// 교시 품앗이(수업 교환) 관련 Firestore 헬퍼
// - school_swaps/{schoolCode}/direct_requests : 특정 선생님에게 보낸 1:1 요청
// - school_swaps/{schoolCode}/requests        : 학교 게시판 공개 요청
// 모든 함수는 클라이언트(핸들러/이펙트)에서만 호출해야 합니다.
import {
  addDoc,
  collection,
  doc,
  getDocs,
  limit,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
  type Timestamp,
} from 'firebase/firestore'
import { auth, db } from './firebase'

export type SwapStatus = 'pending' | 'accepted' | 'declined' | 'cancelled'

export interface SwapRequestBase {
  id: string
  schoolCode: string
  requesterId: string
  requesterName: string
  /** 요청자 반 문서 ID (classes/{classId}) — 신규 문서에만 존재 */
  requesterClassId?: string | null
  /** '3학년 2반' 같은 표시용 라벨 */
  requesterClass?: string
  day: string // 'mon'..'fri'
  dayLabel?: string // '월'..'금'
  period: number
  subject: string
  /** 실제 수업 날짜 YYYYMMDD (KST) — 신규 문서에만 존재 */
  date?: string
  note?: string
  status: SwapStatus
  createdAt?: Timestamp | null
  accepterId?: string
  accepterName?: string
}

export interface DirectSwapRequest extends SwapRequestBase {
  kind: 'direct'
  toId: string
  toName?: string
}

export interface PublicSwapRequest extends SwapRequestBase {
  kind: 'public'
}

export type SwapRequest = DirectSwapRequest | PublicSwapRequest

/** 수락/거절하는 현재 사용자 정보 */
export interface SwapActor {
  uid: string
  name: string
  /** 수락자 반 문서 ID — 있으면 수락 시 해당 반에도 override 를 기록 */
  classId?: string | null
}

export const DAY_LABELS_KO: Record<string, string> = {
  mon: '월',
  tue: '화',
  wed: '수',
  thu: '목',
  fri: '금',
}

const DAY_TO_JS_IDX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}

/**
 * 선택한 요일(mon..fri)의 다음 도래일을 KST 기준 YYYYMMDD 로 반환합니다.
 * 오늘이 해당 요일이면 오늘 날짜를 반환합니다.
 */
