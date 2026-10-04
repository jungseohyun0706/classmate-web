/**
 * 교사 '내 시간표'(대시보드 메인 화면 — 오늘의 내 수업) — 순수 함수
 * 브라우저·Firebase 없이 단위 테스트합니다(tests/unit/teacher-home-*.test.ts). 서버(teacherData.ts)와 화면이 함께 씁니다.
 *
 * 1) computeTeacherOfficialDay (서버): 공식 수업(schools/{s}/courses·series·overrides)으로 그 날 '내 수업'을 계산.
 *    - 학생 화면과 같은 엔진(buildDayTimetable)으로 변경을 적용 — 변경 전후 정보가 학생 화면과 같음
 *    - 내 수업 판정은 uid로만: 변경 후 최종 담당 교사 uid에 내가 있으면 내 수업. 교사 이름만 같은 수업은 내 것이 아님
 *      · 내 차시(기본 담당이 나)를 다른 선생님에게 넘김 → 'changed-away'(빨강, 전후)
 *      · 다른 수업 차시를 나에게 넘김 → 'substitute'(대신 들어가는 수업)
 *      · 내 차시 취소 → 취소 안내(화면은 취소선 행), 다른 날로 옮김 → 옮겨 감 안내, 보강 → 'makeup'
 *    - 다른 교사 uid는 결과에 넣지 않음(이름만)
 * 2) buildTeacherDay (화면): 날짜마다 무엇을 기본 목록으로 보일지 정함
 *    - 그 날짜 학기에 내가 맡은 운영 중 공식 수업(반복 차시)이 있으면 공식 수업이 기본, 직접 등록 주간 시간표는 접힌 참고
 *    - 없고 직접 등록 주간 시간표(users.mySchedule)가 있으면 그 요일 칸 — '수업 변경은 반영되지 않아요'
 *    - 둘 다 없으면 빈 상태(수업 관리·내 시간표 등록)
 *    - 모든 방식에 예전 교환(품앗이)·보결(SOS) 겹쳐 표시
 *    - 쉬는 날·주말·학기 밖은 학생 화면과 같은 상태
 */
import { baseStateOf, buildDayTimetable, courseActiveOn, parseOccurrenceKey, slotMinutes } from './engine'
import { addDays, inRange, isYmd, weekdayOf } from './dates'
import type { ChangeInfo, Course, Enrollment, LessonSeries, LessonView, NoticeView, Override, PeriodTime, SlotState, Ymd } from './types'

// ───────────────────────── 자료 형식 ─────────────────────────

export type TeacherLessonRole =
  | 'mine' // 내 수업(변경이 있으면 전후 표시)
  | 'makeup' // 내가 맡은 보강
  | 'substitute' // 다른 수업인데 변경으로 내가 맡음
  | 'changed-away' // 내 수업인데 변경으로 다른 선생님이 맡음

/** 교사 화면용 공식 수업 — 엔진 LessonView + 역할. teacherUids는 넣지 않음(다른 교사 uid 비공개) */
export interface TeacherLesson extends LessonView {
  courseId: string
  role: TeacherLessonRole
  /** 공통 수업의 학급(예: '3학년 4반') — 없으면 null */
  classLabel: string | null
  /** 내가 담당·관리하는 수업이라 수업 상세(/teacher/courses/{id})를 열 수 있음 */
  manageable: boolean
}

/** 내 차시 안내(취소·옮겨 감·쉬는 날이라 열리지 않음) */
export interface TeacherNotice {
  key: string
  kind: NoticeView['kind']
  makeup?: boolean
  courseId: string
  title: string
  section?: string
  classLabel: string | null
  original: SlotState
  movedTo?: SlotState | null
  reason?: string
  manageable: boolean
}

export interface TeacherOfficialDay {
  /** 그 날짜 학기에 내가 맡은 운영 중 공식 수업(반복 차시)이 있음 → 공식 시간표가 기본 목록 */
  hasOfficial: boolean
  lessons: TeacherLesson[]
  notices: TeacherNotice[]
  /** 변경 묶음 일부를 받지 못해 적용하지 않은 변경이 있음 */
  incomplete: boolean
}

export type WeekdayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri'
export const WEEKDAY_KEYS: WeekdayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri']
/** 예전 교사 주간 시간표(users/{uid}.mySchedule) — 앱 전체가 7교시 고정 */
export const LEGACY_PERIOD_COUNT = 7
export type MySchedule = Record<WeekdayKey, string[]>

