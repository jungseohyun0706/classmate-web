import type { JSX } from 'react'
import Link from 'next/link'
import { slotMinutes } from '../../lib/timetable/engine'
import { formatSyncedAt, type TimetableFetchError } from '../../lib/timetable/client'
import { gradesLabel, parseScheduleCell, rowBadges, type TeacherDayView, type TeacherNotice, type TeacherRow, type TeacherTimetablePayload } from '../../lib/timetable/teacherDay'
import { teacherCourseHref } from '../../lib/timetable/teacherWeek'
import type { PeriodTime, Ymd } from '../../lib/timetable/types'
import LessonCard, { lessonTitle, shortDateKo } from './LessonCard'
import { InfoLine } from './PersonalTimetable'
import TimetableStateCard, { SyncBanner, TimetableSkeleton, type TimetableStateKind } from './TimetableStateCard'

/**
 * 교사 '내 시간표' 하루 화면 조각 — 대시보드 홈 카드(TeacherTimetable)와 내 시간표 화면(/teacher/timetable)의 '하루' 탭·
 * 주간 칸 상세가 같이 씁니다(문구·배지·링크가 한곳에서).
 * - TeacherRowCard: 하루 행 하나(LessonCard + 교사 배지·취소선·수업 상세 링크·학급·직접 등록 문구)
 * - TeacherDayBody: 하루 목록 + 상태 카드·안내 줄(주간 시간표 라벨, 쉬는 날, 옮겨 감, 접힌 직접 등록 참고)
 * - TeacherDayPanel: 불러오는 중(스켈레톤) / 오류(다시 시도 — 빈 목록으로 위장하지 않음) / 자료 + 동기화 배너
 */

export function teacherErrorKind(e: TimetableFetchError): TimetableStateKind {
  if (e.kind === 'unauthenticated') return 'login'
  if (e.kind === 'offline') return 'offline'
  return 'server'
}

/** 옮겨 감·쉬는 날 안내 문구: '영어 · B(3학년 4반) 3교시 → 10월 8일(목) 5교시로 옮겨졌어요' */
export function teacherNoticeText(n: TeacherNotice): string {
  const what = `${lessonTitle({ title: n.makeup ? `${n.title} 보강` : n.title, section: n.section })}${n.classLabel ? `(${n.classLabel})` : ''}`
  if (n.kind === 'moved-out' && n.movedTo) return `${what} ${n.original.period}교시 → ${shortDateKo(n.movedTo.date)} ${n.movedTo.period}교시로 옮겨졌어요`
  return `${what} ${n.original.period}교시`
}

/** 일부 학년 쉬는 날이라 열리지 않는 주간 시간표 칸 표시('3교시 국어(3학년 2반)') */
function cellText(c: { period: number; text: string }): string {
  const cell = parseScheduleCell(c.text)
  return `${cell.title}${cell.classLabel ? `(${cell.classLabel})` : ''} ${c.period}교시`
}

/** 하루 행 하나 — 하루 목록과 주간 칸 상세가 같은 모양 */
export function TeacherRowCard({ row, periodTimes, isNow = false }: { row: TeacherRow; periodTimes: PeriodTime[]; isNow?: boolean }): JSX.Element {
  return (
    <LessonCard
      lesson={row.lesson}
      periodTimes={periodTimes}
      compact
      isNow={isNow}
      extraBadges={rowBadges(row)}
      struck={row.kind === 'cancelled'}
      href={teacherCourseHref(row)}
      metaPrefix={row.classLabel}
      personalLabel={row.kind === 'legacy' ? '직접 등록 · 수업 변경 미반영' : undefined}
      wrapTime
    />
  )
}

/** 직접 등록 주간 시간표 라벨 — 하루 화면·주간 화면 같은 문구 */
export function LegacyScheduleNote({ text = '내가 등록한 주간 시간표예요 — 수업 변경은 반영되지 않아요' }: { text?: string }): JSX.Element {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-700 ring-1 ring-gray-200 break-keep" role="note">
      <span className="min-w-0">{text}</span>
      <Link href="/teacher/my-schedule" className="inline-flex min-h-11 items-center font-semibold text-blue-700 underline-offset-2 hover:underline">
        주간 시간표 고치기
      </Link>
    </p>
  )
}

