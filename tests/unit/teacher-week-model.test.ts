/**
 * 교사 주간 시간표 모델(buildTeacherWeek) 단위 테스트 — 열·교시 행·칸·교시 밖·변경 표시·직접 등록·혼합 주·쉬는 날
 *
 * 가상 데이터(실제 교사·학생 정보 아님). 주: 2026-10-05(월) ~ 10-11(일)
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { computeTeacherOfficialDay, type MySchedule, type TeacherCover, type TeacherGradeOff, type TeacherOfficialDay, type TeacherTimetablePayload } from '../../src/lib/timetable/teacherDay'
import { buildTeacherWeek, weekCellKey, weekCellLabel, weekModelRangeLabel, type TeacherWeekModel } from '../../src/lib/timetable/teacherWeek'
import { addDays } from '../../src/lib/timetable/dates'
import type { Course, LessonSeries, Override, Ymd } from '../../src/lib/timetable/types'

const MON: Ymd = '20261005'
const TUE: Ymd = '20261006'
const WED: Ymd = '20261007'
const THU: Ymd = '20261008'
const FRI: Ymd = '20261009'
const SAT: Ymd = '20261010'
const SUN: Ymd = '20261011'
const ME = 'tme'
const TERM = { startDate: '20260816', endDate: '20270301' }
const TERMS = [{ termId: '2026-2', name: '2026학년도 2학기', ...TERM, isDefault: false }]
const PERIOD_TIMES = [1, 2, 3, 4, 5, 6, 7, 8].map((p) => ({ period: p, start: `${String(8 + p).padStart(2, '0')}:00`, end: `${String(8 + p).padStart(2, '0')}:50` }))

const course = (id: string, title: string, teacherUids: string[], teacherNames: string[], extra: Partial<Course> = {}): Course => ({
  courseId: id, schoolCode: 'S1', termId: '2026-2', title, subject: title.split(' ')[0], teacherUids, teacherNames, status: 'active', endedOn: null,
  commonForHomerooms: [], defaultRoomName: `${title} 교실`, managerUids: [], ...extra,
})
const series = (id: string, courseId: string, weekday: number, period: number, extra: Partial<LessonSeries> = {}): LessonSeries => ({
  seriesId: id, courseId, weekday: weekday as LessonSeries['weekday'], period, validFrom: '20260816', validTo: null, status: 'active', ...extra,
})
let rev = 0
const ov = (courseId: string, occurrenceKey: string, kind: Override['kind'], target: Override['target'], extra: Partial<Override> = {}): Override => {
  rev++
  const at = occurrenceKey.lastIndexOf('@')
  return {
    overrideId: `o${rev}`, courseId, occurrenceKey, changeSetId: `cs${rev}`, kind,
    seriesId: at > 0 ? occurrenceKey.slice(0, at) : null, originalDate: at > 0 ? occurrenceKey.slice(at + 1) : null,
    target, reason: '학교 행사', revision: rev, status: 'published', publishedAt: Date.UTC(2026, 9, 1), ...extra,
  }
}

const engB = course('engB', '영어 B', [ME], ['이영어'], { section: 'B' })
const sciA = course('sciA', '생활과 과학 A', ['tx'], ['김과학'])
const kor3 = course('kor3', '국어', [ME], ['이영어'], { commonForHomerooms: ['S1_3_4'] })
const club = course('club', '방과후 영어', [ME], ['이영어'])

interface WeekInput {
  courses?: Course[]
  series?: LessonSeries[]
  overrides?: Override[]
  offDays?: Record<Ymd, { name: string } | null>
  gradeOffDays?: Record<Ymd, TeacherGradeOff>
  mySchedule?: MySchedule | null
  covers?: TeacherCover[]
  /** 그 날 공식 결과를 직접 고침(교시 없는 수업 등 엔진이 만들지 않는 모양) */
  patchDay?: (date: Ymd, d: TeacherOfficialDay) => TeacherOfficialDay
  from?: Ymd
}

