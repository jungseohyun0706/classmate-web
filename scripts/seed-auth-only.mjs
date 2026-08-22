/**
 * Auth 에뮬레이터 전용 시드 (Firestore 에뮬레이터가 없는 환경용 최소 시드).
 * FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 node scripts/seed-auth-only.mjs
 */
import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'

if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error('FIREBASE_AUTH_EMULATOR_HOST가 없습니다.')
  process.exit(1)
}

initializeApp({ projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'demo-classmate' })
const auth = getAuth()

const users = [
  { email: 'kim@demo.school', password: 'demo1234', displayName: '김철수' },
  { email: 'park@demo.school', password: 'demo1234', displayName: '박민준' },
]

for (const u of users) {
  try {
    await auth.getUserByEmail(u.email)
    console.log('exists:', u.email)
  } catch {
    const created = await auth.createUser({ ...u, emailVerified: true })
    await auth.setCustomUserClaims(created.uid, { role: 'teacher' })
    console.log('created:', u.email, created.uid)
  }
}
console.log('done')
