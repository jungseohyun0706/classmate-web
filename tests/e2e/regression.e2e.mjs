// 클래스메이트 기존 기능 회귀 E2E (F1–F13: 이야기방·공지 읽음/동의, 읽음 명단, 규칙 회귀, 푸시 요청 검증, 교환·SOS 규칙, 주요 화면 스모크)
// (에뮬레이터 + 실제 Next 서버 + Chromium) — 모든 데이터는 테스트용 가상 데이터
// 사용: node tests/e2e/regression.e2e.mjs [label]   (BASE 기본 http://127.0.0.1:3100, 에뮬레이터 FIRESTORE_EMULATOR_HOST/FIREBASE_AUTH_EMULATOR_HOST)
import fs from 'fs'
import { createRequire } from 'module'
import { chromium } from 'playwright-core'
import path from 'path'
import { fileURLToPath } from 'url'
import { seed, admin, CLASS, PW } from './lib/regression-seed.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(ROOT, 'package.json'))
const LABEL = process.argv[2] || 'regression'
const BASE = process.env.BASE || 'http://127.0.0.1:3100'
const [FS_HOST, FS_PORT_STR] = process.env.FIRESTORE_EMULATOR_HOST.split(':')
const FS_PORT = Number(FS_PORT_STR)
const OUT = new URL(`./out-${LABEL}/`, import.meta.url).pathname
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const results = []
const check = (id, name, ok, detail = '') => {
  results.push({ id, name, ok: Boolean(ok), detail: String(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? '  — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function poll(fn, ms = 12000) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    last = await fn()
    if (last) return last
    await sleep(400)
  }
  return last
}

const { db } = admin()
const rcpt = (aid, uid) => db.doc(`classes/${CLASS}/announcements/${aid}/receipts/${uid}`).get()
const annDoc = (aid) => db.doc(`classes/${CLASS}/announcements/${aid}`).get()

await seed()
console.log('seed 완료')

const PW_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const browser = await chromium.launch({ executablePath: fs.existsSync(PW_CHROME) ? PW_CHROME : undefined })
const pageErrors = []

async function newUserPage(who) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push({ who, url: page.url(), kind: 'pageerror', msg: String(e.message || e).slice(0, 300) }))
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push({ who, url: page.url(), kind: 'console.error', msg: m.text().slice(0, 300) })
  })
  return { ctx, page }
}

async function login(who, email) {
  const { ctx, page } = await newUserPage(who)
  await page.goto(BASE + '/auth/login', { waitUntil: 'load' })
  await page.fill('input[type=email]', email)
  await page.fill('input[type=password]', PW)
  await page.locator('button[type=submit]:visible').first().click()
  await page.waitForURL(/\/(student\/today|dashboard)/, { timeout: 25000 })
  return { ctx, page }
}

// ── F1: 학생(이하늘) 이야기방 진입 → 자동 읽음 ─────────────────────
try {
  const { ctx, page } = await login('s1', 's1@e2e.kr')
  await page.goto(BASE + '/class-room', { waitUntil: 'load' })
  await page.getByText('체육복을 챙겨 오세요').first().waitFor({ timeout: 20000 })
  const r1 = await poll(async () => { const s = await rcpt('A1', 's1'); return s.exists && s.data().readAt ? s : null })
  check('F1.1', '학생이 이야기방을 열면 일반 공지(A1)에 readAt 기록', r1, r1 ? '' : 'receipt/readAt 없음')
  const r2 = await poll(async () => { const s = await rcpt('A2', 's1'); return s.exists && s.data().readAt ? s : null })
  check('F1.2', '동의 필요 공지(A2)도 열람 시 readAt 기록', r2)
  await sleep(800)
  const confirmBtns = page.getByRole('button', { name: '동의해요' })
  const nBtn = await confirmBtns.count()
  const oldBtn = await page.getByRole('button', { name: /공지 확인했어요/ }).count()
  check('F1.3', '동의 버튼은 동의 필요 공지(A2)에만, 예전 확인 버튼은 없음', nBtn === 1 && oldBtn === 0, `동의 ${nBtn}개, 옛 버튼 ${oldBtn}개`)
  const readBadges = await page.getByText('👀 읽음').count()
  check('F1.4', '일반 공지에 "👀 읽음" 표시', readBadges >= 1, `${readBadges}개`)
  await page.screenshot({ path: OUT + 'F1-student-classroom.png', fullPage: false })
  if (nBtn >= 1) {
    await confirmBtns.last().click()
    const c = await poll(async () => { const s = await rcpt('A2', 's1'); return s.exists && s.data().consent === 'agreed' ? s : null })
    check('F1.5', 'A2 동의해요 → consent=agreed 저장', c)
    check('F1.6', '확인 후에도 readAt 유지', c && c.data().readAt, c ? JSON.stringify(Object.keys(c.data())) : '')
    const done = await poll(async () => (await page.getByRole('button', { name: '✔ 동의해요' }).count()) > 0)
    check('F1.7', '동의 후 "✔ 동의해요"로 선택 표시', done)
    await page.getByRole('button', { name: '동의하지 않아요' }).last().click()
    await page.getByRole('button', { name: '동의 안 함' }).click()
    const dec = await poll(async () => { const s = await rcpt('A2', 's1'); return s.exists && s.data().consent === 'declined' ? s : null })
    check('F1.8', '동의하지 않아요(확인 창) → consent=declined로 변경', dec)
    await page.getByRole('button', { name: '동의해요' }).last().click()
    await poll(async () => { const s = await rcpt('A2', 's1'); return s.exists && s.data().consent === 'agreed' ? s : null })
  }
  await ctx.close()
} catch (e) { check('F1.x', '학생 이야기방 흐름 예외', false, e.message) }

// ── F2: 과거 데이터 학생(박바다) — 확인만 있고 readAt 없는 receipt ─────
try {
  const before = (await annDoc('A1')).data().readCount
  const { ctx, page } = await login('s2', 's2@e2e.kr')
  await page.goto(BASE + '/class-room', { waitUntil: 'load' })
  await page.getByText('체육복을 챙겨 오세요').first().waitFor({ timeout: 20000 })
  const r = await poll(async () => { const s = await rcpt('A1', 's2'); return s.exists && s.data().readAt ? s : null }, 10000)
  check('F2.1', '과거 확인 기록에 readAt이 채워짐(backfill)', r, r ? '' : 'readAt 여전히 없음')
  const s = await rcpt('A1', 's2')
  check('F2.2', 'backfill 후에도 consent 유지', s.exists && s.data().consent === 'agreed', JSON.stringify(s.data()))
  const after = (await annDoc('A1')).data().readCount
  check('F2.3', 'backfill 시 A1.readCount 증가', after === before + 1, `${before} → ${after}`)
  await page.screenshot({ path: OUT + 'F2-legacy-student.png' })
  await ctx.close()
} catch (e) { check('F2.x', '과거 데이터 학생 흐름 예외', false, e.message) }

