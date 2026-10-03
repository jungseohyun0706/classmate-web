import type { NextApiRequest, NextApiResponse } from 'next'
import { timingSafeEqual } from 'crypto'
import { FieldPath, getFirestore } from 'firebase-admin/firestore'
import type { QueryDocumentSnapshot } from 'firebase-admin/firestore'
import { fetchNeis, isOffDay } from '../../../lib/neis'
import type { NeisRow } from '../../../lib/neis'
import { getAdminApp, isAdminConfigured, sendPushToUser } from '../../../lib/fcm-admin'

// GET /api/cron/evening-brief
// Vercel Cron(0 12 * * 0-4 UTC = KST 일~목 21:00)이 Authorization: Bearer CRON_SECRET
// 헤더와 함께 호출합니다. 시크릿이 로그·브라우저 기록에 남지 않도록 쿼리스트링(?key=)은 받지 않습니다.
// 수동 실행: curl -H "Authorization: Bearer $CRON_SECRET" https://<도메인>/api/cron/evening-brief
// 각 학급의 내일 시간표(변경 오버라이드 반영)를 '내일 가방' 푸시로 (학생에게는 '학급 시간표 기준'으로 표시 — 개인 시간표 아님)
// 담임 선생님과 승인된 학생들에게 보냅니다.
// 학사일정(NEIS)에서 내일이 휴업일·공휴일·방학인 학교(학년)는 건너뜁니다.

// 60초는 모든 Vercel 플랜에서 허용되는 값입니다. 기본값(10~15초)이면 학급이 많을 때 중간에 끊깁니다.
export const config = { maxDuration: 60 }

const PAGE_SIZE = 300
const CLASS_CONCURRENCY = 4
const PUSH_CONCURRENCY = 10
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

