// 직접 입력 일정 구독 복구·저장 오류 문구 회귀 테스트 (운영 점검 3번 — 새 앱 + 예전 규칙 구간)
//  - usePersonalEntries가 구독 오류(permission-denied 등) 뒤 새로 고침 전까지 계속 깨져 있던 문제:
//    화면 복귀·포커스·온라인 복구 때 다시 구독, 간격·횟수 제한, 해제 정리, StrictMode 이중 실행에서도 구독 1개
//  - 로그인 상태에서 저장이 permission-denied로 막히면 '다시 로그인' 대신 중립 문구(로그인이 풀렸을 때만 다시 로그인 안내)
//
// personalEntries.ts·PersonalEntryForm.tsx는 firebase.ts(window 사용)·JSX를 불러 테스트 빌드(lib es2020)에 넣을 수 없어
// 원본을 TypeScript로 바로 CommonJS로 바꿔 불러오고, Firebase·React는 작은 가짜로 바꿉니다.
import { describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'
import * as dates from '../../src/lib/timetable/dates'

/** 원본 위치 — 컴파일 위치(.test-dist/tests/unit)와 원본 위치 모두에서 찾음 */
function srcPath(rel: string): string {
  const cands = [path.resolve(__dirname, '../../..', rel), path.resolve(__dirname, '../..', rel), path.resolve(process.cwd(), rel)]
  const f = cands.find((p) => fs.existsSync(p))
  if (!f) throw new Error(`소스 없음: ${rel}`)
  return f
}

type Mod = Record<string, unknown>

/** TS(X) 원본을 CommonJS로 바꿔 실행. stubs에 있는 import는 그 값을, 나머지는 실제 패키지를 씀 */
function loadTs(rel: string, stubs: Record<string, unknown>): Mod {
  const file = srcPath(rel)
  const out = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText
  const realRequire = createRequire(file)
  const req = (id: string): unknown => {
    if (id in stubs) return stubs[id]
    if (id.startsWith('.')) throw new Error(`가짜가 없는 상대 경로 import: ${id} (${rel})`)
    return realRequire(id)
  }
  const mod = { exports: {} as Mod }
  new Function('require', 'module', 'exports', out)(req, mod, mod.exports)
  return mod.exports
}

// ───────────────────────── 가짜 Firestore ─────────────────────────

interface FakeListener {
  next: (snap: unknown) => void
  error: (e: unknown) => void
  active: boolean
}
const listeners: FakeListener[] = []
const live = () => listeners.filter((l) => l.active)
const lastListener = () => listeners[listeners.length - 1]
const serverSnap = (fromCache = false) => ({ docs: [], metadata: { fromCache, hasPendingWrites: false } })

const firestoreStub = {
  collection: () => ({}),
  doc: () => ({ id: 'x' }),
  onSnapshot: (_ref: unknown, _opts: unknown, next: FakeListener['next'], error: FakeListener['error']) => {
    const l: FakeListener = { next, error, active: true }
    listeners.push(l)
    return () => {
      l.active = false
    }
  },
}
const firebaseStub: { db: unknown; auth: { currentUser: { uid: string } | null } | undefined } = {
  db: {},
  auth: { currentUser: { uid: 'u1' } },
}

// ───────────────────────── 가짜 React(훅 하나만 돌리는 최소 런타임) ─────────────────────────

type EffectFn = () => void | (() => void)
interface Slot {
  v?: unknown
  current?: unknown
  deps?: readonly unknown[]
  fn?: EffectFn
  cleanup?: void | (() => void)
}
let dispatcher: {
  useState: (init: unknown) => [unknown, (u: unknown) => void]
  useRef: (init: unknown) => Slot
  useEffect: (fn: EffectFn, deps?: readonly unknown[]) => void
} | null = null

const reactStub = {
  useState: (init: unknown) => dispatcher!.useState(init),
  useRef: (init: unknown) => dispatcher!.useRef(init),
  useEffect: (fn: EffectFn, deps?: readonly unknown[]) => dispatcher!.useEffect(fn, deps),
}

/** 훅을 마운트. strict면 React 19 StrictMode처럼 첫 마운트 때 effect를 실행→정리→다시 실행 */
function mountHook<R>(hook: () => R, { strict = false } = {}) {
  const slots: Slot[] = []
  let cursor = 0
  let queued: Array<{ k: number; fn: EffectFn; deps?: readonly unknown[] }> = []
  let dirty = false
  let busy = false
  let mounted = true
  let result!: R
  /** effect 슬롯 번호(렌더마다 같은 순서) */
  const effectKeys: number[] = []

  const api = {
    useState(init: unknown): [unknown, (u: unknown) => void] {
      const k = cursor++
      if (!slots[k]) slots[k] = { v: typeof init === 'function' ? (init as () => unknown)() : init }
      const s = slots[k]
      const set = (u: unknown) => {
        if (!mounted) return
        const nv = typeof u === 'function' ? (u as (p: unknown) => unknown)(s.v) : u
        if (Object.is(nv, s.v)) return
        s.v = nv
        dirty = true
        if (!busy) flush()
      }
      return [s.v, set]
    },
    useRef(init: unknown): Slot {
      const k = cursor++
      if (!slots[k]) slots[k] = { current: init }
      return slots[k]
    },
    useEffect(fn: EffectFn, deps?: readonly unknown[]) {
      const k = cursor++
      if (!effectKeys.includes(k)) effectKeys.push(k)
      const prev = slots[k]
      const same = prev?.deps && deps && deps.length === prev.deps.length && deps.every((d, j) => Object.is(d, prev.deps![j]))
      if (!same) queued.push({ k, fn, deps })
    },
  }

  function renderAndCommit() {
    cursor = 0
    queued = []
    dispatcher = api
    try {
      result = hook()
    } finally {
      dispatcher = null
    }
    const q = queued
    for (const e of q) {
      const c = slots[e.k]?.cleanup
      if (typeof c === 'function') c()
    }
    for (const e of q) slots[e.k] = { deps: e.deps, fn: e.fn, cleanup: e.fn() }
  }

  function flush() {
    busy = true
    try {
      let guard = 0
      do {
        dirty = false
        renderAndCommit()
        if (++guard > 50) throw new Error('렌더가 멈추지 않음(무한 루프)')
      } while (dirty)
    } finally {
      busy = false
    }
  }

  busy = true
  try {
    renderAndCommit()
    if (strict) {
      for (const k of effectKeys) {
        const c = slots[k]?.cleanup
        if (typeof c === 'function') c()
      }
      for (const k of effectKeys) slots[k].cleanup = slots[k].fn!()
    }
  } finally {
    busy = false
  }
  if (dirty) flush()

  return {
    get current() {
      return result
    },
    unmount() {
      mounted = false
      for (const k of effectKeys) {
        const c = slots[k]?.cleanup
        if (typeof c === 'function') c()
      }
    },
  }
}

// ───────────────────────── 가짜 window·document ─────────────────────────

interface FakeDoc extends EventTarget {
  visibilityState: 'visible' | 'hidden'
}
function installDom() {
  const win = new EventTarget()
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as 'visible' | 'hidden' }) as FakeDoc
  const g = globalThis as unknown as Record<string, unknown>
  g.window = win
  g.document = doc
  return {
    win,
    doc,
    focus: () => win.dispatchEvent(new Event('focus')),
    online: () => win.dispatchEvent(new Event('online')),
    show: () => {
      doc.visibilityState = 'visible'
      doc.dispatchEvent(new Event('visibilitychange'))
    },
    hide: () => {
      doc.visibilityState = 'hidden'
      doc.dispatchEvent(new Event('visibilitychange'))
    },
    remove: () => {
      delete g.window
      delete g.document
    },
  }
}

