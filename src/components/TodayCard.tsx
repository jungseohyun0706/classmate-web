import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import Link from 'next/link'
import { doc, getDoc, onSnapshot } from 'firebase/firestore'
import { pickMainMeal } from '../lib/meals'
import { currentPeriodAt, periodRanges, schoolLevelOf } from '../lib/periodTimes'
import { offDayOn, type CalendarEventLike } from '../lib/schoolDay'
import { teacherHomeTimetable } from '../lib/teacherHomeTimetable'

export interface TodayCardProps {
  schoolCode: string
  schoolName: string
  grade: string | number
  classNm: string | number
  classId: string
  /** 교사 홈은 담임반이 아니라 이 계정에 저장된 개인 시간표를 표시합니다. */
  teacherUid?: string
  /** 오늘 급식 조회가 끝나면 급식 유무를 알려 줍니다(급식 없는 날 별점 숨김용). */
  onMealLoaded?: (hasMeal: boolean) => void
}

interface PeriodItem {
  period: number
  subject: string
  /** 오늘 시간표 변경(overrides)으로 과목이 바뀐 교시 */
  changed?: boolean
}

interface MealInfo {
  menu: string[]
  calorie: string
  /** 중식이 없어 다른 끼니를 보여줄 때의 끼니명(조식/석식) */
  otherMealName?: string
}

interface EventInfo {
  date: string // YYYYMMDD
  name: string
}

interface OffDayInfo {
  /** 학사일정의 쉬는 날 이름(예: '한글날'). 주말처럼 이름이 없으면 '' */
  name: string
}

const WEEKDAY_LABELS = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'] as const
// getUTCDay() 인덱스(0=일) → Firestore 시간표 문서의 요일 키
const DAY_KEYS = ['', 'mon', 'tue', 'wed', 'thu', 'fri', ''] as const

/** KST 기준 현재 시각. 반환된 Date는 반드시 getUTC* 계열로만 읽어야 합니다. */
function kstNow(): Date {
  return new Date(Date.now() + 9 * 60 * 60 * 1000)
}

function ymdOf(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

/** YYYYMMDD → 그날 0시(UTC 기준 Date) — getUTC* 계열로만 읽습니다. */
function parseYmd(ymd: string): Date {
  return new Date(
    Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)))
  )
}

/** '김치찌개 (5.9.13)' → 메뉴 이름과 알레르기 숫자 표기를 분리 */
function splitAllergy(item: string): { name: string; allergy: string | null } {
  const m = item.match(/^(.*?)\s*\(([0-9][0-9.,\s]*)\)\s*$/)
  if (m && m[1]) {
    return { name: m[1].trim(), allergy: m[2].replace(/\s/g, '') }
  }
  return { name: item, allergy: null }
}

function formatEventDate(ymd: string): string {
  if (ymd.length !== 8) return ymd
  return `${Number(ymd.slice(4, 6))}월 ${Number(ymd.slice(6, 8))}일`
}

function SkeletonLines({ rows }: { rows: number }): JSX.Element {
  const items: JSX.Element[] = []
  for (let i = 0; i < rows; i++) {
    items.push(<div key={i} className="h-9 rounded-lg bg-gray-100" />)
  }
  return <div className="mt-3 animate-pulse space-y-2">{items}</div>
}

