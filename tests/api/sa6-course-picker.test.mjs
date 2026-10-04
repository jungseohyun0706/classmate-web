// 학생 '수업 담기(골라 담기)' API 통합 테스트 — 요구 R20
// 대상: /api/courses(catalog 대상 학년·create/update grades), /api/enrollments(requestMany·leave·request 같은 학기),
//       /api/timetable/me(빼도 지난 날짜 기록 유지), /api/timetable-import(학생 수업 담기 공개 선택·대상 학년)
// 실행 전제: 실제 서버(BASE) + Firebase 에뮬레이터(Firestore 8080, Auth 9099) + NEIS mock
// 사용: BASE=http://127.0.0.1:3200 node tests/api/sa6-course-picker.test.mjs
// 모든 데이터는 에뮬레이터의 테스트용 가상 데이터이며 실제 학생 정보가 아닙니다.
import crypto from 'crypto'
import { admin, wipe, createUsers, writeNeisFixture, clientSession, api, reporter, Timestamp } from '../e2e/lib/env.mjs'

const { check, note, finish } = reporter('api-sa6-course-picker')

// ───────── 날짜(학교 시간대 KST — 서버와 같은 기준) ─────────
const ymdOf = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
const toDate = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)))
const addDays = (ymd, n) => ymdOf(new Date(toDate(ymd).getTime() + n * 86400000))
const weekdayOf = (ymd) => toDate(ymd).getUTCDay() || 7
const TODAY = ymdOf(new Date(Date.now() + 9 * 3600 * 1000))
/** 서버 defaultTermFor와 같은 규칙(학기 문서 없음) */
function termOf(ymd) {
  const y = Number(ymd.slice(0, 4))
  const md = ymd.slice(4)
  if (md >= '0301' && md < '0816') return `${y}-1`
  return `${md < '0301' ? y - 1 : y}-2`
}
const TERM = termOf(TODAY)
const OTHER_TERM = TERM.endsWith('-1') ? `${Number(TERM.slice(0, 4)) - 1}-2` : `${TERM.slice(0, 4)}-1`
const NEXT_MON = addDays(TODAY, 8 - weekdayOf(TODAY))
// 지난 날짜 기록 확인용: 지난주 같은 요일(오늘보다 7일 전)
const PAST = addDays(TODAY, -7)

const S1 = { schoolCode: 'S1', schoolName: '테스트고등학교', officeCode: 'B10' }
const S2 = { schoolCode: 'S2', schoolName: '다른고등학교', officeCode: 'B10' }

const { db } = admin()
const sref = db.doc('schools/S1')
const revNow = async () => Number((await sref.get()).get('scheduleRevision') || 0)
const auditCount = async (action) => (await db.collection('schools/S1/audit').where('action', '==', action).get()).size

async function seed() {
  await wipe()
  writeNeisFixture({
    schools: [
      { SD_SCHUL_CODE: 'S1', SCHUL_NM: '테스트고등학교', SCHUL_KND_SC_NM: '고등학교', ATPT_OFCDC_SC_CODE: 'B10' },
      { SD_SCHUL_CODE: 'S2', SCHUL_NM: '다른고등학교', SCHUL_KND_SC_NM: '고등학교', ATPT_OFCDC_SC_CODE: 'B10' },
    ],
    meals: [],
    timetables: {},
    schedule: [],
  })
  const T = (name, extra = {}) => ({ role: 'teacher', name, displayName: name, masterName: name, ...S1, ...extra })
  const St = (name, classId, grade, classNm, studentId, school = S1) => ({ role: 'student', status: 'approved', name, displayName: name, classId, grade, classNm, studentId, ...school })
  await createUsers([
    { uid: 'tx', email: 'tx@sa6.kr', doc: T('최과학') },
    { uid: 'tz', email: 'tz@sa6.kr', doc: T('강물리') },
    { uid: 'kim', email: 'kim@sa6.kr', doc: T('김민수') }, // 시간표 가져오기 발행 교사
    { uid: 'hr4', email: 'hr4@sa6.kr', doc: T('박담임', { classId: 'S1_3_4', grade: 3, classNm: 4 }) },
    { uid: 'tS2', email: 'ts2@sa6.kr', doc: { role: 'teacher', name: '다른교사', displayName: '다른교사', ...S2 } },
    { uid: 'stu3', email: 'stu3@sa6.kr', doc: St('김학생', 'S1_3_4', 3, 4, 7) },
    { uid: 'stuB', email: 'stub@sa6.kr', doc: St('이학생', 'S1_3_4', 3, 4, 8) },
    { uid: 'stu1', email: 'stu1@sa6.kr', doc: St('박학생', 'S1_1_2', 1, 2, 3) },
  ])
  const now = Timestamp.now()
  await db.doc('classes/S1_3_4').set({ classId: 'S1_3_4', grade: 3, classNm: 4, teacherId: 'hr4', teacherName: '박담임', createdAt: now, ...S1 })
}

