// v2: 초대 화면(/i/{코드}, /join?c=&t=, /install?code=)은 캐시에 넣지 않음 — 이전 버전이 저장해 둔 초대 코드·입장 토큰 주소를 activate에서 지움
// v3: 초대 주소를 ?next=로 품은 로그인·가입 화면(/auth/login?next=/i/{코드} 등)도 넣지 않음 — v2까지 저장된 항목은 activate에서 지움
const VERSION = 'classmate-v3'

// 주소에 초대 코드·입장 토큰이 들어가는 화면. 내용은 항상 서버 확인이 필요하므로 저장해 둘 이유가 없음
function isInviteNavigation(url) {
  return url.pathname.startsWith('/i/') || url.pathname === '/join' || (url.pathname === '/install' && url.searchParams.has('code'))
}

// ?next=(로그인 뒤 돌아갈 곳)가 초대 화면을 가리키는지 — next 안에 다시 next가 있으면 몇 겹까지 따라감
function nextIsInvite(url, depth = 0) {
  const next = url.searchParams.get('next')
  if (!next) return false
  // 너무 깊게 싸였거나 읽을 수 없는 next는 확인하지 않고 '초대일 수 있음'으로 봄(저장 안 함)
  if (depth >= 3) return true
  let inner
  try {
    inner = new URL(next, url.origin)
  } catch {
    return true
  }
  return isInviteNavigation(inner) || nextIsInvite(inner, depth + 1)
}

// 오프라인 대비로 저장해도 되는 화면 이동인지.
// 로그인·가입 화면(/auth/…)은 쿼리가 있으면 저장하지 않음 — 쿼리는 돌아갈 곳(초대 코드가 들어갈 수 있음)뿐이고 로그인은 어차피 온라인이 필요
function shouldStoreNavigation(url) {
  if (isInviteNavigation(url) || nextIsInvite(url)) return false
  if (url.pathname.startsWith('/auth/') && url.search) return false
  return true
}

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim()
      const keys = await caches.keys()
      await Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)))
    })()
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return

  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(request))
    return
  }
  if (request.mode === 'navigate') {
    // 화면 이동은 항상 네트워크 먼저(온라인이면 최신 화면). 초대 화면·초대로 돌아가는 로그인 화면은 오프라인 대비 저장도 하지 않음
    event.respondWith(networkFirst(request, shouldStoreNavigation(url)))
  }
})

async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) {
    const cache = await caches.open(VERSION)
    cache.put(request, response.clone())
  }
  return response
}

async function networkFirst(request, store = true) {
  try {
    const response = await fetch(request)
    if (store && response.ok) {
      const cache = await caches.open(VERSION)
      cache.put(request, response.clone())
    }
    return response
  } catch (error) {
    const cached = await caches.match(request)
    if (cached) return cached
    throw error
  }
}
