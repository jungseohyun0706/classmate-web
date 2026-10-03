// T41 데이터 전환: dry-run → 적용 → 중단 후 재실행 → 복구 (로컬 에뮬레이터 전용, 가상 데이터)
// 사용: node tests/e2e/migration.test.mjs   (에뮬레이터 8080/9099 필요, 서버 불필요)
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { admin, wipe, createUsers, reporter, Timestamp, ROOT } from './lib/env.mjs'

const { check, note, finish, OUT } = reporter('migration')
const run = (...args) =>
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/migrate-timetable.mjs'), '--project', 'demo-classmate', ...args], {
    cwd: OUT,
    env: { ...process.env },
    encoding: 'utf8',
  })
const lastJson = (out) => JSON.parse(out.slice(out.indexOf('{')))

const school = { schoolCode: 'S1', schoolName: '테스트고등학교', officeCode: 'B10' }
await wipe()
await createUsers([
  { uid: 'hr', email: 'hr@m.kr', doc: { role: 'teacher', name: '김담임', classId: 'S1_3_4', grade: 3, classNm: 4, ...school } },
  { uid: 'eng', email: 'eng@m.kr', doc: { role: 'teacher', name: '이영어', teachingClassIds: ['S1_3_5_g_eng001'], ...school } },
  { uid: 'stuA', email: 'a@m.kr', doc: { role: 'student', status: 'approved', name: '학생A', studentId: '7', classId: 'S1_3_4', grade: 3, classNm: 4, extraClassIds: ['S1_3_5_g_eng001'], ...school } },
  { uid: 'stuG', email: 'g@m.kr', doc: { role: 'student', status: 'approved', name: '학생G', classId: 'S1_3_5_g_eng001', grade: null, classNm: null, ...school } },
])
const { db } = admin()
await db.doc('classes/S1_3_4').set({ classId: 'S1_3_4', grade: 3, classNm: 4, teacherId: 'hr', ...school, createdAt: Timestamp.now() })
await db.doc('classes/S1_3_5_g_eng001').set({ classId: 'S1_3_5_g_eng001', isGroup: true, grade: 3, classNm: 5, teacherId: 'eng', teacherName: '이영어', ...school })
await db.doc('classes/S1_3_4/info/timetable').set({ mon: ['국어', '수학'], tue: ['영어'], wed: [], thu: [], fri: [] })
await db.doc('classes/S1_3_4/overrides/20261006').set({ periods: { 1: { subject: '수학(김OO 선생님)' } } })
// 공지·톡방 데이터(전환 후 그대로여야 함)
await db.doc('classes/S1_3_4/announcements/N1').set({ title: '공지', body: '본문', authorId: 'hr', createdAt: Timestamp.now() })

// 1) dry-run: 쓰지 않음
let out = run()
let rep = lastJson(out)
check('T41.1', 'dry-run은 아무것도 쓰지 않음', (await db.collection('schools/S1/courses').get()).empty && rep.mode === 'dry-run', JSON.stringify({ groups: rep.groupsToCourses, enroll: rep.enrollmentsToCreate }))
check('T41.2', 'dry-run 보고: 그룹 1→수업, 수강 2(추가 참여 1 + 그룹 소속 1), 소속 확인 필요 1, 공통 수업 미지정 학급 1, 예전 변경 1일',
  rep.groupsToCourses === 1 && rep.enrollmentsToCreate === 2 && rep.studentsWithGroupAsHomeroom === 1 && rep.homeroomsWithClassTimetable === 1 && rep.legacyOverrideDays === 1,
  JSON.stringify(rep))

// 2) 중간 실패 흉내: 수강 하나를 미리 만들어 둔 상태(앞선 실행이 일부만 쓰고 멈춤)에서 적용
await db.doc('schools/S1/enrollments/lg_S1_3_5_g_eng001__stuA').set({ courseId: 'lg_S1_3_5_g_eng001', uid: 'stuA', status: 'active', source: 'legacy-group' })
out = run('--apply')
rep = lastJson(out)
const logFile1 = rep.logFile
const log1 = JSON.parse(fs.readFileSync(logFile1, 'utf8'))
const enr = await db.collection('schools/S1/enrollments').get()
check('T41.3', '적용: 수업 1, 수강 2(이미 있던 것 중복 생성 없음)', (await db.collection('schools/S1/courses').get()).size === 1 && enr.size === 2, `courses/enrollments=${enr.size} alreadyMigrated=${rep.alreadyMigrated}`)
const g = (await db.doc('users/stuG').get()).data()
check('T41.4', '그룹이 소속처럼 저장된 학생의 소속(classId)은 바꾸지 않음', g.classId === 'S1_3_5_g_eng001')
check('T41.5', '학급 시간표는 확인 없이 공통 수업으로 바꾸지 않음', !(await db.collection('schools/S1/courses').get()).docs.some((d) => d.id.startsWith('hc_')))
check('T41.6', '공지는 그대로', (await db.doc('classes/S1_3_4/announcements/N1').get()).exists)

