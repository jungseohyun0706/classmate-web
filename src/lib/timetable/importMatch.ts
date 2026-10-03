/**
 * 시간표 엑셀 가져오기 — 정규화·매칭·차이 계산 (순수 함수, Firebase 의존 없음, 단위 테스트 대상)
 *
 * 입력은 화면(엑셀 파서)이 만든 '정규화 행'(ImportRow)입니다. 실제 학교 엑셀 자료를 확보하지 못해
 * 열 이름·시트 구조는 여기서 추정하지 않고, 행 하나 = 한 시트의 한 칸(요일·교시)의 수업 하나로 받습니다.
 *
 * 원칙
 *  - 공백·전각 문자 정리는 하지만, 이름이 '비슷하다'는 이유로 서로 다른 값을 합치지 않습니다.
 *  - 같은 차시(같은 요일·교시·교사)가 학급/교사/특별실/전체 자료에 각각 나와도 수업·차시 하나로 합칩니다.
 *    (교사 한 명은 한 시간에 한 곳에만 있을 수 있다는 사실만 근거로 씁니다)
 *  - 세 자료가 서로 다르면 마지막 업로드를 정답으로 쓰지 않고 '검토(review)'로 남깁니다.
 *  - 공통 수업은 담임이 명시한 경우에만: 가져오기는 commonForHomerooms를 쓰지 않습니다(새 수업 [], 기존 수업은 그대로).
 *    분반 없는 한 학급 수업('hr')은 그 학급을 공통 수업 '후보'(importCommon)로만 기록하고, 담임이 /api/courses
 *    setCommon으로 확인해야 학생 시간표에 나타납니다. 분반·여러 학급·학급 미상 수업은 후보도 아닙니다.
 *  - 교사 이름만으로 담당 권한을 연결하지 않습니다: 같은 학교 교사 중 masterName(교사가 스스로 쓰는 값)이 같은 계정은
 *    '연결 후보'일 뿐이고, 발행 교사가 화면에서 확인한 후보(confirmedTeacherUids)만 teacherUids/importLinkedUids에 넣습니다.
 *  - 같은 파일 재업로드·행 순서 변경·수정본이 같은 결정적 id(courseIdFor/seriesIdFor)로 수렴합니다.
 *
 * 브라우저에서도 쓸 수 있게 Node 전용 모듈(crypto 등)을 import하지 않습니다.
 */
import { hmToMinutes } from './dates'
import type { Weekday, Ymd } from './types'

// ───────────────────────── 입력·출력 타입 ─────────────────────────

export type ImportSourceKind = 'class' | 'teacher' | 'room' | 'table'

export const IMPORT_SOURCE_KINDS: ImportSourceKind[] = ['class', 'teacher', 'room', 'table']

/** 화면 → API 계약 (바꾸지 마세요. code/courseCode만 선택 확장 — importRows.ts의 ImportRow와 호환) */
export interface ImportRow {
  sourceKind: ImportSourceKind
  sheet: string
  row: number
  col?: number | null
  /** 1..7 (월=1). normalizeRow는 '월'·'Mon' 같은 원문도 받습니다 */
  weekday: number
  period: number
  /** 원문 과목명 — 분반 접두어('A_화작A') 포함 가능 */
  subject: string
  section?: string | null
  teacher?: string | null
  /** '3-4' 등. '3학년 4반'·'304'·'03-4'도 받음 */
  classLabel?: string | null
  room?: string | null
  start?: string | null
  end?: string | null
  /** (선택) 원본에 안정적인 수업 코드가 있으면 수업 식별에 우선 사용 (importRows.ts의 표 형식 '수업 코드' 열 = code) */
  code?: string | null
  /** code와 같은 뜻(별칭). 둘 다 있으면 code 우선 */
  courseCode?: string | null
}

/** 원문 그대로의 행 (요일·교시가 문자열일 수 있음) */
export type RawImportRow = Omit<ImportRow, 'weekday' | 'period'> & {
  weekday: number | string
  period: number | string
}

export interface SourceRef {
  sheet: string
  row: number
  col: number | null
  sourceKind: ImportSourceKind
}

export interface RowRef {
  sheet: string
  row: number
  col: number | null
}

export type IssueSeverity = 'error' | 'review' | 'info'

export interface ImportIssue {
  severity: IssueSeverity
  code: string
  message: string
  rows: RowRef[]
  fix: string
  /** 이 문제와 관련된 수업(importKey) — 화면 강조·발행 제외 판단용 */
  importKeys: string[]
}

export interface NormalizedRow {
  src: SourceRef
  weekday: Weekday
  period: number
  /** 표시용 과목명(공백 정리, 분반 접두어 제거) */
  subject: string
  /** 원문 과목명(공백만 정리) */
  subjectRaw: string
  subjectKey: string
  section: string | null
  sectionKey: string | null
  teachers: string[]
  teacherKeys: string[]
  classLabel: string | null
  room: string | null
  roomKey: string | null
  start: string | null
  end: string | null
  code: string | null
  codeKey: string | null
}

export interface TeacherAccount {
  uid: string
  /** 교사가 스스로 정한 엑셀 이름 — 연결 '후보'를 찾는 데만 씀(이것만으로 권한을 주지 않음). displayName·name은 후보 근거가 아님 */
  masterName?: string | null
  /** 화면 표시용 이름(users.name/displayName — 교사가 바꿀 수 있는 값이라 신원 확인 근거가 아님) */
  name?: string | null
}

export interface BuildOptions {
  schoolCode: string
  teachers?: TeacherAccount[]
  /** 기본 10 */
  maxPeriod?: number
}

export interface LessonSlot {
  weekday: Weekday
  period: number
  start: string | null
  end: string | null
  roomName: string | null
  teacherNames: string[]
}

/** code: 원본 수업 코드 / sec: 분반 / hr: 한 학급의 수업(공통 수업 후보) / none: 학급·분반 미확인 또는 여러 학급 */
export type ImportKeyKind = 'code' | 'sec' | 'hr' | 'none'

export interface CourseCandidate {
  importKey: string
  keyKind: ImportKeyKind
  title: string
  subject: string
  section: string | null
  teacherNames: string[]
  /** 담당 교사 연결 '후보' 계정(masterName 일치). 발행 교사가 확인한 것만 연결됨 — 그 자체로는 권한 없음 */
  candidateTeacherUids: string[]
  /**
   * 엑셀 교사 이름(키)별 후보 계정. 연결 확인은 (이름키, uid) 쌍으로만 받으므로, 한 이름으로 확인한 계정이
   * 같은 수업의 다른 이름이나 다른 수업으로 번지지 않게 planImport가 이 표로 확인합니다.
   */
  candidateTeacherLinks: Array<{ nameKey: string; uids: string[] }>
  /** 공통 수업 '후보' 학급(분반 없는 한 학급 수업만). 담임이 setCommon으로 확인해야 commonForHomerooms가 됨 */
  commonCandidates: string[]
  classLabels: string[]
  series: LessonSlot[]
  sources: SourceRef[]
  /** 이 수업에 걸린 가장 심각한 문제 — error면 발행 불가, review면 확인(acceptReview) 시 발행에서 제외 */
  blocked: 'error' | 'review' | null
  issueCodes: string[]
}

export interface TeacherLinkCandidate {
  uid: string
  /** 표시용 이름(교사가 바꿀 수 있는 값) */
  name: string | null
}

export interface TeacherLink {
  /** 엑셀의 교사 이름(표시용) */
  name: string
  /** 엑셀 교사 이름의 비교 키(nameKey) — 연결 확인(confirmTeacherLinks)은 이 키와 uid의 쌍으로 보냄 */
  key: string
  /** candidate: 후보 계정 1개, ambiguous: 후보 여럿(동명이인 가능), no-account: 후보 없음(이름만) */
  reason: 'candidate' | 'ambiguous' | 'no-account'
  candidates: TeacherLinkCandidate[]
  /** 이 교사 이름이 나오는 수업 */
  importKeys: string[]
}

export interface BuildStats {
  rows: number
  lessons: number
  duplicatesMerged: number
  errors: number
  review: number
  /** 후보 계정도 없는 교사 이름 수(이름만 표시) */
  unlinkedTeachers: number
  /** 연결 후보 계정이 있는 교사 이름 수(발행 교사 확인 필요) */
  teacherLinkCandidates: number
}

export interface BuildResult {
  courses: CourseCandidate[]
  issues: ImportIssue[]
  stats: BuildStats
  teacherLinks: TeacherLink[]
}

// ───────────────────────── 정규화 도우미 ─────────────────────────

export const MAX_PERIOD = 10

const WEEKDAY_KO = ['', '월', '화', '수', '목', '금', '토', '일']

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

/** 원본 값(교사·과목 이름 등)을 키로 쓰는 사전 — '__proto__' 같은 이름도 안전하게 */
function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

