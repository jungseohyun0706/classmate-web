import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/router'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db } from '../../lib/firebase'
import { useUI } from '../../components/ui/feedback'
import ChangePreview, { changeBadges, changeSummaryText, OrphanList } from '../../components/timetable/ChangePreview'
import { addDays, formatYmdKo, isoToYmd, relativeDayLabel, schoolYmdAt, ymdToIso } from '../../lib/timetable/dates'
import type { Course, LessonSeries, Override, PeriodTime, Weekday, Ymd } from '../../lib/timetable/types'
import {
  approveChangeSet,
  asScheduleError,
  defaultPeriodTimesFor,
  describeError,
  listAwaitingMe,
  listCourseHistory,
  listMyCourses,
  listOrphans,
  loadChangeSet,
  loadOverrides,
  loadSchoolCourses,
  loadSchoolTeachers,
  loadSeries,
  newMutationId,
  occurrencesOn,
  previewChanges,
  publishChanges,
  rejectChangeSet,
  slotTimeText,
  WEEKDAY_NAMES,
  type ChangeDraft,
  type ChangeItemInput,
  type ChangeSetSummary,
  type ConflictEntry,
  type ErrorView,
  type OccurrenceView,
  type OrphanEntry,
  type PreviewResponse,
  type TeacherCourse,
} from '../../lib/timetable/scheduleChangeClient'
import { deselectCourse, draftScopeOf, makeupCourseFor, mergeDraftEntries, planOrphanRestore } from '../../lib/timetable/scheduleChangeView'

// 공식 수업 일정 변경 (요구 문서 5절 '/teacher/schedule-changes', 지시서 11·12장)
// (a) 새 변경: 수업 → 날짜 → 차시 → 종류(이 날짜만 / 지정일부터 기본 시간표) → 교시 교환 → 사유 → 미리보기 → 발행
// (b) 승인 요청: 다른 선생님이 내 수업을 포함해 요청한 변경 — 승인/거절 (알림 링크 ?changeSetId= 로 바로 열림)
// (c) 변경 이력: 수업별 최근 50개 + 검토 필요(기본 시간표 변경으로 대상이 사라진 변경) 정리
// 권한·검증·충돌·동시 수정은 모두 서버(/api/schedule-changes)가 판정합니다. 이 화면은 결과를 code로 구분해 안내만 합니다.
// 학생 명단·이름과 내부 id는 화면에 보여 주지 않습니다(영향 학생은 '수'만).

type Tab = 'new' | 'approvals' | 'history'
type EditKind = 'time' | 'move' | 'room' | 'teacher' | 'cancel' | 'restore' | 'base'

interface Me {
  uid: string
  schoolCode: string
  schoolName: string
}

type Sched =
  | { status: 'loading' }
  | { status: 'error'; error: ErrorView }
  | { status: 'ready'; series: LessonSeries[]; overrides: Override[] }

interface DraftEntry {
  id: string
  label: string
  item: ChangeItemInput
}

const MAX_ITEMS = 40
const PERIOD_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
const WEEKDAY_OPTIONS: Weekday[] = [1, 2, 3, 4, 5, 6, 7]
const CS_ID_RE = /^cs_[A-Za-z0-9_-]{6,100}$/

const KIND_DATE: Array<{ key: EditKind; label: string }> = [
  { key: 'time', label: '교시·시각 이동' },
  { key: 'move', label: '다른 날짜로 이동' },
  { key: 'room', label: '교실 변경' },
  { key: 'teacher', label: '교사 변경' },
  { key: 'cancel', label: '취소' },
  { key: 'restore', label: '원래대로' },
]

const STATUS_LABEL: Record<ChangeSetSummary['status'], { text: string; icon: string; cls: string }> = {
  published: { text: '발행됨', icon: '✓', cls: 'bg-green-50 text-green-800 ring-green-300' },
  'pending-approval': { text: '승인 대기', icon: '⏳', cls: 'bg-amber-50 text-amber-900 ring-amber-300' },
  rejected: { text: '거절됨', icon: '✕', cls: 'bg-gray-100 text-gray-700 ring-gray-300' },
}

const btnPrimary =
  'min-h-[44px] rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-blue-700 transition disabled:cursor-not-allowed disabled:opacity-50'
const btnSecondary =
  'min-h-[44px] rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-blue-700 ring-1 ring-blue-200 hover:bg-blue-50 transition disabled:cursor-not-allowed disabled:opacity-50'
const btnGhost = 'min-h-[44px] rounded-xl px-3 py-2 text-sm font-bold text-gray-600 hover:bg-gray-100 transition disabled:opacity-50'
const inputCls = 'mt-1 block w-full min-h-[44px] rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900'
const cardCls = 'bg-white shadow rounded-xl border border-gray-200 p-4 sm:p-5 mb-4'

const uid = () => Math.random().toString(36).slice(2, 10)
const timeOf = (ms: number | null) =>
  ms
    ? new Date(ms).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '시각 정보 없음'

function seriesSummary(series: LessonSeries[], today: Ymd): string {
  const live = series.filter((s) => !s.validTo || s.validTo > today)
  if (!live.length) return '등록된 반복 차시 없음'
  const slots = Array.from(new Set(live.map((s) => `${WEEKDAY_NAMES[s.weekday]} ${s.period}교시`)))
  return slots.slice(0, 4).join(', ') + (slots.length > 4 ? ` 외 ${slots.length - 4}개` : '')
}

function ErrorBox({ err, onRetry, retryLabel = '다시 시도' }: { err: ErrorView; onRetry?: () => void; retryLabel?: string }) {
  return (
    <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800 break-keep">
      <p className="font-bold">{err.title}</p>
      {err.detail && <p className="mt-1">{err.detail}</p>}
      {(err.retryable || !ERRORS_WITHOUT_CODE.has(err.code)) && <p className="mt-1 text-xs text-red-700">오류 코드: {err.code}</p>}
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-2 min-h-[44px] rounded-lg bg-white px-3 py-2 text-sm font-bold text-red-700 ring-1 ring-red-300">
          {retryLabel}
        </button>
      )}
    </div>
  )
}

/** 사용자가 고칠 수 있는 입력 오류 — 코드까지 보일 필요 없음 */
const ERRORS_WITHOUT_CODE = new Set([
  'no-change',
  'nothing-to-restore',
  'invalid-slot',
  'out-of-term',
  'course-ended',
  'past-effective-date',
  'effective-before-series',
  'series-ended',
  'duplicate-item',
  'too-many-items',
  'stale-revision',
  'conflicts',
  'not-pending',
])

function StatusChip({ status }: { status: ChangeSetSummary['status'] }) {
  const s = STATUS_LABEL[status]
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ring-1 ${s.cls}`}>
      <span aria-hidden>{s.icon}</span>
      {s.text}
    </span>
  )
}

// ───────────────────────── 차시 카드 ─────────────────────────

function OccurrenceCard({ o, picked, onToggle, periodTimes }: { o: OccurrenceView; picked: boolean; onToggle: () => void; periodTimes?: PeriodTime[] }) {
  const shown = o.status === 'cancelled' || o.status === 'moved-out' ? o.base || o.state : o.state
  const time = slotTimeText(shown, periodTimes)
  const changed = o.status !== 'normal'
  const badges: Array<{ icon: string; text: string }> = []
  if (o.status === 'cancelled') badges.push({ icon: '✕', text: '취소됨' })
  else if (o.status === 'moved-out') badges.push({ icon: '📅', text: '다른 날로 옮겨짐' })
  else if (o.status === 'makeup') badges.push({ icon: '➕', text: '보강' })
  if (o.status === 'changed' || o.status === 'moved-in' || (o.status === 'makeup' && o.fields.length)) {
    changeBadges({ kind: 'reschedule', fields: o.fields }).forEach((b) => badges.push(b))
  }
  const statusText = badges.map((b) => b.text).join(', ')
  return (
    <button
      type="button"
      aria-pressed={picked}
      aria-label={`${o.title} ${shown.period}교시${statusText ? ' ' + statusText : ''}${o.canManage ? '' : ' 다른 선생님 수업'}`}
      onClick={onToggle}
      className={`w-full min-h-[44px] text-left rounded-xl p-3 transition ${
        picked ? 'ring-2 ring-blue-600 bg-blue-50' : 'ring-1 ring-gray-200 bg-white hover:bg-gray-50'
      } ${changed ? 'border-2 border-red-300' : 'border-2 border-transparent'}`}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-xs font-bold ${
            picked ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-300 text-transparent'
          }`}
        >
          ✓
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-gray-900 break-keep">
            {shown.period}교시{time ? <span className="ml-1 text-sm font-normal text-gray-600">{time}</span> : null} · {o.title}
          </p>
          <p className="text-sm text-gray-600 break-keep">
            {shown.roomName || '교실 미정'} · {(shown.teacherNames || []).join(', ') || '교사 미정'}
          </p>
          {(badges.length > 0 || !o.canManage) && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {badges.map((b) => (
                <span key={b.text} className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-bold text-red-800 ring-1 ring-red-300">
                  <span aria-hidden>{b.icon}</span>
                  {b.text}
                </span>
              ))}
              {!o.canManage && (
                <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-bold text-gray-700 ring-1 ring-gray-300">
                  다른 선생님 수업 · 승인 필요
                </span>
              )}
            </div>
          )}
          {o.status === 'moved-out' && (
            <p className="mt-1 text-sm text-red-700 break-keep">
              → 지금은 {formatYmdKo(o.state.date)} {o.state.period}교시
            </p>
          )}
          {(o.status === 'changed' || o.status === 'moved-in') && o.base && (
            <p className="mt-1 text-sm text-gray-600 break-keep">
              원래 {o.status === 'moved-in' ? formatYmdKo(o.base.date) + ' ' : ''}
              {o.base.period}교시 · {o.base.roomName || '교실 미정'}
            </p>
          )}
          {o.reason && <p className="mt-0.5 text-xs text-gray-500 break-keep">사유: {o.reason}</p>}
        </div>
      </div>
    </button>
  )
}

// ───────────────────────── 페이지 ─────────────────────────

