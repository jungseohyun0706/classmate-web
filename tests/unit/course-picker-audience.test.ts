/**
 * 학생 '수업 담기' — 대상 반·학년으로 누구에게 보일지 (순수 함수, 가상 데이터)
 *  - 반별 수업(가져오기의 한 학급 수업 'hr|2-1|국어|…', 교사가 한 반만 정한 수업)은 그 반 학생에게만. 다른 반 학생에게는
 *    '다른 반·학년 수업도 보기'로도 안 보임(서버 catalog가 보내지 않음 — offerCatalog, 담기도 거절 — courseOfferFor 'never')
 *  - 여러 반·선택·이동 수업(대상 반 둘 이상, 또는 분반·수업 코드 수업 — 칸이 한 반에서만 나와도)은 기본은 그 반 학생,
 *    다른 반 학생은 보기를 켜면 보임(courseClassScope — 대상 반 개수만으로 정하지 않음)
 *  - 대상 반이 없는 수업은 예전 학년 규칙, 이미 내 수강(참여·승인 대기)은 언제나 내 것
 *  - 빈 화면 구분(catalogEmptyState): 학교에 공개 수업 없음 / 내 학년·반 수업 없음(보기 버튼 여부)
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  catalogEmptyState,
  cleanClassLabels,
  courseAudienceKind,
  courseClassScope,
  courseOfferFor,
  filterForStudent,
  normalizeCatalog,
  offerCatalog,
  studentClassLabelOf,
  studentScopeOf,
  activeOrPendingIds,
  type StudentScope,
} from '../../src/lib/timetable/coursePicker'

const S21: StudentScope = { grade: 2, classLabel: '2-1' }
const S22: StudentScope = { grade: 2, classLabel: '2-2' }
const S23: StudentScope = { grade: 2, classLabel: '2-3' }

// 같은 학년 학급 시간표 가져오기로 만든 반별 국어(반마다 하나 — 'hr' 수업) · 2-1·2-3 선택 과목(분반) · 학년만 아는 수업 · 반·학년 모두 모르는 수업
type Doc = { courseId: string; classLabels?: string[]; classLabelsBy?: string; importKey?: string; grades?: number[] }
const hr = (id: string, label: string): Doc => ({ courseId: id, classLabels: [label], classLabelsBy: 'import', importKey: `hr|${label}|국어|국선생`, grades: [Number(label.split('-')[0])] })
const KOR21 = hr('kor21', '2-1')
const KOR22 = hr('kor22', '2-2')
const KOR23 = hr('kor23', '2-3')
const ELECT: Doc = { courseId: 'elect', classLabels: ['2-1', '2-3'], classLabelsBy: 'import', importKey: 'sec|고전|B|고전쌤', grades: [2] }
const G3: Doc = { courseId: 'g3', grades: [3] }
const ANY: Doc = { courseId: 'any' }
const ALL: Doc[] = [KOR21, KOR22, KOR23, ELECT, G3, ANY]
// 칸이 한 반에서만 나온 선택·이동 수업 — 3-4 칸만 있는 영어 A(분반), 3-5 칸만 있는 수업 코드 수업, 2-1만 있는 여러 학급 키(이론상)
const ENG_A: Doc = { courseId: 'engA', classLabels: ['3-4'], classLabelsBy: 'import', importKey: 'sec|영어|A|이영희', grades: [3] }
const CODE35: Doc = { courseId: 'code35', classLabels: ['3-5'], classLabelsBy: 'import', importKey: 'code|ENG-B', grades: [3] }
const S34: StudentScope = { grade: 3, classLabel: '3-4' }
const S35: StudentScope = { grade: 3, classLabel: '3-5' }

/** 서버 catalog와 같은 흐름: offerCatalog → 응답 모양 → normalizeCatalog(화면이 받는 값) */
function catalogFor(me: StudentScope | null, myStatus: Record<string, string> = {}) {
  const { sent, withheld } = offerCatalog(ALL, me, (id) => myStatus[id])
  const data = {
    term: null,
    courses: sent.map(({ course, offer }) => ({ title: course.courseId, slots: [], ...course, offer })),
    me: me || { grade: null, classLabel: null },
    withheld,
  }
  return normalizeCatalog(JSON.parse(JSON.stringify(data)))!
}
const ids = (cs: Array<{ courseId: string }>) => cs.map((c) => c.courseId).sort()

