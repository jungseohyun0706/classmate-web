// 회원 탈퇴 처리 (서버 전용 — /api/account/delete에서만 import)
// 무엇을 지우고 무엇을 남기는지는 docs/account-deletion.md에 정리했습니다.
// 순서: 첨부 파일 → 내가 쓴 글·기록 → 함께 쓰는 기록 정리 → 내 사용자 문서 → 로그인 계정.
// 로그인 계정을 맨 마지막에 지우므로, 중간에 실패해도 다시 로그인해 같은 요청을 보내면 남은 것을 이어서 지웁니다.

import type { App } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import {
  FieldValue,
  getFirestore,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type QueryDocumentSnapshot,
  type UpdateData,
} from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import {
  DELETED_TEACHER_NAME,
  RELEASED_TEACHER_NAME,
  anonymizeRequestPatch,
  filesUnder,
  isSafeDocId,
  legacyNoticeFilePath,
} from './accountDeletion'

export interface AccountDeleteSummary {
  chatMessages: number
  notices: number
  comments: number
  receipts: number
  mealVotes: number
  files: number
  classesReleased: number
  recordsAnonymized: number
}

// 컬렉션 그룹 색인이 없을 때 Firestore가 돌려주는 오류 코드 (FAILED_PRECONDITION)
const FAILED_PRECONDITION = 9

/** 동시에 너무 많은 요청을 보내지 않도록 size개씩 나눠 실행합니다. */
async function inChunks<T, R>(items: readonly T[], fn: (item: T) => Promise<R>, size = 10): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  }
  return out
}

/** 있는 문서만 돌려줍니다. (getAll은 빈 목록을 받지 않아 나눠 부릅니다) */
async function existing(db: Firestore, refs: DocumentReference[]): Promise<DocumentSnapshot[]> {
  const out: DocumentSnapshot[] = []
  for (let i = 0; i < refs.length; i += 300) {
    out.push(...(await db.getAll(...refs.slice(i, i + 300))))
  }
  return out.filter((s) => s.exists)
}

/** 경로가 classes/{반}/{collections[0]}/{id}/{collections[1]}/{id}… 모양인지 */
function inClass(ref: DocumentReference, ...collections: string[]): boolean {
  const seg = ref.path.split('/')
  return (
    seg.length === 2 + collections.length * 2 &&
    seg[0] === 'classes' &&
    collections.every((name, i) => seg[2 + i * 2] === name)
  )
}

/**
 * 컬렉션 그룹에서 authorId가 uid인 문서를 한 번에 찾습니다.
 * 그 그룹의 authorId 색인(컬렉션 그룹 범위)이 없으면 null — 호출한 쪽이 반마다 찾습니다.
 */
async function authoredByGroup(db: Firestore, group: string, uid: string): Promise<QueryDocumentSnapshot[] | null> {
  try {
    return (await db.collectionGroup(group).where('authorId', '==', uid).get()).docs
  } catch (e) {
    if ((e as { code?: unknown }).code !== FAILED_PRECONDITION) throw e
    console.warn(`account-delete: ${group}.authorId 컬렉션 그룹 색인이 없어 반마다 찾습니다.`)
    return null
  }
}

/** classes/{반}/{chat|announcements} 에서 내가 쓴 문서 */
async function findAuthored(
  db: Firestore,
  group: 'chat' | 'announcements',
  uid: string,
  classIds: string[]
): Promise<QueryDocumentSnapshot[]> {
  const all = await authoredByGroup(db, group, uid)
  if (all) return all.filter((d) => inClass(d.ref, group))
  const snaps = await inChunks(classIds, (id) =>
    db.collection(`classes/${id}/${group}`).where('authorId', '==', uid).get()
  )
  return snaps.flatMap((s) => s.docs)
}

/** 반들의 알림장 문서 참조 (내용은 읽지 않음) */
async function noticeRefs(db: Firestore, classIds: string[]): Promise<DocumentReference[]> {
  const snaps = await inChunks(classIds, (id) => db.collection(`classes/${id}/announcements`).select().get())
  return snaps.flatMap((s) => s.docs.map((d) => d.ref))
}

