/**
 * 학생 개인 일정(직접 입력) — 클라이언트 전용 (users/{uid}/personalEntries)
 *
 * - 본인만 읽기·쓰기(보안 규칙). 학교 시간표와 연결되지 않은 일정은 '직접 입력 · 학교 시간표와 연결되지 않음'으로 표시합니다.
 * - 생성 필드는 정확히 {title, kind, weekday, date, period, start, end, roomName, memo, linkedCourseId, createdAt}.
 *   수정은 바뀐 필드 + updatedAt. createdAt/updatedAt은 serverTimestamp()(규칙이 request.time과 같기를 요구).
 * - linkedCourseId는 학생이 직접 고른 '활성 수강' 수업만(client.linkableCourses). 이름이 비슷하다고 자동 연결하지 않습니다.
 * - 오프라인에서도 쓰기가 로컬에 먼저 반영되고(hasPendingWrites → pendingSync '저장 대기'), 서버 반영은 committed 프로미스로 알립니다.
 * - 규칙과 같은 입력 검증을 클라이언트에서도 합니다(제목 1~40자, 메모 ≤200, 교실 ≤30, 교시 0~10, 시각 HH:MM, 끝>시작).
 */
import { useEffect, useRef, useState } from 'react'
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  type DocumentData,
} from 'firebase/firestore'
import { db } from '../firebase'
import { hmToMinutes, isYmd } from './dates'
import type { PersonalEntry, Weekday, Ymd } from './types'

export const PERSONAL_LIMITS = {
  titleMax: 40,
  memoMax: 200,
  roomMax: 30,
  periodMin: 0,
  periodMax: 10,
} as const

/** 화면 입력값(문자열이 섞여도 됨) */
export interface PersonalEntryDraft {
  title: string
  kind: 'weekly' | 'once'
  weekday?: number | string | null
  /** 'YYYYMMDD' 또는 'YYYY-MM-DD' */
  date?: string | null
  period?: number | string | null
  start?: string | null
  end?: string | null
  roomName?: string | null
  memo?: string | null
  linkedCourseId?: string | null
}

/** 저장 형태(생성 시 이 필드 + createdAt만 씀) */
export interface PersonalEntryFields {
  title: string
  kind: 'weekly' | 'once'
  weekday: Weekday | null
  date: Ymd | null
  period: number | null
  start: string | null
  end: string | null
  roomName: string | null
  memo: string | null
  linkedCourseId: string | null
}

export type PersonalEntryField = keyof PersonalEntryFields
export type PersonalEntryErrors = Partial<Record<PersonalEntryField | 'when', string>>

export type ValidationResult = { ok: true; value: PersonalEntryFields } | { ok: false; errors: PersonalEntryErrors }

const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const ID_RE = /^[A-Za-z0-9_-]{1,120}$/

const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim() : '')
const emptyToNull = (v: string): string | null => (v ? v : null)

/** 'H:MM'·'HH:MM' → 'HH:MM'. 형식이 틀리면 원문(검증에서 걸러짐) */
function normalizeHm(v: unknown): string | null {
  const s = clean(v)
  if (!s) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(s)
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : s
}

/**
 * 입력 검증 + 정규화. activeCourseIds를 주면 linkedCourseId가 그 안에 있어야 함(본인 활성 수강 수업).
 * 교시와 시작 시각 중 하나는 있어야 시간표에 놓을 수 있습니다.
 */
