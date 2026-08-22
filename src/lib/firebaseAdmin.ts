/**
 * 서버 전용 firebase-admin 초기화 (Firestore 전용).
 *
 * 주의: `firebase-admin/auth` 는 import 하지 않는다.
 * jwks-rsa → jose(ESM 전용) require 체인 때문에 서버리스 런타임에서 로드가 실패한다.
 * 토큰 검증은 lib/authVerify.ts(REST)를 사용할 것.
 *
 * - 프로덕션(Vercel): FIREBASE_SERVICE_ACCOUNT 환경변수에 서비스 계정 JSON 전체.
 * - 에뮬레이터: FIRESTORE_EMULATOR_HOST 가 있으면 자격증명 없이 projectId만으로 동작.
 */
import { getApps, initializeApp, cert, type App } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

let app: App | null = null

/** 환경변수에 담긴 서비스 계정 JSON을 관대하게 파싱 (따옴표 감싸짐·\n 이스케이프 허용) */
function parseServiceAccount(raw: string) {
  let text = raw.trim()
  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"'))
  ) {
    text = text.slice(1, -1)
  }
  const parsed = JSON.parse(text)
  if (typeof parsed.private_key === 'string') {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n')
  }
  return parsed
}

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
    const parsed = parseServiceAccount(svc)
    app = initializeApp({ credential: cert(parsed), projectId: parsed.project_id || projectId })
  } else {
    // 에뮬레이터 또는 GCP 기본 자격증명 환경
    app = initializeApp({ projectId })
  }
  return app
}

export const adminDb = () => getFirestore(initAdmin())

export const adminAvailable = () =>
  Boolean(process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIRESTORE_EMULATOR_HOST)
