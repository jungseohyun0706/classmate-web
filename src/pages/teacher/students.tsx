import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { auth, db } from '../../lib/firebase'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc, collection, query, where, getDocs, orderBy, updateDoc } from 'firebase/firestore'
import { useUI } from '../../components/ui/feedback'

type Student = {
  id: string
  name: string
  studentId: number // 출석번호
  parentPhone?: string
  status: 'pending' | 'approved' | 'rejected'
}

export default function StudentList() {
  const router = useRouter()
  const { toast, confirm } = useUI()
  const [loading, setLoading] = useState(true)
  const [students, setStudents] = useState<Student[]>([])
  const [classInfo, setClassInfo] = useState<any>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace('/auth/login')
        return
      }

      try {
        // 1. 선생님 정보(반 ID) 가져오기
        const userSnap = await getDoc(doc(db, 'users', user.uid))
        if (!userSnap.exists()) return
        const userData = userSnap.data()

        if (!userData.classId) {
          toast('아직 등록된 학급이 없어요', 'info')
          router.replace('/dashboard')
          return
        }
        setClassInfo(userData)

        // 2. 학생 목록 가져오기 (해당 반 ID로 필터링)
        // users 컬렉션에서 role='student'이고 classId가 일치하는 애들
        const q = query(
          collection(db, 'users'),
          where('classId', '==', userData.classId),
          where('role', '==', 'student'),
          orderBy('studentId', 'asc') // 번호순 정렬
        )

        const querySnapshot = await getDocs(q)
        const list: Student[] = []
        querySnapshot.forEach((snap) => {
          const student = { id: snap.id, ...snap.data() } as Student
          if (student.status !== 'rejected') list.push(student)
        })
        setStudents(list)

      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    })
    return () => unsub()
  }, [router, toast])

  // 승인하기: 낙관적 업데이트 후 실패 시 롤백
  const handleApprove = async (student: Student) => {
    if (busyId) return
    setBusyId(student.id)
    const prev = students
    setStudents((cur) => cur.map((s) => (s.id === student.id ? { ...s, status: 'approved' as const } : s)))
    try {
      await updateDoc(doc(db, 'users', student.id), { status: 'approved' })
      toast('승인했어요', 'success')
    } catch (e) {
      console.error(e)
      setStudents(prev)
      toast('승인에 실패했어요. 다시 시도해주세요.', 'error')
    } finally {
      setBusyId(null)
    }
  }

  // 거절: 확인 후 목록에서 제거, 실패 시 롤백
  const handleReject = async (student: Student) => {
    if (busyId) return
    const ok = await confirm({
      title: '가입 요청을 거절할까요?',
      description: `${student.name} 학생의 가입 요청을 거절해요. 거절하면 대기 목록에서 사라져요.`,
      confirmText: '거절하기',
      cancelText: '취소',
      danger: true,
    })
    if (!ok) return

    setBusyId(student.id)
    const prev = students
    setStudents((cur) => cur.filter((s) => s.id !== student.id))
    try {
      await updateDoc(doc(db, 'users', student.id), { status: 'rejected' })
      toast('거절했어요', 'success')
    } catch (e) {
      console.error(e)
      setStudents(prev)
      toast('거절에 실패했어요. 다시 시도해주세요.', 'error')
    } finally {
      setBusyId(null)
    }
  }

  if (loading) return <div className="p-10 text-center">로딩 중...</div>

  const pendingStudents = students.filter((s) => s.status === 'pending')
  const approvedStudents = students.filter((s) => s.status === 'approved')

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">학생 관리</h1>
            <p className="text-sm text-gray-600">{classInfo?.schoolName} {classInfo?.grade}학년 {classInfo?.classNm}반</p>
          </div>
          <button
            onClick={() => router.push('/dashboard')}
            className="shrink-0 whitespace-nowrap min-h-[44px] px-2 text-gray-500 hover:text-gray-700"
          >
            &larr; 대시보드로
          </button>
        </div>

        {students.length === 0 ? (
          <div className="bg-white shadow rounded-xl p-10 text-center text-gray-500">
            <p>아직 등록된 학생이 없어요.</p>
            <p className="text-sm mt-2">학생들이 앱에서 가입하면 여기에 표시돼요.</p>
          </div>
        ) : (
          <div className="space-y-8">

            {/* 승인 대기 섹션 */}
            {pendingStudents.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <h2 className="text-lg font-semibold text-gray-900">승인 대기</h2>
                  <span className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-2 rounded-full bg-amber-100 text-amber-700 text-xs font-bold">
                    {pendingStudents.length}
                  </span>
                </div>
                <div className="bg-white shadow rounded-xl overflow-hidden">
                  <ul className="divide-y divide-gray-200">
                    {pendingStudents.map((student) => (
                      <li key={student.id} className="px-4 py-4 sm:px-6">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex items-center min-w-0">
                            <span className="h-9 w-9 shrink-0 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center font-bold text-sm mr-3">
                              {student.studentId}
                            </span>
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-gray-900 truncate">{student.name}</div>
                              <div className="text-xs text-gray-500">승인 대기 중이에요</div>
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleApprove(student)}
                              disabled={busyId === student.id}
                              className="flex-1 sm:flex-none min-h-[44px] px-5 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              승인하기
                            </button>
                            <button
                              onClick={() => handleReject(student)}
                              disabled={busyId === student.id}
                              className="flex-1 sm:flex-none min-h-[44px] px-5 rounded-lg bg-red-50 text-red-600 text-sm font-semibold hover:bg-red-100 transition disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              거절
                            </button>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              </section>
            )}

            {/* 승인된 학생 섹션 */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <h2 className="text-lg font-semibold text-gray-900">우리 반 학생</h2>
                <span className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-2 rounded-full bg-blue-100 text-blue-600 text-xs font-bold">
                  {approvedStudents.length}
                </span>
              </div>
              <div className="bg-white shadow rounded-xl overflow-hidden">
                {approvedStudents.length === 0 ? (
                  <div className="p-10 text-center text-gray-500">
                    <p>아직 승인된 학생이 없어요.</p>
                    <p className="text-sm mt-2">위의 대기 목록에서 승인하면 여기에 표시돼요.</p>
                  </div>
                ) : (
                  <ul className="divide-y divide-gray-200">
                    {approvedStudents.map((student) => (
                      <li key={student.id} className="px-4 py-4 sm:px-6 flex items-center hover:bg-gray-50">
                        <span className="h-9 w-9 shrink-0 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center font-bold text-sm mr-3">
                          {student.studentId}
                        </span>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-gray-900 truncate">{student.name}</div>
                          <div className="text-xs text-gray-500">승인됨</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

          </div>
        )}
      </div>
    </div>
  )
}
