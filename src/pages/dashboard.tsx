import React, { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/router'
import { auth } from '../lib/firebase'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { doc, getDoc, collection, getDocs, query, where } from 'firebase/firestore'
import TodayCard from '../components/TodayCard'
import { useUI } from '../components/ui/feedback'
import { useInstallPrompt } from '../components/ui/install'
import InviteCodeInput from '../components/InviteCodeInput'
import { usePendingInviteResume } from '../lib/pendingInvite'
import { todayKstYmd } from '../lib/sos'

export default function Dashboard() {
  // 로그인 직후 저장된 초대가 있으면 /i/CODE로 이어감(PWA start_url이 /dashboard라 설치·재접속 후에도 여기로 옴)
  const resumingInvite = usePendingInviteResume()
  const resumingRef = useRef(false)
  resumingRef.current = resumingInvite
  const router = useRouter()
  const { toast } = useUI()
  const { canInstall, promptInstall, isIOS, isStandalone, showInstallGuide } = useInstallPrompt()
  const [user, setUser] = useState<any>(null)
  const [userData, setUserData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [pendingSwaps, setPendingSwaps] = useState(0)
  const [hasMasterTimetable, setHasMasterTimetable] = useState(false)
  const [incomplete, setIncomplete] = useState(false)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.replace('/auth/login')
        return
      }
      setUser(u)
      try {
        const { db } = await import('../lib/firebase')
        const snap = await getDoc(doc(db, 'users', u.uid))
        if (snap.exists()) {
          const data = snap.data()
          if (data?.role === 'student') {
            // 초대 화면으로 이어가는 중이면 학생 홈으로 덮어쓰지 않음
            if (!resumingRef.current) router.replace('/student/today')
            return
          }
          if (data?.role !== 'teacher') {
            setIncomplete(true)
            return
          }
          setUserData(data)
          // 학교 시간표 등록 여부 (업로드 카드 문구용 — 실패해도 무시)
          if (data?.schoolCode) {
            getDoc(doc(db, 'school_timetables', String(data.schoolCode)))
              .then((m) => setHasMasterTimetable(m.exists()))
              .catch(() => {})
          }
          // 대기중인 받은 교환 요청 수 (가벼운 배지 쿼리 — 실패해도 무시)
          if (data?.schoolCode) {
            try {
              const swapSnap = await getDocs(
                query(
                  collection(db, 'school_swaps', String(data.schoolCode), 'direct_requests'),
                  where('toId', '==', u.uid),
                  where('status', '==', 'pending')
                )
              )
              // 수업 날짜가 지난 요청은 수락할 수 없으므로 빼고 셈 (date 없는 레거시 요청은 포함)
              const today = todayKstYmd()
              setPendingSwaps(swapSnap.docs.filter((d) => !d.get('date') || d.get('date') >= today).length)
            } catch (e) {
              console.error(e)
            }
          }
        } else {
          // users 문서 없음 = 교사 코드 등록이나 학생 입장 신청이 끝나지 않은 계정 → 교사 화면 대신 안내
          setIncomplete(true)
        }
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    })
    return () => unsub()
  }, [router])

  const handleLogout = async () => {
    await signOut(auth)
    router.replace('/auth/login')
  }

  if (resumingInvite) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-gray-50 text-gray-600">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
        <p className="text-sm">받은 초대를 이어서 여는 중...</p>
      </div>
    )
  }

  if (loading) return <div className="min-h-screen flex items-center justify-center bg-gray-50"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div></div>

  if (incomplete) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-10 text-black">
        <div className="max-w-md w-full bg-white shadow-xl rounded-2xl border border-gray-100 p-6 sm:p-8">
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900 text-center break-keep">가입이 아직 끝나지 않았어요</h1>
          <p className="mt-2 text-sm text-gray-600 text-center break-keep">
            계정은 만들어졌지만 선생님 인증이나 반 입장 신청이 마무리되지 않았어요.
          </p>
          <div className="mt-6 space-y-3">
            <div className="rounded-xl bg-blue-50 border border-blue-100 p-4">
              <p className="text-sm font-bold text-blue-900">🧑‍🏫 선생님이라면</p>
              <p className="mt-1 text-xs text-blue-800 break-keep">
                다시 로그인하면 교사 인증 코드를 입력하는 단계로 이어져요.
              </p>
              <button
                onClick={handleLogout}
                className="mt-3 w-full min-h-[44px] rounded-lg bg-blue-600 text-white text-sm font-bold hover:bg-blue-700 transition"
              >
                다시 로그인해서 코드 입력하기
              </button>
            </div>
            <div className="rounded-xl bg-emerald-50 border border-emerald-100 p-4">
              <p className="text-sm font-bold text-emerald-900">🎒 학생이라면</p>
              <p className="mt-1 text-xs text-emerald-800 break-keep">
                선생님께 받은 초대 코드(XXXX-XXXX)를 입력하거나, 초대 링크·QR을 다시 열면 이 계정으로 이어서 참여할 수 있어요.
              </p>
              <div className="mt-3">
                <InviteCodeInput compact />
              </div>
            </div>
          </div>
          <div className="mt-4 text-center">
            <button
              onClick={handleLogout}
              className="min-h-[44px] px-3 text-sm text-gray-500 underline hover:text-gray-700"
            >
              로그아웃
            </button>
          </div>
        </div>
      </div>
    )
  }

  const hasClass = userData?.classId && userData?.schoolName
  const hasSchool = !!userData?.schoolCode

  // 홈 화면 설치 카드 상태
  const installMode: 'installed' | 'prompt' | 'ios' | 'hint' = isStandalone
    ? 'installed'
    : canInstall
      ? 'prompt'
      : isIOS
        ? 'ios'
        : 'hint'
  const installInteractive = installMode !== 'installed'
  const installDesc =
    installMode === 'installed'
      ? '홈 화면에 설치되어 앱처럼 사용 중이에요.'
      : installMode === 'hint'
        ? '눌러서 홈 화면 설치 방법을 확인해 보세요.'
        : '홈 화면에 추가하고 앱처럼 빠르게 사용해 보세요.'

  const cards = [
    {
      id: 'students',
      title: hasSchool ? '학생 관리' : '내 학교/반 등록',
      desc: hasSchool ? '우리 반·수업 반 학생을 QR 초대·승인해요.' : '학교와 담당 학급을 설정하세요.',
      icon: (
        <svg className={`h-8 w-8 ${hasClass ? 'text-indigo-600' : 'text-blue-600'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          {hasClass ? (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
          )}
        </svg>
      ),
      bgColor: hasClass ? 'bg-indigo-100' : 'bg-blue-100',
      path: hasSchool ? '/teacher/students' : '/teacher/register-class'
    },
    {
      id: 'courses',
      title: '수업 관리',
      desc: '수업 만들기·수업 초대·수강생 승인·반 공통 수업.',
      icon: <svg className="h-8 w-8 text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>,
      bgColor: 'bg-violet-100',
      path: '/teacher/courses',
      needSchool: true
    },
    {
      id: 'schedule-changes',
      title: '시간표 변경',
      desc: '이 날짜만 / 지정일부터 — 수강생에게만 반영.',
      icon: <svg className="h-8 w-8 text-pink-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h4m-4 4h3M5 21h6M5 21a2 2 0 01-2-2V7a2 2 0 012-2h14a2 2 0 012 2v4m-3.5 2.5l2 2L14 21h-2v-2l5.5-5.5z" /></svg>,
      bgColor: 'bg-pink-100',
      path: '/teacher/schedule-changes',
      needSchool: true
    },
    {
      id: 'class-room',
      title: '학급별 톡방',
      desc: '반마다 공지·대화가 한곳에 — 실시간 채팅.',
      icon: <svg className="h-8 w-8 text-rose-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" /></svg>,
      bgColor: 'bg-rose-100',
      // 담임 반이 없어도 수업 반 톡방이 있을 수 있음 — 반이 하나도 없으면 톡방 화면이 직접 안내함
      path: '/class-room'
    },
    {
      id: 'class-timetable',
      title: '학급 시간표 관리',
      desc: '학생들에게 보여질 우리 반 시간표입니다.',
      icon: <svg className="h-8 w-8 text-yellow-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
      bgColor: 'bg-yellow-100',
      path: '/teacher/class-timetable',
      needClass: true
    },
    {
      id: 'upload-timetable',
      title: '시간표 엑셀 업로드',
      desc: hasMasterTimetable
        ? '✓ 우리 학교 등록 완료 — 시간표가 바뀔 때만 교체해요.'
        : '학교 시간표 엑셀로 모든 반·교사 시간표 자동 등록.',
      icon: <svg className="h-8 w-8 text-cyan-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>,
      bgColor: 'bg-cyan-100',
      path: '/teacher/upload-timetable',
      needSchool: true
    },
    {
      id: 'timetable-import',
      title: '시간표 가져오기',
      desc: '교실별·교사별·전체 시간표 엑셀을 수업으로 연결.',
      icon: <svg className="h-8 w-8 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 10h18M3 14h18M10 3v18M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z" /></svg>,
      bgColor: 'bg-emerald-100',
      path: '/teacher/timetable-import',
      needSchool: true
    },
    {
      id: 'roster-import',
      title: '수강 명단 가져오기',
      desc: '학생별 수강 명단으로 수업에 학생을 연결.',
      icon: <svg className="h-8 w-8 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>,
      bgColor: 'bg-amber-100',
      path: '/teacher/roster-import',
      needSchool: true
    },
    {
      id: 'my-schedule',
      title: '내 수업 및 교환',
      desc: '개인 시간표 관리 및 수업 교환 요청.',
      icon: <svg className="h-8 w-8 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>,
      bgColor: 'bg-red-100',
      path: '/teacher/my-schedule',
      needClass: false
    },
    {
      id: 'swaps',
      title: '교환 인박스',
      desc: '받은 교환 요청을 확인하고 수락하세요.',
      icon: <svg className="h-8 w-8 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" /></svg>,
      bgColor: 'bg-purple-100',
      path: '/teacher/swaps',
      needClass: false,
      badge: pendingSwaps
    },
    {
      id: 'sos',
      title: '보결 SOS',
      desc: '갑자기 자리를 비울 때 보결을 요청하세요.',
      icon: <svg className="h-8 w-8 text-orange-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M18.364 5.636l-3.536 3.536m0 5.656l3.536 3.536M9.172 9.172L5.636 5.636m3.536 9.192l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5 0a4 4 0 11-8 0 4 4 0 018 0z" /></svg>,
      bgColor: 'bg-orange-100',
      path: '/teacher/sos',
      needClass: false
    },
    {
      id: 'view-others',
      title: '다른 반 시간표 조회',
      desc: '학교 전체 시간표를 조회합니다.',
      icon: <svg className="h-8 w-8 text-teal-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>,
      bgColor: 'bg-teal-100',
      path: '/teacher/view-timetables',
      needSchool: true
    },
    {
      id: 'calendar',
      title: '학사일정',
      desc: '우리 학교 일정을 한눈에 봐요.',
      icon: <svg className="h-8 w-8 text-sky-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>,
      bgColor: 'bg-sky-100',
      path: '/calendar',
      needSchool: true
    }
  ]

  return (
    <div className="min-h-screen bg-gray-50 text-black">
      <nav className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 h-16 flex justify-between items-center">
          <div className="flex items-center cursor-pointer" onClick={() => router.push('/dashboard')}>
            <span className="text-2xl font-extrabold text-blue-600">Classmate</span>
            <span className="ml-3 px-2 py-1 bg-blue-100 text-blue-800 text-xs font-semibold rounded-full">Teacher</span>
          </div>
          <div className="flex items-center space-x-4">
            <span className="text-gray-700 text-sm hidden sm:block">{userData?.displayName || user?.email} 선생님</span>
            <button 
              onClick={() => router.push('/teacher/settings')}
              className="text-gray-500 hover:text-gray-700 p-2 rounded-full hover:bg-gray-100 transition"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
            </button>
            <button onClick={handleLogout} className="text-gray-500 hover:text-red-600 text-sm font-medium p-2 rounded-lg hover:bg-gray-100 transition">로그아웃</button>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto py-6 sm:py-10 px-4 sm:px-6 lg:px-8">
        <div className="mb-6 sm:mb-8">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 break-keep">
            {hasClass ? `${userData.schoolName} ${userData.grade}학년 ${userData.classNm}반 👋` : `반갑습니다, 선생님! 👋`}
          </h1>
          <p className="mt-2 text-base sm:text-lg text-gray-600 break-keep">
            {hasClass ? '오늘도 학생들과 즐거운 하루 보내세요.' : '먼저 담당하실 학급을 등록해주세요.'}
          </p>
          {/* 학교만 등록한 선생님이 나중에 담임 반을 등록하는 입구 (학교가 없으면 학생 관리 카드가 등록 화면으로 안내) */}
          {!hasClass && hasSchool && (
            <button
              onClick={() => router.push('/teacher/register-class')}
              className="mt-3 inline-flex items-center min-h-[44px] px-4 rounded-xl bg-blue-600 text-white text-sm font-bold hover:bg-blue-700 transition"
            >
              🏠 담임 반 등록하기
            </button>
          )}
        </div>

        {hasClass && userData?.schoolCode && (
          <div className="mb-6">
            <TodayCard
              schoolCode={String(userData.schoolCode)}
              schoolName={String(userData.schoolName)}
              grade={userData.grade as string | number}
              classNm={userData.classNm as string | number}
              classId={String(userData.classId)}
            />
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:gap-6 lg:grid-cols-3">
          {cards.map((card) => (
            <div
              key={card.id}
              onClick={() => {
                if (card.needSchool && !userData?.schoolCode) {
                  toast('먼저 학교를 등록해야 해요.', 'info')
                  router.push('/teacher/register-class')
                  return
                }
                if (card.needClass && !hasClass) {
                  toast('먼저 담임 반을 등록해야 해요.', 'info')
                  router.push('/teacher/register-class')
                  return
                }
                router.push(card.path)
              }}
              className="group cursor-pointer bg-white overflow-hidden shadow-lg rounded-xl border border-gray-100 hover:border-blue-300 hover:shadow-2xl active:scale-[0.98] transition-all duration-200"
            >
              <div className="p-4 sm:p-6">
                <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-0">
                  <div className={`flex-shrink-0 rounded-md p-2.5 sm:p-3 ${card.bgColor} group-hover:scale-110 transition-transform duration-200`}>
                    {card.icon}
                  </div>
                  <div className="sm:ml-4 min-w-0">
                    <h3 className="text-base sm:text-lg font-bold text-gray-900 group-hover:text-blue-600 transition-colors break-keep">
                      {card.title}
                      {card.badge ? (
                        <span className="ml-2 inline-flex items-center justify-center min-w-[1.5rem] h-6 px-1.5 rounded-full bg-red-500 text-white text-xs font-bold align-middle">
                          {card.badge}
                        </span>
                      ) : null}
                    </h3>
                    <p className="mt-1 text-xs sm:text-sm text-gray-500 break-keep">{card.desc}</p>
                  </div>
                </div>
              </div>
              <div className="hidden sm:flex bg-gray-50 px-6 py-3 justify-end items-center group-hover:bg-blue-50 transition-colors">
                <span className="text-sm font-bold text-gray-400 group-hover:text-blue-600 transition-colors">들어가기 &rarr;</span>
              </div>
            </div>
          ))}

          {/* 홈 화면에 설치 카드 */}
          <div
            onClick={() => {
              if (installMode === 'prompt') {
                void promptInstall()
              } else if (installMode !== 'installed') {
                // iOS·인앱 브라우저·프롬프트 미지원 환경 모두 안내 시트로
                showInstallGuide()
              }
            }}
            className={`group bg-white overflow-hidden shadow-lg rounded-xl border border-gray-100 transition-all duration-200 ${
              installInteractive ? 'cursor-pointer hover:border-blue-300 hover:shadow-2xl' : ''
            }`}
          >
            <div className="p-4 sm:p-6">
              <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-0">
                <div
                  className={`flex-shrink-0 rounded-md p-2.5 sm:p-3 ${installMode === 'installed' ? 'bg-green-100' : 'bg-blue-100'} ${
                    installInteractive ? 'group-hover:scale-110 transition-transform duration-200' : ''
                  }`}
                >
                  <svg
                    className={`h-8 w-8 ${installMode === 'installed' ? 'text-green-600' : 'text-blue-600'}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  </svg>
                </div>
                <div className="sm:ml-4 min-w-0">
                  <h3
                    className={`text-base sm:text-lg font-bold text-gray-900 transition-colors break-keep ${
                      installInteractive ? 'group-hover:text-blue-600' : ''
                    }`}
                  >
                    홈 화면에 설치 📱
                  </h3>
                  <p className="mt-1 text-xs sm:text-sm text-gray-500 break-keep">{installDesc}</p>
                </div>
              </div>
            </div>
            <div
              className={`hidden sm:flex bg-gray-50 px-6 py-3 justify-end items-center transition-colors ${
                installInteractive ? 'group-hover:bg-blue-50' : ''
              }`}
            >
              {installMode === 'installed' ? (
                <span className="text-sm font-bold text-green-600">설치됨 ✓</span>
              ) : installMode === 'prompt' ? (
                <span className="text-sm font-bold text-gray-400 group-hover:text-blue-600 transition-colors">설치하기 &rarr;</span>
              ) : installMode === 'ios' ? (
                <span className="text-sm font-bold text-gray-400 group-hover:text-blue-600 transition-colors">설치 방법 보기 &rarr;</span>
              ) : (
                <span className="text-sm font-medium text-gray-400">모바일에서 설치할 수 있어요</span>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
