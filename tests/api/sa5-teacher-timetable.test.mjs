// 교사 '내 시간표' API 통합 테스트 — GET /api/timetable/teacher (아키텍처 '교사 내 시간표(메인 화면)' 절)
// 덮는 항목: 401·403(학생·가입 미완료)·409, 본인 차시만(uid로만 — 이름만 같은 수업 제외), 다른 교사에게 넘긴 차시(changed-away),
//           나에게 넘어온 차시(substitute), 취소, 보강, 학생 화면과 같은 변경 전후, 예전 주간 시간표(mySchedule) 대체 방식,
//           교환(품앗이)·보결(SOS) 겹치기, 응답에 학생 자료(uid·이메일·이름)·다른 교사 uid 없음, 조회 기간 상한, 교시 시각 출처,
//           일부 학년만 쉬는 날(교사는 담임 학년으로 정하지 않음 — 그 학년 수업만 열리지 않음)·학교 전체 쉬는 날,
//           다른 교사가 대기 요청을 많이 만들어도 내 교환·보결이 잘리지 않음, 본인이 고친 users.classId로 남의 학급 교시표를 읽지 못함
// 실행 전제: 실제 서버(BASE, 기본 http://127.0.0.1:3100) + Firebase 에뮬레이터(Firestore 8080, Auth 9099)
//           + NEIS mock(NODE_OPTIONS="--require tests/support/neis-mock.cjs", NEIS_MOCK_FILE)
// 사용: node tests/api/sa5-teacher-timetable.test.mjs
// 화면 판단(buildTeacherDay)은 실제 모듈(src/lib/timetable/teacherDay.ts — 이 테스트가 CommonJS로 변환해 씀)로 계산합니다.
// 모든 데이터는 에뮬레이터의 테스트용 가상 데이터이며 실제 교사·학생 정보가 아닙니다.
import fs from 'fs'
import path from 'path'
import { admin, wipe, createUsers, writeNeisFixture, clientSession, api, reporter, require, ROOT, Timestamp } from '../e2e/lib/env.mjs'

const { OUT, check, note, finish } = reporter('api-sa5-teacher-timetable')

// ───────── 날짜(학교 시간대 KST) ─────────
const ymdOf = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
const toDate = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)))
const addDays = (ymd, n) => ymdOf(new Date(toDate(ymd).getTime() + n * 86400000))
const weekdayOf = (ymd) => toDate(ymd).getUTCDay() || 7
const TODAY = ymdOf(new Date(Date.now() + 9 * 3600 * 1000))
// 이틀 뒤 이후 첫 화요일 — 변경 발행이 '지난 날짜'에 걸리지 않게
let TUE = addDays(TODAY, 2)
while (weekdayOf(TUE) !== 2) TUE = addDays(TUE, 1)
const MON = addDays(TUE, -1)
const WED = addDays(TUE, 1)
const THU = addDays(TUE, 2)
const FRI = addDays(TUE, 3)
const SUN = addDays(TUE, 5)
const NEXT_TUE = addDays(TUE, 7)
const NEXT_WED = addDays(TUE, 8)
const NEXT_THU = addDays(TUE, 9)
const TERM_START = addDays(TODAY, -40)
const TERM_END = addDays(TODAY, 120)

const S1 = { schoolCode: 'S1', schoolName: '테스트고등학교', officeCode: 'B10' }
const S2 = { schoolCode: 'S2', schoolName: '다른고등학교', officeCode: 'B10' }
const STUDENT_NAMES = ['김학생가', '이학생나']
const LEGACY_SCHEDULE = {
  mon: ['', '2-1 국어', '', '', '', '', ''],
  tue: ['1-3 국어', '', '', '', '', '', ''],
  wed: ['', '', '', '', '', '', ''],
  thu: ['', '', '', '', '', '', ''],
  fri: ['', '', '', '', '', '', ''],
}

// ───────── 실제 모듈 불러오기(TS → CommonJS) ─────────
function loadTeacherDay() {
  const ts = require('typescript')
  const dir = path.join(OUT, 'mods')
  fs.mkdirSync(dir, { recursive: true })
  for (const f of ['dates', 'engine', 'teacherDay']) {
    const src = fs.readFileSync(path.join(ROOT, 'src/lib/timetable', f + '.ts'), 'utf8')
    const js = ts
      .transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } })
      .outputText.replace(/require\("\.\/dates"\)/g, 'require("./dates.cjs")')
      .replace(/require\("\.\/engine"\)/g, 'require("./engine.cjs")')
    fs.writeFileSync(path.join(dir, f + '.cjs'), js)
  }
  return { ...require(path.join(dir, 'teacherDay.cjs')), ...require(path.join(dir, 'engine.cjs')) }
}
const { buildTeacherDay, buildDayTimetable } = loadTeacherDay()