/** 전각→반각(NFKC), 제어 문자 제거, 연속 공백을 하나로, 앞뒤 공백 제거 — 값 자체는 바꾸지 않음 */
export function cleanSpaces(v: unknown): string {
  if (v === null || v === undefined) return ''
  let s = String(v)
  try {
    s = s.normalize('NFKC')
  } catch {
    // normalize가 없는 오래된 환경 — 그대로
  }
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 비교용 키: cleanSpaces + 공백 제거. ('김 민수' = '김민수') 그 밖의 유사 이름은 합치지 않음 */
export function nameKey(v: unknown): string {
  return cleanSpaces(v).replace(/\s+/g, '')
}

const WEEKDAY_WORDS: Record<string, number> = {
  월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6, 일: 7,
  mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6, sun: 7, sunday: 7,
}

/** '월'·'월요일'·'(월)'·'Mon'·'monday'·1·'1' → 1..7. 0이나 8 이상은 모호하므로 null */
export function normalizeWeekday(v: unknown): Weekday | null {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= 7 ? (v as Weekday) : null
  const s = nameKey(v).toLowerCase().replace(/[().[\]]/g, '').replace(/요일$/, '')
  if (!s) return null
  if (/^\d{1,2}$/.test(s)) {
    const n = Number(s)
    return n >= 1 && n <= 7 ? (n as Weekday) : null
  }
  return own(WEEKDAY_WORDS, s) ? (WEEKDAY_WORDS[s] as Weekday) : null
}

/** 3·'3'·'3교시'·'제3교시'·'3교시(10:50)' → 3. 형식이 다르면 null (범위 검사는 normalizeRow에서) */
export function normalizePeriod(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null
  const s = nameKey(v)
  const m = /^제?(\d{1,2})(?:교시)?(?:\(\d{1,2}:\d{2}(?:~\d{1,2}:\d{2})?\))?$/.exec(s)
  return m ? Number(m[1]) : null
}

/** '3학년 4반'·'3-4'·'03-4'·'3-04'·'304'·'3/4'·'3-4반' → '3-4'. 알 수 없으면 null */
export function normalizeClassLabel(v: unknown): string | null {
  const s = nameKey(v)
  if (!s) return null
  const m =
    /^(\d{1,2})학년(\d{1,2})반?$/.exec(s) ||
    /^(\d{1,2})[-_/.](\d{1,2})반?$/.exec(s) ||
    /^0?(\d)(\d{2})$/.exec(s)
  if (!m) return null
  const g = parseInt(m[1], 10)
  const c = parseInt(m[2], 10)
  if (!(g >= 1 && g <= 6) || !(c >= 1 && c <= 99)) return null
  return `${g}-${c}`
}

/** 소속 학급 id — 기존 classes/{schoolCode}_{학년}_{반} 규칙 */
export function classIdFor(schoolCode: string, label: string): string | null {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(label)
  return m ? `${schoolCode}_${parseInt(m[1], 10)}_${parseInt(m[2], 10)}` : null
}

/** 'A_화작A' → { section: 'A', subject: '화작A' } (기존 cleanSubject와 같은 접두어 규칙 ^[A-Z]{1,2}_) */
export function splitSectionPrefix(subject: string): { section: string | null; subject: string } {
  const s = cleanSpaces(subject)
  const m = /^([A-Z]{1,2})_\s*(.+)$/.exec(s)
  return m ? { section: m[1], subject: m[2].trim() } : { section: null, subject: s }
}

/** '김민수(15)' → '김민수', '김민수, 이영희' / '김민수/이영희' → 두 명 */
export function splitTeachers(v: unknown): string[] {
  const s = cleanSpaces(v)
  if (!s) return []
  const out: string[] = []
  s.split(/[,/·;、+]/).forEach((part) => {
    const name = part.replace(/\s*\(\d+\)\s*$/, '').trim()
    if (name && out.indexOf(name) < 0) out.push(name)
  })
  return out
}

function normalizeHm(v: unknown): { ok: boolean; value: string | null } {
  const s = nameKey(v)
  if (!s) return { ok: true, value: null }
  const min = hmToMinutes(s)
  if (min === null) return { ok: false, value: null }
  return { ok: true, value: `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}` }
}

export function locOf(r: RowRef): string {
  return `'${r.sheet}' ${r.row}행${r.col !== null && r.col !== undefined ? ` ${r.col}열` : ''}`
}

const refOf = (s: SourceRef): RowRef => ({ sheet: s.sheet, row: s.row, col: s.col })

function issue(
  severity: IssueSeverity,
  code: string,
  message: string,
  fix: string,
  rows: RowRef[],
  importKeys: string[] = []
): ImportIssue {
  return { severity, code, message, fix, rows, importKeys }
}

/**
 * 행 하나 정규화. 오류가 있으면 row: null (그 행은 매칭에서 빠지고 error 이슈로 남음).
 * 과목·교사·수업 코드가 모두 빈 칸이면 빈 칸으로 보고 조용히 건너뜀(row: null, 이슈 없음).
 */
export function normalizeRow(raw: RawImportRow, opts: { maxPeriod?: number } = {}): { row: NormalizedRow | null; issues: ImportIssue[] } {
  const maxPeriod = opts.maxPeriod ?? MAX_PERIOD
  const issues: ImportIssue[] = []
  const src: SourceRef = {
    sheet: cleanSpaces(raw && raw.sheet) || '(시트 이름 없음)',
    row: typeof raw?.row === 'number' && Number.isFinite(raw.row) ? Math.trunc(raw.row) : 0,
    col: typeof raw?.col === 'number' && Number.isFinite(raw.col) ? Math.trunc(raw.col) : null,
    sourceKind: IMPORT_SOURCE_KINDS.indexOf(raw?.sourceKind) >= 0 ? raw.sourceKind : 'table',
  }
  const ref = refOf(src)
  const loc = locOf(ref)

  const subjectRaw = cleanSpaces(raw?.subject)
  const teachers = splitTeachers(raw?.teacher)
  const code = cleanSpaces(raw?.code) || cleanSpaces(raw?.courseCode) || null
  if (!subjectRaw && !teachers.length && !code) return { row: null, issues }

  if (IMPORT_SOURCE_KINDS.indexOf(raw?.sourceKind) < 0) {
    issues.push(issue('error', 'bad-source-kind', `${loc}: 자료 유형을 알 수 없어요.`, '자료 유형(학급·교사·특별실·전체)을 다시 선택해 주세요.', [ref]))
  }
  const weekday = normalizeWeekday(raw?.weekday)
  if (weekday === null) {
    issues.push(
      issue('error', 'bad-weekday', `${loc}: 요일 '${cleanSpaces(raw?.weekday)}'을(를) 알 수 없어요.`, '요일을 월~일(또는 1~7)로 적어 주세요.', [ref])
    )
  }
  const period = normalizePeriod(raw?.period)
  if (period === null || period < 1 || period > maxPeriod) {
    issues.push(
      issue(
        'error',
        'bad-period',
        `${loc}: 교시 '${cleanSpaces(raw?.period)}'이(가) 1~${maxPeriod}교시 범위를 벗어났거나 형식이 달라요.`,
        `교시를 1~${maxPeriod} 숫자(예: 3 또는 3교시)로 고쳐 주세요. 시트의 교시 머리글 행·열이 밀리지 않았는지도 확인해 주세요.`,
        [ref]
      )
    )
  }

  const prefix = splitSectionPrefix(subjectRaw)
  const explicitSection = cleanSpaces(raw?.section) || null
  if (explicitSection && prefix.section && nameKey(explicitSection) !== nameKey(prefix.section)) {
    issues.push(
      issue(
        'review',
        'section-mismatch',
        `${loc}: 분반 칸('${explicitSection}')과 과목명 접두어('${prefix.section}')가 달라요.`,
        '분반 칸과 과목명 접두어 중 맞는 쪽으로 고쳐 주세요.',
        [ref]
      )
    )
  }
  const section = explicitSection || prefix.section

  const classRaw = cleanSpaces(raw?.classLabel)
  const classLabel = classRaw ? normalizeClassLabel(classRaw) : null
  if (classRaw && !classLabel) {
    issues.push(
      issue(
        'review',
        'bad-class-label',
        `${loc}: 학급 표기 '${classRaw}'을(를) 알 수 없어요.`,
        "학급을 '3-4'·'3학년 4반'·'304' 형식으로 적어 주세요. 학급이 아닌 묶음 코드라면 분반 접두어(예: A_영어)로 적어 주세요.",
        [ref]
      )
    )
  }

  const st = normalizeHm(raw?.start)
  const en = normalizeHm(raw?.end)
  if (!st.ok || !en.ok) {
    issues.push(issue('error', 'bad-time', `${loc}: 시각 형식이 올바르지 않아요.`, '시각을 HH:MM(예: 09:10)으로 적어 주세요.', [ref]))
  } else if (st.value && en.value && (hmToMinutes(en.value) as number) <= (hmToMinutes(st.value) as number)) {
    issues.push(issue('error', 'bad-time', `${loc}: 끝나는 시각이 시작 시각보다 빨라요.`, '시작·끝 시각을 확인해 주세요.', [ref]))
  }

  if (issues.some((i) => i.severity === 'error')) return { row: null, issues }

  const room = cleanSpaces(raw?.room) || null
  return {
    row: {
      src,
      weekday: weekday as Weekday,
      period: period as number,
      subject: prefix.subject,
      subjectRaw,
      subjectKey: nameKey(prefix.subject),
      section: section ? cleanSpaces(section) : null,
      sectionKey: section ? nameKey(section) : null,
      teachers,
      teacherKeys: teachers.map(nameKey).filter((k, i, a) => !!k && a.indexOf(k) === i).sort(),
      classLabel,
      room,
      roomKey: room ? nameKey(room) : null,
      start: st.value,
      end: en.value,
      code,
      codeKey: code ? nameKey(code) : null,
    },
    issues,
  }
}

// ───────────────────────── 결정적 id (SHA-256, 순수 JS) ─────────────────────────

const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

function utf8Bytes(s: string): number[] {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00)
        i++
      }
    }
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

/** SHA-256 16진수 (UTF-8). 브라우저·Node 어디서나 같은 값 */
export function sha256Hex(input: string): string {
  const bytes = utf8Bytes(input)
  const bitLen = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  const hi = Math.floor(bitLen / 0x100000000)
  const lo = bitLen >>> 0
  bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255)
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const w: number[] = new Array(64)
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4
      w[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]
      const y = w[i - 2]
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7]
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K256[i] + w[i]) | 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) | 0
      h = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    H[0] = (H[0] + a) | 0
    H[1] = (H[1] + b) | 0
    H[2] = (H[2] + c) | 0
    H[3] = (H[3] + d) | 0
    H[4] = (H[4] + e) | 0
    H[5] = (H[5] + f) | 0
    H[6] = (H[6] + g) | 0
    H[7] = (H[7] + h) | 0
  }
  return H.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('')
}

/** 수업 id = 'im_' + 해시(학교|학기|importKey) — 같은 수업은 재업로드·순서와 무관하게 같은 문서 */
export function courseIdFor(schoolCode: string, termId: string, importKey: string): string {
  return 'im_' + sha256Hex(`${schoolCode}|${termId}|${importKey}`).slice(0, 24)
}

