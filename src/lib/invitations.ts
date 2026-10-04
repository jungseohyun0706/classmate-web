/**
 * 초대(학급·수업) 서버 공용 도우미 — API 라우트 전용(firebase-admin, node crypto)
 * 클라이언트 번들에서 import하지 마세요.
 *
 * - 사람이 입력할 8자 초대 코드(헷갈리는 0·1·I·L·O 제외). 표시는 XXXX-XXXX, 입력은 하이픈·공백·소문자를 정규화.
 * - 시도 제한(IP·uid 기준 실패 횟수 + IP 기준 요청 수). 인스턴스별 best-effort — verify-teacher-code와 같은 방식.
 * - 초대 상태 판정(만료·회수·사용 수·대상 학급/수업 존재·종료·학기).
 * - 학급/수업 그룹 입장 계획(planClassJoin): /api/join(기존 QR 링크)과 /api/invitations(학급 초대 수락)가 같이 씁니다.
 * - 수업 그룹과 연결된 수업(course.legacyGroupId) 찾기, 수강 문서 쓰기 값.
 *
 * 로그에 초대 코드·입장 토큰·학생 이름을 남기지 마세요.
 */
import { randomInt } from 'crypto'
import type { NextApiRequest } from 'next'
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore'
import { courseActiveOn } from './timetable/engine'
import { courseFromDoc, GROUP_RE, ID_RE, needsReapproval, schoolRef } from './timetable/server'
import { homeroomLabel, readTermDocs, termRangeOf, TimetableApiError } from './timetable/studentData'
import type { EnrollmentStatus, Ymd } from './timetable/types'

function fail(status: number, code: string, message: string, extra?: Record<string, unknown>): never {
  throw new TimetableApiError(status, code, message, extra)
}

// ───────────────────────── 초대 코드 ─────────────────────────

/** 헷갈리는 문자(0·1·I·L·O)를 뺀 31자 */
export const INVITE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
export const INVITE_CODE_LENGTH = 8
const INVITE_CODE_RE = new RegExp(`^[${INVITE_ALPHABET}]{${INVITE_CODE_LENGTH}}$`)

/** 새 초대 코드(정규화된 8자). 충돌 확인은 저장할 때(create) 합니다. */
export function generateInviteCode(): string {
  let out = ''
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) out += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)]
  return out
}

/**
 * 사람이 입력·붙여넣은 값 → 정규화된 8자 코드. 형식이 틀리면 null.
 * 하이픈·공백·소문자를 허용하고, 초대 링크 전체(…/i/ABCD-2345)를 붙여넣어도 코드만 꺼냅니다.
 */
