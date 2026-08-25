/* eslint-disable no-undef */
// 클래스메이트 FCM 백그라운드 메시징 서비스 워커 (classic SW, compat 빌드)
// 등록 URL의 쿼리 파라미터(apiKey, projectId, messagingSenderId, appId)로
// Firebase 설정을 전달받아 초기화합니다. 파라미터 없이 등록되면 조용히 무시합니다.
importScripts(
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js'
)

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

try {
  const params = new URLSearchParams(self.location.search)
  const config = {
    apiKey: params.get('apiKey'),
    projectId: params.get('projectId'),
    messagingSenderId: params.get('messagingSenderId'),
    appId: params.get('appId'),
  }
  if (!config.apiKey || !config.projectId || !config.messagingSenderId || !config.appId) {
    throw new Error('firebase config missing in service worker query params')
  }

  firebase.initializeApp(config)
  const messaging = firebase.messaging()

  // 서버는 중복 표시를 막기 위해 data-only 메시지를 보냅니다.
  // (notification 페이로드가 섞여 와도 표시되도록 둘 다 읽습니다.)
  messaging.onBackgroundMessage((payload) => {
    const data = (payload && payload.data) || {}
    const notification = (payload && payload.notification) || {}
    const title = data.title || notification.title || '클래스메이트'
    const body = data.body || notification.body || ''
    const url = data.url || '/dashboard'

    self.registration.showNotification(title, {
      body,
      data: { url },
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
    })
  })
} catch (e) {
  // 설정 없이(쿼리 파라미터 없이) 등록된 경우: 초기화를 건너뜁니다.
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/dashboard'
  const target = new URL(url, self.location.origin).href

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      // 1) 같은 URL의 창이 있으면 포커스
      for (let i = 0; i < clientList.length; i += 1) {
        const client = clientList[i]
        if (client.url === target && 'focus' in client) {
          return client.focus()
        }
      }
      // 2) 같은 origin의 창이 있으면 포커스 후 이동
      for (let i = 0; i < clientList.length; i += 1) {
        const client = clientList[i]
        if ('focus' in client) {
          await client.focus()
          if ('navigate' in client) {
            try {
              return await client.navigate(target)
            } catch (err) {
              return undefined
            }
          }
          return undefined
        }
      }
      // 3) 열린 창이 없으면 새로 열기
      return self.clients.openWindow(target)
    })()
  )
})
