/**
 * 공식 수업 일정 변경(변경 묶음) 서버 로직 — /api/schedule-changes 전용 (firebase-admin)
 * 클라이언트 번들에서 import하지 마세요.
 *
 * 흐름
 *  1. parseChangeRequest: 요청 items 검증·정규화(op별 필수 필드, occurrenceKey 형식, 시각·교시 범위)
 *  2. buildChangePlan: 기존 자료(대상 수업·반복 차시·변경 이력)를 읽고 planItems(순수)로 항목별 최종 상태를 만든 뒤,
 *     '이번 묶음을 모두 적용한 최종 상태'로 교사·교실·학생 충돌을 검사(engine.occurrencesForDates + detectResourceConflicts).
 *     중간 상태로 검사하지 않으므로 정상적인 교시 교환(A↔B)은 통과합니다.
 *  3. 쓰기(트랜잭션)는 API 라우트가 ChangePlan을 받아 합니다.
 *
 * 저장 규칙
 *  - 차시 변경(override)의 target에는 '최종 상태 전체'를 저장합니다. 엔진은 target을 기본 상태 위에 덮어 계산하므로,
 *    부분 값만 저장하면 이전 변경에서 바꾼 교실 등이 새 변경에서 조용히 기본값으로 돌아갑니다.
 *  - dates = [원래 날짜, 목표 날짜] + 같은 차시의 이전 변경들의 dates + 같은 묶음 다른 변경들의 날짜.
 *    날짜로 변경을 찾는 쪽(학생 시간표·충돌 검사)이 '그 날짜를 거쳐 간 차시'의 최신 변경과 묶음 전체를 놓치지 않게 합니다.
 *  - changeSetKeys = 묶음의 모든 `${courseId}|${occurrenceKey}` (엔진 incompleteChangeSets — 중간 상태 노출 방지).
 *  - 문서 id는 mutationId에서 결정적으로 만듭니다(재전송·승인 후 발행에서도 같은 id).
 *  - 학생 uid는 수를 세거나 알림 대상을 고르는 데만 쓰고 응답·로그·감사 기록에 넣지 않습니다.
 */
import { createHash } from 'crypto'
import type { CollectionReference, DocumentReference, DocumentSnapshot, Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore'
import { addDays, hmToMinutes, inRange, isYmd, weekdayOf } from './dates'
import {
  baseStateOf,
  courseActiveOn,
  detectResourceConflicts,
  diffSlots,
  effectiveOverrides,
  mergeTarget,
  occurrenceKeyOf,
  occurrencesForDates,
  parseOccurrenceKey,
  seriesOccursOn,
  validateSlot,
  type ResourceConflict,
  type ScheduledOccurrence,
} from './engine'
import {
  chunk,
  cleanText,
  courseFromDoc,
  courseManagerUids,
  defaultTermFor,
  homeroomOf,
  ID_RE,
  isCourseTeacher,
  overrideFromDoc,
  schoolRef,
  seriesFromDoc,
  type TermInfo,
} from './server'
import { periodRanges, schoolLevelOf } from '../periodTimes'
import type { ChangeField, Course, LessonSeries, Override, PeriodTime, SlotState, Weekday, Ymd } from './types'

// ───────────────────────── 상수 ─────────────────────────

/** 한 묶음의 최대 항목 수(트랜잭션 쓰기 한도 500 안에서 변경 + 묶음 + 감사 + 버전) */
export const MAX_ITEMS = 40
export const MAX_PERIOD = 10
/** 기본 시간표 변경의 충돌 검사 최대 날짜 수(주 1회 × 한 학기) */
const MAX_BASE_DATES = 30
const MUTATION_RE = /^[A-Za-z0-9_-]{6,100}$/
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/
const MK_KEY_RE = /^mk:[A-Za-z0-9_-]{1,120}$/
export const CHANGE_SET_ID_RE = /^cs_[A-Za-z0-9_-]{6,100}$/
/** 교사 변경 요청·승인 화면 (승인 요청 알림 링크) */
export const TEACHER_CHANGES_URL = '/teacher/schedule-changes'
/** 학생 개인 시간표(날짜 지정) — 변경 알림 링크 */
export const STUDENT_TIMETABLE_URL = '/student/timetable'

// ───────────────────────── 오류 ─────────────────────────

/** API가 그대로 { error, code, ...extra } + status로 돌려주는 오류 */
export class ChangeError extends Error {
  status: number
  code: string
  extra?: Record<string, unknown>
  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
    Object.setPrototypeOf(this, ChangeError.prototype)
  }
}

function bad(code: string, error: string, extra?: Record<string, unknown>): never {
  throw new ChangeError(400, code, error, extra)
}

// ───────────────────────── 요청 형식 ─────────────────────────

/** 차시 상태 일부(요청). 빠진 값은 현재 상태 유지, null은 '비움' */
export interface SlotPatch {
  date?: Ymd
  period?: number
  start?: string | null
  end?: string | null
  roomId?: string | null
  roomName?: string | null
  teacherNames?: string[]
  teacherUids?: string[]
}

export interface BasePatch extends Omit<SlotPatch, 'date'> {
  weekday?: Weekday
}

export type ChangeItem =
  | { op: 'cancel' | 'restore'; courseId: string; occurrenceKey: string }
  | { op: 'reschedule'; courseId: string; occurrenceKey: string; target: SlotPatch }
  | { op: 'makeup'; courseId: string; target: SlotPatch & { date: Ymd; period: number } }
  | { op: 'base'; courseId: string; seriesId: string; effectiveFrom: Ymd; patch: BasePatch }

export type ChangeOp = ChangeItem['op']

export interface ChangeRequest {
  mutationId: string | null
  expectedRevision: number | null
  scope: 'date' | 'base'
  reason: string
  items: ChangeItem[]
  acknowledgeConflicts: boolean
}

function parseTime(v: unknown, where: string): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null || v === '') return null
  const m = typeof v === 'string' ? hmToMinutes(v) : null
  if (m === null) bad('invalid-slot', `${where}: 시각 형식이 올바르지 않아요(HH:MM).`)
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

function parseStringList(v: unknown, where: string, kind: 'names' | 'uids'): string[] {
  if (!Array.isArray(v) || v.length > 5) bad('invalid-slot', `${where}: 교사 목록 형식이 올바르지 않아요.`)
  const out: string[] = []
  for (const x of v) {
    if (kind === 'uids') {
      if (typeof x !== 'string' || !UID_RE.test(x)) bad('invalid-teacher', `${where}: 교사 계정 형식이 올바르지 않아요.`)
      if (!out.includes(x)) out.push(x)
    } else {
      const name = cleanText(x, 30)
      if (!name) bad('invalid-slot', `${where}: 교사 이름이 비어 있어요.`)
      if (!out.includes(name)) out.push(name)
    }
  }
  return out
}

function parsePatchFields(r: Record<string, unknown>, where: string, out: SlotPatch | BasePatch) {
  if (r.period !== undefined) {
    if (typeof r.period !== 'number' || !Number.isInteger(r.period) || r.period < 0 || r.period > MAX_PERIOD) {
      bad('invalid-slot', `${where}: 교시는 0~${MAX_PERIOD} 사이여야 해요.`)
    }
    out.period = r.period
  }
  const start = parseTime(r.start, where)
  if (start !== undefined) out.start = start
  const end = parseTime(r.end, where)
  if (end !== undefined) out.end = end
  if (r.roomId !== undefined) {
    if (r.roomId === null || r.roomId === '') out.roomId = null
    else if (typeof r.roomId === 'string' && ID_RE.test(r.roomId)) out.roomId = r.roomId
    else bad('invalid-slot', `${where}: 교실 id 형식이 올바르지 않아요.`)
  }
  if (r.roomName !== undefined) out.roomName = r.roomName === null ? null : cleanText(r.roomName, 40) || null
  if (r.teacherNames !== undefined) out.teacherNames = parseStringList(r.teacherNames, where, 'names')
  if (r.teacherUids !== undefined) out.teacherUids = parseStringList(r.teacherUids, where, 'uids')
}

function parseSlotPatch(raw: unknown, where: string): SlotPatch {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('invalid-item', `${where}: 바꿀 내용(target)이 없어요.`)
  const r = raw as Record<string, unknown>
  const p: SlotPatch = {}
  if (r.date !== undefined) {
    if (!isYmd(r.date)) bad('invalid-slot', `${where}: 날짜 형식이 올바르지 않아요(YYYYMMDD).`)
    p.date = r.date
  }
  parsePatchFields(r, where, p)
  return p
}

function hasAnyField(p: object): boolean {
  return Object.keys(p).some((k) => (p as Record<string, unknown>)[k] !== undefined)
}

function isOccurrenceKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length > 140) return false
  if (key.startsWith('mk:')) return MK_KEY_RE.test(key)
  const parsed = parseOccurrenceKey(key)
  return !!parsed && ID_RE.test(parsed.seriesId) && isYmd(parsed.originalDate)
}

/**
 * 요청 본문 검증·정규화. 잘못되면 ChangeError(400).
 * requireMutationId/requireRevision: 발행은 둘 다 필수, 미리보기는 선택.
 */
