import type { NextApiRequest, NextApiResponse } from 'next'
import { FieldValue, Timestamp, type DocumentReference, type Firestore, type Transaction } from 'firebase-admin/firestore'
import { isAdminConfigured, verifyIdToken } from '../../lib/fcm-admin'
import {
  assertInviteOk,
  checkRateLimit,
  clientIp,
  courseApproverUids,
  courseJoinDefault,
  courseOpenOn,
  decideEnrollment,
  enrollmentWriteData,
  formatInviteCode,
  generateInviteCode,
  inviteStateOf,
  inviteUrlPath,
  maskInviteCode,
  normalizeInviteCode,
  planClassJoin,
  recordFailure,
  schoolOfClass,
  schoolOfUser,
  tsMillis,
  type ClassJoinPlan,
  type InviteState,
  type InviteType,
} from '../../lib/invitations'
import { schoolYmdAt } from '../../lib/timetable/dates'
import {
  adminDb,
  apiError,
  cleanText,
  enrollmentId,
  GROUP_RE,
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
import {
  canManageCourse,
  homeroomLabel,
  readTermDocs,
  termForDateFromDocs,
  TimetableApiError,
} from '../../lib/timetable/studentData'
import type { EnrollmentStatus, Ymd } from '../../lib/timetable/types'

// POST /api/invitations  { action, ... }
// 사람이 입력할 수 있는 8자 초대 코드(invitations/{code})로 학급(homeroom)·수업(course)에 참여합니다.
// 권한은 서버가 users/{uid}와 대상 문서(classes/{id}.teacherId, schools/{s}/courses/{id}.teacherUids·managerUids)로 판정합니다.
// - create  {type:'homeroom'|'course', targetId, expiresInDays?(1~180, 기본 30), maxUses?(null=무제한, 1~10000)}
//           homeroom: 그 학급 담임 / course: 그 수업 담당 교사. 다인용(첫 사용에 소진되지 않음)
//           → { ok, code, displayCode:'XXXX-XXXX', url:'/i/{code}'(상대 경로), type, targetId, targetLabel, schoolName,
//               teacherName, termId, expiresAt(ms), maxUses, uses }
// - revoke  {code}            발급자 또는 대상 담당 교사 → { ok, code, revoked:true, already? }
// - list    {targetId, type?} 대상 담당 교사 → { invitations: [{code, displayCode, url, type, targetLabel, createdAt, expiresAt,
//                               revoked, uses, maxUses, state, issuedByName, mine}] } (사용자 명단 없음)
// - preview {code}            로그인 불필요. 최소 정보만(학생 명단·uid 없음)
//           200 { ok, state:'ok', code, displayCode, type, schoolName, targetLabel, teacherName, termName?, expiresAt }
//           404/410 { error, code: state, state, type?, schoolName?, targetLabel?, teacherName? }
// - accept  {code, name?, studentId?}  로그인 학생(익명 403 anonymous, 교사 403 teacher-account)
//           homeroom: /api/join과 같은 규칙(planClassJoin) — name 필수(기존 프로필 이름이 있으면 생략 가능)
//             → { ok, type:'homeroom', status:'homeroom-pending'|'move-pending'|'already', homeroomStatus, classId, targetLabel, next }
//           course: 소속(classId·grade·classNm·status)은 바꾸지 않음. 프로필이 없으면 소속 없는 학생 프로필을 만듦(name 필수)
//             → { ok, type:'course', status:'enrolled'|'pending'|'already', enrollmentStatus, courseId, courseTitle,
//                 profileCreated, revision, next:'/student/timetable' }
//           같은 사람의 중복 수락·더블 탭·재전송은 같은 결과(already). 사용 기록(uses/{uid})과 사용 수는 처음 수락할 때만
// 오류: { error, code } — 400 bad-action/bad-type/bad-code/bad-expiry/bad-max-uses/invalid-id/name-required/not-homeroom,
//       401 unauthenticated, 403 anonymous/teacher-account/not-student/teacher-only/not-homeroom-teacher/not-course-teacher/
//       not-invite-owner/other-school, 404 not-found/target-not-found/course-not-found, 409 course-ended/no-school,
//       410 expired/revoked/used-up/ended, 429 rate-limited, 500 server-error, 503 not-configured
// 로그에 초대 코드·토큰·학생 이름을 남기지 않습니다.

const DEFAULT_EXPIRES_DAYS = 30
const MAX_EXPIRES_DAYS = 180
const MAX_USES_LIMIT = 10000
const DAY_MS = 86400000

function fail(status: number, code: string, message: string, extra?: Record<string, unknown>): never {
  throw new TimetableApiError(status, code, message, extra)
}

function idField(v: unknown, label: string): string {
  if (typeof v !== 'string' || !ID_RE.test(v)) fail(400, 'invalid-id', `${label} 값이 올바르지 않아요.`)
  return v as string
}

function codeField(v: unknown, ip: string | null, uid: string | null): string {
  const code = normalizeInviteCode(v)
  if (!code) {
    if (ip) recordFailure('invite', ip, uid)
    fail(400, 'bad-code', '초대 코드 형식이 올바르지 않아요. 8자리 코드를 다시 확인해 주세요.', { state: 'not-found' })
  }
  return code as string
}

const invitesCol = (db: Firestore) => db.collection('invitations')

/** 학기 이름: 학기 문서 이름 → 'YYYY학년도 N학기' */
function termNameOf(termDocs: Array<{ id: string; data: Record<string, any> }>, termId: string): string | null {
  const doc = termDocs.find((d) => d.id === termId)
  if (doc && doc.data.name) return String(doc.data.name)
  const m = /^(\d{4})-([12])$/.exec(termId)
  return m ? `${m[1]}학년도 ${m[2]}학기` : null
}

/** 공개 미리보기·오류에 넣는 최소 정보(명단·uid·발급자 uid 없음) */
function publicInfo(inv: Record<string, any>) {
  return {
    type: inv.type === 'course' ? 'course' : 'homeroom',
    schoolName: String(inv.schoolName || ''),
    targetLabel: String(inv.targetLabel || ''),
    teacherName: String(inv.teacherName || ''),
  }
}

// ───────────────────────── 교사: 대상 확인 ─────────────────────────

interface TeacherCtx {
  u: ApiUser
  db: Firestore
  uid: string
  schoolCode: string
  body: Record<string, any>
  today: Ymd
}

interface ManagedTarget {
  type: InviteType
  targetId: string
  data: Record<string, any>
  label: string
  schoolName: string
  teacherName: string
  officeCode: string | null
  termId: string
}

const myName = (ctx: TeacherCtx) => String(ctx.u.user.name || ctx.u.user.displayName || '').trim().slice(0, 20)

/** 대상 학급의 담임 / 대상 수업의 담당 교사인지 확인하고 표시 정보를 만듭니다 */
async function loadManagedTarget(ctx: TeacherCtx, type: InviteType, targetId: string): Promise<ManagedTarget> {
  if (type === 'homeroom') {
    const snap = await ctx.db.collection('classes').doc(targetId).get()
    if (!snap.exists) fail(404, 'target-not-found', '학급을 찾을 수 없어요.')
    const cls = snap.data() || {}
    if (cls.isGroup === true || GROUP_RE.test(targetId)) {
      fail(400, 'not-homeroom', '수업 그룹은 학급 초대를 만들 수 없어요. 그룹과 연결된 수업의 수업 초대를 만들어 주세요.')
    }
    if (schoolOfClass(cls, targetId) !== ctx.schoolCode || String(cls.teacherId || '') !== ctx.uid) {
      fail(403, 'not-homeroom-teacher', '그 학급 담임 선생님만 학급 초대를 만들고 관리할 수 있어요.')
    }
    const termDocs = await readTermDocs(ctx.db, ctx.schoolCode)
    return {
      type,
      targetId,
      data: cls,
      label: homeroomLabel(cls, targetId),
      schoolName: String(cls.schoolName || ctx.u.user.schoolName || ''),
      teacherName: String(cls.teacherName || myName(ctx)),
      officeCode: cls.officeCode ? String(cls.officeCode) : ctx.u.user.officeCode ? String(ctx.u.user.officeCode) : null,
      termId: termForDateFromDocs(termDocs, ctx.today).termId,
    }
  }
  const snap = await schoolRef(ctx.db, ctx.schoolCode).collection('courses').doc(targetId).get()
  if (!snap.exists) fail(404, 'course-not-found', '수업을 찾을 수 없어요.')
  const course = snap.data() || {}
  if (!canManageCourse(course, ctx.uid)) fail(403, 'not-course-teacher', '담당 선생님만 수업 초대를 만들고 관리할 수 있어요.')
  const names = Array.isArray(course.teacherNames) ? course.teacherNames.filter((x: unknown) => typeof x === 'string' && x) : []
  return {
    type,
    targetId,
    data: course,
    label: String(course.title || course.subject || '수업'),
    schoolName: String(ctx.u.user.schoolName || ''),
    teacherName: String(names[0] || myName(ctx)),
    officeCode: ctx.u.user.officeCode ? String(ctx.u.user.officeCode) : null,
    termId: String(course.termId || ''),
  }
}

function typeField(v: unknown): InviteType {
  if (v !== 'homeroom' && v !== 'course') fail(400, 'bad-type', "초대 종류를 골라 주세요('homeroom' 학급 또는 'course' 수업).")
  return v as InviteType
}

// ───────────────────────── create / revoke / list ─────────────────────────

async function createInvite(ctx: TeacherCtx) {
  const b = ctx.body
  const type = typeField(b.type)
  const targetId = idField(b.targetId, '대상')
  let days = DEFAULT_EXPIRES_DAYS
  if (b.expiresInDays !== undefined && b.expiresInDays !== null) {
    if (!Number.isInteger(b.expiresInDays) || b.expiresInDays < 1 || b.expiresInDays > MAX_EXPIRES_DAYS) {
      fail(400, 'bad-expiry', `만료 기간은 1~${MAX_EXPIRES_DAYS}일 사이 정수로 정해 주세요.`)
    }
    days = b.expiresInDays
  }
  let maxUses: number | null = null
  if (b.maxUses !== undefined && b.maxUses !== null) {
    if (!Number.isInteger(b.maxUses) || b.maxUses < 1 || b.maxUses > MAX_USES_LIMIT) {
      fail(400, 'bad-max-uses', `사용 인원은 1~${MAX_USES_LIMIT}명 사이 정수로 정하거나 비워 두세요(무제한).`)
    }
    maxUses = b.maxUses
  }
  const target = await loadManagedTarget(ctx, type, targetId)
  if (type === 'course') {
    const termDocs = await readTermDocs(ctx.db, ctx.schoolCode)
    if (!courseOpenOn(targetId, target.data, termDocs, ctx.today)) fail(409, 'course-ended', '이미 끝난 수업(또는 지난 학기)은 초대할 수 없어요.')
  }

  const expiresAt = Timestamp.fromMillis(Date.now() + days * DAY_MS)
  const doc = {
    schoolCode: ctx.schoolCode,
    schoolName: target.schoolName,
    officeCode: target.officeCode,
    termId: target.termId,
    type,
    targetId,
    targetLabel: target.label,
    teacherName: target.teacherName,
    issuedBy: ctx.uid,
    issuedByName: myName(ctx),
    expiresAt,
    revoked: false,
    uses: 0,
    maxUses,
    lastUsedAt: null,
  }
  // 코드 충돌(31^8 중 하나)은 create가 ALREADY_EXISTS로 실패 → 새 코드로 다시
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = generateInviteCode()
    const ref = invitesCol(ctx.db).doc(code)
    const batch = ctx.db.batch()
    batch.create(ref, { ...doc, code, createdAt: FieldValue.serverTimestamp() })
    writeAudit(batch, ctx.db, ctx.schoolCode, {
      action: 'invitation.create',
      actorUid: ctx.uid,
      target: `invitations/${maskInviteCode(code)}`,
      after: { type, targetId, expiresAt: expiresAt.toMillis(), maxUses },
    })
    try {
      await batch.commit()
    } catch (e) {
      if ((e as { code?: unknown })?.code === 6) continue
      throw e
    }
    return {
      ok: true,
      code,
      displayCode: formatInviteCode(code),
      url: inviteUrlPath(code),
      type,
      targetId,
      targetLabel: target.label,
      schoolName: target.schoolName,
      teacherName: target.teacherName,
      termId: target.termId,
      expiresAt: expiresAt.toMillis(),
      maxUses,
      uses: 0,
    }
  }
  fail(500, 'code-collision', '초대 코드를 만들지 못했어요. 다시 시도해 주세요.')
}

