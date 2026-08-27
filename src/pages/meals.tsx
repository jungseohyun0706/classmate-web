import { useEffect, useState, type FormEvent, type JSX } from 'react'
import Link from 'next/link'
import Head from 'next/head'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth } from '../lib/firebase'
import MealRating from '../components/MealRating'
import { ensureSignedIn, getMonthlyTop, getRating, type MonthlyTopEntry } from '../lib/meals'

const SCHOOL_STORAGE_KEY = 'classmate_meal_school'
const WEEKDAY_LABELS = ['월', '화', '수', '목', '금'] as const

interface SchoolPick {
  code: string
  name: string
}

interface SchoolResult {
  code: string
  officeCode: string
  name: string
  address: string
  kind: string
}

interface ApiMeal {
  date: string
  menu: string[]
  calorie: string
}

interface WeekBar {
  ymd: string
  label: string
  avg: number | null
}

/** KST 기준 현재 시각 — 반환값은 getUTC* 계열로만 읽습니다. */
function kstNow(): Date {
  return new Date(Date.now() + 9 * 60 * 60 * 1000)
}

function ymdOf(d: Date): string {
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${d.getUTCFullYear()}${m}${day}`
}

/** 이번 주 월~금 (YYYYMMDD) */
function weekdaysOfThisWeek(): string[] {
  const now = kstNow()
  const monday = new Date(now.getTime() - ((now.getUTCDay() + 6) % 7) * 86400000)
  return WEEKDAY_LABELS.map((_, i) => ymdOf(new Date(monday.getTime() + i * 86400000)))
}

function formatYmd(ymd: string): string {
  return `${Number(ymd.slice(4, 6))}월 ${Number(ymd.slice(6, 8))}일`
}

/** '메뉴명 (1.5.6.)' → 메뉴명과 알레르기 숫자를 분리합니다. */
function splitAllergy(item: string): { name: string; allergy: string | null } {
  const m = item.match(/^(.*?)\s*\(([0-9][0-9.,\s]*)\)\s*$/)
  if (m && m[1]) {
    return { name: m[1], allergy: m[2].replace(/[.,\s]+$/, '') }
  }
  return { name: item, allergy: null }
}

function loadSavedSchool(): SchoolPick | null {
  try {
    const raw = window.localStorage.getItem(SCHOOL_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { code?: unknown; name?: unknown }
    if (typeof parsed.code === 'string' && parsed.code) {
      return { code: parsed.code, name: typeof parsed.name === 'string' ? parsed.name : '' }
    }
  } catch {
    // 저장 형식이 다르거나 접근 불가하면 무시합니다.
  }
  return null
}

function saveSchool(pick: SchoolPick): void {
  try {
    window.localStorage.setItem(SCHOOL_STORAGE_KEY, JSON.stringify(pick))
  } catch {
    // 저장 실패는 무시합니다.
  }
}

export default function MealsPage(): JSX.Element {
  const today = ymdOf(kstNow())
  const yyyymm = today.slice(0, 6)

  const [resolving, setResolving] = useState<boolean>(true)
  const [school, setSchool] = useState<SchoolPick | null>(null)
  const [homeHref, setHomeHref] = useState<string>('/')

  // 학교 검색 (학교가 없거나 변경할 때)
  const [searchOpen, setSearchOpen] = useState<boolean>(false)
  const [searchQ, setSearchQ] = useState<string>('')
  const [searching, setSearching] = useState<boolean>(false)
  const [results, setResults] = useState<SchoolResult[]>([])
  const [searched, setSearched] = useState<boolean>(false)

  // 오늘 급식
  const [todayMeal, setTodayMeal] = useState<ApiMeal | null>(null)
  const [mealLoaded, setMealLoaded] = useState<boolean>(false)

  // 이번 주 평균 + 이달의 TOP 5
  const [weekBars, setWeekBars] = useState<WeekBar[]>([])
  const [topEntries, setTopEntries] = useState<MonthlyTopEntry[]>([])
  const [topMenus, setTopMenus] = useState<Record<string, string[]>>({})
  const [ratingsLoaded, setRatingsLoaded] = useState<boolean>(false)

  // 1) 학교 결정: 로그인 사용자 문서 → localStorage → 직접 검색
  useEffect(() => {
    let cancelled = false
    const unsub = onAuthStateChanged(auth, (u) => {
      void (async () => {
        let picked: SchoolPick | null = null
        if (u && !u.isAnonymous) {
          try {
            const { db } = await import('../lib/firebase')
            const snap = await getDoc(doc(db, 'users', u.uid))
            if (snap.exists()) {
              const data = snap.data() as {
                role?: string
                schoolCode?: string
                schoolName?: string
              }
              if (data.schoolCode) {
                picked = { code: String(data.schoolCode), name: String(data.schoolName ?? '') }
              }
              if (!cancelled) {
                setHomeHref(data.role === 'teacher' ? '/dashboard' : data.role === 'student' ? '/student/today' : '/')
              }
            }
          } catch {
            // 사용자 문서를 못 읽으면 아래 저장값으로 진행합니다.
          }
        }
        if (!picked) {
          picked = loadSavedSchool()
        }
        if (cancelled) return
        if (picked) {
          setSchool(picked)
          setSearchOpen(false)
        } else {
          setSearchOpen(true)
        }
        setResolving(false)
      })()
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  // 2) 오늘 급식 메뉴
  useEffect(() => {
    const code = school?.code
    if (!code) return
    let cancelled = false
    setMealLoaded(false)
    ;(async () => {
      try {
        const res = await fetch(
          `/api/meals?schoolCode=${encodeURIComponent(code)}&from=${today}&to=${today}`
        )
        const data = (await res.json()) as { meals?: ApiMeal[] }
        if (!cancelled) {
          setTodayMeal(data.meals?.[0] ?? null)
        }
      } catch {
        if (!cancelled) setTodayMeal(null)
      } finally {
        if (!cancelled) setMealLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [school?.code, today])

  // 3) 이번 주 평균 + 이달의 TOP 5 (읽기에는 로그인이 필요해 익명 로그인을 보장합니다)
  useEffect(() => {
    const code = school?.code
    if (!code) return
    let cancelled = false
    setRatingsLoaded(false)
    ;(async () => {
      try {
        await ensureSignedIn()
      } catch {
        // 익명 로그인 실패 시 집계 없이 페이지를 보여줍니다.
        if (!cancelled) setRatingsLoaded(true)
        return
      }
      try {
        const days = weekdaysOfThisWeek()
        const [weekly, top] = await Promise.all([
          Promise.all(
            days.map((ymd) => getRating(code, ymd).catch(() => null))
          ),
          getMonthlyTop(code, yyyymm).catch(() => [] as MonthlyTopEntry[]),
        ])
        if (cancelled) return
        setWeekBars(
          days.map((ymd, i) => ({
            ymd,
            label: WEEKDAY_LABELS[i],
            avg: weekly[i] ? weekly[i]!.avg : null,
          }))
        )
        setTopEntries(top)

        // TOP 5 날짜의 메뉴 — 이번 달 급식을 한 번에 받아 매핑 (best-effort)
        if (top.length > 0) {
          try {
            const res = await fetch(
              `/api/meals?schoolCode=${encodeURIComponent(code)}&from=${yyyymm}01&to=${yyyymm}31`
            )
            const data = (await res.json()) as { meals?: ApiMeal[] }
            if (!cancelled) {
              const map: Record<string, string[]> = {}
              for (const meal of data.meals ?? []) {
                map[meal.date] = meal.menu
              }
              setTopMenus(map)
            }
          } catch {
            // 메뉴 매핑 실패는 무시하고 날짜/평점만 보여줍니다.
          }
        }
      } catch {
        // 집계 조회 실패 — 빈 상태로 둡니다.
      } finally {
        if (!cancelled) setRatingsLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [school?.code, yyyymm])

  const handleSearch = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    const q = searchQ.trim()
    if (!q || searching) return
    setSearching(true)
    setSearched(false)
    try {
      const res = await fetch(`/api/schools?q=${encodeURIComponent(q)}`)
      const data = (await res.json()) as { schools?: SchoolResult[] }
      setResults(data.schools ?? [])
    } catch {
      setResults([])
    } finally {
      setSearching(false)
      setSearched(true)
    }
  }

  const handlePickSchool = (s: SchoolResult): void => {
    const pick: SchoolPick = { code: s.code, name: s.name }
    saveSchool(pick)
    setSchool(pick)
    setSearchOpen(false)
    setResults([])
    setSearchQ('')
    setSearched(false)
  }

  const maxWeekAvg = Math.max(...weekBars.map((b) => b.avg ?? 0), 0)

  return (
    <div className="min-h-screen bg-gray-50 text-black">
      <Head>
        <title>급식 리그 | 클래스메이트</title>
      </Head>

      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex h-14 max-w-2xl items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <Link
              href={homeHref}
              aria-label="홈으로"
              className="rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-5 w-5"
                aria-hidden="true"
              >
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </Link>
            <h1 className="flex items-center gap-1.5 text-lg font-extrabold text-gray-900">
              <span aria-hidden="true">🍚</span> 급식 리그
            </h1>
          </div>
          {school && (
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="max-w-[10rem] truncate rounded-full bg-gray-100 px-3.5 py-2.5 text-xs font-semibold text-gray-600 transition-colors hover:bg-gray-200"
            >
              {school.name || '학교 변경'} ▾
            </button>
          )}
        </div>
      </header>

      <main
        className="mx-auto max-w-2xl space-y-5 px-4 py-5"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 2.5rem)' }}
      >
        {resolving ? (
          <div className="flex justify-center py-16">
            <div className="h-10 w-10 animate-spin rounded-full border-b-2 border-amber-500" />
          </div>
        ) : (
          <>
            {/* 학교 검색 */}
            {(searchOpen || !school) && (
              <section className="rounded-xl border border-gray-100 bg-white p-4 shadow-lg">
                <h2 className="text-sm font-semibold text-gray-700 break-keep">
                  {school ? '다른 학교의 급식 보기' : '어느 학교 급식이 궁금한가요?'}
                </h2>
                <form onSubmit={(e) => void handleSearch(e)} className="mt-3 flex gap-2">
                  <input
                    type="search"
                    value={searchQ}
                    onChange={(e) => setSearchQ(e.target.value)}
                    placeholder="학교 이름으로 검색 (예: 한빛초)"
                    className="min-w-0 flex-1 rounded-xl border border-gray-200 px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
                  />
                  <button
                    type="submit"
                    disabled={searching || !searchQ.trim()}
                    className="shrink-0 rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-amber-600 disabled:cursor-default disabled:opacity-50"
                  >
                    {searching ? '검색 중…' : '검색'}
                  </button>
                </form>
                {searched && results.length === 0 && (
                  <p className="mt-3 text-center text-sm text-gray-400 break-keep">
                    검색 결과가 없어요. 학교 이름을 다시 확인해 주세요.
                  </p>
                )}
                {results.length > 0 && (
                  <ul className="mt-3 max-h-64 divide-y divide-gray-100 overflow-y-auto rounded-xl border border-gray-100">
                    {results.map((s) => (
                      <li key={`${s.officeCode}_${s.code}`}>
                        <button
                          type="button"
                          onClick={() => handlePickSchool(s)}
                          className="flex w-full flex-col items-start gap-0.5 px-3.5 py-2.5 text-left transition-colors hover:bg-amber-50"
                        >
                          <span className="text-sm font-semibold text-gray-900">{s.name}</span>
                          <span className="text-xs text-gray-400">
                            {s.kind} · {s.address}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {school && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchOpen(false)
                      setResults([])
                      setSearched(false)
                    }}
                    className="mt-3 w-full rounded-xl bg-gray-100 py-2.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-200"
                  >
                    닫기
                  </button>
                )}
              </section>
            )}

            {school && (
              <>
                {/* 오늘 급식 + 별점 */}
                <section className="rounded-xl border border-gray-100 bg-white p-4 shadow-lg">
                  <div className="flex items-baseline justify-between">
                    <h2 className="text-sm font-semibold text-gray-700">오늘 급식</h2>
                    <span className="text-xs text-gray-400">
                      {formatYmd(today)}
                      {todayMeal?.calorie ? ` · ${todayMeal.calorie}` : ''}
                    </span>
                  </div>

                  {!mealLoaded ? (
                    <p className="py-6 text-center text-sm text-gray-400">
                      메뉴를 불러오는 중이에요…
                    </p>
                  ) : todayMeal && todayMeal.menu.length > 0 ? (
                    <ul className="mt-3 space-y-1.5">
                      {todayMeal.menu.map((item, i) => {
                        const { name, allergy } = splitAllergy(item)
                        return (
                          <li key={`${item}_${i}`} className="text-sm text-gray-800 break-keep">
                            {name}
                            {allergy && (
                              <span className="ml-1.5 text-[11px] text-gray-400">{allergy}</span>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  ) : (
                    <p className="py-6 text-center text-sm text-gray-400 break-keep">
                      오늘은 급식 정보가 없어요
                    </p>
                  )}

                  <div className="mt-4 border-t border-gray-100 pt-4">
                    <p className="mb-2.5 text-sm font-semibold text-gray-700 break-keep">
                      오늘 급식, 어땠나요?
                    </p>
                    <MealRating schoolCode={school.code} ymd={today} />
                  </div>
                </section>

                {/* 이번 주 평균 */}
                <section className="rounded-xl border border-gray-100 bg-white p-4 shadow-lg">
                  <h2 className="text-sm font-semibold text-gray-700">이번 주 급식 평균</h2>
                  {!ratingsLoaded ? (
                    <p className="py-6 text-center text-sm text-gray-400">불러오는 중이에요…</p>
                  ) : maxWeekAvg === 0 ? (
                    <p className="py-6 text-center text-sm text-gray-400 break-keep">
                      이번 주에는 아직 평가가 없어요
                    </p>
                  ) : (
                    <div className="mt-3 flex items-end justify-between gap-2">
                      {weekBars.map((bar) => {
                        const isToday = bar.ymd === today
                        return (
                          <div key={bar.ymd} className="flex flex-1 flex-col items-center gap-1">
                            <span
                              className={`text-[11px] font-semibold ${
                                bar.avg !== null ? 'text-gray-700' : 'text-gray-300'
                              }`}
                            >
                              {bar.avg !== null ? bar.avg.toFixed(1) : '–'}
                            </span>
                            <div className="flex h-16 w-full max-w-[2.5rem] items-end rounded-md bg-gray-100">
                              <div
                                className={`w-full rounded-md ${
                                  isToday ? 'bg-amber-500' : 'bg-amber-300'
                                }`}
                                style={{
                                  height: `${bar.avg !== null ? Math.max(8, (bar.avg / 5) * 100) : 0}%`,
                                }}
                              />
                            </div>
                            <span
                              className={`text-xs ${
                                isToday ? 'font-bold text-amber-600' : 'text-gray-400'
                              }`}
                            >
                              {bar.label}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </section>

                {/* 이달의 최애 급식 TOP 5 */}
                <section className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-lg">
                  <div className="border-b border-gray-100 px-4 py-3">
                    <h2 className="flex items-center gap-1.5 text-sm font-semibold text-gray-700">
                      <span aria-hidden="true">🏆</span> 이달의 최애 급식 TOP 5
                    </h2>
                  </div>
                  {!ratingsLoaded ? (
                    <p className="px-4 py-8 text-center text-sm text-gray-400">불러오는 중이에요…</p>
                  ) : topEntries.length === 0 ? (
                    <p className="px-4 py-8 text-center text-sm text-gray-400 break-keep">
                      아직 순위가 없어요. 3명 이상 평가한 날부터 순위에 올라요!
                    </p>
                  ) : (
                    <ol className="divide-y divide-gray-100">
                      {topEntries.map((entry, i) => {
                        const menu = (topMenus[entry.date] ?? [])
                          .slice(0, 2)
                          .map((item) => splitAllergy(item).name)
                        return (
                          <li key={entry.date} className="flex items-center gap-3 px-4 py-3">
                            <span
                              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                                i === 0
                                  ? 'bg-amber-400 text-white'
                                  : i === 1
                                    ? 'bg-gray-300 text-white'
                                    : i === 2
                                      ? 'bg-orange-300 text-white'
                                      : 'bg-gray-100 text-gray-500'
                              }`}
                            >
                              {i + 1}
                            </span>
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-semibold text-gray-900">
                                {formatYmd(entry.date)}
                              </p>
                              <p className="mt-0.5 truncate text-xs text-gray-400">
                                {menu.length > 0 ? menu.join(' · ') : '메뉴 정보 없음'}
                              </p>
                            </div>
                            <div className="shrink-0 text-right">
                              <p className="text-sm font-bold text-amber-600">
                                ★ {entry.avg.toFixed(1)}
                              </p>
                              <p className="text-[11px] text-gray-400">{entry.total}명 참여</p>
                            </div>
                          </li>
                        )
                      })}
                    </ol>
                  )}
                </section>

                <p className="text-center text-xs text-gray-400 break-keep">
                  별점은 학교별로 모여요. 로그인하지 않아도 참여할 수 있습니다.
                </p>
              </>
            )}
          </>
        )}
      </main>
    </div>
  )
}
