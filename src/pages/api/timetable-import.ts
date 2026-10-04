import type { NextApiRequest, NextApiResponse } from 'next'
import { randomUUID } from 'crypto'
import { FieldValue, type DocumentReference, type DocumentSnapshot, type Firestore, type Transaction, type WriteBatch } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'
import { getAdminApp } from '../../lib/fcm-admin'
import { isYmd } from '../../lib/timetable/dates'
import {
  IMPORT_SOURCE_KINDS,
  buildCandidates,
  courseIdFor,
  docMatches,
  existingFromDocs,
  maskEmail,
  packOps,
  planDigest,
  planImport,
  resolveTeacherConfirmations,
  undoSetOf,
  type BuildResult,
  type CatalogPublishOption,
  type CourseCandidate,
  type ExistingCourse,
  type ImportIssue,
  type ImportPlan,
  type RawImportRow,
  type TeacherAccount,
  type TeacherConfirmation,
  type WriteOp,
} from '../../lib/timetable/importMatch'
import {
  apiError,
  chunk,
  cleanText,
  currentRevision,
  defaultTermFor,
  ID_RE,
  isTeacher,
  readRevision,
  requireUser,
  schoolRef,
  stripUndefined,
  termForDate,
  writeAudit,
  writeRevision,
  type ApiUser,
} from '../../lib/timetable/server'
import type { Ymd } from '../../lib/timetable/types'

// POST /api/timetable-import  { action, ... }
// Header: Authorization: Bearer <Firebase ID token>
// 시간표 엑셀(학급·교사·특별실·전체)을 화면이 정규화 행(ImportRow)으로 바꿔 보내면
//  stage    → schools/{s}/importBatches/{batchId} (status 'staged') + rows/{000..} 500행씩. 운영 시간표는 건드리지 않음
//  preview  → 매칭·검증 결과(수업 후보, 신규/갱신/동일, 오류·검토 항목, 미연결 교사)와 현재 scheduleRevision
//  commit   → 오류가 있으면 422 has-errors, 검토 항목은 acceptReview일 때만(그 수업은 발행에서 제외).
//             schools/{s}/courses·series를 결정적 id로 만들거나 갱신(과거 차시 보존), scheduleRevision +1 한 번.
//             쓰기는 400개 단위로 나누고, 계획(plan/{n})과 진행 지점(progress)을 배치 문서에 남겨 실패 후 재시도하면 이어서.
//             이어서 하기('failed' 또는 임대가 끝난 'committing')는 학교 버전이 아니라 남은 묶음이 쓸 수업·차시가 계획 뒤
//             그대로인지로 판단(바뀌었으면 409 stale-revision → 원복). 마무리 트랜잭션 실패도 'failed'로 남김.
//             confirmTeacherLinks: [{ nameKey, uid }] — 발행 교사가 '교사 계정 연결 후보'에서 엑셀 교사 이름별로 체크한 계정.
//             서버가 다시 계산한 후보에서 그 이름키의 후보에 그 uid가 있을 때만 그 이름이 나오는 수업의 teacherUids/importLinkedUids에
//             넣음(나머지는 무시하고 ignoredTeacherCount로 알려 줌). 이전 형식 confirmTeacherUids(uid만)도 당분간 받되, 그 uid가
//             발행할 수업의 이름 정확히 하나의 후보일 때만 그 이름으로 해석. 새 수업은 managerUids에 발행 교사.
//             미리보기 뒤 학교 scheduleRevision이 올랐어도(수강 변경 등) 지금 자료로 다시 계산한 계획 해시가 미리보기와 같으면 진행.
//             catalog: { visible, policy } — 학생 '수업 담기' 목록 공개·참여 방식('auto' 바로 담기 / 'approval' 선생님 승인 후).
//             새로 만드는 수업과, 가져오기가 공개 설정을 맡은 기존 가져오기 수업(교사가 수업 화면에서 공개·참여 방식·수업 그룹을
//             바꾸지 않았고 예전 수업 그룹이 연결되지 않은 수업 — importManagesCatalog)에만 씀. 표시 없던 예전 가져오기 수업은 공개
//             여부만 따르고 참여 방식은 '승인 후'(importCatalogFor). 없으면 예전처럼 새 수업은 비공개·승인 후, 기존 수업은 그대로.
//             수업마다 학급 표시(classLabels — 대상 반, classLabelsBy 'import')와 거기서 뽑은 대상 학년(grades)을 기록(학급 표시가
//             없으면 grades 없음). 한 반 수업(대상 반 하나 — 'hr' 등)도 공개하지만 학생 공개 목록은 그 반 학생에게만 보냄(courses catalog).
//             교사가 수업 화면에서 정한 대상 반(classLabelsBy 'teacher')·대상 학년(gradesBy 'teacher')은 덮어쓰거나 지우지 않음(원복도 건드리지 않음)
// 정책: 공통 수업은 담임이 명시한 경우에만 — 가져오기는 commonForHomerooms를 쓰지 않고 후보(importCommon)만 기록.
//       교사 이름(masterName)만으로 담당 권한을 연결하지 않음 — 후보로 보여 주고 발행 교사가 확인한 것만 연결.
//  cancel   → staged 배치만 취소
//  rollback → 그 배치가 만든 차시만 종료, 그 배치가 바꾼 차시·수업은 이전 값으로. 이후 다른 배치·수동 수정으로 바뀐 수업은 건너뜀(skipped)
//             발행 도중 끊긴 배치('failed', 임대가 끝난 'committing')는 반영된 묶음(progress)까지만 되돌림
//  list     → 최근 20개 배치 요약(행 내용 없음). stalled: 발행·원복 중인데 임대가 끝난 배치
// 권한: users/{uid}가 같은 학교 교사(role 'teacher' + schoolCode)일 때만. 학생 403.
// 오류: { error, code } — 400 입력, 401, 403 권한, 404 배치 없음, 409 상태·버전·검토 필요, 422 원본 오류, 500 처리 실패

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
}

const MAX_ROWS = 5000
const ROWS_PER_CHUNK = 500
/** 한 WriteBatch = 계획의 쓰기 399개 + 배치 문서 진행 기록 1개 */
const OPS_PER_WRITE = 399
const LEASE_MS = 2 * 60 * 1000
const BUSY_STATUSES = ['committing', 'rolling-back']

class ImportApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>
  ) {
    super(message)
  }
}

function fail(status: number, code: string, message: string, extra?: Record<string, unknown>): never {
  throw new ImportApiError(status, code, message, extra)
}

interface Ctx {
  u: ApiUser
  db: Firestore
  uid: string
  schoolCode: string
  body: Record<string, any>
}

type BatchDoc = Record<string, any>

const pad = (n: number) => String(n).padStart(3, '0')
const nowMs = () => Date.now()

function requireTeacher(ctx: Ctx) {
  if (!isTeacher(ctx.u)) fail(403, 'forbidden', '같은 학교 선생님만 시간표를 가져올 수 있어요.')
}

function batchesRef(ctx: Ctx) {
  return schoolRef(ctx.db, ctx.schoolCode).collection('importBatches')
}

async function loadBatch(ctx: Ctx): Promise<{ ref: DocumentReference; batch: BatchDoc }> {
  const id = ctx.body.batchId
  if (typeof id !== 'string' || !ID_RE.test(id)) fail(400, 'invalid-id', '가져오기 배치 id가 올바르지 않아요.')
  // 경로가 요청자 학교 아래라서 다른 학교 배치는 찾을 수 없음(404)
  const ref = batchesRef(ctx).doc(id)
  const snap = await ref.get()
  if (!snap.exists) fail(404, 'not-found', '가져오기 배치를 찾을 수 없어요.')
  return { ref, batch: snap.data() || {} }
}

