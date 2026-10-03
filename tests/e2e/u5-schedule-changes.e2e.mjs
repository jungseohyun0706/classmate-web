// U5 교사용 공식 일정 변경 화면 E2E — /teacher/schedule-changes (+ 학생 /student/timetable 반영 확인)
// 대상 요구: R09·R10·R11(이 날짜만)·R16, 검수 T16·T17·T26·T27·T40 (+ T39 역할 가드, T45 좁은 화면, T46 민감정보)
// 사용: BASE=http://127.0.0.1:3100 node tests/e2e/u5-schedule-changes.e2e.mjs
// 서버 전제: 로컬 Firebase 에뮬레이터(Firestore 8080, Auth 9099, 규칙 firestore.rules) + Next 서버(NEXT_PUBLIC_USE_EMULATORS=1)
//           + NEIS mock(NODE_OPTIONS="--require <repo>/tests/support/neis-mock.cjs" NEIS_MOCK_FILE=<repo>/tests/fixtures/neis-mock.runtime.json)
// 모든 데이터는 에뮬레이터의 테스트용 가상 데이터이며 실제 학생 정보가 아닙니다.
import { admin, wipe, createUsers, writeNeisFixture, clientSession, api, reporter, launchBrowser, newPage, uiLogin, sleep, Timestamp, BASE } from './lib/env.mjs'

