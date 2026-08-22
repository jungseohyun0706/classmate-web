import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { initFirebase } from '../../lib/firebase'
import { getAuth, onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc, collection, query, where, getDocs, getFirestore } from 'firebase/firestore'
import TeacherLayout from '../../components/Layout'
import { toast } from '../../lib/toast'
import Link from 'next/link'
import { DAYS_EN, DAYS_KO, PERIODS, readClassTimetable, itemsToCells, type WeekCells } from '../../lib/timetable'

initFirebase()

export default function ViewTimetables() {
  const router = useRouter()
  const auth = getAuth()
  const [loading, setLoading] = useState(true)
  const [classes, setClasses] = useState<any[]>([])
  const [selectedClass, setSelectedClass] = useState<any>(null)
  const [cells, setCells] = useState<WeekCells | null>(null)
  const [loadingTable, setLoadingTable] = useState(false)
  const [schoolName, setSchoolName] = useState('')

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.replace('/auth/login')
        return
      }
      try {
        const db = getFirestore()
        const userSnap = await getDoc(doc(db, 'users', u.uid))
        if (!userSnap.exists()) return
        const userData = userSnap.data()

        if (!userData.schoolCode) {
          toast('학교 정보가 없습니다. 먼저 반을 등록해 주세요.', 'info')
          router.replace('/teacher/register-class')
          return
        }
        setSchoolName(userData.schoolName)

        // 우리 학교의 모든 반 (정렬은 클라이언트에서 — 복합 인덱스 불필요)
        const q = query(collection(db, 'classes'), where('schoolCode', '==', userData.schoolCode))
        const snapshot = await getDocs(q)
        const list: any[] = []
        snapshot.forEach((d) => list.push({ id: d.id, ...d.data() }))
        list.sort((a, b) => (a.grade ?? 0) - (b.grade ?? 0) || (a.classNm ?? 0) - (b.classNm ?? 0))
        setClasses(list)
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    })
    return () => unsub()
  }, [router, auth])

  const handleClassClick = async (cls: any) => {
    setSelectedClass(cls)
    setCells(null)
    setLoadingTable(true)
    try {
      const db = getFirestore()
      const { items } = await readClassTimetable(db, cls.classId || cls.id)
      setCells(items.length ? itemsToCells(items) : null)
    } catch (e) {
      console.error(e)
      toast('시간표를 불러오지 못했습니다.', 'error')
    } finally {
      setLoadingTable(false)
    }
  }

  if (loading) {
    return (
      <TeacherLayout title="전체 시간표">
        <div className="p-10 text-center text-gray-500">로딩 중...</div>
      </TeacherLayout>
    )
  }

  return (
    <TeacherLayout title={`${schoolName} 전체 시간표 🏫`} subtitle="다른 반의 시간표를 조회할 수 있습니다.">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* 왼쪽: 반 목록 */}
        <div className="bg-white shadow rounded-xl overflow-hidden border border-gray-200 h-fit">
          <div className="p-4 bg-gray-50 border-b border-gray-200 font-bold text-gray-700">학급 목록</div>
          <div className="divide-y divide-gray-100 max-h-[600px] overflow-y-auto">
            {classes.length === 0 ? (
              <div className="p-6 text-center text-gray-400 text-sm">
                등록된 반이 없습니다.
                <div className="mt-2">
                  <Link className="text-blue-600 underline" href="/teacher/upload-timetable">시간표 업로드</Link>로 한 번에 만들 수 있어요.
                </div>
              </div>
            ) : (
              classes.map((cls) => (
                <div
                  key={cls.id}
                  onClick={() => handleClassClick(cls)}
                  className={`p-4 cursor-pointer hover:bg-blue-50 transition flex justify-between items-center ${selectedClass?.id === cls.id ? 'bg-blue-100' : ''}`}
                >
                  <span className="font-medium text-gray-900">{cls.grade}학년 {cls.classNm}반</span>
                  {cls.teacherName && <span className="text-xs text-gray-500">{cls.teacherName} T</span>}
                </div>
              ))
            )}
          </div>
        </div>

        {/* 오른쪽: 시간표 뷰어 */}
        <div className="md:col-span-2">
          {selectedClass ? (
            <div className="bg-white shadow rounded-xl overflow-hidden border border-gray-200 animate-fade-in">
              <div className="p-4 bg-blue-600 text-white font-bold flex justify-between items-center">
                <span>{selectedClass.grade}학년 {selectedClass.classNm}반 시간표</span>
                {selectedClass.teacherName && (
                  <span className="text-xs font-normal bg-blue-700 px-2 py-1 rounded">담임: {selectedClass.teacherName}</span>
                )}
              </div>

              {loadingTable ? (
                <div className="p-10 text-center text-gray-400">불러오는 중...</div>
              ) : cells ? (
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 w-16 text-center text-xs font-medium text-gray-500 uppercase">교시</th>
                        {DAYS_KO.map((day) => (
                          <th key={day} className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">{day}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {PERIODS.map((period) => (
                        <tr key={period}>
                          <td className="px-4 py-3 text-center text-sm font-bold text-gray-700 bg-gray-50">{period}교시</td>
                          {DAYS_EN.map((day) => {
                            const cell = cells[day][period - 1]
                            return (
                              <td key={`${day}-${period}`} className="p-3 text-center text-sm text-gray-900 border-l border-gray-100">
                                <div>{cell.subject || '-'}</div>
                                {cell.teacher && <div className="text-[10px] text-gray-400">{cell.teacher}</div>}
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="p-10 text-center text-gray-400">
                  <svg className="mx-auto h-12 w-12 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <p className="mt-2">아직 시간표가 등록되지 않았습니다.</p>
                </div>
              )}
            </div>
          ) : (
            <div className="h-64 flex flex-col items-center justify-center text-gray-400 bg-white shadow rounded-xl border border-dashed border-gray-300">
              <p>왼쪽 목록에서 반을 선택하세요.</p>
            </div>
          )}
        </div>
      </div>
    </TeacherLayout>
  )
}
