import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { initFirebase } from '../../lib/firebase'
import { getAuth, onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc, collection, query, where, getDocs, updateDoc, getFirestore } from 'firebase/firestore'
import TeacherLayout from '../../components/Layout'
import { toast } from '../../lib/toast'

initFirebase()

type Student = {
  id: string
  name?: string
  displayName?: string
  studentId?: number // 출석번호
  parentPhone?: string
  status?: 'pending' | 'approved'
}

export default function StudentList() {
  const router = useRouter()
  const auth = getAuth()
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
        const db = getFirestore()

        // 1. 선생님 정보(반 ID) 가져오기
        const userSnap = await getDoc(doc(db, 'users', user.uid))
        if (!userSnap.exists()) return
        const userData = userSnap.data()

        if (!userData.classId) {
          toast('담당 학급이 없습니다. 먼저 반을 등록해 주세요.', 'info')
          router.replace('/teacher/register-class')
          return
        }
        setClassInfo(userData)

        // 2. 학생 목록 가져오기 (해당 반 ID로 필터링, 정렬은 클라이언트에서)
        const q = query(
          collection(db, 'users'),
          where('classId', '==', userData.classId),
          where('role', '==', 'student'),
        )

        const querySnapshot = await getDocs(q)
        const list: Student[] = []
        querySnapshot.forEach((d) => {
          list.push({ id: d.id, ...d.data() } as Student)
        })
        list.sort((a, b) => (a.studentId ?? 999) - (b.studentId ?? 999))
        setStudents(list)
      } catch (e) {
        console.error(e)
        toast('학생 목록을 불러오지 못했습니다.', 'error')
      } finally {
        setLoading(false)
      }
    })
    return () => unsub()
  }, [router, auth])

  const approve = async (student: Student) => {
    setBusyId(student.id)
    try {
      const db = getFirestore()
      await updateDoc(doc(db, 'users', student.id), { status: 'approved' })
      setStudents((prev) => prev.map((s) => (s.id === student.id ? { ...s, status: 'approved' } : s)))
      toast(`${student.name || student.displayName || '학생'} 님을 승인했습니다.`)
    } catch (e) {
      console.error(e)
      toast('승인에 실패했습니다.', 'error')
    } finally {
      setBusyId(null)
    }
  }

  if (loading) {
    return (
      <TeacherLayout title="학생 관리">
        <div className="p-10 text-center text-gray-500">로딩 중...</div>
      </TeacherLayout>
    )
  }

  return (
    <TeacherLayout
      title="학생 관리 🧑‍🎓"
      subtitle={`${classInfo?.schoolName || ''} ${classInfo?.grade || ''}학년 ${classInfo?.classNm || ''}반`}
    >
      <div className="max-w-3xl">
        <div className="bg-white shadow overflow-hidden rounded-xl border border-gray-200">
          {students.length === 0 ? (
            <div className="p-10 text-center text-gray-500">
              <p>아직 등록된 학생이 없습니다.</p>
              <p className="text-sm mt-2">학생들이 앱에서 가입하면 여기에 뜹니다.</p>
            </div>
          ) : (
            <ul className="divide-y divide-gray-200">
              {students.map((student) => (
                <li key={student.id} className="px-6 py-4 flex items-center justify-between hover:bg-gray-50">
                  <div className="flex items-center">
                    <span className="h-8 w-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center font-bold text-sm mr-4">
                      {student.studentId ?? '·'}
                    </span>
                    <div>
                      <div className="text-sm font-medium text-gray-900">{student.name || student.displayName || '이름 없음'}</div>
                      <div className="text-xs text-gray-500">
                        {student.status === 'approved' ? '승인됨' : '승인 대기중'}
                      </div>
                    </div>
                  </div>
                  <div>
                    {student.status !== 'approved' && (
                      <button
                        onClick={() => approve(student)}
                        disabled={busyId === student.id}
                        className="text-xs bg-indigo-600 text-white px-3 py-1.5 rounded hover:bg-indigo-700 disabled:opacity-50"
                      >
                        {busyId === student.id ? '처리 중...' : '승인하기'}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </TeacherLayout>
  )
}
