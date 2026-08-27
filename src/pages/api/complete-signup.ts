import type { NextApiRequest, NextApiResponse } from 'next'
import { timingSafeEqual } from 'crypto'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { getAdminApp, isAdminConfigured, verifyIdToken } from '../../lib/fcm-admin'

// POST /api/complete-signup
// Body: { idToken, code }
// 구글 로그인으로 처음 들어온 사용자가 교사 인증 코드를 제출하면
// 서버(admin)가 코드를 검증하고 users/{uid}에 교사 role을 부여합니다.
// (role은 보안 규칙상 클라이언트가 스스로 만들 수 없으므로 서버에서 처리)

// TEACHER_SIGNUP_CODE 환경변수가 없을 때 쓰는 레거시 코드 — verify-teacher-code와 동일 규칙
const LEGACY_TEACHER_CODE = 'classmate2026'

function safeCompare(input: string, expected: string): boolean {
  const a = Buffer.from(input, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) {
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

// 코드 무차별 대입 방지 (인스턴스별 best-effort)
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
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '허용되지 않는 요청입니다.' })
  }
  if (!isAdminConfigured()) {
    return res.status(503).json({ error: '서버 인증 설정이 없어요. 관리자에게 문의해 주세요.' })
  }

  const ip =
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown'
  if (limited(ip)) {
    return res.status(429).json({ error: '시도가 너무 많아요. 잠시 후 다시 시도해 주세요.' })
  }

  const { idToken, code } = (req.body ?? {}) as { idToken?: unknown; code?: unknown }
  if (typeof idToken !== 'string' || !idToken || typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ error: '필수 항목이 누락되었어요.' })
  }

  const envCode = (process.env.TEACHER_SIGNUP_CODE ?? '').trim()
  const expected = envCode.length > 0 ? envCode : LEGACY_TEACHER_CODE
  if (!safeCompare(code.trim(), expected)) {
    return res.status(403).json({ error: '교사 인증 코드가 올바르지 않아요. 관리자에게 문의해 주세요.' })
  }

  const decoded = await verifyIdToken(idToken)
  if (!decoded) {
    return res.status(401).json({ error: '로그인 정보가 만료됐어요. 다시 로그인해 주세요.' })
  }

  try {
    const app = getAdminApp()
    if (!app) return res.status(503).json({ error: '서버 초기화에 실패했어요.' })
    const db = getFirestore(app)

    const ref = db.collection('users').doc(decoded.uid)
    const existing = await ref.get()
    if (existing.exists && existing.get('role') === 'student') {
      return res.status(403).json({ error: '학생 계정은 교사로 전환할 수 없어요.' })
    }

    await ref.set(
      {
        email: decoded.email || null,
        displayName: decoded.name || null,
        role: 'teacher',
        ...(existing.exists ? {} : { schoolId: null, createdAt: FieldValue.serverTimestamp() }),
      },
      { merge: true }
    )
    return res.status(200).json({ ok: true })
  } catch (e) {
    console.error('complete-signup error:', e)
    return res.status(500).json({ error: '처리 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.' })
  }
}
