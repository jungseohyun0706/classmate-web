/**
 * 개인 시간표 서버 공용 도우미 (API 라우트 전용 — firebase-admin)
 * 클라이언트 번들에서 import하지 마세요.
 */
import type { NextApiRequest, NextApiResponse } from 'next'
import { FieldValue, getFirestore, type Firestore, type Transaction, type WriteBatch } from 'firebase-admin/firestore'
import type { DecodedIdToken } from 'firebase-admin/auth'
import { getAdminApp, isAdminConfigured, sendPushToUser, verifyIdToken } from '../fcm-admin'
import type { Course, Enrollment, LessonSeries, Override, SlotState, Ymd } from './types'
import { isYmd } from './dates'

export const GROUP_RE = /_g_[A-Za-z0-9]+$/
export const SCHOOL_CODE_RE = /^[0-9A-Z]{7}$|^S\d{1,3}$/ // 운영: NEIS 7자리, 로컬 테스트 픽스처: S1·S2
export const ID_RE = /^[A-Za-z0-9_-]{1,120}$/

export interface ApiUser {
  uid: string
  decoded: DecodedIdToken
  user: Record<string, any>
  db: Firestore
}

export function apiError(res: NextApiResponse, status: number, code: string, error: string) {
  return res.status(status).json({ error, code })
}

/** 인증 + users 문서. 실패하면 응답을 보내고 null */
export async function requireUser(req: NextApiRequest, res: NextApiResponse): Promise<ApiUser | null> {
  if (!isAdminConfigured()) {
    apiError(res, 503, 'not-configured', '서버 설정이 없어요. 관리자에게 문의해 주세요.')
    return null
  }
  const authHeader = req.headers.authorization || ''
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  const decoded = await verifyIdToken(idToken)
  if (!decoded) {
    apiError(res, 401, 'unauthenticated', '로그인이 필요해요. 다시 로그인해 주세요.')
    return null
  }
  const app = getAdminApp()
  if (!app) {
    apiError(res, 503, 'not-configured', '서버 초기화에 실패했어요.')
    return null
  }
  const db = getFirestore(app)
  const snap = await db.collection('users').doc(decoded.uid).get()
  if (!snap.exists) {
    apiError(res, 403, 'no-profile', '가입이 아직 끝나지 않았어요. 초대 링크나 코드로 학급·수업에 먼저 참여해 주세요.')
    return null
  }
  return { uid: decoded.uid, decoded, user: snap.data() || {}, db }
}

export function adminDb(): Firestore | null {
  const app = getAdminApp()
  return app ? getFirestore(app) : null
}

export function schoolRef(db: Firestore, schoolCode: string) {
  return db.collection('schools').doc(schoolCode)
}

export function isTeacher(u: ApiUser): boolean {
  return u.user.role === 'teacher' && typeof u.user.schoolCode === 'string' && !!u.user.schoolCode
}

// ───────────────────────── 학기 ─────────────────────────

export interface TermInfo {
  termId: string
  name: string
  startDate: Ymd
  endDate: Ymd
  isDefault: boolean
}

/**
 * 학교 학기 문서가 없을 때 쓰는 기본 학기. 실제 개학·방학일은 학교마다 달라 '기본값'으로 표시하고
 * 교사 화면에서 바로잡을 수 있게 합니다. 1학기 [3/1, 8/16), 2학기 [8/16, 다음 해 3/1).
 */
export function defaultTermFor(ymd: Ymd): TermInfo {
  const y = Number(ymd.slice(0, 4))
  const md = ymd.slice(4)
  if (md >= '0301' && md < '0816') {
    return { termId: `${y}-1`, name: `${y}학년도 1학기`, startDate: `${y}0301`, endDate: `${y}0816`, isDefault: true }
  }
  const ay = md < '0301' ? y - 1 : y
  return { termId: `${ay}-2`, name: `${ay}학년도 2학기`, startDate: `${ay}0816`, endDate: `${ay + 1}0301`, isDefault: true }
}

