/**
 * 교사 수업 관리 화면(/teacher/courses, /teacher/courses/[id], 초대 패널) 클라이언트 도우미
 *
 * - API 래퍼: /api/courses, /api/enrollments, /api/invitations, /api/schedule-changes(list·orphans)
 *   로그인한 교사의 ID 토큰(Authorization: Bearer)으로 부르고, 실패는 응답 code로 구분해 한국어 문구로 바꿉니다.
 *   원인을 모르는 실패(네트워크·5xx·429)는 retryable — 화면은 '다시 시도'를 보여 주고 빈 결과로 위장하지 않습니다.
 * - Firestore 직접 읽기(같은 학교 교사 읽기 규칙): 담임 반 '공통 수업 후보'(courses.importCommon), 예전 수업 그룹과 연결된 수업.
 * - 표시 도우미: 요일·교시 요약, 학기·날짜·학급 이름.
 *
 * 서버 전용 모듈(server.ts·ids.ts·changes.ts·studentData.ts·invitations.ts·firebase-admin)은 import하지 않습니다.
 * 응답 타입은 src/pages/api/{courses,enrollments,invitations,schedule-changes}.ts의 실제 응답 모양을 옮겨 적었습니다.
 * 초대 코드·토큰은 콘솔에 남기지 않습니다.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/router'
import { onAuthStateChanged } from 'firebase/auth'
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore'
import { auth, db } from '../firebase'
import { useUI } from '../../components/ui/feedback'
import { formatYmdKo, isYmd, schoolYmdAt } from './dates'
import type { ChangeField, Course, EnrollmentSource, EnrollmentStatus, LessonSeries, SlotState, Weekday, Ymd } from './types'

// ───────────────────────── 오류 ─────────────────────────

export type ApiErrorKind = 'network' | 'auth' | 'forbidden' | 'not-found' | 'invalid' | 'conflict' | 'gone' | 'rate-limited' | 'server'

export class TeacherApiError extends Error {
  status: number
  code: string
  kind: ApiErrorKind
  /** 원인을 모르는 실패(네트워크·5xx·429) — '다시 시도'를 보여 줌 */
  retryable: boolean
  /** 서버 응답의 추가 필드(conflicts 등) */
  extra: Record<string, any>

  constructor(status: number, code: string, message: string, extra: Record<string, any> = {}) {
    super(message)
    this.name = 'TeacherApiError'
    this.status = status
    this.code = code
    this.extra = extra
    this.kind = kindOf(status, code)
    this.retryable = this.kind === 'network' || this.kind === 'server' || this.kind === 'rate-limited'
  }
}

function kindOf(status: number, code: string): ApiErrorKind {
  if (code === 'network' || status === 0) return 'network'
  if (status === 401) return 'auth'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not-found'
  if (status === 410) return 'gone'
  if (status === 429) return 'rate-limited'
  if (status === 409) return 'conflict'
  if (status >= 500) return 'server'
  return 'invalid'
}

/**
 * 화면 문구로 고정할 코드(서버 문구보다 행동 안내가 필요한 것).
 * 여기 없는 코드는 서버가 보낸 한국어 문구(필드·날짜가 들어 있음)를 그대로 씁니다.
 */