export function nextOccurrenceYmdKst(day: string): string {
  const target = DAY_TO_JS_IDX[day] ?? 1
  const nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const diff = (target - nowKst.getUTCDay() + 7) % 7
  const d = new Date(nowKst.getTime() + diff * 24 * 60 * 60 * 1000)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${y}${m}${dd}`
}

/** 'YYYYMMDD' → '8월 26일' (형식이 아니면 빈 문자열) */
export function formatYmd(ymd?: string): string {
  if (!ymd || !/^\d{8}$/.test(ymd)) return ''
  return `${parseInt(ymd.slice(4, 6), 10)}월 ${parseInt(ymd.slice(6, 8), 10)}일`
}

/** 카드에 표시할 날짜 라벨 — 날짜가 있으면 '8월 26일 (화)', 없으면 '화요일' */
export function formatSwapDate(req: Pick<SwapRequestBase, 'date' | 'day' | 'dayLabel'>): string {
  const dayLabel = req.dayLabel || DAY_LABELS_KO[req.day] || ''
  const ymd = formatYmd(req.date)
  if (ymd) return dayLabel ? `${ymd} (${dayLabel})` : ymd
  return dayLabel ? `${dayLabel}요일` : '요일 미정'
}

// ---------------------------------------------------------------------------
// 문서 정규화 (레거시 문서: fromId/fromName 만 있는 direct 요청 등)
// ---------------------------------------------------------------------------

function normalizeStatus(raw: unknown): SwapStatus {
  if (raw === 'accepted' || raw === 'declined' || raw === 'cancelled') return raw
  return 'pending'
}

function normalizeDirect(schoolCode: string, id: string, data: Record<string, any>): DirectSwapRequest {
  return {
    kind: 'direct',
    id,
    schoolCode,
    requesterId: data.requesterId ?? data.fromId ?? '',
    requesterName: data.requesterName ?? data.fromName ?? '이름 없음',
    requesterClassId: data.requesterClassId ?? null,
    requesterClass: data.requesterClass,
    toId: data.toId ?? '',
    toName: data.toName,
    day: data.day ?? '',
    dayLabel: data.dayLabel,
    period: Number(data.period) || 0,
    subject: data.subject ?? '',
    date: data.date,
    note: data.note,
    status: normalizeStatus(data.status),
    createdAt: data.createdAt ?? null,
    accepterId: data.accepterId,
    accepterName: data.accepterName,
  }
}

function normalizePublic(schoolCode: string, id: string, data: Record<string, any>): PublicSwapRequest {
  return {
    kind: 'public',
    id,
    schoolCode,
    requesterId: data.requesterId ?? '',
    requesterName: data.requesterName ?? '이름 없음',
    requesterClassId: data.requesterClassId ?? null,
    requesterClass: data.requesterClass,
    day: data.day ?? '',
    dayLabel: data.dayLabel,
    period: Number(data.period) || 0,
    subject: data.subject ?? '',
    date: data.date,
    note: data.note,
    status: normalizeStatus(data.status),
    createdAt: data.createdAt ?? null,
    accepterId: data.accepterId,
    accepterName: data.accepterName,
  }
}

function sortByCreatedDesc<T extends SwapRequestBase>(items: T[]): T[] {
  return items.sort((a, b) => {
    const am = a.createdAt?.toMillis?.() ?? 0
    const bm = b.createdAt?.toMillis?.() ?? 0
    return bm - am
  })
}

function directCol(schoolCode: string) {
  return collection(db, 'school_swaps', schoolCode, 'direct_requests')
}

function publicCol(schoolCode: string) {
  return collection(db, 'school_swaps', schoolCode, 'requests')
}

function requestDocRef(req: SwapRequest) {
  return req.kind === 'direct'
    ? doc(db, 'school_swaps', req.schoolCode, 'direct_requests', req.id)
    : doc(db, 'school_swaps', req.schoolCode, 'requests', req.id)
}

// ---------------------------------------------------------------------------
// 목록 조회
// ---------------------------------------------------------------------------

/** 내가 받은 1:1 교환 요청 */
export async function listReceived(uid: string, schoolCode: string): Promise<DirectSwapRequest[]> {
  const snap = await getDocs(query(directCol(schoolCode), where('toId', '==', uid)))
  const items: DirectSwapRequest[] = []
  snap.forEach((d) => items.push(normalizeDirect(schoolCode, d.id, d.data())))
  return sortByCreatedDesc(items)
}

/** 내가 보낸 요청 (1:1 + 게시판 공개 요청) */
export async function listSent(uid: string, schoolCode: string): Promise<SwapRequest[]> {
  const [byFrom, byRequester, byPublic] = await Promise.all([
    getDocs(query(directCol(schoolCode), where('fromId', '==', uid))),
    getDocs(query(directCol(schoolCode), where('requesterId', '==', uid))),
    getDocs(query(publicCol(schoolCode), where('requesterId', '==', uid))),
  ])
  const map = new Map<string, SwapRequest>()
  byFrom.forEach((d) => map.set(`d_${d.id}`, normalizeDirect(schoolCode, d.id, d.data())))
  byRequester.forEach((d) => map.set(`d_${d.id}`, normalizeDirect(schoolCode, d.id, d.data())))
  byPublic.forEach((d) => map.set(`p_${d.id}`, normalizePublic(schoolCode, d.id, d.data())))
  return sortByCreatedDesc(Array.from(map.values()))
}

/** 학교 게시판 공개 요청 전체 (최신순) */
export async function listPublic(schoolCode: string): Promise<PublicSwapRequest[]> {
  const snap = await getDocs(query(publicCol(schoolCode), limit(100)))
  const items: PublicSwapRequest[] = []
  snap.forEach((d) => items.push(normalizePublic(schoolCode, d.id, d.data())))
  return sortByCreatedDesc(items)
}

// ---------------------------------------------------------------------------
// 알림 (인앱 + 푸시 릴레이)
// ---------------------------------------------------------------------------

async function addInboxNotification(toUid: string, title: string, body: string, url: string) {
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

function sendPushSafe(toUid: string, title: string, body: string, url: string) {
  // fire-and-forget: 실패해도 UX 에 영향 없음
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

// ---------------------------------------------------------------------------
// 시간표 override (계약 4)
// ---------------------------------------------------------------------------

async function writeOverride(classId: string, date: string, period: number, subject: string, reason: string) {
  try {
    await setDoc(
      doc(db, 'classes', classId, 'overrides', date),
      { periods: { [period]: { subject, reason, updatedAt: serverTimestamp() } } },
      { merge: true }
    )
  } catch (e) {
    console.error('시간표 override 기록 실패', e)
  }
}

/** 수락 확정 후 공통 처리: override 기록 + 요청자 알림 + 푸시 */
async function afterAccept(req: SwapRequest, actor: SwapActor) {
  // 날짜가 없는 레거시 문서는 override 를 건너뜁니다.
  if (req.date) {
    if (req.requesterClassId) {
      await writeOverride(req.requesterClassId, req.date, req.period, req.subject, `${actor.name} 선생님 교환 수업`)
    }
    if (actor.classId) {
      await writeOverride(actor.classId, req.date, req.period, req.subject, `${req.requesterName} 선생님과 교환`)
    }
  }

  const title = '교환 수락됨 🙌'
  const body = `${actor.name} 선생님이 ${formatSwapDate(req)} ${req.period}교시(${req.subject}) 교환을 수락했어요.`
  const url = '/teacher/swaps'
  if (req.requesterId) {
    await addInboxNotification(req.requesterId, title, body, url)
    sendPushSafe(req.requesterId, title, body, url)
  }
}

// ---------------------------------------------------------------------------
// 상태 변경 (트랜잭션)
// ---------------------------------------------------------------------------

/** 내게 온 1:1 요청 수락 */
export async function acceptDirectRequest(req: DirectSwapRequest, actor: SwapActor): Promise<void> {
  if (req.toId && req.toId !== actor.uid) throw new Error('나에게 온 요청만 수락할 수 있어요.')
  const ref = requestDocRef(req)
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) throw new Error('요청을 찾을 수 없어요.')
    if (normalizeStatus(snap.data().status) !== 'pending') throw new Error('이미 처리된 요청이에요.')
    tx.update(ref, {
      status: 'accepted',
      acceptedAt: serverTimestamp(),
      accepterId: actor.uid,
      accepterName: actor.name,
    })
  })
  await afterAccept(req, actor)
}

/** 내게 온 1:1 요청 거절 */
export async function declineDirectRequest(req: DirectSwapRequest, actor: SwapActor): Promise<void> {
  if (req.toId && req.toId !== actor.uid) throw new Error('나에게 온 요청만 거절할 수 있어요.')
  const ref = requestDocRef(req)
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) throw new Error('요청을 찾을 수 없어요.')
    if (normalizeStatus(snap.data().status) !== 'pending') throw new Error('이미 처리된 요청이에요.')
    tx.update(ref, {
      status: 'declined',
      declinedAt: serverTimestamp(),
      declinerId: actor.uid,
      declinerName: actor.name,
    })
  })

  const title = '교환 요청 거절'
  const body = `아쉽지만 거절됐어요. ${formatSwapDate(req)} ${req.period}교시(${req.subject}) 교환은 다른 선생님께 부탁해 보세요.`
  const url = '/teacher/swaps'
  if (req.requesterId) {
    await addInboxNotification(req.requesterId, title, body, url)
    sendPushSafe(req.requesterId, title, body, url)
  }
}

/** 내가 보낸 대기중 요청 취소 (1:1 / 게시판 공통) */
export async function cancelRequest(req: SwapRequest): Promise<void> {
  const uid = auth.currentUser?.uid
  if (!uid || uid !== req.requesterId) throw new Error('내가 보낸 요청만 취소할 수 있어요.')
  const ref = requestDocRef(req)
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) throw new Error('요청을 찾을 수 없어요.')
    if (normalizeStatus(snap.data().status) !== 'pending') throw new Error('이미 처리된 요청은 취소할 수 없어요.')
    tx.update(ref, { status: 'cancelled', cancelledAt: serverTimestamp() })
  })
}

/** 게시판 공개 요청 수락 (선착순) */
export async function acceptPublicRequest(req: PublicSwapRequest, actor: SwapActor): Promise<void> {
  if (req.requesterId === actor.uid) throw new Error('내가 올린 요청은 수락할 수 없어요.')
  const ref = requestDocRef(req)
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) throw new Error('요청을 찾을 수 없어요.')
    if (normalizeStatus(snap.data().status) !== 'pending') throw new Error('이미 다른 선생님이 수락했어요.')
    tx.update(ref, {
      status: 'accepted',
      acceptedAt: serverTimestamp(),
      accepterId: actor.uid,
      accepterName: actor.name,
    })
  })
  await afterAccept(req, actor)
}
