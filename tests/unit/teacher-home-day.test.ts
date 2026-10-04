/**
 * 교사 '내 시간표' — 날짜별 기본 목록 고르기(buildTeacherDay)·주간 시간표·교환/보결 겹치기·상태 단위 테스트
 *
 * 가상 데이터(실제 교사·학생 정보 아님). 날짜: 2026-10-05(월) MON, 10-06(화) TUE, 10-09(금) FRI, 10-10(토) SAT
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTeacherDay,
  computeTeacherOfficialDay,
  coveredByText,
  coveringTitle,
  legacyCellsOn,
  normalizeMySchedule,
  normalizeTeacherPayload,
  parseScheduleCell,
  rowBadges,
  weekdayKeyOf,
  type MySchedule,
  type TeacherCover,
  type TeacherOfficialDay,
  type TeacherTimetablePayload,
} from '../../src/lib/timetable/teacherDay'
import type { Course, LessonSeries, Override, Ymd } from '../../src/lib/timetable/types'

const MON: Ymd = '20261005'
const TUE: Ymd = '20261006'
const WED: Ymd = '20261007'
const FRI: Ymd = '20261009'
const SAT: Ymd = '20261010'
const ME = 'tme'
const TERMS = [{ termId: '2026-2', name: '2026학년도 2학기', startDate: '20260816', endDate: '20261220', isDefault: false }]
const PERIOD_TIMES = [1, 2, 3, 4, 5, 6, 7].map((p) => ({ period: p, start: `${String(8 + p).padStart(2, '0')}:00`, end: `${String(8 + p).padStart(2, '0')}:50` }))

const engB: Course = {
  courseId: 'engB', schoolCode: 'S1', termId: '2026-2', title: '영어 B', subject: '영어', section: 'B',
  teacherUids: [ME], teacherNames: ['이영어'], status: 'active', endedOn: null, commonForHomerooms: [], defaultRoomName: '3학년 5반 교실',
}
const sciA: Course = { ...engB, courseId: 'sciA', title: '생활과 과학 A', subject: '생활과 과학', section: 'A', teacherUids: ['tx'], teacherNames: ['김과학'], defaultRoomName: '과학실' }
const SERIES: LessonSeries[] = [
  { seriesId: 'sr_engB_tue3', courseId: 'engB', weekday: 2, period: 3, validFrom: '20260816', validTo: null, status: 'active' },
  { seriesId: 'sr_sciA_tue4', courseId: 'sciA', weekday: 2, period: 4, validFrom: '20260816', validTo: null, status: 'active' },
]
const subTo = (date: Ymd): Override => ({
  overrideId: 'o-sub', courseId: 'sciA', occurrenceKey: `sr_sciA_tue4@${date}`, changeSetId: 'cs-sub', kind: 'reschedule',
  seriesId: 'sr_sciA_tue4', originalDate: date, target: { date, period: 4, teacherUids: [ME], teacherNames: ['이영어'] }, revision: 1, status: 'published',
})

const SCHEDULE: MySchedule = {
  mon: ['1-5 국어', '', '3-2 국어', '', '', '', ''],
  tue: ['', '2-1 문학', '', '', '', '', ''],
  wed: ['', '', '', '', '', '', ''],
  thu: ['', '', '', '', '', '', ''],
  fri: ['동아리', '', '', '', '', '', ''],
}

function official(date: Ymd, courses: Course[], overrides: Override[] = [], offDay: { name: string } | null = null): TeacherOfficialDay {
  return computeTeacherOfficialDay({ uid: ME, date, term: { startDate: '20260816', endDate: '20261220' }, offDay, periodTimes: PERIOD_TIMES, courses, series: SERIES, overrides })
}

function payload(p: Partial<TeacherTimetablePayload> = {}): TeacherTimetablePayload {
  return {
    revision: 1, generatedAt: 0, schoolCode: 'S1', from: '20261001', to: '20261021',
    terms: TERMS, offDays: {}, calendarErrors: [], periodTimes: PERIOD_TIMES, days: {}, mySchedule: null, covers: [], ...p,
  }
}

const cover = (c: Partial<TeacherCover>): TeacherCover => ({
  id: 'swap:x', kind: 'swap', direction: 'covered', date: MON, period: 1, subject: '1-5 국어', requesterClass: '3학년 2반', otherName: '김동료', ...c,
})

describe('주간 시간표(users.mySchedule)', () => {
  test('요일 키: 월~금만, 주말은 null', () => {
    assert.deepEqual([MON, TUE, WED, '20261008', FRI].map(weekdayKeyOf), ['mon', 'tue', 'wed', 'thu', 'fri'])
    assert.equal(weekdayKeyOf(SAT), null)
    assert.equal(weekdayKeyOf('20261011'), null)
  })

  test('그 요일 칸(빈 칸 제외, 교시 = 칸 위치 + 1)', () => {
    assert.deepEqual(legacyCellsOn(SCHEDULE, MON), [
      { period: 1, text: '1-5 국어' },
      { period: 3, text: '3-2 국어' },
    ])
    assert.deepEqual(legacyCellsOn(SCHEDULE, TUE), [{ period: 2, text: '2-1 문학' }])
    assert.deepEqual(legacyCellsOn(SCHEDULE, SAT), [])
    assert.deepEqual(legacyCellsOn(null, MON), [])
  })

  test('정규화: 7칸 맞춤·공백 정리, 모두 비었거나 모양이 아니면 null', () => {
    const n = normalizeMySchedule({ mon: ['  1-5   국어 ', 3, null], tue: 'x' })!
    assert.deepEqual(n.mon, ['1-5 국어', '', '', '', '', '', ''])
    assert.deepEqual(n.tue, ['', '', '', '', '', '', ''])
    assert.equal(normalizeMySchedule({ mon: ['', ''], fri: [' '] }), null)
    assert.equal(normalizeMySchedule('nope'), null)
    assert.equal(normalizeMySchedule(null), null)
  })

  test('칸 문구: 학반 라벨 → 학급 표시 + 과목', () => {
    assert.deepEqual(parseScheduleCell('1-5 국어'), { title: '국어', classLabel: '1학년 5반' })
    assert.deepEqual(parseScheduleCell('3-12'), { title: '3학년 12반 수업', classLabel: '3학년 12반' })
    assert.deepEqual(parseScheduleCell('동아리'), { title: '동아리', classLabel: null })
  })
})

describe('기본 목록 고르기', () => {
  test('공식 수업이 있으면 공식 방식 — 주간 시간표는 접힌 참고로만', () => {
    const v = buildTeacherDay(payload({ days: { [TUE]: official(TUE, [engB, sciA]) }, mySchedule: SCHEDULE }), TUE)
    assert.equal(v.mode, 'official')
    assert.equal(v.state, 'lessons')
    assert.deepEqual(v.rows.map((r) => [r.kind, r.lesson.period, r.lesson.title]), [['official', 3, '영어 B']])
    assert.deepEqual(v.legacyReference, [{ period: 2, text: '2-1 문학' }])
    assert.equal(v.rows[0].manageable, true)
  })

  test('공식 수업이 없고 주간 시간표가 있으면 그 요일 칸(직접 등록 행)', () => {
    const v = buildTeacherDay(payload({ days: { [MON]: official(MON, []) }, mySchedule: SCHEDULE }), MON)
    assert.equal(v.mode, 'legacy')
    assert.deepEqual(v.rows.map((r) => [r.kind, r.lesson.period, r.lesson.title, r.classLabel, r.lesson.source]), [
      ['legacy', 1, '국어', '1학년 5반', 'personal'],
      ['legacy', 3, '국어', '3학년 2반', 'personal'],
    ])
    assert.deepEqual(v.legacyReference, [])
  })

  test('둘 다 없으면 빈 상태(not-registered)', () => {
    const v = buildTeacherDay(payload({ days: { [MON]: official(MON, []) } }), MON)
    assert.equal(v.mode, 'empty')
    assert.equal(v.state, 'not-registered')
    assert.deepEqual(v.rows, [])
  })

  test('주간 시간표 방식에도 변경으로 나에게 넘어온 공식 수업은 보임', () => {
    const v = buildTeacherDay(payload({ days: { [TUE]: official(TUE, [sciA], [subTo(TUE)]) }, mySchedule: SCHEDULE }), TUE)
    assert.equal(v.mode, 'legacy')
    assert.deepEqual(v.rows.map((r) => [r.kind, r.lesson.period, r.role]), [
      ['legacy', 2, null],
      ['official', 4, 'substitute'],
    ])
    assert.deepEqual(rowBadges(v.rows[1]).map((b) => b.label), ['대신 들어가는 수업'])
  })

  test('공식 방식 주말: 수업 없음(no-lessons) — 주간 시간표를 꺼내 보이지 않음', () => {
    const v = buildTeacherDay(payload({ days: { [SAT]: official(SAT, [engB]) }, mySchedule: SCHEDULE }), SAT)
    assert.equal(v.mode, 'official')
    assert.equal(v.state, 'no-lessons')
    assert.deepEqual(v.legacyReference, [])
  })

  test('주간 시간표 방식 주말도 no-lessons', () => {
    const v = buildTeacherDay(payload({ days: { [SAT]: official(SAT, []) }, mySchedule: SCHEDULE }), SAT)
    assert.equal(v.state, 'no-lessons')
  })
})

describe('쉬는 날·학기 밖', () => {
  test('쉬는 날: 공식 방식은 holiday + 열리지 않는 내 수업 안내', () => {
    const off = { name: '재량휴업일' }
    const v = buildTeacherDay(payload({ days: { [TUE]: official(TUE, [engB], [], off) }, offDays: { [TUE]: off } }), TUE)
    assert.equal(v.state, 'holiday')
    assert.equal(v.offDayName, '재량휴업일')
    assert.deepEqual(v.suppressed.map((n) => n.courseId), ['engB'])
  })

  test('쉬는 날: 주간 시간표 칸은 보이지 않음(holiday)', () => {
    const off = { name: '개천절' }
    const v = buildTeacherDay(payload({ days: { [MON]: official(MON, [], [], off) }, offDays: { [MON]: off }, mySchedule: SCHEDULE }), MON)
    assert.equal(v.mode, 'legacy')
    assert.equal(v.state, 'holiday')
    assert.deepEqual(v.rows, [])
  })

  test('학기 밖: 주간 시간표 방식도 outside-term(방학 중 주간 시간표를 보이지 않음)', () => {
    const d = '20261221' // 월요일, 학기 문서 종료(12/20) 뒤
    const v = buildTeacherDay(payload({ days: { [d]: official(d, []) }, mySchedule: SCHEDULE }), d)
    assert.equal(v.outsideTerm, true)
    assert.equal(v.state, 'outside-term')
    assert.deepEqual(v.rows, [])
  })

  test('학기 목록이 비면 학기 밖으로 판정하지 않음', () => {
    const d = '20261221'
    const v = buildTeacherDay(payload({ terms: [], days: { [d]: official(d, []) }, mySchedule: SCHEDULE }), d)
    assert.equal(v.state, 'lessons')
  })

  test('학사일정 확인 실패 날짜 표시', () => {
    const v = buildTeacherDay(payload({ days: { [MON]: official(MON, []) }, calendarErrors: [MON], mySchedule: SCHEDULE }), MON)
    assert.equal(v.calendarFailed, true)
    assert.equal(v.state, 'lessons')
  })
})

describe('교환(품앗이)·보결 겹치기', () => {
  test('내 교시를 다른 선생님이 대신: 같은 교시 행에 표시(주간 시간표 방식)', () => {
    const v = buildTeacherDay(payload({ days: { [MON]: official(MON, []) }, mySchedule: SCHEDULE, covers: [cover({})] }), MON)
    const r1 = v.rows.find((r) => r.lesson.period === 1)!
    assert.deepEqual(rowBadges(r1).map((b) => b.label), ['김동료 선생님이 대신 들어가요 (품앗이)'])
    assert.equal(v.rows.length, 2, '행을 따로 늘리지 않음')
  })

  test('공식 방식: 같은 교시 공식 수업에 보결 표시, changed-away 행에는 붙이지 않음', () => {
    const sos = cover({ id: 'sos:1', kind: 'sos', date: TUE, period: 3, subject: '', otherName: '박보결' })
    const v = buildTeacherDay(payload({ days: { [TUE]: official(TUE, [engB]) }, covers: [sos] }), TUE)
    assert.deepEqual(rowBadges(v.rows[0]).map((b) => b.label), ['박보결 선생님이 대신 들어가요 (보결)'])
    assert.equal(coveredByText(sos), '박보결 선생님이 대신 들어가요 (보결)')
  })

  test('그 교시 수업이 목록에 없으면 따로 행(covered-only)', () => {
    const c = cover({ date: MON, period: 5, subject: '2-3 문학' })
    const v = buildTeacherDay(payload({ days: { [MON]: official(MON, []) }, mySchedule: SCHEDULE, covers: [c] }), MON)
    const r = v.rows.find((x) => x.kind === 'covered-only')!
    assert.equal(r.lesson.period, 5)
    assert.equal(r.lesson.title, '문학')
    assert.equal(r.classLabel, '2학년 3반')
  })

  test('내가 대신 들어가는 교환·보결은 따로 행(covering) — 모든 방식, 빈 상태에서도', () => {
    const swap = cover({ id: 'swap:9', direction: 'covering', date: MON, period: 2, subject: '1-5 국어', requesterClass: '3학년 2반', otherName: '김요청' })
    const sos = cover({ id: 'sos:9', kind: 'sos', direction: 'covering', date: MON, period: 6, subject: '', requesterClass: '3학년 2반', otherName: '박요청' })
    const v = buildTeacherDay(payload({ days: { [MON]: official(MON, []) }, covers: [sos, swap] }), MON)
    assert.equal(v.mode, 'empty')
    assert.equal(v.state, 'lessons')
    assert.deepEqual(v.rows.map((r) => [r.kind, r.lesson.period, r.lesson.title]), [
      ['covering', 2, '대신 들어가는 수업 · 1-5 국어 (김요청 선생님)'],
      ['covering', 6, '대신 들어가는 수업 · 3학년 2반 (박요청 선생님)'],
    ])
    assert.deepEqual(rowBadges(v.rows[0]).map((b) => b.label), ['품앗이'])
    assert.deepEqual(rowBadges(v.rows[1]).map((b) => b.label), ['보결'])
    assert.equal(coveringTitle({ subject: '국어', requesterClass: '3학년 2반', otherName: '김' }), '대신 들어가는 수업 · 3학년 2반 국어 (김 선생님)')
    assert.equal(coveringTitle({ subject: '', requesterClass: '', otherName: '박' }), '대신 들어가는 수업 (박 선생님)')
  })

  test('다른 날짜의 교환·보결은 겹치지 않음', () => {
    const v = buildTeacherDay(payload({ days: { [TUE]: official(TUE, []) }, mySchedule: SCHEDULE, covers: [cover({ date: MON })] }), TUE)
    assert.ok(v.rows.every((r) => r.coveredBy.length === 0 && r.kind === 'legacy'))
  })

  test('행 정렬: 교시(시각) 순', () => {
    const c = cover({ id: 'swap:a', direction: 'covering', date: TUE, period: 1 })
    const v = buildTeacherDay(payload({ days: { [TUE]: official(TUE, [engB, sciA], [subTo(TUE)]) }, covers: [c] }), TUE)
    assert.deepEqual(v.rows.map((r) => r.lesson.period), [1, 3, 4])
  })
})

describe('취소·옮김 행', () => {
  test('취소된 내 차시는 취소 행(배지 취소) + 상태 lessons', () => {
    const cancel: Override = { overrideId: 'c1', courseId: 'engB', occurrenceKey: `sr_engB_tue3@${TUE}`, changeSetId: 'cs-c', kind: 'cancel', seriesId: 'sr_engB_tue3', originalDate: TUE, target: null, revision: 2, status: 'published' }
    const v = buildTeacherDay(payload({ days: { [TUE]: official(TUE, [engB], [cancel]) } }), TUE)
    assert.deepEqual(v.rows.map((r) => [r.kind, r.lesson.period, r.lesson.title]), [['cancelled', 3, '영어 B']])
    assert.deepEqual(rowBadges(v.rows[0]).map((b) => b.label), ['취소'])
    assert.equal(v.state, 'lessons')
  })
})

describe('응답 정리(normalizeTeacherPayload)', () => {
  test('기간 없는 응답은 null, 잘못된 교환 항목·날짜 키는 버림', () => {
    assert.equal(normalizeTeacherPayload({}), null)
    const p = normalizeTeacherPayload({
      from: MON, to: FRI, revision: '3', terms: [{ termId: 't', startDate: '20260816', endDate: 'bad' }],
      days: { [MON]: { hasOfficial: true, lessons: [{ key: 'k', courseId: 'c', teacherNames: 'x' }, { nope: 1 }] }, bad: {} },
      covers: [cover({}), { id: 1 }, { ...cover({}), period: 99 }],
      mySchedule: { mon: ['1-1 국어'] },
      offDays: { [MON]: { name: '' }, [TUE]: null },
    })!
    assert.equal(p.revision, 3)
    assert.deepEqual(p.terms, [])
    assert.deepEqual(Object.keys(p.days), [MON])
    assert.equal(p.days[MON].lessons.length, 1)
    assert.deepEqual(p.days[MON].lessons[0].teacherNames, [])
    assert.equal(p.covers.length, 1)
    assert.deepEqual(p.mySchedule?.mon.slice(0, 2), ['1-1 국어', ''])
    assert.deepEqual(p.offDays, { [MON]: { name: '쉬는 날' }, [TUE]: null })
  })
})
