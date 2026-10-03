/**
 * 개인 시간표 엔진 — 변경 적용·개인 일정·겹침·정렬·day state·서버 충돌 검사·차시 검증
 *
 * 문서 19장 가상 데이터(실제 학생 정보 아님)
 * - 학교 S1·학기 T1, 별도 학교 S2(같은 이름의 '영어 B'·'교사 Y')
 * - 학생 A: 소속 3학년 4반, 생활과 과학 A + 영어 B 수강
 * - 학생 B: 소속 3학년 5반, 영어 B만 수강
 * - 학생 C: 소속 3학년 4반, 생활과 과학 A만 수강(영어 B 미수강 — 대표 흐름 9의 대조군)
 * - 학생 N: 소속 3학년 4반, 수강 없음
 * - 교사 X: 생활과 과학 A·B, 교사 Y: 영어 B·C
 * - 교실 R34(3학년 4반 교실), R35(3학년 5반 교실), LAB(과학실), R-ENG(영어전용실)
 * - 같은 학교의 다른 영어 분반 '영어 C'(과목명만으로 합쳐지지 않음)
 *
 * 날짜: 2026-10-06(화) TUE, 10-07(수) WED, 10-08(목) THU, 10-09(금) FRI, 10-13(화) NEXT_TUE, 10-20(화) TUE_AFTER
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDayTimetable,
  detectResourceConflicts,
  occurrenceKeyOf,
  occurrencesForDates,
  validateSlot,
} from '../../src/lib/timetable/engine'
import type { ScheduledOccurrence } from '../../src/lib/timetable/engine'
import { weekdayOf } from '../../src/lib/timetable/dates'
import type {
  Course,
  DayTimetable,
  Enrollment,
  HomeroomMembership,
  LessonSeries,
  LessonView,
  Override,
  PeriodTime,
  PersonalEntry,
  SlotState,
  Weekday,
  Ymd,
} from '../../src/lib/timetable/types'

// ───────────────────────── 가상 데이터 ─────────────────────────

const TERM_START: Ymd = '20260901'
const TUE: Ymd = '20261006'
const WED: Ymd = '20261007'
const THU: Ymd = '20261008'
const FRI: Ymd = '20261009'
const NEXT_TUE: Ymd = '20261013'
const NEXT_WED: Ymd = '20261014'
const TUE_AFTER: Ymd = '20261020'
const THU_AFTER: Ymd = '20261022'

const PERIOD_TIMES: PeriodTime[] = [
  { period: 1, start: '09:00', end: '09:50' },
  { period: 2, start: '10:00', end: '10:50' },
  { period: 3, start: '11:00', end: '11:50' },
  { period: 4, start: '12:00', end: '12:50' },
  { period: 5, start: '13:50', end: '14:40' },
  { period: 6, start: '14:50', end: '15:40' },
  { period: 7, start: '15:50', end: '16:40' },
]

const PUBLISHED_AT = Date.UTC(2026, 9, 5, 0, 0, 0)

const UID = { A: 'stu-S1-A', B: 'stu-S1-B', C: 'stu-S1-C', N: 'stu-S1-N' } as const
const HR_3_4 = 'hr-S1-T1-3-4'
const HR_3_5 = 'hr-S1-T1-3-5'

function course(p: {
  courseId: string
  schoolCode?: string
  title: string
  subject: string
  section: string
  teacherUid: string
  teacherName: string
  roomId: string
  roomName: string
}): Course {
  return {
    courseId: p.courseId,
    schoolCode: p.schoolCode ?? 'S1',
    termId: 'T1',
    title: p.title,
    subject: p.subject,
    section: p.section,
    teacherUids: [p.teacherUid],
    teacherNames: [p.teacherName],
    status: 'active',
    endedOn: null,
    commonForHomerooms: [],
    defaultRoomId: p.roomId,
    defaultRoomName: p.roomName,
  }
}

const SCI_A = course({ courseId: 'crs-S1-T1-sci-a', title: '생활과 과학 A', subject: '생활과 과학', section: 'A', teacherUid: 'uid-X', teacherName: '교사 X', roomId: 'R34', roomName: '3학년 4반 교실' })
const SCI_B = course({ courseId: 'crs-S1-T1-sci-b', title: '생활과 과학 B', subject: '생활과 과학', section: 'B', teacherUid: 'uid-X', teacherName: '교사 X', roomId: 'LAB', roomName: '과학실' })
const ENG_B = course({ courseId: 'crs-S1-T1-eng-b', title: '영어 B', subject: '영어', section: 'B', teacherUid: 'uid-Y', teacherName: '교사 Y', roomId: 'R35', roomName: '3학년 5반 교실' })
const ENG_C = course({ courseId: 'crs-S1-T1-eng-c', title: '영어 C', subject: '영어', section: 'C', teacherUid: 'uid-Y', teacherName: '교사 Y', roomId: 'R-ENG', roomName: '영어전용실' })
const S2_ENG_B = course({ courseId: 'crs-S2-T1-eng-b', schoolCode: 'S2', title: '영어 B', subject: '영어', section: 'B', teacherUid: 'uid-S2-Y', teacherName: '교사 Y', roomId: 'S2-R35', roomName: '3학년 5반 교실' })

const S1_COURSES = [SCI_A, SCI_B, ENG_B, ENG_C]
const ALL_COURSES = [...S1_COURSES, S2_ENG_B]

function series(seriesId: string, c: Course, weekday: Weekday, period: number, extra: Partial<LessonSeries> = {}): LessonSeries {
  return {
    seriesId,
    courseId: c.courseId,
    weekday,
    period,
    start: null,
    end: null,
    roomId: null,
    roomName: null,
    teacherNames: [],
    teacherUids: [],
    validFrom: TERM_START,
    validTo: null,
    status: 'active',
    ...extra,
  }
}

const SR = {
  sciA_tue1: series('sr-sci-a-tue1', SCI_A, 2, 1),
  sciB_tue2: series('sr-sci-b-tue2', SCI_B, 2, 2),
  engC_tue2: series('sr-eng-c-tue2', ENG_C, 2, 2),
  engB_tue3: series('sr-eng-b-tue3', ENG_B, 2, 3),
  sciA_thu1: series('sr-sci-a-thu1', SCI_A, 4, 1),
  engB_thu2: series('sr-eng-b-thu2', ENG_B, 4, 2),
  s2engB_tue3: series('sr-s2-eng-b-tue3', S2_ENG_B, 2, 3),
}
const S1_SERIES = [SR.sciA_tue1, SR.sciB_tue2, SR.engC_tue2, SR.engB_tue3, SR.sciA_thu1, SR.engB_thu2]
const ALL_SERIES = [...S1_SERIES, SR.s2engB_tue3]

function enr(uid: string, c: Course, extra: Partial<Enrollment> = {}): Enrollment {
  return { courseId: c.courseId, uid, status: 'active', from: TERM_START, to: null, source: 'invite', ...extra }
}
const ENROLLMENTS: Enrollment[] = [enr(UID.A, SCI_A), enr(UID.A, ENG_B), enr(UID.B, ENG_B), enr(UID.C, SCI_A)]

const HOMEROOMS: Record<string, HomeroomMembership[]> = {
  [UID.A]: [{ homeroomId: HR_3_4, from: TERM_START, to: null }],
  [UID.B]: [{ homeroomId: HR_3_5, from: TERM_START, to: null }],
  [UID.C]: [{ homeroomId: HR_3_4, from: TERM_START, to: null }],
  [UID.N]: [{ homeroomId: HR_3_4, from: TERM_START, to: null }],
}

interface DayOpts {
  overrides?: Override[]
  personalEntries?: PersonalEntry[]
  series?: LessonSeries[]
  courses?: Course[]
  enrollments?: Enrollment[]
  offDay?: { name: string } | null
  noPeriodTimes?: boolean
}

function day(uid: string, date: Ymd, o: DayOpts = {}): DayTimetable {
  return buildDayTimetable({
    uid,
    day: { date, offDay: o.offDay ?? null, periodTimes: o.noPeriodTimes ? undefined : PERIOD_TIMES },
    homerooms: HOMEROOMS[uid] ?? [],
    enrollments: o.enrollments ?? ENROLLMENTS,
    courses: o.courses ?? ALL_COURSES,
    series: o.series ?? ALL_SERIES,
    overrides: o.overrides ?? [],
    personalEntries: o.personalEntries ?? [],
  })
}

function reschedule(id: string, s: LessonSeries, originalDate: Ymd, target: SlotState, extra: Partial<Override> = {}): Override {
  return {
    overrideId: id,
    courseId: s.courseId,
    occurrenceKey: occurrenceKeyOf(s.seriesId, originalDate),
    changeSetId: `cs-${id}`,
    kind: 'reschedule',
    seriesId: s.seriesId,
    originalDate,
    target,
    reason: '학사 일정 조정',
    revision: 1,
    status: 'published',
    publishedAt: PUBLISHED_AT,
    ...extra,
  }
}

function cancel(id: string, s: LessonSeries, originalDate: Ymd, extra: Partial<Override> = {}): Override {
  return { ...reschedule(id, s, originalDate, { date: originalDate, period: s.period }), kind: 'cancel', target: null, reason: '교사 출장', ...extra }
}

function restore(id: string, s: LessonSeries, originalDate: Ymd, extra: Partial<Override> = {}): Override {
  return { ...reschedule(id, s, originalDate, { date: originalDate, period: s.period }), kind: 'restore', target: null, reason: '원래 일정으로', ...extra }
}

function makeup(id: string, c: Course, target: SlotState, extra: Partial<Override> = {}): Override {
  return {
    overrideId: id,
    courseId: c.courseId,
    occurrenceKey: `mk:${id}`,
    changeSetId: `cs-${id}`,
    kind: 'makeup',
    seriesId: null,
    originalDate: null,
    target,
    reason: '보강',
    revision: 1,
    status: 'published',
    publishedAt: PUBLISHED_AT,
    ...extra,
  }
}

function personal(p: Partial<PersonalEntry> & Pick<PersonalEntry, 'entryId' | 'title' | 'kind'>): PersonalEntry {
  return { weekday: null, date: null, period: null, start: null, end: null, roomName: null, memo: null, linkedCourseId: null, ...p }
}

const occ = (s: LessonSeries, originalDate: Ymd) => occurrenceKeyOf(s.seriesId, originalDate)
const lessonsOf = (t: DayTimetable, c: Course) => t.lessons.filter((l) => l.courseId === c.courseId)
const brief = (t: DayTimetable) => t.lessons.map((l) => [l.title, l.period] as [string, number | null])

function only<T>(arr: T[], what: string): T {
  assert.equal(arr.length, 1, `${what}: 정확히 1개여야 함 (실제 ${arr.length}개)`)
  return arr[0]
}

function changeOf(l: LessonView) {
  const ch = l.change
  assert.ok(ch, `${l.title} ${l.period}교시에 변경 정보(change)가 있어야 함`)
  return ch
}

/** 서버용: 두 수업을 함께 듣는 학생 수(수강 자료 기준) */
function studentOverlap(a: string, b: string): number {
  const inA = new Set(ENROLLMENTS.filter((e) => e.courseId === a && e.status === 'active').map((e) => e.uid))
  return ENROLLMENTS.filter((e) => e.courseId === b && e.status === 'active' && inA.has(e.uid)).length
}

