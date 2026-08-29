import type { NextApiRequest, NextApiResponse } from 'next'
import { getFirestore } from 'firebase-admin/firestore'
import { getAdminApp, isAdminConfigured, sendPushToUser, verifyIdToken } from '../../lib/fcm-admin'

// POST /api/chat-push
// Header: Authorization: Bearer <Firebase ID token>
// Body: { classId, kind: 'chat'|'notice', preview }
// 이야기방에 새 메시지/공지가 올라오면 반 구성원 전체(보낸 사람 제외)에게
// FCM 푸시를 fan-out 합니다. 발신자가 해당 반의 구성원인지 서버에서 검증합니다.

const MAX_TARGETS = 100

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '허용되지 않는 요청입니다.' })
  }
  if (!isAdminConfigured()) {
    return res.status(202).json({ sent: 0, reason: 'push-not-configured' })
  }

  const authHeader = req.headers.authorization || ''
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  const decoded = await verifyIdToken(idToken)
  if (!decoded) {
    return res.status(401).json({ error: '인증에 실패했어요.' })
  }

  const { classId, kind, preview } = (req.body ?? {}) as Record<string, unknown>
  if (typeof classId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(classId)) {
    return res.status(400).json({ error: '요청 형식이 올바르지 않아요.' })
  }
  const isNotice = kind === 'notice'
  const previewText =
    typeof preview === 'string' ? preview.replace(/\s+/g, ' ').trim().slice(0, 60) : ''

  try {
    const app = getAdminApp()
    if (!app) return res.status(202).json({ sent: 0, reason: 'no-admin' })
    const db = getFirestore(app)

    // 발신자 검증: 이 반의 담임 또는 승인된 학생이어야 함
    const [senderSnap, classSnap] = await Promise.all([
      db.collection('users').doc(decoded.uid).get(),
      db.collection('classes').doc(classId).get(),
    ])
    if (!classSnap.exists) return res.status(404).json({ error: '학급을 찾을 수 없어요.' })
    const sender = senderSnap.exists ? senderSnap.data() || {} : {}
    const cls = classSnap.data() || {}
    const isClassTeacher = String(cls.teacherId || '') === decoded.uid
    const isClassStudent =
      sender.role === 'student' && sender.status === 'approved' && sender.classId === classId
    if (!isClassTeacher && !isClassStudent) {
      return res.status(403).json({ error: '이 반의 구성원만 보낼 수 있어요.' })
    }

    const senderName =
      String(sender.name || sender.displayName || (isClassTeacher ? '선생님' : '학생')).slice(0, 12)

    // 대상: 담임 + 승인된 학생 (발신자 제외)
    const studentsSnap = await db
      .collection('users')
      .where('classId', '==', classId)
      .where('role', '==', 'student')
      .where('status', '==', 'approved')
      .get()
    const targets = new Set<string>()
    if (cls.teacherId) targets.add(String(cls.teacherId))
    studentsSnap.forEach((d) => targets.add(d.id))
    targets.delete(decoded.uid)

    const title = `${cls.grade ?? ''}학년 ${cls.classNm ?? ''}반 이야기방`
    const body = isNotice
      ? `📢 공지: ${previewText || '새 공지가 올라왔어요'}`
      : `${senderName}: ${previewText || '새 메시지'}`
    const url = '/class-room'

    const uids = Array.from(targets).slice(0, MAX_TARGETS)
    const results = await Promise.allSettled(
      uids.map((uid) => sendPushToUser(uid, { title, body, url }))
    )
    const sent = results.filter(
      (r) => r.status === 'fulfilled' && r.value.sent
    ).length

    return res.status(200).json({ sent, targets: uids.length })
  } catch (e) {
    console.error('chat-push error:', e)
    return res.status(200).json({ sent: 0, reason: 'error' })
  }
}
