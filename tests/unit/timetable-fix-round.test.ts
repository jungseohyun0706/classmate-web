// 독립 검토에서 실제 결함으로 확인된 항목의 회귀 테스트 — 가상 데이터
// [0] 끝낸 수강의 지난 날짜 표시, [2] 지난 학기·차시가 모두 끝난 수업, [4][6] 수강하지 않는 학생의 보강 취소·이동 안내
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDayTimetable, clipSeriesToTerm, resolveCourses, scopeCoursesToTerms, seriesAllEndedBy } from '../../src/lib/timetable/engine'
import type { Course, Enrollment, LessonSeries, Override, PeriodTime, PersonalEntry, StudentTimetableInput } from '../../src/lib/timetable/types'

const PREV_TUE = '20260929'
const SAT = '20261003'
const TUE = '20261006'
const WED = '20261007'
const THU = '20261008'
const PT: PeriodTime[] = [
  { period: 1, start: '09:00', end: '09:50' },
  { period: 2, start: '10:00', end: '10:50' },
  { period: 3, start: '11:00', end: '11:50' },
  { period: 4, start: '12:00', end: '12:50' },
  { period: 5, start: '13:50', end: '14:40' },
  { period: 6, start: '14:50', end: '15:40' },
  { period: 7, start: '15:50', end: '16:40' },
]
const course = (courseId: string, title: string, extra: Partial<Course> = {}): Course => ({
  courseId, schoolCode: 'S1', termId: '', title, subject: title, teacherUids: [], teacherNames: [], status: 'active', commonForHomerooms: [], ...extra,
})
const ser = (seriesId: string, courseId: string, weekday: number, period: number, extra: Partial<LessonSeries> = {}): LessonSeries => ({
  seriesId, courseId, weekday: weekday as LessonSeries['weekday'], period, validFrom: '20260901', validTo: null, status: 'active', ...extra,
})
const enr = (courseId: string, extra: Partial<Enrollment> = {}): Enrollment => ({ uid: 'A', courseId, status: 'active', source: 'invite', ...extra })
let seq = 0
const ov = (o: Partial<Override> & Pick<Override, 'courseId' | 'occurrenceKey' | 'kind'>): Override => ({
  overrideId: `o${++seq}`, changeSetId: `cs${seq}`, revision: seq, status: 'published', ...o,
})

const ENG = course('engB', '영어 B')
const ENG_SERIES = [ser('s-eng', 'engB', 2, 3)]

function day(date: string, opts: Partial<StudentTimetableInput> = {}) {
  return buildDayTimetable({
    uid: 'A',
    day: { date, offDay: null, periodTimes: PT, term: null },
    homerooms: opts.homerooms ?? [],
    enrollments: opts.enrollments ?? [enr('engB')],
    courses: opts.courses ?? [ENG],
    series: opts.series ?? ENG_SERIES,
    overrides: opts.overrides ?? [],
    personalEntries: opts.personalEntries ?? [],
  })
}

