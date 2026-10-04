// U7 학생 '수업 담기(골라 담기)' E2E — 요구 R20
// 대상: /student/courses #catalog(시간표 칸 보기·과목으로 찾기·학년 거르기·담은 수업·겹침 경고·한 번에 담기·결과),
//       #mine(내가 담은 수업 빼기 / 학교가 넣어 준 수업은 '선생님께 문의'), #personal(학교 밖 일정 안내·'이 시간 학교 수업' 담기·연결·겹침 안내),
//       /student/today('수업 담기' 진입·오늘의 내 시간표 반영), /teacher/timetable-import(학생 수업 담기 공개 선택), 교사 수업 '대상 학년'
// 실행 전제: 실제 서버(BASE, NEXT_PUBLIC_USE_EMULATORS=1 빌드) + Firebase 에뮬레이터(Firestore 8080·Auth 9099) + NEIS mock
// 사용: BASE=http://127.0.0.1:3200 node tests/e2e/u7-course-picker.e2e.mjs [label]
// 브라우저 시각은 고정하지 않음(서버와 같은 실제 시각) — 수업 칸은 서버 '오늘'의 요일에 둡니다(주말이면 토·일 칸이 생김).
// 엑셀 읽기 라이브러리(xlsx)를 설치하지 못해 가짜(stub)로 빌드된 환경에서는, 교사 가져오기 화면이 받는 그 조각만
// 실제 SheetJS(XLSX_FULL_JS=…/xlsx.full.min.js 또는 node_modules/xlsx/dist)로 바꿔 줍니다. 실제 라이브러리로 빌드됐으면 아무것도 바꾸지 않음.
// 모든 데이터는 에뮬레이터의 테스트용 가상 데이터이며 실제 학생 정보가 아닙니다.
import fs from 'fs'
import path from 'path'
import { admin, wipe, createUsers, writeNeisFixture, reporter, launchBrowser, newPage, uiLogin, sleep, Timestamp, BASE, require as req } from './lib/env.mjs'

const LABEL = process.argv[2] || 'u7-course-picker'
const { OUT, check, note, finish } = reporter(LABEL)

