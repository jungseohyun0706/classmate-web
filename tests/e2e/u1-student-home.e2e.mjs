// U1 학생 개인 시간표 화면 E2E (그룹 'u1-student-home')
// 대상: /student/today('오늘의 내 시간표' 카드·내 수업 칩·수업 정보 시트), /student/timetable?date=, 상태 카드, 캐시·오프라인
// 실행 전제: 실제 서버(BASE, 기본 http://127.0.0.1:3100, NEXT_PUBLIC_USE_EMULATORS=1 빌드)
//           + Firebase 에뮬레이터(Firestore 8080, Auth 9099)
//           + NEIS mock(NODE_OPTIONS="--require <repo>/tests/support/neis-mock.cjs" NEIS_MOCK_FILE=<repo>/tests/fixtures/neis-mock.runtime.json)
// 사용: BASE=http://127.0.0.1:3100 node tests/e2e/u1-student-home.e2e.mjs
// 모든 데이터는 에뮬레이터의 테스트용 가상 데이터이며 실제 학생 정보가 아닙니다.
//
// 요구 식별자(지시서): R01 R03 R05 R08 R11 R15, T01 T03 T10 T11 T12 T13 T16 T34 T35 T36 T37
//  + 첫날 회귀(F16~F20): 학급 시간표(참고)가 직접 입력 일정·승인 대기·/me 오류로 사라지지 않음, '지금' 교시, '내일 가방' 알림 링크
//  - 작업 지시의 '(T09/T10) 날짜 이동'은 지시서 번호로는 T11(일간 탐색)·T12(날짜 경계)에 해당해 그 번호로 기록하고,
//    T10(계정 변경 시 캐시)은 로그아웃·계정 전환 캐시 삭제 검사에 씁니다.
import { admin, wipe, createUsers, writeNeisFixture, reporter, launchBrowser, newPage, uiLogin, sleep, Timestamp, BASE, PW } from './lib/env.mjs'

const { OUT, check, note, finish } = reporter('u1-student-home')

// 고정 시각: 2026-10-06(화) 09:30 KST — 2교시 중
const FIXED = '2026-10-06T09:30:00+09:00'
const TODAY = '20261006'
const TERM = '2026-2'
const S1 = { schoolCode: 'S1', schoolName: '테스트고등학교', officeCode: 'B10' }

// 내부 id(화면에 보이면 안 됨)
const C = { lit: 'e2eLit34', sciA: 'e2eSciA', engB: 'e2eEngB', engC: 'e2eEngC', mathC: 'e2eMathC', physD: 'e2ePhysD' }
const SER = {
  litTue1: 'e2eSerLitTue1',
  engBTue3: 'e2eSerEngBTue3',
  engBWed1: 'e2eSerEngBWed1',
  engBFri3: 'e2eSerEngBFri3',
  engCTue3: 'e2eSerEngCTue3',
  sciATue4: 'e2eSerSciATue4',
  sciAThu2: 'e2eSerSciAThu2',
  physDTue5: 'e2eSerPhysDTue5',
}
const INTERNAL_IDS = [...Object.values(C), ...Object.values(SER), 'cs_e2e_u1', 'e2eOv', 'e2ePeAcademy', 'S1_3_4', 'S1_3_5']

// 학급 시간표(참고) 머리줄(접기·펼치기 버튼) 이름 — ClassTimetableReference의 CLASS_REFERENCE_LABEL
const REF_LABEL = '학급 시간표(참고) — 내 수업과 다를 수 있어요'

function neisFixture() {
  return {
    schools: [{ SD_SCHUL_CODE: 'S1', SCHUL_NM: '테스트고등학교', SCHUL_KND_SC_NM: '고등학교', ATPT_OFCDC_SC_CODE: 'B10' }],
    meals: [{ SD_SCHUL_CODE: 'S1', MLSV_YMD: TODAY, MMEAL_SC_CODE: '2', MMEAL_SC_NM: '중식', DDISH_NM: '현미밥<br/>된장국<br/>불고기<br/>깍두기' }],
    // 3학년 5반 NEIS 학급 시간표(학급 시간표(참고) 보기용)
    timetables: {
      hisTimetable: ['국어', '수학', '영어', '과학'].map((s, i) => ({
        SD_SCHUL_CODE: 'S1',
        GRADE: '3',
        CLASS_NM: '5',
        ALL_TI_YMD: TODAY,
        PERIO: String(i + 1),
        ITRT_CNTNT: s,
      })),
    },
    // 10/9(금) 한글날 — 휴일 상태
    schedule: [{ SD_SCHUL_CODE: 'S1', AA_YMD: '20261009', EVENT_NM: '한글날', SBTR_DD_SC_NM: '공휴일' }],
  }
}

