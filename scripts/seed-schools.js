import { readFileSync } from 'fs';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc } from 'firebase/firestore';

const env = process.env;
const firebaseConfig = {
  apiKey: env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

if (!firebaseConfig.apiKey) {
  console.error('.env not configured. Create .env.local first');
  process.exit(1);
}

initializeApp(firebaseConfig);
const db = getFirestore();

const data = JSON.parse(readFileSync('scripts/seed-schools.json','utf8'));

(async ()=>{
  for (const s of data) {
    console.log('Seeding', s.id);
    await setDoc(doc(db, 'schools', s.id), {
      name: s.name,
      code: s.code,
      createdAt: new Date().toISOString()
    });
  }
  console.log('Done');
})();
