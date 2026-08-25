import type { NextApiRequest, NextApiResponse } from 'next'
import { fetchNeis, resolveOfficeCode, todayKstYmd } from '../../lib/neis'

interface Meal {
  date: string
  menu: string[]
  calorie: string
}

// GET /api/meals?schoolCode=&officeCode=&from=YYYYMMDD&to=YYYYMMDD
// officeCode 생략 시 schoolCode로 자동 조회, 날짜 생략 시 오늘(KST)
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method && req.method !== 'GET') {
    return res.status(405).json({ error: '허용되지 않는 요청입니다.' })
  }

  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400')

  const schoolCode = (req.query.schoolCode as string) || ''
  const from = (req.query.from as string) || todayKstYmd()
  const to = (req.query.to as string) || from

  if (!schoolCode) {
    return res.status(200).json({ meals: [] })
  }

  try {
    const officeCode =
      (req.query.officeCode as string) || (await resolveOfficeCode(schoolCode))

    if (!officeCode) {
      return res.status(200).json({ meals: [] })
    }

    const rows = await fetchNeis('mealServiceDietInfo', {
      ATPT_OFCDC_SC_CODE: officeCode,
      SD_SCHUL_CODE: schoolCode,
      MLSV_FROM_YMD: from,
      MLSV_TO_YMD: to,
    })

    const meals: Meal[] = rows.map((row) => ({
      date: row.MLSV_YMD || '',
      // <br/>로 구분된 메뉴를 나누고, 알레르기 표기 (숫자.숫자...)는 남기고 나머지 마크업만 제거
      menu: (row.DDISH_NM || '')
        .split(/<br\s*\/?>/i)
        .map((item) => item.replace(/<[^>]*>/g, '').trim())
        .filter((item) => item.length > 0),
      calorie: row.CAL_INFO || '',
    }))

    return res.status(200).json({ meals })
  } catch (error) {
    // NEIS 실패 시에도 200 + 빈 배열 (UI에서 '정보 없음'으로 처리)
    console.error('Meals API Error:', error)
    return res.status(200).json({ meals: [] })
  }
}
