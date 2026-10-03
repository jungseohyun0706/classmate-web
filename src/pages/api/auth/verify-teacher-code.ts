import type { NextApiRequest, NextApiResponse } from 'next'
import { timingSafeEqual } from 'crypto'

// 길이가 달라도 실행 시간이 크게 달라지지 않도록 맞춘 비교 (timing-safe-ish)
function safeCompare(input: string, expected: string): boolean {
  const a = Buffer.from(input, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) {
    // 길이가 다르면 자기 자신과 비교해 시간을 비슷하게 만든 뒤 false를 돌려줍니다.
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

// 코드 무차별 대입 방지 (인스턴스별 best-effort) — complete-signup과 같은 규칙.
// 틀린 코드 시도만 셉니다(같은 학교 교사들이 공인 IP 하나로 연달아 가입해도 막히지 않게).
const failedAttempts = new Map<string, { n: number; t: number }>()
const WINDOW_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 10

function limited(ip: string): boolean {
  const a = failedAttempts.get(ip)
  if (!a) return false
  if (Date.now() - a.t > WINDOW_MS) {
    failedAttempts.delete(ip)
    return false
  }
  return a.n >= MAX_ATTEMPTS
}

function recordFailure(ip: string) {
  const now = Date.now()
  const a = failedAttempts.get(ip)
  if (!a || now - a.t > WINDOW_MS) {
    failedAttempts.set(ip, { n: 1, t: now })
    return
  }
  a.n += 1
}

// POST /api/auth/verify-teacher-code
// Body: { code }
// 응답: 200 { ok:true } / 403 { ok:false } / 429·503 { ok:false, error }
// 서버에 TEACHER_SIGNUP_CODE가 설정되지 않았으면 교사 가입을 받지 않습니다(503).
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: '허용되지 않는 요청입니다.' })
  }

  const expected = (process.env.TEACHER_SIGNUP_CODE ?? '').trim()
  if (!expected) {
    return res
      .status(503)
      .json({ ok: false, error: '교사 가입이 아직 열리지 않았어요. 관리자에게 문의해 주세요.' })
  }

  const ip =
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown'
  if (limited(ip)) {
    return res.status(429).json({ ok: false, error: '시도가 너무 많아요. 잠시 후 다시 시도해 주세요.' })
  }

  const { code } = (req.body ?? {}) as { code?: unknown }
  if (typeof code !== 'string' || code.trim().length === 0) {
    return res.status(403).json({ ok: false, error: '인증 코드를 입력해 주세요.' })
  }

  if (safeCompare(code.trim(), expected)) {
    return res.status(200).json({ ok: true })
  }

  recordFailure(ip)
  return res.status(403).json({ ok: false })
}
