import type { NextApiRequest, NextApiResponse } from 'next'
import { FieldPath, FieldValue, type DocumentReference, type Firestore } from 'firebase-admin/firestore'
import { DAY_KEYS, PERIOD_COUNT, cleanSubject, normalizeName } from '../../lib/timetableConvert'
import { isYmd, schoolYmdAt } from '../../lib/timetable/dates'
import {
  baseStateOf,
  courseActiveOn,
  detectResourceConflicts,
  validateSlot,
  type ScheduledOccurrence,
} from '../../lib/timetable/engine'
import {
  apiError,
  chunk,
  courseFromDoc,
  currentRevision,
  enrollmentFromDoc,
  ID_RE,
  isTeacher,
  readRevision,
  requireUser,
  schoolRef,
  seriesFromDoc,
  writeAudit,
  writeRevision,
  type ApiUser,
} from '../../lib/timetable/server'
import {
  buildPeriodTimes,
  canManageCourse,
  getDocsById,
  homeroomLabel,
  readTermDocs,
  studentHomeroomLabel,
  termForDateFromDocs,
  termRangeOf,
  TimetableApiError,
  toStudentNo,
} from '../../lib/timetable/studentData'
import { homeroomCourseId, homeroomSeriesId } from '../../lib/timetable/ids'
import { planHomeroomSeries } from '../../lib/timetable/changes'
import type { Course, LessonSeries, Weekday, Ymd } from '../../lib/timetable/types'

// POST /api/courses  { action, ... }
// Header: Authorization: Bearer <Firebase ID token>
// 수업반(schools/{s}/courses)과 반복 차시(schools/{s}/series)를 서버에서만 만들고 고칩니다.
// 권한은 users/{uid}(role, schoolCode)와 수업 문서(teacherUids/managerUids), 학급 문서(teacherId)로 판정합니다.
// - create          같은 학교 교사. 요청자가 담당 교사(teacherUids)
// - update/end      담당 교사
// - setCommon       그 학급 담임만(학급 학생 모두가 듣는 공통 수업으로 '명시')
// - addSeries       담당 교사. 같은 수업 중복 차시 금지, 담당 교사·교실 충돌은 acknowledgeConflicts 없으면 409
// - retireSeries    담당 교사. 적용일부터 그 차시 종료(validTo) — 지난 날짜는 그대로
// - fromHomeroomTimetable  담임만. 학급 시간표 → (과목, 교사)마다 공통 수업 + 칸마다 차시 (다시 실행해도 중복 없음,
//                          기본 시간표 변경으로 옮긴 칸은 그대로 두고 학급 시간표가 바뀐 칸만 적용일부터 반영)
// - list            교사: 내가 담당·관리하는 수업 + 내가 담임인 학급의 공통 수업
// - get             담당 교사: 수업·차시·수강 인원·승인 대기 명단(명단은 담당 교사에게만)
// - catalog         같은 학교 사용자(학생): 현재 학기 공개 수업의 제목·과목·분반·교사 이름·요일 교시만
// 모든 쓰기는 트랜잭션에서 schools/{s}.scheduleRevision을 1 올리고 감사 로그를 남깁니다.
// 오류: { error, code } — 400 입력, 401, 403 권한, 404 대상 없음, 409 충돌·중복·종료, 500 server-error

const POLICIES = ['auto', 'approval'] as const
type Policy = (typeof POLICIES)[number]

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

const has = (body: Record<string, any>, key: string) => Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined

/** 문자열 입력. 없으면 undefined, null·''이면 ''(지우기). 너무 길면 400 */
function textField(body: Record<string, any>, key: string, max: number, label: string, required = false): string | undefined {
  if (!has(body, key) || body[key] === null || body[key] === '') {
    if (required) fail(400, 'missing-field', `${label}을(를) 입력해 주세요.`)
    return has(body, key) ? '' : undefined
  }
  if (typeof body[key] !== 'string') fail(400, 'invalid-field', `${label} 형식이 올바르지 않아요.`)
  const t = String(body[key]).replace(/[\u0000-\u001f]/g, ' ').trim()
  if (required && !t) fail(400, 'missing-field', `${label}을(를) 입력해 주세요.`)
  if (t.length > max) fail(400, 'too-long', `${label}은(는) ${max}자 이하로 입력해 주세요.`)
  return t
}

function idField(v: unknown, label: string): string {
  if (typeof v !== 'string' || !ID_RE.test(v)) fail(400, 'invalid-id', `${label} 값이 올바르지 않아요.`)
  return v as string
}

function boolField(body: Record<string, any>, key: string): boolean | undefined {
  if (!has(body, key)) return undefined
  if (typeof body[key] !== 'boolean') fail(400, 'invalid-field', `${key} 값은 true/false여야 해요.`)
  return body[key]
}

function policyField(body: Record<string, any>): Policy | undefined {
  if (!has(body, 'invitePolicy')) return undefined
  if (!POLICIES.includes(body.invitePolicy)) fail(400, 'invalid-field', "참여 방식은 'auto' 또는 'approval'이어야 해요.")
  return body.invitePolicy
}

function teacherNamesField(body: Record<string, any>): string[] | undefined {
  if (!has(body, 'teacherNames')) return undefined
  const v = body.teacherNames
  if (!Array.isArray(v)) fail(400, 'invalid-field', '교사 이름 목록 형식이 올바르지 않아요.')
  const out: string[] = []
  for (const x of v as unknown[]) {
    if (typeof x !== 'string') fail(400, 'invalid-field', '교사 이름 형식이 올바르지 않아요.')
    const t = (x as string).replace(/[\u0000-\u001f]/g, ' ').trim()
    if (!t) continue
    if (t.length > 20) fail(400, 'too-long', '교사 이름은 20자 이하로 입력해 주세요.')
    if (!out.includes(t)) out.push(t)
  }
  if (out.length > 5) fail(400, 'too-many', '교사 이름은 5명까지 넣을 수 있어요.')
  return out
}

function intField(v: unknown, min: number, max: number, label: string): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  if (!Number.isInteger(n) || n < min || n > max) fail(400, 'invalid-field', `${label}은(는) ${min}~${max} 사이여야 해요.`)
  return n
}

function hmField(body: Record<string, any>, key: string): string | null {
  if (!has(body, key) || body[key] === null || body[key] === '') return null
  if (typeof body[key] !== 'string') fail(400, 'invalid-slot', '시각 형식이 올바르지 않아요(HH:MM).')
  return String(body[key]).trim()
}

function requireTeacher(ctx: Ctx) {
  if (!isTeacher(ctx.u)) fail(403, 'teacher-only', '선생님 계정만 할 수 있어요.')
}