// ───────────────────────── 대상 모듈 ─────────────────────────

const pe = loadTs('src/lib/timetable/personalEntries.ts', {
  react: reactStub,
  'firebase/firestore': firestoreStub,
  '../firebase': firebaseStub,
  './dates': dates,
}) as {
  PERSONAL_RESUBSCRIBE: { maxAttempts: number; minGapMs: number; maxGapMs: number }
  canResubscribePersonal: (r: { attempts: number; startedAt: number }, now: number) => boolean
  watchPersonalResubscribe: (r: { attempts: number; startedAt: number }, resubscribe: () => void) => () => void
  usePersonalEntries: (uid: string | null) => { entries: unknown[]; loaded: boolean; error: string | null }
}

const form = loadTs('src/components/timetable/PersonalEntryForm.tsx', {
  react: reactStub,
  '../../lib/timetable/engine': {},
  '../../lib/timetable/dates': dates,
  '../../lib/timetable/client': {},
  '../../lib/timetable/personalEntries': pe,
  '../../lib/firebase': firebaseStub,
  '../ui/feedback': {},
  './LessonCard': {},
}) as { personalWriteErrorText: (code: string, linking?: boolean, uid?: string | null) => string }

const { PERSONAL_RESUBSCRIBE: P } = pe

// ───────────────────────── 테스트 ─────────────────────────

