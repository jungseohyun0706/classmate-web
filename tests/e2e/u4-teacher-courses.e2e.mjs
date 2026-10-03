// U4 교사 수업 관리 화면 E2E (요구 문서 5절 / 지시서 4·5·9-1·12장)
// 덮는 항목: T03 T04 T06 T07 T13 T24 T32 T39 · R04 R05 R06 R09 R16
// 흐름: 교사 Y 로그인 → 수업 만들기(영어 B) → 차시 추가(화 3교시, 3학년 5반 교실) → 수업 초대(코드·QR·링크, 사용 0)
//       → 학생 A·B가 API로 수락 → 사용 2·수강생 2(T06) → 수강 종료(T24) → 회수 → 회수 상태·수락 거부(T07)
//       담임 X(S1_3_4): '학급 시간표 → 공통 수업'(T03), 공통 수업 후보 확인·해제(T32), 다른 학교·같은 학교 다른 교사 직접 열기(R16·T39)
//       검토 라운드 2(R2-*): 차시 추가 전 영향 확인·지난 날짜 막기(22), 겹침 확인 뒤 입력 변경 시 확인 무효(9·19),
//       목록 인원은 list counts만(get 호출 없음, 20), 종료 예정 수업은 운영 중처럼(8), 담임 반 확인 성공 시 공통 수업 버튼(12·21)
// 실행 전제: 실제 서버(BASE, 기본 http://127.0.0.1:3100) + Firebase 에뮬레이터(Firestore 8080, Auth 9099)
//           + NEIS mock(NODE_OPTIONS="--require tests/support/neis-mock.cjs", NEIS_MOCK_FILE)
//           + 같은 학교 교사가 schools/{s}/courses·series를 읽을 수 있는 firestore.rules(공통 수업 후보 단계)
// 사용: node tests/e2e/u4-teacher-courses.e2e.mjs
// 모든 데이터는 에뮬레이터의 테스트용 가상 데이터이며 실제 학생 정보가 아닙니다.
import { admin, wipe, createUsers, writeNeisFixture, clientSession, api, reporter, launchBrowser, newPage, uiLogin, sleep, Timestamp, BASE } from './lib/env.mjs'

const LABEL = 'u4-teacher-courses'
const { OUT, check, note, finish } = reporter(LABEL)
const FIXED = '2026-10-06T08:00:00+09:00' // 화요일 아침
const S1 = { schoolCode: 'S1', schoolName: '테스트고등학교', officeCode: 'B10' }
const S2 = { schoolCode: 'S2', schoolName: '다른고등학교', officeCode: 'B10' }
const CODE_RE = /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/
const UID_MARK = 'u4uid' // 학생 uid 접두어 — 화면에 보이면 안 됨

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
  const St = (name, classId, grade, classNm, studentId) => ({ role: 'student', status: 'approved', name, displayName: name, classId, grade, classNm, studentId, ...S1 })
  await createUsers([
    { uid: 'ty', email: 'ty@e2e.kr', doc: T('이영어') }, // 교사 Y(담임 아님)
    { uid: 'hr4', email: 'hr4@e2e.kr', doc: T('김담임', { classId: 'S1_3_4', grade: 3, classNm: 4 }) }, // 담임 X
    { uid: 'tz', email: 'tz@e2e.kr', doc: T('정교사') }, // 같은 학교, 영어 B와 무관
    { uid: 't2', email: 't2@e2e.kr', doc: T('최다른', { classId: 'S2_3_4', grade: 3, classNm: 4 }, S2) }, // 다른 학교
    { uid: `${UID_MARK}A`, email: 'a@e2e.kr', doc: St('김학생', 'S1_3_4', 3, 4, 7) },
    { uid: `${UID_MARK}B`, email: 'b@e2e.kr', doc: St('이학생', 'S1_3_5', 3, 5, 8) },
    { uid: `${UID_MARK}C`, email: 'c@e2e.kr', doc: St('박학생', 'S1_3_5', 3, 5, 9) },
  ])
  const { db } = admin()
  const now = Timestamp.now()
  await db.doc('classes/S1_3_4').set({ classId: 'S1_3_4', grade: 3, classNm: 4, teacherId: 'hr4', teacherName: '김담임', createdAt: now, ...S1 })
  await db.doc('classes/S1_3_5').set({ classId: 'S1_3_5', grade: 3, classNm: 5, teacherId: null, createdAt: now, ...S1 })
  await db.doc('classes/S2_3_4').set({ classId: 'S2_3_4', grade: 3, classNm: 4, teacherId: 't2', createdAt: now, ...S2 })
  // 3학년 4반 학급 시간표(공통 수업 만들기 원본) — 학교 시간표에는 교사·교실이 일부만 있음
  const row = (a) => [...a, '', '', '', '', '', '', ''].slice(0, 7)
  await db.doc('classes/S1_3_4/info/timetable').set({
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
      '3-4': {
        mon: grid([cell('국어', '한국어'), cell('수학', '오수학', '수학실'), cell('체육', '강체육', '운동장')]),
        tue: grid([cell('수학', '오수학', '수학실'), cell('국어', '한국어')]),
        wed: grid([cell('국어', '한국어')]),
        thu: grid([]),
        fri: grid([cell('미술', '유미술')]), // 학급 시간표(체육)와 다름 → 교사·교실 미확인
      },
    },
    teachers: {},
    periodTimes: {},
    sources: [],
  })
}

