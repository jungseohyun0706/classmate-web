// R01/T01 재현: "QR로 초대받은 학생 화면에 급식은 나오지만 시간표가 나오지 않는다"
// 사용: BASE=http://127.0.0.1:3200 node r01-repro.mjs <label>
// 서버는 NODE_OPTIONS="--require <repo>/tests/support/neis-mock.cjs" NEIS_MOCK_FILE=<repo>/tests/fixtures/neis-mock.runtime.json 로 띄움.
// 모든 데이터는 에뮬레이터의 테스트용 가상 데이터이며 실제 학생 정보가 아닙니다.
import { admin, wipe, createUsers, writeNeisFixture, clientSession, api, reporter, launchBrowser, newPage, uiLogin, sleep, Timestamp, BASE } from './lib/env.mjs'
import { doc, updateDoc } from './lib/firestore-client.mjs'

const LABEL = process.argv[2] || 'r01'
const { OUT, check, note, finish } = reporter(LABEL)
const FIXED = '2026-10-06T09:30:00+09:00' // 화요일 2교시 중
const DAY = '20261006'
const SCHOOL = { SD_SCHUL_CODE: 'S1', SCHUL_NM: '테스트고등학교', SCHUL_KND_SC_NM: '고등학교', ATPT_OFCDC_SC_CODE: 'B10' }
const SUBJECTS = ['문학', '수학Ⅰ', '영어Ⅰ', '물리학Ⅰ', '한국사', '체육']

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
  ])
  const { db } = admin()
  await db.doc('classes/S1_3_2').set({ classId: 'S1_3_2', grade: 3, classNm: 2, teacherId: 'hr', teacherName: '김담임', createdAt: Timestamp.now(), ...school })
  await db.doc('classes/S1_3_2_g_eng001').set({ classId: 'S1_3_2_g_eng001', isGroup: true, grade: 3, classNm: 2, teacherId: 'eng', teacherName: '이영어', subjectName: '영어', createdAt: Timestamp.now(), ...school })
}

async function issueToken(classId) {
  // 교사 QR 화면의 issueJoinToken과 같은 문서 구조(createdAt 서버 시각 + expiresAt)
  const t = Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')
  await admin().db.doc(`classes/${classId}/joinTokens/${t}`).set({ createdAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 600000) })
  return t
}

async function joinViaQr(email, classId, name, studentId) {
  const s = await clientSession(email)
  const r = await api('/api/join', s.token, { classId, token: await issueToken(classId), name, studentId })
  await s.close()
  return r
}

async function approve(teacherEmail, studentUid) {
  const t = await clientSession(teacherEmail)
  const w = await updateDoc(doc(t.d, 'users', studentUid), { status: 'approved' }).then(() => 'allowed', (e) => e.code)
  await t.close()
  return w
}

async function studentToday(browser, email, shot, fixedTime = FIXED) {
  const errors = []
  const { ctx, page } = await newPage(browser, { fixedTime, errors, who: email })
  const apiLog = []
  page.on('response', async (res) => {
    const u = res.url()
    if (u.includes('/api/timetable') || u.includes('/api/meals')) {
      apiLog.push({ url: u.replace(BASE, ''), status: res.status(), body: (await res.text().catch(() => '')).slice(0, 300) })
    }
  })
  await uiLogin(page, email)
  if (!page.url().includes('/student/today')) await page.goto(BASE + '/student/today', { waitUntil: 'load' })
  await sleep(4000)
  const text = await page.locator('body').innerText()
  await page.screenshot({ path: `${OUT}/${shot}.png`, fullPage: true })
  await ctx.close()
  return {
    meal: text.includes('불고기'),
    timetable: SUBJECTS.filter((s) => text.includes(s)),
    emptyMsg: /오늘 시간표 정보가 없어요|오늘은 쉬는 날이에요/.exec(text)?.[0] || '',
    errors,
    apiLog,
  }
}