const sessions = {}
async function tok(email) {
  if (!sessions[email]) sessions[email] = await clientSession(email)
  return sessions[email].token
}
const courses = async (email, body) => api('/api/courses', await tok(email), body)
const enroll = async (email, body) => api('/api/enrollments', await tok(email), body)
const me = async (email, q) => api('/api/timetable/me' + q, await tok(email), null, 'GET')

/** 엔진 1~2단계와 같은 규칙: 그 날짜에 들은 수업(활성 수강 [from,to) + 끝낸 수강도 [from,to) 동안) */
function lessonsOn(p, ymd) {
  const wd = weekdayOf(ymd)
  const inR = (d, f, t) => (!f || d >= f) && (!t || d < t)
  const active = new Set(
    p.enrollments
      .filter((e) => (e.status === 'active' || (e.status === 'ended' && e.to && !e.rejected)) && inR(ymd, e.from, e.to))
      .map((e) => e.courseId)
  )
  return p.series
    .filter((s) => active.has(s.courseId) && s.weekday === wd && inR(ymd, s.validFrom, s.validTo))
    .map((s) => s.courseId)
}

async function makeCourse(email, body, series) {
  const c = await courses(email, { action: 'create', ...body })
  if (c.status !== 200) throw new Error(`create ${body.title} ${c.status} ${JSON.stringify(c.j)}`)
  for (const [weekday, period, roomName] of series) {
    const s = await courses(email, { action: 'addSeries', courseId: c.j.courseId, weekday, period, ...(roomName ? { roomName } : {}), acknowledgeConflicts: true })
    if (s.status !== 200) throw new Error(`addSeries ${body.title} ${s.status} ${JSON.stringify(s.j)}`)
  }
  return c.j.courseId
}

