// 통합 테스트: /api/roster-import — 학생별 수강 명단 stage → commit → link → list, 그리고 /api/timetable/me 반영
// 대상: 실제 Next 서버(BASE, 기본 http://127.0.0.1:3100) + 로컬 에뮬레이터(8080/9099) + NEIS mock. 운영 프로젝트에 연결하지 않습니다.
// 데이터는 모두 가상입니다(학교 S1, 이름은 임의).
// 실행: node tests/api/im2-roster.test.mjs   (서버를 에뮬레이터 환경 + NODE_OPTIONS="--require ./tests/support/neis-mock.cjs"로 띄운 뒤)
//
// 검수 항목
// - T32 학생 자료 없음: 시간표(수업·차시)만 있고 명단 연결이 없으면 학생 개인 시간표에 선택 수업이 생기지 않음
//        (stage·commit만으로도 생기지 않고, 담임·담당 교사가 연결을 확정해야 /api/timetable/me에 보임)
// - T33 동명이인·같은 과목 다른 분반: 이름으로 연결하지 않고(학년·반·번호), 분반이 없으면 임의 분반을 고르지 않음
// - T30 같은 파일 재업로드: 명단 행이 늘지 않고 이미 확정한 연결이 유지됨
// - T39/T40 권한: 학생·다른 학교 교사·담임/담당 아닌 교사 차단
// - T46 감사 기록에 학생 이름·uid가 남지 않음
// - 검토 결함 회귀: 가져오기로 만든 수업의 코드(importKey 'code|…')로 연결, 코드로 못 찾으면 과목·분반·교사로,
//   분반 접두어 표기('A_영어', 분반 열 없음)는 시간표 가져오기와 같은 규칙으로 나눠 비교
import crypto from 'crypto'
import { wipe, createUsers, clientSession, api, reporter, admin, Timestamp } from '../e2e/lib/env.mjs'

const S = 'S1'
const API = '/api/roster-import'
const VF = '20261005' // 2026-2 학기(학기 문서 없음 → 기본 학기)
const TERM = '2026-2'
const HASH = crypto.createHash('sha256').update('im2-roster-file-v1').digest('hex')

const { check, note, finish } = reporter('im2-roster')
const { db } = admin()
const sref = db.collection('schools').doc(S)

const USERS = [
  { uid: 'tHome', email: 'thome@im2.test', doc: { role: 'teacher', schoolCode: S, schoolName: '테스트고등학교', name: '담임34', classId: `${S}_3_4` } },
  { uid: 'tHome5', email: 'thome5@im2.test', doc: { role: 'teacher', schoolCode: S, schoolName: '테스트고등학교', name: '담임35' } },
  { uid: 'tEng', email: 'teng@im2.test', doc: { role: 'teacher', schoolCode: S, schoolName: '테스트고등학교', name: '김영어' } },
  { uid: 'tNone', email: 'tnone@im2.test', doc: { role: 'teacher', schoolCode: S, schoolName: '테스트고등학교', name: '무관교사' } },
  { uid: 'tOther', email: 'tother@im2.test', doc: { role: 'teacher', schoolCode: 'S2', schoolName: '다른고', name: '타학교' } },
  { uid: 'sA', email: 'sa@im2.test', doc: { role: 'student', status: 'approved', schoolCode: S, classId: `${S}_3_4`, grade: 3, classNm: 4, studentId: '1', name: '김민수' } },
  { uid: 'sB', email: 'sb@im2.test', doc: { role: 'student', status: 'approved', schoolCode: S, classId: `${S}_3_4`, grade: 3, classNm: 4, studentId: '02', name: '이영희' } },
  // 동명이인: 3학년 5반 1번 김민수
  { uid: 'sC', email: 'sc@im2.test', doc: { role: 'student', status: 'approved', schoolCode: S, classId: `${S}_3_5`, grade: 3, classNm: 5, studentId: '1', name: '김민수' } },
  // 같은 반 같은 번호 두 명(번호 입력 실수)
  { uid: 'sD1', email: 'sd1@im2.test', doc: { role: 'student', status: 'approved', schoolCode: S, classId: `${S}_3_5`, grade: 3, classNm: 5, studentId: '7', name: '중복일' } },
  { uid: 'sD2', email: 'sd2@im2.test', doc: { role: 'student', status: 'approved', schoolCode: S, classId: `${S}_3_5`, grade: 3, classNm: 5, studentId: '7', name: '중복이' } },
]