/** 이 초대를 관리할 수 있는지: 발급자 또는 대상 담당 교사(같은 학교) */
async function canManageInvite(ctx: TeacherCtx, inv: Record<string, any>): Promise<boolean> {
  if (String(inv.schoolCode || '') !== ctx.schoolCode) return false
  if (inv.issuedBy === ctx.uid) return true
  const targetId = String(inv.targetId || '')
  if (!ID_RE.test(targetId)) return false
  if (inv.type === 'homeroom') {
    const c = await ctx.db.collection('classes').doc(targetId).get()
    return c.exists && String(c.get('teacherId') || '') === ctx.uid
  }
  if (inv.type === 'course') {
    const c = await schoolRef(ctx.db, ctx.schoolCode).collection('courses').doc(targetId).get()
    return c.exists && canManageCourse(c.data(), ctx.uid)
  }
  return false
}

async function revokeInvite(ctx: TeacherCtx) {
  const code = codeField(ctx.body.code, null, null)
  const ref = invitesCol(ctx.db).doc(code)
  const snap = await ref.get()
  const inv = snap.exists ? snap.data() || {} : null
  // 다른 학교 초대는 존재 여부를 알리지 않음
  if (!inv || String(inv.schoolCode || '') !== ctx.schoolCode) fail(404, 'not-found', '초대 코드를 찾을 수 없어요.')
  if (!(await canManageInvite(ctx, inv as Record<string, any>))) fail(403, 'not-invite-owner', '초대를 만든 선생님이나 대상 담당 선생님만 회수할 수 있어요.')
  return ctx.db.runTransaction(async (tx) => {
    const cur = await tx.get(ref)
    if (cur.get('revoked') === true) return { ok: true, code, revoked: true, already: true }
    tx.update(ref, { revoked: true, revokedAt: FieldValue.serverTimestamp(), revokedBy: ctx.uid })
    writeAudit(tx, ctx.db, ctx.schoolCode, {
      action: 'invitation.revoke',
      actorUid: ctx.uid,
      target: `invitations/${maskInviteCode(code)}`,
      before: { revoked: false },
      after: { revoked: true },
    })
    return { ok: true, code, revoked: true }
  })
}

