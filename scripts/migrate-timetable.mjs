#!/usr/bin/env node
// 기존 데이터 → 개인 시간표 모델 전환 (docs/classmate-timetable-migration.md)
//
// 기본은 dry-run(읽기만)입니다. 실제 적용은 --apply가 필요하고, 에뮬레이터가 아닌 프로젝트에는
// --project <id> --confirm-production <id> 를 모두 줘야만 씁니다(운영 적용은 별도 승인 후에만).
//
// 사용 예 (로컬 에뮬레이터):
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/migrate-timetable.mjs --project demo-classmate            # dry-run 보고서
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/migrate-timetable.mjs --project demo-classmate --apply    # 적용 + 실행 로그
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/migrate-timetable.mjs --project demo-classmate --rollback migration-log-XXXX.json
//
// 하는 일 (모두 결정적 id → 중간에 멈춘 뒤 다시 실행해도 중복 생성 없음)
//  1. 수업 그룹(classes/{학급}_g_{x}) → 수업반 courses/lg_{groupId} (legacyGroupId 연결, 검토 필요 표시, 학생 공개 목록 비노출)
//  2. 그 그룹에 참여한 학생(extraClassIds) + 그룹을 소속처럼 가진 학생(classId) → 수강 enrollments (source 'legacy-group')
//     ※ 소속 학급(users.classId)은 바꾸지 않습니다. 그룹이 소속처럼 저장된 학생은 '소속 확인 필요'로 보고만 합니다.
//  3. 학급 시간표(info/timetable)·학교 마스터는 공통 수업으로 '자동 전환하지 않고' 학급 목록(담임 uid 포함)만 보고합니다.
//     공통 수업은 담임이 교사 화면의 '학급 시간표 → 공통 수업으로 연결'(POST /api/courses fromHomeroomTimetable)에서
//     직접 확인해야 만들어집니다. 이 스크립트는 담임 확인을 대신하지 않습니다.
//  4. 예전 하루 변경(classes/{id}/overrides/{ymd})은 옮기지 않고 개수만 보고합니다(학급 시간표 참고 보기에서 계속 사용).
//
// 복구(--rollback 로그): 이 실행이 만든 문서 중 이후 수정되지 않은 것만 지웁니다(수강 먼저, 수업은 나중에).
//  수업은 그 뒤 생긴 차시·변경·수강·명단 연결·초대가 가리키면 남기고 skippedCourses(has-dependents)로 보고합니다.
//  지운 문서가 있는 학교는 scheduleRevision +1(열려 있는 학생 화면이 다시 받음).
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(ROOT, 'package.json'))
const { initializeApp } = require('firebase-admin/app')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const project = opt('--project')
const apply = flag('--apply')
const rollbackLog = opt('--rollback')
const confirmProd = opt('--confirm-production')
const onlySchool = opt('--school')
const emulator = !!process.env.FIRESTORE_EMULATOR_HOST

if (flag('--homeroom-common')) {
  console.error('--homeroom-common 은 없어졌습니다. 공통 수업은 담임이 교사 화면(학급 시간표 → 공통 수업으로 연결)에서 확인해야 만들어집니다.')
  process.exit(2)
}
if (!project) {
  console.error('--project <firebase project id> 가 필요합니다')
  process.exit(2)
}
if ((apply || rollbackLog) && !emulator && confirmProd !== project) {
  console.error('에뮬레이터가 아닌 프로젝트에 쓰려면 --confirm-production <같은 project id> 가 필요합니다(운영 적용은 별도 승인 후에만).')
  process.exit(2)
}

initializeApp({ projectId: project })
const db = getFirestore()
const GROUP_RE = /_g_[A-Za-z0-9]+$/

function kstYmd(ms = Date.now()) {
  const d = new Date(ms + 9 * 3600 * 1000)
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}
function defaultTermId(ymd) {
  const y = Number(ymd.slice(0, 4))
  const md = ymd.slice(4)
  if (md >= '0301' && md < '0816') return { termId: `${y}-1` }
  const ay = md < '0301' ? y - 1 : y
  return { termId: `${ay}-2` }
}

const COURSE_PATH_RE = /^schools\/([^/]+)\/courses\/([^/]+)$/

/**
 * 수업을 가리키는 다른 문서 종류(있으면 수업을 지우지 않음).
 * 전환 뒤 담당 교사가 등록한 차시·변경, 그룹 QR·초대·명단으로 새로 생긴 수강, 발급한 초대 등은 수업 문서 자체를
 * 고치지 않아(updatedAt·revision 그대로) 예전에는 함께 지워져 없는 수업을 가리키게 됐습니다.
 * 수강은 이 함수 전에 이 실행이 만든 것부터 지우므로, 여기서 보이는 수강은 로그 밖(또는 이후 수정돼 남긴) 수강입니다.
 * 학생 uid는 돌려주지 않습니다(종류만).
 */
