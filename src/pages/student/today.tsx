import { useEffect, useState, type JSX } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { doc, onSnapshot } from 'firebase/firestore'
import { auth } from '../../lib/firebase'
import TodayCard from '../../components/TodayCard'
import BagChecklist from '../../components/BagChecklist'
import MealRating from '../../components/MealRating'
import EnablePush from '../../components/EnablePush'
import {
  formatNoticeDate,
  getMyReceipts,
  listAnnouncements,
  type Announcement,
  type Receipt,
} from '../../lib/notices'

interface StudentData {
  role?: string
  displayName?: string
  name?: string
  classId?: string
  schoolCode?: string
  schoolName?: string
  grade?: string | number
  classNm?: string | number
  status?: 'pending' | 'approved' | 'rejected'
}

interface DdayEvent {
  date: string // YYYYMMDD
  name: string
  dday: number
}

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

export function StudentTabBar({ active }: { active: 'today' | 'notices' }): JSX.Element {
  const base = 'flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium transition-colors'
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-50 border-t border-gray-200 bg-white"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      aria-label="학생 메뉴"
    >
      <div className="mx-auto flex max-w-2xl">
        <Link
          href="/student/today"
          className={`${base} ${active === 'today' ? 'text-emerald-600' : 'text-gray-400 hover:text-gray-600'}`}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-6 w-6"
            aria-hidden="true"
          >
            <path d="M3 10.5 12 3l9 7.5" />
            <path d="M5 9.5V21h14V9.5" />
          </svg>
          오늘
        </Link>
        <Link
          href="/student/notices"
          className={`${base} ${active === 'notices' ? 'text-emerald-600' : 'text-gray-400 hover:text-gray-600'}`}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-6 w-6"
            aria-hidden="true"
          >
            <rect x="4" y="3" width="16" height="18" rx="2" />
            <path d="M8 8h8M8 12h8M8 16h5" />
          </svg>
          알림장
        </Link>
      </div>
    </nav>
  )
}