const browser = await launchBrowser()
try {
  // ── 시나리오 A: 담임 학급 QR로 가입 → 담임 승인 → 오늘 화면 (NEIS에 3-2 고교 시간표 있음, 학급 시간표 문서 없음)
  await seed()
  writeNeisFixture(baseFixture())
  let r = await joinViaQr('a@e2e.kr', 'S1_3_2', '학생A', '7')
  check('A.1', '학급 QR 가입 요청 성공', r.status === 200, JSON.stringify(r.j))
  check('A.2', '담임 승인', (await approve('hr@e2e.kr', 'stuA')) === 'allowed')
  const prof = (await admin().db.doc('users/stuA').get()).data()
  note('A.profile', `users/stuA classId=${prof.classId} grade=${prof.grade} classNm=${prof.classNm} status=${prof.status} school=${prof.schoolCode}`)
  let v = await studentToday(browser, 'a@e2e.kr', 'A-today')
  note('A.api', JSON.stringify(v.apiLog))
  check('A.3', '급식 표시됨', v.meal)
  check('A.4', '시간표 표시됨(NEIS 고교 시간표 6교시)', v.timetable.length === SUBJECTS.length, `보인 과목 ${v.timetable.length}/6 ${v.emptyMsg}`)

  // ── 시나리오 B: 담임이 앱에 없고 교과 교사(영어)의 수업 그룹 QR로만 가입한 학생
  r = await joinViaQr('b@e2e.kr', 'S1_3_2_g_eng001', '학생B', '9')
  check('B.1', '수업 그룹 QR 가입 요청 성공', r.status === 200, JSON.stringify(r.j))
  check('B.2', '그룹 교사 승인', (await approve('eng@e2e.kr', 'stuB')) === 'allowed')
  const profB = (await admin().db.doc('users/stuB').get()).data()
  note('B.profile', `users/stuB classId=${profB.classId} grade=${profB.grade} classNm=${profB.classNm} status=${profB.status}`)
  v = await studentToday(browser, 'b@e2e.kr', 'B-today')
  note('B.api', JSON.stringify(v.apiLog))
  check('B.3', '급식 표시됨', v.meal)
  check('B.4', '그룹 QR 학생에게 시간표 표시됨', v.timetable.length > 0, `보인 과목 ${v.timetable.length} ${v.emptyMsg}`)

  // ── 시나리오 D: NEIS 시간표 조회 장애 — 오류가 '시간표 없음'으로 위장되는지
  //   (서버 메모리 캐시를 피하려고 아직 조회하지 않은 날짜 10/7 수요일로)
  writeNeisFixture(baseFixture({ fail: ['hisTimetable', 'elsTimetable', 'misTimetable', 'spsTimetable'] }))
  v = await studentToday(browser, 'a@e2e.kr', 'D-neis-fail', '2026-10-07T09:30:00+09:00')
  note('D.api', JSON.stringify(v.apiLog))
  check('D.1', 'NEIS 장애 시 "시간표 없음"이 아닌 오류로 안내', !/오늘 시간표 정보가 없어요/.test(v.emptyMsg) && v.timetable.length === 0, `표시: ${v.emptyMsg || '(문구 없음)'}`)

  // ── 시나리오 H2: 담임 반에 신청(승인 전)한 학생이 수업 그룹 QR을 찍으면 담임 반 신청이 사라지는지
  await createUsers([{ uid: 'stuC', email: 'c@e2e.kr' }])
  writeNeisFixture(baseFixture())
  r = await joinViaQr('c@e2e.kr', 'S1_3_2', '학생C', '11')
  check('H2.1', '담임 반 신청(승인 전)', r.status === 200 && r.j.status === 'pending', JSON.stringify(r.j))
  r = await joinViaQr('c@e2e.kr', 'S1_3_2_g_eng001', '학생C', '11')
  const profC = (await admin().db.doc('users/stuC').get()).data()
  note('H2.profile', `users/stuC classId=${profC.classId} grade=${profC.grade} classNm=${profC.classNm} status=${profC.status} extra=${JSON.stringify(profC.extraClassIds || [])}`)
  check('H2.2', '그룹 QR을 찍어도 담임 반 신청(classId=S1_3_2)이 유지됨', profC.classId === 'S1_3_2', `classId=${profC.classId}`)

  // ── 시나리오 G: 학급 문서 읽기 권한 실패(학급 문서 삭제 등)가 '시간표 없음'으로 숨겨지는지
  //   NEIS는 이 날짜 시간표 없음(INFO-200), 학급 시간표 문서는 있으나 학급 문서가 없어 규칙상 읽기 거부
  const { db } = admin()
  await db.doc('classes/S1_3_2/info/timetable').set({ mon: ['국어'], tue: ['국어', '수학', '영어', '과학', '사회', '체육'], wed: [], thu: [], fri: [] })
  const clsSnap = await db.doc('classes/S1_3_2').get()
  await db.doc('classes/S1_3_2').delete()
  writeNeisFixture(baseFixture({ timetables: {} }))
  v = await studentToday(browser, 'a@e2e.kr', 'G-permission', '2026-10-13T09:30:00+09:00')
  note('G.api', JSON.stringify(v.apiLog))
  check('G.1', '권한 오류 시 "시간표 없음"이 아닌 오류로 안내', !/오늘 시간표 정보가 없어요/.test(v.emptyMsg), `표시: ${v.emptyMsg || '(문구 없음)'}`)
  await db.doc('classes/S1_3_2').set(clsSnap.data())
} catch (e) {
  check('X', '재현 스크립트 예외', false, e.stack)
} finally {
  await browser.close()
}
process.exit(finish() ? 1 : 0)
