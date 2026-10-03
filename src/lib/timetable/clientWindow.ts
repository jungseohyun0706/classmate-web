/**
 * 학생 개인 시간표 — 조회 창(기간)과 '다시 받기' 판단 (순수 함수)
 *
 * useMyTimetable(client.ts)이 날짜를 바꿀 때·응답을 받은 뒤 무엇을 할지 여기서 정합니다.
 * 브라우저·Firebase·React 없이 단위 테스트합니다(tests/unit/timetable-client.test.ts).
 */
import { addDays } from './dates'
import type { Ymd } from './types'

export interface TimetableWindow {
  from: Ymd
  to: Ymd
}

/** 날짜 기준 조회 창: 앞 3일 ~ 뒤 13일(17일, 서버 최대 21일 안) */
export function windowFor(date: Ymd): TimetableWindow {
  return { from: addDays(date, -3), to: addDays(date, 13) }
}

export function windowCovers(w: TimetableWindow, date: Ymd): boolean {
  return w.from <= date && date <= w.to
}

/** 받은 자료가 그 날짜를 포함하는지(from·to 둘 다 포함) */
export function coversDate(p: { from: Ymd; to: Ymd }, date: Ymd): boolean {
  return p.from <= date && date <= p.to
}

/** 조회 도중 학교 시간표 버전이 올라간 경우 같은 기간을 다시 받는 최대 횟수 */
export const MAX_STALE_RETRIES = 2

/** 받은 자료 중 판단에 필요한 부분 */
export interface PayloadWindowLike {
  from: Ymd
  to: Ymd
  revision: number
}

export type DatePlan =
  /** 그대로 둠(진행 중 요청이 그 날짜를 포함하거나, 받은 자료가 이미 포함) */
  | { kind: 'keep' }
  /** 받은 자료가 그 날짜를 포함 — 다른 기간을 받던 요청을 버림 */
  | { kind: 'cancel-inflight' }
  /** 그 날짜 기간을 새로 받음 */
  | { kind: 'load'; win: TimetableWindow }

/**
 * 날짜가 정해지거나 바뀌었을 때 할 일.
 * - 진행 중 요청이 그 날짜를 포함 → 그대로(응답이 그 날짜를 포함)
 * - 서버에서 받은 자료(캐시 아님)가 그 날짜를 포함
 *   - 진행 중 요청이 없음 → 그대로
 *   - 다른 기간을 받는 중(먼 날짜로 갔다가 응답 전에 돌아온 경우) → 그 요청을 버림.
 *     그대로 두면 그 응답이 이 자료를 덮어써 지금 날짜가 기간 밖이 되고, 날짜는 그대로라 다시 받지 않아
 *     시간표가 불러오는 중(스켈레톤)에서 멈춤
 *   - 단, 구독한 학교 시간표 버전이 이 자료보다 새것이면 버리지 않고 이 날짜 기간을 새로 받음(변경 반영이 빠지지 않게)
 * - 그 밖(자료 없음·캐시 자료·기간 밖) → 그 날짜 기간을 받음
 */
export function planForDate(input: {
  date: Ymd
  inflight: TimetableWindow | null
  payload: PayloadWindowLike | null
  fromCache: boolean
  knownRevision: number
}): DatePlan {
  const { date, inflight, payload } = input
  if (inflight && windowCovers(inflight, date)) return { kind: 'keep' }
  if (payload && !input.fromCache && coversDate(payload, date)) {
    if (!inflight) return { kind: 'keep' }
    if (input.knownRevision > payload.revision) return { kind: 'load', win: windowFor(date) }
    return { kind: 'cancel-inflight' }
  }
  return { kind: 'load', win: windowFor(date) }
}

export type AfterLoadPlan =
  | { kind: 'done' }
  /** 응답 기간이 지금 날짜를 포함하지 않음 → 그 날짜 기간을 받음 */
  | { kind: 'reload-date'; win: TimetableWindow }
  /** 조회 도중 버전이 올라감 → 같은 기간을 한 번 더 */
  | { kind: 'reload-revision'; win: TimetableWindow }

/**
 * 성공 응답을 반영한 뒤 할 일.
 * - 지금 날짜가 응답 기간 밖이면(응답을 기다리는 사이 날짜가 바뀐 경우) 그 날짜 기간을 받음.
 *   날짜 effect는 날짜가 바뀔 때만 돌기 때문에, 여기서 받지 않으면 화면이 스켈레톤에서 멈춤.
 *   windowFor(date)는 date를 포함하므로 날짜가 또 바뀌지 않는 한 반복되지 않음
 * - 구독한 버전이 응답 revision보다 크면 같은 기간을 한 번 더(최대 MAX_STALE_RETRIES번)
 */
export function planAfterLoad(input: {
  date: Ymd | null
  win: TimetableWindow
  payload: PayloadWindowLike
  knownRevision: number
  staleRetries: number
}): AfterLoadPlan {
  const { date, payload } = input
  if (date && !coversDate(payload, date)) return { kind: 'reload-date', win: windowFor(date) }
  if (input.knownRevision > payload.revision && input.staleRetries < MAX_STALE_RETRIES) return { kind: 'reload-revision', win: input.win }
  return { kind: 'done' }
}