const CODE_MESSAGES: Record<string, string> = {
  network: '서버에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.',
  unauthenticated: '로그인이 필요해요. 다시 로그인해 주세요.',
  'no-profile': '계정 정보가 없어요. 가입을 먼저 마쳐 주세요.',
  'teacher-only': '선생님 계정만 할 수 있어요.',
  forbidden: '선생님 계정만 할 수 있어요.',
  'no-school': '학교 정보가 없어요. 내 정보에서 학교를 먼저 확인해 주세요.',
  'other-school': '다른 학교의 수업은 볼 수도 바꿀 수도 없어요.',
  'course-not-found': '수업을 찾을 수 없어요. 우리 학교 수업이 아니거나 이미 지워진 수업일 수 있어요.',
  'not-course-teacher': '이 수업의 담당·관리 선생님만 할 수 있어요.',
  'not-homeroom-teacher': '그 학급 담임 선생님만 할 수 있어요.',
  'class-not-found': '학급을 찾을 수 없어요.',
  'group-not-homeroom': '수업 그룹은 소속 학급이 아니라서 공통 수업을 만들 수 없어요.',
  'no-class-timetable': '학급 시간표가 비어 있어요. 학급 시간표를 먼저 올려 주세요.',
  'course-ended': '이미 끝난 수업이에요.',
  'duplicate-series': '같은 요일·교시에 이미 이 수업 차시가 있어요.',
  'series-not-found': '차시를 찾을 수 없어요. 화면을 새로고침해 주세요.',
  conflicts: '다른 수업과 시간이 겹쳐요. 아래 내용을 확인해 주세요.',
  'enrollment-not-found': '이 학생의 수강 정보가 없어요. 목록을 새로고침해 주세요.',
  'not-pending': '이미 처리된 신청이에요. 목록을 새로고침해 주세요.',
  'student-not-found': '같은 학교 학생 계정만 수업에 추가할 수 있어요.',
  'target-not-found': '초대 대상을 찾을 수 없어요.',
  'not-homeroom': '수업 그룹은 학급 초대를 만들 수 없어요. 수업 관리에서 수업 초대를 만들어 주세요.',
  'not-invite-owner': '초대를 만든 선생님이나 대상 담당 선생님만 회수할 수 있어요.',
  'not-found': '초대 코드를 찾을 수 없어요.',
  'code-collision': '초대 코드를 만들지 못했어요. 다시 시도해 주세요.',
  'nothing-to-update': '바뀐 내용이 없어요.',
  'index-required': '목록 조회에 필요한 색인이 아직 준비되지 않았어요. 관리자에게 알려 주세요.',
  'rate-limited': '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.',
  'not-configured': '서버 설정이 없어요. 관리자에게 문의해 주세요.',
  'server-error': '서버에서 처리하지 못했어요. 잠시 후 다시 시도해 주세요.',
  internal: '서버에서 처리하지 못했어요. 잠시 후 다시 시도해 주세요.',
  'permission-denied': '이 자료를 읽을 권한이 없어요(학교 보안 규칙 확인 필요).',
}

function messageFor(status: number, code: string, serverMessage: string): string {
  if (CODE_MESSAGES[code]) return CODE_MESSAGES[code]
  if (serverMessage) return serverMessage
  if (status === 0) return CODE_MESSAGES.network
  if (status >= 500) return `서버 오류가 났어요 (HTTP ${status}). 잠시 후 다시 시도해 주세요.`
  if (status === 403) return '권한이 없어요.'
  if (status === 404) return '찾을 수 없어요.'
  return `요청을 처리하지 못했어요 (HTTP ${status}).`
}

/** 알 수 없는 오류 → TeacherApiError (화면은 항상 이 모양으로 받음) */
export function asApiError(e: unknown): TeacherApiError {
  if (e instanceof TeacherApiError) return e
  const code = (e as { code?: unknown })?.code
  // Firestore 클라이언트 오류
  if (code === 'permission-denied') return new TeacherApiError(403, 'permission-denied', '')
  if (code === 'unavailable' || code === 'deadline-exceeded') return new TeacherApiError(0, 'network', '')
  if (code === 'failed-precondition') return new TeacherApiError(500, 'index-required', '')
  return new TeacherApiError(500, 'client-error', '알 수 없는 오류가 났어요. 다시 시도해 주세요.')
}

/** 화면 오류 문구 + 코드(원인 확인용, 내부 id 없음) */
export function errorText(e: TeacherApiError): string {
  return e.retryable && e.code !== 'network' ? `${e.message} (오류 코드: ${e.code})` : e.message
}

// ───────────────────────── 호출 ─────────────────────────