async function main() {
  await seed()
  note('setup', `TODAY=${TODAY} 학기 ${TERM}(다른 학기 ${OTHER_TERM}), 지난 날짜 확인 ${PAST}`)

  // ───── 수업 준비(교사 API) ─────
  const sci = await makeCourse('tx@sa6.kr', { title: '생활과 과학 A', subject: '생활과 과학', section: 'A', catalogVisible: true, invitePolicy: 'auto', grades: [3] }, [[2, 4, '과학실'], [4, 2, '과학실']])
  const phys = await makeCourse('tz@sa6.kr', { title: '물리 D', subject: '물리학', section: 'D', catalogVisible: true, invitePolicy: 'approval', grades: [3, 3] }, [[2, 5, '물리실']])
  const art = await makeCourse('tx@sa6.kr', { title: '미술 창작', subject: '미술', catalogVisible: true, invitePolicy: 'auto' }, [[2, 4, '미술실']])
  const math1 = await makeCourse('tz@sa6.kr', { title: '1학년 수학 보충', subject: '수학', catalogVisible: true, grades: [1] }, [[1, 1]])
  const hidden = await makeCourse('tx@sa6.kr', { title: '비공개 동아리', subject: '동아리', catalogVisible: false }, [[3, 7]])
  const ended = await makeCourse('tx@sa6.kr', { title: '끝난 수업', subject: '정보', catalogVisible: true }, [[5, 1]])
  await courses('tx@sa6.kr', { action: 'end', courseId: ended, endedOn: TODAY })
  const invited = await makeCourse('tx@sa6.kr', { title: '초대 수업', subject: '화학', catalogVisible: true, invitePolicy: 'auto' }, [[3, 3]])
  const rostered = await makeCourse('tx@sa6.kr', { title: '명단 수업', subject: '지구과학', catalogVisible: true, invitePolicy: 'auto' }, [[3, 4]])
  const s2c = (await api('/api/courses', await tok('ts2@sa6.kr'), { action: 'create', title: '다른 학교 공개 수업', subject: '영어', catalogVisible: true })).j.courseId
  // 다른 학기 공개 수업 · 지난주부터 듣던 내가 담은 수업(지난 날짜 기록 확인용) — 관리 도구로 직접
  const now = Timestamp.now()
  const seedCourse = (id, extra) =>
    db.doc(`schools/S1/courses/${id}`).set({
      schoolCode: 'S1', termId: TERM, title: id, subject: id, section: null, teacherUids: ['tx'], teacherNames: ['최과학'], managerUids: [],
      status: 'active', endedOn: null, commonForHomerooms: [], defaultRoomName: null, invitePolicy: 'auto', catalogVisible: true,
      source: 'manual', createdBy: 'tx', createdAt: now, updatedAt: now, revision: 1, ...extra,
    })
  await seedCourse('sa6OtherTerm', { termId: OTHER_TERM, title: '다른 학기 수업' })
  await seedCourse('sa6Past', { title: '지난주부터 수업' })
  await db.doc('schools/S1/series/sa6PastSer').set({ courseId: 'sa6Past', termId: TERM, weekday: weekdayOf(PAST), period: 6, start: null, end: null, roomName: '어학실', validFrom: addDays(TODAY, -14), validTo: null, status: 'active', createdBy: 'seed', createdAt: now })
  await db.doc(`schools/S1/enrollments/sa6Past__stu3`).set({ courseId: 'sa6Past', uid: 'stu3', schoolCode: 'S1', termId: TERM, status: 'active', from: addDays(TODAY, -14), to: null, source: 'request', decidedBy: null, createdAt: now, updatedAt: now })
  // 학교가 넣어 준 수강: 선생님 추가(admin) · 명단(roster)
  const add = await enroll('tx@sa6.kr', { action: 'add', courseId: invited, uid: 'stu3' })
  await db.doc(`schools/S1/enrollments/${rostered}__stu3`).set({ courseId: rostered, uid: 'stu3', schoolCode: 'S1', termId: TERM, status: 'active', from: TODAY, to: null, source: 'roster', createdAt: now, updatedAt: now })
  check('setup', '수업·차시·수강 준비', add.status === 200 && !!sci && !!phys && !!s2c, `${add.status}`)

  // ───── 1. 공개 목록: 대상 학년 ─────
  const cat = await courses('stu3@sa6.kr', { action: 'catalog' })
  const byId = Object.fromEntries((cat.j.courses || []).map((c) => [c.courseId, c]))
  check('C1', '공개 목록: 공개·운영 중·이번 학기·같은 학교 수업만(비공개·끝난 수업·다른 학기·다른 학교 없음)',
    cat.status === 200 && byId[sci] && byId[phys] && byId[art] && byId[math1] && !byId[hidden] && !byId[ended] && !byId.sa6OtherTerm && !byId[s2c],
    JSON.stringify(Object.keys(byId)))
  check('C2', '대상 학년: 정한 수업은 grades(중복 없이), 정하지 않은 수업은 grades 없음(학년 미상 — 화면이 모든 학년에 보임)',
    JSON.stringify(byId[sci]?.grades) === '[3]' && JSON.stringify(byId[phys]?.grades) === '[3]' && JSON.stringify(byId[math1]?.grades) === '[1]' && byId[art] && !('grades' in byId[art]),
    JSON.stringify({ sci: byId[sci]?.grades, phys: byId[phys]?.grades, math1: byId[math1]?.grades, art: byId[art]?.grades }))
  check('C3', '칸 보기 자료: 요일·교시·교실', JSON.stringify(byId[sci]?.slots) === JSON.stringify([{ weekday: 2, period: 4, roomName: '과학실' }, { weekday: 4, period: 2, roomName: '과학실' }]), JSON.stringify(byId[sci]?.slots))
  const catKeys = byId[sci] ? Object.keys(byId[sci]).sort().join(',') : ''
  check('C4', '공개 목록 수업 키: 학생 자료 없음(수강 인원·명단·교사 uid 없음, 내 상태만)', catKeys === 'courseId,defaultRoomName,grades,invitePolicy,myStatus,section,slots,subject,teacherNames,title', catKeys)
  check('C5', '공개 목록에 다른 학생 uid·이름 없음', !/stuB|stu1|이학생|박학생|"tx"|"tz"/.test(JSON.stringify(cat.j)), '')
  const tGet = await courses('tx@sa6.kr', { action: 'get', courseId: sci })
  check('C6', '교사 상세에 대상 학년(grades)', tGet.status === 200 && JSON.stringify(tGet.j.course?.grades) === '[3]', JSON.stringify(tGet.j.course?.grades))
  const badG = await courses('tx@sa6.kr', { action: 'update', courseId: sci, grades: [7] })
  const okG = await courses('tx@sa6.kr', { action: 'update', courseId: art, grades: [3, 1, 3] })
  const sameG = await courses('tx@sa6.kr', { action: 'update', courseId: hidden, grades: [] })
  check('C7', '대상 학년 수정: 1~6만(7 → 400), 정리해 저장([3,1,3] → [1,3]), 없던 수업에 []는 변경 없음',
    badG.status === 400 && okG.status === 200 && JSON.stringify(okG.j.course?.grades) === '[1,3]' && sameG.status === 200 && sameG.j.already === true,
    `${badG.status} ${JSON.stringify(okG.j.course?.grades)} ${sameG.status}/${sameG.j.already}`)
  await courses('tx@sa6.kr', { action: 'update', courseId: art, grades: null })

  // ───── 2. requestMany: 권한·입력 ─────
  const noTok = await api('/api/enrollments', null, { action: 'requestMany', courseIds: [sci] })
  const tReq = await enroll('tx@sa6.kr', { action: 'requestMany', courseIds: [sci] })
  check('M1', '로그인 없음 401, 교사가 학생 담기 호출 → 403 student-only', noTok.status === 401 && tReq.status === 403 && tReq.j.code === 'student-only', `${noTok.status}/${tReq.status} ${tReq.j.code}`)
  const empty = await enroll('stu3@sa6.kr', { action: 'requestMany', courseIds: [] })
  const notArr = await enroll('stu3@sa6.kr', { action: 'requestMany', courseIds: sci })
  const badEl = await enroll('stu3@sa6.kr', { action: 'requestMany', courseIds: [sci, 5] })
  const many = await enroll('stu3@sa6.kr', { action: 'requestMany', courseIds: Array.from({ length: 21 }, (_, i) => `x${i}`) })
  check('M2', '빈 목록·배열 아님·문자열 아닌 항목 → 400, 21개 → 400 too-many(max 20)',
    empty.status === 400 && notArr.status === 400 && badEl.status === 400 && many.status === 400 && many.j.code === 'too-many' && many.j.max === 20,
    `${empty.status}/${notArr.status}/${badEl.status}/${many.status} ${many.j.code}`)
  const max20 = await enroll('stu1@sa6.kr', { action: 'requestMany', courseIds: Array.from({ length: 20 }, (_, i) => `nope${i}`) })
  check('M3', '20개는 받음(없는 수업은 수업마다 course-not-found, 바뀐 것 없음)', max20.status === 200 && max20.j.results?.length === 20 && max20.j.results.every((r) => r.ok === false && r.code === 'course-not-found') && max20.j.changed === 0, `${max20.status} ${max20.j.changed}`)

  // ───── 3. requestMany: 섞인 묶음(바로·승인·비공개·다른 학교·끝남·다른 학기·중복·형식 오류) ─────
  const rev0 = await revNow()
  const audit0 = await auditCount('enrollment.requestMany')
  const mixed = await enroll('stu3@sa6.kr', { action: 'requestMany', courseIds: [sci, phys, hidden, s2c, ended, 'sa6OtherTerm', sci, 'bad id!'] })
  const res = Object.fromEntries((mixed.j.results || []).map((r) => [r.courseId, r]))
  check('M4', '수업마다 따로 판정(일부 성공): 바로 담기 active · 승인 pending',
    mixed.status === 200 && res[sci]?.ok === true && res[sci]?.status === 'active' && !res[sci]?.already && res[phys]?.ok === true && res[phys]?.status === 'pending',
    JSON.stringify(mixed.j).slice(0, 400))
  check('M5', '비공개 not-open · 다른 학교 course-not-found · 끝남 course-ended · 다른 학기 other-term · 형식 오류 invalid-id',
    res[hidden]?.code === 'not-open' && res[s2c]?.code === 'course-not-found' && res[ended]?.code === 'course-ended' && res.sa6OtherTerm?.code === 'other-term' && res['bad id!']?.code === 'invalid-id' && [hidden, s2c, ended, 'sa6OtherTerm'].every((id) => res[id]?.ok === false),
    JSON.stringify(mixed.j.results))
  check('M6', '중복 id는 한 번만(결과 7개), 바뀐 수강 2개', mixed.j.results?.length === 7 && mixed.j.changed === 2, `${mixed.j.results?.length} changed=${mixed.j.changed}`)
  const rev1 = await revNow()
  const audit1 = await auditCount('enrollment.requestMany')
  check('M7', '묶음 하나에 scheduleRevision +1 한 번, 감사 로그 한 건', rev1 === rev0 + 1 && audit1 === audit0 + 1 && mixed.j.revision === rev1, `${rev0}→${rev1} audit ${audit0}→${audit1}`)
  const eSci = (await db.doc(`schools/S1/enrollments/${sci}__stu3`).get()).data() || {}
  const ePhys = (await db.doc(`schools/S1/enrollments/${phys}__stu3`).get()).data() || {}
  check('M8', '결정적 수강 id(courseId__uid)·출처 request·바로 담기는 오늘부터, 승인은 기간 없음',
    eSci.status === 'active' && eSci.source === 'request' && eSci.from === TODAY && eSci.uid === 'stu3' && ePhys.status === 'pending' && ePhys.from === null && ePhys.source === 'request',
    JSON.stringify({ eSci: [eSci.status, eSci.source, eSci.from], ePhys: [ePhys.status, ePhys.from] }))
  const hiddenDoc = await db.doc(`schools/S1/enrollments/${hidden}__stu3`).get()
  check('M9', '실패한 수업은 수강 문서를 만들지 않음', !hiddenDoc.exists)
  const auditDoc = (await db.collection('schools/S1/audit').where('action', '==', 'enrollment.requestMany').get()).docs.map((d) => d.data()).find((a) => a.actorUid === 'stu3')
  check('M10', '감사 로그: 바뀐 수업과 상태만(다른 학생·이름 없음)', !!auditDoc && auditDoc.meta?.changed === 2 && auditDoc.meta?.items?.length === 2 && !JSON.stringify(auditDoc).includes('김학생'), JSON.stringify(auditDoc?.meta))
  const notif = await db.collection('users/tz/notifications').get()
  check('M11', '승인 대기 수업 담당 교사에게 알림 한 건(기존 신청과 같은 id)', notif.size === 1 && notif.docs[0].id === `enr_${phys}__stu3_${TODAY}`, notif.docs.map((d) => d.id).join(','))
  const txNotif = await db.collection('users/tx/notifications').get()
  check('M12', '바로 담기 수업 교사에게는 알림 없음', txNotif.size === 0, `${txNotif.size}`)

  const again = await enroll('stu3@sa6.kr', { action: 'requestMany', courseIds: [sci, phys] })
  const rev2 = await revNow()
  const audit2 = await auditCount('enrollment.requestMany')
  const notif2 = await db.collection('users/tz/notifications').get()
  check('M13', '다시 담기 → 둘 다 already(같은 결과), 버전·감사·알림 그대로',
    again.status === 200 && again.j.results.every((r) => r.ok && r.already) && again.j.changed === 0 && rev2 === rev1 && audit2 === audit1 && notif2.size === 1,
    `${JSON.stringify(again.j.results)} rev ${rev1}→${rev2}`)
  const single = await enroll('stu3@sa6.kr', { action: 'request', courseId: phys })
  const notif3 = await db.collection('users/tz/notifications').get()
  check('M14', "한 개 'request'도 같은 규칙: 이미 신청 → already, 알림 중복 없음", single.status === 200 && single.j.already === true && single.j.status === 'pending' && notif3.size === 1, `${single.status} ${JSON.stringify(single.j)}`)
  const otherTerm1 = await enroll('stu3@sa6.kr', { action: 'request', courseId: 'sa6OtherTerm' })
  check('M15', "한 개 'request'도 다른 학기 수업은 409 other-term", otherTerm1.status === 409 && otherTerm1.j.code === 'other-term', `${otherTerm1.status} ${otherTerm1.j.code}`)
  check('M16', '응답에 다른 학생 uid 없음', !/stuB|stu1/.test(JSON.stringify(mixed.j) + JSON.stringify(again.j)), '')

  // 다른 학생(B)이 같은 수업을 담아도 서로의 수강 정보는 보이지 않음
  const bPick = await enroll('stub@sa6.kr', { action: 'requestMany', courseIds: [sci, art] })
  const catA = await courses('stu3@sa6.kr', { action: 'catalog' })
  check('M17', '다른 학생이 담아도 내 공개 목록에는 내 상태만(인원·uid 없음)', bPick.status === 200 && !JSON.stringify(catA.j).includes('stuB') && (catA.j.courses || []).find((c) => c.courseId === art)?.myStatus === null, JSON.stringify((catA.j.courses || []).find((c) => c.courseId === art)))

  // ───── 4. leave ─────
  const tLeave = await enroll('tx@sa6.kr', { action: 'leave', courseId: sci })
  check('L1', '교사가 학생 빼기 호출 → 403 student-only', tLeave.status === 403 && tLeave.j.code === 'student-only', `${tLeave.status} ${tLeave.j.code}`)
  const revL0 = await revNow()
  const auditL0 = await auditCount('enrollment.leave')
  const lv = await enroll('stu3@sa6.kr', { action: 'leave', courseId: sci })
  const eSci2 = (await db.doc(`schools/S1/enrollments/${sci}__stu3`).get()).data() || {}
  const revL1 = await revNow()
  check('L2', '내가 담은 수업 빼기 → ended·to=오늘·decidedBy 없음, scheduleRevision +1, 감사 로그',
    lv.status === 200 && lv.j.status === 'ended' && eSci2.status === 'ended' && eSci2.to === TODAY && !eSci2.decidedBy && eSci2.leftBy === 'stu3' && revL1 === revL0 + 1 && (await auditCount('enrollment.leave')) === auditL0 + 1,
    `${lv.status} ${JSON.stringify({ st: eSci2.status, to: eSci2.to, rev: [revL0, revL1] })}`)
  const lvP = await enroll('stu3@sa6.kr', { action: 'leave', courseId: phys })
  const ePhys2 = (await db.doc(`schools/S1/enrollments/${phys}__stu3`).get()).data() || {}
  check('L3', '승인 대기 신청 빼기 → ended·기간 없음(to null)', lvP.status === 200 && ePhys2.status === 'ended' && ePhys2.to === null, JSON.stringify({ st: ePhys2.status, to: ePhys2.to }))
  const lvInv = await enroll('stu3@sa6.kr', { action: 'leave', courseId: invited })
  const lvRos = await enroll('stu3@sa6.kr', { action: 'leave', courseId: rostered })
  const invDoc = (await db.doc(`schools/S1/enrollments/${invited}__stu3`).get()).data() || {}
  check('L4', '학교가 넣어 준 수강(선생님 추가·명단) → 403 not-self-picked, 그대로 active',
    lvInv.status === 403 && lvInv.j.code === 'not-self-picked' && lvRos.status === 403 && lvRos.j.code === 'not-self-picked' && invDoc.status === 'active',
    `${lvInv.status} ${lvInv.j.code} / ${lvRos.status} ${lvRos.j.code}`)
  const lvNone = await enroll('stu3@sa6.kr', { action: 'leave', courseId: art })
  const lvAgain = await enroll('stu3@sa6.kr', { action: 'leave', courseId: sci })
  const lvOther = await enroll('stu1@sa6.kr', { action: 'leave', courseId: sci })
  check('L5', '수강 없음 → 404, 이미 뺀 수업 → already, 다른 학생 수강은 건드릴 수 없음(내 수강 문서만 — 404)',
    lvNone.status === 404 && lvAgain.status === 200 && lvAgain.j.already === true && lvOther.status === 404,
    `${lvNone.status}/${lvAgain.status} ${lvAgain.j.already}/${lvOther.status}`)
  const bSci = (await db.doc(`schools/S1/enrollments/${sci}__stuB`).get()).data() || {}
  check('L6', '다른 학생(B)의 같은 수업 수강은 그대로', bSci.status === 'active', bSci.status)

  // 지난 날짜 기록 유지: 지난주부터 듣던 내가 담은 수업을 빼도 지난 날짜에는 그대로
  const lvPast = await enroll('stu3@sa6.kr', { action: 'leave', courseId: 'sa6Past' })
  const p = await me('stu3@sa6.kr', `?from=${addDays(TODAY, -8)}&to=${addDays(TODAY, 7)}`)
  const ePast = (p.j.enrollments || []).find((e) => e.courseId === 'sa6Past')
  const pastHas = lessonsOn(p.j, PAST).includes('sa6Past')
  const nextHas = lessonsOn(p.j, addDays(TODAY, 7)).includes('sa6Past')
  check('L7', '/api/timetable/me: 뺀 수업은 지난 날짜(지난주)에는 그대로, 다음 주부터 없음(to=오늘)',
    lvPast.status === 200 && p.status === 200 && ePast?.status === 'ended' && ePast?.to === TODAY && pastHas && !nextHas,
    JSON.stringify({ ePast, pastHas, nextHas }))
  check('L8', '/api/timetable/me에 본인 수강만(다른 학생 없음)', (p.j.enrollments || []).every((e) => e.uid === 'stu3') && !JSON.stringify(p.j).includes('stuB'), '')

  // 뺀 뒤 다시 담기 → 처음처럼(바로 담기 수업은 바로, 이력 남김)
  const re = await enroll('stu3@sa6.kr', { action: 'requestMany', courseIds: [sci] })
  const eSci3 = (await db.doc(`schools/S1/enrollments/${sci}__stu3`).get()).data() || {}
  check('L9', '뺀 수업 다시 담기 → active(승인 대기로 바뀌지 않음), 이전 기간은 history',
    re.status === 200 && re.j.results?.[0]?.status === 'active' && eSci3.status === 'active' && Array.isArray(eSci3.history) && eSci3.history.length === 1,
    JSON.stringify({ r: re.j.results, h: eSci3.history }))
  // 선생님이 끝낸 수강은 다시 담으면 승인 대기(기존 규칙)
  await enroll('tx@sa6.kr', { action: 'end', courseId: sci, uid: 'stuB' })
  const reB = await enroll('stub@sa6.kr', { action: 'requestMany', courseIds: [sci] })
  check('L10', '선생님이 끝낸 수강을 다시 담으면 승인 대기(기존 request 규칙 그대로)', reB.j.results?.[0]?.status === 'pending', JSON.stringify(reB.j.results))
  const lvTeacherEnded = await enroll('stub@sa6.kr', { action: 'leave', courseId: sci })
  check('L11', '내가 다시 신청한 승인 대기는 뺄 수 있음(출처 request)', lvTeacherEnded.status === 200, `${lvTeacherEnded.status} ${lvTeacherEnded.j.code || ''}`)

  // ───── 5. 시간표 가져오기: 학생 수업 담기 공개 선택 ─────
  const API = '/api/timetable-import'
  const kimTok = await tok('kim@sa6.kr')
  const row = (r, weekday, period, subject, teacher, classLabel, extra = {}) => ({ sourceKind: 'class', sheet: '가상 시간표', row: r, col: 1, weekday, period, subject, teacher, ...(classLabel ? { classLabel } : {}), ...extra })
  const ROWS = [
    row(1, 1, 3, '국어', '김민수', '3-4'),
    row(2, 2, 6, 'A_영어', '이영희', '3-4'),
    row(3, 2, 6, 'A_영어', '이영희', '3-5'),
    row(4, 3, 5, '수학', '오수학', '1-2'),
    row(5, 5, 7, 'A_동아리', '박동아', null, { sourceKind: 'teacher', sheet: '교사 시간표' }),
  ]
  const sha = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex')
  const publish = async (rows, catalog, validFrom = NEXT_MON) => {
    const st = await api(API, kimTok, { action: 'stage', schoolCode: 'S1', termId: TERM, validFrom, mode: 'merge', fileName: '가상.xlsx', fileHash: sha([rows, validFrom, Math.random()]), rows })
    const pv = await api(API, kimTok, { action: 'preview', batchId: st.j.batchId })
    const body = { action: 'commit', batchId: st.j.batchId, expectedRevision: pv.j.revision, acceptReview: true }
    if (catalog !== undefined) body.catalog = catalog
    const c = await api(API, kimTok, body)
    return { st, pv, c }
  }
  const imported = async () => {
    const q = await db.collection('schools/S1/courses').where('source', '==', 'import').get()
    return Object.fromEntries(q.docs.map((d) => [d.get('importKey'), { id: d.id, ...d.data() }]))
  }
  const badCat = await (async () => {
    const st = await api(API, kimTok, { action: 'stage', schoolCode: 'S1', termId: TERM, validFrom: NEXT_MON, mode: 'merge', fileName: 'x.xlsx', fileHash: sha(['bad']), rows: ROWS })
    const pv = await api(API, kimTok, { action: 'preview', batchId: st.j.batchId })
    const r = await api(API, kimTok, { action: 'commit', batchId: st.j.batchId, expectedRevision: pv.j.revision, catalog: { visible: 'yes', policy: 'auto' } })
    await api(API, kimTok, { action: 'cancel', batchId: st.j.batchId })
    return r
  })()
  check('I0', '공개 선택 형식 오류 → 400 invalid-catalog(아무것도 쓰지 않음)', badCat.status === 400 && badCat.j.code === 'invalid-catalog' && Object.keys(await imported()).length === 0, `${badCat.status} ${badCat.j.code}`)

  const i1 = await publish(ROWS, { visible: true, policy: 'auto' })
  const A = await imported()
  const kor = A['hr|3-4|국어|김민수']
  const eng = A['sec|영어|A|이영희']
  const mth = A['hr|1-2|수학|오수학']
  const club = A['sec|동아리|A|박동아']
  check('I1', '가져오기 발행(공개·바로 담기) → 새 수업 4개 catalogVisible true·invitePolicy auto',
    i1.c.status === 200 && [kor, eng, mth, club].every((c) => c && c.catalogVisible === true && c.invitePolicy === 'auto' && c.catalogBy === 'import'),
    `${i1.c.status} ${i1.c.j.code || ''} ${JSON.stringify(Object.values(A).map((c) => [c.title, c.catalogVisible, c.invitePolicy]))}`)
  check('I2', '대상 학년: 학급 표시에서(3-4 국어 [3], 3-4·3-5 영어 A [3], 1-2 수학 [1]), 학급 표시 없는 동아리 A는 grades 없음',
    JSON.stringify(kor?.grades) === '[3]' && JSON.stringify(eng?.grades) === '[3]' && JSON.stringify(mth?.grades) === '[1]' && club && !('grades' in club),
    JSON.stringify({ kor: kor?.grades, eng: eng?.grades, mth: mth?.grades, club: club?.grades }))
  check('I3', '공통 수업은 여전히 담임 확인만(commonForHomerooms 비어 있음)', [kor, eng].every((c) => JSON.stringify(c.commonForHomerooms) === '[]'), '')
  const cat2 = await courses('stu3@sa6.kr', { action: 'catalog' })
  const cat2Kor = (cat2.j.courses || []).find((c) => c.courseId === kor?.id)
  check('I4', '학생 공개 목록에 가져온 수업이 대상 학년과 함께 보임', !!cat2Kor && JSON.stringify(cat2Kor.grades) === '[3]' && cat2Kor.slots.length === 1, JSON.stringify(cat2Kor))

  // 교사가 수업 화면에서 국어를 비공개로 바꿈 → 다음 가져오기가 덮어쓰지 않음
  const upd = await courses('kim@sa6.kr', { action: 'update', courseId: kor.id, catalogVisible: false })
  const korAfterUpd = (await db.doc(`schools/S1/courses/${kor.id}`).get()).data() || {}
  check('I5', '교사가 공개 설정을 바꾸면 catalogBy teacher', upd.status === 200 && korAfterUpd.catalogBy === 'teacher' && korAfterUpd.catalogVisible === false, `${upd.status} ${korAfterUpd.catalogBy}`)
  const i2 = await publish(ROWS, { visible: true, policy: 'approval' }, addDays(NEXT_MON, 7))
  const B = await imported()
  check('I6', '두 번째 가져오기(공개·승인 후): 가져오기가 맡은 수업만 approval로, 교사가 정한 국어는 그대로(비공개·auto)',
    i2.c.status === 200 && B['hr|3-4|국어|김민수'].catalogVisible === false && B['hr|3-4|국어|김민수'].invitePolicy === 'auto' && B['hr|3-4|국어|김민수'].catalogBy === 'teacher' &&
      ['sec|영어|A|이영희', 'hr|1-2|수학|오수학', 'sec|동아리|A|박동아'].every((k) => B[k].catalogVisible === true && B[k].invitePolicy === 'approval'),
    `${i2.c.status} ${JSON.stringify(Object.values(B).map((c) => [c.title, c.catalogVisible, c.invitePolicy, c.catalogBy]))}`)
  check('I7', '두 번째 발행 결과의 updated에 공개 설정이 바뀐 수업만(국어 제외)', Array.isArray(i2.c.j.updated) && i2.c.j.updated.length === 3 && !i2.c.j.updated.includes(kor.id), JSON.stringify(i2.c.j.updated))
  // 공개 선택 없이(이전 화면·API) → 기존 수업 공개 설정 그대로, 새 수업은 예전처럼 비공개·승인 후
  const ROWS3 = ROWS.concat([row(6, 4, 5, '음악', '최유나', '2-1')])
  const i3 = await publish(ROWS3, undefined, addDays(NEXT_MON, 14))
  const C3 = await imported()
  const music = C3['hr|2-1|음악|최유나']
  check('I8', '공개 선택 없이 발행 → 기존 수업 그대로(영어 A approval·공개), 새 수업(음악)은 예전처럼 비공개·승인 후·grades [2]',
    i3.c.status === 200 && C3['sec|영어|A|이영희'].catalogVisible === true && C3['sec|영어|A|이영희'].invitePolicy === 'approval' && music && music.catalogVisible === false && music.invitePolicy === 'approval' && JSON.stringify(music.grades) === '[2]',
    `${i3.c.status} ${JSON.stringify(music)}`.slice(0, 300))
  // 공개를 끄고 발행 → 가져오기가 맡은 수업은 비공개, 교사가 정한 수업은 그대로
  const i4 = await publish(ROWS3, { visible: false, policy: 'auto' }, addDays(NEXT_MON, 15))
  const D4 = await imported()
  check('I9', '공개 끄고 발행 → 가져오기가 맡은 수업(영어 A·수학·동아리·음악) 비공개, 교사가 정한 국어는 그대로',
    i4.c.status === 200 && ['sec|영어|A|이영희', 'hr|1-2|수학|오수학', 'sec|동아리|A|박동아', 'hr|2-1|음악|최유나'].every((k) => D4[k].catalogVisible === false) && D4['hr|3-4|국어|김민수'].catalogBy === 'teacher',
    JSON.stringify(Object.values(D4).map((c) => [c.title, c.catalogVisible])))
  // 학급 시간표로 만든 공통 수업·직접 만든 수업은 가져오기와 무관(비공개 그대로)
  const manualHidden = (await db.doc(`schools/S1/courses/${hidden}`).get()).data() || {}
  check('I10', '가져오기 출처가 아닌 수업(직접 만든 비공개 수업)은 그대로 비공개', manualHidden.catalogVisible === false, '')
  // 원복: 마지막 발행을 되돌리면 공개 설정도 이전 값으로
  const rb = await api(API, kimTok, { action: 'rollback', batchId: i4.c.j.batchId, expectedRevision: await revNow() })
  const E5 = await imported()
  check('I11', '마지막 발행 원복 → 공개 설정도 이전 값(영어 A 공개·승인 후)', rb.status === 200 && E5['sec|영어|A|이영희'].catalogVisible === true && E5['sec|영어|A|이영희'].invitePolicy === 'approval', `${rb.status} ${rb.j.code || ''} ${JSON.stringify([E5['sec|영어|A|이영희']?.catalogVisible, E5['sec|영어|A|이영희']?.invitePolicy])}`)
  const auditImp = (await db.collection('schools/S1/audit').where('action', '==', 'timetable-import.commit').get()).docs.map((d) => d.data().meta?.catalogOption)
  check('I12', '가져오기 감사 로그에 공개 선택 기록(학생 정보 없음)', auditImp.some((c) => c && c.visible === true && c.policy === 'auto') && auditImp.some((c) => c === null), JSON.stringify(auditImp))

  for (const s of Object.values(sessions)) await s.close()
}

let failed = 1
try {
  await main()
  failed = finish()
} catch (e) {
  console.error('테스트 실행 오류', e)
  check('setup', '테스트 실행 오류 없음', false, String(e?.stack || e).slice(0, 400))
  failed = finish()
}
process.exit(failed ? 1 : 0)
