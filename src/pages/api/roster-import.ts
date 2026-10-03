import type { NextApiRequest, NextApiResponse } from 'next'
import { createHash } from 'crypto'
import {
  FieldValue,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type QuerySnapshot,
} from 'firebase-admin/firestore'
import {
  apiError,
  chunk,
  cleanText,
  enrollmentId,
  GROUP_RE,
  ID_RE,
  isTeacher,
  readRevision,
  requireUser,
  schoolRef,
  termForDate,
  writeAudit,
  writeRevision,
  type ApiUser,
} from '../../lib/timetable/server'
import { isYmd } from '../../lib/timetable/dates'
import { compareKey, normalizeRosterRow, ROSTER_MAX_ROWS, type RosterRowInput } from '../../lib/timetable/importRows'
import { splitSectionPrefix } from '../../lib/timetable/importMatch'

// POST /api/roster-import — 학생별 수강 명단 (요구 문서 14장)
// Header: Authorization: Bearer <Firebase ID token>
// Body: { action: 'stage' | 'preview' | 'commit' | 'cancel' | 'link' | 'list', ... }
//
// 원칙
// - 시간표(수업·차시)와 수강 관계는 별개. 명단이 없으면 학생에게 선택 수업을 만들지 않음.
// - 수업 연결: 같은 학교·학기 수업 중 수업 코드(가져오기 importKey 'code|…'의 코드·code·courseCode) 또는
//   (과목+분반(+교사))로 '정확히 하나'일 때만. 코드로 못 찾으면(코드 없이 가져온 수업 등) 과목·분반·교사로 다시 찾음.
//   과목이 'A_영어'처럼 분반 접두어 표기이고 분반 열이 없으면 시간표 가져오기(splitSectionPrefix)와 같은 규칙으로 나눠 비교.
//   못 찾거나 여럿이면 검토 대상으로 남기고 추정하지 않음.
// - 학생 연결: 이름으로 하지 않음. 같은 학교·같은 소속 학급(classes '{학교}_{학년}_{반}'에 승인된 학생)·
//   같은 번호(users.studentId)인 학생이 정확히 한 명일 때 '연결 후보'로만 보여 주고,
//   담임(그 학생의 소속 학급) 또는 그 수업 담당 교사가 link로 확정해야 수강(enrollment)이 생김.
// - 미가입 학생 행은 미연결로 보관(rosterEntries). 나중에 가입·승인되면 list({unlinked:true})에 후보로 보임.
// - 권한은 users/{uid}(role, schoolCode)와 대상 문서로 서버가 판정. 실패는 { error, code } + HTTP 상태.
// - 로그·감사 기록에 토큰·학생 명단(이름·uid 목록)을 남기지 않음.
// 저장 위치: 임시 적재 schools/{s}/rosterBatches/{batchId}(+ rows/{00000}), 확정 행 schools/{s}/rosterEntries/{re_…},
//   수강 schools/{s}/enrollments/{courseId}__{uid}. (시간표 가져오기 배치 importBatches와 섞이지 않게 따로 둠)

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } }

const LINK_MAX = 100
const LIST_MAX = 3000
const TERM_ID_RE = /^[A-Za-z0-9_-]{1,40}$/

