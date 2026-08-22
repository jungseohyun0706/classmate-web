/**
 * 교사 회원가입 — 서버 측 검증.
 * 인증 코드는 서버 환경변수(TEACHER_SIGNUP_CODE)에만 존재하며,
 * 계정 생성과 role 부여는 admin SDK로만 이뤄진다 (클라이언트가 role을 쓸 수 없음).
 */
import type { NextApiRequest, NextApiResponse } from 'next'
import { adminAuth, adminDb, adminAvailable } from '../../lib/firebaseAdmin'
import { FieldValue } from 'firebase-admin/firestore'

// 서버리스 인스턴스 단위의 가벼운 rate limit (완전하지 않지만 무차별 대입 저지용)
const attempts = new Map<string, { n: number; t: number }>()
const WINDOW_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 8

function limited(ip: string): boolean {
  const now = Date.now()
  const a = attempts.get(ip)
  if (!a || now - a.t > WINDOW_MS) {
    attempts.set(ip, { n: 1, t: now })
    return false
  }
  a.n += 1
  return a.n > MAX_ATTEMPTS
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const signupCode = process.env.TEACHER_SIGNUP_CODE
  if (!signupCode) {
    return res.status(503).json({ error: '서버에 가입 코드가 설정되지 않았습니다. 관리자에게 문의하세요.' })
  }
  if (!adminAvailable()) {
    return res.status(503).json({ error: '서버 인증 설정(FIREBASE_SERVICE_ACCOUNT)이 없습니다. 관리자에게 문의하세요.' })
  }

  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown'
  if (limited(ip)) return res.status(429).json({ error: '시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.' })

  const { email, password, displayName, code } = (req.body ?? {}) as Record<string, string>

  if (!email || !password || !code) return res.status(400).json({ error: '필수 항목이 누락되었습니다.' })
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다.' })
  }
  if (code !== signupCode) {
    return res.status(403).json({ error: '교사 인증 코드가 올바르지 않습니다. 관리자에게 문의하세요.' })
  }

  try {
    const auth = adminAuth()
    const user = await auth.createUser({
      email,
      password,
      displayName: displayName?.trim() || undefined,
      emailVerified: false,
    })
    await auth.setCustomUserClaims(user.uid, { role: 'teacher' })
    await adminDb().collection('users').doc(user.uid).set(
      {
        email,
        displayName: displayName?.trim() || null,
        role: 'teacher',
        schoolId: null,
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
    return res.status(200).json({ ok: true, uid: user.uid })
  } catch (e: any) {
    if (e?.code === 'auth/email-already-exists') {
      return res.status(409).json({ error: '이미 가입된 이메일입니다.' })
    }
    if (e?.code === 'auth/invalid-email') {
      return res.status(400).json({ error: '이메일 형식이 올바르지 않습니다.' })
    }
    console.error('[api/register]', e)
    return res.status(500).json({ error: '회원가입 처리 중 오류가 발생했습니다.' })
  }
}
