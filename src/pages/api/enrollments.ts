import type { NextApiRequest, NextApiResponse } from 'next'
import { FieldValue, type DocumentReference, type DocumentSnapshot, type Firestore, type Transaction } from 'firebase-admin/firestore'
import { schoolYmdAt } from '../../lib/timetable/dates'
import { courseActiveOn } from '../../lib/timetable/engine'
import {
  apiError,
  courseFromDoc,
  enrollmentFromDoc,
  enrollmentId,
  ID_RE,
  importRetiredBy,
  isTeacher,
  needsReapproval,
  notifyUsersOnce,
  readRevision,
  requireUser,
  schoolRef,
  writeAudit,
  writeRevision,
  type ApiUser,
} from '../../lib/timetable/server'
import {
  canManageCourse,
  getDocsById,
  readTermDocs,
  studentHomeroomLabel,
  termForDateFromDocs,
  TimetableApiError,
  toStudentNo,
} from '../../lib/timetable/studentData'
import { AttemptLimiter } from '../../lib/invitations'
import type { EnrollmentStatus, Ymd } from '../../lib/timetable/types'

// POST /api/enrollments  { action, ... }
// Header: Authorization: Bearer <Firebase ID token>
// 학생 ↔ 수업반 수강(schools/{s}/enrollments/{courseId}__{uid})을 서버에서만 바꿉니다. 문서 id가 결정적이라 중복 수강이 생기지 않습니다.
// - request {courseId}            학생: 같은 학교·공개(catalogVisible)·운영 중(가져오기 종료일 지남 아님)·지금 학기 수업만.
//                                  invitePolicy 'auto'면 active, 아니면 pending. 이미 active/pending이면 같은 결과(already).
//                                  선생님이 끝내거나 거절한 수강은 다시 신청하면 승인 대기 — 표시(reapproval)가 남아 학생이 빼고 다시 담아도
//                                  승인 대기(선생님이 승인·추가하면 표시를 지움)
// - requestMany {courseIds}       학생 '수업 담기': 최대 20개, 수업마다 request와 같은 규칙으로 따로 판정(일부 성공 가능) →
//                                  results[{courseId, ok, status?, already?, code?, error?}]. 바뀐 게 있으면 scheduleRevision +1·감사 1건
// - leave {courseId}              학생: 내가 직접 담은(source 'request') active·pending 수강만 빼기(to=오늘, 지난 날짜 그대로).
//                                  학교가 넣어 준 수강(초대·명단·선생님 추가·예전 그룹)은 403 not-self-picked.
//                                  같은 수업은 하루 한 번만 뺄 수 있음(429 left-today — 담기·빼기 반복으로 학교 전체 갱신을 흔들지 못하게)
// - approve/reject/end {courseId, uid}  담당 교사. end는 to=오늘(오늘부터 시간표에서 빠짐, 지난 날짜는 그대로)
// - add {courseId, uid}           담당 교사: 같은 학교 학생 계정만, source 'admin', active
// - list {courseId}               담당 교사: 학생 이름·번호·소속 반·상태 / {mine:true} 본인 수강 + 수업 제목
// 수강이 바뀌면 schools/{s}.scheduleRevision +1(학생 화면 갱신 신호) + 감사 로그.
// 수업에 legacyGroupId가 있으면 active가 될 때 학생 users.extraClassIds에 그 그룹을 추가(톡방·공지 호환). 끝낼 때 빼지는 않음.
// 학생 신청·빼기는 uid별 요청 수 제한(10분 20회, 빼기는 따로 1시간 10회 — 넘으면 429 rate-limited)
// 오류: { error, code } — 400 입력, 403 권한, 404 대상 없음, 409 상태 충돌, 429 요청 과다, 500 server-error

interface Ctx {
  u: ApiUser
  db: Firestore
  uid: string
  schoolCode: string
  body: Record<string, any>
  today: Ymd
}

function fail(status: number, code: string, message: string, extra?: Record<string, unknown>): never {
  throw new TimetableApiError(status, code, message, extra)
}