export function parseChangeRequest(body: unknown, opts: { requireMutationId: boolean; requireRevision: boolean }): ChangeRequest {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>

  let mutationId: string | null = null
  if (b.mutationId !== undefined && b.mutationId !== null) {
    if (typeof b.mutationId !== 'string' || !MUTATION_RE.test(b.mutationId)) bad('invalid-request', '요청 id(mutationId) 형식이 올바르지 않아요.')
    mutationId = b.mutationId
  } else if (opts.requireMutationId) {
    bad('invalid-request', '요청 id(mutationId)가 필요해요.')
  }

  let expectedRevision: number | null = null
  if (b.expectedRevision !== undefined && b.expectedRevision !== null) {
    if (typeof b.expectedRevision !== 'number' || !Number.isInteger(b.expectedRevision) || b.expectedRevision < 0) {
      bad('invalid-request', '시간표 버전(expectedRevision) 형식이 올바르지 않아요.')
    }
    expectedRevision = b.expectedRevision
  } else if (opts.requireRevision) {
    bad('invalid-request', '화면에서 본 시간표 버전(expectedRevision)이 필요해요. 새로고침 후 다시 시도해 주세요.')
  }

  const scope = b.scope === undefined ? 'date' : b.scope
  if (scope !== 'date' && scope !== 'base') bad('invalid-request', "변경 범위(scope)는 'date'(이 날짜만) 또는 'base'(지정일부터 기본 시간표)여야 해요.")
  const reason = cleanText(b.reason, 200)

  if (!Array.isArray(b.items) || b.items.length === 0) bad('invalid-request', '바꿀 차시(items)가 없어요.')
  if (b.items.length > MAX_ITEMS) bad('too-many-items', `한 번에 바꿀 수 있는 차시는 ${MAX_ITEMS}개까지예요. 나눠서 발행해 주세요.`)

  const items: ChangeItem[] = []
  const seen = new Set<string>()
  b.items.forEach((raw, i) => {
    const where = `${i + 1}번째 항목`
    if (!raw || typeof raw !== 'object') bad('invalid-item', `${where}: 형식이 올바르지 않아요.`)
    const r = raw as Record<string, unknown>
    const op = r.op
    if (typeof r.courseId !== 'string' || !ID_RE.test(r.courseId)) bad('invalid-item', `${where}: 수업 id(courseId)가 올바르지 않아요.`)
    const courseId = r.courseId

    if (op === 'base') {
      if (scope !== 'base') bad('invalid-item', `${where}: 기본 시간표 변경은 scope 'base'로 보내 주세요.`)
      if (typeof r.seriesId !== 'string' || !ID_RE.test(r.seriesId)) bad('invalid-item', `${where}: 반복 차시 id(seriesId)가 올바르지 않아요.`)
      if (!isYmd(r.effectiveFrom)) bad('invalid-item', `${where}: 적용 시작일(effectiveFrom) 형식이 올바르지 않아요(YYYYMMDD).`)
      const patch: BasePatch = {}
      if (r.weekday !== undefined) {
        if (typeof r.weekday !== 'number' || !Number.isInteger(r.weekday) || r.weekday < 1 || r.weekday > 7) bad('invalid-slot', `${where}: 요일은 1(월)~7(일)이어야 해요.`)
        patch.weekday = r.weekday as Weekday
      }
      parsePatchFields(r, where, patch)
      if (!hasAnyField(patch)) bad('no-change', `${where}: 바꿀 내용이 없어요.`)
      const dupKey = 'series:' + r.seriesId
      if (seen.has(dupKey)) bad('duplicate-item', `${where}: 같은 반복 차시가 두 번 들어 있어요.`)
      seen.add(dupKey)
      items.push({ op: 'base', courseId, seriesId: r.seriesId, effectiveFrom: r.effectiveFrom, patch })
      return
    }
    if (scope === 'base') bad('invalid-item', `${where}: scope 'base'에는 기본 시간표 변경(op 'base')만 넣을 수 있어요.`)

    if (op === 'makeup') {
      const target = parseSlotPatch(r.target, where)
      if (target.date === undefined || target.period === undefined) bad('invalid-slot', `${where}: 보강은 날짜와 교시가 필요해요.`)
      items.push({ op: 'makeup', courseId, target: target as SlotPatch & { date: Ymd; period: number } })
      return
    }
    if (op !== 'cancel' && op !== 'restore' && op !== 'reschedule') bad('invalid-item', `${where}: 알 수 없는 변경 종류예요.`)
    if (!isOccurrenceKey(r.occurrenceKey)) bad('invalid-item', `${where}: 차시 식별자(occurrenceKey) 형식이 올바르지 않아요.`)
    const occurrenceKey = r.occurrenceKey
    if (seen.has(occurrenceKey)) bad('duplicate-item', `${where}: 같은 차시가 두 번 들어 있어요.`)
    seen.add(occurrenceKey)
    if (op === 'reschedule') {
      const target = parseSlotPatch(r.target, where)
      if (!hasAnyField(target)) bad('no-change', `${where}: 바꿀 내용이 없어요.`)
      items.push({ op, courseId, occurrenceKey, target })
    } else {
      items.push({ op, courseId, occurrenceKey })
    }
  })

  return { mutationId, expectedRevision, scope, reason, items, acknowledgeConflicts: b.acknowledgeConflicts === true }
}

/** undefined 키를 뺀 얕은 복사(저장용 — null은 '비움'이라 그대로 둠) */
function compact<T extends object>(o: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v
  return out as Partial<T>
}

/** 정규화된 항목 → 요청 형식(JSON). 승인 대기 묶음 저장·요청 해시에 씁니다. parseChangeRequest로 다시 읽을 수 있음 */
export function itemToJson(item: ChangeItem): Record<string, unknown> {
  switch (item.op) {
    case 'cancel':
    case 'restore':
      return { op: item.op, courseId: item.courseId, occurrenceKey: item.occurrenceKey }
    case 'reschedule':
      return { op: item.op, courseId: item.courseId, occurrenceKey: item.occurrenceKey, target: compact(item.target) }
    case 'makeup':
      return { op: item.op, courseId: item.courseId, target: compact(item.target) }
    case 'base':
      return { op: item.op, courseId: item.courseId, seriesId: item.seriesId, effectiveFrom: item.effectiveFrom, ...compact(item.patch) }
  }
}

/** 같은 mutationId로 다른 내용을 보냈는지 확인하는 요청 해시 */
export function requestHash(req: Pick<ChangeRequest, 'scope' | 'reason' | 'items'>): string {
  const json = JSON.stringify({ scope: req.scope, reason: req.reason, items: req.items.map(itemToJson) })
  return createHash('sha256').update(json).digest('hex').slice(0, 32)
}

export function changeSetIdOf(mutationId: string): string {
  return `cs_${mutationId}`
}

// ───────────────────────── 학기·교시 시각 ─────────────────────────

/** termForDate와 같은 규칙(학기 문서 → 없으면 기본 학기)을 한 번 읽은 학기 목록으로 */
export function makeTermResolver(terms: Array<{ id: string; data: Record<string, any> }>): (ymd: Ymd) => TermInfo {
  const list: TermInfo[] = []
  for (const t of terms) {
    if (isYmd(t.data.startDate) && isYmd(t.data.endDate)) {
      list.push({ termId: t.id, name: String(t.data.name || t.id), startDate: t.data.startDate, endDate: t.data.endDate, isDefault: false })
    }
  }
  return (ymd) => list.find((t) => ymd >= t.startDate && ymd < t.endDate) || defaultTermFor(ymd)
}

const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

/** 학교급 기본 교시 시각(학교급을 알 때만). 모르면 undefined → 교시 번호로만 비교 */
export function defaultPeriodTimes(kindOrName: unknown): PeriodTime[] | undefined {
  const n = typeof kindOrName === 'string' ? kindOrName.trim() : ''
  if (!/(고등학교|중학교|초등학교)$/.test(n)) return undefined
  return periodRanges(schoolLevelOf(n)).map(([s, e], i) => ({ period: i + 1, start: hm(s), end: hm(e) }))
}

// ───────────────────────── 상태 계산 도우미 ─────────────────────────

/** 상태를 저장 가능한 완전한 형태로(빈 값은 null/[]) */
export function fullSlot(s: SlotState): SlotState {
  return {
    date: s.date,
    period: s.period,
    start: s.start ?? null,
    end: s.end ?? null,
    roomId: s.roomId ?? null,
    roomName: s.roomName ?? null,
    teacherNames: s.teacherNames ?? [],
    teacherUids: s.teacherUids ?? [],
  }
}

/**
 * 현재 상태 위에 요청 값을 덮음 — 엔진 mergeTarget과 같은 규칙(학생 화면과 같은 결과):
 * 빠진 값은 현재 상태 유지, 교시만 바꾸면 명시 시각은 비움(교시표를 따름),
 * 교실(roomId·roomName)과 교사(uid·이름)는 하나만 줘도 한 묶음으로 교체.
 */
export function applyPatch(cur: SlotState, p: SlotPatch): SlotState {
  const target: SlotState = { ...compact(p), date: p.date ?? cur.date, period: p.period ?? cur.period }
  return fullSlot(mergeTarget(cur, target))
}

/** 엔진 effectiveOverrides의 키 */
export const effKey = (courseId: string, occurrenceKey: string) => `${courseId}|${occurrenceKey}`

const unique = <T,>(arr: T[]): T[] => Array.from(new Set(arr))

/** 'YYYYMMDD' → 'M/D' */
export function shortDate(ymd: Ymd): string {
  return `${Number(ymd.slice(4, 6))}/${Number(ymd.slice(6, 8))}`
}

/** 날짜 이후(포함) 처음 오는 그 요일 */
function firstWeekdayOnOrAfter(from: Ymd, weekday: Weekday): Ymd {
  return addDays(from, (weekday - weekdayOf(from) + 7) % 7)
}

