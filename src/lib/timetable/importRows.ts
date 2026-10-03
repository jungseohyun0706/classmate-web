/**
 * 시간표·수강 명단 가져오기의 '정규화 행' (순수 함수 — 브라우저·서버 공용, Firebase 의존 없음)
 *
 * - ImportRow: 시간표 파일의 '실제로 있던 칸' 하나 = 수업 한 칸. 어느 시트·행·열에서 왔는지 남깁니다.
 *   (src/lib/timetable/importMatch.ts의 ImportRow와 같은 모양 — 순환 import를 피하려고 여기 따로 정의)
 * - mapTableRows: 원본 열 구조를 모를 때 교사가 고른 열 매핑으로 '표 형식'(행 = 수업 1개)을 읽습니다.
 * - mapRosterRows / normalizeRosterRow: 학생별 수강 명단(행 = 학생 × 수업 1개).
 *
 * 공백·표기 정규화만 합니다. 이름이 비슷하다고 같은 수업·같은 사람으로 합치지 않습니다(그건 매칭 단계의 일).
 * 행·열 번호는 엑셀 화면에 보이는 번호(1부터, 열 1 = A)입니다.
 */
import type { Weekday } from './types'

export type ImportSourceKind = 'class' | 'teacher' | 'room' | 'table'

export interface ImportRow {
  /** 학급표 'class'(전체시간표 포함), 교사표 'teacher'(주간시간표 포함), 특별실표 'room', 표 형식 'table' */
  sourceKind: ImportSourceKind
  /** 시트 이름(여러 파일이면 '파일명#시트명') */
  sheet: string
  /** 원본 행 번호(1부터) */
  row: number
  /** 원본 열 번호(1부터, 1 = A) */
  col?: number
  weekday: Weekday
  /** 교시(8교시 이상도 그대로) */
  period: number
  /** 과목 원문(분반 접두어 'A_' 등 그대로 — cleanSubject 적용 안 함) */
  subject: string
  section?: string
  teacher?: string
  /** '3-4' 형식으로 읽히면 그 값, 아니면 원문 */
  classLabel?: string
  room?: string
  /** 'HH:MM' */
  start?: string
  end?: string
  /** 표 형식에서 '수업 코드' 열을 고른 경우 원문 */
  code?: string
}

/** 엑셀 셀 값(sheet_to_json raw:false 결과) */
export type RawCell = string | number | boolean | null | undefined

export interface RowProblem {
  sheet: string
  /** 원본 행 번호(1부터). 0이면 행이 아니라 매핑 자체의 문제 */
  row: number
  col?: number
  field: string
  severity: 'error' | 'warning'
  message: string
  /** 고칠 방법 */
  fix: string
}

// ───────────────────────── 기본 정규화 ─────────────────────────

export const cellStr = (v: RawCell): string => (v === null || v === undefined ? '' : String(v).replace(/\r/g, '').trim())