async function seed() {
  await wipe()
  writeNeisFixture(neisFixture())
  const St = (name, classId, grade, classNm) => ({ role: 'student', status: 'approved', name, displayName: name, classId, grade, classNm, ...S1 })
  await createUsers([
    { uid: 'stuA', email: 'a@u1.e2e.kr', doc: St('김학생', 'S1_3_4', 3, 4) }, // 3-4: 영어 B + 생활과 과학 A (+ 학급 공통 문학)
    { uid: 'stuB', email: 'b@u1.e2e.kr', doc: St('이학생', 'S1_3_5', 3, 5) }, // 3-5: 영어 B
    { uid: 'stuC', email: 'c@u1.e2e.kr', doc: St('박학생', 'S1_3_4', 3, 4) }, // 3-4: 영어 C + 생활과 과학 A + 수학 C(시간표 없음)
    // 수업 그룹 QR로 들어와 그룹이 소속처럼 저장된 예전 학생(grade null)
    { uid: 'stuG', email: 'g@u1.e2e.kr', doc: St('최학생', 'S1_3_5_g_engb', null, null) },
    { uid: 'stuN', email: 'n@u1.e2e.kr', doc: St('정학생', 'S1_3_5', 3, 5) }, // 수강 없음
    { uid: 'stuR', email: 'r@u1.e2e.kr', doc: St('한학생', 'S1_3_5', 3, 5) }, // 수학 C(시간표 없음) + 물리 D 승인 대기
    { uid: 'stuP', email: 'p@u1.e2e.kr', doc: St('윤학생', 'S1_3_5', 3, 5) }, // 수강 없음 + 직접 입력 '학원'(매주 월)만
    { uid: 'stuQ', email: 'q@u1.e2e.kr', doc: { ...St('서학생', 'S1_3_5', 3, 5), status: 'pending' } }, // 3-5 담임 승인 대기
  ])
  const { db } = admin()
  const now = Timestamp.now()
  await db.doc('schools/S1').set({ name: '테스트고등학교', kind: '고등학교', officeCode: 'B10', timezone: 'Asia/Seoul', scheduleRevision: 1, updatedAt: now })
  await db.doc('classes/S1_3_4').set({ classId: 'S1_3_4', grade: 3, classNm: 4, teacherId: 'hr4', teacherName: '김담임', createdAt: now, ...S1 })
  await db.doc('classes/S1_3_5').set({ classId: 'S1_3_5', grade: 3, classNm: 5, teacherId: 'hr5', teacherName: '박담임', createdAt: now, ...S1 })
  await db.doc('classes/S1_3_5_g_engb').set({ classId: 'S1_3_5_g_engb', isGroup: true, grade: 3, classNm: 5, teacherId: 'ty', subjectName: '영어', createdAt: now, ...S1 })
  await db.doc('classes/S1_3_5/info/timetable').set({ mon: ['국어'], tue: ['국어', '수학', '영어', '과학'], wed: [], thu: [], fri: [] })

  const course = (id, title, subject, section, teacher, tuid, room, extra = {}) =>
    db.doc(`schools/S1/courses/${id}`).set({
      schoolCode: 'S1',
      termId: TERM,
      title,
      subject,
      section: section || null,
      teacherUids: [tuid],
      teacherNames: [teacher],
      status: 'active',
      endedOn: null,
      commonForHomerooms: [],
      defaultRoomName: room,
      invitePolicy: 'approval',
      catalogVisible: true,
      source: 'manual',
      createdBy: tuid,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      ...extra,
    })
  await course(C.lit, '문학', '문학', null, '한국어', 'tk', '3학년 4반 교실', { commonForHomerooms: ['S1_3_4'], source: 'homeroom-common' })
  await course(C.sciA, '생활과 과학 A', '생활과 과학', 'A', '최과학', 'tx', '3학년 4반 교실')
  await course(C.engB, '영어 B', '영어', 'B', '이영어', 'ty', '3학년 5반 교실')
  await course(C.engC, '영어 C', '영어', 'C', '정영어', 'tz', '영어전용실')
  await course(C.mathC, '수학 C', '수학', 'C', '오수학', 'tm', '수학실')
  await course(C.physD, '물리 D', '물리학', 'D', '강물리', 'tp', '물리실')

  const series = (id, courseId, weekday, period, roomName, teacher) =>
    db.doc(`schools/S1/series/${id}`).set({
      courseId,
      termId: TERM,
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
  await series(SER.engBWed1, C.engB, 3, 1, '3학년 5반 교실', '이영어')
  await series(SER.engBFri3, C.engB, 5, 3, '3학년 5반 교실', '이영어')
  await series(SER.engCTue3, C.engC, 2, 3, '영어전용실', '정영어')
  await series(SER.sciATue4, C.sciA, 2, 4, '3학년 4반 교실', '최과학')
  await series(SER.sciAThu2, C.sciA, 4, 2, '3학년 4반 교실', '최과학')
  await series(SER.physDTue5, C.physD, 2, 5, '물리실', '강물리')

  const enroll = (courseId, uid, status, source) =>
    db.doc(`schools/S1/enrollments/${courseId}__${uid}`).set({ courseId, uid, schoolCode: 'S1', termId: TERM, status, from: null, to: null, source, createdAt: now, updatedAt: now })
  await enroll(C.engB, 'stuA', 'active', 'invite')
  await enroll(C.sciA, 'stuA', 'active', 'invite')
  await enroll(C.engB, 'stuB', 'active', 'invite')
  await enroll(C.engC, 'stuC', 'active', 'roster')
  await enroll(C.sciA, 'stuC', 'active', 'roster')
  await enroll(C.mathC, 'stuC', 'active', 'roster')
  await enroll(C.engB, 'stuG', 'active', 'legacy-group')
  await enroll(C.mathC, 'stuR', 'active', 'request')
  await enroll(C.physD, 'stuR', 'pending', 'request')

  // A의 직접 입력 일정(학교 시간표와 연결되지 않음) — R08
  await db.doc('users/stuA/personalEntries/e2ePeCoding').set({
    title: '방과후 코딩',
    kind: 'once',
    weekday: null,
    date: TODAY,
    period: null,
    start: '16:30',
    end: '18:00',
    roomName: '컴퓨터실',
    memo: null,
    linkedCourseId: null,
    createdAt: now,
  })
  // P의 직접 입력 일정(매주 월 18:00 학원) — 공식 수업 없이 개인 일정만 있는 학생(F16)
  await db.doc('users/stuP/personalEntries/e2ePeAcademy').set({
    title: '학원',
    kind: 'weekly',
    weekday: 1,
    date: null,
    period: null,
    start: '18:00',
    end: '20:00',
    roomName: null,
    memo: null,
    linkedCourseId: null,
    createdAt: now,
  })
}

/** 영어 B 화 3교시 → 화 2교시(이 날짜만) 발행 — 서버 overrideFromDoc 필드 기준 + scheduleRevision +1 */
async function publishEngBMove() {
  const { db } = admin()
  const occ = `${SER.engBTue3}@${TODAY}`
  await db.doc('schools/S1/overrides/e2eOvEngB1006').set({
    courseId: C.engB,
    occurrenceKey: occ,
    changeSetId: 'cs_e2e_u1_1',
    changeSetKeys: [`${C.engB}|${occ}`],
    kind: 'reschedule',
    seriesId: SER.engBTue3,
    originalDate: TODAY,
    target: { date: TODAY, period: 2 },
    dates: [TODAY],
    reason: '영어 선생님 연수로 교시 이동',
    revision: 2,
    status: 'published',
    publishedAt: Timestamp.now(),
    createdBy: 'ty',
  })
  await db.doc('schools/S1').set({ scheduleRevision: 2, updatedAt: Timestamp.now() }, { merge: true })
}

// ───────────────────────── 화면 도우미 ─────────────────────────

async function openAs(browser, email, path = '/student/today', setup) {
  const errors = []
  const { ctx, page } = await newPage(browser, { fixedTime: FIXED, errors, who: email })
  if (setup) await setup(page, ctx)
  await uiLogin(page, email)
  if (!page.url().endsWith(path)) await page.goto(BASE + path, { waitUntil: 'load' })
  return { ctx, page, errors }
}

async function visible(locator, timeout = 10000) {
  try {
    await locator.first().waitFor({ state: 'visible', timeout })
    return true
  } catch {
    return false
  }
}

const seen = (page, text, timeout = 10000) => visible(page.getByText(text), timeout)

/** 개인 시간표 영역(홈: '오늘의 내 시간표'/'내 시간표' 카드, 전체 화면: '내 시간표') */
const ttRegion = (page) => page.getByRole('region', { name: /내 시간표$/ }).first()

async function articleText(scope, name, timeout = 10000) {
  const a = scope.getByRole('article', { name }).first()
  if (!(await visible(a, timeout))) return null
  return a.innerText()
}

async function bodyText(page) {
  return page.locator('body').innerText()
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true }).catch(() => {})
}

async function cacheKeys(page) {
  return page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('cm_tt_')))
}

