/**
 * 수업 교환/보결 시스템.
 *
 * swap_requests/{id}:
 *   type: 'substitute' — 내 수업(a)을 상대가 대신 (상대는 그 시간이 비어 있어야 함)
 *   type: 'swap'       — 내 수업(a)과 상대 수업(b)의 시간을 맞바꿈
 *   status: pending → accepted | declined | cancelled
 *
 * 수락 시 트랜잭션으로 양쪽 users.mySchedule을 실제로 변경하고,
 * schools/{schoolCode}/changes 에 변경 내역(노란 칸 하이라이트용)을 남긴다.
 */
import {
  addDoc,
  collection,
  doc,
  runTransaction,
  serverTimestamp,
  type Firestore,
} from 'firebase/firestore'
import { koToEn, mondayOf, type DayKo } from './timetable'

export interface SwapCell {
  day: DayKo
  period: number
  subject: string
}

export interface SwapRequest {
  id?: string
  schoolCode: string
  type: 'substitute' | 'swap'
  fromUid: string
  fromName: string
  fromClassId?: string | null
  toUid: string
  toName: string
  toClassId?: string | null
  a: SwapCell // 요청자(from)의 수업
  b?: SwapCell // swap일 때 상대(to)의 수업
  note?: string
  status: 'pending' | 'accepted' | 'declined' | 'cancelled'
  weekOf: string
  createdAt?: any
  respondedAt?: any
}

export async function createSwapRequest(
  db: Firestore,
  req: Omit<SwapRequest, 'id' | 'status' | 'createdAt' | 'respondedAt'>,
) {
  return addDoc(collection(db, 'swap_requests'), {
    ...req,
    status: 'pending',
    createdAt: serverTimestamp(),
  })
}

const cellOf = (schedule: any, day: DayKo, period: number): string => {
  const en = koToEn[day]
  const v = schedule?.[en]?.[period - 1]
  return String(v ?? '').trim()
}

const setCell = (schedule: any, day: DayKo, period: number, value: string) => {
  const en = koToEn[day]
  const arr = Array.isArray(schedule?.[en]) ? [...schedule[en]] : ['', '', '', '', '', '', '']
  while (arr.length < 7) arr.push('')
  arr[period - 1] = value
  return { ...schedule, [en]: arr }
}

const emptySchedule = () => ({
  mon: ['', '', '', '', '', '', ''],
  tue: ['', '', '', '', '', '', ''],
  wed: ['', '', '', '', '', '', ''],
  thu: ['', '', '', '', '', '', ''],
  fri: ['', '', '', '', '', '', ''],
})

/**
 * 요청 수락 — 양쪽 시간표를 원자적으로 갱신.
 * 충돌(그 사이 시간표가 바뀜)이 있으면 Error를 던진다.
 */
