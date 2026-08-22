/* Classmate 서비스워커 — PWA 설치/오프라인 지원 (TWA 래핑 요건) */
const VER = 'classmate-v1';
const PRECACHE = ['/offline', '/manifest.json', '/icon.svg', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VER).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VER).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  // 페이지 이동: 네트워크 우선 → 캐시 → 오프라인 안내
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then((r) => {
          const copy = r.clone();
          caches.open(VER).then((c) => c.put(request, copy));
          return r;
        })
        .catch(() => caches.match(request).then((m) => m || caches.match('/offline')))
    );
    return;
  }

  // 정적 자원: 캐시 우선
  if (url.pathname.startsWith('/_next/static/') || /\.(js|css|png|svg|ico|woff2?)$/.test(url.pathname)) {
    e.respondWith(
      caches.match(request).then(
        (m) =>
          m ||
          fetch(request).then((r) => {
            const copy = r.clone();
            caches.open(VER).then((c) => c.put(request, copy));
            return r;
          })
      )
    );
  }
});