async function navText(page) {
  return page.getByRole('navigation', { name: '날짜 이동' }).first().innerText()
}

/** 날짜 이동 영역에 parts가 모두 보일 때까지(최대 timeout) 기다린 뒤 마지막 텍스트 */
async function navHas(page, parts, timeout = 6000) {
  const end = Date.now() + timeout
  let t = ''
  while (Date.now() < end) {
    t = await navText(page).catch(() => '')
    if (parts.every((x) => t.includes(x))) return { ok: true, text: t.replace(/\n/g, ' ') }
    await sleep(150)
  }
  return { ok: false, text: t.replace(/\n/g, ' ') }
}

// ───────────────────────── 시나리오 ─────────────────────────

async function t01GroupLegacyStudent(browser) {
  const { ctx, page, errors } = await openAs(browser, 'g@u1.e2e.kr')
  const region = ttRegion(page)
  const eng = await articleText(region, /3교시 영어 B/)
  const text = await bodyText(page)
  await shot(page, 'T01-group-legacy-today')
  check('T01.1/R01', '그룹 QR 학생(classId=그룹, grade 없음): 오늘의 내 시간표에 연결된 수업 영어 B 3교시 표시', !!eng, eng ? eng.replace(/\n/g, ' ') : '수업 카드 없음')
  check('T01.2/R01', '급식만 보이는 상태가 아님(급식 + 개인 시간표 함께)', text.includes('불고기') && !!eng)
  check('T01.3/R01', '"오늘 시간표 정보가 없어요"·"수업이 없어요"로 표시하지 않음', !/오늘 시간표 정보가 없어요|수업이 없어요/.test(text))
  check('T01.4/R03', '상단 소속은 수업 그룹이 아니라 "소속 학급 확인 필요"', text.includes('소속 학급 확인 필요'))
  check('T01.5/R03', '영어 B 실제 수업 교실(3학년 5반 교실) 표시', !!eng && eng.includes('3학년 5반 교실'))
  if (errors.length) note('T01.errors', JSON.stringify(errors.slice(0, 5)))
  await ctx.close()
}

async function t03t13HomeLayout(browser) {
  // 학생 A(3학년 4반): 학급 공통 문학 + 영어 B(3학년 5반 교실) + 생활과 과학 A + 직접 입력
  const { ctx, page } = await openAs(browser, 'a@u1.e2e.kr')
  const region = ttRegion(page)
  check('T03.0', '"오늘의 내 시간표" 카드', await visible(page.getByRole('region', { name: '오늘의 내 시간표' })))
  const lit = await articleText(region, /1교시 문학/)
  check('T03.1', '학급 공통 수업(문학)이 수강 신청 없이 개인 시간표에 표시', !!lit, lit ?? '없음')
  const eng = await articleText(region, /3교시 영어 B/)
  check('T03.2/T13.1', 'A: 3교시 영어 B · 실제 교실 3학년 5반 교실(소속 3학년 4반과 다른 교실)', !!eng && eng.includes('3학년 5반 교실'), eng?.replace(/\n/g, ' '))
  const sci = await articleText(region, /4교시 생활과 과학 A/)
  check('T03.3', 'A: 4교시 생활과 과학 A · 3학년 4반 교실', !!sci && sci.includes('3학년 4반 교실'))
  const h1 = await page.getByRole('heading', { level: 1 }).first().innerText()
  check('T13.2/R03', '상단: 학교 · 원래 소속 학년·반(3학년 4반)', h1.includes('테스트고등학교') && h1.includes('3학년 4반'), h1)

  // 직접 입력 일정(R08)
  const pe = await articleText(region, /방과후 코딩/)
  if (!pe && (await seen(page, '직접 입력한 일정을 불러오지 못했어요', 1000))) {
    note('R08.rules', 'users/{uid}/personalEntries 읽기 규칙이 아직 없어 직접 입력 일정을 읽지 못함(화면은 오류 안내를 표시)')
  }
  check('R08.1', '직접 입력 일정: "직접 입력 · 학교 시간표와 연결되지 않음" 배지, 변경 강조 없음', !!pe && pe.includes('직접 입력 · 학교 시간표와 연결되지 않음') && !pe.includes('변경'), pe?.replace(/\n/g, ' ') ?? '카드 없음')

  // 내 수업 칩 → 수업 정보 시트(교사·기본 교실·요일 교시, 학생 명단 없음)
  const chip = page.getByRole('button', { name: '영어 B 수업 정보' })
  const chipOk = await visible(chip)
  check('T13.3', '내 수업 칩(영어 B)', chipOk)
  if (chipOk) {
    await chip.first().click()
    const dialog = page.getByRole('dialog', { name: '영어 B' })
    const dOk = await visible(dialog)
    const dText = dOk ? await dialog.innerText() : ''
    await shot(page, 'T13-course-sheet')
    check('T13.4', '수업 정보 시트: 교사 이름·기본 교실·요일 교시', dOk && dText.includes('이영어') && dText.includes('3학년 5반 교실') && /화 3교시/.test(dText), dText.replace(/\n/g, ' '))
    check('T13.5/R03', '수업 정보 시트에 다른 학생 정보 없음', dOk && !/이학생|박학생|최학생|정학생|한학생/.test(dText))
    await dialog.getByRole('button', { name: '닫기' }).click()
    const h1b = await page.getByRole('heading', { level: 1 }).first().innerText()
    check('T13.6/R03', '수업 칩을 눌러도 상단 소속(3학년 4반)이 수업 장소로 바뀌지 않음', h1b.includes('3학년 4반') && !h1b.includes('5반'), h1b)
  }

  const text = await bodyText(page)
  const leaked = INTERNAL_IDS.filter((id) => text.includes(id))
  check('R03.1', '화면에 내부 id·관리 필드 없음', leaked.length === 0, leaked.join(','))
  await shot(page, 'T03-A-today')

  // 같은 반 C: 같은 3교시에 다른 수업(영어 C · 영어전용실)
  const c = await openAs(browser, 'c@u1.e2e.kr')
  const cRegion = ttRegion(c.page)
  const engC = await articleText(cRegion, /3교시 영어 C/)
  const cText = await bodyText(c.page)
  check('T03.4/T13.7', '같은 반 C는 같은 3교시에 영어 C · 영어전용실(과목명만으로 합쳐지지 않음)', !!engC && engC.includes('영어전용실') && !/영어 B/.test(cText), engC?.replace(/\n/g, ' '))
  await shot(c.page, 'T03-C-today')
  await c.ctx.close()

  return { ctx, page }
}