// ── F3: 교사 화면 ─────────────────────────────────────────────
try {
  const { ctx, page } = await login('teacher', 't@e2e.kr')
  await page.goto(BASE + '/class-room', { waitUntil: 'load' })
  await page.getByText('체육복을 챙겨 오세요').first().waitFor({ timeout: 20000 })
  const cardText = await page.locator('button', { hasText: '명단 보기' }).first().innerText()
  const m = cardText.match(/읽음\s*(\d+)/)
  check('F3.1', '공지 카드 "읽음 N명" = 실제 읽은 학생 수(2)', m && Number(m[1]) === 2, cardText.replace(/\s+/g, ' '))
  await page.locator('button', { hasText: '명단 보기' }).first().click()
  await page.getByText('공지 확인 명단').waitFor({ timeout: 10000 })
  await poll(async () => (await page.getByText('명단을 불러오는 중').count()) === 0, 10000)
  await sleep(800)
  const sheet = (await page.locator('div.fixed.inset-0').last().innerText()).replace(/\s+/g, ' ')
  const read = sheet.match(/(\d+)\s*읽음/)
  const unread = sheet.match(/(\d+)\s*안 읽음/)
  check('F3.2', '명단 시트 읽음 2', read && Number(read[1]) === 2, sheet.slice(0, 160))
  check('F3.3', '명단 시트 안 읽음 2(최구름·무번호)', unread && Number(unread[1]) === 2, unread ? unread[0] : '')
  check('F3.4', '이하늘·박바다는 읽음, 최구름은 안 읽음', /이하늘.*(읽음|동의)/.test(sheet) && /박바다.*(읽음|동의)/.test(sheet) && /최구름\s*안 읽음/.test(sheet), sheet.slice(0, 220))
  check('F3.5', '승인 대기·거절 학생은 명단에 없음', !sheet.includes('대기생') && !sheet.includes('거절생'))
  check('F3.9', '번호 없는 학생이 0번으로 표시되지 않음', !/\b0번/.test(sheet) && sheet.includes('무번호'))
  check('F3.10', '번호 없는 학생은 명단 맨 뒤', sheet.lastIndexOf('무번호') > sheet.lastIndexOf('최구름'))
  await page.screenshot({ path: OUT + 'F3-teacher-roster.png' })

  await page.goto(BASE + '/teacher/notices', { waitUntil: 'load' })
  await page.getByText('체육복 준비').first().waitFor({ timeout: 20000 })
  await sleep(1500)
  await page.getByText('체육복 준비').first().click()
  await poll(async () => (await page.getByText(/읽은 학생 \d+명/).count()) > 0, 10000)
  const panel = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  const rs = panel.match(/읽은 학생 (\d+)명/)
  const us = panel.match(/안 읽음 (\d+)명/)
  check('F3.6', '알림장 목록 확장: 읽은 학생 2명', rs && Number(rs[1]) === 2, rs ? rs[0] : panel.slice(0, 200))
  check('F3.7', '알림장 목록 확장: 안 읽음 2명', us && Number(us[1]) === 2, us ? us[0] : '')
  const hdr = panel.match(/읽음 (\d+) \/ 전체 (\d+)/)
  check('F3.8', '목록 헤더 읽음 수 = 명단 읽은 학생 수', hdr && rs && hdr[1] === rs[1], hdr ? hdr[0] : '')
  await page.screenshot({ path: OUT + 'F3-teacher-notices.png', fullPage: true })
  await ctx.close()
} catch (e) { check('F3.x', '교사 화면 흐름 예외', false, e.message) }

// ── F4: 보안 규칙 (클라이언트 SDK로 직접 시도) ─────────────────────
{
  const { initializeApp, deleteApp } = require('firebase/app')
  const { getAuth, connectAuthEmulator, signInWithEmailAndPassword } = require('firebase/auth')
  const { getFirestore, connectFirestoreEmulator, doc, setDoc, updateDoc, serverTimestamp } = require('firebase/firestore')
  async function as(email, fn) {
    const app = initializeApp({ projectId: 'demo-classmate', apiKey: 'e2e-fake-key' }, 'r-' + email + Math.random())
    const a = getAuth(app); connectAuthEmulator(a, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true })
    const d = getFirestore(app); connectFirestoreEmulator(d, FS_HOST, FS_PORT)
    await signInWithEmailAndPassword(a, email, PW)
    try { await fn(d); return 'allowed' } catch (e) { return e.code || e.message } finally { await deleteApp(app) }
  }
  const rpath = (d, uid) => doc(d, 'classes', CLASS, 'announcements', 'A1', 'receipts', uid)
  check('F4.1', '다른 반 학생은 우리 반 receipt 생성 불가', (await as('o@e2e.kr', (d) => setDoc(rpath(d, 'outsider'), { readAt: serverTimestamp(), studentName: 'x' }))) === 'permission-denied')
  check('F4.2', '승인 대기 학생은 receipt 생성 불가', (await as('p@e2e.kr', (d) => setDoc(rpath(d, 'pending'), { readAt: serverTimestamp(), studentName: 'x' }))) === 'permission-denied')
  check('F4.3', '같은 반 승인 학생은 자기 receipt 생성 가능', (await as('s3@e2e.kr', (d) => setDoc(rpath(d, 's3'), { readAt: serverTimestamp(), studentName: '최구름' }, { merge: true }))) === 'allowed')
  check('F4.4', '학생이 남의 uid로 receipt 위조 불가', (await as('s3@e2e.kr', (d) => setDoc(rpath(d, 's1'), { readAt: serverTimestamp(), studentName: '위조' }, { merge: true }))) === 'permission-denied')
  check('F4.5', '학생이 자기 role을 teacher로 올릴 수 없음', (await as('s1@e2e.kr', (d) => updateDoc(doc(d, 'users', 's1'), { role: 'teacher' }))) === 'permission-denied')
  check('F4.6', '승인 대기 학생이 스스로 approved 불가', (await as('p@e2e.kr', (d) => updateDoc(doc(d, 'users', 'pending'), { status: 'approved' }))) === 'permission-denied')
  check('F4.7', '학생이 자기 classId를 남의 반으로 변경 불가', (await as('s1@e2e.kr', (d) => updateDoc(doc(d, 'users', 's1'), { classId: 'S2_1_1' }))) === 'permission-denied')
}