const ROWS = [
  { row: 2, grade: 3, classNm: 4, number: 1, name: '김민수', subject: '영어', section: 'B' }, // cEngB, 후보 sA
  { row: 3, grade: 3, classNm: 4, number: 2, name: '이영희', subject: '영어' }, // 분반 없음 → A/B 모호(검토)
  { row: 4, grade: 3, classNm: 5, number: 1, name: '김민수', subject: '영어', section: 'A' }, // cEngA, 후보 sC(동명이인)
  { row: 5, grade: 3, classNm: 4, number: 9, name: '미가입', subject: '생활과 과학', section: 'A' }, // cSci, 미가입
  { row: 6, grade: 3, classNm: 5, number: 7, subject: '영어', section: 'B' }, // 같은 번호 두 명 → 모호
  { row: 7, grade: 3, classNm: 4, number: 1, name: '김민수', subject: '영어', section: 'B' }, // 2행과 중복
  { row: 8, grade: 3, classNm: 4, number: 3, courseCode: 'eng-b' }, // 수업 코드(대소문자 무시) → cEngB
  { row: 9, grade: 3, classNm: 4, number: 1, subject: '수학' }, // 교사 다른 수학 두 개 → 모호
  { row: 10, grade: 3, classNm: 4, number: 1, subject: '수학', teacher: '정수학' }, // cMath1
]

async function seed() {
  // NEIS mock 파일(tests/fixtures/neis-mock.runtime.json)은 다른 테스트와 함께 쓰므로 고치지 않음 — 학교 S1이 들어 있음
  await wipe()
  await createUsers(USERS)
  await db.collection('classes').doc(`${S}_3_4`).set({ schoolCode: S, schoolName: '테스트고등학교', grade: 3, classNm: 4, teacherId: 'tHome' })
  await db.collection('classes').doc(`${S}_3_5`).set({ schoolCode: S, schoolName: '테스트고등학교', grade: 3, classNm: 5, teacherId: 'tHome5' })
  await sref.set({ scheduleRevision: 5, timezone: 'Asia/Seoul' })
  const course = (id, d) =>
    sref.collection('courses').doc(id).set({
      schoolCode: S,
      termId: TERM,
      status: 'active',
      commonForHomerooms: [],
      teacherUids: [],
      teacherNames: [],
      catalogVisible: false,
      invitePolicy: 'approval',
      source: 'manual',
      title: d.subject + (d.section ? ' ' + d.section : ''),
      createdAt: Timestamp.now(),
      revision: 1,
      ...d,
    })
  await course('cEngA', { subject: '영어', section: 'A', teacherNames: ['박영어'], teacherUids: ['tEngA'] })
  // 시간표 가져오기가 수업 코드로 만든 수업: importKey = 'code|<코드>'(코드 필드는 따로 없음)
  await course('cEngB', { subject: '영어', section: 'B', teacherNames: ['김영어'], teacherUids: ['tEng'], source: 'import', importKey: 'code|ENG-B' })
  // 코드 없이(분반으로) 가져온 수업
  await course('cSci', { subject: '생활과 과학', section: 'A', teacherNames: ['최과학'], source: 'import', importKey: 'sec|생활과과학|A|최과학' })
  await course('cMath1', { subject: '수학', teacherNames: ['정수학'] })
  await course('cMath2', { subject: '수학', teacherNames: ['한수학'] })
  // 영어 B: 화 3교시(3-5 교실). 시간표(차시)는 있지만 수강 관계는 아직 없음
  await sref.collection('series').doc('srEngB').set({
    courseId: 'cEngB',
    termId: TERM,
    weekday: 2,
    period: 3,
    roomName: '3-5 교실',
    validFrom: '20260816',
    validTo: null,
    status: 'active',
    createdAt: Timestamp.now(),
  })
}

