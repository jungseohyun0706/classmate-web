import type { NextApiRequest, NextApiResponse } from 'next'
import { getFirestore } from 'firebase-admin/firestore'
import { getAdminApp, isAdminConfigured, sendPushToUser } from '../../../lib/fcm-admin'

// GET /api/cron/evening-brief
// Vercel Cron(0 12 * * 0-4 UTC = KST 일~목 21:00)이 Authorization: Bearer CRON_SECRET
// 헤더와 함께 호출합니다. 수동 호출은 ?key=CRON_SECRET 도 지원합니다.
// 각 학급의 내일 시간표(변경 오버라이드 반영)를 '내일 가방' 푸시로
// 담임 선생님과 승인된 학생들에게 보냅니다.

const MAX_CLASSES = 300

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

/** 내일 날짜를 KST(Asia/Seoul) 기준으로 { 요일 번호, 시간표 키, YYYYMMDD }로 반환합니다. */
function tomorrowKst(): { day: number; key: string; ymd: string } {
  const kst = new Date(Date.now() + (9 + 24) * 60 * 60 * 1000)
  const y = kst.getUTCFullYear()
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0')
  const d = String(kst.getUTCDate()).padStart(2, '0')
  const day = kst.getUTCDay()
  return { day, key: DAY_KEYS[day], ymd: `${y}${m}${d}` }
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
  let failed = 0

  try {
    const classesSnap = await db.collection('classes').limit(MAX_CLASSES).get()
    classCount = classesSnap.size

    for (const classDoc of classesSnap.docs) {
      const c = classDoc.data()
      const classId: string =
        (typeof c.classId === 'string' && c.classId) || classDoc.id
      const teacherId: string = typeof c.teacherId === 'string' ? c.teacherId : ''

      try {
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
          continue
        }

        let body = `내일 시간표: ${filled.slice(0, 4).join(' · ')}`
        if (overrideNotes.length > 0) {
          body += ` (변경: ${overrideNotes.join(', ')})`
        }

        // 3) 받는 사람: 담임 + 승인된 학생(푸시 토큰 보유자)
        const targets: { uid: string; url: string }[] = []
        if (teacherId) {
          targets.push({ uid: teacherId, url: '/dashboard' })
        }
        const studentsSnap = await db
          .collection('users')
          .where('classId', '==', classId)
          .where('role', '==', 'student')
          .where('status', '==', 'approved')
          .get()
        for (const sDoc of studentsSnap.docs) {
          const tokens = sDoc.get('fcmTokens')
          if (Array.isArray(tokens) && tokens.length > 0) {
            targets.push({ uid: sDoc.id, url: '/student/today' })
          }
        }

        for (const target of targets) {
          const result = await sendPushToUser(target.uid, {
            title: '내일 가방',
            body,
            url: target.url,
          })
          if (result.sent) {
            sent += 1
          } else if (result.reason === 'no-tokens') {
            noTokens += 1
          } else {
            failed += 1
          }
        }
      } catch (e) {
        console.error(`evening-brief: class ${classDoc.id} error:`, e)
        failed += 1
      }
    }

    return res
      .status(200)
      .json({ date: tomorrow.ymd, classes: classCount, sent, noTokens, skipped, failed })
  } catch (e) {
    console.error('evening-brief error:', e)
    return res
      .status(500)
      .json({ error: 'internal-error', classes: classCount, sent, noTokens, skipped, failed })
  }
}
