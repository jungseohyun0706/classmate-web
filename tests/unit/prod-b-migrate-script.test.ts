// 데이터 전환 스크립트(scripts/migrate-timetable.mjs) 회귀 테스트 — 에뮬레이터·네트워크 없이
//  [10] 복구가 남기는 수업(has-dependents·modified)의 수강까지 지워 원래 그룹 학생 시간표에서 수업이 사라짐 → 수강도 남기고 keptEnrollments로 보고
//       수업이 주지 않은 로그(앞선 실행)에 있어도 같은 기준으로 남는 수업이면 수강을 남김(not-in-logs)
//  [11] 교사가 수업 반 목록에서 뺀 그룹·교사 계정이 없는 그룹이 이번 학기 운영 중 수업·수강으로 만들어짐 → 만들지 않고 issues로 보고
//  [13] --school 값이 비면 조용히 전체 학교로 넓어지고, 복구는 --school 을 무시 → 거부·학교 범위만 복구
//  [14] 운영 복구도 --confirm-production 필요, 자격 증명 안내(할당량 프로젝트 포함)
//  [15] 실패 뒤 다시 실행하면 문서가 여러 실행 로그에 나뉨 → 여러 로그를 한 번에 복구, 빠진 로그 안내, 로그는 커밋 전에 기록
// 스크립트를 임시 폴더에 복사하고 firebase-admin 자리에 메모리(JSON 파일) 가짜를 둬 실제 프로세스로 실행합니다.
// 가짜 initializeApp은 표시 파일을 남겨, 인자 거부가 Firestore 초기화 전에 일어나는지도 확인합니다.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

function srcPath(rel: string): string {
  const cands = [path.resolve(__dirname, '../../..', rel), path.resolve(__dirname, '../..', rel), path.resolve(process.cwd(), rel)]
  const f = cands.find((p) => fs.existsSync(p))
  if (!f) throw new Error(`소스 없음: ${rel}`)
  return f
}

const FAKE_APP = `
const fs = require('fs')
module.exports = {
  initializeApp: () => {
    if (process.env.FAKE_INIT_MARK) fs.writeFileSync(process.env.FAKE_INIT_MARK, 'init')
    return {}
  },
}
`

const FAKE_FIRESTORE = `
const fs = require('fs')
const FILE = process.env.FAKE_FS_DB
const store = new Map(Object.entries(FILE && fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {}))
process.on('exit', () => {
  if (FILE) fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(store), null, 2))
})
const FieldValue = { increment: (n) => ({ __op: 'inc', n }), serverTimestamp: () => ({ __op: 'ts' }) }
const resolve = (prev, v) =>
  v && typeof v === 'object' && v.__op === 'inc' ? Number(prev || 0) + v.n : v && typeof v === 'object' && v.__op === 'ts' ? '2026-10-03T00:00:00.000Z' : v
function write(p, data, opts) {
  const prev = opts && opts.merge ? store.get(p) || {} : {}
  const next = { ...prev }
  for (const [k, v] of Object.entries(data)) next[k] = resolve(prev[k], v)
  store.set(p, next)
}
class DocSnap {
  constructor(ref, data) { this.ref = ref; this.id = ref.id; this._d = data; this.exists = data !== undefined }
  data() { return this._d === undefined ? undefined : JSON.parse(JSON.stringify(this._d)) }
  get(f) { return this._d == null ? undefined : this._d[f] }
}
class DocRef {
  constructor(p) { this.path = p; this.id = p.split('/').pop() }
  collection(n) { return new Query(this.path + '/' + n) }
  async get() { return new DocSnap(this, store.get(this.path)) }
  async set(data, opts) { write(this.path, data, opts) }
  async delete() { store.delete(this.path) }
}
const test1 = (d, [f, op, v]) => {
  if (op === '==') return d[f] === v
  if (op === 'array-contains') return Array.isArray(d[f]) && d[f].includes(v)
  throw new Error('fake: unsupported op ' + op)
}
class Query {
  constructor(coll, filters = [], lim = Infinity) { this.coll = coll; this.filters = filters; this.lim = lim }
  doc(id) { return new DocRef(this.coll + '/' + id) }
  where(f, op, v) { return new Query(this.coll, [...this.filters, [f, op, v]], this.lim) }
  limit(n) { return new Query(this.coll, this.filters, n) }
  select() { return this }
  _match() {
    const depth = this.coll.split('/').length + 1
    return [...store.entries()]
      .filter(([p, d]) => p.startsWith(this.coll + '/') && p.split('/').length === depth && this.filters.every((w) => test1(d, w)))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .slice(0, this.lim)
      .map(([p, d]) => new DocSnap(new DocRef(p), d))
  }
  async get() {
    if (process.env.FAKE_FAIL_READ) throw new Error(process.env.FAKE_FAIL_READ)
    const docs = this._match()
    return { docs, empty: !docs.length, size: docs.length, forEach: (fn) => docs.forEach(fn) }
  }
  count() { return { get: async () => ({ data: () => ({ count: this._match().length }) }) } }
}
const db = {
  collection: (n) => new Query(n),
  doc: (p) => new DocRef(p),
  getAll: async (...refs) => refs.map((r) => new DocSnap(r, store.get(r.path))),
  batch() {
    const ops = []
    return {
      set: (ref, data, opts) => ops.push([ref.path, data, opts]),
      commit: async () => {
        if (process.env.FAKE_FAIL_COMMIT === '1') throw new Error('fake commit failure')
        ops.forEach(([p, d, o]) => write(p, d, o))
      },
    }
  },
}
module.exports = { getFirestore: () => db, FieldValue }
`

