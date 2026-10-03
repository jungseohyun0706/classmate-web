import type { NextApiRequest, NextApiResponse } from 'next'
import { getFirestore } from 'firebase-admin/firestore'
import {
  getAdminApp,
  isAdminConfigured,
  sendPushToUser,
  toSafePushPath,
  verifyIdToken,
} from '../../lib/fcm-admin'

const TITLE_MAX = 100
const BODY_MAX = 500
// 학생 수신자의 반 확인: 본반·반 이동 신청 반·추가 반을 모두 보되(추가 반 개수 제한이 없음),
// 비정상적으로 긴 목록에 대비해 상한을 두고 10개씩 나눠 읽으며 담임을 찾으면 멈춥니다.
const MAX_CLASS_LOOKUPS = 100
const LOOKUP_CHUNK = 10
const CLASS_ID_RE = /^[A-Za-z0-9_-]{1,80}$/

// 발신자(uid)별 횟수 제한 — 인스턴스 메모리 기반 best-effort.
// 서버리스는 인스턴스가 여러 개 뜨거나 재시작되면 카운트가 나뉘거나 초기화돼서 완벽하지 않아요.
// SOS 한 번에 빈 시간 선생님 수십 명에게 보내므로 한도를 넉넉하게 잡습니다.
const SEND_WINDOW_MS = 10 * 60 * 1000
const SEND_MAX = 200
const SENDERS_MAX = 5000
const sendCounts = new Map<string, { n: number; t: number }>()

function overSendLimit(uid: string): boolean {
  const now = Date.now()
  const a = sendCounts.get(uid)
  if (a && now - a.t <= SEND_WINDOW_MS) {
    if (a.n >= SEND_MAX) return true
    a.n += 1
    return false
  }
  // 새 창은 delete 후 set → Map 삽입 순서 = 창 시작 순서
  sendCounts.delete(uid)
  sendCounts.set(uid, { n: 1, t: now })
  // 앞(오래된 쪽)부터 만료된 항목과 상한을 넘는 항목을 지움
  while (sendCounts.size > 0) {
    const first = sendCounts.keys().next()
    if (first.done) break
    const entry = sendCounts.get(first.value)
    if (sendCounts.size <= SENDERS_MAX && entry && now - entry.t <= SEND_WINDOW_MS) break
    sendCounts.delete(first.value)
  }
  return false
}

// POST /api/notify
// Body: { toUid, title, body, url? }
// Header: Authorization: Bearer <Firebase ID token>
// 호출 측은 try/catch 안에서 fire-and-forget으로 사용합니다.
// 서버 푸시가 미설정이면 202 { sent:false } 를 돌려줍니다(에러 아님).
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '허용되지 않는 요청입니다.' })
  }

  if (!isAdminConfigured()) {
    return res.status(202).json({ sent: false, reason: 'push-not-configured' })
  }

  const authHeader = req.headers.authorization || ''
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  const decoded = await verifyIdToken(idToken)
  if (!decoded) {
    return res.status(401).json({ error: '인증에 실패했어요.' })
  }
  if (overSendLimit(decoded.uid)) {
    return res.status(429).json({ error: '알림을 너무 많이 보냈어요. 잠시 후 다시 시도해 주세요.' })
  }

  const { toUid, title, body, url } = (req.body ?? {}) as {
    toUid?: unknown
    title?: unknown
    body?: unknown
    url?: unknown
  }

  if (
    typeof toUid !== 'string' ||
    toUid.length === 0 ||
    typeof title !== 'string' ||
    title.length === 0 ||
    typeof body !== 'string'
  ) {
    return res.status(400).json({ error: '요청 형식이 올바르지 않아요.' })
  }

  // 발신자 검증: 같은 학교의 교사만 푸시를 보낼 수 있음
  // (익명 계정·타학교 사용자의 푸시 스팸 차단)
  // 수신 대상: 교사면 같은 학교면 허용(교환·SOS), 학생이면 발신 교사가 그 학생의
  // 본반·추가 반·반 이동 신청 반 중 하나의 담임일 때만 허용
  try {
    const app = getAdminApp()
    if (!app) return res.status(503).json({ error: '서버 초기화에 실패했어요.' })
    const db = getFirestore(app)
    const [senderSnap, targetSnap] = await Promise.all([
      db.collection('users').doc(decoded.uid).get(),
      db.collection('users').doc(toUid).get(),
    ])
    const sender = senderSnap.exists ? senderSnap.data() || {} : {}
    const target = targetSnap.exists ? targetSnap.data() || {} : {}
    const sameSchool =
      sender.schoolCode && target.schoolCode && sender.schoolCode === target.schoolCode
    if (sender.role !== 'teacher' || !sameSchool) {
      return res.status(403).json({ error: '알림을 보낼 권한이 없어요.' })
    }
    if (target.role === 'student') {
      const classIds = new Set<string>()
      const extras: unknown[] = Array.isArray(target.extraClassIds) ? target.extraClassIds : []
      for (const id of [target.classId, target.pendingClassId, ...extras]) {
        if (typeof id === 'string' && CLASS_ID_RE.test(id)) classIds.add(id)
      }
      const ids = Array.from(classIds).slice(0, MAX_CLASS_LOOKUPS)
      let isTheirTeacher = false
      for (let k = 0; k < ids.length && !isTheirTeacher; k += LOOKUP_CHUNK) {
        const refs = ids.slice(k, k + LOOKUP_CHUNK).map((id) => db.collection('classes').doc(id))
        const snaps = await db.getAll(...refs)
        isTheirTeacher = snaps.some((snap) => snap.exists && snap.get('teacherId') === decoded.uid)
      }
      if (!isTheirTeacher) {
        return res.status(403).json({ error: '알림을 보낼 권한이 없어요.' })
      }
    } else if (target.role !== 'teacher') {
      return res.status(403).json({ error: '알림을 보낼 권한이 없어요.' })
    }
  } catch (e) {
    console.error('notify: sender check error:', e)
    return res.status(500).json({ error: '알림 전송에 실패했어요.' })
  }

  // url은 같은 출처의 앱 경로만 남깁니다(외부 피싱 링크면 버리고 기본 화면으로).
  const result = await sendPushToUser(toUid, {
    title: title.slice(0, TITLE_MAX),
    body: body.slice(0, BODY_MAX),
    url: toSafePushPath(url),
  })

  return res.status(200).json({
    sent: result.sent,
    successCount: result.successCount,
    ...(result.reason ? { reason: result.reason } : {}),
  })
}
