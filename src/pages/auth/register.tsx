import React, { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { auth } from '../../lib/firebase'
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  sendEmailVerification,
  signInWithPopup,
  signOut,
  updateProfile,
  type User,
} from 'firebase/auth'
import { doc, setDoc } from 'firebase/firestore'
import { useUI } from '../../components/ui/feedback'
import InviteCodeInput from '../../components/InviteCodeInput'
import { formatInviteCode, invitePath, isInvitePath, normalizeInviteCode, readPendingInvite, safeNextPath } from '../../lib/pendingInvite'
import { useHydrated } from '../../lib/useHydrated'

// 회원가입
// - 선생님: 교사 인증 코드 필요(기존 동작 그대로). 가입 후 이메일 인증 → 로그인(?next 유지).
// - 학생: 초대(?next=/i/… 또는 보관 중인 초대)로 들어온 경우에만 계정(이메일·비밀번호)을 만들고 그 초대로 돌아감.
//   학생 프로필(users/{uid})은 클라이언트가 만들 수 없어 초대 수락(/api/invitations accept, /api/join)이 서버에서 만듭니다.

function studentAuthError(code?: string): string {
  switch (code) {
    case 'auth/email-already-in-use':
      return '이미 가입된 이메일이에요. 로그인해서 이어서 참여해 주세요.'
    case 'auth/invalid-email':
      return '이메일 형식이 올바르지 않아요.'
    case 'auth/weak-password':
      return '비밀번호는 6자 이상으로 만들어 주세요.'
    case 'auth/too-many-requests':
      return '시도가 너무 많았어요. 잠시 후 다시 해 주세요.'
    case 'auth/network-request-failed':
      return '인터넷 연결을 확인하고 다시 시도해 주세요.'
    default:
      return '가입 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.'
  }
}

