// firebase-admin 지연 초기화 + FCM 발송 헬퍼 (서버 전용 — API 라우트에서만 import)
// import 시점에는 절대 throw 하지 않습니다. 설정이 없으면 각 함수가 null/실패를 돌려줍니다.

import fs from 'fs'
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app'
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { getMessaging, type MulticastMessage } from 'firebase-admin/messaging'

interface ServiceAccountJson {
  project_id?: string
  client_email?: string
  private_key?: string
}

export interface PushPayload {
  title: string
  body: string
  url?: string
}

export interface PushResult {
  sent: boolean
  successCount: number
  failureCount: number
  reason?: string
}

let cachedApp: App | null = null
// undefined = 아직 로드 안 함, null = 로드 실패/미설정
let cachedAccount: ServiceAccountJson | null | undefined

function loadServiceAccount(): ServiceAccountJson | null {
  if (cachedAccount !== undefined) return cachedAccount
  cachedAccount = null
  try {
    const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    if (inline && inline.trim()) {
      cachedAccount = JSON.parse(inline) as ServiceAccountJson
      return cachedAccount
    }
    const path = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_PATH
    if (path && fs.existsSync(path)) {
      cachedAccount = JSON.parse(fs.readFileSync(path, 'utf8')) as ServiceAccountJson
      return cachedAccount
    }
  } catch (e) {
    console.error('fcm-admin: service account load error:', e)
    cachedAccount = null
  }
  return cachedAccount
}

/** 서비스 계정이 올바르게 설정되어 있는지(초기화 가능 여부) 확인합니다. */
export function isAdminConfigured(): boolean {
  const sa = loadServiceAccount()
  return Boolean(sa && sa.project_id && sa.client_email && sa.private_key)
}

/** admin 앱을 지연 초기화해 반환합니다. 설정이 없으면 null. */
export function getAdminApp(): App | null {
  if (cachedApp) return cachedApp
  const existing = getApps()
  if (existing.length > 0) {
    cachedApp = existing[0]
    return cachedApp
  }
  const sa = loadServiceAccount()
  if (!sa || !sa.project_id || !sa.client_email || !sa.private_key) return null
  try {
    cachedApp = initializeApp({
      credential: cert({
        projectId: sa.project_id,
        clientEmail: sa.client_email,
        // 인라인 env JSON에서는 개행이 "\\n" 리터럴로 들어오는 경우가 많음
        privateKey: sa.private_key.replace(/\\n/g, '\n'),
      }),
    })
    return cachedApp
  } catch (e) {
    console.error('fcm-admin: initializeApp error:', e)
    return null
  }
}

/** Firebase ID 토큰을 검증합니다. 실패/미설정 시 null. */
export async function verifyIdToken(token: string): Promise<DecodedIdToken | null> {
  if (!token) return null
  const app = getAdminApp()
  if (!app) return null
  try {
    return await getAuth(app).verifyIdToken(token)
  } catch {
    return null
  }
}

/**
 * users/{uid}.fcmTokens 의 모든 토큰으로 웹 푸시를 보냅니다.
 * - 중복 표시(SDK 자동 표시 + onBackgroundMessage)를 막기 위해 data-only로 발송,
 *   표시는 firebase-messaging-sw.js 의 onBackgroundMessage가 담당합니다.
 * - 'registration-token-not-registered' 등 무효 토큰은 문서에서 제거합니다.
 */
export async function sendPushToUser(
  uid: string,
  payload: PushPayload
): Promise<PushResult> {
  const app = getAdminApp()
  if (!app) {
    return { sent: false, successCount: 0, failureCount: 0, reason: 'push-not-configured' }
  }
  try {
    const firestore = getFirestore(app)
    const userRef = firestore.collection('users').doc(uid)
    const snap = await userRef.get()
    const raw = snap.exists ? snap.get('fcmTokens') : null
    const tokens: string[] = Array.isArray(raw)
      ? raw.filter((t: unknown): t is string => typeof t === 'string' && t.length > 0)
      : []
    if (tokens.length === 0) {
      return { sent: false, successCount: 0, failureCount: 0, reason: 'no-tokens' }
    }

    const url = payload.url || '/dashboard'
    const message: MulticastMessage = {
      tokens,
      data: {
        title: payload.title,
        body: payload.body,
        url,
      },
      webpush: {
        headers: { Urgency: 'high', TTL: '86400' },
        // 링크는 절대 https URL만 허용되므로, 절대 URL일 때만 지정합니다.
        // (상대 경로는 SW의 notificationclick에서 data.url로 처리)
        ...(url.indexOf('https://') === 0 ? { fcmOptions: { link: url } } : {}),
      },
    }

    const res = await getMessaging(app).sendEachForMulticast(message)

    const invalidTokens: string[] = []
    res.responses.forEach((r, i) => {
      const code = r.error?.code || ''
      if (
        code.indexOf('registration-token-not-registered') !== -1 ||
        code.indexOf('invalid-registration-token') !== -1
      ) {
        invalidTokens.push(tokens[i])
      }
    })
    if (invalidTokens.length > 0) {
      try {
        await userRef.update({ fcmTokens: FieldValue.arrayRemove(...invalidTokens) })
      } catch (e) {
        console.error('fcm-admin: token prune error:', e)
      }
    }

    return {
      sent: res.successCount > 0,
      successCount: res.successCount,
      failureCount: res.failureCount,
    }
  } catch (e) {
    console.error('fcm-admin: sendPushToUser error:', e)
    return { sent: false, successCount: 0, failureCount: 0, reason: 'send-error' }
  }
}
