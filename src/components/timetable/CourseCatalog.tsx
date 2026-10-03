import { useEffect, useId, useState, type JSX } from 'react'
import { auth } from '../../lib/firebase'
import { weekdayShort } from '../../lib/timetable/client'
import { useUI } from '../ui/feedback'
import { lessonTitle } from './LessonCard'

/**
 * 공식 수업 찾기(학생) — 요구 문서 4절, 지시서 8장 A
 * - POST /api/courses {action:'catalog'} → 지금 학기에 학교가 공개(catalogVisible)한 수업:
 *   과목·분반·교사 이름·요일 교시·참여 방식('바로 참여' / '선생님 승인 필요')·내 상태(myStatus)
 * - '신청' → POST /api/enrollments {action:'request', courseId} → status active '내 시간표에 추가됐어요' /
 *   pending '선생님 승인을 기다려요' / already(이미 참여·신청)
 * - 과목명 검색은 목록을 좁히기만 합니다. 이름이 비슷하다고 자동으로 신청·연결하지 않아요(학생이 '신청'을 직접 누름).
 * - 오류는 응답 code로 구분해 안내하고, 원인을 모르는 오류를 '공개된 수업이 없어요'로 보이지 않게(다시 시도)
 * - 내부 id(courseId)는 화면·DOM 속성에 내놓지 않고 신청 요청 본문에만 씁니다.
 */

export type EnrollmentState = 'active' | 'pending' | 'ended'

export interface CatalogSlot {
  weekday: number
  period: number
  /** 수업 교실(없으면 수업의 기본 교실) */
  roomName?: string | null
}

/** /api/courses catalog 응답의 수업 한 개(courses.ts catalog 모양 그대로) */
export interface CatalogCourse {
  courseId: string
  title: string
  subject: string
  section: string | null
  teacherNames: string[]
  defaultRoomName?: string | null
  invitePolicy: 'auto' | 'approval'
  slots: CatalogSlot[]
  myStatus: EnrollmentState | null
}

export interface CatalogTerm {
  termId: string
  name: string
  startDate: string
  endDate: string
  isDefault: boolean
}

// ───────────────────────── API 호출 (로그인 사용자 토큰) ─────────────────────────

export interface ApiFailure {
  ok: false
  /** HTTP 상태(네트워크 실패는 0) */
  status: number
  /** 서버 code 또는 'network'·'timeout'·'bad-response'·'http-<n>' */
  code: string
}

export type ApiResult = { ok: true; data: Record<string, unknown> } | ApiFailure

const API_TIMEOUT_MS = 20000

async function postOnce(path: string, token: string, body: unknown): Promise<ApiResult> {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
  let timedOut = false
  const timer = ctrl
    ? setTimeout(() => {
        timedOut = true
        ctrl.abort()
      }, API_TIMEOUT_MS)
    : null
  let res: Response
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: ctrl ? ctrl.signal : undefined,
    })
  } catch {
    if (timer) clearTimeout(timer)
    return { ok: false, status: 0, code: timedOut ? 'timeout' : 'network' }
  }
  if (timer) clearTimeout(timer)
  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    json = null
  }
  if (res.ok) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, status: res.status, code: 'bad-response' }
    return { ok: true, data: json as Record<string, unknown> }
  }
  const raw = (json as { code?: unknown } | null)?.code
  return { ok: false, status: res.status, code: typeof raw === 'string' && raw ? raw.slice(0, 40) : `http-${res.status}` }
}

function tokenFailure(e: unknown): ApiFailure {
  const code = String((e as { code?: unknown })?.code || '')
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false
  if (offline || code === 'auth/network-request-failed') return { ok: false, status: 0, code: 'network' }
  return { ok: false, status: 401, code: 'token-failed' }
}

/** 지금 로그인한 사용자의 ID 토큰으로 POST. 401이면 토큰을 새로 받아 한 번 더 */
export async function postAsCurrentUser(path: string, body: unknown): Promise<ApiResult> {
  const user = auth ? auth.currentUser : null
  if (!user) return { ok: false, status: 401, code: 'no-user' }
  let token: string
  try {
    token = await user.getIdToken()
  } catch (e) {
    return tokenFailure(e)
  }
  let r = await postOnce(path, token, body)
  if (!r.ok && r.status === 401) {
    try {
      token = await user.getIdToken(true)
    } catch (e) {
      return tokenFailure(e)
    }
    r = await postOnce(path, token, body)
  }
  return r
}

