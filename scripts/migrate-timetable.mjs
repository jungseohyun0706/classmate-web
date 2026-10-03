#!/usr/bin/env node
// 기존 데이터 → 개인 시간표 모델 전환 (docs/classmate-timetable-migration.md)
//
// 기본은 dry-run(읽기만)입니다. 실제 적용·복구는 --apply / --rollback 이 필요하고, 에뮬레이터가 아닌 프로젝트에는
// --project <id> --confirm-production <id> 를 모두 줘야만 씁니다(운영 적용은 별도 승인 후에만).
//
// 자격 증명(운영): 앱의 .env(FIREBASE_SERVICE_ACCOUNT_JSON*)를 읽지 않고 Application Default Credentials를 씁니다.
//   gcloud auth application-default login                      # 프로젝트 권한이 있는 계정(권장)
//   export GOOGLE_APPLICATION_CREDENTIALS=<저장소 밖의 키 파일>   # 또는 서비스 계정 키
//
// 사용 예 (로컬 에뮬레이터):
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/migrate-timetable.mjs --project demo-classmate            # dry-run 보고서
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/migrate-timetable.mjs --project demo-classmate --apply    # 적용 + 실행 로그
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/migrate-timetable.mjs --project demo-classmate --rollback migration-log-*.json
// 옵션: --school <schoolCode> 한 학교만. 값이 비었거나(셸 변수가 비어 사라진 경우 포함) 모르는 인자가 있으면 실행하지 않습니다
//  (조용히 전체 학교로 넓어지지 않게).
//
// 하는 일 (모두 결정적 id → 중간에 멈춘 뒤 다시 실행해도 중복 생성 없음)
//  1. 수업 그룹(classes/{학급}_g_{x}) → 수업반 courses/lg_{groupId} (legacyGroupId 연결, 검토 필요 표시, 학생 공개 목록 비노출)
//     ※ 담당 교사가 수업 반 목록(users.teachingClassIds)에서 뺀 그룹·교사 계정이 없는 그룹은 만들지 않고
//       issues(group-not-in-teacher-list)로 보고만 합니다. 예전 그룹에는 학기 정보가 없어 지난 학기 그룹은 따로 가려낼 수 없습니다.
//  2. 그 그룹에 참여한 학생(extraClassIds) + 그룹을 소속처럼 가진 학생(classId) → 수강 enrollments (source 'legacy-group')
//     ※ 소속 학급(users.classId)은 바꾸지 않습니다. 그룹이 소속처럼 저장된 학생은 '소속 확인 필요'로 보고만 합니다.
//  3. 학급 시간표(info/timetable)·학교 마스터는 공통 수업으로 '자동 전환하지 않고' 학급 목록(담임 uid 포함)만 보고합니다.
//     공통 수업은 담임이 교사 화면의 '학급 시간표 → 공통 수업으로 연결'(POST /api/courses fromHomeroomTimetable)에서
//     직접 확인해야 만들어집니다. 이 스크립트는 담임 확인을 대신하지 않습니다.
//  4. 예전 하루 변경(classes/{id}/overrides/{ymd})은 옮기지 않고 개수만 보고합니다(학급 시간표 참고 보기에서 계속 사용).
//
// 복구(--rollback 로그 [로그 ...]): 주어진 실행들이 만든 문서 중 이후 수정되지 않은 것만 지웁니다.
//  수업마다 먼저 남길지 정합니다 — 이후 수정됐거나(modified·other-run) 그 뒤 생긴 차시·변경·수강·명단 연결·초대가 가리키면
//  남기고 skippedCourses로 보고하며, 남기는 수업의 수강도 지우지 않습니다(keptEnrollments). 그다음 수강, 마지막에 수업을 지웁니다.
//  실패 뒤 다시 실행하면 실행마다 runId·로그가 따로 생기므로 되돌릴 때는 그 로그를 모두 한 번에 줍니다(migration-log-*.json).
//  --school 을 주면 로그 중 그 학교 문서만 되돌립니다(로그에 그 학교가 없으면 거부).
//  지운 문서가 있는 학교는 scheduleRevision +1(열려 있는 학생 화면이 다시 받음).
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const SCRIPT = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SCRIPT), '..')

const argv = process.argv.slice(2)
const fail = (msg) => {
  console.error(msg)
  process.exit(2)
}

if (argv.includes('--homeroom-common')) {
  fail('--homeroom-common 은 없어졌습니다. 공통 수업은 담임이 교사 화면(학급 시간표 → 공통 수업으로 연결)에서 확인해야 만들어집니다.')
}

