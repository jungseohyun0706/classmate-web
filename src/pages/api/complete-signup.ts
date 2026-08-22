/**
 * 교사 등록 완료 — 구글/이메일 로그인 공통.
 *
 * 클라이언트가 로그인 후 받은 idToken + 교사 인증 코드를 보내면
 * 서버가 (1) 코드 검증 (2) 토큰 검증 (3) admin 권한으로 role 부여를 처리한다.
 * role 은 보안 규칙상 클라이언트가 직접 쓸 수 없으므로 이 경로가 유일한 승격 통로다.
 */
import type { NextApiRequest, NextApiResponse } from 'next'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb, adminAvailable } from '../../lib/firebaseAdmin'
import { verifyIdToken } from '../../lib/authVerify'

const attempts = new Map<string, { n: number; t: number }>()
const WINDOW_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 10

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
    return res.status(503).json({ error: '서버 인증 설정이 없습니다. 관리자에게 문의하세요.' })
  }

  const ip =
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown'
  if (limited(ip)) return res.status(429).json({ error: '시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.' })

  const { idToken, code, displayName } = (req.body ?? {}) as Record<string, string>
  if (!idToken || !code) return res.status(400).json({ error: '필수 항목이 누락되었습니다.' })
  if (code !== signupCode) {
    return res.status(403).json({ error: '교사 인증 코드가 올바르지 않습니다. 관리자에게 문의하세요.' })
  }

  try {
    const user = await verifyIdToken(idToken)
    if (!user) {
      return res.status(401).json({ error: '로그인 정보가 만료되었습니다. 다시 로그인해 주세요.' })
    }

    const ref = adminDb().collection('users').doc(user.uid)
    const existing = await ref.get()
    if (existing.exists && existing.data()?.role === 'student') {
      return res.status(403).json({ error: '학생 계정은 교사로 전환할 수 없습니다.' })
    }

    const name = (displayName || '').trim() || user.name || existing.data()?.displayName || null

    await ref.set(
      {
        email: user.email,
        displayName: name,
        role: 'teacher',
        createdAt: existing.exists ? existing.data()?.createdAt ?? FieldValue.serverTimestamp() : FieldValue.serverTimestamp(),
      },
      { merge: true },
    )

    return res.status(200).json({ ok: true, uid: user.uid })
  } catch (e) {
    console.error('[api/complete-signup]', e)
    return res.status(500).json({ error: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' })
  }
}
