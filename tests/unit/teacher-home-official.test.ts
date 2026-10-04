/**
 * 교사 '내 시간표' — 공식 수업에서 내 차시 찾기(computeTeacherOfficialDay) 단위 테스트
 *
 * 가상 데이터(실제 교사·학생 정보 아님)
 * - 교사 ME(uid tme, 이름 '이영어'), 교사 X(tx, '김과학'), 교사 Z(tz, '정대체')
 * - 영어 B(ME): 화3·목2 / 생활과 과학 A(X): 화4
 * - 영어 N: teacherUids 없이 이름만 '이영어'(엑셀 이름) — uid가 없으니 내 수업 아님
 * - 공동 수업 coT(ME·Z): 화6 차시는 Z 담당(차시 teacherUids), 수1 차시는 수업 담당(ME·Z)
 * - 공통 수업 국어(ME, 3학년 4반 공통): 수2
 * 날짜: 2026-10-06(화) TUE, 10-07(수) WED, 10-08(목) THU, 10-09(금) FRI, 10-13(화) NEXT_TUE, 10-14(수) NEXT_WED
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeTeacherOfficialDay,
  courseClassLabel,
  homeroomIdLabel,
  teacherHasOfficialOn,
  type TeacherOfficialInput,
} from '../../src/lib/timetable/teacherDay'
import type { Course, LessonSeries, Override, SlotState, Weekday, Ymd } from '../../src/lib/timetable/types'

const TUE: Ymd = '20261006'
const WED: Ymd = '20261007'
const THU: Ymd = '20261008'
const FRI: Ymd = '20261009'
const NEXT_TUE: Ymd = '20261013'
const NEXT_WED: Ymd = '20261014'
const TERM = { startDate: '20260816', endDate: '20270301' }
const ME = 'tme'

function course(courseId: string, title: string, teacherUids: string[], teacherNames: string[], extra: Partial<Course> = {}): Course {
  return {
    courseId,
    schoolCode: 'S1',
    termId: '2026-2',
    title,
    subject: title.split(' ')[0],
    teacherUids,
    teacherNames,
    status: 'active',
    endedOn: null,
    commonForHomerooms: [],
    defaultRoomName: `${title} 교실`,
    ...extra,
  }
}

function series(seriesId: string, courseId: string, weekday: Weekday, period: number, extra: Partial<LessonSeries> = {}): LessonSeries {
  return { seriesId, courseId, weekday, period, validFrom: TERM.startDate, validTo: null, status: 'active', ...extra }
}

let rev = 0
function ov(courseId: string, occurrenceKey: string, kind: Override['kind'], target: SlotState | null, extra: Partial<Override> = {}): Override {
  rev += 1
  const at = occurrenceKey.lastIndexOf('@')
  return {
    overrideId: `ov${rev}`,
    courseId,
    occurrenceKey,
    changeSetId: `cs${rev}`,
    kind,
    seriesId: at > 0 ? occurrenceKey.slice(0, at) : null,
    originalDate: at > 0 ? occurrenceKey.slice(at + 1) : null,
    target,
    reason: '학교 행사',
    revision: rev,
    status: 'published',
    publishedAt: Date.UTC(2026, 9, 5),
    ...extra,
  }
}

const COURSES: Course[] = [
  course('engB', '영어 B', [ME], ['이영어'], { section: 'B' }),
  course('sciA', '생활과 과학 A', ['tx'], ['김과학']),
  course('engN', '영어 N', [], ['이영어']), // 이름만 같은 수업(계정 연결 없음)
  course('coT', '공동 수업', [ME, 'tz'], ['이영어', '정대체']),
  course('kor', '국어', [ME], ['이영어'], { commonForHomerooms: ['S1_3_4'], managerUids: ['hr4'] }),
]
const SERIES: LessonSeries[] = [
  series('sr_engB_tue3', 'engB', 2, 3),
  series('sr_engB_thu2', 'engB', 4, 2),
  series('sr_sciA_tue4', 'sciA', 2, 4),
  series('sr_engN_tue5', 'engN', 2, 5),
  series('sr_coT_tue6', 'coT', 2, 6, { teacherUids: ['tz'], teacherNames: ['정대체'] }),
  series('sr_coT_wed1', 'coT', 3, 1),
  series('sr_kor_wed2', 'kor', 3, 2),
]
const OVERRIDES: Override[] = [
  // 내 영어 B 화3(TUE)을 Z에게 넘김
  ov('engB', `sr_engB_tue3@${TUE}`, 'reschedule', { date: TUE, period: 3, teacherUids: ['tz'], teacherNames: ['정대체'] }),
  // X의 생활과 과학 A 화4(TUE)를 나에게 넘김
  ov('sciA', `sr_sciA_tue4@${TUE}`, 'reschedule', { date: TUE, period: 4, teacherUids: [ME], teacherNames: ['이영어'] }),
  // 내 영어 B 목2(THU) 취소
  ov('engB', `sr_engB_thu2@${THU}`, 'cancel', null),
  // 영어 B 보강(FRI 1교시, 나)
  ov('engB', 'mk:m1-0', 'makeup', { date: FRI, period: 1, roomName: '어학실', teacherUids: [ME], teacherNames: ['이영어'] }, { seriesId: null, originalDate: null }),
  // 내 영어 B 화3(NEXT_TUE) → NEXT_WED 5교시로 이동
  ov('engB', `sr_engB_tue3@${NEXT_TUE}`, 'reschedule', { date: NEXT_WED, period: 5 }),
  // 생활과 과학 A 화4(NEXT_TUE)를 '이름만' 이영어로 바꿈(uid 없음) — 내 수업 아님
  ov('sciA', `sr_sciA_tue4@${NEXT_TUE}`, 'reschedule', { date: NEXT_TUE, period: 4, teacherUids: [], teacherNames: ['이영어'] }),
]

function dayOf(date: Ymd, patch: Partial<TeacherOfficialInput> = {}) {
  return computeTeacherOfficialDay({ uid: ME, date, term: TERM, offDay: null, courses: COURSES, series: SERIES, overrides: OVERRIDES, ...patch })
}

describe('uid로만 내 수업 판정', () => {
  test('교사 이름만 같은 수업(teacherUids 없음)은 내 수업이 아님', () => {
    const d = dayOf(TUE)
    assert.ok(!d.lessons.some((l) => l.courseId === 'engN'), JSON.stringify(d.lessons.map((l) => l.courseId)))
  })

  test('공동 수업에서 다른 교사가 맡은 차시(차시 teacherUids)는 내 차시가 아님, 수업 담당 차시는 내 차시', () => {
    assert.ok(!dayOf(TUE).lessons.some((l) => l.courseId === 'coT'))
    const wed = dayOf(WED)
    assert.deepEqual(
      wed.lessons.map((l) => [l.courseId, l.period, l.role]),
      [
        ['coT', 1, 'mine'],
        ['kor', 2, 'mine'],
      ]
    )
  })

  test('이름만 나로 바꾼 변경(uid 없음)은 대신 들어가는 수업이 아님', () => {
    const d = dayOf(NEXT_TUE)
    assert.ok(!d.lessons.some((l) => l.courseId === 'sciA'), JSON.stringify(d.lessons))
  })

  test('다른 교사 uid는 결과에 넣지 않음(이름만)', () => {
    const text = JSON.stringify([dayOf(TUE), dayOf(THU), dayOf(NEXT_TUE), dayOf(NEXT_WED)])
    assert.ok(!text.includes('"tz"') && !text.includes('"tx"') && !text.includes('teacherUids'), text.slice(0, 300))
    assert.ok(!text.includes('hr4'), '관리 교사 uid도 없음')
  })

  test('다른 uid(교사 Z)로 계산하면 Z의 차시만', () => {
    const z = computeTeacherOfficialDay({ uid: 'tz', date: TUE, term: TERM, offDay: null, courses: COURSES, series: SERIES, overrides: OVERRIDES })
    assert.deepEqual(
      z.lessons.map((l) => [l.courseId, l.period, l.role]),
      [
        ['engB', 3, 'substitute'],
        ['coT', 6, 'mine'],
      ]
    )
  })
})

describe('변경 반영', () => {
  test('내 차시를 다른 선생님에게 넘김 → changed-away(전후 교사 이름), 다른 수업을 나에게 → substitute', () => {
    const d = dayOf(TUE)
    const away = d.lessons.find((l) => l.courseId === 'engB')!
    assert.equal(away.role, 'changed-away')
    assert.deepEqual(away.change?.fields, ['teacher'])
    assert.deepEqual(away.change?.before?.teacherNames, ['이영어'])
    assert.deepEqual(away.change?.after.teacherNames, ['정대체'])
    const sub = d.lessons.find((l) => l.courseId === 'sciA')!
    assert.equal(sub.role, 'substitute')
    assert.equal(sub.period, 4)
    assert.ok(sub.change?.fields.includes('teacher'))
    assert.equal(sub.manageable, false, '남의 수업 — 수업 상세 링크 없음')
    assert.equal(away.manageable, true)
  })

  test('취소된 내 차시 → cancelled 안내(수업 목록에는 없음)', () => {
    const d = dayOf(THU)
    assert.equal(d.lessons.length, 0)
    assert.deepEqual(
      d.notices.map((n) => [n.kind, n.courseId, n.original.period, n.reason]),
      [['cancelled', 'engB', 2, '학교 행사']]
    )
    assert.equal(d.notices[0].section, 'B')
  })

  test('보강 → makeup(배지 보강), 교실 반영', () => {
    const d = dayOf(FRI)
    assert.deepEqual(
      d.lessons.map((l) => [l.key, l.role, l.period, l.roomName, l.change?.kind]),
      [['mk:m1-0', 'makeup', 1, '어학실', 'makeup']]
    )
  })

  test('다른 날로 옮긴 내 차시: 원래 날 moved-out 안내, 옮긴 날 날짜 변경 수업', () => {
    const t = dayOf(NEXT_TUE)
    assert.ok(!t.lessons.some((l) => l.courseId === 'engB'))
    assert.deepEqual(
      t.notices.map((n) => [n.kind, n.movedTo?.date, n.movedTo?.period]),
      [['moved-out', NEXT_WED, 5]]
    )
    const w = dayOf(NEXT_WED)
    const moved = w.lessons.find((l) => l.courseId === 'engB')!
    assert.equal(moved.role, 'mine')
    assert.equal(moved.period, 5)
    assert.ok(moved.change?.fields.includes('date'))
  })

  test('다른 교사 차시의 취소 안내는 넣지 않음', () => {
    const extra = ov('sciA', `sr_sciA_tue4@${'20261020'}`, 'cancel', null)
    const d = dayOf('20261020', { overrides: [...OVERRIDES, extra] })
    assert.ok(!d.notices.some((n) => n.courseId === 'sciA'))
    assert.deepEqual(d.lessons.map((l) => [l.courseId, l.period]), [['engB', 3]])
  })

  test('쉬는 날: 기본 차시는 holiday-suppressed 안내(내 차시만), 보강은 그대로', () => {
    const d = dayOf(TUE, { offDay: { name: '재량휴업일' } })
    // 변경(교사만 바꿈)은 '명시적 날짜·교시 변경'이 아니므로 쉬는 날에는 열리지 않음
    assert.equal(d.lessons.length, 0)
    assert.deepEqual(d.notices.map((n) => [n.kind, n.courseId]), [['holiday-suppressed', 'engB']])
    const f = dayOf(FRI, { offDay: { name: '개교기념일' } })
    assert.deepEqual(f.lessons.map((l) => l.role), ['makeup'])
  })

  test('공통 수업은 학급 표시', () => {
    const k = dayOf(WED).lessons.find((l) => l.courseId === 'kor')!
    assert.equal(k.classLabel, '3학년 4반')
    assert.equal(homeroomIdLabel('S1_3_4'), '3학년 4반')
    assert.equal(homeroomIdLabel('S1_3_5_g_engb'), null)
    assert.equal(courseClassLabel({ commonForHomerooms: ['S1_1_2', 'S1_1_3', 'S1_1_2'] }), '1학년 2반, 1학년 3반')
  })
})

describe('공식 시간표 방식 판정(teacherHasOfficialOn)', () => {
  test('내가 담당인 반복 차시가 그 날짜 학기에 있으면 true(주말·수업 없는 날도)', () => {
    assert.equal(dayOf('20261010').hasOfficial, true, '토요일')
    assert.equal(dayOf(TUE).hasOfficial, true)
  })

  test('이름만 같은 수업·다른 교사 차시만 있으면 false', () => {
    const only = [COURSES[1], COURSES[2]]
    assert.equal(teacherHasOfficialOn(ME, TUE, TERM, only, SERIES), false)
  })

  test('대신 들어가는 수업만 있으면 공식 방식 아님(내 기본 시간표가 없음)', () => {
    const d = computeTeacherOfficialDay({ uid: ME, date: TUE, term: TERM, offDay: null, courses: [COURSES[1]], series: SERIES, overrides: OVERRIDES })
    assert.equal(d.hasOfficial, false)
    assert.deepEqual(d.lessons.map((l) => l.role), ['substitute'])
  })

  test('지난 학기 차시(학기로 잘린 기간)·끝난 수업·삭제된 차시는 세지 않음', () => {
    const old = series('sr_old', 'engB', 2, 1, { validFrom: '20260301', validTo: '20260816' })
    assert.equal(teacherHasOfficialOn(ME, TUE, TERM, [COURSES[0]], [old]), false)
    const empty = series('sr_empty', 'engB', 2, 1, { validFrom: '20270301', validTo: '20270301' })
    assert.equal(teacherHasOfficialOn(ME, TUE, TERM, [COURSES[0]], [empty]), false)
    const ended = { ...COURSES[0], endedOn: '20261001' }
    assert.equal(teacherHasOfficialOn(ME, TUE, TERM, [ended], [SERIES[0]]), false)
    const deleted = { ...SERIES[0], status: 'retired' as const, validTo: null }
    assert.equal(teacherHasOfficialOn(ME, TUE, TERM, [COURSES[0]], [deleted]), false)
    // 학기 중 나중에 시작하는 차시도 '이 학기 시간표'로 봄
    const later = series('sr_later', 'engB', 2, 1, { validFrom: '20261201' })
    assert.equal(teacherHasOfficialOn(ME, TUE, TERM, [COURSES[0]], [later]), true)
  })
})
