/**
 * 학급 시간표(참고) 조회 — 클라이언트 공용 (TodayCard·ClassTimetableReference)
 *
 * 개인 시간표가 아닙니다. 소속 학급의 NEIS 학급 시간표 → 없으면 학급 시간표 문서(classes/{id}/info/timetable)
 * → 학급 시간표 변경(classes/{id}/overrides/{ymd}) 순으로 그날 교시 목록을 만듭니다.
 * 개인 시간표 자리에 대신 보여 주지 말고 '학급 시간표(참고)'라는 별도 보기에서만 쓰세요.
 *
 * strict: true면 Firestore 조회 실패를 빈 목록으로 숨기지 않고 예외로 올립니다(참고 보기에서 '불러오지 못했어요' 표시).
 * TodayCard는 기존 동작대로 strict 없이(실패 시 빈 목록/원래 시간표) 씁니다.
 */
import { doc, getDoc } from 'firebase/firestore'
import { offDayOn, type CalendarEventLike } from './schoolDay'

export interface ClassPeriodItem {
  period: number
  subject: string
  /** 학급 시간표 변경(overrides)으로 과목이 바뀐 교시 */
  changed?: boolean
}

// getUTCDay() 인덱스(0=일) → Firestore 학급 시간표 문서의 요일 키
const DAY_KEYS = ['', 'mon', 'tue', 'wed', 'thu', 'fri', ''] as const

function dayIndexOf(ymd: string): number {
  return new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)))).getUTCDay()
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

/** NEIS 학급 시간표 API URL (/api/timetable — 실패해도 200 + 빈 목록) */
export function neisClassTimetableUrl(schoolCode: string, grade: string | number, classNm: string | number, from: string, to: string = from): string {
  const s = encodeURIComponent(schoolCode)
  const g = encodeURIComponent(String(grade))
  const c = encodeURIComponent(String(classNm))
  return `/api/timetable?schoolCode=${s}&grade=${g}&classNm=${c}&from=${from}&to=${to}`
}

export function fetchNeisClassTimetable(
  schoolCode: string,
  grade: string | number,
  classNm: string | number,
  ymd: string
): Promise<Record<string, unknown> | null> {
  return fetchJson(neisClassTimetableUrl(schoolCode, grade, classNm, ymd))
}

/** /api/timetable 응답 → 그 날짜의 교시 목록(같은 교시는 첫 과목만, 교시 순) */
export function periodsFromNeisResponse(data: Record<string, unknown> | null, ymd: string): ClassPeriodItem[] {
  const rows = (data?.timetable as Array<{ date?: string; period?: number; subject?: string }> | undefined) ?? []
  const byPeriod = new Map<number, string>()
  for (const row of rows) {
    if (row.date && row.date !== ymd) continue
    const p = Number(row.period)
    const subject = String(row.subject ?? '').trim()
    if (!p || !subject || byPeriod.has(p)) continue
    byPeriod.set(p, subject)
  }
  const list: ClassPeriodItem[] = []
  byPeriod.forEach((subject, period) => {
    list.push({ period, subject })
  })
  list.sort((a, b) => a.period - b.period)
  return list
}

/** 학급 시간표 문서(classes/{id}/info/timetable)의 그 요일 교시 목록. 주말·문서 없음은 빈 목록 */
export async function readClassTimetableDoc(classId: string, ymd: string, opts: { strict?: boolean } = {}): Promise<ClassPeriodItem[]> {
  const dayKey = DAY_KEYS[dayIndexOf(ymd)]
  if (!classId || !dayKey) return []
  try {
    const { db } = await import('./firebase')
    const snap = await getDoc(doc(db, 'classes', classId, 'info', 'timetable'))
    if (!snap.exists()) return []
    const arr = (snap.data() as Record<string, unknown>)[dayKey]
    if (!Array.isArray(arr)) return []
    return arr
      .map((subject, i) => ({ period: i + 1, subject: String(subject ?? '').trim() }))
      .filter((p) => p.subject.length > 0)
  } catch (e) {
    if (opts.strict) throw e
    // Firestore 조회 실패 시 빈 시간표(기존 TodayCard 동작)
    return []
  }
}

