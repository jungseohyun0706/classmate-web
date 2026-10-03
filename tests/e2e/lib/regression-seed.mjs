// 에뮬레이터 전용 시드 (demo-classmate). 실제 프로젝트와 무관.
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(ROOT, 'package.json'))
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080'
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099'
if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST) || !/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIREBASE_AUTH_EMULATOR_HOST)) {
  throw new Error('회귀 E2E는 로컬 에뮬레이터에서만 실행합니다')
}
const { initializeApp, getApps } = require('firebase-admin/app')
const { getAuth } = require('firebase-admin/auth')
const { getFirestore, Timestamp } = require('firebase-admin/firestore')

const PROJECT = 'demo-classmate'
export const CLASS = 'S1_3_2'
export const PW = 'test1234'
export const USERS = [
  { uid: 'teacher', email: 't@e2e.kr', doc: { role: 'teacher', displayName: '김담임', name: '김담임', classId: CLASS, schoolCode: 'S1', schoolName: '테스트고', grade: 3, classNm: 2 } },
  { uid: 's1', email: 's1@e2e.kr', doc: { role: 'student', status: 'approved', name: '이하늘', studentId: 1, classId: CLASS, schoolCode: 'S1', schoolName: '테스트고', grade: 3, classNm: 2 } },
  { uid: 's2', email: 's2@e2e.kr', doc: { role: 'student', status: 'approved', name: '박바다', studentId: 2, classId: CLASS, schoolCode: 'S1', schoolName: '테스트고', grade: 3, classNm: 2 } },
  { uid: 's3', email: 's3@e2e.kr', doc: { role: 'student', status: 'approved', name: '최구름', studentId: 3, classId: CLASS, schoolCode: 'S1', schoolName: '테스트고', grade: 3, classNm: 2 } },
  { uid: 's4', email: 's4@e2e.kr', doc: { role: 'student', status: 'approved', name: '무번호', classId: CLASS, schoolCode: 'S1', schoolName: '테스트고', grade: 3, classNm: 2 } },
  { uid: 'rejected', email: 'r@e2e.kr', doc: { role: 'student', status: 'rejected', name: '거절생', studentId: 5, classId: CLASS, schoolCode: 'S1', schoolName: '테스트고', grade: 3, classNm: 2 } },
  { uid: 'pending', email: 'p@e2e.kr', doc: { role: 'student', status: 'pending', name: '대기생', studentId: 4, classId: CLASS, schoolCode: 'S1', schoolName: '테스트고', grade: 3, classNm: 2 } },
  { uid: 't2', email: 't2@e2e.kr', doc: { role: 'teacher', displayName: '이교과', name: '이교과', classId: 'S1_3_4', grade: 3, classNm: 4, schoolCode: 'S1', schoolName: '테스트고', mySchedule: { mon: ['', '', '', '', '', '', ''], tue: ['', '', '', '', '', '', ''], wed: ['', '', '', '', '', '', ''], thu: ['', '', '', '', '', '', ''], fri: ['', '', '', '', '', '', ''] } } },
  { uid: 't3', email: 't3@e2e.kr', doc: { role: 'teacher', displayName: '박교과', name: '박교과', schoolCode: 'S1', schoolName: '테스트고', teachingClassIds: ['S1_3_2_g_e2e'] } },
  { uid: 't4', email: 't4@e2e.kr', doc: { role: 'teacher', displayName: '신규쌤', name: '신규쌤' } },
  { uid: 'g1', email: 'g1@e2e.kr', doc: { role: 'student', status: 'approved', name: '그룹생', studentId: 7, classId: 'S1_3_2_g_e2e', schoolCode: 'S1', schoolName: '테스트고', grade: null, classNm: null } },
  { uid: 'outsider', email: 'o@e2e.kr', doc: { role: 'student', status: 'approved', name: '남의반', studentId: 1, classId: 'S2_1_1', schoolCode: 'S2', schoolName: '다른고', grade: 1, classNm: 1 } },
]

export function admin() {
  const app = getApps()[0] || initializeApp({ projectId: PROJECT })
  return { auth: getAuth(app), db: getFirestore(app) }
}