// ───────────────────────── 응답 정리·문구 ─────────────────────────

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [])

function normalizeCourse(v: unknown): CatalogCourse | null {
  const c = v as Record<string, unknown> | null
  if (!c || typeof c !== 'object' || typeof c.courseId !== 'string' || !c.courseId) return null
  const slots: CatalogSlot[] = Array.isArray(c.slots)
    ? (c.slots as unknown[])
        .map((s) => s as { weekday?: unknown; period?: unknown; roomName?: unknown })
        .filter((s) => !!s && Number.isInteger(Number(s.weekday)) && Number.isInteger(Number(s.period)))
        .map((s) => ({
          weekday: Number(s.weekday),
          period: Number(s.period),
          roomName: typeof s.roomName === 'string' && s.roomName.trim() ? s.roomName.trim() : typeof c.defaultRoomName === 'string' && c.defaultRoomName ? c.defaultRoomName : null,
        }))
    : []
  const st = c.myStatus
  return {
    courseId: c.courseId,
    title: typeof c.title === 'string' && c.title ? c.title : '수업',
    subject: typeof c.subject === 'string' ? c.subject : '',
    section: typeof c.section === 'string' && c.section ? c.section : null,
    teacherNames: strArr(c.teacherNames),
    defaultRoomName: typeof c.defaultRoomName === 'string' && c.defaultRoomName ? c.defaultRoomName : null,
    invitePolicy: c.invitePolicy === 'approval' ? 'approval' : 'auto',
    slots,
    myStatus: st === 'active' || st === 'pending' || st === 'ended' ? st : null,
  }
}

function normalizeCatalog(data: Record<string, unknown>): { term: CatalogTerm | null; courses: CatalogCourse[] } | null {
  if (!Array.isArray(data.courses)) return null
  const t = data.term as Partial<CatalogTerm> | null | undefined
  const term =
    t && typeof t === 'object' && typeof t.name === 'string'
      ? {
          termId: String(t.termId || ''),
          name: t.name,
          startDate: String(t.startDate || ''),
          endDate: String(t.endDate || ''),
          isDefault: t.isDefault === true,
        }
      : null
  const courses = (data.courses as unknown[]).map(normalizeCourse).filter((c): c is CatalogCourse => !!c)
  return { term, courses }
}

/** 화면 제목: 제목에 분반이 없으면 '영어 · B' */
export function catalogTitle(c: Pick<CatalogCourse, 'title' | 'section'>): string {
  return lessonTitle({ title: c.title, section: c.section ?? undefined })
}

/** '화 3교시, 수 1교시' — 등록된 차시가 없으면 안내 문구 */
export function catalogSlotText(slots: CatalogSlot[]): string {
  if (!slots.length) return '아직 등록된 시간표가 없어요'
  return slots.map((s) => `${weekdayShort(s.weekday)} ${s.period}교시${s.roomName ? ` · ${s.roomName}` : ''}`).join(', ')
}

function teacherText(names: string[]): string {
  return names.length ? `${names.join(', ')} 선생님` : '담당 선생님 정보 없음'
}

function loadErrorText(f: ApiFailure): { title: string; desc?: string } {
  if (f.code === 'network') return { title: '인터넷 연결을 확인해 주세요', desc: '연결되면 다시 시도해 주세요.' }
  if (f.code === 'timeout') return { title: '응답이 늦어 공식 수업 목록을 불러오지 못했어요 (timeout)', desc: '잠시 후 다시 시도해 주세요.' }
  if (f.status === 401) return { title: '로그인이 필요해요', desc: '다시 로그인한 뒤 시도해 주세요.' }
  if (f.code === 'no-profile') return { title: '가입이 아직 끝나지 않았어요', desc: '초대 코드로 학급·수업에 먼저 참여해 주세요.' }
  if (f.code === 'no-school') return { title: '학교 정보가 없어요', desc: '초대 링크나 코드로 학급·수업에 먼저 참여해 주세요.' }
  if (f.status === 403) return { title: `공식 수업 목록을 볼 권한이 없어요 (${f.code})` }
  return { title: `공식 수업 목록을 불러오지 못했어요 (${f.code})`, desc: '잠시 후 다시 시도해 주세요.' }
}

