import { useCallback, useEffect, useId, useState, type JSX } from 'react'
import { loadClassTimetableDay, type ClassTimetableDay } from '../../lib/classTimetable'
import { classRefNowPeriod } from '../../lib/timetable/classRefPolicy'
import type { PeriodTime, Ymd } from '../../lib/timetable/types'
import { lessonTimeRange } from './LessonCard'
import { useNowMinutes } from './PersonalTimetable'

/**
 * '학급 시간표(참고) — 내 수업과 다를 수 있어요' 접힘 영역.
 * 소속 학급의 NEIS·학급 시간표(classes/{id}/info/timetable + overrides)를 그대로 보여 주는 참고 보기입니다.
 * 개인 시간표가 비었다고 이것을 개인 시간표 자리에 대신 띄우지 마세요(항상 이 라벨과 함께, 별도 영역으로).
 */
export interface ClassTimetableReferenceProps {
  schoolCode: string
  grade: string | number | null | undefined
  classNm: string | number | null | undefined
  /** 소속 학급 id(수업 그룹·승인 전 학급은 넘기지 마세요 — 승인 전에는 null로 공개 NEIS만) */
  classId: string | null | undefined
  date: Ymd
  /** 개인 시간표 자료의 그 날 쉬는 날(모르면 생략 → 학사일정 조회) */
  offDay?: { name: string } | null
  /** 교시 시각표 — 주면 교시 옆 시각과 오늘의 '지금' 교시 표시 */
  periodTimes?: PeriodTime[] | null
  /** 오늘(학교 시간대) — date가 오늘일 때만 '지금' 표시 */
  today?: Ymd | null
  /** 제어형 펼침(생략하면 자체 상태) */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  defaultOpen?: boolean
}

export const CLASS_REFERENCE_LABEL = '학급 시간표(참고) — 내 수업과 다를 수 있어요'

type LoadState = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; data: ClassTimetableDay } | { status: 'error' }
/** 조회 결과(요청 키와 함께 — 키가 지금 보고 있는 날짜·학급과 다르면 '불러오는 중'으로 봄) */
type LoadResult = { key: string; state: LoadState }