/** 서버(teacherData)처럼 날짜마다 computeTeacherOfficialDay로 days를 채운 응답 */
function weekPayload(input: WeekInput = {}): TeacherTimetablePayload {
  const from = input.from ?? MON
  const days: Record<Ymd, TeacherOfficialDay> = {}
  for (let i = 0; i < 7; i++) {
    const date = addDays(from, i)
    const offDay = input.offDays?.[date] ?? null
    let d = computeTeacherOfficialDay({
      uid: ME, date, term: TERM, offDay, gradeOff: offDay ? null : (input.gradeOffDays?.[date] ?? null), periodTimes: PERIOD_TIMES,
      courses: input.courses ?? [], series: input.series ?? [], overrides: input.overrides ?? [],
    })
    if (input.patchDay) d = input.patchDay(date, d)
    days[date] = d
  }
  return {
    revision: 1, generatedAt: 0, schoolCode: 'S1', from, to: addDays(from, 6), terms: TERMS,
    offDays: input.offDays ?? {}, gradeOffDays: input.gradeOffDays ?? {}, calendarErrors: [], periodTimes: PERIOD_TIMES,
    days, mySchedule: input.mySchedule ?? null, covers: input.covers ?? [],
  }
}

const cellTitles = (m: TeacherWeekModel, date: Ymd, period: number) => (m.cells[weekCellKey(date, period)] ?? []).map((i) => i.title)
const colDates = (m: TeacherWeekModel) => m.columns.map((c) => c.date)

const BASE_SERIES = [series('sr_engB_tue3', 'engB', 2, 3), series('sr_engB_wed2', 'engB', 3, 2), series('sr_sciA_tue4', 'sciA', 2, 4)]

const LEGACY: MySchedule = {
  mon: ['1-5 국어', '', '3-2 국어', '', '', '', ''],
  tue: ['', '2-1 문학', '', '', '', '', ''],
  wed: ['', '', '', '', '', '', '동아리'],
  thu: ['', '', '', '', '', '', ''],
  fri: ['', '', '', '', '', '', ''],
}

const cover = (c: Partial<TeacherCover>): TeacherCover => ({
  id: 'sos:x', kind: 'sos', direction: 'covering', date: TUE, period: 1, subject: '', requesterClass: '2학년 1반', otherName: '박주간', ...c,
})

