import type { NextApiRequest, NextApiResponse } from 'next'
import { FieldPath, FieldValue, type DocumentData, type Transaction } from 'firebase-admin/firestore'
import { schoolYmdAt } from '../../lib/timetable/dates'
import {
  apiError,
  cleanText,
  courseManagerUids,
  currentRevision,
  ID_RE,
  isCourseTeacher,
  isTeacher,
  notifyUsersOnce,
  readRevision,
  requireUser,
  SCHOOL_CODE_RE,
  schoolRef,
  stripUndefined,
  writeAudit,
  writeRevision,
  type ApiUser,
} from '../../lib/timetable/server'
import {
  affectedStudents,
  buildChangePlan,
  CHANGE_SET_ID_RE,
  ChangeError,
  changeSetIdOf,
  conflictsCovered,
  findOrphans,
  itemToJson,
  loadCourses,
  loadMemberIndex,
  loadOverridesByCourses,
  loadSeriesForCourses,
  parseChangeRequest,
  requestHash,
  shortDate,
  studentNotifyGroups,
  TEACHER_CHANGES_URL,
  type ChangePlan,
  type ChangeRequest,
} from '../../lib/timetable/changes'
import type { Course, Ymd } from '../../lib/timetable/types'

// POST /api/schedule-changes
// Header: Authorization: Bearer <Firebase ID token>
// Body: { action, schoolCode?, ... } — 아키텍처 문서 5.1절
//  - preview : 쓰지 않고 변경 전후·영향 학생 수·충돌·검토 필요(orphan)·현재 revision
//  - publish : 트랜잭션 하나로 변경·묶음·감사·scheduleRevision+1. 같은 mutationId 재전송은 저장된 결과 그대로.
//              모든 대상 수업의 담당 교사가 아니면 승인 대기(202)로 저장하고 다른 담당 교사에게 알림.
//  - approve / reject : 승인 대기 묶음({changeSetId}). 모두 승인되면 현재 시간표 기준으로 다시 검사한 뒤 발행.
//              요청 때 저장한 충돌에 없던 충돌이 생겼으면 승인자가 acknowledgeConflicts로 확인해야 발행(없으면 409 conflicts).
//  - list    : {courseId} 담당 교사 — 최근 50개 묶음 요약. {awaitingMe:true} — 내 승인을 기다리는 요청.
//  - orphans : {courseId} 담당 교사 — 대상 차시가 사라진 발행 변경(기본 시간표 변경 등) 검토 목록.
//  - 원복은 items의 op 'restore'로(새 변경으로 기록 — 이력은 지우지 않음).
// 권한은 서버가 users/{uid}(role, schoolCode)와 수업 문서(teacherUids)로만 판정합니다. 학생 요청은 항상 403.
// 학생 명단·이름은 응답·로그·감사 기록에 넣지 않습니다(영향 학생은 수만).

interface Ctx {
  u: ApiUser
  db: ApiUser['db']
  schoolCode: string
}

type Body = Record<string, unknown>

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiError(res, 405, 'method-not-allowed', '허용되지 않는 요청이에요.')
  try {
    const u = await requireUser(req, res)
    if (!u) return
    if (u.user.role !== 'teacher') {
      return apiError(res, 403, 'forbidden', '학생 계정으로는 공식 시간표를 바꾸거나 변경 기록을 볼 수 없어요.')
    }
    if (!isTeacher(u)) return apiError(res, 403, 'no-school', '학교 등록을 먼저 마쳐 주세요.')
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Body
    const schoolCode = body.schoolCode === undefined || body.schoolCode === null ? String(u.user.schoolCode) : body.schoolCode
    if (typeof schoolCode !== 'string' || !SCHOOL_CODE_RE.test(schoolCode)) {
      return apiError(res, 400, 'invalid-request', '학교 코드 형식이 올바르지 않아요.')
    }
    if (schoolCode !== u.user.schoolCode) return apiError(res, 403, 'other-school', '다른 학교의 시간표는 볼 수도 바꿀 수도 없어요.')
    const ctx: Ctx = { u, db: u.db, schoolCode }

    switch (body.action) {
      case 'preview':
        return await preview(ctx, body, res)
      case 'publish':
        return await publish(ctx, body, res)
      case 'approve':
        return await approve(ctx, body, res)
      case 'reject':
        return await reject(ctx, body, res)
      case 'list':
        return await list(ctx, body, res)
      case 'orphans':
        return await orphans(ctx, body, res)
      default:
        return apiError(res, 400, 'invalid-request', '알 수 없는 요청(action)이에요.')
    }
  } catch (e) {
    if (e instanceof ChangeError) return res.status(e.status).json({ error: e.message, code: e.code, ...(e.extra || {}) })
    const code = (e as { code?: unknown })?.code
    if (code === 9 || code === 'failed-precondition') {
      console.error('schedule-changes: index required —', (e as Error)?.message)
      return apiError(res, 500, 'index-required', '변경 기록 조회에 필요한 색인이 아직 준비되지 않았어요. 관리자에게 알려 주세요.')
    }
    console.error('schedule-changes failed:', (e as Error)?.message)
    return apiError(res, 500, 'internal', '시간표 변경 처리 중 서버 오류가 났어요. 잠시 후 다시 시도해 주세요.')
  }
}