function expectedRevisionField(body: Record<string, any>): number {
  const v = body.expectedRevision
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) fail(400, 'invalid-revision', '화면의 시간표 버전(expectedRevision)이 필요해요.')
  return v
}

const leaseFresh = (b: BatchDoc) => typeof b.leaseAt === 'number' && nowMs() - b.leaseAt < LEASE_MS

// ───────────────────────── 입력 검증 ─────────────────────────

const STR_LIMITS: Record<string, number> = {
  section: 20,
  teacher: 60,
  classLabel: 30,
  room: 40,
  start: 10,
  end: 10,
  code: 40,
  courseCode: 40,
}

/** 행 하나의 모양만 검사(값의 의미 검증은 preview의 normalizeRow가 행 번호와 함께 보고) */
function sanitizeRow(r: unknown): RawImportRow | string {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return '행이 객체가 아니에요'
  const o = r as Record<string, unknown>
  if (IMPORT_SOURCE_KINDS.indexOf(o.sourceKind as any) < 0) return '자료 유형(sourceKind)'
  if (typeof o.sheet !== 'string' || o.sheet.length > 200) return '시트 이름(sheet)'
  if (typeof o.row !== 'number' || !Number.isInteger(o.row) || o.row < 0 || o.row > 1_000_000) return '행 번호(row)'
  if (o.col !== undefined && o.col !== null && (typeof o.col !== 'number' || !Number.isInteger(o.col) || o.col < 0 || o.col > 100_000)) return '열 번호(col)'
  const wp = (v: unknown) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 20)
  if (!wp(o.weekday)) return '요일(weekday)'
  if (!wp(o.period)) return '교시(period)'
  if (typeof o.subject !== 'string' || o.subject.length > 120) return '과목(subject)'
  const out: RawImportRow = {
    sourceKind: o.sourceKind as RawImportRow['sourceKind'],
    sheet: cleanText(o.sheet, 120),
    row: o.row,
    col: typeof o.col === 'number' ? o.col : null,
    weekday: typeof o.weekday === 'string' ? cleanText(o.weekday, 20) : (o.weekday as number),
    period: typeof o.period === 'string' ? cleanText(o.period, 20) : (o.period as number),
    subject: String(o.subject).replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ').slice(0, 120),
  }
  for (const k of Object.keys(STR_LIMITS)) {
    const v = o[k]
    if (v === undefined || v === null || v === '') {
      ;(out as any)[k] = null
      continue
    }
    if (typeof v !== 'string' || v.length > STR_LIMITS[k] * 2) return k
    ;(out as any)[k] = String(v).replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ').slice(0, STR_LIMITS[k] * 2)
  }
  return out
}

async function resolveTerm(db: Firestore, schoolCode: string, termIdIn: unknown, validFrom: Ymd): Promise<{ termId: string; isDefault: boolean }> {
  if (termIdIn === undefined || termIdIn === null || termIdIn === '') {
    const t = await termForDate(db, schoolCode, validFrom)
    return { termId: t.termId, isDefault: t.isDefault }
  }
  if (typeof termIdIn !== 'string' || !ID_RE.test(termIdIn)) fail(400, 'invalid-term', '학기 값이 올바르지 않아요.')
  const termId = termIdIn as string
  const snap = await schoolRef(db, schoolCode).collection('terms').doc(termId).get()
  if (snap.exists) {
    const t = snap.data() || {}
    if (isYmd(t.startDate) && isYmd(t.endDate) && !(validFrom >= t.startDate && validFrom < t.endDate)) {
      fail(400, 'out-of-term', `적용 시작일이 ${String(t.name || termId)} 기간(${t.startDate}~${t.endDate} 전날)을 벗어났어요.`)
    }
    return { termId, isDefault: false }
  }
  const def = defaultTermFor(validFrom)
  if (def.termId !== termId) fail(400, 'out-of-term', `적용 시작일(${validFrom})이 ${termId} 학기에 속하지 않아요.`)
  return { termId, isDefault: true }
}

// ───────────────────────── 분석(미리보기·확정 공용) ─────────────────────────

interface Analysis {
  rows: RawImportRow[]
  build: BuildResult
  existing: ExistingCourse[]
  revision: number
  planAll: ImportPlan
  planCommit: ImportPlan
  issues: ImportIssue[]
  blocked: CourseCandidate[]
  digest: string
  base: { schoolCode: string; termId: string; validFrom: Ymd; mode: 'merge' | 'replace'; batchId: string; revision: number; existing: ExistingCourse[] }
  blockedKeys: string[]
}

async function loadRows(ref: DocumentReference, rowChunkCount: number): Promise<RawImportRow[]> {
  const refs: DocumentReference[] = []
  for (let i = 0; i < rowChunkCount; i++) refs.push(ref.collection('rows').doc(pad(i)))
  if (!refs.length) return []
  const snaps = await ref.firestore.getAll(...refs)
  const rows: RawImportRow[] = []
  snaps.forEach((s, i) => {
    if (!s.exists) throw new ImportApiError(500, 'rows-missing', `임시 저장된 행 묶음(${i})을 찾지 못했어요. 파일을 다시 올려 주세요.`)
    const list = s.get('rows')
    if (Array.isArray(list)) list.forEach((r) => rows.push(r as RawImportRow))
  })
  return rows
}

async function loadTeachers(db: Firestore, schoolCode: string): Promise<TeacherAccount[]> {
  // 같은 학교 교사의 masterName·표시 이름만 읽음(학생 정보 없음)
  const snap = await db.collection('users').where('schoolCode', '==', schoolCode).where('role', '==', 'teacher').get()
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  return snap.docs.map((d) => ({
    uid: d.id,
    masterName: str(d.get('masterName')),
    name: cleanText(str(d.get('name')) || str(d.get('displayName')) || '', 30) || null,
  }))
}

/**
 * 연결 후보 교사의 로그인 이메일(Firebase Auth — users 문서의 email·name처럼 본인이 바꿔 쓸 수 있는 값이 아님)을 가려서.
 * 발행 교사가 '그 사람'인지 확인하는 용도. 조회 실패는 빈 값으로 위장하지 않고 failed로 알림
 */
async function maskedEmails(uids: string[]): Promise<{ emails: Record<string, string | null>; failed: boolean }> {
  const emails: Record<string, string | null> = Object.create(null)
  if (!uids.length) return { emails, failed: false }
  const app = getAdminApp()
  if (!app) return { emails, failed: true }
  try {
    for (const part of chunk(uids, 100)) {
      const r = await getAuth(app).getUsers(part.map((uid) => ({ uid })))
      r.users.forEach((u) => (emails[u.uid] = maskEmail(u.email)))
    }
    return { emails, failed: false }
  } catch (e) {
    console.error('timetable-import: teacher email lookup failed', String((e as Error)?.message || '').slice(0, 200))
    return { emails, failed: true }
  }
}

interface Confirmations {
  /** confirmTeacherLinks: (엑셀 교사 이름키, uid) 쌍 */
  pairs: TeacherConfirmation[]
  /** confirmTeacherUids(이전 형식): uid만 */
  uids: string[]
}