/** 학급 시간표 변경(classes/{id}/overrides/{ymd}) 덮어쓰기. 실패하면 원래 목록 그대로(strict면 예외) */
export async function applyClassOverrides(
  classId: string,
  ymd: string,
  list: ClassPeriodItem[],
  opts: { strict?: boolean } = {}
): Promise<ClassPeriodItem[]> {
  if (!classId) return list
  try {
    const { db } = await import('./firebase')
    const ovSnap = await getDoc(doc(db, 'classes', classId, 'overrides', ymd))
    if (!ovSnap.exists()) return list
    const periodsObj = (ovSnap.data() as { periods?: Record<string, { subject?: unknown }> }).periods
    if (!periodsObj || typeof periodsObj !== 'object') return list
    const out = list.map((p) => ({ ...p }))
    for (const key of Object.keys(periodsObj)) {
      const p = Number(key)
      const subject = String(periodsObj[key]?.subject ?? '').trim()
      if (!p || !subject) continue
      const existing = out.find((item) => item.period === p)
      if (existing) {
        existing.subject = subject
        existing.changed = true
      } else {
        out.push({ period: p, subject, changed: true })
      }
    }
    out.sort((a, b) => a.period - b.period)
    return out
  } catch (e) {
    if (opts.strict) throw e
    // 변경 정보 조회 실패 시 원래 시간표 그대로
    return list
  }
}

export interface ClassTimetableDay {
  periods: ClassPeriodItem[]
  /** 쉬는 날(주말·휴업일·공휴일·방학). 이름이 없으면 '' */
  offDay: { name: string } | null
  /** 'neis' = NEIS 학급 시간표, 'class' = 학급 시간표 문서, 'none' = 없음 */
  source: 'neis' | 'class' | 'none'
}

/**
 * 그날 학급 시간표(참고). offDay를 주면(개인 시간표 자료의 쉬는 날) 학사일정을 다시 조회하지 않습니다.
 * NEIS 시간표가 있으면 그것(쉬는 날 판정 없이), 없고 쉬는 날이 아니면 학급 시간표 문서 + 학급 변경.
 */
export async function loadClassTimetableDay(opts: {
  schoolCode: string
  grade: string | number | null | undefined
  classNm: string | number | null | undefined
  classId: string | null | undefined
  ymd: string
  offDay?: { name: string } | null
  strict?: boolean
}): Promise<ClassTimetableDay> {
  const { schoolCode, grade, classNm, classId, ymd, strict } = opts
  const hasGradeClass = grade != null && grade !== '' && classNm != null && classNm !== ''
  const neis = schoolCode && hasGradeClass ? await fetchNeisClassTimetable(schoolCode, grade as string | number, classNm as string | number, ymd) : null
  let periods = periodsFromNeisResponse(neis, ymd)
  let source: ClassTimetableDay['source'] = periods.length ? 'neis' : 'none'

  let off: { name: string } | null = null
  if (!periods.length) {
    const dow = dayIndexOf(ymd)
    if (opts.offDay !== undefined) {
      off = opts.offDay ?? (dow === 0 || dow === 6 ? { name: '' } : null)
    } else if (schoolCode) {
      const cal = await fetchJson(`/api/calendar?schoolCode=${encodeURIComponent(schoolCode)}&from=${ymd}&to=${ymd}`)
      off = offDayOn(ymd, (cal?.events as CalendarEventLike[] | undefined) ?? [], grade ?? undefined)
    }
  }

  if (!periods.length && classId && !off) {
    periods = await readClassTimetableDoc(classId, ymd, { strict })
    if (periods.length) source = 'class'
  }
  if (classId && !off) {
    const before = periods.length
    periods = await applyClassOverrides(classId, ymd, periods, { strict })
    if (!before && periods.length) source = 'class'
  }
  return { periods, offDay: periods.length ? null : off, source }
}
