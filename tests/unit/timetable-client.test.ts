// 학생 개인 시간표 클라이언트 검토 결함의 회귀 테스트 — 순수 로직, 가상 데이터
//  [26] useMyTimetable: 먼 날짜로 갔다가 응답 전에 원래 날짜로 돌아오면 다른 기간 응답이 자료를 덮어써 스켈레톤에서 멈춤
//  [27] 수업 초대로만 가입한 학생(status pending, classId null)에게 '선생님 승인을 기다리고 있어요'가 뜸
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  coversDate,
  MAX_STALE_RETRIES,
  planAfterLoad,
  planForDate,
  windowCovers,
  windowFor,
  type PayloadWindowLike,
  type TimetableWindow,
} from '../../src/lib/timetable/clientWindow'
import { addDays } from '../../src/lib/timetable/dates'
import { awaitingHomeroomApproval } from '../../src/lib/homeroomStatus'

/** 화면 소스(정적 검사용) — 컴파일 위치(.test-dist/tests/unit)와 원본 위치 모두에서 찾음 */
function src(rel: string): string {
  const cands = [path.resolve(__dirname, '../../..', rel), path.resolve(__dirname, '../..', rel), path.resolve(process.cwd(), rel)]
  const f = cands.find((p) => fs.existsSync(p))
  if (!f) throw new Error(`소스 없음: ${rel}`)
  return fs.readFileSync(f, 'utf8')
}

const D = '20261003'
const payloadOf = (w: TimetableWindow, revision = 5): PayloadWindowLike => ({ from: w.from, to: w.to, revision })

describe('[26] 조회 창 기본', () => {
  test('windowFor: 앞 3일 ~ 뒤 13일, 그 날짜를 포함', () => {
    const w = windowFor(D)
    assert.deepEqual(w, { from: '20260930', to: '20261016' })
    assert.equal(windowCovers(w, D), true)
    assert.equal(coversDate(w, w.from), true)
    assert.equal(coversDate(w, w.to), true)
    assert.equal(coversDate(w, addDays(w.to, 1)), false)
  })
})

describe('[26] 날짜를 바꿀 때(planForDate)', () => {
  const W1 = windowFor(D)
  const base = { inflight: null as TimetableWindow | null, payload: payloadOf(W1) as PayloadWindowLike | null, fromCache: false, knownRevision: 5 }

  test('보고된 시나리오: D+20으로 갔다가 응답 전에 오늘로 → 진행 중 요청을 버림(이전에는 그대로 둬서 W2 응답이 덮어씀)', () => {
    const far = addDays(D, 20)
    const go = planForDate({ ...base, date: far })
    assert.equal(go.kind, 'load')
    const W2 = go.kind === 'load' ? go.win : null
    assert.ok(W2 && !windowCovers(W2, D), 'W2는 오늘을 포함하지 않음')
    const back = planForDate({ ...base, date: D, inflight: W2 })
    assert.deepEqual(back, { kind: 'cancel-inflight' })
  })

  test('하루씩 D+14로 넘어갔다가 D+10으로 돌아와도 같음', () => {
    const d14 = addDays(D, 14)
    const go = planForDate({ ...base, date: d14 })
    assert.equal(go.kind, 'load')
    const W2 = go.kind === 'load' ? go.win : null
    assert.ok(W2)
    const d10 = addDays(D, 10)
    assert.equal(windowCovers(W2!, d10), false)
    assert.deepEqual(planForDate({ ...base, date: d10, inflight: W2 }), { kind: 'cancel-inflight' })
  })

  test('버리려는 요청이 있어도 구독한 버전이 자료보다 새것이면 이 날짜 기간을 새로 받음(변경 반영이 빠지지 않게)', () => {
    const W2 = windowFor(addDays(D, 20))
    assert.deepEqual(planForDate({ ...base, date: D, inflight: W2, knownRevision: 6 }), { kind: 'load', win: windowFor(D) })
  })

  test('진행 중 요청이 그 날짜를 포함하면 그대로', () => {
    assert.deepEqual(planForDate({ ...base, date: addDays(D, 20), inflight: windowFor(addDays(D, 19)) }), { kind: 'keep' })
  })

  test('진행 중 요청 없이 받은 자료가 포함하면 그대로(버전이 앞서 있어도 날짜 이동마다 다시 받지 않음)', () => {
    assert.deepEqual(planForDate({ ...base, date: addDays(D, 2) }), { kind: 'keep' })
    assert.deepEqual(planForDate({ ...base, date: addDays(D, 2), knownRevision: 9 }), { kind: 'keep' })
  })

  test('캐시 자료·자료 없음·기간 밖이면 그 날짜 기간을 받음', () => {
    assert.deepEqual(planForDate({ ...base, date: D, fromCache: true }), { kind: 'load', win: windowFor(D) })
    assert.deepEqual(planForDate({ ...base, date: D, payload: null }), { kind: 'load', win: windowFor(D) })
    const far = addDays(D, 30)
    assert.deepEqual(planForDate({ ...base, date: far }), { kind: 'load', win: windowFor(far) })
  })
})

