/**
 * 개인 시간표 계산 엔진 (순수 함수 — 화면·Firebase와 분리, 단위 테스트 대상)
 *
 * 처리 순서 (선택 날짜 D)
 *  1. 수강 대상 결정: D에 유효한 수강(active, 끝낸 수강은 [from, to) 안) + D에 유효한 소속 학급의 '명시된 공통 수업'. courseId로 중복 제거.
 *     반복 차시가 D 전에 모두 끝난 수업은 보강·옮겨 온 차시만 보이고 '운영 중'으로 세지 않음
 *  2. 기본 차시 확장: 그 수업들의 반복 차시 중 D의 요일·적용 기간에 맞는 것.
 *  3. 변경 적용: (수업, 차시)마다 revision이 가장 큰 발행 변경 하나만 유효 — 배열 순서·재전송·순서 역전과 무관.
 *     - 취소 → 실제 수업에서 빼고 안내 행으로
 *     - 다른 날로 이동 → 원래 날에는 안내 행(옮겨 감), 새 날에만 수업으로 한 번
 *     - 다른 날에서 D로 이동해 온 차시도 포함(원래 차시 id 유지)
 *     - 복원 → 기본 상태로(강조 없음, 이력은 서버에 남음)
 *     - 보강 → 기본에 없던 차시 추가. 보강 차시를 다시 옮기거나 취소해도 같은 규칙
 *     - 묶음(교시 교환 등)의 일부가 빠진 입력이면 그 묶음은 적용하지 않고 보고(중간 상태 노출 방지)
 *  4. 쉬는 날: 날짜·교시를 명시적으로 바꾼 변경이 아니면 기본 차시를 표시하지 않음(보강·옮겨 온 차시는 표시)
 *  5. 개인 일정 합치기(공식 수업과 연결된 개인 일정은 공식 수업으로 대체하고 메모만 보존)
 *  6. 실제 시각 기준 정렬(전순서), 겹침 검출, 변경 전후 비교
 *  7. 상태: 수업 있음 / 쉬는 날 / 학기 밖 / 시간표 미등록 / 연결된 수업 없음 / 정상 무수업
 */
import { hmToMinutes, inRange, isYmd, weekdayOf } from './dates'
import type {
  ChangeField,
  ChangeInfo,
  ConflictView,
  Course,
  DayTimetable,
  LessonSeries,
  LessonSource,
  LessonView,
  NoticeView,
  Override,
  PeriodTime,
  SlotState,
  StudentTimetableInput,
  Ymd,
} from './types'

export function occurrenceKeyOf(seriesId: string, originalDate: Ymd): string {
  return `${seriesId}@${originalDate}`
}

export function parseOccurrenceKey(key: string): { seriesId: string; originalDate: Ymd } | null {
  if (key.startsWith('mk:')) return null
  const at = key.lastIndexOf('@')
  if (at <= 0) return null
  const originalDate = key.slice(at + 1)
  if (!/^\d{8}$/.test(originalDate)) return null
  return { seriesId: key.slice(0, at), originalDate }
}

const groupKey = (courseId: string, occurrenceKey: string) => `${courseId}|${occurrenceKey}`

// ───────────────────────── 1. 수강 대상 ─────────────────────────

/** 수업이 그 날짜에 운영 중인지 (종료된 수업은 종료일 전 날짜만) */
export function courseActiveOn(course: Course, date: Ymd): boolean {
  if (course.endedOn && date >= course.endedOn) return false
  if (course.status === 'ended' && !course.endedOn) return false
  return true
}

export interface ResolvedCourses {
  /** courseId → 출처 (개별 수강이 공통 수업보다 우선). 끝낸 수강도 [from, to) 날짜에는 들어 있음 */
  active: Map<string, Exclude<LessonSource, 'personal'>>
  pending: string[]
}

export function resolveCourses(
  input: Pick<StudentTimetableInput, 'uid' | 'homerooms' | 'enrollments' | 'courses'>,
  date: Ymd
): ResolvedCourses {
  const byId = new Map(input.courses.map((c) => [c.courseId, c]))
  const active = new Map<string, Exclude<LessonSource, 'personal'>>()
  const pending = new Set<string>()

  for (const e of input.enrollments) {
    if (e.uid !== input.uid) continue
    if (!inRange(date, e.from, e.to)) continue
    if (e.status === 'pending') {
      // 승인 대기는 수업 문서를 못 받아도 대기 상태로 알림
      pending.add(e.courseId)
      continue
    }
    // 끝낸 수강(ended + to)은 [from, to) 동안 들은 수업 — 지난 날짜에는 그대로 보임(enrollments end는 to=오늘).
    // 거절(rejected)·승인 대기에서 끝낸 수강(to 없음)은 들은 기간이 없어 보이지 않음
    const attended = e.status === 'active' || (e.status === 'ended' && !!e.to && !e.rejected)
    if (!attended) continue
    const course = byId.get(e.courseId)
    if (!course || !courseActiveOn(course, date)) continue
    active.set(e.courseId, 'enrolled')
  }

  const homeroomIds = input.homerooms.filter((h) => inRange(date, h.from, h.to)).map((h) => h.homeroomId)
  if (homeroomIds.length) {
    for (const course of input.courses) {
      if (active.has(course.courseId)) continue
      if (!courseActiveOn(course, date)) continue
      if (course.commonForHomerooms.some((id) => homeroomIds.includes(id))) {
        active.set(course.courseId, 'common')
      }
    }
  }
  for (const id of Array.from(active.keys())) pending.delete(id)
  return { active, pending: Array.from(pending).sort() }
}

