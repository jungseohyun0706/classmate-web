import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import DayNav from '../../components/timetable/DayNav'
import { useNowMinutes } from '../../components/timetable/PersonalTimetable'
import { LegacyScheduleNote, TeacherDayPanel, teacherErrorKind } from '../../components/timetable/TeacherDayBody'
import TeacherWeekGrid from '../../components/timetable/TeacherWeekGrid'
import TimetableStateCard, { SyncBanner, TimetableSkeleton } from '../../components/timetable/TimetableStateCard'
import WeekNav from '../../components/timetable/WeekNav'
import { formatSyncedAt } from '../../lib/timetable/client'
import { addDays, formatYmdKo, isYmd, schoolYmdAt } from '../../lib/timetable/dates'
import { errorText, useTeacherProfile } from '../../lib/timetable/teacherClient'
import { buildTeacherDay } from '../../lib/timetable/teacherDay'
import { useTeacherTimetable } from '../../lib/timetable/teacherHomeClient'
import { buildTeacherWeek, shiftWeek, weekModelRangeLabel, weekRangeLabel, weekStartOf, WEEK_WINDOW_POLICY } from '../../lib/timetable/teacherWeek'
import type { Ymd } from '../../lib/timetable/types'

/**
 * 교사 '내 시간표' 화면 — /teacher/timetable?view=week|day&date=YYYYMMDD (기본: 주간, 오늘)
 * 요구(선생님 화면에서 내 시간표를 누르면 오늘 시간표 말고 주간 시간표도): 대시보드 '오늘의 내 수업' 제목·'주간 시간표 →'와
 * 대시보드 카드 '내 시간표 (주간)'에서 들어옴. 아키텍처 10절.
 * - 주간: 그 주(월~일) 요일 × 교시 표(TeacherWeekGrid, 순수 모델 buildTeacherWeek). 하루: 홈 카드와 같은 하루 화면(TeacherDayPanel)
 * - 자료: 홈 카드와 같은 GET /api/timetable/teacher를 그 주 7일로(WEEK_WINDOW_POLICY) — 시간표 버전 구독·화면 복귀 때 다시 받기도 같음.
 *   두 탭이 같은 자료라 탭을 바꿔도 다시 받지 않음. 주를 빨리 넘겨도 마지막 주 응답만 씀(이전 요청 응답은 버림)
 * - 주소 바꾸기는 비동기라, 반영 전에 또 누르면(다음 주 두 번·다음 주 뒤 바로 '하루') 아직 반영 안 된 목적지에서 이어 계산(pendingRef)
 * - 학생 계정은 학생 홈으로, 교사가 아니면 대시보드로(useTeacherProfile — 다른 교사 화면과 같음)
 * - '오늘'은 화면에 붙은 뒤 정함(서버 렌더와 맞춤 — 하이드레이션 안전)
 */

type View = 'week' | 'day'
interface QueryTarget {
  view: View
  date: Ymd
}
const viewOfQuery = (q: { view?: string | string[] }): View => (q.view === 'day' ? 'day' : 'week')
const dateOfQuery = (q: { date?: string | string[] }): Ymd | null => (typeof q.date === 'string' && isYmd(q.date) ? q.date : null)
const TABS: Array<{ key: View; label: string }> = [
  { key: 'week', label: '주간' },
  { key: 'day', label: '하루' },
]

