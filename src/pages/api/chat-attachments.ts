import type { NextApiRequest, NextApiResponse } from 'next'
import { randomUUID } from 'crypto'
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { getAdminApp, verifyIdToken } from '../../lib/fcm-admin'
import { attachmentContentType, canAccessChatFiles, matchesImageSignature, validateChatFiles, type ChatAttachment, type AttachmentInput } from '../../lib/chatAttachments'

export const config = { api: { bodyParser: { sizeLimit: '64kb' } } }
const ID = /^[A-Za-z0-9_-]{1,80}$/
const UPLOAD_TTL = 15 * 60 * 1000
class RequestError extends Error { constructor(public status: number, message: string) { super(message) } }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'private, no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: '허용되지 않는 요청입니다.' })
  const decoded = await verifyIdToken((req.headers.authorization || '').replace(/^Bearer /, ''))
  if (!decoded) return res.status(401).json({ error: '다시 로그인해 주세요.' })
  const app = getAdminApp()
  if (!app) return res.status(503).json({ error: '파일 저장소를 사용할 수 없어요.' })
  const { action, classId, requestId, messageId, kind = 'chat' } = req.body || {}
  if (typeof classId !== 'string' || !ID.test(classId) || !['prepare', 'send', 'links', 'delete'].includes(action)) return res.status(400).json({ error: '요청 형식이 올바르지 않아요.' })
  const db = getFirestore(app)
  const bucketName = process.env.CHAT_STORAGE_BUCKET || `${process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID}-chat`
  const bucket = getStorage(app).bucket(bucketName)
  try {
    const [userSnap, classSnap] = await Promise.all([db.doc(`users/${decoded.uid}`).get(), db.doc(`classes/${classId}`).get()])
    const user = userSnap.data() || {}
    const cls = classSnap.data() || {}
    if (!classSnap.exists || !canAccessChatFiles(user, cls, classId)) throw new RequestError(403, '이 톡방의 구성원만 파일을 주고받을 수 있어요.')

    if (action === 'links' || action === 'delete') {
      if (typeof messageId !== 'string' || !ID.test(messageId) || !['chat', 'notice'].includes(kind)) throw new RequestError(400, '메시지 정보가 올바르지 않아요.')
      const ref = db.doc(`classes/${classId}/${kind === 'notice' ? 'announcements' : 'chat'}/${messageId}`)
      const snap = await ref.get()
      if (!snap.exists) throw new RequestError(404, '삭제된 메시지예요.')
      const message = snap.data() || {}
      const prefix = `chat-files/${classId}/${messageId}/`
      const attachments: ChatAttachment[] = (Array.isArray(message.attachments) ? message.attachments : []).filter((a) => typeof a.path === 'string' && a.path.startsWith(prefix) && !a.path.includes('..'))
      if (action === 'delete') {
        if (message.authorId !== decoded.uid && !(user.role === 'teacher' && cls.teacherId === decoded.uid)) throw new RequestError(403, '메시지를 삭제할 권한이 없어요.')
        // 메시지를 먼저 숨기면 기존 다운로드 링크도 더 이상 새로 발급할 수 없습니다.
        await ref.delete()
        await Promise.all(attachments.map((a) => bucket.file(a.path).delete({ ignoreNotFound: true })))
        return res.status(200).json({ ok: true })
      }
      const links = await Promise.all(attachments.map(async (a) => {
        const file = bucket.file(a.path)
        const [downloadUrl] = await file.getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 10 * 60 * 1000, responseDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}` })
        const [previewUrl] = a.contentType.startsWith('image/')
          ? await file.getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 10 * 60 * 1000, responseType: a.contentType, responseDisposition: 'inline' })
          : ['']
        return { path: a.path, downloadUrl, previewUrl }
      }))
      return res.status(200).json({ links })
    }

    if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(requestId)) throw new RequestError(400, '전송 정보가 올바르지 않아요.')
    const draftRef = db.doc(`chat_uploads/${requestId}`)
    if (action === 'prepare') {
      const files: AttachmentInput[] = Array.isArray(req.body.files) ? req.body.files : []
      if (files.some((f) => !f || typeof f !== 'object')) throw new RequestError(400, '파일 정보가 올바르지 않아요.')
      const error = validateChatFiles(files)
      if (error) throw new RequestError(400, error)
      const attachments = files.map((f) => ({ name: f.name, size: f.size, contentType: attachmentContentType(f.name), path: `chat-staging/${classId}/${requestId}/${randomUUID()}` }))
      const draft = await db.runTransaction(async (tx) => {
        const old = await tx.get(draftRef)
        if (old.exists) {
          const v = old.data()!
          if (v.uid !== decoded.uid || v.classId !== classId || JSON.stringify(v.attachments.map((a: ChatAttachment) => ({ name: a.name, size: a.size }))) !== JSON.stringify(files.map((f) => ({ name: f.name, size: f.size })))) throw new RequestError(409, '첨부 파일이 바뀌었어요. 다시 선택해 주세요.')
          return v
        }
        const rateRef = db.doc(`chat_upload_limits/${decoded.uid}`)
        const rate = (await tx.get(rateRef)).data()
        const recent = rate && Date.now() - rate.startedAt.toMillis() < 10 * 60 * 1000
        if (recent && rate.count >= 30) throw new RequestError(429, '첨부 전송이 많아요. 잠시 후 다시 시도해 주세요.')
        tx.set(rateRef, { startedAt: recent ? rate.startedAt : Timestamp.now(), count: recent ? rate.count + 1 : 1 })
        const v = { uid: decoded.uid, classId, attachments, createdAt: Timestamp.now(), sentKind: null }
        tx.create(draftRef, v)
        return v
      })
      if (draft.sentKind) return res.status(200).json({ sentKind: draft.sentKind, messageId: requestId, uploads: [] })
      if (Date.now() - draft.createdAt.toMillis() > 24 * 60 * 60 * 1000) throw new RequestError(410, '첨부 시간이 만료됐어요. 파일을 다시 선택해 주세요.')
      const uploads = await Promise.all((draft.attachments as ChatAttachment[]).map(async (a) => {
        const [policy] = await bucket.file(a.path).generateSignedPostPolicyV4({ expires: Date.now() + UPLOAD_TTL, fields: { 'Content-Type': a.contentType }, conditions: [['content-length-range', a.size, a.size]] })
        return policy
      }))
      return res.status(200).json({ uploads })
    }

    const draft = (await draftRef.get()).data()
    if (!draft || draft.uid !== decoded.uid || draft.classId !== classId) throw new RequestError(403, '첨부 전송 권한이 없어요.')
    if (draft.sentKind) return res.status(200).json({ messageId: requestId, kind: draft.sentKind })
    if (Date.now() - draft.createdAt.toMillis() > 24 * 60 * 60 * 1000) throw new RequestError(410, '첨부 시간이 만료됐어요. 파일을 다시 선택해 주세요.')
    if (!['chat', 'notice'].includes(kind) || (kind === 'notice' && user.role !== 'teacher')) throw new RequestError(403, '공지는 선생님만 보낼 수 있어요.')
    const text = typeof req.body.text === 'string' ? req.body.text.trim() : ''
    if (text.length > 500) throw new RequestError(400, '메시지는 500자까지 보낼 수 있어요.')
    // 업로드 URL은 임시 경로만 쓸 수 있습니다. 검증한 버전을 별도 경로로 복사해 게시 후 변조를 막습니다.
    const attachments = await Promise.all((draft.attachments as ChatAttachment[]).map(async (a) => {
      const [meta] = await bucket.file(a.path).getMetadata()
      if (Number(meta.size) !== a.size || meta.contentType !== a.contentType) throw new RequestError(400, '업로드가 끝나지 않았어요. 다시 전송해 주세요.')
      const version = bucket.file(a.path, { generation: meta.generation })
      let contentType = a.contentType
      if (contentType.startsWith('image/')) {
        const [head] = await version.download({ start: 0, end: 15 })
        if (!matchesImageSignature(head, contentType)) contentType = 'application/octet-stream'
      }
      return { ...a, contentType, source: version, path: `chat-files/${classId}/${requestId}/${a.path.split('/').pop()}` }
    }))
    for (const a of attachments) {
      try {
        await a.source.copy(bucket.file(a.path), { preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType: a.contentType, cacheControl: 'private, max-age=300', contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}` } })
      } catch (e) {
        if ((e as { code?: number }).code !== 412) throw e // 같은 전송 재시도는 이미 고정한 파일을 사용합니다.
      }
    }
    const resultKind = await db.runTransaction(async (tx) => {
      const current = (await tx.get(draftRef)).data()!
      if (current.sentKind) return current.sentKind as string
      const message = { authorId: decoded.uid, authorName: String(user.name || user.displayName || '이름 없음').slice(0, 50), createdAt: FieldValue.serverTimestamp(), attachments: attachments.map(({ source: _source, ...a }) => a) }
      tx.create(db.doc(`classes/${classId}/${kind === 'notice' ? 'announcements' : 'chat'}/${requestId}`), kind === 'notice'
        ? { ...message, title: (text.split('\n')[0] || attachments[0].name).slice(0, 30), body: text, readCount: 0, checkCount: 0, requiresConsent: false }
        : { ...message, role: user.role === 'teacher' ? 'teacher' : 'student', text })
      tx.update(draftRef, { sentKind: kind, sentAt: FieldValue.serverTimestamp() })
      return kind as string
    })
    return res.status(200).json({ messageId: requestId, kind: resultKind })
  } catch (e) {
    if (e instanceof RequestError) return res.status(e.status).json({ error: e.message })
    console.error('chat-attachments:', e instanceof Error ? e.message : 'failed')
    return res.status(500).json({ error: '첨부 파일을 처리하지 못했어요. 파일을 유지했으니 다시 시도해 주세요.' })
  }
}