/** 반복 차시 id = 'is_' + 해시(courseId|요일|교시|적용 시작일) */
export function seriesIdFor(courseId: string, weekday: number, period: number, validFrom: Ymd): string {
  return 'is_' + sha256Hex(`${courseId}|${weekday}|${period}|${validFrom}`).slice(0, 24)
}

// ───────────────────────── 매칭 ─────────────────────────

interface Lesson {
  weekday: Weekday
  period: number
  keyKind: ImportKeyKind
  importKey: string
  subject: string
  subjectKey: string
  section: string | null
  sectionKey: string | null
  classLabels: string[]
  teacherNames: string[]
  teacherKeys: string[]
  roomName: string | null
  start: string | null
  end: string | null
  rows: NormalizedRow[]
}

class IssueBag {
  private map = new Map<string, ImportIssue>()
  add(i: ImportIssue) {
    const k = `${i.severity}|${i.code}|${i.message}`
    const prev = this.map.get(k)
    if (!prev) {
      this.map.set(k, { ...i, rows: i.rows.slice(), importKeys: i.importKeys.slice() })
      return
    }
    i.rows.forEach((r) => prev.rows.push(r))
    i.importKeys.forEach((x) => prev.importKeys.push(x))
  }
  list(): ImportIssue[] {
    const rank: Record<IssueSeverity, number> = { error: 0, review: 1, info: 2 }
    const out = Array.from(this.map.values()).map((i) => ({
      ...i,
      rows: uniqueRefs(i.rows),
      importKeys: uniq(i.importKeys).sort(),
    }))
    out.sort((a, b) => {
      if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity]
      if (a.code !== b.code) return a.code < b.code ? -1 : 1
      const ra = a.rows[0]
      const rb = b.rows[0]
      const c = ra && rb ? compareRef(ra, rb) : ra ? -1 : rb ? 1 : 0
      if (c) return c
      return a.message < b.message ? -1 : a.message > b.message ? 1 : 0
    })
    return out
  }
}

function uniq<T>(arr: T[]): T[] {
  return arr.filter((x, i) => arr.indexOf(x) === i)
}

function compareRef(a: RowRef, b: RowRef): number {
  if (a.sheet !== b.sheet) return a.sheet < b.sheet ? -1 : 1
  if (a.row !== b.row) return a.row - b.row
  return (a.col ?? -1) - (b.col ?? -1)
}

function uniqueRefs(refs: RowRef[]): RowRef[] {
  const seen: Record<string, boolean> = dict()
  const out: RowRef[] = []
  refs.forEach((r) => {
    const k = `${r.sheet}\u0000${r.row}\u0000${r.col}`
    if (seen[k]) return
    seen[k] = true
    out.push({ sheet: r.sheet, row: r.row, col: r.col })
  })
  return out.sort(compareRef)
}

function uniqueSources(src: SourceRef[]): SourceRef[] {
  const seen: Record<string, boolean> = dict()
  const out: SourceRef[] = []
  src.forEach((s) => {
    const k = `${s.sheet}\u0000${s.row}\u0000${s.col}\u0000${s.sourceKind}`
    if (seen[k]) return
    seen[k] = true
    out.push({ sheet: s.sheet, row: s.row, col: s.col, sourceKind: s.sourceKind })
  })
  return out.sort((a, b) => compareRef(a, b) || (a.sourceKind < b.sourceKind ? -1 : a.sourceKind > b.sourceKind ? 1 : 0))
}

/** 표시 이름 고르기: 가장 많이 나온 표기, 같으면 사전순 — 입력 순서와 무관 */
function representative(values: string[]): string {
  const count: Record<string, number> = dict()
  values.forEach((v) => {
    if (v) count[v] = (count[v] || 0) + 1
  })
  let best = ''
  Object.keys(count).forEach((v) => {
    if (!best || count[v] > count[best] || (count[v] === count[best] && v < best)) best = v
  })
  return best
}

function compareClassLabels(a: string, b: string): number {
  const pa = a.split('-').map(Number)
  const pb = b.split('-').map(Number)
  return pa[0] - pb[0] || pa[1] - pb[1]
}

function distinct(rows: NormalizedRow[], pick: (r: NormalizedRow) => string | null | undefined): string[] {
  const out: string[] = []
  rows.forEach((r) => {
    const v = pick(r)
    if (v && out.indexOf(v) < 0) out.push(v)
  })
  return out.sort()
}

/** 같은 키를 가진 행들의 표시 이름 */
function displayFor(rows: NormalizedRow[], key: string, keyOf: (r: NormalizedRow) => string | null, valueOf: (r: NormalizedRow) => string | null): string {
  return representative(rows.filter((r) => keyOf(r) === key).map((r) => valueOf(r) || ''))
}

function teacherDisplay(rows: NormalizedRow[], key: string): string {
  const names: string[] = []
  rows.forEach((r) =>
    r.teachers.forEach((t) => {
      if (nameKey(t) === key) names.push(t)
    })
  )
  return representative(names) || key
}

function slotLabel(weekday: number, period: number): string {
  return `${WEEKDAY_KO[weekday] || weekday}요일 ${period}교시`
}

interface ClusterSummary {
  codes: string[]
  sections: string[]
  classes: string[]
  subjects: string[]
}

function summarize(rows: NormalizedRow[]): ClusterSummary {
  return {
    codes: distinct(rows, (r) => r.codeKey),
    sections: distinct(rows, (r) => r.sectionKey),
    classes: distinct(rows, (r) => r.classLabel),
    subjects: distinct(rows, (r) => r.subjectKey),
  }
}

/** 교사 없는 행이 교사 묶음에 들어갈 수 있는지 — 알려진 값이 모두 맞고, 학급·분반·코드 중 하나 이상이 실제로 일치 */
function attachable(r: NormalizedRow, s: ClusterSummary): boolean {
  if (r.codeKey) return s.codes.indexOf(r.codeKey) >= 0
  let positive = false
  if (r.sectionKey) {
    if (s.sections.indexOf(r.sectionKey) < 0) return false
    positive = true
  }
  if (r.classLabel) {
    if (s.classes.indexOf(r.classLabel) < 0) return false
    positive = true
  }
  if (r.subjectKey && s.subjects.indexOf(r.subjectKey) < 0) return false
  return positive
}

/** 한 요일·교시의 행들을 '같은 차시' 묶음으로 */
function clusterSlot(rows: NormalizedRow[]): Array<{ rows: NormalizedRow[]; ambiguous: string[] }> {
  // 1) 교사 이름(키)을 공유하는 행끼리 합침 — 한 교사는 한 시간에 한 곳에만 있으므로
  const parent: Record<string, string> = dict()
  const find = (k: string): string => {
    while (parent[k] !== k) {
      parent[k] = parent[parent[k]]
      k = parent[k]
    }
    return k
  }
  const withTeacher = rows.filter((r) => r.teacherKeys.length > 0)
  withTeacher.forEach((r) => r.teacherKeys.forEach((k) => (parent[k] = parent[k] || k)))
  withTeacher.forEach((r) => {
    for (let i = 1; i < r.teacherKeys.length; i++) {
      const a = find(r.teacherKeys[0])
      const b = find(r.teacherKeys[i])
      if (a !== b) parent[a < b ? b : a] = a < b ? a : b
    }
  })
  const groups: Record<string, NormalizedRow[]> = dict()
  withTeacher.forEach((r) => {
    const g = find(r.teacherKeys[0])
    ;(groups[g] = groups[g] || []).push(r)
  })
  const clusters: Array<{ rows: NormalizedRow[]; ambiguous: string[] }> = Object.keys(groups)
    .sort()
    .map((g) => ({ rows: groups[g], ambiguous: [] }))
  const summaries = clusters.map((c) => summarize(c.rows))

  // 2) 교사가 없는 행: 들어갈 수 있는 교사 묶음이 '정확히 하나'일 때만 붙임
  const orphanGroups: Record<string, { rows: NormalizedRow[]; ambiguous: string[] }> = dict()
  rows
    .filter((r) => r.teacherKeys.length === 0)
    .forEach((r) => {
      const matches: number[] = []
      summaries.forEach((s, i) => {
        if (attachable(r, s)) matches.push(i)
      })
      if (matches.length === 1) {
        clusters[matches[0]].rows.push(r)
        return
      }
      const k = `${r.codeKey || ''}|${r.sectionKey || ''}|${r.classLabel || ''}|${r.subjectKey}`
      const g = (orphanGroups[k] = orphanGroups[k] || { rows: [], ambiguous: [] })
      g.rows.push(r)
      matches.forEach((i) => {
        clusters[i].rows.forEach((x) => x.teachers.forEach((t) => g.ambiguous.indexOf(t) < 0 && g.ambiguous.push(t)))
      })
    })
  Object.keys(orphanGroups)
    .sort()
    .forEach((k) => {
      const g = orphanGroups[k]
      g.ambiguous.sort()
      clusters.push(g)
    })
  return clusters
}

