// U2 학생 '내 수업' 화면 E2E (그룹 'u2-student-courses')
// 대상: /student/courses (#invite 초대 코드 · #mine 참여 중인 수업 · #catalog 수업 담기(예전 '공식 수업 찾기') · #personal 직접 입력)
//       + 저장 결과가 /student/timetable?date=·홈 카드에 반영되는지
// 실행 전제: 실제 서버(BASE, 기본 http://127.0.0.1:3100, NEXT_PUBLIC_USE_EMULATORS=1 빌드)
//           + Firebase 에뮬레이터(Firestore 8080 — 규칙 firestore.rules, Auth 9099)
//           + NEIS mock(NODE_OPTIONS="--require <repo>/tests/support/neis-mock.cjs" NEIS_MOCK_FILE=<repo>/tests/fixtures/neis-mock.runtime.json)
// 사용: BASE=http://127.0.0.1:3100 node tests/e2e/u2-student-courses.e2e.mjs [label]
// 모든 데이터는 에뮬레이터의 테스트용 가상 데이터이며 실제 학생 정보가 아닙니다.
//
// 요구 식별자(지시서): R07 R08 R11 R15, T13 T14 T15 T24 T34
//  - 브라우저 시각은 2026-10-06(화) 09:30 KST로 고정. 서버는 실제 시각 — 수업 담기(학기)·담은 수강의 시작일(from)은 서버 날짜 기준.
//    서버 날짜가 10/6보다 늦으면 '신청 → 10/6 시간표' 확인은 건너뛰고 note로 남깁니다.
import { admin, wipe, createUsers, writeNeisFixture, clientSession, reporter, launchBrowser, newPage, uiLogin, sleep, Timestamp, BASE, PW } from './lib/env.mjs'
import { doc, setDoc, updateDoc, serverTimestamp } from './lib/firestore-client.mjs'

const LABEL = process.argv[2] || 'u2-student-courses'
const { OUT, check, note, finish } = reporter(LABEL)

const FIXED = '2026-10-06T09:30:00+09:00'
const TODAY = '20261006' // 화요일
const NEXT_TUE = '20261013'
const TERM = '2026-2'
const S1 = { schoolCode: 'S1', schoolName: '테스트고등학교', officeCode: 'B10' }

/** 서버 시각 기준 오늘(KST)과 학기 id(서버 defaultTermFor와 같은 규칙) — 수업 담기는 서버의 '지금 학기' 수업만 보여 줌 */
function serverToday() {
  const d = new Date(Date.now() + 9 * 3600 * 1000)
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}
function termIdNow() {
  const ymd = serverToday()
  const y = Number(ymd.slice(0, 4))
  const md = ymd.slice(4)
  if (md >= '0301' && md < '0816') return `${y}-1`
  return `${md < '0301' ? y - 1 : y}-2`
}
const CAT_TERM = termIdNow()

// uid·내부 id(화면·HTML에 보이면 안 됨) — 다른 글자와 우연히 겹치지 않게 드문 문자열
const U = { a: 'stuA2u7q', e: 'stuE2u4k', k: 'stuK2u9m', g: 'stuG2u3w', ns: 'stuN2u5x', np: 'stuP2u8z', ty: 'tchY2u6r' }
const C = {
  lit: 'e2eU2Lit',
  engB: 'e2eU2EngB',
  engC: 'e2eU2EngC',
  mathC: 'e2eU2MathC',
  histE: 'e2eU2HistE',
  sciA: 'e2eU2SciA',
  physD: 'e2eU2PhysD',
  hidden: 'e2eU2Hidden',
}
const SER = {
  litTue1: 'e2eU2SerLitTue1',
  engBTue3: 'e2eU2SerEngBTue3',
  engCTue3: 'e2eU2SerEngCTue3',
  mathCMon2: 'e2eU2SerMathCMon2',
  histEMon5: 'e2eU2SerHistEMon5',
  sciATue4: 'e2eU2SerSciATue4',
  sciAThu2: 'e2eU2SerSciAThu2',
  physDTue5: 'e2eU2SerPhysDTue5',
}
const INTERNAL_IDS = [...Object.values(U), ...Object.values(C), ...Object.values(SER), 'S1_3_4', 'S1_3_5', 'cs_e2e_u2']
const OTHER_STUDENT_NAMES = /이학생|박학생|최학생|정학생|한학생/

function neisFixture() {
  return {
    schools: [{ SD_SCHUL_CODE: 'S1', SCHUL_NM: '테스트고등학교', SCHUL_KND_SC_NM: '고등학교', ATPT_OFCDC_SC_CODE: 'B10' }],
    meals: [{ SD_SCHUL_CODE: 'S1', MLSV_YMD: TODAY, MMEAL_SC_CODE: '2', MMEAL_SC_NM: '중식', DDISH_NM: '현미밥<br/>된장국' }],
    timetables: {},
    schedule: [],
  }
}