// ───────────────────────── 공용 ─────────────────────────

const csCol = (ctx: Ctx) => schoolRef(ctx.db, ctx.schoolCode).collection('changeSets')
const nameOf = (u: Record<string, any>) => cleanText(u.name || u.displayName || '', 30) || '선생님'
const toMs = (v: any): number | null => (v && typeof v.toMillis === 'function' ? v.toMillis() : null)

function todayYmd(): Ymd {
  return schoolYmdAt(Date.now())
}

function makePlan(ctx: Ctx, req: ChangeRequest, mutationId: string, requesterUid: string): Promise<ChangePlan> {
  return buildChangePlan({
    db: ctx.db,
    schoolCode: ctx.schoolCode,
    requesterUid,
    mutationId,
    req,
    today: todayYmd(),
    schoolNameHint: typeof ctx.u.user.schoolName === 'string' ? ctx.u.user.schoolName : undefined,
  })
}

function stale(res: NextApiResponse, currentRevision: number) {
  return res.status(409).json({
    error: '그사이 다른 선생님이 시간표를 바꿨어요. 최신 시간표를 확인한 뒤 다시 시도해 주세요.',
    code: 'stale-revision',
    currentRevision,
  })
}

function conflictsError(res: NextApiResponse, plan: ChangePlan) {
  return res.status(409).json({
    error: '시간이 겹치는 수업이 있어요. 내용을 확인하고 그래도 발행하려면 충돌 확인을 선택해 주세요.',
    code: 'conflicts',
    conflicts: plan.conflicts,
    changes: plan.changes,
    affectedStudentCount: plan.affectedStudentCount,
    revision: plan.revision,
  })
}

/** 저장된 묶음 → 응답(발행 직후와 재전송이 같은 모양) */
function summary(id: string, d: DocumentData) {
  return {
    changeSetId: id,
    status: d.status,
    scope: d.scope,
    reason: d.reason || '',
    revision: typeof d.revision === 'number' ? d.revision : null,
    basedOnRevision: typeof d.basedOnRevision === 'number' ? d.basedOnRevision : null,
    overrideIds: d.overrideIds || [],
    seriesChanges: d.seriesChanges || { retired: [], created: [] },
    affectedCourseIds: d.affectedCourseIds || [],
    affectedDates: d.affectedDates || [],
    affectedStudentCount: Number(d.affectedStudentCount) || 0,
    conflicts: d.conflicts || [],
    conflictsAcknowledged: d.conflictsAcknowledged === true,
    changes: d.changes || [],
    orphans: d.orphans || [],
    approvals: d.approvals || {},
    createdBy: d.createdBy || null,
    createdByName: d.createdByName || null,
    createdAt: toMs(d.createdAt),
    publishedAt: toMs(d.publishedAt),
    rejectedBy: d.rejectedBy || null,
    rejectReason: d.rejectReason || null,
  }
}

async function respondWithStored(ctx: Ctx, id: string, res: NextApiResponse, extra: Record<string, unknown>) {
  const snap = await csCol(ctx).doc(id).get()
  const d = snap.data() || {}
  const status = d.status === 'pending-approval' ? 202 : 200
  return res.status(status).json({ ...summary(id, d), ...extra })
}

function parseChangeSetId(v: unknown): string {
  if (typeof v !== 'string' || !CHANGE_SET_ID_RE.test(v)) throw new ChangeError(400, 'invalid-request', '변경 묶음 id(changeSetId) 형식이 올바르지 않아요.')
  return v
}

