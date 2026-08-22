import React, { useState, useEffect } from 'react'
import { useRouter } from 'next/router'
import { initFirebase } from '../../lib/firebase'
import { getAuth, onAuthStateChanged } from 'firebase/auth'
import {
  doc, getDoc, setDoc, collection, query, where, getDocs, addDoc, serverTimestamp, getFirestore,
} from 'firebase/firestore'
import TeacherLayout from '../../components/Layout'
import { toast } from '../../lib/toast'
import { createSwapRequest } from '../../lib/swaps'
import {
  DAYS_EN, DAYS_KO, PERIODS, enToKo, mondayOf, normalizeItems, deriveTeacherSchedule,
  type DayKo, type DayEn,
} from '../../lib/timetable'

initFirebase()

type Cell = { day: DayEn; dayLabel: DayKo; period: number; periodIdx: number; subject: string }
type TeacherInfo = { id: string; name: string; grade?: number; classNm?: number; classId?: string; mySchedule?: any }

export default function MySchedulePage() {
  const router = useRouter()
  const auth = getAuth()

  const [loading, setLoading] = useState(true)
  const [userData, setUserData] = useState<any>(null)

  const [schedule, setSchedule] = useState<any>({
    mon: ['', '', '', '', '', '', ''],
    tue: ['', '', '', '', '', '', ''],
    wed: ['', '', '', '', '', '', ''],
    thu: ['', '', '', '', '', '', ''],
    fri: ['', '', '', '', '', '', ''],
  })
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)

  // 패널 상태
  const [selectedCell, setSelectedCell] = useState<Cell | null>(null)
  const [mode, setMode] = useState<'menu' | 'substitute' | 'swap'>('menu')
  const [availableTeachers, setAvailableTeachers] = useState<TeacherInfo[]>([])
  const [allTeachers, setAllTeachers] = useState<TeacherInfo[]>([])
  const [swapTarget, setSwapTarget] = useState<TeacherInfo | null>(null)
  const [searching, setSearching] = useState(false)
  const [swapNote, setSwapNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

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
          setUserData(data)
          if (data.mySchedule) setSchedule(data.mySchedule)
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
    setSchedule((prev: any) => ({
      ...prev,
      [day]: prev[day].map((item: string, idx: number) => (idx === periodIndex ? value : item)),
    }))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const db = getFirestore()
      await setDoc(doc(db, 'users', auth.currentUser!.uid), { mySchedule: schedule }, { merge: true })
      toast('내 시간표가 저장되었습니다.')
    } catch (e) {
      console.error(e)
      toast('저장에 실패했습니다.', 'error')
    } finally {
      setSaving(false)
    }
  }

  /** 업로드된 전교 시간표에서 내 이름이 붙은 수업 불러오기 */
  const importFromSchool = async () => {
    const myName = (userData?.displayName || '').trim()
    if (!userData?.schoolCode) return toast('학교 정보가 없습니다. 먼저 반을 등록해 주세요.', 'error')
    if (!myName) return toast('설정에서 이름을 먼저 입력해 주세요. 시간표의 선생님 이름과 같아야 합니다.', 'error')
    setImporting(true)
    try {
      const db = getFirestore()
      const q = query(collection(db, 'classes'), where('schoolCode', '==', userData.schoolCode))
      const snap = await getDocs(q)
      const classes: { classId: string; label: string; items: any[] }[] = []
      snap.forEach((d) => {
        const c = d.data()
        classes.push({
          classId: d.id,
          label: c.grade && c.classNm ? `${c.grade}-${c.classNm}` : d.id,
          items: normalizeItems(c.timetable || []),
        })
      })
      const derived = deriveTeacherSchedule(classes, myName)
      let count = 0
      const next: any = { ...schedule }
      for (const en of DAYS_EN) {
        next[en] = [...(next[en] || ['', '', '', '', '', '', ''])]
        derived[en].forEach((cell, idx) => {
          if (cell) {
            next[en][idx] = `${cell.subject}(${cell.classLabel})`
            count += 1
          }
        })
      }
      if (!count) {
        toast(`전교 시간표에서 '${myName}' 선생님의 수업을 찾지 못했습니다.`, 'info')
      } else {
        setSchedule(next)
        toast(`${count}개 수업을 불러왔습니다. 저장하기를 눌러 확정하세요.`)
      }
    } catch (e) {
      console.error(e)
      toast('불러오기에 실패했습니다.', 'error')
    } finally {
      setImporting(false)
    }
  }

  /* ---------- 교환/보결 ---------- */

  const loadTeachers = async (): Promise<TeacherInfo[]> => {
    const db = getFirestore()
    const q = query(
      collection(db, 'users'),
      where('schoolCode', '==', userData.schoolCode),
      where('role', '==', 'teacher'),
    )
    const snap = await getDocs(q)
    const list: TeacherInfo[] = []
    snap.forEach((d) => {
      if (d.id === auth.currentUser?.uid) return
      const t = d.data()
      list.push({
        id: d.id,
        name: t.displayName || t.email,
        grade: t.grade,
        classNm: t.classNm,
        classId: t.classId,
        mySchedule: t.mySchedule,
      })
    })
    return list
  }

  const findAvailableTeachers = async (cell: Cell) => {
    if (!userData?.schoolCode) return toast('학교 정보가 없습니다.', 'error')
    setSearching(true)
    setAvailableTeachers([])
    try {
      const list = await loadTeachers()
      const free = list.filter((t) => {
        const s = t.mySchedule
        return !s || !s[cell.day] || !String(s[cell.day][cell.periodIdx] || '').trim()
      })
      setAvailableTeachers(free)
      if (!free.length) toast('해당 시간에 비어 있는 선생님이 없습니다.', 'info')
    } catch (e) {
      console.error(e)
      toast('검색에 실패했습니다.', 'error')
    } finally {
      setSearching(false)
    }
  }

  const startSwapMode = async () => {
    setMode('swap')
    setSwapTarget(null)
    setSearching(true)
    try {
      setAllTeachers(await loadTeachers())
    } catch (e) {
      console.error(e)
      toast('선생님 목록을 불러오지 못했습니다.', 'error')
    } finally {
      setSearching(false)
    }
  }

  /** 보결 요청 */
  const requestSubstitute = async (teacher: TeacherInfo) => {
    if (!selectedCell) return
    setSubmitting(true)
    try {
      const db = getFirestore()
      await createSwapRequest(db, {
        schoolCode: userData.schoolCode,
        type: 'substitute',
        fromUid: auth.currentUser!.uid,
        fromName: userData.displayName || auth.currentUser!.email || '선생님',
        fromClassId: userData.classId || null,
        toUid: teacher.id,
        toName: teacher.name,
        toClassId: teacher.classId || null,
        a: { day: selectedCell.dayLabel, period: selectedCell.period, subject: selectedCell.subject },
        note: swapNote || '',
        weekOf: mondayOf(),
      })
      toast(`${teacher.name} 선생님에게 보결 요청을 보냈습니다.`)
      closePanel()
    } catch (e) {
      console.error(e)
      toast('요청 전송에 실패했습니다.', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  /** 맞교환 요청 — 상대의 수업(그들이 수업 중 + 나는 빈 시간) 선택 */
  const requestSwap = async (teacher: TeacherInfo, bDay: DayKo, bPeriod: number, bSubject: string) => {
    if (!selectedCell) return
    setSubmitting(true)
    try {
      const db = getFirestore()
      await createSwapRequest(db, {
        schoolCode: userData.schoolCode,
        type: 'swap',
        fromUid: auth.currentUser!.uid,
        fromName: userData.displayName || auth.currentUser!.email || '선생님',
        fromClassId: userData.classId || null,
        toUid: teacher.id,
        toName: teacher.name,
        toClassId: teacher.classId || null,
        a: { day: selectedCell.dayLabel, period: selectedCell.period, subject: selectedCell.subject },
        b: { day: bDay, period: bPeriod, subject: bSubject },
        note: swapNote || '',
        weekOf: mondayOf(),
      })
      toast(`${teacher.name} 선생님에게 맞교환을 제안했습니다.`)
      closePanel()
    } catch (e) {
      console.error(e)
      toast('요청 전송에 실패했습니다.', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  /** 공개 교환 요청(장터) */
  const submitOpenSwap = async () => {
    if (!selectedCell) return
    setSubmitting(true)
    try {
      const db = getFirestore()
      await addDoc(collection(db, 'school_swaps', userData.schoolCode || 'default', 'requests'), {
        requesterId: auth.currentUser?.uid,
        requesterName: userData.displayName || auth.currentUser?.email,
        requesterClass: userData.grade ? `${userData.grade}학년 ${userData.classNm}반` : '담임 없음',
        day: selectedCell.day,
        dayLabel: selectedCell.dayLabel,
        period: selectedCell.period,
        subject: selectedCell.subject,
        note: swapNote,
        status: 'pending',
        createdAt: serverTimestamp(),
      })
      toast('공개 교환 요청이 등록되었습니다.')
      closePanel()
    } catch (e) {
      console.error(e)
      toast('등록에 실패했습니다.', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const closePanel = () => {
    setSelectedCell(null)
    setMode('menu')
    setSwapTarget(null)
    setAvailableTeachers([])
    setSwapNote('')
  }

  /** 상대 수업 중 내가 빈 시간인 후보 */
  const swapCandidates = (teacher: TeacherInfo) => {
    const out: { day: DayKo; period: number; subject: string }[] = []
    const s = teacher.mySchedule
    if (!s) return out
    for (const en of DAYS_EN) {
      const arr = s[en] || []
      arr.forEach((subj: string, idx: number) => {
        const their = String(subj || '').trim()
        const mine = String(schedule[en]?.[idx] || '').trim()
        const isSelected = en === selectedCell?.day && idx === selectedCell?.periodIdx
        if (their && !mine && !isSelected) out.push({ day: enToKo[en], period: idx + 1, subject: their })
      })
    }
    return out
  }

  if (loading) {
    return (
      <TeacherLayout title="내 시간표">
        <div className="p-10 text-center text-gray-500">로딩 중...</div>
      </TeacherLayout>
    )
  }

  return (
    <TeacherLayout
      title="내 수업 시간표 📅"
      subtitle="수업 칸을 클릭하면 보결·맞교환을 요청할 수 있어요. 수락되면 양쪽 시간표에 자동 반영됩니다."
    >
      <div className="flex justify-end gap-2 mb-4">
        <button
          onClick={importFromSchool}
          disabled={importing}
          className="border border-blue-200 text-blue-700 bg-blue-50 font-bold py-2 px-4 rounded-lg hover:bg-blue-100 transition disabled:opacity-50 text-sm"
        >
          {importing ? '불러오는 중...' : '⬇ 전교 시간표에서 내 수업 불러오기'}
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="bg-blue-600 text-white font-bold py-2 px-6 rounded-lg hover:bg-blue-700 transition disabled:opacity-50 text-sm"
        >
          {saving ? '저장 중...' : '저장하기'}
        </button>
      </div>

      <div className="flex flex-col lg:flex-row gap-6">
        {/* 시간표 */}
        <div className="flex-1 bg-white shadow rounded-xl overflow-hidden border border-gray-200 h-fit">
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
                {PERIODS.map((period, pIdx) => (
                  <tr key={period}>
                    <td className="px-4 py-3 text-center text-sm font-bold text-gray-700 bg-gray-50">{period}교시</td>
                    {DAYS_EN.map((day) => {
                      const isSel = selectedCell?.day === day && selectedCell?.periodIdx === pIdx
                      return (
                        <td
                          key={`${day}-${period}`}
                          className={`p-1 relative transition ${schedule[day][pIdx] ? 'bg-blue-50' : ''} ${isSel ? 'ring-2 ring-blue-500 ring-inset rounded' : ''}`}
                          onClick={() => {
                            if (schedule[day][pIdx]) {
                              setSelectedCell({
                                day: day as DayEn,
                                dayLabel: enToKo[day as DayEn],
                                period,
                                periodIdx: pIdx,
                                subject: schedule[day][pIdx],
                              })
                              setMode('menu')
                              setAvailableTeachers([])
                              setSwapTarget(null)
                            }
                          }}
                        >
                          <input
                            type="text"
                            className="w-full text-center border-none bg-transparent focus:ring-2 focus:ring-blue-500 rounded p-3 text-sm text-gray-900 placeholder-gray-300 cursor-pointer"
                            value={schedule[day][pIdx]}
                            onChange={(e) => handleChange(day, pIdx, e.target.value)}
                          />
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* 교환 패널 */}
        {selectedCell && (
          <div className="w-full lg:w-96 bg-white shadow-xl rounded-xl border border-blue-100 p-6 flex flex-col h-fit animate-fade-in-right">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="text-lg font-bold text-gray-900">
                  {selectedCell.dayLabel}요일 {selectedCell.period}교시
                </h3>
                <p className="text-blue-600 font-bold text-xl">{selectedCell.subject}</p>
              </div>
              <button onClick={closePanel} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>

            <input
              value={swapNote}
              onChange={(e) => setSwapNote(e.target.value)}
              placeholder="메모 (예: 출장으로 부탁드려요)"
              className="mb-4 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-blue-500 focus:border-blue-500"
            />

            {mode === 'menu' && (
              <div className="space-y-2">
                <button
                  onClick={() => { setMode('substitute'); findAvailableTeachers(selectedCell) }}
                  className="w-full bg-indigo-600 text-white font-bold py-2.5 rounded-lg hover:bg-indigo-700 transition"
                >
                  🔍 빈 선생님 찾아 보결 요청
                </button>
                <button
                  onClick={startSwapMode}
                  className="w-full bg-blue-50 text-blue-700 border border-blue-200 font-bold py-2.5 rounded-lg hover:bg-blue-100 transition"
                >
                  🔄 수업 맞교환 제안
                </button>
                <button
                  onClick={submitOpenSwap}
                  disabled={submitting}
                  className="w-full bg-gray-50 text-gray-600 border border-gray-200 font-medium py-2.5 rounded-lg hover:bg-gray-100 transition text-sm disabled:opacity-50"
                >
                  📢 전체 공개로 요청 올리기
                </button>
              </div>
            )}

            {mode === 'substitute' && (
              <div className="flex-1 overflow-y-auto max-h-96">
                <button onClick={() => setMode('menu')} className="text-xs text-gray-400 hover:text-gray-600 mb-2">← 뒤로</button>
                {searching ? (
                  <p className="text-center text-gray-400 text-sm py-6">검색 중...</p>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs font-bold text-gray-500 uppercase">이 시간이 빈 선생님</p>
                    {availableTeachers.map((t) => (
                      <div key={t.id} className="flex justify-between items-center p-3 border rounded-lg hover:bg-gray-50">
                        <div>
                          <div className="font-bold text-gray-800">{t.name}</div>
                          <div className="text-xs text-gray-500">{t.grade ? `${t.grade}학년 ${t.classNm}반 담임` : '담임 없음'}</div>
                        </div>
                        <button
                          onClick={() => requestSubstitute(t)}
                          disabled={submitting}
                          className="text-xs bg-indigo-600 text-white px-3 py-1.5 rounded hover:bg-indigo-700 disabled:opacity-50"
                        >
                          보결 요청
                        </button>
                      </div>
                    ))}
                    {!availableTeachers.length && (
                      <p className="text-center text-gray-400 text-sm py-4">비어 있는 선생님이 없습니다.</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {mode === 'swap' && (
              <div className="flex-1 overflow-y-auto max-h-96">
                <button onClick={() => { setMode('menu'); setSwapTarget(null) }} className="text-xs text-gray-400 hover:text-gray-600 mb-2">← 뒤로</button>
                {searching ? (
                  <p className="text-center text-gray-400 text-sm py-6">불러오는 중...</p>
                ) : !swapTarget ? (
                  <div className="space-y-2">
                    <p className="text-xs font-bold text-gray-500 uppercase">교환할 선생님 선택</p>
                    {allTeachers.map((t) => (
                      <div
                        key={t.id}
                        onClick={() => setSwapTarget(t)}
                        className="p-3 border rounded-lg hover:bg-blue-50 cursor-pointer"
                      >
                        <div className="font-bold text-gray-800">{t.name}</div>
                        <div className="text-xs text-gray-500">{t.grade ? `${t.grade}학년 ${t.classNm}반 담임` : '담임 없음'}</div>
                      </div>
                    ))}
                    {!allTeachers.length && <p className="text-center text-gray-400 text-sm py-4">같은 학교 선생님이 없습니다.</p>}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs font-bold text-gray-500 uppercase">
                      {swapTarget.name} 선생님의 수업 중<br />내가 비어 있는 시간
                    </p>
                    {swapCandidates(swapTarget).map((c) => (
                      <div key={`${c.day}-${c.period}`} className="flex justify-between items-center p-3 border rounded-lg hover:bg-gray-50">
                        <div>
                          <div className="font-bold text-gray-800">{c.day}요일 {c.period}교시</div>
                          <div className="text-xs text-gray-500">{c.subject}</div>
                        </div>
                        <button
                          onClick={() => requestSwap(swapTarget, c.day, c.period, c.subject)}
                          disabled={submitting}
                          className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50"
                        >
                          이 수업과 교환
                        </button>
                      </div>
                    ))}
                    {!swapCandidates(swapTarget).length && (
                      <p className="text-center text-gray-400 text-sm py-4">
                        맞교환 가능한 시간이 없습니다.<br />(상대 수업 중 내가 빈 시간이 없어요)
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </TeacherLayout>
  )
}
