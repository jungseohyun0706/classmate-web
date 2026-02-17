import React, { useState, useEffect } from 'react'
import { useRouter } from 'next/router'
import { initFirebase } from '../../lib/firebase'
import { getAuth, onAuthStateChanged, sendPasswordResetEmail, updateProfile } from 'firebase/auth'
import { doc, getDoc, updateDoc } from 'firebase/firestore'

initFirebase()

export default function SettingsPage() {
  const router = useRouter()
  const auth = getAuth()
  
  const [user, setUser] = useState<any>(null)
  const [userData, setUserData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  
  const [displayName, setDisplayName] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.replace('/auth/login')
        return
      }
      setUser(u)
      try {
        const { db } = await import('../../lib/firebase')
        const snap = await getDoc(doc(db, 'users', u.uid))
        if (snap.exists()) {
          const data = snap.data()
          setUserData(data)
          setDisplayName(data.displayName || u.displayName || '')
        }
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    })
    return () => unsub()
  }, [router, auth])

  // 이름 변경 저장
  const handleSaveProfile = async () => {
    if (!displayName.trim()) return alert('이름을 입력해주세요.')
    setSaving(true)
    try {
      const { db } = await import('../../lib/firebase')
      
      // 1. Auth 프로필 업데이트
      if (auth.currentUser) {
        await updateProfile(auth.currentUser, { displayName })
      }

      // 2. Firestore 유저 정보 업데이트
      await updateDoc(doc(db, 'users', user.uid), {
        displayName
      })

      // 3. (옵션) 반 정보(Classes)에 있는 teacherName도 업데이트하면 좋음
      if (userData?.classId) {
        await updateDoc(doc(db, 'classes', userData.classId), {
          teacherName: displayName
        })
      }

      alert('저장되었습니다.')
    } catch (e) {
      console.error(e)
      alert('저장 중 오류가 발생했습니다.')
    } finally {
      setSaving(false)
    }
  }

  // 비밀번호 재설정 메일 발송
  const handleResetPassword = async () => {
    if (!confirm(`${user.email}로 비밀번호 재설정 메일을 보내시겠습니까?`)) return
    try {
      await sendPasswordResetEmail(auth, user.email)
      alert('메일을 보냈습니다. 메일함을 확인해주세요.')
    } catch (e) {
      alert('메일 발송 실패.')
    }
  }

  if (loading) return <div className="p-10 text-center">로딩 중...</div>

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-xl mx-auto">
        <div className="mb-6 flex justify-between items-center">
          <h1 className="text-2xl font-bold text-gray-900">계정 설정</h1>
          <button onClick={() => router.push('/dashboard')} className="text-gray-500 hover:text-gray-700">
            &larr; 대시보드로
          </button>
        </div>

        <div className="bg-white shadow rounded-lg divide-y divide-gray-200">
          
          {/* 프로필 수정 섹션 */}
          <div className="p-6">
            <h2 className="text-lg font-medium text-gray-900 mb-4">내 정보 수정</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">이메일 (아이디)</label>
                <input 
                  disabled 
                  value={user?.email || ''} 
                  className="mt-1 block w-full px-3 py-2 border border-gray-200 rounded-md bg-gray-100 text-gray-500"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700">이름</label>
                <div className="mt-1 flex rounded-md shadow-sm">
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    className="flex-1 min-w-0 block w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                    placeholder="홍길동"
                  />
                  <button
                    onClick={handleSaveProfile}
                    disabled={saving}
                    className="ml-3 inline-flex justify-center py-2 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
                  >
                    {saving ? '저장...' : '저장'}
                  </button>
                </div>
                <p className="mt-2 text-sm text-gray-500">학생들에게 표시되는 이름입니다.</p>
              </div>
            </div>
          </div>

          {/* 반 정보 섹션 (읽기 전용) */}
          {userData?.classId && (
            <div className="p-6">
              <h2 className="text-lg font-medium text-gray-900 mb-4">내 학급 정보</h2>
              <div className="bg-gray-50 p-4 rounded-md border border-gray-200">
                <p className="text-sm text-gray-600">학교</p>
                <p className="font-medium text-gray-900">{userData.schoolName}</p>
                <div className="mt-3 flex gap-4">
                  <div>
                    <p className="text-sm text-gray-600">학년</p>
                    <p className="font-medium text-gray-900">{userData.grade}학년</p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-600">반</p>
                    <p className="font-medium text-gray-900">{userData.classNm}반</p>
                  </div>
                </div>
              </div>
              <p className="mt-2 text-xs text-gray-400">* 학급 정보 변경은 관리자에게 문의하세요.</p>
            </div>
          )}

          {/* 보안 섹션 */}
          <div className="p-6 bg-gray-50 rounded-b-lg">
            <h2 className="text-lg font-medium text-gray-900 mb-4">보안</h2>
            <button
              onClick={handleResetPassword}
              className="text-red-600 hover:text-red-800 text-sm font-medium underline"
            >
              비밀번호 재설정 메일 보내기
            </button>
          </div>

        </div>
      </div>
    </div>
  )
}
