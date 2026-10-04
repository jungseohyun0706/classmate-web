/**
 * 학생 '수업 담기(골라 담기)' — 순수 함수 (Firebase·React 의존 없음, 단위 테스트 대상)
 *
 * 학생은 학교가 공개한 공식 수업(/api/courses catalog) 중에서 골라 담고, 담은 수업은 선생님이 발행한 변경이 자동 반영됩니다.
 * 이 모듈은 화면이 쓰는 계산만 합니다(서버 catalog도 대상 반·학년 판정 courseOfferFor를 같이 씀).
 *  - normalizeCatalog: 공개 목록 응답 정리(대상 학년 grades·대상 반 classLabels·나에게 보이는 방식 offer 포함)
 *  - courseOfferFor: 수업을 이 학생에게 기본으로 보일지('mine') / '다른 반·학년 수업도 보기'에서만('other') / 절대 안 보일지('never' —
 *    다른 반의 반별 수업). 서버가 'never'는 보내지 않음
 *  - filterForStudent: 기본은 'mine' + 이미 내 것인 수업, '다른 반·학년 수업도 보기'면 전부 — 수업 담기 화면과 직접 입력 안내가 같이 씀
 *  - catalogEmptyState: 빈 화면 구분(학교에 공개 수업이 없음 / 내 학년·반 수업이 없음 / 요일·교시가 없음)
 *  - myLessonsFrom: 내 시간표 자료(/api/timetable/me)에서 이미 내 것인 수업의 요일·교시(참여·시작 예정·승인 대기·반 공통)
 *  - myCourseStates: 수업별 내 상태·출처(차시 없는 수업·끝낸 수강 포함) — 카드 상태와 '빼기' 표시
 *  - buildPickerGrid: 요일 × 교시 칸(월~금, 토·일은 차시가 있을 때만, 교시는 있는 것 중 가장 큰 교시까지)
 *  - cartConflicts: 담은 수업끼리 같은 요일·교시 / 담은 수업과 이미 듣는 수업이 같은 요일·교시 — 경고일 뿐 막지 않음
 *  - mapRequestResults: requestMany 응답 → 수업마다 '추가됨 / 선생님 승인 대기 / 이미 있음 / 담지 못함(이유)'
 *  - slotSuggestions·entryOverlapsSchool: 직접 입력 일정의 요일·교시(또는 학교 교시 안의 시각)로만 학교 수업을 찾음
 *    — 입력한 제목(이름)으로는 절대 찾거나 연결하지 않습니다(이름 기반 연결 금지 원칙)
 */
import { courseActiveOn, slotMinutes } from './engine'
import { weekdayOf } from './dates'
import type { Course, Enrollment, EnrollmentSource, HomeroomMembership, LessonSeries, PeriodTime, Ymd } from './types'

// ───────────────────────── 공개 목록(catalog) ─────────────────────────

export type PickStatus = 'active' | 'pending' | 'ended'

export interface PickerSlot {
  weekday: number
  period: number
  /** 차시 교실(없으면 수업의 기본 교실) */
  roomName: string | null
}

/** /api/courses catalog 응답의 수업 한 개(정리한 모양) */
export interface PickerCourse {
  courseId: string
  title: string
  subject: string
  section: string | null
  teacherNames: string[]
  defaultRoomName: string | null
  invitePolicy: 'auto' | 'approval'
  slots: PickerSlot[]
  /** 내 수강 상태(목록을 받은 시점) */
  myStatus: PickStatus | null
  /** 대상 학년(1~6). 비면 학년 미상 — 모든 학년에 보임 */
  grades: number[]
  /** 대상 반('2-1'). 하나면 그 반의 반별 수업(그 반 학생에게만 옴), 둘 이상이면 이동·선택 수업, 비면 반 정보 없음 */
  classLabels: string[]
  /**
   * 서버가 정한 나에게 보이는 방식: 'mine' 기본으로 보임(내 반·학년, 반·학년 미상, 이미 내 수강) /
   * 'other' '다른 반·학년 수업도 보기'에서만. 다른 반의 반별 수업('never')은 서버가 보내지 않음
   */
  offer: 'mine' | 'other'
}

/** catalog 응답의 '나'(학생 프로필 기준 — 거르기 안내 문구용) */
export interface CatalogMe {
  /** 내 학년(users.grade) — 모르면 null */
  grade: number | null
  /** 내 반('2-1' — users.grade + users.classNm) — 모르면 null(반별 수업이 보이지 않음) */
  classLabel: string | null
}

export interface PickerTerm {
  termId: string
  name: string
  startDate: string
  endDate: string
  isDefault: boolean
}

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [])
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** 대상 학년 값 정리: 1~6 정수만, 중복 없이 오름차순 */
export function cleanGrades(v: unknown): number[] {
  if (!Array.isArray(v)) return []
  const out: number[] = []
  v.forEach((x) => {
    const n = typeof x === 'number' ? x : NaN
    if (Number.isInteger(n) && n >= 1 && n <= 6 && out.indexOf(n) < 0) out.push(n)
  })
  return out.sort((a, b) => a - b)
}