async function requireCourseTeacher(ctx: Ctx, courseId: unknown): Promise<Course> {
  if (typeof courseId !== 'string' || !ID_RE.test(courseId)) throw new ChangeError(400, 'invalid-request', '수업 id(courseId)가 필요해요.')
  const course = (await loadCourses(ctx.db, ctx.schoolCode, [courseId])).get(courseId)
  if (!course) throw new ChangeError(404, 'course-not-found', '수업을 찾을 수 없어요.')
  if (!isCourseTeacher(course, ctx.u.uid)) throw new ChangeError(403, 'not-course-teacher', '이 수업의 담당 교사만 볼 수 있어요.')
  return course
}

/** 기본 변경: 계획 이후 대상 반복 차시가 바뀌지 않았는지(트랜잭션 안 읽기) */
async function seriesUnchanged(tx: Transaction, ctx: Ctx, plan: ChangePlan): Promise<boolean> {
  const col = schoolRef(ctx.db, ctx.schoolCode).collection('series')
  for (const r of plan.seriesRetire) {
    const snap = await tx.get(col.doc(r.seriesId))
    if (!snap.exists) return false
    const v = snap.get('validTo')
    if ((typeof v === 'string' && v ? v : null) !== r.expectValidTo) return false
  }
  return true
}

interface PublishMeta {
  mode: 'new' | 'approve'
  req: ChangeRequest
  hash: string
  actorUid: string
  createdBy: string
  createdByName: string
  approvals: Record<string, boolean>
}

/** 변경·반복 차시·묶음·감사·버전을 한 트랜잭션에 씀(읽기는 모두 끝난 뒤) */
function writePublish(tx: Transaction, ctx: Ctx, plan: ChangePlan, meta: PublishMeta) {
  const { db, schoolCode } = ctx
  const sref = schoolRef(db, schoolCode)
  const now = FieldValue.serverTimestamp()
  const approvedBy = Object.keys(meta.approvals).filter((k) => meta.approvals[k] === true)
  for (const d of plan.overrideDocs) {
    tx.set(sref.collection('overrides').doc(d.id), { ...stripUndefined(d.data), approvedBy, publishedAt: now })
  }
  for (const r of plan.seriesRetire) {
    tx.update(sref.collection('series').doc(r.seriesId), {
      validTo: r.validTo,
      status: 'retired',
      supersededBy: r.newSeriesId,
      retiredByChangeSetId: plan.changeSetId,
      updatedAt: now,
    })
  }
  for (const c of plan.seriesCreate) tx.set(sref.collection('series').doc(c.id), { ...stripUndefined(c.data), createdAt: now })

  const data = stripUndefined({
    mutationId: plan.mutationId,
    scope: meta.req.scope,
    status: 'published',
    items: meta.req.items.map(itemToJson),
    requestHash: meta.hash,
    overrideIds: plan.overrideDocs.map((d) => d.id),
    seriesChanges: { retired: plan.seriesRetire.map((r) => r.seriesId), created: plan.seriesCreate.map((c) => c.id) },
    reason: meta.req.reason,
    createdBy: meta.createdBy,
    createdByName: meta.createdByName,
    revision: plan.newRevision,
    basedOnRevision: plan.revision,
    affectedCourseIds: plan.affectedCourseIds,
    affectedDates: plan.affectedDates,
    courseDates: plan.courseDates,
    affectedStudentCount: plan.affectedStudentCount,
    conflicts: plan.conflicts,
    conflictsAcknowledged: plan.conflicts.length > 0,
    acknowledgeConflicts: meta.req.acknowledgeConflicts,
    changes: plan.changes,
    orphans: plan.orphans,
    approvals: meta.approvals,
    approverUids: Object.keys(meta.approvals),
  })
  const csRef = csCol(ctx).doc(plan.changeSetId)
  if (meta.mode === 'new') tx.set(csRef, { ...data, createdAt: now, publishedAt: now, publishedBy: meta.actorUid })
  else tx.set(csRef, { ...data, publishedAt: now, publishedBy: meta.actorUid, approvedAt: now }, { merge: true })

  writeAudit(tx, db, schoolCode, {
    action: 'schedule-change.publish',
    actorUid: meta.actorUid,
    target: `changeSets/${plan.changeSetId}`,
    revision: plan.newRevision,
    before: plan.changes.map((c) => ({ key: c.occurrenceKey, courseId: c.courseId, kind: c.kind, state: c.before })),
    after: plan.changes.map((c) => ({ key: c.occurrenceKey, courseId: c.courseId, kind: c.kind, state: c.after })),
    reason: meta.req.reason,
    meta: {
      scope: meta.req.scope,
      mutationId: plan.mutationId,
      overrideIds: plan.overrideDocs.map((d) => d.id),
      seriesRetired: plan.seriesRetire.map((r) => r.seriesId),
      seriesCreated: plan.seriesCreate.map((c) => c.id),
      affectedCourseIds: plan.affectedCourseIds,
      affectedDates: plan.affectedDates,
      affectedStudentCount: plan.affectedStudentCount,
      conflictCount: plan.conflicts.length,
      requestedBy: meta.createdBy,
      approvedBy,
    },
  })
  writeRevision(tx, db, schoolCode, plan.newRevision)
}