async function seed() {
  await wipe()
  writeNeisFixture(neisFixture())
  const St = (name, classId, grade, classNm, extra = {}) => ({ role: 'student', status: 'approved', name, displayName: name, classId, grade, classNm, ...S1, ...extra })
  await createUsers([
    { uid: U.a, email: 'a@u2.e2e.kr', doc: St('김학생', 'S1_3_4', 3, 4) }, // T14·T24: 공통 문학 + 영어 C(예전 그룹) + 한국사 E(10/12부터) + 수학 C(종료)
    { uid: U.e, email: 'e@u2.e2e.kr', doc: St('이학생', 'S1_3_5', 3, 5) }, // T15: 영어 B 활성 수강
    { uid: U.k, email: 'k@u2.e2e.kr', doc: St('박학생', 'S1_3_5', 3, 5) }, // T13: 수강 없음 → 수업 담기에서 담기
    { uid: U.g, email: 'g@u2.e2e.kr', doc: St('최학생', 'S1_3_5_g_engb', null, null) }, // 그룹이 소속처럼 저장된 예전 학생
    { uid: U.ns, email: 'ns@u2.e2e.kr', doc: { role: 'student', status: 'approved', name: '정학생', displayName: '정학생', classId: null } }, // 학교 없음
    { uid: U.np, email: 'np@u2.e2e.kr' }, // 가입 미완료(Auth 계정만)
    { uid: U.ty, email: 'ty@u2.e2e.kr', doc: { role: 'teacher', name: '이영어', displayName: '이영어', ...S1 } },
  ])
  const { db } = admin()
  const now = Timestamp.now()
  await db.doc('schools/S1').set({ name: '테스트고등학교', kind: '고등학교', officeCode: 'B10', timezone: 'Asia/Seoul', scheduleRevision: 1, updatedAt: now })
  await db.doc('classes/S1_3_4').set({ classId: 'S1_3_4', grade: 3, classNm: 4, teacherId: 'hr4x', teacherName: '김담임', createdAt: now, ...S1 })
  await db.doc('classes/S1_3_5').set({ classId: 'S1_3_5', grade: 3, classNm: 5, teacherId: 'hr5x', teacherName: '박담임', createdAt: now, ...S1 })
  await db.doc('classes/S1_3_5_g_engb').set({ classId: 'S1_3_5_g_engb', isGroup: true, grade: 3, classNm: 5, teacherId: U.ty, subjectName: '영어', createdAt: now, ...S1 })

  const course = (id, title, subject, section, teacher, room, extra = {}) =>
    db.doc(`schools/S1/courses/${id}`).set({
      schoolCode: 'S1',
      termId: TERM,
      title,
      subject,
      section: section || null,
      teacherUids: [U.ty],
      teacherNames: [teacher],
      status: 'active',
      endedOn: null,
      commonForHomerooms: [],
      defaultRoomName: room,
      invitePolicy: 'approval',
      catalogVisible: false,
      source: 'manual',
      createdBy: U.ty,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      ...extra,
    })
  await course(C.lit, '문학', '문학', null, '한국어', '3학년 4반 교실', { commonForHomerooms: ['S1_3_4'], source: 'homeroom-common' })
  await course(C.engB, '영어 B', '영어', 'B', '이영어', '3학년 5반 교실', { legacyGroupId: 'S1_3_5_g_engb' })
  await course(C.engC, '영어 C', '영어', 'C', '정영어', '영어전용실', { source: 'legacy-group' })
  await course(C.mathC, '수학 C', '수학', 'C', '오수학', '수학실')
  await course(C.histE, '한국사 E', '한국사', 'E', '서역사', '역사실')
  // 수업 담기에 보이는 수업(서버 '지금 학기') — 바로 담기 / 선생님 승인 필요 / 비공개
  await course(C.sciA, '생활과 과학 A', '생활과 과학', 'A', '최과학', '과학실', { termId: CAT_TERM, invitePolicy: 'auto', catalogVisible: true })
  await course(C.physD, '물리 D', '물리학', 'D', '강물리', '물리실', { termId: CAT_TERM, invitePolicy: 'approval', catalogVisible: true })
  await course(C.hidden, '비공개 동아리', '동아리', null, '한비밀', '동아리실', { termId: CAT_TERM, invitePolicy: 'auto', catalogVisible: false })

  const series = (id, courseId, weekday, period, roomName, teacher) =>
    db.doc(`schools/S1/series/${id}`).set({
      courseId,
      termId: courseId === C.sciA || courseId === C.physD ? CAT_TERM : TERM,
      weekday,
      period,
      start: null,
      end: null,
      roomName,
      teacherNames: [teacher],
      teacherUids: [],
      validFrom: '20260816',
      validTo: null,
      status: 'active',
      createdBy: 'seed',
      createdAt: now,
    })
  await series(SER.litTue1, C.lit, 2, 1, '3학년 4반 교실', '한국어')
  await series(SER.engBTue3, C.engB, 2, 3, '3학년 5반 교실', '이영어')
  await series(SER.engCTue3, C.engC, 2, 3, '영어전용실', '정영어')
  await series(SER.mathCMon2, C.mathC, 1, 2, '수학실', '오수학')
  await series(SER.histEMon5, C.histE, 1, 5, '역사실', '서역사')
  await series(SER.sciATue4, C.sciA, 2, 4, '과학실', '최과학')
  await series(SER.sciAThu2, C.sciA, 4, 2, '과학실', '최과학')
  await series(SER.physDTue5, C.physD, 2, 5, '물리실', '강물리')

  const enroll = (courseId, uid, status, source, extra = {}) =>
    db.doc(`schools/S1/enrollments/${courseId}__${uid}`).set({ courseId, uid, schoolCode: 'S1', termId: TERM, status, from: null, to: null, source, createdAt: now, updatedAt: now, ...extra })
  await enroll(C.engC, U.a, 'active', 'legacy-group')
  await enroll(C.histE, U.a, 'active', 'invite', { from: '20261012' }) // T24: 시작 예정
  await enroll(C.mathC, U.a, 'ended', 'roster', { from: '20260901', to: '20260915', decidedBy: U.ty }) // T24: 종료
  await enroll(C.engB, U.e, 'active', 'invite')
  await enroll(C.engB, U.g, 'active', 'invite', { via: 'group-qr', legacyGroupId: 'S1_3_5_g_engb' })
}

/** 영어 B 화 3교시 → 화 2교시(이 날짜만) 발행 — 서버 overrideFromDoc 필드 + schools/S1.scheduleRevision +1 */
async function publishEngBMove() {
  const { db } = admin()
  const cur = Number((await db.doc('schools/S1').get()).get('scheduleRevision') || 0)
  const rev = cur + 1
  const occ = `${SER.engBTue3}@${TODAY}`
  await db.doc('schools/S1/overrides/e2eU2OvEngB1006').set({
    courseId: C.engB,
    occurrenceKey: occ,
    changeSetId: 'cs_e2e_u2_1',
    changeSetKeys: [`${C.engB}|${occ}`],
    kind: 'reschedule',
    seriesId: SER.engBTue3,
    originalDate: TODAY,
    target: { date: TODAY, period: 2 },
    dates: [TODAY],
    reason: '영어 선생님 연수로 교시 이동',
    revision: rev,
    status: 'published',
    publishedAt: Timestamp.now(),
    createdBy: U.ty,
  })
  await db.doc('schools/S1').set({ scheduleRevision: rev, updatedAt: Timestamp.now() }, { merge: true })
  return rev
}

// ───────────────────────── 화면 도우미 ─────────────────────────

async function openAs(browser, email, path = '/student/courses', setup) {
  const errors = []
  const { ctx, page } = await newPage(browser, { fixedTime: FIXED, errors, who: email })
  if (setup) await setup(page, ctx)
  await uiLogin(page, email)
  if (!page.url().endsWith(path)) await page.goto(BASE + path, { waitUntil: 'load' })
  return { ctx, page, errors }
}

/** 프로필 없는 계정 등 역할별 화면으로 가지 않는 계정: 로그인만 하고 path로 이동 */
async function loginThenGo(browser, email, path, waitText) {
  const { ctx, page } = await newPage(browser, { fixedTime: FIXED })
  await page.goto(BASE + '/auth/login', { waitUntil: 'load' })
  await page.fill('input[type=email]', email)
  await page.fill('input[type=password]', PW)
  await page.locator('button[type=submit]:visible').first().click()
  if (waitText) await visible(page.getByText(waitText), 20000)
  else await page.waitForURL(/\/(student\/|dashboard)/, { timeout: 25000 }).catch(() => {})
  await page.goto(BASE + path, { waitUntil: 'load' })
  return { ctx, page }
}

async function visible(locator, timeout = 10000) {
  try {
    await locator.first().waitFor({ state: 'visible', timeout })
    return true
  } catch {
    return false
  }
}

async function gone(locator, timeout = 10000) {
  try {
    await locator.first().waitFor({ state: 'hidden', timeout })
    return true
  } catch {
    return false
  }
}

const seen = (page, text, timeout = 10000) => visible(page.getByText(text), timeout)
const region = (page, name) => page.getByRole('region', { name }).first()
/** 시간표 화면의 개인 시간표 영역('내 시간표' / 홈 '오늘의 내 시간표') */
const ttRegion = (page) => page.getByRole('region', { name: /내 시간표$/ }).first()