export function normalizeCatalogCourse(v: unknown): PickerCourse | null {
  const c = v as Record<string, unknown> | null
  if (!c || typeof c !== 'object' || typeof c.courseId !== 'string' || !c.courseId) return null
  const defaultRoomName = str(c.defaultRoomName)
  const seen = new Set<string>()
  const slots: PickerSlot[] = []
  if (Array.isArray(c.slots)) {
    ;(c.slots as unknown[]).forEach((raw) => {
      const s = raw as { weekday?: unknown; period?: unknown; roomName?: unknown } | null
      if (!s) return
      const weekday = Number(s.weekday)
      const period = Number(s.period)
      if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7 || !Number.isInteger(period) || period < 0 || period > 20) return
      const k = `${weekday}-${period}`
      if (seen.has(k)) return
      seen.add(k)
      slots.push({ weekday, period, roomName: str(s.roomName) ?? defaultRoomName })
    })
  }
  slots.sort((a, b) => a.weekday - b.weekday || a.period - b.period)
  const st = c.myStatus
  return {
    courseId: c.courseId,
    title: str(c.title) ?? '수업',
    subject: typeof c.subject === 'string' ? c.subject : '',
    section: str(c.section),
    teacherNames: strArr(c.teacherNames),
    defaultRoomName,
    invitePolicy: c.invitePolicy === 'approval' ? 'approval' : 'auto',
    slots,
    myStatus: st === 'active' || st === 'pending' || st === 'ended' ? st : null,
    grades: cleanGrades(c.grades),
    classLabels: cleanClassLabels(c.classLabels),
    // 서버가 'other'라고 한 수업만 기본 보기에서 숨김(값이 없거나 다르면 기본으로 보임 — 숨길 근거가 없으므로)
    offer: c.offer === 'other' ? 'other' : 'mine',
  }
}

export interface NormalizedCatalog {
  term: PickerTerm | null
  courses: PickerCourse[]
  me: CatalogMe
  /** 보내지 않은 다른 반의 반별 수업 수('학교에 공개 수업이 없어요'와 '내 학년·반 수업이 없어요'를 구분하는 데만 씀) */
  withheld: number
}

/** catalog 응답 → 학기·수업 목록. 모양이 다르면 null(빈 목록으로 위장하지 않음) */
export function normalizeCatalog(data: Record<string, unknown> | null | undefined): NormalizedCatalog | null {
  if (!data || !Array.isArray(data.courses)) return null
  const t = data.term as Partial<PickerTerm> | null | undefined
  const term =
    t && typeof t === 'object' && typeof t.name === 'string'
      ? { termId: String(t.termId || ''), name: t.name, startDate: String(t.startDate || ''), endDate: String(t.endDate || ''), isDefault: t.isDefault === true }
      : null
  const courses = (data.courses as unknown[]).map(normalizeCatalogCourse).filter((c): c is PickerCourse => !!c)
  const m = data.me as { grade?: unknown; classLabel?: unknown } | null | undefined
  const me: CatalogMe = {
    grade: m && typeof m === 'object' ? studentGradeOf(m.grade) : null,
    classLabel: m && typeof m === 'object' ? cleanClassLabels([m.classLabel])[0] ?? null : null,
  }
  const w = Number(data.withheld)
  return { term, courses, me, withheld: Number.isInteger(w) && w > 0 ? w : 0 }
}

/** 화면 제목: 제목에 분반이 없으면 '영어 · B' (LessonCard.lessonTitle과 같은 규칙) */
export function pickerTitle(c: { title: string; section?: string | null }): string {
  if (c.section && !c.title.includes(c.section)) return `${c.title} · ${c.section}`
  return c.title
}

/** 학생 프로필의 학년(users.grade) → 1~6 정수, 모르면 null */
export function studentGradeOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.trim()) : NaN
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : null
}

// ───────────────────────── 대상 반·학년(누구에게 보여 줄지) ─────────────────────────

const CLASS_LABEL_RE = /^([1-6])-([1-9][0-9]?)$/

const labelParts = (l: string): [number, number] => {
  const i = l.indexOf('-')
  return [Number(l.slice(0, i)), Number(l.slice(i + 1))]
}

/** 학급 표시 '2-1' 순서: 학년 → 반(숫자) */
export function compareClassLabels(a: string, b: string): number {
  const [ga, ca] = labelParts(a)
  const [gb, cb] = labelParts(b)
  return ga - gb || ca - cb
}

/**
 * 대상 반 값 정리: 'g-c'(1~6학년·1~99반, 앞자리 0 없음 — 가져오기·교사 입력이 저장하는 모양)만, 중복 없이 학년·반 순.
 * 형식이 다른 값은 버림(다른 반 수업을 내 반 수업으로 잘못 읽지 않게 — 읽을 수 없는 표시는 없는 것으로)
 */
