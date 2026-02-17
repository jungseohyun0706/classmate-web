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

  if (loading) return <div className="p-10 text-center text-black">로딩 중...</div>

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4 sm:px-6 lg:px-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex justify-between items-center mb-6 text-black">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">학급 시간표 관리</h1>
            <p className="text-sm text-gray-600">{userData?.schoolName} {userData?.grade}학년 {userData?.classNm}반</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => router.push('/dashboard')} className="text-gray-500 hover:text-gray-700 font-medium px-4">나가기</button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="inline-flex justify-center py-2 px-6 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none disabled:opacity-50"
            >
              {saving ? '저장 중...' : '시간표 저장하기'}
            </button>
          </div>
        </div>

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
                        <input
                          type="text"
                          className="w-full text-center border-none focus:ring-2 focus:ring-blue-500 rounded p-2 text-sm text-gray-900 placeholder-gray-300"
                          value={timetable[day][pIdx]}
                          onChange={(e) => handleChange(day, pIdx, e.target.value)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