function idField(v: unknown, label: string): string {
  if (typeof v !== 'string' || !ID_RE.test(v)) fail(400, 'invalid-id', `${label} 값이 올바르지 않아요.`)
  return v as string
}

function requireTeacher(ctx: Ctx) {
  if (!isTeacher(ctx.u)) fail(403, 'teacher-only', '선생님 계정만 할 수 있어요.')
}

const refs = (ctx: Ctx, courseId: string, uid: string) => {
  const sref = schoolRef(ctx.db, ctx.schoolCode)
  return {
    course: sref.collection('courses').doc(courseId),
    enrollment: sref.collection('enrollments').doc(enrollmentId(courseId, uid)),
    user: ctx.db.collection('users').doc(uid),
  }
}

/** 담당 교사 확인 + 수업 문서 */
async function managedCourse(tx: Transaction, ctx: Ctx, courseRef: DocumentReference) {
  const snap = await tx.get(courseRef)
  if (!snap.exists) fail(404, 'course-not-found', '수업을 찾을 수 없어요.')
  const course = snap.data() || {}
  if (!canManageCourse(course, ctx.uid)) fail(403, 'not-course-teacher', '담당 선생님만 수강생을 관리할 수 있어요.')
  return course
}

/** 대상이 같은 학교 학생 계정인지. 다른 학교·없는 계정은 구분하지 않고 같은 오류(존재 여부 노출 방지) */
function assertSameSchoolStudent(ctx: Ctx, snap: DocumentSnapshot) {
  const v = snap.exists ? snap.data() || {} : null
  if (!v || v.role !== 'student' || String(v.schoolCode || '') !== ctx.schoolCode) {
    fail(404, 'student-not-found', '같은 학교 학생만 수업에 추가할 수 있어요.')
  }
}

/** active가 될 때: 예전 수업 그룹(톡방·공지)에도 참여 */
function joinLegacyGroup(tx: Transaction, ctx: Ctx, course: Record<string, any>, uid: string) {
  const gid = typeof course.legacyGroupId === 'string' && ID_RE.test(course.legacyGroupId) ? course.legacyGroupId : ''
  if (!gid) return
  tx.set(ctx.db.collection('users').doc(uid), { extraClassIds: FieldValue.arrayUnion(gid) }, { merge: true })
}

function historyItem(cur: Record<string, any>) {
  return {
    status: cur.status ?? null,
    from: cur.from ?? null,
    to: cur.to ?? null,
    source: cur.source ?? null,
    decidedBy: cur.decidedBy ?? null,
  }
}

interface WriteResult {
  ok: true
  courseId: string
  uid: string
  status: EnrollmentStatus
  already?: boolean
  revision: number
}

/** 수강 문서 쓰기 + 버전 + 감사(트랜잭션 안, 모든 읽기 뒤) */
function commitEnrollment(
  tx: Transaction,
  ctx: Ctx,
  rev0: number,
  r: ReturnType<typeof refs>,
  cur: Record<string, any> | null,
  next: Record<string, any>,
  action: string,
  courseId: string,
  uid: string
): WriteResult {
  const rev = rev0 + 1
  const data: Record<string, any> = {
    courseId,
    uid,
    schoolCode: ctx.schoolCode,
    ...next,
    updatedAt: FieldValue.serverTimestamp(),
  }
  if (!cur) data.createdAt = FieldValue.serverTimestamp()
  else if (cur.status === 'ended' && next.status !== 'ended') data.history = FieldValue.arrayUnion(historyItem(cur))
  tx.set(r.enrollment, data, { merge: true })
  writeRevision(tx, ctx.db, ctx.schoolCode, rev)
  writeAudit(tx, ctx.db, ctx.schoolCode, {
    action,
    actorUid: ctx.uid,
    target: `enrollments/${enrollmentId(courseId, uid)}`,
    revision: rev,
    before: cur ? { status: cur.status ?? null, from: cur.from ?? null, to: cur.to ?? null } : null,
    after: { status: next.status, from: next.from ?? cur?.from ?? null, to: next.to ?? null },
  })
  return { ok: true, courseId, uid, status: next.status, revision: rev }
}

// ───────────────────────── 학생 신청(한 개·여러 개)·빼기 ─────────────────────────

