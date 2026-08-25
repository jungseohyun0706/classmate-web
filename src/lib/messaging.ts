// FCM 웹 푸시 클라이언트 헬퍼
// 모든 함수는 브라우저에서만 동작합니다(핸들러/이펙트 안에서 호출).
// env 미설정 등 어떤 실패도 throw 하지 않고 { ok:false, reason }으로 돌려줍니다.

import {
  getMessaging,
  getToken,
  isSupported,
  onMessage,
  type MessagePayload,
} from 'firebase/messaging'
import { arrayUnion, doc, updateDoc } from 'firebase/firestore'
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

    const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY
    const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
    const messagingSenderId = process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
    const appId = process.env.NEXT_PUBLIC_FIREBASE_APP_ID
    const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY

    if (!apiKey || !projectId || !messagingSenderId || !appId) {
      return { ok: false, reason: 'firebase-env-missing' }
    }
    if (!vapidKey) {
      return { ok: false, reason: 'vapid-key-missing' }
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

    const swUrl =
      '/firebase-messaging-sw.js?' +
      new URLSearchParams({ apiKey, projectId, messagingSenderId, appId }).toString()
    const registration = await navigator.serviceWorker.register(swUrl, {
      scope: FCM_SW_SCOPE,
    })
    await waitForActivation(registration)

    const messaging = getMessaging(initFirebase())
    const token = await getToken(messaging, {
      vapidKey,
      serviceWorkerRegistration: registration,
    })
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
