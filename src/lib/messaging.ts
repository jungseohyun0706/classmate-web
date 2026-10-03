// FCM 웹 푸시 클라이언트 헬퍼
// 모든 함수는 브라우저에서만 동작합니다(핸들러/이펙트 안에서 호출).
// env 미설정 등 어떤 실패도 throw 하지 않고 { ok:false, reason }으로 돌려줍니다.

import {
  deleteToken,
  getMessaging,
  getToken,
  isSupported,
  onMessage,
  type MessagePayload,
} from 'firebase/messaging'
import { arrayRemove, arrayUnion, doc, getDoc, updateDoc } from 'firebase/firestore'
import { auth, db, initFirebase } from './firebase'

export type EnablePushResult =
  | { ok: true; token: string }
  | { ok: false; reason: string }

// 기존 PWA 서비스 워커(/sw.js, scope '/')와 충돌하지 않도록
// FCM 전용 scope를 따로 사용합니다(Firebase SDK 기본 scope와 동일).
const FCM_SW_SCOPE = '/firebase-cloud-messaging-push-scope'

/** 이 브라우저에서 웹 푸시를 지원하는지 확인합니다. */
export async function isPushSupported(): Promise<boolean> {
  if (typeof window === 'undefined') return false
  if (!('Notification' in window)) return false
  if (!('serviceWorker' in navigator)) return false
  try {
    return await isSupported()
  } catch {
    return false
  }
}

let foregroundAttached = false

// 지금 화면에 열려 있는 톡방 classId. 실시간 피드로 이미 보이는 메시지에
// 포그라운드 토스트를 또 띄우지 않기 위해 씁니다.
let activeRoomId: string | null = null

export function setActiveRoom(id: string | null): void {
  activeRoomId = id
}

export function getActiveRoom(): string | null {
  return activeRoomId
}

/**
 * 포그라운드(onMessage) 수신 핸들러를 1회만 등록합니다.
 * 지원되지 않는 환경이면 조용히 무시합니다.
 */
export function attachForegroundHandler(
  callback: (payload: MessagePayload) => void
): void {
  if (foregroundAttached) return
  try {
    const messaging = getMessaging(initFirebase())
    onMessage(messaging, callback)
    foregroundAttached = true
  } catch {
    // messaging 미지원 환경 — 무시
  }
}

/** 새로 등록된 서비스 워커가 활성화될 때까지 잠시 기다립니다(최대 5초). */
async function waitForActivation(
  registration: ServiceWorkerRegistration
): Promise<void> {
  if (registration.active) return
  const sw = registration.installing || registration.waiting
  if (!sw) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5000)
    const onChange = () => {
      if (sw.state === 'activated' || sw.state === 'redundant') {
        sw.removeEventListener('statechange', onChange)
        clearTimeout(timer)
        resolve()
      }
    }
    sw.addEventListener('statechange', onChange)
    onChange()
  })
}

interface PushEnv {
  apiKey: string
  projectId: string
  messagingSenderId: string
  appId: string
  vapidKey: string
}

function readPushEnv(): PushEnv | 'firebase-env-missing' | 'vapid-key-missing' {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
  const messagingSenderId = process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
  const appId = process.env.NEXT_PUBLIC_FIREBASE_APP_ID
  const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY

  if (!apiKey || !projectId || !messagingSenderId || !appId) {
    return 'firebase-env-missing'
  }
  if (!vapidKey) {
    return 'vapid-key-missing'
  }
  return { apiKey, projectId, messagingSenderId, appId, vapidKey }
}

/**
 * FCM 서비스 워커를 등록(설정을 쿼리로 전달, 같은 URL·scope면 기존 등록 재사용)하고
 * 이 기기의 토큰을 받습니다. 알림 권한이 'granted'일 때만 부르세요.
 */
async function issueToken(env: PushEnv): Promise<string> {
  const { apiKey, projectId, messagingSenderId, appId, vapidKey } = env
  const swUrl =
    '/firebase-messaging-sw.js?' +
    new URLSearchParams({ apiKey, projectId, messagingSenderId, appId }).toString()
  const registration = await navigator.serviceWorker.register(swUrl, {
    scope: FCM_SW_SCOPE,
  })
  await waitForActivation(registration)

  const messaging = getMessaging(initFirebase())
  return getToken(messaging, {
    vapidKey,
    serviceWorkerRegistration: registration,
  })
}

/**
 * 푸시 알림 활성화 전체 흐름:
 * 권한 요청 → FCM 서비스 워커 등록(설정을 쿼리로 전달) → 토큰 발급 →
 * users/{uid}.fcmTokens 에 arrayUnion 저장 → (옵션) 포그라운드 핸들러 등록.
 */
