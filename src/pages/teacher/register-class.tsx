import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { onAuthStateChanged } from 'firebase/auth'
import { auth, db } from '../../lib/firebase'
import { doc, getDoc, setDoc, serverTimestamp, writeBatch } from 'firebase/firestore'
import { useUI } from '../../components/ui/feedback'
import { storedClassGridToInfoTimetable } from '../../lib/timetableConvert'

type School = {
  code: string
  officeCode: string
  name: string
  address: string
  kind: string
}

export default function RegisterClass() {
  const router = useRouter()
  const { toast } = useUI()

  // Steps: 0 = Search School, 1 = Input Class Info
  const [step, setStep] = useState(0)
  
  // Search State
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<School[]>([])
  const [searching, setSearching] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)
  const [selectedSchool, setSelectedSchool] = useState<School | null>(null)

  // Class Info State
  const [grade, setGrade] = useState('')
  const [classNm, setClassNm] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // 이미 담임인 반 (반 변경 모드 안내용)
  const [currentClassLabel, setCurrentClassLabel] = useState('')

  // 학교(schoolCode)는 한 번 정해지면 바꿀 수 없음(보안 규칙). 다른 학교를 고르면 쓰기 전에 막고 안내
  const schoolLocked = (me: any, school: School) => {
    if (!me?.schoolCode || String(me.schoolCode) === school.code) return false
    toast(
      `학교는 바꿀 수 없어요. ${me.schoolName || '이미 등록된 학교'}의 반만 등록할 수 있어요. (학교를 옮기셨다면 관리자에게 문의해 주세요)`,
      'error'
    )
    return true
  }

  // 담임이 아닌(교과 전담 등) 선생님: 반 없이 학교 소속만 등록
  const handleSchoolOnly = async () => {
    if (!selectedSchool) return
    if (!auth.currentUser) {
      toast('로그인이 필요해요', 'error')
      router.replace('/auth/login')
      return
    }
    setSubmitting(true)
    try {
      const user = auth.currentUser
      const meSnap = await getDoc(doc(db, 'users', user.uid))
      if (meSnap.exists() && meSnap.data().role === 'student') {
        toast('학생 계정으로는 등록할 수 없어요.', 'error')
        router.replace('/student/today')
        return
      }
      if (schoolLocked(meSnap.exists() ? meSnap.data() : null, selectedSchool)) return
      await setDoc(
        doc(db, 'users', user.uid),
        {
          schoolCode: selectedSchool.code,
          officeCode: selectedSchool.officeCode,
          schoolName: selectedSchool.name,
          role: 'teacher',
        },
        { merge: true }
      )
      toast('학교 등록 완료! 시간표·교환·SOS를 바로 쓸 수 있어요.', 'success')
      router.replace('/dashboard')
    } catch (e: any) {
      console.error(e)
      toast('등록에 실패했어요. 잠시 후 다시 시도해 주세요.', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) return
      try {
        const snap = await getDoc(doc(db, 'users', u.uid))
        if (!snap.exists()) return
        const d = snap.data()
        if (d.role === 'student') {
          router.replace('/student/today')
          return
        }
        if (d.classId && d.schoolName) {
          setCurrentClassLabel(`${d.schoolName} ${d.grade}학년 ${d.classNm}반`)
        }
        // 이미 학교를 등록한 선생님(학교만 등록 → 담임 반 추가 등)은 학교를 바꿀 수 없으니 바로 학년·반 입력으로
        if (d.schoolCode && d.schoolName && d.officeCode) {
          setSelectedSchool(
            (cur) =>
              cur ?? {
                code: String(d.schoolCode),
                officeCode: String(d.officeCode),
                name: String(d.schoolName),
                address: '',
                kind: '',
              }
          )
          setStep(1)
        }
      } catch (e) {
        console.error(e)
      }
    })
    return () => unsub()
  }, [router])

  // 1. 학교 검색 함수
  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!query.trim()) return
    setSearching(true)
    setResults([])
    setSearchFailed(false)
    
    try {
      // API 파라미터를 query -> q로 수정하여 schools.ts와 맞춤
      const res = await fetch(`/api/schools?q=${encodeURIComponent(query)}`)
      // NEIS 장애는 오류 상태로 오므로 '검색 결과 없음'과 구분해서 알림
      if (!res.ok) {
        setSearchFailed(true)
        toast('학교 검색에 실패했어요. 잠시 후 다시 시도해 주세요.', 'error')
        return
      }
      const data = await res.json()
      if (Array.isArray(data)) {
        setResults(data)
      } else if (data.schools) {
        setResults(data.schools)
      }
    } catch (err) {
      setSearchFailed(true)
      toast('학교 검색에 실패했어요. 잠시 후 다시 시도해 주세요.', 'error')
    } finally {
      setSearching(false)
    }
  }

  // 2. 반 등록 함수
  const handleCreate = async () => {
    if (!selectedSchool || !grade || !classNm) return
    if (!auth.currentUser) {
      toast('로그인이 필요해요', 'error')
      router.replace('/auth/login')
      return
    }

    setSubmitting(true)
    try {
      const user = auth.currentUser

      // 학생 계정은 반을 만들 수 없음
      const meSnap = await getDoc(doc(db, 'users', user.uid))
      if (meSnap.exists() && meSnap.data().role === 'student') {
        toast('학생 계정으로는 반을 만들 수 없어요.', 'error')
        router.replace('/student/today')
        return
      }
      // 아래 쓰기가 권한 오류로 막히는 원인을 미리 걸러, 실패 문구가 실제 원인과 맞게 함
      if (!meSnap.exists() || meSnap.data().role !== 'teacher') {
        toast('가입이 아직 끝나지 않은 계정이에요. 다시 로그인해 교사 인증 코드를 입력해 주세요.', 'error')
        return
      }
      const me = meSnap.data()
      if (schoolLocked(me, selectedSchool)) return
      const prevClassId = String(me.classId || '')

      // 고유 반 ID 생성 (학교코드_학년_반)
      // 이렇게 하면 중복 생성을 방지하거나 쉽게 찾을 수 있음
      // 숫자로 정규화해 "03" 같은 입력이 다른 ID를 만들지 않게 함
      const gradeNum = parseInt(grade, 10)
      const classNum = parseInt(classNm, 10)
      const classId = `${selectedSchool.code}_${gradeNum}_${classNum}`

      // 1~2.5를 한 batch로: 어느 하나라도 규칙에 막히면 전부 취소되어,
      // 반 문서만 내 것으로 점유된 채 남는 일이 없게 함
      const batch = writeBatch(db)

      // 1. Classes 컬렉션에 반 정보 저장
      // setDoc을 쓰면 이미 있으면 덮어쓰기(업데이트) 됨
      batch.set(doc(db, 'classes', classId), {
        classId: classId,
        schoolCode: selectedSchool.code,
        officeCode: selectedSchool.officeCode,
        schoolName: selectedSchool.name,
        grade: gradeNum,
        classNm: classNum,
        teacherId: user.uid,
        // Auth displayName은 이메일 가입이면 비어 있음 → users 문서의 이름을 먼저
        teacherName: me.displayName || me.name || me.masterName || user.displayName || '담임 선생님',
        createdAt: serverTimestamp()
      }, { merge: true })

      // 2. 선생님 계정(Users)에 내 반 정보 연결
      batch.set(doc(db, 'users', user.uid), {
        classId: classId,
        schoolCode: selectedSchool.code,
        officeCode: selectedSchool.officeCode,
        schoolName: selectedSchool.name,
        grade: gradeNum,
        classNm: classNum,
        role: 'teacher'
      }, { merge: true })

      // 2.5. 반을 바꾼 경우: 이전 반의 담임 자리를 비워 다른 선생님이 맡을 수 있게 함
      // (이전 반이 아직 내 담임 반일 때만 — 아니면 해제 쓰기가 거부되어 batch 전체가 실패함)
      if (prevClassId && prevClassId !== classId) {
        try {
          const prevSnap = await getDoc(doc(db, 'classes', prevClassId))
          if (prevSnap.exists() && prevSnap.data().teacherId === user.uid) {
            batch.set(
              doc(db, 'classes', prevClassId),
              { teacherId: null, teacherName: '담임 미정' },
              { merge: true }
            )
          }
        } catch (releaseErr) {
          console.error('이전 반 확인 실패(해제 생략):', releaseErr)
        }
      }

      await batch.commit()

      // 3. 학교 시간표 엑셀(마스터)이 이미 업로드돼 있으면 우리 반 시간표를 자동으로 채움
      try {
        const masterSnap = await getDoc(doc(db, 'school_timetables', selectedSchool.code))
        const classGrid = masterSnap.exists()
          ? (masterSnap.data().classes || {})[`${gradeNum}-${classNum}`]
          : null
        if (classGrid) {
          await setDoc(
            doc(db, 'classes', classId, 'info', 'timetable'),
            storedClassGridToInfoTimetable(classGrid)
          )
          toast('업로드된 학교 시간표에서 우리 반 시간표를 자동으로 채웠어요!', 'success')
        }
      } catch (autoFillError) {
        // 자동 채움은 부가 기능 — 실패해도 반 등록 자체는 성공으로 처리
        console.error('학교 시간표 자동 채움 실패:', autoFillError)
      }

      toast('반 등록이 완료됐어요', 'success')
      router.replace('/dashboard')

    } catch (e: any) {
      console.error(e)
      // 계정·학교 문제는 위에서 걸렀으니, 남은 권한 오류는 반 문서의 담임이 다른 선생님인 경우
      if (String(e?.code || e?.message || '').includes('permission')) {
        toast('이미 다른 선생님이 담임으로 등록된 반이에요. 학년·반을 다시 확인해 주세요.', 'error')
      } else {
        toast('등록에 실패했어요: ' + (e.message || e.code || '알 수 없는 오류'), 'error')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4 sm:px-6 lg:px-8 flex justify-center">
      <div className="max-w-xl w-full space-y-8">
        
        {/* Header */}
        <div className="text-center">
          <h2 className="text-3xl font-extrabold text-gray-900">
            {currentClassLabel ? '반 바꾸기' : '우리 반 등록하기'}
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            {step === 0 ? '먼저 학교를 검색해서 선택해주세요.' : '학년과 반을 입력해주세요.'}
          </p>
        </div>

        {currentClassLabel && (
          <div className="rounded-xl bg-blue-50 border border-blue-100 p-4 text-sm text-blue-800 break-keep">
            현재 담임: <b>{currentClassLabel}</b>
            <br />
            새로 등록하면 이전 반 담임에서는 해제돼요. 이전 반 학생들은 새 반 QR로 다시
            들어와야 해요.
          </div>
        )}

        <div className="bg-white py-8 px-6 shadow-xl rounded-2xl border border-gray-100">
          
          {/* STEP 0: 학교 검색 */}
          {step === 0 && (
            <div className="space-y-6">
              <form onSubmit={handleSearch} className="flex gap-2">
                <input
                  type="text"
                  className="flex-1 appearance-none block w-full px-4 py-3 border border-gray-300 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-lg"
                  placeholder="예: 서울고등학교"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <button
                  type="submit"
                  disabled={searching}
                  className="bg-blue-600 text-white px-6 py-3 rounded-lg font-bold hover:bg-blue-700 transition disabled:opacity-50"
                >
                  검색
                </button>
              </form>

              {/* 검색 결과 리스트 */}
              <div className="mt-4 space-y-2 sm:max-h-96 sm:overflow-y-auto">
                {results.map((school) => (
                  <div 
                    key={school.code}
                    onClick={() => {
                      setSelectedSchool(school)
                      setStep(1) // 다음 단계로
                    }}
                    className="p-4 border rounded-lg hover:bg-blue-50 cursor-pointer transition group"
                  >
                    <div className="font-bold text-lg text-gray-800 group-hover:text-blue-700">
                      {school.name}
                    </div>
                    <div className="text-sm text-gray-500">
                      {school.address}
                    </div>
                  </div>
                ))}
                {results.length === 0 && query && !searching && (
                  <div className="text-center text-gray-500 py-4">
                    {searchFailed ? '학교 검색에 실패했어요. 잠시 후 다시 시도해 주세요.' : '검색 결과가 없습니다.'}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* STEP 1: 학년/반 입력 */}
          {step === 1 && selectedSchool && (
            <div className="space-y-6">
              <div className="bg-blue-50 p-4 rounded-lg border border-blue-100 mb-6">
                <span className="text-xs font-bold text-blue-600 uppercase tracking-wide">선택된 학교</span>
                <div className="text-xl font-bold text-blue-900 mt-1">{selectedSchool.name}</div>
                <div className="text-sm text-blue-700">{selectedSchool.address}</div>
                <button 
                  onClick={() => setStep(0)}
                  className="mt-1 inline-flex items-center min-h-[44px] px-3 -mx-3 text-sm text-gray-500 underline hover:text-gray-700"
                >
                  다시 검색하기
                </button>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">학년</label>
                  <input
                    type="number"
                    min="1"
                    max="6"
                    className="block w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500 text-lg text-gray-900 placeholder-gray-300"
                    value={grade}
                    onChange={(e) => setGrade(e.target.value)}
                    placeholder="예: 1"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">반</label>
                  <input
                    type="number"
                    min="1"
                    max="20"
                    className="block w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500 text-lg text-gray-900 placeholder-gray-300"
                    value={classNm}
                    onChange={(e) => setClassNm(e.target.value)}
                    placeholder="예: 3"
                  />
                </div>
              </div>

              <button
                onClick={handleCreate}
                disabled={submitting || !grade || !classNm}
                className="w-full flex justify-center py-4 px-4 border border-transparent rounded-lg shadow-sm text-lg font-bold text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors mt-6"
              >
                {submitting ? '등록 중...' : '이대로 반 생성하기'}
              </button>
              {(!grade || !classNm) && (
                <p className="text-center text-sm text-amber-600 -mt-2">
                  {!grade && !classNm
                    ? '학년과 반 숫자를 입력하면 버튼이 켜져요'
                    : !grade
                      ? '학년 숫자를 입력하면 버튼이 켜져요'
                      : '반 숫자를 입력하면 버튼이 켜져요'}
                </p>
              )}

              <div className="relative py-2">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-gray-200"></div>
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="px-2 bg-white text-gray-400">또는</span>
                </div>
              </div>

              <button
                onClick={handleSchoolOnly}
                disabled={submitting}
                className="w-full flex justify-center py-3.5 px-4 border border-gray-300 rounded-lg text-base font-bold text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                🧑‍🏫 담임이 아니에요 — 학교만 등록하기
              </button>
              <p className="text-center text-xs text-gray-400 -mt-2 break-keep">
                교과 선생님도 내 시간표·수업 교환·보결 SOS를 모두 쓸 수 있어요. 담임 반은 나중에 언제든 등록 가능해요.
              </p>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
