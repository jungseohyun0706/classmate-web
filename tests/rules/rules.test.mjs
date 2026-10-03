// Firestore 보안 규칙 테스트 (개인 시간표 개편 — 아키텍처 문서 8절, 지시서 16장·T14·T15·T39·R16)
// 실행 전제: 저장소 firestore.rules를 읽은 로컬 Firebase 에뮬레이터(Firestore + Auth)
// 사용: FIRESTORE_EMULATOR_HOST=127.0.0.1:8484 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9499 node --test tests/rules/
//       (포트는 환경변수로만 정합니다. 프로젝트 id는 FIREBASE_PROJECT_ID, 기본 demo-classmate)
// - 시드는 firebase-admin(규칙 우회), 확인은 firebase 클라이언트 SDK(규칙을 거치는 실제 앱 경로)로 합니다.
// - 실행마다 고유한 학교 코드·uid를 써서 기존 데이터를 지우지 않습니다(wipe 없음).
// - 모든 데이터는 테스트용 가상 데이터이며 실제 학생 정보가 아닙니다.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(ROOT, 'package.json'))

const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST || ''
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || ''
const isLocal = (h) => /^(127\.0\.0\.1|localhost):\d+$/.test(h)
if (!isLocal(FS_HOST) || !isLocal(AUTH_HOST)) {
  throw new Error('규칙 테스트는 로컬 에뮬레이터에서만 실행합니다. FIRESTORE_EMULATOR_HOST·FIREBASE_AUTH_EMULATOR_HOST(127.0.0.1:포트)를 지정하세요.')
}
const PROJECT = process.env.FIREBASE_PROJECT_ID || 'demo-classmate'
const PW = 'rules-test-1234'

const { initializeApp: initAdmin, deleteApp: deleteAdminApp } = require('firebase-admin/app')
const { getAuth: getAdminAuth } = require('firebase-admin/auth')
const { getFirestore: getAdminDb, Timestamp } = require('firebase-admin/firestore')
const { initializeApp: initClient, deleteApp } = require('firebase/app')
const { getAuth, connectAuthEmulator, signInWithEmailAndPassword } = require('firebase/auth')
const fsc = require('firebase/firestore')
fsc.setLogLevel('silent') // 거부된 쓰기마다 찍히는 경고 숨김(결과는 아래 단언으로 확인)

