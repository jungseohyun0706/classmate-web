/**
 * 핵심 로직 단위 테스트 (Firestore 불필요한 순수 함수들)
 * 실행: npx tsx scripts/test-lib.ts
 */
import {
  gridToItems, itemsToCells, normalizeItems, deriveTeacherSchedule,
  classIdOf, parseClassId, mondayOf, nextMondayOf, periodOf,
} from '../src/lib/timetable'
import { parseTable, splitDelimited, groupRows } from '../src/lib/uploadParse'

let pass = 0
let fail = 0
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}\n    expected: ${b}\n    actual:   ${a}`) }
}
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}`) }
}

console.log('■ timetable: grid ↔ items 변환')
{
  const grid = { mon: ['국어', '', '수학', '', '', '', ''], tue: ['', '영어', '', '', '', '', ''], wed: ['', '', '', '', '', '', ''], thu: ['', '', '', '', '', '', ''], fri: ['', '', '', '', '', '', ''] }
  const tGrid = { mon: ['김철수', '', '', '', '', '', ''], tue: ['', '', '', '', '', '', ''], wed: ['', '', '', '', '', '', ''], thu: ['', '', '', '', '', '', ''], fri: ['', '', '', '', '', '', ''] }
  const items = gridToItems(grid as any, tGrid as any)
  eq('items 수', items.length, 3)
  eq('첫 item', items[0], { id: '월-1', day: '월', period: 1, subject: '국어', teacher: '김철수' })
  const cells = itemsToCells(items)
  eq('roundtrip 월1 과목', cells.mon[0].subject, '국어')
  eq('roundtrip 월1 교사', cells.mon[0].teacher, '김철수')
  eq('roundtrip 화2 과목', cells.tue[1].subject, '영어')
  eq('빈 칸', cells.fri[6].subject, '')
}

console.log('■ timetable: 모바일 legacy 포맷 정규화 (period 없이 id만)')
{
  const legacy = [
    { id: 'tt-월-3', day: '월', subject: '과학' },       // id 끝에서 교시 추출
    { id: '화-2', day: '화', subject: '체육', teacher: '최강' },
    { id: 'bad', day: '없는요일', subject: 'X' },        // 버려짐
    { id: '수-9', day: '수', subject: '초과교시' },      // MAX 초과 — 버려짐
    { day: '금', period: 5, subject: '음악' },           // id 없어도 period 사용
  ]
  const items = normalizeItems(legacy as any[])
  eq('유효 항목 수', items.length, 3)
  eq('id 파싱 교시', items[0].period, 3)
  eq('id 재생성', items[0].id, '월-3')
  eq('period 필드 우선', periodOf({ period: 4, id: '월-9' }), 4)
}

console.log('■ timetable: 교사 시간표 도출')
{
  const classes = [
    { classId: 'S_1_1', label: '1-1', items: normalizeItems([{ id: '월-1', day: '월', period: 1, subject: '국어', teacher: '김철수' }]) },
    { classId: 'S_1_2', label: '1-2', items: normalizeItems([{ id: '월-2', day: '월', period: 2, subject: '국어', teacher: '김철수' }, { id: '화-1', day: '화', period: 1, subject: '수학', teacher: '이영희' }]) },
  ]
  const g = deriveTeacherSchedule(classes, '김철수')
  eq('월1', g.mon[0], { subject: '국어', classLabel: '1-1' })
  eq('월2', g.mon[1], { subject: '국어', classLabel: '1-2' })
  eq('타 교사 수업 제외', g.tue[0], null)
}

console.log('■ timetable: classId')
{
  eq('생성', classIdOf('7010084', 1, 3), '7010084_1_3')
  eq('파싱', parseClassId('7010084_1_3'), { schoolCode: '7010084', grade: 1, classNm: 3 })
  eq('언더스코어 학교코드', parseClassId('demo_school_2_5'), { schoolCode: 'demo_school', grade: 2, classNm: 5 })
}

console.log('■ timetable: 주 계산')
{
  eq('월요일', mondayOf(new Date('2026-08-22T12:00:00')), '2026-08-17') // 토요일 → 그 주 월요일
  eq('월요일 자신', mondayOf(new Date('2026-08-17T09:00:00')), '2026-08-17')
  eq('다음 주', nextMondayOf(new Date('2026-08-22T12:00:00')), '2026-08-24')
}

console.log('■ uploadParse: TSV 붙여넣기')
{
  const tsv = '학년\t반\t요일\t교시\t과목\t선생님\n1\t1\t월\t1\t국어\t김철수\n1\t1\t월\t2\t수학\t이영희\n1\t2\t화\t1\t영어\t박민준\n2\t1\tmon\t3\t과학\t\n'
  const parsed = parseTable(splitDelimited(tsv))
  eq('에러 없음', parsed.errors, [])
  eq('행 수', parsed.rows.length, 4)
  eq('영문 요일 별칭', parsed.rows[3].day, '월')
  const bundles = groupRows(parsed.rows)
  eq('반 묶음 수', bundles.length, 3)
  eq('정렬(1-1 먼저)', `${bundles[0].grade}-${bundles[0].classNm}`, '1-1')
  eq('teacher 생략 허용', bundles[2].items[0].teacher, undefined)
}

console.log('■ uploadParse: 검증 에러')
{
  const bad = [
    ['7', '1', '월', '1', '국어'],      // 학년 범위 초과
    ['1', '99', '월', '1', '국어'],     // 반 범위 초과
    ['1', '1', '토', '1', '국어'],      // 주말
    ['1', '1', '월', '8', '국어'],      // 교시 초과
    ['1', '1', '월', '1', ''],          // 과목 없음
    ['1', '1', '월', '1', '국어'],      // 정상
    ['1', '1', '월', '1', '수학'],      // 중복 (경고 + 마지막 값)
  ]
  const parsed = parseTable(bad as any)
  // 유효성 에러 5건 + 중복 경고 1건 = 6건
  eq('에러·경고 6건', parsed.errors.length, 6)
  eq('유효 2행', parsed.rows.length, 2)
  const bundles = groupRows(parsed.rows)
  eq('중복은 마지막 값', bundles[0].items[0].subject, '수학')
  eq('셀 1개만', bundles[0].items.length, 1)
}

console.log('■ uploadParse: CSV')
{
  const csv = '1,1,월,1,국어,김철수\n1,1,월,2,"수학",이영희'
  const parsed = parseTable(splitDelimited(csv))
  eq('CSV 행', parsed.rows.length, 2)
  eq('따옴표 제거', parsed.rows[1].subject, '수학')
}

console.log(`\n결과: ${pass} 통과, ${fail} 실패`)
process.exit(fail ? 1 : 0)
