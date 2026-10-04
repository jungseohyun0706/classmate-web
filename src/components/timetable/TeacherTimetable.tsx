import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import Link from 'next/link'
import { schoolYmdAt } from '../../lib/timetable/dates'
import { buildTeacherDay, type TeacherDayView } from '../../lib/timetable/teacherDay'
import { useTeacherTimetable } from '../../lib/timetable/teacherHomeClient'
import type { Ymd } from '../../lib/timetable/types'
import DayNav from './DayNav'
import { useNowMinutes } from './PersonalTimetable'
import { TeacherDayPanel } from './TeacherDayBody'

/**
 * 교사 대시보드 메인 '오늘의 내 수업' — 학급 시간표 대신 선생님 본인 시간표(요구: 선생님 화면 메인 = 선생님 전용 시간표)
 * - 자료: GET /api/timetable/teacher(useTeacherTimetable) → 날짜마다 buildTeacherDay(teacherDay.ts)
 * - 공식 수업이 있으면 공식 수업(변경 전후·빨간 배지), 없으면 직접 등록 주간 시간표('수업 변경은 반영되지 않아요'), 둘 다 없으면 빈 상태
 * - 예전 교환(품앗이)·보결(SOS)을 겹쳐 표시. 쉬는 날·학기 밖·수업 없는 날은 학생 화면과 같은 상태 카드
 * - 담임 선생님은 '우리 반 시간표 보기' 작은 링크(학급 시간표는 메인 화면이 아님)
 * - 카드 제목과 머리의 '주간 시간표 →'는 내 시간표 화면 주간 보기(/teacher/timetable?view=week&date=보고 있는 날짜)로
 * - 하루 화면 조각(목록·상태·안내 줄)은 TeacherDayBody.tsx — 내 시간표 화면 '하루' 탭과 같음
 */

/** 내 시간표 화면 주간 보기 주소(날짜를 아직 모르면 이번 주) */
export function teacherWeekHref(date: Ymd | null): string {
  return date ? `/teacher/timetable?view=week&date=${date}` : '/teacher/timetable?view=week'
}

export interface TeacherTimetableProps {
  uid: string
  schoolCode: string
  /** 담임 반이 있는 선생님 — '우리 반 시간표 보기' 링크 */
  homeroom: boolean
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
  const weekHref = teacherWeekHref(date)
  const linkCls =
    'inline-flex min-h-11 items-center gap-1 rounded text-sm font-semibold text-blue-700 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400'

  return (
    <section aria-labelledby="teacher-today-title" className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-lg">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-gray-100 px-4 py-3 sm:px-5">
        {/* 제목 자체도 주간 시간표로(요구: '내 시간표'를 누르면 주간 시간표도) */}
        <h2 id="teacher-today-title" className="text-lg font-bold text-gray-900 break-keep">
          <Link href={weekHref} className="inline-flex min-h-11 items-center rounded underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
            {isToday || !date ? '오늘의 내 수업' : '내 수업'}
          </Link>
        </h2>
        <div className="flex flex-wrap items-center gap-x-3">
          <Link href={weekHref} className={linkCls}>
            주간 시간표
            <span aria-hidden="true">&rarr;</span>
          </Link>
          {homeroom && (
            <Link href="/teacher/class-timetable" className={linkCls}>
              우리 반 시간표 보기
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </Link>
          )}
        </div>
      </div>
      <div className="space-y-3 p-4 sm:p-5">
        {date && today && <DayNav date={date} today={today} onChange={setDate} compact />}
        <TeacherDayPanel
          view={view}
          payload={payload}
          today={today}
          nowMinutes={nowMinutes}
          error={error}
          loading={loading}
          syncedAt={syncedAt}
          onRetry={retry}
          onGoToday={() => today && setDate(today)}
          isToday={isToday}
        />
      </div>
    </section>
  )
}
