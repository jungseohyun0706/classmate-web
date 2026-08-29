import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { auth, db } from '../../lib/firebase'
import { onAuthStateChanged } from 'firebase/auth'
import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore'
import { useUI } from '../../components/ui/feedback'
import { normalizeName } from '../../lib/timetableConvert'

// 학생 관리 — 우리 반(담임) + 수업 들어가는 반들을 탭으로 관리.
// 수업 반은 업로드된 엑셀 시간표(school_timetables)에서 내 이름으로 자동 제안됩니다.
// 승인/거절/QR은 담임 반에서만 가능(보안 규칙과 일치), 수업 반은 명단 조회용.

type Student = {
  id: string
  name: string
  studentId: number // 출석번호
  status: 'pending' | 'approved' | 'rejected'
}

/** classId(`{school}_{g}_{c}`) → '1학년 3반' */
function classLabel(classId: string): string {
  const parts = classId.split('_')
  if (parts.length < 3) return classId
  return `${parts[parts.length - 2]}학년 ${parts[parts.length - 1]}반`
}

export default function StudentList() {
  const router = useRouter()
  const { toast, confirm } = useUI()
  const [loading, setLoading] = useState(true)
  const [me, setMe] = useState<any>(null)
  const [teaching, setTeaching] = useState<string[]>([])
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [activeId, setActiveId] = useState<string>('')
  const [rosters, setRosters] = useState<Record<string, Student[]>>({})
  const [rosterLoading, setRosterLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  // 직접 추가 입력
  const [addGrade, setAddGrade] = useState('')
  const [addClassNm, setAddClassNm] = useState('')
  const [adding, setAdding] = useState(false)

  const myClassId: string = me?.classId || ''
  const schoolCode: string = me?.schoolCode || ''

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace('/auth/login')
        return
      }
      try {
        const userSnap = await getDoc(doc(db, 'users', user.uid))
        if (!userSnap.exists()) return
        const userData = userSnap.data()

        if (userData.role === 'student') {
          router.replace('/student/today')
          return
        }
        if (!userData.schoolCode) {
          toast('먼저 학교를 등록해 주세요.', 'info')
          router.replace('/teacher/register-class')
          return
        }
        setMe(userData)
        const t: string[] = Array.isArray(userData.teachingClassIds)
          ? userData.teachingClassIds.filter((x: unknown) => typeof x === 'string')
          : []
        setTeaching(t)
        setActiveId(userData.classId || t[0] || '')

        // 엑셀 시간표에서 내 수업 반 자동 제안 (실패해도 무시)
        try {
          const master = await getDoc(doc(db, 'school_timetables', String(userData.schoolCode)))
          if (master.exists()) {
            const teachers = master.data().teachers || {}
            const myName = normalizeName(String(userData.displayName || userData.name || ''))
            const matchKey = Object.keys(teachers).find((k) => normalizeName(k) === myName)
            if (matchKey) {
              const labels = new Set<string>()
              const grid = teachers[matchKey] || {}
              for (const day of Object.values(grid) as any[]) {
                if (!Array.isArray(day)) continue
                for (const slot of day) {
                  const label = slot?.classLabel
                  if (typeof label === 'string' && /^\d{1,2}-\d{1,2}$/.test(label)) labels.add(label)
                }
              }
              const ids = Array.from(labels)
                .map((label) => {
                  const [g, c] = label.split('-')
                  return `${userData.schoolCode}_${parseInt(g, 10)}_${parseInt(c, 10)}`
                })
                .filter((id) => id !== userData.classId && !t.includes(id))
              ids.sort((a, b) => classLabel(a).localeCompare(classLabel(b), 'ko', { numeric: true }))
              setSuggestions(ids)
            }
          }
        } catch (e) {
          console.error('수업 반 제안 로드 실패(무시):', e)
        }
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    })
    return () => unsub()
  }, [router, toast])

  // 활성 탭의 명단 로드 (탭별 캐시)
  useEffect(() => {
    if (!activeId || rosters[activeId]) return
    let cancelled = false
    setRosterLoading(true)
    ;(async () => {
      try {
        const snap = await getDocs(
          query(collection(db, 'users'), where('classId', '==', activeId), where('role', '==', 'student'))
        )
        if (cancelled) return
        const list: Student[] = []
        snap.forEach((d) => {
          const s = { id: d.id, ...d.data() } as Student
          if (s.status !== 'rejected') list.push(s)
        })
        list.sort((a, b) => {
          const an = parseInt(String(a.studentId ?? ''), 10)
          const bn = parseInt(String(b.studentId ?? ''), 10)
          const av = Number.isFinite(an) ? an : 9999
          const bv = Number.isFinite(bn) ? bn : 9999
          if (av !== bv) return av - bv
          return String(a.name || '').localeCompare(String(b.name || ''), 'ko')
        })
        setRosters((prev) => ({ ...prev, [activeId]: list }))
      } catch (e) {
        console.error(e)
        toast('명단을 불러오지 못했어요.', 'error')
      } finally {
        if (!cancelled) setRosterLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  const addTeaching = async (classId: string) => {
    if (!auth.currentUser || teaching.includes(classId)) return
    try {
      await updateDoc(doc(db, 'users', auth.currentUser.uid), {
        teachingClassIds: arrayUnion(classId),
      })
      setTeaching((prev) => [...prev, classId])
      setSuggestions((prev) => prev.filter((id) => id !== classId))
      setActiveId(classId)
      toast(`${classLabel(classId)}을 수업 반에 추가했어요.`, 'success')
    } catch (e) {
      console.error(e)
      toast('추가하지 못했어요. 잠시 후 다시 시도해 주세요.', 'error')
    }
  }

  const removeTeaching = async (classId: string) => {
    if (!auth.currentUser) return
    const ok = await confirm({
      title: `${classLabel(classId)}을 목록에서 뺄까요?`,
      description: '언제든 다시 추가할 수 있어요.',
      confirmText: '빼기',
      cancelText: '취소',
    })
    if (!ok) return
    try {
      await updateDoc(doc(db, 'users', auth.currentUser.uid), {
        teachingClassIds: arrayRemove(classId),
      })
      setTeaching((prev) => prev.filter((id) => id !== classId))
      if (activeId === classId) setActiveId(myClassId || teaching.find((id) => id !== classId) || '')
    } catch (e) {
      console.error(e)
      toast('빼지 못했어요.', 'error')
    }
  }

  const addManual = async () => {
    const g = parseInt(addGrade, 10)
    const c = parseInt(addClassNm, 10)
    if (!Number.isFinite(g) || !Number.isFinite(c) || g < 1 || c < 1) {
      toast('학년과 반 숫자를 입력해 주세요.', 'error')
      return
    }
    const classId = `${schoolCode}_${g}_${c}`
    if (classId === myClassId) {
      toast('우리 반은 이미 있어요.', 'info')
      return
    }
    if (teaching.includes(classId)) {
      toast('이미 추가된 반이에요.', 'info')
      return
    }
    setAdding(true)
    try {
      const cls = await getDoc(doc(db, 'classes', classId))
      if (!cls.exists()) {
        toast('아직 앱에 만들어지지 않은 반이에요. 학년·반을 확인해 주세요.', 'error')
        return
      }
      await addTeaching(classId)
      setAddGrade('')
      setAddClassNm('')
    } catch (e) {
      console.error(e)
      toast('추가하지 못했어요.', 'error')
    } finally {
      setAdding(false)
    }
  }

  // 승인하기: 낙관적 업데이트 후 실패 시 롤백 (활성 탭 반 기준)
  const handleApprove = async (student: Student) => {
    if (busyId || !activeId) return
    const tabId = activeId
    setBusyId(student.id)
    const prev = rosters[tabId] || []
    setRosters((cur) => ({
      ...cur,
      [tabId]: prev.map((s) => (s.id === student.id ? { ...s, status: 'approved' as const } : s)),
    }))
    try {
      await updateDoc(doc(db, 'users', student.id), { status: 'approved' })
      toast('승인했어요', 'success')
      try {
        const title = '우리 반 입장 완료 🎉'
        const body = `${me?.schoolName || ''} ${classLabel(tabId)} 학생이 되었어요!`
        const url = '/student/today'
        await addDoc(collection(db, 'users', student.id, 'notifications'), {
          title,
          body,
          url,
          createdAt: serverTimestamp(),
          read: false,
        })
        void auth.currentUser?.getIdToken().then((t) =>
          fetch('/api/notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
            body: JSON.stringify({ toUid: student.id, title, body, url }),
          }).catch(() => {})
        )
      } catch (notifyErr) {
        console.error(notifyErr)
      }
    } catch (e) {
      console.error(e)
      setRosters((cur) => ({ ...cur, [tabId]: prev }))
      toast('승인에 실패했어요. 다시 시도해주세요.', 'error')
    } finally {
      setBusyId(null)
    }
  }

  const handleReject = async (student: Student) => {
    if (busyId || !activeId) return
    const tabId = activeId
    const ok = await confirm({
      title: '가입 요청을 거절할까요?',
      description: `${student.name} 학생의 가입 요청을 거절해요. 거절하면 대기 목록에서 사라져요.`,
      confirmText: '거절하기',
      cancelText: '취소',
      danger: true,
    })
    if (!ok) return

    setBusyId(student.id)
    const prev = rosters[tabId] || []
    setRosters((cur) => ({ ...cur, [tabId]: prev.filter((s) => s.id !== student.id) }))
    try {
      await updateDoc(doc(db, 'users', student.id), { status: 'rejected' })
      toast('거절했어요', 'success')
    } catch (e) {
      console.error(e)
      setRosters((cur) => ({ ...cur, [tabId]: prev }))
      toast('거절에 실패했어요. 다시 시도해주세요.', 'error')
    } finally {
      setBusyId(null)
    }
  }

  if (loading) return <div className="p-10 text-center">로딩 중...</div>

  const isMyClassActive = !!myClassId && activeId === myClassId
  const students = rosters[activeId] || []
  const pendingStudents = students.filter((s) => s.status === 'pending')
  const approvedStudents = students.filter((s) => s.status === 'approved')
  const tabs: string[] = [...(myClassId ? [myClassId] : []), ...teaching]

  return (
    <div className="min-h-screen bg-gray-50 py-6 sm:py-10 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center mb-5">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900">학생 관리</h1>
            <p className="text-sm text-gray-600">{me?.schoolName}{myClassId ? '' : ' · 담임 반 없음(교과)'}</p>
          </div>
          <div className="flex items-center gap-2">
            {activeId && (
              <button
                onClick={() => router.push(`/teacher/class-qr?classId=${encodeURIComponent(activeId)}`)}
                className="shrink-0 whitespace-nowrap min-h-[44px] px-4 rounded-xl bg-emerald-600 text-white font-bold hover:bg-emerald-700 transition"
              >
                📱 {classLabel(activeId)} 초대 QR
              </button>
            )}
            <button
              onClick={() => router.push('/dashboard')}
              className="shrink-0 whitespace-nowrap min-h-[44px] px-2 text-gray-500 hover:text-gray-700"
            >
              &larr; 대시보드로
            </button>
          </div>
        </div>

        {/* 반 탭 */}
        {tabs.length > 0 && (
          <div className="mb-4 flex gap-1.5 overflow-x-auto pb-1">
            {tabs.map((id) => (
              <button
                key={id}
                onClick={() => setActiveId(id)}
                className={`shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-sm font-bold transition ${
                  activeId === id
                    ? id === myClassId
                      ? 'bg-blue-600 text-white'
                      : 'bg-emerald-600 text-white'
                    : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
                }`}
              >
                {id === myClassId ? `🏠 우리 반 (${classLabel(id)})` : classLabel(id)}
              </button>
            ))}
          </div>
        )}

        {/* 엑셀 시간표 기반 수업 반 제안 */}
        {suggestions.length > 0 && (
          <div className="mb-4 rounded-xl border border-cyan-200 bg-cyan-50 p-4">
            <p className="text-xs font-bold text-cyan-800 mb-2">
              📥 엑셀 시간표에서 찾은 선생님의 수업 반 — 눌러서 추가하세요
            </p>
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((id) => (
                <button
                  key={id}
                  onClick={() => void addTeaching(id)}
                  className="rounded-full bg-white px-3 py-1.5 text-sm font-bold text-cyan-700 ring-1 ring-cyan-300 hover:bg-cyan-100 transition"
                >
                  + {classLabel(id)}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 활성 탭 내용 */}
        {!activeId ? (
          <div className="bg-white shadow rounded-xl p-10 text-center text-gray-500">
            <p className="font-medium">아직 관리하는 반이 없어요.</p>
            <p className="text-sm mt-2 break-keep">
              위의 제안에서 수업 반을 추가하거나, 아래에서 직접 추가해 보세요.
              {suggestions.length === 0 && ' (시간표 엑셀이 업로드되면 수업 반이 자동으로 제안돼요)'}
            </p>
          </div>
        ) : rosterLoading && !rosters[activeId] ? (
          <div className="bg-white shadow rounded-xl p-10 text-center text-gray-400">명단을 불러오는 중...</div>
        ) : (
          <div className="space-y-6">
            {/* 수업 반(담임 아님) 안내 + 빼기 */}
            {!isMyClassActive && (
              <div className="flex items-center justify-between rounded-xl bg-white border border-gray-200 px-4 py-3">
                <p className="text-xs text-gray-500 break-keep">
                  수업 반이에요. QR 초대와 승인을 여기서 할 수 있어요.
                </p>
                <button
                  onClick={() => void removeTeaching(activeId)}
                  className="shrink-0 whitespace-nowrap text-xs text-gray-400 underline hover:text-red-500 min-h-[44px] px-2"
                >
                  이 반 빼기
                </button>
              </div>
            )}

            {/* 승인 대기 */}
            {pendingStudents.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <h2 className="text-lg font-semibold text-gray-900">승인 대기</h2>
                  <span className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-2 rounded-full bg-amber-100 text-amber-700 text-xs font-bold">
                    {pendingStudents.length}
                  </span>
                </div>
                <div className="bg-white shadow rounded-xl overflow-hidden">
                  <ul className="divide-y divide-gray-200">
                    {pendingStudents.map((student) => (
                      <li key={student.id} className="px-4 py-4 sm:px-6">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex items-center min-w-0">
                            <span className="h-9 w-9 shrink-0 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center font-bold text-sm mr-3">
                              {student.studentId}
                            </span>
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-gray-900 truncate">{student.name}</div>
                              <div className="text-xs text-gray-500">승인 대기 중이에요</div>
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleApprove(student)}
                              disabled={busyId === student.id}
                              className="flex-1 sm:flex-none min-h-[44px] px-5 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              승인하기
                            </button>
                            <button
                              onClick={() => handleReject(student)}
                              disabled={busyId === student.id}
                              className="flex-1 sm:flex-none min-h-[44px] px-5 rounded-lg bg-red-50 text-red-600 text-sm font-semibold hover:bg-red-100 transition disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              거절
                            </button>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              </section>
            )}

            {/* 학생 명단 */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <h2 className="text-lg font-semibold text-gray-900">
                  {isMyClassActive ? '우리 반 학생' : `${classLabel(activeId)} 학생`}
                </h2>
                <span className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-2 rounded-full bg-blue-100 text-blue-600 text-xs font-bold">
                  {approvedStudents.length}
                </span>
              </div>
              <div className="bg-white shadow rounded-xl overflow-hidden">
                {approvedStudents.length === 0 ? (
                  <div className="p-10 text-center text-gray-500">
                    <p>아직 등록된 학생이 없어요.</p>
                    <p className="text-sm mt-2">QR 코드를 보여주면 학생들이 스캔해서 바로 가입할 수 있어요.</p>
                    <button
                      onClick={() => router.push(`/teacher/class-qr?classId=${encodeURIComponent(activeId)}`)}
                      className="mt-5 inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-emerald-600 text-white font-bold hover:bg-emerald-700 transition"
                    >
                      📱 {classLabel(activeId)} QR로 학생 초대하기
                    </button>
                  </div>
                ) : (
                  <ul className="divide-y divide-gray-200">
                    {approvedStudents.map((student) => (
                      <li key={student.id} className="px-4 py-4 sm:px-6 flex items-center hover:bg-gray-50">
                        <span className="h-9 w-9 shrink-0 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center font-bold text-sm mr-3">
                          {student.studentId}
                        </span>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-gray-900 truncate">{student.name}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </div>
        )}

        {/* 수업 반 직접 추가 */}
        <div className="mt-6 rounded-xl bg-white border border-gray-200 p-4">
          <p className="text-xs font-bold text-gray-500 mb-2">수업 반 직접 추가</p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              value={addGrade}
              onChange={(e) => setAddGrade(e.target.value)}
              placeholder="학년"
              className="w-20 rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder-gray-300"
            />
            <input
              type="number"
              min={1}
              value={addClassNm}
              onChange={(e) => setAddClassNm(e.target.value)}
              placeholder="반"
              className="w-20 rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder-gray-300"
            />
            <button
              onClick={() => void addManual()}
              disabled={adding}
              className="min-h-[44px] rounded-lg bg-gray-900 px-5 text-sm font-bold text-white hover:bg-gray-800 transition disabled:opacity-50"
            >
              추가
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