/** 커밋 후 영향 학생에게만 묶음당 1건(알림 id sched_<changeSetId>로 재시도·중복 이벤트에도 1건) */
async function notifyStudents(ctx: Ctx, changeSetId: string, d: DocumentData): Promise<{ created: number; skipped: number } | null> {
  try {
    const courseIds: string[] = Array.isArray(d.affectedCourseIds) ? d.affectedCourseIds : []
    const courseDates: Record<string, Ymd[]> = d.courseDates && typeof d.courseDates === 'object' ? d.courseDates : {}
    const courses = Array.from((await loadCourses(ctx.db, ctx.schoolCode, courseIds)).values())
    if (!courses.length) return { created: 0, skipped: 0 }
    const idx = await loadMemberIndex(ctx.db, ctx.schoolCode, courses)
    const affected = affectedStudents(idx, courses, courseDates)
    const titles = new Map(courses.map((c) => [c.courseId, c.title]))
    let created = 0
    let skipped = 0
    for (const g of studentNotifyGroups(affected, titles, d.scope === 'base' ? 'base' : 'date')) {
      const r = await notifyUsersOnce(ctx.db, g.uids, 'sched_' + changeSetId, { title: g.title, body: g.body, url: g.url })
      created += r.created
      skipped += r.skipped
    }
    await csCol(ctx).doc(changeSetId).set({ notifiedAt: FieldValue.serverTimestamp(), notifiedCount: created }, { merge: true })
    return { created, skipped }
  } catch (e) {
    // 발행은 이미 끝남 — 알림 실패는 응답에 표시하고, 같은 mutationId 재전송 시 다시 시도(중복 없이)
    console.error('schedule-changes notify failed:', (e as Error)?.message)
    return null
  }
}

/** 교사 알림(승인 요청·결과) — 실패해도 요청 처리는 유지 */
async function notifyTeachers(ctx: Ctx, uids: string[], dedupeId: string, msg: { title: string; body: string; url: string }) {
  if (!uids.length) return
  try {
    await notifyUsersOnce(ctx.db, uids, dedupeId, msg)
  } catch (e) {
    console.error('schedule-changes teacher notify failed:', (e as Error)?.message)
  }
}

function titlesOf(d: DocumentData): string {
  const titles = Array.from(new Set((Array.isArray(d.changes) ? d.changes : []).map((c: any) => String(c?.title || '')).filter(Boolean))) as string[]
  if (!titles.length) return '수업'
  return titles.length > 1 ? `${titles[0]} 외 ${titles.length - 1}개 수업` : titles[0]
}

function firstDateOf(d: DocumentData): string {
  const dates: string[] = Array.isArray(d.affectedDates) ? d.affectedDates.slice().sort() : []
  return dates.length ? ` (${shortDate(dates[0])})` : ''
}

// ───────────────────────── preview ─────────────────────────

async function preview(ctx: Ctx, body: Body, res: NextApiResponse) {
  const req = parseChangeRequest(body, { requireMutationId: false, requireRevision: false })
  if (req.expectedRevision !== null) {
    const cur = await currentRevision(ctx.db, ctx.schoolCode)
    if (cur !== req.expectedRevision) return stale(res, cur)
  }
  const plan = await makePlan(ctx, req, req.mutationId || 'preview', ctx.u.uid)
  return res.status(200).json({
    changes: plan.changes,
    affectedStudentCount: plan.affectedStudentCount,
    conflicts: plan.conflicts,
    orphans: plan.orphans,
    revision: plan.revision,
    requiresApproval: plan.notOwnedCourseIds.length > 0,
    approverUids: Object.keys(plan.approvals),
  })
}

// ───────────────────────── publish ─────────────────────────