// ───────────────────────── 계획(순수) ─────────────────────────

/** 변경 문서 + 조회용 dates */
export interface OverrideRecord {
  o: Override
  dates: Ymd[]
}

export interface ChangePreview {
  courseId: string
  title: string
  occurrenceKey: string
  kind: ChangeOp
  /** 지금 학생 화면의 상태(취소된 상태면 null) */
  before: SlotState | null
  /** 변경 후(취소면 null) */
  after: SlotState | null
  /** 기본(원래) 상태 — 보강이면 null */
  base: SlotState | null
  /** before → after에서 달라진 항목 */
  fields: ChangeField[]
  seriesId?: string | null
  newSeriesId?: string | null
  effectiveFrom?: Ymd | null
}

export interface ConflictEntry extends ResourceConflict {
  date: Ymd
  aCourseId: string
  bCourseId: string
  aTitle: string
  bTitle: string
  aPeriod: number
  bPeriod: number
}

export interface OrphanEntry {
  overrideId: string
  courseId: string
  occurrenceKey: string
  kind: Override['kind']
  originalDate: Ymd | null
  target: SlotState | null
  revision: number
  changeSetId: string
  reason: string | null
  /** 같은 날짜에 열리는 새 반복 차시가 있으면 그 차시 id(재연결 후보) */
  suggestedOccurrenceKey: string | null
}

export interface BaseItemPlan {
  courseId: string
  seriesId: string
  newSeriesId: string
  effectiveFrom: Ymd
}

export interface PlanItemsInput {
  req: ChangeRequest
  mutationId: string
  requesterUid: string
  /** 계획 기준 scheduleRevision — 새 변경은 revision+1 */
  revision: number
  courses: Map<string, Course>
  /** 대상 수업의 모든 반복 차시 */
  series: Map<string, LessonSeries>
  /** effKey(courseId, occurrenceKey) → 그 차시의 모든 변경(이력) */
  histories: Map<string, OverrideRecord[]>
  termOf: (ymd: Ymd) => TermInfo
  /** 학교 시간대 오늘 */
  today: Ymd
}

export interface PlannedItems {
  proposed: Override[]
  overrideDocs: Array<{ id: string; data: Record<string, unknown> }>
  seriesRetire: Array<{ seriesId: string; validTo: Ymd; expectValidTo: Ymd | null; newSeriesId: string }>
  seriesCreate: Array<{ id: string; data: Record<string, unknown> }>
  /** 기본 변경을 적용한 뒤의 대상 수업 반복 차시 */
  seriesAfter: Map<string, LessonSeries>
  changes: ChangePreview[]
  /** 이번 묶음으로 상태가 바뀌는 차시(충돌 보고 대상) */
  changedKeys: Set<string>
  /** 충돌 검사 날짜(바뀐 차시의 최종 날짜) */
  conflictDates: Ymd[]
  /** 수업별 영향 날짜(알림·영향 학생 계산) */
  courseDates: Map<string, Set<Ymd>>
  baseItems: BaseItemPlan[]
}

function checkTerm(course: Course, dates: Ymd[], termOf: (ymd: Ymd) => TermInfo, where: string) {
  const ids = unique(dates.map((d) => termOf(d).termId))
  const ok = course.termId ? ids.every((id) => id === course.termId) : ids.length <= 1
  if (!ok) bad('out-of-term', `${where}: 수업의 학기 범위를 벗어난 날짜예요.`)
}

function checkCourseActive(course: Course, dates: Ymd[], where: string) {
  for (const d of dates) {
    if (!courseActiveOn(course, d)) throw new ChangeError(400, 'course-ended', `${where}: '${course.title}' 수업은 이 날짜에 운영되지 않아요(종료된 수업).`)
  }
}

function checkSlot(slot: SlotState, where: string) {
  const errors = validateSlot(slot, { maxPeriod: MAX_PERIOD })
  if (errors.length) bad('invalid-slot', `${where}: ${errors.join(' ')}`)
}

/**
 * 항목별 최종 상태 계획(순수). 검증 실패는 ChangeError.
 * - 반복 차시 키는 대상 반복 차시가 그 날짜에 실제로 열려야 함(복원은 검토 대상(orphan) 정리용으로 허용)
 * - 보강 키(mk:)는 같은 수업의 기존 보강이 있어야 함
 */