// ───────── 실행마다 고유한 식별자 ─────────
const RUN = (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase()
const SA = `RA${RUN}` // 학교 A
const SB = `RB${RUN}` // 학교 B(다른 학교)
const HR_A = `${SA}_1_1`
const HR_B = `${SB}_1_1`
const U = {
  stuA: `stuA_${RUN}`, // 학교 A 학생(수강: c1 active, c2 ended, c3 pending)
  stuA2: `stuA2_${RUN}`, // 학교 A 다른 학생(수강: c1, c4 active)
  stuP: `stuP_${RUN}`, // 학교 A 승인 대기 학생
  teaA: `teaA_${RUN}`, // 학교 A 담임·c1 담당 교사
  teaA2: `teaA2_${RUN}`, // 학교 A 다른 교사(담당 수업 없음)
  teaB: `teaB_${RUN}`, // 학교 B 교사
  stuB: `stuB_${RUN}`, // 학교 B 학생
  nodoc: `nodoc_${RUN}`, // Auth 계정만 있고 users 문서 없음(가입 직후)
}
const emailOf = (k) => `${k.toLowerCase()}.${RUN.toLowerCase()}@rules.test`
const INVITE = `IV${RUN}`.slice(0, 20)

let adminApp
let adb
const S = {} // 클라이언트 세션
const apps = []

async function seed() {
  adminApp = initAdmin({ projectId: PROJECT }, `rules-admin-${RUN}`)
  const auth = getAdminAuth(adminApp)
  adb = getAdminDb(adminApp)
  const now = Timestamp.now()
  const school = (code) => ({ schoolCode: code, schoolName: `${code} 고등학교`, officeCode: 'B10' })
  const docs = {
    stuA: { role: 'student', status: 'approved', classId: HR_A, grade: 1, classNm: 1, name: '가학생', displayName: '가학생', ...school(SA) },
    stuA2: { role: 'student', status: 'approved', classId: HR_A, grade: 1, classNm: 1, studentId: '3', name: '나학생', displayName: '나학생', ...school(SA) },
    stuP: { role: 'student', status: 'pending', classId: HR_A, grade: 1, classNm: 1, name: '다학생', displayName: '다학생', ...school(SA) },
    teaA: { role: 'teacher', classId: HR_A, name: '김담임', displayName: '김담임', ...school(SA) },
    teaA2: { role: 'teacher', name: '이교사', displayName: '이교사', ...school(SA) },
    teaB: { role: 'teacher', classId: HR_B, name: '박교사', displayName: '박교사', ...school(SB) },
    stuB: { role: 'student', status: 'approved', classId: HR_B, grade: 1, classNm: 1, name: '라학생', displayName: '라학생', ...school(SB) },
  }
  for (const [k, uid] of Object.entries(U)) {
    await auth.createUser({ uid, email: emailOf(k), password: PW, emailVerified: true })
    if (docs[k]) await adb.doc(`users/${uid}`).set({ ...docs[k], email: emailOf(k), createdAt: now })
  }

  const b = adb.batch()
  const set = (p, d) => b.set(adb.doc(p), d)
  set(`classes/${HR_A}`, { classId: HR_A, grade: 1, classNm: 1, teacherId: U.teaA, ...school(SA) })
  set(`classes/${HR_B}`, { classId: HR_B, grade: 1, classNm: 1, teacherId: U.teaB, ...school(SB) })
  set(`schools/${SA}`, { name: `${SA} 고등학교`, timezone: 'Asia/Seoul', scheduleRevision: 3, updatedAt: now })
  set(`schools/${SB}`, { name: `${SB} 고등학교`, timezone: 'Asia/Seoul', scheduleRevision: 1, updatedAt: now })
  const course = (title, teacherUids) => ({
    schoolCode: SA, termId: '2026-2', title, subject: title, teacherUids, teacherNames: [], status: 'active',
    commonForHomerooms: [], invitePolicy: 'auto', catalogVisible: false, source: 'manual', createdAt: now, updatedAt: now, revision: 1,
  })
  set(`schools/${SA}/courses/c1`, course('영어 B', [U.teaA]))
  set(`schools/${SA}/courses/c2`, course('생활과 과학 A', [U.teaA]))
  set(`schools/${SA}/courses/c3`, course('정보 A', [U.teaA]))
  set(`schools/${SA}/courses/c4`, course('물리 A', [U.teaA2]))
  set(`schools/${SB}/courses/cb1`, { ...course('영어 B', [U.teaB]), schoolCode: SB })
  set(`schools/${SA}/series/s1`, { courseId: 'c1', termId: '2026-2', weekday: 2, period: 3, roomName: '영어실', validFrom: '20260816', validTo: null, status: 'active', createdAt: now })
  set(`schools/${SA}/overrides/o1`, {
    courseId: 'c1', occurrenceKey: 's1@20261006', changeSetId: 'cs_m1', kind: 'cancel', seriesId: 's1', originalDate: '20261006',
    changeSetKeys: ['c1|s1@20261006'], dates: ['20261006'], revision: 2, status: 'published', publishedAt: now, createdBy: U.teaA,
  })
  set(`schools/${SA}/terms/2026-2`, { name: '2026학년도 2학기', startDate: '20260816', endDate: '20270301' })
  set(`schools/${SA}/rooms/r1`, { name: '영어실' })
  set(`schools/${SA}/changeSets/cs_m1`, { mutationId: 'm1', scope: 'date', status: 'published', affectedCourseIds: ['c1'], createdAt: now, revision: 2 })
  set(`schools/${SA}/audit/a1`, { action: 'override.publish', actorUid: U.teaA, target: 'changeSets/cs_m1', revision: 2, at: now })
  set(`schools/${SA}/importBatches/b1`, { status: 'staged', termId: '2026-2', createdAt: now })
  set(`schools/${SA}/importBatches/b1/rows/00000`, { rows: [] })
  set(`schools/${SA}/rosterEntries/re1`, { batchId: 'rb1', courseId: 'c1', linked: false })
  set(`schools/${SA}/rosterBatches/rb1`, { fileHash: 'x', createdAt: now })
  const enr = (courseId, uid, status, schoolCode = SA) => ({
    courseId, uid, schoolCode, termId: '2026-2', status, from: '20260901', to: status === 'ended' ? '20261001' : null, source: 'admin', createdAt: now, updatedAt: now,
  })
  set(`schools/${SA}/enrollments/c1__${U.stuA}`, enr('c1', U.stuA, 'active'))
  set(`schools/${SA}/enrollments/c2__${U.stuA}`, enr('c2', U.stuA, 'ended'))
  set(`schools/${SA}/enrollments/c3__${U.stuA}`, enr('c3', U.stuA, 'pending'))
  set(`schools/${SA}/enrollments/c1__${U.stuA2}`, enr('c1', U.stuA2, 'active'))
  set(`schools/${SA}/enrollments/c4__${U.stuA2}`, enr('c4', U.stuA2, 'active'))
  set(`schools/${SB}/enrollments/cb1__${U.stuB}`, enr('cb1', U.stuB, 'active', SB))
  // 학교 B에 학생 A uid로 된 수강(전학 등) — 학생 A 학교(A) 기준 연결 검사에서 쓰이면 안 됨
  set(`schools/${SB}/enrollments/cb1__${U.stuA}`, enr('cb1', U.stuA, 'active', SB))
  set(`invitations/${INVITE}`, {
    schoolCode: SA, termId: '2026-2', type: 'course', targetId: 'c1', targetLabel: '영어 B', issuedBy: U.teaA, issuedByName: '김담임',
    createdAt: now, expiresAt: null, revoked: false, uses: 1, maxUses: null,
  })
  set(`invitations/${INVITE}/uses/${U.stuA}`, { at: now, status: 'active' })
  const pe = (extra) => ({ title: '학원', kind: 'weekly', weekday: 2, period: null, start: null, end: null, roomName: null, memo: null, linkedCourseId: null, createdAt: now, updatedAt: now, ...extra })
  set(`users/${U.stuA}/personalEntries/pe-plain`, pe({}))
  set(`users/${U.stuA}/personalEntries/pe-ended-link`, pe({ title: '과학 메모', weekday: 3, linkedCourseId: 'c2', memo: '실험복' }))
  set(`users/${U.stuA}/personalEntries/pe-del`, pe({ title: '지울 일정' }))
  await b.commit()
}

async function clientApp(name) {
  const app = initClient({ projectId: PROJECT, apiKey: 'rules-test-fake-key' }, `rules-${name}-${RUN}`)
  apps.push(app)
  const db = fsc.getFirestore(app)
  const [host, port] = FS_HOST.split(':')
  fsc.connectFirestoreEmulator(db, host, Number(port))
  return { app, db }
}

async function signIn(k) {
  const { app, db } = await clientApp(k)
  const a = getAuth(app)
  connectAuthEmulator(a, `http://${AUTH_HOST}`, { disableWarnings: true })
  const cred = await signInWithEmailAndPassword(a, emailOf(k), PW)
  return { app, db, uid: cred.user.uid }
}

// ───────── 단언 도우미 ─────────
const dref = (s, p) => fsc.doc(s.db, p)
const read = (s, p) => fsc.getDocFromServer(dref(s, p))
const list = (s, p, ...c) => fsc.getDocsFromServer(fsc.query(fsc.collection(s.db, p), ...c))
const now = () => fsc.serverTimestamp()

async function denied(p, what) {
  try {
    await p
  } catch (e) {
    if (e && e.code === 'permission-denied') return
    throw e
  }
  assert.fail(`${what}: 거부되어야 하는데 허용됨`)
}

async function allowed(p, what) {
  try {
    return await p
  } catch (e) {
    assert.fail(`${what}: 허용되어야 하는데 실패 — ${e && e.code ? e.code : e}`)
  }
}

before(async () => {
  await seed()
  for (const k of Object.keys(U)) S[k] = await signIn(k)
  S.anon = await clientApp('anon') // 로그인하지 않은 사용자
})

after(async () => {
  for (const app of apps) {
    await fsc.terminate(fsc.getFirestore(app)).catch(() => {})
    await deleteApp(app).catch(() => {})
  }
  if (adminApp) await deleteAdminApp(adminApp).catch(() => {})
})

// ─────────────────────────────────────────────────────────────
describe('schools/{s} 학교 문서 (R16)', () => {
  it('같은 학교 학생·교사는 학교 문서(scheduleRevision)를 읽을 수 있다', async () => {
    const snap = await allowed(read(S.stuA, `schools/${SA}`), '학생 A → 학교 A')
    assert.equal(snap.get('scheduleRevision'), 3)
    await allowed(read(S.stuP, `schools/${SA}`), '승인 대기 학생 → 학교 A')
    await allowed(read(S.teaA, `schools/${SA}`), '교사 A → 학교 A')
  })

  it('다른 학교 사용자·로그인 안 한 사용자·users 문서 없는 계정은 읽을 수 없다', async () => {
    await denied(read(S.teaB, `schools/${SA}`), '학교 B 교사 → 학교 A')
    await denied(read(S.stuB, `schools/${SA}`), '학교 B 학생 → 학교 A')
    await denied(read(S.anon, `schools/${SA}`), '비로그인 → 학교 A')
    await denied(read(S.nodoc, `schools/${SA}`), 'users 문서 없음 → 학교 A')
    await denied(list(S.stuA, 'schools'), '학생 A → 학교 목록')
  })

  it('학생·교사 모두 학교 문서를 쓸 수 없다(scheduleRevision 조작 차단)', async () => {
    await denied(fsc.updateDoc(dref(S.stuA, `schools/${SA}`), { scheduleRevision: 99 }), '학생 A → scheduleRevision')
    await denied(fsc.updateDoc(dref(S.teaA, `schools/${SA}`), { scheduleRevision: 99 }), '교사 A → scheduleRevision')
    await denied(fsc.setDoc(dref(S.teaA, `schools/NEW${RUN}`), { name: 'x' }), '교사 A → 새 학교 문서')
  })
})

// ─────────────────────────────────────────────────────────────
describe('schools/{s}/enrollments 수강 (T39·R16)', () => {
  it("T39 학생은 where('uid','==',내 uid) 쿼리로 본인 수강만 읽는다", async () => {
    const q = await allowed(list(S.stuA, `schools/${SA}/enrollments`, fsc.where('uid', '==', U.stuA)), '학생 A 본인 수강 쿼리')
    assert.deepEqual(q.docs.map((d) => d.get('courseId')).sort(), ['c1', 'c2', 'c3'])
    const q2 = await allowed(
      list(S.stuA, `schools/${SA}/enrollments`, fsc.where('uid', '==', U.stuA), fsc.where('status', '==', 'active')),
      '학생 A 본인 active 수강 쿼리(uid+status)'
    )
    assert.deepEqual(q2.docs.map((d) => d.get('courseId')), ['c1'])
    const one = await allowed(read(S.stuA, `schools/${SA}/enrollments/c1__${U.stuA}`), '학생 A 본인 수강 문서')
    assert.equal(one.get('status'), 'active')
  })

  it('T39 학생은 다른 학생 수강·필터 없는 목록·수업별 명단을 읽을 수 없다', async () => {
    await denied(read(S.stuA, `schools/${SA}/enrollments/c1__${U.stuA2}`), '학생 A → 학생 A2 수강')
    await denied(list(S.stuA, `schools/${SA}/enrollments`), '학생 A → 수강 전체 목록')
    await denied(list(S.stuA, `schools/${SA}/enrollments`, fsc.where('courseId', '==', 'c1')), '학생 A → c1 수강생 명단')
    await denied(list(S.stuA, `schools/${SA}/enrollments`, fsc.where('uid', '==', U.stuA2)), '학생 A → 학생 A2 uid 쿼리')
    await denied(read(S.stuA, `schools/${SA}/enrollments/nope__${U.stuA}`), '학생 A → 없는 수강 문서')
  })

  it('같은 학교 교사는 수업별 수강 명단을 읽고, 다른 학교 교사는 읽을 수 없다(R16)', async () => {
    const q = await allowed(
      list(S.teaA, `schools/${SA}/enrollments`, fsc.where('courseId', '==', 'c1'), fsc.where('status', '==', 'active')),
      '교사 A → c1 active 수강생'
    )
    assert.equal(q.size, 2)
    await allowed(read(S.teaA2, `schools/${SA}/enrollments/c1__${U.stuA}`), '같은 학교 다른 교사 → 수강 문서')
    await denied(read(S.teaB, `schools/${SA}/enrollments/c1__${U.stuA}`), '학교 B 교사 → 학교 A 수강')
    await denied(list(S.teaB, `schools/${SA}/enrollments`, fsc.where('courseId', '==', 'c1')), '학교 B 교사 → 학교 A 명단')
    // 본인 문서 규칙은 학교와 무관하게 '내 uid 문서만' — 다른 학교 학생이 쿼리해도 남의 수강은 나오지 않음
    const other = await allowed(list(S.stuB, `schools/${SA}/enrollments`, fsc.where('uid', '==', U.stuB)), '학교 B 학생 → 학교 A 본인 uid 쿼리')
    assert.equal(other.size, 0)
    await denied(list(S.stuB, `schools/${SA}/enrollments`, fsc.where('courseId', '==', 'c1')), '학교 B 학생 → 학교 A 수업 명단')
  })

  it('T39 학생·교사 모두 수강을 직접 만들거나 바꿀 수 없다(초대·승인은 서버 API만)', async () => {
    const mine = { courseId: 'c4', uid: U.stuA, schoolCode: SA, termId: '2026-2', status: 'active', source: 'request' }
    await denied(fsc.setDoc(dref(S.stuA, `schools/${SA}/enrollments/c4__${U.stuA}`), mine), '학생 A → 본인 수강 생성')
    await denied(fsc.updateDoc(dref(S.stuA, `schools/${SA}/enrollments/c3__${U.stuA}`), { status: 'active' }), '학생 A → 승인 대기 수강을 active로')
    await denied(fsc.updateDoc(dref(S.stuA, `schools/${SA}/enrollments/c2__${U.stuA}`), { to: null, status: 'active' }), '학생 A → 끝난 수강 되살리기')
    await denied(fsc.deleteDoc(dref(S.stuA, `schools/${SA}/enrollments/c1__${U.stuA}`)), '학생 A → 본인 수강 삭제')
    await denied(fsc.setDoc(dref(S.teaA, `schools/${SA}/enrollments/c1__${U.stuP}`), { ...mine, courseId: 'c1', uid: U.stuP }), '교사 A → 수강 생성')
    await denied(fsc.updateDoc(dref(S.teaA, `schools/${SA}/enrollments/c3__${U.stuA}`), { status: 'active' }), '교사 A → 수강 승인(직접 쓰기)')
  })
})

// ─────────────────────────────────────────────────────────────
describe('공식 시간표 자료 courses·series·overrides·terms·rooms·changeSets·audit·importBatches·rosterEntries (T39·R16)', () => {
  const teacherReadable = [
    'courses/c1',
    'series/s1',
    'overrides/o1',
    'terms/2026-2',
    'rooms/r1',
    'changeSets/cs_m1',
    'audit/a1',
    'importBatches/b1',
    'importBatches/b1/rows/00000',
    'rosterEntries/re1',
  ]

  it('T39 학생은 수강 중인 수업이라도 공식 자료를 직접 읽을 수 없다(/api/timetable/me로만)', async () => {
    for (const p of teacherReadable) await denied(read(S.stuA, `schools/${SA}/${p}`), `학생 A → ${p}`)
    await denied(list(S.stuA, `schools/${SA}/courses`), '학생 A → 수업 목록')
    await denied(list(S.stuA, `schools/${SA}/series`, fsc.where('courseId', '==', 'c1')), '학생 A → c1 차시 목록')
    await denied(list(S.stuA, `schools/${SA}/overrides`, fsc.where('courseId', '==', 'c1')), '학생 A → c1 변경 목록')
  })

  it('T39 학생은 공식 일정(수업·차시·변경)을 쓸 수 없다', async () => {
    await denied(fsc.updateDoc(dref(S.stuA, `schools/${SA}/courses/c1`), { title: '바뀐 제목' }), '학생 A → 수업 수정')
    await denied(fsc.setDoc(dref(S.stuA, `schools/${SA}/series/sX`), { courseId: 'c1', weekday: 1, period: 1 }), '학생 A → 차시 생성')
    await denied(
      fsc.setDoc(dref(S.stuA, `schools/${SA}/overrides/oX`), { courseId: 'c1', occurrenceKey: 's1@20261013', kind: 'cancel', status: 'published', revision: 99 }),
      '학생 A → 휴강 변경 생성'
    )
    await denied(fsc.deleteDoc(dref(S.stuA, `schools/${SA}/overrides/o1`)), '학생 A → 변경 삭제')
  })

  it('같은 학교 교사는 읽을 수 있다(담당 수업 아니어도)', async () => {
    for (const p of teacherReadable) {
      const snap = await allowed(read(S.teaA2, `schools/${SA}/${p}`), `교사 A2 → ${p}`)
      assert.ok(snap.exists(), `${p} 문서가 있어야 함`)
    }
    const mine = await allowed(list(S.teaA, `schools/${SA}/courses`, fsc.where('teacherUids', 'array-contains', U.teaA)), '교사 A → 내 수업 목록')
    assert.equal(mine.size, 3)
    // 에뮬레이터는 복합 인덱스를 강제하지 않음 — 규칙 통과만 확인(인덱스는 firestore.indexes.json)
    await allowed(
      list(S.teaA, `schools/${SA}/changeSets`, fsc.where('affectedCourseIds', 'array-contains', 'c1'), fsc.orderBy('createdAt', 'desc')),
      '교사 A → c1 변경 이력'
    )
  })

  it('교사도 공식 자료를 직접 쓸 수 없다(서버 트랜잭션만 — 권한·충돌·버전·감사 기록)', async () => {
    await denied(fsc.updateDoc(dref(S.teaA, `schools/${SA}/courses/c1`), { title: '바뀐 제목' }), '담당 교사 A → 수업 수정')
    await denied(fsc.setDoc(dref(S.teaA, `schools/${SA}/courses/cNew`), { title: '새 수업', teacherUids: [U.teaA] }), '교사 A → 수업 생성')
    await denied(fsc.setDoc(dref(S.teaA, `schools/${SA}/series/sX`), { courseId: 'c1', weekday: 1, period: 1 }), '교사 A → 차시 생성')
    await denied(fsc.setDoc(dref(S.teaA, `schools/${SA}/overrides/oX`), { courseId: 'c1', kind: 'cancel', status: 'published' }), '교사 A → 변경 생성')
    await denied(fsc.setDoc(dref(S.teaA, `schools/${SA}/changeSets/cs_x`), { status: 'published' }), '교사 A → 변경 묶음 생성')
    await denied(fsc.setDoc(dref(S.teaA, `schools/${SA}/audit/aX`), { action: 'fake' }), '교사 A → 감사 기록 위조')
    await denied(fsc.deleteDoc(dref(S.teaA, `schools/${SA}/audit/a1`)), '교사 A → 감사 기록 삭제')
    await denied(fsc.setDoc(dref(S.teaA, `schools/${SA}/terms/2027-1`), { name: 'x' }), '교사 A → 학기 생성')
    await denied(fsc.setDoc(dref(S.teaA, `schools/${SA}/rooms/rX`), { name: 'x' }), '교사 A → 교실 생성')
    await denied(fsc.updateDoc(dref(S.teaA, `schools/${SA}/importBatches/b1`), { status: 'committed' }), '교사 A → 가져오기 배치 확정')
    await denied(fsc.setDoc(dref(S.teaA, `schools/${SA}/importBatches/b1/rows/00001`), { rows: [] }), '교사 A → 가져오기 행')
    await denied(fsc.updateDoc(dref(S.teaA, `schools/${SA}/rosterEntries/re1`), { linked: true }), '교사 A → 명단 연결')
  })

  it('R16 다른 학교 교사는 공식 자료를 읽을 수 없다', async () => {
    for (const p of ['courses/c1', 'series/s1', 'overrides/o1', 'audit/a1', 'changeSets/cs_m1', 'rosterEntries/re1']) {
      await denied(read(S.teaB, `schools/${SA}/${p}`), `학교 B 교사 → 학교 A ${p}`)
    }
    await denied(list(S.teaB, `schools/${SA}/courses`), '학교 B 교사 → 학교 A 수업 목록')
    await allowed(read(S.teaB, `schools/${SB}/courses/cb1`), '학교 B 교사 → 자기 학교 수업')
  })

  it('목록에 없는 하위 경로(rosterBatches)는 같은 학교 교사도 읽을 수 없다(서버만)', async () => {
    await denied(read(S.teaA, `schools/${SA}/rosterBatches/rb1`), '교사 A → rosterBatches')
    await denied(read(S.stuA, `schools/${SA}/unknown/x`), '학생 A → 알 수 없는 하위 경로')
  })
})

// ─────────────────────────────────────────────────────────────
describe('invitations/{code} 초대 (서버 전용)', () => {
  it('학생·발급 교사·비로그인 모두 초대 문서와 사용 기록을 읽거나 쓸 수 없다', async () => {
    await denied(read(S.stuA, `invitations/${INVITE}`), '학생 A → 초대')
    await denied(read(S.teaA, `invitations/${INVITE}`), '발급 교사 A → 초대')
    await denied(read(S.anon, `invitations/${INVITE}`), '비로그인 → 초대')
    await denied(list(S.teaA, 'invitations', fsc.where('targetId', '==', 'c1')), '교사 A → 초대 목록')
    await denied(read(S.stuA, `invitations/${INVITE}/uses/${U.stuA}`), '학생 A → 본인 사용 기록')
    await denied(list(S.teaA, `invitations/${INVITE}/uses`), '교사 A → 사용 기록 목록')
    await denied(fsc.setDoc(dref(S.teaA, `invitations/NEW${RUN}`), { type: 'course', targetId: 'c1', revoked: false }), '교사 A → 초대 직접 생성')
    await denied(fsc.updateDoc(dref(S.teaA, `invitations/${INVITE}`), { revoked: true }), '교사 A → 초대 직접 회수')
    await denied(fsc.setDoc(dref(S.stuA, `invitations/${INVITE}/uses/${U.stuA}`), { at: 1 }), '학생 A → 사용 기록 쓰기')
  })
})

// ─────────────────────────────────────────────────────────────
describe('users/{uid}/personalEntries 개인 일정 (T14·T15)', () => {
  const P = (id) => `users/${U.stuA}/personalEntries/${id}`
  const weekly = (extra = {}) => ({
    title: '수학 학원', kind: 'weekly', weekday: 2, period: null, start: '18:00', end: '19:30',
    roomName: null, memo: null, linkedCourseId: null, createdAt: now(), updatedAt: now(), ...extra,
  })
  const without = (o, k) => {
    const c = { ...o }
    delete c[k]
    return c
  }
  let n = 0
  const nid = () => `t${++n}`

  it('T14 본인은 공식 미연결 일정을 만들고 읽고 고치고 지울 수 있다', async () => {
    const id = nid()
    await allowed(fsc.setDoc(dref(S.stuA, P(id)), weekly()), '주간 일정 생성')
    const snap = await allowed(read(S.stuA, P(id)), '주간 일정 읽기')
    assert.equal(snap.get('linkedCourseId'), null)
    await allowed(fsc.updateDoc(dref(S.stuA, P(id)), { title: '수학 학원(이동)', roomName: '2층', updatedAt: now() }), '주간 일정 수정')
    await allowed(fsc.deleteDoc(dref(S.stuA, P(id))), '주간 일정 삭제')
    await allowed(fsc.deleteDoc(dref(S.stuA, P('pe-del'))), '시드 일정 삭제')
    const once = { title: '병원', kind: 'once', date: '20261005', period: 3, start: '10:00', end: '10:45', roomName: '서울병원', memo: '보건실 들르기', linkedCourseId: null, createdAt: now(), updatedAt: now() }
    await allowed(fsc.setDoc(dref(S.stuA, P(nid())), once), '하루 일정 생성(선택 필드 모두)')
    await allowed(fsc.setDoc(dref(S.stuA, P(nid())), { title: '독서실', kind: 'weekly', weekday: 7, createdAt: now() }), '최소 필드 + updatedAt 생략')
    await allowed(fsc.setDoc(dref(S.stuA, P(nid())), weekly({ period: 0, start: null, end: null })), '0교시·시각 없음')
    const list1 = await allowed(list(S.stuA, `users/${U.stuA}/personalEntries`), '본인 개인 일정 목록')
    assert.ok(list1.size >= 3)
  })

  it('T14 제목·종류·요일·날짜·교시·시각·길이를 검증한다', async () => {
    const cases = [
      ['제목 41자', weekly({ title: '가'.repeat(41) })],
      ['빈 제목', weekly({ title: '' })],
      ['공백 제목', weekly({ title: '   ' })],
      ['제목이 문자열 아님', weekly({ title: 123 })],
      ['kind 잘못됨', weekly({ kind: 'daily' })],
      ['weekly인데 weekday 없음', without(weekly(), 'weekday')],
      ['weekly인데 weekday null', weekly({ weekday: null })],
      ['weekday 0', weekly({ weekday: 0 })],
      ['weekday 8', weekly({ weekday: 8 })],
      ['weekday 문자열', weekly({ weekday: '2' })],
      ['weekday 소수', weekly({ weekday: 2.5 })],
      ['once인데 date 없음', { ...without(weekly(), 'weekday'), kind: 'once' }],
      ['date 형식(하이픈)', { ...weekly(), kind: 'once', date: '2026-10-05' }],
      ['date 13월', { ...weekly(), kind: 'once', date: '20261305' }],
      ['date 숫자', { ...weekly(), kind: 'once', date: 20261005 }],
      ['period 11', weekly({ period: 11 })],
      ['period -1', weekly({ period: -1 })],
      ['period 소수', weekly({ period: 2.5 })],
      ['start 형식 9:00', weekly({ start: '9:00' })],
      ['start 25:00', weekly({ start: '25:00' })],
      ['end 숫자', weekly({ end: 1930 })],
      ['start ≥ end', weekly({ start: '19:30', end: '18:00' })],
      ['start = end', weekly({ start: '18:00', end: '18:00' })],
      ['roomName 31자', weekly({ roomName: '나'.repeat(31) })],
      ['memo 201자', weekly({ memo: '다'.repeat(201) })],
      ['허용 목록 밖 키 source', weekly({ source: 'official' })],
      ['허용 목록 밖 키 synced', weekly({ synced: true })],
      ['허용 목록 밖 키 pendingSync', weekly({ pendingSync: true })],
      ['허용 목록 밖 키 change(변경 표시 위조)', weekly({ change: { kind: 'reschedule' } })],
      ['createdAt 클라이언트 시각', weekly({ createdAt: new Date() })],
      ['updatedAt 클라이언트 시각', weekly({ updatedAt: new Date(Date.now() + 86400000) })],
      ['createdAt 없음', without(weekly(), 'createdAt')],
      ['linkedCourseId 숫자', weekly({ linkedCourseId: 123 })],
    ]
    for (const [label, data] of cases) await denied(fsc.setDoc(dref(S.stuA, P(nid())), data), label)
    await allowed(fsc.setDoc(dref(S.stuA, P(nid())), weekly({ title: '가'.repeat(40), roomName: '나'.repeat(30), memo: '다'.repeat(200) })), '한글 40자 제목·30자 교실·200자 메모')
  })

  it('T14 수정할 때 updatedAt은 서버 시각, createdAt은 바꿀 수 없고 형식 검증도 다시 한다', async () => {
    await denied(fsc.updateDoc(dref(S.stuA, P('pe-plain')), { title: '학원2' }), 'updatedAt 없이 수정')
    await denied(fsc.updateDoc(dref(S.stuA, P('pe-plain')), { title: '학원2', updatedAt: new Date() }), 'updatedAt 클라이언트 시각')
    await denied(fsc.updateDoc(dref(S.stuA, P('pe-plain')), { createdAt: now(), updatedAt: now() }), 'createdAt 변경')
    await denied(fsc.updateDoc(dref(S.stuA, P('pe-plain')), { weekday: 9, updatedAt: now() }), '수정 시 weekday 9')
    await denied(fsc.updateDoc(dref(S.stuA, P('pe-plain')), { synced: true, updatedAt: now() }), '수정 시 허용 밖 키')
    await allowed(fsc.updateDoc(dref(S.stuA, P('pe-plain')), { memo: '수요일로 바뀔 수도', updatedAt: now() }), '메모 수정')
  })

  it('T14 다른 학생·교사(담임 포함)는 남의 개인 일정을 읽거나 쓸 수 없다', async () => {
    await denied(read(S.stuA2, P('pe-plain')), '학생 A2 → 학생 A 일정 읽기')
    await denied(list(S.stuA2, `users/${U.stuA}/personalEntries`), '학생 A2 → 학생 A 일정 목록')
    await denied(read(S.teaA, P('pe-plain')), '담임 A → 학생 A 일정 읽기')
    await denied(fsc.setDoc(dref(S.stuA2, P(nid())), weekly()), '학생 A2 → 학생 A 경로에 생성')
    await denied(fsc.updateDoc(dref(S.stuA2, P('pe-plain')), { title: 'x', updatedAt: now() }), '학생 A2 → 학생 A 일정 수정')
    await denied(fsc.deleteDoc(dref(S.stuA2, P('pe-plain'))), '학생 A2 → 학생 A 일정 삭제')
    await denied(fsc.deleteDoc(dref(S.teaA, P('pe-plain'))), '담임 A → 학생 A 일정 삭제')
    await denied(read(S.anon, P('pe-plain')), '비로그인 → 학생 A 일정')
  })

  it('T15 linkedCourseId는 본인 학교의 active 수강일 때만 연결할 수 있다', async () => {
    await allowed(fsc.setDoc(dref(S.stuA, P('linked-c1')), weekly({ title: '영어 B 메모', linkedCourseId: 'c1', memo: '단어 시험' })), 'active 수강 c1 연결')
    await denied(fsc.setDoc(dref(S.stuA, P(nid())), weekly({ linkedCourseId: 'c2' })), '끝난 수강 c2 연결')
    await denied(fsc.setDoc(dref(S.stuA, P(nid())), weekly({ linkedCourseId: 'c3' })), '승인 대기 수강 c3 연결')
    await denied(fsc.setDoc(dref(S.stuA, P(nid())), weekly({ linkedCourseId: 'c4' })), '남(A2)만 듣는 c4 연결')
    await denied(fsc.setDoc(dref(S.stuA, P(nid())), weekly({ linkedCourseId: 'c999' })), '수강 기록 없는 수업 연결')
    await denied(fsc.setDoc(dref(S.stuA, P(nid())), weekly({ linkedCourseId: 'cb1' })), '다른 학교(B) 수강으로 연결')
    await denied(fsc.setDoc(dref(S.stuA, P(nid())), weekly({ linkedCourseId: `c1__${U.stuA2}` })), '경로 조작 id')
    await denied(fsc.setDoc(dref(S.stuA, P(nid())), weekly({ linkedCourseId: '../c1' })), '허용 밖 문자')
    await denied(fsc.setDoc(dref(S.stuA, P(nid())), weekly({ linkedCourseId: '' })), '빈 문자열')
    await denied(fsc.setDoc(dref(S.stuA2, `users/${U.stuA2}/personalEntries/x`), weekly({ linkedCourseId: 'c2' })), '학생 A2 → 듣지 않는 c2')
    await allowed(fsc.setDoc(dref(S.stuA2, `users/${U.stuA2}/personalEntries/x`), weekly({ linkedCourseId: 'c4' })), '학생 A2 → 본인 active c4')
  })

  it('T15 연결 변경은 다시 확인하고, 이미 연결된 일정은 수강이 끝나도 메모 수정·연결 해제가 된다', async () => {
    await denied(fsc.updateDoc(dref(S.stuA, P('pe-plain')), { linkedCourseId: 'c2', updatedAt: now() }), '미연결 → 끝난 수강 c2')
    await denied(fsc.updateDoc(dref(S.stuA, P('linked-c1')), { linkedCourseId: 'c4', updatedAt: now() }), 'c1 → 남의 수강 c4')
    await allowed(fsc.updateDoc(dref(S.stuA, P('pe-plain')), { linkedCourseId: 'c1', updatedAt: now() }), '미연결 → active c1')
    await allowed(fsc.updateDoc(dref(S.stuA, P('pe-ended-link')), { memo: '실험복 챙기기', updatedAt: now() }), '끝난 c2 연결 일정 메모 수정(연결 값 그대로)')
    await allowed(fsc.updateDoc(dref(S.stuA, P('pe-ended-link')), { linkedCourseId: null, updatedAt: now() }), '연결 해제(null)')
    await denied(fsc.updateDoc(dref(S.stuA, P('pe-ended-link')), { linkedCourseId: 'c2', updatedAt: now() }), '해제 뒤 끝난 c2로 다시 연결')
  })
})

// ─────────────────────────────────────────────────────────────
describe('users 권한 필드·기존 규칙 회귀 (T39)', () => {
  const me = (k) => dref(S[k], `users/${U[k]}`)

  it('T39 학생·교사 모두 자기 문서에 학교 관리자 등 권한 필드를 쓸 수 없다', async () => {
    for (const k of ['stuA', 'teaA']) {
      await denied(fsc.updateDoc(me(k), { isSchoolAdmin: true }), `${k} isSchoolAdmin`)
      await denied(fsc.updateDoc(me(k), { schoolAdmin: true }), `${k} schoolAdmin`)
      await denied(fsc.updateDoc(me(k), { isAdmin: true }), `${k} isAdmin`)
      await denied(fsc.updateDoc(me(k), { roles: ['admin'] }), `${k} roles`)
      await denied(fsc.updateDoc(me(k), { permissions: { publish: true } }), `${k} permissions`)
      await denied(fsc.updateDoc(me(k), { isSchoolAdmin: false, displayName: '이름' }), `${k} isSchoolAdmin:false 끼워 넣기`)
    }
  })

  it('T39 학생은 역할·승인 상태·소속·학교를 스스로 바꿀 수 없다(기존 규칙 유지)', async () => {
    await denied(fsc.updateDoc(me('stuA'), { role: 'teacher' }), '학생 → role teacher')
    await denied(fsc.updateDoc(me('stuP'), { status: 'approved' }), '대기 학생 → 스스로 승인')
    await denied(fsc.updateDoc(me('stuA'), { classId: `${SA}_1_2` }), '학생 → classId 변경')
    await denied(fsc.updateDoc(me('stuA'), { extraClassIds: [`${SA}_1_1_g_x`] }), '학생 → extraClassIds')
    await denied(fsc.updateDoc(me('stuA'), { schoolCode: SB }), '학생 → 다른 학교로')
    await denied(fsc.setDoc(dref(S.nodoc, `users/${U.nodoc}`), { role: 'teacher', schoolCode: SA }), 'users 문서 직접 생성')
    await denied(read(S.stuA, `users/${U.stuA2}`), '학생 A → 학생 A2 프로필')
  })

  it('T39 학생은 자기 번호(studentId)·신청 일련번호(joinSeq)를 바꿀 수 없다(명단 연결 후보 가로채기·차단 방지)', async () => {
    // 명단 가져오기 연결은 '같은 반 승인 학생 중 번호가 같은 1명'을 후보로 씀 — 번호는 서버(/api/join·초대 수락·반 이동 승인)만 씀
    await denied(fsc.updateDoc(me('stuA'), { studentId: '3' }), '번호 없는 학생 A → 다른 학생(A2) 번호로')
    await denied(fsc.updateDoc(me('stuA2'), { studentId: '5' }), '학생 A2 → 번호 변경')
    await denied(fsc.updateDoc(me('stuA2'), { studentId: 5 }), '학생 A2 → 번호를 숫자로')
    await denied(fsc.updateDoc(me('stuA2'), { studentId: fsc.deleteField() }), '학생 A2 → 번호 지우기(자리 비우기)')
    await denied(fsc.setDoc(me('stuA2'), { studentId: '5', displayName: '나학생' }, { merge: true }), '학생 A2 → 이름과 함께 번호 끼워 넣기')
    await denied(fsc.updateDoc(me('stuP'), { studentId: '9' }), '승인 대기 학생 → 번호 변경')
    await denied(fsc.updateDoc(me('stuA'), { joinSeq: 99 }), '학생 → 신청 일련번호(알림 id) 조작')
    // 번호를 그대로 둔 채 다른 허용 필드 수정(전체 문서 merge 저장 포함)은 계속 됨
    await allowed(fsc.setDoc(me('stuA2'), { studentId: '3', displayName: '나학생' }, { merge: true }), '학생 A2 → 같은 번호 그대로 + displayName')
    const snap = await allowed(read(S.stuA2, `users/${U.stuA2}`), '학생 A2 → 본인 프로필')
    assert.equal(snap.get('studentId'), '3')
  })

  it('교사는 role·schoolCode를 바꿀 수 없고, 허용 필드는 그대로 수정된다(회귀)', async () => {
    await denied(fsc.updateDoc(me('teaA'), { role: 'student' }), '교사 → role 변경')
    await denied(fsc.updateDoc(me('teaA'), { schoolCode: SB }), '교사 → schoolCode 변경')
    await allowed(fsc.updateDoc(me('stuA'), { displayName: '가학생2' }), '학생 → displayName')
    await allowed(fsc.updateDoc(me('teaA'), { mySchedule: { mon: ['영어'] } }), '교사 → mySchedule')
    await allowed(fsc.updateDoc(me('teaA'), { teachingClassIds: [HR_A] }), '교사 → teachingClassIds')
  })

  it('담임만 대기 학생을 승인할 수 있다(다른 학교 교사·담임 아닌 교사 거부 — 회귀)', async () => {
    await denied(fsc.updateDoc(dref(S.teaB, `users/${U.stuP}`), { status: 'approved' }), '학교 B 교사 → 승인')
    await denied(fsc.updateDoc(dref(S.teaA2, `users/${U.stuP}`), { status: 'approved' }), '담임 아닌 교사 → 승인')
    await denied(fsc.updateDoc(dref(S.teaA, `users/${U.stuP}`), { status: 'approved', isSchoolAdmin: true }), '담임 → 승인 + 권한 필드')
    await allowed(fsc.updateDoc(dref(S.teaA, `users/${U.stuP}`), { status: 'approved' }), '담임 A → 승인')
  })

  it('알림: 클라이언트는 자동 id로만 만들 수 있고 서버 중복 방지 id(sched_…)는 먼저 만들 수 없다', async () => {
    const msg = () => ({ title: '알림', body: '본문', url: '/student/today', createdAt: now(), read: false })
    await denied(fsc.setDoc(dref(S.teaA, `users/${U.stuA}/notifications/sched_cs_${RUN}`), msg()), '교사 → sched_ 고정 id 선점')
    await denied(fsc.setDoc(dref(S.stuA2, `users/${U.stuA}/notifications/join_x_${RUN}`), msg()), '학생 → join_ 고정 id 선점')
    await allowed(fsc.addDoc(fsc.collection(S.teaA.db, `users/${U.stuA}/notifications`), msg()), '교사 → 자동 id 알림(기존 기능)')
  })

  it('다른 학교 교사는 학급·학생 프로필을 읽을 수 없다(회귀)', async () => {
    await denied(read(S.teaB, `classes/${HR_A}`), '학교 B 교사 → 학교 A 학급')
    await denied(read(S.teaB, `users/${U.stuA}`), '학교 B 교사 → 학교 A 학생')
    await allowed(read(S.teaA2, `users/${U.stuA}`), '같은 학교 교사 → 학생 프로필')
  })
})