async function t16t36Change(browser, a) {
  const { page } = a
  const region = ttRegion(page)
  const before = await articleText(region, /3교시 영어 B/)
  check('T16.0', '변경 전: 영어 B 3교시, 변경 배지 없음', !!before && !before.includes('시간 변경'))

  await publishEngBMove()
  // T36: 화면을 연 채로 발행 → schools/S1.scheduleRevision 구독으로 다시 받기
  let after = await articleText(region, /2교시 영어 B/, 12000)
  let path = 'scheduleRevision 구독'
  if (!after) {
    // 구독 권한이 없으면 화면 포커스·visibilitychange 때 다시 받기로 대체
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    after = await articleText(region, /2교시 영어 B/, 10000)
    path = '포커스 복귀 다시 받기(구독 실패 대체 경로)'
  }
  note('T36.path', after ? path : '반영 안 됨')
  check('T36.1', '화면을 연 상태에서 변경 발행 → 새로고침 없이 최신 버전 반영', !!after, path)
  check('T16.1/R10', 'A: 빨간 배지 "시간 변경" + "3교시 → 2교시"', !!after && after.includes('시간 변경') && after.includes('3교시 → 2교시'), after?.replace(/\n/g, ' '))
  if (after) {
    const art = region.getByRole('article', { name: /2교시 영어 B/ }).first()
    const cls = (await art.getAttribute('class')) || ''
    check('T16.2/R10', '변경 카드는 빨간 계열 테두리(색 + 텍스트 배지 함께)', /border-red-/.test(cls), cls)
    await art.getByText('변경 사유·안내 시각').click()
    check('T16.3', '변경 사유는 펼쳐서 확인', await visible(art.getByText('영어 선생님 연수로 교시 이동'), 5000))
  }
  await shot(page, 'T16-A-after')

  // B(3학년 5반, 영어 B 수강)
  const b = await openAs(browser, 'b@u1.e2e.kr')
  const bEng = await articleText(ttRegion(b.page), /2교시 영어 B/)
  check('T16.4', 'B: 영어 B 2교시로 "시간 변경" + "3교시 → 2교시"', !!bEng && bEng.includes('시간 변경') && bEng.includes('3교시 → 2교시'), bEng?.replace(/\n/g, ' '))
  await shot(b.page, 'T16-B-after')
  await b.ctx.close()

  // C(영어 B 안 들음): 변경 없음
  const c = await openAs(browser, 'c@u1.e2e.kr')
  const cEng = await articleText(ttRegion(c.page), /3교시 영어 C/)
  const cText = await bodyText(c.page)
  check('T16.5/R09', '영어 B를 안 듣는 C에는 변경 배지 없음(영어 C 3교시 그대로)', !!cEng && !cText.includes('시간 변경') && !cText.includes('3교시 → 2교시'))
  await c.ctx.close()

  // R11: 다른 날짜(다음 주 화요일)의 기본 시간표는 이 날짜만 변경에 영향 없음
  await page.goto(BASE + '/student/timetable?date=20261013', { waitUntil: 'load' })
  const next = await articleText(ttRegion(page), /3교시 영어 B/)
  check('R11.1/T16.6', '다음 주 화요일 영어 B는 기본 3교시 그대로(변경 배지 없음)', !!next && !next.includes('변경'), next?.replace(/\n/g, ' '))
}

