// U6 교사 메인 화면 '오늘의 내 수업' E2E — 선생님 화면 메인은 반 시간표가 아니라 선생님 본인 시간표
// 덮는 항목: 메인에 '오늘의 내 수업'(학급 시간표는 메인 아님 — 급식은 유지), 날짜 이동, 변경 발행 뒤 새로 고침 없이 빨간 배지,
//           공식 수업 없는 교사의 직접 등록 주간 시간표(라벨), 교환·보결 겹침, 빈 상태(수업 관리·내 시간표 등록),
//           담임 '우리 반 시간표 보기' 링크, 390px 가로 스크롤 없음, 콘솔 오류·페이지 오류 0
// 실행 전제: 실제 서버(BASE, 기본 http://127.0.0.1:3100) + Firebase 에뮬레이터(Firestore 8080, Auth 9099)
//           + NEIS mock(NODE_OPTIONS="--require tests/support/neis-mock.cjs", NEIS_MOCK_FILE) + NEXT_PUBLIC_USE_EMULATORS=1 빌드
// 사용: node tests/e2e/u6-teacher-home.e2e.mjs
// 모든 데이터는 에뮬레이터의 테스트용 가상 데이터이며 실제 교사·학생 정보가 아닙니다.
import { admin, wipe, createUsers, writeNeisFixture, clientSession, api, reporter, launchBrowser, newPage, uiLogin, sleep, Timestamp, BASE } from './lib/env.mjs'

const LABEL = 'u6-teacher-home'
const { OUT, check, note, finish } = reporter(LABEL)
const FIXED = '2026-10-06T08:00:00+09:00' // 화요일 아침(1교시 전)
const TUE = '20261006'
const WED = '20261007'
const S1 = { schoolCode: 'S1', schoolName: '테스트고등학교', officeCode: 'B10' }
const STUDENT_NAME = '테스트학생가'
const LEGACY = {
  mon: ['', '', '', '', '', '', ''],
  tue: ['1-3 국어', '', '2-1 국어', '', '', '', ''],
  wed: ['', '', '', '', '', '', ''],
  thu: ['', '', '', '', '', '', ''],
  fri: ['', '', '', '', '', '', ''],
}

