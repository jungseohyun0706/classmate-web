import type { NextApiRequest, NextApiResponse } from 'next'
import { timingSafeEqual } from 'crypto'
import { FieldPath, getFirestore } from 'firebase-admin/firestore'
import type { QueryDocumentSnapshot } from 'firebase-admin/firestore'
import {
  fetchNeis,
  isOffDay,
  mergeTimetableRows,
  neisTimetableEndpoint,
  todayKstYmd,
} from '../../../lib/neis'
import type { NeisRow } from '../../../lib/neis'
import { getAdminApp, isAdminConfigured, sendPushToUser } from '../../../lib/fcm-admin'

// GET /api/cron/morning-brief
// Vercel Cron(0 23 * * 0-4 UTC = KST 평일 08:00)이 Authorization: Bearer CRON_SECRET
// 헤더와 함께 호출합니다. 시크릿이 로그·브라우저 기록에 남지 않도록 쿼리스트링(?key=)은 받지 않습니다.
// 수동 실행: curl -H "Authorization: Bearer $CRON_SECRET" https://<도메인>/api/cron/morning-brief
// 각 학급 담임에게 오늘의 브리핑(1~2교시 + 급식 + 받은 교환 요청 수)을 푸시합니다.
// 학사일정(NEIS)에서 오늘이 휴업일·공휴일·방학인 학교(학년)는 건너뜁니다.

// 60초는 모든 Vercel 플랜에서 허용되는 값입니다. 기본값(10~15초)이면 학급이 많을 때 중간에 끊깁니다.
export const config = { maxDuration: 60 }

const PAGE_SIZE = 300
const CLASS_CONCURRENCY = 8
const NEIS_TIMEOUT_MS = 5000
// maxDuration 전에 새 학급 처리를 멈추고, 못 한 학급을 로그로 남기기 위한 여유
const TIME_BUDGET_MS = 50 * 1000

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

/** 길이가 달라도 실행 시간이 크게 달라지지 않도록 맞춘 비교 */
function safeCompare(input: string, expected: string): boolean {
  const a = Buffer.from(input, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) {
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

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

/** NEIS 응답이 늦어도 학급 처리가 밀리지 않게 상한을 둡니다. 늦으면 빈 결과(조회 실패와 같은 처리)로 넘어갑니다. */
function neisWithTimeout(promise: Promise<NeisRow[]>): Promise<NeisRow[]> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), NEIS_TIMEOUT_MS)
    promise.then(
      (rows) => {
        clearTimeout(timer)
        resolve(rows)
      },
      () => {
        clearTimeout(timer)
        resolve([])
      }
    )
  })
}

/** 같은 키는 첫 호출의 Promise를 공유합니다(동시에 처리되는 같은 학교 학급도 NEIS는 한 번만 호출). */
function memo<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let p = cache.get(key)
  if (!p) {
    p = load()
    cache.set(key, p)
  }
  return p
}