/** 문구가 화면에 나타나는지(시간 안에) — 실패해도 throw하지 않고 false */
async function seen(page, textOrRe, timeout = 15000) {
  try {
    await page.getByText(textOrRe).first().waitFor({ state: 'visible', timeout })
    return true
  } catch {
    return false
  }
}

const bodyText = (page) => page.locator('body').innerText()
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true }).catch(() => {})

async function token(email) {
  const s = await clientSession(email)
  const t = s.token
  await s.close()
  return t
}

const browser = await launchBrowser()
const errors = []
let courseId = ''
try {
  await seed()
  const { db } = admin()

  // ───────── 1. 교사 Y: 대시보드 → 수업 관리 → 수업 만들기 ─────────
  {
    const { ctx, page } = await newPage(browser, { fixedTime: FIXED, errors, who: 'ty' })
    await uiLogin(page, 'ty@e2e.kr')
    if (!/\/dashboard/.test(page.url())) await page.goto(BASE + '/dashboard', { waitUntil: 'load' })
    const tiles = []
    for (const t of ['수업 관리', '시간표 변경', '시간표 가져오기', '수강 명단 가져오기', '학생 관리']) {
      if (await seen(page, t, 10000)) tiles.push(t)
    }
    check('R05.dashboard-tiles', '대시보드에 수업 관리·시간표 변경·시간표 가져오기·수강 명단 가져오기 타일(기존 학생 관리 유지)', tiles.length === 5, tiles.join(','))
    await page.getByRole('heading', { name: '수업 관리', exact: true }).click()
    await page.waitForURL(/\/teacher\/courses$/, { timeout: 15000 })
    check('R05.courses-page', '수업 관리 화면 열림', await seen(page, '+ 새 수업 만들기'))
    check('R05.empty', '수업이 없을 때 빈 상태 안내(오류와 구분)', await seen(page, '아직 담당·관리하는 수업이 없어요'))

    await page.getByRole('button', { name: '+ 새 수업 만들기' }).click()
    await page.getByLabel('수업 이름').fill('영어 B')
    await page.getByLabel('과목', { exact: true }).fill('영어')
    await page.getByLabel('분반(선택)').fill('B')
    await page.getByLabel('기본 수업 교실').fill('3학년 5반 교실')
    await page.getByRole('button', { name: '수업 만들기', exact: true }).click()
    await page.waitForURL(/\/teacher\/courses\/[^/?#]+$/, { timeout: 20000 })
    courseId = decodeURIComponent(page.url().split('/').pop())
    const created = (await db.doc(`schools/S1/courses/${courseId}`).get()).data() || {}
    check('T04.create', '교사 Y가 수업 영어 B(분반 B, 기본 교실 3학년 5반 교실) 생성', created.title === '영어 B' && created.section === 'B' && created.defaultRoomName === '3학년 5반 교실', JSON.stringify({ title: created.title, section: created.section, room: created.defaultRoomName }))
    check('T04.detail', '수업 상세 화면(기본 정보) 표시', await seen(page, '영어 B') && (await seen(page, '바로 참여')))

    // ───────── 2. 차시 추가: 화 3교시, 수업 교실 3학년 5반 교실 ─────────
    const minFrom = await page.getByLabel('적용 시작일(선택)').getAttribute('min', { timeout: 10000 }).catch(() => null)
    check('R2-22.min-date', '차시 적용 시작일 입력의 최소값 = 오늘(학교 시간대 — 지난 날짜 선택 불가)', minFrom === '2026-10-06', String(minFrom))
    await page.getByLabel('요일').selectOption({ label: '화' })
    await page.getByLabel('교시').selectOption({ label: '3교시' })
    await page.getByLabel('수업 교실').fill('3학년 5반 교실')
    await page.getByRole('button', { name: '차시 추가', exact: true }).click()
    const dlgAdd = page.getByRole('dialog')
    const addCopy = await dlgAdd.getByText('이 수업 수강생 모두의 시간표에').waitFor({ timeout: 10000 }).then(() => true, () => false)
    check('R2-22.add-confirm', '차시 추가 전 확인 대화상자에 영향 문구(이 수업 수강생의 그날 이후 시간표가 바뀜)', addCopy)
    await dlgAdd.getByRole('button', { name: '차시 추가하기' }).click()
    await seen(page, '차시를 추가했어요')
    await sleep(1500)
    const series = (await db.collection('schools/S1/series').where('courseId', '==', courseId).get()).docs.map((d) => d.data())
    check('T13.series', '차시 저장: 화(2) 3교시, roomName=3학년 5반 교실', series.length === 1 && series[0].weekday === 2 && series[0].period === 3 && series[0].roomName === '3학년 5반 교실', JSON.stringify(series.map((s) => [s.weekday, s.period, s.roomName])))
    const seriesRow = page.locator('li').filter({ hasText: '화요일 3교시' }).filter({ hasText: '3학년 5반 교실' })
    check('T13.series-ui', "차시 목록에 '화요일 3교시 · 수업 교실 3학년 5반 교실'", (await seriesRow.count()) >= 1)
    check('R03.room-label', "교실 입력이 '수업 교실'로 학급과 구분됨", await seen(page, '학생의 소속 학급(반)과는 별개'))

    // ───────── 2-1. 겹침 확인 패널이 뜬 뒤 입력을 바꾸면 확인 무효(R2-9·19) ─────────
    // 같은 교사 Y의 다른 수업(영어 C, 월 1교시)을 미리 둠 → 영어 B 월 1교시는 교사 겹침(409 conflicts)
    await db.doc('schools/S1/courses/u4other').set({
      ...created,
      title: '영어 C',
      section: 'C',
      defaultRoomName: '영어전용실',
      commonForHomerooms: [],
      createdAt: Timestamp.now(),
    })
    await db.doc('schools/S1/series/u4other-s1').set({ courseId: 'u4other', termId: created.termId, weekday: 1, period: 1, roomName: '영어전용실', validFrom: '20260901', validTo: null, status: 'active', createdAt: Timestamp.now() })
    await page.getByLabel('요일').selectOption({ label: '월' })
    await page.getByLabel('교시').selectOption({ label: '1교시' })
    await page.getByLabel('수업 교실').fill('')
    await page.getByRole('button', { name: '차시 추가', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '차시 추가하기' }).click()
    const panelShown = await seen(page, '월요일 1교시 차시가 다른 수업과 시간이 겹쳐요')
    await page.getByLabel('교시').selectOption({ label: '2교시' })
    const ackGone = await page.getByRole('button', { name: '겹쳐도 추가' }).waitFor({ state: 'hidden', timeout: 5000 }).then(() => true, () => false)
    const redo = await seen(page, '입력을 바꿔서 겹침 확인을 취소했어요', 5000)
    await sleep(800)
    const afterChange = (await db.collection('schools/S1/series').where('courseId', '==', courseId).get()).docs.map((d) => d.data())
    check('R2-9.invalidate', "겹침 확인 패널이 뜬 뒤 교시를 바꾸면 패널이 닫히고 다시 확인 안내(보지 않은 칸이 '겹쳐도 추가'로 저장되지 않음)", panelShown && ackGone && redo && afterChange.length === 1, `panel=${panelShown} hidden=${ackGone} msg=${redo} series=${afterChange.length}`)
    // 같은 입력으로 다시 확인받으면 '겹쳐도 추가'는 그 칸(월 1교시)만 저장
    await page.getByLabel('교시').selectOption({ label: '1교시' })
    await page.getByRole('button', { name: '차시 추가', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '차시 추가하기' }).click()
    await seen(page, '월요일 1교시 차시가 다른 수업과 시간이 겹쳐요')
    await page.getByRole('button', { name: '겹쳐도 추가' }).click()
    const ackSaved = await seen(page, '겹침을 확인하고 추가했어요')
    await sleep(800)
    const afterAck = (await db.collection('schools/S1/series').where('courseId', '==', courseId).get()).docs.map((d) => d.data())
    check('R2-9.ack-same-input', "같은 입력으로 다시 확인한 뒤 '겹쳐도 추가' → 확인한 월 1교시만 저장", ackSaved && afterAck.length === 2 && afterAck.some((x) => x.weekday === 1 && x.period === 1) && !afterAck.some((x) => x.period === 2), JSON.stringify(afterAck.map((x) => [x.weekday, x.period])))

    // ───────── 3. 수업 초대 만들기: 코드·QR·링크·사용 0 ─────────
    check('T04.invite-kind', '수업 초대 문구(원래 학급은 그대로, 이 수업만 추가)', await seen(page, '수업 초대 — 원래 학급은 그대로, 이 수업만 추가'))
    await page.getByRole('button', { name: '수업 초대 코드 만들기' }).click()
    const codeShown = await seen(page, CODE_RE, 20000)
    const displayCode = codeShown ? (await page.getByText(CODE_RE).first().innerText()).trim() : ''
    const qrOk = await page.getByRole('img', { name: '수업 초대 QR 코드' }).waitFor({ timeout: 15000 }).then(() => true, () => false)
    const linkOk = await seen(page, /\/i\/[2-9A-HJKMNP-Z]{8}$/)
    check('T06.invite-created', '초대 코드(XXXX-XXXX)·QR·공유 링크 표시', codeShown && qrOk && linkOk, `code=${codeShown} qr=${qrOk} link=${linkOk}`)
    check('T06.uses0', "목록에 '사용 0명 · 인원 제한 없음'(다인용 기본)", await seen(page, '사용 0명 · 인원 제한 없음'))
    check('R09-1.target', '대상 학교·학기·수업·분반·교사 표시', (await seen(page, '테스트고등학교')) && (await seen(page, /2026학년도 [12]학기/)) && (await seen(page, '이영어')))
    await shot(page, '1-course-detail-invite')

    const invSnap = await db.collection('invitations').where('targetId', '==', courseId).get()
    const code = invSnap.docs[0]?.id || ''
    check('T06.code-match', '화면 코드 = 저장된 초대 코드', !!code && displayCode.replace('-', '') === code)
    const inv = invSnap.docs[0]?.data() || {}
    const expDays = inv.expiresAt ? Math.round((inv.expiresAt.toMillis() - inv.createdAt.toMillis()) / 86400000) : null
    check('T06.defaults', '기본 만료 30일·사용 제한 없음(maxUses=null)', expDays === 30 && inv.maxUses === null, `days=${expDays} maxUses=${inv.maxUses}`)

    // ───────── 4. 학생 A·B 수락(API) → 사용 2·수강생 2 ─────────
    const ra = await api('/api/invitations', await token('a@e2e.kr'), { action: 'accept', code })
    const rb = await api('/api/invitations', await token('b@e2e.kr'), { action: 'accept', code })
    check('T06.accept', '학생 A·B 모두 같은 코드로 참여(첫 사용에 소진되지 않음)', ra.status === 200 && rb.status === 200 && ra.j.status === 'enrolled' && rb.j.status === 'enrolled', `${ra.status}/${ra.j.status} ${rb.status}/${rb.j.status}`)
    const stuA = (await db.doc(`users/${UID_MARK}A`).get()).data() || {}
    check('R04.homeroom-kept', '학생 A 소속(S1_3_4·3학년 4반) 유지', stuA.classId === 'S1_3_4' && stuA.grade === 3 && stuA.classNm === 4, `classId=${stuA.classId}`)
    const meA = await api('/api/timetable/me?from=20261005&to=20261011', await token('a@e2e.kr'), null, 'GET')
    const engB = (meA.j.courses || []).find((c) => c.courseId === courseId)
    const engSeries = (meA.j.series || []).filter((s) => s.courseId === courseId)
    check('T13.me', '학생 A 개인 시간표 자료에 영어 B(화 3교시·3학년 5반 교실), 소속은 3학년 4반', meA.status === 200 && !!engB && engSeries.some((s) => s.weekday === 2 && s.period === 3 && s.roomName === '3학년 5반 교실') && meA.j.homeroom?.classId === 'S1_3_4', `status=${meA.status} homeroom=${meA.j.homeroom?.classId}`)

    await page.reload({ waitUntil: 'load' })
    check('T06.uses2', "새로고침 후 초대 목록 '사용 2명'", await seen(page, '사용 2명'))
    check('T06.students2', "수강생 '참여 중 2명'", await seen(page, '참여 중 2명'))
    const body1 = await bodyText(page)
    const leakAt = (t, needle) => {
      const i = t.indexOf(needle)
      return i < 0 ? '' : t.slice(Math.max(0, i - 60), i + needle.length + 20).replace(/\s+/g, ' ')
    }
    check('T46.no-ids', '화면에 학생 uid·수업 id가 보이지 않음', !body1.includes(UID_MARK) && !body1.includes(courseId), leakAt(body1, UID_MARK) || leakAt(body1, courseId))
    check('T04.student-homeroom', "수강생 줄에 소속 표시('소속 3학년 4반')", body1.includes('소속 3학년 4반'))
    await shot(page, '2-after-accept')

    // ───────── 5. 수강 종료(T24): 오늘부터 빠지고 지난 날짜 유지 ─────────
    const rowB = page.locator('li').filter({ hasText: '이학생' })
    await rowB.getByRole('button', { name: '수강 종료' }).click()
    const dlgEnd = page.getByRole('dialog')
    check('T24.copy', "수강 종료 확인 문구(오늘부터 빠지고 지난 날짜 기록 유지)", await dlgEnd.getByText('지난 날짜 기록은 그대로').isVisible().catch(() => false))
    await dlgEnd.getByRole('button', { name: '수강 종료' }).click()
    await seen(page, '수강을 끝냈어요')
    await sleep(1000)
    const enrB = (await db.doc(`schools/S1/enrollments/${courseId}__${UID_MARK}B`).get()).data() || {}
    check('T24.ended', '학생 B 수강 ended, to=오늘(서버 날짜), from 유지', enrB.status === 'ended' && /^\d{8}$/.test(enrB.to || '') && !!enrB.from, JSON.stringify({ status: enrB.status, from: enrB.from, to: enrB.to }))
    check('T24.ui', "화면에 '지난 수강·거절 1명'", await seen(page, '지난 수강·거절 1명'))

    // ───────── 6. 회수(T07) ─────────
    await page.getByRole('button', { name: '회수', exact: true }).first().click()
    const dlgRevoke = page.getByRole('dialog')
    await dlgRevoke.getByRole('button', { name: '회수하기' }).click()
    check('T07.revoked-ui', "목록 상태 '회수됨'", await seen(page, '회수됨'))
    const revoked = (await db.doc(`invitations/${code}`).get()).data() || {}
    check('T07.revoked-db', '초대 문서 revoked=true, 사용 수 2 유지', revoked.revoked === true && revoked.uses === 2, `revoked=${revoked.revoked} uses=${revoked.uses}`)
    const rc = await api('/api/invitations', await token('c@e2e.kr'), { action: 'accept', code })
    check('T07.accept-blocked', '회수된 코드 수락은 410 revoked(만료와 구분)', rc.status === 410 && rc.j.code === 'revoked', `${rc.status} ${rc.j.code}`)
    await shot(page, '3-revoked')

    // ───────── 6-1. 수업 목록: 인원은 list 응답 counts만(R2-20), 종료 예정 표시(R2-8) ─────────
    // 영어 C는 종료일을 미래(11/30)로 정해 둔 상태 — 그 전까지 운영 중
    await db.doc('schools/S1/courses/u4other').set({ status: 'ended', endedOn: '20261130' }, { merge: true })
    const getCalls = []
    const onReq = (req) => {
      if (req.method() === 'POST' && req.url().includes('/api/courses') && /"action"\s*:\s*"get"/.test(req.postData() || '')) getCalls.push(req.url())
    }
    page.on('request', onReq)
    await page.goto(BASE + '/teacher/courses', { waitUntil: 'load' })
    const cardB = page.getByRole('link', { name: '영어 B 수업 관리' })
    const cardC = page.getByRole('link', { name: '영어 C 수업 관리' })
    await cardB.waitFor({ timeout: 20000 }).catch(() => {})
    await sleep(1500)
    page.off('request', onReq)
    const cardBText = (await cardB.innerText().catch(() => '')).replace(/\s+/g, ' ')
    const cardCText = (await cardC.innerText().catch(() => '')).replace(/\s+/g, ' ')
    check('R2-20.list-counts', "목록 인원은 list 응답 counts로 표시(영어 B '수강생 1명' — A 참여, B 종료)", /수강생 1명/.test(cardBText), cardBText.slice(0, 160))
    check('R2-20.no-get', '목록 화면이 수업마다 get(승인 대기 학생 명단·uid 포함)을 부르지 않음', getCalls.length === 0, `get ${getCalls.length}회`)
    check('R2-8.list-scheduled', "목록: 종료일을 미래로 정한 수업은 '…부터 종료 예정'(⛔ 종료 아님)", /11월 30일 \(.\)부터 종료 예정/.test(cardCText) && !cardCText.includes('⛔ 종료'), cardCText.slice(0, 160))
    await shot(page, '3b-list-counts')

    // ───────── 6-2. 종료 예정 수업 상세: 승인·초대·차시 편집·정보 수정·종료일 바꾸기 가능(R2-8) ─────────
    await page.goto(`${BASE}/teacher/courses/u4other`, { waitUntil: 'load' })
    const schedBadge = await seen(page, /11월 30일 \(.\)부터 종료 예정/, 20000)
    const editBtn = await page.getByRole('button', { name: '정보 수정' }).isVisible().catch(() => false)
    const changeEndBtn = await page.getByRole('button', { name: '종료일 바꾸기' }).isVisible().catch(() => false)
    const addBtn = await page.getByRole('button', { name: '차시 추가', exact: true }).isVisible().catch(() => false)
    const inviteBtn = await page.getByRole('button', { name: '수업 초대 코드 만들기' }).isEnabled().catch(() => false)
    const readOnly = await page.getByText('종료된 수업이라 차시를 바꿀 수 없어요').isVisible().catch(() => false)
    check('R2-8.detail-scheduled', "종료 예정 수업 상세: '…부터 종료 예정' + 정보 수정·종료일 바꾸기·차시 추가·초대 가능(종료로 막지 않음)", schedBadge && editBtn && changeEndBtn && addBtn && inviteBtn && !readOnly, JSON.stringify({ schedBadge, editBtn, changeEndBtn, addBtn, inviteBtn, readOnly }))
    await page.getByRole('button', { name: '종료일 바꾸기' }).click().catch(() => {})
    const endMin = await page.getByLabel('종료일').getAttribute('min', { timeout: 5000 }).catch(() => null)
    const endVal = await page.getByLabel('종료일').inputValue({ timeout: 5000 }).catch(() => '')
    check('R2-8.change-end', '종료일 바꾸기: 지금 정한 종료일(11/30)에서 시작, 최소값 오늘(지난 날짜 불가)', endVal === '2026-11-30' && endMin === '2026-10-06', `value=${endVal} min=${endMin}`)
    await shot(page, '3c-end-scheduled')
    await ctx.close()
  }

  // ───────── 7. 담임 X: 학급 시간표 → 우리 반 공통 수업(T03) ─────────
  {
    const { ctx, page } = await newPage(browser, { fixedTime: FIXED, errors, who: 'hr4' })
    await uiLogin(page, 'hr4@e2e.kr')
    await page.goto(BASE + '/teacher/courses', { waitUntil: 'load' })
    await page.getByRole('button', { name: '학급 시간표 → 우리 반 공통 수업으로 연결' }).click()
    const dlg = page.getByRole('dialog')
    const warn = await dlg.getByText('반 학생 모두가 같은 수업을 듣는 과목만 공통 수업이 됩니다').isVisible().catch(() => false)
    const warn2 = await dlg.getByText('선택·이동 수업이 섞여 있으면 수업별로 따로 만들고 초대·명단으로 연결하세요').isVisible().catch(() => false)
    check('T03.confirm-copy', '실행 전 확인 대화상자 문구(공통 수업 조건·선택/이동 수업 안내)', warn && warn2)
    await dlg.getByRole('button', { name: '공통 수업 만들기' }).click()
    const summaryOk = await seen(page, /만든 수업 \d+개/, 25000)
    const body = await bodyText(page)
    const m1 = /교사 미확인 칸 (\d+)개/.exec(body)
    const m2 = /교실 미확인 칸 (\d+)개/.exec(body)
    check('T03.summary', '결과 요약: 만든 수업 수·교사 미확인 칸·교실 미확인 칸', summaryOk && !!m1 && !!m2, `teacher=${m1?.[1]} room=${m2?.[1]}`)
    const commons = (await db.collection('schools/S1/courses').where('commonForHomerooms', 'array-contains', 'S1_3_4').get()).docs
    check('T03.courses', '3학년 4반 공통 수업이 만들어짐(과목·교사별)', commons.length >= 3, `count=${commons.length}`)
    check('T03.list-badge', "목록에 '반 전체 공통 수업 · 3학년 4반'", await seen(page, '반 전체 공통 수업 · 3학년 4반'))
    const meA = await api('/api/timetable/me?from=20261005&to=20261011', await token('a@e2e.kr'), null, 'GET')
    const commonInMe = (meA.j.courses || []).filter((c) => (c.commonForHomerooms || []).includes('S1_3_4'))
    check('T03.student', '3학년 4반 학생 A 개인 시간표 자료에 공통 수업이 들어옴(따로 참여하지 않아도)', meA.status === 200 && commonInMe.length === commons.length, `me=${commonInMe.length}/${commons.length}`)
    await shot(page, '4-homeroom-common')

    // ───────── 8. 공통 수업 후보(importCommon) 확인·해제(T32) ─────────
    const list = await api('/api/courses', await token('hr4@e2e.kr'), { action: 'list' })
    const termId = list.j.termId
    await db.doc('schools/S1/courses/u4cand1').set({
      schoolCode: 'S1',
      termId,
      title: '음악',
      subject: '음악',
      section: null,
      teacherUids: [],
      teacherNames: ['나음악'],
      managerUids: [],
      status: 'active',
      endedOn: null,
      commonForHomerooms: [],
      importCommon: ['S1_3_4'],
      defaultRoomId: null,
      defaultRoomName: null,
      invitePolicy: 'approval',
      catalogVisible: false,
      source: 'import',
      createdAt: Timestamp.now(),
    })
    await db.doc('schools/S1/series/u4cand1s').set({ courseId: 'u4cand1', termId, weekday: 4, period: 2, roomName: '음악실', validFrom: '20260301', validTo: null, status: 'active', createdAt: Timestamp.now() })
    const meBefore = await api('/api/timetable/me?from=20261005&to=20261011', await token('a@e2e.kr'), null, 'GET')
    check('T32.not-auto', '확인 전 후보 수업은 학생 시간표 자료에 없음(가져오기만으로 공통 수업이 되지 않음)', meBefore.status === 200 && !(meBefore.j.courses || []).some((c) => c.courseId === 'u4cand1'))

    await page.reload({ waitUntil: 'load' })
    const candVisible = await seen(page, '공통 수업 후보(시간표 가져오기)')
    const candRow = page.locator('li').filter({ hasText: '음악' }).filter({ hasText: '나음악' })
    const candShown = await candRow.first().waitFor({ timeout: 15000 }).then(() => true, () => false)
    const candErr = await page.getByText('공통 수업 후보를 불러오지 못했어요').isVisible().catch(() => false)
    check('T32.candidate-ui', '후보 목록에 음악(나음악 · 목 2교시)과 확인 버튼', candVisible && candShown && (await seen(page, '목 2교시')), candErr ? '후보 읽기 실패 — schools/{s}/courses 교사 읽기 규칙 확인' : '')
    check('T32.guide', '선택·이동 수업은 확인하지 말라는 안내', await seen(page, '선택·이동 수업(분반이 나뉜 수업)은 확인하지 마세요'))
    if (candShown) {
      await candRow.first().getByRole('button', { name: '반 학생 모두가 듣는 수업이면 확인' }).click()
      await page.getByRole('dialog').getByRole('button', { name: '공통 수업으로 확인' }).click()
      await seen(page, '공통 수업으로 확인했어요')
      await sleep(1000)
      const c1 = (await db.doc('schools/S1/courses/u4cand1').get()).data() || {}
      check('T32.confirm', '확인 → commonForHomerooms에 S1_3_4 추가(setCommon)', (c1.commonForHomerooms || []).includes('S1_3_4'), JSON.stringify(c1.commonForHomerooms))
      // 해제
      const confirmedRow = page.locator('li').filter({ hasText: '음악' }).filter({ has: page.getByRole('button', { name: '해제' }) })
      await confirmedRow.first().getByRole('button', { name: '해제' }).click()
      await page.getByRole('dialog').getByRole('button', { name: '해제하기' }).click()
      await seen(page, '공통 수업을 해제했어요')
      await sleep(1000)
      const c2 = (await db.doc('schools/S1/courses/u4cand1').get()).data() || {}
      check('T32.unconfirm', "'해제' → commonForHomerooms에서 빠짐(enabled:false)", !(c2.commonForHomerooms || []).includes('S1_3_4'), JSON.stringify(c2.commonForHomerooms))
    }
    await shot(page, '5-candidates')

    // ───────── 8-1. 담임 반 확인 성공 → 공통 수업 지정·해제 버튼(R2-12·21) ─────────
    if (commons[0]) {
      await page.goto(`${BASE}/teacher/courses/${encodeURIComponent(commons[0].id)}`, { waitUntil: 'load' })
      const hrBtn = await page
        .getByRole('button', { name: /3학년 4반 (공통 수업 해제|학생 전체의 공통 수업으로 지정)/ })
        .waitFor({ timeout: 20000 })
        .then(() => true, () => false)
      const hrDenied = await page.getByText('그 반 담임 선생님만 할 수 있어요').isVisible().catch(() => false)
      const hrErr = await page.getByText('내 담임 반을 확인하지 못했어요').isVisible().catch(() => false)
      check('R2-12.homeroom-ok', "담임 X가 공통 수업 상세를 열면 '3학년 4반 공통 수업 해제' 버튼(확인 실패·'담임만' 안내 아님)", hrBtn && !hrDenied && !hrErr, JSON.stringify({ hrBtn, hrDenied, hrErr }))
    } else {
      check('R2-12.homeroom-ok', '공통 수업 상세 확인(공통 수업이 없어 건너뜀)', false, 'commons=0')
    }
    await ctx.close()
  }

  // ───────── 9. 권한(R16·T39): 다른 학교 교사·같은 학교 다른 교사·학생 ─────────
  {
    const { ctx, page } = await newPage(browser, { fixedTime: FIXED, errors, who: 't2' })
    await uiLogin(page, 't2@e2e.kr')
    await page.goto(`${BASE}/teacher/courses/${encodeURIComponent(courseId)}`, { waitUntil: 'load' })
    const blocked = (await seen(page, '수업을 찾을 수 없어요', 20000)) || (await seen(page, '이 수업을 관리할 권한이 없어요', 2000))
    const body = await bodyText(page)
    check('T39.other-school-ui', '다른 학교 교사가 수업 상세를 직접 열면 차단 안내(수업 정보 없음)', blocked && !body.includes('영어 B') && !body.includes('김학생'), '')
    const r = await api('/api/courses', await token('t2@e2e.kr'), { action: 'get', courseId })
    check('R16.other-school-api', '다른 학교 교사 get → 404/403(존재 여부 비공개)', r.status === 404 || r.status === 403, `${r.status} ${r.j.code}`)
    await shot(page, '6-other-school')
    await ctx.close()
  }
  {
    const { ctx, page } = await newPage(browser, { fixedTime: FIXED, errors, who: 'tz' })
    await uiLogin(page, 'tz@e2e.kr')
    await page.goto(`${BASE}/teacher/courses/${encodeURIComponent(courseId)}`, { waitUntil: 'load' })
    const forb = await seen(page, '이 수업을 관리할 권한이 없어요', 20000)
    const body = await bodyText(page)
    check('T39.same-school-403', "같은 학교 다른 교사: '권한이 없어요'(없는 수업 안내와 구분), 명단 없음", forb && !body.includes('김학생') && !body.includes('수업을 찾을 수 없어요'))
    await page.goto(`${BASE}/teacher/courses/not-a-real-course`, { waitUntil: 'load' })
    check('T39.not-found', "없는 수업: '수업을 찾을 수 없어요'(권한 안내와 구분)", await seen(page, '수업을 찾을 수 없어요', 20000))
    await shot(page, '7-same-school-forbidden')
    await ctx.close()
  }
  {
    const { ctx, page } = await newPage(browser, { fixedTime: FIXED, errors, who: 'stuA' })
    await uiLogin(page, 'a@e2e.kr')
    await page.goto(`${BASE}/teacher/courses`, { waitUntil: 'load' })
    const moved = await page.waitForURL(/\/student\//, { timeout: 20000 }).then(() => true, () => false)
    check('R16.student-guard', '학생이 /teacher/courses를 열면 학생 화면으로 이동', moved, page.url().replace(BASE, ''))
    const r = await api('/api/courses', await token('a@e2e.kr'), { action: 'get', courseId })
    check('T39.student-api', '학생 get → 403 teacher-only', r.status === 403 && r.j.code === 'teacher-only', `${r.status} ${r.j.code}`)
    await ctx.close()
  }

  const pageErrors = errors.filter((e) => e.kind === 'pageerror')
  check('R18.no-pageerror', '처리되지 않은 화면 오류(pageerror) 없음', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)))
  const leaked = errors.filter((e) => /[2-9A-HJKMNP-Z]{4}-?[2-9A-HJKMNP-Z]{4}/.test(e.msg) && /invite|초대/i.test(e.msg))
  check('T46.console', '콘솔 오류에 초대 코드가 없음', leaked.length === 0, JSON.stringify(leaked.slice(0, 2)))
  note('console', `console.error ${errors.filter((e) => e.kind === 'console.error').length}건(404 응답 로그 포함 — 내용은 results.json)`)
} catch (e) {
  check('crash', '시나리오 실행 중 예외', false, String(e?.stack || e).slice(0, 500))
} finally {
  await browser.close()
}
const failed = finish({ errors })
process.exit(failed ? 1 : 0)
