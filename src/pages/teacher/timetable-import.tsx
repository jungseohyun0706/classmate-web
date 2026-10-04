import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/router'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth } from '../../lib/firebase'
import { useUI } from '../../components/ui/feedback'
import { addDays, formatYmdKo, isoToYmd, isYmd, schoolYmdAt, weekdayOf, ymdToIso } from '../../lib/timetable/dates'
import {
  colName,
  combinedHash,
  guessHeaderRow,
  IMPORT_ACCEPT,
  mapTableRows,
  normSpace,
  readImportFile,
  suggestTableMapping,
  TABLE_FIELDS,
  type ImportRow,
  type RowProblem,
  type TableMapping,
  type WorkbookSheet,
} from '../../lib/timetable/importRows'
import {
  detectImportSheets,
  extractImportRowsWithReport,
  type CellValue,
  type ImportSheetChoice,
  type ImportSheetInput,
  type SheetDetection,
} from '../../lib/timetableParser'

// 시간표 가져오기 → 수업·차시로 발행 (새 개인 시간표, 요구 문서 13장)
// 파일 선택 → 시트별 자료 유형 확인 → (표 형식이면) 열 매핑 → 학교·학기·적용 시작일·모드 → 임시 적재(stage)
// → 미리보기(preview) → 확정(commit) → 결과·되돌리기(rollback)
// - 파일은 브라우저에서만 읽어요(값만, 수식·매크로 실행 안 함). 서버에는 칸 단위 정리 행(ImportRow)만 보냅니다.
// - 확정 전에는 운영 시간표를 바꾸지 않고, 오류가 있으면 확정할 수 없어요.
// - 시간표만으로는 학생 개인 시간표가 생기지 않아요(수강 명단·초대·신청으로 수강 관계가 필요).
//   분반 없는 한 학급 수업은 '공통 수업 후보'로만 기록되고, 그 학급 담임이 수업 관리 화면에서 확인해야 학생에게 보여요.
// - 교사 이름(엑셀 이름)만으로 담당 권한을 주지 않아요: '교사 계정 연결 후보'에서 발행 교사가 체크한 계정만
//   그 엑셀 이름이 나오는 수업의 담당 교사(일정 변경·수강 관리)가 돼요. 체크는 기본 해제.
//   체크는 (엑셀 이름, 계정) 쌍으로 보냄 — 미리보기 뒤 누가 엑셀 이름(masterName)을 바꿔도 다른 이름의 수업에 연결되지 않게.
// 서버 계약: POST /api/timetable-import { action: 'stage'|'preview'|'commit'|'cancel'|'rollback'|'list', ... }
//            commit { batchId, expectedRevision, acceptReview?, confirmTeacherLinks?: { nameKey, uid }[],
//                     catalog?: { visible, policy } — 학생 '수업 담기' 목록 공개(기본 켬)·참여 방식(기본 바로 담기) }
//            (멈춘 발행 이어서 하기도 commit { batchId, expectedRevision } — 서버가 저장한 계획으로 이어서)

const IMPORT_MAX_ROWS = 5000 // 서버(/api/timetable-import) 한도와 같음
const DAY_KO = ['', '월', '화', '수', '목', '금', '토', '일']

interface ApiFailure {
  message: string
  code: string
  status: number
  body?: Record<string, unknown>
}

interface SourceRef {
  sheet?: string
  row?: number
  col?: number
}

interface IssueView {
  severity: 'error' | 'review' | 'warning' | 'info'
  code: string
  message: string
  fix?: string
  refs: SourceRef[]
}

interface LessonLine {
  weekday?: number
  period?: number
  start?: string
  end?: string
  room?: string
  classes: string[]
  status?: string
  refs: SourceRef[]
}

interface CourseView {
  key: string
  title: string
  status?: string
  teachers: string[]
  teacherUnlinked: boolean
  /** 'error' = 발행 불가, 'review' = 검토 확인 시 발행에서 제외 */
  blocked?: string
  classes: string[]
  /** 공통 수업 후보 학급 id(담임 확인 전) */
  commonPending: string[]
  /** 이미 담임이 공통 수업으로 확인한 학급 id */
  commonConfirmed: string[]
  lessons: LessonLine[]
  refs: SourceRef[]
}

interface TeacherCandidateView {
  uid: string
  name?: string
  emailMasked?: string
  /** 이전 확인으로 이미 연결된 수업 수 */
  linkedCourseCount: number
}

interface TeacherLinkView {
  /** 엑셀의 교사 이름 */
  name: string
  /** 엑셀 교사 이름의 비교 키(서버 nameKey) — 연결 확인은 (nameKey, uid) 쌍으로 보냄 */
  nameKey: string
  reason: string
  courseCount: number
  candidates: TeacherCandidateView[]
}

interface PreviewView {
  batchId: string
  revision: number | null
  termId?: string
  stats: { key: string; label: string; value: number; cls: string }[]
  errorCount: number
  reviewCount: number
  issues: IssueView[]
  courses: CourseView[]
  /** 적용 시작일부터 끝나는 기존 수업(교체 모드) */
  retiring: { title: string; seriesCount?: number }[]
  /** 엑셀 교사 이름별 연결 후보 계정(발행 교사가 확인해 체크) */
  teacherLinks: TeacherLinkView[]
  /** 후보 교사의 로그인 이메일을 확인하지 못함(사람 확인 불가) */
  teacherEmailError: boolean
  duplicateOf?: string
}

interface BatchView {
  batchId: string
  status: string
  fileName?: string
  createdAt?: number
  revision?: number
  counts?: string
  /** 발행·원복 중인데 임대가 끝남(함수가 끊김) — 이어서 발행하거나 되돌릴 수 있음 */
  stalled: boolean
  /** 멈춘 발행의 진행(반영한 묶음/전체) */
  progress?: { done: number; total: number }
}

interface ConfirmLink {
  nameKey: string
  uid: string
}

/** 연결 확인 체크 상태의 키: (엑셀 이름키, uid) */
const linkKey = (nameKey: string, uid: string) => `${nameKey}\u0000${uid}`
/** 서버 nameKey가 없을 때(이전 응답) — 서버 nameKey와 같은 규칙(NFKC, 공백 제거) */
const localNameKey = (v: string) => {
  let s = v
  try {
    s = s.normalize('NFKC')
  } catch {
    // normalize가 없는 환경 — 그대로
  }
  return s.replace(/\s+/g, '')
}

interface TableCfg {
  headerRow: number
  mapping: TableMapping
  numericWeekday: boolean
}

type FileInfo = { name: string; hash: string; bytes: number }

// ───────────────────────── 응답 읽기(서버 응답 필드 이름 차이를 견딤) ─────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : [])

function refsOf(o: any): SourceRef[] {
  if (!o || typeof o !== 'object') return []
  const list: any[] = []
  if (o.row !== undefined || o.sheet !== undefined) list.push({ sheet: o.sheet, row: o.row, col: o.col })
  ;[o.sources, o.refs, o.where, o.rows, o.source].forEach((v) => {
    if (Array.isArray(v)) list.push(...v)
    else if (v && typeof v === 'object') list.push(v)
  })
  const out: SourceRef[] = []
  list.forEach((x) => {
    const ref: SourceRef | null =
      typeof x === 'number' ? { row: x } : x && typeof x === 'object' ? { sheet: str(x.sheet), row: num(x.row), col: num(x.col) } : null
    if (ref && (ref.row !== undefined || ref.sheet)) out.push(ref)
  })
  return out
}

function severityOf(v: unknown): IssueView['severity'] {
  const s = String(v || '').toLowerCase()
  if (s === 'error' || s === 'blocking' || s === 'fatal') return 'error'
  if (s === 'review' || s === 'needs-review' || s === 'ambiguous' || s === 'conflict') return 'review'
  if (s === 'warning' || s === 'warn') return 'warning'
  return 'info'
}

const STAT_LABELS: { keys: string[]; label: string; cls: string }[] = [
  { keys: ['newCourses', 'new', 'created', 'added'], label: '새 수업', cls: 'bg-emerald-50 text-emerald-700' },
  { keys: ['updatedCourses', 'updated', 'changed'], label: '갱신 수업', cls: 'bg-blue-50 text-blue-700' },
  { keys: ['unchanged', 'same'], label: '같음(변경 없음)', cls: 'bg-gray-100 text-gray-700' },
  { keys: ['duplicatesMerged', 'merged', 'duplicates', 'deduped'], label: '중복 합침', cls: 'bg-gray-100 text-gray-700' },
  { keys: ['retiring', 'retired', 'ended', 'removed'], label: '적용일부터 끝남', cls: 'bg-gray-100 text-gray-700' },
  { keys: ['errors', 'error'], label: '오류', cls: 'bg-red-50 text-red-700' },
  { keys: ['review', 'needsReview'], label: '검토', cls: 'bg-amber-50 text-amber-700' },
  { keys: ['excluded'], label: '발행 제외(검토)', cls: 'bg-amber-50 text-amber-700' },
  { keys: ['unlinkedTeachers', 'teachersUnlinked', 'teacherUnlinked'], label: '계정 후보 없는 교사', cls: 'bg-amber-50 text-amber-700' },
  { keys: ['teacherLinkCandidates'], label: '계정 연결 후보 교사(확인 필요)', cls: 'bg-amber-50 text-amber-700' },
  { keys: ['rows'], label: '받은 칸', cls: 'bg-gray-100 text-gray-700' },
  { keys: ['lessons'], label: '차시(합친 뒤)', cls: 'bg-gray-100 text-gray-700' },
  { keys: ['restored'], label: '되돌림', cls: 'bg-blue-50 text-blue-700' },
  { keys: ['skipped'], label: '건너뜀(이후 수정됨)', cls: 'bg-amber-50 text-amber-700' },
]
const GROUP_LABEL: Record<string, string> = { courses: '수업', course: '수업', series: '차시', lessons: '차시', rows: '칸' }

