import { useCallback, useEffect, useId, useRef, useState, type JSX } from 'react'
import { classRefNowPeriod } from '../../lib/timetable/classRefPolicy'
import { formatYmdKo } from '../../lib/timetable/dates'
import { lessonTimeRange } from '../../lib/timetable/lessonText'
import {
  compactClassLabel,
  weekCellKey,
  weekCellLabel,
  type TeacherWeekColumn,
  type TeacherWeekItem,
  type TeacherWeekModel,
} from '../../lib/timetable/teacherWeek'
import type { PeriodTime, Ymd } from '../../lib/timetable/types'
import { InfoLine } from './PersonalTimetable'
import { TeacherRowCard, teacherNoticeText } from './TeacherDayBody'

/**
 * 교사 주간 시간표 표(요일 열 × 교시 행) + 칸 상세 시트
 * - 표 의미: <table>(열 머리 = 요일·날짜, 행 머리 = 교시). 칸 버튼 이름은 '화 3교시 영어 B 3학년 5반 시청각실 (교실 변경)'
 * - 390px: 월~금 5열은 화면 안에 들어가고, 토·일 열이 붙으면 이 상자 안에서만 옆으로 밀림(교시 열 고정) — 화면은 옆으로 밀리지 않음
 * - 변경 표시는 하루 보기·학생 화면과 같은 기준: 빨간 테두리·배지(변경·대신·보강·→○○·보결/품앗이·옮겨 감), 취소는 취소선,
 *   직접 등록 칸은 회색 점선, 쉬는 날이라 열리지 않는 수업은 회색
 * - 칸을 누르면 상세 시트(하루 보기와 같은 수업 카드 — 공식 수업은 수업 상세 링크) + '이 날 전체 보기'
 * - 오늘 열 강조, 이번 주를 볼 때 지금 교시 표시
 * - 화면은 주마다 key(model.start)로 새로 그려 다른 주로 넘어가면 열린 시트가 닫힘
 */

/** 칸 최소 폭(px): 390px 화면(표 상자 약 332px)에 월~토 6열 + 교시 열 + 칸 사이(2px)까지 들어가는 값(44px 이상 — 누르기 쉬움). 7열이면 상자 안에서 밀림 */
const COL_MIN_PX = 48
const PERIOD_COL_PX = 28
const SPACING_PX = 2

function chipFrame(it: TeacherWeekItem): string {
  if (it.red) return `border border-red-300 bg-red-50 ${it.kind === 'moved-out' ? 'border-dashed' : ''}`
  if (it.muted) return 'border border-gray-200 bg-gray-100'
  if (it.legacy) return 'border border-dashed border-gray-300 bg-gray-50'
  return 'border border-gray-200 bg-white'
}

const BADGE_TONE: Record<'red' | 'gray' | 'sky', string> = {
  red: 'bg-red-100 text-red-700',
  gray: 'bg-gray-200 text-gray-600',
  sky: 'bg-sky-100 text-sky-800',
}

/** 칸 안 수업 하나(좁은 칸 — 제목 두 줄, 학급·교실 한 줄, 배지 두 개까지. 전체 문구는 title·칸 이름·상세 시트) */
function ItemChip({ item, periodTimes }: { item: TeacherWeekItem; periodTimes: PeriodTime[] }): JSX.Element {
  const time = item.period == null && item.row ? lessonTimeRange(item.row.lesson, periodTimes) : null
  const meta = [time, compactClassLabel(item.classLabel), item.roomName].filter(Boolean).join(' · ')
  return (
    <span title={item.label} data-kind={item.kind} className={`block w-full min-w-0 rounded px-1 py-0.5 ${chipFrame(item)}`}>
      <span
        className={`line-clamp-2 text-[11px] font-semibold leading-tight break-keep wrap-anywhere ${
          item.struck ? 'text-gray-500 line-through' : item.muted ? 'text-gray-500' : item.red ? 'text-red-800' : 'text-gray-900'
        }`}
      >
        {item.title}
      </span>
      {meta && <span className="block truncate text-[10px] leading-tight text-gray-600">{meta}</span>}
      {item.note && <span className="block text-[10px] font-semibold leading-tight text-red-700 break-keep">{item.note}</span>}
      {item.badges.length > 0 && (
        <span className="mt-0.5 flex min-w-0 flex-wrap gap-0.5">
          {item.badges.slice(0, 2).map((b) => (
            <span key={b.label} data-badge={b.tone} className={`max-w-full truncate rounded px-0.5 text-[10px] font-bold leading-4 ${BADGE_TONE[b.tone]}`}>
              {b.label}
            </span>
          ))}
        </span>
      )}
    </span>
  )
}

interface SheetTarget {
  col: TeacherWeekColumn
  period: number | null
  items: TeacherWeekItem[]
}