/** 보이지 않는 문자·연속 공백 정리(줄바꿈도 공백 하나로) */
export function normSpace(v: RawCell): string {
  return cellStr(v)
    .replace(/[​-‍﻿]/g, '')
    .replace(/[ 　]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 비교용 키: 공백을 모두 없애고 영문 대소문자 통일. 같은 개체 확정이 아니라 '표기 차이'만 없앰 */
export function compareKey(v: RawCell): string {
  return normSpace(v).replace(/\s+/g, '').toUpperCase()
}

const KO_DAYS = ['월', '화', '수', '목', '금', '토', '일']
const EN_DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']

/**
 * 요일 표기 → ISO 요일(월=1 … 일=7).
 * '월', '월요일', '(월)', 'Mon', 'MONDAY'. 숫자는 numeric이 켜졌을 때만 월=1 … 일=7로 읽음(학교마다 규칙이 달라 추정하지 않음)
 */
export function parseWeekdayText(v: RawCell, opts: { numeric?: boolean } = {}): Weekday | null {
  const t = normSpace(v).replace(/[()（）\s]/g, '')
  if (!t) return null
  const ko = t.replace(/요일$/, '')
  const ki = KO_DAYS.indexOf(ko)
  if (ki >= 0) return (ki + 1) as Weekday
  const en = t.toUpperCase().slice(0, 3)
  if (/^[A-Z]{3,9}\.?$/.test(t.toUpperCase())) {
    const ei = EN_DAYS.indexOf(en)
    if (ei >= 0) return (ei + 1) as Weekday
  }
  if (opts.numeric && /^[1-7]$/.test(t)) return Number(t) as Weekday
  return null
}

export const MAX_PERIOD = 20

/**
 * 교시 표기 → 교시 번호 목록. '3', '3교시', '제3교시', '03', 3 → [3]
 * 여러 교시로 이어진 수업: '3~4', '3-4교시', '3,4' → [3, 4] (최대 4교시 연속)
 */
export function parsePeriodText(v: RawCell): number[] | null {
  const t = normSpace(v).replace(/\s+/g, '').replace(/^제/, '').replace(/교시$/, '')
  if (!t) return null
  let m = /^(\d{1,2})$/.exec(t)
  if (m) {
    const p = Number(m[1])
    return p >= 1 && p <= MAX_PERIOD ? [p] : null
  }
  m = /^(\d{1,2})(?:교시)?[~\-–](\d{1,2})$/.exec(t)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    if (a < 1 || b > MAX_PERIOD || b < a || b - a > 3) return null
    const out: number[] = []
    for (let p = a; p <= b; p++) out.push(p)
    return out
  }
  if (/^\d{1,2}(,\d{1,2}){1,3}$/.test(t)) {
    const list = t.split(',').map(Number)
    if (list.some((p) => p < 1 || p > MAX_PERIOD)) return null
    return Array.from(new Set(list)).sort((a, b) => a - b)
  }
  return null
}

/** 시각 표기 → 'HH:MM'. '9:10', '09:10:00', '오후 1:30', '1:30 PM' */
export function parseTimeText(v: RawCell): string | null {
  const t = normSpace(v)
  if (!t) return null
  const m = /^(오전|오후|AM|PM)?\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|오전|오후)?$/i.exec(t)
  if (!m) return null
  let h = Number(m[2])
  const min = Number(m[3])
  const ap = (m[1] || m[4] || '').toUpperCase()
  if (ap === 'PM' || ap === '오후') {
    if (h < 12) h += 12
  } else if ((ap === 'AM' || ap === '오전') && h === 12) h = 0
  if (h > 23 || min > 59) return null
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

/** '09:10~09:55', '9:10-9:55' → { start, end } */
export function parseTimeRange(v: RawCell): { start: string; end: string } | null {
  const parts = normSpace(v).split(/\s*[~\-–]\s*/)
  if (parts.length !== 2) return null
  const start = parseTimeText(parts[0])
  const end = parseTimeText(parts[1])
  return start && end ? { start, end } : null
}

/**
 * 학년·반 표기 → '3-4'. '3-4', '3학년 4반', '3학년4반', '03-04', '3/4', 3자리 반코드 '304'(컴시간 표기).
 * 읽지 못하면 null (원문은 호출하는 쪽이 판단)
 */
export function normalizeClassLabel(v: RawCell): string | null {
  const t = normSpace(v).replace(/\s+/g, '')
  if (!t) return null
  let m = /^(\d{1,2})학년(\d{1,2})반$/.exec(t)
  if (m) return `${Number(m[1])}-${Number(m[2])}`
  m = /^(\d{1,2})[-/](\d{1,2})(?:반)?$/.exec(t)
  if (m) return `${Number(m[1])}-${Number(m[2])}`
  m = /^(\d)(\d{2})$/.exec(t)
  if (m) return `${Number(m[1])}-${Number(m[2])}`
  return null
}

/** '조혜선(15)' → '조혜선' (교사표의 시수 표기 제거) + 공백 정리 */
export function normalizeTeacherName(v: RawCell): string {
  return normSpace(v).replace(/\s*\(\d+\)\s*$/, '').trim()
}

const intIn = (v: RawCell, suffix: RegExp, min: number, max: number): number | null => {
  const t = normSpace(v).replace(/\s+/g, '').replace(suffix, '')
  if (!/^\d{1,3}$/.test(t)) return null
  const n = Number(t)
  return n >= min && n <= max ? n : null
}

/** '3', '3학년', '03' → 3 */
export const parseGrade = (v: RawCell): number | null => intIn(v, /학년$/, 1, 12)
/** '4', '4반', '04' → 4 */
export const parseClassNm = (v: RawCell): number | null => intIn(v, /반$/, 1, 99)
/** '12', '12번' → 12 */
export const parseStudentNo = (v: RawCell): number | null => intIn(v, /번$/, 1, 199)

// ───────────────────────── 머리글 도우미 ─────────────────────────

/** 머리글 행 추정: 위에서부터 글자가 든 칸이 2개 이상인 첫 행(교사가 화면에서 바꿀 수 있음) */
export function guessHeaderRow(grid: RawCell[][], maxScan = 20): number {
  for (let r = 0; r < Math.min(grid.length, maxScan); r++) {
    const filled = (grid[r] || []).filter((c) => normSpace(c) !== '').length
    if (filled >= 2) return r
  }
  return 0
}

type HeaderHints<K extends string> = Record<K, RegExp>

function suggestByHeader<K extends string>(headerRow: RawCell[], hints: HeaderHints<K>): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {}
  const used = new Set<number>()
  ;(Object.keys(hints) as K[]).forEach((key) => {
    for (let c = 0; c < headerRow.length; c++) {
      if (used.has(c)) continue
      const h = normSpace(headerRow[c]).replace(/\s+/g, '')
      if (h && hints[key].test(h)) {
        out[key] = c
        used.add(c)
        return
      }
    }
  })
  return out
}