function lessonFromRows(rows: NormalizedRow[], bag: IssueBag, ambiguous: string[]): Lesson {
  const s = summarize(rows)
  const first = rows[0]
  const weekday = first.weekday
  const period = first.period
  const teacherKeys: string[] = []
  rows.forEach((r) => r.teacherKeys.forEach((k) => teacherKeys.indexOf(k) < 0 && teacherKeys.push(k)))
  teacherKeys.sort()
  const teacherNames = teacherKeys.map((k) => teacherDisplay(rows, k))
  const subjectKey = s.subjects.length === 1 ? s.subjects[0] : ''
  const subject = subjectKey ? displayFor(rows, subjectKey, (r) => r.subjectKey, (r) => r.subject) : ''
  const sectionKey = s.sections.length === 1 ? s.sections[0] : null
  const section = sectionKey ? displayFor(rows, sectionKey, (r) => r.sectionKey, (r) => r.section) : null
  const classLabels = s.classes.slice().sort(compareClassLabels)
  const tk = teacherKeys.join('+')

  let keyKind: ImportKeyKind
  let importKey: string
  if (s.codes.length === 1) {
    keyKind = 'code'
    importKey = `code|${s.codes[0]}`
  } else if (sectionKey) {
    keyKind = 'sec'
    importKey = `sec|${subjectKey}|${sectionKey}|${tk}`
  } else if (classLabels.length === 1) {
    keyKind = 'hr'
    importKey = `hr|${classLabels[0]}|${subjectKey}|${tk}`
  } else if (classLabels.length > 1) {
    keyKind = 'none'
    importKey = `mc|${classLabels.join('+')}|${subjectKey}|${tk}`
  } else {
    keyKind = 'none'
    importKey = `none|${subjectKey}|${tk}`
  }

  const refs = rows.map((r) => refOf(r.src))
  const where = slotLabel(weekday, period)
  const what = `${subject || '(과목 없음)'}${section ? ' ' + section : ''}`
  const keys = [importKey]

  if (!teacherKeys.length) {
    if (ambiguous.length) {
      bag.add(
        issue(
          'review',
          'ambiguous-match',
          `${where} '${what}': 교사가 적혀 있지 않고, 같은 시간의 여러 교사(${ambiguous.join(', ')}) 수업과 모두 맞아 하나로 정할 수 없어요.`,
          '이 칸에 교사 이름을 적거나 분반 접두어(예: A_영어)·수업 코드를 넣어 어느 수업인지 구분해 주세요.',
          refs,
          keys
        )
      )
    } else {
      bag.add(
        issue(
          'review',
          'teacher-missing',
          `${where} '${what}': 교사를 확인할 수 없어요(교사 미확인).`,
          '학급시간표 칸에 교사 이름을 넣거나, 같은 수업이 있는 교사시간표를 함께 올려 주세요.',
          refs,
          keys
        )
      )
    }
  }
  if (!subjectKey) {
    bag.add(
      issue('review', 'subject-missing', `${where}: ${teacherNames.join(', ') || '교사 미확인'} 수업의 과목을 알 수 없어요.`, '교사시간표 칸에 과목명을 넣거나 학급시간표를 함께 올려 주세요.', refs, keys)
    )
  }
  if (keyKind === 'none' && classLabels.length > 1) {
    bag.add(
      issue(
        'review',
        'combined-class',
        `${where} '${what}': ${teacherNames.join(', ')} 선생님 수업이 여러 학급(${classLabels.join(', ')})에 나와요 — 이동수업/합반이면 분반 코드가 필요해요.`,
        '과목명에 분반 접두어(예: A_영어)를 붙이거나 수업 코드를 넣어 주세요. 학급 공통 수업으로 추정하지 않습니다.',
        refs,
        keys
      )
    )
  } else if (keyKind === 'none') {
    bag.add(
      issue(
        'review',
        'no-class',
        `${where} '${what}': 어느 학급·분반 수업인지 알 수 없어요.`,
        "교사시간표 칸의 반 코드(예: 304)를 확인하거나, 분반 접두어(예: A_영어)를 적어 주세요.",
        refs,
        keys
      )
    )
  }
  const rooms = distinct(rows, (r) => r.roomKey)
  let roomName: string | null = null
  if (rooms.length === 1) {
    roomName = displayFor(rows, rooms[0], (r) => r.roomKey, (r) => r.room)
  } else if (rooms.length > 1) {
    const names = rooms.map((k) => displayFor(rows, k, (r) => r.roomKey, (r) => r.room))
    bag.add(
      issue(
        'review',
        'room-mismatch',
        `${where} '${what}': 자료마다 수업 장소가 달라요(${names.join(' / ')}).`,
        '어느 장소가 맞는지 원본을 확인해 하나로 고쳐 주세요. 마지막에 올린 자료를 정답으로 쓰지 않습니다.',
        refs,
        keys
      )
    )
  }
  const times = distinct(rows, (r) => (r.start || r.end ? `${r.start || ''}~${r.end || ''}` : null))
  let start: string | null = null
  let end: string | null = null
  if (times.length === 1) {
    const r = rows.filter((x) => x.start || x.end)[0]
    start = r.start
    end = r.end
  } else if (times.length > 1) {
    bag.add(
      issue('review', 'time-mismatch', `${where} '${what}': 자료마다 시각이 달라요(${times.join(' / ')}).`, '시각이 맞는 자료로 통일해 주세요.', refs, keys)
    )
  }
  return {
    weekday,
    period,
    keyKind,
    importKey,
    subject,
    subjectKey,
    section,
    sectionKey,
    classLabels,
    teacherNames,
    teacherKeys,
    roomName,
    start,
    end,
    rows,
  }
}

/** 한 묶음 분석 — 같은 교사가 같은 시간에 서로 다른 과목·분반·코드로 나오면 충돌(error)로 보고 행 정체성별로 나눔 */
function lessonsFromCluster(c: { rows: NormalizedRow[]; ambiguous: string[] }, bag: IssueBag): Lesson[] {
  const s = summarize(c.rows)
  if (s.subjects.length <= 1 && s.sections.length <= 1 && s.codes.length <= 1) {
    return [lessonFromRows(c.rows, bag, c.ambiguous)]
  }
  const parts: Record<string, NormalizedRow[]> = dict()
  c.rows.forEach((r) => {
    const id = r.codeKey ? `c:${r.codeKey}` : r.sectionKey ? `s:${r.sectionKey}|${r.subjectKey}` : `h:${r.classLabel || ''}|${r.subjectKey}`
    ;(parts[id] = parts[id] || []).push(r)
  })
  const lessons = Object.keys(parts)
    .sort()
    .map((id) => lessonFromRows(parts[id], bag, []))
  const first = c.rows[0]
  const teachers: string[] = []
  c.rows.forEach((r) => r.teachers.forEach((t) => teachers.indexOf(t) < 0 && teachers.push(t)))
  teachers.sort()
  const whats = lessons.map((l) => `${l.classLabels.join('·') || '?'} ${l.subject || '?'}${l.section ? ' ' + l.section : ''}`)
  bag.add(
    issue(
      'error',
      'teacher-conflict',
      `${slotLabel(first.weekday, first.period)}: ${teachers.join(', ')} 선생님이 같은 시간에 서로 다른 수업(${whats.join(' / ')})으로 나와요.`,
      '원본의 요일·교시·교사를 확인해 주세요. 이름이 같은 다른 교사라면 원본에서 이름을 구분해 적어 주세요(예: 김민수A).',
      c.rows.map((r) => refOf(r.src)),
      lessons.map((l) => l.importKey)
    )
  )
  return lessons
}

/**
 * 정규화 행 → 수업 후보. 순서와 무관한 결정적 결과(같은 입력 집합이면 같은 출력).
 */