// ───────────────────────── 2. 기본 차시 ─────────────────────────

/** 반복 차시의 적용 기간 안인지(요일 무관). 종료일 없이 retired면 삭제된 것으로 봄 */
export function seriesValidOn(s: LessonSeries, date: Ymd): boolean {
  if (s.status === 'retired' && !s.validTo) return false
  return inRange(date, s.validFrom, s.validTo)
}

/**
 * 수업의 반복 차시가 그 날짜 전에 모두 끝났는지(차시가 하나 이상 있고, 삭제된 것을 빼면 모두 validTo ≤ date).
 * 예: 같은 학기에 학급 시간표를 다시 만들어 옛 공통 수업의 차시만 닫힌 경우. 차시가 없거나 아직 시작 전인 수업은 해당 없음(시간표 미등록)
 */
export function seriesAllEndedBy(courseId: string, series: LessonSeries[], date: Ymd): boolean {
  const own = series.filter((s) => s.courseId === courseId && !(s.status === 'retired' && !s.validTo))
  return own.length > 0 && own.every((s) => !!s.validTo && s.validTo <= date)
}

/** 반복 차시가 그 날짜에 열리는지 (요일 + 적용 기간) */
export function seriesOccursOn(s: LessonSeries, date: Ymd): boolean {
  return s.weekday === weekdayOf(date) && seriesValidOn(s, date)
}

export function baseStateOf(s: LessonSeries, date: Ymd, course?: Course): SlotState {
  return {
    date,
    period: s.period,
    start: s.start ?? null,
    end: s.end ?? null,
    roomId: s.roomId ?? course?.defaultRoomId ?? null,
    roomName: s.roomName ?? course?.defaultRoomName ?? null,
    teacherNames: s.teacherNames && s.teacherNames.length ? s.teacherNames : course?.teacherNames ?? [],
    teacherUids: s.teacherUids && s.teacherUids.length ? s.teacherUids : course?.teacherUids ?? [],
  }
}

/** 같은 seriesId가 두 번 들어와도 결과가 입력 순서에 좌우되지 않게(첫 번째, seriesId 순) */
function uniqueSeries(series: LessonSeries[]): LessonSeries[] {
  const out = new Map<string, LessonSeries>()
  for (const s of [...series].sort((a, b) => (a.seriesId < b.seriesId ? -1 : a.seriesId > b.seriesId ? 1 : 0))) {
    if (!out.has(s.seriesId)) out.set(s.seriesId, s)
  }
  return Array.from(out.values())
}

// ───────────────────────── 3. 변경 ─────────────────────────

const later = (a: Override, b: Override) => a.revision > b.revision || (a.revision === b.revision && a.overrideId > b.overrideId)

/**
 * (수업, 차시)별 유효 변경: 발행된 것 중 revision 최대(동률이면 overrideId 사전순 마지막 — 결정적).
 * 키는 `${courseId}|${occurrenceKey}` — 다른 수업의 변경이 같은 차시 키를 가리켜도 섞이지 않음.
 */
export function effectiveOverrides(overrides: Override[]): Map<string, Override> {
  const out = new Map<string, Override>()
  for (const o of overrides) {
    if (o.status !== 'published') continue
    const k = groupKey(o.courseId, o.occurrenceKey)
    const cur = out.get(k)
    if (!cur || later(o, cur)) out.set(k, o)
  }
  return out
}

/** 보강 차시의 기준 상태 = 그 차시의 첫 번째(가장 작은 revision) 보강 발행 */
function makeupBases(overrides: Override[]): Map<string, Override> {
  const out = new Map<string, Override>()
  for (const o of overrides) {
    if (o.status !== 'published' || o.kind !== 'makeup' || !o.target) continue
    const k = groupKey(o.courseId, o.occurrenceKey)
    const cur = out.get(k)
    if (!cur || later(cur, o)) out.set(k, o)
  }
  return out
}

/**
 * 묶음 완전성: changeSetKeys가 있는 묶음 중, 이 입력에 있어야 할(학생이 보는 수업의) 변경이 빠진 묶음 id
 */
export function incompleteChangeSets(overrides: Override[], visibleCourseIds: Set<string>): Set<string> {
  const present = new Map<string, Set<string>>()
  const expected = new Map<string, string[]>()
  for (const o of overrides) {
    if (o.status !== 'published') continue
    if (!present.has(o.changeSetId)) present.set(o.changeSetId, new Set())
    present.get(o.changeSetId)!.add(groupKey(o.courseId, o.occurrenceKey))
    if (o.changeSetKeys && o.changeSetKeys.length && !expected.has(o.changeSetId)) expected.set(o.changeSetId, o.changeSetKeys)
  }
  const bad = new Set<string>()
  for (const [cs, keys] of Array.from(expected.entries())) {
    const have = present.get(cs) || new Set<string>()
    for (const k of keys) {
      const courseId = k.slice(0, k.indexOf('|'))
      if (visibleCourseIds.has(courseId) && !have.has(k)) {
        bad.add(cs)
        break
      }
    }
  }
  return bad
}