/** commit 본문의 연결 확인 — confirmTeacherLinks: [{ nameKey, uid }], confirmTeacherUids: string[](이전 형식). 없으면 [] */
function confirmFields(body: Record<string, any>): Confirmations {
  const v = body.confirmTeacherUids
  let uids: string[] = []
  if (v !== undefined && v !== null) {
    if (!Array.isArray(v) || v.length > 300 || v.some((x) => typeof x !== 'string' || !ID_RE.test(x))) {
      fail(400, 'invalid-confirm', '교사 계정 연결 확인 목록(confirmTeacherUids) 형식이 올바르지 않아요.')
    }
    uids = Array.from(new Set(v as string[])).sort()
  }
  const p = body.confirmTeacherLinks
  let pairs: TeacherConfirmation[] = []
  if (p !== undefined && p !== null) {
    const bad = (x: any) =>
      !x || typeof x !== 'object' || Array.isArray(x) || typeof x.nameKey !== 'string' || !x.nameKey || x.nameKey.length > 200 || typeof x.uid !== 'string' || !ID_RE.test(x.uid)
    if (!Array.isArray(p) || p.length > 300 || p.some(bad)) {
      fail(400, 'invalid-confirm', '교사 계정 연결 확인 목록(confirmTeacherLinks) 형식이 올바르지 않아요.')
    }
    pairs = (p as any[]).map((x) => ({ nameKey: String(x.nameKey), uid: String(x.uid) }))
  }
  return { pairs, uids }
}

/**
 * commit 본문의 학생 '수업 담기' 공개 선택 — catalog: { visible: boolean, policy: 'auto'|'approval' }.
 * 없으면(null) 예전 동작: 새 수업은 비공개·승인 후, 기존 수업의 공개·참여 방식은 그대로
 */
function catalogField(body: Record<string, any>): CatalogPublishOption | null {
  const v = body.catalog
  if (v === undefined || v === null) return null
  if (typeof v !== 'object' || Array.isArray(v) || typeof v.visible !== 'boolean' || (v.policy !== 'auto' && v.policy !== 'approval')) {
    fail(400, 'invalid-catalog', "학생 수업 담기 공개 설정(catalog) 형식이 올바르지 않아요. { visible: true/false, policy: 'auto'|'approval' }")
  }
  return { visible: v.visible, policy: v.policy }
}

async function loadExisting(db: Firestore, schoolCode: string, termId: string, courseIds: string[], mode: string): Promise<ExistingCourse[]> {
  const sref = schoolRef(db, schoolCode)
  const docs: Record<string, Record<string, unknown>> = Object.create(null)
  for (const ids of chunk(courseIds, 100)) {
    const snaps = await db.getAll(...ids.map((id) => sref.collection('courses').doc(id)))
    snaps.forEach((s) => {
      if (s.exists) docs[s.id] = s.data() || {}
    })
  }
  if (mode === 'replace') {
    const q = await sref.collection('courses').where('termId', '==', termId).where('source', '==', 'import').get()
    q.docs.forEach((d) => (docs[d.id] = d.data() || {}))
  }
  const ids = Object.keys(docs)
  const series: Array<{ id: string; data: Record<string, unknown> }> = []
  const groups = chunk(ids, 30)
  for (const part of chunk(groups, 8)) {
    const snaps = await Promise.all(part.map((g) => sref.collection('series').where('courseId', 'in', g).get()))
    snaps.forEach((q) => q.docs.forEach((d) => series.push({ id: d.id, data: d.data() || {} })))
  }
  return existingFromDocs(
    ids.map((id) => ({ id, data: docs[id] })),
    series
  )
}

async function analyze(ctx: Ctx, ref: DocumentReference, batch: BatchDoc): Promise<Analysis> {
  const [rows, teachers, revision] = await Promise.all([
    loadRows(ref, Number(batch.rowChunkCount) || 0),
    loadTeachers(ctx.db, ctx.schoolCode),
    currentRevision(ctx.db, ctx.schoolCode),
  ])
  const termId = String(batch.termId)
  const validFrom = String(batch.validFrom)
  const mode = batch.mode === 'replace' ? 'replace' : 'merge'
  const build = buildCandidates(rows, { schoolCode: ctx.schoolCode, teachers })
  const courseIds = build.courses.map((c) => courseIdFor(ctx.schoolCode, termId, c.importKey))
  const existing = await loadExisting(ctx.db, ctx.schoolCode, termId, courseIds, mode)
  const blocked = build.courses.filter((c) => c.blocked)
  const blockedKeys = blocked.map((c) => c.importKey)
  const base = { schoolCode: ctx.schoolCode, termId, validFrom, mode: mode as 'merge' | 'replace', batchId: ref.id, revision: revision + 1, existing }
  // 미리보기·비교 해시는 '확인 목록·발행 교사 없이' 만든 계획으로(같은 미리보기면 연결 확인과 무관하게 같은 해시)
  const planAll = planImport({ ...base, courses: build.courses })
  const planCommit = planImport({ ...base, courses: build.courses.filter((c) => !c.blocked), keepKeys: blockedKeys })

  const issues = build.issues.slice()
  const futureByCourse: Record<string, { importKey: string; dates: string[] }> = Object.create(null)
  planAll.futureVersions.forEach((f) => {
    const g = (futureByCourse[f.courseId] = futureByCourse[f.courseId] || { importKey: f.importKey, dates: [] })
    if (g.dates.indexOf(f.validFrom) < 0) g.dates.push(f.validFrom)
  })
  Object.keys(futureByCourse)
    .sort()
    .forEach((courseId) => {
      const g = futureByCourse[courseId]
      const title = (planAll.items.find((i) => i.courseId === courseId) || { title: g.importKey }).title
      issues.push({
        severity: 'error',
        code: 'future-version',
        message: `'${title}' 수업에 적용일(${validFrom})보다 뒤(${g.dates.sort().join(', ')})부터 적용되는 시간표가 이미 있어요.`,
        fix: '적용 시작일을 그 날짜 이후로 바꾸거나, 그 날짜의 가져오기 배치를 먼저 원복해 주세요.',
        rows: [],
        importKeys: [g.importKey],
      })
    })
  // 비교 해시: 수업·차시 쓰기(revision 값 제외)·제외 수업·교사 후보 매핑(엑셀 이름 → 후보 계정)
  const digest = planDigest(planCommit, blockedKeys, build.teacherLinks)
  return { rows, build, existing, revision, planAll, planCommit, issues, blocked, digest, base, blockedKeys }
}

/**
 * 확정에 쓸 최종 계획: 비교 해시를 확인한 뒤 연결 확인·발행 교사를 얹어 다시 계산.
 * 연결 확인은 (엑셀 이름키, uid) 쌍으로 — 다시 계산한 그 이름의 후보에 있을 때만, 그 이름이 나오는 수업에만 연결
 */
function finalPlan(a: Analysis, confirm: Confirmations, publisherUid: string, catalog: CatalogPublishOption | null) {
  const courses = a.build.courses.filter((c) => !c.blocked)
  const r = resolveTeacherConfirmations(
    a.build.teacherLinks,
    courses.map((c) => c.importKey),
    confirm.pairs,
    confirm.uids
  )
  const plan = planImport({ ...a.base, courses, keepKeys: a.blockedKeys, confirmedTeacherLinks: r.accepted, publisherUid, catalog })
  return { plan, accepted: r.acceptedUids, acceptedLinks: r.accepted, ignored: r.ignored }
}

function statsOf(a: Analysis) {
  const items = a.planAll.items
  return {
    ...a.build.stats,
    newCourses: items.filter((i) => i.status === 'new').length,
    updatedCourses: items.filter((i) => i.status === 'update').length,
    unchanged: items.filter((i) => i.status === 'same').length,
    retiring: items.filter((i) => i.status === 'retire').length,
    errors: a.issues.filter((i) => i.severity === 'error').length,
    review: a.issues.filter((i) => i.severity === 'review').length,
    excluded: a.blocked.length,
  }
}

function excludedList(a: Analysis) {
  return a.blocked.map((c) => ({ importKey: c.importKey, title: c.title, blocked: c.blocked, codes: c.issueCodes }))
}

// ───────────────────────── stage ─────────────────────────

