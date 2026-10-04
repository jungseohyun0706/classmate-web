/**
 * 교사 '내 시간표' 주간 보기(/teacher/timetable?view=week) — 순수 함수
 * 브라우저·Firebase 없이 단위 테스트합니다(tests/unit/teacher-week-*.test.ts).
 *
 * - 자료는 홈 카드와 같은 GET /api/timetable/teacher 응답(TeacherTimetablePayload)을 그 주 월~일 7일로 받음(WEEK_WINDOW_POLICY)
 * - 날짜마다 홈 카드와 같은 buildTeacherDay로 그 날 무엇을 보일지 정함 — 공식 수업이 있는 날은 공식, 없으면 직접 등록 주간 시간표,
 *   둘 다 없으면 빈 상태. 한 주 안에서 날짜마다 방식이 달라도(학기 중 다음 주부터 공식 수업) 그 날 규칙 그대로(혼합 주)
 * - buildTeacherWeek: 요일 열 × 교시 행 칸으로 펼침
 *   · 월~금은 늘, 토·일은 그 날 수업·교환·보결·안내가 있을 때만 열
 *   · 교시 행: 1 ~ (있는 교시 중 가장 큰 것), 최소 6 — 직접 등록 주간 시간표 열이 있으면 최소 7(예전 시간표가 7교시 고정)
 *   · 교시가 없거나(명시 시각만) 1보다 작은 교시는 '교시 밖' 줄로 — 조용히 빠뜨리지 않음
 *   · 한 칸에 여러 수업이면 모두(하루 목록 순서 그대로) + 그 칸에서 다른 날로 옮겨 간 내 수업('옮김 · → 목 5교시'),
 *     쉬는 날이라 열리지 않는 수업(회색)
 *   · 학교 전체 쉬는 날·학기 밖이고 보일 것이 없는 날은 열 전체가 상태(쉬는 날 이름 / 학기 밖)
 *   · 일부 학년만 쉬는 날은 열 머리 짧은 표시('3학년 쉼') + 표 아래 안내 줄 + 그 학년 수업은 회색 '쉬는 날'
 * - 주 계산·이동·한국어 라벨(이번 주·지난주·다음 주, '10월 5일 ~ 10월 9일')
 */
import { addDays, toUtcDate, weekdayOf } from './dates'
import type { TimetableWindow, WindowPolicy } from './clientWindow'
import { changeBadgeLabels, lessonTitle, shortDateKo } from './lessonText'
import {
  buildTeacherDay,
  coverKindLabel,
  coveredByText,
  gradesLabel,
  LEGACY_PERIOD_COUNT,
  parseScheduleCell,
  type TeacherDayMode,
  type TeacherDayView,
  type TeacherNotice,
  type TeacherRow,
  type TeacherTimetablePayload,
} from './teacherDay'
import type { Weekday, Ymd } from './types'

// ───────────────────────── 주 계산·라벨 ─────────────────────────

const WEEKDAY_KO = ['', '월', '화', '수', '목', '금', '토', '일']

/** 그 날짜가 든 주의 월요일(주는 월~일) */
export function weekStartOf(date: Ymd): Ymd {
  return addDays(date, 1 - weekdayOf(date))
}

/** 그 날짜가 든 주의 일요일 */
export function weekEndOf(date: Ymd): Ymd {
  return addDays(weekStartOf(date), 6)
}

/** 그 주 월~일 7일 */
export function weekDatesOf(date: Ymd): Ymd[] {
  const start = weekStartOf(date)
  return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(start, i))
}

/** 조회 기간 = 그 주 월~일(둘 다 포함, 7일 — 서버 최대 21일 안) */
export function weekWindowOf(date: Ymd): TimetableWindow {
  return { from: weekStartOf(date), to: weekEndOf(date) }
}

/** 주간 화면: 그 주 7일을 받고, 7일이 모두 있어야 그림(useTeacherTimetable의 policy) */
export const WEEK_WINDOW_POLICY: WindowPolicy = { fetch: weekWindowOf, need: weekWindowOf }