export function planItems(input: PlanItemsInput): PlannedItems {
  const { req, mutationId, requesterUid, courses, series, histories, termOf, today } = input
  const changeSetId = changeSetIdOf(mutationId)
  const newRevision = input.revision + 1
  const out: PlannedItems = {
    proposed: [],
    overrideDocs: [],
    seriesRetire: [],
    seriesCreate: [],
    seriesAfter: new Map(series),
    changes: [],
    changedKeys: new Set(),
    conflictDates: [],
    courseDates: new Map(),
    baseItems: [],
  }
  const addCourseDate = (courseId: string, ...dates: Array<Ymd | null | undefined>) => {
    const set = out.courseDates.get(courseId) || new Set<Ymd>()
    dates.forEach((d) => d && set.add(d))
    out.courseDates.set(courseId, set)
  }
  const conflictDates = new Set<Ymd>()

  req.items.forEach((item, i) => {
    const where = `${i + 1}번째 항목`
    const course = courses.get(item.courseId)
    if (!course) throw new ChangeError(404, 'course-not-found', `${where}: 수업을 찾을 수 없어요.`)

    if (item.op === 'base') {
      const s = series.get(item.seriesId)
      if (!s || s.courseId !== course.courseId || (s.status === 'retired' && !s.validTo)) {
        throw new ChangeError(404, 'series-not-found', `${where}: 반복 차시를 찾을 수 없어요. 목록을 새로고침해 주세요.`)
      }
      const from = item.effectiveFrom
      if (from < today) bad('past-effective-date', `${where}: 기본 시간표 변경은 오늘 이후 날짜부터 적용할 수 있어요.`)
      if (from < s.validFrom) bad('effective-before-series', `${where}: 적용 시작일이 이 반복 차시의 시작일보다 빨라요.`)
      if (s.validTo && from >= s.validTo) bad('series-ended', `${where}: 이미 끝난 반복 차시예요.`)
      checkTerm(course, [from], termOf, where)
      checkCourseActive(course, [from], where)
      const p = item.patch
      // 엔진 mergeTarget과 같은 규칙: 교시만 바꾸면 명시 시각은 비움, 교실·교사는 한 묶음으로 교체
      const period = p.period ?? s.period
      const timesGiven = p.start !== undefined || p.end !== undefined
      const keepTimes = !timesGiven && period === s.period
      const roomGiven = p.roomId !== undefined || p.roomName !== undefined
      const next: LessonSeries = {
        seriesId: `sr_${mutationId}_${i}`,
        courseId: s.courseId,
        weekday: p.weekday ?? s.weekday,
        period,
        start: timesGiven ? p.start ?? null : keepTimes ? s.start ?? null : null,
        end: timesGiven ? p.end ?? null : keepTimes ? s.end ?? null : null,
        roomId: roomGiven ? p.roomId ?? null : s.roomId ?? null,
        roomName: roomGiven ? p.roomName ?? null : s.roomName ?? null,
        teacherNames: p.teacherNames !== undefined ? p.teacherNames : s.teacherNames ?? [],
        teacherUids: p.teacherUids !== undefined ? p.teacherUids : s.teacherUids ?? [],
        validFrom: from,
        validTo: s.validTo,
        status: 'active',
        // 학급 시간표에서 온 차시를 옮기면 새 차시도 그 학급 차시 — 학급 시간표 → 공통 수업 재실행이 찾아서 중복을 만들지 않게
        ...(s.sourceHomeroomId ? { sourceHomeroomId: s.sourceHomeroomId } : {}),
      }
      const d1 = firstWeekdayOnOrAfter(from, next.weekday)
      checkSlot({ date: d1, period: next.period, start: next.start, end: next.end }, where)
      const same =
        next.weekday === s.weekday &&
        next.period === s.period &&
        (next.start ?? null) === (s.start ?? null) &&
        (next.end ?? null) === (s.end ?? null) &&
        (next.roomId ?? null) === (s.roomId ?? null) &&
        (next.roomName ?? null) === (s.roomName ?? null) &&
        JSON.stringify(next.teacherNames ?? []) === JSON.stringify(s.teacherNames ?? []) &&
        JSON.stringify(next.teacherUids ?? []) === JSON.stringify(s.teacherUids ?? [])
      if (same) bad('no-change', `${where}: 지금 기본 시간표와 같아요.`)

      const retired: LessonSeries = { ...s, validTo: from, status: 'retired' }
      out.seriesAfter.set(s.seriesId, retired)
      out.seriesAfter.set(next.seriesId, next)
      out.seriesRetire.push({ seriesId: s.seriesId, validTo: from, expectValidTo: s.validTo, newSeriesId: next.seriesId })
      out.seriesCreate.push({
        id: next.seriesId,
        data: {
          courseId: next.courseId,
          termId: course.termId || termOf(from).termId,
          weekday: next.weekday,
          period: next.period,
          start: next.start ?? null,
          end: next.end ?? null,
          roomId: next.roomId ?? null,
          roomName: next.roomName ?? null,
          teacherNames: next.teacherNames ?? [],
          teacherUids: next.teacherUids ?? [],
          validFrom: from,
          validTo: next.validTo ?? null,
          status: 'active',
          replacesSeriesId: s.seriesId,
          ...(next.sourceHomeroomId ? { sourceHomeroomId: next.sourceHomeroomId } : {}),
          changeSetId,
          createdBy: requesterUid,
        },
      })
      out.baseItems.push({ courseId: course.courseId, seriesId: s.seriesId, newSeriesId: next.seriesId, effectiveFrom: from })

      // 변경 전후(적용일 이후 첫 차시 기준)
      const d0 = firstWeekdayOnOrAfter(from, s.weekday)
      const before = !s.validTo || d0 < s.validTo ? fullSlot(baseStateOf(s, d0, course)) : null
      const after = fullSlot(baseStateOf(next, d1, course))
      out.changes.push({
        courseId: course.courseId,
        title: course.title,
        occurrenceKey: occurrenceKeyOf(s.seriesId, d0),
        kind: 'base',
        before,
        after,
        base: before,
        fields: before ? diffSlots(before, after) : [],
        seriesId: s.seriesId,
        newSeriesId: next.seriesId,
        effectiveFrom: from,
      })
      // 새 반복 차시의 날짜들(적용일 ~ 학기 끝/기존 종료일)
      const termEnd = termOf(from).endDate
      const end = s.validTo && s.validTo < termEnd ? s.validTo : termEnd
      for (let d = d1, n = 0; d < end && n < MAX_BASE_DATES; d = addDays(d, 7), n++) {
        conflictDates.add(d)
        out.changedKeys.add(occurrenceKeyOf(next.seriesId, d))
      }
      addCourseDate(course.courseId, from)
      return
    }

    const overrideId = `ov_${mutationId}_${i}`
    if (item.op === 'makeup') {
      const key = `mk:${mutationId}-${i}`
      const defaults: SlotState = {
        date: item.target.date,
        period: item.target.period,
        roomId: course.defaultRoomId ?? null,
        roomName: course.defaultRoomName ?? null,
        teacherNames: course.teacherNames,
        teacherUids: course.teacherUids,
      }
      const after = applyPatch(defaults, item.target)
      checkSlot(after, where)
      checkTerm(course, [after.date], termOf, where)
      checkCourseActive(course, [after.date], where)
      const o: Override = {
        overrideId,
        courseId: course.courseId,
        occurrenceKey: key,
        changeSetId,
        kind: 'makeup',
        seriesId: null,
        originalDate: null,
        target: after,
        reason: req.reason || undefined,
        revision: newRevision,
        status: 'published',
      }
      out.proposed.push(o)
      out.overrideDocs.push({ id: overrideId, data: overrideDocData(o, [after.date], requesterUid) })
      out.changes.push({ courseId: course.courseId, title: course.title, occurrenceKey: key, kind: 'makeup', before: null, after, base: null, fields: [] })
      out.changedKeys.add(key)
      conflictDates.add(after.date)
      addCourseDate(course.courseId, after.date)
      return
    }

    // cancel / restore / reschedule — 기존 차시
    const key = item.occurrenceKey
    const hist = histories.get(effKey(course.courseId, key)) || []
    const eff = effectiveOverrides(hist.map((h) => h.o)).get(effKey(course.courseId, key))
    const histDates = unique(hist.reduce<Ymd[]>((acc, h) => acc.concat(h.dates), []))
    let base: SlotState | null = null
    let current: SlotState | null = null
    let seriesId: string | null = null
    let originalDate: Ymd | null = null
    /** 취소된 차시를 다시 열 때 출발점 */
    let reopenFrom: SlotState | null = null

    if (key.startsWith('mk:')) {
      // 보강 차시: 기준 상태 = 그 차시의 첫 보강 발행(엔진 makeupBases와 같은 규칙), 복원은 그 상태로
      const firstMakeup = hist
        .map((h) => h.o)
        .filter((o) => o.status === 'published' && o.kind === 'makeup' && o.target)
        .sort((a, b) => a.revision - b.revision || (a.overrideId < b.overrideId ? -1 : 1))[0]
      if (!eff || !firstMakeup?.target) throw new ChangeError(404, 'occurrence-not-found', `${where}: 보강 차시를 찾을 수 없어요.`)
      base = fullSlot(mergeTarget(null, firstMakeup.target))
      if (eff.kind === 'makeup' && eff.target) current = fullSlot(mergeTarget(null, eff.target))
      else if (eff.kind === 'restore') current = base
      else if (eff.kind === 'reschedule' && eff.target) current = fullSlot(mergeTarget(base, eff.target))
      else current = null
      reopenFrom = current || base
    } else {
      const parsed = parseOccurrenceKey(key)!
      seriesId = parsed.seriesId
      originalDate = parsed.originalDate
      const s = series.get(parsed.seriesId)
      if (!s || s.courseId !== course.courseId) throw new ChangeError(404, 'occurrence-not-found', `${where}: 그 날짜에는 이 수업 차시가 없어요. 시간표를 새로고침해 주세요.`)
      const occurs = seriesOccursOn(s, parsed.originalDate) && courseActiveOn(course, parsed.originalDate)
      if (occurs) {
        base = fullSlot(baseStateOf(s, parsed.originalDate, course))
        if (!eff || eff.kind === 'restore' || eff.kind === 'makeup' || !eff.target) current = base
        else if (eff.kind === 'cancel') current = null
        else current = fullSlot(mergeTarget(base, eff.target))
        reopenFrom = current || base
      } else if (!(item.op === 'restore' && eff && eff.kind !== 'restore')) {
        // 복원만 예외: 기본 시간표가 바뀌어 대상이 사라진 변경(orphan)을 정리하는 용도
        throw new ChangeError(404, 'occurrence-not-found', `${where}: 그 날짜에는 이 수업 차시가 없어요. 시간표를 새로고침해 주세요.`)
      }
    }

    let after: SlotState | null = null
    if (item.op === 'cancel') {
      if (!current) bad('no-change', `${where}: 이미 취소된 차시예요.`)
    } else if (item.op === 'restore') {
      const already = !eff || eff.kind === 'restore' || (key.startsWith('mk:') && eff.kind === 'makeup' && !!current && !!base && !diffSlots(base, current).length)
      if (already) bad('nothing-to-restore', `${where}: 이미 원래 일정이에요.`)
      after = base
    } else if (item.op === 'reschedule') {
      if (!reopenFrom) throw new ChangeError(404, 'occurrence-not-found', `${where}: 차시의 현재 상태를 알 수 없어요.`)
      after = applyPatch(reopenFrom, item.target)
      checkSlot(after, where)
      if (current && !diffSlots(current, after).length) bad('no-change', `${where}: 지금 일정과 같아요.`)
    }

    const termDates = [originalDate, after?.date].filter((d): d is Ymd => !!d)
    if (termDates.length) checkTerm(course, termDates, termOf, where)
    if (after) checkCourseActive(course, [after.date], where)

    const o: Override = {
      overrideId,
      courseId: course.courseId,
      occurrenceKey: key,
      changeSetId,
      kind: item.op,
      seriesId,
      originalDate,
      target: item.op === 'reschedule' ? after : null,
      reason: req.reason || undefined,
      revision: newRevision,
      status: 'published',
    }
    const dates = unique([originalDate, after?.date, current?.date, ...histDates].filter((d): d is Ymd => !!d)).sort()
    out.proposed.push(o)
    out.overrideDocs.push({ id: overrideId, data: overrideDocData(o, dates, requesterUid) })
    out.changes.push({
      courseId: course.courseId,
      title: course.title,
      occurrenceKey: key,
      kind: item.op,
      before: current,
      after,
      base,
      fields: current && after ? diffSlots(current, after) : [],
    })
    out.changedKeys.add(key)
    if (after) conflictDates.add(after.date)
    addCourseDate(course.courseId, originalDate, current?.date, after?.date)
  })

  // 묶음 완전성(엔진 incompleteChangeSets): 같은 묶음의 모든 변경 키를 각 변경에 기록하고,
  // dates도 묶음 전체 날짜로 맞춤 — 기간으로 변경을 읽는 쪽(/api/timetable/me)이 묶음의 일부만 받아
  // '불완전한 묶음'으로 통째로 버리지 않게(예: 화요일 취소 + 수요일 보강을 화요일 하루만 조회)
  const changeSetKeys = out.proposed.map((o) => effKey(o.courseId, o.occurrenceKey)).sort()
  const batchDates = unique(out.overrideDocs.reduce<Ymd[]>((acc, d) => acc.concat(d.data.dates as Ymd[]), [])).sort()
  out.proposed.forEach((o) => (o.changeSetKeys = changeSetKeys))
  out.overrideDocs.forEach((d) => {
    d.data.changeSetKeys = changeSetKeys
    d.data.dates = batchDates
  })
  out.conflictDates = Array.from(conflictDates).sort()
  return out
}

function overrideDocData(o: Override, dates: Ymd[], createdBy: string): Record<string, unknown> {
  return {
    courseId: o.courseId,
    occurrenceKey: o.occurrenceKey,
    changeSetId: o.changeSetId,
    kind: o.kind,
    seriesId: o.seriesId ?? null,
    originalDate: o.originalDate ?? null,
    target: o.target ? fullSlot(o.target) : null,
    dates,
    reason: o.reason ?? null,
    revision: o.revision,
    status: 'published',
    createdBy,
  }
}

// ───────────────────────── 충돌(순수) ─────────────────────────

