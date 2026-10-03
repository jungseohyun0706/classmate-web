import type { NextApiRequest, NextApiResponse } from 'next'
import {
  fetchNeisResult,
  lookupSchool,
  mergeTimetableRows,
  neisTimetableEndpoint,
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
// 학교 종류에 맞는 NEIS 시간표(초 elsTimetable, 중 misTimetable, 고 hisTimetable, 특수 spsTimetable).
// officeCode 생략 시 자동 조회, 날짜 생략 시 오늘(KST)
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
    // officeCode가 와도 학교 종류로 데이터셋을 골라야 하므로 학교 정보는 항상 조회 (메모리 캐시됨).
    // 조회 실패 시 종류를 모른 채 초등 데이터셋을 부르면 중·고교는 '데이터 없음'으로 길게 캐시되므로 여기서 멈춤
    const school = await lookupSchool(schoolCode)
    if (!school.ok) {
      return res.status(200).json({ timetable: [] })
    }
    const officeCode = (req.query.officeCode as string) || school.officeCode

    if (!officeCode) {
      return res.status(200).json({ timetable: [] })
    }

    // 학년도(AY): 1~2월은 전년도 학년도에 속함
    // 학기(SEM)는 보내지 않음: 2학기 개학일이 학교마다 달라(8월 중하순) 월로 계산하면 행이 걸러짐
    const year = Number(from.slice(0, 4))
    const month = Number(from.slice(4, 6))
    const ay = month <= 2 ? year - 1 : year

    const { ok, rows } = await fetchNeisResult(neisTimetableEndpoint(school.kind), {
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

    // 같은 교시에 행이 여럿(고교학점제 선택과목 등)이면 한 항목으로 합쳐
    // 오늘 화면·가방 목록·아침 브리핑이 같은 과목을 보게 함
    const timetable: TimetableEntry[] = mergeTimetableRows(rows)

    res.setHeader('Cache-Control', NEIS_CACHE_CONTROL_OK)
    return res.status(200).json({ timetable })
  } catch (error) {
    // NEIS 실패 시에도 200 + 빈 배열 (UI에서 '정보 없음'으로 처리)
    console.error('Timetable API Error:', error)
    return res.status(200).json({ timetable: [] })
  }
}
