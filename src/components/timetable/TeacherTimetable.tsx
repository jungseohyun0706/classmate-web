import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import Link from 'next/link'
import { slotMinutes } from '../../lib/timetable/engine'
import { schoolYmdAt } from '../../lib/timetable/dates'
import { formatSyncedAt, type TimetableFetchError } from '../../lib/timetable/client'
import { buildTeacherDay, parseScheduleCell, rowBadges, type TeacherDayView, type TeacherNotice, type TeacherRow, type TeacherTimetablePayload } from '../../lib/timetable/teacherDay'
import { useTeacherTimetable } from '../../lib/timetable/teacherHomeClient'
import type { Ymd } from '../../lib/timetable/types'
import DayNav from './DayNav'
import LessonCard, { lessonTitle, shortDateKo } from './LessonCard'
import { InfoLine, useNowMinutes } from './PersonalTimetable'
import TimetableStateCard, { SyncBanner, TimetableSkeleton, type TimetableStateKind } from './TimetableStateCard'

/**
 * 교사 대시보드 메인 '오늘의 내 수업' — 학급 시간표 대신 선생님 본인 시간표(요구: 선생님 화면 메인 = 선생님 전용 시간표)
 * - 자료: GET /api/timetable/teacher(useTeacherTimetable) → 날짜마다 buildTeacherDay(teacherDay.ts)
 * - 공식 수업이 있으면 공식 수업(변경 전후·빨간 배지), 없으면 직접 등록 주간 시간표('수업 변경은 반영되지 않아요'), 둘 다 없으면 빈 상태
 * - 예전 교환(품앗이)·보결(SOS)을 겹쳐 표시. 쉬는 날·학기 밖·수업 없는 날은 학생 화면과 같은 상태 카드
 * - 담임 선생님은 '우리 반 시간표 보기' 작은 링크(학급 시간표는 메인 화면이 아님)
 */
export interface TeacherTimetableProps {
  uid: string
  schoolCode: string
  /** 담임 반이 있는 선생님 — '우리 반 시간표 보기' 링크 */
  homeroom: boolean
}

function errorKind(e: TimetableFetchError): TimetableStateKind {
  if (e.kind === 'unauthenticated') return 'login'
  if (e.kind === 'offline') return 'offline'
  return 'server'
}

function noticeText(n: TeacherNotice): string {
  const what = `${lessonTitle({ title: n.makeup ? `${n.title} 보강` : n.title, section: n.section })}${n.classLabel ? `(${n.classLabel})` : ''}`
  if (n.kind === 'moved-out' && n.movedTo) return `${what} ${n.original.period}교시 → ${shortDateKo(n.movedTo.date)} ${n.movedTo.period}교시로 옮겨졌어요`
  return `${what} ${n.original.period}교시`
}

function courseHref(row: TeacherRow): string | null {
  return row.courseId && row.manageable && (row.kind === 'official' || row.kind === 'cancelled') ? `/teacher/courses/${encodeURIComponent(row.courseId)}` : null
}

