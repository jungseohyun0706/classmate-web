/**
 * 교사 '내 시간표' — 쉬는 날 판정 단위 테스트
 * 교사는 학생처럼 '내 학년' 하나로 쉬는 날을 정하지 않음(수업이 여러 학년에 걸침):
 * - 학교 전체 쉬는 날(학년 표시 없음, 또는 학교의 모든 학년) → offDays — 모든 수업이 열리지 않음
 * - 일부 학년만 쉬는 날(예: '3학년 재량휴업일') → gradeOffDays — 그 학년 수업(공통 수업 학급·주간 시간표 칸 '3-2 …')만 열리지 않음
 *
 * 가상 데이터(실제 교사·학생 정보 아님). 날짜: 2026-10-06(화) TUE, 10-07(수) WED, 10-08(목) THU
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isOffDayRow, offDayGradesOfRow, teacherOffDaysFromRows } from '../../src/lib/neisOffDays'
import {
  buildTeacherDay,
  computeTeacherOfficialDay,
  courseGrades,
  courseOffForGrades,
  gradesLabel,
  normalizeTeacherPayload,
  scheduleCellGrade,
  type MySchedule,
  type TeacherGradeOff,
  type TeacherTimetablePayload,
} from '../../src/lib/timetable/teacherDay'
import type { Course, LessonSeries, Override, Ymd } from '../../src/lib/timetable/types'

const TUE: Ymd = '20261006'
const WED: Ymd = '20261007'
const THU: Ymd = '20261008'
const ME = 'tme'
const TERM = { startDate: '20260816', endDate: '20270301' }
const PERIOD_TIMES = [1, 2, 3, 4, 5, 6, 7].map((p) => ({ period: p, start: `${String(8 + p).padStart(2, '0')}:00`, end: `${String(8 + p).padStart(2, '0')}:50` }))

type NeisRow = Record<string, string>

/** NEIS 학사일정 행(학년 표시: 1~6학년 'Y'/'N', 없으면 학년 표시 없음) */
function row(ymd: Ymd, name: string, flags: Array<'Y' | 'N'> | null, kind = '휴업일'): NeisRow {
  const r: NeisRow = { AA_YMD: ymd, EVENT_NM: name, SBTR_DD_SC_NM: kind }
  if (flags) ['ONE', 'TW', 'THREE', 'FR', 'FIV', 'SIX'].forEach((g, i) => (r[`${g}_GRADE_EVENT_YN`] = flags[i] ?? 'N'))
  return r
}
const G3_ONLY = row(TUE, '3학년 재량휴업일', ['N', 'N', 'Y', 'N', 'N', 'N'])

function course(courseId: string, title: string, extra: Partial<Course> = {}): Course {
  return {
    courseId, schoolCode: 'S1', termId: '2026-2', title, subject: title, teacherUids: [ME], teacherNames: ['이영어'],
    status: 'active', endedOn: null, commonForHomerooms: [], defaultRoomName: `${title} 교실`, ...extra,
  }
}
const kor3 = course('kor3', '국어', { commonForHomerooms: ['S1_3_4'] }) // 3학년 4반 공통 수업
const kor1 = course('kor1', '국어 1', { commonForHomerooms: ['S1_1_2'] }) // 1학년 2반 공통 수업
const engB = course('engB', '영어 B') // 선택 과목(학급 없음 — 학년 모름)
const COURSES = [kor3, kor1, engB]
const SERIES: LessonSeries[] = [
  { seriesId: 'sr_kor3', courseId: 'kor3', weekday: 2, period: 1, validFrom: TERM.startDate, validTo: null, status: 'active' },
  { seriesId: 'sr_kor1', courseId: 'kor1', weekday: 2, period: 2, validFrom: TERM.startDate, validTo: null, status: 'active' },
  { seriesId: 'sr_engB', courseId: 'engB', weekday: 2, period: 3, validFrom: TERM.startDate, validTo: null, status: 'active' },
]