async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const u = auth?.currentUser
  if (!u) throw new TeacherApiError(401, 'unauthenticated', '')
  let token: string
  try {
    token = await u.getIdToken()
  } catch {
    throw new TeacherApiError(0, 'network', '')
  }
  let resp: Response
  try {
    resp = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
  } catch {
    throw new TeacherApiError(0, 'network', '')
  }
  const json = (await resp.json().catch(() => null)) as Record<string, any> | null
  if (!resp.ok) {
    const code = json && typeof json.code === 'string' ? json.code : resp.status >= 500 ? 'server-error' : `http-${resp.status}`
    const serverMessage = json && typeof json.error === 'string' ? json.error : ''
    const extra: Record<string, any> = {}
    if (json) {
      Object.keys(json).forEach((k) => {
        if (k !== 'error' && k !== 'code') extra[k] = json[k]
      })
    }
    throw new TeacherApiError(resp.status, code, messageFor(resp.status, code, serverMessage), extra)
  }
  if (!json) throw new TeacherApiError(500, 'bad-response', '서버 응답을 읽지 못했어요. 다시 시도해 주세요.')
  return json as T
}

// ───────────────────────── 응답 타입: 수업 ─────────────────────────

export type InvitePolicy = 'auto' | 'approval'

/** courses.ts courseView() — 교사 화면용 수업 */
export interface TeacherCourse extends Course {
  invitePolicy: InvitePolicy
  catalogVisible: boolean
  /** 대상 학년(1~6). 비면 학년 미상 — 학생 '수업 담기'에서 모든 학년에 보임 */
  grades: number[]
  /** 대상 반('2-1'). 비면 대상 학년 규칙 */
  classLabels?: string[]
  /**
   * 대상 반의 성격(서버 courseClassScope — 학생 '수업 담기'와 같은 판정): 'homeroom' 그 반 학생에게만(반별 수업) /
   * 'classes' 그 반 학생에게 먼저, 다른 반 학생도 보기로(분반·수업 코드 수업은 한 반이어도 여기) / null 대상 반 없음
   */
  classScope?: 'homeroom' | 'classes' | null
  legacyGroupId: string | null
  managerUids: string[]
  source: string
}

export interface HomeroomRef {
  classId: string
  label: string
}

export interface CourseListItem extends TeacherCourse {
  /** 'teacher' 담당 / 'manager' 관리(예: 학급 시간표로 만든 공통 수업) / 'homeroom' 내 담임 반 공통 수업 */
  role: 'teacher' | 'manager' | 'homeroom'
  canManage: boolean
  series: LessonSeries[]
}

export interface CourseListResponse {
  termId: string | null
  homerooms: HomeroomRef[]
  courses: CourseListItem[]
  revision: number
}

export interface EnrollmentCounts {
  active: number
  pending: number
  ended: number
}

export interface PendingStudentView {
  uid: string
  name: string
  studentId: number | null
  homeroomLabel: string
}

export interface CourseDetailResponse {
  course: TeacherCourse
  series: LessonSeries[]
  counts: EnrollmentCounts
  pending: PendingStudentView[]
  commonHomerooms: HomeroomRef[]
  revision: number
}

export interface CreateCourseInput {
  title: string
  subject: string
  section?: string | null
  defaultRoomName?: string | null
  invitePolicy?: InvitePolicy
  catalogVisible?: boolean
  teacherNames?: string[]
  grades?: number[]
  classLabels?: string[]
}

export interface UpdateCourseInput {
  title?: string
  subject?: string
  section?: string | null
  defaultRoomName?: string | null
  teacherNames?: string[]
  invitePolicy?: InvitePolicy
  catalogVisible?: boolean
  grades?: number[]
  classLabels?: string[]
}

/** addSeries 충돌(교사 uid 없음) */
export interface SeriesConflict {
  kind: 'teacher' | 'room' | 'students'
  seriesId: string
  courseId: string
  courseTitle: string
  weekday: number
  period: number
  detail: string
}

export interface AddSeriesInput {
  courseId: string
  weekday: Weekday
  period: number
  start?: string | null
  end?: string | null
  roomName?: string | null
  validFrom?: Ymd | null
  acknowledgeConflicts?: boolean
}

export interface AddSeriesResponse {
  ok: true
  seriesId: string
  series: LessonSeries
  conflicts: SeriesConflict[]
  revision: number
}

export interface FromHomeroomResponse {
  ok: true
  already?: boolean
  classId: string
  termId: string
  effectiveFrom: Ymd
  courses: number
  coursesCreated: number
  seriesCreated: number
  seriesRetired: number
  seriesUnchanged: number
  cellsWithoutTeacher: number
  cellsWithoutRoom: number
  courseIds: string[]
  revision: number
}

