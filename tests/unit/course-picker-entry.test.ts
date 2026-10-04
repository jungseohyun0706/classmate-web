/**
 * 학생 '수업 담기' — 직접 입력 화면의 '이 시간 학교 수업'과 직접 입력 목록의 겹침 안내 (순수 함수, 가상 데이터)
 *  - 요일·교시(또는 학교 교시 안의 시각)로만 찾음. 입력한 제목은 함수에 들어가지도 않음(이름 기반 연결 금지)
 *  - 아직 내 것이 아닌 공개 수업 → '담기', 이미 듣는(연결 가능한) 수업 → '연결'
 *  - 담기 후보·겹침 안내도 수업 담기의 기본 보기와 같은 거르기(filterForStudent — 서버가 정한 offer)를 거침:
 *    다른 반·학년 수업(offer 'other')은 후보가 아니고, 그 수업 때문에 겹침 안내를 하지 않음
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  entryOverlapsSchool,
  entrySchoolSlot,
  filterForStudent,
  offerCatalog,
  slotSuggestions,
  type EntrySlotLike,
  type MyLesson,
  type PickerCourse,
} from '../../src/lib/timetable/coursePicker'
import type { PeriodTime } from '../../src/lib/timetable/types'

const PT: PeriodTime[] = [
  { period: 1, start: '08:40', end: '09:30' },
  { period: 2, start: '09:40', end: '10:30' },
  { period: 3, start: '10:40', end: '11:30' },
  { period: 4, start: '11:40', end: '12:30' },
  { period: 5, start: '13:30', end: '14:20' },
  { period: 6, start: '14:30', end: '15:20' },
  { period: 7, start: '15:30', end: '16:20' },
]

function pc(id: string, title: string, slots: Array<[number, number]>, extra: Partial<PickerCourse> = {}): PickerCourse {
  return {
    courseId: id,
    title,
    subject: title,
    section: null,
    teacherNames: [],
    defaultRoomName: null,
    invitePolicy: 'auto',
    slots: slots.map(([weekday, period]) => ({ weekday, period, roomName: null })),
    myStatus: null,
    grades: [],
    classLabels: [],
    offer: 'mine',
    ...extra,
  }
}
const ml = (courseId: string, title: string, weekday: number, period: number, status: MyLesson['status'] = 'active', linkable = status === 'active'): MyLesson => ({
  courseId,
  title,
  status,
  source: status === 'common' ? 'common' : 'request',
  weekday,
  period,
  roomName: null,
  linkable,
})
const weekly = (weekday: number, period: number | null, start: string | null = null, end: string | null = null): EntrySlotLike => ({
  kind: 'weekly',
  weekday,
  date: null,
  period,
  start,
  end,
})

// 화 4교시: 생활과 과학 A(공개, 아직 안 담음), 물리 D(공개, 승인 대기 중), 화 3교시: 영어 B(이미 활성 수강)
const SCI = pc('sci', '생활과 과학 A', [[2, 4], [4, 2]])
const PHYS = pc('phys', '물리 D', [[2, 4]], { myStatus: 'pending', invitePolicy: 'approval' })
const ENG = pc('engB', '영어 B', [[2, 3]], { myStatus: 'active' })
const CATALOG = [SCI, PHYS, ENG, pc('math', '수학', [[3, 4]])]
const MINE = [ml('engB', '영어 B', 2, 3), ml('phys', '물리 D', 2, 4, 'pending', false), ml('lit', '문학', 2, 1, 'common', false)]

describe('일정의 학교 교시(entrySchoolSlot)', () => {
  test('교시를 고르면 그 교시', () => {
    assert.deepEqual(entrySchoolSlot(weekly(2, 4), PT), { weekday: 2, periods: [4] })
  })
  test('교시 없이 시각만 → 그 시각과 겹치는 학교 교시(학교 교시 밖 시각은 없음)', () => {
    assert.deepEqual(entrySchoolSlot(weekly(2, null, '11:50', '12:10'), PT), { weekday: 2, periods: [4] })
    assert.deepEqual(entrySchoolSlot(weekly(2, null, '10:00', '11:00'), PT), { weekday: 2, periods: [2, 3] })
    assert.deepEqual(entrySchoolSlot(weekly(2, null, '18:00', '20:00'), PT).periods, [], '학원 시간(학교 밖)')
    assert.deepEqual(entrySchoolSlot(weekly(2, null, '11:50', null), PT).periods, [4], '시작만 있으면 그 시각')
  })
  test('특정 날짜는 그 날짜의 요일, 요일을 모르면 없음', () => {
    assert.deepEqual(entrySchoolSlot({ kind: 'once', weekday: null, date: '20261006', period: 3, start: null, end: null }, PT), { weekday: 2, periods: [3] })
    assert.deepEqual(entrySchoolSlot({ kind: 'once', weekday: null, date: null, period: 3, start: null, end: null }, PT), { weekday: null, periods: [] })
    assert.deepEqual(entrySchoolSlot(weekly(2, null), PT), { weekday: 2, periods: [] }, '교시·시각 없음')
  })
})

describe("'이 시간 학교 수업'(slotSuggestions) — 요일·교시로만", () => {
  test('화 4교시: 아직 내 것이 아닌 공개 수업만 담기 후보(승인 대기 중인 물리 D는 빼고)', () => {
    const s = slotSuggestions(weekly(2, 4), CATALOG, MINE, PT)
    assert.deepEqual(s.offered.map((c) => c.courseId), ['sci'])
    assert.deepEqual(s.linkable, [])
  })
  test('화 3교시: 이미 듣는 영어 B는 담기 후보가 아니라 연결 후보', () => {
    const s = slotSuggestions(weekly(2, 3), CATALOG, MINE, PT)
    assert.deepEqual(s.offered, [])
    assert.deepEqual(s.linkable.map((m) => m.courseId), ['engB'])
  })
  test('반 공통 수업(연결 불가)은 연결 후보에 없음', () => {
    assert.deepEqual(slotSuggestions(weekly(2, 1), CATALOG, MINE, PT).linkable, [])
  })
  test('시각(11:50~12:10 — 4교시 안)으로도 같은 후보', () => {
    assert.deepEqual(slotSuggestions(weekly(2, null, '11:50', '12:10'), CATALOG, MINE, PT).offered.map((c) => c.courseId), ['sci'])
  })
  test('다른 요일·교시면 후보 없음 — 입력 제목이 수업 이름과 같아도(제목은 입력에 없음)', () => {
    // 학생이 '생활과 과학 A'라고 적었어도 월 1교시라면 학교 수업 후보가 없음: 함수는 제목을 받지 않음
    const entry = { ...weekly(1, 1), title: '생활과 과학 A' } as EntrySlotLike & { title: string }
    const s = slotSuggestions(entry, CATALOG, MINE, PT)
    assert.deepEqual(s.offered, [])
    assert.deepEqual(s.linkable, [])
  })
  test('제목과 상관없이 같은 칸이면 후보 — 학교 밖 이름을 적어도 같은 칸 수업이 보임(자동 연결은 없음)', () => {
    const entry = { ...weekly(4, 2), title: '학원' } as EntrySlotLike & { title: string }
    assert.deepEqual(slotSuggestions(entry, CATALOG, MINE, PT).offered.map((c) => c.courseId), ['sci'])
  })
  test('학교 교시 밖 시각(학원 18:00)·요일 없음 → 후보 없음', () => {
    assert.deepEqual(slotSuggestions(weekly(2, null, '18:00', '20:00'), CATALOG, MINE, PT).offered, [])
    assert.deepEqual(slotSuggestions({ kind: 'weekly', weekday: null, date: null, period: 4, start: null, end: null }, CATALOG, MINE, PT).offered, [])
  })
})

describe("직접 입력 목록의 '학교 수업과 시간이 겹쳐요'(entryOverlapsSchool)", () => {
  test('연결하지 않은 일정이 내 수업·공개 수업과 같은 요일·교시면 true', () => {
    assert.equal(entryOverlapsSchool(weekly(2, 3), CATALOG, MINE, PT), true, '내 수업(영어 B)')
    assert.equal(entryOverlapsSchool(weekly(3, 4), CATALOG, MINE, PT), true, '공개 수업(수학)')
    assert.equal(entryOverlapsSchool(weekly(2, 1), [], MINE, PT), true, '반 공통 수업(문학)')
  })
  test('연결한 일정·다른 시간·학교 밖 시각은 false', () => {
    assert.equal(entryOverlapsSchool({ ...weekly(2, 3), linkedCourseId: 'engB' }, CATALOG, MINE, PT), false)
    assert.equal(entryOverlapsSchool(weekly(1, 7), CATALOG, MINE, PT), false)
    assert.equal(entryOverlapsSchool(weekly(2, null, '18:00', '20:00'), CATALOG, MINE, PT), false)
  })
  test('승인 대기 수업만 있는 칸은 안내하지 않음(공개 목록에도 없을 때)', () => {
    assert.equal(entryOverlapsSchool(weekly(2, 4), [], MINE, PT), false)
  })
})

describe('담기 후보·겹침 안내도 수업 담기 기본 보기와 같은 거르기(내 학년·반 수업만)', () => {
  // 2-1 학생: 화 5교시에 2-2 학생 선택 과목(다른 반·학년 — other)과 3학년 수업(other), 목 5교시에 2-1 선택 과목(mine)
  const OTHER_ELECT = pc('elect22', '심화 국어', [[2, 5]], { classLabels: ['2-2', '2-3'], offer: 'other' })
  const OTHER_GRADE = pc('g3', '3학년 진로', [[2, 5]], { grades: [3], offer: 'other' })
  const MY_ELECT = pc('elect21', '고전 읽기', [[4, 5]], { classLabels: ['2-1', '2-4'], offer: 'mine' })
  const CAT2 = [OTHER_ELECT, OTHER_GRADE, MY_ELECT]
  test("다른 반·학년 수업(offer other)은 '이 시간 학교 수업' 담기 후보가 아님 — 피커 기본 보기와 같은 목록", () => {
    assert.deepEqual(slotSuggestions(weekly(2, 5), CAT2, [], PT).offered, [])
    assert.deepEqual(slotSuggestions(weekly(4, 5), CAT2, [], PT).offered.map((c) => c.courseId), ['elect21'])
    // 같은 순수 함수: 피커 기본 보기(filterForStudent(..., false))에 없는 수업은 후보에도 없음
    const pickerDefault = new Set(filterForStudent(CAT2, false).shown.map((c) => c.courseId))
    ;[weekly(2, 5), weekly(4, 5)].forEach((e) =>
      slotSuggestions(e, CAT2, [], PT).offered.forEach((c) => assert.ok(pickerDefault.has(c.courseId), c.courseId))
    )
  })
  test("다른 반·학년 수업만 있는 칸은 '학교 수업과 시간이 겹쳐요'를 띄우지 않음, 내 학년·반 수업 칸은 띄움", () => {
    assert.equal(entryOverlapsSchool(weekly(2, 5), CAT2, [], PT), false)
    assert.equal(entryOverlapsSchool(weekly(4, 5), CAT2, [], PT), true)
  })
  test('다른 학년 수업이어도 이미 내 수업이면(칸에 있는 내 수업) 연결 후보·겹침 안내 그대로', () => {
    const mine = [ml('g3', '3학년 진로', 2, 5)]
    assert.deepEqual(slotSuggestions(weekly(2, 5), CAT2, mine, PT).linkable.map((m) => m.courseId), ['g3'])
    assert.equal(entryOverlapsSchool(weekly(2, 5), CAT2, mine, PT), true)
  })
  test('다른 반의 반별 수업은 서버가 보내지 않으므로 같은 칸이어도 후보·안내 없음(제목이 같아도)', () => {
    const raw = [
      { courseId: 'kor22', classLabels: ['2-2'], grades: [2] },
      { courseId: 'kor21', classLabels: ['2-1'], grades: [2] },
    ]
    const { sent } = offerCatalog(raw, { grade: 2, classLabel: '2-1' }, () => null)
    const cat = sent.map(({ course, offer }) => pc(course.courseId, '국어', [[1, 1]], { classLabels: course.classLabels, offer }))
    assert.deepEqual(cat.map((c) => c.courseId), ['kor21'])
    assert.deepEqual(slotSuggestions(weekly(1, 1), cat, [], PT).offered.map((c) => c.courseId), ['kor21'])
  })
})