export function cleanClassLabels(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  v.forEach((x) => {
    if (typeof x !== 'string') return
    const m = CLASS_LABEL_RE.exec(x.trim())
    if (!m) return
    const l = `${m[1]}-${m[2]}`
    if (out.indexOf(l) < 0) out.push(l)
  })
  return out.sort(compareClassLabels)
}

/**
 * 학생 프로필(users.grade·users.classNm) → 내 반 '2-1'. 학년 1~6·반 1~99(숫자·'4'·'4반')가 아니면 null.
 * 서버 catalog·requestMany와 화면이 같은 값으로 판정
 */
export function studentClassLabelOf(grade: unknown, classNm: unknown): string | null {
  const g = studentGradeOf(grade)
  let c = NaN
  if (typeof classNm === 'number') c = classNm
  else if (typeof classNm === 'string') {
    const m = /^(\d{1,2})반?$/.exec(classNm.trim())
    if (m) c = Number(m[1])
  }
  if (g === null || !Number.isInteger(c) || c < 1 || c > 99) return null
  return `${g}-${c}`
}

/**
 * 수업의 대상 범위:
 *  - 'homeroom' 반별 수업 — 대상 반이 정확히 하나(가져오기의 한 학급 수업 'hr|2-1|국어|…'처럼 칸이 모두 한 반에서 나온 수업,
 *    또는 교사가 대상 반을 하나만 정한 수업). 그 반의 정규 수업이라 그 반 학생만 담을 수 있음
 *  - 'classes' 여러 반 수업 — 대상 반이 둘 이상(이동·선택·합반 수업). 기본은 그 반 학생, 다른 반 학생도 '보기'로 찾을 수 있음
 *  - 'grades' 대상 반은 없고 대상 학년만 앎 / 'all' 반·학년 모두 모름(모든 학생에게 보임)
 */
export type CourseAudienceKind = 'homeroom' | 'classes' | 'grades' | 'all'

export function courseAudienceKind(c: { classLabels?: unknown; grades?: unknown }): CourseAudienceKind {
  const labels = cleanClassLabels(c.classLabels)
  if (labels.length === 1) return 'homeroom'
  if (labels.length > 1) return 'classes'
  return cleanGrades(c.grades).length ? 'grades' : 'all'
}

/** 'mine' 기본으로 보임 · 'other' '다른 반·학년 수업도 보기'에서만 · 'never' 이 학생에게는 보이지 않음(담을 수도 없음) */
export type CourseOffer = 'mine' | 'other' | 'never'

export interface StudentScope {
  /** 내 학년(users.grade) — 모르면 null */
  grade: number | null
  /** 내 반('2-1') — 모르면 null */
  classLabel: string | null
}

/** 학생 프로필(users 문서) → 판정에 쓰는 내 학년·반 */
export function studentScopeOf(user: { grade?: unknown; classNm?: unknown } | null | undefined): StudentScope {
  return { grade: studentGradeOf(user?.grade), classLabel: studentClassLabelOf(user?.grade, user?.classNm) }
}

/**
 * 수업을 이 학생에게 어떻게 보여 줄지 — 서버 catalog(보낼지·offer)와 requestMany(다른 반의 반별 수업 거절)가 이 함수를 씀.
 *  - 반별 수업(대상 반 하나): 내 반이면 'mine', 아니면 'never'. **'다른 반·학년 수업도 보기'로도 보이지 않음** —
 *    다른 반의 정규 수업(같은 학년 2-2의 국어 등)이라 담으면 남의 반 시간표가 내 시간표가 되기 때문.
 *    내 반을 모르면(프로필에 반이 없음) 어느 반 수업인지 확인할 수 없어 'never'(소속 학급을 등록하면 보임)
 *  - 여러 반 수업: 내 반이 대상 반에 있으면 'mine', 아니면 'other'(보기로 찾을 수 있음 — 선택 과목은 다른 반 학생도 들을 수 있음).
 *    내 반을 모르면 대상 반들의 학년으로(내 학년이 있으면 'mine', 내 학년도 모르면 'mine')
 *  - 대상 반이 없는 수업은 예전 학년 규칙: 대상 학년이 없거나 내 학년을 모르거나 내 학년이 들어 있으면 'mine', 아니면 'other'
 * 이미 내 수강(참여·승인 대기)인 수업은 이 판정과 상관없이 내 것으로 보임(호출하는 쪽이 먼저 확인 — catalog·filterForStudent)
 */