export const listCourses = (opts: { termId?: string | 'all' } = {}) =>
  postJson<CourseListResponse>('/api/courses', { action: 'list', ...(opts.termId ? { termId: opts.termId } : {}) })

export const getCourse = (courseId: string) => postJson<CourseDetailResponse>('/api/courses', { action: 'get', courseId })

export const createCourse = (input: CreateCourseInput) =>
  postJson<{ ok: true; courseId: string; course: TeacherCourse; revision: number }>('/api/courses', { action: 'create', ...input })

export const updateCourse = (courseId: string, patch: UpdateCourseInput) =>
  postJson<{ ok: true; already?: boolean; courseId: string; course: TeacherCourse; revision: number }>('/api/courses', {
    action: 'update',
    courseId,
    ...patch,
  })

export const endCourse = (courseId: string, endedOn?: Ymd) =>
  postJson<{ ok: true; already?: boolean; courseId: string; endedOn: Ymd; revision: number }>('/api/courses', {
    action: 'end',
    courseId,
    ...(endedOn ? { endedOn } : {}),
  })

export const setCommon = (courseId: string, homeroomId: string, enabled: boolean) =>
  postJson<{ ok: true; already?: boolean; courseId: string; homeroomId: string; enabled: boolean; revision: number }>('/api/courses', {
    action: 'setCommon',
    courseId,
    homeroomId,
    enabled,
  })

export const addSeries = (input: AddSeriesInput) => postJson<AddSeriesResponse>('/api/courses', { action: 'addSeries', ...input })

export const retireSeries = (seriesId: string, effectiveFrom: Ymd) =>
  postJson<{ ok: true; already?: boolean; seriesId: string; validTo: Ymd | null; revision: number }>('/api/courses', {
    action: 'retireSeries',
    seriesId,
    effectiveFrom,
  })

export const fromHomeroomTimetable = (classId: string, effectiveFrom?: Ymd) =>
  postJson<FromHomeroomResponse>('/api/courses', { action: 'fromHomeroomTimetable', classId, ...(effectiveFrom ? { effectiveFrom } : {}) })

// ───────────────────────── 수강 ─────────────────────────

export interface EnrolledStudentView {
  uid: string
  name: string
  studentId: number | null
  /** 소속 표시(서버가 만든 문구 — 그룹이 소속처럼 저장된 학생은 '소속 학급 미설정') */
  homeroomLabel: string
  status: EnrollmentStatus
  from: Ymd | null
  to: Ymd | null
  source: EnrollmentSource
}

export interface EnrollmentListResponse {
  courseId: string
  counts: EnrollmentCounts
  students: EnrolledStudentView[]
}

export interface EnrollmentWriteResponse {
  ok: true
  courseId: string
  uid: string
  status: EnrollmentStatus
  already?: boolean
  revision: number
}

export const listEnrollments = (courseId: string) => postJson<EnrollmentListResponse>('/api/enrollments', { action: 'list', courseId })

export const decideEnrollment = (action: 'approve' | 'reject' | 'end', courseId: string, uid: string) =>
  postJson<EnrollmentWriteResponse>('/api/enrollments', { action, courseId, uid })

// ───────────────────────── 초대 ─────────────────────────

export type InviteType = 'homeroom' | 'course'
export type InviteState = 'ok' | 'expired' | 'revoked' | 'used-up' | 'ended' | 'not-found'

export interface CreatedInvitation {
  ok: true
  code: string
  displayCode: string
  /** 상대 경로 '/i/{code}' — 화면이 window.location.origin을 붙임 */
  url: string
  type: InviteType
  targetId: string
  targetLabel: string
  schoolName: string
  teacherName: string
  termId: string
  expiresAt: number
  maxUses: number | null
  uses: number
}

export interface InvitationRow {
  code: string
  displayCode: string
  url: string
  type: InviteType
  targetLabel: string
  createdAt: number | null
  expiresAt: number | null
  revoked: boolean
  uses: number
  maxUses: number | null
  state: InviteState
  issuedByName: string
  mine: boolean
}

export interface InvitationListResponse {
  targetId: string
  type: InviteType
  targetLabel: string
  invitations: InvitationRow[]
}