function officialOn(date: Ymd, opts: { offDay?: { name: string } | null; gradeOff?: TeacherGradeOff | null; overrides?: Override[] } = {}) {
  return computeTeacherOfficialDay({
    uid: ME, date, term: TERM, offDay: opts.offDay ?? null, gradeOff: opts.gradeOff ?? null, periodTimes: PERIOD_TIMES,
    courses: COURSES, series: SERIES, overrides: opts.overrides ?? [],
  })
}

function payload(p: Partial<TeacherTimetablePayload>): TeacherTimetablePayload {
  return {
    revision: 1, generatedAt: 0, schoolCode: 'S1', from: TUE, to: THU,
    terms: [{ termId: '2026-2', name: '2학기', startDate: TERM.startDate, endDate: TERM.endDate, isDefault: false }],
    offDays: {}, gradeOffDays: {}, calendarErrors: [], periodTimes: PERIOD_TIMES, days: {}, mySchedule: null, covers: [], ...p,
  }
}

describe('NEIS 학사일정 행 → 쉬는 학년', () => {
  test('학년 표시 없음 → 학교 전체, 일부 학년 Y → 그 학년, 쉬는 날이 아니면 null', () => {
    assert.equal(offDayGradesOfRow(row(TUE, '개교기념일', null)), 'all')
    assert.deepEqual(offDayGradesOfRow(G3_ONLY), [3])
    assert.deepEqual(offDayGradesOfRow(row(TUE, '1·2학년 휴업', ['Y', 'Y', 'N', 'N', 'N', 'N'])), [1, 2])
    assert.equal(offDayGradesOfRow(row(TUE, '방학식', null, '해당없음')), null)
    assert.equal(offDayGradesOfRow(row(TUE, '체육대회', null, '해당없음')), null)
    assert.equal(offDayGradesOfRow(row(TUE, '여름방학', null, '해당없음')), 'all')
  })

  test('학생 규칙(isOffDayRow)은 그대로 — 학년을 모르면 학년별 행도 쉬는 날로 봄(그래서 교사에게 쓰지 않음)', () => {
    assert.equal(isOffDayRow(G3_ONLY, 3), true)
    assert.equal(isOffDayRow(G3_ONLY, 1), false)
    assert.equal(isOffDayRow(G3_ONLY), true)
  })
})

describe('교사용 날짜별 쉬는 날(teacherOffDaysFromRows)', () => {
  test("담임이 아닌(학년 없는) 교사: '3학년 재량휴업일'은 학교 전체 쉬는 날이 아님 → gradeOffDays", () => {
    const r = teacherOffDaysFromRows([G3_ONLY], [TUE, WED], 3)
    assert.deepEqual(r.offDays, { [TUE]: null, [WED]: null })
    assert.deepEqual(r.gradeOffDays, { [TUE]: { name: '3학년 재량휴업일', grades: [3] } })
  })

  test('학년 표시 없는 행 → 학교 전체', () => {
    const r = teacherOffDaysFromRows([row(WED, '개천절', null, '공휴일')], [TUE, WED], 3)
    assert.deepEqual(r.offDays, { [TUE]: null, [WED]: { name: '개천절' } })
    assert.deepEqual(r.gradeOffDays, {})
  })

  test('중·고(3개 학년): 1~3학년이 모두 Y면 학교 전체. 초(6개 학년)에서는 같은 행이 일부 학년', () => {
    const all3 = row(TUE, '재량휴업일', ['Y', 'Y', 'Y', 'N', 'N', 'N'])
    assert.deepEqual(teacherOffDaysFromRows([all3], [TUE], 3).offDays, { [TUE]: { name: '재량휴업일' } })
    const elem = teacherOffDaysFromRows([all3], [TUE], 6)
    assert.deepEqual(elem.offDays, { [TUE]: null })
    assert.deepEqual(elem.gradeOffDays[TUE].grades, [1, 2, 3])
  })

  test('같은 날 학년별 행 여러 개는 학년을 합침 — 모두 덮으면 학교 전체', () => {
    const rows = [row(TUE, '1학년 휴업', ['Y', 'N', 'N']), row(TUE, '2학년 휴업', ['N', 'Y', 'N'])]
    assert.deepEqual(teacherOffDaysFromRows(rows, [TUE], 3).gradeOffDays[TUE], { name: '1학년 휴업', grades: [1, 2] })
    const all = rows.concat(row(TUE, '3학년 휴업', ['N', 'N', 'Y']))
    assert.deepEqual(teacherOffDaysFromRows(all, [TUE], 3).offDays[TUE], { name: '1학년 휴업' })
  })
})