async function stage(ctx: Ctx) {
  requireTeacher(ctx)
  const b = ctx.body
  if (typeof b.schoolCode !== 'string' || b.schoolCode !== ctx.schoolCode) {
    fail(403, 'school-mismatch', '내 학교와 업로드 대상 학교가 달라요. 새로고침한 뒤 다시 올려 주세요.')
  }
  if (!isYmd(b.validFrom)) fail(400, 'invalid-date', '적용 시작일(YYYYMMDD)이 올바르지 않아요.')
  const validFrom = b.validFrom as Ymd
  if (b.mode !== 'merge' && b.mode !== 'replace') fail(400, 'invalid-mode', "가져오기 방식은 'merge' 또는 'replace'여야 해요.")
  if (typeof b.fileHash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(b.fileHash)) fail(400, 'invalid-file-hash', '파일 식별값(fileHash)이 올바르지 않아요.')
  const fileHash = String(b.fileHash).toLowerCase()
  const fileName = cleanText(b.fileName, 120) || '(이름 없는 파일)'
  if (!Array.isArray(b.rows) || b.rows.length === 0) fail(400, 'invalid-rows', '가져올 행이 없어요.')
  if (b.rows.length > MAX_ROWS) fail(400, 'too-many-rows', `한 번에 ${MAX_ROWS}행까지 올릴 수 있어요. 파일을 나눠 올려 주세요.`)
  const rows: RawImportRow[] = []
  for (let i = 0; i < b.rows.length; i++) {
    const r = sanitizeRow(b.rows[i])
    if (typeof r === 'string') {
      const raw = b.rows[i] && typeof b.rows[i] === 'object' ? b.rows[i] : {}
      fail(400, 'invalid-rows', `${i + 1}번째 행(${cleanText(raw.sheet, 40) || '시트 미상'} ${Number(raw.row) || '?'}행)의 ${r} 형식이 올바르지 않아요.`, { index: i })
    }
    rows.push(r as RawImportRow)
  }
  const term = await resolveTerm(ctx.db, ctx.schoolCode, b.termId, validFrom)

  // 같은 파일(같은 해시·같은 학기)을 이미 발행했으면 알려 줌 — 새 배치는 그대로 만들되, 미리보기는 '동일'로 나옴
  const dup = await batchesRef(ctx).where('fileHash', '==', fileHash).where('termId', '==', term.termId).where('status', '==', 'committed').limit(1).get()
  const duplicateOf = dup.empty ? null : dup.docs[0].id

  const ref = batchesRef(ctx).doc()
  const parts = chunk(rows, ROWS_PER_CHUNK)
  const wb = ctx.db.batch()
  wb.set(ref, {
    schoolCode: ctx.schoolCode,
    termId: term.termId,
    termIsDefault: term.isDefault,
    validFrom,
    mode: b.mode,
    fileName,
    fileHash,
    rowCount: rows.length,
    rowChunkCount: parts.length,
    status: 'staged',
    duplicateOf,
    createdBy: ctx.uid,
    createdByName: cleanText(ctx.u.user.displayName || ctx.u.user.name || ctx.u.user.masterName || '', 40) || null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  })
  parts.forEach((part, i) => wb.set(ref.collection('rows').doc(pad(i)), { index: i, rows: part.map((r) => stripUndefined(r)) }))
  writeAudit(wb, ctx.db, ctx.schoolCode, {
    action: 'timetable-import.stage',
    actorUid: ctx.uid,
    target: `importBatches/${ref.id}`,
    meta: { fileName, rowCount: rows.length, termId: term.termId, validFrom, mode: b.mode, duplicateOf },
  })
  await wb.commit()
  return { batchId: ref.id, rowCount: rows.length, termId: term.termId, termIsDefault: term.isDefault, duplicateOf }
}

// ───────────────────────── preview ─────────────────────────

async function preview(ctx: Ctx) {
  requireTeacher(ctx)
  const { ref, batch } = await loadBatch(ctx)
  if (batch.status !== 'staged') fail(409, 'bad-status', `이미 ${statusKo(batch.status)} 배치라 미리보기를 다시 만들 수 없어요.`, { status: batch.status })
  const a = await analyze(ctx, ref, batch)
  const stats = statsOf(a)
  const itemByKey: Record<string, ImportPlan['items'][number]> = Object.create(null)
  a.planAll.items.forEach((i) => (itemByKey[i.importKey] = i))
  const exById: Record<string, ExistingCourse> = Object.create(null)
  a.existing.forEach((c) => (exById[c.courseId] = c))
  // 확인 없이 발행했을 때의 담당 교사(사람이 넣은 uid + 이전에 확인된 연결)
  const plannedTeacherUids: Record<string, string[]> = Object.create(null)
  const courses = a.build.courses.map((c) => {
    const it = itemByKey[c.importKey]
    const courseOp = it.ops.find((o) => o.target === 'course')
    const ex = exById[it.courseId]
    const teacherUids = courseOp && Array.isArray(courseOp.set.teacherUids) ? (courseOp.set.teacherUids as string[]) : ex ? ex.teacherUids : []
    plannedTeacherUids[c.importKey] = teacherUids
    // 공통 수업: 가져오기는 바꾸지 않음 — 새 수업 [], 기존 수업은 담임이 정한 값 그대로. 후보는 commonCandidates
    const common = ex ? ex.commonForHomerooms : []
    return {
      importKey: c.importKey,
      courseId: it.courseId,
      keyKind: c.keyKind,
      title: c.title,
      subject: c.subject,
      section: c.section,
      teacherNames: c.teacherNames,
      teacherUids,
      candidateTeacherUids: c.candidateTeacherUids,
      commonForHomerooms: common,
      commonCandidates: c.commonCandidates,
      classLabels: c.classLabels,
      status: it.status,
      changes: it.changes,
      blocked: c.blocked,
      issueCodes: c.issueCodes,
      series: c.series,
      sources: c.sources,
    }
  })
  // 교사 계정 연결 후보: 엑셀 이름 → 후보 계정(표시 이름·가린 로그인 이메일). 학생 정보 없음
  const candUids = Array.from(new Set(a.build.teacherLinks.flatMap((l) => l.candidates.map((x) => x.uid)))).sort()
  const { emails, failed: teacherEmailError } = await maskedEmails(candUids)
  const teacherLinks = a.build.teacherLinks.map((l) => {
    const keys = l.importKeys
    const candidates = l.candidates.map((x) => {
      const linkedCourseCount = keys.filter((k) => (plannedTeacherUids[k] || []).indexOf(x.uid) >= 0).length
      return { uid: x.uid, name: x.name, emailMasked: emails[x.uid] ?? null, linkedCourseCount }
    })
    return {
      name: l.name,
      // 연결 확인을 보낼 때 쓰는 엑셀 이름키(confirmTeacherLinks[].nameKey)
      nameKey: l.key,
      reason: l.reason,
      courseCount: keys.length,
      importKeys: keys,
      // 이 이름의 모든 수업에 이미(이전 확인으로) 연결된 후보가 있는지
      linked: candidates.some((x) => x.linkedCourseCount === keys.length),
      candidates,
    }
  })
  const retiring = a.planAll.items
    .filter((i) => i.status === 'retire')
    .map((i) => ({ courseId: i.courseId, importKey: i.importKey, title: i.title, seriesCount: i.ops.filter((o) => o.target === 'series').length }))
  await ref.update({
    previewRevision: a.revision,
    previewDigest: a.digest,
    previewStats: stats,
    previewBy: ctx.uid,
    previewAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  })
  return {
    batchId: ref.id,
    termId: batch.termId,
    validFrom: batch.validFrom,
    mode: batch.mode,
    duplicateOf: batch.duplicateOf || null,
    stats,
    courses,
    retiring,
    issues: a.issues,
    teacherLinks,
    teacherEmailError,
    revision: a.revision,
  }
}

// ───────────────────────── commit ─────────────────────────

