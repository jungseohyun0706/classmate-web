// 로그인 판단·로그인 뒤 갈 곳(src/lib/authRouting.ts) 회귀 테스트 — 검토 round2 [0][4][6]
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isSignedInUser, loginPathWithNext, missingProfileStep } from '../../src/lib/authRouting'

describe('[0][4] 둘러보기(익명) 세션은 로그인 안 됨으로 봄 — /student/timetable', () => {
  test('null·undefined는 로그인 안 됨', () => {
    assert.equal(isSignedInUser(null), false)
    assert.equal(isSignedInUser(undefined), false)
  })

  test('익명(/meals 별점 집계가 만든 계정)은 로그인 안 됨 — 가입 미완료(no-profile)로 보내지 않음', () => {
    assert.equal(isSignedInUser({ isAnonymous: true, uid: 'anonUid' }), false)
  })

  test('실제 계정은 로그인됨', () => {
    assert.equal(isSignedInUser({ isAnonymous: false, uid: 'stuA' }), true)
  })

  test('로그인 화면 next에 지금 날짜 주소를 그대로 담음(로그인 뒤 같은 날짜로)', () => {
    const p = loginPathWithNext('/student/timetable?date=20261007', '/student/timetable')
    assert.equal(p, '/auth/login?next=%2Fstudent%2Ftimetable%3Fdate%3D20261007')
    assert.equal(decodeURIComponent(p.split('next=')[1]), '/student/timetable?date=20261007')
  })

  test('지금 주소가 그 화면이 아니면(라우터 준비 전 등) 화면 기본 주소로', () => {
    assert.equal(loginPathWithNext('', '/student/timetable'), '/auth/login?next=%2Fstudent%2Ftimetable')
    assert.equal(loginPathWithNext(null, '/student/timetable'), '/auth/login?next=%2Fstudent%2Ftimetable')
    assert.equal(loginPathWithNext('/meals', '/student/timetable'), '/auth/login?next=%2Fstudent%2Ftimetable')
  })
})

describe('[6] 프로필 없는 계정 + 보관된 초대 — 로그인 화면', () => {
  test('보관된 초대만 있으면(?next 없음) 초대로 자동 이동하지 않고 갈래 화면 + 학생 쪽 이어가기 코드', () => {
    assert.deepEqual(missingProfileStep(null, 'ABCD2345'), { kind: 'choose', resumeCode: 'ABCD2345' })
  })

  test('?next가 초대 경로(초대 화면에서 로그인하고 참여)면 지금처럼 그 초대로 이어감', () => {
    assert.deepEqual(missingProfileStep('/i/ABCD2345', 'ABCD2345'), { kind: 'invite', path: '/i/ABCD2345' })
    assert.deepEqual(missingProfileStep('/i/WXYZ6789', null), { kind: 'invite', path: '/i/WXYZ6789' })
    assert.deepEqual(missingProfileStep('/join?c=S1_3_4&t=tok', 'ABCD2345'), { kind: 'invite', path: '/join?c=S1_3_4&t=tok' })
  })

  test('초대가 전혀 없으면 갈래 화면(이어가기 버튼 없음)', () => {
    assert.deepEqual(missingProfileStep(null, null), { kind: 'choose', resumeCode: null })
    assert.deepEqual(missingProfileStep(null, ''), { kind: 'choose', resumeCode: null })
  })
})