// ── F6: 푸시 API 위조 차단 + 채팅·댓글 규칙 ───────────────────────
{
  const { initializeApp, deleteApp } = require('firebase/app')
  const { getAuth, connectAuthEmulator, signInWithEmailAndPassword } = require('firebase/auth')
  const { getFirestore, connectFirestoreEmulator, doc, addDoc, collection, serverTimestamp, Timestamp } = require('firebase/firestore')
  async function session(email) {
    const app = initializeApp({ projectId: 'demo-classmate', apiKey: 'e2e-fake-key' }, 'p-' + email + Math.random())
    const a = getAuth(app); connectAuthEmulator(a, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true })
    const d = getFirestore(app); connectFirestoreEmulator(d, FS_HOST, FS_PORT)
    const cred = await signInWithEmailAndPassword(a, email, PW)
    const token = await cred.user.getIdToken()
    return { app, d, token, uid: cred.user.uid, close: () => deleteApp(app) }
  }
  const push = async (token, body) => {
    const r = await fetch(BASE + '/api/chat-push', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) })
    return { status: r.status, j: await r.json().catch(() => ({})) }
  }
  const tryWrite = async (fn) => { try { await fn(); return 'allowed' } catch (e) { return e.code || e.message } }
  const s1 = await session('s1@e2e.kr'), s2 = await session('s2@e2e.kr'), t = await session('t@e2e.kr')
  try {
    let r = await push(s1.token, { classId: CLASS, kind: 'chat', preview: '스팸' })
    check('F6.1', '옛 형식(preview만) 푸시 요청은 거부', r.status === 400, `HTTP ${r.status}`)
    r = await push(s1.token, { classId: CLASS, kind: 'notice', docId: 'A1' })
    check('F6.2', '학생의 공지 푸시 위조 거부', r.status === 403, `HTTP ${r.status} ${JSON.stringify(r.j)}`)
    r = await push(s1.token, { classId: CLASS, kind: 'chat', docId: 'nope123' })
    check('F6.3', '없는 메시지로 푸시 요청 거부', r.status === 404, `HTTP ${r.status}`)
    const mine = await addDoc(collection(s1.d, 'classes', CLASS, 'chat'), { authorId: s1.uid, authorName: '이하늘', role: 'student', text: '안녕하세요', createdAt: serverTimestamp() })
    r = await push(s1.token, { classId: CLASS, kind: 'chat', docId: mine.id })
    check('F6.4', '내가 방금 쓴 메시지로는 푸시 성공', r.status === 200 && r.j.reason !== 'not-author', `HTTP ${r.status} ${JSON.stringify(r.j)}`)
    r = await push(s1.token, { classId: CLASS, kind: 'chat', docId: mine.id })
    check('F6.5', '같은 메시지로 두 번째 푸시는 보내지 않음', r.status === 200 && r.j.reason === 'already-pushed', JSON.stringify(r.j))
    r = await push(s2.token, { classId: CLASS, kind: 'chat', docId: mine.id })
    check('F6.6', '남이 쓴 메시지로 푸시 요청 거부', r.status === 403, `HTTP ${r.status}`)
    check('F6.7', '학생이 role:teacher로 채팅 작성 불가', (await tryWrite(() => addDoc(collection(s1.d, 'classes', CLASS, 'chat'), { authorId: s1.uid, authorName: '선생님', role: 'teacher', text: '가짜 선생님', createdAt: serverTimestamp() }))) === 'permission-denied')
    check('F6.8', '미래 createdAt으로 채팅 고정 불가', (await tryWrite(() => addDoc(collection(s1.d, 'classes', CLASS, 'chat'), { authorId: s1.uid, authorName: '이하늘', role: 'student', text: '고정', createdAt: Timestamp.fromDate(new Date('2099-01-01')) }))) === 'permission-denied')
    check('F6.9', '교사는 role:teacher로 정상 작성', (await tryWrite(() => addDoc(collection(t.d, 'classes', CLASS, 'chat'), { authorId: t.uid, authorName: '김담임', role: 'teacher', text: '안내합니다', createdAt: serverTimestamp() }))) === 'allowed')
    check('F6.10', '학생이 role:teacher로 댓글 작성 불가', (await tryWrite(() => addDoc(collection(s1.d, 'classes', CLASS, 'announcements', 'A1', 'comments'), { authorId: s1.uid, authorName: '선생님', role: 'teacher', text: '가짜', createdAt: serverTimestamp() }))) === 'permission-denied')
    check('F6.11', '학생 정상 댓글은 허용', (await tryWrite(() => addDoc(collection(s1.d, 'classes', CLASS, 'announcements', 'A1', 'comments'), { authorId: s1.uid, authorName: '이하늘', role: 'student', text: '확인했어요', createdAt: serverTimestamp() }))) === 'allowed')
  } catch (e) { check('F6.x', '푸시/규칙 시나리오 예외', false, e.message) }
  await s1.close(); await s2.close(); await t.close()
}

// ── F7: 거절 학생 안내 / 담임 삭제 버튼 / UI로 채팅 전송 ───────────────
try {
  const { ctx, page } = await login('rejected', 'r@e2e.kr')
  await page.goto(BASE + '/class-room', { waitUntil: 'load' })
  const ok = await poll(async () => (await page.getByText('입장 신청이 승인되지 않았어요').count()) > 0, 15000)
  check('F7.1', '거절된 학생에게 거절 안내 표시(승인 대기 아님)', ok)
  await page.screenshot({ path: OUT + 'F7-rejected.png' })
  await ctx.close()
} catch (e) { check('F7.1x', '거절 학생 흐름 예외', false, e.message) }
try {
  const st = await login('s1', 's1@e2e.kr')
  await st.page.goto(BASE + '/class-room', { waitUntil: 'load' })
  await st.page.getByText('체육복을 챙겨 오세요').first().waitFor({ timeout: 20000 })
  await st.page.locator('textarea, input[placeholder*="메시지"]').first().fill('UI에서 보낸 메시지')
  await st.page.getByRole('button', { name: '전송' }).click()
  const sent = await poll(async () => { const q = await db.collection(`classes/${CLASS}/chat`).where('text', '==', 'UI에서 보낸 메시지').get(); return q.empty ? null : q.docs[0] }, 10000)
  check('F7.2', '학생이 UI로 채팅 전송(새 규칙 통과)', sent)
  const pushed = sent && await poll(async () => (await sent.ref.get()).data().pushedAt ? true : null, 10000)
  check('F7.3', 'UI 전송 후 서버 푸시 처리됨(pushedAt 기록)', pushed)
  await st.ctx.close()
  const tc = await login('teacher', 't@e2e.kr')
  await tc.page.goto(BASE + '/class-room', { waitUntil: 'load' })
  await tc.page.getByText('UI에서 보낸 메시지').first().waitFor({ timeout: 20000 })
  await sleep(1500)
  const del = await tc.page.locator('button', { hasText: '삭제' }).count()
  check('F7.4', '담임에게는 학생 메시지 삭제 버튼이 있음', del > 0, `${del}개`)
  await tc.ctx.close()
} catch (e) { check('F7.x', '채팅 UI 흐름 예외', false, e.message) }

