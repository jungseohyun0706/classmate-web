/**
 * 학생 개인 시간표 — 클라이언트 전용 도우미
 *
 * - GET /api/timetable/me 호출과 오류 code 구분(fetchMyTimetable)
 * - 본인 자료만 담은 로컬 캐시(localStorage 'cm_tt_v1_<uid>') — 로그아웃·계정 전환 시 clearTimetableCache
 * - schools/{s}.scheduleRevision 구독(subscribeScheduleRevision) — 값이 커지면 다시 받기
 * - 엔진 입력 조립(dayInput) — 화면은 buildDayTimetable 결과만 렌더합니다
 * - 화면용 훅(useMyTimetable): 조회 창(앞 3일~뒤 13일), 캐시·오프라인, 버전 구독, 포커스 복귀 갱신
 *
 * 서버 전용 모듈(server.ts·studentData.ts·ids.ts·changes.ts·firebase-admin)을 import하지 마세요.
 * MyTimetablePayload는 studentData.ts의 interface와 같은 모양을 여기 복제해 둡니다(서버 파일을 번들에 넣지 않으려고).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { auth, db } from '../firebase'
import { addDays, inRange, isYmd, schoolYmdAt, toUtcDate } from './dates'
import { coversDate, planAfterLoad, planForDate, windowCovers, windowFor, type TimetableWindow } from './clientWindow'
import { courseActiveOn, resolveCourses } from './engine'
import type {
  Course,
  Enrollment,
  HomeroomMembership,
  LessonSeries,
  Override,
  PeriodTime,
  PersonalEntry,
  StudentTimetableInput,
  Weekday,
  Ymd,
} from './types'

// ───────────────────────── 서버 응답 모양 (studentData.ts MyTimetablePayload 복제) ─────────────────────────

export interface TermSummary {
  termId: string
  name: string
  startDate: Ymd
  endDate: Ymd
  isDefault: boolean
}

export interface HomeroomSummary {
  classId: string
  label: string
  schoolName: string
  isGroupLegacy: boolean
}

export interface MyTimetablePayload {
  /** schools/{s}.scheduleRevision — 서버가 조회를 시작하기 전에 읽은 값 */
  revision: number
  generatedAt: number
  schoolCode: string | null
  /** 조회 기간(둘 다 포함) */
  from: Ymd
  to: Ymd
  /** from 날짜의 학기 */
  term: TermSummary
  /** 조회 기간에 걸친 학기 전부(시작일 순) */
  terms: TermSummary[]
  homeroom: HomeroomSummary | null
  homerooms: HomeroomMembership[]
  /** 본인 수강만(모든 상태) */
  enrollments: Enrollment[]
  /** 본인 수강 + 소속 학급 공통 수업만 */
  courses: Course[]
  series: LessonSeries[]
  overrides: Override[]
  /** 날짜별 쉬는 날. 조회 실패한 날짜는 키가 없고 calendarErrors에 들어감 */
  offDays: Record<Ymd, { name: string } | null>
  calendarErrors: Ymd[]
  periodTimes: PeriodTime[]
  /** '학급 시간표(참고)' 보기를 보여 줄 수 있는지 */
  legacyClassTimetableAvailable: boolean
}

// ───────────────────────── 조회 ─────────────────────────

export type TimetableErrorKind =
  | 'unauthenticated' // 401
  | 'no-profile' // 403 no-profile — 가입 미완료
  | 'not-student' // 403 not-student — 학생 계정 아님(본인 수강도 없음)
  | 'no-school' // 409 no-school
  | 'forbidden' // 그 밖의 403
  | 'server' // 5xx·400·알 수 없는 응답
  | 'offline' // 네트워크 실패

export interface TimetableFetchError {
  ok: false
  kind: TimetableErrorKind
  /** 서버 code(예: 'load-failed', 'index-required') 또는 'network'·'http-502' */
  code: string
  status: number
}