const ymdOf = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
const toDate = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)))
const weekdayOf = (ymd) => toDate(ymd).getUTCDay() || 7
const TODAY = ymdOf(new Date(Date.now() + 9 * 3600 * 1000))
function termOf(ymd) {
  const y = Number(ymd.slice(0, 4))
  const md = ymd.slice(4)
  if (md >= '0301' && md < '0816') return { id: `${y}-1`, start: `${y}0301` }
  const ay = md < '0301' ? y - 1 : y
  return { id: `${ay}-2`, start: `${ay}0816` }
}
const TERM = termOf(TODAY)
const D = weekdayOf(TODAY) // 오늘 요일 — 담은 수업이 홈 '오늘의 내 시간표'에 바로 보이게
const E = D === 1 ? 2 : 1
const WD = ['', '월', '화', '수', '목', '금', '토', '일']
const WDL = ['', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일']
const S1 = { schoolCode: 'S1', schoolName: '테스트고등학교', officeCode: 'B10' }

const U = { pk: 'stuPk7q', ot: 'stuOt7w', ty: 'tchTy7r' }
const C = { lit: 'e2eU7Lit', sci: 'e2eU7Sci', art: 'e2eU7Art', phys: 'e2eU7Phys', g1: 'e2eU7G1', chem: 'e2eU7Chem', hidden: 'e2eU7Hidden' }
const INTERNAL_IDS = [...Object.values(U), ...Object.values(C)]

async function seed() {
  await wipe()
  writeNeisFixture({
    schools: [{ SD_SCHUL_CODE: 'S1', SCHUL_NM: '테스트고등학교', SCHUL_KND_SC_NM: '고등학교', ATPT_OFCDC_SC_CODE: 'B10' }],
    meals: [],
    timetables: {},
    schedule: [],
  })
  const St = (name, classId, grade, classNm) => ({ role: 'student', status: 'approved', name, displayName: name, classId, grade, classNm, ...S1 })
  await createUsers([
    { uid: U.pk, email: 'pk@u7.e2e.kr', doc: St('김담기', 'S1_3_4', 3, 4) },
    { uid: U.ot, email: 'ot@u7.e2e.kr', doc: St('이다른', 'S1_3_4', 3, 4) },
    { uid: U.ty, email: 'ty@u7.e2e.kr', doc: { role: 'teacher', name: '최과학', displayName: '최과학', masterName: '최과학', ...S1 } },
  ])
  const { db } = admin()
  const now = Timestamp.now()
  await db.doc('schools/S1').set({ name: '테스트고등학교', kind: '고등학교', officeCode: 'B10', timezone: 'Asia/Seoul', scheduleRevision: 1, updatedAt: now })
  await db.doc('classes/S1_3_4').set({ classId: 'S1_3_4', grade: 3, classNm: 4, teacherId: 'hr4x', teacherName: '김담임', createdAt: now, ...S1 })
  const course = (id, title, subject, section, teacher, extra = {}) =>
    db.doc(`schools/S1/courses/${id}`).set({
      schoolCode: 'S1', termId: TERM.id, title, subject, section: section || null, teacherUids: [U.ty], teacherNames: [teacher], managerUids: [],
      status: 'active', endedOn: null, commonForHomerooms: [], defaultRoomName: null, invitePolicy: 'auto', catalogVisible: true,
      source: 'manual', createdBy: U.ty, createdAt: now, updatedAt: now, revision: 1, ...extra,
    })
  await course(C.lit, '문학', '문학', null, '한국어', { commonForHomerooms: ['S1_3_4'], catalogVisible: false, source: 'homeroom-common', invitePolicy: 'approval' })
  await course(C.sci, '생활과 과학 A', '생활과 과학', 'A', '최과학', { grades: [3] })
  await course(C.art, '미술 창작', '미술', null, '유미술') // 대상 학년 미상 → 모든 학년에 보임
  await course(C.phys, '물리 D', '물리학', 'D', '강물리', { invitePolicy: 'approval', grades: [3] })
  await course(C.g1, '1학년 수학 보충', '수학', null, '오수학', { grades: [1] })
  await course(C.chem, '화학 실험', '화학', null, '정화학', { grades: [2, 3] })
  await course(C.hidden, '비공개 동아리', '동아리', null, '한비밀', { catalogVisible: false })
  const series = (id, courseId, weekday, period, roomName) =>
    db.doc(`schools/S1/series/${id}`).set({ courseId, termId: TERM.id, weekday, period, start: null, end: null, roomName, validFrom: TERM.start, validTo: null, status: 'active', createdBy: 'seed', createdAt: now })
  await series('u7SerLit', C.lit, D, 1, '3학년 4반 교실')
  await series('u7SerSci1', C.sci, D, 3, '과학실')
  await series('u7SerSci2', C.sci, E, 2, '과학실')
  await series('u7SerArt', C.art, D, 3, '미술실')
  await series('u7SerG1', C.g1, D, 4, '1학년 교실')
  await series('u7SerPhys', C.phys, D, 5, '물리실')
  await series('u7SerChem', C.chem, D, 6, '화학실')
  await series('u7SerHidden', C.hidden, D, 7, '동아리실')
  // 학교 수업과 같은 시간(오늘 요일 5교시)에 적어 둔 직접 입력 일정(연결 안 됨) — 겹침 안내 확인용
  await db.doc(`users/${U.pk}/personalEntries/u7Entry1`).set({
    title: '자습', kind: 'weekly', weekday: D, date: null, period: 5, start: null, end: null, roomName: null, memo: null, linkedCourseId: null,
    createdAt: now, updatedAt: now,
  })
}

// ───────────────────────── 화면 도우미 ─────────────────────────

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
const region = (page, name) => page.getByRole('region', { name }).first()
const art = (scope, name) => scope.getByRole('article', typeof name === 'string' ? { name, exact: true } : { name })
async function articleText(scope, name, timeout = 10000) {
  const a = art(scope, name).first()
  if (!(await visible(a, timeout))) return null
  return (await a.innerText()).replace(/\n/g, ' ')
}
async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true }).catch(() => {})
}
async function confirmSheet(page, buttonName) {
  const d = page.getByRole('dialog').last()
  await d.waitFor({ state: 'visible', timeout: 10000 })
  const text = (await d.innerText()).replace(/\n/g, ' ')
  await d.getByRole('button', { name: buttonName, exact: true }).click()
  await gone(d, 5000)
  return text
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
async function enrollmentOf(courseId, uid = U.pk) {
  const { db } = admin()
  return (await db.doc(`schools/S1/enrollments/${courseId}__${uid}`).get()).data() || null
}
async function until(fn, ms = 10000) {
  const end = Date.now() + ms
  let v = await fn()
  while (!v && Date.now() < end) {
    await sleep(300)
    v = await fn()
  }
  return v
}

/** 실제 SheetJS 위치(가짜로 빌드된 환경용) — 없으면 null */
function realXlsxPath() {
  const cands = [process.env.XLSX_FULL_JS]
  try {
    cands.push(req.resolve('xlsx/dist/xlsx.full.min.js'))
  } catch {
    // 가짜 패키지에는 dist가 없음
  }
  return cands.find((p) => p && fs.existsSync(p)) || null
}

/** 가짜 xlsx 조각(webpack chunk)을 실제 라이브러리로 바꿔 내려줌. 바꿨는지 기록 */
async function useRealXlsx(page, state) {
  await page.route('**/_next/static/chunks/**', async (route) => {
    const resp = await route.fetch()
    const body = await resp.text()
    if (!body.includes('xlsx stub')) return route.fulfill({ response: resp, body })
    const lib = realXlsxPath()
    const m = /push\(\[\[(\d+)\],\{(\d+):/.exec(body)
    if (!lib || !m) {
      state.stub = 'no-real-lib'
      return route.fulfill({ response: resp, body })
    }
    state.stub = 'replaced'
    const code = fs.readFileSync(lib, 'utf8')
    const chunk = `(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[${m[1]}],{${m[2]}:e=>{var module={exports:{}};var exports=module.exports;\n${code}\n;e.exports=module.exports}}]);`
    return route.fulfill({ response: resp, body: chunk, headers: { ...resp.headers(), 'content-type': 'application/javascript' } })
  })
}

const PICKER = '수업 담기 (학교 수업 목록에서 고르기)'
const cellBtn = (scope, weekday, period) => scope.getByRole('button', { name: new RegExp(`^${WDL[weekday]} ${period}교시`) })

// ───────────────────────── 학생 ─────────────────────────

async function studentFlow(browser, errors) {
  const { ctx, page } = await newPage(browser, { errors, who: 'student' })
  await uiLogin(page, 'pk@u7.e2e.kr')

  // ── 홈 진입: '내 수업'의 수업 담기 ──
  await page.waitForURL(/\/student\/today/, { timeout: 20000 }).catch(() => {})
  const myCourses = page.getByRole('region', { name: '내 수업' }).first()
  const homeLink = page.getByRole('link', { name: '+ 수업 담기' })
  const homeOk = await visible(homeLink, 20000)
  check('U7.home.1', "학생 홈 '내 수업'에 '수업 담기' 버튼(→ /student/courses#catalog)", homeOk && (await homeLink.getAttribute('href')) === '/student/courses#catalog', homeOk ? '' : (await myCourses.innerText().catch(() => '')).slice(0, 200))
  check('U7.home.2', '홈 390px 가로 스크롤 없음', await noHScroll(page))
  await homeLink.click()
  await page.waitForURL(/\/student\/courses#catalog/, { timeout: 15000 }).catch(() => {})

  // ── 수업 담기: 시간표 칸 보기 ──
  const pick = region(page, PICKER)
  const table = pick.getByRole('table', { name: '수업 담기 시간표 칸' })
  check('U7.1', "'수업 담기 (학교 수업 목록에서 고르기)' 섹션 + 시간표 칸 보기(기본)", await visible(table, 20000))
  const box = await pick.boundingBox()
  check('U7.1b', '#catalog로 들어오면 수업 담기 섹션으로 스크롤', !!box && box.y < 900 && box.y + box.height > 0, box ? `y=${Math.round(box.y)}` : '')
  const heads = (await table.locator('thead th').allInnerTexts()).map((t) => t.trim()).filter((t) => t && t !== '교시')
  const expectHeads = ['월', '화', '수', '목', '금'].concat(D === 6 || E === 6 ? ['토'] : [], D === 7 ? ['일'] : [])
  check('U7.2', `요일: 월~금${D >= 6 ? ' + 차시가 있는 주말' : ''}(차시 없는 토·일은 없음)`, JSON.stringify(heads) === JSON.stringify(expectHeads), JSON.stringify(heads))
  const rows = await table.locator('tbody tr').count()
  check('U7.3', '교시: 1교시부터 가장 큰 교시(6)까지 — 비공개 수업의 7교시는 없음', rows === 6, `${rows}행`)
  const litCell = cellBtn(table, D, 1)
  const litLabel = (await visible(litCell, 5000)) ? await litCell.getAttribute('aria-label') : ''
  check('U7.4', '칸에 이미 내 시간표에 있는 수업(반 공통 문학) 표시', /내 수업 문학/.test(litLabel || ''), litLabel)
  const g1Hidden = !(await visible(cellBtn(table, D, 4), 1500))
  const hiddenNote = await visible(pick.getByText(/다른 학년 수업 1개 숨김/), 3000)
  check('U7.5', '기본은 내 학년(3) 수업 + 학년 미상 수업 — 1학년 수업 칸은 숨김', g1Hidden && hiddenNote)
  await pick.getByLabel('다른 학년 수업도 보기').check()
  const g1Shown = await visible(cellBtn(table, D, 4), 5000)
  const g1Label = g1Shown ? await cellBtn(table, D, 4).getAttribute('aria-label') : ''
  check('U7.6', "'다른 학년 수업도 보기' → 1학년 수업 칸이 보임", g1Shown && /고를 수 있는 수업 1개/.test(g1Label || ''), g1Label)
  await pick.getByLabel('다른 학년 수업도 보기').uncheck()
  await shot(page, 'U7-grid')

  // 칸 누르기 → 그 시간 수업 목록
  await cellBtn(table, D, 3).click()
  const panel = region(page, `${WDL[D]} 3교시 수업`)
  const sciCard = await articleText(panel, '생활과 과학 A', 8000)
  const artCard = await articleText(panel, '미술 창작')
  check('U7.7', '칸 → 그 시간 수업: 제목·분반·선생님·교실(생활과 과학 A 최과학 과학실, 미술 창작 유미술 미술실)',
    !!sciCard && sciCard.includes('분반 A') && sciCard.includes('최과학 선생님') && sciCard.includes('과학실') && !!artCard && artCard.includes('유미술 선생님') && artCard.includes('미술실'),
    `${sciCard} / ${artCard}`)
  await panel.getByRole('button', { name: '생활과 과학 A 담기' }).click()
  await panel.getByRole('button', { name: '미술 창작 담기' }).click()
  const cart = region(page, '담은 수업')
  const cartOk = await visible(cart.getByText('담은 수업 2'), 5000)
  const warn = cart.getByRole('status', { name: '겹침 경고' })
  const warnText = (await visible(warn, 3000)) ? (await warn.innerText()).replace(/\n/g, ' ') : ''
  check('U7.8', "두 수업을 담으면 '담은 수업 2' + 같은 시간 겹침 경고(담은 수업끼리)", cartOk && warnText.includes(`${WD[D]} 3교시`) && warnText.includes('담은 수업끼리 겹쳐요'), warnText)
  const cellLabel = await cellBtn(table, D, 3).getAttribute('aria-label')
  check('U7.9', '칸에 담음·겹침 표시', /담은 수업 [^·]*생활과 과학 A/.test(cellLabel || '') && /담은 수업 [^·]*미술 창작/.test(cellLabel || '') && /겹침/.test(cellLabel || ''), cellLabel)
  check('U7.10', '수업 담기(칸·담은 수업 표시) 390px 가로 스크롤 없음', await noHScroll(page))
  await shot(page, 'U7-cart-conflict')

  // 한 번에 담기 → 결과
  await cart.getByRole('button', { name: /내 시간표에 담기 \(2\)/ }).click()
  const sheet = await confirmSheet(page, '담기')
  check('U7.11', '담기 전 확인 시트: 수업 2개 + 겹침 안내(그대로 담거나 뺄 수 있음)', sheet.includes('수업 2개를 내 시간표에 담을까요?') && sheet.includes('겹치는 시간이 1곳'), sheet.slice(0, 200))
  const result = cart.getByRole('status', { name: '담기 결과' })
  const resultOk = await visible(result.getByText('추가됨').first(), 15000)
  const resultText = resultOk ? (await result.innerText()).replace(/\n/g, ' ') : ''
  const eSci = await until(() => enrollmentOf(C.sci))
  const eArt = await enrollmentOf(C.art)
  check('U7.12', "결과: 생활과 과학 A — 추가됨, 미술 창작 — 추가됨 · 수강 active(출처 신청)",
    /생활과 과학 A — 추가됨/.test(resultText) && /미술 창작 — 추가됨/.test(resultText) && eSci?.status === 'active' && eSci?.source === 'request' && eArt?.status === 'active',
    `${resultText} | ${JSON.stringify([eSci?.status, eSci?.source, eArt?.status])}`)
  const mine = region(page, '참여 중인 수업')
  const mineSci = await articleText(mine, '생활과 과학 A', 15000)
  const mineLit = await articleText(mine, '문학')
  check('U7.13', "참여 중인 수업: 내가 담은 수업은 '빼기', 반 공통 수업은 '선생님께 문의'",
    !!mineSci && mineSci.includes('출처 · 신청') && (await visible(mine.getByRole('button', { name: '생활과 과학 A 빼기' }), 3000)) && !!mineLit && mineLit.includes('선생님께 문의') && !(await visible(mine.getByRole('button', { name: '문학 빼기' }), 500)),
    `${mineSci} / ${mineLit}`)
  await shot(page, 'U7-results')

  // ── 과목으로 찾기 → 승인 필요 수업 ──
  await pick.getByRole('button', { name: '과목으로 찾기' }).click()
  await pick.getByLabel('과목명으로 찾기').fill('물리')
  const physCard = await articleText(pick, '물리 D', 5000)
  check('U7.14', "과목으로 찾기: 검색은 목록만 좁힘 — 물리 D '선생님 승인 필요'", !!physCard && physCard.includes('선생님 승인 필요') && !(await visible(art(pick, '미술 창작'), 800)), physCard)
  await pick.getByRole('button', { name: '물리 D 담기' }).click()
  await region(page, '담은 수업').getByRole('button', { name: /내 시간표에 담기 \(1\)/ }).click()
  const sheet2 = await confirmSheet(page, '담기')
  const waitOk = await visible(region(page, '담은 수업').getByText(/물리 D — 선생님 승인 대기/), 15000)
  const ePhys = await until(() => enrollmentOf(C.phys))
  check('U7.15', "승인 필요 수업 담기 → '선생님 승인 대기' · 수강 pending", sheet2.includes('승인이 필요한 수업 1개') && waitOk && ePhys?.status === 'pending', `${sheet2.slice(0, 120)} ${ePhys?.status}`)
  const minePhys = await articleText(mine, '물리 D', 15000)
  check('U7.16', "참여 중인 수업에 물리 D '승인 대기' + 신청 취소(빼기) 가능", !!minePhys && minePhys.includes('승인 대기') && (await visible(mine.getByRole('button', { name: '물리 D 빼기' }), 3000)), minePhys)
  await pick.getByLabel('과목명으로 찾기').fill('')

  // ── 홈 '오늘의 내 시간표'에 반영 ──
  await page.goto(BASE + '/student/today', { waitUntil: 'load' })
  const tt = page.getByRole('region', { name: /오늘의 내 시간표$/ }).first()
  const homeSci = await visible(art(tt, /3교시 생활과 과학 A/), 20000)
  const homeArt = await visible(art(tt, /3교시 미술 창작/), 5000)
  const homeWait = await visible(tt.getByText('물리 D 수업 승인을 기다리고 있어요'), 5000)
  check('U7.17', "홈 '오늘의 내 시간표': 담은 생활과 과학 A·미술 창작(3교시) + 물리 D 승인 대기 안내", homeSci && homeArt && homeWait, JSON.stringify({ homeSci, homeArt, homeWait }))
  check('U7.18', '홈 390px 가로 스크롤 없음(수업이 있을 때)', await noHScroll(page))
  await shot(page, 'U7-home')

  // ── 내가 담은 수업 빼기 ──
  await page.goto(BASE + '/student/courses#mine', { waitUntil: 'load' })
  const mine2 = region(page, '참여 중인 수업')
  await visible(mine2.getByRole('button', { name: '미술 창작 빼기' }), 20000)
  await mine2.getByRole('button', { name: '미술 창작 빼기' }).click()
  const sheet3 = await confirmSheet(page, '빼기')
  const eArt2 = await until(async () => {
    const e = await enrollmentOf(C.art)
    return e && e.status === 'ended' ? e : null
  })
  const artGone = await gone(mine2.getByRole('button', { name: '미술 창작 빼기' }), 15000)
  check('U7.19', "'빼기' → 확인(지난 기록 유지 안내) → 수강 ended(to=오늘), 참여 중 목록에서 빠짐",
    sheet3.includes('지난 날짜 기록은 그대로') && eArt2?.to === TODAY && artGone,
    `${sheet3.slice(0, 120)} ${JSON.stringify(eArt2 && [eArt2.status, eArt2.to])}`)

  // ── 직접 입력: 학교 밖 일정 안내 + '이 시간 학교 수업' ──
  const personal = region(page, '직접 입력한 일정')
  const jaseup = await articleText(personal, '자습', 15000)
  check('U7.20', "연결 안 된 직접 입력(같은 요일·교시에 학교 수업) → '학교 수업과 시간이 겹쳐요 — 담기/연결하면 변경이 자동 반영돼요'",
    !!jaseup && jaseup.includes('학교 수업과 시간이 겹쳐요 — 담기/연결하면 변경이 자동 반영돼요'), jaseup)
  await personal.getByRole('button', { name: '직접 입력 추가' }).click()
  const form = page.getByRole('form', { name: '직접 입력 일정 추가' })
  await visible(form, 5000)
  const formText = (await form.innerText()).replace(/\n/g, ' ')
  check('U7.21', "직접 입력 머리말: 학원·자습 같은 학교 밖 일정, 학교 수업은 '수업 담기'에서", formText.includes('학원·자습 같은 학교 밖 일정') && formText.includes('수업 담기'), formText.slice(0, 160))
  await form.getByLabel('제목').fill('학원 숙제') // 이름은 상관없음 — 요일·교시로만 찾음
  await form.getByLabel('요일').selectOption(String(D))
  await form.getByLabel('교시', { exact: true }).selectOption('3')
  const group = form.getByRole('group', { name: '이 시간 학교 수업' })
  const linkBtn = group.getByRole('button', { name: '생활과 과학 A 연결' })
  const artBtn = group.getByRole('button', { name: '미술 창작 담기' })
  check('U7.22', "같은 칸(3교시): 이미 듣는 생활과 과학 A는 '연결', 뺀 미술 창작은 다시 '담기' 후보", (await visible(linkBtn, 5000)) && (await visible(artBtn, 3000)) && !(await visible(group.getByRole('button', { name: '생활과 과학 A 담기' }), 500)))
  await form.getByLabel('교시', { exact: true }).selectOption('6')
  const chemBtn = group.getByRole('button', { name: '화학 실험 담기' })
  check('U7.23', "6교시: '이 시간 학교 수업'에 화학 실험 '담기'(제목 '학원 숙제'와 무관)", await visible(chemBtn, 5000))
  await shot(page, 'U7-entry-chip')
  await chemBtn.click()
  const sheet4 = await confirmSheet(page, '담기')
  // 담기면 내 수업이 되어 같은 칸의 '연결' 후보로 바뀜(자동으로 연결하지는 않음 — 학생이 고름)
  const chemLink = group.getByRole('button', { name: '화학 실험 연결' })
  const chemOk = await visible(chemLink, 15000)
  const chemNote = chemOk ? (await group.innerText()).includes('방금 담았어요(추가됨)') : false
  const eChem = await until(() => enrollmentOf(C.chem))
  const linkSel = await form.getByLabel(/연결할 공식 수업/).evaluate((el) => (el.selectedIndex >= 0 ? el.options[el.selectedIndex].text : ''))
  check('U7.24', "칩 '담기' → 같은 확인 시트 → 추가됨(수강 active·출처 신청) → 같은 칸의 '연결' 후보로 — 자동 연결 없음",
    sheet4.includes('화학 실험 수업을 담을까요?') && chemOk && chemNote && eChem?.status === 'active' && eChem?.source === 'request' && /연결하지 않음/.test(linkSel),
    `${sheet4.slice(0, 80)} ${JSON.stringify(eChem && [eChem.status, eChem.source])} link=${linkSel}`)
  await form.getByRole('button', { name: '취소' }).click()
  const { db } = admin()
  const entries = (await db.collection(`users/${U.pk}/personalEntries`).get()).docs.map((d) => d.data())
  check('U7.25', '칩으로 담아도 직접 입력 일정은 만들어지지 않음(이름 기반 자동 연결 없음)', entries.length === 1 && entries.every((e) => !e.linkedCourseId), JSON.stringify(entries.map((e) => [e.title, e.linkedCourseId])))
  check('U7.26', '내 수업 화면 390px 가로 스크롤 없음', await noHScroll(page))

  // 내부 id·다른 학생 정보가 화면에 없음
  const html = await page.content()
  const leaked = INTERNAL_IDS.filter((id) => html.includes(id))
  check('U7.27', '화면·HTML에 내부 id·다른 학생 정보 없음', leaked.length === 0 && !html.includes('이다른'), leaked.join(','))

  // 키보드: 칸 버튼에 포커스가 가고 Enter로 열림
  await page.goto(BASE + '/student/courses#catalog', { waitUntil: 'load' })
  const table2 = region(page, PICKER).getByRole('table', { name: '수업 담기 시간표 칸' })
  await visible(table2, 20000)
  const c6 = cellBtn(table2, D, 6)
  await c6.focus()
  await page.keyboard.press('Enter')
  const kbPanel = await visible(region(page, `${WDL[D]} 6교시 수업`), 5000)
  check('U7.28', '칸 버튼은 키보드로 열 수 있음(포커스 + Enter, aria-expanded)', kbPanel && (await c6.getAttribute('aria-expanded')) === 'true')
  await ctx.close()
}

// ───────────────────────── 교사: 가져오기 공개 선택·대상 학년 ─────────────────────────

async function teacherFlow(browser, errors) {
  // 서비스 워커가 정적 조각을 대신 받으면 가로채지 못하므로 이 컨텍스트는 서비스 워커를 막음
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', serviceWorkers: 'block' })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push({ who: 'teacher', url: page.url(), kind: 'pageerror', msg: String(e.message || e).slice(0, 300) }))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push({ who: 'teacher', url: page.url(), kind: 'console.error', msg: m.text().slice(0, 300) })
  })
  // 조각을 처음 받기 전에 걸어 둠(앞 화면에서 미리 받아 두면 다시 받지 않음)
  const xl = { stub: 'none' }
  await useRealXlsx(page, xl)
  await uiLogin(page, 'ty@u7.e2e.kr')
  // 수업 정보 수정: 대상 학년·'학생 수업 담기 목록에 공개'
  await page.goto(BASE + `/teacher/courses/${C.sci}`, { waitUntil: 'load' })
  const editBtn = page.getByRole('button', { name: '정보 수정' })
  await visible(editBtn, 20000)
  const info = (await page.locator('main, body').first().innerText()).replace(/\n/g, ' ')
  check('U7.T1', "수업 상세: '학생 수업 담기 · 공개' · '대상 학년 3학년'", info.includes('학생 수업 담기') && info.includes('3학년'), '')
  await editBtn.click()
  const grades = page.getByRole('group', { name: '대상 학년(선택)' })
  const g3 = grades.getByLabel('3학년')
  const pubBox = page.getByRole('checkbox', { name: /학생 수업 담기 목록에 공개/ })
  check('U7.T2', "정보 수정: '대상 학년(선택)' 1~6학년(3학년 체크) + '학생 수업 담기 목록에 공개'", (await visible(grades, 5000)) && (await g3.isChecked()) && (await grades.getByRole('checkbox').count()) === 6 && (await visible(pubBox, 3000)) && (await pubBox.isChecked()))
  await grades.getByLabel('2학년').check()
  await page.locator('form').filter({ has: grades }).getByRole('button', { name: '저장', exact: true }).click()
  const { db } = admin()
  const saved = await until(async () => {
    const d = (await db.doc(`schools/S1/courses/${C.sci}`).get()).data() || {}
    return JSON.stringify(d.grades) === '[2,3]' ? d : null
  })
  check('U7.T3', '대상 학년 저장 → grades [2,3]', !!saved, JSON.stringify(saved?.grades))

  // 시간표 가져오기: 확정 단계의 '학생 수업 담기 목록에 공개' 선택
  await page.goto(BASE + '/teacher/timetable-import', { waitUntil: 'load' })
  const csv = ['요일,교시,과목,교사,학급', '월,1,가상국어,김가상,2-1', '화,2,가상국어,김가상,2-1', '수,3,가상수학,박가상,1-3'].join('\n')
  const file = path.join(OUT, 'u7-import.csv')
  fs.writeFileSync(file, csv)
  await page.locator('input[type=file]').setInputFiles(file)
  const stageBtn = page.getByRole('button', { name: '임시로 올리고 미리보기' })
  const stageOk = await visible(stageBtn, 20000)
  note('U7.T.xlsx', xl.stub === 'replaced' ? '이 환경의 xlsx는 가짜(stub)라 실제 SheetJS로 바꿔 읽음' : xl.stub === 'no-real-lib' ? 'xlsx가 가짜인데 실제 라이브러리를 찾지 못함(XLSX_FULL_JS)' : '실제 xlsx로 빌드됨')
  if (!stageOk) throw new Error(`가져오기 파일을 읽지 못함: ${(await page.locator('body').innerText()).slice(0, 300)}`)
  await stageBtn.click()
  const pub = page.getByLabel('학생 수업 담기 목록에 공개 (학생이 직접 골라 담기)')
  const pubOk = await visible(pub, 30000)
  const autoRadio = page.getByRole('radio', { name: '바로 담기(기본)' })
  check('U7.T4', "가져오기 확정 단계: '학생 수업 담기 목록에 공개 (학생이 직접 골라 담기)' 기본 켬 + '바로 담기(기본)' / '선생님 승인 후'",
    pubOk && (await pub.isChecked()) && (await autoRadio.isChecked()) && (await visible(page.getByRole('radio', { name: '선생님 승인 후' }), 2000)))
  await shot(page, 'U7-import-option')
  await page.getByRole('button', { name: '확정 발행' }).click()
  const sheet = await confirmSheet(page, '발행하기')
  const doneOk = await visible(page.getByText(/학생 '수업 담기' 목록에 공개했어요/), 30000)
  const imported = (await db.collection('schools/S1/courses').where('source', '==', 'import').get()).docs.map((d) => d.data())
  check('U7.T5', '발행 → 새 수업이 학생 수업 담기 목록에 공개(바로 담기)·대상 학년(학급 표시에서)',
    sheet.includes("학생 '수업 담기' 목록에 공개") && doneOk && imported.length === 2 && imported.every((c) => c.catalogVisible === true && c.invitePolicy === 'auto') &&
      JSON.stringify(imported.map((c) => c.grades).sort()) === JSON.stringify([[1], [2]]),
    JSON.stringify(imported.map((c) => [c.title, c.catalogVisible, c.invitePolicy, c.grades])))
  await ctx.close()
}

async function main() {
  await seed()
  note('setup', `서버 오늘 ${TODAY}(${WD[D]}), 학기 ${TERM.id} — 수업 칸은 오늘 요일(${WD[D]})에: 문학(공통 1교시)·생활과 과학 A·미술 창작(3교시 겹침)·1학년 수학(4교시)·물리 D(승인 5교시)·화학 실험(6교시)`)
  const browser = await launchBrowser()
  const errors = []
  try {
    await studentFlow(browser, errors)
    await teacherFlow(browser, errors)
  } catch (e) {
    check('X', '시나리오 예외', false, e?.stack || String(e))
  } finally {
    await browser.close()
  }
  check('U7.errors', '콘솔 오류·페이지 오류 0건', errors.length === 0, JSON.stringify(errors.slice(0, 5)))
  process.exit(finish() ? 1 : 0)
}

await main()
