/**
 * 개인 시간표 엔진 — 수강 대상 결정·기본 차시 확장·날짜 유틸·기본 시간표 버전·이동수업·분반 구분·학교 혼입
 *
 * 테스트 데이터는 모두 가상입니다(문서 19장 구성). 실제 학생·교사 정보가 아닙니다.
 *   학교 S1(T1 = 2026-09-01 ~ 2027-03-01 미포함), 별도 학교 S2(같은 이름의 교사·과목·학생)
 *   학생 A: 소속 3학년 4반, 생활과 과학 A + 영어 B 수강
 *   학생 B: 소속 3학년 5반, 영어 B만 수강
 *   학생 C: 영어 C(같은 과목명 다른 분반) 수강
 *   교사 X: 생활과 과학 A / 교사 Y: 영어 B, 영어 C
 *   교실 R34: 3학년 4반 교실 / R35: 3학년 5반 교실 (학급과 별개 개체)
 *
 * 요일 기대값은 엔진이 아니라 Python datetime.isoweekday()로 별도 확인한 값입니다.
 *   2026-10-05 월 · 10-06 화 · 10-07 수 · 10-08 목 · 10-09 금 · 10-10 토 · 10-11 일
 *   2026-10-31 토 · 11-01 일 · 12-31 목 · 2027-01-01 금 · 2027-02-28 일 · 03-01 월
 *   2028-02-28 월 · 02-29 화 · 03-01 수 · 2024-02-29 목
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { buildDayTimetable, courseActiveOn, resolveCourses, seriesOccursOn } from '../../src/lib/timetable/engine'
import type { ResolvedCourses } from '../../src/lib/timetable/engine'
import { addDays, inRange, isoToYmd, isYmd, relativeDayLabel, schoolHmAt, schoolYmdAt, weekdayOf } from '../../src/lib/timetable/dates'
import type {
  Course,
  DayTimetable,
  Enrollment,
  HomeroomMembership,
  LessonSeries,
  Override,
  StudentTimetableInput,
  Ymd,
} from '../../src/lib/timetable/types'

// ───────────────────────── 가상 픽스처 ─────────────────────────

const T1_FROM = '20260901'
const T1_TO = '20270301' // 미포함

const HR_S1_34 = 'hr-s1-t1-3-4' // S1 3학년 4반 (소속 학급 id)
const HR_S1_35 = 'hr-s1-t1-3-5' // S1 3학년 5반
const HR_S2_34 = 'hr-s2-t1-3-4' // S2 3학년 4반 — 표시 이름은 같아도 다른 학급

const UID_A = 'uid-test-student-a'
const UID_B = 'uid-test-student-b'
const UID_C = 'uid-test-student-c'
const UID_D = 'uid-test-student-d' // 수강 자료가 없는 3학년 4반 학생
const UID_E = 'uid-test-student-e' // 승인 대기 학생
const UID_A_SAME_NAME = 'uid-test-student-a-dup' // S1 안에서 A와 이름이 같은 다른 학생
const UID_S2_A = 'uid-test-s2-student-a' // S2의 동명이인

const ROOM_R34 = { id: 'room-s1-r34', name: '3학년 4반 교실' }
const ROOM_R35 = { id: 'room-s1-r35', name: '3학년 5반 교실' }
const ROOM_ENG = { id: 'room-s1-eng', name: '영어전용실' }
const ROOM_LANG = { id: 'room-s1-lang', name: '어학실' }

function mkCourse(p: Partial<Course> & Pick<Course, 'courseId' | 'title' | 'subject'>): Course {
  return {
    schoolCode: 'S1',
    termId: 'T1',
    teacherUids: [],
    teacherNames: [],
    status: 'active',
    endedOn: null,
    commonForHomerooms: [],
    defaultRoomId: null,
    defaultRoomName: null,
    ...p,
  }
}

function mkSeries(p: Partial<LessonSeries> & Pick<LessonSeries, 'seriesId' | 'courseId' | 'weekday' | 'period'>): LessonSeries {
  return { validFrom: T1_FROM, validTo: T1_TO, status: 'active', ...p }
}

function mkEnr(uid: string, courseId: string, p: Partial<Enrollment> = {}): Enrollment {
  return { uid, courseId, status: 'active', from: null, to: null, source: 'invite', ...p }
}

// courseId는 과목명·학급·교실과 무관한 불투명 값
const SCI_A = mkCourse({
  courseId: 'crs-9f1c',
  title: '생활과 과학 A',
  subject: '생활과 과학',
  section: 'A',
  teacherUids: ['uid-test-teacher-x'],
  teacherNames: ['교사 X'],
  defaultRoomId: ROOM_R34.id,
  defaultRoomName: ROOM_R34.name,
})
const ENG_B = mkCourse({
  courseId: 'crs-27ab',
  title: '영어 B',
  subject: '영어',
  section: 'B',
  teacherUids: ['uid-test-teacher-y'],
  teacherNames: ['교사 Y'],
  defaultRoomId: ROOM_R35.id,
  defaultRoomName: ROOM_R35.name,
})
const ENG_C = mkCourse({
  courseId: 'crs-5d03',
  title: '영어 C',
  subject: '영어',
  section: 'C',
  teacherUids: ['uid-test-teacher-y'],
  teacherNames: ['교사 Y'],
  defaultRoomId: ROOM_ENG.id,
  defaultRoomName: ROOM_ENG.name,
})
/** 3학년 5반 교실에서 열리지만 학생 B와 수강 관계가 없는 수업 */
const MATH_C_IN_R35 = mkCourse({
  courseId: 'crs-b871',
  title: '수학 선택 C',
  subject: '수학',
  section: 'C',
  teacherUids: ['uid-test-teacher-z'],
  teacherNames: ['교사 Z'],
  defaultRoomId: ROOM_R35.id,
  defaultRoomName: ROOM_R35.name,
})
/** 다른 학교 S2 — 제목·과목·분반·교사 이름·교실 이름이 S1 영어 B와 같음 */
const S2_ENG_B = mkCourse({
  courseId: 'crs-s2-e4f0',
  schoolCode: 'S2',
  title: '영어 B',
  subject: '영어',
  section: 'B',
  teacherUids: ['uid-test-s2-teacher-y'],
  teacherNames: ['교사 Y'],
  defaultRoomId: 'room-s2-r35',
  defaultRoomName: '3학년 5반 교실',
})
/** 명시된 학급 공통 수업 — 기본 픽스처에는 넣지 않고 공통 수업 테스트에서만 추가 */
const HR34_COMMON = mkCourse({
  courseId: 'crs-c341',
  title: '창의적 체험활동(3-4)',
  subject: '창의적 체험활동',
  teacherUids: ['uid-test-teacher-x'],
  teacherNames: ['교사 X'],
  defaultRoomId: ROOM_R34.id,
  defaultRoomName: ROOM_R34.name,
  commonForHomerooms: [HR_S1_34],
})
const HR35_COMMON = mkCourse({
  courseId: 'crs-c351',
  title: '창의적 체험활동(3-5)',
  subject: '창의적 체험활동',
  teacherUids: ['uid-test-teacher-y'],
  teacherNames: ['교사 Y'],
  defaultRoomId: ROOM_R35.id,
  defaultRoomName: ROOM_R35.name,
  commonForHomerooms: [HR_S1_35],
})
const S2_HR34_COMMON = mkCourse({
  courseId: 'crs-s2-c341',
  schoolCode: 'S2',
  title: '창의적 체험활동(3-4)',
  subject: '창의적 체험활동',
  defaultRoomName: '3학년 4반 교실',
  commonForHomerooms: [HR_S2_34],
})

