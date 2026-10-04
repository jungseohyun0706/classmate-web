/**
 * 학생 '수업 담기' — 담은 수업 겹침 경고·담기 결과 정리 (순수 함수, 가상 데이터)
 *  - 겹침: 담은 수업끼리 같은 요일·교시 / 담은 수업과 이미 듣는 수업(참여·반 공통·승인 대기)이 같은 요일·교시 — 경고만
 *  - 결과: requestMany 응답 → 추가됨 / 선생님 승인 대기 / 이미 있음 / 담지 못함(이유). 응답에 없는 수업은 성공으로 위장하지 않음
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cartConflicts,
  mapRequestResults,
  pickFailureText,
  pickSummaryText,
  type MyLesson,
  type PickerCourse,
} from '../../src/lib/timetable/coursePicker'

function pc(id: string, slots: Array<[number, number]>, extra: Partial<PickerCourse> = {}): PickerCourse {
  return {
    courseId: id,
    title: id,
    subject: id,
    section: null,
    teacherNames: [],
    defaultRoomName: null,
    invitePolicy: 'auto',
    slots: slots.map(([weekday, period]) => ({ weekday, period, roomName: null })),
    myStatus: null,
    grades: [],
    classLabels: [],
    offer: 'mine',
    ...extra,
  }
}
const ml = (courseId: string, weekday: number, period: number, status: MyLesson['status'] = 'active', source: MyLesson['source'] = 'invite'): MyLesson => ({
  courseId,
  title: courseId,
  status,
  source,
  weekday,
  period,
  roomName: null,
  linkable: status === 'active',
})

describe('담은 수업 겹침(cartConflicts)', () => {
  test('겹침 없음 → []', () => {
    assert.deepEqual(cartConflicts([pc('a', [[1, 1]]), pc('b', [[1, 2]])], [ml('x', 2, 1)]), [])
  })

  test('담은 수업 둘이 같은 요일·교시 → picks 경고 하나(담은 순서)', () => {
    const r = cartConflicts([pc('sci', [[2, 4], [4, 2]]), pc('art', [[2, 4]])], [])
    assert.equal(r.length, 1)
    assert.deepEqual(r[0], { kind: 'picks', weekday: 2, period: 4, courseIds: ['sci', 'art'], mine: [] })
  })

  test('담은 수업이 이미 듣는 수업과 같은 요일·교시 → mine 경고(승인 대기·반 공통도 포함)', () => {
    const r = cartConflicts([pc('sci', [[2, 3], [3, 1]])], [ml('engB', 2, 3), ml('lit', 3, 1, 'common', 'common'), ml('phys', 5, 5, 'pending', 'request')])
    assert.deepEqual(
      r.map((x) => [x.kind, `${x.weekday}-${x.period}`, x.courseIds.join('+'), x.mine.map((m) => m.courseId).join('+')]),
      [
        ['mine', '2-3', 'sci', 'engB'],
        ['mine', '3-1', 'sci', 'lit'],
      ]
    )
    const p = cartConflicts([pc('chem', [[5, 5]])], [ml('phys', 5, 5, 'pending', 'request')])
    assert.equal(p[0].mine[0].status, 'pending', '승인 대기 수업과 겹쳐도 알려 줌')
  })

  test('두 종류가 한 칸에 같이 있으면 둘 다, 요일·교시 순', () => {
    const r = cartConflicts([pc('b', [[3, 2]]), pc('a', [[1, 1]]), pc('c', [[1, 1]])], [ml('m', 1, 1)])
    assert.deepEqual(
      r.map((x) => `${x.kind}@${x.weekday}-${x.period}`),
      ['picks@1-1', 'mine@1-1']
    )
  })

  test('이미 내 것인 수업을 다시 담은 경우 자기 자신과는 겹침이 아님', () => {
    assert.deepEqual(cartConflicts([pc('engB', [[2, 3]])], [ml('engB', 2, 3, 'active', 'request')]), [])
  })
})

describe('담기 결과(mapRequestResults)', () => {
  const data = {
    ok: true,
    results: [
      { courseId: 'sci', ok: true, status: 'active' },
      { courseId: 'phys', ok: true, status: 'pending' },
      { courseId: 'engB', ok: true, status: 'active', already: true },
      { courseId: 'engC', ok: true, status: 'pending', already: true },
      { courseId: 'hidden', ok: false, code: 'not-open', error: '...' },
      { courseId: 'ended', ok: false, code: 'course-ended' },
      { courseId: 'next', ok: false, code: 'other-term' },
    ],
  }
  test('수업마다 추가됨·선생님 승인 대기·이미 있음·담지 못함(이유) — 담은 순서', () => {
    const r = mapRequestResults(['phys', 'sci', 'engB', 'engC', 'hidden', 'ended', 'next'], data)
    assert.deepEqual(
      r.map((x) => [x.courseId, x.kind, x.label]),
      [
        ['phys', 'pending', '선생님 승인 대기'],
        ['sci', 'added', '추가됨'],
        ['engB', 'already', '이미 있음'],
        ['engC', 'already', '이미 있음'],
        ['hidden', 'failed', '담지 못함'],
        ['ended', 'failed', '담지 못함'],
        ['next', 'failed', '담지 못함'],
      ]
    )
    assert.equal(r[2].detail, '참여 중')
    assert.equal(r[3].detail, '승인 대기 중')
    assert.equal(r[4].detail, pickFailureText('not-open'))
    assert.match(r[5].detail || '', /끝난 수업/)
    assert.match(r[6].detail || '', /이번 학기/)
    assert.equal(r[4].code, 'not-open')
  })

  test('응답에 없는 수업은 담지 못함(결과 모름) — 성공으로 위장하지 않음, 중복 요청은 한 번', () => {
    const r = mapRequestResults(['sci', 'lost', 'sci'], data)
    assert.equal(r.length, 2)
    assert.deepEqual([r[1].kind, r[1].code], ['failed', 'missing'])
    assert.deepEqual(mapRequestResults(['a'], null).map((x) => x.kind), ['failed'])
    assert.deepEqual(mapRequestResults(['a'], { results: [{ courseId: 'a', ok: true, status: 'weird' }] }).map((x) => x.kind), ['failed'])
  })

  test('요약 문구', () => {
    const r = mapRequestResults(['phys', 'sci', 'engB', 'hidden'], data)
    assert.equal(pickSummaryText(r), '1개 추가됨 · 1개 선생님 승인 대기 · 1개 이미 있음 · 1개 담지 못함')
    assert.equal(pickSummaryText([]), '담은 수업이 없어요')
  })

  test('알 수 없는 code는 code를 보여 줌', () => {
    assert.match(pickFailureText('weird-code'), /weird-code/)
  })
})