describe('열: 월요일 시작, 토·일은 일정이 있을 때만', () => {
  test('주 안 어느 날을 줘도 같은 주(일요일 포함) — 월~금 5열', () => {
    const p = weekPayload({ courses: [engB, sciA], series: BASE_SERIES })
    for (const d of [MON, WED, SUN]) {
      const m = buildTeacherWeek(p, d)
      assert.equal(m.start, MON)
      assert.equal(m.end, SUN)
      assert.deepEqual(colDates(m), [MON, TUE, WED, THU, FRI])
    }
    const m = buildTeacherWeek(p, SUN)
    assert.deepEqual(m.columns.map((c) => `${c.dayLabel} ${c.dateLabel}`), ['월 10/5', '화 10/6', '수 10/7', '목 10/8', '금 10/9'])
    assert.equal(weekModelRangeLabel(m), '10월 5일 ~ 10월 9일')
  })

  test('토요일 수업이 있으면 토 열만, 일요일 보결이 있으면 일 열도', () => {
    const p = weekPayload({ courses: [engB, club], series: [...BASE_SERIES.slice(0, 2), series('sr_club_sat2', 'club', 6, 2)] })
    const m = buildTeacherWeek(p, MON)
    assert.deepEqual(colDates(m), [MON, TUE, WED, THU, FRI, SAT])
    assert.deepEqual(cellTitles(m, SAT, 2), ['방과후 영어'])
    assert.equal(weekModelRangeLabel(m), '10월 5일 ~ 10월 10일')
    const withSun = buildTeacherWeek({ ...p, covers: [cover({ id: 'sos:sun', date: SUN, period: 1 })] }, MON)
    assert.deepEqual(colDates(withSun), [MON, TUE, WED, THU, FRI, SAT, SUN])
    assert.deepEqual(withSun.cells[weekCellKey(SUN, 1)].map((i) => [i.kind, i.title, i.badges.map((b) => b.label)]), [['covering', '보결 수업', ['대신']]])
  })

  test('달이 바뀌는 주(9/28~10/4): 날짜·요일 그대로, 수업은 그 날짜에', () => {
    const p = weekPayload({ from: '20260928', courses: [engB], series: [series('sr_engB_tue3', 'engB', 2, 3), series('sr_engB_thu2', 'engB', 4, 2)] })
    const m = buildTeacherWeek(p, '20261001')
    assert.equal(m.start, '20260928')
    assert.deepEqual(m.columns.map((c) => c.dateLabel), ['9/28', '9/29', '9/30', '10/1', '10/2'])
    assert.deepEqual(cellTitles(m, '20260929', 3), ['영어 B'])
    assert.deepEqual(cellTitles(m, '20261001', 2), ['영어 B'])
    assert.equal(weekModelRangeLabel(m), '9월 28일 ~ 10월 2일')
  })

  test('해가 바뀌는 주(12/28~1/3): 1월 1일 쉬는 날 열, 라벨에 연도', () => {
    const p = weekPayload({ from: '20261228', courses: [engB], series: [series('sr_engB_tue3', 'engB', 2, 3), series('sr_engB_fri1', 'engB', 5, 1)], offDays: { '20270101': { name: '신정' } } })
    const m = buildTeacherWeek(p, '20270103')
    assert.equal(m.start, '20261228')
    assert.equal(m.end, '20270103')
    assert.deepEqual(colDates(m), ['20261228', '20261229', '20261230', '20261231', '20270101'])
    assert.deepEqual(cellTitles(m, '20261229', 3), ['영어 B'])
    const jan1 = m.columns[4]
    assert.equal(jan1.closed, 'holiday')
    assert.equal(jan1.view.offDayName, '신정')
    assert.equal(m.cells[weekCellKey('20270101', 1)], undefined, '쉬는 날 열은 칸을 만들지 않음')
    assert.equal(weekModelRangeLabel(m), '2026년 12월 28일 ~ 2027년 1월 1일')
  })
})

describe('교시 행·칸', () => {
  test('공식 수업만: 1 ~ 있는 교시 최대, 최소 6', () => {
    const p = weekPayload({ courses: [engB, sciA], series: BASE_SERIES })
    assert.deepEqual(buildTeacherWeek(p, MON).periods, [1, 2, 3, 4, 5, 6])
    const late = weekPayload({ courses: [engB], series: [series('sr_engB_thu8', 'engB', 4, 8)] })
    assert.deepEqual(buildTeacherWeek(late, MON).periods, [1, 2, 3, 4, 5, 6, 7, 8])
  })

  test('한 칸에 여러 수업 — 모두 보임', () => {
    const p = weekPayload({ courses: [engB, club], series: [series('sr_engB_tue3', 'engB', 2, 3), series('sr_club_tue3', 'club', 2, 3)] })
    const m = buildTeacherWeek(p, MON)
    assert.deepEqual(cellTitles(m, TUE, 3).sort(), ['방과후 영어', '영어 B'])
    const label = weekCellLabel(m.columns[1], 3, m.cells[weekCellKey(TUE, 3)])
    assert.match(label, /^화 3교시 /)
    assert.ok(label.includes('영어 B') && label.includes('방과후 영어'), label)
  })

  test('교시 없는(명시 시각만) 수업·0교시 보결은 교시 밖 줄 — 빠뜨리지 않음', () => {
    const p = weekPayload({
      courses: [engB],
      series: [series('sr_engB_tue3', 'engB', 2, 3)],
      covers: [cover({ id: 'sos:zero', date: WED, period: 0, subject: '1-2 자습' })],
      patchDay: (date, d) =>
        date === THU
          ? {
              ...d,
              lessons: d.lessons.concat({
                key: 'x-free', occurrenceId: 'x-free', courseId: 'engB', title: '영어 B 보충', period: null, start: '16:30', end: '17:20', roomName: '어학실',
                teacherNames: ['이영어'], source: 'enrolled', synced: true, change: null, role: 'mine', classLabel: null, manageable: true,
              }),
            }
          : d,
    })
    const m = buildTeacherWeek(p, MON)
    assert.equal(m.hasOutside, true)
    assert.deepEqual(m.outside[THU].map((i) => [i.title, i.period, i.roomName]), [['영어 B 보충', null, '어학실']])
    assert.deepEqual(m.outside[WED].map((i) => [i.kind, i.title, i.classLabel]), [['covering', '자습', '1학년 2반']])
    assert.equal(m.itemCount, 3)
    assert.equal(weekCellLabel(m.columns[3], null, m.outside[THU]).startsWith('목 교시 밖 영어 B 보충'), true)
  })
})

