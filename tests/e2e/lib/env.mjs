// E2E 공용 헬퍼 — 로컬 Firebase 에뮬레이터(demo-classmate) 전용. 운영 프로젝트에 연결하지 않습니다.
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { chromium } from 'playwright-core'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
export const require = createRequire(path.join(ROOT, 'package.json'))
export const PROJECT = 'demo-classmate'
export const PW = 'test1234'
export const BASE = process.env.BASE || 'http://127.0.0.1:3100'
export const NEIS_FIXTURE = process.env.NEIS_MOCK_FILE || path.join(ROOT, 'tests/fixtures/neis-mock.runtime.json')

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080'
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099'
const isLocal = (h) => /^(127\.0\.0\.1|localhost):\d+$/.test(h)
if (!isLocal(process.env.FIRESTORE_EMULATOR_HOST) || !isLocal(process.env.FIREBASE_AUTH_EMULATOR_HOST)) {
  throw new Error('E2E는 로컬 에뮬레이터에서만 실행합니다')
}

const { initializeApp, getApps } = require('firebase-admin/app')
const { getAuth } = require('firebase-admin/auth')
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore')
export { Timestamp, FieldValue }

export function admin() {
  const app = getApps()[0] || initializeApp({ projectId: PROJECT })
  return { auth: getAuth(app), db: getFirestore(app) }
}

export async function wipe() {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' })
  await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' })
}

/** users: [{uid, email, doc?}] — doc이 없으면 Auth 계정만 만듦(가입 직후 상태) */
export async function createUsers(users) {
  const { auth, db } = admin()
  for (const u of users) {
    await auth.createUser({ uid: u.uid, email: u.email, password: PW, emailVerified: true, displayName: u.doc?.name || u.uid })
    if (u.doc) await db.collection('users').doc(u.uid).set({ ...u.doc, email: u.email, createdAt: Timestamp.now() })
  }
}

export function writeNeisFixture(data) {
  fs.mkdirSync(path.dirname(NEIS_FIXTURE), { recursive: true })
  fs.writeFileSync(NEIS_FIXTURE, JSON.stringify(data, null, 2))
}

/** 클라이언트 SDK 세션 (보안 규칙을 거치는 실제 앱 경로) */
export async function clientSession(email) {
  const { initializeApp: initClient, deleteApp } = require('firebase/app')
  const { getAuth: getClientAuth, connectAuthEmulator, signInWithEmailAndPassword } = require('firebase/auth')
  const { getFirestore: getClientDb, connectFirestoreEmulator } = require('firebase/firestore')
  const app = initClient({ projectId: PROJECT, apiKey: 'e2e-fake-key' }, 's-' + email + Math.random())
  const a = getClientAuth(app)
  connectAuthEmulator(a, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true })
  const d = getClientDb(app)
  const [fsHost, fsPort] = process.env.FIRESTORE_EMULATOR_HOST.split(':')
  connectFirestoreEmulator(d, fsHost, Number(fsPort))
  const cred = await signInWithEmailAndPassword(a, email, PW)
  return { app, d, uid: cred.user.uid, token: await cred.user.getIdToken(), close: () => deleteApp(app) }
}

export async function api(pathname, token, body, method = 'POST') {
  const r = await fetch(BASE + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  })
  return { status: r.status, j: await r.json().catch(() => ({})) }
}

export function reporter(label) {
  const OUT = path.join(ROOT, 'tests/e2e', `out-${label}`)
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })
  const results = []
  const check = (id, name, ok, detail = '') => {
    results.push({ id, name, ok: Boolean(ok), detail: String(detail) })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? '  — ' + detail : ''}`)
  }
  const note = (id, text) => {
    results.push({ id, name: text, ok: null, detail: 'note' })
    console.log(`NOTE  ${id}  ${text}`)
  }
  const finish = (extra = {}) => {
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, ...extra }, null, 2))
    const checks = results.filter((r) => r.ok !== null)
    const failed = checks.filter((r) => !r.ok)
    console.log(`\n=== ${label}: ${checks.length - failed.length}/${checks.length} 통과 ===`)
    return failed.length
  }
  return { OUT, check, note, finish, results }
}

export async function launchBrowser() {
  const executablePath = fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
    ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
    : undefined
  return chromium.launch({ executablePath })
}

/** 고정 시각(KST) 브라우저 컨텍스트 + 콘솔 오류 수집 */
export async function newPage(browser, { fixedTime, errors, who = '' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' })
  const page = await ctx.newPage()
  if (fixedTime) await page.clock.setFixedTime(new Date(fixedTime))
  if (errors) {
    page.on('pageerror', (e) => errors.push({ who, url: page.url(), kind: 'pageerror', msg: String(e.message || e).slice(0, 300) }))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push({ who, url: page.url(), kind: 'console.error', msg: m.text().slice(0, 300) })
    })
  }
  return { ctx, page }
}

/** Next 화면이 React와 연결(하이드레이션)될 때까지 — 그 전의 입력·클릭은 브라우저 기본 동작이 됨 */
export async function waitHydrated(page, timeout = 15000) {
  // _app이 하이드레이션을 마치면 <html data-hydrated="1">을 남김(window.next.router는 그 전에 생겨 신호로 부족)
  await page.waitForFunction(() => document.documentElement.getAttribute('data-hydrated') === '1', null, { timeout }).catch(() => {})
}

export async function uiLogin(page, email, attempts = 2) {
  for (let i = 0; i < attempts; i++) {
    await page.goto(BASE + '/auth/login', { waitUntil: 'load' })
    await waitHydrated(page)
    await page.fill('input[type=email]', email)
    await page.fill('input[type=password]', PW)
    await page.locator('button[type=submit]:visible').first().click()
    try {
      await page.waitForURL(/\/(student\/|dashboard)/, { timeout: 25000 })
      return
    } catch (e) {
      if (i === attempts - 1) throw e
    }
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