/** 예전 교환(품앗이)·보결(SOS) 중 수락·배정된 것 — 내가 요청했거나 맡은 것만 */
export interface TeacherCover {
  /** 'swap:<문서 id>' · 'sos:<문서 id>' */
  id: string
  kind: 'swap' | 'sos'
  /** covered = 내 교시를 다른 선생님이 대신, covering = 내가 다른 선생님 교시를 대신 */
  direction: 'covered' | 'covering'
  date: Ymd
  period: number
  /** 교환 칸 문구(예: '1-5 국어'). 보결은 빈 값 */
  subject: string
  /** 요청한 선생님의 담임 학급 표시('담임 없음'은 빈 값) */
  requesterClass: string
  /** covered: 대신 들어가는 선생님 이름, covering: 요청한 선생님 이름 */
  otherName: string
}

export interface TeacherTermSummary {
  termId: string
  name: string
  startDate: Ymd
  endDate: Ymd
  isDefault: boolean
}

/** GET /api/timetable/teacher 응답 */
export interface TeacherTimetablePayload {
  /** schools/{s}.scheduleRevision — 조회를 시작하기 전에 읽은 값 */
  revision: number
  generatedAt: number
  schoolCode: string
  /** 조회 기간(둘 다 포함) */
  from: Ymd
  to: Ymd
  /** 학교 학기 문서 + 문서 없는 날짜의 기본 학기(학생 /me와 같은 규칙) */
  terms: TeacherTermSummary[]
  offDays: Record<Ymd, { name: string } | null>
  calendarErrors: Ymd[]
  periodTimes: PeriodTime[]
  /** 날짜별 공식 수업(내 uid 기준, 엔진 계산) */
  days: Record<Ymd, TeacherOfficialDay>
  /** 직접 등록(또는 학교 엑셀에서 자동 등록)한 주간 시간표 — 없거나 비면 null */
  mySchedule: MySchedule | null
  covers: TeacherCover[]
}

// ───────────────────────── 공용 도우미 ─────────────────────────

const unique = <T,>(arr: T[]): T[] => Array.from(new Set(arr))

/** 다른 교사 uid를 빼고(이름만) 돌려줌 */
function publicSlot(s: SlotState): SlotState {
  const out: SlotState = { ...s }
  delete out.teacherUids
  return out
}

function publicChange(c: ChangeInfo | null): ChangeInfo | null {
  return c ? { ...c, before: c.before ? publicSlot(c.before) : null, after: publicSlot(c.after) } : null
}

/** 학급 id('S1_3_4') → '3학년 4반'. 수업 그룹(_g_)·형식 밖은 null */
export function homeroomIdLabel(id: string): string | null {
  if (/_g_/.test(id)) return null
  const m = /_(\d{1,2})_(\d{1,2})$/.exec(id)
  return m ? `${Number(m[1])}학년 ${Number(m[2])}반` : null
}

/** 공통 수업이면 학급 표시('3학년 4반', 여러 반이면 쉼표) */
export function courseClassLabel(course: Pick<Course, 'commonForHomerooms'>): string | null {
  const labels = unique((course.commonForHomerooms || []).map(homeroomIdLabel).filter((x): x is string => !!x))
  return labels.length ? labels.join(', ') : null
}

/** 수업 상세를 열 수 있는 계정(담당 교사 또는 관리 교사) */
export function managesCourse(course: Pick<Course, 'teacherUids' | 'managerUids'>, uid: string): boolean {
  return (course.teacherUids || []).includes(uid) || (course.managerUids || []).includes(uid)
}

/** 반복 차시의 기본 담당 교사 uid(차시 값 → 없으면 수업 값) */
export function seriesTeacherUids(s: Pick<LessonSeries, 'teacherUids'>, course: Pick<Course, 'teacherUids'>): string[] {
  return s.teacherUids && s.teacherUids.length ? s.teacherUids : course.teacherUids || []
}

/**
 * 그 날짜 학기에 내가 맡은 운영 중 공식 수업이 있는지:
 * 수업이 그 날 운영 중(종료 전)이고, 내가 기본 담당인 반복 차시(삭제 제외)의 적용 기간이 그 날짜의 학기와 겹침.
 * uid로만 판정 — 교사 이름이 같아도 계정이 연결되지 않은 수업은 세지 않음
 */