const SER_SCI_A_TUE_1 = mkSeries({ seriesId: 'ser-sci-a-tue-1', courseId: SCI_A.courseId, weekday: 2, period: 1 })
const SER_SCI_A_THU_4 = mkSeries({ seriesId: 'ser-sci-a-thu-4', courseId: SCI_A.courseId, weekday: 4, period: 4 })
/** 교실 미지정 → 수업 기본 장소(3학년 5반 교실) */
const SER_ENG_B_TUE_3 = mkSeries({ seriesId: 'ser-eng-b-tue-3', courseId: ENG_B.courseId, weekday: 2, period: 3 })
/** 차시별 교실(어학실)이 수업 기본 장소보다 우선 */
const SER_ENG_B_FRI_2 = mkSeries({
  seriesId: 'ser-eng-b-fri-2',
  courseId: ENG_B.courseId,
  weekday: 5,
  period: 2,
  roomId: ROOM_LANG.id,
  roomName: ROOM_LANG.name,
})
const SER_ENG_C_TUE_3 = mkSeries({ seriesId: 'ser-eng-c-tue-3', courseId: ENG_C.courseId, weekday: 2, period: 3 })
const SER_MATH_C_TUE_1 = mkSeries({ seriesId: 'ser-math-c-tue-1', courseId: MATH_C_IN_R35.courseId, weekday: 2, period: 1 })
const SER_S2_ENG_B_TUE_3 = mkSeries({ seriesId: 'ser-s2-eng-b-tue-3', courseId: S2_ENG_B.courseId, weekday: 2, period: 3 })
const SER_HR34_WED_7 = mkSeries({ seriesId: 'ser-hr34-wed-7', courseId: HR34_COMMON.courseId, weekday: 3, period: 7 })
const SER_HR35_WED_6 = mkSeries({ seriesId: 'ser-hr35-wed-6', courseId: HR35_COMMON.courseId, weekday: 3, period: 6 })
const SER_S2_HR34_WED_7 = mkSeries({ seriesId: 'ser-s2-hr34-wed-7', courseId: S2_HR34_COMMON.courseId, weekday: 3, period: 7 })

const S1_COURSES: Course[] = [SCI_A, ENG_B, ENG_C, MATH_C_IN_R35]
const S1_SERIES: LessonSeries[] = [SER_SCI_A_TUE_1, SER_SCI_A_THU_4, SER_ENG_B_TUE_3, SER_ENG_B_FRI_2, SER_ENG_C_TUE_3, SER_MATH_C_TUE_1]
/** S1 학교 전체 수강 행(엔진이 uid로 걸러야 함) */
const S1_ENROLLMENTS: Enrollment[] = [
  mkEnr(UID_A, SCI_A.courseId, { source: 'roster' }),
  mkEnr(UID_A, ENG_B.courseId, { source: 'invite' }),
  mkEnr(UID_B, ENG_B.courseId, { source: 'invite' }),
  mkEnr(UID_C, ENG_C.courseId, { source: 'roster' }),
  mkEnr(UID_A_SAME_NAME, ENG_C.courseId, { source: 'roster' }),
]

const HR_A: HomeroomMembership[] = [{ homeroomId: HR_S1_34, from: T1_FROM }]
const HR_B: HomeroomMembership[] = [{ homeroomId: HR_S1_35, from: T1_FROM }]
const HR_C: HomeroomMembership[] = [{ homeroomId: HR_S1_34, from: T1_FROM }]

const MON_1005 = '20261005'
const TUE_1006 = '20261006'
const WED_1007 = '20261007'
const THU_1008 = '20261008'
const FRI_1009 = '20261009'
const SAT_1010 = '20261010'
const SUN_1011 = '20261011'
const TUE_1013 = '20261013'
const TUE_1020 = '20261020'
const TUE_1027 = '20261027'

function mkInput(uid: string, date: Ymd, p: Partial<StudentTimetableInput> = {}): StudentTimetableInput {
  return {
    uid,
    day: { date },
    homerooms: [],
    enrollments: S1_ENROLLMENTS,
    courses: S1_COURSES,
    series: S1_SERIES,
    overrides: [],
    personalEntries: [],
    ...p,
  }
}

/** 화면에 실제 수업으로 나오는 행 요약 */
const brief = (t: DayTimetable): string[] => t.lessons.map((l) => `${l.period}교시 ${l.title} @${l.roomName}`)
const activeIds = (r: ResolvedCourses): string[] => Array.from(r.active.keys()).sort()
const sorted = (xs: string[]): string[] => [...xs].sort()

// ───────────────────────── 1. 수강 대상 결정 ─────────────────────────