describe('[0] 끝낸 수강은 [from, to) 지난 날짜에 그대로', () => {
  // 9/1부터 듣다가 10/3(토)에 선생님이 수강 종료 → enrollments end가 { status:'ended', to: 오늘 } 저장
  const ended = enr('engB', { status: 'ended', from: '20260901', to: SAT })

  test('종료 전 화요일(9/29)에는 영어 B가 보이고, 종료 뒤 화요일(10/6)에는 없음', () => {
    const past = day(PREV_TUE, { enrollments: [ended] })
    assert.deepEqual(past.lessons.map((l) => l.courseId), ['engB'])
    assert.equal(past.state, 'lessons')
    assert.deepEqual(past.activeCourseIds, ['engB'])
    const after = day(TUE, { enrollments: [ended] })
    assert.equal(after.lessons.length, 0)
    assert.equal(after.state, 'no-courses')
    // 시작일 전은 여전히 밖
    assert.equal(day('20260825', { enrollments: [ended] }).lessons.length, 0)
  })

  test('거절(rejected)·승인 대기에서 끝낸 수강(to 없음)은 어느 날짜에도 보이지 않음', () => {
    const rejected = enr('engB', { status: 'ended', from: null, to: null, rejected: true })
    const pendingEnded = enr('engB', { status: 'ended', from: null, to: null })
    // 방어: to가 있어도 거절 표시면 들은 기간이 아님
    const rejectedWithTo = enr('engB', { status: 'ended', from: '20260901', to: SAT, rejected: true })
    for (const e of [rejected, pendingEnded, rejectedWithTo]) {
      const t = day(PREV_TUE, { enrollments: [e] })
      assert.equal(t.lessons.length, 0, JSON.stringify(e))
      assert.deepEqual(t.activeCourseIds, [])
      assert.deepEqual(t.pendingCourseIds, [])
    }
  })

  test('resolveCourses(내 수업 목록·연결 후보 계산)도 같은 기간 규칙', () => {
    const input = { uid: 'A', homerooms: [], enrollments: [ended], courses: [ENG] }
    assert.equal(resolveCourses(input, PREV_TUE).active.get('engB'), 'enrolled')
    assert.equal(resolveCourses(input, SAT).active.has('engB'), false, 'to는 미포함')
  })
})

