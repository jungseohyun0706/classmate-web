import type { NextApiRequest, NextApiResponse } from 'next'
import { createHash } from 'node:crypto'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { canAccessChatFiles } from '../../lib/chatAttachments'
import { getAdminApp, verifyIdToken } from '../../lib/fcm-admin'

const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,150}$/.test(value)

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'private, no-store')
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: '지원하지 않는 요청이에요.' })
  const user = await verifyIdToken((req.headers.authorization || '').replace(/^Bearer /, ''))
  if (!user) return res.status(401).json({ error: '로그인이 필요해요.' })
  const app = getAdminApp()
  if (!app) return res.status(503).json({ error: '잠시 후 다시 시도해 주세요.' })
  const db = getFirestore(app)
  const userRef = db.collection('users').doc(user.uid)
  const blocks = userRef.collection('blocked_chat')
  try {
    if (req.method === 'GET' && req.query.classId === undefined) {
      const snapshot = await blocks.get()
      return res.status(200).json({ blocked: snapshot.docs.map((entry) => ({ id: entry.id, name: String(entry.get('name') || '사용자') })) })
    }
    const body = req.method === 'GET' ? req.query : req.body || {}
    const { action, classId, messageId, kind, targetId, reportId } = body
    if (req.method === 'POST' && action === 'unblock' && validId(targetId)) {
      await blocks.doc(targetId).delete()
      return res.status(200).json({ ok: true })
    }
    if (!validId(classId)) return res.status(400).json({ error: '학급 정보가 올바르지 않아요.' })
    const clsRef = db.collection('classes').doc(classId)
    const [profile, room] = await Promise.all([userRef.get(), clsRef.get()])
    const cls = room.data()
    if (!cls || !canAccessChatFiles(profile.data() ?? {}, cls, classId)) {
      return res.status(403).json({ error: '이 학급의 구성원만 이용할 수 있어요.' })
    }
    const reports = clsRef.collection('chat_reports')
    const isTeacher = profile.get('role') === 'teacher' && cls.teacherId === user.uid

    if (req.method === 'GET') {
      if (!isTeacher) return res.status(403).json({ error: '담임 선생님만 신고를 확인할 수 있어요.' })
      const snapshot = await reports.orderBy('createdAt', 'desc').limit(60).get()
      return res.status(200).json({
        reports: snapshot.docs.filter((entry) => !entry.get('handledAt')).map((entry) => ({
          id: entry.id,
          messageId: entry.get('messageId'),
          kind: entry.get('kind'),
          name: entry.get('name'),
          excerpt: entry.get('excerpt'),
        })),
      })
    }
    if (action === 'resolve' && validId(reportId)) {
      if (!isTeacher) return res.status(403).json({ error: '담임 선생님만 신고를 확인할 수 있어요.' })
      await reports.doc(reportId).update({ handledAt: FieldValue.serverTimestamp() })
      return res.status(200).json({ ok: true })
    }
    if (!validId(messageId) || (kind !== 'notice' && kind !== 'chat') || !['report', 'block'].includes(action)) {
      return res.status(400).json({ error: '메시지 정보가 올바르지 않아요.' })
    }
    const message = await clsRef.collection(kind === 'notice' ? 'announcements' : 'chat').doc(messageId).get()
    const author = message.get('authorId')
    if (!message.exists || !validId(author) || author === user.uid) {
      return res.status(404).json({ error: '이 메시지를 처리할 수 없어요.' })
    }
    const name = String(message.get('authorName') || '사용자').slice(0, 60)
    if (action === 'block') {
      await blocks.doc(author).set({ name })
      return res.status(200).json({ ok: true, author: { id: author, name } })
    }

    const report = reports.doc(createHash('sha256').update(`${user.uid}:${kind}:${messageId}`).digest('hex'))
    const excerpt = String(message.get(kind === 'notice' ? 'body' : 'text') || '첨부 메시지').slice(0, 500)
    const rate = userRef.collection('moderation').doc('report-rate')
    const saved = await db.runTransaction(async (transaction) => {
      const [existing, recent] = await Promise.all([transaction.get(report), transaction.get(rate)])
      if (existing.exists) return true
      const hour = Math.floor(Date.now() / 3600000)
      const count = recent.get('hour') === hour ? Number(recent.get('count')) || 0 : 0
      if (count >= 12) return false
      transaction.create(report, { kind, messageId, name, excerpt, createdAt: FieldValue.serverTimestamp() })
      transaction.set(rate, { hour, count: count + 1 })
      if (validId(cls.teacherId) && cls.teacherId !== author) {
        transaction.create(db.collection('users').doc(cls.teacherId).collection('notifications').doc(), {
          title: '학급톡방 신고',
          body: '학급톡방에 신고된 메시지가 있어요. 신고 목록에서 확인해 주세요.',
          url: `/class-room?classId=${classId}&reports=1`,
          createdAt: FieldValue.serverTimestamp(),
          read: false,
        })
      }
      return true
    })
    return saved ? res.status(200).json({ ok: true }) : res.status(429).json({ error: '신고 요청이 많아요. 잠시 후 다시 시도해 주세요.' })
  } catch (error) {
    console.error('chat-safety:', error)
    return res.status(500).json({ error: '처리하지 못했어요. 잠시 후 다시 시도해 주세요.' })
  }
}