describe('수강 대상 결정 resolveCourses', () => {
  test('R04/T04 학생 A는 소속 학급(3-4)과 별개로 생활과 과학 A·영어 B 두 수업을 개별 수강으로 가진다', () => {
    const r = resolveCourses(mkInput(UID_A, TUE_1006, { homerooms: HR_A }), TUE_1006)
    assert.deepEqual(activeIds(r), sorted([SCI_A.courseId, ENG_B.courseId]))
    assert.equal(r.active.get(SCI_A.courseId), 'enrolled')
    assert.equal(r.active.get(ENG_B.courseId), 'enrolled')
    assert.deepEqual(r.pending, [])
  })

  test('R16/T33 다른 uid(같은 학교 동명이인 포함)의 수강 행은 무시 — uid로만 판정', () => {
    // S1_ENROLLMENTS에는 A와 이름이 같은 다른 학생(UID_A_SAME_NAME)의 영어 C 수강이 있음
    const a = resolveCourses(mkInput(UID_A, TUE_1006, { homerooms: HR_A }), TUE_1006)
    assert.equal(a.active.has(ENG_C.courseId), false)
    const b = resolveCourses(mkInput(UID_B, TUE_1006, { homerooms: HR_B }), TUE_1006)
    assert.deepEqual(activeIds(b), [ENG_B.courseId])
    const nobody = resolveCourses(mkInput('uid-test-unknown', TUE_1006), TUE_1006)
    assert.equal(nobody.active.size, 0)
  })

  test('T03/R05 명시된 학급 공통 수업은 개별 수강 없이 소속 학급만으로 포함(출처 common), 가입일 전에는 없음', () => {
    const courses = [...S1_COURSES, HR34_COMMON, HR35_COMMON]
    const series = [...S1_SERIES, SER_HR34_WED_7, SER_HR35_WED_6]
    // D는 10/6에 3학년 4반 학급 QR을 수락(소속 시작) — 개별 수강 없음
    const homerooms: HomeroomMembership[] = [{ homeroomId: HR_S1_34, from: TUE_1006 }]
    const r = resolveCourses(mkInput(UID_D, WED_1007, { homerooms, courses }), WED_1007)
    assert.deepEqual(activeIds(r), [HR34_COMMON.courseId])
    assert.equal(r.active.get(HR34_COMMON.courseId), 'common')

    const day = buildDayTimetable(mkInput(UID_D, WED_1007, { homerooms, courses, series }))
    assert.deepEqual(brief(day), ['7교시 창의적 체험활동(3-4) @3학년 4반 교실'])
    assert.equal(day.lessons[0].source, 'common')
    assert.equal(day.lessons[0].synced, true)

    const before = resolveCourses(mkInput(UID_D, MON_1005, { homerooms, courses }), MON_1005)
    assert.equal(before.active.size, 0, '소속 시작일 전에는 공통 수업 없음')
  })

  test('R03/T32 같은 교실(3학년 4반 교실)에서 열린다는 이유만으로 연결하지 않음 — 시간표만 있고 수강 자료가 없으면 개인 시간표 없음', () => {
    // 생활과 과학 A는 3학년 4반 교실에서 열리지만 commonForHomerooms가 비어 있음
    const input = mkInput(UID_D, TUE_1006, { homerooms: [{ homeroomId: HR_S1_34, from: T1_FROM }] })
    const r = resolveCourses(input, TUE_1006)
    assert.equal(r.active.size, 0)
    const day = buildDayTimetable(input)
    assert.deepEqual(day.lessons, [])
    assert.deepEqual(day.activeCourseIds, [])
    assert.equal(day.state, 'no-courses')
  })

  test('T05 공통 수업·개별 수강·중복 초대 행·중복 차시 문서가 겹쳐도 courseId/차시 기준 한 번만 — 개별 수강 출처 우선', () => {
    const sciAsCommon: Course = { ...SCI_A, commonForHomerooms: [HR_S1_34] }
    const courses = [sciAsCommon, ENG_B, ENG_C, MATH_C_IN_R35, sciAsCommon] // 같은 수업 문서가 두 번 들어옴
    const enrollments = [
      mkEnr(UID_A, SCI_A.courseId, { source: 'roster' }),
      mkEnr(UID_A, SCI_A.courseId, { source: 'invite' }), // 교사 초대로 또 수락
      mkEnr(UID_A, ENG_B.courseId, { source: 'invite' }),
      mkEnr(UID_A, ENG_B.courseId, { source: 'invite' }), // 더블 탭 재전송
    ]
    // 교사별·교실별 조회에서 같은 반복 차시 문서가 두 번 들어온 상황
    const series = [...S1_SERIES, SER_SCI_A_TUE_1, SER_ENG_B_TUE_3]
    const input = mkInput(UID_A, TUE_1006, { homerooms: HR_A, courses, enrollments, series })

    const r = resolveCourses(input, TUE_1006)
    assert.deepEqual(activeIds(r), sorted([SCI_A.courseId, ENG_B.courseId]))
    assert.equal(r.active.get(SCI_A.courseId), 'enrolled', '개별 수강이 공통 수업보다 우선')

    const day = buildDayTimetable(input)
    assert.deepEqual(brief(day), ['1교시 생활과 과학 A @3학년 4반 교실', '3교시 영어 B @3학년 5반 교실'])
    const keys = day.lessons.map((l) => l.key)
    assert.equal(new Set(keys).size, keys.length, '화면 key 중복 없음')
    assert.deepEqual(day.conflicts, [], '자기 자신과의 겹침으로 오인하지 않음')
  })

  test('R13/T34 승인 대기(pending) 수강은 active와 분리되어 pendingCourseIds로만 전달, 승인되면 pending에서 빠짐', () => {
    const pendingOnly = [mkEnr(UID_E, ENG_C.courseId, { status: 'pending', source: 'request' })]
    const r = resolveCourses(mkInput(UID_E, TUE_1006, { enrollments: pendingOnly }), TUE_1006)
    assert.equal(r.active.size, 0)
    assert.deepEqual(r.pending, [ENG_C.courseId])

    const day = buildDayTimetable(mkInput(UID_E, TUE_1006, { enrollments: pendingOnly }))
    assert.deepEqual(day.lessons, [], '승인 전 수업은 시간표에 표시하지 않음')
    assert.deepEqual(day.pendingCourseIds, [ENG_C.courseId])
    assert.deepEqual(day.activeCourseIds, [])

    // 예전 신청(pending) 행과 승인된(active) 행이 같이 있으면 active만
    const both = [...pendingOnly, mkEnr(UID_E, ENG_C.courseId, { status: 'active', source: 'request' })]
    const r2 = resolveCourses(mkInput(UID_E, TUE_1006, { enrollments: both }), TUE_1006)
    assert.deepEqual(activeIds(r2), [ENG_C.courseId])
    assert.deepEqual(r2.pending, [])

    // 종료(ended)된 수강은 어느 쪽에도 없음
    const ended = [mkEnr(UID_E, ENG_C.courseId, { status: 'ended', source: 'request' })]
    const r3 = resolveCourses(mkInput(UID_E, TUE_1006, { enrollments: ended }), TUE_1006)
    assert.equal(r3.active.size, 0)
    assert.deepEqual(r3.pending, [])
  })

  test('T24 수강 기간 [from, to) — 시작일 포함·종료일 미포함, 과거/미래 날짜에 정확히 반영', () => {
    const enrollments = [
      mkEnr(UID_A, SCI_A.courseId, { source: 'roster' }),
      mkEnr(UID_A, ENG_B.courseId, { source: 'invite', from: TUE_1006, to: TUE_1020 }),
    ]
    const eng = (d: Ymd) => resolveCourses(mkInput(UID_A, d, { homerooms: HR_A, enrollments }), d).active.has(ENG_B.courseId)
    assert.equal(eng('20260929'), false, '시작 전 화요일')
    assert.equal(eng(MON_1005), false, '시작 전날')
    assert.equal(eng(TUE_1006), true, '시작일 포함')
    assert.equal(eng(TUE_1013), true)
    assert.equal(eng('20261019'), true, '종료 전날')
    assert.equal(eng(TUE_1020), false, '종료일 미포함')

    const day = (d: Ymd) => brief(buildDayTimetable(mkInput(UID_A, d, { homerooms: HR_A, enrollments })))
    assert.deepEqual(day('20260929'), ['1교시 생활과 과학 A @3학년 4반 교실'])
    assert.deepEqual(day(TUE_1006), ['1교시 생활과 과학 A @3학년 4반 교실', '3교시 영어 B @3학년 5반 교실'])
    assert.deepEqual(day(TUE_1013), ['1교시 생활과 과학 A @3학년 4반 교실', '3교시 영어 B @3학년 5반 교실'])
    assert.deepEqual(day(TUE_1020), ['1교시 생활과 과학 A @3학년 4반 교실'])
  })

  test('T24 수업 종료일(endedOn) — 종료일 전날까지만 운영, 종료 전 과거 날짜 이력은 보존', () => {
    const engEnded: Course = { ...ENG_B, status: 'ended', endedOn: TUE_1013 }
    const courses = [SCI_A, engEnded, ENG_C, MATH_C_IN_R35]
    assert.equal(courseActiveOn(engEnded, '20261012'), true)
    assert.equal(courseActiveOn(engEnded, TUE_1013), false)

    const r = (d: Ymd) => resolveCourses(mkInput(UID_A, d, { homerooms: HR_A, courses }), d)
    assert.equal(r('20261012').active.has(ENG_B.courseId), true)
    assert.equal(r(TUE_1013).active.has(ENG_B.courseId), false)

    const past = buildDayTimetable(mkInput(UID_A, TUE_1006, { homerooms: HR_A, courses }))
    assert.ok(brief(past).includes('3교시 영어 B @3학년 5반 교실'), '종료 전 과거 날짜는 그대로')
    const after = buildDayTimetable(mkInput(UID_A, TUE_1013, { homerooms: HR_A, courses }))
    assert.deepEqual(brief(after), ['1교시 생활과 과학 A @3학년 4반 교실'])

    // 상태가 active여도 종료일이 지정되면 그 날부터 운영 안 함 (공통 수업도 같음)
    const commonEnding: Course = { ...HR34_COMMON, endedOn: '20261014' }
    const r2 = (d: Ymd) =>
      resolveCourses(mkInput(UID_D, d, { homerooms: [{ homeroomId: HR_S1_34 }], courses: [...S1_COURSES, commonEnding] }), d)
    assert.equal(r2(WED_1007).active.has(HR34_COMMON.courseId), true)
    assert.equal(r2('20261014').active.has(HR34_COMMON.courseId), false)
  })

  test('T24/R03 소속 학급 기간 — 반 이동 적용일부터 새 학급 공통 수업, 이전 날짜는 이전 학급 공통 수업, 개별 수강은 유지', () => {
    const courses = [...S1_COURSES, HR34_COMMON, HR35_COMMON]
    const series = [...S1_SERIES, SER_HR34_WED_7, SER_HR35_WED_6]
    const homerooms: HomeroomMembership[] = [
      { homeroomId: HR_S1_34, from: T1_FROM, to: '20261012' },
      { homeroomId: HR_S1_35, from: '20261012' },
    ]
    const enrollments = [mkEnr(UID_D, ENG_B.courseId, { source: 'invite' })]
    const r = (d: Ymd) => resolveCourses(mkInput(UID_D, d, { homerooms, courses, enrollments }), d)
    assert.deepEqual(activeIds(r('20261011')), sorted([ENG_B.courseId, HR34_COMMON.courseId]))
    assert.deepEqual(activeIds(r('20261012')), sorted([ENG_B.courseId, HR35_COMMON.courseId]))

    const wed = (d: Ymd) => brief(buildDayTimetable(mkInput(UID_D, d, { homerooms, courses, series, enrollments })))
    assert.deepEqual(wed(WED_1007), ['7교시 창의적 체험활동(3-4) @3학년 4반 교실'])
    assert.deepEqual(wed('20261014'), ['6교시 창의적 체험활동(3-5) @3학년 5반 교실'])
    // 반 이동과 무관하게 영어 B는 이동 전후 모두 유지
    assert.ok(brief(buildDayTimetable(mkInput(UID_D, TUE_1006, { homerooms, courses, series, enrollments }))).includes('3교시 영어 B @3학년 5반 교실'))
    assert.ok(brief(buildDayTimetable(mkInput(UID_D, TUE_1013, { homerooms, courses, series, enrollments }))).includes('3교시 영어 B @3학년 5반 교실'))
  })
})

