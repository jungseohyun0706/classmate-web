import React, { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { initFirebase } from '../../lib/firebase'
import { getAuth, onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore'

initFirebase()

type Student = {
  id: string
  name: string
  studentId: number | null // 출석번호 (없을 수도 있음)
  parentPhone?: string
  status: 'pending' | 'approved'
}

type LoadError = {
  code: string
  message: string
  indexUrl?: string
}

// 학생 앱(모바일)이 쓰는 필드명이 웹과 100% 같다고 보장할 수 없어서 방어적으로 읽는다.
const toStudent = (id: string, raw: any): Student => {
  const numberish = raw?.studentId ?? raw?.studentNo ?? raw?.number ?? raw?.attendanceNo
  const parsed = typeof numberish === 'number' ? numberish : parseInt(String(numberish ?? ''), 10)
  return {
    id,
    name: raw?.name || raw?.displayName || raw?.email || '이름 없음',
    studentId: Number.isFinite(parsed) ? parsed : null,
    parentPhone: raw?.parentPhone,
    status: raw?.status === 'approved' ? 'approved' : 'pending',
  }
}

// 출석번호 순 정렬. 번호가 없는 학생은 뒤로 보내고 이름순으로.
const byStudentNumber = (a: Student, b: Student) => {
  if (a.studentId === null && b.studentId === null) return a.name.localeCompare(b.name)
  if (a.studentId === null) return 1
  if (b.studentId === null) return -1
  return a.studentId - b.studentId
}

const extractIndexUrl = (message: string) => {
  const match = message.match(/https:\/\/console\.firebase\.google\.com\/\S+/)
  return match ? match[0].replace(/[).,]+$/, '') : undefined
}

/**
 * 학생 명단 조회.
 *
 * ⚠️ 예전 코드는 where(classId) + where(role) + orderBy('studentId') 를 한 쿼리에 넣었는데,
 *    Firestore는 "동등 필터 + 다른 필드 orderBy" 조합에 복합 색인(composite index)을 요구한다.
 *    색인이 없으면 getDocs가 failed-precondition으로 던져버려서 명단이 통째로 안 나왔다.
 *    게다가 orderBy('studentId')는 studentId 필드가 아예 없는 문서를 결과에서 제외해버린다.
 *    => 서버 정렬을 빼고(색인 불필요) 클라이언트에서 정렬한다.
 */
const fetchStudents = async (db: any, classId: string): Promise<{ source: string; list: Student[] }> => {
  // 1차: users 컬렉션에서 우리 반 + role='student'
  // (동등 필터 2개뿐이라 복합 색인이 필요 없다 — my-schedule.tsx의 교사 조회와 같은 형태)
  const primary = await getDocs(
    query(collection(db, 'users'), where('classId', '==', classId), where('role', '==', 'student'))
  )
  if (!primary.empty) {
    return { source: 'users(role=student)', list: primary.docs.map((d) => toStudent(d.id, d.data())) }
  }

  // 2차: role 값이 다르게 저장됐을 수도 있으니 classId만으로 긁고 교사만 제외한다.
  try {
    const byClass = await getDocs(query(collection(db, 'users'), where('classId', '==', classId)))
    const students = byClass.docs.filter((d) => String(d.data()?.role ?? '').toLowerCase() !== 'teacher')
    if (students.length) {
      return { source: 'users(classId only)', list: students.map((d) => toStudent(d.id, d.data())) }
    }
  } catch (e) {
    console.warn('[students] classId-only fallback failed', e)
  }

  // 3차: classes/{classId}/students 서브컬렉션에 담는 구조일 수도 있다.
  try {
    const sub = await getDocs(collection(db, 'classes', classId, 'students'))
    if (!sub.empty) {
      return { source: 'classes/{id}/students', list: sub.docs.map((d) => toStudent(d.id, d.data())) }
    }
  } catch (e) {
    console.warn('[students] subcollection fallback failed', e)
  }

  return { source: 'empty', list: [] }
}

export default function StudentList() {
  const router = useRouter()
  const auth = getAuth()
  const [loading, setLoading] = useState(true)
  const [students, setStudents] = useState<Student[]>([])
  const [classInfo, setClassInfo] = useState<any>(null)
  const [error, setError] = useState<LoadError | null>(null)
  const [noClass, setNoClass] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const retry = useCallback(() => {
    setLoading(true)
    setError(null)
    setReloadKey((k) => k + 1)
  }, [])

  useEffect(() => {
    let alive = true

    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace('/auth/login')
        return
      }

      try {
        const { db } = await import('../../lib/firebase')

        // 1. 선생님 정보(반 ID) 가져오기
        const userSnap = await getDoc(doc(db, 'users', user.uid))
        if (!alive) return

        if (!userSnap.exists()) {
          // 예전에는 여기서 그냥 return 해버려서 "등록된 학생이 없습니다" 화면만 떴다.
          setError({
            code: 'profile-missing',
            message: '선생님 프로필 정보를 찾을 수 없습니다. 다시 로그인한 뒤 시도해 주세요.',
          })
          return
        }

        const userData = userSnap.data()
        if (!userData.classId) {
          setNoClass(true)
          return
        }
        setClassInfo(userData)

        // 2. 학생 목록 가져오기
        const { source, list } = await fetchStudents(db, userData.classId)
        if (!alive) return

        console.info(`[students] loaded ${list.length} student(s) from ${source}`)
        setStudents([...list].sort(byStudentNumber))
        setError(null)
      } catch (e: any) {
        console.error('[students] load failed', e)
        if (!alive) return

        const code = e?.code || 'unknown'
        const raw = e?.message || '알 수 없는 오류가 발생했습니다.'

        let message = raw
        if (code === 'permission-denied') {
          message =
            '학생 명단을 읽을 권한이 없습니다. Firestore 보안 규칙에서 담임 선생님이 우리 반 학생 문서를 조회할 수 있도록 허용해야 합니다.'
        } else if (code === 'failed-precondition') {
          message = '이 조회에 필요한 Firestore 색인이 아직 없습니다. 아래 링크로 색인을 만든 뒤 다시 시도해 주세요.'
        } else if (code === 'unavailable') {
          message = '네트워크 연결이 불안정합니다. 잠시 후 다시 시도해 주세요.'
        }

        setError({ code, message, indexUrl: extractIndexUrl(raw) })
      } finally {
        if (alive) setLoading(false)
      }
    })

    return () => {
      alive = false
      unsub()
    }
  }, [router, auth, reloadKey])

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

        {noClass && (
          <div className="bg-white shadow sm:rounded-lg p-10 text-center">
            <p className="text-gray-700 font-medium">담당 학급이 아직 등록되지 않았습니다.</p>
            <button
              onClick={() => router.push('/teacher/register-class')}
              className="mt-4 bg-blue-600 text-white px-5 py-2 rounded-lg font-bold hover:bg-blue-700 transition"
            >
              우리 반 등록하러 가기
            </button>
          </div>
        )}

        {!noClass && error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-6 mb-6">
            <p className="text-sm font-bold text-red-800">학생 명단을 불러오지 못했습니다.</p>
            <p className="text-sm text-red-700 mt-2">{error.message}</p>
            {error.indexUrl && (
              <a
                href={error.indexUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-block mt-3 text-sm font-medium text-blue-600 underline break-all"
              >
                Firestore 색인 만들기
              </a>
            )}
            <div className="mt-4 flex items-center gap-3">
              <button
                onClick={retry}
                className="text-sm bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700 transition"
              >
                다시 시도
              </button>
              <span className="text-xs text-red-500">오류 코드: {error.code}</span>
            </div>
          </div>
        )}

        {!noClass && !error && (
          <div className="bg-white shadow overflow-hidden sm:rounded-lg">
            {students.length === 0 ? (
              <div className="p-10 text-center text-gray-500">
                <p>아직 등록된 학생이 없습니다.</p>
                <p className="text-sm mt-2">학생들이 앱에서 가입하면 여기에 뜹니다.</p>
                <button onClick={retry} className="mt-4 text-sm text-blue-600 underline">
                  새로고침
                </button>
              </div>
            ) : (
              <ul className="divide-y divide-gray-200">
                {students.map((student) => (
                  <li key={student.id} className="px-6 py-4 flex items-center justify-between hover:bg-gray-50">
                    <div className="flex items-center">
                      <span className="h-8 w-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center font-bold text-sm mr-4">
                        {student.studentId ?? '-'}
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
        )}
      </div>
    </div>
  )
}