export default function ScheduleChangesPage() {
  const router = useRouter()
  const { toast, confirm } = useUI()
  const today = useMemo(() => schoolYmdAt(Date.now()), [])

  const [loading, setLoading] = useState(true)
  const [me, setMe] = useState<Me | null>(null)
  const [tab, setTab] = useState<Tab>('new')
  const periodTimes = useMemo(() => defaultPeriodTimesFor(me?.schoolName), [me])

  // 내 수업
  const [myCourses, setMyCourses] = useState<TeacherCourse[] | null>(null)
  const [termId, setTermId] = useState<string | null>(null)
  const [coursesError, setCoursesError] = useState<ErrorView | null>(null)
  const [coursesLoading, setCoursesLoading] = useState(false)

  // 다른 선생님 수업(교시 교환 상대)
  const [otherCourses, setOtherCourses] = useState<TeacherCourse[]>([])
  const [schoolCourses, setSchoolCourses] = useState<Course[] | null>(null)
  const [schoolCoursesError, setSchoolCoursesError] = useState<ErrorView | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [search, setSearch] = useState('')

  // 선택
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [scheds, setScheds] = useState<Record<string, Sched>>({})
  const [date, setDate] = useState<Ymd>(today)
  const [picked, setPicked] = useState<string[]>([])

  // 편집기
  const [kind, setKind] = useState<EditKind>('time')
  const [fPeriod, setFPeriod] = useState(1)
  const [fStart, setFStart] = useState('')
  const [fEnd, setFEnd] = useState('')
  const [fMoveDate, setFMoveDate] = useState<Ymd>(today)
  const [fMovePeriod, setFMovePeriod] = useState(1)
  const [fRoom, setFRoom] = useState('')
  const [fTeacher, setFTeacher] = useState('')
  const [fTeacherName, setFTeacherName] = useState('')
  const [fBaseFrom, setFBaseFrom] = useState<Ymd>(today)
  const [fBaseWeekday, setFBaseWeekday] = useState<Weekday>(1)
  const [fBasePeriod, setFBasePeriod] = useState(1)
  const [fBaseRoom, setFBaseRoom] = useState('')
  const [teachers, setTeachers] = useState<Array<{ uid: string; name: string }> | null>(null)
  const [teachersError, setTeachersError] = useState<ErrorView | null>(null)

  // 보강 추가
  const [makeupOpen, setMakeupOpen] = useState(false)
  const [mCourse, setMCourse] = useState('')
  const [mDate, setMDate] = useState<Ymd>(today)
  const [mPeriod, setMPeriod] = useState(1)
  const [mRoom, setMRoom] = useState('')

  // 변경 목록·미리보기·발행
  const [draft, setDraft] = useState<DraftEntry[]>([])
  const [reason, setReason] = useState('')
  const [mutationId, setMutationId] = useState<string>('')
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [previewError, setPreviewError] = useState<ErrorView | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [ack, setAck] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const publishingRef = useRef(false)
  const [publishError, setPublishError] = useState<ErrorView | null>(null)
  const [stale, setStale] = useState<{ currentRevision: number | null } | null>(null)
  const [result, setResult] = useState<{ status: number; summary: ChangeSetSummary } | null>(null)
  const draftRef = useRef<HTMLElement | null>(null)

  // 승인 요청
  const [awaiting, setAwaiting] = useState<ChangeSetSummary[] | null>(null)
  const [awaitingError, setAwaitingError] = useState<ErrorView | null>(null)
  const [awaitingLoading, setAwaitingLoading] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [focusId, setFocusId] = useState<string | null>(null)
  const [focusState, setFocusState] = useState<{ kind: 'loading' } | { kind: 'found'; cs: ChangeSetSummary } | { kind: 'missing'; error?: ErrorView } | null>(null)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const actionRef = useRef(false)
  const [approveConflicts, setApproveConflicts] = useState<Record<string, ConflictEntry[]>>({})
  const [approveAck, setApproveAck] = useState<Record<string, boolean>>({})
  const [cardError, setCardError] = useState<Record<string, ErrorView>>({})
  const [rejectOpen, setRejectOpen] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [processed, setProcessed] = useState<Array<{ id: string; text: string; cs: ChangeSetSummary }>>([])

  // 변경 이력
  const [histCourse, setHistCourse] = useState('')
  const [history, setHistory] = useState<ChangeSetSummary[] | null>(null)
  // history가 어느 수업 것인지 — 수업을 바꾼 사이 늦게 온 다른 수업 응답이 덮어쓰지 않게
  const [historyFor, setHistoryFor] = useState('')
  const histSeq = useRef(0)
  const histInflight = useRef('')
  const [historyError, setHistoryError] = useState<ErrorView | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [orphans, setOrphans] = useState<OrphanEntry[] | null>(null)
  const [orphansError, setOrphansError] = useState<ErrorView | null>(null)
  const [histExpanded, setHistExpanded] = useState<Record<string, boolean>>({})

  // ── 인증·역할 확인(화면 표시용 — 실제 권한은 서버가 users 문서로 다시 판정) ──
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.replace('/auth/login')
        return
      }
      try {
        const snap = await getDoc(doc(db, 'users', u.uid))
        const data = snap.exists() ? snap.data() : null
        if (!data || data.role !== 'teacher') {
          toast('선생님 계정만 쓸 수 있는 화면이에요. 홈으로 이동할게요.', 'info')
          router.replace(data?.role === 'student' ? '/student/today' : '/dashboard')
          return
        }
        if (!data.schoolCode) {
          toast('먼저 학교 등록을 마쳐 주세요.', 'info')
          router.replace('/teacher/register-class')
          return
        }
        setMe({ uid: u.uid, schoolCode: String(data.schoolCode), schoolName: String(data.schoolName || '') })
      } catch (e) {
        console.error('schedule-changes: 내 정보 확인 실패', (e as Error)?.message)
        toast('내 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.', 'error')
      } finally {
        setLoading(false)
      }
    })
    return () => unsub()
  }, [router, toast])

  // ── 알림 링크(?changeSetId=)로 들어오면 승인 요청 탭에서 그 요청을 펼침 ──
  useEffect(() => {
    if (!router.isReady) return
    const q = router.query.changeSetId
    const id = typeof q === 'string' && CS_ID_RE.test(q) ? q : null
    if (id) {
      setTab('approvals')
      setFocusId(id)
      setExpanded((p) => ({ ...p, [id]: true }))
    }
  }, [router.isReady, router.query.changeSetId])

  const loadCourses = useCallback(async (): Promise<TeacherCourse[] | null> => {
    setCoursesLoading(true)
    setCoursesError(null)
    try {
      const r = await listMyCourses()
      setMyCourses(r.courses)
      setTermId(r.termId)
      return r.courses
    } catch (e) {
      setCoursesError(describeError(e))
      return null
    } finally {
      setCoursesLoading(false)
    }
  }, [])

  const loadAwaiting = useCallback(async () => {
    setAwaitingLoading(true)
    setAwaitingError(null)
    try {
      setAwaiting(await listAwaitingMe())
    } catch (e) {
      setAwaitingError(describeError(e))
    } finally {
      setAwaitingLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!me) return
    loadCourses()
    loadAwaiting()
    setMutationId(newMutationId())
  }, [me, loadCourses, loadAwaiting])

  const courseById = useMemo(() => {
    const m = new Map<string, TeacherCourse>()
    ;(myCourses || []).forEach((c) => m.set(c.course.courseId, c))
    otherCourses.forEach((c) => {
      if (!m.has(c.course.courseId)) m.set(c.course.courseId, c)
    })
    return m
  }, [myCourses, otherCourses])
  const titleOf = useCallback((id: string) => courseById.get(id)?.course.title || '수업', [courseById])

  // ── 선택한 수업의 차시·변경 읽기 ──
  const loadSchedule = useCallback(
    async (tc: TeacherCourse) => {
      if (!me) return
      const id = tc.course.courseId
      setScheds((p) => ({ ...p, [id]: { status: 'loading' } }))
      try {
        const [series, overrides] = await Promise.all([
          tc.mine ? Promise.resolve(tc.series) : loadSeries(db, me.schoolCode, id),
          loadOverrides(db, me.schoolCode, id),
        ])
        setScheds((p) => ({ ...p, [id]: { status: 'ready', series, overrides } }))
      } catch (e) {
        console.error('schedule-changes: 차시 읽기 실패', asScheduleError(e).code)
        setScheds((p) => ({ ...p, [id]: { status: 'error', error: describeError(e) } }))
      }
    },
    [me]
  )

  /** 최신 시간표 다시 읽기(발행 후·다른 변경이 먼저 발행됐을 때) */
  const reloadSchedules = useCallback(async () => {
    const fresh = await loadCourses()
    const byId = new Map<string, TeacherCourse>()
    ;(fresh || myCourses || []).forEach((c) => byId.set(c.course.courseId, c))
    otherCourses.forEach((c) => {
      if (!byId.has(c.course.courseId)) byId.set(c.course.courseId, c)
    })
    await Promise.all(
      selectedIds.map((id) => {
        const tc = byId.get(id)
        return tc ? loadSchedule(tc) : Promise.resolve()
      })
    )
  }, [loadCourses, loadSchedule, myCourses, otherCourses, selectedIds])

  // ── 수업 상세의 '일정 변경' 버튼(?courseId=)으로 들어오면 그 수업을 미리 선택(내 수업일 때만, 한 번만) ──
  const preselected = useRef(false)
  useEffect(() => {
    if (preselected.current || !router.isReady || !myCourses) return
    preselected.current = true
    const q = router.query.courseId
    const tc = typeof q === 'string' ? myCourses.find((c) => c.course.courseId === q) : undefined
    if (!tc || selectedIds.length) return
    setSelectedIds([tc.course.courseId])
    setHistCourse(tc.course.courseId)
    loadSchedule(tc)
  }, [router.isReady, router.query.courseId, myCourses, selectedIds.length, loadSchedule])

  const toggleCourse = (tc: TeacherCourse) => {
    const id = tc.course.courseId
    setPicked([])
    if (selectedIds.includes(id)) {
      // 보강 추가 패널이 이 수업을 대상으로 열려 있었으면 닫고 대상 수업을 남은 선택 안에서 다시 정함
      // (예전에는 뺀 수업이 패널에 남아, 목록에 없는 그 수업으로 보강이 추가됐음)
      const nextSel = deselectCourse(selectedIds, id, mCourse)
      setSelectedIds(nextSel.selectedIds)
      setMCourse(nextSel.mCourse)
      if (nextSel.closeMakeup) setMakeupOpen(false)
      return
    }
    setSelectedIds([...selectedIds, id])
    loadSchedule(tc)
  }

  const openSearch = async () => {
    setSearchOpen(true)
    if (schoolCourses || !me) return
    setSchoolCoursesError(null)
    try {
      setSchoolCourses(await loadSchoolCourses(db, me.schoolCode, termId))
    } catch (e) {
      setSchoolCoursesError(describeError(e))
    }
  }

  const addOtherCourse = (c: Course) => {
    if (courseById.has(c.courseId)) {
      const tc = courseById.get(c.courseId)!
      if (!selectedIds.includes(c.courseId)) toggleCourse(tc)
      return
    }
    const tc: TeacherCourse = { course: c, canManage: !!me && (c.teacherUids.includes(me.uid) || (c.managerUids || []).includes(me.uid)), mine: false, series: [] }
    setOtherCourses((p) => p.concat(tc))
    setSelectedIds((p) => p.concat(c.courseId))
    setPicked([])
    loadSchedule(tc)
    setSearch('')
  }

  const searchResults = useMemo(() => {
    if (!schoolCourses) return []
    const q = search.replace(/\s+/g, '').toLowerCase()
    const mine = new Set((myCourses || []).map((c) => c.course.courseId))
    return schoolCourses
      .filter((c) => !selectedIds.includes(c.courseId) && !mine.has(c.courseId))
      .filter((c) => {
        if (!q) return true
        const hay = [c.title, c.subject, c.section || '', ...c.teacherNames].join(' ').replace(/\s+/g, '').toLowerCase()
        return hay.includes(q)
      })
      .slice(0, 20)
  }, [schoolCourses, search, selectedIds, myCourses])

  // ── 그 날짜 차시 ──
  const selectedReady = useMemo(
    () =>
      selectedIds
        .map((id) => {
          const tc = courseById.get(id)
          const s = scheds[id]
          return tc && s && s.status === 'ready' ? { ...tc, series: s.series, overrides: s.overrides } : null
        })
        .filter((x): x is TeacherCourse & { overrides: Override[] } => !!x),
    [selectedIds, courseById, scheds]
  )
  const occs = useMemo(() => occurrencesOn(date, selectedReady), [date, selectedReady])
  const schedLoading = selectedIds.some((id) => !scheds[id] || scheds[id].status === 'loading')
  const schedErrors = selectedIds
    .map((id) => ({ id, s: scheds[id] }))
    .filter((x): x is { id: string; s: { status: 'error'; error: ErrorView } } => !!x.s && x.s.status === 'error')
  const pickedOccs = picked.map((k) => occs.find((o) => o.key === k)).filter((o): o is OccurrenceView => !!o)
  const one = pickedOccs.length === 1 ? pickedOccs[0] : null
  const oneSeries = useMemo(() => {
    if (!one || !one.seriesId) return null
    const s = scheds[one.courseId]
    return s && s.status === 'ready' ? s.series.find((x) => x.seriesId === one.seriesId) || null : null
  }, [one, scheds])

  useEffect(() => {
    setPicked([])
  }, [date])

  // 차시를 하나 고르면 편집 기본값을 그 차시로
  const oneKey = one?.key || ''
  useEffect(() => {
    if (!one) return
    const cur = one.state
    setKind(one.status === 'cancelled' ? 'restore' : 'time')
    setFPeriod(cur.period)
    setFStart('')
    setFEnd('')
    setFMoveDate(cur.date)
    setFMovePeriod(cur.period)
    setFRoom('')
    setFTeacher('')
    setFTeacherName('')
    setFBaseFrom(date > today ? date : today)
    if (oneSeries) {
      setFBaseWeekday(oneSeries.weekday)
      setFBasePeriod(oneSeries.period)
      setFBaseRoom(oneSeries.roomName || courseById.get(one.courseId)?.course.defaultRoomName || '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oneKey])

  const togglePick = (o: OccurrenceView) => {
    if (picked.includes(o.key)) {
      setPicked(picked.filter((k) => k !== o.key))
      return
    }
    if (picked.length >= 2) {
      toast('차시는 두 개까지 고를 수 있어요(교시 교환). 하나를 먼저 해제해 주세요.', 'info')
      return
    }
    setPicked([...picked, o.key])
  }

  const needTeachers = kind === 'teacher' && !!one
  useEffect(() => {
    if (!needTeachers || teachers || !me) return
    loadSchoolTeachers(db, me.schoolCode)
      .then((t) => setTeachers(t))
      .catch((e) => setTeachersError(describeError(e)))
  }, [needTeachers, teachers, me])

  // ── 변경 목록 ──
  const scope = draftScopeOf(draft)

  const resetOutcome = () => {
    setPreview(null)
    setPreviewError(null)
    setAck(false)
    setPublishError(null)
    setStale(null)
    setMutationId(newMutationId())
  }

  const SCOPE_MIX_TEXT = '‘이 날짜만’ 변경과 ‘기본 시간표 변경’은 따로 발행해 주세요. 변경 목록을 먼저 비워 주세요.'
  const TOO_MANY_TEXT = `한 번에 ${MAX_ITEMS}개 차시까지 바꿀 수 있어요. 나눠서 발행해 주세요.`

  const addItems = (entries: Array<{ label: string; item: ChangeItemInput }>) => {
    // 같은 차시 항목 합치기·바꾸기, 범위 섞기 막기 — 규칙은 scheduleChangeView.mergeDraftEntries(검토 필요 '원래대로'도 같은 규칙)
    const r = mergeDraftEntries(draft, entries, { max: MAX_ITEMS, newId: uid })
    if (!r.ok) {
      toast(r.error === 'scope-mismatch' ? SCOPE_MIX_TEXT : TOO_MANY_TEXT, 'error')
      return false
    }
    const { next, replaced, merged } = r
    setDraft(next)
    setResult(null)
    resetOutcome()
    toast(merged ? '같은 차시의 변경과 합쳤어요.' : replaced ? '같은 차시의 이전 항목을 새 내용으로 바꿨어요.' : '변경 목록에 추가했어요.', 'success')
    return true
  }

  const removeItem = (id: string) => {
    setDraft(draft.filter((d) => d.id !== id))
    resetOutcome()
  }

  const occLabel = (o: OccurrenceView) => {
    const s = o.status === 'cancelled' || o.status === 'moved-out' ? o.base || o.state : o.state
    return `${o.title} · ${formatYmdKo(s.date)} ${s.period}교시`
  }

  const addFromEditor = () => {
    if (!one) return
    const o = one
    const cur = o.state
    const label = occLabel(o)
    const timeText = fStart || fEnd ? ` (${fStart || '?'}–${fEnd || '?'})` : ''
    switch (kind) {
      case 'time': {
        if (fPeriod === cur.period && !fStart && !fEnd && o.status !== 'cancelled') {
          toast('바꿀 교시나 시각을 골라 주세요.', 'error')
          return
        }
        const target = { date: cur.date, period: fPeriod, ...(fStart || fEnd ? { start: fStart || null, end: fEnd || null } : {}) }
        addItems([{ label: `${label} → ${fPeriod}교시${timeText}`, item: { op: 'reschedule', courseId: o.courseId, occurrenceKey: o.occurrenceKey, target } }])
        return
      }
      case 'move': {
        if (fMoveDate === cur.date && fMovePeriod === cur.period && o.status !== 'cancelled') {
          toast('옮길 날짜나 교시를 바꿔 주세요.', 'error')
          return
        }
        addItems([
          {
            label: `${label} → ${formatYmdKo(fMoveDate)} ${fMovePeriod}교시`,
            item: { op: 'reschedule', courseId: o.courseId, occurrenceKey: o.occurrenceKey, target: { date: fMoveDate, period: fMovePeriod } },
          },
        ])
        return
      }
      case 'room': {
        const room = fRoom.trim()
        if (!room) {
          toast('바꿀 교실 이름을 입력해 주세요.', 'error')
          return
        }
        addItems([{ label: `${label} 교실 → ${room}`, item: { op: 'reschedule', courseId: o.courseId, occurrenceKey: o.occurrenceKey, target: { roomName: room } } }])
        return
      }
      case 'teacher': {
        const t = teachers?.find((x) => x.uid === fTeacher)
        const name = fTeacherName.trim()
        if (!t && !name) {
          toast('바꿀 선생님을 고르거나 이름을 입력해 주세요.', 'error')
          return
        }
        const target = t ? { teacherUids: [t.uid] } : { teacherNames: [name] }
        addItems([{ label: `${label} 교사 → ${t ? t.name : name}`, item: { op: 'reschedule', courseId: o.courseId, occurrenceKey: o.occurrenceKey, target } }])
        return
      }
      case 'cancel':
        addItems([{ label: `${label} 취소`, item: { op: 'cancel', courseId: o.courseId, occurrenceKey: o.occurrenceKey } }])
        return
      case 'restore':
        addItems([{ label: `${label} 원래대로`, item: { op: 'restore', courseId: o.courseId, occurrenceKey: o.occurrenceKey } }])
        return
      case 'base': {
        if (!o.seriesId || !oneSeries) {
          toast('보강 차시는 기본 시간표를 바꿀 수 없어요.', 'error')
          return
        }
        if (fBaseFrom < today) {
          toast('기본 시간표 변경은 오늘 이후 날짜부터 적용할 수 있어요.', 'error')
          return
        }
        const room = fBaseRoom.trim()
        const curRoom = oneSeries.roomName || courseById.get(o.courseId)?.course.defaultRoomName || ''
        const item: ChangeItemInput = { op: 'base', courseId: o.courseId, seriesId: o.seriesId, effectiveFrom: fBaseFrom }
        const parts: string[] = []
        if (fBaseWeekday !== oneSeries.weekday) {
          item.weekday = fBaseWeekday
          parts.push(`${WEEKDAY_NAMES[fBaseWeekday]}요일`)
        }
        if (fBasePeriod !== oneSeries.period) {
          item.period = fBasePeriod
          parts.push(`${fBasePeriod}교시`)
        }
        if (room && room !== curRoom) {
          item.roomName = room
          parts.push(`교실 ${room}`)
        }
        if (!parts.length) {
          toast('바꿀 요일·교시·교실을 골라 주세요.', 'error')
          return
        }
        addItems([
          {
            label: `${o.title} 기본 시간표(매주 ${WEEKDAY_NAMES[oneSeries.weekday]} ${oneSeries.period}교시) → ${parts.join(' ')} · ${formatYmdKo(fBaseFrom)}부터`,
            item,
          },
        ])
        return
      }
    }
  }

  const swapPicked = () => {
    if (pickedOccs.length !== 2) return
    const [a, b] = pickedOccs
    if (a.status === 'cancelled' || a.status === 'moved-out' || b.status === 'cancelled' || b.status === 'moved-out') {
      toast('지금 이 날짜에 열리는 차시끼리만 서로 바꿀 수 있어요.', 'error')
      return
    }
    const to = (x: OccurrenceView) => ({ date: x.state.date, period: x.state.period, start: x.state.start ?? null, end: x.state.end ?? null })
    addItems([
      {
        label: `${occLabel(a)} → ${b.state.date === a.state.date ? '' : formatYmdKo(b.state.date) + ' '}${b.state.period}교시 (교시 교환)`,
        item: { op: 'reschedule', courseId: a.courseId, occurrenceKey: a.occurrenceKey, target: to(b) },
      },
      {
        label: `${occLabel(b)} → ${a.state.date === b.state.date ? '' : formatYmdKo(a.state.date) + ' '}${a.state.period}교시 (교시 교환)`,
        item: { op: 'reschedule', courseId: b.courseId, occurrenceKey: b.occurrenceKey, target: to(a) },
      },
    ])
    setPicked([])
  }

  // 보강 대상 수업 — 지금 수업 선택에 있는 수업만(선택에서 빠진 수업이 남아 있으면 화면에 보이는 첫 수업)
  const makeupCourse = makeupCourseFor(mCourse, selectedIds)

  const addMakeup = () => {
    const courseId = makeupCourse
    if (!courseId) return
    const room = mRoom.trim()
    const ok = addItems([
      {
        label: `${titleOf(courseId)} · 보강 ${formatYmdKo(mDate)} ${mPeriod}교시${room ? ` · ${room}` : ''}`,
        item: { op: 'makeup', courseId, target: { date: mDate, period: mPeriod, ...(room ? { roomName: room } : {}) } },
      },
    ])
    if (ok) setMakeupOpen(false)
  }

  // ── 미리보기·발행 ──
  const currentDraft = (entries: DraftEntry[] = draft, r: string = reason): ChangeDraft => ({
    scope: entries.length && entries[0].item.op === 'base' ? 'base' : 'date',
    reason: r.trim(),
    items: entries.map((d) => d.item),
  })

  const runPreview = async (entries: DraftEntry[] = draft, r: string = reason) => {
    if (!entries.length || previewing) return
    setPreviewing(true)
    setPreviewError(null)
    setPublishError(null)
    setStale(null)
    setAck(false)
    try {
      setPreview(await previewChanges(currentDraft(entries, r)))
    } catch (e) {
      setPreview(null)
      setPreviewError(describeError(e))
    } finally {
      setPreviewing(false)
    }
  }

  const publish = async () => {
    if (!preview || publishingRef.current) return
    if (preview.conflicts.length && !ack) return
    publishingRef.current = true
    setPublishing(true)
    setPublishError(null)
    setStale(null)
    const d = currentDraft()
    try {
      const { status, result: summary } = await publishChanges(d, { mutationId, expectedRevision: preview.revision, acknowledgeConflicts: ack })
      setResult({ status, summary })
      toast(status === 202 ? '승인 요청을 보냈어요.' : '발행했어요.', 'success')
      // 발행 끝 — 같은 요청 id를 다시 쓰지 않도록 새로 만들고 목록을 비움
      setDraft([])
      setReason('')
      setPreview(null)
      setAck(false)
      setPicked([])
      setMutationId(newMutationId())
      if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
      if (status !== 202) reloadSchedules()
      if (histCourse && summary.affectedCourseIds.includes(histCourse)) setHistory(null)
    } catch (e) {
      const err = asScheduleError(e)
      if (err.code === 'stale-revision') {
        setStale({ currentRevision: typeof err.body.currentRevision === 'number' ? err.body.currentRevision : null })
      } else if (err.code === 'conflicts') {
        // 아무것도 저장되지 않음 — 충돌을 보여 주고 확인을 받은 뒤 같은 요청 id로 다시(요청 해시에 확인 여부는 들어가지 않음)
        setPreview({
          ...preview,
          changes: Array.isArray(err.body.changes) ? err.body.changes : preview.changes,
          conflicts: Array.isArray(err.body.conflicts) ? err.body.conflicts : preview.conflicts,
          affectedStudentCount: typeof err.body.affectedStudentCount === 'number' ? err.body.affectedStudentCount : preview.affectedStudentCount,
          revision: typeof err.body.revision === 'number' ? err.body.revision : preview.revision,
        })
        setAck(false)
        setPublishError(describeError(err))
      } else {
        if (err.code === 'mutation-id-reused') setMutationId(newMutationId())
        setPublishError(describeError(err))
      }
    } finally {
      publishingRef.current = false
      setPublishing(false)
    }
  }

  const refreshAfterStale = async () => {
    // 새 미리보기가 올 때까지 예전 미리보기(예전 revision)로 발행하지 못하게 먼저 치움
    setPreview(null)
    setStale(null)
    await reloadSchedules()
    await runPreview()
  }

  // ── 승인 요청 ──
  useEffect(() => {
    if (!focusId || !awaiting || !me) return
    if (awaiting.some((c) => c.changeSetId === focusId)) {
      setFocusState(null)
      setTimeout(() => document.getElementById('req-' + focusId)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
      return
    }
    if (processed.some((p) => p.id === focusId)) return
    let alive = true
    setFocusState({ kind: 'loading' })
    loadChangeSet(db, me.schoolCode, focusId)
      .then((cs) => alive && setFocusState(cs ? { kind: 'found', cs } : { kind: 'missing' }))
      .catch((e) => alive && setFocusState({ kind: 'missing', error: describeError(e) }))
    return () => {
      alive = false
    }
  }, [focusId, awaiting, me, processed])

  const approve = async (cs: ChangeSetSummary) => {
    if (actionRef.current) return
    const id = cs.changeSetId
    const withAck = !!approveConflicts[id] && approveAck[id] === true
    actionRef.current = true
    setActionBusy(id)
    setCardError((p) => {
      const n = { ...p }
      delete n[id]
      return n
    })
    try {
      const { status, result: r } = await approveChangeSet(id, withAck)
      const text =
        r.status === 'published'
          ? `승인해서 발행했어요. ${r.affectedStudentCount}명의 학생 시간표에 반영됐어요.`
          : status === 202
            ? '승인했어요. 다른 담당 선생님의 승인을 기다리고 있어요.'
            : '처리했어요.'
      toast(r.status === 'published' ? '승인해서 발행했어요.' : '승인했어요.', 'success')
      setProcessed((p) => [{ id, text, cs: { ...cs, ...r, changes: r.changes.length ? r.changes : cs.changes } }].concat(p.filter((x) => x.id !== id)))
      setApproveConflicts((p) => {
        const n = { ...p }
        delete n[id]
        return n
      })
      await loadAwaiting()
    } catch (e) {
      const err = asScheduleError(e)
      if (err.code === 'conflicts' && Array.isArray(err.body.conflicts)) {
        setApproveConflicts((p) => ({ ...p, [id]: err.body.conflicts }))
        setApproveAck((p) => ({ ...p, [id]: false }))
      }
      setCardError((p) => ({ ...p, [id]: describeError(err) }))
      if (err.code === 'not-pending' || err.code === 'no-longer-valid' || err.code === 'approvers-changed') loadAwaiting()
    } finally {
      actionRef.current = false
      setActionBusy(null)
    }
  }

  const reject = async (cs: ChangeSetSummary, asRequester = false) => {
    if (actionRef.current) return
    const id = cs.changeSetId
    if (asRequester) {
      const ok = await confirm({ title: '요청 철회', description: '이 승인 요청을 거둬요. 시간표는 바뀌지 않아요.', confirmText: '철회하기', danger: true })
      if (!ok) return
    }
    actionRef.current = true
    setActionBusy(id)
    try {
      await rejectChangeSet(id, asRequester ? '' : rejectReason.trim())
      toast(asRequester ? '요청을 철회했어요.' : '요청을 거절했어요.', 'success')
      if (!asRequester) {
        const entry: { id: string; text: string; cs: ChangeSetSummary } = { id, text: '요청을 거절했어요. 시간표는 바뀌지 않았어요.', cs: { ...cs, status: 'rejected' } }
        setProcessed((p) => [entry].concat(p.filter((x) => x.id !== id)))
      }
      setRejectOpen(null)
      setRejectReason('')
      if (asRequester) setHistory(null)
      await loadAwaiting()
    } catch (e) {
      const err = describeError(e)
      setCardError((p) => ({ ...p, [id]: err }))
      if (asRequester) toast(err.title, 'error')
    } finally {
      actionRef.current = false
      setActionBusy(null)
    }
  }

  // ── 변경 이력 ──
  const manageable = useMemo(() => (myCourses || []).filter((c) => c.canManage), [myCourses])
  useEffect(() => {
    if (!histCourse && manageable.length) setHistCourse(manageable[0].course.courseId)
  }, [histCourse, manageable])

  const loadHistory = useCallback(async (courseId: string) => {
    if (!courseId) return
    const seq = ++histSeq.current
    histInflight.current = courseId
    setHistoryLoading(true)
    setHistoryError(null)
    setOrphansError(null)
    const [h, o] = await Promise.allSettled([listCourseHistory(courseId), listOrphans(courseId)])
    // 그 사이 다른 요청(다른 수업 선택·새로고침)이 시작됐으면 이 결과는 버림
    if (seq !== histSeq.current) return
    histInflight.current = ''
    setHistoryFor(courseId)
    if (h.status === 'fulfilled') setHistory(h.value)
    else {
      setHistory(null)
      setHistoryError(describeError(h.reason))
    }
    if (o.status === 'fulfilled') setOrphans(o.value)
    else {
      setOrphans(null)
      setOrphansError(describeError(o.reason))
    }
    setHistoryLoading(false)
  }, [])

  useEffect(() => {
    if (tab !== 'history' || !histCourse || historyError || histInflight.current === histCourse) return
    if (history === null || historyFor !== histCourse) loadHistory(histCourse)
  }, [tab, histCourse, history, historyFor, historyLoading, historyError, loadHistory])

  const restoreOrphan = async (o: OrphanEntry) => {
    const title = titleOf(o.courseId)
    const entry: { label: string; item: ChangeItemInput } = {
      label: `${title} · ${o.originalDate ? formatYmdKo(o.originalDate) + ' 차시' : '보강 차시'} 원래대로 (검토 필요 정리)`,
      item: { op: 'restore', courseId: o.courseId, occurrenceKey: o.occurrenceKey },
    }
    // 작성 중인 변경 목록·사유를 말없이 덮어쓰지 않음(예전에는 이 항목 하나로 바꿔 발행 전 변경이 사라졌음)
    // '이 날짜만' 목록이면 거기에 추가하고, '기본 시간표 변경' 목록이면 확인을 받은 뒤에만 바꿈
    const plan = planOrphanRestore(draft, entry, reason, { max: MAX_ITEMS, newId: uid })
    if (plan.kind === 'too-many') {
      toast(TOO_MANY_TEXT, 'error')
      return
    }
    if (plan.kind === 'replace') {
      const ok = await confirm({
        title: '변경 목록 바꾸기',
        description:
          `작성 중인 기본 시간표 변경 ${plan.dropped}건${plan.hadReason ? '과 사유를' : '을'} 지우고 이 ‘원래대로’ 항목으로 바꿀까요? ` +
          '‘이 날짜만’ 변경과 기본 시간표 변경은 한 번에 발행할 수 없어요.',
        confirmText: '바꾸기',
        danger: true,
      })
      if (!ok) return
    } else if (plan.kept > 0) {
      toast(plan.replaced ? '같은 차시의 이전 항목을 ‘원래대로’로 바꿨어요.' : `작성 중인 변경 ${plan.kept}건에 이어 추가했어요.`, 'info')
    }
    setDraft(plan.next)
    setReason(plan.reason)
    setResult(null)
    resetOutcome()
    setTab('new')
    setTimeout(() => draftRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
    runPreview(plan.next, plan.reason)
  }

  // ───────────────────────── 렌더 ─────────────────────────

  if (loading) return <div className="p-10 text-center text-black">로딩 중...</div>
  if (!me) return <div className="p-10 text-center text-gray-600">교사 정보를 확인하지 못했어요. 새로고침해 주세요.</div>

  const awaitingCount = awaiting ? awaiting.length : 0
  const canPublish = !!preview && !publishing && !previewing && (!preview.conflicts.length || ack)
  const approvalsOf = (cs: ChangeSetSummary) => {
    const vals = Object.keys(cs.approvals).map((k) => cs.approvals[k])
    return { done: vals.filter(Boolean).length, total: vals.length }
  }

  const requestCard = (cs: ChangeSetSummary, opts: { actionable: boolean }) => {
    const id = cs.changeSetId
    const open = expanded[id] === true
    const ap = approvalsOf(cs)
    const conflicts = approveConflicts[id]
    const err = cardError[id]
    return (
      <article key={id} id={`req-${id}`} className={`${cardCls} ${focusId === id ? 'ring-2 ring-blue-500' : ''}`} aria-label={`${cs.createdByName || '선생님'} 선생님의 변경 요청`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="font-bold text-gray-900 break-keep">{cs.createdByName || '다른'} 선생님의 변경 요청</h3>
            <p className="text-xs text-gray-500">
              {timeOf(cs.createdAt)} · {cs.scope === 'base' ? '지정일부터 기본 시간표 변경' : '이 날짜만'} · 담당 선생님 승인 {ap.done}/{ap.total}명
            </p>
          </div>
          <StatusChip status={cs.status} />
        </div>
        <ul className="mt-2 space-y-0.5 text-sm text-gray-800">
          {cs.changes.slice(0, 4).map((c, i) => (
            <li key={i} className="break-keep">
              · {changeSummaryText(c)}
            </li>
          ))}
          {cs.changes.length > 4 && <li className="text-gray-500">외 {cs.changes.length - 4}건</li>}
        </ul>
        {cs.reason && <p className="mt-1 text-sm text-gray-600 break-keep">사유: {cs.reason}</p>}
        <p className="mt-1 text-sm text-gray-700">
          영향 학생 <b>{cs.affectedStudentCount}명</b>
          {cs.conflicts.length > 0 && <span className="ml-2 font-bold text-amber-800">요청 시 충돌 {cs.conflicts.length}건 확인됨</span>}
        </p>
        <button type="button" onClick={() => setExpanded((p) => ({ ...p, [id]: !open }))} className={`${btnGhost} mt-1 px-0`} aria-expanded={open}>
          {open ? '접기 ▲' : '변경 전후 자세히 보기 ▼'}
        </button>
        {open && (
          <div className="mt-2">
            <ChangePreview changes={cs.changes} affectedStudentCount={cs.affectedStudentCount} conflicts={cs.conflicts} orphans={cs.orphans} periodTimes={periodTimes} heading="요청한 변경" />
          </div>
        )}
        {conflicts && conflicts.length > 0 && (
          <div className="mt-3 space-y-2">
            <p className="text-sm font-bold text-amber-900">지금 시간표 기준으로 다시 검사했더니 겹치는 수업이 있어요.</p>
            <ChangePreview changes={[]} conflicts={conflicts} heading="승인 전 충돌 확인" />
            <label className="flex min-h-[44px] items-center gap-2 text-sm font-bold text-gray-900">
              <input type="checkbox" className="h-5 w-5" checked={approveAck[id] === true} onChange={(e) => setApproveAck((p) => ({ ...p, [id]: e.target.checked }))} />
              충돌을 확인했고 그래도 승인
            </label>
          </div>
        )}
        {err && <div className="mt-3"><ErrorBox err={err} /></div>}
        {opts.actionable && cs.status === 'pending-approval' && (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={btnPrimary}
              disabled={actionBusy !== null || (!!conflicts && conflicts.length > 0 && approveAck[id] !== true)}
              onClick={() => approve(cs)}
            >
              {actionBusy === id ? '처리 중…' : conflicts && conflicts.length ? '충돌 확인 후 승인' : '승인'}
            </button>
            <button type="button" className={btnSecondary} disabled={actionBusy !== null} onClick={() => setRejectOpen(rejectOpen === id ? null : id)}>
              거절
            </button>
          </div>
        )}
        {rejectOpen === id && (
          <div className="mt-3 rounded-xl bg-gray-50 p-3">
            <label className="block text-sm text-gray-700" htmlFor={`reject-${id}`}>
              거절 사유(선택 · 요청한 선생님에게 보여요)
            </label>
            <textarea id={`reject-${id}`} className={inputCls} rows={2} maxLength={200} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
            <button type="button" className={`${btnPrimary} mt-2 bg-red-600 hover:bg-red-700`} disabled={actionBusy !== null} onClick={() => reject(cs)}>
              {actionBusy === id ? '처리 중…' : '거절하기'}
            </button>
          </div>
        )}
      </article>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 py-6 sm:py-10 px-4 sm:px-6">
      <div className="max-w-3xl mx-auto">
        <div className="flex justify-between items-start gap-3 mb-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900">시간표 변경</h1>
            <p className="text-sm text-gray-600 break-keep">
              {me.schoolName ? `${me.schoolName} — ` : ''}공식 수업 일정을 바꾸면 그 수업 수강생의 개인 시간표에만 반영돼요.
            </p>
          </div>
          <button onClick={() => router.push('/dashboard')} className="shrink-0 min-h-[44px] text-gray-500 hover:text-gray-700 px-2">
            나가기
          </button>
        </div>

        <div role="tablist" aria-label="시간표 변경 메뉴" className="bg-white rounded-xl border border-gray-200 p-1 flex mb-4 shadow-sm">
          {(
            [
              { key: 'new', label: '새 변경' },
              { key: 'approvals', label: '승인 요청' },
              { key: 'history', label: '변경 이력' },
            ] as Array<{ key: Tab; label: string }>
          ).map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`flex-1 min-h-[44px] py-2 rounded-lg text-sm font-bold transition ${tab === t.key ? 'bg-blue-600 text-white shadow' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              {t.label}
              {t.key === 'approvals' && awaitingCount > 0 && (
                <span className={`ml-1.5 inline-flex min-w-[1.25rem] h-5 items-center justify-center rounded-full px-1 text-xs ${tab === t.key ? 'bg-white text-blue-700' : 'bg-red-600 text-white'}`}>
                  {awaitingCount}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* ───────── (a) 새 변경 ───────── */}
        {tab === 'new' && (
          <div role="tabpanel" aria-label="새 변경">
            {result && (
              <div role="status" className={`mb-4 rounded-xl border p-4 text-sm break-keep ${result.status === 202 ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-green-300 bg-green-50 text-green-900'}`}>
                {result.status === 202 ? (
                  <>
                    <p className="font-bold">승인 요청을 보냈어요.</p>
                    <p className="mt-1">
                      다른 선생님 수업이 포함돼 있어 그 수업 담당 선생님 {approvalsOf(result.summary).total}명이 모두 승인하면 발행돼요. 그 전까지 학생 시간표는 바뀌지 않아요.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="font-bold">{result.summary.replayed ? '이미 발행된 요청이에요(같은 결과).' : '발행했어요.'}</p>
                    <p className="mt-1">
                      영향 학생 {result.summary.affectedStudentCount}명의 개인 시간표에 바로 반영돼요.
                      {result.summary.notified ? ` 알림 ${result.summary.notified.created}건을 보냈어요.` : ''}
                    </p>
                  </>
                )}
              </div>
            )}

            {/* 1. 수업 */}
            <section className={cardCls} aria-label="수업 선택">
              <h2 className="font-bold text-gray-900 mb-1">1. 수업 선택</h2>
              <p className="text-sm text-gray-600 mb-3 break-keep">바꿀 수업을 고르세요. 교시 교환은 두 수업을 함께 고르면 돼요.</p>
              {coursesLoading && !myCourses && <p className="text-sm text-gray-500">내 수업을 불러오는 중…</p>}
              {coursesError && <ErrorBox err={coursesError} onRetry={() => loadCourses()} />}
              {myCourses && myCourses.length === 0 && (
                <div className="rounded-xl border border-dashed border-gray-300 p-4 text-sm text-gray-600 break-keep">
                  담당하는 수업이 아직 없어요. 시간표 가져오기에서 수업을 먼저 만들어 주세요.
                  <div className="mt-2">
                    <button type="button" className={btnSecondary} onClick={() => router.push('/teacher/timetable-import')}>
                      시간표 가져오기 →
                    </button>
                  </div>
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {(myCourses || []).map((tc) => {
                  const on = selectedIds.includes(tc.course.courseId)
                  return (
                    <button
                      key={tc.course.courseId}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleCourse(tc)}
                      className={`min-h-[44px] rounded-xl p-3 text-left transition ${on ? 'bg-blue-50 ring-2 ring-blue-600' : 'bg-white ring-1 ring-gray-200 hover:bg-gray-50'}`}
                    >
                      <span className="block font-bold text-gray-900 break-keep">{tc.course.title}</span>
                      <span className="block text-xs text-gray-600 break-keep">
                        {seriesSummary(tc.series, today)}
                        {tc.course.defaultRoomName ? ` · ${tc.course.defaultRoomName}` : ''}
                        {!tc.canManage ? ' · 담임 학급 공통 수업(승인 필요)' : ''}
                      </span>
                    </button>
                  )
                })}
                {otherCourses
                  .filter((tc) => selectedIds.includes(tc.course.courseId))
                  .map((tc) => (
                    <button
                      key={tc.course.courseId}
                      type="button"
                      aria-pressed
                      onClick={() => toggleCourse(tc)}
                      className="min-h-[44px] rounded-xl bg-blue-50 p-3 text-left ring-2 ring-blue-600"
                    >
                      <span className="block font-bold text-gray-900 break-keep">{tc.course.title}</span>
                      <span className="block text-xs text-gray-600 break-keep">
                        {tc.course.teacherNames.join(', ') || '교사 미정'} · {tc.canManage ? '내 수업' : '다른 선생님 수업(승인 필요)'} · 눌러서 빼기
                      </span>
                    </button>
                  ))}
              </div>
              <div className="mt-3">
                {!searchOpen ? (
                  <button type="button" className={btnSecondary} onClick={openSearch}>
                    + 다른 선생님 수업 추가(교시 교환)
                  </button>
                ) : (
                  <div className="rounded-xl bg-gray-50 p-3">
                    <label className="block text-sm text-gray-700" htmlFor="course-search">
                      다른 수업 찾기
                    </label>
                    <input
                      id="course-search"
                      className={inputCls}
                      placeholder="수업 이름·선생님 이름으로 찾기"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    {schoolCoursesError && (
                      <div className="mt-2">
                        <ErrorBox
                          err={schoolCoursesError}
                          onRetry={() => {
                            setSchoolCoursesError(null)
                            setSchoolCourses(null)
                            setSearchOpen(false)
                          }}
                          retryLabel="닫고 다시 시도"
                        />
                      </div>
                    )}
                    {!schoolCourses && !schoolCoursesError && <p className="mt-2 text-sm text-gray-500">학교 수업 목록을 불러오는 중…</p>}
                    {schoolCourses && (
                      <ul className="mt-2 space-y-1.5">
                        {searchResults.map((c) => (
                          <li key={c.courseId}>
                            <button type="button" onClick={() => addOtherCourse(c)} className="w-full min-h-[44px] rounded-lg bg-white px-3 py-2 text-left text-sm ring-1 ring-gray-200 hover:bg-blue-50">
                              <span className="font-bold text-gray-900">{c.title}</span>
                              <span className="text-gray-600"> · {c.teacherNames.join(', ') || '교사 미정'} 선생님 수업 추가</span>
                            </button>
                          </li>
                        ))}
                        {!searchResults.length && <li className="text-sm text-gray-500">찾는 수업이 없어요.</li>}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </section>

            {/* 2·3. 날짜·차시 */}
            {selectedIds.length > 0 && (
              <section className={cardCls} aria-label="날짜와 차시 선택">
                <h2 className="font-bold text-gray-900 mb-2">2. 날짜 선택</h2>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className={btnGhost} aria-label="이전 날" onClick={() => setDate(addDays(date, -1))}>
                    ‹
                  </button>
                  <input
                    type="date"
                    aria-label="날짜"
                    className="min-h-[44px] rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900"
                    value={ymdToIso(date)}
                    onChange={(e) => {
                      const y = isoToYmd(e.target.value)
                      if (y) setDate(y)
                    }}
                  />
                  <button type="button" className={btnGhost} aria-label="다음 날" onClick={() => setDate(addDays(date, 1))}>
                    ›
                  </button>
                  {date !== today && (
                    <button type="button" className={btnGhost} onClick={() => setDate(today)}>
                      오늘로
                    </button>
                  )}
                </div>
                <p className="mt-1 text-sm font-bold text-gray-800">
                  {relativeDayLabel(date, today) ? `${relativeDayLabel(date, today)} · ` : ''}
                  {formatYmdKo(date)}
                </p>

                <h2 className="font-bold text-gray-900 mt-4 mb-1">3. 차시 선택</h2>
                <p className="text-sm text-gray-600 mb-2 break-keep">하나를 고르면 변경 종류를, 두 개를 고르면 서로 바꾸기를 할 수 있어요.</p>
                {schedErrors.map(({ id, s }) => (
                  <div key={id} className="mb-2">
                    <p className="mb-1 text-sm font-bold text-gray-800">{titleOf(id)} 차시를 불러오지 못했어요</p>
                    <ErrorBox
                      err={s.error}
                      onRetry={() => {
                        const tc = courseById.get(id)
                        if (tc) loadSchedule(tc)
                      }}
                    />
                  </div>
                ))}
                {schedLoading && <p className="text-sm text-gray-500" role="status">차시를 불러오는 중…</p>}
                {!schedLoading && occs.length === 0 && schedErrors.length === 0 && (
                  <p className="rounded-xl border border-dashed border-gray-300 p-4 text-sm text-gray-600 break-keep">
                    {formatYmdKo(date)}에는 고른 수업의 차시가 없어요. 날짜를 바꾸거나 아래 ‘보강 추가’를 써 주세요.
                  </p>
                )}
                <ul className="space-y-2" aria-label="차시 목록">
                  {occs.map((o) => (
                    <li key={o.key}>
                      <OccurrenceCard o={o} picked={picked.includes(o.key)} onToggle={() => togglePick(o)} periodTimes={periodTimes} />
                    </li>
                  ))}
                </ul>

                <div className="mt-3">
                  {!makeupOpen ? (
                    <button
                      type="button"
                      className={btnSecondary}
                      onClick={() => {
                        setMakeupOpen(true)
                        setMCourse(selectedIds[0])
                        setMDate(date)
                        setMPeriod(1)
                        setMRoom('')
                      }}
                    >
                      + 보강 추가
                    </button>
                  ) : (
                    <div className="rounded-xl bg-gray-50 p-3" role="group" aria-label="보강 추가">
                      <p className="font-bold text-gray-900 text-sm">보강 추가 — 원래 시간표에 없던 차시</p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                        <label className="text-sm text-gray-700">
                          수업
                          <select aria-label="보강 수업" className={inputCls} value={makeupCourse} onChange={(e) => setMCourse(e.target.value)}>
                            {selectedIds.map((id) => (
                              <option key={id} value={id}>
                                {titleOf(id)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="text-sm text-gray-700">
                          보강 날짜
                          <input type="date" aria-label="보강 날짜" className={inputCls} value={ymdToIso(mDate)} onChange={(e) => setMDate(isoToYmd(e.target.value) || mDate)} />
                        </label>
                        <label className="text-sm text-gray-700">
                          보강 교시
                          <select aria-label="보강 교시" className={inputCls} value={mPeriod} onChange={(e) => setMPeriod(Number(e.target.value))}>
                            {PERIOD_OPTIONS.map((p) => (
                              <option key={p} value={p}>
                                {p}교시
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="text-sm text-gray-700">
                          보강 교실(비우면 기본 교실)
                          <input aria-label="보강 교실" className={inputCls} value={mRoom} maxLength={40} placeholder={courseById.get(makeupCourse)?.course.defaultRoomName || '교실 이름'} onChange={(e) => setMRoom(e.target.value)} />
                        </label>
                      </div>
                      <div className="mt-2 flex gap-2">
                        <button type="button" className={btnPrimary} onClick={addMakeup}>
                          보강을 변경 목록에 추가
                        </button>
                        <button type="button" className={btnGhost} onClick={() => setMakeupOpen(false)}>
                          닫기
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* 4. 종류 / 교시 교환 */}
            {one && (
              <section className={cardCls} aria-label="변경 종류">
                <h2 className="font-bold text-gray-900 mb-1">4. 변경 종류</h2>
                <p className="text-sm text-gray-700 mb-3 break-keep">
                  고른 차시: <b>{occLabel(one)}</b>
                  {one.status === 'moved-out' && ` (지금은 ${formatYmdKo(one.state.date)} ${one.state.period}교시)`}
                  {one.status === 'cancelled' && ' (취소됨)'}
                </p>
                <fieldset>
                  <legend className="text-xs font-bold text-gray-500 mb-1">이 날짜만</legend>
                  <div className="grid grid-cols-2 gap-2">
                    {KIND_DATE.map((k) => {
                      const disabled = (k.key === 'restore' && !one.canRestore) || (k.key === 'cancel' && one.status === 'cancelled')
                      return (
                        <label
                          key={k.key}
                          className={`flex min-h-[44px] items-center gap-2 rounded-lg px-3 py-2 text-sm ring-1 ${kind === k.key ? 'bg-blue-50 ring-blue-600 font-bold' : 'ring-gray-200'} ${disabled ? 'opacity-50' : 'cursor-pointer'}`}
                        >
                          <input type="radio" name="kind" value={k.key} checked={kind === k.key} disabled={disabled} onChange={() => setKind(k.key)} />
                          {k.label}
                        </label>
                      )
                    })}
                  </div>
                </fieldset>
                <fieldset className="mt-3">
                  <legend className="text-xs font-bold text-gray-500 mb-1">지정일부터</legend>
                  <label
                    className={`flex min-h-[44px] items-center gap-2 rounded-lg px-3 py-2 text-sm ring-1 ${kind === 'base' ? 'bg-blue-50 ring-blue-600 font-bold' : 'ring-gray-200'} ${!oneSeries ? 'opacity-50' : 'cursor-pointer'}`}
                  >
                    <input type="radio" name="kind" value="base" checked={kind === 'base'} disabled={!oneSeries} onChange={() => setKind('base')} />
                    지정일부터 기본 시간표 변경
                  </label>
                </fieldset>

                <div className="mt-3 rounded-xl bg-gray-50 p-3 space-y-2">
                  {kind === 'time' && (
                    <>
                      <label className="block text-sm text-gray-700">
                        바꿀 교시
                        <select aria-label="바꿀 교시" className={inputCls} value={fPeriod} onChange={(e) => setFPeriod(Number(e.target.value))}>
                          {PERIOD_OPTIONS.map((p) => (
                            <option key={p} value={p}>
                              {p}교시
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        <label className="text-sm text-gray-700">
                          시작 시각(선택)
                          <input type="time" aria-label="시작 시각" className={inputCls} value={fStart} onChange={(e) => setFStart(e.target.value)} />
                        </label>
                        <label className="text-sm text-gray-700">
                          끝 시각(선택)
                          <input type="time" aria-label="끝 시각" className={inputCls} value={fEnd} onChange={(e) => setFEnd(e.target.value)} />
                        </label>
                      </div>
                      <p className="text-xs text-gray-500 break-keep">시각을 비우면 학교 교시표 시각을 따라요. 같은 날 안에서만 옮겨요.</p>
                    </>
                  )}
                  {kind === 'move' && (
                    <div className="grid grid-cols-2 gap-2">
                      <label className="text-sm text-gray-700">
                        옮길 날짜
                        <input type="date" aria-label="옮길 날짜" className={inputCls} value={ymdToIso(fMoveDate)} onChange={(e) => setFMoveDate(isoToYmd(e.target.value) || fMoveDate)} />
                      </label>
                      <label className="text-sm text-gray-700">
                        옮길 교시
                        <select aria-label="옮길 교시" className={inputCls} value={fMovePeriod} onChange={(e) => setFMovePeriod(Number(e.target.value))}>
                          {PERIOD_OPTIONS.map((p) => (
                            <option key={p} value={p}>
                              {p}교시
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                  {kind === 'room' && (
                    <label className="block text-sm text-gray-700">
                      바꿀 교실
                      <input aria-label="바꿀 교실" className={inputCls} maxLength={40} placeholder="예: 시청각실" value={fRoom} onChange={(e) => setFRoom(e.target.value)} />
                    </label>
                  )}
                  {kind === 'teacher' && (
                    <>
                      <label className="block text-sm text-gray-700">
                        바꿀 선생님(같은 학교 교사 계정)
                        <select aria-label="바꿀 선생님" className={inputCls} value={fTeacher} onChange={(e) => setFTeacher(e.target.value)}>
                          <option value="">직접 입력(계정 없는 강사)</option>
                          {(teachers || []).map((t) => (
                            <option key={t.uid} value={t.uid}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      {!teachers && !teachersError && <p className="text-xs text-gray-500">선생님 목록을 불러오는 중…</p>}
                      {teachersError && <p className="text-xs text-red-700">선생님 목록을 불러오지 못했어요({teachersError.code}). 이름을 직접 입력해 주세요.</p>}
                      {!fTeacher && (
                        <label className="block text-sm text-gray-700">
                          선생님 이름
                          <input aria-label="선생님 이름" className={inputCls} maxLength={30} value={fTeacherName} onChange={(e) => setFTeacherName(e.target.value)} />
                        </label>
                      )}
                      <p className="text-xs text-gray-500 break-keep">이름만 입력하면 교사 겹침은 이름으로만 확인돼요(같은 사람일 수 있음으로 표시).</p>
                    </>
                  )}
                  {kind === 'cancel' && <p className="text-sm text-gray-700">이 날짜의 이 차시를 취소해요. 학생 화면에는 ‘취소’ 안내로 보여요.</p>}
                  {kind === 'restore' && <p className="text-sm text-gray-700">이 차시의 변경을 거두고 원래 일정으로 되돌려요. 변경 이력은 지우지 않아요.</p>}
                  {kind === 'base' && oneSeries && (
                    <>
                      <p className="text-sm text-gray-700 break-keep">
                        지금 기본 시간표: 매주 {WEEKDAY_NAMES[oneSeries.weekday]}요일 {oneSeries.period}교시. 적용일부터 매주 바뀌고, 그 전 날짜는 그대로예요.
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        <label className="text-sm text-gray-700">
                          적용 시작일
                          <input type="date" aria-label="적용 시작일" className={inputCls} min={ymdToIso(today)} value={ymdToIso(fBaseFrom)} onChange={(e) => setFBaseFrom(isoToYmd(e.target.value) || fBaseFrom)} />
                        </label>
                        <label className="text-sm text-gray-700">
                          요일
                          <select aria-label="기본 요일" className={inputCls} value={fBaseWeekday} onChange={(e) => setFBaseWeekday(Number(e.target.value) as Weekday)}>
                            {WEEKDAY_OPTIONS.map((w) => (
                              <option key={w} value={w}>
                                {WEEKDAY_NAMES[w]}요일
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="text-sm text-gray-700">
                          교시
                          <select aria-label="기본 교시" className={inputCls} value={fBasePeriod} onChange={(e) => setFBasePeriod(Number(e.target.value))}>
                            {PERIOD_OPTIONS.map((p) => (
                              <option key={p} value={p}>
                                {p}교시
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="text-sm text-gray-700">
                          교실
                          <input aria-label="기본 교실" className={inputCls} maxLength={40} value={fBaseRoom} onChange={(e) => setFBaseRoom(e.target.value)} />
                        </label>
                      </div>
                    </>
                  )}
                  <button type="button" className={btnPrimary} onClick={addFromEditor}>
                    변경 목록에 추가
                  </button>
                </div>
              </section>
            )}

            {pickedOccs.length === 2 && (
              <section className={cardCls} aria-label="교시 교환">
                <h2 className="font-bold text-gray-900 mb-1">4. 교시 교환</h2>
                <p className="text-sm text-gray-700 break-keep">
                  <b>{occLabel(pickedOccs[0])}</b> ↔ <b>{occLabel(pickedOccs[1])}</b>
                </p>
                <p className="text-xs text-gray-500 mt-1 break-keep">
                  두 차시의 날짜·교시·시각을 서로 바꿔 한 번에 발행해요(교실·교사는 그대로). 학생에게 중간 상태가 보이지 않아요.
                </p>
                <button type="button" className={`${btnPrimary} mt-2`} onClick={swapPicked}>
                  서로 바꾸기
                </button>
              </section>
            )}

            {/* 5. 변경 목록·사유·미리보기·발행 */}
            {(draft.length > 0 || preview || previewError) && (
              <section className={cardCls} aria-label="변경 목록" ref={(el) => { draftRef.current = el }}>
                <h2 className="font-bold text-gray-900 mb-1">5. 변경 목록 · 사유</h2>
                <p className="text-xs text-gray-500 mb-2">
                  범위: {scope === 'base' ? '지정일부터 기본 시간표 변경' : '이 날짜만'} · {draft.length}건
                </p>
                <ul className="space-y-1.5">
                  {draft.map((d) => (
                    <li key={d.id} className="flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-900">
                      <span className="min-w-0 flex-1 break-keep">{d.label}</span>
                      <button type="button" className="min-h-[44px] shrink-0 px-2 text-sm font-bold text-gray-500 hover:text-red-700" onClick={() => removeItem(d.id)} aria-label={`${d.label} 빼기`}>
                        빼기
                      </button>
                    </li>
                  ))}
                </ul>
                <label className="block mt-3 text-sm text-gray-700" htmlFor="change-reason">
                  변경 사유
                </label>
                <textarea
                  id="change-reason"
                  className={inputCls}
                  rows={2}
                  maxLength={200}
                  placeholder="예: 학교 행사, 출장 보강"
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value)
                    setMutationId(newMutationId())
                  }}
                />
                <p className="mt-1 text-xs text-gray-500">학생 화면의 변경 안내를 펼치면 함께 보여요. 학생 이름은 어디에도 보이지 않아요.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className={btnSecondary} disabled={!draft.length || previewing || publishing} onClick={() => runPreview()}>
                    {previewing ? '확인 중…' : preview ? '다시 미리보기' : '미리보기'}
                  </button>
                  <button
                    type="button"
                    className={btnGhost}
                    disabled={publishing}
                    onClick={() => {
                      setDraft([])
                      resetOutcome()
                    }}
                  >
                    목록 비우기
                  </button>
                </div>
                {previewError && (
                  <div className="mt-3">
                    <ErrorBox err={previewError} onRetry={previewError.retryable ? () => runPreview() : undefined} />
                  </div>
                )}
              </section>
            )}

            {preview && (
              <section className={cardCls} aria-label="변경 미리보기">
                <h2 className="font-bold text-gray-900 mb-2">6. 미리보기 · 발행</h2>
                <ChangePreview
                  changes={preview.changes}
                  affectedStudentCount={preview.affectedStudentCount}
                  conflicts={preview.conflicts}
                  orphans={preview.orphans}
                  periodTimes={periodTimes}
                  courseTitles={Object.fromEntries(Array.from(courseById.entries()).map(([id, c]) => [id, c.course.title]))}
                />
                {preview.requiresApproval && (
                  <p className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 break-keep">
                    <b>승인 필요</b> — 다른 선생님 수업이 포함돼 있어요. 보내면 그 수업 담당 선생님 {preview.approverUids.length}명에게 승인 요청이 가고, 모두 승인하면 발행돼요.
                  </p>
                )}
                {preview.conflicts.length > 0 && (
                  <label className="mt-3 flex min-h-[44px] items-center gap-2 text-sm font-bold text-gray-900">
                    <input type="checkbox" className="h-5 w-5" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                    충돌을 확인했고 그래도 발행
                  </label>
                )}
                {stale && (
                  <div role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800 break-keep">
                    <p className="font-bold">다른 변경이 먼저 발행됐어요.</p>
                    <p className="mt-1">이 미리보기는 예전 시간표 기준이라 발행하지 않았어요(다른 변경을 덮어쓰지 않음). 최신 시간표로 다시 확인해 주세요.</p>
                    <button type="button" className={`${btnPrimary} mt-2`} disabled={previewing} onClick={refreshAfterStale}>
                      {previewing ? '확인 중…' : '최신 시간표로 다시 미리보기'}
                    </button>
                  </div>
                )}
                {publishError && (
                  <div className="mt-3">
                    <ErrorBox err={publishError} onRetry={publishError.retryable ? publish : undefined} />
                  </div>
                )}
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button type="button" className={btnPrimary} disabled={!canPublish || !!stale} onClick={publish}>
                    {publishing ? '발행 중…' : preview.requiresApproval ? '승인 요청 보내기' : '발행하기'}
                  </button>
                  {preview.conflicts.length > 0 && !ack && <span className="text-xs text-amber-800">충돌을 확인해야 발행할 수 있어요.</span>}
                </div>
              </section>
            )}
          </div>
        )}

        {/* ───────── (b) 승인 요청 ───────── */}
        {tab === 'approvals' && (
          <div role="tabpanel" aria-label="승인 요청">
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="text-sm text-gray-600 break-keep">다른 선생님이 내 수업을 포함해 요청한 변경이에요. 모두 승인하면 그때 시간표 기준으로 다시 검사한 뒤 발행돼요.</p>
              <button type="button" className={`${btnGhost} shrink-0 whitespace-nowrap`} onClick={loadAwaiting} disabled={awaitingLoading}>
                {awaitingLoading ? '불러오는 중…' : '새로고침'}
              </button>
            </div>
            {processed.length > 0 && (
              <div role="status" className="mb-4 space-y-2">
                {processed.map((p) => (
                  <div key={p.id} className="rounded-xl border border-green-300 bg-green-50 p-3 text-sm text-green-900 break-keep">
                    <p className="font-bold">{p.text}</p>
                    <p className="mt-0.5 text-green-800">{p.cs.changes.slice(0, 2).map(changeSummaryText).join(' / ')}</p>
                  </div>
                ))}
              </div>
            )}
            {focusState?.kind === 'loading' && <p className="text-sm text-gray-500">요청을 찾는 중…</p>}
            {focusState?.kind === 'found' && (
              <div className="mb-2">
                <p className="mb-2 rounded-xl bg-blue-50 p-3 text-sm text-blue-900 break-keep">
                  알림으로 연 요청이에요.{' '}
                  {focusState.cs.status === 'pending-approval'
                    ? '아직 승인 대기 중이지만 내 승인을 기다리는 요청은 아니에요.'
                    : focusState.cs.status === 'published'
                      ? '이미 승인되어 발행됐어요.'
                      : '거절되었거나 철회된 요청이에요.'}
                  {focusState.cs.rejectReason ? ` (사유: ${focusState.cs.rejectReason})` : ''}
                </p>
                {requestCard(focusState.cs, { actionable: false })}
              </div>
            )}
            {focusState?.kind === 'missing' && (
              <div className="mb-3">
                {focusState.error ? (
                  <ErrorBox err={{ ...focusState.error, title: `알림으로 연 요청을 확인하지 못했어요. ${focusState.error.title}` }} />
                ) : (
                  <p className="rounded-xl border border-gray-200 bg-white p-3 text-sm text-gray-700">알림으로 연 요청을 찾을 수 없어요. 이미 처리되었거나 삭제된 요청이에요.</p>
                )}
              </div>
            )}
            {awaitingError && <ErrorBox err={awaitingError} onRetry={loadAwaiting} />}
            {!awaiting && !awaitingError && <p className="text-sm text-gray-500">승인 요청을 불러오는 중…</p>}
            {awaiting && awaiting.length === 0 && (
              <div className="bg-white rounded-xl border border-dashed border-gray-200 py-10 px-6 text-center">
                <p className="text-gray-700 font-bold">내 승인을 기다리는 요청이 없어요.</p>
              </div>
            )}
            {(awaiting || []).map((cs) => requestCard(cs, { actionable: true }))}
          </div>
        )}

        {/* ───────── (c) 변경 이력 ───────── */}
        {tab === 'history' && (
          <div role="tabpanel" aria-label="변경 이력">
            <section className={cardCls} aria-label="수업별 변경 이력">
              <label className="block text-sm text-gray-700" htmlFor="hist-course">
                수업
              </label>
              {coursesError && <ErrorBox err={coursesError} onRetry={() => loadCourses()} />}
              {myCourses && manageable.length === 0 && <p className="text-sm text-gray-600">담당하는 수업이 없어요.</p>}
              {manageable.length > 0 && (
                <div className="flex gap-2">
                  <select
                    id="hist-course"
                    className={inputCls}
                    value={histCourse}
                    onChange={(e) => {
                      setHistCourse(e.target.value)
                      setHistory(null)
                      setOrphans(null)
                      setHistoryError(null)
                    }}
                  >
                    {manageable.map((c) => (
                      <option key={c.course.courseId} value={c.course.courseId}>
                        {c.course.title}
                      </option>
                    ))}
                  </select>
                  <button type="button" className={`${btnGhost} mt-1 shrink-0`} disabled={historyLoading} onClick={() => loadHistory(histCourse)}>
                    {historyLoading ? '불러오는 중…' : '새로고침'}
                  </button>
                </div>
              )}
            </section>

            {histCourse && (
              <>
                {orphansError && (
                  <div className="mb-4">
                    <p className="mb-1 text-sm font-bold text-gray-800">검토 필요 목록을 불러오지 못했어요</p>
                    <ErrorBox err={orphansError} onRetry={() => loadHistory(histCourse)} />
                  </div>
                )}
                {orphans && historyFor === histCourse && orphans.length > 0 && (
                  <section className={cardCls} aria-label="검토 필요">
                    <OrphanList
                      orphans={orphans}
                      courseTitles={{ [histCourse]: titleOf(histCourse) }}
                      periodTimes={periodTimes}
                      intro="기본 시간표가 바뀌어 대상 차시가 없어진 변경이에요. 학생 화면에는 적용되지 않아요. 원래대로 정리하거나 새 시간표에 맞춰 다시 지정해 주세요."
                    />
                    <ul className="mt-2 space-y-1.5">
                      {orphans.map((o, i) => (
                        <li key={`${o.originalDate}-${i}`} className="flex items-center justify-between gap-2 text-sm">
                          <span className="min-w-0 break-keep text-gray-800">
                            {o.originalDate ? formatYmdKo(o.originalDate) : '보강'} 차시 변경
                          </span>
                          <button type="button" className={btnSecondary} onClick={() => restoreOrphan(o)}>
                            원래대로
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {orphans && historyFor === histCourse && orphans.length === 0 && <p className="mb-3 text-sm text-gray-600">검토 필요한 변경이 없어요.</p>}

                {historyError && <ErrorBox err={historyError} onRetry={() => loadHistory(histCourse)} />}
                {historyLoading && !history && <p className="text-sm text-gray-500">변경 이력을 불러오는 중…</p>}
                {history && historyFor === histCourse && history.length === 0 && (
                  <div className="bg-white rounded-xl border border-dashed border-gray-200 py-10 px-6 text-center">
                    <p className="text-gray-700 font-bold">아직 이 수업의 변경 이력이 없어요.</p>
                  </div>
                )}
                {history && historyFor === histCourse && history.length > 0 && (
                  <ul className="space-y-3" aria-label="변경 이력 목록">
                    {history.map((cs) => {
                      const open = histExpanded[cs.changeSetId] === true
                      const mineReq = cs.createdBy === me.uid
                      return (
                        <li key={cs.changeSetId} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <p className="text-xs text-gray-500">
                              {timeOf(cs.createdAt)} · {cs.createdByName || '선생님'} · {cs.scope === 'base' ? '기본 시간표 변경' : '이 날짜만'}
                            </p>
                            <StatusChip status={cs.status} />
                          </div>
                          <ul className="mt-1 space-y-0.5 text-sm text-gray-900">
                            {cs.changes.slice(0, 3).map((c, i) => (
                              <li key={i} className="break-keep">
                                · {changeSummaryText(c)}
                              </li>
                            ))}
                            {cs.changes.length > 3 && <li className="text-gray-500">외 {cs.changes.length - 3}건</li>}
                          </ul>
                          {cs.reason && <p className="mt-1 text-sm text-gray-600 break-keep">사유: {cs.reason}</p>}
                          {cs.status === 'rejected' && cs.rejectReason && <p className="mt-1 text-sm text-gray-600 break-keep">거절 사유: {cs.rejectReason}</p>}
                          <p className="mt-1 text-xs text-gray-600">
                            영향 학생 {cs.affectedStudentCount}명{cs.conflictsAcknowledged ? ` · 충돌 ${cs.conflicts.length}건 확인 후 발행` : ''}
                          </p>
                          <div className="mt-1 flex flex-wrap gap-2">
                            <button type="button" className={`${btnGhost} px-0`} aria-expanded={open} onClick={() => setHistExpanded((p) => ({ ...p, [cs.changeSetId]: !open }))}>
                              {open ? '접기 ▲' : '자세히 ▼'}
                            </button>
                            {mineReq && cs.status === 'pending-approval' && (
                              <button type="button" className={btnGhost} disabled={actionBusy !== null} onClick={() => reject(cs, true)}>
                                요청 철회
                              </button>
                            )}
                          </div>
                          {open && (
                            <div className="mt-2">
                              <ChangePreview changes={cs.changes} affectedStudentCount={cs.affectedStudentCount} conflicts={cs.conflicts} orphans={cs.orphans} periodTimes={periodTimes} />
                            </div>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