type TxOutcome = { kind: 'replay' } | { kind: 'stale'; rev: number } | { kind: 'retry' } | { kind: 'pending' } | { kind: 'published' }

async function replayStored(ctx: Ctx, id: string, d: DocumentData, hash: string, res: NextApiResponse) {
  if (d.createdBy !== ctx.u.uid || (d.requestHash && d.requestHash !== hash)) {
    return apiError(res, 409, 'mutation-id-reused', '이미 다른 내용에 쓰인 요청 id예요. 화면을 새로고침한 뒤 다시 시도해 주세요.')
  }
  if (d.status === 'rejected') {
    return res.status(409).json({ error: '이 변경 요청은 거절되었어요.', code: 'rejected', ...summary(id, d), replayed: true })
  }
  // 발행 후 알림 단계가 끝나지 못했으면 다시 시도(알림 id가 같아 중복되지 않음)
  const notified = d.status === 'published' && !d.notifiedAt ? await notifyStudents(ctx, id, d) : null
  return res.status(d.status === 'pending-approval' ? 202 : 200).json({ ...summary(id, d), replayed: true, notified })
}

async function publish(ctx: Ctx, body: Body, res: NextApiResponse) {
  const req = parseChangeRequest(body, { requireMutationId: true, requireRevision: true })
  const mutationId = req.mutationId as string
  const hash = requestHash(req)
  const changeSetId = changeSetIdOf(mutationId)
  const csRef = csCol(ctx).doc(changeSetId)
  const { db, schoolCode, u } = ctx

  // 같은 요청 재전송 → 저장된 결과 그대로(버전 비교보다 먼저 — 첫 요청이 이미 버전을 올렸기 때문)
  const existing = await csRef.get()
  if (existing.exists) return replayStored(ctx, changeSetId, existing.data() || {}, hash, res)

  const cur = await currentRevision(db, schoolCode)
  if (cur !== req.expectedRevision) return stale(res, cur)

  for (let attempt = 0; attempt < 3; attempt++) {
    const plan = await makePlan(ctx, req, mutationId, u.uid)
    if (plan.conflicts.length && !req.acknowledgeConflicts) return conflictsError(res, plan)
    const pending = plan.notOwnedCourseIds.length > 0
    const createdByName = nameOf(u.user)

    const outcome: TxOutcome = await db.runTransaction(async (tx): Promise<TxOutcome> => {
      const cs = await tx.get(csRef)
      if (cs.exists) return { kind: 'replay' }
      const rev = await readRevision(tx, db, schoolCode)
      if (rev !== req.expectedRevision) return { kind: 'stale', rev }
      if (rev !== plan.revision) return { kind: 'retry' }
      if (pending) {
        tx.set(csRef, {
          ...stripUndefined({
            mutationId,
            scope: req.scope,
            status: 'pending-approval',
            items: req.items.map(itemToJson),
            requestHash: hash,
            overrideIds: [],
            seriesChanges: { retired: [], created: [] },
            reason: req.reason,
            createdBy: u.uid,
            createdByName,
            revision: null,
            basedOnRevision: plan.revision,
            affectedCourseIds: plan.affectedCourseIds,
            affectedDates: plan.affectedDates,
            courseDates: plan.courseDates,
            affectedStudentCount: plan.affectedStudentCount,
            conflicts: plan.conflicts,
            conflictsAcknowledged: plan.conflicts.length > 0,
            acknowledgeConflicts: req.acknowledgeConflicts,
            changes: plan.changes,
            orphans: plan.orphans,
            approvals: plan.approvals,
            approverUids: Object.keys(plan.approvals),
          }),
          createdAt: FieldValue.serverTimestamp(),
        })
        writeAudit(tx, db, schoolCode, {
          action: 'schedule-change.request',
          actorUid: u.uid,
          target: `changeSets/${changeSetId}`,
          revision: plan.revision,
          reason: req.reason,
          meta: {
            scope: req.scope,
            mutationId,
            affectedCourseIds: plan.affectedCourseIds,
            affectedDates: plan.affectedDates,
            approverCount: Object.keys(plan.approvals).length,
          },
        })
        return { kind: 'pending' }
      }
      if (!(await seriesUnchanged(tx, ctx, plan))) return { kind: 'retry' }
      writePublish(tx, ctx, plan, { mode: 'new', req, hash, actorUid: u.uid, createdBy: u.uid, createdByName, approvals: {} })
      return { kind: 'published' }
    })

    if (outcome.kind === 'retry') continue
    if (outcome.kind === 'stale') return stale(res, outcome.rev)
    if (outcome.kind === 'replay') {
      const snap = await csRef.get()
      return replayStored(ctx, changeSetId, snap.data() || {}, hash, res)
    }
    if (outcome.kind === 'pending') {
      const snap = await csRef.get()
      const d = snap.data() || {}
      await notifyTeachers(ctx, Object.keys(plan.approvals), 'schedreq_' + changeSetId, {
        title: '시간표 변경 승인 요청',
        body: `${createdByName} 선생님이 ${titlesOf(d)} 일정 변경을 요청했어요${firstDateOf(d)}`,
        url: `${TEACHER_CHANGES_URL}?changeSetId=${changeSetId}`,
      })
      return res.status(202).json({ ...summary(changeSetId, d), replayed: false })
    }
    const snap = await csRef.get()
    const d = snap.data() || {}
    const notified = await notifyStudents(ctx, changeSetId, d)
    return res.status(200).json({ ...summary(changeSetId, d), replayed: false, notified })
  }
  return apiError(res, 409, 'busy', '다른 변경이 동시에 처리되고 있어요. 잠시 후 다시 시도해 주세요.')
}