export function validatePersonalEntry(draft: PersonalEntryDraft, opts: { activeCourseIds?: string[] } = {}): ValidationResult {
  const errors: PersonalEntryErrors = {}

  const title = clean(draft.title)
  if (!title) errors.title = '제목을 입력해 주세요.'
  else if (title.length > PERSONAL_LIMITS.titleMax) errors.title = `제목은 ${PERSONAL_LIMITS.titleMax}자까지 쓸 수 있어요.`

  const kind: 'weekly' | 'once' = draft.kind === 'once' ? 'once' : 'weekly'
  let weekday: Weekday | null = null
  let date: Ymd | null = null
  if (kind === 'weekly') {
    const w = Number(draft.weekday)
    if (!Number.isInteger(w) || w < 1 || w > 7) errors.weekday = '요일을 골라 주세요.'
    else weekday = w as Weekday
  } else {
    const raw = clean(draft.date).replace(/-/g, '')
    if (!isYmd(raw)) errors.date = '날짜를 골라 주세요.'
    else date = raw
  }

  let period: number | null = null
  const pRaw = draft.period
  if (pRaw !== null && pRaw !== undefined && String(pRaw).trim() !== '') {
    const p = Number(pRaw)
    if (!Number.isInteger(p) || p < PERSONAL_LIMITS.periodMin || p > PERSONAL_LIMITS.periodMax) {
      errors.period = `교시는 ${PERSONAL_LIMITS.periodMin}~${PERSONAL_LIMITS.periodMax} 사이로 골라 주세요.`
    } else period = p
  }

  const start = normalizeHm(draft.start)
  const end = normalizeHm(draft.end)
  if (start && !HM_RE.test(start)) errors.start = '시작 시각 형식이 올바르지 않아요(예: 09:00).'
  if (end && !HM_RE.test(end)) errors.end = '끝 시각 형식이 올바르지 않아요(예: 09:50).'
  if (end && !start && !errors.end) errors.start = '끝 시각을 쓰려면 시작 시각도 입력해 주세요.'
  if (start && end && !errors.start && !errors.end) {
    const s = hmToMinutes(start)
    const e = hmToMinutes(end)
    if (s !== null && e !== null && e <= s) errors.end = '끝나는 시각이 시작 시각보다 늦어야 해요.'
  }
  if (period === null && !start && !errors.period && !errors.start) errors.when = '교시나 시작 시각 중 하나는 입력해 주세요.'

  const roomName = emptyToNull(clean(draft.roomName))
  if (roomName && roomName.length > PERSONAL_LIMITS.roomMax) errors.roomName = `교실은 ${PERSONAL_LIMITS.roomMax}자까지 쓸 수 있어요.`

  const memo = emptyToNull(clean(draft.memo))
  if (memo && memo.length > PERSONAL_LIMITS.memoMax) errors.memo = `메모는 ${PERSONAL_LIMITS.memoMax}자까지 쓸 수 있어요.`

  const linkedCourseId = emptyToNull(clean(draft.linkedCourseId))
  if (linkedCourseId) {
    if (!ID_RE.test(linkedCourseId)) errors.linkedCourseId = '연결할 수업을 다시 골라 주세요.'
    else if (opts.activeCourseIds && !opts.activeCourseIds.includes(linkedCourseId)) {
      errors.linkedCourseId = '참여 중인 공식 수업에만 연결할 수 있어요.'
    }
  }

  if (Object.keys(errors).length) return { ok: false, errors }
  return {
    ok: true,
    value: { title, kind, weekday, date, period, start: start || null, end: end || null, roomName, memo, linkedCourseId },
  }
}

function entriesCol(uid: string) {
  return collection(db, 'users', uid, 'personalEntries')
}

export interface WriteResult {
  ok: true
  entryId: string
  /** 서버 반영 완료(오프라인이면 연결될 때까지 대기). 규칙에 막히면 reject — 화면은 기다리지 않고 '저장 대기'를 보여 줘도 됨 */
  committed: Promise<void>
  /** 수정 시 실제로 바뀐 필드 */
  changed?: PersonalEntryField[]
}

export type WriteOutcome = WriteResult | { ok: false; errors: PersonalEntryErrors }

/** 새 개인 일정. 필드는 정확히 PersonalEntryFields + createdAt */
export function createPersonalEntry(uid: string, draft: PersonalEntryDraft, opts: { activeCourseIds?: string[] } = {}): WriteOutcome {
  const v = validatePersonalEntry(draft, opts)
  if (!v.ok) return v
  const ref = doc(entriesCol(uid))
  const value = v.value
  const committed = setDoc(ref, {
    title: value.title,
    kind: value.kind,
    weekday: value.weekday,
    date: value.date,
    period: value.period,
    start: value.start,
    end: value.end,
    roomName: value.roomName,
    memo: value.memo,
    linkedCourseId: value.linkedCourseId,
    createdAt: serverTimestamp(),
  })
  return { ok: true, entryId: ref.id, committed }
}

/** 기존 일정 수정: 바뀐 필드 + updatedAt만 씀. 바뀐 게 없으면 쓰지 않음 */
export function updatePersonalEntry(
  uid: string,
  current: PersonalEntry,
  draft: PersonalEntryDraft,
  opts: { activeCourseIds?: string[] } = {}
): WriteOutcome {
  // 연결을 그대로 둔 수정은 이미 저장된 연결이므로 허용(수강이 끝났으면 규칙이 판단)
  const keepLink = draft.linkedCourseId != null && draft.linkedCourseId === (current.linkedCourseId ?? null)
  const v = validatePersonalEntry(draft, keepLink ? {} : opts)
  if (!v.ok) return v
  const before = fieldsOf(current)
  const after = v.value
  const changed = (Object.keys(after) as PersonalEntryField[]).filter((k) => after[k] !== before[k])
  if (!changed.length) return { ok: true, entryId: current.entryId, committed: Promise.resolve(), changed: [] }
  const patch: DocumentData = { updatedAt: serverTimestamp() }
  changed.forEach((k) => {
    patch[k] = after[k]
  })
  const committed = updateDoc(doc(entriesCol(uid), current.entryId), patch)
  return { ok: true, entryId: current.entryId, committed, changed }
}