const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()

function sameSet(a: string[], b: string[], f: (x: string) => string = (x) => x): boolean {
  const x = Array.from(new Set(a.map(f))).sort()
  const y = Array.from(new Set(b.map(f))).sort()
  return x.length === y.length && x.every((v, i) => v === y[i])
}

/** 교실이 같은지: 둘 다 id가 있으면 id로, 아니면 이름(공백·대소문자 무시)으로 */
function sameRoom(a: SlotState, b: SlotState): boolean {
  if (a.roomId && b.roomId) return a.roomId === b.roomId
  const an = a.roomName ? norm(a.roomName) : ''
  const bn = b.roomName ? norm(b.roomName) : ''
  if (an || bn) return an === bn
  return !a.roomId && !b.roomId
}

/** 교사가 같은지: 둘 다 uid가 있으면 uid로, 아니면 이름으로 */
function sameTeacher(a: SlotState, b: SlotState): boolean {
  const au = a.teacherUids ?? []
  const bu = b.teacherUids ?? []
  if (au.length && bu.length) return sameSet(au, bu)
  return sameSet(a.teacherNames ?? [], b.teacherNames ?? [], norm)
}

/** 변경 전후 비교 — 달라진 항목만 */
export function diffSlots(before: SlotState, after: SlotState): ChangeField[] {
  const fields: ChangeField[] = []
  if (before.date !== after.date) fields.push('date')
  if (before.period !== after.period || (before.start ?? null) !== (after.start ?? null) || (before.end ?? null) !== (after.end ?? null)) {
    fields.push('time')
  }
  if (!sameRoom(before, after)) fields.push('room')
  if (!sameTeacher(before, after)) fields.push('teacher')
  return fields
}

/**
 * 변경 목표를 기준 상태 위에 적용.
 * - 시각: 목표에 start/end가 있으면 그것, 교시가 바뀌었는데 시각이 없으면 비움(교시표를 따름), 아니면 기준 유지
 * - 교실: roomId·roomName 중 하나라도 목표에 있으면 둘을 한 묶음으로 교체(이름만 바꾼 교실 변경도 반영)
 * - 교사: teacherUids·teacherNames 중 하나라도 목표에 있으면 둘을 한 묶음으로 교체(대체 교사를 이름만 지정해도 원래 교사 uid가 남지 않음)
 */
export function mergeTarget(base: SlotState | null, target: SlotState): SlotState {
  const has = (k: keyof SlotState) => Object.prototype.hasOwnProperty.call(target, k) && target[k] !== undefined
  const periodChanged = !base || base.period !== target.period
  const timesGiven = has('start') || has('end')
  const roomGiven = has('roomId') || has('roomName')
  const teacherGiven = has('teacherUids') || has('teacherNames')
  return {
    date: target.date,
    period: target.period,
    start: timesGiven ? target.start ?? null : periodChanged ? null : base?.start ?? null,
    end: timesGiven ? target.end ?? null : periodChanged ? null : base?.end ?? null,
    roomId: roomGiven ? target.roomId ?? null : base?.roomId ?? null,
    roomName: roomGiven ? target.roomName ?? null : base?.roomName ?? null,
    teacherNames: teacherGiven ? target.teacherNames ?? [] : base?.teacherNames ?? [],
    teacherUids: teacherGiven ? target.teacherUids ?? [] : base?.teacherUids ?? [],
  }
}

// ───────────────────────── 시각 ─────────────────────────

export function slotMinutes(slot: { period: number | null; start?: string | null; end?: string | null }, periodTimes?: PeriodTime[]): {
  start: number | null
  end: number | null
} {
  let start = hmToMinutes(slot.start ?? null)
  let end = hmToMinutes(slot.end ?? null)
  if ((start === null || end === null) && slot.period != null && periodTimes) {
    const pt = periodTimes.find((p) => p.period === slot.period)
    if (pt) {
      if (start === null) start = hmToMinutes(pt.start)
      if (end === null) end = hmToMinutes(pt.end)
    }
  }
  if (start !== null && end !== null && end <= start) end = null
  // 시작만 있으면 그 시각 한 점으로 봄(겹침을 '없음'으로 처리하지 않도록)
  if (start !== null && end === null) end = start + 1
  return { start, end }
}

function overlaps(
  a: { period: number | null; start?: string | null; end?: string | null },
  b: { period: number | null; start?: string | null; end?: string | null },
  periodTimes?: PeriodTime[]
): boolean {
  const x = slotMinutes(a, periodTimes)
  const y = slotMinutes(b, periodTimes)
  if (x.start !== null && x.end !== null && y.start !== null && y.end !== null) {
    return x.start < y.end && y.start < x.end
  }
  return a.period != null && a.period === b.period
}