async function seed() {
  await wipe()
  writeNeisFixture({
    schools: [{ SD_SCHUL_CODE: 'S1', SCHUL_NM: '테스트고등학교', SCHUL_KND_SC_NM: '고등학교', ATPT_OFCDC_SC_CODE: 'B10' }],
    meals: [{ SD_SCHUL_CODE: 'S1', MLSV_YMD: TUE, MMEAL_SC_CODE: '2', MMEAL_SC_NM: '중식', DDISH_NM: '현미밥<br/>카레라이스<br/>깍두기' }],
    // 담임 반(3학년 5반) NEIS 학급 시간표 — 메인 화면에 보이면 안 됨(학급 시간표는 '우리 반 시간표 보기'에서만)
    timetables: { hisTimetable: ['학급체육', '학급음악'].map((s, i) => ({ SD_SCHUL_CODE: 'S1', GRADE: '3', CLASS_NM: '5', ALL_TI_YMD: TUE, PERIO: String(i + 1), ITRT_CNTNT: s })) },
    schedule: [],
  })
  const T = (name, extra = {}) => ({ role: 'teacher', name, displayName: name, ...S1, ...extra })
  await createUsers([
    // 교사 Y: 담임(3학년 5반) + 공식 수업 영어 B(화3·수2) + 예전 주간 시간표(참고로만 접혀 보여야 함)
    { uid: 'ty', email: 'ty@e2e.kr', doc: T('이영어', { classId: 'S1_3_5', grade: 3, classNm: 5, mySchedule: LEGACY }) },
    { uid: 'tx', email: 'tx@e2e.kr', doc: T('김과학') }, // 생활과 과학 A(화4)
    { uid: 'tleg', email: 'tleg@e2e.kr', doc: T('박주간', { mySchedule: LEGACY }) }, // 공식 수업 없음 + 주간 시간표
    { uid: 'tempty', email: 'tempty@e2e.kr', doc: T('최빈칸') }, // 아무것도 없음
    { uid: 'u6uidA', email: 'a@e2e.kr', doc: { role: 'student', status: 'approved', name: STUDENT_NAME, displayName: STUDENT_NAME, classId: 'S1_3_5', grade: 3, classNm: 5, studentId: 1, ...S1 } },
  ])
  const { db } = admin()
  const now = Timestamp.now()
  await db.doc('classes/S1_3_5').set({ classId: 'S1_3_5', grade: 3, classNm: 5, teacherId: 'ty', teacherName: '이영어', createdAt: now, ...S1 })
  const s = db.doc('schools/S1')
  await s.set({ name: '테스트고등학교', kind: '고등학교', scheduleRevision: 0, timezone: 'Asia/Seoul' })
  await s.collection('terms').doc('2026-2').set({ name: '2026학년도 2학기', startDate: '20260816', endDate: '20270301' })
  const course = (id, title, subject, section, teacher, teacherName, room) =>
    s.collection('courses').doc(id).set({
      schoolCode: 'S1', termId: '2026-2', title, subject, section, teacherUids: [teacher], teacherNames: [teacherName], status: 'active', endedOn: null,
      commonForHomerooms: [], defaultRoomName: room, invitePolicy: 'auto', catalogVisible: false, source: 'manual', createdBy: teacher, createdAt: now, updatedAt: now, revision: 0,
    })
  await course('engB', '영어 B', '영어', 'B', 'ty', '이영어', '3학년 5반 교실')
  await course('sciA', '생활과 과학 A', '생활과 과학', 'A', 'tx', '김과학', '과학실')
  const ser = (id, courseId, weekday, period) =>
    s.collection('series').doc(id).set({ courseId, termId: '2026-2', weekday, period, validFrom: '20260816', validTo: null, status: 'active', createdBy: 'seed', createdAt: now })
  await ser('sr_engB_tue3', 'engB', 2, 3)
  await ser('sr_engB_wed2', 'engB', 3, 2)
  await ser('sr_sciA_tue4', 'sciA', 2, 4)
  await s.collection('enrollments').doc('engB__u6uidA').set({ courseId: 'engB', uid: 'u6uidA', schoolCode: 'S1', termId: '2026-2', status: 'active', source: 'admin', createdAt: now, updatedAt: now })
  // 보결 SOS: 박주간 화1 → 이영어가 맡음
  await db.collection('school_sos').doc('S1').collection('requests').doc('sos1').set({
    date: TUE, period: 1, reason: '병원 진료', requesterId: 'tleg', requesterName: '박주간', requesterClass: '2학년 1반', schoolCode: 'S1',
    status: 'assigned', assignedTo: 'ty', assignedName: '이영어', createdAt: now,
  })
}

