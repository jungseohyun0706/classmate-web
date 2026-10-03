// 공식 수업 일정 변경(변경 묶음) API 통합 테스트 — 아키텍처 5.1절, 지시서 11·12·15·16장
// 대상: /api/schedule-changes (preview·publish·approve·reject·list·orphans) + /api/timetable/me(학생 화면 자료)
// 실행 전제: 실제 서버(BASE, 기본 http://127.0.0.1:3100) + Firebase 에뮬레이터(Firestore 8080, Auth 9099)
//           + NEIS mock(NODE_OPTIONS="--require tests/support/neis-mock.cjs", NEIS_MOCK_FILE)
// 사용: node tests/api/sa2-schedule-changes.test.mjs
// 학생 화면 검증은 /api/timetable/me 자료를 실제 엔진(src/lib/timetable/engine.ts — 이 테스트가 CommonJS로 변환해 씀)으로 계산합니다.
// 모든 데이터는 에뮬레이터의 테스트용 가상 데이터이며 실제 학생 정보가 아닙니다.
import fs from 'fs'
import path from 'path'
import { admin, wipe, createUsers, writeNeisFixture, clientSession, api, reporter, require, ROOT, Timestamp } from '../e2e/lib/env.mjs'

const { OUT, check, note, finish } = reporter('api-sa2-schedule-changes')

// ───────── 날짜(학교 시간대 KST) ─────────
const ymdOf = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
const toDate = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)))
const addDays = (ymd, n) => ymdOf(new Date(toDate(ymd).getTime() + n * 86400000))
const weekdayOf = (ymd) => toDate(ymd).getUTCDay() || 7
const TODAY = ymdOf(new Date(Date.now() + 9 * 3600 * 1000))
// 이틀 뒤 이후 첫 화요일부터 한 주씩 — 시나리오마다 다른 화요일을 써서 서로 섞이지 않게
let D1 = addDays(TODAY, 2)
while (weekdayOf(D1) !== 2) D1 = addDays(D1, 1)
const D2 = addDays(D1, 7) // 교시 교환(T17)
const D3 = addDays(D1, 14) // 날짜 이동(T18) + 교사 충돌(T26)
const D4 = addDays(D1, 21) // 담당 아닌 교환 거절(T40) → 교실·교사 변경(T19)
const D5 = addDays(D1, 28) // 취소·보강(T20)
const D6 = addDays(D1, 35) // 기본 시간표 변경 적용일(T21)
const D7 = addDays(D1, 42) // 기본 변경 전에 만든 날짜 변경 → orphan(T22)
const D8 = addDays(D1, 49) // 승인자 두 명 동시 승인(검토 [3][7])
const D9 = addDays(D1, 56) // 승인 시점에 새로 생긴 충돌(검토 [5])
const D10 = addDays(D1, 63) // 요청 때 확인한 충돌만 그대로 → 요청자 확인으로 승인(검토 [5])
const TERM_START = addDays(TODAY, -30)
const TERM_END = addDays(TODAY, 150)

const S1 = { schoolCode: 'S1', schoolName: '테스트고등학교', officeCode: 'B10' }
const S2 = { schoolCode: 'S2', schoolName: '다른고등학교', officeCode: 'B10' }
const STUDENT_NAMES = ['김학생가', '이학생나', '박학생다']

// ───────── 실제 엔진 불러오기(TS → CommonJS) ─────────
function loadEngine() {
  const ts = require('typescript')
  const dir = path.join(OUT, 'engine')
  fs.mkdirSync(dir, { recursive: true })
  for (const f of ['dates', 'engine']) {
    const src = fs.readFileSync(path.join(ROOT, 'src/lib/timetable', f + '.ts'), 'utf8')
    const js = ts
      .transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } })
      .outputText.replace(/require\("\.\/dates"\)/g, 'require("./dates.cjs")')
    fs.writeFileSync(path.join(dir, f + '.cjs'), js)
  }
  return require(path.join(dir, 'engine.cjs'))
}
const { buildDayTimetable } = loadEngine()

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
  const T = (name, school = S1) => ({ role: 'teacher', name, displayName: name, ...school })
  const St = (name, classId, grade, classNm, studentId) => ({ role: 'student', status: 'approved', name, displayName: name, classId, grade, classNm, studentId, ...S1 })
  await createUsers([
    { uid: 'tx', email: 'tx@e2e.kr', doc: T('김과학') }, // 교사 X: 생활과 과학 A·C
    { uid: 'ty', email: 'ty@e2e.kr', doc: T('이영어') }, // 교사 Y: 영어 A·B
    { uid: 'tz', email: 'tz@e2e.kr', doc: T('박수학') }, // 교사 Z: 담당 수업 없음(대체 교사·권한 검사)
    { uid: 'tw', email: 'tw@e2e.kr', doc: T('이영어', S2) }, // 다른 학교 S2의 같은 이름 교사
    { uid: 'stuA', email: 'a@e2e.kr', doc: St(STUDENT_NAMES[0], 'S1_3_4', 3, 4, 1) }, // 생활과 과학 A + 영어 B
    { uid: 'stuB', email: 'b@e2e.kr', doc: St(STUDENT_NAMES[1], 'S1_3_5', 3, 5, 2) }, // 영어 B만
    { uid: 'stuC', email: 'c@e2e.kr', doc: St(STUDENT_NAMES[2], 'S1_3_4', 3, 4, 3) }, // 생활과 과학 A + 영어 A(같은 과목 다른 분반)
  ])
  const { db } = admin()
  const now = Timestamp.now()
  await db.doc('classes/S1_3_4').set({ classId: 'S1_3_4', grade: 3, classNm: 4, teacherId: 'tx', teacherName: '김과학', createdAt: now, ...S1 })
  await db.doc('classes/S1_3_5').set({ classId: 'S1_3_5', grade: 3, classNm: 5, teacherId: 'ty', teacherName: '이영어', createdAt: now, ...S1 })
  const s = db.doc('schools/S1')
  await s.set({ name: '테스트고등학교', kind: '고등학교', scheduleRevision: 0, timezone: 'Asia/Seoul' })
  await db.doc('schools/S2').set({ name: '다른고등학교', kind: '고등학교', scheduleRevision: 0, timezone: 'Asia/Seoul' })
  await s.collection('terms').doc('T1').set({ name: '테스트 학기', startDate: TERM_START, endDate: TERM_END })
  const course = (id, title, subject, section, teacher, teacherName, room) =>
    s.collection('courses').doc(id).set({
      schoolCode: 'S1', termId: 'T1', title, subject, section, teacherUids: [teacher], teacherNames: [teacherName], status: 'active', endedOn: null,
      commonForHomerooms: [], defaultRoomName: room, invitePolicy: 'auto', catalogVisible: false, source: 'manual', createdBy: teacher, createdAt: now, updatedAt: now, revision: 0,
    })
  await course('sciA', '생활과 과학 A', '생활과 과학', 'A', 'tx', '김과학', '3학년 4반 교실')
  await course('sciC', '생활과 과학 C', '생활과 과학', 'C', 'tx', '김과학', '과학실')
  await course('engB', '영어 B', '영어', 'B', 'ty', '이영어', '3학년 5반 교실')
  await course('engA', '영어 A', '영어', 'A', 'ty', '이영어', '어학실 2')
  await db.doc('schools/S2/courses/engB2').set({ schoolCode: 'S2', termId: 'T1', title: '영어 B', subject: '영어', teacherUids: ['tw'], teacherNames: ['이영어'], status: 'active', commonForHomerooms: [] })
  const ser = (id, courseId, weekday, period) =>
    s.collection('series').doc(id).set({ courseId, termId: 'T1', weekday, period, validFrom: TERM_START, validTo: null, status: 'active', createdBy: 'seed', createdAt: now })
  await ser('sr_sciA_tue4', 'sciA', 2, 4)
  await ser('sr_engB_tue3', 'engB', 2, 3)
  await ser('sr_engA_tue1', 'engA', 2, 1)
  await ser('sr_sciC_tue2', 'sciC', 2, 2)
  const en = (courseId, uid) =>
    s.collection('enrollments').doc(`${courseId}__${uid}`).set({ courseId, uid, schoolCode: 'S1', termId: 'T1', status: 'active', source: 'admin', createdAt: now, updatedAt: now })
  await en('sciA', 'stuA')
  await en('engB', 'stuA')
  await en('engB', 'stuB')
  await en('sciA', 'stuC')
  await en('engA', 'stuC')
}