/** 학생 신청·빼기 요청 수 제한(uid별, 인스턴스 메모리 — best-effort). 수강이 바뀔 때마다 학교 scheduleRevision이 올라
 *  같은 학교 학생 화면이 모두 다시 받으므로, 한 학생이 신청·빼기를 반복해 학교 전체를 흔들지 못하게 상한을 둡니다.
 *  여러 개 담기(requestMany)는 한 번에 한 건으로 셈. 오래 남는 상한은 수강 문서의 leftOn(같은 수업 하루 한 번 빼기) */
const STUDENT_WRITE_MAX = 20
const studentWriteLimiter = new AttemptLimiter({ windowMs: 10 * 60 * 1000, max: STUDENT_WRITE_MAX, maxKeys: 20000 })
const LEAVE_MAX = 10
const leaveLimiter = new AttemptLimiter({ windowMs: 60 * 60 * 1000, max: LEAVE_MAX, maxKeys: 20000 })

function requireStudent(ctx: Ctx) {
  if (ctx.u.user.role !== 'student') fail(403, 'student-only', '학생 계정만 수강 신청을 할 수 있어요.')
}

/** 세기 전에 확인 — 창 안에서 정확히 max번까지 받고 max+1번째부터 429 */
function hitLimit(limiter: AttemptLimiter, key: string) {
  if (limiter.limited(key)) fail(429, 'rate-limited', '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.')
  limiter.hit(key)
}

function hitStudentLimit(ctx: Ctx) {
  hitLimit(studentWriteLimiter, ctx.uid)
}

/** 한 번에 담을 수 있는 수업 수(requestMany) */
const REQUEST_MANY_MAX = 20

type RequestPlan =
  | { kind: 'error'; status: number; code: string; message: string }
  | { kind: 'already'; status: EnrollmentStatus }
  | { kind: 'write'; next: Record<string, any>; legacyGroupId: string | null; notifyTo: string[] }

/**
 * 학생 신청 규칙(request·requestMany가 같이 씀) — 트랜잭션에서 읽은 수업·수강 문서로 결정
 *  - 같은 학교: 수업 문서를 요청자 학교 경로(schools/{내 학교}/courses)에서만 읽음 → 다른 학교 수업은 course-not-found
 *  - 학교가 공개(catalogVisible)한 수업만, 운영 중(종료·종료일 지남·가져오기 종료일(importRetiredOn) 지남 아님),
 *    지금 학기 수업만(공개 목록과 같은 학기)
 *  - 수강 문서 id는 courseId__uid(결정적) — 이미 active/pending이면 같은 결과(already, 쓰기 없음)
 *  - invitePolicy 'auto'면 active(오늘부터), 아니면 pending. 선생님이 끝내거나 거절한 수강(ended + decidedBy)은 다시 승인 대기.
 *    그 표시(reapproval)는 다시 신청한 문서에도 남김 — 학생이 승인 대기를 빼도(leave는 decidedBy를 비움) 다음 신청이 다시 승인 대기.
 *    선생님이 승인·추가하면 표시를 지움(decide)
 */