// ───────────────────────── approve / reject ─────────────────────────

interface ApprovalRecord {
  /** 트랜잭션에서 읽은 묶음 상태 — 'pending-approval'일 때만 기록함 */
  status: string
  /** 내 승인을 더한 최신 승인 상태 */
  approvals: Record<string, boolean>
  allApproved: boolean
}

/**
 * 내 승인을 기록하고, 트랜잭션 안에서 읽은 최신 승인 상태로 '모두 승인' 여부를 돌려줌.
 * 승인자 둘이 동시에 승인하면 트랜잭션 밖 스냅숏으로는 둘 다 '상대 미승인'으로 보여 발행이 멈추므로(모두 승인인데 대기),
 * 나중에 기록한 쪽이 여기서 모두 승인을 보고 발행으로 이어갑니다.
 */
async function recordApproval(ctx: Ctx, changeSetId: string, uid: string): Promise<ApprovalRecord> {
  const csRef = csCol(ctx).doc(changeSetId)
  return ctx.db.runTransaction(async (tx): Promise<ApprovalRecord> => {
    const cur = await tx.get(csRef)
    const status = cur.exists ? String(cur.get('status') || '') : 'missing'
    const raw = cur.exists ? cur.get('approvals') : null
    const approvals: Record<string, boolean> = raw && typeof raw === 'object' ? { ...raw } : {}
    if (status !== 'pending-approval') return { status, approvals, allApproved: false }
    tx.update(csRef, new FieldPath('approvals', uid), true, 'updatedAt', FieldValue.serverTimestamp())
    writeAudit(tx, ctx.db, ctx.schoolCode, {
      action: 'schedule-change.approve',
      actorUid: uid,
      target: `changeSets/${changeSetId}`,
      meta: { mutationId: cur.get('mutationId') || null },
    })
    approvals[uid] = true
    return { status, approvals, allApproved: Object.keys(approvals).every((k) => approvals[k] === true) }
  })
}