class HttpError extends Error {
  status: number
  code: string
  extra?: Record<string, unknown>
  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex')

/** 출석 번호: 없거나 숫자가 아니면 null (class-roster.ts와 같은 규칙) */
function toStudentNo(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

const homeroomIdOf = (schoolCode: string, grade: number, classNm: number) => `${schoolCode}_${grade}_${classNm}`

/** 명단 행의 '수업 표기' — 같은 학생·같은 표기는 다시 올려도 같은 명단 행(문서 id)이 됨 */
function courseRefOf(r: RosterRowInput): string {
  if (r.courseCode) return `code:${compareKey(r.courseCode)}`
  return `subj:${compareKey(r.subject)}|${compareKey(r.section)}|${compareKey(r.teacher)}`
}

function entryIdOf(termId: string, homeroomId: string, number: number, courseRef: string): string {
  return `re_${sha1(`${termId}|${homeroomId}|${number}|${courseRef}`).slice(0, 28)}`
}

// ───────────────────────── 수업 매칭 ─────────────────────────

interface CourseIndexItem {
  id: string
  title: string
  subjectKey: string
  sectionKey: string
  teacherKeys: string[]
  ended: boolean
  teacherUids: string[]
  managerUids: string[]
  /** 수업 문서에서 알 수 있는 학년(grade·grades·classLabels·commonForHomerooms). 비면 학년 정보 없음 */
  grades: number[]
}

/** 수업 문서의 학년 정보 — 다른 학년의 같은 과목 수업과 섞이지 않게(학년 정보가 없는 수업은 거르지 않음) */
function courseGrades(c: DocumentData): number[] {
  const out = new Set<number>()
  const add = (v: unknown) => {
    const n = Number(v)
    if (Number.isInteger(n) && n >= 1 && n <= 12) out.add(n)
  }
  add(c.grade)
  if (Array.isArray(c.grades)) c.grades.forEach(add)
  strList(c.classLabels).forEach((l) => add(l.split('-')[0]))
  strList(c.commonForHomerooms).forEach((h) => {
    const m = /_(\d{1,2})_\d{1,2}$/.exec(h)
    if (m) add(m[1])
  })
  return Array.from(out)
}

interface CourseIndex {
  items: CourseIndexItem[]
  byCode: Map<string, string[]>
  hasCodes: boolean
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** 수업 코드 비교 키 — 가져오기 importKey의 코드는 NFKC(전각→반각)로 정리돼 있어 명단 쪽도 같게 */
function codeKeyOf(v: unknown): string {
  let s = typeof v === 'string' ? v : ''
  try {
    s = s.normalize('NFKC')
  } catch {
    // normalize가 없는 환경 — 그대로
  }
  return compareKey(s)
}

/**
 * 수업 문서의 수업 코드들: 시간표 가져오기가 코드로 만든 수업은 importKey가 'code|<코드>'(코드 자체는 문서에 따로 없음),
 * 직접 넣은 code·courseCode, 그리고 '|'가 없는 importKey(예전·수동 자료의 코드). 'sec|…'·'hr|…' 같은 가져오기 키는 코드가 아님
 */
function courseCodesOf(c: DocumentData): string[] {
  const out = new Set<string>()
  const add = (v: unknown) => {
    const k = codeKeyOf(v)
    if (k) out.add(k)
  }
  if (typeof c.importKey === 'string') {
    if (c.importKey.startsWith('code|')) add(c.importKey.slice(5))
    else if (c.importKey.indexOf('|') < 0) add(c.importKey)
  }
  add(c.code)
  add(c.courseCode)
  return Array.from(out)
}

async function loadCourseIndex(db: Firestore, schoolCode: string, termId: string): Promise<CourseIndex> {
  const snap = await schoolRef(db, schoolCode).collection('courses').where('termId', '==', termId).get()
  const items: CourseIndexItem[] = []
  const byCode = new Map<string, string[]>()
  snap.forEach((d) => {
    const c = d.data()
    const subject = String(c.subject || c.title || '')
    items.push({
      id: d.id,
      title: String(c.title || c.subject || '수업'),
      subjectKey: compareKey(subject),
      sectionKey: compareKey(c.section ? String(c.section) : ''),
      teacherKeys: strList(c.teacherNames).map((n) => compareKey(n)),
      ended: c.status === 'ended',
      teacherUids: strList(c.teacherUids),
      managerUids: strList(c.managerUids),
      grades: courseGrades(c),
    })
    // 가져오기가 남긴 수업 코드(importKey 'code|…')나 원본 수업 코드
    courseCodesOf(c).forEach((k) => {
      const list = byCode.get(k) || []
      list.push(d.id)
      byCode.set(k, list)
    })
  })
  return { items, byCode, hasCodes: byCode.size > 0 }
}

type CourseMatchStatus = 'matched' | 'not-found' | 'ambiguous' | 'ended'

interface CourseMatch {
  status: CourseMatchStatus
  via: 'code' | 'subject'
  courseId?: string
  title?: string
  candidates: number
  /**
   * 'section-missing': 명단에 분반이 없어 같은 과목의 분반 수업 중 어느 것인지 정할 수 없음
   * 'section-mismatch': 분반 열과 과목명 분반 접두어('A_영어')가 달라 어느 쪽인지 정할 수 없음
   */
  hint?: 'section-missing' | 'section-mismatch'
}

function matchCourse(r: RosterRowInput, idx: CourseIndex): CourseMatch {
  let via: CourseMatch['via'] = 'subject'
  let cands: CourseIndexItem[] = []
  let hint: CourseMatch['hint']
  const gradeOk = (c: CourseIndexItem) => c.grades.length === 0 || c.grades.includes(r.grade)
  if (r.courseCode) {
    const ids = idx.byCode.get(codeKeyOf(r.courseCode)) || []
    const byCode = idx.items.filter((c) => ids.includes(c.id))
    // 코드로 찾은 수업이 있으면(여럿이면 모호 — 과목으로 다시 고르지 않음) 그것으로. 못 찾았고 과목이 있으면
    // (코드 없이 가져온 수업·코드 열이 다른 표기인 학교) 아래 과목·분반·교사로 다시 찾음
    if (byCode.length > 0 || !r.subject) {
      via = 'code'
      cands = byCode
    }
  }
  if (via === 'subject' && r.subject) {
    // 분반 열이 없고 과목이 'A_영어'처럼 분반 접두어 표기면 시간표 가져오기와 같은 규칙으로 과목 '영어'·분반 'A'로 나눔
    // (명단 행 id(courseRefOf)는 원문 그대로 — 이미 저장한 행이 바뀌지 않게 비교에서만)
    const pre = splitSectionPrefix(r.subject)
    if (pre.section && r.section && compareKey(pre.section) !== compareKey(r.section)) {
      // 분반 열과 접두어가 다르면 어느 쪽도 고르지 않고 검토로(importMatch의 'section-mismatch'와 같은 판단)
      return { status: 'ambiguous', via, candidates: 0, hint: 'section-mismatch' }
    }
    const rt = r.teacher ? compareKey(r.teacher) : ''
    const teacherOk = (c: CourseIndexItem) => !rt || c.teacherKeys.includes(rt)
    const find = (subjectKey: string, sectionKey: string) =>
      idx.items.filter(
        (c) =>
          // 과목·분반이 둘 다 같거나, 분반 열이 없을 때 '영어B'처럼 과목에 붙여 쓴 경우만(표기 차이) 같은 수업 후보
          ((c.subjectKey === subjectKey && c.sectionKey === sectionKey) ||
            (!sectionKey && c.sectionKey !== '' && c.subjectKey + c.sectionKey === subjectKey)) &&
          teacherOk(c) &&
          gradeOk(c)
      )
    const rs = compareKey(pre.section ? pre.subject : r.subject)
    const rsec = compareKey(pre.section || r.section)
    cands = find(rs, rsec)
    // 접두어까지 과목명으로 저장한 예전·수동 수업('A_영어' 그대로)은 원문으로도 찾음(이전과 같은 결과)
    if (cands.length === 0 && pre.section && !r.section) cands = find(compareKey(r.subject), '')
    if (cands.length === 0 && !rsec) {
      // 분반이 없는 행: 같은 과목의 분반 수업이 있으면 어느 분반인지 모름 → 검토(임의로 고르지 않음)
      const sameSubject = idx.items.filter((c) => c.subjectKey === rs && c.sectionKey !== '' && teacherOk(c) && gradeOk(c) && !c.ended)
      if (sameSubject.length > 0) return { status: 'ambiguous', via, candidates: sameSubject.length, hint: 'section-missing' }
    }
  }
  const active = cands.filter((c) => !c.ended)
  if (active.length === 1) return { status: 'matched', via, courseId: active[0].id, title: active[0].title, candidates: 1 }
  if (active.length > 1) return { status: 'ambiguous', via, candidates: active.length, ...(hint ? { hint } : {}) }
  if (cands.length > 0) return { status: 'ended', via, candidates: cands.length, title: cands.length === 1 ? cands[0].title : undefined }
  return { status: 'not-found', via, candidates: 0 }
}

// ───────────────────────── 학생 후보 ─────────────────────────

interface HomeroomStudent {
  uid: string
  name: string
  number: number | null
}

type HomeroomCache = Map<string, Promise<HomeroomStudent[]>>

/** 소속 학급에 '승인된' 학생(수업 그룹·다른 학교 문서 제외) */
function homeroomStudents(db: Firestore, schoolCode: string, homeroomId: string, cache: HomeroomCache): Promise<HomeroomStudent[]> {
  const hit = cache.get(homeroomId)
  if (hit) return hit
  const p = db
    .collection('users')
    .where('classId', '==', homeroomId)
    .get()
    .then((snap) => {
      const out: HomeroomStudent[] = []
      snap.forEach((d) => {
        const v = d.data()
        if (v.role !== 'student' || v.status !== 'approved') return
        if (v.schoolCode && String(v.schoolCode) !== schoolCode) return
        out.push({ uid: d.id, name: String(v.name || v.displayName || ''), number: toStudentNo(v.studentId) })
      })
      return out
    })
  cache.set(homeroomId, p)
  return p
}

interface StudentCandidate {
  status: 'candidate' | 'none' | 'ambiguous'
  uid?: string
  name?: string
  /** 명단 이름과 계정 이름이 같은지(명단에 이름이 없으면 null). 다르면 경고만 — 연결 근거 아님 */
  nameMatches?: boolean | null
  /** 후보가 없을 때: 그 반에 번호가 비어 있는 승인 학생 수(번호 입력이 필요할 수 있음) */
  withoutNumber?: number
}

function findCandidate(students: HomeroomStudent[], number: number, rosterName?: string | null): StudentCandidate {
  const same = students.filter((s) => s.number === number)
  if (same.length === 1) {
    const s = same[0]
    const nameMatches = rosterName ? compareKey(rosterName) === compareKey(s.name) : null
    return { status: 'candidate', uid: s.uid, name: s.name, nameMatches }
  }
  if (same.length > 1) return { status: 'ambiguous' }
  return { status: 'none', withoutNumber: students.filter((s) => s.number === null).length }
}

// ───────────────────────── 공통 ─────────────────────────

function userSchool(u: ApiUser, body: Record<string, any>): string {
  const mine = String(u.user.schoolCode || '')
  if (body.schoolCode !== undefined && body.schoolCode !== null && String(body.schoolCode) !== mine) {
    throw new HttpError(403, 'school-mismatch', '우리 학교 명단만 다룰 수 있어요.')
  }
  return mine
}

function batchIdOf(body: Record<string, any>): string {
  const id = typeof body.batchId === 'string' ? body.batchId : ''
  if (!ID_RE.test(id)) throw new HttpError(400, 'bad-batch-id', '명단 묶음 id가 올바르지 않아요.')
  return id
}

async function loadRosterBatch(db: Firestore, schoolCode: string, batchId: string) {
  const ref = schoolRef(db, schoolCode).collection('rosterBatches').doc(batchId)
  const snap = await ref.get()
  if (!snap.exists || snap.get('kind') !== 'roster') {
    throw new HttpError(404, 'batch-not-found', '명단 묶음을 찾을 수 없어요. 파일을 다시 올려 주세요.')
  }
  return { ref, snap }
}

function cleanMapping(v: unknown): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  if (!v || typeof v !== 'object') return out
  const keys = ['studentKey', 'grade', 'classNm', 'number', 'name', 'courseCode', 'subject', 'section', 'teacher']
  for (const k of keys) {
    const c = (v as Record<string, unknown>)[k]
    out[k] = typeof c === 'number' && Number.isInteger(c) && c >= 0 && c < 1000 ? c : null
  }
  return out
}

// ───────────────────────── stage / preview ─────────────────────────

interface StagedRow {
  row: number
  error?: string
  data?: RosterRowInput
  homeroomId?: string
  courseRef?: string
  entryId?: string
  course?: CourseMatch
  duplicateOf?: number
}

interface RowView {
  row: number
  error?: string
  grade?: number
  classNm?: number
  number?: number
  name?: string
  studentKey?: string
  courseCode?: string
  subject?: string
  section?: string
  teacher?: string
  homeroomId?: string
  course?: CourseMatch
  student?: StudentCandidate
  /** 이미 저장된 명단 행인지: 'new' | 'existing' | 'linked'(이미 학생과 연결됨) */
  entry?: 'new' | 'existing' | 'linked'
  entryId?: string
  duplicateOf?: number
}

interface PreviewStats {
  total: number
  valid: number
  errors: number
  duplicates: number
  courseMatched: number
  courseNotFound: number
  courseAmbiguous: number
  courseEnded: number
  linkCandidates: number
  nameMismatch: number
  unregistered: number
  studentAmbiguous: number
  existing: number
  alreadyLinked: number
}

/** 저장된 행 → 화면 자료(학생 후보·기존 명단 행은 지금 다시 계산) */
async function buildPreview(db: Firestore, schoolCode: string, staged: StagedRow[]) {
  const cache: HomeroomCache = new Map()
  const entriesRef = schoolRef(db, schoolCode).collection('rosterEntries')
  const ids = staged.filter((s) => s.entryId && !s.duplicateOf).map((s) => s.entryId as string)
  const existing = new Map<string, DocumentData>()
  for (const part of chunk(Array.from(new Set(ids)), 300)) {
    const snaps = await db.getAll(...part.map((id) => entriesRef.doc(id)))
    snaps.forEach((s) => {
      if (s.exists) existing.set(s.id, s.data() || {})
    })
  }
  const stats: PreviewStats = {
    total: staged.length,
    valid: 0,
    errors: 0,
    duplicates: 0,
    courseMatched: 0,
    courseNotFound: 0,
    courseAmbiguous: 0,
    courseEnded: 0,
    linkCandidates: 0,
    nameMismatch: 0,
    unregistered: 0,
    studentAmbiguous: 0,
    existing: 0,
    alreadyLinked: 0,
  }
  const rows: RowView[] = []
  for (const s of staged) {
    if (s.error || !s.data) {
      stats.errors++
      rows.push({ row: s.row, error: s.error || '행을 읽지 못했어요.' })
      continue
    }
    const d = s.data
    const view: RowView = {
      row: s.row,
      grade: d.grade,
      classNm: d.classNm,
      number: d.number,
      homeroomId: s.homeroomId,
      course: s.course,
      entryId: s.entryId,
    }
    ;(['name', 'studentKey', 'courseCode', 'subject', 'section', 'teacher'] as const).forEach((k) => {
      if (d[k]) view[k] = d[k]
    })
    if (s.duplicateOf) {
      stats.duplicates++
      view.duplicateOf = s.duplicateOf
      rows.push(view)
      continue
    }
    stats.valid++
    const c = s.course
    if (c?.status === 'matched') stats.courseMatched++
    else if (c?.status === 'ambiguous') stats.courseAmbiguous++
    else if (c?.status === 'ended') stats.courseEnded++
    else stats.courseNotFound++
    const ex = s.entryId ? existing.get(s.entryId) : undefined
    if (ex && typeof ex.linkedUid === 'string' && ex.linkedUid) {
      view.entry = 'linked'
      stats.alreadyLinked++
    } else {
      view.entry = ex ? 'existing' : 'new'
      if (ex) stats.existing++
      const students = await homeroomStudents(db, schoolCode, s.homeroomId as string, cache)
      const cand = findCandidate(students, d.number, d.name)
      view.student = cand
      if (cand.status === 'candidate') {
        stats.linkCandidates++
        if (cand.nameMatches === false) stats.nameMismatch++
      } else if (cand.status === 'ambiguous') stats.studentAmbiguous++
      else stats.unregistered++
    }
    rows.push(view)
  }
  return { stats, rows }
}

async function stage(u: ApiUser, body: Record<string, any>, res: NextApiResponse) {
  const db = u.db
  const schoolCode = userSchool(u, body)
  const validFrom = body.validFrom
  if (!isYmd(validFrom)) throw new HttpError(400, 'bad-valid-from', '적용 시작일(YYYYMMDD)을 확인해 주세요.')
  const fileHash = typeof body.fileHash === 'string' ? body.fileHash.toLowerCase() : ''
  if (!/^[a-f0-9]{64}$/.test(fileHash)) throw new HttpError(400, 'bad-file-hash', '파일 확인값(sha256)이 올바르지 않아요.')
  const fileName = cleanText(body.fileName, 200) || '이름 없는 파일'
  if (!Array.isArray(body.rows) || body.rows.length === 0) throw new HttpError(400, 'no-rows', '명단에 읽을 행이 없어요.')
  if (body.rows.length > ROSTER_MAX_ROWS) {
    throw new HttpError(413, 'too-many-rows', `한 번에 ${ROSTER_MAX_ROWS}행까지 올릴 수 있어요. 파일을 나눠 올려 주세요.`, {
      limit: ROSTER_MAX_ROWS,
    })
  }
  let termId: string
  if (body.termId !== undefined && body.termId !== null && body.termId !== '') {
    if (typeof body.termId !== 'string' || !TERM_ID_RE.test(body.termId)) throw new HttpError(400, 'bad-term', '학기 id가 올바르지 않아요.')
    termId = body.termId
  } else {
    termId = (await termForDate(db, schoolCode, validFrom)).termId
  }

  const idx = await loadCourseIndex(db, schoolCode, termId)
  const staged: StagedRow[] = []
  const firstByKey = new Map<string, number>()
  ;(body.rows as unknown[]).forEach((raw, i) => {
    const { row, error } = normalizeRosterRow(raw)
    const fallbackRow = Number((raw as any)?.row)
    if (!row) {
      staged.push({ row: Number.isInteger(fallbackRow) && fallbackRow > 0 ? fallbackRow : i + 2, error: error || '행을 읽지 못했어요.' })
      return
    }
    const homeroomId = homeroomIdOf(schoolCode, row.grade, row.classNm)
    const courseRef = courseRefOf(row)
    const course = matchCourse(row, idx)
    const s: StagedRow = { row: row.row, data: row, homeroomId, courseRef, course, entryId: entryIdOf(termId, homeroomId, row.number, courseRef) }
    // 같은 학생·같은 수업이 파일에 두 번 → 하나로 합침
    const dupKey = `${homeroomId}|${row.number}|${course.status === 'matched' ? `id:${course.courseId}` : courseRef}`
    const first = firstByKey.get(dupKey)
    if (first !== undefined) s.duplicateOf = first
    else firstByKey.set(dupKey, row.row)
    staged.push(s)
  })

  const issues: { code: string; severity: 'info' | 'warning'; message: string; batchId?: string }[] = []
  if (idx.items.length === 0) {
    issues.push({
      code: 'no-courses-in-term',
      severity: 'warning',
      message: `${termId} 학기에 등록된 수업이 없어요. 먼저 시간표를 가져오거나 수업을 만든 뒤 명단을 올리면 수업과 연결돼요.`,
    })
  }
  if (staged.some((s) => s.data?.courseCode) && !idx.hasCodes) {
    issues.push({
      code: 'code-unavailable',
      severity: 'info',
      message: '이 학기 수업에 수업 코드가 저장돼 있지 않아 과목·분반·교사로 찾았어요.',
    })
  }
  const prev = await schoolRef(db, schoolCode).collection('rosterBatches').where('fileHash', '==', fileHash).get()
  const prevCommitted = prev.docs.find((d) => d.get('kind') === 'roster' && d.get('status') === 'committed')
  if (prevCommitted) {
    issues.push({
      code: 'same-file',
      severity: 'info',
      message: '같은 파일을 이미 반영한 적이 있어요. 다시 반영해도 명단 행은 늘어나지 않아요.',
      batchId: prevCommitted.id,
    })
  }

  const { stats, rows } = await buildPreview(db, schoolCode, staged)

  // 임시 적재(운영 수강에는 아직 아무것도 반영하지 않음)
  const batchRef = schoolRef(db, schoolCode).collection('rosterBatches').doc()
  await batchRef.set({
    kind: 'roster',
    status: 'staged',
    schoolCode,
    termId,
    validFrom,
    fileName,
    fileHash,
    mapping: cleanMapping(body.mapping),
    rowCount: staged.length,
    stats,
    createdBy: u.uid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  })
  for (let start = 0; start < staged.length; start += 400) {
    const wb = db.batch()
    staged.slice(start, start + 400).forEach((s, j) => {
      // 문서 id = 파일 안 순서(0부터) — 미리보기를 다시 불러와도 같은 순서
      const docId = String(start + j).padStart(5, '0')
      const data: Record<string, unknown> = { row: s.row }
      if (s.error) data.error = s.error
      if (s.data) data.data = { ...s.data }
      if (s.homeroomId) data.homeroomId = s.homeroomId
      if (s.courseRef) data.courseRef = s.courseRef
      if (s.entryId) data.entryId = s.entryId
      if (s.course) data.course = JSON.parse(JSON.stringify(s.course))
      if (s.duplicateOf) data.duplicateOf = s.duplicateOf
      wb.set(batchRef.collection('rows').doc(docId), data)
    })
    await wb.commit()
  }
  return res.status(200).json({ batchId: batchRef.id, status: 'staged', termId, validFrom, stats, rows, issues })
}

async function readStagedRows(ref: DocumentReference): Promise<StagedRow[]> {
  const snap = await ref.collection('rows').orderBy('__name__').get()
  return snap.docs.map((d) => {
    const v = d.data()
    const s: StagedRow = { row: Number(v.row) || 0 }
    if (v.error) s.error = String(v.error)
    if (v.data) s.data = v.data as RosterRowInput
    if (v.homeroomId) s.homeroomId = String(v.homeroomId)
    if (v.courseRef) s.courseRef = String(v.courseRef)
    if (v.entryId) s.entryId = String(v.entryId)
    if (v.course) s.course = v.course as CourseMatch
    if (v.duplicateOf) s.duplicateOf = Number(v.duplicateOf)
    return s
  })
}

async function preview(u: ApiUser, body: Record<string, any>, res: NextApiResponse) {
  const schoolCode = userSchool(u, body)
  const batchId = batchIdOf(body)
  const { ref, snap } = await loadRosterBatch(u.db, schoolCode, batchId)
  const staged = await readStagedRows(ref)
  const { stats, rows } = await buildPreview(u.db, schoolCode, staged)
  return res.status(200).json({
    batchId,
    status: snap.get('status'),
    termId: snap.get('termId'),
    validFrom: snap.get('validFrom'),
    fileName: snap.get('fileName'),
    stats,
    rows,
    issues: [],
  })
}

// ───────────────────────── commit / cancel ─────────────────────────

async function commit(u: ApiUser, body: Record<string, any>, res: NextApiResponse) {
  const db = u.db
  const schoolCode = userSchool(u, body)
  const batchId = batchIdOf(body)
  const { ref } = await loadRosterBatch(db, schoolCode, batchId)

  // 상태 전환(staged → committing)을 트랜잭션으로 — 두 번 눌러도 한 번만 진행
  const begin = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref)
    const status = s.get('status')
    if (status === 'committed') return { already: true, data: s.data() || {} }
    if (status === 'cancelled') throw new HttpError(409, 'batch-cancelled', '취소한 명단 묶음이에요. 파일을 다시 올려 주세요.')
    if (status !== 'staged' && status !== 'committing') throw new HttpError(409, 'bad-batch-state', '반영할 수 없는 상태예요.')
    const errors = Number(s.get('stats.errors') || 0)
    if (errors > 0 && body.excludeErrorRows !== true) {
      throw new HttpError(422, 'has-errors', `읽지 못한 행이 ${errors}개 있어요. 파일을 고쳐 다시 올리거나 '오류 행 제외하고 저장'을 선택해 주세요.`, {
        errors,
      })
    }
    tx.update(ref, { status: 'committing', commitStartedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
    return { already: false, data: s.data() || {} }
  })
  if (begin.already) {
    return res.status(200).json({ batchId, status: 'committed', already: true, result: begin.data.result || null })
  }
  const termId = String(begin.data.termId || '')
  const validFrom = String(begin.data.validFrom || '')
  const staged = await readStagedRows(ref)
  const toSave = staged.filter((s) => s.data && s.entryId && !s.duplicateOf && !s.error)
  const entriesRef = schoolRef(db, schoolCode).collection('rosterEntries')
  const existing = new Map<string, DocumentData>()
  for (const part of chunk(toSave.map((s) => s.entryId as string), 300)) {
    const snaps = await db.getAll(...part.map((id) => entriesRef.doc(id)))
    snaps.forEach((x) => {
      if (x.exists) existing.set(x.id, x.data() || {})
    })
  }
  let created = 0
  let updated = 0
  for (const part of chunk(toSave, 400)) {
    const wb = db.batch()
    part.forEach((s) => {
      const d = s.data as RosterRowInput
      const c = s.course
      const base: Record<string, unknown> = {
        schoolCode,
        termId,
        validFrom,
        batchId,
        row: s.row,
        homeroomId: s.homeroomId,
        grade: d.grade,
        classNm: d.classNm,
        number: d.number,
        name: d.name || null,
        studentKey: d.studentKey || null,
        courseCode: d.courseCode || null,
        subject: d.subject || null,
        section: d.section || null,
        teacher: d.teacher || null,
        courseRef: s.courseRef,
        courseId: c?.status === 'matched' ? c.courseId : null,
        courseTitle: c?.status === 'matched' ? c.title || null : null,
        courseIssue: c?.status === 'matched' ? null : c?.status || 'not-found',
        updatedAt: FieldValue.serverTimestamp(),
      }
      const ref2 = entriesRef.doc(s.entryId as string)
      const ex = existing.get(s.entryId as string)
      if (ex) {
        // 이미 학생과 연결된 행이면 연결 정보는 그대로 둠(다시 올려도 연결이 풀리지 않음)
        if (ex.linkedUid && base.courseId !== ex.courseId) {
          // 연결된 수강과 다른 수업으로 바뀌면 덮지 않고 검토로
          base.courseId = ex.courseId ?? null
          base.courseTitle = ex.courseTitle ?? null
          base.pendingCourseChange = c?.status === 'matched' ? c.courseId : null
        }
        wb.set(ref2, base, { merge: true })
        updated++
      } else {
        wb.set(ref2, { ...base, linkedUid: null, linkStatus: 'unlinked', createdBy: u.uid, createdAt: FieldValue.serverTimestamp() })
        created++
      }
    })
    await wb.commit()
  }
  const result = {
    created,
    updated,
    skippedErrors: staged.filter((s) => s.error).length,
    duplicates: staged.filter((s) => s.duplicateOf).length,
    unmatchedCourse: toSave.filter((s) => s.course?.status !== 'matched').length,
  }
  const fin = db.batch()
  fin.update(ref, {
    status: 'committed',
    committedBy: u.uid,
    committedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    result,
  })
  writeAudit(fin, db, schoolCode, {
    action: 'roster-import-commit',
    actorUid: u.uid,
    target: `rosterBatches/${batchId}`,
    meta: { termId, ...result },
  })
  await fin.commit()
  return res.status(200).json({ batchId, status: 'committed', result })
}

async function cancel(u: ApiUser, body: Record<string, any>, res: NextApiResponse) {
  const db = u.db
  const schoolCode = userSchool(u, body)
  const batchId = batchIdOf(body)
  const { ref } = await loadRosterBatch(db, schoolCode, batchId)
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref)
    const status = s.get('status')
    if (status === 'cancelled') return
    if (status !== 'staged') throw new HttpError(409, 'already-committed', '이미 저장한 명단은 취소할 수 없어요.')
    tx.update(ref, { status: 'cancelled', cancelledBy: u.uid, updatedAt: FieldValue.serverTimestamp() })
  })
  return res.status(200).json({ batchId, status: 'cancelled' })
}