export function normalizeInviteCode(input: unknown): string | null {
  if (typeof input !== 'string') return null
  let s = input.trim()
  if (!s || s.length > 200) return null
  const m = /\/i\/([^/?#\s]+)/.exec(s)
  if (m) s = m[1]
  try {
    s = decodeURIComponent(s)
  } catch {
    // 잘못된 % 인코딩은 그대로 두고 아래 형식 검사에서 거름
  }
  s = s.replace(/[\s\-‐-―_.]/g, '').toUpperCase()
  return INVITE_CODE_RE.test(s) ? s : null
}

/** 'ABCD2345' → 'ABCD-2345' */
export function formatInviteCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code
}

/** 초대 링크 경로(상대 경로 — 화면이 자기 origin을 붙임) */
export function inviteUrlPath(code: string): string {
  return `/i/${code}`
}

/** 감사 로그·오류 메시지용: 앞 2자만 남김 */
export function maskInviteCode(code: string): string {
  return `${code.slice(0, 2)}******`
}

// ───────────────────────── 시도 제한 ─────────────────────────

interface LimiterOptions {
  windowMs: number
  max: number
  /** Map 크기 상한(메모리 보호). 넘으면 만료된 항목부터, 그래도 많으면 오래된 항목부터 지움 */
  maxKeys: number
}

/** 키별 고정 창 카운터(인스턴스 메모리) */
export class AttemptLimiter {
  private hits = new Map<string, { n: number; t: number }>()
  constructor(private opts: LimiterOptions) {}

  private current(key: string, now: number) {
    const a = this.hits.get(key)
    if (!a) return null
    if (now - a.t > this.opts.windowMs) {
      this.hits.delete(key)
      return null
    }
    return a
  }

  limited(key: string, now = Date.now()): boolean {
    const a = this.current(key, now)
    return !!a && a.n >= this.opts.max
  }

  hit(key: string, now = Date.now()) {
    const a = this.current(key, now)
    if (a) {
      a.n += 1
      return
    }
    if (this.hits.size >= this.opts.maxKeys) this.prune(now)
    this.hits.set(key, { n: 1, t: now })
  }

  private prune(now: number) {
    const expired: string[] = []
    this.hits.forEach((v, k) => {
      if (now - v.t > this.opts.windowMs) expired.push(k)
    })
    expired.forEach((k) => this.hits.delete(k))
    // 그래도 꽉 차 있으면 가장 먼저 들어온 항목부터(삽입 순서) 지움
    const over = this.hits.size - this.opts.maxKeys + 1
    if (over > 0) {
      const keys = Array.from(this.hits.keys()).slice(0, over)
      keys.forEach((k) => this.hits.delete(k))
    }
  }

  get size(): number {
    return this.hits.size
  }
}

/**
 * 실패 횟수 제한: 없는 코드·형식 오류만 셉니다(무차별 대입의 흔적).
 * 만료·회수된 코드는 실제로 발급된 코드라 세지 않습니다 — 한 학교(공인 IP 하나)에서 학생들이 만료된
 * 코드를 연달아 열어도, 선생님이 새로 발급한 코드까지 막히지 않게 하기 위해서입니다.
 * IP는 학교 NAT를 고려해 넉넉하게, 로그인 계정(uid)은 좁게 둡니다.
 */
export const failureLimiter = new AttemptLimiter({ windowMs: 10 * 60 * 1000, max: 30, maxKeys: 10000 })
export const uidFailureLimiter = new AttemptLimiter({ windowMs: 10 * 60 * 1000, max: 10, maxKeys: 10000 })
/** 대량 요청 제한(성공·실패 모두): IP당 1분 300회 */
export const requestLimiter = new AttemptLimiter({ windowMs: 60 * 1000, max: 300, maxKeys: 10000 })

/** 요청 IP — 기존 API(verify-teacher-code 등)와 같은 기준 */
export function clientIp(req: NextApiRequest): string {
  const xff = req.headers['x-forwarded-for']
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim()
  return first || (req.socket && req.socket.remoteAddress) || 'unknown'
}

/**
 * 요청 시작 시 확인. 막혀 있으면 TimetableApiError(429).
 * scope: 'invite' | 'join' — 기존 QR 토큰과 초대 코드의 실패를 따로 셉니다.
 */
export function checkRateLimit(scope: string, ip: string, uid?: string | null) {
  requestLimiter.hit(`${scope}:${ip}`)
  if (
    requestLimiter.limited(`${scope}:${ip}`) ||
    failureLimiter.limited(`${scope}:${ip}`) ||
    (uid ? uidFailureLimiter.limited(`${scope}:${uid}`) : false)
  ) {
    fail(429, 'rate-limited', '시도가 너무 많아요. 잠시 후 다시 시도해 주세요.')
  }
}

export function recordFailure(scope: string, ip: string, uid?: string | null) {
  failureLimiter.hit(`${scope}:${ip}`)
  if (uid) uidFailureLimiter.hit(`${scope}:${uid}`)
}

// ───────────────────────── 기존 QR 입장 토큰(/join?c=&t=) ─────────────────────────

/** src/lib/join.ts의 JOIN_TOKEN_TTL_MS와 같은 값(그 파일은 클라이언트 SDK를 불러와 서버에서 import하지 않음) */
export const JOIN_TOKEN_TTL_MS = 10 * 60 * 1000
export const CLASS_ID_RE = /^[A-Za-z0-9_-]{1,80}$/
export const JOIN_TOKEN_RE = /^[a-f0-9]{32}$/

/**
 * classes/{classId}/joinTokens/{token} 확인.
 * 만료는 교사 기기 시계로 계산된 expiresAt이 아니라 서버가 기록한 createdAt 기준(createdAt이 없는 예전 토큰만 expiresAt).
 */
export async function checkJoinToken(db: Firestore, classId: string, token: string): Promise<'ok' | 'not-found' | 'expired'> {
  const snap = await db.collection('classes').doc(classId).collection('joinTokens').doc(token).get()
  if (!snap.exists) return 'not-found'
  const createdAt = snap.get('createdAt')
  const expiresAt = snap.get('expiresAt')
  const expiresAtMs =
    createdAt instanceof Timestamp
      ? createdAt.toMillis() + JOIN_TOKEN_TTL_MS
      : expiresAt instanceof Timestamp
        ? expiresAt.toMillis()
        : 0
  return expiresAtMs > Date.now() ? 'ok' : 'expired'
}

// ───────────────────────── 학교·수업 판정 ─────────────────────────

/** 학급 문서의 학교 코드. schoolCode가 없는 예전 문서는 classId 첫 토막(보안 규칙과 같은 기준) */
export function schoolOfClass(cls: Record<string, any> | null | undefined, classId: string): string {
  return String((cls && cls.schoolCode) || classId.split('_')[0] || '')
}

/** 사용자 문서의 학교 코드(없으면 classId 첫 토막, 그것도 없으면 '') */
export function schoolOfUser(user: Record<string, any> | null | undefined): string {
  if (!user) return ''
  if (typeof user.schoolCode === 'string' && user.schoolCode) return user.schoolCode
  const classId = typeof user.classId === 'string' ? user.classId : ''
  return classId ? classId.split('_')[0] : ''
}

type TermDocs = Array<{ id: string; data: Record<string, any> }>

/**
 * 수업에 지금 참여할 수 있는지: 종료되지 않았고(status·endedOn), 수업 학기가 끝나지 않았음.
 * 다음 학기 수업(아직 시작 전)은 미리 참여할 수 있습니다.
 */
export function courseOpenOn(courseId: string, course: Record<string, any>, termDocs: TermDocs, today: Ymd): boolean {
  if (!courseActiveOn(courseFromDoc(courseId, course), today)) return false
  const termId = typeof course.termId === 'string' ? course.termId : ''
  const range = termId ? termRangeOf(termDocs, termId) : null
  if (range && today >= range.endDate) return false
  return true
}

/** 수업 그룹(classes/{base}_g_{x})과 연결된(legacyGroupId) 참여 가능한 수업 — 최대 10개 */
export async function linkedCoursesForGroup(
  db: Firestore,
  schoolCode: string,
  groupId: string,
  today: Ymd
): Promise<Array<{ courseId: string; data: Record<string, any> }>> {
  if (!schoolCode || !GROUP_RE.test(groupId)) return []
  const [snap, termDocs] = await Promise.all([
    schoolRef(db, schoolCode).collection('courses').where('legacyGroupId', '==', groupId).get(),
    readTermDocs(db, schoolCode),
  ])
  return snap.docs
    .map((d) => ({ courseId: d.id, data: d.data() || {} }))
    .filter((c) => String(c.data.schoolCode || schoolCode) === schoolCode && courseOpenOn(c.courseId, c.data, termDocs, today))
    .sort((a, b) => a.courseId.localeCompare(b.courseId))
    .slice(0, 10)
}

// ───────────────────────── 초대 상태 ─────────────────────────

export type InviteType = 'homeroom' | 'course'
export type InviteState = 'ok' | 'expired' | 'revoked' | 'used-up' | 'ended' | 'not-found'

export const INVITE_STATE_HTTP: Record<Exclude<InviteState, 'ok'>, number> = {
  'not-found': 404,
  expired: 410,
  revoked: 410,
  'used-up': 410,
  ended: 410,
}

export const INVITE_STATE_MESSAGE: Record<Exclude<InviteState, 'ok'>, string> = {
  'not-found': '초대 코드를 찾을 수 없어요. 코드를 다시 확인해 주세요.',
  expired: '초대 기간이 지났어요. 선생님께 새 초대 코드를 요청해 주세요.',
  revoked: '선생님이 회수한 초대예요. 선생님께 새 초대 코드를 요청해 주세요.',
  'used-up': '이 초대는 사용할 수 있는 인원이 모두 찼어요. 선생님께 문의해 주세요.',
  ended: '이미 끝난 수업(또는 지난 학기)의 초대예요. 선생님께 확인해 주세요.',
}

export function tsMillis(v: unknown): number | null {
  return v && typeof (v as Timestamp).toMillis === 'function' ? (v as Timestamp).toMillis() : null
}

/**
 * 초대 상태 판정(순수). 우선순위: 없음 → 회수 → 만료 → 대상 없음 → 종료 → 인원 초과.
 * alreadyUsedByMe: 이미 이 초대를 수락한 사람의 재요청은 인원 초과로 막지 않음(같은 결과).
 */
export function inviteStateOf(
  inv: Record<string, any> | null,
  target: Record<string, any> | null,
  ctx: { nowMs: number; today: Ymd; termDocs?: TermDocs; alreadyUsedByMe?: boolean }
): InviteState {
  if (!inv) return 'not-found'
  if (inv.revoked === true) return 'revoked'
  const exp = tsMillis(inv.expiresAt)
  if (exp !== null && exp <= ctx.nowMs) return 'expired'
  if (!target) return 'not-found'
  if (inv.type === 'course') {
    if (!courseOpenOn(String(inv.targetId || ''), target, ctx.termDocs || [], ctx.today)) return 'ended'
  } else if (inv.type === 'homeroom') {
    if (target.isGroup === true) return 'not-found'
    if (schoolOfClass(target, String(inv.targetId || '')) !== String(inv.schoolCode || '')) return 'not-found'
  } else {
    return 'not-found'
  }
  const max = typeof inv.maxUses === 'number' ? inv.maxUses : null
  const uses = Number(inv.uses) || 0
  if (max !== null && uses >= max && !ctx.alreadyUsedByMe) return 'used-up'
  return 'ok'
}

/** 상태가 ok가 아니면 알맞은 HTTP 상태·code로 throw */
export function assertInviteOk(state: InviteState, extra?: Record<string, unknown>) {
  if (state === 'ok') return
  fail(INVITE_STATE_HTTP[state], state, INVITE_STATE_MESSAGE[state], { state, ...(extra || {}) })
}

// ───────────────────────── 학급·수업 그룹 입장 계획 ─────────────────────────

export type ClassJoinStatus = 'approved' | 'move-pending' | 'joined-extra' | 'joined-extra-pending' | 'pending'

export interface ClassJoinNotice {
  teacherId: string
  /**
   * users/{teacher}/notifications 문서 id — 같은 신청을 다시 보내도 알림이 쌓이지 않게.
   * 신청마다 다른 일련번호(users.joinSeq)를 붙여, 거절·그룹에서 뺀 뒤의 새 신청은 다시 알립니다.
   */
  dedupeId: string
  title: string
  body: string
  url: string
}

export interface ClassJoinPlan {
  status: ClassJoinStatus
  already: boolean
  /** users/{uid}에 merge로 쓸 값(없으면 쓰지 않음) */
  userWrite: Record<string, unknown> | null
  /** 커밋 뒤 보낼 교사 알림 */
  notify: ClassJoinNotice | null
  /** 수업 그룹 입장: 그룹과 연결된 수업(legacyGroupId) 수강도 함께 만들지 */
  linkGroupCourses: boolean
}

export interface ClassJoinInput {
  uid: string
  email: string | null
  classId: string
  /** classes/{classId} 문서(서버가 읽은 값) */
  cls: Record<string, any>
  /** users/{uid} 문서(없으면 null) */
  prev: Record<string, any> | null
  /** 이름(정리된 값, 비어 있으면 기존 프로필 이름) */
  name: string
  /** 번호(숫자만, 비어 있으면 '') */
  studentId: string
  /** 호출하는 쪽 호환용(알림 id는 날짜 대신 신청 일련번호 joinSeq로 정함) */
  today: Ymd
}

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/**
 * 학급(실반)·수업 그룹 QR 입장 처리 계획(순수 — 쓰기는 호출하는 쪽이 트랜잭션에서).
 *
 * - 교사 계정 403 teacher-account, 학생이 아닌 역할 403 not-student
 * - 승인됐거나 신청 중인 학생이 다른 학교 반·그룹 → 403 other-school(기존 소속·신청을 덮어쓰지 않음)
 * - 승인된 학생: 같은 반 already / 다른 실반 → 반 이동 신청(pendingClassId) / 그룹 → 추가 참여(extraClassIds)
 * - 신청 중(pending)인 학생:
 *     같은 반·그룹 → 프로필(이름·번호)만 갱신, 알림 다시 보내지 않음(already)
 *     수업 그룹 → 신청해 둔 소속은 그대로, 그룹은 extraClassIds에만(joined-extra-pending) — H2 수정
 *     다른 실반 → 새 반으로 다시 신청(아래 기본)
 * - 기본(신규·거절·소속 없는 학생): 그 반 승인 대기. 그룹이면 그룹이 임시 소속(그룹 교사 승인)이고 학년·반은 비움
 * - 새 신청(반 이동·그룹 참여·입장 신청)마다 users.joinSeq를 +1 하고 교사 알림 id에 붙입니다.
 *   같은 신청의 재전송·더블 탭은 위에서 already(쓰기·알림 없음)로 끝나므로 알림은 1건,
 *   거절 뒤 같은 날 재신청·그룹에서 빠진 뒤 재참여는 새 번호라 다시 알립니다(날짜·고정 id는 이 알림을 막았음).
 */
export function planClassJoin(input: ClassJoinInput): ClassJoinPlan {
  const { uid, classId, cls, studentId } = input
  const prev = input.prev || {}
  if (prev.role === 'teacher') fail(403, 'teacher-account', '교사 계정으로는 학생 입장을 할 수 없어요. 학생 계정으로 로그인해 주세요.')
  if (prev.role && prev.role !== 'student') fail(403, 'not-student', '학생 계정에서만 입장할 수 있어요.')

  const isGroup = cls.isGroup === true
  const classSchool = schoolOfClass(cls, classId)
  const prevClassId = typeof prev.classId === 'string' ? prev.classId : ''
  const isStudent = prev.role === 'student'
  const approved = isStudent && prev.status === 'approved' && !!prevClassId
  const pending = isStudent && prev.status === 'pending'
  const mySchool = schoolOfUser(prev)
  const displayName = String(prev.name || input.name || '학생')
  const teacherId = cls.teacherId ? String(cls.teacherId) : ''
  const groupLabel = `${cls.grade ?? ''}학년 ${cls.classNm ?? ''}반 톡방`
  const notice = (dedupeId: string, title: string, body: string): ClassJoinNotice | null =>
    teacherId ? { teacherId, dedupeId, title, body, url: '/teacher/students' } : null
  // 이번 신청 번호(트랜잭션 안에서 읽은 프로필 기준 — 경합하면 트랜잭션이 다시 읽어 번호가 겹치지 않음)
  const seq = (Number.isSafeInteger(prev.joinSeq) && prev.joinSeq > 0 ? (prev.joinSeq as number) : 0) + 1

  if ((approved || pending) && mySchool && mySchool !== classSchool) {
    fail(403, 'other-school', '다른 학교 반에는 들어갈 수 없어요. 전학했다면 지금 학교 선생님께 문의해 주세요.')
  }

  if (approved) {
    if (prevClassId === classId) {
      return { status: 'approved', already: true, userWrite: null, notify: null, linkGroupCourses: isGroup }
    }
    if (!isGroup) {
      if (prev.pendingClassId === classId) {
        return { status: 'move-pending', already: true, userWrite: null, notify: null, linkGroupCourses: false }
      }
      return {
        status: 'move-pending',
        already: false,
        userWrite: { pendingClassId: classId, pendingStudentId: studentId || null, pendingAt: FieldValue.serverTimestamp(), joinSeq: seq },
        notify: notice(`move_${classId}__${uid}_${seq}`, '반 이동 신청', `${displayName} 학생이 우리 반으로 옮기고 싶어해요`),
        linkGroupCourses: false,
      }
    }
    if (arr(prev.extraClassIds).includes(classId)) {
      return { status: 'joined-extra', already: true, userWrite: null, notify: null, linkGroupCourses: true }
    }
    return {
      status: 'joined-extra',
      already: false,
      userWrite: { extraClassIds: FieldValue.arrayUnion(classId), joinSeq: seq },
      notify: notice(`extra_${classId}__${uid}_${seq}`, '수업 반 참여', `${displayName} 학생이 ${groupLabel}에 참여했어요`),
      linkGroupCourses: true,
    }
  }

  if (pending && prevClassId) {
    if (prevClassId === classId) {
      // 같은 반 재신청: 이름·번호만 갱신하고 교사 알림·푸시는 다시 보내지 않음(멱등)
      const w: Record<string, unknown> = {}
      if (input.name && input.name !== prev.name) {
        w.name = input.name
        w.displayName = input.name
      }
      if (studentId && studentId !== String(prev.studentId ?? '')) w.studentId = studentId
      return { status: 'pending', already: true, userWrite: Object.keys(w).length ? w : null, notify: null, linkGroupCourses: isGroup }
    }
    if (isGroup) {
      // H2: 승인 전에 수업 그룹 QR을 찍어도 신청해 둔 소속(담임 반)은 그대로 — 그룹은 추가 참여로만
      if (arr(prev.extraClassIds).includes(classId)) {
        return { status: 'joined-extra-pending', already: true, userWrite: null, notify: null, linkGroupCourses: true }
      }
      return {
        status: 'joined-extra-pending',
        already: false,
        userWrite: { extraClassIds: FieldValue.arrayUnion(classId), joinSeq: seq },
        notify: notice(`extra_${classId}__${uid}_${seq}`, '수업 반 참여', `${displayName} 학생이 ${groupLabel}에 참여했어요`),
        linkGroupCourses: true,
      }
    }
    // 다른 실반: 새 반으로 다시 신청(아래)
  }

  // 기본: 신규·승인 전·거절·소속 없는 학생 → 그 반(또는 그룹) 승인 대기
  //   그룹에는 여러 반 학생이 섞이므로 학년·반은 그룹 원본 반 값으로 채우지 않음
  const name = input.name || String(prev.name || '')
  if (!name) fail(400, 'name-required', '이름을 입력해 주세요.')
  const profile: Record<string, unknown> = {
    role: 'student',
    status: 'pending',
    classId,
    schoolCode: classSchool || null,
    schoolName: cls.schoolName ?? prev.schoolName ?? null,
    grade: isGroup ? null : cls.grade ?? null,
    classNm: isGroup ? null : cls.classNm ?? null,
    name,
    displayName: name,
    email: input.email || prev.email || null,
    pendingClassId: FieldValue.delete(),
    pendingStudentId: FieldValue.delete(),
    pendingAt: FieldValue.delete(),
    joinSeq: seq,
  }
  if (cls.officeCode) profile.officeCode = cls.officeCode
  if (studentId) profile.studentId = studentId
  if (!input.prev) profile.createdAt = FieldValue.serverTimestamp()
  return {
    status: 'pending',
    already: false,
    userWrite: profile,
    notify: notice(`join_${classId}__${uid}_${seq}`, '새 학생 입장 신청', `${name} 학생이 승인을 기다려요`),
    linkGroupCourses: isGroup,
  }
}

// ───────────────────────── 수강 쓰기 ─────────────────────────

/**
 * 수업에 새로 참여할 때의 기본 상태: 수업 참여 방식이 '승인 필요'(invitePolicy 'approval')면 승인 대기, 아니면 바로 참여.
 * 수업 초대 수락(/api/invitations)·그룹 QR(/api/join)·수강 신청이 같은 규칙을 씁니다(그룹 QR이 승인을 건너뛰지 않게).
 */
export function courseJoinDefault(course: Record<string, any> | null | undefined): 'active' | 'pending' {
  return course && course.invitePolicy === 'approval' ? 'pending' : 'active'
}

/** 수강 승인 요청 알림을 받을 교사: 수업 담당(teacherUids) + 관리(managerUids), 중복 없이 */
export function courseApproverUids(course: Record<string, any> | null | undefined): string[] {
  if (!course) return []
  return Array.from(new Set([...arr(course.teacherUids), ...arr(course.managerUids)])).filter((x) => ID_RE.test(x))
}

/**
 * 기존 수강 문서 → 이번 참여로 정할 상태.
 * active/pending이면 그대로(변경 없음). 선생님이 끝내거나 거절한 수강(ended + decidedBy)은 다시 승인 대기.
 * 선생님이 끝낸 뒤 학생이 다시 신청했다가 스스로 뺀 수강(reapproval 표시 — /api/enrollments leave는 decidedBy를 비움)도 승인 대기.
 */
export function decideEnrollment(
  cur: Record<string, any> | null,
  defaultStatus: 'active' | 'pending'
): { status: EnrollmentStatus; changed: boolean } {
  if (cur && (cur.status === 'active' || cur.status === 'pending')) return { status: cur.status, changed: false }
  const removedByTeacher = needsReapproval(cur)
  return { status: removedByTeacher ? 'pending' : defaultStatus, changed: true }
}

/** schools/{s}/enrollments/{courseId}__{uid}에 merge로 쓸 값 */
export function enrollmentWriteData(args: {
  cur: Record<string, any> | null
  courseId: string
  course: Record<string, any>
  uid: string
  schoolCode: string
  status: EnrollmentStatus
  today: Ymd
  source: 'invite'
  extra?: Record<string, unknown>
}): Record<string, unknown> {
  const { cur } = args
  const data: Record<string, unknown> = {
    courseId: args.courseId,
    uid: args.uid,
    schoolCode: args.schoolCode,
    termId: String(args.course.termId || ''),
    status: args.status,
    from: args.status === 'active' ? args.today : null,
    to: null,
    source: args.source,
    requestedAt: FieldValue.serverTimestamp(),
    decidedBy: null,
    rejected: false,
    ...(args.extra || {}),
    updatedAt: FieldValue.serverTimestamp(),
  }
  if (!cur) data.createdAt = FieldValue.serverTimestamp()
  else if (cur.status === 'ended') {
    data.history = FieldValue.arrayUnion({
      status: cur.status ?? null,
      from: cur.from ?? null,
      to: cur.to ?? null,
      source: cur.source ?? null,
      decidedBy: cur.decidedBy ?? null,
    })
  }
  return data
}

/** 학급 표시 이름('3학년 4반') — 수업 그룹은 '영어 수업 그룹' */
export function classTargetLabel(cls: Record<string, any> | null | undefined, classId: string): string {
  return homeroomLabel(cls, classId)
}
