// U8 교사 '내 시간표' 주간 보기 E2E — 요구: 선생님 화면에서 내 시간표를 누르면 오늘 시간표 말고 주간 시간표도
// 덮는 항목: 홈 카드 '주간 시간표 →'·제목 링크 → /teacher/timetable?view=week&date=, 대시보드 카드 '내 시간표 (주간)',
//           주간 표(요일 × 교시)에 수업이 맞는 날·교시에, 오늘 열·지금 교시 표시, 쉬는 날 열(한글날)·일부 학년 쉬는 날 안내,
//           변경 발행 → 새로 고침 없이 빨간 표시(교실 변경·대신 들어가는 수업), 보결 겹침, 칸 누르기 → 상세 시트(수업 상세 링크)·'이 날 전체 보기',
//           다음 주·지난주·날짜 선택·이번 주(주소 갱신), 토요일 수업이 있는 주만 토 열, 다른 날로 옮긴 수업(새 칸 + 원래 칸 '옮겨 감'),
//           주간/하루 탭, 공식 수업 없는 교사의 직접 등록 주간 시간표(라벨·7교시), 빈 상태, 학생은 학생 홈으로,
//           390px 화면 가로 스크롤 없음(표가 넓으면 표 상자 안에서만), 콘솔 오류·페이지 오류 0, 스크린숏
// 실행 전제: 실제 서버(BASE) + Firebase 에뮬레이터(Firestore 8080, Auth 9099) + NEIS mock + NEXT_PUBLIC_USE_EMULATORS=1 빌드 (u6과 같음)
// 사용: BASE=http://127.0.0.1:3200 node tests/e2e/u8-teacher-week.e2e.mjs
// 모든 데이터는 에뮬레이터의 테스트용 가상 데이터이며 실제 교사·학생 정보가 아닙니다.
import { admin, wipe, createUsers, writeNeisFixture, clientSession, api, reporter, launchBrowser, newPage, uiLogin, sleep, Timestamp, BASE } from './lib/env.mjs'

const LABEL = 'u8-teacher-week'
const { OUT, check, note, finish } = reporter(LABEL)
const FIXED = '2026-10-06T10:50:00+09:00' // 화요일 3교시(10:40~11:30) 중
const TUE = '20261006'
const WED = '20261007'
const FRI = '20261009'
const NEXT_WED = '20261014'
const NEXT_THU = '20261015'
const NEXT_SAT = '20261017'
const S1 = { schoolCode: 'S1', schoolName: '테스트고등학교', officeCode: 'B10' }
const LEGACY = {
  mon: ['', '', '', '', '', '', ''],
  tue: ['1-3 국어', '', '2-1 국어', '', '', '', ''],
  wed: ['', '', '', '', '', '', ''],
  thu: ['', '', '', '', '', '', '3-1 국어'],
  fri: ['', '', '', '', '', '', ''],
}