export default function TodayCard({
  schoolCode,
  schoolName,
  grade,
  classNm,
  classId,
  teacherUid,
  onMealLoaded,
}: TodayCardProps): JSX.Element {
  const [loading, setLoading] = useState<boolean>(true)
  const [periods, setPeriods] = useState<PeriodItem[]>([])
  const [teacherState, setTeacherState] = useState<{
    uid: string
    status: 'ready' | 'error'
    schedule?: unknown
  } | null>(null)
  const [teacherRetry, setTeacherRetry] = useState(0)
  const [meal, setMeal] = useState<MealInfo | null>(null)
  const [nextEvent, setNextEvent] = useState<EventInfo | null>(null)
  // 오늘이 쉬는 날(주말·휴업일·공휴일·방학)이면 시간표 대신 안내를 보여 줍니다.
  const [offDay, setOffDay] = useState<OffDayInfo | null>(null)
  // 업로드된 학교 시간표의 교시 시작 시각 (없으면 학교급 기본 시각)
  const [periodStarts, setPeriodStarts] = useState<string[] | null>(null)
  const [nowMin, setNowMin] = useState<number>(() => {
    const n = kstNow()
    return n.getUTCHours() * 60 + n.getUTCMinutes()
  })
  // 오늘(KST) — 화면을 띄워 둔 채 날짜가 바뀌면 이 값이 바뀌어 오늘 데이터를 다시 불러옵니다.
  const [todayYmd, setTodayYmd] = useState<string>(() => ymdOf(kstNow()))

  useEffect(() => {
    if (!teacherUid) return
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    setTeacherState(null)
    const fail = (): void => {
      if (!cancelled) setTeacherState({ uid: teacherUid, status: 'error' })
    }
    void import('../lib/firebase').then(({ db }) => {
      if (cancelled) return
      unsubscribe = onSnapshot(doc(db, 'users', teacherUid), (snap) => {
        if (cancelled) return
        if (!snap.exists()) { fail(); return }
        setTeacherState({ uid: teacherUid, status: 'ready', schedule: snap.data().mySchedule })
      }, fail)
    }).catch(fail)
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [teacherUid, teacherRetry])

  const ownTimetable = useMemo(
    () => teacherHomeTimetable(teacherState?.uid === teacherUid ? teacherState?.schedule : null, todayYmd),
    [teacherState, teacherUid, todayYmd]
  )

  // 렌더마다 새 함수가 와도 다시 불러오지 않도록 최신 콜백만 ref로 들고 있습니다.
  const onMealLoadedRef = useRef(onMealLoaded)
  useEffect(() => {
    onMealLoadedRef.current = onMealLoaded
  })

  // 1분마다 현재 교시 하이라이트·날짜 갱신 (백그라운드에서 돌아올 때도 바로 확인)
  useEffect(() => {
    const tick = (): void => {
      const n = kstNow()
      setNowMin(n.getUTCHours() * 60 + n.getUTCMinutes())
      setTodayYmd(ymdOf(n))
    }
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') tick()
    }
    const t = setInterval(tick, 60000)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setOffDay(null)
    onMealLoadedRef.current?.(false)

    const load = async (): Promise<void> => {
      const today = todayYmd
      const base = parseYmd(today)
      const weekLater = ymdOf(new Date(base.getTime() + 7 * 86400000))
      const dayIdx = base.getUTCDay()

      const fetchJson = async (url: string): Promise<Record<string, unknown> | null> => {
        try {
          const res = await fetch(url)
          if (!res.ok) return null
          return (await res.json()) as Record<string, unknown>
        } catch {
          return null
        }
      }

      const s = encodeURIComponent(schoolCode)
      const g = encodeURIComponent(String(grade))
      const c = encodeURIComponent(String(classNm))

      const [ttData, mealData, calData] = await Promise.all([
        teacherUid ? Promise.resolve(null) : fetchJson(`/api/timetable?schoolCode=${s}&grade=${g}&classNm=${c}&from=${today}&to=${today}`),
        fetchJson(`/api/meals?schoolCode=${s}&from=${today}&to=${today}`),
        fetchJson(`/api/calendar?schoolCode=${s}&from=${today}&to=${weekLater}`),
      ])

      // --- 오늘 시간표: NEIS 우선, 비어 있으면 Firestore 학급 시간표로 대체 ---
      let list: PeriodItem[] = []
      const rows =
        (ttData?.timetable as Array<{ date?: string; period?: number; subject?: string }> | undefined) ?? []
      const byPeriod = new Map<number, string>()
      for (const row of rows) {
        if (row.date && row.date !== today) continue
        const p = Number(row.period)
        const subject = String(row.subject ?? '').trim()
        if (!p || !subject || byPeriod.has(p)) continue
        byPeriod.set(p, subject)
      }
      byPeriod.forEach((subject, period) => {
        list.push({ period, subject })
      })
      list.sort((a, b) => a.period - b.period)

      // --- 쉬는 날: NEIS 시간표가 없고 주말이거나 학사일정상 휴업일·공휴일·방학이면 ---
      // 일정 조회가 실패하면(calData 없음) 평일은 기존처럼 요일 시간표로 대체합니다.
      const eventsArr = (calData?.events as CalendarEventLike[] | undefined) ?? []
      // 교사는 여러 학년을 가르치므로 담임 학년만 쉬는 날에 모든 수업을 숨기지 않습니다.
      const schoolGrades = schoolLevelOf(schoolName) === 'elementary' ? [1, 2, 3, 4, 5, 6] : [1, 2, 3]
      const offEvents = teacherUid
        ? eventsArr.filter((e) => !Array.isArray(e.offGrades) || schoolGrades.every((g) => e.offGrades!.includes(g)))
        : eventsArr
      const off: OffDayInfo | null = list.length === 0 ? offDayOn(today, offEvents, teacherUid ? undefined : grade) : null

      if (!teacherUid && list.length === 0 && classId && !off) {
        const dayKey = DAY_KEYS[dayIdx]
        if (dayKey) {
          try {
            const { db } = await import('../lib/firebase')
            const snap = await getDoc(doc(db, 'classes', classId, 'info', 'timetable'))
            if (snap.exists()) {
              const arr = (snap.data() as Record<string, unknown>)[dayKey]
              if (Array.isArray(arr)) {
                list = arr
                  .map((subject, i) => ({ period: i + 1, subject: String(subject ?? '').trim() }))
                  .filter((p) => p.subject.length > 0)
              }
            }
          } catch {
            // Firestore 조회 실패 시 빈 시간표로 표시
          }
        }
      }

      // --- 오늘 시간표 변경(overrides) 오버레이: 있으면 해당 교시 과목을 덮어씀 ---
      // 쉬는 날에는 변경 문서가 있어도(공휴일로 잡힌 교환 등) 적용하지 않고 쉬는 날 안내를 보여 줍니다.
      if (!teacherUid && classId && !off) {
        try {
          const { db } = await import('../lib/firebase')
          const ovSnap = await getDoc(doc(db, 'classes', classId, 'overrides', today))
          if (ovSnap.exists()) {
            const periodsObj = (ovSnap.data() as { periods?: Record<string, { subject?: unknown }> })
              .periods
            if (periodsObj && typeof periodsObj === 'object') {
              for (const key of Object.keys(periodsObj)) {
                const p = Number(key)
                const subject = String(periodsObj[key]?.subject ?? '').trim()
                if (!p || !subject) continue
                const existing = list.find((item) => item.period === p)
                if (existing) {
                  existing.subject = subject
                  existing.changed = true
                } else {
                  list.push({ period: p, subject, changed: true })
                }
              }
              list.sort((a, b) => a.period - b.period)
            }
          }
        } catch {
          // 변경 정보 조회 실패 시 원래 시간표 그대로 표시
        }
      }

      // --- 오늘 급식 (조식/석식이 함께 오면 중식 우선) ---
      const mealsArr =
        (mealData?.meals as
          | Array<{ date?: string; menu?: unknown; calorie?: string; mealCode?: string; mealType?: string }>
          | undefined) ?? []
      const todays = mealsArr.filter((m) => m.date === today)
      const todayMeal = pickMainMeal(todays.length > 0 ? todays : mealsArr)
      const mealInfo: MealInfo | null =
        todayMeal && Array.isArray(todayMeal.menu) && todayMeal.menu.length > 0
          ? {
              menu: todayMeal.menu.map((x) => String(x)),
              calorie: String(todayMeal.calorie ?? ''),
              otherMealName:
                todayMeal.mealCode && String(todayMeal.mealCode) !== '2' && todayMeal.mealType
                  ? String(todayMeal.mealType)
                  : undefined,
            }
          : null

      // --- 다가오는 학사일정 (오늘~+7일 중 가장 가까운 1건) ---
      // NEIS는 토요일마다 '토요휴업일'을 내려줘 실제 행사를 가리므로 제외합니다.
      const upcoming =
        eventsArr
          .filter((e): e is { date: string; name: string } =>
            Boolean(e.date && e.name && e.date >= today && e.name !== '토요휴업일')
          )
          .sort((a, b) => (a.date < b.date ? -1 : 1))[0] ?? null

      if (cancelled) return
      setPeriods(list)
      setOffDay(off)
      setMeal(mealInfo)
      setNextEvent(upcoming)
      setLoading(false)
      onMealLoadedRef.current?.(mealInfo !== null)
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [schoolCode, schoolName, grade, classNm, classId, todayYmd, teacherUid])

  // 학급 교시 시각 (classes/{classId}/info/periodTimes — 시간표 엑셀 업로드 때 복사됨)
  useEffect(() => {
    setPeriodStarts(null)
    if (!classId) return
    let cancelled = false
    ;(async () => {
      try {
        const { db } = await import('../lib/firebase')
        const snap = await getDoc(doc(db, 'classes', classId, 'info', 'periodTimes'))
        const times = snap.exists() ? (snap.data() as { times?: unknown }).times : undefined
        if (!cancelled && Array.isArray(times)) {
          setPeriodStarts(times.map((t) => (typeof t === 'string' ? t : '')))
        }
      } catch {
        // 못 읽으면 학교급 기본 시각으로 판별
      }
    })()
    return () => {
      cancelled = true
    }
  }, [classId])

  const ranges = useMemo(
    () => periodRanges(schoolLevelOf(schoolName), periodStarts ?? undefined),
    [schoolName, periodStarts]
  )

  const currentPeriod = useMemo<number>(
    () => (offDay ? 0 : currentPeriodAt(nowMin, ranges)),
    [nowMin, ranges, offDay]
  )

  const hasOverride = useMemo<boolean>(() => periods.some((p) => p.changed === true), [periods])
  const visiblePeriods: PeriodItem[] = teacherUid ? (offDay ? [] : ownTimetable.periods) : periods
  const timetableLoading = teacherUid ? teacherState?.uid !== teacherUid : loading
  const timetableError = teacherUid && teacherState?.uid === teacherUid && teacherState.status === 'error'

  // 헤더 날짜도 불러온 데이터와 같은 날(todayYmd) 기준으로 표시합니다.
  const header = parseYmd(todayYmd)
  const dateLabel = `${header.getUTCMonth() + 1}월 ${header.getUTCDate()}일 ${WEEKDAY_LABELS[header.getUTCDay()]}`

  return (
    <section className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-lg">
      {/* 헤더: 오늘 날짜 + 학교명 */}
      <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-4">
        <div>
          <p className="text-xs font-semibold text-blue-600">오늘</p>
          <h2 className="text-lg font-bold text-gray-900">{dateLabel}</h2>
        </div>
        <span className="break-keep text-right text-sm text-gray-500">{schoolName}</span>
      </div>

      {/* 시간표 변경 안내 배너 */}
      {!teacherUid && !loading && hasOverride && (
        <div className="flex items-center gap-1.5 border-b border-amber-100 bg-amber-50 px-5 py-2 text-xs font-medium text-amber-800">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          >
            <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
            <path d="M12 9v4M12 17h.01" />
          </svg>
          오늘 시간표가 변경됐어요
        </div>
      )}

      {/* 다가오는 학사일정 (없으면 숨김) */}
      {!loading && nextEvent && (
        <div className="px-5 pt-4">
          <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-3.5 w-3.5"
              aria-hidden="true"
            >
              <rect x="3" y="5" width="18" height="16" rx="2" />
              <path d="M8 3v4M16 3v4M3 10h18" />
            </svg>
            <span className="shrink-0">{formatEventDate(nextEvent.date)} ·</span>
            <span className="min-w-0 truncate">{nextEvent.name}</span>
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2">
        {/* 오늘 시간표 타임라인 */}
        <div>
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-700">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4 text-blue-600"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 3" />
              </svg>
              {teacherUid ? '오늘의 내 수업' : '오늘 시간표'}
            </h3>
            {teacherUid && (
              <Link href="/teacher/my-schedule" className="flex min-h-[44px] shrink-0 items-center text-xs font-semibold text-blue-600">
                주간 시간표 →
              </Link>
            )}
          </div>
          {timetableLoading ? (
            <SkeletonLines rows={4} />
          ) : timetableError ? (
            <div role="alert" className="mt-3 rounded-lg bg-gray-50 px-4 py-5 text-center text-sm text-gray-600">
              내 시간표를 불러오지 못했어요.
              <button type="button" onClick={() => setTeacherRetry((n) => n + 1)} className="mx-auto mt-1 block min-h-[44px] px-4 font-semibold text-blue-600">
                다시 불러오기
              </button>
            </div>
          ) : visiblePeriods.length === 0 && offDay ? (
            <p className="mt-3 rounded-lg bg-gray-50 px-4 py-6 text-center text-sm text-gray-500 break-keep">
              오늘은 쉬는 날이에요
              {offDay.name && (
                <span className="mt-1 block text-xs font-semibold text-gray-700">{offDay.name}</span>
              )}
            </p>
          ) : visiblePeriods.length === 0 ? (
            <p className="mt-3 rounded-lg bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
              {teacherUid
                ? ownTimetable.hasSchedule ? '오늘은 등록된 수업이 없어요' : '아직 내 시간표가 등록되지 않았어요'
                : '오늘 시간표 정보가 없어요'}
              {teacherUid && !ownTimetable.hasSchedule && (
                <Link href="/teacher/my-schedule" className="mt-2 flex min-h-[44px] items-center justify-center font-semibold text-blue-600">
                  내 시간표 불러오기
                </Link>
              )}
            </p>
          ) : (
            <ol className="mt-3 space-y-1.5">
              {visiblePeriods.map((p) => {
                const isNow = p.period === currentPeriod
                return (
                  <li
                    key={p.period}
                    className={`flex items-center gap-3 rounded-lg px-3 py-2 ${
                      isNow ? 'bg-blue-50 ring-2 ring-blue-500' : 'bg-gray-50'
                    }`}
                  >
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                        isNow ? 'bg-blue-600 text-white' : 'bg-white text-gray-500 ring-1 ring-gray-200'
                      }`}
                    >
                      {p.period}
                    </span>
                    <span
                      className={`min-w-0 flex-1 break-words text-sm ${
                        isNow
                          ? 'font-semibold text-blue-900'
                          : p.changed
                            ? 'font-semibold text-gray-900'
                            : 'text-gray-700'
                      }`}
                    >
                      {p.subject}
                    </span>
                    {p.changed && (
                      <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 ring-1 ring-amber-200">
                        변경
                      </span>
                    )}
                    {isNow && (
                      <span className="shrink-0 rounded-full bg-blue-600 px-2 py-0.5 text-[11px] font-semibold text-white">
                        지금
                      </span>
                    )}
                  </li>
                )
              })}
            </ol>
          )}
        </div>

        {/* 오늘 급식 */}
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-700">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4 text-orange-500"
              aria-hidden="true"
            >
              <path d="M4 3v7a2 2 0 0 0 2 2h0a2 2 0 0 0 2-2V3" />
              <path d="M6 3v18" />
              <path d="M15 3c-1.7 0-3 2-3 5s1.3 5 3 5v8" />
              <path d="M15 3c1.7 0 3 2 3 5s-1.3 5-3 5" />
            </svg>
            오늘 급식
            {!loading && meal?.otherMealName && (
              <span className="text-xs font-medium text-gray-400">· {meal.otherMealName}</span>
            )}
          </h3>
          {loading ? (
            <SkeletonLines rows={4} />
          ) : !meal ? (
            <p className="mt-3 rounded-lg bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
              오늘은 급식 정보가 없어요
            </p>
          ) : (
            <div className="mt-3 rounded-lg bg-orange-50 p-4 ring-1 ring-orange-100">
              <ul className="space-y-1">
                {meal.menu.map((item, i) => {
                  const { name, allergy } = splitAllergy(item)
                  return (
                    <li key={i} className="break-keep text-sm text-gray-800">
                      {name}
                      {allergy && (
                        <span className="ml-1 align-middle text-[10px] text-gray-400">({allergy})</span>
                      )}
                    </li>
                  )
                })}
              </ul>
              {meal.calorie && <p className="mt-2 text-right text-xs text-gray-400">{meal.calorie}</p>}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