function planRequest(ctx: Ctx, courseId: string, course: Record<string, any> | null, cur: Record<string, any> | null, termId: string): RequestPlan {
  if (!course) return { kind: 'error', status: 404, code: 'course-not-found', message: '수업을 찾을 수 없어요.' }
  if (course.catalogVisible !== true) {
    return { kind: 'error', status: 403, code: 'not-open', message: '공개된 수업만 신청할 수 있어요. 선생님께 수업 초대를 받아 주세요.' }
  }
  if (!courseActiveOn(courseFromDoc(courseId, course), ctx.today) || importRetiredBy(course, ctx.today)) {
    return { kind: 'error', status: 409, code: 'course-ended', message: '이미 끝난 수업이에요.' }
  }
  if (course.termId && String(course.termId) !== termId) {
    return { kind: 'error', status: 409, code: 'other-term', message: '이번 학기 수업만 담을 수 있어요.' }
  }
  if (cur && (cur.status === 'active' || cur.status === 'pending')) return { kind: 'already', status: cur.status as EnrollmentStatus }
  // 선생님이 끝내거나 거절한 수강은 자동 참여 수업이어도 다시 승인을 받아야 함. 학생이 스스로 뺀 수강은 decidedBy가 없어 처음처럼 —
  // 단 선생님이 끝낸 뒤 다시 신청한 승인 대기를 학생이 뺀 경우는 reapproval 표시가 남아 있어 여전히 승인 대기
  const removedByTeacher = needsReapproval(cur)
  const status: EnrollmentStatus = course.invitePolicy === 'approval' || removedByTeacher ? 'pending' : 'active'
  const next = {
    termId: String(course.termId || ''),
    status,
    from: status === 'active' ? ctx.today : null,
    to: null,
    source: 'request',
    requestedAt: FieldValue.serverTimestamp(),
    decidedBy: null,
    rejected: false,
    reapproval: removedByTeacher,
  }
  const gid = typeof course.legacyGroupId === 'string' && ID_RE.test(course.legacyGroupId) ? course.legacyGroupId : null
  return {
    kind: 'write',
    next,
    legacyGroupId: status === 'active' ? gid : null,
    notifyTo:
      status === 'pending'
        ? Array.from(new Set([...(course.teacherUids || []), ...(course.managerUids || [])])).filter((x): x is string => typeof x === 'string' && ID_RE.test(x))
        : [],
  }
}

/** 승인 대기 알림: 수업·학생·날짜마다 한 번만(같은 학생이 반복 신청해도 쌓이지 않게 — request·requestMany 같은 id). 실패해도 신청은 성공 */
async function notifyPending(ctx: Ctx, courseId: string, to: string[]) {
  if (!to.length) return
  try {
    await notifyUsersOnce(ctx.db, to, `enr_${courseId}__${ctx.uid}_${ctx.today}`, {
      title: '수강 신청',
      body: `${String(ctx.u.user.name || ctx.u.user.displayName || '학생')} 학생이 수업 참여를 기다려요`,
      url: '/teacher/courses',
    })
  } catch (e) {
    console.error('enrollments: notify failed', (e as Error)?.message)
  }
}

async function currentTermId(ctx: Ctx): Promise<string> {
  return termForDateFromDocs(await readTermDocs(ctx.db, ctx.schoolCode), ctx.today).termId
}

async function requestEnrollment(ctx: Ctx) {
  requireStudent(ctx)
  const courseId = idField(ctx.body.courseId, '수업')
  hitStudentLimit(ctx)
  const termId = await currentTermId(ctx)
  const r = refs(ctx, courseId, ctx.uid)
  let notifyTo: string[] = []
  const result = await ctx.db.runTransaction(async (tx) => {
    const courseSnap = await tx.get(r.course)
    const enrSnap = await tx.get(r.enrollment)
    const rev0 = await readRevision(tx, ctx.db, ctx.schoolCode)
    const cur = enrSnap.exists ? enrSnap.data() || {} : null
    const plan = planRequest(ctx, courseId, courseSnap.exists ? courseSnap.data() || {} : null, cur, termId)
    if (plan.kind === 'error') fail(plan.status, plan.code, plan.message)
    if (plan.kind === 'already') return { ok: true as const, courseId, uid: ctx.uid, status: plan.status, already: true, revision: rev0 }
    if (plan.legacyGroupId) tx.set(r.user, { extraClassIds: FieldValue.arrayUnion(plan.legacyGroupId) }, { merge: true })
    notifyTo = plan.notifyTo
    return commitEnrollment(tx, ctx, rev0, r, cur, plan.next, 'enrollment.request', courseId, ctx.uid)
  })
  if (!result.already) await notifyPending(ctx, courseId, notifyTo)
  return result
}

interface ManyItemResult {
  courseId: string
  ok: boolean
  /** 성공: 이번 결과 상태(active 추가됨 / pending 승인 대기) */
  status?: EnrollmentStatus
  already?: boolean
  /** 실패: 'request'와 같은 code·문구 */
  code?: string
  error?: string
}

