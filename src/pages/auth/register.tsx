import React, { useState } from 'react'
import { useRouter } from 'next/router'
import { initFirebase } from '../../lib/firebase'
import { getAuth, createUserWithEmailAndPassword, sendEmailVerification } from 'firebase/auth'
import { doc, setDoc, serverTimestamp } from 'firebase/firestore'

// Ensure firebase is initialized
initFirebase()

// 🔒 교사 인증 코드 (나중에 환경변수로 뺄 수 있음)
const TEACHER_SECRET_CODE = "classmate2026"

export default function RegisterPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [secretCode, setSecretCode] = useState('') // 인증 코드 상태
  
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const auth = getAuth()

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setInfo(null)

    // 1. 기본 유효성 검사
    if (!email || !password || !secretCode) {
      setError('모든 항목을 입력해 주세요.')
      return
    }
    if (password.length < 6) {
      setError('비밀번호는 6자 이상이어야 합니다.')
      return
    }

    // 2. 인증 코드 검사 (핵심!)
    if (secretCode !== TEACHER_SECRET_CODE) {
      setError('교사 인증 코드가 올바르지 않습니다. 관리자에게 문의하세요.')
      return
    }

    setLoading(true)
    try {
      // 3. Firebase Auth 가입
      const cred = await createUserWithEmailAndPassword(auth, email, password)
      const user = cred.user

      // 4. Firestore에 유저 정보 저장
      try {
        const { db } = await import('../../lib/firebase')
        await setDoc(doc(db, 'users', user.uid), {
          email: user.email,
          displayName: displayName || null,
          role: 'teacher', // 교사 권한 부여
          schoolId: null,
          createdAt: serverTimestamp()
        })
      } catch (e) {
        console.warn('users doc write failed', e)
        // 치명적이지 않으므로 계속 진행 (단, 나중에 프로필 로드 이슈 가능성 있음)
      }

      // 5. 이메일 인증 발송
      await sendEmailVerification(user)
      setInfo('가입이 완료되었습니다! 인증 메일을 확인해 주세요. (잠시 후 로그인 페이지로 이동합니다)')
      
      // 3초 후 로그인 페이지로 이동
      setTimeout(() => {
        router.replace('/auth/login')
      }, 3000)

    } catch (e: any) {
      console.error(e)
      if (e.code === 'auth/email-already-in-use') {
        setError('이미 가입된 이메일입니다.')
      } else if (e.code === 'auth/invalid-email') {
        setError('이메일 형식이 올바르지 않습니다.')
      } else if (e.code === 'auth/weak-password') {
        setError('비밀번호가 너무 약합니다.')
      } else {
        setError('회원가입 중 오류가 발생했습니다: ' + (e.message || '알 수 없는 오류'))
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-center items-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-lg">
        <h2 className="mt-6 text-center text-4xl font-extrabold text-gray-900">
          회원가입
        </h2>
        <p className="mt-3 text-center text-base text-gray-600">
          선생님 계정 생성 (인증 코드 필요)
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-lg">
        <div className="bg-white py-10 px-6 shadow-xl rounded-2xl sm:px-12 border border-gray-100">
          <form className="space-y-6" onSubmit={onSubmit}>
            
            {/* 에러 메시지 */}
            {error && (
              <div className="rounded-md bg-red-50 p-4 border border-red-100">
                <div className="flex">
                  <div className="flex-shrink-0">
                    <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <div className="ml-3">
                    <p className="text-sm font-medium text-red-800">{error}</p>
                  </div>
                </div>
              </div>
            )}

            {/* 성공 메시지 */}
            {info && (
              <div className="rounded-md bg-green-50 p-4 border border-green-100">
                <div className="flex">
                  <div className="flex-shrink-0">
                    <svg className="h-5 w-5 text-green-400" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <div className="ml-3">
                    <p className="text-sm font-medium text-green-800">{info}</p>
                  </div>
                </div>
              </div>
            )}

            {/* 입력 폼 */}
            <div>
              <label className="block text-base font-medium text-gray-700 mb-1">이름 (선택)</label>
              <input
                className="appearance-none block w-full px-4 py-3 border border-gray-300 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-lg text-black"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="홍길동"
              />
            </div>

            <div>
              <label className="block text-base font-medium text-gray-700 mb-1">이메일</label>
              <input
                type="email"
                required
                className="appearance-none block w-full px-4 py-3 border border-gray-300 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-lg text-black"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="teacher@school.edu"
              />
            </div>

            <div>
              <label className="block text-base font-medium text-gray-700 mb-1">비밀번호</label>
              <input
                type="password"
                required
                className="appearance-none block w-full px-4 py-3 border border-gray-300 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-lg text-black"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="6자 이상 입력"
              />
            </div>

            <div className="pt-2">
              <label className="block text-base font-bold text-blue-700 mb-1">교사 인증 코드 🔒</label>
              <input
                type="text"
                required
                className="appearance-none block w-full px-4 py-3 border-2 border-blue-100 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-lg text-black bg-blue-50"
                value={secretCode}
                onChange={(e) => setSecretCode(e.target.value)}
                placeholder="전달받은 코드를 입력하세요"
              />
              <p className="mt-1 text-xs text-gray-500">
                * 교사만 가입할 수 있도록 인증 코드가 필요합니다.
              </p>
            </div>

            <div className="pt-4">
              <button
                type="submit"
                disabled={loading}
                className="w-full flex justify-center py-3 px-4 border border-transparent rounded-lg shadow-sm text-lg font-bold text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? '가입 처리 중...' : '회원가입 완료'}
              </button>
            </div>
          </form>

          <div className="mt-6">
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-300"></div>
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-2 bg-white text-gray-500">
                  이미 계정이 있으신가요?
                </span>
              </div>
            </div>

            <div className="mt-6 text-center">
              <a href="/auth/login" className="font-medium text-blue-600 hover:text-blue-500 text-base">
                로그인하러 가기
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