export default function ClassTimetableReference({
  schoolCode,
  grade,
  classNm,
  classId,
  date,
  offDay,
  periodTimes,
  today,
  open: openProp,
  onOpenChange,
  defaultOpen = false,
}: ClassTimetableReferenceProps): JSX.Element {
  const panelId = useId()
  const [openState, setOpenState] = useState<boolean>(defaultOpen)
  const open = openProp ?? openState
  const [result, setResult] = useState<LoadResult>({ key: '', state: { status: 'idle' } })
  const [reloadKey, setReloadKey] = useState(0)
  const hasTarget = !!schoolCode && (!!classId || (grade != null && grade !== '' && classNm != null && classNm !== ''))

  const toggle = useCallback(() => {
    const next = !open
    if (openProp === undefined) setOpenState(next)
    onOpenChange?.(next)
  }, [open, openProp, onOpenChange])

  // 펼쳤을 때만 조회(날짜가 바뀌면 다시). offDay는 렌더마다 새 객체일 수 있어 문자열 키로 비교
  const offKey = offDay === undefined ? '' : JSON.stringify(offDay)
  const reqKey = [schoolCode, grade ?? '', classNm ?? '', classId ?? '', date, offKey, reloadKey].join('|')
  useEffect(() => {
    if (!open || !hasTarget) return
    let cancelled = false
    const off = offKey ? (JSON.parse(offKey) as { name: string } | null) : undefined
    loadClassTimetableDay({ schoolCode, grade, classNm, classId: classId || null, ymd: date, offDay: off, strict: true })
      .then((data) => {
        if (!cancelled) setResult({ key: reqKey, state: { status: 'ready', data } })
      })
      .catch((e) => {
        console.warn('[timetable] 학급 시간표(참고) 조회 실패', (e as { code?: string })?.code || e)
        if (!cancelled) setResult({ key: reqKey, state: { status: 'error' } })
      })
    return () => {
      cancelled = true
    }
  }, [open, hasTarget, schoolCode, grade, classNm, classId, date, offKey, reqKey])
  const load: LoadState = result.key === reqKey ? result.state : { status: 'loading' }
  const nowMinutes = useNowMinutes()
  const nowPeriod =
    load.status === 'ready'
      ? classRefNowPeriod({
          date,
          today,
          offDay: !!load.data.offDay,
          nowMinutes,
          periods: load.data.periods.map((p) => p.period),
          periodTimes,
        })
      : null

  return (
    <section className="overflow-hidden rounded-xl border border-gray-200 bg-white">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex min-h-11 w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-gray-50"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0 text-gray-400" aria-hidden="true">
          <rect x="3" y="4" width="18" height="17" rx="2" />
          <path d="M3 10h18M9 4v17" />
        </svg>
        <span className="min-w-0 flex-1 text-sm font-semibold text-gray-700 break-keep">{CLASS_REFERENCE_LABEL}</span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div id={panelId} className="border-t border-gray-100 px-4 py-3">
          <p className="mb-2 text-[11px] text-gray-500 break-keep">
            소속 학급 전체의 시간표예요. 이동 수업·선택 과목·수업 변경은 위 &lsquo;내 시간표&rsquo;를 확인해 주세요.
          </p>
          {!hasTarget ? (
            <p className="rounded-lg bg-gray-50 px-4 py-5 text-center text-sm text-gray-500 break-keep">
              소속 학급 정보가 없어 학급 시간표를 볼 수 없어요
            </p>
          ) : load.status === 'loading' || load.status === 'idle' ? (
            <div className="animate-pulse space-y-1.5" role="status" aria-label="학급 시간표를 불러오는 중">
              <div className="h-8 rounded-lg bg-gray-100" />
              <div className="h-8 rounded-lg bg-gray-100" />
              <div className="h-8 rounded-lg bg-gray-100" />
            </div>
          ) : load.status === 'error' ? (
            <div role="alert" className="rounded-lg bg-rose-50 px-4 py-4 text-center ring-1 ring-rose-200">
              <p className="text-sm font-semibold text-rose-800 break-keep">학급 시간표를 불러오지 못했어요</p>
              <button
                type="button"
                onClick={() => setReloadKey((k) => k + 1)}
                className="mt-2 inline-flex min-h-11 items-center rounded-xl bg-white px-4 text-sm font-semibold text-rose-700 ring-1 ring-rose-200 hover:bg-rose-50"
              >
                다시 시도
              </button>
            </div>
          ) : load.data.periods.length === 0 ? (
            <p className="rounded-lg bg-gray-50 px-4 py-5 text-center text-sm text-gray-500 break-keep">
              {load.data.offDay ? `학급 시간표상 쉬는 날이에요${load.data.offDay.name ? ` (${load.data.offDay.name})` : ''}` : '이 날 학급 시간표 정보가 없어요'}
            </p>
          ) : (
            <ol className="space-y-1" aria-label="학급 시간표(참고)">
              {load.data.periods.map((p) => {
                const time = periodTimes ? lessonTimeRange({ period: p.period }, periodTimes) : null
                const isNow = p.period === nowPeriod
                return (
                  <li
                    key={p.period}
                    aria-current={isNow ? 'time' : undefined}
                    className={`flex items-center gap-3 rounded-lg px-3 py-2 ${isNow ? 'bg-emerald-50 ring-1 ring-emerald-300' : 'bg-gray-50'}`}
                  >
                    <span className="w-16 shrink-0">
                      <span className="block text-xs font-bold text-gray-500">{p.period}교시</span>
                      {time && <span className="block text-[10px] leading-tight text-gray-400">{time}</span>}
                    </span>
                    <span className="min-w-0 flex-1 text-sm text-gray-700 break-keep wrap-anywhere">{p.subject}</span>
                    {p.changed && (
                      <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 ring-1 ring-amber-200">
                        학급 변경
                      </span>
                    )}
                    {isNow && (
                      <span className="shrink-0 rounded-full bg-emerald-600 px-2 py-0.5 text-[11px] font-semibold text-white">지금</span>
                    )}
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      )}
    </section>
  )
}