export function TeacherDayBody({
  view,
  payload,
  today,
  nowMinutes,
  onGoToday,
}: {
  view: TeacherDayView
  payload: TeacherTimetablePayload
  today: Ymd
  nowMinutes: number | null
  onGoToday: () => void
}): JSX.Element {
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
      {view.mode === 'legacy' && view.state !== 'holiday' && view.state !== 'outside-term' && <LegacyScheduleNote />}

      {view.state === 'lessons' && view.offDayName && (
        <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900 ring-1 ring-sky-200 break-keep">
          {isToday ? '오늘은' : '이 날은'} 쉬는 날({view.offDayName})이지만 아래 일정이 있어요
        </p>
      )}

      {/* 일부 학년만 쉬는 날(예: 3학년 재량휴업일) — 학교는 열려 있어 다른 학년 수업은 그대로 */}
      {view.gradeOff && view.state !== 'outside-term' && (
        <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900 ring-1 ring-sky-200 break-keep" role="note">
          {isToday ? '오늘은' : '이 날은'} {gradesLabel(view.gradeOff.grades)} 쉬는 날이에요({view.gradeOff.name}) — 그 학년 수업은 열리지 않아요
        </p>
      )}

      {stateKind ? (
        <TimetableStateCard kind={stateKind} compact isToday={isToday} offDayName={view.offDayName} onGoToday={onGoToday} />
      ) : (
        <ol className="space-y-1.5" aria-label="내 수업 목록">
          {view.rows.map((row) => (
            <li key={row.key}>
              <TeacherRowCard row={row} periodTimes={payload.periodTimes} isNow={isNow(row)} />
            </li>
          ))}
        </ol>
      )}

      {/* 등록된 시간표가 없지만 교환·보결 등 일정이 있는 날: 등록 안내를 함께(쉬는 날·학기 밖은 그 상태 카드만) */}
      {view.mode === 'empty' && view.state === 'lessons' && <TimetableStateCard kind="teacher-empty" compact />}

      {view.movedOut.length > 0 && (
        <ul className="space-y-1.5" aria-label="옮겨 간 내 수업">
          {view.movedOut.map((n) => (
            <InfoLine key={`m|${n.key}`} tone="red" icon="move">
              <span className="font-semibold">{teacherNoticeText(n)}</span>
              {n.reason ? <span className="text-red-700/80"> · {n.reason}</span> : null}
            </InfoLine>
          ))}
        </ul>
      )}

      {(view.suppressed.length > 0 || view.suppressedCells.length > 0) && (
        <ul aria-label="쉬는 날 안내">
          <InfoLine tone="gray" icon="info">
            {view.gradeOff ? `${gradesLabel(view.gradeOff.grades)} 쉬는 날이라 열리지 않아요: ` : '쉬는 날이라 열리지 않아요: '}
            {view.suppressed.map((n) => teacherNoticeText(n)).concat(view.suppressedCells.map(cellText)).join(', ')}
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

/**
 * 하루 화면 상태: 자료가 그 날짜를 포함하지 않으면 스켈레톤(오류면 상태 카드 + 다시 시도),
 * 포함하면 (오프라인·서버 오류 배너 +) 하루 목록. 자료가 다른 기간 것이면 그리지 않음(빈 목록으로 보이지 않게)
 */
export function TeacherDayPanel({
  view,
  payload,
  today,
  nowMinutes,
  error,
  loading,
  syncedAt,
  onRetry,
  onGoToday,
  isToday,
}: {
  view: TeacherDayView | null
  payload: TeacherTimetablePayload | null
  today: Ymd | null
  nowMinutes: number | null
  error: TimetableFetchError | null
  loading: boolean
  syncedAt: number | null
  onRetry: () => void
  onGoToday: () => void
  isToday: boolean
}): JSX.Element {
  if (!view || !payload || !today) {
    return error && !loading ? (
      <TimetableStateCard kind={teacherErrorKind(error)} code={error.code} compact onRetry={onRetry} isToday={isToday} />
    ) : (
      <TimetableSkeleton rows={3} />
    )
  }
  const syncedLabel = syncedAt ? formatSyncedAt(syncedAt) : null
  return (
    <div className="space-y-3">
      {error && (error.kind === 'offline' || error.kind === 'server') && (
        <SyncBanner kind={error.kind} syncedLabel={syncedLabel} code={error.code} onRetry={onRetry} retrying={loading} />
      )}
      <TeacherDayBody view={view} payload={payload} today={today} nowMinutes={nowMinutes} onGoToday={onGoToday} />
    </div>
  )
}
