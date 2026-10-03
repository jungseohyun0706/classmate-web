// 초대(학급·수업 초대 코드) + 기존 QR 링크(/join?c=&t=) 통합 테스트 (지시서 9장·19장·20장)
// 대상: /api/invitations, /api/join, /api/join-info (+ /api/courses·/api/timetable/me로 결과 확인)
// 실행 전제: 실제 서버(BASE, 기본 http://127.0.0.1:3100) + Firebase 에뮬레이터(Firestore 8080, Auth 9099)
//           + NEIS mock(NODE_OPTIONS="--require tests/support/neis-mock.cjs", NEIS_MOCK_FILE)
// 사용: node tests/api/sa3-invitations.test.mjs
// 모든 데이터는 에뮬레이터의 테스트용 가상 데이터이며 실제 학생 정보가 아닙니다.
// 시도 제한(IP 기준)을 일부러 넘기는 요청·실패 요청은 실행마다 다른 가짜 X-Forwarded-For로 보내
// 같은 서버에서 도는 다른 테스트(127.0.0.1)가 막히지 않게 합니다.
import crypto from 'crypto'
import { admin, wipe, createUsers, writeNeisFixture, clientSession, api, reporter, Timestamp, BASE } from '../e2e/lib/env.mjs'

const { check, note, finish } = reporter('api-sa3-invitations')
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099'

// ───────── 날짜(학교 시간대 KST) ─────────
const ymdOf = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
const toDate = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)))
const addDays = (ymd, n) => ymdOf(new Date(toDate(ymd).getTime() + n * 86400000))
const weekdayOf = (ymd) => toDate(ymd).getUTCDay() || 7
const TODAY = ymdOf(new Date(Date.now() + 9 * 3600 * 1000))
const MON = addDays(TODAY, 8 - weekdayOf(TODAY)) // 다음 주 월요일
const SUN = addDays(MON, 6)

const S1 = { schoolCode: 'S1', schoolName: '테스트고등학교', officeCode: 'B10' }
const S2 = { schoolCode: 'S2', schoolName: '다른고등학교', officeCode: 'B10' }
const GROUP = 'S1_3_5_g_engb' // 교사 Y의 예전 영어 수업 그룹(영어 B와 연결)
const GROUP_NOLINK = 'S1_3_4_g_mathx' // 연결된 수업이 없는 그룹
const GROUP_APPR = 'S1_3_4_g_sciap' // 교사 X의 과학 그룹(참여 방식 '승인 필요' 수업과 연결)
const CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/
const FAKE_IP = `10.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}`

function neisFixture() {
  return {
    schools: [
      { SD_SCHUL_CODE: 'S1', SCHUL_NM: '테스트고등학교', SCHUL_KND_SC_NM: '고등학교', ATPT_OFCDC_SC_CODE: 'B10' },
      { SD_SCHUL_CODE: 'S2', SCHUL_NM: '다른고등학교', SCHUL_KND_SC_NM: '고등학교', ATPT_OFCDC_SC_CODE: 'B10' },
    ],
    meals: [],
    timetables: {},
    schedule: [],
  }
}

async function seed() {
  await wipe()
  writeNeisFixture(neisFixture())
  const T = (name, extra = {}, school = S1) => ({ role: 'teacher', name, displayName: name, ...school, ...extra })
  const St = (name, classId, grade, classNm, studentId, school = S1) => ({
    role: 'student',
    status: 'approved',
    name,
    displayName: name,
    classId,
    grade,
    classNm,
    studentId,
    ...school,
  })
  await createUsers([
    { uid: 'hr4', email: 'hr4@e2e.kr', doc: T('김담임', { classId: 'S1_3_4', grade: 3, classNm: 4 }) },
    { uid: 'hr5', email: 'hr5@e2e.kr', doc: T('박담임', { classId: 'S1_3_5', grade: 3, classNm: 5 }) },
    { uid: 'ty', email: 'ty@e2e.kr', doc: T('이영어') }, // 교사 Y: 영어 B, 예전 영어 그룹 소유
    { uid: 'tx', email: 'tx@e2e.kr', doc: T('최과학') }, // 교사 X: 영어 B와 무관
    { uid: 'hr24', email: 'hr24@e2e.kr', doc: T('김담임', { classId: 'S2_3_4' }, S2) },
    { uid: 'stuA', email: 'a@e2e.kr', doc: St('김학생', 'S1_3_4', 3, 4, 7) }, // 3학년 4반 승인 학생
    { uid: 'stuB', email: 'b@e2e.kr', doc: St('이학생', 'S1_3_5', 3, 5, 8) },
    { uid: 'stuC', email: 'c@e2e.kr', doc: St('정학생', 'S1_3_4', 3, 4, 9) },
    { uid: 'stuS2', email: 's2@e2e.kr', doc: St('김학생', 'S2_3_4', 3, 4, 7, S2) }, // 다른 학교 동명 학생
    // 가입 직후(Auth 계정만, users 문서 없음)
    { uid: 'stuNew', email: 'new@e2e.kr' },
    { uid: 'stuNew2', email: 'new2@e2e.kr' },
    { uid: 'stuL', email: 'l@e2e.kr' },
    { uid: 'stuG', email: 'g@e2e.kr' },
    { uid: 'stuG2', email: 'g2@e2e.kr' },
    { uid: 'stuRL', email: 'rl@e2e.kr' },
    // 검토 [16]·[24] 회귀용
    { uid: 'stuRj', email: 'rj@e2e.kr' }, // 가입 직후 → 입장 신청 → 거절 → 같은 날 재신청
    { uid: 'stuX', email: 'x@e2e.kr', doc: St('한학생', 'S1_3_4', 3, 4, 11) }, // 그룹 참여 → 그룹에서 빠짐 → 재참여
    { uid: 'stuY', email: 'y@e2e.kr', doc: St('윤학생', 'S1_3_5', 3, 5, 12) }, // 승인 필요 수업 그룹 QR
    { uid: 'stuZ', email: 'z@e2e.kr', doc: St('조학생', 'S1_3_4', 3, 4, 13) }, // 승인 필요 수업 초대 → 거절 → 재수락
    { uid: 'stuAp', email: 'ap@e2e.kr' }, // 가입 직후 → 승인 필요 수업 그룹 QR
  ])
  const { db } = admin()
  const now = Timestamp.now()
  await db.doc('classes/S1_3_4').set({ classId: 'S1_3_4', grade: 3, classNm: 4, teacherId: 'hr4', teacherName: '김담임', createdAt: now, ...S1 })
  await db.doc('classes/S1_3_5').set({ classId: 'S1_3_5', grade: 3, classNm: 5, teacherId: 'hr5', teacherName: '박담임', createdAt: now, ...S1 })
  await db.doc(`classes/${GROUP}`).set({ classId: GROUP, isGroup: true, grade: 3, classNm: 5, teacherId: 'ty', subjectName: '영어', createdAt: now, ...S1 })
  await db.doc(`classes/${GROUP_NOLINK}`).set({ classId: GROUP_NOLINK, isGroup: true, grade: 3, classNm: 4, teacherId: 'tx', createdAt: now, ...S1 })
  await db.doc(`classes/${GROUP_APPR}`).set({ classId: GROUP_APPR, isGroup: true, grade: 3, classNm: 4, teacherId: 'tx', subjectName: '과학', createdAt: now, ...S1 })
  await db.doc('classes/S2_3_4').set({ classId: 'S2_3_4', grade: 3, classNm: 4, teacherId: 'hr24', teacherName: '김담임', createdAt: now, ...S2 })
}

