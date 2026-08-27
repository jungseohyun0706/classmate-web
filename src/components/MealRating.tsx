import { useEffect, useState, type JSX } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { auth } from '../lib/firebase'
import {
  ensureSignedIn,
  getMyVote,
  getRating,
  rateMeal,
  type RatingSummary,
} from '../lib/meals'
import { useUI } from './ui/feedback'

interface MealRatingProps {
  schoolCode: string
  /** YYYYMMDD — 생략 시 오늘(KST) */
  ymd?: string
  /** true면 한 줄로 압축해서 렌더링 */
  compact?: boolean
}

const EMOJIS = ['😖', '😕', '😐', '😋', '🤩'] as const
const LABELS = ['별로예요', '아쉬워요', '보통이에요', '맛있어요', '최고예요'] as const

/** KST 기준 오늘 날짜 (YYYYMMDD) */
function todayKst(): string {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${d.getUTCFullYear()}${m}${day}`
}

function avgEmoji(avg: number): string {
  const idx = Math.min(5, Math.max(1, Math.round(avg))) - 1
  return EMOJIS[idx]
}

/**
 * 급식 별점 위젯 — 1~5점 이모지 버튼 + 우리 학교 평균.
 * 계정당 1표(votes/{uid} + localStorage)로 중복 참여를 막습니다.
 * 방문자는 투표 시 익명 로그인으로 참여할 수 있습니다.
 */
export default function MealRating({ schoolCode, ymd, compact = false }: MealRatingProps): JSX.Element {
  const { toast } = useUI()
  const day = ymd ?? todayKst()
  const storageKey = `classmate_meal_vote_${day}`

  const [summary, setSummary] = useState<RatingSummary | null>(null)
  const [myRating, setMyRating] = useState<number | null>(null)
  const [busy, setBusy] = useState<boolean>(false)

  // localStorage에 남긴 오늘의 투표 기록 확인 (기기 기준 중복 방지)
  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(storageKey))
      if (Number.isInteger(saved) && saved >= 1 && saved <= 5) {
        setMyRating(saved)
      }
    } catch {
      // localStorage 접근 불가(시크릿 모드 등)는 무시합니다.
    }
  }, [storageKey])

  // 집계 + 내 투표(votes/{uid}) 확인 — 로그인 상태가 바뀌면 다시 시도합니다.
  useEffect(() => {
    let cancelled = false
    const unsub = onAuthStateChanged(auth, (u) => {
      void (async () => {
        try {
          const [agg, mine] = await Promise.all([
            getRating(schoolCode, day),
            u ? getMyVote(schoolCode, day) : Promise.resolve<number | null>(null),
          ])
          if (cancelled) return
          setSummary(agg)
          if (mine !== null) {
            setMyRating(mine)
          }
        } catch {
          // 로그인 전에는 집계를 읽을 수 없을 수 있어요 — 조용히 넘어갑니다.
        }
      })()
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [schoolCode, day])

  const handleVote = async (rating: number): Promise<void> => {
    if (busy || myRating !== null) return
    setBusy(true)
    try {
      await ensureSignedIn()
      await rateMeal(schoolCode, day, rating)
      try {
        window.localStorage.setItem(storageKey, String(rating))
      } catch {
        // localStorage 실패는 무시 — votes/{uid}가 중복을 막아 줍니다.
      }
      setMyRating(rating)
      const agg = await getRating(schoolCode, day).catch(() => null)
      if (agg) setSummary(agg)
      const avg = (agg ? agg.avg : rating).toFixed(1)
      toast(`평가 완료! 오늘 급식 평균 ★${avg}`, 'success')
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (msg === '이미 참여했어요') {
        const mine = await getMyVote(schoolCode, day).catch(() => null)
        if (mine !== null) {
          setMyRating(mine)
          try {
            window.localStorage.setItem(storageKey, String(mine))
          } catch {
            // 무시
          }
        } else {
          setMyRating(0) // 점수를 몰라도 버튼은 잠급니다.
        }
        toast('오늘 급식에는 이미 참여했어요', 'info')
      } else {
        toast('평가에 실패했어요. 잠시 후 다시 시도해 주세요.', 'error')
      }
    } finally {
      setBusy(false)
    }
  }

  const voted = myRating !== null
  const averageLine =
    summary && summary.total > 0 ? (
      <p className={`text-gray-600 break-keep ${compact ? 'text-xs' : 'text-sm'}`}>
        우리 학교 평균 {avgEmoji(summary.avg)}{' '}
        <span className="font-semibold text-gray-900">{summary.avg.toFixed(1)}</span>/5 ({summary.total}
        명)
      </p>
    ) : (
      <p className={`text-gray-400 break-keep ${compact ? 'text-xs' : 'text-sm'}`}>
        아직 평가가 없어요. 첫 별점을 남겨 보세요!
      </p>
    )

  const buttons = (
    <div
      role="group"
      aria-label="급식 별점 (1~5점)"
      className={`flex items-center ${compact ? 'gap-1.5' : 'gap-2'}`}
    >
      {EMOJIS.map((emoji, i) => {
        const rating = i + 1
        const selected = myRating === rating
        return (
          <button
            key={rating}
            type="button"
            disabled={voted || busy}
            onClick={() => void handleVote(rating)}
            aria-label={`${rating}점 ${LABELS[i]}`}
            aria-pressed={selected}
            title={LABELS[i]}
            className={`flex items-center justify-center rounded-full transition-transform ${
              compact ? 'h-10 w-10 text-xl' : 'h-11 w-11 text-2xl'
            } ${
              selected
                ? 'scale-125 bg-amber-100 ring-2 ring-amber-400'
                : voted
                  ? 'opacity-35 grayscale'
                  : 'hover:scale-110 hover:bg-amber-50 active:scale-95'
            } ${voted || busy ? 'cursor-default' : 'cursor-pointer'}`}
          >
            <span aria-hidden="true">{emoji}</span>
          </button>
        )
      })}
    </div>
  )

  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {buttons}
        {averageLine}
      </div>
    )
  }

  return (
    <div className="space-y-2.5">
      <div className="flex justify-center sm:justify-start">{buttons}</div>
      <div className="text-center sm:text-left">
        {voted && myRating !== null && myRating >= 1 && (
          <p className="text-xs font-semibold text-amber-600 break-keep">
            내 평가: {EMOJIS[myRating - 1]} {LABELS[myRating - 1]}
          </p>
        )}
        {averageLine}
      </div>
    </div>
  )
}