async function t11t12DateNav(browser) {
  // 저녁 알림 링크(/student/timetable?date=내일)
  const { ctx, page } = await openAs(browser, 'a@u1.e2e.kr', '/student/timetable?date=20261007')
  const region = ttRegion(page)
  const wed = await articleText(region, /1교시 영어 B/)
  let nav = await navHas(page, ['내일', '10월 7일 (수)'])
  check('T11.1', '알림 링크 ?date=내일 → "내일" + 10월 7일 (수) + 그날 수업', nav.ok && !!wed, nav.text)

  await page.getByRole('button', { name: '이전 날' }).click()
  nav = await navHas(page, ['오늘', '10월 6일 (화)'])
  check('T11.2', '‹ 이전 날 → "오늘" 10월 6일 (화)', nav.ok && page.url().includes('date=20261006'), nav.text)
  check('T11.3', '오늘에는 "오늘로" 버튼 숨김', !(await visible(page.getByRole('button', { name: '오늘로' }), 1000)))

  await page.getByRole('button', { name: '이전 날' }).click()
  nav = await navHas(page, ['어제', '10월 5일 (월)'])
  check('T11.4', '어제 라벨 + 10월 5일 (월)', nav.ok, nav.text)

  await page.getByRole('button', { name: '오늘로' }).click()
  nav = await navHas(page, ['오늘', '10월 6일 (화)'])
  check('T11.5', '"오늘로" → 오늘', nav.ok, nav.text)

  await page.getByRole('button', { name: '다음 날' }).click()
  await navHas(page, ['내일'])
  await page.getByRole('button', { name: '다음 날' }).click()
  nav = await navHas(page, ['모레', '10월 8일 (목)'])
  const thu = await articleText(region, /2교시 생활과 과학 A/)
  check('T11.6', '› 두 번 → "모레" 10월 8일 (목) + 그날 수업(생활과 과학 A 2교시)', nav.ok && !!thu, nav.text)

  // 조회 창 밖 날짜(다시 받기) + 날짜 선택
  await page.getByLabel('날짜 선택').fill('2026-11-03')
  nav = await navHas(page, ['11월 3일 (화)'])
  const nov = await articleText(region, /3교시 영어 B/, 15000)
  check('T11.7', '날짜 선택(조회 창 밖 11/3) → 그 기간을 다시 받아 수업 표시', nav.ok && !!nov, nav.text)

  // 월말·연말 경계
  await page.getByLabel('날짜 선택').fill('2026-12-31')
  nav = await navHas(page, ['12월 31일 (목)'])
  check('T12.1', '연말 12월 31일 (목)', nav.ok, nav.text)
  await page.getByRole('button', { name: '다음 날' }).click()
  nav = await navHas(page, ['1월 1일 (금)'])
  check('T12.2', '다음 날 → 1월 1일 (금), URL date=20270101', nav.ok && page.url().includes('date=20270101'), nav.text)
  await page.getByLabel('날짜 선택').fill('2026-10-31')
  await navHas(page, ['10월 31일 (토)'])
  await page.getByRole('button', { name: '다음 날' }).click()
  nav = await navHas(page, ['11월 1일 (일)'])
  check('T12.3', '월말 10/31(토) → 11월 1일 (일)', nav.ok, nav.text)
  await shot(page, 'T12-boundary')

  // 홈 카드의 '전체 보기' → /student/timetable?date=
  await page.goto(BASE + '/student/today', { waitUntil: 'load' })
  await visible(ttRegion(page).getByRole('article'), 10000)
  await page.getByRole('button', { name: '다음 날' }).click()
  await page.getByRole('link', { name: /전체 보기/ }).click()
  await page.waitForURL(/\/student\/timetable\?date=20261007/, { timeout: 10000 }).catch(() => {})
  check('T11.8', '홈 "전체 보기" → /student/timetable?date=(보던 날짜)', page.url().includes('/student/timetable?date=20261007'), page.url())
  await ctx.close()

  // 로그인 안 됨 → 로그인 화면(?next=) → 로그인 뒤 그 날짜 화면으로
  const anon = await newPage(browser, { fixedTime: FIXED })
  await anon.page.goto(BASE + '/student/timetable?date=20261007', { waitUntil: 'load' })
  await anon.page.waitForURL(/\/auth\/login/, { timeout: 15000 }).catch(() => {})
  const loginUrl = anon.page.url()
  check('R15.1', '로그인 안 됨 → 로그인 화면(돌아올 주소 next 포함)', loginUrl.includes('/auth/login') && decodeURIComponent(loginUrl).includes('next=/student/timetable?date=20261007'), loginUrl)
  try {
    await anon.page.fill('input[type=email]', 'a@u1.e2e.kr')
    await anon.page.fill('input[type=password]', PW)
    await anon.page.locator('button[type=submit]:visible').first().click()
    await anon.page.waitForURL(/\/student\/timetable\?date=20261007/, { timeout: 25000 })
    const back = await navHas(anon.page, ['내일', '10월 7일 (수)'])
    check('R15.2', '로그인 뒤 원래 날짜 화면(/student/timetable?date=20261007)으로 돌아옴', back.ok, anon.page.url())
  } catch (e) {
    check('R15.2', '로그인 뒤 원래 날짜 화면으로 돌아옴', false, `${anon.page.url()} ${String(e?.message || e).slice(0, 120)}`)
  }
  await anon.ctx.close()

  // 둘러보기(익명) 세션도 로그인 안 됨과 같이 → 로그인 화면(?next=), '가입 미완료'로 보이지 않음
  // (/meals는 학교가 정해지면 별점 집계를 읽으려고 signInAnonymously로 익명 계정을 만듦 — 저장된 학교로 재현)
  const guest = await newPage(browser, { fixedTime: FIXED })
  try {
    await guest.page.addInitScript(() => {
      try {
        window.localStorage.setItem('classmate_meal_school', JSON.stringify({ code: 'S1', name: '테스트고등학교' }))
      } catch {}
    })
    await guest.page.goto(BASE + '/meals', { waitUntil: 'load' })
    // Firebase가 IndexedDB(firebaseLocalStorageDb)에 익명 사용자를 저장했는지 — DB를 먼저 만들지 않게 있을 때만 열어 봄
    const anonSaved = () =>
      guest.page.evaluate(async () => {
        try {
          const dbs = indexedDB.databases ? await indexedDB.databases() : []
          if (!dbs.some((d) => d.name === 'firebaseLocalStorageDb')) return false
          return await new Promise((resolve) => {
            const req = indexedDB.open('firebaseLocalStorageDb')
            req.onerror = () => resolve(false)
            req.onsuccess = () => {
              const db = req.result
              if (!db.objectStoreNames.contains('firebaseLocalStorage')) {
                db.close()
                resolve(false)
                return
              }
              const all = db.transaction('firebaseLocalStorage', 'readonly').objectStore('firebaseLocalStorage').getAll()
              all.onsuccess = () => {
                db.close()
                resolve(all.result.some((r) => r && r.value && r.value.isAnonymous === true))
              }
              all.onerror = () => {
                db.close()
                resolve(false)
              }
            }
          })
        } catch {
          return false
        }
      })
    let anonOk = false
    for (let i = 0; i < 40 && !anonOk; i++) {
      anonOk = await anonSaved()
      if (!anonOk) await sleep(500)
    }
    await guest.page.goto(BASE + '/student/timetable?date=20261007', { waitUntil: 'load' })
    await guest.page.waitForURL(/\/auth\/login/, { timeout: 15000 }).catch(() => {})
    const gUrl = guest.page.url()
    const gText = await bodyText(guest.page)
    check(
      'R15.3',
      '둘러보기(익명) 세션 → 로그인 안 됨과 같이 로그인 화면(next 포함), "가입 미완료"로 보이지 않음',
      anonOk && gUrl.includes('/auth/login') && decodeURIComponent(gUrl).includes('next=/student/timetable?date=20261007') && !gText.includes('가입이 아직 끝나지 않았어요'),
      `${anonOk ? '' : '익명 세션을 만들지 못함 '}${gUrl}`
    )
  } catch (e) {
    check('R15.3', '둘러보기(익명) 세션 → 로그인 화면', false, `${guest.page.url()} ${String(e?.message || e).slice(0, 120)}`)
  }
  await guest.ctx.close()
}

async function t34States(browser) {
  // 참여한 수업 없음(no-courses) + 학급 시간표(참고)는 별도 보기
  const n = await openAs(browser, 'n@u1.e2e.kr')
  const nRegion = ttRegion(n.page)
  const noCourses = await visible(nRegion.getByText('아직 연결된 수업이 없어요'))
  check('T34.1', '수강 없음: "아직 연결된 수업이 없어요"', noCourses)
  const links = ['초대 코드 입력', '공식 수업 찾기', '직접 입력']
  const linkOk = []
  for (const l of links) linkOk.push(await visible(nRegion.getByRole('link', { name: l }), 3000))
  check('T34.2', '수강 없음 버튼: 초대 코드 입력·공식 수업 찾기·직접 입력', linkOk.every(Boolean), JSON.stringify(linkOk))
  const nText = await bodyText(n.page)
  check('T34.3', '수강 없음을 "이 날은 수업이 없어요"로 표시하지 않음', !nText.includes('이 날은 수업이 없어요'))
  const refBtn = nRegion.getByRole('button', { name: '학급 시간표(참고) 보기' })
  if (await visible(refBtn, 3000)) {
    await refBtn.click()
    const refLabel = await seen(n.page, '학급 시간표(참고) — 내 수업과 다를 수 있어요')
    const refSubject = await visible(n.page.getByRole('list', { name: '학급 시간표(참고)' }).getByText('국어'), 10000)
    check('T34.4/R05', '학급 시간표(참고)는 라벨을 단 별도 영역으로만 표시', refLabel && refSubject && (await visible(nRegion.getByText('아직 연결된 수업이 없어요'), 1000)))
  } else {
    check('T34.4/R05', '학급 시간표(참고) 보기 버튼', false, 'legacyClassTimetableAvailable=false?')
  }
  await shot(n.page, 'T34-no-courses')
  await n.ctx.close()

  // 시간표 미등록(not-registered) + 승인 대기
  const r = await openAs(browser, 'r@u1.e2e.kr')
  const rRegion = ttRegion(r.page)
  check('T34.5', '시간표 미등록: "수업은 연결됐지만 선생님이 아직 시간표를 등록하지 않았어요"', await visible(rRegion.getByText('수업은 연결됐지만 선생님이 아직 시간표를 등록하지 않았어요')))
  check('T34.6', '승인 대기: "물리 D 수업 승인을 기다리고 있어요"', await visible(rRegion.getByText('물리 D 수업 승인을 기다리고 있어요')))
  await shot(r.page, 'T34-not-registered')
  await r.ctx.close()

  // 일부만 연결(C: 수학 C 시간표 없음)
  const c = await openAs(browser, 'c@u1.e2e.kr')
  check('T34.7', '일부만 연결: "일부 수업 시간표가 아직 없어요 (수학 C)"', await visible(ttRegion(c.page).getByText(/일부 수업 시간표가 아직 없어요.*수학 C/)))
  await c.ctx.close()

  // 휴업일·정상 무수업(A)
  const a = await openAs(browser, 'a@u1.e2e.kr', '/student/timetable?date=20261009')
  const aRegion = ttRegion(a.page)
  check('T34.8', '휴업일: "이 날은 쉬는 날이에요 (한글날)"', await visible(aRegion.getByText('이 날은 쉬는 날이에요 (한글날)')))
  await shot(a.page, 'T34-holiday')
  await a.page.getByLabel('날짜 선택').fill('2026-10-11')
  check('T34.9', '수업 없는 정상 날짜(일요일): "이 날은 수업이 없어요"', await visible(aRegion.getByText('이 날은 수업이 없어요')))
  await a.ctx.close()

  // 학기 밖: schools/S1/terms/2026-2 = [08-17, 10-05) → 10/6은 학기 밖
  //  (A는 10/6에 직접 입력 일정이 있어 '수업 있음'이 되므로 직접 입력이 없는 C로 확인)
  const { db } = admin()
  await db.doc(`schools/S1/terms/${TERM}`).set({ name: '2026학년도 2학기', startDate: '20260817', endDate: '20261005' })
  try {
    const o = await openAs(browser, 'c@u1.e2e.kr')
    const oRegion = ttRegion(o.page)
    const outside = await visible(oRegion.getByText('이 날짜는 등록된 학기 밖이에요'))
    const oText = await bodyText(o.page)
    check('T34.10', '학기 밖: "이 날짜는 등록된 학기 밖이에요"("수업이 없어요"로 단정하지 않음)', outside && !oText.includes('이 날은 수업이 없어요'))
    await shot(o.page, 'T34-outside-term')
    await o.ctx.close()
  } finally {
    await db.doc(`schools/S1/terms/${TERM}`).delete()
  }
}

