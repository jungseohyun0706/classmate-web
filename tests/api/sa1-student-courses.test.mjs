// 수업반·수강·학생 개인 시간표 API 통합 테스트 (지시서 19장 테스트 구성)
// 대상: /api/courses, /api/enrollments, /api/timetable/me (+ 공통 수업 기본 변경에 /api/schedule-changes)
// 실행 전제: 실제 서버(BASE, 기본 http://127.0.0.1:3100) + Firebase 에뮬레이터(Firestore 8080, Auth 9099)
//           + NEIS mock(NODE_OPTIONS="--require tests/support/neis-mock.cjs", NEIS_MOCK_FILE)
// 사용: node tests/api/sa1-student-courses.test.mjs
// 모든 데이터는 에뮬레이터의 테스트용 가상 데이터이며 실제 학생 정보가 아닙니다.
import { admin, wipe, createUsers, writeNeisFixture, clientSession, api, reporter, Timestamp, FieldValue } from '../e2e/lib/env.mjs'

const { check, note, finish } = reporter('api-sa1-student-courses')

// ───────── 날짜(학교 시간대 KST) ─────────
const ymdOf = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
const toDate = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)))
const addDays = (ymd, n) => ymdOf(new Date(toDate(ymd).getTime() + n * 86400000))
const weekdayOf = (ymd) => toDate(ymd).getUTCDay() || 7
const TODAY = ymdOf(new Date(Date.now() + 9 * 3600 * 1000))
// 다음 주 월~일(오늘 이후라 '오늘부터' 적용되는 차시·수강이 모두 보임)
const MON = addDays(TODAY, 8 - weekdayOf(TODAY))
const TUE = addDays(MON, 1)
const WED = addDays(MON, 2)
const THU = addDays(MON, 3)
const SUN = addDays(MON, 6)

const S1 = { schoolCode: 'S1', schoolName: '테스트고등학교', officeCode: 'B10' }
const S2 = { schoolCode: 'S2', schoolName: '다른고등학교', officeCode: 'B10' }

function neisFixture() {
  return {
    schools: [
      { SD_SCHUL_CODE: 'S1', SCHUL_NM: '테스트고등학교', SCHUL_KND_SC_NM: '고등학교', ATPT_OFCDC_SC_CODE: 'B10' },
      { SD_SCHUL_CODE: 'S2', SCHUL_NM: '다른고등학교', SCHUL_KND_SC_NM: '고등학교', ATPT_OFCDC_SC_CODE: 'B10' },
    ],
    meals: [],
    timetables: {},
    // 다음 주 목요일은 S1 재량휴업일
    schedule: [{ SD_SCHUL_CODE: 'S1', AA_YMD: THU, EVENT_NM: '재량휴업일', SBTR_DD_SC_NM: '휴업일' }],
  }
}

async function seed() {
  await wipe()
  writeNeisFixture(neisFixture())
  const T = (name, extra = {}) => ({ role: 'teacher', name, displayName: name, ...S1, ...extra })
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
    { uid: 'tx', email: 'tx@e2e.kr', doc: T('최과학') }, // 교사 X: 생활과 과학 A
    { uid: 'ty', email: 'ty@e2e.kr', doc: T('이영어') }, // 교사 Y: 영어 B
    { uid: 'tz', email: 'tz@e2e.kr', doc: T('정영어') }, // 같은 학교 다른 영어 분반(영어 C)
    { uid: 'stuA', email: 'a@e2e.kr', doc: St('김학생', 'S1_3_4', 3, 4, 7) },
    { uid: 'stuB', email: 'b@e2e.kr', doc: St('이학생', 'S1_3_5', 3, 5, 8) },
    { uid: 'stuD', email: 'd@e2e.kr', doc: St('박학생', 'S1_3_5', 3, 5, 9) }, // 수강 자료 없음
    // 수업 그룹이 소속처럼 저장된 예전 학생
    { uid: 'stuG', email: 'g@e2e.kr', doc: { ...St('최학생', 'S1_3_5_g_engb', null, null, null) } },
    { uid: 'stuN', email: 'n@e2e.kr', doc: { role: 'student', status: 'pending', name: '학교없음' } },
    // 다른 학교 S2: 같은 이름의 교사·학생·과목
    { uid: 'tx2', email: 'tx2@e2e.kr', doc: { role: 'teacher', name: '최과학', displayName: '최과학', ...S2 } },
    { uid: 'hr24', email: 'hr24@e2e.kr', doc: { role: 'teacher', name: '김담임', displayName: '김담임', classId: 'S2_3_4', ...S2 } },
    { uid: 'stuA2', email: 'a2@e2e.kr', doc: St('김학생', 'S2_3_4', 3, 4, 7, S2) },
  ])
  const { db } = admin()
  const now = Timestamp.now()
  await db.doc('classes/S1_3_4').set({ classId: 'S1_3_4', grade: 3, classNm: 4, teacherId: 'hr4', teacherName: '김담임', createdAt: now, ...S1 })
  await db.doc('classes/S1_3_5').set({ classId: 'S1_3_5', grade: 3, classNm: 5, teacherId: 'hr5', teacherName: '박담임', createdAt: now, ...S1 })
  await db.doc('classes/S1_3_5_g_engb').set({ classId: 'S1_3_5_g_engb', isGroup: true, grade: 3, classNm: 5, teacherId: 'ty', subjectName: '영어', createdAt: now, ...S1 })
  await db.doc('classes/S2_3_4').set({ classId: 'S2_3_4', grade: 3, classNm: 4, teacherId: 'hr24', createdAt: now, ...S2 })
  // 3학년 5반 학급 시간표(참고용·공통 수업 만들기 원본). 학교 시간표에는 교사·교실이 일부만 있음
  const row = (a) => [...a, '', '', '', '', '', '', ''].slice(0, 7)
  await db.doc('classes/S1_3_5/info/timetable').set({
    mon: row(['국어', '수학', '체육']),
    tue: row(['수학', '국어']),
    wed: row(['국어']),
    thu: row([]),
    fri: row(['체육']),
  })
  const cell = (subject, teacher, room) => ({ subject, ...(teacher ? { teacher } : {}), ...(room ? { room } : {}) })
  const grid = (a) => [...a, null, null, null, null, null, null, null].slice(0, 7)
  await db.doc('school_timetables/S1').set({
    classes: {
      '3-5': {
        mon: grid([cell('국어', '한국어'), cell('수학', '오수학', '수학실'), cell('체육', '강체육', '운동장')]),
        tue: grid([cell('수학', '오수학', '수학실'), cell('국어', '한국어')]),
        wed: grid([cell('국어', '한국어')]),
        thu: grid([]),
        fri: grid([cell('미술', '유미술')]), // 학급 시간표(체육)와 다름 → 교사·교실 모름
      },
    },
    teachers: {},
    periodTimes: {},
    sources: [],
  })
}