export function courseOfferFor(c: { classLabels?: unknown; grades?: unknown }, me: StudentScope): CourseOffer {
  const labels = cleanClassLabels(c.classLabels)
  if (labels.length === 1) return me.classLabel !== null && me.classLabel === labels[0] ? 'mine' : 'never'
  if (labels.length > 1) {
    if (me.classLabel !== null) return labels.indexOf(me.classLabel) >= 0 ? 'mine' : 'other'
    if (me.grade === null) return 'mine'
    return labels.some((l) => labelParts(l)[0] === me.grade) ? 'mine' : 'other'
  }
  const grades = cleanGrades(c.grades)
  if (!grades.length || me.grade === null) return 'mine'
  return grades.indexOf(me.grade) >= 0 ? 'mine' : 'other'
}

/**
 * 서버 catalog가 보낼 수업과 수업마다 offer — me가 null(학생이 아님)이면 거르지 않음(모두 'mine').
 * 이미 내 수강(참여·승인 대기)인 수업은 판정과 상관없이 'mine'으로 보냄(내 수업은 언제나 내 것으로 보임).
 * 'never'(다른 반의 반별 수업)는 보내지 않고 개수만(withheld) — 학교에 공개 수업이 없다는 안내와 구분하는 데만 씀
 */
export function offerCatalog<T extends { courseId: string; classLabels?: unknown; grades?: unknown }>(
  courses: T[],
  me: StudentScope | null,
  myStatusOf: (courseId: string) => string | null | undefined
): { sent: Array<{ course: T; offer: 'mine' | 'other' }>; withheld: number } {
  const sent: Array<{ course: T; offer: 'mine' | 'other' }> = []
  let withheld = 0
  courses.forEach((c) => {
    const st = myStatusOf(c.courseId)
    const offer: CourseOffer = !me || st === 'active' || st === 'pending' ? 'mine' : courseOfferFor(c, me)
    if (offer === 'never') withheld++
    else sent.push({ course: c, offer })
  })
  return { sent, withheld }
}

/**
 * 공개 목록 거르기 — 수업 담기 화면(칸 보기·과목으로 찾기)과 직접 입력 안내('이 시간 학교 수업'·'학교 수업과 시간이 겹쳐요')가
 * 같은 함수를 씀. 기본은 서버가 'mine'이라고 한 수업 + 이미 내 것인 수업(myIds — 참여·시작 예정·승인 대기·반 공통),
 * showAll('다른 반·학년 수업도 보기')이면 받은 수업 전부(다른 반의 반별 수업은 서버가 보내지 않아 여기에도 없음).
 * hidden = 기본 보기에서 숨긴 수(보기를 켜면 보이는 수)
 */
export function filterForStudent<T extends { courseId: string; offer: 'mine' | 'other' }>(
  courses: T[],
  showAll: boolean,
  myIds?: Set<string> | null
): { shown: T[]; hidden: number } {
  if (showAll) return { shown: courses.slice(), hidden: 0 }
  const shown = courses.filter((c) => c.offer === 'mine' || (!!myIds && myIds.has(c.courseId)))
  return { shown, hidden: courses.length - shown.length }
}

/** 수업별 내 상태 중 지금 내 것(참여 중·시작 예정·반 공통·승인 대기)인 수업 id */
export function activeOrPendingIds(states: Map<string, { status: PickStatus }> | null | undefined): Set<string> {
  const out = new Set<string>()
  if (states) states.forEach((s, id) => s.status !== 'ended' && out.add(id))
  return out
}

/**
 * 수업 담기 빈 화면 구분(칸 보기·과목으로 찾기 공통):
 *  - 'no-public'  학교에 이번 학기 공개 수업이 하나도 없음(받은 수업 0개이고 보내지 않은 다른 반 반별 수업도 0개)
 *  - 'no-mine'    공개 수업은 있지만 지금 보기에 보이는 수업이 없음(모두 다른 반·학년 수업) — canShowOthers면
 *                 '다른 반·학년 수업도 보기'를 켜면 보이는 수업이 있음(없으면 다른 반의 반별 수업뿐이라 켜도 안 보임)
 *  - null         보이는 수업이 있음
 */
export function catalogEmptyState(x: { total: number; withheld: number; shown: number; hidden: number; showAll: boolean }): { kind: 'no-public' } | { kind: 'no-mine'; canShowOthers: boolean } | null {
  if (x.total === 0 && x.withheld === 0) return { kind: 'no-public' }
  if (x.shown > 0) return null
  return { kind: 'no-mine', canShowOthers: !x.showAll && x.hidden > 0 }
}

// ───────────────────────── 내 시간표에 이미 있는 수업 ─────────────────────────

export type MyLessonStatus = 'active' | 'upcoming' | 'pending' | 'common'

/** 이미 내 것인 수업의 요일·교시 하나(칸 표시·겹침 경고·직접 입력 안내용) */
export interface MyLesson {
  courseId: string
  title: string
  status: MyLessonStatus
  /** 수강 출처(반 공통 수업은 'common') — '빼기'는 'request'만 */
  source: EnrollmentSource | 'common'
  weekday: number
  period: number
  roomName: string | null
  /** 직접 입력 일정을 연결할 수 있는 수업(오늘 활성 수강 — PersonalEntryForm linkableCourses와 같은 기준) */
  linkable: boolean
}

