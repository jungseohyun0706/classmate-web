import type { JSX } from 'react'
import Link from 'next/link'
import { slotMinutes } from '../../lib/timetable/engine'
import { toUtcDate, weekdayOf } from '../../lib/timetable/dates'
import type { ChangeField, ChangeInfo, LessonView, PeriodTime, SlotState, Ymd } from '../../lib/timetable/types'

/**
 * 수업 카드 (요구 문서 2.2)
 * - 교시(·시각), 과목(·분반), 실제 수업 교실, 담당 교사
 * - 변경: 빨간 테두리 + 배지 텍스트(시간 변경/날짜 변경/교실 변경/교사 변경/보강) + 전후('3교시 → 2교시'). 사유·안내 시각은 펼쳐서
 * - 직접 입력: 회색 점선 테두리 + '직접 입력 · 학교 시간표와 연결되지 않음', 서버 반영 전이면 '저장 대기'
 * - 내부 id·관리 필드는 보이지 않음
 * - 교사 '내 시간표'(TeacherTimetable)가 쓰는 선택 값: 덧붙이는 배지(대신 들어가는 수업 등)·취소선·수업 상세 링크·학급 표시·직접 등록 문구.
 *   주지 않으면 학생 화면 모양 그대로
 */
export interface LessonCardProps {
  lesson: LessonView
  periodTimes?: PeriodTime[]
  compact?: boolean
  /** 지금 진행 중인 수업 */
  isNow?: boolean
  /** 다른 일정과 겹침 — 노란 표시(문구는 목록 위 경고 줄) */
  conflict?: boolean
  /** 덧붙이는 배지(교사 화면: '대신 들어가는 수업', '○○ 선생님이 대신 들어가요 (품앗이)' 등). 빨강이 하나라도 있으면 빨간 테두리 */
  extraBadges?: Array<{ label: string; tone: 'red' | 'gray' | 'sky' }>
  /** 취소된 차시 — 교시·제목에 취소선 */
  struck?: boolean
  /** 제목을 링크로(교사 수업 상세) */
  href?: string | null
  /** 교실 앞에 붙일 표시(교사 화면: '3학년 4반') */
  metaPrefix?: string | null
  /** 직접 입력(source personal) 배지 문구 — 기본 '직접 입력 · 학교 시간표와 연결되지 않음' */
  personalLabel?: string
}

const WEEKDAY_KO = ['', '월', '화', '수', '목', '금', '토', '일']

