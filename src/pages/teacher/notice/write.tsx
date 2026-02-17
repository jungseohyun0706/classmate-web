import React, { useState, useEffect } from 'react'
import { useRouter } from 'next/router'
import { initFirebase } from '../../../lib/firebase'
import { getAuth, onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc, collection, addDoc, serverTimestamp } from 'firebase/firestore'
import { getStorage, ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage'

initFirebase()

export default function WriteNotice() {
  const router = useRouter()
  const auth = getAuth()
  const storage = getStorage()

  const [loading, setLoading] = useState(true)
  const [userData, setUserData] = useState<any>(null)
  
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.replace('/auth/login')
        return
      }
      try {
        const { db } = await import('../../../lib/firebase')
        const snap = await getDoc(doc(db, 'users', u.uid))
        if (snap.exists()) {
          const data = snap.data()
          if (!data.classId) {
            alert('담당 학급이 없습니다. 먼저 반을 등록해주세요.')
            router.replace('/dashboard')
            return
          }
          setUserData(data)
        }
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    })
    return () => unsub()
  }, [router, auth])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !body.trim()) return alert('제목과 내용을 입력해주세요.')
    
    setSubmitting(true)
    try {
      const { db } = await import('../../../lib/firebase')
      
      let attachmentUrl = null
      let attachmentName = null

      // 파일 업로드
      if (file) {
        const storageRef = ref(storage, `notices/${Date.now()}_${file.name}`)
        const uploadTask = await uploadBytesResumable(storageRef, file)
        attachmentUrl = await getDownloadURL(uploadTask.ref)
        attachmentName = file.name
      }

      // Firestore 저장 (classes/{classId}/announcements)
      await addDoc(collection(db, 'classes', userData.classId, 'announcements'), {
        title,
        body,
        authorId: auth.currentUser?.uid,
        authorName: userData.displayName || '선생님',
        attachmentUrl,
        attachmentName,
        createdAt: serverTimestamp(),
        readCount: 0
      })

      alert('공지사항이 등록되었습니다!')
      router.replace('/dashboard')

    } catch (e) {
      console.error(e)
      alert('등록 실패: 오류가 발생했습니다.')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <div className="p-10 text-center">로딩 중...</div>

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-2xl mx-auto">
        <div className="mb-6 flex justify-between items-center">
          <h1 className="text-3xl font-bold text-gray-900">공지사항 쓰기</h1>
          <button onClick={() => router.back()} className="text-gray-500 hover:text-gray-700">취소</button>
        </div>

        <div className="bg-white shadow-xl rounded-2xl p-8 border border-gray-100">
          <form onSubmit={handleSubmit} className="space-y-6">
            
            {/* 받는 사람 (자동 표시) */}
            <div>
              <label className="block text-sm font-medium text-gray-500 mb-1">받는 사람</label>
              <div className="text-lg font-bold text-blue-600">
                {userData?.schoolName} {userData?.grade}학년 {userData?.classNm}반 전체
              </div>
            </div>

            {/* 제목 */}
            <div>
              <label className="block text-lg font-medium text-gray-900 mb-2">제목</label>
              <input
                type="text"
                required
                className="block w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500 text-lg"
                placeholder="예: 다음 주 준비물 안내"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            {/* 내용 */}
            <div>
              <label className="block text-lg font-medium text-gray-900 mb-2">내용</label>
              <textarea
                required
                rows={8}
                className="block w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500 text-base"
                placeholder="내용을 입력하세요..."
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </div>

            {/* 파일 첨부 */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">첨부파일 (선택)</label>
              <input
                type="file"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="block w-full text-sm text-gray-500
                  file:mr-4 file:py-2 file:px-4
                  file:rounded-full file:border-0
                  file:text-sm file:font-semibold
                  file:bg-blue-50 file:text-blue-700
                  hover:file:bg-blue-100"
              />
            </div>

            {/* 버튼 */}
            <div className="pt-4">
              <button
                type="submit"
                disabled={submitting}
                className="w-full flex justify-center py-4 px-4 border border-transparent rounded-xl shadow-sm text-xl font-bold text-white bg-blue-600 hover:bg-blue-700 focus:outline-none disabled:opacity-50 transition-colors"
              >
                {submitting ? '등록 중...' : '공지 보내기 🚀'}
              </button>
            </div>

          </form>
        </div>
      </div>
    </div>
  )
}