describe('canResubscribePersonal — 간격을 늘려 가며 최대 횟수까지', () => {
  test('첫 재시도는 마지막 구독 시작 뒤 최소 간격이 지나야 함', () => {
    assert.equal(pe.canResubscribePersonal({ attempts: 0, startedAt: 1000 }, 1000), false)
    assert.equal(pe.canResubscribePersonal({ attempts: 0, startedAt: 1000 }, 1000 + P.minGapMs - 1), false)
    assert.equal(pe.canResubscribePersonal({ attempts: 0, startedAt: 1000 }, 1000 + P.minGapMs), true)
  })

  test('간격은 두 배씩 늘고 최대 간격에서 멈춤', () => {
    assert.equal(pe.canResubscribePersonal({ attempts: 1, startedAt: 0 }, P.minGapMs * 2 - 1), false)
    assert.equal(pe.canResubscribePersonal({ attempts: 1, startedAt: 0 }, P.minGapMs * 2), true)
    assert.equal(pe.canResubscribePersonal({ attempts: 3, startedAt: 0 }, P.minGapMs * 8), true)
    const late = P.maxAttempts - 1
    assert.ok(P.minGapMs * 2 ** late > P.maxGapMs, '마지막 시도 전 간격은 상한에 걸림')
    assert.equal(pe.canResubscribePersonal({ attempts: late, startedAt: 0 }, P.maxGapMs - 1), false)
    assert.equal(pe.canResubscribePersonal({ attempts: late, startedAt: 0 }, P.maxGapMs), true)
  })

  test('최대 횟수를 채우면 아무리 오래 지나도 다시 구독하지 않음', () => {
    assert.equal(pe.canResubscribePersonal({ attempts: P.maxAttempts, startedAt: 0 }, 10 ** 12), false)
  })
})

describe('watchPersonalResubscribe — 화면 복귀·포커스·온라인 복구 때만', () => {
  test('focus와 visibilitychange가 한꺼번에 와도 한 번만, hidden이면 무시, 해제 뒤엔 반응 없음', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
    const dom = installDom()
    try {
      const r = { attempts: 0, startedAt: Date.now() }
      let calls = 0
      const stop = pe.watchPersonalResubscribe(r, () => calls++)
      dom.focus()
      assert.equal(calls, 0, '방금 구독했으면 바로 다시 하지 않음')
      t.mock.timers.tick(P.minGapMs)
      dom.hide()
      assert.equal(calls, 0, '숨겨질 때는 다시 구독하지 않음')
      dom.show()
      dom.focus()
      assert.equal(calls, 1, '화면 복귀 + 포커스 = 한 번')
      assert.deepEqual(r, { attempts: 1, startedAt: Date.now() })
      t.mock.timers.tick(P.minGapMs * 2)
      dom.online()
      assert.equal(calls, 2, '온라인 복구 때도 다시 구독')
      stop()
      t.mock.timers.tick(P.maxGapMs)
      dom.focus()
      dom.show()
      assert.equal(calls, 2, '해제 뒤에는 반응하지 않음')
    } finally {
      dom.remove()
    }
  })

  test('계속 막혀도 최대 횟수까지만(이벤트가 아무리 많아도)', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
    const dom = installDom()
    try {
      const r = { attempts: 0, startedAt: Date.now() }
      let calls = 0
      const stop = pe.watchPersonalResubscribe(r, () => calls++)
      for (let i = 0; i < 200; i++) {
        t.mock.timers.tick(30_000)
        dom.focus()
        dom.show()
      }
      assert.equal(calls, P.maxAttempts)
      stop()
    } finally {
      dom.remove()
    }
  })

  test('window가 없으면(SSR) 아무것도 하지 않음', () => {
    const stop = pe.watchPersonalResubscribe({ attempts: 0, startedAt: 0 }, () => assert.fail('호출되면 안 됨'))
    stop()
  })
})