type Db = Record<string, Record<string, unknown>>
interface RunResult {
  status: number | null
  stdout: string
  stderr: string
  json: any
}

let fakeRoot = ''
let tmp = ''

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-b-mig-'))
  fakeRoot = path.join(tmp, 'root')
  fs.mkdirSync(path.join(fakeRoot, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(fakeRoot, 'node_modules/firebase-admin'), { recursive: true })
  fs.writeFileSync(path.join(fakeRoot, 'package.json'), '{"name":"fake-root","private":true}')
  fs.copyFileSync(srcPath('scripts/migrate-timetable.mjs'), path.join(fakeRoot, 'scripts/migrate-timetable.mjs'))
  fs.writeFileSync(path.join(fakeRoot, 'node_modules/firebase-admin/package.json'), '{"name":"firebase-admin","version":"0.0.0-fake"}')
  fs.writeFileSync(path.join(fakeRoot, 'node_modules/firebase-admin/app.js'), FAKE_APP)
  fs.writeFileSync(path.join(fakeRoot, 'node_modules/firebase-admin/firestore.js'), FAKE_FIRESTORE)
})
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

let seq = 0
/** 시나리오마다 작업 폴더(실행 로그가 쌓이는 곳)와 가짜 DB 파일 */
function scenario(seed: Db = {}) {
  const dir = path.join(tmp, `case-${++seq}`)
  fs.mkdirSync(dir, { recursive: true })
  const dbFile = path.join(dir, 'fake-db.json')
  fs.writeFileSync(dbFile, JSON.stringify(seed))
  const initMark = path.join(dir, 'init-mark')
  const run = (args: string[], opts: { emulator?: boolean; env?: Record<string, string>; failCommit?: boolean } = {}): RunResult => {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !/^(FIRESTORE_EMULATOR_HOST|GOOGLE_APPLICATION_CREDENTIALS|FAKE_)/.test(k)) env[k] = v
    }
    if (opts.emulator !== false) env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1' // 가짜 firebase-admin이라 실제로 연결하지 않음
    env.FAKE_FS_DB = dbFile
    env.FAKE_INIT_MARK = initMark
    if (opts.failCommit) env.FAKE_FAIL_COMMIT = '1'
    Object.assign(env, opts.env || {})
    const r = spawnSync(process.execPath, [path.join(fakeRoot, 'scripts/migrate-timetable.mjs'), ...args], {
      cwd: dir,
      env: env as NodeJS.ProcessEnv,
      encoding: 'utf8',
      timeout: 20000,
    })
    let json: any = null
    const i = r.stdout.indexOf('{')
    if (i >= 0) {
      try {
        json = JSON.parse(r.stdout.slice(i))
      } catch {
        json = null
      }
    }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json }
  }
  const db = (): Db => JSON.parse(fs.readFileSync(dbFile, 'utf8'))
  const patch = (p: string, data: Record<string, unknown> | null) => {
    const cur = db()
    if (data === null) delete cur[p]
    else cur[p] = { ...(cur[p] || {}), ...data }
    fs.writeFileSync(dbFile, JSON.stringify(cur))
  }
  const initialized = () => fs.existsSync(initMark)
  const resetInit = () => fs.rmSync(initMark, { force: true })
  return { dir, run, db, patch, initialized, resetInit }
}