async function courseDependents(schoolCode, courseId) {
  const sref = db.collection('schools').doc(schoolCode)
  const probes = [
    ['series', sref.collection('series').where('courseId', '==', courseId)],
    ['overrides', sref.collection('overrides').where('courseId', '==', courseId)],
    ['enrollments', sref.collection('enrollments').where('courseId', '==', courseId)],
    ['rosterEntries', sref.collection('rosterEntries').where('courseId', '==', courseId)],
    ['changeSets', sref.collection('changeSets').where('affectedCourseIds', 'array-contains', courseId)],
  ]
  const found = []
  for (const [kind, q] of probes) {
    if (!(await q.limit(1).get()).empty) found.push(kind)
  }
  // 초대는 학교 밖 컬렉션(invitations/{code}) — 같은 학교의 수업 초대만(회수·만료된 것도 수업을 가리키므로 셈)
  const inv = await db.collection('invitations').where('targetId', '==', courseId).limit(50).get()
  if (inv.docs.some((d) => d.get('type') === 'course' && String(d.get('schoolCode') || '') === schoolCode)) found.push('invitations')
  return found
}

async function rollback(file) {
  const log = JSON.parse(fs.readFileSync(file, 'utf8'))
  const paths = (log.created || []).map((w) => String((w && w.path) || '')).filter(Boolean)
  // 수강(수업이 아닌 문서)을 먼저, 수업은 나중에 — 이 실행이 만든 수강이 수업의 '다른 참조'로 세어지지 않게
  const ordered = [...paths.filter((p) => !COURSE_PATH_RE.test(p)), ...paths.filter((p) => COURSE_PATH_RE.test(p))]
  let deleted = 0
  let skipped = 0
  const skippedCourses = [] // {path, reason, dependents?} — 수업 경로만(수강 경로에는 학생 uid가 들어 있어 보고하지 않음)
  const changedSchools = new Set()
  for (const p of ordered) {
    const ref = db.doc(p)
    const snap = await ref.get()
    if (!snap.exists) continue
    const m = COURSE_PATH_RE.exec(p)
    // 전환 뒤에 다른 사람이 고친 문서(서버 API가 updatedAt을 남김)는 지우지 않음(이후 정상 수정 보호)
    if (snap.get('migrationRunId') !== log.runId || snap.get('updatedAt') != null || Number(snap.get('revision') || 0) > 0) {
      skipped++
      if (m) skippedCourses.push({ path: p, reason: 'modified' })
      continue
    }
    if (m) {
      // 이후 연결된 차시·수강·변경·초대가 있으면 수업을 남김(지우면 참조가 끊겨 학생 시간표에서 수업이 사라짐)
      const dependents = await courseDependents(m[1], m[2])
      if (dependents.length) {
        skipped++
        skippedCourses.push({ path: p, reason: 'has-dependents', dependents })
        continue
      }
    }
    await ref.delete()
    deleted++
    changedSchools.add(p.split('/')[1])
  }
  // 학생 화면 갱신 신호(적용 때와 같음) — 지운 문서가 있는 학교만
  for (const s of changedSchools) {
    await db.collection('schools').doc(s).set({ scheduleRevision: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  }
  console.log(JSON.stringify({ rollback: file, deleted, skipped, skippedCourses, revisionBumped: Array.from(changedSchools) }, null, 2))
}

async function plan() {
  const runId = `mig_${Date.now()}`
  const today = kstYmd()
  // 학교별 학기: schools/{s}/terms 문서가 오늘을 포함하면 그 학기, 없으면 기본 규칙(src/lib/timetable/server.ts defaultTermFor와 같음)
  const termCache = new Map()
  const termIdFor = async (schoolCode) => {
    if (termCache.has(schoolCode)) return termCache.get(schoolCode)
    const snap = await db.collection('schools').doc(schoolCode).collection('terms').get()
    const hit = snap.docs.find((d) => {
      const t = d.data() || {}
      return typeof t.startDate === 'string' && typeof t.endDate === 'string' && today >= t.startDate && today < t.endDate
    })
    const termId = hit ? hit.id : defaultTermId(today).termId
    termCache.set(schoolCode, termId)
    return termId
  }
  const report = {
    runId,
    mode: apply ? 'apply' : 'dry-run',
    project,
    emulator,
    generatedAt: new Date().toISOString(),
    schools: {},
    groupsToCourses: 0,
    enrollmentsToCreate: 0,
    alreadyMigrated: 0,
    studentsWithGroupAsHomeroom: 0,
    homeroomsWithClassTimetable: 0,
    legacyOverrideDays: 0,
    unclassified: [],
    issues: [],
  }
  const writes = [] // {path, data}

  const classes = await db.collection('classes').get()
  const groups = classes.docs.filter((d) => GROUP_RE.test(d.id) || d.get('isGroup') === true)
  const homerooms = classes.docs.filter((d) => !GROUP_RE.test(d.id) && d.get('isGroup') !== true)

  for (const g of groups) {
    const data = g.data()
    const schoolCode = String(data.schoolCode || g.id.split('_')[0] || '')
    if (onlySchool && schoolCode !== onlySchool) continue
    if (!schoolCode) {
      report.issues.push({ kind: 'group-without-school', id: g.id })
      continue
    }
    report.schools[schoolCode] ||= { groups: 0, enrollments: 0 }
    const termId = await termIdFor(schoolCode)
    const courseId = `lg_${g.id}`
    const courseRef = db.collection('schools').doc(schoolCode).collection('courses').doc(courseId)
    const exists = (await courseRef.get()).exists
    if (exists) report.alreadyMigrated++
    else {
      const label = data.grade && data.classNm ? `${data.grade}학년 ${data.classNm}반 수업` : '수업 그룹'
      writes.push({
        path: courseRef.path,
        data: {
          schoolCode,
          termId,
          title: data.subjectName ? String(data.subjectName) : `${label}${data.teacherName ? ` (${data.teacherName})` : ''}`,
          subject: data.subjectName ? String(data.subjectName) : '',
          teacherUids: data.teacherId ? [String(data.teacherId)] : [],
          teacherNames: data.teacherName ? [String(data.teacherName)] : [],
          status: 'active',
          commonForHomerooms: [],
          invitePolicy: 'auto',
          catalogVisible: false,
          legacyGroupId: g.id,
          needsReview: true, // 과목명·요일·교시가 없어 담당 교사가 확인·차시 등록 필요
          source: 'legacy-group',
          revision: 0,
          migrationRunId: runId,
        },
      })
      report.groupsToCourses++
      report.schools[schoolCode].groups++
    }
    // 참여 학생
    const [extra, home] = await Promise.all([
      db.collection('users').where('extraClassIds', 'array-contains', g.id).get(),
      db.collection('users').where('classId', '==', g.id).get(),
    ])
    const members = new Map()
    extra.forEach((u) => {
      if (u.get('role') === 'student' && u.get('status') === 'approved') members.set(u.id, 'extra')
    })
    home.forEach((u) => {
      if (u.get('role') !== 'student') return
      report.studentsWithGroupAsHomeroom++
      report.unclassified.push({ kind: 'group-as-homeroom', uid: u.id, groupId: g.id, status: u.get('status') || null })
      if (u.get('status') === 'approved') members.set(u.id, 'home')
    })
    for (const uid of members.keys()) {
      const eref = db.collection('schools').doc(schoolCode).collection('enrollments').doc(`${courseId}__${uid}`)
      if ((await eref.get()).exists) {
        report.alreadyMigrated++
        continue
      }
      writes.push({
        path: eref.path,
        data: { courseId, uid, schoolCode, termId, status: 'active', from: null, to: null, source: 'legacy-group', revision: 0, migrationRunId: runId },
      })
      report.enrollmentsToCreate++
      report.schools[schoolCode].enrollments++
    }
  }

  for (const h of homerooms) {
    const schoolCode = String(h.get('schoolCode') || h.id.split('_')[0] || '')
    if (onlySchool && schoolCode !== onlySchool) continue
    const tt = await h.ref.collection('info').doc('timetable').get()
    const ov = await h.ref.collection('overrides').count().get()
    report.legacyOverrideDays += ov.data().count
    if (!tt.exists) continue
    report.homeroomsWithClassTimetable++
    report.unclassified.push({
      kind: 'homeroom-timetable-not-common',
      classId: h.id,
      teacherUid: h.get('teacherId') || null,
      note: '담임이 교사 화면에서 "우리 반 학생 모두 같은 수업"을 확인하면 공통 수업으로 연결됨(자동 전환 안 함)',
    })
  }
  return { report, writes }
}

async function main() {
  if (rollbackLog) {
    await rollback(rollbackLog)
    return
  }
  const { report, writes } = await plan()
  report.writes = writes.length
  if (!apply) {
    const out = path.join(process.cwd(), `migration-dryrun-${report.runId}.json`)
    fs.writeFileSync(out, JSON.stringify({ report, writes: writes.map((w) => w.path) }, null, 2))
    console.log(JSON.stringify({ ...report, unclassified: report.unclassified.length, writePaths: writes.length, reportFile: out }, null, 2))
    return
  }
  const logFile = path.join(process.cwd(), `migration-log-${report.runId}.json`)
  const log = { runId: report.runId, project, startedAt: new Date().toISOString(), created: [], done: false }
  fs.writeFileSync(logFile, JSON.stringify(log, null, 2))
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch()
    for (const w of writes.slice(i, i + 400)) {
      batch.set(db.doc(w.path), { ...w.data, createdAt: FieldValue.serverTimestamp() }, { merge: true })
      log.created.push({ path: w.path })
    }
    await batch.commit()
    fs.writeFileSync(logFile, JSON.stringify(log, null, 2)) // 중간 실패 시에도 어디까지 썼는지 남김
  }
  // 학생 화면 갱신 신호
  const schools = new Set(writes.map((w) => w.path.split('/')[1]))
  for (const s of schools) {
    await db.collection('schools').doc(s).set({ scheduleRevision: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  }
  log.done = true
  log.finishedAt = new Date().toISOString()
  fs.writeFileSync(logFile, JSON.stringify(log, null, 2))
  console.log(JSON.stringify({ ...report, unclassified: report.unclassified.length, logFile }, null, 2))
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('migration failed:', e?.message || e)
    process.exit(1)
  }
)