describe('usePersonalEntries — 구독 오류 뒤 새로 고침 없이 복구', () => {
  function setup(t: { mock: typeof mock }) {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 })
    t.mock.method(console, 'warn', () => {})
    listeners.length = 0
    return installDom()
  }

  test('StrictMode 이중 실행에서도 활성 구독은 1개, 해제하면 0개', (t) => {
    const dom = setup(t)
    try {
      const h = mountHook(() => pe.usePersonalEntries('u1'), { strict: true })
      assert.equal(listeners.length, 2, 'StrictMode: 구독 → 정리 → 다시 구독')
      assert.equal(live().length, 1)
      lastListener().next(serverSnap())
      assert.equal(h.current.loaded, true)
      assert.equal(h.current.error, null)
      h.unmount()
      assert.equal(live().length, 0)
    } finally {
      dom.remove()
    }
  })

  test('권한 오류 뒤 화면 복귀·포커스 때 다시 구독하고, 서버 결과가 오면 오류가 풀림', (t) => {
    const dom = setup(t)
    try {
      const h = mountHook(() => pe.usePersonalEntries('u1'), { strict: true })
      lastListener().error({ code: 'permission-denied' })
      assert.equal(h.current.error, 'permission-denied')
      assert.equal(h.current.loaded, true)

      dom.focus()
      assert.equal(listeners.length, 2, '최소 간격 전에는 다시 구독하지 않음')

      t.mock.timers.tick(P.minGapMs)
      dom.show()
      dom.focus()
      assert.equal(listeners.length, 3, '화면 복귀 + 포커스에도 한 번만 다시 구독')
      assert.equal(live().length, 1, '이전 구독은 정리됨')
      assert.equal(h.current.error, 'permission-denied', '새 결과가 오기 전까지 오류 표시 유지')

      t.mock.timers.tick(10_000)
      assert.equal(h.current.error, 'permission-denied', '첫 결과 대기 타이머가 오류를 지우지 않음')

      lastListener().next(serverSnap())
      assert.equal(h.current.error, null)
      assert.equal(h.current.loaded, true)

      t.mock.timers.tick(P.maxGapMs)
      dom.focus()
      dom.show()
      assert.equal(listeners.length, 3, '정상이면 포커스로 다시 구독하지 않음')
      h.unmount()
      assert.equal(live().length, 0)
    } finally {
      dom.remove()
    }
  })

  test('계속 거부되면 최대 횟수까지만 다시 구독(캐시 결과가 끼어도 횟수는 쌓임)', (t) => {
    const dom = setup(t)
    try {
      const h = mountHook(() => pe.usePersonalEntries('u1'))
      lastListener().error({ code: 'permission-denied' })
      for (let i = 0; i < 50; i++) {
        t.mock.timers.tick(P.maxGapMs)
        const before = listeners.length
        dom.show()
        dom.focus()
        if (listeners.length > before) {
          // 캐시 결과 → 서버 거부(새 규칙 배포 전 구간)
          lastListener().next(serverSnap(true))
          lastListener().error({ code: 'permission-denied' })
        }
      }
      assert.equal(listeners.length, 1 + P.maxAttempts)
      assert.equal(live().length, 1)
      assert.equal(h.current.error, 'permission-denied')
      h.unmount()
      assert.equal(live().length, 0)
    } finally {
      dom.remove()
    }
  })

  test('서버 결과를 받으면 횟수가 0으로 — 나중 오류에도 다시 복구 가능', (t) => {
    const dom = setup(t)
    try {
      const h = mountHook(() => pe.usePersonalEntries('u1'))
      for (let round = 0; round < P.maxAttempts + 2; round++) {
        lastListener().error({ code: 'permission-denied' })
        t.mock.timers.tick(P.maxGapMs)
        const before = listeners.length
        dom.focus()
        assert.equal(listeners.length, before + 1, `${round}번째 오류 뒤에도 다시 구독`)
        lastListener().next(serverSnap())
        assert.equal(h.current.error, null)
      }
      h.unmount()
    } finally {
      dom.remove()
    }
  })

  test('해제(언마운트) 뒤에는 이벤트가 와도 다시 구독하지 않음', (t) => {
    const dom = setup(t)
    try {
      const h = mountHook(() => pe.usePersonalEntries('u1'))
      lastListener().error({ code: 'permission-denied' })
      h.unmount()
      t.mock.timers.tick(P.maxGapMs)
      dom.focus()
      dom.show()
      assert.equal(listeners.length, 1)
      assert.equal(live().length, 0)
    } finally {
      dom.remove()
    }
  })

  test('첫 결과가 늦으면 3초 뒤 빈 목록으로 진행(기존 동작 유지)', (t) => {
    const dom = setup(t)
    try {
      const h = mountHook(() => pe.usePersonalEntries('u1'))
      assert.equal(h.current.loaded, false)
      t.mock.timers.tick(3000)
      assert.equal(h.current.loaded, true)
      assert.equal(h.current.error, null)
      h.unmount()
    } finally {
      dom.remove()
    }
  })
})

