// 학생 홈 '학급 시간표(참고)' 첫날 회귀 — 순수 로직, 가상 데이터(실제 학생 정보 아님)
//  [16] 직접 입력 일정을 하나 추가하거나 과목 수업이 하나 생기면 홈에서 학급 시간표(참고)가 사라지고 '이 날은 수업이 없어요'로 보임
//  [17] 담임 승인 대기 학생이 예전에 보던 공개 NEIS 학급 시간표를 못 보고 초대 코드 입력으로 안내됨
//  [19] /api/timetable/me 서버·네트워크 오류면 학급 시간표(참고)도 못 봄(예전 TodayCard는 따로 불러옴) + 느린 학사일정이 응답을 붙잡음
//  [20] 학급 시간표(참고)에 '지금' 교시·교시 시각이 없음
//  [18] 저녁 '내일 가방' 알림이 가방 체크리스트가 없는 화면을 엶
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { buildDayTimetable } from '../../src/lib/timetable/engine'
import {
  awaitingHomeroomClass,
  classRefAutoOpen,
  classRefNowPeriod,
  classRefOffDay,
  classRefTarget,
  defaultPeriodTimes,
  displayDayState,
  hasOfficialTimetable,
  type ClassRefPayload,
  type ClassRefProfile,
} from '../../src/lib/timetable/classRefPolicy'
import type { Course, Enrollment, LessonSeries, PersonalEntry, StudentTimetableInput, Ymd } from '../../src/lib/timetable/types'

/** 화면 소스(정적 검사용) — 컴파일 위치(.test-dist/tests/unit)와 원본 위치 모두에서 찾음 */
function src(rel: string): string {
  const cands = [path.resolve(__dirname, '../../..', rel), path.resolve(__dirname, '../..', rel), path.resolve(process.cwd(), rel)]
  const f = cands.find((p) => fs.existsSync(p))
  if (!f) throw new Error(`소스 없음: ${rel}`)
  return fs.readFileSync(f, 'utf8')
}

const MON = '20261005'
const TUE = '20261006'
const WED = '20261007'
const UID = 'uid-test-student'
const HR = 'S1_3_5'

const mkCourse = (p: Partial<Course> & Pick<Course, 'courseId' | 'title'>): Course => ({
  schoolCode: 'S1',
  termId: '2026-2',
  subject: p.title,
  teacherUids: [],
  teacherNames: [],
  status: 'active',
  endedOn: null,
  commonForHomerooms: [],
  ...p,
})
const mkSeries = (p: Partial<LessonSeries> & Pick<LessonSeries, 'seriesId' | 'courseId' | 'weekday' | 'period'>): LessonSeries => ({
  validFrom: '20260816',
  validTo: null,
  status: 'active',
  ...p,
})
const mkEnr = (courseId: string): Enrollment => ({ uid: UID, courseId, status: 'active', from: null, to: null, source: 'invite' })
const ACADEMY: PersonalEntry = { entryId: 'pe-academy', title: '학원', kind: 'weekly', weekday: 1, start: '18:00', end: '20:00' }

function mkInput(date: Ymd, p: Partial<StudentTimetableInput> = {}): StudentTimetableInput {
  return { uid: UID, day: { date }, homerooms: [], enrollments: [], courses: [], series: [], overrides: [], personalEntries: [], ...p }
}

/** 예전 판단(그 날 상태로만) — 회귀 비교용 */
const oldAutoOpen = (state: string) => state === 'no-courses' || state === 'not-registered'

