/**
 * 교사 '내 시간표'(대시보드 오늘의 내 수업) — 클라이언트 전용 도우미
 *
 * - GET /api/timetable/teacher 호출과 오류 code 구분(fetchTeacherTimetable) — 실패를 빈 시간표로 바꾸지 않음
 * - useTeacherTimetable: 조회 창(앞 3일~뒤 13일, 학생 화면과 같은 clientWindow 규칙),
 *   schools/{s}.scheduleRevision 구독(공식 수업 변경 발행 → 다시 받기), 화면 복귀·포커스·온라인 복구 때 다시 받기
 *   (교환·보결·주간 시간표는 버전을 올리지 않으므로 복귀 때 확인)
 * - 로컬 캐시는 두지 않음(교사 자료는 화면을 열 때 서버에서)
 *
 * 서버 전용 모듈(server.ts·studentData.ts·teacherData.ts·firebase-admin)을 import하지 마세요.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { auth } from '../firebase'
import { subscribeScheduleRevision, type TimetableErrorKind, type TimetableFetchError } from './client'
import { coversDate, planAfterLoad, planForDate, windowCovers, windowFor, type TimetableWindow } from './clientWindow'
import { normalizeTeacherPayload, type TeacherTimetablePayload } from './teacherDay'
import type { Ymd } from './types'

export type TeacherFetchResult = { ok: true; payload: TeacherTimetablePayload } | TimetableFetchError

function errorKindOf(status: number, code: string): TimetableErrorKind {
  if (status === 401) return 'unauthenticated'
  if (status === 403) return code === 'no-profile' ? 'no-profile' : 'forbidden'
  if (status === 409 && code === 'no-school') return 'no-school'
  return 'server'
}

const FETCH_TIMEOUT_MS = 20000

/** GET /api/timetable/teacher?from&to (둘 다 포함, 최대 21일) */
export async function fetchTeacherTimetable(token: string, from: Ymd, to: Ymd): Promise<TeacherFetchResult> {
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
    res = await fetch(`/api/timetable/teacher?from=${from}&to=${to}`, {
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
    const payload = normalizeTeacherPayload(body)
    if (!payload) return { ok: false, kind: 'server', code: 'bad-response', status: res.status }
    return { ok: true, payload }
  }
  const raw = (body as { code?: unknown } | null)?.code
  const code = typeof raw === 'string' && raw ? raw.slice(0, 40) : `http-${res.status}`
  return { ok: false, kind: errorKindOf(res.status, code), code, status: res.status }
}

function tokenError(e: unknown): TimetableFetchError {
  const code = String((e as { code?: unknown })?.code || '')
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false
  if (offline || code === 'auth/network-request-failed') return { ok: false, kind: 'offline', code: 'network', status: 0 }
  return { ok: false, kind: 'unauthenticated', code: code || 'token-failed', status: 401 }
}

/** 현재 로그인 사용자의 토큰으로 조회. 401이면 토큰을 새로 받아 한 번 더 */
async function requestAsUser(uid: string, win: TimetableWindow): Promise<TeacherFetchResult> {
  const user = auth ? auth.currentUser : null
  if (!user || user.uid !== uid) return { ok: false, kind: 'unauthenticated', code: 'no-user', status: 401 }
  let token: string
  try {
    token = await user.getIdToken()
  } catch (e) {
    return tokenError(e)
  }
  let res = await fetchTeacherTimetable(token, win.from, win.to)
  if (!res.ok && res.kind === 'unauthenticated') {
    try {
      token = await user.getIdToken(true)
    } catch (e) {
      return tokenError(e)
    }
    res = await fetchTeacherTimetable(token, win.from, win.to)
  }
  return res
}

interface TeacherTimetableState {
  payload: TeacherTimetablePayload | null
  /** 서버에서 받은 시각(ms) */
  syncedAt: number | null
  loading: boolean
  /** 마지막 요청의 오류(성공하면 null). offline·server는 자료가 있으면 배너로, 없으면 상태 카드로 */
  error: TimetableFetchError | null
}

export interface TeacherTimetableHook extends TeacherTimetableState {
  /** payload가 선택 날짜를 포함하는지 */
  covered: boolean
  retry: () => void
}

const EMPTY: TeacherTimetableState = { payload: null, syncedAt: null, loading: false, error: null }
/** 화면 복귀 때 이보다 오래된 자료면 다시 받음(교환·보결 수락은 시간표 버전을 올리지 않음) */
const FOCUS_STALE_MS = 30 * 1000

export function useTeacherTimetable(uid: string | null, date: Ymd | null, schoolCode: string | null): TeacherTimetableHook {
  // 계정별 상태: 저장된 상태의 uid가 지금 uid와 다르면(계정 전환 직후) 빈 상태로 봄
  const [keyed, setKeyed] = useState<TeacherTimetableState & { uid: string | null }>({ ...EMPTY, uid: null })
  const state: TeacherTimetableState = uid && keyed.uid === uid ? keyed : EMPTY
  const stateRef = useRef<TeacherTimetableState>(EMPTY)
  const uidRef = useRef<string | null>(uid)
  const dateRef = useRef<Ymd | null>(date)
  const seqRef = useRef(0)
  const inflightRef = useRef<TimetableWindow | null>(null)
  const wantedRef = useRef<TimetableWindow | null>(null)
  const knownRevRef = useRef(0)
  const subFailedRef = useRef(false)
  const staleRetryRef = useRef(0)
  const loadSelfRef = useRef<((win: TimetableWindow) => Promise<void>) | null>(null)

  useEffect(() => {
    dateRef.current = date
  }, [date])

  const commit = useCallback((next: TeacherTimetableState) => {
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
      if (seq !== seqRef.current || uidRef.current !== myUid) return // 더 새 요청·계정 전환
      inflightRef.current = null

      if (res.ok) {
        const p = res.payload
        commit({ payload: p, syncedAt: Date.now(), loading: false, error: null })
        const next = planAfterLoad({ date: dateRef.current, win, payload: p, knownRevision: knownRevRef.current, staleRetries: staleRetryRef.current })
        if (next.kind === 'reload-revision') staleRetryRef.current++
        else if (next.kind === 'done') staleRetryRef.current = 0
        if (next.kind !== 'done') void loadSelfRef.current?.(next.win)
        return
      }
      if (res.kind !== 'server' && res.kind !== 'offline') {
        // 인증·권한·가입 상태: 이전 자료를 보이지 않음
        commit({ ...EMPTY, error: res })
        return
      }
      // 네트워크·서버 오류: 날짜를 포함한 자료가 있으면 그대로 두고 오류만(배너)
      commit({ ...stateRef.current, loading: false, error: res })
    },
    [commit]
  )
  useEffect(() => {
    loadSelfRef.current = load
  }, [load])

  // 계정이 바뀌면 진행 중 요청 무효화(화면 상태는 위 keyed 비교로 빈 상태)
  useEffect(() => {
    uidRef.current = uid
    stateRef.current = EMPTY
    seqRef.current++
    inflightRef.current = null
    wantedRef.current = null
    knownRevRef.current = 0
    subFailedRef.current = false
    staleRetryRef.current = 0
  }, [uid])

  // 날짜가 받은 기간 밖이면(또는 아직 받지 않았으면) 그 날짜 기간을 받음
  useEffect(() => {
    if (!uid || !date) return
    const s = stateRef.current
    const plan = planForDate({ date, inflight: inflightRef.current, payload: s.payload, fromCache: false, knownRevision: knownRevRef.current })
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

  // 학교 시간표 버전 구독 — 공식 수업 변경이 발행되면 다시 받음
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

  // 화면 복귀·포커스·온라인 복구 때 다시 받기(교환·보결 수락, 구독 실패, 오류 표시 중, 오래된 자료)
  useEffect(() => {
    if (!uid) return
    const refresh = (force: boolean) => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (inflightRef.current) return
      const d = dateRef.current
      if (!d) return
      const s = stateRef.current
      const stale = !s.syncedAt || Date.now() - s.syncedAt > FOCUS_STALE_MS
      if (!force && !subFailedRef.current && !s.error && !stale) return
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
