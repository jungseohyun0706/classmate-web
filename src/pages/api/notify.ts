import type { NextApiRequest, NextApiResponse } from 'next'
import { getFirestore } from 'firebase-admin/firestore'
import { getAdminApp, isAdminConfigured, sendPushToUser, verifyIdToken } from '../../lib/fcm-admin'

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

  // 발신자 검증: 같은 학교의 교사만 임의 사용자에게 푸시를 보낼 수 있음
  // (익명 계정·타학교 사용자의 푸시 스팸 차단)
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
  } catch (e) {
    console.error('notify: sender check error:', e)
    return res.status(500).json({ error: '알림 전송에 실패했어요.' })
  }

  const result = await sendPushToUser(toUid, {
    title,
    body,
    url: typeof url === 'string' && url.length > 0 ? url : undefined,
  })

  return res.status(200).json({
    sent: result.sent,
    successCount: result.successCount,
    ...(result.reason ? { reason: result.reason } : {}),
  })
}