const meQuery = '/api/timetable/me?from=20261005&to=20261011'
const hasCourse = (j, id) => Array.isArray(j?.courses) && j.courses.some((c) => c.courseId === id)

try {
  await seed()
  const T = {}
  for (const u of USERS) {
    const s = await clientSession(u.email)
    T[u.uid] = s.token
    await s.close()
  }

  // ── 권한 ──
  let r = await api(API, null, { action: 'list' })
  check('T39', '토큰 없으면 401', r.status === 401 && r.j.code === 'unauthenticated', `${r.status} ${r.j.code}`)
  r = await api(API, T.sA, { action: 'list' })
  check('T39', '학생은 명단 API 403(teacher-only)', r.status === 403 && r.j.code === 'teacher-only', `${r.status} ${r.j.code}`)
  r = await api(API, T.tOther, { action: 'stage', schoolCode: S, validFrom: VF, fileName: 'x.csv', fileHash: HASH, rows: ROWS })
  check('T39', '다른 학교 교사가 S1 명단 stage → 403 school-mismatch', r.status === 403 && r.j.code === 'school-mismatch', `${r.status} ${r.j.code}`)
  r = await api(API, T.tHome, { action: 'stage', schoolCode: S, validFrom: VF, fileHash: HASH, rows: Array.from({ length: 3001 }, (_, i) => ({ ...ROWS[0], row: i + 2 })) })
  check('val', '3001행 → 413 too-many-rows', r.status === 413 && r.j.code === 'too-many-rows', `${r.status} ${r.j.code}`)

  // ── T32: 명단 연결 전에는 학생 개인 시간표에 선택 수업이 없음 ──
  r = await api(meQuery, T.sA, undefined, 'GET')
  check('T32', '명단 없이: /api/timetable/me 200이고 영어 B 없음(임의 배정 없음)', r.status === 200 && !hasCourse(r.j, 'cEngB'), `${r.status} ${r.j.code || ''} courses=${(r.j.courses || []).length}`)

  // ── stage ──
  r = await api(API, T.tHome, { action: 'stage', schoolCode: S, validFrom: VF, fileName: 'roster.csv', fileHash: HASH, mapping: { grade: 1, classNm: 2, number: 3 }, rows: ROWS })
  check('stage', 'stage 200, 학기 2026-2', r.status === 200 && r.j.batchId && r.j.termId === TERM, `${r.status} ${r.j.code || ''}`)
  const batchId = r.j.batchId
  const rows = Object.fromEntries((r.j.rows || []).map((x) => [x.row, x]))
  const st = r.j.stats || {}
  check('stage', '통계: 전체 9 · 중복 1 · 오류 0', st.total === 9 && st.duplicates === 1 && st.errors === 0, JSON.stringify(st))
  check('T33', '영어 B(분반 명시) → cEngB 하나로 연결', rows[2]?.course?.status === 'matched' && rows[2].course.courseId === 'cEngB')
  check('T33', '분반 없는 영어 → A/B 중 임의로 고르지 않음(ambiguous, section-missing)', rows[3]?.course?.status === 'ambiguous' && rows[3].course.hint === 'section-missing', JSON.stringify(rows[3]?.course))
  check('T33', '동명이인: 3-5 1번 김민수 행의 후보는 3-5 학생(sC), 3-4 1번 행은 sA', rows[4]?.student?.uid === 'sC' && rows[2]?.student?.uid === 'sA')
  check('T33', '같은 과목(수학) 교사 다른 두 수업: 교사 없으면 모호, 교사 있으면 하나', rows[9]?.course?.status === 'ambiguous' && rows[10]?.course?.courseId === 'cMath1')
  check('stage', '미가입 학생 → 후보 없음(미연결 보관 예정)', rows[5]?.student?.status === 'none')
  check('stage', '같은 반 같은 번호 두 명 → 후보로 고르지 않음(ambiguous)', rows[6]?.student?.status === 'ambiguous')
  check('stage', '같은 학생·같은 수업 중복 행 합침', rows[7]?.duplicateOf === 2)
  check('stage', '수업 코드(대소문자 무시) → cEngB', rows[8]?.course?.via === 'code' && rows[8].course.courseId === 'cEngB')
  let enr = await sref.collection('enrollments').get()
  check('T32', 'stage만으로 수강 0건', enr.size === 0, `enrollments=${enr.size}`)

  // ── commit ──
  r = await api(API, T.tHome, { action: 'commit', batchId })
  check('commit', 'commit 200(새 행 8)', r.status === 200 && r.j.result?.created === 8, `${r.status} ${JSON.stringify(r.j.result || r.j)}`)
  r = await api(API, T.tHome, { action: 'commit', batchId })
  check('T28', '같은 commit 재요청 → already, 중복 저장 없음', r.status === 200 && r.j.already === true)
  const entries = await sref.collection('rosterEntries').get()
  check('commit', 'rosterEntries 8건 모두 미연결(linkedUid null)', entries.size === 8 && entries.docs.every((d) => d.get('linkedUid') === null))
  enr = await sref.collection('enrollments').get()
  const rev5 = (await sref.get()).get('scheduleRevision')
  check('T32', 'commit 후에도 수강 0건, scheduleRevision 그대로', enr.size === 0 && rev5 === 5, `enrollments=${enr.size} rev=${rev5}`)
  r = await api(meQuery, T.sA, undefined, 'GET')
  check('T32', '연결 확정 전 /api/timetable/me에 영어 B 없음', r.status === 200 && !hasCourse(r.j, 'cEngB'))
  const audit = await sref.collection('audit').get()
  const auditText = JSON.stringify(audit.docs.map((d) => d.data()))
  check('T46', '감사 기록에 학생 이름·uid 없음', !/김민수|이영희|"sA"|"sB"|"sC"/.test(auditText))

  const entryOf = (row) => entries.docs.find((d) => d.get('row') === row)?.id

  // ── link 권한 ──
  r = await api(API, T.tHome, { action: 'link', entryIds: [entryOf(2)] })
  check('link', 'confirm 없으면 400 confirm-required', r.status === 400 && r.j.code === 'confirm-required')
  r = await api(API, T.tNone, { action: 'link', entryIds: [entryOf(2)], confirm: true })
  check('T40', '담임·담당 아닌 교사의 연결 → 403', r.status === 403 && r.j.code === 'forbidden', `${r.status} ${r.j.code}`)
  r = await api(API, T.tHome, { action: 'link', entryIds: [entryOf(4)], confirm: true })
  check('T40', '3-4 담임이 3-5 학생·남의 수업 행 연결 → 403', r.status === 403, `${r.status} ${r.j.code}`)
  r = await api(API, T.sA, { action: 'link', entryIds: [entryOf(2)], confirm: true })
  check('T39', '학생이 직접 연결 → 403', r.status === 403)

  // ── 담임이 확정 → T32 표시 ──
  r = await api(API, T.tHome, { action: 'link', entryIds: [entryOf(2), entryOf(3), entryOf(5)], confirm: true })
  const res1 = Object.fromEntries((r.j.results || []).map((x) => [x.entryId, x.status]))
  check(
    'link',
    '담임 확정: 2행 linked, 3행 수업 미확인(course-unresolved), 5행 미가입(no-candidate)',
    r.status === 200 && res1[entryOf(2)] === 'linked' && res1[entryOf(3)] === 'course-unresolved' && res1[entryOf(5)] === 'no-candidate' && r.j.revision === 6,
    JSON.stringify(r.j)
  )
  const e1 = await sref.collection('enrollments').doc('cEngB__sA').get()
  check('link', 'enrollments/cEngB__sA active · source roster · from=적용일', e1.exists && e1.get('status') === 'active' && e1.get('source') === 'roster' && e1.get('from') === VF)
  r = await api(meQuery, T.sA, undefined, 'GET')
  check(
    'T32',
    '연결 확정 후 /api/timetable/me에 영어 B와 차시(화 3교시) 표시',
    r.status === 200 && hasCourse(r.j, 'cEngB') && (r.j.series || []).some((s) => s.seriesId === 'srEngB') && r.j.revision === 6,
    `${r.status} rev=${r.j.revision}`
  )
  r = await api(meQuery, T.sC, undefined, 'GET')
  check('T33', '동명이인 sC(3-5 김민수)의 시간표에는 영어 B 없음', r.status === 200 && !hasCourse(r.j, 'cEngB'))
  r = await api(API, T.tHome, { action: 'link', entryIds: [entryOf(2)], confirm: true })
  check('T05', '같은 행 다시 확정 → already-linked, 버전 그대로', r.j.results?.[0]?.status === 'already-linked' && r.j.revision === null)
  r = await api(API, T.tEng, { action: 'link', entryIds: [entryOf(6)], confirm: true })
  check('link', '담당 교사 확정: 같은 번호 두 명이면 연결하지 않음(ambiguous)', r.j.results?.[0]?.status === 'ambiguous', JSON.stringify(r.j))
  check('T33', '3-5 7번 두 학생 모두 영어 B 수강 없음', !(await sref.collection('enrollments').doc('cEngB__sD1').get()).exists && !(await sref.collection('enrollments').doc('cEngB__sD2').get()).exists)

  // ── 나중에 가입·승인 → 담임 목록에서 후보 ──
  r = await api(API, T.tHome, { action: 'list', unlinked: true })
  const l5 = (r.j.entries || []).find((e) => e.row === 5)
  check('list', '담임 미연결 목록: 미가입 5행은 후보 없음', r.status === 200 && l5?.candidate?.status === 'none' && !(r.j.entries || []).some((e) => e.row === 2))
  await createUsers([
    { uid: 'sNew', email: 'snew@im2.test', doc: { role: 'student', status: 'approved', schoolCode: S, classId: `${S}_3_4`, grade: 3, classNm: 4, studentId: '9', name: '새학생' } },
  ])
  r = await api(API, T.tHome, { action: 'list', unlinked: true })
  const l5b = (r.j.entries || []).find((e) => e.row === 5)
  check('list', '가입·승인 후 같은 반·번호 학생이 연결 후보로 보임(이름 다르면 경고만)', l5b?.candidate?.uid === 'sNew' && l5b.candidate.nameMatches === false && l5b.canLink === true, JSON.stringify(l5b?.candidate))
  r = await api(API, T.tNone, { action: 'list', unlinked: true })
  check('T39', '담임·담당 없는 교사의 목록은 비어 있음', r.status === 200 && (r.j.entries || []).length === 0)

  // ── T30: 같은 파일 재업로드 ──
  r = await api(API, T.tHome, { action: 'stage', schoolCode: S, validFrom: VF, fileName: 'roster.csv', fileHash: HASH, rows: ROWS })
  check('T30', '같은 파일 재업로드: same-file 안내, 이미 연결 1·기존 7', r.status === 200 && (r.j.issues || []).some((i) => i.code === 'same-file') && r.j.stats?.alreadyLinked === 1 && r.j.stats?.existing === 7, JSON.stringify(r.j.stats))
  r = await api(API, T.tHome, { action: 'commit', batchId: r.j.batchId })
  const entries2 = await sref.collection('rosterEntries').get()
  check('T30', '재반영: 새 행 0 · 갱신 8 · 연결 유지', r.j.result?.created === 0 && r.j.result?.updated === 8 && entries2.size === 8 && entries2.docs.filter((d) => d.get('linkedUid')).length === 1)

  // ── [검토 결함] 수업 코드·분반 접두어 표기로 가져온 수업과 연결 ──
  {
    const extra = [
      { row: 2, grade: 3, classNm: 4, number: 11, courseCode: 'SCI-9', subject: '생활과 과학', section: 'A' }, // 코드 없이 가져온 수업 → 과목·분반으로
      { row: 3, grade: 3, classNm: 4, number: 12, subject: 'A_영어' }, // 분반 열 없음 + 접두어 → 영어 A
      { row: 4, grade: 3, classNm: 4, number: 13, subject: 'A_영어', section: 'B' }, // 분반 열과 접두어가 다름 → 검토
      { row: 5, grade: 3, classNm: 4, number: 14, courseCode: 'ＥＮＧ－Ｂ' }, // 전각 코드 → 가져오기 코드(NFKC 정리)와 같게
      { row: 6, grade: 3, classNm: 4, number: 15, courseCode: 'ENG-B', subject: '영어', section: 'A' }, // 코드로 찾으면 코드가 우선
      { row: 7, grade: 3, classNm: 4, number: 16, subject: 'A_영어', section: 'A' }, // 분반 열과 접두어가 같음 → 영어 A
      { row: 8, grade: 3, classNm: 4, number: 17, courseCode: 'NO-SUCH' }, // 코드만 있고 못 찾음 → 미확인(추정하지 않음)
    ]
    r = await api(API, T.tHome, { action: 'stage', schoolCode: S, validFrom: VF, fileName: 'roster-code.csv', fileHash: 'c'.repeat(64), rows: extra })
    const xr = Object.fromEntries((r.j.rows || []).map((x) => [x.row, x]))
    check('code', "가져오기 코드 수업(importKey 'code|ENG-B')을 명단 코드로 찾음(전각 표기도 같게)", r.status === 200 && xr[5]?.course?.status === 'matched' && xr[5].course.courseId === 'cEngB' && xr[5].course.via === 'code', JSON.stringify(xr[5]?.course))
    check('code', '코드로 못 찾으면(코드 없이 가져온 수업) 과목·분반으로 다시 찾음', xr[2]?.course?.status === 'matched' && xr[2].course.courseId === 'cSci' && xr[2].course.via === 'subject', JSON.stringify(xr[2]?.course))
    check('code', '코드로 찾은 수업이 있으면 과목·분반보다 코드 우선', xr[6]?.course?.courseId === 'cEngB' && xr[6].course.via === 'code', JSON.stringify(xr[6]?.course))
    check('code', '코드만 있고 못 찾으면 미확인(not-found) — 추정하지 않음', xr[8]?.course?.status === 'not-found' && xr[8].course.via === 'code', JSON.stringify(xr[8]?.course))
    check('prefix', "분반 열 없이 'A_영어' → 영어 A 수업(cEngA)", xr[3]?.course?.status === 'matched' && xr[3].course.courseId === 'cEngA', JSON.stringify(xr[3]?.course))
    check('prefix', "분반 열과 접두어가 같음('A_영어' + A) → 영어 A", xr[7]?.course?.courseId === 'cEngA', JSON.stringify(xr[7]?.course))
    check('prefix', "분반 열(B)과 접두어(A)가 다르면 고르지 않음(ambiguous, section-mismatch)", xr[4]?.course?.status === 'ambiguous' && xr[4].course.hint === 'section-mismatch' && !xr[4].course.courseId, JSON.stringify(xr[4]?.course))
    r = await api(API, T.tHome, { action: 'cancel', batchId: r.j.batchId })
    check('code', '확인용 묶음 취소', r.status === 200 && r.j.status === 'cancelled')
  }

  // ── 취소·다른 학교 ──
  r = await api(API, T.tHome, { action: 'stage', schoolCode: S, validFrom: VF, fileHash: 'b'.repeat(64), rows: ROWS.slice(0, 1) })
  const b3 = r.j.batchId
  r = await api(API, T.tHome, { action: 'cancel', batchId: b3 })
  check('cancel', 'staged 취소', r.status === 200 && r.j.status === 'cancelled')
  r = await api(API, T.tHome, { action: 'commit', batchId: b3 })
  check('cancel', '취소한 묶음 commit → 409 batch-cancelled', r.status === 409 && r.j.code === 'batch-cancelled')
  r = await api(API, T.tOther, { action: 'preview', batchId })
  check('T39', '다른 학교 교사는 S1 묶음을 찾을 수 없음(404)', r.status === 404 && r.j.code === 'batch-not-found')
  note('T32', '화면(/teacher/roster-import) 흐름은 격리 하네스(Playwright)로 따로 확인 — 이 파일은 API만')
} catch (e) {
  check('fatal', '테스트 실행 중 예외', false, String(e?.stack || e).slice(0, 500))
}

const failed = finish()
process.exit(failed ? 1 : 0)