export type TimetableFetchResult = { ok: true; payload: MyTimetablePayload } | TimetableFetchError

/** 인증·권한·가입 상태 오류 — 화면 자료를 비우고 상태 카드만 보여 줌 */
export function isBlockingError(kind: TimetableErrorKind): boolean {
  return kind !== 'server' && kind !== 'offline'
}

function errorKindOf(status: number, code: string): TimetableErrorKind {
  if (status === 401) return 'unauthenticated'
  if (status === 403) {
    if (code === 'no-profile') return 'no-profile'
    if (code === 'not-student') return 'not-student'
    return 'forbidden'
  }
  if (status === 409 && code === 'no-school') return 'no-school'
  return 'server'
}

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

function normalizeTerm(v: unknown): TermSummary | null {
  const t = v as Partial<TermSummary> | null
  if (!t || !isYmd(t.startDate) || !isYmd(t.endDate)) return null
  return {
    termId: String(t.termId || ''),
    name: String(t.name || t.termId || ''),
    startDate: t.startDate,
    endDate: t.endDate,
    isDefault: t.isDefault === true,
  }
}

/** 응답(JSON) 모양 확인 + 빠진 배열 보정. 기간이 없으면 쓸 수 없는 응답으로 봄 */
export function normalizePayload(body: unknown): MyTimetablePayload | null {
  const b = body as Record<string, unknown> | null
  if (!b || typeof b !== 'object' || !isYmd(b.from) || !isYmd(b.to)) return null
  const terms = arr<unknown>(b.terms)
    .map(normalizeTerm)
    .filter((t): t is TermSummary => !!t)
  const term = normalizeTerm(b.term) || terms[0] || { termId: '', name: '', startDate: b.from, endDate: addDays(b.to, 1), isDefault: true }
  const hr = b.homeroom as Partial<HomeroomSummary> | null | undefined
  const offDaysRaw = b.offDays && typeof b.offDays === 'object' ? (b.offDays as Record<string, unknown>) : {}
  const offDays: Record<Ymd, { name: string } | null> = {}
  Object.keys(offDaysRaw).forEach((k) => {
    const v = offDaysRaw[k] as { name?: unknown } | null
    offDays[k] = v && typeof v === 'object' ? { name: String(v.name || '쉬는 날') } : null
  })
  const revision = Number(b.revision)
  return {
    revision: Number.isFinite(revision) ? revision : 0,
    generatedAt: Number(b.generatedAt) || 0,
    schoolCode: typeof b.schoolCode === 'string' && b.schoolCode ? b.schoolCode : null,
    from: b.from,
    to: b.to,
    term,
    terms,
    homeroom:
      hr && typeof hr === 'object' && typeof hr.classId === 'string'
        ? { classId: hr.classId, label: String(hr.label || ''), schoolName: String(hr.schoolName || ''), isGroupLegacy: hr.isGroupLegacy === true }
        : null,
    homerooms: arr<HomeroomMembership>(b.homerooms),
    enrollments: arr<Enrollment>(b.enrollments),
    courses: arr<Course>(b.courses).map((c) => ({ ...c, teacherNames: strArr(c.teacherNames), teacherUids: strArr(c.teacherUids), commonForHomerooms: strArr(c.commonForHomerooms) })),
    series: arr<LessonSeries>(b.series),
    overrides: arr<Override>(b.overrides),
    offDays,
    calendarErrors: strArr(b.calendarErrors),
    periodTimes: arr<PeriodTime>(b.periodTimes),
    legacyClassTimetableAvailable: b.legacyClassTimetableAvailable === true,
  }
}

const FETCH_TIMEOUT_MS = 20000

/**
 * GET /api/timetable/me?from&to (둘 다 포함, 최대 21일).
 * 실패를 빈 시간표로 바꾸지 않고 종류(kind)·code·status로 돌려줍니다.
 */
