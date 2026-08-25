// 보결 SOS 도우미 (클라이언트 전용)
// - createSos: SOS 발행 + 그 시간이 비어 있는 선생님들에게 알림/푸시 발송
// - acceptSos: 선착순 수락 (트랜잭션으로 open → assigned)
// - cancelSos: 요청자가 모집 중인 SOS를 취소
// 모든 함수는 반드시 클라이언트(핸들러/이펙트)에서만 호출해야 합니다.

import { auth, db } from './firebase'
import {
  addDoc,
  collection,
  doc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from 'firebase/firestore'

export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri'

const DAY_KEYS: (DayKey | null)[] = [null, 'mon', 'tue', 'wed', 'thu', 'fri', null] // getUTCDay(): 0=일
const DAY_LABELS_KO = ['일', '월', '화', '수', '목', '금', '토']

export type SosStatus = 'open' | 'assigned' | 'cancelled'

export interface SosRequestDoc {
  date: string // YYYYMMDD
  period: number // 1~7
  reason: string
  requesterId: string
  requesterName: string
  requesterClass: string
  schoolCode: string
  status: SosStatus
  createdAt: unknown
  assignedTo?: string
  assignedName?: string
  assignedAt?: unknown
  cancelledAt?: unknown
}

export class SosStateError extends Error {
  code: 'not-found' | 'not-open' | 'forbidden'
  constructor(code: 'not-found' | 'not-open' | 'forbidden', message: string) {
    super(message)
    this.name = 'SosStateError'
    this.code = code
  }
}

/** 오늘 날짜를 KST(Asia/Seoul) 기준 YYYYMMDD 문자열로 반환합니다. */
export function todayKstYmd(): string {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const y = kst.getUTCFullYear()
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0')
  const d = String(kst.getUTCDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

/** YYYYMMDD → 요일 키(mon~fri). 주말이거나 형식이 틀리면 null. */
export function ymdToDayKey(ymd: string): DayKey | null {
  if (!/^\d{8}$/.test(ymd)) return null
  const y = Number(ymd.slice(0, 4))
  const m = Number(ymd.slice(4, 6))
  const d = Number(ymd.slice(6, 8))
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return DAY_KEYS[day]
}

/** YYYYMMDD → "8월 25일 (월)" 형태의 표시용 문자열. */
export function formatYmd(ymd: string): string {
  if (!/^\d{8}$/.test(ymd)) return ymd
  const y = Number(ymd.slice(0, 4))
  const m = Number(ymd.slice(4, 6))
  const d = Number(ymd.slice(6, 8))
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return `${m}월 ${d}일 (${DAY_LABELS_KO[day]})`
}

// ---------- 알림/푸시 (공용 계약) ----------

async function writeNotification(toUid: string, title: string, body: string, url: string): Promise<void> {
  await addDoc(collection(db, 'users', toUid, 'notifications'), {
    title,
    body,
    url,
    createdAt: serverTimestamp(),
    read: false,
  })
}

/** 푸시 릴레이 호출. 실패해도 무시하는 fire-and-forget. */
async function sendPush(toUid: string, title: string, body: string, url: string): Promise<void> {
  try {
    const token = await auth.currentUser?.getIdToken()
    if (!token) return
    await fetch('/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ toUid, title, body, url }),
    })
  } catch {
    // 푸시 실패는 조용히 무시 (인앱 알림이 이미 남아 있음)
  }
}

// ---------- 빈 시간 선생님 스캔 ----------

export interface FreeTeacher {
  id: string
  name: string
}

/**
 * 우리 학교 선생님 중 해당 요일/교시가 비어 있는 선생님을 찾습니다.
 * my-schedule의 스캔 로직과 같은 쿼리를 쓰되,
 * 시간표(mySchedule)를 저장하지 않은 선생님은 '알 수 없음'으로 보고
 * 알림 대상에서 제외합니다(빈 시간으로 간주하지 않음).
 */
export async function findFreeTeachers(
  schoolCode: string,
  dayKey: DayKey,
  periodIdx: number, // 0-based (period - 1)
  excludeUid?: string
): Promise<FreeTeacher[]> {
  const q = query(
    collection(db, 'users'),
    where('schoolCode', '==', schoolCode),
    where('role', '==', 'teacher')
  )
  const snap = await getDocs(q)

  const free: FreeTeacher[] = []
  snap.forEach((d) => {
    if (excludeUid && d.id === excludeUid) return
    const t = d.data() as Record<string, any>
    const s = t.mySchedule
    // 시간표 미등록 선생님은 제외 (unknown ≠ free)
    if (!s || !Array.isArray(s[dayKey])) return
    if (!s[dayKey][periodIdx]) {
      free.push({ id: d.id, name: t.displayName || t.email || '선생님' })
    }
  })
  return free
}

// ---------- SOS 발행 / 수락 / 취소 ----------

export interface CreateSosInput {
  date?: string // YYYYMMDD, 기본값: 오늘(KST)
  period: number // 1~7
  reason?: string
  requesterId: string
  requesterName: string
  requesterClass?: string // 예: "3학년 2반", 없으면 "담임 없음"
  schoolCode: string
}

export interface CreateSosResult {
  id: string
  notified: number // 알림을 보낸 빈 시간 선생님 수
}

/**
 * SOS를 발행하고, 그 요일/교시가 비어 있는 선생님들에게
 * 인앱 알림 + 푸시를 보냅니다. 주말 날짜면 알림 대상은 0명입니다.
 */
export async function createSos(input: CreateSosInput): Promise<CreateSosResult> {
  const date = input.date && /^\d{8}$/.test(input.date) ? input.date : todayKstYmd()

  const ref = await addDoc(collection(db, 'school_sos', input.schoolCode, 'requests'), {
    date,
    period: input.period,
    reason: input.reason?.trim() || '',
    requesterId: input.requesterId,
    requesterName: input.requesterName,
    requesterClass: input.requesterClass || '담임 없음',
    schoolCode: input.schoolCode,
    status: 'open',
    createdAt: serverTimestamp(),
  })

  // 빈 시간 선생님 스캔 후 알림 발송
  let notified = 0
  const dayKey = ymdToDayKey(date)
  if (dayKey) {
    const free = await findFreeTeachers(input.schoolCode, dayKey, input.period - 1, input.requesterId)
    const title = '보결 SOS'
    const body = `${input.requesterName} 선생님이 ${formatYmd(date)} ${input.period}교시 보결을 요청했어요`
    const url = '/teacher/sos'

    await Promise.all(
      free.map(async (t) => {
        try {
          await writeNotification(t.id, title, body, url)
          notified += 1
        } catch {
          // 개별 알림 실패는 무시하고 계속
        }
        void sendPush(t.id, title, body, url)
      })
    )
  }

  return { id: ref.id, notified }
}

export interface AcceptSosInput {
  schoolCode: string
  reqId: string
  accepterId: string
  accepterName: string
}

/**
 * 선착순 수락: 트랜잭션으로 status가 'open'일 때만 assigned로 바꿉니다.
 * 이미 마감됐으면 SosStateError('not-open')를 던집니다.
 * 성공하면 요청자에게 알림/푸시를 보냅니다.
 */
export async function acceptSos(input: AcceptSosInput): Promise<void> {
  const ref = doc(db, 'school_sos', input.schoolCode, 'requests', input.reqId)

  const requesterId = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) {
      throw new SosStateError('not-found', 'SOS 요청을 찾을 수 없어요.')
    }
    const data = snap.data() as SosRequestDoc
    if (data.status !== 'open') {
      throw new SosStateError('not-open', '이미 마감된 SOS예요.')
    }
    if (data.requesterId === input.accepterId) {
      throw new SosStateError('forbidden', '내가 올린 SOS는 맡을 수 없어요.')
    }
    tx.update(ref, {
      status: 'assigned',
      assignedTo: input.accepterId,
      assignedName: input.accepterName,
      assignedAt: serverTimestamp(),
    })
    return data.requesterId
  })

  // 요청자에게 알림
  const title = '보결 SOS'
  const body = `${input.accepterName} 선생님이 보결을 맡아주셨어요`
  const url = '/teacher/sos'
  try {
    await writeNotification(requesterId, title, body, url)
  } catch {
    // 알림 실패는 수락 자체에 영향 없음
  }
  void sendPush(requesterId, title, body, url)
}

/**
 * 요청자 본인이 모집 중(open)인 SOS를 취소합니다.
 */
export async function cancelSos(schoolCode: string, reqId: string, requesterId: string): Promise<void> {
  const ref = doc(db, 'school_sos', schoolCode, 'requests', reqId)
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) {
      throw new SosStateError('not-found', 'SOS 요청을 찾을 수 없어요.')
    }
    const data = snap.data() as SosRequestDoc
    if (data.requesterId !== requesterId) {
      throw new SosStateError('forbidden', '본인이 올린 SOS만 취소할 수 있어요.')
    }
    if (data.status !== 'open') {
      throw new SosStateError('not-open', '모집 중인 SOS만 취소할 수 있어요.')
    }
    tx.update(ref, {
      status: 'cancelled',
      cancelledAt: serverTimestamp(),
    })
  })
}
