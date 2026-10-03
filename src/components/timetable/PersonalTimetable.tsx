import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react'
import { buildDayTimetable, slotMinutes } from '../../lib/timetable/engine'
import { hmToMinutes, schoolHmAt } from '../../lib/timetable/dates'
import { displayDayState } from '../../lib/timetable/classRefPolicy'
import {
  calendarFailedOn,
  dayInput,
  formatSyncedAt,
  type MyTimetableHook,
  type MyTimetablePayload,
} from '../../lib/timetable/client'
import type { DayTimetable, LessonView, NoticeView, PersonalEntry, Ymd } from '../../lib/timetable/types'
import LessonCard, { lessonTitle, shortDateKo } from './LessonCard'
import TimetableStateCard, { stateKindForDay, stateKindForError, SyncBanner, TimetableSkeleton } from './TimetableStateCard'

/**
 * 개인 시간표(엔진 결과) 렌더 — 화면에서 직접 조합하지 않고 buildDayTimetable 결과만 보여 줍니다.
 * - lessons: 수업 카드 목록
 * - notices: 취소·옮겨 감·휴일 안내 — 수업 목록과 분리된 안내 줄
 * - conflicts: 노란 경고 줄('2교시에 수업 두 개가 겹쳐요')
 * - pendingCourseIds: '○○ 수업 승인을 기다리고 있어요'
 * - coursesWithoutSchedule(일부만): '일부 수업 시간표가 아직 없어요'
 * - calendarErrors: '쉬는 날 여부를 확인하지 못했어요' 작은 안내
 * compact = 홈 카드, full = 시간표 화면
 */
export interface PersonalTimetableProps {
  day: DayTimetable
  payload: MyTimetablePayload
  mode: 'compact' | 'full'
  today: Ymd
  /** 지금 시각(분, 학교 시간대) — 오늘 진행 중 수업 표시용 */
  nowMinutes?: number | null
  /** 직접 입력 일정을 불러오지 못함(오류 code) */
  personalError?: string | null
  onGoToday?: () => void
  /** '학급 시간표(참고)' 펼치기 — 볼 수 없으면 생략(볼 수 있는지는 화면이 classRefTarget으로 판단) */
  onShowClassReference?: (() => void) | null
  /** 담임 학급 신청 승인 대기 — 수업 없음 카드에 초대 코드 대신 승인 대기 안내 */
  awaitingHomeroom?: boolean
}

function courseTitle(payload: MyTimetablePayload, courseId: string): string {
  const c = payload.courses.find((x) => x.courseId === courseId)
  return c ? lessonTitle(c) : '신청한'
}

function conflictText(a: LessonView | undefined, b: LessonView | undefined, kind: 'official' | 'personal', periodTimes: MyTimetablePayload['periodTimes']): string {
  // 교시가 있는 쪽(공식 수업)의 교시로, 둘 다 교시가 없으면 시작 시각으로
  const withPeriod = [a, b].find((l) => l?.period != null)
  const where = withPeriod
    ? `${withPeriod.period}교시에`
    : (() => {
        const m = a ? slotMinutes(a, periodTimes) : { start: null }
        if (m.start !== null) return `${String(Math.floor(m.start / 60)).padStart(2, '0')}:${String(m.start % 60).padStart(2, '0')}에`
        return '같은 시간에'
      })()
  if (kind === 'official') return `${where} 수업 두 개가 겹쳐요`
  const bothPersonal = a?.source === 'personal' && b?.source === 'personal'
  return bothPersonal ? `${where} 직접 입력한 일정 두 개가 겹쳐요` : `${where} 직접 입력한 일정과 수업이 겹쳐요`
}

function noticeText(n: NoticeView): string {
  const p = n.original.period
  const what = n.makeup ? `${n.title} 보강` : n.title
  if (n.kind === 'cancelled') return `${what} ${p}교시 취소`
  if (n.kind === 'moved-out' && n.movedTo) {
    const sameDay = n.movedTo.date === n.original.date
    return sameDay ? `${what} ${p}교시 → ${n.movedTo.period}교시로 옮겨졌어요` : `${what} → ${shortDateKo(n.movedTo.date)} ${n.movedTo.period}교시로 옮겨졌어요`
  }
  return `${what} ${p}교시`
}