async function t35Errors(browser) {
  // /api/timetable/me 응답을 가로채 오류 상태 확인(서버 오류는 실제로 유도하기 어려워 응답 모킹)
  let mode = { status: 409, code: 'no-school' }
  const setup = async (page) => {
    await page.route('**/api/timetable/me**', (route) => {
      if (!mode) return route.continue()
      return route.fulfill({ status: mode.status, contentType: 'application/json', body: JSON.stringify({ error: '테스트 오류', code: mode.code }) })
    })
  }
  const { ctx, page } = await openAs(browser, 'a@u1.e2e.kr', '/student/today', setup)
  const region = ttRegion(page)
  check('T35.1', '409 no-school → "학교 정보가 없어요" + 내 정보 확인', (await visible(region.getByText('학교 정보가 없어요'))) && (await visible(region.getByRole('link', { name: '내 정보 확인' }), 2000)))

  mode = { status: 403, code: 'forbidden' }
  await page.reload({ waitUntil: 'load' })
  check('T35.2', '403 → "이 시간표를 볼 권한이 없어요"', await visible(region.getByText('이 시간표를 볼 권한이 없어요')))

  mode = { status: 500, code: 'index-required' }
  await page.reload({ waitUntil: 'load' })
  const serverOk = await visible(region.getByText('시간표를 불러오지 못했어요 (index-required)'))
  const text = await bodyText(page)
  check('T35.3/R15', '500 index-required → "시간표를 불러오지 못했어요 (index-required)" + 다시 시도, 빈 시간표로 위장 안 함', serverOk && (await visible(region.getByRole('button', { name: '다시 시도' }), 2000)) && !/수업이 없어요|연결된 수업이 없어요/.test(text))
  await shot(page, 'T35-server-error')

  mode = null
  await region.getByRole('button', { name: '다시 시도' }).click()
  check('T35.4', '다시 시도 → 정상 시간표로 복구', !!(await articleText(region, /영어 B/, 15000)))
  await ctx.close()
}

async function t37t10OfflineAndAccount(browser) {
  const { ctx, page } = await openAs(browser, 'a@u1.e2e.kr')
  const region = ttRegion(page)
  const online = await articleText(region, /영어 B/)
  const keys0 = await cacheKeys(page)
  check('T37.0', '온라인 조회 후 본인 캐시 저장(cm_tt_v1_stuA)', !!online && keys0.includes('cm_tt_v1_stuA'), JSON.stringify(keys0))

  // 오프라인 + 캐시에 없는 날짜 → 캐시 없음 상태
  await ctx.setOffline(true)
  await page.getByLabel('날짜 선택').fill('2026-11-20')
  check('T37.1', '오프라인·캐시 없음: "인터넷 연결을 확인해 주세요" + 다시 시도', (await visible(region.getByText('인터넷 연결을 확인해 주세요'), 15000)) && (await visible(region.getByRole('button', { name: '다시 시도' }), 2000)))
  await region.getByRole('button', { name: '오늘로' }).click().catch(() => page.getByRole('button', { name: '오늘로' }).click())
  const banner = await visible(region.getByText(/마지막 동기화/), 10000)
  check('T37.2', '오프라인·받은 자료 있음: 시간표 + "마지막 동기화 HH:MM · 최근 변경이 반영되지 않았을 수 있어요"', banner && !!(await articleText(region, /영어 B/, 3000)))
  await ctx.setOffline(false)

  // 다시 열기: 앱 문서는 받되 시간표 API는 네트워크 실패 → localStorage 캐시
  await page.route('**/api/timetable/me**', (route) => route.abort('internetdisconnected'))
  await page.reload({ waitUntil: 'load' })
  const reopened = await visible(region.getByText(/마지막 동기화 \d{2}:\d{2}/), 15000)
  const cachedLesson = await articleText(region, /영어 B/, 5000)
  const bannerText = reopened ? await region.getByText(/마지막 동기화/).first().innerText() : ''
  check('T37.3', '오프라인으로 다시 열면 캐시 시간표 + "마지막 동기화 HH:MM"', reopened && !!cachedLesson, bannerText.replace(/\n/g, ' '))
  await shot(page, 'T37-offline-cache')
  await page.unroute('**/api/timetable/me**')
  await region.getByRole('button', { name: '다시 시도' }).first().click()
  await sleep(3000)
  check('T37.4', '연결 복구 후 다시 시도 → 배너 사라짐(최신 자료)', !(await visible(region.getByText(/마지막 동기화/), 2000)))

  // T10: 로그아웃 → 캐시 삭제, 다른 계정 로그인 → 이전 계정 자료 없음
  await page.getByRole('button', { name: '로그아웃' }).click()
  await page.waitForURL(/\/auth\/login/, { timeout: 15000 }).catch(() => {})
  await sleep(500)
  const keys1 = await cacheKeys(page)
  check('T10.1', '로그아웃하면 시간표 캐시(cm_tt_*) 삭제', keys1.length === 0, JSON.stringify(keys1))
  await uiLogin(page, 'b@u1.e2e.kr')
  if (!page.url().endsWith('/student/today')) await page.goto(BASE + '/student/today', { waitUntil: 'load' })
  const bEng = await articleText(ttRegion(page), /영어 B/)
  const bText = await bodyText(page)
  const keys2 = await cacheKeys(page)
  check('T10.2', '다른 계정(B) 로그인: A 캐시 없음, A 수업(생활과 과학 A·방과후 코딩) 안 보임', !!bEng && !keys2.includes('cm_tt_v1_stuA') && !/생활과 과학 A|방과후 코딩/.test(bText), JSON.stringify(keys2))
  await ctx.close()
}