export function buildCandidates(rawRows: RawImportRow[], opts: BuildOptions): BuildResult {
  const maxPeriod = opts.maxPeriod ?? MAX_PERIOD
  const bag = new IssueBag()
  const rows: NormalizedRow[] = []
  // 행은 매칭에 쓰지만 검토가 필요한 이슈(분반 칸·접두어 불일치, 알 수 없는 학급 표기 등) — 그 행이 들어간 수업에 아래(1)에서 연결
  const rowIssues = new Map<NormalizedRow, ImportIssue[]>()
  rawRows.forEach((r) => {
    const n = normalizeRow(r, { maxPeriod })
    n.issues.forEach((i) => bag.add(i))
    if (n.row) {
      rows.push(n.row)
      if (n.issues.length) rowIssues.set(n.row, n.issues)
    }
  })

  // 1) 요일·교시별 묶기 → 같은 차시 합치기
  const bySlot: Record<string, NormalizedRow[]> = dict()
  rows.forEach((r) => {
    const k = `${r.weekday}|${String(r.period).padStart(2, '0')}`
    ;(bySlot[k] = bySlot[k] || []).push(r)
  })
  const lessons: Lesson[] = []
  Object.keys(bySlot)
    .sort()
    .forEach((k) => {
      clusterSlot(bySlot[k]).forEach((c) => lessonsFromCluster(c, bag).forEach((l) => lessons.push(l)))
    })
  // 행 단위 이슈를 그 행으로 만든 수업(importKey)에 연결. 연결하지 않으면 (7)의 차단 판정에서 빠져,
  // '검토 항목 제외 동의' 뒤에도 확인되지 않은 행(예: 분반이 엇갈린 행)으로 만든 수업이 그대로 발행됨
  lessons.forEach((l) =>
    l.rows.forEach((r) => {
      const list = rowIssues.get(r)
      if (list) list.forEach((i) => bag.add({ ...i, rows: [], importKeys: [l.importKey] }))
    })
  )

  // 2) 자료 간 불일치: 교사시간표(또는 학급시간표)를 올렸는데 그 자료에는 없는 차시
  const teacherSheets: Record<string, boolean> = dict()
  const classSheets: Record<string, boolean> = dict()
  rows.forEach((r) => {
    if (r.src.sourceKind === 'teacher') r.teacherKeys.forEach((k) => (teacherSheets[k] = true))
    if ((r.src.sourceKind === 'class' || r.src.sourceKind === 'table') && r.classLabel) classSheets[r.classLabel] = true
  })
  lessons.forEach((l) => {
    const refs = l.rows.map((r) => refOf(r.src))
    const where = `${slotLabel(l.weekday, l.period)} '${l.subject || '(과목 없음)'}${l.section ? ' ' + l.section : ''}'`
    l.teacherKeys.forEach((k, i) => {
      if (!teacherSheets[k]) return
      if (l.rows.some((r) => r.src.sourceKind === 'teacher' && r.teacherKeys.indexOf(k) >= 0)) return
      bag.add(
        issue(
          'review',
          'source-mismatch',
          `${where}: 다른 자료에는 있지만 ${l.teacherNames[i]} 선생님 교사시간표에는 이 시간 수업이 없어요.`,
          '교사시간표와 학급·전체 시간표 중 어느 쪽이 맞는지 확인해 고쳐 주세요. 마지막에 올린 자료를 정답으로 쓰지 않습니다.',
          refs,
          [l.importKey]
        )
      )
    })
    if (l.keyKind === 'hr') {
      const c = l.classLabels[0]
      if (classSheets[c] && !l.rows.some((r) => (r.src.sourceKind === 'class' || r.src.sourceKind === 'table') && r.classLabel === c)) {
        bag.add(
          issue(
            'review',
            'source-mismatch',
            `${where}: 다른 자료에는 있지만 ${c}반 학급(전체)시간표에는 이 시간 수업이 없어요.`,
            '학급시간표와 교사·특별실 시간표 중 어느 쪽이 맞는지 확인해 고쳐 주세요.',
            refs,
            [l.importKey]
          )
        )
      }
    }
  })

  // 3) 같은 학급·요일·교시에 분반 없는 수업이 다른 수업과 겹침 → 이동수업/선택 가능
  const byClassSlot: Record<string, Lesson[]> = dict()
  lessons.forEach((l) =>
    l.classLabels.forEach((c) => {
      const k = `${c}|${l.weekday}|${l.period}`
      ;(byClassSlot[k] = byClassSlot[k] || []).push(l)
    })
  )
  Object.keys(byClassSlot)
    .sort()
    .forEach((k) => {
      const ls = byClassSlot[k]
      const plain = ls.filter((l) => l.keyKind === 'hr')
      if (!plain.length || ls.length < 2) return
      const c = k.split('|')[0]
      const names = ls.map((l) => `${l.subject || '?'}${l.section ? ' ' + l.section : ''}(${l.teacherNames.join(', ') || '교사 미확인'})`).sort()
      const refs: RowRef[] = []
      ls.forEach((l) => l.rows.forEach((r) => refs.push(refOf(r.src))))
      bag.add(
        issue(
          'review',
          'class-slot-multiple',
          `${c}반 ${slotLabel(ls[0].weekday, ls[0].period)}에 수업이 둘 이상이에요(${names.join(', ')}) — 이동수업/선택 가능, 분반 코드 필요.`,
          '선택·이동 수업이면 과목명에 분반 접두어(예: A_화작)를 붙여 주세요. 학급 학생 모두가 듣는 수업으로 추정하지 않습니다.',
          refs,
          plain.map((l) => l.importKey)
        )
      )
    })

  // 4) 수업(importKey)별로 묶기
  const byKey: Record<string, Lesson[]> = dict()
  lessons.forEach((l) => (byKey[l.importKey] = byKey[l.importKey] || []).push(l))

  const meta: Record<string, { teacherKeys: string[]; subjectKey: string; sectionKey: string | null }> = dict()
  const courses: CourseCandidate[] = Object.keys(byKey)
    .sort()
    .map((key) => {
      const ls = byKey[key].slice().sort((a, b) => a.weekday - b.weekday || a.period - b.period)
      const allRows: NormalizedRow[] = []
      ls.forEach((l) => l.rows.forEach((r) => allRows.push(r)))
      // 같은 요일·교시(공동 수업 코드 등) 차시는 하나로
      const slots: Record<string, Lesson[]> = dict()
      ls.forEach((l) => {
        const sk = `${l.weekday}|${String(l.period).padStart(2, '0')}`
        ;(slots[sk] = slots[sk] || []).push(l)
      })
      const series: LessonSlot[] = Object.keys(slots)
        .sort()
        .map((sk) => {
          const group = slots[sk]
          const tKeys: string[] = []
          group.forEach((l) => l.teacherKeys.forEach((t) => tKeys.indexOf(t) < 0 && tKeys.push(t)))
          tKeys.sort()
          const groupRows: NormalizedRow[] = []
          group.forEach((l) => l.rows.forEach((r) => groupRows.push(r)))
          const rooms = uniq(group.map((l) => l.roomName || '').filter(Boolean)).sort()
          const times = uniq(group.map((l) => `${l.start || ''}~${l.end || ''}`))
          if (rooms.length > 1) {
            bag.add(
              issue(
                'review',
                'room-mismatch',
                `${slotLabel(group[0].weekday, group[0].period)} '${group[0].subject}': 같은 수업 코드의 차시 장소가 달라요(${rooms.join(' / ')}).`,
                '어느 장소가 맞는지 원본을 확인해 주세요.',
                groupRows.map((r) => refOf(r.src)),
                [key]
              )
            )
          }
          return {
            weekday: group[0].weekday,
            period: group[0].period,
            start: times.length === 1 ? group[0].start : null,
            end: times.length === 1 ? group[0].end : null,
            roomName: rooms.length === 1 ? rooms[0] : null,
            teacherNames: tKeys.map((t) => teacherDisplay(groupRows, t)),
          }
        })
      const subjectKeys = uniq(ls.map((l) => l.subjectKey).filter(Boolean)).sort()
      if (subjectKeys.length > 1) {
        bag.add(
          issue(
            'review',
            'subject-variants',
            `수업 코드 '${key.slice(5)}'의 과목명이 차시마다 달라요(${subjectKeys.join(', ')}).`,
            '수업 코드와 과목명이 맞는지 확인해 주세요.',
            allRows.map((r) => refOf(r.src)),
            [key]
          )
        )
      }
      const subject = representative(ls.map((l) => l.subject).filter(Boolean))
      const section = representative(ls.map((l) => l.section || '').filter(Boolean)) || null
      const tKeys: string[] = []
      ls.forEach((l) => l.teacherKeys.forEach((t) => tKeys.indexOf(t) < 0 && tKeys.push(t)))
      tKeys.sort()
      const classLabels: string[] = []
      ls.forEach((l) => l.classLabels.forEach((c) => classLabels.indexOf(c) < 0 && classLabels.push(c)))
      classLabels.sort(compareClassLabels)
      const keyKind = ls[0].keyKind
      // 공통 수업 '후보'는 '한 학급·분반 없음·코드 없음' 수업뿐(담임 확인 전에는 학생에게 연결되지 않음).
      // 분반·코드·여러 학급 수업은 후보도 아님 — 수강 자료(명단·초대)가 있어야 학생에게 연결됨
      const homeroom = keyKind === 'hr' ? classIdFor(opts.schoolCode, ls[0].classLabels[0]) : null
      meta[key] = { teacherKeys: tKeys, subjectKey: subjectKeys[0] || '', sectionKey: ls[0].sectionKey }
      const course: CourseCandidate = {
        importKey: key,
        keyKind,
        title: subject ? `${subject}${section ? ' ' + section : ''}` : '(과목 미확인)',
        subject,
        section,
        teacherNames: tKeys.map((t) => teacherDisplay(allRows, t)),
        candidateTeacherUids: [],
        candidateTeacherLinks: [],
        commonCandidates: homeroom ? [homeroom] : [],
        classLabels,
        series,
        sources: uniqueSources(allRows.map((r) => r.src)),
        blocked: null,
        issueCodes: [],
      }
      return course
    })

  // 5) 중복 분반: 같은 과목·분반이 서로 다른 교사(수업)로 나옴
  const bySection: Record<string, string[]> = dict()
  courses.forEach((c) => {
    if (c.keyKind !== 'sec') return
    const k = `${meta[c.importKey].subjectKey}|${meta[c.importKey].sectionKey}`
    ;(bySection[k] = bySection[k] || []).push(c.importKey)
  })
  Object.keys(bySection)
    .sort()
    .forEach((k) => {
      const keys = bySection[k]
      if (keys.length < 2) return
      const cs = courses.filter((c) => keys.indexOf(c.importKey) >= 0)
      const refs: RowRef[] = []
      cs.forEach((c) => c.sources.forEach((s) => refs.push(refOf(s))))
      bag.add(
        issue(
          'review',
          'duplicate-section',
          `'${cs[0].title}' 분반이 서로 다른 교사(${cs.map((c) => c.teacherNames.join('·') || '교사 미확인').join(', ')})로 나와요 — 같은 분반인지 확인이 필요해요.`,
          '분반 코드가 겹치지 않게 고치거나(예: 영어 A1/A2), 함께 가르치는 수업이면 수업 코드를 넣어 주세요.',
          refs,
          keys
        )
      )
    })

  // 6) 교사 계정 연결 '후보': masterName이 같은(공백 정리 후) 같은 학교 교사. 후보는 권한이 아님 —
  //    발행 교사가 화면에서 사람(이름·가린 이메일)을 확인해 체크한 후보만 planImport가 연결(confirmedTeacherUids)
  const accounts: Record<string, TeacherLinkCandidate[]> = dict()
  ;(opts.teachers || [])
    .slice()
    .sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0))
    .forEach((t) => {
      const k = nameKey(t.masterName)
      if (!k || !t.uid) return
      const list = (accounts[k] = accounts[k] || [])
      if (!list.some((x) => x.uid === t.uid)) list.push({ uid: t.uid, name: cleanSpaces(t.name) || null })
    })
  const linkByKey: Record<string, TeacherLink> = dict()
  courses.forEach((c) =>
    meta[c.importKey].teacherKeys.forEach((k, i) => {
      const prev = linkByKey[k]
      if (prev) {
        if (prev.importKeys.indexOf(c.importKey) < 0) prev.importKeys.push(c.importKey)
        return
      }
      const cands = own(accounts, k) ? accounts[k].map((x) => ({ uid: x.uid, name: x.name })) : []
      linkByKey[k] = {
        name: c.teacherNames[i],
        key: k,
        reason: cands.length === 1 ? 'candidate' : cands.length > 1 ? 'ambiguous' : 'no-account',
        candidates: cands,
        importKeys: [c.importKey],
      }
    })
  )
  courses.forEach((c) => {
    const uids: string[] = []
    meta[c.importKey].teacherKeys.forEach((k) => linkByKey[k].candidates.forEach((x) => uids.indexOf(x.uid) < 0 && uids.push(x.uid)))
    c.candidateTeacherUids = uids.sort()
    c.candidateTeacherLinks = meta[c.importKey].teacherKeys
      .filter((k) => linkByKey[k].candidates.length > 0)
      .map((k) => ({ nameKey: k, uids: linkByKey[k].candidates.map((x) => x.uid).sort() }))
  })
  const teacherLinks = Object.keys(linkByKey)
    .sort()
    .map((k) => ({ ...linkByKey[k], importKeys: linkByKey[k].importKeys.slice().sort() }))
  Object.keys(linkByKey)
    .sort()
    .forEach((k) => {
      const l = linkByKey[k]
      if (l.reason === 'candidate') return
      const related = courses.filter((c) => meta[c.importKey].teacherKeys.indexOf(k) >= 0)
      const refs: RowRef[] = []
      related.forEach((c) => c.sources.slice(0, 3).forEach((s) => refs.push(refOf(s))))
      bag.add(
        l.reason === 'ambiguous'
          ? issue(
              'info',
              'teacher-ambiguous',
              `'${l.name}' 이름(masterName)을 쓰는 교사 계정이 ${l.candidates.length}개예요(동명이인 가능) — 자동으로 연결하지 않았어요.`,
              "'교사 계정 연결 후보'에서 이름·이메일로 실제 담당 선생님을 확인해 그 계정만 체크해 주세요. 확인하지 않으면 이름만 표시돼요.",
              refs,
              related.map((c) => c.importKey)
            )
          : issue(
              'info',
              'teacher-unlinked',
              `'${l.name}' 선생님과 연결할 교사 계정 후보가 없어요 — 이름만 표시하고 담당 권한은 주지 않아요.`,
              '선생님이 가입한 뒤 내 시간표 화면에서 엑셀 이름을 확정하면, 다음 업로드 때 연결 후보로 나와요(발행 교사 확인 필요).',
              refs,
              related.map((c) => c.importKey)
            )
      )
    })

  // 7) 수업별 차단 상태
  const issues = bag.list()
  courses.forEach((c) => {
    const mine = issues.filter((i) => i.importKeys.indexOf(c.importKey) >= 0)
    c.blocked = mine.some((i) => i.severity === 'error') ? 'error' : mine.some((i) => i.severity === 'review') ? 'review' : null
    c.issueCodes = uniq(mine.map((i) => i.code)).sort()
  })

  const lessonCount = courses.reduce((n, c) => n + c.series.length, 0)
  return {
    courses,
    issues,
    stats: {
      rows: rawRows.length,
      lessons: lessonCount,
      duplicatesMerged: rows.length - lessonCount,
      errors: issues.filter((i) => i.severity === 'error').length,
      review: issues.filter((i) => i.severity === 'review').length,
      unlinkedTeachers: teacherLinks.filter((l) => l.reason === 'no-account').length,
      teacherLinkCandidates: teacherLinks.filter((l) => l.reason !== 'no-account').length,
    },
    teacherLinks,
  }
}

