/**
 * 교사용 공식 일정 변경 화면(/teacher/schedule-changes) 클라이언트 도우미
 *
 * - API 호출: /api/schedule-changes(preview·publish·approve·reject·list·orphans), /api/courses(list)
 *   로그인한 교사의 ID 토큰(Authorization: Bearer)으로 부르고, 실패는 응답 code로 구분합니다(빈 결과로 위장하지 않음).
 * - 차시 목록: 수업의 반복 차시(내 수업은 /api/courses list, 다른 선생님 수업은 Firestore) + 그 수업의 변경
 *   (Firestore schools/{s}/overrides where courseId ==)을 순수 엔진(engine.occurrencesForDates)으로 계산해
 *   그 날짜의 '현재' 상태(이미 옮겨진 것·취소된 것 포함)를 만듭니다.
 *
 * 서버 전용 모듈(server.ts·changes.ts·ids.ts·studentData.ts·firebase-admin)은 import하지 않습니다.
 * 응답 타입은 src/lib/timetable/changes.ts·src/pages/api/schedule-changes.ts의 실제 응답 모양을 그대로 옮겨 적었습니다.
 */
import { collection, doc, getDoc, getDocs, query, where, type Firestore } from 'firebase/firestore'
import { auth } from '../firebase'
import { isYmd } from './dates'
import {
  baseStateOf,
  courseActiveOn,
  diffSlots,
  effectiveOverrides,
  mergeTarget,
  occurrenceKeyOf,
  occurrencesForDates,
  parseOccurrenceKey,
  seriesOccursOn,
} from './engine'
import { periodRanges, schoolLevelOf } from '../periodTimes'
import type { ChangeField, Course, LessonSeries, Override, PeriodTime, SlotState, Weekday, Ymd } from './types'

// ───────────────────────── 응답 타입(서버 계약) ─────────────────────────

export type ChangeOp = 'cancel' | 'reschedule' | 'restore' | 'makeup' | 'base'

/** changes.ts ChangePreview — 미리보기·변경 묶음의 차시별 변경 전후 */
export interface ChangePreviewItem {
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
  fields: ChangeField[]
  seriesId?: string | null
  newSeriesId?: string | null
  effectiveFrom?: Ymd | null
}

/** changes.ts ConflictEntry — detail은 교사 이름·교실 이름·겹치는 학생 수('same-course'는 같은 수업 두 차시) */
export interface ConflictEntry {
  kind: 'teacher' | 'room' | 'students'
  a: string
  b: string
  detail: string
  possible?: boolean
  date: Ymd
  aCourseId: string
  bCourseId: string
  aTitle: string
  bTitle: string
  aPeriod: number
  bPeriod: number
}

/** changes.ts OrphanEntry — 대상 차시가 사라진 발행 변경(검토 필요) */
export interface OrphanEntry {
  overrideId: string
  courseId: string
  occurrenceKey: string
  kind: 'cancel' | 'reschedule' | 'makeup' | 'restore'
  originalDate: Ymd | null
  target: SlotState | null
  revision: number
  changeSetId: string
  reason: string | null
  suggestedOccurrenceKey: string | null
}

export interface PreviewResponse {
  changes: ChangePreviewItem[]
  affectedStudentCount: number
  conflicts: ConflictEntry[]
  orphans: OrphanEntry[]
  /** 미리보기 기준 scheduleRevision — 발행의 expectedRevision */
  revision: number
  /** 다른 교사 수업이 섞여 승인 요청이 됨 */
  requiresApproval: boolean
  approverUids: string[]
}

export type ChangeSetStatus = 'published' | 'pending-approval' | 'rejected'

/** schedule-changes.ts summary() — 발행·승인·거절·목록 응답의 변경 묶음 */
export interface ChangeSetSummary {
  changeSetId: string
  status: ChangeSetStatus
  scope: 'date' | 'base'
  reason: string
  revision: number | null
  basedOnRevision: number | null
  affectedCourseIds: string[]
  affectedDates: Ymd[]
  affectedStudentCount: number
  conflicts: ConflictEntry[]
  conflictsAcknowledged: boolean
  changes: ChangePreviewItem[]
  orphans: OrphanEntry[]
  approvals: Record<string, boolean>
  createdBy: string | null
  createdByName: string | null
  createdAt: number | null
  publishedAt: number | null
  rejectedBy: string | null
  rejectReason: string | null
  replayed?: boolean
  notified?: { created: number; skipped: number } | null
}