/** 공식 수업 연결/해제만 바꿈(학생이 직접 고른 활성 수강 수업) */
export function setPersonalEntryLink(
  uid: string,
  current: PersonalEntry,
  linkedCourseId: string | null,
  opts: { activeCourseIds?: string[] } = {}
): WriteOutcome {
  return updatePersonalEntry(uid, current, { ...draftOf(current), linkedCourseId }, opts)
}

export function deletePersonalEntry(uid: string, entryId: string): { ok: true; committed: Promise<void> } {
  return { ok: true, committed: deleteDoc(doc(entriesCol(uid), entryId)) }
}

/** 저장된 일정 → 편집 초기값 */
export function draftOf(e: PersonalEntry): PersonalEntryDraft {
  return {
    title: e.title,
    kind: e.kind,
    weekday: e.weekday ?? null,
    date: e.date ?? null,
    period: e.period ?? null,
    start: e.start ?? null,
    end: e.end ?? null,
    roomName: e.roomName ?? null,
    memo: e.memo ?? null,
    linkedCourseId: e.linkedCourseId ?? null,
  }
}

function fieldsOf(e: PersonalEntry): PersonalEntryFields {
  return {
    title: e.title,
    kind: e.kind,
    weekday: e.weekday ?? null,
    date: e.date ?? null,
    period: e.period ?? null,
    start: e.start ?? null,
    end: e.end ?? null,
    roomName: e.roomName ?? null,
    memo: e.memo ?? null,
    linkedCourseId: e.linkedCourseId ?? null,
  }
}

/** Firestore 문서 → PersonalEntry(값이 이상하면 안전한 기본값) */
export function personalEntryFromDoc(id: string, d: DocumentData, pendingSync: boolean): PersonalEntry {
  const kind: 'weekly' | 'once' = d.kind === 'once' ? 'once' : 'weekly'
  const w = Number(d.weekday)
  const p = Number(d.period)
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)
  return {
    entryId: id,
    title: typeof d.title === 'string' && d.title ? d.title : '직접 입력 일정',
    kind,
    weekday: kind === 'weekly' && Number.isInteger(w) && w >= 1 && w <= 7 ? (w as Weekday) : null,
    date: kind === 'once' && isYmd(d.date) ? d.date : null,
    period: d.period != null && Number.isInteger(p) ? p : null,
    start: str(d.start),
    end: str(d.end),
    roomName: str(d.roomName),
    memo: str(d.memo),
    linkedCourseId: str(d.linkedCourseId),
    pendingSync,
  }
}

export interface PersonalEntriesSnapshotMeta {
  fromCache: boolean
  hasPendingWrites: boolean
}

/**
 * 본인 개인 일정 구독(includeMetadataChanges — 서버 반영 전이면 pendingSync).
 * 반환값: 구독 해제 함수
 */
export function subscribePersonalEntries(
  uid: string,
  onData: (entries: PersonalEntry[], meta: PersonalEntriesSnapshotMeta) => void,
  onError?: (e: unknown) => void
): () => void {
  if (!uid || !db) {
    onError?.(new Error('no-db'))
    return () => {}
  }
  try {
    return onSnapshot(
      entriesCol(uid),
      { includeMetadataChanges: true },
      (snap) => {
        const entries = snap.docs.map((d) => personalEntryFromDoc(d.id, d.data(), d.metadata.hasPendingWrites))
        entries.sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0))
        onData(entries, { fromCache: snap.metadata.fromCache, hasPendingWrites: snap.metadata.hasPendingWrites })
      },
      (e) => {
        console.warn('[timetable] 직접 입력 일정 구독 실패', (e as { code?: string })?.code || e)
        onError?.(e)
      }
    )
  } catch (e) {
    onError?.(e)
    return () => {}
  }
}

export interface PersonalEntriesState {
  entries: PersonalEntry[]
  /** 첫 결과(캐시 포함)를 받았는지 */
  loaded: boolean
  /** 구독 오류 code(예: 'permission-denied') — 오류가 나면 entries는 비어 있음 */
  error: string | null
  /** 서버에 아직 반영되지 않은 쓰기가 있는지 */
  hasPendingWrites: boolean
}

const EMPTY_ENTRIES: PersonalEntriesState = { entries: [], loaded: false, error: null, hasPendingWrites: false }
const PERSONAL_READY_TIMEOUT_MS = 3000