const sessions = {}
async function tok(email) {
  if (!sessions[email]) sessions[email] = await clientSession(email)
  return sessions[email].token
}
const inv = async (email, body) => api('/api/invitations', email ? await tok(email) : null, body)
const courses = async (email, body) => api('/api/courses', await tok(email), body)
const me = async (email) => api(`/api/timetable/me?from=${MON}&to=${SUN}`, await tok(email), null, 'GET')

/** 가짜 X-Forwarded-For를 붙인 요청(시도 제한 테스트·실패 요청용) */
async function apiFrom(ip, pathname, token, body) {
  const r = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body ?? {}),
  })
  return { status: r.status, j: await r.json().catch(() => ({})) }
}

/** 익명 계정 토큰(둘러보기 /meals가 만드는 계정과 같은 종류) */
async function anonymousToken() {
  const r = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=e2e-fake-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  })
  const j = await r.json()
  if (!j.idToken) throw new Error('anonymous sign-up failed')
  return j.idToken
}

/** 기존 QR 입장 토큰(교사 화면 class-qr가 만드는 것과 같은 모양) */
async function joinToken(classId, ageMs = 0) {
  const { db } = admin()
  const t = crypto.randomBytes(16).toString('hex')
  const createdAt = Timestamp.fromMillis(Date.now() - ageMs)
  await db.doc(`classes/${classId}/joinTokens/${t}`).set({ createdAt, expiresAt: Timestamp.fromMillis(createdAt.toMillis() + 10 * 60 * 1000) })
  return t
}

const userDoc = async (uid) => (await admin().db.doc(`users/${uid}`).get()).data() || null
const enrDoc = async (courseId, uid) => (await admin().db.doc(`schools/S1/enrollments/${courseId}__${uid}`).get()).data() || null
const invDoc = async (code) => (await admin().db.doc(`invitations/${code}`).get()).data() || {}
const countNotes = async (uid, title) => (await admin().db.collection(`users/${uid}/notifications`).where('title', '==', title).get()).size
const noteIds = async (uid, prefix) => (await admin().db.collection(`users/${uid}/notifications`).get()).docs.map((d) => d.id).filter((id) => id.startsWith(prefix))