/** 칸 상세 시트(모달) — Esc·바깥 누르기·닫기로 닫고, 연 칸으로 초점을 돌려줌 */
function CellSheet({
  target,
  periodTimes,
  onClose,
  onOpenDay,
}: {
  target: SheetTarget
  periodTimes: PeriodTime[]
  onClose: () => void
  onOpenDay: (date: Ymd) => void
}): JSX.Element {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])
  const { col, period, items } = target
  const when = period == null ? '교시 밖' : `${period}교시`
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white px-4 pt-3 shadow-xl sm:rounded-2xl"
        style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom, 0px))' }}
      >
        <div className="flex items-center justify-between gap-2">
          <h2 id={titleId} className="min-w-0 text-base font-bold text-gray-900 break-keep">
            {formatYmdKo(col.date)} {when}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-gray-600 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            aria-label="닫기"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        {col.legacyTag && <p className="mb-2 text-xs text-gray-600 break-keep">이 날은 내가 등록한 주간 시간표예요 — 수업 변경은 반영되지 않아요</p>}
        <ul className="mt-1 space-y-1.5" aria-label={`${col.dayLabel} ${when} 수업`}>
          {items.map((it) =>
            it.row ? (
              <li key={it.key}>
                <TeacherRowCard row={it.row} periodTimes={periodTimes} />
              </li>
            ) : it.kind === 'moved-out' && it.notice ? (
              <InfoLine key={it.key} tone="red" icon="move">
                <span className="font-semibold">{teacherNoticeText(it.notice)}</span>
                {it.notice.reason ? <span className="text-red-700/80"> · {it.notice.reason}</span> : null}
              </InfoLine>
            ) : (
              <InfoLine key={it.key} tone="gray" icon="info">
                쉬는 날이라 열리지 않아요: {it.notice ? teacherNoticeText(it.notice) : `${it.title}${it.classLabel ? `(${it.classLabel})` : ''} ${it.period ?? ''}교시`}
              </InfoLine>
            )
          )}
        </ul>
        <button
          type="button"
          onClick={() => onOpenDay(col.date)}
          className="mt-3 flex min-h-11 w-full items-center justify-center rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
        >
          이 날 전체 보기
        </button>
      </div>
    </div>
  )
}

export interface TeacherWeekGridProps {
  model: TeacherWeekModel
  periodTimes: PeriodTime[]
  today: Ymd
  nowMinutes: number | null
  /** 열 머리·상세 '이 날 전체 보기' → 하루 보기 */
  onOpenDay: (date: Ymd) => void
}

