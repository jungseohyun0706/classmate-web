// U3 초대 수락·로그인 복구·설치 안내 E2E (지시서 9·10장 / R02·R14·R15·R17 / T02·T04·T05·T07·T08·T09·T10·T42·T44·T46)
// 실행 전제: 실제 Next 서버(BASE, 기본 http://127.0.0.1:3100, NEXT_PUBLIC_USE_EMULATORS=1)
//           + Firebase 에뮬레이터(Firestore 8080, Auth 9099) + NEIS mock(NODE_OPTIONS="--require tests/support/neis-mock.cjs", NEIS_MOCK_FILE)
// 사용: node tests/e2e/u3-invite-install.e2e.mjs [label]
// 모든 데이터는 에뮬레이터의 테스트용 가상 데이터이며 실제 학생 정보가 아닙니다.
// 브라우저 시각은 2026-10-06(화) 09:30 KST로 고정합니다(서버는 실제 시각 — 초대 만료·학기 판정은 서버 시각 기준).
import crypto from 'crypto'
import { admin, wipe, createUsers, writeNeisFixture, clientSession, api, reporter, launchBrowser, newPage, uiLogin, Timestamp, BASE, PW } from './lib/env.mjs'

const LABEL = process.argv[2] || 'u3-invite-install'
const { OUT, check, note, finish } = reporter(LABEL)
const FIXED = '2026-10-06T09:30:00+09:00'

// uid는 HTML·콘솔 검사(T46)에서 다른 글자와 우연히 겹치지 않게 드문 문자열로 둡니다.
const U = { hr: 'tchrH4w9', ty: 'tchrY7q2', a: 'stuA8x3k', c: 'stuC5m1z', secret: 'stuS9v6p', np: 'nopfK7r2' }
const S1 = { schoolCode: 'S1', schoolName: '테스트고등학교', officeCode: 'B10' }
const COURSE_ID = 'engB'
const CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/
// 스토어 앱 버튼·문구(저장소에 실제 스토어 주소가 없으므로 어디에도 나오면 안 됨)
const STORE_RE = /Google Play|App Store|앱스토어|앱 스토어|플레이 ?스토어|Play 스토어|출시 예정|준비 중|스토어에서 검색/
const fmt = (c) => `${c.slice(0, 4)}-${c.slice(4)}`

/** 서버 시각 기준 지금 학기 id(서버 defaultTermFor와 같은 규칙) — 수업이 '지난 학기'로 판정되지 않게 */
function termIdNow() {
  const d = new Date(Date.now() + 9 * 3600 * 1000)
  const y = d.getUTCFullYear()
  const md = String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0')
  if (md >= '0301' && md < '0816') return `${y}-1`
  return `${md < '0301' ? y - 1 : y}-2`
}

async function seed() {
  await wipe()
  writeNeisFixture({
    schools: [{ SD_SCHUL_CODE: 'S1', SCHUL_NM: '테스트고등학교', SCHUL_KND_SC_NM: '고등학교', ATPT_OFCDC_SC_CODE: 'B10' }],
    meals: [],
    timetables: {},
    schedule: [],
  })
  const St = (name, studentId) => ({
    role: 'student',
    status: 'approved',
    name,
    displayName: name,
    classId: 'S1_3_4',
    grade: 3,
    classNm: 4,
    studentId,
    ...S1,
  })
  await createUsers([
    { uid: U.hr, email: 'hr4@e2e.kr', doc: { role: 'teacher', name: '김담임', displayName: '김담임', classId: 'S1_3_4', grade: 3, classNm: 4, ...S1 } },
    { uid: U.ty, email: 'ty@e2e.kr', doc: { role: 'teacher', name: '이영어', displayName: '이영어', ...S1 } }, // 교사 Y
    { uid: U.a, email: 'a@e2e.kr', doc: St('김학생', 7) }, // 학생 A: 3학년 4반 승인
    { uid: U.c, email: 'c@e2e.kr', doc: St('정학생', 9) },
    { uid: U.secret, email: 'secret@e2e.kr', doc: St('박비밀', 11) }, // 화면에 나오면 안 되는 다른 학생
  ])
  const { db } = admin()
  const now = Timestamp.now()
  await db.doc('classes/S1_3_4').set({ classId: 'S1_3_4', grade: 3, classNm: 4, teacherId: U.hr, teacherName: '김담임', createdAt: now, ...S1 })
  // 교사 Y의 영어 B 수업(초대하면 바로 참여 — invitePolicy 'auto')
  await db.doc(`schools/S1/courses/${COURSE_ID}`).set({
    schoolCode: 'S1',
    termId: termIdNow(),
    title: '영어 B',
    subject: '영어',
    section: 'B',
    teacherUids: [U.ty],
    teacherNames: ['이영어'],
    status: 'active',
    endedOn: null,
    commonForHomerooms: [],
    defaultRoomName: '3학년 5반 교실',
    invitePolicy: 'auto',
    createdAt: now,
    updatedAt: now,
  })
}