/** 글 카드(article) — 이름이 문자열이면 정확히 일치(‘영어’가 ‘영어 B’에 걸리지 않게), 정규식이면 패턴 */
const art = (scope, name) => scope.getByRole('article', typeof name === 'string' ? { name, exact: true } : { name })

async function articleText(scope, name, timeout = 10000) {
  const a = art(scope, name).first()
  if (!(await visible(a, timeout))) return null
  return (await a.innerText()).replace(/\n/g, ' ')
}

async function bodyText(page) {
  return page.locator('body').innerText()
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true }).catch(() => {})
}

/** select의 선택된 선택지 글자 */
const selectedText = (sel) => sel.evaluate((el) => (el.selectedIndex >= 0 ? el.options[el.selectedIndex].text : ''))

/** 확인 시트(useUI confirm)에서 버튼 누르기 */
async function confirmSheet(page, buttonName) {
  const d = page.getByRole('dialog').last()
  await d.waitFor({ state: 'visible', timeout: 10000 })
  const title = (await d.innerText()).split('\n')[0]
  await d.getByRole('button', { name: buttonName, exact: true }).click()
  await gone(d, 5000)
  return title
}

/** 화면·HTML에 내부 id가 없는지 */
async function leakedIds(page) {
  const html = await page.content()
  const text = await bodyText(page)
  return INTERNAL_IDS.filter((id) => html.includes(id) || text.includes(id))
}

async function entriesOf(uid) {
  const { db } = admin()
  const s = await db.collection(`users/${uid}/personalEntries`).get()
  return s.docs.map((d) => ({ id: d.id, ...d.data() }))
}

/** 화면은 쓰기 지연 보정으로 먼저 바뀌므로, 서버(Firestore)에 반영될 때까지 잠시 다시 읽음 */
async function entriesUntil(uid, pred, ms = 10000) {
  const end = Date.now() + ms
  let list = await entriesOf(uid)
  while (!pred(list) && Date.now() < end) {
    await sleep(400)
    list = await entriesOf(uid)
  }
  return list
}

/** 시간표 화면을 다시 받게 함(구독 → 포커스 복귀 → 새로고침 순) — 반영 경로를 note로 남김 */
async function waitTimetable(page, name, id) {
  const r = ttRegion(page)
  let t = await articleText(r, name, 12000)
  let path = 'scheduleRevision 구독'
  if (!t) {
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    t = await articleText(r, name, 8000)
    path = '포커스 복귀 다시 받기'
  }
  if (!t) {
    await page.reload({ waitUntil: 'load' })
    t = await articleText(r, name, 15000)
    path = '새로고침'
  }
  note(`${id}.path`, t ? `반영 경로: ${path}` : '반영 안 됨')
  return t
}

// ───────────────────────── T14: 직접 입력 추가·수정·삭제 ─────────────────────────

