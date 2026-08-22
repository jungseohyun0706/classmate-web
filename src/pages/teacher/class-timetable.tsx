import React, { useState, useEffect } from 'react'
import { useRouter } from 'next/router'
import { initFirebase } from '../../lib/firebase'
import { getAuth, onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc, getFirestore } from 'firebase/firestore'
import TeacherLayout from '../../components/Layout'
import { toast } from '../../lib/toast'
import {
  DAYS_EN, DAYS_KO, PERIODS, readClassTimetable, writeClassTimetable, itemsToCells, gridToItems,
  cellsToSubjectGrid, type WeekGrid,
} from '../../lib/timetable'

initFirebase()

const emptyGrid = (): WeekGrid => ({
  mon: ['', '', '', '', '', '', ''],
  tue: ['', '', '', '', '', '', ''],
  wed: ['', '', '', '', '', '', ''],
  thu: ['', '', '', '', '', '', ''],
  fri: ['', '', '', '', '', '', ''],
})

export default function TimetablePage() {
  const router = useRouter()
  const auth = getAuth()

  const [loading, setLoading] = useState(true)
  const [userData, setUserData] = useState<any>(null)

  const [timetable, setTimetable] = useState<WeekGrid>(emptyGrid())
  const [teachers, setTeachers] = useState<WeekGrid>(emptyGrid())
  const [saving, setSaving] = useState(false)

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
          const data = snap.data()
          if (!data.classId) {
            toast('담당 학급이 없습니다. 먼저 반을 등록해 주세요.', 'info')
            router.replace('/teacher/register-class')
            return
          }
          setUserData(data)

          // 통합 리더: canonical(timetable 필드) 우선, legacy 폴백
          const { items } = await readClassTimetable(db, data.classId)
          if (items.length) {
            const cells = itemsToCells(items)
            setTimetable(cellsToSubjectGrid(cells))
            const tg = emptyGrid()
            for (const en of DAYS_EN) tg[en] = cells[en].map((c) => c.teacher || '')
            setTeachers(tg)
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

  const handleChange = (day: keyof WeekGrid, periodIndex: number, value: string) => {
    setTimetable((prev) => ({
      ...prev,
      [day]: prev[day].map((item, idx) => (idx === periodIndex ? value : item)),
    }))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const db = getFirestore()
      // canonical + legacy 양쪽에 저장 → 모바일 앱·학생 페이지 모두 즉시 반영
      const items = gridToItems(timetable, teachers)
      await writeClassTimetable(db, userData.classId, items, {
        schoolCode: userData.schoolCode || null,
        schoolName: userData.schoolName || null,
        grade: userData.grade ?? null,
        classNm: userData.classNm ?? null,
      })
      toast('시간표가 저장되었습니다. 학생 화면에 바로 반영돼요.')
    } catch (e) {
      console.error(e)
      toast('저장에 실패했습니다.', 'error')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <TeacherLayout title="학급 시간표 관리">
        <div className="p-10 text-center text-gray-500">로딩 중...</div>
      </TeacherLayout>
    )
  }

  return (
    <TeacherLayout
      title="학급 시간표 관리 🗓"
      subtitle={`${userData?.schoolName || ''} ${userData?.grade || ''}학년 ${userData?.classNm || ''}반 — 저장하면 학생 페이지와 앱에 바로 반영됩니다.`}
    >
      <div className="flex justify-end mb-4">
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex justify-center py-2 px-6 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none disabled:opacity-50"
        >
          {saving ? '저장 중...' : '시간표 저장하기'}
        </button>
      </div>

      <div className="bg-white shadow rounded-xl overflow-hidden border border-gray-200 max-w-5xl">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-16">교시</th>
                {DAYS_KO.map((day) => (
                  <th key={day} className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">{day}</th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {PERIODS.map((period, pIdx) => (
                <tr key={period}>
                  <td className="px-4 py-3 whitespace-nowrap text-center text-sm font-bold text-gray-700 bg-gray-50">{period}교시</td>
                  {DAYS_EN.map((day) => (
                    <td key={`${day}-${period}`} className="p-1 relative">
                      <input
                        type="text"
                        className="w-full text-center border-none focus:ring-2 focus:ring-blue-500 rounded p-2 text-sm text-gray-900 placeholder-gray-300"
                        value={timetable[day][pIdx]}
                        placeholder="과목"
                        onChange={(e) => handleChange(day, pIdx, e.target.value)}
                      />
                      <input
                        type="text"
                        className="w-full text-center border-none focus:ring-1 focus:ring-blue-300 rounded px-2 pb-1 text-[11px] text-gray-400 placeholder-gray-200"
                        value={teachers[day][pIdx]}
                        placeholder="선생님(선택)"
                        onChange={(e) =>
                          setTeachers((prev) => ({
                            ...prev,
                            [day]: prev[day].map((t, idx) => (idx === pIdx ? e.target.value : t)),
                          }))
                        }
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </TeacherLayout>
  )
}
