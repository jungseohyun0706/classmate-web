// 서비스 워커(public/sw.js) 캐시 저장 범위 회귀 테스트
//  [28] '/auth/login?next=/i/{코드}'·'/auth/register?next=/i/{코드}'처럼 초대 주소를 next로 품은 화면이
//       Cache Storage에 저장돼 초대 코드가 남음 → 저장하지 않고, 캐시 버전을 올려 이전 항목을 지움
// sw.js를 node:vm에서 가짜 self·caches·fetch로 실행해 실제 fetch·activate 핸들러를 부릅니다.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

function src(rel: string): string {
  const cands = [path.resolve(__dirname, '../../..', rel), path.resolve(__dirname, '../..', rel), path.resolve(process.cwd(), rel)]
  const f = cands.find((p) => fs.existsSync(p))
  if (!f) throw new Error(`소스 없음: ${rel}`)
  return fs.readFileSync(f, 'utf8')
}

const ORIGIN = 'https://classmate.test'

interface FakeEvent {
  request?: { method: string; url: string; mode: string }
  respondWith?: (p: Promise<unknown>) => void
  waitUntil?: (p: Promise<unknown>) => void
}

function loadSw(existingCaches: string[] = []) {
  const handlers: Record<string, (e: FakeEvent) => void> = {}
  const stores = new Map<string, string[]>()
  existingCaches.forEach((k) => stores.set(k, ['https://classmate.test/old']))
  const puts: string[] = []
  const deleted: string[] = []
  const caches = {
    keys: async () => Array.from(stores.keys()),
    delete: async (k: string) => {
      deleted.push(k)
      return stores.delete(k)
    },
    open: async (k: string) => {
      if (!stores.has(k)) stores.set(k, [])
      return {
        put: (req: { url: string }) => {
          puts.push(req.url)
          stores.get(k)!.push(req.url)
        },
      }
    },
    match: async () => undefined,
  }
  const response = { ok: true, clone() { return this } }
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (e: FakeEvent) => void) => {
      handlers[type] = fn
    },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  }
  const ctx = vm.createContext({ self, caches, fetch: async () => response, URL, console })
  vm.runInContext(src('public/sw.js'), ctx)
  const version = vm.runInContext('VERSION', ctx) as string

  async function navigate(pathAndQuery: string): Promise<boolean> {
    const before = puts.length
    let p: Promise<unknown> | null = null
    handlers.fetch({ request: { method: 'GET', url: ORIGIN + pathAndQuery, mode: 'navigate' }, respondWith: (x) => (p = x) })
    assert.ok(p, `respondWith 호출 안 됨: ${pathAndQuery}`)
    await p
    return puts.length > before
  }

  async function activate(): Promise<void> {
    let p: Promise<unknown> | null = null
    handlers.activate({ waitUntil: (x) => (p = x) })
    await p
  }

  return { navigate, activate, version, stores, deleted }
}

describe('[28] 초대 코드가 든 주소는 Cache Storage에 저장하지 않음', () => {
  test('초대 화면으로 돌아가는 로그인·가입 화면(next=/i/·/join·/install?code)은 저장 안 함', async () => {
    const sw = loadSw()
    const code = 'ABCD2345'
    for (const u of [
      `/auth/login?next=${encodeURIComponent(`/i/${code}`)}`,
      `/auth/register?next=${encodeURIComponent(`/i/${code}`)}`,
      `/auth/login?next=/i/${code}`,
      `/auth/login?next=${encodeURIComponent('/join?c=S1_3_4&t=tok123')}`,
      `/auth/register?next=${encodeURIComponent('/join')}`,
      `/auth/login?next=${encodeURIComponent(`/install?code=${code}`)}`,
      // next 안에 다시 next(가입 → 로그인 → 초대)
      `/auth/register?next=${encodeURIComponent(`/auth/login?next=${encodeURIComponent(`/i/${code}`)}`)}`,
    ]) {
      assert.equal(await sw.navigate(u), false, u)
    }
  })

  test('auth 밖 화면이라도 next가 초대 화면이면 저장 안 함', async () => {
    const sw = loadSw()
    assert.equal(await sw.navigate(`/student/courses?next=${encodeURIComponent('/i/ABCD2345')}`), false)
  })

  test('기존 초대 화면(/i/·/join·/install?code)도 계속 저장 안 함', async () => {
    const sw = loadSw()
    assert.equal(await sw.navigate('/i/ABCD2345'), false)
    assert.equal(await sw.navigate('/join?c=S1_3_4&t=tok123'), false)
    assert.equal(await sw.navigate('/install?code=ABCD2345'), false)
  })

  test('일반 화면은 오프라인 대비로 계속 저장', async () => {
    const sw = loadSw()
    assert.equal(await sw.navigate('/student/today'), true)
    assert.equal(await sw.navigate('/student/timetable?date=20261005'), true)
    assert.equal(await sw.navigate('/auth/login'), true)
    assert.equal(await sw.navigate('/install'), true)
  })

  test('캐시 버전을 올려 activate 때 이전 버전(v1·v2) 항목을 지움', async () => {
    const sw = loadSw(['classmate-v1', 'classmate-v2'])
    assert.notEqual(sw.version, 'classmate-v1')
    assert.notEqual(sw.version, 'classmate-v2')
    await sw.activate()
    assert.deepEqual([...sw.deleted].sort(), ['classmate-v1', 'classmate-v2'])
    assert.equal(sw.stores.has('classmate-v2'), false)
  })
})
