import type { NextApiRequest, NextApiResponse } from 'next'
import {
  fetchNeisResult,
  isOffDayRow,
  lookupOfficeCode,
  todayKstYmd,
  GRADE_EVENT_FIELDS,
  NEIS_CACHE_CONTROL_ERROR,
  NEIS_CACHE_CONTROL_OK,
  type NeisRow,
} from '../../lib/neis'

interface CalendarEvent {
  date: string
  name: string
  /** 등교하지 않는 날(휴업일·공휴일·방학) */
  offDay: boolean
  /** 일부 학년만 쉬는 날이면 그 학년들(1~6). 없으면 학교 전체가 쉼 */
  offGrades?: number[]
}

/**
 * 쉬는 날 행인지는 src/lib/neis.ts의 isOffDayRow(학년 없이)로 판정합니다(크론 브리핑과 같은 기준).
 * - 학년별 해당 여부(*_GRADE_EVENT_YN)에 'Y'가 있으면 'N'이 아닌 학년만 쉬는 날(offGrades)
 */
function offDayOf(row: NeisRow): Pick<CalendarEvent, 'offDay' | 'offGrades'> {
  if (!isOffDayRow(row)) return { offDay: false }
  const flags = GRADE_EVENT_FIELDS.map((f) => row[f])
  if (!flags.includes('Y')) return { offDay: true }
  return { offDay: true, offGrades: flags.flatMap((f, i) => (f === 'N' ? [] : [i + 1])) }
}

// GET /api/calendar?schoolCode=&officeCode=&from=YYYYMMDD&to=YYYYMMDD
// 학사일정(SchoolSchedule). officeCode 생략 시 자동 조회, 날짜 생략 시 오늘(KST)
// 응답: { events: [{ date: YYYYMMDD, name, offDay, offGrades? }] }
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
    return res.status(200).json({ events: [] })
  }

  try {
    let officeCode = (req.query.officeCode as string) || null
    if (!officeCode) {
      const lookup = await lookupOfficeCode(schoolCode)
      if (!lookup.ok) {
        return res.status(200).json({ events: [] })
      }
      officeCode = lookup.officeCode
    }

    if (!officeCode) {
      return res.status(200).json({ events: [] })
    }

    const { ok, rows } = await fetchNeisResult('SchoolSchedule', {
      ATPT_OFCDC_SC_CODE: officeCode,
      SD_SCHUL_CODE: schoolCode,
      AA_FROM_YMD: from,
      AA_TO_YMD: to,
    })
    if (!ok) {
      return res.status(200).json({ events: [] })
    }

    // '토요휴업일'이 같은 날짜에 중복으로 내려오는 경우만 걸러냄
    const seenSaturdayOff = new Set<string>()
    const events: CalendarEvent[] = []

    for (const row of rows) {
      const date = row.AA_YMD || ''
      const name = row.EVENT_NM || ''
      if (!name) continue

      if (name === '토요휴업일') {
        if (seenSaturdayOff.has(date)) continue
        seenSaturdayOff.add(date)
      }

      events.push({ date, name, ...offDayOf(row) })
    }

    res.setHeader('Cache-Control', NEIS_CACHE_CONTROL_OK)
    return res.status(200).json({ events })
  } catch (error) {
    // NEIS 실패 시에도 200 + 빈 배열 (UI에서 '정보 없음'으로 처리)
    console.error('Calendar API Error:', error)
    return res.status(200).json({ events: [] })
  }
}