/** /api/timetable/me 자료 중 필요한 부분(client.ts MyTimetablePayload와 호환) */
export interface PayloadLike {
  enrollments: Enrollment[]
  courses: Course[]
  series: LessonSeries[]
  homerooms: HomeroomMembership[]
}

const inRange = (d: Ymd, from?: Ymd | null, to?: Ymd | null) => (!from || d >= from) && (!to || d < to)

/** 수업의 반복 차시 중 그 날짜 이후에도 이어지는 요일·교시(client.courseSchedule과 같은 규칙, 요일·교시로 중복 제거) */
export function courseSlotsFrom(p: Pick<PayloadLike, 'courses' | 'series'>, courseId: string, fromDate: Ymd): PickerSlot[] {
  const course = p.courses.find((c) => c.courseId === courseId)
  const seen = new Set<string>()
  const out: PickerSlot[] = []
  p.series
    .filter((s) => s.courseId === courseId && s.status !== 'retired' && (!s.validTo || s.validTo > fromDate) && (!s.validTo || s.validFrom < s.validTo))
    .sort((a, b) => a.weekday - b.weekday || a.period - b.period || a.validFrom.localeCompare(b.validFrom))
    .forEach((s) => {
      const k = `${s.weekday}-${s.period}`
      if (seen.has(k)) return
      seen.add(k)
      out.push({ weekday: s.weekday, period: s.period, roomName: s.roomName || course?.defaultRoomName || null })
    })
  return out
}

/**
 * 이미 내 시간표에 있는(또는 승인을 기다리는) 수업의 요일·교시.
 * 본인 수강: active(오늘 이후에도 이어짐 — 시작 예정 포함), pending. 반 공통 수업: 지금 소속 학급에 명시된 수업.
 * 수강이 있으면 공통 수업보다 수강 출처를 씀(courseId 중복 없음). 끝난 수업·끝난 수강은 넣지 않음
 */
export function myLessonsFrom(p: PayloadLike, uid: string, today: Ymd): MyLesson[] {
  const byId = new Map(p.courses.map((c) => [c.courseId, c] as const))
  const out: MyLesson[] = []
  const seen = new Set<string>()
  const push = (c: Course, status: MyLessonStatus, source: MyLesson['source'], linkable: boolean) => {
    if (seen.has(c.courseId)) return
    seen.add(c.courseId)
    courseSlotsFrom(p, c.courseId, today).forEach((s) =>
      out.push({ courseId: c.courseId, title: pickerTitle(c), status, source, weekday: s.weekday, period: s.period, roomName: s.roomName, linkable })
    )
  }
  p.enrollments
    .filter((e) => e.uid === uid && !!e.courseId)
    .forEach((e) => {
      const c = byId.get(e.courseId)
      if (!c || !courseActiveOn(c, today)) return
      if (e.status === 'pending') return push(c, 'pending', e.source, false)
      if (e.status !== 'active' || (e.to && e.to <= today)) return
      const upcoming = !!e.from && e.from > today
      push(c, upcoming ? 'upcoming' : 'active', e.source, !upcoming && inRange(today, e.from, e.to))
    })
  const hrs = p.homerooms.filter((h) => inRange(today, h.from, h.to)).map((h) => h.homeroomId)
  p.courses.forEach((c) => {
    if (!courseActiveOn(c, today) || !c.commonForHomerooms.some((h) => hrs.indexOf(h) >= 0)) return
    push(c, 'common', 'common', false)
  })
  return out.sort((a, b) => a.weekday - b.weekday || a.period - b.period || a.title.localeCompare(b.title, 'ko'))
}

/** 이미 내 것(참여·시작 예정·승인 대기·반 공통)인 수업 id */
export function myCourseIds(mine: MyLesson[]): Set<string> {
  return new Set(mine.map((m) => m.courseId))
}

/** 수업 하나에 대한 내 상태(내 시간표 자료 기준) */
export interface MyCourseState {
  /** active: 참여 중·시작 예정·반 공통 / pending: 승인 대기 / ended: 끝냄·뺌·거절(다시 담을 수 있음) */
  status: PickStatus
  /** 수강 출처(반 공통 수업은 'common') — '빼기'는 'request'만 */
  source: EnrollmentSource | 'common'
}

/**
 * 수업별 내 상태 — 수업 담기 카드의 상태·'빼기' 표시용. myLessonsFrom(요일·교시가 있는 수업만)과 달리
 * 차시가 아직 없는 수업도 포함하고, 끝낸·뺀 수강도 'ended'로 남김(목록 응답의 myStatus보다 최신일 수 있는 내 시간표 자료 기준).
 * 본인 수강: pending → pending, active(끝나는 날이 오늘 뒤이거나 없음 — 시작 예정 포함) → active, 그 밖 → ended.
 * 반 공통 수업(지금 소속 학급에 명시, 운영 중)은 수강이 active·pending이 아니면 active(출처 common)
 */