function statusKo(s: unknown): string {
  switch (s) {
    case 'staged':
      return '임시 저장된'
    case 'committing':
      return '발행 중인'
    case 'committed':
      return '발행된'
    case 'failed':
      return '발행이 중단된'
    case 'cancelled':
      return '취소된'
    case 'rolling-back':
      return '원복 중인'
    case 'rolled-back':
      return '원복된'
    case 'rollback-failed':
      return '원복이 중단된'
    default:
      return '처리된'
  }
}

function committedResult(batchId: string, b: BatchDoc, extra: Record<string, unknown> = {}) {
  return {
    batchId,
    status: b.status,
    revision: b.commitRevision ?? null,
    created: b.created || [],
    updated: b.updated || [],
    retired: b.retired || [],
    excluded: b.excluded || [],
    unchanged: b.unchangedCount ?? 0,
    confirmedTeacherUids: b.confirmedTeacherUids || [],
    confirmedTeacherLinks: b.confirmedTeacherLinks || [],
    ignoredTeacherCount: Number(b.ignoredTeacherCount) || 0,
    catalog: b.catalogOption ?? null,
    ...extra,
  }
}

function writeOp(wb: WriteBatch, ctx: Ctx, op: WriteOp, extra: Record<string, unknown> = {}) {
  const sref = schoolRef(ctx.db, ctx.schoolCode)
  const ref = sref.collection(op.target === 'course' ? 'courses' : 'series').doc(op.id)
  const data: Record<string, unknown> = { ...op.set, ...extra, updatedAt: FieldValue.serverTimestamp() }
  if (op.kind === 'create') {
    data.createdAt = FieldValue.serverTimestamp()
    data.createdBy = ctx.uid
    // 새 수업의 관리 교사(발행 교사): 이미 있는 값은 지우지 않게 arrayUnion
    if (op.target === 'course' && Array.isArray(op.set.managerUids) && op.set.managerUids.length) {
      data.managerUids = FieldValue.arrayUnion(...(op.set.managerUids as string[]))
    }
  }
  wb.set(ref, data, { merge: true })
}

/** 다른 배치가 발행·원복 중인지(트랜잭션 안) */
async function assertNoOtherBusy(tx: Transaction, ctx: Ctx, batchId: string) {
  const q = await tx.get(batchesRef(ctx).where('status', 'in', BUSY_STATUSES))
  const other = q.docs.find((d) => d.id !== batchId && leaseFresh(d.data() || {}))
  if (other) fail(409, 'in-progress', '다른 시간표 가져오기를 발행하거나 원복하는 중이에요. 잠시 후 다시 시도해 주세요.')
}

/** 이 시도(attemptId)가 아직 배치를 잡고 있는지 — 그때의 배치 문서 스냅숏(묶음 쓰기의 전제 조건으로 씀) */
async function holdOf(ref: DocumentReference, attemptId: string): Promise<DocumentSnapshot> {
  const snap = await ref.get()
  const b = snap.data() || {}
  if (b.status !== 'committing' || b.attemptId !== attemptId) fail(409, 'in-progress', '다른 요청이 이 배치를 처리하고 있어요.')
  return snap
}

async function applyPlanChunks(ctx: Ctx, ref: DocumentReference, attemptId: string, from: number, total: number) {
  for (let i = from; i < total; i++) {
    const snap = await ref.collection('plan').doc(pad(i)).get()
    const ops = (snap.exists ? snap.get('ops') : null) as WriteOp[] | null
    if (!Array.isArray(ops)) throw new Error(`plan chunk ${i} missing`)
    // 임대가 끝나 다른 요청(이어서 발행·원복)이 이 배치를 넘겨받았으면 이 묶음을 쓰지 않음:
    // 배치 문서가 방금 확인한 그대로일 때만(lastUpdateTime) 묶음 전체가 반영됨
    const hold = await holdOf(ref, attemptId)
    const wb = ctx.db.batch()
    ops.forEach((op) => writeOp(wb, ctx, op))
    // 진행 지점은 같은 묶음 안에서 기록 → 묶음이 반영됐으면 progress도 반영됨
    wb.update(ref, { progress: i + 1, leaseAt: nowMs(), attemptId }, { lastUpdateTime: hold.updateTime })
    await wb.commit()
  }
}

async function finishCommit(ctx: Ctx, ref: DocumentReference, attemptId: string) {
  return ctx.db.runTransaction(async (tx) => {
    const bs = await tx.get(ref)
    const b = bs.data() || {}
    if (b.status !== 'committing' || b.attemptId !== attemptId) fail(409, 'in-progress', '다른 요청이 이 배치를 처리하고 있어요.')
    const rev = await readRevision(tx, ctx.db, ctx.schoolCode)
    const changed = Number(b.opCount) > 0
    const newRev = changed ? rev + 1 : rev
    if (changed) writeRevision(tx, ctx.db, ctx.schoolCode, newRev)
    tx.update(ref, {
      status: 'committed',
      commitRevision: newRev,
      committedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      leaseAt: null,
      error: null,
    })
    writeAudit(tx, ctx.db, ctx.schoolCode, {
      action: 'timetable-import.commit',
      actorUid: ctx.uid,
      target: `importBatches/${ref.id}`,
      revision: newRev,
      meta: {
        fileName: b.fileName,
        termId: b.termId,
        validFrom: b.validFrom,
        mode: b.mode,
        created: (b.created || []).length,
        updated: (b.updated || []).length,
        retired: (b.retired || []).length,
        excluded: (b.excluded || []).length,
        opCount: b.opCount,
        // 담당 권한을 준 교사 계정(발행 교사가 엑셀 이름별로 확인한 후보) — 교사 uid·엑셀 이름키만, 학생 정보 없음
        confirmedTeacherUids: b.confirmedTeacherUids || [],
        confirmedTeacherLinks: b.confirmedTeacherLinks || [],
        ignoredTeacherCount: Number(b.ignoredTeacherCount) || 0,
        catalogOption: b.catalogOption ?? null,
      },
    })
    return { ...b, status: 'committed', commitRevision: newRev }
  })
}

/**
 * 이 시도가 아직 배치를 잡고 있을 때만 'failed'로 표시(트랜잭션). 이미 'committed'(마무리 트랜잭션이 실제로는 반영됐는데
 * 오류만 돌아온 경우)거나 다른 요청이 넘겨받았으면 덮어쓰지 않음. 읽은 배치 문서와 표시 여부(읽지도 못하면 null)
 */
async function markFailed(ctx: Ctx, ref: DocumentReference, attemptId: string, error: string): Promise<{ marked: boolean; b: BatchDoc } | null> {
  try {
    return await ctx.db.runTransaction(async (tx) => {
      const b = (await tx.get(ref)).data() || {}
      if (b.status !== 'committing' || b.attemptId !== attemptId) return { marked: false, b }
      tx.update(ref, { status: 'failed', error, failedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), leaseAt: null })
      return { marked: true, b: { ...b, status: 'failed', error } }
    })
  } catch (e) {
    console.error('timetable-import: mark failed failed', ref.id, String((e as Error)?.message || '').slice(0, 200))
    return null
  }
}

