import React, { useState } from 'react'
import { useRouter } from 'next/router'
import { initFirebase } from '../../lib/firebase'
import { getAuth } from 'firebase/auth'
import { doc, setDoc, collection, serverTimestamp } from 'firebase/firestore'

initFirebase()

type School = {
  code: string
  officeCode: string
  name: string
  address: string
  kind: string
}

export default function RegisterClass() {
  const router = useRouter()
  const auth = getAuth()
  
  // Steps: 0 = Search School, 1 = Input Class Info
  const [step, setStep] = useState(0)
  
  // Search State
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<School[]>([])
  const [searching, setSearching] = useState(false)
  const [selectedSchool, setSelectedSchool] = useState<School | null>(null)

  // Class Info State
  const [grade, setGrade] = useState('')
  const [classNm, setClassNm] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // 1. 학교 검색 함수
  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!query.trim()) return
    setSearching(true)
    setResults([])
    
    try {
      const res = await fetch(`/api/schools?query=${encodeURIComponent(query)}`)
      const data = await res.json()
      if (data.schools) {
        setResults(data.schools)
      }
    } catch (err) {
      alert('학교 검색 중 오류가 발생했습니다.')
    } finally {
      setSearching(false)
    }
  }

  // 2. 반 등록 함수
  const handleCreate = async () => {
    if (!selectedSchool || !grade || !classNm) return
    if (!auth.currentUser) {
      alert('로그인이 필요합니다.')
      router.replace('/auth/login')
      return
    }

    setSubmitting(true)
    try {
      const { db } = await import('../../lib/firebase')
      const user = auth.currentUser
      
      // 고유 반 ID 생성 (학교코드_학년_반)
      // 이렇게 하면 중복 생성을 방지하거나 쉽게 찾을 수 있음
      const classId = `${selectedSchool.code}_${grade}_${classNm}`
      
      // 1. Classes 컬렉션에 반 정보 저장
      // setDoc을 쓰면 이미 있으면 덮어쓰기(업데이트) 됨
      await setDoc(doc(db, 'classes', classId), {
        classId: classId,
        schoolCode: selectedSchool.code,
        schoolName: selectedSchool.name,
        grade: parseInt(grade),
        classNm: parseInt(classNm),
        teacherId: user.uid,
        teacherName: user.displayName || '담임 선생님',
        createdAt: serverTimestamp()
      }, { merge: true })

      // 2. 선생님 계정(Users)에 내 반 정보 연결 (없으면 생성)
      await setDoc(doc(db, 'users', user.uid), {
        classId: classId,
        schoolCode: selectedSchool.code,
        schoolName: selectedSchool.name,
        grade: parseInt(grade),
        classNm: parseInt(classNm),
        role: 'teacher'
      }, { merge: true })

      alert('반 등록이 완료되었습니다!')
      router.replace('/dashboard')

    } catch (e: any) {
      console.error(e)
      alert('등록 실패: ' + (e.message || e.code || '알 수 없는 오류'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4 sm:px-6 lg:px-8 flex justify-center">
      <div className="max-w-xl w-full space-y-8">
        
        {/* Header */}
        <div className="text-center">
          <h2 className="text-3xl font-extrabold text-gray-900">우리 반 등록하기</h2>
          <p className="mt-2 text-sm text-gray-600">
            {step === 0 ? '먼저 학교를 검색해서 선택해주세요.' : '학년과 반을 입력해주세요.'}
          </p>
        </div>

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
              <div className="mt-4 max-h-96 overflow-y-auto space-y-2">
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
                    검색 결과가 없습니다.
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
                  className="text-xs text-gray-500 underline mt-2 hover:text-gray-700"
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
                    className="block w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500 text-lg"
                    value={grade}
                    onChange={(e) => setGrade(e.target.value)}
                    placeholder="1"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">반</label>
                  <input
                    type="number"
                    min="1"
                    max="20"
                    className="block w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500 text-lg"
                    value={classNm}
                    onChange={(e) => setClassNm(e.target.value)}
                    placeholder="3"
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
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
