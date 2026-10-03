// 일정 변경·학급 공통 수업 검토 결함의 회귀 테스트(순수 로직) — 가상 데이터
//  [1]  기본 변경(base)이 만든 새 차시에 원래 차시의 sourceHomeroomId를 이어 붙임
//  [11] 학급 시간표 → 공통 수업 재실행이 기본 변경으로 옮긴 칸을 다시 만들지 않음(planHomeroomSeries)
//  [5]  승인 시 요청자의 충돌 확인은 요청 때 저장한 충돌에만 유효(conflictsCovered)
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  conflictKey,
  conflictsCovered,
  planHomeroomSeries,
  planItems,
  type ConflictEntry,
  type HomeroomSeriesRecord,
  type ChangeRequest,
} from '../../src/lib/timetable/changes'
import { seriesFromDoc } from '../../src/lib/timetable/server'
import type { Course, LessonSeries, Weekday } from '../../src/lib/timetable/types'

const CLASS = 'S1_3_5'
const course = (courseId: string, extra: Partial<Course> = {}): Course => ({
  courseId, schoolCode: 'S1', termId: 'T1', title: courseId, subject: courseId, teacherUids: [], teacherNames: [], status: 'active', commonForHomerooms: [CLASS], ...extra,
})
const ser = (seriesId: string, courseId: string, weekday: number, period: number, extra: Partial<LessonSeries> = {}): LessonSeries => ({
  seriesId, courseId, weekday: weekday as Weekday, period, roomName: null, validFrom: '20260901', validTo: null, status: 'active', ...extra,
})
const rec = (s: LessonSeries, links: { replacesSeriesId?: string; supersededBy?: string } = {}): HomeroomSeriesRecord => ({ s, ...links })
const cell = (weekday: number, period: number, courseId: string, room: string | null = null) => ({ weekday: weekday as Weekday, period, courseId, room })
const termOf = () => ({ termId: 'T1', name: 'T1', startDate: '20260816', endDate: '20270301', isDefault: false })

describe('[1] 기본 변경이 학급 차시의 sourceHomeroomId를 이어 붙임', () => {
  const baseReq = (seriesId: string): ChangeRequest => ({
    mutationId: 'm-base-0001', expectedRevision: 3, scope: 'base', reason: '', acknowledgeConflicts: false,
    items: [{ op: 'base', courseId: 'hcKor', seriesId, effectiveFrom: '20261012', patch: { period: 4 } }],
  })
  const run = (s: LessonSeries) =>
    planItems({
      req: baseReq(s.seriesId), mutationId: 'm-base-0001', requesterUid: 'hr5', revision: 3,
      courses: new Map([['hcKor', course('hcKor', { managerUids: ['hr5'] })]]),
      series: new Map([[s.seriesId, s]]), histories: new Map(), termOf, today: '20261003',
    })

  test('학급 차시(hcs_)를 옮긴 새 차시(sr_) 문서·계획에 같은 학급 id', () => {
    const p = run(ser('hcs_A', 'hcKor', 1, 1, { sourceHomeroomId: CLASS }))
    assert.equal(p.seriesCreate.length, 1)
    assert.equal(p.seriesCreate[0].id, 'sr_m-base-0001_0')
    assert.equal(p.seriesCreate[0].data.sourceHomeroomId, CLASS)
    assert.equal(p.seriesCreate[0].data.replacesSeriesId, 'hcs_A')
    assert.equal(p.seriesAfter.get('sr_m-base-0001_0')?.sourceHomeroomId, CLASS)
  })

  test('학급 시간표에서 오지 않은 차시는 필드를 만들지 않음', () => {
    const p = run(ser('sr_manual', 'hcKor', 1, 1))
    assert.equal('sourceHomeroomId' in p.seriesCreate[0].data, false)
  })

  test('seriesFromDoc: 문서의 sourceHomeroomId를 읽고, 없으면 키를 넣지 않음', () => {
    const doc = { courseId: 'c', weekday: 1, period: 1, validFrom: '20260901', validTo: null, status: 'active' }
    assert.equal(seriesFromDoc('a', { ...doc, sourceHomeroomId: CLASS }).sourceHomeroomId, CLASS)
    assert.equal('sourceHomeroomId' in seriesFromDoc('b', doc), false)
    assert.equal('sourceHomeroomId' in seriesFromDoc('c', { ...doc, sourceHomeroomId: '' }), false)
  })
})