export async function fetchMyTimetable(token: string, from?: Ymd, to?: Ymd): Promise<TimetableFetchResult> {
  const qs = new URLSearchParams()
  if (from) qs.set('from', from)
  if (to) qs.set('to', to)
  const q = qs.toString()
  // 응답이 오지 않는 요청이 다음 갱신을 막지 않도록 시간 제한
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
  let timedOut = false
  const timer = ctrl
    ? setTimeout(() => {
        timedOut = true
        ctrl.abort()
      }, FETCH_TIMEOUT_MS)
    : null
  let res: Response
  try {
    res = await fetch(`/api/timetable/me${q ? `?${q}` : ''}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: ctrl ? ctrl.signal : undefined,
    })
  } catch {
    if (timer) clearTimeout(timer)
    if (timedOut) return { ok: false, kind: 'server', code: 'timeout', status: 0 }
    return { ok: false, kind: 'offline', code: 'network', status: 0 }
  }
  if (timer) clearTimeout(timer)
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (res.ok) {
    const payload = normalizePayload(body)
    if (!payload) return { ok: false, kind: 'server', code: 'bad-response', status: res.status }
    return { ok: true, payload }
  }
  const raw = (body as { code?: unknown } | null)?.code
  const code = typeof raw === 'string' && raw ? raw.slice(0, 40) : `http-${res.status}`
  return { ok: false, kind: errorKindOf(res.status, code), code, status: res.status }
}

// ───────────────────────── 조회 창 ─────────────────────────
// 기간 계산·다시 받기 판단은 순수 함수로 clientWindow.ts에 둡니다(단위 테스트). 기존 import 경로를 위해 여기서 다시 내보냄
export { coversDate, windowCovers, windowFor } from './clientWindow'
export type { TimetableWindow } from './clientWindow'

// ───────────────────────── 캐시 (본인 자료만) ─────────────────────────

const CACHE_PREFIX = 'cm_tt_'
const cacheKey = (uid: string) => `${CACHE_PREFIX}v1_${uid}`

export interface TimetableCacheEntry {
  payload: MyTimetablePayload
  /** 서버에서 받은 시각(ms) */
  syncedAt: number
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
  } catch {
    return null
  }
}

/** 캐시 읽기. 학교가 바뀌었으면(schoolCode 불일치) 쓰지 않음 */
export function readTimetableCache(uid: string, opts: { schoolCode?: string | null } = {}): TimetableCacheEntry | null {
  const s = storage()
  if (!s || !uid) return null
  try {
    const raw = s.getItem(cacheKey(uid))
    if (!raw) return null
    const parsed = JSON.parse(raw) as { payload?: unknown; syncedAt?: unknown }
    const payload = normalizePayload(parsed?.payload)
    const syncedAt = Number(parsed?.syncedAt)
    if (!payload || !Number.isFinite(syncedAt)) return null
    if (opts.schoolCode && payload.schoolCode && payload.schoolCode !== opts.schoolCode) return null
    return { payload, syncedAt }
  } catch {
    return null
  }
}

/**
 * 캐시 쓰기. 다시 열었을 때 쓸모 있도록 '오늘'을 포함한 창을 우선 보관합니다
 * (오늘이 없는 먼 날짜 창은, 이미 오늘을 포함한 캐시가 있으면 덮어쓰지 않음).
 */
export function writeTimetableCache(uid: string, payload: MyTimetablePayload, syncedAt: number): void {
  const s = storage()
  if (!s || !uid) return
  try {
    const today = schoolYmdAt(Date.now())
    if (!coversDate(payload, today)) {
      const cur = readTimetableCache(uid)
      if (cur && coversDate(cur.payload, today)) return
    }
    s.setItem(cacheKey(uid), JSON.stringify({ payload, syncedAt }))
  } catch {
    // 저장 공간 부족·사파리 프라이빗 모드 등 — 캐시 없이 동작
  }
}

export function removeTimetableCache(uid: string): void {
  const s = storage()
  if (!s || !uid) return
  try {
    s.removeItem(cacheKey(uid))
  } catch {
    // 무시
  }
}

/**
 * 'cm_tt_' 접두어 캐시를 모두 지웁니다(로그아웃·계정 전환).
 * keepUid를 주면 그 계정의 캐시만 남기고 나머지(다른 계정 자료)를 지웁니다.
 */
export function clearTimetableCache(keepUid?: string | null): void {
  const s = storage()
  if (!s) return
  try {
    const keep = keepUid ? cacheKey(keepUid) : null
    const keys: string[] = []
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i)
      if (k && k.startsWith(CACHE_PREFIX) && k !== keep) keys.push(k)
    }
    keys.forEach((k) => s.removeItem(k))
  } catch {
    // 무시
  }
}

// ───────────────────────── 실시간 갱신 신호 ─────────────────────────

/**
 * schools/{schoolCode}.scheduleRevision 구독. 값이 바뀔 때마다 onRevision(값).
 * 권한 오류 등으로 구독하지 못하면 콘솔 경고 + onError — 호출하는 쪽은 화면 포커스·visibilitychange 때 다시 받기로 대체합니다.
 * 반환값: 구독 해제 함수
 */
export function subscribeScheduleRevision(
  schoolCode: string,
  onRevision: (revision: number) => void,
  onError?: (e: unknown) => void
): () => void {
  if (!schoolCode || !db) {
    onError?.(new Error('no-db'))
    return () => {}
  }
  try {
    return onSnapshot(
      doc(db, 'schools', schoolCode),
      (snap) => {
        const v = Number(snap.exists() ? snap.get('scheduleRevision') || 0 : 0)
        if (Number.isFinite(v)) onRevision(v)
      },
      (e) => {
        console.warn('[timetable] 시간표 변경 구독 실패 — 화면으로 돌아올 때 다시 확인합니다.', (e as { code?: string })?.code || e)
        onError?.(e)
      }
    )
  } catch (e) {
    console.warn('[timetable] 시간표 변경 구독을 시작하지 못했어요.', e)
    onError?.(e)
    return () => {}
  }
}

// ───────────────────────── 엔진 입력 ─────────────────────────

function dayDiff(a: Ymd, b: Ymd): number {
  return Math.round((toUtcDate(b).getTime() - toUtcDate(a).getTime()) / 86400000)
}

/**
 * 그 날짜의 학기 범위.
 * - terms가 비면 null(학기 밖 판정 안 함)
 * - 날짜를 포함하는 학기가 있으면 그 학기
 * - 어디에도 안 걸리면 가장 가까운 학기 → 엔진이 'outside-term'으로 판정
 */
export function termRangeFor(payload: Pick<MyTimetablePayload, 'terms'>, date: Ymd): { startDate: Ymd; endDate: Ymd } | null {
  const terms = payload.terms || []
  if (!terms.length) return null
  const hit = terms.find((t) => inRange(date, t.startDate, t.endDate))
  if (hit) return { startDate: hit.startDate, endDate: hit.endDate }
  let best = terms[0]
  let bestDist = Number.POSITIVE_INFINITY
  terms.forEach((t) => {
    const d = date < t.startDate ? dayDiff(date, t.startDate) : dayDiff(addDays(t.endDate, -1), date)
    if (d < bestDist) {
      best = t
      bestDist = d
    }
  })
  return { startDate: best.startDate, endDate: best.endDate }
}

/** 본인 uid — 서버가 본인 수강만 주므로 수강 문서에서 알 수 있음(없으면 수강 판정에 쓰이지 않음) */
function uidOf(payload: MyTimetablePayload, uid?: string | null): string {
  return uid || payload.enrollments[0]?.uid || ''
}

/**
 * buildDayTimetable 입력. date가 payload 조회 창(from~to) 밖이면 쉬는 날 정보가 없으니
 * 호출하기 전에 coversDate로 확인하고, 밖이면 windowFor(date)로 다시 받으세요.
 */
export function dayInput(
  payload: MyTimetablePayload,
  date: Ymd,
  personalEntries: PersonalEntry[],
  uid?: string | null
): StudentTimetableInput {
  return {
    uid: uidOf(payload, uid),
    day: {
      date,
      term: termRangeFor(payload, date),
      offDay: payload.offDays[date] ?? null,
      periodTimes: payload.periodTimes,
    },
    homerooms: payload.homerooms,
    enrollments: payload.enrollments,
    courses: payload.courses,
    series: payload.series,
    overrides: payload.overrides,
    personalEntries,
  }
}

/** 그 날짜의 학사일정(쉬는 날) 확인에 실패했는지 */
export function calendarFailedOn(payload: MyTimetablePayload, date: Ymd): boolean {
  return payload.calendarErrors.includes(date)
}

// ───────────────────────── 내 수업 목록·수업 정보 ─────────────────────────

/** 그 날짜에 참여 중인 수업(활성 수강 + 소속 학급 공통 수업) — 제목 순 */
export function activeCoursesOn(payload: MyTimetablePayload, date: Ymd, uid?: string | null): Course[] {
  const { active } = resolveCourses(
    { uid: uidOf(payload, uid), homerooms: payload.homerooms, enrollments: payload.enrollments, courses: payload.courses },
    date
  )
  return payload.courses
    .filter((c) => active.has(c.courseId))
    .sort((a, b) => a.title.localeCompare(b.title, 'ko'))
}

/**
 * 직접 입력 일정을 연결할 수 있는 수업: 본인 '활성 수강'(공통 수업 제외 — 수강 문서가 있어야 규칙이 허용) 중 운영 중인 것.
 * 이름이 비슷하다고 자동으로 고르지 않습니다 — 학생이 이 목록에서 직접 선택.
 */
export function linkableCourses(payload: MyTimetablePayload, date: Ymd, uid?: string | null): Course[] {
  const me = uidOf(payload, uid)
  const ids = new Set(
    payload.enrollments
      .filter((e) => e.uid === me && e.status === 'active' && (!e.from || e.from <= date) && (!e.to || date < e.to))
      .map((e) => e.courseId)
  )
  return payload.courses
    .filter((c) => ids.has(c.courseId) && courseActiveOn(c, date))
    .sort((a, b) => a.title.localeCompare(b.title, 'ko'))
}

export interface CourseSlotSummary {
  weekday: Weekday
  period: number
  start: string | null
  end: string | null
  roomName: string | null
}

const WEEKDAY_SHORT = ['', '월', '화', '수', '목', '금', '토', '일']

export function weekdayShort(w: number): string {
  return WEEKDAY_SHORT[w] || ''
}

/** 수업 정보 시트용: 그 날짜 이후에도 이어지는 반복 차시의 요일·교시·교실(중복 제거, 요일·교시 순) */
export function courseSchedule(payload: MyTimetablePayload, courseId: string, fromDate: Ymd): CourseSlotSummary[] {
  const course = payload.courses.find((c) => c.courseId === courseId)
  const seen = new Set<string>()
  const out: CourseSlotSummary[] = []
  payload.series
    .filter((s) => s.courseId === courseId && s.status !== 'retired' && (!s.validTo || s.validTo > fromDate) && (!s.validTo || s.validFrom < s.validTo))
    .sort((a, b) => a.weekday - b.weekday || a.period - b.period || a.validFrom.localeCompare(b.validFrom))
    .forEach((s) => {
      const roomName = s.roomName || course?.defaultRoomName || null
      const k = `${s.weekday}|${s.period}|${roomName || ''}`
      if (seen.has(k)) return
      seen.add(k)
      out.push({ weekday: s.weekday, period: s.period, start: s.start ?? null, end: s.end ?? null, roomName })
    })
  return out
}

// ───────────────────────── 화면용 훅 ─────────────────────────

export interface MyTimetableState {
  /** 화면에 쓰는 자료. 선택 날짜를 포함하지 않을 수 있으니 covered를 확인 */
  payload: MyTimetablePayload | null
  /** 자료를 서버에서 받은 시각(ms) */
  syncedAt: number | null
  /** 로컬 캐시에서 꺼낸 자료인지 */
  fromCache: boolean
  /** 요청 중 */
  loading: boolean
  /** 마지막 요청의 오류(성공하면 null). offline·server는 자료가 있으면 배너로, 없으면 상태 카드로 */
  error: TimetableFetchError | null
}

export interface MyTimetableHook extends MyTimetableState {
  /** payload가 선택 날짜를 포함하는지 */
  covered: boolean
  retry: () => void
}

const EMPTY_STATE: MyTimetableState = { payload: null, syncedAt: null, fromCache: false, loading: false, error: null }
const STALE_MS = 5 * 60 * 1000

function tokenError(e: unknown): TimetableFetchError {
  const code = String((e as { code?: unknown })?.code || '')
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false
  if (offline || code === 'auth/network-request-failed') return { ok: false, kind: 'offline', code: 'network', status: 0 }
  return { ok: false, kind: 'unauthenticated', code: code || 'token-failed', status: 401 }
}

/** 현재 로그인 사용자의 토큰으로 조회. 401이면 토큰을 새로 받아 한 번 더 */
async function requestAsUser(uid: string, win: TimetableWindow): Promise<TimetableFetchResult> {
  const user = auth ? auth.currentUser : null
  if (!user || user.uid !== uid) return { ok: false, kind: 'unauthenticated', code: 'no-user', status: 401 }
  let token: string
  try {
    token = await user.getIdToken()
  } catch (e) {
    return tokenError(e)
  }
  let res = await fetchMyTimetable(token, win.from, win.to)
  if (!res.ok && res.kind === 'unauthenticated') {
    try {
      token = await user.getIdToken(true)
    } catch (e) {
      return tokenError(e)
    }
    res = await fetchMyTimetable(token, win.from, win.to)
  }
  return res
}

/**
 * 학생 개인 시간표 자료 훅.
 * - uid가 정해지면 캐시를 먼저 보여 주고(있으면) 서버에서 다시 받음
 * - date가 받은 기간 밖이면 windowFor(date)로 다시 받음
 * - schools/{s}.scheduleRevision이 받은 revision보다 커지면 다시 받음(구독 실패 시 포커스 복귀 때)
 * - 네트워크 실패: 날짜를 포함한 자료(현재 또는 캐시)가 있으면 그대로 두고 error=offline(배너), 없으면 상태 카드
 * - 인증·권한 오류: 자료를 비우고 이 계정 캐시도 지움
 * - 늦게 도착한 이전 요청 결과는 버림(요청 순번)
 */
export function useMyTimetable(uid: string | null, date: Ymd | null, opts: { schoolCode?: string | null } = {}): MyTimetableHook {
  // 계정별 상태: 저장된 상태의 uid가 지금 uid와 다르면(계정 전환 직후) 그 계정 캐시로 시작
  const [keyed, setKeyed] = useState<MyTimetableState & { uid: string | null }>({ ...EMPTY_STATE, uid: null })
  const optSchool = opts.schoolCode ?? null
  const initial = useMemo<MyTimetableState>(() => {
    if (!uid) return EMPTY_STATE
    const cached = readTimetableCache(uid, { schoolCode: optSchool })
    return cached ? { payload: cached.payload, syncedAt: cached.syncedAt, fromCache: true, loading: false, error: null } : EMPTY_STATE
  }, [uid, optSchool])
  const state: MyTimetableState = uid && keyed.uid === uid ? keyed : initial

  const stateRef = useRef<MyTimetableState>(state)
  const uidRef = useRef<string | null>(uid)
  const dateRef = useRef<Ymd | null>(date)
  const schoolCodeRef = useRef<string | null>(opts.schoolCode ?? null)
  const seqRef = useRef(0)
  const inflightRef = useRef<TimetableWindow | null>(null)
  const wantedRef = useRef<TimetableWindow | null>(null)
  const knownRevRef = useRef(0)
  const subFailedRef = useRef(false)
  const staleRetryRef = useRef(0)
  /** load 자신을 다시 부르기 위한 참조(조회 도중 버전이 올라간 경우) */
  const loadSelfRef = useRef<((win: TimetableWindow) => Promise<void>) | null>(null)

  useEffect(() => {
    stateRef.current = state
  }, [state])
  useEffect(() => {
    dateRef.current = date
  }, [date])
  useEffect(() => {
    schoolCodeRef.current = opts.schoolCode ?? null
  }, [opts.schoolCode])

  const commit = useCallback((next: MyTimetableState) => {
    stateRef.current = next
    setKeyed({ ...next, uid: uidRef.current })
  }, [])

  const load = useCallback(
    async (win: TimetableWindow): Promise<void> => {
      const myUid = uidRef.current
      if (!myUid) return
      const seq = ++seqRef.current
      wantedRef.current = win
      inflightRef.current = win
      if (!stateRef.current.loading) commit({ ...stateRef.current, loading: true })

      const res = await requestAsUser(myUid, win)
      // 더 새 요청이 있거나 계정이 바뀌었으면 이 결과는 버림
      if (seq !== seqRef.current || uidRef.current !== myUid) return
      inflightRef.current = null
      // 요청 도중 로그아웃·계정 전환: 결과를 보이거나 캐시에 다시 쓰지 않음(_app이 지운 캐시가 되살아나지 않게)
      const current = auth ? auth.currentUser : null
      if (!current || current.uid !== myUid) {
        commit({ ...EMPTY_STATE, error: { ok: false, kind: 'unauthenticated', code: 'signed-out', status: 401 } })
        return
      }

      if (res.ok) {
        const p = res.payload
        const now = Date.now()
        commit({ payload: p, syncedAt: now, fromCache: false, loading: false, error: null })
        writeTimetableCache(myUid, p, now)
        // 응답을 기다리는 사이 날짜가 이 기간 밖으로 바뀌었으면 그 날짜 기간을 받음(스켈레톤에서 멈추지 않게),
        // 조회 도중 변경이 발행돼 구독한 버전이 더 크면 같은 기간을 한 번 더(최대 2번)
        const next = planAfterLoad({
          date: dateRef.current,
          win,
          payload: p,
          knownRevision: knownRevRef.current,
          staleRetries: staleRetryRef.current,
        })
        if (next.kind === 'reload-revision') staleRetryRef.current++
        else if (next.kind === 'done') staleRetryRef.current = 0
        if (next.kind !== 'done') void loadSelfRef.current?.(next.win)
        return
      }

      if (isBlockingError(res.kind)) {
        // 인증·권한·가입 상태가 바뀜: 이전 자료를 보여 주지 않음
        removeTimetableCache(myUid)
        commit({ ...EMPTY_STATE, error: res })
        return
      }

      // 네트워크·서버 오류: 날짜를 포함한 자료가 있으면 그대로 두고 오류만 표시
      const d = dateRef.current
      const cur = stateRef.current
      if (cur.payload && d && coversDate(cur.payload, d)) {
        commit({ ...cur, loading: false, error: res })
        return
      }
      const cached = d ? readTimetableCache(myUid, { schoolCode: schoolCodeRef.current }) : null
      if (cached && d && coversDate(cached.payload, d)) {
        commit({ payload: cached.payload, syncedAt: cached.syncedAt, fromCache: true, loading: false, error: res })
        return
      }
      commit({ ...cur, loading: false, error: res })
    },
    [commit]
  )
  useEffect(() => {
    loadSelfRef.current = load
  }, [load])

  // 계정이 바뀌면 진행 중 요청을 무효화(화면 상태는 위 initial — 그 계정 캐시 — 로 바뀜)
  useEffect(() => {
    uidRef.current = uid
    seqRef.current++
    inflightRef.current = null
    wantedRef.current = null
    knownRevRef.current = 0
    subFailedRef.current = false
    staleRetryRef.current = 0
  }, [uid])

  // 날짜가 받은 기간 밖이면(또는 아직 서버에서 받지 않았으면) 다시 받기.
  // 받은 자료가 이 날짜를 포함하는데 다른 기간을 받는 중이면(먼 날짜로 갔다가 응답 전에 돌아옴) 그 요청을 버림 —
  // 그 응답이 자료를 덮어쓰면 이 날짜가 기간 밖이 되어 시간표가 스켈레톤에서 멈췄음
  useEffect(() => {
    if (!uid || !date) return
    const s = stateRef.current
    const plan = planForDate({
      date,
      inflight: inflightRef.current,
      payload: s.payload,
      fromCache: s.fromCache,
      knownRevision: knownRevRef.current,
    })
    if (plan.kind === 'load') {
      void load(plan.win)
      return
    }
    if (plan.kind === 'cancel-inflight' && s.payload) {
      seqRef.current++
      inflightRef.current = null
      wantedRef.current = { from: s.payload.from, to: s.payload.to }
      if (s.loading) commit({ ...s, loading: false })
    }
  }, [uid, date, load, commit])

  // 학교 시간표 버전 구독
  const schoolCode = state.payload?.schoolCode ?? null
  useEffect(() => {
    if (!uid || !schoolCode) return
    subFailedRef.current = false
    return subscribeScheduleRevision(
      schoolCode,
      (rev) => {
        if (rev > knownRevRef.current) knownRevRef.current = rev
        const p = stateRef.current.payload
        if (!p || rev <= p.revision) return
        const d = dateRef.current
        const w = wantedRef.current
        void load(w && (!d || windowCovers(w, d)) ? w : d ? windowFor(d) : { from: p.from, to: p.to })
      },
      () => {
        subFailedRef.current = true
      }
    )
  }, [uid, schoolCode, load])

  // 화면 복귀·포커스·온라인 복구 때 다시 받기(구독 실패, 오류·캐시 표시 중, 오래된 자료일 때)
  useEffect(() => {
    if (!uid) return
    const refresh = (force: boolean) => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (inflightRef.current) return
      const d = dateRef.current
      if (!d) return
      const s = stateRef.current
      const stale = !s.syncedAt || Date.now() - s.syncedAt > STALE_MS
      if (!force && !subFailedRef.current && !s.error && !s.fromCache && !stale) return
      const w = wantedRef.current
      void load(w && windowCovers(w, d) ? w : windowFor(d))
    }
    const onFocus = () => refresh(false)
    const onOnline = () => refresh(true)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      window.removeEventListener('online', onOnline)
    }
  }, [uid, load])

  const retry = useCallback(() => {
    const d = dateRef.current
    if (!d) return
    const w = wantedRef.current
    void load(w && windowCovers(w, d) ? w : windowFor(d))
  }, [load])

  return { ...state, covered: !!(state.payload && date && coversDate(state.payload, date)), retry }
}

// ───────────────────────── 표시 도우미 ─────────────────────────

/** 마지막 동기화 표시: 오늘이면 'HH:MM', 아니면 'M월 D일 HH:MM' (학교 시간대) */
export function formatSyncedAt(ms: number, nowMs: number = Date.now()): string {
  const kst = new Date(ms + 9 * 60 * 60 * 1000)
  const hm = `${String(kst.getUTCHours()).padStart(2, '0')}:${String(kst.getUTCMinutes()).padStart(2, '0')}`
  if (schoolYmdAt(ms) === schoolYmdAt(nowMs)) return hm
  return `${kst.getUTCMonth() + 1}월 ${kst.getUTCDate()}일 ${hm}`
}
