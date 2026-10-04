import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { doc, getDoc, onSnapshot } from 'firebase/firestore'
import { auth } from '../../lib/firebase'
import TodayCard from '../../components/TodayCard'
import DayNav from '../../components/timetable/DayNav'
import { PersonalTimetablePanel } from '../../components/timetable/PersonalTimetable'
import ClassTimetableReference from '../../components/timetable/ClassTimetableReference'
import TimetableStateCard from '../../components/timetable/TimetableStateCard'
import { lessonTitle } from '../../components/timetable/LessonCard'
import { buildDayTimetable } from '../../lib/timetable/engine'
import {
  activeCoursesOn,
  courseSchedule,
  coversDate,
  dayInput,
  useMyTimetable,
  weekdayShort,
  type CourseSlotSummary,
} from '../../lib/timetable/client'
import {
  awaitingHomeroomClass,
  classRefAutoOpen,
  classRefOffDay,
  classRefTarget,
  defaultPeriodTimes,
} from '../../lib/timetable/classRefPolicy'
import { isYmd } from '../../lib/timetable/dates'
import { usePersonalEntries } from '../../lib/timetable/personalEntries'
import { awaitingHomeroomApproval } from '../../lib/homeroomStatus'
import type { Course } from '../../lib/timetable/types'
import BagChecklist from '../../components/BagChecklist'
import MealRating from '../../components/MealRating'
import EnablePush from '../../components/EnablePush'
import { useInstallPrompt } from '../../components/ui/install'
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
  officeCode?: string
  grade?: string | number
  classNm?: string | number
  status?: 'pending' | 'approved' | 'rejected'
  /** 반 이동 신청 중인 반 (새 담임 승인 전까지 classId는 그대로) */
  pendingClassId?: string
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

export function StudentTabBar({ active }: { active: 'today' | 'notices' | 'room' }): JSX.Element {
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
          href="/class-room"
          className={`${base} ${active === 'room' ? 'text-emerald-600' : 'text-gray-400 hover:text-gray-600'}`}
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
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
          톡방
        </Link>
      </div>
    </nav>
  )
}

/** 수업 그룹(classes/{base}_g_{x})이 소속처럼 저장된 예전 학생 */
const GROUP_CLASS_RE = /_g_[A-Za-z0-9]+$/

/** 홈 '내 수업' 줄에 바로 보이는 칩 수(나머지는 '전체') */
const MAX_COURSE_CHIPS = 4

/**
 * 수업 정보 시트: 교사 이름·기본 교실·요일 교시.
 * 학생 명단은 보여 주지 않습니다(서버도 내려주지 않음). 시트를 열어도 상단 소속 학급 표시는 바뀌지 않습니다.
 */