// ───────────────────────── 표 형식(행 = 수업 1개) ─────────────────────────

/** 값 = 머리글 행의 열 인덱스(0부터). null/undefined = 고르지 않음 */
export interface TableMapping {
  weekday: number | null
  period: number | null
  subject: number | null
  section?: number | null
  teacher?: number | null
  classLabel?: number | null
  room?: number | null
  start?: number | null
  end?: number | null
  code?: number | null
}

export const TABLE_FIELDS: { key: keyof TableMapping; label: string; required: boolean }[] = [
  { key: 'weekday', label: '요일', required: true },
  { key: 'period', label: '교시', required: true },
  { key: 'subject', label: '과목', required: true },
  { key: 'section', label: '분반', required: false },
  { key: 'teacher', label: '교사', required: false },
  { key: 'classLabel', label: '학급(학년-반)', required: false },
  { key: 'room', label: '교실·장소', required: false },
  { key: 'start', label: '시작 시각', required: false },
  { key: 'end', label: '종료 시각', required: false },
  { key: 'code', label: '수업 코드', required: false },
]

/** 머리글 이름으로 열 매핑 '제안'(확정 아님 — 화면에서 교사가 확인·수정) */
export function suggestTableMapping(headerRow: RawCell[]): TableMapping {
  const s = suggestByHeader(headerRow, {
    code: /(수업|강좌|과목)?코드|^code$/i,
    weekday: /요일|^day$/i,
    period: /교시|^period$/i,
    section: /분반|반명|^section$/i,
    subject: /과목|교과|강좌|^subject$/i,
    teacher: /교사|선생|담당|^teacher$/i,
    classLabel: /학급|학년반|^반$|^class$/i,
    room: /교실|장소|특별실|강의실|^room$/i,
    start: /시작|^start$/i,
    end: /종료|끝|^end$/i,
  } as HeaderHints<keyof TableMapping>)
  return {
    weekday: s.weekday ?? null,
    period: s.period ?? null,
    subject: s.subject ?? null,
    section: s.section ?? null,
    teacher: s.teacher ?? null,
    classLabel: s.classLabel ?? null,
    room: s.room ?? null,
    start: s.start ?? null,
    end: s.end ?? null,
    code: s.code ?? null,
  }
}

export interface TableMapOptions {
  /** 시트 이름(출처 기록용) */
  sheet?: string
  /** dataRows[0]의 원본 행 번호(1부터). 기본 2 (1행이 머리글) */
  firstDataRow?: number
  /** grid 열 0의 원본 열 번호(1부터). 기본 1 */
  firstCol?: number
  /** 요일 열이 숫자일 때 월=1 … 일=7로 읽기(교사가 명시한 경우만) */
  numericWeekday?: boolean
}

export interface TableMapResult {
  rows: ImportRow[]
  problems: RowProblem[]
  skipped: { blank: number; repeatedHeader: number }
}

/** 매핑 자체 검사(필수 열·같은 열 중복) */
export function validateTableMapping(mapping: TableMapping, headerLength: number): string[] {
  const errs: string[] = []
  const seen = new Map<number, string>()
  for (const f of TABLE_FIELDS) {
    const c = mapping[f.key]
    if (c === null || c === undefined) {
      if (f.required) errs.push(`'${f.label}' 열을 골라 주세요.`)
      continue
    }
    if (!Number.isInteger(c) || c < 0 || (headerLength > 0 && c >= headerLength + 50)) {
      errs.push(`'${f.label}' 열 선택이 올바르지 않아요.`)
      continue
    }
    const prev = seen.get(c)
    // 시작·종료가 한 칸('09:10~09:55')에 함께 있는 경우만 같은 열 허용
    if (prev && !((prev === '시작 시각' && f.key === 'end') || (prev === '종료 시각' && f.key === 'start'))) {
      errs.push(`'${prev}'와 '${f.label}'에 같은 열을 골랐어요.`)
    } else seen.set(c, f.label)
  }
  return errs
}