async function listInvites(ctx: TeacherCtx) {
  const targetId = idField(ctx.body.targetId, '대상')
  let type: InviteType
  if (ctx.body.type !== undefined && ctx.body.type !== null) type = typeField(ctx.body.type)
  else {
    const c = await schoolRef(ctx.db, ctx.schoolCode).collection('courses').doc(targetId).get()
    type = c.exists ? 'course' : 'homeroom'
  }
  const target = await loadManagedTarget(ctx, type, targetId)
  const termDocs = type === 'course' ? await readTermDocs(ctx.db, ctx.schoolCode) : []
  const snap = await invitesCol(ctx.db).where('targetId', '==', targetId).get()
  const now = Date.now()
  const rows = snap.docs
    .map((d) => ({ id: d.id, v: d.data() || {} }))
    .filter((r) => String(r.v.schoolCode || '') === ctx.schoolCode && r.v.type === type)
    .map((r) => {
      const state: InviteState = inviteStateOf(r.v, target.data, { nowMs: now, today: ctx.today, termDocs })
      return {
        code: r.id,
        displayCode: formatInviteCode(r.id),
        url: inviteUrlPath(r.id),
        type,
        targetLabel: String(r.v.targetLabel || target.label),
        createdAt: tsMillis(r.v.createdAt),
        expiresAt: tsMillis(r.v.expiresAt),
        revoked: r.v.revoked === true,
        uses: Number(r.v.uses) || 0,
        maxUses: typeof r.v.maxUses === 'number' ? r.v.maxUses : null,
        state,
        issuedByName: String(r.v.issuedByName || ''),
        mine: r.v.issuedBy === ctx.uid,
      }
    })
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 100)
  return { targetId, type, targetLabel: target.label, invitations: rows }
}