// ───────────────────────── 기존 자료와의 차이(발행 계획) ─────────────────────────

export interface ExistingSeries {
  seriesId: string
  courseId: string
  weekday: number
  period: number
  start: string | null
  end: string | null
  roomName: string | null
  teacherNames: string[]
  validFrom: Ymd
  validTo: Ymd | null
  status: 'active' | 'retired'
  importBatchId: string | null
  importClosedBy?: string | null
}

export interface ExistingCourse {
  courseId: string
  importKey: string | null
  termId: string
  source: string
  status: 'active' | 'ended'
  endedOn: Ymd | null
  title: string
  subject: string
  section: string | null
  teacherNames: string[]
  teacherUids: string[]
  importLinkedUids: string[]
  /** 담임이 setCommon으로 정한 값 — 가져오기는 읽기만(미리보기 표시용) */
  commonForHomerooms: string[]
  importCommon: string[] | null
  classLabels: string[]
  importBatchId: string | null
  importRetiredOn: Ymd | null
  revision: number | null
  /** 이 수업의 모든 반복 차시(상태 무관) */
  series: ExistingSeries[]
}

export type WriteOpKind = 'create' | 'update' | 'overwrite' | 'close' | 'retire'

/** 커밋 때 merge로 쓰는 필드(set)와 원복 때 되돌릴 필드(restore). create는 restore가 null(원복 = 종료) */
export interface WriteOp {
  target: 'course' | 'series'
  kind: WriteOpKind
  id: string
  courseId: string
  set: Record<string, unknown>
  restore: Record<string, unknown> | null
}

export type CoursePlanStatus = 'new' | 'update' | 'same' | 'retire'

export interface CoursePlan {
  courseId: string
  importKey: string
  title: string
  status: CoursePlanStatus
  /** 'title' | 'teachers' | 'common' | 'series' | 'reactivate' | 'retire' */
  changes: string[]
  ops: WriteOp[]
}

export interface PlanInput {
  schoolCode: string
  termId: string
  validFrom: Ymd
  mode: 'merge' | 'replace'
  batchId: string
  /** 이번 발행이 수업 문서에 남길 revision(= 발행 후 학교 scheduleRevision 예정값) */
  revision: number
  courses: CourseCandidate[]
  /** 후보 courseId 문서 + (replace) 같은 학기 import 출처 수업 */
  existing: ExistingCourse[]
  /** replace에서 종료하지 않을 importKey (파일에 있지만 검토로 발행에서 제외된 수업) */
  keepKeys?: string[]
  /**
   * (이전 형식) 발행 교사가 확인한 교사 계정 uid — 각 수업의 연결 후보(candidateTeacherUids)와 겹치는 것만 연결합니다.
   * 어느 엑셀 이름으로 확인했는지가 없어 서버는 이 값 대신 confirmedTeacherLinks만 넘깁니다(순수 함수 호환용으로 남김).
   * 미리보기 비교 해시(planDigest)는 확인 없이 만든 계획으로 계산합니다(확인 목록은 해시 밖에서 적용).
   */
  confirmedTeacherUids?: string[]
  /**
   * 발행 교사가 확인한 (엑셀 교사 이름키, uid) 쌍. 수업의 그 이름 후보(candidateTeacherLinks)에 그 uid가 있을 때만
   * 그 이름이 나오는 수업에 연결 — 한 이름으로 확인한 계정이 다른 이름의 수업으로 번지지 않음
   */
  confirmedTeacherLinks?: Array<{ nameKey: string; uid: string }>
  /** 발행 교사 uid — 이번 가져오기로 '새로 만드는' 수업의 managerUids에 넣음(기존 수업의 managerUids는 그대로) */
  publisherUid?: string | null
}

export interface ImportPlan {
  items: CoursePlan[]
  /** 적용일보다 뒤에 시작하는 기존 차시(다른 배치가 미래 적용일로 올린 시간표) — 발행 전 정리 필요 */
  futureVersions: Array<{ courseId: string; importKey: string; seriesId: string; validFrom: Ymd }>
  opCount: number
}

const sortedCopy = (a: string[]): string[] => a.slice().sort()
const sameList = (a: string[], b: string[]): boolean => {
  const x = sortedCopy(a)
  const y = sortedCopy(b)
  return x.length === y.length && x.every((v, i) => v === y[i])
}

function slotSignature(s: { start?: string | null; end?: string | null; roomName?: string | null; teacherNames?: string[] }): string {
  return [s.start || '', s.end || '', nameKey(s.roomName || ''), (s.teacherNames || []).map(nameKey).sort().join('+')].join('|')
}

function seriesSnapshot(s: ExistingSeries): Record<string, unknown> {
  return {
    weekday: s.weekday,
    period: s.period,
    start: s.start,
    end: s.end,
    roomName: s.roomName,
    teacherNames: s.teacherNames.slice(),
    validFrom: s.validFrom,
    validTo: s.validTo,
    status: s.status,
    importBatchId: s.importBatchId,
    importClosedBy: s.importClosedBy ?? null,
  }
}

/**
 * 가져오기가 기존 수업에 쓰는(그래서 원복 때 되돌리는) 필드. commonForHomerooms·managerUids는 담임·사람이 정하는 값이라
 * 가져오기가 쓰지도 되돌리지도 않습니다(공통 수업 후보는 importCommon).
 */
const COURSE_FIELDS = [
  'title',
  'subject',
  'section',
  'teacherNames',
  'teacherUids',
  'importLinkedUids',
  'importCommon',
  'classLabels',
  'status',
  'endedOn',
  'importBatchId',
  'importRetiredOn',
  'revision',
]

function courseSnapshot(c: ExistingCourse): Record<string, unknown> {
  const all: Record<string, unknown> = {
    title: c.title,
    subject: c.subject,
    section: c.section,
    teacherNames: c.teacherNames.slice(),
    teacherUids: c.teacherUids.slice(),
    importLinkedUids: c.importLinkedUids.slice(),
    importCommon: c.importCommon ? c.importCommon.slice() : null,
    classLabels: c.classLabels.slice(),
    status: c.status,
    endedOn: c.endedOn,
    importBatchId: c.importBatchId,
    importRetiredOn: c.importRetiredOn,
    revision: c.revision,
  }
  const out: Record<string, unknown> = dict()
  COURSE_FIELDS.forEach((k) => (out[k] = all[k] === undefined ? null : all[k]))
  return out
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = dict()
  keys.forEach((k) => (out[k] = obj[k] === undefined ? null : obj[k]))
  return out
}

/**
 * 적용일 X 이후에도 열리는 차시. 엔진(seriesOccursOn)과 같은 해석: active이거나, retired라도 validTo가 있으면
 * [validFrom, validTo) 동안은 열림. 빈 기간([a, a))은 제외.
 */
function relevantSeries(c: ExistingCourse, X: Ymd): ExistingSeries[] {
  return c.series.filter(
    (s) => (s.status === 'active' || !!s.validTo) && (!s.validTo || (s.validTo > X && s.validTo > s.validFrom))
  )
}

function closeOrRetireOps(c: ExistingCourse, s: ExistingSeries, X: Ymd, batchId: string): WriteOp {
  if (s.validFrom < X) {
    return {
      target: 'series',
      kind: 'close',
      id: s.seriesId,
      courseId: c.courseId,
      set: { validTo: X, importClosedBy: batchId },
      restore: { validTo: s.validTo, importClosedBy: s.importClosedBy ?? null },
    }
  }
  return {
    target: 'series',
    kind: 'retire',
    id: s.seriesId,
    courseId: c.courseId,
    set: { status: 'retired', validTo: s.validFrom, importClosedBy: batchId },
    restore: { status: s.status, validTo: s.validTo, importClosedBy: s.importClosedBy ?? null },
  }
}