// ───────────────────────── 2. 기본 차시 확장 ─────────────────────────

describe('기본 차시 확장 seriesOccursOn', () => {
  test('R06/T11 반복 차시는 같은 요일에만 열림 — 화요일 차시는 월·수·주말에는 없고 다음 주 화요일에는 있음', () => {
    assert.equal(seriesOccursOn(SER_ENG_B_TUE_3, MON_1005), false)
    assert.equal(seriesOccursOn(SER_ENG_B_TUE_3, TUE_1006), true)
    assert.equal(seriesOccursOn(SER_ENG_B_TUE_3, WED_1007), false)
    assert.equal(seriesOccursOn(SER_ENG_B_TUE_3, SAT_1010), false)
    assert.equal(seriesOccursOn(SER_ENG_B_TUE_3, SUN_1011), false)
    assert.equal(seriesOccursOn(SER_ENG_B_TUE_3, TUE_1013), true)
  })

  test('R05/R06/T11 학생 A의 한 주(월~일) 개인 시간표 — 요일별 차시와 차시별 교실, 주말은 정상 무수업', () => {
    const week: Record<Ymd, string[]> = {
      [MON_1005]: [],
      [TUE_1006]: ['1교시 생활과 과학 A @3학년 4반 교실', '3교시 영어 B @3학년 5반 교실'],
      [WED_1007]: [],
      [THU_1008]: ['4교시 생활과 과학 A @3학년 4반 교실'],
      [FRI_1009]: ['2교시 영어 B @어학실'],
      [SAT_1010]: [],
      [SUN_1011]: [],
    }
    for (const [d, expected] of Object.entries(week)) {
      const t = buildDayTimetable(mkInput(UID_A, d, { homerooms: HR_A }))
      assert.equal(t.date, d)
      assert.deepEqual(brief(t), expected, d)
      assert.equal(t.state, expected.length ? 'lessons' : 'no-lessons', d)
    }
  })

  test('R06/T11 어제·오늘·내일·모레 이동 — 각 날짜의 요일에 맞는 개인 시간표', () => {
    const today = TUE_1006
    const views = [-1, 0, 1, 2].map((n) => {
      const d = addDays(today, n)
      return { label: relativeDayLabel(d, today), d, lessons: brief(buildDayTimetable(mkInput(UID_A, d, { homerooms: HR_A }))) }
    })
    assert.deepEqual(views, [
      { label: '어제', d: MON_1005, lessons: [] },
      { label: '오늘', d: TUE_1006, lessons: ['1교시 생활과 과학 A @3학년 4반 교실', '3교시 영어 B @3학년 5반 교실'] },
      { label: '내일', d: WED_1007, lessons: [] },
      { label: '모레', d: THU_1008, lessons: ['4교시 생활과 과학 A @3학년 4반 교실'] },
    ])
  })

  test('T12 월말·연말 넘김에서 요일이 어긋나지 않음 — 10/30(금)→11/3(화), 12/29(화)·12/31(목)→1/5(화)', () => {
    const at = (d: Ymd) => brief(buildDayTimetable(mkInput(UID_A, d, { homerooms: HR_A })))
    assert.deepEqual(at('20261030'), ['2교시 영어 B @어학실'])
    assert.deepEqual(at(addDays('20261030', 4)), ['1교시 생활과 과학 A @3학년 4반 교실', '3교시 영어 B @3학년 5반 교실'])
    assert.deepEqual(at('20261229'), ['1교시 생활과 과학 A @3학년 4반 교실', '3교시 영어 B @3학년 5반 교실'])
    assert.deepEqual(at('20261231'), ['4교시 생활과 과학 A @3학년 4반 교실'])
    assert.deepEqual(at(addDays('20261231', 5)), ['1교시 생활과 과학 A @3학년 4반 교실', '3교시 영어 B @3학년 5반 교실'])
  })

  test('T21/R11 적용 기간 [validFrom, validTo) — 시작일 포함·종료일 미포함, validTo 없으면 계속', () => {
    const s = mkSeries({ seriesId: 'ser-x', courseId: ENG_B.courseId, weekday: 2, period: 3, validFrom: TUE_1013, validTo: TUE_1027 })
    assert.equal(seriesOccursOn(s, TUE_1006), false, '시작 전')
    assert.equal(seriesOccursOn(s, TUE_1013), true, '시작일 포함')
    assert.equal(seriesOccursOn(s, TUE_1020), true)
    assert.equal(seriesOccursOn(s, TUE_1027), false, '종료일 미포함')
    const open = { ...s, validTo: null }
    assert.equal(seriesOccursOn(open, TUE_1027), true)
    assert.equal(seriesOccursOn(open, '20270223'), true)
  })

  test('T21 retired 차시 — 종료일 없이 retired면 삭제로 보아 어느 날짜에도 없음, 종료일이 있으면 그 전 날짜는 유지', () => {
    const deleted: LessonSeries = { ...SER_ENG_B_TUE_3, status: 'retired', validTo: null }
    assert.equal(seriesOccursOn(deleted, TUE_1006), false)
    assert.equal(seriesOccursOn(deleted, TUE_1027), false)
    const superseded: LessonSeries = { ...SER_ENG_B_TUE_3, status: 'retired', validTo: TUE_1020 }
    assert.equal(seriesOccursOn(superseded, TUE_1013), true, '교체 전 과거 날짜 보존')
    assert.equal(seriesOccursOn(superseded, TUE_1020), false)
  })

  test('T12 학기 전환 — T1 마지막 화요일은 T1 수업, T2 첫 화요일은 T2 수업만(수강·차시 기간 모두 [from,to))', () => {
    const ENG_B_T2 = mkCourse({ ...ENG_B, courseId: 'crs-t2-61aa', termId: 'T2' })
    const SER_T2 = mkSeries({ seriesId: 'ser-t2-eng-b-tue-5', courseId: ENG_B_T2.courseId, weekday: 2, period: 5, validFrom: '20270302', validTo: '20270901' })
    const enrollments = [
      mkEnr(UID_A, ENG_B.courseId, { source: 'invite', from: T1_FROM, to: T1_TO }),
      mkEnr(UID_A, ENG_B_T2.courseId, { source: 'roster', from: '20270302', to: '20270901' }),
    ]
    const input = (d: Ymd) =>
      mkInput(UID_A, d, { homerooms: HR_A, enrollments, courses: [ENG_B, ENG_B_T2], series: [SER_ENG_B_TUE_3, SER_T2] })
    assert.equal(weekdayOf('20270223'), 2)
    assert.equal(weekdayOf('20270302'), 2)

    const last = buildDayTimetable(input('20270223'))
    assert.deepEqual(last.lessons.map((l) => [l.courseId, l.period]), [[ENG_B.courseId, 3]])
    const first = buildDayTimetable(input('20270302'))
    assert.deepEqual(first.lessons.map((l) => [l.courseId, l.period]), [[ENG_B_T2.courseId, 5]])
  })

  test('T12/R15 학기 밖 날짜(모든 반복 차시의 적용 기간 밖)는 정상 무수업(no-lessons)으로 단정하지 않음', () => {
    // 2026-08-25(화)는 T1 시작(09-01) 전 — 수강은 기간 제한이 없지만 어떤 반복 차시도 적용되지 않음
    assert.equal(weekdayOf('20260825'), 2)
    const t = buildDayTimetable(mkInput(UID_A, '20260825', { homerooms: HR_A }))
    assert.deepEqual(t.lessons, [])
    assert.notEqual(
      t.state,
      'no-lessons',
      '문서 7-3: 학기 밖 날짜나 아직 시간표가 등록되지 않은 기간을 "수업 없음"으로 단정하지 않음 / 7-6: 미등록·미발행과 정상 무수업을 구분'
    )
  })

  test('T34/R13/R15 반복 차시가 하나도 등록되지 않은 수업만 연결된 날은 정상 무수업(no-lessons)으로 단정하지 않음', () => {
    const INFO_D = mkCourse({ courseId: 'crs-0e9d', title: '정보 D', subject: '정보', section: 'D', teacherNames: ['교사 W'] })
    const t = buildDayTimetable(
      mkInput(UID_A, TUE_1006, {
        homerooms: HR_A,
        courses: [...S1_COURSES, INFO_D],
        enrollments: [mkEnr(UID_A, INFO_D.courseId, { source: 'invite' })],
      })
    )
    assert.deepEqual(t.activeCourseIds, [INFO_D.courseId])
    assert.deepEqual(t.lessons, [])
    assert.notEqual(
      t.state,
      'no-lessons',
      '문서 7-6: "학교 또는 해당 기간의 시간표 미등록/미발행"은 "등록된 시간표상 수업이 없는 정상 날짜"와 별도 상태'
    )
  })
})

