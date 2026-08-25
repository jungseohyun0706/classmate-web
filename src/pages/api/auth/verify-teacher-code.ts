import type { NextApiRequest, NextApiResponse } from 'next'
import { timingSafeEqual } from 'crypto'

// TEACHER_SIGNUP_CODE 환경변수가 없을 때 개발용으로 쓰는 레거시 코드
const LEGACY_TEACHER_CODE = 'classmate2026'

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

// POST /api/auth/verify-teacher-code
// Body: { code }
// 응답: 200 { ok:true, configured } / 403 { ok:false, configured }
// configured=false 이면 서버에 TEACHER_SIGNUP_CODE가 설정되지 않아
// 레거시 기본 코드로 검사했다는 뜻입니다(운영 환경에서는 반드시 설정하세요).
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: '허용되지 않는 요청입니다.' })
  }

  const envCode = (process.env.TEACHER_SIGNUP_CODE ?? '').trim()
  const configured = envCode.length > 0
  const expected = configured ? envCode : LEGACY_TEACHER_CODE

  const { code } = (req.body ?? {}) as { code?: unknown }
  if (typeof code !== 'string' || code.trim().length === 0) {
    return res
      .status(403)
      .json({ ok: false, configured, error: '인증 코드를 입력해 주세요.' })
  }

  if (safeCompare(code.trim(), expected)) {
    return res.status(200).json({ ok: true, configured })
  }

  return res.status(403).json({ ok: false, configured })
}
