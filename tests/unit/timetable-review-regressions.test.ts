// 엔진 적대적 검토(D1~D16)에서 확인된 결함의 회귀 테스트 — 가상 데이터
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDayTimetable,
  detectResourceConflicts,
  occurrencesForDates,
  occurrenceKeyOf,
} from '../../src/lib/timetable/engine'
import type { Course, Enrollment, LessonSeries, Override, PeriodTime, StudentTimetableInput } from '../../src/lib/timetable/types'

const TUE = '20261006'
const WED = '20261007'
const THU = '20261008'
const PT: PeriodTime[] = [
  { period: 1, start: '09:00', end: '09:50' },
  { period: 2, start: '10:00', end: '10:50' },
  { period: 3, start: '11:00', end: '11:50' },
  { period: 4, start: '12:00', end: '12:50' },
  { period: 5, start: '13:50', end: '14:40' },
]
const course = (courseId: string, title: string, extra: Partial<Course> = {}): Course => ({
  courseId, schoolCode: 'S1', termId: 'T1', title, subject: title, teacherUids: [], teacherNames: [], status: 'active', commonForHomerooms: [], ...extra,
})
const ser = (seriesId: string, courseId: string, weekday: number, period: number, extra: Partial<LessonSeries> = {}): LessonSeries => ({
  seriesId, courseId, weekday: weekday as LessonSeries['weekday'], period, validFrom: '20260901', validTo: null, status: 'active', ...extra,
})
const enr = (uid: string, courseId: string): Enrollment => ({ uid, courseId, status: 'active', source: 'invite' })
let seq = 0
const ov = (o: Partial<Override> & Pick<Override, 'courseId' | 'occurrenceKey' | 'kind'>): Override => ({
  overrideId: `o${++seq}`, changeSetId: `cs${seq}`, revision: seq, status: 'published', ...o,
})

const SCI = course('sci', '생활과 과학 A', { teacherUids: ['uid-X'], teacherNames: ['교사 X'], defaultRoomId: 'R34', defaultRoomName: '3학년 4반 교실' })
const ENG = course('engB', '영어 B', { teacherUids: ['uid-Y'], teacherNames: ['교사 Y'], defaultRoomId: 'R35', defaultRoomName: '3학년 5반 교실' })
const ENGC = course('engC', '영어 C', { teacherUids: ['uid-Y'], teacherNames: ['교사 Y'], defaultRoomId: 'R36', defaultRoomName: '3학년 6반 교실' })

function day(date: string, opts: Partial<StudentTimetableInput> & { offDay?: { name: string } | null; term?: { startDate: string; endDate: string } | null } = {}) {
  return buildDayTimetable({
    uid: 'A',
    day: { date, offDay: opts.offDay ?? null, periodTimes: PT, term: opts.term ?? null },
    homerooms: [{ homeroomId: 'S1_3_4' }],
    enrollments: opts.enrollments ?? [enr('A', 'sci'), enr('A', 'engB')],
    courses: opts.courses ?? [SCI, ENG, ENGC],
    series: opts.series ?? [ser('s-sci', 'sci', 2, 1), ser('s-eng', 'engB', 2, 3, { start: '11:00', end: '11:50' })],
    overrides: opts.overrides ?? [],
    personalEntries: opts.personalEntries ?? [],
  })
}