const sessions = {}
async function tok(email) {
  if (!sessions[email]) sessions[email] = await clientSession(email)
  return sessions[email].token
}
const courses = async (email, body) => api('/api/courses', await tok(email), body)
const enroll = async (email, body) => api('/api/enrollments', await tok(email), body)
const me = async (email, q = `?from=${MON}&to=${SUN}`) => api('/api/timetable/me' + q, await tok(email), null, 'GET')

/** 페이로드에서 그 날짜의 기본 차시(변경 없음) — 엔진 1~2단계와 같은 규칙 */
function lessonsOn(p, ymd) {
  const wd = weekdayOf(ymd)
  const inR = (d, f, t) => (!f || d >= f) && (!t || d < t)
  const active = new Set(p.enrollments.filter((e) => e.status === 'active' && inR(ymd, e.from, e.to)).map((e) => e.courseId))
  const hrs = p.homerooms.map((h) => h.homeroomId)
  p.courses.forEach((c) => {
    if (c.commonForHomerooms.some((h) => hrs.includes(h))) active.add(c.courseId)
  })
  return p.series
    .filter((s) => active.has(s.courseId) && s.weekday === wd && inR(ymd, s.validFrom, s.validTo))
    .map((s) => {
      const c = p.courses.find((x) => x.courseId === s.courseId)
      return { courseId: s.courseId, title: c?.title, period: s.period, roomName: s.roomName || c?.defaultRoomName || null }
    })
    .sort((a, b) => a.period - b.period)
}

