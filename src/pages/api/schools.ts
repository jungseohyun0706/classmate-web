import type { NextApiRequest, NextApiResponse } from 'next'

// NEIS Open API URL
const NEIS_API_URL = 'https://open.neis.go.kr/hub/schoolInfo'

// 인스턴스 메모리 캐시 (24시간) — 학교 정보는 거의 변하지 않는다
const cache = new Map<string, { t: number; data: any }>()
const TTL = 24 * 60 * 60 * 1000

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // query 대신 q를 파라미터로 받음 (구버전 호환으로 query도 허용)
  const q = String((req.query.q as string) || (req.query.query as string) || '').trim().slice(0, 40)

  if (!q) {
    return res.status(200).json({ schools: [] })
  }

  const hit = cache.get(q)
  if (hit && Date.now() - hit.t < TTL) {
    res.setHeader('x-cache', 'HIT')
    return res.status(200).json(hit.data)
  }

  try {
    const params = new URLSearchParams({
      Type: 'json',
      pIndex: '1',
      pSize: '50',
      SCHUL_NM: q,
    })
    if (process.env.NEIS_SERVICE_KEY) params.set('KEY', process.env.NEIS_SERVICE_KEY)

    const response = await fetch(`${NEIS_API_URL}?${params.toString()}`)
    const data = await response.json()

    // NEIS 응답 데이터 구조 처리
    if (data.schoolInfo && data.schoolInfo[1] && data.schoolInfo[1].row) {
      const schools = data.schoolInfo[1].row.map((school: any) => ({
        code: school.SD_SCHUL_CODE,
        officeCode: school.ATPT_OFCDC_SC_CODE,
        name: school.SCHUL_NM,
        address: school.ORG_RDNMA,
        kind: school.SCHUL_KND_SC_NM,
      }))
      const payload = { schools }
      cache.set(q, { t: Date.now(), data: payload })
      return res.status(200).json(payload)
    }

    return res.status(200).json({ schools: [] })
  } catch (error) {
    console.error('NEIS API Error:', error)
    return res.status(500).json({ error: '학교 정보를 가져오는데 실패했습니다.' })
  }
}