// ───────────────────────── link ─────────────────────────

type LinkStatus =
  | 'linked'
  | 'enrollment-exists'
  | 'already-linked'
  | 'not-found'
  | 'course-unresolved'
  | 'course-missing'
  | 'course-ended'
  | 'forbidden'
  | 'no-candidate'
  | 'ambiguous'

async function homeroomTeachers(db: Firestore, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const part of chunk(ids, 100)) {
    const snaps = await db.getAll(...part.map((id) => db.collection('classes').doc(id)))
    snaps.forEach((s) => {
      if (s.exists && s.get('isGroup') !== true && typeof s.get('teacherId') === 'string') out.set(s.id, s.get('teacherId'))
    })
  }
  return out
}

async function link(u: ApiUser, body: Record<string, any>, res: NextApiResponse) {
  const db = u.db
  const schoolCode = userSchool(u, body)
  if (body.confirm !== true) throw new HttpError(400, 'confirm-required', '연결을 확정하려면 확인이 필요해요.')
  const rawIds: unknown[] = Array.isArray(body.entryIds) ? body.entryIds : []
  if (rawIds.length === 0 || rawIds.some((x) => typeof x !== 'string' || !ID_RE.test(x))) {
    throw new HttpError(400, 'bad-entry-ids', '연결할 명단 행을 골라 주세요.')
  }
  const entryIds = Array.from(new Set(rawIds as string[]))
  if (entryIds.length > LINK_MAX) throw new HttpError(413, 'too-many', `한 번에 ${LINK_MAX}명까지 연결할 수 있어요.`)

  const sref = schoolRef(db, schoolCode)
  const entrySnaps = await db.getAll(...entryIds.map((id) => sref.collection('rosterEntries').doc(id)))
  const entries = new Map<string, DocumentData>()
  entrySnaps.forEach((s) => {
    if (s.exists) entries.set(s.id, s.data() || {})
  })
  const courseIds = Array.from(new Set(Array.from(entries.values()).map((e) => e.courseId).filter((x): x is string => typeof x === 'string' && !!x)))
  const courses = new Map<string, DocumentData>()
  for (const part of chunk(courseIds, 100)) {
    const snaps = await db.getAll(...part.map((id) => sref.collection('courses').doc(id)))
    snaps.forEach((s) => {
      if (s.exists) courses.set(s.id, s.data() || {})
    })
  }
  const homeroomIds = Array.from(new Set(Array.from(entries.values()).map((e) => String(e.homeroomId || '')).filter(Boolean)))
  const hrTeacher = await homeroomTeachers(db, homeroomIds)
  const cache: HomeroomCache = new Map()

  const results: { entryId: string; status: LinkStatus; message?: string }[] = []
  const plan: { entryId: string; uid: string; courseId: string; termId: string; validFrom: string | null }[] = []
  for (const id of entryIds) {
    const e = entries.get(id)
    if (!e) {
      results.push({ entryId: id, status: 'not-found', message: '명단 행을 찾을 수 없어요.' })
      continue
    }
    const homeroomId = String(e.homeroomId || '')
    const courseId = typeof e.courseId === 'string' ? e.courseId : ''
    const course = courseId ? courses.get(courseId) : undefined
    const isHomeroomTeacher = !!homeroomId && hrTeacher.get(homeroomId) === u.uid
    const isCourseTeacher = !!course && (strList(course.teacherUids).includes(u.uid) || strList(course.managerUids).includes(u.uid))
    if (!isHomeroomTeacher && !isCourseTeacher) {
      results.push({ entryId: id, status: 'forbidden', message: '그 학생의 담임이나 그 수업 담당 교사만 연결할 수 있어요.' })
      continue
    }
    if (e.linkedUid) {
      results.push({ entryId: id, status: 'already-linked' })
      continue
    }
    if (!courseId) {
      results.push({ entryId: id, status: 'course-unresolved', message: '어느 수업인지 확인되지 않은 행이에요.' })
      continue
    }
    if (!course) {
      results.push({ entryId: id, status: 'course-missing', message: '수업이 삭제됐어요.' })
      continue
    }
    if (course.status === 'ended') {
      results.push({ entryId: id, status: 'course-ended', message: '종료된 수업이에요.' })
      continue
    }
    const number = Number(e.number)
    const students = await homeroomStudents(db, schoolCode, homeroomId, cache)
    const cand = findCandidate(students, number, null)
    if (cand.status === 'ambiguous') {
      results.push({ entryId: id, status: 'ambiguous', message: '같은 반에 같은 번호 학생이 여럿이에요. 학생 번호를 먼저 바로잡아 주세요.' })
      continue
    }
    if (cand.status !== 'candidate' || !cand.uid) {
      results.push({ entryId: id, status: 'no-candidate', message: '그 반·번호로 승인된 학생이 아직 없어요.' })
      continue
    }
    plan.push({
      entryId: id,
      uid: cand.uid,
      courseId,
      termId: String(course.termId || e.termId || ''),
      validFrom: isYmd(e.validFrom) ? e.validFrom : null,
    })
  }

  let revision: number | null = null
  let created = 0
  if (plan.length > 0) {
    const out = await db.runTransaction(async (tx) => {
      const rev = await readRevision(tx, db, schoolCode)
      const entryRefs = plan.map((p) => sref.collection('rosterEntries').doc(p.entryId))
      const enrRefs = plan.map((p) => sref.collection('enrollments').doc(enrollmentId(p.courseId, p.uid)))
      const fresh: DocumentSnapshot[] = await tx.getAll(...entryRefs)
      const enrs: DocumentSnapshot[] = await tx.getAll(...enrRefs)
      const txResults: { entryId: string; status: LinkStatus }[] = []
      let made = 0
      const seenEnr = new Set<string>()
      plan.forEach((p, i) => {
        if (fresh[i].get('linkedUid')) {
          txResults.push({ entryId: p.entryId, status: 'already-linked' })
          return
        }
        const enrKey = enrRefs[i].path
        if (enrs[i].exists || seenEnr.has(enrKey)) {
          // 이미 있는 수강은 그대로(상태·출처를 바꾸지 않음) — 명단 행만 그 학생과 연결
          txResults.push({ entryId: p.entryId, status: 'enrollment-exists' })
        } else {
          tx.set(enrRefs[i], {
            courseId: p.courseId,
            uid: p.uid,
            schoolCode,
            termId: p.termId,
            status: 'active',
            from: p.validFrom,
            to: null,
            source: 'roster',
            rosterEntryId: p.entryId,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            decidedBy: u.uid,
          })
          made++
          txResults.push({ entryId: p.entryId, status: 'linked' })
        }
        seenEnr.add(enrKey)
        tx.update(entryRefs[i], {
          linkedUid: p.uid,
          linkStatus: 'linked',
          linkedBy: u.uid,
          linkedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        })
      })
      const next = made > 0 ? rev + 1 : rev
      if (made > 0) writeRevision(tx, db, schoolCode, next)
      writeAudit(tx, db, schoolCode, {
        action: 'roster-link',
        actorUid: u.uid,
        target: 'rosterEntries',
        revision: next,
        meta: {
          requested: entryIds.length,
          linked: txResults.filter((r) => r.status === 'linked' || r.status === 'enrollment-exists').length,
          enrollmentsCreated: made,
          courseIds: Array.from(new Set(plan.map((p) => p.courseId))).slice(0, 30),
        },
      })
      return { txResults, made, next }
    })
    revision = out.next
    created = out.made
    results.push(...out.txResults)
  }

  const order = new Map(entryIds.map((id, i) => [id, i] as [string, number]))
  results.sort((a, b) => (order.get(a.entryId) ?? 0) - (order.get(b.entryId) ?? 0))
  const linked = results.filter((r) => r.status === 'linked' || r.status === 'enrollment-exists').length
  if (linked === 0 && results.every((r) => r.status === 'forbidden')) {
    throw new HttpError(403, 'forbidden', '그 학생의 담임이나 그 수업 담당 교사만 연결할 수 있어요.', { results })
  }
  return res.status(200).json({ linked, enrollmentsCreated: created, revision, results })
}

