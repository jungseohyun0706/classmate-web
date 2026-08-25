import { useEffect, useRef, useState, type JSX } from 'react'
import { useRouter } from 'next/router'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth } from '../lib/firebase'

interface CalendarEvent {
  date: string // YYYYMMDD
  name: string
}

interface UserDoc {
  role?: string
  schoolCode?: string | number
  schoolName?: string
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const

/** KST 기준 현재 시각 — 반환값은 getUTC* 계열로만 읽습니다. */
function kstNow(): Date {
  return new Date(Date.now() + 9 * 60 * 60 * 1000)
}

function ymdOf(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function daysBetweenYmd(from: string, to: string): number {
  const a = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(4, 6)) - 1, Number(from.slice(6, 8)))
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(4, 6)) - 1, Number(to.slice(6, 8)))
  return Math.round((b - a) / 86400000)
}

/** YYYYMMDD → 요일 인덱스(0=일) */
function weekdayOf(ymd: string): number {
  return new Date(
    Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)))
  ).getUTCDay()
}

export default function CalendarPage(): JSX.Element {
  const router = useRouter()
  const [loading, setLoading] = useState<boolean>(true)
  const [userData, setUserData] = useState<UserDoc | null>(null)
  const [ym, setYm] = useState<{ y: number; m: number }>(() => {
    const now = kstNow()
    return { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1 }
  })
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [monthLoading, setMonthLoading] = useState<boolean>(false)
  // 월별 결과 캐시 — 같은 달을 다시 열면 재요청하지 않습니다.
  const cacheRef = useRef<Map<string, CalendarEvent[]>>(new Map())

  // 로그인 가드 — users 문서가 있는 사용자라면 누구나 볼 수 있습니다.
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.replace('/auth/login')
        return
      }
      try {
        const { db } = await import('../lib/firebase')
        const snap = await getDoc(doc(db, 'users', u.uid))
        if (!snap.exists()) {
          router.replace('/dashboard')
          return
        }
        setUserData(snap.data() as UserDoc)
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    })
    return () => unsub()
  }, [router])

  // 월이 바뀔 때마다 해당 월의 학사일정을 조회합니다 (캐시 우선).
  useEffect(() => {
    const schoolCode = userData?.schoolCode
    if (!schoolCode) return
    const key = `${ym.y}-${ym.m}`
    const cached = cacheRef.current.get(key)
    if (cached) {
      setEvents(cached)
      return
    }
    let cancelled = false
    setMonthLoading(true)
    ;(async () => {
      try {
        const mm = String(ym.m).padStart(2, '0')
        const lastDay = new Date(Date.UTC(ym.y, ym.m, 0)).getUTCDate()
        const from = `${ym.y}${mm}01`
        const to = `${ym.y}${mm}${String(lastDay).padStart(2, '0')}`
        const res = await fetch(
          `/api/calendar?schoolCode=${encodeURIComponent(String(schoolCode))}&from=${from}&to=${to}`
        )
        const data = res.ok
          ? ((await res.json()) as { events?: Array<{ date?: string; name?: string }> })
          : { events: [] }
        const list = (data.events ?? [])
          .filter((e): e is CalendarEvent => Boolean(e.date && e.name))
          .sort((a, b) => (a.date < b.date ? -1 : 1))
        if (!cancelled) {
          cacheRef.current.set(key, list)
          setEvents(list)
        }
      } catch {
        if (!cancelled) setEvents([])
      } finally {
        if (!cancelled) setMonthLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [userData?.schoolCode, ym])

  const moveMonth = (delta: number): void => {
    setYm((prev) => {
      const idx = prev.y * 12 + (prev.m - 1) + delta
      return { y: Math.floor(idx / 12), m: (idx % 12) + 1 }
    })
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-gray-400" />
      </div>
    )
  }

  const isStudent = userData?.role === 'student'
  const backPath = isStudent ? '/student/today' : '/dashboard'
  // 역할별 포인트 색 — 학생은 에메랄드, 교사는 파랑
  const c = isStudent
    ? {
        text: 'text-emerald-600',
        hoverText: 'hover:text-emerald-700',
        bgSoft: 'bg-emerald-50/60',
        chip: 'bg-emerald-100 text-emerald-800',
        spinner: 'border-emerald-600',
      }
    : {
        text: 'text-blue-600',
        hoverText: 'hover:text-blue-700',
        bgSoft: 'bg-blue-50/60',
        chip: 'bg-blue-100 text-blue-800',
        spinner: 'border-blue-600',
      }

  const today = ymdOf(kstNow())
  const hasSchool = Boolean(userData?.schoolCode)

  // 날짜별로 묶은 아젠다 목록
  const grouped: Array<[string, string[]]> = (() => {
    const map = new Map<string, string[]>()
    for (const e of events) {
      const list = map.get(e.date)
      if (list) list.push(e.name)
      else map.set(e.date, [e.name])
    }
    return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1))
  })()

  return (
    <div className="min-h-screen bg-gray-50 text-black">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-2 px-4">
          <button
            type="button"
            onClick={() => router.push(backPath)}
            aria-label="뒤로 가기"
            className="-ml-2 rounded-full p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
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
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-lg font-bold text-gray-900">학사일정</h1>
          {userData?.schoolName && (
            <span className="ml-auto truncate text-sm text-gray-500">{userData.schoolName}</span>
          )}
        </div>
      </header>

      <main
        className="mx-auto max-w-2xl space-y-4 px-4 py-5"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 2rem)' }}
      >
        {!hasSchool ? (
          <div className="rounded-xl border border-gray-100 bg-white p-8 text-center shadow-lg">
            <h2 className="text-lg font-bold text-gray-900 break-keep">아직 학교 정보가 없어요</h2>
            <p className="mt-2 text-sm leading-relaxed text-gray-500 break-keep">
              {isStudent
                ? '선생님 QR로 우리 반에 들어가면 학사일정을 볼 수 있어요.'
                : '학교와 학급을 먼저 등록하면 학사일정을 볼 수 있어요.'}
            </p>
          </div>
        ) : (
          <>
            {/* 월 이동 내비게이션 */}
            <div className="flex items-center justify-between rounded-xl border border-gray-100 bg-white px-2 py-2 shadow-lg">
              <button
                type="button"
                onClick={() => moveMonth(-1)}
                aria-label="이전 달"
                className="rounded-full p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
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
              </button>
              <span className="text-base font-bold text-gray-900">
                {ym.y}년 {ym.m}월
              </span>
              <button
                type="button"
                onClick={() => moveMonth(1)}
                aria-label="다음 달"
                className="rounded-full p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
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
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>
            </div>

            {/* 아젠다 목록 */}
            {monthLoading ? (
              <div className="flex items-center justify-center rounded-xl border border-gray-100 bg-white py-16 shadow-lg">
                <div className={`h-8 w-8 animate-spin rounded-full border-b-2 ${c.spinner}`} />
              </div>
            ) : grouped.length === 0 ? (
              <div className="rounded-xl border border-gray-100 bg-white p-10 text-center shadow-lg">
                <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-100 text-gray-400">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-6 w-6"
                    aria-hidden="true"
                  >
                    <rect x="3" y="4" width="18" height="17" rx="2" />
                    <path d="M8 2v4M16 2v4M3 9h18" />
                  </svg>
                </span>
                <p className="mt-3 text-sm text-gray-500">이번 달 학사일정이 없어요</p>
              </div>
            ) : (
              <section className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-lg">
                <ul className="divide-y divide-gray-100">
                  {grouped.map(([date, names]) => {
                    const isToday = date === today
                    const dday = daysBetweenYmd(today, date)
                    const showDday = dday >= 0 && dday <= 7
                    const weekday = weekdayOf(date)
                    const weekdayColor = isToday
                      ? c.text
                      : weekday === 0
                        ? 'text-red-500'
                        : weekday === 6
                          ? 'text-blue-500'
                          : 'text-gray-500'
                    return (
                      <li
                        key={date}
                        className={`px-4 py-3 ${isToday ? c.bgSoft : ''}`}
                      >
                        <div className="flex items-center gap-2">
                          <p
                            className={`text-sm font-semibold ${
                              isToday ? c.text : 'text-gray-900'
                            }`}
                          >
                            {Number(date.slice(4, 6))}월 {Number(date.slice(6, 8))}일{' '}
                            <span className={weekdayColor}>({WEEKDAYS[weekday]})</span>
                          </p>
                          {isToday && (
                            <span
                              className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${c.chip}`}
                            >
                              오늘
                            </span>
                          )}
                          {showDday && (
                            <span className={`text-xs font-bold ${c.text}`}>
                              {dday === 0 ? 'D-DAY' : `D-${dday}`}
                            </span>
                          )}
                        </div>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {names.map((name, i) => (
                            <span
                              key={`${date}_${i}`}
                              className="inline-flex max-w-full items-center rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700"
                            >
                              <span className="truncate">{name}</span>
                            </span>
                          ))}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  )
}
