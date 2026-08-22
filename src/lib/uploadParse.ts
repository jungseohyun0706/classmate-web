/**
 * 시간표 업로드 파서 — [학년, 반, 요일, 교시, 과목, 선생님?] 목록형 데이터를
 * 반별 TimetableItem[] 묶음으로 변환한다. (엑셀/CSV/TSV/붙여넣기 공용)
 */
import { MAX_PERIODS, type DayKo, type TimetableItem } from './timetable'

export interface ParsedRow {
  line: number
  grade: number
  classNm: number
  day: DayKo
  period: number
  subject: string
  teacher?: string
}

export interface ParseResult {
  rows: ParsedRow[]
  errors: string[]
}

export const DAY_ALIASES: Record<string, DayKo> = {
  월: '월', 화: '화', 수: '수', 목: '목', 금: '금',
  월요일: '월', 화요일: '화', 수요일: '수', 목요일: '목', 금요일: '금',
  mon: '월', tue: '화', wed: '수', thu: '목', fri: '금',
}

/** [학년, 반, 요일, 교시, 과목, 선생님?] 형태의 2차원 배열 파싱 */
export function parseTable(table: (string | number | null | undefined)[][]): ParseResult {
  const rows: ParsedRow[] = []
  const errors: string[] = []
  const seen = new Set<string>()

  table.forEach((cols, i) => {
    const line = i + 1
    const raw = (cols || []).map((c) => String(c ?? '').trim())
    if (raw.every((c) => !c)) return // 빈 줄

    const [gradeS, classS, dayS, periodS, subject, teacher] = raw

    // 헤더 감지: 학년 칸이 숫자가 아니면 스킵
    if (i === 0 && (isNaN(Number(gradeS)) || gradeS === '')) return

    const grade = Number(gradeS)
    const classNm = Number(classS)
    const day = DAY_ALIASES[(dayS || '').toLowerCase()]
    const period = Number(periodS)

    if (!Number.isInteger(grade) || grade < 1 || grade > 6) {
      errors.push(`${line}행: 학년(${gradeS})이 올바르지 않습니다.`)
      return
    }
    if (!Number.isInteger(classNm) || classNm < 1 || classNm > 30) {
      errors.push(`${line}행: 반(${classS})이 올바르지 않습니다.`)
      return
    }
    if (!day) {
      errors.push(`${line}행: 요일(${dayS})은 월~금으로 입력해 주세요.`)
      return
    }
    if (!Number.isInteger(period) || period < 1 || period > MAX_PERIODS) {
      errors.push(`${line}행: 교시(${periodS})는 1~${MAX_PERIODS} 사이여야 합니다.`)
      return
    }
    if (!subject) {
      errors.push(`${line}행: 과목이 비어 있습니다.`)
      return
    }
    const key = `${grade}-${classNm}-${day}-${period}`
    if (seen.has(key)) {
      errors.push(`${line}행: ${grade}학년 ${classNm}반 ${day} ${period}교시가 중복 입력되었습니다. (마지막 값 사용)`)
    }
    seen.add(key)
    rows.push({ line, grade, classNm, day, period, subject, teacher: teacher || undefined })
  })

  return { rows, errors }
}

export function splitDelimited(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const delim = line.includes('\t') ? '\t' : ','
      return line.split(delim).map((c) => c.replace(/^"|"$/g, ''))
    })
}

export type ClassBundle = {
  grade: number
  classNm: number
  items: TimetableItem[]
}

export function groupRows(rows: ParsedRow[]): ClassBundle[] {
  const map = new Map<string, ClassBundle>()
  for (const r of rows) {
    const key = `${r.grade}_${r.classNm}`
    if (!map.has(key)) map.set(key, { grade: r.grade, classNm: r.classNm, items: [] })
    const bundle = map.get(key)!
    // 중복 키는 마지막 값 우선
    const idx = bundle.items.findIndex((it) => it.day === r.day && it.period === r.period)
    const item: TimetableItem = {
      id: `${r.day}-${r.period}`,
      day: r.day,
      period: r.period,
      subject: r.subject,
      ...(r.teacher ? { teacher: r.teacher } : {}),
    }
    if (idx >= 0) bundle.items[idx] = item
    else bundle.items.push(item)
  }
  return Array.from(map.values()).sort((a, b) => a.grade - b.grade || a.classNm - b.classNm)
}
