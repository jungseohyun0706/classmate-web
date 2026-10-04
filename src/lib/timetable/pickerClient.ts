/**
 * 학생 '수업 담기' — 클라이언트 API 호출(로그인 사용자 토큰) + 공개 목록 훅
 *  - POST /api/courses {action:'catalog'}            지금 학기 학교 공개 수업(대상 학년·요일 교시·교실·내 상태)
 *  - POST /api/enrollments {action:'requestMany'}     골라 담은 수업 한 번에(최대 20개) → 수업마다 결과
 *  - POST /api/enrollments {action:'leave'}           내가 직접 담은 수업 빼기
 * 계산은 coursePicker.ts(순수 함수)에 있습니다. 서버 전용 모듈을 import하지 마세요.
 */
import { useCallback, useEffect, useState } from 'react'
import { auth } from '../firebase'
import { mapRequestResults, normalizeCatalog, type PickerCourse, type PickerTerm, type PickResult } from './coursePicker'

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

// ───────────────────────── 문구 ─────────────────────────

/** 공개 목록을 못 받았을 때 */
export function catalogLoadErrorText(f: ApiFailure): { title: string; desc?: string } {
  if (f.code === 'network') return { title: '인터넷 연결을 확인해 주세요', desc: '연결되면 다시 시도해 주세요.' }
  if (f.code === 'timeout') return { title: '응답이 늦어 학교 수업 목록을 불러오지 못했어요 (timeout)', desc: '잠시 후 다시 시도해 주세요.' }
  if (f.status === 401) return { title: '로그인이 필요해요', desc: '다시 로그인한 뒤 시도해 주세요.' }
  if (f.code === 'no-profile') return { title: '가입이 아직 끝나지 않았어요', desc: '초대 코드로 학급·수업에 먼저 참여해 주세요.' }
  if (f.code === 'no-school') return { title: '학교 정보가 없어요', desc: '초대 링크나 코드로 학급·수업에 먼저 참여해 주세요.' }
  if (f.status === 403) return { title: `학교 수업 목록을 볼 권한이 없어요 (${f.code})` }
  return { title: `학교 수업 목록을 불러오지 못했어요 (${f.code})`, desc: '잠시 후 다시 시도해 주세요.' }
}

/** 담기 요청 전체가 실패했을 때(수업마다의 실패는 PickResult) */
export function pickRequestErrorText(f: ApiFailure): string {
  switch (f.code) {
    case 'network':
      return '인터넷 연결을 확인해 주세요. 담지 못했어요.'
    case 'timeout':
      return '응답이 늦어 담기 결과를 확인하지 못했어요. 내 수업 목록에서 다시 확인해 주세요.'
    case 'too-many':
      return '한 번에 20개까지 담을 수 있어요. 나눠서 담아 주세요.'
    case 'rate-limited':
      return '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.'
    case 'student-only':
      return '학생 계정만 수업을 담을 수 있어요.'
    case 'no-profile':
      return '가입이 아직 끝나지 않았어요. 초대 코드로 먼저 참여해 주세요.'
    case 'no-school':
      return '학교 정보가 없어요. 초대 링크나 코드로 학급·수업에 먼저 참여해 주세요.'
    case 'course-ended':
      return '이미 끝난 수업이에요.'
    default:
      break
  }
  if (f.status === 401) return '로그인이 필요해요. 다시 로그인해 주세요.'
  return `담지 못했어요 (${f.code}). 잠시 후 다시 시도해 주세요.`
}

/** 빼기 실패 */
export function leaveErrorText(f: ApiFailure): string {
  switch (f.code) {
    case 'not-self-picked':
      return '학교에서 넣어 준 수업은 직접 뺄 수 없어요. 선생님께 문의해 주세요.'
    case 'enrollment-not-found':
      return '내가 담은 수업이 아니에요. 목록을 새로 고쳐 주세요.'
    case 'left-today':
      return '오늘은 이미 뺀 수업이에요. 내일 다시 시도해 주세요.'
    case 'network':
      return '인터넷 연결을 확인해 주세요. 빼지 못했어요.'
    case 'rate-limited':
      return '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.'
    default:
      break
  }
  if (f.status === 401) return '로그인이 필요해요. 다시 로그인해 주세요.'
  return `빼지 못했어요 (${f.code}). 잠시 후 다시 시도해 주세요.`
}

// ───────────────────────── 호출 ─────────────────────────

export type PickOutcome = { ok: true; results: PickResult[]; changed: number } | { ok: false; failure: ApiFailure }

/** 골라 담은 수업 한 번에 담기(requestMany) — 수업마다 결과(담은 순서) */
export async function requestCourses(courseIds: string[]): Promise<PickOutcome> {
  const ids = Array.from(new Set(courseIds))
  const r = await postAsCurrentUser('/api/enrollments', { action: 'requestMany', courseIds: ids })
  if (!r.ok) return { ok: false, failure: r }
  if (!Array.isArray(r.data.results)) return { ok: false, failure: { ok: false, status: 200, code: 'bad-response' } }
  return { ok: true, results: mapRequestResults(ids, r.data), changed: Number(r.data.changed) || 0 }
}

/** 내가 담은 수업 빼기 */
export async function leaveCourse(courseId: string): Promise<{ ok: true; already: boolean } | { ok: false; failure: ApiFailure }> {
  const r = await postAsCurrentUser('/api/enrollments', { action: 'leave', courseId })
  if (!r.ok) return { ok: false, failure: r }
  return { ok: true, already: r.data.already === true }
}

// ───────────────────────── 공개 목록 훅 ─────────────────────────

export type CatalogState =
  | { status: 'loading' }
  | { status: 'ready'; term: PickerTerm | null; courses: PickerCourse[] }
  | { status: 'error'; failure: ApiFailure }

/**
 * 공개 목록 — uid가 정해지면 받고, reload()로 다시 받음. 늦게 온 이전 응답은 버림.
 * 원인을 모르는 실패를 '공개된 수업이 없어요'로 위장하지 않음(error 상태)
 */
export function useCatalog(uid: string | null): { state: CatalogState; refreshing: boolean; reload: () => void } {
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<{ key: string; value: CatalogState }>({ key: '', value: { status: 'loading' } })
  const key = uid ? `${uid}#${attempt}` : ''
  useEffect(() => {
    if (!uid) return
    const k = `${uid}#${attempt}`
    let cancelled = false
    void (async () => {
      const r = await postAsCurrentUser('/api/courses', { action: 'catalog' })
      if (cancelled) return
      if (!r.ok) {
        setLoaded({ key: k, value: { status: 'error', failure: r } })
        return
      }
      const n = normalizeCatalog(r.data)
      setLoaded({
        key: k,
        value: n ? { status: 'ready', term: n.term, courses: n.courses } : { status: 'error', failure: { ok: false, status: 200, code: 'bad-response' } },
      })
    })()
    return () => {
      cancelled = true
    }
  }, [uid, attempt])
  const reload = useCallback(() => setAttempt((a) => a + 1), [])
  // 다시 받는 동안에는 같은 계정의 이전 목록을 그대로 보여 줌(담은 뒤 새로 고칠 때 화면이 비지 않게)
  const current = !!key && loaded.key === key
  const sameUser = !!uid && loaded.key.slice(0, loaded.key.lastIndexOf('#')) === uid
  const state: CatalogState = current ? loaded.value : sameUser && loaded.value.status === 'ready' ? loaded.value : { status: 'loading' }
  return { state, refreshing: !current && state.status === 'ready', reload }
}