const P = 'demo-classmate'
const S1 = { schoolCode: 'S1', schoolName: '테스트고' }
const teacher = (uid: string, teaching: string[], school = S1) => ({ [`users/${uid}`]: { role: 'teacher', name: uid, teachingClassIds: teaching, ...school } })
const group = (gid: string, teacherId: string, school = S1) => ({ [`classes/${gid}`]: { classId: gid, isGroup: true, grade: 3, classNm: 5, teacherId, teacherName: teacherId, ...school } })
const student = (uid: string, extra: string[], school = S1) => ({
  [`users/${uid}`]: { role: 'student', status: 'approved', name: uid, classId: `${school.schoolCode}_3_4`, extraClassIds: extra, ...school },
})
const logFiles = (dir: string) => fs.readdirSync(dir).filter((f) => /^migration-log-.+\.json$/.test(f)).sort()
const newLog = (dir: string, before: string[]) => {
  const added = logFiles(dir).filter((f) => !before.includes(f))
  assert.equal(added.length, 1, `새 로그 1개여야 함: ${added.join(',')}`)
  return added[0]
}

describe('[13][14] 인자 검사 — Firestore 초기화 전에 거부', () => {
  const cases: Array<[string, string[], RegExp, { emulator?: boolean; env?: Record<string, string> }?]> = [
    ['--school 이 마지막이라 값이 없음(셸 변수 빔)', ['--project', P, '--apply', '--school'], /--school 뒤에 값이 필요/],
    ['--school 값이 빈 문자열', ['--project', P, '--apply', '--school', ''], /--school 뒤에 값이 필요/],
    ['--school 뒤에 바로 다른 옵션', ['--project', P, '--school', '--apply'], /--school 뒤에 값이 필요/],
    ['오타 난 옵션(--shcool)은 무시하지 않고 거부', ['--project', P, '--apply', '--shcool', 'S1'], /알 수 없는 인자: --shcool/],
    ['운영 복구도 --confirm-production 필요', ['--project', 'classmate-prod-x', '--rollback', 'migration-log-x.json'], /--confirm-production/, { emulator: false }],
    ['--confirm-production 값이 다른 프로젝트', ['--project', 'classmate-prod-x', '--apply', '--confirm-production', 'other'], /--confirm-production/, { emulator: false }],
    ['--apply 와 --rollback 을 함께', ['--project', P, '--apply', '--rollback', 'migration-log-x.json'], /함께 쓸 수 없습니다/],
    ['--rollback 뒤에 로그 파일이 없음', ['--project', P, '--rollback'], /파일을 하나 이상/],
    ['없는 로그 파일', ['--project', P, '--rollback', 'migration-log-none.json'], /실행 로그가 없습니다/],
    [
      'GOOGLE_APPLICATION_CREDENTIALS가 없는 파일을 가리킴 → ADC 설정 안내',
      ['--project', 'classmate-prod-x'],
      /GOOGLE_APPLICATION_CREDENTIALS 파일이 없습니다[\s\S]*FIREBASE_SERVICE_ACCOUNT_JSON[\s\S]*application-default login[\s\S]*set-quota-project classmate-prod-x/,
      { emulator: false, env: { GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/prod-b-key.json' } },
    ],
    ['--homeroom-common 은 계속 거부', ['--project', P, '--apply', '--homeroom-common', 'S1_3_4'], /--homeroom-common/],
  ]
  for (const [name, args, re, opts] of cases) {
    test(name, () => {
      const s = scenario({ ...teacher('eng', ['S1_3_5_g_eng001']), ...group('S1_3_5_g_eng001', 'eng'), ...student('stuA', ['S1_3_5_g_eng001']) })
      const r = s.run(args, opts)
      assert.equal(r.status, 2, r.stderr)
      assert.match(r.stderr, re)
      assert.equal(s.initialized(), false, 'Firestore 초기화 전에 멈춰야 함')
      assert.equal(Object.keys(s.db()).filter((p) => p.startsWith('schools/')).length, 0)
    })
  }

  test('할당량 프로젝트 없는 최종 사용자 자격 증명 오류(코드 없이 메시지만)에도 설정 안내 — set-quota-project 포함', () => {
    const s = scenario({ ...teacher('eng', ['S1_3_5_g_eng001']), ...group('S1_3_5_g_eng001', 'eng') })
    const r = s.run(['--project', 'classmate-prod-x'], {
      emulator: false,
      env: {
        FAKE_FAIL_READ:
          'Your application has authenticated using end user credentials from the Google Cloud SDK or Google Cloud Shell which are not supported by the firestore.googleapis.com. We recommend configuring the billing/quota_project setting in gcloud',
      },
    })
    assert.equal(r.status, 1, r.stderr)
    assert.match(r.stderr, /migration failed:[\s\S]*application-default login[\s\S]*set-quota-project classmate-prod-x/)
  })

  test('다른 프로젝트의 실행 로그, 로그에 없는 --school 은 거부', () => {
    const s = scenario({ ...teacher('eng', ['S1_3_5_g_eng001']), ...group('S1_3_5_g_eng001', 'eng'), ...student('stuA', ['S1_3_5_g_eng001']) })
    assert.equal(s.run(['--project', P, '--apply']).status, 0)
    const log = logFiles(s.dir)[0]
    s.resetInit()
    const other = s.run(['--project', 'demo-other', '--rollback', log])
    assert.equal(other.status, 2)
    assert.match(other.stderr, /demo-classmate 프로젝트의 로그/)
    const wrongSchool = s.run(['--project', P, '--rollback', log, '--school', 'S9'])
    assert.equal(wrongSchool.status, 2)
    assert.match(wrongSchool.stderr, /학교 S9의 문서가 없습니다/)
    assert.equal(s.initialized(), false)
    assert.ok(s.db()['schools/S1/courses/lg_S1_3_5_g_eng001'], '아무것도 지우지 않음')
  })
})

describe('[11] 교사가 목록에서 뺀 그룹은 전환하지 않음', () => {
  test('dry-run 보고 → 적용: 목록에 있는 그룹만 수업·수강, 나머지는 issues', () => {
    const s = scenario({
      ...teacher('eng', ['S1_3_5_g_eng001']),
      ...group('S1_3_5_g_eng001', 'eng'),
      ...group('S1_3_6_g_old001', 'eng'), // 교사가 '목록에서 빼기' 한 그룹(문서·학생 extraClassIds는 남음)
      ...group('S1_3_7_g_gone01', 'ghost'), // 교사 계정 없음
      ...student('stuA', ['S1_3_5_g_eng001', 'S1_3_6_g_old001', 'S1_3_7_g_gone01']),
    })
    const dry = s.run(['--project', P])
    assert.equal(dry.status, 0, dry.stderr)
    assert.equal(dry.json.groupsToCourses, 1)
    assert.equal(dry.json.enrollmentsToCreate, 1)
    assert.equal(dry.json.groupsNotInTeacherList, 2)
    const issues = dry.json.issues.filter((i: any) => i.kind === 'group-not-in-teacher-list')
    assert.deepEqual(
      issues.map((i: any) => [i.id, i.reason, i.teacherUid]).sort(),
      [
        ['S1_3_6_g_old001', 'removed-from-list', 'eng'],
        ['S1_3_7_g_gone01', 'teacher-missing', 'ghost'],
      ]
    )
    const ap = s.run(['--project', P, '--apply'])
    assert.equal(ap.status, 0, ap.stderr)
    const schoolDocs = Object.keys(s.db()).filter((p) => p.startsWith('schools/S1/') && !p.endsWith('/S1'))
    assert.deepEqual(schoolDocs.sort(), ['schools/S1/courses/lg_S1_3_5_g_eng001', 'schools/S1/enrollments/lg_S1_3_5_g_eng001__stuA'])
  })

  test('교사가 목록에 다시 넣으면 다음 실행에서 전환', () => {
    const s = scenario({ ...teacher('eng', []), ...group('S1_3_6_g_old001', 'eng'), ...student('stuA', ['S1_3_6_g_old001']) })
    assert.equal(s.run(['--project', P, '--apply']).json.groupsToCourses, 0)
    s.patch('users/eng', { teachingClassIds: ['S1_3_6_g_old001'] })
    const again = s.run(['--project', P, '--apply'])
    assert.equal(again.json.groupsToCourses, 1)
    assert.ok(s.db()['schools/S1/enrollments/lg_S1_3_6_g_old001__stuA'])
  })
})

describe('[10] 복구는 남기는 수업의 수강을 지우지 않음', () => {
  test('차시가 붙은 수업·수정된 수업은 수강과 함께 남기고, 연결 없는 수업만 수강과 함께 지움', () => {
    const gids = ['S1_3_5_g_eng001', 'S1_3_6_g_mat001', 'S1_3_7_g_sci001']
    const s = scenario({
      ...teacher('eng', gids),
      ...group(gids[0], 'eng'),
      ...group(gids[1], 'eng'),
      ...group(gids[2], 'eng'),
      ...student('stuA', [gids[0]]),
      ...student('stuB', [gids[1]]),
      ...student('stuC', [gids[2]]),
      ...student('stuD', [gids[1]]),
    })
    const ap = s.run(['--project', P, '--apply'])
    assert.equal(ap.status, 0, ap.stderr)
    const log = path.basename(ap.json.logFile)
    // 전환 뒤: 수학 수업에 담당 교사가 차시 등록(수업 문서는 그대로), 과학 수업은 교사가 고침(updatedAt)
    s.patch('schools/S1/series/ser_mat1', { courseId: 'lg_S1_3_6_g_mat001', weekday: 2, period: 3, status: 'active' })
    s.patch('schools/S1/courses/lg_S1_3_7_g_sci001', { updatedAt: '2026-10-04T00:00:00Z', title: '과학(수정)' })
    const rb = s.run(['--project', P, '--rollback', log])
    assert.equal(rb.status, 0, rb.stderr)
    const db = s.db()
    // 영어: 연결 없음 → 수업·수강 삭제
    assert.equal(db['schools/S1/courses/lg_S1_3_5_g_eng001'], undefined)
    assert.equal(db['schools/S1/enrollments/lg_S1_3_5_g_eng001__stuA'], undefined)
    // 수학: 차시가 있어 남김 → 원래 그룹 학생 수강도 남김(시간표에서 수업이 사라지지 않게)
    assert.ok(db['schools/S1/courses/lg_S1_3_6_g_mat001'])
    assert.ok(db['schools/S1/enrollments/lg_S1_3_6_g_mat001__stuB'])
    assert.ok(db['schools/S1/enrollments/lg_S1_3_6_g_mat001__stuD'])
    // 과학: 수정돼 남김 → 수강도 남김
    assert.ok(db['schools/S1/courses/lg_S1_3_7_g_sci001'])
    assert.ok(db['schools/S1/enrollments/lg_S1_3_7_g_sci001__stuC'])
    const mat = rb.json.skippedCourses.find((c: any) => c.path === 'schools/S1/courses/lg_S1_3_6_g_mat001')
    const sci = rb.json.skippedCourses.find((c: any) => c.path === 'schools/S1/courses/lg_S1_3_7_g_sci001')
    assert.equal(mat.reason, 'has-dependents')
    assert.deepEqual(mat.dependents, ['series'], '이 실행이 만든 수강은 의존으로 세지 않음')
    assert.equal(mat.keptEnrollments, 2)
    assert.equal(sci.reason, 'modified')
    assert.equal(sci.keptEnrollments, 1)
    assert.equal(rb.json.keptEnrollments, 3)
    assert.equal(rb.json.deleted, 2)
    assert.deepEqual(rb.json.revisionBumped, ['S1'])
    assert.doesNotMatch(JSON.stringify(rb.json), /stu[A-Z]/, '복구 보고에 학생 uid 없음')
  })

  test('이 실행이 만들었지만 이후 수정된 수강이 있으면 수업을 지우지 않음(없는 수업을 가리키지 않게)', () => {
    const s = scenario({ ...teacher('eng', ['S1_3_5_g_eng001']), ...group('S1_3_5_g_eng001', 'eng'), ...student('stuA', ['S1_3_5_g_eng001']), ...student('stuB', ['S1_3_5_g_eng001']) })
    const ap = s.run(['--project', P, '--apply'])
    s.patch('schools/S1/enrollments/lg_S1_3_5_g_eng001__stuB', { status: 'ended', updatedAt: '2026-10-04T00:00:00Z' })
    const rb = s.run(['--project', P, '--rollback', path.basename(ap.json.logFile)])
    assert.equal(rb.status, 0, rb.stderr)
    const db = s.db()
    assert.ok(db['schools/S1/courses/lg_S1_3_5_g_eng001'])
    assert.ok(db['schools/S1/enrollments/lg_S1_3_5_g_eng001__stuA'])
    assert.ok(db['schools/S1/enrollments/lg_S1_3_5_g_eng001__stuB'])
    assert.equal(rb.json.deleted, 0)
  })

  test('수업은 앞선 실행(주지 않은 로그)이 만들고 수강만 이 로그에 있음 — 남는 수업(차시)의 수강은 남기고, 두 로그를 함께 줘도 아무것도 지우지 않음', () => {
    const gid = 'S1_3_5_g_eng001'
    const course = `schools/S1/courses/lg_${gid}`
    const s = scenario({ ...teacher('eng', [gid]), ...group(gid, 'eng'), ...student('stuA', [gid]) })
    const a = s.run(['--project', P, '--apply'])
    assert.equal(a.status, 0, a.stderr)
    const logA = path.basename(a.json.logFile)
    // 그룹에 학생이 늘어 다시 적용(7)) — 이 실행은 stuB 수강만 만듦
    s.patch('users/stuB', { role: 'student', status: 'approved', name: 'stuB', classId: 'S1_3_4', extraClassIds: [gid], ...S1 })
    const b = s.run(['--project', P, '--apply'])
    assert.equal(b.status, 0, b.stderr)
    const logB = path.basename(b.json.logFile)
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(s.dir, logB), 'utf8')).created.map((w: any) => w.path),
      [`schools/S1/enrollments/lg_${gid}__stuB`]
    )
    // 전환 뒤 담당 교사가 차시 등록(수업 문서는 그대로)
    s.patch('schools/S1/series/ser1', { courseId: `lg_${gid}`, weekday: 1, period: 2, status: 'active' })
    const revBefore = Number((s.db()['schools/S1'] || {}).scheduleRevision || 0)

    const onlyB = s.run(['--project', P, '--rollback', logB])
    assert.equal(onlyB.status, 0, onlyB.stderr)
    let db = s.db()
    assert.ok(db[`schools/S1/enrollments/lg_${gid}__stuB`], '남는 수업의 수강은 이 로그만 되돌려도 남김(stuB 시간표에서 차시가 사라지지 않게)')
    assert.ok(db[course])
    assert.ok(db[`schools/S1/enrollments/lg_${gid}__stuA`])
    assert.ok(db['schools/S1/series/ser1'])
    assert.equal(onlyB.json.deleted, 0)
    assert.equal(onlyB.json.keptEnrollments, 1)
    const kept = onlyB.json.skippedCourses.find((c: any) => c.path === course)
    assert.equal(kept.reason, 'not-in-logs')
    assert.deepEqual(kept.dependents, ['series', 'enrollments'])
    assert.equal(kept.keptEnrollments, 1)
    assert.deepEqual(onlyB.json.revisionBumped, [])
    assert.equal(Number((db['schools/S1'] || {}).scheduleRevision || 0), revBefore)
    assert.doesNotMatch(JSON.stringify(onlyB.json), /stu[A-Z]/)

    const both = s.run(['--project', P, '--rollback', logB, logA])
    assert.equal(both.status, 0, both.stderr)
    db = s.db()
    assert.equal(both.json.deleted, 0, '차시가 있는 동안에는 둘 다 줘도 지우지 않음')
    assert.equal(both.json.keptEnrollments, 2)
    const keptBoth = both.json.skippedCourses.find((c: any) => c.path === course)
    assert.equal(keptBoth.reason, 'has-dependents')
    assert.deepEqual(keptBoth.dependents, ['series'])
    assert.ok(db[course] && db[`schools/S1/enrollments/lg_${gid}__stuA`] && db[`schools/S1/enrollments/lg_${gid}__stuB`])
  })

  test('수업이 주지 않은 로그에 있을 때 — 수정된 수업이면 수강을 남기고, 아무것도 가리키지 않거나 수업이 없으면 수강만 지우며 수업은 지우지 않음', () => {
    const gid = 'S1_3_5_g_eng001'
    const course = `schools/S1/courses/lg_${gid}`
    const enrB = `schools/S1/enrollments/lg_${gid}__stuB`
    // 학생 없는 그룹 → 첫 실행은 수업만, 학생이 들어온 뒤 다시 적용한 실행은 수강만
    const s = scenario({ ...teacher('eng', [gid]), ...group(gid, 'eng') })
    assert.equal(s.run(['--project', P, '--apply']).status, 0)
    s.patch('users/stuB', { role: 'student', status: 'approved', name: 'stuB', classId: 'S1_3_4', extraClassIds: [gid], ...S1 })
    const b = s.run(['--project', P, '--apply'])
    assert.equal(b.status, 0, b.stderr)
    const logB = path.basename(b.json.logFile)

    // 교사가 수업을 고침(updatedAt) → 수업·수강 모두 남김
    s.patch(course, { updatedAt: '2026-10-04T00:00:00Z', title: '영어(수정)' })
    const modified = s.run(['--project', P, '--rollback', logB])
    assert.equal(modified.status, 0, modified.stderr)
    assert.ok(s.db()[enrB])
    assert.deepEqual(modified.json.skippedCourses, [{ path: course, reason: 'not-in-logs', modified: true, keptEnrollments: 1 }])
    assert.equal(modified.json.deleted, 0)

    // 수정 전으로 돌리면 수업을 가리키는 것이 이 로그의 수강뿐 → 수강만 지우고 수업은 로그 밖이라 그대로(이 실행 전 상태)
    const cur = s.db()
    delete cur[course].updatedAt
    fs.writeFileSync(path.join(s.dir, 'fake-db.json'), JSON.stringify(cur))
    const plain = s.run(['--project', P, '--rollback', logB])
    assert.equal(plain.status, 0, plain.stderr)
    assert.equal(s.db()[enrB], undefined)
    assert.ok(s.db()[course], '주지 않은 로그의 수업은 지우지 않음')
    assert.equal(plain.json.deleted, 1)
    assert.equal(plain.json.keptEnrollments, 0)
    assert.deepEqual(plain.json.skippedCourses, [])
    assert.deepEqual(plain.json.revisionBumped, ['S1'])

    // 수업이 이미 없으면 그 수강은 없는 수업을 가리키므로 지움
    const c = s.run(['--project', P, '--apply'])
    assert.equal(c.status, 0, c.stderr)
    s.patch(course, null)
    const gone = s.run(['--project', P, '--rollback', path.basename(c.json.logFile)])
    assert.equal(gone.status, 0, gone.stderr)
    assert.equal(s.db()[enrB], undefined)
    assert.equal(gone.json.deleted, 1)
  })
})

