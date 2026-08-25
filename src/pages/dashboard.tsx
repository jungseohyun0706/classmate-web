import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { auth } from '../lib/firebase'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import TodayCard from '../components/TodayCard'
import { useUI } from '../components/ui/feedback'
import { useInstallPrompt } from '../components/ui/install'

export default function Dashboard() {
  const router = useRouter()
  const { toast } = useUI()
  const { canInstall, promptInstall, isIOS, isStandalone, showIOSGuide } = useInstallPrompt()
  const [user, setUser] = useState<any>(null)
  const [userData, setUserData] = useState<any>(null)
  const [loading, setLoading] = useState(true)

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
          setUserData(snap.data())
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

  if (loading) return <div className="min-h-screen flex items-center justify-center bg-gray-50"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div></div>

  const hasClass = userData?.classId && userData?.schoolName

  // 홈 화면 설치 카드 상태
  const installMode: 'installed' | 'prompt' | 'ios' | 'hint' = isStandalone
    ? 'installed'
    : canInstall
      ? 'prompt'
      : isIOS
        ? 'ios'
        : 'hint'
  const installInteractive = installMode === 'prompt' || installMode === 'ios'
  const installDesc =
    installMode === 'installed'
      ? '홈 화면에 설치되어 앱처럼 사용 중이에요.'
      : installMode === 'hint'
        ? '모바일 브라우저에서 열면 홈 화면에 설치할 수 있어요.'
        : '홈 화면에 추가하고 앱처럼 빠르게 사용해 보세요.'

  const cards = [
    {
      id: 'students',
      title: hasClass ? '학생 관리' : '내 학교/반 등록',
      desc: hasClass ? '우리 반 학생 목록을 확인하세요.' : '학교와 담당 학급을 설정하세요.',
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
      path: hasClass ? '/teacher/students' : '/teacher/register-class'
    },
    {
      id: 'notice',
      title: '공지사항 작성',
      desc: '학생들에게 알림장을 보내세요.',
      icon: <svg className="h-8 w-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" /></svg>,
      bgColor: 'bg-green-100',
      path: '/teacher/notice/write',
      needClass: true
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
      id: 'my-schedule',
      title: '내 수업 및 교환',
      desc: '개인 시간표 관리 및 수업 교환 요청.',
      icon: <svg className="h-8 w-8 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>,
      bgColor: 'bg-red-100',
      path: '/teacher/my-schedule',
      needClass: false
    },
    {
      id: 'view-others',
      title: '다른 반 시간표 조회',
      desc: '학교 전체 시간표를 조회합니다.',
      icon: <svg className="h-8 w-8 text-teal-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>,
      bgColor: 'bg-teal-100',
      path: '/teacher/view-timetables',
      needClass: true
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
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z\"/><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z\"/></svg>
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

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((card) => (
            <div
              key={card.id}
              onClick={() => {
                if (card.needClass && !hasClass) {
                  toast('먼저 반을 등록해야 해요.', 'info')
                  return
                }
                router.push(card.path)
              }}
              className="group cursor-pointer bg-white overflow-hidden shadow-lg rounded-xl border border-gray-100 hover:border-blue-300 hover:shadow-2xl transition-all duration-200"
            >
              <div className="p-6">
                <div className="flex items-center">
                  <div className={`flex-shrink-0 rounded-md p-3 ${card.bgColor} group-hover:scale-110 transition-transform duration-200`}>
                    {card.icon}
                  </div>
                  <div className="ml-4">
                    <h3 className="text-lg font-bold text-gray-900 group-hover:text-blue-600 transition-colors">{card.title}</h3>
                    <p className="mt-1 text-sm text-gray-500">{card.desc}</p>
                  </div>
                </div>
              </div>
              <div className="bg-gray-50 px-6 py-3 flex justify-end items-center group-hover:bg-blue-50 transition-colors">
                <span className="text-sm font-bold text-gray-400 group-hover:text-blue-600 transition-colors">들어가기 &rarr;</span>
              </div>
            </div>
          ))}

          {/* 홈 화면에 설치 카드 */}
          <div
            onClick={() => {
              if (installMode === 'prompt') {
                void promptInstall()
              } else if (installMode === 'ios') {
                showIOSGuide()
              }
            }}
            className={`group bg-white overflow-hidden shadow-lg rounded-xl border border-gray-100 transition-all duration-200 ${
              installInteractive ? 'cursor-pointer hover:border-blue-300 hover:shadow-2xl' : ''
            }`}
          >
            <div className="p-6">
              <div className="flex items-center">
                <div
                  className={`flex-shrink-0 rounded-md p-3 ${installMode === 'installed' ? 'bg-green-100' : 'bg-blue-100'} ${
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
                <div className="ml-4">
                  <h3
                    className={`text-lg font-bold text-gray-900 transition-colors ${
                      installInteractive ? 'group-hover:text-blue-600' : ''
                    }`}
                  >
                    홈 화면에 설치 📱
                  </h3>
                  <p className="mt-1 text-sm text-gray-500 break-keep">{installDesc}</p>
                </div>
              </div>
            </div>
            <div
              className={`bg-gray-50 px-6 py-3 flex justify-end items-center transition-colors ${
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