function conflictsAfter(overrides: Override[], dates: Ymd[] = [TUE], extra: { sharedRooms?: Set<string>; courses?: Course[]; series?: LessonSeries[] } = {}) {
  const occs = occurrencesForDates(dates, extra.courses ?? S1_COURSES, extra.series ?? S1_SERIES, overrides)
  return detectResourceConflicts(occs, { periodTimes: PERIOD_TIMES, studentOverlap, sharedRooms: extra.sharedRooms })
}
const kindsOf = (cs: { kind: string; detail: string }[]) => cs.map((c) => `${c.kind}:${c.detail}`).sort()

// ───────────────────────── 0. 데이터 확인 ─────────────────────────

describe('가상 데이터 기준선', () => {
  test('R17 테스트 날짜의 요일이 의도와 같다(화·수·목·금)', () => {
    assert.equal(weekdayOf(TUE), 2)
    assert.equal(weekdayOf(WED), 3)
    assert.equal(weekdayOf(THU), 4)
    assert.equal(weekdayOf(FRI), 5)
    assert.equal(weekdayOf(NEXT_TUE), 2)
    assert.equal(weekdayOf(TUE_AFTER), 2)
    assert.equal(weekdayOf(THU_AFTER), 4)
  })

  test('대표 흐름 5·6 (R05·T13): 학생 A의 화요일은 수강한 두 수업만, 영어 B는 실제 교실(3학년 5반 교실)로 표시', () => {
    const t = day(UID.A, TUE)
    assert.equal(t.state, 'lessons')
    assert.deepEqual(
      t.lessons.map((l) => [l.title, l.period, l.roomName, l.teacherNames]),
      [
        ['생활과 과학 A', 1, '3학년 4반 교실', ['교사 X']],
        ['영어 B', 3, '3학년 5반 교실', ['교사 Y']],
      ]
    )
    for (const l of t.lessons) {
      assert.equal(l.source, 'enrolled')
      assert.equal(l.synced, true)
      assert.equal(l.change, null)
    }
    assert.deepEqual(t.notices, [])
    assert.deepEqual(t.conflicts, [])
    assert.deepEqual(t.orphanOverrides, [])
    // 같은 과목명의 다른 분반(영어 C)·다른 학교(S2)의 '영어 B'는 섞이지 않음
    assert.ok(!t.lessons.some((l) => l.courseId === ENG_C.courseId || l.courseId === S2_ENG_B.courseId))
  })
})

// ───────────────────────── T16 같은 날 교시 이동 ─────────────────────────

describe('T16 같은 날 교시 이동', () => {
  const move = reschedule('ov-t16', SR.engB_tue3, TUE, { date: TUE, period: 2 }, { reason: '교내 행사' })

  test('T16 같은 날 교시 이동(영어 B 화 3→2교시): 수강생 A·B 모두 변경 전후(fields=time)와 원래 occurrenceId로 반영 (대표 흐름 7·8·10, R09·R10)', () => {
    for (const uid of [UID.A, UID.B]) {
      const t = day(uid, TUE, { overrides: [move] })
      const eng = only(lessonsOf(t, ENG_B), `${uid}의 영어 B`)
      assert.equal(eng.period, 2)
      assert.equal(eng.occurrenceId, occ(SR.engB_tue3, TUE))
      assert.equal(eng.key, occ(SR.engB_tue3, TUE))
      assert.equal(eng.roomName, '3학년 5반 교실', '교실은 그대로')
      assert.equal(eng.synced, true)
      const ch = changeOf(eng)
      assert.equal(ch.kind, 'reschedule')
      assert.deepEqual(ch.fields, ['time'])
      assert.equal(ch.before?.date, TUE)
      assert.equal(ch.before?.period, 3)
      assert.equal(ch.after.date, TUE)
      assert.equal(ch.after.period, 2)
      assert.equal(ch.reason, '교내 행사')
      assert.equal(ch.changeSetId, 'cs-ov-t16')
      assert.equal(ch.revision, 1)
      assert.equal(ch.publishedAt, PUBLISHED_AT)
      assert.deepEqual(t.notices, [], '같은 날 이동은 안내 행(moved-out)을 만들지 않음')
      assert.deepEqual(t.orphanOverrides, [])
    }
    const a = day(UID.A, TUE, { overrides: [move] })
    assert.deepEqual(brief(a), [
      ['생활과 과학 A', 1],
      ['영어 B', 2],
    ])
    assert.equal(only(lessonsOf(a, SCI_A), '생활과 과학 A').change, null, '다른 수업은 강조 없음')
    assert.deepEqual(a.conflicts, [])
  })

  test('T16 대표 흐름 9: 영어 B를 듣지 않는 학생 C의 시간표는 변경 전과 완전히 같다', () => {
    assert.deepEqual(day(UID.C, TUE, { overrides: [move] }), day(UID.C, TUE))
  })

  test('T16 대표 흐름 11·R11: 같은 요일 다음 주(10/13 화)의 기본 시간표는 임시 변경 영향 없음', () => {
    const next = day(UID.A, NEXT_TUE, { overrides: [move] })
    assert.deepEqual(next, day(UID.A, NEXT_TUE))
    const eng = only(lessonsOf(next, ENG_B), '다음 주 영어 B')
    assert.equal(eng.period, 3)
    assert.equal(eng.change, null)
    assert.equal(eng.occurrenceId, occ(SR.engB_tue3, NEXT_TUE))
  })

  test('T16·T33 학교 S2의 같은 이름 수업(영어 B·교사 Y) 변경은 S1 학생 A·B에게 영향 없음', () => {
    const s2move = reschedule('ov-s2', SR.s2engB_tue3, TUE, { date: TUE, period: 1 })
    for (const uid of [UID.A, UID.B]) {
      assert.deepEqual(day(uid, TUE, { overrides: [s2move] }), day(uid, TUE))
    }
  })
})