async function seen(page, textOrRe, timeout = 15000) {
  try {
    await page.getByText(textOrRe).first().waitFor({ state: 'visible', timeout })
    return true
  } catch {
    return false
  }
}
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true }).catch(() => {})
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
const card = (page) => page.locator('section[aria-labelledby="teacher-today-title"]')
const rowsText = async (page) => (await card(page).locator('ol[aria-label="내 수업 목록"] > li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim())

async function token(email) {
  const s = await clientSession(email)
  const t = s.token
  await s.close()
  return t
}
const revNow = async () => Number((await admin().db.doc('schools/S1').get()).get('scheduleRevision') || 0)

/** 빨간 배지인지(배지 span의 배경이 bg-red-100) */
async function redBadge(page, text) {
  const el = card(page).locator('span', { hasText: text }).first()
  try {
    await el.waitFor({ state: 'visible', timeout: 20000 })
  } catch {
    return false
  }
  return /bg-red-100/.test((await el.getAttribute('class')) || '')
}

const browser = await launchBrowser()
const errors = []
try {
  await seed()

  // ───────── 1. 담임 교사 Y: 메인 = 오늘의 내 수업 ─────────
  {
    const { ctx, page } = await newPage(browser, { fixedTime: FIXED, errors, who: 'ty' })
    await uiLogin(page, 'ty@e2e.kr')
    if (!/\/dashboard/.test(page.url())) await page.goto(BASE + '/dashboard', { waitUntil: 'load' })
    const title = await seen(page, '오늘의 내 수업', 20000)
    const rowOk = await seen(page, '영어 B', 20000)
    check('U6.main', "대시보드 메인에 '오늘의 내 수업' + 내 수업(영어 B)", title && rowOk)
    await seen(page, '오늘 급식', 15000)
    const body = await page.locator('body').innerText()
    check('U6.not-class', '학급 시간표(NEIS 3학년 5반 학급체육·학급음악, TodayCard 오늘 시간표)는 메인에 없음, 급식은 그대로',
      !body.includes('학급체육') && !body.includes('학급음악') && !body.includes('오늘 시간표') && body.includes('카레라이스'), '')
    // 메인 카드가 급식 카드보다 위
    const order = await page.evaluate(() => {
      const t = document.querySelector('section[aria-labelledby="teacher-today-title"]')
      const meal = Array.from(document.querySelectorAll('h3')).find((h) => h.textContent && h.textContent.includes('오늘 급식'))
      return !!t && !!meal && !!(t.compareDocumentPosition(meal) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    check('U6.order', "'오늘의 내 수업'이 급식 카드보다 먼저", order)
    let rows = await rowsText(page)
    check('U6.rows', '오늘 행: 1교시 대신 들어가는 보결(박주간) + 3교시 영어 B(교시·시각·교실)',
      rows.length === 2 && /1교시/.test(rows[0]) && rows[0].includes('대신 들어가는 수업 · 2학년 1반 (박주간 선생님)') && rows[0].includes('보결') &&
        /3교시/.test(rows[1]) && rows[1].includes('10:40') && rows[1].includes('영어 B') && rows[1].includes('3학년 5반 교실'),
      JSON.stringify(rows))
    const href = await card(page).getByRole('link', { name: '영어 B' }).first().getAttribute('href').catch(() => null)
    check('U6.course-link', '공식 수업 제목 → 수업 상세 링크', href === '/teacher/courses/engB', String(href))
    const refSummary = await seen(page, '내 주간 시간표(직접 등록·참고)', 5000)
    const refOpen = await card(page).locator('details[open]').count()
    check('U6.legacy-ref', '공식 수업이 있으면 직접 등록 주간 시간표는 접힌 참고로만', refSummary && refOpen === 0)
    check('U6.homeroom-link', "담임: '우리 반 시간표 보기' 링크(/teacher/class-timetable)",
      (await card(page).getByRole('link', { name: '우리 반 시간표 보기' }).getAttribute('href').catch(() => null)) === '/teacher/class-timetable')
    check('U6.no-student', '메인 화면에 학생 이름 없음', !body.includes(STUDENT_NAME))
    check('U6.width', '390px 가로 스크롤 없음(오늘)', await noHorizontalScroll(page))
    await shot(page, '1-today')

    // ───────── 2. 날짜 이동 ─────────
    await card(page).getByRole('button', { name: '다음 날' }).click()
    const tomorrow = (await seen(page, '내일', 10000)) && (await seen(page, '10월 7일 (수)', 10000))
    await page.waitForFunction(() => /2교시/.test(document.querySelector('ol[aria-label="내 수업 목록"]')?.textContent || ''), null, { timeout: 15000 }).catch(() => {})
    rows = await rowsText(page)
    const heading = await card(page).locator('h2').innerText()
    check('U6.nav-next', "다음 날: '내일 10월 7일 (수)' + 수요일 영어 B 2교시, 제목 '내 수업'", tomorrow && rows.length === 1 && /2교시/.test(rows[0]) && rows[0].includes('영어 B') && heading === '내 수업', JSON.stringify({ rows, heading }))
    await card(page).getByRole('button', { name: '오늘로' }).click()
    const back = await page.waitForFunction(() => document.querySelector('#teacher-today-title')?.textContent === '오늘의 내 수업', null, { timeout: 10000 }).then(() => true, () => false)
    check('U6.nav-today', "'오늘로' → 오늘(화)로 돌아옴", back && (await seen(page, '10월 6일 (화)', 5000)))
    await card(page).getByLabel('날짜 선택').fill('2026-10-10')
    const weekend = await seen(page, '이 날은 수업이 없어요', 15000)
    check('U6.nav-weekend', '날짜 선택(토요일) → 이 날은 수업이 없어요(주간 시간표를 꺼내 보이지 않음)', weekend && (await rowsText(page)).length === 0)
    await card(page).getByRole('button', { name: '오늘로' }).click()
    await seen(page, '영어 B', 10000)

    // ───────── 3. 변경 발행 → 새로 고침 없이 빨간 배지 ─────────
    let rev = await revNow()
    const room = await api('/api/schedule-changes', await token('ty@e2e.kr'), {
      action: 'publish', mutationId: 'u6-room-000001', expectedRevision: rev, reason: '교실 공사',
      items: [{ op: 'reschedule', courseId: 'engB', occurrenceKey: `sr_engB_tue3@${TUE}`, target: { roomName: '시청각실' } }],
    })
    rev = await revNow()
    const sub = await api('/api/schedule-changes', await token('tx@e2e.kr'), {
      action: 'publish', mutationId: 'u6-sub-0000001', expectedRevision: rev, reason: '출장',
      items: [{ op: 'reschedule', courseId: 'sciA', occurrenceKey: `sr_sciA_tue4@${TUE}`, target: { teacherUids: ['ty'] } }],
    })
    check('U6.publish', '교실 변경(영어 B)·담당 변경(생활과 과학 A → 이영어) 발행 200', room.status === 200 && sub.status === 200, `${room.status} ${room.j.code || ''} / ${sub.status} ${sub.j.code || ''}`)
    const roomBadge = await redBadge(page, '교실 변경')
    const subBadge = await redBadge(page, '대신 들어가는 수업')
    rows = await rowsText(page)
    check('U6.live-badge', "새로 고침 없이(시간표 버전 구독) 빨간 '교실 변경'(3학년 5반 교실 → 시청각실)·'대신 들어가는 수업'(생활과 과학 A 4교시)",
      roomBadge && subBadge && rows.some((t) => t.includes('3학년 5반 교실 → 시청각실')) && rows.some((t) => t.includes('생활과 과학 A') && /4교시/.test(t)),
      JSON.stringify(rows))
    const subHref = await card(page).getByRole('link', { name: '생활과 과학 A' }).count()
    check('U6.sub-no-link', '대신 들어가는 남의 수업은 수업 상세 링크 없음', subHref === 0)
    check('U6.width2', '390px 가로 스크롤 없음(변경 배지)', await noHorizontalScroll(page))
    await shot(page, '2-live-change')

    // ───────── 4. 담임 링크 → 우리 반 시간표 ─────────
    await card(page).getByRole('link', { name: '우리 반 시간표 보기' }).click()
    const moved = await page.waitForURL(/\/teacher\/class-timetable/, { timeout: 15000 }).then(() => true, () => false)
    check('U6.homeroom-nav', "'우리 반 시간표 보기' → /teacher/class-timetable", moved && (await seen(page, '학급 시간표 관리', 15000)))
    await ctx.close()
  }

  // ───────── 5. 공식 수업 없는 교사: 직접 등록 주간 시간표 + 보결 겹침 ─────────
  {
    const { ctx, page } = await newPage(browser, { fixedTime: FIXED, errors, who: 'tleg' })
    await uiLogin(page, 'tleg@e2e.kr')
    if (!/\/dashboard/.test(page.url())) await page.goto(BASE + '/dashboard', { waitUntil: 'load' })
    const label = await seen(page, '내가 등록한 주간 시간표예요 — 수업 변경은 반영되지 않아요', 20000)
    const rows = await rowsText(page)
    check('U6.legacy', "주간 시간표 방식: 라벨 + 화요일 칸(1교시 국어·1학년 3반, 3교시 국어·2학년 1반) '직접 등록 · 수업 변경 미반영'",
      label && rows.length === 2 && rows[0].includes('국어') && rows[0].includes('1학년 3반') && rows[0].includes('직접 등록 · 수업 변경 미반영') && rows[1].includes('2학년 1반'),
      JSON.stringify(rows))
    check('U6.cover', "보결 겹침: 1교시에 '이영어 선생님이 대신 들어가요 (보결)' 빨간 배지", (await redBadge(page, '이영어 선생님이 대신 들어가요 (보결)')) && rows[0].includes('이영어 선생님이 대신 들어가요 (보결)'), rows[0])
    check('U6.no-homeroom-link', "담임 아님: '우리 반 시간표 보기' 없음", (await card(page).getByRole('link', { name: '우리 반 시간표 보기' }).count()) === 0)
    check('U6.width3', '390px 가로 스크롤 없음(주간 시간표)', await noHorizontalScroll(page))
    await shot(page, '3-legacy')
    await ctx.close()
  }

  // ───────── 6. 아무것도 없는 교사: 빈 상태 ─────────
  {
    const { ctx, page } = await newPage(browser, { fixedTime: FIXED, errors, who: 'tempty' })
    await uiLogin(page, 'tempty@e2e.kr')
    if (!/\/dashboard/.test(page.url())) await page.goto(BASE + '/dashboard', { waitUntil: 'load' })
    const empty = await seen(page, '아직 등록된 내 시간표가 없어요', 20000)
    const c1 = await card(page).getByRole('link', { name: '수업 관리' }).getAttribute('href').catch(() => null)
    const c2 = await card(page).getByRole('link', { name: '내 시간표 등록' }).getAttribute('href').catch(() => null)
    check('U6.empty', "빈 상태 + '수업 관리'(/teacher/courses)·'내 시간표 등록'(/teacher/my-schedule)", empty && c1 === '/teacher/courses' && c2 === '/teacher/my-schedule', `${c1} ${c2}`)
    check('U6.empty-not-error', '빈 상태는 오류 카드가 아님', !(await card(page).getByText('시간표를 불러오지 못했어요').count()))
    check('U6.width4', '390px 가로 스크롤 없음(빈 상태)', await noHorizontalScroll(page))
    await shot(page, '4-empty')
    await card(page).getByRole('link', { name: '내 시간표 등록' }).click()
    check('U6.empty-cta', "'내 시간표 등록' → /teacher/my-schedule", await page.waitForURL(/\/teacher\/my-schedule/, { timeout: 15000 }).then(() => true, () => false))
    await ctx.close()
  }

  await sleep(500)
  const pageErrors = errors.filter((e) => e.kind === 'pageerror')
  const consoleErrors = errors.filter((e) => e.kind === 'console.error')
  check('U6.no-pageerror', '페이지 오류(pageerror) 0', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)))
  check('U6.no-console-error', '콘솔 오류(console.error) 0', consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 3)))
} catch (e) {
  check('crash', '시나리오 실행 중 예외', false, String(e?.stack || e).slice(0, 500))
} finally {
  await browser.close()
}
note('errors', `수집한 오류 ${errors.length}건(내용은 results.json)`)
const failed = finish({ errors })
process.exit(failed ? 1 : 0)