describe('[11] 학급 시간표 → 공통 수업 재실행(planHomeroomSeries)', () => {
  const F = '20261012' // 기본 변경 적용일(월요일): 국어 월1 → 월4
  const termEnd = '20270301'
  const hcsA = ser('hcs_A', 'hcKor', 1, 1, { sourceHomeroomId: CLASS, validTo: F, status: 'retired' })
  const hcsMath = ser('hcs_M', 'hcMath', 1, 2, { sourceHomeroomId: CLASS })
  const srX = ser('sr_X', 'hcKor', 1, 4, { sourceHomeroomId: CLASS, validFrom: F })
  const unchangedClass = [cell(1, 1, 'hcKor'), cell(1, 2, 'hcMath')]
  const chain = () => [rec(hcsA, { supersededBy: 'sr_X' }), rec(srX, { replacesSeriesId: 'hcs_A' }), rec(hcsMath)]
  const plan = (effectiveFrom: string, existing: HomeroomSeriesRecord[], desired = unchangedClass) =>
    planHomeroomSeries({ classId: CLASS, effectiveFrom, termEnd, existing, desired })
  const ids = (xs: LessonSeries[]) => xs.map((s) => s.seriesId).sort()

  test('기본 변경이 없으면 예전과 같음: 그대로인 칸 유지, 바뀐 칸만 새로', () => {
    const p = plan('20261020', [rec(ser('hcs_K', 'hcKor', 1, 1, { sourceHomeroomId: CLASS })), rec(hcsMath)], [cell(1, 1, 'hcKor'), cell(1, 3, 'hcMath')])
    assert.deepEqual(Array.from(p.keep), ['hcs_K'])
    assert.deepEqual(p.toCreate.map((c) => [c.weekday, c.period, c.courseId, c.validFrom]), [[1, 3, 'hcMath', '20261020']])
    assert.deepEqual(ids(p.toRetire), ['hcs_M'])
    assert.equal(p.keptByChange, 0)
  })

  test('적용일이 기본 변경 뒤(E ≥ F)이고 학급 시간표 그대로 → 옮긴 차시(sr_) 유지, 새로 만들거나 끝내는 것 없음', () => {
    const p = plan('20261020', chain())
    assert.equal(p.toCreate.length, 0)
    assert.equal(p.toRetire.length, 0)
    assert.deepEqual(Array.from(p.keep).sort(), ['hcs_M', 'sr_X'])
    assert.equal(p.keptByChange, 1)
  })

  test('적용일이 기본 변경 전(E < F) → 원래 차시(F까지)와 옮긴 차시(F부터) 모두 유지', () => {
    const p = plan('20261005', chain())
    assert.equal(p.toCreate.length, 0)
    assert.equal(p.toRetire.length, 0)
    assert.deepEqual(Array.from(p.keep).sort(), ['hcs_A', 'hcs_M', 'sr_X'])
  })

  test('예전 자료: sr_에 sourceHomeroomId가 없어도 replacesSeriesId 연결로 이 학급 차시로 봄', () => {
    const legacy = [rec(hcsA), rec({ ...srX, sourceHomeroomId: undefined }, { replacesSeriesId: 'hcs_A' }), rec(hcsMath)]
    for (const E of ['20261005', '20261020']) {
      const p = plan(E, legacy)
      assert.equal(p.toCreate.length, 0, E)
      assert.equal(p.toRetire.length, 0, E)
      assert.ok(p.keep.has('sr_X'), E)
    }
  })

  test('예전 버그로 이미 겹쳐 만든 차시(같은 칸 hcs_)는 적용일부터 끝내고 옮긴 차시를 남김', () => {
    const dup = ser('hcs_A2', 'hcKor', 1, 1, { sourceHomeroomId: CLASS, validFrom: '20261019' })
    const p = plan('20261026', [...chain(), rec(dup)])
    assert.deepEqual(ids(p.toRetire), ['hcs_A2'])
    assert.equal(p.toCreate.length, 0)
    assert.ok(p.keep.has('sr_X'))
  })

  test('담임이 학급 시간표도 옮긴 칸(월4)으로 맞춰 둠 → 지금 칸과 같아 그대로 유지', () => {
    const p = plan('20261020', chain(), [cell(1, 4, 'hcKor'), cell(1, 2, 'hcMath')])
    assert.equal(p.toCreate.length, 0)
    assert.equal(p.toRetire.length, 0)
    assert.equal(p.keptByChange, 1)
  })

  test('학급 시간표에서 그 칸이 빠짐(실제로 바뀐 칸) → 옮긴 차시도 적용일부터 끝냄', () => {
    const after = plan('20261020', chain(), [cell(1, 2, 'hcMath')])
    assert.deepEqual(ids(after.toRetire), ['sr_X'])
    const before = plan('20261005', chain(), [cell(1, 2, 'hcMath')])
    assert.deepEqual(ids(before.toRetire), ['hcs_A', 'sr_X'])
    assert.equal(before.toCreate.length, 0)
  })

  test('학급 시간표의 다른 칸이 바뀌면 그 칸만 적용일부터 반영, 옮긴 칸은 유지', () => {
    const p = plan('20261020', chain(), [...unchangedClass, cell(4, 1, 'hcKor')])
    assert.deepEqual(p.toCreate.map((c) => [c.weekday, c.period, c.validFrom]), [[4, 1, '20261020']])
    assert.equal(p.toRetire.length, 0)
    assert.ok(p.keep.has('sr_X'))
  })

  test('원래 칸(월1)과 옮긴 칸(월4)이 둘 다 학급 시간표에 있으면 월4는 옮긴 차시, 월1은 원래 차시가 끝난 뒤부터 새로(같은 칸 두 번 없음)', () => {
    const desired = [cell(1, 1, 'hcKor'), cell(1, 4, 'hcKor'), cell(1, 2, 'hcMath')]
    const afterF = plan('20261020', chain(), desired)
    assert.deepEqual(afterF.toCreate.map((c) => [c.period, c.validFrom]), [[1, '20261020']])
    const beforeF = plan('20261005', chain(), desired)
    assert.deepEqual(beforeF.toCreate.map((c) => [c.period, c.validFrom]), [[1, F]])
    assert.equal(beforeF.toRetire.length, 0)
  })

  test('교사가 직접 추가한 차시(학급 차시와 연결 없음)는 건드리지 않음', () => {
    const manual = ser('sr_manual', 'hcKor', 3, 5)
    const p = plan('20261020', [...chain(), rec(manual)])
    assert.equal(p.keep.has('sr_manual'), false)
    assert.equal(p.toRetire.some((s) => s.seriesId === 'sr_manual'), false)
  })

  test('옮긴 차시가 이미 끝났으면(차시 종료) 학급 시간표 칸을 적용일부터 다시 만듦', () => {
    const ended = [rec(hcsA, { supersededBy: 'sr_X' }), rec({ ...srX, validTo: '20261019', status: 'retired' }, { replacesSeriesId: 'hcs_A' }), rec(hcsMath)]
    const p = plan('20261020', ended)
    assert.deepEqual(p.toCreate.map((c) => [c.weekday, c.period, c.validFrom]), [[1, 1, '20261020']])
  })
})