describe('대상 반 값(cleanClassLabels·studentClassLabelOf)', () => {
  test("'g-c' 모양만, 중복 없이 학년·반(숫자) 순 — 읽을 수 없는 표시는 버림", () => {
    assert.deepEqual(cleanClassLabels(['2-10', '2-3', '1-2', '2-3', '2-01', '7-1', '2학년 1반', 3, null, ' 2-2 ']), ['1-2', '2-2', '2-3', '2-10'])
    assert.deepEqual(cleanClassLabels(undefined), [])
  })
  test("학생 프로필 grade·classNm → '2-1'(숫자·숫자 문자열·'4반'), 모르면 null", () => {
    assert.equal(studentClassLabelOf(2, 1), '2-1')
    assert.equal(studentClassLabelOf('3', '4'), '3-4')
    assert.equal(studentClassLabelOf(3, '4반'), '3-4')
    assert.equal(studentClassLabelOf(3, null), null)
    assert.equal(studentClassLabelOf(null, 4), null)
    assert.equal(studentClassLabelOf(7, 1), null)
    assert.equal(studentClassLabelOf(2, '사랑반'), null)
    assert.deepEqual(studentScopeOf({ grade: 2, classNm: 3 }), { grade: 2, classLabel: '2-3' })
    assert.deepEqual(studentScopeOf({ grade: 2 }), { grade: 2, classLabel: null })
    assert.deepEqual(studentScopeOf(null), { grade: null, classLabel: null })
  })
  test('대상 범위: 한 학급 수업 = 반별 수업, 둘 이상 = 여러 반 수업, 없으면 학년·전체', () => {
    assert.equal(courseAudienceKind(KOR21), 'homeroom')
    assert.equal(courseAudienceKind(ENG_A), 'classes', '분반 수업은 대상 반이 하나여도 선택·이동 수업')
    assert.equal(courseAudienceKind(ELECT), 'classes')
    assert.equal(courseAudienceKind(G3), 'grades')
    assert.equal(courseAudienceKind(ANY), 'all')
    // 형식이 다른 표시만 있으면 반 정보 없음으로(다른 반 수업을 내 반 수업으로 읽지 않음)
    assert.equal(courseAudienceKind({ classLabels: ['2학년 1반'], grades: [2] }), 'grades')
  })
})

describe('대상 반의 성격(courseClassScope) — 개수만이 아니라 출처로', () => {
  test("가져오기 수업: 한 학급 'hr|…'만 반별 수업, 분반 'sec|…'·수업 코드 'code|…'·여러 학급 'mc|…'는 한 반이어도 선택·이동 수업", () => {
    assert.equal(courseClassScope(KOR21), 'homeroom')
    assert.equal(courseClassScope(ENG_A), 'classes')
    assert.equal(courseClassScope(CODE35), 'classes')
    assert.equal(courseClassScope({ classLabels: ['2-1', '2-2'], classLabelsBy: 'import', importKey: 'mc|2-1+2-2|체육|체쌤' }), 'classes')
    assert.equal(courseClassScope(ELECT), 'classes')
  })
  test("교사가 정한 대상 반(classLabelsBy 'teacher')은 교사 화면 안내대로: 한 반이면 반별 수업, 둘 이상이면 여러 반 — 가져오기 키와 상관없이", () => {
    assert.equal(courseClassScope({ ...ENG_A, classLabelsBy: 'teacher' }), 'homeroom')
    assert.equal(courseClassScope({ ...KOR22, classLabels: ['2-2', '2-3'], classLabelsBy: 'teacher' }), 'classes')
    assert.equal(courseClassScope({ classLabels: ['1-1'], classLabelsBy: 'teacher' }), 'homeroom')
  })
  test('출처 표시가 없는 값(예전 자료·직접 넣은 값)은 교사 값과 같은 규칙, 대상 반이 없으면 null', () => {
    assert.equal(courseClassScope({ classLabels: ['2-1'] }), 'homeroom')
    assert.equal(courseClassScope({ classLabels: ['2-1', '2-3'] }), 'classes')
    assert.equal(courseClassScope({ classLabels: [], importKey: 'hr|2-1|국어|국선생' }), null)
    assert.equal(courseClassScope(G3), null)
    assert.equal(courseClassScope({ classLabels: ['2학년 1반'], importKey: 'hr|2-1|국어|국선생' }), null, '읽을 수 없는 표시는 없는 것으로')
  })
})