function InfoLine({ tone, icon, children }: { tone: 'amber' | 'red' | 'gray' | 'sky'; icon: 'warn' | 'info' | 'clock' | 'move' | 'x'; children: ReactNode }): JSX.Element {
  const cls = {
    amber: 'bg-amber-50 text-amber-900 ring-amber-200',
    red: 'bg-red-50 text-red-800 ring-red-200',
    gray: 'bg-gray-50 text-gray-600 ring-gray-200',
    sky: 'bg-sky-50 text-sky-900 ring-sky-200',
  }[tone]
  const path = {
    warn: (
      <>
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        <path d="M12 9v4M12 17h.01" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5M12 8h.01" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 3" />
      </>
    ),
    move: <path d="M5 12h14M13 6l6 6-6 6" />,
    x: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="m15 9-6 6M9 9l6 6" />
      </>
    ),
  }[icon]
  return (
    <li className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs ring-1 ${cls}`}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true">
        {path}
      </svg>
      <span className="min-w-0 flex-1 break-keep wrap-anywhere">{children}</span>
    </li>
  )
}

export default function PersonalTimetable({
  day,
  payload,
  mode,
  today,
  nowMinutes,
  personalError,
  onGoToday,
  onShowClassReference,
  awaitingHomeroom,
}: PersonalTimetableProps): JSX.Element {
  const compact = mode === 'compact'
  const isToday = day.date === today
  const byKey = new Map(day.lessons.map((l) => [l.key, l]))
  const conflictKeys = new Set<string>()
  const conflictLines: string[] = []
  day.conflicts.forEach((c) => {
    conflictKeys.add(c.keys[0])
    conflictKeys.add(c.keys[1])
    const t = conflictText(byKey.get(c.keys[0]), byKey.get(c.keys[1]), c.kind, payload.periodTimes)
    if (!conflictLines.includes(t)) conflictLines.push(t)
  })

  const cancelled = day.notices.filter((n) => n.kind === 'cancelled' || n.kind === 'moved-out')
  const suppressed = day.notices.filter((n) => n.kind === 'holiday-suppressed')
  const pendingTitles = day.pendingCourseIds.map((id) => courseTitle(payload, id))
  const partial =
    (day.state === 'lessons' || day.state === 'no-lessons') &&
    day.coursesWithoutSchedule.length > 0 &&
    day.coursesWithoutSchedule.length < day.activeCourseIds.length
  const partialTitles = partial ? day.coursesWithoutSchedule.map((id) => courseTitle(payload, id)) : []
  const calendarFailed = calendarFailedOn(payload, day.date)
  // 공식 수업 없이 직접 입력만 있는 학생의 빈 날은 '수업 없음(정상)'이 아니라 '연결된 수업 없음'으로
  const stateKind = stateKindForDay(displayDayState(day))

  const isNow = (l: LessonView): boolean => {
    if (!isToday || nowMinutes == null) return false
    const m = slotMinutes(l, payload.periodTimes)
    return m.start !== null && m.end !== null && m.start <= nowMinutes && nowMinutes < m.end
  }

  return (
    <div className="space-y-3">
      {/* 쉬는 날인데 보강·이동한 수업이 있는 날 */}
      {day.state === 'lessons' && day.offDayName && (
        <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900 ring-1 ring-sky-200 break-keep">
          {isToday ? '오늘은' : '이 날은'} 쉬는 날({day.offDayName})이지만 아래 수업은 열려요
        </p>
      )}

      {/* 겹침 경고(노랑) */}
      {conflictLines.length > 0 && (
        <ul className="space-y-1.5" aria-label="겹침 경고">
          {conflictLines.map((t) => (
            <InfoLine key={t} tone="amber" icon="warn">
              {t}
            </InfoLine>
          ))}
        </ul>
      )}

      {stateKind ? (
        <TimetableStateCard
          kind={stateKind}
          compact={compact}
          isToday={isToday}
          offDayName={day.offDayName}
          onGoToday={onGoToday}
          onShowClassReference={onShowClassReference}
          awaitingHomeroom={awaitingHomeroom}
        />
      ) : (
        <ol className={compact ? 'space-y-1.5' : 'space-y-2'} aria-label="수업 목록">
          {day.lessons.map((l) => (
            <li key={l.key}>
              <LessonCard lesson={l} periodTimes={payload.periodTimes} compact={compact} isNow={isNow(l)} conflict={conflictKeys.has(l.key)} />
            </li>
          ))}
        </ol>
      )}

      {/* 취소·옮겨 간 수업 — 실제 수업 목록과 분리된 안내 */}
      {cancelled.length > 0 && (
        <ul className="space-y-1.5" aria-label="수업 변경 안내">
          {cancelled.map((n) => (
            <InfoLine key={`${n.kind}|${n.key}`} tone="red" icon={n.kind === 'cancelled' ? 'x' : 'move'}>
              <span className="font-semibold">{noticeText(n)}</span>
              {!compact && n.reason ? <span className="text-red-700/80"> · {n.reason}</span> : null}
            </InfoLine>
          ))}
        </ul>
      )}

      {/* 쉬는 날이라 열리지 않는 기본 수업 */}
      {suppressed.length > 0 && !compact && (
        <ul aria-label="쉬는 날 안내">
          <InfoLine tone="gray" icon="info">
            쉬는 날이라 열리지 않아요: {suppressed.map((n) => `${n.title} ${n.original.period}교시`).join(', ')}
          </InfoLine>
        </ul>
      )}

      {(pendingTitles.length > 0 || partial || calendarFailed || day.incompleteChangeSets.length > 0 || personalError) && (
        <ul className="space-y-1.5" aria-label="시간표 안내">
          {pendingTitles.map((t, i) => (
            <InfoLine key={`p${i}`} tone="sky" icon="clock">
              {t} 수업 승인을 기다리고 있어요
            </InfoLine>
          ))}
          {partial && (
            <InfoLine tone="amber" icon="info">
              일부 수업 시간표가 아직 없어요{partialTitles.length ? ` (${partialTitles.join(', ')})` : ''}
            </InfoLine>
          )}
          {day.incompleteChangeSets.length > 0 && (
            <InfoLine tone="gray" icon="info">
              시간표 변경 일부를 아직 받지 못해 바뀌기 전 시간표로 보여요. 잠시 후 다시 확인해 주세요.
            </InfoLine>
          )}
          {calendarFailed && (
            <InfoLine tone="gray" icon="info">
              쉬는 날 여부를 확인하지 못했어요
            </InfoLine>
          )}
          {personalError && (
            <InfoLine tone="gray" icon="warn">
              직접 입력한 일정을 불러오지 못했어요
            </InfoLine>
          )}
        </ul>
      )}
    </div>
  )
}

// ───────────────────────── 로딩·오류·캐시 상태까지 포함한 패널 ─────────────────────────

export interface PersonalTimetablePanelProps {
  /** useMyTimetable 결과 */
  tt: MyTimetableHook
  date: Ymd
  today: Ymd
  uid: string | null
  mode: 'compact' | 'full'
  personalEntries: PersonalEntry[]
  /** 직접 입력 일정 첫 결과를 받았는지(받기 전에는 '수업 없음'으로 단정하지 않도록 스켈레톤) */
  personalReady?: boolean
  personalError?: string | null
  onGoToday?: () => void
  onShowClassReference?: (() => void) | null
  awaitingHomeroom?: boolean
}

/** 학교 시간대 현재 시각(분) — 1분마다 갱신(학급 시간표(참고)의 '지금' 표시도 같이 씀) */
export function useNowMinutes(): number | null {
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    const tick = () => setNow(hmToMinutes(schoolHmAt(Date.now())))
    tick()
    const t = setInterval(tick, 60000)
    return () => clearInterval(t)
  }, [])
  return now
}

/**
 * 상태 판단: 최초 로딩(스켈레톤) → 인증·권한 오류(상태 카드) → 자료 있음(+오프라인·서버 오류 배너) → 자료 없음 오류(상태 카드).
 * 자료가 그 날짜를 포함하지 않으면 훅이 그 날짜 창을 다시 받습니다.
 */
export function PersonalTimetablePanel({
  tt,
  date,
  today,
  uid,
  mode,
  personalEntries,
  personalReady = true,
  personalError,
  onGoToday,
  onShowClassReference,
  awaitingHomeroom,
}: PersonalTimetablePanelProps): JSX.Element {
  const nowMinutes = useNowMinutes()
  const { payload, covered, error, loading, syncedAt, fromCache, retry } = tt

  const day = useMemo<DayTimetable | null>(() => {
    if (!payload || !covered) return null
    return buildDayTimetable(dayInput(payload, date, personalEntries, uid))
  }, [payload, covered, date, personalEntries, uid])

  if (!day || !payload || !personalReady) {
    if (error && !loading && !day) {
      return <TimetableStateCard kind={stateKindForError(error.kind)} code={error.code} compact={mode === 'compact'} onRetry={retry} isToday={date === today} />
    }
    return <TimetableSkeleton rows={mode === 'compact' ? 3 : 5} />
  }

  const syncedLabel = syncedAt ? formatSyncedAt(syncedAt) : null
  return (
    <div className="space-y-3">
      {error && (error.kind === 'offline' || error.kind === 'server') && (
        <SyncBanner kind={error.kind} syncedLabel={syncedLabel} code={error.code} onRetry={retry} retrying={loading} />
      )}
      {!error && fromCache && loading && (
        <p className="text-[11px] text-gray-400" role="status">
          최신 시간표를 확인하는 중… (마지막 동기화 {syncedLabel ?? '알 수 없음'})
        </p>
      )}
      <PersonalTimetable
        day={day}
        payload={payload}
        mode={mode}
        today={today}
        nowMinutes={nowMinutes}
        personalError={personalError}
        onGoToday={onGoToday}
        onShowClassReference={onShowClassReference}
        awaitingHomeroom={awaitingHomeroom}
      />
    </div>
  )
}
