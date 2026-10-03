// NEIS Open API 공통 헬퍼
// 캐시는 모듈 레벨 in-memory Map (전체 URL 기준, 6시간 TTL).
// 단일 서버리스 인스턴스에서만 유효한 캐시이지만, CDN Cache-Control과 함께 쓰기에 충분합니다.

const NEIS_BASE_URL = 'https://open.neis.go.kr/hub'
const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6시간
// 공개 API라 임의 쿼리 값으로 키가 계속 늘 수 있어 상한을 둠
const CACHE_MAX_ENTRIES = 1000
const FETCH_TIMEOUT_MS = 5000

/** NEIS 조회가 정상(데이터 없음 포함)일 때 API 응답에 붙이는 CDN 캐시 */
export const NEIS_CACHE_CONTROL_OK = 's-maxage=21600, stale-while-revalidate=86400'
/** NEIS 오류·장애일 때: 빈 응답이 CDN에 오래 남지 않도록 1분만 */
export const NEIS_CACHE_CONTROL_ERROR = 's-maxage=60'

export type NeisRow = Record<string, string>

export interface NeisResult {
  /** false면 NEIS 오류·장애(네트워크, 비JSON, ERROR 봉투 등). '데이터 없음'(INFO-200)은 true */
  ok: boolean
  rows: NeisRow[]
}

interface CacheEntry {
  expires: number
  rows: NeisRow[]
}

const cache = new Map<string, CacheEntry>()

function cacheGet(url: string): NeisRow[] | null {
  const entry = cache.get(url)
  if (!entry) return null
  if (entry.expires <= Date.now()) {
    cache.delete(url)
    return null
  }
  return entry.rows
}

function cacheSet(url: string, rows: NeisRow[]): void {
  // TTL이 모두 같으므로 다시 넣으면(delete 후 set) Map 삽입 순서 = 만료 순서
  cache.delete(url)
  cache.set(url, { expires: Date.now() + CACHE_TTL_MS, rows })
  // 앞(오래된 쪽)부터 만료된 항목과 상한을 넘는 항목을 지움
  const now = Date.now()
  while (cache.size > 0) {
    const first = cache.keys().next()
    if (first.done) break
    const entry = cache.get(first.value)
    if (cache.size <= CACHE_MAX_ENTRIES && entry && entry.expires > now) break
    cache.delete(first.value)
  }
}

/**
 * NEIS Open API 호출 헬퍼. 오류와 '데이터 없음'을 구분해 돌려줍니다.
 * - Type=json, pIndex=1, pSize=200 기본 적용
 * - NEIS_SERVICE_KEY 환경변수가 설정된 경우에만 KEY 파라미터 추가
 * - 정상 응답: { [endpoint]: [ { head: [...] }, { row: [...] } ] }
 * - 데이터 없음: { RESULT: { CODE: 'INFO-200' } } → ok: true, 빈 배열
 * - 그 밖의 RESULT 봉투, HTTP 오류, 비JSON, 네트워크 오류·타임아웃 → ok: false (캐시하지 않음)
 */
export async function fetchNeisResult(
  endpoint: string,
  params: Record<string, string>
): Promise<NeisResult> {
  const searchParams = new URLSearchParams({
    Type: 'json',
    pIndex: '1',
    pSize: '200',
    ...params,
  })
  if (process.env.NEIS_SERVICE_KEY) {
    searchParams.set('KEY', process.env.NEIS_SERVICE_KEY)
  }
  const url = `${NEIS_BASE_URL}/${endpoint}?${searchParams.toString()}`

  const cached = cacheGet(url)
  if (cached) {
    return { ok: true, rows: cached }
  }

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) {
      console.error(`NEIS API Error (${endpoint}): HTTP ${response.status}`)
      return { ok: false, rows: [] }
    }
    const data = await response.json()

    const rows = data?.[endpoint]?.[1]?.row
    if (Array.isArray(rows)) {
      cacheSet(url, rows)
      return { ok: true, rows }
    }

    const result = data?.RESULT ?? data?.[endpoint]?.[0]?.head?.[1]?.RESULT
    const code = typeof result?.CODE === 'string' ? result.CODE : ''
    // INFO-200: 해당하는 데이터가 없음 / INFO-000: 정상 처리(행 없음)
    if (code === 'INFO-200' || code === 'INFO-000') {
      cacheSet(url, [])
      return { ok: true, rows: [] }
    }

    console.error(`NEIS API Error (${endpoint}):`, code || 'unknown', result?.MESSAGE ?? '')
    return { ok: false, rows: [] }
  } catch (error) {
    console.error(`NEIS API Error (${endpoint}):`, error)
    return { ok: false, rows: [] }
  }
}

/**
 * fetchNeisResult의 행만 돌려주는 기존 형태(오류도 빈 배열).
 */
export async function fetchNeis(
  endpoint: string,
  params: Record<string, string>
): Promise<NeisRow[]> {
  return (await fetchNeisResult(endpoint, params)).rows
}

/**
 * 학교 코드(SD_SCHUL_CODE)로 시도교육청 코드(ATPT_OFCDC_SC_CODE)를 조회합니다.
 * fetchNeis를 통해 같은 캐시(Map)에 저장됩니다.
 */
export async function resolveOfficeCode(
  schoolCode: string
): Promise<string | null> {
  return (await lookupOfficeCode(schoolCode)).officeCode
}

/**
 * resolveOfficeCode와 같지만 NEIS 오류(ok: false)와 '학교 없음'(officeCode: null)을 구분합니다.
 */
export async function lookupOfficeCode(
  schoolCode: string
): Promise<{ ok: boolean; officeCode: string | null }> {
  const { ok, officeCode } = await lookupSchool(schoolCode)
  return { ok, officeCode }
}