export function myCourseStates(p: PayloadLike, uid: string, today: Ymd): Map<string, MyCourseState> {
  const out = new Map<string, MyCourseState>()
  const put = (courseId: string, st: MyCourseState) => {
    const prev = out.get(courseId)
    if (prev && prev.status !== 'ended') return
    out.set(courseId, st)
  }
  p.enrollments
    .filter((e) => e.uid === uid && !!e.courseId)
    .forEach((e) => {
      const status: PickStatus = e.status === 'pending' ? 'pending' : e.status === 'active' && (!e.to || e.to > today) ? 'active' : 'ended'
      put(e.courseId, { status, source: e.source })
    })
  const hrs = p.homerooms.filter((h) => inRange(today, h.from, h.to)).map((h) => h.homeroomId)
  p.courses.forEach((c) => {
    if (!courseActiveOn(c, today) || !c.commonForHomerooms.some((h) => hrs.indexOf(h) >= 0)) return
    put(c.courseId, { status: 'active', source: 'common' })
  })
  return out
}

// ───────────────────────── 시간표 칸 보기 ─────────────────────────

export interface GridCell {
  weekday: number
  period: number
  /** 이 칸에 열리는 공개 수업(제목 순) — 이미 내 것인 수업도 포함(화면이 상태로 구분) */
  offered: PickerCourse[]
  /** 이 칸에 이미 있는 내 수업 */
  mine: MyLesson[]
}

export interface PickerGrid {
  weekdays: number[]
  periods: number[]
  cells: Record<string, GridCell>
}

export const cellKey = (weekday: number, period: number) => `${weekday}-${period}`

/**
 * 요일 × 교시 칸. 요일은 월~금(토·일은 공개 수업이나 내 수업 차시가 있을 때만), 교시는 1교시부터 있는 교시 중 가장 큰 교시까지
 * (0교시 차시가 있으면 0교시부터). 차시가 하나도 없으면 칸 없음(periods []).
 */
export function buildPickerGrid(courses: PickerCourse[], mine: MyLesson[]): PickerGrid {
  const cells: Record<string, GridCell> = {}
  const cell = (w: number, p: number) => (cells[cellKey(w, p)] = cells[cellKey(w, p)] || { weekday: w, period: p, offered: [], mine: [] })
  let maxP = -1
  let minP = 1
  let sat = false
  let sun = false
  const note = (w: number, p: number) => {
    if (p > maxP) maxP = p
    if (p < minP) minP = p
    if (w === 6) sat = true
    if (w === 7) sun = true
  }
  courses.forEach((c) =>
    c.slots.forEach((s) => {
      note(s.weekday, s.period)
      const x = cell(s.weekday, s.period)
      if (!x.offered.some((o) => o.courseId === c.courseId)) x.offered.push(c)
    })
  )
  mine.forEach((m) => {
    note(m.weekday, m.period)
    const x = cell(m.weekday, m.period)
    if (!x.mine.some((o) => o.courseId === m.courseId)) x.mine.push(m)
  })
  Object.keys(cells).forEach((k) => cells[k].offered.sort((a, b) => pickerTitle(a).localeCompare(pickerTitle(b), 'ko') || a.courseId.localeCompare(b.courseId)))
  const weekdays = [1, 2, 3, 4, 5].concat(sat ? [6] : [], sun ? [7] : [])
  const periods: number[] = []
  if (maxP >= 0) for (let p = Math.min(minP, 1); p <= maxP; p++) periods.push(p)
  return { weekdays, periods, cells }
}

// ───────────────────────── 담은 수업(장바구니) 겹침 ─────────────────────────

export interface CartConflict {
  /** 'picks' 담은 수업끼리 / 'mine' 담은 수업과 이미 있는 내 수업 */
  kind: 'picks' | 'mine'
  weekday: number
  period: number
  /** 겹친 담은 수업 id(담은 순서) */
  courseIds: string[]
  /** kind 'mine': 겹친 내 수업 */
  mine: MyLesson[]
}

/**
 * 담은 수업 겹침(같은 요일·교시). 경고일 뿐 — 학생은 그대로 담거나 빼면 됨.
 * 이미 내 것인 수업을 다시 담은 경우(같은 courseId)는 겹침으로 보지 않음
 */