// ───────────────────────── 3. 날짜 유틸 ─────────────────────────

describe('날짜 유틸 dates.ts', () => {
  test('T11/T12 weekdayOf — ISO 요일(월=1 … 일=7), 월말·연말·윤일 포함', () => {
    const cases: [Ymd, number][] = [
      ['20260901', 2],
      [MON_1005, 1],
      [TUE_1006, 2],
      [WED_1007, 3],
      [THU_1008, 4],
      [FRI_1009, 5],
      [SAT_1010, 6],
      [SUN_1011, 7],
      ['20261031', 6],
      ['20261101', 7],
      ['20261231', 4],
      ['20270101', 5],
      ['20270228', 7],
      ['20270301', 1],
      ['20280228', 1],
      ['20280229', 2],
      ['20280301', 3],
      ['20240229', 4],
    ]
    for (const [d, wd] of cases) assert.equal(weekdayOf(d), wd, d)
  })

  test('T12 addDays — 월말·연말·윤년(2028)·평년(2027)·100/400년 규칙·음수·주 단위', () => {
    assert.equal(addDays('20261031', 1), '20261101')
    assert.equal(addDays('20261101', -1), '20261031')
    assert.equal(addDays('20261130', 1), '20261201')
    assert.equal(addDays('20261231', 1), '20270101')
    assert.equal(addDays('20270101', -1), '20261231')
    assert.equal(addDays('20270228', 1), '20270301', '2027 평년')
    assert.equal(addDays('20280228', 1), '20280229', '2028 윤년')
    assert.equal(addDays('20280229', 1), '20280301')
    assert.equal(addDays('20280301', -1), '20280229')
    assert.equal(addDays('21000228', 1), '21000301', '2100은 평년(100의 배수)')
    assert.equal(addDays('20000228', 1), '20000229', '2000은 윤년(400의 배수)')
    assert.equal(addDays(TUE_1006, 7), TUE_1013)
    assert.equal(addDays(TUE_1006, 0), TUE_1006)
    assert.equal(addDays('20261229', 7), '20270105')
    assert.equal(addDays('20270301', -365), '20260301')
  })

  test('T24 inRange — [from, to) 경계와 열린 구간', () => {
    assert.equal(inRange('20261005', TUE_1006, TUE_1013), false, '시작 전')
    assert.equal(inRange(TUE_1006, TUE_1006, TUE_1013), true, '시작일 포함')
    assert.equal(inRange('20261012', TUE_1006, TUE_1013), true, '종료 전날')
    assert.equal(inRange(TUE_1013, TUE_1006, TUE_1013), false, '종료일 미포함')
    assert.equal(inRange(TUE_1006, TUE_1006, TUE_1006), false, '빈 구간')
    assert.equal(inRange(TUE_1006, null, null), true)
    assert.equal(inRange(TUE_1006, undefined, TUE_1013), true)
    assert.equal(inRange(TUE_1013, undefined, TUE_1013), false)
    assert.equal(inRange('20991231', TUE_1006, null), true)
    assert.equal(inRange('20261231', '20261201', '20270101'), true, '연말 경계')
    assert.equal(inRange('20270101', '20261201', '20270101'), false)
  })

  test('T12 schoolYmdAt/schoolHmAt — 한국 시간(KST) 자정 경계(UTC 15:00)와 연말·윤일 경계', () => {
    assert.equal(schoolYmdAt(Date.UTC(2026, 9, 5, 14, 59, 59, 999)), MON_1005)
    assert.equal(schoolHmAt(Date.UTC(2026, 9, 5, 14, 59, 59, 999)), '23:59')
    assert.equal(schoolYmdAt(Date.UTC(2026, 9, 5, 15, 0, 0, 0)), TUE_1006)
    assert.equal(schoolHmAt(Date.UTC(2026, 9, 5, 15, 0, 0, 0)), '00:00')
    assert.equal(schoolYmdAt(Date.UTC(2026, 9, 6, 0, 0, 0, 0)), TUE_1006, 'UTC 자정 = KST 09:00 같은 날')
    assert.equal(schoolHmAt(Date.UTC(2026, 9, 6, 0, 0, 0, 0)), '09:00')
    assert.equal(schoolYmdAt(Date.UTC(2026, 11, 31, 14, 59, 59, 999)), '20261231')
    assert.equal(schoolYmdAt(Date.UTC(2026, 11, 31, 15, 0, 0, 0)), '20270101')
    assert.equal(schoolYmdAt(Date.UTC(2028, 1, 28, 15, 0, 0, 0)), '20280229')
    // epoch 값은 Python datetime으로 별도 계산: 2026-10-05T15:00:00Z = 1791212400000
    assert.equal(schoolYmdAt(1791212400000 - 1), MON_1005)
    assert.equal(schoolYmdAt(1791212400000), TUE_1006)
  })

  test('R06/T11/T12 relativeDayLabel — 어제/오늘/내일/모레, 그 밖은 null, 월말·연말·윤년 넘김', () => {
    assert.equal(relativeDayLabel(MON_1005, TUE_1006), '어제')
    assert.equal(relativeDayLabel(TUE_1006, TUE_1006), '오늘')
    assert.equal(relativeDayLabel(WED_1007, TUE_1006), '내일')
    assert.equal(relativeDayLabel(THU_1008, TUE_1006), '모레')
    assert.equal(relativeDayLabel(FRI_1009, TUE_1006), null)
    assert.equal(relativeDayLabel('20261004', TUE_1006), null)
    assert.equal(relativeDayLabel('20261101', '20261031'), '내일', '월말')
    assert.equal(relativeDayLabel('20270101', '20261231'), '내일', '연말')
    assert.equal(relativeDayLabel('20261231', '20270101'), '어제', '연초')
    assert.equal(relativeDayLabel('20270102', '20261231'), '모레')
    assert.equal(relativeDayLabel('20280301', '20280228'), '모레', '윤년: 2/29가 있음')
    assert.equal(relativeDayLabel('20270301', '20270228'), '내일', '평년')
  })

  test('R15 isYmd/isoToYmd — 존재하지 않는 날짜·형식 오류 거부', () => {
    assert.equal(isYmd(TUE_1006), true)
    assert.equal(isYmd('20280229'), true, '윤일')
    assert.equal(isYmd('20270229'), false, '평년 2/29')
    assert.equal(isYmd('20260230'), false)
    assert.equal(isYmd('20260931'), false)
    assert.equal(isYmd('20261032'), false)
    assert.equal(isYmd('20261301'), false)
    assert.equal(isYmd('20261000'), false)
    assert.equal(isYmd('20260000'), false)
    assert.equal(isYmd('2026106'), false)
    assert.equal(isYmd('202610066'), false)
    assert.equal(isYmd('2026-10-06'), false)
    assert.equal(isYmd(' 20261006'), false)
    assert.equal(isYmd(20261006), false)
    assert.equal(isYmd(null), false)
    assert.equal(isYmd(undefined), false)
    assert.equal(isoToYmd('2026-10-06'), TUE_1006)
    assert.equal(isoToYmd('2027-02-29'), null)
    assert.equal(isoToYmd('20261006'), null)
  })
})