/**
 * 여러 수업 한 번에 담기(학생). 수업마다 'request'와 같은 규칙으로 따로 판정(일부만 성공 가능).
 * 바뀐 수강이 있으면 학교 scheduleRevision +1 한 번, 감사 로그 한 건. 승인 대기 알림은 'request'와 같은 id라 겹치지 않음
 */
async function requestMany(ctx: Ctx) {
  requireStudent(ctx)
  const raw = ctx.body.courseIds
  if (!Array.isArray(raw) || !raw.length) fail(400, 'missing-field', '담을 수업을 골라 주세요.')
  if (raw.length > REQUEST_MANY_MAX) fail(400, 'too-many', `한 번에 ${REQUEST_MANY_MAX}개까지 담을 수 있어요.`, { max: REQUEST_MANY_MAX })
  if ((raw as unknown[]).some((x) => typeof x !== 'string' || x.length > 200)) fail(400, 'invalid-field', '수업 목록 형식이 올바르지 않아요.')
  const ids = Array.from(new Set(raw as string[]))
  hitStudentLimit(ctx)
  const termId = await currentTermId(ctx)
  const valid = ids.filter((id) => ID_RE.test(id))
  const sref = schoolRef(ctx.db, ctx.schoolCode)
  const userRef = ctx.db.collection('users').doc(ctx.uid)
  const notify: Array<{ courseId: string; to: string[] }> = []

  const out = await ctx.db.runTransaction(async (tx) => {
    notify.length = 0
    const courseRefs = valid.map((id) => sref.collection('courses').doc(id))
    const enrRefs = valid.map((id) => sref.collection('enrollments').doc(enrollmentId(id, ctx.uid)))
    const snaps = valid.length ? await tx.getAll(...courseRefs, ...enrRefs) : []
    const rev0 = await readRevision(tx, ctx.db, ctx.schoolCode)
    const courseById = new Map<string, Record<string, any> | null>()
    const enrById = new Map<string, Record<string, any> | null>()
    valid.forEach((id, i) => {
      const c = snaps[i]
      const e = snaps[valid.length + i]
      courseById.set(id, c && c.exists ? c.data() || {} : null)
      enrById.set(id, e && e.exists ? e.data() || {} : null)
    })

    const results: ManyItemResult[] = []
    const writes: Array<{ courseId: string; cur: Record<string, any> | null; next: Record<string, any> }> = []
    const groups = new Set<string>()
    ids.forEach((courseId) => {
      if (!ID_RE.test(courseId)) {
        results.push({ courseId, ok: false, code: 'invalid-id', error: '수업 값이 올바르지 않아요.' })
        return
      }
      const cur = enrById.get(courseId) ?? null
      const plan = planRequest(ctx, courseId, courseById.get(courseId) ?? null, cur, termId)
      if (plan.kind === 'error') {
        results.push({ courseId, ok: false, code: plan.code, error: plan.message })
        return
      }
      if (plan.kind === 'already') {
        results.push({ courseId, ok: true, status: plan.status, already: true })
        return
      }
      writes.push({ courseId, cur, next: plan.next })
      if (plan.legacyGroupId) groups.add(plan.legacyGroupId)
      if (plan.notifyTo.length) notify.push({ courseId, to: plan.notifyTo })
      results.push({ courseId, ok: true, status: plan.next.status })
    })
    if (!writes.length) return { results, revision: rev0, changed: 0 }

    const rev = rev0 + 1
    writes.forEach((w) => {
      const data: Record<string, any> = {
        courseId: w.courseId,
        uid: ctx.uid,
        schoolCode: ctx.schoolCode,
        ...w.next,
        updatedAt: FieldValue.serverTimestamp(),
      }
      if (!w.cur) data.createdAt = FieldValue.serverTimestamp()
      else if (w.cur.status === 'ended') data.history = FieldValue.arrayUnion(historyItem(w.cur))
      tx.set(sref.collection('enrollments').doc(enrollmentId(w.courseId, ctx.uid)), data, { merge: true })
    })
    // 예전 수업 그룹(톡방·공지)은 한 번에(같은 문서를 여러 번 쓰지 않게)
    if (groups.size) tx.set(userRef, { extraClassIds: FieldValue.arrayUnion(...Array.from(groups)) }, { merge: true })
    writeRevision(tx, ctx.db, ctx.schoolCode, rev)
    writeAudit(tx, ctx.db, ctx.schoolCode, {
      action: 'enrollment.requestMany',
      actorUid: ctx.uid,
      target: `enrollments/*__${ctx.uid}`,
      revision: rev,
      // 본인 수강만 — 수업 id와 상태 변화(다른 학생 정보 없음)
      meta: {
        requested: ids.length,
        changed: writes.length,
        items: writes.map((w) => ({ courseId: w.courseId, before: w.cur ? w.cur.status ?? null : null, after: w.next.status })),
      },
    })
    return { results, revision: rev, changed: writes.length }
  })
  for (const n of notify) await notifyPending(ctx, n.courseId, n.to)
  return { ok: true, ...out }
}

