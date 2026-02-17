import React, { useState, useEffect } from 'react'
import { useRouter } from 'next/router'
import { initFirebase } from '../../lib/firebase'
import { getAuth, onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc, setDoc, addDoc, collection, serverTimestamp } from 'firebase/firestore'

initFirebase()

const PERIODS = [1, 2, 3, 4, 5, 6, 7]
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri']
const DAY_LABELS = ['월', '화', '수', '목', '금']

export default function TimetablePage() {
  const router = useRouter()
  const auth = getAuth()
  
  const [loading, setLoading] = useState(true)
  const [userData, setUserData] = useState<any>(null)
  
  const [timetable, setTimetable] = useState<any>({
    mon: ['', '', '', '', '', '', ''],
    tue: ['', '', '', '', '', '', ''],
    wed: ['', '', '', '', '', '', ''],
    thu: ['', '', '', '', '', '', ''],
    fri: ['', '', '', '', '', '', '']
  })
  const [saving, setSaving] = useState(false)

  // 교환 모드 상태
  const [swapMode, setSwapMode] = useState(false)
  const [selectedCell, setSelectedCell] = useState<any>(null) // { day, period, subject }
  const [swapNote, setSwapNote] = useState('') // 요청 메시지

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.replace('/auth/login')
        return
      }
      try {
        const { db } = await import('../../lib/firebase')
        const snap = await getDoc(doc(db, 'users', u.uid))
        if (snap.exists()) {
          const data = snap.data()
          if (!data.classId) {
            alert('담당 학급이 없습니다.')
            router.replace('/dashboard')
            return
          }
          setUserData(data)
          
          const timeSnap = await getDoc(doc(db, 'classes', data.classId, 'info', 'timetable'))
          if (timeSnap.exists()) {
            setTimetable(timeSnap.data())
          }
        }
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    })
    return () => unsub()
  }, [router, auth])

  const handleChange = (day: string, periodIndex: number, value: string) => {
    setTimetable((prev: any) => ({
      ...prev,
      [day]: prev[day].map((item: string, idx: number) => idx === periodIndex ? value : item)
    }))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const { db } = await import('../../lib/firebase')
      await setDoc(doc(db, 'classes', userData.classId, 'info', 'timetable'), timetable, { merge: true })
      alert('시간표가 저장되었습니다.')
    } catch (e) {
      console.error(e)
      alert('저장 실패')
    } finally {
      setSaving(false)
    }
  }

  // 셀 클릭 핸들러 (교환 모드일 때)
  const handleCellClick = (day: string, periodIdx: number, subject: string) => {
    if (!swapMode) return // 편집 모드면 무시 (Input이 처리)
    if (!subject.trim()) return alert('빈 칸은 교환 요청할 수 없습니다.')
    
    setSelectedCell({
      day,
      dayLabel: DAY_LABELS[DAYS.indexOf(day)],
      period: periodIdx + 1,
      subject
    })
    setSwapNote('')
  }

  // 교환 요청 등록
  const handleSubmitSwap = async () => {
    if (!selectedCell) return
    try {
      const { db } = await import('../../lib/firebase')
      
      // school_swaps/{schoolCode}/requests 컬렉션에 저장
      // (같은 학교 선생님들만 볼 수 있게 schoolCode로 묶음)
      await addDoc(collection(db, 'school_swaps', userData.schoolCode || 'default', 'requests'), {
        requesterId: auth.currentUser?.uid,
        requesterName: userData.displayName,
        requesterClass: `${userData.grade}학년 ${userData.classNm}반`,
        
        day: selectedCell.day,
        dayLabel: selectedCell.dayLabel,
        period: selectedCell.period,
        subject: selectedCell.subject,
        note: swapNote,
        
        status: 'pending', // pending, matched, completed
        createdAt: serverTimestamp()
      })

      alert('교환 요청이 등록되었습니다! 다른 선생님들이 볼 수 있습니다.')
      setSelectedCell(null)
      setSwapMode(false) // 모드 끄기
    } catch (e) {
      console.error(e)
      alert('요청 등록 실패')
    }
  }

  if (loading) return <div className="p-10 text-center">로딩 중...</div>

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4 sm:px-6 lg:px-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">시간표 관리</h1>
            <p className="text-sm text-gray-600">{userData?.schoolName} {userData?.grade}학년 {userData?.classNm}반</p>
          </div>
          <div className="flex gap-2">
            <button 
              onClick={() => router.push('/teacher/swap-market')}
              className="bg-indigo-100 text-indigo-700 font-bold py-2 px-4 rounded hover:bg-indigo-200 transition"
            >
              교환 장터 가기 &rarr;
            </button>
            <button 
              onClick={() => setSwapMode(!swapMode)}
              className={`font-bold py-2 px-4 rounded border transition ${swapMode ? 'bg-red-500 text-white border-red-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}`}
            >
              {swapMode ? '교환 모드 종료' : '🔄 수업 교환 요청하기'}
            </button>
          </div>
        </div>

        {/* 안내 메시지 */}
        {swapMode && (
          <div className="bg-red-50 border-l-4 border-red-500 p-4 mb-6">
            <div className="flex">
              <div className="flex-shrink-0">
                <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                </svg>
              </div>
              <div className="ml-3">
                <p className="text-sm text-red-700">
                  교환하고 싶은 수업(칸)을 클릭해주세요.
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="bg-white shadow rounded-xl overflow-hidden border border-gray-200">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-16">교시</th>
                  {DAY_LABELS.map((day) => (
                    <th key={day} className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">{day}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {PERIODS.map((period, pIdx) => (
                  <tr key={period}>
                    <td className="px-4 py-3 whitespace-nowrap text-center text-sm font-bold text-gray-700 bg-gray-50">{period}교시</td>
                    {DAYS.map((day) => (
                      <td key={`${day}-${period}`} className="p-1 relative">
                        {/* 교환 모드일 때 클릭 영역 (오버레이) */}
                        {swapMode && (
                          <div 
                            className="absolute inset-0 bg-red-500 opacity-0 hover:opacity-20 cursor-pointer z-10"
                            onClick={() => handleCellClick(day, pIdx, timetable[day][pIdx])}
                          />
                        )}
                        <input
                          type="text"
                          className="w-full text-center border-none focus:ring-2 focus:ring-blue-500 rounded p-2 text-sm text-gray-900 placeholder-gray-300"
                          value={timetable[day][pIdx]}
                          onChange={(e) => handleChange(day, pIdx, e.target.value)}
                          disabled={swapMode} // 교환 모드일 땐 입력 막음
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          
          {!swapMode && (
            <div className="bg-gray-50 px-6 py-4 flex justify-end gap-2">
              <button onClick={() => router.push('/dashboard')} className="text-gray-500 hover:text-gray-700 font-medium px-4">나가기</button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="inline-flex justify-center py-2 px-6 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none disabled:opacity-50"
              >
                {saving ? '저장 중...' : '시간표 저장하기'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 교환 요청 모달 */}
      {selectedCell && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-md shadow-2xl">
            <h3 className="text-lg font-bold text-gray-900 mb-2">수업 교환 요청</h3>
            <p className="text-gray-600 mb-4">
              <span className="font-bold text-blue-600">{selectedCell.dayLabel}요일 {selectedCell.period}교시 ({selectedCell.subject})</span> 수업을 교환하시겠습니까?
            </p>
            
            <label className="block text-sm font-medium text-gray-700 mb-1">메모 (선택)</label>
            <input 
              className="w-full border border-gray-300 rounded-md p-2 mb-4" 
              placeholder="예: 수요일 2교시랑 바꾸고 싶어요 / 대강 구합니다"
              value={swapNote}
              onChange={(e) => setSwapNote(e.target.value)}
            />

            <div className="flex justify-end gap-2">
              <button 
                onClick={() => setSelectedCell(null)}
                className="px-4 py-2 text-gray-500 hover:bg-gray-100 rounded"
              >
                취소
              </button>
              <button 
                onClick={handleSubmitSwap}
                className="px-4 py-2 bg-red-600 text-white font-bold rounded hover:bg-red-700"
              >
                요청 등록하기
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
