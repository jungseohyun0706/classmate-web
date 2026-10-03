// Firestore 보안 규칙 × 실제 서버 API 통합 테스트 (아키텍처 8·9절, 지시서 16장 — T14·T15·T39·R16)
// 서버 API(/api/courses·/api/invitations·/api/enrollments·/api/timetable/me)가 만든 실제 문서를
// 클라이언트 SDK(보안 규칙을 거치는 앱 경로)로 읽고 쓸 때 허용·차단이 맞는지 확인합니다.
// 실행 전제: 실제 서버(BASE, 기본 http://127.0.0.1:3100) + Firebase 에뮬레이터(Firestore 8080, Auth 9099)
//           — 에뮬레이터는 저장소 firestore.rules를 읽은 상태여야 합니다(복사본이면 최신 규칙으로 다시 복사)
//           + NEIS mock(NODE_OPTIONS="--require tests/support/neis-mock.cjs", NEIS_MOCK_FILE)
// 사용: node tests/api/sa4-rules.test.mjs
// 참고: 에뮬레이터는 복합 인덱스를 강제하지 않습니다 — 인덱스 누락은 운영(또는 스테이징)에서만 드러나므로
//       firestore.indexes.json 배포 전후로 실제 프로젝트에서 따로 확인해야 합니다.
// 모든 데이터는 에뮬레이터의 테스트용 가상 데이터이며 실제 학생 정보가 아닙니다.
import { admin, wipe, createUsers, writeNeisFixture, clientSession, api, reporter, require as rootRequire } from '../e2e/lib/env.mjs'

const fsc = rootRequire('firebase/firestore')
fsc.setLogLevel('silent') // 거부된 쓰기마다 찍히는 SDK 경고 숨김(결과는 check로 기록)

const { check, note, finish } = reporter('api-sa4-rules')

// ───────── 날짜(학교 시간대 KST) ─────────
const ymdOf = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
const toDate = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)))
const addDays = (ymd, n) => ymdOf(new Date(toDate(ymd).getTime() + n * 86400000))
const weekdayOf = (ymd) => toDate(ymd).getUTCDay() || 7
const TODAY = ymdOf(new Date(Date.now() + 9 * 3600 * 1000))
const MON = addDays(TODAY, 8 - weekdayOf(TODAY)) // 다음 주 월요일
const SUN = addDays(MON, 6)

const S1 = { schoolCode: 'S1', schoolName: '테스트고등학교', officeCode: 'B10' }
const S2 = { schoolCode: 'S2', schoolName: '다른고등학교', officeCode: 'B10' }

async function seed() {
  await wipe()
  writeNeisFixture({
    schools: [
      { SD_SCHUL_CODE: 'S1', SCHUL_NM: '테스트고등학교', SCHUL_KND_SC_NM: '고등학교', ATPT_OFCDC_SC_CODE: 'B10' },
      { SD_SCHUL_CODE: 'S2', SCHUL_NM: '다른고등학교', SCHUL_KND_SC_NM: '고등학교', ATPT_OFCDC_SC_CODE: 'B10' },
    ],
    meals: [],
    timetables: {},
    schedule: [],
  })
  const St = (name, studentId) => ({ role: 'student', status: 'approved', name, displayName: name, classId: 'S1_3_4', grade: 3, classNm: 4, studentId, ...S1 })
  await createUsers([
    { uid: 'hr4', email: 'hr4@e2e.kr', doc: { role: 'teacher', name: '김담임', displayName: '김담임', classId: 'S1_3_4', grade: 3, classNm: 4, ...S1 } },
    { uid: 'ty', email: 'ty@e2e.kr', doc: { role: 'teacher', name: '이영어', displayName: '이영어', ...S1 } },
    { uid: 'stuA', email: 'a@e2e.kr', doc: St('김학생', 7) },
    { uid: 'stuB', email: 'b@e2e.kr', doc: St('이학생', 8) },
    { uid: 'ty2', email: 'ty2@e2e.kr', doc: { role: 'teacher', name: '이영어', displayName: '이영어', ...S2 } },
  ])
  const { db } = admin()
  await db.doc('classes/S1_3_4').set({ classId: 'S1_3_4', grade: 3, classNm: 4, teacherId: 'hr4', teacherName: '김담임', ...S1 })
}