// ───────────────────────── 요청 타입 ─────────────────────────

/** 차시 상태 일부(빠진 값은 현재 상태 유지, null은 비움) */
export interface SlotPatchInput {
  date?: Ymd
  period?: number
  start?: string | null
  end?: string | null
  roomName?: string | null
  teacherNames?: string[]
  teacherUids?: string[]
}

export type ChangeItemInput =
  | { op: 'cancel' | 'restore'; courseId: string; occurrenceKey: string }
  | { op: 'reschedule'; courseId: string; occurrenceKey: string; target: SlotPatchInput }
  | { op: 'makeup'; courseId: string; target: SlotPatchInput & { date: Ymd; period: number } }
  | {
      op: 'base'
      courseId: string
      seriesId: string
      effectiveFrom: Ymd
      weekday?: Weekday
      period?: number
      start?: string | null
      end?: string | null
      roomName?: string | null
      teacherNames?: string[]
      teacherUids?: string[]
    }

export interface ChangeDraft {
  scope: 'date' | 'base'
  reason: string
  items: ChangeItemInput[]
}

// ───────────────────────── 오류 ─────────────────────────

/** API·Firestore 실패(화면은 code로 구분해 안내) */
export class ScheduleApiError extends Error {
  status: number
  code: string
  /** 응답의 나머지 필드(currentRevision, conflicts, changes 등) */
  body: Record<string, any>
  constructor(status: number, code: string, message: string, body: Record<string, any> = {}) {
    super(message)
    this.status = status
    this.code = code
    this.body = body
    Object.setPrototypeOf(this, ScheduleApiError.prototype)
  }
}