/** n주 앞뒤로(요일은 그대로 — 하루 보기로 바꿔도 같은 요일) */
export function shiftWeek(date: Ymd, n: number): Ymd {
  return addDays(date, 7 * n)
}

/** b가 든 주 - a가 든 주(주 수) */
export function weeksBetween(a: Ymd, b: Ymd): number {
  const ms = toUtcDate(weekStartOf(b)).getTime() - toUtcDate(weekStartOf(a)).getTime()
  return Math.round(ms / (7 * 86400000))
}

/** 이번 주 / 지난주 / 다음 주 / N주 전 / N주 뒤 */
export function relativeWeekLabel(date: Ymd, today: Ymd): string {
  const d = weeksBetween(today, date)
  if (d === 0) return '이번 주'
  if (d === -1) return '지난주'
  if (d === 1) return '다음 주'
  return d < 0 ? `${-d}주 전` : `${d}주 뒤`
}

/** '10월 6일' */
export function monthDayKo(date: Ymd): string {
  const d = toUtcDate(date)
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`
}

/** '10월 5일 ~ 10월 9일'. 해가 바뀌는 주는 '2026년 12월 28일 ~ 2027년 1월 1일' */
export function weekRangeLabel(from: Ymd, to: Ymd): string {
  if (from.slice(0, 4) !== to.slice(0, 4)) return `${from.slice(0, 4)}년 ${monthDayKo(from)} ~ ${to.slice(0, 4)}년 ${monthDayKo(to)}`
  return `${monthDayKo(from)} ~ ${monthDayKo(to)}`
}

/** '화' */
export function weekdayKo(date: Ymd): string {
  return WEEKDAY_KO[weekdayOf(date)]
}

/** '10/6' */
export function monthDaySlash(date: Ymd): string {
  const d = toUtcDate(date)
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
}

/** 좁은 칸용 학급 표시: '3학년 5반' → '3-5'(여러 반이면 '3-4, 3-5'). 형식 밖은 그대로 */
export function compactClassLabel(label: string | null | undefined): string | null {
  if (!label) return null
  return label.replace(/(\d{1,2})학년\s*(\d{1,2})반/g, '$1-$2')
}

/** 수업 상세(/teacher/courses/{id}) — 내가 담당·관리하는 공식 수업 행·취소 행만(대신 들어가는 남의 수업은 없음) */
export function teacherCourseHref(row: Pick<TeacherRow, 'courseId' | 'manageable' | 'kind'>): string | null {
  return row.courseId && row.manageable && (row.kind === 'official' || row.kind === 'cancelled') ? `/teacher/courses/${encodeURIComponent(row.courseId)}` : null
}

// ───────────────────────── 주간 모델 ─────────────────────────

export type TeacherWeekItemKind = TeacherRow['kind'] | 'moved-out' | 'suppressed'

export interface TeacherWeekBadge {
  label: string
  tone: 'red' | 'gray' | 'sky'
}

/** 주간 칸 하나에 보일 수업(또는 안내) 하나 */
export interface TeacherWeekItem {
  key: string
  date: Ymd
  /** 칸 교시(1 이상). null이면 '교시 밖' 줄 */
  period: number | null
  kind: TeacherWeekItemKind
  /** 화면 제목(과목·분반 — 교환·보결은 칸 과목) */
  title: string
  /** 학급('3학년 5반') — 칸에는 compactClassLabel로 */
  classLabel: string | null
  roomName: string | null
  /** 칸에 보일 짧은 배지(앞의 것이 중요) */
  badges: TeacherWeekBadge[]
  /** 칸 둘째 줄 짧은 안내('→ 목 5교시') */
  note: string | null
  /** 빨간 테두리(변경·취소·대신 들어감·다른 선생님이 맡음·교환·보결·옮겨 감) — 하루 보기 LessonCard와 같은 기준 */
  red: boolean
  /** 취소(취소선) */
  struck: boolean
  /** 직접 등록 주간 시간표 칸(회색 점선 — 수업 변경 미반영) */
  legacy: boolean
  /** 쉬는 날이라 열리지 않음(회색) */
  muted: boolean
  /** 접근성 이름·상세: '영어 B 3학년 5반 시청각실 (교실 변경)' */
  label: string
  /** 수업 상세 링크 */
  href: string | null
  /** 상세(LessonCard)용 원래 행 — 안내(옮겨 감·쉬는 날)는 null */
  row: TeacherRow | null
  notice: TeacherNotice | null
}

export interface TeacherWeekColumn {
  date: Ymd
  weekday: Weekday
  /** '화' */
  dayLabel: string
  /** '10/6' */
  dateLabel: string
  /** 그 날 하루 화면(buildTeacherDay) — 하루 보기·상세와 같은 자료 */
  view: TeacherDayView
  /** 그 날 방식(공식 / 직접 등록 주간 시간표 / 빈 상태) — 홈 카드와 같은 규칙 */
  source: TeacherDayMode
  /** 학교 전체 쉬는 날·학기 밖이고 보일 것이 없음 → 열 전체에 상태 하나 */
  closed: 'holiday' | 'outside-term' | null
  /** 학교 전체가 쉬지만 일정이 있어 열린 날의 쉬는 날 이름 */
  offDayName: string | null
  /** 일부 학년만 쉬는 날 안내('3학년 쉬는 날(3학년 재량휴업일)') — 표 아래 안내 줄 */
  gradeOffNote: string | null
  /** 열 머리용 짧은 표시('3학년 쉼') */
  gradeOffShort: string | null
  /** 혼합 주(공식 + 직접 등록)에서 이 열이 직접 등록 주간 시간표 방식 — 열 머리 '직접 등록' */
  legacyTag: boolean
}

/**
 * 주 방식: 열린 열(쉬는 날·학기 밖 아님)의 방식으로 정함(모두 닫혔으면 모든 열)
 * - official: 모두 공식(빈 날 섞임 포함 — 공식 수업이 다음 주부터인 날 등)
 * - legacy: 모두 직접 등록 주간 시간표 → '내가 등록한 주간 시간표예요 — 수업 변경은 반영되지 않아요'
 * - mixed: 공식 날과 직접 등록 날이 섞임 → 열마다 '직접 등록' 표시 + 안내
 * - empty: 공식 수업도 직접 등록 주간 시간표도 없음
 */
export type TeacherWeekMode = 'official' | 'legacy' | 'mixed' | 'empty'

export interface TeacherWeekModel {
  /** 그 주 월요일·일요일 */
  start: Ymd
  end: Ymd
  /** 보일 열(월~금 + 일정이 있는 토·일) */
  columns: TeacherWeekColumn[]
  /** 교시 행 1..N */
  periods: number[]
  /** weekCellKey(date, period) → 칸 수업(하루 목록 순서) */
  cells: Record<string, TeacherWeekItem[]>
  /** 교시 밖(명시 시각만 있는 수업 등) — 날짜별 */
  outside: Record<Ymd, TeacherWeekItem[]>
  hasOutside: boolean
  mode: TeacherWeekMode
  /** empty = 등록된 시간표도 보일 일정도 없음(수업 관리·내 시간표 등록 빈 상태), grid = 표 */
  state: 'grid' | 'empty'
  /** 보일 열의 칸·교시 밖 수업 수 */
  itemCount: number
  /** 변경 묶음 일부를 받지 못한 날이 있음 */
  incomplete: boolean
  /** 쉬는 날 여부를 확인하지 못한 날 */
  calendarFailed: Ymd[]
}

export function weekCellKey(date: Ymd, period: number): string {
  return `${date}|${period}`
}

/** 하루 보기 배지(rowBadges)·변경 배지와 같은 내용을 칸 폭에 맞게 줄인 것 + 접근성용 전체 문구 */
function rowBadgeSets(row: TeacherRow): { short: TeacherWeekBadge[]; full: string[] } {
  const short: TeacherWeekBadge[] = []
  const full: string[] = []
  const l = row.lesson
  if (row.kind === 'cancelled') {
    short.push({ label: '취소', tone: 'red' })
    full.push('취소')
  }
  if (row.role === 'substitute') {
    short.push({ label: '대신', tone: 'red' })
    full.push('대신 들어가는 수업')
  }
  if (row.role === 'changed-away') {
    const names = l.teacherNames.filter(Boolean)
    short.push({ label: names.length ? `→${names[0]}${names.length > 1 ? ' 외' : ''}` : '다른 선생님', tone: 'red' })
    full.push(names.length ? `${names.join(', ')} 선생님이 맡아요` : '다른 선생님이 맡아요')
  }
  // 엔진 변경 배지(보강·시간·날짜·교실·교사 변경) — 대신 들어감·넘김은 위 배지가 이미 말함
  if (l.change && row.role !== 'substitute' && row.role !== 'changed-away') {
    const labels = changeBadgeLabels(l.change)
    if (labels.includes('보강')) short.push({ label: '보강', tone: 'red' })
    if (labels.some((x) => x !== '보강')) short.push({ label: '변경', tone: 'red' })
    full.push(...labels)
  }
  if (row.kind === 'covering' && row.cover) {
    // 칸 과목이 없으면 제목이 '보결 수업'·'품앗이 수업'이라 종류 배지는 과목이 있을 때만
    short.push({ label: '대신', tone: 'red' })
    if (row.cover.subject.trim()) short.push({ label: coverKindLabel(row.cover.kind), tone: 'red' })
    full.push(coverKindLabel(row.cover.kind))
  }
  for (const c of row.coveredBy) {
    short.push({ label: `→${c.otherName || '다른 선생님'}`, tone: 'red' })
    full.push(coveredByText(c))
  }
  return { short, full }
}

function joinLabel(parts: Array<string | null | undefined>, extra: string[]): string {
  const base = parts.filter((x): x is string => !!x && !!x.trim()).join(' ')
  return extra.length ? `${base} (${extra.join(', ')})` : base
}

function itemFromRow(row: TeacherRow, date: Ymd): TeacherWeekItem {
  const l = row.lesson
  let title = lessonTitle(l)
  let classLabel = row.classLabel
  if (row.kind === 'covering' && row.cover) {
    // 하루 보기 제목('대신 들어가는 수업 · 2학년 1반 국어 (김선생 선생님)')은 칸에 길어서 칸 과목(없으면 '보결 수업')·학급만
    const c = row.cover
    const cell = c.subject.trim() ? parseScheduleCell(c.subject) : null
    title = cell?.title || `${coverKindLabel(c.kind)} 수업`
    classLabel = cell?.classLabel ?? (c.requesterClass.trim() || null)
  }
  const { short, full } = rowBadgeSets(row)
  const legacy = row.kind === 'legacy'
  const red = row.kind === 'cancelled' || !!l.change || short.some((b) => b.tone === 'red')
  const label =
    row.kind === 'covering'
      ? joinLabel([l.title], full) // 이미 '대신 들어가는 수업 · … (○○ 선생님)'
      : joinLabel([title, classLabel, l.roomName], legacy ? full.concat('직접 등록 · 수업 변경 미반영') : full)
  return {
    key: row.key,
    date,
    period: l.period,
    kind: row.kind,
    title,
    classLabel,
    roomName: l.roomName,
    badges: short,
    note: null,
    red,
    struck: row.kind === 'cancelled',
    legacy,
    muted: false,
    label,
    href: teacherCourseHref(row),
    row,
    notice: null,
  }
}

/** 다른 날(또는 다른 주)로 옮겨 간 내 수업 — 원래 칸에 '옮김 · → 목 5교시' */
function itemFromMovedOut(n: TeacherNotice, date: Ymd, weekStart: Ymd): TeacherWeekItem {
  const title = lessonTitle({ title: n.makeup ? `${n.title} 보강` : n.title, section: n.section })
  const to = n.movedTo ?? null
  const sameWeek = !!to && weekStartOf(to.date) === weekStart
  const note = to ? (to.date === date ? `→ ${to.period}교시` : sameWeek ? `→ ${weekdayKo(to.date)} ${to.period}교시` : `→ ${monthDaySlash(to.date)}(${weekdayKo(to.date)}) ${to.period}교시`) : null
  const where = to ? `${shortDateKo(to.date)} ${to.period}교시로 옮겨졌어요` : '옮겨졌어요'
  return {
    key: `m:${n.key}`,
    date,
    period: n.original.period,
    kind: 'moved-out',
    title,
    classLabel: n.classLabel,
    // 원래 교실은 칸에서 빼고(옮겨 간 곳 안내가 중요) 상세 시트에서
    roomName: null,
    badges: [{ label: '옮김', tone: 'red' }],
    note,
    red: true,
    struck: false,
    legacy: false,
    muted: false,
    label: joinLabel([title, n.classLabel], [where]),
    href: n.manageable && n.courseId ? `/teacher/courses/${encodeURIComponent(n.courseId)}` : null,
    row: null,
    notice: n,
  }
}

/** 쉬는 날(학교 전체·그 학년)이라 열리지 않는 내 공식 수업 */
function itemFromSuppressed(n: TeacherNotice, date: Ymd): TeacherWeekItem {
  const title = lessonTitle({ title: n.makeup ? `${n.title} 보강` : n.title, section: n.section })
  return {
    key: `s:${n.key}`,
    date,
    period: n.original.period,
    kind: 'suppressed',
    title,
    classLabel: n.classLabel,
    roomName: n.original.roomName ?? null,
    badges: [{ label: '쉬는 날', tone: 'gray' }],
    note: null,
    red: false,
    struck: false,
    legacy: false,
    muted: true,
    label: joinLabel([title, n.classLabel], ['쉬는 날이라 열리지 않아요']),
    href: n.manageable && n.courseId ? `/teacher/courses/${encodeURIComponent(n.courseId)}` : null,
    row: null,
    notice: n,
  }
}

/** 그 학년이 쉬는 날이라 열리지 않는 직접 등록 주간 시간표 칸 */
function itemFromSuppressedCell(c: { period: number; text: string }, date: Ymd): TeacherWeekItem {
  const cell = parseScheduleCell(c.text)
  return {
    key: `sw:${date}:${c.period}`,
    date,
    period: c.period,
    kind: 'suppressed',
    title: cell.title,
    classLabel: cell.classLabel,
    roomName: null,
    badges: [{ label: '쉬는 날', tone: 'gray' }],
    note: null,
    red: false,
    struck: false,
    legacy: true,
    muted: true,
    label: joinLabel([cell.title, cell.classLabel], ['쉬는 날이라 열리지 않아요', '직접 등록']),
    href: null,
    row: null,
    notice: null,
  }
}

/** 그 날 칸에 보일 것(행 → 옮겨 감 → 쉬는 날 순) */
function itemsOfDay(view: TeacherDayView, weekStart: Ymd): TeacherWeekItem[] {
  const out = view.rows.map((r) => itemFromRow(r, view.date))
  for (const n of view.movedOut) out.push(itemFromMovedOut(n, view.date, weekStart))
  for (const n of view.suppressed) out.push(itemFromSuppressed(n, view.date))
  for (const c of view.suppressedCells) out.push(itemFromSuppressedCell(c, view.date))
  return out
}

const isGridPeriod = (p: number | null): p is number => p != null && Number.isInteger(p) && p >= 1

/** 최소 교시 행: 직접 등록 주간 시간표 열이 있으면 7(예전 시간표 고정 칸 수), 아니면 6 */
export const MIN_WEEK_PERIODS = 6

/**
 * 주간 모델. payload는 그 주 월~일을 포함해야 함(WEEK_WINDOW_POLICY) — 없는 날짜는 공식 수업 없는 날로 계산됨
 */
export function buildTeacherWeek(p: TeacherTimetablePayload, anyDateInWeek: Ymd): TeacherWeekModel {
  const start = weekStartOf(anyDateInWeek)
  const end = addDays(start, 6)
  const columns: TeacherWeekColumn[] = []
  const byDate = new Map<Ymd, TeacherWeekItem[]>()

  for (const date of weekDatesOf(start)) {
    const view = buildTeacherDay(p, date)
    const items = itemsOfDay(view, start)
    const weekday = weekdayOf(date)
    // 토·일은 그 날 수업·교환·보결·안내가 있을 때만
    if (weekday >= 6 && items.length === 0) continue
    const closed = (view.state === 'holiday' || view.state === 'outside-term') && view.movedOut.length === 0 ? view.state : null
    columns.push({
      date,
      weekday,
      dayLabel: weekdayKo(date),
      dateLabel: monthDaySlash(date),
      view,
      source: view.mode,
      closed,
      offDayName: closed ? null : view.offDayName,
      gradeOffNote: view.gradeOff && view.state !== 'outside-term' ? `${gradesLabel(view.gradeOff.grades)} 쉬는 날(${view.gradeOff.name})` : null,
      gradeOffShort: view.gradeOff && view.state !== 'outside-term' ? `${gradesLabel(view.gradeOff.grades)} 쉼` : null,
      legacyTag: false,
    })
    // 열 전체가 상태인 날은 칸을 만들지 않음(쉬는 날이라 열리지 않는 수업도 상태 하나로)
    byDate.set(date, closed ? [] : items)
  }

  // 주 방식 — 열린 열 기준(모두 닫혔으면 모든 열)
  const open = columns.filter((c) => !c.closed)
  const basis = open.length ? open : columns
  const hasOfficial = basis.some((c) => c.source === 'official')
  const hasLegacy = basis.some((c) => c.source === 'legacy')
  const mode: TeacherWeekMode = hasOfficial && hasLegacy ? 'mixed' : hasOfficial ? 'official' : hasLegacy ? 'legacy' : 'empty'
  if (mode === 'mixed') for (const c of columns) c.legacyTag = !c.closed && c.source === 'legacy'

  // 칸·교시 밖
  const cells: Record<string, TeacherWeekItem[]> = {}
  const outside: Record<Ymd, TeacherWeekItem[]> = {}
  let maxPeriod = open.some((c) => c.source === 'legacy') ? LEGACY_PERIOD_COUNT : MIN_WEEK_PERIODS
  let itemCount = 0
  for (const c of columns) {
    for (const it of byDate.get(c.date) ?? []) {
      itemCount++
      if (isGridPeriod(it.period)) {
        const k = weekCellKey(c.date, it.period)
        ;(cells[k] ||= []).push(it)
        if (it.period > maxPeriod) maxPeriod = it.period
      } else {
        ;(outside[c.date] ||= []).push({ ...it, period: null })
      }
    }
  }
  const periods = Array.from({ length: maxPeriod }, (_, i) => i + 1)

  const state: TeacherWeekModel['state'] = mode === 'empty' && itemCount === 0 && columns.some((c) => c.view.state === 'not-registered') ? 'empty' : 'grid'

  return {
    start,
    end,
    columns,
    periods,
    cells,
    outside,
    hasOutside: Object.keys(outside).length > 0,
    mode,
    state,
    itemCount,
    incomplete: columns.some((c) => c.view.incomplete),
    calendarFailed: columns.filter((c) => c.view.calendarFailed).map((c) => c.date),
  }
}

/** 보이는 열의 첫날~끝날 라벨(월~금, 토·일 열이 있으면 그날까지) */
export function weekModelRangeLabel(m: Pick<TeacherWeekModel, 'columns' | 'start'>): string {
  const first = m.columns[0]?.date ?? m.start
  const last = m.columns[m.columns.length - 1]?.date ?? addDays(m.start, 4)
  return weekRangeLabel(first, last)
}

/** 칸 접근성 이름: '화 3교시 영어 B 3학년 5반 시청각실 (교실 변경)' — 여러 수업이면 쉼표로 */
export function weekCellLabel(col: Pick<TeacherWeekColumn, 'dayLabel'>, period: number | null, items: TeacherWeekItem[]): string {
  const where = period == null ? `${col.dayLabel} 교시 밖` : `${col.dayLabel} ${period}교시`
  return items.length ? `${where} ${items.map((i) => i.label).join(', ')}` : `${where} 수업 없음`
}