/** 내가 단 알림장 댓글. 색인이 없으면 내가 속하거나 맡은 반에서만 찾습니다. */
async function findComments(db: Firestore, uid: string, classIds: string[]): Promise<QueryDocumentSnapshot[]> {
  const all = await authoredByGroup(db, 'comments', uid)
  if (all) return all.filter((d) => inClass(d.ref, 'announcements', 'comments'))
  const notices = await noticeRefs(db, classIds)
  const snaps = await inChunks(notices, (ref) => ref.collection('comments').where('authorId', '==', uid).get())
  return snaps.flatMap((s) => s.docs)
}

type RequestKind = 'swap' | 'sos'

/** 우리 학교 수업 교환·보결 요청 중 내가 보냈거나·받았거나·맡은 것 */
async function findRequests(
  db: Firestore,
  schoolCode: string,
  uid: string
): Promise<Array<{ kind: RequestKind; doc: QueryDocumentSnapshot }>> {
  const targets: Array<[RequestKind, string, string[]]> = [
    ['swap', `school_swaps/${schoolCode}/direct_requests`, ['requesterId', 'fromId', 'toId', 'accepterId', 'declinerId']],
    ['swap', `school_swaps/${schoolCode}/requests`, ['requesterId', 'accepterId']],
    ['sos', `school_sos/${schoolCode}/requests`, ['requesterId', 'assignedTo']],
  ]
  const found = new Map<string, { kind: RequestKind; doc: QueryDocumentSnapshot }>()
  for (const [kind, path, fields] of targets) {
    const snaps = await Promise.all(fields.map((f) => db.collection(path).where(f, '==', uid).get()))
    for (const s of snaps) for (const doc of s.docs) found.set(doc.ref.path, { kind, doc })
  }
  return Array.from(found.values())
}

/**
 * uid 계정과 그 사람이 남긴 데이터를 지웁니다. 이미 지운 것은 건너뛰므로 여러 번 불러도 됩니다.
 * 실패하면 throw — 로그인 계정은 맨 마지막에 지우므로 다시 시도할 수 있습니다.
 */
