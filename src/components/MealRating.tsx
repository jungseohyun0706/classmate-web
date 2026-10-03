import { useEffect, useRef, useState, type JSX } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { auth } from '../lib/firebase'
import {
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

/** 기기에 남기는 투표 기록 키 — 계정·학교·날짜별로 따로 둡니다(공용 기기·다른 학교 잠금 방지). */
function voteStorageKey(uid: string, schoolCode: string, day: string): string {
  return `classmate_meal_vote_${uid}_${schoolCode}_${day}`
}

function avgEmoji(avg: number): string {
  const idx = Math.min(5, Math.max(1, Math.round(avg))) - 1
  return EMOJIS[idx]
}

/**
 * 급식 별점 위젯 — 1~5점 이모지 버튼 + 우리 학교 평균.
 * 계정당 1표(votes/{uid})로 중복 참여를 막습니다. localStorage 기록은 서버 확인 전 잠깐 보여주는 용도이고,
 * 실제 투표 여부는 서버의 votes/{uid}를 기준으로 합니다.
 * 투표는 로그인한 학생·선생님 계정만 가능합니다(익명 계정은 보안 규칙에서도 거부 — 별점 조작 방지).
 */
export default function MealRating({ schoolCode, ymd, compact = false }: MealRatingProps): JSX.Element {
  const { toast } = useUI()
  const day = ymd ?? todayKst()

  const [summary, setSummary] = useState<RatingSummary | null>(null)
  const [myRating, setMyRating] = useState<number | null>(null)
  const [busy, setBusy] = useState<boolean>(false)
  const [canVote, setCanVote] = useState<boolean>(false)
  // 투표가 끝나면 그 전에 시작된 조회 결과(투표 전 상태)가 잠금을 풀지 않도록 세대를 올립니다.
  const loadSeqRef = useRef<number>(0)

  // 집계 + 내 투표(votes/{uid}) 확인 — 학교·날짜·로그인 계정이 바뀌면 처음부터 다시 확인합니다.
  useEffect(() => {
    let cancelled = false
    const unsub = onAuthStateChanged(auth, (u) => {
      const seq = ++loadSeqRef.current
      setSummary(null)
      setMyRating(null)
      setCanVote(Boolean(u && !u.isAnonymous))
      // 서버 확인 전까지는 이 기기에 남긴 같은 계정·학교·날짜 기록으로 잠가 둡니다.
      if (u) {
        try {
          const saved = Number(window.localStorage.getItem(voteStorageKey(u.uid, schoolCode, day)))
          if (Number.isInteger(saved) && saved >= 1 && saved <= 5) {
            setMyRating(saved)
          }
        } catch {
          // localStorage 접근 불가(시크릿 모드 등)는 무시합니다.
        }
      }
      void (async () => {
        // 로그인 전에는 집계를 읽을 수 없을 수 있어요 — 실패한 쪽은 조용히 넘어갑니다.
        const [agg, mine] = await Promise.all([
          getRating(schoolCode, day).catch(() => undefined),
          u ? getMyVote(schoolCode, day).catch(() => undefined) : Promise.resolve<number | null>(null),
        ])
        if (cancelled || seq !== loadSeqRef.current) return
        if (agg !== undefined) setSummary(agg)
        // 서버 결과가 기준 — 투표 기록이 없으면(null) 기기 기록이 있어도 잠금을 풉니다.
        if (mine !== undefined) setMyRating(mine)
      })()
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [schoolCode, day])

  const handleVote = async (rating: number): Promise<void> => {
    if (busy || myRating !== null) return
    const user = auth.currentUser
    if (!user || user.isAnonymous) {
      toast('로그인한 학생·선생님만 별점을 남길 수 있어요', 'info')
      return
    }
    setBusy(true)
    const uid = user.uid
    try {
      await rateMeal(schoolCode, day, rating)
      loadSeqRef.current++
      try {
        window.localStorage.setItem(voteStorageKey(uid, schoolCode, day), String(rating))
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
        loadSeqRef.current++
        const mine = await getMyVote(schoolCode, day).catch(() => null)
        if (mine !== null) {
          setMyRating(mine)
          try {
            window.localStorage.setItem(voteStorageKey(uid, schoolCode, day), String(mine))
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
            disabled={voted || busy || !canVote}
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
            } ${voted || busy || !canVote ? 'cursor-default' : 'cursor-pointer'}`}
          >
            <span aria-hidden="true">{emoji}</span>
          </button>
        )
      })}
    </div>
  )

  const loginHint =
    !canVote && !voted ? (
      <p className="text-xs text-gray-400 break-keep">
        로그인한 학생·선생님만 별점을 남길 수 있어요
      </p>
    ) : null

  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {buttons}
        {averageLine}
        {loginHint}
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
        {loginHint}
      </div>
    </div>
  )
}