describe('personalWriteErrorText — 로그인이 풀렸을 때만 다시 로그인 안내', () => {
  const withUser = (u: { uid: string } | null, fn: () => void) => {
    const prev = firebaseStub.auth
    firebaseStub.auth = { currentUser: u }
    try {
      fn()
    } finally {
      firebaseStub.auth = prev
    }
  }

  test('로그인 상태의 permission-denied는 중립 문구(다시 로그인 안내 없음)', () => {
    withUser({ uid: 'u1' }, () => {
      const text = form.personalWriteErrorText('permission-denied', false, 'u1')
      assert.equal(text, '지금은 저장할 수 없어요. 잠시 후 다시 시도해 주세요.')
      assert.doesNotMatch(text, /로그인/)
      assert.doesNotMatch(form.personalWriteErrorText('permission-denied'), /로그인/, 'uid 없이 불러도(내 수업 화면) 같음')
    })
  })

  test('공식 수업 연결 중 permission-denied는 연결 안내 그대로', () => {
    withUser({ uid: 'u1' }, () => {
      assert.match(form.personalWriteErrorText('permission-denied', true, 'u1'), /참여 중인\(승인된\) 공식 수업에만 연결/)
    })
  })

  test('로그아웃됐거나 다른 계정이면 다시 로그인 안내', () => {
    withUser(null, () => {
      assert.match(form.personalWriteErrorText('permission-denied', false, 'u1'), /다시 로그인해 주세요/)
      assert.match(form.personalWriteErrorText('permission-denied', true), /다시 로그인해 주세요/)
    })
    withUser({ uid: 'other' }, () => {
      assert.match(form.personalWriteErrorText('permission-denied', false, 'u1'), /다시 로그인해 주세요/)
    })
  })

  test('unauthenticated는 그대로 다시 로그인 안내, Firebase를 못 쓰면 중립 문구', () => {
    withUser({ uid: 'u1' }, () => {
      assert.equal(form.personalWriteErrorText('unauthenticated', false, 'u1'), '로그인이 필요해요. 다시 로그인해 주세요.')
    })
    const prev = firebaseStub.auth
    firebaseStub.auth = undefined
    try {
      assert.doesNotMatch(form.personalWriteErrorText('permission-denied', false, 'u1'), /로그인/)
    } finally {
      firebaseStub.auth = prev
    }
  })
})
