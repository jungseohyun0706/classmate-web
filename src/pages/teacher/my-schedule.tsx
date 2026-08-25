import React, { useState, useEffect } from 'react'
import { useRouter } from 'next/router'
import { auth } from '../../lib/firebase'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc, setDoc, collection, query, where, getDocs, addDoc, serverTimestamp } from 'firebase/firestore'
import { useUI } from '../../components/ui/feedback'

const PERIODS = [1, 2, 3, 4, 5, 6, 7]
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri']
const DAY_LABELS = ['월', '화', '수', '목', '금']

export default function MySchedulePage() {
  const router = useRouter()
  const { toast, confirm } = useUI()

  const [loading, setLoading] = useState(true)
  const [userData, setUserData] = useState<any>(null)
  
  // 선생님 개인 시간표
  const [schedule, setSchedule] = useState<any>({
    mon: ['', '', '', '', '', '', ''],
    tue: ['', '', '', '', '', '', ''],
    wed: ['', '', '', '', '', '', ''],
    thu: ['', '', '', '', '', '', ''],
    fri: ['', '', '', '', '', '', '']
  })
  const [saving, setSaving] = useState(false)

  // 교환 관련 상태
  const [selectedCell, setSelectedCell] = useState<any>(null)
  const [availableTeachers, setAvailableTeachers] = useState<any[]>([])
  const [searching, setSearching] = useState(false)
  const [swapNote, setSwapNote] = useState('') // 공개 요청용 메모
  const [submittingSwap, setSubmittingSwap] = useState(false)

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
          setUserData(data)
          // 개인 시간표 불러오기 (없으면 빈 값)
          if (data.mySchedule) {
            setSchedule(data.mySchedule)
          }
        }
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    })
    return () => unsub()
  }, [router])

  const handleChange = (day: string, periodIndex: number, value: string) => {
    setSchedule((prev: any) => ({
      ...prev,
      [day]: prev[day].map((item: string, idx: number) => idx === periodIndex ? value : item)
    }))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const { db } = await import('../../lib/firebase')
      // users/{uid} 문서에 mySchedule 필드로 저장
      await setDoc(doc(db, 'users', auth.currentUser!.uid), { mySchedule: schedule }, { merge: true })
      toast('내 시간표가 저장되었어요.', 'success')
    } catch (e) {
      console.error(e)
      toast('저장에 실패했어요. 잠시 후 다시 시도해 주세요.', 'error')
    } finally {
      setSaving(false)
    }
  }

  // 빈 선생님 찾기
  const findAvailableTeachers = async (day: string, periodIdx: number) => {
    if (!userData.schoolCode) {
      toast('학교 정보가 없어요.', 'error')
      return
    }
    setSearching(true)
    setAvailableTeachers([])
    
    try {
      const { db } = await import('../../lib/firebase')
      
      // 우리 학교 선생님들 싹 가져오기
      // (실제로는 수백 명일 수 있으니 쿼리 최적화 필요하지만 MVP는 일단 전체 스캔)
      const q = query(
        collection(db, 'users'),
        where('schoolCode', '==', userData.schoolCode),
        where('role', '==', 'teacher')
      )
      const snap = await getDocs(q)
      
      const freeTeachers: any[] = []
      snap.forEach(doc => {
        const t = doc.data()
        // 나 자신은 제외
        if (doc.id === auth.currentUser?.uid) return
        
        // 그 선생님 시간표 확인
        // 시간표가 없거나, 해당 요일/교시가 비어있으면(Empty String) "가능"으로 간주
        const tSchedule = t.mySchedule
        const isFree = !tSchedule || !tSchedule[day] || !tSchedule[day][periodIdx]
        
        if (isFree) {
          freeTeachers.push({
            id: doc.id,
            name: t.displayName || t.email,
            grade: t.grade,
            classNm: t.classNm
          })
        }
      })
      
      setAvailableTeachers(freeTeachers)

    } catch (e) {
      console.error(e)
      toast('검색에 실패했어요. 잠시 후 다시 시도해 주세요.', 'error')
    } finally {
      setSearching(false)
    }
  }

  // 교환 요청 보내기 (MVP: 알림 띄우기)
  const requestSwap = async (teacher: any) => {
    // 실제로는 여기서 'requests' 컬렉션에 문서를 만들고 상대방에게 알림을 쏴야 함.
    // 지금은 UI 흐름만 구현.
    const ok = await confirm({
      title: '교환 요청 보내기',
      description: `${teacher.name} 선생님께 교환 요청을 보낼까요?`,
      confirmText: '보내기',
    })
    if (!ok) return
    try {
        const { db } = await import('../../lib/firebase')
        await addDoc(collection(db, 'school_swaps', userData.schoolCode, 'direct_requests'), {
            fromId: auth.currentUser?.uid,
            fromName: userData.displayName,
            toId: teacher.id,
            toName: teacher.name,
            day: selectedCell.day,
            period: selectedCell.period,
            subject: selectedCell.subject,
            status: 'pending',
            createdAt: serverTimestamp()
        })
        toast(`요청을 보냈어요! ${teacher.name} 선생님이 수락하면 알려드릴게요.`, 'success')
        setSelectedCell(null)
    } catch(e) {
        toast('전송에 실패했어요. 잠시 후 다시 시도해 주세요.', 'error')
    }
  }

  // 전체 공개 교환 요청 등록 (장터 기능 통합)
  const handleSubmitSwap = async () => {
    if (!selectedCell) return
    setSubmittingSwap(true)
    try {
      const { db } = await import('../../lib/firebase')
      
      // school_swaps/{schoolCode}/requests 컬렉션에 저장
      await addDoc(collection(db, 'school_swaps', userData.schoolCode || 'default', 'requests'), {
        requesterId: auth.currentUser?.uid,
        requesterName: userData.displayName,
        requesterClass: userData.grade ? `${userData.grade}학년 ${userData.classNm}반` : '담임 없음',
        
        day: selectedCell.day,
        dayLabel: selectedCell.dayLabel,
        period: selectedCell.period,
        subject: selectedCell.subject,
        note: swapNote,
        
        status: 'pending', 
        createdAt: serverTimestamp()
      })

      toast('교환 요청이 장터에 등록되었어요!', 'success')
      setSelectedCell(null)
      setSwapNote('')
    } catch (e) {
      console.error(e)
      toast('요청 등록에 실패했어요. 잠시 후 다시 시도해 주세요.', 'error')
    } finally {
      setSubmittingSwap(false)
    }
  }

  if (loading) return <div className="p-10 text-center text-black">로딩 중...</div>

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4 sm:px-6 lg:px-8">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">내 수업 시간표 📅</h1>
            <p className="text-sm text-gray-600">본인의 수업 스케줄을 입력하세요.</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => router.push('/dashboard')} className="text-gray-500 hover:text-gray-700 px-3">
              나가기
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="bg-blue-600 text-white font-bold py-2 px-6 rounded hover:bg-blue-700 transition disabled:opacity-50"
            >
              {saving ? '저장 중...' : '저장하기'}
            </button>
          </div>
        </div>

        <div className="flex gap-6">
            {/* 왼쪽: 시간표 */}
            <div className="flex-1 bg-white shadow rounded-xl overflow-hidden border border-gray-200">
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
                        <td 
                            key={`${day}-${period}`} 
                            className={`p-1 relative ${schedule[day][pIdx] ? 'bg-blue-50' : ''}`}
                            onClick={() => {
                                if(schedule[day][pIdx]) {
                                    setSelectedCell({ day, dayLabel: DAY_LABELS[DAYS.indexOf(day)], period: period, periodIdx: pIdx, subject: schedule[day][pIdx] })
                                    setAvailableTeachers([]) // 초기화
                                }
                            }}
                        >
                            <input
                            type="text"
                            className="w-full text-center border-none bg-transparent focus:ring-2 focus:ring-blue-500 rounded p-3 text-sm text-gray-900 placeholder-gray-300 cursor-pointer"
                            placeholder=""
                            value={schedule[day][pIdx]}
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

            {/* 오른쪽: 교환 패널 (선택 시 등장) */}
            {selectedCell && (
                <div className="w-80 bg-white shadow-xl rounded-xl border border-blue-100 p-6 flex flex-col h-fit animate-fade-in-right">
                    <div className="flex justify-between items-start mb-4">
                        <div>
                            <h3 className="text-lg font-bold text-gray-900">{selectedCell.dayLabel}요일 {selectedCell.period}교시</h3>
                            <p className="text-blue-600 font-bold text-xl">{selectedCell.subject}</p>
                        </div>
                        <button onClick={() => setSelectedCell(null)} className="text-gray-400 hover:text-gray-600">✕</button>
                    </div>

                    <div className="mb-4">
                        <p className="text-sm text-gray-600 mb-2">이 수업을 대신할 선생님을 찾나요?</p>
                        <div className="space-y-2">
                            <button 
                                onClick={() => findAvailableTeachers(selectedCell.day, selectedCell.periodIdx)}
                                disabled={searching}
                                className="w-full bg-indigo-100 text-indigo-700 font-bold py-2 rounded hover:bg-indigo-200 transition flex justify-center items-center"
                            >
                                {searching ? <span className="animate-spin mr-2">⏳</span> : '🔍'} 빈 시간 선생님 찾기
                            </button>
                            
                            <div className="relative py-2">
                                <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-gray-200"></span></div>
                                <div className="relative flex justify-center text-xs uppercase"><span className="bg-white px-2 text-gray-400 font-bold">도움말</span></div>
                            </div>
                            <p className="text-xs text-gray-500 text-center leading-relaxed">
                                선택한 시간에 수업이 없는<br/>교내 선생님을 검색합니다.
                            </p>
                        </div>
                    </div>

                    {/* 검색 결과 */}
                    <div className="flex-1 overflow-y-auto max-h-96">
                        {availableTeachers.length > 0 && (
                            <div className="space-y-2">
                                <p className="text-xs font-bold text-gray-500 uppercase">가능한 선생님 목록</p>
                                {availableTeachers.map(t => (
                                    <div key={t.id} className="flex justify-between items-center p-3 border rounded-lg hover:bg-gray-50">
                                        <div>
                                            <div className="font-bold text-gray-800">{t.name}</div>
                                            <div className="text-xs text-gray-500">{t.grade ? `${t.grade}학년 ${t.classNm}반` : '담임 없음'}</div>
                                        </div>
                                        <button 
                                            onClick={() => requestSwap(t)}
                                            className="text-xs bg-indigo-600 text-white px-3 py-1.5 rounded hover:bg-indigo-700"
                                        >
                                            요청
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                        {availableTeachers.length === 0 && !searching && selectedCell && (
                            <p className="text-center text-gray-400 text-sm py-4">
                                (검색 버튼을 눌러보세요)
                            </p>
                        )}
                    </div>
                </div>
            )}
        </div>
      </div>
    </div>
  )
}