/** items를 최대 limit개씩 동시에 처리합니다. worker는 스스로 오류를 처리해야 합니다. */
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        await worker(items[next++])
      }
    })
  )
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const startedAt = Date.now()

  if (req.method && req.method !== 'GET') {
    return res.status(405).json({ error: '허용되지 않는 요청입니다.' })
  }

  const secret = process.env.CRON_SECRET
  if (!secret) {
    return res.status(503).json({ error: 'cron-not-configured' })
  }
  const authHeader = req.headers.authorization || ''
  if (!safeCompare(authHeader, `Bearer ${secret}`)) {
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
  const todayKey = DAY_KEYS[kstDay]

  let classCount = 0
  let sent = 0
  let noTokens = 0
  let skipped = 0
  let dayOff = 0
  let failed = 0
  const unprocessedIds: string[] = []
  let unreadAfterId: string | null = null

  const outOfTime = () => Date.now() - startedAt > TIME_BUDGET_MS

  // 같은 학교 학급들이 NEIS를 중복 호출하지 않도록 학교 단위 캐시
  const schoolInfoCache = new Map<string, Promise<NeisRow | null>>()
  const scheduleCache = new Map<string, Promise<NeisRow[]>>()
  const mealCache = new Map<string, Promise<string>>()

  const getSchoolInfo = (schoolCode: string) =>
    memo(schoolInfoCache, schoolCode, async () => {
      const rows = await neisWithTimeout(fetchNeis('schoolInfo', { SD_SCHUL_CODE: schoolCode }))
      return rows[0] ?? null
    })

  const processClass = async (classDoc: QueryDocumentSnapshot) => {
    const c = classDoc.data()
    const teacherId: string = typeof c.teacherId === 'string' ? c.teacherId : ''
    const schoolCode: string = typeof c.schoolCode === 'string' ? c.schoolCode : ''
    // 수업 그룹(교사 개인 소유)은 브리핑 대상이 아님 — 실반(담임 반)만
    if (!teacherId || !schoolCode || c.isGroup === true) {
      skipped += 1
      return
    }
    if (outOfTime()) {
      unprocessedIds.push(classDoc.id)
      return
    }

    try {
      // officeCode: 문서 값 → NEIS schoolInfo 조회 순
      const officeCode: string | null =
        (typeof c.officeCode === 'string' && c.officeCode) ||
        (await getSchoolInfo(schoolCode))?.ATPT_OFCDC_SC_CODE ||
        null

      // 오늘이 휴업일·공휴일(방학 포함)이면 이 학급은 건너뜀
      if (officeCode) {
        const scheduleRows = await memo(scheduleCache, schoolCode, () =>
          neisWithTimeout(
            fetchNeis('SchoolSchedule', {
              ATPT_OFCDC_SC_CODE: officeCode,
              SD_SCHUL_CODE: schoolCode,
              AA_FROM_YMD: today,
              AA_TO_YMD: today,
            })
          )
        )
        // 조회 실패(빈 배열)면 쉬는 날로 보지 않고 평소처럼 발송
        if (isOffDay(scheduleRows, today, c.grade)) {
          dayOff += 1
          return
        }
      }

      const parts: string[] = []

      // 오늘 시간표 앞 두 교시: 학급 시간표(info/timetable) 기본, 없으면 NEIS, 그 위에 오늘 변경(overrides)
      const [ttSnap, ovSnap] = await Promise.all([
        db.collection('classes').doc(classDoc.id).collection('info').doc('timetable').get(),
        db.collection('classes').doc(classDoc.id).collection('overrides').doc(today).get(),
      ])
      const byPeriod = new Map<number, string>()
      const rawDay = ttSnap.exists ? ttSnap.get(todayKey) : null
      if (Array.isArray(rawDay)) {
        rawDay.forEach((s: unknown, i: number) => {
          const subject = typeof s === 'string' ? s.trim() : ''
          if (subject) byPeriod.set(i + 1, subject)
        })
      }
      if (byPeriod.size === 0 && officeCode) {
        // 학교 정보를 못 받았으면 학교 종류를 몰라 NEIS 시간표는 생략
        const schoolInfo = await getSchoolInfo(schoolCode)
        if (schoolInfo) {
          const ttRows = await neisWithTimeout(
            fetchNeis(neisTimetableEndpoint(schoolInfo.SCHUL_KND_SC_NM || ''), {
              ATPT_OFCDC_SC_CODE: officeCode,
              SD_SCHUL_CODE: schoolCode,
              ALL_TI_YMD: today,
              GRADE: String(c.grade ?? ''),
              CLASS_NM: String(c.classNm ?? ''),
            })
          )
          // 같은 교시에 행이 여럿(고교학점제 선택과목 등)이면 /api/timetable과 같이 과목을 ' / '로 이어 씀
          for (const { period, subject } of mergeTimetableRows(ttRows)) {
            if (!period || byPeriod.has(period)) continue
            byPeriod.set(period, subject)
          }
        }
      }
      const periods = ovSnap.exists ? ovSnap.get('periods') : null
      if (periods && typeof periods === 'object') {
        for (const [p, entry] of Object.entries(periods as Record<string, { subject?: unknown }>)) {
          const subject =
            entry && typeof entry.subject === 'string' ? entry.subject.trim() : ''
          const n = Number(p)
          if (!subject || !Number.isInteger(n) || n < 1) continue
          byPeriod.set(n, subject)
        }
      }
      const firstTwo = Array.from(byPeriod.entries())
        .sort((a, b) => a[0] - b[0])
        .slice(0, 2)
        .map(([p, subject]) => `${p}교시 ${subject}`)
      if (firstTwo.length > 0) {
        parts.push(firstTwo.join(' · '))
      }

      // 급식 (학교 단위 1회 조회)
      if (officeCode) {
        const mealSummary = await memo(mealCache, schoolCode, async () => {
          const mealRows = await neisWithTimeout(
            fetchNeis('mealServiceDietInfo', {
              ATPT_OFCDC_SC_CODE: officeCode,
              SD_SCHUL_CODE: schoolCode,
              MLSV_FROM_YMD: today,
              MLSV_TO_YMD: today,
            })
          )
          // 조식·석식을 주는 학교도 있으므로 중식(MMEAL_SC_CODE '2')을 우선, 없으면 첫 끼니
          const lunch = mealRows.find((r) => String(r.MMEAL_SC_CODE ?? '') === '2') ?? mealRows[0]
          return summarizeMeal(lunch?.DDISH_NM || '')
        })
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
      // 수업 날짜가 지난 요청은 수락할 수 없으므로 빼고 셈 (date 없는 레거시 요청은 포함)
      const pendingCount = pendingSnap.docs.filter((d) => !d.get('date') || d.get('date') >= today).length
      if (pendingCount > 0) {
        parts.push(`받은 교환 요청 ${pendingCount}건`)
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

  try {
    // 문서 ID 순으로 끝까지 페이지를 넘기며 전체 학급을 순회 (수업 그룹은 processClass에서 거름)
    let lastDoc: QueryDocumentSnapshot | null = null
    for (;;) {
      if (outOfTime()) {
        unreadAfterId = lastDoc ? lastDoc.id : ''
        break
      }
      let q = db.collection('classes').orderBy(FieldPath.documentId()).limit(PAGE_SIZE)
      if (lastDoc) q = q.startAfter(lastDoc)
      const page = await q.get()
      classCount += page.size

      // 페이지 안의 학급은 동시성 상한을 두고 병렬 처리
      await runPool(page.docs, CLASS_CONCURRENCY, processClass)

      if (page.size < PAGE_SIZE) break
      lastDoc = page.docs[page.docs.length - 1]
    }

    if (unprocessedIds.length > 0 || unreadAfterId !== null) {
      console.error(
        `morning-brief: 실행 시간 한도(${TIME_BUDGET_MS / 1000}초)에 걸려 일부 학급을 처리하지 못했어요. ` +
          `미처리 ${unprocessedIds.length}개: ${unprocessedIds.slice(0, 20).join(', ')}` +
          (unprocessedIds.length > 20 ? ' 외' : '') +
          (unreadAfterId !== null
            ? ` / 문서 ID '${unreadAfterId}' 이후로는 학급을 조회하지 못했어요.`
            : '')
      )
    }

    return res.status(200).json({
      date: today,
      classes: classCount,
      sent,
      noTokens,
      skipped,
      dayOff,
      failed,
      unprocessed: unprocessedIds.length,
      truncated: unreadAfterId !== null,
    })
  } catch (e) {
    console.error('morning-brief error:', e)
    return res
      .status(500)
      .json({ error: 'internal-error', classes: classCount, sent, noTokens, skipped, dayOff, failed })
  }
}
