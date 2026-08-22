/**
 * NEIS 급식 정보 프록시 — 학생 포털의 '오늘의 급식'.
 * GET /api/meals?officeCode=B10&schoolCode=7010084&from=20260822&to=20260829
 */
import type { NextApiRequest, NextApiResponse } from 'next'

const NEIS_MEAL_URL = 'https://open.neis.go.kr/hub/mealServiceDietInfo'

// 인스턴스 메모리 캐시 (1시간)
const cache = new Map<string, { t: number; data: any }>()
const TTL = 60 * 60 * 1000

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const officeCode = String(req.query.officeCode || '').trim()
  const schoolCode = String(req.query.schoolCode || '').trim()
  const from = String(req.query.from || '').trim()
  const to = String(req.query.to || from).trim()

  if (!/^[A-Z]\d{2}$/i.test(officeCode) || !/^\d{4,10}$/.test(schoolCode) || !/^\d{8}$/.test(from)) {
    return res.status(400).json({ error: '잘못된 요청입니다.' })
  }

  const key = `${officeCode}:${schoolCode}:${from}:${to}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.t < TTL) {
    res.setHeader('x-cache', 'HIT')
    return res.status(200).json(hit.data)
  }

  try {
    const params = new URLSearchParams({
      Type: 'json',
      pIndex: '1',
      pSize: '30',
      ATPT_OFCDC_SC_CODE: officeCode.toUpperCase(),
      SD_SCHUL_CODE: schoolCode,
      MLSV_FROM_YMD: from,
      MLSV_TO_YMD: to,
    })
    if (process.env.NEIS_SERVICE_KEY) params.set('KEY', process.env.NEIS_SERVICE_KEY)

    const r = await fetch(`${NEIS_MEAL_URL}?${params.toString()}`)
    const j = await r.json()

    const rows = j?.mealServiceDietInfo?.[1]?.row ?? []
    const meals = rows.map((row: any) => ({
      date: row.MLSV_YMD, // YYYYMMDD
      type: row.MMEAL_SC_NM, // 조식/중식/석식
      menu: String(row.DDISH_NM || '')
        .split(/<br\s*\/?\s*>/i)
        .map((s: string) => s.replace(/\([^)]*\)/g, '').trim()) // 알레르기 번호 제거
        .filter(Boolean),
      calories: row.CAL_INFO || null,
    }))

    const data = { meals }
    cache.set(key, { t: Date.now(), data })
    return res.status(200).json(data)
  } catch (e) {
    console.error('[api/meals]', e)
    return res.status(500).json({ error: '급식 정보를 가져오지 못했습니다.' })
  }
}
