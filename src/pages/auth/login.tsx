import React, { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { auth } from '../../lib/firebase'
import {
  signInWithEmailAndPassword,
  sendEmailVerification,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  type User,
} from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import InviteCodeInput from '../../components/InviteCodeInput'
import {
  clearPendingInvite,
  formatInviteCode,
  invitePath,
  isInvitePath,
  normalizeInviteCode,
  readPendingInvite,
  safeNextPath,
} from '../../lib/pendingInvite'
import { missingProfileStep } from '../../lib/authRouting'
import { useHydrated } from '../../lib/useHydrated'

const GoogleIcon = () => (
  <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/>
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0012 23z"/>
    <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 010-4.2V7.06H2.18a11 11 0 000 9.88l3.66-2.84z"/>
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 002.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/>
  </svg>
)

const ROLE_CHECK_FAILED = '계정 정보를 확인하지 못했어요. 네트워크를 확인하고 다시 시도해 주세요.'

export default function LoginPage() {
  const hydrated = useHydrated()
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  // 구글로 처음 들어온 사용자 → 교사 인증 코드 단계
  // choose = 계정은 있지만 프로필이 없는 계정(가입 미완료): 학생(초대 코드) / 선생님(교사 인증) 갈래
  const [mode, setMode] = useState<'login' | 'code' | 'choose'>('login')
  const [pendingUser, setPendingUser] = useState<User | null>(null)
  const [signupCode, setSignupCode] = useState('')
  const [codeLoading, setCodeLoading] = useState(false)
  // 이메일 인증 전 교사는 로그아웃시키므로, 인증 메일 재전송에 쓸 User를 따로 보관해요.
  const [unverifiedUser, setUnverifiedUser] = useState<User | null>(null)

  // 로그인 뒤 돌아갈 곳: ?next=(같은 사이트 상대 경로만 — 임의 리디렉션 방지) → 보관 중인 초대(/i/코드) → 역할별 기본 화면
  // (프로필 없는 계정은 보관된 초대로 자동 이동하지 않음 — routeMissing)
  const nextParam = safeNextPath(router.query.next)
  const safeNext = nextParam && !nextParam.startsWith('/auth/') ? nextParam : null
  const nextQuery = safeNext ? `?next=${encodeURIComponent(safeNext)}` : ''
  const [pendingCode, setPendingCode] = useState<string | null>(null)
  useEffect(() => {
    setPendingCode(readPendingInvite())
  }, [])

  const nextIsInvite = !!safeNext && isInvitePath(safeNext)
  /** 로그인 완료 뒤 이동: ?next → 보관 중인 초대 → 기본 화면 */
  const afterLogin = (fallback: string): string => {
    if (safeNext) return safeNext
    const code = readPendingInvite()
    return code ? invitePath(code) : fallback
  }
  /**
   * 프로필이 없는 계정: ?next가 초대(초대 화면에서 '로그인하고 참여')면 그 초대로, 아니면 학생/선생님 갈래 화면.
   * 보관된 초대만으로는 자동 이동하지 않음 — 이 브라우저에 남은 초대 때문에 구글로 처음 로그인한 선생님이
   * 교사 인증 단계로 갈 수 없고 초대를 수락하면 학생 프로필이 생기던 문제. 보관된 초대는 갈래 화면의 학생 쪽 버튼으로 이어감.
   */
  const routeMissing = (user: User) => {
    const step = missingProfileStep(nextIsInvite ? safeNext : null, readPendingInvite())
    if (step.kind === 'invite') {
      router.replace(step.path)
      return
    }
    setPendingCode(step.resumeCode)
    setPendingUser(user)
    setMode('choose')
  }
  // 화면 위 안내용: 이 로그인이 어떤 초대로 이어지는지(?next가 초대면 그 코드, ?next가 없으면 보관 중인 초대)
  const bannerCode = nextIsInvite ? (safeNext!.startsWith('/i/') ? normalizeInviteCode(safeNext) : null) : !safeNext ? pendingCode : null
  const showInviteBanner = nextIsInvite || !!bannerCode

  /**
   * 로그인 성공 후 공통 처리: users 문서의 role에 따라 이동
   * missing = 문서/role 없음(교사 등록 전), error = 읽기 실패(네트워크 등)
   */
  const routeByRole = async (user: User): Promise<'student' | 'teacher' | 'missing' | 'error'> => {
    try {
      const { db } = await import('../../lib/firebase')
      const udoc = await getDoc(doc(db, 'users', user.uid))
      if (udoc.exists()) {
        const role = ((udoc.data() as any)?.role as string) ?? null
        if (role === 'student') return 'student'
        if (role === 'teacher') return 'teacher'
      }
      return 'missing'
    } catch (e) {
      console.warn('users doc check failed', e)
      return 'error'
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
      const role = await routeByRole(cred.user)
      if (role === 'student') {
        router.replace(afterLogin('/student/today'))
        return
      }
      if (role === 'teacher') {
        router.replace(afterLogin('/dashboard'))
        return
      }
      // 읽기 실패를 '처음 온 사용자'로 착각해 코드 단계로 보내지 않아요.
      if (role === 'error') {
        try {
          await signOut(auth)
        } catch {}
        setError(ROLE_CHECK_FAILED)
        return
      }
      // 처음 온 사용자(프로필 없음) → ?next가 초대면 그 초대로, 아니면 학생/선생님 갈래
      routeMissing(cred.user)
    } catch (e: any) {
      console.error(e)
      const code = e?.code || ''
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        // 사용자가 창을 닫음 — 조용히 무시
      } else if (code === 'auth/popup-blocked') {
        setError('팝업이 차단됐어요. 브라우저에서 팝업을 허용해 주세요.')
      } else if (code === 'auth/unauthorized-domain') {
        setError('이 주소에서는 구글 로그인이 허용되지 않았어요. 관리자에게 문의해 주세요.')
      } else {
        setError('구글 로그인 중 문제가 발생했어요. 잠시 후 다시 시도해 주세요.')
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
        setError(data?.error || '등록 처리 중 오류가 발생했어요.')
        return
      }
      // 교사 계정은 학생 초대를 수락할 수 없으므로 이 브라우저에 보관된 초대를 지움
      // (지우지 않으면 대시보드·다음 로그인이 새 선생님을 학생 초대 화면으로 다시 보냄)
      clearPendingInvite()
      setPendingCode(null)
      // 이메일(비밀번호) 계정은 인증 메일을 확인해야 대시보드에 들어갈 수 있어요.
      const isPasswordUser = pendingUser.providerData.some((p) => p.providerId === 'password')
      if (isPasswordUser && !pendingUser.emailVerified) {
        let mailSent = true
        try {
          await sendEmailVerification(pendingUser)
        } catch (err) {
          console.warn('sendEmailVerification failed', err)
          mailSent = false
        }
        setUnverifiedUser(pendingUser)
        try {
          await signOut(auth)
        } catch {}
        setPendingUser(null)
        setSignupCode('')
        setMode('login')
        setInfo(
          mailSent
            ? '교사 등록이 완료됐어요. 인증 메일을 확인한 뒤 다시 로그인해 주세요.'
            : '교사 등록이 완료됐어요. 인증 메일을 보내지 못했으니 아래에서 다시 보내 주세요.'
        )
        return
      }
      router.replace('/dashboard')
    } catch (e) {
      console.error(e)
      setError('등록 처리 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.')
    } finally {
      setCodeLoading(false)
    }
  }

  const cancelCodeStep = async () => {
    try {
      await signOut(auth)
    } catch {}
    setPendingUser(null)
    setSignupCode('')
    setMode('login')
    setError(null)
    setInfo(null)
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setInfo(null)
    setUnverifiedUser(null)
    if (!email || !password) {
      setError('이메일과 비밀번호를 입력해 주세요.')
      return
    }
    setLoading(true)
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password)
      const user = cred.user

      const role = await routeByRole(user)

      // 학생: 이메일 인증 없이 바로 오늘 페이지로 이동해요.
      // (승인 대기 중이어도 /student/today 에서 대기 상태를 안내합니다)
      if (role === 'student') {
        router.replace(afterLogin('/student/today'))
        return
      }

      if (role === 'error') {
        try {
          await signOut(auth)
        } catch {}
        setError(ROLE_CHECK_FAILED)
        return
      }

      // 프로필이 없는 계정(교사 등록이나 학생 초대 수락 전) → ?next가 초대면 그 초대로 이어가고,
      // 아니면 바로 교사 코드 단계로 보내지 않고 학생(초대 코드) / 선생님(교사 인증) 중 고르게 함
      if (role === 'missing') {
        routeMissing(user)
        return
      }

      // 교사: 이메일 인증을 마쳐야 대시보드에 들어갈 수 있어요.
      // 로그인 상태로 두면 /dashboard로 바로 들어갈 수 있으니 로그아웃시켜요.
      if (!user.emailVerified) {
        setUnverifiedUser(user)
        try {
          await signOut(auth)
        } catch {}
        setInfo('이메일 인증이 필요합니다. 인증 메일을 다시 보낼 수 있어요.')
        setLoading(false)
        return
      }

      router.replace(afterLogin('/dashboard'))
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
    if (!unverifiedUser) {
      setError('먼저 로그인을 시도해 주세요.')
      return
    }
    try {
      await sendEmailVerification(unverifiedUser)
      setInfo('인증 메일을 다시 보냈습니다. 메일함을 확인해 주세요.')
    } catch (e) {
      console.error(e)
      setError('인증 메일 전송에 실패했습니다. 잠시 후 다시 시도해 주세요.')
    }
  }

  const errorBox = error && (
    <div className="rounded-md bg-red-50 p-4 border border-red-100">
      <div className="flex">
        <div className="flex-shrink-0">
          <svg className="h-5 w-5 text-red-400" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
          </svg>
        </div>
        <div className="ml-3">
          <h3 className="text-sm font-medium text-red-800">확인이 필요해요</h3>
          <div className="mt-2 text-sm text-red-700">
            <p>{error}</p>
          </div>
        </div>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-center items-center py-10 px-4 sm:px-6 lg:px-8">
      <div className="w-full max-w-lg mx-auto">
        <h2 className="mt-6 text-center text-4xl font-extrabold text-gray-900">
          Classmate
        </h2>
        <p className="mt-3 text-center text-base text-gray-600">
          클래스메이트 로그인
        </p>
        <p className="mt-1 text-center text-sm text-gray-400">
          선생님·학생 모두 여기서 로그인해요
        </p>
      </div>

      {showInviteBanner && mode === 'login' && (
        <div className="mt-6 w-full max-w-lg mx-auto rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-sm font-bold text-emerald-900 break-keep">
            {/* 보관된 초대만 있을 때는 프로필 없는 계정을 자동으로 보내지 않으므로(갈래 화면에서 고름) 학생 기준으로 안내 */}
            {nextIsInvite ? '로그인하면 받은 초대로 돌아가서 이어서 참여해요' : '받은 초대가 있어요 — 학생은 로그인하면 이어서 참여해요'}
            {bannerCode ? (
              <>
                {' '}
                <span className="font-mono tracking-widest whitespace-nowrap">({formatInviteCode(bannerCode)})</span>
              </>
            ) : null}
          </p>
          <p className="mt-1 text-sm text-emerald-800 break-keep">
            계정이 없다면{' '}
            <Link href={`/auth/register${nextQuery}`} className="font-bold underline">
              처음이에요 (가입)
            </Link>
            를 눌러 주세요.
          </p>
        </div>
      )}

      <div className="mt-8 w-full max-w-lg mx-auto">
        <div className="bg-white py-10 px-6 shadow-xl rounded-2xl sm:px-12 border border-gray-100">
          {mode === 'choose' ? (
            <div className="space-y-5">
              {errorBox}
              <div className="text-center">
                <p className="text-lg font-bold text-gray-900">가입이 아직 끝나지 않았어요</p>
                <p className="mt-2 text-sm text-gray-600 break-all">
                  {pendingUser?.email || '이'} 계정은 아직 학생이나 선생님으로 등록되지 않았어요.
                </p>
              </div>
              <div className="rounded-xl bg-emerald-50 border border-emerald-100 p-4">
                <p className="text-sm font-bold text-emerald-900">
                  <span aria-hidden="true">🎒 </span>
                  {pendingCode ? '학생이면 받은 초대로 이어서 참여하세요' : '학생이면 초대 코드를 입력하세요'}
                </p>
                {pendingCode ? (
                  <>
                    <p className="mt-1 mb-3 text-xs text-emerald-800 break-keep">
                      이 브라우저에서 열었던 초대예요. 참여하면 이 계정이 학생으로 등록돼요.
                    </p>
                    <Link
                      href={invitePath(pendingCode)}
                      className="block w-full min-h-[44px] rounded-lg bg-emerald-600 px-3 py-3 text-center text-white text-sm font-bold break-keep hover:bg-emerald-700 transition"
                    >
                      받은 초대로 이어서 참여{' '}
                      <span className="font-mono tracking-widest whitespace-nowrap">({formatInviteCode(pendingCode)})</span>
                    </Link>
                    <p className="mt-3 mb-2 text-xs text-emerald-800 break-keep">다른 초대 코드를 받았다면 입력하세요.</p>
                  </>
                ) : (
                  <p className="mt-1 mb-3 text-xs text-emerald-800 break-keep">
                    선생님께 받은 초대 코드(XXXX-XXXX)를 입력하면 이 계정으로 이어서 참여해요. 입장 QR이 있다면 다시 찍어도 돼요.
                  </p>
                )}
                <InviteCodeInput compact />
              </div>
              <div className="rounded-xl bg-blue-50 border border-blue-100 p-4">
                <p className="text-sm font-bold text-blue-900">
                  <span aria-hidden="true">🧑‍🏫 </span>선생님이면 교사 인증
                </p>
                <p className="mt-1 text-xs text-blue-800 break-keep">학교에서 받은 교사 인증 코드로 등록을 마쳐요.</p>
                <button
                  type="button"
                  onClick={() => {
                    setError(null)
                    setMode('code')
                  }}
                  className="mt-3 w-full min-h-[44px] rounded-lg bg-blue-600 text-white text-sm font-bold hover:bg-blue-700 transition"
                >
                  교사 인증 코드 입력하기
                </button>
              </div>
              <button
                type="button"
                onClick={cancelCodeStep}
                className="w-full min-h-[44px] flex justify-center items-center text-sm text-gray-500 hover:text-gray-700"
              >
                다른 계정으로 로그인
              </button>
            </div>
          ) : mode === 'code' ? (
            <form className="space-y-6" method="post" onSubmit={onSubmitCode}>
              {errorBox}
              <div className="text-center">
                <p className="text-lg font-bold text-gray-900">처음 오셨네요! 👋</p>
                <p className="mt-2 text-sm text-gray-600">
                  {pendingUser?.email} 계정으로 교사 등록을 마치려면
                  <br />
                  학교에서 받은 <b>교사 인증 코드</b>를 입력해 주세요.
                </p>
              </div>
              <div>
                <label htmlFor="signup-code" className="block text-base font-medium text-gray-700 mb-2">
                  교사 인증 코드
                </label>
                <input
                  id="signup-code"
                  type="text"
                  autoComplete="off"
                  required
                  value={signupCode}
                  onChange={(e) => setSignupCode(e.target.value)}
                  className="appearance-none block w-full px-4 py-3 border border-gray-300 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-lg text-black"
                  placeholder="인증 코드"
                />
              </div>
              <button
                type="submit"
                disabled={!hydrated || codeLoading}
                className="w-full flex justify-center py-3 px-4 border border-transparent rounded-lg shadow-sm text-lg font-bold text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 transition-colors"
              >
                {codeLoading ? '등록 중...' : '교사로 등록하기'}
              </button>
              <button
                type="button"
                onClick={cancelCodeStep}
                className="w-full flex justify-center py-2 text-sm text-gray-500 hover:text-gray-700"
              >
                다른 계정으로 로그인
              </button>
              <p className="text-xs text-gray-400 text-center leading-relaxed">
                학생이신가요?{' '}
                <button
                  type="button"
                  onClick={() => {
                    setError(null)
                    setMode('choose')
                  }}
                  className="inline-flex min-h-[44px] items-center font-medium text-emerald-700 underline"
                >
                  초대 코드 입력으로 돌아가기
                </button>
              </p>
            </form>
          ) : (
            <>
              <div className="space-y-4">
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

                <button
                  type="button"
                  onClick={onGoogleLogin}
                  disabled={googleLoading}
                  className="w-full flex justify-center items-center gap-3 py-3 px-4 border border-gray-300 rounded-lg shadow-sm text-lg font-bold text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 transition-colors"
                >
                  <GoogleIcon />
                  {googleLoading ? '로그인 중...' : '구글 계정으로 계속하기'}
                </button>

                <div className="relative py-2">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-gray-300"></div>
                  </div>
                  <div className="relative flex justify-center text-sm">
                    <span className="px-2 bg-white text-gray-500">또는 이메일로 로그인</span>
                  </div>
                </div>
              </div>

              <form className="space-y-5 mt-4" method="post" onSubmit={onSubmit}>
                <div>
                  <label htmlFor="email" className="block text-base font-medium text-gray-700 mb-2">
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
                      className="appearance-none block w-full px-4 py-3 border border-gray-300 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-lg text-black"
                      placeholder="teacher@school.edu"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="password" className="block text-base font-medium text-gray-700 mb-2">
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
                      className="appearance-none block w-full px-4 py-3 border border-gray-300 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-lg text-black"
                      placeholder="••••••••"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <div className="text-sm">
                    <Link href={`/auth/register${nextQuery}`} className="font-medium text-blue-600 hover:text-blue-500 text-base">
                      회원가입
                    </Link>
                  </div>
                  <div className="text-sm">
                    <a href="/auth/forgot" className="font-medium text-gray-600 hover:text-gray-500 text-base">
                      비밀번호 찾기
                    </a>
                  </div>
                </div>

                {/* 에러는 제출 버튼 바로 위 — 모바일에서 시야 안에 뜨도록 */}
                {errorBox}

                <div>
                  <button
                    type="submit"
                    disabled={!hydrated || loading}
                    className="w-full flex justify-center py-3 px-4 border border-transparent rounded-lg shadow-sm text-lg font-bold text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
                <div className="mt-8">
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
                      className="w-full flex justify-center py-3 px-4 border border-gray-300 rounded-lg shadow-sm text-base font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                    >
                      인증메일 다시 보내기
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        {/* 설치한 앱을 처음 연 학생 등: 로그인 전에 초대 코드부터 확인할 수 있게(초대 화면에서 로그인·가입으로 이어짐) */}
        {mode === 'login' && !showInviteBanner && (
          <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
            <p className="text-sm font-bold text-emerald-900 break-keep">학생인가요? 받은 초대 코드가 있다면</p>
            <p className="mt-0.5 mb-3 text-xs text-emerald-800 break-keep">
              코드를 먼저 입력하면 초대 화면에서 로그인하거나 가입하고 이어서 참여해요.
            </p>
            <InviteCodeInput compact />
          </div>
        )}
        <p className="mt-6 text-center text-sm text-gray-400">
          &copy; 2026 Classmate. All rights reserved.
        </p>
      </div>
    </div>
  )
}