const browser = await launchBrowser()
const allConsole = [] // T46: 모든 화면의 콘솔 메시지(오류뿐 아니라 전부)
const allErrors = []
const contexts = []

async function openCtx(who) {
  const { ctx, page } = await newPage(browser, { fixedTime: FIXED, errors: allErrors, who })
  page.on('console', (m) => allConsole.push({ who, text: m.text() }))
  contexts.push(ctx)
  return { ctx, page }
}

const bodyText = (page) => page.locator('body').innerText()

async function waitText(page, text, timeout = 20000) {
  try {
    await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout })
    return true
  } catch {
    return false
  }
}

async function loginOnForm(page, email) {
  await page.waitForFunction(() => document.documentElement.getAttribute('data-hydrated') === '1', null, { timeout: 15000 }).catch(() => {})
  await page.fill('input[type=email]', email)
  await page.fill('input[type=password]', PW)
  await page.locator('button[type=submit]:visible').first().click()
}

async function pendingInvite(page) {
  const raw = await page.evaluate(() => window.localStorage.getItem('cm_pending_invite_v1'))
  try {
    return raw ? JSON.parse(raw) : null
  } catch {
    return { broken: raw }
  }
}

try {
  await seed()
  const { db, auth } = admin()

  // ───── 교사 Y: 영어 B 수업 초대 3개(정상 / 회수용 / 만료용) ─────
  const ty = await clientSession('ty@e2e.kr')
  const mk = () => api('/api/invitations', ty.token, { action: 'create', type: 'course', targetId: COURSE_ID })
  const [c1, c2, c3] = [await mk(), await mk(), await mk()]
  const CODE = c1.j.code
  const CODE_REVOKED = c2.j.code
  const CODE_EXPIRED = c3.j.code
  check(
    'setup',
    '교사 Y가 영어 B 수업 초대 3개 생성(API)',
    [c1, c2, c3].every((r) => r.status === 200 && CODE_RE.test(r.j.code || '')),
    [c1, c2, c3].map((r) => `${r.status}${r.status === 200 ? '' : ' ' + r.j.code}`).join(' / ')
  )
  const rv = await api('/api/invitations', ty.token, { action: 'revoke', code: CODE_REVOKED })
  await db.doc(`invitations/${CODE_EXPIRED}`).update({ expiresAt: Timestamp.fromMillis(Date.now() - 60 * 1000) })
  check('setup', '두 번째 초대 회수, 세 번째 초대 만료 처리', rv.status === 200 && rv.j.revoked === true, `${rv.status}`)
  await ty.close()

  // ───── T08 + T04: 로그아웃 상태로 초대 열기 → 로그인 → 자동 복귀 → 참여 → 내 시간표 ─────
  {
    const { page } = await openCtx('T08-studentA')
    const previewBodies = []
    page.on('response', async (res) => {
      if (res.url().includes('/api/invitations')) previewBodies.push(await res.text().catch(() => ''))
    })
    await page.goto(`${BASE}/i/${CODE}`, { waitUntil: 'load' })
    const shown = await waitText(page, '영어 B')
    let t = await bodyText(page)
    check(
      'T08',
      '로그아웃 상태 /i/CODE: 수업 초대·학교·담당 교사·초대 코드 표시',
      shown && t.includes('수업 초대') && t.includes('테스트고등학교') && t.includes('이영어') && t.includes(fmt(CODE)),
      t.slice(0, 200).replace(/\s+/g, ' ')
    )
    check('T04', '수업 초대 설명: 원래 학급은 그대로, 이 수업만 내 시간표에 추가', t.includes('원래 학급은 그대로') && !t.includes('담임 승인 필요'))
    const infoBox = await page.getByRole('region', { name: '초대 정보' }).boundingBox()
    const installLink = page.getByRole('link', { name: '설치 안내' })
    const installBox = await installLink.boundingBox().catch(() => null)
    check('T44', '초대 정보 카드가 설치 안내보다 위(설치 안내에 묻히지 않음)', !!infoBox && !!installBox && infoBox.y < installBox.y, JSON.stringify({ info: infoBox?.y, install: installBox?.y }))
    check('T09', "초대 화면의 설치 안내 링크 → /install?code=CODE", (await installLink.getAttribute('href').catch(() => '')) === `/install?code=${CODE}`)
    const saved = await pendingInvite(page)
    check(
      'T08',
      '로그인 전 초대 코드만 보관(localStorage cm_pending_invite_v1 = {code, savedAt})',
      saved && saved.code === CODE && Object.keys(saved).sort().join(',') === 'code,savedAt',
      JSON.stringify(saved && Object.keys(saved))
    )
    // T46: 비로그인 화면 HTML·미리보기 응답에 학생 명단·uid 없음
    const html = await page.content()
    const leak = [U.a, U.c, U.secret, U.ty, U.hr, '박비밀', '정학생', '김학생', 'issuedBy', 'teacherUids'].filter((x) => html.includes(x))
    check('T46', '/i/CODE 페이지 HTML에 학생 이름·uid·관리 필드 없음', leak.length === 0, leak.join(','))
    const pvLeak = previewBodies.filter((b) => [U.a, U.ty, U.secret, '박비밀', 'issuedBy', '"uses"'].some((x) => b.includes(x)))
    check('T46', '미리보기 응답에 명단·uid·사용 수 없음', previewBodies.length > 0 && pvLeak.length === 0, `응답 ${previewBodies.length}개`)

    await page.getByRole('link', { name: '로그인하고 참여' }).click()
    await page.waitForURL(/\/auth\/login\?/, { timeout: 15000 })
    check('T08', "'로그인하고 참여' → /auth/login?next=/i/CODE", new URL(page.url()).searchParams.get('next') === `/i/${CODE}`, page.url().replace(BASE, ''))
    check('T08', '로그인 화면에 초대로 돌아간다는 안내와 코드', await waitText(page, '받은 초대로 돌아가서', 8000))
    await loginOnForm(page, 'a@e2e.kr')
    let back = true
    await page.waitForURL(new RegExp(`/i/${CODE}$`), { timeout: 25000 }).catch(() => (back = false))
    check('T08', '로그인 후 자동으로 /i/CODE로 돌아옴(next)', back, page.url().replace(BASE, ''))
    const joinBtn = page.getByRole('button', { name: '이 계정으로 참여' })
    await joinBtn.waitFor({ timeout: 20000 })
    t = await bodyText(page)
    check('T08', '로그인 계정 이메일 표시 + 이 계정으로 참여·다른 계정으로', t.includes('a@e2e.kr') && t.includes('다른 계정으로'))
    check('T04', '이미 학생인 계정의 수업 초대에는 이름 입력칸 없음', (await page.getByLabel('이름').count()) === 0)
    await joinBtn.click()
    const enrolled = await waitText(page, '영어 B 수업이 내 시간표에 추가됐어요')
    check('T04', "참여 → '영어 B 수업이 내 시간표에 추가됐어요'(enrolled)", enrolled, (await bodyText(page)).slice(0, 200).replace(/\s+/g, ' '))
    check('T08', '참여 완료 후 보관한 초대를 지움', (await pendingInvite(page)) === null)
    const uA = (await db.doc(`users/${U.a}`).get()).data() || {}
    check(
      'T04',
      '학생 A 소속 유지: users.classId S1_3_4·3학년 4반·승인(수업으로 바뀌지 않음)',
      uA.classId === 'S1_3_4' && uA.grade === 3 && uA.classNm === 4 && uA.status === 'approved',
      JSON.stringify({ classId: uA.classId, grade: uA.grade, classNm: uA.classNm, status: uA.status })
    )
    const eA = (await db.doc(`schools/S1/enrollments/${COURSE_ID}__${U.a}`).get()).data()
    check('T02', '수강 문서 courseId__uid: active·source invite', eA?.status === 'active' && eA?.source === 'invite', JSON.stringify(eA && { s: eA.status, src: eA.source }))
    await page.getByRole('link', { name: '내 시간표 보기' }).click()
    await page.waitForURL(/\/student\/timetable/, { timeout: 15000 }).catch(() => {})
    check('T04', "'내 시간표 보기' → /student/timetable", /\/student\/timetable/.test(page.url()), page.url().replace(BASE, ''))
    await page.screenshot({ path: `${OUT}/T04-after-join.png`, fullPage: true }).catch(() => {})

    // ── T05: 같은 초대를 다시 열어 더블 탭 → 이미 참여(같은 결과, 사용 수 1)
    await page.goto(`${BASE}/i/${CODE}`, { waitUntil: 'load' })
    const again = page.getByRole('button', { name: '이 계정으로 참여' })
    await again.waitFor({ timeout: 20000 })
    await again.dblclick()
    const already = await waitText(page, '이미 참여 중인 수업이에요')
    check('T05', "다시 열어 참여(더블 탭) → '이미 참여 중인 수업이에요'", already, (await bodyText(page)).slice(0, 200).replace(/\s+/g, ' '))
    const inv = (await db.doc(`invitations/${CODE}`).get()).data() || {}
    const uses = (await db.collection(`invitations/${CODE}/uses`).get()).size
    const enrs = (await db.collection('schools/S1/enrollments').where('uid', '==', U.a).get()).docs.filter((d) => d.get('courseId') === COURSE_ID)
    check('T05', '사용 수 1·사용 기록 1·수강 문서 1개(중복 없음)', inv.uses === 1 && uses === 1 && enrs.length === 1, `uses=${inv.uses}/${uses} enr=${enrs.length}`)
    const uA2 = (await db.doc(`users/${U.a}`).get()).data() || {}
    check('T05', '두 번째 참여 뒤에도 소속 S1_3_4 그대로', uA2.classId === 'S1_3_4' && uA2.status === 'approved')

    // ── T07: 회수·만료·없는 코드·형식 오류를 각각 다른 문구로, 만료와 회수를 섞지 않음
    await page.goto(`${BASE}/i/${CODE_REVOKED}`, { waitUntil: 'load' })
    const revokedShown = await waitText(page, '선생님이 회수한 초대예요')
    t = await bodyText(page)
    check(
      'T07',
      "회수된 코드 → '선생님이 회수한 초대예요' + 새 초대 요청 안내(만료 문구 아님)",
      revokedShown && t.includes('선생님께 새 초대를 요청하세요') && !t.includes('만료') && !t.includes('기간이 지났'),
      t.slice(0, 200).replace(/\s+/g, ' ')
    )
    check('T07', '회수된 초대에는 참여 버튼 없음', (await page.getByRole('button', { name: '이 계정으로 참여' }).count()) === 0)
    await page.goto(`${BASE}/i/${CODE_EXPIRED}`, { waitUntil: 'load' })
    const expiredShown = await waitText(page, '초대 기간이 지났어요')
    t = await bodyText(page)
    check('T07', "만료된 코드 → '초대 기간이 지났어요'(회수 문구 아님)", expiredShown && !t.includes('회수'), t.slice(0, 160).replace(/\s+/g, ' '))
    let missing = 'ABCD2345'
    while (missing === CODE || missing === CODE_REVOKED || missing === CODE_EXPIRED) missing = 'WXYZ6789'
    await page.goto(`${BASE}/i/${missing}`, { waitUntil: 'load' })
    check('T07', "없는 코드 → '초대 코드를 찾을 수 없어요'", await waitText(page, '초대 코드를 찾을 수 없어요'))
    await page.goto(`${BASE}/i/hello`, { waitUntil: 'load' })
    check('T07', "형식이 틀린 코드 → '초대 코드 형식이 올바르지 않아요'", await waitText(page, '초대 코드 형식이 올바르지 않아요'))

    // ── R15/T07: 네트워크 오류·5xx는 '만료'·'없음'으로 보이지 않고 다시 시도
    await page.route('**/api/invitations', (route) => route.abort('failed'))
    await page.goto(`${BASE}/i/${CODE}`, { waitUntil: 'load' })
    const netShown = await waitText(page, '초대 정보를 불러오지 못했어요')
    t = await bodyText(page)
    check(
      'T07',
      "네트워크 오류 → '초대 정보를 불러오지 못했어요' + 다시 시도(만료·없음 문구 아님)",
      netShown && (await page.getByRole('button', { name: '다시 시도' }).count()) === 1 && !t.includes('기간이 지났') && !t.includes('찾을 수 없어요') && !t.includes('만료'),
      t.slice(0, 160).replace(/\s+/g, ' ')
    )
    await page.unroute('**/api/invitations')
    await page.route('**/api/invitations', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'x', code: 'server-error' }) })
    )
    await page.getByRole('button', { name: '다시 시도' }).click()
    check('T07', "서버 오류(500) → '(오류 500)' + 다시 시도", await waitText(page, '오류 500'))
    await page.unroute('**/api/invitations')
    await page.getByRole('button', { name: '다시 시도' }).click()
    check('T07', "'다시 시도' → 초대 정보 다시 표시", await waitText(page, '이 계정으로 참여'))
  }

  // ───── T10: 교사 계정으로 로그인된 상태에서 학생 초대 참여 → teacher-account 안내 → 다른 계정으로 ─────
  {
    const { page } = await openCtx('T10-teacher')
    await uiLogin(page, 'ty@e2e.kr')
    await page.goto(`${BASE}/i/${CODE}`, { waitUntil: 'load' })
    const btn = page.getByRole('button', { name: '이 계정으로 참여' })
    await btn.waitFor({ timeout: 20000 })
    check('T10', '교사 계정 이메일 표시', (await bodyText(page)).includes('ty@e2e.kr'))
    await btn.click()
    const blocked = await waitText(page, '교사 계정은 학생 초대를 수락할 수 없어요')
    check('T10', "참여 → '교사 계정은 학생 초대를 수락할 수 없어요' + '다른 계정으로'", blocked && (await page.getByRole('button', { name: '다른 계정으로' }).count()) === 1)
    const e = (await db.doc(`schools/S1/enrollments/${COURSE_ID}__${U.ty}`).get()).exists
    const tDoc = (await db.doc(`users/${U.ty}`).get()).data() || {}
    check('T10', '교사 계정에 수강·학생 역할이 생기지 않음', !e && tDoc.role === 'teacher')
    await page.getByRole('button', { name: '다른 계정으로' }).click()
    const out = await waitText(page, '로그인하고 참여')
    const saved = await pendingInvite(page)
    check('T10', "'다른 계정으로' → 로그아웃 후 같은 화면(로그인하고 참여), 초대 코드 유지", out && /\/i\//.test(page.url()) && saved?.code === CODE, JSON.stringify(saved && saved.code === CODE))
    // 다른(학생) 계정으로 로그인 → 같은 초대로 돌아옴
    await page.getByRole('link', { name: '로그인하고 참여' }).click()
    await page.waitForURL(/\/auth\/login\?/, { timeout: 15000 })
    await loginOnForm(page, 'c@e2e.kr')
    let back = true
    await page.waitForURL(new RegExp(`/i/${CODE}$`), { timeout: 25000 }).catch(() => (back = false))
    check('T10', '학생 계정으로 다시 로그인 → 같은 초대로 복귀하고 그 계정 이메일 표시', back && (await waitText(page, 'c@e2e.kr', 15000)))
  }

  // ───── T09: 설치 화면 + 코드 입력 경로 + 저장된 초대 자동 복구 경로 ─────
  {
    const { page } = await openCtx('T09-install')
    await page.goto(`${BASE}/install?code=${CODE}`, { waitUntil: 'load' })
    const shown = await waitText(page, '받은 초대가 있어요')
    const t = await bodyText(page)
    check(
      'T09',
      '/install?code=: 초대 코드(XXXX-XXXX)와 설치 후 코드 입력 안내',
      shown && t.includes(fmt(CODE)) && t.includes('설치 후 앱을 열고 이 초대 코드를 입력하세요'),
      t.slice(0, 200).replace(/\s+/g, ' ')
    )
    const reopen = page.getByRole('link', { name: '원래 초대 링크 다시 열기' })
    check('T09', "'원래 초대 링크 다시 열기' → /i/CODE, 복사 버튼", (await reopen.getAttribute('href').catch(() => '')) === `/i/${CODE}` && (await page.getByRole('button', { name: '복사', exact: true }).count()) === 1)
    check('T09', 'iOS는 Safari와 홈 화면 앱 저장 공간이 따로라 자동으로 이어지지 않을 수 있다고 안내', t.includes('저장 공간이 따로'))
    check('T44', '설치 화면에 스토어 버튼·출시 예정·스토어 검색 문구 없음', !STORE_RE.test(t), (STORE_RE.exec(t) || [''])[0])
    check('T44', '설치 화면에 앱 이름·아이콘', t.includes('클래스메이트') && (await page.locator('img[src="/icons/icon-192.png"]').count()) > 0)
    await page.screenshot({ path: `${OUT}/T09-install.png`, fullPage: true }).catch(() => {})

    // 랜딩: 스토어 장식 버튼 대신 설치 안내·초대 코드 입력
    await page.goto(`${BASE}/`, { waitUntil: 'load' })
    await waitText(page, '앱 설치 안내')
    const lt = await bodyText(page)
    check('T44', "랜딩에 '앱 설치 안내'(/install)와 초대 코드 입력, 스토어 문구 없음", (await page.getByRole('link', { name: '앱 설치 안내' }).getAttribute('href')) === '/install' && !STORE_RE.test(lt), (STORE_RE.exec(lt) || [''])[0])
    await page.waitForFunction(() => document.documentElement.getAttribute('data-hydrated') === '1', null, { timeout: 15000 }).catch(() => {})
    const input = page.getByLabel('초대 코드')
    await input.fill('zz')
    await input.press('Enter')
    check('T09', '형식이 틀린 코드 입력 → 안내 문구(이동하지 않음)', (await waitText(page, '8자리', 5000)) && new URL(page.url()).pathname === '/')
    await input.fill(`${CODE.slice(0, 4).toLowerCase()} - ${CODE.slice(4).toLowerCase()}`)
    check('T09', '입력 중 대문자·하이픈 자동 정리', (await input.inputValue()) === fmt(CODE), await input.inputValue())
    await input.press('Enter')
    let went = true
    await page.waitForURL(new RegExp(`/i/${CODE}$`), { timeout: 15000 }).catch(() => (went = false))
    check('T09', '초대 코드 입력 경로: 랜딩에서 코드 입력 → /i/CODE', went && (await waitText(page, '영어 B')), page.url().replace(BASE, ''))
  }
  {
    // 자동 복구 경로: 초대를 연 브라우저에서 next 없이 로그인해도 보관한 초대로 돌아옴
    const { page } = await openCtx('T09-resume')
    await page.goto(`${BASE}/i/${CODE}`, { waitUntil: 'load' })
    await waitText(page, '로그인하고 참여')
    await page.goto(`${BASE}/auth/login`, { waitUntil: 'load' })
    check('T09', '보관한 초대가 있으면 로그인 화면에 초대 코드 안내', await waitText(page, fmt(CODE), 8000))
    await loginOnForm(page, 'secret@e2e.kr')
    let back = true
    await page.waitForURL(new RegExp(`/i/${CODE}$`), { timeout: 25000 }).catch(() => (back = false))
    check('T09', '자동 복구 경로: next 없이 로그인해도 보관한 초대(/i/CODE)로 이동', back, page.url().replace(BASE, ''))
  }
  // ───── R14: 프로필 없는 계정(교사 인증·학생 초대 수락 전) + 보관된 초대 ─────
  // next 없이 로그인하면 초대로 자동 이동하지 않고 학생(받은 초대로 이어서 참여)/선생님(교사 인증) 갈래 화면
  // (구글로 처음 로그인한 선생님이 이 브라우저에 남은 초대 때문에 교사 인증으로 갈 수 없던 문제).
  // 초대 화면에서 '로그인하고 참여'(?next=/i/CODE)로 온 경우만 지금처럼 그 초대로 이어감.
  {
    await createUsers([{ uid: U.np, email: 'np@e2e.kr' }]) // Auth 계정만(구글로 처음 로그인한 선생님과 같은 상태)
    const { page } = await openCtx('R14-noprofile')
    await page.goto(`${BASE}/i/${CODE}`, { waitUntil: 'load' })
    await waitText(page, '로그인하고 참여')
    await page.goto(`${BASE}/auth/login`, { waitUntil: 'load' })
    await waitText(page, fmt(CODE), 8000)
    await loginOnForm(page, 'np@e2e.kr')
    const chose = await waitText(page, '가입이 아직 끝나지 않았어요', 20000)
    check(
      'R14',
      '프로필 없는 계정 + 보관된 초대, next 없이 로그인 → 초대로 자동 이동하지 않고 학생/선생님 갈래 화면',
      chose && new URL(page.url()).pathname === '/auth/login',
      page.url().replace(BASE, '')
    )
    const resume = page.getByRole('link', { name: new RegExp(`받은 초대로 이어서 참여\\s*\\(${fmt(CODE)}\\)`) })
    check('R14', "갈래 화면 학생 쪽: '받은 초대로 이어서 참여 (XXXX-XXXX)' → /i/CODE", (await resume.getAttribute('href').catch(() => '')) === `/i/${CODE}`)
    const teacherBtn = page.getByRole('button', { name: '교사 인증 코드 입력하기' })
    check('R14', "갈래 화면 선생님 쪽: '교사 인증 코드 입력하기'", (await teacherBtn.count()) === 1)
    await teacherBtn.click()
    check('R14', '교사 인증 → 교사 인증 코드 단계(처음 오셨네요)', (await waitText(page, '처음 오셨네요', 8000)) && (await page.getByLabel('교사 인증 코드').count()) === 1)
    check('R14', '갈래·교사 인증 단계를 거쳐도 학생 프로필이 생기지 않음', !(await db.doc(`users/${U.np}`).get()).exists)
    // '다른 계정으로 로그인'(로그아웃) → 초대 화면 '로그인하고 참여'(?next=/i/CODE) → 같은 계정 → 초대로 이어감
    await page.getByRole('button', { name: '다른 계정으로 로그인' }).click()
    await page.locator('input[type=email]').waitFor({ timeout: 10000 })
    await page.goto(`${BASE}/i/${CODE}`, { waitUntil: 'load' })
    await page.getByRole('link', { name: '로그인하고 참여' }).click()
    await page.waitForURL(/\/auth\/login\?/, { timeout: 15000 })
    await loginOnForm(page, 'np@e2e.kr')
    let back = true
    await page.waitForURL(new RegExp(`/i/${CODE}$`), { timeout: 25000 }).catch(() => (back = false))
    check(
      'R14',
      "초대 화면에서 '로그인하고 참여'(next=/i/CODE)로 온 프로필 없는 계정은 지금처럼 초대로 이어감",
      back && (await waitText(page, 'np@e2e.kr', 15000)),
      page.url().replace(BASE, '')
    )
  }
  {
    // iOS Safari UA: 자동 설치 버튼 없이 '공유 → 홈 화면에 추가' 단계
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    })
    contexts.push(ctx)
    const page = await ctx.newPage()
    page.on('console', (m) => allConsole.push({ who: 'T44-ios', text: m.text() }))
    await page.goto(`${BASE}/install`, { waitUntil: 'load' })
    const ok = await waitText(page, 'iPhone·iPad (Safari)')
    const t = await bodyText(page)
    check('T44', "iOS Safari: '공유 버튼 → 홈 화면에 추가' 단계, 자동 설치 버튼 없음", ok && t.includes('홈 화면에 추가') && t.includes('공유 버튼') && (await page.getByRole('button', { name: '설치', exact: true }).count()) === 0)
    await page.screenshot({ path: `${OUT}/T44-ios-install.png`, fullPage: true }).catch(() => {})
  }
  note('T44', "Android Chrome의 '설치' 버튼(beforeinstallprompt)·standalone('앱에서 열려 있어요')은 headless에서 재현할 수 없어 실기기 확인 필요")

  // ───── T02: 처음 온 학생 — 초대에서 가입 → 초대로 복귀 → 이름 입력 → 참여(소속 없는 학생 프로필 + 수강) ─────
  {
    const { page } = await openCtx('T02-new')
    await page.goto(`${BASE}/i/${CODE}`, { waitUntil: 'load' })
    await page.getByRole('link', { name: '처음이에요 (가입)' }).click()
    await page.waitForURL(/\/auth\/register\?/, { timeout: 15000 })
    check('T02', '가입 화면이 학생 가입으로 열리고 초대 코드 안내', await waitText(page, '학생 계정 만들기'))
    await page.getByLabel('이름').fill('최새싹')
    await page.getByLabel('이메일').fill('new02@e2e.kr')
    await page.getByLabel('비밀번호').fill(PW)
    await page.getByRole('button', { name: '가입하고 초대로 돌아가기' }).click()
    let back = true
    await page.waitForURL(new RegExp(`/i/${CODE}$`), { timeout: 25000 }).catch(() => (back = false))
    check('T02', '가입 후 /i/CODE로 돌아옴', back, page.url().replace(BASE, ''))
    const nameInput = page.getByLabel('이름')
    await nameInput.waitFor({ timeout: 20000 }).catch(() => {})
    check('T02', '프로필 없는 계정의 수업 초대 → 이름 입력칸(가입 때 이름으로 채움)', (await nameInput.inputValue().catch(() => '')) === '최새싹')
    await page.getByRole('button', { name: '이 계정으로 참여' }).click()
    check('T02', '참여 → 수업 추가 결과 + 소속 학급 없음 안내', (await waitText(page, '영어 B 수업이 내 시간표에 추가됐어요')) && (await waitText(page, '아직 소속 학급은 없어요', 5000)))
    const nu = await auth.getUserByEmail('new02@e2e.kr')
    const ud = (await db.doc(`users/${nu.uid}`).get()).data() || {}
    const en = (await db.doc(`schools/S1/enrollments/${COURSE_ID}__${nu.uid}`).get()).data()
    check(
      'T02',
      '새 학생 uid의 프로필(role student, classId null, 이름) + 수강 active',
      ud.role === 'student' && ud.classId === null && ud.name === '최새싹' && en?.status === 'active',
      JSON.stringify({ role: ud.role, classId: ud.classId, name: ud.name === '최새싹', enr: en?.status })
    )
  }

  // ───── T42: 기존 /join?c=&t= 링크 호환 ─────
  {
    const tok = crypto.randomBytes(16).toString('hex')
    await db.doc(`classes/S1_3_4/joinTokens/${tok}`).set({ createdAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 10 * 60 * 1000) })
    const { page } = await openCtx('T42-join')
    await page.goto(`${BASE}/join?c=S1_3_4&t=${tok}`, { waitUntil: 'load' })
    const shown = await waitText(page, '3학년 4반')
    check('T42', '기존 /join?c=&t= 링크: 학교·반·담임 표시', shown && (await bodyText(page)).includes('테스트고등학교') && (await bodyText(page)).includes('김담임'))
    await page.getByLabel('이름').fill('한신입')
    await page.getByLabel('이메일').fill('new42@e2e.kr')
    await page.getByLabel('비밀번호').fill(PW)
    await page.getByRole('button', { name: '계정 만들고 계속하기' }).click()
    const confirm = page.getByRole('button', { name: '입장 신청하기' })
    await confirm.waitFor({ timeout: 20000 })
    check('T42', '같은 탭에서 가입 → 확인 카드에 신청할 계정 이메일 표시', (await bodyText(page)).includes('new42@e2e.kr'))
    await confirm.click()
    check('T42', "입장 신청 → '선생님 승인을 기다리고 있어요'", await waitText(page, '선생님 승인을 기다리고 있어요'))
    const nu = await auth.getUserByEmail('new42@e2e.kr')
    const ud = (await db.doc(`users/${nu.uid}`).get()).data() || {}
    check('T42', '학급 신청 기록: classId S1_3_4·status pending·이름', ud.classId === 'S1_3_4' && ud.status === 'pending' && ud.name === '한신입', JSON.stringify({ c: ud.classId, s: ud.status }))

    // 만료·없는 토큰·네트워크 오류를 구분(네트워크 오류를 만료로 보이지 않음)
    const old = crypto.randomBytes(16).toString('hex')
    const createdAt = Timestamp.fromMillis(Date.now() - 11 * 60 * 1000)
    await db.doc(`classes/S1_3_4/joinTokens/${old}`).set({ createdAt, expiresAt: Timestamp.fromMillis(createdAt.toMillis() + 10 * 60 * 1000) })
    const { page: p2 } = await openCtx('T42-errors')
    await p2.goto(`${BASE}/join?c=S1_3_4&t=${old}`, { waitUntil: 'load' })
    check('T42', "만료된 토큰 → '입장 코드가 만료되었어요' + 새 QR 요청 안내", (await waitText(p2, '입장 코드가 만료되었어요')) && (await bodyText(p2)).includes('새 코드 만들기'))
    await p2.goto(`${BASE}/join?c=S1_3_4&t=${crypto.randomBytes(16).toString('hex')}`, { waitUntil: 'load' })
    const nf = await waitText(p2, '입장 코드를 찾을 수 없어요')
    check('T42', "없는 토큰 → '입장 코드를 찾을 수 없어요'(만료 문구 아님)", nf && !(await bodyText(p2)).includes('만료'))
    await p2.goto(`${BASE}/join?c=S1_3_4`, { waitUntil: 'load' })
    check('T42', "토큰 없는 링크 → '입장 링크가 올바르지 않아요'", await waitText(p2, '입장 링크가 올바르지 않아요'))
    await p2.route('**/api/join-info', (route) => route.abort('failed'))
    await p2.goto(`${BASE}/join?c=S1_3_4&t=${tok}`, { waitUntil: 'load' })
    const net = await waitText(p2, '입장 코드를 확인하지 못했어요')
    const nt = await bodyText(p2)
    check('T42', "네트워크 오류 → '확인하지 못했어요' + 다시 시도(만료 문구 아님)", net && !nt.includes('만료') && (await p2.getByRole('button', { name: '다시 시도' }).count()) === 1)
    await p2.unroute('**/api/join-info')
  }

  // ───── T46: 콘솔에 초대 코드·입장 토큰·uid·다른 학생 이름 없음 ─────
  {
    const secrets = [CODE, CODE_REVOKED, CODE_EXPIRED, fmt(CODE), U.a, U.c, U.secret, U.ty, U.hr, '박비밀']
    const hits = allConsole.filter((m) => secrets.some((s) => m.text.includes(s)))
    check('T46', '모든 화면 콘솔에 초대 코드·uid·다른 학생 이름이 찍히지 않음', hits.length === 0, hits.slice(0, 3).map((h) => `${h.who}: ${h.text.slice(0, 80)}`).join(' | '))
    note('T46', `콘솔 메시지 ${allConsole.length}개, 페이지 오류 ${allErrors.filter((e) => e.kind === 'pageerror').length}개`)
  }
} catch (e) {
  check('X', 'U3 시나리오 예외', false, e && e.stack)
} finally {
  for (const c of contexts) await c.close().catch(() => {})
  await browser.close()
}
process.exit(finish({ errors: allErrors.slice(0, 50) }) ? 1 : 0)