async function runChunksAndFinish(ctx: Ctx, ref: DocumentReference, attemptId: string, from: number, total: number) {
  try {
    await applyPlanChunks(ctx, ref, attemptId, from, total)
  } catch (e) {
    if (e instanceof ImportApiError) throw e // 다른 요청이 넘겨받음 — 그 요청의 상태를 건드리지 않음
    console.error('timetable-import: commit chunk failed', ref.id, String((e as Error)?.message || '').slice(0, 200))
    const m = await markFailed(ctx, ref, attemptId, '쓰기 중단')
    if (m && !m.marked) fail(409, 'in-progress', '다른 요청이 이 배치를 처리하고 있어요.')
    fail(500, 'commit-failed', '발행 중 문제가 생겨 멈췄어요. 다시 시도하면 멈춘 곳부터 이어서 진행해요.', {
      progress: m ? Number(m.b.progress) || 0 : from,
      total,
    })
  }
  let done: BatchDoc
  try {
    done = await finishCommit(ctx, ref, attemptId)
  } catch (e) {
    if (e instanceof ImportApiError) throw e
    // 예전에는 여기서 실패하면 'committing'으로 남아(임대가 끝나도) 이어서 발행·원복이 막혔음.
    // 마무리 트랜잭션이 실제로는 반영됐을 수 있으므로(DEADLINE_EXCEEDED 등) 다시 읽어, 아직 이 시도의 'committing'일 때만 'failed'
    console.error('timetable-import: commit finish failed', ref.id, String((e as Error)?.message || '').slice(0, 200))
    const m = await markFailed(ctx, ref, attemptId, '발행 마무리 중단')
    if (m && m.b.status === 'committed') return committedResult(ref.id, m.b)
    if (m && !m.marked) fail(409, 'in-progress', '다른 요청이 이 배치를 처리하고 있어요.')
    fail(500, 'commit-failed', '발행을 마무리하지 못했어요. 다시 시도하면 남은 마무리만 이어서 해요.', { progress: total, total })
  }
  return committedResult(ref.id, done)
}

/**
 * 이어서 발행 전 확인 — 바뀐 문서 경로(비면 그대로):
 *  ① 남은 묶음이 쓸 문서가 계획 때 상태(restore, 새로 만들 문서는 '없음') 그대로이거나 이미 계획한 값인지
 *  ② 남은 묶음의 수업에 계획 뒤 다른 곳에서 새 차시가 생기지 않았는지(계획은 그 차시를 모름 — knownSeries)
 */
async function changedSincePlan(ctx: Ctx, ref: DocumentReference, from: number, total: number): Promise<string[]> {
  const sref = schoolRef(ctx.db, ctx.schoolCode)
  const ops: WriteOp[] = []
  const known: Record<string, string[]> = Object.create(null)
  for (let i = from; i < total; i++) {
    const snap = await ref.collection('plan').doc(pad(i)).get()
    const list = snap.exists ? snap.get('ops') : null
    if (!Array.isArray(list)) throw new Error(`plan chunk ${i} missing`)
    list.forEach((o: WriteOp) => ops.push(o))
    const k = snap.get('knownSeries')
    if (k && typeof k === 'object') {
      Object.keys(k).forEach((cid) => (known[cid] = Array.isArray(k[cid]) ? k[cid].filter((x: unknown) => typeof x === 'string') : []))
    }
  }
  const pathOf = (o: WriteOp) => `${o.target === 'course' ? 'courses' : 'series'}/${o.id}`
  const changed: string[] = []
  for (const part of chunk(ops, 100)) {
    const snaps = await ctx.db.getAll(...part.map((o) => sref.collection(o.target === 'course' ? 'courses' : 'series').doc(o.id)))
    const cur: Record<string, Record<string, unknown> | null> = Object.create(null)
    snaps.forEach((s) => (cur[`${s.ref.parent.id}/${s.id}`] = s.exists ? s.data() || {} : null))
    part.forEach((o) => {
      const d = cur[pathOf(o)]
      const ok = docMatches(d, o.set) || (o.restore ? docMatches(d, o.restore) : d === null)
      if (!ok) changed.push(pathOf(o))
    })
  }
  for (const g of chunk(Object.keys(known).sort(), 30)) {
    const q = await sref.collection('series').where('courseId', 'in', g).get()
    q.docs.forEach((d) => {
      const list = known[String(d.get('courseId'))] || []
      if (list.indexOf(d.id) >= 0 || d.get('importBatchId') === ref.id) return
      changed.push(`series/${d.id}`)
    })
  }
  return Array.from(new Set(changed)).sort()
}