function statsOf(raw: any): PreviewView['stats'] {
  const out: PreviewView['stats'] = []
  const add = (key: string, last: string, value: number, prefix: string) => {
    const known = STAT_LABELS.find((s) => s.keys.includes(last))
    out.push({ key, label: `${prefix}${known ? known.label : last}`, value, cls: known ? known.cls : 'bg-gray-100 text-gray-700' })
  }
  if (!raw || typeof raw !== 'object') return out
  Object.keys(raw).forEach((k) => {
    const v = raw[k]
    if (typeof v === 'number') add(k, k, v, '')
    else if (Array.isArray(v) && STAT_LABELS.some((s) => s.keys.includes(k))) add(k, k, v.length, '')
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.keys(v).forEach((k2) => {
        if (typeof v[k2] === 'number') add(`${k}.${k2}`, k2, v[k2], GROUP_LABEL[k] ? `${GROUP_LABEL[k]} ` : `${k} `)
      })
    }
  })
  return out
}

function statValue(raw: any, keys: string[]): number | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  for (const k of keys) if (typeof raw[k] === 'number') return raw[k]
  return undefined
}

function lessonOf(l: any): LessonLine {
  const classes = Array.isArray(l?.classLabels) ? l.classLabels.map(String) : str(l?.classLabel) ? String(l.classLabel).split(',') : []
  return {
    weekday: num(l?.weekday),
    period: num(l?.period),
    start: str(l?.start),
    end: str(l?.end),
    room: str(l?.roomName) ?? str(l?.room),
    classes,
    status: str(l?.status) ?? str(l?.action),
    refs: refsOf(l),
  }
}

function courseOf(c: any, i: number): CourseView {
  const title = str(c?.title) ?? ([str(c?.subject), str(c?.section)].filter(Boolean).join(' ') || str(c?.name) || `수업 ${i + 1}`)
  const teachers = arr(c?.teacherNames ?? c?.teachers).map((t: any) => (typeof t === 'string' ? t : str(t?.name) || '')).filter(Boolean)
  if (teachers.length === 0 && str(c?.teacher)) teachers.push(String(c.teacher))
  const common = arr(c?.commonForHomerooms).map(String)
  const candidates = arr(c?.commonCandidates).map(String)
  return {
    key: str(c?.importKey) ?? str(c?.courseId) ?? str(c?.key) ?? `${title}#${i}`,
    title,
    status: str(c?.status) ?? str(c?.action) ?? str(c?.change),
    teachers,
    teacherUnlinked: c?.teacherLinked === false || (Array.isArray(c?.teacherUids) && c.teacherUids.length === 0 && teachers.length > 0),
    blocked: str(c?.blocked),
    classes: arr(c?.classLabels).map(String),
    commonPending: candidates.filter((h: string) => !common.includes(h)),
    commonConfirmed: candidates.filter((h: string) => common.includes(h)),
    lessons: arr(c?.lessons ?? c?.series ?? c?.occurrences ?? c?.slots).map(lessonOf),
    refs: refsOf({ sources: c?.sources }),
  }
}

function previewOf(raw: any, batchId: string): PreviewView {
  const p = raw?.preview && typeof raw.preview === 'object' ? raw.preview : raw
  const issues: IssueView[] = arr(p?.issues).map((x: any) => ({
    severity: severityOf(x?.severity ?? x?.level ?? x?.kind ?? x?.type),
    code: str(x?.code) || '',
    message: str(x?.message) ?? str(x?.error) ?? str(x?.text) ?? '내용 없음',
    fix: str(x?.fix) ?? str(x?.hint) ?? str(x?.howToFix),
    refs: refsOf(x),
  }))
  const errorCount = statValue(p?.stats, ['errors', 'error']) ?? issues.filter((i) => i.severity === 'error').length
  const reviewCount = statValue(p?.stats, ['review', 'needsReview']) ?? issues.filter((i) => i.severity === 'review').length
  const rev = num(p?.revision) ?? num(raw?.revision)
  return {
    batchId: str(p?.batchId) ?? batchId,
    revision: rev === undefined ? null : rev,
    termId: str(p?.termId) ?? str(raw?.termId),
    stats: statsOf(p?.stats),
    errorCount,
    reviewCount,
    issues,
    courses: arr(p?.courses).map(courseOf),
    retiring: arr(p?.retiring).map((r: any) => ({ title: str(r?.title) || str(r?.courseId) || '수업', seriesCount: num(r?.seriesCount) })),
    teacherLinks: arr(p?.teacherLinks)
      .filter((l: any) => l && typeof l === 'object')
      .map((l: any) => ({
        name: str(l.name) || '?',
        nameKey: str(l.nameKey) || localNameKey(str(l.name) || ''),
        reason: str(l.reason) || 'no-account',
        courseCount: num(l.courseCount) ?? 0,
        candidates: arr(l.candidates)
          .filter((x: any) => x && str(x.uid))
          .map((x: any) => ({ uid: String(x.uid), name: str(x.name), emailMasked: str(x.emailMasked), linkedCourseCount: num(x.linkedCourseCount) ?? 0 })),
      })),
    teacherEmailError: p?.teacherEmailError === true,
    duplicateOf: str(p?.duplicateOf),
  }
}

/** 'S1_3_4' → '3학년 4반' (형식이 다르면 그대로) */
function homeroomText(id: string): string {
  const m = /_(\d{1,2})_(\d{1,2})$/.exec(id)
  return m ? `${Number(m[1])}학년 ${Number(m[2])}반` : id
}