/** 학급 문서의 학교: schoolCode가 없는 예전 문서는 classId 첫 토막(보안 규칙과 같은 기준) */
function classSchoolOf(cls: Record<string, any>, classId: string): string {
  return String(cls.schoolCode || classId.split('_')[0])
}

/** 응답용 수업(교사 화면) */
function courseView(id: string, d: Record<string, any>) {
  return {
    ...courseFromDoc(id, d),
    invitePolicy: d.invitePolicy === 'approval' ? 'approval' : 'auto',
    catalogVisible: d.catalogVisible === true,
    legacyGroupId: typeof d.legacyGroupId === 'string' ? d.legacyGroupId : null,
    managerUids: Array.isArray(d.managerUids) ? d.managerUids.filter((x: unknown) => typeof x === 'string') : [],
    source: typeof d.source === 'string' ? d.source : 'manual',
  }
}

/** 기간 [from, to) 두 개가 겹치는지(to가 null이면 열린 구간) */
function periodsOverlap(aFrom: Ymd, aTo: Ymd | null, bFrom: Ymd, bTo: Ymd | null): boolean {
  return (!bTo || aFrom < bTo) && (!aTo || bFrom < aTo)
}

/** 실제로 열리는 차시인지(삭제·빈 기간 제외) */
function seriesAlive(s: LessonSeries): boolean {
  if (s.status === 'retired' && !s.validTo) return false
  return !s.validTo || s.validTo > s.validFrom
}

async function checkHomerooms(ctx: Ctx, raw: unknown): Promise<string[]> {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.length > 20) fail(400, 'invalid-field', '공통 수업 학급 목록 형식이 올바르지 않아요.')
  const ids = Array.from(new Set((raw as unknown[]).map((v) => idField(v, '학급'))))
  if (!ids.length) return []
  const snaps = await getDocsById(ctx.db, ids.map((id) => ctx.db.collection('classes').doc(id)))
  for (const s of snaps) {
    const cls = s.exists ? s.data() || {} : null
    if (!cls || cls.isGroup === true || String(cls.teacherId || '') !== ctx.uid || classSchoolOf(cls, s.id) !== ctx.schoolCode) {
      fail(403, 'not-homeroom-teacher', '담임을 맡은 학급만 공통 수업으로 지정할 수 있어요.')
    }
  }
  return ids
}

async function checkGroupOwner(ctx: Ctx, groupId: string): Promise<string> {
  const s = await ctx.db.collection('classes').doc(groupId).get()
  const g = s.exists ? s.data() || {} : null
  if (!g || g.isGroup !== true || String(g.teacherId || '') !== ctx.uid || classSchoolOf(g, groupId) !== ctx.schoolCode) {
    fail(403, 'not-group-owner', '내가 만든 수업 그룹만 연결할 수 있어요.')
  }
  return groupId
}

function termIdField(termDocs: Array<{ id: string; data: Record<string, any> }>, v: unknown): string {
  if (typeof v !== 'string' || v.length > 20 || !ID_RE.test(v) || !termRangeOf(termDocs, v)) {
    fail(400, 'invalid-term', '학기 값이 올바르지 않아요.')
  }
  return v as string
}

// ───────────────────────── create / update / end / setCommon ─────────────────────────

async function createCourse(ctx: Ctx) {
  requireTeacher(ctx)
  const b = ctx.body
  const title = textField(b, 'title', 40, '수업 이름', true) as string
  const subject = textField(b, 'subject', 40, '과목', true) as string
  const section = textField(b, 'section', 20, '분반') || null
  const defaultRoomName = textField(b, 'defaultRoomName', 30, '기본 교실') || null
  const myName = String(ctx.u.user.name || ctx.u.user.displayName || '').trim().slice(0, 20)
  const teacherNames = teacherNamesField(b) ?? (myName ? [myName] : [])
  const invitePolicy = policyField(b) ?? 'auto'
  const catalogVisible = boolField(b, 'catalogVisible') ?? false
  const termDocs = await readTermDocs(ctx.db, ctx.schoolCode)
  const termId = has(b, 'termId') && b.termId !== null && b.termId !== '' ? termIdField(termDocs, b.termId) : termForDateFromDocs(termDocs, ctx.today).termId
  const legacyGroupId = has(b, 'legacyGroupId') && b.legacyGroupId ? await checkGroupOwner(ctx, idField(b.legacyGroupId, '수업 그룹')) : null
  const commonForHomerooms = await checkHomerooms(ctx, b.commonForHomerooms)

  const sref = schoolRef(ctx.db, ctx.schoolCode)
  const ref = sref.collection('courses').doc()
  const doc: Record<string, any> = {
    schoolCode: ctx.schoolCode,
    termId,
    title,
    subject,
    section,
    teacherUids: [ctx.uid],
    teacherNames,
    managerUids: [],
    status: 'active',
    endedOn: null,
    commonForHomerooms,
    defaultRoomId: null,
    defaultRoomName,
    invitePolicy,
    catalogVisible,
    legacyGroupId,
    source: 'manual',
    createdBy: ctx.uid,
  }
  const revision = await ctx.db.runTransaction(async (tx) => {
    const rev = (await readRevision(tx, ctx.db, ctx.schoolCode)) + 1
    tx.set(ref, { ...doc, revision: rev, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
    writeRevision(tx, ctx.db, ctx.schoolCode, rev)
    writeAudit(tx, ctx.db, ctx.schoolCode, {
      action: 'course.create',
      actorUid: ctx.uid,
      target: `courses/${ref.id}`,
      revision: rev,
      after: { title, subject, section, termId, commonForHomerooms, legacyGroupId },
    })
    return rev
  })
  return { ok: true, courseId: ref.id, course: courseView(ref.id, doc), revision }
}

async function updateCourse(ctx: Ctx) {
  requireTeacher(ctx)
  const b = ctx.body
  const courseId = idField(b.courseId, '수업')
  const patch: Record<string, any> = {}
  const title = textField(b, 'title', 40, '수업 이름')
  if (title !== undefined) {
    if (!title) fail(400, 'missing-field', '수업 이름을(를) 입력해 주세요.')
    patch.title = title
  }
  const subject = textField(b, 'subject', 40, '과목')
  if (subject !== undefined) {
    if (!subject) fail(400, 'missing-field', '과목을(를) 입력해 주세요.')
    patch.subject = subject
  }
  const section = textField(b, 'section', 20, '분반')
  if (section !== undefined) patch.section = section || null
  const room = textField(b, 'defaultRoomName', 30, '기본 교실')
  if (room !== undefined) patch.defaultRoomName = room || null
  const teacherNames = teacherNamesField(b)
  if (teacherNames !== undefined) patch.teacherNames = teacherNames
  const policy = policyField(b)
  if (policy !== undefined) patch.invitePolicy = policy
  const visible = boolField(b, 'catalogVisible')
  if (visible !== undefined) patch.catalogVisible = visible
  if (has(b, 'legacyGroupId')) patch.legacyGroupId = b.legacyGroupId ? await checkGroupOwner(ctx, idField(b.legacyGroupId, '수업 그룹')) : null
  if (!Object.keys(patch).length) fail(400, 'nothing-to-update', '바꿀 내용이 없어요.')

  const ref = schoolRef(ctx.db, ctx.schoolCode).collection('courses').doc(courseId)
  return ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) fail(404, 'course-not-found', '수업을 찾을 수 없어요.')
    const cur = snap.data() || {}
    if (!canManageCourse(cur, ctx.uid)) fail(403, 'not-course-teacher', '담당 선생님만 수업을 바꿀 수 있어요.')
    const rev0 = await readRevision(tx, ctx.db, ctx.schoolCode)
    const before: Record<string, unknown> = {}
    const after: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(patch)) {
      if (JSON.stringify(cur[k] ?? null) !== JSON.stringify(v ?? null)) {
        before[k] = cur[k] ?? null
        after[k] = v
      }
    }
    if (!Object.keys(after).length) return { ok: true, already: true, courseId, course: courseView(courseId, cur), revision: rev0 }
    const rev = rev0 + 1
    tx.set(ref, { ...after, revision: rev, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    writeRevision(tx, ctx.db, ctx.schoolCode, rev)
    writeAudit(tx, ctx.db, ctx.schoolCode, { action: 'course.update', actorUid: ctx.uid, target: `courses/${courseId}`, revision: rev, before, after })
    return { ok: true, courseId, course: courseView(courseId, { ...cur, ...after }), revision: rev }
  })
}