/**
 * 표 형식 시트를 ImportRow로. 행마다 수업 1개(교시가 '3~4'면 교시마다 한 행씩).
 * 빈 행·반복 머리글은 건너뛰고, 읽지 못한 칸은 problems에 행 번호와 고칠 방법을 남깁니다(조용히 버리지 않음).
 */
export function mapTableRows(
  headerRow: RawCell[],
  dataRows: RawCell[][],
  mapping: TableMapping,
  opts: TableMapOptions = {}
): TableMapResult {
  const sheet = opts.sheet || '표'
  const firstDataRow = opts.firstDataRow ?? 2
  const firstCol = opts.firstCol ?? 1
  const out: TableMapResult = { rows: [], problems: [], skipped: { blank: 0, repeatedHeader: 0 } }
  const mapErrs = validateTableMapping(mapping, headerRow.length)
  if (mapErrs.length) {
    mapErrs.forEach((m) =>
      out.problems.push({ sheet, row: 0, field: 'mapping', severity: 'error', message: m, fix: '열 매핑에서 다시 골라 주세요.' })
    )
    return out
  }
  const colOf = (k: keyof TableMapping) => {
    const c = mapping[k]
    return c === null || c === undefined ? null : c
  }
  const mappedCols = TABLE_FIELDS.map((f) => colOf(f.key)).filter((c): c is number => c !== null)
  const headerKeys = mappedCols.map((c) => compareKey(headerRow[c]))

  dataRows.forEach((cells, i) => {
    const rowNo = firstDataRow + i
    const row = cells || []
    const get = (k: keyof TableMapping): RawCell => {
      const c = colOf(k)
      return c === null ? null : row[c]
    }
    const colNo = (k: keyof TableMapping) => {
      const c = colOf(k)
      return c === null ? undefined : c + firstCol
    }
    if (mappedCols.every((c) => normSpace(row[c]) === '')) {
      out.skipped.blank++
      return
    }
    // 여러 쪽으로 나뉜 표의 반복 머리글
    if (headerKeys.some((h) => h !== '') && mappedCols.every((c, j) => compareKey(row[c]) === headerKeys[j])) {
      out.skipped.repeatedHeader++
      return
    }
    const problem = (field: keyof TableMapping, severity: RowProblem['severity'], message: string, fix: string) =>
      out.problems.push({ sheet, row: rowNo, col: colNo(field), field, severity, message, fix })

    let ok = true
    const weekday = parseWeekdayText(get('weekday'), { numeric: opts.numericWeekday })
    if (!weekday) {
      ok = false
      const raw = normSpace(get('weekday'))
      problem(
        'weekday',
        'error',
        raw ? `요일 '${raw}'을(를) 읽지 못했어요.` : '요일이 비어 있어요.',
        /^\d$/.test(raw) && !opts.numericWeekday
          ? "요일이 숫자라면 '요일 열이 숫자예요(월=1 … 일=7)'를 켜 주세요."
          : "'월'·'화요일'·'Mon'처럼 적어 주세요."
      )
    }
    const periods = parsePeriodText(get('period'))
    if (!periods) {
      ok = false
      const raw = normSpace(get('period'))
      problem(
        'period',
        'error',
        raw ? `교시 '${raw}'을(를) 읽지 못했어요.` : '교시가 비어 있어요.',
        `1~${MAX_PERIOD} 사이 숫자('3', '3교시') 또는 이어진 교시('3~4')로 적어 주세요.`
      )
    }
    const subject = normSpace(get('subject'))
    if (!subject) {
      ok = false
      problem('subject', 'error', '과목이 비어 있어요.', '과목 칸을 채우거나 이 행을 지워 주세요.')
    }

    let start: string | undefined
    let end: string | undefined
    const rawStart = get('start')
    const rawEnd = get('end')
    const sameTimeCol = colOf('start') !== null && colOf('start') === colOf('end')
    if (normSpace(rawStart)) {
      const range = parseTimeRange(rawStart)
      const single = parseTimeText(rawStart)
      if (range && (sameTimeCol || !normSpace(rawEnd))) {
        start = range.start
        end = range.end
      } else if (single) start = single
      else {
        ok = false
        problem('start', 'error', `시작 시각 '${normSpace(rawStart)}'을(를) 읽지 못했어요.`, "'09:10'처럼 적어 주세요.")
      }
    }
    if (!sameTimeCol && normSpace(rawEnd)) {
      const single = parseTimeText(rawEnd)
      if (single) end = single
      else {
        ok = false
        problem('end', 'error', `종료 시각 '${normSpace(rawEnd)}'을(를) 읽지 못했어요.`, "'09:55'처럼 적어 주세요.")
      }
    }
    if (start && end && start >= end) {
      ok = false
      problem('end', 'error', `종료 시각(${end})이 시작 시각(${start})보다 빨라요.`, '시각을 확인해 주세요.')
    }
    if (periods && periods.length > 1 && (start || end)) {
      problem(
        'period',
        'warning',
        `이어진 교시(${periods.join('·')}교시)에 시각이 하나만 있어요 — 각 교시에 같은 시각을 넣었어요.`,
        '교시마다 시각이 다르면 행을 교시별로 나눠 주세요.'
      )
    }

    let classLabel: string | undefined
    const rawClass = normSpace(get('classLabel'))
    if (rawClass) {
      const parts = rawClass.split(/\s*[,·、]\s*/).filter(Boolean)
      const labels = parts.map((p) => normalizeClassLabel(p))
      if (labels.every((l): l is string => !!l)) classLabel = labels.join(',')
      else {
        classLabel = rawClass
        problem('classLabel', 'warning', `학급 '${rawClass}'을(를) 학년-반으로 읽지 못해 원문 그대로 둬요.`, "'3-4' 또는 '3학년 4반'처럼 적으면 학급과 연결돼요.")
      }
    }

    if (!ok || !weekday || !periods) return
    const base: ImportRow = {
      sourceKind: 'table',
      sheet,
      row: rowNo,
      col: colNo('subject'),
      weekday,
      period: periods[0],
      subject,
    }
    const section = normSpace(get('section'))
    const teacher = normalizeTeacherName(get('teacher'))
    const room = normSpace(get('room'))
    const code = normSpace(get('code'))
    if (section) base.section = section
    if (teacher) base.teacher = teacher
    if (classLabel) base.classLabel = classLabel
    if (room) base.room = room
    if (start) base.start = start
    if (end) base.end = end
    if (code) base.code = code
    periods.forEach((p) => out.rows.push({ ...base, period: p }))
  })
  return out
}

