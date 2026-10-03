import { useId, type JSX } from 'react'
import { addDays, formatYmdKo, isoToYmd, relativeDayLabel, toUtcDate, ymdToIso } from '../../lib/timetable/dates'
import type { Ymd } from '../../lib/timetable/types'

export interface DayNavProps {
  /** 보고 있는 날짜 (YYYYMMDD, 학교 시간대) */
  date: Ymd
  /** 오늘 (YYYYMMDD, 학교 시간대) */
  today: Ymd
  onChange: (date: Ymd) => void
  /** 홈 카드처럼 좁은 자리 */
  compact?: boolean
}

/** 상대 날짜 이름: 어제/오늘/내일/모레, 그 밖은 'N일 전'·'N일 뒤' */
export function relativeLabel(date: Ymd, today: Ymd): string {
  const rel = relativeDayLabel(date, today)
  if (rel) return rel
  const diff = Math.round((toUtcDate(date).getTime() - toUtcDate(today).getTime()) / 86400000)
  return diff < 0 ? `${-diff}일 전` : `${diff}일 뒤`
}

/**
 * 날짜 이동: ‹ 이전 날 · (상대 날짜 + 실제 날짜·요일) · 다음 날 ›, 날짜 선택(input date), 오늘로.
 * 주말·휴일도 선택할 수 있습니다(수업 여부는 시간표가 판단).
 */
export default function DayNav({ date, today, onChange, compact = false }: DayNavProps): JSX.Element {
  const inputId = useId()
  const rel = relativeLabel(date, today)
  const isToday = date === today
  const go = (d: Ymd) => {
    if (d !== date) onChange(d)
  }

  const arrowCls =
    'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-gray-600 ring-1 ring-gray-200 transition-colors hover:bg-gray-50 active:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500'

  return (
    <nav aria-label="날짜 이동" className={compact ? 'space-y-2' : 'space-y-3'}>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => go(addDays(date, -1))} aria-label="이전 날" className={arrowCls}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden="true">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <div className="min-w-0 flex-1 text-center" aria-live="polite" aria-atomic="true">
          <p
            className={`text-xs font-bold ${
              isToday ? 'text-emerald-600' : rel === '어제' || rel.endsWith('전') ? 'text-gray-500' : 'text-blue-600'
            }`}
          >
            {rel}
          </p>
          <p className={`${compact ? 'text-base' : 'text-lg'} font-bold text-gray-900 break-keep`}>{formatYmdKo(date)}</p>
        </div>
        <button type="button" onClick={() => go(addDays(date, 1))} aria-label="다음 날" className={arrowCls}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden="true">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      </div>
      <div className="flex items-center gap-2">
        <label htmlFor={inputId} className="sr-only">
          날짜 선택
        </label>
        <input
          id={inputId}
          type="date"
          value={ymdToIso(date)}
          min="2000-01-01"
          max="2099-12-31"
          onChange={(e) => {
            const d = isoToYmd(e.target.value)
            if (d) go(d)
          }}
          className="h-11 min-w-0 flex-1 rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-800 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
        />
        {!isToday && (
          <button
            type="button"
            onClick={() => go(today)}
            className="h-11 shrink-0 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            오늘로
          </button>
        )}
      </div>
    </nav>
  )
}