/** 신청 오류 문구 — /api/enrollments request의 code 기준 */
export function requestErrorText(f: ApiFailure): string {
  switch (f.code) {
    case 'network':
      return '인터넷 연결을 확인해 주세요. 신청하지 못했어요.'
    case 'timeout':
      return '응답이 늦어 신청 결과를 확인하지 못했어요. 내 수업 목록에서 다시 확인해 주세요.'
    case 'not-open':
      return '공개된 수업만 신청할 수 있어요. 선생님께 수업 초대를 받아 주세요.'
    case 'course-ended':
      return '이미 끝난 수업이에요.'
    case 'course-not-found':
      return '수업을 찾을 수 없어요. 목록을 새로 고쳐 주세요.'
    case 'invalid-id':
      return '수업 정보가 올바르지 않아요. 목록을 새로 고쳐 주세요.'
    case 'student-only':
      return '학생 계정만 수강 신청을 할 수 있어요.'
    case 'no-profile':
      return '가입이 아직 끝나지 않았어요. 초대 코드로 먼저 참여해 주세요.'
    case 'no-school':
      return '학교 정보가 없어요. 초대 링크나 코드로 학급·수업에 먼저 참여해 주세요.'
    default:
      break
  }
  if (f.status === 401) return '로그인이 필요해요. 다시 로그인해 주세요.'
  return `신청하지 못했어요 (${f.code}). 잠시 후 다시 시도해 주세요.`
}

/** 신청 결과 문구 */
export function requestResultText(status: 'active' | 'pending', already: boolean): string {
  if (status === 'active') return already ? '이미 참여 중인 수업이에요' : '내 시간표에 추가됐어요'
  return already ? '이미 신청했어요 · 선생님 승인을 기다려요' : '선생님 승인을 기다려요'
}

/** 목록을 다시 받아야 하는 신청 오류(수업 상태가 바뀜) */
const RELOAD_CODES = ['not-open', 'course-ended', 'course-not-found', 'invalid-id', 'timeout']

// ───────────────────────── 화면 ─────────────────────────

export interface CourseCatalogProps {
  /** 로그인한 학생 uid — 바뀌면 목록을 다시 받음(화면에는 쓰지 않음) */
  uid: string
  /**
   * 내 시간표 자료(/api/timetable/me)로 계산한 내 수강 상태(courseId → 상태).
   * 목록을 받은 뒤 선생님이 승인·종료했으면 이 값이 더 최신이라 우선합니다.
   */
  knownStatus?: Record<string, EnrollmentState>
  /** 신청이 끝난 뒤 — 내 시간표 다시 받기(useMyTimetable().retry) */
  onEnrolled?: (r: { status: 'active' | 'pending' | null; already: boolean }) => void
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; term: CatalogTerm | null; courses: CatalogCourse[] }
  | { status: 'error'; failure: ApiFailure }

interface LocalResult {
  status: 'active' | 'pending'
  already: boolean
  /** 신청할 때 knownStatus 값 — 이후 시간표 자료가 바뀌면 그쪽을 믿음 */
  base: EnrollmentState | null
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, '')

const btnPrimary =
  'inline-flex min-h-11 items-center justify-center rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:opacity-60'
const btnSecondary =
  'inline-flex min-h-11 items-center justify-center rounded-xl bg-white px-4 text-sm font-semibold text-emerald-700 ring-1 ring-emerald-200 transition-colors hover:bg-emerald-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:opacity-60'

function BoltIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 shrink-0" aria-hidden="true">
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
    </svg>
  )
}

function UserCheckIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 shrink-0" aria-hidden="true">
      <circle cx="9" cy="8" r="4" />
      <path d="M2 21a7 7 0 0 1 14 0M16 11l2 2 4-4" />
    </svg>
  )
}

function CheckIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 shrink-0" aria-hidden="true">
      <path d="m5 12 5 5 9-10" />
    </svg>
  )
}

function ClockIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 shrink-0" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}