// ───────────────────────── preview (로그인 불필요) ─────────────────────────

/** 초대 대상 문서(학급 또는 수업). 없으면 null */
async function loadTarget(db: Firestore, inv: Record<string, any>): Promise<Record<string, any> | null> {
  const targetId = String(inv.targetId || '')
  if (!ID_RE.test(targetId)) return null
  if (inv.type === 'homeroom') {
    const s = await db.collection('classes').doc(targetId).get()
    return s.exists ? s.data() || {} : null
  }
  if (inv.type === 'course') {
    const schoolCode = String(inv.schoolCode || '')
    if (!schoolCode || !ID_RE.test(schoolCode)) return null
    const s = await schoolRef(db, schoolCode).collection('courses').doc(targetId).get()
    return s.exists ? s.data() || {} : null
  }
  return null
}

async function previewInvite(db: Firestore, ip: string, body: Record<string, any>) {
  checkRateLimit('invite', ip)
  const code = codeField(body.code, ip, null)
  const snap = await invitesCol(db).doc(code).get()
  if (!snap.exists) {
    recordFailure('invite', ip)
    fail(404, 'not-found', '초대 코드를 찾을 수 없어요. 코드를 다시 확인해 주세요.', { state: 'not-found' })
  }
  const inv = snap.data() || {}
  const target = await loadTarget(db, inv)
  const termDocs = inv.type === 'course' && inv.schoolCode ? await readTermDocs(db, String(inv.schoolCode)) : []
  const today = schoolYmdAt(Date.now())
  const state = inviteStateOf(inv, target, { nowMs: Date.now(), today, termDocs })
  const info: Record<string, unknown> = { ...publicInfo(inv) }
  if (inv.type === 'course') {
    const termName = termNameOf(termDocs, String(inv.termId || ''))
    if (termName) info.termName = termName
  }
  assertInviteOk(state, info)
  return { ok: true, state: 'ok', code, displayCode: formatInviteCode(code), ...info, expiresAt: tsMillis(inv.expiresAt) }
}

