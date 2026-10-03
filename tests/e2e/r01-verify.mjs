// R01/T01 해결 검증: r01-repro.mjs와 같은 시드·시나리오를 새 구조(수업반·수강·개인 시간표)의 기대 동작으로 확인
// - 학급 시간표를 개인 시간표처럼 대신 보여 주지 않고, 연결된 수업이 생기면 개인 시간표에 나타나는지
// - 그룹 QR 학생: 마이그레이션(그룹 → 수업, 수강) → 담당 교사 차시 등록 → 개인 시간표 표시
// - 연결된 그룹 QR로 새로 들어온 학생: 바로 수강 생성 → 개인 시간표 표시
// - 담임 반 학생: 담임이 '학급 시간표 → 공통 수업' 확인 → 개인 시간표 표시
// 사용: node tests/e2e/r01-verify.mjs   (BASE 기본 http://127.0.0.1:3100, 에뮬레이터 8080/9099, NEIS mock 서버)
// 모든 데이터는 에뮬레이터의 테스트용 가상 데이터이며 실제 학생 정보가 아닙니다.
import { execFileSync } from 'child_process'
import path from 'path'
import { admin, wipe, createUsers, writeNeisFixture, clientSession, api, reporter, launchBrowser, newPage, uiLogin, sleep, Timestamp, BASE, ROOT } from './lib/env.mjs'
import { doc, updateDoc } from './lib/firestore-client.mjs'

const { OUT, check, note, finish } = reporter('r01-verify')
const FIXED = '2026-10-06T09:30:00+09:00' // 화요일 2교시 중
const DAY = '20261006'
const SCHOOL = { SD_SCHUL_CODE: 'S1', SCHUL_NM: '테스트고등학교', SCHUL_KND_SC_NM: '고등학교', ATPT_OFCDC_SC_CODE: 'B10' }
const SUBJECTS = ['문학', '수학Ⅰ', '영어Ⅰ', '물리학Ⅰ', '한국사', '체육']
const NO_TIMETABLE_MSG = /오늘 시간표 정보가 없어요/

function baseFixture(extra = {}) {
  return {
    schools: [SCHOOL],
    meals: [{ SD_SCHUL_CODE: 'S1', MLSV_YMD: DAY, MMEAL_SC_CODE: '2', MMEAL_SC_NM: '중식', DDISH_NM: '현미밥<br/>된장국<br/>불고기<br/>깍두기' }],
    timetables: {
      hisTimetable: SUBJECTS.map((s, i) => ({ SD_SCHUL_CODE: 'S1', GRADE: '3', CLASS_NM: '2', ALL_TI_YMD: DAY, PERIO: String(i + 1), ITRT_CNTNT: s })),
    },
    schedule: [],
    ...extra,
  }
}

const school = { schoolCode: 'S1', schoolName: '테스트고등학교', officeCode: 'B10' }
async function seed() {
  await wipe()
  await createUsers([
    { uid: 'hr', email: 'hr@e2e.kr', doc: { role: 'teacher', name: '김담임', displayName: '김담임', classId: 'S1_3_2', grade: 3, classNm: 2, ...school } },
    { uid: 'eng', email: 'eng@e2e.kr', doc: { role: 'teacher', name: '이영어', displayName: '이영어', teachingClassIds: ['S1_3_2_g_eng001'], ...school } },
    { uid: 'stuA', email: 'a@e2e.kr' }, // 가입만 한 새 학생(프로필 없음)
    { uid: 'stuB', email: 'b@e2e.kr' },
    { uid: 'stuD', email: 'd@e2e.kr' },
  ])
  const { db } = admin()
  await db.doc('classes/S1_3_2').set({ classId: 'S1_3_2', grade: 3, classNm: 2, teacherId: 'hr', teacherName: '김담임', createdAt: Timestamp.now(), ...school })
  await db.doc('classes/S1_3_2_g_eng001').set({ classId: 'S1_3_2_g_eng001', isGroup: true, grade: 3, classNm: 2, teacherId: 'eng', teacherName: '이영어', subjectName: '영어', createdAt: Timestamp.now(), ...school })
}

async function issueToken(classId) {
  const t = Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')
  await admin().db.doc(`classes/${classId}/joinTokens/${t}`).set({ createdAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 600000) })
  return t
}

async function asUser(email, fn) {
  const s = await clientSession(email)
  try {
    return await fn(s)
  } finally {
    await s.close()
  }
}
const joinViaQr = (email, classId, name, studentId) =>
  asUser(email, async (s) => api('/api/join', s.token, { classId, token: await issueToken(classId), name, studentId }))
const approve = (teacherEmail, studentUid) =>
  asUser(teacherEmail, (t) => updateDoc(doc(t.d, 'users', studentUid), { status: 'approved' }).then(() => 'allowed', (e) => e.code))