async function t14PersonalEntry(browser) {
  const { ctx, page, errors } = await openAs(browser, 'a@u2.e2e.kr', '/student/courses#personal')
  const sec = region(page, '직접 입력한 일정')
  check('T14.0', '#personal 앵커로 들어오면 직접 입력 섹션이 보임', await visible(sec))
  await visible(sec.getByText('아직 직접 입력한 일정이 없어요'), 8000)
  const box = await sec.boundingBox()
  check('T14.0b', '해시 앵커 섹션으로 스크롤(화면 안에 보임)', !!box && box.y < 900 && box.y + box.height > 0, box ? `y=${Math.round(box.y)}` : '')
  check('R08.0', '직접 입력 안내: 학교 시간표와 연결되지 않아 선생님 변경이 자동 반영되지 않음', await visible(sec.getByText(/자동으로 반영되지 않아요/)))

  // 입력 검증(제목 없음)
  await sec.getByRole('button', { name: '직접 입력 추가' }).click()
  let form = page.getByRole('form', { name: '직접 입력 일정 추가' })
  check('T14.1', '직접 입력 폼 열림', await visible(form))
  await form.getByRole('button', { name: '저장', exact: true }).click()
  check('T14.2', '제목 없이 저장 → "제목을 입력해 주세요." 안내(저장 안 됨)', await visible(form.getByText('제목을 입력해 주세요.'), 5000))
  check('T14.2b', '교시·시각 없이 저장 → "교시나 시작 시각 중 하나는 입력해 주세요."', await visible(form.getByText('교시나 시작 시각 중 하나는 입력해 주세요.'), 3000))

  // 매주 화 7교시 '수학 보충'
  await form.getByLabel('제목', { exact: true }).fill('수학 보충')
  check('T14.3', '기본 반복은 매주', await form.getByRole('radio', { name: '매주' }).isChecked())
  await form.getByLabel('요일', { exact: true }).selectOption('2')
  await form.getByLabel('교시', { exact: true }).selectOption('7')
  await form.getByLabel('교실 (선택)').fill('수학실')
  const linkSel = form.getByLabel(/연결할 공식 수업/)
  const linkDefault = (await linkSel.count()) ? await selectedText(linkSel) : '(선택 없음)'
  check('T14.4/R08', '공식 수업 연결은 기본 "연결하지 않음"(자동 연결 없음)', /연결하지 않음/.test(linkDefault), linkDefault)
  await form.getByRole('button', { name: '저장', exact: true }).click()
  const savedToast = await seen(page, '저장했어요', 10000)
  let item = await articleText(sec, '수학 보충')
  check('T14.5', '저장 → 목록에 "수학 보충" · 매주 화요일 · 7교시 · 수학실', savedToast && !!item && item.includes('매주 화요일') && item.includes('7교시') && item.includes('수학실'), item ?? '목록에 없음')
  check('T14.6/R08', '목록: "직접 입력 · 학교 시간표와 연결되지 않음" 배지', !!item && item.includes('직접 입력 · 학교 시간표와 연결되지 않음'))
  const docs = (await entriesOf(U.a)).filter((d) => d.title === '수학 보충')
  const d0 = docs[0] || {}
  const keys = Object.keys(d0).filter((k) => k !== 'id').sort().join(',')
  check(
    'T14.7',
    'Firestore 저장 형태: weekly·weekday 2·period 7·linkedCourseId null·허용 키만',
    docs.length === 1 && d0.kind === 'weekly' && d0.weekday === 2 && d0.period === 7 && d0.roomName === '수학실' && d0.linkedCourseId === null && keys === 'createdAt,date,end,kind,linkedCourseId,memo,period,roomName,start,title,weekday',
    JSON.stringify({ n: docs.length, kind: d0.kind, weekday: d0.weekday, period: d0.period, linkedCourseId: d0.linkedCourseId, keys })
  )
  await shot(page, 'T14-saved')

  // 특정 날짜 일정(once) — 10/7 16:30~18:00
  await sec.getByRole('button', { name: '직접 입력 추가' }).click()
  form = page.getByRole('form', { name: '직접 입력 일정 추가' })
  await form.getByLabel('제목', { exact: true }).fill('방과후 코딩')
  await form.getByRole('radio', { name: '특정 날짜' }).check()
  await form.getByLabel('날짜', { exact: true }).fill('2026-10-07')
  await form.getByLabel('시작 시각').fill('16:30')
  await form.getByLabel('끝 시각').fill('18:00')
  await form.getByRole('button', { name: '저장', exact: true }).click()
  const once = await articleText(sec, '방과후 코딩')
  check('T14.8', '특정 날짜 일정: "10월 7일(수) · 16:30~18:00"', !!once && once.includes('10월 7일(수)') && once.includes('16:30~18:00'), once ?? '없음')

  // 시간표(10/6)에 회색 점선 '직접 입력' 카드
  await page.goto(BASE + `/student/timetable?date=${TODAY}`, { waitUntil: 'load' })
  const tt = ttRegion(page)
  const card = await articleText(tt, /7교시 수학 보충/, 15000)
  const cls = card ? (await tt.getByRole('article', { name: /7교시 수학 보충/ }).first().getAttribute('class')) || '' : ''
  check('T14.9/R08', '/student/timetable?date=20261006: "7교시 수학 보충" 회색 점선 카드 + "직접 입력 · 학교 시간표와 연결되지 않음"', !!card && card.includes('직접 입력 · 학교 시간표와 연결되지 않음') && /border-dashed/.test(cls) && /border-gray-/.test(cls), `${card ?? '없음'} | ${cls}`)
  check('T14.10/R08', '직접 입력 카드에 변경 강조(빨간 배지) 없음', !!card && !/시간 변경|교실 변경|날짜 변경/.test(card) && !/border-red-/.test(cls))
  await shot(page, 'T14-timetable')
  await page.goto(BASE + '/student/timetable?date=20261007', { waitUntil: 'load' })
  check('T14.11', '10/7 시간표: 특정 날짜 일정 "방과후 코딩" 16:30', !!(await articleText(ttRegion(page), /16:30.*방과후 코딩/, 15000)))

  // 홈 카드(오늘 10/6)
  await page.goto(BASE + '/student/today', { waitUntil: 'load' })
  const home = await articleText(page.getByRole('region', { name: '오늘의 내 시간표' }), /7교시 수학 보충/, 15000)
  check('T14.12', '홈 "오늘의 내 시간표" 카드에도 반영', !!home, home ?? '없음')

  // 수정: 8교시 · 수학실 2 · 메모
  await page.goto(BASE + '/student/courses#personal', { waitUntil: 'load' })
  await visible(art(sec, '수학 보충'), 10000)
  await sec.getByRole('button', { name: '수학 보충 수정' }).click()
  const edit = page.getByRole('form', { name: '직접 입력 일정 수정' })
  check('T14.13', '수정 폼에 저장된 값', (await visible(edit)) && (await edit.getByLabel('제목', { exact: true }).inputValue()) === '수학 보충' && (await edit.getByLabel('교시', { exact: true }).inputValue()) === '7')
  await edit.getByLabel('교시', { exact: true }).selectOption('8')
  await edit.getByLabel('교실 (선택)').fill('수학실 2')
  await edit.getByLabel('메모 (선택)').fill('심화 문제 풀기')
  await edit.getByRole('button', { name: '저장', exact: true }).click()
  const edited = await seen(page, '고쳤어요', 10000)
  item = await articleText(sec, '수학 보충')
  check('T14.14', '수정 → 8교시 · 수학실 2 · 메모', edited && !!item && item.includes('8교시') && item.includes('수학실 2') && item.includes('심화 문제 풀기'), item ?? '없음')
  const d1 = (await entriesOf(U.a)).find((d) => d.title === '수학 보충') || {}
  check('T14.15', '수정은 바뀐 필드 + updatedAt(createdAt 유지)', d1.period === 8 && d1.roomName === '수학실 2' && !!d1.updatedAt && !!d1.createdAt, JSON.stringify({ period: d1.period, roomName: d1.roomName, updatedAt: !!d1.updatedAt }))
  await page.goto(BASE + `/student/timetable?date=${TODAY}`, { waitUntil: 'load' })
  const card8 = await articleText(ttRegion(page), /8교시 수학 보충/, 15000)
  check('T14.16', '시간표: 8교시로 바뀌고 7교시 카드는 없음', !!card8 && !(await visible(ttRegion(page).getByRole('article', { name: /7교시 수학 보충/ }), 1500)), card8 ?? '없음')

  // 삭제(확인)
  await page.goto(BASE + '/student/courses#personal', { waitUntil: 'load' })
  await visible(art(sec, '수학 보충'), 10000)
  await sec.getByRole('button', { name: '수학 보충 삭제' }).click()
  const dTitle = await confirmSheet(page, '삭제')
  check('T14.17', '삭제는 확인 시트를 거침', /수학 보충.*삭제할까요/.test(dTitle), dTitle)
  const removed = await gone(art(sec, '수학 보충'), 10000)
  const left = (await entriesUntil(U.a, (l) => !l.some((d) => d.title === '수학 보충'))).filter((d) => d.title === '수학 보충')
  check('T14.18', '삭제 → 목록·Firestore에서 사라짐', removed && left.length === 0, `남은 문서 ${left.length}`)
  await page.goto(BASE + `/student/timetable?date=${TODAY}`, { waitUntil: 'load' })
  await visible(ttRegion(page).getByRole('article'), 15000)
  check('T14.19', '삭제 후 시간표에 "수학 보충" 없음', !(await visible(ttRegion(page).getByRole('article', { name: /수학 보충/ }), 2000)))

  // 내부 id·다른 학생 정보
  await page.goto(BASE + '/student/courses', { waitUntil: 'load' })
  await visible(region(page, '참여 중인 수업').getByRole('article'), 15000)
  const leaks = await leakedIds(page)
  check('T14.20', '내 수업 화면 HTML·텍스트에 내부 id(uid·courseId·seriesId·classId) 없음', leaks.length === 0, leaks.join(','))
  check('T14.21', '다른 학생 이름이 보이지 않음', !OTHER_STUDENT_NAMES.test(await bodyText(page)))
  if (errors.length) note('T14.errors', JSON.stringify(errors.slice(0, 5)))
  await ctx.close()
}

// ───────────────────────── T24·R07: 참여 중인 수업 목록(출처·기간·상태) ─────────────────────────