/**
 * 내가 직접 담은 수업 빼기(학생). 본인 수강 중 출처가 'request'(학생 신청)인 active·pending만.
 * 초대·명단·선생님 추가·예전 그룹 수강은 403 not-self-picked(선생님께 문의). 반 공통 수업은 수강 문서가 없어 404.
 * 'end'와 같은 기간 규칙: active는 to=오늘(오늘부터 빠지고 지난 날짜 기록은 그대로), pending은 기간 없이 종료.
 * decidedBy는 비워 둠 — 다시 담으면 처음 신청처럼(바로 담기 수업은 바로 참여). 단 reapproval(선생님이 끝낸 뒤 다시 신청)은
 * 건드리지 않음(merge로 남음) → 다시 담아도 승인 대기.
 * 같은 수업은 하루 한 번만(leftOn = 오늘이면 429 left-today): 담기·빼기를 되풀이해 학교 scheduleRevision을 계속 올리지 못하게
 */
async function leaveEnrollment(ctx: Ctx) {
  requireStudent(ctx)
  const courseId = idField(ctx.body.courseId, '수업')
  hitStudentLimit(ctx)
  hitLimit(leaveLimiter, ctx.uid)
  const r = refs(ctx, courseId, ctx.uid)
  return ctx.db.runTransaction(async (tx) => {
    const enrSnap = await tx.get(r.enrollment)
    const rev0 = await readRevision(tx, ctx.db, ctx.schoolCode)
    const cur = enrSnap.exists ? enrSnap.data() || {} : null
    if (!cur || String(cur.uid || '') !== ctx.uid) fail(404, 'enrollment-not-found', '내가 담은 수업이 아니에요.')
    if (cur.source !== 'request') fail(403, 'not-self-picked', '학교에서 넣어 준 수업은 직접 뺄 수 없어요. 선생님께 문의해 주세요.')
    const status = enrollmentFromDoc(cur).status
    if (status === 'ended') return { ok: true, courseId, uid: ctx.uid, status: 'ended' as EnrollmentStatus, already: true, revision: rev0 }
    if (cur.leftOn === ctx.today) fail(429, 'left-today', '오늘은 이미 뺀 수업이에요. 내일 다시 시도해 주세요.')
    const left = { decidedBy: null, leftBy: ctx.uid, leftOn: ctx.today, leftAt: FieldValue.serverTimestamp(), rejected: false }
    const from = typeof cur.from === 'string' ? cur.from : null
    const next =
      status === 'active'
        ? { status: 'ended', to: from && from > ctx.today ? from : ctx.today, ...left }
        : { status: 'ended', to: null, ...left }
    return commitEnrollment(tx, ctx, rev0, r, cur, next, 'enrollment.leave', courseId, ctx.uid)
  })
}

// ───────────────────────── 담당 교사 ─────────────────────────