// ───────────────────────── T17 교시 교환 ─────────────────────────

describe('T17 교시 교환 묶음', () => {
  const swap = [
    reschedule('ov-swap-sci', SR.sciA_tue1, TUE, { date: TUE, period: 3 }, { changeSetId: 'cs-swap-1006', revision: 7 }),
    reschedule('ov-swap-eng', SR.engB_tue3, TUE, { date: TUE, period: 1 }, { changeSetId: 'cs-swap-1006', revision: 7 }),
  ]

  test('T17 교시 교환(생활과 과학 A 1교시 ↔ 영어 B 3교시): 같은 changeSetId·revision 묶음이 두 수업 수강생 각각에 반영, A에게 중간 상태(겹침) 없음', () => {
    const a = day(UID.A, TUE, { overrides: swap })
    assert.deepEqual(brief(a), [
      ['영어 B', 1],
      ['생활과 과학 A', 3],
    ])
    for (const l of a.lessons) {
      const ch = changeOf(l)
      assert.equal(ch.changeSetId, 'cs-swap-1006')
      assert.equal(ch.revision, 7)
      assert.deepEqual(ch.fields, ['time'])
    }
    assert.deepEqual(a.conflicts, [], '교환 최종 상태에서는 겹침 없음')
    assert.deepEqual(a.notices, [])

    const b = day(UID.B, TUE, { overrides: swap })
    assert.deepEqual(brief(b), [['영어 B', 1]])
    assert.equal(changeOf(b.lessons[0]).before?.period, 3)

    const c = day(UID.C, TUE, { overrides: swap })
    assert.deepEqual(brief(c), [['생활과 과학 A', 3]])
    assert.equal(changeOf(c.lessons[0]).before?.period, 1)
  })

  test('T17·T28 교환 묶음의 도착 순서가 바뀌어도 결과 동일', () => {
    for (const uid of [UID.A, UID.B, UID.C]) {
      assert.deepEqual(day(uid, TUE, { overrides: [...swap].reverse() }), day(uid, TUE, { overrides: swap }))
    }
  })
})

// ───────────────────────── T18 날짜 간 이동 ─────────────────────────

describe('T18 다른 날짜로 이동', () => {
  const move = reschedule('ov-t18', SR.engB_tue3, TUE, { date: THU, period: 4 }, { reason: '현장 체험학습' })
  const movedId = occ(SR.engB_tue3, TUE)

  test('T18 영어 B 화 3교시 → 목 4교시: 원래 날은 moved-out 안내만, 새 날에 한 번만, occurrenceId 유지', () => {
    const tue = day(UID.A, TUE, { overrides: [move] })
    assert.deepEqual(brief(tue), [['생활과 과학 A', 1]], '원래 날의 실제 수업 목록에서 빠짐')
    const n = only(tue.notices, '화요일 안내')
    assert.equal(n.kind, 'moved-out')
    assert.equal(n.key, movedId)
    assert.equal(n.courseId, ENG_B.courseId)
    assert.equal(n.original.date, TUE)
    assert.equal(n.original.period, 3)
    assert.equal(n.movedTo?.date, THU)
    assert.equal(n.movedTo?.period, 4)
    assert.equal(n.reason, '현장 체험학습')
    assert.ok(!tue.lessons.some((l) => l.key === n.key), '안내 행이 실제 수업으로 섞이지 않음')

    const thu = day(UID.A, THU, { overrides: [move] })
    const moved = only(thu.lessons.filter((l) => l.occurrenceId === movedId), '목요일에 옮겨 온 영어 B')
    assert.equal(moved.period, 4)
    assert.equal(moved.courseId, ENG_B.courseId)
    const ch = changeOf(moved)
    assert.deepEqual(ch.fields, ['date', 'time'])
    assert.equal(ch.before?.date, TUE)
    assert.equal(ch.before?.period, 3)
    assert.equal(ch.after.date, THU)
    assert.equal(ch.after.period, 4)
    assert.deepEqual(thu.notices, [])
    // 목요일 원래 영어 B(2교시)는 별개 차시로 그대로
    const base = only(thu.lessons.filter((l) => l.occurrenceId === occ(SR.engB_thu2, THU)), '목요일 원래 영어 B')
    assert.equal(base.period, 2)
    assert.equal(base.change, null)
    assert.deepEqual(brief(thu), [
      ['생활과 과학 A', 1],
      ['영어 B', 2],
      ['영어 B', 4],
    ])

    // 같은 차시가 주간 어디에도 정상 수업으로 두 번 나오지 않음
    let total = 0
    for (const d of [TUE, WED, THU, FRI]) total += day(UID.A, d, { overrides: [move] }).lessons.filter((l) => l.occurrenceId === movedId).length
    assert.equal(total, 1)
    assert.deepEqual(day(UID.A, WED, { overrides: [move] }), day(UID.A, WED))
  })

  test('T18 실제 진행일 기준 수강 자격: 학생 B에게도 목요일에 반영, 미수강 학생 C는 변화 없음', () => {
    const b = day(UID.B, THU, { overrides: [move] })
    assert.equal(only(b.lessons.filter((l) => l.occurrenceId === movedId), 'B의 옮겨 온 영어 B').period, 4)
    const bTue = day(UID.B, TUE, { overrides: [move] })
    assert.deepEqual(bTue.lessons, [])
    assert.equal(bTue.state, 'no-lessons')
    assert.equal(only(bTue.notices, 'B 화요일 안내').kind, 'moved-out')
    for (const d of [TUE, THU]) assert.deepEqual(day(UID.C, d, { overrides: [move] }), day(UID.C, d))
  })

  test('T18 다음 주 같은 요일로 이동: 그 날의 기본 차시와 옮겨 온 차시가 서로 다른 occurrenceId로 각각 한 번', () => {
    const toNext = reschedule('ov-t18-next', SR.engB_tue3, TUE, { date: NEXT_TUE, period: 5 })
    const t = day(UID.A, NEXT_TUE, { overrides: [toNext] })
    const eng = lessonsOf(t, ENG_B)
    assert.equal(eng.length, 2)
    const baseL = only(eng.filter((l) => l.occurrenceId === occ(SR.engB_tue3, NEXT_TUE)), '다음 주 기본 차시')
    assert.equal(baseL.period, 3)
    assert.equal(baseL.change, null)
    const movedL = only(eng.filter((l) => l.occurrenceId === movedId), '옮겨 온 차시')
    assert.equal(movedL.period, 5)
    assert.deepEqual(changeOf(movedL).fields, ['date', 'time'])
    assert.equal(only(day(UID.A, TUE, { overrides: [toNext] }).notices, '원래 날 안내').movedTo?.date, NEXT_TUE)
  })

  test('T18·T28 같은 차시를 두 번 옮기면(목 → 금) 최신 revision의 목적지에만 표시, 이전 목적지엔 없음', () => {
    const first = reschedule('ov-t18-r1', SR.engB_tue3, TUE, { date: THU, period: 4 }, { revision: 1 })
    const second = reschedule('ov-t18-r2', SR.engB_tue3, TUE, { date: FRI, period: 1 }, { revision: 2 })
    for (const overrides of [
      [first, second],
      [second, first],
    ]) {
      assert.equal(day(UID.A, THU, { overrides }).lessons.filter((l) => l.occurrenceId === movedId).length, 0)
      const fri = day(UID.A, FRI, { overrides })
      const moved = only(fri.lessons.filter((l) => l.occurrenceId === movedId), '금요일 영어 B')
      assert.equal(moved.period, 1)
      assert.equal(changeOf(moved).revision, 2)
      assert.equal(only(day(UID.A, TUE, { overrides }).notices, '화요일 안내').movedTo?.date, FRI)
    }
  })
})

// ───────────────────────── T19 교실/교사 변경 ─────────────────────────