const sessions = {}
async function tok(email) {
  if (!sessions[email]) sessions[email] = await clientSession(email)
  return sessions[email].token
}
const sc = async (email, body) => api('/api/schedule-changes', email ? await tok(email) : null, body)
const UID = { 'a@e2e.kr': 'stuA', 'b@e2e.kr': 'stuB', 'c@e2e.kr': 'stuC' }

/** 학생 화면: /api/timetable/me(그 날짜 하루) → 실제 엔진으로 하루 시간표 */
async function dayView(email, date) {
  const r = await api(`/api/timetable/me?from=${date}&to=${date}`, await tok(email), null, 'GET')
  if (r.status !== 200) return { error: `${r.status} ${r.j.code}`, lessons: [], notices: [], orphanOverrides: [], conflicts: [] }
  const p = r.j
  return buildDayTimetable({
    uid: UID[email],
    day: { date, offDay: p.offDays?.[date] ?? null, periodTimes: p.periodTimes },
    homerooms: p.homerooms,
    enrollments: p.enrollments,
    courses: p.courses,
    series: p.series,
    overrides: p.overrides,
    personalEntries: [],
  })
}
const lessonOf = (day, courseId) => day.lessons.filter((l) => l.courseId === courseId)
const periods = (day) => JSON.stringify(day.error || day.lessons.map((l) => [l.title, l.period]))

