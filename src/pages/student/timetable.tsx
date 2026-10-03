import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth } from '../../lib/firebase'
import DayNav from '../../components/timetable/DayNav'
import { PersonalTimetablePanel } from '../../components/timetable/PersonalTimetable'
import ClassTimetableReference from '../../components/timetable/ClassTimetableReference'
import { buildDayTimetable } from '../../lib/timetable/engine'
import { coversDate, dayInput, useMyTimetable } from '../../lib/timetable/client'
import {
  awaitingHomeroomClass,
  classRefAutoOpen,
  classRefOffDay,
  classRefTarget,
  defaultPeriodTimes,
} from '../../lib/timetable/classRefPolicy'
import { usePersonalEntries } from '../../lib/timetable/personalEntries'
import { isYmd, schoolYmdAt } from '../../lib/timetable/dates'
import { isSignedInUser, loginPathWithNext } from '../../lib/authRouting'
import type { Ymd } from '../../lib/timetable/types'

/**
 * 학생 개인 시간표 전체 화면 — /student/timetable?date=YYYYMMDD
 * (시간표 변경 알림이 /student/timetable?date=그 날짜 로 연결. 저녁 '내일 가방' 알림은 가방 체크리스트가 있는 홈 /student/today?date=내일)
 * - date가 없거나 형식이 틀리면 오늘(학교 시간대)
 * - 날짜 이동, 개인 시간표(전체), 상태 카드, 학급 시간표(참고) 접힘, '내 수업 관리' 링크
 * - 로그인 안 됨(둘러보기 익명 세션 포함) → 로그인 화면(?next=지금 주소 — 로그인 화면이 같은 사이트 상대 경로만 받아 로그인 뒤 이 날짜로 돌아옴)
 */

interface ProfileLite {
  schoolCode?: string
  schoolName?: string
  classId?: string | null
  status?: string | null
  grade?: string | number | null
  classNm?: string | number | null
}