// ───────────────────────── 학생별 수강 명단 ─────────────────────────

/** 명단 한 행(학생 × 수업 1개). 학생 연결은 이름이 아니라 학교·학년·반·번호로만 */
export interface RosterRowInput {
  /** 원본 행 번호(1부터) */
  row: number
  /** 학교가 쓰는 학생 식별값(학번 등) — 원문 보관만, 계정 연결 근거로 쓰지 않음 */
  studentKey?: string
  grade: number
  classNm: number
  /** 출석 번호 */
  number: number
  /** 확인용 이름(연결 근거 아님 — 다르면 경고만) */
  name?: string
  courseCode?: string
  subject?: string
  section?: string
  teacher?: string
}

export interface RosterMapping {
  studentKey?: number | null
  grade: number | null
  classNm: number | null
  number: number | null
  name?: number | null
  courseCode?: number | null
  subject?: number | null
  section?: number | null
  teacher?: number | null
}

export const ROSTER_FIELDS: { key: keyof RosterMapping; label: string; required: boolean }[] = [
  { key: 'grade', label: '학년', required: true },
  { key: 'classNm', label: '반', required: true },
  { key: 'number', label: '번호', required: true },
  { key: 'name', label: '이름(확인용)', required: false },
  { key: 'studentKey', label: '학번(학교 식별값)', required: false },
  { key: 'courseCode', label: '수업 코드', required: false },
  { key: 'subject', label: '과목', required: false },
  { key: 'section', label: '분반', required: false },
  { key: 'teacher', label: '교사', required: false },
]

export const ROSTER_MAX_ROWS = 3000

export function suggestRosterMapping(headerRow: RawCell[]): RosterMapping {
  const s = suggestByHeader(headerRow, {
    studentKey: /학번|학생코드|학생번호|^id$/i,
    grade: /^학년$|^grade$/i,
    classNm: /^반$|^학급$|^class$/i,
    number: /^번호$|출석번호|^번$|^no\.?$/i,
    name: /이름|성명|^name$/i,
    courseCode: /(수업|강좌|과목)코드|^code$/i,
    section: /분반|^section$/i,
    subject: /과목|교과|강좌|^subject$/i,
    teacher: /교사|선생|담당|^teacher$/i,
  } as HeaderHints<keyof RosterMapping>)
  return {
    studentKey: s.studentKey ?? null,
    grade: s.grade ?? null,
    classNm: s.classNm ?? null,
    number: s.number ?? null,
    name: s.name ?? null,
    courseCode: s.courseCode ?? null,
    subject: s.subject ?? null,
    section: s.section ?? null,
    teacher: s.teacher ?? null,
  }
}