async function approve(ctx: Ctx, body: Body, res: NextApiResponse) {
  const changeSetId = parseChangeSetId(body.changeSetId)
  const csRef = csCol(ctx).doc(changeSetId)
  const { db, schoolCode, u } = ctx
  const snap = await csRef.get()
  if (!snap.exists) return apiError(res, 404, 'change-set-not-found', '변경 요청을 찾을 수 없어요.')
  const d = snap.data() || {}
  const approvals: Record<string, boolean> = d.approvals && typeof d.approvals === 'object' ? d.approvals : {}
  if (!Object.prototype.hasOwnProperty.call(approvals, u.uid)) {
    return apiError(res, 403, 'not-approver', '이 변경 요청을 승인할 수 있는 담당 교사가 아니에요.')
  }
  if (d.status === 'published') return res.status(200).json({ ...summary(changeSetId, d), replayed: true })
  if (d.status !== 'pending-approval') return apiError(res, 409, 'not-pending', '이미 처리된 변경 요청이에요.')

  let next: Record<string, boolean> = { ...approvals, [u.uid]: true }
  let recorded = false
  if (!Object.keys(next).every((k) => next[k] === true)) {
    // 스냅숏으로는 아직 남은 승인자가 있음 — 기록하면서 트랜잭션 안의 최신 승인 상태로 다시 판단(동시 승인)
    const rec = await recordApproval(ctx, changeSetId, u.uid)
    recorded = true
    if (rec.status !== 'pending-approval') {
      // 그사이 다른 승인자가 발행했거나 거절·철회됨(위의 상태 확인과 같은 응답)
      const cur = (await csRef.get()).data() || {}
      if (cur.status === 'published') return res.status(200).json({ ...summary(changeSetId, cur), replayed: true })
      return apiError(res, 409, 'not-pending', '이미 처리된 변경 요청이에요.')
    }
    if (!rec.allApproved) return respondWithStored(ctx, changeSetId, res, { replayed: false })
    next = rec.approvals
  }

  // 모두 승인: 요청 당시가 아니라 '지금' 시간표 기준으로 다시 검증·충돌 검사 후 발행
  const req = parseChangeRequest(
    { scope: d.scope, reason: d.reason, items: d.items, mutationId: d.mutationId, acknowledgeConflicts: d.acknowledgeConflicts === true },
    { requireMutationId: true, requireRevision: false }
  )
  const mutationId = req.mutationId as string
  const requester = String(d.createdBy || '')
  for (let attempt = 0; attempt < 3; attempt++) {
    let plan: ChangePlan
    try {
      plan = await makePlan(ctx, req, mutationId, requester)
    } catch (e) {
      if (e instanceof ChangeError && (e.status === 400 || e.status === 404)) {
        return res.status(409).json({ error: `요청 이후 시간표가 바뀌어 이 변경을 그대로 적용할 수 없어요. (${e.message})`, code: 'no-longer-valid', reasonCode: e.code })
      }
      throw e
    }
    // 승인 범위: 요청자가 담당이 아닌 수업마다 '지금' 담당 교사 중 승인한 사람이 있어야 함
    for (const id of plan.notOwnedCourseIds) {
      const c = plan.courses.find((x) => x.courseId === id)
      if (!c || !courseManagerUids(c).some((t) => next[t] === true)) {
        return apiError(res, 409, 'approvers-changed', '요청 이후 담당 교사가 바뀌었어요. 변경을 다시 요청해 주세요.')
      }
    }
    // 요청자의 '충돌 확인'은 요청 때 보여 준(저장된) 충돌에만 유효 — 승인 시점에 새로 생긴 충돌은 승인자가 직접 확인해야 함
    const acknowledged = body.acknowledgeConflicts === true || (req.acknowledgeConflicts && conflictsCovered(plan.conflicts, d.conflicts))
    if (plan.conflicts.length && !acknowledged) {
      if (!recorded) await recordApproval(ctx, changeSetId, u.uid)
      return conflictsError(res, plan)
    }
    const reqForWrite: ChangeRequest = { ...req, acknowledgeConflicts: acknowledged }
    const outcome: TxOutcome = await db.runTransaction(async (tx): Promise<TxOutcome> => {
      const cs = await tx.get(csRef)
      if (!cs.exists || cs.get('status') !== 'pending-approval') return { kind: 'replay' }
      const rev = await readRevision(tx, db, schoolCode)
      if (rev !== plan.revision) return { kind: 'retry' }
      if (!(await seriesUnchanged(tx, ctx, plan))) return { kind: 'retry' }
      writePublish(tx, ctx, plan, {
        mode: 'approve',
        req: reqForWrite,
        hash: String(d.requestHash || requestHash(req)),
        actorUid: u.uid,
        createdBy: requester,
        createdByName: String(d.createdByName || '선생님'),
        approvals: next,
      })
      return { kind: 'published' }
    })
    if (outcome.kind === 'retry') continue
    if (outcome.kind === 'replay') {
      const cur = (await csRef.get()).data() || {}
      if (cur.status === 'published') return res.status(200).json({ ...summary(changeSetId, cur), replayed: true })
      return apiError(res, 409, 'not-pending', '이미 처리된 변경 요청이에요.')
    }
    const after = (await csRef.get()).data() || {}
    const notified = await notifyStudents(ctx, changeSetId, after)
    await notifyTeachers(ctx, requester && requester !== u.uid ? [requester] : [], 'schedreq_ok_' + changeSetId, {
      title: '시간표 변경 승인됨',
      body: `${titlesOf(after)} 변경 요청이 승인되어 발행되었어요${firstDateOf(after)}`,
      url: `${TEACHER_CHANGES_URL}?changeSetId=${changeSetId}`,
    })
    return res.status(200).json({ ...summary(changeSetId, after), replayed: false, notified })
  }
  return apiError(res, 409, 'busy', '다른 변경이 동시에 처리되고 있어요. 잠시 후 다시 시도해 주세요.')
}