describe('변경 표시(하루 보기·학생 화면과 같은 기준)', () => {
  const COURSES = [engB, sciA]

  test('교실 변경: 빨강 + 변경 배지 + 이름에 전체 문구, 수업 상세 링크', () => {
    const p = weekPayload({ courses: COURSES, series: BASE_SERIES, overrides: [ov('engB', `sr_engB_tue3@${TUE}`, 'reschedule', { date: TUE, period: 3, roomName: '시청각실' })] })
    const [it] = buildTeacherWeek(p, MON).cells[weekCellKey(TUE, 3)]
    assert.equal(it.red, true)
    assert.deepEqual(it.badges.map((b) => b.label), ['변경'])
    assert.equal(it.roomName, '시청각실')
    assert.equal(it.label, '영어 B 시청각실 (교실 변경)')
    assert.equal(it.href, '/teacher/courses/engB')
  })

  test('취소: 취소선·취소 배지, 원래 칸에 그대로', () => {
    const p = weekPayload({ courses: COURSES, series: BASE_SERIES, overrides: [ov('engB', `sr_engB_wed2@${WED}`, 'cancel', null)] })
    const [it] = buildTeacherWeek(p, MON).cells[weekCellKey(WED, 2)]
    assert.equal(it.kind, 'cancelled')
    assert.equal(it.struck, true)
    assert.equal(it.red, true)
    assert.deepEqual(it.badges.map((b) => b.label), ['취소'])
  })

  test("대신 들어가는 수업(substitute): 빨간 '대신', 남의 수업이라 링크 없음", () => {
    const p = weekPayload({ courses: COURSES, series: BASE_SERIES, overrides: [ov('sciA', `sr_sciA_tue4@${TUE}`, 'reschedule', { date: TUE, period: 4, teacherUids: [ME], teacherNames: ['이영어'] })] })
    const [it] = buildTeacherWeek(p, MON).cells[weekCellKey(TUE, 4)]
    assert.equal(it.title, '생활과 과학 A')
    assert.equal(it.row?.role, 'substitute')
    assert.deepEqual(it.badges.map((b) => [b.label, b.tone]), [['대신', 'red']])
    assert.equal(it.href, null)
    assert.ok(it.label.includes('대신 들어가는 수업'))
    assert.ok(!it.label.includes('교사 변경'), '담당 변경은 대신 들어가는 수업 문구가 이미 말함')
  })

  test('대신 들어가는 수업이 교실도 바뀜: 이름에 교실 변경까지(하루 보기 LessonCard 배지와 같은 내용), 칸 배지는 대신 하나', () => {
    const p = weekPayload({
      courses: COURSES,
      series: BASE_SERIES,
      overrides: [ov('sciA', `sr_sciA_tue4@${TUE}`, 'reschedule', { date: TUE, period: 4, roomName: '어학실', teacherUids: [ME], teacherNames: ['이영어'] })],
    })
    const [it] = buildTeacherWeek(p, MON).cells[weekCellKey(TUE, 4)]
    assert.equal(it.row?.role, 'substitute')
    assert.deepEqual(it.badges.map((b) => b.label), ['대신'])
    assert.equal(it.label, '생활과 과학 A 어학실 (대신 들어가는 수업, 교실 변경)')
    // 다른 선생님이 맡고 교실도 바뀜: 누가 맡는지 + 교실 변경
    const away = weekPayload({
      courses: COURSES,
      series: BASE_SERIES,
      overrides: [ov('engB', `sr_engB_tue3@${TUE}`, 'reschedule', { date: TUE, period: 3, roomName: '시청각실', teacherUids: ['tz'], teacherNames: ['정대체'] })],
    })
    const [a] = buildTeacherWeek(away, MON).cells[weekCellKey(TUE, 3)]
    assert.equal(a.row?.role, 'changed-away')
    assert.equal(a.label, '영어 B 시청각실 (정대체 선생님이 맡아요, 교실 변경)')
  })

  test('다른 선생님이 맡음(changed-away): 누가 맡는지', () => {
    const p = weekPayload({ courses: COURSES, series: BASE_SERIES, overrides: [ov('engB', `sr_engB_tue3@${TUE}`, 'reschedule', { date: TUE, period: 3, teacherUids: ['tz'], teacherNames: ['정대체'] })] })
    const [it] = buildTeacherWeek(p, MON).cells[weekCellKey(TUE, 3)]
    assert.equal(it.row?.role, 'changed-away')
    assert.deepEqual(it.badges.map((b) => b.label), ['→정대체'])
    assert.ok(it.label.includes('정대체 선생님이 맡아요'), it.label)
  })

  test('보강: 그 날 그 교시 칸에 보강 배지', () => {
    const p = weekPayload({
      courses: COURSES,
      series: BASE_SERIES,
      overrides: [ov('engB', 'mk:m1-0', 'makeup', { date: THU, period: 6, roomName: '어학실', teacherUids: [ME], teacherNames: ['이영어'] }, { seriesId: null, originalDate: null })],
    })
    const [it] = buildTeacherWeek(p, MON).cells[weekCellKey(THU, 6)]
    assert.equal(it.row?.role, 'makeup')
    assert.deepEqual(it.badges.map((b) => b.label), ['보강'])
    assert.equal(it.red, true)
  })

  test('주 안에서 다른 날로 옮김: 새 날 칸에 수업(날짜 변경), 원래 칸에 옮겨 감 안내', () => {
    const p = weekPayload({ courses: COURSES, series: BASE_SERIES, overrides: [ov('engB', `sr_engB_tue3@${TUE}`, 'reschedule', { date: THU, period: 5 })] })
    const m = buildTeacherWeek(p, MON)
    const [moved] = m.cells[weekCellKey(THU, 5)]
    assert.equal(moved.title, '영어 B')
    assert.ok(moved.label.includes('날짜 변경'), moved.label)
    assert.deepEqual(moved.badges.map((b) => b.label), ['변경'])
    const old = m.cells[weekCellKey(TUE, 3)]
    assert.deepEqual(old.map((i) => [i.kind, i.note, i.badges.map((b) => b.label), i.red]), [['moved-out', '→ 목 5교시', ['옮김'], true]])
    assert.ok(old[0].label.includes('10월 8일(목) 5교시로 옮겨졌어요'), old[0].label)
    // 다른 주로 옮기면 원래 칸 안내에 날짜까지
    const p2 = weekPayload({ courses: COURSES, series: BASE_SERIES, overrides: [ov('engB', `sr_engB_tue3@${TUE}`, 'reschedule', { date: '20261014', period: 2 })] })
    assert.equal(buildTeacherWeek(p2, MON).cells[weekCellKey(TUE, 3)][0].note, '→ 10/14(수) 2교시')
  })

  test('예전 교환·보결 겹치기: 내가 맡음(대신 — 과목 없는 보결은 제목 보결 수업, 교환 칸 과목이 있으면 그 과목 + 품앗이), 내 교시를 남이 맡음(→이름)', () => {
    const p = weekPayload({
      courses: COURSES,
      series: BASE_SERIES,
      covers: [
        cover({ id: 'sos:in', date: MON, period: 2 }),
        cover({ id: 'swap:in', kind: 'swap', date: THU, period: 3, subject: '1-5 국어', requesterClass: '3학년 2반', otherName: '김동료' }),
        cover({ id: 'swap:out', kind: 'swap', direction: 'covered', date: WED, period: 2, subject: '', otherName: '김동료' }),
      ],
    })
    const m = buildTeacherWeek(p, MON)
    const [inn] = m.cells[weekCellKey(MON, 2)]
    assert.deepEqual([inn.kind, inn.title, inn.classLabel, inn.badges.map((b) => b.label), inn.red], ['covering', '보결 수업', '2학년 1반', ['대신'], true])
    assert.equal(inn.label, '대신 들어가는 수업 · 2학년 1반 (박주간 선생님) (보결)')
    const [sw] = m.cells[weekCellKey(THU, 3)]
    assert.deepEqual([sw.title, sw.classLabel, sw.badges.map((b) => b.label)], ['국어', '1학년 5반', ['대신', '품앗이']])
    const [wed] = m.cells[weekCellKey(WED, 2)]
    assert.equal(wed.title, '영어 B')
    assert.deepEqual(wed.badges.map((b) => b.label), ['→김동료'])
    assert.ok(wed.label.includes('김동료 선생님이 대신 들어가요 (품앗이)'), wed.label)
  })
})