describe('T19 교실·교사 변경', () => {
  test('T19 교실 변경(R35 → 영어전용실): fields=room, 변경 전후 교실명, 수강생 집단(courseId)·시간·교사 유지', () => {
    const o = reschedule('ov-t19-room', SR.engB_tue3, TUE, { date: TUE, period: 3, roomId: 'R-ENG', roomName: '영어전용실' })
    for (const uid of [UID.A, UID.B]) {
      const eng = only(lessonsOf(day(uid, TUE, { overrides: [o] }), ENG_B), `${uid} 영어 B`)
      assert.equal(eng.courseId, ENG_B.courseId)
      assert.equal(eng.period, 3)
      assert.equal(eng.roomName, '영어전용실')
      assert.deepEqual(eng.teacherNames, ['교사 Y'])
      const ch = changeOf(eng)
      assert.deepEqual(ch.fields, ['room'])
      assert.equal(ch.before?.roomName, '3학년 5반 교실')
      assert.equal(ch.after.roomName, '영어전용실')
    }
    assert.deepEqual(day(UID.C, TUE, { overrides: [o] }), day(UID.C, TUE), '교실 칸 덮어쓰기 금지 — 미수강 학생 영향 없음')
  })

  test('T19 교사 변경(대체 교사 Z): fields=teacher, 교실·시간은 그대로', () => {
    const o = reschedule('ov-t19-teacher', SR.engB_tue3, TUE, { date: TUE, period: 3, teacherUids: ['uid-Z'], teacherNames: ['교사 Z'] })
    for (const uid of [UID.A, UID.B]) {
      const eng = only(lessonsOf(day(uid, TUE, { overrides: [o] }), ENG_B), `${uid} 영어 B`)
      assert.equal(eng.courseId, ENG_B.courseId, '교사 교체는 다른 수업반으로 바뀌는 것이 아님')
      assert.deepEqual(eng.teacherNames, ['교사 Z'])
      assert.equal(eng.roomName, '3학년 5반 교실')
      assert.equal(eng.period, 3)
      const ch = changeOf(eng)
      assert.deepEqual(ch.fields, ['teacher'])
      assert.deepEqual(ch.before?.teacherNames, ['교사 Y'])
      assert.deepEqual(ch.after.teacherNames, ['교사 Z'])
    }
  })

  test('T19·R10 교실 이름만 지정한 교실 변경(roomId 미지정, 예: 운동장)도 room 변경으로 강조되고 이전 교실 id가 남지 않는다', () => {
    const o = reschedule('ov-t19-roomname', SR.engB_tue3, TUE, { date: TUE, period: 3, roomName: '운동장' })
    const eng = only(lessonsOf(day(UID.A, TUE, { overrides: [o] }), ENG_B), '영어 B')
    assert.equal(eng.roomName, '운동장')
    const ch = changeOf(eng)
    assert.deepEqual(ch.fields, ['room'])
    assert.equal(ch.before?.roomName, '3학년 5반 교실')
    assert.equal(ch.after.roomName, '운동장')
    assert.notEqual(ch.after.roomId, 'R35', '운동장으로 옮긴 차시가 여전히 R35를 점유한 것으로 남으면 안 됨')
  })
})

// ───────────────────────── T20 취소·보강 ─────────────────────────

describe('T20 취소·보강', () => {
  test('T20 취소: 실제 수업 목록에서 빠지고 notices(cancelled)로만 — 수강생 A·B, 미수강 C는 영향 없음', () => {
    const o = cancel('ov-t20-cancel', SR.engB_tue3, TUE)
    const a = day(UID.A, TUE, { overrides: [o] })
    assert.deepEqual(brief(a), [['생활과 과학 A', 1]])
    const n = only(a.notices, '취소 안내')
    assert.equal(n.kind, 'cancelled')
    assert.equal(n.key, occ(SR.engB_tue3, TUE))
    assert.equal(n.courseId, ENG_B.courseId)
    assert.equal(n.title, '영어 B')
    assert.equal(n.original.period, 3)
    assert.equal(n.reason, '교사 출장')
    assert.ok(!a.lessons.some((l) => l.key === n.key))

    const b = day(UID.B, TUE, { overrides: [o] })
    assert.deepEqual(b.lessons, [])
    assert.equal(b.state, 'no-lessons')
    assert.equal(only(b.notices, 'B 취소 안내').kind, 'cancelled')

    assert.deepEqual(day(UID.C, TUE, { overrides: [o] }), day(UID.C, TUE))
  })

  test('T20 보강: 기본에 없던 수요일 5교시 차시가 makeup(before=null)으로 수강생에게만 추가', () => {
    const mk = makeup('mk-eng-wed5', ENG_B, { date: WED, period: 5, roomId: 'R35', roomName: '3학년 5반 교실', teacherUids: ['uid-Y'], teacherNames: ['교사 Y'] })
    for (const uid of [UID.A, UID.B]) {
      const t = day(uid, WED, { overrides: [mk] })
      assert.equal(t.state, 'lessons')
      const l = only(lessonsOf(t, ENG_B), `${uid} 보강`)
      assert.equal(l.occurrenceId, 'mk:mk-eng-wed5')
      assert.equal(l.period, 5)
      assert.equal(l.roomName, '3학년 5반 교실')
      const ch = changeOf(l)
      assert.equal(ch.kind, 'makeup')
      assert.equal(ch.before, null)
      assert.equal(ch.after.date, WED)
      assert.deepEqual(ch.fields, [])
      assert.deepEqual(t.notices, [])
    }
    const c = day(UID.C, WED, { overrides: [mk] })
    assert.deepEqual(c, day(UID.C, WED))
    // 보강은 다른 날에 영향 없음
    assert.deepEqual(day(UID.A, TUE, { overrides: [mk] }), day(UID.A, TUE))
    assert.deepEqual(day(UID.A, NEXT_WED, { overrides: [mk] }), day(UID.A, NEXT_WED))
  })

  test('T20 취소+보강 묶음: 화요일은 취소 안내, 수요일은 보강 수업 — 서로 섞이지 않음', () => {
    const set = [
      cancel('ov-cm-cancel', SR.engB_tue3, TUE, { changeSetId: 'cs-cancel-makeup', revision: 3 }),
      makeup('mk-cm', ENG_B, { date: WED, period: 6 }, { changeSetId: 'cs-cancel-makeup', revision: 3 }),
    ]
    const tue = day(UID.A, TUE, { overrides: set })
    assert.deepEqual(brief(tue), [['생활과 과학 A', 1]])
    assert.equal(only(tue.notices, '화 안내').kind, 'cancelled')
    const wed = day(UID.A, WED, { overrides: set })
    assert.deepEqual(brief(wed), [['영어 B', 6]])
    assert.equal(changeOf(wed.lessons[0]).kind, 'makeup')
    assert.deepEqual(wed.notices, [])
  })

  test('T20·T28 보강 차시가 이후 revision에서 취소되면 실제 수업으로 표시하지 않음', () => {
    const mk = makeup('mk-eng-wed5', ENG_B, { date: WED, period: 5 }, { revision: 1 })
    const mkCancel: Override = { ...mk, overrideId: 'mk-eng-wed5-cancel', kind: 'cancel', target: null, revision: 2 }
    for (const overrides of [
      [mk, mkCancel],
      [mkCancel, mk],
    ]) {
      const t = day(UID.A, WED, { overrides })
      assert.deepEqual(lessonsOf(t, ENG_B), [])
    }
  })
})

// ───────────────────────── T23 복원 ─────────────────────────

describe('T23 복원', () => {
  test('T23 복원(restore)이 최신 revision이면 기본 상태·강조 없음 (도착 순서 무관)', () => {
    const moved = reschedule('ov-t23-move', SR.engB_tue3, TUE, { date: TUE, period: 2 }, { revision: 1 })
    const back = restore('ov-t23-restore', SR.engB_tue3, TUE, { revision: 2 })
    for (const overrides of [
      [moved, back],
      [back, moved],
    ]) {
      const t = day(UID.A, TUE, { overrides })
      const eng = only(lessonsOf(t, ENG_B), '영어 B')
      assert.equal(eng.period, 3)
      assert.equal(eng.change, null)
      assert.deepEqual(t, day(UID.A, TUE), '복원 후 현재 표시는 변경 없는 상태와 같음')
    }
  })

  test('T23 날짜 이동 후 복원: 원래 날에 강조 없이 다시 표시되고 옮겨 갔던 날에는 없음', () => {
    const moved = reschedule('ov-t23-dmove', SR.engB_tue3, TUE, { date: THU, period: 4 }, { revision: 1 })
    const back = restore('ov-t23-drestore', SR.engB_tue3, TUE, { revision: 2 })
    assert.deepEqual(day(UID.A, TUE, { overrides: [moved, back] }), day(UID.A, TUE))
    assert.deepEqual(day(UID.A, THU, { overrides: [moved, back] }), day(UID.A, THU))
  })

  test('T23 기본 상태와 같은 목표로 다시 옮긴 변경(현재 차이 없음)은 강조하지 않음', () => {
    const moved = reschedule('ov-t23-a', SR.engB_tue3, TUE, { date: TUE, period: 2 }, { revision: 1 })
    const same = reschedule('ov-t23-b', SR.engB_tue3, TUE, { date: TUE, period: 3 }, { revision: 2 })
    const eng = only(lessonsOf(day(UID.A, TUE, { overrides: [moved, same] }), ENG_B), '영어 B')
    assert.equal(eng.period, 3)
    assert.equal(eng.change, null)
  })
})

