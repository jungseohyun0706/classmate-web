import {
  Timestamp,
  collection,
  doc,
  documentId,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore'
import { db } from './firebase'

/**
 * 가방 싸기(준비물 체크리스트) 유틸.
 * 모든 함수는 클라이언트(useEffect/핸들러)에서만 호출해야 합니다.
 *
 * 데이터 계약 (contract 3):
 * - users/{uid}/bagChecks/{YYYYMMDD}
 *   {items: {준비물이름: boolean}, done: boolean, updatedAt}
 *   → YYYYMMDD는 "가방을 싸는 대상 등교일"(보통 내일, 금/토요일엔 다음 월요일)입니다.
 */

/** 과목명 → 대표 준비물 (초등 기준, 과목명이 포함되면 매칭) */
export const SUBJECT_SUPPLIES: Readonly<Record<string, string>> = {
  체육: '체육복',
  미술: '미술 도구',
  음악: '리코더',
  영어: '영어 교과서',
  과학: '실험 관찰',
  수학: '수학 익힘책',
  국어: '국어 교과서',
  사회: '사회과 부도',
}

export interface ChecklistItem {
  name: string
  source: 'timetable' | 'notice'
}

export interface BagCheck {
  items: Record<string, boolean>
  done: boolean
}

export interface BuildChecklistParams {
  classId: string
  schoolCode: string
  uid: string
}

// getUTCDay() 인덱스(0=일) → Firestore 시간표 문서의 요일 키
const DAY_KEYS = ['', 'mon', 'tue', 'wed', 'thu', 'fri', ''] as const
const WEEKDAY_LABELS = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'] as const

/** KST 기준 현재 시각 — 반환값은 getUTC* 계열로만 읽습니다. */
function kstNow(): Date {
  return new Date(Date.now() + 9 * 60 * 60 * 1000)
}

function ymdOf(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function parseYmd(ymd: string): Date {
  return new Date(
    Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)))
  )
}

/** 다음 등교일(YYYYMMDD). 기본은 내일이고, 토/일이면 다음 월요일까지 건너뜁니다. */
export function nextSchoolDayYmd(): string {
  let d = new Date(kstNow().getTime() + 86400000)
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d = new Date(d.getTime() + 86400000)
  }
  return ymdOf(d)
}

/** ymd 바로 이전 등교일(YYYYMMDD). 주말은 건너뜁니다. */
function prevSchoolDayYmd(ymd: string): string {
  let d = new Date(parseYmd(ymd).getTime() - 86400000)
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d = new Date(d.getTime() - 86400000)
  }
  return ymdOf(d)
}