export async function deleteAccount(app: App, uid: string): Promise<AccountDeleteSummary> {
  const db = getFirestore(app)
  const userRef = db.doc(`users/${uid}`)
  const user = (await userRef.get()).data() || {}
  const role = user.role
  const schoolCode = isSafeDocId(user.schoolCode) ? user.schoolCode : null

  // 내가 속했거나 맡은 반 + 같은 학교 반들 (교사는 학교의 어느 반 톡방·알림장에도 쓸 수 있고,
  // 학생은 반을 옮기기 전 반에 글·읽음 기록을 남겼을 수 있어서).
  // 학생은 수업 반(그룹)에 지금 참여 중인 것(extraClassIds)만 들어갈 수 있어, 학교의 그룹 전체는 훑지 않습니다
  // — 선생님마다 그룹이 여럿이라 큰 학교에서 시간 제한을 넘기지 않게.
  const ownedClasses = (await db.collection('classes').where('teacherId', '==', uid).get()).docs
  const listed: unknown[] = [
    user.classId,
    user.pendingClassId,
    ...(Array.isArray(user.extraClassIds) ? user.extraClassIds : []),
    ...(Array.isArray(user.teachingClassIds) ? user.teachingClassIds : []),
    ...ownedClasses.map((d) => d.id),
  ]
  const myClassIds = Array.from(new Set(listed.filter(isSafeDocId)))
  const schoolClasses = schoolCode
    ? (await db.collection('classes').where('schoolCode', '==', schoolCode).select('isGroup').get()).docs
    : []
  const scanClassIds = Array.from(
    new Set([
      ...myClassIds,
      ...schoolClasses.filter((d) => role === 'teacher' || d.get('isGroup') !== true).map((d) => d.id).filter(isSafeDocId),
    ])
  )

  // ── 찾기 ──────────────────────────────────────────────
  const chat = await findAuthored(db, 'chat', uid, scanClassIds)
  // 알림장은 선생님만 쓸 수 있어요(학생 계정은 건너뜀).
  const notices = role === 'teacher' ? await findAuthored(db, 'announcements', uid, scanClassIds) : []
  const comments = await findComments(db, uid, myClassIds)
  // 읽음·동의 기록(receipts/{uid})은 학생만 남깁니다. 문서 ID가 uid라 필드로 찾을 수 없어 알림장마다 확인합니다.
  const receipts =
    role === 'student'
      ? await existing(db, (await noticeRefs(db, scanClassIds)).map((ref) => ref.collection('receipts').doc(uid)))
      : []
  const mealVotes = schoolCode
    ? await existing(
        db,
        (await db.collection('meal_ratings').where('schoolCode', '==', schoolCode).select().get()).docs.map((d) =>
          d.ref.collection('votes').doc(uid)
        )
      )
    : []
  const uploads = (await db.collection('chat_uploads').where('uid', '==', uid).get()).docs
  const requests = schoolCode ? await findRequests(db, schoolCode, uid) : []
  const slots = schoolCode
    ? (await db.collection(`school_swaps/${schoolCode}/slots`).where('uid', '==', uid).get()).docs
    : []
  const timetables = (await db.collection('school_timetables').where('uploadedBy', '==', uid).get()).docs

  // ── 첨부 파일 (문서보다 먼저 — 다시 시도할 때 문서에서 경로를 다시 찾을 수 있게) ──
  const chatBucket = process.env.CHAT_STORAGE_BUCKET || `${process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID}-chat`
  const defaultBucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
  const files: Array<{ bucket: string; path: string }> = []
  for (const d of [...chat, ...notices]) {
    const classId = d.ref.path.split('/')[1]
    for (const path of filesUnder(`chat-files/${classId}/${d.id}/`, d.get('attachments'))) {
      files.push({ bucket: chatBucket, path })
    }
  }
  for (const d of notices) {
    const path = legacyNoticeFilePath(d.get('attachmentUrl'), defaultBucket)
    if (path && defaultBucket) files.push({ bucket: defaultBucket, path })
  }
  for (const d of uploads) {
    const classId = d.get('classId')
    if (!isSafeDocId(classId)) continue
    for (const path of filesUnder(`chat-staging/${classId}/${d.id}/`, d.get('attachments'))) {
      files.push({ bucket: chatBucket, path })
    }
  }
  if (files.length > 0) {
    const storage = getStorage(app)
    await inChunks(files, (f) => storage.bucket(f.bucket).file(f.path).delete({ ignoreNotFound: true }))
  }

  // ── 문서 지우기·고치기 ────────────────────────────────
  const writer = db.bulkWriter()
  let failure: unknown = null
  const pending: Promise<unknown>[] = []
  // 실패를 바로 잡아 두어야 처리되지 않은 rejection으로 함수가 죽지 않습니다.
  const track = (p: Promise<unknown>): void => {
    pending.push(p.catch((e) => {
      failure = failure ?? e
    }))
  }
  for (const d of [...chat, ...comments, ...receipts, ...mealVotes, ...uploads, ...slots]) track(writer.delete(d.ref))
  track(writer.delete(db.doc(`chat_upload_limits/${uid}`)))

  // 맡던 반은 지우지 않고 담임 자리만 비웁니다 (학생들이 계속 쓰고, 같은 학교 선생님이 넘겨받을 수 있게).
  for (const d of ownedClasses) track(writer.update(d.ref, { teacherId: null, teacherName: RELEASED_TEACHER_NAME }))

  let recordsAnonymized = 0
  for (const { kind, doc } of requests) {
    const patch = anonymizeRequestPatch(kind, doc.data(), uid)
    if (!patch) continue
    const data: UpdateData<Record<string, unknown>> = { ...patch.set }
    for (const field of patch.now) data[field] = FieldValue.serverTimestamp()
    track(writer.update(doc.ref, data))
    recordsAnonymized++
  }
  // 학교 시간표는 같은 학교 선생님들이 쓰므로 남기고, 올린 사람만 지웁니다.
  for (const d of timetables) {
    track(writer.update(d.ref, { uploadedBy: FieldValue.delete(), uploadedByName: DELETED_TEACHER_NAME }))
    recordsAnonymized++
  }
  await writer.close()
  await Promise.all(pending)
  if (failure) throw failure

  // 내가 쓴 알림장은 거기 달린 댓글·읽음 기록까지 함께 지웁니다.
  await inChunks(notices, (d) => db.recursiveDelete(d.ref), 5)

  // 내 사용자 문서와 알림함(notifications)·가방 체크(bagChecks)
  await db.recursiveDelete(userRef)

  try {
    await getAuth(app).deleteUser(uid)
  } catch (e) {
    if ((e as { code?: unknown }).code !== 'auth/user-not-found') throw e
  }

  return {
    chatMessages: chat.length,
    notices: notices.length,
    comments: comments.length,
    receipts: receipts.length,
    mealVotes: mealVotes.length,
    files: files.length,
    classesReleased: ownedClasses.length,
    recordsAnonymized,
  }
}