// ───────────────────────── list ─────────────────────────

async function list(u: ApiUser, body: Record<string, any>, res: NextApiResponse) {
  const db = u.db
  const schoolCode = userSchool(u, body)
  const sref = schoolRef(db, schoolCode)
  const onlyUnlinked = body.unlinked === true

  // 내가 연결할 수 있는 범위: 내가 담임인 소속 학급 + 내가 담당(또는 관리)하는 수업
  const [hrSnap, tSnap, mSnap] = await Promise.all([
    db.collection('classes').where('teacherId', '==', u.uid).get(),
    sref.collection('courses').where('teacherUids', 'array-contains', u.uid).get(),
    sref.collection('courses').where('managerUids', 'array-contains', u.uid).get(),
  ])
  const myHomerooms = hrSnap.docs
    .filter((d) => d.get('isGroup') !== true && !GROUP_RE.test(d.id) && String(d.get('schoolCode') || d.id.split('_')[0]) === schoolCode)
    .map((d) => d.id)
  const myCourses = Array.from(new Set(tSnap.docs.map((d) => d.id).concat(mSnap.docs.map((d) => d.id))))

  const found = new Map<string, DocumentData>()
  if (typeof body.batchId === 'string' && body.batchId) {
    const batchId = batchIdOf(body)
    const s = await sref.collection('rosterEntries').where('batchId', '==', batchId).limit(LIST_MAX).get()
    s.forEach((d) => found.set(d.id, d.data()))
  } else {
    const queries: Promise<QuerySnapshot>[] = []
    chunk(myHomerooms, 30).forEach((ids) => queries.push(sref.collection('rosterEntries').where('homeroomId', 'in', ids).limit(LIST_MAX).get()))
    chunk(myCourses, 30).forEach((ids) => queries.push(sref.collection('rosterEntries').where('courseId', 'in', ids).limit(LIST_MAX).get()))
    const snaps = await Promise.all(queries)
    snaps.forEach((s) => s.forEach((d) => found.set(d.id, d.data())))
  }

  const cache: HomeroomCache = new Map()
  const hrSet = new Set(myHomerooms)
  const courseSet = new Set(myCourses)
  const entries: Record<string, unknown>[] = []
  let candidates = 0
  let unlinked = 0
  const all = Array.from(found.entries())
  for (const [id, e] of all) {
    const isLinked = typeof e.linkedUid === 'string' && !!e.linkedUid
    if (onlyUnlinked && isLinked) continue
    const homeroomId = String(e.homeroomId || '')
    const courseId = typeof e.courseId === 'string' ? e.courseId : null
    const canLink = hrSet.has(homeroomId) || (!!courseId && courseSet.has(courseId))
    let candidate: StudentCandidate | null = null
    if (!isLinked) {
      unlinked++
      if (courseId && canLink) {
        candidate = findCandidate(await homeroomStudents(db, schoolCode, homeroomId, cache), Number(e.number), e.name || null)
        if (candidate.status === 'candidate') candidates++
      }
    }
    entries.push({
      entryId: id,
      batchId: e.batchId || null,
      row: e.row ?? null,
      grade: e.grade,
      classNm: e.classNm,
      number: e.number,
      name: e.name || null,
      studentKey: e.studentKey || null,
      homeroomId,
      courseId,
      courseTitle: e.courseTitle || null,
      courseIssue: e.courseIssue || null,
      subject: e.subject || null,
      section: e.section || null,
      teacher: e.teacher || null,
      courseCode: e.courseCode || null,
      validFrom: e.validFrom || null,
      linkStatus: isLinked ? 'linked' : 'unlinked',
      linkedUid: isLinked ? e.linkedUid : null,
      candidate,
      canLink: canLink && !isLinked && !!courseId,
    })
  }
  entries.sort(
    (a: any, b: any) =>
      a.grade - b.grade || a.classNm - b.classNm || a.number - b.number || String(a.courseTitle || a.subject || '').localeCompare(String(b.courseTitle || b.subject || ''), 'ko')
  )
  return res.status(200).json({
    entries,
    counts: { total: entries.length, unlinked, candidates },
    scope: { homerooms: myHomerooms, courseCount: myCourses.length },
  })
}

