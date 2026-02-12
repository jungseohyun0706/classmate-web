import React, { useState } from 'react'
import { useRouter } from 'next/router'
import { initFirebase } from '../../lib/firebase'
import { getAuth, signInWithEmailAndPassword, sendEmailVerification } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'

// Ensure firebase is initialized (idempotent)
initFirebase()

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const auth = getAuth()

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setInfo(null)
    if (!email || !password) {
      setError('이메일과 비밀번호를 입력해 주세요.')
      return
    }
    setLoading(true)
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password)
      const user = cred.user
      if (!user.emailVerified) {
        setInfo('이메일 인증이 필요합니다. 인증 메일을 다시 보낼 수 있어요.')
        setLoading(false)
        return
      }
      // optional: check users/{uid} doc for role and schoolId
      try {
        const { db } = await import('../../lib/firebase')
        const udoc = await getDoc(doc(db, 'users', user.uid))
        if (!udoc.exists()) {
          // If users doc missing, allow but warn
          console.warn('users doc missing for', user.uid)
        } else {
          const data = udoc.data() as any
          if (data.role !== 'teacher') {
            setError('이 계정은 교사용 계정이 아닙니다. 관리에게 문의하세요.')
            await auth.signOut()
            setLoading(false)
            return
          }
        }
      } catch (e) {
        // non-fatal: continue
        console.warn('users doc check failed', e)
      }

      // success -> redirect
      router.replace('/dashboard')
    } catch (e: any) {
      console.error(e)
      const msg = (e && e.message) || String(e)
      if (msg.includes('wrong-password')) setError('잘못된 비밀번호입니다.')
      else if (msg.includes('user-not-found')) setError('등록된 계정이 없습니다.')
      else setError('로그인에 실패했습니다. 이메일/비밀번호를 확인해 주세요.')
    } finally {
      setLoading(false)
    }
  }

  const resendVerification = async () => {
    setError(null)
    setInfo(null)
    if (!auth.currentUser) {
      setError('먼저 정상적으로 로그인한 상태여야 합니다. (임시 처리)')
      return
    }
    try {
      await sendEmailVerification(auth.currentUser)
      setInfo('인증 메일을 다시 보냈습니다. 메일함을 확인해 주세요.')
    } catch (e) {
      console.error(e)
      setError('인증 메일 전송에 실패했습니다. 잠시 후 다시 시도해 주세요.')
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4">
      <div className="max-w-md w-full bg-white p-8 rounded shadow">
        <h1 className="text-2xl font-semibold mb-6">교사용 로그인</h1>
        {error && (
          <div className="mb-4 text-sm text-red-700 bg-red-50 p-3 rounded">{error}</div>
        )}
        {info && (
          <div className="mb-4 text-sm text-blue-700 bg-blue-50 p-3 rounded">{info}</div>
        )}
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">이메일</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="학교 이메일을 입력하세요"
              className="mt-1 block w-full border border-gray-300 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">비밀번호</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="비밀번호"
              className="mt-1 block w-full border border-gray-300 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div className="flex items-center justify-between">
            <a href="/auth/register" className="text-sm text-indigo-600 hover:underline">회원가입</a>
            <a href="/auth/forgot" className="text-sm text-gray-600 hover:underline">비밀번호 재설정</a>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-indigo-600 text-white py-2 rounded disabled:opacity-60"
          >
            {loading ? '로그인 중...' : '로그인'}
          </button>
        </form>

        <div className="mt-4 text-sm text-gray-600">
          이메일 인증을 못 받으셨나요? 로그인 후 아래 버튼으로 인증메일을 다시 보낼 수 있어요.
        </div>
        <div className="mt-3">
          <button
            onClick={resendVerification}
            className="w-full border border-gray-300 rounded py-2 text-sm"
          >
            인증메일 다시보내기
          </button>
        </div>
      </div>
    </div>
  )
}
