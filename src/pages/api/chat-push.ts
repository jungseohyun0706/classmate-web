import type { NextApiRequest, NextApiResponse } from 'next'
import { getFirestore } from 'firebase-admin/firestore'
import { getAdminApp, isAdminConfigured, sendPushToUser, verifyIdToken } from '../../lib/fcm-admin'

// POST /api/chat-push
// Header: Authorization: Bearer <Firebase ID token>
// Body: { classId, kind: 'chat'|'notice', docId }
// 이야기방에 새 메시지/공지가 올라오면 반 구성원 전체(보낸 사람 제외)에게
// FCM 푸시를 fan-out 합니다.
//
// 클라이언트가 보낸 문구를 그대로 믿으면 학생이 '📢 공지' 푸시를 위조하거나
// 저장하지도 않은 문구로 반 전체에 반복 발송할 수 있었습니다. 그래서
// - 저장된 문서(docId)를 서버가 직접 읽어 작성자가 요청자 본인이고 방금 쓴 것인지 확인하고,
// - 푸시 본문은 저장된 내용으로 만들며,
// - 같은 문서로는 한 번만 보냅니다(pushedAt).

const MAX_TARGETS = 100
const MAX_AGE_MS = 2 * 60 * 1000

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

  const { classId, kind, docId } = (req.body ?? {}) as Record<string, unknown>
  if (
    typeof classId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(classId) ||
    (kind !== 'chat' && kind !== 'notice') ||
    typeof docId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(docId)
  ) {
    return res.status(400).json({ error: '요청 형식이 올바르지 않아요.' })
  }
  const isNotice = kind === 'notice'

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
    const isSchoolTeacher =
      sender.role === 'teacher' && String(sender.schoolCode || '') === String(cls.schoolCode || '')
    const isClassStudent =
      sender.role === 'student' &&
      sender.status === 'approved' &&
      (sender.classId === classId ||
        (Array.isArray(sender.extraClassIds) && sender.extraClassIds.includes(classId)))
    if (!isSchoolTeacher && !isClassStudent) {
      return res.status(403).json({ error: '이 반의 구성원만 보낼 수 있어요.' })
    }

    // 공지는 교사만 올릴 수 있습니다(announcements 쓰기 규칙과 같은 기준).
    if (isNotice && !isSchoolTeacher) {
      return res.status(403).json({ error: '공지는 선생님만 보낼 수 있어요.' })
    }

    // 저장된 문서를 확인: 요청자가 방금 쓴 문서여야 하고, 한 번만 보냅니다.
    const docRef = db
      .collection('classes')
      .doc(classId)
      .collection(isNotice ? 'announcements' : 'chat')
      .doc(docId)
    const claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef)
      if (!snap.exists) return { ok: false as const, status: 404, reason: 'not-found' }
      const d = snap.data() || {}
      if (d.authorId !== decoded.uid) return { ok: false as const, status: 403, reason: 'not-author' }
      const created = typeof d.createdAt?.toMillis === 'function' ? d.createdAt.toMillis() : 0
      if (!created || Date.now() - created > MAX_AGE_MS) {
        return { ok: false as const, status: 409, reason: 'stale' }
      }
      if (d.pushedAt) return { ok: false as const, status: 200, reason: 'already-pushed' }
      tx.update(docRef, { pushedAt: new Date() })
      return { ok: true as const, text: String((isNotice ? d.body : d.text) || '') }
    })
    if (!claimed.ok) {
      return res.status(claimed.status).json({ sent: 0, reason: claimed.reason })
    }
    const previewText = claimed.text.replace(/\s+/g, ' ').trim().slice(0, 60)

    const senderName =
      String(sender.name || sender.displayName || (isSchoolTeacher ? '선생님' : '학생')).slice(0, 12)

    // 대상: 담임 + 본반 학생 + 추가 참여 학생 (발신자 제외)
    const [homeSnap, extraSnap] = await Promise.all([
      db
        .collection('users')
        .where('classId', '==', classId)
        .where('role', '==', 'student')
        .where('status', '==', 'approved')
        .get(),
      db
        .collection('users')
        .where('extraClassIds', 'array-contains', classId)
        .where('role', '==', 'student')
        .where('status', '==', 'approved')
        .get(),
    ])
    const targets = new Set<string>()
    if (cls.teacherId) targets.add(String(cls.teacherId))
    homeSnap.forEach((d) => targets.add(d.id))
    extraSnap.forEach((d) => targets.add(d.id))
    targets.delete(decoded.uid)

    const title = `${cls.grade ?? ''}학년 ${cls.classNm ?? ''}반${cls.isGroup === true ? ' 수업' : ''} 톡방`
    const body = isNotice
      ? `📢 공지: ${previewText || '새 공지가 올라왔어요'}`
      : `${senderName}: ${previewText || '새 메시지'}`
    // 추가 참여 반·수업 반 알림을 누르면 그 방이 열리도록 classId를 붙입니다.
    const url = `/class-room?classId=${encodeURIComponent(classId)}`

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