export interface ConflictInput {
  dates: Ymd[]
  courses: Course[]
  series: LessonSeries[]
  overrides: Override[]
  /** 이번 묶음으로 바뀌는 차시 — 이 차시가 낀 충돌만 보고(원래 있던 다른 수업끼리의 충돌은 이번 변경 탓이 아님) */
  changedKeys: Set<string>
  periodTimes?: PeriodTime[]
  /** 그 날짜에 두 수업을 함께 듣는 학생 수 */
  studentOverlap: (a: string, b: string, date: Ymd) => number
}

/** 묶음 전체 적용 후 최종 상태 기준 교사·교실·학생 충돌 */
export function computeConflicts(input: ConflictInput): ConflictEntry[] {
  const occs = occurrencesForDates(input.dates, input.courses, input.series, input.overrides)
  const byKey = new Map<string, ScheduledOccurrence>(occs.map((o) => [o.key, o]))
  const titleOf = new Map(input.courses.map((c) => [c.courseId, c.title]))
  const byDate = new Map<Ymd, ScheduledOccurrence[]>()
  for (const o of occs) {
    const list = byDate.get(o.date) || []
    list.push(o)
    byDate.set(o.date, list)
  }
  const out: ConflictEntry[] = []
  for (const date of Array.from(byDate.keys()).sort()) {
    const list = byDate.get(date)!
    if (!list.some((o) => input.changedKeys.has(o.key))) continue
    const found = detectResourceConflicts(list, {
      periodTimes: input.periodTimes,
      studentOverlap: (a, b) => input.studentOverlap(a, b, date),
    })
    for (const c of found) {
      if (!input.changedKeys.has(c.a) && !input.changedKeys.has(c.b)) continue
      const a = byKey.get(c.a)!
      const b = byKey.get(c.b)!
      out.push({
        ...c,
        detail: conflictLabel(c, a),
        date,
        aCourseId: a.courseId,
        bCourseId: b.courseId,
        aTitle: titleOf.get(a.courseId) || '',
        bTitle: titleOf.get(b.courseId) || '',
        aPeriod: a.period,
        bPeriod: b.period,
      })
    }
  }
  return out
}

/**
 * 응답·저장용 충돌 설명: 교사는 표시 이름, 교실은 교실 이름, 학생은 겹치는 인원 수(명단 아님).
 * 엔진 detail의 'uid:…'(계정 id)·정규화한 이름을 화면·기록에 그대로 내보내지 않습니다.
 */
function conflictLabel(c: ResourceConflict, a: ScheduledOccurrence): string {
  if (c.kind === 'teacher') {
    if (c.detail.startsWith('uid:')) {
      const i = (a.teacherUids ?? []).indexOf(c.detail.slice(4))
      const name = i >= 0 ? (a.teacherNames ?? [])[i] : undefined
      return name || (a.teacherNames ?? [])[0] || '같은 교사'
    }
    return (a.teacherNames ?? [])[0] || '같은 교사'
  }
  if (c.kind === 'room') return a.roomName || a.roomId || '같은 교실'
  return c.detail
}

/**
 * 충돌 동일성 키 — 요청 때 저장한 충돌과 승인 때 다시 검사한 충돌을 비교합니다.
 * 두 차시 순서는 정규화하고, 학생 충돌의 detail(겹치는 인원 수)은 수강 변동으로 바뀌므로 넣지 않습니다.
 * 교사·교실 충돌의 detail(교사·교실 이름)은 넣음 — 다른 교사·교실로 겹치게 됐으면 새 충돌로 봄.
 */
export function conflictKey(c: Pick<ConflictEntry, 'kind' | 'date' | 'a' | 'b' | 'aCourseId' | 'bCourseId' | 'detail'>): string {
  const pair = [`${c.aCourseId}|${c.a}`, `${c.bCourseId}|${c.b}`].sort()
  return [c.kind, c.date, pair[0], pair[1], c.kind === 'students' ? '' : c.detail].join('#')
}

/**
 * 지금 충돌이 모두 저장된 충돌(요청 때 요청자가 확인한 것)에 들어 있는지.
 * 승인 시점에 새로 생긴 충돌은 아무도 확인하지 않았으므로 false — 승인자가 직접 확인해야 함.
 */
export function conflictsCovered(fresh: ConflictEntry[], stored: unknown): boolean {
  const known = new Set(
    (Array.isArray(stored) ? stored : []).filter((x): x is ConflictEntry => !!x && typeof x === 'object').map((x) => conflictKey(x))
  )
  return fresh.every((c) => known.has(conflictKey(c)))
}

// ───────────────────────── 검토 필요(orphan) ─────────────────────────

function orphanEntry(o: Override, suggested: string | null): OrphanEntry {
  return {
    overrideId: o.overrideId,
    courseId: o.courseId,
    occurrenceKey: o.occurrenceKey,
    kind: o.kind,
    originalDate: o.originalDate ?? null,
    target: o.target ?? null,
    revision: o.revision,
    changeSetId: o.changeSetId,
    reason: o.reason ?? null,
    suggestedOccurrenceKey: suggested,
  }
}

function groupByKey(records: OverrideRecord[]): Map<string, OverrideRecord[]> {
  const m = new Map<string, OverrideRecord[]>()
  const seen = new Set<string>()
  for (const r of records) {
    if (seen.has(r.o.overrideId)) continue
    seen.add(r.o.overrideId)
    const k = effKey(r.o.courseId, r.o.occurrenceKey)
    const list = m.get(k) || []
    list.push(r)
    m.set(k, list)
  }
  return m
}

/**
 * 기본 시간표 변경으로 '새로' 대상 차시가 사라지는 기존 날짜 변경.
 * 적용일 이후 날짜를 가리키는 기존 유효 변경(복원 제외) 중 변경 후에는 그 반복 차시가 열리지 않는 것.
 */
export function findBaseOrphans(
  records: OverrideRecord[],
  baseItems: BaseItemPlan[],
  seriesBefore: Map<string, LessonSeries>,
  seriesAfter: Map<string, LessonSeries>
): OrphanEntry[] {
  const out: OrphanEntry[] = []
  groupByKey(records).forEach((list, gk) => {
    const eff = effectiveOverrides(list.map((r) => r.o)).get(gk)
    if (!eff || eff.kind === 'restore') return
    const parsed = parseOccurrenceKey(eff.occurrenceKey)
    if (!parsed) return
    const item = baseItems.find((b) => b.seriesId === parsed.seriesId && b.courseId === eff.courseId)
    if (!item || parsed.originalDate < item.effectiveFrom) return
    const before = seriesBefore.get(parsed.seriesId)
    const after = seriesAfter.get(parsed.seriesId)
    if (!before || !seriesOccursOn(before, parsed.originalDate)) return // 이미 검토 대상이던 것
    if (after && seriesOccursOn(after, parsed.originalDate)) return
    const next = seriesAfter.get(item.newSeriesId)
    const suggested = next && seriesOccursOn(next, parsed.originalDate) ? occurrenceKeyOf(next.seriesId, parsed.originalDate) : null
    out.push(orphanEntry(eff, suggested))
  })
  return out.sort((a, b) => (a.originalDate || '').localeCompare(b.originalDate || '') || a.occurrenceKey.localeCompare(b.occurrenceKey))
}

/** 현재 대상 차시가 없는 발행 변경(수업 단위 검토 목록) */
export function findOrphans(records: OverrideRecord[], series: Map<string, LessonSeries>): OrphanEntry[] {
  const out: OrphanEntry[] = []
  const all = Array.from(series.values())
  groupByKey(records).forEach((list, gk) => {
    const eff = effectiveOverrides(list.map((r) => r.o)).get(gk)
    if (!eff || eff.kind === 'restore') return
    const parsed = parseOccurrenceKey(eff.occurrenceKey)
    if (!parsed) return
    const s = series.get(parsed.seriesId)
    if (s && s.courseId === eff.courseId && seriesOccursOn(s, parsed.originalDate)) return
    const candidates = all.filter((x) => x.courseId === eff.courseId && seriesOccursOn(x, parsed.originalDate))
    const pick = candidates.find((x) => s && x.period === s.period) || candidates[0]
    out.push(orphanEntry(eff, pick ? occurrenceKeyOf(pick.seriesId, parsed.originalDate) : null))
  })
  return out.sort((a, b) => (a.originalDate || '').localeCompare(b.originalDate || '') || a.occurrenceKey.localeCompare(b.occurrenceKey))
}

// ───────────────────────── 학급 시간표 → 공통 수업 재실행(순수, /api/courses) ─────────────────────────

/** 학급 시간표 칸 — 요일·교시·수업·교실이 같으면 같은 차시로 봄 */
export interface HomeroomCellKey {
  weekday: Weekday
  period: number
  courseId: string
  room: string | null
}

/** 기존 차시 + 기본 변경 연결(문서의 replacesSeriesId·supersededBy) */
export interface HomeroomSeriesRecord {
  s: LessonSeries
  replacesSeriesId?: string | null
  supersededBy?: string | null
}

export interface HomeroomSeriesPlan<T extends HomeroomCellKey> {
  /** 그대로 둘 차시 id */
  keep: Set<string>
  /** 새로 만들 칸(validFrom은 보통 적용일) */
  toCreate: Array<T & { validFrom: Ymd }>
  /** 적용일부터 끝낼 차시 */
  toRetire: LessonSeries[]
  /** 기본 시간표 변경으로 옮긴 채로 유지한 칸 수 */
  keptByChange: number
}

const seriesOpen = (s: LessonSeries) => !(s.status === 'retired' && !s.validTo) && (!s.validTo || s.validTo > s.validFrom)
const sameCell = (s: LessonSeries, c: HomeroomCellKey) =>
  s.weekday === c.weekday && s.period === c.period && s.courseId === c.courseId && (s.roomName || null) === (c.room || null)