async function endCourse(ctx: Ctx) {
  requireTeacher(ctx)
  const courseId = idField(ctx.body.courseId, '수업')
  const endedOn = has(ctx.body, 'endedOn') ? ctx.body.endedOn : ctx.today
  if (!isYmd(endedOn)) fail(400, 'bad-date', '종료일 형식이 올바르지 않아요(YYYYMMDD).')
  const ref = schoolRef(ctx.db, ctx.schoolCode).collection('courses').doc(courseId)
  return ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) fail(404, 'course-not-found', '수업을 찾을 수 없어요.')
    const cur = snap.data() || {}
    if (!canManageCourse(cur, ctx.uid)) fail(403, 'not-course-teacher', '담당 선생님만 수업을 끝낼 수 있어요.')
    const rev0 = await readRevision(tx, ctx.db, ctx.schoolCode)
    if (cur.status === 'ended' && cur.endedOn === endedOn) return { ok: true, already: true, courseId, endedOn, revision: rev0 }
    const rev = rev0 + 1
    tx.set(ref, { status: 'ended', endedOn, revision: rev, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    writeRevision(tx, ctx.db, ctx.schoolCode, rev)
    writeAudit(tx, ctx.db, ctx.schoolCode, {
      action: 'course.end',
      actorUid: ctx.uid,
      target: `courses/${courseId}`,
      revision: rev,
      before: { status: cur.status ?? 'active', endedOn: cur.endedOn ?? null },
      after: { status: 'ended', endedOn },
    })
    return { ok: true, courseId, endedOn, revision: rev }
  })
}

async function setCommon(ctx: Ctx) {
  requireTeacher(ctx)
  const courseId = idField(ctx.body.courseId, '수업')
  const homeroomId = idField(ctx.body.homeroomId, '학급')
  const enabled = boolField(ctx.body, 'enabled')
  if (enabled === undefined) fail(400, 'invalid-field', 'enabled 값이 필요해요.')
  await checkHomerooms(ctx, [homeroomId])
  const ref = schoolRef(ctx.db, ctx.schoolCode).collection('courses').doc(courseId)
  const termDocs = enabled ? await readTermDocs(ctx.db, ctx.schoolCode) : []
  return ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) fail(404, 'course-not-found', '수업을 찾을 수 없어요.')
    const cur = snap.data() || {}
    if (enabled) {
      // 끝난 수업·지난 학기 수업은 공통 수업으로 새로 지정하지 않음(해제는 언제나 가능)
      if (!courseActiveOn(courseFromDoc(courseId, cur), ctx.today)) fail(409, 'course-ended', '이미 끝난 수업은 공통 수업으로 지정할 수 없어요.')
      const range = cur.termId ? termRangeOf(termDocs, String(cur.termId)) : null
      if (range && range.endDate <= ctx.today) fail(409, 'term-ended', '지난 학기 수업은 공통 수업으로 지정할 수 없어요.')
    }
    const list: string[] = Array.isArray(cur.commonForHomerooms) ? cur.commonForHomerooms : []
    const rev0 = await readRevision(tx, ctx.db, ctx.schoolCode)
    if (list.includes(homeroomId) === enabled) return { ok: true, already: true, courseId, homeroomId, enabled, revision: rev0 }
    const rev = rev0 + 1
    tx.set(
      ref,
      {
        commonForHomerooms: enabled ? FieldValue.arrayUnion(homeroomId) : FieldValue.arrayRemove(homeroomId),
        revision: rev,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    )
    writeRevision(tx, ctx.db, ctx.schoolCode, rev)
    writeAudit(tx, ctx.db, ctx.schoolCode, {
      action: enabled ? 'course.common.add' : 'course.common.remove',
      actorUid: ctx.uid,
      target: `courses/${courseId}`,
      revision: rev,
      meta: { homeroomId },
    })
    return { ok: true, courseId, homeroomId, enabled, revision: rev }
  })
}

// ───────────────────────── 반복 차시 ─────────────────────────

interface SeriesConflictView {
  kind: 'teacher' | 'room' | 'students'
  seriesId: string
  courseId: string
  courseTitle: string
  weekday: number
  period: number
  detail: string
}

/**
 * 새 반복 차시가 담당 교사(인증 uid)의 다른 수업 또는 같은 교실(이름)의 다른 차시와 같은 요일·시간에 겹치는지.
 * 적용 기간이 겹치는 차시만 비교합니다. 다른 학기 수업·종료된 수업은 제외.
 */
