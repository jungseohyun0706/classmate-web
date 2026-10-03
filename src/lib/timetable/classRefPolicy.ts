/**
 * '학급 시간표(참고)' 보기 판단 — 순수 함수(브라우저·Firebase 없이 단위 테스트: tests/unit/prod-c-class-ref-policy.test.ts)
 *
 * 학급 시간표는 개인 시간표가 아니라 그 아래 '참고' 라벨의 별도 영역입니다(R05). 여기서 정하는 것:
 * - classRefTarget: 어느 학급을 참고로 보여 줄지
 *   · 서버 응답(/api/timetable/me)의 승인된 소속 학급 → 학급 id까지(NEIS + 학급 시간표 문서·학급 변경)
 *   · 담임 승인 대기 → 학년·반의 공개 NEIS 학급 시간표만(classId=null — 규칙으로 막힌 학급 문서는 읽지 않음)
 *   · /me가 서버·네트워크 오류로 자료 없이 실패 → 프로필로(서버 homeroomOf와 같은 규칙: 승인 + 수업 그룹 아님)
 * - classRefAutoOpen: 처음부터 펼칠지 — 그 날 상태(no-courses 등)가 아니라 '공식 수업 시간표가 연결돼 있는지'로.
 *   직접 입력 일정은 세지 않음(일정 하나를 추가했다고 학급 시간표가 사라지지 않게)
 * - displayDayState: 공식 수업 없이 직접 입력만 있는 학생의 빈 날을 '이 날은 수업이 없어요'(학교가 쉬는 것처럼)로 보이지 않게
 * - classRefNowPeriod: 학급 시간표(참고)의 '지금' 교시(예전 홈 TodayCard와 같은 표시)
 */
import { awaitingHomeroomApproval } from '../homeroomStatus'
import { periodRanges, schoolLevelOf } from '../periodTimes'
import { slotMinutes } from './engine'
import type { DayState, DayTimetable, PeriodTime, Ymd } from './types'

/** 수업 그룹(classes/{base}_g_{x})이 소속처럼 저장된 예전 학생 — server.ts GROUP_RE와 같음 */
const GROUP_CLASS_RE = /_g_[A-Za-z0-9]+$/

export interface ClassRefProfile {
  classId?: string | null
  status?: string | null
  schoolCode?: string | null
  grade?: string | number | null
  classNm?: string | number | null
}

export interface ClassRefPayload {
  schoolCode: string | null
  homeroom: { classId: string; isGroupLegacy: boolean } | null
  legacyClassTimetableAvailable: boolean
}

export interface ClassRefTarget {
  /** homeroom = 서버가 확인한 소속 학급, pending = 담임 승인 대기(공개 NEIS만), profile = /me 실패 시 프로필 기준 */
  source: 'homeroom' | 'pending' | 'profile'
  schoolCode: string
  /** 학급 문서(classes/{id}/info/timetable·overrides)를 읽어도 되는 학급 id. 승인 대기는 null */
  classId: string | null
  grade: string | number | null
  classNm: string | number | null
}