describe('공식 수업: 일부 학년 쉬는 날', () => {
  test('수업 학년: 공통 수업 학급 id에서(수업 그룹·선택 과목은 모름)', () => {
    assert.deepEqual(courseGrades(kor3), [3])
    assert.deepEqual(courseGrades({ commonForHomerooms: ['S1_1_2', 'S1_3_1', 'S1_g_ab12'] }), [1, 3])
    assert.deepEqual(courseGrades(engB), [])
    assert.equal(courseOffForGrades(kor3, [3]), true)
    assert.equal(courseOffForGrades({ commonForHomerooms: ['S1_1_2', 'S1_3_1'] }, [3]), false, '다른 학년도 듣는 수업은 열림')
    assert.equal(courseOffForGrades(engB, [3]), false, '학년을 모르면 열림')
    assert.equal(gradesLabel([3]), '3학년')
    assert.equal(gradesLabel([1, 2]), '1·2학년')
  })

  test("'3학년 재량휴업일': 3학년 수업만 열리지 않음(쉬는 날 안내), 1학년·학년 모르는 수업은 그대로", () => {
    const d = officialOn(TUE, { gradeOff: { name: '3학년 재량휴업일', grades: [3] } })
    assert.deepEqual(d.lessons.map((l) => [l.courseId, l.period, l.role]), [['kor1', 2, 'mine'], ['engB', 3, 'mine']])
    assert.deepEqual(d.notices.map((n) => [n.kind, n.courseId]), [['holiday-suppressed', 'kor3']])
    assert.equal(d.hasOfficial, true)
  })

  test('학교 전체 쉬는 날이면 학년과 상관없이 모두 열리지 않음(학년별 값은 무시)', () => {
    const d = officialOn(TUE, { offDay: { name: '개교기념일' }, gradeOff: { name: 'x', grades: [1] } })
    assert.deepEqual(d.lessons, [])
    assert.deepEqual(d.notices.map((n) => n.courseId).sort(), ['engB', 'kor1', 'kor3'])
  })

  test('쉬는 학년 수업이라도 날짜·교시를 명시적으로 옮긴 차시는 열림(학생 화면과 같은 규칙)', () => {
    const moved: Override = {
      overrideId: 'm1', courseId: 'kor3', occurrenceKey: `sr_kor3@${TUE}`, changeSetId: 'cs-m', kind: 'reschedule', seriesId: 'sr_kor3', originalDate: TUE,
      target: { date: TUE, period: 5 }, revision: 1, status: 'published',
    }
    const d = officialOn(TUE, { gradeOff: { name: '3학년 재량휴업일', grades: [3] }, overrides: [moved] })
    assert.deepEqual(d.lessons.map((l) => [l.courseId, l.period]), [['kor1', 2], ['engB', 3], ['kor3', 5]])
  })

  test('화면: 학교 전체가 아니라 holiday가 아님 — 열린 수업 + 학년 쉬는 날 안내', () => {
    const gradeOff = { name: '3학년 재량휴업일', grades: [3] }
    const v = buildTeacherDay(payload({ days: { [TUE]: officialOn(TUE, { gradeOff }) }, gradeOffDays: { [TUE]: gradeOff } }), TUE)
    assert.equal(v.state, 'lessons')
    assert.deepEqual(v.gradeOff, gradeOff)
    assert.equal(v.offDayName, null)
    assert.deepEqual(v.rows.map((r) => r.lesson.title), ['국어 1', '영어 B'])
    assert.deepEqual(v.suppressed.map((n) => n.courseId), ['kor3'])
  })
})