export const createInvitation = (input: { type: InviteType; targetId: string; expiresInDays?: number; maxUses?: number | null }) =>
  postJson<CreatedInvitation>('/api/invitations', { action: 'create', ...input })

export const revokeInvitation = (code: string) =>
  postJson<{ ok: true; code: string; revoked: true; already?: boolean }>('/api/invitations', { action: 'revoke', code })

export const listInvitations = (targetId: string, type: InviteType) =>
  postJson<InvitationListResponse>('/api/invitations', { action: 'list', targetId, type })

export const INVITE_STATE_LABEL: Record<InviteState, string> = {
  ok: '사용 가능',
  expired: '만료됨',
  revoked: '회수됨',
  'used-up': '인원 다 참',
  ended: '수업 종료',
  'not-found': '대상 없음',
}

// ───────────────────────── 변경 이력(읽기만) ─────────────────────────

export interface ChangeSetChange {
  courseId: string
  title: string
  occurrenceKey: string
  kind: 'cancel' | 'reschedule' | 'restore' | 'makeup' | 'base'
  before: SlotState | null
  after: SlotState | null
  base: SlotState | null
  fields: ChangeField[]
  effectiveFrom?: Ymd | null
}

/** schedule-changes.ts summary() 중 화면에 쓰는 필드(승인자 uid 등은 표시하지 않음) */
export interface ChangeSetSummaryView {
  changeSetId: string
  status: 'published' | 'pending-approval' | 'rejected'
  scope: 'date' | 'base'
  reason: string
  affectedDates: Ymd[]
  affectedStudentCount: number
  changes: ChangeSetChange[]
  createdByName: string | null
  createdAt: number | null
  publishedAt: number | null
}

export interface OrphanView {
  overrideId: string
  courseId: string
  occurrenceKey: string
  kind: 'cancel' | 'reschedule' | 'makeup' | 'restore'
  originalDate: Ymd | null
  target: SlotState | null
  reason: string | null
  suggestedOccurrenceKey: string | null
}

export const listChangeSets = async (courseId: string) =>
  (await postJson<{ changeSets: ChangeSetSummaryView[] }>('/api/schedule-changes', { action: 'list', courseId })).changeSets || []

export const listOrphans = async (courseId: string) =>
  (await postJson<{ courseId: string; orphans: OrphanView[] }>('/api/schedule-changes', { action: 'orphans', courseId })).orphans || []

/** 일정 변경 화면(다른 그룹 담당) 링크 */
export const scheduleChangesHref = (courseId?: string) =>
  courseId ? `/teacher/schedule-changes?courseId=${encodeURIComponent(courseId)}` : '/teacher/schedule-changes'

// ───────────────────────── Firestore 직접 읽기(같은 학교 교사 읽기 규칙) ─────────────────────────

/** 가져오기가 남긴 '공통 수업 후보'(아직 담임이 확인하지 않은 것) */
export interface CommonCandidate {
  courseId: string
  title: string
  subject: string
  section: string | null
  teacherNames: string[]
  termId: string
  series: LessonSeries[]
}

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