function batchOf(b: any): BatchView | null {
  const id = str(b?.batchId) ?? str(b?.id)
  if (!id) return null
  const t = b?.createdAt
  const createdAt =
    typeof t === 'number' ? t : typeof t === 'string' ? Date.parse(t) : num(t?._seconds) !== undefined ? t._seconds * 1000 : num(t?.seconds) !== undefined ? t.seconds * 1000 : undefined
  const counts = b?.counts && typeof b.counts === 'object' ? statsOf(b.counts).filter((x) => x.value > 0) : []
  const done = num(b?.progress?.done)
  const total = num(b?.progress?.total)
  return {
    batchId: id,
    status: str(b?.status) || '?',
    fileName: str(b?.fileName),
    createdAt: Number.isFinite(createdAt as number) ? createdAt : undefined,
    revision: num(b?.commitRevision) ?? num(b?.revision),
    counts: counts.map((x) => `${x.label} ${x.value}`).join(' · ') || undefined,
    stalled: b?.stalled === true,
    progress: done !== undefined && total !== undefined ? { done, total } : undefined,
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const sheetShort = (name: string) => {
  const i = name.lastIndexOf('#')
  return i >= 0 ? name.slice(i + 1) : name
}
const refText = (r: SourceRef) => [r.sheet ? `'${sheetShort(r.sheet)}'` : '', r.row ? `${r.row}행` : '', r.col ? `${colName(r.col)}열` : ''].filter(Boolean).join(' ')

const STATUS_KO: Record<string, string> = {
  new: '새 수업',
  created: '새 수업',
  update: '갱신',
  updated: '갱신',
  changed: '갱신',
  same: '같음',
  unchanged: '같음',
  retire: '끝남',
  review: '검토',
  error: '오류',
  staged: '임시 저장',
  committing: '발행 중',
  committed: '발행됨',
  cancelled: '취소됨',
  'rolling-back': '되돌리는 중',
  'rolled-back': '되돌림',
  'rollback-failed': '되돌리기 중단',
  failed: '발행 중단',
}
const TEACHER_REASON_KO: Record<string, string> = {
  'no-account': '연결할 계정 후보 없음 — 이름만 표시',
  ambiguous: '같은 엑셀 이름을 쓰는 계정이 여럿 — 이메일로 실제 담당 선생님을 확인해 주세요',
  candidate: '',
}
/** 되돌릴 수 있는 배치 상태(서버 rollback 조건과 같음 — 'committing'·'rolling-back'은 임대가 끝난(stalled) 경우만) */
const ROLLBACKABLE = ['committed', 'failed', 'rollback-failed']
const canRollback = (b: BatchView) => ROLLBACKABLE.includes(b.status) || (b.stalled && (b.status === 'committing' || b.status === 'rolling-back'))
/** 멈춘 발행: 저장된 계획으로 이어서 발행할 수 있음 */
const canResume = (b: BatchView) => !!b.progress && b.progress.total > 0 && (b.status === 'failed' || (b.status === 'committing' && b.stalled))

const KIND_KO: Record<string, string> = { class: '학급 시간표', teacher: '교사 시간표', room: '특별실 시간표', mixed: '여러 종류 섞임', unknown: '알 수 없음' }

const CHOICE_OPTIONS: { value: ImportSheetChoice; label: string }[] = [
  { value: 'auto', label: '자동 판별대로' },
  { value: 'class', label: '학급(전체) 시간표' },
  { value: 'teacher', label: '교사 시간표' },
  { value: 'room', label: '특별실·교실 시간표' },
  { value: 'table', label: '표 형식(열 직접 지정)' },
  { value: 'skip', label: '사용 안 함' },
]

function nextMonday(today: string): string {
  let d = addDays(today, 1)
  while (weekdayOf(d) !== 1) d = addDays(d, 1)
  return d
}

const rowText = (r: ImportRow) =>
  [
    `${DAY_KO[r.weekday] || r.weekday} ${r.period}교시`,
    r.start ? `${r.start}${r.end ? `–${r.end}` : ''}` : '',
    r.classLabel || '',
    r.subject || '(과목 없음)',
    r.section ? `${r.section}반` : '',
    r.teacher || '',
    r.room || '',
  ]
    .filter(Boolean)
    .join(' · ')

async function postImport<T>(body: Record<string, unknown>): Promise<T> {
  const u = auth.currentUser
  if (!u) throw { message: '로그인이 필요해요. 다시 로그인해 주세요.', code: 'unauthenticated', status: 401 } as ApiFailure
  const token = await u.getIdToken()
  let resp: Response
  try {
    resp = await fetch('/api/timetable-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
  } catch {
    throw { message: '서버에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.', code: 'network', status: 0 } as ApiFailure
  }
  const json = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    throw {
      message: typeof json.error === 'string' ? json.error : `요청에 실패했어요 (HTTP ${resp.status})`,
      code: typeof json.code === 'string' ? json.code : `http-${resp.status}`,
      status: resp.status,
      body: json,
    } as ApiFailure
  }
  return json as T
}

const asFailure = (e: unknown): ApiFailure =>
  e && typeof e === 'object' && 'code' in e && 'message' in e
    ? (e as ApiFailure)
    : { message: (e as Error)?.message || '알 수 없는 오류가 났어요.', code: 'client-error', status: 0 }

export default function TimetableImportPage() {
  const router = useRouter()
  const { toast, confirm } = useUI()
  const today = useMemo(() => schoolYmdAt(Date.now()), [])

  const [loading, setLoading] = useState(true)
  const [me, setMe] = useState<{ schoolCode: string; schoolName: string } | null>(null)

  const [reading, setReading] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const [files, setFiles] = useState<FileInfo[]>([])
  const [sheets, setSheets] = useState<WorkbookSheet[]>([])
  const [choices, setChoices] = useState<Record<string, ImportSheetChoice>>({})
  const [tableCfg, setTableCfg] = useState<Record<string, TableCfg>>({})

  const [validFrom, setValidFrom] = useState(() => nextMonday(today))
  const [termId, setTermId] = useState('')
  const [mode, setMode] = useState<'merge' | 'replace'>('merge')

  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState<ApiFailure | null>(null)
  const [preview, setPreview] = useState<PreviewView | null>(null)
  const [acceptReview, setAcceptReview] = useState(false)
  /** 학생 '수업 담기' 목록에 공개(기본 켬) + 참여 방식(기본 바로 담기) — 새 수업과 가져오기가 공개 설정을 맡은 수업에만 적용 */
  const [publishCatalog, setPublishCatalog] = useState(true)
  const [catalogPolicy, setCatalogPolicy] = useState<'auto' | 'approval'>('auto')
  /** 교사 계정 연결 확인((엑셀 이름키, uid) → 체크). 기본 해제 */
  const [confirmLinks, setConfirmLinks] = useState<Record<string, boolean>>({})
  const [committed, setCommitted] = useState<{
    batchId: string
    revision: number | null
    stats: PreviewView['stats']
    already?: boolean
    /** 담당 교사로 연결한 계정(표시 이름) */
    linkedTeachers: string[]
    ignoredTeachers: number
    /** 담임 확인을 기다리는 공통 수업 후보 수 */
    commonPending: number
    /** 학생 '수업 담기' 공개 선택(발행할 때 보낸 값) */
    catalog: { visible: boolean; policy: 'auto' | 'approval' }
  } | null>(null)
  const [rolledBack, setRolledBack] = useState(false)
  const [batches, setBatches] = useState<BatchView[] | null>(null)
  const [batchesError, setBatchesError] = useState<ApiFailure | null>(null)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.replace('/auth/login')
        return
      }
      try {
        const { db } = await import('../../lib/firebase')
        const snap = await getDoc(doc(db, 'users', u.uid))
        const data = snap.exists() ? snap.data() : null
        // 화면 표시용 확인 — 실제 권한은 서버가 users 문서로 다시 판정
        if (!data || data.role !== 'teacher') {
          toast('교사 계정만 사용할 수 있어요.', 'error')
          router.replace('/dashboard')
          return
        }
        if (!data.schoolCode) {
          toast('먼저 학교/반을 등록해야 해요.', 'info')
          router.replace('/teacher/register-class')
          return
        }
        const next = { schoolCode: String(data.schoolCode), schoolName: String(data.schoolName || '') }
        // 같은 값이면 상태를 바꾸지 않음(라우터 객체가 바뀌어 이 효과가 다시 돌아도 목록을 다시 부르지 않게)
        setMe((prev) => (prev && prev.schoolCode === next.schoolCode && prev.schoolName === next.schoolName ? prev : next))
      } catch (e) {
        console.error('timetable-import: 내 정보 확인 실패', (e as Error)?.message)
        toast('내 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.', 'error')
      } finally {
        setLoading(false)
      }
    })
    return () => unsub()
  }, [router, toast])

  const loadBatches = useCallback(async () => {
    setBatchesError(null)
    try {
      const r = await postImport<{ batches?: unknown[]; items?: unknown[] }>({ action: 'list' })
      setBatches(arr(r.batches ?? r.items).map(batchOf).filter((b): b is BatchView => !!b))
    } catch (e) {
      setBatchesError(asFailure(e))
    }
  }, [])

  const meSchool = me ? me.schoolCode : ''
  useEffect(() => {
    if (meSchool) loadBatches()
  }, [meSchool, loadBatches])

  // ── 파일 읽기 ──
  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    const picked = Array.from(fileList) // input 초기화 전에 스냅숏
    setReading(true)
    setReadError(null)
    setPreview(null)
    setCommitted(null)
    setFailure(null)
    setRolledBack(false)
    try {
      const XLSX = await import('xlsx')
      const infos: FileInfo[] = []
      const all: WorkbookSheet[] = []
      for (const f of picked) {
        const r = await readImportFile(f, XLSX)
        infos.push({ name: f.name, hash: r.hash, bytes: r.bytes })
        r.sheets.forEach((s) => {
          if (s.grid.some((row) => (row || []).some((c) => normSpace(c) !== ''))) all.push(s)
        })
      }
      if (all.length === 0) throw new Error('파일에서 내용이 있는 시트를 찾지 못했어요.')
      const detections = detectImportSheets(all.map(toInput))
      const anyRecognized = detections.some((d) => d.layout !== 'none')
      const nextChoices: Record<string, ImportSheetChoice> = {}
      const nextCfg: Record<string, TableCfg> = {}
      all.forEach((s, i) => {
        const d = detections[i]
        const isCsv = /\.csv$/i.test(s.fileName)
        nextChoices[s.name] = d.layout !== 'none' ? 'auto' : isCsv || !anyRecognized ? 'table' : 'skip'
        const h = guessHeaderRow(s.grid)
        nextCfg[s.name] = { headerRow: h, mapping: suggestTableMapping(s.grid[h] || []), numericWeekday: false }
      })
      setFiles(infos)
      setSheets(all)
      setChoices(nextChoices)
      setTableCfg(nextCfg)
    } catch (e) {
      setReadError((e as Error)?.message || '파일을 읽지 못했어요.')
      setFiles([])
      setSheets([])
    } finally {
      setReading(false)
    }
  }

  // ── 칸 추출(브라우저 안) ──
  const extract = useMemo(() => extractImportRowsWithReport(sheets.map(toInput), { kinds: choices }), [sheets, choices])
  const detections: SheetDetection[] = extract.sheets

  const tableResults = useMemo(() => {
    const out: Record<string, { rows: ImportRow[]; problems: RowProblem[]; skipped: { blank: number; repeatedHeader: number } }> = {}
    sheets.forEach((s) => {
      if (choices[s.name] !== 'table') return
      const cfg = tableCfg[s.name]
      if (!cfg) return
      out[s.name] = mapTableRows(s.grid[cfg.headerRow] || [], s.grid.slice(cfg.headerRow + 1), cfg.mapping, {
        sheet: s.name,
        firstDataRow: s.origin.r + cfg.headerRow + 2,
        firstCol: s.origin.c + 1,
        numericWeekday: cfg.numericWeekday,
      })
    })
    return out
  }, [sheets, choices, tableCfg])

  const allRows = useMemo(() => {
    const rows = extract.rows.slice()
    Object.keys(tableResults).forEach((k) => rows.push(...tableResults[k].rows))
    return rows
  }, [extract, tableResults])
  const tableProblems = useMemo(() => {
    const list: RowProblem[] = []
    Object.keys(tableResults).forEach((k) => list.push(...tableResults[k].problems))
    return list
  }, [tableResults])
  const blocking = tableProblems.filter((p) => p.severity === 'error')
  const tableWarnings = tableProblems.filter((p) => p.severity === 'warning')
  const tooMany = allRows.length > IMPORT_MAX_ROWS
  const kindCounts = useMemo(() => {
    const c: Record<string, number> = { class: 0, teacher: 0, room: 0, table: 0 }
    allRows.forEach((r) => (c[r.sourceKind] = (c[r.sourceKind] || 0) + 1))
    return c
  }, [allRows])
  const tableSheets = sheets.filter((s) => choices[s.name] === 'table')

  const resetServerState = () => {
    setPreview(null)
    setCommitted(null)
    setFailure(null)
    setAcceptReview(false)
    setConfirmLinks({})
    setRolledBack(false)
  }

  // ── 서버 단계 ──
  const loadPreview = async (batchId: string) => {
    setBusy('미리보기를 만드는 중…')
    try {
      const raw = await postImport<Record<string, unknown>>({ action: 'preview', batchId })
      setPreview(previewOf(raw, batchId))
      setAcceptReview(false)
      setConfirmLinks({}) // 미리보기를 새로 만들면 연결 확인도 다시(기본 해제)
    } catch (e) {
      setFailure(asFailure(e))
    } finally {
      setBusy(null)
    }
  }

  const stage = async () => {
    if (!me || allRows.length === 0 || blocking.length > 0 || tooMany) return
    resetServerState()
    setBusy('파일 확인값을 계산하는 중…')
    let batchId = ''
    try {
      const fileHash = await combinedHash(files.map((f) => f.hash))
      setBusy(`정리한 칸 ${allRows.length.toLocaleString()}개를 서버에 임시로 올리는 중…`)
      const raw = await postImport<Record<string, any>>({
        action: 'stage',
        schoolCode: me.schoolCode,
        termId: termId.trim() || undefined,
        validFrom,
        mode,
        fileName: files.map((f) => f.name).join(', ').slice(0, 200),
        fileHash,
        rows: allRows,
        periodTimes: extract.periodTimes,
      })
      batchId = String(raw.batchId || '')
      if (!batchId) throw { message: '서버가 묶음 id를 돌려주지 않았어요.', code: 'bad-response', status: 0 } as ApiFailure
      // stage 응답에 미리보기가 같이 오면 그대로, 아니면 preview로 받음
      if (raw.stats || raw.issues || raw.courses || raw.preview) {
        setPreview(previewOf(raw, batchId))
        setConfirmLinks({})
        setBusy(null)
      } else {
        await loadPreview(batchId)
      }
    } catch (e) {
      setFailure(asFailure(e))
      setBusy(null)
    }
  }

  /** 화면에 지금 보이는 (엑셀 이름, 후보) 중 체크한 쌍만(미리보기가 바뀌면 사라진 후보는 보내지 않음) */
  const checkedLinks = useMemo((): ConfirmLink[] => {
    if (!preview) return []
    const out: ConfirmLink[] = []
    preview.teacherLinks.forEach((l) =>
      l.candidates.forEach((c) => {
        if (confirmLinks[linkKey(l.nameKey, c.uid)]) out.push({ nameKey: l.nameKey, uid: c.uid })
      })
    )
    return out
  }, [preview, confirmLinks])

  const commit = async () => {
    if (!preview) return
    if (preview.errorCount > 0) return
    if (preview.reviewCount > 0 && !acceptReview) return
    const pendingCommon = preview.courses.filter((c) => !c.blocked && c.commonPending.length > 0).length
    const ok = await confirm({
      title: '시간표 발행',
      description:
        `${formatYmdKo(validFrom)}부터 이 시간표를 학교 수업·차시로 발행해요.` +
        (preview.reviewCount > 0 ? ` 검토 항목 ${preview.reviewCount}건은 빼고 발행해요.` : '') +
        (checkedLinks.length > 0
          ? ` 체크한 교사 계정 ${checkedLinks.length}개를 그 엑셀 이름이 나오는 수업의 담당 교사(일정 변경·수강 관리 권한)로 연결해요.`
          : ' 교사 계정은 연결하지 않아요(이름만 표시).') +
        (publishCatalog
          ? ` 학생 '수업 담기' 목록에 공개해 학생이 직접 골라 담을 수 있어요(${catalogPolicy === 'auto' ? '바로 담기' : '선생님 승인 후'}).`
          : " 학생 '수업 담기' 목록에는 공개하지 않아요.") +
        ' 학생 시간표에는 학생이 담았거나 이미 수강 중이거나 담임이 공통 수업으로 확인한 수업만 반영돼요.' +
        (pendingCommon > 0 ? ` 공통 수업 후보 ${pendingCommon}개는 담임 확인 전까지 학생에게 보이지 않아요.` : ''),
      confirmText: '발행하기',
      danger: mode === 'replace',
    })
    if (!ok) return
    setBusy('발행하는 중…')
    setFailure(null)
    try {
      const raw = await postImport<Record<string, any>>({
        action: 'commit',
        batchId: preview.batchId,
        expectedRevision: preview.revision,
        acceptReview: preview.reviewCount > 0 ? acceptReview : false,
        confirmTeacherLinks: checkedLinks,
        catalog: { visible: publishCatalog, policy: catalogPolicy },
      })
      const rev = num(raw.revision)
      const nameOfUid: Record<string, string> = {}
      const nameOfLink: Record<string, string> = {}
      preview.teacherLinks.forEach((l) =>
        l.candidates.forEach((c) => {
          const who = `${c.name || l.name}${c.emailMasked ? ` (${c.emailMasked})` : ''}`
          nameOfUid[c.uid] = who
          nameOfLink[linkKey(l.nameKey, c.uid)] = `${l.name} → ${who}`
        })
      )
      const links = arr(raw.confirmedTeacherLinks).filter((x: any) => x && str(x.nameKey) && str(x.uid))
      setCommitted({
        batchId: preview.batchId,
        revision: rev === undefined ? null : rev,
        stats: statsOf(raw.stats ?? raw.result ?? { created: raw.created, updated: raw.updated, retired: raw.retired, excluded: raw.excluded, unchanged: raw.unchanged }),
        already: raw.already === true || raw.alreadyCommitted === true,
        linkedTeachers: links.length
          ? links.map((x: any) => nameOfLink[linkKey(String(x.nameKey), String(x.uid))] || nameOfUid[String(x.uid)] || '선생님')
          : arr(raw.confirmedTeacherUids).map((u: any) => nameOfUid[String(u)] || '선생님'),
        ignoredTeachers: num(raw.ignoredTeacherCount) ?? 0,
        commonPending: pendingCommon,
        catalog: { visible: publishCatalog, policy: catalogPolicy },
      })
      toast('시간표를 발행했어요.', 'success')
      loadBatches()
    } catch (e) {
      setFailure(asFailure(e))
    } finally {
      setBusy(null)
    }
  }

  const cancel = async () => {
    if (!preview) return
    setBusy('취소하는 중…')
    try {
      await postImport({ action: 'cancel', batchId: preview.batchId })
      resetServerState()
      toast('임시로 올린 시간표를 취소했어요. 아무것도 바뀌지 않았어요.', 'info')
      loadBatches()
    } catch (e) {
      setFailure(asFailure(e))
    } finally {
      setBusy(null)
    }
  }

  /** 학교 시간표 현재 버전(schools/{s}.scheduleRevision). 읽지 못하면 null */
  const currentRevision = async (): Promise<number | null> => {
    if (!me) return null
    try {
      const { db } = await import('../../lib/firebase')
      const snap = await getDoc(doc(db, 'schools', me.schoolCode))
      const v = snap.exists() ? Number(snap.get('scheduleRevision') || 0) : 0
      return Number.isFinite(v) ? v : null
    } catch {
      return null
    }
  }

  const rollback = async (batchId: string, fallbackRevision?: number | null) => {
    const ok = await confirm({
      title: '발행 되돌리기',
      description: '이 가져오기가 만든 수업·차시 변경만 되돌려요. 그 뒤에 다른 선생님이 고친 수업은 서버가 건너뛰고 알려 드려요.',
      confirmText: '되돌리기',
      danger: true,
    })
    if (!ok) return
    setBusy('되돌리는 중…')
    setFailure(null)
    let expected = await currentRevision()
    if (expected === null && typeof fallbackRevision === 'number') expected = fallbackRevision
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const raw = await postImport<Record<string, any>>({ action: 'rollback', batchId, expectedRevision: expected })
          if (committed?.batchId === batchId) setRolledBack(true)
          const skipped = arr(raw.skipped).length
          toast(skipped ? `되돌렸어요. 이후 수정된 수업 ${skipped}개는 건너뛰었어요.` : '발행을 되돌렸어요.', 'success')
          loadBatches()
          return
        } catch (e) {
          const f = asFailure(e)
          const latest = num(f.body?.revision)
          if (attempt === 0 && f.code === 'stale-revision' && latest !== undefined) {
            setBusy(null)
            const again = await confirm({
              title: '시간표가 그 사이 바뀌었어요',
              description: `지금 버전(${latest})을 기준으로 다시 되돌릴까요? 이 가져오기 뒤에 바뀐 수업은 서버가 건너뛰어요.`,
              confirmText: '다시 되돌리기',
              danger: true,
            })
            if (!again) return
            setBusy('되돌리는 중…')
            expected = latest
            continue
          }
          throw f
        }
      }
    } catch (e) {
      setFailure(asFailure(e))
    } finally {
      setBusy(null)
    }
  }

  /** 멈춘 발행 이어서 하기 — 서버가 저장한 계획으로 남은 묶음만(그 사이 그 수업·차시가 바뀌었으면 서버가 거절하고 원복 안내) */
  const resumeCommit = async (batchId: string) => {
    const ok = await confirm({
      title: '멈춘 발행 이어서 하기',
      description: '발행 도중 멈춘 시간표를 처음 확정한 내용 그대로 이어서 발행해요. 그 사이 다른 곳에서 바뀐 수업이 있으면 이어서 하지 않고 알려 드려요.',
      confirmText: '이어서 발행',
    })
    if (!ok) return
    setBusy('이어서 발행하는 중…')
    setFailure(null)
    try {
      // expectedRevision은 형식상 필요(이어서 하기는 학교 버전이 아니라 남은 수업·차시가 그대로인지로 판단)
      const expected = (await currentRevision()) ?? 0
      await postImport<Record<string, any>>({ action: 'commit', batchId, expectedRevision: expected })
      toast('멈춘 발행을 마쳤어요.', 'success')
      loadBatches()
    } catch (e) {
      setFailure(asFailure(e))
      loadBatches()
    } finally {
      setBusy(null)
    }
  }

  // 진행 단계 표시: 자료 유형(2)은 파일을 읽자마자 판별되고, 표 형식 매핑에 문제가 있으면 3에 머묾
  const step = committed
    ? 7
    : preview
      ? 6
      : busy && sheets.length > 0
        ? 5
        : sheets.length === 0
          ? 1
          : tableSheets.length > 0 && blocking.length > 0
            ? 3
            : 4
  const STEPS = ['파일', '자료 유형', '열 매핑', '적용 범위', '임시 적재', '미리보기', '확정·결과']

  if (loading) return <div className="p-10 text-center text-black">로딩 중...</div>
  if (!me) return <div className="p-10 text-center text-gray-600">교사 정보를 확인하지 못했어요. 새로고침해 주세요.</div>

  const updateCfg = (name: string, patch: Partial<TableCfg>) => {
    setTableCfg({ ...tableCfg, [name]: { ...tableCfg[name], ...patch } })
    resetServerState()
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4 sm:px-6">
      <div className="max-w-3xl mx-auto">
        <div className="flex justify-between items-start gap-3 mb-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900">시간표 가져오기 (수업·차시)</h1>
            <p className="text-sm text-gray-600 break-keep">
              {me.schoolName ? `${me.schoolName} — ` : ''}엑셀 시간표를 학교 수업·차시로 정리해 학생 개인 시간표의 기본 일정으로 발행해요.
            </p>
          </div>
          <button onClick={() => router.push('/dashboard')} className="shrink-0 min-h-[44px] text-gray-500 hover:text-gray-700 px-2">
            나가기
          </button>
        </div>

        <div className="rounded-xl bg-blue-50 border border-blue-100 p-4 mb-4 text-sm text-blue-900 leading-relaxed break-keep">
          · 학급·교사·특별실·전체 시간표를 함께 올려도 같은 수업은 하나로 합쳐요. 확신할 수 없는 칸은 검토로 따로 보여 드려요.
          <br />· 시간표만으로는 학생마다 듣는 수업을 알 수 없어요. 발행한 뒤 <b>수강 명단</b>이나 <b>수업 초대</b>로 학생을 연결하거나, 반 학생 모두가 듣는 수업은{' '}
          <b>담임이 공통 수업으로 확인</b>해야 개인 시간표에 보여요.
          <br />· 엑셀의 교사 이름만으로 담당 권한을 주지 않아요. 미리보기의 &lsquo;교사 계정 연결 후보&rsquo;에서 확인해 체크한 계정만 담당 교사가 돼요.
          <div className="mt-2 flex flex-wrap gap-2">
            <button onClick={() => router.push('/teacher/roster-import')} className="rounded-lg bg-white px-3 py-2 text-xs font-bold text-blue-700 ring-1 ring-blue-200">
              수강 명단 올리기 →
            </button>
            <button onClick={() => router.push('/teacher/upload-timetable')} className="rounded-lg bg-white px-3 py-2 text-xs font-bold text-gray-600 ring-1 ring-gray-200">
              기존 학급 시간표 등록 화면 →
            </button>
          </div>
        </div>

        <ol className="flex flex-wrap gap-1.5 mb-4 text-xs" aria-label="진행 단계">
          {STEPS.map((label, i) => (
            <li
              key={label}
              className={`px-2.5 py-1 rounded-full ${i + 1 === step ? 'bg-blue-600 text-white font-bold' : i + 1 < step ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'}`}
              aria-current={i + 1 === step ? 'step' : undefined}
            >
              {i + 1}. {label}
            </li>
          ))}
        </ol>
        {busy && (
          <div role="status" className="mb-4 rounded-lg bg-gray-900 text-white text-sm px-4 py-3 flex items-center gap-2">
            <span className="inline-block h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" aria-hidden />
            {busy}
          </div>
        )}

        {/* 1. 파일 */}
        <section className="bg-white shadow rounded-xl border border-gray-200 p-5 mb-4">
          <h2 className="font-bold text-gray-900 mb-1">1. 파일 선택</h2>
          <p className="text-sm text-gray-600 mb-3 break-keep">엑셀(.xlsx, .xls) 또는 CSV, 파일마다 최대 10MB. 여러 파일을 한 번에 골라도 돼요.</p>
          <label className="flex flex-col items-center justify-center border-2 border-dashed border-blue-300 rounded-xl py-8 cursor-pointer bg-blue-50/50 hover:bg-blue-50 transition">
            <span className="text-sm font-bold text-blue-700">{reading ? '읽는 중…' : files.length ? '다른 파일 선택' : '파일 선택 (여러 개 가능)'}</span>
            {files.length > 0 && <span className="mt-1 text-xs text-gray-500">{files.map((f) => f.name).join(', ')}</span>}
            <input
              type="file"
              accept={IMPORT_ACCEPT}
              multiple
              className="sr-only"
              disabled={reading || !!busy}
              onChange={(e) => {
                handleFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </label>
          {readError && <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{readError}</p>}
        </section>

        {/* 2. 시트별 자료 유형 */}
        {sheets.length > 0 && (
          <section className="bg-white shadow rounded-xl border border-gray-200 p-5 mb-4">
            <h2 className="font-bold text-gray-900 mb-1">2. 시트별 자료 유형</h2>
            <p className="text-xs text-gray-500 mb-3 break-keep">자동으로 판별한 결과예요. 실제 파일과 다르면 바꿔 주세요.</p>
            <ul className="space-y-3">
              {sheets.map((s, i) => {
                const d = detections[i]
                const sample = extract.rows.filter((r) => r.sheet === s.name).slice(0, 6)
                const tr = tableResults[s.name]
                return (
                  <li key={s.name} className="rounded-lg border border-gray-200 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-gray-900 break-all">{s.sheetName}</p>
                        <p className="text-xs text-gray-500 break-all">
                          {s.fileName} · {s.grid.length}행 · 판별: {d ? KIND_KO[d.detected] || d.detected : '-'}
                        </p>
                      </div>
                      <select
                        value={choices[s.name] || 'auto'}
                        onChange={(e) => {
                          setChoices({ ...choices, [s.name]: e.target.value as ImportSheetChoice })
                          resetServerState()
                        }}
                        className="rounded-lg border border-gray-300 px-2 py-2 text-sm"
                        aria-label={`${s.sheetName} 자료 유형`}
                      >
                        {CHOICE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    {d && <p className="mt-1 text-xs text-gray-500 break-keep">{d.note}</p>}
                    {choices[s.name] === 'skip' && <p className="mt-1 text-xs text-amber-700">이 시트는 읽지 않아요.</p>}
                    {choices[s.name] === 'table' && tr && <p className="mt-1 text-xs text-gray-600">표 형식으로 읽은 칸 {tr.rows.length}개 (아래 3단계에서 열 확인)</p>}
                    {choices[s.name] !== 'table' && choices[s.name] !== 'skip' && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-blue-700">
                          읽은 칸 {extract.rows.filter((r) => r.sheet === s.name).length}개 — 앞부분 보기
                        </summary>
                        <ul className="mt-1 space-y-0.5 text-xs text-gray-700">
                          {sample.map((r, j) => (
                            <li key={j} className="break-keep">
                              <span className="text-gray-400">
                                {r.row}행 {r.col ? colName(r.col) + '열' : ''}
                              </span>{' '}
                              {rowText(r)}
                            </li>
                          ))}
                          {sample.length === 0 && <li className="text-gray-500">읽은 칸이 없어요.</li>}
                        </ul>
                      </details>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {/* 3. 표 형식 열 매핑 */}
        {tableSheets.length > 0 && (
          <section className="bg-white shadow rounded-xl border border-gray-200 p-5 mb-4">
            <h2 className="font-bold text-gray-900 mb-1">3. 열 매핑 (표 형식)</h2>
            <p className="text-xs text-gray-500 mb-3 break-keep">
              한 행에 수업 하나가 적힌 표예요. 머리글 이름으로 열을 제안했지만 확정이 아니에요 — 실제 열과 맞는지 확인해 주세요. 필수: 요일·교시·과목.
            </p>
            {tableSheets.map((s) => {
              const cfg = tableCfg[s.name]
              if (!cfg) return null
              const header = s.grid[cfg.headerRow] || []
              const tr = tableResults[s.name]
              const errs = tr ? tr.problems.filter((p) => p.severity === 'error') : []
              return (
                <div key={s.name} className="rounded-lg border border-gray-200 p-3 mb-3">
                  <p className="text-sm font-bold text-gray-900 mb-2 break-all">{s.sheetName}</p>
                  <label className="block text-sm text-gray-700 mb-2">
                    머리글 행
                    <select
                      value={cfg.headerRow}
                      onChange={(e) => {
                        const h = Number(e.target.value)
                        updateCfg(s.name, { headerRow: h, mapping: suggestTableMapping(s.grid[h] || []) })
                      }}
                      className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    >
                      {s.grid.slice(0, 20).map((row, i) => (
                        <option key={i} value={i}>
                          {s.origin.r + i + 1}행: {(row || []).map((c) => normSpace(c)).filter(Boolean).slice(0, 4).join(' | ') || '(빈 행)'}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {TABLE_FIELDS.map((f) => (
                      <label key={f.key} className="text-sm text-gray-700 flex items-center gap-2">
                        <span className="w-24 shrink-0">
                          {f.label}
                          {f.required && <span className="text-red-600"> *</span>}
                        </span>
                        <select
                          value={cfg.mapping[f.key] ?? ''}
                          onChange={(e) => updateCfg(s.name, { mapping: { ...cfg.mapping, [f.key]: e.target.value === '' ? null : Number(e.target.value) } })}
                          className="min-w-0 flex-1 rounded-lg border border-gray-300 px-2 py-2 text-sm"
                        >
                          <option value="">(없음)</option>
                          {header.map((h, c) => (
                            <option key={c} value={c}>
                              {colName(s.origin.c + c + 1)}열 · {normSpace(h) || '(빈 머리글)'}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                  <label className="mt-2 flex items-center gap-2 text-xs text-gray-700">
                    <input type="checkbox" checked={cfg.numericWeekday} onChange={(e) => updateCfg(s.name, { numericWeekday: e.target.checked })} />
                    요일 열이 숫자예요 (월=1 … 일=7)
                  </label>
                  {tr && (
                    <div className="mt-2 text-xs text-gray-700">
                      읽은 칸 {tr.rows.length}개{tr.skipped.blank ? ` · 빈 행 ${tr.skipped.blank}` : ''}
                      {tr.skipped.repeatedHeader ? ` · 반복 머리글 ${tr.skipped.repeatedHeader}` : ''}
                      {tr.rows.slice(0, 3).map((r, j) => (
                        <p key={j} className="text-gray-500">
                          {r.row}행: {rowText(r)}
                        </p>
                      ))}
                    </div>
                  )}
                  {errs.length > 0 && (
                    <ul className="mt-2 max-h-40 overflow-y-auto rounded-lg bg-red-50 p-2 text-xs text-red-800 space-y-0.5">
                      {errs.slice(0, 50).map((p, j) => (
                        <li key={j}>
                          {p.row ? `${p.row}행${p.col ? ` ${colName(p.col)}열` : ''}: ` : ''}
                          {p.message} → {p.fix}
                        </li>
                      ))}
                      {errs.length > 50 && <li>…외 {errs.length - 50}건</li>}
                    </ul>
                  )}
                </div>
              )
            })}
          </section>
        )}

        {/* 4. 적용 범위 */}
        {sheets.length > 0 && (
          <section className="bg-white shadow rounded-xl border border-gray-200 p-5 mb-4">
            <h2 className="font-bold text-gray-900 mb-3">4. 학교·학기·적용 범위</h2>
            <p className="text-sm text-gray-700 mb-3">
              학교: <b>{me.schoolName || me.schoolCode}</b>
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
              <label className="text-sm text-gray-700">
                적용 시작일
                <input
                  type="date"
                  value={ymdToIso(validFrom)}
                  onChange={(e) => {
                    const y = isoToYmd(e.target.value)
                    if (y) {
                      setValidFrom(y)
                      resetServerState()
                    }
                  }}
                  className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
                <span className="text-xs text-gray-500">{isYmd(validFrom) ? `${formatYmdKo(validFrom)}부터 반복 시간표로 적용 (그 전 날짜는 그대로)` : ''}</span>
              </label>
              <label className="text-sm text-gray-700">
                학기 (비우면 적용 시작일 기준 자동)
                <input
                  type="text"
                  value={termId}
                  placeholder="예: 2026-2"
                  onChange={(e) => {
                    setTermId(e.target.value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40))
                    resetServerState()
                  }}
                  className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </label>
            </div>
            <fieldset className="mb-3 space-y-2">
              <legend className="text-xs font-bold text-gray-500 mb-1">반영 방식</legend>
              {(
                [
                  ['merge', '병합 (기본)', '파일에 있는 수업·차시만 추가·갱신하고, 파일에 없는 기존 수업은 그대로 둬요.'],
                  ['replace', '교체', '적용 시작일부터 이 파일을 이 학기 기본 시간표로 써요. 무엇이 끝나는지는 미리보기에서 확인할 수 있어요.'],
                ] as ['merge' | 'replace', string, string][]
              ).map(([v, title, desc]) => (
                <label key={v} className={`flex items-start gap-2 rounded-lg border p-3 text-sm cursor-pointer ${mode === v ? 'border-blue-400 bg-blue-50' : 'border-gray-200'}`}>
                  <input
                    type="radio"
                    name="import-mode"
                    className="mt-0.5"
                    checked={mode === v}
                    onChange={() => {
                      setMode(v)
                      resetServerState()
                    }}
                  />
                  <span className="break-keep">
                    <b className="text-gray-900">{title}</b>
                    <br />
                    <span className="text-xs text-gray-500">{desc}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-700 mb-3 break-keep">
              보낼 칸 <b>{allRows.length.toLocaleString()}</b>개 (학급표 {kindCounts.class} · 교사표 {kindCounts.teacher} · 특별실 {kindCounts.room} · 표 형식 {kindCounts.table})
              {extract.mergedCells > 0 && ` · 병합 셀로 이어진 칸 ${extract.mergedCells}개`}
              {Object.keys(extract.periodTimes).length > 0 && (
                <span className="block mt-1">
                  파일에 적힌 교시 시각:{' '}
                  {Object.keys(extract.periodTimes)
                    .map(Number)
                    .sort((a, b) => a - b)
                    .map((p) => `${p}교시 ${extract.periodTimes[p].start}${extract.periodTimes[p].end ? `–${extract.periodTimes[p].end}` : ''}`)
                    .join(', ')}
                </span>
              )}
            </div>
            {(extract.warnings.length > 0 || tableWarnings.length > 0) && (
              <details className="mb-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
                <summary className="cursor-pointer font-bold">읽으면서 확인할 점 {extract.warnings.length + tableWarnings.length}건</summary>
                <ul className="mt-1 max-h-48 overflow-y-auto space-y-0.5">
                  {extract.warnings.slice(0, 100).map((w, j) => (
                    <li key={`w${j}`}>
                      {refText({ sheet: w.sheet, row: w.row, col: w.col })}: {w.message}
                    </li>
                  ))}
                  {tableWarnings.slice(0, 100).map((p, j) => (
                    <li key={`t${j}`}>
                      {refText({ sheet: p.sheet, row: p.row, col: p.col })}: {p.message} → {p.fix}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {blocking.length > 0 && (
              <p className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-800">
                표 형식 시트에 읽지 못한 칸·매핑 문제가 {blocking.length}건 있어요. 3단계에서 열을 고치거나 파일을 고쳐 다시 올려 주세요.
              </p>
            )}
            {tooMany && <p className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-800">칸이 너무 많아요(최대 {IMPORT_MAX_ROWS.toLocaleString()}개). 파일을 나눠 올려 주세요.</p>}
            {allRows.length === 0 && <p className="mb-3 text-sm text-gray-500">보낼 칸이 없어요. 시트 유형을 확인해 주세요.</p>}
            <button
              onClick={stage}
              disabled={!!busy || allRows.length === 0 || blocking.length > 0 || tooMany || !!committed}
              className="w-full rounded-xl bg-blue-600 py-3 text-sm font-bold text-white disabled:opacity-50"
            >
              임시로 올리고 미리보기
            </button>
            <p className="mt-2 text-[11px] text-gray-400 break-keep">임시로 올려도 학교 시간표는 바뀌지 않아요. 확정해야 반영돼요.</p>
          </section>
        )}

        {failure && (
          <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <p className="font-bold">{failure.message}</p>
            <p className="mt-1 text-xs text-red-600">오류 코드: {failure.code}</p>
            {failure.code === 'stale-revision' && preview && (
              <button onClick={() => loadPreview(preview.batchId)} className="mt-2 rounded-lg bg-white px-3 py-2 text-xs font-bold text-red-700 ring-1 ring-red-200">
                최신 상태로 미리보기 다시 만들기
              </button>
            )}
          </div>
        )}

        {/* 6. 미리보기 + 확정 */}
        {preview && (
          <section className="bg-white shadow rounded-xl border border-gray-200 p-5 mb-4">
            <h2 className="font-bold text-gray-900 mb-1">5·6. 미리보기와 확정</h2>
            <p className="text-xs text-gray-500 mb-3">
              {preview.termId ? `학기 ${preview.termId} · ` : ''}
              {formatYmdKo(validFrom)}부터 · {mode === 'replace' ? '교체' : '병합'}
              {preview.revision !== null ? ` · 기준 버전 ${preview.revision}` : ''}
            </p>
            {preview.duplicateOf && (
              <p className="mb-3 rounded-lg bg-gray-50 p-3 text-xs text-gray-700">같은 파일을 이미 발행한 적이 있어요. 바뀐 내용이 없으면 &lsquo;같음&rsquo;으로 나와요.</p>
            )}
            {preview.stats.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3 text-center">
                {preview.stats.map((s) => (
                  <div key={s.key} className={`rounded-lg p-2 ${s.cls}`}>
                    <div className="text-xl font-extrabold">{s.value}</div>
                    <div className="text-[11px] break-keep">{s.label}</div>
                  </div>
                ))}
              </div>
            )}

            {(['error', 'review', 'warning', 'info'] as IssueView['severity'][]).map((sev) => {
              const list = preview.issues.filter((i) => i.severity === sev)
              if (list.length === 0) return null
              const style =
                sev === 'error' ? 'bg-red-50 text-red-800' : sev === 'review' ? 'bg-amber-50 text-amber-900' : sev === 'warning' ? 'bg-amber-50/60 text-amber-800' : 'bg-gray-50 text-gray-700'
              const title = sev === 'error' ? '오류 — 고쳐야 발행할 수 있어요' : sev === 'review' ? '검토 — 확신할 수 없어 따로 둔 항목' : sev === 'warning' ? '확인할 점' : '안내'
              return (
                <details key={sev} open={sev === 'error' || sev === 'review'} className={`mb-3 rounded-lg p-3 text-xs ${style}`}>
                  <summary className="cursor-pointer font-bold">
                    {title} {list.length}건
                  </summary>
                  <ul className="mt-2 max-h-64 overflow-y-auto space-y-1.5">
                    {list.slice(0, 200).map((i, j) => (
                      <li key={j} className="break-keep">
                        {i.message}
                        {i.refs.length > 0 && <span className="block opacity-80">위치: {i.refs.slice(0, 5).map(refText).join(', ')}{i.refs.length > 5 ? ` 외 ${i.refs.length - 5}곳` : ''}</span>}
                        {i.fix && <span className="block opacity-80">고칠 방법: {i.fix}</span>}
                      </li>
                    ))}
                  </ul>
                </details>
              )
            })}

            {preview.teacherLinks.length > 0 && (
              <section aria-label="교사 계정 연결 후보" className="mb-3 rounded-lg border border-gray-200 p-3">
                <h3 className="text-sm font-bold text-gray-900">교사 계정 연결 후보</h3>
                <p className="mt-1 text-xs text-gray-600 break-keep">
                  엑셀의 교사 이름과 같은 이름(엑셀 이름)을 쓰는 우리 학교 교사 계정이에요. 이름은 본인이 정하는 값이라 같다고 같은 사람은 아니에요 —
                  이메일로 실제 담당 선생님인지 확인해 주세요. <b>체크한 교사만 이 수업의 담당 교사 권한(일정 변경·수강 관리)을 받습니다.</b>{' '}
                  체크하지 않으면 이름만 표시돼요.
                </p>
                {preview.teacherEmailError && (
                  <p role="alert" className="mt-2 rounded-lg bg-red-50 p-2 text-xs text-red-800 break-keep">
                    후보 교사의 로그인 이메일을 확인하지 못했어요. 사람을 확인할 수 없으면 체크하지 말고, 미리보기를 다시 만들어 주세요.
                  </p>
                )}
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-gray-500">
                        <th className="py-1 pr-2 font-normal">엑셀 교사 이름</th>
                        <th className="py-1 font-normal">후보 계정(이름 · 가린 이메일)</th>
                      </tr>
                    </thead>
                    <tbody className="align-top">
                      {preview.teacherLinks.map((l, j) => (
                        <tr key={`${l.name}#${j}`} className="border-t border-gray-100">
                          <td className="py-2 pr-2 font-bold text-gray-900 break-keep">
                            {l.name}
                            <span className="block font-normal text-gray-500">수업 {l.courseCount}개</span>
                          </td>
                          <td className="py-2">
                            {l.candidates.length === 0 && <span className="text-gray-500">{TEACHER_REASON_KO['no-account']}</span>}
                            {l.reason === 'ambiguous' && <p className="mb-1 text-amber-800 break-keep">{TEACHER_REASON_KO.ambiguous}</p>}
                            <ul className="space-y-1">
                              {l.candidates.map((c) => {
                                const allLinked = l.courseCount > 0 && c.linkedCourseCount >= l.courseCount
                                const k = linkKey(l.nameKey, c.uid)
                                return (
                                  <li key={c.uid}>
                                    <label className="flex items-start gap-2 min-h-[32px]">
                                      <input
                                        type="checkbox"
                                        className="mt-0.5"
                                        checked={allLinked || !!confirmLinks[k]}
                                        disabled={allLinked || !!committed || !!busy}
                                        onChange={(e) => setConfirmLinks({ ...confirmLinks, [k]: e.target.checked })}
                                        aria-label={`${l.name} 수업 담당 교사로 ${c.name || '이 계정'} 연결`}
                                      />
                                      <span className="break-all">
                                        <b className="text-gray-900">{c.name || '(이름 없음)'}</b>{' '}
                                        <span className="text-gray-600">{c.emailMasked || '이메일 확인 불가'}</span>
                                        {allLinked && <span className="block text-emerald-700">이미 담당 교사로 연결됨(이전 확인)</span>}
                                        {!allLinked && c.linkedCourseCount > 0 && (
                                          <span className="block text-gray-500">
                                            {l.courseCount}개 중 {c.linkedCourseCount}개 수업은 이미 연결됨 — 체크하면 나머지도 연결
                                          </span>
                                        )}
                                      </span>
                                    </label>
                                  </li>
                                )
                              })}
                            </ul>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-[11px] text-gray-500 break-keep">
                  체크한 계정 {checkedLinks.length}개 · 체크하지 않은 수업은 발행 교사(나)가 관리 교사로 남아 나중에 담당 교사를 연결할 수 있어요.
                </p>
              </section>
            )}
            {(() => {
              const pending = preview.courses.filter((c) => c.commonPending.length > 0)
              if (pending.length === 0) return null
              return (
                <details open className="mb-3 rounded-lg bg-sky-50 p-3 text-xs text-sky-900">
                  <summary className="cursor-pointer font-bold">공통 수업 후보 {pending.length}개 — 담임 확인 필요</summary>
                  <p className="mt-1 break-keep">
                    분반 없이 한 학급에만 나오는 수업이에요. 반 학생 모두가 듣는지는 시간표만으로 알 수 없어서, 확정해도 학생 시간표에 바로 나타나지 않아요.
                    그 학급 담임이 수업 관리 화면에서 &lsquo;우리 반 공통 수업&rsquo;으로 확인하면 나타나요.
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {pending.map((c) => (
                      <li key={c.key} className="break-keep">
                        <b>{c.title}</b> — {c.commonPending.map(homeroomText).join(', ')} 공통 수업 후보 — 담임 확인 필요, 확정해도 학생 시간표에 바로 나타나지 않음
                      </li>
                    ))}
                  </ul>
                </details>
              )
            })()}
            {preview.retiring.length > 0 && (
              <details className="mb-3 rounded-lg bg-gray-50 p-3 text-xs text-gray-700">
                <summary className="cursor-pointer font-bold">{formatYmdKo(validFrom)}부터 끝나는 기존 수업 {preview.retiring.length}개</summary>
                <ul className="mt-1 space-y-0.5">
                  {preview.retiring.map((r, j) => (
                    <li key={j}>
                      {r.title}
                      {r.seriesCount !== undefined ? ` (반복 차시 ${r.seriesCount}개)` : ''}
                    </li>
                  ))}
                </ul>
                <p className="mt-1">그 전 날짜의 시간표는 그대로 남아요.</p>
              </details>
            )}
            {preview.courses.length > 0 && (
              <details className="mb-3 rounded-lg border border-gray-200 p-3">
                <summary className="cursor-pointer text-sm font-bold text-gray-900">수업별 차시 목록 ({preview.courses.length}개 수업)</summary>
                <ul className="mt-2 space-y-2 max-h-[28rem] overflow-y-auto">
                  {preview.courses.map((c) => (
                    <li key={c.key} className="rounded-lg bg-gray-50 p-2 text-xs">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <b className="text-sm text-gray-900">{c.title}</b>
                        {c.status && <span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-gray-600 ring-1 ring-gray-200">{STATUS_KO[c.status] || c.status}</span>}
                        {c.blocked === 'error' && <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] text-red-700">오류</span>}
                        {c.blocked === 'review' && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-800">검토 — 확인 시 발행 제외</span>}
                        {c.teachers.length > 0 && <span className="text-gray-600">{c.teachers.join(', ')}</span>}
                        {c.teacherUnlinked && <span className="text-amber-700">(교사 계정 미연결 — 위 후보에서 체크하면 연결)</span>}
                        {c.classes.length > 0 && <span className="text-gray-500">· {c.classes.join(', ')}</span>}
                      </div>
                      {c.commonPending.length > 0 && (
                        <p className="mt-1 text-[11px] text-sky-800 break-keep">
                          {c.commonPending.map(homeroomText).join(', ')} 공통 수업 후보 — 담임 확인 필요, 확정해도 학생 시간표에 바로 나타나지 않음
                        </p>
                      )}
                      {c.commonConfirmed.length > 0 && (
                        <p className="mt-1 text-[11px] text-emerald-700 break-keep">{c.commonConfirmed.map(homeroomText).join(', ')} 공통 수업(담임 확인됨)</p>
                      )}
                      <ul className="mt-1 space-y-0.5 text-gray-700">
                        {c.lessons.map((l, j) => (
                          <li key={j} className="break-keep">
                            {l.weekday ? DAY_KO[l.weekday] : '?'} {l.period ?? '?'}교시
                            {l.start ? ` ${l.start}${l.end ? `–${l.end}` : ''}` : ''}
                            {l.room ? ` · ${l.room}` : ''}
                            {l.classes.length ? ` · ${l.classes.join(',')}` : ''}
                            {l.status ? ` · ${STATUS_KO[l.status] || l.status}` : ''}
                            {l.refs.length > 0 && <span className="text-gray-400"> ({l.refs.slice(0, 3).map(refText).join(', ')})</span>}
                          </li>
                        ))}
                        {c.lessons.length === 0 && <li className="text-gray-500">차시 없음</li>}
                      </ul>
                      {c.refs.length > 0 && (
                        <p className="mt-1 text-[11px] text-gray-400 break-keep">
                          출처: {c.refs.slice(0, 4).map(refText).join(', ')}
                          {c.refs.length > 4 ? ` 외 ${c.refs.length - 4}곳` : ''}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {!committed && (
              <div className="space-y-2">
                {preview.errorCount > 0 && (
                  <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800 break-keep">
                    오류 {preview.errorCount}건이 있어 발행할 수 없어요. 위치를 보고 파일을 고친 뒤 다시 올려 주세요.
                  </p>
                )}
                {preview.errorCount === 0 && preview.reviewCount > 0 && (
                  <label className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                    <input type="checkbox" className="mt-1" checked={acceptReview} onChange={(e) => setAcceptReview(e.target.checked)} />
                    <span className="break-keep">검토 항목 {preview.reviewCount}건을 제외하고 발행하기 (제외한 수업·차시는 학생에게 보이지 않아요)</span>
                  </label>
                )}
                <fieldset className="rounded-lg bg-emerald-50/60 p-3 text-sm text-gray-900 ring-1 ring-emerald-100">
                  <legend className="sr-only">학생 수업 담기 공개</legend>
                  <label className="flex min-h-[44px] items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1 h-5 w-5 shrink-0"
                      checked={publishCatalog}
                      onChange={(e) => setPublishCatalog(e.target.checked)}
                      disabled={!!busy}
                    />
                    <span className="break-keep">
                      <b>학생 수업 담기 목록에 공개 (학생이 직접 골라 담기)</b>
                      <span className="mt-0.5 block text-xs text-gray-600">
                        학생이 &lsquo;수업 담기&rsquo;에서 학년·요일·교시로 이 수업을 찾아 직접 담아요. 담은 수업은 선생님이 바꾸는 시간표가 자동 반영돼요.
                        수업 화면에서 선생님이 공개·참여 방식을 직접 바꾼 수업은 그대로 둬요.
                      </span>
                    </span>
                  </label>
                  {publishCatalog && (
                    <div role="radiogroup" aria-label="학생이 담을 때" className="mt-1 grid grid-cols-1 gap-1 pl-7 sm:grid-cols-2">
                      <label className="flex min-h-[44px] items-center gap-2">
                        <input type="radio" name="catalogPolicy" className="h-5 w-5" checked={catalogPolicy === 'auto'} onChange={() => setCatalogPolicy('auto')} disabled={!!busy} />
                        <span className="break-keep">바로 담기(기본)</span>
                      </label>
                      <label className="flex min-h-[44px] items-center gap-2">
                        <input type="radio" name="catalogPolicy" className="h-5 w-5" checked={catalogPolicy === 'approval'} onChange={() => setCatalogPolicy('approval')} disabled={!!busy} />
                        <span className="break-keep">선생님 승인 후</span>
                      </label>
                    </div>
                  )}
                </fieldset>
                <div className="grid grid-cols-3 gap-2">
                  <button onClick={cancel} disabled={!!busy} className="rounded-xl bg-white py-3 text-sm font-bold text-gray-600 ring-1 ring-gray-300 disabled:opacity-50">
                    취소
                  </button>
                  <button
                    onClick={commit}
                    disabled={!!busy || preview.errorCount > 0 || (preview.reviewCount > 0 && !acceptReview)}
                    className="col-span-2 rounded-xl bg-blue-600 py-3 text-sm font-bold text-white disabled:opacity-50"
                  >
                    확정 발행
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {/* 7. 결과 */}
        {committed && (
          <section className="bg-white shadow rounded-xl border border-emerald-200 p-5 mb-4">
            <h2 className="font-bold text-gray-900 mb-2">7. 결과</h2>
            {rolledBack ? (
              <p className="text-sm text-gray-700">이 발행을 되돌렸어요.</p>
            ) : (
              <>
                <p className="text-sm text-emerald-800">
                  ✅ {committed.already ? '이미 발행한 묶음이에요.' : '발행했어요.'}
                  {committed.revision !== null ? ` (학교 시간표 버전 ${committed.revision})` : ''}
                </p>
                {committed.stats.length > 0 && (
                  <p className="mt-1 text-xs text-gray-600">{committed.stats.map((s) => `${s.label} ${s.value}`).join(' · ')}</p>
                )}
                <p className="mt-2 text-xs text-gray-700 break-keep">
                  {committed.linkedTeachers.length > 0
                    ? `담당 교사로 연결: ${committed.linkedTeachers.join(', ')}`
                    : '담당 교사로 연결한 계정 없음 — 교사 이름만 표시돼요(발행한 내가 관리 교사).'}
                  {committed.ignoredTeachers > 0 ? ` · 후보가 아니어서 연결하지 않은 계정 ${committed.ignoredTeachers}개` : ''}
                </p>
                <p className="mt-2 text-xs text-gray-700 break-keep">
                  {committed.catalog.visible
                    ? `학생 '수업 담기' 목록에 공개했어요 — ${committed.catalog.policy === 'auto' ? '학생이 담으면 바로 시간표에 들어가요' : '학생이 담으면 선생님 승인 후 시간표에 들어가요'}.`
                    : "학생 '수업 담기' 목록에는 공개하지 않았어요."}
                </p>
                <div className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 break-keep">
                  <b>학생 시간표에 나타나려면:</b> {committed.catalog.visible ? "학생이 '수업 담기'에서 직접 담거나, " : ''}담임의 공통 수업 확인 또는 수강 명단 가져오기/초대가 필요해요.
                  {committed.commonPending > 0 && <span className="block text-xs mt-1">공통 수업 후보 {committed.commonPending}개가 담임 확인을 기다리고 있어요.</span>}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button onClick={() => router.push('/teacher/roster-import')} className="rounded-xl bg-emerald-600 py-3 text-sm font-bold text-white">
                    수강 명단 올리기
                  </button>
                  <button onClick={() => router.push('/teacher/courses')} className="rounded-xl bg-white py-3 text-sm font-bold text-emerald-700 ring-1 ring-emerald-200">
                    수업 관리(공통 수업 확인)
                  </button>
                  <button
                    onClick={() => rollback(committed.batchId, committed.revision)}
                    disabled={!!busy}
                    className="col-span-2 rounded-xl bg-white py-3 text-sm font-bold text-red-700 ring-1 ring-red-200 disabled:opacity-50"
                  >
                    이 발행 되돌리기
                  </button>
                </div>
              </>
            )}
          </section>
        )}

        {/* 최근 가져오기 */}
        <section className="bg-white shadow rounded-xl border border-gray-200 p-5 mb-10">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-bold text-gray-900">최근 가져오기</h2>
            <button onClick={loadBatches} className="text-xs text-blue-700 px-2 py-1">
              새로고침
            </button>
          </div>
          {batchesError && (
            <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
              목록을 불러오지 못했어요: {batchesError.message} <span className="text-xs">({batchesError.code})</span>
            </p>
          )}
          {batches && batches.length === 0 && <p className="text-sm text-gray-500">아직 가져온 시간표가 없어요.</p>}
          {batches && batches.length > 0 && (
            <ul className="divide-y divide-gray-100 text-sm">
              {batches.slice(0, 10).map((b) => (
                <li key={b.batchId} className="py-2 flex items-center justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block truncate text-gray-900">{b.fileName || b.batchId}</span>
                    <span className="text-xs text-gray-500">
                      {STATUS_KO[b.status] || b.status}
                      {b.stalled ? ' (멈춤)' : ''}
                      {b.progress && (b.status === 'failed' || b.status === 'committing') ? ` · ${b.progress.done}/${b.progress.total}묶음 반영` : ''}
                      {b.createdAt ? ` · ${new Date(b.createdAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}` : ''}
                      {b.counts ? ` · ${b.counts}` : ''}
                    </span>
                  </span>
                  <span className="flex shrink-0 gap-1">
                    {canResume(b) && (
                      <button
                        onClick={() => resumeCommit(b.batchId)}
                        disabled={!!busy}
                        className="rounded-lg px-3 py-2 text-xs font-bold text-blue-700 ring-1 ring-blue-200 disabled:opacity-50"
                      >
                        이어서 발행
                      </button>
                    )}
                    {canRollback(b) && (
                      <button
                        onClick={() => rollback(b.batchId, b.revision)}
                        disabled={!!busy}
                        className="rounded-lg px-3 py-2 text-xs font-bold text-red-700 ring-1 ring-red-200 disabled:opacity-50"
                      >
                        되돌리기
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}

/** 화면의 시트 → 파서 입력(값은 문자열·숫자만 — sheet_to_json raw:false라 불리언은 나오지 않음) */
function toInput(s: WorkbookSheet): ImportSheetInput {
  return { name: s.name, grid: s.grid as CellValue[][], origin: s.origin, merges: s.merges }
}