async function seed() {
  await wipe()
  writeNeisFixture({
    schools: [{ SD_SCHUL_CODE: 'S1', SCHUL_NM: '테스트고등학교', SCHUL_KND_SC_NM: '고등학교', ATPT_OFCDC_SC_CODE: 'B10' }],
    meals: [],
    timetables: {},
    schedule: [
      // 3학년만 쉬는 날(수) — 학년을 모르는 영어 B는 열림
      { SD_SCHUL_CODE: 'S1', AA_YMD: WED, EVENT_NM: '3학년 재량휴업일', SBTR_DD_SC_NM: '휴업일', ONE_GRADE_EVENT_YN: 'N', TW_GRADE_EVENT_YN: 'N', THREE_GRADE_EVENT_YN: 'Y', FR_GRADE_EVENT_YN: 'N', FIV_GRADE_EVENT_YN: 'N', SIX_GRADE_EVENT_YN: 'N' },
      // 학교 전체 공휴일(금)
      { SD_SCHUL_CODE: 'S1', AA_YMD: FRI, EVENT_NM: '한글날', SBTR_DD_SC_NM: '공휴일' },
    ],
  })
  const T = (name, extra = {}) => ({ role: 'teacher', name, displayName: name, ...S1, ...extra })
  await createUsers([
    // 교사 Y: 담임(3학년 5반) + 공식 수업 영어 B(화3·수2, 다음 주 토2) + 예전 주간 시간표(공식 방식이라 주간 표에는 안 보임)
    { uid: 'ty', email: 'ty@u8.e2e.kr', doc: T('이영어', { classId: 'S1_3_5', grade: 3, classNm: 5, mySchedule: LEGACY }) },
    { uid: 'tx', email: 'tx@u8.e2e.kr', doc: T('김과학') }, // 생활과 과학 A(화4)
    { uid: 'tleg', email: 'tleg@u8.e2e.kr', doc: T('박주간', { mySchedule: LEGACY }) }, // 공식 수업 없음 + 주간 시간표
    { uid: 'tempty', email: 'tempty@u8.e2e.kr', doc: T('최빈칸') }, // 아무것도 없음
    { uid: 'u8uidA', email: 'a@u8.e2e.kr', doc: { role: 'student', status: 'approved', name: '테스트학생팔', displayName: '테스트학생팔', classId: 'S1_3_5', grade: 3, classNm: 5, studentId: 1, ...S1 } },
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
  const ser = (id, courseId, weekday, period, extra = {}) =>
    s.collection('series').doc(id).set({ courseId, termId: '2026-2', weekday, period, validFrom: '20260816', validTo: null, status: 'active', createdBy: 'seed', createdAt: now, ...extra })
  await ser('sr_engB_tue3', 'engB', 2, 3)
  await ser('sr_engB_wed2', 'engB', 3, 2)
  await ser('sr_sciA_tue4', 'sciA', 2, 4)
  // 다음 주(10/12~10/18)에만 토요일 2교시 — 그 주에만 토 열
  await ser('sr_engB_sat2', 'engB', 6, 2, { validFrom: '20261012', validTo: '20261019' })
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
const cellBtn = (page, date, period) => page.locator(`button[data-cell="${date}|${period}"]`)
const cellLabel = (page, date, period) => cellBtn(page, date, period).getAttribute('aria-label', { timeout: 3000 }).catch(() => null)
const panel = (page) => page.locator('#tt-panel')
// 첫 열 머리(교시, 화면 낭독용)는 빼고 요일 열 머리만
const colHeaders = async (page) => (await page.locator('#tt-panel table thead th[scope="col"]:not(:first-child)').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean)
const weekRange = (page) => page.getByTestId('week-range').innerText().catch(() => '')
const urlQuery = (page) => Object.fromEntries(new URL(page.url()).searchParams)
async function waitUrl(page, re, timeout = 10000) {
  return page.waitForURL(re, { timeout }).then(() => true, () => false)
}
async function waitLabel(page, date, period, pred, timeout = 20000) {
  return page
    .waitForFunction(
      ([sel, src]) => {
        const el = document.querySelector(sel)
        const l = el ? el.getAttribute('aria-label') || '' : ''
        return new RegExp(src).test(l)
      },
      [`button[data-cell="${date}|${period}"]`, pred],
      { timeout }
    )
    .then(() => true, () => false)
}
async function token(email) {
  const s = await clientSession(email)
  const t = s.token
  await s.close()
  return t
}
const revNow = async () => Number((await admin().db.doc('schools/S1').get()).get('scheduleRevision') || 0)

const browser = await launchBrowser()
const errors = []
try {
  await seed()

  // ───────── 1. 홈 카드 → 주간 보기 ─────────
  {
    const { ctx, page } = await newPage(browser, { fixedTime: FIXED, errors, who: 'ty' })
    await uiLogin(page, 'ty@u8.e2e.kr')
    if (!/\/dashboard/.test(page.url())) await page.goto(BASE + '/dashboard', { waitUntil: 'load' })
    const card = page.locator('section[aria-labelledby="teacher-today-title"]')
    await seen(page, '영어 B', 20000)
    const weekLink = card.getByRole('link', { name: '주간 시간표', exact: true })
    const href = await weekLink.getAttribute('href').catch(() => null)
    const titleHref = await card.getByRole('link', { name: '오늘의 내 수업' }).getAttribute('href').catch(() => null)
    check('U8.home-link', "홈 카드 '주간 시간표 →'·카드 제목 → /teacher/timetable?view=week&date=20261006(보고 있는 날짜)",
      href === `/teacher/timetable?view=week&date=${TUE}` && titleHref === href, `${href} / ${titleHref}`)
    check('U8.home-homeroom', "담임 '우리 반 시간표 보기'는 그대로", (await card.getByRole('link', { name: '우리 반 시간표 보기' }).count()) === 1)
    check('U8.dash-card', "대시보드 카드 '내 시간표 (주간)'과 '내 수업 및 교환'이 함께", (await seen(page, '내 시간표 (주간)', 5000)) && (await seen(page, '내 수업 및 교환', 5000)))
    // 다음 날로 옮긴 뒤 링크는 그 날짜로
    await card.getByRole('button', { name: '다음 날' }).click()
    const nextHref = await page
      .waitForFunction(() => document.querySelector('section[aria-labelledby="teacher-today-title"] h2 a')?.getAttribute('href') === '/teacher/timetable?view=week&date=20261007', null, { timeout: 10000 })
      .then(() => true, () => false)
    check('U8.home-link-date', '홈 카드에서 날짜를 옮기면 주간 링크도 그 날짜', nextHref)
    await card.getByRole('button', { name: '오늘로' }).click()
    await page.waitForFunction(() => document.querySelector('#teacher-today-title')?.textContent === '오늘의 내 수업', null, { timeout: 10000 }).catch(() => {})
    await card.getByRole('link', { name: '주간 시간표', exact: true }).click()
    const opened = await waitUrl(page, /\/teacher\/timetable\?view=week&date=20261006/, 15000)
    const tabSel = await page.getByRole('tab', { name: '주간' }).getAttribute('aria-selected').catch(() => null)
    check('U8.open-week', "'주간 시간표 →' → 주간 탭(선택됨)", opened && tabSel === 'true', page.url().replace(BASE, ''))

    // ───────── 2. 주간 표: 맞는 날·교시 ─────────
    await cellBtn(page, TUE, 3).waitFor({ state: 'visible', timeout: 20000 }).catch(() => {})
    const range = await weekRange(page)
    check('U8.range', "기간 라벨 '이번 주 · 10월 5일 ~ 10월 9일'", range === '10월 5일 ~ 10월 9일' && (await panel(page).getByText('이번 주', { exact: true }).count()) >= 1, range)
    const heads = await colHeaders(page)
    check('U8.columns', '열: 월~금(토·일 수업 없는 주는 토·일 열 없음)', heads.length === 5 && heads[0].startsWith('월') && heads[4].startsWith('금') && !heads.some((h) => /^토|^일/.test(h)), JSON.stringify(heads))
    const t3 = await cellLabel(page, TUE, 3)
    const w2 = await cellLabel(page, WED, 2)
    const t1 = await cellLabel(page, TUE, 1)
    check('U8.cells', "화 3교시·수 2교시 영어 B, 화 1교시 보결(대신 들어가는 수업 · 2학년 1반 (박주간 선생님))",
      /^화 3교시 영어 B 3학년 5반 교실/.test(t3 || '') && /^수 2교시 영어 B/.test(w2 || '') && /^화 1교시 대신 들어가는 수업 · 2학년 1반 \(박주간 선생님\) \(보결\)/.test(t1 || ''),
      JSON.stringify([t3, w2, t1]))
    const emptyMon = await cellBtn(page, '20261005', 3).count()
    check('U8.empty-cell', '수업 없는 칸은 버튼 없음(월 3교시)', emptyMon === 0)
    const t1Badges = await cellBtn(page, TUE, 1).locator('span.bg-red-100').allInnerTexts()
    const t1Text = (await cellBtn(page, TUE, 1).innerText().catch(() => '')).replace(/\s+/g, ' ')
    check('U8.cover-badge', "보결 칸: '보결 수업 · 2-1' + 빨간 '대신' 배지", t1Badges.includes('대신') && t1Text.includes('보결 수업') && t1Text.includes('2-1'), JSON.stringify([t1Badges, t1Text]))
    const friText = (await panel(page).locator('td[rowspan]').allInnerTexts()).join('|')
    check('U8.holiday-col', "금(한글날)은 열 전체가 '쉬는 날 · 한글날'", friText.includes('쉬는 날') && friText.includes('한글날'), friText)
    const gradeNote = (await panel(page).locator('ul[aria-label="일부 학년 쉬는 날"]').innerText().catch(() => '')).replace(/\s+/g, ' ')
    check('U8.grade-off', "수 열 머리 '3학년 쉼' + 표 아래 '수 10/7 3학년 쉬는 날(3학년 재량휴업일) — 그 학년 수업은 열리지 않아요'",
      heads[2].includes('3학년 쉼') && gradeNote.includes('수 10/7 3학년 쉬는 날(3학년 재량휴업일) — 그 학년 수업은 열리지 않아요'), `${heads[2]} / ${gradeNote}`)
    const todayHead = await page.locator('#tt-panel th[aria-current="date"]').innerText().catch(() => '')
    const nowRow = await page.locator('#tt-panel tbody th[scope="row"]', { hasText: '(지금)' }).innerText().catch(() => '')
    check('U8.today-now', "오늘 열(화·'오늘') 강조 + 지금 교시(3교시) 표시", /화/.test(todayHead) && todayHead.includes('오늘') && /^3/.test(nowRow.trim()), `${todayHead} / ${nowRow}`)
    const rows = await page.locator('#tt-panel tbody tr').count()
    check('U8.periods', '교시 행 1~6(공식 수업만 — 최소 6)', rows === 6, String(rows))
    check('U8.width', '390px 화면 가로 스크롤 없음(주간)', await noHorizontalScroll(page))
    await shot(page, '1-week')

    // ───────── 3. 변경 발행 → 새로 고침 없이 빨간 표시 ─────────
    let rev = await revNow()
    const room = await api('/api/schedule-changes', await token('ty@u8.e2e.kr'), {
      action: 'publish', mutationId: 'u8-room-000001', expectedRevision: rev, reason: '교실 공사',
      items: [{ op: 'reschedule', courseId: 'engB', occurrenceKey: `sr_engB_tue3@${TUE}`, target: { roomName: '시청각실' } }],
    })
    rev = await revNow()
    const sub = await api('/api/schedule-changes', await token('tx@u8.e2e.kr'), {
      action: 'publish', mutationId: 'u8-sub-0000001', expectedRevision: rev, reason: '출장',
      items: [{ op: 'reschedule', courseId: 'sciA', occurrenceKey: `sr_sciA_tue4@${TUE}`, target: { teacherUids: ['ty'] } }],
    })
    check('U8.publish', '교실 변경(영어 B 화3)·담당 변경(생활과 과학 A 화4 → 이영어) 발행 200', room.status === 200 && sub.status === 200, `${room.status} ${room.j.code || ''} / ${sub.status} ${sub.j.code || ''}`)
    const roomLive = await waitLabel(page, TUE, 3, '영어 B 시청각실 \\(교실 변경\\)')
    const subLive = await waitLabel(page, TUE, 4, '생활과 과학 A .*대신 들어가는 수업')
    const roomChip = (await cellBtn(page, TUE, 3).locator('span[data-kind]').first().getAttribute('class').catch(() => '')) || ''
    // 칸 배지(span[data-badge]) 중 '대신'
    const subBadge = (await cellBtn(page, TUE, 4).locator('span[data-badge]', { hasText: /^대신$/ }).first().getAttribute('class').catch(() => '')) || ''
    const t3b = await cellLabel(page, TUE, 3)
    check('U8.live-change', "새로 고침 없이(시간표 버전 구독) 화 3교시 빨간 테두리·'교실 변경', 화 4교시 생활과 과학 A 빨간 '대신'",
      roomLive && subLive && /\(교실 변경\)/.test(t3b || '') && roomChip.includes('border-red-300') && subBadge.includes('bg-red-100'), JSON.stringify([t3b, roomChip.slice(0, 60), subBadge.slice(0, 40)]))
    check('U8.width2', '390px 가로 스크롤 없음(변경 표시)', await noHorizontalScroll(page))
    await shot(page, '2-live-change')

    // ───────── 4. 칸 누르기 → 상세 시트 → 하루 보기 ─────────
    await cellBtn(page, TUE, 3).click()
    const dialog = page.getByRole('dialog')
    const dlgOk = await dialog.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)
    const dlgText = dlgOk ? (await dialog.innerText()).replace(/\s+/g, ' ') : ''
    const dlgHref = await dialog.getByRole('link', { name: '영어 B' }).getAttribute('href').catch(() => null)
    check('U8.sheet', "칸 → 상세 시트('10월 6일 (화) 3교시', 교실 변경 전후, 수업 상세 링크)",
      dlgOk && dlgText.includes('10월 6일 (화) 3교시') && dlgText.includes('3학년 5반 교실 → 시청각실') && dlgHref === '/teacher/courses/engB', `${dlgText.slice(0, 160)} / ${dlgHref}`)
    await shot(page, '3-sheet')
    await page.keyboard.press('Escape')
    const closed = await dialog.waitFor({ state: 'hidden', timeout: 5000 }).then(() => true, () => false)
    const focusBack = await page.evaluate(() => document.activeElement?.getAttribute('data-cell') || '')
    check('U8.sheet-close', 'Esc로 닫힘 + 연 칸으로 초점', closed && focusBack === `${TUE}|3`, focusBack)
    await cellBtn(page, TUE, 4).click()
    await page.getByRole('dialog').getByRole('button', { name: '이 날 전체 보기' }).click()
    const toDay = await waitUrl(page, /view=day&date=20261006/)
    await page.locator('ol[aria-label="내 수업 목록"] > li').nth(2).waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})
    const dayRows = toDay ? await page.locator('ol[aria-label="내 수업 목록"] > li').count() : 0
    check('U8.sheet-day', "'이 날 전체 보기' → 하루 탭(?view=day&date=20261006) + 그 날 목록(보결·영어 B·생활과 과학 A)",
      toDay && (await page.getByRole('tab', { name: '하루' }).getAttribute('aria-selected')) === 'true' && dayRows === 3, `${page.url().replace(BASE, '')} rows=${dayRows}`)
    check('U8.day-nav', "하루 탭은 홈 카드와 같은 날짜 이동('10월 6일 (화)')", await seen(page, '10월 6일 (화)', 5000))
    await shot(page, '4-day')
    await page.getByRole('tab', { name: '주간' }).click()
    const backWeek = (await waitUrl(page, /view=week&date=20261006/)) && (await cellBtn(page, TUE, 3).waitFor({ state: 'visible', timeout: 10000 }).then(() => true, () => false))
    check('U8.tab-week', "'주간' 탭 → 다시 주간 표(?view=week, 같은 날짜)", backWeek, page.url().replace(BASE, ''))

    // ───────── 5. 다음 주(토요일 수업 + 다른 날로 옮긴 수업) ─────────
    rev = await revNow()
    const move = await api('/api/schedule-changes', await token('ty@u8.e2e.kr'), {
      action: 'publish', mutationId: 'u8-move-000001', expectedRevision: rev, reason: '체험학습',
      items: [{ op: 'reschedule', courseId: 'engB', occurrenceKey: `sr_engB_wed2@${NEXT_WED}`, target: { date: NEXT_THU, period: 5 } }],
    })
    check('U8.publish-move', '다음 주 수 2교시 → 목 5교시 이동 발행 200', move.status === 200, `${move.status} ${move.j.code || ''}`)
    await page.getByRole('button', { name: '다음 주' }).click()
    const nextUrl = await waitUrl(page, /view=week&date=20261013/)
    await cellBtn(page, NEXT_SAT, 2).waitFor({ state: 'visible', timeout: 20000 }).catch(() => {})
    const nextRange = await weekRange(page)
    const nextHeads = await colHeaders(page)
    check('U8.next-week', "다음 주 → 주소 date=20261013, '다음 주 · 10월 12일 ~ 10월 17일', 토 열(토 2교시 영어 B)",
      nextUrl && nextRange === '10월 12일 ~ 10월 17일' && nextHeads.length === 6 && nextHeads[5].startsWith('토') && /^토 2교시 영어 B/.test((await cellLabel(page, NEXT_SAT, 2)) || ''),
      `${page.url().replace(BASE, '')} ${nextRange} ${JSON.stringify(nextHeads)}`)
    const movedIn = await cellLabel(page, NEXT_THU, 5)
    const movedOut = await cellLabel(page, NEXT_WED, 2)
    const movedNote = await cellBtn(page, NEXT_WED, 2).innerText().catch(() => '')
    check('U8.moved', "옮긴 수업: 목 5교시에 영어 B(날짜 변경), 수 2교시에 '옮김 · → 목 5교시'",
      /영어 B .*날짜 변경/.test(movedIn || '') && /10월 15일\(목\) 5교시로 옮겨졌어요/.test(movedOut || '') && movedNote.includes('옮김') && movedNote.replace(/\s+/g, ' ').includes('→ 목 5교시'),
      JSON.stringify([movedIn, movedOut, movedNote.replace(/\s+/g, ' ')]))
    const scroll = await page.getByTestId('teacher-week-scroll').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth })).catch(() => null)
    check('U8.width3', '390px 화면 가로 스크롤 없음(월~토 6열도 표 상자 안에 — 7열이면 상자 안에서만 밀림)', (await noHorizontalScroll(page)) && !!scroll && scroll.sw <= scroll.cw + 1, JSON.stringify(scroll))
    await shot(page, '5-next-week')
    await page.getByRole('button', { name: '지난주' }).click()
    const prevUrl = await waitUrl(page, /view=week&date=20261006/)
    await cellBtn(page, TUE, 3).waitFor({ state: 'visible', timeout: 20000 }).catch(() => {})
    const prevHeads = await colHeaders(page)
    check('U8.prev-week', '지난주 → date=20261006, 토 열 없음', prevUrl && prevHeads.length === 5 && (await weekRange(page)) === '10월 5일 ~ 10월 9일', JSON.stringify(prevHeads))
    // 날짜 선택 → 그 날짜가 든 주, '이번 주' → 오늘
    await page.getByLabel('날짜 선택(그 날짜가 든 주로)').fill('2026-10-21')
    const picked = await waitUrl(page, /date=20261021/)
    await page.waitForFunction(() => document.querySelector('[data-testid="week-range"]')?.textContent === '10월 19일 ~ 10월 23일', null, { timeout: 15000 }).catch(() => {})
    check('U8.picker', "날짜 선택(10/21) → '2주 뒤 · 10월 19일 ~ 10월 23일'", picked && (await weekRange(page)) === '10월 19일 ~ 10월 23일' && (await panel(page).getByText('2주 뒤').count()) === 1)
    await page.getByRole('button', { name: '이번 주' }).click()
    check('U8.this-week', "'이번 주' → 오늘(date=20261006)", await waitUrl(page, /date=20261006/))
    // 빠르게 여러 주 넘김(응답을 기다리지 않고 주소만 바뀌면 다음 클릭) → 마지막 주만(앞 응답이 덮어쓰지 않음)
    let fastUrl = true
    for (const d of ['20261013', '20261020', '20261027']) {
      await page.getByRole('button', { name: '다음 주' }).click()
      fastUrl = (await waitUrl(page, new RegExp(`date=${d}`), 5000)) && fastUrl
    }
    await page.waitForFunction(() => document.querySelector('[data-testid="week-range"]')?.textContent === '10월 26일 ~ 10월 30일', null, { timeout: 15000 }).catch(() => {})
    await cellBtn(page, '20261027', 3).waitFor({ state: 'visible', timeout: 20000 }).catch(() => {})
    await sleep(1500)
    const fastLabel = await cellLabel(page, '20261027', 3)
    const staleCell = await cellBtn(page, NEXT_SAT, 2).count()
    check('U8.fast-nav', '다음 주를 빠르게 세 번 → 3주 뒤(10/26~) 자료만(앞 주 칸이 남지 않음)', fastUrl && /^화 3교시 영어 B/.test(fastLabel || '') && staleCell === 0, `${fastLabel} stale=${staleCell}`)
    await ctx.close()
  }

  // ───────── 6. 공식 수업 없는 교사: 직접 등록 주간 시간표 ─────────
  {
    const { ctx, page } = await newPage(browser, { fixedTime: FIXED, errors, who: 'tleg' })
    await uiLogin(page, 'tleg@u8.e2e.kr')
    await page.goto(BASE + '/teacher/timetable', { waitUntil: 'load' })
    const label = await seen(page, '내가 등록한 주간 시간표예요 — 수업 변경은 반영되지 않아요', 20000)
    const fix = await panel(page).getByRole('link', { name: '주간 시간표 고치기' }).getAttribute('href').catch(() => null)
    await cellBtn(page, TUE, 1).waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
    const a = await cellLabel(page, TUE, 1)
    const b = await cellLabel(page, TUE, 3)
    const c7 = await cellLabel(page, '20261008', 7)
    const rows = await page.locator('#tt-panel tbody tr').count()
    check('U8.legacy', "주간 시간표 방식: 라벨 + '주간 시간표 고치기'(/teacher/my-schedule), 화1 국어 1학년 3반·화3 국어 2학년 1반·목7 국어 3학년 1반, 7교시 행",
      label && fix === '/teacher/my-schedule' && /^화 1교시 국어 1학년 3반/.test(a || '') && /직접 등록 · 수업 변경 미반영/.test(a || '') && /^화 3교시 국어 2학년 1반/.test(b || '') && /^목 7교시 국어 3학년 1반/.test(c7 || '') && rows === 7,
      JSON.stringify([a, b, c7, rows]))
    check('U8.legacy-cover', "보결 겹침: 화1에 '이영어 선생님이 대신 들어가요 (보결)'(빨간 →이영어)",
      /이영어 선생님이 대신 들어가요 \(보결\)/.test(a || '') && (await cellBtn(page, TUE, 1).locator('span.bg-red-100', { hasText: '→이영어' }).count()) === 1, a)
    const legacyChip = (await cellBtn(page, TUE, 3).locator('span[data-kind]').first().getAttribute('class').catch(() => '')) || ''
    check('U8.legacy-style', '직접 등록 칸은 회색 점선', legacyChip.includes('border-dashed') && legacyChip.includes('border-gray-300'), legacyChip)
    check('U8.width4', '390px 가로 스크롤 없음(주간 시간표)', await noHorizontalScroll(page))
    await shot(page, '6-legacy')
    await ctx.close()
  }

  // ───────── 7. 아무것도 없는 교사: 빈 상태 ─────────
  {
    const { ctx, page } = await newPage(browser, { fixedTime: FIXED, errors, who: 'tempty' })
    await uiLogin(page, 'tempty@u8.e2e.kr')
    await page.goto(BASE + '/teacher/timetable?view=week', { waitUntil: 'load' })
    const empty = await seen(page, '아직 등록된 내 시간표가 없어요', 20000)
    const c1 = await panel(page).getByRole('link', { name: '수업 관리' }).getAttribute('href').catch(() => null)
    const c2 = await panel(page).getByRole('link', { name: '내 시간표 등록' }).getAttribute('href').catch(() => null)
    check('U8.empty', "빈 상태 + '수업 관리'·'내 시간표 등록', 빈 표 없음", empty && c1 === '/teacher/courses' && c2 === '/teacher/my-schedule' && (await page.locator('#tt-panel table').count()) === 0, `${c1} ${c2}`)
    check('U8.empty-not-error', '빈 상태는 오류 카드가 아님', !(await panel(page).getByText('시간표를 불러오지 못했어요').count()))
    await shot(page, '7-empty')
    await ctx.close()
  }

  // ───────── 8. 학생은 학생 홈으로 ─────────
  {
    const { ctx, page } = await newPage(browser, { fixedTime: FIXED, errors, who: 'student' })
    await uiLogin(page, 'a@u8.e2e.kr')
    await page.goto(BASE + '/teacher/timetable', { waitUntil: 'load' })
    check('U8.student', '학생 계정 → /student/today로', await waitUrl(page, /\/student\/today/, 15000), page.url().replace(BASE, ''))
    await ctx.close()
  }

  await sleep(500)
  const pageErrors = errors.filter((e) => e.kind === 'pageerror')
  const consoleErrors = errors.filter((e) => e.kind === 'console.error')
  check('U8.no-pageerror', '페이지 오류(pageerror) 0', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)))
  check('U8.no-console-error', '콘솔 오류(console.error) 0', consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 3)))
} catch (e) {
  check('crash', '시나리오 실행 중 예외', false, String(e?.stack || e).slice(0, 500))
} finally {
  await browser.close()
}
note('errors', `수집한 오류 ${errors.length}건(내용은 results.json)`)
const failed = finish({ errors })
process.exit(failed ? 1 : 0)
