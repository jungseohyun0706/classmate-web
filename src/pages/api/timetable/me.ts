import type { NextApiRequest, NextApiResponse } from 'next'
import { addDays, isYmd, schoolYmdAt, toUtcDate } from '../../../lib/timetable/dates'
import { apiError, requireUser, schoolRef } from '../../../lib/timetable/server'
import { loadStudentTimetableData, TimetableApiError } from '../../../lib/timetable/studentData'

// GET /api/timetable/me?from=YYYYMMDD&to=YYYYMMDD
// Header: Authorization: Bearer <Firebase ID token>
// 로그인한 학생의 개인 시간표 자료(MyTimetablePayload — 아키텍처 6절)를 돌려줍니다.
// - from·to는 둘 다 포함, 최대 21일. 기본값: 어제(학교 시간대) ~ 13일 뒤
// - 본인 수강 + 소속 학급의 명시된 공통 수업 범위만. 학교 전체 시간표·다른 학생 수강은 내려주지 않음
// - 교사 계정은 본인 수강이 있을 때만(없으면 403 not-student — 빈 시간표로 위장하지 않음)
// 오류: 400 bad-date/bad-range, 401 unauthenticated, 403 no-profile/not-student, 409 no-school,
//       500 load-failed/index-required, 503 not-configured — 모두 { error, code }

// 기본 함수 시간 한도(플랜에 따라 10~15초)면 콜드 스타트 + Firestore + NEIS 학사일정이 겹칠 때 504가 날 수 있어 여유를 둠.
// 학사일정 자체는 studentData의 상한(CALENDAR_TIMEOUT_MS) 뒤 calendarErrors로 넘어가므로 보통은 훨씬 빨리 끝남
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
    console.error('timetable/me: auth failed', (e as Error)?.message)
    return apiError(res, 500, 'load-failed', '사용자 정보를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.')
  }
  if (!u) return

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
    return apiError(res, 409, 'no-school', '학교 정보가 없어요. 초대 링크로 학급·수업에 먼저 참여하거나 내 정보를 확인해 주세요.')
  }

  try {
    if (u.user.role !== 'student') {
      // 교사 등: 본인 수강이 있을 때만 개인 시간표를 만듦
      const mine = await schoolRef(u.db, schoolCode).collection('enrollments').where('uid', '==', u.uid).limit(1).get()
      if (mine.empty) {
        return apiError(res, 403, 'not-student', '학생 개인 시간표는 학생 계정에서 볼 수 있어요.')
      }
    }
    const payload = await loadStudentTimetableData(u.db, u.uid, u.user, from, to)
    return res.status(200).json(payload)
  } catch (e) {
    if (e instanceof TimetableApiError) return apiError(res, e.status, e.code, e.message)
    const err = e as { code?: unknown; message?: string }
    // 인덱스 누락(FAILED_PRECONDITION)은 원인 코드를 따로 — 빈 시간표로 보이지 않게
    const indexMissing = err?.code === 9 || /index/i.test(String(err?.message || ''))
    console.error('timetable/me: load failed', indexMissing ? 'index-required' : 'load-failed', String(err?.message || '').slice(0, 200))
    return apiError(
      res,
      500,
      indexMissing ? 'index-required' : 'load-failed',
      '시간표를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.'
    )
  }
}