/** 정렬용 분 값: 시각 → 교시표 → 교시 번호 추정(08:00 + 교시×60분). 하나의 수치 키라 전순서가 보장됨 */
function sortMinutes(l: { period: number | null; start?: string | null; end?: string | null }, periodTimes?: PeriodTime[]): number {
  const m = slotMinutes(l, periodTimes)
  if (m.start !== null) return m.start
  if (l.period != null) return 8 * 60 + l.period * 60
  return 24 * 60 + 1
}

// ───────────────────────── 4~7. 하루 시간표 ─────────────────────────

/** 쉬는 날에도 표시할 만큼 '명시적'인 변경인지: 날짜나 교시·시각을 바꾼 변경 */
function explicitlyScheduled(fields: ChangeField[]): boolean {
  return fields.includes('date') || fields.includes('time')
}

export function buildDayTimetable(input: StudentTimetableInput): DayTimetable {
  const D = input.day.date
  const periodTimes = input.day.periodTimes
  const isOff = !!input.day.offDay
  const courseById = new Map(input.courses.map((c) => [c.courseId, c]))
  const series = uniqueSeries(input.series)
  const seriesById = new Map(series.map((s) => [s.seriesId, s]))
  const { active, pending } = resolveCourses(input, D)

  // 학생이 보는 수업의 변경만, 일부가 빠진 묶음은 적용하지 않음
  const visibleCourseIds = new Set(input.courses.map((c) => c.courseId))
  const incomplete = incompleteChangeSets(input.overrides, visibleCourseIds)
  const usable = input.overrides.filter((o) => !incomplete.has(o.changeSetId))
  const eff = effectiveOverrides(usable)
  const mkBase = makeupBases(usable)

  const lessons: LessonView[] = []
  const notices: NoticeView[] = []
  const noticeKeys = new Set<string>()
  const orphanOverrides: Override[] = []
  const orphanIds = new Set<string>()
  const seen = new Set<string>()

  const addOrphan = (o: Override) => {
    if (!active.has(o.courseId) || orphanIds.has(o.overrideId)) return // 수강하지 않는 수업의 검토 항목은 노출하지 않음
    orphanIds.add(o.overrideId)
    orphanOverrides.push(o)
  }
  const addNotice = (n: NoticeView) => {
    const k = `${n.kind}|${n.key}`
    if (noticeKeys.has(k)) return
    noticeKeys.add(k)
    notices.push(n)
  }
  const pushLesson = (course: Course, source: Exclude<LessonSource, 'personal'>, occKey: string, state: SlotState, change: ChangeInfo | null) => {
    if (seen.has(occKey)) return
    seen.add(occKey)
    lessons.push({
      key: occKey,
      occurrenceId: occKey,
      courseId: course.courseId,
      title: course.title,
      subject: course.subject,
      section: course.section,
      period: state.period,
      start: state.start ?? null,
      end: state.end ?? null,
      roomName: state.roomName ?? null,
      teacherNames: state.teacherNames ?? [],
      teacherUids: state.teacherUids ?? [],
      source,
      synced: true,
      change,
    })
  }
  const changeOf = (kind: ChangeInfo['kind'], o: Override, before: SlotState | null, after: SlotState): ChangeInfo | null => {
    const fields = before ? diffSlots(before, after) : []
    if (kind === 'reschedule' && !fields.length) return null
    return { kind, fields, before, after, reason: o.reason, publishedAt: o.publishedAt ?? null, changeSetId: o.changeSetId, revision: o.revision }
  }

  // (a) D의 기본 차시
  for (const s of series) {
    const source = active.get(s.courseId)
    const course = courseById.get(s.courseId)
    if (!source || !course) continue
    if (!seriesOccursOn(s, D)) continue
    const key = occurrenceKeyOf(s.seriesId, D)
    const base = baseStateOf(s, D, course)
    const o = eff.get(groupKey(s.courseId, key))
    if (o && o.kind === 'cancel') {
      addNotice({ key, kind: 'cancelled', courseId: course.courseId, title: course.title, original: base, reason: o.reason })
      continue
    }
    if (o && o.kind === 'reschedule' && !o.target) {
      // 잘못된 변경(목표 없음): 기본 차시를 그대로 보이고 검토 대상으로
      addOrphan(o)
    }
    if (!o || o.kind === 'restore' || o.kind === 'makeup' || !o.target) {
      if (o && o.kind === 'makeup') addOrphan(o) // 반복 차시 키에 보강이 붙은 잘못된 데이터
      if (isOff) {
        addNotice({ key, kind: 'holiday-suppressed', courseId: course.courseId, title: course.title, original: base })
        continue
      }
      pushLesson(course, source, key, base, null)
      continue
    }
    const after = mergeTarget(base, o.target)
    if (after.date !== D) {
      addNotice({ key, kind: 'moved-out', courseId: course.courseId, title: course.title, original: base, movedTo: after, reason: o.reason })
      continue
    }
    const change = changeOf('reschedule', o, base, after)
    if (isOff && !(change && explicitlyScheduled(change.fields))) {
      addNotice({ key, kind: 'holiday-suppressed', courseId: course.courseId, title: course.title, original: base })
      continue
    }
    pushLesson(course, source, key, after, change)
  }

  // (b) 다른 날에서 D로 옮겨 온 차시, (c) 보강 차시, (d) 대상이 사라진 변경
  const effEntries = Array.from(eff.entries()).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
  for (const [gk, o] of effEntries) {
    const key = o.occurrenceKey
    if (seen.has(key)) continue
    const course = courseById.get(o.courseId)
    if (!course) continue

    if (key.startsWith('mk:')) {
      const mb = mkBase.get(gk)
      if (!mb || !mb.target) {
        if (o.target?.date === D || o.originalDate === D) addOrphan(o)
        continue
      }
      // 수강 확인을 안내보다 먼저: 승인 대기·끝낸 수강(D가 기간 밖) 학생에게 보강 취소·이동 안내를 보이지 않음(반복 차시 (a)와 같은 규칙)
      const source = active.get(o.courseId)
      if (!source) continue
      const base = mergeTarget(null, mb.target)
      const cur = o.kind === 'makeup' ? mergeTarget(null, o.target!) : o.kind === 'restore' ? base : o.kind === 'reschedule' && o.target ? mergeTarget(base, o.target) : null
      if (o.kind === 'cancel') {
        if (base.date === D) addNotice({ key, kind: 'cancelled', makeup: true, courseId: course.courseId, title: course.title, original: base, reason: o.reason })
        continue
      }
      if (!cur) continue
      if (base.date === D && cur.date !== D) {
        addNotice({ key, kind: 'moved-out', makeup: true, courseId: course.courseId, title: course.title, original: base, movedTo: cur, reason: o.reason })
        continue
      }
      if (cur.date !== D) continue
      const info = changeOf('makeup', o, o.kind === 'makeup' ? null : base, cur)
      pushLesson(course, source, key, cur, info)
      continue
    }

    const parsed = parseOccurrenceKey(key)
    const touchesD = parsed?.originalDate === D || o.target?.date === D
    if (!touchesD) continue
    const s = parsed ? seriesById.get(parsed.seriesId) : undefined
    const valid = !!(parsed && s && s.courseId === o.courseId && seriesOccursOn(s, parsed.originalDate))
    if (!valid) {
      // 기본 시간표가 바뀌어 대상 차시가 없어진 변경 — 조용히 버리지 않고 검토 대상으로
      if (o.kind !== 'restore') addOrphan(o)
      continue
    }
    if (parsed!.originalDate === D) continue // 원래 날짜가 D인 차시는 (a)에서 처리
    if (o.kind !== 'reschedule' || !o.target || o.target.date !== D) continue
    const source = active.get(o.courseId) // 실제 진행일(D) 기준 수강 자격
    if (!source) continue
    const before = baseStateOf(s!, parsed!.originalDate, course)
    const after = mergeTarget(before, o.target)
    pushLesson(course, source, key, after, changeOf('reschedule', o, before, after))
  }

  // 반복 차시가 D 전에 모두 끝난 수업: 보강·옮겨 온 차시는 위에서 그대로 보이고, 그 차시가 없는 날은 운영 중인 수업으로 세지 않음
  // ('일부 수업 시간표가 아직 없어요' 오탐·연결 개인 일정이 사라지는 문제 방지)
  const withLesson = new Set(lessons.map((l) => l.courseId))
  const operating = (cid: string) => active.has(cid) && (withLesson.has(cid) || !seriesAllEndedBy(cid, series, D))

  // 5. 개인 일정
  const weekday = weekdayOf(D)
  for (const p of [...input.personalEntries].sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0))) {
    const applies = p.kind === 'once' ? p.date === D : p.weekday === weekday
    if (!applies) continue
    if (p.linkedCourseId && operating(p.linkedCourseId)) {
      // 공식 수업으로 대체 — 메모는 같은 교시(없으면 그날 그 수업의 첫 차시)에만 붙임
      if (p.memo) {
        // 같은 교시 → 원래(변경 전) 교시가 같은 차시 → 그날 그 수업 차시가 하나뿐이면 그 차시
        const cands = lessons.filter((l) => l.courseId === p.linkedCourseId && !l.memo)
        const target =
          (p.period != null ? cands.find((l) => l.period === p.period) : undefined) ||
          (p.period != null ? cands.find((l) => l.change?.before?.period === p.period) : undefined) ||
          (cands.length === 1 ? cands[0] : undefined)
        if (target) {
          target.memo = p.memo
          if (p.pendingSync) target.pendingSync = true
        }
      }
      continue
    }
    lessons.push({
      key: `p:${p.entryId}`,
      occurrenceId: null,
      courseId: null,
      title: p.title,
      period: p.period ?? null,
      start: p.start ?? null,
      end: p.end ?? null,
      roomName: p.roomName ?? null,
      teacherNames: [],
      source: 'personal',
      synced: false,
      change: null,
      memo: p.memo ?? null,
      pendingSync: p.pendingSync,
    })
  }

  // 6. 정렬(하나의 수치 키 + 동률 깨기 → 전순서) + 겹침
  lessons.sort((a, b) => {
    const x = sortMinutes(a, periodTimes)
    const y = sortMinutes(b, periodTimes)
    if (x !== y) return x - y
    const pa = a.period ?? 999
    const pb = b.period ?? 999
    if (pa !== pb) return pa - pb
    const t = a.title.localeCompare(b.title, 'ko')
    if (t !== 0) return t
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })
  notices.sort((a, b) => a.original.date.localeCompare(b.original.date) || a.original.period - b.original.period || a.key.localeCompare(b.key))
  orphanOverrides.sort((a, b) => (a.overrideId < b.overrideId ? -1 : 1))

  const conflicts: ConflictView[] = []
  for (let i = 0; i < lessons.length; i++) {
    for (let j = i + 1; j < lessons.length; j++) {
      const a = lessons[i]
      const b = lessons[j]
      if (overlaps(a, b, periodTimes)) {
        conflicts.push({ keys: [a.key, b.key], kind: a.source !== 'personal' && b.source !== 'personal' ? 'official' : 'personal' })
      }
    }
  }

  // 7. 상태
  const activeCourseIds = Array.from(active.keys()).filter(operating).sort()
  // D에 운영 중인 수업만 판정(끝난 수업·차시가 모두 끝난 수업은 위에서 빠짐). 보강만 있는 날의 차시 끝난 수업도 미등록으로 보지 않음
  const coursesWithoutSchedule = activeCourseIds.filter((cid) => !seriesAllEndedBy(cid, series, D) && !series.some((s) => s.courseId === cid && seriesValidOn(s, D)))
  const term = input.day.term
  const outsideTerm = !!(term && !inRange(D, term.startDate, term.endDate))
  const hasAnyPersonal = input.personalEntries.length > 0
  let state: DayTimetable['state']
  if (lessons.length) state = 'lessons'
  else if (isOff) state = 'holiday'
  else if (outsideTerm) state = 'outside-term'
  else if (!activeCourseIds.length && !hasAnyPersonal) state = 'no-courses'
  else if (activeCourseIds.length && coursesWithoutSchedule.length === activeCourseIds.length) state = 'not-registered'
  else state = 'no-lessons'

  return {
    date: D,
    state,
    lessons,
    notices,
    conflicts,
    orphanOverrides,
    pendingCourseIds: pending,
    activeCourseIds,
    coursesWithoutSchedule,
    incompleteChangeSets: Array.from(incomplete).sort(),
    offDayName: input.day.offDay?.name ?? null,
  }
}