// 3) 재실행: 새로 쓰는 문서 0
out = run('--apply')
rep = lastJson(out)
check('T41.7', '재실행해도 중복 생성 없음', rep.writes === 0, `writes=${rep.writes}`)

// 4) 학급 시간표 → 공통 수업은 스크립트로 만들 수 없음(담임이 교사 화면에서 확인해야 함)
let refused = false
try {
  run('--apply', '--homeroom-common', 'S1_3_4')
} catch (e) {
  refused = e.status === 2
}
const hc = (await db.collection('schools/S1/courses').get()).docs.filter((d) => d.id.startsWith('hc_'))
const unclassified = JSON.parse(fs.readFileSync(path.join(OUT, fs.readdirSync(OUT).filter((f) => f.startsWith('migration-dryrun-')).sort().pop()), 'utf8')).report.unclassified
check('T41.8', '담임 확인 없는 공통 수업 생성 옵션은 거부, 학급 시간표 학급은 담임 uid와 함께 보고', refused && hc.length === 0 && unclassified.some((u) => u.kind === 'homeroom-timetable-not-common' && u.classId === 'S1_3_4' && u.teacherUid === 'hr'), `refused=${refused} hc=${hc.length}`)

// 5) 복구: 이후 수정된 문서는 남기고, 이 실행이 만든 것만 지움
const courseRef = db.doc('schools/S1/courses/lg_S1_3_5_g_eng001')
await courseRef.set({ updatedAt: Timestamp.now(), title: '영어 B(수정)' }, { merge: true })
out = run('--rollback', logFile1)
const rb = lastJson(out)
const enrAfter = (await db.collection('schools/S1/enrollments').get()).docs.map((d) => d.id).sort()
check('T41.9', '복구: 이 실행이 만든 수강만 삭제, 이후 수정된 수업과 실행 전부터 있던 수강은 보존',
  (await courseRef.get()).exists && enrAfter.length === 1 && enrAfter[0] === 'lg_S1_3_5_g_eng001__stuA' && rb.skipped >= 1,
  JSON.stringify({ rb, enrAfter }))
note('T41.log', `첫 적용 로그 ${log1.runId} 문서 ${log1.created.length}건`)
const revOf = async () => Number((await db.doc('schools/S1').get()).get('scheduleRevision') || 0)
check('T41.9b', '복구 보고: 수정돼 남긴 수업은 modified, 학생 uid 없음(수업 경로·사유만)', !/stu[A-Z]/.test(JSON.stringify(rb)) && Array.isArray(rb.skippedCourses) && rb.skippedCourses.some((c) => c.reason === 'modified'), JSON.stringify(rb.skippedCourses))