// ── F8: 교사 가입 코드 (서버를 TEACHER_SIGNUP_CODE 없이 띄움) ─────────
try {
  const r = await fetch(BASE + '/api/auth/verify-teacher-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'classmate2026' }) })
  const j = await r.json().catch(() => ({}))
  check('F8.1', '코드 미설정 서버는 예전 공개 코드(classmate2026)를 거부', r.status === 503, `HTTP ${r.status} ${JSON.stringify(j)}`)
  check('F8.2', '응답에 설정 여부(configured)를 노출하지 않음', !('configured' in j))
} catch (e) { check('F8.x', '교사 코드 시나리오 예외', false, e.message) }

// ── F9: 보안 규칙 강화분 (알림·학급·receipt·급식 별점) ────────────────
{
  const { initializeApp, deleteApp } = require('firebase/app')
  const { getAuth, connectAuthEmulator, signInWithEmailAndPassword } = require('firebase/auth')
  const { getFirestore, connectFirestoreEmulator, doc, setDoc, addDoc, collection, serverTimestamp, runTransaction, increment } = require('firebase/firestore')
  async function as(email, fn) {
    const app = initializeApp({ projectId: 'demo-classmate', apiKey: 'e2e-fake-key' }, 'q-' + email + Math.random())
    const a = getAuth(app); connectAuthEmulator(a, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true })
    const d = getFirestore(app); connectFirestoreEmulator(d, FS_HOST, FS_PORT)
    await signInWithEmailAndPassword(a, email, PW)
    try { await fn(d, a.currentUser.uid); return 'allowed' } catch (e) { return e.code || e.message } finally { await deleteApp(app) }
  }
  const noti = (url, extra = {}) => (d) => addDoc(collection(d, 'users', 'teacher', 'notifications'), { title: '알림', body: '본문', url, createdAt: serverTimestamp(), read: false, ...extra })
  check('F9.1', '알림: 앱 내부 경로 url 허용', (await as('s1@e2e.kr', noti('/teacher/notices'))) === 'allowed')
  check('F9.2', '알림: 외부 https url 거부', (await as('s1@e2e.kr', noti('https://evil.example'))) === 'permission-denied')
  check('F9.3', '알림: //로 시작하는 url 거부', (await as('s1@e2e.kr', noti('//evil.example'))) === 'permission-denied')
  check('F9.4', '알림: /\\ 로 시작하는 url 거부', (await as('s1@e2e.kr', noti('/\\evil.example'))) === 'permission-denied')
  check('F9.5', '알림: javascript: url 거부', (await as('s1@e2e.kr', noti('javascript:alert(1)'))) === 'permission-denied')
  check('F9.6', '알림: 허용되지 않은 필드 거부', (await as('s1@e2e.kr', noti('/teacher/notices', { html: '<b>x</b>' }))) === 'permission-denied')
  const cls = (id, data) => (d, uid) => setDoc(doc(d, 'classes', id), { classId: id, teacherId: uid, ...data }, { merge: true })
  check('F9.7', '학급: 다른 학교 반 생성 거부', (await as('t@e2e.kr', cls('S2_9_9', { schoolCode: 'S2', grade: 9, classNm: 9 }))) === 'permission-denied')
  check('F9.8', '학급: 우리 학교 반 생성 허용', (await as('t@e2e.kr', cls('S1_9_9', { schoolCode: 'S1', grade: 9, classNm: 9 }))) === 'allowed')
  check('F9.9', '학급: 다른 학교 담임 없는 반 인수 거부', (await as('t@e2e.kr', cls('S2_2_2', {}))) === 'permission-denied')
  check('F9.10', '학급: 학교코드 없는 예전 타학교 반 인수 거부', (await as('t@e2e.kr', cls('S2_3_3', {}))) === 'permission-denied')
  check('F9.11', '학급: 우리 학교 담임 없는 반 인수 허용', (await as('t@e2e.kr', cls('S1_1_1', {}))) === 'allowed')
  const rc = (data) => (d, uid) => setDoc(doc(d, 'classes', CLASS, 'announcements', 'A2', 'receipts', uid), data, { merge: true })
  check('F9.12', 'receipt: 이름에 숫자 등 이상 타입 거부', (await as('s3@e2e.kr', rc({ studentName: 123 }))) === 'permission-denied')
  check('F9.13', 'receipt: 정의되지 않은 동의 값 거부', (await as('s3@e2e.kr', rc({ studentName: '최구름', consent: 'maybe' }))) === 'permission-denied')
  const MEAL = 'S1_20261003'
  const vote = (rating, sumDelta = rating) => (d, uid) => runTransaction(d, async (tx) => {
    const vref = doc(d, 'meal_ratings', MEAL, 'votes', uid)
    tx.set(vref, { rating, createdAt: serverTimestamp() })
    tx.set(doc(d, 'meal_ratings', MEAL), { schoolCode: 'S1', date: '20261003', sum: increment(sumDelta), total: increment(1), counts: { [String(rating)]: increment(1) } }, { merge: true })
  })
  check('F9.14', '급식 별점: 첫 투표(집계 생성) 허용', (await as('s1@e2e.kr', vote(4))) === 'allowed')
  check('F9.15', '급식 별점: 다른 학생 투표(집계 갱신) 허용', (await as('s2@e2e.kr', vote(5))) === 'allowed')
  check('F9.16', '급식 별점: 투표 점수와 다른 집계 증가 거부', (await as('s3@e2e.kr', vote(3, 5))) === 'permission-denied')
  check('F9.17', '급식 별점: 집계 직접 덮어쓰기 거부', (await as('s3@e2e.kr', (d) => setDoc(doc(d, 'meal_ratings', MEAL), { total: 999, sum: 4995 }, { merge: true }))) === 'permission-denied')
  const agg = (await db.doc('meal_ratings/' + MEAL).get()).data()
  check('F9.18', '급식 별점: 집계가 정확(2표, 합 9)', agg && agg.total === 2 && agg.sum === 9, JSON.stringify(agg))
}

// ── F10: 알림장 쓰기로 올린 공지도 푸시 처리 ─────────────────────────
try {
  const { ctx, page } = await login('teacher', 't@e2e.kr')
  await page.goto(BASE + '/teacher/notice/write', { waitUntil: 'load' })
  await page.getByPlaceholder('예: 다음 주 준비물 안내').waitFor({ timeout: 20000 })
  await page.getByPlaceholder('예: 다음 주 준비물 안내').fill('E2E 알림장 공지')
  await page.getByPlaceholder('내용을 입력하세요...').fill('알림장 쓰기 화면에서 보낸 공지입니다.')
  await page.getByRole('button', { name: /공지 보내기/ }).click()
  const made = await poll(async () => { const q = await db.collection(`classes/${CLASS}/announcements`).where('title', '==', 'E2E 알림장 공지').get(); return q.empty ? null : q.docs[0] }, 15000)
  check('F10.1', '알림장 쓰기로 공지 저장', made)
  const pushed = made && await poll(async () => (await made.ref.get()).data().pushedAt ? true : null, 15000)
  check('F10.2', '알림장 쓰기 공지도 서버 푸시 처리됨(pushedAt)', pushed)
  await ctx.close()
} catch (e) { check('F10.x', '알림장 쓰기 흐름 예외', false, e.message) }