/** '10월 8일(목)' */
export function shortDateKo(ymd: Ymd): string {
  const d = toUtcDate(ymd)
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일(${WEEKDAY_KO[weekdayOf(ymd)]})`
}

function minutesToHm(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** 표시용 시각 '09:00~09:50' (명시 시각 → 교시표). 모르면 null */
export function lessonTimeRange(
  l: { period: number | null; start?: string | null; end?: string | null },
  periodTimes?: PeriodTime[]
): string | null {
  const m = slotMinutes(l, periodTimes)
  if (m.start === null) return null
  // slotMinutes는 끝 시각이 없으면 시작+1분으로 둠 — 표시는 시작만
  const hasEnd = m.end !== null && m.end - m.start > 1
  return hasEnd ? `${minutesToHm(m.start)}~${minutesToHm(m.end as number)}` : minutesToHm(m.start)
}

const FIELD_LABEL: Record<ChangeField, string> = {
  date: '날짜 변경',
  time: '시간 변경',
  room: '교실 변경',
  teacher: '교사 변경',
}

/** 변경 배지 문구 */
export function changeBadgeLabels(change: ChangeInfo): string[] {
  if (change.kind === 'makeup' && !change.before) return ['보강']
  const labels = change.fields.map((f) => FIELD_LABEL[f])
  if (change.kind === 'makeup') labels.unshift('보강')
  return labels
}

function slotWhen(s: SlotState): string {
  if (s.start) return `${s.period}교시(${s.start}${s.end ? `~${s.end}` : ''})`
  return `${s.period}교시`
}

function teacherText(names: string[] | undefined): string {
  return names && names.length ? `${names.join(', ')} 선생님` : '담당 교사 미정'
}

/** 변경 전후 문구: '3교시 → 2교시', '10월 6일(화) 3교시 → 10월 8일(목) 3교시', '3학년 4반 교실 → 영어전용실' */
export function changeSummaryLines(change: ChangeInfo): string[] {
  const b = change.before
  const a = change.after
  if (!b) return []
  const out: string[] = []
  if (change.fields.includes('date')) {
    out.push(`${shortDateKo(b.date)} ${slotWhen(b)} → ${shortDateKo(a.date)} ${slotWhen(a)}`)
  } else if (change.fields.includes('time')) {
    if (b.period !== a.period) out.push(`${slotWhen(b)} → ${slotWhen(a)}`)
    else out.push(`${b.start || '교시 시각'}${b.end ? `~${b.end}` : ''} → ${a.start || '교시 시각'}${a.end ? `~${a.end}` : ''}`)
  }
  if (change.fields.includes('room')) out.push(`${b.roomName || '교실 미정'} → ${a.roomName || '교실 미정'}`)
  if (change.fields.includes('teacher')) out.push(`${teacherText(b.teacherNames)} → ${teacherText(a.teacherNames)}`)
  return out
}

/** 안내 시각(ms) → '10월 5일 18:20' (학교 시간대) */
export function formatPublishedAt(ms: number): string {
  const d = new Date(ms + 9 * 60 * 60 * 1000)
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/** 화면 제목: 제목에 분반이 이미 있으면 그대로, 없으면 '영어 · B' */
export function lessonTitle(l: Pick<LessonView, 'title' | 'section'>): string {
  if (l.section && !l.title.includes(l.section)) return `${l.title} · ${l.section}`
  return l.title
}

function ChangeIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 shrink-0" aria-hidden="true">
      <path d="M7 4 3 8l4 4M3 8h13a5 5 0 0 1 0 10h-2" />
    </svg>
  )
}

const EXTRA_TONE: Record<'red' | 'gray' | 'sky', string> = {
  red: 'bg-red-100 text-red-700 ring-red-200 font-bold',
  gray: 'bg-gray-100 text-gray-600 ring-gray-200 font-medium',
  sky: 'bg-sky-50 text-sky-800 ring-sky-200 font-medium',
}

export default function LessonCard({
  lesson,
  periodTimes,
  compact = false,
  isNow = false,
  conflict = false,
  extraBadges = [],
  struck = false,
  href = null,
  metaPrefix = null,
  personalLabel,
}: LessonCardProps): JSX.Element {
  const personal = lesson.source === 'personal'
  const change = lesson.change
  const changed = !!change
  const time = lessonTimeRange(lesson, periodTimes)
  const periodLabel = lesson.period != null ? `${lesson.period}교시` : time || '시간 미정'
  const title = lessonTitle(lesson)
  const lines = change ? changeSummaryLines(change) : []
  const badges = change ? changeBadgeLabels(change) : []
  const hasDetail = !!(change && (change.reason || change.publishedAt))
  const redExtra = struck || extraBadges.some((b) => b.tone === 'red')

  const frame = changed || redExtra
    ? 'border-2 border-red-300 bg-red-50/50'
    : personal
      ? 'border-2 border-dashed border-gray-300 bg-gray-50'
      : isNow
        ? 'border-2 border-emerald-400 bg-emerald-50/40'
        : 'border border-gray-200 bg-white'

  const meta: string[] = []
  if (metaPrefix) meta.push(metaPrefix)
  if (lesson.roomName) meta.push(lesson.roomName)
  if (!compact && lesson.teacherNames.length) meta.push(`${lesson.teacherNames.join(', ')} 선생님`)

  return (
    <article
      aria-label={`${periodLabel} ${title}${changed ? ` (${badges.join(', ')})` : ''}${extraBadges.length ? ` (${extraBadges.map((b) => b.label).join(', ')})` : ''}${personal ? ' (직접 입력)' : ''}`}
      className={`relative rounded-xl ${frame} ${compact ? 'px-3 py-2.5' : 'px-4 py-3'} ${conflict ? 'ring-2 ring-amber-300' : ''}`}
    >
      <div className="flex items-start gap-3">
        {/* 교시·시각 (교시가 없는 직접 입력은 시작 시각을 크게) */}
        <div className={`shrink-0 text-center ${compact ? 'w-12' : 'w-14'}`}>
          <p className={`font-bold ${changed || redExtra ? 'text-red-700' : 'text-gray-900'} ${struck ? 'line-through' : ''} ${compact ? 'text-sm' : 'text-base'}`}>
            {lesson.period != null ? `${lesson.period}교시` : time ? time.split('~')[0] : '시간 미정'}
          </p>
          {lesson.period != null
            ? time && (
                // 좁은 칸(홈 카드 w-12)에서 '08:40~09:30'이 옆 칸으로 넘치지 않게 '~' 뒤에서 줄을 바꿀 수 있게 함
                <p className="mt-0.5 text-[11px] leading-tight text-gray-500">
                  {time.includes('~') ? (
                    <>
                      {time.split('~')[0]}~<wbr />
                      {time.split('~')[1]}
                    </>
                  ) : (
                    time
                  )}
                </p>
              )
            : time && time.includes('~') && <p className="mt-0.5 text-[11px] leading-tight text-gray-500">~{time.split('~')[1]}</p>}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className={`min-w-0 font-semibold break-keep wrap-anywhere ${struck ? 'text-gray-500 line-through' : 'text-gray-900'} ${compact ? 'text-sm' : 'text-[15px]'}`}>
              {href ? (
                <Link href={href} className="underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 rounded">
                  {title}
                </Link>
              ) : (
                title
              )}
            </h3>
            {isNow && (
              <span className="shrink-0 rounded-full bg-emerald-600 px-2 py-0.5 text-[11px] font-semibold text-white">지금</span>
            )}
          </div>

          {meta.length > 0 && (
            <p className="mt-0.5 flex items-start gap-1 text-xs text-gray-600 break-keep wrap-anywhere">
              {lesson.roomName && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 h-3 w-3 shrink-0 text-gray-400" aria-hidden="true">
                  <path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11Z" />
                  <circle cx="12" cy="10" r="2.5" />
                </svg>
              )}
              <span className="min-w-0">{meta.join(' · ')}</span>
            </p>
          )}

          {/* 배지: 변경(빨강) / 직접 입력(회색) / 저장 대기 */}
          {(changed || personal || lesson.pendingSync || extraBadges.length > 0) && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {badges.map((b) => (
                <span key={b} className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-bold text-red-700 ring-1 ring-red-200">
                  <ChangeIcon />
                  {b}
                </span>
              ))}
              {extraBadges.map((b) => (
                <span key={`x:${b.label}`} className={`inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ring-1 break-keep wrap-anywhere ${EXTRA_TONE[b.tone]}`}>
                  {b.tone === 'red' && <ChangeIcon />}
                  {b.label}
                </span>
              ))}
              {personal && (
                <span className="inline-flex max-w-full items-center rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-gray-600 ring-1 ring-gray-300 break-keep">
                  {personalLabel || '직접 입력 · 학교 시간표와 연결되지 않음'}
                </span>
              )}
              {lesson.pendingSync && (
                <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600 ring-1 ring-gray-200">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v5l3 2" />
                  </svg>
                  저장 대기
                </span>
              )}
            </div>
          )}

          {/* 변경 전후 */}
          {lines.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {lines.map((t) => (
                <li key={t} className="text-xs font-semibold text-red-700 break-keep wrap-anywhere">
                  {t}
                </li>
              ))}
            </ul>
          )}

          {lesson.memo && (
            <p className={`mt-1 text-xs text-gray-600 break-keep wrap-anywhere ${compact ? 'line-clamp-2' : ''}`}>
              <span className="font-semibold text-gray-500">메모</span> {lesson.memo}
            </p>
          )}

          {hasDetail && change && (
            <details className="group mt-0.5">
              <summary className="-ml-1 flex min-h-11 cursor-pointer list-none items-center gap-1 px-1 text-xs font-semibold text-red-700 [&::-webkit-details-marker]:hidden">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 transition-transform group-open:rotate-90" aria-hidden="true">
                  <path d="m9 18 6-6-6-6" />
                </svg>
                변경 사유·안내 시각
              </summary>
              <dl className="mb-1 space-y-0.5 rounded-lg bg-white/70 px-3 py-2 text-xs text-gray-700 ring-1 ring-red-100">
                {change.reason && (
                  <div className="flex gap-2">
                    <dt className="shrink-0 font-semibold text-gray-500">사유</dt>
                    <dd className="min-w-0 break-keep wrap-anywhere">{change.reason}</dd>
                  </div>
                )}
                {change.publishedAt ? (
                  <div className="flex gap-2">
                    <dt className="shrink-0 font-semibold text-gray-500">안내</dt>
                    <dd>{formatPublishedAt(change.publishedAt)}</dd>
                  </div>
                ) : null}
              </dl>
            </details>
          )}
        </div>
      </div>
    </article>
  )
}
