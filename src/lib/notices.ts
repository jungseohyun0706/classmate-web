import {
  Timestamp,
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Unsubscribe,
} from 'firebase/firestore'
import { db } from './firebase'

/**
 * 알림장(announcements) 조회 + 읽음 확인(receipts) 유틸.
 * 모든 함수는 클라이언트(useEffect/핸들러)에서만 호출해야 합니다.
 *
 * 데이터 계약:
 * - classes/{classId}/announcements/{aid}
 *   {title, body, authorId, authorName, attachmentUrl?, attachmentName?, createdAt, readCount, requiresConsent?}
 * - classes/{classId}/announcements/{aid}/receipts/{studentUid}
 *   {readAt, studentName, consent?: 'agreed'|'declined', consentAt?}
 */

export type ConsentValue = 'agreed' | 'declined'

export interface Announcement {
  id: string
  title: string
  body: string
  authorId: string
  authorName: string
  attachmentUrl: string | null
  attachmentName: string | null
  createdAt: Timestamp | null
  readCount: number
  checkCount: number
  requiresConsent: boolean
}

export interface Receipt {
  readAt: Timestamp | null
  studentName: string
  consent?: ConsentValue
  consentAt?: Timestamp | null
}

function toAnnouncement(id: string, data: Record<string, unknown>): Announcement {
  return {
    id,
    title: String(data.title ?? ''),
    body: String(data.body ?? ''),
    authorId: String(data.authorId ?? ''),
    authorName: String(data.authorName ?? ''),
    attachmentUrl: typeof data.attachmentUrl === 'string' && data.attachmentUrl ? data.attachmentUrl : null,
    attachmentName:
      typeof data.attachmentName === 'string' && data.attachmentName ? data.attachmentName : null,
    createdAt: data.createdAt instanceof Timestamp ? data.createdAt : null,
    readCount: typeof data.readCount === 'number' ? data.readCount : 0,
    checkCount: typeof data.checkCount === 'number' ? data.checkCount : 0,
    requiresConsent: data.requiresConsent === true,
  }
}

function toReceipt(data: Record<string, unknown>): Receipt {
  const consent = data.consent === 'agreed' || data.consent === 'declined' ? data.consent : undefined
  return {
    readAt: data.readAt instanceof Timestamp ? data.readAt : null,
    studentName: String(data.studentName ?? ''),
    ...(consent ? { consent } : {}),
    consentAt: data.consentAt instanceof Timestamp ? data.consentAt : null,
  }
}

/** 학급 알림장을 최신순으로 가져옵니다. */
export async function listAnnouncements(classId: string, max: number = 30): Promise<Announcement[]> {
  const snap = await getDocs(
    query(
      collection(db, 'classes', classId, 'announcements'),
      orderBy('createdAt', 'desc'),
      limit(max)
    )
  )
  return snap.docs.map((d) => toAnnouncement(d.id, d.data() as Record<string, unknown>))
}

/** 알림장 실시간 구독 (최신 max개, 시간 오름차순으로 콜백) */
export function watchAnnouncements(
  classId: string,
  onChange: (list: Announcement[]) => void,
  onError?: (e: unknown) => void,
  max: number = 20
): Unsubscribe {
  const q = query(
    collection(db, 'classes', classId, 'announcements'),
    orderBy('createdAt', 'desc'),
    limit(max)
  )
  return onSnapshot(
    q,
    (snap) => {
      const list = snap.docs.map((d) =>
        toAnnouncement(d.id, d.data({ serverTimestamps: 'estimate' }) as Record<string, unknown>)
      )
      list.reverse()
      onChange(list)
    },
    (e) => onError?.(e)
  )
}

/** 알림장 한 건을 가져옵니다. 없으면 null. */
export async function getAnnouncement(classId: string, aid: string): Promise<Announcement | null> {
  const snap = await getDoc(doc(db, 'classes', classId, 'announcements', aid))
  if (!snap.exists()) return null
  return toAnnouncement(snap.id, snap.data() as Record<string, unknown>)
}

/** 내 읽음 확인(receipt) 문서를 가져옵니다. 없으면 null. */
export async function getReceipt(
  classId: string,
  aid: string,
  uid: string
): Promise<Receipt | null> {
  const snap = await getDoc(doc(db, 'classes', classId, 'announcements', aid, 'receipts', uid))
  if (!snap.exists()) return null
  return toReceipt(snap.data() as Record<string, unknown>)
}

/**
 * 여러 알림장에 대한 내 읽음 확인을 한 번에 가져옵니다.
 * 반환 맵에 없는 aid는 아직 읽지 않은(receipt 없는) 알림장입니다.
 * 개별 조회 실패(권한 등)는 조용히 건너뜁니다.
 */
export async function getMyReceipts(
  classId: string,
  aids: string[],
  uid: string
): Promise<Record<string, Receipt>> {
  const entries = await Promise.all(
    aids.map(async (aid): Promise<readonly [string, Receipt | null]> => {
      try {
        return [aid, await getReceipt(classId, aid, uid)] as const
      } catch {
        return [aid, null] as const
      }
    })
  )
  const out: Record<string, Receipt> = {}
  for (const [aid, receipt] of entries) {
    if (receipt) out[aid] = receipt
  }
  return out
}

/**
 * 알림장을 읽음 처리합니다. receipt가 이미 있으면 아무것도 하지 않습니다.
 * readCount 증가는 규칙상 학생에게 거부될 수 있으므로 실패해도 무시합니다
 * (receipts 하위 컬렉션이 읽음 여부의 원본입니다).
 */