export function validateRosterMapping(mapping: RosterMapping): string[] {
  const errs: string[] = []
  for (const f of ROSTER_FIELDS) {
    const c = mapping[f.key]
    if (f.required && (c === null || c === undefined)) errs.push(`'${f.label}' 열을 골라 주세요.`)
    if (c !== null && c !== undefined && (!Number.isInteger(c) || c < 0)) errs.push(`'${f.label}' 열 선택이 올바르지 않아요.`)
  }
  const has = (k: keyof RosterMapping) => mapping[k] !== null && mapping[k] !== undefined
  if (!has('courseCode') && !has('subject')) errs.push("수업을 알 수 있게 '수업 코드' 또는 '과목' 열을 골라 주세요.")
  const seen = new Map<number, string>()
  for (const f of ROSTER_FIELDS) {
    const c = mapping[f.key]
    if (c === null || c === undefined) continue
    const prev = seen.get(c)
    // 학년·반이 한 칸('3-4', '3학년 4반')에 함께 있는 경우만 같은 열 허용
    const gradeClassPair = prev && ((prev === '학년' && f.key === 'classNm') || (prev === '반' && f.key === 'grade'))
    if (prev && !gradeClassPair) errs.push(`'${prev}'와 '${f.label}'에 같은 열을 골랐어요.`)
    else seen.set(c, f.label)
  }
  return errs
}

export interface RosterMapResult {
  rows: RosterRowInput[]
  problems: RowProblem[]
  skipped: { blank: number; repeatedHeader: number }
}

export function mapRosterRows(
  headerRow: RawCell[],
  dataRows: RawCell[][],
  mapping: RosterMapping,
  opts: { sheet?: string; firstDataRow?: number; firstCol?: number } = {}
): RosterMapResult {
  const sheet = opts.sheet || '명단'
  const firstDataRow = opts.firstDataRow ?? 2
  const firstCol = opts.firstCol ?? 1
  const out: RosterMapResult = { rows: [], problems: [], skipped: { blank: 0, repeatedHeader: 0 } }
  const mapErrs = validateRosterMapping(mapping)
  if (mapErrs.length) {
    mapErrs.forEach((m) =>
      out.problems.push({ sheet, row: 0, field: 'mapping', severity: 'error', message: m, fix: '열 매핑에서 다시 골라 주세요.' })
    )
    return out
  }
  const colOf = (k: keyof RosterMapping) => {
    const c = mapping[k]
    return c === null || c === undefined ? null : c
  }
  const mappedCols = ROSTER_FIELDS.map((f) => colOf(f.key)).filter((c): c is number => c !== null)
  const headerKeys = mappedCols.map((c) => compareKey(headerRow[c]))
  const gradeClassSame = colOf('grade') === colOf('classNm')

  dataRows.forEach((cells, i) => {
    const rowNo = firstDataRow + i
    const row = cells || []
    const get = (k: keyof RosterMapping): RawCell => {
      const c = colOf(k)
      return c === null ? null : row[c]
    }
    const colNo = (k: keyof RosterMapping) => {
      const c = colOf(k)
      return c === null ? undefined : c + firstCol
    }
    if (mappedCols.every((c) => normSpace(row[c]) === '')) {
      out.skipped.blank++
      return
    }
    if (headerKeys.some((h) => h !== '') && mappedCols.every((c, j) => compareKey(row[c]) === headerKeys[j])) {
      out.skipped.repeatedHeader++
      return
    }
    const problem = (field: keyof RosterMapping, message: string, fix: string) =>
      out.problems.push({ sheet, row: rowNo, col: colNo(field), field, severity: 'error', message, fix })
    let grade: number | null
    let classNm: number | null
    if (gradeClassSame) {
      const label = normalizeClassLabel(get('grade'))
      grade = label ? Number(label.split('-')[0]) : null
      classNm = label ? Number(label.split('-')[1]) : null
      if (!label) problem('grade', `학년·반 '${normSpace(get('grade'))}'을(를) 읽지 못했어요.`, "'3-4' 또는 '3학년 4반'처럼 적어 주세요.")
    } else {
      grade = parseGrade(get('grade'))
      classNm = parseClassNm(get('classNm'))
      if (!grade) problem('grade', `학년 '${normSpace(get('grade'))}'을(를) 읽지 못했어요.`, "'3' 또는 '3학년'처럼 적어 주세요.")
      if (!classNm) problem('classNm', `반 '${normSpace(get('classNm'))}'을(를) 읽지 못했어요.`, "'4' 또는 '4반'처럼 적어 주세요.")
    }
    const number = parseStudentNo(get('number'))
    if (!number) problem('number', `번호 '${normSpace(get('number'))}'을(를) 읽지 못했어요.`, "출석 번호를 '12'처럼 숫자로 적어 주세요.")
    const courseCode = normSpace(get('courseCode')).slice(0, 60)
    const subject = normSpace(get('subject')).slice(0, 60)
    if (!courseCode && !subject) problem(colOf('courseCode') !== null ? 'courseCode' : 'subject', '수업 코드와 과목이 모두 비어 있어요.', '어느 수업인지 알 수 있게 채워 주세요.')
    if (!grade || !classNm || !number || (!courseCode && !subject)) return
    const r: RosterRowInput = { row: rowNo, grade, classNm, number }
    const studentKey = normSpace(get('studentKey')).slice(0, 30)
    const name = normSpace(get('name')).slice(0, 30)
    const section = normSpace(get('section')).slice(0, 30)
    const teacher = normalizeTeacherName(get('teacher')).slice(0, 60)
    if (studentKey) r.studentKey = studentKey
    if (name) r.name = name
    if (courseCode) r.courseCode = courseCode
    if (subject) r.subject = subject
    if (section) r.section = section
    if (teacher) r.teacher = teacher
    out.rows.push(r)
  })
  return out
}

