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
  const { ok, rows } = await fetchNeisResult('schoolInfo', { SD_SCHUL_CODE: schoolCode })
  return { ok, officeCode: rows[0]?.ATPT_OFCDC_SC_CODE ?? null }
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
