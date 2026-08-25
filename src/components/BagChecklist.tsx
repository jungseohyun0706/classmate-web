import { useEffect, useMemo, useState, type JSX } from 'react'
import {
  buildChecklist,
  formatBagDate,
  getStreak,
  loadCheck,
  nextSchoolDayYmd,
  saveCheck,
  type ChecklistItem,
} from '../lib/bag'

export interface BagChecklistProps {
  classId: string
  schoolCode: string
  uid: string
}

/**
 * '내일 가방 싸기' 카드 — 다음 등교일 준비물 체크리스트.
 * 시간표 과목 + 최근 알림장 준비물을 합쳐 보여주고,
 * 체크 상태는 users/{uid}/bagChecks/{ymd}에 저장합니다.
 */
export default function BagChecklist({ classId, schoolCode, uid }: BagChecklistProps): JSX.Element {
  const [ymd] = useState<string>(() => nextSchoolDayYmd())
  const [loading, setLoading] = useState<boolean>(true)
  const [items, setItems] = useState<ChecklistItem[]>([])
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [streak, setStreak] = useState<number>(0)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [list, saved, s] = await Promise.all([
          buildChecklist({ classId, schoolCode, uid }),
          loadCheck(uid, ymd),
          getStreak(uid),
        ])
        if (cancelled) return
        setItems(list)
        const init: Record<string, boolean> = {}
        for (const item of list) {
          init[item.name] = saved?.items[item.name] === true
        }
        setChecked(init)
        setStreak(s)
      } catch (e) {
        console.error(e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [classId, schoolCode, uid, ymd])

  const checkedCount = useMemo<number>(
    () => items.filter((i) => checked[i.name] === true).length,
    [items, checked]
  )
  const allDone = items.length > 0 && checkedCount === items.length

  const handleToggle = (name: string): void => {
    const next = { ...checked, [name]: checked[name] !== true }
    setChecked(next)
    const nowDone = items.length > 0 && items.every((i) => next[i.name] === true)
    void saveCheck(uid, ymd, next, nowDone)
      .then(() => {
        if (nowDone) {
          // 방금 완료 도장을 찍었으면 스트릭을 새로 계산
          getStreak(uid).then(setStreak).catch(() => {})
        }
      })
      .catch((e) => console.error(e))
  }

  return (
    <section className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-lg">
      {/* 헤더 */}
      <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4.5 w-4.5"
              aria-hidden="true"
            >
              <path d="M9 7V5a3 3 0 0 1 6 0v2" />
              <rect x="5" y="7" width="14" height="14" rx="3" />
              <path d="M9 21v-4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4" />
            </svg>
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-gray-700">내일 가방 싸기</h2>
            <p className="truncate text-xs text-gray-400">{formatBagDate(ymd)} 준비물</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {streak >= 2 && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-orange-50 px-2.5 py-1 text-xs font-bold text-orange-600 ring-1 ring-orange-200">
              🔥 {streak}일 연속
            </span>
          )}
          {!loading && items.length > 0 && (
            <span
              className={`text-xs font-semibold ${allDone ? 'text-emerald-600' : 'text-gray-400'}`}
            >
              {checkedCount}/{items.length}
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <div className="animate-pulse space-y-2 p-4">
          <div className="h-11 rounded-lg bg-gray-100" />
          <div className="h-11 rounded-lg bg-gray-100" />
          <div className="h-11 rounded-lg bg-gray-100" />
        </div>
      ) : items.length === 0 ? (
        /* 준비물 없음 */
        <p className="px-4 py-8 text-center text-sm text-gray-500 break-keep">
          내일 준비물이 없어요! 편하게 자요 😴
        </p>
      ) : (
        <>
          <ul className="divide-y divide-gray-100">
            {items.map((item) => {
              const isChecked = checked[item.name] === true
              return (
                <li key={item.name}>
                  <label className="flex cursor-pointer items-center gap-3 px-4 py-3.5 transition-colors hover:bg-emerald-50/50 active:bg-emerald-50">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => handleToggle(item.name)}
                      className="h-6 w-6 shrink-0 rounded border-gray-300 text-emerald-600 accent-emerald-600 focus:ring-emerald-500"
                    />
                    <span
                      className={`min-w-0 flex-1 break-keep text-base ${
                        isChecked ? 'text-gray-400 line-through' : 'font-medium text-gray-800'
                      }`}
                    >
                      {item.name}
                    </span>
                    {item.source === 'notice' && (
                      <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200">
                        알림장
                      </span>
                    )}
                  </label>
                </li>
              )
            })}
          </ul>

          {/* 전부 체크 → 도장 */}
          {allDone && (
            <div className="flex flex-col items-center gap-1.5 border-t border-emerald-100 bg-emerald-50/60 py-5">
              <div className="bag-stamp flex h-24 w-24 flex-col items-center justify-center rounded-full border-4 border-emerald-500 bg-white/70 text-emerald-600">
                <span className="text-lg font-extrabold leading-tight">가방</span>
                <span className="text-lg font-extrabold leading-tight">완료!</span>
              </div>
              <p className="text-xs font-medium text-emerald-700 break-keep">
                내일 가방 준비 끝! 잘했어요 👏
              </p>
              <style>{`
                @keyframes bagStamp {
                  0% { transform: scale(2.1) rotate(-12deg); opacity: 0; }
                  60% { transform: scale(0.92) rotate(-12deg); opacity: 1; }
                  100% { transform: scale(1) rotate(-12deg); opacity: 1; }
                }
                .bag-stamp { animation: bagStamp 0.45s cubic-bezier(0.2, 0.9, 0.3, 1.35) both; }
              `}</style>
            </div>
          )}
        </>
      )}
    </section>
  )
}