// 인자 해석 — 값이 필요한 옵션 뒤에 값이 없거나 다음 옵션이 오면, 모르는 인자가 있으면 거부
const VALUE_OPTS = new Set(['--project', '--confirm-production', '--school'])
const opts = {}
const rollbackFiles = []
let apply = false
let rollbackGiven = false
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--apply') apply = true
  else if (a === '--rollback') {
    rollbackGiven = true
    while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) rollbackFiles.push(argv[++i])
  } else if (VALUE_OPTS.has(a)) {
    const v = argv[i + 1]
    if (v === undefined || !v.trim() || v.startsWith('--')) fail(`${a} 뒤에 값이 필요합니다(값이 비어 있으면 실행하지 않습니다).`)
    opts[a] = v.trim()
    i++
  } else fail(`알 수 없는 인자: ${a}`)
}

const project = opts['--project']
const confirmProd = opts['--confirm-production']
const onlySchool = opts['--school'] || null
const emulator = !!process.env.FIRESTORE_EMULATOR_HOST

if (!project) fail('--project <firebase project id> 가 필요합니다')
if (apply && rollbackGiven) fail('--apply 와 --rollback 은 함께 쓸 수 없습니다')
if (rollbackGiven && (!rollbackFiles.length || rollbackFiles.some((f) => !f.trim()))) {
  fail('--rollback 뒤에 migration-log-<runId>.json 파일을 하나 이상 적어 주세요(여러 번 나눠 실행했으면 모두: migration-log-*.json)')
}
if ((apply || rollbackGiven) && !emulator && confirmProd !== project) {
  fail('에뮬레이터가 아닌 프로젝트에 쓰려면(적용·복구 모두) --confirm-production <같은 project id> 가 필요합니다(운영 적용은 별도 승인 후에만).')
}

const credHelp = () =>
  [
    `${project} Firestore 자격 증명을 찾지 못했거나 권한이 없습니다.`,
    '이 스크립트는 앱의 .env(FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_SERVICE_ACCOUNT_JSON_PATH)를 읽지 않고 Application Default Credentials를 씁니다.',
    '다음 중 하나를 한 뒤 다시 실행하세요(docs/classmate-timetable-migration.md 2절). firebase login·gcloud auth login 만으로는 생기지 않습니다.',
    '  gcloud auth application-default login                                   # 프로젝트 권한이 있는 계정으로',
    '  export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.config/classmate/<키 파일>.json"  # 저장소 밖에 둔 서비스 계정 키',
    `계정에는 ${project}의 Firestore 읽기·쓰기 권한(예: Cloud Datastore 사용자 역할)이 있어야 합니다.`,
  ].join('\n')
const isCredentialError = (e) =>
  e?.code === 16 ||
  e?.code === 7 ||
  /default credentials|invalid_grant|invalid_rapt|refresh access token|UNAUTHENTICATED|PERMISSION_DENIED|insufficient permissions/i.test(String(e?.message || e))

if (!emulator && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const keyFile = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  if (!fs.existsSync(keyFile)) fail(`GOOGLE_APPLICATION_CREDENTIALS 파일이 없습니다: ${keyFile}\n${credHelp()}`)
  const rel = path.relative(ROOT, keyFile)
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    console.warn(`주의: 서비스 계정 키 파일이 저장소 안에 있습니다(${rel}). 저장소 밖으로 옮기고 작업이 끝나면 지우세요.`)
  }
}

const COURSE_PATH_RE = /^schools\/([^/]+)\/courses\/([^/]+)$/
const schoolOf = (p) => String(p || '').split('/')[1] || ''
const LOG_NAME_RE = /^migration-log-.+\.json$/

/** 복구할 실행 로그 읽기·검사(Firestore 연결 전) — 다른 프로젝트 로그, --school 이 로그 범위와 맞지 않으면 거부 */
function loadLogs(files) {
  const seen = new Set()
  const logs = []
  for (const f of files) {
    const file = path.resolve(f)
    if (seen.has(file)) continue
    seen.add(file)
    if (!fs.existsSync(file)) fail(`실행 로그가 없습니다: ${f}`)
    let log = null
    try {
      log = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      fail(`실행 로그를 읽지 못했습니다(JSON 아님): ${f}`)
    }
    if (!log || typeof log.runId !== 'string' || !Array.isArray(log.created)) fail(`migration-log 형식이 아닙니다: ${f}`)
    if (log.project !== project) fail(`${f} 는 ${log.project || '(project 없음)'} 프로젝트의 로그입니다(--project ${project}와 다름). 되돌리지 않습니다.`)
    logs.push({ name: f, file, log })
  }
  if (onlySchool && !logs.some(({ log }) => log.created.some((w) => schoolOf(w && w.path) === onlySchool))) {
    fail(`주어진 로그에 학교 ${onlySchool}의 문서가 없습니다(--school 이 로그 범위와 맞지 않음). 되돌리지 않습니다.`)
  }
  return logs
}

