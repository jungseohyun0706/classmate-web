import type { NextApiRequest, NextApiResponse } from 'next'

// NEIS Open API URL
const NEIS_API_URL = 'https://open.neis.go.kr/hub/schoolInfo'

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
    // NEIS API 호출 (KEY를 넣으면 더 좋음)
    const apiUrl = `${NEIS_API_URL}?Type=json&pIndex=1&pSize=100&SCHUL_NM=${encodeURIComponent(q)}`
    
    const response = await fetch(apiUrl)
    const data = await response.json()

    // NEIS 응답 데이터 구조 처리
    if (data.schoolInfo && data.schoolInfo[1] && data.schoolInfo[1].row) {
      const schools = data.schoolInfo[1].row.map((school: any) => ({
        code: school.SD_SCHUL_CODE,
        officeCode: school.ATPT_OFCDC_SC_CODE,
        name: school.SCHUL_NM,
        address: school.ORG_RDNMA,
        kind: school.SCHUL_KND_SC_NM
      }))
      return res.status(200).json({ schools })
    }

    return res.status(200).json({ schools: [] })

  } catch (error) {
    console.error('NEIS API Error:', error)
    return res.status(500).json({ error: '학교 정보를 가져오는데 실패했습니다.' })
  }
}