export default function StudentTimetablePage(): JSX.Element {
  const router = useRouter()
  const [authReady, setAuthReady] = useState<boolean>(false)
  const [uid, setUid] = useState<string | null>(null)
  const [profile, setProfile] = useState<ProfileLite | null>(null)
  const [today, setToday] = useState<Ymd>(() => schoolYmdAt(Date.now()))
  // '학급 시간표(참고)' 펼침 — 학생이 고른 값(null = 아직 안 고름)
  const [refChoice, setRefChoice] = useState<boolean | null>(null)

  const queryDate = typeof router.query.date === 'string' && isYmd(router.query.date) ? router.query.date : null
  const date: Ymd | null = router.isReady ? queryDate ?? today : null

  // 1분마다·화면 복귀 때 오늘 날짜 확인(자정 경계)
  useEffect(() => {
    const check = (): void => setToday(schoolYmdAt(Date.now()))
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

  // 날짜를 바꿀 때(shallow replace)마다 로그인 구독을 다시 만들지 않도록 router는 ref로
  const routerRef = useRef(router)
  useEffect(() => {
    routerRef.current = router
  }, [router])

  // 로그인 확인 + 학급 시간표(참고)에 쓸 소속·학년·반(표시용 — 시간표 권한 판단은 서버 API가 함)
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      // 둘러보기(익명) 세션도 로그인 안 됨으로 봄 — /meals가 만든 익명 계정을 로그인으로 보면
      // 서버가 no-profile을 돌려줘 '가입 미완료'로 잘못 안내함
      if (!isSignedInUser(u)) {
        setUid(null)
        const r = routerRef.current
        void r.replace(loginPathWithNext(r.asPath, '/student/timetable'))
        return
      }
      setUid(u.uid)
      setAuthReady(true)
      ;(async () => {
        try {
          const { db } = await import('../../lib/firebase')
          const snap = await getDoc(doc(db, 'users', u.uid))
          const d = snap.exists() ? (snap.data() as ProfileLite) : null
          setProfile(
            d
              ? {
                  schoolCode: d.schoolCode,
                  schoolName: d.schoolName,
                  classId: d.classId ?? null,
                  status: d.status ?? null,
                  grade: d.grade ?? null,
                  classNm: d.classNm ?? null,
                }
              : null
          )
        } catch {
          // 프로필을 못 읽어도 시간표 상태는 API 응답으로 안내
          setProfile(null)
        }
      })()
    })
    return () => unsub()
  }, [])

  const tt = useMyTimetable(uid, date, { schoolCode: profile?.schoolCode ?? null })
  const personal = usePersonalEntries(uid)
  // 그 날의 공식 수업만 본 결과 — 공식 수업 시간표가 없는 날(직접 입력만 있어도)은 학급 시간표(참고)를 처음부터 펼쳐 둠(별도 영역·참고 라벨 유지)
  const officialDay = useMemo(() => {
    if (!tt.payload || !date || !coversDate(tt.payload, date)) return null
    return buildDayTimetable(dayInput(tt.payload, date, [], uid))
  }, [tt.payload, date, uid])
  const ttFailed = !tt.covered && !!tt.error && (tt.error.kind === 'server' || tt.error.kind === 'offline')
  const refOpen = refChoice ?? classRefAutoOpen({ day: officialDay, loadFailed: ttFailed })
  const setRefOpen = setRefChoice

  const changeDate = useCallback(
    (d: Ymd) => {
      void router.replace({ pathname: '/student/timetable', query: { date: d } }, undefined, { shallow: true, scroll: false })
    },
    [router]
  )
  const goToday = useCallback(() => changeDate(today), [changeDate, today])

  if (!authReady || !date) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-emerald-600" />
      </div>
    )
  }

  const hr = tt.payload?.homeroom ?? null
  // 학급 시간표(참고): 홈과 같은 규칙(승인된 소속 학급 / 담임 승인 대기는 공개 NEIS만 / /me 실패 시 프로필)
  const refTarget = classRefTarget({ profile, payload: tt.payload, loadFailed: ttFailed })
  const refOffDay = classRefOffDay(tt.payload, date)
  const refPeriodTimes = tt.payload?.periodTimes ?? defaultPeriodTimes(hr?.schoolName || profile?.schoolName)
  const pendingHomeroom = awaitingHomeroomClass(profile)

  return (
    <div className="min-h-screen bg-gray-50 text-black">
      <header className="sticky top-0 z-40 border-b border-gray-200 bg-white">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-1 px-2">
          <Link
            href="/student/today"
            aria-label="오늘 화면으로"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-gray-600 transition-colors hover:bg-gray-100"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden="true">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </Link>
          <h1 className="min-w-0 flex-1 truncate text-lg font-bold text-gray-900">내 시간표</h1>
          <Link
            href="/student/courses"
            className="inline-flex min-h-11 shrink-0 items-center rounded-xl px-3 text-sm font-semibold text-emerald-700 transition-colors hover:bg-emerald-50"
          >
            내 수업 관리
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-4 px-4 py-4" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 2rem)' }}>
        {hr && (
          <p className="text-sm text-gray-500 break-keep wrap-anywhere">
            {hr.schoolName ? `${hr.schoolName} · ` : ''}
            {hr.isGroupLegacy ? '소속 학급 확인 필요' : hr.label}
          </p>
        )}

        <section className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
          <DayNav date={date} today={today} onChange={changeDate} />
        </section>

        <section aria-label="내 시간표" className="rounded-xl border border-gray-100 bg-white p-4 shadow-lg">
          <PersonalTimetablePanel
            tt={tt}
            date={date}
            today={today}
            uid={uid}
            mode="full"
            personalEntries={personal.entries}
            personalReady={personal.loaded}
            personalError={personal.error}
            onGoToday={goToday}
            onShowClassReference={refTarget ? () => setRefOpen(true) : null}
            awaitingHomeroom={pendingHomeroom}
          />
        </section>

        {refTarget && (
          <ClassTimetableReference
            schoolCode={refTarget.schoolCode}
            grade={refTarget.grade}
            classNm={refTarget.classNm}
            classId={refTarget.classId}
            date={date}
            offDay={refOffDay}
            periodTimes={refPeriodTimes}
            today={today}
            open={refOpen}
            onOpenChange={setRefOpen}
          />
        )}

        <Link
          href="/student/courses"
          className="flex min-h-11 items-center justify-between rounded-xl bg-white px-4 py-3 text-sm font-semibold text-gray-800 ring-1 ring-gray-200 transition-colors hover:bg-emerald-50"
        >
          <span className="break-keep">내 수업 관리 · 초대 코드 · 직접 입력</span>
          <span aria-hidden="true" className="text-emerald-600">
            &rarr;
          </span>
        </Link>
      </main>
    </div>
  )
}
