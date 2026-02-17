import React, { useState, useEffect } from 'react'
import { useRouter } from 'next/router'
import { initFirebase } from '../../lib/firebase'
import { getAuth, onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import * as XLSX from 'xlsx'

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
      alert('시간표가 저장되었습니다. 학생들에게도 바로 반영됩니다.')
    } catch (e) {
      console.error(e)
      alert('저장 실패')
    } finally {
      setSaving(false)
    }
  }

  // 엑셀 업로드 처리
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (evt) => {
      const bstr = evt.target?.result
      const wb = XLSX.read(bstr, { type: 'binary' })
      const wsname = wb.SheetNames[0]
      const ws = wb.Sheets[wsname]
      const data = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][]

      // 데이터 파싱 로직 (단순화: 월화수목금 헤더 찾고 그 아래 7칸 읽기)
      // 1. "월"이 포함된 행 찾기
      let headerRowIndex = -1
      for (let i = 0; i < data.length; i++) {
        if (data[i].some((cell: any) => String(cell).includes('월'))) {
          headerRowIndex = i
          break
        }
      }

      if (headerRowIndex === -1) {
        // 헤더 못 찾으면 그냥 첫 줄부터 가정
        headerRowIndex = 0
      }

      // 2. 요일별 열 인덱스 찾기
      const dayIndices: { [key: string]: number } = {}
      const headerRow = data[headerRowIndex]
      headerRow.forEach((cell: any, idx: number) => {
        const val = String(cell)
        if (val.includes('월')) dayIndices['mon'] = idx
        if (val.includes('화')) dayIndices['tue'] = idx
        if (val.includes('수')) dayIndices['wed'] = idx
        if (val.includes('목')) dayIndices['thu'] = idx
        if (val.includes('금')) dayIndices['fri'] = idx
      })

      // 3. 데이터 매핑
      const newTimetable: any = { ...timetable }
      let foundData = false

      // 헤더 다음 행부터 7교시까지 읽기
      for (let p = 0; p < 7; p++) {
        const rowData = data[headerRowIndex + 1 + p]
        if (!rowData) break
        
        DAYS.forEach(day => {
          if (dayIndices[day] !== undefined) {
            const cellValue = rowData[dayIndices[day]]
            if (cellValue) {
              newTimetable[day][p] = String(cellValue).trim()
              foundData = true
            }
          } else {
            // 요일 인덱스 못 찾았으면 기본적으로 1,2,3,4,5열로 가정 (0열은 교시)
            const fallbackIdx = DAYS.indexOf(day) + 1
            if (rowData[fallbackIdx]) {
               newTimetable[day][p] = String(rowData[fallbackIdx]).trim()
               foundData = true
            }
          }
        })
      }

      if (foundData) {
        setTimetable(newTimetable)
        alert('엑셀 데이터를 불러왔습니다. 내용을 확인하고 [저장하기]를 눌러주세요.')
      } else {
        alert('엑셀에서 시간표 데이터를 찾지 못했습니다. 형식을 확인해주세요.')
      }
    }
    reader.readAsBinaryString(file)
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
            {/* 엑셀 업로드 버튼 (숨김 input + 라벨) */}
            <label className="cursor-pointer bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded inline-flex items-center">
              <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"></path></svg>
              <span>엑셀 업로드</span>
              <input type='file' className="hidden" accept=".xlsx, .xls" onChange={handleFileUpload} />
            </label>
            <button onClick={() => router.push('/dashboard')} className="text-gray-500 hover:text-gray-700 px-3">
              나가기
            </button>
          </div>
        </div>

        <div className="bg-white shadow rounded-xl overflow-hidden border border-gray-200">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-16">
                    교시
                  </th>
                  {DAY_LABELS.map((day) => (
                    <th key={day} className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                      {day}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {PERIODS.map((period, pIdx) => (
                  <tr key={period}>
                    <td className="px-4 py-3 whitespace-nowrap text-center text-sm font-bold text-gray-700 bg-gray-50">
                      {period}교시
                    </td>
                    {DAYS.map((day) => (
                      <td key={`${day}-${period}`} className="p-1">
                        <input
                          type="text"
                          className="w-full text-center border-none focus:ring-2 focus:ring-blue-500 rounded p-2 text-sm text-gray-900 placeholder-gray-300"
                          placeholder="과목"
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
          
          <div className="bg-gray-50 px-6 py-4 flex justify-between items-center">
            <p className="text-xs text-gray-500">* 엑셀 파일의 "월, 화, 수..." 행을 찾아 자동으로 입력합니다.</p>
            <button
              onClick={handleSave}
              disabled={saving}
              className="inline-flex justify-center py-2 px-6 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
            >
              {saving ? '저장 중...' : '시간표 저장하기'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
