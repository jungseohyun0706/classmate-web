/**
 * 학생 '수업 담기(골라 담기)' — 순수 함수 (Firebase·React 의존 없음, 단위 테스트 대상)
 *
 * 학생은 학교가 공개한 공식 수업(/api/courses catalog) 중에서 골라 담고, 담은 수업은 선생님이 발행한 변경이 자동 반영됩니다.
 * 이 모듈은 화면이 쓰는 계산만 합니다.
 *  - normalizeCatalog: 공개 목록 응답 정리(대상 학년 grades 포함)
 *  - filterByGrade: 내 학년 수업 + 학년 미상 수업(기본), '다른 학년 수업도 보기'면 전부
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
  }
}

/** catalog 응답 → 학기·수업 목록. 모양이 다르면 null(빈 목록으로 위장하지 않음) */
export function normalizeCatalog(data: Record<string, unknown> | null | undefined): { term: PickerTerm | null; courses: PickerCourse[] } | null {
  if (!data || !Array.isArray(data.courses)) return null
  const t = data.term as Partial<PickerTerm> | null | undefined
  const term =
    t && typeof t === 'object' && typeof t.name === 'string'
      ? { termId: String(t.termId || ''), name: t.name, startDate: String(t.startDate || ''), endDate: String(t.endDate || ''), isDefault: t.isDefault === true }
      : null
  const courses = (data.courses as unknown[]).map(normalizeCatalogCourse).filter((c): c is PickerCourse => !!c)
  return { term, courses }
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

/**
 * 학년 거르기: 기본은 내 학년 수업 + 학년 미상 수업(대상 학년을 모르는 수업은 언제나 보임).
 * 내 학년을 모르거나 '다른 학년 수업도 보기'면 전부. hidden = 거른 수업 수
 */
export function filterByGrade<T extends { grades: number[] }>(courses: T[], grade: number | null, showAll: boolean): { shown: T[]; hidden: number } {
  if (showAll || grade === null) return { shown: courses.slice(), hidden: 0 }
  const shown = courses.filter((c) => !c.grades.length || c.grades.indexOf(grade) >= 0)
  return { shown, hidden: courses.length - shown.length }
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
 * 직접 입력 화면의 '이 시간 학교 수업': 요일·교시로만 찾음(입력한 제목과 무관). 자동으로 담거나 연결하지 않고 후보만 돌려줌
 */
export function slotSuggestions(e: EntrySlotLike, catalog: PickerCourse[], mine: MyLesson[], periodTimes: PeriodTime[]): SlotSuggestions {
  const { weekday, periods } = entrySchoolSlot(e, periodTimes)
  if (!weekday || !periods.length) return { weekday, periods, offered: [], linkable: [] }
  const at = (s: { weekday: number; period: number }) => s.weekday === weekday && periods.indexOf(s.period) >= 0
  const mineIds = myCourseIds(mine)
  const offered = catalog
    .filter((c) => !mineIds.has(c.courseId) && c.myStatus !== 'active' && c.myStatus !== 'pending' && c.slots.some(at))
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
 * '학교 수업과 시간이 겹쳐요 — 담기/연결하면 변경이 자동 반영돼요' 안내용. 연결된 일정·제목은 보지 않음
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
  return mine.some((m) => m.status !== 'pending' && at(m)) || catalog.some((c) => c.slots.some(at))
}