describe('직접 등록 주간 시간표·혼합 주', () => {
  test('공식 수업 없음 → 주간 시간표 칸(7교시), 직접 등록 표시', () => {
    const m = buildTeacherWeek(weekPayload({ mySchedule: LEGACY }), MON)
    assert.equal(m.mode, 'legacy')
    assert.equal(m.state, 'grid')
    assert.deepEqual(m.periods, [1, 2, 3, 4, 5, 6, 7])
    const [a] = m.cells[weekCellKey(MON, 1)]
    assert.deepEqual([a.kind, a.title, a.classLabel, a.legacy], ['legacy', '국어', '1학년 5반', true])
    assert.ok(a.label.endsWith('(직접 등록 · 수업 변경 미반영)'), a.label)
    assert.deepEqual(cellTitles(m, TUE, 2), ['문학'])
    assert.deepEqual(cellTitles(m, WED, 7), ['동아리'])
    assert.equal(m.columns.some((c) => c.legacyTag), false, '모두 직접 등록이면 열마다 표시하지 않음(위 안내 한 줄)')
  })

  test('공식 수업이 수요일부터: 월·화는 직접 등록, 수~금은 공식 — 날짜마다 같은 규칙, 열 표시', () => {
    const p = weekPayload({ courses: [engB], series: [series('sr_engB_wed2', 'engB', 3, 2, { validFrom: WED }), series('sr_engB_thu4', 'engB', 4, 4, { validFrom: WED })], mySchedule: LEGACY })
    const m = buildTeacherWeek(p, MON)
    assert.equal(m.mode, 'mixed')
    assert.deepEqual(m.columns.map((c) => [c.dayLabel, c.source, c.legacyTag]), [
      ['월', 'legacy', true],
      ['화', 'legacy', true],
      ['수', 'official', false],
      ['목', 'official', false],
      ['금', 'official', false],
    ])
    assert.deepEqual(cellTitles(m, MON, 3), ['국어'])
    assert.deepEqual(cellTitles(m, WED, 2), ['영어 B'])
    assert.deepEqual(cellTitles(m, WED, 7), [], '공식 날에는 주간 시간표 칸(수 7교시 동아리)을 보이지 않음')
    assert.deepEqual(m.periods, [1, 2, 3, 4, 5, 6, 7], '직접 등록 열이 있으면 7교시까지')
  })

  test('공식 주의 토·일 보결 열은 그 날 방식이 직접 등록이어도 혼합 주가 아님(주간 시간표 칸은 월~금만)', () => {
    // 공식 차시가 금요일까지(validTo 토, 끝 제외) → 토·일은 공식 수업 없음 + 주간 시간표 있음 = 그 날 방식 legacy
    const p = weekPayload({
      courses: [engB],
      series: [series('sr_engB_tue3', 'engB', 2, 3, { validTo: SAT }), series('sr_engB_wed2', 'engB', 3, 2, { validTo: SAT })],
      mySchedule: LEGACY,
      covers: [cover({ id: 'sos:sun', date: SUN, period: 2 })],
    })
    const m = buildTeacherWeek(p, MON)
    const sun = m.columns[m.columns.length - 1]
    assert.equal(sun.date, SUN)
    assert.equal(sun.source, 'legacy', '하루 보기와 같은 그 날 규칙')
    assert.equal(m.mode, 'official')
    assert.equal(sun.legacyTag, false)
    assert.equal(m.columns.some((c) => c.legacyTag), false)
    assert.deepEqual(m.periods, [1, 2, 3, 4, 5, 6], '직접 등록 칸이 없으니 7교시 행을 억지로 만들지 않음')
    assert.deepEqual(m.cells[weekCellKey(SUN, 2)].map((i) => i.kind), ['covering'])
  })
})