async function seriesConflicts(ctx: Ctx, courseId: string, course: Record<string, any>, cand: LessonSeries): Promise<SeriesConflictView[]> {
  const sref = schoolRef(ctx.db, ctx.schoolCode)
  const teacherUids: string[] = (Array.isArray(course.teacherUids) ? course.teacherUids : []).filter((x: unknown) => typeof x === 'string').slice(0, 30)
  const roomName = cand.roomName || (typeof course.defaultRoomName === 'string' ? course.defaultRoomName : '') || ''

  const [teacherCourses, roomCourses, roomSeries] = await Promise.all([
    teacherUids.length ? sref.collection('courses').where('teacherUids', 'array-contains-any', teacherUids).get() : null,
    roomName ? sref.collection('courses').where('defaultRoomName', '==', roomName).get() : null,
    roomName ? sref.collection('series').where('roomName', '==', roomName).get() : null,
  ])
  const courseDocs = new Map<string, Record<string, any>>()
  teacherCourses?.docs.forEach((d) => courseDocs.set(d.id, d.data() || {}))
  roomCourses?.docs.forEach((d) => courseDocs.set(d.id, d.data() || {}))
  const seriesById = new Map<string, LessonSeries>()
  roomSeries?.docs.forEach((d) => seriesById.set(d.id, seriesFromDoc(d.id, d.data() || {})))
  const unknownCourseIds = Array.from(new Set(Array.from(seriesById.values()).map((s) => s.courseId))).filter((id) => id && !courseDocs.has(id))
  const extra = await getDocsById(ctx.db, unknownCourseIds.map((id) => sref.collection('courses').doc(id)))
  extra.forEach((s) => {
    if (s.exists) courseDocs.set(s.id, s.data() || {})
  })
  const seriesCourseIds = Array.from(courseDocs.keys()).filter((id) => id !== courseId)
  const snaps = await Promise.all(chunk(seriesCourseIds, 30).map((ids) => sref.collection('series').where('courseId', 'in', ids).get()))
  snaps.forEach((snap) => snap.docs.forEach((d) => seriesById.set(d.id, seriesFromDoc(d.id, d.data() || {}))))

  const termId = String(course.termId || '')
  const target = courseFromDoc(courseId, course)
  const pseudoDate = (w: number) => `W${w}` // 같은 요일끼리만 비교(detectResourceConflicts는 날짜 문자열이 같은 것만 비교)
  const toOcc = (key: string, s: LessonSeries, c: Course): ScheduledOccurrence => {
    const st = baseStateOf(s, cand.validFrom, c)
    return { ...st, key, courseId: c.courseId, date: pseudoDate(s.weekday), period: s.period }
  }
  const occs: ScheduledOccurrence[] = [toOcc('new', cand, target)]
  const meta = new Map<string, { s: LessonSeries; c: Course }>()
  Array.from(seriesById.values()).forEach((s) => {
    if (s.courseId === courseId || s.weekday !== cand.weekday || !seriesAlive(s)) return
    if (!periodsOverlap(s.validFrom, s.validTo, cand.validFrom, cand.validTo)) return
    const d = courseDocs.get(s.courseId)
    if (!d) return
    if (termId && d.termId && String(d.termId) !== termId) return
    const c = courseFromDoc(s.courseId, d)
    if (c.status === 'ended' && (!c.endedOn || c.endedOn <= cand.validFrom)) return
    if (c.endedOn && c.endedOn <= cand.validFrom) return
    meta.set(s.seriesId, { s, c })
    occs.push(toOcc(s.seriesId, s, c))
  })
  const periodTimes = buildPeriodTimes(String(ctx.u.user.schoolName || ''))
  return detectResourceConflicts(occs, { periodTimes })
    .filter((x) => x.a === 'new' || x.b === 'new')
    .map((x) => {
      const other = meta.get(x.a === 'new' ? x.b : x.a)
      return {
        kind: x.kind,
        seriesId: other?.s.seriesId || '',
        courseId: other?.c.courseId || '',
        courseTitle: other?.c.title || '',
        weekday: other?.s.weekday || cand.weekday,
        period: other?.s.period ?? cand.period,
        // 교사 uid는 응답에 넣지 않음
        detail: x.kind === 'teacher' ? '담당 선생님의 다른 수업과 시간이 겹쳐요.' : x.kind === 'room' ? `같은 교실(${roomName})을 쓰는 수업과 시간이 겹쳐요.` : '같은 학생이 듣는 수업과 겹쳐요.',
      }
    })
}