/** 같은 폴더에 있는, 이번에 주지 않은 같은 프로젝트의 실행 로그(되돌릴 문서가 있는 것만) */
function otherLogs(dirs, exclude) {
  const out = []
  for (const dir of dirs) {
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const n of names) {
      const file = path.join(dir, n)
      if (!LOG_NAME_RE.test(n) || exclude.has(file)) continue
      try {
        const log = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (log?.project !== project || !Array.isArray(log.created)) continue
        if (!log.created.some((w) => !onlySchool || schoolOf(w && w.path) === onlySchool)) continue
        out.push(path.relative(process.cwd(), file) || file)
      } catch {
        // 읽을 수 없는 파일은 건너뜀
      }
    }
  }
  return out.sort()
}

const rollbackLogs = rollbackGiven ? loadLogs(rollbackFiles) : null
const scriptRel = path.relative(process.cwd(), SCRIPT)
const scriptShown = scriptRel && !scriptRel.startsWith('..') ? scriptRel : SCRIPT
const scriptCmd = `node ${/\s/.test(scriptShown) ? `"${scriptShown}"` : scriptShown} --project ${project}${emulator ? '' : ` --confirm-production ${project}`}`
const rollbackCmd = `${scriptCmd} --rollback migration-log-*.json`

const require = createRequire(path.join(ROOT, 'package.json'))
const { initializeApp } = require('firebase-admin/app')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')

initializeApp({ projectId: project })
const db = getFirestore()
const GROUP_RE = /_g_[A-Za-z0-9]+$/
let applyLogFile = null // 적용 중인 실행 로그(실패 안내용)

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

/**
 * 수업을 가리키는 다른 문서 종류(있으면 수업을 지우지 않음).
 * 전환 뒤 담당 교사가 등록한 차시·변경, 그룹 QR·초대·명단으로 새로 생긴 수강, 발급한 초대 등은 수업 문서 자체를
 * 고치지 않아(updatedAt·revision 그대로) 예전에는 함께 지워져 없는 수업을 가리키게 됐습니다.
 * ownEnrollments: 이번 복구가 지울 수 있는 이 수업의 수강 경로(이 실행들이 만들고 손대지 않은 것) — 의존으로 세지 않음.
 * 학생 uid는 돌려주지 않습니다(종류만).
 */
async function courseDependents(schoolCode, courseId, ownEnrollments = new Set()) {
  const sref = db.collection('schools').doc(schoolCode)
  const probes = [
    ['series', sref.collection('series').where('courseId', '==', courseId)],
    ['overrides', sref.collection('overrides').where('courseId', '==', courseId)],
    ['rosterEntries', sref.collection('rosterEntries').where('courseId', '==', courseId)],
    ['changeSets', sref.collection('changeSets').where('affectedCourseIds', 'array-contains', courseId)],
  ]
  const found = []
  for (const [kind, q] of probes) {
    if (!(await q.limit(1).get()).empty) found.push(kind)
  }
  // 수강은 이번 복구가 지울 것 말고 하나라도 있으면 의존(own이 n개면 n+1개까지만 보면 충분)
  const enr = await sref.collection('enrollments').where('courseId', '==', courseId).select().limit(ownEnrollments.size + 1).get()
  if (enr.docs.some((d) => !ownEnrollments.has(d.ref.path))) found.push('enrollments')
  // 초대는 학교 밖 컬렉션(invitations/{code}) — 같은 학교의 수업 초대만(회수·만료된 것도 수업을 가리키므로 셈)
  const inv = await db.collection('invitations').where('targetId', '==', courseId).limit(50).get()
  if (inv.docs.some((d) => d.get('type') === 'course' && String(d.get('schoolCode') || '') === schoolCode)) found.push('invitations')
  return found
}