describe('[2] 지난 학기 수업·차시가 모두 끝난 수업', () => {
  test('같은 학기에 학급 시간표를 다시 만들어 옛 공통 수업의 차시만 닫혀도 미등록 오탐·연결 일정 숨김이 없음', () => {
    const old = course('hcOld', '수학(김)', { commonForHomerooms: ['S1_3_4'] })
    const neu = course('hcNew', '수학(이)', { commonForHomerooms: ['S1_3_4'] })
    const series = [
      ser('s-old', 'hcOld', 2, 2, { validTo: '20261005', status: 'retired' }),
      ser('s-new', 'hcNew', 2, 2, { validFrom: '20261005' }),
    ]
    const pe: PersonalEntry[] = [{ entryId: 'p1', title: '수학 보충', kind: 'weekly', weekday: 2, period: 6, linkedCourseId: 'hcOld' }]
    const opts = { enrollments: [], courses: [old, neu], series, homerooms: [{ homeroomId: 'S1_3_4' }], personalEntries: pe }
    const after = day(TUE, opts)
    assert.deepEqual(after.coursesWithoutSchedule, [], "'일부 수업 시간표가 아직 없어요' 오탐 없음")
    assert.deepEqual(after.activeCourseIds, ['hcNew'])
    assert.deepEqual(after.lessons.map((l) => l.key).sort(), ['p:p1', `s-new@${TUE}`], '연결된 개인 일정이 그대로 보임')
    // 차시가 열려 있던 날에는 기존처럼 공식 수업으로 대체
    const before = day(PREV_TUE, opts)
    assert.deepEqual(before.lessons.map((l) => l.key), [`s-old@${PREV_TUE}`])
    assert.ok(before.activeCourseIds.includes('hcOld'))
    assert.ok(!before.coursesWithoutSchedule.includes('hcOld'))
  })

  test('차시가 모두 끝난 수업에 보강이 있는 날은 보강을 보이고 미등록으로 보지 않음', () => {
    const series = [ser('s-eng', 'engB', 2, 3, { validTo: '20261001' })]
    const mk = ov({ courseId: 'engB', occurrenceKey: 'mk:late', kind: 'makeup', target: { date: TUE, period: 5 } })
    const t = day(TUE, { series, overrides: [mk] })
    assert.deepEqual(t.lessons.map((l) => l.key), ['mk:late'])
    assert.deepEqual(t.activeCourseIds, ['engB'])
    assert.deepEqual(t.coursesWithoutSchedule, [])
    // 보강이 없는 날: 운영 중인 수업이 없음(시간표 미등록 아님)
    const plain = day(WED, { series })
    assert.deepEqual(plain.activeCourseIds, [])
    assert.equal(plain.state, 'no-courses')
  })

  test('차시가 없거나 아직 시작 전인 수업은 그대로 시간표 미등록', () => {
    assert.equal(seriesAllEndedBy('engB', [], TUE), false)
    assert.equal(day(TUE, { series: [] }).state, 'not-registered')
    const future = [ser('s-eng', 'engB', 2, 3, { validFrom: '20261101' })]
    assert.equal(seriesAllEndedBy('engB', future, TUE), false)
    assert.deepEqual(day(TUE, { series: future }).coursesWithoutSchedule, ['engB'])
    // 삭제된 차시(종료일 없는 retired)만 있으면 끝난 것이 아니라 미등록
    assert.equal(seriesAllEndedBy('engB', [ser('s-del', 'engB', 2, 3, { status: 'retired', validTo: null })], TUE), false)
  })

  // 학교 학기(studentData.termRangeOf가 학기 문서에서 읽는 값): 1학기 [0302, 0720), 2학기 [0817, 0227)
  const TERMS: Record<string, { startDate: string; endDate: string }> = {
    '2026-1': { startDate: '20260302', endDate: '20260720' },
    '2026-2': { startDate: '20260817', endDate: '20270227' },
  }
  const H = 'S1_3_4'
  const hc1 = course('hc1', '국어', { termId: '2026-1', commonForHomerooms: [H] })
  const hc2 = course('hc2', '국어', { termId: '2026-2', commonForHomerooms: [H] })
  const art = course('art1', '미술 A', { termId: '2026-1' }) // 1학기 개별 수강(수강 문서는 종료하지 않음)
  const rangeOf = (cs: Course[]) => new Map(cs.map((c) => [c.courseId, TERMS[c.termId] ?? null] as const))

  test('scopeCoursesToTerms: 학기 종료일을 수업 종료일로, 조회 기간 전에 끝난 공통 수업은 뺌(개별 수강은 유지)', () => {
    const all = [hc1, hc2, art, course('free', '자율', { termId: '' })]
    const scoped = scopeCoursesToTerms(all, rangeOf(all), new Set(['art1']), '20261005')
    assert.deepEqual(scoped.map((c) => c.courseId), ['hc2', 'art1', 'free'])
    assert.equal(scoped.find((c) => c.courseId === 'art1')!.endedOn, '20260720')
    assert.equal(scoped.find((c) => c.courseId === 'hc2')!.endedOn, '20270227')
    assert.equal(scoped.find((c) => c.courseId === 'free')!.endedOn, undefined, '학기를 모르는 수업은 그대로')
    // 조회 기간이 1학기에 걸치면 공통 수업도 남음(지난 날짜 표시)
    const past = scopeCoursesToTerms(all, rangeOf(all), new Set(), '20260713')
    assert.ok(past.some((c) => c.courseId === 'hc1'))
    // 더 이른 종료일은 유지, 종료일 없이 끝난 수업은 되살리지 않음
    const early = course('e', '조기 종료', { termId: '2026-2', endedOn: '20261001' })
    const endedNoDate = course('x', '종료', { termId: '2026-2', status: 'ended', endedOn: null })
    const s2 = scopeCoursesToTerms([early, endedNoDate], rangeOf([early, endedNoDate]), new Set(['e', 'x']), '20261005')
    assert.equal(s2[0].endedOn, '20261001')
    assert.equal(s2[1].endedOn, null)
    assert.equal(resolveCourses({ uid: 'A', homerooms: [], enrollments: [enr('x')], courses: s2 }, '20260901').active.has('x'), false)
  })

  test('2학기에 지난 학기 수업이 운영 중으로 남지 않음: 미등록 경고 없음 + 연결 개인 일정 보임', () => {
    const all = [hc1, hc2, art]
    const ranges = rangeOf(all)
    // 이전 조회 창(1학기 마지막 주 포함)에서 받은 자료여도 같은 결과여야 함
    const courses = scopeCoursesToTerms(all, ranges, new Set(['art1']), '20260713')
    const rawSeries = [
      ser('s-hc1', 'hc1', 2, 1, { validFrom: '20260302' }),
      ser('s-hc2', 'hc2', 2, 1, { validFrom: '20260817' }),
      ser('s-art', 'art1', 2, 4, { validFrom: '20260302' }),
    ]
    const series = rawSeries.map((s) => clipSeriesToTerm(s, ranges.get(s.courseId) ?? null))
    const pe: PersonalEntry[] = [{ entryId: 'p-art', title: '미술 실기', kind: 'weekly', weekday: 2, period: 4, linkedCourseId: 'art1' }]
    const input = { enrollments: [enr('art1', { from: '20260302' })], courses, series, homerooms: [{ homeroomId: H }], personalEntries: pe }
    const t = day(TUE, input)
    assert.deepEqual(t.activeCourseIds, ['hc2'])
    assert.deepEqual(t.coursesWithoutSchedule, [])
    assert.deepEqual(t.lessons.map((l) => l.key), [`s-hc2@${TUE}`, 'p:p-art'])
    // 1학기 날짜에는 지난 수업이 공식 수업으로 보이고 개인 일정은 대체됨
    const july = day('20260714', input)
    assert.deepEqual(july.lessons.map((l) => l.courseId), ['hc1', 'art1'])
  })
})