async function t24MineList(browser) {
  const { ctx, page } = await openAs(browser, 'a@u2.e2e.kr', '/student/courses#mine')
  const mine = region(page, '참여 중인 수업')
  const lit = await articleText(mine, '문학', 15000)
  check('R07.1', '반 공통 수업: 문학 · 참여 중 · 출처 반 공통 수업 · 화 1교시 · 3학년 4반 교실', !!lit && lit.includes('참여 중') && lit.includes('출처 · 반 공통 수업') && lit.includes('화 1교시') && lit.includes('3학년 4반 교실'), lit ?? '없음')
  const engC = await articleText(mine, '영어 C')
  check('R07.2', '예전 수업 그룹(source legacy-group): 영어 C · 출처 예전 수업 그룹 · 정영어 선생님 · 영어전용실', !!engC && engC.includes('출처 · 예전 수업 그룹') && engC.includes('정영어 선생님') && engC.includes('영어전용실'), engC ?? '없음')
  const hist = await articleText(mine, '한국사 E')
  check('T24.1', '시작 전 수강(from 10/12): "10월 12일부터" 표시(참여 중으로 단정하지 않음)', !!hist && hist.includes('10월 12일부터') && !hist.includes('참여 중') && hist.includes('출처 · 초대'), hist ?? '없음')
  const endedSummary = mine.getByText(/종료된 수업 1개/)
  const hasEnded = await visible(endedSummary, 5000)
  if (hasEnded) await endedSummary.click()
  const math = hasEnded ? await articleText(mine, '수학 C', 5000) : null
  check('T24.2', '종료된 수강(to 9/15): "종료된 수업"으로 따로 · "종료 · 9월 14일까지" · 출처 명단', !!math && math.includes('종료 · 9월 14일까지') && math.includes('출처 · 명단'), math ?? '없음')
  const top = await page.locator('main p').first().innerText()
  check('T24.3', '상단: 학교 · 원래 소속(3학년 4반)', top.includes('테스트고등학교') && top.includes('3학년 4반'), top)
  await shot(page, 'T24-mine')
  await ctx.close()

  // 그룹이 소속처럼 저장된 예전 학생
  const g = await openAs(browser, 'g@u2.e2e.kr', '/student/courses')
  await visible(g.page.getByText('소속 학급이 아직 없어요(수업은 따로 볼 수 있음)'), 15000)
  const gText = await bodyText(g.page)
  check('R07.3', '예전 그룹 학생: "소속 학급 확인 필요" + "소속 학급이 아직 없어요(수업은 따로 볼 수 있음)" + 담임 초대 코드 입력', gText.includes('소속 학급 확인 필요') && gText.includes('소속 학급이 아직 없어요(수업은 따로 볼 수 있음)') && (await visible(g.page.getByRole('link', { name: '담임 초대 코드 입력' }), 3000)))
  const gEng = await articleText(region(g.page, '참여 중인 수업'), '영어 B', 15000)
  check('R07.4', '그룹 QR로 연결된 영어 B가 참여 중인 수업에 표시', !!gEng && gEng.includes('참여 중'), gEng ?? '없음')
  // via 'group-qr'는 서버(enrollmentFromDoc)가 내려주지 않으면 '초대'로 보임 — 결과만 기록
  note('R07.4.via', `group-qr 수강 출처 표시: ${gEng ? (gEng.match(/출처 · [^ ]+( [^ ]+)?/) || ['?'])[0] : '없음'} (서버가 via를 내려주면 '예전 수업 그룹')`)
  await g.ctx.close()
}

// ───────────────────────── T13: 수업 담기(과목으로 찾기) → 담기 ─────────────────────────
// (예전 '공식 수업 찾기 → 신청'을 '수업 담기 → 담은 수업 한 번에 담기'로 바꾼 흐름. 시간표 칸 보기는 u7에서)

const PICKER = '수업 담기 (학교 수업 목록에서 고르기)'

async function t13Catalog(browser) {
  const sToday = serverToday()
  note('T13.server', `서버 날짜 ${sToday}, 학기 ${CAT_TERM}`)
  let failNext = null
  const setup = async (page) => {
    await page.route('**/api/enrollments', (route) => {
      if (!failNext) return route.continue()
      const f = failNext
      failNext = null
      return route.fulfill({ status: f.status, contentType: 'application/json', body: JSON.stringify({ error: '테스트 오류', code: f.code }) })
    })
  }
  const { ctx, page, errors } = await openAs(browser, 'k@u2.e2e.kr', '/student/courses#catalog', setup)
  const cat = region(page, PICKER)
  await visible(cat.getByRole('button', { name: '과목으로 찾기' }), 15000)
  await cat.getByRole('button', { name: '과목으로 찾기' }).click()
  const sci = await articleText(cat, '생활과 과학 A', 15000)
  check('T13.1', '공개 수업 목록: 생활과 과학 A · 과목·분반·최과학 선생님·화 4교시, 목 2교시(교실 과학실) · "바로 담기"', !!sci && sci.includes('분반 A') && sci.includes('최과학 선생님') && sci.includes('화 4교시') && sci.includes('목 2교시') && sci.includes('과학실') && sci.includes('바로 담기'), sci ?? '없음')
  const phys = await articleText(cat, '물리 D')
  check('T13.2', '승인 수업: 물리 D · "선생님 승인 필요"', !!phys && phys.includes('선생님 승인 필요'), phys ?? '없음')
  const catText = await cat.innerText()
  check('T13.3', '비공개(catalogVisible false) 수업·다른 공개 안 된 수업은 목록에 없음', !catText.includes('비공개 동아리') && !catText.includes('영어 B'))
  const box = await cat.boundingBox()
  check('T13.3b', '#catalog 앵커로 들어오면 수업 담기 섹션으로 스크롤', !!box && box.y < 900 && box.y + box.height > 0, box ? `y=${Math.round(box.y)}` : '')

  // 검색은 목록 필터일 뿐(자동 담기·연결 없음)
  await cat.getByLabel('과목명으로 찾기').fill('물리')
  const onlyPhys = (await visible(art(cat, '물리 D'), 3000)) && !(await visible(art(cat, '생활과 과학 A'), 1000))
  await sleep(800)
  const { db } = admin()
  const afterSearch = await db.collection('schools/S1/enrollments').where('uid', '==', U.k).get()
  check('T13.4/R07', '과목명 검색은 목록만 좁힘(수강 문서가 생기지 않음)', onlyPhys && afterSearch.size === 0, `수강 ${afterSearch.size}건`)
  await cat.getByLabel('과목명으로 찾기').fill('')

  // 담기 오류 code 안내(응답 모킹 409 course-ended) — 담은 수업은 그대로 남아 다시 담을 수 있음
  const cart = region(page, '담은 수업')
  failNext = { status: 409, code: 'course-ended' }
  await cat.getByRole('button', { name: '생활과 과학 A 담기' }).click()
  await cart.getByRole('button', { name: /내 시간표에 담기 \(1\)/ }).click()
  await confirmSheet(page, '담기')
  check('T13.5', '담기 오류 409 course-ended → "이미 끝난 수업이에요." 안내(빈 결과로 처리하지 않음), 담은 수업 유지', (await visible(cart.getByText('이미 끝난 수업이에요.'), 8000)) && (await visible(cart.getByText('담은 수업 1'), 2000)))

  // 바로 담기 수업 → 내 시간표에 추가
  await cart.getByRole('button', { name: /내 시간표에 담기 \(1\)/ }).click()
  const sheetTitle = await confirmSheet(page, '담기')
  check('T13.6', '담기 전 확인 시트(수업 이름)', sheetTitle.includes('생활과 과학 A'), sheetTitle)
  const added = await visible(cat.getByText('내 시간표에 추가됐어요'), 15000)
  const resultOk = await visible(cart.getByText(/생활과 과학 A — 추가됨/), 5000)
  const enrSci = (await db.doc(`schools/S1/enrollments/${C.sciA}__${U.k}`).get()).data() || {}
  check('T13.7', 'auto 수업 담기 → "추가됨"·"내 시간표에 추가됐어요" + 수강 active(source request)', added && resultOk && enrSci.status === 'active' && enrSci.source === 'request', JSON.stringify({ status: enrSci.status, source: enrSci.source, from: enrSci.from }))
  const sciAfter = await articleText(cat, '생활과 과학 A')
  check('T13.8', '담은 뒤 목록에 "참여 중"(담기 버튼 없음)', !!sciAfter && sciAfter.includes('참여 중') && !(await visible(cat.getByRole('button', { name: '생활과 과학 A 담기' }), 1000)), sciAfter ?? '없음')
  const mine = region(page, '참여 중인 수업')
  const mineSci = await articleText(mine, '생활과 과학 A', 15000)
  const startsLater = !!enrSci.from && enrSci.from > TODAY
  check(
    'T13.9',
    '참여 중인 수업에 생활과 과학 A · 출처 신청(내 시간표 다시 받음)',
    !!mineSci && mineSci.includes('출처 · 신청') && (startsLater ? /부터/.test(mineSci) : mineSci.includes('참여 중')),
    mineSci ?? '없음'
  )

  // 승인 필요 수업 담기 → 승인 대기
  await cat.getByRole('button', { name: '물리 D 담기' }).click()
  await cart.getByRole('button', { name: /내 시간표에 담기 \(1\)/ }).click()
  await confirmSheet(page, '담기')
  const waiting = await visible(cat.getByText('선생님 승인을 기다려요'), 15000)
  const enrPhys = (await db.doc(`schools/S1/enrollments/${C.physD}__${U.k}`).get()).data() || {}
  check('T13.10', 'approval 수업 담기 → "선생님 승인을 기다려요" + 수강 pending', waiting && enrPhys.status === 'pending', JSON.stringify({ status: enrPhys.status }))
  const minePhys = await articleText(mine, '물리 D', 15000)
  check('T13.11', '참여 중인 수업: 물리 D "승인 대기" + "물리 D 수업 승인을 기다리고 있어요"', !!minePhys && minePhys.includes('승인 대기') && minePhys.includes('물리 D 수업 승인을 기다리고 있어요'), minePhys ?? '없음')
  await shot(page, 'T13-catalog-after')

  // 새로고침 뒤에도 상태 유지(과목으로 찾기 목록)
  await page.reload({ waitUntil: 'load' })
  const cat2 = region(page, PICKER)
  await visible(cat2.getByRole('button', { name: '과목으로 찾기' }), 15000)
  await cat2.getByRole('button', { name: '과목으로 찾기' }).click()
  const sciReload = await articleText(cat2, '생활과 과학 A', 15000)
  const physReload = await articleText(cat2, '물리 D')
  check('T13.12', '다시 열어도 수업 담기 목록에 참여 중·승인 대기', !!sciReload && sciReload.includes('참여 중') && !!physReload && physReload.includes('승인 대기'))

  // 개인 시간표(10/6)에 이동수업 표시(소속 3학년 5반, 수업 장소 과학실) + 승인 대기 안내
  await page.goto(BASE + `/student/timetable?date=${TODAY}`, { waitUntil: 'load' })
  const tt = ttRegion(page)
  if (startsLater || sToday > TODAY) {
    note('T13.13', `서버 날짜(${sToday})가 10/6 뒤라 담은 수강이 ${enrSci.from}부터 — 10/6 시간표 확인 생략`)
  } else {
    const card = await articleText(tt, /4교시 생활과 과학 A/, 15000)
    check('T13.13', '개인 시간표 10/6: 4교시 생활과 과학 A · 과학실(소속 반과 다른 교실)', !!card && card.includes('과학실'), card ?? '없음')
  }
  check('T13.14', '개인 시간표: "물리 D 수업 승인을 기다리고 있어요"', await visible(tt.getByText('물리 D 수업 승인을 기다리고 있어요'), 10000))
  await shot(page, 'T13-timetable')
  if (errors.length) note('T13.errors', JSON.stringify(errors.slice(0, 5)))
  await ctx.close()
}