// ───────────────────────── 서버용: 자원 충돌 검사 ─────────────────────────

export interface ScheduledOccurrence {
  key: string
  courseId: string
  date: Ymd
  period: number
  start?: string | null
  end?: string | null
  roomId?: string | null
  roomName?: string | null
  teacherUids?: string[]
  teacherNames?: string[]
}

export interface ResourceConflict {
  kind: 'teacher' | 'room' | 'students'
  a: string
  b: string
  /** 교사 uid/이름, 교실, 또는 겹치는 학생 수 */
  detail: string
  /** 이름으로만 같다고 본 경우(계정·교실 id가 한쪽에 없음) — 관리자 확인 필요 */
  possible?: boolean
}

function sharedTeacher(a: ScheduledOccurrence, b: ScheduledOccurrence): { detail: string; possible: boolean } | null {
  const au = a.teacherUids ?? []
  const bu = b.teacherUids ?? []
  const u = au.find((x) => bu.includes(x))
  if (u) return { detail: 'uid:' + u, possible: false }
  if (au.length && bu.length) return null // 둘 다 인증된 계정이 있고 겹치지 않음
  const an = (a.teacherNames ?? []).map(norm)
  const bn = new Set((b.teacherNames ?? []).map(norm))
  const n = an.find((x) => x && bn.has(x))
  return n ? { detail: 'name:' + n, possible: true } : null
}