export function cartConflicts(picks: PickerCourse[], mine: MyLesson[]): CartConflict[] {
  const out: CartConflict[] = []
  const bySlot = new Map<string, { weekday: number; period: number; ids: string[] }>()
  picks.forEach((c) =>
    c.slots.forEach((s) => {
      const k = cellKey(s.weekday, s.period)
      const g = bySlot.get(k) || { weekday: s.weekday, period: s.period, ids: [] }
      if (g.ids.indexOf(c.courseId) < 0) g.ids.push(c.courseId)
      bySlot.set(k, g)
    })
  )
  const pickIds = new Set(picks.map((p) => p.courseId))
  Array.from(bySlot.values())
    .sort((a, b) => a.weekday - b.weekday || a.period - b.period)
    .forEach((g) => {
      if (g.ids.length > 1) out.push({ kind: 'picks', weekday: g.weekday, period: g.period, courseIds: g.ids.slice(), mine: [] })
      const hit = mine.filter((m) => m.weekday === g.weekday && m.period === g.period && !pickIds.has(m.courseId))
      if (hit.length) out.push({ kind: 'mine', weekday: g.weekday, period: g.period, courseIds: g.ids.slice(), mine: hit })
    })
  return out
}

// ───────────────────────── 담기 결과 ─────────────────────────

export type PickResultKind = 'added' | 'pending' | 'already' | 'failed'

export interface PickResult {
  courseId: string
  kind: PickResultKind
  /** 화면 문구: '추가됨' / '선생님 승인 대기' / '이미 있음' / '담지 못함' */
  label: string
  /** 'already'의 상태 또는 실패 이유 */
  detail: string | null
  /** 서버 code(실패) */
  code: string | null
}

/** 수업 하나 실패 이유 — /api/enrollments request·requestMany의 code 기준 */
export function pickFailureText(code: string): string {
  switch (code) {
    case 'not-open':
      return '학교가 공개하지 않은 수업이에요. 선생님께 수업 초대를 받아 주세요.'
    case 'course-ended':
      return '이미 끝난 수업이에요.'
    case 'other-term':
      return '이번 학기 수업이 아니에요.'
    case 'other-class':
      return '다른 반의 반별 수업이라 담을 수 없어요. 우리 반 수업을 골라 주세요.'
    case 'course-not-found':
      return '수업을 찾을 수 없어요. 목록을 새로 고쳐 주세요.'
    case 'invalid-id':
      return '수업 정보가 올바르지 않아요. 목록을 새로 고쳐 주세요.'
    case 'missing':
      return '결과를 받지 못했어요. 내 수업 목록에서 다시 확인해 주세요.'
    default:
      return `담지 못했어요 (${code}).`
  }
}

/**
 * requestMany 응답(results) → 담은 순서대로 수업마다 결과. 응답에 없는 수업은 '담지 못함'(결과 모름)으로 —
 * 성공으로 위장하지 않음
 */
export function mapRequestResults(courseIds: string[], data: Record<string, unknown> | null | undefined): PickResult[] {
  const list = data && Array.isArray(data.results) ? (data.results as unknown[]) : []
  const byId = new Map<string, Record<string, unknown>>()
  list.forEach((r) => {
    const x = r as Record<string, unknown> | null
    if (x && typeof x.courseId === 'string' && !byId.has(x.courseId)) byId.set(x.courseId, x)
  })
  const seen = new Set<string>()
  const out: PickResult[] = []
  courseIds.forEach((id) => {
    if (seen.has(id)) return
    seen.add(id)
    const r = byId.get(id)
    if (!r) {
      out.push({ courseId: id, kind: 'failed', label: '담지 못함', detail: pickFailureText('missing'), code: 'missing' })
      return
    }
    if (r.ok === true && (r.status === 'active' || r.status === 'pending')) {
      if (r.already === true) {
        out.push({ courseId: id, kind: 'already', label: '이미 있음', detail: r.status === 'pending' ? '승인 대기 중' : '참여 중', code: null })
      } else if (r.status === 'active') {
        out.push({ courseId: id, kind: 'added', label: '추가됨', detail: null, code: null })
      } else {
        out.push({ courseId: id, kind: 'pending', label: '선생님 승인 대기', detail: null, code: null })
      }
      return
    }
    const code = typeof r.code === 'string' && r.code ? r.code.slice(0, 40) : 'unknown'
    out.push({ courseId: id, kind: 'failed', label: '담지 못함', detail: pickFailureText(code), code })
  })
  return out
}

/** 결과 요약: '2개 추가됨 · 1개 승인 대기 · 1개 담지 못함' */
export function pickSummaryText(results: PickResult[]): string {
  const n = (k: PickResultKind) => results.filter((r) => r.kind === k).length
  const parts: string[] = []
  if (n('added')) parts.push(`${n('added')}개 추가됨`)
  if (n('pending')) parts.push(`${n('pending')}개 선생님 승인 대기`)
  if (n('already')) parts.push(`${n('already')}개 이미 있음`)
  if (n('failed')) parts.push(`${n('failed')}개 담지 못함`)
  return parts.join(' · ') || '담은 수업이 없어요'
}

// ───────────────────────── 직접 입력 일정 ↔ 학교 수업(요일·교시로만) ─────────────────────────

