/**
 * 수업 표시 문구 — 순수 함수(브라우저·React 없이 단위 테스트 가능)
 * 수업 카드(LessonCard)와 교사 주간 시간표(teacherWeek.ts)가 같은 문구를 쓰도록 여기에 둡니다.
 * LessonCard.tsx가 그대로 다시 내보내므로 기존 import(`from './LessonCard'`)는 바뀌지 않습니다.
 */
import { slotMinutes } from './engine'
import { toUtcDate, weekdayOf } from './dates'
import type { ChangeField, ChangeInfo, LessonView, PeriodTime, Ymd } from './types'

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

/** 화면 제목: 제목에 분반이 이미 있으면 그대로, 없으면 '영어 · B' */
export function lessonTitle(l: Pick<LessonView, 'title' | 'section'>): string {
  if (l.section && !l.title.includes(l.section)) return `${l.title} · ${l.section}`
  return l.title
}
