import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/router'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth } from '../../lib/firebase'
import { useUI } from '../../components/ui/feedback'
import { formatYmdKo, isoToYmd, isYmd, schoolYmdAt, ymdToIso } from '../../lib/timetable/dates'
import {
  colName,
  guessHeaderRow,
  IMPORT_ACCEPT,
  mapRosterRows,
  normSpace,
  readImportFile,
  ROSTER_FIELDS,
  ROSTER_MAX_ROWS,
  suggestRosterMapping,
  validateRosterMapping,
  type RosterMapping,
  type WorkbookSheet,
} from '../../lib/timetable/importRows'
import { canStageRoster, rosterSourceKey, rosterStageKey, skipConsentValid, stagedIsStale } from '../../lib/timetable/rosterImportView'

// 학생별 수강 명단 올리기 (요구 문서 14장)
// 시간표만으로는 학생이 어떤 수업(분반)을 듣는지 알 수 없어서, 학교가 가진 수강 명단으로 수강 관계를 만듭니다.
// 파일 선택 → 열 매핑 → 미리보기(수업 매칭·연결 후보·미가입·오류 행) → 저장 → 연결 확정
// - 학생은 이름이 아니라 학년·반·번호가 정확히 한 명일 때만 '후보'로 보이고, 담임·담당 교사가 확정해야 수강이 생깁니다.
// - 파일은 브라우저에서만 읽고(값만, 수식·매크로 실행 안 함) 정리된 행만 우리 서버(/api/roster-import)로 보냅니다.

interface ApiFailure {
  message: string
  code: string
  status: number
}

interface CourseMatch {
  status: 'matched' | 'not-found' | 'ambiguous' | 'ended'
  via: 'code' | 'subject'
  courseId?: string
  title?: string
  candidates: number
  hint?: 'section-missing' | 'section-mismatch'
}

