/**
 * 학생 개인 시간표 자료 + 수업·수강 API 공용 도우미 (API 라우트 전용 — firebase-admin)
 * 클라이언트 번들에서 import하지 마세요.
 *
 * loadStudentTimetableData: 아키텍처 6절 MyTimetablePayload를 만듭니다.
 * - 본인 수강(모든 상태) + 소속 학급의 '명시된' 공통 수업만 모읍니다. 학교 전체 수업·다른 학생 수강은 읽어 오지 않습니다.
 * - 학급 시간표(classes/{id}/info/timetable, NEIS 학급 시간표)는 개인 시간표 원본으로 쓰지 않고,
 *   '학급 시간표(참고)' 보기를 보여 줄 수 있는지(legacyClassTimetableAvailable)만 알려 줍니다.
 * - 조회 실패는 빈 시간표로 바꾸지 않고 예외로 올립니다(API가 5xx + code로 응답).
 *   NEIS 학사일정만은 실패해도 시간표를 보여 줄 수 있어 그 날짜를 calendarErrors로 따로 알려 줍니다.
 */
import type { DocumentData, DocumentReference, DocumentSnapshot, Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore'
import { fetchNeisResult, isOffDay, isOffDayRow, lookupSchool, type NeisRow } from '../neis'
import { periodRanges, schoolLevelOf } from '../periodTimes'
import { addDays, isYmd } from './dates'
import { clipSeriesToTerm, scopeCoursesToTerms, selectOverridesForWindow } from './engine'
import {
  chunk,
  courseFromDoc,
  currentRevision,
  defaultTermFor,
  enrollmentFromDoc,
  homeroomOf,
  overrideFromDoc,
  schoolRef,
  seriesFromDoc,
  type TermInfo,
} from './server'
import type { Course, Enrollment, HomeroomMembership, LessonSeries, Override, PeriodTime, Ymd } from './types'

// ───────────────────────── 공용: API 오류 ─────────────────────────

/** API 처리 중 의도한 실패. 핸들러가 { error, code, ...extra } + status로 응답합니다. */
export class TimetableApiError extends Error {
  status: number
  code: string
  extra?: Record<string, unknown>
  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

/**
 * 수업을 관리할 수 있는 계정인지.
 * - teacherUids: 실제 담당 교사(인증된 계정)
 * - managerUids: 학급 시간표에서 공통 수업을 만든 담임처럼 '관리만' 맡은 계정.
 *   교사 충돌 판정에는 쓰지 않습니다(담임이 그 과목 교사인 것으로 오인하지 않도록).
 */
export function canManageCourse(course: Record<string, any> | null | undefined, uid: string): boolean {
  if (!course || !uid) return false
  const t = Array.isArray(course.teacherUids) ? course.teacherUids : []
  const m = Array.isArray(course.managerUids) ? course.managerUids : []
  return t.includes(uid) || m.includes(uid)
}

/** 학급 표시 이름: '3학년 4반'. 수업 그룹은 '영어 수업 그룹' */
export function homeroomLabel(cls: Record<string, any> | null | undefined, classId: string): string {
  if (cls?.isGroup === true) return cls.subjectName ? `${String(cls.subjectName)} 수업 그룹` : '수업 그룹'
  const grade = cls?.grade
  const classNm = cls?.classNm
  if (grade != null && grade !== '' && classNm != null && classNm !== '') return `${grade}학년 ${classNm}반`
  const m = /_(\d{1,2})_(\d{1,2})$/.exec(classId)
  return m ? `${Number(m[1])}학년 ${Number(m[2])}반` : '학급'
}

/** 학생 문서의 소속 표시(명단용). 그룹이 소속처럼 저장된 학생은 '소속 학급 미설정' */
export function studentHomeroomLabel(user: Record<string, any>): string {
  const hr = homeroomOf(user)
  if (!hr) return typeof user.classId === 'string' && user.classId ? '소속 확인 중' : '소속 학급 미설정'
  if (hr.isGroupLegacy) return '소속 학급 미설정'
  return homeroomLabel({ grade: user.grade, classNm: user.classNm }, hr.classId)
}

/** 출석번호: 없거나 숫자가 아니면 null(0번으로 보이지 않게) */
export function toStudentNo(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

// ───────────────────────── 공용: 학기 범위 ─────────────────────────

const TERM_ID_RE = /^(\d{4})-([12])$/

/** termId → 기간. 학기 문서가 있으면 그 값, 없으면 기본 학기 규칙(2026-1 → [0301, 0816))으로. 알 수 없으면 null */
export function termRangeOf(
  termDocs: Array<{ id: string; data: Record<string, any> }>,
  termId: string
): { startDate: Ymd; endDate: Ymd; isDefault: boolean } | null {
  const doc = termDocs.find((d) => d.id === termId)
  if (doc && isYmd(doc.data.startDate) && isYmd(doc.data.endDate)) {
    return { startDate: doc.data.startDate, endDate: doc.data.endDate, isDefault: false }
  }
  const m = TERM_ID_RE.exec(termId)
  if (!m) return null
  const t = defaultTermFor(m[2] === '1' ? `${m[1]}0301` : `${m[1]}0816`)
  return { startDate: t.startDate, endDate: t.endDate, isDefault: true }
}

/** termForDate(server.ts)와 같은 규칙 — 이미 읽은 학기 문서로 계산(같은 요청에서 두 번 읽지 않도록) */
export function termForDateFromDocs(termDocs: Array<{ id: string; data: Record<string, any> }>, ymd: Ymd): TermInfo {
  for (const d of termDocs) {
    const t = d.data
    if (isYmd(t.startDate) && isYmd(t.endDate) && ymd >= t.startDate && ymd < t.endDate) {
      return { termId: d.id, name: String(t.name || d.id), startDate: t.startDate, endDate: t.endDate, isDefault: false }
    }
  }
  return defaultTermFor(ymd)
}

/**
 * 화면의 '학기 밖' 판정용 학기 목록(시작일 순).
 * - 학교가 등록한 학기 문서는 모두 넣음(몇 개뿐 — 가장 가까운 학기를 찾을 수 있게)
 * - 어떤 학기 문서에도 들지 않는 날짜는 기본 학기 규칙을 쓰되, 그 기본 학기 id가 이미 등록된 학기 문서와 같으면
 *   (예: 2026-2 문서가 10/5에 끝났는데 10/20의 기본 학기도 2026-2) 그 날짜는 학기 밖으로 둠 — 기본 학기로 덮어 '학기 안'처럼 보이지 않게
 */
export function termsForWindow(termDocs: Array<{ id: string; data: Record<string, any> }>, dates: Ymd[]): TermInfo[] {
  const docTerms: TermInfo[] = termDocs
    .filter((d) => isYmd(d.data.startDate) && isYmd(d.data.endDate) && d.data.startDate < d.data.endDate)
    .map((d) => ({ termId: d.id, name: String(d.data.name || d.id), startDate: d.data.startDate, endDate: d.data.endDate, isDefault: false }))
  const out = new Map<string, TermInfo>()
  docTerms.forEach((t) => out.set(t.termId, t))
  for (const ymd of dates) {
    if (docTerms.some((t) => ymd >= t.startDate && ymd < t.endDate)) continue
    const t = defaultTermFor(ymd)
    if (docTerms.some((x) => x.termId === t.termId)) continue
    if (!out.has(t.termId)) out.set(t.termId, t)
  }
  return Array.from(out.values()).sort((a, b) => a.startDate.localeCompare(b.startDate) || a.termId.localeCompare(b.termId))
}

export async function readTermDocs(db: Firestore, schoolCode: string) {
  const snap = await schoolRef(db, schoolCode).collection('terms').get()
  return snap.docs.map((d) => ({ id: d.id, data: d.data() || {} }))
}

// clipSeriesToTerm·scopeCoursesToTerms는 순수 함수라 engine.ts에 둠(단위 테스트 대상). 이 경로로 import하던 코드 호환
export { clipSeriesToTerm, scopeCoursesToTerms } from './engine'

// ───────────────────────── 학생 화면 자료 ─────────────────────────

export interface MyTimetablePayload {
  /** schools/{s}.scheduleRevision — 조회를 시작하기 전에 읽은 값(조회 중 변경되면 화면이 다시 받음) */
  revision: number
  generatedAt: number
  schoolCode: string | null
  /** 조회 기간(둘 다 포함) */
  from: Ymd
  to: Ymd
  /** from 날짜의 학기 */
  term: { termId: string; name: string; startDate: Ymd; endDate: Ymd; isDefault: boolean }
  /** 학교가 등록한 학기 문서 전부 + 문서가 없는 날짜의 기본 학기(시작일 순, termsForWindow) — 날짜별 '학기 밖' 판정은 이것으로 */
  terms: Array<{ termId: string; name: string; startDate: Ymd; endDate: Ymd; isDefault: boolean }>
  homeroom: { classId: string; label: string; schoolName: string; isGroupLegacy: boolean } | null
  homerooms: HomeroomMembership[]
  /** 본인 수강만(모든 상태) */
  enrollments: Enrollment[]
  /** 본인 수강 + 소속 학급 공통 수업만(조회 시작일 전에 학기가 끝난 공통 수업 제외). endedOn은 학기 종료일까지로 자른 값(scopeCoursesToTerms) */
  courses: Course[]
  /** 위 수업들의 반복 차시(수업 학기 범위로 자른 값) */
  series: LessonSeries[]
  /** 위 수업들의 발행된 변경 중 조회 기간에 걸친 차시의 변경 전부(차시별 이력 포함) + 같은 묶음의 변경 */
  overrides: Override[]
  /** 날짜별 쉬는 날. 조회 실패한 날짜는 키가 없고 calendarErrors에 들어감 */
  offDays: Record<Ymd, { name: string } | null>
  calendarErrors: Ymd[]
  periodTimes: PeriodTime[]
  /** '학급 시간표(참고)' 보기를 보여 줄 수 있는지 — 개인 시간표 대신 쓰지 않음 */
  legacyClassTimetableAvailable: boolean
}

/** from~to(둘 다 포함) 날짜 목록 */
export function datesBetween(from: Ymd, to: Ymd): Ymd[] {
  const out: Ymd[] = []
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d)
  return out
}

function minutesToHm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}

/** 학급 교시표(엑셀에서 온 시작 시각)가 있으면 그것으로, 없으면 학교급 기본 교시표 */
export function buildPeriodTimes(schoolName: string, starts?: unknown): PeriodTime[] {
  const list = Array.isArray(starts) ? starts.map((s) => (typeof s === 'string' ? s : '')) : undefined
  return periodRanges(schoolLevelOf(schoolName), list).map(([s, e], i) => ({
    period: i + 1,
    start: minutesToHm(s),
    end: minutesToHm(e),
  }))
}

export type OffDaysResult = { offDays: Record<Ymd, { name: string } | null>; calendarErrors: Ymd[] }

/**
 * 학사일정 조회 상한(ms). NEIS가 느리면(학교 조회 5초 + 학사일정 5초가 이어질 수 있음) 시간표 응답 전체가 늦어지거나
 * 함수 시간 한도에 걸려 5xx가 되므로, 넘으면 그 기간을 calendarErrors로 돌려 시간표는 먼저 보여 줌.
 */
export const CALENDAR_TIMEOUT_MS = 4000

/** 학사일정 조회에 상한을 둠 — ms 안에 끝나지 않으면 모든 날짜를 calendarErrors로(쉬는 날 아님으로 단정하지 않음) */
export async function boundCalendarLookup(lookup: Promise<OffDaysResult>, dates: Ymd[], ms: number = CALENDAR_TIMEOUT_MS): Promise<OffDaysResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<OffDaysResult>((resolve) => {
    timer = setTimeout(() => {
      console.error('timetable/me: school schedule timed out', ms)
      resolve({ offDays: {}, calendarErrors: dates.slice() })
    }, ms)
  })
  try {
    return await Promise.race([lookup, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * NEIS 학사일정 → 날짜별 쉬는 날. 실패하면 모든 날짜를 calendarErrors로(쉬는 날 아님으로 단정하지 않음).
 * 교사 '내 시간표'(teacherData.ts)도 같은 규칙으로 씀(학년 = 담임 학년, 없으면 학년별 쉬는 날도 쉬는 날)
 */
export async function loadOffDays(
  schoolCode: string,
  officeCodeHint: string,
  dates: Ymd[],
  grade: unknown
): Promise<OffDaysResult> {
  const fail = () => ({ offDays: {} as Record<Ymd, { name: string } | null>, calendarErrors: dates.slice() })
  if (!dates.length) return { offDays: {}, calendarErrors: [] }
  try {
    let officeCode = officeCodeHint
    if (!officeCode) {
      const school = await lookupSchool(schoolCode)
      if (!school.ok || !school.officeCode) return fail()
      officeCode = school.officeCode
    }
    const { ok, rows } = await fetchNeisResult('SchoolSchedule', {
      ATPT_OFCDC_SC_CODE: officeCode,
      SD_SCHUL_CODE: schoolCode,
      AA_FROM_YMD: dates[0],
      AA_TO_YMD: dates[dates.length - 1],
    })
    if (!ok) return fail()
    const offDays: Record<Ymd, { name: string } | null> = {}
    for (const ymd of dates) {
      if (!isOffDay(rows, ymd, grade)) {
        offDays[ymd] = null
        continue
      }
      const row = rows.find((r: NeisRow) => (!r.AA_YMD || r.AA_YMD === ymd) && isOffDayRow(r, grade))
      offDays[ymd] = { name: String(row?.EVENT_NM || '').trim() || '쉬는 날' }
    }
    return { offDays, calendarErrors: [] }
  } catch (e) {
    console.error('timetable/me: school schedule failed', (e as Error)?.message)
    return fail()
  }
}

const docData = (d: QueryDocumentSnapshot<DocumentData>) => d.data() || {}

/**
 * 학생 개인 시간표 자료. user는 서버가 읽은 users/{uid} 문서(클라이언트 값 아님).
 * from·to는 둘 다 포함(YYYYMMDD, 검증은 호출하는 쪽).
 * schoolCode가 없으면 TimetableApiError(409 'no-school').
 */
export async function loadStudentTimetableData(
  db: Firestore,
  uid: string,
  user: Record<string, any>,
  from: Ymd,
  to: Ymd
): Promise<MyTimetablePayload> {
  const schoolCode = typeof user.schoolCode === 'string' && user.schoolCode ? user.schoolCode : ''
  if (!schoolCode) throw new TimetableApiError(409, 'no-school', '학교 정보가 없어요. 내 정보에서 학교를 먼저 확인해 주세요.')
  const sref = schoolRef(db, schoolCode)
  const dates = datesBetween(from, to)

  // 버전을 가장 먼저 읽음: 조회 도중 변경이 발행되면 화면은 낮은 버전을 받고, 구독한 버전이 바뀌어 다시 받음
  const revision = await currentRevision(db, schoolCode)

  // 소속 학급: 학생만. 수업 그룹이 소속처럼 저장된 학생은 공통 수업 대상이 아님(isGroupLegacy)
  const hr = user.role === 'student' ? homeroomOf(user) : null
  const homeroomId = hr && !hr.isGroupLegacy ? hr.classId : null

  // 학사일정은 Firestore 조회와 함께 시작하고, 느리면 상한(CALENDAR_TIMEOUT_MS) 뒤 calendarErrors로
  const offDaysPromise = boundCalendarLookup(
    loadOffDays(schoolCode, typeof user.officeCode === 'string' ? user.officeCode : '', dates, user.grade),
    dates
  )

  const [termDocs, enrollSnap, commonSnap, classSnap, infoTimetableSnap, periodTimesSnap] = await Promise.all([
    readTermDocs(db, schoolCode),
    sref.collection('enrollments').where('uid', '==', uid).get(),
    homeroomId ? sref.collection('courses').where('commonForHomerooms', 'array-contains', homeroomId).get() : null,
    hr ? db.collection('classes').doc(hr.classId).get() : null,
    homeroomId ? db.collection('classes').doc(homeroomId).collection('info').doc('timetable').get() : null,
    homeroomId ? db.collection('classes').doc(homeroomId).collection('info').doc('periodTimes').get() : null,
  ])

  const term = termForDateFromDocs(termDocs, from)
  const termsInWindow = termsForWindow(termDocs, dates)

  // 본인 수강만(쿼리 조건 + 한 번 더 확인)
  const enrollments: Enrollment[] = enrollSnap.docs
    .map((d) => enrollmentFromDoc(docData(d)))
    .filter((e) => e.uid === uid && !!e.courseId)

  // 수업: 수강한 수업(상태 무관 — 지난 기간·승인 대기 표시용) + 소속 학급 공통 수업
  const courseDocs = new Map<string, Record<string, any>>()
  commonSnap?.docs.forEach((d) => courseDocs.set(d.id, docData(d)))
  const missing = Array.from(new Set(enrollments.map((e) => e.courseId))).filter((id) => !courseDocs.has(id))
  const enrolledSnaps = await getDocsById(db, missing.map((id) => sref.collection('courses').doc(id)))
  enrolledSnaps.forEach((s) => {
    if (s.exists) courseDocs.set(s.id, s.data() || {})
  })
  const allCourses: Course[] = Array.from(courseDocs.entries())
    .map(([id, d]) => {
      // 관리 교사 uid는 학생 자료에 넣지 않음
      const { managerUids: _m, ...c } = courseFromDoc(id, d)
      return c
    })
    .sort((a, b) => a.title.localeCompare(b.title, 'ko') || a.courseId.localeCompare(b.courseId))
  const termRangeByCourse = new Map<string, { startDate: Ymd; endDate: Ymd } | null>()
  allCourses.forEach((c) => termRangeByCourse.set(c.courseId, c.termId ? termRangeOf(termDocs, c.termId) : null))
  // 수업 자체에도 학기 범위 적용(차시만 자르던 것과 맞춤) + 조회 기간 전에 학기가 끝난 공통 수업은 뺌
  const courses = scopeCoursesToTerms(allCourses, termRangeByCourse, new Set(enrollments.map((e) => e.courseId)), from)
  const courseIds = courses.map((c) => c.courseId)

  // 반복 차시·변경: courseId in (30개씩)
  const idChunks = chunk(courseIds, 30)
  const [seriesSnaps, overrideSnaps] = await Promise.all([
    Promise.all(idChunks.map((ids) => sref.collection('series').where('courseId', 'in', ids).get())),
    Promise.all(idChunks.map((ids) => sref.collection('overrides').where('courseId', 'in', ids).get())),
  ])

  const series: LessonSeries[] = []
  seriesSnaps.forEach((snap) =>
    snap.docs.forEach((d) => {
      const s = seriesFromDoc(d.id, docData(d))
      if (s.status === 'retired' && !s.validTo) return // 삭제된 차시
      series.push(clipSeriesToTerm(s, termRangeByCourse.get(s.courseId) ?? null))
    })
  )
  series.sort((a, b) => a.weekday - b.weekday || a.period - b.period || a.seriesId.localeCompare(b.seriesId))

  const allOverrides: Array<{ o: Override; raw: Record<string, any> }> = []
  overrideSnaps.forEach((snap) =>
    snap.docs.forEach((d) => {
      const raw = docData(d)
      const o = overrideFromDoc(d.id, raw)
      if (o.status === 'published') allOverrides.push({ o, raw })
    })
  )
  const overrides = selectOverridesForWindow(allOverrides, from, to)
  overrides.sort((a, b) => a.revision - b.revision || a.overrideId.localeCompare(b.overrideId))

  // 소속 학급 표시
  const cls = classSnap && classSnap.exists ? classSnap.data() || {} : null
  const schoolName = String(cls?.schoolName || user.schoolName || '')
  const homeroom = hr
    ? { classId: hr.classId, label: homeroomLabel(cls || { grade: user.grade, classNm: user.classNm }, hr.classId), schoolName, isGroupLegacy: hr.isGroupLegacy }
    : null
  const homerooms: HomeroomMembership[] = homeroomId ? [{ homeroomId, from: null, to: null }] : []

  const periodTimes = buildPeriodTimes(schoolName, periodTimesSnap?.exists ? periodTimesSnap.get('times') : undefined)

  const hasGradeClass = (o: Record<string, any> | null) => !!o && o.grade != null && o.grade !== '' && o.classNm != null && o.classNm !== ''
  const legacyClassTimetableAvailable =
    !!homeroomId && (!!infoTimetableSnap?.exists || hasGradeClass(cls) || hasGradeClass(user))

  const { offDays, calendarErrors } = await offDaysPromise

  return {
    revision,
    generatedAt: Date.now(),
    schoolCode,
    from,
    to,
    term: { termId: term.termId, name: term.name, startDate: term.startDate, endDate: term.endDate, isDefault: term.isDefault },
    terms: termsInWindow.map((t) => ({ termId: t.termId, name: t.name, startDate: t.startDate, endDate: t.endDate, isDefault: t.isDefault })),
    homeroom,
    homerooms,
    enrollments,
    courses,
    series,
    overrides,
    offDays,
    calendarErrors,
    periodTimes,
    legacyClassTimetableAvailable,
  }
}

/** 문서 id로 여러 문서 읽기(100개씩) */
export async function getDocsById(db: Firestore, refs: DocumentReference[]): Promise<DocumentSnapshot[]> {
  const out: DocumentSnapshot[] = []
  for (const part of chunk(refs, 100)) {
    if (!part.length) continue
    out.push(...(await db.getAll(...part)))
  }
  return out
}