/** 'YYYYMMDD' → '8월 27일 목요일' */
export function formatBagDate(ymd: string): string {
  if (ymd.length !== 8) return ymd
  const d = parseYmd(ymd)
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 ${WEEKDAY_LABELS[d.getUTCDay()]}`
}

/**
 * 다음 등교일 준비물 체크리스트를 만듭니다.
 * 1) 학급 시간표(classes/{classId}/info/timetable)의 해당 요일 과목
 * 2) 시간표 변경(classes/{classId}/overrides/{ymd})을 덮어쓴 뒤
 *    SUBJECT_SUPPLIES로 과목 → 준비물 변환 (중복 제거)
 * 3) 최근 48시간 내 알림장(announcements)의 supplies[] 칩 추가 (contract 4)
 */
export async function buildChecklist(params: BuildChecklistParams): Promise<ChecklistItem[]> {
  const { classId } = params
  const ymd = nextSchoolDayYmd()
  const dayKey = DAY_KEYS[parseYmd(ymd).getUTCDay()]

  // 교시 → 과목 (시간표 + 변경 오버레이)
  const subjectByPeriod = new Map<number, string>()

  try {
    const snap = await getDoc(doc(db, 'classes', classId, 'info', 'timetable'))
    if (snap.exists() && dayKey) {
      const arr = (snap.data() as Record<string, unknown>)[dayKey]
      if (Array.isArray(arr)) {
        arr.forEach((s, i) => {
          const subject = String(s ?? '').trim()
          if (subject) subjectByPeriod.set(i + 1, subject)
        })
      }
    }
  } catch {
    // 시간표 조회 실패 시 알림장 준비물만 표시
  }

  try {
    const ovSnap = await getDoc(doc(db, 'classes', classId, 'overrides', ymd))
    if (ovSnap.exists()) {
      const periodsObj = (ovSnap.data() as { periods?: Record<string, { subject?: unknown }> })
        .periods
      if (periodsObj && typeof periodsObj === 'object') {
        for (const key of Object.keys(periodsObj)) {
          const p = Number(key)
          const subject = String(periodsObj[key]?.subject ?? '').trim()
          if (p && subject) subjectByPeriod.set(p, subject)
        }
      }
    }
  } catch {
    // 변경 정보 조회 실패 시 원래 시간표 기준으로 계산
  }

  const items: ChecklistItem[] = []
  const seen = new Set<string>()
  const push = (name: string, source: ChecklistItem['source']): void => {
    if (seen.has(name)) return
    seen.add(name)
    items.push({ name, source })
  }

  // 교시 순서대로 과목 → 준비물
  const periods = Array.from(subjectByPeriod.keys()).sort((a, b) => a - b)
  for (const p of periods) {
    const subject = subjectByPeriod.get(p) ?? ''
    for (const key of Object.keys(SUBJECT_SUPPLIES)) {
      if (subject.includes(key)) push(SUBJECT_SUPPLIES[key], 'timetable')
    }
  }

  // 최근 48시간 내 알림장의 준비물 칩
  try {
    const since = Timestamp.fromMillis(Date.now() - 48 * 60 * 60 * 1000)
    const snap = await getDocs(
      query(collection(db, 'classes', classId, 'announcements'), where('createdAt', '>=', since))
    )
    for (const d of snap.docs) {
      const supplies = (d.data() as { supplies?: unknown }).supplies
      if (!Array.isArray(supplies)) continue
      for (const s of supplies) {
        const name = String(s ?? '').trim()
        if (name) push(name, 'notice')
      }
    }
  } catch {
    // 승인 전 등 알림장 권한이 없으면 시간표 준비물만 표시
  }

  return items
}

/** 저장된 체크 상태를 가져옵니다. 없으면 null. */
export async function loadCheck(uid: string, ymd: string): Promise<BagCheck | null> {
  const snap = await getDoc(doc(db, 'users', uid, 'bagChecks', ymd))
  if (!snap.exists()) return null
  const data = snap.data() as { items?: Record<string, unknown>; done?: unknown }
  const items: Record<string, boolean> = {}
  if (data.items && typeof data.items === 'object') {
    for (const key of Object.keys(data.items)) {
      items[key] = data.items[key] === true
    }
  }
  return { items, done: data.done === true }
}

/** 체크 상태를 저장합니다 (users/{uid}/bagChecks/{ymd}). */
export async function saveCheck(
  uid: string,
  ymd: string,
  items: Record<string, boolean>,
  done: boolean
): Promise<void> {
  await setDoc(doc(db, 'users', uid, 'bagChecks', ymd), {
    items,
    done,
    updatedAt: serverTimestamp(),
  })
}

/**
 * 연속 가방 싸기 일수(스트릭)를 계산합니다.
 * 최근 bagChecks 30건을 읽어, 현재 대상 등교일부터 주말을 건너뛰며
 * 거꾸로 걸으면서 done === true인 날을 셉니다.
 * 아직 안 싼 현재 대상일은 스트릭을 끊지 않고 건너뜁니다.
 */
export async function getStreak(uid: string): Promise<number> {
  const snap = await getDocs(
    query(collection(db, 'users', uid, 'bagChecks'), orderBy(documentId(), 'desc'), limit(30))
  )
  const doneByYmd = new Map<string, boolean>()
  for (const d of snap.docs) {
    doneByYmd.set(d.id, (d.data() as { done?: unknown }).done === true)
  }
  if (doneByYmd.size === 0) return 0

  let cursor = nextSchoolDayYmd()
  let streak = 0
  for (let i = 0; i < 40; i++) {
    if (doneByYmd.get(cursor) === true) {
      streak++
    } else if (i > 0) {
      break
    }
    cursor = prevSchoolDayYmd(cursor)
  }
  return streak
}