async function main() {
  await seed()
  const { db } = admin()
  note('setup', `TODAY=${TODAY}, 조회 기간 ${MON}~${SUN}, 실패 요청 IP ${FAKE_IP}`)

  // ───── 수업 준비: 교사 Y의 영어 B(예전 영어 그룹 연결, 화 3교시 3학년 5반 교실) ─────
  const engB = await courses('ty@e2e.kr', {
    action: 'create',
    title: '영어 B',
    subject: '영어',
    section: 'B',
    defaultRoomName: '3학년 5반 교실',
    legacyGroupId: GROUP,
    invitePolicy: 'auto',
  })
  const engBId = engB.j.courseId
  const ser = await courses('ty@e2e.kr', { action: 'addSeries', courseId: engBId, weekday: 2, period: 3, roomName: '3학년 5반 교실' })
  check('setup', '영어 B 수업·차시(화 3교시) 준비', engB.status === 200 && ser.status === 200, `${engB.status}/${ser.status} ${JSON.stringify(engB.j).slice(0, 120)}`)

  // ───── 수업 초대 만들기 ─────
  const c1 = await inv('ty@e2e.kr', { action: 'create', type: 'course', targetId: engBId })
  const CODE = c1.j.code
  const exp30 = Date.now() + 30 * 86400000
  check(
    'T04',
    '교사 Y가 영어 B 수업 초대 생성(8자 코드·XXXX-XXXX·/i/ 상대 링크·기본 30일·무제한)',
    c1.status === 200 && CODE_RE.test(CODE || '') && c1.j.displayCode === `${CODE.slice(0, 4)}-${CODE.slice(4)}` && c1.j.url === `/i/${CODE}` && Math.abs(c1.j.expiresAt - exp30) < 120000 && c1.j.maxUses === null && c1.j.targetLabel === '영어 B',
    JSON.stringify(c1.j).slice(0, 220)
  )
  const xCreate = await inv('tx@e2e.kr', { action: 'create', type: 'course', targetId: engBId })
  check('T40', '담당이 아닌 교사 X의 영어 B 초대 생성 → 403 not-course-teacher', xCreate.status === 403 && xCreate.j.code === 'not-course-teacher', `${xCreate.status} ${xCreate.j.code}`)
  const sCreate = await inv('a@e2e.kr', { action: 'create', type: 'course', targetId: engBId })
  check('T39', '학생의 초대 생성 → 403 teacher-only', sCreate.status === 403 && sCreate.j.code === 'teacher-only', `${sCreate.status} ${sCreate.j.code}`)
  const badExp = await inv('ty@e2e.kr', { action: 'create', type: 'course', targetId: engBId, expiresInDays: 365 })
  const badMax = await inv('ty@e2e.kr', { action: 'create', type: 'course', targetId: engBId, maxUses: 0 })
  check('T31', '만료 1~180일·사용 인원 1 이상만 허용(400 bad-expiry / bad-max-uses)', badExp.j.code === 'bad-expiry' && badMax.j.code === 'bad-max-uses', `${badExp.j.code}/${badMax.j.code}`)

  // ───── 미리보기(로그인 없음, 최소 정보) ─────
  const typed = `${CODE.slice(0, 4).toLowerCase()} - ${CODE.slice(4).toLowerCase()}`
  const pv = await inv(null, { action: 'preview', code: typed })
  check(
    'T04',
    '미리보기: 소문자·하이픈·공백 입력도 같은 코드, 수업·학교·교사 이름 표시',
    pv.status === 200 && pv.j.state === 'ok' && pv.j.type === 'course' && pv.j.targetLabel === '영어 B' && pv.j.teacherName === '이영어' && pv.j.schoolName === '테스트고등학교',
    JSON.stringify(pv.j).slice(0, 220)
  )
  const pvText = JSON.stringify(pv.j)
  check('T46', '미리보기에 학생 명단·uid·발급자 uid·사용 수 없음', !/stu[A-Z]|"ty"|issuedBy"|"uses"|teacherUids/.test(pvText), pvText.slice(0, 200))

  // ───── 학생 A(3학년 4반 승인) 수락 ─────
  const a1 = await inv('a@e2e.kr', { action: 'accept', code: CODE })
  check('T04', '학생 A 수업 초대 수락 → enrolled(active)', a1.status === 200 && a1.j.status === 'enrolled' && a1.j.enrollmentStatus === 'active' && a1.j.courseId === engBId && a1.j.next === '/student/timetable', JSON.stringify(a1.j))
  const uA = await userDoc('stuA')
  check(
    'T04',
    '학생 A 소속은 그대로 3학년 4반·승인(수업 교실·그룹으로 바뀌지 않음), 연결 그룹은 extraClassIds',
    uA.classId === 'S1_3_4' && uA.grade === 3 && uA.classNm === 4 && uA.status === 'approved' && (uA.extraClassIds || []).includes(GROUP),
    JSON.stringify({ classId: uA.classId, grade: uA.grade, classNm: uA.classNm, status: uA.status, extra: uA.extraClassIds })
  )
  const eA = await enrDoc(engBId, 'stuA')
  check('T02', '수강 문서 courseId__uid: active, source invite, invitationCode, from=오늘', eA?.status === 'active' && eA?.source === 'invite' && eA?.invitationCode === CODE && eA?.from === TODAY, JSON.stringify(eA && { s: eA.status, src: eA.source, from: eA.from }))
  const a2 = await inv('a@e2e.kr', { action: 'accept', code: CODE })
  const invAfterA = await invDoc(CODE)
  const usesA = (await db.collection(`invitations/${CODE}/uses`).get()).size
  check('T05', '같은 학생 두 번 수락 → already, 사용 수 1·사용 기록 1', a2.status === 200 && a2.j.status === 'already' && a2.j.enrollmentStatus === 'active' && invAfterA.uses === 1 && usesA === 1, `${JSON.stringify(a2.j)} uses=${invAfterA.uses}/${usesA}`)
  const pA = await me('a@e2e.kr')
  const tue = addDays(MON, 1)
  const engSeries = (pA.j.series || []).filter((s) => s.courseId === engBId)
  check(
    'T04',
    '/api/timetable/me: 소속 3학년 4반 + 참여 수업 영어 B(화 3교시 3학년 5반 교실)',
    pA.status === 200 && pA.j.homeroom?.classId === 'S1_3_4' && (pA.j.courses || []).some((c) => c.courseId === engBId) && engSeries.length === 1 && engSeries[0].weekday === 2 && engSeries[0].period === 3 && engSeries[0].roomName === '3학년 5반 교실',
    JSON.stringify({ hr: pA.j.homeroom, series: engSeries, tue })
  )

  // ───── 다인용 + 더블 탭 ─────
  const b1 = await inv('b@e2e.kr', { action: 'accept', code: CODE })
  check('T06', '학생 B도 같은 코드 사용(첫 사용에 소진되지 않음)', b1.status === 200 && b1.j.status === 'enrolled', JSON.stringify(b1.j))
  const [c1a, c1b] = await Promise.all([inv('c@e2e.kr', { action: 'accept', code: CODE }), inv('c@e2e.kr', { action: 'accept', code: CODE })])
  const cStatuses = [c1a.j.status, c1b.j.status].sort().join(',')
  const invAfterC = await invDoc(CODE)
  const enrC = (await db.collection('schools/S1/enrollments').where('uid', '==', 'stuC').get()).size
  check('T05', '더블 탭(동시 두 요청) → enrolled 1번 + already 1번, 수강 1건, 사용 수 +1', cStatuses === 'already,enrolled' && enrC === 1 && invAfterC.uses === 3, `${cStatuses} enr=${enrC} uses=${invAfterC.uses}`)

  // ───── 잘못된 초대: 회수·만료·다른 학교·종료·없음·인원 초과 ─────
  const r1 = await inv('ty@e2e.kr', { action: 'create', type: 'course', targetId: engBId })
  const rv = await inv('ty@e2e.kr', { action: 'revoke', code: r1.j.displayCode })
  const rv2 = await inv('ty@e2e.kr', { action: 'revoke', code: r1.j.code })
  const xRevoke = await inv('tx@e2e.kr', { action: 'revoke', code: CODE })
  check('T07', '발급자 회수(재요청 already), 담당 아닌 교사 회수 → 403', rv.status === 200 && rv.j.revoked === true && rv2.j.already === true && xRevoke.status === 403 && xRevoke.j.code === 'not-invite-owner', `${rv.status}/${rv2.j.already}/${xRevoke.status} ${xRevoke.j.code}`)
  const pvRevoked = await inv(null, { action: 'preview', code: r1.j.code })
  const acRevoked = await inv('b@e2e.kr', { action: 'accept', code: r1.j.code })

  const e1 = await inv('ty@e2e.kr', { action: 'create', type: 'course', targetId: engBId, expiresInDays: 1 })
  await db.doc(`invitations/${e1.j.code}`).update({ expiresAt: Timestamp.fromMillis(Date.now() - 60000) })
  const pvExpired = await inv(null, { action: 'preview', code: e1.j.code })
  const acExpired = await inv('b@e2e.kr', { action: 'accept', code: e1.j.code })

  const acOther = await inv('s2@e2e.kr', { action: 'accept', code: CODE })

  const engD = await courses('ty@e2e.kr', { action: 'create', title: '영어 D', subject: '영어', section: 'D' })
  const d1 = await inv('ty@e2e.kr', { action: 'create', type: 'course', targetId: engD.j.courseId })
  const endD = await courses('ty@e2e.kr', { action: 'end', courseId: engD.j.courseId, endedOn: TODAY })
  const pvEnded = await inv(null, { action: 'preview', code: d1.j.code })
  const acEnded = await inv('a@e2e.kr', { action: 'accept', code: d1.j.code })
  const createEnded = await inv('ty@e2e.kr', { action: 'create', type: 'course', targetId: engD.j.courseId })

  const pvMissing = await apiFrom(FAKE_IP, '/api/invitations', null, { action: 'preview', code: 'ZZZZ-ZZZZ' })
  const pvBad = await apiFrom(FAKE_IP, '/api/invitations', null, { action: 'preview', code: 'O0I1-L' })

  const m1 = await inv('ty@e2e.kr', { action: 'create', type: 'course', targetId: engBId, maxUses: 1 })
  const m1a = await inv('a@e2e.kr', { action: 'accept', code: m1.j.code })
  const m1b = await inv('b@e2e.kr', { action: 'accept', code: m1.j.code })
  const m1a2 = await inv('a@e2e.kr', { action: 'accept', code: m1.j.code })
  const pvUsedUp = await inv(null, { action: 'preview', code: m1.j.code })

  check('T07', '회수된 초대: 미리보기·수락 410 revoked(대상 정보는 표시)', pvRevoked.status === 410 && pvRevoked.j.code === 'revoked' && pvRevoked.j.state === 'revoked' && pvRevoked.j.targetLabel === '영어 B' && acRevoked.status === 410 && acRevoked.j.code === 'revoked', `${pvRevoked.status} ${pvRevoked.j.code} / ${acRevoked.status} ${acRevoked.j.code}`)
  check('T07', '만료된 초대: 미리보기·수락 410 expired', pvExpired.status === 410 && pvExpired.j.code === 'expired' && acExpired.status === 410 && acExpired.j.code === 'expired', `${pvExpired.status} ${pvExpired.j.code} / ${acExpired.status} ${acExpired.j.code}`)
  check('T07', '다른 학교 학생 수락 → 403 other-school(수강 생성 안 됨)', acOther.status === 403 && acOther.j.code === 'other-school' && !(await admin().db.doc(`schools/S1/enrollments/${engBId}__stuS2`).get()).exists, `${acOther.status} ${acOther.j.code}`)
  check('T07', '종료 수업 초대: 미리보기·수락 410 ended, 새 초대 생성 409 course-ended', endD.status === 200 && pvEnded.status === 410 && pvEnded.j.code === 'ended' && acEnded.status === 410 && acEnded.j.code === 'ended' && createEnded.status === 409 && createEnded.j.code === 'course-ended', `${pvEnded.status} ${pvEnded.j.code} / ${acEnded.j.code} / ${createEnded.j.code}`)
  check('T07', '없는 코드 404 not-found, 형식 오류 400 bad-code', pvMissing.status === 404 && pvMissing.j.code === 'not-found' && pvBad.status === 400 && pvBad.j.code === 'bad-code', `${pvMissing.status} ${pvMissing.j.code} / ${pvBad.status} ${pvBad.j.code}`)
  check('T07', '인원 1명 초대: 첫 학생 수락, 다음 학생 410 used-up, 첫 학생 재요청은 already', m1a.j.status === 'already' && m1b.status === 410 && m1b.j.code === 'used-up' && m1a2.status === 200 && m1a2.j.status === 'already' && pvUsedUp.j.code === 'used-up', `${m1a.j.status}/${m1b.status} ${m1b.j.code}/${m1a2.j.status}/${pvUsedUp.j.code}`)
  const codes = new Set([pvRevoked.j.code, pvExpired.j.code, acOther.j.code, pvEnded.j.code, pvMissing.j.code, m1b.j.code])
  check('T07', '사유별 code가 모두 다름(만료·회수·다른 학교·종료·없음·인원 초과)', codes.size === 6, Array.from(codes).join(','))
  check('T46', '오류 응답에 초대 코드 원문이 다시 나오지 않음', !JSON.stringify([pvRevoked.j, acExpired.j, acOther.j]).includes(r1.j.code) && !JSON.stringify(acExpired.j).includes(e1.j.code), '')

  // ───── 계정 종류 ─────
  const anon = await api('/api/invitations', await anonymousToken(), { action: 'accept', code: CODE })
  const tAcc = await inv('hr4@e2e.kr', { action: 'accept', code: CODE })
  const noAuth = await inv(null, { action: 'accept', code: CODE })
  check('T10', '익명 계정 수락 → 403 anonymous', anon.status === 403 && anon.j.code === 'anonymous', `${anon.status} ${anon.j.code}`)
  check('T10', '교사 계정 수락 → 403 teacher-account(초대로 학생 수강·권한 생기지 않음)', tAcc.status === 403 && tAcc.j.code === 'teacher-account' && !(await admin().db.doc(`schools/S1/enrollments/${engBId}__hr4`).get()).exists, `${tAcc.status} ${tAcc.j.code}`)
  check('T08', '로그인 없이 수락 → 401 unauthenticated(미리보기는 로그인 없이 가능)', noAuth.status === 401 && noAuth.j.code === 'unauthenticated', `${noAuth.status} ${noAuth.j.code}`)

  // ───── 가입 직후(프로필 없음) 학생의 수업 초대 수락 ─────
  const noName = await inv('new2@e2e.kr', { action: 'accept', code: CODE })
  check('T02', '프로필 없는 학생이 이름 없이 수업 초대 수락 → 400 name-required(프로필 만들지 않음)', noName.status === 400 && noName.j.code === 'name-required' && !(await userDoc('stuNew2')), `${noName.status} ${noName.j.code}`)
  const nw = await inv('new@e2e.kr', { action: 'accept', code: CODE, name: '새학생', studentId: '12' })
  const uNew = await userDoc('stuNew')
  check('T02', '가입 직후 학생 수업 초대 수락 → enrolled + profileCreated', nw.status === 200 && nw.j.status === 'enrolled' && nw.j.profileCreated === true, JSON.stringify(nw.j))
  check(
    'T02',
    '새 프로필: role student, status pending, classId null(수업 교실·그룹을 소속으로 쓰지 않음), 학교 S1, uid 일치 수강',
    uNew?.role === 'student' && uNew?.status === 'pending' && uNew?.classId === null && uNew?.schoolCode === 'S1' && uNew?.name === '새학생' && (await enrDoc(engBId, 'stuNew'))?.uid === 'stuNew',
    JSON.stringify(uNew && { role: uNew.role, status: uNew.status, classId: uNew.classId, school: uNew.schoolCode, grade: uNew.grade })
  )
  const pNew = await me('new@e2e.kr')
  check('T02', '가입 직후 학생 /api/timetable/me: 소속 없음(homeroom null) + 영어 B 수업', pNew.status === 200 && pNew.j.homeroom === null && (pNew.j.courses || []).some((c) => c.courseId === engBId) && (pNew.j.series || []).some((s) => s.courseId === engBId), `${pNew.status} ${JSON.stringify({ hr: pNew.j.homeroom, n: (pNew.j.courses || []).length, code: pNew.j.code })}`)

  // ───── 학급 초대 ─────
  const h1 = await inv('hr4@e2e.kr', { action: 'create', type: 'homeroom', targetId: 'S1_3_4' })
  const hy = await inv('ty@e2e.kr', { action: 'create', type: 'homeroom', targetId: 'S1_3_4' })
  const hg = await inv('ty@e2e.kr', { action: 'create', type: 'homeroom', targetId: GROUP })
  check('T40', '학급 초대: 담임만 생성(다른 교사 403), 수업 그룹은 학급 초대 불가(400 not-homeroom)', h1.status === 200 && h1.j.targetLabel === '3학년 4반' && hy.status === 403 && hy.j.code === 'not-homeroom-teacher' && hg.status === 400 && hg.j.code === 'not-homeroom', `${h1.status} ${h1.j.targetLabel} / ${hy.j.code} / ${hg.j.code}`)
  const HCODE = h1.j.code
  const hpv = await inv(null, { action: 'preview', code: HCODE })
  check('T02', '학급 초대 미리보기: homeroom, 3학년 4반, 담임 이름', hpv.status === 200 && hpv.j.type === 'homeroom' && hpv.j.targetLabel === '3학년 4반' && hpv.j.teacherName === '김담임', JSON.stringify(hpv.j).slice(0, 200))
  const hn1 = await inv('new2@e2e.kr', { action: 'accept', code: HCODE, name: '둘째학생', studentId: '3' })
  const hn2 = await inv('new2@e2e.kr', { action: 'accept', code: HCODE, name: '둘째학생' })
  const uNew2 = await userDoc('stuNew2')
  check('T02', '신규 학생 학급 초대 수락 → homeroom-pending(그 반 승인 대기, 학년·반 기록)', hn1.status === 200 && hn1.j.status === 'homeroom-pending' && uNew2?.classId === 'S1_3_4' && uNew2?.status === 'pending' && uNew2?.grade === 3 && uNew2?.classNm === 4, `${JSON.stringify(hn1.j)} ${JSON.stringify(uNew2 && { c: uNew2.classId, s: uNew2.status })}`)
  check('T05', '학급 초대 재수락 → already, 담임 알림 1건만', hn2.j.status === 'already' && (await countNotes('hr4', '새 학생 입장 신청')) === 1, `${hn2.j.status} notes=${await countNotes('hr4', '새 학생 입장 신청')}`)
  const hNew = await inv('new@e2e.kr', { action: 'accept', code: HCODE })
  const uNewH = await userDoc('stuNew')
  check('T04', '수업 초대로 가입한 학생이 학급 초대 수락 → 소속 신청(3-4 pending), 수강(영어 B)은 그대로', hNew.j.status === 'homeroom-pending' && uNewH?.classId === 'S1_3_4' && uNewH?.status === 'pending' && (await enrDoc(engBId, 'stuNew'))?.status === 'active', `${hNew.status} ${JSON.stringify(hNew.j)}`)
  const hB = await inv('b@e2e.kr', { action: 'accept', code: HCODE })
  const uB = await userDoc('stuB')
  check('T04', '다른 반(3-5) 승인 학생의 3-4 학급 초대 → move-pending, 소속 3-5 유지', hB.j.status === 'move-pending' && uB.classId === 'S1_3_5' && uB.status === 'approved' && uB.pendingClassId === 'S1_3_4', `${JSON.stringify(hB.j)} ${uB.classId}/${uB.pendingClassId}`)
  const hS2 = await inv('s2@e2e.kr', { action: 'accept', code: HCODE })
  const hT = await inv('hr5@e2e.kr', { action: 'accept', code: HCODE })
  check('T07', '다른 학교 학생 학급 초대 → 403 other-school, 교사 → 403 teacher-account', hS2.status === 403 && hS2.j.code === 'other-school' && hT.status === 403 && hT.j.code === 'teacher-account', `${hS2.j.code}/${hT.j.code}`)

  // ───── 목록 ─────
  const lh = await inv('hr4@e2e.kr', { action: 'list', targetId: 'S1_3_4' })
  const lhRow = (lh.j.invitations || []).find((r) => r.code === HCODE)
  check('T06', '담임 목록: 코드·만료·회수·사용 수(신규 2명 + 반 이동 신청 1명 = 3, 거부된 수락은 세지 않음, 명단 없음)', lh.status === 200 && lhRow && lhRow.uses === 3 && lhRow.state === 'ok' && lhRow.revoked === false && !JSON.stringify(lh.j).includes('stuNew'), JSON.stringify(lhRow))
  const ly = await inv('ty@e2e.kr', { action: 'list', targetId: engBId })
  const states = new Set((ly.j.invitations || []).map((r) => r.state))
  check('T07', '교사 Y 수업 초대 목록에 상태(ok·revoked·expired·used-up) 구분', ly.status === 200 && ['ok', 'revoked', 'expired', 'used-up'].every((s) => states.has(s)), Array.from(states).join(','))
  const lx = await inv('tx@e2e.kr', { action: 'list', targetId: 'S1_3_4' })
  check('T40', '담임 아닌 교사의 학급 초대 목록 → 403', lx.status === 403, `${lx.status} ${lx.j.code}`)

  // ───── 기존 /join?c=&t= 링크 호환(T42) ─────
  const t35 = await joinToken('S1_3_5')
  const ji = await api('/api/join-info', null, { classId: 'S1_3_5', token: t35 })
  check('T42', '기존 링크 join-info 200(학교·학년·반·담임, 그룹 아님)', ji.status === 200 && ji.j.classInfo?.schoolName === '테스트고등학교' && ji.j.classInfo?.grade === 3 && ji.j.classInfo?.classNm === 5 && ji.j.classInfo?.teacherName === '박담임' && ji.j.classInfo?.isGroup === false, JSON.stringify(ji.j))
  const jL1 = await api('/api/join', await tok('l@e2e.kr'), { classId: 'S1_3_5', token: t35, name: '엘학생', studentId: '5' })
  const jL2 = await api('/api/join', await tok('l@e2e.kr'), { classId: 'S1_3_5', token: t35, name: '엘학생' })
  const uL = await userDoc('stuL')
  check('T42', '기존 링크 /api/join 신규 학생 → pending(3-5, 학년·반 기록)', jL1.status === 200 && jL1.j.status === 'pending' && uL?.classId === 'S1_3_5' && uL?.grade === 3 && uL?.classNm === 5 && uL?.status === 'pending', `${JSON.stringify(jL1.j)} ${JSON.stringify(uL && { c: uL.classId, g: uL.grade })}`)
  check('T05', '같은 반 재신청 → pending already, 담임 알림·푸시 1건만', jL2.status === 200 && jL2.j.status === 'pending' && jL2.j.already === true && (await countNotes('hr5', '새 학생 입장 신청')) === 1, `${JSON.stringify(jL2.j)} notes=${await countNotes('hr5', '새 학생 입장 신청')}`)
  const tOld = await joinToken('S1_3_5', 11 * 60 * 1000)
  const jiOld = await api('/api/join-info', null, { classId: 'S1_3_5', token: tOld })
  const jOld = await api('/api/join', await tok('l@e2e.kr'), { classId: 'S1_3_5', token: tOld, name: '엘학생' })
  const jiMissing = await apiFrom(FAKE_IP, '/api/join-info', null, { classId: 'S1_3_5', token: crypto.randomBytes(16).toString('hex') })
  const jiBad = await apiFrom(FAKE_IP, '/api/join-info', null, { classId: 'S1_3_5', token: 'xyz' })
  check('T42', '지난 링크(10분 경과) → join-info·join 410 expired(재발급 안내)', jiOld.status === 410 && jiOld.j.code === 'expired' && jOld.status === 410 && jOld.j.code === 'expired', `${jiOld.status} ${jiOld.j.code} / ${jOld.status} ${jOld.j.code}`)
  check('T35', 'join-info 오류 구분: 없는 토큰 404 not-found, 형식 오류 400 bad-request(모두 만료로 보이지 않음)', jiMissing.status === 404 && jiMissing.j.code === 'not-found' && jiBad.status === 400 && jiBad.j.code === 'bad-request', `${jiMissing.status} ${jiMissing.j.code} / ${jiBad.status} ${jiBad.j.code}`)
  const jAnon = await api('/api/join', await anonymousToken(), { classId: 'S1_3_5', token: t35, name: '익명' })
  check('T10', '기존 링크도 익명 계정 → 403 anonymous', jAnon.status === 403 && jAnon.j.code === 'anonymous', `${jAnon.status} ${jAnon.j.code}`)

  // ───── H2: 승인 전 학생이 수업 그룹 QR → 신청해 둔 실반 유지 ─────
  const tg = await joinToken(GROUP)
  const jig = await api('/api/join-info', null, { classId: GROUP, token: tg })
  check('R01', '그룹 링크 join-info에 연결된 수업 제목(영어 B)·담당 교사 이름', jig.status === 200 && jig.j.classInfo?.isGroup === true && jig.j.classInfo?.courseTitle === '영어 B' && jig.j.classInfo?.teacherName === '이영어', JSON.stringify(jig.j))
  const jLg = await api('/api/join', await tok('l@e2e.kr'), { classId: GROUP, token: tg, name: '엘학생' })
  const uLg = await userDoc('stuL')
  check(
    'T04',
    'H2: 3-5 신청 중(미승인) 학생이 그룹 QR → joined-extra-pending, classId·학년·반·status 그대로, 그룹은 extraClassIds',
    jLg.status === 200 && jLg.j.status === 'joined-extra-pending' && uLg.classId === 'S1_3_5' && uLg.grade === 3 && uLg.classNm === 5 && uLg.status === 'pending' && (uLg.extraClassIds || []).includes(GROUP),
    `${JSON.stringify(jLg.j)} ${JSON.stringify({ c: uLg.classId, g: uLg.grade, s: uLg.status, x: uLg.extraClassIds })}`
  )
  const hr5Pending = (await db.collection('users').where('classId', '==', 'S1_3_5').where('status', '==', 'pending').get()).docs.map((d) => d.id)
  const eL = await enrDoc(engBId, 'stuL')
  check('T04', 'H2: 담임(3-5) 승인 대기 목록에 그대로 + 그룹 연결 수업 영어 B 수강(source invite)', hr5Pending.includes('stuL') && eL?.status === 'active' && eL?.source === 'invite' && eL?.via === 'group-qr', JSON.stringify({ pending: hr5Pending.length, e: eL && { s: eL.status, src: eL.source } }))

  // ───── R01: 새 학생이 연결된 수업이 있는 그룹 QR로 입장 → 개인 시간표에 수업 ─────
  const revBefore = Number((await db.doc('schools/S1').get()).get('scheduleRevision') || 0)
  const jG = await api('/api/join', await tok('g@e2e.kr'), { classId: GROUP, token: tg, name: '지학생' })
  const uG = await userDoc('stuG')
  const revAfter = Number((await db.doc('schools/S1').get()).get('scheduleRevision') || 0)
  check('R01', '새 학생 그룹 QR → pending(그룹이 임시 소속, 학년·반 비움) + 영어 B 수강 active', jG.status === 200 && jG.j.status === 'pending' && uG.classId === GROUP && uG.grade === null && (jG.j.courses || []).some((c) => c.courseId === engBId && c.status === 'active'), `${JSON.stringify(jG.j)}`)
  check('T36', '그룹 QR로 수강이 생기면 scheduleRevision 증가(학생 화면 갱신 신호)', revAfter === revBefore + 1, `${revBefore} → ${revAfter}`)
  const pG = await me('g@e2e.kr')
  const gSeries = (pG.j.series || []).filter((s) => s.courseId === engBId)
  check(
    'R01',
    '그룹 QR 학생 /api/timetable/me: 영어 B 수업·화 3교시 차시(학급 시간표 대신 표시 아님), 소속은 그룹(예전 데이터 표시)',
    pG.status === 200 && (pG.j.enrollments || []).some((e) => e.courseId === engBId && e.status === 'active') && gSeries.length === 1 && gSeries[0].period === 3 && pG.j.homeroom?.isGroupLegacy === true && pG.j.legacyClassTimetableAvailable === false,
    `${pG.status} ${JSON.stringify({ hr: pG.j.homeroom, n: gSeries.length, code: pG.j.code })}`
  )
  const jG2 = await api('/api/join', await tok('g@e2e.kr'), { classId: GROUP, token: tg, name: '지학생' })
  const enrG = (await db.collection('schools/S1/enrollments').where('uid', '==', 'stuG').get()).size
  check('T05', '그룹 QR 재입장 → already, 수강 1건', jG2.j.already === true && enrG === 1, `${JSON.stringify(jG2.j)} enr=${enrG}`)
  const tn = await joinToken(GROUP_NOLINK)
  const jN = await api('/api/join', await tok('g2@e2e.kr'), { classId: GROUP_NOLINK, token: tn, name: '지이학생' })
  const enrN = (await db.collection('schools/S1/enrollments').where('uid', '==', 'stuG2').get()).size
  const pN = await me('g2@e2e.kr')
  check('T32', '연결된 수업이 없는 그룹 QR → 수강을 만들지 않음(임의 시간표 없음)', jN.status === 200 && (jN.j.courses || []).length === 0 && enrN === 0 && pN.status === 200 && (pN.j.courses || []).length === 0, `${JSON.stringify(jN.j)} enr=${enrN}`)
  const jA = await api('/api/join', await tok('a@e2e.kr'), { classId: GROUP, token: tg, name: '김학생' })
  check('T05', '이미 영어 B 수강 중인 승인 학생 A가 그룹 QR → joined-extra already, 수강 중복 없음', jA.j.status === 'joined-extra' && jA.j.already === true && (jA.j.courses || []).every((c) => c.status === 'active'), JSON.stringify(jA.j))
  const jS2 = await api('/api/join', await tok('s2@e2e.kr'), { classId: 'S1_3_5', token: t35, name: '김학생' })
  check('T07', '기존 링크: 다른 학교 승인 학생 → 403 other-school', jS2.status === 403 && jS2.j.code === 'other-school', `${jS2.status} ${jS2.j.code}`)

  // ───── 검토 [16]: 정당한 재신청은 다시 알림(거절 뒤 같은 날 재신청, 그룹에서 뺀 뒤 재참여), 같은 신청 재전송은 1건 ─────
  const t34 = await joinToken('S1_3_4')
  const hr4Join0 = await countNotes('hr4', '새 학생 입장 신청')
  const jRj1 = await api('/api/join', await tok('rj@e2e.kr'), { classId: 'S1_3_4', token: t34, name: '알학생', studentId: '21' })
  const jRj1b = await api('/api/join', await tok('rj@e2e.kr'), { classId: 'S1_3_4', token: t34, name: '알학생' })
  const hr4Join1 = await countNotes('hr4', '새 학생 입장 신청')
  check('R16a', '입장 신청 + 같은 신청 재전송(더블 탭) → 담임 알림 1건', jRj1.j.status === 'pending' && jRj1b.j.already === true && hr4Join1 === hr4Join0 + 1, `${jRj1.j.status}/${jRj1b.j.already} ${hr4Join0}→${hr4Join1}`)
  // 담임 거절(교사 화면 decidePending과 같은 값: status만 rejected)
  await db.doc('users/stuRj').update({ status: 'rejected' })
  const jRj2 = await api('/api/join', await tok('rj@e2e.kr'), { classId: 'S1_3_4', token: t34, name: '알학생' })
  const hr4Join2 = await countNotes('hr4', '새 학생 입장 신청')
  const rjIds = await noteIds('hr4', 'join_S1_3_4__stuRj_')
  check('R16a', '거절된 학생이 같은 날 다시 신청 → pending + 담임에게 새 알림(신청마다 다른 id)', jRj2.status === 200 && jRj2.j.status === 'pending' && !jRj2.j.already && hr4Join2 === hr4Join0 + 2 && rjIds.length === 2 && (await userDoc('stuRj')).status === 'pending', `${JSON.stringify(jRj2.j)} ${hr4Join0}→${hr4Join2} ids=${rjIds.join(',')}`)

  const tyExtra0 = await countNotes('ty', '수업 반 참여')
  const jX1 = await api('/api/join', await tok('x@e2e.kr'), { classId: GROUP, token: tg, name: '한학생' })
  const jX1b = await api('/api/join', await tok('x@e2e.kr'), { classId: GROUP, token: tg, name: '한학생' })
  const tyExtra1 = await countNotes('ty', '수업 반 참여')
  check('R16b', '승인 학생 그룹 참여 + 재전송 → 그룹 교사 알림 1건', jX1.j.status === 'joined-extra' && !jX1.j.already && jX1b.j.already === true && tyExtra1 === tyExtra0 + 1, `${jX1.j.status}/${jX1b.j.already} ${tyExtra0}→${tyExtra1}`)
  const rmX = await api('/api/class-membership', await tok('ty@e2e.kr'), { action: 'remove-extra', classId: GROUP, studentUid: 'stuX' })
  const xAfterRm = await userDoc('stuX')
  const jX2 = await api('/api/join', await tok('x@e2e.kr'), { classId: GROUP, token: tg, name: '한학생' })
  const tyExtra2 = await countNotes('ty', '수업 반 참여')
  check('R16b', '그룹에서 뺀 학생이 다시 그룹 QR → joined-extra + 그룹 교사에게 새 알림', rmX.status === 200 && !(xAfterRm.extraClassIds || []).includes(GROUP) && jX2.j.status === 'joined-extra' && !jX2.j.already && tyExtra2 === tyExtra0 + 2 && ((await userDoc('stuX')).extraClassIds || []).includes(GROUP), `rm=${rmX.status} ${JSON.stringify(jX2.j)} ${tyExtra0}→${tyExtra2}`)

  // ───── 검토 [24]: 그룹 QR도 연결 수업의 참여 방식 '승인 필요'를 따름(pending + 담당 교사 수강 승인 요청) ─────
  const sciA = await courses('tx@e2e.kr', { action: 'create', title: '과학 A', subject: '과학', section: 'A', legacyGroupId: GROUP_APPR, invitePolicy: 'approval' })
  const sciId = sciA.j.courseId
  const sciSer = await courses('tx@e2e.kr', { action: 'addSeries', courseId: sciId, weekday: 4, period: 2, roomName: '과학실' })
  check('R24', "준비: 교사 X의 과학 A(과학 그룹 연결, 참여 방식 'approval')·차시(목 2교시)", sciA.status === 200 && sciSer.status === 200, `${sciA.status}/${sciSer.status} ${JSON.stringify(sciA.j).slice(0, 120)}`)
  const tap = await joinToken(GROUP_APPR)
  const apprNotes0 = await countNotes('tx', '수강 승인 요청')
  const jY = await api('/api/join', await tok('y@e2e.kr'), { classId: GROUP_APPR, token: tap, name: '윤학생' })
  const eY = await enrDoc(sciId, 'stuY')
  const apprNotes1 = await countNotes('tx', '수강 승인 요청')
  check(
    'R24',
    '승인 학생이 승인 필요 수업 그룹 QR → 그룹은 추가 참여, 수강은 pending(바로 active 아님) + 담당 교사 수강 승인 요청 1건',
    jY.status === 200 && jY.j.status === 'joined-extra' && (jY.j.courses || []).some((c) => c.courseId === sciId && c.status === 'pending') && eY?.status === 'pending' && eY?.from === null && apprNotes1 === apprNotes0 + 1,
    `${JSON.stringify(jY.j)} enr=${eY?.status} notes ${apprNotes0}→${apprNotes1}`
  )
  const pY = await me('y@e2e.kr')
  // /me는 수강 상태와 함께 원자료를 주고 화면(엔진)이 active 수강만 시간표에 넣음 → 수강 상태로 확인
  const yEnr = (pY.j.enrollments || []).filter((e) => e.courseId === sciId)
  check('R24', '승인 전 /api/timetable/me: 과학 A 수강은 pending뿐(active 없음 → 시간표에 수업으로 나오지 않음)', pY.status === 200 && yEnr.length === 1 && yEnr[0].status === 'pending', `${pY.status} ${JSON.stringify(yEnr)}`)
  const jY2 = await api('/api/join', await tok('y@e2e.kr'), { classId: GROUP_APPR, token: tap, name: '윤학생' })
  check('R24', '같은 그룹 QR 재전송 → already, 수강 pending 그대로, 승인 요청 알림 추가 없음', jY2.j.already === true && (jY2.j.courses || []).every((c) => c.status === 'pending') && (await countNotes('tx', '수강 승인 요청')) === apprNotes0 + 1, JSON.stringify(jY2.j))
  const jAp = await api('/api/join', await tok('ap@e2e.kr'), { classId: GROUP_APPR, token: tap, name: '에이학생' })
  check('R24', '가입 직후 학생도 승인 필요 수업은 pending(그룹 입장 신청과 별개로 수강 승인 요청)', jAp.status === 200 && jAp.j.status === 'pending' && (await enrDoc(sciId, 'stuAp'))?.status === 'pending' && (await countNotes('tx', '수강 승인 요청')) === apprNotes0 + 2, JSON.stringify(jAp.j))
  // 교사가 수강을 거절한 뒤 학생이 같은 날 다시 그룹 QR → 다시 승인 대기 + 새 승인 요청(같은 날 id로 막히지 않음)
  const rjY = await api('/api/enrollments', await tok('tx@e2e.kr'), { action: 'reject', courseId: sciId, uid: 'stuY' })
  const jY3 = await api('/api/join', await tok('y@e2e.kr'), { classId: GROUP_APPR, token: tap, name: '윤학생' })
  check('R24', '수강 거절 뒤 같은 날 그룹 QR 재참여 → pending + 새 수강 승인 요청', rjY.status === 200 && (jY3.j.courses || []).some((c) => c.courseId === sciId && c.status === 'pending') && (await enrDoc(sciId, 'stuY'))?.status === 'pending' && (await countNotes('tx', '수강 승인 요청')) === apprNotes0 + 3, `rej=${rjY.status} ${JSON.stringify(jY3.j)}`)
  // 같은 규칙: 수업 초대 수락도 거절 뒤 같은 날 다시 수락하면 새 승인 요청
  const sciInv = await inv('tx@e2e.kr', { action: 'create', type: 'course', targetId: sciId })
  const z1 = await inv('z@e2e.kr', { action: 'accept', code: sciInv.j.code })
  const rjZ = await api('/api/enrollments', await tok('tx@e2e.kr'), { action: 'reject', courseId: sciId, uid: 'stuZ' })
  const z2 = await inv('z@e2e.kr', { action: 'accept', code: sciInv.j.code })
  check('R24', '승인 필요 수업 초대: 수락 pending → 거절 → 같은 날 재수락 pending, 승인 요청 2건', z1.j.status === 'pending' && rjZ.status === 200 && z2.j.status === 'pending' && (await countNotes('tx', '수강 승인 요청')) === apprNotes0 + 5, `${z1.j.status}/${rjZ.status}/${z2.j.status} notes=${await countNotes('tx', '수강 승인 요청')}`)

  // ───── 시도 제한 ─────
  const rlIp = `10.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}`
  let firstBlock = -1
  for (let i = 0; i < 40 && firstBlock < 0; i++) {
    const r = await apiFrom(rlIp, '/api/invitations', null, { action: 'preview', code: crypto.randomBytes(4).toString('hex') + 'zz' })
    if (r.status === 429) firstBlock = i
  }
  const stillOk = await inv(null, { action: 'preview', code: CODE })
  check('T46', '없는 코드 연속 미리보기 → 30회 뒤 429 rate-limited(다른 IP의 정상 미리보기는 영향 없음)', firstBlock === 30 && stillOk.status === 200, `blocked at ${firstBlock}, other ip ${stillOk.status}`)
  const rlTok = await tok('rl@e2e.kr')
  const rlIp2 = `10.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}`
  let uidBlock = -1
  for (let i = 0; i < 15 && uidBlock < 0; i++) {
    const r = await apiFrom(rlIp2, '/api/invitations', rlTok, { action: 'accept', code: 'ZZZZZZZ' + 'ABCDEFGH'[i % 8] })
    if (r.status === 429) uidBlock = i
  }
  check('T46', '같은 계정의 없는 코드 수락 실패 10회 뒤 429', uidBlock === 10, `blocked at ${uidBlock}`)

  // ───── 감사 로그·저장값 ─────
  const audit = await db.collection('schools/S1/audit').where('action', 'in', ['invitation.create', 'invitation.revoke', 'enrollment.invite', 'enrollment.group-qr']).get()
  const auditText = JSON.stringify(audit.docs.map((d) => d.data()))
  check('T46', '감사 로그: 초대 생성·회수·수강 기록, 초대 코드 원문·이메일·토큰 없음', audit.size >= 6 && !auditText.includes(CODE) && !auditText.includes(HCODE) && !auditText.includes('@e2e.kr') && !auditText.includes(tg), `audit ${audit.size}건`)
  const useDoc = (await db.doc(`invitations/${CODE}/uses/stuA`).get()).data() || {}
  check('T46', '사용 기록에는 시각·종류·결과만(이름·이메일 없음)', Object.keys(useDoc).sort().join(',') === 'at,result,type', Object.keys(useDoc).join(','))

  for (const s of Object.values(sessions)) await s.close()
}

let failed = 1
try {
  await main()
  failed = finish()
} catch (e) {
  console.error('테스트 실행 오류', e)
  check('setup', '테스트 실행 오류 없음', false, String(e?.stack || e).slice(0, 400))
  failed = finish()
}
process.exit(failed ? 1 : 0)
