import type { NextApiRequest, NextApiResponse } from 'next'
import { getFirestore } from 'firebase-admin/firestore'
import { fetchNeis, resolveOfficeCode, todayKstYmd } from '../../../lib/neis'
import { getAdminApp, isAdminConfigured, sendPushToUser } from '../../../lib/fcm-admin'

// GET /api/cron/morning-brief
// Vercel Cron(0 23 * * 0-4 UTC = KST 평일 08:00)이 Authorization: Bearer CRON_SECRET
// 헤더와 함께 호출합니다. 수동 호출은 ?key=CRON_SECRET 도 지원합니다.
// 각 학급 담임에게 오늘의 브리핑(1~2교시 + 급식 + 받은 교환 요청 수)을 푸시합니다.

const MAX_CLASSES = 300

/** 급식 메뉴 문자열에서 앞 3개 항목만 뽑아 요약합니다. */
function summarizeMeal(dishRaw: string): string {
  const items = dishRaw
    .split(/<br\s*\/?>/i)
    .map((item) =>
      item
        .replace(/<[^>]*>/g, '')
        // 뒤쪽 알레르기 표기 "(1.2.5.)" 제거
        .replace(/\s*\([0-9.\s]+\)\s*$/, '')
        .trim()
    )
    .filter((item) => item.length > 0)
    .slice(0, 3)
  return items.length > 0 ? `급식: ${items.join(', ')}` : ''
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method && req.method !== 'GET') {
    return res.status(405).json({ error: '허용되지 않는 요청입니다.' })
  }

  const secret = process.env.CRON_SECRET
  if (!secret) {
    return res.status(503).json({ error: 'cron-not-configured' })
  }
  const authHeader = req.headers.authorization || ''
  const key = typeof req.query.key === 'string' ? req.query.key : ''
  if (authHeader !== `Bearer ${secret}` && key !== secret) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  if (!isAdminConfigured()) {
    return res.status(503).json({ error: 'push-not-configured' })
  }
  const app = getAdminApp()
  if (!app) {
    return res.status(503).json({ error: 'push-not-configured' })
  }

  // 주말(KST 토/일)은 발송하지 않음
  const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const kstDay = kstNow.getUTCDay()
  if (kstDay === 0 || kstDay === 6) {
    return res.status(200).json({ skipped: 'weekend' })
  }

  const db = getFirestore(app)
  const today = todayKstYmd()

  let classCount = 0
  let sent = 0
  let noTokens = 0
  let skipped = 0
  let failed = 0

  try {
    const classesSnap = await db.collection('classes').limit(MAX_CLASSES).get()
    classCount = classesSnap.size

    // 같은 학교 학급들이 NEIS를 중복 호출하지 않도록 학교 단위 캐시
    const officeCache = new Map<string, string | null>()
    const mealCache = new Map<string, string>()

    for (const classDoc of classesSnap.docs) {
      const c = classDoc.data()
      const teacherId: string = typeof c.teacherId === 'string' ? c.teacherId : ''
      const schoolCode: string = typeof c.schoolCode === 'string' ? c.schoolCode : ''
      // 수업 그룹(교사 개인 소유)은 브리핑 대상이 아님 — 실반(담임 반)만
      if (!teacherId || !schoolCode || c.isGroup === true) {
        skipped += 1
        continue
      }

      try {
        // officeCode: 문서 값 → 캐시 → NEIS 조회 순
        let officeCode: string | null =
          (typeof c.officeCode === 'string' && c.officeCode) || null
        if (!officeCode) {
          if (officeCache.has(schoolCode)) {
            officeCode = officeCache.get(schoolCode) ?? null
          } else {
            officeCode = await resolveOfficeCode(schoolCode)
            officeCache.set(schoolCode, officeCode)
          }
        }

        const parts: string[] = []

        if (officeCode) {
          // 오늘 시간표 앞 두 교시
          const ttRows = await fetchNeis('elsTimetable', {
            ATPT_OFCDC_SC_CODE: officeCode,
            SD_SCHUL_CODE: schoolCode,
            ALL_TI_YMD: today,
            GRADE: String(c.grade ?? ''),
            CLASS_NM: String(c.classNm ?? ''),
          })
          const firstTwo = ttRows
            .slice()
            .sort((a, b) => Number(a.PERIO || 0) - Number(b.PERIO || 0))
            .slice(0, 2)
            .map((r) => `${r.PERIO}교시 ${(r.ITRT_CNTNT || '').trim()}`.trim())
            .filter((s) => s.length > 0)
          if (firstTwo.length > 0) {
            parts.push(firstTwo.join(' · '))
          }

          // 급식 (학교 단위 1회 조회)
          let mealSummary = mealCache.get(schoolCode)
          if (mealSummary === undefined) {
            const mealRows = await fetchNeis('mealServiceDietInfo', {
              ATPT_OFCDC_SC_CODE: officeCode,
              SD_SCHUL_CODE: schoolCode,
              MLSV_FROM_YMD: today,
              MLSV_TO_YMD: today,
            })
            mealSummary = summarizeMeal(mealRows[0]?.DDISH_NM || '')
            mealCache.set(schoolCode, mealSummary)
          }
          if (mealSummary) {
            parts.push(mealSummary)
          }
        }

        // 나에게 온 대기 중 교환 요청 수
        const pendingSnap = await db
          .collection('school_swaps')
          .doc(schoolCode)
          .collection('direct_requests')
          .where('toId', '==', teacherId)
          .where('status', '==', 'pending')
          .get()
        if (pendingSnap.size > 0) {
          parts.push(`받은 교환 요청 ${pendingSnap.size}건`)
        }

        const body =
          parts.length > 0 ? parts.join(' | ') : '오늘도 좋은 하루 보내세요!'

        const result = await sendPushToUser(teacherId, {
          title: '오늘의 우리 반 브리핑',
          body,
          url: '/dashboard',
        })
        if (result.sent) {
          sent += 1
        } else if (result.reason === 'no-tokens') {
          noTokens += 1
        } else {
          failed += 1
        }
      } catch (e) {
        console.error(`morning-brief: class ${classDoc.id} error:`, e)
        failed += 1
      }
    }

    return res.status(200).json({ date: today, classes: classCount, sent, noTokens, skipped, failed })
  } catch (e) {
    console.error('morning-brief error:', e)
    return res
      .status(500)
      .json({ error: 'internal-error', classes: classCount, sent, noTokens, skipped, failed })
  }
}
