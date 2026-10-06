const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'] as const

/** 개인 시간표의 빈 교시는 건너뛰되 실제 교시 번호와 수업 반 표기는 보존합니다. */
export function teacherHomeTimetable(schedule: unknown, ymd: string): {
  hasSchedule: boolean
  periods: Array<{ period: number; subject: string }>
} {
  const week = schedule && typeof schedule === 'object' && !Array.isArray(schedule)
    ? schedule as Record<string, unknown>
    : {}
  const hasSchedule = WEEKDAYS.some((day) => {
    const slots = week[day]
    return Array.isArray(slots) && slots.some((slot) => typeof slot === 'string' && slot.trim())
  })
  const weekday = new Date(Date.UTC(
    Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))
  )).getUTCDay()
  const key = WEEKDAYS[weekday - 1]
  const slots = key ? week[key] : undefined
  const periods = Array.isArray(slots)
    ? slots.map((slot, index) => ({
        period: index + 1,
        subject: typeof slot === 'string' ? slot.trim() : '',
      })).filter((slot) => slot.subject.length > 0)
    : []
  return { hasSchedule, periods }
}