/**
 * 후보 수업과 기존 수업·차시를 비교해 쓰기 계획을 만듭니다(순수 함수).
 * - 새 수업: 수업 문서 + 차시 생성
 * - 기존 수업: 요일·교시별로 비교. 같은 차시가 바뀌면 기존 차시 validTo = 적용일, 새 차시 validFrom = 적용일(과거 보존).
 *   기존 차시가 바로 그 적용일에 시작했다면(같은 id) 그 자리에서 고칩니다.
 *   이번 자료에 없는 차시는 적용일에 종료.
 * - replace: 같은 학기 import 출처 수업 중 이번 자료에 없는 수업의 차시를 적용일에 종료(삭제하지 않음).
 */
export function planImport(input: PlanInput): ImportPlan {
  const X = input.validFrom
  const byId: Record<string, ExistingCourse> = dict()
  input.existing.forEach((c) => (byId[c.courseId] = c))
  const items: CoursePlan[] = []
  const futureVersions: ImportPlan['futureVersions'] = []
  const inFile: Record<string, boolean> = dict()
  input.courses.forEach((c) => (inFile[c.importKey] = true))
  ;(input.keepKeys || []).forEach((k) => (inFile[k] = true))
  const confirmedAll = uniq((input.confirmedTeacherUids || []).filter((u) => typeof u === 'string' && !!u))
  const confirmedPairs = (input.confirmedTeacherLinks || []).filter(
    (p) => p && typeof p.nameKey === 'string' && !!p.nameKey && typeof p.uid === 'string' && !!p.uid
  )
  const publisher = typeof input.publisherUid === 'string' && input.publisherUid ? input.publisherUid : null

  const noteFuture = (c: ExistingCourse, importKey: string) =>
    relevantSeries(c, X)
      .filter((s) => s.validFrom > X)
      .forEach((s) => futureVersions.push({ courseId: c.courseId, importKey, seriesId: s.seriesId, validFrom: s.validFrom }))

  input.courses
    .slice()
    .sort((a, b) => (a.importKey < b.importKey ? -1 : a.importKey > b.importKey ? 1 : 0))
    .forEach((cand) => {
      const courseId = courseIdFor(input.schoolCode, input.termId, cand.importKey)
      const ex = byId[courseId] || null
      const ops: WriteOp[] = []
      const changes: string[] = []

      // 담당 교사: 사람이 직접 넣은 uid(importLinkedUids에 없는 것)는 그대로 두고, 가져오기 연결은
      //  ① 이전 가져오기에서 확인된 연결 중 지금도 이 수업의 후보이고 teacherUids에 남아 있는 것
      //  ② 이번에 발행 교사가 확인한 후보 — 둘만. 후보가 아닌 uid를 보내도 무시합니다.
      const cands = sortedCopy(uniq(cand.candidateTeacherUids))
      const isCand = (u: string) => cands.indexOf(u) >= 0
      const manualUids = ex ? ex.teacherUids.filter((u) => ex.importLinkedUids.indexOf(u) < 0) : []
      const kept = ex ? ex.importLinkedUids.filter((u) => isCand(u) && ex.teacherUids.indexOf(u) >= 0) : []
      // 쌍 확인: 이 수업에 나오는 그 이름의 후보에 그 uid가 있을 때만
      const pairUids = confirmedPairs
        .filter((p) => (cand.candidateTeacherLinks || []).some((l) => l.nameKey === p.nameKey && l.uids.indexOf(p.uid) >= 0))
        .map((p) => p.uid)
      const confirmed = uniq(confirmedAll.concat(pairUids)).filter((u) => isCand(u) && manualUids.indexOf(u) < 0)
      const linked = sortedCopy(uniq(kept.concat(confirmed)))
      const teacherUids = sortedCopy(uniq(manualUids.concat(linked)))
      // 공통 수업: 가져오기는 후보(importCommon)만 기록. commonForHomerooms는 담임이 setCommon으로 정한 값 그대로(새 수업은 [])
      const importCommon = sortedCopy(cand.commonCandidates)
      const courseAfter: Record<string, unknown> = {
        title: cand.title,
        subject: cand.subject,
        section: cand.section,
        teacherNames: cand.teacherNames.slice(),
        teacherUids,
        importLinkedUids: linked,
        importCommon,
        classLabels: cand.classLabels.slice(),
        status: 'active',
        endedOn: null,
        importBatchId: input.batchId,
        importRetiredOn: null,
        revision: input.revision,
      }
      if (ex) {
        if (ex.title !== cand.title || ex.subject !== cand.subject || (ex.section || null) !== (cand.section || null)) changes.push('title')
        if (!sameList(ex.teacherNames, cand.teacherNames) || !sameList(ex.teacherUids, teacherUids) || !sameList(ex.importLinkedUids, linked)) changes.push('teachers')
        // 공통 수업 변경 감지는 후보(importCommon) 차이로만 — commonForHomerooms는 가져오기와 무관
        if (!sameList(ex.importCommon || [], importCommon)) changes.push('common')
        if (!sameList(ex.classLabels, cand.classLabels)) changes.push('labels')
        if (ex.status !== 'active' || ex.endedOn || ex.importRetiredOn) changes.push('reactivate')
      }

      // 차시
      const exSeries = ex ? relevantSeries(ex, X) : []
      if (ex) noteFuture(ex, cand.importKey)
      const current = exSeries.filter((s) => s.validFrom <= X)
      const used: Record<string, boolean> = dict()
      const allById: Record<string, ExistingSeries> = dict()
      if (ex) ex.series.forEach((s) => (allById[s.seriesId] = s))
      cand.series.forEach((slot) => {
        const sig = slotSignature(slot)
        const same = current.filter((s) => !used[s.seriesId] && s.weekday === slot.weekday && s.period === slot.period)
        // 그대로 두려면 내용이 같고 '끝이 열린' 차시여야 함 — 다른 배치가 종료일을 정해 둔 차시는 이번 자료(적용일부터 계속)와 다름
        const exact = same.filter((s) => !s.validTo && slotSignature(s) === sig)[0]
        if (exact) {
          used[exact.seriesId] = true
          return
        }
        const newId = seriesIdFor(courseId, slot.weekday, slot.period, X)
        const fields: Record<string, unknown> = {
          courseId,
          termId: input.termId,
          weekday: slot.weekday,
          period: slot.period,
          start: slot.start,
          end: slot.end,
          roomName: slot.roomName,
          teacherNames: slot.teacherNames.slice(),
          validFrom: X,
          validTo: null,
          status: 'active',
          importBatchId: input.batchId,
          importClosedBy: null,
        }
        const prev = same[0]
        if (prev) {
          used[prev.seriesId] = true
          if (prev.seriesId !== newId) ops.push(closeOrRetireOps(ex as ExistingCourse, prev, X, input.batchId))
        }
        const existingDoc = allById[newId]
        // 같은 id 문서를 이 자리에서 고치므로, 아래 '이번 자료에 없는 차시 종료'에서 다시 다루지 않게
        used[newId] = true
        if (existingDoc) {
          ops.push({
            target: 'series',
            kind: 'overwrite',
            id: newId,
            courseId,
            set: fields,
            restore: seriesSnapshot(existingDoc),
          })
        } else {
          ops.push({ target: 'series', kind: 'create', id: newId, courseId, set: fields, restore: null })
        }
      })
      current.forEach((s) => {
        if (!used[s.seriesId]) ops.push(closeOrRetireOps(ex as ExistingCourse, s, X, input.batchId))
      })
      if (ops.length) changes.push('series')

      let status: CoursePlanStatus
      if (!ex) status = 'new'
      else status = changes.length ? 'update' : 'same'
      if (status !== 'same') {
        ops.unshift(
          ex
            ? { target: 'course', kind: 'update', id: courseId, courseId, set: courseAfter, restore: courseSnapshot(ex) }
            : {
                target: 'course',
                kind: 'create',
                id: courseId,
                courseId,
                set: {
                  ...courseAfter,
                  // 새 수업: 공통 수업은 담임 확인 전까지 없음. 발행 교사를 관리 교사로(담당 교사가 연결되지 않아도 관리 가능)
                  commonForHomerooms: [],
                  ...(publisher ? { managerUids: [publisher] } : {}),
                  schoolCode: input.schoolCode,
                  termId: input.termId,
                  source: 'import',
                  importKey: cand.importKey,
                  defaultRoomId: null,
                  defaultRoomName: null,
                  invitePolicy: 'approval',
                  catalogVisible: false,
                },
                restore: null,
              }
        )
      }
      items.push({ courseId, importKey: cand.importKey, title: cand.title, status, changes, ops })
    })

  if (input.mode === 'replace') {
    input.existing
      .filter((c) => c.source === 'import' && c.termId === input.termId && c.importKey && !inFile[c.importKey])
      .sort((a, b) => (a.courseId < b.courseId ? -1 : 1))
      .forEach((c) => {
        noteFuture(c, c.importKey as string)
        const ops: WriteOp[] = relevantSeries(c, X).map((s) => closeOrRetireOps(c, s, X, input.batchId))
        if (!ops.length) return
        ops.unshift({
          target: 'course',
          kind: 'update',
          id: c.courseId,
          courseId: c.courseId,
          set: { importBatchId: input.batchId, importRetiredOn: X, revision: input.revision },
          restore: pick(courseSnapshot(c), ['importBatchId', 'importRetiredOn', 'revision']),
        })
        items.push({ courseId: c.courseId, importKey: c.importKey as string, title: c.title, status: 'retire', changes: ['retire'], ops })
      })
  }

  return { items, futureVersions, opCount: items.reduce((n, i) => n + i.ops.length, 0) }
}

/** 해시에서 뺄 필드: 수업 문서에 남기는 revision(= 발행 시점 학교 scheduleRevision+1) */
function withoutRevision(set: Record<string, unknown>): Record<string, unknown> {
  if (!own(set, 'revision')) return set
  const out: Record<string, unknown> = {}
  Object.keys(set).forEach((k) => {
    if (k !== 'revision') out[k] = set[k]
  })
  return out
}

