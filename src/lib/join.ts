// ---------------------------------------------------------------------------
// QR 학급 입장 (조인 토큰) — 공용 계약 1
//  - classes/{classId}/joinTokens/{token} { createdAt, expiresAt(now+10min) }
//  - 학생 랜딩: /join?c={classId}&t={token}
// 모든 함수는 클라이언트(브라우저) 전용입니다. (effect/핸들러에서만 호출)
// ---------------------------------------------------------------------------

import { auth, db } from './firebase'
import {
  addDoc,
  collection,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  Timestamp,
} from 'firebase/firestore'

export const JOIN_TOKEN_TTL_MS = 10 * 60 * 1000

export interface JoinClassInfo {
  classId: string
  schoolCode: string
  officeCode?: string
  schoolName: string
  grade: string | number
  classNm: string | number
  teacherId?: string
  teacherName?: string
}

export interface JoinStudentInput {
  name: string
  studentId?: string
}

/** 16바이트 랜덤 hex 토큰 (32자) */
function randomTokenId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** 새 입장 토큰 발급 — 10분 뒤 만료. QR/링크에 쓸 URL을 함께 돌려줍니다. */
export async function issueJoinToken(
  classId: string
): Promise<{ token: string; url: string; expiresAtMs: number }> {
  const token = randomTokenId()
  const expiresAtMs = Date.now() + JOIN_TOKEN_TTL_MS
  await setDoc(doc(db, 'classes', classId, 'joinTokens', token), {
    createdAt: serverTimestamp(),
    expiresAt: Timestamp.fromMillis(expiresAtMs),
  })
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return { token, url: `${origin}/join?c=${encodeURIComponent(classId)}&t=${token}`, expiresAtMs }
}

/** 토큰 유효성 확인 — 존재하고 아직 만료되지 않았는지 */
export async function validateJoinToken(classId: string, token: string): Promise<boolean> {
  if (!classId || !token) return false
  try {
    const snap = await getDoc(doc(db, 'classes', classId, 'joinTokens', token))
    if (!snap.exists()) return false
    const expiresAt = snap.data()?.expiresAt as Timestamp | undefined
    return !!expiresAt && expiresAt.toMillis() > Date.now()
  } catch (e) {
    console.error('입장 토큰 확인 실패', e)
    return false
  }
}

/** 확인 카드 표시용 학급 정보 읽기 */
export async function getJoinClassInfo(classId: string): Promise<JoinClassInfo | null> {
  try {
    const snap = await getDoc(doc(db, 'classes', classId))
    if (!snap.exists()) return null
    const data = snap.data()
    return {
      classId,
      schoolCode: String(data.schoolCode ?? ''),
      officeCode: data.officeCode ? String(data.officeCode) : undefined,
      schoolName: String(data.schoolName ?? ''),
      grade: data.grade as string | number,
      classNm: data.classNm as string | number,
      teacherId: data.teacherId ? String(data.teacherId) : undefined,
      teacherName: data.teacherName ? String(data.teacherName) : undefined,
    }
  } catch (e) {
    console.error('학급 정보 읽기 실패', e)
    return null
  }
}

/** 담임 교사에게 인앱 알림 기록 (공용 계약: users/{uid}/notifications) */
async function addTeacherNotification(toUid: string, title: string, body: string, url: string) {
  try {
    await addDoc(collection(db, 'users', toUid, 'notifications'), {
      title,
      body,
      url,
      createdAt: serverTimestamp(),
      read: false,
    })
  } catch (e) {
    console.error('알림 저장 실패', e)
  }
}

/** 푸시 릴레이 호출 — fire-and-forget, 실패해도 무시 */
function sendPushSafe(toUid: string, title: string, body: string, url: string) {
  try {
    void auth.currentUser
      ?.getIdToken()
      .then((token) =>
        fetch('/api/notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ toUid, title, body, url }),
        })
      )
      .catch(() => {})
  } catch {
    /* ignore */
  }
}

/**
 * 학급 입장 신청.
 * 토큰 검증 → 학급 정보 읽기 → users/{uid} 학생 프로필(status:'pending') 병합 저장
 * → 담임 교사에게 인앱 알림 + 푸시(fire-and-forget).
 */
export async function joinClass(
  classId: string,
  token: string,
  student: JoinStudentInput
): Promise<void> {
  const user = auth.currentUser
  if (!user) throw new Error('로그인이 필요해요.')

  const name = student.name.trim()
  if (!name) throw new Error('이름을 입력해 주세요.')

  const valid = await validateJoinToken(classId, token)
  if (!valid) throw new Error('입장 코드가 만료되었어요. 선생님께 새 코드를 요청해 주세요.')

  const classSnap = await getDoc(doc(db, 'classes', classId))
  if (!classSnap.exists()) throw new Error('학급 정보를 찾을 수 없어요.')
  const cls = classSnap.data()

  const profile: Record<string, unknown> = {
    role: 'student',
    status: 'pending',
    classId,
    schoolCode: cls.schoolCode,
    schoolName: cls.schoolName,
    grade: cls.grade,
    classNm: cls.classNm,
    name,
    displayName: name,
    email: user.email ?? null,
    createdAt: serverTimestamp(),
  }
  if (cls.officeCode) profile.officeCode = cls.officeCode
  const studentId = student.studentId?.trim()
  if (studentId) profile.studentId = studentId

  await setDoc(doc(db, 'users', user.uid), profile, { merge: true })

  // 담임 교사에게 승인 대기 알림
  const teacherId = cls.teacherId ? String(cls.teacherId) : ''
  if (teacherId) {
    const title = '새 학생 입장 신청'
    const body = `${name} 학생이 승인을 기다려요`
    const url = '/teacher/students'
    await addTeacherNotification(teacherId, title, body, url)
    sendPushSafe(teacherId, title, body, url)
  }
}