/**
 * 학급 시간표 → 공통 수업 재실행 계획.
 * existing: 이번 학기 후보 차시(sourceHomeroomId가 이 학급인 것 + 이 학급 공통 수업들의 차시).
 * - 이 학급 차시 = sourceHomeroomId가 이 학급이거나, 기본 변경 연결(replacesSeriesId·supersededBy)로 그런 차시와 이어진 차시.
 *   (예전 기본 변경으로 생긴 차시엔 sourceHomeroomId가 없을 수 있음) 교사가 직접 추가한 차시는 건드리지 않음.
 * - 기본 시간표 변경으로 이어진 차시 묶음은 '처음 만든 칸' 또는 '지금 칸'이 학급 시간표에 그대로 있으면 이미 반영된 칸 —
 *   묶음 전체를 그대로 둠(다시 만들지도, 끝내지도 않음). 담임이 기본 변경으로 옮긴 차시를 재실행이 되돌리거나 겹쳐 만들지 않게.
 * - 학급 시간표가 실제로 바뀐 칸만 적용일부터 반영: 없어진 칸의 차시는 끝내고 새 칸은 만듦.
 */
export function planHomeroomSeries<T extends HomeroomCellKey>(input: {
  classId: string
  effectiveFrom: Ymd
  /** 학기 끝(미포함) — 새 차시 시작일이 이 날 이후면 만들지 않음 */
  termEnd: Ymd
  existing: HomeroomSeriesRecord[]
  desired: T[]
}): HomeroomSeriesPlan<T> {
  const E = input.effectiveFrom
  const byId = new Map<string, HomeroomSeriesRecord>()
  input.existing.forEach((r) => byId.set(r.s.seriesId, r))

  // 기본 변경 연결로 묶음 만들기(양쪽 링크 모두 — 한쪽만 남은 예전 자료도 이어지게)
  const parent = new Map<string, string>()
  byId.forEach((_, id) => parent.set(id, id))
  const find = (id: string): string => {
    let cur = id
    while (parent.get(cur) !== cur) cur = parent.get(cur)!
    return cur
  }
  const link = (a: string, b?: string | null) => {
    if (!b || !byId.has(b)) return
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  byId.forEach((r, id) => {
    link(id, r.replacesSeriesId)
    link(id, r.supersededBy)
  })
  const groups = new Map<string, LessonSeries[]>()
  Array.from(byId.keys())
    .sort()
    .forEach((id) => {
      const k = find(id)
      groups.set(k, (groups.get(k) || []).concat(byId.get(id)!.s))
    })

  interface Chain {
    members: LessonSeries[]
    /** 묶음 안에서 대체한 차시가 없는 것 = 학급 시간표에서 처음 만든 칸 */
    origins: LessonSeries[]
    /** 지금 이어지는(끝나는 날 없는) 차시 */
    tail: LessonSeries | null
  }
  const chains: Chain[] = []
  groups.forEach((members) => {
    if (!members.some((s) => s.sourceHomeroomId === input.classId)) return // 이 학급 차시가 아님
    const ids = new Set(members.map((s) => s.seriesId))
    const origins = members.filter((s) => {
      const p = byId.get(s.seriesId)?.replacesSeriesId
      return !p || !ids.has(p)
    })
    const open = members.filter((s) => seriesOpen(s) && !s.validTo).sort((a, b) => b.validFrom.localeCompare(a.validFrom))
    chains.push({ members, origins, tail: open[0] || null })
  })

  // 적용일 이후에도 열리는 이 학급 차시
  const live: LessonSeries[] = []
  const liveIds = new Set<string>()
  chains.forEach((c) =>
    c.members.forEach((s) => {
      if (seriesOpen(s) && (!s.validTo || s.validTo > E)) {
        live.push(s)
        liveIds.add(s.seriesId)
      }
    })
  )
  live.sort((a, b) => a.seriesId.localeCompare(b.seriesId))

  const keep = new Set<string>()
  const claimed = new Set<Chain>()
  const done = new Set<number>()
  let keptByChange = 0
  const moved = chains.filter((c) => c.members.length > 1 && c.tail)
  const claim = (c: Chain, i: number) => {
    claimed.add(c)
    done.add(i)
    keptByChange++
    c.members.forEach((s) => liveIds.has(s.seriesId) && keep.add(s.seriesId))
  }
  // 1) 기본 변경 뒤 '지금 칸'이 학급 시간표와 같음(담임이 학급 시간표도 맞춰 둠) — 먼저 짝지어 같은 칸을 새로 만들지 않게
  input.desired.forEach((d, i) => {
    const c = moved.find((x) => !claimed.has(x) && sameCell(x.tail!, d))
    if (c) claim(c, i)
  })
  // 2) '처음 만든 칸'이 학급 시간표에 그대로 있음 — 학급 시간표가 바뀐 칸이 아니므로 기본 변경으로 옮긴 차시 유지
  input.desired.forEach((d, i) => {
    if (done.has(i)) return
    const c = moved.find((x) => !claimed.has(x) && x.origins.some((o) => sameCell(o, d)))
    if (c) claim(c, i)
  })
  // 3) 그대로인 칸
  input.desired.forEach((d, i) => {
    if (done.has(i)) return
    const s = live.find((x) => !x.validTo && sameCell(x, d))
    if (s) {
      keep.add(s.seriesId)
      done.add(i)
    }
  })
  // 4) 바뀐 칸은 새 차시 — 유지하는 차시가 같은 칸을 정해진 날까지 맡고 있으면 그 다음 날부터(같은 칸 두 번 방지)
  const toCreate: Array<T & { validFrom: Ymd }> = []
  input.desired.forEach((d, i) => {
    if (done.has(i)) return
    let from = E
    live.forEach((s) => {
      if (keep.has(s.seriesId) && s.validTo && s.validFrom <= E && s.validTo > from && sameCell(s, d)) from = s.validTo
    })
    if (from < input.termEnd) toCreate.push({ ...d, validFrom: from })
  })
  return { keep, toCreate, toRetire: live.filter((s) => !keep.has(s.seriesId)), keptByChange }
}

// ───────────────────────── 수강생(서버) ─────────────────────────

interface StudentInfo {
  homeroom: string | null
  enrollments: Array<{ courseId: string; from: Ymd | null; to: Ymd | null }>
}

/** 대상 수업 학생들의 수강·소속 색인(학생 uid는 서버 메모리에서만) */
export interface MemberIndex {
  students: Map<string, StudentInfo>
}

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const ymdOrNull = (v: unknown): Ymd | null => (isYmd(v) ? v : null)

async function queryIn(col: CollectionReference, field: string, op: 'in' | 'array-contains-any', values: string[]): Promise<QueryDocumentSnapshot[]> {
  const parts = chunk(unique(values.filter((v) => typeof v === 'string' && v)), 30)
  const snaps = await Promise.all(parts.map((p) => col.where(field, op, p).get()))
  return snaps.reduce<QueryDocumentSnapshot[]>((acc, s) => acc.concat(s.docs), [])
}

async function getAllDocs(db: Firestore, refs: DocumentReference[]): Promise<DocumentSnapshot[]> {
  const parts = chunk(refs, 100)
  const snaps = await Promise.all(parts.map((p) => (p.length ? db.getAll(...p) : Promise.resolve([] as DocumentSnapshot[]))))
  return snaps.reduce<DocumentSnapshot[]>((acc, s) => acc.concat(s), [])
}

/**
 * 대상 수업의 학생(활성 수강 + 공통 수업으로 지정된 소속 학급의 승인 학생)과
 * 그 학생들의 모든 활성 수강·소속 학급을 읽습니다.
 */
export async function loadMemberIndex(db: Firestore, schoolCode: string, courses: Course[]): Promise<MemberIndex> {
  const sref = schoolRef(db, schoolCode)
  const students = new Map<string, StudentInfo>()
  const ensure = (uid: string) => {
    let s = students.get(uid)
    if (!s) {
      s = { homeroom: null, enrollments: [] }
      students.set(uid, s)
    }
    return s
  }
  const courseIds = courses.map((c) => c.courseId)
  const homerooms = unique(courses.reduce<string[]>((acc, c) => acc.concat(c.commonForHomerooms), []))
  const [enrolled, inHomerooms] = await Promise.all([
    queryIn(sref.collection('enrollments'), 'courseId', 'in', courseIds),
    homerooms.length ? queryIn(db.collection('users'), 'classId', 'in', homerooms) : Promise.resolve([] as QueryDocumentSnapshot[]),
  ])
  for (const d of enrolled) {
    const uid = d.get('uid')
    if (d.get('status') === 'active' && typeof uid === 'string') ensure(uid)
  }
  const knownUser = new Set<string>()
  for (const d of inHomerooms) {
    const u = d.data()
    if (u.role !== 'student' || u.schoolCode !== schoolCode) continue
    const h = homeroomOf(u)
    if (!h || h.isGroupLegacy) continue
    ensure(d.id).homeroom = h.classId
    knownUser.add(d.id)
  }
  const uids = Array.from(students.keys())
  if (!uids.length) return { students }
  const [allEnrollments, userSnaps] = await Promise.all([
    queryIn(sref.collection('enrollments'), 'uid', 'in', uids),
    getAllDocs(db, uids.filter((u) => !knownUser.has(u)).map((u) => db.collection('users').doc(u))),
  ])
  for (const d of allEnrollments) {
    const uid = d.get('uid')
    if (d.get('status') !== 'active' || typeof uid !== 'string' || !students.has(uid)) continue
    students.get(uid)!.enrollments.push({ courseId: String(d.get('courseId') || ''), from: ymdOrNull(d.get('from')), to: ymdOrNull(d.get('to')) })
  }
  for (const snap of userSnaps) {
    if (!snap.exists) continue
    const u = snap.data() || {}
    if (u.role !== 'student' || u.schoolCode !== schoolCode) continue
    const h = homeroomOf(u)
    if (h && !h.isGroupLegacy) ensure(snap.id).homeroom = h.classId
  }
  return { students }
}

/** 그 날짜에 수업을 듣는 학생(색인에 있는 학생 중) — 개인 시간표 엔진의 수강 판정과 같은 규칙 */
export function membersOn(idx: MemberIndex, course: Course, date: Ymd): Set<string> {
  const out = new Set<string>()
  if (!courseActiveOn(course, date)) return out
  idx.students.forEach((s, uid) => {
    const enrolled = s.enrollments.some((e) => e.courseId === course.courseId && inRange(date, e.from, e.to))
    const common = !!s.homeroom && course.commonForHomerooms.includes(s.homeroom)
    if (enrolled || common) out.add(uid)
  })
  return out
}

/** 수업별 영향 날짜 중 하루라도 그 수업을 듣는 학생 */
export function affectedStudents(idx: MemberIndex, courses: Course[], courseDates: Map<string, Set<Ymd>> | Record<string, Ymd[]>): Map<string, { courseIds: string[]; dates: Ymd[] }> {
  const out = new Map<string, { courseIds: string[]; dates: Ymd[] }>()
  for (const c of courses) {
    const raw = courseDates instanceof Map ? courseDates.get(c.courseId) : courseDates[c.courseId]
    const dates = raw ? Array.from(raw) : []
    for (const d of dates) {
      membersOn(idx, c, d).forEach((uid) => {
        const e = out.get(uid) || { courseIds: [], dates: [] }
        if (!e.courseIds.includes(c.courseId)) e.courseIds.push(c.courseId)
        if (!e.dates.includes(d)) e.dates.push(d)
        out.set(uid, e)
      })
    }
  }
  return out
}

/**
 * 학생 알림 묶음: 같은 수업 조합·같은 첫 날짜인 학생끼리 한 메시지(학생 이름 등 개인정보 없음).
 * 한 학생은 묶음당 1건만 받습니다(알림 id는 API가 sched_<changeSetId>로 고정).
 */
export function studentNotifyGroups(
  affected: Map<string, { courseIds: string[]; dates: Ymd[] }>,
  titles: Map<string, string>,
  scope: 'date' | 'base'
): Array<{ uids: string[]; title: string; body: string; url: string }> {
  const groups = new Map<string, { uids: string[]; title: string; body: string; url: string }>()
  affected.forEach((a, uid) => {
    const ids = a.courseIds.slice().sort()
    const first = a.dates.slice().sort()[0]
    const gkey = ids.join(',') + '|' + first
    let g = groups.get(gkey)
    if (!g) {
      const names = ids.map((id) => titles.get(id) || '수업')
      const subject = names.length > 1 ? `${names[0]} 외 ${names.length - 1}개 수업` : names[0]
      const body = scope === 'base' ? `${subject} 기본 시간표가 바뀌었어요 (${shortDate(first)}부터)` : `${subject} 일정이 바뀌었어요 (${shortDate(first)})`
      g = { uids: [], title: '시간표 변경', body, url: `${STUDENT_TIMETABLE_URL}?date=${first}` }
      groups.set(gkey, g)
    }
    g.uids.push(uid)
  })
  return Array.from(groups.values())
}

// ───────────────────────── 자료 읽기 ─────────────────────────

export function recordFromDoc(d: QueryDocumentSnapshot | DocumentSnapshot): OverrideRecord {
  const data = d.data() || {}
  return { o: overrideFromDoc(d.id, data), dates: strArr(data.dates).filter((x) => isYmd(x)) }
}

export async function loadCourses(db: Firestore, schoolCode: string, ids: string[]): Promise<Map<string, Course>> {
  const sref = schoolRef(db, schoolCode)
  const snaps = await getAllDocs(db, unique(ids).map((id) => sref.collection('courses').doc(id)))
  const out = new Map<string, Course>()
  for (const s of snaps) if (s.exists) out.set(s.id, courseFromDoc(s.id, s.data() || {}))
  return out
}

export async function loadSeriesForCourses(db: Firestore, schoolCode: string, courseIds: string[]): Promise<Map<string, LessonSeries>> {
  const docs = await queryIn(schoolRef(db, schoolCode).collection('series'), 'courseId', 'in', courseIds)
  return new Map(docs.map((d) => [d.id, seriesFromDoc(d.id, d.data())]))
}

export async function loadOverridesByKeys(db: Firestore, schoolCode: string, keys: string[]): Promise<OverrideRecord[]> {
  return (await queryIn(schoolRef(db, schoolCode).collection('overrides'), 'occurrenceKey', 'in', keys)).map(recordFromDoc)
}

export async function loadOverridesByCourses(db: Firestore, schoolCode: string, courseIds: string[]): Promise<OverrideRecord[]> {
  return (await queryIn(schoolRef(db, schoolCode).collection('overrides'), 'courseId', 'in', courseIds)).map(recordFromDoc)
}

async function loadOverridesByDates(db: Firestore, schoolCode: string, dates: Ymd[]): Promise<OverrideRecord[]> {
  return (await queryIn(schoolRef(db, schoolCode).collection('overrides'), 'dates', 'array-contains-any', dates)).map(recordFromDoc)
}

/**
 * 변경 후 담당 교사 계정 확인: teacherUids는 같은 학교 교사 계정이어야 함.
 * uid만 주면 이름을 계정에서 채우고, 이름만 주면(계정 없는 대체 강사 등) uid는 비웁니다 — 이전 교사 uid가 남아 충돌 검사가 틀리지 않게.
 */
export async function resolveTeacherPatches(db: Firestore, schoolCode: string, items: ChangeItem[]): Promise<void> {
  const patches: Array<SlotPatch | BasePatch> = []
  for (const it of items) {
    if (it.op === 'reschedule' || it.op === 'makeup') patches.push(it.target)
    else if (it.op === 'base') patches.push(it.patch)
  }
  const uids = unique(patches.reduce<string[]>((acc, p) => acc.concat(p.teacherUids ?? []), []))
  const names = new Map<string, string>()
  if (uids.length) {
    const snaps = await getAllDocs(db, uids.map((u) => db.collection('users').doc(u)))
    for (const s of snaps) {
      const u = s.exists ? s.data() || {} : null
      if (!u || u.role !== 'teacher' || u.schoolCode !== schoolCode) {
        bad('invalid-teacher', '변경 후 담당 교사는 같은 학교 교사 계정이어야 해요.')
      }
      names.set(s.id, cleanText(u.name || u.displayName || '', 30) || '선생님')
    }
  }
  for (const p of patches) {
    if (p.teacherUids !== undefined && p.teacherNames === undefined) p.teacherNames = p.teacherUids.map((u) => names.get(u) || '선생님')
    else if (p.teacherNames !== undefined && p.teacherUids === undefined) p.teacherUids = []
  }
}

// ───────────────────────── 계획 전체 ─────────────────────────

export interface ChangePlan {
  schoolCode: string
  mutationId: string
  changeSetId: string
  /** 계획을 세울 때 읽은 scheduleRevision */
  revision: number
  newRevision: number
  courses: Course[]
  ownedCourseIds: string[]
  notOwnedCourseIds: string[]
  /** 요청자가 담당이 아닌 수업의 담당 교사 → false (모두 담당이면 빈 객체) */
  approvals: Record<string, boolean>
  overrideDocs: Array<{ id: string; data: Record<string, unknown> }>
  seriesRetire: PlannedItems['seriesRetire']
  seriesCreate: PlannedItems['seriesCreate']
  changes: ChangePreview[]
  conflicts: ConflictEntry[]
  orphans: OrphanEntry[]
  affectedCourseIds: string[]
  affectedDates: Ymd[]
  courseDates: Record<string, Ymd[]>
  affectedStudentCount: number
}

export interface BuildPlanOptions {
  db: Firestore
  schoolCode: string
  requesterUid: string
  /** 미리보기는 임시 값('preview') — 결정적 id의 근거 */
  mutationId: string
  req: ChangeRequest
  /** 학교 시간대 오늘 */
  today: Ymd
  /** 학교 문서에 학교급이 없을 때 쓸 학교 이름(교사 users.schoolName) */
  schoolNameHint?: string
}

export async function buildChangePlan(o: BuildPlanOptions): Promise<ChangePlan> {
  const { db, schoolCode, req } = o
  const sref = schoolRef(db, schoolCode)
  const [schoolSnap, termsSnap] = await Promise.all([sref.get(), sref.collection('terms').get()])
  const revRaw = schoolSnap.exists ? Number(schoolSnap.get('scheduleRevision') || 0) : 0
  const revision = Number.isFinite(revRaw) ? revRaw : 0
  const termOf = makeTermResolver(termsSnap.docs.map((d) => ({ id: d.id, data: d.data() })))
  const periodTimes =
    defaultPeriodTimes(schoolSnap.exists ? schoolSnap.get('kind') : null) ||
    defaultPeriodTimes(schoolSnap.exists ? schoolSnap.get('name') : null) ||
    defaultPeriodTimes(o.schoolNameHint)

  // 1. 대상 수업
  const courseIds = unique(req.items.map((i) => i.courseId))
  const courses = await loadCourses(db, schoolCode, courseIds)
  for (const id of courseIds) {
    if (!courses.has(id)) throw new ChangeError(404, 'course-not-found', '수업을 찾을 수 없어요. 목록을 새로고침해 주세요.')
  }
  await resolveTeacherPatches(db, schoolCode, req.items)

  // 2. 대상 수업의 반복 차시 + 대상 차시 변경 이력
  const itemKeys = req.items.reduce<string[]>((acc, i) => (i.op === 'cancel' || i.op === 'restore' || i.op === 'reschedule' ? acc.concat(i.occurrenceKey) : acc), [])
  const [series, histRecords] = await Promise.all([
    loadSeriesForCourses(db, schoolCode, courseIds),
    itemKeys.length ? loadOverridesByKeys(db, schoolCode, itemKeys) : Promise.resolve([] as OverrideRecord[]),
  ])
  const histories = groupByKey(histRecords)

  // 3. 항목별 계획(검증 포함)
  const planned = planItems({ req, mutationId: o.mutationId, requesterUid: o.requesterUid, revision, courses, series, histories, termOf, today: o.today })
  const targetCourses = Array.from(courses.values())

  // 4. 영향 학생(수만)
  const idx = await loadMemberIndex(db, schoolCode, targetCourses)
  const affected = affectedStudents(idx, targetCourses, planned.courseDates)

  // 5. 충돌(최종 상태)
  const conflicts = planned.conflictDates.length
    ? await detectPlanConflicts(db, schoolCode, { planned, courses, histRecords, idx, periodTimes, termOf })
    : []

  // 6. 기본 변경으로 대상이 사라지는 기존 변경
  let orphans: OrphanEntry[] = []
  if (planned.baseItems.length) {
    const recs = await loadOverridesByCourses(db, schoolCode, unique(planned.baseItems.map((b) => b.courseId)))
    orphans = findBaseOrphans(recs, planned.baseItems, series, planned.seriesAfter)
  }

  // 7. 담당·승인
  // 담당 교사 또는 관리 교사(managerUids — 예: 공통 수업을 만든 담임)면 자기 수업
  const owned = targetCourses.filter((c) => isCourseTeacher(c, o.requesterUid))
  const notOwned = targetCourses.filter((c) => !isCourseTeacher(c, o.requesterUid))
  const approvals: Record<string, boolean> = {}
  for (const c of notOwned) {
    const others = courseManagerUids(c).filter((u) => u !== o.requesterUid)
    if (!others.length) throw new ChangeError(403, 'no-approver', `'${c.title}' 수업에 담당 교사 계정이 연결되어 있지 않아 승인을 요청할 수 없어요.`)
    others.forEach((u) => (approvals[u] = false))
  }

  const courseDates: Record<string, Ymd[]> = {}
  planned.courseDates.forEach((set, id) => (courseDates[id] = Array.from(set).sort()))
  const affectedDates = unique(Object.keys(courseDates).reduce<Ymd[]>((acc, id) => acc.concat(courseDates[id]), [])).sort()

  return {
    schoolCode,
    mutationId: o.mutationId,
    changeSetId: changeSetIdOf(o.mutationId),
    revision,
    newRevision: revision + 1,
    courses: targetCourses,
    ownedCourseIds: owned.map((c) => c.courseId),
    notOwnedCourseIds: notOwned.map((c) => c.courseId),
    approvals,
    overrideDocs: planned.overrideDocs,
    seriesRetire: planned.seriesRetire,
    seriesCreate: planned.seriesCreate,
    changes: planned.changes,
    conflicts,
    orphans,
    affectedCourseIds: courseIds,
    affectedDates,
    courseDates,
    affectedStudentCount: affected.size,
  }
}

/**
 * 충돌 후보 수업 찾기: 바뀐 차시의 최종 교사·교실을 쓰는 같은 학교 수업 + 그 날짜에 변경이 있는 수업
 * + 대상 수업 학생들이 듣는 수업. 그 수업들의 반복 차시·변경을 읽어 최종 상태로 검사합니다.
 */
async function detectPlanConflicts(
  db: Firestore,
  schoolCode: string,
  ctx: {
    planned: PlannedItems
    courses: Map<string, Course>
    histRecords: OverrideRecord[]
    idx: MemberIndex
    periodTimes?: PeriodTime[]
    termOf: (ymd: Ymd) => TermInfo
  }
): Promise<ConflictEntry[]> {
  const { planned, courses, idx } = ctx
  const dates = planned.conflictDates
  const sref = schoolRef(db, schoolCode)
  const targetCourses = Array.from(courses.values())
  const seriesAfter = Array.from(planned.seriesAfter.values())
  const own = occurrencesForDates(dates, targetCourses, seriesAfter, ctx.histRecords.map((r) => r.o).concat(planned.proposed)).filter((x) =>
    planned.changedKeys.has(x.key)
  )
  if (!own.length) return []

  const tUids = unique(own.reduce<string[]>((acc, x) => acc.concat(x.teacherUids ?? []), []))
  const tNames = unique(own.reduce<string[]>((acc, x) => (x.teacherUids?.length ? acc : acc.concat(x.teacherNames ?? [])), []))
  const roomIds = unique(own.map((x) => x.roomId || '').filter(Boolean))
  const roomNames = unique(own.map((x) => x.roomName || '').filter(Boolean))
  const homerooms = unique(Array.from(idx.students.values()).map((s) => s.homeroom || '').filter(Boolean))
  const courseCol = sref.collection('courses')
  const seriesCol = sref.collection('series')
  const none = Promise.resolve([] as QueryDocumentSnapshot[])

  const [c1, c2, c3, c4, c5, s1, s2, s3, s4, onDates] = await Promise.all([
    tUids.length ? queryIn(courseCol, 'teacherUids', 'array-contains-any', tUids) : none,
    tNames.length ? queryIn(courseCol, 'teacherNames', 'array-contains-any', tNames) : none,
    roomIds.length ? queryIn(courseCol, 'defaultRoomId', 'in', roomIds) : none,
    roomNames.length ? queryIn(courseCol, 'defaultRoomName', 'in', roomNames) : none,
    homerooms.length ? queryIn(courseCol, 'commonForHomerooms', 'array-contains-any', homerooms) : none,
    tUids.length ? queryIn(seriesCol, 'teacherUids', 'array-contains-any', tUids) : none,
    tNames.length ? queryIn(seriesCol, 'teacherNames', 'array-contains-any', tNames) : none,
    roomIds.length ? queryIn(seriesCol, 'roomId', 'in', roomIds) : none,
    roomNames.length ? queryIn(seriesCol, 'roomName', 'in', roomNames) : none,
    loadOverridesByDates(db, schoolCode, dates),
  ])

  const candidate = new Set<string>()
  for (const d of c1.concat(c2, c3, c4, c5)) candidate.add(d.id)
  for (const d of s1.concat(s2, s3, s4)) candidate.add(String(d.get('courseId') || ''))
  for (const r of onDates) candidate.add(r.o.courseId)
  idx.students.forEach((s) => s.enrollments.forEach((e) => candidate.add(e.courseId)))
  courses.forEach((_, id) => candidate.delete(id))
  candidate.delete('')

  // 같은 학기 수업만(지난 학기 수업의 열린 반복 차시와 엉뚱하게 겹치지 않게)
  const termIds = new Set(dates.map((d) => ctx.termOf(d).termId))
  const others = Array.from((await loadCourses(db, schoolCode, Array.from(candidate))).values()).filter((c) => !c.termId || termIds.has(c.termId))
  const otherIds = others.map((c) => c.courseId)

  const known = new Set(ctx.histRecords.map((r) => r.o.occurrenceKey))
  const extraKeys = unique(onDates.map((r) => r.o.occurrenceKey)).filter((k) => !known.has(k))
  const [otherSeries, extraHist] = await Promise.all([
    otherIds.length ? loadSeriesForCourses(db, schoolCode, otherIds) : Promise.resolve(new Map<string, LessonSeries>()),
    extraKeys.length ? loadOverridesByKeys(db, schoolCode, extraKeys) : Promise.resolve([] as OverrideRecord[]),
  ])

  const byId = new Map<string, Override>()
  for (const r of ctx.histRecords.concat(onDates, extraHist)) byId.set(r.o.overrideId, r.o)
  for (const p of planned.proposed) byId.set(p.overrideId, p)
  const allCourses = targetCourses.concat(others)
  const courseById = new Map(allCourses.map((c) => [c.courseId, c]))
  const memo = new Map<string, Set<string>>()
  const members = (courseId: string, date: Ymd) => {
    const k = courseId + '|' + date
    let m = memo.get(k)
    if (!m) {
      const c = courseById.get(courseId)
      m = c ? membersOn(idx, c, date) : new Set<string>()
      memo.set(k, m)
    }
    return m
  }

  return computeConflicts({
    dates,
    courses: allCourses,
    series: seriesAfter.concat(Array.from(otherSeries.values())),
    overrides: Array.from(byId.values()),
    changedKeys: planned.changedKeys,
    periodTimes: ctx.periodTimes,
    studentOverlap: (a, b, date) => {
      if (!courses.has(a) && !courses.has(b)) return 0
      const A = members(a, date)
      let n = 0
      members(b, date).forEach((u) => {
        if (A.has(u)) n++
      })
      return n
    },
  })
}