export function asScheduleError(e: unknown): ScheduleApiError {
  if (e instanceof ScheduleApiError) return e
  const code = (e as { code?: unknown })?.code
  // Firestore 클라이언트 오류(FirebaseError: 'permission-denied' 등)
  if (typeof code === 'string') {
    if (code === 'permission-denied' || code === 'firestore/permission-denied') {
      return new ScheduleApiError(403, 'permission-denied', '시간표 자료를 읽을 권한이 없어요.')
    }
    if (code === 'unavailable' || code === 'firestore/unavailable') {
      return new ScheduleApiError(0, 'network', '서버에 연결하지 못했어요.')
    }
    if (code === 'failed-precondition' || code === 'firestore/failed-precondition') {
      return new ScheduleApiError(500, 'index-required', '조회에 필요한 색인이 아직 준비되지 않았어요.')
    }
    return new ScheduleApiError(0, code.replace(/^firestore\//, ''), (e as Error)?.message || '알 수 없는 오류가 났어요.')
  }
  return new ScheduleApiError(0, 'client-error', (e as Error)?.message || '알 수 없는 오류가 났어요.')
}

export interface ErrorView {
  /** 화면 제목 문구 */
  title: string
  /** 서버가 준 자세한 설명(몇 번째 항목인지 등) — 제목과 같으면 없음 */
  detail: string | null
  /** 같은 요청을 다시 보내도 되는 오류(네트워크·서버 일시 오류) */
  retryable: boolean
  code: string
}

const ERROR_TITLES: Record<string, string> = {
  network: '서버에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.',
  unauthenticated: '로그인이 필요해요. 다시 로그인해 주세요.',
  'no-profile': '가입이 아직 끝나지 않았어요.',
  forbidden: '학생 계정으로는 공식 시간표를 바꿀 수 없어요.',
  'teacher-only': '선생님 계정만 할 수 있어요.',
  'no-school': '학교 등록을 먼저 마쳐 주세요.',
  'other-school': '다른 학교의 시간표는 볼 수도 바꿀 수도 없어요.',
  'not-course-teacher': '이 수업의 담당 선생님만 볼 수 있어요.',
  'no-approver': '담당 교사 계정이 연결되지 않은 수업이 있어 승인을 요청할 수 없어요.',
  'not-approver': '이 요청을 승인하거나 거절할 수 있는 담당 선생님이 아니에요.',
  'permission-denied': '시간표 자료를 읽을 권한이 없어요. 관리자에게 알려 주세요.',
  'stale-revision': '다른 변경이 먼저 발행됐어요. 최신 시간표로 다시 미리보기 해 주세요.',
  conflicts: '시간이 겹치는 수업이 있어요. 충돌 내용을 확인해 주세요.',
  'mutation-id-reused': '이 요청 번호는 이미 다른 내용에 쓰였어요. 다시 미리보기 한 뒤 발행해 주세요.',
  'invalid-request': '요청 형식이 올바르지 않아요. 화면을 새로고침한 뒤 다시 시도해 주세요.',
  'invalid-item': '변경 항목이 올바르지 않아요.',
  'invalid-slot': '교시·시각·날짜 값이 올바르지 않아요.',
  'invalid-teacher': '변경 후 담당 교사는 같은 학교 교사 계정이어야 해요.',
  'out-of-term': '수업의 학기 범위를 벗어난 날짜예요.',
  'course-ended': '종료된 수업이라 이 날짜에는 바꿀 수 없어요.',
  'past-effective-date': '기본 시간표 변경은 오늘 이후 날짜부터 적용할 수 있어요.',
  'effective-before-series': '적용 시작일이 이 반복 차시의 시작일보다 빨라요.',
  'series-ended': '이미 끝난 반복 차시예요.',
  'series-not-found': '반복 차시를 찾을 수 없어요. 목록을 새로고침해 주세요.',
  'occurrence-not-found': '그 날짜에는 이 수업 차시가 없어요. 시간표를 새로고침해 주세요.',
  'course-not-found': '수업을 찾을 수 없어요. 목록을 새로고침해 주세요.',
  'no-change': '지금 일정과 같아서 바꿀 내용이 없어요.',
  'nothing-to-restore': '이미 원래 일정이에요.',
  'duplicate-item': '같은 차시가 변경 목록에 두 번 들어 있어요.',
  'too-many-items': '한 번에 바꿀 수 있는 차시 수를 넘었어요. 나눠서 발행해 주세요.',
  'change-set-not-found': '변경 요청을 찾을 수 없어요.',
  'not-pending': '이미 처리된 변경 요청이에요.',
  'no-longer-valid': '요청 이후 시간표가 바뀌어 이 변경을 그대로 적용할 수 없어요.',
  'approvers-changed': '요청 이후 담당 교사가 바뀌었어요. 변경을 다시 요청해 주세요.',
  rejected: '이 변경 요청은 거절되었어요.',
  busy: '다른 변경이 동시에 처리되고 있어요. 잠시 후 다시 시도해 주세요.',
  'index-required': '변경 기록 조회에 필요한 색인이 아직 준비되지 않았어요. 관리자에게 알려 주세요.',
  internal: '서버 오류가 났어요. 잠시 후 다시 시도해 주세요.',
  'server-error': '서버 오류가 났어요. 잠시 후 다시 시도해 주세요.',
  'not-configured': '서버 설정이 없어요. 관리자에게 문의해 주세요.',
}

/** 오류 → 화면 문구. 모르는 code도 '빈 결과'가 아니라 오류로 보여 줍니다 */
export function describeError(e: unknown): ErrorView {
  const f = asScheduleError(e)
  const known = ERROR_TITLES[f.code]
  const retryable = f.code === 'network' || f.code === 'busy' || f.status >= 500 || f.status === 0
  const title = known || (f.status >= 500 ? `서버 오류가 났어요 (오류 코드 ${f.code}).` : f.message || `요청을 처리하지 못했어요 (오류 코드 ${f.code}).`)
  const detail = known && f.message && !title.includes(f.message.replace(/[.\s]+$/, '')) ? f.message : null
  return { title, detail, retryable, code: f.code }
}

// ───────────────────────── API 호출 ─────────────────────────

async function postJson(path: string, body: Record<string, unknown>): Promise<{ status: number; data: Record<string, any> }> {
  const u = auth?.currentUser
  if (!u) throw new ScheduleApiError(401, 'unauthenticated', '로그인이 필요해요. 다시 로그인해 주세요.')
  const token = await u.getIdToken()
  let resp: Response
  try {
    resp = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
  } catch {
    throw new ScheduleApiError(0, 'network', '서버에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.')
  }
  const data = (await resp.json().catch(() => null)) as Record<string, any> | null
  if (!resp.ok) {
    const json = data && typeof data === 'object' ? data : {}
    throw new ScheduleApiError(
      resp.status,
      typeof json.code === 'string' ? json.code : `http-${resp.status}`,
      typeof json.error === 'string' ? json.error : `요청에 실패했어요 (HTTP ${resp.status})`,
      json
    )
  }
  if (!data || typeof data !== 'object') throw new ScheduleApiError(resp.status, 'bad-response', '서버 응답을 읽지 못했어요.')
  return { status: resp.status, data }
}

const SC_PATH = '/api/schedule-changes'

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

function normalizePreview(d: Record<string, any>): PreviewResponse {
  return {
    changes: arr<ChangePreviewItem>(d.changes),
    affectedStudentCount: Number(d.affectedStudentCount) || 0,
    conflicts: arr<ConflictEntry>(d.conflicts),
    orphans: arr<OrphanEntry>(d.orphans),
    revision: Number(d.revision) || 0,
    requiresApproval: d.requiresApproval === true,
    approverUids: arr<string>(d.approverUids),
  }
}

function normalizeSummary(d: Record<string, any>): ChangeSetSummary {
  return {
    changeSetId: String(d.changeSetId || ''),
    status: d.status === 'pending-approval' || d.status === 'rejected' ? d.status : 'published',
    scope: d.scope === 'base' ? 'base' : 'date',
    reason: String(d.reason || ''),
    revision: typeof d.revision === 'number' ? d.revision : null,
    basedOnRevision: typeof d.basedOnRevision === 'number' ? d.basedOnRevision : null,
    affectedCourseIds: arr<string>(d.affectedCourseIds),
    affectedDates: arr<Ymd>(d.affectedDates),
    affectedStudentCount: Number(d.affectedStudentCount) || 0,
    conflicts: arr<ConflictEntry>(d.conflicts),
    conflictsAcknowledged: d.conflictsAcknowledged === true,
    changes: arr<ChangePreviewItem>(d.changes),
    orphans: arr<OrphanEntry>(d.orphans),
    approvals: d.approvals && typeof d.approvals === 'object' ? d.approvals : {},
    createdBy: typeof d.createdBy === 'string' ? d.createdBy : null,
    createdByName: typeof d.createdByName === 'string' ? d.createdByName : null,
    createdAt: typeof d.createdAt === 'number' ? d.createdAt : null,
    publishedAt: typeof d.publishedAt === 'number' ? d.publishedAt : null,
    rejectedBy: typeof d.rejectedBy === 'string' ? d.rejectedBy : null,
    rejectReason: typeof d.rejectReason === 'string' ? d.rejectReason : null,
    replayed: d.replayed === true,
    notified: d.notified && typeof d.notified === 'object' ? d.notified : null,
  }
}

/** 미리보기(쓰지 않음). expectedRevision을 주지 않아 '지금' 시간표 기준으로 계산하고 그 revision을 돌려받습니다 */
export async function previewChanges(draft: ChangeDraft): Promise<PreviewResponse> {
  const { data } = await postJson(SC_PATH, { action: 'preview', scope: draft.scope, reason: draft.reason, items: draft.items })
  return normalizePreview(data)
}

/**
 * 발행. 200 = 발행됨, 202 = 승인 대기(다른 교사 수업 포함).
 * 같은 mutationId 재전송은 저장된 결과를 그대로 돌려받습니다(네트워크 실패 후 다시 눌러도 같은 결과).
 * requestHash는 scope·reason·items만으로 만들어지므로 acknowledgeConflicts만 바꿔 같은 mutationId로 다시 보내도 됩니다.
 */
export async function publishChanges(
  draft: ChangeDraft,
  opts: { mutationId: string; expectedRevision: number; acknowledgeConflicts: boolean }
): Promise<{ status: number; result: ChangeSetSummary }> {
  const { status, data } = await postJson(SC_PATH, {
    action: 'publish',
    scope: draft.scope,
    reason: draft.reason,
    items: draft.items,
    mutationId: opts.mutationId,
    expectedRevision: opts.expectedRevision,
    acknowledgeConflicts: opts.acknowledgeConflicts,
  })
  return { status, result: normalizeSummary(data) }
}

export async function approveChangeSet(changeSetId: string, acknowledgeConflicts = false): Promise<{ status: number; result: ChangeSetSummary }> {
  const { status, data } = await postJson(SC_PATH, { action: 'approve', changeSetId, ...(acknowledgeConflicts ? { acknowledgeConflicts: true } : {}) })
  return { status, result: normalizeSummary(data) }
}

export async function rejectChangeSet(changeSetId: string, reason: string): Promise<ChangeSetSummary> {
  const { data } = await postJson(SC_PATH, { action: 'reject', changeSetId, reason })
  return normalizeSummary(data)
}

/** 내 승인을 기다리는 요청(최근 50개) */
export async function listAwaitingMe(): Promise<ChangeSetSummary[]> {
  const { data } = await postJson(SC_PATH, { action: 'list', awaitingMe: true })
  return arr<Record<string, any>>(data.changeSets).map(normalizeSummary)
}

/** 수업별 변경 이력(최근 50개, 담당 교사만) */
export async function listCourseHistory(courseId: string): Promise<ChangeSetSummary[]> {
  const { data } = await postJson(SC_PATH, { action: 'list', courseId })
  return arr<Record<string, any>>(data.changeSets).map(normalizeSummary)
}

/** 검토 필요(대상 차시가 사라진 발행 변경) */
export async function listOrphans(courseId: string): Promise<OrphanEntry[]> {
  const { data } = await postJson(SC_PATH, { action: 'orphans', courseId })
  return arr<OrphanEntry>(data.orphans)
}

// ───────────────────────── 수업·차시 자료 ─────────────────────────

/** 화면에서 쓰는 수업(내 수업은 /api/courses list, 다른 선생님 수업은 Firestore) */
export interface TeacherCourse {
  course: Course
  /** 내가 담당·관리하는 수업인지(아니면 발행 시 승인 요청) */
  canManage: boolean
  /** 내 수업 목록에서 온 수업인지 */
  mine: boolean
  series: LessonSeries[]
}

export interface MyCoursesResult {
  termId: string | null
  courses: TeacherCourse[]
  revision: number
}

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const ymdOrNull = (v: unknown): Ymd | null => (isYmd(v) ? v : null)

export function courseFromData(id: string, d: Record<string, any>): Course {
  return {
    courseId: id,
    schoolCode: String(d.schoolCode || ''),
    termId: String(d.termId || ''),
    title: String(d.title || d.subject || '수업'),
    subject: String(d.subject || ''),
    section: d.section ? String(d.section) : undefined,
    teacherUids: strArr(d.teacherUids),
    teacherNames: strArr(d.teacherNames),
    ...(strArr(d.managerUids).length ? { managerUids: strArr(d.managerUids) } : {}),
    status: d.status === 'ended' ? 'ended' : 'active',
    endedOn: ymdOrNull(d.endedOn),
    commonForHomerooms: strArr(d.commonForHomerooms),
    defaultRoomId: d.defaultRoomId ? String(d.defaultRoomId) : null,
    defaultRoomName: d.defaultRoomName ? String(d.defaultRoomName) : null,
  }
}

export function seriesFromData(id: string, d: Record<string, any>): LessonSeries {
  return {
    seriesId: id,
    courseId: String(d.courseId || ''),
    weekday: Math.min(7, Math.max(1, Number(d.weekday) || 1)) as Weekday,
    period: Number(d.period) || 0,
    start: d.start ? String(d.start) : null,
    end: d.end ? String(d.end) : null,
    roomId: d.roomId ? String(d.roomId) : null,
    roomName: d.roomName ? String(d.roomName) : null,
    teacherNames: strArr(d.teacherNames),
    teacherUids: strArr(d.teacherUids),
    validFrom: ymdOrNull(d.validFrom) || '19700101',
    validTo: ymdOrNull(d.validTo),
    status: d.status === 'retired' ? 'retired' : 'active',
  }
}

function slotFromData(t: any): SlotState | null {
  if (!t || !isYmd(t.date)) return null
  const s: SlotState = { date: t.date, period: Number(t.period) || 0 }
  if ('start' in t) s.start = t.start ?? null
  if ('end' in t) s.end = t.end ?? null
  if ('roomId' in t) s.roomId = t.roomId ?? null
  if ('roomName' in t) s.roomName = t.roomName ?? null
  if ('teacherNames' in t) s.teacherNames = strArr(t.teacherNames)
  if ('teacherUids' in t) s.teacherUids = strArr(t.teacherUids)
  return s
}

/** server.ts overrideFromDoc과 같은 규칙: 'published'로 명시된 것만 적용 */
export function overrideFromData(id: string, d: Record<string, any>): Override {
  const kindOk = ['cancel', 'reschedule', 'makeup', 'restore'].includes(d.kind)
  const changeSetKeys = strArr(d.changeSetKeys).filter((k) => k.includes('|'))
  const publishedAt = d.publishedAt && typeof d.publishedAt.toMillis === 'function' ? d.publishedAt.toMillis() : null
  return {
    overrideId: id,
    courseId: String(d.courseId || ''),
    occurrenceKey: String(d.occurrenceKey || ''),
    changeSetId: String(d.changeSetId || ''),
    ...(changeSetKeys.length ? { changeSetKeys } : {}),
    kind: kindOk ? d.kind : 'reschedule',
    seriesId: d.seriesId ? String(d.seriesId) : null,
    originalDate: ymdOrNull(d.originalDate),
    target: slotFromData(d.target),
    reason: d.reason ? String(d.reason) : undefined,
    revision: Number(d.revision) || 0,
    status: d.status === 'published' && kindOk ? 'published' : 'withdrawn',
    publishedAt,
  }
}

/** 실제로 열리는 반복 차시인지(삭제된 것·빈 기간 제외) */
function seriesAlive(s: LessonSeries): boolean {
  if (s.status === 'retired' && !s.validTo) return false
  return !s.validTo || s.validTo > s.validFrom
}

/**
 * 내 수업(담당·관리 + 담임 학급 공통 수업)과 반복 차시. /api/courses list가 차시를 함께 주므로 한 번에 받습니다
 * ('get'은 승인 대기 학생 명단까지 내려주므로 이 화면에서는 쓰지 않음 — 학생 명단을 이 화면으로 가져오지 않기 위해).
 */
export async function listMyCourses(termId?: string): Promise<MyCoursesResult> {
  const { data } = await postJson('/api/courses', { action: 'list', ...(termId ? { termId } : {}) })
  const courses = arr<Record<string, any>>(data.courses).map((c) => ({
    course: courseFromData(String(c.courseId || ''), c),
    canManage: c.canManage === true,
    mine: true,
    series: arr<Record<string, any>>(c.series)
      .map((s) => seriesFromData(String(s.seriesId || ''), s))
      .filter(seriesAlive),
  }))
  return { termId: typeof data.termId === 'string' ? data.termId : null, courses, revision: Number(data.revision) || 0 }
}

/** 같은 학교 수업 목록(교시 교환 상대 찾기) — Firestore 읽기(같은 학교 교사 읽기 규칙 필요) */
export async function loadSchoolCourses(db: Firestore, schoolCode: string, termId: string | null): Promise<Course[]> {
  const col = collection(db, 'schools', schoolCode, 'courses')
  const snap = await getDocs(termId ? query(col, where('termId', '==', termId)) : col)
  return snap.docs
    .map((d) => courseFromData(d.id, d.data() || {}))
    .filter((c) => c.status === 'active')
    .sort((a, b) => a.title.localeCompare(b.title, 'ko'))
}

/** 다른 선생님 수업의 반복 차시(Firestore) */
export async function loadSeries(db: Firestore, schoolCode: string, courseId: string): Promise<LessonSeries[]> {
  const snap = await getDocs(query(collection(db, 'schools', schoolCode, 'series'), where('courseId', '==', courseId)))
  return snap.docs.map((d) => seriesFromData(d.id, d.data() || {})).filter(seriesAlive)
}

/** 수업의 변경(이력 포함 — 엔진이 차시별 최신 revision만 적용) */
export async function loadOverrides(db: Firestore, schoolCode: string, courseId: string): Promise<Override[]> {
  const snap = await getDocs(query(collection(db, 'schools', schoolCode, 'overrides'), where('courseId', '==', courseId)))
  return snap.docs.map((d) => overrideFromData(d.id, d.data() || {}))
}

/** 승인 요청 바로 열기(?changeSetId=)에서 내 승인 대상이 아닐 때 상태만 확인 */
export async function loadChangeSet(db: Firestore, schoolCode: string, changeSetId: string): Promise<ChangeSetSummary | null> {
  const snap = await getDoc(doc(db, 'schools', schoolCode, 'changeSets', changeSetId))
  if (!snap.exists()) return null
  const d = snap.data() || {}
  const toMs = (v: any): number | null => (v && typeof v.toMillis === 'function' ? v.toMillis() : null)
  return normalizeSummary({ ...d, changeSetId: snap.id, createdAt: toMs(d.createdAt), publishedAt: toMs(d.publishedAt) })
}

/** 같은 학교 교사 계정(교사 변경 선택용 — 이름과 계정만 씀) */
export async function loadSchoolTeachers(db: Firestore, schoolCode: string): Promise<Array<{ uid: string; name: string }>> {
  const snap = await getDocs(query(collection(db, 'users'), where('schoolCode', '==', schoolCode), where('role', '==', 'teacher')))
  return snap.docs
    .map((d) => {
      const v = d.data() || {}
      return { uid: d.id, name: String(v.name || v.displayName || '').trim() }
    })
    .filter((t) => t.name)
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
}

// ───────────────────────── 그 날짜의 차시(현재 상태) ─────────────────────────

export type OccurrenceStatus = 'normal' | 'changed' | 'moved-in' | 'makeup' | 'cancelled' | 'moved-out'

export interface OccurrenceView {
  /** 화면 key(내부용 — 표시하지 않음) */
  key: string
  courseId: string
  title: string
  occurrenceKey: string
  /** 반복 차시면 그 id(기본 시간표 변경용), 보강이면 null */
  seriesId: string | null
  originalDate: Ymd | null
  status: OccurrenceStatus
  /** 지금 상태 — 취소면 원래 상태, 다른 날로 옮겨졌으면 옮겨 간 상태 */
  state: SlotState
  /** 원래(기본) 상태 — 보강이면 첫 보강 상태 */
  base: SlotState | null
  /** 원래 상태와 비교해 달라진 항목 */
  fields: ChangeField[]
  /** 발행된 변경이 있어 '원래대로'를 할 수 있는지 */
  canRestore: boolean
  canManage: boolean
  /** 변경 사유(있으면) */
  reason: string | null
}

const gk = (courseId: string, key: string) => `${courseId}|${key}`

/** 보강 차시의 기준 상태 = 그 차시의 첫(가장 작은 revision) 보강 발행 (engine makeupBases와 같은 규칙) */
function makeupBaseOf(overrides: Override[], courseId: string, key: string): SlotState | null {
  let first: Override | null = null
  for (const o of overrides) {
    if (o.status !== 'published' || o.kind !== 'makeup' || !o.target || o.courseId !== courseId || o.occurrenceKey !== key) continue
    if (!first || o.revision < first.revision || (o.revision === first.revision && o.overrideId < first.overrideId)) first = o
  }
  return first && first.target ? mergeTarget(null, first.target) : null
}

/**
 * 선택한 수업들의 그 날짜 차시. 엔진(occurrencesForDates)으로 '지금' 열리는 차시를 구하고,
 * 그 날짜가 원래 날짜인데 취소됐거나 다른 날로 옮겨진 차시도 함께 돌려줍니다(원래대로·다시 옮기기용).
 * 학교 쉬는 날(NEIS)은 여기서 판단하지 않습니다 — 교사가 쉬는 날에도 보강·이동을 지정할 수 있게.
 */
export function occurrencesOn(date: Ymd, list: Array<TeacherCourse & { overrides: Override[] }>): OccurrenceView[] {
  const courses = list.map((x) => x.course)
  const courseById = new Map(courses.map((c) => [c.courseId, c]))
  const manage = new Map(list.map((x) => [x.course.courseId, x.canManage]))
  const series: LessonSeries[] = []
  const overrides: Override[] = []
  list.forEach((x) => {
    x.series.forEach((s) => series.push(s))
    x.overrides.forEach((o) => overrides.push(o))
  })
  const seriesById = new Map(series.map((s) => [s.seriesId, s]))
  const eff = effectiveOverrides(overrides)
  const out: OccurrenceView[] = []
  const seen = new Set<string>()

  const baseOf = (courseId: string, key: string): SlotState | null => {
    if (key.startsWith('mk:')) return makeupBaseOf(overrides, courseId, key)
    const p = parseOccurrenceKey(key)
    const s = p ? seriesById.get(p.seriesId) : undefined
    return p && s ? baseStateOf(s, p.originalDate, courseById.get(courseId)) : null
  }
  const push = (courseId: string, key: string, status: OccurrenceStatus, state: SlotState, base: SlotState | null) => {
    const k = gk(courseId, key)
    if (seen.has(k)) return
    seen.add(k)
    const o = eff.get(k)
    const p = parseOccurrenceKey(key)
    const isMk = key.startsWith('mk:')
    const fields = base && status !== 'cancelled' ? diffSlots(base, state) : []
    out.push({
      key: k,
      courseId,
      title: courseById.get(courseId)?.title || '수업',
      occurrenceKey: key,
      seriesId: p ? p.seriesId : null,
      originalDate: p ? p.originalDate : isMk && base ? base.date : null,
      status,
      state,
      base,
      fields,
      canRestore: !!o && o.kind !== 'restore' && !(isMk && o.kind === 'makeup' && !fields.length),
      canManage: manage.get(courseId) === true,
      reason: o && o.kind !== 'restore' && o.reason ? o.reason : null,
    })
  }

  // 1. 지금 그 날짜에 열리는 차시(옮겨 온 것·보강 포함)
  for (const occ of occurrencesForDates([date], courses, series, overrides)) {
    const state: SlotState = {
      date: occ.date,
      period: occ.period,
      start: occ.start ?? null,
      end: occ.end ?? null,
      roomId: occ.roomId ?? null,
      roomName: occ.roomName ?? null,
      teacherNames: occ.teacherNames ?? [],
      teacherUids: occ.teacherUids ?? [],
    }
    const base = baseOf(occ.courseId, occ.key)
    const p = parseOccurrenceKey(occ.key)
    let status: OccurrenceStatus = 'normal'
    if (occ.key.startsWith('mk:')) status = 'makeup'
    else if (p && p.originalDate !== date) status = 'moved-in'
    else if (base && diffSlots(base, state).length) status = 'changed'
    push(occ.courseId, occ.key, status, state, base)
  }

  // 2. 원래 이 날짜인데 취소됐거나 다른 날로 옮겨진 반복 차시
  for (const s of series) {
    const course = courseById.get(s.courseId)
    if (!course || !courseActiveOn(course, date) || !seriesOccursOn(s, date)) continue
    const key = occurrenceKeyOf(s.seriesId, date)
    if (seen.has(gk(s.courseId, key))) continue
    const o = eff.get(gk(s.courseId, key))
    const base = baseStateOf(s, date, course)
    if (o && o.kind === 'cancel') push(s.courseId, key, 'cancelled', base, base)
    else if (o && o.kind === 'reschedule' && o.target) {
      const after = mergeTarget(base, o.target)
      if (after.date !== date) push(s.courseId, key, 'moved-out', after, base)
    }
  }

  // 3. 이 날짜에 잡혔던 보강이 취소됐거나 다른 날로 옮겨진 경우
  eff.forEach((o, k) => {
    if (seen.has(k) || !o.occurrenceKey.startsWith('mk:') || !courseById.has(o.courseId)) return
    const base = makeupBaseOf(overrides, o.courseId, o.occurrenceKey)
    if (!base || base.date !== date) return
    if (o.kind === 'cancel') push(o.courseId, o.occurrenceKey, 'cancelled', base, base)
    else if (o.kind === 'reschedule' && o.target) {
      const after = mergeTarget(base, o.target)
      if (after.date !== date) push(o.courseId, o.occurrenceKey, 'moved-out', after, base)
    }
  })

  const sortKey = (v: OccurrenceView) => (v.status === 'moved-out' || v.status === 'cancelled' ? v.base?.period ?? v.state.period : v.state.period)
  return out.sort(
    (a, b) =>
      sortKey(a) - sortKey(b) ||
      (a.state.start || '').localeCompare(b.state.start || '') ||
      a.title.localeCompare(b.title, 'ko') ||
      a.key.localeCompare(b.key)
  )
}

// ───────────────────────── 표시 도우미 ─────────────────────────

const pad = (n: number) => String(n).padStart(2, '0')

/** 학교급 기본 교시 시각(서버 changes.defaultPeriodTimes와 같은 규칙 — 학교급을 알 때만) */
export function defaultPeriodTimesFor(schoolName: unknown): PeriodTime[] | undefined {
  const n = typeof schoolName === 'string' ? schoolName.trim() : ''
  if (!/(고등학교|중학교|초등학교)$/.test(n)) return undefined
  return periodRanges(schoolLevelOf(n)).map(([s, e], i) => ({
    period: i + 1,
    start: `${pad(Math.floor(s / 60))}:${pad(s % 60)}`,
    end: `${pad(Math.floor(e / 60))}:${pad(e % 60)}`,
  }))
}

/** 차시 시각 'HH:MM–HH:MM' (명시 시각 → 교시표). 모르면 null */
export function slotTimeText(slot: { period: number; start?: string | null; end?: string | null }, periodTimes?: PeriodTime[]): string | null {
  const pt = periodTimes?.find((p) => p.period === slot.period)
  const start = slot.start || pt?.start || null
  const end = slot.end || pt?.end || null
  if (!start) return null
  return end ? `${start}–${end}` : `${start}부터`
}

export const WEEKDAY_NAMES = ['', '월', '화', '수', '목', '금', '토', '일']

/** 재전송 안전용 요청 id(^[A-Za-z0-9_-]{6,100}$) */
export function newMutationId(): string {
  const c: Crypto | undefined = typeof globalThis !== 'undefined' ? (globalThis as { crypto?: Crypto }).crypto : undefined
  if (c && typeof c.randomUUID === 'function') return 'sc-' + c.randomUUID()
  const bytes = new Uint8Array(16)
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return 'sc-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
