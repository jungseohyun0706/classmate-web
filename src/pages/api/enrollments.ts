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
  isTeacher,
  notifyUsersOnce,
  readRevision,
  requireUser,
  schoolRef,
  writeAudit,
  writeRevision,
  type ApiUser,
} from '../../lib/timetable/server'
import { canManageCourse, getDocsById, studentHomeroomLabel, TimetableApiError, toStudentNo } from '../../lib/timetable/studentData'
import type { EnrollmentStatus, Ymd } from '../../lib/timetable/types'

// POST /api/enrollments  { action, ... }
// Header: Authorization: Bearer <Firebase ID token>
// 학생 ↔ 수업반 수강(schools/{s}/enrollments/{courseId}__{uid})을 서버에서만 바꿉니다. 문서 id가 결정적이라 중복 수강이 생기지 않습니다.
// - request {courseId}            학생: 같은 학교·공개(catalogVisible)·운영 중 수업만. invitePolicy 'auto'면 active, 아니면 pending.
//                                  이미 active/pending이면 같은 결과(already). 선생님이 끝내거나 거절한 수강은 다시 신청하면 승인 대기.
// - approve/reject/end {courseId, uid}  담당 교사. end는 to=오늘(오늘부터 시간표에서 빠짐, 지난 날짜는 그대로)
// - add {courseId, uid}           담당 교사: 같은 학교 학생 계정만, source 'admin', active
// - list {courseId}               담당 교사: 학생 이름·번호·소속 반·상태 / {mine:true} 본인 수강 + 수업 제목
// 수강이 바뀌면 schools/{s}.scheduleRevision +1(학생 화면 갱신 신호) + 감사 로그.
// 수업에 legacyGroupId가 있으면 active가 될 때 학생 users.extraClassIds에 그 그룹을 추가(톡방·공지 호환). 끝낼 때 빼지는 않음.
// 오류: { error, code } — 400 입력, 403 권한, 404 대상 없음, 409 상태 충돌, 500 server-error

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

// ───────────────────────── 학생 신청 ─────────────────────────

async function requestEnrollment(ctx: Ctx) {
  if (ctx.u.user.role !== 'student') fail(403, 'student-only', '학생 계정만 수강 신청을 할 수 있어요.')
  const courseId = idField(ctx.body.courseId, '수업')
  const r = refs(ctx, courseId, ctx.uid)
  let notifyTo: string[] = []
  const result = await ctx.db.runTransaction(async (tx) => {
    const courseSnap = await tx.get(r.course)
    if (!courseSnap.exists) fail(404, 'course-not-found', '수업을 찾을 수 없어요.')
    const course = courseSnap.data() || {}
    if (course.catalogVisible !== true) fail(403, 'not-open', '공개된 수업만 신청할 수 있어요. 선생님께 수업 초대를 받아 주세요.')
    if (!courseActiveOn(courseFromDoc(courseId, course), ctx.today)) fail(409, 'course-ended', '이미 끝난 수업이에요.')
    const enrSnap = await tx.get(r.enrollment)
    const rev0 = await readRevision(tx, ctx.db, ctx.schoolCode)
    const cur = enrSnap.exists ? enrSnap.data() || {} : null
    if (cur && (cur.status === 'active' || cur.status === 'pending')) {
      return { ok: true as const, courseId, uid: ctx.uid, status: cur.status as EnrollmentStatus, already: true, revision: rev0 }
    }
    // 선생님이 끝내거나 거절한 수강은 자동 참여 수업이어도 다시 승인을 받아야 함
    const removedByTeacher = !!cur && cur.status === 'ended' && !!cur.decidedBy
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
    }
    if (status === 'active') joinLegacyGroup(tx, ctx, course, ctx.uid)
    else notifyTo = Array.from(new Set([...(course.teacherUids || []), ...(course.managerUids || [])])).filter((x) => typeof x === 'string')
    return commitEnrollment(tx, ctx, rev0, r, cur, next, 'enrollment.request', courseId, ctx.uid)
  })
  if (notifyTo.length && !result.already) {
    // 하루 한 번만(같은 학생이 반복 신청해도 알림이 쌓이지 않게). 실패해도 신청은 성공
    try {
      await notifyUsersOnce(ctx.db, notifyTo, `enr_${courseId}__${ctx.uid}_${ctx.today}`, {
        title: '수강 신청',
        body: `${String(ctx.u.user.name || ctx.u.user.displayName || '학생')} 학생이 수업 참여를 기다려요`,
        url: '/teacher/courses',
      })
    } catch (e) {
      console.error('enrollments: notify failed', (e as Error)?.message)
    }
  }
  return result
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
          ? { status: 'active', from: ctx.today, to: null, rejected: false, ...decided }
          : { termId: String(course.termId || ''), status: 'active', from: ctx.today, to: null, source: 'admin', rejected: false, ...decided }
      return commitEnrollment(tx, ctx, rev0, r, cur, next, 'enrollment.add', courseId, uid)
    }

    if (!cur) fail(404, 'enrollment-not-found', '이 학생의 수강 정보가 없어요.')

    if (action === 'approve') {
      if (status === 'active') return same('active')
      if (status !== 'pending') fail(409, 'not-pending', '승인 대기 중인 신청이 아니에요.')
      assertSameSchoolStudent(ctx, userSnap)
      if (!courseActiveOn(courseFromDoc(courseId, course), ctx.today)) fail(409, 'course-ended', '이미 끝난 수업이에요.')
      joinLegacyGroup(tx, ctx, course, uid)
      return commitEnrollment(tx, ctx, rev0, r, cur, { status: 'active', from: ctx.today, to: null, rejected: false, ...decided }, 'enrollment.approve', courseId, uid)
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