// 6) 복구 회귀: 전환 뒤 차시·새 수강·초대가 연결된 lg_ 수업은 지우지 않음(참조 끊김 방지), 연결 없는 수업만 지움, 학교 revision +1
await createUsers([
  { uid: 'stuM', email: 'm@m.kr', doc: { role: 'student', status: 'approved', name: '학생M', classId: 'S1_3_4', grade: 3, classNm: 4, extraClassIds: ['S1_3_6_g_mat001'], ...school } },
  { uid: 'stuN', email: 'n@m.kr', doc: { role: 'student', status: 'approved', name: '학생N', classId: 'S1_3_4', grade: 3, classNm: 4, ...school } },
  { uid: 'stuS', email: 's@m.kr', doc: { role: 'student', status: 'approved', name: '학생S', classId: 'S1_3_4', grade: 3, classNm: 4, extraClassIds: ['S1_3_7_g_sci001'], ...school } },
  { uid: 'stuR', email: 'r@m.kr', doc: { role: 'student', status: 'approved', name: '학생R', classId: 'S1_3_4', grade: 3, classNm: 4, extraClassIds: ['S1_3_8_g_art001'], ...school } },
])
for (const [gid, cn] of [['S1_3_6_g_mat001', 6], ['S1_3_7_g_sci001', 7], ['S1_3_8_g_art001', 8]]) {
  await db.doc(`classes/${gid}`).set({ classId: gid, isGroup: true, grade: 3, classNm: cn, teacherId: 'eng', teacherName: '이영어', ...school })
}
out = run('--apply')
const rep2 = lastJson(out)
const log2 = JSON.parse(fs.readFileSync(rep2.logFile, 'utf8'))
const C = (gid) => db.doc(`schools/S1/courses/lg_${gid}`)
check('T41.10', '두 번째 적용: 새 그룹 3개 → 수업 3개(+ 각 수강)', rep2.groupsToCourses === 3 && (await C('S1_3_6_g_mat001').get()).exists && (await C('S1_3_8_g_art001').get()).exists, `groups=${rep2.groupsToCourses} writes=${rep2.writes}`)
// 전환 뒤 실제 사용: 수학 그룹 수업에 담당 교사 차시 등록 + 그룹 QR로 새 학생 수강(둘 다 수업 문서는 고치지 않음),
// 과학 그룹 수업에는 수업 초대 발급. 미술 그룹 수업은 아무도 쓰지 않음.
await db.doc('schools/S1/series/ser_mat1').set({ courseId: 'lg_S1_3_6_g_mat001', termId: '2026-2', weekday: 2, period: 3, status: 'active', createdAt: Timestamp.now() })
await db.doc('schools/S1/enrollments/lg_S1_3_6_g_mat001__stuN').set({ courseId: 'lg_S1_3_6_g_mat001', uid: 'stuN', schoolCode: 'S1', status: 'active', source: 'invite', via: 'group-qr', createdAt: Timestamp.now(), updatedAt: Timestamp.now() })
await db.doc('invitations/MIGTEST2').set({ type: 'course', targetId: 'lg_S1_3_7_g_sci001', schoolCode: 'S1', revoked: false, uses: 0, maxUses: null, createdAt: Timestamp.now() })
const revBeforeRb2 = await revOf()
out = run('--rollback', rep2.logFile)
const rb2 = lastJson(out)
const skippedOf = (gid) => (rb2.skippedCourses || []).find((c) => c.path === `schools/S1/courses/lg_${gid}`)
const matSkip = skippedOf('S1_3_6_g_mat001')
const sciSkip = skippedOf('S1_3_7_g_sci001')
check('T41.11', '복구: 차시·새 수강이 연결된 수업은 남기고 has-dependents로 보고(차시·새 수강도 그대로)',
  (await C('S1_3_6_g_mat001').get()).exists && matSkip?.reason === 'has-dependents' && matSkip.dependents.includes('series') && matSkip.dependents.includes('enrollments') &&
    (await db.doc('schools/S1/series/ser_mat1').get()).exists && (await db.doc('schools/S1/enrollments/lg_S1_3_6_g_mat001__stuN').get()).exists,
  JSON.stringify(matSkip))
check('T41.12', '복구: 초대가 가리키는 수업도 남김(초대가 없는 수업을 가리키지 않게)', (await C('S1_3_7_g_sci001').get()).exists && sciSkip?.reason === 'has-dependents' && sciSkip.dependents.includes('invitations'), JSON.stringify(sciSkip))
check('T41.13', '복구: 연결 없는 수업과 이 실행이 만든 수강은 지움(이 실행 로그의 수강은 의존으로 세지 않음)',
  !(await C('S1_3_8_g_art001').get()).exists && !(await db.doc('schools/S1/enrollments/lg_S1_3_8_g_art001__stuR').get()).exists &&
    !(await db.doc('schools/S1/enrollments/lg_S1_3_6_g_mat001__stuM').get()).exists && !(await db.doc('schools/S1/enrollments/lg_S1_3_7_g_sci001__stuS').get()).exists,
  JSON.stringify({ deleted: rb2.deleted, skipped: rb2.skipped }))
const revAfterRb2 = await revOf()
check('T41.14', '복구 뒤 바뀐 학교 scheduleRevision +1(열려 있는 학생 화면 갱신)', revAfterRb2 === revBeforeRb2 + 1 && (rb2.revisionBumped || []).includes('S1'), `${revBeforeRb2} → ${revAfterRb2}`)
check('T41.15', '복구 보고에 학생 uid 없음', !/stu[A-Z]/.test(JSON.stringify(rb2)), '')
note('T41.log2', `두 번째 적용 로그 ${log2.runId} 문서 ${log2.created.length}건, 복구 삭제 ${rb2.deleted}·보류 ${rb2.skipped}`)

process.exit(finish() ? 1 : 0)