function neisFixture() {
  return {
    schools: [
      { SD_SCHUL_CODE: 'S1', SCHUL_NM: '테스트고등학교', SCHUL_KND_SC_NM: '고등학교', ATPT_OFCDC_SC_CODE: 'B10' },
      { SD_SCHUL_CODE: 'S2', SCHUL_NM: '다른고등학교', SCHUL_KND_SC_NM: '고등학교', ATPT_OFCDC_SC_CODE: 'B10' },
    ],
    meals: [],
    timetables: {},
    // 학년별 해당 여부: ONE·TW·THREE(고등학교라 FR~SIX는 N)
    schedule: [
      schoolRow(NEXT_TUE, '1학년 현장체험 휴업일', ['Y', 'N', 'N']), // 1학년만
      schoolRow(NEXT_WED, '3학년 재량휴업일', ['N', 'N', 'Y']), // 3학년만
      schoolRow(NEXT_THU, '재량휴업일', ['Y', 'Y', 'Y']), // 모든 학년 = 학교 전체
    ],
  }
}

function schoolRow(ymd, name, grades) {
  const r = { SD_SCHUL_CODE: 'S1', ATPT_OFCDC_SC_CODE: 'B10', AA_YMD: ymd, EVENT_NM: name, SBTR_DD_SC_NM: '휴업일' }
  ;['ONE', 'TW', 'THREE', 'FR', 'FIV', 'SIX'].forEach((g, i) => (r[`${g}_GRADE_EVENT_YN`] = grades[i] || 'N'))
  return r
}