// ───────────────────────── accept (로그인 학생) ─────────────────────────

interface AcceptCtx {
  db: Firestore
  uid: string
  email: string | null
  code: string
  name: string
  studentId: string
  today: Ymd
}

/** 교사·학생이 아닌 계정 거부(초대 수락으로 역할·권한을 얻을 수 없음) */
function assertStudentOrNew(prev: Record<string, any> | null) {
  if (prev?.role === 'teacher') fail(403, 'teacher-account', '교사 계정으로는 학생 초대를 수락할 수 없어요. 학생 계정으로 로그인해 주세요.')
  if (prev?.role && prev.role !== 'student') fail(403, 'not-student', '학생 계정에서만 초대를 수락할 수 있어요.')
}

/** 처음 수락할 때만 사용 기록 + 사용 수 증가(트랜잭션 안) */
function recordUse(tx: Transaction, invRef: DocumentReference, useRef: DocumentReference, alreadyUsed: boolean, type: InviteType, result: string) {
  if (alreadyUsed) return
  tx.set(useRef, { at: FieldValue.serverTimestamp(), type, result })
  tx.update(invRef, { uses: FieldValue.increment(1), lastUsedAt: FieldValue.serverTimestamp() })
}

async function acceptHomeroom(ctx: AcceptCtx, inv0: Record<string, any>) {
  const { db, uid, code } = ctx
  const invRef = invitesCol(db).doc(code)
  const useRef = invRef.collection('uses').doc(uid)
  const classId = String(inv0.targetId || '')
  if (!ID_RE.test(classId)) fail(404, 'not-found', '초대 대상을 찾을 수 없어요.', { state: 'not-found' })
  const classRef = db.collection('classes').doc(classId)
  const userRef = db.collection('users').doc(uid)

  const plan: ClassJoinPlan = await db.runTransaction(async (tx) => {
    const [invSnap, useSnap, classSnap, userSnap] = await tx.getAll(invRef, useRef, classRef, userRef)
    const inv = invSnap.exists ? invSnap.data() || {} : null
    const prev = userSnap.exists ? userSnap.data() || {} : null
    assertStudentOrNew(prev)
    const cls = classSnap.exists ? classSnap.data() || {} : null
    const state = inviteStateOf(inv, cls, { nowMs: Date.now(), today: ctx.today, alreadyUsedByMe: useSnap.exists })
    assertInviteOk(state, inv ? publicInfo(inv) : undefined)
    const p = planClassJoin({
      uid,
      email: ctx.email,
      classId,
      cls: cls as Record<string, any>,
      prev,
      name: ctx.name,
      studentId: ctx.studentId,
      today: ctx.today,
    })
    if (p.userWrite) tx.set(userRef, p.userWrite, { merge: true })
    recordUse(tx, invRef, useRef, useSnap.exists, 'homeroom', p.status)
    return p
  })

  if (plan.notify) {
    try {
      await notifyUsersOnce(db, [plan.notify.teacherId], plan.notify.dedupeId, {
        title: plan.notify.title,
        body: plan.notify.body,
        url: plan.notify.url,
      })
    } catch (e) {
      console.error('invitations: homeroom notify failed', (e as Error)?.message)
    }
  }
  const status = plan.already ? 'already' : plan.status === 'pending' ? 'homeroom-pending' : plan.status
  return {
    ok: true,
    type: 'homeroom',
    status,
    homeroomStatus: plan.status,
    classId,
    targetLabel: String(inv0.targetLabel || ''),
    next: '/student/today',
  }
}

