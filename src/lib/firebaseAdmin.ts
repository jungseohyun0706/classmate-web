/**
 * 서버 전용 firebase-admin 초기화.
 * - 프로덕션(Vercel): FIREBASE_SERVICE_ACCOUNT 환경변수에 서비스 계정 JSON 전체를 넣는다.
 * - 에뮬레이터: FIREBASE_AUTH_EMULATOR_HOST / FIRESTORE_EMULATOR_HOST 가 설정돼 있으면
 *   자격증명 없이 projectId만으로 동작한다.
 */
import { getApps, initializeApp, cert, type App } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'

let app: App | null = null

export function initAdmin(): App {
  if (app) return app
  if (getApps().length) {
    app = getApps()[0]
    return app
  }

  const projectId =
    process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'demo-classmate'

  const svc = process.env.FIREBASE_SERVICE_ACCOUNT
  if (svc) {
    const parsed = JSON.parse(svc)
    app = initializeApp({ credential: cert(parsed), projectId: parsed.project_id || projectId })
  } else {
    // 에뮬레이터 또는 GCP 기본 자격증명 환경
    app = initializeApp({ projectId })
  }
  return app
}

export const adminAuth = () => getAuth(initAdmin())
export const adminDb = () => getFirestore(initAdmin())

export const adminAvailable = () =>
  Boolean(process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIRESTORE_EMULATOR_HOST)