function seriesFromData(id: string, d: Record<string, any>): LessonSeries {
  return {
    seriesId: id,
    courseId: String(d.courseId || ''),
    weekday: Math.min(7, Math.max(1, Number(d.weekday) || 1)) as Weekday,
    period: Number(d.period) || 0,
    start: d.start ? String(d.start) : null,
    end: d.end ? String(d.end) : null,
    roomId: d.roomId ? String(d.roomId) : null,
    roomName: d.roomName ? String(d.roomName) : null,
    validFrom: isYmd(d.validFrom) ? d.validFrom : '19700101',
    validTo: isYmd(d.validTo) ? d.validTo : null,
    status: d.status === 'retired' ? 'retired' : 'active',
  }
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

/**
 * 담임 반의 공통 수업 '후보': schools/{s}/courses where importCommon array-contains classId 중
 * 아직 commonForHomerooms에 그 반이 없고 운영 중인 수업(termId가 주어지면 그 학기만).
 * 읽기 실패(권한·네트워크)는 그대로 throw — 화면이 '후보 없음'으로 위장하지 않음.
 */
export async function loadCommonCandidates(schoolCode: string, classId: string, termId: string | null): Promise<CommonCandidate[]> {
  if (!db) throw new TeacherApiError(503, 'not-configured', '')
  try {
    const snap = await getDocs(query(collection(db, 'schools', schoolCode, 'courses'), where('importCommon', 'array-contains', classId)))
    const rows = snap.docs
      .map((d) => ({ id: d.id, v: d.data() || {} }))
      .filter((r) => r.v.status !== 'ended' && !strArr(r.v.commonForHomerooms).includes(classId))
      .filter((r) => !termId || String(r.v.termId || '') === termId)
    const seriesByCourse = new Map<string, LessonSeries[]>()
    for (const ids of chunk(rows.map((r) => r.id), 30)) {
      const s = await getDocs(query(collection(db, 'schools', schoolCode, 'series'), where('courseId', 'in', ids)))
      s.docs.forEach((d) => {
        const x = seriesFromData(d.id, d.data() || {})
        const arr = seriesByCourse.get(x.courseId) || []
        arr.push(x)
        seriesByCourse.set(x.courseId, arr)
      })
    }
    return rows
      .map((r) => ({
        courseId: r.id,
        title: String(r.v.title || r.v.subject || '수업'),
        subject: String(r.v.subject || ''),
        section: r.v.section ? String(r.v.section) : null,
        teacherNames: strArr(r.v.teacherNames),
        termId: String(r.v.termId || ''),
        series: seriesByCourse.get(r.id) || [],
      }))
      .sort((a, b) => a.title.localeCompare(b.title, 'ko'))
  } catch (e) {
    throw asApiError(e)
  }
}

/** 예전 수업 그룹(classes/{base}_g_{x})과 연결된 수업(course.legacyGroupId) — 없으면 null */
export async function findCourseForLegacyGroup(schoolCode: string, groupId: string): Promise<{ courseId: string; title: string } | null> {
  if (!db) throw new TeacherApiError(503, 'not-configured', '')
  try {
    const snap = await getDocs(query(collection(db, 'schools', schoolCode, 'courses'), where('legacyGroupId', '==', groupId)))
    const live = snap.docs.filter((d) => d.get('status') !== 'ended')
    const d = live[0] || snap.docs[0]
    return d ? { courseId: d.id, title: String(d.get('title') || d.get('subject') || '수업') } : null
  } catch (e) {
    throw asApiError(e)
  }
}

// ───────────────────────── 교사 가드 ─────────────────────────

export interface TeacherProfile {
  uid: string
  name: string
  schoolCode: string
  schoolName: string
  /** 담임 반(users.classId) — 수업 그룹이 아닌 학급일 때만 */
  homeroomId: string | null
}

/**
 * 기존 교사 페이지와 같은 인증 가드: 로그인 없음 → /auth/login, 학생 → /student/today,
 * 교사 프로필 없음 → /dashboard, 학교 없음 → /teacher/register-class.
 * 내 정보 읽기 실패(네트워크)는 이동하지 않고 오류 + 다시 시도.
 * 화면 표시용 확인일 뿐 — 실제 권한은 서버가 다시 판정합니다.
 */
export function useTeacherProfile(): { profile: TeacherProfile | null; loading: boolean; error: TeacherApiError | null; retry: () => void } {
  const router = useRouter()
  const { toast } = useUI()
  const routerRef = useRef(router)
  const toastRef = useRef(toast)
  routerRef.current = router
  toastRef.current = toast
  const [profile, setProfile] = useState<TeacherProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<TeacherApiError | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!auth || !db) {
      setError(new TeacherApiError(503, 'not-configured', ''))
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        routerRef.current.replace('/auth/login')
        return
      }
      try {
        const snap = await getDoc(doc(db, 'users', u.uid))
        const data = snap.exists() ? snap.data() : null
        if (data?.role === 'student') {
          routerRef.current.replace('/student/today')
          return
        }
        if (!data || data.role !== 'teacher') {
          routerRef.current.replace('/dashboard')
          return
        }
        if (!data.schoolCode) {
          toastRef.current('먼저 학교를 등록해 주세요.', 'info')
          routerRef.current.replace('/teacher/register-class')
          return
        }
        const classId = typeof data.classId === 'string' && data.classId && !/_g_/.test(data.classId) ? data.classId : null
        const next: TeacherProfile = {
          uid: u.uid,
          name: String(data.displayName || data.name || ''),
          schoolCode: String(data.schoolCode),
          schoolName: String(data.schoolName || ''),
          homeroomId: classId,
        }
        setProfile((prev) =>
          prev && prev.uid === next.uid && prev.schoolCode === next.schoolCode && prev.homeroomId === next.homeroomId && prev.name === next.name
            ? prev
            : next
        )
        setLoading(false)
      } catch (e) {
        console.error('teacher: 내 정보 확인 실패', (e as { code?: string })?.code || (e as Error)?.message)
        setError(asApiError(e))
        setLoading(false)
      }
    })
    return () => unsub()
  }, [attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { profile, loading, error, retry }
}