async function acceptCourse(ctx: AcceptCtx, inv0: Record<string, any>) {
  const { db, uid, code, today } = ctx
  const schoolCode = String(inv0.schoolCode || '')
  const courseId = String(inv0.targetId || '')
  if (!ID_RE.test(schoolCode) || !ID_RE.test(courseId)) fail(404, 'not-found', '초대 대상을 찾을 수 없어요.', { state: 'not-found' })
  const sref = schoolRef(db, schoolCode)
  const invRef = invitesCol(db).doc(code)
  const useRef = invRef.collection('uses').doc(uid)
  const courseRef = sref.collection('courses').doc(courseId)
  const userRef = db.collection('users').doc(uid)
  const enrRef = sref.collection('enrollments').doc(enrollmentId(courseId, uid))
  const termDocs = await readTermDocs(db, schoolCode)

  const r = await db.runTransaction(async (tx) => {
    const [invSnap, useSnap, courseSnap, userSnap, enrSnap] = await tx.getAll(invRef, useRef, courseRef, userRef, enrRef)
    const rev0 = await readRevision(tx, db, schoolCode)
    const inv = invSnap.exists ? invSnap.data() || {} : null
    const prev = userSnap.exists ? userSnap.data() || {} : null
    assertStudentOrNew(prev)
    const course = courseSnap.exists ? courseSnap.data() || {} : null
    const state = inviteStateOf(inv, course, { nowMs: Date.now(), today, termDocs, alreadyUsedByMe: useSnap.exists })
    assertInviteOk(state, inv ? publicInfo(inv) : undefined)
    const c = course as Record<string, any>
    const i = inv as Record<string, any>

    // 다른 학교 학생은 막음(소속 학교를 초대로 바꾸지 않음)
    const mySchool = schoolOfUser(prev)
    if (mySchool && mySchool !== schoolCode) {
      fail(403, 'other-school', '다른 학교 수업 초대예요. 전학했다면 지금 학교 선생님께 문의해 주세요.')
    }

    const isStudent = prev?.role === 'student'
    const userWrite: Record<string, unknown> = {}
    let profileCreated = false
    const name = ctx.name || String(prev?.name || '')
    if (!isStudent) {
      // 가입 직후(프로필 없음): 소속 학급은 비워 둔 학생 프로필 — 수업 교실·그룹을 소속으로 쓰지 않음
      if (!name) fail(400, 'name-required', '이름을 입력해 주세요.')
      Object.assign(userWrite, {
        role: 'student',
        status: 'pending',
        classId: null,
        schoolCode,
        schoolName: i.schoolName || null,
        name,
        displayName: name,
        email: ctx.email || prev?.email || null,
      })
      if (i.officeCode) userWrite.officeCode = i.officeCode
      if (ctx.studentId) userWrite.studentId = ctx.studentId
      if (!prev) userWrite.createdAt = FieldValue.serverTimestamp()
      profileCreated = true
    } else if (!prev?.schoolCode) {
      // 기존 학생: 소속(classId·grade·classNm·status)은 그대로, 비어 있는 학교 정보만 채움
      userWrite.schoolCode = schoolCode
      if (i.schoolName && !prev?.schoolName) userWrite.schoolName = i.schoolName
      if (i.officeCode && !prev?.officeCode) userWrite.officeCode = i.officeCode
    }

    const cur = enrSnap.exists ? enrSnap.data() || {} : null
    const d = decideEnrollment(cur, courseJoinDefault(c))
    let revision = rev0
    if (d.changed) {
      tx.set(
        enrRef,
        enrollmentWriteData({ cur, courseId, course: c, uid, schoolCode, status: d.status, today, source: 'invite', extra: { invitationCode: code } }),
        { merge: true }
      )
      const gid = typeof c.legacyGroupId === 'string' && ID_RE.test(c.legacyGroupId) && GROUP_RE.test(c.legacyGroupId) ? c.legacyGroupId : ''
      if (d.status === 'active' && gid) userWrite.extraClassIds = FieldValue.arrayUnion(gid)
      revision = rev0 + 1
      writeRevision(tx, db, schoolCode, revision)
      writeAudit(tx, db, schoolCode, {
        action: 'enrollment.invite',
        actorUid: uid,
        target: `enrollments/${enrollmentId(courseId, uid)}`,
        revision,
        before: cur ? { status: cur.status ?? null, from: cur.from ?? null, to: cur.to ?? null } : null,
        after: { status: d.status, from: d.status === 'active' ? today : null },
        meta: { invitation: maskInviteCode(code), profileCreated },
      })
    }
    if (Object.keys(userWrite).length) tx.set(userRef, userWrite, { merge: true })
    recordUse(tx, invRef, useRef, useSnap.exists, 'course', d.changed ? d.status : 'already')
    const teachers = courseApproverUids(c)
    return {
      changed: d.changed,
      status: d.status as EnrollmentStatus,
      revision,
      profileCreated,
      title: String(c.title || c.subject || '수업'),
      teachers,
      studentName: String(prev?.name || name || '학생'),
    }
  })

  if (r.changed && r.teachers.length) {
    const pending = r.status === 'pending'
    try {
      // 알림 id는 이번 변경의 학교 revision으로 — 같은 수락의 재전송은 changed=false라 알림이 없고,
      // 선생님이 거절한 뒤 같은 날 다시 수락하면 새 승인 요청이 갑니다(날짜 id는 이 알림을 막았음)
      await notifyUsersOnce(db, r.teachers, `inv_${courseId}__${uid}_r${r.revision}`, {
        title: pending ? '수강 승인 요청' : '새 수강생',
        body: pending
          ? `${r.studentName} 학생이 ${r.title} 수업 참여 승인을 기다려요`
          : `${r.studentName} 학생이 초대 코드로 ${r.title} 수업에 참여했어요`,
        url: '/teacher/courses',
      })
    } catch (e) {
      console.error('invitations: course notify failed', (e as Error)?.message)
    }
  }
  return {
    ok: true,
    type: 'course',
    status: !r.changed ? 'already' : r.status === 'active' ? 'enrolled' : 'pending',
    enrollmentStatus: r.status,
    courseId,
    courseTitle: r.title,
    profileCreated: r.profileCreated,
    revision: r.revision,
    next: '/student/timetable',
  }
}