// users 문서 없이 Auth 계정만 있는 신규 학생 (그룹 QR 첫 가입 검증용)
export const NEWBIES = [{ uid: 'newbie', email: 'n@e2e.kr' }]

export async function seed() {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' })
  await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' })
  const { auth, db } = admin()
  const now = Date.now()
  const ts = (msAgo) => Timestamp.fromMillis(now - msAgo)

  for (const u of USERS) {
    await auth.createUser({ uid: u.uid, email: u.email, password: PW, emailVerified: true, displayName: u.doc.name })
    await db.collection('users').doc(u.uid).set({ ...u.doc, email: u.email, createdAt: ts(86400000) })
  }
  await db.collection('classes').doc(CLASS).set({ classId: CLASS, schoolCode: 'S1', schoolName: '테스트고', grade: 3, classNm: 2, teacherId: 'teacher', teacherName: '김담임', createdAt: ts(86400000) })
  for (const n of NEWBIES) await auth.createUser({ uid: n.uid, email: n.email, password: PW, emailVerified: true })
  await db.collection('classes').doc('S1_3_4').set({ classId: 'S1_3_4', schoolCode: 'S1', schoolName: '테스트고', grade: 3, classNm: 4, teacherId: 't2', teacherName: '이교과', createdAt: ts(86400000) })
  await db.collection('classes').doc('S1_3_2_g_e2e').set({ classId: 'S1_3_2_g_e2e', isGroup: true, schoolCode: 'S1', schoolName: '테스트고', grade: 3, classNm: 2, teacherId: 't3', teacherName: '박교과', createdAt: ts(86400000) })
  await db.collection('classes').doc('S2_1_1_g_x').set({ classId: 'S2_1_1_g_x', isGroup: true, schoolCode: 'S2', schoolName: '다른고', grade: 1, classNm: 1, teacherId: 'other-teacher', createdAt: ts(86400000) })
  await db.collection('classes').doc('S2_1_1').set({ classId: 'S2_1_1', schoolCode: 'S2', schoolName: '다른고', grade: 1, classNm: 1, teacherId: 'other-teacher', teacherName: '남선생', createdAt: ts(86400000) })

  // 담임 없는 반(인수 규칙 검증용): 같은 학교 / 다른 학교 / schoolCode 없는 예전 다른 학교 반
  await db.collection('classes').doc('S1_1_1').set({ classId: 'S1_1_1', schoolCode: 'S1', grade: 1, classNm: 1, teacherId: null })
  await db.collection('classes').doc('S1_1_2').set({ classId: 'S1_1_2', schoolCode: 'S1', grade: 1, classNm: 2, teacherId: null })
  await db.collection('classes').doc('S2_2_2').set({ classId: 'S2_2_2', schoolCode: 'S2', grade: 2, classNm: 2, teacherId: null })
  await db.collection('classes').doc('S2_3_3').set({ classId: 'S2_3_3', grade: 3, classNm: 3, teacherId: null })

  const ann = db.collection('classes').doc(CLASS).collection('announcements')
  await ann.doc('A1').set({ title: '체육복 준비', body: '내일 체육 수업이 있어요. 체육복을 챙겨 오세요.', authorId: 'teacher', authorName: '김담임', attachmentUrl: null, attachmentName: null, createdAt: ts(2 * 3600000), readCount: 0, checkCount: 1, requiresConsent: false })
  await ann.doc('A2').set({ title: '현장체험학습 동의', body: '다음 주 현장체험학습 참가 동의를 받습니다.', authorId: 'teacher', authorName: '김담임', attachmentUrl: null, attachmentName: null, createdAt: ts(3600000), readCount: 0, checkCount: 0, requiresConsent: true })
  // 과거 데이터: 박바다는 예전 버전에서 '확인했어요'만 눌러 readAt 없는 receipt를 가짐
  await ann.doc('A1').collection('receipts').doc('s2').set({ studentName: '박바다', consent: 'agreed', consentAt: ts(90 * 60000) })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await seed()
  console.log('seed 완료')
  process.exit(0)
}