export function teacherHasOfficialOn(
  uid: string,
  date: Ymd,
  term: { startDate: Ymd; endDate: Ymd } | null,
  courses: Course[],
  series: LessonSeries[]
): boolean {
  if (!uid) return false
  const byId = new Map(courses.map((c) => [c.courseId, c]))
  const lo = term ? term.startDate : date
  const hi = term ? term.endDate : addDays(date, 1)
  return series.some((s) => {
    const c = byId.get(s.courseId)
    if (!c || !courseActiveOn(c, date)) return false
    if (s.status === 'retired' && !s.validTo) return false
    if (s.validTo && s.validTo <= s.validFrom) return false // 학기로 잘려 빈 기간
    if (!seriesTeacherUids(s, c).includes(uid)) return false
    return s.validFrom < hi && (!s.validTo || s.validTo > lo)
  })
}

// ───────────────────────── 1. 공식 수업(서버) ─────────────────────────

export interface TeacherOfficialInput {
  uid: string
  date: Ymd
  /** 그 날짜가 든 학기(없으면 null) */
  term: { startDate: Ymd; endDate: Ymd } | null
  offDay: { name: string } | null
  periodTimes?: PeriodTime[]
  /** 후보 수업: 내가 담당인 수업 + 내가 담당인 차시가 있는 수업 + 조회 기간 변경으로 나에게 넘어온 수업 */
  courses: Course[]
  series: LessonSeries[]
  /** 후보 수업의 발행된 변경(조회 기간에 걸친 차시 — selectOverridesForWindow) */
  overrides: Override[]
}

/** 차시의 '기본' 담당 교사 uid: 반복 차시면 그 차시 기본 상태, 보강이면 처음 발행된 보강 상태 */
function baseTeacherUidsOf(l: LessonView, course: Course, seriesById: Map<string, LessonSeries>): string[] {
  const parsed = l.occurrenceId ? parseOccurrenceKey(l.occurrenceId) : null
  if (parsed) {
    const s = seriesById.get(parsed.seriesId)
    if (s && s.courseId === course.courseId) return baseStateOf(s, parsed.originalDate, course).teacherUids ?? []
  }
  // 보강: 엔진의 change.before가 처음 보강 상태(처음 그대로면 before 없음 → 지금 상태)
  return l.change?.before?.teacherUids ?? l.teacherUids ?? []
}

export function computeTeacherOfficialDay(input: TeacherOfficialInput): TeacherOfficialDay {
  const { uid, date } = input
  const courseById = new Map(input.courses.map((c) => [c.courseId, c]))
  const seriesById = new Map(input.series.map((s) => [s.seriesId, s]))
  // 후보 수업을 모두 '수강'처럼 넣어 학생 화면과 같은 엔진으로 하루 시간표(변경·쉬는 날 반영)를 계산
  const enrollments: Enrollment[] = input.courses.map((c) => ({ courseId: c.courseId, uid, status: 'active', source: 'admin', from: null, to: null }))
  const day = buildDayTimetable({
    uid,
    day: { date, term: input.term, offDay: input.offDay, periodTimes: input.periodTimes },
    homerooms: [],
    enrollments,
    courses: input.courses,
    series: input.series,
    overrides: input.overrides,
    personalEntries: [],
  })

  const lessons: TeacherLesson[] = []
  for (const l of day.lessons) {
    if (!l.courseId) continue
    const course = courseById.get(l.courseId)
    if (!course) continue
    const nowMine = (l.teacherUids ?? []).includes(uid)
    const wasMine = baseTeacherUidsOf(l, course, seriesById).includes(uid)
    let role: TeacherLessonRole
    if (nowMine && wasMine) role = l.change?.kind === 'makeup' ? 'makeup' : 'mine'
    else if (nowMine) role = 'substitute'
    else if (wasMine) role = 'changed-away'
    else continue // 내 차시가 아님(같은 수업의 다른 교사 차시, 이름만 같은 수업 등)
    const view: LessonView = { ...l }
    delete view.teacherUids
    lessons.push({
      ...view,
      courseId: l.courseId,
      change: publicChange(l.change),
      role,
      classLabel: courseClassLabel(course),
      manageable: managesCourse(course, uid),
    })
  }

  const notices: TeacherNotice[] = []
  for (const n of day.notices) {
    if (!(n.original.teacherUids ?? []).includes(uid)) continue // 원래 내 차시였던 것만
    const course = courseById.get(n.courseId)
    notices.push({
      key: n.key,
      kind: n.kind,
      ...(n.makeup ? { makeup: true } : {}),
      courseId: n.courseId,
      title: n.title,
      ...(course?.section ? { section: course.section } : {}),
      classLabel: course ? courseClassLabel(course) : null,
      original: publicSlot(n.original),
      movedTo: n.movedTo ? publicSlot(n.movedTo) : null,
      ...(n.reason ? { reason: n.reason } : {}),
      manageable: course ? managesCourse(course, uid) : false,
    })
  }

  return {
    hasOfficial: teacherHasOfficialOn(uid, date, input.term, input.courses, input.series),
    lessons,
    notices,
    incomplete: day.incompleteChangeSets.length > 0,
  }
}

