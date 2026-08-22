import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { initFirebase } from '../lib/firebase'
import { getAuth, onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc, getFirestore } from 'firebase/firestore'
import TeacherLayout from '../components/Layout'
import { toast } from '../lib/toast'

initFirebase()

export default function Dashboard() {
  const router = useRouter()
  const [userData, setUserData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const auth = getAuth()

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.replace('/auth/login')
        return
      }
      try {
        const db = getFirestore()
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

  const hasClass = userData?.classId && userData?.schoolName
  const hasSchool = !!userData?.schoolCode

  const studentUrl = hasClass
    ? `/s/${userData.schoolCode}/${userData.grade}/${userData.classNm}${userData.officeCode ? `?office=${userData.officeCode}` : ''}`
    : '/s'

  const copyStudentLink = async () => {
    try {
      const url = `${window.location.origin}${studentUrl}`
      await navigator.clipboard.writeText(url)
      toast('학생용 시간표 링크가 복사되었습니다. 학급 게시판에 공유하세요!')
    } catch {
      toast('복사에 실패했습니다.', 'error')
    }
  }

  const cards = [
    {
      id: 'upload',
      title: '시간표 파일 업로드',
      desc: '엑셀 하나로 전교 시간표를 등록합니다.',
      emoji: '📄',
      bgColor: 'bg-blue-100',
      onClick: () => router.push('/teacher/upload-timetable'),
      needSchool: true,
    },
    {
      id: 'my-schedule',
      title: '내 수업 및 교환',
      desc: '개인 시간표 관리, 보결·맞교환 요청.',
      emoji: '🔄',
      bgColor: 'bg-red-100',
      onClick: () => router.push('/teacher/my-schedule'),
    },
    {
      id: 'requests',
      title: '교환 요청함',
      desc: '받은 요청을 수락하면 시간표에 자동 반영.',
      emoji: '📥',
      bgColor: 'bg-purple-100',
      onClick: () => router.push('/teacher/requests'),
    },
    {
      id: 'students',
      title: hasClass ? '학생 관리' : '내 학교/반 등록',
      desc: hasClass ? '우리 반 학생 목록과 가입 승인.' : '학교와 담당 학급을 설정하세요.',
      emoji: hasClass ? '🧑‍🎓' : '🏫',
      bgColor: hasClass ? 'bg-indigo-100' : 'bg-blue-100',
      onClick: () => router.push(hasClass ? '/teacher/students' : '/teacher/register-class'),
    },
    {
      id: 'class-timetable',
      title: '학급 시간표 관리',
      desc: '우리 반 시간표를 직접 수정합니다.',
      emoji: '🗓',
      bgColor: 'bg-yellow-100',
      onClick: () => router.push('/teacher/class-timetable'),
      needClass: true,
    },
    {
      id: 'notice',
      title: '공지사항 작성',
      desc: '학생들에게 알림장을 보내세요.',
      emoji: '📢',
      bgColor: 'bg-green-100',
      onClick: () => router.push('/teacher/notice/write'),
      needClass: true,
    },
    {
      id: 'view-others',
      title: '전체 시간표 조회',
      desc: '학교 모든 반의 시간표를 봅니다.',
      emoji: '🔍',
      bgColor: 'bg-teal-100',
      onClick: () => router.push('/teacher/view-timetables'),
      needSchool: true,
    },
    {
      id: 'student-link',
      title: '학생용 페이지 공유',
      desc: '로그인 없이 보는 우리 반 시간표 링크 복사.',
      emoji: '🔗',
      bgColor: 'bg-orange-100',
      onClick: copyStudentLink,
      needClass: true,
    },
  ]

  if (loading) {
    return (
      <TeacherLayout>
        <div className="min-h-[50vh] flex items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
        </div>
      </TeacherLayout>
    )
  }

  return (
    <TeacherLayout>
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">
          {hasClass ? `${userData.schoolName} ${userData.grade}학년 ${userData.classNm}반 👋` : `반갑습니다, ${userData?.displayName || '선생님'}! 👋`}
        </h1>
        <p className="mt-2 text-lg text-gray-600">
          {hasClass ? '오늘도 학생들과 즐거운 하루 보내세요.' : '먼저 학교와 담당 학급을 등록해주세요.'}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <div
            key={card.id}
            onClick={() => {
              if ((card as any).needClass && !hasClass) {
                toast('먼저 내 학교/반 등록을 완료해 주세요.', 'info')
                router.push('/teacher/register-class')
                return
              }
              if ((card as any).needSchool && !hasSchool) {
                toast('먼저 내 학교/반 등록을 완료해 주세요.', 'info')
                router.push('/teacher/register-class')
                return
              }
              card.onClick()
            }}
            className="group cursor-pointer bg-white overflow-hidden shadow-lg rounded-xl border border-gray-100 hover:border-blue-300 hover:shadow-2xl transition-all duration-200"
          >
            <div className="p-6">
              <div className="flex items-center">
                <div className={`flex-shrink-0 rounded-md p-3 text-2xl ${card.bgColor} group-hover:scale-110 transition-transform duration-200`}>
                  {card.emoji}
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
      </div>

      <div className="mt-10 bg-blue-50 border border-blue-100 rounded-xl p-5 text-sm text-blue-800">
        📱 <b>모바일에서도 그대로:</b> 이 페이지를 폰 브라우저에서 열고 &lsquo;홈 화면에 추가&rsquo;하면 앱처럼 사용할 수 있어요.
        학생들에게는 <b>학생용 페이지 공유</b> 링크를 전달하면 설치·로그인 없이 시간표를 볼 수 있습니다.
      </div>
    </TeacherLayout>
  )
}
