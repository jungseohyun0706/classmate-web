/**
 * 교사 '내 시간표'(대시보드 메인 화면) 자료 — API 라우트 전용(firebase-admin). 클라이언트 번들에서 import하지 마세요.
 *
 * loadTeacherTimetableData → GET /api/timetable/teacher 응답(TeacherTimetablePayload, teacherDay.ts)
 * - 공식 수업 후보는 uid로만 찾음: 수업 teacherUids array-contains 내 uid, 차시 teacherUids array-contains 내 uid,
 *   조회 기간 날짜의 변경(dates array-contains-any) 중 변경 후 담당 교사 uid에 내가 있는 차시의 수업.
 *   teacherNames(엑셀에서 온 이름)로는 찾지 않습니다.
 * - 후보 수업의 반복 차시·변경을 읽어 날짜마다 computeTeacherOfficialDay(학생 화면과 같은 엔진)로 계산
 * - 학생 명단·수강(enrollments)·다른 교사 uid는 읽지도 내려주지도 않음(다른 교사는 이름만)
 * - 예전 자료: users.mySchedule(주간 시간표), 교환(school_swaps/{s}/requests·direct_requests)·보결(school_sos/{s}/requests) 중
 *   조회 기간에 수락·배정되고 내가 요청했거나 맡은 것
 * - 쿼리는 등호·array-contains·array-contains-any·in만(정렬·범위 없음) — 복합 인덱스가 필요 없음. 날짜 거르기는 메모리에서
 * - 학기·쉬는 날·교시 시각은 학생 /api/timetable/me와 같은 규칙
 */
import type { CollectionReference, DocumentData, Firestore, QueryDocumentSnapshot, QuerySnapshot } from 'firebase-admin/firestore'
import { periodTimesToStarts } from '../timetableConvert'
import { isYmd } from './dates'
import { clipSeriesToTerm, scopeCoursesToTerms, selectOverridesForWindow } from './engine'
import { chunk, cleanText, courseFromDoc, currentRevision, GROUP_RE, overrideFromDoc, schoolRef, seriesFromDoc } from './server'
import { boundCalendarLookup, buildPeriodTimes, datesBetween, loadOffDays, readTermDocs, termRangeOf, termsForWindow, TimetableApiError } from './studentData'
import { computeTeacherOfficialDay, normalizeMySchedule, type TeacherCover, type TeacherOfficialDay, type TeacherTimetablePayload } from './teacherDay'
import type { Course, LessonSeries, Override, Ymd } from './types'

/** 후보 수업 상한 — 넘으면 앞에서부터만 계산하고 로그(정상 교사는 수십 개 이하) */
const MAX_COURSES = 150
/** 한 쿼리에서 읽을 교환·보결 문서 상한(조회 기간 21일 안 학교 전체) */
const MAX_COVER_DOCS = 500

const docData = (d: QueryDocumentSnapshot<DocumentData>) => d.data() || {}
const LEVEL_RE = /(고등학교|중학교|초등학교)$/

function text(v: unknown, max: number): string {
  return cleanText(v, max)
}

/** 요청 교사의 담임 학급 표시 — '담임 없음'은 빈 값 */
function requesterClassOf(v: unknown): string {
  const t = text(v, 30)
  return t === '담임 없음' ? '' : t
}

function periodOf(v: unknown): number | null {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : null
}

/** 교환 문서 → 내 교환(수락된 것만). 예전 1:1 문서는 fromId/fromName·toId만 있을 수 있음 */
export function swapCoverOf(uid: string, id: string, d: Record<string, unknown>, kind: 'direct' | 'public', from: Ymd, to: Ymd): TeacherCover | null {
  if (d.status !== 'accepted') return null
  const date = d.date
  if (!isYmd(date) || date < from || date > to) return null
  const period = periodOf(d.period)
  if (period === null) return null
  const requester = d.requesterId ?? d.fromId ?? null
  const accepter = d.accepterId ?? (kind === 'direct' ? d.toId ?? null : null)
  let direction: TeacherCover['direction']
  if (requester === uid) direction = 'covered'
  else if (accepter === uid) direction = 'covering'
  else return null
  const otherName =
    direction === 'covered' ? text(d.accepterName ?? (kind === 'direct' ? d.toName : ''), 30) : text(d.requesterName ?? d.fromName, 30)
  return {
    id: `swap:${kind === 'direct' ? 'd' : 'p'}_${id}`,
    kind: 'swap',
    direction,
    date,
    period,
    subject: text(d.subject, 40),
    requesterClass: requesterClassOf(d.requesterClass),
    otherName,
  }
}

