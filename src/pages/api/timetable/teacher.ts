import type { NextApiRequest, NextApiResponse } from 'next'
import { addDays, isYmd, schoolYmdAt, toUtcDate } from '../../../lib/timetable/dates'
import { apiError, requireUser } from '../../../lib/timetable/server'
import { TimetableApiError } from '../../../lib/timetable/studentData'
import { loadTeacherTimetableData } from '../../../lib/timetable/teacherData'

// GET /api/timetable/teacher?from=YYYYMMDD&to=YYYYMMDD
// Header: Authorization: Bearer <Firebase ID token>
// 로그인한 교사의 '내 시간표'(TeacherTimetablePayload — src/lib/timetable/teacherDay.ts, 아키텍처 '교사 내 시간표' 절)를 돌려줍니다.
// - from·to는 둘 다 포함, 최대 21일. 기본값: 어제(학교 시간대) ~ 13일 뒤 (/api/timetable/me와 같음)
// - 본인 차시만(uid로만 판정 — 교사 이름으로 연결하지 않음). 학생 명단·수강·다른 교사 uid는 내려주지 않음
// - 교사 계정만(학생은 403 teacher-only)
// 오류: 400 bad-date/bad-range, 401 unauthenticated, 403 no-profile/teacher-only, 409 no-school,
//       500 load-failed/index-required, 503 not-configured — 모두 { error, code }

// 콜드 스타트 + Firestore + NEIS 학사일정이 겹쳐도 기본 시간 한도에 걸리지 않게(/api/timetable/me와 같음)
export const config = { maxDuration: 30 }

const MAX_DAYS = 21

function dayDiff(from: string, to: string): number {
  return Math.round((toUtcDate(to).getTime() - toUtcDate(from).getTime()) / 86400000)
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // 사용자별 자료: 공유 캐시(CDN)·브라우저 캐시에 남기지 않음
  res.setHeader('Cache-Control', 'private, no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return apiError(res, 405, 'method-not-allowed', '허용되지 않는 요청이에요.')
  }

  let u
  try {
    u = await requireUser(req, res)
  } catch (e) {
    console.error('timetable/teacher: auth failed', (e as Error)?.message)
    return apiError(res, 500, 'load-failed', '사용자 정보를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.')
  }
  if (!u) return

  if (u.user.role !== 'teacher') {
    return apiError(res, 403, 'teacher-only', '선생님 계정에서만 볼 수 있는 시간표예요.')
  }

  const qFrom = typeof req.query.from === 'string' ? req.query.from : ''
  const qTo = typeof req.query.to === 'string' ? req.query.to : ''
  if ((qFrom && !isYmd(qFrom)) || (qTo && !isYmd(qTo))) {
    return apiError(res, 400, 'bad-date', '날짜 형식이 올바르지 않아요(YYYYMMDD).')
  }
  const today = schoolYmdAt(Date.now())
  const from = qFrom || (qTo ? addDays(qTo, -14) : addDays(today, -1))
  const to = qTo || (qFrom ? addDays(qFrom, 14) : addDays(today, 13))
  const span = dayDiff(from, to)
  if (span < 0 || span + 1 > MAX_DAYS) {
    return apiError(res, 400, 'bad-range', `조회 기간은 시작일부터 최대 ${MAX_DAYS}일까지예요.`)
  }

  const schoolCode = typeof u.user.schoolCode === 'string' ? u.user.schoolCode : ''
  if (!schoolCode) {
    return apiError(res, 409, 'no-school', '학교 정보가 없어요. 학교·학급 등록을 먼저 해 주세요.')
  }

  try {
    const payload = await loadTeacherTimetableData(u.db, u.uid, u.user, from, to)
    return res.status(200).json(payload)
  } catch (e) {
    if (e instanceof TimetableApiError) return apiError(res, e.status, e.code, e.message)
    const err = e as { code?: unknown; message?: string }
    // 인덱스 누락(FAILED_PRECONDITION)은 원인 코드를 따로 — 빈 시간표로 보이지 않게
    const indexMissing = err?.code === 9 || /index/i.test(String(err?.message || ''))
    console.error('timetable/teacher: load failed', indexMissing ? 'index-required' : 'load-failed', String(err?.message || '').slice(0, 200))
    return apiError(
      res,
      500,
      indexMissing ? 'index-required' : 'load-failed',
      '시간표를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.'
    )
  }
}
