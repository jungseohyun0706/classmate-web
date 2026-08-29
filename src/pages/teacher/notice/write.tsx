import React, { useState, useEffect } from 'react'
import { useRouter } from 'next/router'
import Link from 'next/link'
import { auth, storage } from '../../../lib/firebase'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc, collection, addDoc, serverTimestamp } from 'firebase/firestore'
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage'
import { useUI } from '../../../components/ui/feedback'

export default function WriteNotice() {
  const router = useRouter()
  const { toast } = useUI()

  const [loading, setLoading] = useState(true)
  const [userData, setUserData] = useState<any>(null)
  
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [requiresConsent, setRequiresConsent] = useState(false)
  const [supplies, setSupplies] = useState<string[]>([])
  const [supplyInput, setSupplyInput] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const addSupply = () => {
    const value = supplyInput.trim()
    if (!value) return
    if (supplies.includes(value)) {
      setSupplyInput('')
      return
    }
    if (supplies.length >= 20) {
      toast('준비물은 최대 20개까지 등록할 수 있어요.', 'error')
      return
    }
    setSupplies([...supplies, value])
    setSupplyInput('')
  }

  const removeSupply = (name: string) => {
    setSupplies(supplies.filter((s) => s !== name))
  }

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
          if (data.role === 'student') {
            router.replace('/student/today')
            return
          }
          if (!data.classId) {
            toast('담당 학급이 없어요. 먼저 반을 등록해 주세요.', 'error')
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
  }, [router, toast])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !body.trim()) {
      toast('제목과 내용을 입력해 주세요.', 'error')
      return
    }

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
        requiresConsent,
        ...(supplies.length > 0 ? { supplies } : {}),
        createdAt: serverTimestamp(),
        readCount: 0,
        checkCount: 0
      })

      toast('공지사항이 등록되었어요!', 'success')
      router.replace('/dashboard')

    } catch (e) {
      console.error(e)
      toast('등록에 실패했어요. 잠시 후 다시 시도해 주세요.', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <div className="p-10 text-center">로딩 중...</div>

  return (
    <div className="min-h-screen bg-gray-50 py-6 sm:py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-2xl mx-auto">
        <div className="mb-6 flex justify-between items-center">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">공지사항 쓰기</h1>
            <Link href="/teacher/notices" className="inline-block mt-1 text-sm font-medium text-blue-600 hover:text-blue-700">
              알림장 목록 보기 &rarr;
            </Link>
          </div>
          <button onClick={() => router.back()} className="min-h-[44px] px-3 text-gray-500 hover:text-gray-700">취소</button>
        </div>

        <div className="bg-white shadow-xl rounded-2xl p-5 sm:p-8 border border-gray-100">
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

            {/* 준비물 */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">준비물 (선택)</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={supplyInput}
                  onChange={(e) => setSupplyInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    if (e.nativeEvent.isComposing) return
                    e.preventDefault()
                    addSupply()
                  }}
                  placeholder="예: 체육복, 물감 — 입력 후 Enter"
                  className="flex-1 px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500 text-sm"
                />
                <button
                  type="button"
                  onClick={addSupply}
                  className="shrink-0 px-4 py-2.5 rounded-lg bg-blue-50 text-sm font-semibold text-blue-700 hover:bg-blue-100 transition-colors"
                >
                  추가
                </button>
              </div>
              {supplies.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {supplies.map((s) => (
                    <span
                      key={s}
                      className="inline-flex items-center gap-1 rounded-full bg-blue-100 pl-3 pr-1.5 py-1 text-sm font-medium text-blue-800"
                    >
                      {s}
                      <button
                        type="button"
                        onClick={() => removeSupply(s)}
                        aria-label={`${s} 삭제`}
                        className="flex h-5 w-5 items-center justify-center rounded-full text-blue-500 hover:bg-blue-200 hover:text-blue-800"
                      >
                        &times;
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <p className="mt-1.5 text-xs text-gray-500">
                등록하면 학생 화면의 '내일 가방 싸기' 체크리스트에 자동으로 들어가요.
              </p>
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

            {/* 학부모 동의 받기 */}
            <label className="flex items-start gap-3 p-4 bg-blue-50 rounded-xl cursor-pointer">
              <input
                type="checkbox"
                checked={requiresConsent}
                onChange={(e) => setRequiresConsent(e.target.checked)}
                className="mt-0.5 h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span>
                <span className="block text-sm font-semibold text-gray-900">학부모 동의 받기</span>
                <span className="block text-xs text-gray-500 mt-0.5">
                  체크하면 학생 화면에 동의/거절 버튼이 표시되고, 목록에서 동의 현황을 볼 수 있어요.
                </span>
              </span>
            </label>

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