// ───────────────────────── T28 revision·재전송·역순 ─────────────────────────

describe('T28 revision 최대만 유효', () => {
  const r1 = reschedule('ov-r1', SR.engB_tue3, TUE, { date: TUE, period: 2 }, { revision: 1 })
  const r2 = reschedule('ov-r2', SR.engB_tue3, TUE, { date: TUE, period: 5 }, { revision: 2 })
  const r3 = reschedule('ov-r3', SR.engB_tue3, TUE, { date: TUE, period: 4 }, { revision: 3 })

  test('T28 revision 최대(3)만 유효: 모든 도착 순서에서 결과 동일', () => {
    const orders = [
      [r1, r2, r3],
      [r3, r2, r1],
      [r2, r3, r1],
      [r3, r1, r2],
    ]
    const expected = day(UID.A, TUE, { overrides: orders[0] })
    const eng = only(lessonsOf(expected, ENG_B), '영어 B')
    assert.equal(eng.period, 4)
    assert.equal(changeOf(eng).revision, 3)
    for (const overrides of orders) assert.deepEqual(day(UID.A, TUE, { overrides }), expected)
  })

  test('T28 같은 변경 재전송(중복 이벤트): 수업·안내가 한 번만', () => {
    const t = day(UID.A, TUE, { overrides: [r3, r3, { ...r3 }] })
    assert.equal(lessonsOf(t, ENG_B).length, 1)
    assert.deepEqual(t, day(UID.A, TUE, { overrides: [r3] }))
    const c = cancel('ov-dup-cancel', SR.engB_tue3, TUE)
    const tc = day(UID.A, TUE, { overrides: [c, c, { ...c }] })
    assert.equal(tc.notices.length, 1)
    const mv = reschedule('ov-dup-move', SR.engB_tue3, TUE, { date: THU, period: 4 })
    assert.equal(day(UID.A, TUE, { overrides: [mv, mv] }).notices.length, 1)
    assert.equal(day(UID.A, THU, { overrides: [mv, mv] }).lessons.filter((l) => l.occurrenceId === occ(SR.engB_tue3, TUE)).length, 1)
  })

  test('T28 회수(withdrawn)된 변경은 revision이 더 커도 무시', () => {
    const withdrawn: Override = { ...r2, overrideId: 'ov-withdrawn', revision: 9, status: 'withdrawn' }
    const eng = only(lessonsOf(day(UID.A, TUE, { overrides: [r1, withdrawn] }), ENG_B), '영어 B')
    assert.equal(eng.period, 2)
    assert.equal(changeOf(eng).revision, 1)
  })

  test('T28 같은 revision의 서로 다른 변경이 경쟁해도 도착 순서와 무관하게 결정적', () => {
    const x = reschedule('ov-tie-a', SR.engB_tue3, TUE, { date: TUE, period: 2 }, { revision: 4 })
    const y = reschedule('ov-tie-b', SR.engB_tue3, TUE, { date: TUE, period: 5 }, { revision: 4 })
    assert.deepEqual(day(UID.A, TUE, { overrides: [x, y] }), day(UID.A, TUE, { overrides: [y, x] }))
    assert.equal(lessonsOf(day(UID.A, TUE, { overrides: [x, y] }), ENG_B).length, 1)
  })

  test('T28·T05 같은 반복 차시 자료가 중복 입력돼도(공통·개별 수강 경로 중복 조회 등) 수업과 취소·이동 안내가 각각 한 번', () => {
    const dupSeries = [...ALL_SERIES, { ...SR.engB_tue3 }]
    assert.equal(lessonsOf(day(UID.A, TUE, { series: dupSeries }), ENG_B).length, 1, '수업은 한 번')
    const c = cancel('ov-dupser-cancel', SR.engB_tue3, TUE)
    assert.equal(day(UID.A, TUE, { series: dupSeries, overrides: [c] }).notices.length, 1, '취소 안내는 한 번')
    const mv = reschedule('ov-dupser-move', SR.engB_tue3, TUE, { date: THU, period: 4 })
    assert.equal(day(UID.A, TUE, { series: dupSeries, overrides: [mv] }).notices.length, 1, '이동 안내는 한 번')
  })
})

// ───────────────────────── T22 기본 버전 변경 후 예외 ─────────────────────────

describe('T22 기본 시간표 버전 변경과 기존 예외', () => {
  // 10/13부터 영어 B 화요일 3교시(v1) → 4교시(v2)로 기본 시간표 변경
  const v1: LessonSeries = { ...SR.engB_tue3, validTo: NEXT_TUE, status: 'retired' }
  const v2 = series('sr-eng-b-tue4-v2', ENG_B, 2, 4, { validFrom: NEXT_TUE })
  const seriesV = [...ALL_SERIES.filter((s) => s.seriesId !== SR.engB_tue3.seriesId), v1, v2]
  // 기본 변경 전에 만들어 둔 10/20 예외(v1의 10/20 차시를 2교시로) — 대상 차시가 더 이상 없음
  const stale = reschedule('ov-t22-stale', v1, TUE_AFTER, { date: TUE_AFTER, period: 2 })
  // 기본 변경 전 날짜(10/6)의 예외 — 계속 유효
  const past = reschedule('ov-t22-past', v1, TUE, { date: TUE, period: 2 })

  test('T22 사라진 차시를 가리키는 변경은 조용히 버리지 않고 orphanOverrides로, 새 기본 차시는 강조 없이', () => {
    const t = day(UID.A, TUE_AFTER, { series: seriesV, overrides: [stale, past] })
    assert.deepEqual(
      t.orphanOverrides.map((o) => o.overrideId),
      ['ov-t22-stale']
    )
    const eng = only(lessonsOf(t, ENG_B), '10/20 영어 B')
    assert.equal(eng.occurrenceId, occ(v2, TUE_AFTER))
    assert.equal(eng.period, 4)
    assert.equal(eng.change, null)
    assert.ok(!t.lessons.some((l) => l.occurrenceId === stale.occurrenceKey), '대상 없는 변경으로 수업을 만들어 내지 않음')
  })

  test('T22·T21 기본 변경 전 날짜의 예외는 그대로 유효(과거 시간표 보존), 적용일 이후는 새 기본값', () => {
    const tue = day(UID.A, TUE, { series: seriesV, overrides: [stale, past] })
    const eng = only(lessonsOf(tue, ENG_B), '10/6 영어 B')
    assert.equal(eng.occurrenceId, occ(v1, TUE))
    assert.equal(eng.period, 2)
    assert.deepEqual(changeOf(eng).fields, ['time'])
    assert.deepEqual(tue.orphanOverrides, [])
    const next = day(UID.A, NEXT_TUE, { series: seriesV, overrides: [stale, past] })
    assert.deepEqual(
      lessonsOf(next, ENG_B).map((l) => [l.occurrenceId, l.period]),
      [[occ(v2, NEXT_TUE), 4]]
    )
  })

  test('T22 다른 날로 옮기는 예외의 대상이 사라지면 목적지 날짜에서도 orphanOverrides로 표시', () => {
    const staleMove = reschedule('ov-t22-stale-move', v1, TUE_AFTER, { date: THU_AFTER, period: 5 })
    const thu = day(UID.A, THU_AFTER, { series: seriesV, overrides: [staleMove] })
    assert.deepEqual(
      thu.orphanOverrides.map((o) => o.overrideId),
      ['ov-t22-stale-move']
    )
    assert.ok(!thu.lessons.some((l) => l.occurrenceId === staleMove.occurrenceKey))
    assert.deepEqual(
      day(UID.A, TUE_AFTER, { series: seriesV, overrides: [staleMove] }).orphanOverrides.map((o) => o.overrideId),
      ['ov-t22-stale-move']
    )
  })

  test('T22·대표 흐름 9: 영어 B를 듣지 않는 학생 C의 시간표에는 영어 B의 대상 없는 변경(검토 필요)도 나타나지 않음', () => {
    const c = day(UID.C, TUE_AFTER, { series: seriesV, overrides: [stale] })
    assert.deepEqual(c.lessons, day(UID.C, TUE_AFTER, { series: seriesV }).lessons)
    assert.deepEqual(
      c.orphanOverrides.map((o) => o.overrideId),
      [],
      '수강하지 않는 수업의 변경이 학생 C의 결과(orphanOverrides)에 반영됨'
    )
  })
})

// ───────────────────────── 쉬는 날 ─────────────────────────