export async function termForDate(db: Firestore, schoolCode: string, ymd: Ymd): Promise<TermInfo> {
  const snap = await schoolRef(db, schoolCode).collection('terms').get()
  for (const d of snap.docs) {
    const t = d.data()
    if (isYmd(t.startDate) && isYmd(t.endDate) && ymd >= t.startDate && ymd < t.endDate) {
      return { termId: d.id, name: String(t.name || d.id), startDate: t.startDate, endDate: t.endDate, isDefault: false }
    }
  }
  return defaultTermFor(ymd)
}

// ───────────────────────── 학교 문서 / 버전 ─────────────────────────

/** 학교 문서가 없으면 만들고 현재 scheduleRevision을 돌려줍니다(트랜잭션 안) */
export async function readRevision(tx: Transaction, db: Firestore, schoolCode: string): Promise<number> {
  const snap = await tx.get(schoolRef(db, schoolCode))
  const rev = snap.exists ? Number(snap.get('scheduleRevision') || 0) : 0
  return Number.isFinite(rev) ? rev : 0
}

export function writeRevision(tx: Transaction, db: Firestore, schoolCode: string, revision: number) {
  tx.set(
    schoolRef(db, schoolCode),
    { scheduleRevision: revision, timezone: 'Asia/Seoul', updatedAt: FieldValue.serverTimestamp() },
    { merge: true }
  )
}

export async function currentRevision(db: Firestore, schoolCode: string): Promise<number> {
  const snap = await schoolRef(db, schoolCode).get()
  return snap.exists ? Number(snap.get('scheduleRevision') || 0) : 0
}

// ───────────────────────── 감사 로그 ─────────────────────────

export interface AuditEntry {
  action: string
  actorUid: string
  target: string
  revision?: number
  before?: unknown
  after?: unknown
  reason?: string
  meta?: Record<string, unknown>
}

/** Firestore는 undefined를 저장하지 못하므로 일반 객체·배열 안의 undefined를 null로 바꿈(FieldValue 등은 그대로) */
export function stripUndefined<T>(v: T): T {
  if (v === undefined) return null as unknown as T
  if (Array.isArray(v)) return v.map((x) => stripUndefined(x)) as unknown as T
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = stripUndefined(x)
    return out as T
  }
  return v
}

/** 토큰·인증정보·학생 명단을 넣지 마세요 */
export function writeAudit(w: Transaction | WriteBatch, db: Firestore, schoolCode: string, entry: AuditEntry) {
  const ref = schoolRef(db, schoolCode).collection('audit').doc()
  ;(w as WriteBatch).set(ref, { ...stripUndefined(entry), at: FieldValue.serverTimestamp() })
}

// ───────────────────────── 문서 → 도메인 변환 ─────────────────────────

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const ymdOrNull = (v: unknown): Ymd | null => (isYmd(v) ? v : null)