async function acceptInvite(req: NextApiRequest, ip: string, body: Record<string, any>) {
  const authHeader = req.headers.authorization || ''
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  const decoded = await verifyIdToken(idToken)
  if (!decoded) fail(401, 'unauthenticated', '로그인이 필요해요. 로그인한 뒤 초대를 다시 열어 주세요.')
  if (decoded.firebase?.sign_in_provider === 'anonymous') {
    fail(403, 'anonymous', '익명(둘러보기) 계정으로는 초대를 수락할 수 없어요. 계정을 만들거나 로그인해 주세요.')
  }
  checkRateLimit('invite', ip, decoded.uid)
  const code = codeField(body.code, ip, decoded.uid)
  const db = adminDb()
  if (!db) fail(503, 'not-configured', '서버 초기화에 실패했어요.')
  const snap = await invitesCol(db).doc(code).get()
  if (!snap.exists) {
    recordFailure('invite', ip, decoded.uid)
    fail(404, 'not-found', '초대 코드를 찾을 수 없어요. 코드를 다시 확인해 주세요.', { state: 'not-found' })
  }
  const inv = snap.data() || {}
  const ctx: AcceptCtx = {
    db,
    uid: decoded.uid,
    email: decoded.email || null,
    code,
    name: cleanText(body.name, 20),
    studentId:
      typeof body.studentId === 'string' || typeof body.studentId === 'number'
        ? String(body.studentId).replace(/[^0-9]/g, '').slice(0, 10)
        : '',
    today: schoolYmdAt(Date.now()),
  }
  if (inv.type === 'homeroom') return acceptHomeroom(ctx, inv)
  if (inv.type === 'course') return acceptCourse(ctx, inv)
  fail(404, 'not-found', '초대 대상을 찾을 수 없어요.', { state: 'not-found' })
}