describe('엔진 검토 회귀', () => {
  test('D1 교시를 옮기면 기본 차시의 명시 시각을 버리고 새 교시 시각을 따름', () => {
    const t = day(TUE, { overrides: [ov({ courseId: 'engB', occurrenceKey: occurrenceKeyOf('s-eng', TUE), kind: 'reschedule', target: { date: TUE, period: 2 } })] })
    const eng = t.lessons.find((l) => l.courseId === 'engB')!
    assert.equal(eng.period, 2)
    assert.equal(eng.start, null, '교시표(10:00)를 따르도록 시각을 비움')
    // 서버 충돌 검사도 새 시각 기준: 2교시의 영어 C(같은 교사 Y)와 충돌
    const occs = occurrencesForDates([TUE], [SCI, ENG, ENGC], [ser('s-eng', 'engB', 2, 3, { start: '11:00', end: '11:50' }), ser('s-engc', 'engC', 2, 2)], [
      ov({ courseId: 'engB', occurrenceKey: occurrenceKeyOf('s-eng', TUE), kind: 'reschedule', target: { date: TUE, period: 2 } }),
    ])
    assert.ok(detectResourceConflicts(occs, { periodTimes: PT }).some((c) => c.kind === 'teacher' && c.detail === 'uid:uid-Y'))
  })

  test('D2 보강 차시를 다른 날로 옮기면 교실·교사를 유지하고, 원래 날에는 옮겨 감 안내', () => {
    const mk = 'mk:m1'
    const overrides = [
      ov({ courseId: 'engB', occurrenceKey: mk, kind: 'makeup', target: { date: WED, period: 5, roomName: '과학실', teacherNames: ['교사 Y'], teacherUids: ['uid-Y'] } }),
      ov({ courseId: 'engB', occurrenceKey: mk, kind: 'reschedule', target: { date: THU, period: 4 } }),
    ]
    const thu = day(THU, { overrides })
    const l = thu.lessons.find((x) => x.key === mk)!
    assert.equal(l.roomName, '과학실')
    assert.deepEqual(l.teacherNames, ['교사 Y'])
    assert.equal(l.change?.kind, 'makeup')
    assert.ok(l.change?.fields.includes('date'))
    const wed = day(WED, { overrides })
    assert.ok(wed.notices.some((n) => n.kind === 'moved-out' && n.makeup))
    // 보강 취소 → 수요일에 취소 안내
    const cancelled = day(WED, { overrides: [overrides[0], ov({ courseId: 'engB', occurrenceKey: mk, kind: 'cancel' })] })
    assert.ok(cancelled.notices.some((n) => n.kind === 'cancelled' && n.makeup))
    assert.equal(cancelled.lessons.filter((x) => x.key === mk).length, 0)
  })

  test('D3 쉬는 날: 차이 없는 변경·교실만 바꾼 변경은 숨기고 holiday-suppressed 안내, 교시를 옮긴 변경은 표시', () => {
    const key = occurrenceKeyOf('s-sci', TUE)
    const off = { name: '재량휴업일' }
    const same = day(TUE, { offDay: off, overrides: [ov({ courseId: 'sci', occurrenceKey: key, kind: 'reschedule', target: { date: TUE, period: 1 } })] })
    assert.equal(same.lessons.length, 0)
    assert.equal(same.state, 'holiday')
    assert.ok(same.notices.some((n) => n.kind === 'holiday-suppressed'))
    const roomOnly = day(TUE, { offDay: off, overrides: [ov({ courseId: 'sci', occurrenceKey: key, kind: 'reschedule', target: { date: TUE, period: 1, roomName: '강당' } })] })
    assert.equal(roomOnly.lessons.length, 0)
    const moved = day(TUE, { offDay: off, overrides: [ov({ courseId: 'sci', occurrenceKey: key, kind: 'reschedule', target: { date: TUE, period: 4 } })] })
    assert.equal(moved.lessons.length, 1)
  })

  test('D4 occurrencesForDates는 쉬는 날 기본 차시를 열지 않음(학생 화면과 같은 규칙)', () => {
    const series = [ser('s-eng', 'engB', 2, 3, { roomId: 'R35' })]
    const makeup = ov({ courseId: 'sci', occurrenceKey: 'mk:x', kind: 'makeup', target: { date: TUE, period: 3, roomId: 'R35' } })
    const withOff = occurrencesForDates([TUE], [SCI, ENG], series, [makeup], { offDays: new Set([TUE]) })
    assert.deepEqual(detectResourceConflicts(withOff, { periodTimes: PT }).filter((c) => c.kind === 'room'), [])
    const noOff = occurrencesForDates([TUE], [SCI, ENG], series, [makeup])
    assert.equal(detectResourceConflicts(noOff, { periodTimes: PT }).filter((c) => c.kind === 'room').length, 1)
  })

  test('D5·D15 정렬·안내 순서가 입력 순서와 무관(전순서)', () => {
    const series = [ser('s-sci', 'sci', 2, 1), ser('s-eng6', 'engB', 2, 6)]
    const pe = [{ entryId: 'p1', title: '아침 자습', kind: 'once' as const, date: TUE, start: '07:30' }]
    const a = day(TUE, { series, personalEntries: pe }).lessons.map((l) => l.title)
    const b = day(TUE, { series: [...series].reverse(), personalEntries: pe }).lessons.map((l) => l.title)
    assert.deepEqual(a, b)
    assert.deepEqual(a, ['아침 자습', '생활과 과학 A', '영어 B'])
  })

  test('D6 한쪽만 uid가 있어도 같은 이름 교사·같은 이름 교실은 가능 충돌로 검출', () => {
    const c = detectResourceConflicts([
      { key: 'a', courseId: 'engB', date: TUE, period: 3, teacherUids: ['uid-Y'], teacherNames: ['교사 Y'], roomId: 'R35', roomName: '3학년 5반 교실' },
      { key: 'b', courseId: 'engC', date: TUE, period: 3, teacherNames: ['교사Y'], roomName: '3학년 5반 교실' },
    ])
    assert.ok(c.some((x) => x.kind === 'teacher' && x.possible))
    assert.ok(c.some((x) => x.kind === 'room' && x.possible))
    // 둘 다 uid가 있고 다르면 이름이 같아도 충돌 아님(동명이인)
    const d = detectResourceConflicts([
      { key: 'a', courseId: 'engB', date: TUE, period: 3, teacherUids: ['uid-Y'], teacherNames: ['김민수'] },
      { key: 'b', courseId: 'engC', date: TUE, period: 3, teacherUids: ['uid-Z'], teacherNames: ['김민수'] },
    ])
    assert.equal(d.filter((x) => x.kind === 'teacher').length, 0)
  })

  test('D7 다른 수업의 변경이 같은 차시 키를 가리켜도 섞이지 않음', () => {
    const key = occurrenceKeyOf('s-eng', TUE)
    const t = day(TUE, { overrides: [ov({ courseId: 'engC', occurrenceKey: key, kind: 'cancel', revision: 99 })] })
    assert.ok(t.lessons.some((l) => l.courseId === 'engB'), '영어 B는 그대로')
    assert.equal(t.notices.filter((n) => n.kind === 'cancelled').length, 0)
  })

  test('D8 교환 묶음 중 학생이 보는 수업의 한쪽이 빠지면 묶음 전체를 적용하지 않고 보고', () => {
    const k1 = occurrenceKeyOf('s-sci', TUE)
    const k2 = occurrenceKeyOf('s-eng', TUE)
    const keys = [`sci|${k1}`, `engB|${k2}`]
    const half = [ov({ courseId: 'sci', occurrenceKey: k1, kind: 'reschedule', target: { date: TUE, period: 3 }, changeSetId: 'swap1', changeSetKeys: keys, revision: 50 })]
    const t = day(TUE, { overrides: half })
    assert.deepEqual(t.incompleteChangeSets, ['swap1'])
    assert.equal(t.lessons.find((l) => l.courseId === 'sci')!.period, 1, '중간 상태(3교시 겹침) 노출 안 함')
    // 학생이 보지 않는 수업의 키만 빠진 경우는 정상 적용
    const other = [ov({ courseId: 'sci', occurrenceKey: k1, kind: 'reschedule', target: { date: TUE, period: 3 }, changeSetId: 'swap2', changeSetKeys: [`sci|${k1}`, `zzz|x@${TUE}`], revision: 51 })]
    assert.deepEqual(day(TUE, { overrides: other, series: [ser('s-sci', 'sci', 2, 1)] }).incompleteChangeSets, [])
  })

  test('D11 목표가 없는 잘못된 이동 변경은 기본 차시를 보이고 검토 대상으로', () => {
    const t = day(TUE, { overrides: [ov({ courseId: 'sci', occurrenceKey: occurrenceKeyOf('s-sci', TUE), kind: 'reschedule', target: null })] })
    assert.ok(t.lessons.some((l) => l.courseId === 'sci'))
    assert.equal(t.orphanOverrides.length, 1)
  })

  test('D12 orphan 판정은 키에서 원래 날짜를 읽음(originalDate 필드가 비어도)', () => {
    const t = day(TUE, { overrides: [ov({ courseId: 'sci', occurrenceKey: `gone@${TUE}`, kind: 'cancel', originalDate: null })] })
    assert.equal(t.orphanOverrides.length, 1)
  })

  test('D13 같은 교실을 이름으로 다시 고르면 교실 변경으로 강조하지 않음', () => {
    const t = day(TUE, {
      series: [ser('s-eng', 'engB', 2, 3, { roomId: 'R35', roomName: '3학년 5반 교실' })],
      overrides: [ov({ courseId: 'engB', occurrenceKey: occurrenceKeyOf('s-eng', TUE), kind: 'reschedule', target: { date: TUE, period: 3, roomId: null, roomName: '3학년 5반 교실' } })],
    })
    assert.equal(t.lessons.find((l) => l.courseId === 'engB')!.change, null)
  })

  test('D14 연결된 개인 일정 메모는 같은 교시 차시에만', () => {
    const t = day(TUE, {
      series: [ser('s-eng3', 'engB', 2, 3), ser('s-eng5', 'engB', 2, 5)],
      personalEntries: [{ entryId: 'p', title: '영어', kind: 'weekly', weekday: 2, period: 5, memo: '단어 시험', linkedCourseId: 'engB', pendingSync: true }],
    })
    const p3 = t.lessons.find((l) => l.period === 3)!
    const p5 = t.lessons.find((l) => l.period === 5)!
    assert.equal(p3.memo, undefined)
    assert.equal(p5.memo, '단어 시험')
    assert.equal(p5.pendingSync, true)
  })

  test('D16 시작 시각만 있는 개인 일정도 겹침 검사', () => {
    const t = day(TUE, { personalEntries: [{ entryId: 'p', title: '상담', kind: 'once', date: TUE, start: '09:10' }] })
    assert.equal(t.conflicts.filter((c) => c.kind === 'personal').length, 1)
  })

  test('E5 학기 밖·시간표 미등록은 정상 무수업과 구분', () => {
    assert.equal(day('20260825', { term: { startDate: '20260901', endDate: '20270301' } }).state, 'outside-term')
    const noSeries = day(TUE, { series: [] })
    assert.equal(noSeries.state, 'not-registered')
    assert.deepEqual(noSeries.coursesWithoutSchedule, ['engB', 'sci'])
    // 일부만 미등록: 수업은 있고 미등록 목록으로 안내
    const partial = day(TUE, { series: [ser('s-sci', 'sci', 2, 1)] })
    assert.equal(partial.state, 'lessons')
    assert.deepEqual(partial.coursesWithoutSchedule, ['engB'])
    // 주말(기본 시간표는 있음)은 정상 무수업
    assert.equal(day('20261010').state, 'no-lessons')
  })
})