// ───────────────────────── 4. 시나리오 ─────────────────────────

describe('시나리오 — 기본 시간표 버전·이동수업·분반·학교 범위', () => {
  test('T21/R11 기본 시간표 변경 — 적용일(10/20) 전 과거 날짜는 이전 버전 유지, 적용일부터만 새 교시·교실', () => {
    const v2: LessonSeries = mkSeries({
      seriesId: 'ser-eng-b-tue-2-v2',
      courseId: ENG_B.courseId,
      weekday: 2,
      period: 2,
      roomId: ROOM_ENG.id,
      roomName: ROOM_ENG.name,
      validFrom: TUE_1020,
    })
    const PRE_A = ['1교시 생활과 과학 A @3학년 4반 교실', '3교시 영어 B @3학년 5반 교실']
    const POST_A = ['1교시 생활과 과학 A @3학년 4반 교실', '2교시 영어 B @영어전용실']

    // 이전 버전을 retired+validTo로 닫든 active+validTo로 닫든 결과는 같아야 함
    for (const status of ['retired', 'active'] as const) {
      const v1: LessonSeries = { ...SER_ENG_B_TUE_3, validTo: TUE_1020, status }
      const series = [...S1_SERIES.filter((s) => s.seriesId !== SER_ENG_B_TUE_3.seriesId), v1, v2]
      const a = (d: Ymd) => buildDayTimetable(mkInput(UID_A, d, { homerooms: HR_A, series }))

      assert.deepEqual(brief(a(TUE_1006)), PRE_A, `${status}: 과거`)
      assert.deepEqual(brief(a(TUE_1013)), PRE_A, `${status}: 적용 전날 주`)
      assert.deepEqual(brief(a(TUE_1020)), POST_A, `${status}: 적용일`)
      assert.deepEqual(brief(a(TUE_1027)), POST_A, `${status}: 이후`)

      const engPre = a(TUE_1013).lessons.filter((l) => l.courseId === ENG_B.courseId)
      const engPost = a(TUE_1020).lessons.filter((l) => l.courseId === ENG_B.courseId)
      assert.equal(engPre.length, 1)
      assert.equal(engPost.length, 1, '이전 버전과 새 버전이 같은 날 함께 나오지 않음')
      assert.equal(engPre[0].occurrenceId, 'ser-eng-b-tue-3@20261013')
      assert.equal(engPost[0].occurrenceId, 'ser-eng-b-tue-2-v2@20261020')
      // 기본 시간표 변경은 특정 날짜 임시 변경(override)과 구분 — 임시 변경 표시 없음
      assert.equal(engPost[0].change, null)
      assert.deepEqual(a(TUE_1020).orphanOverrides, [])

      // 같은 수업 수강생 B에게도 같은 기준, 영어 C 수강생 C는 영향 없음, 다른 요일(금) 차시도 그대로
      assert.deepEqual(brief(buildDayTimetable(mkInput(UID_B, TUE_1013, { homerooms: HR_B, series }))), ['3교시 영어 B @3학년 5반 교실'])
      assert.deepEqual(brief(buildDayTimetable(mkInput(UID_B, TUE_1020, { homerooms: HR_B, series }))), ['2교시 영어 B @영어전용실'])
      assert.deepEqual(brief(buildDayTimetable(mkInput(UID_C, TUE_1020, { homerooms: HR_C, series }))), ['3교시 영어 C @영어전용실'])
      assert.deepEqual(brief(a('20261023')), ['2교시 영어 B @어학실'])
    }
  })

  test('T13/R03/R04 이동수업 — 소속 3학년 4반 학생 A의 영어 B는 3학년 5반 교실로 표시되고 소속 학급과 무관', () => {
    const homerooms: HomeroomMembership[] = JSON.parse(JSON.stringify(HR_A))
    const t = buildDayTimetable(mkInput(UID_A, TUE_1006, { homerooms }))
    const eng = t.lessons.find((l) => l.courseId === ENG_B.courseId)
    assert.ok(eng, '영어 B 차시가 있어야 함')
    assert.equal(eng.roomName, '3학년 5반 교실')
    assert.deepEqual(eng.teacherNames, ['교사 Y'])
    assert.equal(eng.source, 'enrolled')
    assert.equal(eng.synced, true)
    assert.equal(eng.change, null)
    const sci = t.lessons.find((l) => l.courseId === SCI_A.courseId)
    assert.equal(sci?.roomName, '3학년 4반 교실')
    assert.deepEqual(homerooms, HR_A, '소속 학급 입력이 바뀌지 않음')

    // 소속 학급 정보가 아직 없어도(프로필 설정 전) 개별 수강 수업은 그대로
    assert.deepEqual(brief(buildDayTimetable(mkInput(UID_A, TUE_1006, { homerooms: [] }))), [
      '1교시 생활과 과학 A @3학년 4반 교실',
      '3교시 영어 B @3학년 5반 교실',
    ])
    // 차시별 교실이 수업 기본 장소보다 우선(금요일 어학실)
    assert.deepEqual(brief(buildDayTimetable(mkInput(UID_A, FRI_1009, { homerooms }))), ['2교시 영어 B @어학실'])
  })

  test('R05/R13 학생 B는 영어 B만 — 소속 학급 교실(3학년 5반)에서 열리는 수학 선택 C·같은 교사의 영어 C·생활과 과학 A는 표시되지 않음', () => {
    const b = (d: Ymd) => buildDayTimetable(mkInput(UID_B, d, { homerooms: HR_B }))
    assert.deepEqual(b(TUE_1006).activeCourseIds, [ENG_B.courseId])
    assert.deepEqual(brief(b(TUE_1006)), ['3교시 영어 B @3학년 5반 교실'])
    assert.deepEqual(brief(b(THU_1008)), [])
    assert.equal(b(THU_1008).state, 'no-lessons')
    assert.deepEqual(brief(b(FRI_1009)), ['2교시 영어 B @어학실'])
  })

  test('T33 같은 과목명(영어)의 다른 분반 B/C는 같은 교사·같은 교시여도 합쳐지지 않고, 한 분반의 변경이 다른 분반에 번지지 않음', () => {
    assert.deepEqual(brief(buildDayTimetable(mkInput(UID_A, TUE_1006, { homerooms: HR_A }))), [
      '1교시 생활과 과학 A @3학년 4반 교실',
      '3교시 영어 B @3학년 5반 교실',
    ])
    assert.deepEqual(brief(buildDayTimetable(mkInput(UID_C, TUE_1006, { homerooms: HR_C }))), ['3교시 영어 C @영어전용실'])

    // 영어 C만 10/6 3교시 → 2교시로 임시 이동
    const moveEngC: Override = {
      overrideId: 'ovr-eng-c-1',
      courseId: ENG_C.courseId,
      occurrenceKey: 'ser-eng-c-tue-3@20261006',
      changeSetId: 'cs-eng-c-1',
      kind: 'reschedule',
      seriesId: SER_ENG_C_TUE_3.seriesId,
      originalDate: TUE_1006,
      target: { date: TUE_1006, period: 2 },
      reason: '테스트용 교시 이동',
      revision: 1,
      status: 'published',
    }
    const a = buildDayTimetable(mkInput(UID_A, TUE_1006, { homerooms: HR_A, overrides: [moveEngC] }))
    const engB = a.lessons.find((l) => l.courseId === ENG_B.courseId)
    assert.equal(engB?.period, 3, '영어 B는 그대로')
    assert.equal(engB?.change, null)
    assert.equal(a.lessons.some((l) => l.courseId === ENG_C.courseId), false)
    assert.deepEqual(a.notices, [])
    const c = buildDayTimetable(mkInput(UID_C, TUE_1006, { homerooms: HR_C, overrides: [moveEngC] }))
    assert.deepEqual(brief(c), ['2교시 영어 C @영어전용실'])
    assert.deepEqual(c.lessons[0].change?.fields, ['time'])

    // 제목·과목·분반·교사 이름까지 같은 다른 수업 문서(중복 분반)도 courseId가 다르면 별개
    const ENG_B_DUP = mkCourse({ ...ENG_B, courseId: 'crs-77e2', defaultRoomId: ROOM_ENG.id, defaultRoomName: ROOM_ENG.name })
    const SER_DUP = mkSeries({ seriesId: 'ser-eng-b-dup-tue-3', courseId: ENG_B_DUP.courseId, weekday: 2, period: 3 })
    const withDup = buildDayTimetable(
      mkInput(UID_A, TUE_1006, { homerooms: HR_A, courses: [...S1_COURSES, ENG_B_DUP], series: [...S1_SERIES, SER_DUP] })
    )
    const engLessons = withDup.lessons.filter((l) => l.title === '영어 B')
    assert.equal(engLessons.length, 1)
    assert.equal(engLessons[0].courseId, ENG_B.courseId)
    assert.equal(engLessons[0].roomName, '3학년 5반 교실')
  })

  test('R16/T39/T33 다른 학교(S2)의 같은 이름 수업·교사·교실·학급·학생은 이름으로 연결되지 않음', () => {
    const courses = [...S1_COURSES, S2_ENG_B, S2_HR34_COMMON]
    const series = [...S1_SERIES, SER_S2_ENG_B_TUE_3, SER_S2_HR34_WED_7]
    const enrollments = [...S1_ENROLLMENTS, mkEnr(UID_S2_A, S2_ENG_B.courseId, { source: 'roster' })]
    const input = (d: Ymd) => mkInput(UID_A, d, { homerooms: HR_A, courses, series, enrollments })

    const r = resolveCourses(input(TUE_1006), TUE_1006)
    assert.deepEqual(activeIds(r), sorted([SCI_A.courseId, ENG_B.courseId]))
    const tue = buildDayTimetable(input(TUE_1006))
    assert.deepEqual(tue.lessons.map((l) => l.courseId), [SCI_A.courseId, ENG_B.courseId])
    // S2 '3학년 4반' 공통 수업은 S1 3학년 4반 학생 A와 무관(학급 id가 학교별로 다름)
    assert.deepEqual(brief(buildDayTimetable(input(WED_1007))), [])
  })

  test('R16/T39 학교·학기 범위 필터는 입력 단계(로더·권한) 책임 — 엔진은 schoolCode를 보지 않고 courseId 수강 관계만 따른다', () => {
    // 로더가 학교 조건 없이 조회해 S2 수강 행(uid가 A)이 섞여 들어온 상황을 가정
    const leaked = mkEnr(UID_A, S2_ENG_B.courseId, { source: 'roster' })
    const courses = [...S1_COURSES, S2_ENG_B]
    const series = [...S1_SERIES, SER_S2_ENG_B_TUE_3]
    const enrollments = [...S1_ENROLLMENTS, leaked]
    const raw = buildDayTimetable(mkInput(UID_A, TUE_1006, { homerooms: HR_A, courses, series, enrollments }))
    assert.ok(raw.activeCourseIds.includes(S2_ENG_B.courseId), '엔진 입력에는 학교 정보가 없어 걸러내지 못함 → 로더가 걸러야 함')

    // 로더가 학생의 학교(S1)로 수업·수강을 먼저 거르면 혼입 없음
    const s1Courses = courses.filter((c) => c.schoolCode === 'S1')
    const s1CourseIds = new Set(s1Courses.map((c) => c.courseId))
    const filtered = buildDayTimetable(
      mkInput(UID_A, TUE_1006, {
        homerooms: HR_A,
        courses: s1Courses,
        series: series.filter((s) => s1CourseIds.has(s.courseId)),
        enrollments: enrollments.filter((e) => s1CourseIds.has(e.courseId)),
      })
    )
    assert.deepEqual(sorted(filtered.activeCourseIds), sorted([SCI_A.courseId, ENG_B.courseId]))
    assert.deepEqual(brief(filtered), ['1교시 생활과 과학 A @3학년 4반 교실', '3교시 영어 B @3학년 5반 교실'])
  })
})
