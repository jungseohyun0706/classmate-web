/**
 * 교사 주간 시간표 — 주 계산·이동·라벨·조회 창(WEEK_WINDOW_POLICY) 단위 테스트
 *
 * 날짜: 2026-10-05(월) ~ 2026-10-11(일). 2026-10-01은 목요일, 2027-01-01은 금요일
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compactClassLabel,
  monthDaySlash,
  relativeWeekLabel,
  shiftWeek,
  weekDatesOf,
  weekEndOf,
  weekRangeLabel,
  weeksBetween,
  weekStartOf,
  weekWindowOf,
  WEEK_WINDOW_POLICY,
} from '../../src/lib/timetable/teacherWeek'
import { DAY_WINDOW_POLICY, planAfterLoad, planForDate, windowContains, windowFor } from '../../src/lib/timetable/clientWindow'
import { weekdayOf } from '../../src/lib/timetable/dates'

describe('주 시작·끝(월~일)', () => {
  test('월요일 시작: 월~일 모두 같은 월요일', () => {
    for (const d of ['20261005', '20261006', '20261007', '20261008', '20261009', '20261010', '20261011']) {
      assert.equal(weekStartOf(d), '20261005', d)
      assert.equal(weekEndOf(d), '20261011', d)
    }
  })

  test('일요일은 앞 주(월요일 시작) — 다음 날 월요일은 새 주', () => {
    assert.equal(weekStartOf('20261011'), '20261005')
    assert.equal(weekStartOf('20261012'), '20261012')
    assert.equal(weekdayOf(weekStartOf('20261011')), 1)
  })

  test('7일 목록', () => {
    assert.deepEqual(weekDatesOf('20261008'), ['20261005', '20261006', '20261007', '20261008', '20261009', '20261010', '20261011'])
  })

  test('달이 바뀌는 주(9월 28일 ~ 10월 4일)', () => {
    assert.equal(weekStartOf('20261001'), '20260928')
    assert.equal(weekEndOf('20261001'), '20261004')
    assert.deepEqual(weekDatesOf('20261001').slice(2, 5), ['20260930', '20261001', '20261002'])
    assert.equal(weekRangeLabel('20260928', '20261002'), '9월 28일 ~ 10월 2일')
  })

  test('해가 바뀌는 주(2026-12-28 ~ 2027-01-03) — 라벨에 연도', () => {
    assert.equal(weekStartOf('20270101'), '20261228')
    assert.equal(weekEndOf('20261229'), '20270103')
    assert.equal(weekRangeLabel('20261228', '20270101'), '2026년 12월 28일 ~ 2027년 1월 1일')
    assert.equal(weekRangeLabel('20261005', '20261009'), '10월 5일 ~ 10월 9일')
  })

  test('조회 창 = 그 주 월~일 7일(서버 최대 21일 안), 받을 기간 = 필요한 기간', () => {
    assert.deepEqual(weekWindowOf('20261008'), { from: '20261005', to: '20261011' })
    assert.deepEqual(WEEK_WINDOW_POLICY.fetch('20261011'), { from: '20261005', to: '20261011' })
    assert.deepEqual(WEEK_WINDOW_POLICY.need('20261011'), WEEK_WINDOW_POLICY.fetch('20261011'))
    assert.deepEqual(weekWindowOf('20261231'), { from: '20261228', to: '20270103' })
  })
})

describe('주 이동·상대 라벨', () => {
  test('n주 앞뒤(요일 유지), 달·해 경계', () => {
    assert.equal(shiftWeek('20261006', 1), '20261013')
    assert.equal(shiftWeek('20261006', -1), '20260929')
    assert.equal(shiftWeek('20261231', 1), '20270107')
    assert.equal(weekdayOf(shiftWeek('20261008', 3)), 4)
  })

  test('주 차이 — 같은 주 안 날짜는 0, 해 경계도', () => {
    assert.equal(weeksBetween('20261006', '20261011'), 0)
    assert.equal(weeksBetween('20261011', '20261012'), 1)
    assert.equal(weeksBetween('20261230', '20270106'), 1)
    assert.equal(weeksBetween('20261006', '20260921'), -2)
  })

  test('이번 주 / 지난주 / 다음 주 / N주 전·뒤', () => {
    const today = '20261006'
    assert.equal(relativeWeekLabel('20261005', today), '이번 주')
    assert.equal(relativeWeekLabel('20261011', today), '이번 주')
    assert.equal(relativeWeekLabel('20261004', today), '지난주')
    assert.equal(relativeWeekLabel('20261012', today), '다음 주')
    assert.equal(relativeWeekLabel('20261020', today), '2주 뒤')
    assert.equal(relativeWeekLabel('20260921', today), '2주 전')
  })

  test('좁은 칸 라벨: 날짜 10/6, 학급 3학년 5반 → 3-5', () => {
    assert.equal(monthDaySlash('20261006'), '10/6')
    assert.equal(compactClassLabel('3학년 5반'), '3-5')
    assert.equal(compactClassLabel('3학년 4반, 3학년 5반'), '3-4, 3-5')
    assert.equal(compactClassLabel('동아리'), '동아리')
    assert.equal(compactClassLabel(null), null)
  })
})

describe('조회 창 판단(주간 policy) — 홈 카드 기본은 그대로', () => {
  const week = { from: '20261005', to: '20261011' }

  test('받은 자료가 그 주 7일을 모두 포함해야 그대로 둠(그 날짜만 포함하면 그 주를 새로 받음)', () => {
    assert.deepEqual(planForDate({ date: '20261008', inflight: null, payload: { ...week, revision: 1 }, fromCache: false, knownRevision: 1, policy: WEEK_WINDOW_POLICY }), { kind: 'keep' })
    // 홈 카드 창(앞 3일~뒤 13일)이 목요일은 포함해도 그 주 월요일(10/5)을 포함하지 않으면 주간 화면은 다시 받음
    const homeWin = windowFor('20261009') // 10/6 ~ 10/22
    assert.equal(windowContains(homeWin, week), false)
    assert.deepEqual(planForDate({ date: '20261008', inflight: null, payload: { ...homeWin, revision: 1 }, fromCache: false, knownRevision: 1, policy: WEEK_WINDOW_POLICY }), {
      kind: 'load',
      win: week,
    })
    // 기본(하루 화면)은 그 날짜만 보면 됨 — 예전과 같음
    assert.deepEqual(planForDate({ date: '20261008', inflight: null, payload: { ...homeWin, revision: 1 }, fromCache: false, knownRevision: 1 }), { kind: 'keep' })
    assert.equal(DAY_WINDOW_POLICY.fetch, windowFor)
  })

  test('주를 빨리 넘김: 진행 중 요청(이번 주)이 다음 주를 포함하지 않으면 다음 주를 받음(이전 응답은 훅이 버림)', () => {
    assert.deepEqual(planForDate({ date: '20261013', inflight: week, payload: null, fromCache: false, knownRevision: 0, policy: WEEK_WINDOW_POLICY }), {
      kind: 'load',
      win: { from: '20261012', to: '20261018' },
    })
    // 같은 주 안 다른 요일로 옮기면 그대로(다시 받지 않음)
    assert.deepEqual(planForDate({ date: '20261010', inflight: week, payload: null, fromCache: false, knownRevision: 0, policy: WEEK_WINDOW_POLICY }), { kind: 'keep' })
  })

  test('응답을 받는 사이 다른 주로 갔으면 그 주를 받음, 버전이 올라갔으면 같은 주를 한 번 더', () => {
    assert.deepEqual(
      planAfterLoad({ date: '20261013', win: week, payload: { ...week, revision: 3 }, knownRevision: 3, staleRetries: 0, policy: WEEK_WINDOW_POLICY }),
      { kind: 'reload-date', win: { from: '20261012', to: '20261018' } }
    )
    assert.deepEqual(planAfterLoad({ date: '20261007', win: week, payload: { ...week, revision: 3 }, knownRevision: 4, staleRetries: 0, policy: WEEK_WINDOW_POLICY }), {
      kind: 'reload-revision',
      win: week,
    })
    assert.deepEqual(planAfterLoad({ date: '20261007', win: week, payload: { ...week, revision: 4 }, knownRevision: 4, staleRetries: 0, policy: WEEK_WINDOW_POLICY }), { kind: 'done' })
  })
})