async function addSeries(ctx: Ctx) {
  requireTeacher(ctx)
  const b = ctx.body
  const courseId = idField(b.courseId, '수업')
  const weekday = intField(b.weekday, 1, 7, '요일') as Weekday
  const period = intField(b.period, 0, 10, '교시')
  const start = hmField(b, 'start')
  const end = hmField(b, 'end')
  const roomName = textField(b, 'roomName', 30, '교실') || null
  const acknowledge = boolField(b, 'acknowledgeConflicts') === true

  const sref = schoolRef(ctx.db, ctx.schoolCode)
  const courseRef = sref.collection('courses').doc(courseId)
  const [courseSnap, termDocs] = await Promise.all([courseRef.get(), readTermDocs(ctx.db, ctx.schoolCode)])
  if (!courseSnap.exists) fail(404, 'course-not-found', '수업을 찾을 수 없어요.')
  const course = courseSnap.data() || {}
  if (!canManageCourse(course, ctx.uid)) fail(403, 'not-course-teacher', '담당 선생님만 차시를 추가할 수 있어요.')

  const range = course.termId ? termRangeOf(termDocs, String(course.termId)) : null
  let validFrom: Ymd
  if (has(b, 'validFrom') && b.validFrom !== null && b.validFrom !== '') {
    if (!isYmd(b.validFrom)) fail(400, 'bad-date', '적용 시작일 형식이 올바르지 않아요(YYYYMMDD).')
    // 지난 날짜부터 차시를 넣으면 이미 지난 시간표가 소급해 바뀜 — 오늘부터만
    if (b.validFrom < ctx.today) fail(400, 'past-date', '지난 날짜는 바꿀 수 없어요. 오늘 이후 날짜를 골라 주세요.')
    validFrom = b.validFrom
  } else {
    // 기본: 오늘부터(지난 날짜 시간표를 바꾸지 않음). 학기가 아직 시작 전이면 학기 시작일부터
    validFrom = range && range.startDate > ctx.today ? range.startDate : ctx.today
  }
  let validTo: Ymd | null = null
  if (has(b, 'validTo') && b.validTo !== null && b.validTo !== '') {
    if (!isYmd(b.validTo) || b.validTo <= validFrom) fail(400, 'bad-range', '적용 종료일은 시작일보다 뒤여야 해요.')
    validTo = b.validTo
  }
  if (range && (validFrom < range.startDate || validFrom >= range.endDate)) {
    fail(400, 'out-of-term', `적용 시작일이 수업 학기(${range.startDate}~${range.endDate}) 밖이에요.`)
  }
  const target = courseFromDoc(courseId, course)
  if (!courseActiveOn(target, validFrom)) fail(409, 'course-ended', '이미 끝난 수업에는 차시를 추가할 수 없어요.')
  const slotErrors = validateSlot({ date: validFrom, period, start, end })
  if (slotErrors.length) fail(400, 'invalid-slot', slotErrors[0], { errors: slotErrors })

  const ref = sref.collection('series').doc()
  const cand: LessonSeries = {
    seriesId: ref.id,
    courseId,
    weekday,
    period,
    start,
    end,
    roomId: null,
    roomName,
    validFrom,
    validTo,
    status: 'active',
  }
  const conflicts = await seriesConflicts(ctx, courseId, course, cand)
  if (conflicts.length && !acknowledge) {
    fail(409, 'conflicts', '다른 수업과 시간이 겹쳐요. 확인 후 다시 저장해 주세요.', { conflicts })
  }

  return ctx.db.runTransaction(async (tx) => {
    // 같은 수업·같은 요일·교시·겹치는 기간의 차시가 이미 있으면 중복
    const existing = await tx.get(sref.collection('series').where('courseId', '==', courseId))
    for (const d of existing.docs) {
      const s = seriesFromDoc(d.id, d.data() || {})
      if (!seriesAlive(s) || s.weekday !== weekday || s.period !== period) continue
      if (periodsOverlap(s.validFrom, s.validTo, validFrom, validTo)) {
        fail(409, 'duplicate-series', '같은 요일·교시에 이미 이 수업 차시가 있어요.', { seriesId: d.id })
      }
    }
    const rev = (await readRevision(tx, ctx.db, ctx.schoolCode)) + 1
    const doc = {
      courseId,
      termId: String(course.termId || ''),
      weekday,
      period,
      start,
      end,
      roomId: null,
      roomName,
      validFrom,
      validTo,
      status: 'active',
      createdBy: ctx.uid,
    }
    tx.set(ref, { ...doc, createdAt: FieldValue.serverTimestamp() })
    writeRevision(tx, ctx.db, ctx.schoolCode, rev)
    writeAudit(tx, ctx.db, ctx.schoolCode, {
      action: 'series.add',
      actorUid: ctx.uid,
      target: `series/${ref.id}`,
      revision: rev,
      after: { courseId, weekday, period, start, end, roomName, validFrom, validTo },
      meta: conflicts.length ? { acknowledgedConflicts: conflicts.length } : undefined,
    })
    return { ok: true, seriesId: ref.id, series: cand, conflicts, revision: rev }
  })
}

async function retireSeries(ctx: Ctx) {
  requireTeacher(ctx)
  const seriesId = idField(ctx.body.seriesId, '차시')
  const effectiveFrom = ctx.body.effectiveFrom
  if (!isYmd(effectiveFrom)) fail(400, 'bad-date', '적용일 형식이 올바르지 않아요(YYYYMMDD).')
  // 지난 날짜부터 끝내면 이미 지난 수업 기록이 사라짐 — 오늘부터만
  if (effectiveFrom < ctx.today) fail(400, 'past-date', '지난 날짜는 바꿀 수 없어요. 오늘 이후 날짜를 골라 주세요.')
  const sref = schoolRef(ctx.db, ctx.schoolCode)
  const ref = sref.collection('series').doc(seriesId)
  return ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) fail(404, 'series-not-found', '차시를 찾을 수 없어요.')
    const s = seriesFromDoc(seriesId, snap.data() || {})
    const courseSnap = await tx.get(sref.collection('courses').doc(s.courseId))
    if (!canManageCourse(courseSnap.exists ? courseSnap.data() : null, ctx.uid)) {
      fail(403, 'not-course-teacher', '담당 선생님만 차시를 바꿀 수 있어요.')
    }
    const rev0 = await readRevision(tx, ctx.db, ctx.schoolCode)
    if ((s.status === 'retired' && !s.validTo) || (s.validTo && s.validTo <= effectiveFrom)) {
      return { ok: true, already: true, seriesId, validTo: s.validTo, revision: rev0 }
    }
    // 적용일이 시작일보다 앞이면 빈 기간 [validFrom, validFrom) — 어떤 날짜에도 열리지 않음(지난 기록은 그대로)
    const validTo = effectiveFrom < s.validFrom ? s.validFrom : effectiveFrom
    const rev = rev0 + 1
    tx.set(ref, { validTo, status: 'retired', retiredBy: ctx.uid, retiredAt: FieldValue.serverTimestamp() }, { merge: true })
    writeRevision(tx, ctx.db, ctx.schoolCode, rev)
    writeAudit(tx, ctx.db, ctx.schoolCode, {
      action: 'series.retire',
      actorUid: ctx.uid,
      target: `series/${seriesId}`,
      revision: rev,
      before: { validTo: s.validTo, status: s.status },
      after: { validTo, status: 'retired' },
    })
    return { ok: true, seriesId, validTo, revision: rev }
  })
}

// ───────────────────────── 학급 시간표 → 공통 수업 ─────────────────────────

interface HomeroomCell {
  weekday: Weekday
  period: number
  subject: string
  teacher: string
  room: string | null
}

/**
 * 담임이 '우리 반 학생 모두 이 시간표대로 듣는다'고 명시할 때만 호출합니다.
 * 과목은 학급 시간표(info/timetable)를 기준으로, 교사·교실은 같은 칸·같은 과목인 학교 시간표 칸에서만 가져옵니다.
 * 교실을 모르면 null(학급 이름을 교실로 추정하지 않음). 교사 이름은 표시용이며 계정(uid)과 연결하지 않습니다.
 */