export async function enablePush(
  onForeground?: (payload: MessagePayload) => void
): Promise<EnablePushResult> {
  try {
    if (!(await isPushSupported())) {
      return { ok: false, reason: 'unsupported' }
    }

    const env = readPushEnv()
    if (typeof env === 'string') {
      return { ok: false, reason: env }
    }

    const user = auth?.currentUser
    if (!user) {
      return { ok: false, reason: 'not-signed-in' }
    }

    const permission = await Notification.requestPermission()
    if (permission !== 'granted') {
      return {
        ok: false,
        reason: permission === 'denied' ? 'permission-denied' : 'permission-dismissed',
      }
    }

    const token = await issueToken(env)
    if (!token) {
      return { ok: false, reason: 'token-unavailable' }
    }

    await updateDoc(doc(db, 'users', user.uid), {
      fcmTokens: arrayUnion(token),
    })

    if (onForeground) {
      attachForegroundHandler(onForeground)
    }

    return { ok: true, token }
  } catch (e) {
    console.error('enablePush error:', e)
    return { ok: false, reason: 'error' }
  }
}

/**
 * 알림이 켜진 기기에서 앱을 열 때 토큰을 다시 받아, 현재 사용자 문서에 없으면 추가합니다.
 * 권한을 껐다 다시 켜거나 브라우저가 구독을 갱신하면 토큰이 바뀌는데, 서버는 옛 토큰을
 * 발송 실패 때 지우기만 하므로 이 경로가 없으면 푸시가 영영 끊깁니다.
 * 권한 요청은 하지 않으며(이미 'granted'일 때만) 실패는 조용히 무시합니다.
 * '알림 켜짐' 여부는 호출 측(EnablePush의 PushBridge)에서 확인합니다.
 */
export async function refreshPushToken(): Promise<void> {
  try {
    if (!(await isPushSupported())) return
    if (Notification.permission !== 'granted') return
    const env = readPushEnv()
    if (typeof env === 'string') return
    const user = auth?.currentUser
    if (!user) return

    const token = await issueToken(env)
    // 토큰을 받는 사이 계정이 바뀌었으면 다른 사람 문서에 넣지 않습니다.
    if (!token || auth.currentUser?.uid !== user.uid) return

    const ref = doc(db, 'users', user.uid)
    const snap = await getDoc(ref)
    if (!snap.exists()) return
    const saved: unknown = snap.get('fcmTokens')
    if (Array.isArray(saved) && saved.includes(token)) return
    await updateDoc(ref, { fcmTokens: arrayUnion(token) })
  } catch (e) {
    console.warn('refreshPushToken error:', e)
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ])
}

async function releasePushTokenNow(uid: string): Promise<void> {
  let registration: ServiceWorkerRegistration | undefined
  try {
    if (!(await isPushSupported())) return
    if (Notification.permission !== 'granted') return
    registration = await navigator.serviceWorker.getRegistration(FCM_SW_SCOPE)
    // getRegistration은 scope '/'의 /sw.js를 돌려줄 수도 있어 FCM 전용 scope인지 확인합니다.
    if (!registration || !registration.scope.endsWith(FCM_SW_SCOPE)) return
    // 구독이 없으면 이 기기에 살아 있는 토큰도 없습니다(아래 getToken이 새 토큰을 만들지 않게).
    if (!(await registration.pushManager.getSubscription())) return

    const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY
    if (vapidKey) {
      const messaging = getMessaging(initFirebase())
      // 기존 등록을 넘겨 두어야 deleteToken이 설정 없는 기본 SW를 같은 scope에 새로 등록해
      // 설정이 담긴 SW를 덮어쓰지 않습니다.
      const token = await getToken(messaging, {
        vapidKey,
        serviceWorkerRegistration: registration,
      })
      if (token) {
        // 아직 이전 사용자로 인증된 상태라 규칙상 본인 문서에서 지울 수 있습니다.
        await withTimeout(
          updateDoc(doc(db, 'users', uid), { fcmTokens: arrayRemove(token) }).catch((e) => {
            console.warn('releasePushToken: token remove failed:', e)
          }),
          1500
        )
        await deleteToken(messaging)
        return
      }
    }
  } catch (e) {
    console.warn('releasePushToken error:', e)
  }
  // deleteToken까지 못 했으면(오프라인 등) 최소한 이 기기의 푸시 구독을 끊어
  // 이전 계정 알림이 더는 오지 않게 합니다. (서버는 다음 발송 때 무효 토큰을 지웁니다)
  try {
    const subscription = await registration?.pushManager.getSubscription()
    await subscription?.unsubscribe()
  } catch {
    // 무시
  }
}

/**
 * 로그아웃·계정 전환 직전에 이 기기의 푸시 토큰을 이전 사용자 문서에서 지우고 삭제합니다.
 * (공용 기기에서 다음 사용자에게 이전 계정 알림이 뜨지 않게)
 * 로그아웃을 막지 않도록 절대 throw하지 않고, 최대 3초만 기다립니다.
 */
export async function releasePushToken(uid: string): Promise<void> {
  try {
    await withTimeout(releasePushTokenNow(uid), 3000)
  } catch {
    // 무시
  }
}

/** 같은 출처의 앱 경로(pathname+search+hash)만 돌려줍니다. 외부 주소면 null. */
export function toAppPath(url: string): string | null {
  try {
    const u = new URL(url, window.location.origin)
    if (u.origin !== window.location.origin) return null
    // '//evil.com' 같은 경로는 라우터가 외부 주소로 해석하므로 앞 슬래시를 하나로 줄입니다.
    return u.pathname.replace(/^\/{2,}/, '/') + u.search + u.hash
  } catch {
    return null
  }
}