const courses = (email, body) => asUser(email, (s) => api('/api/courses', s.token, body))

async function studentToday(browser, email, shot, fixedTime = FIXED) {
  const errors = []
  const { ctx, page } = await newPage(browser, { fixedTime, errors, who: email })
  await uiLogin(page, email)
  if (!page.url().includes('/student/today')) await page.goto(BASE + '/student/today', { waitUntil: 'load' })
  const region = page.getByRole('region', { name: /내 시간표$/ }).first()
  await region.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
  await sleep(3500)
  const text = await page.locator('body').innerText()
  const ttText = (await region.innerText().catch(() => '')) || ''
  const refText = (await page.getByRole('list', { name: '학급 시간표(참고)' }).first().innerText().catch(() => '')) || ''
  await page.screenshot({ path: `${OUT}/${shot}.png`, fullPage: true })
  await ctx.close()
  return {
    text,
    ttText,
    refText,
    meal: text.includes('불고기'),
    refLabel: text.includes('학급 시간표(참고)'),
    refSubjects: SUBJECTS.filter((s) => refText.includes(s)),
    errors: errors.filter((e) => e.kind === 'pageerror'),
  }
}
const oneLine = (s) => s.replace(/\s+/g, ' ').slice(0, 220)

const browser = await launchBrowser()
try {
  // ── A: 담임 학급 QR로 가입 → 담임 승인 → 오늘 화면 (연결된 수업 없음, NEIS에 3-2 고교 시간표 있음)
  await seed()
  writeNeisFixture(baseFixture())
  let r = await joinViaQr('a@e2e.kr', 'S1_3_2', '학생A', '7')
  check('A.1', '학급 QR 가입 요청 성공', r.status === 200, JSON.stringify(r.j))
  check('A.2', '담임 승인', (await approve('hr@e2e.kr', 'stuA')) === 'allowed')
  let v = await studentToday(browser, 'a@e2e.kr', 'A-today')
  check('A.3', '급식 표시됨', v.meal)
  check('A.4/R05', '개인 시간표 카드는 연결된 수업이 없다고 정직하게 안내(학급 시간표로 대신 채우지 않음)', /아직 연결된 수업이 없어요/.test(v.ttText) && !SUBJECTS.some((s) => v.ttText.includes(s)), oneLine(v.ttText))
  check('A.5', '학급 시간표는 "학급 시간표(참고)" 라벨의 별도 영역으로 표시(NEIS 6교시)', v.refLabel && v.refSubjects.length === SUBJECTS.length, `참고 영역 과목 ${v.refSubjects.length}/6`)
  check('A.6', '"오늘 시간표 정보가 없어요"로 표시하지 않음', !NO_TIMETABLE_MSG.test(v.text))

  // ── A2: 담임이 '학급 시간표 → 우리 반 공통 수업' 확인 → 학생 개인 시간표에 공통 수업 표시
  await admin().db.doc('classes/S1_3_2/info/timetable').set({ mon: ['국어'], tue: ['문학', '수학Ⅰ', '영어Ⅰ'], wed: [], thu: [], fri: [] })
  r = await courses('hr@e2e.kr', { action: 'fromHomeroomTimetable', classId: 'S1_3_2' })
  check('A2.1', '담임 확인으로 공통 수업 생성', r.status === 200 && r.j.coursesCreated >= 3, JSON.stringify(r.j).slice(0, 200))
  v = await studentToday(browser, 'a@e2e.kr', 'A2-today')
  check('A2.2/T03', '공통 수업(문학·수학Ⅰ·영어Ⅰ)이 개인 시간표에 표시', ['문학', '수학Ⅰ', '영어Ⅰ'].every((s) => v.ttText.includes(s)), oneLine(v.ttText))

  // ── B: 담임이 앱에 없고 수업 그룹 QR로만 가입한 학생 (그룹에 연결된 수업 없음)
  r = await joinViaQr('b@e2e.kr', 'S1_3_2_g_eng001', '학생B', '9')
  check('B.1', '수업 그룹 QR 가입 요청 성공', r.status === 200, JSON.stringify(r.j))
  check('B.2', '그룹 교사 승인', (await approve('eng@e2e.kr', 'stuB')) === 'allowed')
  v = await studentToday(browser, 'b@e2e.kr', 'B-today')
  check('B.3', '급식 표시됨', v.meal)
  check('B.4/R15', '연결된 수업이 없음을 상태로 안내(소속 학급·수업 연결 안내), "시간표 없음"으로 위장하지 않음', /소속 학급|연결된 수업이 없어요/.test(v.ttText + v.text) && !NO_TIMETABLE_MSG.test(v.text), oneLine(v.ttText))
  check('B.5/R03', '수업 그룹을 소속 학급처럼 표시하지 않음(학급 시간표 참고도 없음)', !v.refLabel || v.refSubjects.length === 0)

  // ── B2: 데이터 전환(그룹 → 수업 + 수강) → 담당 교사가 차시 등록 → 그룹 QR 학생 개인 시간표에 영어 표시
  const migOut = execFileSync(process.execPath, [path.join(ROOT, 'scripts/migrate-timetable.mjs'), '--project', 'demo-classmate', '--apply'], { cwd: OUT, env: { ...process.env }, encoding: 'utf8' })
  const mig = JSON.parse(migOut.slice(migOut.indexOf('{')))
  check('B2.1/T41', '마이그레이션: 그룹 1 → 수업, 그룹 학생 수강 생성', mig.groupsToCourses === 1 && mig.enrollmentsToCreate >= 1, JSON.stringify({ g: mig.groupsToCourses, e: mig.enrollmentsToCreate }))
  v = await studentToday(browser, 'b@e2e.kr', 'B2-before-series')
  check('B2.2/R15', '차시 등록 전: "수업은 연결됐지만 선생님이 아직 시간표를 등록하지 않았어요"', /아직 시간표를 등록하지 않았어요/.test(v.ttText), oneLine(v.ttText))
  r = await courses('eng@e2e.kr', { action: 'addSeries', courseId: 'lg_S1_3_2_g_eng001', weekday: 2, period: 3, roomName: '영어전용실' })
  check('B2.3', '그룹 교사가 연결된 수업에 차시 등록(화 3교시, 영어전용실)', r.status === 200, JSON.stringify(r.j).slice(0, 200))
  v = await studentToday(browser, 'b@e2e.kr', 'B2-today')
  check('B2.4/R01', '그룹 QR 학생 개인 시간표에 영어 3교시·영어전용실 표시', /3교시/.test(v.ttText) && /영어/.test(v.ttText) && v.ttText.includes('영어전용실'), oneLine(v.ttText))

  // ── B3: 연결된 그룹 QR로 새로 들어온 학생 → 서버가 수강을 바로 만듦 → 개인 시간표 표시
  r = await joinViaQr('d@e2e.kr', 'S1_3_2_g_eng001', '학생D', '12')
  check('B3.1', '연결된 그룹 QR 가입: 연결된 수업 수강 생성', r.status === 200 && Array.isArray(r.j.courses) && r.j.courses.length === 1, JSON.stringify(r.j))
  check('B3.2', '그룹 교사 승인', (await approve('eng@e2e.kr', 'stuD')) === 'allowed')
  v = await studentToday(browser, 'd@e2e.kr', 'B3-today')
  check('B3.3/R01', '새 그룹 QR 학생 개인 시간표에 영어 표시', /영어/.test(v.ttText) && v.ttText.includes('영어전용실'), oneLine(v.ttText))

  // ── D: NEIS 학급 시간표 조회 장애 — 참고 보기는 오류로, 개인 시간표는 그대로
  writeNeisFixture(baseFixture({ fail: ['hisTimetable', 'elsTimetable', 'misTimetable', 'spsTimetable'] }))
  await admin().db.doc('classes/S1_3_2/info/timetable').delete()
  v = await studentToday(browser, 'b@e2e.kr', 'D-neis-fail', '2026-10-13T09:30:00+09:00')
  check('D.1', 'NEIS 장애여도 개인 시간표(영어)는 그대로 표시', /영어/.test(v.ttText), oneLine(v.ttText))
  check('D.2', '"오늘 시간표 정보가 없어요"로 위장하지 않음', !NO_TIMETABLE_MSG.test(v.text))

  // ── H2: 담임 반 신청(승인 전) 학생이 그룹 QR → 담임 반 신청 유지
  await createUsers([{ uid: 'stuC', email: 'c@e2e.kr' }])
  writeNeisFixture(baseFixture())
  r = await joinViaQr('c@e2e.kr', 'S1_3_2', '학생C', '11')
  check('H2.1', '담임 반 신청(승인 전)', r.status === 200 && r.j.status === 'pending', JSON.stringify(r.j))
  r = await joinViaQr('c@e2e.kr', 'S1_3_2_g_eng001', '학생C', '11')
  const profC = (await admin().db.doc('users/stuC').get()).data()
  check('H2.2', '그룹 QR을 찍어도 담임 반 신청(classId=S1_3_2)이 유지되고 수업은 추가됨', profC.classId === 'S1_3_2' && r.j.status === 'joined-extra-pending', `classId=${profC.classId} status=${r.j.status}`)

  const pageErrors = []
  note('pageerrors', `pageerror ${pageErrors.length}건`)
} catch (e) {
  check('X', '검증 스크립트 예외', false, e.stack)
} finally {
  await browser.close()
}
process.exit(finish() ? 1 : 0)
