import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { auth } from '../../lib/firebase'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc, collection, query, where, getDocs, orderBy } from 'firebase/firestore'
import { useUI } from '../../components/ui/feedback'

const PERIODS = [1, 2, 3, 4, 5, 6, 7]
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri']
const DAY_LABELS = ['월', '화', '수', '목', '금']

export default function ViewTimetables() {
  const router = useRouter()
  const { toast } = useUI()
  const [loading, setLoading] = useState(true)
  const [classes, setClasses] = useState<any[]>([])
  const [selectedClass, setSelectedClass] = useState<any>(null)
  const [timetable, setTimetable] = useState<any>(null)
  const [schoolName, setSchoolName] = useState('')

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.replace('/auth/login')
        return
      }
      try {
        const { db } = await import('../../lib/firebase')
        const userSnap = await getDoc(doc(db, 'users', u.uid))
        if (!userSnap.exists()) return
        const userData = userSnap.data()

        if (!userData.schoolCode) {
          toast('학교 정보가 없어요.', 'error')
          router.replace('/dashboard')
          return
        }
        setSchoolName(userData.schoolName)

        // 우리 학교의 모든 반 가져오기
        const q = query(
          collection(db, 'classes'),
          where('schoolCode', '==', userData.schoolCode),
          orderBy('grade', 'asc'),
          orderBy('classNm', 'asc')
        )
        const snapshot = await getDocs(q)
        const list: any[] = []
        snapshot.forEach(doc => list.push({ id: doc.id, ...doc.data() }))
        setClasses(list)

      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    })
    return () => unsub()
  }, [router, toast])

  const loadTimetable = async (classId: string) => {
    try {
      const { db } = await import('../../lib/firebase')
      
      // 1. 새로운 방식: classes/{classId} 문서의 timetable 필드 확인 (앱 연동 방식)
      const classSnap = await getDoc(doc(db, 'classes', classId))
      if (classSnap.exists() && classSnap.data().timetable) {
        const rawItems = classSnap.data().timetable;
        // TimetableItem[] 형식을 요일별 객체로 변환
        const formatted: any = { mon: [], tue: [], wed: [], thu: [], fri: [] };
        const dayMap: any = { '월': 'mon', '화': 'tue', '수': 'wed', '목': 'thu', '금': 'fri' };
        
        rawItems.forEach((item: any) => {
          const dayKey = dayMap[item.day];
          if (dayKey) {
            // 교시 인덱스 계산 (start 시간을 기준으로 하거나 id에서 추출)
            const period = parseInt(item.id?.split('-').pop() || '1') - 1;
            if (period >= 0 && period < 7) {
              formatted[dayKey][period] = item.subject;
            }
          }
        });
        setTimetable(formatted);
        return;
      }

      // 2. 기존 방식: classes/{classId}/info/timetable 문서 확인
      const snap = await getDoc(doc(db, 'classes', classId, 'info', 'timetable'))
      if (snap.exists()) {
        setTimetable(snap.data())
      } else {
        setTimetable(null) // 시간표 없음
      }
    } catch (e) {
      console.error(e)
    }
  }

  const handleClassClick = (cls: any) => {
    setSelectedClass(cls)
    setTimetable(null) // 초기화
    loadTimetable(cls.classId)
  }

  if (loading) return <div className="p-10 text-center">로딩 중...</div>

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4 sm:px-6 lg:px-8">
      <div className="max-w-6xl mx-auto">
        
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{schoolName} 전체 시간표 🏫</h1>
            <p className="text-sm text-gray-600">다른 반의 시간표를 조회할 수 있습니다.</p>
          </div>
          <button onClick={() => router.push('/dashboard')} className="shrink-0 whitespace-nowrap text-gray-500 hover:text-gray-700 font-medium px-3">
            나가기
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          
          {/* 왼쪽: 반 목록 */}
          <div className="bg-white shadow rounded-xl overflow-hidden border border-gray-200 h-fit">
            <div className="p-4 bg-gray-50 border-b border-gray-200 font-bold text-gray-700">
              학급 목록
            </div>
            <div className="divide-y divide-gray-100 max-h-[600px] overflow-y-auto">
              {classes.length === 0 ? (
                <div className="p-6 text-center text-gray-400 text-sm">등록된 반이 없습니다.</div>
              ) : classes.map((cls) => (
                <div 
                  key={cls.classId}
                  onClick={() => handleClassClick(cls)}
                  className={`p-4 cursor-pointer hover:bg-blue-50 transition flex justify-between items-center ${selectedClass?.classId === cls.classId ? 'bg-blue-100' : ''}`}
                >
                  <span className="font-medium text-gray-900">{cls.grade}학년 {cls.classNm}반</span>
                  <span className="text-xs text-gray-500">{cls.teacherName} T</span>
                </div>
              ))}
            </div>
          </div>

          {/* 오른쪽: 시간표 뷰어 */}
          <div className="md:col-span-2">
            {selectedClass ? (
              <div className="bg-white shadow rounded-xl overflow-hidden border border-gray-200 animate-fade-in">
                <div className="p-4 bg-blue-600 text-white font-bold flex justify-between items-center">
                  <span>{selectedClass.grade}학년 {selectedClass.classNm}반 시간표</span>
                  <span className="text-xs font-normal bg-blue-700 px-2 py-1 rounded">담임: {selectedClass.teacherName}</span>
                </div>
                
                {timetable ? (
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 w-16 text-center text-xs font-medium text-gray-500 uppercase">교시</th>
                          {DAY_LABELS.map((day) => (
                            <th key={day} className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">{day}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {PERIODS.map((period, pIdx) => (
                          <tr key={period}>
                            <td className="px-4 py-3 text-center text-sm font-bold text-gray-700 bg-gray-50">{period}교시</td>
                            {DAYS.map((day) => (
                              <td key={`${day}-${period}`} className="p-3 text-center text-sm text-gray-900 border-l border-gray-100">
                                {timetable[day][pIdx] || '-'}
                              </td>
                            ))}
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
      </div>
    </div>
  )
}