/** 보결 SOS 문서 → 내 보결(배정된 것만). 사유(reason)는 넣지 않음 */
export function sosCoverOf(uid: string, id: string, d: Record<string, unknown>, from: Ymd, to: Ymd): TeacherCover | null {
  if (d.status !== 'assigned') return null
  const date = d.date
  if (!isYmd(date) || date < from || date > to) return null
  const period = periodOf(d.period)
  if (period === null) return null
  let direction: TeacherCover['direction']
  if (d.requesterId === uid) direction = 'covered'
  else if (d.assignedTo === uid) direction = 'covering'
  else return null
  return {
    id: `sos:${id}`,
    kind: 'sos',
    direction,
    date,
    period,
    subject: '',
    requesterClass: requesterClassOf(d.requesterClass),
    otherName: direction === 'covered' ? text(d.assignedName, 30) : text(d.requesterName, 30),
  }
}

async function queryIn(col: CollectionReference, field: string, op: 'in' | 'array-contains-any', values: string[], limit?: number) {
  const parts = chunk(Array.from(new Set(values.filter(Boolean))), 30)
  const snaps: QuerySnapshot[] = await Promise.all(
    parts.map((p) => {
      const q = col.where(field, op, p)
      return (limit ? q.limit(limit) : q).get()
    })
  )
  return snaps.reduce<QueryDocumentSnapshot[]>((acc, s) => acc.concat(s.docs), [])
}

/**
 * 교사 '내 시간표' 자료. user는 서버가 읽은 users/{uid} 문서(클라이언트 값 아님), from·to는 둘 다 포함(검증은 호출하는 쪽).
 * schoolCode가 없으면 TimetableApiError(409 'no-school').
 */