/** 실제 학급(수업 그룹 아님) 신청이 담임 승인을 기다리는 중 — 승인 대기 안내·공개 NEIS 참고 보기 대상 */
export function awaitingHomeroomClass(p: { classId?: string | null; status?: string | null } | null | undefined): boolean {
  return awaitingHomeroomApproval(p) && !GROUP_CLASS_RE.test(text(p?.classId))
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function filled(v: string | number | null | undefined): v is string | number {
  return v != null && v !== ''
}

export function classRefTarget(input: {
  /** 학생 프로필(users/{uid}). 읽지 못했으면 null — 그때는 서버 응답만으로 판단 */
  profile: ClassRefProfile | null
  payload: ClassRefPayload | null
  /** /me가 서버·네트워크 오류로 실패해 이 날짜 자료가 없음 */
  loadFailed: boolean
}): ClassRefTarget | null {
  const { profile, payload, loadFailed } = input
  if (profile?.status === 'rejected') return null
  const profileClassId = text(profile?.classId)
  const schoolCode = text(profile?.schoolCode) || text(payload?.schoolCode)
  if (!schoolCode) return null
  const g = profile?.grade
  const c = profile?.classNm
  const grade = filled(g) ? g : null
  const classNm = filled(c) ? c : null

  // 담임 승인 대기: 학년·반 공개 NEIS 학급 시간표만(승인 전 학급 문서는 규칙상 못 읽음)
  if (profile && awaitingHomeroomClass(profile)) {
    return grade != null && classNm != null ? { source: 'pending', schoolCode, classId: null, grade, classNm } : null
  }

  // 서버 응답이 있으면 서버가 정한 소속 학급(승인·수업 그룹 판단은 서버)
  if (payload) {
    const hr = payload.homeroom
    if (!hr || hr.isGroupLegacy || !payload.legacyClassTimetableAvailable) return null
    // 소속이 바뀐 직후의 이전 자료는 쓰지 않음(새 자료를 다시 받는 중)
    if (profile && hr.classId !== profileClassId) return null
    return { source: 'homeroom', schoolCode, classId: hr.classId, grade, classNm }
  }

  // 서버 오류·오프라인으로 자료가 없음: 프로필로 — 서버 homeroomOf와 같은 규칙(승인 + 수업 그룹 아님)
  if (loadFailed && profile && profileClassId && !GROUP_CLASS_RE.test(profileClassId) && profile.status === 'approved') {
    return { source: 'profile', schoolCode, classId: profileClassId, grade, classNm }
  }
  return null
}

/** 그 날 결과에 공식 수업(수강·학급 공통 수업)의 차시나 기본 시간표가 있는지 — 직접 입력 일정은 세지 않음 */
export function hasOfficialTimetable(day: Pick<DayTimetable, 'lessons' | 'activeCourseIds' | 'coursesWithoutSchedule'>): boolean {
  if (day.lessons.some((l) => l.source !== 'personal')) return true
  return day.activeCourseIds.some((id) => !day.coursesWithoutSchedule.includes(id))
}

/**
 * 학급 시간표(참고)를 처음부터 펼칠지(학생이 직접 펼치거나 접으면 그 선택이 우선).
 * - 그 날 결과가 있으면: 공식 수업 시간표가 없을 때(수업 없음·시간표 미등록·직접 입력만 있음)
 * - 결과가 없으면: /me가 서버·네트워크 오류로 실패했을 때만(상태 카드에 참고 버튼이 없으므로)
 */
export function classRefAutoOpen(input: {
  day: Pick<DayTimetable, 'lessons' | 'activeCourseIds' | 'coursesWithoutSchedule'> | null
  loadFailed: boolean
}): boolean {
  if (input.day) return !hasOfficialTimetable(input.day)
  return input.loadFailed
}

/**
 * 상태 카드에 쓸 상태. 엔진은 직접 입력 일정이 하나라도 있으면 빈 날을 no-lessons로 두는데(요구 문서 3절),
 * 공식 수업이 하나도 없는 학생에게 '이 날은 수업이 없어요'는 학교가 쉬는 날처럼 읽혀 no-courses 카드로 보여 줌.
 */
export function displayDayState(day: Pick<DayTimetable, 'state' | 'activeCourseIds'>): DayState {
  return day.state === 'no-lessons' && day.activeCourseIds.length === 0 ? 'no-courses' : day.state
}

/**
 * 학급 시간표(참고)에 넘길 그 날 쉬는 날.
 * 자료 기간 밖이거나 학사일정 확인에 실패한 날은 undefined(참고 보기가 학사일정을 직접 조회) — null(쉬는 날 아님)로 단정하지 않음.
 */
export function classRefOffDay(
  payload: { from: Ymd; to: Ymd; offDays: Record<Ymd, { name: string } | null>; calendarErrors: Ymd[] } | null,
  date: Ymd
): { name: string } | null | undefined {
  if (!payload || date < payload.from || date > payload.to || payload.calendarErrors.includes(date)) return undefined
  return payload.offDays[date] ?? null
}

function minutesToHm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}

/** 학교급 기본 교시표(서버 buildPeriodTimes에 학급 교시표가 없을 때와 같음) — /me 자료가 없을 때 참고 보기용 */
export function defaultPeriodTimes(schoolName: string | null | undefined): PeriodTime[] {
  return periodRanges(schoolLevelOf(schoolName)).map(([s, e], i) => ({ period: i + 1, start: minutesToHm(s), end: minutesToHm(e) }))
}

/** 학급 시간표(참고)의 '지금' 교시 — 오늘·쉬는 날 아님·그 교시 수업 시간 안일 때만, 아니면 null */
export function classRefNowPeriod(input: {
  date: Ymd
  today: Ymd | null | undefined
  offDay: boolean
  nowMinutes: number | null
  periods: number[]
  periodTimes: PeriodTime[] | null | undefined
}): number | null {
  const { date, today, offDay, nowMinutes, periods, periodTimes } = input
  if (!today || date !== today || offDay || nowMinutes == null || !periodTimes?.length) return null
  for (const period of periods) {
    const m = slotMinutes({ period }, periodTimes)
    if (m.start !== null && m.end !== null && m.start <= nowMinutes && nowMinutes < m.end) return period
  }
  return null
}