/**
 * 구독 오류 뒤 다시 구독하기 — Firestore 구독은 오류가 나면 끝나므로(권한 오류: 새 규칙 배포 전후, 세션 만료 등)
 * 화면 복귀·포커스·온라인 복구 때만 다시 시작합니다. 간격은 5초부터 두 배씩(최대 5분), 서버 결과를 받기 전까지 최대 8번.
 */
export const PERSONAL_RESUBSCRIBE = { maxAttempts: 8, minGapMs: 5_000, maxGapMs: 5 * 60_000 } as const

export interface PersonalResubscribeState {
  /** 마지막 서버 결과 뒤 다시 구독한 횟수(서버 결과를 받으면 0) */
  attempts: number
  /** 마지막으로 구독을 시작한 시각(ms) */
  startedAt: number
}

/** 지금 다시 구독해도 되는지(순수 함수) — 포커스·visibilitychange가 한꺼번에 와도 한 번만, 계속 막혀도 몇 번만 */
export function canResubscribePersonal(r: PersonalResubscribeState, now: number): boolean {
  if (r.attempts >= PERSONAL_RESUBSCRIBE.maxAttempts) return false
  const gap = Math.min(PERSONAL_RESUBSCRIBE.minGapMs * 2 ** r.attempts, PERSONAL_RESUBSCRIBE.maxGapMs)
  return now - r.startedAt >= gap
}

/**
 * 화면 복귀(visibilitychange → visible)·포커스·온라인 복구 때 canResubscribePersonal이면 resubscribe() — r을 직접 갱신.
 * 반환값: 이벤트 해제 함수
 */
export function watchPersonalResubscribe(r: PersonalResubscribeState, resubscribe: () => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  const wake = () => {
    if (document.visibilityState === 'hidden') return
    const now = Date.now()
    if (!canResubscribePersonal(r, now)) return
    r.attempts++
    r.startedAt = now
    resubscribe()
  }
  window.addEventListener('focus', wake)
  document.addEventListener('visibilitychange', wake)
  window.addEventListener('online', wake)
  return () => {
    window.removeEventListener('focus', wake)
    document.removeEventListener('visibilitychange', wake)
    window.removeEventListener('online', wake)
  }
}

/**
 * 화면용: 본인 개인 일정 구독 훅(계정이 바뀌면 이전 계정 결과는 쓰지 않음).
 * 구독 오류면 오류를 보여 주다가 화면 복귀·포커스 때 다시 구독(watchPersonalResubscribe) — 새로 고치지 않아도 풀림.
 */
export function usePersonalEntries(uid: string | null): PersonalEntriesState {
  const [state, setState] = useState<{ uid: string | null; value: PersonalEntriesState }>({ uid: null, value: EMPTY_ENTRIES })
  const [attempt, setAttempt] = useState(0)
  const retryRef = useRef<PersonalResubscribeState & { uid: string | null }>({ uid: null, attempts: 0, startedAt: 0 })
  useEffect(() => {
    if (!uid) return
    const retry = retryRef.current
    if (retry.uid !== uid) {
      retry.uid = uid
      retry.attempts = 0
    }
    retry.startedAt = Date.now()
    let got = false
    // 오프라인 첫 연결 등으로 첫 결과가 늦으면 빈 목록으로 먼저 진행(나중 결과가 오면 바뀜) — 시간표가 스켈레톤에 묶이지 않게.
    // 다시 구독할 때는 이미 보여 주던 결과(오류 포함)를 새 결과가 올 때까지 그대로 둠
    const timer = setTimeout(() => {
      if (got) return
      setState((prev) =>
        prev.uid === uid && prev.value.loaded ? prev : { uid, value: { entries: [], loaded: true, error: null, hasPendingWrites: false } }
      )
    }, PERSONAL_READY_TIMEOUT_MS)
    const unsub = subscribePersonalEntries(
      uid,
      (entries, meta) => {
        got = true
        // 캐시 결과만으로는 횟수를 되돌리지 않음(캐시 → 서버 거부가 반복돼도 시도 횟수가 쌓이게)
        if (!meta.fromCache) retry.attempts = 0
        setState({ uid, value: { entries, loaded: true, error: null, hasPendingWrites: meta.hasPendingWrites } })
      },
      (e) => {
        got = true
        setState({
          uid,
          value: { entries: [], loaded: true, error: String((e as { code?: unknown })?.code || 'error'), hasPendingWrites: false },
        })
      }
    )
    return () => {
      clearTimeout(timer)
      unsub()
    }
  }, [uid, attempt])

  const failed = !!uid && state.uid === uid && !!state.value.error
  useEffect(() => {
    if (!uid || !failed) return
    return watchPersonalResubscribe(retryRef.current, () => setAttempt((a) => a + 1))
  }, [uid, failed])

  return uid && state.uid === uid ? state.value : EMPTY_ENTRIES
}
