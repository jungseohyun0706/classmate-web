/**
 * 학생 '수업 담기' — 공개 목록 정리·학년 거르기·시간표 칸 만들기 (순수 함수, 가상 데이터)
 *  - 대상 학년을 모르는 수업은 언제나 보임, 내 학년을 모르면 거르지 않음
 *  - 칸: 월~금 + 토·일은 차시가 있을 때만, 교시는 있는 것 중 가장 큰 교시까지(0교시는 있을 때만)
 *  - 칸에 이미 내 시간표에 있는 수업(참여·시작 예정·승인 대기·반 공통)이 표시됨
 *  - 수업별 내 상태(myCourseStates): 차시가 아직 없는 수업·끝낸(뺀) 수강도 포함 — 카드 상태·'빼기' 표시 기준
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPickerGrid,
  cellKey,
  cleanGrades,
  courseOfferFor,
  filterForStudent,
  myCourseStates,
  myLessonsFrom,
  normalizeCatalog,
  normalizeCatalogCourse,
  pickerTitle,
  studentGradeOf,
  type MyLesson,
  type PayloadLike,
  type PickerCourse,
} from '../../src/lib/timetable/coursePicker'
import type { Course, LessonSeries } from '../../src/lib/timetable/types'

const TODAY = '20261006' // 화

function pc(id: string, slots: Array<[number, number, string?]>, extra: Partial<PickerCourse> = {}): PickerCourse {
  return {
    courseId: id,
    title: id,
    subject: id,
    section: null,
    teacherNames: ['가선생'],
    defaultRoomName: null,
    invitePolicy: 'auto',
    slots: slots.map(([weekday, period, roomName]) => ({ weekday, period, roomName: roomName ?? null })),
    myStatus: null,
    grades: [],
    classLabels: [],
    offer: 'mine',
    ...extra,
  }
}

describe('공개 목록 정리(normalizeCatalog)', () => {
  test('대상 학년은 1~6 정수만, 중복 없이 오름차순 — 없으면 [](학년 미상)', () => {
    assert.deepEqual(cleanGrades([3, 1, 3, 7, 0, 2.5, '2', null]), [1, 3])
    assert.deepEqual(cleanGrades(undefined), [])
    const c = normalizeCatalogCourse({ courseId: 'c1', title: '영어 B', subject: '영어', section: 'B', teacherNames: ['이영어'], invitePolicy: 'approval', slots: [], myStatus: 'pending', grades: [3] })
    assert.deepEqual(c?.grades, [3])
    assert.equal(c?.invitePolicy, 'approval')
    assert.equal(c?.myStatus, 'pending')
    assert.deepEqual(normalizeCatalogCourse({ courseId: 'c2', title: '국어', slots: [] })?.grades, [])
  })

  test('차시: 요일 1~7·교시 정수만, 같은 요일·교시는 한 번, 교실이 없으면 기본 교실, 요일·교시 순', () => {
    const c = normalizeCatalogCourse({
      courseId: 'c1',
      title: '과학',
      defaultRoomName: '과학실',
      slots: [
        { weekday: 4, period: 2, roomName: null },
        { weekday: 2, period: 4, roomName: '실험실' },
        { weekday: 2, period: 4, roomName: '다른 곳' },
        { weekday: 9, period: 1 },
        { weekday: 1, period: 'x' },
      ],
    })
    assert.deepEqual(c?.slots, [
      { weekday: 2, period: 4, roomName: '실험실' },
      { weekday: 4, period: 2, roomName: '과학실' },
    ])
  })

  test('courses 배열이 없는 응답은 null(빈 목록으로 위장하지 않음), id 없는 수업은 버림', () => {
    assert.equal(normalizeCatalog({ term: null }), null)
    assert.equal(normalizeCatalog(null), null)
    const n = normalizeCatalog({ term: { termId: '2026-2', name: '2026학년도 2학기', startDate: '20260816', endDate: '20270301' }, courses: [{ title: 'id 없음' }, { courseId: 'ok', title: '수학' }] })
    assert.equal(n?.courses.length, 1)
    assert.equal(n?.term?.name, '2026학년도 2학기')
  })

  test('제목: 제목에 분반이 없으면 붙임', () => {
    assert.equal(pickerTitle({ title: '영어', section: 'B' }), '영어 · B')
    assert.equal(pickerTitle({ title: '영어 B', section: 'B' }), '영어 B')
    assert.equal(pickerTitle({ title: '국어', section: null }), '국어')
  })
})

describe('학년 거르기 — 대상 반이 없는 수업(courseOfferFor 학년 규칙 → filterForStudent)', () => {
  const g3 = pc('g3', [[1, 1]], { grades: [3] })
  const g12 = pc('g12', [[1, 2]], { grades: [1, 2] })
  const unknown = pc('unknown', [[1, 3]])
  const g23 = pc('g23', [[1, 4]], { grades: [2, 3] })
  const withOffer = (grade: number | null) => [g3, g12, unknown, g23].map((c) => ({ ...c, offer: courseOfferFor(c, { grade, classLabel: null }) as 'mine' | 'other' }))

  test('기본: 내 학년(3) 수업 + 학년 미상 수업은 언제나 보임', () => {
    const r = filterForStudent(withOffer(3), false)
    assert.deepEqual(r.shown.map((c) => c.courseId), ['g3', 'unknown', 'g23'])
    assert.equal(r.hidden, 1)
  })
  test('다른 반·학년 수업도 보기 → 전부', () => {
    const r = filterForStudent(withOffer(3), true)
    assert.equal(r.shown.length, 4)
    assert.equal(r.hidden, 0)
  })
  test('내 학년을 모르면 거르지 않음', () => {
    assert.equal(filterForStudent(withOffer(null), false).shown.length, 4)
  })
  test('학생 학년 값: 1~6 숫자·숫자 문자열만', () => {
    assert.equal(studentGradeOf(3), 3)
    assert.equal(studentGradeOf('2'), 2)
    assert.equal(studentGradeOf(' 1 '), 1)
    assert.equal(studentGradeOf('3학년'), null)
    assert.equal(studentGradeOf(0), null)
    assert.equal(studentGradeOf(7), null)
    assert.equal(studentGradeOf(null), null)
    assert.equal(studentGradeOf(undefined), null)
  })
})

describe('시간표 칸(buildPickerGrid)', () => {
  test('월~금, 교시는 1부터 있는 교시 중 가장 큰 교시까지 — 칸마다 그 시간 수업(제목 순)', () => {
    const g = buildPickerGrid([pc('물리', [[2, 5]]), pc('과학', [[2, 4], [4, 2]]), pc('가정', [[2, 4]])], [])
    assert.deepEqual(g.weekdays, [1, 2, 3, 4, 5])
    assert.deepEqual(g.periods, [1, 2, 3, 4, 5])
    assert.deepEqual(g.cells[cellKey(2, 4)].offered.map((c) => c.courseId), ['가정', '과학'])
    assert.deepEqual(g.cells[cellKey(4, 2)].offered.map((c) => c.courseId), ['과학'])
    assert.equal(g.cells[cellKey(1, 1)], undefined, '수업 없는 칸은 비어 있음')
  })

  test('토·일은 차시가 있을 때만(토 없이 일만 있으면 일만)', () => {
    assert.deepEqual(buildPickerGrid([pc('a', [[6, 1]])], []).weekdays, [1, 2, 3, 4, 5, 6])
    assert.deepEqual(buildPickerGrid([pc('a', [[7, 2]])], []).weekdays, [1, 2, 3, 4, 5, 7])
    assert.deepEqual(buildPickerGrid([pc('a', [[6, 1], [7, 1]])], []).weekdays, [1, 2, 3, 4, 5, 6, 7])
  })

  test('0교시는 있을 때만, 차시가 하나도 없으면 칸 없음', () => {
    assert.deepEqual(buildPickerGrid([pc('a', [[1, 0], [1, 2]])], []).periods, [0, 1, 2])
    assert.deepEqual(buildPickerGrid([pc('a', [])], []).periods, [])
    assert.deepEqual(buildPickerGrid([], []).periods, [])
  })

  test('내 수업(공개 목록에 없는 반 공통 수업 포함)도 칸에 들어가고 교시 범위를 넓힘', () => {
    const mine: MyLesson[] = [
      { courseId: 'lit', title: '문학', status: 'common', source: 'common', weekday: 2, period: 7, roomName: null, linkable: false },
      { courseId: 'eng', title: '영어 B', status: 'pending', source: 'request', weekday: 6, period: 1, roomName: null, linkable: false },
    ]
    const g = buildPickerGrid([pc('a', [[1, 3]])], mine)
    assert.deepEqual(g.periods, [1, 2, 3, 4, 5, 6, 7])
    assert.deepEqual(g.weekdays, [1, 2, 3, 4, 5, 6])
    assert.equal(g.cells[cellKey(2, 7)].mine[0].title, '문학')
    assert.equal(g.cells[cellKey(6, 1)].mine[0].status, 'pending')
  })
})

describe('이미 내 시간표에 있는 수업(myLessonsFrom)', () => {
  const course = (courseId: string, extra: Partial<Course> = {}): Course => ({
    courseId,
    schoolCode: 'S1',
    termId: '2026-2',
    title: courseId,
    subject: courseId,
    teacherUids: [],
    teacherNames: [],
    status: 'active',
    commonForHomerooms: [],
    ...extra,
  })
  const series = (seriesId: string, courseId: string, weekday: number, period: number, extra: Partial<LessonSeries> = {}): LessonSeries => ({
    seriesId,
    courseId,
    weekday: weekday as LessonSeries['weekday'],
    period,
    roomName: null,
    validFrom: '20260816',
    validTo: null,
    status: 'active',
    ...extra,
  })
  const payload: PayloadLike = {
    homerooms: [{ homeroomId: 'S1_3_4' }],
    courses: [
      course('lit', { commonForHomerooms: ['S1_3_4'], defaultRoomName: '3-4 교실' }),
      course('engB', { section: 'B', title: '영어' }),
      course('phys'),
      course('hist'),
      course('math'),
      course('old', { status: 'ended', endedOn: '20260901' }),
      course('other', { commonForHomerooms: ['S1_3_5'] }),
    ],
    series: [
      series('s1', 'lit', 2, 1),
      series('s2', 'engB', 2, 3, { roomName: '영어실' }),
      series('s3', 'phys', 2, 5),
      series('s4', 'hist', 1, 5),
      series('s5', 'math', 1, 2),
      series('s6', 'old', 3, 3),
      series('s7', 'other', 4, 4),
      series('s8', 'engB', 4, 4, { validTo: '20261001' }), // 이미 끝난 차시
    ],
    enrollments: [
      { courseId: 'engB', uid: 'me', status: 'active', source: 'request', from: '20261001' },
      { courseId: 'phys', uid: 'me', status: 'pending', source: 'request' },
      { courseId: 'hist', uid: 'me', status: 'active', source: 'invite', from: '20261012' }, // 시작 예정
      { courseId: 'math', uid: 'me', status: 'ended', source: 'roster', from: '20260901', to: '20260915' },
      { courseId: 'old', uid: 'me', status: 'active', source: 'invite' },
      { courseId: 'lit', uid: 'someone', status: 'active', source: 'invite' },
    ],
  }

  test('참여·시작 예정·승인 대기·반 공통 — 끝난 수강·끝난 수업·다른 반 공통 수업은 빼고, 끝난 차시도 뺌', () => {
    const m = myLessonsFrom(payload, 'me', TODAY)
    const brief = m.map((x) => `${x.courseId}:${x.status}:${x.source}:${x.weekday}-${x.period}`)
    assert.deepEqual(brief, ['hist:upcoming:invite:1-5', 'lit:common:common:2-1', 'engB:active:request:2-3', 'phys:pending:request:2-5'])
    assert.equal(m.find((x) => x.courseId === 'engB')?.title, '영어 · B')
    assert.equal(m.find((x) => x.courseId === 'engB')?.roomName, '영어실')
    assert.equal(m.find((x) => x.courseId === 'lit')?.roomName, '3-4 교실', '차시 교실이 없으면 수업 기본 교실')
  })

  test('연결 가능(linkable)은 오늘 활성 수강만 — 시작 예정·승인 대기·반 공통은 아님', () => {
    const m = myLessonsFrom(payload, 'me', TODAY)
    assert.deepEqual(
      m.filter((x) => x.linkable).map((x) => x.courseId),
      ['engB']
    )
  })

  test('다른 학생의 수강은 내 것으로 보지 않음', () => {
    assert.deepEqual(myLessonsFrom(payload, 'someone', TODAY).map((x) => x.courseId), ['lit'])
  })

  describe('수업별 내 상태(myCourseStates)', () => {
    // 차시가 아직 없는 수업(slotless)에 담은 수강·승인 대기, 오늘 뺀 수강(to=오늘), 끝낸 뒤 반 공통으로 다시 내 것인 수업
    const p2: PayloadLike = {
      ...payload,
      courses: payload.courses.concat([course('noSlot'), course('noSlotP'), course('leftToday'), course('lit2', { commonForHomerooms: ['S1_3_4'] })]),
      enrollments: payload.enrollments.concat([
        { courseId: 'noSlot', uid: 'me', status: 'active', source: 'request', from: '20261002' },
        { courseId: 'noSlotP', uid: 'me', status: 'pending', source: 'request' },
        { courseId: 'leftToday', uid: 'me', status: 'ended', source: 'request', from: '20261001', to: TODAY },
        { courseId: 'lit2', uid: 'me', status: 'ended', source: 'roster', from: '20260901', to: '20260915' },
        { courseId: 'noSlot', uid: 'someone', status: 'ended', source: 'request' },
      ]),
    }
    const st = myCourseStates(p2, 'me', TODAY)
    const brief = (id: string) => {
      const x = st.get(id)
      return x ? `${x.status}:${x.source}` : null
    }

    test('차시가 없는 수업도 참여 중·승인 대기(칸 목록 myLessonsFrom에는 없음) — 출처 그대로라 빼기 가능', () => {
      assert.equal(brief('noSlot'), 'active:request')
      assert.equal(brief('noSlotP'), 'pending:request')
      assert.ok(!myLessonsFrom(p2, 'me', TODAY).some((m) => m.courseId === 'noSlot' || m.courseId === 'noSlotP'))
    })

    test('끝낸·뺀 수강(오늘 뺀 수업 포함)은 ended(다시 담기), 시작 예정은 active, 반 공통은 active·common', () => {
      assert.equal(brief('leftToday'), 'ended:request')
      assert.equal(brief('math'), 'ended:roster')
      assert.equal(brief('hist'), 'active:invite')
      assert.equal(brief('lit'), 'active:common')
      assert.equal(brief('lit2'), 'active:common', '끝낸 수강보다 지금 소속 학급의 공통 수업이 우선')
    })

    test('다른 학생 수강·다른 반 공통 수업·관련 없는 수업은 없음', () => {
      assert.equal(brief('other'), null)
      assert.equal(brief('nope'), null)
      assert.equal(myCourseStates(p2, 'someone', TODAY).get('noSlot')?.status, 'ended')
      assert.equal(myCourseStates(p2, 'someone', TODAY).get('noSlotP'), undefined)
    })
  })
})