/** 직접 입력 일정의 요일·시간(제목은 받지 않음 — 이름으로 학교 수업을 찾지 않기 위해) */
export interface EntrySlotLike {
  kind: 'weekly' | 'once'
  weekday: number | null
  date: Ymd | null
  period: number | null
  start: string | null
  end: string | null
}

/**
 * 일정의 요일과 학교 교시. 교시를 골랐으면 그 교시, 시각만 있으면 교시표에서 그 시각과 겹치는 교시들(학교 교시 안의 시각만).
 * 요일을 모르거나 교시·시각이 없으면 periods [].
 */
export function entrySchoolSlot(e: EntrySlotLike, periodTimes: PeriodTime[]): { weekday: number | null; periods: number[] } {
  const weekday = e.kind === 'once' ? (e.date && /^\d{8}$/.test(e.date) ? weekdayOf(e.date) : null) : e.weekday && e.weekday >= 1 && e.weekday <= 7 ? e.weekday : null
  if (!weekday) return { weekday: null, periods: [] }
  if (e.period !== null && e.period !== undefined && Number.isInteger(e.period)) return { weekday, periods: [e.period] }
  if (!e.start) return { weekday, periods: [] }
  const x = slotMinutes({ period: null, start: e.start, end: e.end }, periodTimes)
  if (x.start === null || x.end === null) return { weekday, periods: [] }
  const periods = periodTimes
    .filter((pt) => {
      const y = slotMinutes({ period: pt.period, start: pt.start, end: pt.end }, periodTimes)
      return y.start !== null && y.end !== null && (x.start as number) < y.end && y.start < (x.end as number)
    })
    .map((pt) => pt.period)
    .sort((a, b) => a - b)
  return { weekday, periods }
}

export interface SlotSuggestions {
  weekday: number | null
  periods: number[]
  /** 그 요일·교시에 열리는 공개 수업 중 아직 내 것이 아닌 수업 — '담기' 빠른 선택 */
  offered: PickerCourse[]
  /** 그 요일·교시에 이미 듣는 수업(연결 가능한 활성 수강) — 기존 '연결' */
  linkable: MyLesson[]
}

/**
 * 직접 입력 화면의 '이 시간 학교 수업': 요일·교시로만 찾음(입력한 제목과 무관). 자동으로 담거나 연결하지 않고 후보만 돌려줌.
 * 담기 후보는 수업 담기의 기본 보기와 같은 거르기(filterForStudent — 내 반·학년 수업, 다른 반·학년 수업은 빠짐)를 거친 수업만
 */
export function slotSuggestions(e: EntrySlotLike, catalog: PickerCourse[], mine: MyLesson[], periodTimes: PeriodTime[]): SlotSuggestions {
  const { weekday, periods } = entrySchoolSlot(e, periodTimes)
  if (!weekday || !periods.length) return { weekday, periods, offered: [], linkable: [] }
  const at = (s: { weekday: number; period: number }) => s.weekday === weekday && periods.indexOf(s.period) >= 0
  const mineIds = myCourseIds(mine)
  const offered = filterForStudent(catalog, false, mineIds)
    .shown.filter((c) => !mineIds.has(c.courseId) && c.myStatus !== 'active' && c.myStatus !== 'pending' && c.slots.some(at))
    .sort((a, b) => pickerTitle(a).localeCompare(pickerTitle(b), 'ko') || a.courseId.localeCompare(b.courseId))
  const seen = new Set<string>()
  const linkable = mine.filter((m) => {
    if (!m.linkable || !at(m) || seen.has(m.courseId)) return false
    seen.add(m.courseId)
    return true
  })
  return { weekday, periods, offered, linkable }
}

/**
 * 연결되지 않은 직접 입력 일정이 같은 요일·교시의 학교 수업(내 수업 또는 공개 수업)과 겹치는지 —
 * '학교 수업과 시간이 겹쳐요 — 담기/연결하면 변경이 자동 반영돼요' 안내용. 연결된 일정·제목은 보지 않음.
 * 공개 수업은 수업 담기의 기본 보기와 같은 거르기(filterForStudent)를 거친 수업만 — 다른 반·학년 수업 때문에 안내하지 않음
 */
export function entryOverlapsSchool(
  e: EntrySlotLike & { linkedCourseId?: string | null },
  catalog: PickerCourse[],
  mine: MyLesson[],
  periodTimes: PeriodTime[]
): boolean {
  if (e.linkedCourseId) return false
  const { weekday, periods } = entrySchoolSlot(e, periodTimes)
  if (!weekday || !periods.length) return false
  const at = (s: { weekday: number; period: number }) => s.weekday === weekday && periods.indexOf(s.period) >= 0
  return mine.some((m) => m.status !== 'pending' && at(m)) || filterForStudent(catalog, false, myCourseIds(mine)).shown.some((c) => c.slots.some(at))
}