// ───────────────────────── 핸들러 ─────────────────────────

const TEACHER_ACTIONS: Record<string, (ctx: TeacherCtx) => Promise<unknown>> = {
  create: createInvite,
  revoke: revokeInvite,
  list: listInvites,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'private, no-store')
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return apiError(res, 405, 'method-not-allowed', '허용되지 않는 요청이에요.')
  }
  if (!isAdminConfigured()) return apiError(res, 503, 'not-configured', '서버 설정이 없어요. 관리자에게 문의해 주세요.')
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, any>) : {}
  const action = typeof body.action === 'string' ? body.action : ''
  const ip = clientIp(req)

  try {
    if (action === 'preview') {
      const db = adminDb()
      if (!db) return apiError(res, 503, 'not-configured', '서버 초기화에 실패했어요.')
      return res.status(200).json(await previewInvite(db, ip, body))
    }
    if (action === 'accept') return res.status(200).json(await acceptInvite(req, ip, body))

    const run = Object.prototype.hasOwnProperty.call(TEACHER_ACTIONS, action) ? TEACHER_ACTIONS[action] : null
    if (!run) return apiError(res, 400, 'bad-action', '알 수 없는 요청이에요.')
    let u: ApiUser | null
    try {
      u = await requireUser(req, res)
    } catch (e) {
      console.error('invitations: auth failed', (e as Error)?.message)
      return apiError(res, 500, 'server-error', '사용자 정보를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.')
    }
    if (!u) return
    if (!isTeacher(u)) {
      return u.user.role === 'teacher'
        ? apiError(res, 409, 'no-school', '학교 정보가 없어요. 내 정보에서 학교를 먼저 확인해 주세요.')
        : apiError(res, 403, 'teacher-only', '선생님 계정만 초대를 만들고 관리할 수 있어요.')
    }
    const ctx: TeacherCtx = { u, db: u.db, uid: u.uid, schoolCode: String(u.user.schoolCode), body, today: schoolYmdAt(Date.now()) }
    return res.status(200).json(await run(ctx))
  } catch (e) {
    if (e instanceof TimetableApiError) return res.status(e.status).json({ error: e.message, code: e.code, ...(e.extra || {}) })
    console.error('invitations: failed', action, String((e as Error)?.message || '').slice(0, 200))
    return apiError(res, 500, 'server-error', '처리하지 못했어요. 잠시 후 다시 시도해 주세요.')
  }
}
