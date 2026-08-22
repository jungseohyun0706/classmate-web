/**
 * 체험 모드 데이터 — /s/demo/1/1
 * 가입 전 학생·학부모·선생님이 서비스를 미리 볼 수 있는 쇼케이스.
 */
import { mondayOf, type TimetableItem } from './timetable'

const it = (day: any, period: number, subject: string, teacher?: string): TimetableItem => ({
  id: `${day}-${period}`, day, period, subject, ...(teacher ? { teacher } : {}),
})

export const DEMO_SCHOOL_CODE = 'demo'

export const demoClassData = {
  classId: 'demo_1_1',
  schoolCode: 'demo',
  schoolName: '클래스메이트고',
  grade: 1,
  classNm: 1,
  teacherName: '김철수',
}

export const demoItems: TimetableItem[] = [
  it('월', 1, '국어', '김철수'), it('월', 2, '수학', '이영희'), it('월', 3, '영어', '박민준'), it('월', 4, '통합과학', '정다은'), it('월', 5, '체육', '최강'), it('월', 6, '음악', '송가인'),
  it('화', 1, '수학', '이영희'), it('화', 2, '국어', '김철수'), it('화', 3, '통합사회', '한지민'), it('화', 4, '영어', '박민준'), it('화', 5, '기술가정', '조단단'), it('화', 6, '창체', '김철수'),
  it('수', 1, '영어', '박민준'), it('수', 2, '통합과학', '정다은'), it('수', 3, '국어', '김철수'), it('수', 4, '수학', '이영희'), it('수', 5, '미술', '유화백'),
  it('목', 1, '통합사회', '한지민'), it('목', 2, '체육', '최강'), it('목', 3, '수학', '이영희'), it('목', 4, '국어', '김철수'), it('목', 5, '영어', '박민준'), it('목', 6, '동아리', '담당T'),
  it('금', 1, '통합과학', '정다은'), it('금', 2, '영어', '박민준'), it('금', 3, '음악', '송가인'), it('금', 4, '국어', '김철수'), it('금', 5, '수학', '이영희'),
]

export const demoChanges = () => [
  {
    id: 'demo-chg-1',
    day: '수', period: 3, type: 'substitute' as const,
    classIds: ['demo_1_1'], weekOf: mondayOf(),
    note: '국어 — 김철수 → 정다은 선생님 (보결)',
  },
  {
    id: 'demo-chg-2',
    day: '금', period: 5, type: 'swap' as const,
    classIds: ['demo_1_1'], weekOf: mondayOf(),
    note: '5교시 수학(이영희) → 체육(최강) 교환',
  },
]

const ymd = (d: Date) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`

export const demoMeals = () => {
  const menus = [
    ['현미밥', '된장찌개', '제육볶음', '상추겉절이', '배추김치', '요구르트'],
    ['카레라이스', '유부장국', '치킨너겟', '단무지무침', '깍두기'],
    ['잡곡밥', '김치찌개', '고등어구이', '숙주나물', '배추김치', '사과'],
    ['비빔밥', '계란국', '군만두', '배추김치', '수박'],
    ['백미밥', '미역국', '불고기', '오이무침', '배추김치', '초코우유'],
  ]
  const mon = new Date(mondayOf())
  return Array.from({ length: 5 }, (_, i) => {
    const d = new Date(mon)
    d.setDate(d.getDate() + i)
    return { date: ymd(d), type: '중식', menu: menus[i], calories: `${780 + i * 17} Kcal` }
  })
}