export default function CourseCatalog({ uid, knownStatus, onEnrolled }: CourseCatalogProps): JSX.Element {
  const { toast, confirm } = useUI()
  const searchId = useId()
  const hintId = useId()
  const [query, setQuery] = useState<string>('')
  const [attempt, setAttempt] = useState<number>(0)
  const [loaded, setLoaded] = useState<{ key: string; value: LoadState }>({ key: '', value: { status: 'loading' } })
  const [results, setResults] = useState<Record<string, LocalResult>>({})
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const key = `${uid}#${attempt}`
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const r = await postAsCurrentUser('/api/courses', { action: 'catalog' })
      if (cancelled) return
      if (!r.ok) {
        setLoaded({ key, value: { status: 'error', failure: r } })
        return
      }
      const n = normalizeCatalog(r.data)
      setLoaded({
        key,
        value: n ? { status: 'ready', term: n.term, courses: n.courses } : { status: 'error', failure: { ok: false, status: 200, code: 'bad-response' } },
      })
    })()
    return () => {
      cancelled = true
    }
  }, [key])

  const load: LoadState = loaded.key === key ? loaded.value : { status: 'loading' }
  const reload = (): void => setAttempt((a) => a + 1)

  /** 표시할 내 상태: 방금 신청한 결과(그 뒤 시간표 자료가 바뀌지 않았을 때) → 시간표 자료 → 목록 응답 */
  const statusOf = (c: CatalogCourse): EnrollmentState | null => {
    const known = knownStatus ? knownStatus[c.courseId] ?? null : null
    const local = results[c.courseId]
    if (local && local.base === known) return local.status
    return known ?? c.myStatus
  }

  const request = async (c: CatalogCourse): Promise<void> => {
    if (busy) return
    const title = catalogTitle(c)
    const what = `${teacherText(c.teacherNames)} · ${catalogSlotText(c.slots)}`
    const ok = await confirm({
      title: `${title} 수업을 신청할까요?`,
      description:
        c.invitePolicy === 'approval'
          ? `선생님이 승인하면 내 시간표에 추가돼요. 과목·분반·선생님·요일이 맞는지 확인해 주세요. (${what})`
          : `신청하면 바로 내 시간표에 추가돼요. 과목·분반·선생님·요일이 맞는지 확인해 주세요. (${what})`,
      confirmText: '신청',
    })
    if (!ok) return
    setBusy(c.courseId)
    setItemErrors((prev) => {
      const next = { ...prev }
      delete next[c.courseId]
      return next
    })
    const r = await postAsCurrentUser('/api/enrollments', { action: 'request', courseId: c.courseId })
    setBusy(null)
    if (!r.ok) {
      const msg = requestErrorText(r)
      setItemErrors((prev) => ({ ...prev, [c.courseId]: msg }))
      toast(msg, 'error')
      if (RELOAD_CODES.includes(r.code)) reload()
      // 응답을 못 받은 경우 실제로는 신청됐을 수 있어 내 시간표도 다시 받음
      if (r.code === 'timeout') onEnrolled?.({ status: null, already: false })
      return
    }
    const st = r.data.status
    if (st !== 'active' && st !== 'pending') {
      const msg = '신청 결과를 확인하지 못했어요. 목록을 새로 고쳐 다시 확인해 주세요.'
      setItemErrors((prev) => ({ ...prev, [c.courseId]: msg }))
      toast(msg, 'error')
      reload()
      onEnrolled?.({ status: null, already: false })
      return
    }
    const already = r.data.already === true
    const base = knownStatus ? knownStatus[c.courseId] ?? null : null
    setResults((prev) => ({ ...prev, [c.courseId]: { status: st, already, base } }))
    toast(requestResultText(st, already), st === 'active' ? 'success' : 'info')
    onEnrolled?.({ status: st, already })
  }

  const q = norm(query)
  const courses = load.status === 'ready' ? load.courses : []
  const shown = q ? courses.filter((c) => norm(`${c.title} ${c.subject}`).includes(q)) : courses

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={searchId} className="block text-sm font-medium text-gray-700">
          과목명으로 찾기
        </label>
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value.slice(0, 40))}
          placeholder="예: 영어"
          autoComplete="off"
          enterKeyHint="search"
          aria-describedby={hintId}
          className="mt-1 block min-h-11 w-full min-w-0 appearance-none rounded-xl border border-gray-300 bg-white px-3 py-2 text-base text-black shadow-sm placeholder-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
        />
        <p id={hintId} className="mt-1 text-xs leading-relaxed text-gray-500 break-keep">
          검색은 목록만 좁혀요. 이름이 같아도 자동으로 참여하지 않으니, 과목·분반·선생님·요일을 확인하고 &lsquo;신청&rsquo;을 눌러 주세요.
        </p>
      </div>

      {load.status === 'loading' && (
        <div className="animate-pulse space-y-2" role="status" aria-label="공식 수업 목록을 불러오는 중">
          <div className="h-24 rounded-xl bg-gray-100" />
          <div className="h-24 rounded-xl bg-gray-100" />
        </div>
      )}

      {load.status === 'error' &&
        (() => {
          const t = loadErrorText(load.failure)
          return (
            <div role="alert" className="rounded-xl bg-rose-50 px-4 py-4 ring-1 ring-rose-200">
              <p className="text-sm font-semibold text-gray-900 break-keep wrap-anywhere">{t.title}</p>
              {t.desc && <p className="mt-1 text-xs leading-relaxed text-gray-600 break-keep">{t.desc}</p>}
              <button type="button" onClick={reload} className={`${btnPrimary} mt-3`}>
                다시 시도
              </button>
            </div>
          )
        })()}

      {load.status === 'ready' && (
        <>
          <p className="text-xs text-gray-500 break-keep" aria-live="polite">
            {load.term ? `${load.term.name} · ` : ''}
            {q ? `‘${query.trim()}’ 검색 결과 ${shown.length}개 / 공개 수업 ${courses.length}개` : `학교가 공개한 수업 ${courses.length}개`}
          </p>

          {courses.length === 0 ? (
            <div role="status" className="rounded-xl bg-gray-50 px-4 py-5 text-center ring-1 ring-gray-100">
              <p className="text-sm font-semibold text-gray-900 break-keep">지금 학교에 공개된 수업이 없어요</p>
              <p className="mt-1 text-xs leading-relaxed text-gray-500 break-keep">
                선생님께 받은 초대 코드로 참여하거나, 공식 수업이 아직 없으면 직접 입력할 수 있어요.
              </p>
            </div>
          ) : shown.length === 0 ? (
            <div role="status" className="rounded-xl bg-gray-50 px-4 py-5 text-center ring-1 ring-gray-100">
              <p className="text-sm font-semibold text-gray-900 break-keep wrap-anywhere">‘{query.trim()}’와(과) 맞는 공개 수업이 없어요</p>
              <button type="button" onClick={() => setQuery('')} className={`${btnSecondary} mt-3`}>
                검색 지우기
              </button>
            </div>
          ) : (
            <ul className="space-y-2" aria-label="공식 수업 목록">
              {shown.map((c) => {
                const title = catalogTitle(c)
                const st = statusOf(c)
                const local = results[c.courseId]
                const showResult = !!local && local.status === st
                const err = itemErrors[c.courseId]
                const isBusy = busy === c.courseId
                return (
                  <li key={c.courseId}>
                    <article aria-label={title} className="rounded-xl border border-gray-200 bg-white px-4 py-3">
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <h3 className="text-[15px] font-semibold text-gray-900 break-keep wrap-anywhere">{title}</h3>
                          <p className="mt-0.5 text-xs text-gray-600 break-keep wrap-anywhere">
                            과목 {c.subject || c.title}
                            {c.section ? ` · 분반 ${c.section}` : ''}
                          </p>
                          <p className="text-xs text-gray-600 break-keep wrap-anywhere">{teacherText(c.teacherNames)}</p>
                          <p className="text-xs text-gray-600 break-keep wrap-anywhere">{catalogSlotText(c.slots)}</p>
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {c.invitePolicy === 'approval' ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-gray-700 ring-1 ring-gray-300">
                                <UserCheckIcon />
                                선생님 승인 필요
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-800 ring-1 ring-sky-200">
                                <BoltIcon />
                                바로 참여
                              </span>
                            )}
                            {st === 'active' && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800 ring-1 ring-emerald-200">
                                <CheckIcon />
                                참여 중
                              </span>
                            )}
                            {st === 'pending' && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-800 ring-1 ring-amber-200">
                                <ClockIcon />
                                승인 대기
                              </span>
                            )}
                          </div>
                        </div>
                        {(st === null || st === 'ended') && (
                          <button
                            type="button"
                            onClick={() => void request(c)}
                            disabled={!!busy}
                            aria-label={`${title} ${st === 'ended' ? '다시 신청' : '신청'}`}
                            className={`${btnPrimary} shrink-0 px-3`}
                          >
                            {isBusy ? '신청 중…' : st === 'ended' ? '다시 신청' : '신청'}
                          </button>
                        )}
                      </div>
                      {showResult && local && (
                        <p
                          role="status"
                          className={`mt-2 flex items-start gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold break-keep ${
                            local.status === 'active' ? 'bg-emerald-50 text-emerald-900' : 'bg-amber-50 text-amber-900'
                          }`}
                        >
                          {local.status === 'active' ? <CheckIcon /> : <ClockIcon />}
                          <span className="min-w-0">{requestResultText(local.status, local.already)}</span>
                        </p>
                      )}
                      {err && (
                        <p role="alert" className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 break-keep">
                          <span aria-hidden="true">⚠️ </span>
                          {err}
                        </p>
                      )}
                    </article>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
