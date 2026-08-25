import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  getFirestore,
  type Firestore,
} from 'firebase/firestore';
import { getStorage, type FirebaseStorage } from 'firebase/storage';
import { getFunctions, type Functions } from 'firebase/functions';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

export const initFirebase = (): FirebaseApp => {
  if (!getApps().length) {
    initializeApp(firebaseConfig);
  }
  return getApp();
};

const initFirestoreDb = (app: FirebaseApp): Firestore => {
  // 서버(SSR)에서는 영구 캐시를 사용할 수 없으므로 기본 인스턴스를 사용한다.
  if (typeof window === 'undefined') {
    return getFirestore(app);
  }
  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch {
    // Fast Refresh 등으로 이미 초기화된 경우 기존 인스턴스를 재사용한다.
    return getFirestore(app);
  }
};

// SDK 인스턴스는 브라우저에서만 초기화한다.
// 서버(빌드 시 페이지 데이터 수집 포함)에서는 env가 없으면 getAuth가 throw하므로
// 초기화를 건너뛴다 — 모든 사용처는 클라이언트 전용(useEffect/핸들러)이다.
const isBrowser = typeof window !== 'undefined';

// env 미설정(로컬 등)이어도 앱 셸은 렌더되도록 초기화 실패를 삼킨다 —
// 이 경우 Firebase 기능만 동작하지 않고 콘솔 경고가 남는다.
const safeInit = <T>(label: string, fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    console.warn(`[firebase] ${label} 초기화 실패 — NEXT_PUBLIC_FIREBASE_* env를 확인하세요.`, e);
    return undefined as unknown as T;
  }
};

const app: FirebaseApp | null = isBrowser ? safeInit('app', initFirebase) : null;

export const auth: Auth = (app ? safeInit('auth', () => getAuth(app)) : undefined) as unknown as Auth;
export const db: Firestore = (app ? safeInit('firestore', () => initFirestoreDb(app)) : undefined) as unknown as Firestore;
export const storage: FirebaseStorage = (app ? safeInit('storage', () => getStorage(app)) : undefined) as unknown as FirebaseStorage;
export const functions: Functions = (app ? safeInit('functions', () => getFunctions(app)) : undefined) as unknown as Functions;