export async function acceptSwapRequest(db: Firestore, reqId: string, req: SwapRequest) {
  await runTransaction(db, async (tx) => {
    const reqRef = doc(db, 'swap_requests', reqId)
    const reqSnap = await tx.get(reqRef)
    if (!reqSnap.exists() || reqSnap.data().status !== 'pending') {
      throw new Error('이미 처리된 요청입니다.')
    }

    const fromRef = doc(db, 'users', req.fromUid)
    const toRef = doc(db, 'users', req.toUid)
    const [fromSnap, toSnap] = [await tx.get(fromRef), await tx.get(toRef)]
    if (!fromSnap.exists() || !toSnap.exists()) throw new Error('사용자 정보를 찾을 수 없습니다.')

    let fromSch = fromSnap.data().mySchedule ?? emptySchedule()
    let toSch = toSnap.data().mySchedule ?? emptySchedule()

    if (req.type === 'substitute') {
      // 상대(to)가 내(from) 수업 a를 대신 맡는다
      if (cellOf(toSch, req.a.day, req.a.period)) {
        throw new Error(`${req.toName} 선생님의 ${req.a.day} ${req.a.period}교시에 이미 수업이 있습니다.`)
      }
      fromSch = setCell(fromSch, req.a.day, req.a.period, '')
      toSch = setCell(toSch, req.a.day, req.a.period, `${req.a.subject}(보결)`)
    } else {
      // swap: from의 a ↔ to의 b — 서로의 시간대로 이동
      if (!req.b) throw new Error('교환 대상 수업 정보가 없습니다.')
      if (cellOf(fromSch, req.b.day, req.b.period)) {
        throw new Error(`요청자 시간표의 ${req.b.day} ${req.b.period}교시가 더 이상 비어있지 않습니다.`)
      }
      if (cellOf(toSch, req.a.day, req.a.period)) {
        throw new Error(`수락자 시간표의 ${req.a.day} ${req.a.period}교시가 더 이상 비어있지 않습니다.`)
      }
      // from: a 자리 비우고 b 자리에서 자기 과목 수업
      fromSch = setCell(fromSch, req.a.day, req.a.period, '')
      fromSch = setCell(fromSch, req.b.day, req.b.period, `${req.a.subject}(교환)`)
      // to: b 자리 비우고 a 자리에서 자기 과목 수업
      toSch = setCell(toSch, req.b.day, req.b.period, '')
      toSch = setCell(toSch, req.a.day, req.a.period, `${req.b.subject}(교환)`)
    }

    tx.update(fromRef, { mySchedule: fromSch })
    tx.update(toRef, { mySchedule: toSch })
    tx.update(reqRef, { status: 'accepted', respondedAt: serverTimestamp() })

    // 변경 내역 기록 — 학생/교사 화면의 노란 하이라이트
    const classIds = [req.fromClassId, req.toClassId].filter(Boolean) as string[]
    const weekOf = req.weekOf || mondayOf()
    const changesCol = collection(db, 'schools', req.schoolCode, 'changes')

    const baseChange = {
      schoolCode: req.schoolCode,
      weekOf,
      classIds,
      aName: req.fromName,
      bName: req.toName,
      createdAt: serverTimestamp(),
    }
    if (req.type === 'substitute') {
      tx.set(doc(changesCol), {
        ...baseChange,
        type: 'substitute',
        day: req.a.day,
        period: req.a.period,
        aSubject: req.a.subject,
        note: `${req.a.subject} — ${req.fromName} → ${req.toName} 선생님 (보결)`,
      })
    } else {
      tx.set(doc(changesCol), {
        ...baseChange,
        type: 'swap',
        day: req.a.day,
        period: req.a.period,
        aSubject: req.a.subject,
        bSubject: req.b!.subject,
        note: `${req.a.period}교시 ${req.a.subject}(${req.fromName}) → ${req.b!.subject}(${req.toName}) 교환`,
      })
      tx.set(doc(changesCol), {
        ...baseChange,
        type: 'swap',
        day: req.b!.day,
        period: req.b!.period,
        aSubject: req.b!.subject,
        bSubject: req.a.subject,
        note: `${req.b!.period}교시 ${req.b!.subject}(${req.toName}) → ${req.a.subject}(${req.fromName}) 교환`,
      })
    }
  })
}

export async function declineSwapRequest(db: Firestore, reqId: string) {
  await runTransaction(db, async (tx) => {
    const ref = doc(db, 'swap_requests', reqId)
    const snap = await tx.get(ref)
    if (!snap.exists() || snap.data().status !== 'pending') throw new Error('이미 처리된 요청입니다.')
    tx.update(ref, { status: 'declined', respondedAt: serverTimestamp() })
  })
}

export async function cancelSwapRequest(db: Firestore, reqId: string) {
  await runTransaction(db, async (tx) => {
    const ref = doc(db, 'swap_requests', reqId)
    const snap = await tx.get(ref)
    if (!snap.exists() || snap.data().status !== 'pending') throw new Error('이미 처리된 요청입니다.')
    tx.update(ref, { status: 'cancelled', respondedAt: serverTimestamp() })
  })
}