/** 서버 검증: 클라이언트가 보낸 명단 행을 다시 확인(클라이언트 정규화를 믿지 않음) */
export function normalizeRosterRow(raw: unknown): { row: RosterRowInput | null; error: string | null } {
  if (!raw || typeof raw !== 'object') return { row: null, error: '행 형식이 올바르지 않아요.' }
  const o = raw as Record<string, unknown>
  const rowNo = Number(o.row)
  if (!Number.isInteger(rowNo) || rowNo < 1 || rowNo > 1000000) return { row: null, error: '원본 행 번호가 없어요.' }
  const str = (v: unknown, max: number) => (typeof v === 'string' || typeof v === 'number' ? normSpace(String(v)).slice(0, max) : '')
  const grade = parseGrade(str(o.grade, 10))
  const classNm = parseClassNm(str(o.classNm, 10))
  const number = parseStudentNo(str(o.number, 10))
  const courseCode = str(o.courseCode, 60)
  const subject = str(o.subject, 60)
  const missing: string[] = []
  if (!grade) missing.push('학년')
  if (!classNm) missing.push('반')
  if (!number) missing.push('번호')
  if (!courseCode && !subject) missing.push('수업 코드 또는 과목')
  if (!grade || !classNm || !number || missing.length) {
    return { row: null, error: `${missing.join('·')}을(를) 읽지 못했어요.` }
  }
  const r: RosterRowInput = { row: rowNo, grade, classNm, number }
  const studentKey = str(o.studentKey, 30)
  const name = str(o.name, 30)
  const section = str(o.section, 30)
  const teacher = normalizeTeacherName(str(o.teacher, 60))
  if (studentKey) r.studentKey = studentKey
  if (name) r.name = name
  if (courseCode) r.courseCode = courseCode
  if (subject) r.subject = subject
  if (section) r.section = section
  if (teacher) r.teacher = teacher
  return { row: r, error: null }
}

// ───────────────────────── 파일 읽기(브라우저) ─────────────────────────
// xlsx는 화면에서 동적 import한 모듈을 받아 씁니다(이 파일은 서버에서도 쓰므로 직접 import하지 않음).
// 값만 읽습니다: 수식은 계산된 값만(cellFormula:false), 매크로(VBA)는 읽지도 실행하지도 않습니다.
// 파일 내용은 브라우저 안에서만 읽고 외부 변환 서비스로 보내지 않습니다.

export const IMPORT_ACCEPT = '.xlsx,.xls,.csv'
export const IMPORT_MAX_BYTES = 10 * 1024 * 1024
export const IMPORT_MAX_SHEET_ROWS = 5000
export const IMPORT_MAX_SHEET_COLS = 300

export interface WorkbookSheet {
  /** '파일명#시트명' */
  name: string
  fileName: string
  sheetName: string
  grid: RawCell[][]
  /** grid[0][0]의 원본 위치(0부터) */
  origin: { r: number; c: number }
  merges: { s: { r: number; c: number }; e: { r: number; c: number } }[]
}

