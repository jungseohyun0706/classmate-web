/**
 * Firebase 에뮬레이터에 데모 데이터 심기.
 *
 * 사용법:
 *   FIRESTORE_EMULATOR_HOST=localhost:8080 \
 *   FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 \
 *   node scripts/seed-emulator.mjs
 *
 * 만드는 것:
 *   - 서울고등학교 (B10 / 7010084) + 1-1 ~ 1-3 반 시간표
 *   - 교사 3명 (kim/lee/park @demo.school, 비밀번호 demo1234)
 *   - 김철수 → 박민준 보결 요청 1건 (pending)
 *   - 이번 주 변경사항 1건 (학생 화면 노란 칸 데모)
 */
import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST가 없습니다. 에뮬레이터 전용 스크립트입니다.')
  process.exit(1)
}

const PROJECT = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'demo-classmate'
initializeApp({ projectId: PROJECT })
const auth = getAuth()
const db = getFirestore()

const SCHOOL = { code: '7010084', officeCode: 'B10', name: '서울고등학교', address: '서울특별시 서초구', kind: '고등학교' }

const mondayOf = (d = new Date()) => {
  const date = new Date(d)
  const dow = (date.getDay() + 6) % 7
  date.setDate(date.getDate() - dow)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const item = (day, period, subject, teacher) => ({ id: `${day}-${period}`, day, period, subject, ...(teacher ? { teacher } : {}) })

const TT_1_1 = [
  item('월', 1, '국어', '김철수'), item('월', 2, '수학', '이영희'), item('월', 3, '영어', '박민준'), item('월', 4, '과학', '정다은'), item('월', 5, '체육', '최강'),
  item('화', 1, '수학', '이영희'), item('화', 2, '국어', '김철수'), item('화', 3, '사회', '한지민'), item('화', 4, '음악', '송가인'), item('화', 5, '영어', '박민준'),
  item('수', 1, '영어', '박민준'), item('수', 2, '과학', '정다은'), item('수', 3, '국어', '김철수'), item('수', 4, '수학', '이영희'),
  item('목', 1, '사회', '한지민'), item('목', 2, '체육', '최강'), item('목', 3, '수학', '이영희'), item('목', 4, '국어', '김철수'), item('목', 5, '미술', '유화백'),
  item('금', 1, '과학', '정다은'), item('금', 2, '영어', '박민준'), item('금', 3, '음악', '송가인'), item('금', 4, '국어', '김철수'),
]
const TT_1_2 = [
  item('월', 1, '수학', '이영희'), item('월', 2, '국어', '김철수'), item('월', 3, '과학', '정다은'), item('월', 4, '영어', '박민준'), item('월', 5, '미술', '유화백'),
  item('화', 1, '국어', '김철수'), item('화', 2, '영어', '박민준'), item('화', 3, '수학', '이영희'), item('화', 4, '체육', '최강'),
  item('수', 1, '사회', '한지민'), item('수', 2, '수학', '이영희'), item('수', 3, '영어', '박민준'), item('수', 4, '국어', '김철수'), item('수', 5, '음악', '송가인'),
  item('목', 1, '영어', '박민준'), item('목', 2, '과학', '정다은'), item('목', 3, '국어', '김철수'), item('목', 4, '수학', '이영희'),
  item('금', 1, '체육', '최강'), item('금', 2, '사회', '한지민'), item('금', 3, '수학', '이영희'), item('금', 4, '과학', '정다은'),
]
const TT_1_3 = [
  item('월', 1, '영어', '박민준'), item('월', 2, '사회', '한지민'), item('월', 3, '수학', '이영희'), item('월', 4, '국어', '김철수'),
  item('화', 1, '과학', '정다은'), item('화', 2, '수학', '이영희'), item('화', 3, '체육', '최강'), item('화', 4, '영어', '박민준'), item('화', 5, '국어', '김철수'),
  item('수', 1, '음악', '송가인'), item('수', 2, '국어', '김철수'), item('수', 3, '과학', '정다은'), item('수', 4, '영어', '박민준'),
  item('목', 1, '수학', '이영희'), item('목', 2, '미술', '유화백'), item('목', 3, '사회', '한지민'), item('목', 4, '체육', '최강'),
  item('금', 1, '국어', '김철수'), item('금', 2, '수학', '이영희'), item('금', 3, '영어', '박민준'), item('금', 4, '음악', '송가인'),
]

const gridFromItems = (items) => {
  const map = { 월: 'mon', 화: 'tue', 수: 'wed', 목: 'thu', 금: 'fri' }
  const g = { mon: ['', '', '', '', '', '', ''], tue: ['', '', '', '', '', '', ''], wed: ['', '', '', '', '', '', ''], thu: ['', '', '', '', '', '', ''], fri: ['', '', '', '', '', '', ''] }
  for (const it of items) g[map[it.day]][it.period - 1] = it.subject
  return g
}

/** 교사 개인 시간표: 전교 시간표에서 이름 매칭으로 도출 */
const teacherSchedule = (name) => {
  const map = { 월: 'mon', 화: 'tue', 수: 'wed', 목: 'thu', 금: 'fri' }
  const g = { mon: ['', '', '', '', '', '', ''], tue: ['', '', '', '', '', '', ''], wed: ['', '', '', '', '', '', ''], thu: ['', '', '', '', '', '', ''], fri: ['', '', '', '', '', '', ''] }
  const all = [['1-1', TT_1_1], ['1-2', TT_1_2], ['1-3', TT_1_3]]
  for (const [label, items] of all) {
    for (const it of items) {
      if (it.teacher === name) g[map[it.day]][it.period - 1] = `${it.subject}(${label})`
    }
  }
  return g
}

async function upsertUser(email, password, displayName) {
  try {
    const u = await auth.getUserByEmail(email)
    return u.uid
  } catch {
    const u = await auth.createUser({ email, password, displayName, emailVerified: true })
    await auth.setCustomUserClaims(u.uid, { role: 'teacher' })
    return u.uid
  }
}

const classId = (g, c) => `${SCHOOL.code}_${g}_${c}`

async function main() {
  console.log('· 학교 문서')
  await db.doc(`schools/${SCHOOL.code}`).set(SCHOOL, { merge: true })

  console.log('· 교사 계정 3명')
  const kim = await upsertUser('kim@demo.school', 'demo1234', '김철수')
  const lee = await upsertUser('lee@demo.school', 'demo1234', '이영희')
  const park = await upsertUser('park@demo.school', 'demo1234', '박민준')

  const baseUser = { role: 'teacher', schoolCode: SCHOOL.code, officeCode: SCHOOL.officeCode, schoolName: SCHOOL.name }
  await db.doc(`users/${kim}`).set({ ...baseUser, email: 'kim@demo.school', displayName: '김철수', classId: classId(1, 1), grade: 1, classNm: 1, mySchedule: teacherSchedule('김철수') }, { merge: true })
  await db.doc(`users/${lee}`).set({ ...baseUser, email: 'lee@demo.school', displayName: '이영희', classId: classId(1, 2), grade: 1, classNm: 2, mySchedule: teacherSchedule('이영희') }, { merge: true })
  await db.doc(`users/${park}`).set({ ...baseUser, email: 'park@demo.school', displayName: '박민준', classId: null, mySchedule: teacherSchedule('박민준') }, { merge: true })

  console.log('· 반 3개 + 시간표 (canonical + legacy)')
  const classes = [
    [1, 1, TT_1_1, kim, '김철수'],
    [1, 2, TT_1_2, lee, '이영희'],
    [1, 3, TT_1_3, null, null],
  ]
  for (const [g, c, tt, tid, tname] of classes) {
    const id = classId(g, c)
    await db.doc(`classes/${id}`).set({
      classId: id, schoolCode: SCHOOL.code, officeCode: SCHOOL.officeCode, schoolName: SCHOOL.name,
      grade: g, classNm: c, teacherId: tid, teacherName: tname,
      timetable: tt, timetableUpdatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    await db.doc(`classes/${id}/info/timetable`).set(gridFromItems(tt))
  }

  console.log('· 보결 요청 1건 (김철수 → 박민준, pending)')
  await db.collection('swap_requests').add({
    schoolCode: SCHOOL.code, type: 'substitute',
    fromUid: kim, fromName: '김철수', fromClassId: classId(1, 1),
    toUid: park, toName: '박민준', toClassId: null,
    a: { day: '금', period: 4, subject: '국어(1-1)' },
    note: '금요일 출장이 잡혔습니다. 부탁드려요!',
    status: 'pending', weekOf: mondayOf(),
    createdAt: FieldValue.serverTimestamp(),
  })

  console.log('· 이번 주 변경사항 1건 (1-1 수요일 3교시)')
  await db.collection(`schools/${SCHOOL.code}/changes`).add({
    schoolCode: SCHOOL.code, weekOf: mondayOf(), type: 'substitute',
    day: '수', period: 3, classIds: [classId(1, 1)],
    aName: '김철수', bName: '정다은', aSubject: '국어',
    note: '국어 — 김철수 → 정다은 선생님 (보결)',
    createdAt: FieldValue.serverTimestamp(),
  })

  console.log('완료! 로그인: kim@demo.school / lee@demo.school / park@demo.school (비밀번호 demo1234)')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
