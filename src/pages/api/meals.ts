import type { NextApiRequest, NextApiResponse } from 'next'
import {
  fetchNeisResult,
  lookupOfficeCode,
  todayKstYmd,
  NEIS_CACHE_CONTROL_ERROR,
  NEIS_CACHE_CONTROL_OK,
} from '../../lib/neis'

interface Meal {
  date: string
  menu: string[]
  calorie: string
  /** NEIS MMEAL_SC_CODE: '1' 조식 / '2' 중식 / '3' 석식 */
  mealCode: string
  /** NEIS MMEAL_SC_NM (예: '중식') */
  mealType: string
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

  // 기본은 짧게만 캐시하고, NEIS 조회가 정상일 때만 길게 캐시 (장애 때 빈 응답이 CDN에 오래 남지 않도록)
  res.setHeader('Cache-Control', NEIS_CACHE_CONTROL_ERROR)

  const schoolCode = (req.query.schoolCode as string) || ''
  const from = (req.query.from as string) || todayKstYmd()
  const to = (req.query.to as string) || from

  if (!schoolCode) {
    return res.status(200).json({ meals: [] })
  }

  try {
    let officeCode = (req.query.officeCode as string) || null
    if (!officeCode) {
      const lookup = await lookupOfficeCode(schoolCode)
      if (!lookup.ok) {
        return res.status(200).json({ meals: [] })
      }
      officeCode = lookup.officeCode
    }

    if (!officeCode) {
      return res.status(200).json({ meals: [] })
    }

    const { ok, rows } = await fetchNeisResult('mealServiceDietInfo', {
      ATPT_OFCDC_SC_CODE: officeCode,
      SD_SCHUL_CODE: schoolCode,
      MLSV_FROM_YMD: from,
      MLSV_TO_YMD: to,
    })
    if (!ok) {
      return res.status(200).json({ meals: [] })
    }

    const meals: Meal[] = rows.map((row) => ({
      date: row.MLSV_YMD || '',
      // <br/>로 구분된 메뉴를 나누고, 알레르기 표기 (숫자.숫자...)는 남기고 나머지 마크업만 제거
      menu: (row.DDISH_NM || '')
        .split(/<br\s*\/?>/i)
        .map((item) => item.replace(/<[^>]*>/g, '').trim())
        .filter((item) => item.length > 0),
      calorie: row.CAL_INFO || '',
      mealCode: row.MMEAL_SC_CODE || '',
      mealType: row.MMEAL_SC_NM || '',
    }))

    res.setHeader('Cache-Control', NEIS_CACHE_CONTROL_OK)
    return res.status(200).json({ meals })
  } catch (error) {
    // NEIS 실패 시에도 200 + 빈 배열 (UI에서 '정보 없음'으로 처리)
    console.error('Meals API Error:', error)
    return res.status(200).json({ meals: [] })
  }
}