async function fromHomeroomTimetable(ctx: Ctx) {
  requireTeacher(ctx)
  const classId = idField(ctx.body.classId, '학급')
  const clsSnap = await ctx.db.collection('classes').doc(classId).get()
  if (!clsSnap.exists) fail(404, 'class-not-found', '학급을 찾을 수 없어요.')
  const cls = clsSnap.data() || {}
  if (cls.isGroup === true) fail(400, 'group-not-homeroom', '수업 그룹은 소속 학급이 아니라서 공통 수업을 만들 수 없어요.')
  if (String(cls.teacherId || '') !== ctx.uid || classSchoolOf(cls, classId) !== ctx.schoolCode) {
    fail(403, 'not-homeroom-teacher', '담임 선생님만 학급 시간표로 공통 수업을 만들 수 있어요.')
  }

  const sref = schoolRef(ctx.db, ctx.schoolCode)
  const gradeClass = `${cls.grade ?? ''}-${cls.classNm ?? ''}`
  const [infoSnap, masterSnap, termDocs] = await Promise.all([
    ctx.db.collection('classes').doc(classId).collection('info').doc('timetable').get(),
    ctx.db.collection('school_timetables').doc(ctx.schoolCode).get(),
    readTermDocs(ctx.db, ctx.schoolCode),
  ])
  const info = infoSnap.exists ? infoSnap.data() || {} : null
  const grid = masterSnap.exists ? (masterSnap.get(new FieldPath('classes', gradeClass)) as Record<string, any> | undefined) : undefined

  const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '')
  const cells: HomeroomCell[] = []
  DAY_KEYS.forEach((day, d) => {
    for (let p = 0; p < PERIOD_COUNT; p++) {
      const infoSubject = info ? clean(cleanSubject(String(info[day]?.[p] ?? '')), 40) : ''
      const g = grid?.[day]?.[p]
      const gridSubject = g && typeof g.subject === 'string' ? clean(cleanSubject(g.subject), 40) : ''
      // 학급 시간표 문서가 있으면 그것이 과목 기준(담임이 비운 칸은 수업 없음). 없을 때만 학교 시간표 칸
      const subject = info ? infoSubject : gridSubject
      if (!subject) continue
      const sameCell = !!gridSubject && normalizeName(gridSubject) === normalizeName(subject)
      cells.push({
        weekday: (d + 1) as Weekday,
        period: p + 1,
        subject,
        teacher: sameCell ? clean(g.teacher, 20) : '',
        room: sameCell ? clean(g.room, 30) || null : null,
      })
    }
  })
  if (!cells.length) fail(404, 'no-class-timetable', '학급 시간표가 비어 있어요. 시간표를 먼저 올려 주세요.')

  const term = termForDateFromDocs(termDocs, ctx.today)
  const range = termRangeOf(termDocs, term.termId) || { startDate: term.startDate, endDate: term.endDate }
  let effectiveFrom: Ymd = range.startDate > ctx.today ? range.startDate : ctx.today
  if (has(ctx.body, 'effectiveFrom') && ctx.body.effectiveFrom) {
    if (!isYmd(ctx.body.effectiveFrom)) fail(400, 'bad-date', '적용일 형식이 올바르지 않아요(YYYYMMDD).')
    if (ctx.body.effectiveFrom < ctx.today) fail(400, 'past-date', '지난 날짜는 바꿀 수 없어요. 오늘 이후 날짜를 골라 주세요.')
    effectiveFrom = ctx.body.effectiveFrom
  }
  if (effectiveFrom < range.startDate || effectiveFrom >= range.endDate) fail(400, 'out-of-term', '적용일이 이번 학기 밖이에요.')

  // (과목, 교사)마다 수업 하나 — courseId는 결정적이라 다시 실행해도 같은 수업
  const subjectTeachers = new Map<string, Set<string>>()
  cells.forEach((c) => {
    const set = subjectTeachers.get(c.subject) || new Set<string>()
    set.add(c.teacher)
    subjectTeachers.set(c.subject, set)
  })
  const courseIdOf = (c: HomeroomCell) => homeroomCourseId(classId, term.termId, c.subject, c.teacher)
  const desiredCourses = new Map<string, { title: string; subject: string; teacherNames: string[] }>()
  cells.forEach((c) => {
    const id = courseIdOf(c)
    if (desiredCourses.has(id)) return
    const ambiguous = (subjectTeachers.get(c.subject)?.size || 0) > 1
    const title = ambiguous ? `${c.subject}(${c.teacher || '교사 미정'})`.slice(0, 40) : c.subject
    desiredCourses.set(id, { title, subject: c.subject, teacherNames: c.teacher ? [c.teacher] : [] })
  })
  const desiredSeries = cells.map((c) => ({ ...c, courseId: courseIdOf(c) }))

  const courseIds = Array.from(desiredCourses.keys())
  return ctx.db.runTransaction(async (tx) => {
    const seriesCol = sref.collection('series')
    const existingSnap = await tx.get(seriesCol.where('sourceHomeroomId', '==', classId))
    // 기본 시간표 변경(/api/schedule-changes 'base')으로 생긴 차시는 예전 자료에 sourceHomeroomId가 없을 수 있어
    // 이 학급 공통 수업들의 courseId로도 읽음(학급 차시인지는 기본 변경 연결로 판정 — planHomeroomSeries)
    const hrCourseIds = Array.from(new Set(courseIds.concat(existingSnap.docs.map((d) => String(d.get('courseId') || ''))).filter(Boolean)))
    const byCourseSnaps = []
    for (const ids of chunk(hrCourseIds, 30)) byCourseSnaps.push(await tx.get(seriesCol.where('courseId', 'in', ids)))
    const courseRefs: DocumentReference[] = courseIds.map((id) => sref.collection('courses').doc(id))
    const courseSnaps = courseRefs.length ? await tx.getAll(...courseRefs) : []
    const rev0 = await readRevision(tx, ctx.db, ctx.schoolCode)

    // 이번 학기 후보 차시 → 유지·새로 만들기·끝내기(기본 변경으로 옮긴 칸은 다시 만들지 않음)
    const docs = new Map<string, Record<string, any>>()
    ;[existingSnap, ...byCourseSnaps].forEach((snap) => snap.docs.forEach((d) => docs.set(d.id, d.data() || {})))
    const existing = Array.from(docs.entries())
      .filter(([, d]) => String(d.termId || '') === term.termId)
      .map(([id, d]) => ({
        s: seriesFromDoc(id, d),
        replacesSeriesId: typeof d.replacesSeriesId === 'string' ? d.replacesSeriesId : null,
        supersededBy: typeof d.supersededBy === 'string' ? d.supersededBy : null,
      }))
    const plan = planHomeroomSeries({ classId, effectiveFrom, termEnd: range.endDate, existing, desired: desiredSeries })
    const keep = plan.keep
    const toCreate = plan.toCreate.map((c) => ({
      ...c,
      seriesId: homeroomSeriesId(classId, term.termId, c.weekday, c.period, c.validFrom, c.courseId, c.room),
    }))
    const toRetire = plan.toRetire

    const courseWrites: Array<{ ref: DocumentReference; data: Record<string, any>; created: boolean }> = []
    courseSnaps.forEach((snap, i) => {
      const want = desiredCourses.get(courseIds[i])!
      if (!snap.exists) {
        courseWrites.push({
          ref: courseRefs[i],
          created: true,
          data: {
            schoolCode: ctx.schoolCode,
            termId: term.termId,
            title: want.title,
            subject: want.subject,
            section: null,
            // 실제 담당 교사 계정은 모름 — 이름만 표시용. 관리 권한은 만든 담임(managerUids)
            teacherUids: [],
            teacherNames: want.teacherNames,
            managerUids: [ctx.uid],
            status: 'active',
            endedOn: null,
            commonForHomerooms: [classId],
            defaultRoomId: null,
            defaultRoomName: null,
            invitePolicy: 'approval',
            catalogVisible: false,
            legacyGroupId: null,
            source: 'homeroom-common',
            sourceHomeroomId: classId,
            createdBy: ctx.uid,
            createdAt: FieldValue.serverTimestamp(),
          },
        })
        return
      }
      const cur = snap.data() || {}
      const managers: string[] = Array.isArray(cur.managerUids) ? cur.managerUids : []
      const common: string[] = Array.isArray(cur.commonForHomerooms) ? cur.commonForHomerooms : []
      if (cur.title === want.title && cur.subject === want.subject && managers.includes(ctx.uid) && common.includes(classId)) return
      courseWrites.push({
        ref: courseRefs[i],
        created: false,
        data: {
          title: want.title,
          subject: want.subject,
          managerUids: FieldValue.arrayUnion(ctx.uid),
          commonForHomerooms: FieldValue.arrayUnion(classId),
          sourceHomeroomId: classId,
        },
      })
    })

    const summary = {
      classId,
      termId: term.termId,
      effectiveFrom,
      courses: courseIds.length,
      coursesCreated: courseWrites.filter((w) => w.created).length,
      seriesCreated: toCreate.length,
      seriesRetired: toRetire.length,
      seriesUnchanged: keep.size,
      // 기본 시간표 변경으로 옮긴 채 유지한 칸(학급 시간표가 바뀌지 않은 칸 — 다시 만들지 않음)
      cellsKeptByChange: plan.keptByChange,
      cellsWithoutTeacher: cells.filter((c) => !c.teacher).length,
      cellsWithoutRoom: cells.filter((c) => !c.room).length,
    }
    if (!courseWrites.length && !toCreate.length && !toRetire.length) {
      return { ok: true, already: true, ...summary, courseIds, revision: rev0 }
    }

    const rev = rev0 + 1
    courseWrites.forEach((w) => tx.set(w.ref, { ...w.data, revision: rev, updatedAt: FieldValue.serverTimestamp() }, { merge: true }))
    toRetire.forEach((s) => {
      tx.set(
        sref.collection('series').doc(s.seriesId),
        { validTo: effectiveFrom < s.validFrom ? s.validFrom : effectiveFrom, status: 'retired', retiredBy: ctx.uid, retiredAt: FieldValue.serverTimestamp() },
        { merge: true }
      )
    })
    toCreate.forEach((s) => {
      tx.set(sref.collection('series').doc(s.seriesId), {
        courseId: s.courseId,
        termId: term.termId,
        weekday: s.weekday,
        period: s.period,
        start: null,
        end: null,
        roomId: null,
        roomName: s.room,
        validFrom: s.validFrom,
        validTo: null,
        status: 'active',
        sourceHomeroomId: classId,
        createdBy: ctx.uid,
        createdAt: FieldValue.serverTimestamp(),
      })
    })
    writeRevision(tx, ctx.db, ctx.schoolCode, rev)
    writeAudit(tx, ctx.db, ctx.schoolCode, {
      action: 'course.fromHomeroomTimetable',
      actorUid: ctx.uid,
      target: `classes/${classId}`,
      revision: rev,
      meta: summary,
    })
    return { ok: true, ...summary, courseIds, revision: rev }
  })
}