function sharedRoom(a: ScheduledOccurrence, b: ScheduledOccurrence): { detail: string; possible: boolean } | null {
  if (a.roomId && b.roomId) return a.roomId === b.roomId ? { detail: a.roomId, possible: false } : null
  const an = a.roomName ? norm(a.roomName) : ''
  const bn = b.roomName ? norm(b.roomName) : ''
  return an && an === bn ? { detail: 'name:' + an, possible: !(a.roomId && b.roomId) } : null
}

/**
 * 같은 교사·같은 교실·같은 학생이 실제 시간 기준으로 겹치는지.
 * 교사는 인증된 uid로 비교하고, 한쪽에 uid가 없을 때만 이름으로 비교해 '가능 충돌'로 표시합니다(계정 연결 아님).
 * studentOverlap(courseA, courseB)은 두 수업을 함께 듣는 학생 수(서버에서 수강 정보로 계산).
 */
export function detectResourceConflicts(
  occs: ScheduledOccurrence[],
  opts: { periodTimes?: PeriodTime[]; studentOverlap?: (a: string, b: string) => number; sharedRooms?: Set<string> } = {}
): ResourceConflict[] {
  const out: ResourceConflict[] = []
  const sorted = [...occs].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]
      const b = sorted[j]
      if (a.date !== b.date || a.key === b.key) continue
      if (!overlaps(a, b, opts.periodTimes)) continue
      if (a.courseId === b.courseId) {
        out.push({ kind: 'students', a: a.key, b: b.key, detail: 'same-course' }) // 같은 수업 두 차시가 같은 시간(잘못된 이동)
        continue
      }
      const t = sharedTeacher(a, b)
      if (t) out.push({ kind: 'teacher', a: a.key, b: b.key, detail: t.detail, possible: t.possible || undefined })
      const r = sharedRoom(a, b)
      if (r && !opts.sharedRooms?.has(r.detail)) out.push({ kind: 'room', a: a.key, b: b.key, detail: r.detail, possible: r.possible || undefined })
      const n = opts.studentOverlap ? opts.studentOverlap(a.courseId, b.courseId) : 0
      if (n > 0) out.push({ kind: 'students', a: a.key, b: b.key, detail: String(n) })
    }
  }
  return out
}