// ───────────────────────── T15: 직접 입력 → 공식 수업 연결 ─────────────────────────

async function t15Link(browser) {
  const { ctx, page, errors } = await openAs(browser, 'e@u2.e2e.kr', '/student/courses#personal')
  const sec = region(page, '직접 입력한 일정')
  await visible(sec.getByRole('button', { name: '직접 입력 추가' }), 15000)
  await sec.getByRole('button', { name: '직접 입력 추가' }).click()
  const form = page.getByRole('form', { name: '직접 입력 일정 추가' })
  await form.getByLabel('제목', { exact: true }).fill('영어')
  await form.getByLabel('요일', { exact: true }).selectOption('2')
  await form.getByLabel('교시', { exact: true }).selectOption('3')
  await form.getByLabel('메모 (선택)').fill('단어장 챙기기')
  await form.getByRole('button', { name: '저장', exact: true }).click()
  const item0 = await articleText(sec, '영어')
  check('T15.0', '직접 입력 "영어"(매주 화 3교시) 저장 · 미연결 배지', !!item0 && item0.includes('직접 입력 · 학교 시간표와 연결되지 않음'), item0 ?? '없음')

  // 연결 전: 공식 영어 B와 직접 입력 영어가 따로 보이고 겹침 경고
  await page.goto(BASE + `/student/timetable?date=${TODAY}`, { waitUntil: 'load' })
  let tt = ttRegion(page)
  const official0 = await articleText(tt, /3교시 영어 B/, 15000)
  const personal0 = await articleText(tt, /3교시 영어 \(직접 입력\)/, 5000)
  check('T15.1', '연결 전: 공식 영어 B + 직접 입력 영어가 각각 보이고 겹침 안내', !!official0 && !!personal0 && (await visible(tt.getByText(/겹쳐요/), 3000)))

  // 공식 수업에 연결(학생이 직접 고름) — 이름이 같아도 자동 선택 없음
  await page.goto(BASE + '/student/courses#personal', { waitUntil: 'load' })
  await visible(art(sec, '영어'), 15000)
  await sec.getByRole('button', { name: '영어 공식 수업에 연결' }).click()
  const lf = page.getByRole('form', { name: '공식 수업 연결' })
  check('T15.2', '연결 화면 열림', await visible(lf))
  const sel = lf.getByLabel(/연결할 공식 수업/)
  const selected0 = await selectedText(sel)
  const optionTexts = await sel.evaluate((el) => Array.from(el.options).map((o) => o.text))
  check('T15.3/R08', '제목이 "영어"여도 자동 추천·선택 없음(기본 "연결하지 않음")', /연결하지 않음/.test(selected0), selected0)
  check('T15.4', '선택지는 활성 수강 수업만(영어 B) — 수강하지 않는 물리 D·생활과 과학 A 없음', optionTexts.some((t) => t.startsWith('영어 B')) && !optionTexts.some((t) => /물리 D|생활과 과학 A|영어 C/.test(t)), optionTexts.join(' | '))
  await sel.selectOption({ label: '영어 B · 이영어 선생님' })
  const preview = lf.getByRole('group', { name: '연결 전 확인' })
  const pText = (await visible(preview, 5000)) ? (await preview.innerText()).replace(/\n/g, ' ') : ''
  check('T15.5', '연결 전 확인: 직접 입력(매주 화요일 3교시)과 공식 수업(화 3교시 · 3학년 5반 교실)을 나란히', pText.includes('직접 입력') && pText.includes('매주 화요일') && pText.includes('화 3교시') && pText.includes('3학년 5반 교실'), pText)
  check('T15.6', '같은 시간 겹침 안내 + "공식 수업이 표시되고 메모만 붙어요 — 학교 변경이 자동 반영돼요"', pText.includes('같은 시간이에요') && pText.includes('공식 수업이 표시되고 메모만 붙어요 — 학교 변경이 자동 반영돼요'), pText)
  await lf.getByRole('button', { name: '이 수업에 연결' }).click()
  const cTitle = await confirmSheet(page, '연결')
  check('T15.7', '연결은 확인 시트를 거침', cTitle.includes('영어 B'), cTitle)
  const linkedItem = await articleText(sec, '영어', 10000)
  const linkedOk = await visible(sec.getByText('공식 수업에 연결됨 · 영어 B'), 10000)
  check('T15.8', '목록: "공식 수업에 연결됨 · 영어 B" + 자동 반영 안내', linkedOk && !!linkedItem && linkedItem.includes('공식 수업이 표시되고 메모만 붙어요 — 학교 변경이 자동 반영돼요'), linkedItem ?? '없음')
  const ent = (await entriesOf(U.e)).find((d) => d.title === '영어') || {}
  check('T15.9', 'Firestore: linkedCourseId = 영어 B 수업(학생이 고른 활성 수강)', ent.linkedCourseId === C.engB, String(ent.linkedCourseId))
  await shot(page, 'T15-linked')

  // 연결 후 시간표: 영어 B 공식 카드 하나만 + 메모
  await page.goto(BASE + `/student/timetable?date=${TODAY}`, { waitUntil: 'load' })
  tt = ttRegion(page)
  const official1 = await articleText(tt, /3교시 영어 B/, 15000)
  const engCount1 = await tt.getByRole('article', { name: /영어/ }).count()
  check('T15.10', '연결 후 10/6: 영어 카드 하나(공식 영어 B)만 · 중복 없음', !!official1 && engCount1 === 1, `영어 카드 ${engCount1}개`)
  check('T15.11', '공식 카드에 메모 "단어장 챙기기" · 직접 입력 배지 없음', !!official1 && official1.includes('단어장 챙기기') && !official1.includes('직접 입력 · 학교 시간표와 연결되지 않음'), official1 ?? '없음')

  // 관리자 변경: 영어 B 화 3교시 → 2교시(이 날짜만) — 공식 카드가 따라 바뀌고 메모 유지
  await publishEngBMove()
  const moved = await waitTimetable(page, /2교시 영어 B/, 'T15.12')
  tt = ttRegion(page)
  const engCount2 = await tt.getByRole('article', { name: /영어/ }).count()
  check('T15.12', '변경 발행 → 공식 카드 2교시 + "시간 변경" + "3교시 → 2교시"', !!moved && moved.includes('시간 변경') && moved.includes('3교시 → 2교시'), moved ?? '없음')
  check('T15.13', '변경 후에도 메모 유지 · 영어 카드 하나(옛 3교시 직접 입력 카드 없음)', !!moved && moved.includes('단어장 챙기기') && engCount2 === 1 && !(await visible(tt.getByRole('article', { name: /3교시 영어/ }), 1000)), `영어 카드 ${engCount2}개`)
  await shot(page, 'T15-after-change')

  // R11: 이 날짜만 변경 — 다음 주 화요일은 기본 3교시 그대로(메모도 붙음)
  await page.goto(BASE + `/student/timetable?date=${NEXT_TUE}`, { waitUntil: 'load' })
  const next = await articleText(ttRegion(page), /3교시 영어 B/, 15000)
  check('R11.1/T15.14', '다음 주 화(10/13): 영어 B 기본 3교시 · 변경 배지 없음 · 메모 유지', !!next && !next.includes('변경') && next.includes('단어장 챙기기'), next ?? '없음')

  // 규칙: 수강하지 않는 수업 id로 직접 연결 시도 → 거부 / 연결 그대로 두고 메모만 수정 → 허용
  const cs = await clientSession('e@u2.e2e.kr')
  try {
    const tryWrite = async (fn) => {
      try {
        await fn()
        return 'ok'
      } catch (e) {
        return String(e?.code || e?.message || e)
      }
    }
    const base = { title: '물리', kind: 'weekly', weekday: 2, date: null, period: 5, start: null, end: null, roomName: null, memo: null }
    const r1 = await tryWrite(() => setDoc(doc(cs.d, 'users', cs.uid, 'personalEntries', 'e2eU2RuleNew'), { ...base, linkedCourseId: C.physD, createdAt: serverTimestamp() }))
    check('T15.15', '규칙: 수강하지 않는 수업(물리 D) id로 새 일정 연결 → permission-denied', /permission-denied/.test(r1), r1)
    const r2 = await tryWrite(() => updateDoc(doc(cs.d, 'users', cs.uid, 'personalEntries', ent.id), { linkedCourseId: C.physD, updatedAt: serverTimestamp() }))
    check('T15.16', '규칙: 기존 일정 연결을 수강하지 않는 수업으로 바꾸기 → permission-denied', /permission-denied/.test(r2), r2)
    const r3 = await tryWrite(() => updateDoc(doc(cs.d, 'users', cs.uid, 'personalEntries', ent.id), { memo: '단어장 챙기기 · 듣기', updatedAt: serverTimestamp() }))
    check('T15.17', '규칙: 연결은 그대로 두고 메모만 수정 → 허용(연결 변경 때만 재검사)', r3 === 'ok', r3)
    const r4 = await tryWrite(() => setDoc(doc(cs.d, 'users', cs.uid, 'personalEntries', 'e2eU2RuleOk'), { ...base, title: '영어 복습', period: 3, linkedCourseId: C.engB, createdAt: serverTimestamp() }))
    check('T15.18', '규칙(대조): 본인 active 수강(영어 B) 연결 새 일정 → 허용', r4 === 'ok', r4)
    if (r4 === 'ok') await admin().db.doc(`users/${U.e}/personalEntries/e2eU2RuleOk`).delete()
  } finally {
    await cs.close()
  }

  // 연결 해제(setPersonalEntryLink null) → 다시 직접 입력 표시
  await page.goto(BASE + '/student/courses#personal', { waitUntil: 'load' })
  await visible(art(sec, '영어'), 15000)
  await sec.getByRole('button', { name: '영어 연결 해제' }).click()
  await confirmSheet(page, '연결 해제')
  const unlinked = await visible(art(sec, '영어').getByText('직접 입력 · 학교 시간표와 연결되지 않음'), 10000)
  const ent2 = (await entriesUntil(U.e, (l) => l.some((d) => d.title === '영어' && d.linkedCourseId === null))).find((d) => d.title === '영어') || {}
  check('T15.19', '연결 해제 → "직접 입력 · 학교 시간표와 연결되지 않음" + linkedCourseId null', unlinked && ent2.linkedCourseId === null, String(ent2.linkedCourseId))
  await shot(page, 'T15-unlinked')
  if (errors.length) note('T15.errors', JSON.stringify(errors.slice(0, 5)))
  await ctx.close()
}