// ───────────────────────── 첫날 회귀: 학급 시간표(참고) ─────────────────────────

const refHeader = (page) => page.getByRole('button', { name: REF_LABEL, exact: true }).first()
const refList = (page) => page.getByRole('list', { name: '학급 시간표(참고)' }).first()

/** 머리줄이 보이고 펼침 상태가 expanded인지(최대 timeout) */
async function refExpanded(page, expanded, timeout = 10000) {
  const h = refHeader(page)
  if (!(await visible(h, timeout))) return false
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if ((await h.getAttribute('aria-expanded').catch(() => null)) === String(expanded)) return true
    await sleep(150)
  }
  return false
}

async function f16PersonalOnlyKeepsReference(browser) {
  // P: 공식 수업 없음 + 직접 입력 '학원'(매주 월)만. 예전에는 일정 하나로 홈의 학급 시간표(참고)가 사라지고 '이 날은 수업이 없어요'로 보였음
  const { ctx, page, errors } = await openAs(browser, 'p@u1.e2e.kr')
  const region = ttRegion(page)
  const noCourses = await visible(region.getByText('아직 연결된 수업이 없어요'))
  const text = await bodyText(page)
  check('F16.1', '직접 입력만 있는 학생의 일정 없는 화요일: "아직 연결된 수업이 없어요"("이 날은 수업이 없어요"로 학교가 쉬는 것처럼 보이지 않음)', noCourses && !text.includes('이 날은 수업이 없어요'))
  const open = await refExpanded(page, true)
  const subj = await visible(refList(page).getByText('국어'), 10000)
  check('F16.2/R05', '공식 수업이 없으니 학급 시간표(참고)를 처음부터 펼침(개인 일정이 있어도) — 개인 시간표 카드 밖 별도 영역', open && subj && !(await visible(region.getByRole('list', { name: '학급 시간표(참고)' }), 500)))
  await shot(page, 'F16-personal-only-tue')

  await page.getByRole('button', { name: '이전 날' }).first().click()
  const academy = await articleText(region, /학원/)
  const monRef = await visible(refList(page).getByText('국어'), 10000)
  check('F16.3', '일정이 있는 월요일: 개인 시간표에 학원(직접 입력) + 학급 시간표(참고)는 그대로 펼침', !!academy && academy.includes('직접 입력') && (await refExpanded(page, true, 3000)) && monRef, academy?.replace(/\n/g, ' '))

  // 접어도 머리줄이 남아 다시 펼칠 수 있음(예전 홈은 접으면 영역이 통째로 사라짐)
  await refHeader(page).click()
  const collapsed = (await refExpanded(page, false, 3000)) && !(await visible(refList(page), 1000))
  await refHeader(page).click()
  const reopened = (await refExpanded(page, true, 3000)) && (await visible(refList(page).getByText('국어'), 10000))
  check('F16.4', '홈에서 학급 시간표(참고)를 접어도 머리줄이 남고 다시 펼칠 수 있음', collapsed && reopened, JSON.stringify({ collapsed, reopened }))
  if (errors.some((e) => e.kind === 'pageerror')) note('F16.errors', JSON.stringify(errors.slice(0, 5)))
  await ctx.close()

  // 전체 화면도 같은 규칙
  const t = await openAs(browser, 'p@u1.e2e.kr', `/student/timetable?date=${TODAY}`)
  const tText = await bodyText(t.page)
  check('F16.5', '/student/timetable도 직접 입력만 있는 학생은 학급 시간표(참고)를 펼침 + "이 날은 수업이 없어요" 없음', (await refExpanded(t.page, true)) && (await visible(refList(t.page).getByText('국어'), 10000)) && !tText.includes('이 날은 수업이 없어요'))
  await t.ctx.close()

  // 공식 수업 시간표가 있는 학생(A): 접힌 채로 머리줄만 — 눌러서 펼칠 수 있음(T16에서 영어 B가 2교시로 옮겨진 뒤)
  const a = await openAs(browser, 'a@u1.e2e.kr')
  await articleText(ttRegion(a.page), /영어 B/)
  const aCollapsed = await refExpanded(a.page, false)
  let aOpened = false
  if (aCollapsed) {
    await refHeader(a.page).click()
    aOpened = await refExpanded(a.page, true, 3000)
  }
  check('F16.6', '공식 수업이 연결된 학생은 학급 시간표(참고)가 접힌 머리줄로 남고 눌러서 펼칠 수 있음', aCollapsed && aOpened, JSON.stringify({ aCollapsed, aOpened }))
  await a.ctx.close()
}

async function f17PendingSeesReference(browser) {
  // Q: 3-5 담임 승인 대기. 예전(b7d6c46)에는 승인 전에도 NEIS 학급 시간표를 봤음 → 공개 NEIS 참고 보기(classId 없이)
  const { ctx, page, errors } = await openAs(browser, 'q@u1.e2e.kr')
  const region = ttRegion(page)
  check('F17.0', '승인 대기 배너', await seen(page, '선생님 승인을 기다리고 있어요'))
  const open = await refExpanded(page, true)
  const subjects = await refList(page).innerText().catch(() => '')
  check('F17.1/R05', '승인 대기 학생도 학급 시간표(참고)(공개 NEIS 3-5: 국어·수학·영어·과학)를 별도 영역으로 봄', open && ['국어', '수학', '영어', '과학'].every((x) => subjects.includes(x)), subjects.replace(/\n/g, ' '))
  const note17 = await visible(region.getByText(/담임 선생님이 학급 신청을 승인하기 전이에요/))
  const invite = await visible(region.getByRole('link', { name: '초대 코드 입력' }), 1000)
  check('F17.2', '수업 없음 카드는 초대 코드 대신 승인 대기 안내(초대 코드 입력 버튼 없음)', note17 && !invite)
  await shot(page, 'F17-pending-today')
  // classId 없이 공개 NEIS만 조회 — NEIS가 빈 날(10/7)에 승인 전 학급 문서(classes/{id}/info/timetable·overrides)를 읽으면
  // 규칙 거부로 '불러오지 못했어요'가 뜸. 공개 NEIS만이면 '이 날 학급 시간표 정보가 없어요'
  await page.getByRole('button', { name: '다음 날' }).first().click()
  await navHas(page, ['내일'])
  const empty = await visible(page.getByText('이 날 학급 시간표 정보가 없어요'), 10000)
  const denied = await visible(page.getByText('학급 시간표를 불러오지 못했어요'), 1000)
  check('F17.3', 'NEIS가 빈 날에도 승인 전 학급 문서를 읽지 않음(조회 오류 없이 "이 날 학급 시간표 정보가 없어요")', empty && !denied, JSON.stringify({ empty, denied }))
  if (errors.length) note('F17.errors', JSON.stringify(errors.slice(0, 5)))
  await ctx.close()

  const t = await openAs(browser, 'q@u1.e2e.kr', `/student/timetable?date=${TODAY}`)
  check('F17.4', '/student/timetable도 승인 대기 학생에게 학급 시간표(참고)', (await refExpanded(t.page, true)) && (await visible(refList(t.page).getByText('국어'), 10000)))
  await t.ctx.close()
}