describe('[4][6] 수강하지 않는 학생에게 보강 취소·이동 안내를 보이지 않음', () => {
  const mk = 'mk:m-0'
  const makeup = ov({ courseId: 'engC', occurrenceKey: mk, kind: 'makeup', target: { date: WED, period: 7 } })
  const cancel = ov({ courseId: 'engC', occurrenceKey: mk, kind: 'cancel' })
  const moved = ov({ courseId: 'engC', occurrenceKey: mk, kind: 'reschedule', target: { date: THU, period: 6 } })
  const ENGC = course('engC', '영어 C')
  const base = { courses: [ENG, ENGC], series: ENG_SERIES }
  const notRelated: Array<[string, Enrollment]> = [
    ['승인 대기', enr('engC', { status: 'pending', from: null, to: null })],
    ['끝낸 수강', enr('engC', { status: 'ended', from: '20260901', to: SAT })],
    ['기간이 지난 active 수강', enr('engC', { from: '20260901', to: '20261005' })],
    ['거절', enr('engC', { status: 'ended', from: null, to: null, rejected: true })],
  ]

  for (const [label, e] of notRelated) {
    test(`${label}: 보강 취소·이동 안내 없음, 옮겨 간 날에도 수업 없음`, () => {
      const enrollments = [enr('engB'), e]
      const c = day(WED, { ...base, enrollments, overrides: [makeup, cancel] })
      assert.deepEqual(c.notices, [])
      assert.deepEqual(c.orphanOverrides, [])
      const m = day(WED, { ...base, enrollments, overrides: [makeup, moved] })
      assert.deepEqual(m.notices, [])
      assert.equal(day(THU, { ...base, enrollments, overrides: [makeup, moved] }).lessons.some((l) => l.key === mk), false)
    })
  }

  test('수강 중인 학생은 그대로 보강 취소·옮겨 감 안내(makeup 표시)', () => {
    const enrollments = [enr('engB'), enr('engC')]
    const c = day(WED, { ...base, enrollments, overrides: [makeup, cancel] })
    assert.deepEqual(c.notices.map((n) => [n.kind, n.key, n.makeup]), [['cancelled', mk, true]])
    const m = day(WED, { ...base, enrollments, overrides: [makeup, moved] })
    assert.deepEqual(m.notices.map((n) => [n.kind, n.key, n.makeup, n.movedTo?.date]), [['moved-out', mk, true, THU]])
    const thu = day(THU, { ...base, enrollments, overrides: [makeup, moved] })
    assert.deepEqual(thu.lessons.filter((l) => l.key === mk).map((l) => l.period), [6])
  })
})
