// NEIS Open API 공통 헬퍼
// 캐시는 모듈 레벨 in-memory Map (전체 URL 기준, 6시간 TTL).
// 단일 서버리스 인스턴스에서만 유효한 캐시이지만, CDN Cache-Control과 함께 쓰기에 충분합니다.

const NEIS_BASE_URL = 'https://open.neis.go.kr/hub'
const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6시간

export type NeisRow = Record<string, string>

interface CacheEntry {
  expires: number
  rows: NeisRow[]
}

const cache = new Map<string, CacheEntry>()

/**
 * NEIS Open API 호출 헬퍼.
 * - Type=json, pIndex=1, pSize=200 기본 적용
 * - NEIS_SERVICE_KEY 환경변수가 설정된 경우에만 KEY 파라미터 추가
 * - 정상 응답: { [endpoint]: [ { head: [...] }, { row: [...] } ] }
 * - 오류/데이터 없음 응답: { RESULT: { CODE, MESSAGE } } → 빈 배열 반환
 */
export async function fetchNeis(
  endpoint: string,
  params: Record<string, string>
): Promise<NeisRow[]> {
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

  const cached = cache.get(url)
  if (cached && cached.expires > Date.now()) {
    return cached.rows
  }

  try {
    const response = await fetch(url)
    const data = await response.json()

    // RESULT 오류 봉투(데이터 없음 포함)도 빈 배열로 처리
    const rows: NeisRow[] = data?.[endpoint]?.[1]?.row ?? []
    cache.set(url, { expires: Date.now() + CACHE_TTL_MS, rows })
    return rows
  } catch (error) {
    console.error(`NEIS API Error (${endpoint}):`, error)
    return []
  }
}

/**
 * 학교 코드(SD_SCHUL_CODE)로 시도교육청 코드(ATPT_OFCDC_SC_CODE)를 조회합니다.
 * fetchNeis를 통해 같은 캐시(Map)에 저장됩니다.
 */
export async function resolveOfficeCode(
  schoolCode: string
): Promise<string | null> {
  const rows = await fetchNeis('schoolInfo', { SD_SCHUL_CODE: schoolCode })
  return rows[0]?.ATPT_OFCDC_SC_CODE ?? null
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