const sessions = {}
async function sess(email) {
  if (!sessions[email]) sessions[email] = await clientSession(email)
  return sessions[email]
}
const tok = async (email) => (await sess(email)).token
const courses = async (email, body) => api('/api/courses', await tok(email), body)
const inv = async (email, body) => api('/api/invitations', await tok(email), body)
const enroll = async (email, body) => api('/api/enrollments', await tok(email), body)
const me = async (email) => api(`/api/timetable/me?from=${MON}&to=${SUN}`, await tok(email), null, 'GET')

/** 클라이언트 SDK 요청 결과: { ok, v } 또는 { ok:false, code } */
async function attempt(p) {
  try {
    return { ok: true, v: await p }
  } catch (e) {
    return { ok: false, code: e?.code || String(e).slice(0, 120) }
  }
}
const denied = (r) => !r.ok && r.code === 'permission-denied'
const why = (r) => (r.ok ? '허용됨' : r.code)

/** onSnapshot 첫 결과(구독이 규칙을 통과하는지) */
function firstSnapshot(ref, ms = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub()
      reject(new Error('timeout'))
    }, ms)
    const unsub = fsc.onSnapshot(
      ref,
      (snap) => {
        clearTimeout(timer)
        unsub()
        resolve(snap)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

async function main() {
  await seed()
  note('setup', `TODAY=${TODAY} 조회 기간 ${MON}~${SUN}. 에뮬레이터가 저장소 firestore.rules를 읽은 상태여야 합니다.`)

  // ───── 서버 API로 수업·차시·초대·수강을 만든다 ─────
  const c = await courses('ty@e2e.kr', { action: 'create', title: '영어 B', subject: '영어', section: 'B' })
  const courseId = c.j.courseId
  const s = await courses('ty@e2e.kr', { action: 'addSeries', courseId, weekday: 2, period: 3, roomName: '영어실' })
  check('setup', '교사 Y가 API로 영어 B(화3 영어실) 생성', c.status === 200 && !!courseId && s.status === 200, `${c.status}/${s.status} ${c.j.code || ''}`)
  const iv = await inv('ty@e2e.kr', { action: 'create', type: 'course', targetId: courseId })
  const CODE = iv.j.code
  const acc = await inv('a@e2e.kr', { action: 'accept', code: CODE })
  check('setup', '학생 A가 수업 초대를 API로 수락 → active 수강', acc.status === 200 && acc.j.enrollmentStatus === 'active', `${acc.status} ${JSON.stringify(acc.j).slice(0, 160)}`)

  const A = await sess('a@e2e.kr')
  const B = await sess('b@e2e.kr')
  const Y = await sess('ty@e2e.kr')
  const Y2 = await sess('ty2@e2e.kr')
  const HR = await sess('hr4@e2e.kr')

  // ───── 학교 문서: 학생 화면의 scheduleRevision 구독 ─────
  const sch = await attempt(fsc.getDocFromServer(fsc.doc(A.d, 'schools/S1')))
  check('R16', '학생 A: schools/S1 읽기 허용(scheduleRevision이 서버 쓰기로 올라가 있음)', sch.ok && Number(sch.v.get('scheduleRevision')) >= 1, sch.ok ? `rev=${sch.v.get('scheduleRevision')}` : why(sch))
  const sub = await attempt(firstSnapshot(fsc.doc(A.d, 'schools/S1')))
  check('R16', '학생 A: schools/S1 onSnapshot 구독 허용(변경 시 다시 받기 신호)', sub.ok && sub.v.exists(), why(sub))
  const schW = await attempt(fsc.updateDoc(fsc.doc(A.d, 'schools/S1'), { scheduleRevision: 999 }))
  check('T39', '학생 A: scheduleRevision 직접 쓰기 거부', denied(schW), why(schW))
  const schOther = await attempt(fsc.getDocFromServer(fsc.doc(Y2.d, 'schools/S1')))
  check('R16', '다른 학교(S2) 교사: schools/S1 읽기 거부', denied(schOther), why(schOther))

  // ───── 수강: 앱이 쓰는 where('uid','==',me) 쿼리 ─────
  const enrCol = fsc.collection(A.d, 'schools/S1/enrollments')
  const mine = await attempt(fsc.getDocsFromServer(fsc.query(enrCol, fsc.where('uid', '==', 'stuA'))))
  check(
    'T39',
    "학생 A: where('uid','==',본인) 수강 쿼리 허용 — 서버가 만든 수강 1건",
    mine.ok && mine.v.size === 1 && mine.v.docs[0].get('courseId') === courseId && mine.v.docs[0].get('status') === 'active',
    mine.ok ? `${mine.v.size}건` : why(mine)
  )
  const mineActive = await attempt(fsc.getDocsFromServer(fsc.query(enrCol, fsc.where('uid', '==', 'stuA'), fsc.where('status', '==', 'active'))))
  check('T39', "학생 A: uid+status 쿼리 허용(인덱스 enrollments uid·status)", mineActive.ok && mineActive.v.size === 1, why(mineActive))
  const roster = await attempt(fsc.getDocsFromServer(fsc.query(enrCol, fsc.where('courseId', '==', courseId))))
  check('T39', '학생 A: 수업별 수강생 명단 쿼리 거부(타인 수강 조회 차단)', denied(roster), why(roster))
  const allEnr = await attempt(fsc.getDocsFromServer(enrCol))
  check('T39', '학생 A: 필터 없는 수강 목록 거부', denied(allEnr), why(allEnr))
  const enrW = await attempt(fsc.setDoc(fsc.doc(A.d, `schools/S1/enrollments/${courseId}__stuB`), { courseId, uid: 'stuB', status: 'active' }))
  check('T39', '학생 A: 다른 학생 수강을 직접 만들기 거부', denied(enrW), why(enrW))
  const enrSelf = await attempt(fsc.updateDoc(fsc.doc(A.d, `schools/S1/enrollments/${courseId}__stuA`), { to: null, status: 'active', source: 'admin' }))
  check('T39', '학생 A: 본인 수강 문서 직접 수정 거부(서버 API만)', denied(enrSelf), why(enrSelf))

  // ───── 공식 시간표 자료는 API로만 ─────
  const crs = await attempt(fsc.getDocFromServer(fsc.doc(A.d, `schools/S1/courses/${courseId}`)))
  check('T39', '학생 A: 수강 중인 수업 문서도 직접 읽기 거부(/api/timetable/me로만)', denied(crs), why(crs))
  const ser = await attempt(fsc.getDocsFromServer(fsc.query(fsc.collection(A.d, 'schools/S1/series'), fsc.where('courseId', '==', courseId))))
  check('T39', '학생 A: 차시 목록 직접 읽기 거부', denied(ser), why(ser))
  const ovW = await attempt(fsc.setDoc(fsc.doc(A.d, 'schools/S1/overrides/fake'), { courseId, kind: 'cancel', status: 'published', revision: 99 }))
  check('T39', '학생 A: 휴강 변경 직접 쓰기 거부(공식 일정 수정 차단)', denied(ovW), why(ovW))
  const meA = await me('a@e2e.kr')
  const payloadText = JSON.stringify(meA.j)
  check(
    'T39',
    '학생 A: /api/timetable/me는 본인 수강 수업·차시를 돌려줌(다른 학생 uid 없음)',
    meA.status === 200 && (meA.j.courses || []).some((x) => x.courseId === courseId) && (meA.j.series || []).some((x) => x.courseId === courseId) && !payloadText.includes('stuB'),
    `${meA.status} ${meA.j.code || ''} courses=${(meA.j.courses || []).length}`
  )

  // ───── 초대 문서는 서버만 ─────
  const invRead = await attempt(fsc.getDocFromServer(fsc.doc(A.d, `invitations/${CODE}`)))
  const invReadT = await attempt(fsc.getDocFromServer(fsc.doc(Y.d, `invitations/${CODE}`)))
  check('T39', '초대 문서 직접 읽기: 학생·발급 교사 모두 거부(미리보기는 API)', denied(invRead) && denied(invReadT), `${why(invRead)}/${why(invReadT)}`)
  const usesRead = await attempt(fsc.getDocsFromServer(fsc.collection(Y.d, `invitations/${CODE}/uses`)))
  check('T39', '초대 사용 기록(참여 학생) 직접 읽기 거부', denied(usesRead), why(usesRead))

  // ───── 교사: 같은 학교는 읽기만, 다른 학교는 차단 ─────
  const yCourses = await attempt(fsc.getDocsFromServer(fsc.query(fsc.collection(Y.d, 'schools/S1/courses'), fsc.where('teacherUids', 'array-contains', 'ty'))))
  check('R16', '교사 Y: 내 수업 쿼리(teacherUids array-contains) 허용', yCourses.ok && yCourses.v.docs.some((d) => d.id === courseId), why(yCourses))
  const yRoster = await attempt(fsc.getDocsFromServer(fsc.query(fsc.collection(Y.d, 'schools/S1/enrollments'), fsc.where('courseId', '==', courseId), fsc.where('status', '==', 'active'))))
  check('R16', '교사 Y: 수업별 active 수강생 쿼리 허용(인덱스 enrollments courseId·status)', yRoster.ok && yRoster.v.size === 1, why(yRoster))
  const ySets = await attempt(
    fsc.getDocsFromServer(fsc.query(fsc.collection(Y.d, 'schools/S1/changeSets'), fsc.where('affectedCourseIds', 'array-contains', courseId), fsc.orderBy('createdAt', 'desc')))
  )
  check('R16', '교사 Y: 변경 이력 쿼리(affectedCourseIds + createdAt desc) 규칙 통과(인덱스는 에뮬레이터가 강제하지 않음)', ySets.ok, why(ySets))
  const yW = await attempt(fsc.updateDoc(fsc.doc(Y.d, `schools/S1/courses/${courseId}`), { title: '바뀐 제목' }))
  check('T39', '담당 교사 Y도 수업 문서 직접 수정 거부(서버 API만 — 버전·감사 기록)', denied(yW), why(yW))
  const y2Read = await attempt(fsc.getDocFromServer(fsc.doc(Y2.d, `schools/S1/courses/${courseId}`)))
  const y2Enr = await attempt(fsc.getDocsFromServer(fsc.query(fsc.collection(Y2.d, 'schools/S1/enrollments'), fsc.where('courseId', '==', courseId))))
  check('R16', '다른 학교(S2) 같은 이름 교사: 수업·수강 읽기 거부', denied(y2Read) && denied(y2Enr), `${why(y2Read)}/${why(y2Enr)}`)

  // ───── 개인 일정: 직접 입력 vs 공식 연결 ─────
  const pe = (extra) => ({ title: '영어 B 메모', kind: 'weekly', weekday: 2, period: 3, start: null, end: null, roomName: null, memo: '단어 시험', linkedCourseId: null, createdAt: fsc.serverTimestamp(), updatedAt: fsc.serverTimestamp(), ...extra })
  const aLinked = await attempt(fsc.setDoc(fsc.doc(A.d, 'users/stuA/personalEntries/eng'), pe({ linkedCourseId: courseId })))
  check('T15', '학생 A: 초대로 수강한 수업에 개인 일정 연결 허용', aLinked.ok, why(aLinked))
  const bLinked = await attempt(fsc.setDoc(fsc.doc(B.d, 'users/stuB/personalEntries/eng'), pe({ linkedCourseId: courseId })))
  check('T15', '학생 B(같은 반, 미수강): 같은 수업 연결 거부 — 과목명·학급만으로 연결 불가', denied(bLinked), why(bLinked))
  const bPlain = await attempt(fsc.setDoc(fsc.doc(B.d, 'users/stuB/personalEntries/plain'), pe({ title: '영어 학원', start: '18:00', end: '19:00', memo: null })))
  check('T14', '학생 B: 공식 미연결 개인 일정 생성 허용', bPlain.ok, why(bPlain))
  const bFake = await attempt(fsc.setDoc(fsc.doc(B.d, 'users/stuB/personalEntries/fake'), pe({ source: 'official', synced: true })))
  check('T14', '학생 B: 공식 수업처럼 보이게 하는 키(source·synced) 거부', denied(bFake), why(bFake))
  const hrRead = await attempt(fsc.getDocFromServer(fsc.doc(HR.d, 'users/stuA/personalEntries/eng')))
  check('T14', '담임 교사도 학생 개인 일정 읽기 거부(본인만)', denied(hrRead), why(hrRead))

  // 학생 B도 초대를 수락하면 연결 가능 → 담당 교사가 수강을 끝내면 새 연결은 거부, 기존 연결 일정 메모 수정은 허용
  const accB = await inv('b@e2e.kr', { action: 'accept', code: CODE })
  const bLinked2 = await attempt(fsc.setDoc(fsc.doc(B.d, 'users/stuB/personalEntries/eng'), pe({ linkedCourseId: courseId })))
  check('T15', '학생 B: 초대 수락(API) 뒤에는 같은 수업 연결 허용', accB.status === 200 && bLinked2.ok, `${accB.status} ${accB.j.enrollmentStatus || accB.j.code}/${why(bLinked2)}`)
  const endB = await enroll('ty@e2e.kr', { action: 'end', courseId, uid: 'stuB' })
  const bLinked3 = await attempt(fsc.setDoc(fsc.doc(B.d, 'users/stuB/personalEntries/eng2'), pe({ linkedCourseId: courseId })))
  check('T15', '담당 교사가 학생 B 수강 종료(API) 뒤 새 연결 거부', endB.status === 200 && denied(bLinked3), `${endB.status} ${endB.j.code || ''}/${why(bLinked3)}`)
  const bMemo = await attempt(fsc.updateDoc(fsc.doc(B.d, 'users/stuB/personalEntries/eng'), { memo: '수강 끝남', updatedAt: fsc.serverTimestamp() }))
  const bUnlink = await attempt(fsc.updateDoc(fsc.doc(B.d, 'users/stuB/personalEntries/eng'), { linkedCourseId: null, updatedAt: fsc.serverTimestamp() }))
  check('T15', '수강이 끝나도 기존 연결 일정의 메모 수정·연결 해제는 허용', bMemo.ok && bUnlink.ok, `${why(bMemo)}/${why(bUnlink)}`)

  // ───── users 권한 필드 ─────
  const aAdmin = await attempt(fsc.updateDoc(fsc.doc(A.d, 'users/stuA'), { isSchoolAdmin: true }))
  const yAdmin = await attempt(fsc.updateDoc(fsc.doc(Y.d, 'users/ty'), { isSchoolAdmin: true }))
  const aRole = await attempt(fsc.updateDoc(fsc.doc(A.d, 'users/stuA'), { role: 'teacher' }))
  check('T39', '학생·교사 모두 isSchoolAdmin 자기 부여 거부, 학생 role 변경 거부', denied(aAdmin) && denied(yAdmin) && denied(aRole), `${why(aAdmin)}/${why(yAdmin)}/${why(aRole)}`)
  const yAdminApi = await courses('ty@e2e.kr', { action: 'list' })
  check('T39', '거부된 권한 필드 쓰기 뒤에도 교사 Y의 수업 목록 API는 정상(규칙 강화가 기존 흐름을 막지 않음)', yAdminApi.status === 200, `${yAdminApi.status} ${yAdminApi.j.code || ''}`)

  for (const x of Object.values(sessions)) await x.close()
}

let failed = 1
try {
  await main()
  failed = finish()
} catch (e) {
  console.error('테스트 실행 오류', e)
  check('setup', '테스트 실행 오류 없음', false, String(e?.stack || e).slice(0, 400))
  failed = finish()
}
process.exit(failed ? 1 : 0)
