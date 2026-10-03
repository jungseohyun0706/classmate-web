// 조회 기간 변경 선택(selectOverridesForWindow) — 서버가 기간으로 거른 변경을 엔진이 받아도 결과가 같아야 함 (가상 데이터)
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDayTimetable, occurrenceKeyOf, selectOverridesForWindow } from '../../src/lib/timetable/engine'
import type { Course, LessonSeries, Override } from '../../src/lib/timetable/types'

const course = (courseId: string, title: string): Course => ({
  courseId, schoolCode: 'S1', termId: '2026-2', title, subject: title, teacherUids: [], teacherNames: [], status: 'active', commonForHomerooms: [],
})
const ENG = course('engB', '영어 B')
const SCI = course('sci', '생활과 과학 A')
// 금요일(5) 3교시 영어, 화요일(2) 1교시 과학
const SERIES: LessonSeries[] = [
  { seriesId: 's-eng', courseId: 'engB', weekday: 5, period: 3, validFrom: '20260816', validTo: null, status: 'active' },
  { seriesId: 's-sci', courseId: 'sci', weekday: 2, period: 1, validFrom: '20260816', validTo: null, status: 'active' },
]
const ov = (id: string, rev: number, o: Partial<Override> & Pick<Override, 'courseId' | 'occurrenceKey' | 'kind'>): Override => ({
  overrideId: id, changeSetId: `cs-${id}`, revision: rev, status: 'published', ...o,
})
const at = (overrides: Override[], date: string) =>
  buildDayTimetable({
    uid: 'A',
    day: { date, offDay: null, periodTimes: [], term: null },
    homerooms: [],
    enrollments: [
      { uid: 'A', courseId: 'engB', status: 'active', source: 'invite' },
      { uid: 'A', courseId: 'sci', status: 'active', source: 'invite' },
    ],
    courses: [ENG, SCI],
    series: SERIES,
    overrides,
    personalEntries: [],
  })

describe('조회 기간 변경 선택', () => {
  // 11/20(금) 영어를 10/14로 당겼다가(rev5), 다시 11/21로 옮김(rev7)
  const key = occurrenceKeyOf('s-eng', '20261120')
  const rev5 = ov('o5', 5, { courseId: 'engB', occurrenceKey: key, kind: 'reschedule', seriesId: 's-eng', originalDate: '20261120', target: { date: '20261014', period: 2 } })
  const rev7 = ov('o7', 7, { courseId: 'engB', occurrenceKey: key, kind: 'reschedule', seriesId: 's-eng', originalDate: '20261120', target: { date: '20261121', period: 2 } })

  test('D9 기간 밖으로 다시 옮긴 최신 변경도 함께 넣어, 예전 변경이 기간 안에 살아나지 않음', () => {
    const picked = selectOverridesForWindow([{ o: rev5, raw: { dates: ['20261120', '20261014'] } }, { o: rev7, raw: { dates: ['20261120', '20261121'] } }], '20261012', '20261025')
    assert.deepEqual(picked.map((o) => o.overrideId).sort(), ['o5', 'o7'])
    const t = at(picked, '20261014')
    assert.equal(t.lessons.length, 0, '10/14에는 영어가 없어야 함(최신 변경은 11/21)')
    // 기간 필터를 차시별 최신 선택보다 먼저 하면 생기던 잘못된 결과(회귀 확인용)
    const wrong = at([rev5], '20261014')
    assert.equal(wrong.lessons.length, 1)
  })

  test('기간에 전혀 걸치지 않는 차시의 변경은 넣지 않음', () => {
    const other = ov('o9', 9, { courseId: 'sci', occurrenceKey: occurrenceKeyOf('s-sci', '20261201'), kind: 'cancel', seriesId: 's-sci', originalDate: '20261201' })
    const picked = selectOverridesForWindow([{ o: other, raw: { dates: ['20261201'] } }], '20261012', '20261025')
    assert.equal(picked.length, 0)
  })

  test('묶음의 한쪽만 기간에 걸쳐도 묶음 전체를 넣어, 묶음이 불완전하다고 버려지지 않음', () => {
    // 10/13(화) 과학 1교시와 11/20(금) 영어 3교시를 한 묶음으로 서로 바꿈
    const kSci = occurrenceKeyOf('s-sci', '20261013')
    const kEng = occurrenceKeyOf('s-eng', '20261120')
    const keys = [`sci|${kSci}`, `engB|${kEng}`]
    const a = ov('a', 11, { courseId: 'sci', occurrenceKey: kSci, kind: 'reschedule', seriesId: 's-sci', originalDate: '20261013', target: { date: '20261120', period: 3 }, changeSetId: 'cs-swap', changeSetKeys: keys })
    const b = ov('b', 11, { courseId: 'engB', occurrenceKey: kEng, kind: 'reschedule', seriesId: 's-eng', originalDate: '20261120', target: { date: '20261013', period: 1 }, changeSetId: 'cs-swap', changeSetKeys: keys })
    // dates 필드가 없는 예전 문서여도 원래 날짜·옮겨 간 날짜로 판단
    const picked = selectOverridesForWindow([{ o: a }, { o: b }], '20261012', '20261016')
    assert.equal(picked.length, 2)
    const t = at(picked, '20261013')
    assert.deepEqual(t.incompleteChangeSets, [])
    assert.deepEqual(t.lessons.map((l) => l.courseId), ['engB'])
    // 한쪽만 받으면 묶음 전체를 적용하지 않음(중간 상태 노출 방지) — 위 선택이 이것을 막음
    assert.deepEqual(at([a], '20261013').incompleteChangeSets, ['cs-swap'])
  })

  test('발행되지 않은(withdrawn) 변경은 넣지 않음', () => {
    const w = { ...rev5, overrideId: 'w', status: 'withdrawn' as const }
    assert.equal(selectOverridesForWindow([{ o: w }], '20261012', '20261025').length, 0)
  })
})