async function reject(ctx: Ctx, body: Body, res: NextApiResponse) {
  const changeSetId = parseChangeSetId(body.changeSetId)
  const csRef = csCol(ctx).doc(changeSetId)
  const { u } = ctx
  const snap = await csRef.get()
  if (!snap.exists) return apiError(res, 404, 'change-set-not-found', '변경 요청을 찾을 수 없어요.')
  const d = snap.data() || {}
  const approvals: Record<string, boolean> = d.approvals && typeof d.approvals === 'object' ? d.approvals : {}
  const isApprover = Object.prototype.hasOwnProperty.call(approvals, u.uid)
  const isRequester = d.createdBy === u.uid
  if (!isApprover && !isRequester) return apiError(res, 403, 'not-approver', '이 변경 요청을 거절할 수 있는 담당 교사가 아니에요.')
  if (d.status !== 'pending-approval') return apiError(res, 409, 'not-pending', '이미 처리된 변경 요청이에요.')
  const reason = cleanText(body.reason, 200)
  const done = await ctx.db.runTransaction(async (tx) => {
    const cur = await tx.get(csRef)
    if (!cur.exists || cur.get('status') !== 'pending-approval') return false
    tx.update(csRef, {
      status: 'rejected',
      rejectedBy: u.uid,
      rejectedAt: FieldValue.serverTimestamp(),
      rejectReason: reason || null,
      withdrawn: !isApprover && isRequester,
    })
    writeAudit(tx, ctx.db, ctx.schoolCode, {
      action: isApprover ? 'schedule-change.reject' : 'schedule-change.withdraw',
      actorUid: u.uid,
      target: `changeSets/${changeSetId}`,
      reason,
      meta: { mutationId: cur.get('mutationId') || null },
    })
    return true
  })
  if (!done) return apiError(res, 409, 'not-pending', '이미 처리된 변경 요청이에요.')
  if (!isRequester && d.createdBy) {
    await notifyTeachers(ctx, [String(d.createdBy)], 'schedreq_no_' + changeSetId, {
      title: '시간표 변경 요청 거절',
      body: `${titlesOf(d)} 변경 요청이 거절되었어요`,
      url: `${TEACHER_CHANGES_URL}?changeSetId=${changeSetId}`,
    })
  }
  return respondWithStored(ctx, changeSetId, res, { replayed: false })
}

// ───────────────────────── list / orphans ─────────────────────────

async function list(ctx: Ctx, body: Body, res: NextApiResponse) {
  if (body.awaitingMe === true) {
    // 내 승인을 기다리는 요청 — 상태는 쿼리에서 거름(처리된 묶음도 approverUids에 남아 limit 안을 채우면 대기 요청이 잘림).
    // 배열 포함 + 등호 하나라 복합 색인 불필요, 정렬은 메모리에서
    const snap = await csCol(ctx)
      .where('approverUids', 'array-contains', ctx.u.uid)
      .where('status', '==', 'pending-approval')
      .limit(200)
      .get()
    const rows = snap.docs
      .filter((d) => d.get('status') === 'pending-approval')
      .map((d) => summary(d.id, d.data()))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 50)
    return res.status(200).json({ changeSets: rows })
  }
  const course = await requireCourseTeacher(ctx, body.courseId)
  // 색인 필요: changeSets (affectedCourseIds ARRAY_CONTAINS, createdAt DESC)
  const snap = await csCol(ctx).where('affectedCourseIds', 'array-contains', course.courseId).orderBy('createdAt', 'desc').limit(50).get()
  return res.status(200).json({ changeSets: snap.docs.map((d) => summary(d.id, d.data())) })
}

async function orphans(ctx: Ctx, body: Body, res: NextApiResponse) {
  const course = await requireCourseTeacher(ctx, body.courseId)
  const [records, series] = await Promise.all([
    loadOverridesByCourses(ctx.db, ctx.schoolCode, [course.courseId]),
    loadSeriesForCourses(ctx.db, ctx.schoolCode, [course.courseId]),
  ])
  return res.status(200).json({ courseId: course.courseId, orphans: findOrphans(records, series) })
}