// ───────────────────────── 표시 도우미 ─────────────────────────

export const WEEKDAY_KO = ['', '월', '화', '수', '목', '금', '토', '일'] as const

/** '2026-2' → '2026학년도 2학기' */
export function termLabel(termId: string | null | undefined): string {
  const m = /^(\d{4})-([12])$/.exec(termId || '')
  return m ? `${m[1]}학년도 ${m[2]}학기` : termId ? '학기 정보 확인 필요' : '학기 미정'
}

/** classId → '3학년 4반'(수업 그룹·형식 밖은 학년·반을 추정하지 않음) */
export function homeroomLabelFromId(classId: string): string {
  if (/_g_/.test(classId)) return '수업 그룹'
  const m = /_(\d{1,2})_(\d{1,2})$/.exec(classId)
  return m ? `${Number(m[1])}학년 ${Number(m[2])}반` : '학급'
}

export const todayYmd = (): Ymd => schoolYmdAt(Date.now())

/** ms → '11월 5일 (목)' (학교 시간대) */
export function formatMsDate(ms: number | null | undefined): string {
  return typeof ms === 'number' && Number.isFinite(ms) ? formatYmdKo(schoolYmdAt(ms)) : '—'
}

/** 차시가 오늘 이후로 열려 있는지(지금 적용 중이거나 예정) */
export function seriesCurrentOrUpcoming(s: LessonSeries, today: Ymd): boolean {
  if (s.validTo && s.validTo <= s.validFrom) return false
  if (s.status === 'retired' && !s.validTo) return false
  return !s.validTo || s.validTo > today
}

/** 'HH:MM~HH:MM' 또는 '' */
export function timeRangeText(s: { start?: string | null; end?: string | null }): string {
  if (s.start && s.end) return `${s.start}~${s.end}`
  if (s.start) return `${s.start}부터`
  return ''
}

/** 요일·교시 요약: '화 3교시 · 목 5교시' (지금 적용 중이거나 예정인 차시만) */
export function seriesSummary(series: LessonSeries[], today: Ymd, max = 4): string {
  const seen = new Set<string>()
  const items = series
    .filter((s) => seriesCurrentOrUpcoming(s, today))
    .sort((a, b) => a.weekday - b.weekday || a.period - b.period)
    .filter((s) => {
      const k = `${s.weekday}-${s.period}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .map((s) => `${WEEKDAY_KO[s.weekday]} ${s.period}교시`)
  if (!items.length) return '등록된 차시 없음'
  return items.length > max ? `${items.slice(0, max).join(' · ')} 외 ${items.length - max}개` : items.join(' · ')
}

export const ENROLLMENT_SOURCE_LABEL: Record<EnrollmentSource, string> = {
  invite: '초대 코드',
  roster: '수강 명단',
  request: '학생 신청',
  admin: '선생님 추가',
  'legacy-group': '예전 수업 그룹',
}

export const COURSE_SOURCE_LABEL: Record<string, string> = {
  manual: '직접 만든 수업',
  import: '시간표 가져오기',
  'legacy-group': '예전 수업 그룹에서 옮김',
  'homeroom-common': '학급 시간표로 만든 공통 수업',
}

export const CHANGE_FIELD_LABEL: Record<ChangeField, string> = {
  date: '날짜',
  time: '시간',
  room: '교실',
  teacher: '교사',
}