/**
 * 계획 요약 해시 — 미리보기와 확정 사이에 결과가 달라졌는지 비교.
 * - 쓰기 값의 revision은 뺌: 학교 scheduleRevision은 수강 변경(초대 수락·그룹 QR·명단 연결)에도 오르는데,
 *   그것만으로 수업·차시 계획이 '바뀌었다'고 보면 관련 없는 이유로 발행이 막힘. 수업 문서 자체가 바뀌면 restore가 달라져 잡힘.
 * - teacherLinks(엑셀 교사 이름 → 후보 계정)를 넣으면 그 매핑도 비교 — 미리보기 뒤 누가 masterName을 바꾸면
 *   화면에서 확인한 사람과 다른 사람이 후보가 될 수 있으므로 다시 미리보기하게 함
 */
export function planDigest(plan: ImportPlan, excludedKeys: string[], teacherLinks?: Array<Pick<TeacherLink, 'key' | 'candidates' | 'importKeys'>>): string {
  const body: Record<string, unknown> = {
    items: plan.items.map((i) => [i.courseId, i.status, i.ops.map((o) => [o.target, o.kind, o.id, withoutRevision(o.set), o.restore])]),
    future: plan.futureVersions.map((f) => f.seriesId),
    excluded: sortedCopy(excludedKeys),
  }
  if (teacherLinks) {
    body.teachers = teacherLinks
      .map((l) => [l.key, l.candidates.map((c) => c.uid).sort(), sortedCopy(l.importKeys)] as [string, string[], string[]])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  }
  return sha256Hex(JSON.stringify(body))
}

/**
 * 발행 교사가 보낸 확인 목록 정리: 발행할 수업 중 어느 하나의 연결 후보인 uid만 받아들이고(accepted),
 * 나머지(후보가 아닌 uid·다른 학교 교사·학생 등)는 무시(ignored). 결과는 정렬·중복 제거.
 */
export function splitConfirmations(courses: Array<Pick<CourseCandidate, 'candidateTeacherUids'>>, confirm: string[]): { accepted: string[]; ignored: string[] } {
  const all: Record<string, boolean> = dict()
  courses.forEach((c) => c.candidateTeacherUids.forEach((u) => (all[u] = true)))
  const list = uniq(confirm.filter((u) => typeof u === 'string' && !!u)).sort()
  return { accepted: list.filter((u) => all[u] === true), ignored: list.filter((u) => all[u] !== true) }
}

export interface TeacherConfirmation {
  nameKey: string
  uid: string
}

/**
 * 연결 확인 정리 — (엑셀 교사 이름키, uid) 쌍 단위.
 * - pairs: 다시 계산한 후보에서 그 이름키의 후보에 그 uid가 있고, 그 이름이 발행할 수업(publishKeys)에 나올 때만 받음
 * - legacyUids(이전 형식 confirmTeacherUids): 그 uid가 발행할 수업에 나오는 이름 '정확히 하나'의 후보일 때만 그 이름으로 해석
 * 나머지는 무시하고 개수만(ignored). accepted는 이름키·uid 순 정렬·중복 제거.
 */
export function resolveTeacherConfirmations(
  links: Array<Pick<TeacherLink, 'key' | 'candidates' | 'importKeys'>>,
  publishKeys: string[],
  pairs: TeacherConfirmation[],
  legacyUids: string[] = []
): { accepted: TeacherConfirmation[]; acceptedUids: string[]; ignored: number } {
  const publish: Record<string, boolean> = dict()
  publishKeys.forEach((k) => (publish[k] = true))
  const live = links.filter((l) => l.importKeys.some((k) => publish[k] === true))
  const seen: Record<string, boolean> = dict()
  const accepted: TeacherConfirmation[] = []
  let ignored = 0
  const take = (nameKeyIn: string, uid: string): boolean => {
    const k = nameKey(nameKeyIn)
    const l = live.filter((x) => x.key === k)[0]
    if (!l || !l.candidates.some((c) => c.uid === uid)) return false
    const id = `${k}\u0000${uid}`
    if (!seen[id]) {
      seen[id] = true
      accepted.push({ nameKey: k, uid })
    }
    return true
  }
  pairs.forEach((p) => {
    if (!p || typeof p.nameKey !== 'string' || typeof p.uid !== 'string' || !take(p.nameKey, p.uid)) ignored++
  })
  uniq(legacyUids.filter((u) => typeof u === 'string' && !!u)).forEach((u) => {
    const names = live.filter((l) => l.candidates.some((c) => c.uid === u))
    if (names.length !== 1 || !take(names[0].key, u)) ignored++
  })
  accepted.sort((a, b) => (a.nameKey < b.nameKey ? -1 : a.nameKey > b.nameKey ? 1 : a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0))
  return { accepted, acceptedUids: uniq(accepted.map((p) => p.uid)).sort(), ignored }
}

/** 이메일 일부 가림: 'abcdef@school.kr' → 'ab***@school.kr' (앞 2자, 짧으면 1자). 형식이 아니면 null */
export function maskEmail(email: unknown): string | null {
  if (typeof email !== 'string') return null
  const s = email.trim()
  const at = s.lastIndexOf('@')
  if (at < 1 || at === s.length - 1) return null
  const local = Array.from(s.slice(0, at))
  const domain = s.slice(at + 1)
  const keep = local.length > 2 ? 2 : 1
  return `${local.slice(0, keep).join('')}***@${domain}`
}

/** 쓰기 묶음 나누기 — 한 수업의 쓰기는 가능한 한 같은 묶음에(최대 maxOps) */
export function packOps(items: CoursePlan[], maxOps: number): WriteOp[][] {
  const out: WriteOp[][] = []
  let cur: WriteOp[] = []
  items.forEach((it) => {
    if (!it.ops.length) return
    if (cur.length && cur.length + it.ops.length > maxOps) {
      out.push(cur)
      cur = []
    }
    for (let i = 0; i < it.ops.length; i += maxOps) {
      const part = it.ops.slice(i, i + maxOps)
      if (cur.length && cur.length + part.length > maxOps) {
        out.push(cur)
        cur = []
      }
      part.forEach((o) => cur.push(o))
    }
  })
  if (cur.length) out.push(cur)
  return out
}

/** 원복 때 쓸 필드: create는 종료(수업 'ended', 차시 'retired'), 나머지는 restore */
export function undoSetOf(op: WriteOp, validFrom: Ymd): Record<string, unknown> {
  if (op.restore) return op.restore
  if (op.target === 'course') return { status: 'ended', endedOn: validFrom }
  return { status: 'retired', validTo: (op.set.validFrom as string) || validFrom }
}

/** Firestore 값 비교(배열은 순서까지, undefined = null) */
export function sameValue(a: unknown, b: unknown): boolean {
  const x = a === undefined ? null : a
  const y = b === undefined ? null : b
  if (Array.isArray(x) || Array.isArray(y)) {
    if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false
    return x.every((v, i) => sameValue(v, y[i]))
  }
  if (x && y && typeof x === 'object' && typeof y === 'object') {
    const ka = Object.keys(x as object).sort()
    const kb = Object.keys(y as object).sort()
    return sameList(ka, kb) && ka.every((k) => sameValue((x as any)[k], (y as any)[k]))
  }
  return x === y
}

/** 문서가 fields 값과 모두 같은지 */
export function docMatches(doc: Record<string, unknown> | null, fields: Record<string, unknown>): boolean {
  if (!doc) return false
  return Object.keys(fields).every((k) => sameValue(doc[k], fields[k]))
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const ymdOrNull = (v: unknown): Ymd | null => (typeof v === 'string' && /^\d{8}$/.test(v) ? v : null)
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** Firestore 문서(평범한 객체) → 계획 계산용 기존 수업. 서버와 단위 테스트가 같은 변환을 씁니다 */
export function existingFromDocs(
  courses: Array<{ id: string; data: Record<string, unknown> }>,
  series: Array<{ id: string; data: Record<string, unknown> }>
): ExistingCourse[] {
  const byCourse: Record<string, ExistingSeries[]> = dict()
  series.forEach(({ id, data: d }) => {
    const courseId = typeof d.courseId === 'string' ? d.courseId : ''
    if (!courseId) return
    ;(byCourse[courseId] = byCourse[courseId] || []).push({
      seriesId: id,
      courseId,
      weekday: Number(d.weekday) || 0,
      period: Number(d.period) || 0,
      start: strOrNull(d.start),
      end: strOrNull(d.end),
      roomName: strOrNull(d.roomName),
      teacherNames: strList(d.teacherNames),
      validFrom: ymdOrNull(d.validFrom) || '19700101',
      validTo: ymdOrNull(d.validTo),
      status: d.status === 'retired' ? 'retired' : 'active',
      importBatchId: strOrNull(d.importBatchId),
      importClosedBy: strOrNull(d.importClosedBy),
    })
  })
  return courses.map(({ id, data: d }) => ({
    courseId: id,
    importKey: strOrNull(d.importKey),
    termId: typeof d.termId === 'string' ? d.termId : '',
    source: typeof d.source === 'string' ? d.source : 'manual',
    status: d.status === 'ended' ? 'ended' : 'active',
    endedOn: ymdOrNull(d.endedOn),
    title: typeof d.title === 'string' ? d.title : '',
    subject: typeof d.subject === 'string' ? d.subject : '',
    section: strOrNull(d.section),
    teacherNames: strList(d.teacherNames),
    teacherUids: strList(d.teacherUids),
    importLinkedUids: strList(d.importLinkedUids),
    commonForHomerooms: strList(d.commonForHomerooms),
    importCommon: Array.isArray(d.importCommon) ? strList(d.importCommon) : null,
    classLabels: strList(d.classLabels),
    importBatchId: strOrNull(d.importBatchId),
    importRetiredOn: ymdOrNull(d.importRetiredOn),
    revision: typeof d.revision === 'number' ? d.revision : null,
    series: (byCourse[id] || []).sort((a, b) => (a.seriesId < b.seriesId ? -1 : 1)),
  }))
}
