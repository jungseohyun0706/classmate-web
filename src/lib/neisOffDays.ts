/**
 * NEIS 학사일정(SchoolSchedule) 행 판정 — 순수 함수(fetch·캐시 없음). 단위 테스트(tests/unit/teacher-home-offdays.test.ts)가 직접 씀.
 * src/lib/neis.ts가 같은 이름으로 다시 내보냄(예전 import 경로 호환).
 */

/** NEIS 응답 행(neis.ts NeisRow와 같은 모양) */
type NeisRow = Record<string, string>

// NEIS 학사일정의 학년별 해당 여부 필드: ONE_GRADE_EVENT_YN ~ SIX_GRADE_EVENT_YN
export const GRADE_EVENT_FIELDS = ['ONE', 'TW', 'THREE', 'FR', 'FIV', 'SIX'].map(
  (g) => `${g}_GRADE_EVENT_YN`
)

/**
 * 학사일정(SchoolSchedule) 행 하나가 등교하지 않는 날을 뜻하는지 판정합니다.
 * - 수업공제일(SBTR_DD_SC_NM)이 '휴업일'(재량휴업·방학 등)이나 '공휴일'(한글날 같은 국경일)이면 쉬는 날
 * - 수업공제일이 비어 있거나 '해당없음'이어도 행사명(EVENT_NM)에 '방학'이 있으면 쉬는 날. 단 '방학식'은 등교하는 날
 * - 특정 학년만 해당하는 행(*_GRADE_EVENT_YN)은 그 학년에만 적용합니다.
 *   학년 표시가 없거나 grade를 모르면 학교 전체가 쉬는 것으로 봅니다.
 */
export function isOffDayRow(row: NeisRow, grade?: unknown): boolean {
  if (!isOffKindRow(row)) return false
  const flags = GRADE_EVENT_FIELDS.map((f) => row[f])
  if (!flags.includes('Y')) return true
  const g = Number(grade)
  const mine = Number.isInteger(g) && g >= 1 && g <= 6 ? flags[g - 1] : undefined
  return mine !== 'N'
}

/** 학년 표시와 상관없이 쉬는 날 종류의 행인지(휴업일·공휴일·방학. '방학식'은 아님) */
function isOffKindRow(row: NeisRow): boolean {
  const kind = (row.SBTR_DD_SC_NM || '').trim()
  const eventName = row.EVENT_NM || ''
  // NEIS는 수업공제가 없는 행을 빈 값 대신 '해당없음'으로 보내기도 함
  const noSbtr = kind === '' || kind === '해당없음'
  return kind === '휴업일' || kind === '공휴일' || (noSbtr && eventName.includes('방학') && !eventName.includes('방학식'))
}

/**
 * 쉬는 날 행이 해당하는 학년: 'all'(학년 표시 없음 = 학교 전체) 또는 'Y'인 학년 목록(1~6). 쉬는 날 행이 아니면 null.
 * 한 학년에 묶이지 않는 교사 화면용(학생은 isOffDayRow(row, 내 학년)).
 */
export function offDayGradesOfRow(row: NeisRow): 'all' | number[] | null {
  if (!isOffKindRow(row)) return null
  const grades = GRADE_EVENT_FIELDS.map((f, i) => (row[f] === 'Y' ? i + 1 : 0)).filter((g) => g > 0)
  return grades.length ? grades : 'all'
}

/** 그 날 일부 학년만 쉬는 날(교사 화면) */
export interface GradeOffDay {
  name: string
  /** 쉬는 학년(오름차순, 1~6) */
  grades: number[]
}

/**
 * 교사용 날짜별 쉬는 날. 학생처럼 '내 학년' 하나로 정하지 않습니다(교사 수업은 여러 학년에 걸침).
 * - offDays: 학교 전체가 쉬는 날 — 학년 표시가 없거나, 그 날 쉬는 학년이 학교의 모든 학년(gradeCount: 초 6, 중·고 3)을 덮음
 * - gradeOffDays: 일부 학년만 쉬는 날(예: '3학년 재량휴업일') — 그 학년 수업만 열리지 않음(화면이 수업 학년으로 거름)
 * 행에 날짜(AA_YMD)가 없으면 isOffDay처럼 모든 날짜에 적용합니다.
 */
export function teacherOffDaysFromRows(
  rows: NeisRow[],
  dates: string[],
  gradeCount: number
): { offDays: Record<string, { name: string } | null>; gradeOffDays: Record<string, GradeOffDay> } {
  const offDays: Record<string, { name: string } | null> = {}
  const gradeOffDays: Record<string, GradeOffDay> = {}
  const count = Math.min(6, Math.max(1, Math.floor(gradeCount) || 6))
  for (const ymd of dates) {
    let wholeName: string | null = null
    let partName: string | null = null
    const grades = new Set<number>()
    for (const r of rows) {
      if (r.AA_YMD && r.AA_YMD !== ymd) continue
      const g = offDayGradesOfRow(r)
      if (!g) continue
      const name = String(r.EVENT_NM || '').trim() || '쉬는 날'
      if (g === 'all') {
        if (wholeName === null) wholeName = name
        continue
      }
      g.forEach((x) => grades.add(x))
      if (partName === null) partName = name
    }
    const covered = grades.size > 0 && Array.from({ length: count }, (_, i) => i + 1).every((x) => grades.has(x))
    if (wholeName !== null || covered) {
      offDays[ymd] = { name: wholeName ?? partName ?? '쉬는 날' }
      continue
    }
    offDays[ymd] = null
    if (grades.size) gradeOffDays[ymd] = { name: partName ?? '쉬는 날', grades: Array.from(grades).sort((a, b) => a - b) }
  }
  return { offDays, gradeOffDays }
}

/**
 * 학사일정 행 중 ymd(YYYYMMDD)에 해당하는 쉬는 날 행(isOffDayRow)이 있으면 true.
 * 조회 실패(빈 배열)면 false라서 호출하는 쪽은 평소처럼 처리합니다.
 */
export function isOffDay(rows: NeisRow[], ymd: string, grade?: unknown): boolean {
  return rows.some((r) => (!r.AA_YMD || r.AA_YMD === ymd) && isOffDayRow(r, grade))
}