async function decide(ctx: Ctx, action: 'approve' | 'reject' | 'end' | 'add') {
  requireTeacher(ctx)
  const courseId = idField(ctx.body.courseId, '수업')
  const uid = idField(ctx.body.uid, '학생')
  const r = refs(ctx, courseId, uid)
  return ctx.db.runTransaction(async (tx) => {
    const course = await managedCourse(tx, ctx, r.course)
    const [enrSnap, userSnap] = await Promise.all([tx.get(r.enrollment), tx.get(r.user)])
    const rev0 = await readRevision(tx, ctx.db, ctx.schoolCode)
    const cur = enrSnap.exists ? enrSnap.data() || {} : null
    const status = cur ? enrollmentFromDoc(cur).status : null
    const same = (s: EnrollmentStatus): WriteResult => ({ ok: true, courseId, uid, status: s, already: true, revision: rev0 })
    const decided = { decidedBy: ctx.uid, decidedAt: FieldValue.serverTimestamp() }

    if (action === 'add') {
      assertSameSchoolStudent(ctx, userSnap)
      if (!courseActiveOn(courseFromDoc(courseId, course), ctx.today)) fail(409, 'course-ended', '이미 끝난 수업이에요.')
      if (status === 'active') return same('active')
      joinLegacyGroup(tx, ctx, course, uid)
      const next =
        status === 'pending'
          ? { status: 'active', from: ctx.today, to: null, rejected: false, reapproval: false, ...decided }
          : { termId: String(course.termId || ''), status: 'active', from: ctx.today, to: null, source: 'admin', rejected: false, reapproval: false, ...decided }
      return commitEnrollment(tx, ctx, rev0, r, cur, next, 'enrollment.add', courseId, uid)
    }

    if (!cur) fail(404, 'enrollment-not-found', '이 학생의 수강 정보가 없어요.')

    if (action === 'approve') {
      if (status === 'active') return same('active')
      if (status !== 'pending') fail(409, 'not-pending', '승인 대기 중인 신청이 아니에요.')
      assertSameSchoolStudent(ctx, userSnap)
      if (!courseActiveOn(courseFromDoc(courseId, course), ctx.today)) fail(409, 'course-ended', '이미 끝난 수업이에요.')
      joinLegacyGroup(tx, ctx, course, uid)
      return commitEnrollment(tx, ctx, rev0, r, cur, { status: 'active', from: ctx.today, to: null, rejected: false, reapproval: false, ...decided }, 'enrollment.approve', courseId, uid)
    }

    if (action === 'reject') {
      if (status === 'ended') return same('ended')
      if (status !== 'pending') fail(409, 'not-pending', '이미 참여 중인 학생은 수강 종료로 처리해 주세요.')
      return commitEnrollment(tx, ctx, rev0, r, cur, { status: 'ended', to: null, rejected: true, ...decided }, 'enrollment.reject', courseId, uid)
    }

    // end: 오늘부터 시간표에서 빠짐(지난 날짜 기록은 유지). 그룹 톡방은 담당 교사가 따로 관리하므로 빼지 않음
    if (status === 'ended') return same('ended')
    const next = status === 'active' ? { status: 'ended', to: ctx.today, ...decided } : { status: 'ended', to: null, ...decided }
    return commitEnrollment(tx, ctx, rev0, r, cur, next, 'enrollment.end', courseId, uid)
  })
}

// ───────────────────────── 목록 ─────────────────────────