async function f19MeFailureKeepsReference(browser) {
  // /api/timetable/me 500(캐시 없음) — 예전 TodayCard는 학급 시간표를 따로 불러와 계속 보였음
  let mode = { status: 500, code: 'load-failed' }
  const setup = async (page) => {
    await page.route('**/api/timetable/me**', (route) => {
      if (!mode) return route.continue()
      if (mode === 'offline') return route.abort('internetdisconnected')
      return route.fulfill({ status: mode.status, contentType: 'application/json', body: JSON.stringify({ error: '테스트 오류', code: mode.code }) })
    })
  }
  const { ctx, page } = await openAs(browser, 'n@u1.e2e.kr', '/student/today', setup)
  const region = ttRegion(page)
  const errCard = await visible(region.getByText('시간표를 불러오지 못했어요 (load-failed)'))
  const open = await refExpanded(page, true)
  const subj = await visible(refList(page).getByText('국어'), 10000)
  const text = await bodyText(page)
  check('F19.1/R15', '/me 500: 개인 시간표는 오류 카드 + 학급 시간표(참고)는 프로필(승인된 3-5) 기준으로 펼쳐 계속 표시', errCard && open && subj && !text.includes('이 날은 수업이 없어요'))
  await shot(page, 'F19-me-500')

  mode = 'offline'
  await page.reload({ waitUntil: 'load' })
  const offline = await visible(region.getByText('인터넷 연결을 확인해 주세요'), 15000)
  check('F19.2', '/me 네트워크 실패(캐시 없음)에도 학급 시간표(참고) 표시', offline && (await refExpanded(page, true)) && (await visible(refList(page).getByText('국어'), 10000)))

  mode = null
  await region.getByRole('button', { name: '다시 시도' }).first().click()
  check('F19.3', '다시 시도 → 정상 상태 카드로 복구(학급 시간표(참고)는 그대로)', (await visible(region.getByText('아직 연결된 수업이 없어요'), 15000)) && (await refExpanded(page, true, 3000)))
  await ctx.close()

  mode = { status: 500, code: 'load-failed' }
  const t = await openAs(browser, 'n@u1.e2e.kr', `/student/timetable?date=${TODAY}`, setup)
  check('F19.4', '/student/timetable도 /me 500일 때 학급 시간표(참고) 표시', (await refExpanded(t.page, true)) && (await visible(refList(t.page).getByText('국어'), 10000)))
  await t.ctx.close()
}

async function f20NowPeriodInReference(browser) {
  // 10:00 KST = 고등학교 기본 교시표 2교시(09:40~10:30) — 예전 TodayCard처럼 '지금' 표시
  const errors = []
  const { ctx, page } = await newPage(browser, { fixedTime: '2026-10-06T10:00:00+09:00', errors, who: 'n@u1.e2e.kr' })
  await uiLogin(page, 'n@u1.e2e.kr')
  if (!page.url().endsWith('/student/today')) await page.goto(BASE + '/student/today', { waitUntil: 'load' })
  await refExpanded(page, true)
  const row = refList(page).getByRole('listitem').filter({ hasText: '수학' }).first()
  const rowText = (await visible(row, 10000)) ? await row.innerText() : ''
  const other = await refList(page).getByRole('listitem').filter({ hasText: '국어' }).first().innerText().catch(() => '')
  check('F20.1', "학급 시간표(참고): 수업 중인 2교시(수학)에 '지금' + 교시 시각 09:40~10:30", rowText.includes('지금') && rowText.includes('09:40~10:30') && !other.includes('지금'), rowText.replace(/\n/g, ' '))
  await page.getByRole('button', { name: '다음 날' }).first().click()
  await navHas(page, ['내일'])
  check('F20.2', "다른 날짜에는 '지금' 표시 없음", !(await visible(refList(page).getByText('지금', { exact: true }), 2000)))
  await shot(page, 'F20-now-period')
  await ctx.close()
}

async function f18EveningBagLink(browser) {
  // 저녁 '내일 가방' 알림 주소(/student/today?date=내일): 가방 체크리스트가 있는 홈 + 개인 시간표 카드는 내일
  const { ctx, page } = await openAs(browser, 'p@u1.e2e.kr', '/student/today?date=20261007')
  const nav = await navHas(page, ['내일', '10월 7일 (수)'])
  const bag = await visible(page.getByRole('heading', { name: '내일 가방 싸기' }))
  check('F18.1', "'내일 가방' 알림 링크 → 홈(가방 체크리스트 \"내일 가방 싸기\") + 개인 시간표 카드는 내일(10월 7일 (수))", nav.ok && bag, nav.text)
  await ctx.close()
}

async function main() {
  await seed()
  note('setup', `고정 시각 ${FIXED}, 학교 S1, 수업 문학(3-4 공통)·생활과 과학 A·영어 B·영어 C·수학 C(시간표 없음)·물리 D, 10/9 한글날, P(직접 입력만)·Q(3-5 승인 대기)`)
  const browser = await launchBrowser()
  try {
    await t01GroupLegacyStudent(browser)
    const a = await t03t13HomeLayout(browser)
    await t16t36Change(browser, a)
    await a.ctx.close()
    await t11t12DateNav(browser)
    await t34States(browser)
    await t35Errors(browser)
    await f16PersonalOnlyKeepsReference(browser)
    await f17PendingSeesReference(browser)
    await f19MeFailureKeepsReference(browser)
    await f20NowPeriodInReference(browser)
    await f18EveningBagLink(browser)
    await t37t10OfflineAndAccount(browser)
  } catch (e) {
    check('X', '시나리오 예외', false, e?.stack || String(e))
  } finally {
    await browser.close()
  }
  process.exit(finish() ? 1 : 0)
}

await main()
