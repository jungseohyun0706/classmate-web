import type { NextApiRequest, NextApiResponse } from 'next'

// NEIS Open API URL
const NEIS_API_URL = 'https://open.neis.go.kr/hub/schoolInfo'

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const { query } = req.query

  if (!query) {
    return res.status(400).json({ error: '검색어를 입력해주세요.' })
  }

  try {
    // API 호출 (KEY 없이 호출 시 제한적이지만 테스트 가능, Type=json)
    const apiUrl = `${NEIS_API_URL}?Type=json&pIndex=1&pSize=100&SCHUL_NM=${encodeURIComponent(query as string)}`
    
    const response = await fetch(apiUrl)
    const data = await response.json()

    if (data.RESULT && data.RESULT.CODE !== 'INFO-000') {
      // 에러 또는 결과 없음
      return res.status(200).json({ schools: [] })
    }

    if (data.schoolInfo) {
      // 결과 파싱
      const schools = data.schoolInfo[1].row.map((school: any) => ({
        code: school.SD_SCHUL_CODE,
        officeCode: school.ATPT_OFCDC_SC_CODE,
        name: school.SCHUL_NM,
        address: school.ORG_RDNMA,
        kind: school.SCHUL_KND_SC_NM // 초등학교, 고등학교 등
      }))
      return res.status(200).json({ schools })
    }

    return res.status(200).json({ schools: [] })

  } catch (error) {
    console.error('NEIS API Error:', error)
    return res.status(500).json({ error: '학교 정보를 가져오는데 실패했습니다.' })
  }
}