export default function TeacherWeekGrid({ model, periodTimes, today, nowMinutes, onOpenDay }: TeacherWeekGridProps): JSX.Element {
  const [sheet, setSheet] = useState<SheetTarget | null>(null)
  const openerRef = useRef<HTMLButtonElement | null>(null)
  const closeSheet = useCallback(() => {
    setSheet(null)
    const el = openerRef.current
    if (el && el.isConnected) el.focus()
  }, [])
  const todayCol = model.columns.find((c) => c.date === today && !c.closed) ?? null
  const nowPeriod = todayCol
    ? classRefNowPeriod({ date: today, today, offDay: false, nowMinutes, periods: model.periods, periodTimes })
    : null
  const rowSpan = model.periods.length + (model.hasOutside ? 1 : 0)
  const minWidth = PERIOD_COL_PX + model.columns.length * COL_MIN_PX + (model.columns.length + 2) * SPACING_PX

  const open = (e: { currentTarget: HTMLButtonElement }, target: SheetTarget) => {
    openerRef.current = e.currentTarget
    setSheet(target)
  }

  const cell = (col: TeacherWeekColumn, period: number | null, items: TeacherWeekItem[]): JSX.Element => {
    const isToday = col.date === today
    const isNow = isToday && period != null && period === nowPeriod
    if (!items.length) {
      return (
        <td key={col.date} className="p-0 align-top">
          <span aria-hidden="true" className={`block h-full min-h-12 rounded-md ${isToday ? 'bg-emerald-50' : 'bg-gray-50'} ${isNow ? 'ring-2 ring-emerald-400' : ''}`} />
        </td>
      )
    }
    return (
      <td key={col.date} className="p-0 align-top">
        <button
          type="button"
          onClick={(e) => open(e, { col, period, items })}
          aria-haspopup="dialog"
          aria-label={weekCellLabel(col, period, items)}
          data-cell={period == null ? `${col.date}|out` : weekCellKey(col.date, period)}
          className={`flex min-h-12 w-full min-w-0 flex-col gap-0.5 rounded-md p-0.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
            isToday ? 'bg-emerald-50 hover:bg-emerald-100' : 'hover:bg-gray-50'
          } ${isNow ? 'ring-2 ring-emerald-400' : ''}`}
        >
          {items.map((it) => (
            <ItemChip key={it.key} item={it} periodTimes={periodTimes} />
          ))}
        </button>
      </td>
    )
  }

  return (
    <>
      {/* 표가 상자보다 넓으면(토·일 열) 이 상자 안에서만 옆으로 밀림 — 교시 열은 고정 */}
      <div className="-mx-1 overflow-x-auto overscroll-x-contain px-1 pb-1" data-testid="teacher-week-scroll">
        <table className="w-full table-fixed border-separate border-spacing-0.5" style={{ minWidth: `${minWidth}px` }}>
          <caption className="sr-only">주간 내 시간표 — 요일별 교시 칸. 칸을 누르면 자세히 볼 수 있어요</caption>
          <colgroup>
            <col style={{ width: `${PERIOD_COL_PX}px` }} />
            {model.columns.map((c) => (
              <col key={c.date} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 z-[1] bg-white">
                <span className="sr-only">교시</span>
              </th>
              {model.columns.map((c) => {
                const isToday = c.date === today
                return (
                  <th key={c.date} scope="col" aria-current={isToday ? 'date' : undefined} className={`rounded-md p-0 align-top font-normal ${isToday ? 'bg-emerald-50' : ''}`}>
                    <button
                      type="button"
                      onClick={() => onOpenDay(c.date)}
                      title={`${formatYmdKo(c.date)} 하루 보기`}
                      className={`flex min-h-11 w-full flex-col items-center justify-center rounded-md px-0.5 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                        isToday ? 'text-emerald-700 hover:bg-emerald-100' : 'text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      <span className="text-xs font-bold leading-tight">{c.dayLabel}</span>
                      <span className="text-[10px] leading-tight">{c.dateLabel}</span>
                      {isToday && <span className="mt-0.5 rounded-full bg-emerald-600 px-1.5 text-[10px] font-semibold leading-4 text-white">오늘</span>}
                    </button>
                    {(c.legacyTag || c.offDayName || c.gradeOffShort) && (
                      <span className="flex flex-col items-center gap-0.5 px-0.5 pb-1">
                        {c.legacyTag && (
                          <span className="max-w-full truncate rounded bg-gray-100 px-1 text-[10px] font-semibold leading-4 text-gray-600 ring-1 ring-gray-300" title="내가 등록한 주간 시간표 — 수업 변경 미반영">
                            직접 등록
                          </span>
                        )}
                        {c.offDayName && (
                          <span className="max-w-full truncate rounded bg-sky-100 px-1 text-[10px] font-semibold leading-4 text-sky-800" title={`쉬는 날(${c.offDayName})이지만 일정이 있어요`}>
                            {c.offDayName}
                          </span>
                        )}
                        {c.gradeOffShort && (
                          <span className="max-w-full truncate rounded bg-sky-100 px-1 text-[10px] font-semibold leading-4 text-sky-800" title={`${c.gradeOffNote ?? ''} — 그 학년 수업은 열리지 않아요`}>
                            {c.gradeOffShort}
                          </span>
                        )}
                      </span>
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {model.periods.map((p, i) => (
              <tr key={p}>
                <th scope="row" className={`sticky left-0 z-[1] bg-white text-center text-xs font-semibold ${p === nowPeriod ? 'text-emerald-700' : 'text-gray-500'}`}>
                  {p}
                  <span className="sr-only">교시{p === nowPeriod ? ' (지금)' : ''}</span>
                  {p === nowPeriod && <span aria-hidden="true" className="mx-auto mt-0.5 block h-1.5 w-1.5 rounded-full bg-emerald-500" />}
                </th>
                {model.columns.map((c) => {
                  if (c.closed) {
                    if (i !== 0) return null
                    return (
                      <td key={c.date} rowSpan={rowSpan} className="rounded-md bg-gray-100 px-0.5 py-3 text-center align-top">
                        <span className="block text-[11px] font-semibold text-gray-700 break-keep">{c.closed === 'holiday' ? '쉬는 날' : '학기 밖'}</span>
                        {c.closed === 'holiday' && c.view.offDayName && (
                          <span className="mt-0.5 block text-[10px] leading-tight text-gray-500 break-keep wrap-anywhere">{c.view.offDayName}</span>
                        )}
                      </td>
                    )
                  }
                  return cell(c, p, model.cells[weekCellKey(c.date, p)] ?? [])
                })}
              </tr>
            ))}
            {model.hasOutside && (
              <tr>
                <th scope="row" className="sticky left-0 z-[1] bg-white text-center text-[10px] font-semibold leading-tight text-gray-500 break-keep">
                  교시 밖
                </th>
                {model.columns.map((c) => (c.closed ? null : cell(c, null, model.outside[c.date] ?? [])))}
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {model.columns.some((c) => c.gradeOffNote) && (
        <ul className="space-y-1.5" aria-label="일부 학년 쉬는 날">
          {model.columns
            .filter((c) => c.gradeOffNote)
            .map((c) => (
              <InfoLine key={c.date} tone="sky" icon="info">
                <span className="font-semibold">
                  {c.dayLabel} {c.dateLabel}
                </span>{' '}
                {c.gradeOffNote} — 그 학년 수업은 열리지 않아요
              </InfoLine>
            ))}
        </ul>
      )}
      {sheet && <CellSheet target={sheet} periodTimes={periodTimes} onClose={closeSheet} onOpenDay={onOpenDay} />}
    </>
  )
}
