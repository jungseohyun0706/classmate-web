import type { Weekday, Ymd } from './types'

/** 학교 기본 시간대. 학교 설정이 따로 생기기 전까지 한국 학교는 모두 Asia/Seoul(UTC+9, 서머타임 없음) */
export const SCHOOL_TZ_OFFSET_MS = 9 * 60 * 60 * 1000

const YMD_RE = /^\d{8}$/

export function isYmd(v: unknown): v is Ymd {
  if (typeof v !== 'string' || !YMD_RE.test(v)) return false
  const d = toUtcDate(v)
  return ymdOfUtc(d) === v
}

/** 'YYYYMMDD' → 그 날짜 0시(UTC)의 Date — 요일·날짜 계산 전용(getUTC*로만 읽음) */
export function toUtcDate(ymd: Ymd): Date {
  return new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))))
}

export function ymdOfUtc(d: Date): Ymd {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

/** 시각(ms) → 학교 시간대 기준 날짜 */
export function schoolYmdAt(ms: number): Ymd {
  return ymdOfUtc(new Date(ms + SCHOOL_TZ_OFFSET_MS))
}

/** 학교 시간대 기준 현재 'HH:MM' */
export function schoolHmAt(ms: number): string {
  const d = new Date(ms + SCHOOL_TZ_OFFSET_MS)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

export function addDays(ymd: Ymd, n: number): Ymd {
  return ymdOfUtc(new Date(toUtcDate(ymd).getTime() + n * 86400000))
}

/** ISO 요일 (월=1 … 일=7) */
export function weekdayOf(ymd: Ymd): Weekday {
  const js = toUtcDate(ymd).getUTCDay() // 0=일
  return (js === 0 ? 7 : js) as Weekday
}

/** [from, to) 포함 여부. from/to가 비면 열린 구간 */
export function inRange(ymd: Ymd, from?: Ymd | null, to?: Ymd | null): boolean {
  if (from && ymd < from) return false
  if (to && ymd >= to) return false
  return true
}

/** 'HH:MM' → 분. 형식이 틀리면 null */
export function hmToMinutes(hm: string | null | undefined): number | null {
  if (!hm) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** 오늘 기준 상대 날짜 이름 (어제/오늘/내일/모레) — 그 밖은 null */
export function relativeDayLabel(ymd: Ymd, today: Ymd): string | null {
  const diff = Math.round((toUtcDate(ymd).getTime() - toUtcDate(today).getTime()) / 86400000)
  switch (diff) {
    case -1:
      return '어제'
    case 0:
      return '오늘'
    case 1:
      return '내일'
    case 2:
      return '모레'
    default:
      return null
  }
}

const WEEKDAY_KO = ['', '월', '화', '수', '목', '금', '토', '일']

/** '10월 6일 (화)' */
export function formatYmdKo(ymd: Ymd): string {
  const d = toUtcDate(ymd)
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 (${WEEKDAY_KO[weekdayOf(ymd)]})`
}

/** 'YYYYMMDD' ↔ 'YYYY-MM-DD' (input[type=date]) */
export function ymdToIso(ymd: Ymd): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
}

export function isoToYmd(iso: string): Ymd | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return null
  const ymd = `${m[1]}${m[2]}${m[3]}`
  return isYmd(ymd) ? ymd : null
}