async function rollback(logs) {
  // 경로 → 그 경로를 적은 실행 id들(로그는 커밋 전에 기록 — 끊긴 실행의 경로를 다음 실행이 다시 만들었을 수 있음)
  const runIdsByPath = new Map()
  for (const { log } of logs) {
    for (const w of log.created) {
      const p = String((w && w.path) || '')
      if (!p || (onlySchool && schoolOf(p) !== onlySchool)) continue
      if (!runIdsByPath.has(p)) runIdsByPath.set(p, new Set())
      runIdsByPath.get(p).add(log.runId)
    }
  }
  const paths = Array.from(runIdsByPath.keys())
  const snaps = new Map()
  for (let i = 0; i < paths.length; i += 300) {
    const chunk = paths.slice(i, i + 300)
    const got = await db.getAll(...chunk.map((p) => db.doc(p)))
    got.forEach((s, j) => snaps.set(chunk[j], s))
  }
  // 이 실행들이 만들고 이후 아무도 고치지 않은 문서인지(서버 API는 고칠 때 updatedAt·revision을 남김)
  const stateOf = (p, s) => {
    if (!runIdsByPath.get(p).has(s.get('migrationRunId'))) return 'other-run'
    if (s.get('updatedAt') != null || Number(s.get('revision') || 0) > 0) return 'modified'
    return 'own'
  }
  let deleted = 0
  let skipped = 0
  let keptEnrollments = 0
  const skippedCourses = [] // {path, reason, dependents?, keptEnrollments?} — 수업 경로만(수강 경로에는 학생 uid가 들어 있어 보고하지 않음)
  const changedSchools = new Set()

  // 1) 지울 수 있는 수강(수업이 아닌 문서)을 수업별로 모음 — 수업의 '다른 참조'로 세지 않기 위해
  const ownDocs = []
  const ownByCourse = new Map() // '{school}/{courseId}' → Set(path)
  for (const p of paths) {
    const s = snaps.get(p)
    if (COURSE_PATH_RE.test(p) || !s.exists) continue
    if (stateOf(p, s) !== 'own') {
      skipped++
      continue
    }
    const key = `${schoolOf(p)}/${String(s.get('courseId') || '')}`
    ownDocs.push({ p, key })
    if (!ownByCourse.has(key)) ownByCourse.set(key, new Set())
    ownByCourse.get(key).add(p)
  }
  // 2) 수업마다 먼저 남길지 정함 — 남기는 수업이면 그 수업의 수강도 남김(지우면 원래 그룹 학생 시간표에서 수업이 사라짐)
  const keptCourses = new Map() // key → skippedCourses 항목
  const courseDeletes = []
  for (const p of paths) {
    const m = COURSE_PATH_RE.exec(p)
    const s = snaps.get(p)
    if (!m || !s.exists) continue
    const key = `${m[1]}/${m[2]}`
    const state = stateOf(p, s)
    let entry = null
    if (state !== 'own') entry = { path: p, reason: state }
    else {
      const dependents = await courseDependents(m[1], m[2], ownByCourse.get(key))
      if (dependents.length) entry = { path: p, reason: 'has-dependents', dependents }
    }
    if (entry) {
      skipped++
      skippedCourses.push(entry)
      keptCourses.set(key, entry)
    } else courseDeletes.push(p)
  }
  // 3) 수강 먼저, 4) 수업은 나중에(중간에 멈춰도 없는 수업을 가리키는 수강이 남지 않게)
  for (const { p, key } of ownDocs) {
    const kept = keptCourses.get(key)
    if (kept) {
      skipped++
      keptEnrollments++
      kept.keptEnrollments = (kept.keptEnrollments || 0) + 1
      continue
    }
    await db.doc(p).delete()
    deleted++
    changedSchools.add(schoolOf(p))
  }
  for (const p of courseDeletes) {
    await db.doc(p).delete()
    deleted++
    changedSchools.add(schoolOf(p))
  }
  // 학생 화면 갱신 신호(적용 때와 같음) — 지운 문서가 있는 학교만
  for (const s of changedSchools) {
    await db.collection('schools').doc(s).set({ scheduleRevision: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  }
  const given = new Set(logs.map((l) => l.file))
  const notIncludedLogs = otherLogs(new Set(logs.map((l) => path.dirname(l.file))), given)
  console.log(
    JSON.stringify(
      {
        rollback: logs.map((l) => l.name),
        school: onlySchool,
        deleted,
        skipped,
        keptEnrollments,
        skippedCourses,
        revisionBumped: Array.from(changedSchools),
        notIncludedLogs,
      },
      null,
      2
    )
  )
  if (notIncludedLogs.length) {
    console.error(
      `주의: 같은 폴더에 이번에 주지 않은 실행 로그 ${notIncludedLogs.length}개가 있습니다(${notIncludedLogs.join(', ')}).\n` +
        '실패 뒤 다시 실행해 문서가 여러 로그에 나뉘었다면 그 로그의 문서는 남아 있습니다. 모두 되돌리려면 로그를 한 번에 주세요(다시 실행해도 안전):\n' +
        `  ${rollbackCmd}${onlySchool ? ` --school ${onlySchool}` : ''}`
    )
  }
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
  // 그룹 담당 교사(classes.teacherId)의 users 문서 — 교사마다 한 번만 읽음
  const ownerCache = new Map()
  const ownerOf = async (uid) => {
    if (!uid) return null
    if (!ownerCache.has(uid)) {
      const snap = await db.collection('users').doc(uid).get()
      ownerCache.set(uid, snap.exists ? snap.data() || {} : null)
    }
    return ownerCache.get(uid)
  }
  const report = {
    runId,
    mode: apply ? 'apply' : 'dry-run',
    project,
    emulator,
    school: onlySchool, // null = 전체 학교
    generatedAt: new Date().toISOString(),
    schools: {},
    groupsToCourses: 0,
    enrollmentsToCreate: 0,
    alreadyMigrated: 0,
    groupsNotInTeacherList: 0,
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
    // 예전 '목록에서 빼기'는 교사 users.teachingClassIds에서만 지우고 그룹 문서·학생 extraClassIds는 남겼습니다.
    // 교사가 뺀 그룹(또는 교사 계정이 없는 그룹)은 운영 중인 이번 학기 수업·수강으로 만들지 않고 보고만 합니다.
    // 교사가 수업 반 목록에 다시 넣으면 다음 실행에서 전환됩니다.
    const teacherUid = String(data.teacherId || '')
    const owner = await ownerOf(teacherUid)
    if (!owner || !Array.isArray(owner.teachingClassIds) || !owner.teachingClassIds.includes(g.id)) {
      report.groupsNotInTeacherList++
      report.issues.push({ kind: 'group-not-in-teacher-list', id: g.id, teacherUid: teacherUid || null, reason: owner ? 'removed-from-list' : 'teacher-missing' })
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
  if (rollbackLogs) {
    await rollback(rollbackLogs)
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
  const earlierLogs = otherLogs(new Set([process.cwd()]), new Set([logFile]))
  const log = { runId: report.runId, project, school: onlySchool, startedAt: new Date().toISOString(), created: [], committedWrites: 0, done: false }
  fs.writeFileSync(logFile, JSON.stringify(log, null, 2))
  applyLogFile = logFile
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch()
    for (const w of writes.slice(i, i + 400)) {
      batch.set(db.doc(w.path), { ...w.data, createdAt: FieldValue.serverTimestamp() }, { merge: true })
      log.created.push({ path: w.path })
    }
    // 커밋 전에 기록 — 커밋이 끊기거나 결과가 불확실해도 이 배치 경로가 로그에 남음(복구는 없는 문서를 건너뜀)
    fs.writeFileSync(logFile, JSON.stringify(log, null, 2))
    await batch.commit()
    log.committedWrites = log.created.length
    fs.writeFileSync(logFile, JSON.stringify(log, null, 2)) // 중간 실패 시 어디까지 커밋됐는지 남김
  }
  // 학생 화면 갱신 신호
  const schools = new Set(writes.map((w) => w.path.split('/')[1]))
  for (const s of schools) {
    await db.collection('schools').doc(s).set({ scheduleRevision: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  }
  log.done = true
  log.finishedAt = new Date().toISOString()
  fs.writeFileSync(logFile, JSON.stringify(log, null, 2))
  applyLogFile = null
  console.log(
    JSON.stringify(
      {
        ...report,
        unclassified: report.unclassified.length,
        logFile,
        earlierLogs,
        rollback: `되돌리려면 이 폴더의 실행 로그를 모두 한 번에: ${rollbackCmd}`,
      },
      null,
      2
    )
  )
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('migration failed:', e?.message || e)
    if (!emulator && isCredentialError(e)) console.error(credHelp())
    if (applyLogFile) {
      console.error(
        `적용이 중간에 멈췄습니다. 여기까지 쓴 문서 경로는 ${applyLogFile} 에 있습니다(done: false).\n` +
          '같은 명령을 다시 실행하면 이미 있는 문서는 건너뛰지만 새 runId·실행 로그가 하나 더 생깁니다.\n' +
          `되돌릴 때는 이 폴더의 로그를 모두 한 번에 주세요: ${rollbackCmd}`
      )
    } else if (rollbackLogs) {
      console.error('복구가 중간에 멈췄습니다. 같은 명령을 다시 실행하면 남은 문서부터 이어서 처리합니다(이미 지운 문서는 건너뜀).')
    }
    process.exit(1)
  }
)