describe('[5] 승인 시 충돌 확인 범위(conflictsCovered)', () => {
  const c = (kind: ConflictEntry['kind'], a: string, b: string, detail: string, extra: Partial<ConflictEntry> = {}): ConflictEntry => ({
    kind, a, b, detail, date: '20261013', aCourseId: a.split('@')[0], bCourseId: b.split('@')[0], aTitle: '', bTitle: '', aPeriod: 2, bPeriod: 2, ...extra,
  })
  const X = c('teacher', 'sciA@k1', 'sciC@k2', '김과학')

  test('요청 때 확인한 충돌만 있으면 그대로 유효(두 차시 순서가 바뀌어도 같은 충돌)', () => {
    assert.equal(conflictsCovered([X], [X]), true)
    const swapped = c('teacher', 'sciC@k2', 'sciA@k1', '김과학')
    assert.equal(conflictKey(swapped), conflictKey(X))
    assert.equal(conflictsCovered([swapped], [X]), true)
  })

  test('학생 충돌은 겹치는 인원 수가 바뀌어도 같은 충돌', () => {
    const s1 = c('students', 'sciA@k1', 'engA@k3', '1')
    const s2 = c('students', 'sciA@k1', 'engA@k3', '2')
    assert.equal(conflictsCovered([s2], [s1]), true)
  })

  test('승인 시점에 새로 생긴 충돌(다른 차시·다른 종류·다른 교실)은 확인되지 않은 것', () => {
    const Y = c('students', 'sciA@k1', 'engA@k3', '1')
    assert.equal(conflictsCovered([X, Y], [X]), false)
    assert.equal(conflictsCovered([c('room', 'sciA@k1', 'sciC@k2', '과학실')], [X]), false)
    assert.equal(conflictsCovered([c('room', 'sciA@k1', 'sciC@k2', '어학실')], [c('room', 'sciA@k1', 'sciC@k2', '과학실')]), false)
    assert.equal(conflictsCovered([X], undefined), false)
    assert.equal(conflictsCovered([X], [null, 'x']), false)
  })

  test('지금 충돌이 없으면 확인할 것도 없음', () => {
    assert.equal(conflictsCovered([], []), true)
    assert.equal(conflictsCovered([], undefined), true)
  })
})