describe('[13] 복구의 --school 범위', () => {
  test('--school 학교 문서만 되돌리고 나머지 학교는 그대로, 이어서 전체 복구', () => {
    const S2 = { schoolCode: 'S2', schoolName: '둘째고' }
    const s = scenario({
      ...teacher('eng', ['S1_3_5_g_eng001']),
      ...group('S1_3_5_g_eng001', 'eng'),
      ...student('stuA', ['S1_3_5_g_eng001']),
      ...teacher('kor', ['S2_1_1_g_kor001'], S2),
      ...group('S2_1_1_g_kor001', 'kor', S2),
      ...student('stuK', ['S2_1_1_g_kor001'], S2),
    })
    const ap = s.run(['--project', P, '--apply'])
    assert.equal(ap.status, 0, ap.stderr)
    const log = path.basename(ap.json.logFile)
    const rev = (school: string) => Number((s.db()[`schools/${school}`] || {}).scheduleRevision || 0)
    const rev1 = rev('S1')
    const rb = s.run(['--project', P, '--rollback', log, '--school', 'S2'])
    assert.equal(rb.status, 0, rb.stderr)
    assert.equal(rb.json.school, 'S2')
    assert.deepEqual(rb.json.revisionBumped, ['S2'])
    let db = s.db()
    assert.equal(db['schools/S2/courses/lg_S2_1_1_g_kor001'], undefined)
    assert.equal(db['schools/S2/enrollments/lg_S2_1_1_g_kor001__stuK'], undefined)
    assert.ok(db['schools/S1/courses/lg_S1_3_5_g_eng001'])
    assert.ok(db['schools/S1/enrollments/lg_S1_3_5_g_eng001__stuA'])
    assert.equal(rev('S1'), rev1, '다른 학교 revision은 그대로')
    const rest = s.run(['--project', P, '--rollback', log])
    assert.equal(rest.status, 0, rest.stderr)
    db = s.db()
    assert.equal(db['schools/S1/courses/lg_S1_3_5_g_eng001'], undefined)
    assert.equal(rest.json.deleted, 2)
  })

  test('dry-run 보고에 범위(school)가 남음 — 값 없이 전체로 넓어지지 않음', () => {
    const s = scenario({ ...teacher('eng', ['S1_3_5_g_eng001']), ...group('S1_3_5_g_eng001', 'eng'), ...student('stuA', ['S1_3_5_g_eng001']) })
    assert.equal(s.run(['--project', P, '--school', 'S1']).json.school, 'S1')
    assert.equal(s.run(['--project', P]).json.school, null)
  })
})

