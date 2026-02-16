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
      try {
        const { db } = await import('../../lib/firebase')
        const udoc = await getDoc(doc(db, 'users', user.uid))
        if (!udoc.exists()) {
          console.warn('users doc missing for', user.uid)
        } else {
          const data = udoc.data() as any
          if (data.role !== 'teacher') {
            setError('이 계정은 교사용 계정이 아닙니다. 관리자에게 문의하세요.')
            await auth.signOut()
            setLoading(false)
            return
          }
        }
      } catch (e) {
        console.warn('users doc check failed', e)
      }
      router.replace('/dashboard')
    } catch (e: any) {
      console.error(e)
      const msg = (e && e.message) || String(e)
      if (msg.includes('wrong-password') || msg.includes('user-not-found') || msg.includes('invalid-credential')) {
        setError('이메일 또는 비밀번호가 올바르지 않습니다.')
      } else {
        setError('로그인 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.')
      }
    } finally {
      setLoading(false)
    }
  }

  const resendVerification = async () => {
    setError(null)
    setInfo(null)
    if (!auth.currentUser) {
      setError('먼저 로그인을 시도해 주세요.')
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
    <div className="min-h-screen bg-gray-50 flex flex-col justify-center items-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
          Classmate
        </h2>
        <p className="mt-2 text-center text-sm text-gray-600">
          교사용 관리자 로그인
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-8 px-4 shadow-lg rounded-xl sm:px-10 border border-gray-100">
          <form className="space-y-6" onSubmit={onSubmit}>
            {error && (
              <div className="rounded-md bg-red-50 p-4 border border-red-100">
                <div className="flex">
                  <div className="flex-shrink-0">
                    <svg className="h-5 w-5 text-red-400" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <div className="ml-3">
                    <h3 className="text-sm font-medium text-red-800">
                      로그인 실패
                    </h3>
                    <div className="mt-2 text-sm text-red-700">
                      <p>{error}</p>
                    </div>
                  </div>
                </div>
              </div>
            )}
            
            {info && (
              <div className="rounded-md bg-blue-50 p-4 border border-blue-100">
                <div className="flex">
                  <div className="flex-shrink-0">
                    <svg className="h-5 w-5 text-blue-400" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <div className="ml-3 flex-1 md:flex md:justify-between">
                    <p className="text-sm text-blue-700">{info}</p>
                  </div>
                </div>
              </div>
            )}

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700">
                이메일
              </label>
              <div className="mt-1">
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="appearance-none block w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm text-black"
                  placeholder="teacher@school.edu"
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                비밀번호
              </label>
              <div className="mt-1">
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="appearance-none block w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm text-black"
                  placeholder="••••••••"
                />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div className="text-sm">
                <a href="/auth/register" className="font-medium text-blue-600 hover:text-blue-500">
                  회원가입
                </a>
              </div>
              <div className="text-sm">
                <a href="/auth/forgot" className="font-medium text-gray-600 hover:text-gray-500">
                  비밀번호 찾기
                </a>
              </div>
            </div>

            <div>
              <button
                type="submit"
                disabled={loading}
                className="w-full flex justify-center py-2.5 px-4 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? (
                  <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                ) : null}
                {loading ? '로그인 중...' : '로그인'}
              </button>
            </div>
          </form>

          {info?.includes('인증') && (
            <div className="mt-6">
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-gray-300"></div>
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="px-2 bg-white text-gray-500">
                    메일을 받지 못하셨나요?
                  </span>
                </div>
              </div>

              <div className="mt-6">
                <button
                  onClick={resendVerification}
                  className="w-full flex justify-center py-2 px-4 border border-gray-300 rounded-lg shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  인증메일 다시 보내기
                </button>
              </div>
            </div>
          )}
        </div>
        <p className="mt-4 text-center text-xs text-gray-400">
          &copy; 2026 Classmate. All rights reserved.
        </p>
      </div>
    </div>
  )
}
