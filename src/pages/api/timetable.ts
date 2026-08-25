import type { NextApiRequest, NextApiResponse } from 'next'
import { fetchNeis, resolveOfficeCode, todayKstYmd } from '../../lib/neis'

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

  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400')

  const schoolCode = (req.query.schoolCode as string) || ''
  const grade = (req.query.grade as string) || ''
  const classNm = (req.query.classNm as string) || ''
  const from = (req.query.from as string) || todayKstYmd()
  const to = (req.query.to as string) || from

  if (!schoolCode || !grade || !classNm) {
    return res.status(200).json({ timetable: [] })
  }

  try {
    const officeCode =
      (req.query.officeCode as string) || (await resolveOfficeCode(schoolCode))

    if (!officeCode) {
      return res.status(200).json({ timetable: [] })
    }

    // 학년도(AY): 1~2월은 전년도 학년도에 속함 / 학기(SEM): 3~8월은 1학기, 그 외 2학기
    const year = Number(from.slice(0, 4))
    const month = Number(from.slice(4, 6))
    const ay = month <= 2 ? year - 1 : year
    const sem = month >= 3 && month <= 8 ? '1' : '2'

    const rows = await fetchNeis('elsTimetable', {
      ATPT_OFCDC_SC_CODE: officeCode,
      SD_SCHUL_CODE: schoolCode,
      AY: String(ay),
      SEM: sem,
      TI_FROM_YMD: from,
      TI_TO_YMD: to,
      GRADE: grade,
      CLASS_NM: classNm,
    })

    const timetable: TimetableEntry[] = rows.map((row) => ({
      date: row.ALL_TI_YMD || '',
      period: Number(row.PERIO) || 0,
      subject: row.ITRT_CNTNT || '',
    }))

    return res.status(200).json({ timetable })
  } catch (error) {
    // NEIS 실패 시에도 200 + 빈 배열 (UI에서 '정보 없음'으로 처리)
    console.error('Timetable API Error:', error)
    return res.status(200).json({ timetable: [] })
  }
}