describe('쉬는 날(offDay)', () => {
  const offDay = { name: '개교기념일' }

  test('R15·T34 쉬는 날: 기본 차시는 표시하지 않고 state=holiday, offDayName 유지', () => {
    const t = day(UID.A, TUE, { offDay })
    assert.deepEqual(t.lessons, [])
    assert.equal(t.state, 'holiday')
    assert.equal(t.offDayName, '개교기념일')
    assert.deepEqual(t.activeCourseIds.sort(), [ENG_B.courseId, SCI_A.courseId].sort())
  })

  test('R15·T20 쉬는 날에도 명시된 보강·다른 날에서 옮겨 온 차시는 표시(기본 차시는 미표시)', () => {
    const mk = makeup('mk-holiday', ENG_B, { date: TUE, period: 5 })
    const movedIn = reschedule('ov-holiday-in', SR.sciA_thu1, THU, { date: TUE, period: 6 })
    const t = day(UID.A, TUE, { offDay, overrides: [mk, movedIn] })
    assert.equal(t.state, 'lessons')
    assert.deepEqual(
      t.lessons.map((l) => [l.occurrenceId, l.period]),
      [
        ['mk:mk-holiday', 5],
        [occ(SR.sciA_thu1, THU), 6],
      ]
    )
    assert.ok(!t.lessons.some((l) => l.occurrenceId === occ(SR.sciA_tue1, TUE) || l.occurrenceId === occ(SR.engB_tue3, TUE)))
    // 원래 날(목)에는 옮겨 갔다는 안내
    assert.equal(only(day(UID.A, THU, { overrides: [mk, movedIn] }).notices, '목 안내').movedTo?.date, TUE)
  })
})

// ───────────────────────── 대표 흐름 9: 미수강 학생 ─────────────────────────

describe('대표 흐름 9 — 미수강 학생 영향 없음', () => {
  test('대표 흐름 9·R09: 영어 B의 교시 이동·날짜 이동·취소·보강·교실 변경이 있어도 학생 C의 화·수·목·다음 화 시간표는 그대로', () => {
    const overrides = [
      reschedule('ov-f9-same', SR.engB_tue3, TUE, { date: TUE, period: 1 }),
      reschedule('ov-f9-date', SR.engB_tue3, NEXT_TUE, { date: WED, period: 6 }),
      cancel('ov-f9-cancel', SR.engB_thu2, THU),
      makeup('mk-f9', ENG_B, { date: WED, period: 2 }),
      reschedule('ov-f9-room', SR.engB_thu2, '20261015', { date: '20261015', period: 2, roomId: 'R34', roomName: '3학년 4반 교실' }),
    ]
    for (const d of [TUE, WED, THU, NEXT_TUE, '20261015']) {
      assert.deepEqual(day(UID.C, d, { overrides }), day(UID.C, d), `${d}`)
    }
  })
})

// ───────────────────────── T14·T15 개인 일정 ─────────────────────────

describe('T14·T15 개인 일정', () => {
  test('T14·R08 직접 입력 일정: source=personal, synced=false, courseId·occurrenceId 없음, 변경 표시 없음', () => {
    const pe = personal({ entryId: 'pe-academy', title: '수학 학원', kind: 'weekly', weekday: 2, start: '17:00', end: '18:30', roomName: '학원', memo: '숙제 확인' })
    const t = day(UID.A, TUE, { personalEntries: [pe] })
    const p = only(t.lessons.filter((l) => l.source === 'personal'), '개인 일정')
    assert.equal(p.key, 'p:pe-academy')
    assert.equal(p.synced, false)
    assert.equal(p.courseId, null)
    assert.equal(p.occurrenceId, null)
    assert.equal(p.change, null)
    assert.equal(p.memo, '숙제 확인')
    assert.equal(p.roomName, '학원')
    assert.deepEqual(p.teacherNames, [])
    assert.equal(t.lessons[t.lessons.length - 1].key, 'p:pe-academy', '17:00 일정은 마지막')

    // 학교 변경이 있어도 개인 일정은 자동 변경되지 않음
    const withChange = day(UID.A, TUE, { personalEntries: [pe], overrides: [reschedule('ov-t14', SR.engB_tue3, TUE, { date: TUE, period: 2 })] })
    assert.deepEqual(only(withChange.lessons.filter((l) => l.source === 'personal'), '개인 일정'), p)
  })

  test('T14 특정 날짜(once) 일정은 그 날짜에만, 반복(weekly)은 그 요일에만, pendingSync 그대로 전달', () => {
    const once = personal({ entryId: 'pe-once', title: '동아리 발표', kind: 'once', date: WED, period: 7, pendingSync: true })
    const weekly = personal({ entryId: 'pe-weekly', title: '방과후 독서', kind: 'weekly', weekday: 2, period: 7 })
    const entries = [once, weekly]
    const wed = day(UID.A, WED, { personalEntries: entries })
    assert.deepEqual(
      wed.lessons.map((l) => l.key),
      ['p:pe-once']
    )
    assert.equal(wed.lessons[0].pendingSync, true)
    assert.equal(wed.lessons[0].synced, false)
    assert.deepEqual(day(UID.A, NEXT_WED, { personalEntries: entries }).lessons, [])
    for (const d of [TUE, NEXT_TUE]) {
      assert.deepEqual(
        day(UID.A, d, { personalEntries: entries }).lessons.filter((l) => l.source === 'personal').map((l) => l.key),
        ['p:pe-weekly']
      )
    }
  })

  test('T14·R08 과목명이 같아도(영어 B) 연결되지 않은 개인 일정은 공식 수업과 합치지 않고, 학교 변경 후에도 synced=false — 겹치면 둘 다 보이고 personal 경고', () => {
    const pe = personal({ entryId: 'pe-eng-self', title: '영어 B', kind: 'weekly', weekday: 2, period: 3 })
    const plain = day(UID.A, TUE, { personalEntries: [pe] })
    assert.equal(plain.lessons.length, 3)
    const official = only(lessonsOf(plain, ENG_B), '공식 영어 B')
    const mine = only(plain.lessons.filter((l) => l.key === 'p:pe-eng-self'), '직접 입력 영어 B')
    assert.equal(mine.synced, false)
    assert.equal(mine.courseId, null)
    assert.deepEqual(plain.conflicts.map((c) => [c.kind, [...c.keys].sort()]), [['personal', [official.key, mine.key].sort()]])

    const moved = day(UID.A, TUE, { personalEntries: [pe], overrides: [reschedule('ov-t14-same', SR.engB_tue3, TUE, { date: TUE, period: 2 })] })
    const off2 = only(lessonsOf(moved, ENG_B), '공식 영어 B')
    assert.equal(off2.period, 2)
    assert.ok(off2.change)
    const mine2 = only(moved.lessons.filter((l) => l.key === 'p:pe-eng-self'), '직접 입력 영어 B')
    assert.equal(mine2.period, 3, '직접 입력은 자동으로 따라가지 않음')
    assert.equal(mine2.synced, false)
    assert.equal(mine2.change, null)

    // 공식 수업이 없는 학생 N에게도 개인 일정으로만
    const n = day(UID.N, TUE, { personalEntries: [pe] })
    assert.equal(n.state, 'lessons')
    assert.deepEqual(n.lessons.map((l) => [l.source, l.synced, l.courseId]), [['personal', false, null]])
  })

  test('T15 공식 수업에 연결된 개인 일정: 공식 수업 하나로만 표시, 메모 보존, 학교 변경 반영, 중복·겹침 없음', () => {
    const pe = personal({ entryId: 'pe-eng-linked', title: '영어', kind: 'weekly', weekday: 2, period: 3, memo: '단어 시험 준비', linkedCourseId: ENG_B.courseId })
    for (const overrides of [[], [reschedule('ov-t15', SR.engB_tue3, TUE, { date: TUE, period: 2 })]]) {
      const t = day(UID.A, TUE, { personalEntries: [pe], overrides })
      assert.equal(t.lessons.length, 2)
      assert.ok(!t.lessons.some((l) => l.source === 'personal'), '개인 일정 행이 따로 나오지 않음')
      const eng = only(lessonsOf(t, ENG_B), '영어 B')
      assert.equal(eng.source, 'enrolled')
      assert.equal(eng.synced, true)
      assert.equal(eng.memo, '단어 시험 준비')
      assert.equal(eng.title, '영어 B', '공식 수업 데이터가 개인 입력(영어)으로 덮이지 않음')
      assert.equal(eng.period, overrides.length ? 2 : 3)
      if (overrides.length) assert.deepEqual(changeOf(eng).fields, ['time'])
      assert.ok(!only(lessonsOf(t, SCI_A), '생활과 과학 A').memo, '다른 수업에 메모가 붙지 않음')
      assert.deepEqual(t.conflicts, [])
    }
  })

  test('T15 연결 대상 수업을 실제로 수강 중이 아니면(승인 대기) 개인 일정으로 남고 synced=false', () => {
    const pe = personal({ entryId: 'pe-pending-link', title: '영어', kind: 'weekly', weekday: 2, period: 3, linkedCourseId: ENG_B.courseId })
    const enrollments = [...ENROLLMENTS, enr(UID.N, ENG_B, { status: 'pending', source: 'request' })]
    const t = day(UID.N, TUE, { personalEntries: [pe], enrollments })
    assert.deepEqual(t.pendingCourseIds, [ENG_B.courseId])
    const p = only(t.lessons, '개인 일정')
    assert.equal(p.source, 'personal')
    assert.equal(p.synced, false)
    assert.equal(p.courseId, null)
  })
})