// ── F11: 수업 교환·SOS 규칙 (칸 잠금) + 익명 급식 투표 차단 ──────────────
{
  const { initializeApp, deleteApp } = require('firebase/app')
  const { getAuth, connectAuthEmulator, signInWithEmailAndPassword, signInAnonymously } = require('firebase/auth')
  const { getFirestore, connectFirestoreEmulator, doc, addDoc, setDoc, updateDoc, deleteDoc, collection, serverTimestamp, runTransaction, increment } = require('firebase/firestore')
  async function as(email, fn) {
    const app = initializeApp({ projectId: 'demo-classmate', apiKey: 'e2e-fake-key' }, 'w-' + email + Math.random())
    const a = getAuth(app); connectAuthEmulator(a, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true })
    const d = getFirestore(app); connectFirestoreEmulator(d, FS_HOST, FS_PORT)
    if (email === 'anon') await signInAnonymously(a)
    else await signInWithEmailAndPassword(a, email, PW)
    try { const v = await fn(d, a.currentUser.uid); return v === undefined ? 'allowed' : v } catch (e) { return e.code || e.message } finally { await deleteApp(app) }
  }
  const S = 'S1', DATE = '20261230'
  const lockRef = (d, uid, date, period) => doc(d, 'school_swaps', S, 'slots', `${uid}_${date}_${period}`)
  const lockData = (uid, date, period, kind, refPath) => ({ uid, date, period, kind, refPath, createdAt: serverTimestamp() })
  // swaps.ts의 accept 트랜잭션과 같은 쓰기 (claimSwapSlots → tx.update)
  const acceptSwap = (coll, id, { skipLocks = false, ignoreExisting = false } = {}) => (d, uid) => runTransaction(d, async (tx) => {
    const ref = doc(d, 'school_swaps', S, coll, id)
    const snap = await tx.get(ref)
    const v = snap.data()
    const requesterId = v.requesterId ?? v.fromId
    if (!skipLocks) {
      const rl = lockRef(d, requesterId, v.date, v.period), al = lockRef(d, uid, v.date, v.period)
      const [rs, as_] = [await tx.get(rl), await tx.get(al)]
      if (!ignoreExisting && (rs.exists() || as_.exists())) throw new Error('slot-taken')
      tx.set(rl, lockData(requesterId, v.date, v.period, 'swap', ref.path))
      tx.set(al, lockData(uid, v.date, v.period, 'swap', ref.path))
    }
    tx.update(ref, { status: 'accepted', acceptedAt: serverTimestamp(), accepterId: uid, accepterName: '수락' })
  })
  const direct = (to, period, extra = {}) => (d, uid) => addDoc(collection(d, 'school_swaps', S, 'direct_requests'), {
    fromId: uid, fromName: '김담임', requesterId: uid, requesterName: '김담임', requesterClassId: CLASS, requesterClass: '3학년 2반',
    toId: to, toName: '받는분', day: 'wed', dayLabel: '수', period, subject: '국어', date: DATE, status: 'pending', createdAt: serverTimestamp(), ...extra,
  }).then((r) => r.id)

  const d1 = await as('t@e2e.kr', direct('t2', 3))
  const d2 = await as('t@e2e.kr', direct('t3', 3))
  check('F11.1', '교환: 1:1 요청 생성 허용', /^[A-Za-z0-9]{20}$/.test(d1) && /^[A-Za-z0-9]{20}$/.test(d2), `${d1} ${d2}`)
  check('F11.2', '교환: 남의 이름으로 요청 생성 거부', (await as('t@e2e.kr', direct('t2', 4, { requesterId: 't3', fromId: 't3' }))) === 'permission-denied')
  check('F11.3', '교환: 받는 사람이 아닌 교사의 수락 거부', (await as('t3@e2e.kr', acceptSwap('direct_requests', d1))) === 'permission-denied')
  check('F11.4', '교환: 칸 잠금 없이 수락 거부', (await as('t2@e2e.kr', acceptSwap('direct_requests', d1, { skipLocks: true }))) === 'permission-denied')
  check('F11.5', '교환: 받은 교사가 칸 잠금과 함께 수락 허용', (await as('t2@e2e.kr', acceptSwap('direct_requests', d1))) === 'allowed')
  const lk = (await db.doc(`school_swaps/${S}/slots/teacher_${DATE}_3`).get()).data()
  check('F11.6', '교환: 요청·수락 교사 칸 잠금 생성됨', lk && lk.kind === 'swap' && (await db.doc(`school_swaps/${S}/slots/t2_${DATE}_3`).get()).exists, JSON.stringify(lk))
  check('F11.7', '교환: 같은 수업의 다른 요청 동시 수락 거부(잠금 존재)', (await as('t3@e2e.kr', acceptSwap('direct_requests', d2, { ignoreExisting: true }))) === 'permission-denied')
  check('F11.8', '교환: 다른 교사 칸 잠금 위조 거부', (await as('t3@e2e.kr', (d) => setDoc(lockRef(d, 't2', DATE, 5), lockData('t2', DATE, 5, 'swap', `school_swaps/${S}/direct_requests/${d2}`)))) === 'permission-denied')
  check('F11.9', '교환: 남이 보낸 요청 취소 거부', (await as('t3@e2e.kr', (d) => updateDoc(doc(d, 'school_swaps', S, 'direct_requests', d2), { status: 'cancelled', cancelledAt: serverTimestamp() }))) === 'permission-denied')
  check('F11.10', '교환: 요청 내용 변조 거부', (await as('t3@e2e.kr', (d) => updateDoc(doc(d, 'school_swaps', S, 'direct_requests', d2), { subject: '변조' }))) === 'permission-denied')
  check('F11.11', '교환: 요청 삭제 거부', (await as('t@e2e.kr', (d) => deleteDoc(doc(d, 'school_swaps', S, 'direct_requests', d2)))) === 'permission-denied')
  check('F11.12', '교환: 보낸 교사의 취소 허용', (await as('t@e2e.kr', (d) => updateDoc(doc(d, 'school_swaps', S, 'direct_requests', d2), { status: 'cancelled', cancelledAt: serverTimestamp() }))) === 'allowed')
  check('F11.13', '교환: 받은 교사의 거절 허용', (await as('t3@e2e.kr', async (d) => {
    const id = await addDoc(collection(d, 'school_swaps', S, 'direct_requests'), { fromId: 't3x' }).catch(() => null)
    if (id) throw new Error('잘못된 형식 요청이 생성됨')
  })) === 'allowed' && (await as('t3@e2e.kr', async (d) => {
    const ref = await addDoc(collection(d, 'school_swaps', S, 'direct_requests'), { fromId: 't3', fromName: '박교과', requesterId: 't3', requesterName: '박교과', toId: 't2', toName: '이교과', day: 'thu', dayLabel: '목', period: 2, subject: '수학', date: '20261231', status: 'pending', createdAt: serverTimestamp() })
    return ref.id
  }).then((id) => as('t2@e2e.kr', (d, uid) => updateDoc(doc(d, 'school_swaps', S, 'direct_requests', id), { status: 'declined', declinedAt: serverTimestamp(), declinerId: uid, declinerName: '이교과' })))) === 'allowed')

  const pub = await as('t@e2e.kr', (d, uid) => addDoc(collection(d, 'school_swaps', S, 'requests'), { requesterId: uid, requesterName: '김담임', requesterClassId: CLASS, requesterClass: '3학년 2반', day: 'wed', dayLabel: '수', period: 6, subject: '체육', date: DATE, note: '', status: 'pending', createdAt: serverTimestamp() }).then((r) => r.id))
  check('F11.14', '게시판: 공개 요청 생성 허용', /^[A-Za-z0-9]{20}$/.test(pub), pub)
  check('F11.15', '게시판: 내가 올린 요청 수락 거부', (await as('t@e2e.kr', acceptSwap('requests', pub))) === 'permission-denied')
  check('F11.16', '게시판: 다른 교사 수락(칸 잠금) 허용', (await as('t3@e2e.kr', acceptSwap('requests', pub))) === 'allowed')

  const sos = (period, date = DATE) => (d, uid) => addDoc(collection(d, 'school_sos', S, 'requests'), { date, period, reason: '출장', requesterId: uid, requesterName: '김담임', requesterClass: '3학년 2반', schoolCode: S, status: 'open', createdAt: serverTimestamp() }).then((r) => r.id)
  const assignSos = (id, { skipLock = false } = {}) => (d, uid) => runTransaction(d, async (tx) => {
    const ref = doc(d, 'school_sos', S, 'requests', id)
    const v = (await tx.get(ref)).data()
    const lr = lockRef(d, uid, v.date, v.period)
    if (!skipLock && (await tx.get(lr)).exists()) throw new Error('slot-taken')
    tx.update(ref, { status: 'assigned', assignedTo: uid, assignedName: '맡음', assignedAt: serverTimestamp() })
    if (!skipLock) tx.set(lr, lockData(uid, v.date, v.period, 'sos', ref.path))
  })
  const sos1 = await as('t@e2e.kr', sos(4))
  check('F11.17', 'SOS: 생성 허용', /^[A-Za-z0-9]{20}$/.test(sos1), sos1)
  check('F11.18', 'SOS: 남의 이름으로 생성 거부', (await as('t@e2e.kr', (d) => addDoc(collection(d, 'school_sos', S, 'requests'), { date: DATE, period: 1, requesterId: 't2', requesterName: 'x', status: 'open', createdAt: serverTimestamp() }))) === 'permission-denied')
  check('F11.19', 'SOS: 칸 잠금 없이 배정 거부', (await as('t2@e2e.kr', assignSos(sos1, { skipLock: true }))) === 'permission-denied')
  check('F11.20', 'SOS: 칸 잠금과 함께 배정 허용', (await as('t2@e2e.kr', assignSos(sos1))) === 'allowed')
  check('F11.21', 'SOS: 이미 배정된 SOS 재배정 거부', (await as('t3@e2e.kr', assignSos(sos1))) === 'permission-denied')
  check('F11.22', 'SOS: 배정 후 올린 사람 취소 거부', (await as('t@e2e.kr', (d) => updateDoc(doc(d, 'school_sos', S, 'requests', sos1), { status: 'cancelled', cancelledAt: serverTimestamp() }))) === 'permission-denied')
  const sos2 = await as('t@e2e.kr', sos(3))
  check('F11.23', 'SOS: 교환으로 이미 찬 칸(t2 3교시)은 배정 거부', (await as('t2@e2e.kr', assignSos(sos2))) === 'slot-taken')
  check('F11.24', 'SOS: 다른 교사가 남의 SOS 취소 거부', (await as('t3@e2e.kr', (d) => updateDoc(doc(d, 'school_sos', S, 'requests', sos2), { status: 'cancelled', cancelledAt: serverTimestamp() }))) === 'permission-denied')
  check('F11.25', 'SOS: 올린 사람 취소 허용', (await as('t@e2e.kr', (d) => updateDoc(doc(d, 'school_sos', S, 'requests', sos2), { status: 'cancelled', cancelledAt: serverTimestamp() }))) === 'allowed')
  check('F11.26', '교환: 다른 학교 학생/교사 읽기 거부', (await as('o@e2e.kr', (d) => require('firebase/firestore').getDoc(doc(d, 'school_swaps', S, 'direct_requests', d1)))) === 'permission-denied')

  const MEAL2 = 'S1_20261005'
  check('F11.27', '급식 별점: 익명 계정 투표 거부', (await as('anon', (d, uid) => runTransaction(d, async (tx) => {
    tx.set(doc(d, 'meal_ratings', MEAL2, 'votes', uid), { rating: 5, createdAt: serverTimestamp() })
    tx.set(doc(d, 'meal_ratings', MEAL2), { schoolCode: 'S1', date: '20261005', sum: increment(5), total: increment(1), counts: { '5': increment(1) } }, { merge: true })
  }))) === 'permission-denied')
}