async function listEnrollments(ctx: Ctx) {
  const sref = schoolRef(ctx.db, ctx.schoolCode)
  if (ctx.body.mine === true) {
    // 본인 수강만(다른 학생 정보 없음)
    const snap = await sref.collection('enrollments').where('uid', '==', ctx.uid).get()
    const mine = snap.docs.map((d) => enrollmentFromDoc(d.data() || {})).filter((e) => e.uid === ctx.uid && e.courseId)
    const courseSnaps = await getDocsById(ctx.db, mine.map((e) => sref.collection('courses').doc(e.courseId)))
    const byId = new Map(courseSnaps.filter((s) => s.exists).map((s) => [s.id, s.data() || {}] as const))
    return {
      enrollments: mine.map((e) => {
        const c = byId.get(e.courseId)
        return {
          courseId: e.courseId,
          status: e.status,
          from: e.from ?? null,
          to: e.to ?? null,
          source: e.source,
          course: c
            ? {
                title: String(c.title || c.subject || '수업'),
                subject: String(c.subject || ''),
                section: c.section ? String(c.section) : null,
                teacherNames: Array.isArray(c.teacherNames) ? c.teacherNames.filter((x: unknown) => typeof x === 'string') : [],
                status: c.status === 'ended' ? 'ended' : 'active',
                endedOn: typeof c.endedOn === 'string' ? c.endedOn : null,
              }
            : null,
        }
      }),
    }
  }

  requireTeacher(ctx)
  const courseId = idField(ctx.body.courseId, '수업')
  const courseSnap = await sref.collection('courses').doc(courseId).get()
  if (!courseSnap.exists) fail(404, 'course-not-found', '수업을 찾을 수 없어요.')
  if (!canManageCourse(courseSnap.data(), ctx.uid)) fail(403, 'not-course-teacher', '담당 선생님만 수강생 명단을 볼 수 있어요.')
  const snap = await sref.collection('enrollments').where('courseId', '==', courseId).get()
  const rows = snap.docs.map((d) => enrollmentFromDoc(d.data() || {})).filter((e) => e.uid)
  const users = await getDocsById(ctx.db, rows.map((e) => ctx.db.collection('users').doc(e.uid)))
  const userById = new Map(users.map((s) => [s.id, s.exists ? s.data() || {} : null] as const))
  const counts = { active: 0, pending: 0, ended: 0 }
  const students = rows.map((e) => {
    counts[e.status]++
    const v = userById.get(e.uid)
    return {
      uid: e.uid,
      name: v ? String(v.name || v.displayName || '이름 없음') : '탈퇴한 학생',
      studentId: v ? toStudentNo(v.studentId) : null,
      homeroomLabel: v ? studentHomeroomLabel(v) : '',
      status: e.status,
      from: e.from ?? null,
      to: e.to ?? null,
      source: e.source,
    }
  })
  const order = { pending: 0, active: 1, ended: 2 } as const
  students.sort(
    (a, b) =>
      order[a.status] - order[b.status] ||
      a.homeroomLabel.localeCompare(b.homeroomLabel, 'ko') ||
      (a.studentId ?? 999) - (b.studentId ?? 999) ||
      a.name.localeCompare(b.name, 'ko')
  )
  return { courseId, counts, students }
}

// ───────────────────────── 핸들러 ─────────────────────────

const ACTIONS: Record<string, (ctx: Ctx) => Promise<unknown>> = {
  request: requestEnrollment,
  requestMany,
  leave: leaveEnrollment,
  approve: (ctx) => decide(ctx, 'approve'),
  reject: (ctx) => decide(ctx, 'reject'),
  end: (ctx) => decide(ctx, 'end'),
  add: (ctx) => decide(ctx, 'add'),
  list: listEnrollments,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'private, no-store')
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return apiError(res, 405, 'method-not-allowed', '허용되지 않는 요청이에요.')
  }
  let u: ApiUser | null
  try {
    u = await requireUser(req, res)
  } catch (e) {
    console.error('enrollments: auth failed', (e as Error)?.message)
    return apiError(res, 500, 'server-error', '사용자 정보를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.')
  }
  if (!u) return
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, any>) : {}
  const action = typeof body.action === 'string' ? body.action : ''
  const run = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null
  if (!run) return apiError(res, 400, 'bad-action', '알 수 없는 요청이에요.')
  const schoolCode = typeof u.user.schoolCode === 'string' ? u.user.schoolCode : ''
  if (!schoolCode) return apiError(res, 409, 'no-school', '학교 정보가 없어요. 내 정보에서 학교를 먼저 확인해 주세요.')

  const ctx: Ctx = { u, db: u.db, uid: u.uid, schoolCode, body, today: schoolYmdAt(Date.now()) }
  try {
    return res.status(200).json(await run(ctx))
  } catch (e) {
    if (e instanceof TimetableApiError) return res.status(e.status).json({ error: e.message, code: e.code, ...(e.extra || {}) })
    console.error('enrollments: failed', action, String((e as Error)?.message || '').slice(0, 200))
    return apiError(res, 500, 'server-error', '처리하지 못했어요. 잠시 후 다시 시도해 주세요.')
  }
}
