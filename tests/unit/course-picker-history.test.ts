/**
 * 학생 '수업 담기' — 빼고 다시 담아도 지난 날짜 기록 유지 · 가져오기가 정리한 수업 (순수 함수, 가상 데이터)
 *  - 수강 문서 id가 결정적(courseId__uid)이라 다시 담으면 from/to가 바뀜 → 이전 기간은 history에 남고,
 *    enrollmentFromDoc이 그중 '들은 기간'(끝낸 수강의 [from, to))을 past로 꺼내 엔진이 지난 날짜에 그대로 보여 줌
 *  - 승인 대기에서 끝내거나 거절된 수강(to 없음)·같은 날 담았다 뺀 수강(from = to)은 들은 기간이 없어 넣지 않음
 *  - 시간표 가져오기(replace)가 정리한 수업(importRetiredOn 지남)은 공개 목록·담기에서 빠짐(importRetiredBy)
 *  - 다시 참여할 때 승인(needsReapproval): '선생님이 끝낸 뒤 다시 신청했다가 학생이 뺀' 수강(reapproval)도 승인 대기
 *    — 학생 신청·초대 수락(decideEnrollment)·그룹 QR이 같은 규칙
 * 테스트 데이터는 모두 가상입니다.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveCourses } from '../../src/lib/timetable/engine'
import { enrollmentFromDoc, importRetiredBy, needsReapproval } from '../../src/lib/timetable/server'
import type { Course } from '../../src/lib/timetable/types'

const course = (courseId: string, extra: Partial<Course> = {}): Course => ({
  courseId,
  schoolCode: 'S1',
  termId: '2026-2',
  title: courseId,
  subject: courseId,
  teacherUids: [],
  teacherNames: [],
  status: 'active',
  commonForHomerooms: [],
  ...extra,
})

describe('수강 문서 history → 이전에 들은 기간(enrollmentFromDoc past)', () => {
  test('끝낸 수강의 [from, to)만, 같은 기간은 한 번 — 승인 대기 종료·거절(to 없음)·같은 날 담았다 뺀 수강은 제외', () => {
    const e = enrollmentFromDoc({
      courseId: 'sci',
      uid: 'me',
      status: 'active',
      from: '20261005',
      to: null,
      source: 'request',
      history: [
        { status: 'ended', from: '20260907', to: '20260921', source: 'request', decidedBy: null },
        { status: 'ended', from: '20260907', to: '20260921', source: 'request', decidedBy: null },
        { status: 'ended', from: null, to: null, source: 'request', decidedBy: 'tx' }, // 거절·승인 대기 종료
        { status: 'ended', from: '20260928', to: '20260928', source: 'request', decidedBy: null }, // 같은 날 담았다 뺌
        { status: 'ended', from: null, to: '20260905', source: 'roster', decidedBy: 'tx' }, // 처음부터 듣다 끝냄
        { status: 'active', from: '20260901', to: null }, // 형식 밖
        'x',
      ],
    })
    assert.deepEqual(e.past, [
      { from: '20260907', to: '20260921' },
      { from: null, to: '20260905' },
    ])
  })
  test('history가 없거나 들은 기간이 없으면 past 필드 없음(응답 모양 그대로)', () => {
    assert.ok(!('past' in enrollmentFromDoc({ courseId: 'a', uid: 'me', status: 'active', source: 'request' })))
    assert.ok(!('past' in enrollmentFromDoc({ courseId: 'a', uid: 'me', status: 'pending', source: 'request', history: [{ status: 'ended', from: null, to: null }] })))
  })
})

describe('엔진: 빼고 다시 담은 수업의 지난 날짜(resolveCourses)', () => {
  const courses = [course('sci'), course('phys'), course('done', { status: 'ended', endedOn: '20260915' })]
  const enrollments = [
    // 9/7~9/21 듣고 뺐다가 10/5부터 다시 담음
    { courseId: 'sci', uid: 'me', status: 'active' as const, from: '20261005', to: null, source: 'request' as const, past: [{ from: '20260907', to: '20260921' }] },
    // 9/7~9/14 듣다가 선생님이 끝내고, 다시 신청해 승인 대기
    { courseId: 'phys', uid: 'me', status: 'pending' as const, from: null, to: null, source: 'request' as const, past: [{ from: '20260907', to: '20260914' }] },
    // 수업 자체가 끝난 날짜 뒤에는 이전 기간이어도 보이지 않음
    { courseId: 'done', uid: 'me', status: 'ended' as const, from: '20260901', to: '20260910', source: 'request' as const, past: [{ from: null, to: '20260920' }] },
  ]
  const on = (date: string) => resolveCourses({ uid: 'me', homerooms: [], enrollments, courses }, date)

  test('이전 기간 안의 날짜: 들은 수업(enrolled) — 지금 승인 대기여도 그날은 참여로', () => {
    const r = on('20260910')
    assert.equal(r.active.get('sci'), 'enrolled')
    assert.equal(r.active.get('phys'), 'enrolled')
    assert.ok(!r.pending.includes('phys'))
  })
  test('이전 기간과 지금 기간 사이(뺀 동안)는 없음, 지금 기간부터 다시 참여', () => {
    assert.ok(!on('20260928').active.has('sci'))
    assert.equal(on('20261006').active.get('sci'), 'enrolled')
  })
  test('이전 기간 밖에서는 지금 상태 그대로(승인 대기), 끝난 수업은 끝난 날부터 이전 기간이어도 없음', () => {
    const r = on('20260928')
    assert.deepEqual(r.pending, ['phys'])
    assert.equal(on('20260912').active.get('done'), 'enrolled')
    assert.ok(!on('20260916').active.has('done'))
  })
  test('다른 학생의 수강 기간은 내 시간표에 넣지 않음', () => {
    assert.equal(resolveCourses({ uid: 'other', homerooms: [], enrollments, courses }, '20260910').active.size, 0)
  })
})

describe('가져오기가 정리한 수업(importRetiredBy)', () => {
  test('importRetiredOn이 오늘이거나 지났으면 정리됨, 앞으로의 날짜·없음·형식 오류는 아님', () => {
    assert.equal(importRetiredBy({ importRetiredOn: '20261005' }, '20261005'), true)
    assert.equal(importRetiredBy({ importRetiredOn: '20261001' }, '20261005'), true)
    assert.equal(importRetiredBy({ importRetiredOn: '20261012' }, '20261005'), false)
    assert.equal(importRetiredBy({ importRetiredOn: null }, '20261005'), false)
    assert.equal(importRetiredBy({}, '20261005'), false)
    assert.equal(importRetiredBy({ importRetiredOn: '2026-10-01' }, '20261005'), false)
  })
})

describe('다시 참여할 때 승인이 필요한 수강(needsReapproval — 신청·초대·그룹 QR 공통)', () => {
  test('선생님이 끝내거나 거절한 수강(decidedBy) → 필요, 그 뒤 다시 신청했다가 학생이 뺀 수강(decidedBy 없음 + reapproval) → 여전히 필요', () => {
    assert.equal(needsReapproval({ status: 'ended', decidedBy: 'tx' }), true)
    assert.equal(needsReapproval({ status: 'ended', decidedBy: 'tx', rejected: true }), true)
    assert.equal(needsReapproval({ status: 'ended', decidedBy: null, reapproval: true }), true)
  })
  test('학생이 스스로 뺀 수강(표시 없음)·처음 참여·참여 중·대기는 아님', () => {
    assert.equal(needsReapproval({ status: 'ended', decidedBy: null, reapproval: false }), false)
    assert.equal(needsReapproval({ status: 'ended', decidedBy: null }), false)
    assert.equal(needsReapproval(null), false)
    assert.equal(needsReapproval({ status: 'pending', reapproval: true }), false)
    assert.equal(needsReapproval({ status: 'active', decidedBy: 'tx' }), false)
  })
})