// ───────────────────────── T34·R15: 상태 구분 ─────────────────────────

async function t34States(browser) {
  // 로그인 안 됨 → '로그인이 필요해요' + 로그인(next=/student/courses#catalog) → 로그인 뒤 돌아옴
  const anon = await newPage(browser, { fixedTime: FIXED })
  await anon.page.goto(BASE + '/student/courses#catalog', { waitUntil: 'load' })
  const loginMsg = await seen(anon.page, '로그인이 필요해요', 15000)
  const loginLink = anon.page.getByRole('link', { name: '로그인', exact: true })
  const href = (await visible(loginLink, 3000)) ? (await loginLink.getAttribute('href')) || '' : ''
  check('T34.1/R15', '로그인 안 됨: "로그인이 필요해요" + 로그인(next=/student/courses#catalog)', loginMsg && decodeURIComponent(href).includes('next=/student/courses#catalog'), href)
  try {
    await loginLink.click()
    await anon.page.waitForURL(/\/auth\/login/, { timeout: 10000 })
    await anon.page.fill('input[type=email]', 'a@u2.e2e.kr')
    await anon.page.fill('input[type=password]', PW)
    await anon.page.locator('button[type=submit]:visible').first().click()
    await anon.page.waitForURL(/\/student\/courses/, { timeout: 25000 })
    check('T34.2/R15', '로그인 뒤 /student/courses(수업 담기)로 돌아옴', await visible(region(anon.page, PICKER), 15000), anon.page.url())
  } catch (e) {
    check('T34.2/R15', '로그인 뒤 /student/courses로 돌아옴', false, `${anon.page.url()} ${String(e?.message || e).slice(0, 120)}`)
  }
  await anon.ctx.close()

  // 가입 미완료(프로필 없음)
  const np = await loginThenGo(browser, 'np@u2.e2e.kr', '/student/courses', '아직 학생이나 선생님으로 등록되지 않았어요')
  check('T34.3', '가입 미완료: "가입이 아직 끝나지 않았어요" + 초대 코드 입력', (await seen(np.page, '가입이 아직 끝나지 않았어요', 15000)) && (await visible(np.page.getByLabel('초대 코드'), 3000)))
  await shot(np.page, 'T34-no-profile')
  await np.ctx.close()

  // 학교 없음
  const ns = await loginThenGo(browser, 'ns@u2.e2e.kr', '/student/courses')
  check('T34.4', '학교 미설정: "학교 정보가 없어요" + 초대 코드 입력', (await seen(ns.page, '학교 정보가 없어요', 15000)) && (await visible(ns.page.getByLabel('초대 코드'), 3000)))
  await ns.ctx.close()

  // 학생이 아님(교사)
  const ty = await loginThenGo(browser, 'ty@u2.e2e.kr', '/student/courses')
  check('T34.5', '교사 계정: "이 시간표를 볼 권한이 없어요" + 선생님 화면으로', (await seen(ty.page, '이 시간표를 볼 권한이 없어요', 15000)) && (await visible(ty.page.getByRole('link', { name: '선생님 화면으로' }), 3000)))
  await ty.ctx.close()

  // 서버 오류(응답 모킹) — 빈 목록으로 위장하지 않고 code + 다시 시도
  let ttFail = true
  let catFail = true
  const setup = async (page) => {
    await page.route('**/api/timetable/me**', (route) =>
      ttFail ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'x', code: 'load-failed' }) }) : route.continue()
    )
    await page.route('**/api/courses', (route) =>
      catFail ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'x', code: 'server-error' }) }) : route.continue()
    )
  }
  const a = await openAs(browser, 'a@u2.e2e.kr', '/student/courses', setup)
  const mine = region(a.page, '참여 중인 수업')
  const cat = region(a.page, PICKER)
  const mineErr = await visible(mine.getByText('참여 중인 수업을 불러오지 못했어요 (load-failed)'), 20000)
  const catErr = await visible(cat.getByText('학교 수업 목록을 불러오지 못했어요 (server-error)'), 10000)
  const text = await bodyText(a.page)
  check('T34.6/R15', '수업 목록 500 → "참여 중인 수업을 불러오지 못했어요 (load-failed)" + 다시 시도("연결된 수업이 없어요"로 위장 안 함)', mineErr && (await visible(mine.getByRole('button', { name: '다시 시도' }), 2000)) && !text.includes('아직 연결된 수업이 없어요'))
  check('T34.7/R15', '수업 담기 목록 500 → "학교 수업 목록을 불러오지 못했어요 (server-error)" + 다시 시도("공개된 수업이 없어요"로 위장 안 함)', catErr && !text.includes('지금 학교에 공개된 수업이 없어요'))
  await shot(a.page, 'T34-errors')
  ttFail = false
  catFail = false
  await mine.getByRole('button', { name: '다시 시도' }).click()
  await cat.getByRole('button', { name: '다시 시도' }).click()
  await visible(cat.getByRole('button', { name: '과목으로 찾기' }), 15000)
  await cat.getByRole('button', { name: '과목으로 찾기' }).click()
  check('T34.8', '다시 시도 → 목록 복구', (await visible(art(mine, '문학'), 15000)) && (await visible(art(cat, '물리 D'), 15000)))
  await a.ctx.close()

  // #invite 앵커: 초대 코드 입력칸으로 바로
  const inv = await openAs(browser, 'k@u2.e2e.kr', '/student/courses#invite')
  const invInput = region(inv.page, '초대 코드로 참여').getByLabel('초대 코드')
  await visible(invInput, 15000)
  check('U2.invite', '#invite → 초대 코드 입력칸에 바로 입력 가능(포커스)', await invInput.evaluate((el) => el === document.activeElement).catch(() => false))
  await invInput.fill('ABCD2345')
  await region(inv.page, '초대 코드로 참여').getByRole('button', { name: '초대 확인하기' }).click()
  await inv.page.waitForURL(/\/i\/ABCD2345/, { timeout: 10000 }).catch(() => {})
  check('U2.invite.2', '초대 코드 입력 → /i/{code}', /\/i\/ABCD2345/.test(inv.page.url()), inv.page.url())
  await inv.ctx.close()
}

async function main() {
  await seed()
  note('setup', `고정 시각 ${FIXED}, 학교 S1, 학기 ${TERM}(수업 담기 ${CAT_TERM}) — 문학(3-4 공통)·영어 B·영어 C·수학 C(종료)·한국사 E(10/12부터)·생활과 과학 A(바로 참여)·물리 D(승인)·비공개 동아리`)
  const browser = await launchBrowser()
  try {
    await t14PersonalEntry(browser)
    await t24MineList(browser)
    await t13Catalog(browser)
    await t15Link(browser)
    await t34States(browser)
  } catch (e) {
    check('X', '시나리오 예외', false, e?.stack || String(e))
  } finally {
    await browser.close()
  }
  process.exit(finish() ? 1 : 0)
}

await main()