export default function RegisterPage() {
  const hydrated = useHydrated()
  const router = useRouter()
  const { toast } = useUI()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [secretCode, setSecretCode] = useState('') // 인증 코드 상태
  
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  // 가입 뒤 돌아갈 곳(같은 사이트 상대 경로만) — 초대로 들어온 학생이면 학생 가입을 먼저 보여 줌
  const nextParam = safeNextPath(router.query.next)
  const safeNext = nextParam && !nextParam.startsWith('/auth/') ? nextParam : null
  const nextQuery = safeNext ? `?next=${encodeURIComponent(safeNext)}` : ''
  // undefined = 아직 읽지 않음(첫 렌더) — 학생에게 교사 가입 폼이 잠깐 보이지 않게 읽은 뒤에 그림
  const [pendingCode, setPendingCode] = useState<string | null | undefined>(undefined)
  const [kind, setKind] = useState<'teacher' | 'student'>('teacher')
  const [kindChosen, setKindChosen] = useState(false)
  useEffect(() => {
    setPendingCode(readPendingInvite())
  }, [])
  const nextIsInvite = !!safeNext && isInvitePath(safeNext)
  const inviteTarget = nextIsInvite ? safeNext : pendingCode ? invitePath(pendingCode) : null
  const inviteCode = nextIsInvite ? (safeNext!.startsWith('/i/') ? normalizeInviteCode(safeNext) : null) : pendingCode
  const ready = router.isReady && pendingCode !== undefined
  useEffect(() => {
    if (!ready || kindChosen) return
    setKind(inviteTarget ? 'student' : 'teacher')
  }, [ready, inviteTarget, kindChosen])
  const [kindSettled, setKindSettled] = useState(false)
  useEffect(() => {
    if (ready) setKindSettled(true)
  }, [ready])
  const chooseKind = (k: 'teacher' | 'student') => {
    setKindChosen(true)
    setKind(k)
    setError(null)
    setInfo(null)
  }

  // 학생 가입(초대로 들어온 경우)
  const [studentName, setStudentName] = useState('')
  const [studentLoading, setStudentLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const studentTarget = () => inviteTarget || '/dashboard'

  const onStudentSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const nm = studentName.trim()
    if (!nm) {
      setError('이름을 입력해 주세요.')
      return
    }
    if (!email.trim() || !password) {
      setError('이메일과 비밀번호를 입력해 주세요.')
      return
    }
    if (password.length < 6) {
      setError('비밀번호는 6자 이상으로 만들어 주세요.')
      return
    }
    setStudentLoading(true)
    try {
      const cred = await createUserWithEmailAndPassword(auth, email.trim(), password)
      // 초대 화면에서 이름을 미리 채우는 데만 씀(학생 프로필은 초대 수락 때 서버가 만듦)
      try {
        await updateProfile(cred.user, { displayName: nm.slice(0, 20) })
      } catch (err) {
        console.warn('updateProfile failed', err)
      }
      router.replace(studentTarget())
    } catch (err: any) {
      console.error(err)
      setError(studentAuthError(err?.code))
    } finally {
      setStudentLoading(false)
    }
  }

  const onStudentGoogle = async () => {
    setError(null)
    setGoogleLoading(true)
    try {
      const provider = new GoogleAuthProvider()
      provider.setCustomParameters({ prompt: 'select_account' })
      await signInWithPopup(auth, provider)
      router.replace(studentTarget())
    } catch (err: any) {
      const code = err?.code || ''
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        // 사용자가 창을 닫음 — 조용히 무시
      } else if (code === 'auth/popup-blocked') {
        setError('팝업이 차단됐어요. 브라우저에서 팝업을 허용해 주세요.')
      } else {
        console.error(err)
        setError('구글 로그인 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.')
      }
    } finally {
      setGoogleLoading(false)
    }
  }

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

    setLoading(true)

    // 2. 인증 코드 검사 (핵심!) — 서버에서 확인합니다. 코드가 클라이언트에 노출되지 않아요.
    try {
      const verifyRes = await fetch('/api/auth/verify-teacher-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: secretCode.trim() }),
      })
      const verify = await verifyRes.json().catch(() => ({ ok: false }))
      if (!verifyRes.ok || !verify?.ok) {
        // 가입 미개설(503)·시도 초과(429)는 서버 안내를 그대로 보여 줘요.
        const msg = verify?.error || '교사 인증 코드가 올바르지 않습니다. 관리자에게 문의하세요.'
        toast(msg, 'error')
        setError(msg)
        setLoading(false)
        return
      }
    } catch (e) {
      console.error('verify-teacher-code failed', e)
      toast('인증 코드 확인 중 문제가 발생했어요. 잠시 후 다시 시도해 주세요.', 'error')
      setLoading(false)
      return
    }

    // 교사 등록 전에 실패하면 방금 만든 Auth 계정을 지워야 같은 이메일로 다시 가입할 수 있어요.
    let created: User | null = null
    let roleGranted = false
    try {
      // 3. Firebase Auth 가입
      const cred = await createUserWithEmailAndPassword(auth, email, password)
      const user = cred.user
      created = user

      // 4. 교사 role 부여는 서버에서만 (보안 규칙상 클라이언트는 role을 쓸 수 없음)
      const idToken = await user.getIdToken()
      const signupRes = await fetch('/api/complete-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, code: secretCode.trim() }),
      })
      if (!signupRes.ok) {
        const d = await signupRes.json().catch(() => ({}))
        throw new Error(d?.error || '교사 등록에 실패했어요. 잠시 후 다시 시도해 주세요.')
      }
      roleGranted = true
      if (displayName) {
        try {
          const { db } = await import('../../lib/firebase')
          await setDoc(doc(db, 'users', user.uid), { displayName }, { merge: true })
        } catch (e) {
          console.warn('displayName write failed', e)
        }
        // 반 등록 때 담임 이름은 Auth 프로필의 displayName을 써요.
        try {
          await updateProfile(user, { displayName })
        } catch (e) {
          console.warn('updateProfile failed', e)
        }
      }

      // 5. 이메일 인증 발송 — 가입은 이미 끝났으니 발송 실패는 오류로 보여 주지 않아요.
      let mailSent = true
      try {
        await sendEmailVerification(user)
      } catch (e) {
        console.warn('sendEmailVerification failed', e)
        mailSent = false
      }
      // 이메일 인증 전에는 로그인 상태로 남기지 않아요(인증 후 로그인해야 대시보드에 들어갈 수 있게).
      try {
        await signOut(auth)
      } catch {}
      setInfo(
        mailSent
          ? '가입이 완료되었습니다! 인증 메일을 확인해 주세요. (잠시 후 로그인 페이지로 이동합니다)'
          : '가입은 완료됐어요. 다만 인증 메일을 보내지 못했어요. 로그인 화면에서 로그인한 뒤 "인증메일 다시 보내기"를 눌러 주세요. (잠시 후 로그인 페이지로 이동합니다)'
      )
      
      // 3초 후 로그인 페이지로 이동(돌아갈 곳 ?next 유지)
      setTimeout(() => {
        router.replace(`/auth/login${nextQuery}`)
      }, 3000)

    } catch (e: any) {
      console.error(e)
      if (created && !roleGranted) {
        try {
          await created.delete()
        } catch (delErr) {
          console.warn('rollback delete failed', delErr)
          try {
            await signOut(auth)
          } catch {}
        }
      }
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

  const errorBox = error && (
    <div className="rounded-md bg-red-50 p-4 border border-red-100" role="alert">
      <div className="flex">
        <div className="flex-shrink-0">
          <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
          </svg>
        </div>
        <div className="ml-3">
          <p className="text-sm font-medium text-red-800">{error}</p>
          {kind === 'student' && error.includes('이미 가입된') ? (
            <Link href={`/auth/login${nextQuery}`} className="mt-1 inline-flex min-h-[44px] items-center text-sm font-bold text-red-800 underline">
              로그인하러 가기
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  )

  const studentInput =
    'appearance-none block w-full min-h-[44px] px-4 py-3 border border-gray-300 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-emerald-500 focus:border-emerald-500 text-lg text-black'

  if (!kindSettled) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50" role="status" aria-label="불러오는 중">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600" aria-hidden="true"></div>
      </div>
    )
  }

  if (kind === 'student') {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col justify-center items-center py-12 px-4 sm:px-6 lg:px-8">
        <div className="w-full sm:max-w-lg">
          <h2 className="mt-6 text-center text-4xl font-extrabold text-gray-900">회원가입</h2>
          <p className="mt-3 text-center text-base text-gray-600">학생 계정 만들기 (받은 초대로 참여)</p>
        </div>

        <div className="mt-8 w-full sm:max-w-lg">
          <div className="bg-white py-8 px-5 shadow-xl rounded-2xl sm:px-12 border border-gray-100">
            <div className="rounded-xl bg-emerald-50 border border-emerald-100 p-4">
              <p className="text-sm font-bold text-emerald-900 break-keep">
                가입하면 받은 초대로 돌아가서 이어서 참여해요
                {inviteCode ? (
                  <>
                    {' '}
                    <span className="font-mono tracking-widest whitespace-nowrap">({formatInviteCode(inviteCode)})</span>
                  </>
                ) : null}
              </p>
              <p className="mt-1 text-xs text-emerald-800 break-keep">
                학생 정보(소속·수업)는 초대 화면에서 &lsquo;참여&rsquo;를 눌러야 등록돼요.
              </p>
            </div>

            <form className="mt-6 space-y-5" method="post" onSubmit={onStudentSubmit} noValidate>
              {errorBox}
              <div>
                <label htmlFor="student-name" className="block text-base font-medium text-gray-700 mb-1">
                  이름
                </label>
                <input
                  id="student-name"
                  type="text"
                  autoComplete="name"
                  maxLength={20}
                  required
                  className={studentInput}
                  value={studentName}
                  onChange={(e) => setStudentName(e.target.value)}
                  placeholder="홍길동"
                />
              </div>
              <div>
                <label htmlFor="student-email" className="block text-base font-medium text-gray-700 mb-1">
                  이메일
                </label>
                <input
                  id="student-email"
                  type="email"
                  autoComplete="email"
                  required
                  className={studentInput}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="student@example.com"
                />
              </div>
              <div>
                <label htmlFor="student-password" className="block text-base font-medium text-gray-700 mb-1">
                  비밀번호
                </label>
                <input
                  id="student-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  className={studentInput}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="6자 이상 입력"
                />
              </div>
              <button
                type="submit"
                disabled={!hydrated || studentLoading || googleLoading}
                className="w-full min-h-[44px] flex justify-center items-center py-3 px-4 border border-transparent rounded-xl shadow-sm text-lg font-bold text-white bg-emerald-600 hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {studentLoading ? '가입하는 중...' : '가입하고 초대로 돌아가기'}
              </button>
            </form>

            <div className="relative py-4">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-200"></div>
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="px-2 bg-white text-gray-400">또는</span>
              </div>
            </div>
            <button
              type="button"
              onClick={onStudentGoogle}
              disabled={studentLoading || googleLoading}
              className="w-full min-h-[44px] flex justify-center items-center gap-2 py-3 px-4 border border-gray-300 rounded-xl shadow-sm text-base font-bold text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 transition-colors"
            >
              {googleLoading ? '로그인 중...' : '구글 계정으로 계속하기'}
            </button>

            <div className="mt-6 space-y-1 text-center">
              <Link
                href={`/auth/login${nextQuery}`}
                className="inline-flex min-h-[44px] items-center font-medium text-emerald-700 hover:text-emerald-600 text-base"
              >
                이미 계정이 있어요 → 로그인
              </Link>
              <div>
                <button
                  type="button"
                  onClick={() => chooseKind('teacher')}
                  className="inline-flex min-h-[44px] items-center text-sm text-gray-500 hover:text-gray-700 underline"
                >
                  선생님이신가요? 교사 계정 만들기
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-center items-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="w-full sm:max-w-lg">
        <h2 className="mt-6 text-center text-4xl font-extrabold text-gray-900">
          회원가입
        </h2>
        <p className="mt-3 text-center text-base text-gray-600">
          선생님 계정 생성 (인증 코드 필요)
        </p>
      </div>

      <div className="mt-8 w-full sm:max-w-lg">
        {inviteTarget ? (
          <div className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-center">
            <button
              type="button"
              onClick={() => chooseKind('student')}
              className="inline-flex min-h-[44px] items-center text-sm font-bold text-emerald-800 underline"
            >
              학생이에요 — 학생 계정 만들기로 돌아가기
            </button>
          </div>
        ) : null}
        <div className="bg-white py-10 px-6 shadow-xl rounded-2xl sm:px-12 border border-gray-100">
          <form className="space-y-6" method="post" onSubmit={onSubmit}>
            
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
                disabled={!hydrated || loading}
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
              <Link href={`/auth/login${nextQuery}`} className="font-medium text-blue-600 hover:text-blue-500 text-base">
                로그인하러 가기
              </Link>
            </div>
          </div>
        </div>
        {!inviteTarget ? (
          <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
            <p className="text-sm font-bold text-emerald-900 break-keep">학생인가요? 학생은 초대 코드로 시작해요</p>
            <p className="mt-1 mb-3 text-xs text-emerald-800 break-keep">
              선생님께 받은 초대 코드(XXXX-XXXX)를 입력하면 초대 화면에서 학생 계정을 만들고 참여할 수 있어요.
            </p>
            <InviteCodeInput compact />
          </div>
        ) : null}
      </div>
    </div>
  )
}
