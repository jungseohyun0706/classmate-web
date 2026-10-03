import type { NextApiRequest, NextApiResponse } from 'next'
import {
  fetchNeisResult,
  lookupOfficeCode,
  todayKstYmd,
  NEIS_CACHE_CONTROL_ERROR,
  NEIS_CACHE_CONTROL_OK,
} from '../../lib/neis'

interface TimetableEntry {
  date: string
  period: number
  subject: string
}

// GET /api/timetable?schoolCode=&officeCode=&grade=&classNm=&from=YYYYMMDD&to=YYYYMMDD
// 초등학교 시간표(elsTimetable). officeCode 생략 시 자동 조회, 날짜 생략 시 오늘(KST)
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
  const grade = (req.query.grade as string) || ''
  const classNm = (req.query.classNm as string) || ''
  const from = (req.query.from as string) || todayKstYmd()
  const to = (req.query.to as string) || from

  if (!schoolCode || !grade || !classNm) {
    return res.status(200).json({ timetable: [] })
  }

  try {
    let officeCode = (req.query.officeCode as string) || null
    if (!officeCode) {
      const lookup = await lookupOfficeCode(schoolCode)
      if (!lookup.ok) {
        return res.status(200).json({ timetable: [] })
      }
      officeCode = lookup.officeCode
    }

    if (!officeCode) {
      return res.status(200).json({ timetable: [] })
    }

    // 학년도(AY): 1~2월은 전년도 학년도에 속함
    // 학기(SEM)는 보내지 않음: 2학기 개학일이 학교마다 달라(8월 중하순) 월로 계산하면 행이 걸러짐
    const year = Number(from.slice(0, 4))
    const month = Number(from.slice(4, 6))
    const ay = month <= 2 ? year - 1 : year

    const { ok, rows } = await fetchNeisResult('elsTimetable', {
      ATPT_OFCDC_SC_CODE: officeCode,
      SD_SCHUL_CODE: schoolCode,
      AY: String(ay),
      TI_FROM_YMD: from,
      TI_TO_YMD: to,
      GRADE: grade,
      CLASS_NM: classNm,
    })
    if (!ok) {
      return res.status(200).json({ timetable: [] })
    }

    const timetable: TimetableEntry[] = rows.map((row) => ({
      date: row.ALL_TI_YMD || '',
      period: Number(row.PERIO) || 0,
      subject: row.ITRT_CNTNT || '',
    }))

    res.setHeader('Cache-Control', NEIS_CACHE_CONTROL_OK)
    return res.status(200).json({ timetable })
  } catch (error) {
    // NEIS 실패 시에도 200 + 빈 배열 (UI에서 '정보 없음'으로 처리)
    console.error('Timetable API Error:', error)
    return res.status(200).json({ timetable: [] })
  }
}
