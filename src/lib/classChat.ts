// 우리 반 이야기방 — 반 단위 실시간 채팅 메시지
// classes/{classId}/chat/{mid} {authorId, authorName, role, text, createdAt}
import {
  Timestamp,
  addDoc,
  collection,
  deleteDoc,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  type Unsubscribe,
} from 'firebase/firestore'
import { db } from './firebase'

export interface ChatMessage {
  id: string
  authorId: string
  authorName: string
  role: 'teacher' | 'student'
  text: string
  createdAt: Timestamp | null
}

export const CHAT_MAX_LEN = 500

/** 최근 채팅 실시간 구독 (최신 100개, 시간 오름차순으로 콜백) */
export function watchChat(
  classId: string,
  onChange: (messages: ChatMessage[]) => void,
  onError?: (e: unknown) => void
): Unsubscribe {
  const q = query(
    collection(db, 'classes', classId, 'chat'),
    orderBy('createdAt', 'desc'),
    limit(100)
  )
  return onSnapshot(
    q,
    (snap) => {
      const list: ChatMessage[] = snap.docs.map((d) => {
        const v = d.data()
        return {
          id: d.id,
          authorId: String(v.authorId ?? ''),
          authorName: String(v.authorName ?? ''),
          role: v.role === 'teacher' ? 'teacher' : 'student',
          text: String(v.text ?? ''),
          createdAt: v.createdAt instanceof Timestamp ? v.createdAt : null,
        }
      })
      list.reverse()
      onChange(list)
    },
    (e) => onError?.(e)
  )
}

export async function sendChat(
  classId: string,
  author: { uid: string; name: string; role: 'teacher' | 'student' },
  text: string
): Promise<void> {
  const clean = text.trim().slice(0, CHAT_MAX_LEN)
  if (!clean) throw new Error('내용을 입력해 주세요.')
  await addDoc(collection(db, 'classes', classId, 'chat'), {
    authorId: author.uid,
    authorName: author.name,
    role: author.role,
    text: clean,
    createdAt: serverTimestamp(),
  })
}

export async function deleteChat(classId: string, mid: string): Promise<void> {
  await deleteDoc(doc(db, 'classes', classId, 'chat', mid))
}