// ───────────────────────── 조회 ─────────────────────────

async function listCourses(ctx: Ctx) {
  requireTeacher(ctx)
  const sref = schoolRef(ctx.db, ctx.schoolCode)
  const termDocs = await readTermDocs(ctx.db, ctx.schoolCode)
  const termFilter =
    ctx.body.termId === 'all' ? null : ctx.body.termId ? termIdField(termDocs, ctx.body.termId) : termForDateFromDocs(termDocs, ctx.today).termId

  const [teaching, managing, classesSnap, revision] = await Promise.all([
    sref.collection('courses').where('teacherUids', 'array-contains', ctx.uid).get(),
    sref.collection('courses').where('managerUids', 'array-contains', ctx.uid).get(),
    ctx.db.collection('classes').where('teacherId', '==', ctx.uid).get(),
    currentRevision(ctx.db, ctx.schoolCode),
  ])
  const homerooms = classesSnap.docs
    .filter((d) => (d.data() || {}).isGroup !== true && classSchoolOf(d.data() || {}, d.id) === ctx.schoolCode)
    .map((d) => ({ classId: d.id, label: homeroomLabel(d.data(), d.id) }))
  const commonSnaps = await Promise.all(
    chunk(homerooms.map((h) => h.classId), 30).map((ids) => sref.collection('courses').where('commonForHomerooms', 'array-contains-any', ids).get())
  )

  const docs = new Map<string, { d: Record<string, any>; role: 'teacher' | 'manager' | 'homeroom' }>()
  commonSnaps.forEach((s) => s.docs.forEach((d) => docs.set(d.id, { d: d.data() || {}, role: 'homeroom' })))
  managing.docs.forEach((d) => docs.set(d.id, { d: d.data() || {}, role: 'manager' }))
  teaching.docs.forEach((d) => docs.set(d.id, { d: d.data() || {}, role: 'teacher' }))
  const entries = Array.from(docs.entries()).filter(([, v]) => !termFilter || String(v.d.termId || '') === termFilter)

  const ids = entries.map(([id]) => id)
  const [seriesSnaps, enrollSnaps] = await Promise.all([
    Promise.all(chunk(ids, 30).map((part) => sref.collection('series').where('courseId', 'in', part).get())),
    // 목록에는 인원 수만(학생 이름·uid 없음) — 화면이 수업마다 get을 불러 명단을 받지 않게
    Promise.all(chunk(ids, 30).map((part) => sref.collection('enrollments').where('courseId', 'in', part).select('courseId', 'status', 'to').get())),
  ])
  const counts = new Map<string, { active: number; pending: number }>()
  enrollSnaps.forEach((s) =>
    s.docs.forEach((d) => {
      const courseId = String(d.get('courseId') || '')
      const c = counts.get(courseId) || { active: 0, pending: 0 }
      const st = d.get('status')
      const to = d.get('to')
      if (st === 'active' && !(isYmd(to) && to <= ctx.today)) c.active += 1
      else if (st === 'pending') c.pending += 1
      counts.set(courseId, c)
    })
  )
  const seriesByCourse = new Map<string, LessonSeries[]>()
  seriesSnaps.forEach((s) =>
    s.docs.forEach((d) => {
      const x = seriesFromDoc(d.id, d.data() || {})
      if (!seriesAlive(x)) return
      const arr = seriesByCourse.get(x.courseId) || []
      arr.push(x)
      seriesByCourse.set(x.courseId, arr)
    })
  )
  const courses = entries
    .map(([id, v]) => ({
      ...courseView(id, v.d),
      role: v.role,
      canManage: canManageCourse(v.d, ctx.uid),
      counts: counts.get(id) || { active: 0, pending: 0 },
      series: (seriesByCourse.get(id) || []).sort((a, b) => a.weekday - b.weekday || a.period - b.period || a.validFrom.localeCompare(b.validFrom)),
    }))
    .sort((a, b) => a.title.localeCompare(b.title, 'ko') || a.courseId.localeCompare(b.courseId))
  return { termId: termFilter, homerooms, courses, revision }
}

