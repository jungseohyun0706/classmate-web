import React, { useState } from 'react'
import { useRouter } from 'next/router'
import Link from 'next/link'
import { initFirebase } from '../../lib/firebase'
import {
  getAuth, signInWithEmailAndPassword, sendEmailVerification,
  signInWithPopup, GoogleAuthProvider, signOut, type User,
} from 'firebase/auth'
import { doc, getDoc, getFirestore } from 'firebase/firestore'

// Ensure firebase is initialized (idempotent)
initFirebase()

const GoogleIcon = () => (
  <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/>
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0012 23z"/>
    <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 010-4.2V7.06H2.18a11 11 0 000 9.88l3.66-2.84z"/>
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 002.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/>
  </svg>
)

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [showEmailForm, setShowEmailForm] = useState(false)

  // 신규 구글 사용자 → 교사 인증 코드 단계
  const [mode, setMode] = useState<'login' | 'code'>('login')
  const [pendingUser, setPendingUser] = useState<User | null>(null)
  const [signupCode, setSignupCode] = useState('')
  const [codeLoading, setCodeLoading] = useState(false)

  const auth = getAuth()

  /** 로그인 성공 후 공통 처리: users 문서 확인 → 대시보드 or 코드 입력 단계 */
  const afterAuth = async (user: User) => {
    try {
      const db = getFirestore()
      const udoc = await getDoc(doc(db, 'users', user.uid))
      if (udoc.exists()) {
        const data = udoc.data() as any
        if (data.role === 'student') {
          setError('학생 계정입니다. 학생은 로그인 없이 classmate.kr/s 에서 시간표를 볼 수 있어요.')
          await signOut(auth)
          return
        }
        if (data.role === 'teacher') {
          router.replace('/dashboard')
          return
        }
      }
      // users 문서가 없거나 role이 없음 → 신규 교사 등록 (인증 코드)
      setPendingUser(user)
      setMode('code')
      setError(null)
      setInfo(null)
    } catch (e) {
      console.warn('users doc check failed', e)
      router.replace('/dashboard')
    }
  }

  const onGoogleLogin = async () => {
    setError(null)
    setInfo(null)
    setGoogleLoading(true)
    try {
      const provider = new GoogleAuthProvider()
      provider.setCustomParameters({ prompt: 'select_account' })
      const cred = await signInWithPopup(auth, provider)
      await afterAuth(cred.user)
    } catch (e: any) {
      console.error(e)
      const code = e?.code || ''
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        // 사용자가 창을 닫음 — 조용히 무시
      } else if (code === 'auth/popup-blocked') {
        setError('팝업이 차단되었습니다. 브라우저에서 팝업을 허용해 주세요.')
      } else if (code === 'auth/unauthorized-domain') {
        setError('이 주소에서는 구글 로그인이 허용되지 않았습니다. 관리자에게 문의하세요.')
      } else {
        setError('구글 로그인 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.')
      }
    } finally {
      setGoogleLoading(false)
    }
  }

  const onSubmitCode = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!pendingUser) return
    if (!signupCode.trim()) {
      setError('교사 인증 코드를 입력해 주세요.')
      return
    }
    setError(null)
    setCodeLoading(true)
    try {
      const idToken = await pendingUser.getIdToken()
      const res = await fetch('/api/complete-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, code: signupCode.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data?.error || '등록 처리 중 오류가 발생했습니다.')
        return
      }
      router.replace('/dashboard')
    } catch (e) {
      console.error(e)
      setError('등록 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.')
    } finally {
      setCodeLoading(false)
    }
  }

  const cancelCodeStep = async () => {
    await signOut(auth)
    setPendingUser(null)
    setSignupCode('')
    setMode('login')
    setError(null)
  }

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
      await afterAuth(user)
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
      <div className="sm:mx-auto sm:w-full sm:max-w-lg">
        <h2 className="mt-6 text-center text-4xl font-extrabold text-gray-900">
          Classmate
        </h2>
        <p className="mt-3 text-center text-base text-gray-600">
          {mode === 'code' ? '교사 인증 코드 입력' : '교사용 관리자 로그인'}
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-lg">
        <div className="bg-white py-10 px-6 shadow-xl rounded-2xl sm:px-12 border border-gray-100">

          {error && (
            <div className="mb-6 rounded-md bg-red-50 p-4 border border-red-100">
              <p className="text-sm font-medium text-red-800">{error}</p>
            </div>
          )}
          {info && (
            <div className="mb-6 rounded-md bg-blue-50 p-4 border border-blue-100">
              <p className="text-sm text-blue-700">{info}</p>
            </div>
          )}

          {mode === 'code' ? (
            /* ===== 신규 교사: 인증 코드 단계 ===== */
            <form className="space-y-6" onSubmit={onSubmitCode}>
              <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-sm text-gray-700">
                <b>{pendingUser?.displayName || pendingUser?.email}</b> 님, 반가워요!<br />
                교사만 가입할 수 있도록 학교에서 전달받은 <b>교사 인증 코드</b>를 입력해 주세요.
              </div>
              <div>
                <label className="block text-base font-bold text-blue-700 mb-1">교사 인증 코드 🔒</label>
                <input
                  type="password"
                  autoFocus
                  required
                  value={signupCode}
                  onChange={(e) => setSignupCode(e.target.value)}
                  className="appearance-none block w-full px-4 py-3 border-2 border-blue-100 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-lg text-black bg-blue-50"
                  placeholder="전달받은 코드를 입력하세요"
                />
              </div>
              <button
                type="submit"
                disabled={codeLoading}
                className="w-full flex justify-center py-3 px-4 rounded-lg shadow-sm text-lg font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {codeLoading ? '확인 중...' : '등록 완료하고 시작하기'}
              </button>
              <button
                type="button"
                onClick={cancelCodeStep}
                className="w-full text-sm text-gray-400 hover:text-gray-600 underline"
              >
                다른 계정으로 로그인
              </button>
            </form>
          ) : (
            /* ===== 로그인 단계 ===== */
            <>
              <button
                onClick={onGoogleLogin}
                disabled={googleLoading}
                className="w-full flex items-center justify-center gap-3 py-3.5 px-4 border border-gray-300 rounded-xl shadow-sm text-lg font-bold text-gray-800 bg-white hover:bg-gray-50 disabled:opacity-60 transition-colors"
              >
                <GoogleIcon />
                {googleLoading ? '연결 중...' : 'Google 계정으로 계속하기'}
              </button>
              <p className="mt-3 text-center text-xs text-gray-400">
                처음이라면 로그인 후 교사 인증 코드 입력으로 바로 가입돼요.
              </p>

              <div className="relative my-7">
                <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-gray-200"></div></div>
                <div className="relative flex justify-center text-sm">
                  <button
                    onClick={() => setShowEmailForm(!showEmailForm)}
                    className="px-3 bg-white text-gray-400 hover:text-gray-600"
                  >
                    이메일로 로그인 {showEmailForm ? '접기 ▲' : '펼치기 ▼'}
                  </button>
                </div>
              </div>

              {showEmailForm && (
                <form className="space-y-6" onSubmit={onSubmit}>
                  <div>
                    <label htmlFor="email" className="block text-base font-medium text-gray-700 mb-2">이메일</label>
                    <input
                      id="email" name="email" type="email" autoComplete="email" required
                      value={email} onChange={(e) => setEmail(e.target.value)}
                      className="appearance-none block w-full px-4 py-3 border border-gray-300 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-lg text-black"
                      placeholder="teacher@school.edu"
                    />
                  </div>
                  <div>
                    <label htmlFor="password" className="block text-base font-medium text-gray-700 mb-2">비밀번호</label>
                    <input
                      id="password" name="password" type="password" autoComplete="current-password" required
                      value={password} onChange={(e) => setPassword(e.target.value)}
                      className="appearance-none block w-full px-4 py-3 border border-gray-300 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-lg text-black"
                      placeholder="••••••••"
                    />
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <Link href="/auth/register" className="font-medium text-blue-600 hover:text-blue-500">이메일로 회원가입</Link>
                    <Link href="/auth/forgot" className="font-medium text-gray-500 hover:text-gray-600">비밀번호 찾기</Link>
                  </div>
                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full flex justify-center py-3 px-4 rounded-lg shadow-sm text-lg font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  >
                    {loading ? '로그인 중...' : '이메일로 로그인'}
                  </button>

                  {info?.includes('인증') && (
                    <button
                      type="button"
                      onClick={resendVerification}
                      className="w-full flex justify-center py-3 px-4 border border-gray-300 rounded-lg text-base font-medium text-gray-700 bg-white hover:bg-gray-50"
                    >
                      인증메일 다시 보내기
                    </button>
                  )}
                </form>
              )}
            </>
          )}
        </div>
        <p className="mt-6 text-center text-sm text-gray-400">
          &copy; 2026 Classmate. All rights reserved.
        </p>
      </div>
    </div>
  )
}