interface StudentCandidate {
  status: 'candidate' | 'none' | 'ambiguous'
  uid?: string
  name?: string
  nameMatches?: boolean | null
  withoutNumber?: number
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
  course?: CourseMatch
  student?: StudentCandidate
  entry?: 'new' | 'existing' | 'linked'
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

interface StageResponse {
  batchId: string
  status: string
  termId: string
  validFrom: string
  stats: PreviewStats
  rows: RowView[]
  issues: { code: string; severity: string; message: string }[]
}

interface CommitResponse {
  batchId: string
  status: string
  already?: boolean
  result: { created: number; updated: number; skippedErrors: number; duplicates: number; unmatchedCourse: number } | null
}

interface ListEntry {
  entryId: string
  row: number | null
  grade: number
  classNm: number
  number: number
  name: string | null
  courseId: string | null
  courseTitle: string | null
  courseIssue: string | null
  subject: string | null
  section: string | null
  teacher: string | null
  courseCode: string | null
  validFrom: string | null
  linkStatus: 'linked' | 'unlinked'
  candidate: StudentCandidate | null
  canLink: boolean
}

interface ListResponse {
  entries: ListEntry[]
  counts: { total: number; unlinked: number; candidates: number }
  scope: { homerooms: string[]; courseCount: number }
}

interface LinkResponse {
  linked: number
  enrollmentsCreated: number
  revision: number | null
  results: { entryId: string; status: string; message?: string }[]
}

type RowFilter = 'all' | 'errors' | 'course' | 'candidate' | 'unregistered'

const EMPTY_MAPPING: RosterMapping = {
  studentKey: null,
  grade: null,
  classNm: null,
  number: null,
  name: null,
  courseCode: null,
  subject: null,
  section: null,
  teacher: null,
}

async function postRoster<T>(body: Record<string, unknown>): Promise<T> {
  const u = auth.currentUser
  if (!u) throw { message: '로그인이 필요해요. 다시 로그인해 주세요.', code: 'unauthenticated', status: 401 } as ApiFailure
  const token = await u.getIdToken()
  let resp: Response
  try {
    resp = await fetch('/api/roster-import', {
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
    } as ApiFailure
  }
  return json as T
}

const asFailure = (e: unknown): ApiFailure =>
  e && typeof e === 'object' && 'code' in e && 'message' in e
    ? (e as ApiFailure)
    : { message: (e as Error)?.message || '알 수 없는 오류가 났어요.', code: 'client-error', status: 0 }

const studentLabel = (r: { grade?: number; classNm?: number; number?: number }) =>
  `${r.grade ?? '?'}학년 ${r.classNm ?? '?'}반 ${r.number ?? '?'}번`

const courseText = (r: { courseCode?: string | null; subject?: string | null; section?: string | null; teacher?: string | null }) =>
  [r.courseCode ? `코드 ${r.courseCode}` : '', r.subject || '', r.section ? `${r.section}반` : '', r.teacher ? `(${r.teacher})` : '']
    .filter(Boolean)
    .join(' ') || '수업 정보 없음'

function CourseBadge({ c }: { c?: CourseMatch }) {
  if (!c) return null
  if (c.status === 'matched') return <span className="text-emerald-700">✓ 수업: {c.title}</span>
  if (c.status === 'ambiguous')
    return (
      <span className="text-amber-700">
        ⚠️ 수업 후보 {c.candidates}개 —{' '}
        {c.hint === 'section-missing'
          ? '분반이 적혀 있지 않아 어느 분반인지 정할 수 없어요. 분반 열을 지정해 주세요.'
          : c.hint === 'section-mismatch'
            ? '과목 이름의 분반 표기(예: A_영어)와 분반 열이 서로 달라요. 어느 쪽이 맞는지 원본을 확인해 주세요.'
            : '분반·교사 열을 더 지정해 주세요.'}
      </span>
    )
  if (c.status === 'ended') return <span className="text-gray-500">⛔ 종료된 수업이라 연결하지 않아요.</span>
  return (
    <span className="text-amber-700">
      ⚠️ 이 학기 수업에서 찾지 못했어요 — {c.via === 'code' ? '수업 코드' : '과목·분반 표기'}를 확인하거나 시간표를 먼저 가져와 주세요.
    </span>
  )
}

function StudentBadge({ s }: { s?: StudentCandidate | null }) {
  if (!s) return null
  if (s.status === 'candidate')
    return (
      <span className={s.nameMatches === false ? 'text-red-700' : 'text-blue-700'}>
        👤 연결 후보: <b>{s.name || '이름 없음'}</b>
        {s.nameMatches === false && ' — 명단 이름과 계정 이름이 달라요. 학생을 확인한 뒤 연결하세요.'}
      </span>
    )
  if (s.status === 'ambiguous') return <span className="text-amber-700">⚠️ 같은 반에 같은 번호 학생이 여럿이에요. 학생 번호를 먼저 바로잡아 주세요.</span>
  return (
    <span className="text-gray-500">
      💤 아직 이 반·번호로 승인된 학생이 없어요(미연결로 보관).
      {s.withoutNumber ? ` 이 반에 번호가 비어 있는 학생 ${s.withoutNumber}명 — 학생 관리에서 번호를 확인해 주세요.` : ''}
    </span>
  )
}

export default function RosterImportPage() {
  const router = useRouter()
  const { toast, confirm } = useUI()
  const today = useMemo(() => schoolYmdAt(Date.now()), [])

  const [loading, setLoading] = useState(true)
  const [me, setMe] = useState<{ schoolCode: string; schoolName: string } | null>(null)

  const [reading, setReading] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [fileHash, setFileHash] = useState('')
  const [sheets, setSheets] = useState<WorkbookSheet[]>([])
  const [sheetIdx, setSheetIdx] = useState(0)
  const [headerRow, setHeaderRow] = useState(0)
  const [mapping, setMapping] = useState<RosterMapping>(EMPTY_MAPPING)
  // '읽지 못한 행 빼고 계속하기' 동의 — 동의할 때의 파일·시트·머리글·열 매핑 키(바뀌면 동의가 풀림)
  const [skipConsent, setSkipConsent] = useState<string | null>(null)
  const [validFrom, setValidFrom] = useState(today)
  const [termId, setTermId] = useState('')

  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState<ApiFailure | null>(null)
  const [staged, setStaged] = useState<StageResponse | null>(null)
  // staged를 만든 입력(rosterStageKey) — 지금 입력과 다르면 저장하지 않음
  const [stagedKey, setStagedKey] = useState<string | null>(null)
  const [filter, setFilter] = useState<RowFilter>('all')
  const [showCount, setShowCount] = useState(100)
  const [excludeErrors, setExcludeErrors] = useState(false)
  const [committed, setCommitted] = useState<CommitResponse | null>(null)

  const [list, setList] = useState<ListResponse | null>(null)
  const [listError, setListError] = useState<ApiFailure | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [linkResult, setLinkResult] = useState<LinkResponse | null>(null)

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
        // 화면 표시용 확인일 뿐 — 실제 권한은 서버(/api/roster-import)가 users 문서로 다시 판정
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
        console.error('roster-import: 내 정보 확인 실패', (e as Error)?.message)
        toast('내 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.', 'error')
      } finally {
        setLoading(false)
      }
    })
    return () => unsub()
  }, [router, toast])

  const loadList = useCallback(async () => {
    setListLoading(true)
    setListError(null)
    try {
      const r = await postRoster<ListResponse>({ action: 'list', unlinked: true })
      setList(r)
      setSelected({})
    } catch (e) {
      setListError(asFailure(e))
    } finally {
      setListLoading(false)
    }
  }, [])

  const meSchool = me ? me.schoolCode : ''
  useEffect(() => {
    if (meSchool) loadList()
  }, [meSchool, loadList])

  const sheet = sheets[sheetIdx] || null
  const header = useMemo(() => (sheet ? sheet.grid[headerRow] || [] : []), [sheet, headerRow])

  // 시트·머리글 행을 바꾸면 열 매핑을 머리글 이름으로 다시 '제안'(교사가 확인·수정)
  useEffect(() => {
    if (sheet) setMapping(suggestRosterMapping(sheet.grid[headerRow] || []))
  }, [sheet, headerRow])

  const mappingErrors = useMemo(() => validateRosterMapping(mapping), [mapping])
  const mapped = useMemo(() => {
    if (!sheet || mappingErrors.length) return null
    return mapRosterRows(header, sheet.grid.slice(headerRow + 1), mapping, {
      sheet: sheet.name,
      firstDataRow: sheet.origin.r + headerRow + 2,
      firstCol: sheet.origin.c + 1,
    })
  }, [sheet, header, headerRow, mapping, mappingErrors])
  const badRows = mapped ? mapped.problems.filter((p) => p.row > 0) : []
  const tooMany = !!mapped && mapped.rows.length > ROSTER_MAX_ROWS

  // 예전에는 동의(boolean)가 시트·머리글·열 매핑을 바꿔도 남아, 동의하지 않은 다른(더 많은) 행이 말없이 빠진 채 올라갔음
  const sourceKey = sheet ? rosterSourceKey({ fileHash, sheetName: sheet.name, headerRow, mapping }) : ''
  const skipOk = skipConsentValid(skipConsent, sourceKey)
  const stageReady = !!mapped && canStageRoster({ rowCount: mapped.rows.length, tooMany, badRowCount: badRows.length, consentKey: skipConsent, sourceKey })
  // 예전에는 미리보기 뒤 적용 시작일·학기를 바꿔도 저장(commit, batchId만 보냄)이 미리보기 때 값으로 됐음
  const stageKey = sheet ? rosterStageKey({ fileHash, sheetName: sheet.name, headerRow, mapping, validFrom, termId }) : ''
  const previewStale = !!staged && stagedIsStale(stagedKey, stageKey)

  const resetResults = () => {
    setStaged(null)
    setStagedKey(null)
    setCommitted(null)
    setFailure(null)
    setExcludeErrors(false)
    setFilter('all')
    setShowCount(100)
  }

  const handleFile = async (fileList: FileList | null) => {
    const file = fileList && fileList[0]
    if (!file) return
    setReading(true)
    setReadError(null)
    resetResults()
    setSheets([])
    setFileName(file.name)
    try {
      const XLSX = await import('xlsx')
      const r = await readImportFile(file, XLSX)
      const usable = r.sheets.filter((s) => s.grid.some((row) => (row || []).some((c) => normSpace(c) !== '')))
      if (usable.length === 0) throw new Error('파일에서 내용이 있는 시트를 찾지 못했어요.')
      setFileHash(r.hash)
      setSheets(usable)
      setSheetIdx(0)
      setHeaderRow(guessHeaderRow(usable[0].grid))
      setSkipConsent(null)
    } catch (e) {
      setReadError((e as Error)?.message || '파일을 읽지 못했어요.')
      setFileName('')
    } finally {
      setReading(false)
    }
  }

  const stage = async () => {
    if (!me || !mapped || !fileHash || !stageReady) return
    // 요청을 보낼 때의 입력 — 응답을 기다리는 사이 입력이 바뀌면 이 결과는 '다시 미리보기 필요'로 보임
    const key = stageKey
    setBusy('명단을 확인하는 중…')
    resetResults()
    try {
      const r = await postRoster<StageResponse>({
        action: 'stage',
        schoolCode: me.schoolCode,
        termId: termId.trim() || undefined,
        validFrom,
        fileName,
        fileHash,
        mapping,
        rows: mapped.rows,
      })
      setStaged(r)
      setStagedKey(key)
      if (r.stats.errors > 0) setFilter('errors')
    } catch (e) {
      setFailure(asFailure(e))
    } finally {
      setBusy(null)
    }
  }

  const commit = async () => {
    if (!staged || previewStale) return
    const ok = await confirm({
      title: '명단 저장',
      description: `명단 ${staged.stats.valid}행을 학기 ${staged.termId} · ${formatYmdKo(staged.validFrom)}부터 수강으로 저장해요. 저장만으로는 학생 시간표가 바뀌지 않고, 아래 '연결 확정'을 해야 학생에게 수업이 보여요.`,
      confirmText: '저장하기',
    })
    if (!ok) return
    setBusy('명단을 저장하는 중…')
    setFailure(null)
    try {
      const r = await postRoster<CommitResponse>({ action: 'commit', batchId: staged.batchId, excludeErrorRows: excludeErrors })
      setCommitted(r)
      toast(r.already ? '이미 저장한 명단이에요.' : '명단을 저장했어요.', 'success')
      await loadList()
    } catch (e) {
      setFailure(asFailure(e))
    } finally {
      setBusy(null)
    }
  }

  const cancel = async () => {
    if (!staged) return
    setBusy('취소하는 중…')
    try {
      await postRoster({ action: 'cancel', batchId: staged.batchId })
      resetResults()
      toast('올린 명단을 취소했어요. 아무것도 저장되지 않았어요.', 'info')
    } catch (e) {
      setFailure(asFailure(e))
    } finally {
      setBusy(null)
    }
  }

  const linkable = useMemo(
    () => (list ? list.entries.filter((e) => e.canLink && e.candidate?.status === 'candidate') : []),
    [list]
  )
  const selectedIds = Object.keys(selected).filter((k) => selected[k])

  const link = async () => {
    if (selectedIds.length === 0) return
    const mismatch = linkable.filter((e) => selected[e.entryId] && e.candidate?.nameMatches === false).length
    const ok = await confirm({
      title: '수강 연결 확정',
      description:
        `선택한 ${selectedIds.length}건을 학생 계정과 연결해요. 연결하면 그 학생 개인 시간표에 수업이 바로 보여요.` +
        (mismatch ? ` 이름이 다른 ${mismatch}건이 있어요 — 같은 학생인지 꼭 확인해 주세요.` : ''),
      confirmText: '연결 확정',
      danger: mismatch > 0,
    })
    if (!ok) return
    setBusy('연결하는 중…')
    setLinkResult(null)
    try {
      const ids = selectedIds.slice(0, 100)
      const r = await postRoster<LinkResponse>({ action: 'link', entryIds: ids, confirm: true })
      setLinkResult(r)
      toast(`${r.linked}건을 연결했어요.`, 'success')
      if (selectedIds.length > 100) toast('한 번에 100건까지 연결해요. 나머지는 다시 선택해 주세요.', 'info')
      await loadList()
    } catch (e) {
      const f = asFailure(e)
      toast(f.message, 'error')
      setListError(f)
    } finally {
      setBusy(null)
    }
  }

  const rowsShown = useMemo(() => {
    if (!staged) return []
    return staged.rows.filter((r) => {
      switch (filter) {
        case 'errors':
          return !!r.error
        case 'course':
          return !r.error && !r.duplicateOf && r.course?.status !== 'matched'
        case 'candidate':
          return r.student?.status === 'candidate'
        case 'unregistered':
          return r.student?.status === 'none' || r.student?.status === 'ambiguous'
        default:
          return true
      }
    })
  }, [staged, filter])

  const step = linkResult || committed ? 5 : staged ? 3 : sheet ? 2 : 1

  if (loading) return <div className="p-10 text-center text-black">로딩 중...</div>
  if (!me) return <div className="p-10 text-center text-gray-600">교사 정보를 확인하지 못했어요. 새로고침해 주세요.</div>

  const stats = staged?.stats
  const canCommit = !!staged && staged.status === 'staged' && !committed && !previewStale && (stats!.errors === 0 || excludeErrors) && stats!.valid > 0

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4 sm:px-6">
      <div className="max-w-3xl mx-auto">
        <div className="flex justify-between items-start gap-3 mb-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900">수강 명단 올리기</h1>
            <p className="text-sm text-gray-600 break-keep">
              {me.schoolName ? `${me.schoolName} — ` : ''}학생이 실제로 듣는 수업(분반)을 명단으로 연결해요.
            </p>
          </div>
          <button onClick={() => router.push('/dashboard')} className="shrink-0 min-h-[44px] text-gray-500 hover:text-gray-700 px-2">
            나가기
          </button>
        </div>

        <div className="rounded-xl bg-blue-50 border border-blue-100 p-4 mb-4 text-sm text-blue-900 leading-relaxed break-keep">
          시간표 파일만으로는 학생마다 어떤 선택·이동 수업을 듣는지 알 수 없어요. 명단이 없는 학생에게는 수업을 임의로 넣지 않아요.
          <br />· 학생은 <b>이름이 아니라 학년·반·번호</b>가 정확히 한 명일 때만 후보로 보여요.
          <br />· 후보는 <b>담임 또는 그 수업 담당 선생님이 확인</b>해야 연결돼요. 아직 가입하지 않은 학생은 미연결로 보관했다가 가입·승인되면 후보로 보여요.
          <div className="mt-2 flex flex-wrap gap-2">
            <button onClick={() => router.push('/teacher/timetable-import')} className="rounded-lg bg-white px-3 py-2 text-xs font-bold text-blue-700 ring-1 ring-blue-200">
              먼저 시간표(수업·차시) 가져오기 →
            </button>
          </div>
        </div>

        {/* 진행 단계 */}
        <ol className="flex flex-wrap gap-1.5 mb-4 text-xs" aria-label="진행 단계">
          {['파일', '열 매핑', '미리보기', '저장', '연결 확정'].map((label, i) => (
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
          <h2 className="font-bold text-gray-900 mb-1">1. 명단 파일 선택</h2>
          <p className="text-sm text-gray-600 mb-3 break-keep">
            한 행에 <b>학생 한 명 × 수업 하나</b>가 적힌 엑셀(.xlsx, .xls) 또는 CSV. 최대 10MB, {ROSTER_MAX_ROWS.toLocaleString()}행.
          </p>
          <label className="flex flex-col items-center justify-center border-2 border-dashed border-blue-300 rounded-xl py-8 cursor-pointer bg-blue-50/50 hover:bg-blue-50 transition">
            <span className="text-sm font-bold text-blue-700">{reading ? '읽는 중…' : fileName ? `📄 ${fileName} (다른 파일 선택)` : '파일 선택'}</span>
            <input
              type="file"
              accept={IMPORT_ACCEPT}
              className="sr-only"
              disabled={reading || !!busy}
              onChange={(e) => {
                handleFile(e.target.files)
                e.target.value = ''
              }}
            />
          </label>
          {readError && <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{readError}</p>}
        </section>

        {/* 2. 열 매핑 */}
        {sheet && (
          <section className="bg-white shadow rounded-xl border border-gray-200 p-5 mb-4">
            <h2 className="font-bold text-gray-900 mb-3">2. 열 매핑</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
              {sheets.length > 1 && (
                <label className="text-sm text-gray-700">
                  시트
                  <select
                    value={sheetIdx}
                    onChange={(e) => {
                      const i = Number(e.target.value)
                      setSheetIdx(i)
                      setHeaderRow(guessHeaderRow(sheets[i].grid))
                      resetResults()
                    }}
                    className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  >
                    {sheets.map((s, i) => (
                      <option key={s.name} value={i}>
                        {s.sheetName} ({s.grid.length}행)
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="text-sm text-gray-700">
                머리글 행
                <select
                  value={headerRow}
                  onChange={(e) => {
                    setHeaderRow(Number(e.target.value))
                    resetResults()
                  }}
                  className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                >
                  {sheet.grid.slice(0, 20).map((row, i) => (
                    <option key={i} value={i}>
                      {sheet.origin.r + i + 1}행: {(row || []).map((c) => normSpace(c)).filter(Boolean).slice(0, 4).join(' | ') || '(빈 행)'}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <p className="text-xs text-gray-500 mb-2 break-keep">
              머리글 이름으로 열을 제안했어요. 실제 파일과 맞는지 꼭 확인해 주세요. 필수: 학년·반·번호, 그리고 수업 코드 또는 과목(+분반·교사).
              학년·반이 한 칸(&lsquo;3-4&rsquo;)에 있으면 두 항목에 같은 열을 고르세요.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
              {ROSTER_FIELDS.map((f) => (
                <label key={f.key} className="text-sm text-gray-700 flex items-center gap-2">
                  <span className="w-28 shrink-0">
                    {f.label}
                    {f.required && <span className="text-red-600"> *</span>}
                  </span>
                  <select
                    value={mapping[f.key] ?? ''}
                    onChange={(e) => {
                      setMapping({ ...mapping, [f.key]: e.target.value === '' ? null : Number(e.target.value) })
                      resetResults()
                    }}
                    className="min-w-0 flex-1 rounded-lg border border-gray-300 px-2 py-2 text-sm"
                  >
                    <option value="">(없음)</option>
                    {header.map((h, c) => (
                      <option key={c} value={c}>
                        {colName(sheet.origin.c + c + 1)}열 · {normSpace(h) || '(빈 머리글)'}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            {mappingErrors.length > 0 && (
              <ul className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800 mb-3">
                {mappingErrors.map((m) => (
                  <li key={m}>· {m}</li>
                ))}
              </ul>
            )}
            {mapped && (
              <div className="text-sm text-gray-700 mb-3">
                읽은 행 <b>{mapped.rows.length}</b>개
                {mapped.skipped.blank > 0 && ` · 빈 행 ${mapped.skipped.blank}개 건너뜀`}
                {mapped.skipped.repeatedHeader > 0 && ` · 반복 머리글 ${mapped.skipped.repeatedHeader}개 건너뜀`}
                {tooMany && <p className="mt-2 text-red-700">한 번에 {ROSTER_MAX_ROWS}행까지 올릴 수 있어요. 파일을 나눠 주세요.</p>}
                {badRows.length > 0 && (
                  <div className="mt-2 rounded-lg bg-red-50 p-3 text-red-800">
                    <p className="font-bold">읽지 못한 행 {badRows.length}개</p>
                    <ul className="mt-1 max-h-40 overflow-y-auto text-xs space-y-0.5">
                      {badRows.slice(0, 50).map((p, i) => (
                        <li key={i}>
                          {p.row}행{p.col ? ` ${colName(p.col)}열` : ''}: {p.message} → {p.fix}
                        </li>
                      ))}
                    </ul>
                    <label className="mt-2 flex items-center gap-2 text-xs">
                      <input type="checkbox" checked={skipOk} onChange={(e) => setSkipConsent(e.target.checked ? sourceKey : null)} />
                      읽지 못한 {badRows.length}개 행을 빼고 계속하기 (빠진 학생은 수강이 연결되지 않아요)
                    </label>
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
              <label className="text-sm text-gray-700">
                적용 시작일
                <input
                  type="date"
                  value={ymdToIso(validFrom)}
                  onChange={(e) => {
                    const y = isoToYmd(e.target.value)
                    if (!y || y === validFrom) return
                    setValidFrom(y)
                    // 미리보기는 이 날짜로 만든 것이 아니므로 비움(시간표 가져오기 화면과 같이 다시 미리보기)
                    resetResults()
                  }}
                  className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
                <span className="text-xs text-gray-500">{isYmd(validFrom) ? `${formatYmdKo(validFrom)}부터 수강` : ''}</span>
              </label>
              <label className="text-sm text-gray-700">
                학기 (비우면 적용 시작일 기준 자동)
                <input
                  type="text"
                  value={termId}
                  placeholder="예: 2026-2"
                  onChange={(e) => {
                    const t = e.target.value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
                    if (t === termId) return
                    setTermId(t)
                    resetResults()
                  }}
                  className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </label>
            </div>
            <button
              onClick={stage}
              disabled={!!busy || !stageReady}
              className="w-full rounded-xl bg-blue-600 py-3 text-sm font-bold text-white disabled:opacity-50"
            >
              미리보기 만들기
            </button>
          </section>
        )}

        {failure && (
          <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <p className="font-bold">{failure.message}</p>
            <p className="mt-1 text-xs text-red-600">오류 코드: {failure.code}</p>
          </div>
        )}

        {/* 3. 미리보기 */}
        {staged && stats && (
          <section className="bg-white shadow rounded-xl border border-gray-200 p-5 mb-4">
            <h2 className="font-bold text-gray-900 mb-1">3. 미리보기</h2>
            <p className="text-xs text-gray-500 mb-3">
              학기 {staged.termId} · {formatYmdKo(staged.validFrom)}부터 · 아직 저장되지 않았어요
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3 text-center">
              {[
                { label: '수업 연결됨', v: stats.courseMatched, cls: 'bg-emerald-50 text-emerald-700' },
                { label: '수업 확인 필요', v: stats.courseNotFound + stats.courseAmbiguous + stats.courseEnded, cls: 'bg-amber-50 text-amber-700' },
                { label: '학생 연결 후보', v: stats.linkCandidates, cls: 'bg-blue-50 text-blue-700' },
                { label: '미가입·번호 없음', v: stats.unregistered, cls: 'bg-gray-100 text-gray-700' },
                { label: '오류 행', v: stats.errors, cls: 'bg-red-50 text-red-700' },
                { label: '중복 합침', v: stats.duplicates, cls: 'bg-gray-100 text-gray-700' },
                { label: '이름 다름(확인)', v: stats.nameMismatch, cls: 'bg-red-50 text-red-700' },
                { label: '이미 연결됨', v: stats.alreadyLinked, cls: 'bg-gray-100 text-gray-700' },
              ].map((x) => (
                <div key={x.label} className={`rounded-lg p-2 ${x.cls}`}>
                  <div className="text-xl font-extrabold">{x.v}</div>
                  <div className="text-[11px]">{x.label}</div>
                </div>
              ))}
            </div>
            {staged.issues.length > 0 && (
              <ul className="mb-3 space-y-1 text-sm">
                {staged.issues.map((i) => (
                  <li key={i.code} className={`rounded-lg p-2 ${i.severity === 'warning' ? 'bg-amber-50 text-amber-800' : 'bg-gray-50 text-gray-700'}`}>
                    {i.message}
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-wrap gap-1.5 mb-3" role="tablist">
              {(
                [
                  ['all', `전체 ${stats.total}`],
                  ['errors', `오류 ${stats.errors}`],
                  ['course', `수업 확인 ${stats.courseNotFound + stats.courseAmbiguous + stats.courseEnded}`],
                  ['candidate', `후보 ${stats.linkCandidates}`],
                  ['unregistered', `미가입 ${stats.unregistered + stats.studentAmbiguous}`],
                ] as [RowFilter, string][]
              ).map(([k, label]) => (
                <button
                  key={k}
                  role="tab"
                  aria-selected={filter === k}
                  onClick={() => {
                    setFilter(k)
                    setShowCount(100)
                  }}
                  className={`text-xs px-3 py-1.5 rounded-full border ${filter === k ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-200'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <ul className="divide-y divide-gray-100 border border-gray-100 rounded-lg">
              {rowsShown.slice(0, showCount).map((r) => (
                <li key={r.row} className="p-3 text-sm">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-xs text-gray-400">{r.row}행</span>
                    {r.error ? (
                      <span className="text-red-700">❌ {r.error} → 파일에서 고쳐 다시 올려 주세요.</span>
                    ) : (
                      <>
                        <b className="text-gray-900">{studentLabel(r)}</b>
                        {r.name && <span className="text-gray-600">{r.name}</span>}
                        <span className="text-gray-500">· {courseText(r)}</span>
                      </>
                    )}
                  </div>
                  {!r.error && (
                    <div className="mt-1 space-y-0.5 text-xs break-keep">
                      {r.duplicateOf ? (
                        <p className="text-gray-500">↩︎ {r.duplicateOf}행과 같은 학생·수업이라 하나로 합쳤어요.</p>
                      ) : (
                        <>
                          <p>
                            <CourseBadge c={r.course} />
                          </p>
                          {r.entry === 'linked' ? (
                            <p className="text-gray-500">🔗 이미 학생과 연결된 행이에요(그대로 유지).</p>
                          ) : (
                            <p>
                              <StudentBadge s={r.student} />
                            </p>
                          )}
                          {r.entry === 'existing' && <p className="text-gray-400">이전에 저장한 행 — 저장하면 내용만 갱신돼요.</p>}
                        </>
                      )}
                    </div>
                  )}
                </li>
              ))}
              {rowsShown.length === 0 && <li className="p-3 text-sm text-gray-500">해당하는 행이 없어요.</li>}
            </ul>
            {rowsShown.length > showCount && (
              <button onClick={() => setShowCount(showCount + 200)} className="mt-2 w-full py-2 text-xs text-gray-500">
                더 보기 ({rowsShown.length - showCount}행 남음)
              </button>
            )}

            {!committed && (
              <div className="mt-4 space-y-2">
                {previewStale && (
                  <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 break-keep">
                    ⚠️ 이 미리보기를 만든 뒤에 적용 시작일·학기나 열 매핑이 바뀌었어요. 저장하려면 위에서 &lsquo;미리보기 만들기&rsquo;를 다시 눌러 주세요.
                  </p>
                )}
                {stats.errors > 0 && (
                  <label className="flex items-start gap-2 text-sm text-red-800">
                    <input type="checkbox" className="mt-1" checked={excludeErrors} onChange={(e) => setExcludeErrors(e.target.checked)} />
                    오류 행 {stats.errors}개를 빼고 저장하기 (빠진 학생은 수강이 연결되지 않아요)
                  </label>
                )}
                {stats.courseNotFound + stats.courseAmbiguous + stats.courseEnded > 0 && (
                  <p className="text-xs text-amber-800 break-keep">
                    수업을 확인하지 못한 행은 &lsquo;수업 미확인&rsquo;으로 보관만 하고 연결하지 않아요. 시간표를 가져온 뒤 같은 명단을 다시 올리면 연결돼요.
                  </p>
                )}
                <div className="grid grid-cols-3 gap-2">
                  <button onClick={cancel} disabled={!!busy} className="rounded-xl bg-white py-3 text-sm font-bold text-gray-600 ring-1 ring-gray-300 disabled:opacity-50">
                    취소
                  </button>
                  <button onClick={commit} disabled={!!busy || !canCommit} className="col-span-2 rounded-xl bg-blue-600 py-3 text-sm font-bold text-white disabled:opacity-50">
                    명단 저장
                  </button>
                </div>
              </div>
            )}
            {committed && (
              <div className="mt-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
                ✅ {committed.already ? '이미 저장한 명단이에요.' : '명단을 저장했어요.'}
                {committed.result && (
                  <span>
                    {' '}
                    새 행 {committed.result.created} · 갱신 {committed.result.updated}
                    {committed.result.skippedErrors ? ` · 오류로 제외 ${committed.result.skippedErrors}` : ''}
                    {committed.result.unmatchedCourse ? ` · 수업 미확인 ${committed.result.unmatchedCourse}` : ''}
                  </span>
                )}
                <br />
                학생 시간표에 보이려면 아래에서 <b>연결 확정</b>을 해 주세요.
              </div>
            )}
          </section>
        )}

        {/* 5. 미연결 목록 + 연결 확정 */}
        <section className="bg-white shadow rounded-xl border border-gray-200 p-5 mb-10">
          <div className="flex items-center justify-between gap-2 mb-1">
            <h2 className="font-bold text-gray-900">연결 확정 (미연결 명단)</h2>
            <button onClick={loadList} disabled={listLoading} className="text-xs text-blue-700 px-2 py-1 disabled:opacity-50">
              {listLoading ? '불러오는 중…' : '새로고침'}
            </button>
          </div>
          <p className="text-xs text-gray-500 mb-3 break-keep">
            내가 담임인 반 학생과 내가 맡은 수업의 명단만 보여요. 같은 반·번호로 승인된 학생이 한 명일 때만 연결할 수 있어요.
          </p>
          {listError && (
            <div role="alert" className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-800">
              {listError.message} <span className="text-xs text-red-600">({listError.code})</span>
            </div>
          )}
          {linkResult && (
            <div className="mb-3 rounded-lg bg-gray-50 p-3 text-xs text-gray-700">
              연결 {linkResult.linked}건(새 수강 {linkResult.enrollmentsCreated}건)
              {linkResult.results.filter((r) => r.status !== 'linked' && r.status !== 'enrollment-exists').length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {linkResult.results
                    .filter((r) => r.status !== 'linked' && r.status !== 'enrollment-exists')
                    .map((r) => (
                      <li key={r.entryId}>· {r.message || r.status}</li>
                    ))}
                </ul>
              )}
            </div>
          )}
          {list && list.entries.length === 0 && !listError && (
            <p className="text-sm text-gray-500">
              {list.scope.homerooms.length === 0 && list.scope.courseCount === 0
                ? '담임 반이나 맡은 수업이 없어 볼 수 있는 명단이 없어요.'
                : '연결을 기다리는 명단이 없어요.'}
            </p>
          )}
          {list && list.entries.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-2 mb-2 text-xs">
                <span className="text-gray-600">
                  미연결 {list.counts.unlinked} · 연결 가능 {linkable.length}
                </span>
                <button
                  onClick={() => {
                    const next: Record<string, boolean> = {}
                    linkable.filter((e) => e.candidate?.nameMatches !== false).forEach((e) => (next[e.entryId] = true))
                    setSelected(next)
                  }}
                  disabled={linkable.length === 0}
                  className="rounded-full border border-gray-200 px-3 py-1 text-gray-700 disabled:opacity-50"
                >
                  이름이 같은 후보 모두 선택
                </button>
                <button onClick={() => setSelected({})} className="rounded-full border border-gray-200 px-3 py-1 text-gray-700">
                  선택 해제
                </button>
              </div>
              <ul className="divide-y divide-gray-100 border border-gray-100 rounded-lg max-h-[28rem] overflow-y-auto">
                {list.entries.map((e) => {
                  const can = e.canLink && e.candidate?.status === 'candidate'
                  return (
                    <li key={e.entryId} className="p-3 text-sm">
                      <label className={`flex items-start gap-2 ${can ? 'cursor-pointer' : ''}`}>
                        <input
                          type="checkbox"
                          className="mt-1"
                          disabled={!can}
                          checked={!!selected[e.entryId]}
                          onChange={(ev) => setSelected({ ...selected, [e.entryId]: ev.target.checked })}
                          aria-label={`${studentLabel(e)} 연결 선택`}
                        />
                        <span className="min-w-0">
                          <b className="text-gray-900">{studentLabel(e)}</b> {e.name && <span className="text-gray-600">{e.name}</span>}
                          <span className="block text-xs text-gray-600">
                            {e.courseId ? `수업: ${e.courseTitle || courseText(e)}` : `수업 미확인 — ${courseText(e)}`}
                            {e.validFrom && isYmd(e.validFrom) ? ` · ${formatYmdKo(e.validFrom)}부터` : ''}
                          </span>
                          <span className="block text-xs break-keep">
                            {e.courseId ? (
                              e.candidate ? (
                                <StudentBadge s={e.candidate} />
                              ) : (
                                <span className="text-gray-500">이 학생의 담임이나 이 수업 담당 선생님이 연결할 수 있어요.</span>
                              )
                            ) : (
                              <span className="text-amber-700">시간표를 가져온 뒤 명단을 다시 올리면 수업과 연결돼요.</span>
                            )}
                          </span>
                        </span>
                      </label>
                    </li>
                  )
                })}
              </ul>
              <button
                onClick={link}
                disabled={!!busy || selectedIds.length === 0}
                className="mt-3 w-full rounded-xl bg-blue-600 py-3 text-sm font-bold text-white disabled:opacity-50"
              >
                선택한 {selectedIds.length}건 연결 확정
              </button>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