// ── F5: 화면 스모크 (페이지 오류 수집) ─────────────────────────────
const before5 = pageErrors.length
try {
  const anon = await newUserPage('anon')
  for (const p of ['/', '/auth/login', '/auth/register', '/auth/forgot', '/privacy', '/join']) {
    const resp = await anon.page.goto(BASE + p, { waitUntil: 'load' }).catch((e) => ({ status: () => 'ERR ' + e.message }))
    check('F5.anon' + p, `익명 ${p} 응답`, resp && resp.status() === 200, String(resp && resp.status()))
  }
  await anon.ctx.close()
  const t = await login('teacher', 't@e2e.kr')
  for (const p of ['/dashboard', '/teacher/students', '/teacher/notices', '/teacher/notice/write', '/teacher/settings', '/teacher/class-timetable', '/teacher/view-timetables', '/teacher/my-schedule', '/teacher/swaps', '/teacher/sos', '/teacher/class-qr', '/teacher/register-class', '/teacher/upload-timetable', '/calendar', '/meals', '/class-room']) {
    await t.page.goto(BASE + p, { waitUntil: 'load' }).catch(() => {})
    await sleep(1800)
    const stuck = await t.page.locator('.animate-spin').count()
    check('F5.t' + p, `교사 ${p} 로드(스피너 잔존 X)`, !t.page.url().includes('/auth/login') && stuck === 0, `url=${t.page.url().replace(BASE, '')} spinner=${stuck}`)
    await t.page.screenshot({ path: OUT + 'F5-teacher' + p.replace(/\//g, '_') + '.png' })
  }
  await t.ctx.close()
  const s = await login('s1', 's1@e2e.kr')
  for (const p of ['/student/today', '/student/notices', '/student/notices/A1', '/class-room', '/meals', '/calendar']) {
    await s.page.goto(BASE + p, { waitUntil: 'load' }).catch(() => {})
    await sleep(1800)
    const stuck = await s.page.locator('.animate-spin').count()
    check('F5.s' + p, `학생 ${p} 로드(스피너 잔존 X)`, !s.page.url().includes('/auth/login') && stuck === 0, `url=${s.page.url().replace(BASE, '')} spinner=${stuck}`)
    await s.page.screenshot({ path: OUT + 'F5-student' + p.replace(/\//g, '_') + '.png' })
  }
  await s.ctx.close()
} catch (e) { check('F5.x', '스모크 예외', false, e.message) }

// ── F13: 알림 API 수신 범위 + 교사 학교 소속(서버 설정) ─────────────────
try {
  const { initializeApp, deleteApp } = require('firebase/app')
  const { getAuth, connectAuthEmulator, signInWithEmailAndPassword } = require('firebase/auth')
  const { getFirestore, connectFirestoreEmulator, doc, setDoc, updateDoc, serverTimestamp } = require('firebase/firestore')
  async function sess(email) {
    const app = initializeApp({ projectId: 'demo-classmate', apiKey: 'e2e-fake-key' }, 'k-' + email + Math.random())
    const a = getAuth(app); connectAuthEmulator(a, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true })
    const d = getFirestore(app); connectFirestoreEmulator(d, FS_HOST, FS_PORT)
    const cred = await signInWithEmailAndPassword(a, email, PW)
    return { d, uid: cred.user.uid, token: await cred.user.getIdToken(), close: () => deleteApp(app) }
  }
  const post = async (path, token, body) => {
    const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) })
    return { status: r.status, j: await r.json().catch(() => ({})) }
  }
  const notify = (s, toUid) => post('/api/notify', s.token, { toUid, title: '테스트 알림', body: '본문', url: '/student/today' })
  const ok = (r) => r.status === 200 || r.status === 202
  const t = await sess('t@e2e.kr'), t2 = await sess('t2@e2e.kr'), t3 = await sess('t3@e2e.kr'), t4 = await sess('t4@e2e.kr'), s1 = await sess('s1@e2e.kr')
  try {
    let r = await notify(t, 's1')
    check('F13.1', '알림: 담임 → 우리 반 학생 허용', ok(r), `${r.status} ${JSON.stringify(r.j)}`)
    r = await notify(t2, 's1')
    check('F13.2', '알림: 다른 반 교사 → 남의 반 학생 거부(403)', r.status === 403, `${r.status}`)
    r = await notify(t, 't2')
    check('F13.3', '알림: 교사 → 같은 학교 교사 허용(교환·SOS)', ok(r), `${r.status}`)
    r = await notify(s1, 'teacher')
    check('F13.4', '알림: 학생 발신 거부', r.status === 403, `${r.status}`)
    r = await notify(t, 'outsider')
    check('F13.5', '알림: 다른 학교 학생 거부', r.status === 403, `${r.status}`)
    r = await notify(t3, 'g1')
    check('F13.6', '알림: 수업 그룹 교사 → 그룹 본반 학생 허용', ok(r), `${r.status}`)

    r = await post('/api/set-school', s1.token, { schoolCode: 'S2' })
    check('F13.7', '학교 설정 API: 학생 거부', r.status === 403, `${r.status}`)
    r = await post('/api/set-school', t.token, { schoolCode: 'S2' })
    check('F13.8', '학교 설정 API: 이미 학교가 있는 교사의 다른 학교 변경 거부', r.status === 409 || r.status === 400, `${r.status} ${JSON.stringify(r.j)}`)
    r = await post('/api/set-school', t4.token, { schoolCode: '7010057' })
    const t4doc = (await db.doc('users/t4').get()).data()
    check('F13.9', '학교 설정 API: NEIS 확인 불가(테스트 환경)면 설정하지 않음(fail-closed)', r.status >= 400 && !t4doc.schoolCode, `${r.status} ${JSON.stringify(r.j)} school=${t4doc.schoolCode}`)
    let w = await updateDoc(doc(t4.d, 'users', 't4'), { schoolCode: 'S1', schoolName: '테스트고' }).then(() => 'allowed', (e) => e.code)
    check('F13.10', '규칙: 교사가 학교를 클라이언트에서 처음 정하는 것 거부', w === 'permission-denied', w)
    w = await setDoc(doc(t4.d, 'classes', 'S1_8_8'), { classId: 'S1_8_8', schoolCode: 'S1', grade: 8, classNm: 8, teacherId: 't4' }).then(() => 'allowed', (e) => e.code)
    check('F13.11', '규칙: 학교가 없는 교사의 반 생성 거부', w === 'permission-denied', w)
    w = await setDoc(doc(t4.d, 'classes', 'S1_1_2'), { teacherId: 't4' }, { merge: true }).then(() => 'allowed', (e) => e.code)
    check('F13.12', '규칙: 학교가 없는 교사의 담임 없는 반 인수 거부', w === 'permission-denied', w)
    w = await updateDoc(doc(t.d, 'users', 'teacher'), { displayName: '김담임' }).then(() => 'allowed', (e) => e.code)
    check('F13.13', '규칙: 학교 있는 교사의 일반 프로필 수정은 허용', w === 'allowed', w)
    w = await updateDoc(doc(t2.d, 'users', 's2'), { classId: 'S1_3_4' }).then(() => 'allowed', (e) => e.code)
    check('F13.14', '규칙: 다른 반 교사가 학생 classId를 자기 반으로 변경 거부', w === 'permission-denied', w)
    w = await updateDoc(doc(t2.d, 'users', 'pending'), { status: 'approved' }).then(() => 'allowed', (e) => e.code)
    check('F13.15', '규칙: 그 반 담임이 아닌 교사의 승인 거부', w === 'permission-denied', w)
    w = await updateDoc(doc(t.d, 'users', 'pending'), { status: 'weird' }).then(() => 'allowed', (e) => e.code)
    check('F13.16', '규칙: 승인/거절 외 상태값 거부', w === 'permission-denied', w)
    w = await updateDoc(doc(t.d, 'users', 'pending'), { status: 'approved' }).then(() => 'allowed', (e) => e.code)
    check('F13.17', '규칙: 담임의 승인 허용', w === 'allowed', w)
  } finally {
    for (const x of [t, t2, t3, t4, s1]) await x.close()
  }
} catch (e) { check('F13.x', '알림 범위·학교 설정 흐름 예외', false, e.message) }

// ── F12: 반 이동·수업 그룹 QR 정책 (/api/join, /api/class-membership, class-roster) ──────
try {
  const { initializeApp, deleteApp } = require('firebase/app')
  const { getAuth, connectAuthEmulator, signInWithEmailAndPassword } = require('firebase/auth')
  const { getFirestore, connectFirestoreEmulator, doc, updateDoc } = require('firebase/firestore')
  const { Timestamp: AdminTs } = require('firebase-admin/firestore')
  async function sess(email) {
    const app = initializeApp({ projectId: 'demo-classmate', apiKey: 'e2e-fake-key' }, 'j-' + email + Math.random())
    const a = getAuth(app); connectAuthEmulator(a, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true })
    const d = getFirestore(app); connectFirestoreEmulator(d, FS_HOST, FS_PORT)
    const cred = await signInWithEmailAndPassword(a, email, PW)
    return { d, uid: cred.user.uid, token: await cred.user.getIdToken(), close: () => deleteApp(app) }
  }
  const tokenFor = async (classId) => {
    const t = [...Array(32)].map((_, i) => '0123456789abcdef'[(i * 7 + classId.length * 3 + Math.floor(Math.random() * 16)) % 16]).join('')
    await db.doc(`classes/${classId}/joinTokens/${t}`).set({ createdAt: AdminTs.now(), expiresAt: AdminTs.fromMillis(Date.now() + 600000) })
    return t
  }
  const post = async (path, token, body) => {
    const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) })
    return { status: r.status, j: await r.json().catch(() => ({})) }
  }
  const join = async (s, classId, name, studentId) => post('/api/join', s.token, { classId, token: await tokenFor(classId), name, studentId })
  const member = (s, action, classId, studentUid) => post('/api/class-membership', s.token, { action, classId, studentUid })
  const user = async (uid) => (await db.doc('users/' + uid).get()).data()
  const roster = async (s, classId) => {
    const r = await fetch(BASE + '/api/class-roster?classId=' + classId, { headers: { Authorization: 'Bearer ' + s.token } })
    return { status: r.status, j: await r.json().catch(() => ({})) }
  }

  const s1 = await sess('s1@e2e.kr'), s2 = await sess('s2@e2e.kr'), s3 = await sess('s3@e2e.kr'), g1 = await sess('g1@e2e.kr'), nb = await sess('n@e2e.kr')
  const t = await sess('t@e2e.kr'), t2 = await sess('t2@e2e.kr'), t3 = await sess('t3@e2e.kr')
  try {
    // 승인된 학생이 같은 학교 다른 실반 QR → 이동 신청(본반 유지)
    let r = await join(s1, 'S1_3_4', '이하늘', '11')
    let u = await user('s1')
    check('F12.1', '실반 QR → 이동 신청(move-pending)', r.status === 200 && r.j.status === 'move-pending', `${r.status} ${JSON.stringify(r.j)}`)
    check('F12.2', '승인 전에는 기존 반·승인 상태 유지', u.classId === CLASS && u.status === 'approved' && u.pendingClassId === 'S1_3_4', JSON.stringify({ c: u.classId, s: u.status, p: u.pendingClassId }))
    r = await join(s1, 'S1_3_4', '이하늘', '11')
    check('F12.3', '같은 반 재신청은 already', r.status === 200 && r.j.status === 'move-pending' && r.j.already === true, JSON.stringify(r.j))
    let w = await updateDoc(doc(s1.d, 'users', 's1'), { pendingClassId: null }).then(() => 'allowed', (e) => e.code)
    check('F12.4', '학생이 자기 이동 신청 필드를 직접 수정 불가', w === 'permission-denied', w)
    // 새 반 담임의 명단에 이동 신청이 보임, 학생에게는 안 보임
    let ro = await roster(t2, 'S1_3_4')
    const mv = (ro.j.members || []).find((m) => m.id === 's1')
    check('F12.5', '새 반 담임 명단에 이동 신청 학생(현재 반 표시)', ro.status === 200 && mv && mv.status === 'pending' && mv.moveFromClassId === CLASS, JSON.stringify(mv || ro.j).slice(0, 200))
    // 권한: 다른 교사·학생은 승인 불가
    r = await member(t3, 'approve-move', 'S1_3_4', 's1')
    check('F12.6', '그 반 담임이 아닌 교사는 이동 승인 불가', r.status === 403, `${r.status}`)
    r = await member(s2, 'approve-move', 'S1_3_4', 's1')
    check('F12.7', '학생은 이동 승인 API 사용 불가', r.status === 403, `${r.status}`)
    r = await member(t2, 'approve-move', 'S1_3_4', 's1')
    u = await user('s1')
    check('F12.8', '새 담임 승인 → 반 이동(학년·반·번호 갱신, 대기 필드 삭제)', r.status === 200 && u.classId === 'S1_3_4' && u.status === 'approved' && Number(u.classNm) === 4 && String(u.studentId) === '11' && !('pendingClassId' in u), JSON.stringify({ st: r.status, c: u.classId, n: u.classNm, id: u.studentId, p: u.pendingClassId }))
    check('F12.9', '실반에서 옮기면 이전 반은 추가 반으로 남지 않음', !(u.extraClassIds || []).includes(CLASS), JSON.stringify(u.extraClassIds))
    r = await member(t2, 'approve-move', 'S1_3_4', 's1')
    check('F12.10', '이미 처리된 이동 재승인은 409', r.status === 409, `${r.status}`)

    // 이동 거절 → 기존 반 그대로
    await join(s2, 'S1_3_4', '박바다', '')
    r = await member(t2, 'reject-move', 'S1_3_4', 's2')
    u = await user('s2')
    check('F12.11', '이동 거절 → 기존 반·승인 유지, 대기 필드 삭제', r.status === 200 && u.classId === CLASS && u.status === 'approved' && !('pendingClassId' in u), JSON.stringify({ st: r.status, c: u.classId, s: u.status, p: u.pendingClassId }))

    // 수업 그룹이 본반인 학생: 실반 QR → 승인 전까지 그룹 유지, 거절돼도 그룹 유지 (r2#8, dc#6)
    r = await join(g1, 'S1_3_4', '그룹생', '')
    u = await user('g1')
    check('F12.12', '그룹 본반 학생의 실반 신청 중에도 그룹 본반·승인 유지', r.j.status === 'move-pending' && u.classId === 'S1_3_2_g_e2e' && u.status === 'approved', JSON.stringify({ r: r.j, c: u.classId, s: u.status }))
    r = await member(t2, 'reject-move', 'S1_3_4', 'g1')
    u = await user('g1')
    check('F12.13', '거절돼도 그룹 소속·승인 유지', u.classId === 'S1_3_2_g_e2e' && u.status === 'approved', JSON.stringify({ c: u.classId, s: u.status }))
    await join(g1, 'S1_3_4', '그룹생', '7')
    r = await member(t2, 'approve-move', 'S1_3_4', 'g1')
    u = await user('g1')
    check('F12.14', '그룹 본반 학생 승인 → 실반 이동 + 그룹은 추가 반으로 유지', u.classId === 'S1_3_4' && (u.extraClassIds || []).includes('S1_3_2_g_e2e'), JSON.stringify({ c: u.classId, e: u.extraClassIds }))

    // 다른 학교 QR 거부
    r = await join(s3, 'S2_1_1', '최구름', '3')
    check('F12.15', '다른 학교 실반 QR 거부(403)', r.status === 403 && (await user('s3')).classId === CLASS, `${r.status} ${JSON.stringify(r.j)}`)
    r = await join(s3, 'S2_1_1_g_x', '최구름', '3')
    check('F12.16', '다른 학교 수업 그룹 QR 거부(403)', r.status === 403, `${r.status}`)
    // 같은 학교 수업 그룹 QR → 추가 반
    r = await join(s3, 'S1_3_2_g_e2e', '최구름', '3')
    u = await user('s3')
    check('F12.17', '같은 학교 수업 그룹 QR → 추가 반 참여', r.status === 200 && r.j.status === 'joined-extra' && (u.extraClassIds || []).includes('S1_3_2_g_e2e') && u.classId === CLASS, JSON.stringify({ r: r.j, e: u.extraClassIds }))
    // 그룹 소유 교사가 추가 반에서 내보내기 (dc#7)
    r = await member(t, 'remove-extra', 'S1_3_2_g_e2e', 's3')
    check('F12.18', '그룹 소유 교사가 아니면 내보내기 불가', r.status === 403, `${r.status}`)
    r = await member(t3, 'remove-extra', 'S1_3_2_g_e2e', 's3')
    u = await user('s3')
    check('F12.19', '그룹 소유 교사는 추가 반에서 내보내기 가능', r.status === 200 && !(u.extraClassIds || []).includes('S1_3_2_g_e2e') && u.classId === CLASS, JSON.stringify({ st: r.status, e: u.extraClassIds }))
    r = await member(t, 'remove-extra', CLASS, 's3')
    check('F12.20', '본반은 내보내기 API로 뺄 수 없음(400)', r.status === 400, `${r.status}`)

    // 신규 학생이 수업 그룹으로 첫 가입 → 학년·반을 그룹 원본 반으로 저장하지 않음 (dc#20)
    r = await join(nb, 'S1_3_2_g_e2e', '새학생', '5')
    u = await user('newbie')
    check('F12.21', '신규 학생 그룹 QR 가입: 대기 + 학년·반 비움', r.status === 200 && u.status === 'pending' && u.classId === 'S1_3_2_g_e2e' && u.grade == null && u.classNm == null, JSON.stringify({ r: r.j, g: u.grade, n: u.classNm }))
  } finally {
    for (const x of [s1, s2, s3, g1, nb, t, t2, t3]) await x.close()
  }
} catch (e) { check('F12.x', '반 이동 정책 흐름 예외', false, e.message) }

await browser.close()
const failed = results.filter((r) => !r.ok)
fs.writeFileSync(OUT + 'results.json', JSON.stringify({ results, pageErrors }, null, 2))
console.log(`\n=== ${LABEL}: ${results.length - failed.length}/${results.length} 통과 ===`)
console.log(`페이지 오류/콘솔 에러 ${pageErrors.length}건 (스모크 구간 ${pageErrors.length - before5}건) → ${OUT}results.json`)
process.exit(0)
