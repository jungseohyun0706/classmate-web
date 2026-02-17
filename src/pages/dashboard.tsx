import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { initFirebase } from '../lib/firebase'
import { getAuth, onAuthStateChanged, signOut } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'

initFirebase()

export default function Dashboard() {
  const router = useRouter()
  const [user, setUser] = useState<any>(null)
  const [userData, setUserData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const auth = getAuth()

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
  }, [router, auth])

  const handleLogout = async () => {
    await signOut(auth)
    router.replace('/auth/login')
  }

  if (loading) return <div className="min-h-screen flex items-center justify-center bg-gray-50"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div></div>

  // 반 정보 확인
  const hasClass = userData?.classId && userData?.schoolName

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 h-16 flex justify-between items-center">
          <div className="flex items-center cursor-pointer" onClick={() => router.push('/dashboard')}>
            <span className="text-2xl font-extrabold text-blue-600">Classmate</span>
            <span className="ml-3 px-2 py-1 bg-blue-100 text-blue-800 text-xs font-semibold rounded-full">Teacher</span>
          </div>
          <div className="flex items-center space-x-4">
            <span className="text-gray-700 text-sm hidden sm:block">{userData?.displayName || user?.email} 선생님</span>
            <button onClick={handleLogout} className="text-gray-500 hover:text-red-600 text-sm font-medium">로그아웃</button>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto py-10 px-4 sm:px-6 lg:px-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">
            {hasClass ? `${userData.schoolName} ${userData.grade}학년 ${userData.classNm}반 👋` : `반갑습니다, 선생님! 👋`}
          </h1>
          <p className="mt-2 text-lg text-gray-600">
            {hasClass ? '오늘도 학생들과 즐거운 하루 보내세요.' : '먼저 담당하실 학급을 등록해주세요.'}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          
          {/* Card 1: 반 관리 (조건부 렌더링) */}
          <div className="bg-white overflow-hidden shadow-lg rounded-xl border border-gray-100 hover:shadow-xl transition-shadow duration-300">
            <div className="p-6">
              <div className="flex items-center">
                <div className={`flex-shrink-0 rounded-md p-3 ${hasClass ? 'bg-indigo-100' : 'bg-blue-100'}`}>
                  <svg className={`h-8 w-8 ${hasClass ? 'text-indigo-600' : 'text-blue-600'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    {hasClass ? (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                    ) : (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                    )}
                  </svg>
                </div>
                <div className="ml-4">
                  <h3 className="text-lg font-bold text-gray-900">{hasClass ? '학생 관리' : '내 학교/반 등록'}</h3>
                  <p className="mt-1 text-sm text-gray-500">
                    {hasClass ? '우리 반 학생 목록을 확인하세요.' : '학교와 담당 학급을 설정하세요.'}
                  </p>
                </div>
              </div>
            </div>
            <div className="bg-gray-50 px-6 py-4">
              <button 
                onClick={() => router.push(hasClass ? '/teacher/students' : '/teacher/register-class')}
                className={`text-sm font-medium flex items-center ${hasClass ? 'text-indigo-600 hover:text-indigo-500' : 'text-blue-600 hover:text-blue-500'}`}
              >
                {hasClass ? '학생 보러 가기' : '등록하러 가기'} <span aria-hidden="true" className="ml-1">&rarr;</span>
              </button>
            </div>
          </div>

          {/* Card 2: 공지사항 */}
          <div className="bg-white overflow-hidden shadow-lg rounded-xl border border-gray-100 hover:shadow-xl transition-shadow duration-300">
            <div className="p-6">
              <div className="flex items-center">
                <div className="flex-shrink-0 bg-green-100 rounded-md p-3">
                  <svg className="h-8 w-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" />
                  </svg>
                </div>
                <div className="ml-4">
                  <h3 className="text-lg font-bold text-gray-900">공지사항 작성</h3>
                  <p className="mt-1 text-sm text-gray-500">학생들에게 알림장을 보내세요.</p>
                </div>
              </div>
            </div>
            <div className="bg-gray-50 px-6 py-4">
              <button 
                onClick={() => {
                  if(!hasClass) alert('먼저 반을 등록해야 공지를 쓸 수 있습니다.')
                  else router.push('/teacher/notice/write')
                }}
                className="text-sm font-medium text-green-600 hover:text-green-500 flex items-center"
              >
                작성하러 가기 <span aria-hidden="true" className="ml-1">&rarr;</span>
              </button>
            </div>
          </div>

          {/* Card 3: 설정 */}
          <div className="bg-white overflow-hidden shadow-lg rounded-xl border border-gray-100 hover:shadow-xl transition-shadow duration-300">
            <div className="p-6">
              <div className="flex items-center">
                <div className="flex-shrink-0 bg-purple-100 rounded-md p-3">
                  <svg className="h-8 w-8 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </div>
                <div className="ml-4">
                  <h3 className="text-lg font-bold text-gray-900">계정 설정</h3>
                  <p className="mt-1 text-sm text-gray-500">정보 수정.</p>
                </div>
              </div>
            </div>
            <div className="bg-gray-50 px-6 py-4">
              <button 
                onClick={() => router.push('/teacher/settings')}
                className="text-sm font-medium text-purple-600 hover:text-purple-500 flex items-center"
              >
                설정하기 <span aria-hidden="true" className="ml-1">&rarr;</span>
              </button>
            </div>
          </div>

        </div>
      </main>
    </div>
  )
}
