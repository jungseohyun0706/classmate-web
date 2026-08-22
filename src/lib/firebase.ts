import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { getStorage, connectStorageEmulator } from 'firebase/storage';
import { getFunctions } from 'firebase/functions';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

const USE_EMULATOR = process.env.NEXT_PUBLIC_USE_EMULATOR === '1';
const EMU_HOST = process.env.NEXT_PUBLIC_EMULATOR_HOST || 'localhost';

// 에뮬레이터 연결은 페이지 전환마다 재실행되면 안 되므로 전역 플래그로 1회만
declare global {
  // eslint-disable-next-line no-var
  var __classmateEmulatorConnected: boolean | undefined;
}

export const initFirebase = () => {
  if (!getApps().length) {
    initializeApp(firebaseConfig);
  }
  const app = getApp();

  if (USE_EMULATOR && !globalThis.__classmateEmulatorConnected) {
    globalThis.__classmateEmulatorConnected = true;
    try {
      connectAuthEmulator(getAuth(app), `http://${EMU_HOST}:9099`, { disableWarnings: true });
      connectFirestoreEmulator(getFirestore(app), EMU_HOST, 8080);
      connectStorageEmulator(getStorage(app), EMU_HOST, 9199);
      // eslint-disable-next-line no-console
      console.info('[firebase] emulator mode');
    } catch (e) {
      console.warn('[firebase] emulator connect failed', e);
    }
  }
  return app;
};

// Initialize and export SDK instances (runtime init — build 시점 static export 문제 방지)
initFirebase();
export const auth = getAuth();
export const db = getFirestore();
export const storage = getStorage();
export const functions = getFunctions();
