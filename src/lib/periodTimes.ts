// '지금' 교시 판별용 교시 시각.
// 학교급별 기본 시각을 두고, 교사가 올린 시간표 엑셀에 교시 시작 시각이 있으면
// (classes/{classId}/info/periodTimes.times) 그 시작 시각에 학교급 수업 길이를 더해 씁니다.

import { PERIOD_COUNT } from './timetableConvert'

export type SchoolLevel = 'elementary' | 'middle' | 'high'

/** 교시 [시작, 끝) — 0시부터의 분 */
export type PeriodRange = readonly [number, number]

interface LevelSpec {
  /** 1교시 시작 'HH:MM' */
  start: string
  /** 수업 길이(분) */
  lesson: number
  /** 쉬는 시간(분) */
  rest: number
  /** 이 교시가 끝나면 점심시간 */
  lunchAfter: number
  /** 점심시간(분) */
  lunch: number
}

const LEVEL_SPECS: Record<SchoolLevel, LevelSpec> = {
  elementary: { start: '09:00', lesson: 40, rest: 10, lunchAfter: 4, lunch: 50 },
  middle: { start: '09:00', lesson: 45, rest: 10, lunchAfter: 4, lunch: 60 },
  high: { start: '08:40', lesson: 50, rest: 10, lunchAfter: 4, lunch: 60 },
}

/** 'HH:MM'·'H:MM' → 0시부터의 분. 형식이 틀리면 null */
function toMinutes(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** 학교 이름 접미사로 학교급을 판별합니다. 알 수 없으면 초등(예전 고정 시각과 같음). */
export function schoolLevelOf(schoolName: string | null | undefined): SchoolLevel {
  const name = String(schoolName ?? '').trim()
  if (name.endsWith('고등학교')) return 'high'
  if (name.endsWith('중학교')) return 'middle'
  return 'elementary'
}

/**
 * 1교시부터의 교시 시각표를 만듭니다.
 * starts(교시별 시작 'HH:MM', 1교시부터)가 있으면 그 시작 시각 + 학교급 수업 길이로 끝 시각을 정하고,
 * 빈 교시는 앞 교시에 이어(쉬는 시간·점심시간을 더해) 계산합니다. starts가 없으면 학교급 기본값입니다.
 */
export function periodRanges(
  level: SchoolLevel,
  starts?: ReadonlyArray<string | null | undefined>
): PeriodRange[] {
  const spec = LEVEL_SPECS[level]
  const ranges: [number, number][] = []
  for (let i = 0; i < PERIOD_COUNT; i++) {
    const prev = ranges[i - 1]
    let start = toMinutes(String(starts?.[i] ?? ''))
    // 엑셀에 오후 시각이 12시간제('1:20')로 적힌 경우
    if (start !== null && prev && start <= prev[0] && start < 12 * 60) start += 12 * 60
    if (start === null || (prev && start <= prev[0])) {
      start = prev
        ? prev[1] + (i === spec.lunchAfter ? spec.lunch : spec.rest)
        : (toMinutes(spec.start) as number)
    }
    ranges.push([start, start + spec.lesson])
  }
  // 수업 길이가 학교급 기본보다 짧은 학교: 다음 교시가 시작하면 앞 교시는 끝난 것으로 봅니다.
  for (let i = 0; i + 1 < ranges.length; i++) {
    if (ranges[i + 1][0] < ranges[i][1]) ranges[i][1] = ranges[i + 1][0]
  }
  return ranges
}

/** nowMin(0시부터의 분)이 몇 교시 수업 중인지. 수업 시간이 아니면 0 */
export function currentPeriodAt(nowMin: number, ranges: ReadonlyArray<PeriodRange>): number {
  for (let i = 0; i < ranges.length; i++) {
    if (nowMin >= ranges[i][0] && nowMin < ranges[i][1]) return i + 1
  }
  return 0
}