export interface ReadFileResult {
  sheets: WorkbookSheet[]
  /** 파일 바이트의 sha256(소문자 16진수) */
  hash: string
  bytes: number
}

/** 파일 이름·크기 검사. 문제가 있으면 한국어 안내, 없으면 null */
export function checkImportFile(file: { name: string; size: number }): string | null {
  if (!/\.(xlsx|xls|csv)$/i.test(file.name)) return `'${file.name}'은(는) 올릴 수 없는 형식이에요. 엑셀(.xlsx, .xls) 또는 CSV 파일만 올려 주세요.`
  if (file.size <= 0) return `'${file.name}'이(가) 비어 있어요.`
  if (file.size > IMPORT_MAX_BYTES) return `'${file.name}'이(가) 너무 커요(최대 10MB). 필요한 시트만 남겨 다시 저장해 주세요.`
  return null
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const subtle = typeof globalThis !== 'undefined' && globalThis.crypto ? globalThis.crypto.subtle : undefined
  if (!subtle) throw new Error('이 브라우저에서는 파일 확인값(sha256)을 계산할 수 없어요. 최신 브라우저에서 다시 시도해 주세요.')
  const view = data instanceof Uint8Array ? data : new Uint8Array(data)
  const copy = new Uint8Array(view.byteLength)
  copy.set(view)
  const digest = await subtle.digest('SHA-256', copy.buffer as ArrayBuffer)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** 여러 파일의 확인값을 하나로(파일 순서와 무관). 파일이 하나면 그 파일의 sha256 그대로 */
export async function combinedHash(hashes: string[]): Promise<string> {
  if (hashes.length === 1) return hashes[0]
  const text = hashes.slice().sort().join('\n')
  return sha256Hex(new TextEncoder().encode(text))
}

/** CSV 글자 인코딩: UTF-8(BOM 포함)로 읽고, 깨지면 EUC-KR(엑셀 한글 CSV 기본) */
function decodeCsv(buf: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '')
  } catch {
    return new TextDecoder('euc-kr').decode(buf)
  }
}

/**
 * 파일 → 시트별 셀 그리드. XLSX = await import('xlsx')
 * 시트 하나가 IMPORT_MAX_SHEET_ROWS행·IMPORT_MAX_SHEET_COLS열을 넘으면 잘라 읽지 않고 오류로 알립니다.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readImportFile(file: File, XLSX: any): Promise<ReadFileResult> {
  const problem = checkImportFile(file)
  if (problem) throw new Error(problem)
  const buf = await file.arrayBuffer()
  const hash = await sha256Hex(buf)
  const opts = { cellFormula: false, cellHTML: false, cellStyles: false, cellNF: false, bookVBA: false, sheetStubs: false }
  const wb = /\.csv$/i.test(file.name)
    ? XLSX.read(decodeCsv(buf), { ...opts, type: 'string', raw: true }) // CSV: '3-4'를 날짜로 바꾸지 않도록 값 그대로
    : XLSX.read(new Uint8Array(buf), { ...opts, type: 'array' })
  const sheets: WorkbookSheet[] = []
  for (const sheetName of wb.SheetNames as string[]) {
    const ws = wb.Sheets[sheetName]
    if (!ws || !ws['!ref']) continue
    const range = XLSX.utils.decode_range(ws['!ref'])
    const rows = range.e.r - range.s.r + 1
    const cols = range.e.c - range.s.c + 1
    if (rows > IMPORT_MAX_SHEET_ROWS || cols > IMPORT_MAX_SHEET_COLS) {
      throw new Error(
        `'${file.name}'의 '${sheetName}' 시트가 너무 커요(${rows}행 × ${cols}열, 최대 ${IMPORT_MAX_SHEET_ROWS}행 × ${IMPORT_MAX_SHEET_COLS}열). 필요한 부분만 남겨 주세요.`
      )
    }
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: true, defval: null, raw: false }) as RawCell[][]
    const merges = Array.isArray(ws['!merges']) ? (ws['!merges'] as WorkbookSheet['merges']) : []
    sheets.push({ name: `${file.name}#${sheetName}`, fileName: file.name, sheetName, grid, origin: { r: range.s.r, c: range.s.c }, merges })
  }
  return { sheets, hash, bytes: buf.byteLength }
}

/** 엑셀 열 이름(1 → A, 27 → AA) */
export function colName(col1: number): string {
  let n = col1
  let s = ''
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s || '?'
}
