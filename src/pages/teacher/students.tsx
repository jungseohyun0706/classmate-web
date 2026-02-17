import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { initFirebase } from '../../lib/firebase'
import { getAuth, onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc, collection, query, where, getDocs, orderBy } from 'firebase/firestore'

initFirebase()

type Student = {
  id: string
  name: string
  studentId: number // 출석번호
  parentPhone?: string
  status: 'pending' | 'approved'
}

export default function StudentList() {
  const router = useRouter()
  const auth = getAuth()
  const [loading, setLoading] = useState(true)
  const [students, setStudents] = useState<Student[]>([])
  const [classInfo, setClassInfo] = useState<any>(null)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace('/auth/login')
        return
      }
      
      try {
        const { db } = await import('../../lib/firebase')
        
        // 1. 선생님 정보(반 ID) 가져오기
        const userSnap = await getDoc(doc(db, 'users', user.uid))
        if (!userSnap.exists()) return
        const userData = userSnap.data()
        
        if (!userData.classId) {
          alert('담당 학급이 없습니다.')
          router.replace('/dashboard')
          return
        }
        setClassInfo(userData)

        // 2. 학생 목록 가져오기 (해당 반 ID로 필터링)
        // users 컬렉션에서 role='student'이고 classId가 일치하는 애들
        // (아직 학생앱은 안 만들었지만 구조는 이렇게 짬)
        const q = query(
          collection(db, 'users'),
          where('classId', '==', userData.classId),
          where('role', '==', 'student'),
          orderBy('studentId', 'asc') // 번호순 정렬
        )
        
        const querySnapshot = await getDocs(q)
        const list: Student[] = []
        querySnapshot.forEach((doc) => {
          list.push({ id: doc.id, ...doc.data() } as Student)
        })
        setStudents(list)

      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    })
    return () => unsub()
  }, [router, auth])

  if (loading) return <div className="p-10 text-center">로딩 중...</div>

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">학생 관리</h1>
            <p className="text-sm text-gray-600">{classInfo?.schoolName} {classInfo?.grade}학년 {classInfo?.classNm}반</p>
          </div>
          <button onClick={() => router.push('/dashboard')} className="text-gray-500 hover:text-gray-700">
            &larr; 대시보드로
          </button>
        </div>

        <div className="bg-white shadow overflow-hidden sm:rounded-lg">
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
                      {student.studentId}
                    </span>
                    <div>
                      <div className="text-sm font-medium text-gray-900">{student.name}</div>
                      <div className="text-xs text-gray-500">{student.status === 'pending' ? '승인 대기중' : '승인됨'}</div>
                    </div>
                  </div>
                  <div>
                    {student.status === 'pending' && (
                      <button className="text-xs bg-indigo-600 text-white px-3 py-1 rounded hover:bg-indigo-700">
                        승인하기
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