describe('[15] 실패 뒤 다시 실행 → 여러 로그를 한 번에 복구', () => {
  test('수업은 첫 실행, 수강 일부는 다음 실행 로그 — 하나만 주면 남기고 빠진 로그를 알려 주며, 함께 주면 모두 지움', () => {
    const gid = 'S1_3_5_g_eng001'
    const s = scenario({ ...teacher('eng', [gid]), ...group(gid, 'eng'), ...student('stuA', [gid]) })
    const a = s.run(['--project', P, '--apply'])
    assert.equal(a.status, 0, a.stderr)
    const logA = path.basename(a.json.logFile)
    s.patch('users/stuB', { role: 'student', status: 'approved', name: 'stuB', classId: 'S1_3_4', extraClassIds: [gid], ...S1 })
    const b = s.run(['--project', P, '--apply'])
    assert.equal(b.status, 0, b.stderr)
    const logB = path.basename(b.json.logFile)
    assert.deepEqual(b.json.earlierLogs, [logA], '적용 결과에 앞선 실행 로그 안내')
    assert.match(b.json.rollback, /--rollback migration-log-\*\.json/)

    const onlyA = s.run(['--project', P, '--rollback', logA])
    assert.equal(onlyA.status, 0, onlyA.stderr)
    assert.deepEqual(onlyA.json.notIncludedLogs, [logB])
    assert.match(onlyA.stderr, /이번에 주지 않은 실행 로그 1개/)
    const course = onlyA.json.skippedCourses.find((c: any) => c.path === `schools/S1/courses/lg_${gid}`)
    assert.equal(course.reason, 'has-dependents')
    assert.ok(s.db()[`schools/S1/enrollments/lg_${gid}__stuA`], '남기는 수업의 수강은 남김')

    const both = s.run(['--project', P, '--rollback', logB, logA])
    assert.equal(both.status, 0, both.stderr)
    assert.deepEqual(both.json.notIncludedLogs, [])
    assert.equal(both.json.deleted, 3)
    assert.equal(Object.keys(s.db()).filter((p) => /^schools\/S1\/(courses|enrollments)\//.test(p)).length, 0)
  })

  test('커밋 실패: 로그는 커밋 전에 남고 안내가 나오며, 다시 실행한 로그와 함께 복구하면 모두 지움', () => {
    const gid = 'S1_3_5_g_eng001'
    const s = scenario({ ...teacher('eng', [gid]), ...group(gid, 'eng'), ...student('stuA', [gid]) })
    const failed = s.run(['--project', P, '--apply'], { failCommit: true })
    assert.equal(failed.status, 1)
    assert.match(failed.stderr, /적용이 중간에 멈췄습니다[\s\S]*모두 한 번에/)
    const logA = logFiles(s.dir)[0]
    const la = JSON.parse(fs.readFileSync(path.join(s.dir, logA), 'utf8'))
    assert.equal(la.done, false)
    assert.equal(la.committedWrites, 0)
    assert.deepEqual(la.created.map((w: any) => w.path).sort(), [`schools/S1/courses/lg_${gid}`, `schools/S1/enrollments/lg_${gid}__stuA`])

    const before = logFiles(s.dir)
    assert.equal(s.run(['--project', P, '--apply']).status, 0)
    const logB = newLog(s.dir, before)
    // A만: 문서는 B가 만들었으므로(other-run) 지우지 않음
    const onlyA = s.run(['--project', P, '--rollback', logA])
    assert.equal(onlyA.json.deleted, 0)
    assert.equal(onlyA.json.skippedCourses[0].reason, 'other-run')
    const all = s.run(['--project', P, '--rollback', ...logFiles(s.dir)])
    assert.equal(all.status, 0, all.stderr)
    assert.equal(all.json.deleted, 2)
    assert.ok(logB)
  })
})