describe('[16] 학급 시간표(참고) 자동 펼침은 날짜 상태가 아니라 공식 수업 시간표 유무로', () => {
  test('직접 입력 일정만 있는 학생: 일정 없는 화요일도, 일정 있는 월요일도 펼침(예전 판단은 둘 다 접힘)', () => {
    const tue = buildDayTimetable(mkInput(TUE, { personalEntries: [ACADEMY] }))
    assert.equal(tue.state, 'no-lessons') // 엔진·요구 문서 3절은 그대로
    assert.equal(oldAutoOpen(tue.state), false)
    assert.equal(classRefAutoOpen({ day: tue, loadFailed: false }), true)

    const mon = buildDayTimetable(mkInput(MON, { personalEntries: [ACADEMY] }))
    assert.equal(mon.state, 'lessons')
    assert.equal(oldAutoOpen(mon.state), false)
    assert.equal(classRefAutoOpen({ day: mon, loadFailed: false }), true)
  })

  test("직접 입력만 있는 학생의 빈 날은 '이 날은 수업이 없어요'(no-lessons) 대신 '연결된 수업 없음'(no-courses) 카드", () => {
    const tue = buildDayTimetable(mkInput(TUE, { personalEntries: [ACADEMY] }))
    assert.equal(displayDayState(tue), 'no-courses')
    const mon = buildDayTimetable(mkInput(MON, { personalEntries: [ACADEMY] }))
    assert.equal(displayDayState(mon), 'lessons')
  })

  test('공식 수업이 하나도 없는 학생(no-courses)·시간표 미등록(not-registered)은 계속 펼침', () => {
    const none = buildDayTimetable(mkInput(TUE))
    assert.equal(none.state, 'no-courses')
    assert.equal(classRefAutoOpen({ day: none, loadFailed: false }), true)

    const math = mkCourse({ courseId: 'c-math', title: '수학 C' })
    const unregistered = buildDayTimetable(mkInput(TUE, { courses: [math], enrollments: [mkEnr(math.courseId)] }))
    assert.equal(unregistered.state, 'not-registered')
    assert.equal(classRefAutoOpen({ day: unregistered, loadFailed: false }), true)
    // 직접 입력 일정이 그 날 있어 lessons가 되어도 공식 시간표는 여전히 없음
    const withPersonal = buildDayTimetable(mkInput(MON, { courses: [math], enrollments: [mkEnr(math.courseId)], personalEntries: [ACADEMY] }))
    assert.equal(withPersonal.state, 'lessons')
    assert.equal(hasOfficialTimetable(withPersonal), false)
    assert.equal(classRefAutoOpen({ day: withPersonal, loadFailed: false }), true)
  })

  test('공식 수업 시간표가 연결된 학생은 접힌 채로(수업 없는 날도) — 상태 카드 문구도 그대로', () => {
    const lit = mkCourse({ courseId: 'c-lit', title: '문학', commonForHomerooms: [HR] })
    const input = (d: Ymd) =>
      mkInput(d, {
        homerooms: [{ homeroomId: HR, from: null, to: null }],
        courses: [lit],
        series: [mkSeries({ seriesId: 's-lit-tue1', courseId: lit.courseId, weekday: 2, period: 1 })],
      })
    const tue = buildDayTimetable(input(TUE))
    assert.equal(tue.state, 'lessons')
    assert.equal(classRefAutoOpen({ day: tue, loadFailed: false }), false)
    const wed = buildDayTimetable(input(WED))
    assert.equal(wed.state, 'no-lessons')
    assert.equal(classRefAutoOpen({ day: wed, loadFailed: false }), false)
    assert.equal(displayDayState(wed), 'no-lessons')
  })

  test('자료가 없으면 서버·네트워크 오류일 때만 펼침(불러오는 중에는 접힘)', () => {
    assert.equal(classRefAutoOpen({ day: null, loadFailed: true }), true)
    assert.equal(classRefAutoOpen({ day: null, loadFailed: false }), false)
  })

  test('홈은 학급 시간표(참고)를 펼쳤을 때만 그리지 않고 항상 그려 접기·다시 펼치기가 됨(timetable 화면과 같음)', () => {
    for (const page of ['src/pages/student/today.tsx', 'src/pages/student/timetable.tsx']) {
      const s = src(page)
      assert.ok(!/\{refOpen\s*&&/.test(s), `${page}: refOpen일 때만 그림`)
      assert.ok(/open=\{refOpen\}/.test(s), `${page}: open={refOpen}로 제어`)
      assert.ok(s.includes('classRefAutoOpen('), `${page}: classRefAutoOpen 사용`)
    }
  })
})

const payloadOf = (p: Partial<ClassRefPayload> = {}): ClassRefPayload => ({
  schoolCode: 'S1',
  homeroom: { classId: HR, isGroupLegacy: false },
  legacyClassTimetableAvailable: true,
  ...p,
})
const approved: ClassRefProfile = { classId: HR, status: 'approved', schoolCode: 'S1', grade: 3, classNm: 5 }
const pending: ClassRefProfile = { ...approved, status: 'pending' }

describe('[17][19] 학급 시간표(참고) 대상 classRefTarget', () => {
  test('승인된 소속 학급(서버 응답) → 학급 id까지', () => {
    assert.deepEqual(classRefTarget({ profile: approved, payload: payloadOf(), loadFailed: false }), {
      source: 'homeroom',
      schoolCode: 'S1',
      classId: HR,
      grade: 3,
      classNm: 5,
    })
  })

  test('서버 응답의 소속이 프로필과 다르거나(반 이동 직후) 참고 보기를 못 하면 없음', () => {
    assert.equal(classRefTarget({ profile: { ...approved, classId: 'S1_3_6' }, payload: payloadOf(), loadFailed: false }), null)
    assert.equal(classRefTarget({ profile: approved, payload: payloadOf({ legacyClassTimetableAvailable: false }), loadFailed: false }), null)
    assert.equal(classRefTarget({ profile: approved, payload: payloadOf({ homeroom: null }), loadFailed: false }), null)
  })

  test('프로필을 못 읽은 화면(전체 시간표)은 서버 응답만으로', () => {
    const t = classRefTarget({ profile: null, payload: payloadOf(), loadFailed: false })
    assert.equal(t?.source, 'homeroom')
    assert.equal(t?.classId, HR)
  })

  test('[17] 담임 승인 대기 → 공개 NEIS만(classId=null — 규칙으로 막힌 학급 문서를 읽지 않음), /me 자료와 무관', () => {
    const want = { source: 'pending', schoolCode: 'S1', classId: null, grade: 3, classNm: 5 }
    // 서버는 승인 전 학급을 homeroom null로 줌
    assert.deepEqual(classRefTarget({ profile: pending, payload: payloadOf({ homeroom: null, legacyClassTimetableAvailable: false }), loadFailed: false }), want)
    assert.deepEqual(classRefTarget({ profile: pending, payload: null, loadFailed: false }), want)
    assert.deepEqual(classRefTarget({ profile: pending, payload: null, loadFailed: true }), want)
    // 승인 직후 프로필은 아직 pending인데 예전 자료에 학급이 있어도 학급 문서를 읽지 않음
    assert.equal(classRefTarget({ profile: pending, payload: payloadOf(), loadFailed: false })?.classId, null)
  })

  test('[17] 승인 대기라도 학년·반이 없거나(예전 수업 그룹) 수업 초대로만 가입(classId 없음)·거절이면 없음', () => {
    assert.equal(classRefTarget({ profile: { ...pending, grade: null }, payload: null, loadFailed: false }), null)
    assert.equal(classRefTarget({ profile: { ...pending, classId: 'S1_3_5_g_engb' }, payload: null, loadFailed: false }), null)
    assert.equal(classRefTarget({ profile: { ...pending, classId: null }, payload: payloadOf({ homeroom: null }), loadFailed: false }), null)
    assert.equal(classRefTarget({ profile: { ...approved, status: 'rejected' }, payload: payloadOf(), loadFailed: true }), null)
  })

  test('[19] /me 서버·네트워크 오류로 자료가 없으면 프로필로 — 서버 homeroomOf와 같은 규칙(승인 + 수업 그룹 아님)', () => {
    assert.deepEqual(classRefTarget({ profile: approved, payload: null, loadFailed: true }), {
      source: 'profile',
      schoolCode: 'S1',
      classId: HR,
      grade: 3,
      classNm: 5,
    })
    assert.equal(classRefTarget({ profile: approved, payload: null, loadFailed: false }), null) // 불러오는 중
    assert.equal(classRefTarget({ profile: { ...approved, status: undefined }, payload: null, loadFailed: true }), null)
    assert.equal(classRefTarget({ profile: { ...approved, classId: 'S1_3_5_g_engb' }, payload: null, loadFailed: true }), null)
    assert.equal(classRefTarget({ profile: { ...approved, schoolCode: '' }, payload: null, loadFailed: true }), null)
  })
})

describe('[17][19] 상태 카드·쉬는 날 전달', () => {
  test('[17] 승인 대기 안내 대상은 실제 학급 신청만(수업 그룹 신청·수업 초대로만 가입·승인됨 제외)', () => {
    assert.equal(awaitingHomeroomClass(pending), true)
    assert.equal(awaitingHomeroomClass({ ...pending, classId: 'S1_3_5_g_engb' }), false)
    assert.equal(awaitingHomeroomClass({ ...pending, classId: null }), false)
    assert.equal(awaitingHomeroomClass(approved), false)
    assert.equal(awaitingHomeroomClass(null), false)
  })

  test('[17] 승인 대기 학생의 수업 없음 카드는 초대 코드 대신 승인 대기 안내', () => {
    const s = src('src/components/timetable/TimetableStateCard.tsx')
    assert.ok(s.includes('담임 선생님이 학급 신청을 승인하기 전이에요.'))
    assert.ok(/if \(!props\.awaitingHomeroom\)/.test(s))
  })

  test('학사일정 확인에 실패한 날·자료 기간 밖은 쉬는 날을 단정하지 않음(undefined → 참고 보기가 직접 조회)', () => {
    const p = { from: MON, to: WED, offDays: { [MON]: null, [TUE]: { name: '재량휴업일' } } as Record<Ymd, { name: string } | null>, calendarErrors: [WED] }
    assert.equal(classRefOffDay(p, MON), null)
    assert.deepEqual(classRefOffDay(p, TUE), { name: '재량휴업일' })
    assert.equal(classRefOffDay(p, WED), undefined)
    assert.equal(classRefOffDay(p, '20261008'), undefined)
    assert.equal(classRefOffDay(null, MON), undefined)
  })

  // studentData.ts는 neis.ts(DOM fetch 타입)를 끌어와 단위 테스트 빌드(lib es2020)에 넣을 수 없어 소스로 확인
  test('[19] 느린 학사일정 조회는 상한 뒤 그 기간 전부 calendarErrors로(시간표 응답을 붙잡지 않음)', () => {
    const s = src('src/lib/timetable/studentData.ts')
    assert.ok(/const offDaysPromise = boundCalendarLookup\(\s*loadOffDays\(/.test(s), 'loadOffDays를 상한으로 감쌈')
    assert.ok(/resolve\(\{ offDays: \{\}, calendarErrors: dates\.slice\(\) \}\)/.test(s), '시간 초과 = 모든 날짜 calendarErrors')
    assert.ok(/clearTimeout\(timer\)/.test(s), '끝나면 타이머 정리')
  })

  test('[19] /api/timetable/me는 함수 시간 한도를 늘림(pages router config)', () => {
    assert.ok(/export const config = \{ maxDuration: \d+ \}/.test(src('src/pages/api/timetable/me.ts')))
  })
})

describe("[20] 학급 시간표(참고)의 '지금' 교시와 교시 시각", () => {
  const HIGH = defaultPeriodTimes('테스트고등학교')
  const at = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5))
  const base = { date: TUE, today: TUE, offDay: false, periods: [1, 2, 3, 4], periodTimes: HIGH }

  test('학교급 기본 교시표(서버 buildPeriodTimes와 같은 값)', () => {
    assert.deepEqual(HIGH[0], { period: 1, start: '08:40', end: '09:30' })
    assert.deepEqual(HIGH[1], { period: 2, start: '09:40', end: '10:30' })
    assert.equal(defaultPeriodTimes('테스트중학교')[0].start, '09:00')
  })

  test('오늘·수업 시간 안이면 그 교시, 쉬는 시간·다른 날·쉬는 날·교시표 없음이면 없음', () => {
    assert.equal(classRefNowPeriod({ ...base, nowMinutes: at('10:00') }), 2)
    assert.equal(classRefNowPeriod({ ...base, nowMinutes: at('08:40') }), 1)
    assert.equal(classRefNowPeriod({ ...base, nowMinutes: at('09:30') }), null) // 쉬는 시간
    assert.equal(classRefNowPeriod({ ...base, nowMinutes: at('10:00'), date: WED }), null)
    assert.equal(classRefNowPeriod({ ...base, nowMinutes: at('10:00'), offDay: true }), null)
    assert.equal(classRefNowPeriod({ ...base, nowMinutes: null }), null)
    assert.equal(classRefNowPeriod({ ...base, nowMinutes: at('10:00'), periodTimes: null }), null)
    assert.equal(classRefNowPeriod({ ...base, nowMinutes: at('10:00'), periods: [1, 3] }), null) // 그 교시가 학급 시간표에 없음
  })

  test('참고 보기는 교시 시각과 지금 표시를 그림(LessonCard와 같은 시각 형식)', () => {
    const s = src('src/components/timetable/ClassTimetableReference.tsx')
    assert.ok(s.includes('lessonTimeRange('))
    assert.ok(s.includes('classRefNowPeriod('))
    assert.ok(s.includes('지금'))
  })
})

describe("[18] 저녁 '내일 가방' 알림은 가방 체크리스트가 있는 홈으로", () => {
  test('학생 알림 주소는 /student/today?date=내일, 홈은 ?date=로 개인 시간표 날짜를 맞춤', () => {
    const cron = src('src/pages/api/cron/evening-brief.ts')
    assert.ok(cron.includes('url: `/student/today?date=${tomorrow.ymd}`'))
    assert.ok(!cron.includes('url: `/student/timetable?date='))
    const today = src('src/pages/student/today.tsx')
    assert.ok(/router\.query\.date/.test(today) && /isYmd\(router\.query\.date\)/.test(today))
    assert.ok(today.includes('<BagChecklist'))
  })
})