// ───────────────────────── handler ─────────────────────────

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiError(res, 405, 'method-not-allowed', '허용되지 않는 요청입니다.')
  let u: ApiUser | null
  try {
    u = await requireUser(req, res)
  } catch (e) {
    console.error('roster-import auth error:', (e as Error)?.message)
    return apiError(res, 500, 'server-error', '사용자 정보를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.')
  }
  if (!u) return
  if (!isTeacher(u)) return apiError(res, 403, 'teacher-only', '학교가 등록된 교사 계정만 쓸 수 있어요.')
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>
  const action = typeof body.action === 'string' ? body.action : ''
  try {
    switch (action) {
      case 'stage':
        return await stage(u, body, res)
      case 'preview':
        return await preview(u, body, res)
      case 'commit':
        return await commit(u, body, res)
      case 'cancel':
        return await cancel(u, body, res)
      case 'link':
        return await link(u, body, res)
      case 'list':
        return await list(u, body, res)
      default:
        return apiError(res, 400, 'bad-action', '알 수 없는 요청이에요.')
    }
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, code: e.code, ...(e.extra || {}) })
    // 학생 명단·토큰을 남기지 않도록 메시지만
    console.error('roster-import error:', action, (e as Error)?.message)
    const msg = String((e as Error)?.message || '')
    if (/FAILED_PRECONDITION|index/i.test(msg)) {
      return apiError(res, 500, 'index-missing', '조회에 필요한 색인이 없어요. 관리자에게 알려 주세요.')
    }
    return apiError(res, 500, 'server-error', '명단 처리 중 오류가 났어요. 잠시 후 다시 시도해 주세요.')
  }
}