describe('누구에게 보일지(courseOfferFor)', () => {
  test('반별 수업: 내 반이면 mine, 같은 학년 다른 반이면 never(보기를 켜도 안 보임)', () => {
    assert.equal(courseOfferFor(KOR21, S21), 'mine')
    assert.equal(courseOfferFor(KOR22, S21), 'never')
    assert.equal(courseOfferFor(KOR23, S21), 'never')
    assert.equal(courseOfferFor(KOR22, S22), 'mine')
  })
  test('반별 수업: 내 반을 모르면(학년만 앎·아무것도 모름) never — 어느 반 수업인지 확인할 수 없음', () => {
    assert.equal(courseOfferFor(KOR21, { grade: 2, classLabel: null }), 'never')
    assert.equal(courseOfferFor(KOR21, { grade: null, classLabel: null }), 'never')
  })
  test('여러 반 수업(2-1·2-3 선택 과목): 2-1·2-3은 mine, 2-2는 other(보기를 켜면 보임)', () => {
    assert.equal(courseOfferFor(ELECT, S21), 'mine')
    assert.equal(courseOfferFor(ELECT, S23), 'mine')
    assert.equal(courseOfferFor(ELECT, S22), 'other')
    assert.equal(courseOfferFor(ELECT, { grade: 3, classLabel: '3-1' }), 'other')
  })
  test('여러 반 수업: 내 반을 모르면 대상 반들의 학년으로(내 학년도 모르면 mine)', () => {
    assert.equal(courseOfferFor(ELECT, { grade: 2, classLabel: null }), 'mine')
    assert.equal(courseOfferFor(ELECT, { grade: 1, classLabel: null }), 'other')
    assert.equal(courseOfferFor(ELECT, { grade: null, classLabel: null }), 'mine')
  })
  test('한 반 칸만 있는 분반 수업(영어 A 3-4): 3-4는 mine, 3-5는 other — 보기로 찾아 담을 수 있음(never 아님)', () => {
    assert.equal(courseOfferFor(ENG_A, S34), 'mine')
    assert.equal(courseOfferFor(ENG_A, S35), 'other')
    assert.equal(courseOfferFor(CODE35, S34), 'other')
    assert.equal(courseOfferFor(CODE35, S35), 'mine')
    assert.equal(courseOfferFor(ENG_A, { grade: 3, classLabel: null }), 'mine', '내 반을 모르면 학년으로')
    assert.equal(courseOfferFor(ENG_A, S21), 'other', '다른 학년도 보기로')
    // 교사가 그 수업의 대상 반을 3-4 하나로 정하면 그때는 반별 수업
    assert.equal(courseOfferFor({ ...ENG_A, classLabelsBy: 'teacher' }, S35), 'never')
  })
  test('대상 반이 없는 수업은 예전 학년 규칙: 학년 미상·내 학년·내 학년 모름은 mine, 다른 학년은 other', () => {
    assert.equal(courseOfferFor(ANY, S21), 'mine')
    assert.equal(courseOfferFor(G3, S21), 'other')
    assert.equal(courseOfferFor(G3, { grade: 3, classLabel: '3-4' }), 'mine')
    assert.equal(courseOfferFor(G3, { grade: null, classLabel: null }), 'mine')
  })
})

