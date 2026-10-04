/**
 * 교사 수업 관리 화면(/teacher/courses, /teacher/courses/[id], SeriesEditor)의 순수 판정 도우미
 * (Firebase·React와 분리 — 단위 테스트 대상. teacherClient.ts는 firebase를 불러오므로 여기서 import하지 않음)
 *
 * - 수업 운영 상태: 서버(courseActiveOn)와 같은 기준으로 '종료' / '종료 예정' / '운영 중'
 * - 담임 반 확인: 읽기 실패를 '담임 아님'으로 위장하지 않음(오류 → 다시 시도)
 * - 차시 추가 요청 만들기·비교: 겹침 확인을 받은 입력과 저장할 입력이 같은지
 * - 지난 날짜 막기: 차시 추가·종료 적용일은 오늘(학교 시간대)부터
 * - 수업 목록 인원: 목록 응답의 counts만 사용(수업마다 상세·명단을 다시 받지 않음)
 * - 대상 반 입력 나누기: '2-1, 2-3'·'2-1 2-3' → ['2-1', '2-3'] (정리·확인은 서버)
 */
import { courseActiveOn } from './engine'
import { formatYmdKo, isoToYmd } from './dates'
import type { Course, Weekday, Ymd } from './types'

// ───────────────────────── 수업 운영 상태 ─────────────────────────

export interface CourseEndState {
  /** 오늘 운영하지 않음(종료일이 오늘이거나 지남) — 승인·초대·차시 편집·정보 수정을 막음 */
  ended: boolean
  /** 종료일을 미래로 정해 둠 — 그 전까지는 운영 중과 똑같이 다룸(서버도 그날 전까지 초대·승인을 받음) */
  endScheduled: boolean
  endedOn: Ymd | null
}

/**
 * status === 'ended'만 보면 종료일을 미래로 정한 수업이 바로 '종료'로 보여 승인 대기 학생을 승인할 수 없었음.
 * 서버(enrollments·invitations·courses)와 같은 courseActiveOn(오늘) 기준으로 판정합니다.
 */
export function courseEndState(course: Course, today: Ymd): CourseEndState {
  const endedOn = course.endedOn || null
  const ended = !courseActiveOn(course, today)
  return { ended, endScheduled: !ended && !!endedOn, endedOn }
}

// ───────────────────────── 담임 반 확인 ─────────────────────────

export interface HomeroomRefView {
  classId: string
  label: string
}

export type HomeroomCheck =
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'ok'; ref: HomeroomRefView }
  | { status: 'error'; error: unknown }

export function homeroomLabelOf(v: Record<string, any>): string {
  return v.grade != null && v.classNm != null ? `${v.grade}학년 ${v.classNm}반` : '우리 반'
}

/**
 * 내 담임 반(공통 수업 지정·해제 버튼용) 확인.
 * - 'none'은 담임 반이 없거나, 문서를 실제로 읽었는데 내가 담임이 아닐 때만
 * - 읽기 실패는 'error'(화면: 오류 + 다시 시도). 예전에는 실패도 '담임만 할 수 있어요'로 보였음
 * - 직접 읽기가 permission-denied면(schoolCode 없는 예전 학급 문서 — 규칙상 클라이언트 읽기 거부)
 *   서버가 판정한 내 담임 반 목록(serverHomerooms, /api/courses list의 homerooms)으로 다시 확인 — 서버 setCommon과 같은 기준
 */
export async function checkMyHomeroom(opts: {
  homeroomId: string | null | undefined
  uid: string | null | undefined
  /** 학급 문서 읽기 — 문서가 없으면 null */
  readClass: (classId: string) => Promise<Record<string, any> | null>
  serverHomerooms?: () => Promise<HomeroomRefView[]>
}): Promise<HomeroomCheck> {
  const { homeroomId, uid } = opts
  if (!homeroomId || !uid) return { status: 'none' }
  let v: Record<string, any> | null
  try {
    v = await opts.readClass(homeroomId)
  } catch (e) {
    const code = (e as { code?: unknown })?.code
    if (code !== 'permission-denied' || !opts.serverHomerooms) return { status: 'error', error: e }
    try {
      const list = await opts.serverHomerooms()
      const found = list.find((h) => h.classId === homeroomId)
      return found ? { status: 'ok', ref: { classId: found.classId, label: found.label } } : { status: 'none' }
    } catch (e2) {
      return { status: 'error', error: e2 }
    }
  }
  if (!v || v.isGroup === true || v.teacherId !== uid) return { status: 'none' }
  return { status: 'ok', ref: { classId: homeroomId, label: homeroomLabelOf(v) } }
}