describe('[26] 응답을 반영한 뒤(planAfterLoad)', () => {
  test('응답 기간이 지금 날짜를 포함하지 않으면 그 날짜 기간을 받음(스켈레톤에서 멈추지 않음), 그 응답 뒤에는 끝', () => {
    const W2 = windowFor(addDays(D, 20))
    const first = planAfterLoad({ date: D, win: W2, payload: payloadOf(W2), knownRevision: 5, staleRetries: 0 })
    assert.deepEqual(first, { kind: 'reload-date', win: windowFor(D) })
    const W3 = windowFor(D)
    assert.deepEqual(planAfterLoad({ date: D, win: W3, payload: payloadOf(W3), knownRevision: 5, staleRetries: 0 }), { kind: 'done' })
  })

  test('날짜가 기간 밖이면 버전 재시도보다 날짜 기간 받기가 먼저', () => {
    const W2 = windowFor(addDays(D, 20))
    assert.equal(planAfterLoad({ date: D, win: W2, payload: payloadOf(W2, 5), knownRevision: 8, staleRetries: 0 }).kind, 'reload-date')
  })

  test('조회 도중 버전이 올라가면 같은 기간을 최대 MAX_STALE_RETRIES번 더', () => {
    const W = windowFor(D)
    assert.deepEqual(planAfterLoad({ date: D, win: W, payload: payloadOf(W, 5), knownRevision: 6, staleRetries: 0 }), { kind: 'reload-revision', win: W })
    assert.deepEqual(planAfterLoad({ date: D, win: W, payload: payloadOf(W, 5), knownRevision: 6, staleRetries: MAX_STALE_RETRIES }), { kind: 'done' })
    assert.deepEqual(planAfterLoad({ date: D, win: W, payload: payloadOf(W, 6), knownRevision: 6, staleRetries: 0 }), { kind: 'done' })
  })

  test('날짜가 아직 없으면 날짜 기준 재요청 없음', () => {
    const W = windowFor(D)
    assert.deepEqual(planAfterLoad({ date: null, win: W, payload: payloadOf(W), knownRevision: 0, staleRetries: 0 }), { kind: 'done' })
  })

  test('useMyTimetable이 이 판단을 씀(날짜 effect·성공 응답) — 예전처럼 진행 중 요청을 남긴 채 return하지 않음', () => {
    const s = src('src/lib/timetable/client.ts')
    assert.match(s, /planForDate\(\{/)
    assert.match(s, /planAfterLoad\(\{/)
    assert.match(s, /plan\.kind === 'cancel-inflight'[\s\S]{0,200}seqRef\.current\+\+[\s\S]{0,80}inflightRef\.current = null/)
    assert.doesNotMatch(s, /if \(s\.payload && !s\.fromCache && coversDate\(s\.payload, date\)\) return/)
  })
})

describe('[27] 소속 학급 승인 대기 표시', () => {
  test('수업 초대로만 가입(status pending, classId 없음) → 승인 대기 아님', () => {
    assert.equal(awaitingHomeroomApproval({ status: 'pending', classId: null }), false)
    assert.equal(awaitingHomeroomApproval({ status: 'pending' }), false)
    assert.equal(awaitingHomeroomApproval({ status: 'pending', classId: '' }), false)
    assert.equal(awaitingHomeroomApproval({ status: 'pending', classId: '  ' }), false)
  })

  test('학급 신청 대기(classId 있음) → 승인 대기, 예전 수업 그룹(_g_) 신청도 승인 대기', () => {
    assert.equal(awaitingHomeroomApproval({ status: 'pending', classId: 'S1_3_4' }), true)
    assert.equal(awaitingHomeroomApproval({ status: 'pending', classId: 'S1_3_g_ab12' }), true)
  })

  test('승인됨·거절됨·프로필 없음 → 승인 대기 아님', () => {
    assert.equal(awaitingHomeroomApproval({ status: 'approved', classId: 'S1_3_4' }), false)
    assert.equal(awaitingHomeroomApproval({ status: 'rejected', classId: 'S1_3_4' }), false)
    assert.equal(awaitingHomeroomApproval(null), false)
    assert.equal(awaitingHomeroomApproval(undefined), false)
  })

  test('today.tsx 배너·학급 표시와 courses.tsx 학급 표시가 같은 판단을 씀', () => {
    const today = src('src/pages/student/today.tsx')
    assert.match(today, /\{awaitingHomeroomApproval\(userData\) && \(/)
    assert.doesNotMatch(today, /\{userData\.status === 'pending' && \(/)
    assert.match(today, /awaitingHomeroomApproval\(userData\) \? `\$\{base\} \(승인 대기\)`/)
    const courses = src('src/pages/student/courses.tsx')
    assert.match(courses, /awaitingHomeroomApproval\(p\) \? `\$\{label\} \(승인 대기\)`/)
    assert.doesNotMatch(courses, /p\.status === 'pending' \?/)
  })
})