describe('직접 등록 주간 시간표: 일부 학년 쉬는 날', () => {
  const SCHEDULE: MySchedule = {
    mon: ['', '', '', '', '', '', ''],
    tue: ['3-2 국어', '1-5 국어', '동아리', '', '', '', ''],
    wed: ['3-1 국어', '', '', '', '', '', ''],
    thu: ['', '', '', '', '', '', ''],
    fri: ['', '', '', '', '', '', ''],
  }
  const empty = (date: Ymd) => computeTeacherOfficialDay({ uid: ME, date, term: TERM, offDay: null, courses: [], series: [], overrides: [] })

  test('칸 학년: 학반 라벨에서만', () => {
    assert.equal(scheduleCellGrade('3-2 국어'), 3)
    assert.equal(scheduleCellGrade('12-1'), 12)
    assert.equal(scheduleCellGrade('동아리'), null)
    assert.equal(scheduleCellGrade('3-2반 국어'), null)
  })

  test("'3학년 재량휴업일': 3학년 칸만 숨기고 안내(suppressedCells), 1학년·학년 모르는 칸은 그대로", () => {
    const gradeOff = { name: '3학년 재량휴업일', grades: [3] }
    const v = buildTeacherDay(payload({ days: { [TUE]: empty(TUE) }, gradeOffDays: { [TUE]: gradeOff }, mySchedule: SCHEDULE }), TUE)
    assert.equal(v.mode, 'legacy')
    assert.equal(v.state, 'lessons')
    assert.deepEqual(v.rows.map((r) => [r.lesson.period, r.lesson.title]), [[2, '국어'], [3, '동아리']])
    assert.deepEqual(v.suppressedCells, [{ period: 1, text: '3-2 국어' }])
  })

  test('그 날 칸이 모두 쉬는 학년이면 no-lessons(holiday 아님 — 학교는 열림)', () => {
    const gradeOff = { name: '3학년 재량휴업일', grades: [3] }
    const v = buildTeacherDay(payload({ days: { [WED]: empty(WED) }, gradeOffDays: { [WED]: gradeOff }, mySchedule: SCHEDULE }), WED)
    assert.equal(v.state, 'no-lessons')
    assert.deepEqual(v.rows, [])
    assert.deepEqual(v.suppressedCells, [{ period: 1, text: '3-1 국어' }])
  })

  test('쉬는 학년 교시의 covered 교환은 따로 행을 만들지 않음', () => {
    const gradeOff = { name: '3학년 재량휴업일', grades: [3] }
    const covers = [{ id: 'swap:g', kind: 'swap' as const, direction: 'covered' as const, date: WED, period: 4, subject: '3-1 국어', requesterClass: '', otherName: '김동료' }]
    const v = buildTeacherDay(payload({ days: { [WED]: empty(WED) }, gradeOffDays: { [WED]: gradeOff }, mySchedule: SCHEDULE, covers }), WED)
    assert.deepEqual(v.rows, [])
  })
})

describe('응답 정리: gradeOffDays', () => {
  test('잘못된 날짜 키·학년 값은 버리고 학년은 정렬', () => {
    const p = normalizeTeacherPayload({
      from: TUE, to: THU,
      gradeOffDays: { [TUE]: { name: '3학년 재량휴업일', grades: [3, '1', 9, 3] }, bad: { name: 'x', grades: [1] }, [WED]: { grades: [] } },
    })!
    assert.deepEqual(p.gradeOffDays, { [TUE]: { name: '3학년 재량휴업일', grades: [1, 3] } })
    assert.deepEqual(normalizeTeacherPayload({ from: TUE, to: THU })!.gradeOffDays, {})
  })
})