export interface SchoolLookup {
  /** false면 NEIS 오류·장애. 학교가 없으면 ok: true, officeCode: null */
  ok: boolean
  /** 시도교육청 코드(ATPT_OFCDC_SC_CODE) */
  officeCode: string | null
  /** 학교 종류(SCHUL_KND_SC_NM): 초등학교, 중학교, 고등학교, 특수학교 등. 모르면 '' */
  kind: string
  /** 학교 이름(SCHUL_NM). 모르면 '' */
  name: string
}

/**
 * 학교 코드(SD_SCHUL_CODE)로 학교 정보(schoolInfo)를 조회합니다.
 * fetchNeisResult를 거치므로 정상 결과는 같은 메모리 캐시(Map, 6시간)에 저장되고 오류는 저장되지 않습니다.
 */
export async function lookupSchool(schoolCode: string): Promise<SchoolLookup> {
  const { ok, rows } = await fetchNeisResult('schoolInfo', { SD_SCHUL_CODE: schoolCode })
  const row = rows[0]
  return {
    ok,
    officeCode: row?.ATPT_OFCDC_SC_CODE ?? null,
    kind: (row?.SCHUL_KND_SC_NM || '').trim(),
    name: row?.SCHUL_NM || '',
  }
}

/**
 * 학교 종류(SCHUL_KND_SC_NM) → NEIS 시간표 데이터셋.
 * 네 데이터셋의 행은 같은 필드를 씁니다(ALL_TI_YMD 날짜, PERIO 교시, ITRT_CNTNT 수업내용).
 * 종류 이름에 드러난 학교급으로 고릅니다.
 * - '특수'가 들어가면 특수(spsTimetable)
 * - 중학교, 방송통신중학교, 각종학교(중), 평생학교(중)-…, 재외한국학교(중), 고등공민학교 → 중(misTimetable)
 *   고등공민학교는 이름과 달리 중학교 과정이라 고등 판정보다 먼저 봅니다.
 * - 고등학교, 방송통신고등학교, 각종학교(고), 평생학교(고)-…, 재외한국학교(고), 고등기술학교 → 고(hisTimetable)
 * - 그 밖의 종류(초등학교, 각종학교(초), 외국인학교 등)나 모르는 경우는 초등(elsTimetable)으로 시도합니다.
 */
export function neisTimetableEndpoint(kind: string): string {
  const k = kind.trim()
  if (k.includes('특수')) return 'spsTimetable'
  if (k.includes('고등공민학교') || k.includes('(중)') || k.includes('중학교')) return 'misTimetable'
  if (k.includes('(고)') || k.includes('고등학교') || k.includes('고등기술학교')) return 'hisTimetable'
  return 'elsTimetable'
}

export interface NeisTimetableEntry {
  /** YYYYMMDD */
  date: string
  period: number
  /** 같은 날짜·교시의 서로 다른 과목은 ' / '로 이어 붙임 */
  subject: string
}

/**
 * NEIS 시간표 행을 날짜·교시(ALL_TI_YMD, PERIO)마다 한 항목으로 합칩니다.
 * 고교학점제 선택과목이나 특수학교의 여러 과정처럼 같은 교시에 행이 여러 개 오면
 * 과목명(ITRT_CNTNT)을 trim·중복 제거해 ' / '로 잇습니다. 과목명이 빈 행은 버리고, 날짜·교시 순으로 정렬합니다.
 */
export function mergeTimetableRows(rows: NeisRow[]): NeisTimetableEntry[] {
  const byKey = new Map<string, { date: string; period: number; subjects: string[] }>()
  for (const row of rows) {
    const subject = (row.ITRT_CNTNT || '').trim()
    if (!subject) continue
    const date = row.ALL_TI_YMD || ''
    const period = Number(row.PERIO) || 0
    const key = `${date}|${period}`
    const entry = byKey.get(key)
    if (!entry) byKey.set(key, { date, period, subjects: [subject] })
    else if (!entry.subjects.includes(subject)) entry.subjects.push(subject)
  }
  return Array.from(byKey.values())
    .map(({ date, period, subjects }) => ({ date, period, subject: subjects.join(' / ') }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.period - b.period)
}

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
  const kind = (row.SBTR_DD_SC_NM || '').trim()
  const eventName = row.EVENT_NM || ''
  // NEIS는 수업공제가 없는 행을 빈 값 대신 '해당없음'으로 보내기도 함
  const noSbtr = kind === '' || kind === '해당없음'
  const off =
    kind === '휴업일' ||
    kind === '공휴일' ||
    (noSbtr && eventName.includes('방학') && !eventName.includes('방학식'))
  if (!off) return false
  const flags = GRADE_EVENT_FIELDS.map((f) => row[f])
  if (!flags.includes('Y')) return true
  const g = Number(grade)
  const mine = Number.isInteger(g) && g >= 1 && g <= 6 ? flags[g - 1] : undefined
  return mine !== 'N'
}

/**
 * 학사일정 행 중 ymd(YYYYMMDD)에 해당하는 쉬는 날 행(isOffDayRow)이 있으면 true.
 * 조회 실패(빈 배열)면 false라서 호출하는 쪽은 평소처럼 처리합니다.
 */
export function isOffDay(rows: NeisRow[], ymd: string, grade?: unknown): boolean {
  return rows.some((r) => (!r.AA_YMD || r.AA_YMD === ymd) && isOffDayRow(r, grade))
}

/**
 * 오늘 날짜를 KST(Asia/Seoul) 기준 YYYYMMDD 문자열로 반환합니다.
 */
export function todayKstYmd(): string {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const y = kst.getUTCFullYear()
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0')
  const d = String(kst.getUTCDate()).padStart(2, '0')
  return `${y}${m}${d}`
}