export default function TeacherTimetablePage(): JSX.Element {
  const router = useRouter()
  const { profile, loading: profileLoading, error: profileError, retry: retryProfile } = useTeacherProfile()

  // 오늘(학교 시간대) — 화면에 붙은 뒤에 정하고 1분마다·화면 복귀 때 확인(자정 경계)
  const [today, setToday] = useState<Ymd | null>(null)
  useEffect(() => {
    const check = (): void => setToday(schoolYmdAt(Date.now()))
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') check()
    }
    check()
    const t = setInterval(check, 60000)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const view: View = viewOfQuery(router.query)
  const queryDate = dateOfQuery(router.query)
  const date: Ymd | null = router.isReady && today ? (queryDate ?? today) : null

  const tt = useTeacherTimetable(profile?.uid ?? null, date, profile?.schoolCode ?? null, WEEK_WINDOW_POLICY)
  const nowMinutes = useNowMinutes()
  const { payload, covered, error, loading, syncedAt, retry } = tt

  const week = useMemo(() => (payload && covered && date ? buildTeacherWeek(payload, date) : null), [payload, covered, date])
  const dayView = useMemo(() => (payload && covered && date ? buildTeacherDay(payload, date) : null), [payload, covered, date])

  // 주소(?view&date)로 상태를 둠 — 뒤로 가기·새로 고침·공유 링크가 같은 화면
  // routerRef는 레이아웃 효과로 갱신: Next는 화면 반영(커밋) 뒤에 replace를 끝내므로, 끝난 뒤의 클릭은 늘 새 주소를 읽음
  const routerRef = useRef(router)
  useLayoutEffect(() => {
    routerRef.current = router
  }, [router])
  // 아직 주소에 반영되지 않은 마지막 목적지 — 그동안의 클릭은 여기서 이어 계산(다음 주 두 번 = 2주 뒤, 다음 주 → '하루' = 그 주의 하루)
  const pendingRef = useRef<QueryTarget | null>(null)
  const setQuery = useCallback(
    (next: { view?: View; date?: Ymd }) => {
      const r = routerRef.current
      const base: QueryTarget | null = pendingRef.current ?? (today ? { view: viewOfQuery(r.query), date: dateOfQuery(r.query) ?? today } : null)
      if (!base) return
      const target: QueryTarget = { view: next.view ?? base.view, date: next.date ?? base.date }
      pendingRef.current = target
      const settle = (): void => {
        if (pendingRef.current === target) pendingRef.current = null
      }
      r.replace({ pathname: '/teacher/timetable', query: { view: target.view, date: target.date } }, undefined, { shallow: true, scroll: false }).then(settle, settle)
    },
    [today]
  )
  const openDay = useCallback((d: Ymd) => setQuery({ view: 'day', date: d }), [setQuery])
  const shiftBy = useCallback(
    (n: number) => {
      const base = pendingRef.current?.date ?? date
      if (base) setQuery({ date: shiftWeek(base, n) })
    },
    [date, setQuery]
  )

  const tabRefs = useRef<Record<View, HTMLButtonElement | null>>({ week: null, day: null })
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const cur = pendingRef.current?.view ?? view
    const next: View = e.key === 'Home' ? 'week' : e.key === 'End' ? 'day' : cur === 'week' ? 'day' : 'week'
    setQuery({ view: next })
    tabRefs.current[next]?.focus()
  }

  if (profileError) {
    return (
      <div className="min-h-screen bg-gray-50 px-4 py-10 text-black">
        <div role="alert" className="mx-auto max-w-md rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 break-keep">
          <p className="font-bold">내 정보를 불러오지 못했어요</p>
          <p className="mt-1">{errorText(profileError)}</p>
          {profileError.retryable && (
            <button type="button" onClick={retryProfile} className="mt-2 min-h-[44px] rounded-lg border border-red-200 bg-white px-4 font-bold text-red-700 hover:bg-red-100">
              다시 시도
            </button>
          )}
        </div>
      </div>
    )
  }
  if (profileLoading || !profile || !date || !today) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-blue-600" aria-label="불러오는 중" />
      </div>
    )
  }

  const isToday = date === today
  const syncedLabel = syncedAt ? formatSyncedAt(syncedAt) : null
  // 기간 라벨: 자료 전에는 그 주 월~금
  const rangeLabel = week ? weekModelRangeLabel(week) : weekRangeLabel(weekStartOf(date), addDays(weekStartOf(date), 4))

  let weekBody: JSX.Element
  if (!week || !payload) {
    // 자료가 그 주를 포함하지 않음: 오류면 상태 카드(다시 시도) — 빈 표로 보이지 않게, 아니면 불러오는 중
    weekBody =
      error && !loading ? (
        <TimetableStateCard kind={teacherErrorKind(error)} code={error.code} compact onRetry={retry} />
      ) : (
        <TimetableSkeleton rows={4} />
      )
  } else {
    weekBody = (
      <div className="space-y-3">
        {error && (error.kind === 'offline' || error.kind === 'server') && (
          <SyncBanner kind={error.kind} syncedLabel={syncedLabel} code={error.code} onRetry={retry} retrying={loading} />
        )}
        {week.mode === 'legacy' && <LegacyScheduleNote />}
        {week.mode === 'mixed' && <LegacyScheduleNote text="'직접 등록' 표시가 있는 날은 내가 등록한 주간 시간표예요 — 수업 변경은 반영되지 않아요" />}
        {week.state === 'empty' ? (
          <TimetableStateCard kind="teacher-empty" compact />
        ) : (
          <TeacherWeekGrid key={week.start} model={week} periodTimes={payload.periodTimes} today={today} nowMinutes={nowMinutes} onOpenDay={openDay} />
        )}
        {/* 시간표는 있는데 이 주 열린 날에 수업이 없음(시험 주·다음 주부터 시작 등) — 빈 칸만 있는 표로 두지 않음(하루 보기 '이 날은 수업이 없어요'와 같은 뜻) */}
        {week.noLessons && (
          <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600 ring-1 ring-gray-200 break-keep" role="note">
            이 주에는 내 수업이 없어요
          </p>
        )}
        {/* 등록된 시간표는 없지만 교환·보결 등 일정이 있는 주: 등록 안내를 함께 */}
        {week.state === 'grid' && week.mode === 'empty' && week.itemCount > 0 && <TimetableStateCard kind="teacher-empty" compact />}
        {(week.incomplete || week.calendarFailed.length > 0) && (
          <ul className="space-y-1.5" aria-label="시간표 안내">
            {week.incomplete && (
              <li className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600 ring-1 ring-gray-200 break-keep">
                시간표 변경 일부를 아직 받지 못해 바뀌기 전 시간표로 보이는 날이 있어요. 잠시 후 다시 확인해 주세요.
              </li>
            )}
            {week.calendarFailed.length > 0 && (
              <li className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600 ring-1 ring-gray-200 break-keep">
                쉬는 날 여부를 확인하지 못한 날이 있어요({week.calendarFailed.map((d) => formatYmdKo(d)).join(', ')})
              </li>
            )}
          </ul>
        )}
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 text-black">
      <header className="sticky top-0 z-40 border-b border-gray-200 bg-white">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-1 px-2">
          <Link
            href="/dashboard"
            aria-label="대시보드로"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-gray-600 transition-colors hover:bg-gray-100"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden="true">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </Link>
          <h1 className="min-w-0 flex-1 truncate text-lg font-bold text-gray-900">내 시간표</h1>
          {profile.homeroomId && (
            <Link href="/teacher/class-timetable" className="inline-flex min-h-11 shrink-0 items-center rounded-xl px-3 text-sm font-semibold text-blue-700 transition-colors hover:bg-blue-50">
              우리 반 시간표 보기
            </Link>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-4" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 2rem)' }}>
        <div role="tablist" aria-label="보기" className="grid grid-cols-2 gap-1 rounded-xl bg-gray-100 p-1">
          {TABS.map((t) => {
            const selected = view === t.key
            return (
              <button
                key={t.key}
                ref={(el) => {
                  tabRefs.current[t.key] = el
                }}
                type="button"
                role="tab"
                id={`tt-tab-${t.key}`}
                aria-selected={selected}
                aria-controls="tt-panel"
                tabIndex={selected ? 0 : -1}
                onClick={() => setQuery({ view: t.key })}
                onKeyDown={onTabKey}
                className={`min-h-11 rounded-lg text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                  selected ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {t.label}
              </button>
            )
          })}
        </div>

        <section id="tt-panel" role="tabpanel" aria-labelledby={`tt-tab-${view}`} className="space-y-4 rounded-xl border border-gray-100 bg-white p-3 shadow-lg sm:p-5">
          {view === 'week' ? (
            <>
              <WeekNav date={date} today={today} rangeLabel={rangeLabel} onChange={(d) => setQuery({ date: d })} onShift={shiftBy} />
              {weekBody}
            </>
          ) : (
            <>
              <DayNav date={date} today={today} onChange={(d) => setQuery({ date: d })} compact />
              <TeacherDayPanel
                view={dayView}
                payload={payload}
                today={today}
                nowMinutes={nowMinutes}
                error={error}
                loading={loading}
                syncedAt={syncedAt}
                onRetry={retry}
                onGoToday={() => setQuery({ date: today })}
                isToday={isToday}
              />
            </>
          )}
        </section>

        <nav aria-label="관련 화면" className="grid gap-2 sm:grid-cols-2">
          <Link
            href="/teacher/courses"
            className="flex min-h-11 items-center justify-between rounded-xl bg-white px-4 py-3 text-sm font-semibold text-gray-800 ring-1 ring-gray-200 transition-colors hover:bg-blue-50"
          >
            <span className="break-keep">수업 관리</span>
            <span aria-hidden="true" className="text-blue-600">
              &rarr;
            </span>
          </Link>
          <Link
            href="/teacher/my-schedule"
            className="flex min-h-11 items-center justify-between rounded-xl bg-white px-4 py-3 text-sm font-semibold text-gray-800 ring-1 ring-gray-200 transition-colors hover:bg-blue-50"
          >
            <span className="break-keep">내 수업 및 교환(직접 등록 주간 시간표)</span>
            <span aria-hidden="true" className="text-blue-600">
              &rarr;
            </span>
          </Link>
        </nav>
      </main>
    </div>
  )
}