async function commit(ctx: Ctx) {
  requireTeacher(ctx)
  const expectedRevision = expectedRevisionField(ctx.body)
  const acceptReview = ctx.body.acceptReview === true
  const confirm = confirmFields(ctx.body)
  const catalog = catalogField(ctx.body)
  const { ref, batch } = await loadBatch(ctx)

  if (batch.status === 'committed') return committedResult(ref.id, batch, { alreadyCommitted: true })
  if (batch.status === 'committing' && leaseFresh(batch)) fail(409, 'in-progress', '이 배치를 발행하는 중이에요. 잠시 후 결과를 확인해 주세요.')

  // 중단된 발행 이어서 하기(저장된 계획 그대로 — 같은 결과)
  if ((batch.status === 'committing' || batch.status === 'failed') && typeof batch.planChunkCount === 'number') {
    const from = Number(batch.progress) || 0
    const total = batch.planChunkCount
    // 학교 전체 버전(scheduleRevision)은 수강 변경(초대 수락·그룹 QR·명단 연결)에도 올라서 비교하지 않음 —
    // 남은 묶음이 쓸 수업·차시가 계획 뒤 다른 곳에서 바뀌었을 때만 막음(이미 반영한 묶음은 원복으로 되돌릴 수 있음)
    const changed = await changedSincePlan(ctx, ref, from, total)
    if (changed.length) {
      fail(409, 'stale-revision', '발행이 멈춘 뒤 이 가져오기가 고칠 수업·차시가 다른 곳에서 바뀌었어요. 이 배치를 원복한 뒤 다시 올려 주세요.', {
        revision: await currentRevision(ctx.db, ctx.schoolCode),
        changedCount: changed.length,
      })
    }
    const attemptId = randomUUID()
    await ctx.db.runTransaction(async (tx) => {
      const b = (await tx.get(ref)).data() || {}
      if (!((b.status === 'committing' && !leaseFresh(b)) || b.status === 'failed')) fail(409, 'in-progress', '다른 요청이 이 배치를 처리하고 있어요.')
      // 확인한 뒤 다른 요청이 더 진행했으면 확인한 범위와 달라짐
      if ((Number(b.progress) || 0) !== from) fail(409, 'in-progress', '다른 요청이 이 배치를 처리하고 있어요.')
      await assertNoOtherBusy(tx, ctx, ref.id)
      tx.update(ref, { status: 'committing', attemptId, leaseAt: nowMs(), error: null })
    })
    return runChunksAndFinish(ctx, ref, attemptId, from, total)
  }
  if (batch.status !== 'staged') fail(409, 'bad-status', `${statusKo(batch.status)} 배치는 발행할 수 없어요.`, { status: batch.status })
  if (!batch.previewDigest) fail(409, 'needs-preview', '먼저 미리보기로 결과를 확인해 주세요.')
  // 화면의 미리보기가 이 배치의 마지막 미리보기인지(그 뒤 다른 창에서 미리보기를 다시 만들었으면 다시 확인)
  if (batch.previewRevision !== expectedRevision) {
    fail(409, 'stale-revision', '미리보기 이후 시간표가 바뀌었어요. 미리보기를 다시 확인해 주세요.', { revision: await currentRevision(ctx.db, ctx.schoolCode) })
  }

  // 학교 scheduleRevision이 미리보기 뒤 올랐어도(수강 변경 등) 바로 막지 않음: 지금 자료로 계획을 다시 계산해
  // 미리보기와 같은 계획(해시 — 수업·차시 쓰기, 제외 수업, 교사 후보 매핑)일 때만 진행
  for (let attempt = 1; ; attempt++) {
    const a = await analyze(ctx, ref, batch)
    const errors = a.issues.filter((i) => i.severity === 'error').length
    const review = a.issues.filter((i) => i.severity === 'review').length
    if (errors) {
      fail(422, 'has-errors', `오류 ${errors}건을 원본에서 고친 뒤 다시 올려 주세요. 오류가 있는 자료는 시간표로 발행하지 않아요.`, { errors, review })
    }
    if (review && !acceptReview) {
      fail(409, 'needs-review', `확인이 필요한 항목 ${review}건이 있어요. 해당 수업을 빼고 발행하려면 검토 항목 제외에 동의해 주세요.`, {
        review,
        excluded: excludedList(a),
      })
    }
    if (a.digest !== batch.previewDigest) {
      fail(409, 'stale-revision', '미리보기 이후 수업·교사 자료가 바뀌었어요. 미리보기를 다시 확인해 주세요.', { revision: a.revision })
    }

    // 해시 확인 뒤 연결 확인((이름키, uid) 쌍 — 서버가 다시 계산한 그 이름의 후보에 있는 것만)·발행 교사를 얹은 최종 계획
    const fin = finalPlan(a, confirm, ctx.uid, catalog)
    // 계획 저장(재시도 시 같은 계획으로 이어서 진행 — 확인 목록도 계획에 들어 있어 이어서 할 때 다시 받지 않음).
    // knownSeries: 묶음의 수업마다 계획 때 있던 차시 id — 이어서 발행할 때 그 뒤 새로 생긴 차시를 찾는 데 씀
    const packs = packOps(fin.plan.items, OPS_PER_WRITE)
    const exById: Record<string, ExistingCourse> = Object.create(null)
    a.existing.forEach((c) => (exById[c.courseId] = c))
    for (let i = 0; i < packs.length; i++) {
      const knownSeries: Record<string, string[]> = {}
      packs[i].forEach((o) => {
        if (!knownSeries[o.courseId]) knownSeries[o.courseId] = exById[o.courseId] ? exById[o.courseId].series.map((s) => s.seriesId).sort() : []
      })
      await ref.collection('plan').doc(pad(i)).set({ index: i, ops: stripUndefined(packs[i]), knownSeries })
    }
    const items = fin.plan.items
    const attemptId = randomUUID()
    const raced = await ctx.db.runTransaction(async (tx) => {
      const bs = await tx.get(ref)
      const b = bs.data() || {}
      if (b.status !== 'staged') fail(409, 'in-progress', '다른 요청이 이 배치를 처리하고 있어요.')
      const rev = await readRevision(tx, ctx.db, ctx.schoolCode)
      // 분석과 이 트랜잭션 사이에 학교 버전이 또 바뀌면(수업 변경일 수도 있음) 처음부터 다시 분석
      if (rev !== a.revision) return rev
      await assertNoOtherBusy(tx, ctx, ref.id)
      tx.update(ref, {
        status: 'committing',
        attemptId,
        leaseAt: nowMs(),
        commitBy: ctx.uid,
        acceptReview,
        commitFromRevision: a.revision,
        courseRevision: a.revision + 1,
        planChunkCount: packs.length,
        opCount: fin.plan.opCount,
        confirmedTeacherUids: fin.accepted,
        confirmedTeacherLinks: fin.acceptedLinks,
        // 받아들이지 않은 확인은 개수만(클라이언트가 보낸 임의 uid — 학생 uid일 수도 있어 저장하지 않음)
        ignoredTeacherCount: fin.ignored,
        // 학생 '수업 담기' 공개 선택(없으면 null — 예전 동작)
        catalogOption: catalog,
        progress: 0,
        created: items.filter((i) => i.status === 'new').map((i) => i.courseId),
        updated: items.filter((i) => i.status === 'update').map((i) => i.courseId),
        retired: items.filter((i) => i.status === 'retire').map((i) => i.courseId),
        unchangedCount: items.filter((i) => i.status === 'same').length,
        excluded: excludedList(a),
        error: null,
        updatedAt: FieldValue.serverTimestamp(),
      })
      return null
    })
    if (raced === null) return runChunksAndFinish(ctx, ref, attemptId, 0, packs.length)
    if (attempt >= 3) fail(409, 'stale-revision', '방금 다른 시간표 변경이 있었어요. 잠시 후 다시 시도해 주세요.', { revision: raced })
  }
}

// ───────────────────────── cancel ─────────────────────────