function DayBody({ view, payload, today, nowMinutes, onGoToday }: { view: TeacherDayView; payload: TeacherTimetablePayload; today: Ymd; nowMinutes: number | null; onGoToday: () => void }): JSX.Element {
  const isToday = view.date === today
  const isNow = (row: TeacherRow): boolean => {
    if (!isToday || nowMinutes == null) return false
    if (row.kind === 'cancelled' || row.role === 'changed-away' || row.kind === 'covered-only' || row.coveredBy.length) return false
    const m = slotMinutes(row.lesson, payload.periodTimes)
    return m.start !== null && m.end !== null && m.start <= nowMinutes && nowMinutes < m.end
  }
  const stateKind: TimetableStateKind | null =
    view.state === 'holiday' || view.state === 'outside-term' || view.state === 'no-lessons' ? view.state : view.state === 'not-registered' ? 'teacher-empty' : null

  return (
    <div className="space-y-3">
      {view.mode === 'legacy' && view.state !== 'holiday' && view.state !== 'outside-term' && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-700 ring-1 ring-gray-200 break-keep" role="note">
          <span className="min-w-0">내가 등록한 주간 시간표예요 — 수업 변경은 반영되지 않아요</span>
          <Link href="/teacher/my-schedule" className="inline-flex min-h-8 items-center font-semibold text-blue-700 underline-offset-2 hover:underline">
            주간 시간표 고치기
          </Link>
        </p>
      )}

      {view.state === 'lessons' && view.offDayName && (
        <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900 ring-1 ring-sky-200 break-keep">
          {isToday ? '오늘은' : '이 날은'} 쉬는 날({view.offDayName})이지만 아래 일정이 있어요
        </p>
      )}

      {stateKind ? (
        <TimetableStateCard kind={stateKind} compact isToday={isToday} offDayName={view.offDayName} onGoToday={onGoToday} />
      ) : (
        <ol className="space-y-1.5" aria-label="내 수업 목록">
          {view.rows.map((row) => (
            <li key={row.key}>
              <LessonCard
                lesson={row.lesson}
                periodTimes={payload.periodTimes}
                compact
                isNow={isNow(row)}
                extraBadges={rowBadges(row)}
                struck={row.kind === 'cancelled'}
                href={courseHref(row)}
                metaPrefix={row.classLabel}
                personalLabel={row.kind === 'legacy' ? '직접 등록 · 수업 변경 미반영' : undefined}
              />
            </li>
          ))}
        </ol>
      )}

      {/* 등록된 시간표가 없지만 교환·보결 등 일정이 있는 날: 등록 안내를 함께 */}
      {view.mode === 'empty' && view.state !== 'not-registered' && <TimetableStateCard kind="teacher-empty" compact />}

      {view.movedOut.length > 0 && (
        <ul className="space-y-1.5" aria-label="옮겨 간 내 수업">
          {view.movedOut.map((n) => (
            <InfoLine key={`m|${n.key}`} tone="red" icon="move">
              <span className="font-semibold">{noticeText(n)}</span>
              {n.reason ? <span className="text-red-700/80"> · {n.reason}</span> : null}
            </InfoLine>
          ))}
        </ul>
      )}

      {view.suppressed.length > 0 && (
        <ul aria-label="쉬는 날 안내">
          <InfoLine tone="gray" icon="info">
            쉬는 날이라 열리지 않아요: {view.suppressed.map((n) => noticeText(n)).join(', ')}
          </InfoLine>
        </ul>
      )}

      {(view.calendarFailed || view.incomplete) && (
        <ul className="space-y-1.5" aria-label="시간표 안내">
          {view.incomplete && (
            <InfoLine tone="gray" icon="info">
              시간표 변경 일부를 아직 받지 못해 바뀌기 전 시간표로 보여요. 잠시 후 다시 확인해 주세요.
            </InfoLine>
          )}
          {view.calendarFailed && (
            <InfoLine tone="gray" icon="info">
              쉬는 날 여부를 확인하지 못했어요
            </InfoLine>
          )}
        </ul>
      )}

      {/* 공식 수업이 기본일 때 예전 주간 시간표는 접어 둔 참고로만 */}
      {view.legacyReference.length > 0 && (
        <details className="group rounded-lg bg-gray-50 ring-1 ring-gray-200">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 px-3 text-xs font-semibold text-gray-700 [&::-webkit-details-marker]:hidden">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true">
              <path d="m9 18 6-6-6-6" />
            </svg>
            내 주간 시간표(직접 등록·참고)
          </summary>
          <div className="px-3 pb-3">
            <p className="mb-1.5 text-[11px] text-gray-500 break-keep">직접 등록한 주간 시간표예요. 수업 변경은 위 공식 시간표에만 반영돼요.</p>
            <ul className="space-y-1">
              {view.legacyReference.map((c) => {
                const cell = parseScheduleCell(c.text)
                return (
                  <li key={c.period} className="flex gap-2 text-xs text-gray-700 break-keep wrap-anywhere">
                    <span className="w-10 shrink-0 font-semibold text-gray-500">{c.period}교시</span>
                    <span className="min-w-0">
                      {cell.title}
                      {cell.classLabel ? <span className="text-gray-500"> · {cell.classLabel}</span> : null}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        </details>
      )}
    </div>
  )
}

export default function TeacherTimetable({ uid, schoolCode, homeroom }: TeacherTimetableProps): JSX.Element {
  // 오늘(학교 시간대) — 서버 렌더와 맞추려고 화면에 붙은 뒤에 정함. 자정을 넘기면 '오늘'을 보던 화면은 새 오늘로
  const [today, setToday] = useState<Ymd | null>(null)
  const [date, setDate] = useState<Ymd | null>(null)
  const todayRef = useRef<Ymd | null>(null)
  useEffect(() => {
    const tick = () => {
      const t = schoolYmdAt(Date.now())
      const prev = todayRef.current
      if (prev === t) return
      todayRef.current = t
      setToday(t)
      setDate((d) => (!d || d === prev ? t : d))
    }
    tick()
    const timer = setInterval(tick, 60000)
    return () => clearInterval(timer)
  }, [])

  const tt = useTeacherTimetable(uid, date, schoolCode)
  const nowMinutes = useNowMinutes()
  const { payload, covered, error, loading, syncedAt, retry } = tt

  const view = useMemo<TeacherDayView | null>(() => (payload && covered && date ? buildTeacherDay(payload, date) : null), [payload, covered, date])

  const isToday = !!date && date === today
  let body: JSX.Element
  if (!view || !payload || !today) {
    body =
      error && !loading ? (
        <TimetableStateCard kind={errorKind(error)} code={error.code} compact onRetry={retry} isToday={isToday} />
      ) : (
        <TimetableSkeleton rows={3} />
      )
  } else {
    const syncedLabel = syncedAt ? formatSyncedAt(syncedAt) : null
    body = (
      <div className="space-y-3">
        {error && (error.kind === 'offline' || error.kind === 'server') && (
          <SyncBanner kind={error.kind} syncedLabel={syncedLabel} code={error.code} onRetry={retry} retrying={loading} />
        )}
        <DayBody view={view} payload={payload} today={today} nowMinutes={nowMinutes} onGoToday={() => setDate(today)} />
      </div>
    )
  }

  return (
    <section aria-labelledby="teacher-today-title" className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-lg">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-gray-100 px-4 py-3 sm:px-5">
        <h2 id="teacher-today-title" className="text-lg font-bold text-gray-900 break-keep">
          {isToday || !date ? '오늘의 내 수업' : '내 수업'}
        </h2>
        {homeroom && (
          <Link
            href="/teacher/class-timetable"
            className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-blue-700 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 rounded"
          >
            우리 반 시간표 보기
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </Link>
        )}
      </div>
      <div className="space-y-3 p-4 sm:p-5">
        {date && today && <DayNav date={date} today={today} onChange={setDate} compact />}
        {body}
      </div>
    </section>
  )
}