// ───────────────────────── 지난 날짜 ─────────────────────────

/** 차시 추가·종료 적용일이 오늘보다 이를 때(화면 검사 + 서버 400 code 'past-date') */
export const PAST_DATE_TEXT = '지난 날짜는 바꿀 수 없어요. 오늘 이후 날짜를 골라 주세요.'
/** 서버가 지난 날짜를 거부할 때의 코드(courses.ts addSeries·retireSeries = 'past-date', 일정 변경 쪽 이름도 함께) */
const PAST_DATE_CODES = new Set(['past-date', 'past-effective-date'])

export function isPastDateCode(code: string | null | undefined): boolean {
  return !!code && PAST_DATE_CODES.has(code)
}

/** 날짜 입력(YYYY-MM-DD) → 적용일. 비었거나 형식이 틀리면 오류, 오늘보다 이르면 지난 날짜 오류 */
export function effectiveDateFromIso(iso: string, today: Ymd, emptyText = '적용일을 골라 주세요.'): { ok: true; ymd: Ymd } | { ok: false; error: string } {
  const ymd = isoToYmd(iso)
  if (!ymd) return { ok: false, error: emptyText }
  if (ymd < today) return { ok: false, error: PAST_DATE_TEXT }
  return { ok: true, ymd }
}

// ───────────────────────── 차시 추가 요청 ─────────────────────────

export interface SeriesFormValues {
  weekday: Weekday
  period: number
  /** 'HH:MM' 또는 '' */
  start: string
  end: string
  roomName: string
  /** input[type=date] 값(YYYY-MM-DD) 또는 '' */
  validFromIso: string
}

/** addSeries로 보낼 값(겹침 확인을 받은 입력과 비교하는 단위) */
export interface SeriesAddRequest {
  weekday: Weekday
  period: number
  start: string | null
  end: string | null
  roomName: string | null
  /** null이면 서버 기본(오늘, 학기 시작 전이면 학기 시작일) */
  validFrom: Ymd | null
}

export function buildSeriesAddRequest(v: SeriesFormValues, today: Ymd): { ok: true; req: SeriesAddRequest } | { ok: false; error: string } {
  if ((v.start && !v.end) || (!v.start && v.end)) return { ok: false, error: '시작·끝 시각을 함께 넣거나 둘 다 비워 주세요.' }
  if (v.start && v.end && v.start >= v.end) return { ok: false, error: '끝 시각은 시작 시각보다 뒤여야 해요.' }
  let validFrom: Ymd | null = null
  if (v.validFromIso) {
    validFrom = isoToYmd(v.validFromIso)
    if (!validFrom) return { ok: false, error: '적용 시작일 형식이 올바르지 않아요.' }
    // 지난 날짜부터 차시를 넣으면 지난 학생 시간표가 소급해 바뀜
    if (validFrom < today) return { ok: false, error: PAST_DATE_TEXT }
  }
  return {
    ok: true,
    req: {
      weekday: v.weekday,
      period: v.period,
      start: v.start || null,
      end: v.end || null,
      roomName: v.roomName.trim() || null,
      validFrom,
    },
  }
}

/** 겹침 확인을 받은 입력과 지금 입력이 같은지(다르면 '겹쳐도 추가'로 보내지 않고 다시 확인) */
export function sameSeriesAddRequest(a: SeriesAddRequest, b: SeriesAddRequest): boolean {
  return (
    a.weekday === b.weekday &&
    a.period === b.period &&
    a.start === b.start &&
    a.end === b.end &&
    a.roomName === b.roomName &&
    a.validFrom === b.validFrom
  )
}