async function seed() {
  await wipe()
  writeNeisFixture(neisFixture())
  const T = (name, extra = {}, school = S1) => ({ role: 'teacher', name, displayName: name, ...school, ...extra })
  const St = (name, classId, grade, classNm, studentId) => ({ role: 'student', status: 'approved', name, displayName: name, classId, grade, classNm, studentId, ...S1 })
  await createUsers([
    // 교사 ME: 공식 수업(영어 B·국어 공통) + 담임 3학년 4반 + 예전 주간 시간표도 있음(공식 방식이면 참고로만)
    { uid: 'tme', email: 'tme@e2e.kr', doc: T('이영어', { classId: 'S1_3_4', grade: 3, classNm: 4, mySchedule: LEGACY_SCHEDULE }) },
    { uid: 'tx', email: 'tx@e2e.kr', doc: T('김과학') }, // 생활과 과학 A
    { uid: 'tz', email: 'tz@e2e.kr', doc: T('정대체') }, // 대체 교사
    { uid: 'tleg', email: 'tleg@e2e.kr', doc: T('박주간', { mySchedule: LEGACY_SCHEDULE }) }, // 공식 수업 없음 + 주간 시간표
    { uid: 'tempty', email: 'tempty@e2e.kr', doc: T('최빈칸') }, // 아무것도 없음
    { uid: 'tnos', email: 'tnos@e2e.kr', doc: { role: 'teacher', name: '학교없음', displayName: '학교없음' } },
    { uid: 'tw', email: 'tw@e2e.kr', doc: T('이영어', {}, S2) }, // 다른 학교의 같은 이름 교사
    // 본인이 users.classId를 남의 학급·다른 학교 학급·경로 모양 값으로 고친 교사(담임 아님) — 남의 학급 교시표를 읽으면 안 됨
    { uid: 'tfake', email: 'tfake@e2e.kr', doc: T('가짜담임', { classId: 'S1_3_4' }) },
    { uid: 'tfake2', email: 'tfake2@e2e.kr', doc: T('가짜담임둘', { classId: 'S2_1_1' }) },
    { uid: 'tfake3', email: 'tfake3@e2e.kr', doc: T('가짜담임셋', { classId: 'S1_9_9/info/periodTimes/x' }) },
    { uid: 'stuA', email: 'a@e2e.kr', doc: St(STUDENT_NAMES[0], 'S1_3_4', 3, 4, 1) },
    { uid: 'stuB', email: 'b@e2e.kr', doc: St(STUDENT_NAMES[1], 'S1_3_5', 3, 5, 2) },
    { uid: 'noprof', email: 'noprof@e2e.kr' }, // 가입 미완료(users 문서 없음)
  ])
  const { db } = admin()
  const now = Timestamp.now()
  await db.doc('classes/S1_3_4').set({ classId: 'S1_3_4', grade: 3, classNm: 4, teacherId: 'tme', teacherName: '이영어', createdAt: now, ...S1 })
  await db.doc('classes/S1_3_4/info/periodTimes').set({ times: ['09:10'] }) // 담임 학급 교시표(엑셀 업로드 때 복사)
  await db.doc('school_timetables/S1').set({ classes: {}, teachers: {}, periodTimes: { 1: '08:50' }, sources: [] }) // 학교 엑셀 교시표
  await db.doc('classes/S2_1_1').set({ classId: 'S2_1_1', grade: 1, classNm: 1, teacherId: 'tw', createdAt: now, ...S2 })
  await db.doc('classes/S2_1_1/info/periodTimes').set({ times: ['07:30'] }) // 다른 학교 학급 교시표
  const s = db.doc('schools/S1')
  await s.set({ name: '테스트고등학교', kind: '고등학교', scheduleRevision: 0, timezone: 'Asia/Seoul' })
  await db.doc('schools/S2').set({ name: '다른고등학교', kind: '고등학교', scheduleRevision: 0, timezone: 'Asia/Seoul' })
  await s.collection('terms').doc('T1').set({ name: '테스트 학기', startDate: TERM_START, endDate: TERM_END })
  const course = (id, title, subject, section, teacherUids, teacherNames, room, extra = {}) =>
    s.collection('courses').doc(id).set({
      schoolCode: 'S1', termId: 'T1', title, subject, section, teacherUids, teacherNames, status: 'active', endedOn: null,
      commonForHomerooms: [], defaultRoomName: room, invitePolicy: 'auto', catalogVisible: false, source: 'manual', createdBy: 'seed', createdAt: now, updatedAt: now, revision: 0, ...extra,
    })
  await course('engB', '영어 B', '영어', 'B', ['tme'], ['이영어'], '3학년 5반 교실')
  await course('sciA', '생활과 과학 A', '생활과 과학', 'A', ['tx'], ['김과학'], '과학실')
  await course('engN', '영어 N', '영어', 'N', [], ['이영어'], '어학실') // 엑셀 이름만 같음(계정 연결 없음)
  await course('kor34', '국어', '국어', '', ['tme'], ['이영어'], '3학년 4반 교실', { commonForHomerooms: ['S1_3_4'] })
  await db.doc('schools/S2/courses/engB2').set({ schoolCode: 'S2', termId: 'T1', title: '영어 B', subject: '영어', teacherUids: ['tw'], teacherNames: ['이영어'], status: 'active', commonForHomerooms: [] })
  await db.doc('schools/S2/series/sr_engB2_tue3').set({ courseId: 'engB2', weekday: 2, period: 3, validFrom: TERM_START, validTo: null, status: 'active' })
  await db.doc('schools/S2').collection('terms').doc('T1').set({ name: '테스트 학기', startDate: TERM_START, endDate: TERM_END })
  const ser = (id, courseId, weekday, period) =>
    s.collection('series').doc(id).set({ courseId, termId: 'T1', weekday, period, validFrom: TERM_START, validTo: null, status: 'active', createdBy: 'seed', createdAt: now })
  await ser('sr_engB_tue3', 'engB', 2, 3)
  await ser('sr_engB_thu2', 'engB', 4, 2)
  await ser('sr_sciA_tue4', 'sciA', 2, 4)
  await ser('sr_engN_tue5', 'engN', 2, 5)
  await ser('sr_kor34_wed1', 'kor34', 3, 1)
  // 영어 B 수5: 다음 주부터(이번 주 수요일 B5 확인에 영향 없음) — 3학년만 쉬는 다음 주 수요일에도 열리는 학년 모르는 수업
  await s.collection('series').doc('sr_engB_wed5').set({ courseId: 'engB', termId: 'T1', weekday: 3, period: 5, validFrom: THU, validTo: null, status: 'active', createdBy: 'seed', createdAt: now })
  const en = (courseId, uid) =>
    s.collection('enrollments').doc(`${courseId}__${uid}`).set({ courseId, uid, schoolCode: 'S1', termId: 'T1', status: 'active', source: 'admin', createdAt: now, updatedAt: now })
  await en('engB', 'stuA')
  await en('engB', 'stuB')
  await en('sciA', 'stuA')

  // 예전 교환(품앗이)·보결(SOS)
  const sw = db.collection('school_swaps').doc('S1')
  await sw.collection('requests').doc('pub1').set({ requesterId: 'tme', requesterName: '이영어', requesterClass: '3학년 4반', day: 'tue', period: 6, subject: '3-4 영어', date: TUE, status: 'accepted', accepterId: 'tz', accepterName: '정대체', createdAt: now })
  await sw.collection('direct_requests').doc('dir1').set({ requesterId: 'tx', requesterName: '김과학', requesterClass: '담임 없음', toId: 'tme', toName: '이영어', day: 'tue', period: 7, subject: '1-2 과학', date: TUE, status: 'accepted', accepterId: 'tme', accepterName: '이영어', note: '개인 사정', createdAt: now })
  await sw.collection('direct_requests').doc('dirPending').set({ requesterId: 'tx', requesterName: '김과학', toId: 'tme', day: 'wed', period: 3, subject: '1-2 과학', date: WED, status: 'pending', createdAt: now })
  await sw.collection('direct_requests').doc('dirOther').set({ requesterId: 'tx', requesterName: '김과학', toId: 'tz', day: 'wed', period: 4, subject: '1-2 과학', date: WED, status: 'accepted', accepterId: 'tz', accepterName: '정대체', createdAt: now })
  await sw.collection('requests').doc('pubFar').set({ requesterId: 'tme', requesterName: '이영어', period: 2, subject: '3-4 영어', date: addDays(TUE, 40), status: 'accepted', accepterId: 'tz', accepterName: '정대체', createdAt: now })
  const sos = db.collection('school_sos').doc('S1').collection('requests')
  await sos.doc('sos1').set({ date: MON, period: 2, reason: '병원 진료', requesterId: 'tleg', requesterName: '박주간', requesterClass: '2학년 1반', schoolCode: 'S1', status: 'assigned', assignedTo: 'tme', assignedName: '이영어', createdAt: now })
  await sos.doc('sosOpen').set({ date: MON, period: 3, reason: '출장', requesterId: 'tleg', requesterName: '박주간', requesterClass: '2학년 1반', schoolCode: 'S1', status: 'open', createdAt: now })

  // 같은 학교 다른 교사가 조회 기간 날짜에 모집 중 요청을 많이 만든 상태(규칙상 누구나 만들 수 있음) — 문서 id가 내 문서보다 앞에 정렬됨
  for (const [col, make] of [
    [sos, (i) => ({ date: MON, period: 1 + (i % 7), reason: '출장', requesterId: 'tx', requesterName: '김과학', schoolCode: 'S1', status: 'open', createdAt: now })],
    [sw.collection('requests'), (i) => ({ requesterId: 'tx', requesterName: '김과학', period: 1 + (i % 7), subject: '1-2 과학', date: TUE, status: 'pending', createdAt: now })],
  ]) {
    for (let start = 0; start < SPAM_DOCS; start += 400) {
      const batch = db.batch()
      for (let i = start; i < Math.min(SPAM_DOCS, start + 400); i++) batch.set(col.doc(`aaspam${String(i).padStart(4, '0')}`), make(i))
      await batch.commit()
    }
  }
}
const SPAM_DOCS = 620