// ───────────────────────── T25 겹침 ─────────────────────────

describe('T25 학생 시간 겹침', () => {
  test('T25 다른 교사·다른 교실이어도 같은 학생의 공식 수업끼리 겹치면 kind=official', () => {
    const t = day(UID.A, TUE, { overrides: [reschedule('ov-t25', SR.sciA_tue1, TUE, { date: TUE, period: 3 })] })
    const sci = only(lessonsOf(t, SCI_A), '생활과 과학 A')
    const eng = only(lessonsOf(t, ENG_B), '영어 B')
    assert.notDeepEqual(sci.teacherNames, eng.teacherNames)
    assert.notEqual(sci.roomName, eng.roomName)
    assert.deepEqual(t.conflicts.map((c) => [c.kind, [...c.keys].sort()]), [['official', [sci.key, eng.key].sort()]])
    assert.equal(t.lessons.length, 2, '겹쳐도 어느 쪽도 숨기지 않음')
  })

  test('T25 교시 번호가 달라도(2교시 vs 3교시) 실제 시각이 겹치면 검출', () => {
    const overrides = [
      reschedule('ov-t25-sci', SR.sciA_tue1, TUE, { date: TUE, period: 2 }), // 10:00~10:50 (교시표)
      reschedule('ov-t25-eng', SR.engB_tue3, TUE, { date: TUE, period: 3, start: '10:40', end: '11:30' }),
    ]
    const t = day(UID.A, TUE, { overrides })
    assert.equal(t.conflicts.length, 1)
    assert.equal(t.conflicts[0].kind, 'official')
    // 같은 교시 번호 배치라도 시각이 안 겹치면 충돌 아님(기본 상태)
    assert.deepEqual(day(UID.A, TUE, { overrides: [overrides[0]] }).conflicts, [])
  })

  test('T25 개인 일정과 공식 수업이 겹치면 kind=personal로 경고하고 둘 다 유지', () => {
    const pe = personal({ entryId: 'pe-consult', title: '보충 상담', kind: 'once', date: TUE, start: '09:30', end: '10:10' })
    const t = day(UID.A, TUE, { personalEntries: [pe] })
    assert.equal(t.lessons.length, 3)
    assert.deepEqual(t.conflicts.map((c) => [c.kind, [...c.keys].sort()]), [['personal', [occ(SR.sciA_tue1, TUE), 'p:pe-consult'].sort()]])
  })

  test('T25 끝과 시작이 맞닿으면(09:50) 겹침 아님', () => {
    const pe = personal({ entryId: 'pe-break', title: '쉬는 시간 면담', kind: 'once', date: TUE, start: '09:50', end: '10:00' })
    assert.deepEqual(day(UID.A, TUE, { personalEntries: [pe] }).conflicts, [])
  })
})

// ───────────────────────── 정렬 ─────────────────────────

describe('정렬', () => {
  test('R06·6장-10 정렬: 교시표가 있으면 실제 시각 순 — 개인 일정(교시만/시각만)도 같은 축에서', () => {
    const entries = [
      personal({ entryId: 'pe-noon', title: '점심 동아리', kind: 'weekly', weekday: 2, start: '12:10', end: '12:40' }),
      personal({ entryId: 'pe-p2', title: '자습', kind: 'weekly', weekday: 2, period: 2 }),
    ]
    const t = day(UID.A, TUE, { personalEntries: entries, series: [...ALL_SERIES].reverse() })
    assert.deepEqual(
      t.lessons.map((l) => l.key),
      [occ(SR.sciA_tue1, TUE), 'p:pe-p2', occ(SR.engB_tue3, TUE), 'p:pe-noon']
    )
    assert.deepEqual(t.conflicts, [])
  })

  test('R06 정렬: 교시표가 없으면 교시 번호 순(입력 순서 무관)', () => {
    const t = day(UID.A, TUE, { noPeriodTimes: true, series: [...ALL_SERIES].reverse() })
    assert.deepEqual(brief(t), [
      ['생활과 과학 A', 1],
      ['영어 B', 3],
    ])
  })

  test('R06·T16 변경된 차시는 바뀐 시각 기준으로 정렬(목 영어 B 2교시 → 08:10 1교시면 맨 앞)', () => {
    const t = day(UID.A, THU, { overrides: [reschedule('ov-sort', SR.engB_thu2, THU, { date: THU, period: 1, start: '08:10', end: '08:50' })] })
    assert.deepEqual(brief(t), [
      ['영어 B', 1],
      ['생활과 과학 A', 1],
    ])
  })
})

// ───────────────────────── day state ─────────────────────────

describe('day state', () => {
  test('R15·T34 day state 구분: lessons / no-lessons / holiday / no-courses', () => {
    assert.equal(day(UID.A, TUE).state, 'lessons')
    const wed = day(UID.A, WED)
    assert.equal(wed.state, 'no-lessons')
    assert.deepEqual(wed.lessons, [])
    assert.equal(day(UID.A, TUE, { offDay: { name: '재량휴업일' } }).state, 'holiday')
    const n = day(UID.N, TUE)
    assert.equal(n.state, 'no-courses')
    assert.deepEqual(n.activeCourseIds, [])
    assert.deepEqual(n.pendingCourseIds, [])
  })

  test('R15·T34 그 날 수업이 모두 취소·이동되면 no-lessons(holiday/no-courses 아님)이고 안내는 유지', () => {
    const overrides = [cancel('ov-st-c', SR.sciA_tue1, TUE), reschedule('ov-st-m', SR.engB_tue3, TUE, { date: WED, period: 1 })]
    const t = day(UID.A, TUE, { overrides })
    assert.equal(t.state, 'no-lessons')
    assert.deepEqual(t.lessons, [])
    assert.deepEqual(t.notices.map((n) => n.kind).sort(), ['cancelled', 'moved-out'])
    assert.equal(day(UID.A, WED, { overrides }).state, 'lessons')
  })
})

// ───────────────────────── T26 서버용 자원 충돌 ─────────────────────────

