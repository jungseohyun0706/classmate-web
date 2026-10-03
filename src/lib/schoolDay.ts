// 학사일정(/api/calendar) 이벤트로 쉬는 날을 판정하는 클라이언트 공용 헬퍼.

/** /api/calendar 응답 이벤트 */
export interface CalendarEventLike {
  date?: string // YYYYMMDD
  name?: string
  /** 휴업일·공휴일·방학 */
  offDay?: boolean
  /** 일부 학년만 쉬는 날이면 그 학년들 */
  offGrades?: number[]
}

/**
 * 이 학년 학생에게 쉬는 날인 이벤트인지.
 * 일부 학년만 쉬는 날은 그 학년에만 적용하고, 학년을 모르면(수업 그룹 등) 쉬는 날로 봅니다.
 * (src/lib/neis.ts isOffDayRow의 학년 처리와 같은 기준)
 */
export function isOffDayFor(e: CalendarEventLike, grade?: string | number | null): boolean {
  if (e.offDay !== true) return false
  if (!Array.isArray(e.offGrades)) return true
  const g = Number(grade)
  if (!Number.isInteger(g) || g < 1 || g > 6) return true
  return e.offGrades.includes(g)
}

/**
 * ymd(YYYYMMDD)가 이 학년에게 쉬는 날(주말·휴업일·공휴일·방학)이면 { name }, 아니면 null.
 * name은 그날 쉬는 날 일정의 이름(예: '한글날'). 매주 오는 '토요휴업일'이나 주말이라 이름이 없으면 ''.
 * events가 비어 있으면(일정 조회 실패 포함) 주말만 쉬는 날로 봅니다.
 */
export function offDayOn(
  ymd: string,
  events: ReadonlyArray<CalendarEventLike>,
  grade?: string | number | null
): { name: string } | null {
  const dow = new Date(
    Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)))
  ).getUTCDay()
  const offs = events.filter((e) => e.date === ymd && isOffDayFor(e, grade))
  if (dow !== 0 && dow !== 6 && offs.length === 0) return null
  return { name: offs.find((e) => e.name && e.name !== '토요휴업일')?.name ?? '' }
}