export function courseFromDoc(id: string, d: Record<string, any>): Course {
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

/**
 * 시간표 가져오기(replace)가 그 날짜부터 정리한 수업인지(importRetiredOn <= 오늘 — 차시가 모두 끝나 빈 수업).
 * 수업 상태(status)는 그대로라 courseActiveOn으로는 알 수 없음 → 학생 공개 목록에서 빼고 새로 담지 못하게(다음 가져오기가 다시 쓰면 null)
 */
export function importRetiredBy(d: Record<string, any>, today: Ymd): boolean {
  return typeof d.importRetiredOn === 'string' && isYmd(d.importRetiredOn) && d.importRetiredOn <= today
}

export function seriesFromDoc(id: string, d: Record<string, any>): LessonSeries {
  return {
    seriesId: id,
    courseId: String(d.courseId || ''),
    weekday: Math.min(7, Math.max(1, Number(d.weekday) || 1)) as LessonSeries['weekday'],
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
    // 학급 시간표에서 온 차시만(없으면 키 자체를 넣지 않음 — 다른 차시의 모양은 그대로)
    ...(typeof d.sourceHomeroomId === 'string' && d.sourceHomeroomId ? { sourceHomeroomId: d.sourceHomeroomId } : {}),
  }
}

function slotFromDoc(t: any): SlotState | null {
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

export function overrideFromDoc(id: string, d: Record<string, any>): Override {
  const publishedAt = d.publishedAt && typeof d.publishedAt.toMillis === 'function' ? d.publishedAt.toMillis() : null
  const kindOk = ['cancel', 'reschedule', 'makeup', 'restore'].includes(d.kind)
  const changeSetKeys = Array.isArray(d.changeSetKeys) ? d.changeSetKeys.filter((k: unknown): k is string => typeof k === 'string' && k.includes('|')) : []
  return {
    overrideId: id,
    courseId: String(d.courseId || ''),
    occurrenceKey: String(d.occurrenceKey || ''),
    changeSetId: String(d.changeSetId || ''),
    ...(changeSetKeys.length ? { changeSetKeys } : {}),
    kind: kindOk ? d.kind : 'reschedule',
    seriesId: d.seriesId ? String(d.seriesId) : null,
    originalDate: ymdOrNull(d.originalDate),
    target: slotFromDoc(d.target),
    reason: d.reason ? String(d.reason) : undefined,
    revision: Number(d.revision) || 0,
    // '발행됨'으로 명시된 것만 적용(승인 대기·알 수 없는 상태·알 수 없는 종류는 적용하지 않음)
    status: d.status === 'published' && kindOk ? 'published' : 'withdrawn',
    publishedAt,
  }
}

export function enrollmentFromDoc(d: Record<string, any>): Enrollment {
  return {
    courseId: String(d.courseId || ''),
    uid: String(d.uid || ''),
    status: d.status === 'pending' ? 'pending' : d.status === 'ended' ? 'ended' : 'active',
    from: ymdOrNull(d.from),
    to: ymdOrNull(d.to),
    source: ['invite', 'roster', 'request', 'admin', 'legacy-group'].includes(d.source) ? d.source : 'admin',
    ...(d.via === 'group-qr' ? { via: 'group-qr' as const } : {}),
    ...(d.rejected === true ? { rejected: true } : {}),
    ...pastRangesOf(d.history),
  }
}

/**
 * 수강 문서 history(다시 참여할 때 남긴 이전 상태) → 이전에 들은 기간. 끝낸 수강 중 기간이 있는 것만(to 있음, from < to) —
 * 승인 대기에서 끝내거나 거절된 수강(to 없음)은 들은 기간이 없어 넣지 않음. 최근 20개까지
 */
function pastRangesOf(history: unknown): { past?: Array<{ from: Ymd | null; to: Ymd }> } {
  if (!Array.isArray(history)) return {}
  const past: Array<{ from: Ymd | null; to: Ymd }> = []
  history.slice(-20).forEach((h: any) => {
    if (!h || h.status !== 'ended') return
    const to = ymdOrNull(h.to)
    const from = ymdOrNull(h.from)
    if (!to || (from && from >= to)) return
    if (!past.some((r) => r.from === from && r.to === to)) past.push({ from, to })
  })
  return past.length ? { past } : {}
}

/**
 * 다시 참여할 때 선생님 승인이 필요한 수강인지(바로 담기 수업이어도 승인 대기):
 * 선생님이 끝내거나 거절한 수강(ended + decidedBy), 또는 그 뒤 다시 신청했다가 학생이 스스로 뺀 수강
 * (reapproval 표시 — 학생 빼기(leave)는 decidedBy를 비우지만 이 표시는 남김. 선생님이 승인·추가하면 지움).
 * 학생 신청(request·requestMany)·초대 수락·그룹 QR이 같은 규칙을 씀
 */
export function needsReapproval(cur: Record<string, any> | null | undefined): boolean {
  return !!cur && cur.status === 'ended' && (!!cur.decidedBy || cur.reapproval === true)
}

export function enrollmentId(courseId: string, uid: string): string {
  return `${courseId}__${uid}`
}

/**
 * 수업을 관리(일정 변경·수강 관리)할 수 있는 계정인지: 담당 교사(teacherUids) 또는 관리 교사(managerUids — 예: 공통 수업을 만든 담임).
 * 교사 '충돌' 판정에는 teacherUids만 씁니다(담임을 그 과목 교사로 오인하지 않도록).
 */
/** 수업을 관리할 수 있는 계정 전부(담당 교사 + 관리 교사, 중복 없음) — 승인 요청 대상 */
export function courseManagerUids(course: { teacherUids?: string[]; managerUids?: string[] }): string[] {
  return Array.from(new Set([...(course.teacherUids || []), ...(course.managerUids || [])]))
}

export function isCourseTeacher(course: { teacherUids?: string[]; managerUids?: string[] } | Record<string, any>, uid: string): boolean {
  if (!course || !uid) return false
  const t = Array.isArray((course as any).teacherUids) ? (course as any).teacherUids : []
  const m = Array.isArray((course as any).managerUids) ? (course as any).managerUids : []
  return t.includes(uid) || m.includes(uid)
}

export function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

/** 소속 학급: 수업 그룹이 소속처럼 저장된 예전 데이터는 소속으로 보지 않음 */
export function homeroomOf(user: Record<string, any>): { classId: string; isGroupLegacy: boolean } | null {
  const classId = typeof user.classId === 'string' ? user.classId : ''
  if (!classId) return null
  if (GROUP_RE.test(classId)) return { classId, isGroupLegacy: true }
  if (user.status !== 'approved') return null
  return { classId, isGroupLegacy: false }
}

// ───────────────────────── 영향 학생 / 알림 ─────────────────────────

/** 수업들을 듣는 학생 uid(활성 수강 + 공통 수업의 소속 학급 승인 학생). 명단을 응답에 넣지 말고 수만 쓰세요. */
export async function studentUidsForCourses(db: Firestore, schoolCode: string, courseIds: string[]): Promise<Set<string>> {
  const uids = new Set<string>()
  if (!courseIds.length) return uids
  const sref = schoolRef(db, schoolCode)
  for (const ids of chunk(courseIds, 30)) {
    const es = await sref.collection('enrollments').where('courseId', 'in', ids).where('status', '==', 'active').get()
    es.forEach((d) => {
      const uid = d.get('uid')
      if (typeof uid === 'string') uids.add(uid)
    })
    const cs = await db.getAll(...ids.map((id) => sref.collection('courses').doc(id)))
    const homerooms = new Set<string>()
    cs.forEach((c) => strArr(c.get('commonForHomerooms')).forEach((h) => homerooms.add(h)))
    for (const hs of chunk(Array.from(homerooms), 30)) {
      const us = await db
        .collection('users')
        .where('classId', 'in', hs)
        .where('role', '==', 'student')
        .where('status', '==', 'approved')
        .get()
      us.forEach((u) => uids.add(u.id))
    }
  }
  return uids
}

/** 사용자별 1건 알림(문서 id로 중복 방지) + 푸시. 같은 dedupeId로 다시 부르면 다시 보내지 않음 */
export async function notifyUsersOnce(
  db: Firestore,
  uids: string[],
  dedupeId: string,
  msg: { title: string; body: string; url: string }
): Promise<{ created: number; skipped: number }> {
  let created = 0
  let skipped = 0
  for (const group of chunk(uids, 20)) {
    await Promise.all(
      group.map(async (uid) => {
        const ref = db.collection('users').doc(uid).collection('notifications').doc(dedupeId)
        try {
          await ref.create({ ...msg, createdAt: FieldValue.serverTimestamp(), read: false })
          created++
        } catch {
          skipped++ // 이미 보냄(같은 변경 재시도·중복 이벤트)
          return
        }
        try {
          await Promise.race([sendPushToUser(uid, msg), new Promise((r) => setTimeout(r, 3000))])
        } catch (e) {
          console.error('timetable notify push failed', (e as Error)?.message)
        }
      })
    )
  }
  return { created, skipped }
}

/** 클라이언트에서 받은 문자열 정리 */
export function cleanText(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : ''
}