describe('T26 서버용 detectResourceConflicts (occurrencesForDates로 만든 최종 상태 기준)', () => {
  test('T26 기준선: 변경 없는 S1 화·목 시간표에는 충돌 없음(다른 날짜의 같은 교사·같은 교시는 충돌 아님)', () => {
    assert.deepEqual(conflictsAfter([], [TUE, THU]), [])
  })

  test('T26 교사 충돌: 교사 Y의 영어 C를 영어 B와 같은 화 3교시로 옮기면 teacher(uid) 충돌', () => {
    const cs = conflictsAfter([reschedule('ov-t26-teacher', SR.engC_tue2, TUE, { date: TUE, period: 3 })])
    assert.deepEqual(kindsOf(cs), ['teacher:uid:uid-Y'])
    assert.deepEqual([cs[0].a, cs[0].b].sort(), [occ(SR.engB_tue3, TUE), occ(SR.engC_tue2, TUE)].sort())
  })

  test('T26 교실 충돌: 생활과 과학 B를 영어 C가 쓰는 영어전용실로 같은 교시에 배정하면 room 충돌', () => {
    const cs = conflictsAfter([reschedule('ov-t26-room', SR.sciB_tue2, TUE, { date: TUE, period: 2, roomId: 'R-ENG', roomName: '영어전용실' })])
    assert.deepEqual(kindsOf(cs), ['room:R-ENG'])
  })

  test('T26·T25 학생 충돌: 학생 A가 함께 듣는 두 수업을 같은 시간에 두면 students 충돌(교사·교실은 다름)', () => {
    const cs = conflictsAfter([reschedule('ov-t26-stu', SR.sciA_tue1, TUE, { date: TUE, period: 3 })])
    assert.deepEqual(kindsOf(cs), ['students:1'])
  })

  test('T26·T17 정상 교시 교환(생활과 과학 A ↔ 영어 B)은 최종 상태 기준 통과, 중간 상태는 학생 충돌', () => {
    const swap = [
      reschedule('ov-sw-sci', SR.sciA_tue1, TUE, { date: TUE, period: 3 }, { changeSetId: 'cs-sw', revision: 2 }),
      reschedule('ov-sw-eng', SR.engB_tue3, TUE, { date: TUE, period: 1 }, { changeSetId: 'cs-sw', revision: 2 }),
    ]
    assert.deepEqual(conflictsAfter(swap), [])
    assert.deepEqual(kindsOf(conflictsAfter([swap[0]])), ['students:1'], '묶음 일부만 적용한 중간 상태는 충돌')
  })

  test('T26·T17 같은 교사 X의 두 수업 교환(과학 A 1교시 ↔ 과학 B 2교시)도 최종 상태 기준 통과', () => {
    const swap = [
      reschedule('ov-swx-a', SR.sciA_tue1, TUE, { date: TUE, period: 2 }, { changeSetId: 'cs-swx', revision: 2 }),
      reschedule('ov-swx-b', SR.sciB_tue2, TUE, { date: TUE, period: 1 }, { changeSetId: 'cs-swx', revision: 2 }),
    ]
    assert.deepEqual(conflictsAfter(swap), [])
    assert.deepEqual(kindsOf(conflictsAfter([swap[0]])), ['teacher:uid:uid-X'])
  })

  test('T26 교시 번호가 달라도 실제 시각(11:30~12:20 vs 3교시 11:00~11:50)이 겹치면 교사 충돌', () => {
    const cs = conflictsAfter([reschedule('ov-t26-time', SR.engC_tue2, TUE, { date: TUE, period: 4, start: '11:30', end: '12:20' })])
    assert.deepEqual(kindsOf(cs), ['teacher:uid:uid-Y'])
    assert.deepEqual(conflictsAfter([reschedule('ov-t26-time-ok', SR.engC_tue2, TUE, { date: TUE, period: 4 })]), [])
  })

  test('T26 공유 교실을 명시(sharedRooms)하면 교실 충돌만 제외되고 교사 충돌은 그대로', () => {
    const o = reschedule('ov-t26-shared', SR.engC_tue2, TUE, { date: TUE, period: 3, roomId: 'R35', roomName: '3학년 5반 교실' })
    assert.deepEqual(kindsOf(conflictsAfter([o])), ['room:R35', 'teacher:uid:uid-Y'])
    assert.deepEqual(kindsOf(conflictsAfter([o], [TUE], { sharedRooms: new Set(['R35']) })), ['teacher:uid:uid-Y'])
  })

  test('T26 계정이 연결되지 않은 교사는 표시 이름(공백·대소문자 정규화)으로, 교실도 이름으로 비교', () => {
    const occs: ScheduledOccurrence[] = [
      { key: `imp-1@${TUE}`, courseId: 'crs-imp-1', date: TUE, period: 5, teacherUids: [], teacherNames: ['교사 Q'], roomName: '시청각실' },
      { key: `imp-2@${TUE}`, courseId: 'crs-imp-2', date: TUE, period: 5, teacherUids: [], teacherNames: ['교사q'], roomName: '시청각 실' },
    ]
    assert.deepEqual(kindsOf(detectResourceConflicts(occs, { periodTimes: PERIOD_TIMES })), ['room:name:시청각실', 'teacher:name:교사q'])
  })

  test('T26 같은 수업의 두 차시를 같은 시간에 두는 잘못된 이동은 same-course로 검출', () => {
    const cs = conflictsAfter([reschedule('ov-t26-same', SR.engB_thu2, THU, { date: TUE, period: 3 })], [TUE, THU])
    assert.deepEqual(kindsOf(cs), ['students:same-course'])
  })

  test('T26·T20 취소된 차시는 충돌 대상이 아니고, 이동한 차시는 목적지 날짜에서만 검사', () => {
    const intoP3 = reschedule('ov-t26-into', SR.engC_tue2, TUE, { date: TUE, period: 3 })
    assert.deepEqual(conflictsAfter([intoP3, cancel('ov-t26-cancel', SR.engB_tue3, TUE)]), [])
    // 영어 B 화 3교시를 목 2교시(영어 B 목요일 기본 차시와 같은 시간)로 옮기면 목요일에서 same-course
    const toThu = reschedule('ov-t26-tothu', SR.engB_tue3, TUE, { date: THU, period: 2 })
    assert.deepEqual(conflictsAfter([toThu], [TUE]), [])
    assert.deepEqual(kindsOf(conflictsAfter([toThu], [THU])), ['students:same-course'])
  })

  test('T26·T33 학교 S2의 같은 이름 교사(교사 Y)·교실명(3학년 5반 교실)은 uid·roomId가 달라 충돌 아님', () => {
    const cs = conflictsAfter([], [TUE], { courses: ALL_COURSES, series: ALL_SERIES })
    assert.deepEqual(cs, [])
  })

  test('T26·T19 이름만 지정한 대체 교사(교사 Z, 계정 미연결) 변경 후, 원래 교사 Y의 같은 시간 다른 수업과 교사 충돌로 오인하지 않음', () => {
    const engCtoP3 = reschedule('ov-t26-y-busy', SR.engC_tue2, TUE, { date: TUE, period: 3 })
    // 대조군: 대체 교사를 uid로 지정하면 충돌 없음
    const subWithUid = reschedule('ov-t26-sub-uid', SR.engB_tue3, TUE, { date: TUE, period: 3, teacherUids: ['uid-Z'], teacherNames: ['교사 Z'] })
    assert.deepEqual(conflictsAfter([engCtoP3, subWithUid]), [])
    // 이름만 지정(가져온 교사 이름) — 영어 B 차시의 교사는 이제 교사 Z뿐
    const subNameOnly = reschedule('ov-t26-sub-name', SR.engB_tue3, TUE, { date: TUE, period: 3, teacherNames: ['교사 Z'] })
    const occs = occurrencesForDates([TUE], S1_COURSES, S1_SERIES, [engCtoP3, subNameOnly])
    const engB = only(occs.filter((o) => o.courseId === ENG_B.courseId), '영어 B 차시')
    assert.deepEqual(engB.teacherNames, ['교사 Z'])
    assert.ok(!(engB.teacherUids ?? []).includes('uid-Y'), `대체 후에도 원래 교사 uid가 남음: ${JSON.stringify(engB.teacherUids)}`)
    assert.deepEqual(conflictsAfter([engCtoP3, subNameOnly]), [])
  })
})

// ───────────────────────── validateSlot ─────────────────────────

describe('validateSlot (12-1 잘못된 교시·시각)', () => {
  test('T31·12-1 validateSlot: 정상 차시와 0교시는 오류 없음', () => {
    assert.deepEqual(validateSlot({ date: TUE, period: 3, start: '11:00', end: '11:50' }), [])
    assert.deepEqual(validateSlot({ date: TUE, period: 0 }), [])
    assert.deepEqual(validateSlot({ date: TUE, period: 7, start: '15:50' }), [])
  })

  test('T31·12-1 validateSlot: 잘못된 교시(음수·범위 초과·소수·NaN, maxPeriod 지정)', () => {
    for (const period of [-1, 11, 2.5, Number.NaN]) {
      const errs = validateSlot({ date: TUE, period })
      assert.equal(errs.length, 1, `period=${period}`)
      assert.match(errs[0], /교시/)
    }
    assert.deepEqual(validateSlot({ date: TUE, period: 7 }, { maxPeriod: 7 }), [])
    assert.match(validateSlot({ date: TUE, period: 8 }, { maxPeriod: 7 })[0], /0~7/)
  })

  test('T31·12-1 validateSlot: 끝<시작·끝=시작·시각 형식 오류·날짜 형식 오류', () => {
    assert.deepEqual(validateSlot({ date: TUE, period: 3, start: '11:50', end: '11:00' }), ['끝나는 시각이 시작 시각보다 늦어야 해요.'])
    assert.deepEqual(validateSlot({ date: TUE, period: 3, start: '11:00', end: '11:00' }), ['끝나는 시각이 시작 시각보다 늦어야 해요.'])
    assert.deepEqual(validateSlot({ date: TUE, period: 3, start: '25:00', end: '11:00' }), ['시각 형식이 올바르지 않아요(HH:MM).'])
    assert.deepEqual(validateSlot({ date: TUE, period: 3, start: '11:00', end: '11:5' }), ['시각 형식이 올바르지 않아요(HH:MM).'])
    assert.deepEqual(validateSlot({ date: '2026-10-06', period: 3 }), ['날짜 형식이 올바르지 않아요.'])
  })
})
