import {
  collection,
  doc,
  documentId,
  getDoc,
  getDocs,
  increment,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from 'firebase/firestore'
import { signInAnonymously } from 'firebase/auth'
import { auth, db } from './firebase'

/**
 * 급식 별점(meal_ratings) 유틸.
 * 모든 함수는 클라이언트(useEffect/핸들러)에서만 호출해야 합니다.
 *
 * 데이터 계약:
 * - meal_ratings/{schoolCode}_{YYYYMMDD}
 *   {schoolCode, date, sum, total, counts: {'1'..'5': number}}
 * - meal_ratings/{schoolCode}_{YYYYMMDD}/votes/{uid}
 *   {rating, createdAt} — 계정당 1표, 생성만 가능(수정/삭제 불가)
 */

export interface RatingSummary {
  /** 평균 별점 (total이 0이면 0) */
  avg: number
  /** 참여 인원 */
  total: number
  /** 점수별 투표 수 */
  counts: Record<string, number>
}

export interface MonthlyTopEntry extends RatingSummary {
  /** YYYYMMDD */
  date: string
}

function ratingDocId(schoolCode: string, ymd: string): string {
  return `${schoolCode}_${ymd}`
}

function toSummary(data: Record<string, unknown>): RatingSummary {
  const sum = typeof data.sum === 'number' ? data.sum : 0
  const total = typeof data.total === 'number' ? data.total : 0
  const rawCounts = (data.counts ?? {}) as Record<string, unknown>
  const counts: Record<string, number> = {}
  for (const key of ['1', '2', '3', '4', '5']) {
    counts[key] = typeof rawCounts[key] === 'number' ? (rawCounts[key] as number) : 0
  }
  return {
    avg: total > 0 ? sum / total : 0,
    total,
    counts,
  }
}

/**
 * 로그인 상태를 보장합니다. 방문자는 익명 로그인으로 참여할 수 있습니다.
 * @returns 로그인된 사용자의 uid
 */
export async function ensureSignedIn(): Promise<string> {
  if (auth.currentUser) {
    return auth.currentUser.uid
  }
  const cred = await signInAnonymously(auth)
  return cred.user.uid
}

/**
 * 오늘 급식에 별점을 남깁니다. 계정당 1표(votes/{uid})이며,
 * 이미 참여한 경우 '이미 참여했어요' 에러를 던집니다.
 */
export async function rateMeal(schoolCode: string, ymd: string, rating: number): Promise<void> {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error('별점은 1~5점만 가능해요')
  }
  const uid = auth.currentUser?.uid
  if (!uid) {
    throw new Error('로그인이 필요해요')
  }

  const parentRef = doc(db, 'meal_ratings', ratingDocId(schoolCode, ymd))
  const voteRef = doc(db, 'meal_ratings', ratingDocId(schoolCode, ymd), 'votes', uid)

  await runTransaction(db, async (tx) => {
    const voteSnap = await tx.get(voteRef)
    if (voteSnap.exists()) {
      throw new Error('이미 참여했어요')
    }
    tx.set(voteRef, { rating, createdAt: serverTimestamp() })
    tx.set(
      parentRef,
      {
        schoolCode,
        date: ymd,
        sum: increment(rating),
        total: increment(1),
        counts: { [String(rating)]: increment(1) },
      },
      { merge: true }
    )
  })
}

/** 특정 날짜의 별점 집계를 가져옵니다. 아직 아무도 참여하지 않았으면 null. */
export async function getRating(schoolCode: string, ymd: string): Promise<RatingSummary | null> {
  const snap = await getDoc(doc(db, 'meal_ratings', ratingDocId(schoolCode, ymd)))
  if (!snap.exists()) {
    return null
  }
  const summary = toSummary(snap.data() as Record<string, unknown>)
  return summary.total > 0 ? summary : null
}

/** 내가 이 날짜 급식에 이미 남긴 별점을 가져옵니다. 없으면 null. */
export async function getMyVote(schoolCode: string, ymd: string): Promise<number | null> {
  const uid = auth.currentUser?.uid
  if (!uid) {
    return null
  }
  const snap = await getDoc(doc(db, 'meal_ratings', ratingDocId(schoolCode, ymd), 'votes', uid))
  if (!snap.exists()) {
    return null
  }
  const rating = (snap.data() as Record<string, unknown>).rating
  return typeof rating === 'number' ? rating : null
}

/**
 * 이달의 최애 급식 TOP 5.
 * 문서 ID가 '{schoolCode}_{YYYYMMDD}' 형태이므로 documentId() 범위 쿼리를 사용합니다
 * (단일 필드 범위라 복합 색인이 필요 없습니다).
 * 신뢰도를 위해 3명 이상 참여한 날만 포함하고, 평균 내림차순으로 정렬합니다.
 */
export async function getMonthlyTop(schoolCode: string, yyyymm: string): Promise<MonthlyTopEntry[]> {
  const snap = await getDocs(
    query(
      collection(db, 'meal_ratings'),
      where(documentId(), '>=', `${schoolCode}_${yyyymm}01`),
      where(documentId(), '<=', `${schoolCode}_${yyyymm}31`)
    )
  )

  const entries: MonthlyTopEntry[] = []
  snap.forEach((d) => {
    const data = d.data() as Record<string, unknown>
    const summary = toSummary(data)
    const date = typeof data.date === 'string' ? data.date : d.id.slice(schoolCode.length + 1)
    if (summary.total >= 3) {
      entries.push({ date, ...summary })
    }
  })

  entries.sort((a, b) => b.avg - a.avg || b.total - a.total)
  return entries.slice(0, 5)
}