export async function markRead(
  classId: string,
  aid: string,
  uid: string,
  studentName: string
): Promise<void> {
  const receiptRef = doc(db, 'classes', classId, 'announcements', aid, 'receipts', uid)
  const existing = await getDoc(receiptRef)
  if (existing.exists()) return

  await setDoc(receiptRef, { readAt: serverTimestamp(), studentName }, { merge: true })

  try {
    await updateDoc(doc(db, 'classes', classId, 'announcements', aid), {
      readCount: increment(1),
    })
  } catch {
    // 학생 권한으로 readCount 쓰기가 거부될 수 있음 — receipts가 원본이므로 무시
  }
}

/**
 * 공지 확인 체크. receipt에 확인 표시(consent:'agreed' 재사용)를 남기고
 * 공지의 checkCount를 +1 합니다(규칙상 실패해도 receipt가 원본이므로 무시).
 */
export async function checkNotice(
  classId: string,
  aid: string,
  uid: string,
  studentName: string
): Promise<void> {
  const receiptRef = doc(db, 'classes', classId, 'announcements', aid, 'receipts', uid)
  await setDoc(
    receiptRef,
    { studentName, consent: 'agreed', consentAt: serverTimestamp() },
    { merge: true }
  )
  try {
    await updateDoc(doc(db, 'classes', classId, 'announcements', aid), {
      checkCount: increment(1),
    })
  } catch {
    // 구버전 문서 등에서 실패 가능 — receipts가 원본이므로 무시
  }
}

/** 동의/미동의 응답을 저장합니다. 나중에 다시 바꿀 수 있습니다. */
export async function setConsent(
  classId: string,
  aid: string,
  uid: string,
  studentName: string,
  consent: ConsentValue
): Promise<void> {
  const receiptRef = doc(db, 'classes', classId, 'announcements', aid, 'receipts', uid)
  await setDoc(
    receiptRef,
    { studentName, consent, consentAt: serverTimestamp() },
    { merge: true }
  )
}

// ── 댓글(의견 나누기) ───────────────────────────────────────
// classes/{classId}/announcements/{aid}/comments/{cid}
//   {authorId, authorName, role: 'teacher'|'student', text, createdAt}

export interface NoticeComment {
  id: string
  authorId: string
  authorName: string
  role: 'teacher' | 'student'
  text: string
  createdAt: Timestamp | null
}

export const COMMENT_MAX_LEN = 500

function toComment(id: string, data: Record<string, unknown>): NoticeComment {
  return {
    id,
    authorId: String(data.authorId ?? ''),
    authorName: String(data.authorName ?? ''),
    role: data.role === 'teacher' ? 'teacher' : 'student',
    text: String(data.text ?? ''),
    createdAt: data.createdAt instanceof Timestamp ? data.createdAt : null,
  }
}

/** 댓글 실시간 구독 (작성순). 권한 없음 등 오류는 onError로 전달. */
export function watchComments(
  classId: string,
  aid: string,
  onChange: (comments: NoticeComment[]) => void,
  onError?: (e: unknown) => void
): Unsubscribe {
  const q = query(
    collection(db, 'classes', classId, 'announcements', aid, 'comments'),
    orderBy('createdAt', 'asc'),
    limit(200)
  )
  return onSnapshot(
    q,
    (snap) =>
      onChange(
        snap.docs.map((d) =>
          toComment(d.id, d.data({ serverTimestamps: 'estimate' }) as Record<string, unknown>)
        )
      ),
    (e) => onError?.(e)
  )
}

/** 댓글 작성 */
export async function addComment(
  classId: string,
  aid: string,
  author: { uid: string; name: string; role: 'teacher' | 'student' },
  text: string
): Promise<void> {
  const clean = text.trim().slice(0, COMMENT_MAX_LEN)
  if (!clean) throw new Error('내용을 입력해 주세요.')
  await addDoc(collection(db, 'classes', classId, 'announcements', aid, 'comments'), {
    authorId: author.uid,
    authorName: author.name,
    role: author.role,
    text: clean,
    createdAt: serverTimestamp(),
  })
}

/** 댓글 삭제 (본인 또는 담임) */
export async function deleteComment(classId: string, aid: string, cid: string): Promise<void> {
  await deleteDoc(doc(db, 'classes', classId, 'announcements', aid, 'comments', cid))
}

/** 학생 댓글 작성 시 담임에게 인앱 알림 (실패 무시) */
export async function notifyTeacherOfComment(
  classId: string,
  noticeTitle: string,
  studentName: string
): Promise<void> {
  try {
    const cls = await getDoc(doc(db, 'classes', classId))
    const teacherId = cls.exists() ? String(cls.data().teacherId || '') : ''
    if (!teacherId) return
    await addDoc(collection(db, 'users', teacherId, 'notifications'), {
      title: '알림장에 새 의견 💬',
      body: `${studentName}: "${noticeTitle}"에 의견을 남겼어요`,
      url: '/teacher/notices',
      createdAt: serverTimestamp(),
      read: false,
    })
  } catch (e) {
    console.error('댓글 알림 실패(무시):', e)
  }
}

/** Timestamp → '8월 26일' (올해가 아니면 '2025년 8월 26일') */
export function formatNoticeDate(ts: Timestamp | null | undefined): string {
  if (!ts) return ''
  const d = ts.toDate()
  const base = `${d.getMonth() + 1}월 ${d.getDate()}일`
  return d.getFullYear() === new Date().getFullYear() ? base : `${d.getFullYear()}년 ${base}`
}