const sessions = {}
async function tok(email) {
  if (!sessions[email]) sessions[email] = await clientSession(email)
  return sessions[email].token
}
const teacherApi = async (email, q = `?from=${MON}&to=${SUN}`) => api('/api/timetable/teacher' + q, email ? await tok(email) : null, null, 'GET')
const sc = async (email, body) => api('/api/schedule-changes', await tok(email), body)

async function main() {
  await seed()
  const { db } = admin()
  const revNow = async () => Number((await db.doc('schools/S1').get()).get('scheduleRevision') || 0)
  note('setup', `TODAY=${TODAY}, 조회 기간 ${MON}~${SUN}, 화요일 ${TUE}`)

  // ───── 인증·권한·기간 ─────
  let r = await api(`/api/timetable/teacher?from=${MON}&to=${SUN}`, null, null, 'GET')
  check('A1', '토큰 없음 → 401 unauthenticated', r.status === 401 && r.j.code === 'unauthenticated', `${r.status} ${r.j.code}`)
  r = await api(`/api/timetable/teacher?from=${MON}&to=${SUN}`, 'not-a-token', null, 'GET')
  check('A1', '잘못된 토큰 → 401', r.status === 401, `${r.status}`)
  r = await teacherApi('a@e2e.kr')
  check('A2', '학생 → 403 teacher-only(빈 시간표로 위장하지 않음)', r.status === 403 && r.j.code === 'teacher-only' && !r.j.days, `${r.status} ${r.j.code}`)
  r = await teacherApi('noprof@e2e.kr')
  check('A2', '가입 미완료(users 문서 없음) → 403 no-profile', r.status === 403 && r.j.code === 'no-profile', `${r.status} ${r.j.code}`)
  r = await teacherApi('tnos@e2e.kr')
  check('A3', '학교 없는 교사 → 409 no-school', r.status === 409 && r.j.code === 'no-school', `${r.status} ${r.j.code}`)
  r = await teacherApi('tme@e2e.kr', `?from=${MON}&to=${addDays(MON, 21)}`)
  check('A4', '22일 기간 → 400 bad-range', r.status === 400 && r.j.code === 'bad-range', `${r.status} ${r.j.code}`)
  r = await teacherApi('tme@e2e.kr', `?from=2026-10-01&to=${SUN}`)
  check('A4', '날짜 형식 오류 → 400 bad-date', r.status === 400 && r.j.code === 'bad-date', `${r.status} ${r.j.code}`)
  r = await teacherApi('tme@e2e.kr', `?from=${SUN}&to=${MON}`)
  check('A4', '끝이 시작보다 빠름 → 400 bad-range', r.status === 400 && r.j.code === 'bad-range', `${r.status} ${r.j.code}`)
  r = await teacherApi('tme@e2e.kr', `?from=${MON}&to=${addDays(MON, 20)}`)
  check('A4', '21일 기간 → 200, 날짜 21개', r.status === 200 && Object.keys(r.j.days || {}).length === 21, `${r.status} ${Object.keys(r.j.days || {}).length}`)
  r = await teacherApi('tme@e2e.kr', '')
  check('A4', '기간 생략 → 기본(어제~13일 뒤, 15일)', r.status === 200 && Object.keys(r.j.days || {}).length === 15 && r.j.from === addDays(TODAY, -1), `${r.status} ${r.j.from}~${r.j.to}`)
  const viaPost = await api(`/api/timetable/teacher?from=${MON}&to=${SUN}`, await tok('tme@e2e.kr'), {}, 'POST')
  check('A4', 'GET 외 → 405', viaPost.status === 405, `${viaPost.status}`)

  // ───── 변경 발행(실제 API) ─────
  let rev = await revNow()
  // 1) 내 영어 B 화3(TUE) → 정대체에게(changed-away)
  r = await sc('tme@e2e.kr', { action: 'publish', mutationId: 'sa5-away-00001', expectedRevision: rev, reason: '출장', items: [{ op: 'reschedule', courseId: 'engB', occurrenceKey: `sr_engB_tue3@${TUE}`, target: { teacherUids: ['tz'] } }] })
  check('P1', '영어 B 화3 담당을 정대체로 바꾸는 변경 발행', r.status === 200, `${r.status} ${r.j.code || ''}`)
  rev = await revNow()
  // 2) 생활과 과학 A 화4(TUE) → 나(substitute)
  r = await sc('tx@e2e.kr', { action: 'publish', mutationId: 'sa5-sub-000001', expectedRevision: rev, reason: '보강 협의', items: [{ op: 'reschedule', courseId: 'sciA', occurrenceKey: `sr_sciA_tue4@${TUE}`, target: { teacherUids: ['tme'] } }] })
  check('P2', '김과학이 생활과 과학 A 화4를 이영어(uid)에게 넘기는 변경 발행', r.status === 200, `${r.status} ${r.j.code || ''} ${JSON.stringify(r.j.conflicts || '').slice(0, 200)}`)
  rev = await revNow()
  // 3) 내 영어 B 목2(THU) 취소
  r = await sc('tme@e2e.kr', { action: 'publish', mutationId: 'sa5-cancel-0001', expectedRevision: rev, reason: '학교 행사', items: [{ op: 'cancel', courseId: 'engB', occurrenceKey: `sr_engB_thu2@${THU}` }] })
  check('P3', '영어 B 목2 취소 발행', r.status === 200, `${r.status} ${r.j.code || ''}`)
  rev = await revNow()
  // 4) 영어 B 보강(FRI 1교시)
  r = await sc('tme@e2e.kr', { action: 'publish', mutationId: 'sa5-makeup-0001', expectedRevision: rev, reason: '취소 보강', items: [{ op: 'makeup', courseId: 'engB', target: { date: FRI, period: 1, roomName: '어학실' } }] })
  check('P4', '영어 B 보강(금 1교시) 발행', r.status === 200, `${r.status} ${r.j.code || ''}`)
  rev = await revNow()
  // 5) 생활과 과학 A 화4(NEXT_TUE)를 '이름만' 이영어로(계정 없는 대체 강사처럼) — 내 수업이 되면 안 됨
  r = await sc('tx@e2e.kr', { action: 'publish', mutationId: 'sa5-name-000001', expectedRevision: rev, items: [{ op: 'reschedule', courseId: 'sciA', occurrenceKey: `sr_sciA_tue4@${NEXT_TUE}`, target: { teacherNames: ['이영어'] } }] })
  check('P5', '이름만 이영어로 바꾸는 변경 발행(uid 없음)', r.status === 200, `${r.status} ${r.j.code || ''}`)

  // ───── 교사 ME 자료 ─────
  r = await teacherApi('tme@e2e.kr')
  const p = r.j
  check('B0', 'ME 조회 200 + 버전 = schools/S1.scheduleRevision', r.status === 200 && p.revision === (await revNow()), `${r.status} rev=${p.revision}`)
  const lessonsOn = (d) => (p.days?.[d]?.lessons || []).map((l) => `${l.courseId}:${l.period}:${l.role}`)
  check('B1', `화(${TUE}): 영어 B 3교시 changed-away + 생활과 과학 A 4교시 substitute, 이름만 같은 영어 N 없음`,
    JSON.stringify(lessonsOn(TUE)) === JSON.stringify(['engB:3:changed-away', 'sciA:4:substitute']), JSON.stringify(lessonsOn(TUE)))
  const away = p.days?.[TUE]?.lessons?.find((l) => l.courseId === 'engB')
  check('B1', 'changed-away: 교사 변경 전후(이영어 → 정대체)·사유',
    !!away && JSON.stringify(away.change?.fields) === '["teacher"]' && away.change?.before?.teacherNames?.[0] === '이영어' && away.change?.after?.teacherNames?.[0] === '정대체' && away.change?.reason === '출장',
    JSON.stringify(away?.change || null).slice(0, 300))
  const sub = p.days?.[TUE]?.lessons?.find((l) => l.courseId === 'sciA')
  check('B2', 'substitute: 남의 수업이라 manageable=false, 교사 변경 전후(김과학 → 이영어)', !!sub && sub.manageable === false && sub.change?.before?.teacherNames?.[0] === '김과학' && sub.change?.after?.teacherNames?.[0] === '이영어', JSON.stringify(sub || null).slice(0, 300))
  check('B3', `목(${THU}): 영어 B 2교시는 수업 목록에 없고 취소 안내`,
    lessonsOn(THU).length === 0 && (p.days?.[THU]?.notices || []).some((n) => n.kind === 'cancelled' && n.courseId === 'engB' && n.original?.period === 2 && n.reason === '학교 행사'),
    JSON.stringify(p.days?.[THU] || null).slice(0, 300))
  check('B4', `금(${FRI}): 보강 1교시(makeup, 어학실)`,
    JSON.stringify(lessonsOn(FRI)) === '["engB:1:makeup"]' && p.days?.[FRI]?.lessons?.[0]?.roomName === '어학실', JSON.stringify(p.days?.[FRI]?.lessons || null).slice(0, 200))
  check('B5', `수(${WED}): 공통 수업 국어 1교시(학급 3학년 4반, 담당이라 manageable)`,
    JSON.stringify(lessonsOn(WED)) === '["kor34:1:mine"]' && p.days?.[WED]?.lessons?.[0]?.classLabel === '3학년 4반' && p.days?.[WED]?.lessons?.[0]?.manageable === true,
    JSON.stringify(p.days?.[WED]?.lessons || null).slice(0, 200))
  check('B6', '공식 수업이 있는 교사 → 날짜마다 hasOfficial(주말 포함)', [MON, TUE, SUN].every((d) => p.days?.[d]?.hasOfficial === true))

  // 다음 주: 이름만 바꾼 변경은 내 수업이 아님
  const nx = (await teacherApi('tme@e2e.kr', `?from=${NEXT_TUE}&to=${NEXT_TUE}`)).j
  const nxLessons = (nx.days?.[NEXT_TUE]?.lessons || []).map((l) => `${l.courseId}:${l.role}`)
  check('B7', '이름만 이영어로 바꾼 차시(uid 없음)는 대신 들어가는 수업이 아님 — 영어 B만', JSON.stringify(nxLessons) === '["engB:mine"]', JSON.stringify(nxLessons))

  // 학생 화면과 같은 변경 정보: 학생 A의 /me + 엔진 결과와 비교
  const me = await api(`/api/timetable/me?from=${TUE}&to=${TUE}`, await tok('a@e2e.kr'), null, 'GET')
  const studentDay = buildDayTimetable({
    uid: 'stuA',
    day: { date: TUE, offDay: me.j.offDays?.[TUE] ?? null, periodTimes: me.j.periodTimes },
    homerooms: me.j.homerooms, enrollments: me.j.enrollments, courses: me.j.courses, series: me.j.series, overrides: me.j.overrides, personalEntries: [],
  })
  const stuSci = studentDay.lessons.find((l) => l.courseId === 'sciA')
  const stuEng = studentDay.lessons.find((l) => l.courseId === 'engB')
  check('B8', '학생 화면과 같은 변경 전후(교사 변경 항목·변경 후 교사 이름·교시)',
    me.status === 200 && !!stuSci && !!stuEng &&
      JSON.stringify(stuSci.change?.fields) === JSON.stringify(sub?.change?.fields) && JSON.stringify(stuSci.change?.after?.teacherNames) === JSON.stringify(sub?.change?.after?.teacherNames) &&
      JSON.stringify(stuEng.change?.fields) === JSON.stringify(away?.change?.fields) && stuEng.period === away?.period,
    JSON.stringify({ stu: [stuSci?.change?.fields, stuEng?.change?.fields], teacher: [sub?.change?.fields, away?.change?.fields] }))

  // ───── 응답에 학생·다른 교사 자료 없음 ─────
  const text = JSON.stringify(p)
  const leaked = ['stuA', 'stuB', 'a@e2e.kr', 'b@e2e.kr', ...STUDENT_NAMES, 'enrollments', 'teacherUids', 'managerUids', '"tx"', '"tz"', '"tleg"', '병원 진료', '개인 사정'].filter((x) => text.includes(x))
  check('C1', '응답에 학생 uid·이메일·이름·수강, 교사 uid, 보결 사유·교환 메모 없음', leaked.length === 0, leaked.join(','))
  check('C2', '응답 키는 정해진 것만', JSON.stringify(Object.keys(p).sort()) === JSON.stringify(['calendarErrors', 'covers', 'days', 'from', 'generatedAt', 'gradeOffDays', 'mySchedule', 'offDays', 'periodTimes', 'revision', 'schoolCode', 'terms', 'to']), Object.keys(p).join(','))

  // ───── 다른 학교 같은 이름 교사 ─────
  const w = (await teacherApi('tw@e2e.kr')).j
  const wLessons = (w.days?.[TUE]?.lessons || []).map((l) => l.courseId)
  check('C3', '다른 학교(S2) 같은 이름 교사: 자기 학교 수업만(S1 영어 B·영어 N 없음)', JSON.stringify(wLessons) === '["engB2"]' && !JSON.stringify(w).includes('sciA'), JSON.stringify(wLessons))

  // ───── 교환·보결 ─────
  const covers = (p.covers || []).map((c) => `${c.kind}:${c.direction}:${c.date === TUE ? 'TUE' : c.date === MON ? 'MON' : c.date}:${c.period}:${c.otherName}`)
  check('D1', `ME 교환·보결: 내가 요청한 품앗이(정대체가 대신), 내가 받은 1:1 품앗이, 내가 맡은 보결 — 대기·남의 것·기간 밖·모집 중 SOS 제외(다른 교사 모집 중 요청 ${SPAM_DOCS}건씩이 있어도 잘리지 않음)`,
    JSON.stringify(covers) === JSON.stringify(['sos:covering:MON:2:박주간', 'swap:covered:TUE:6:정대체', 'swap:covering:TUE:7:김과학']), JSON.stringify(covers))
  const dirCover = (p.covers || []).find((c) => c.period === 7)
  check('D2', "요청 교사 담임 학급 '담임 없음'은 빈 값, 교환 칸 문구는 그대로", dirCover?.requesterClass === '' && dirCover?.subject === '1-2 과학', JSON.stringify(dirCover))
  const tueView = buildTeacherDay(p, TUE)
  const tueRows = tueView.rows.map((x) => `${x.kind}:${x.lesson.period}:${x.lesson.title}`)
  check('D3', '화요일 화면: 공식 방식, 공식 수업 + 대신 들어가는 교환(7교시) + 다른 선생님이 대신하는 내 교시(6교시) 행',
    tueView.mode === 'official' && JSON.stringify(tueRows) === JSON.stringify(['official:3:영어 B', 'official:4:생활과 과학 A', 'covered-only:6:영어', 'covering:7:대신 들어가는 수업 · 1-2 과학 (김과학 선생님)']),
    JSON.stringify(tueRows))
  check('D4', '공식 방식이면 예전 주간 시간표는 참고로만(화 1교시 칸)', JSON.stringify(tueView.legacyReference) === JSON.stringify([{ period: 1, text: '1-3 국어' }]), JSON.stringify(tueView.legacyReference))

  // ───── 예전 주간 시간표 대체 방식 ─────
  const leg = (await teacherApi('tleg@e2e.kr')).j
  check('E1', '공식 수업 없는 교사: hasOfficial=false, mySchedule 그대로, 내가 요청한 보결(이영어가 대신)',
    Object.values(leg.days || {}).every((d) => d.hasOfficial === false && d.lessons.length === 0) && leg.mySchedule?.mon?.[1] === '2-1 국어' &&
      JSON.stringify((leg.covers || []).map((c) => `${c.kind}:${c.direction}:${c.period}:${c.otherName}`)) === '["sos:covered:2:이영어"]',
    JSON.stringify({ my: leg.mySchedule?.mon, covers: leg.covers }).slice(0, 300))
  const legMon = buildTeacherDay(leg, MON)
  const legRow = legMon.rows.find((x) => x.lesson.period === 2)
  check('E2', '월요일 화면: 주간 시간표 방식(2교시 국어 · 2학년 1반) + 보결 겹침(이영어 선생님이 대신 들어가요)',
    legMon.mode === 'legacy' && legMon.rows.length === 1 && legRow?.kind === 'legacy' && legRow?.classLabel === '2학년 1반' && legRow?.coveredBy?.[0]?.otherName === '이영어',
    JSON.stringify(legMon.rows).slice(0, 300))
  const empty = (await teacherApi('tempty@e2e.kr')).j
  const emptyMon = buildTeacherDay(empty, MON)
  check('E3', '아무것도 없는 교사: 빈 상태(not-registered), 주간 시간표 null',
    empty.mySchedule === null && emptyMon.mode === 'empty' && emptyMon.state === 'not-registered' && (empty.covers || []).length === 0, JSON.stringify({ mode: emptyMon.mode, state: emptyMon.state }))

  // ───── 쉬는 날: 일부 학년만 vs 학교 전체(교사는 담임 학년 하나로 정하지 않음) ─────
  const nw = (await teacherApi('tme@e2e.kr', `?from=${NEXT_TUE}&to=${NEXT_THU}`)).j
  check('G1', `학년별 행은 학교 전체 쉬는 날이 아님(offDays null) → gradeOffDays, 1~3학년 모두면 학교 전체`,
    nw.offDays?.[NEXT_TUE] === null && nw.offDays?.[NEXT_WED] === null && nw.offDays?.[NEXT_THU]?.name === '재량휴업일' &&
      JSON.stringify(nw.gradeOffDays) === JSON.stringify({ [NEXT_TUE]: { name: '1학년 현장체험 휴업일', grades: [1] }, [NEXT_WED]: { name: '3학년 재량휴업일', grades: [3] } }),
    JSON.stringify({ off: nw.offDays, g: nw.gradeOffDays }))
  const nwOn = (d) => (nw.days?.[d]?.lessons || []).map((l) => `${l.courseId}:${l.period}`)
  const nwSup = (d) => (nw.days?.[d]?.notices || []).filter((n) => n.kind === 'holiday-suppressed').map((n) => n.courseId)
  check('G2', '3학년만 쉬는 날(담임 3학년 교사): 3학년 4반 공통 국어만 열리지 않음, 학년 모르는 영어 B 5교시는 열림',
    JSON.stringify(nwOn(NEXT_WED)) === '["engB:5"]' && JSON.stringify(nwSup(NEXT_WED)) === '["kor34"]', JSON.stringify({ on: nwOn(NEXT_WED), sup: nwSup(NEXT_WED) }))
  check('G3', '1학년만 쉬는 날: 담임 3학년 교사의 영어 B 3교시 그대로', JSON.stringify(nwOn(NEXT_TUE)) === '["engB:3"]', JSON.stringify(nwOn(NEXT_TUE)))
  const nwThu = buildTeacherDay(nw, NEXT_THU)
  check('G4', '모든 학년 휴업(학교 전체): 영어 B 목2 열리지 않음, 화면 holiday', nwOn(NEXT_THU).length === 0 && nwSup(NEXT_THU).includes('engB') && nwThu.state === 'holiday',
    JSON.stringify({ on: nwOn(NEXT_THU), state: nwThu.state }))
  const nwWed = buildTeacherDay(nw, NEXT_WED)
  check('G5', '3학년만 쉬는 날 화면: holiday 아님(lessons) + 학년 쉬는 날 정보 + 열리지 않는 수업 안내',
    nwWed.state === 'lessons' && nwWed.gradeOff?.grades?.[0] === 3 && nwWed.suppressed.length === 1, JSON.stringify({ state: nwWed.state, g: nwWed.gradeOff }))
  // 학년 없는 교사(담임 아님): 학생 규칙(학년 모르면 학년별 행도 쉬는 날)을 쓰면 하루 전체가 쉬는 날이 되던 경우
  const txNext = (await teacherApi('tx@e2e.kr', `?from=${NEXT_TUE}&to=${NEXT_TUE}`)).j
  check('G6', "학년 없는 교사: '1학년 현장체험 휴업일'에 학년 모르는 생활과 과학 A 4교시가 그대로(하루 전체를 쉬는 날로 보지 않음)",
    txNext.offDays?.[NEXT_TUE] === null && JSON.stringify((txNext.days?.[NEXT_TUE]?.lessons || []).map((l) => `${l.courseId}:${l.period}`)) === '["sciA:4"]',
    JSON.stringify({ off: txNext.offDays, lessons: txNext.days?.[NEXT_TUE]?.lessons?.map((l) => l.courseId) }))
  const legNext = (await teacherApi('tleg@e2e.kr', `?from=${NEXT_TUE}&to=${NEXT_TUE}`)).j
  const legNextView = buildTeacherDay(legNext, NEXT_TUE)
  check('G7', "주간 시간표 교사: 1학년만 쉬는 날에 '1-3 국어' 칸은 열리지 않음 안내, 상태 no-lessons(학교는 열림)",
    legNextView.mode === 'legacy' && legNextView.state === 'no-lessons' && JSON.stringify(legNextView.suppressedCells) === JSON.stringify([{ period: 1, text: '1-3 국어' }]),
    JSON.stringify({ state: legNextView.state, cells: legNextView.suppressedCells }))

  // ───── 담임 학급 교시표: users.classId는 본인이 고칠 수 있는 값 ─────
  const fake = await teacherApi('tfake@e2e.kr')
  const fake2 = await teacherApi('tfake2@e2e.kr')
  const fake3 = await teacherApi('tfake3@e2e.kr')
  check('H1', '남의 학급(담임 아님)·다른 학교 학급·경로 모양 classId는 학급 교시표를 쓰지 않음 → 학교 엑셀 교시표(08:50), 500 아님',
    fake.status === 200 && fake2.status === 200 && fake3.status === 200 &&
      [fake, fake2, fake3].every((x) => x.j.periodTimes?.[0]?.start === '08:50'),
    [fake, fake2, fake3].map((x) => `${x.status}:${x.j.periodTimes?.[0]?.start}`).join(' '))

  // ───── 학기·교시 시각 ─────
  check('F1', '학기: 학교 학기 문서(T1)', (p.terms || []).some((t) => t.termId === 'T1' && t.startDate === TERM_START && t.endDate === TERM_END), JSON.stringify(p.terms))
  check('F2', '교시 시각: 담임 학급 교시표(09:10) 우선 → 담임 아닌 교사는 학교 엑셀 교시표(08:50)',
    p.periodTimes?.[0]?.start === '09:10' && leg.periodTimes?.[0]?.start === '08:50' && leg.periodTimes?.[0]?.end === '09:40', `${p.periodTimes?.[0]?.start} / ${leg.periodTimes?.[0]?.start}~${leg.periodTimes?.[0]?.end}`)
  await db.doc('school_timetables/S1').delete()
  const legNoMaster = (await teacherApi('tleg@e2e.kr')).j
  check('F3', '학교 엑셀 교시표가 없으면 학교급(고등학교) 기본 08:40', legNoMaster.periodTimes?.[0]?.start === '08:40', String(legNoMaster.periodTimes?.[0]?.start))

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
