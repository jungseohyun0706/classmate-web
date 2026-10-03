import type { NextApiRequest, NextApiResponse } from 'next'
import { fetchNeisResult } from '../../lib/neis'

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // query 대신 q를 파라미터로 받음 (register-class.tsx와 일치)
  const q = (req.query.q as string || req.query.query as string || '')

  if (!q) {
    return res.status(200).json({ schools: [] })
  }

  try {
    // 공용 헬퍼를 거쳐야 NEIS_SERVICE_KEY가 붙음 (키가 없으면 NEIS가 최대 5건만 돌려줌)
    const { ok, rows } = await fetchNeisResult('schoolInfo', { SCHUL_NM: q })

    // NEIS 장애·오류는 '검색 결과 없음'(200 + 빈 배열)과 구분되도록 502로 응답
    if (!ok) {
      return res.status(502).json({ error: '학교 정보를 가져오는데 실패했습니다.' })
    }

    const schools = rows.map((school) => ({
      code: school.SD_SCHUL_CODE,
      officeCode: school.ATPT_OFCDC_SC_CODE,
      name: school.SCHUL_NM,
      address: school.ORG_RDNMA,
      kind: school.SCHUL_KND_SC_NM
    }))
    return res.status(200).json({ schools })

  } catch (error) {
    console.error('NEIS API Error:', error)
    return res.status(500).json({ error: '학교 정보를 가져오는데 실패했습니다.' })
  }
}