describe('서버가 보낼 목록(offerCatalog) → 화면 거르기(filterForStudent)', () => {
  test("2-1 학생: 2-1 국어는 받음, 2-2·2-3 국어는 받지도 않음(보기를 켜도 없음) — 개수만 withheld", () => {
    const cat = catalogFor(S21)
    assert.deepEqual(ids(cat.courses), ['any', 'elect', 'g3', 'kor21'])
    assert.equal(cat.withheld, 2)
    assert.deepEqual(cat.me, { grade: 2, classLabel: '2-1' })
    const def = filterForStudent(cat.courses, false)
    assert.deepEqual(ids(def.shown), ['any', 'elect', 'kor21'])
    assert.equal(def.hidden, 1) // 3학년 수업
    const all = filterForStudent(cat.courses, true)
    assert.deepEqual(ids(all.shown), ['any', 'elect', 'g3', 'kor21'], "'다른 반·학년 수업도 보기'로도 2-2 국어는 없음")
    assert.ok(!all.shown.some((c) => c.courseId === 'kor22' || c.courseId === 'kor23'))
  })
  test('선택 과목(2-1·2-3): 2-1·2-3 학생은 기본으로, 2-2 학생은 보기를 켰을 때만', () => {
    for (const me of [S21, S23]) {
      const cat = catalogFor(me)
      assert.ok(filterForStudent(cat.courses, false).shown.some((c) => c.courseId === 'elect'), me.classLabel as string)
    }
    const c22 = catalogFor(S22)
    const e = c22.courses.find((c) => c.courseId === 'elect')
    assert.equal(e?.offer, 'other')
    assert.deepEqual(e?.classLabels, ['2-1', '2-3'])
    assert.ok(!filterForStudent(c22.courses, false).shown.some((c) => c.courseId === 'elect'), '기본 보기에는 없음')
    assert.ok(filterForStudent(c22.courses, true).shown.some((c) => c.courseId === 'elect'), '보기를 켜면 보임')
    assert.deepEqual(ids(filterForStudent(c22.courses, true).shown), ['any', 'elect', 'g3', 'kor22'])
  })
  test('이미 내 수강(참여·승인 대기)인 다른 반 수업은 언제나 내 것으로 받음(offer mine) — 끝낸 수강은 다시 판정', () => {
    const cat = catalogFor(S21, { kor22: 'active', kor23: 'pending', g3: 'pending' })
    const byId = new Map(cat.courses.map((c) => [c.courseId, c]))
    assert.equal(byId.get('kor22')?.offer, 'mine')
    assert.equal(byId.get('kor23')?.offer, 'mine')
    assert.equal(byId.get('g3')?.offer, 'mine')
    assert.equal(cat.withheld, 0)
    const ended = catalogFor(S21, { kor22: 'ended' })
    assert.ok(!ended.courses.some((c) => c.courseId === 'kor22'))
  })
  test('화면도 내 시간표 자료의 내 수업(참여·승인 대기)은 거르기와 상관없이 보여 줌', () => {
    const cat = catalogFor(S22)
    const keep = activeOrPendingIds(
      new Map([
        ['g3', { status: 'active' as const }],
        ['elect', { status: 'ended' as const }],
      ])
    )
    assert.deepEqual(Array.from(keep), ['g3'])
    const r = filterForStudent(cat.courses, false, keep)
    assert.ok(r.shown.some((c) => c.courseId === 'g3'), '내 수업은 다른 학년이어도 보임')
    assert.ok(!r.shown.some((c) => c.courseId === 'elect'), '끝낸 수강은 내 것이 아님(다른 반 선택 과목은 보기로)')
  })
  test('3-5 학생: 3-4 칸만 있는 영어 A는 받음(offer other — 보기를 켜면 보이고 담을 수 있음), 반별 수업이 아니라 withheld에 들지 않음', () => {
    const { sent, withheld } = offerCatalog([ENG_A, CODE35, hr('kor34', '3-4')], S35, () => null)
    assert.deepEqual(
      sent.map((x) => [x.course.courseId, x.offer]),
      [
        ['engA', 'other'],
        ['code35', 'mine'],
      ]
    )
    assert.equal(withheld, 1, '3-4 국어(한 학급 수업)만 보내지 않음')
  })
  test('교사가 아니면(me null은 교사) 거르지 않음, offer 값이 없거나 이상하면 기본으로 보임', () => {
    const t = catalogFor(null)
    assert.equal(t.courses.length, 6)
    assert.equal(t.withheld, 0)
    assert.ok(t.courses.every((c) => c.offer === 'mine'))
    const n = normalizeCatalog({ courses: [{ courseId: 'a', title: 'a', offer: 'weird' }, { courseId: 'b', title: 'b' }], withheld: -3 })!
    assert.ok(n.courses.every((c) => c.offer === 'mine'))
    assert.equal(n.withheld, 0)
    assert.deepEqual(n.me, { grade: null, classLabel: null })
  })
})

describe('빈 화면 구분(catalogEmptyState)', () => {
  test('학교에 공개 수업이 하나도 없음 — 받은 수업도, 보내지 않은 다른 반 반별 수업도 0', () => {
    assert.deepEqual(catalogEmptyState({ total: 0, withheld: 0, shown: 0, hidden: 0, showAll: false }), { kind: 'no-public' })
  })
  test('공개 수업이 모두 다른 학년·반 선택 수업 → 내 학년·반 수업 없음 + 보기 버튼', () => {
    assert.deepEqual(catalogEmptyState({ total: 3, withheld: 0, shown: 0, hidden: 3, showAll: false }), { kind: 'no-mine', canShowOthers: true })
  })
  test('공개 수업이 모두 다른 반의 반별 수업(보내지 않음) → 내 학년·반 수업 없음, 보기 버튼 없음(켜도 안 보임)', () => {
    assert.deepEqual(catalogEmptyState({ total: 0, withheld: 4, shown: 0, hidden: 0, showAll: false }), { kind: 'no-mine', canShowOthers: false })
    assert.deepEqual(catalogEmptyState({ total: 2, withheld: 1, shown: 0, hidden: 0, showAll: true }), { kind: 'no-mine', canShowOthers: false })
  })
  test('보이는 수업이 있으면 빈 화면 아님(요일·교시가 없는 경우는 칸 보기가 따로 안내)', () => {
    assert.equal(catalogEmptyState({ total: 2, withheld: 5, shown: 1, hidden: 1, showAll: false }), null)
  })
  test('2-1 학생, 학교 공개 수업이 2-2·2-3 국어뿐 → 내 학년·반 수업 없음(no-public 아님)', () => {
    const { sent, withheld } = offerCatalog([KOR22, KOR23], S21, () => null)
    const total = sent.length
    assert.deepEqual(catalogEmptyState({ total, withheld, shown: 0, hidden: 0, showAll: false }), { kind: 'no-mine', canShowOthers: false })
  })
})