describe('쉬는 날·빈 상태', () => {
  test('학교 전체 쉬는 날: 열 전체가 상태(이름), 그 날 수업은 칸에 없음 / 일정이 있으면 열고 이름 표시', () => {
    const p = weekPayload({ courses: [engB, sciA], series: [...BASE_SERIES, series('sr_engB_fri1', 'engB', 5, 1)], offDays: { [FRI]: { name: '한글날' } } })
    const m = buildTeacherWeek(p, MON)
    const fri = m.columns[4]
    assert.equal(fri.closed, 'holiday')
    assert.equal(fri.view.offDayName, '한글날')
    assert.equal(m.cells[weekCellKey(FRI, 1)], undefined)
    const withCover = buildTeacherWeek({ ...p, covers: [cover({ id: 'sos:h', date: FRI, period: 2 })] }, MON)
    assert.equal(withCover.columns[4].closed, null)
    assert.equal(withCover.columns[4].offDayName, '한글날')
    assert.deepEqual(withCover.cells[weekCellKey(FRI, 2)].map((i) => i.kind), ['covering'])
    assert.deepEqual(withCover.cells[weekCellKey(FRI, 1)].map((i) => [i.kind, i.muted, i.badges[0].label]), [['suppressed', true, '쉬는 날']])
  })

  test('학기 밖 날짜: 열 전체가 학기 밖', () => {
    const p = weekPayload({ courses: [engB], series: BASE_SERIES.slice(0, 1) })
    const m = buildTeacherWeek({ ...p, terms: [{ ...TERMS[0], endDate: WED }] }, MON)
    assert.deepEqual(m.columns.map((c) => c.closed), [null, null, 'outside-term', 'outside-term', 'outside-term'])
  })

  test('일부 학년만 쉬는 날: 열 머리 안내 + 그 학년 수업·주간 시간표 칸은 회색, 학년 모르는 수업은 그대로', () => {
    const p = weekPayload({
      courses: [engB, kor3],
      series: [series('sr_engB_wed2', 'engB', 3, 2), series('sr_kor3_wed3', 'kor3', 3, 3)],
      gradeOffDays: { [WED]: { name: '3학년 재량휴업일', grades: [3] } },
    })
    const m = buildTeacherWeek(p, MON)
    const wed = m.columns[2]
    assert.equal(wed.closed, null)
    assert.equal(wed.gradeOffNote, '3학년 쉬는 날(3학년 재량휴업일)')
    assert.equal(wed.gradeOffShort, '3학년 쉼')
    assert.equal(m.columns[1].gradeOffNote, null)
    assert.deepEqual(cellTitles(m, WED, 2), ['영어 B'])
    const [k] = m.cells[weekCellKey(WED, 3)]
    assert.deepEqual([k.kind, k.muted, k.classLabel, k.badges.map((b) => b.label)], ['suppressed', true, '3학년 4반', ['쉬는 날']])
    // 직접 등록 주간 시간표('3-2 국어' 월3)도 그 학년 쉬는 날에는 회색
    const legacy = buildTeacherWeek(weekPayload({ mySchedule: LEGACY, gradeOffDays: { [MON]: { name: '3학년 체험학습', grades: [3] } } }), MON)
    assert.deepEqual(legacy.cells[weekCellKey(MON, 3)].map((i) => [i.kind, i.legacy, i.muted]), [['suppressed', true, true]])
    assert.deepEqual(cellTitles(legacy, MON, 1), ['국어'], '1학년 칸은 그대로')
    assert.equal(legacy.columns[0].gradeOffNote, '3학년 쉬는 날(3학년 체험학습)')
  })

  test('공식 수업도 주간 시간표도 없음 → 빈 상태, 교환·보결만 있으면 표 + 빈 상태 안내', () => {
    const empty = buildTeacherWeek(weekPayload(), MON)
    assert.equal(empty.mode, 'empty')
    assert.equal(empty.state, 'empty')
    assert.equal(empty.itemCount, 0)
    const withCover = buildTeacherWeek(weekPayload({ covers: [cover({ id: 'sos:e', date: TUE, period: 1 })] }), MON)
    assert.equal(withCover.mode, 'empty')
    assert.equal(withCover.state, 'grid')
    assert.equal(withCover.itemCount, 1)
    // 모든 날이 쉬는 날이면 빈 상태 카드가 아니라 쉬는 날 열(하루 보기와 같은 순서: 쉬는 날이 먼저)
    const allOff: Record<Ymd, { name: string }> = {}
    for (const d of [MON, TUE, WED, THU, FRI]) allOff[d] = { name: '가을 방학' }
    const vacation = buildTeacherWeek(weekPayload({ offDays: allOff }), MON)
    assert.equal(vacation.state, 'grid')
    assert.deepEqual(vacation.columns.map((c) => c.closed), ['holiday', 'holiday', 'holiday', 'holiday', 'holiday'])
    assert.equal(vacation.noLessons, false, '쉬는 날 열이 상태를 말하므로 수업 없음 안내는 띄우지 않음')
  })

  test('모두 쉬는 주(방학): 직접 등록 교사도 직접 등록 안내 없이 쉬는 날 열만, 공식 교사는 official', () => {
    const allOff: Record<Ymd, { name: string }> = {}
    for (const d of [MON, TUE, WED, THU, FRI]) allOff[d] = { name: '가을 방학' }
    const legacy = buildTeacherWeek(weekPayload({ mySchedule: LEGACY, offDays: allOff }), MON)
    assert.deepEqual(legacy.columns.map((c) => [c.source, c.closed]), Array(5).fill(['legacy', 'holiday']))
    assert.notEqual(legacy.mode, 'legacy')
    assert.notEqual(legacy.mode, 'mixed')
    assert.deepEqual(legacy.periods, [1, 2, 3, 4, 5, 6])
    assert.equal(legacy.state, 'grid')
    const official = buildTeacherWeek(weekPayload({ courses: [engB], series: BASE_SERIES.slice(0, 2), mySchedule: LEGACY, offDays: allOff }), MON)
    assert.equal(official.mode, 'official')
  })

  test("시간표는 있는데 이 주에 수업이 하나도 없음 → noLessons('이 주에는 내 수업이 없어요'), 빈 상태 교사는 아님", () => {
    // 공식: 운영 중 차시는 있지만(공식 방식) 이 주 열린 날에 보일 수업이 없음
    const quiet = buildTeacherWeek(weekPayload({ courses: [engB], series: BASE_SERIES.slice(0, 2), patchDay: (_d, d) => ({ ...d, lessons: [], notices: [] }) }), MON)
    assert.equal(quiet.mode, 'official')
    assert.equal(quiet.state, 'grid')
    assert.equal(quiet.itemCount, 0)
    assert.equal(quiet.noLessons, true)
    // 직접 등록: 주간 시간표가 모두 빈 칸
    const blank: MySchedule = { mon: Array(7).fill(''), tue: Array(7).fill(''), wed: Array(7).fill(''), thu: Array(7).fill(''), fri: Array(7).fill('') }
    const legacy = buildTeacherWeek(weekPayload({ mySchedule: blank }), MON)
    assert.equal(legacy.mode, 'legacy')
    assert.equal(legacy.noLessons, true)
    // 수업이 있으면 아님, 아무것도 등록 안 한 교사는 빈 상태 카드(noLessons 아님)
    assert.equal(buildTeacherWeek(weekPayload({ courses: [engB], series: BASE_SERIES.slice(0, 2) }), MON).noLessons, false)
    const empty = buildTeacherWeek(weekPayload(), MON)
    assert.equal(empty.state, 'empty')
    assert.equal(empty.noLessons, false)
  })
})