export default function StudentToday(): JSX.Element {
  const router = useRouter()
  const [loading, setLoading] = useState<boolean>(true)
  const [uid, setUid] = useState<string | null>(null)
  const [userData, setUserData] = useState<StudentData | null>(null)
  const [notices, setNotices] = useState<Announcement[]>([])
  const [receipts, setReceipts] = useState<Record<string, Receipt>>({})
  const [ddays, setDdays] = useState<DdayEvent[]>([])

  // 로그인 + 학생 역할 가드
  // 내 계정 문서를 실시간 구독 — 선생님이 승인하는 순간 새로고침 없이 반영됩니다.
  useEffect(() => {
    let unsubDoc: (() => void) | null = null
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (unsubDoc) {
        unsubDoc()
        unsubDoc = null
      }
      if (!u) {
        router.replace('/auth/login')
        return
      }
      try {
        const { db } = await import('../../lib/firebase')
        unsubDoc = onSnapshot(
          doc(db, 'users', u.uid),
          (snap) => {
            const data = snap.exists() ? (snap.data() as StudentData) : null
            if (!data || data.role !== 'student') {
              router.replace('/dashboard')
              return
            }
            setUid(u.uid)
            setUserData(data)
            setLoading(false)
          },
          (e) => {
            console.error(e)
            setLoading(false)
          }
        )
      } catch (e) {
        console.error(e)
        setLoading(false)
      }
    })
    return () => {
      if (unsubDoc) unsubDoc()
      unsub()
    }
  }, [router])

  // 최신 알림장 3건 + 내 읽음 확인
  useEffect(() => {
    const classId = userData?.classId
    if (!uid || !classId) return
    let cancelled = false
    ;(async () => {
      try {
        const list = await listAnnouncements(classId, 3)
        const mine = await getMyReceipts(classId, list.map((a) => a.id), uid)
        if (cancelled) return
        setNotices(list)
        setReceipts(mine)
      } catch {
        // 승인 전 등 권한이 없으면 알림장 미리보기를 비워 둡니다.
        if (!cancelled) setNotices([])
      }
    })()
    return () => {
      cancelled = true
    }
    // status를 의존성에 포함 — 승인되는 순간 알림장을 다시 불러옵니다.
  }, [uid, userData?.classId, userData?.status])

  // 30일 이내 학사일정 D-day 칩
  useEffect(() => {
    const schoolCode = userData?.schoolCode
    if (!schoolCode) return
    let cancelled = false
    ;(async () => {
      try {
        const now = kstNow()
        const today = ymdOf(now)
        const end = ymdOf(new Date(now.getTime() + 30 * 86400000))
        const res = await fetch(
          `/api/calendar?schoolCode=${encodeURIComponent(String(schoolCode))}&from=${today}&to=${end}`
        )
        if (!res.ok) return
        const data = (await res.json()) as { events?: Array<{ date?: string; name?: string }> }
        const events = (data.events ?? [])
          .filter((e): e is { date: string; name: string } => Boolean(e.date && e.name && e.date >= today))
          .sort((a, b) => (a.date < b.date ? -1 : 1))
          .slice(0, 3)
          .map((e) => ({ date: e.date, name: e.name, dday: daysBetweenYmd(today, e.date) }))
        if (!cancelled) setDdays(events)
      } catch {
        // 학사일정 조회 실패 시 칩을 표시하지 않습니다.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [userData?.schoolCode])

  const handleLogout = async (): Promise<void> => {
    await signOut(auth)
    router.replace('/auth/login')
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-emerald-600" />
      </div>
    )
  }

  if (!userData) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-sm rounded-xl border border-gray-100 bg-white p-8 text-center shadow-lg">
          <p className="text-sm text-gray-600 break-keep">정보를 불러오지 못했어요.</p>
          <button
            type="button"
            onClick={() => router.reload()}
            className="mt-4 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-700"
          >
            다시 시도
          </button>
        </div>
      </div>
    )
  }

  const hasClass = Boolean(userData.classId && userData.schoolCode)
  const studentName = userData.name || userData.displayName || '학생'

  return (
    <div className="min-h-screen bg-gray-50 text-black">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex h-14 max-w-2xl items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <span className="text-xl font-extrabold text-emerald-600">Classmate</span>
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
              Student
            </span>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="rounded-lg p-2 text-sm font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
          >
            로그아웃
          </button>
        </div>
      </header>

      <main
        className="mx-auto max-w-2xl space-y-5 px-4 py-5"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 6.5rem)' }}
      >
        <div>
          <h1 className="text-xl font-bold text-gray-900 break-keep">
            {hasClass
              ? `${userData.schoolName ?? ''} ${userData.grade ?? ''}학년 ${userData.classNm ?? ''}반`
              : `안녕, ${studentName}!`}
          </h1>
          <p className="mt-1 text-sm text-gray-500 break-keep">
            {hasClass ? `${studentName}, 오늘도 좋은 하루 보내요!` : '우리 반에 들어가면 소식이 여기에 보여요.'}
          </p>
        </div>

        {/* 승인 대기 배너 */}
        {userData.status === 'pending' && (
          <div className="flex items-center gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5 shrink-0 text-amber-600"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 3" />
            </svg>
            <p className="text-sm font-medium text-amber-800 break-keep">
              선생님 승인을 기다리고 있어요
            </p>
          </div>
        )}

        {!hasClass ? (
          /* 반 미가입 — QR 안내 */
          <div className="rounded-xl border border-gray-100 bg-white p-8 text-center shadow-lg">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-7 w-7"
                aria-hidden="true"
              >
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <path d="M14 14h3v3h-3zM20 14h1M14 20h1M18 18h3v3h-3z" />
              </svg>
            </span>
            <h2 className="mt-4 text-lg font-bold text-gray-900">아직 우리 반이 없어요</h2>
            <p className="mt-2 text-sm leading-relaxed text-gray-500 break-keep">
              선생님이 보여주시는 QR 코드를 휴대폰 카메라로 찍으면
              <br />
              우리 반 시간표와 알림장을 볼 수 있어요.
            </p>
          </div>
        ) : (
          <>
            <TodayCard
              schoolCode={String(userData.schoolCode)}
              schoolName={String(userData.schoolName ?? '')}
              grade={userData.grade ?? ''}
              classNm={userData.classNm ?? ''}
              classId={String(userData.classId)}
            />

            {/* 내일 가방 싸기 체크리스트 */}
            {uid && (
              <BagChecklist
                classId={String(userData.classId)}
                schoolCode={String(userData.schoolCode)}
                uid={uid}
              />
            )}

            {/* 오늘 급식 별점 (한 줄) */}
            <MealRating schoolCode={String(userData.schoolCode)} compact />

            {/* 최신 알림장 */}
            <section className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-lg">
              <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
                <h2 className="flex items-center gap-1.5 text-sm font-semibold text-gray-700">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-4 w-4 text-emerald-600"
                    aria-hidden="true"
                  >
                    <rect x="4" y="3" width="16" height="18" rx="2" />
                    <path d="M8 8h8M8 12h8M8 16h5" />
                  </svg>
                  최신 알림장
                </h2>
                <Link
                  href="/student/notices"
                  className="-m-2 p-2 text-xs font-semibold text-emerald-600 transition-colors hover:text-emerald-700"
                >
                  전체 보기 &rarr;
                </Link>
              </div>
              {notices.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-gray-500">
                  아직 볼 수 있는 알림장이 없어요
                </p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {notices.map((a) => {
                    const unread = !receipts[a.id]
                    return (
                      <li key={a.id}>
                        <Link
                          href={`/student/notices/${a.id}`}
                          className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-emerald-50/50"
                        >
                          <span
                            aria-hidden="true"
                            className={`h-2 w-2 shrink-0 rounded-full ${
                              unread ? 'bg-emerald-500' : 'bg-transparent'
                            }`}
                          />
                          <div className="min-w-0 flex-1">
                            <p
                              className={`truncate text-sm ${
                                unread ? 'font-semibold text-gray-900' : 'text-gray-700'
                              }`}
                            >
                              {a.title}
                            </p>
                            <p className="mt-0.5 text-xs text-gray-400">
                              {formatNoticeDate(a.createdAt)} · {a.authorName}
                            </p>
                          </div>
                          {a.requiresConsent && !receipts[a.id]?.consent && (
                            <span className="shrink-0 rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-600 ring-1 ring-rose-200">
                              동의 필요
                            </span>
                          )}
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>

            <EnablePush variant="student" />

            {/* 다가오는 학사일정 D-day + 바로가기 */}
            <div className="flex flex-wrap gap-2">
              {ddays.map((e) => (
                <span
                  key={`${e.date}_${e.name}`}
                  className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-medium text-gray-700 ring-1 ring-gray-200"
                >
                  <span className="font-bold text-emerald-600">
                    {e.dday === 0 ? 'D-DAY' : `D-${e.dday}`}
                  </span>
                  <span className="max-w-[10rem] truncate">{e.name}</span>
                </span>
              ))}
              <Link
                href="/meals"
                className="inline-flex items-center rounded-full bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-700"
              >
                급식 리그 &rarr;
              </Link>
              <Link
                href="/calendar"
                className="inline-flex items-center rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-emerald-700 ring-1 ring-emerald-200 transition-colors hover:bg-emerald-50"
              >
                학사일정 &rarr;
              </Link>
            </div>
          </>
        )}
      </main>

      <StudentTabBar active="today" />
    </div>
  )
}