export async function loadTeacherTimetableData(
  db: Firestore,
  uid: string,
  user: Record<string, unknown>,
  from: Ymd,
  to: Ymd
): Promise<TeacherTimetablePayload> {
  const schoolCode = typeof user.schoolCode === 'string' && user.schoolCode ? user.schoolCode : ''
  if (!schoolCode) throw new TimetableApiError(409, 'no-school', '학교 정보가 없어요. 내 정보에서 학교를 먼저 확인해 주세요.')
  const sref = schoolRef(db, schoolCode)
  const dates = datesBetween(from, to)

  // 버전을 가장 먼저 읽음(조회 도중 변경이 발행되면 화면은 낮은 버전을 받고, 구독한 버전이 바뀌어 다시 받음)
  const revision = await currentRevision(db, schoolCode)

  // 학사일정은 함께 시작하고 느리면 상한 뒤 calendarErrors로(학생 /me와 같은 규칙 — 학년은 담임 학년)
  const offDaysPromise = boundCalendarLookup(
    loadOffDays(schoolCode, typeof user.officeCode === 'string' ? user.officeCode : '', dates, user.grade),
    dates
  )

  // 교시 시각: 담임 학급 교시표(엑셀 업로드 때 복사) → 학교 엑셀 교시표 → 학교급 기본
  const homeroomId = typeof user.classId === 'string' && user.classId && !GROUP_RE.test(user.classId) ? user.classId : ''
  const swapRoot = db.collection('school_swaps').doc(schoolCode)

  const [termDocs, schoolSnap, ownCourses, ownSeries, windowOverrides, classPtSnap, masterSnaps, swapPublic, swapDirect, sosDocs] = await Promise.all([
    readTermDocs(db, schoolCode),
    sref.get(),
    sref.collection('courses').where('teacherUids', 'array-contains', uid).get(),
    sref.collection('series').where('teacherUids', 'array-contains', uid).get(),
    queryIn(sref.collection('overrides'), 'dates', 'array-contains-any', dates),
    homeroomId ? db.collection('classes').doc(homeroomId).collection('info').doc('periodTimes').get() : null,
    db.getAll(db.collection('school_timetables').doc(schoolCode), { fieldMask: ['periodTimes'] }),
    queryIn(swapRoot.collection('requests'), 'date', 'in', dates, MAX_COVER_DOCS),
    queryIn(swapRoot.collection('direct_requests'), 'date', 'in', dates, MAX_COVER_DOCS),
    queryIn(db.collection('school_sos').doc(schoolCode).collection('requests'), 'date', 'in', dates, MAX_COVER_DOCS),
  ])

  // ── 후보 수업 ──
  const courseDocs = new Map<string, Record<string, unknown>>()
  ownCourses.docs.forEach((d) => courseDocs.set(d.id, docData(d)))
  const extraIds = new Set<string>()
  ownSeries.docs.forEach((d) => {
    const cid = d.get('courseId')
    if (typeof cid === 'string' && cid) extraIds.add(cid)
  })
  for (const d of windowOverrides) {
    const o = overrideFromDoc(d.id, docData(d))
    // 변경 후 담당 교사 uid에 내가 있는 차시(대신 들어가는 수업 후보) — 이름으로는 찾지 않음
    if (o.status === 'published' && o.courseId && (o.target?.teacherUids ?? []).includes(uid)) extraIds.add(o.courseId)
  }
  const missing = Array.from(extraIds).filter((id) => !courseDocs.has(id))
  for (const part of chunk(missing, 100)) {
    const snaps = await db.getAll(...part.map((id) => sref.collection('courses').doc(id)))
    snaps.forEach((s) => {
      if (s.exists) courseDocs.set(s.id, s.data() || {})
    })
  }
  let allCourses: Course[] = Array.from(courseDocs.entries())
    .map(([id, d]) => courseFromDoc(id, d))
    .sort((a, b) => a.title.localeCompare(b.title, 'ko') || a.courseId.localeCompare(b.courseId))
  if (allCourses.length > MAX_COURSES) {
    console.error('timetable/teacher: too many candidate courses', allCourses.length)
    allCourses = allCourses.slice(0, MAX_COURSES)
  }
  const termRangeByCourse = new Map<string, { startDate: Ymd; endDate: Ymd } | null>()
  allCourses.forEach((c) => termRangeByCourse.set(c.courseId, c.termId ? termRangeOf(termDocs, c.termId) : null))
  // 학생 자료와 같은 학기 범위(지난 학기 수업이 이어지지 않게)
  const courses = scopeCoursesToTerms(allCourses, termRangeByCourse, new Set(), from)
  const courseIds = courses.map((c) => c.courseId)

  // ── 반복 차시·변경(후보 수업 전부 — 기본 상태·차시별 이력 계산용) ──
  const [seriesDocs, overrideDocs] = await Promise.all([
    queryIn(sref.collection('series'), 'courseId', 'in', courseIds),
    queryIn(sref.collection('overrides'), 'courseId', 'in', courseIds),
  ])
  const series: LessonSeries[] = []
  for (const d of seriesDocs) {
    const s = seriesFromDoc(d.id, docData(d))
    if (s.status === 'retired' && !s.validTo) continue // 삭제된 차시
    series.push(clipSeriesToTerm(s, termRangeByCourse.get(s.courseId) ?? null))
  }
  const published: Array<{ o: Override; raw: Record<string, unknown> }> = []
  for (const d of overrideDocs) {
    const raw = docData(d)
    const o = overrideFromDoc(d.id, raw)
    if (o.status === 'published') published.push({ o, raw })
  }
  const overrides = selectOverridesForWindow(published, from, to)

  // ── 학기·교시 시각·쉬는 날 ──
  const terms = termsForWindow(termDocs, dates)
  const classStarts = classPtSnap?.exists ? classPtSnap.get('times') : undefined
  const master = masterSnaps[0]
  const masterStarts = master?.exists ? periodTimesToStarts(master.get('periodTimes')) : []
  const starts =
    Array.isArray(classStarts) && classStarts.some((t) => typeof t === 'string' && t) ? classStarts : masterStarts.length ? masterStarts : undefined
  const names = [schoolSnap.exists ? schoolSnap.get('kind') : null, schoolSnap.exists ? schoolSnap.get('name') : null, user.schoolName]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
  const levelName = names.find((n) => LEVEL_RE.test(n)) || names.find(Boolean) || ''
  const periodTimes = buildPeriodTimes(levelName, starts)
  const { offDays, calendarErrors } = await offDaysPromise

  // ── 날짜별 공식 수업(엔진) ──
  const days: Record<Ymd, TeacherOfficialDay> = {}
  for (const date of dates) {
    const t = terms.find((x) => date >= x.startDate && date < x.endDate)
    days[date] = computeTeacherOfficialDay({
      uid,
      date,
      term: t ? { startDate: t.startDate, endDate: t.endDate } : null,
      offDay: offDays[date] ?? null,
      periodTimes,
      courses,
      series,
      overrides,
    })
  }

  // ── 교환·보결 ──
  const coverMap = new Map<string, TeacherCover>()
  const add = (c: TeacherCover | null) => {
    if (c && !coverMap.has(c.id)) coverMap.set(c.id, c)
  }
  swapPublic.forEach((d) => add(swapCoverOf(uid, d.id, docData(d), 'public', from, to)))
  swapDirect.forEach((d) => add(swapCoverOf(uid, d.id, docData(d), 'direct', from, to)))
  sosDocs.forEach((d) => add(sosCoverOf(uid, d.id, docData(d), from, to)))
  const covers = Array.from(coverMap.values()).sort((a, b) => a.date.localeCompare(b.date) || a.period - b.period || a.id.localeCompare(b.id))

  return {
    revision,
    generatedAt: Date.now(),
    schoolCode,
    from,
    to,
    terms: terms.map((t) => ({ termId: t.termId, name: t.name, startDate: t.startDate, endDate: t.endDate, isDefault: t.isDefault })),
    offDays,
    calendarErrors,
    periodTimes,
    days,
    mySchedule: normalizeMySchedule(user.mySchedule),
    covers,
  }
}
