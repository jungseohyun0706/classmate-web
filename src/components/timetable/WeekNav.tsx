import { useId, type JSX } from 'react'
import { isoToYmd, ymdToIso } from '../../lib/timetable/dates'
import { relativeWeekLabel, weekStartOf } from '../../lib/timetable/teacherWeek'
import type { Ymd } from '../../lib/timetable/types'

export interface WeekNavProps {
  /** 보고 있는 날짜(그 주의 아무 날, YYYYMMDD) */
  date: Ymd
  today: Ymd
  /** 보이는 열의 기간 라벨('10월 5일 ~ 10월 9일') */
  rangeLabel: string
  /** 이번 주·날짜 선택(그 날짜로) */
  onChange: (date: Ymd) => void
  /** 지난주(-1)·다음 주(+1) — 화면이 아직 주소에 반영되지 않은 이동까지 이어서 계산하도록 몇 주인지만 넘김 */
  onShift: (weeks: number) => void
}

/**
 * 주 이동: ‹ 지난주 · 이번 주 · 다음 주 ›, 기간 라벨(상대 주 + '10월 5일 ~ 10월 9일'), 날짜 선택(그 날짜가 든 주로).
 * 주를 옮겨도 요일은 그대로(하루 보기로 바꾸면 같은 요일)
 */
export default function WeekNav({ date, today, rangeLabel, onChange, onShift }: WeekNavProps): JSX.Element {
  const inputId = useId()
  const thisWeek = weekStartOf(date) === weekStartOf(today)
  const rel = relativeWeekLabel(date, today)
  const btn =
    'flex h-11 min-w-0 items-center justify-center gap-1 rounded-xl px-2 text-sm font-semibold ring-1 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500'
  const arrow = (d: string) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0" aria-hidden="true">
      <path d={d} />
    </svg>
  )

  return (
    <nav aria-label="주 이동" className="space-y-2">
      <div className="grid grid-cols-3 gap-2">
        <button type="button" onClick={() => onShift(-1)} className={`${btn} text-gray-700 ring-gray-200 hover:bg-gray-50 active:bg-gray-100`}>
          {arrow('m15 18-6-6 6-6')}
          지난주
        </button>
        <button
          type="button"
          onClick={() => onChange(today)}
          disabled={thisWeek}
          aria-current={thisWeek ? 'date' : undefined}
          className={`${btn} ${thisWeek ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-emerald-600 text-white ring-emerald-600 hover:bg-emerald-700'}`}
        >
          이번 주
        </button>
        <button type="button" onClick={() => onShift(1)} className={`${btn} text-gray-700 ring-gray-200 hover:bg-gray-50 active:bg-gray-100`}>
          다음 주
          {arrow('m9 18 6-6-6-6')}
        </button>
      </div>
      <div className="text-center" aria-live="polite" aria-atomic="true">
        <p className={`text-xs font-bold ${thisWeek ? 'text-emerald-600' : rel === '지난주' || rel.endsWith('전') ? 'text-gray-500' : 'text-blue-600'}`}>{rel}</p>
        <p className="text-base font-bold text-gray-900 break-keep" data-testid="week-range">
          {rangeLabel}
        </p>
      </div>
      <div>
        <label htmlFor={inputId} className="sr-only">
          날짜 선택(그 날짜가 든 주로)
        </label>
        <input
          id={inputId}
          type="date"
          value={ymdToIso(date)}
          min="2000-01-01"
          max="2099-12-31"
          onChange={(e) => {
            const d = isoToYmd(e.target.value)
            if (d) onChange(d)
          }}
          className="h-11 w-full min-w-0 rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-800 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
        />
      </div>
    </nav>
  )
}