// ───────────────────────── 예전 주간 시간표 ─────────────────────────

/** users.mySchedule → {mon..fri: string[7]}(앞뒤 공백 정리). 모양이 아니거나 모든 칸이 비면 null */
export function normalizeMySchedule(raw: unknown): MySchedule | null {
  if (!raw || typeof raw !== 'object') return null
  const src = raw as Record<string, unknown>
  const out = {} as MySchedule
  let any = false
  for (const k of WEEKDAY_KEYS) {
    const arr = Array.isArray(src[k]) ? (src[k] as unknown[]) : []
    out[k] = Array.from({ length: LEGACY_PERIOD_COUNT }, (_, i) => {
      const v = arr[i]
      const t = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 60) : ''
      if (t) any = true
      return t
    })
  }
  return any ? out : null
}

/** 월~금 → 'mon'…'fri', 주말 → null */
export function weekdayKeyOf(date: Ymd): WeekdayKey | null {
  const w = weekdayOf(date)
  return w >= 1 && w <= 5 ? WEEKDAY_KEYS[w - 1] : null
}

/** 주간 시간표 칸 '1-5 국어' → { title: '국어', classLabel: '1학년 5반' }. 학반 라벨이 없으면 칸 문구 그대로 */
export function parseScheduleCell(text: string): { title: string; classLabel: string | null } {
  const t = String(text || '').trim()
  const m = /^(\d{1,2})-(\d{1,2})(?:\s+(.+))?$/.exec(t)
  if (m) {
    const classLabel = `${Number(m[1])}학년 ${Number(m[2])}반`
    return { title: (m[3] || '').trim() || `${classLabel} 수업`, classLabel }
  }
  return { title: t, classLabel: null }
}

/** 그 날짜 요일의 주간 시간표 칸(빈 칸 제외, 교시 순). 주말·자료 없음 → [] */
export function legacyCellsOn(schedule: MySchedule | null, date: Ymd): Array<{ period: number; text: string }> {
  const k = weekdayKeyOf(date)
  if (!schedule || !k) return []
  return (schedule[k] || []).map((text, i) => ({ period: i + 1, text })).filter((c) => !!c.text)
}

// ───────────────────────── 교환·보결 문구 ─────────────────────────

export function coverKindLabel(kind: TeacherCover['kind']): string {
  return kind === 'swap' ? '품앗이' : '보결'
}

/** '○○ 선생님이 대신 들어가요 (품앗이)' */
export function coveredByText(c: Pick<TeacherCover, 'otherName' | 'kind'>): string {
  return `${c.otherName || '다른'} 선생님이 대신 들어가요 (${coverKindLabel(c.kind)})`
}

/** '대신 들어가는 수업 · 3학년 2반 국어 (김선생 선생님)' — 교환 칸에 학반 라벨('1-5 국어')이 있으면 담임 학급은 덧붙이지 않음 */
export function coveringTitle(c: Pick<TeacherCover, 'subject' | 'requesterClass' | 'otherName'>): string {
  const subject = (c.subject || '').trim()
  const hasLabel = /^\d{1,2}-\d{1,2}(\s|$)/.test(subject)
  const what = [hasLabel ? '' : (c.requesterClass || '').trim(), subject].filter(Boolean).join(' ')
  const who = `(${c.otherName || '요청한'} 선생님)`
  return what ? `대신 들어가는 수업 · ${what} ${who}` : `대신 들어가는 수업 ${who}`
}