async function main() {
  await seed()
  const { db } = admin()
  note('setup', `TODAY=${TODAY} 조회 기간 ${MON}~${SUN}(다음 주), 목요일 ${THU}는 S1 재량휴업일`)

  // ───── 수업 만들기 ─────
  const sciA = await courses('tx@e2e.kr', { action: 'create', title: '생활과 과학 A', subject: '생활과 과학', section: 'A', defaultRoomName: '3학년 4반 교실' })
  check('T04', '교사 X가 생활과 과학 A 생성', sciA.status === 200 && sciA.j.courseId, JSON.stringify(sciA.j).slice(0, 200))
  const sciAId = sciA.j.courseId
  const sciDoc = (await db.doc(`schools/S1/courses/${sciAId}`).get()).data() || {}
  check('T04', '수업 담당 교사 = 요청자 uid(이름으로 연결하지 않음)', JSON.stringify(sciDoc.teacherUids) === '["tx"]' && sciDoc.schoolCode === 'S1', JSON.stringify(sciDoc.teacherUids))
  const s1 = await courses('tx@e2e.kr', { action: 'addSeries', courseId: sciAId, weekday: 1, period: 1 })
  const s2 = await courses('tx@e2e.kr', { action: 'addSeries', courseId: sciAId, weekday: 3, period: 2 })
  check('T04', '생활과 과학 A 차시 추가(월1, 수2)', s1.status === 200 && s2.status === 200, `${s1.status}/${s2.status} ${JSON.stringify(s1.j).slice(0, 150)}`)

  const engB = await courses('ty@e2e.kr', {
    action: 'create',
    title: '영어 B',
    subject: '영어',
    section: 'B',
    defaultRoomName: '3학년 5반 교실',
    legacyGroupId: 'S1_3_5_g_engb',
    catalogVisible: true,
    invitePolicy: 'auto',
  })
  check('T04', '교사 Y가 영어 B 생성(예전 수업 그룹 연결)', engB.status === 200 && engB.j.course?.legacyGroupId === 'S1_3_5_g_engb', JSON.stringify(engB.j).slice(0, 200))
  const engBId = engB.j.courseId
  const e1 = await courses('ty@e2e.kr', { action: 'addSeries', courseId: engBId, weekday: 2, period: 3, roomName: '3학년 5반 교실' })
  const e2 = await courses('ty@e2e.kr', { action: 'addSeries', courseId: engBId, weekday: 4, period: 4 })
  check('T13', '영어 B 차시(화3 3학년 5반 교실, 목4 기본 교실)', e1.status === 200 && e2.status === 200, `${e1.status}/${e2.status}`)
  const dup = await courses('ty@e2e.kr', { action: 'addSeries', courseId: engBId, weekday: 2, period: 3 })
  check('T05', '같은 수업·요일·교시 차시 중복 추가 → 409 duplicate-series', dup.status === 409 && dup.j.code === 'duplicate-series', `${dup.status} ${dup.j.code}`)

  const engC = await courses('tz@e2e.kr', { action: 'create', title: '영어 C', subject: '영어', section: 'C', catalogVisible: true, invitePolicy: 'approval' })
  const engCId = engC.j.courseId
  const roomClash = await courses('tz@e2e.kr', { action: 'addSeries', courseId: engCId, weekday: 2, period: 3, roomName: '3학년 5반 교실' })
  check(
    'T26',
    '다른 교사 수업과 같은 교실·같은 시간 → 409 conflicts(교실)',
    roomClash.status === 409 && roomClash.j.code === 'conflicts' && (roomClash.j.conflicts || []).some((c) => c.kind === 'room' && c.courseId === engBId),
    `${roomClash.status} ${JSON.stringify(roomClash.j.conflicts || roomClash.j).slice(0, 200)}`
  )
  check('T46', '충돌 응답에 교사 uid 없음', !JSON.stringify(roomClash.j).includes('uid:'), JSON.stringify(roomClash.j).slice(0, 120))
  const engCSeries = await courses('tz@e2e.kr', { action: 'addSeries', courseId: engCId, weekday: 2, period: 3, roomName: '영어전용실' })
  check('T33', '같은 과목 다른 분반(영어 C)은 별도 수업·별도 교실로 추가', engCSeries.status === 200 && engCId !== engBId, `${engCSeries.status}`)

  const sciB = await courses('tx@e2e.kr', { action: 'create', title: '생활과 과학 B', subject: '생활과 과학', section: 'B' })
  const teacherClash = await courses('tx@e2e.kr', { action: 'addSeries', courseId: sciB.j.courseId, weekday: 1, period: 1, roomName: '과학실' })
  check(
    'T26',
    '같은 교사의 다른 수업과 같은 시간 → 409 conflicts(교사)',
    teacherClash.status === 409 && (teacherClash.j.conflicts || []).some((c) => c.kind === 'teacher'),
    `${teacherClash.status} ${JSON.stringify(teacherClash.j.conflicts || teacherClash.j).slice(0, 200)}`
  )
  const ack = await courses('tx@e2e.kr', { action: 'addSeries', courseId: sciB.j.courseId, weekday: 1, period: 1, roomName: '과학실', acknowledgeConflicts: true })
  check('T26', '충돌 확인(acknowledgeConflicts) 후에는 저장', ack.status === 200 && (ack.j.conflicts || []).length > 0, `${ack.status}`)
  const badSlot = await courses('tx@e2e.kr', { action: 'addSeries', courseId: sciB.j.courseId, weekday: 2, period: 11 })
  check('T31', '교시 범위 밖(11교시) → 400', badSlot.status === 400, `${badSlot.status} ${badSlot.j.code}`)
  const pastAdd = await courses('tx@e2e.kr', { action: 'addSeries', courseId: sciB.j.courseId, weekday: 3, period: 6, validFrom: addDays(TODAY, -1) })
  check('T21', '지난 날짜부터 차시 추가 → 400 past-date(지난 시간표를 소급해 바꾸지 않음)', pastAdd.status === 400 && pastAdd.j.code === 'past-date', `${pastAdd.status} ${pastAdd.j.code}`)

  // ───── 공통 수업 지정 ─────
  const notHr = await courses('tx@e2e.kr', { action: 'setCommon', courseId: sciAId, homeroomId: 'S1_3_4', enabled: true })
  check('T40', '담임이 아닌 교사의 공통 수업 지정 → 403', notHr.status === 403 && notHr.j.code === 'not-homeroom-teacher', `${notHr.status} ${notHr.j.code}`)
  const common = await courses('hr4@e2e.kr', { action: 'setCommon', courseId: sciAId, homeroomId: 'S1_3_4', enabled: true })
  const common2 = await courses('hr4@e2e.kr', { action: 'setCommon', courseId: sciAId, homeroomId: 'S1_3_4', enabled: true })
  check('T03', '3학년 4반 담임이 생활과 과학 A를 공통 수업으로 명시(재요청은 같은 결과)', common.status === 200 && common2.j.already === true, `${common.status} ${JSON.stringify(common2.j)}`)

  // ───── 수강 연결 ─────
  const revBefore = Number((await db.doc('schools/S1').get()).get('scheduleRevision') || 0)
  const addA = await enroll('ty@e2e.kr', { action: 'add', courseId: engBId, uid: 'stuA' })
  const addB = await enroll('ty@e2e.kr', { action: 'add', courseId: engBId, uid: 'stuB' })
  check('T02', '교사 Y가 학생 A·B를 영어 B에 연결', addA.status === 200 && addA.j.status === 'active' && addB.j.status === 'active', `${addA.status} ${JSON.stringify(addA.j)}`)
  const revAfter = Number((await db.doc('schools/S1').get()).get('scheduleRevision') || 0)
  check('T36', '수강 변경마다 scheduleRevision 증가(학생 화면 갱신 신호)', revAfter === revBefore + 2, `${revBefore} → ${revAfter}`)
  const enrDoc = (await db.doc(`schools/S1/enrollments/${engBId}__stuA`).get()).data() || {}
  check('T02', '수강 문서 id = courseId__uid, uid·학교·출처 일치', enrDoc.uid === 'stuA' && enrDoc.schoolCode === 'S1' && enrDoc.source === 'admin' && enrDoc.from === TODAY, JSON.stringify({ uid: enrDoc.uid, source: enrDoc.source, from: enrDoc.from }))
  const userA = (await db.doc('users/stuA').get()).data() || {}
  check('T04', '연결된 예전 수업 그룹이 extraClassIds에 추가(톡방 호환), 소속 classId는 그대로', (userA.extraClassIds || []).includes('S1_3_5_g_engb') && userA.classId === 'S1_3_4', JSON.stringify({ classId: userA.classId, extra: userA.extraClassIds }))
  const addAgain = await enroll('ty@e2e.kr', { action: 'add', courseId: engBId, uid: 'stuA' })
  check('T05', '같은 학생을 다시 추가해도 같은 결과(already)', addAgain.status === 200 && addAgain.j.already === true && addAgain.j.status === 'active', JSON.stringify(addAgain.j))
  const addOther = await enroll('ty@e2e.kr', { action: 'add', courseId: engBId, uid: 'stuA2' })
  check('T39', '다른 학교 학생은 추가할 수 없음 → 404 student-not-found', addOther.status === 404 && addOther.j.code === 'student-not-found', `${addOther.status} ${addOther.j.code}`)

  // ───── S2: 같은 이름 교사·과목·학생 ─────
  const s2c = await courses('tx2@e2e.kr', { action: 'create', title: '생활과 과학 A', subject: '생활과 과학', section: 'A', defaultRoomName: '3학년 4반 교실' })
  await courses('tx2@e2e.kr', { action: 'addSeries', courseId: s2c.j.courseId, weekday: 1, period: 1 })
  await courses('hr24@e2e.kr', { action: 'setCommon', courseId: s2c.j.courseId, homeroomId: 'S2_3_4', enabled: true })
  const crossCommon = await courses('hr24@e2e.kr', { action: 'setCommon', courseId: sciAId, homeroomId: 'S2_3_4', enabled: true })
  check('T39', '다른 학교 수업은 내 학교 경로에 없음 → 404', crossCommon.status === 404, `${crossCommon.status} ${crossCommon.j.code}`)

  // ───── 학생 A 개인 시간표 ─────
  const pa = await me('a@e2e.kr')
  check('T02', '/api/timetable/me 200 (학생 A)', pa.status === 200, `${pa.status} ${JSON.stringify(pa.j).slice(0, 200)}`)
  const A = pa.j
  check('T04', '학생 A 소속은 계속 3학년 4반(수업 교실로 바뀌지 않음)', A.homeroom?.classId === 'S1_3_4' && A.homeroom?.label === '3학년 4반' && A.homeroom?.isGroupLegacy === false, JSON.stringify(A.homeroom))
  check('T02', 'enrollments는 본인 것만', A.enrollments?.length === 1 && A.enrollments.every((e) => e.uid === 'stuA') && A.enrollments[0].courseId === engBId, JSON.stringify(A.enrollments))
  const aIds = (A.courses || []).map((c) => c.courseId).sort()
  check('T04', '참여 수업 = 생활과 과학 A(공통) + 영어 B(개별)', JSON.stringify(aIds) === JSON.stringify([sciAId, engBId].sort()), JSON.stringify((A.courses || []).map((c) => c.title)))
  const monA = lessonsOn(A, MON)
  const tueA = lessonsOn(A, TUE)
  const wedA = lessonsOn(A, WED)
  check('T03', '월요일 1교시 생활과 과학 A(학급 공통 수업, 3학년 4반 교실)', monA.length === 1 && monA[0].courseId === sciAId && monA[0].period === 1 && monA[0].roomName === '3학년 4반 교실', JSON.stringify(monA))
  check('T13', '화요일 3교시 영어 B — 실제 교실 3학년 5반 교실(소속 3-4와 다름)', tueA.length === 1 && tueA[0].courseId === engBId && tueA[0].period === 3 && tueA[0].roomName === '3학년 5반 교실', JSON.stringify(tueA))
  check('T04', '수요일 2교시 생활과 과학 A', wedA.length === 1 && wedA[0].courseId === sciAId && wedA[0].period === 2, JSON.stringify(wedA))
  check('T33', '같은 이름 다른 분반(영어 C)·다른 학교 수업 미포함', !aIds.includes(engCId) && !aIds.includes(s2c.j.courseId) && (A.courses || []).every((c) => c.schoolCode === 'S1'), JSON.stringify(aIds))
  check('T05', '공통 수업 + 개별 수강이 겹쳐도 한 수업은 한 번(수업 목록 중복 없음)', new Set(aIds).size === aIds.length, JSON.stringify(aIds))
  check('T34', '휴업일(목)은 offDays에 이름, 평일은 null, 조회 실패 없음', A.offDays?.[THU]?.name === '재량휴업일' && A.offDays?.[MON] === null && (A.calendarErrors || []).length === 0, JSON.stringify({ thu: A.offDays?.[THU], mon: A.offDays?.[MON], err: A.calendarErrors }))
  check('T11', '조회 기간·학기·교시표 포함(고등학교 기본 1교시 08:40)', A.from === MON && A.to === SUN && A.term?.termId && A.periodTimes?.[0]?.start === '08:40' && typeof A.revision === 'number', JSON.stringify({ from: A.from, to: A.to, term: A.term, p1: A.periodTimes?.[0], rev: A.revision }))
  check('T46', '학생 응답에 다른 학생 uid·명단 없음', !JSON.stringify(A).includes('stuB') && !JSON.stringify(A).includes('stuD'), '')

  // ───── 학생 B: 영어 B만 ─────
  const B = (await me('b@e2e.kr')).j
  const bIds = (B.courses || []).map((c) => c.courseId)
  check('T33', '학생 B는 영어 B만(생활과 과학 A·영어 C 없음)', JSON.stringify(bIds) === JSON.stringify([engBId]), JSON.stringify((B.courses || []).map((c) => c.title)))
  const tueB = lessonsOn(B, TUE)
  check('T13', '학생 B 화요일 3교시 영어 B 3학년 5반 교실', tueB.length === 1 && tueB[0].roomName === '3학년 5반 교실', JSON.stringify(tueB))

  // ───── 수강 자료 없는 학생 D ─────
  const D0 = (await me('d@e2e.kr')).j
  check(
    'T32',
    '수강 자료 없음: enrollments·courses 비어 있고(임의 시간표 없음) 소속·학급 시간표(참고) 여부로 상태 판단',
    Array.isArray(D0.enrollments) && D0.enrollments.length === 0 && D0.courses.length === 0 && D0.series.length === 0 && D0.homeroom?.classId === 'S1_3_5' && D0.legacyClassTimetableAvailable === true,
    JSON.stringify({ e: D0.enrollments, c: D0.courses, hr: D0.homeroom, legacy: D0.legacyClassTimetableAvailable })
  )

  // ───── 그룹이 소속처럼 저장된 학생 ─────
  const G = (await me('g@e2e.kr')).j
  check('T34', '그룹을 소속으로 가진 예전 학생: isGroupLegacy, 공통 수업 대상 아님', G.homeroom?.isGroupLegacy === true && G.homerooms.length === 0 && G.legacyClassTimetableAvailable === false, JSON.stringify({ hr: G.homeroom, hrs: G.homerooms }))

  // ───── 다른 학교 S2 학생 ─────
  const A2 = (await me('a2@e2e.kr')).j
  const a2Ids = (A2.courses || []).map((c) => c.courseId)
  check('T33', '다른 학교 동명 학생은 자기 학교 수업만(S1 수업 섞이지 않음)', JSON.stringify(a2Ids) === JSON.stringify([s2c.j.courseId]) && A2.schoolCode === 'S2', JSON.stringify(a2Ids))

  // ───── 오류를 빈 시간표로 위장하지 않음 ─────
  const tMe = await me('tx@e2e.kr')
  check('T35', '수강 없는 교사 → 403 not-student(빈 시간표 아님)', tMe.status === 403 && tMe.j.code === 'not-student', `${tMe.status} ${tMe.j.code}`)
  const nMe = await me('n@e2e.kr')
  check('T35', '학교 정보 없는 학생 → 409 no-school', nMe.status === 409 && nMe.j.code === 'no-school', `${nMe.status} ${nMe.j.code}`)
  const longR = await me('a@e2e.kr', `?from=${MON}&to=${addDays(MON, 21)}`)
  const badD = await me('a@e2e.kr', `?from=2026-10-05&to=${SUN}`)
  check('T35', '조회 기간 21일 초과 400 bad-range, 날짜 형식 오류 400 bad-date', longR.status === 400 && longR.j.code === 'bad-range' && badD.status === 400 && badD.j.code === 'bad-date', `${longR.j.code}/${badD.j.code}`)
  const noTok = await api('/api/timetable/me', null, null, 'GET')
  check('T35', '로그인 없음 → 401', noTok.status === 401 && noTok.j.code === 'unauthenticated', `${noTok.status}`)

  // ───── 권한 우회(학생) ─────
  const stCreate = await courses('a@e2e.kr', { action: 'create', title: '해킹', subject: '해킹' })
  check('T39', '학생의 수업 생성 → 403', stCreate.status === 403 && stCreate.j.code === 'teacher-only', `${stCreate.status} ${stCreate.j.code}`)
  const stUpdate = await courses('a@e2e.kr', { action: 'update', courseId: engBId, title: '바꿈' })
  const stSeries = await courses('a@e2e.kr', { action: 'addSeries', courseId: engBId, weekday: 5, period: 1 })
  check('T39', '학생의 수업 수정·차시 추가 → 403', stUpdate.status === 403 && stSeries.status === 403, `${stUpdate.status}/${stSeries.status}`)
  const stAdd = await enroll('a@e2e.kr', { action: 'add', courseId: engCId, uid: 'stuA' })
  const stList = await enroll('a@e2e.kr', { action: 'list', courseId: engBId })
  const stGet = await courses('a@e2e.kr', { action: 'get', courseId: engBId })
  check('T39', '학생이 스스로 수강 추가·타인 수강 명단 조회 → 403', stAdd.status === 403 && stList.status === 403 && stGet.status === 403, `${stAdd.status}/${stList.status}/${stGet.status}`)

  // ───── 교사 범위 ─────
  const xUpd = await courses('tx@e2e.kr', { action: 'update', courseId: engBId, title: '영어 B (X가 바꿈)' })
  check('T40', '교사 X가 교사 Y의 영어 B 수정 → 403', xUpd.status === 403 && xUpd.j.code === 'not-course-teacher', `${xUpd.status} ${xUpd.j.code}`)
  const xSeries = await courses('tx@e2e.kr', { action: 'addSeries', courseId: engBId, weekday: 5, period: 5 })
  const xEnd = await courses('tx@e2e.kr', { action: 'end', courseId: engBId, endedOn: TODAY })
  const xAdd = await enroll('tx@e2e.kr', { action: 'add', courseId: engBId, uid: 'stuD' })
  const xGet = await courses('tx@e2e.kr', { action: 'get', courseId: engBId })
  check('T40', '교사 X가 영어 B 차시 추가·종료·수강 추가·명단 조회 → 모두 403', [xSeries, xEnd, xAdd, xGet].every((r) => r.status === 403), [xSeries, xEnd, xAdd, xGet].map((r) => r.status).join('/'))
  const engBTitle = (await db.doc(`schools/S1/courses/${engBId}`).get()).get('title')
  check('T40', '거부된 수정은 반영되지 않음', engBTitle === '영어 B', engBTitle)

  // ───── 학생 신청(공식 수업 선택) ─────
  const cat = await courses('d@e2e.kr', { action: 'catalog' })
  const catIds = (cat.j.courses || []).map((c) => c.courseId)
  check('T39', '학생 공개 목록: 공개 수업만(영어 B·C), 비공개 생활과 과학 A·다른 학교 없음', cat.status === 200 && catIds.includes(engBId) && catIds.includes(engCId) && !catIds.includes(sciAId) && !catIds.includes(s2c.j.courseId), JSON.stringify(catIds))
  const catB = (cat.j.courses || []).find((c) => c.courseId === engBId)
  const catKeys = catB ? Object.keys(catB).sort().join(',') : ''
  check('T46', '공개 목록에는 제목·과목·분반·교사 이름·요일 교시·교실·나에게 보이는 방식(offer)만(명단·인원·uid 없음)',
    catB &&
      JSON.stringify(catB.slots.map((x) => [x.weekday, x.period])) === JSON.stringify([[2, 3], [4, 4]]) &&
      catB.slots[0].roomName === '3학년 5반 교실' &&
      catKeys === 'courseId,defaultRoomName,invitePolicy,myStatus,offer,section,slots,subject,teacherNames,title' &&
      !JSON.stringify(cat.j).includes('stuA'),
    JSON.stringify(catB))
  const rq1 = await enroll('d@e2e.kr', { action: 'request', courseId: engBId })
  const rq2 = await enroll('d@e2e.kr', { action: 'request', courseId: engBId })
  check('T05', '자동 참여 수업 신청 두 번 → 같은 결과(active, 두 번째 already)', rq1.status === 200 && rq1.j.status === 'active' && rq2.j.status === 'active' && rq2.j.already === true, `${JSON.stringify(rq1.j)} / ${JSON.stringify(rq2.j)}`)
  const rqC1 = await enroll('d@e2e.kr', { action: 'request', courseId: engCId })
  const rqC2 = await enroll('d@e2e.kr', { action: 'request', courseId: engCId })
  check('T05', '승인 수업 신청 두 번 → pending 한 건', rqC1.j.status === 'pending' && rqC2.j.status === 'pending' && rqC2.j.already === true, `${rqC1.j.status}/${rqC2.j.status}`)
  const rqHidden = await enroll('d@e2e.kr', { action: 'request', courseId: sciAId })
  check('T39', '비공개 수업 신청 → 403 not-open', rqHidden.status === 403 && rqHidden.j.code === 'not-open', `${rqHidden.status} ${rqHidden.j.code}`)
  const mine = await enroll('d@e2e.kr', { action: 'list', mine: true })
  check('T05', '본인 수강 목록: 영어 B active 1건 + 영어 C pending 1건(중복 없음)', mine.status === 200 && mine.j.enrollments.length === 2 && mine.j.enrollments.filter((e) => e.courseId === engBId).length === 1, JSON.stringify(mine.j.enrollments?.map((e) => [e.course?.title, e.status])))
  const D1 = (await me('d@e2e.kr')).j
  const dPending = D1.enrollments.find((e) => e.courseId === engCId)
  check('T34', '승인 대기 수업은 pending으로 구분(시간표 수업 아님)', dPending?.status === 'pending' && lessonsOn(D1, TUE).every((l) => l.courseId !== engCId), JSON.stringify(dPending))
  const zGet = await courses('tz@e2e.kr', { action: 'get', courseId: engCId })
  check('T34', '담당 교사 Z는 승인 대기 1명(이름·번호·소속)을 봄', zGet.status === 200 && zGet.j.counts?.pending === 1 && zGet.j.pending?.[0]?.name === '박학생' && zGet.j.pending?.[0]?.studentId === 9 && zGet.j.pending?.[0]?.homeroomLabel === '3학년 5반', JSON.stringify(zGet.j.pending))
  const yApprove = await enroll('ty@e2e.kr', { action: 'approve', courseId: engCId, uid: 'stuD' })
  check('T40', '다른 교사(Y)는 영어 C 승인 불가 → 403', yApprove.status === 403, `${yApprove.status}`)
  const zApprove = await enroll('tz@e2e.kr', { action: 'approve', courseId: engCId, uid: 'stuD' })
  check('T05', '담당 교사 Z 승인 → active', zApprove.status === 200 && zApprove.j.status === 'active', JSON.stringify(zApprove.j))
  const D2 = (await me('d@e2e.kr')).j
  const tueD = lessonsOn(D2, TUE)
  check('T25', '학생 D 화요일 3교시에 영어 B·영어 C 두 수업(겹침은 화면 엔진이 검출 — 숨기지 않음)', tueD.length === 2 && tueD.every((l) => l.period === 3), JSON.stringify(tueD))

  // ───── 수강 종료(기간 경계) ─────
  const endB = await enroll('ty@e2e.kr', { action: 'end', courseId: engBId, uid: 'stuB' })
  const B2 = (await me('b@e2e.kr')).j
  const eB = B2.enrollments.find((e) => e.courseId === engBId)
  check('T24', '수강 종료: to=오늘(오늘부터 빠짐, 지난 날짜 기록 유지), 다음 주 화요일 수업 없음', endB.status === 200 && eB?.status === 'ended' && eB?.to === TODAY && lessonsOn(B2, TUE).length === 0, JSON.stringify(eB))
  const userB = (await db.doc('users/stuB').get()).data() || {}
  check('T04', '수강 종료해도 예전 그룹 톡방(extraClassIds)은 빼지 않음', (userB.extraClassIds || []).includes('S1_3_5_g_engb'), JSON.stringify(userB.extraClassIds))
  const yList = await enroll('ty@e2e.kr', { action: 'list', courseId: engBId })
  check('T34', '담당 교사 명단: 상태별 인원', yList.status === 200 && yList.j.counts?.active === 2 && yList.j.counts?.ended === 1, JSON.stringify(yList.j.counts))

  // ───── 반복 차시 종료(기본 시간표 변경) ─────
  const engBSeries = (await courses('ty@e2e.kr', { action: 'get', courseId: engBId })).j.series || []
  const thuSeries = engBSeries.find((s) => s.weekday === 4)
  const pastRetire = await courses('ty@e2e.kr', { action: 'retireSeries', seriesId: thuSeries?.seriesId, effectiveFrom: addDays(TODAY, -1) })
  check('T21', '지난 날짜부터 차시 종료 → 400 past-date(지난 수업 기록 유지)', pastRetire.status === 400 && pastRetire.j.code === 'past-date', `${pastRetire.status} ${pastRetire.j.code}`)
  const retire = await courses('ty@e2e.kr', { action: 'retireSeries', seriesId: thuSeries?.seriesId, effectiveFrom: WED })
  const A3 = (await me('a@e2e.kr')).j
  const thuA3 = A3.series.find((s) => s.seriesId === thuSeries?.seriesId)
  check('T21', '차시 종료(적용일부터): validTo=적용일, 이전 날짜 차시는 그대로', retire.status === 200 && thuA3?.validTo === WED && thuA3?.validFrom <= TODAY, JSON.stringify(thuA3))

  // ───── 학급 시간표 → 공통 수업(3학년 5반) ─────
  const xHc = await courses('tx@e2e.kr', { action: 'fromHomeroomTimetable', classId: 'S1_3_5' })
  check('T40', '담임이 아닌 교사의 학급 시간표 공통 수업 만들기 → 403', xHc.status === 403, `${xHc.status} ${xHc.j.code}`)
  const hc1 = await courses('hr5@e2e.kr', { action: 'fromHomeroomTimetable', classId: 'S1_3_5' })
  const countSeries = async () => (await db.collection('schools/S1/series').where('sourceHomeroomId', '==', 'S1_3_5').get()).size
  const n1 = await countSeries()
  const hc2 = await courses('hr5@e2e.kr', { action: 'fromHomeroomTimetable', classId: 'S1_3_5' })
  const n2 = await countSeries()
  check('T03', '학급 시간표로 (과목,교사)별 공통 수업 4개(국어·수학·체육 강체육·체육 교사 미정) + 칸별 차시 7개', hc1.status === 200 && hc1.j.courses === 4 && hc1.j.seriesCreated === 7, JSON.stringify(hc1.j).slice(0, 300))
  check('T29', '다시 실행해도 수업·차시 중복 없음', hc2.status === 200 && hc2.j.already === true && n1 === n2 && n1 === 7, `${n1}→${n2} ${JSON.stringify(hc2.j).slice(0, 120)}`)
  const hcSeries = (await db.collection('schools/S1/series').where('sourceHomeroomId', '==', 'S1_3_5').get()).docs.map((d) => d.data())
  const friPe = hcSeries.find((s) => s.weekday === 5 && s.period === 1)
  check('T31', '교실을 모르면 null(학급 이름을 교실로 추정하지 않음), 학교 시간표와 과목이 다른 칸은 교사 미정', friPe && friPe.roomName === null && hcSeries.every((s) => s.roomName !== '3학년 5반' && s.roomName !== '3학년 5반 교실'), JSON.stringify(friPe))
  const hcCourse = (await db.doc(`schools/S1/courses/${hc1.j.courseIds?.[0]}`).get()).data() || {}
  check('T33', '공통 수업 교사는 이름만(계정 연결 없음), 관리 권한은 담임(managerUids)', JSON.stringify(hcCourse.teacherUids) === '[]' && JSON.stringify(hcCourse.managerUids) === '["hr5"]', JSON.stringify({ t: hcCourse.teacherUids, m: hcCourse.managerUids, n: hcCourse.teacherNames }))
  const D3 = (await me('d@e2e.kr')).j
  const monD = lessonsOn(D3, MON)
  check('T03', '3학년 5반 학생 D: 공통 수업 지정 후 월요일 국어·수학(수학실)·체육(운동장) 표시', monD.length === 3 && monD[1].roomName === '수학실' && monD[2].roomName === '운동장', JSON.stringify(monD))
  const hrList = await courses('hr5@e2e.kr', { action: 'list' })
  check('T40', '담임 목록에 관리 중인 공통 수업(role manager)', hrList.status === 200 && (hrList.j.courses || []).filter((c) => c.role === 'manager').length === 4, JSON.stringify((hrList.j.courses || []).map((c) => [c.title, c.role])))
  const yListC = await courses('ty@e2e.kr', { action: 'list' })
  const yTitles = (yListC.j.courses || []).map((c) => c.title)
  check('T40', '교사 Y 목록은 자기 수업만(영어 B), 다른 교사 수업 없음', JSON.stringify(yTitles) === JSON.stringify(['영어 B']), JSON.stringify(yTitles))
  const yEngB = (yListC.j.courses || []).find((c) => c.title === '영어 B')
  check('T46', '수업 목록은 인원 수만(counts) — 학생 명단·uid 없음', !!yEngB && typeof yEngB.counts?.active === 'number' && typeof yEngB.counts?.pending === 'number' && !('pending' in yEngB && Array.isArray(yEngB.pending)) && !JSON.stringify(yListC.j).includes('stuA'), JSON.stringify(yEngB?.counts))

  // ───── 검토 [1][11] 기본 시간표 변경으로 옮긴 공통 수업 칸 + 학급 시간표 재실행(중복·되돌림 없음) ─────
  const F = addDays(MON, 7) // 기본 변경 적용일(다다음 주 월요일)
  const hrSeriesDocs = async () => (await db.collection('schools/S1/series').where('sourceHomeroomId', '==', 'S1_3_5').get()).docs
  const korMon = (await hrSeriesDocs()).find((d) => d.get('weekday') === 1 && d.get('period') === 1)
  const korId = korMon?.get('courseId')
  const revNow = async () => Number((await db.doc('schools/S1').get()).get('scheduleRevision') || 0)
  const baseChange = await api('/api/schedule-changes', await tok('hr5@e2e.kr'), {
    action: 'publish', scope: 'base', mutationId: 'm-hr-base-00001', expectedRevision: await revNow(),
    items: [{ op: 'base', courseId: korId, seriesId: korMon?.id, effectiveFrom: F, period: 4 }],
  })
  const srRef = db.doc('schools/S1/series/sr_m-hr-base-00001_0')
  const sr = (await srRef.get()).data() || {}
  check('R1', '담임이 공통 수업 국어 월1을 기본 변경으로 월4로 옮김 → 새 차시에 같은 sourceHomeroomId',
    baseChange.status === 200 && sr.sourceHomeroomId === 'S1_3_5' && sr.replacesSeriesId === korMon?.id && sr.weekday === 1 && sr.period === 4 && sr.validFrom === F,
    `${baseChange.status} ${baseChange.j.code || ''} ${JSON.stringify(sr).slice(0, 200)}`)
  const korPeriods = async (from) => {
    const p = (await me('d@e2e.kr', `?from=${from}&to=${addDays(from, 6)}`)).j
    return lessonsOn(p, from).filter((l) => l.courseId === korId).map((l) => l.period)
  }
  const hcBefore = await courses('hr5@e2e.kr', { action: 'fromHomeroomTimetable', classId: 'S1_3_5' })
  check('R11', '적용일 전(오늘부터) 재실행: 학급 시간표 그대로 → already, 옮긴 칸 1개 유지, 새로 만들거나 끝낸 차시 없음',
    hcBefore.status === 200 && hcBefore.j.already === true && hcBefore.j.seriesCreated === 0 && hcBefore.j.seriesRetired === 0 && hcBefore.j.cellsKeptByChange === 1,
    JSON.stringify(hcBefore.j).slice(0, 300))
  const hcAfter = await courses('hr5@e2e.kr', { action: 'fromHomeroomTimetable', classId: 'S1_3_5', effectiveFrom: addDays(F, 7) })
  check('R11', '적용일 뒤부터 재실행도 already(옮긴 월4를 월1로 되돌리거나 겹쳐 만들지 않음)',
    hcAfter.status === 200 && hcAfter.j.already === true && hcAfter.j.seriesCreated === 0 && hcAfter.j.seriesRetired === 0,
    JSON.stringify(hcAfter.j).slice(0, 300))
  const [kMon, kF, kF7] = [await korPeriods(MON), await korPeriods(F), await korPeriods(addDays(F, 7))]
  check('R11', '학생 D 월요일 국어는 주마다 한 번: 적용일 전 1교시, 적용일부터 4교시',
    JSON.stringify([kMon, kF, kF7]) === JSON.stringify([[1], [4], [4]]), JSON.stringify([kMon, kF, kF7]))
  // 예전 자료(수정 전 기본 변경으로 생긴 차시엔 sourceHomeroomId가 없음)도 수업 id + 연결로 찾음
  await srRef.update({ sourceHomeroomId: FieldValue.delete() })
  const hcLegacy = await courses('hr5@e2e.kr', { action: 'fromHomeroomTimetable', classId: 'S1_3_5', effectiveFrom: addDays(F, 7) })
  check('R11', '예전 자료(sr_에 sourceHomeroomId 없음) 재실행도 already — 수업 id로 읽어 연결(replacesSeriesId)로 판정',
    hcLegacy.status === 200 && hcLegacy.j.already === true && hcLegacy.j.cellsKeptByChange === 1 && JSON.stringify(await korPeriods(addDays(F, 7))) === '[4]',
    JSON.stringify(hcLegacy.j).slice(0, 300))
  // 학급 시간표가 실제로 바뀐 칸만 적용일부터 반영: 목1 국어 추가 → 그 칸만 새로, 옮긴 칸은 그대로
  const E2 = addDays(F, 7)
  const ttRef = db.doc('classes/S1_3_5/info/timetable')
  await ttRef.update({ thu: ['국어', '', '', '', '', '', ''] })
  await db.doc('school_timetables/S1').update({ 'classes.3-5.thu': [{ subject: '국어', teacher: '한국어' }, null, null, null, null, null, null] })
  const hcAdd = await courses('hr5@e2e.kr', { action: 'fromHomeroomTimetable', classId: 'S1_3_5', effectiveFrom: E2 })
  const srAfterAdd = (await srRef.get()).data() || {}
  check('R11', '학급 시간표에 목1 국어 추가 → 그 칸만 적용일부터 새 차시 1개, 끝낸 차시 없음, 옮긴 차시(월4) 계속',
    hcAdd.status === 200 && hcAdd.j.seriesCreated === 1 && hcAdd.j.seriesRetired === 0 && hcAdd.j.cellsKeptByChange === 1 && srAfterAdd.validTo === null,
    JSON.stringify(hcAdd.j).slice(0, 300))
  // 원래 칸(월1 국어)을 학급 시간표에서 빼면 실제로 바뀐 칸 → 옮긴 차시도 적용일부터 끝냄
  const E3 = addDays(F, 14)
  await ttRef.update({ mon: ['', '수학', '체육', '', '', '', ''] })
  const hcRemove = await courses('hr5@e2e.kr', { action: 'fromHomeroomTimetable', classId: 'S1_3_5', effectiveFrom: E3 })
  const srAfterRemove = (await srRef.get()).data() || {}
  const [kE2, kE3] = [await korPeriods(E2), await korPeriods(E3)]
  check('R11', '원래 칸(월1 국어)을 빼고 재실행 → 옮긴 차시(월4)를 적용일부터 끝냄, 그 전 주는 그대로',
    hcRemove.status === 200 && hcRemove.j.seriesRetired === 1 && hcRemove.j.seriesCreated === 0 && srAfterRemove.validTo === E3 && JSON.stringify([kE2, kE3]) === '[[4],[]]',
    `${JSON.stringify(hcRemove.j).slice(0, 200)} validTo=${srAfterRemove.validTo} ${JSON.stringify([kE2, kE3])}`)

  // ───── 감사 로그 ─────
  const audit = await db.collection('schools/S1/audit').get()
  const auditText = JSON.stringify(audit.docs.map((d) => d.data()))
  check('T46', '감사 로그 기록, 토큰·이메일 없음', audit.size > 10 && !auditText.includes('eyJ') && !auditText.includes('@e2e.kr'), `audit ${audit.size}건`)

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