/** 차시 상태 검증: 교시 범위, 시각 순서 */
export function validateSlot(slot: SlotState, opts: { maxPeriod?: number } = {}): string[] {
  const errors: string[] = []
  const maxPeriod = opts.maxPeriod ?? 10
  if (!/^\d{8}$/.test(slot.date)) errors.push('날짜 형식이 올바르지 않아요.')
  if (!Number.isInteger(slot.period) || slot.period < 0 || slot.period > maxPeriod) errors.push(`교시는 0~${maxPeriod} 사이여야 해요.`)
  const s = hmToMinutes(slot.start ?? null)
  const e = hmToMinutes(slot.end ?? null)
  if ((slot.start && s === null) || (slot.end && e === null)) errors.push('시각 형식이 올바르지 않아요(HH:MM).')
  if (s !== null && e !== null && e <= s) errors.push('끝나는 시각이 시작 시각보다 늦어야 해요.')
  return errors
}

/**
 * 변경 묶음을 적용한 '최종 상태'의 차시 목록(서버 충돌 검사용 — 학생 화면과 같은 규칙).
 * 기존 유효 변경 위에 제안된 변경을 더 큰 revision으로 올려 넣어 계산 — 교시 교환의 중간 상태 때문에 막히지 않음.
 * offDays: 쉬는 날에는 명시적으로 옮긴 차시가 아니면 기본 차시가 열리지 않음.
 */
export function occurrencesForDates(
  dates: Ymd[],
  courses: Course[],
  series: LessonSeries[],
  overrides: Override[],
  opts: { offDays?: Set<Ymd> } = {}
): ScheduledOccurrence[] {
  const courseById = new Map(courses.map((c) => [c.courseId, c]))
  const uniq = uniqueSeries(series)
  const seriesById = new Map(uniq.map((s) => [s.seriesId, s]))
  const eff = effectiveOverrides(overrides)
  const mkBase = makeupBases(overrides)
  const out: ScheduledOccurrence[] = []
  const pushed = new Set<string>()
  const dateSet = new Set(dates)
  const emit = (key: string, courseId: string, st: SlotState) => {
    const k = groupKey(courseId, key)
    if (pushed.has(k) || !dateSet.has(st.date)) return
    const course = courseById.get(courseId)
    if (!course || !courseActiveOn(course, st.date)) return
    pushed.add(k)
    out.push({ key, courseId, date: st.date, period: st.period, start: st.start, end: st.end, roomId: st.roomId, roomName: st.roomName, teacherUids: st.teacherUids, teacherNames: st.teacherNames })
  }
  for (const D of dates) {
    const off = !!opts.offDays?.has(D)
    for (const s of uniq) {
      const course = courseById.get(s.courseId)
      if (!course || !courseActiveOn(course, D) || !seriesOccursOn(s, D)) continue
      const key = occurrenceKeyOf(s.seriesId, D)
      const base = baseStateOf(s, D, course)
      const o = eff.get(groupKey(s.courseId, key))
      if (!o || o.kind === 'restore' || o.kind === 'makeup' || (o.kind === 'reschedule' && !o.target)) {
        if (!off) emit(key, s.courseId, base)
      } else if (o.kind === 'reschedule' && o.target) {
        const after = mergeTarget(base, o.target)
        if (off && after.date === D && !explicitlyScheduled(diffSlots(base, after))) continue
        emit(key, s.courseId, after)
      }
    }
  }
  for (const [gk, o] of Array.from(eff.entries())) {
    if (pushed.has(gk) || o.kind === 'cancel') continue
    if (o.occurrenceKey.startsWith('mk:')) {
      const mb = mkBase.get(gk)
      if (!mb || !mb.target) continue
      const base = mergeTarget(null, mb.target)
      const cur = o.kind === 'makeup' ? mergeTarget(null, o.target!) : o.kind === 'restore' ? base : o.target ? mergeTarget(base, o.target) : null
      if (cur) emit(o.occurrenceKey, o.courseId, cur)
      continue
    }
    if (o.kind !== 'reschedule' || !o.target || !dateSet.has(o.target.date)) continue
    const parsed = parseOccurrenceKey(o.occurrenceKey)
    const s = parsed ? seriesById.get(parsed.seriesId) : undefined
    if (!parsed || !s || s.courseId !== o.courseId || !seriesOccursOn(s, parsed.originalDate)) continue
    emit(o.occurrenceKey, o.courseId, mergeTarget(baseStateOf(s, parsed.originalDate, courseById.get(o.courseId)), o.target))
  }
  return out
}

// ───────────────────────── 서버용: 학기 범위(학생 자료) ─────────────────────────