// ───────────────────────── 2. 날짜별 화면(클라이언트) ─────────────────────────

export type TeacherDayMode = 'official' | 'legacy' | 'empty'

export type TeacherDayState =
  | 'lessons' // 보일 행이 있음
  | 'holiday' // 쉬는 날(휴업일·공휴일·방학)
  | 'outside-term' // 등록된 학기 밖
  | 'no-lessons' // 시간표가 있고 이 날 수업 없음(주말 포함)
  | 'not-registered' // 공식 수업도 직접 등록 시간표도 없음 → 빈 상태(수업 관리·내 시간표 등록)

export type TeacherRowKind =
  | 'official' // 공식 수업(내 수업·보강·대신 들어감·다른 선생님이 맡음)
  | 'cancelled' // 취소된 내 공식 차시(취소선)
  | 'legacy' // 직접 등록 주간 시간표 칸
  | 'covering' // 내가 대신 들어가는 교환·보결
  | 'covered-only' // 다른 선생님이 대신 들어가는 내 교시(목록에 그 교시 수업이 없을 때)

export interface TeacherRow {
  key: string
  kind: TeacherRowKind
  /** 수업 카드(LessonCard) 입력 */
  lesson: LessonView
  role: TeacherLessonRole | null
  courseId: string | null
  manageable: boolean
  classLabel: string | null
  /** 이 교시를 다른 선생님이 대신 들어가는 교환·보결 */
  coveredBy: TeacherCover[]
  /** covering·covered-only 행의 원본 */
  cover: TeacherCover | null
}

export interface TeacherDayView {
  date: Ymd
  mode: TeacherDayMode
  state: TeacherDayState
  rows: TeacherRow[]
  /** 다른 날로 옮겨 간 내 수업(빨간 안내 줄) */
  movedOut: TeacherNotice[]
  /** 쉬는 날이라 열리지 않는 내 수업(회색 안내 줄) */
  suppressed: TeacherNotice[]
  offDayName: string | null
  /** 학사일정(쉬는 날 여부) 확인 실패 */
  calendarFailed: boolean
  outsideTerm: boolean
  /** 공식 방식일 때 접어 두는 '내 주간 시간표(직접 등록·참고)' — 그 요일 칸 */
  legacyReference: Array<{ period: number; text: string }>
  incomplete: boolean
}

const ROW_ORDER: Record<TeacherRowKind, number> = { official: 0, cancelled: 1, 'covered-only': 2, legacy: 3, covering: 4 }

function sortKey(l: LessonView, periodTimes: PeriodTime[]): number {
  const m = slotMinutes(l, periodTimes)
  if (m.start !== null) return m.start
  if (l.period != null) return 8 * 60 + l.period * 60
  return 24 * 60 + 1
}

function noticeLesson(n: TeacherNotice): LessonView {
  return {
    key: n.key,
    occurrenceId: n.key,
    courseId: n.courseId,
    title: n.makeup ? `${n.title} 보강` : n.title,
    ...(n.section ? { section: n.section } : {}),
    period: n.original.period,
    start: n.original.start ?? null,
    end: n.original.end ?? null,
    roomName: n.original.roomName ?? null,
    teacherNames: n.original.teacherNames ?? [],
    source: 'enrolled',
    synced: true,
    change: null,
  }
}

function plainLesson(key: string, title: string, period: number, source: LessonView['source']): LessonView {
  return { key, occurrenceId: null, courseId: null, title, period, start: null, end: null, roomName: null, teacherNames: [], source, synced: false, change: null }
}

/** 받은 학기 목록에서 그 날짜가 든 학기. 학기 목록이 비면 판단하지 않음(학생 화면 termRangeFor와 같은 기준) */
export function isOutsideTerms(terms: Array<{ startDate: Ymd; endDate: Ymd }>, date: Ymd): boolean {
  return terms.length > 0 && !terms.some((t) => inRange(date, t.startDate, t.endDate))
}