async function main() {
  await seed()
  const { db } = admin()
  const revisionNow = async () => Number((await db.doc('schools/S1').get()).get('scheduleRevision') || 0)
  const notif = (uid, id) => db.doc(`users/${uid}/notifications/${id}`).get()
  note('setup', `TODAY=${TODAY}, 화요일 D1=${D1} … D7=${D7}, 학기 T1 ${TERM_START}~${TERM_END}`)

  const itemsD1 = [{ op: 'reschedule', courseId: 'engB', occurrenceKey: `sr_engB_tue3@${D1}`, target: { date: D1, period: 2 } }]

  // ───── T39 권한 우회 ─────
  let r = await sc(null, { action: 'preview', items: itemsD1 })
  check('T39', '토큰 없음 → 401 unauthenticated', r.status === 401 && r.j.code === 'unauthenticated', `${r.status} ${r.j.code}`)
  r = await sc('a@e2e.kr', { action: 'publish', schoolCode: 'S1', mutationId: 'stu-publish-0001', expectedRevision: 0, items: itemsD1 })
  check('T39', '학생 publish → 403 forbidden', r.status === 403 && r.j.code === 'forbidden', `${r.status} ${r.j.code}`)
  r = await sc('a@e2e.kr', { action: 'preview', items: itemsD1 })
  check('T39', '학생 preview → 403', r.status === 403, `${r.status} ${r.j.code}`)
  r = await sc('a@e2e.kr', { action: 'list', courseId: 'engB' })
  check('T39', '학생 변경 이력 list → 403', r.status === 403, `${r.status} ${r.j.code}`)
  r = await sc('a@e2e.kr', { action: 'publish', garbage: true })
  check('T39', '학생은 본문이 잘못돼도 403(입력 검증보다 권한 먼저)', r.status === 403, `${r.status} ${r.j.code}`)
  r = await sc('tw@e2e.kr', { action: 'preview', schoolCode: 'S1', items: itemsD1 })
  check('T39', '다른 학교(S2) 교사가 S1 시간표 → 403 other-school', r.status === 403 && r.j.code === 'other-school', `${r.status} ${r.j.code}`)
  r = await sc('tw@e2e.kr', { action: 'publish', schoolCode: 'S2', mutationId: 'cross-school-0001', expectedRevision: 0, items: itemsD1 })
  check('T39', '다른 학교 교사가 자기 학교 코드로 S1 수업 id → 404(같은 이름 수업과 섞이지 않음)', r.status === 404 && r.j.code === 'course-not-found', `${r.status} ${r.j.code}`)

  // ───── 입력 검증(T31 성격: 잘못된 교시·시각·학기 범위) ─────
  r = await sc('ty@e2e.kr', { action: 'preview', items: [{ op: 'reschedule', courseId: 'engB', occurrenceKey: 'bad-key', target: { period: 2 } }] })
  check('T16', '잘못된 occurrenceKey → 400 invalid-item', r.status === 400 && r.j.code === 'invalid-item', `${r.status} ${r.j.code}`)
  r = await sc('ty@e2e.kr', { action: 'preview', items: [{ op: 'reschedule', courseId: 'engB', occurrenceKey: `sr_engB_tue3@${addDays(D1, 1)}`, target: { period: 2 } }] })
  check('T16', '그 날짜에 열리지 않는 차시 → 404 occurrence-not-found', r.status === 404 && r.j.code === 'occurrence-not-found', `${r.status} ${r.j.code}`)
  r = await sc('ty@e2e.kr', { action: 'preview', items: [{ op: 'reschedule', courseId: 'engB', occurrenceKey: `sr_engB_tue3@${D1}`, target: { period: 11 } }] })
  check('T16', '교시 범위 밖 → 400 invalid-slot', r.status === 400 && r.j.code === 'invalid-slot', `${r.status} ${r.j.code}`)
  r = await sc('ty@e2e.kr', { action: 'preview', items: [{ op: 'reschedule', courseId: 'engB', occurrenceKey: `sr_engB_tue3@${D1}`, target: { start: '10:00', end: '09:00' } }] })
  check('T16', '끝 시각이 시작보다 빠름 → 400 invalid-slot', r.status === 400 && r.j.code === 'invalid-slot', `${r.status} ${r.j.code}`)
  r = await sc('ty@e2e.kr', { action: 'preview', items: [{ op: 'reschedule', courseId: 'engB', occurrenceKey: `sr_engB_tue3@${D1}`, target: { date: addDays(TERM_END, 7) } }] })
  check('T16', '학기 범위 밖 날짜 → 400 out-of-term', r.status === 400 && r.j.code === 'out-of-term', `${r.status} ${r.j.code}`)
  r = await sc('ty@e2e.kr', { action: 'publish', mutationId: 'no-revision-0001', items: itemsD1 })
  check('T27', 'expectedRevision 없는 발행 → 400', r.status === 400 && r.j.code === 'invalid-request', `${r.status} ${r.j.code}`)

  // ───── T16 / 대표 흐름 7~10: 영어 B 화3 → 화2 (D1) ─────
  r = await sc('ty@e2e.kr', { action: 'preview', items: itemsD1 })
  const pv = r.j
  const c0 = pv.changes?.[0]
  check('T16', 'preview: 변경 전후(3→2)·time·영향 학생 2명·충돌 없음·승인 불필요',
    r.status === 200 && c0?.before?.period === 3 && c0?.after?.period === 2 && JSON.stringify(c0?.fields) === '["time"]' && pv.affectedStudentCount === 2 && pv.conflicts.length === 0 && pv.requiresApproval === false,
    `${r.status} ${JSON.stringify({ c0, n: pv.affectedStudentCount, k: pv.conflicts }).slice(0, 300)}`)
  check('T46', 'preview 응답에 학생 이름·uid 없음(영향 인원 수만)', !new RegExp(STUDENT_NAMES.join('|') + '|stu[ABC]').test(JSON.stringify(pv)))
  const rev0 = pv.revision
  const body16 = { action: 'publish', schoolCode: 'S1', mutationId: 'm-t16-engB-0001', expectedRevision: rev0, scope: 'date', reason: '학교 행사', items: itemsD1 }
  r = await sc('ty@e2e.kr', body16)
  const pub16 = r.j
  check('T16', 'publish 200, scheduleRevision +1', r.status === 200 && pub16.status === 'published' && pub16.revision === rev0 + 1 && (await revisionNow()) === rev0 + 1, `${r.status} ${pub16.code || pub16.status} rev=${pub16.revision}`)
  const a1 = await dayView('a@e2e.kr', D1)
  const b1 = await dayView('b@e2e.kr', D1)
  const c1 = await dayView('c@e2e.kr', D1)
  const aE = lessonOf(a1, 'engB')[0]
  const bE = lessonOf(b1, 'engB')[0]
  check('T16', '대표 8: 학생 A 영어 B 2교시 + 변경 전(3교시)·time 표시', aE?.period === 2 && aE?.change?.before?.period === 3 && aE?.change?.fields?.includes('time'), JSON.stringify(aE || a1.error))
  check('T16', '대표 10: 변경 정보(change.kind·fields·before/after·사유) 제공 — 빨간 배지 근거', aE?.change?.kind === 'reschedule' && aE?.change?.reason === '학교 행사' && aE?.change?.after?.period === 2, JSON.stringify(aE?.change))
  check('T16', '대표 8: 학생 B 영어 B 2교시', bE?.period === 2 && !!bE?.change, JSON.stringify(bE || b1.error))
  check('T16', '대표 9: 영어 B 안 듣는 학생 C — 영어 A(같은 과목 다른 분반) 1교시 그대로, 영어 B 없음',
    !lessonOf(c1, 'engB').length && lessonOf(c1, 'engA')[0]?.period === 1 && !lessonOf(c1, 'engA')[0]?.change, periods(c1))
  const nA = await notif('stuA', 'sched_cs_m-t16-engB-0001')
  const nB = await notif('stuB', 'sched_cs_m-t16-engB-0001')
  const nC = await notif('stuC', 'sched_cs_m-t16-engB-0001')
  check('T38', '알림: 수강생 A·B만(C 없음), 날짜별 화면 링크, 잠금 화면에 학생 정보 없음',
    nA.exists && nB.exists && !nC.exists && nA.get('url') === `/student/timetable?date=${D1}` && nA.get('title') === '시간표 변경' && /영어 B/.test(nA.get('body')) && !new RegExp(STUDENT_NAMES.join('|')).test(nA.get('body')),
    JSON.stringify(nA.exists ? { t: nA.get('title'), b: nA.get('body'), u: nA.get('url') } : 'none'))
  const a2 = await dayView('a@e2e.kr', D2)
  check('T21', '대표 11: 다음 주 화요일 영어 B는 기본 3교시 그대로(임시 변경이 다른 주에 번지지 않음)', lessonOf(a2, 'engB')[0]?.period === 3 && !lessonOf(a2, 'engB')[0]?.change, periods(a2))

  // ───── T28 같은 mutationId 재전송 ─────
  r = await sc('ty@e2e.kr', body16)
  check('T28', '재전송 → 200 같은 결과(changeSetId·revision·overrideIds), 버전 그대로',
    r.status === 200 && r.j.replayed === true && r.j.changeSetId === pub16.changeSetId && r.j.revision === pub16.revision && JSON.stringify(r.j.overrideIds) === JSON.stringify(pub16.overrideIds) && (await revisionNow()) === rev0 + 1,
    `${r.status} replayed=${r.j.replayed}`)
  const allA = await db.collection('users/stuA/notifications').get()
  check('T28', '재전송 후에도 학생 A 알림 1건', allA.size === 1, `${allA.size}건`)
  const ovCount = (await db.collection('schools/S1/overrides').where('occurrenceKey', '==', `sr_engB_tue3@${D1}`).get()).size
  check('T28', '재전송 후에도 변경 문서 1개(중복 차시 없음)', ovCount === 1, `${ovCount}개`)
  r = await sc('ty@e2e.kr', { ...body16, reason: '다른 내용' })
  check('T28', '같은 mutationId에 다른 내용 → 409 mutation-id-reused', r.status === 409 && r.j.code === 'mutation-id-reused', `${r.status} ${r.j.code}`)

  // ───── T27 오래된 expectedRevision ─────
  r = await sc('ty@e2e.kr', { action: 'publish', mutationId: 'm-t27-stale-0001', expectedRevision: rev0, items: [{ op: 'cancel', courseId: 'engB', occurrenceKey: `sr_engB_tue3@${D2}` }] })
  check('T27', '오래된 expectedRevision → 409 stale-revision + currentRevision', r.status === 409 && r.j.code === 'stale-revision' && r.j.currentRevision === rev0 + 1, `${r.status} ${JSON.stringify(r.j)}`)
  check('T27', '거부된 요청은 아무것도 쓰지 않음(최신 변경을 덮어쓰지 않음)', !(await db.doc('schools/S1/changeSets/cs_m-t27-stale-0001').get()).exists && (await revisionNow()) === rev0 + 1 && lessonOf(await dayView('a@e2e.kr', D2), 'engB')[0]?.period === 3)

  // ───── T17 교시 교환(D2): 교사 X 요청 → 202 → 교사 Y 승인 → 한 번에 발행 ─────
  const swap = [
    { op: 'reschedule', courseId: 'sciA', occurrenceKey: `sr_sciA_tue4@${D2}`, target: { date: D2, period: 3 } },
    { op: 'reschedule', courseId: 'engB', occurrenceKey: `sr_engB_tue3@${D2}`, target: { date: D2, period: 4 } },
  ]
  r = await sc('tx@e2e.kr', { action: 'preview', items: [swap[0]] })
  check('T17', '한쪽만 옮기면(중간 상태) 학생 A 겹침 충돌로 보고', r.status === 200 && r.j.conflicts.some((c) => c.kind === 'students' && c.detail === '1'), JSON.stringify(r.j.conflicts))
  r = await sc('tx@e2e.kr', { action: 'preview', items: swap })
  check('T26', '교환 묶음 전체는 최종 상태 기준 충돌 없음(정상 교환 통과)', r.status === 200 && r.j.conflicts.length === 0 && r.j.requiresApproval === true, `${r.status} ${JSON.stringify(r.j.conflicts)}`)
  const revSwap = await revisionNow()
  r = await sc('tx@e2e.kr', { action: 'publish', mutationId: 'm-t17-swap-00001', expectedRevision: revSwap, items: swap, reason: '교시 교환' })
  const swapCs = r.j.changeSetId
  check('T40', '담당 아닌 수업(영어 B)이 낀 교환 → 202 pending-approval, 승인자 Y', r.status === 202 && r.j.status === 'pending-approval' && JSON.stringify(r.j.approvals) === '{"ty":false}', `${r.status} ${JSON.stringify(r.j.approvals)}`)
  check('T17', '승인 대기 중에는 버전·학생 화면 그대로', (await revisionNow()) === revSwap && lessonOf(await dayView('a@e2e.kr', D2), 'engB')[0]?.period === 3)
  check('T17', '승인 담당 교사 Y에게 요청 알림', (await notif('ty', 'schedreq_' + swapCs)).exists)
  r = await sc('tz@e2e.kr', { action: 'approve', changeSetId: swapCs })
  check('T40', '승인 담당이 아닌 교사 approve → 403 not-approver', r.status === 403 && r.j.code === 'not-approver', `${r.status} ${r.j.code}`)
  r = await sc('ty@e2e.kr', { action: 'approve', changeSetId: swapCs })
  check('T17', 'Y 승인 → 재검사 후 발행 200, 버전 +1 한 번', r.status === 200 && r.j.status === 'published' && r.j.revision === revSwap + 1 && (await revisionNow()) === revSwap + 1, `${r.status} ${r.j.status || r.j.code} rev=${r.j.revision}`)
  const a2s = await dayView('a@e2e.kr', D2)
  const sA = lessonOf(a2s, 'sciA')[0]
  const eB = lessonOf(a2s, 'engB')[0]
  check('T17', '학생 A: 생활과 과학 A 3교시·영어 B 4교시 — 같은 묶음·같은 revision, 겹침 없음',
    sA?.period === 3 && eB?.period === 4 && sA?.change?.changeSetId === eB?.change?.changeSetId && sA?.change?.revision === eB?.change?.revision && a2s.conflicts.length === 0, periods(a2s))
  check('T17', '학생 B(영어 B만): 영어 B 4교시', lessonOf(await dayView('b@e2e.kr', D2), 'engB')[0]?.period === 4)
  r = await sc('ty@e2e.kr', { action: 'approve', changeSetId: swapCs })
  check('T28', '승인 재요청은 같은 결과(replayed)', r.status === 200 && r.j.replayed === true && r.j.status === 'published', `${r.status} ${r.j.replayed}`)

  // ───── T40 담당 아닌 수업만으로 된 교환(D4) → 202, 일부 승인, 거절 ─────
  const swap4 = [
    { op: 'reschedule', courseId: 'sciA', occurrenceKey: `sr_sciA_tue4@${D4}`, target: { date: D4, period: 3 } },
    { op: 'reschedule', courseId: 'engB', occurrenceKey: `sr_engB_tue3@${D4}`, target: { date: D4, period: 4 } },
  ]
  let rv = await revisionNow()
  r = await sc('tz@e2e.kr', { action: 'publish', mutationId: 'm-t40-zswap-0001', expectedRevision: rv, items: swap4 })
  const zCs = r.j.changeSetId
  check('T40', '두 수업 모두 담당 아닌 교사 Z의 교환 → 202, X·Y 모두 승인 필요', r.status === 202 && JSON.stringify(r.j.approvals) === '{"tx":false,"ty":false}', `${r.status} ${JSON.stringify(r.j.approvals)}`)
  r = await sc('tx@e2e.kr', { action: 'approve', changeSetId: zCs })
  check('T40', 'X만 승인 → 아직 대기(발행 안 됨)', r.status === 202 && r.j.status === 'pending-approval' && r.j.approvals?.tx === true && (await revisionNow()) === rv, `${r.status} ${JSON.stringify(r.j.approvals)}`)
  r = await sc('ty@e2e.kr', { action: 'reject', changeSetId: zCs, reason: '수업 진도' })
  check('T40', 'Y 거절 → rejected, 시간표 그대로', r.status === 200 && r.j.status === 'rejected' && (await revisionNow()) === rv && lessonOf(await dayView('a@e2e.kr', D4), 'engB')[0]?.period === 3, `${r.status} ${r.j.status}`)
  r = await sc('tx@e2e.kr', { action: 'approve', changeSetId: zCs })
  check('T40', '거절된 요청 승인 → 409 not-pending', r.status === 409 && r.j.code === 'not-pending', `${r.status} ${r.j.code}`)
  r = await sc('tx@e2e.kr', { action: 'publish', mutationId: 'm-t40-xengb-0001', expectedRevision: rv, items: [{ op: 'cancel', courseId: 'engB', occurrenceKey: `sr_engB_tue3@${D4}` }] })
  check('T40', '담당 아닌 수업(영어 B) 단독 취소도 바로 발행되지 않고 202', r.status === 202 && (await revisionNow()) === rv, `${r.status}`)
  r = await sc('tx@e2e.kr', { action: 'reject', changeSetId: r.j.changeSetId })
  check('T40', '요청한 교사 본인 철회', r.status === 200 && r.j.status === 'rejected', `${r.status} ${r.j.status}`)
  r = await sc('tx@e2e.kr', { action: 'list', courseId: 'engB' })
  check('T40', '담당 아닌 수업의 변경 이력 list → 403 not-course-teacher', r.status === 403 && r.j.code === 'not-course-teacher', `${r.status} ${r.j.code}`)

  // ───── T18 날짜 간 이동(D3 화3 → 목 5교시) ─────
  const thu = addDays(D3, 2)
  rv = await revisionNow()
  r = await sc('ty@e2e.kr', { action: 'publish', mutationId: 'm-t18-move-00001', expectedRevision: rv, items: [{ op: 'reschedule', courseId: 'engB', occurrenceKey: `sr_engB_tue3@${D3}`, target: { date: thu, period: 5 } }] })
  check('T18', '다른 날짜로 이동 publish 200', r.status === 200, `${r.status} ${r.j.code || ''}`)
  const a3 = await dayView('a@e2e.kr', D3)
  const a3t = await dayView('a@e2e.kr', thu)
  check('T18', '원래 날짜: 정상 수업에서 빠지고 "옮겨 감" 안내', !lessonOf(a3, 'engB').length && a3.notices.some((n) => n.kind === 'moved-out' && n.courseId === 'engB' && n.movedTo?.date === thu), JSON.stringify(a3.notices))
  check('T18', '새 날짜: 한 번만 표시, date 변경 표시', lessonOf(a3t, 'engB').length === 1 && lessonOf(a3t, 'engB')[0].period === 5 && lessonOf(a3t, 'engB')[0].change?.fields?.includes('date'), periods(a3t))
  check('T18', '수강하지 않는 학생 C의 목요일엔 없음', !lessonOf(await dayView('c@e2e.kr', thu), 'engB').length)

  // ───── T26 교사 충돌(D3 생활과 과학 A 4→2, 같은 교사 X의 생활과 과학 C 2교시) ─────
  rv = await revisionNow()
  const t26 = { action: 'publish', mutationId: 'm-t26-conf-00001', expectedRevision: rv, items: [{ op: 'reschedule', courseId: 'sciA', occurrenceKey: `sr_sciA_tue4@${D3}`, target: { date: D3, period: 2 } }] }
  r = await sc('tx@e2e.kr', t26)
  check('T26', '같은 교사 같은 시간 → 409 conflicts(teacher, 교사 이름으로 설명)', r.status === 409 && r.j.code === 'conflicts' && r.j.conflicts.some((c) => c.kind === 'teacher' && c.detail === '김과학'), `${r.status} ${JSON.stringify(r.j.conflicts || r.j).slice(0, 300)}`)
  check('T46', '충돌 응답에 교사 계정 id(uid:) 없음', !JSON.stringify(r.j).includes('uid:'))
  check('T26', '충돌 409는 아무것도 쓰지 않음', (await revisionNow()) === rv && !(await db.doc('schools/S1/changeSets/cs_m-t26-conf-00001').get()).exists)
  r = await sc('tx@e2e.kr', { ...t26, acknowledgeConflicts: true })
  check('T26', 'acknowledgeConflicts → 발행, 충돌을 묶음에 기록', r.status === 200 && r.j.conflicts.length > 0 && r.j.conflictsAcknowledged === true, `${r.status} ${r.j.code || ''}`)
  r = await sc('tx@e2e.kr', { action: 'preview', items: [{ op: 'reschedule', courseId: 'sciA', occurrenceKey: `sr_sciA_tue4@${D5}`, target: { date: D5, start: '10:30', end: '11:00' } }] })
  check('T25', '교시 번호가 달라도(4교시 vs 3교시) 실제 시각이 겹치면 학생 충돌', r.status === 200 && r.j.conflicts.some((c) => c.kind === 'students' && [c.aPeriod, c.bPeriod].sort().join() === '3,4'), JSON.stringify(r.j.conflicts))

  // ───── T19 교실·교사 변경(D4) ─────
  rv = await revisionNow()
  r = await sc('ty@e2e.kr', { action: 'publish', mutationId: 'm-t19-room-00001', expectedRevision: rv, items: [{ op: 'reschedule', courseId: 'engB', occurrenceKey: `sr_engB_tue3@${D4}`, target: { roomName: '시청각실', teacherUids: ['tz'] } }] })
  check('T19', '교실·대체 교사 변경 publish 200', r.status === 200, `${r.status} ${r.j.code || ''}`)
  const a4 = lessonOf(await dayView('a@e2e.kr', D4), 'engB')[0]
  check('T19', '교실·교사 필드만 변경(room·teacher), 교시 그대로, 교사 이름은 계정에서',
    a4?.period === 3 && a4?.roomName === '시청각실' && JSON.stringify(a4?.teacherNames) === '["박수학"]' && JSON.stringify(a4?.change?.fields) === '["room","teacher"]', JSON.stringify(a4))
  check('T19', '수강생 집단 유지(학생 C에게 영어 B 없음)', !lessonOf(await dayView('c@e2e.kr', D4), 'engB').length)
  r = await sc('ty@e2e.kr', { action: 'preview', items: [{ op: 'reschedule', courseId: 'engB', occurrenceKey: `sr_engB_tue3@${D4}`, target: { teacherUids: ['tw'] } }] })
  check('T19', '다른 학교 교사 계정으로 교사 변경 → 400 invalid-teacher', r.status === 400 && r.j.code === 'invalid-teacher', `${r.status} ${r.j.code}`)
  r = await sc('ty@e2e.kr', { action: 'preview', items: [{ op: 'reschedule', courseId: 'engB', occurrenceKey: `sr_engB_tue3@${D4}`, target: { period: 2 } }] })
  check('T19', '이어서 교시만 바꿔도 앞서 바꾼 교실·교사 유지(조용히 되돌리지 않음)', r.status === 200 && r.j.changes[0].after.roomName === '시청각실' && JSON.stringify(r.j.changes[0].after.teacherUids) === '["tz"]', JSON.stringify(r.j.changes?.[0]?.after))

  // ───── T20 취소·보강(D5) ─────
  const wed5 = addDays(D5, 1)
  rv = await revisionNow()
  r = await sc('ty@e2e.kr', { action: 'publish', mutationId: 'm-t20-cancel-001', expectedRevision: rv, items: [{ op: 'cancel', courseId: 'engB', occurrenceKey: `sr_engB_tue3@${D5}` }, { op: 'makeup', courseId: 'engB', target: { date: wed5, period: 6 } }] })
  check('T20', '취소 + 보강 한 묶음 publish 200', r.status === 200, `${r.status} ${r.j.code || ''}`)
  const a5 = await dayView('a@e2e.kr', D5)
  const a5w = await dayView('a@e2e.kr', wed5)
  check('T20', '취소: 정상 수업에서 빠지고 취소 안내로 구분', !lessonOf(a5, 'engB').length && a5.notices.some((n) => n.kind === 'cancelled' && n.courseId === 'engB'), JSON.stringify(a5.notices))
  check('T20', '보강: 수요일 6교시 makeup으로 표시(기본 교실)', lessonOf(a5w, 'engB')[0]?.period === 6 && lessonOf(a5w, 'engB')[0]?.change?.kind === 'makeup' && lessonOf(a5w, 'engB')[0]?.roomName === '3학년 5반 교실', periods(a5w))
  check('T20', '보강은 수강하지 않는 학생 C에게 없음', !lessonOf(await dayView('c@e2e.kr', wed5), 'engB').length)
  const ovCancel = (await db.doc('schools/S1/overrides/ov_m-t20-cancel-001_0').get()).data() || {}
  check('T20', '묶음의 각 변경 dates = 묶음 전체 날짜(하루만 조회해도 묶음 전체가 함께 내려감)', JSON.stringify(ovCancel.dates) === JSON.stringify([D5, wed5]), JSON.stringify(ovCancel.dates))
  const mkKey = 'mk:m-t20-cancel-001-1'
  rv = await revisionNow()
  r = await sc('ty@e2e.kr', { action: 'publish', mutationId: 'm-t20-mkcancel-1', expectedRevision: rv, items: [{ op: 'cancel', courseId: 'engB', occurrenceKey: mkKey }] })
  check('T20', '보강 차시 취소', r.status === 200 && !lessonOf(await dayView('a@e2e.kr', wed5), 'engB').length, `${r.status} ${r.j.code || ''}`)
  rv = await revisionNow()
  r = await sc('ty@e2e.kr', { action: 'publish', mutationId: 'm-t20-mkrestore1', expectedRevision: rv, items: [{ op: 'restore', courseId: 'engB', occurrenceKey: mkKey }] })
  check('T23', '보강 차시 복원 → 처음 보강 상태(수 6교시)', r.status === 200 && lessonOf(await dayView('a@e2e.kr', wed5), 'engB')[0]?.period === 6, `${r.status} ${r.j.code || ''}`)

  // ───── T22 준비: 기본 변경 전에 D7 날짜 변경 ─────
  rv = await revisionNow()
  r = await sc('ty@e2e.kr', { action: 'publish', mutationId: 'm-t22-pre-000001', expectedRevision: rv, items: [{ op: 'reschedule', courseId: 'engB', occurrenceKey: `sr_engB_tue3@${D7}`, target: { roomName: '어학실' } }] })
  check('T22', '적용일 뒤 날짜(D7)의 날짜 변경 발행', r.status === 200, `${r.status} ${r.j.code || ''}`)

  // ───── T21 기본 시간표 변경: D6부터 영어 B 수요일 2교시 ─────
  const baseItem = { op: 'base', courseId: 'engB', seriesId: 'sr_engB_tue3', effectiveFrom: D6, weekday: 3, period: 2 }
  r = await sc('ty@e2e.kr', { action: 'preview', scope: 'base', items: [baseItem] })
  check('T22', 'preview: 새 기본값과 맞지 않게 될 기존 날짜 변경(D7)을 orphan으로 보고', r.status === 200 && r.j.orphans.length === 1 && r.j.orphans[0].occurrenceKey === `sr_engB_tue3@${D7}`, JSON.stringify(r.j.orphans || r.j))
  check('T21', 'preview: 기본 변경 전후(화3 → 수2, date·time)', r.status === 200 && r.j.changes[0].kind === 'base' && r.j.changes[0].before.period === 3 && r.j.changes[0].after.period === 2 && r.j.changes[0].fields.includes('date'), JSON.stringify(r.j.changes))
  r = await sc('ty@e2e.kr', { action: 'preview', scope: 'base', items: [{ ...baseItem, effectiveFrom: addDays(TODAY, -1) }] })
  check('T21', '과거 적용일 → 400 past-effective-date(과거 시간표 보존)', r.status === 400 && r.j.code === 'past-effective-date', `${r.status} ${r.j.code}`)
  rv = await revisionNow()
  r = await sc('ty@e2e.kr', { action: 'publish', scope: 'base', mutationId: 'm-t21-base-00001', expectedRevision: rv, items: [baseItem] })
  const oldSeries = (await db.doc('schools/S1/series/sr_engB_tue3').get()).data() || {}
  const newSeries = (await db.doc('schools/S1/series/sr_m-t21-base-00001_0').get()).data() || {}
  check('T21', 'publish 200: 기존 반복 차시 validTo=적용일, 새 반복 차시 validFrom=적용일(수2)',
    r.status === 200 && oldSeries.validTo === D6 && newSeries.validFrom === D6 && newSeries.weekday === 3 && newSeries.period === 2, `${r.status} ${JSON.stringify({ o: oldSeries.validTo, n: [newSeries.validFrom, newSeries.weekday, newSeries.period] })}`)
  const a4b = lessonOf(await dayView('a@e2e.kr', D4), 'engB')[0]
  check('T21', '적용일 전(D4): 당시 기본(화3) + 그날 교실 변경 그대로', a4b?.period === 3 && a4b?.roomName === '시청각실', JSON.stringify(a4b))
  const a6 = await dayView('a@e2e.kr', D6)
  const a6w = await dayView('a@e2e.kr', addDays(D6, 1))
  check('T21', '적용일 이후: 화요일엔 없고 수요일 2교시(새 기본값이라 변경 배지 없음)', !lessonOf(a6, 'engB').length && lessonOf(a6w, 'engB')[0]?.period === 2 && !lessonOf(a6w, 'engB')[0]?.change, `${periods(a6)} / ${periods(a6w)}`)
  r = await sc('ty@e2e.kr', { action: 'orphans', courseId: 'engB' })
  check('T22', 'orphans: D7 변경이 검토 대상으로 남음(조용히 버리지 않음)', r.status === 200 && r.j.orphans.length === 1 && r.j.orphans[0].occurrenceKey === `sr_engB_tue3@${D7}`, JSON.stringify(r.j.orphans || r.j))
  const a7 = await dayView('a@e2e.kr', D7)
  check('T22', '학생 엔진에도 orphanOverrides로 전달되고 수업으로는 표시되지 않음', a7.orphanOverrides.length === 1 && !lessonOf(a7, 'engB').length, JSON.stringify({ o: a7.orphanOverrides.length, l: periods(a7) }))
  const nBase = await notif('stuB', 'sched_cs_m-t21-base-00001')
  check('T38', '기본 변경 알림(…부터) — 수강생에게만', nBase.exists && /부터\)$/.test(nBase.get('body')) && !(await notif('stuC', 'sched_cs_m-t21-base-00001')).exists, nBase.exists ? nBase.get('body') : 'none')

  // ───── T23 원복(D1 영어 B) — 이력 유지 ─────
  rv = await revisionNow()
  r = await sc('ty@e2e.kr', { action: 'publish', mutationId: 'm-t23-restore-01', expectedRevision: rv, items: [{ op: 'restore', courseId: 'engB', occurrenceKey: `sr_engB_tue3@${D1}` }] })
  check('T23', 'restore publish 200', r.status === 200, `${r.status} ${r.j.code || ''}`)
  const a1r = lessonOf(await dayView('a@e2e.kr', D1), 'engB')[0]
  check('T23', '원래 일정(3교시)으로 표시, 변경 강조 없음', a1r?.period === 3 && !a1r?.change, JSON.stringify(a1r))
  const hist = await db.collection('schools/S1/overrides').where('occurrenceKey', '==', `sr_engB_tue3@${D1}`).get()
  check('T23', '변경 이력 2건(이동 + 복원) 유지 — 삭제하지 않음', hist.size === 2 && hist.docs.map((d) => d.get('kind')).sort().join() === 'reschedule,restore', `${hist.size}건`)
  r = await sc('ty@e2e.kr', { action: 'preview', items: [{ op: 'restore', courseId: 'engB', occurrenceKey: `sr_engB_tue3@${D1}` }] })
  check('T23', '이미 원래 일정이면 → 400 nothing-to-restore', r.status === 400 && r.j.code === 'nothing-to-restore', `${r.status} ${r.j.code}`)
  rv = await revisionNow()
  r = await sc('ty@e2e.kr', { action: 'publish', mutationId: 'm-t23-orphan-001', expectedRevision: rv, items: [{ op: 'restore', courseId: 'engB', occurrenceKey: `sr_engB_tue3@${D7}` }] })
  const orphansAfter = await sc('ty@e2e.kr', { action: 'orphans', courseId: 'engB' })
  check('T22', '검토 대상(orphan)을 복원으로 정리하면 목록에서 빠짐', r.status === 200 && orphansAfter.status === 200 && orphansAfter.j.orphans.length === 0, `${r.status} ${JSON.stringify(orphansAfter.j.orphans)}`)

  // ───── T27/T28 동시 요청 ─────
  rv = await revisionNow()
  const thu1 = addDays(D1, 2)
  const [p1, p2] = await Promise.all([
    sc('ty@e2e.kr', { action: 'publish', mutationId: 'm-race-a-000001', expectedRevision: rv, items: [{ op: 'makeup', courseId: 'engB', target: { date: thu1, period: 7 } }] }),
    sc('ty@e2e.kr', { action: 'publish', mutationId: 'm-race-b-000001', expectedRevision: rv, items: [{ op: 'makeup', courseId: 'engB', target: { date: thu1, period: 8 } }] }),
  ])
  const sts = [p1.status, p2.status].sort().join()
  check('T27', '같은 버전 기준 동시 발행 2건: 하나만 200, 다른 하나 409 stale-revision', sts === '200,409' && (await revisionNow()) === rv + 1, sts)
  rv = await revisionNow()
  const same = { action: 'publish', mutationId: 'm-race-same-0001', expectedRevision: rv, items: [{ op: 'makeup', courseId: 'engB', target: { date: thu1, period: 9 } }] }
  const [q1, q2] = await Promise.all([sc('ty@e2e.kr', same), sc('ty@e2e.kr', same)])
  const nSame = (await notif('stuB', 'sched_cs_m-race-same-0001')).exists
  const allB = (await db.collection('users/stuB/notifications').get()).docs.filter((d) => d.id === 'sched_cs_m-race-same-0001').length
  check('T28', '같은 mutationId 동시 2회: 둘 다 200 같은 결과, 버전 +1, 알림 1건',
    q1.status === 200 && q2.status === 200 && q1.j.changeSetId === q2.j.changeSetId && q1.j.revision === q2.j.revision && (await revisionNow()) === rv + 1 && nSame && allB === 1,
    `${q1.status},${q2.status} rev=${q1.j.revision},${q2.j.revision}`)

  // ───── 검토 [3][7] 승인자 두 명이 동시에 승인 → 대기에 멈추지 않고 한 번만 발행 ─────
  rv = await revisionNow()
  const dual = [
    { op: 'cancel', courseId: 'sciA', occurrenceKey: `sr_sciA_tue4@${D8}` },
    { op: 'cancel', courseId: 'engA', occurrenceKey: `sr_engA_tue1@${D8}` },
  ]
  r = await sc('tz@e2e.kr', { action: 'publish', mutationId: 'm-dual-approve-01', expectedRevision: rv, items: dual, reason: '동시 승인' })
  const dualCs = r.j.changeSetId
  check('R3', '교사 Z가 X·Y 수업 취소 요청 → 202, 승인자 X·Y', r.status === 202 && JSON.stringify(r.j.approvals) === '{"tx":false,"ty":false}', `${r.status} ${JSON.stringify(r.j.approvals)}`)
  const [ax, ay] = await Promise.all([sc('tx@e2e.kr', { action: 'approve', changeSetId: dualCs }), sc('ty@e2e.kr', { action: 'approve', changeSetId: dualCs })])
  const dualDoc = (await db.doc(`schools/S1/changeSets/${dualCs}`).get()).data() || {}
  check('R3', 'X·Y 동시 승인 → 최종 published(모두 승인), 버전 +1 한 번, 한 응답은 200 발행·다른 응답은 2xx',
    dualDoc.status === 'published' && dualDoc.approvals?.tx === true && dualDoc.approvals?.ty === true && dualDoc.revision === rv + 1 && (await revisionNow()) === rv + 1 &&
      [ax, ay].some((x) => x.status === 200 && x.j.status === 'published') && [ax, ay].every((x) => x.status === 200 || x.status === 202),
    `${ax.status}/${ax.j.status || ax.j.code} ${ay.status}/${ay.j.status || ay.j.code} → ${dualDoc.status} ${JSON.stringify(dualDoc.approvals)} rev=${dualDoc.revision}`)
  const c8 = await dayView('c@e2e.kr', D8)
  check('R3', '학생 C: 그날 생활과 과학 A·영어 A 모두 취소 안내, 알림 1건',
    !lessonOf(c8, 'sciA').length && !lessonOf(c8, 'engA').length && c8.notices.filter((n) => n.kind === 'cancelled').length === 2 && (await notif('stuC', 'sched_' + dualCs)).exists,
    `${periods(c8)} ${JSON.stringify(c8.notices.map((n) => n.kind))}`)

  // ───── 검토 [5] 요청자의 '충돌 확인'은 요청 때 저장한 충돌에만 — 승인 시점에 새로 생긴 충돌은 승인자 확인 필요 ─────
  const ackReq = (date, mutationId, expectedRevision) => ({
    action: 'publish', mutationId, expectedRevision, acknowledgeConflicts: true,
    items: [{ op: 'reschedule', courseId: 'sciA', occurrenceKey: `sr_sciA_tue4@${date}`, target: { date, period: 2 } }],
  })
  r = await sc('tz@e2e.kr', ackReq(D9, 'm-ack-new-000001', await revisionNow()))
  const ackCs = r.j.changeSetId
  check('R5', '요청 때 교사 충돌(생활과 과학 C 2교시) 확인하고 요청 → 202, 충돌 1건 저장', r.status === 202 && r.j.conflicts?.length === 1 && r.j.conflicts[0].kind === 'teacher', `${r.status} ${JSON.stringify(r.j.conflicts || r.j).slice(0, 200)}`)
  r = await sc('ty@e2e.kr', { action: 'publish', mutationId: 'm-ack-other-0001', expectedRevision: await revisionNow(), items: [{ op: 'reschedule', courseId: 'engA', occurrenceKey: `sr_engA_tue1@${D9}`, target: { date: D9, period: 2 } }] })
  check('R5', '그 뒤 교사 Y가 영어 A를 같은 2교시로 옮겨 발행(그때는 충돌 없음)', r.status === 200, `${r.status} ${r.j.code || ''}`)
  rv = await revisionNow()
  r = await sc('tx@e2e.kr', { action: 'approve', changeSetId: ackCs })
  check('R5', '승인자 X가 확인 없이 승인 → 409 conflicts(새로 생긴 학생 충돌 포함), 발행 안 됨',
    r.status === 409 && r.j.code === 'conflicts' && r.j.conflicts.some((c) => c.kind === 'students' && [c.aCourseId, c.bCourseId].sort().join() === 'engA,sciA') &&
      (await db.doc(`schools/S1/changeSets/${ackCs}`).get()).get('status') === 'pending-approval' && (await revisionNow()) === rv,
    `${r.status} ${r.j.code} ${JSON.stringify((r.j.conflicts || []).map((c) => c.kind))}`)
  r = await sc('tx@e2e.kr', { action: 'approve', changeSetId: ackCs, acknowledgeConflicts: true })
  check('R5', '승인자가 충돌을 확인하고 승인 → 200 발행, 충돌 2건(교사·학생) 기록', r.status === 200 && r.j.status === 'published' && r.j.conflicts.length === 2 && r.j.conflictsAcknowledged === true, `${r.status} ${r.j.status || r.j.code} ${JSON.stringify((r.j.conflicts || []).map((c) => c.kind))}`)
  r = await sc('tz@e2e.kr', ackReq(D10, 'm-ack-same-00001', await revisionNow()))
  const sameCs = r.j.changeSetId
  check('R5', '(대조) 같은 요청을 다른 주에 → 202, 요청 때 충돌 1건', r.status === 202 && r.j.conflicts?.length === 1, `${r.status} ${JSON.stringify(r.j.conflicts || r.j).slice(0, 200)}`)
  r = await sc('tx@e2e.kr', { action: 'approve', changeSetId: sameCs })
  check('R5', '(대조) 요청 때와 같은 충돌만 있으면 요청자 확인으로 승인 → 200 발행', r.status === 200 && r.j.status === 'published', `${r.status} ${r.j.status || r.j.code}`)

  // ───── 이력·감사·민감정보 ─────
  r = await sc('ty@e2e.kr', { action: 'list', courseId: 'engB' })
  const rows = r.j.changeSets || []
  check('T23', 'list: 영어 B 변경 묶음 이력(최신순, 거절·복원 포함)', r.status === 200 && rows.length >= 10 && rows[0].createdAt >= rows[rows.length - 1].createdAt && rows.some((x) => x.status === 'rejected'), `${r.status} ${r.j.code || rows.length}`)
  r = await sc('ty@e2e.kr', { action: 'list', awaitingMe: true })
  check('T40', 'list awaitingMe: 처리된 요청은 대기 목록에 없음', r.status === 200 && (r.j.changeSets || []).every((x) => x.status === 'pending-approval'), `${r.status}`)
  const audits = await db.collection('schools/S1/audit').get()
  const auditText = JSON.stringify(audits.docs.map((d) => d.data()))
  check('T46', '감사 로그: 발행·요청·승인·거절 기록, 학생 이름·uid·토큰·이메일 없음',
    /schedule-change\.publish/.test(auditText) && /schedule-change\.request/.test(auditText) && /schedule-change\.approve/.test(auditText) && /schedule-change\.reject/.test(auditText) &&
      !new RegExp(STUDENT_NAMES.join('|') + '|stu[ABC]|eyJ|@e2e\\.kr').test(auditText),
    `audit ${audits.size}건`)
  const csText = JSON.stringify((await db.collection('schools/S1/changeSets').get()).docs.map((d) => d.data()))
  check('T46', '변경 묶음 문서에 학생 이름·uid 없음(영향 인원 수만)', !new RegExp(STUDENT_NAMES.join('|') + '|stu[ABC]').test(csText))
  const ov = (await db.doc('schools/S1/overrides/ov_m-t17-swap-00001_0').get()).data() || {}
  check('T17', '교환 묶음의 각 변경에 묶음 키(changeSetKeys) 기록 — 클라이언트 묶음 완전성 확인용',
    JSON.stringify(ov.changeSetKeys) === JSON.stringify([`engB|sr_engB_tue3@${D2}`, `sciA|sr_sciA_tue4@${D2}`]), JSON.stringify(ov.changeSetKeys))

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