/**
 * 반복 차시 적용 기간을 수업의 학기 안으로 자릅니다(학기를 넘어 지난 학기 수업이 이어지지 않게).
 * 학기를 모르는 수업(termId 비었거나 형식 밖)은 그대로 둡니다.
 */
export function clipSeriesToTerm(s: LessonSeries, range: { startDate: Ymd; endDate: Ymd } | null): LessonSeries {
  if (!range) return s
  const validFrom = s.validFrom < range.startDate ? range.startDate : s.validFrom
  const validTo = !s.validTo || s.validTo > range.endDate ? range.endDate : s.validTo
  if (validFrom === s.validFrom && validTo === s.validTo) return s
  // 비어 있는 기간이 되면 [validFrom, validFrom)으로 — 어떤 날짜에도 열리지 않음
  return { ...s, validFrom, validTo: validTo < validFrom ? validFrom : validTo }
}

/**
 * 학생 자료의 수업에 학기 범위를 적용합니다(차시만 자르면 지난 학기 수업이 학기 뒤에도 '운영 중'으로 남아
 * '일부 수업 시간표가 아직 없어요' 오탐·연결 개인 일정 숨김이 생김).
 * - 학기를 아는 수업: endedOn = min(endedOn, 학기 종료일) — 초대·신청의 courseOpenOn과 같은 기준.
 *   종료일 없이 끝난 수업(status 'ended')은 그대로(종료일을 넣으면 그 전 날짜에 되살아남)
 * - 학기가 조회 시작일 전에 끝난 공통 수업은 뺌. 본인 수강 수업은 지난 기간 표시를 위해 남김
 * 학기를 모르는 수업(termId 비었거나 형식 밖)은 그대로 둡니다.
 */
export function scopeCoursesToTerms(
  courses: Course[],
  termRangeByCourse: Map<string, { startDate: Ymd; endDate: Ymd } | null>,
  enrolledCourseIds: Set<string>,
  from: Ymd
): Course[] {
  const out: Course[] = []
  for (const c of courses) {
    const range = termRangeByCourse.get(c.courseId) ?? null
    if (!range) {
      out.push(c)
      continue
    }
    if (range.endDate <= from && !enrolledCourseIds.has(c.courseId)) continue
    if (c.status === 'ended' && !c.endedOn) {
      out.push(c)
      continue
    }
    const endedOn = c.endedOn && c.endedOn < range.endDate ? c.endedOn : range.endDate
    out.push(endedOn === c.endedOn ? c : { ...c, endedOn })
  }
  return out
}

// ───────────────────────── 서버용: 조회 기간 변경 선택 ─────────────────────────

/**
 * 조회 기간에 필요한 변경만 고릅니다(발행된 것만 넘겨 주세요).
 * 기간 필터를 '차시별 최신 변경을 고른 뒤'가 아니라 '차시 단위'로 적용합니다:
 * 한 차시(수업|occurrenceKey)의 변경 중 하나라도 기간에 걸치면 그 차시의 변경을 모두 넣고,
 * 그 변경이 속한 묶음(changeSetId)의 다른 차시 변경도 모두 넣습니다.
 * (예: 11/20 수업을 10/14로 옮겼다가(rev5) 다시 11/21로 옮긴(rev7) 경우, rev7이 기간 밖이라고 빼면
 *  화면이 rev5를 최신으로 보고 10/14에 수업을 보여 주는 문제 — 차시 단위로 넣으면 엔진이 rev7을 고름)
 */
export function selectOverridesForWindow(
  all: Array<{ o: Override; raw?: Record<string, any> }>,
  from: Ymd,
  to: Ymd
): Override[] {
  const inWindow = (d: unknown) => isYmd(d) && d >= from && d <= to
  const keyOf = (o: Override) => `${o.courseId}|${o.occurrenceKey}`
  const byKey = new Map<string, Override[]>()
  const byChangeSet = new Map<string, Override[]>()
  const keys = new Set<string>()
  for (const { o, raw } of all) {
    if (o.status !== 'published') continue
    const k = keyOf(o)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k)!.push(o)
    if (!byChangeSet.has(o.changeSetId)) byChangeSet.set(o.changeSetId, [])
    byChangeSet.get(o.changeSetId)!.push(o)
    const touches =
      inWindow(o.originalDate) ||
      inWindow(o.target?.date) ||
      (Array.isArray(raw?.dates) && raw!.dates.some((x: unknown) => inWindow(x)))
    if (touches) keys.add(k)
  }
  // 차시 ↔ 묶음을 따라 닫힘을 구함(묶음이 작아 몇 번 안 돎)
  const doneSets = new Set<string>()
  let grew = true
  while (grew) {
    grew = false
    for (const k of Array.from(keys)) {
      for (const o of byKey.get(k) || []) {
        if (doneSets.has(o.changeSetId)) continue
        doneSets.add(o.changeSetId)
        for (const m of byChangeSet.get(o.changeSetId) || []) {
          const mk = keyOf(m)
          if (!keys.has(mk)) {
            keys.add(mk)
            grew = true
          }
        }
      }
    }
  }
  const out: Override[] = []
  keys.forEach((k) => out.push(...(byKey.get(k) || [])))
  return out
}