export function buildTeacherDay(p: TeacherTimetablePayload, date: Ymd): TeacherDayView {
  const official = p.days[date] || null
  const off = p.offDays[date] ?? null
  const outsideTerm = isOutsideTerms(p.terms, date)
  const schedule = p.mySchedule
  const mode: TeacherDayMode = official?.hasOfficial ? 'official' : schedule ? 'legacy' : 'empty'
  const cells = legacyCellsOn(schedule, date)

  const rows: TeacherRow[] = []

  // 1. 공식 수업 — 모든 방식(기본 시간표가 없는 선생님도 변경으로 맡은 수업·보강은 보임)
  for (const l of official?.lessons ?? []) {
    rows.push({ coveredBy: [], cover: null, key: `o:${l.key}`, kind: 'official', lesson: l, role: l.role, courseId: l.courseId, manageable: l.manageable, classLabel: l.classLabel })
  }
  // 2. 취소된 내 차시(취소선)
  for (const n of official?.notices ?? []) {
    if (n.kind !== 'cancelled') continue
    rows.push({ coveredBy: [], cover: null, key: `x:${n.key}`, kind: 'cancelled', lesson: noticeLesson(n), role: null, courseId: n.courseId, manageable: n.manageable, classLabel: n.classLabel })
  }
  // 3. 직접 등록 주간 시간표(공식 수업이 없는 선생님만 기본 목록). 쉬는 날·학기 밖에는 보이지 않음
  if (mode === 'legacy' && !off && !outsideTerm) {
    for (const c of cells) {
      const cell = parseScheduleCell(c.text)
      rows.push({ coveredBy: [], cover: null, key: `w:${c.period}`, kind: 'legacy', lesson: plainLesson(`w:${date}:${c.period}`, cell.title, c.period, 'personal'), role: null, courseId: null, manageable: false, classLabel: cell.classLabel })
    }
  }
  // 4. 교환·보결 겹치기
  const covers = p.covers.filter((c) => c.date === date)
  for (const c of covers) {
    if (c.direction !== 'covering') continue
    rows.push({ coveredBy: [], cover: c, key: `c:${c.id}`, kind: 'covering', lesson: plainLesson(`c:${c.id}`, coveringTitle(c), c.period, 'enrolled'), role: null, courseId: null, manageable: false, classLabel: null })
  }
  for (const c of covers) {
    if (c.direction !== 'covered') continue
    const targets = rows.filter(
      (r) => r.lesson.period === c.period && (r.kind === 'legacy' || (r.kind === 'official' && r.role !== 'changed-away'))
    )
    if (targets.length) {
      targets.forEach((r) => r.coveredBy.push(c))
      continue
    }
    const cell = c.subject ? parseScheduleCell(c.subject) : { title: '내 수업', classLabel: null }
    rows.push({ coveredBy: [c], cover: c, key: `v:${c.id}`, kind: 'covered-only', lesson: plainLesson(`v:${c.id}`, cell.title || '내 수업', c.period, 'enrolled'), role: null, courseId: null, manageable: false, classLabel: cell.classLabel })
  }

  rows.sort((a, b) => {
    const x = sortKey(a.lesson, p.periodTimes)
    const y = sortKey(b.lesson, p.periodTimes)
    if (x !== y) return x - y
    const pa = a.lesson.period ?? 999
    const pb = b.lesson.period ?? 999
    if (pa !== pb) return pa - pb
    if (ROW_ORDER[a.kind] !== ROW_ORDER[b.kind]) return ROW_ORDER[a.kind] - ROW_ORDER[b.kind]
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })

  let state: TeacherDayState
  if (rows.length) state = 'lessons'
  else if (off) state = 'holiday'
  else if (outsideTerm) state = 'outside-term'
  else if (mode === 'empty') state = 'not-registered'
  else state = 'no-lessons'

  const notices = official?.notices ?? []
  return {
    date,
    mode,
    state,
    rows,
    movedOut: notices.filter((n) => n.kind === 'moved-out'),
    suppressed: notices.filter((n) => n.kind === 'holiday-suppressed'),
    offDayName: off ? off.name : null,
    calendarFailed: p.calendarErrors.includes(date),
    outsideTerm,
    legacyReference: mode === 'official' ? cells : [],
    incomplete: !!official?.incomplete,
  }
}