/** 내일 날짜를 KST(Asia/Seoul) 기준으로 { 요일 번호, 시간표 키, YYYYMMDD }로 반환합니다. */
function tomorrowKst(): { day: number; key: string; ymd: string } {
  const kst = new Date(Date.now() + (9 + 24) * 60 * 60 * 1000)
  const y = kst.getUTCFullYear()
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0')
  const d = String(kst.getUTCDate()).padStart(2, '0')
  const day = kst.getUTCDay()
  return { day, key: DAY_KEYS[day], ymd: `${y}${m}${d}` }
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

  // 내일이 주말(KST 토/일)이면 보낼 시간표가 없으므로 발송하지 않음
  const tomorrow = tomorrowKst()
  if (tomorrow.day === 0 || tomorrow.day === 6) {
    return res.status(200).json({ skipped: 'weekend' })
  }

  const db = getFirestore(app)

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
  const officeCache = new Map<string, Promise<string | null>>()
  const scheduleCache = new Map<string, Promise<NeisRow[]>>()

  const processClass = async (classDoc: QueryDocumentSnapshot) => {
    const c = classDoc.data()
    const classId: string =
      (typeof c.classId === 'string' && c.classId) || classDoc.id
    const teacherId: string = typeof c.teacherId === 'string' ? c.teacherId : ''
    const schoolCode: string = typeof c.schoolCode === 'string' ? c.schoolCode : ''
    // 수업 그룹(교사 개인 소유)은 브리핑 대상이 아님 — 실반(담임 반)만
    if (c.isGroup === true) {
      skipped += 1
      return
    }
    if (outOfTime()) {
      unprocessedIds.push(classDoc.id)
      return
    }

    try {
      // 0) 내일이 휴업일·공휴일(방학 포함)이면 이 학급은 건너뜀. officeCode: 문서 값 → NEIS schoolInfo 조회 순
      if (schoolCode) {
        const officeCode =
          (typeof c.officeCode === 'string' && c.officeCode) ||
          (await memo(officeCache, schoolCode, async () => {
            const rows = await neisWithTimeout(fetchNeis('schoolInfo', { SD_SCHUL_CODE: schoolCode }))
            return rows[0]?.ATPT_OFCDC_SC_CODE || null
          }))
        if (officeCode) {
          const scheduleRows = await memo(scheduleCache, schoolCode, () =>
            neisWithTimeout(
              fetchNeis('SchoolSchedule', {
                ATPT_OFCDC_SC_CODE: officeCode,
                SD_SCHUL_CODE: schoolCode,
                AA_FROM_YMD: tomorrow.ymd,
                AA_TO_YMD: tomorrow.ymd,
              })
            )
          )
          // 조회 실패(빈 배열)면 쉬는 날로 보지 않고 평소처럼 발송
          if (isOffDay(scheduleRows, tomorrow.ymd, c.grade)) {
            dayOff += 1
            return
          }
        }
      }

      // 1) 내일 기본 시간표 (classes/{id}/info/timetable 의 mon..fri 배열)
      const ttSnap = await db
        .collection('classes')
        .doc(classDoc.id)
        .collection('info')
        .doc('timetable')
        .get()
      const rawDay = ttSnap.exists ? ttSnap.get(tomorrow.key) : null
      const subjects: string[] = Array.isArray(rawDay)
        ? rawDay.map((s: unknown) => (typeof s === 'string' ? s.trim() : ''))
        : []

      // 2) 내일 변경 오버라이드 (classes/{id}/overrides/{YYYYMMDD})
      const ovSnap = await db
        .collection('classes')
        .doc(classDoc.id)
        .collection('overrides')
        .doc(tomorrow.ymd)
        .get()
      const periods = ovSnap.exists ? ovSnap.get('periods') : null
      const overrideNotes: string[] = []
      if (periods && typeof periods === 'object') {
        const periodKeys = Object.keys(periods).sort(
          (a, b) => Number(a) - Number(b)
        )
        for (const p of periodKeys) {
          const entry = (periods as Record<string, { subject?: unknown }>)[p]
          const subject =
            entry && typeof entry.subject === 'string' ? entry.subject.trim() : ''
          const idx = Number(p) - 1
          if (!subject || !Number.isInteger(idx) || idx < 0) continue
          while (subjects.length <= idx) subjects.push('')
          subjects[idx] = subject
          overrideNotes.push(`${p}교시 ${subject}`)
        }
      }

      // 시간표가 비어 있으면 이 학급은 건너뜀
      const filled = subjects.filter((s) => s.length > 0)
      if (filled.length === 0) {
        skipped += 1
        return
      }

      let body = `내일 시간표: ${filled.slice(0, 4).join(' · ')}`
      if (overrideNotes.length > 0) {
        body += ` (변경: ${overrideNotes.join(', ')})`
      }

      // 학생에게는 학급 시간표를 '내 시간표'처럼 보내지 않음: 선택 과목·수업반이 학생마다 다를 수 있어
      // '학급 시간표 기준'임을 밝히고, 내 수업(개인 시간표)은 앱에서 보게 함
      let studentBody = `학급 시간표 기준: ${filled.slice(0, 4).join(' · ')}`
      if (overrideNotes.length > 0) {
        studentBody += ` (학급 변경: ${overrideNotes.join(', ')})`
      }
      studentBody += ' · 내 수업은 앱에서 확인하세요'

      // 3) 받는 사람: 담임 + 승인된 학생(푸시 토큰 보유자)
      const targets: { uid: string; url: string; body: string }[] = []
      if (teacherId) {
        targets.push({ uid: teacherId, url: '/dashboard', body })
      }
      const studentsSnap = await db
        .collection('users')
        .where('classId', '==', classId)
        .where('role', '==', 'student')
        .where('status', '==', 'approved')
        .get()
      // '내일 가방' 알림이므로 가방 체크리스트가 있는 홈으로 — ?date=내일로 홈의 개인 시간표 카드도 내일을 보여 줌
      for (const sDoc of studentsSnap.docs) {
        const tokens = sDoc.get('fcmTokens')
        if (Array.isArray(tokens) && tokens.length > 0) {
          targets.push({ uid: sDoc.id, url: `/student/today?date=${tomorrow.ymd}`, body: studentBody })
        }
      }

      // sendPushToUser는 실패해도 throw하지 않고 결과로 알려 줌
      await runPool(targets, PUSH_CONCURRENCY, async (target) => {
        const result = await sendPushToUser(target.uid, {
          title: '내일 가방',
          body: target.body,
          url: target.url,
        })
        if (result.sent) {
          sent += 1
        } else if (result.reason === 'no-tokens') {
          noTokens += 1
        } else {
          failed += 1
        }
      })
    } catch (e) {
      console.error(`evening-brief: class ${classDoc.id} error:`, e)
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
        `evening-brief: 실행 시간 한도(${TIME_BUDGET_MS / 1000}초)에 걸려 일부 학급을 처리하지 못했어요. ` +
          `미처리 ${unprocessedIds.length}개: ${unprocessedIds.slice(0, 20).join(', ')}` +
          (unprocessedIds.length > 20 ? ' 외' : '') +
          (unreadAfterId !== null
            ? ` / 문서 ID '${unreadAfterId}' 이후로는 학급을 조회하지 못했어요.`
            : '')
      )
    }

    return res.status(200).json({
      date: tomorrow.ymd,
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
    console.error('evening-brief error:', e)
    return res
      .status(500)
      .json({ error: 'internal-error', classes: classCount, sent, noTokens, skipped, dayOff, failed })
  }
}