async function getCourse(ctx: Ctx) {
  requireTeacher(ctx)
  const courseId = idField(ctx.body.courseId, '수업')
  const sref = schoolRef(ctx.db, ctx.schoolCode)
  const snap = await sref.collection('courses').doc(courseId).get()
  if (!snap.exists) fail(404, 'course-not-found', '수업을 찾을 수 없어요.')
  const d = snap.data() || {}
  // 수강 명단은 담당 교사에게만
  if (!canManageCourse(d, ctx.uid)) fail(403, 'not-course-teacher', '담당 선생님만 볼 수 있어요.')
  const [seriesSnap, enrollSnap, revision] = await Promise.all([
    sref.collection('series').where('courseId', '==', courseId).get(),
    sref.collection('enrollments').where('courseId', '==', courseId).get(),
    currentRevision(ctx.db, ctx.schoolCode),
  ])
  const series = seriesSnap.docs
    .map((x) => seriesFromDoc(x.id, x.data() || {}))
    .filter((s) => !(s.status === 'retired' && !s.validTo))
    .sort((a, b) => a.weekday - b.weekday || a.period - b.period || a.validFrom.localeCompare(b.validFrom))
  const counts = { active: 0, pending: 0, ended: 0 }
  const pendingUids: string[] = []
  enrollSnap.docs.forEach((x) => {
    const e = enrollmentFromDoc(x.data() || {})
    counts[e.status]++
    if (e.status === 'pending') pendingUids.push(e.uid)
  })
  const users = await getDocsById(ctx.db, pendingUids.slice(0, 300).map((uid) => ctx.db.collection('users').doc(uid)))
  const pending = users.map((s) => {
    const v = s.exists ? s.data() || {} : {}
    return {
      uid: s.id,
      name: String(v.name || v.displayName || '이름 없음'),
      studentId: toStudentNo(v.studentId),
      homeroomLabel: studentHomeroomLabel(v),
    }
  })
  const commonIds: string[] = Array.isArray(d.commonForHomerooms) ? d.commonForHomerooms : []
  const classSnaps = await getDocsById(ctx.db, commonIds.map((id) => ctx.db.collection('classes').doc(id)))
  const commonHomerooms = classSnaps.map((s) => ({ classId: s.id, label: homeroomLabel(s.exists ? s.data() : null, s.id) }))
  return { course: courseView(courseId, d), series, counts, pending, commonHomerooms, revision }
}

async function catalog(ctx: Ctx) {
  const sref = schoolRef(ctx.db, ctx.schoolCode)
  const termDocs = await readTermDocs(ctx.db, ctx.schoolCode)
  const term = termForDateFromDocs(termDocs, ctx.today)
  const [snap, mine] = await Promise.all([
    sref.collection('courses').where('termId', '==', term.termId).where('catalogVisible', '==', true).get(),
    sref.collection('enrollments').where('uid', '==', ctx.uid).get(),
  ])
  const myStatus = new Map<string, string>()
  mine.docs.forEach((d) => {
    const e = enrollmentFromDoc(d.data() || {})
    if (e.uid === ctx.uid) myStatus.set(e.courseId, e.status)
  })
  const open = snap.docs.filter((d) => courseActiveOn(courseFromDoc(d.id, d.data() || {}), ctx.today))
  const seriesSnaps = await Promise.all(
    chunk(open.map((d) => d.id), 30).map((ids) => sref.collection('series').where('courseId', 'in', ids).get())
  )
  const slots = new Map<string, Array<{ weekday: number; period: number; roomName: string | null }>>()
  seriesSnaps.forEach((s) =>
    s.docs.forEach((d) => {
      const x = seriesFromDoc(d.id, d.data() || {})
      if (!seriesAlive(x) || (x.validTo && x.validTo <= ctx.today)) return
      const arr = slots.get(x.courseId) || []
      if (!arr.some((a) => a.weekday === x.weekday && a.period === x.period)) arr.push({ weekday: x.weekday, period: x.period, roomName: x.roomName || null })
      slots.set(x.courseId, arr)
    })
  )
  // 학생에게는 수업을 고르는 데 필요한 최소 정보만(수강 인원·명단·교사 계정은 없음)
  const courses = open
    .map((d) => {
      const v = d.data() || {}
      return {
        courseId: d.id,
        title: String(v.title || v.subject || '수업'),
        subject: String(v.subject || ''),
        section: v.section ? String(v.section) : null,
        teacherNames: Array.isArray(v.teacherNames) ? v.teacherNames.filter((x: unknown) => typeof x === 'string') : [],
        defaultRoomName: v.defaultRoomName ? String(v.defaultRoomName) : null,
        invitePolicy: v.invitePolicy === 'approval' ? 'approval' : 'auto',
        slots: (slots.get(d.id) || []).sort((a, b) => a.weekday - b.weekday || a.period - b.period),
        myStatus: myStatus.get(d.id) || null,
      }
    })
    .sort((a, b) => a.title.localeCompare(b.title, 'ko') || a.courseId.localeCompare(b.courseId))
  return { term: { termId: term.termId, name: term.name, startDate: term.startDate, endDate: term.endDate, isDefault: term.isDefault }, courses }
}

// ───────────────────────── 핸들러 ─────────────────────────

const ACTIONS: Record<string, (ctx: Ctx) => Promise<Record<string, unknown>>> = {
  create: createCourse,
  update: updateCourse,
  end: endCourse,
  setCommon,
  addSeries,
  retireSeries,
  fromHomeroomTimetable,
  list: listCourses,
  get: getCourse,
  catalog,
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
    console.error('courses: auth failed', (e as Error)?.message)
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
    console.error('courses: failed', action, String((e as Error)?.message || '').slice(0, 200))
    return apiError(res, 500, 'server-error', '처리하지 못했어요. 잠시 후 다시 시도해 주세요.')
  }
}