async function cancel(ctx: Ctx) {
  requireTeacher(ctx)
  const { ref } = await loadBatch(ctx)
  await ctx.db.runTransaction(async (tx) => {
    const b = (await tx.get(ref)).data() || {}
    if (b.status === 'cancelled') return
    if (b.status !== 'staged') fail(409, 'bad-status', `${statusKo(b.status)} 배치는 취소할 수 없어요. 발행된 배치는 원복을 사용해 주세요.`, { status: b.status })
    tx.update(ref, { status: 'cancelled', cancelledBy: ctx.uid, cancelledAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
  })
  return { batchId: ref.id, status: 'cancelled' }
}

// ───────────────────────── rollback ─────────────────────────

async function rollback(ctx: Ctx) {
  requireTeacher(ctx)
  const expectedRevision = expectedRevisionField(ctx.body)
  const { ref, batch } = await loadBatch(ctx)
  if (batch.status === 'rolled-back') {
    return {
      batchId: ref.id,
      status: 'rolled-back',
      revision: batch.rollbackRevision ?? null,
      restored: batch.restored || [],
      skipped: batch.skipped || [],
      alreadyRolledBack: true,
    }
  }
  if (batch.status === 'rolling-back' && leaseFresh(batch)) fail(409, 'in-progress', '이 배치를 원복하는 중이에요. 잠시 후 결과를 확인해 주세요.')
  if (batch.status === 'committing' && leaseFresh(batch)) fail(409, 'in-progress', '이 배치를 발행하는 중이에요. 잠시 후 결과를 확인해 주세요.')
  // 'committing'이고 임대가 끝난 배치(발행 도중 함수가 끊김)도 원복 가능 — 반영된 묶음(progress)까지만 되돌림
  if (['committed', 'failed', 'committing', 'rolling-back', 'rollback-failed'].indexOf(batch.status) < 0) {
    fail(409, 'bad-status', `${statusKo(batch.status)} 배치는 원복할 수 없어요.`, { status: batch.status })
  }
  if ((batch.status === 'failed' || batch.status === 'committing') && typeof batch.planChunkCount !== 'number') fail(409, 'bad-status', '반영된 내용이 없는 배치예요.')
  const current = await currentRevision(ctx.db, ctx.schoolCode)
  if (current !== expectedRevision) fail(409, 'stale-revision', '화면을 연 뒤 시간표가 바뀌었어요. 새로고침한 뒤 다시 시도해 주세요.', { revision: current })

  const attemptId = randomUUID()
  const applied = await ctx.db.runTransaction(async (tx) => {
    const b = (await tx.get(ref)).data() || {}
    const okStatus =
      b.status === 'committed' ||
      b.status === 'failed' ||
      b.status === 'rollback-failed' ||
      ((b.status === 'rolling-back' || b.status === 'committing') && !leaseFresh(b))
    if (!okStatus) fail(409, 'in-progress', '다른 요청이 이 배치를 처리하고 있어요.')
    await assertNoOtherBusy(tx, ctx, ref.id)
    // 원복 대상: 발행 완료면 계획 전부, 중단됐으면 반영된 묶음까지
    const appliedChunks =
      typeof b.rollbackChunks === 'number'
        ? b.rollbackChunks
        : b.status === 'committed'
          ? Number(b.planChunkCount) || 0
          : Number(b.progress) || 0
    tx.update(ref, {
      status: 'rolling-back',
      rollbackAttempt: attemptId,
      rollbackChunks: appliedChunks,
      rollbackFromStatus: b.rollbackFromStatus || b.status,
      leaseAt: nowMs(),
      rollbackBy: ctx.uid,
      updatedAt: FieldValue.serverTimestamp(),
    })
    return appliedChunks
  })

  try {
    const ops: WriteOp[] = []
    for (let i = 0; i < applied; i++) {
      const snap = await ref.collection('plan').doc(pad(i)).get()
      const list = snap.exists ? snap.get('ops') : null
      if (!Array.isArray(list)) throw new Error(`plan chunk ${i} missing`)
      list.forEach((o: WriteOp) => ops.push(o))
    }
    const validFrom = String(batch.validFrom) as Ymd
    const byCourse: Record<string, WriteOp[]> = Object.create(null)
    ops.forEach((o) => (byCourse[o.courseId] = byCourse[o.courseId] || []).push(o))
    const sref = schoolRef(ctx.db, ctx.schoolCode)
    const restored: string[] = []
    const skipped: Array<{ courseId: string; title: string; reason: string }> = []
    const toWrite: WriteOp[] = []
    const courseIds = Object.keys(byCourse).sort()
    for (const ids of chunk(courseIds, 20)) {
      const refs: DocumentReference[] = []
      ids.forEach((cid) => byCourse[cid].forEach((o) => refs.push(sref.collection(o.target === 'course' ? 'courses' : 'series').doc(o.id))))
      const snaps = await ctx.db.getAll(...refs)
      const cur: Record<string, Record<string, unknown> | null> = Object.create(null)
      snaps.forEach((s) => (cur[`${s.ref.parent.id}/${s.id}`] = s.exists ? s.data() || {} : null))
      ids.forEach((cid) => {
        const list = byCourse[cid]
        const docOf = (o: WriteOp) => cur[`${o.target === 'course' ? 'courses' : 'series'}/${o.id}`]
        const pending: WriteOp[] = []
        let bad = false
        list.forEach((o) => {
          const d = docOf(o)
          if (docMatches(d, o.set)) pending.push(o)
          else if (!docMatches(d, undoSetOf(o, validFrom))) bad = true // 이미 원복된 것도, 이번 배치가 쓴 값도 아님 → 이후에 바뀜
        })
        const courseOp = list.find((o) => o.target === 'course')
        const title = courseOp && typeof courseOp.set.title === 'string' ? courseOp.set.title : cid
        if (bad) {
          skipped.push({ courseId: cid, title, reason: '가져오기 이후 다른 배치나 수동 수정으로 바뀐 수업이라 건드리지 않았어요.' })
          return
        }
        pending.forEach((o) => toWrite.push(o))
        restored.push(cid)
      })
    }
    for (const part of chunk(toWrite, 400)) {
      const wb = ctx.db.batch()
      part.forEach((o) => writeOp(wb, ctx, { ...o, kind: 'update', set: undoSetOf(o, validFrom) }, { rolledBackBy: ref.id }))
      await wb.commit()
      await ref.update({ leaseAt: nowMs() })
    }
    return await ctx.db.runTransaction(async (tx) => {
      const b = (await tx.get(ref)).data() || {}
      if (b.status !== 'rolling-back' || b.rollbackAttempt !== attemptId) fail(409, 'in-progress', '다른 요청이 이 배치를 처리하고 있어요.')
      const rev = await readRevision(tx, ctx.db, ctx.schoolCode)
      const newRev = toWrite.length ? rev + 1 : rev
      if (toWrite.length) writeRevision(tx, ctx.db, ctx.schoolCode, newRev)
      tx.update(ref, {
        status: 'rolled-back',
        rollbackRevision: newRev,
        restored,
        skipped,
        rolledBackAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        leaseAt: null,
        error: null,
      })
      writeAudit(tx, ctx.db, ctx.schoolCode, {
        action: 'timetable-import.rollback',
        actorUid: ctx.uid,
        target: `importBatches/${ref.id}`,
        revision: newRev,
        meta: { restored: restored.length, skipped: skipped.length, writes: toWrite.length, fileName: b.fileName },
      })
      return { batchId: ref.id, status: 'rolled-back', revision: newRev, restored, skipped }
    })
  } catch (e) {
    if (e instanceof ImportApiError) throw e
    console.error('timetable-import: rollback failed', ref.id, String((e as Error)?.message || '').slice(0, 200))
    await ref.update({ status: 'rollback-failed', error: '원복 중단', leaseAt: null }).catch(() => undefined)
    fail(500, 'rollback-failed', '원복 중 문제가 생겨 멈췄어요. 다시 시도하면 남은 부분을 이어서 원복해요.')
  }
}

// ───────────────────────── list ─────────────────────────

const msOf = (v: any): number | null => (v && typeof v.toMillis === 'function' ? v.toMillis() : null)

async function list(ctx: Ctx) {
  requireTeacher(ctx)
  const snap = await batchesRef(ctx).orderBy('createdAt', 'desc').limit(20).get()
  return {
    batches: snap.docs.map((d) => {
      const b = d.data() || {}
      return {
        batchId: d.id,
        status: b.status,
        fileName: b.fileName || null,
        termId: b.termId || null,
        validFrom: b.validFrom || null,
        mode: b.mode || null,
        rowCount: b.rowCount || 0,
        duplicateOf: b.duplicateOf || null,
        createdAt: msOf(b.createdAt),
        createdByName: b.createdByName || null,
        committedAt: msOf(b.committedAt),
        commitRevision: b.commitRevision ?? null,
        rolledBackAt: msOf(b.rolledBackAt),
        counts: {
          created: (b.created || []).length,
          updated: (b.updated || []).length,
          retired: (b.retired || []).length,
          excluded: (b.excluded || []).length,
          restored: (b.restored || []).length,
          skipped: (b.skipped || []).length,
        },
        previewStats: b.previewStats || null,
        progress: b.status === 'failed' || b.status === 'committing' ? { done: b.progress || 0, total: b.planChunkCount || 0 } : null,
        // 발행·원복 중인데 임대가 끝남(함수가 끊김) — 이어서 발행하거나 원복할 수 있음
        stalled: (b.status === 'committing' || b.status === 'rolling-back') && !leaseFresh(b),
      }
    }),
  }
}

// ───────────────────────── 진입점 ─────────────────────────

const ACTIONS: Record<string, (ctx: Ctx) => Promise<unknown>> = { stage, preview, commit, cancel, rollback, list }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'private, no-store')
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return apiError(res, 405, 'method-not-allowed', '허용되지 않는 요청이에요.')
  }
  let u: ApiUser | null
  try {
    u = await requireUser(req, res)
  } catch (e) {
    console.error('timetable-import: auth failed', String((e as Error)?.message || '').slice(0, 200))
    return apiError(res, 500, 'server-error', '사용자 정보를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.')
  }
  if (!u) return
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, any>) : {}
  const action = typeof body.action === 'string' ? body.action : ''
  const run = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null
  if (!run) return apiError(res, 400, 'bad-action', '알 수 없는 요청이에요.')
  if (u.user.role !== 'teacher') return apiError(res, 403, 'forbidden', '같은 학교 선생님만 시간표를 가져올 수 있어요.')
  const schoolCode = typeof u.user.schoolCode === 'string' ? u.user.schoolCode : ''
  if (!schoolCode) return apiError(res, 403, 'no-school', '학교가 확인된 교사 계정만 시간표를 가져올 수 있어요.')

  const ctx: Ctx = { u, db: u.db, uid: u.uid, schoolCode, body }
  try {
    return res.status(200).json(await run(ctx))
  } catch (e) {
    if (e instanceof ImportApiError) return res.status(e.status).json({ error: e.message, code: e.code, ...(e.extra || {}) })
    console.error('timetable-import: failed', action, String((e as Error)?.message || '').slice(0, 200))
    return apiError(res, 500, 'server-error', '처리하지 못했어요. 잠시 후 다시 시도해 주세요.')
  }
}
