import React, { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/router'
import { auth, db } from '../../lib/firebase'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc, collection, query, where, getDocs, orderBy } from 'firebase/firestore'
import { useUI } from '../../components/ui/feedback'
import { DAY_KEYS, PERIOD_COUNT, normalizeName, normalizeWeeklySchedule, ymdToDayKey, type DayKey, type WeeklySchedule } from '../../lib/timetableConvert'
import type { TeacherTimetable } from '../api/teacher-timetables'

const PERIODS = Array.from({ length: PERIOD_COUNT }, (_, index) => index + 1)
const DAY_LABELS = ['월', '화', '수', '목', '금']
const VIEW_LABELS = { class: '학급별', teacher: '교사별', free: '수업 없는 교사 찾기' } as const
type TimetableView = keyof typeof VIEW_LABELS

type FreeSearch =
  | { status: 'idle' | 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; teachers: TeacherTimetable[] }

function defaultSearchDate() {
  const date = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const day = date.getUTCDay()
  if (day === 0 || day === 6) date.setUTCDate(date.getUTCDate() + (day === 0 ? 1 : 2))
  return date.toISOString().slice(0, 10)
}

async function fetchTeacherTimetables(signal: AbortSignal, query?: URLSearchParams) {
  const token = await auth.currentUser?.getIdToken()
  if (!token) throw new Error('다시 로그인해 주세요.')
  const path = query ? `/api/teacher-timetables?${query}` : '/api/teacher-timetables'
  const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` }, signal })
  if (!response.ok) throw new Error(`교사 시간표 조회 실패 (${response.status})`)
  const data: { teachers: TeacherTimetable[] } = await response.json()
  return data.teachers
}

interface SchoolClass {
  id: string
  grade: number | string
  classNm: number | string
  teacherName?: string
}

export default function ViewTimetables() {
  const router = useRouter()
  const { toast } = useUI()
  const [loading, setLoading] = useState(true)
  const [profile, setProfile] = useState<{ schoolCode: string; schoolName: string } | null>(null)
  const [mode, setMode] = useState<TimetableView>('class')
  const [classes, setClasses] = useState<SchoolClass[] | null>(null)
  const [classesError, setClassesError] = useState(false)
  const [selectedClass, setSelectedClass] = useState<SchoolClass | null>(null)
  const [classTimetable, setClassTimetable] = useState<WeeklySchedule | null>(null)
  const [classStatus, setClassStatus] = useState<'loading' | 'ready' | 'error'>('ready')
  const [gradeFilter, setGradeFilter] = useState<number | 'all'>('all')
  const [teachers, setTeachers] = useState<TeacherTimetable[] | null>(null)
  const [teacherError, setTeacherError] = useState(false)
  const [teacherQuery, setTeacherQuery] = useState('')
  const [selectedTeacher, setSelectedTeacher] = useState<TeacherTimetable | null>(null)
  const [freeDate, setFreeDate] = useState(defaultSearchDate)
  const [freePeriod, setFreePeriod] = useState(1)
  const [freeSearch, setFreeSearch] = useState<FreeSearch>({ status: 'idle' })
  const freeRequest = useRef<AbortController | null>(null)
  // 반을 빠르게 바꿀 때 늦게 도착한 이전 반 응답이 화면을 덮어쓰지 않도록 마지막으로 고른 반을 기억
  const classRequest = useRef(0)

  useEffect(() => {
    let cancelled = false
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (cancelled) return
      setProfile(null)
      setClasses(null)
      setTeachers(null)
      setTeacherError(false)
      setSelectedTeacher(null)
      setSelectedClass(null)
      freeRequest.current?.abort()
      setFreeSearch({ status: 'idle' })
      classRequest.current += 1
      if (!u) {
        router.replace('/auth/login')
        return
      }
      try {
        const userSnap = await getDoc(doc(db, 'users', u.uid))
        if (cancelled || auth.currentUser?.uid !== u.uid) return
        if (!userSnap.exists()) {
          router.replace('/dashboard')
          return
        }
        const userData = userSnap.data()

        if (userData.role !== 'teacher') {
          router.replace(userData.role === 'student' ? '/student/today' : '/dashboard')
          return
        }
        if (!userData.schoolCode) {
          toast('학교 정보가 없어요.', 'error')
          router.replace('/dashboard')
          return
        }
        setProfile({ schoolCode: userData.schoolCode, schoolName: userData.schoolName || '우리 학교' })
      } catch (e) {
        console.error(e)
        if (!cancelled && auth.currentUser?.uid === u.uid) {
          toast('학교 정보를 불러오지 못했어요.', 'error')
          router.replace('/dashboard')
        }
      } finally {
        if (!cancelled && auth.currentUser?.uid === u.uid) setLoading(false)
      }
    })
    return () => {
      cancelled = true
      unsub()
      freeRequest.current?.abort()
    }
  }, [router, toast])

  useEffect(() => {
    if (!profile) return
    let cancelled = false
    setClasses(null)
    setClassesError(false)
    const q = query(
      collection(db, 'classes'),
      where('schoolCode', '==', profile.schoolCode),
      orderBy('grade', 'asc'),
      orderBy('classNm', 'asc')
    )
    void getDocs(q).then((snapshot) => {
      if (cancelled) return
      const list: SchoolClass[] = []
      snapshot.forEach((classDoc) => {
        const { isGroup, grade, classNm, teacherName } = classDoc.data()
        if (isGroup !== true) list.push({ id: classDoc.id, grade, classNm, teacherName })
      })
      setClasses(list)
    }).catch((error) => {
      console.error(error)
      if (!cancelled) setClassesError(true)
    })
    return () => { cancelled = true }
  }, [profile])

  useEffect(() => {
    if (!profile || mode !== 'teacher' || teachers || teacherError) return
    const controller = new AbortController()
    async function loadTeachers() {
      try {
        const data = await fetchTeacherTimetables(controller.signal)
        if (!controller.signal.aborted) setTeachers(data)
      } catch (error) {
        if (controller.signal.aborted) return
        console.error(error)
        setTeacherError(true)
      }
    }
    void loadTeachers()
    return () => controller.abort()
  }, [profile, mode, teachers, teacherError])

  const loadTimetable = async (classId: string) => {
    const request = ++classRequest.current
    setClassStatus('loading')
    try {
      // 1. 원본: classes/{classId}/info/timetable (학급 시간표 관리·엑셀 업로드가 저장하고 학생 화면도 읽는 곳)
      const snap = await getDoc(doc(db, 'classes', classId, 'info', 'timetable'))
      if (classRequest.current !== request) return
      if (snap.exists()) {
        setClassTimetable(normalizeWeeklySchedule(snap.data()))
        setClassStatus('ready')
        return
      }

      // 2. 구형 방식: classes/{classId} 문서의 timetable 필드 (모바일 앱 시절 데이터, 원본이 없을 때만)
      const classSnap = await getDoc(doc(db, 'classes', classId))
      if (classRequest.current !== request) return
      const rawItems = classSnap.exists() ? classSnap.data().timetable : null
      if (Array.isArray(rawItems) && rawItems.length > 0) {
        // TimetableItem[] 형식을 요일별 객체로 변환
        const formatted = normalizeWeeklySchedule(null)
        const dayMap: Record<string, DayKey> = { 월: 'mon', 화: 'tue', 수: 'wed', 목: 'thu', 금: 'fri' }
        
        rawItems.forEach((item: { day?: string; id?: string; subject?: unknown } | null) => {
          const dayKey = item?.day ? dayMap[item.day] : undefined
          if (dayKey) {
            // 교시 인덱스 계산 (start 시간을 기준으로 하거나 id에서 추출)
            const period = parseInt(typeof item?.id === 'string' ? item.id.split('-').pop() || '1' : '1') - 1
            if (period >= 0 && period < PERIOD_COUNT && typeof item?.subject === 'string') {
              formatted[dayKey][period] = item.subject
            }
          }
        })
        setClassTimetable(formatted)
      } else {
        setClassTimetable(null)
      }
      setClassStatus('ready')
    } catch (e) {
      console.error(e)
      if (classRequest.current === request) setClassStatus('error')
    }
  }

  const scrollToTimetable = () => {
    // 모바일: 목록이 숨고 시간표가 나타나므로 화면 맨 위로
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  const clearSelection = () => {
    classRequest.current += 1
    setSelectedClass(null)
    setSelectedTeacher(null)
  }

  const resetFreeSearch = () => {
    freeRequest.current?.abort()
    setFreeSearch({ status: 'idle' })
    setSelectedTeacher(null)
  }

  const searchFreeTeachers = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    resetFreeSearch()
    const date = freeDate.replace(/-/g, '')
    if (!ymdToDayKey(date)) {
      setFreeSearch({ status: 'error', message: '월요일부터 금요일 사이 날짜를 선택해 주세요.' })
      return
    }
    const controller = new AbortController()
    freeRequest.current = controller
    setFreeSearch({ status: 'loading' })
    try {
      const query = new URLSearchParams({ date, period: String(freePeriod) })
      const results = await fetchTeacherTimetables(controller.signal, query)
      if (!controller.signal.aborted) setFreeSearch({ status: 'ready', teachers: results })
    } catch (error) {
      if (controller.signal.aborted) return
      console.error(error)
      setFreeSearch({ status: 'error', message: '검색에 실패했어요. 다시 시도해 주세요.' })
    }
  }

  if (loading) return <div className="p-10 text-center">로딩 중...</div>
  if (!profile) return null

  const classList = classes ?? []
  const grades = Array.from(new Set(classList.map((c) => Number(c.grade)).filter(Number.isFinite))).sort(
    (a, b) => a - b
  )
  const filtered = gradeFilter === 'all' ? classList : classList.filter((c) => Number(c.grade) === gradeFilter)
  const teacherSearch = normalizeName(teacherQuery).toLowerCase()
  const filteredTeachers = (teachers ?? []).filter((teacher) => normalizeName(teacher.name).toLowerCase().includes(teacherSearch))
  const byAvailability = mode === 'free'
  const byTeacher = mode !== 'class'
  const teacherResults = byAvailability
    ? freeSearch.status === 'ready' ? freeSearch.teachers : []
    : filteredTeachers
  const selected = byTeacher ? selectedTeacher : selectedClass
  const timetable = byTeacher ? selectedTeacher?.schedule : classTimetable
  const heading = byTeacher
    ? `${selectedTeacher?.name} 선생님 시간표`
    : `${selectedClass?.grade}학년 ${selectedClass?.classNm}반 시간표`
  const selectedDetail = byTeacher
    ? (selectedTeacher?.homeroom ?? (selectedTeacher?.excelOnly ? '학교 엑셀' : undefined))
    : selectedClass?.teacherName

  return (
    <div className="min-h-screen bg-gray-50 py-5 sm:py-10 px-4 sm:px-6 lg:px-8">
      <div className="max-w-6xl mx-auto">
        
        {/* Header */}
        <div className="flex justify-between items-center mb-5 sm:mb-8">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{profile.schoolName} 전체 시간표 🏫</h1>
          </div>
          <button onClick={() => router.push('/dashboard')} className="shrink-0 whitespace-nowrap text-gray-500 hover:text-gray-700 font-medium px-3">
            나가기
          </button>
        </div>

        <div className="mb-5 inline-flex flex-wrap gap-1 rounded-xl bg-gray-100 p-1" role="group" aria-label="시간표 조회 유형">
          {(['class', 'teacher', 'free'] as const).map((view) => (
            <button
              key={view}
              type="button"
              aria-pressed={mode === view}
              onClick={() => {
                if (mode === view) return
                clearSelection()
                if (mode === 'free') resetFreeSearch()
                setMode(view)
              }}
              className={`min-h-11 rounded-lg px-2.5 text-sm font-semibold sm:px-4 ${mode === view ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-600 hover:bg-white/70'}`}
            >
              {VIEW_LABELS[view]}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">

          {/* 모바일에서는 목록과 시간표를 한 화면에 하나씩 표시합니다. */}
          <div className={`bg-white shadow rounded-xl overflow-hidden border border-gray-200 h-fit ${selected ? 'hidden md:block' : ''}`}>
            <div className="p-4 bg-gray-50 border-b border-gray-200 font-bold text-gray-700">
              {byAvailability ? '수업 없는 교사' : byTeacher ? '교사 목록' : '학급 목록'}
            </div>
            {byAvailability ? (
              <form onSubmit={searchFreeTeachers} className="space-y-3 border-b border-gray-100 p-3">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                  <label className="min-w-0 space-y-1 text-sm font-medium text-gray-700">
                    <span>날짜</span>
                    <input
                      type="date"
                      required
                      value={freeDate}
                      onChange={(event) => {
                        setFreeDate(event.target.value)
                        resetFreeSearch()
                      }}
                      className="block min-h-11 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-2 text-base text-gray-900"
                    />
                  </label>
                  <label className="space-y-1 text-sm font-medium text-gray-700">
                    <span>교시</span>
                    <select
                      value={freePeriod}
                      onChange={(event) => {
                        setFreePeriod(Number(event.target.value))
                        resetFreeSearch()
                      }}
                      className="block min-h-11 w-full rounded-lg border border-gray-300 bg-white px-2 text-base text-gray-900"
                    >
                      {PERIODS.map((period) => <option key={period} value={period}>{period}교시</option>)}
                    </select>
                  </label>
                </div>
                <button
                  type="submit"
                  disabled={freeSearch.status === 'loading'}
                  className="min-h-11 w-full rounded-lg bg-blue-600 px-4 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-60"
                >
                  {freeSearch.status === 'loading' ? '찾는 중…' : '찾기'}
                </button>
              </form>
            ) : byTeacher ? (
              <div className="border-b border-gray-100 p-3">
                <input
                  type="search"
                  aria-label="선생님 이름"
                  placeholder="선생님 이름 검색"
                  value={teacherQuery}
                  onChange={(event) => setTeacherQuery(event.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 placeholder:text-gray-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
                />
              </div>
            ) : grades.length > 1 && (
              <div className="flex gap-1.5 p-3 border-b border-gray-100 overflow-x-auto">
                <button
                  onClick={() => setGradeFilter('all')}
                  className={`whitespace-nowrap px-3 py-1.5 rounded-full text-sm font-bold transition ${
                    gradeFilter === 'all' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  전체
                </button>
                {grades.map((g) => (
                  <button
                    key={g}
                    onClick={() => setGradeFilter(g)}
                    className={`whitespace-nowrap px-3 py-1.5 rounded-full text-sm font-bold transition ${
                      gradeFilter === g ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {g}학년
                  </button>
                ))}
              </div>
            )}
            <div className="divide-y divide-gray-100 max-h-[70vh] md:max-h-[600px] overflow-y-auto">
              {byTeacher ? (
                byAvailability && freeSearch.status === 'idle' ? (
                  <p className="p-6 text-center text-sm text-gray-500">날짜와 교시를 선택해 검색하세요.</p>
                ) : byAvailability && freeSearch.status === 'loading' ? (
                  <p role="status" className="p-6 text-center text-sm text-gray-500">수업 없는 선생님을 찾는 중이에요.</p>
                ) : byAvailability && freeSearch.status === 'error' ? (
                  <p role="alert" className="p-6 text-center text-sm text-red-700">{freeSearch.message}</p>
                ) : !byAvailability && teacherError ? (
                  <div className="p-5 text-center text-sm text-gray-600">
                    <p>교사 시간표를 불러오지 못했어요.</p>
                    <button onClick={() => setTeacherError(false)} className="mt-2 min-h-10 font-semibold text-blue-700">
                      다시 시도
                    </button>
                  </div>
                ) : !byAvailability && !teachers ? (
                  <p role="status" className="p-6 text-center text-sm text-gray-500">교사 목록을 불러오는 중이에요.</p>
                ) : teacherResults.length === 0 ? (
                  <p role="status" className="p-6 text-center text-sm text-gray-500">
                    {byAvailability
                      ? '해당 교시에 수업이 비어 있는 선생님을 찾지 못했어요.'
                      : teacherSearch ? '검색한 이름과 일치하는 선생님이 없어요.' : '조회할 수 있는 선생님이 없어요.'}
                  </p>
                ) : teacherResults.map((teacher) => (
                  <button
                    key={teacher.id}
                    type="button"
                    aria-pressed={selectedTeacher?.id === teacher.id}
                    onClick={() => {
                      setSelectedTeacher(teacher)
                      scrollToTimetable()
                    }}
                    className={`flex min-h-12 w-full items-center justify-between gap-2 px-4 py-3 text-left hover:bg-blue-50 ${selectedTeacher?.id === teacher.id ? 'bg-blue-100' : ''}`}
                  >
                    <span className="font-medium text-gray-900">{teacher.name} 선생님</span>
                    <span className="shrink-0 text-xs text-gray-500">
                      {teacher.homeroom ?? (teacher.excelOnly ? '학교 엑셀' : !teacher.schedule ? '시간표 미등록' : '')}
                    </span>
                  </button>
                ))
              ) : classesError ? (
                <p className="p-6 text-center text-sm text-gray-500">학급 목록을 불러오지 못했어요.</p>
              ) : !classes ? (
                <p role="status" className="p-6 text-center text-sm text-gray-500">학급 목록을 불러오는 중이에요.</p>
              ) : filtered.length === 0 ? (
                <div className="p-6 text-center text-gray-400 text-sm">등록된 반이 없습니다.</div>
              ) : filtered.map((cls) => (
                <button
                  key={cls.id}
                  type="button"
                  aria-pressed={selectedClass?.id === cls.id}
                  onClick={() => {
                    setSelectedClass(cls)
                    setClassTimetable(null)
                    void loadTimetable(cls.id)
                    scrollToTimetable()
                  }}
                  className={`w-full px-4 py-3.5 hover:bg-blue-50 active:bg-blue-100 transition flex justify-between items-center ${selectedClass?.id === cls.id ? 'bg-blue-100' : ''}`}
                >
                  <span className="font-medium text-gray-900">{cls.grade}학년 {cls.classNm}반</span>
                  {cls.teacherName && <span className="text-xs text-gray-500">{cls.teacherName} T</span>}
                </button>
              ))}
            </div>
          </div>

          {/* 시간표 뷰어 */}
          <div className={`md:col-span-2 ${!selected ? 'hidden md:block' : ''}`}>
            {selected ? (
              <div className="bg-white shadow rounded-xl overflow-hidden border border-gray-200 animate-fade-in">
                {/* 모바일 전용: 목록으로 돌아가기 */}
                <button
                  onClick={clearSelection}
                  className="md:hidden w-full flex items-center gap-2 px-4 py-3 text-sm font-bold text-blue-600 bg-blue-50 border-b border-blue-100"
                >
                  {byTeacher ? '← 교사 목록' : '← 다른 반 보기'}
                </button>
                <div className="p-4 bg-blue-600 text-white font-bold flex justify-between items-center gap-2">
                  <h2 className="min-w-0 break-keep">{heading}</h2>
                  {selectedDetail && (
                    <span className="text-xs font-normal bg-blue-700 px-2 py-1 rounded whitespace-nowrap">{selectedDetail}</span>
                  )}
                </div>
                
                {!byTeacher && classStatus === 'loading' ? (
                  <p role="status" className="p-10 text-center text-sm text-gray-500">시간표를 불러오는 중이에요.</p>
                ) : !byTeacher && classStatus === 'error' ? (
                  <p className="p-10 text-center text-sm text-gray-600">시간표를 불러오지 못했어요.</p>
                ) : timetable ? (
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-1.5 sm:px-4 py-3 w-10 sm:w-16 text-center text-xs font-medium text-gray-500 uppercase">교시</th>
                          {DAY_LABELS.map((day) => (
                            <th key={day} className="px-1.5 sm:px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">{day}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {PERIODS.map((period, pIdx) => (
                          <tr key={period}>
                            <td className="px-1.5 sm:px-4 py-3 text-center text-xs sm:text-sm font-bold text-gray-700 bg-gray-50 whitespace-nowrap">{period}</td>
                            {DAY_KEYS.map((day) => (
                              <td key={`${day}-${period}`} className="px-1 sm:p-3 py-3 text-center text-xs sm:text-sm text-gray-900 border-l border-gray-100 break-keep">
                                {timetable[day]?.[pIdx] || '-'}
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
                <p>{byTeacher ? '목록에서 선생님을 선택하세요.' : '목록에서 반을 선택하세요.'}</p>
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  )
}