function CourseInfoSheet({
  course,
  slots,
  onClose,
}: {
  course: Course
  slots: CourseSlotSummary[]
  onClose: () => void
}): JSX.Element {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    const last = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      last?.focus()
    }
  }, [onClose])

  const title = lessonTitle(course)
  return (
    <div className="fixed inset-0 z-[105] flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="닫기"
        tabIndex={-1}
        className="cm-backdrop-enter absolute inset-0 h-full w-full cursor-default bg-black/40"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="course-sheet-title"
        className="cm-sheet-enter relative max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 shadow-2xl sm:mx-4 sm:rounded-2xl"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1.25rem)' }}
      >
        <p className="text-xs font-semibold text-emerald-600">수업 정보</p>
        <h2 id="course-sheet-title" className="mt-0.5 text-lg font-bold text-gray-900 break-keep wrap-anywhere">
          {title}
        </h2>
        <dl className="mt-4 space-y-3 text-sm">
          {course.subject && (
            <div className="flex gap-3">
              <dt className="w-20 shrink-0 text-gray-500">과목</dt>
              <dd className="min-w-0 text-gray-900 break-keep wrap-anywhere">
                {course.subject}
                {course.section ? ` · ${course.section}` : ''}
              </dd>
            </div>
          )}
          <div className="flex gap-3">
            <dt className="w-20 shrink-0 text-gray-500">담당 선생님</dt>
            <dd className="min-w-0 text-gray-900 break-keep wrap-anywhere">
              {course.teacherNames.length ? course.teacherNames.join(', ') : '정보 없음'}
            </dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-20 shrink-0 text-gray-500">기본 교실</dt>
            <dd className="min-w-0 text-gray-900 break-keep wrap-anywhere">{course.defaultRoomName || '정보 없음'}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-20 shrink-0 text-gray-500">요일·교시</dt>
            <dd className="min-w-0 text-gray-900">
              {slots.length === 0 ? (
                <span className="text-gray-500 break-keep">아직 등록된 시간표가 없어요</span>
              ) : (
                <ul className="space-y-1">
                  {slots.map((sl) => (
                    <li key={`${sl.weekday}-${sl.period}-${sl.roomName ?? ''}`} className="break-keep wrap-anywhere">
                      {weekdayShort(sl.weekday)} {sl.period}교시
                      {sl.start ? ` (${sl.start}${sl.end ? `~${sl.end}` : ''})` : ''}
                      {sl.roomName ? <span className="text-gray-500"> · {sl.roomName}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        </dl>
        <p className="mt-4 text-[11px] leading-relaxed text-gray-400 break-keep">
          날짜별 변경은 &lsquo;오늘의 내 시간표&rsquo;에 빨간색 배지로 표시돼요.
        </p>
        <div className="mt-5 flex gap-2">
          <Link
            href="/student/courses"
            className="flex min-h-11 flex-1 items-center justify-center rounded-xl bg-slate-100 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200"
          >
            내 수업 관리
          </Link>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="min-h-11 flex-1 rounded-xl bg-emerald-600 text-sm font-semibold text-white transition-colors hover:bg-emerald-700"
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  )
}

export default function StudentToday(): JSX.Element {
  const router = useRouter()
  const { canInstall, promptInstall, isStandalone, showInstallGuide } = useInstallPrompt()
  const [loading, setLoading] = useState<boolean>(true)
  const [uid, setUid] = useState<string | null>(null)
  const [userData, setUserData] = useState<StudentData | null>(null)
  const [notices, setNotices] = useState<Announcement[]>([])
  const [receipts, setReceipts] = useState<Record<string, Receipt>>({})
  const [ddays, setDdays] = useState<DdayEvent[]>([])
  // 오늘(KST) — 화면을 띄워 둔 채 날짜가 바뀌면 D-day·가방·급식 별점을 새 날짜로 다시 불러옵니다.
  const [todayYmd, setTodayYmd] = useState<string>(() => ymdOf(kstNow()))
  // 오늘 급식이 있는지(TodayCard가 알려 줌) — 급식 없는 날에는 별점을 받지 않습니다.
  const [hasMealToday, setHasMealToday] = useState<boolean>(false)
  // 반 이동 신청 중인 반 이름 ('3학년 2반') — 반 문서를 못 읽으면 '새 반'
  const [pendingClassLabel, setPendingClassLabel] = useState<string>('')
  // 개인 시간표 카드에서 보고 있는 날짜(기본 오늘)
  const [ttDate, setTtDate] = useState<string>(() => ymdOf(kstNow()))
  // '학급 시간표(참고)' 펼침 — 학생이 고른 값(null = 아직 안 고름). 개인 시간표 자리를 대신하지 않고 그 아래 별도 영역
  const [refChoice, setRefChoice] = useState<boolean | null>(null)
  // 수업 정보 시트로 연 수업
  const [sheetCourseId, setSheetCourseId] = useState<string | null>(null)

  // 알림(저녁 '내일 가방')이 /student/today?date=YYYYMMDD로 열면 개인 시간표 카드를 그 날짜로 — 가방 체크리스트는 이 화면에 있음
  const queryDate = typeof router.query.date === 'string' && isYmd(router.query.date) ? router.query.date : null
  useEffect(() => {
    if (queryDate) setTtDate(queryDate)
  }, [queryDate])

  // 1분마다, 그리고 백그라운드에서 돌아올 때 날짜가 바뀌었는지 확인 (같은 날이면 상태 변화 없음)
  useEffect(() => {
    const check = (): void => setTodayYmd(ymdOf(kstNow()))
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') check()
    }
    const t = setInterval(check, 60000)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  // 자정이 지나면 '오늘'을 보던 개인 시간표도 새 오늘로
  const prevTodayRef = useRef<string>(todayYmd)
  useEffect(() => {
    const prev = prevTodayRef.current
    prevTodayRef.current = todayYmd
    if (prev !== todayYmd) setTtDate((d) => (d === prev ? todayYmd : d))
  }, [todayYmd])

  // 개인 시간표 자료(/api/timetable/me) + 직접 입력 일정 — 학생 계정이 확인된 뒤에만(uid는 학생일 때만 설정됨)
  const tt = useMyTimetable(uid, ttDate, { schoolCode: userData?.schoolCode ?? null })
  const personal = usePersonalEntries(uid)
  // 담임 승인·거절·반 이동으로 소속이 바뀌면 공통 수업 범위가 달라지므로 개인 시간표 자료를 다시 받음
  const homeroomKey = userData ? `${userData.status ?? ''}|${userData.classId ?? ''}` : ''
  const prevHomeroomKey = useRef(homeroomKey)
  const ttRetry = tt.retry
  useEffect(() => {
    if (prevHomeroomKey.current === homeroomKey) return
    const first = prevHomeroomKey.current === ''
    prevHomeroomKey.current = homeroomKey
    if (!first) ttRetry()
  }, [homeroomKey, ttRetry])
  const myCourses = useMemo<Course[]>(
    () => (tt.payload ? activeCoursesOn(tt.payload, todayYmd, uid) : []),
    [tt.payload, todayYmd, uid]
  )
  const closeSheet = useCallback(() => setSheetCourseId(null), [])
  // 그 날의 공식 수업(수강·학급 공통 수업)만 본 결과 — 학급 시간표(참고)를 처음부터 펼칠지 판단용.
  // 직접 입력 일정은 넣지 않음: 일정 하나를 추가했다고 학급 시간표가 접히거나 사라지지 않게(classRefAutoOpen)
  const officialDay = useMemo(() => {
    if (!tt.payload || !coversDate(tt.payload, ttDate)) return null
    return buildDayTimetable(dayInput(tt.payload, ttDate, [], uid))
  }, [tt.payload, ttDate, uid])

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

  // 반 이동 신청 중인 반 이름
  useEffect(() => {
    const pendingClassId = userData?.pendingClassId
    if (!pendingClassId) {
      setPendingClassLabel('')
      return
    }
    let cancelled = false
    setPendingClassLabel('새 반')
    ;(async () => {
      try {
        const { db } = await import('../../lib/firebase')
        const snap = await getDoc(doc(db, 'classes', pendingClassId))
        const c = snap.exists() ? snap.data() : null
        if (!cancelled && c?.grade && c?.classNm) setPendingClassLabel(`${c.grade}학년 ${c.classNm}반`)
      } catch {
        // 반 문서를 못 읽으면 '새 반'으로 둡니다.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [userData?.pendingClassId])

  // 30일 이내 학사일정 D-day 칩
  useEffect(() => {
    const schoolCode = userData?.schoolCode
    if (!schoolCode) return
    let cancelled = false
    ;(async () => {
      try {
        const today = todayYmd
        const start = Date.UTC(
          Number(today.slice(0, 4)),
          Number(today.slice(4, 6)) - 1,
          Number(today.slice(6, 8))
        )
        const end = ymdOf(new Date(start + 30 * 86400000))
        const res = await fetch(
          `/api/calendar?schoolCode=${encodeURIComponent(String(schoolCode))}&from=${today}&to=${end}`
        )
        if (!res.ok) return
        const data = (await res.json()) as { events?: Array<{ date?: string; name?: string }> }
        // 매주 나오는 '토요휴업일'은 빼고, 방학처럼 여러 날 이어지는 일정은 첫날만 남깁니다.
        const seenNames = new Set<string>()
        const events = (data.events ?? [])
          .filter((e): e is { date: string; name: string } =>
            Boolean(e.date && e.name && e.date >= today && e.name !== '토요휴업일')
          )
          .sort((a, b) => (a.date < b.date ? -1 : 1))
          .filter((e) => {
            if (seenNames.has(e.name)) return false
            seenNames.add(e.name)
            return true
          })
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
  }, [userData?.schoolCode, todayYmd])

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

  // 거절된 학생은 classId가 남아 있어도 반 소속으로 보여주지 않습니다.
  const rejected = userData.status === 'rejected'
  const hasClass = Boolean(userData.classId && userData.schoolCode) && !rejected
  const studentName = userData.name || userData.displayName || '학생'

  // 상단: 학교 · 원래 소속 학년·반 (수업 칩을 눌러도 바뀌지 않음)
  const classId = rejected ? '' : String(userData.classId || '')
  const isGroupLegacy = GROUP_CLASS_RE.test(classId)
  const payloadHr = tt.payload?.homeroom ?? null
  const homeroomMissing = !classId || isGroupLegacy
  const homeroomLabel = !classId
    ? '소속 학급 미설정 — 담임 선생님 QR로 등록'
    : isGroupLegacy
      ? '소속 학급 확인 필요'
      : (() => {
          const base =
            payloadHr && payloadHr.classId === classId && !payloadHr.isGroupLegacy && payloadHr.label
              ? payloadHr.label
              : userData.grade && userData.classNm
                ? `${userData.grade}학년 ${userData.classNm}반`
                : '학급'
          return awaitingHomeroomApproval(userData) ? `${base} (승인 대기)` : base
        })()
  const schoolName = String(payloadHr?.schoolName || userData.schoolName || '')

  // 학급 시간표(참고): 개인 시간표 카드 밖의 별도 영역. 승인된 소속 학급 → 학급 id까지, 담임 승인 대기 → 공개 NEIS만,
  // /api/timetable/me가 서버·네트워크 오류로 실패해도 프로필(승인된 소속 학급)로 계속 보여 줌(예전 TodayCard처럼)
  const ttFailed = !tt.covered && !!tt.error && (tt.error.kind === 'server' || tt.error.kind === 'offline')
  // 담임 학급 신청 승인 대기(수업 그룹 신청 제외) — 수업 없음 카드에 초대 코드 대신 승인 대기 안내
  const pendingHomeroom = !rejected && awaitingHomeroomClass(userData)
  const refTarget = classRefTarget({
    profile: {
      classId: classId || null,
      status: userData.status ?? null,
      schoolCode: userData.schoolCode ?? null,
      grade: userData.grade ?? null,
      classNm: userData.classNm ?? null,
    },
    payload: tt.payload,
    loadFailed: ttFailed,
  })
  // 공식 수업 시간표가 없는 날(직접 입력만 있어도)·자료를 못 받은 날은 처음부터 펼침. 학생이 접거나 펼치면 그 선택대로
  const refOpen = refChoice ?? classRefAutoOpen({ day: officialDay, loadFailed: ttFailed })
  const refOffDay = classRefOffDay(tt.payload, ttDate)
  const refPeriodTimes = tt.payload?.periodTimes ?? defaultPeriodTimes(schoolName)

  const sheetCourse = sheetCourseId && tt.payload ? tt.payload.courses.find((c) => c.courseId === sheetCourseId) ?? null : null

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
          <h1 className="text-xl font-bold text-gray-900 break-keep wrap-anywhere">
            {schoolName && (
              <>
                {schoolName}
                <span className="text-gray-300" aria-hidden="true">
                  {' '}
                  ·{' '}
                </span>
              </>
            )}
            <span className={homeroomMissing ? 'text-amber-700' : undefined}>{homeroomLabel}</span>
          </h1>
          <p className="mt-1 text-sm text-gray-500 break-keep">
            {hasClass && !homeroomMissing ? `${studentName}, 오늘도 좋은 하루 보내요!` : `안녕, ${studentName}!`}
          </p>
        </div>

        {/* 반 이동 신청 안내 */}
        {userData.pendingClassId && (
          <div className="flex items-center gap-2.5 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5 shrink-0 text-sky-600"
              aria-hidden="true"
            >
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
            <p className="text-sm font-medium text-sky-800 break-keep">
              {pendingClassLabel || '새 반'}으로 이동 신청 중 — 새 담임 선생님 승인을 기다려요
            </p>
          </div>
        )}

        {/* 승인 대기 배너 — 실제 학급(또는 예전 수업 그룹) 신청이 있을 때만. 수업 초대로만 가입한 학생은
            status가 pending이어도 classId가 없어 기다리는 신청이 없음('소속 없음' 카드가 따로 보임) */}
        {awaitingHomeroomApproval(userData) && (
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

        {rejected ? (
          /* 입장 거절 — 톡방과 같은 안내 */
          <div className="rounded-xl border border-gray-100 bg-white p-8 text-center shadow-lg">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-50 text-rose-500">
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
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v5M12 16h.01" />
              </svg>
            </span>
            <h2 className="mt-4 text-lg font-bold text-gray-900 break-keep">입장 신청이 승인되지 않았어요</h2>
            <p className="mt-2 text-sm leading-relaxed text-gray-500 break-keep">
              선생님께 확인한 뒤 반 QR을 다시 찍어 신청해 주세요.
            </p>
          </div>
        ) : (
          homeroomMissing && (
            /* 소속 학급 미설정(수업 그룹이 소속처럼 저장된 예전 학생 포함) — 수업은 아래에서 따로 보임 */
            <TimetableStateCard kind="no-homeroom" compact />
          )
        )}

        {/* 내 수업 줄 — 누르면 수업 정보 시트(소속 학급 표시는 그대로) */}
        {tt.payload && (
          <section aria-labelledby="my-courses-title">
            <div className="flex items-center justify-between">
              <h2 id="my-courses-title" className="text-sm font-semibold text-gray-700">
                내 수업
              </h2>
              <div className="-mr-2 flex items-center gap-1">
                <Link
                  href="/student/courses#catalog"
                  className="inline-flex min-h-11 items-center rounded-lg px-2 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                >
                  + 수업 담기
                </Link>
                {myCourses.length > 0 && (
                  <Link
                    href="/student/courses"
                    className="inline-flex min-h-11 items-center px-2 text-xs font-semibold text-emerald-600 transition-colors hover:text-emerald-700"
                  >
                    전체 &rarr;
                  </Link>
                )}
              </div>
            </div>
            {myCourses.length === 0 ? (
              <div className="mt-1 flex flex-wrap items-center gap-2 rounded-xl bg-emerald-50/60 px-3 py-2.5 ring-1 ring-emerald-100">
                <p className="min-w-0 flex-1 text-xs text-gray-600 break-keep">아직 참여 중인 수업이 없어요 · 학교 수업 목록에서 골라 담아 보세요</p>
                <Link
                  href="/student/courses#catalog"
                  className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                >
                  수업 담기
                </Link>
              </div>
            ) : (
              <ul className="mt-1 flex flex-wrap gap-2">
                {myCourses.slice(0, MAX_COURSE_CHIPS).map((c) => (
                  <li key={c.courseId} className="max-w-full">
                    <button
                      type="button"
                      onClick={() => setSheetCourseId(c.courseId)}
                      aria-label={`${lessonTitle(c)} 수업 정보`}
                      className="inline-flex min-h-11 max-w-full items-center rounded-full bg-white px-4 text-sm font-semibold text-gray-800 ring-1 ring-gray-200 transition-colors hover:bg-emerald-50 hover:ring-emerald-200"
                    >
                      <span className="truncate">{lessonTitle(c)}</span>
                    </button>
                  </li>
                ))}
                {myCourses.length > MAX_COURSE_CHIPS && (
                  <li>
                    <Link
                      href="/student/courses"
                      className="inline-flex min-h-11 items-center rounded-full bg-emerald-50 px-4 text-sm font-semibold text-emerald-700 ring-1 ring-emerald-200"
                    >
                      +{myCourses.length - MAX_COURSE_CHIPS} 전체
                    </Link>
                  </li>
                )}
              </ul>
            )}
          </section>
        )}

        {/* 오늘의 내 시간표 — 소속 학급이 없거나 승인 대기여도 숨기지 않음(수강 수업은 따로 보임) */}
        <section
          aria-labelledby="my-timetable-title"
          className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-lg"
        >
          <div className="flex items-center justify-between gap-2 border-b border-gray-100 px-4 py-2">
            <h2 id="my-timetable-title" className="flex items-center gap-1.5 text-base font-bold text-gray-900">
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
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 3" />
              </svg>
              {ttDate === todayYmd ? '오늘의 내 시간표' : '내 시간표'}
            </h2>
            <Link
              href={`/student/timetable?date=${ttDate}`}
              className="-mr-2 inline-flex min-h-11 items-center px-2 text-xs font-semibold text-emerald-600 transition-colors hover:text-emerald-700"
            >
              전체 보기 &rarr;
            </Link>
          </div>
          <div className="space-y-4 p-4">
            <DayNav compact date={ttDate} today={todayYmd} onChange={setTtDate} />
            <PersonalTimetablePanel
              tt={tt}
              date={ttDate}
              today={todayYmd}
              uid={uid}
              mode="compact"
              personalEntries={personal.entries}
              personalReady={personal.loaded}
              personalError={personal.error}
              onGoToday={() => setTtDate(todayYmd)}
              onShowClassReference={refTarget ? () => setRefChoice(true) : null}
              awaitingHomeroom={pendingHomeroom}
            />
          </div>
        </section>

        {/* 학급 시간표(참고): 개인 시간표 카드 밖의 별도 영역(항상 '참고' 라벨). 접어도 머리줄이 남아 다시 펼칠 수 있음 */}
        {refTarget && (
          <ClassTimetableReference
            schoolCode={refTarget.schoolCode}
            grade={refTarget.grade}
            classNm={refTarget.classNm}
            classId={refTarget.classId}
            date={ttDate}
            offDay={refOffDay}
            periodTimes={refPeriodTimes}
            today={todayYmd}
            open={refOpen}
            onOpenChange={setRefChoice}
          />
        )}

        {hasClass && (
          <>
            {/* 급식·학사일정 (학급 시간표 부분은 개인 시간표 카드로 대체되어 숨김) */}
            <TodayCard
              schoolCode={String(userData.schoolCode)}
              schoolName={String(userData.schoolName ?? '')}
              grade={userData.grade ?? ''}
              classNm={userData.classNm ?? ''}
              classId={String(userData.classId)}
              onMealLoaded={setHasMealToday}
              showTimetable={false}
            />

            {/* 내일 가방 싸기 체크리스트 — 날짜가 바뀌면 대상 등교일을 다시 정하도록 리마운트 */}
            {uid && (
              <BagChecklist
                key={todayYmd}
                classId={String(userData.classId)}
                schoolCode={String(userData.schoolCode)}
                uid={uid}
                status={userData.status}
                grade={userData.grade ?? undefined}
                classNm={userData.classNm ?? undefined}
                officeCode={userData.officeCode ? String(userData.officeCode) : undefined}
              />
            )}

            {/* 오늘 급식 별점 (한 줄) — 급식이 있는 날만 */}
            {hasMealToday && (
              <MealRating schoolCode={String(userData.schoolCode)} ymd={todayYmd} compact />
            )}

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
                  href="/class-room"
                  className="-m-2 p-2 text-xs font-semibold text-emerald-600 transition-colors hover:text-emerald-700"
                >
                  톡방에서 보기 &rarr;
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

            {/* 홈 화면 설치 유도 (이미 앱으로 쓰는 중이면 숨김) */}
            {!isStandalone && (
              <button
                onClick={() => {
                  if (canInstall) void promptInstall()
                  else showInstallGuide()
                }}
                className="w-full flex items-center gap-3 rounded-xl border border-emerald-200 bg-white p-4 text-left shadow-sm transition hover:bg-emerald-50 active:scale-[0.99]"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-xl">📱</span>
                <span className="min-w-0">
                  <span className="block text-sm font-bold text-gray-900">홈 화면에 앱으로 설치하기</span>
                  <span className="block text-xs text-gray-500 break-keep">
                    아이콘 한 번으로 바로 열 수 있어요 (설치 방법 안내)
                  </span>
                </span>
              </button>
            )}

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

      {sheetCourse && tt.payload && (
        <CourseInfoSheet
          course={sheetCourse}
          slots={courseSchedule(tt.payload, sheetCourse.courseId, todayYmd)}
          onClose={closeSheet}
        />
      )}

      <StudentTabBar active="today" />
    </div>
  )
}