const { OUT, check, note, finish } = reporter('u5-schedule-changes')
const FIXED = '2026-10-06T08:00:00+09:00' // 화요일 아침(1교시 전)
const D16 = '20261006' // T16 영어 B 3교시 → 2교시
const D27 = '20261013' // T27 낡은 revision으로 교실 변경
const D27X = '20261103' // T27 '다른 탭'에서 먼저 발행하는 변경(취소)
const D17 = '20261020' // T17·T40 영어 B ↔ 생활과 과학 A 교시 교환(승인 요청)
const D26 = '20261027' // T26 같은 교사 시간 겹침(영어 B → 1교시, 영어 A 1교시)
const S1 = { schoolCode: 'S1', schoolName: '테스트고등학교', officeCode: 'B10' }
const STUDENT_NAMES = ['테스트학생가', '테스트학생나', '테스트학생다']
const iso = (ymd) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`

async function seed() {
  await wipe()
  writeNeisFixture({
    schools: [{ SD_SCHUL_CODE: 'S1', SCHUL_NM: '테스트고등학교', SCHUL_KND_SC_NM: '고등학교', ATPT_OFCDC_SC_CODE: 'B10' }],
    meals: [],
    timetables: {},
    schedule: [],
  })
  const T = (name) => ({ role: 'teacher', name, displayName: name, ...S1 })
  const St = (name, classId, grade, classNm, studentId) => ({ role: 'student', status: 'approved', name, displayName: name, classId, grade, classNm, studentId, ...S1 })
  await createUsers([
    { uid: 'tx', email: 'tx@e2e.kr', doc: T('김과학') }, // 교사 X: 생활과 과학 A
    { uid: 'ty', email: 'ty@e2e.kr', doc: T('이영어') }, // 교사 Y: 영어 B(+ 영어 A — 교사 충돌용)
    { uid: 'stuA', email: 'a@e2e.kr', doc: St(STUDENT_NAMES[0], 'S1_3_4', 3, 4, 1) }, // 생활과 과학 A + 영어 B
    { uid: 'stuB', email: 'b@e2e.kr', doc: St(STUDENT_NAMES[1], 'S1_3_5', 3, 5, 2) }, // 영어 B만
    { uid: 'stuC', email: 'c@e2e.kr', doc: St(STUDENT_NAMES[2], 'S1_3_4', 3, 4, 3) }, // 영어 B 안 들음(생활과 과학 A만)
  ])
  const { db } = admin()
  const now = Timestamp.now()
  await db.doc('classes/S1_3_4').set({ classId: 'S1_3_4', grade: 3, classNm: 4, teacherId: 'tx', teacherName: '김과학', createdAt: now, ...S1 })
  await db.doc('classes/S1_3_5').set({ classId: 'S1_3_5', grade: 3, classNm: 5, teacherId: 'ty', teacherName: '이영어', createdAt: now, ...S1 })
  const s = db.doc('schools/S1')
  await s.set({ name: '테스트고등학교', kind: '고등학교', scheduleRevision: 0, timezone: 'Asia/Seoul' })
  await s.collection('terms').doc('2026-2').set({ name: '2026학년도 2학기', startDate: '20260816', endDate: '20270301' })
  const course = (id, title, subject, section, teacher, teacherName, room) =>
    s.collection('courses').doc(id).set({
      schoolCode: 'S1', termId: '2026-2', title, subject, section, teacherUids: [teacher], teacherNames: [teacherName], status: 'active', endedOn: null,
      commonForHomerooms: [], defaultRoomName: room, invitePolicy: 'auto', catalogVisible: false, source: 'manual', createdBy: teacher, createdAt: now, updatedAt: now, revision: 0,
    })
  await course('sciA', '생활과 과학 A', '생활과 과학', 'A', 'tx', '김과학', '3학년 4반 교실')
  await course('engB', '영어 B', '영어', 'B', 'ty', '이영어', '3학년 5반 교실')
  await course('engA', '영어 A', '영어', 'A', 'ty', '이영어', '어학실 2')
  const ser = (id, courseId, weekday, period) =>
    s.collection('series').doc(id).set({ courseId, termId: '2026-2', weekday, period, validFrom: '20260816', validTo: null, status: 'active', createdBy: 'seed', createdAt: now })
  await ser('sr_sciA_tue4', 'sciA', 2, 4)
  await ser('sr_engB_tue3', 'engB', 2, 3)
  await ser('sr_engA_tue1', 'engA', 2, 1)
  const en = (courseId, uid) =>
    s.collection('enrollments').doc(`${courseId}__${uid}`).set({ courseId, uid, schoolCode: 'S1', termId: '2026-2', status: 'active', source: 'admin', createdAt: now, updatedAt: now })
  await en('sciA', 'stuA')
  await en('engB', 'stuA')
  await en('engB', 'stuB')
  await en('sciA', 'stuC')
}

// ───────── 화면 도우미(선택자는 화면 텍스트·role 기반) ─────────
const errors = []
const bodyText = (page) => page.locator('body').innerText()

async function waitText(page, re, timeout = 25000) {
  try {
    await page.waitForFunction((src) => new RegExp(src).test(document.body.innerText), re.source, { timeout })
  } catch (e) {
    // 실패 원인 확인용: 그 순간 화면 문구 일부를 남김
    const t = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ')
    console.log(`waitText 실패(${re.source}) — 화면: ${t.slice(-900)}`)
    await page.screenshot({ path: `${OUT}/waitText-fail.png`, fullPage: true }).catch(() => {})
    throw e
  }
}

async function openChanges(page, query = '') {
  await page.goto(BASE + '/teacher/schedule-changes' + query, { waitUntil: 'load' })
  await page.getByRole('heading', { name: '시간표 변경' }).waitFor({ timeout: 25000 })
}

async function selectCourse(page, title) {
  const btn = page.getByRole('region', { name: '수업 선택' }).getByRole('button', { name: new RegExp('^' + title) }).first()
  await btn.waitFor({ timeout: 25000 })
  await btn.click()
}

async function setDate(page, ymd) {
  await page.getByLabel('날짜', { exact: true }).fill(iso(ymd))
}

async function pickOcc(page, title, period) {
  const btn = page.getByRole('button', { name: new RegExp(`^${title} ${period}교시`) }).first()
  await btn.waitFor({ timeout: 25000 })
  await btn.click()
}

async function previewDraft(page, reason) {
  await page.getByLabel('변경 사유').fill(reason)
  await page.getByRole('button', { name: '미리보기', exact: true }).click()
  const pv = page.getByRole('region', { name: '변경 미리보기' })
  await pv.waitFor({ timeout: 25000 })
  return pv
}

async function waitEnabled(page, name, timeout = 25000) {
  await page.waitForFunction(
    (n) => Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === n && !b.disabled),
    name,
    { timeout }
  )
}

async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
}

async function studentDay(browser, email, ymd, shot) {
  const { ctx, page } = await newPage(browser, { fixedTime: FIXED, errors, who: email })
  try {
    await uiLogin(page, email)
    await page.goto(`${BASE}/student/timetable?date=${ymd}`, { waitUntil: 'load' })
    await page.waitForFunction(() => /영어 B|생활과 과학 A|수업이 없어요|불러오지 못했어요/.test(document.body.innerText), null, { timeout: 25000 }).catch(() => {})
    await sleep(1500)
    const text = await bodyText(page)
    await page.screenshot({ path: `${OUT}/${shot}.png`, fullPage: true })
    return text
  } finally {
    await ctx.close()
  }
}

async function main() {
  await seed()
  const { db } = admin()
  const revisionNow = async () => Number((await db.doc('schools/S1').get()).get('scheduleRevision') || 0)
  const changeSets = async () => (await db.collection('schools/S1/changeSets').get()).docs.map((d) => ({ id: d.id, ...d.data() }))
  const overridesOn = async (key) => (await db.collection('schools/S1/overrides').where('occurrenceKey', '==', key).get()).docs.map((d) => d.data())
  note('setup', `FIXED=${FIXED}, T16=${D16}, T27=${D27}(+${D27X}), T17=${D17}, T26=${D26}`)

  const browser = await launchBrowser()
  try {
    // ───── T39: 학생은 이 화면을 쓸 수 없음(안내 후 홈으로) ─────
    {
      const { ctx, page } = await newPage(browser, { fixedTime: FIXED, errors, who: 'stuA-guard' })
      await uiLogin(page, 'a@e2e.kr')
      await page.goto(BASE + '/teacher/schedule-changes', { waitUntil: 'load' })
      const ok = await page.waitForURL(/\/student\/today/, { timeout: 20000 }).then(() => true, () => false)
      check('T39', '학생이 /teacher/schedule-changes → 학생 홈으로 돌려보냄', ok, page.url())
      await ctx.close()
    }

    // ───── T16: 교사 Y — 영어 B 10/6(화) 3교시 → 2교시 ─────
    const ty = await newPage(browser, { fixedTime: FIXED, errors, who: 'ty' })
    await uiLogin(ty.page, 'ty@e2e.kr')
    await openChanges(ty.page)
    await selectCourse(ty.page, '영어 B')
    await pickOcc(ty.page, '영어 B', 3) // 고정 시각의 학교 날짜(10/6)가 기본 날짜
    await ty.page.getByRole('radio', { name: '교시·시각 이동', exact: true }).check()
    await ty.page.getByLabel('바꿀 교시').selectOption('2')
    await ty.page.getByRole('button', { name: '변경 목록에 추가' }).click()
    let pv = await previewDraft(ty.page, '학교 행사')
    let pvText = await pv.innerText()
    await ty.page.screenshot({ path: `${OUT}/T16-preview.png`, fullPage: true })
    check('T16', '미리보기: 영향 학생 수 2명(명단 없이 수만)', /영향 학생\s*2명/.test(pvText), pvText.slice(0, 300))
    check('T16', '미리보기: 변경 전후 "3교시 → 2교시" + 텍스트 배지 "시간 변경"', /3교시 → 2교시/.test(pvText) && pvText.includes('시간 변경'), pvText.slice(0, 300))
    const t16Body = await bodyText(ty.page)
    check('T46', '교사 화면에 학생 이름·내부 id(courseId·seriesId·occurrenceKey·uid) 없음',
      !new RegExp(STUDENT_NAMES.join('|') + '|stu[ABC]|engB|sciA|sr_engB|@2026|cs_|\\bty\\b').test(t16Body), '')
    check('T45', '390px 폭에서 가로 스크롤 없음(미리보기 화면)', await noHorizontalScroll(ty.page))
    await ty.page.getByRole('button', { name: '발행하기' }).click()
    await waitText(ty.page, /발행했어요/)
    let sets = await changeSets()
    check('T16', '발행 200: 변경 묶음 1개 published, scheduleRevision 0 → 1',
      sets.length === 1 && sets[0].status === 'published' && (await revisionNow()) === 1, JSON.stringify(sets.map((x) => [x.status, x.revision])))
    const ov16 = await overridesOn(`sr_engB_tue3@${D16}`)
    check('T16', '저장된 변경: 영어 B 10/6 차시 reschedule → 2교시(교실 칸 덮어쓰기 아님, 수업반 차시 단위)',
      ov16.length === 1 && ov16[0].kind === 'reschedule' && ov16[0].target?.period === 2 && ov16[0].courseId === 'engB', JSON.stringify(ov16))

    // 학생 화면 반영(학생 개인 시간표 화면은 다른 그룹 담당 — 배지 문구 '시간 변경' 기준)
    const aText = await studentDay(browser, 'a@e2e.kr', D16, 'T16-studentA')
    check('T16', '학생 A(/student/timetable?date=20261006): 영어 B에 "시간 변경" 배지', aText.includes('영어 B') && aText.includes('시간 변경'), aText.slice(0, 400))
    const bText = await studentDay(browser, 'b@e2e.kr', D16, 'T16-studentB')
    check('T16', '학생 B(영어 B만): "시간 변경" 배지', bText.includes('영어 B') && bText.includes('시간 변경'), bText.slice(0, 400))
    const cText = await studentDay(browser, 'c@e2e.kr', D16, 'T16-studentC')
    check('T16', '학생 C(영어 B 안 들음): 영어 B·변경 배지 없음, 생활과 과학 A는 그대로', !cText.includes('영어 B') && !cText.includes('시간 변경') && cText.includes('생활과 과학 A'), cText.slice(0, 400))

    // ───── T27: 낡은 revision으로 발행 → stale 안내 → 최신으로 다시 미리보기 → 발행 ─────
    await openChanges(ty.page)
    await selectCourse(ty.page, '영어 B')
    await setDate(ty.page, D27)
    await pickOcc(ty.page, '영어 B', 3)
    await ty.page.getByRole('radio', { name: '교실 변경', exact: true }).check()
    await ty.page.getByLabel('바꿀 교실').fill('시청각실')
    await ty.page.getByRole('button', { name: '변경 목록에 추가' }).click()
    pv = await previewDraft(ty.page, '교실 공사')
    pvText = await pv.innerText()
    check('T27', '미리보기: 교실 변경 전후(3학년 5반 교실 → 시청각실) + "교실 변경" 배지', /3학년 5반 교실 → 시청각실/.test(pvText) && pvText.includes('교실 변경'), pvText.slice(0, 300))
    const revSeen = await revisionNow()
    // 같은 교사가 다른 탭에서 먼저 발행(= API로 revision을 올림)
    const sess = await clientSession('ty@e2e.kr')
    const other = await api('/api/schedule-changes', sess.token, {
      action: 'publish', mutationId: 'u5-other-tab-0001', expectedRevision: revSeen, reason: '다른 탭',
      items: [{ op: 'cancel', courseId: 'engB', occurrenceKey: `sr_engB_tue3@${D27X}` }],
    })
    await sess.close()
    check('T27', '다른 탭(API)에서 먼저 발행 → revision +1', other.status === 200 && (await revisionNow()) === revSeen + 1, `${other.status} ${other.j.code || other.j.status}`)
    await ty.page.getByRole('button', { name: '발행하기' }).click()
    await waitText(ty.page, /다른 변경이 먼저 발행됐어요/)
    await ty.page.screenshot({ path: `${OUT}/T27-stale.png`, fullPage: true })
    check('T27', '낡은 revision 발행 → "다른 변경이 먼저 발행됐어요" 안내, 아무것도 덮어쓰지 않음',
      (await overridesOn(`sr_engB_tue3@${D27}`)).length === 0 && (await revisionNow()) === revSeen + 1)
    await ty.page.getByRole('button', { name: '최신 시간표로 다시 미리보기' }).click()
    await waitEnabled(ty.page, '발행하기')
    await ty.page.getByRole('button', { name: '발행하기' }).click()
    await waitText(ty.page, /발행했어요/)
    const ov27 = await overridesOn(`sr_engB_tue3@${D27}`)
    check('T27', '최신 시간표로 다시 미리보기 후 발행 성공(revision +1, 교실 시청각실)',
      ov27.length === 1 && ov27[0].target?.roomName === '시청각실' && (await revisionNow()) === revSeen + 2, JSON.stringify(ov27.map((o) => o.target)))

    // ───── T17·T40: 교사 Y가 영어 B ↔ 생활과 과학 A(교사 X 담당) 교환 → 승인 요청(202) ─────
    await openChanges(ty.page)
    await selectCourse(ty.page, '영어 B')
    await ty.page.getByRole('button', { name: /다른 선생님 수업 추가/ }).click()
    await ty.page.getByLabel('다른 수업 찾기').fill('생활과')
    const otherBtn = ty.page.getByRole('button', { name: /^생활과 과학 A/ }).first()
    await otherBtn.waitFor({ timeout: 25000 })
    await otherBtn.click()
    // 검토 결함 [10]: 보강 추가 패널의 수업(영어 B)을 수업 선택에서 빼면 패널이 닫힘 — 목록에 없는 수업으로 보강을 추가하지 않음
    {
      const mkGroup = ty.page.getByRole('group', { name: '보강 추가' })
      const mkSelect = mkGroup.getByLabel('보강 수업', { exact: true })
      await ty.page.getByRole('button', { name: '+ 보강 추가' }).click()
      await mkGroup.waitFor({ timeout: 25000 })
      const before = await mkSelect.evaluate((el) => el.options[el.selectedIndex]?.textContent || '')
      await selectCourse(ty.page, '영어 B') // 선택 해제
      const closed = await mkGroup.waitFor({ state: 'detached', timeout: 10000 }).then(() => true, () => false)
      await ty.page.getByRole('button', { name: '+ 보강 추가' }).click()
      await mkGroup.waitFor({ timeout: 25000 })
      const options = await mkSelect.evaluate((el) => Array.from(el.options).map((o) => o.textContent))
      await mkGroup.getByRole('button', { name: '닫기' }).click()
      check('RV10', '보강 패널의 수업(영어 B)을 선택에서 빼면 패널이 닫히고, 다시 열면 남은 수업(생활과 과학 A)만 고를 수 있음',
        before === '영어 B' && closed && JSON.stringify(options) === '["생활과 과학 A"]', JSON.stringify({ before, closed, options }))
      await selectCourse(ty.page, '영어 B') // 다시 선택(아래 교시 교환에 씀)
    }
    await setDate(ty.page, D17)
    await pickOcc(ty.page, '영어 B', 3)
    await pickOcc(ty.page, '생활과 과학 A', 4)
    await ty.page.getByRole('button', { name: '서로 바꾸기' }).click()
    pv = await previewDraft(ty.page, '교시 교환')
    pvText = await pv.innerText()
    await ty.page.screenshot({ path: `${OUT}/T17-swap-preview.png`, fullPage: true })
    check('T17', '교환 미리보기: 두 수업 모두 전후 표시(3교시 → 4교시, 4교시 → 3교시), 최종 상태 기준 충돌 없음',
      /3교시 → 4교시/.test(pvText) && /4교시 → 3교시/.test(pvText) && !/충돌 \d+건/.test(pvText), pvText.slice(0, 500))
    check('T40', '미리보기: 다른 선생님 수업 포함 → "승인 필요" 안내와 "승인 요청 보내기" 버튼',
      pvText.includes('승인 필요') && (await ty.page.getByRole('button', { name: '승인 요청 보내기' }).count()) === 1, pvText.slice(-300))
    const revBeforeSwap = await revisionNow()
    await ty.page.getByRole('button', { name: '승인 요청 보내기' }).click()
    await waitText(ty.page, /승인 요청을 보냈어요/)
    sets = await changeSets()
    const pending = sets.find((x) => x.status === 'pending-approval')
    check('T40', '담당 아닌 수업이 낀 교환 → 202 승인 대기(교사 X 승인 필요), 시간표 버전 그대로',
      !!pending && JSON.stringify(pending.approvals) === '{"tx":false}' && (await revisionNow()) === revBeforeSwap, JSON.stringify(pending ? pending.approvals : sets.map((x) => x.status)))
    const reqNotif = pending ? await db.doc(`users/tx/notifications/schedreq_${pending.id}`).get() : null
    const reqUrl = reqNotif?.exists ? reqNotif.get('url') : null
    check('T40', '교사 X에게 승인 요청 알림(링크 /teacher/schedule-changes?changeSetId=…)', !!reqUrl && reqUrl === `/teacher/schedule-changes?changeSetId=${pending?.id}`, String(reqUrl))
    await ty.ctx.close()

    // 교사 X: 알림 링크로 들어와 승인
    const tx = await newPage(browser, { fixedTime: FIXED, errors, who: 'tx' })
    await uiLogin(tx.page, 'tx@e2e.kr')
    await openChanges(tx.page, reqUrl ? reqUrl.replace('/teacher/schedule-changes', '') : '')
    const tabSelected = await tx.page.getByRole('tab', { name: /승인 요청/ }).getAttribute('aria-selected')
    const card = tx.page.getByRole('article', { name: /이영어 선생님의 변경 요청/ }).first()
    await card.waitFor({ timeout: 25000 })
    const cardText = await card.innerText()
    await tx.page.screenshot({ path: `${OUT}/T40-approval.png`, fullPage: true })
    check('T40', '알림 링크(?changeSetId=)로 승인 요청 탭이 열리고 그 요청이 펼쳐짐(변경 전후·영향 학생 수)',
      tabSelected === 'true' && /3교시 → 4교시/.test(cardText) && /영향 학생\s*3명/.test(cardText), `${tabSelected} ${cardText.slice(0, 300)}`)
    check('T46', '승인 화면에 학생 이름·내부 id 없음', !new RegExp(STUDENT_NAMES.join('|') + '|stu[ABC]|engB|sciA|sr_|cs_').test(await bodyText(tx.page)))
    check('T45', '390px 폭에서 가로 스크롤 없음(승인 요청)', await noHorizontalScroll(tx.page))
    await card.getByRole('button', { name: '승인', exact: true }).click()
    await waitText(tx.page, /승인해서 발행했어요/)
    sets = await changeSets()
    const done = sets.find((x) => x.id === pending?.id)
    const swapOvs = (await db.collection('schools/S1/overrides').where('changeSetId', '==', pending?.id || '-').get()).docs.map((d) => d.data())
    check('T17', '교사 X 승인 → 한 묶음으로 발행(변경 2건 같은 changeSet·같은 revision, 버전 +1 한 번)',
      done?.status === 'published' && swapOvs.length === 2 && swapOvs[0].revision === swapOvs[1].revision && (await revisionNow()) === revBeforeSwap + 1,
      JSON.stringify({ s: done?.status, n: swapOvs.length, r: swapOvs.map((o) => o.revision) }))
    const aSwap = await studentDay(browser, 'a@e2e.kr', D17, 'T17-studentA')
    check('T17', '학생 A(두 수업): 10/20 두 수업 모두 "시간 변경" 표시', aSwap.includes('영어 B') && aSwap.includes('생활과 과학 A') && aSwap.includes('시간 변경'), aSwap.slice(0, 400))
    await tx.ctx.close()

    // ───── T26: 같은 교사 시간 겹침 경고 → 확인 후 발행 ─────
    const ty2 = await newPage(browser, { fixedTime: FIXED, errors, who: 'ty-2' })
    await uiLogin(ty2.page, 'ty@e2e.kr')
    await openChanges(ty2.page)
    await selectCourse(ty2.page, '영어 B')
    await setDate(ty2.page, D26)
    await pickOcc(ty2.page, '영어 B', 3)
    await ty2.page.getByLabel('바꿀 교시').selectOption('1')
    await ty2.page.getByRole('button', { name: '변경 목록에 추가' }).click()
    pv = await previewDraft(ty2.page, '교사 겹침 확인')
    pvText = await pv.innerText()
    await ty2.page.screenshot({ path: `${OUT}/T26-conflict.png`, fullPage: true })
    check('T26', '미리보기: 교사 겹침 경고(같은 선생님 이영어, 영어 A 1교시)', pvText.includes('교사 겹침') && pvText.includes('이영어') && pvText.includes('영어 A'), pvText.slice(0, 500))
    const publishBtn = ty2.page.getByRole('button', { name: '발행하기' })
    check('T26', '충돌 확인 전에는 발행 버튼 비활성', await publishBtn.isDisabled())
    await ty2.page.getByLabel('충돌을 확인했고 그래도 발행').check()
    await waitEnabled(ty2.page, '발행하기')
    await publishBtn.click()
    await waitText(ty2.page, /발행했어요/)
    const ack = (await changeSets()).find((x) => (x.items || []).some((i) => i.occurrenceKey === `sr_engB_tue3@${D26}`))
    check('T26', '확인 후 발행: 충돌을 묶음에 기록(conflictsAcknowledged)', ack?.status === 'published' && ack?.conflictsAcknowledged === true && (ack?.conflicts || []).some((c) => c.kind === 'teacher'), JSON.stringify(ack ? { s: ack.status, a: ack.conflictsAcknowledged } : null))

    // ───── 변경 이력 탭(T23 성격: 이력 유지 표시) ─────
    await ty2.page.getByRole('tab', { name: '변경 이력' }).click()
    await ty2.page.getByLabel('수업', { exact: true }).selectOption({ label: '영어 B' })
    await waitText(ty2.page, /3교시 → 2교시/)
    const histText = await bodyText(ty2.page)
    check('T16', '변경 이력: 영어 B 묶음들이 상태(발행됨) 텍스트와 함께 보임', (histText.match(/발행됨/g) || []).length >= 3 && histText.includes('3교시 → 2교시'), '')
    await ty2.ctx.close()

    const pageErrors = errors.filter((e) => e.kind === 'pageerror')
    check('T45', '페이지 오류(pageerror) 없음', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)))
    if (errors.length) note('console', JSON.stringify(errors.slice(0, 10)))
  } finally {
    await browser.close()
  }
}

let failed = 1
try {
  await main()
  failed = finish()
} catch (e) {
  check('X', 'U5 시나리오 예외', false, e.stack)
  failed = finish()
}
process.exit(failed ? 1 : 0)