/**
 * '겹쳐도 추가'로 보낼 요청 — 겹침 확인을 받은 입력(confirmed)과 지금 폼 입력이 같을 때만 그 입력을 돌려줌.
 * 다르면 null(패널을 닫고 '차시 추가'로 다시 확인). 예전에는 지금 폼 값에 acknowledgeConflicts를 붙여 보내,
 * 교사가 보지 않은 새 칸의 겹침이 확인 없이 저장됐음.
 */
export function acknowledgedRequest(confirmed: SeriesAddRequest, current: SeriesFormValues, today: Ymd): SeriesAddRequest | null {
  const built = buildSeriesAddRequest(current, today)
  if (!built.ok || !sameSeriesAddRequest(built.req, confirmed)) return null
  return confirmed
}

// ───────────────────────── 확인 문구(영향) ─────────────────────────

export function addSeriesImpactText(validFrom: Ymd | null): string {
  const from = validFrom ? formatYmdKo(validFrom) : '오늘(학기 시작 전이면 학기 시작일)'
  return `${from}부터 이 수업 수강생 모두의 시간표에 매주 이 차시가 들어가요. 그 전 날짜(지난 시간표)는 바뀌지 않아요.`
}

export function retireSeriesImpactText(effectiveFrom: Ymd): string {
  return (
    `${formatYmdKo(effectiveFrom)}부터 이 수업 수강생 모두의 시간표에서 매주 이 차시가 빠져요. 그 전 날짜(지난 수업)는 그대로 남아요. ` +
    `그날 이후 이 차시에 걸어 둔 날짜별 일정 변경(옮김·취소 등)은 '검토 필요'로 바뀌어 학생 화면에 적용되지 않아요.`
  )
}

// ───────────────────────── 수업 목록 인원 ─────────────────────────

export interface ListCounts {
  active: number
  pending: number
}

const countOk = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0

/**
 * /api/courses list 응답의 수업별 counts({active, pending}). 없거나 모양이 틀리면 null(화면: '인원 —').
 * 목록 화면은 인원 수만 필요하므로 수업마다 get(승인 대기 학생 명단·uid 포함)을 부르지 않습니다.
 */
export function listCountsOf(item: unknown): ListCounts | null {
  const c = (item as { counts?: unknown } | null)?.counts as { active?: unknown; pending?: unknown } | null | undefined
  if (!c || typeof c !== 'object') return null
  if (!countOk(c.active) || !countOk(c.pending)) return null
  return { active: c.active, pending: c.pending }
}

// ───────────────────────── 대상 반 입력 ─────────────────────────

/** 띄어 쓴 낱말 하나가 반 표시 모양인지('2-1'·'2_1'·'2/1'·'2.1'·'2-1반'·'201'·'0201') — 띄어쓰기로 나눌지 판단용 */
const CLASS_LABEL_WORD = /^(\d{1,2}[-_/.]\d{1,2}반?|0?\d\d{2})$/

/**
 * 교사 '대상 반' 입력 → 보낼 목록. 쉼표·가운뎃점·세미콜론·줄바꿈으로 나누고, 한 토막 안에서 띄어 쓴 낱말이 **모두** 반 표시 모양이면
 * 띄어쓰기로도 나눔('2-1 2-3' → ['2-1', '2-3']). '2학년 1반'처럼 한 표시를 띄어 쓴 것은 그대로 보내 서버가 정리·확인
 * (알 수 없는 표시는 서버가 400 invalid-class-label — 다른 반으로 잘못 저장하지 않음). 중복 없이 입력 순서대로
 */
export function splitClassLabelsText(text: string): string[] {
  const out: string[] = []
  const add = (x: string) => {
    if (x && out.indexOf(x) < 0) out.push(x)
  }
  text.split(/[,，·;；\n]+/).forEach((chunk) => {
    const t = chunk.trim()
    if (!t) return
    const words = t.split(/\s+/)
    if (words.length > 1 && words.every((w) => CLASS_LABEL_WORD.test(w))) words.forEach(add)
    else add(t)
  })
  return out
}