/** 행에 붙일 배지(빨강: 변경·대신 들어감, 회색: 직접 등록). 엔진 변경 배지(시간 변경 등)는 LessonCard가 따로 붙임 */
export function rowBadges(row: TeacherRow): Array<{ label: string; tone: 'red' | 'gray' | 'sky' }> {
  const out: Array<{ label: string; tone: 'red' | 'gray' | 'sky' }> = []
  if (row.kind === 'cancelled') out.push({ label: '취소', tone: 'red' })
  if (row.role === 'substitute') out.push({ label: '대신 들어가는 수업', tone: 'red' })
  if (row.role === 'changed-away') out.push({ label: '다른 선생님이 맡아요', tone: 'red' })
  if (row.kind === 'covering' && row.cover) out.push({ label: coverKindLabel(row.cover.kind), tone: 'red' })
  for (const c of row.coveredBy) out.push({ label: coveredByText(c), tone: 'red' })
  return out
}

// ───────────────────────── 응답 정리(클라이언트) ─────────────────────────

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

function normalizeOfficialDay(v: unknown): TeacherOfficialDay {
  const d = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return {
    hasOfficial: d.hasOfficial === true,
    lessons: arr<TeacherLesson>(d.lessons)
      .filter((l) => l && typeof l === 'object' && typeof l.key === 'string' && typeof l.courseId === 'string')
      .map((l) => ({ ...l, teacherNames: strArr(l.teacherNames), classLabel: l.classLabel ?? null, manageable: l.manageable === true, change: l.change ?? null })),
    notices: arr<TeacherNotice>(d.notices).filter((n) => n && typeof n === 'object' && typeof n.key === 'string' && !!n.original),
    incomplete: d.incomplete === true,
  }
}

function normalizeCover(v: unknown): TeacherCover | null {
  const c = v as Partial<TeacherCover> | null
  if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !isYmd(c.date)) return null
  if (c.kind !== 'swap' && c.kind !== 'sos') return null
  if (c.direction !== 'covered' && c.direction !== 'covering') return null
  const period = Number(c.period)
  if (!Number.isInteger(period) || period < 0 || period > 10) return null
  return {
    id: c.id,
    kind: c.kind,
    direction: c.direction,
    date: c.date,
    period,
    subject: String(c.subject || ''),
    requesterClass: String(c.requesterClass || ''),
    otherName: String(c.otherName || ''),
  }
}

/** 응답(JSON) 모양 확인 + 빠진 값 보정. 기간이 없으면 쓸 수 없는 응답으로 봄 */
export function normalizeTeacherPayload(body: unknown): TeacherTimetablePayload | null {
  const b = body as Record<string, unknown> | null
  if (!b || typeof b !== 'object' || !isYmd(b.from) || !isYmd(b.to)) return null
  const terms = arr<Partial<TeacherTermSummary>>(b.terms)
    .filter((t) => t && isYmd(t.startDate) && isYmd(t.endDate))
    .map((t) => ({ termId: String(t.termId || ''), name: String(t.name || t.termId || ''), startDate: t.startDate as Ymd, endDate: t.endDate as Ymd, isDefault: t.isDefault === true }))
  const offRaw = b.offDays && typeof b.offDays === 'object' ? (b.offDays as Record<string, unknown>) : {}
  const offDays: Record<Ymd, { name: string } | null> = {}
  Object.keys(offRaw).forEach((k) => {
    const v = offRaw[k] as { name?: unknown } | null
    offDays[k] = v && typeof v === 'object' ? { name: String(v.name || '쉬는 날') } : null
  })
  const daysRaw = b.days && typeof b.days === 'object' ? (b.days as Record<string, unknown>) : {}
  const days: Record<Ymd, TeacherOfficialDay> = {}
  Object.keys(daysRaw).forEach((k) => {
    if (isYmd(k)) days[k] = normalizeOfficialDay(daysRaw[k])
  })
  const revision = Number(b.revision)
  return {
    revision: Number.isFinite(revision) ? revision : 0,
    generatedAt: Number(b.generatedAt) || 0,
    schoolCode: typeof b.schoolCode === 'string' ? b.schoolCode : '',
    from: b.from,
    to: b.to,
    terms,
    offDays,
    calendarErrors: strArr(b.calendarErrors),
    periodTimes: arr<PeriodTime>(b.periodTimes),
    days,
    mySchedule: normalizeMySchedule(b.mySchedule),
    covers: arr<unknown>(b.covers)
      .map(normalizeCover)
      .filter((c): c is TeacherCover => !!c),
  }
}
