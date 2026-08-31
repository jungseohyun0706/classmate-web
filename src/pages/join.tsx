import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { auth } from '../lib/firebase'
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  type User,
} from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { useUI } from '../components/ui/feedback'

// 입장 검증·신청은 전부 서버(/api/join-info, /api/join)에서 처리 —
// 신규 계정은 보안 규칙상 학급/토큰 문서를 직접 읽을 수 없기 때문.
interface JoinClassInfo {
  classId: string
  schoolName: string
  grade: string | number
  classNm: string | number
  teacherName?: string
  isGroup?: boolean
}

function authErrorMessage(code?: string): string {
  switch (code) {
    case 'auth/email-already-in-use':
      return '이미 가입된 이메일이에요. 아래에서 로그인으로 바꿔 시도해 보세요.'
    case 'auth/invalid-email':
      return '이메일 형식이 올바르지 않아요.'
    case 'auth/weak-password':
      return '비밀번호는 6자 이상으로 만들어 주세요.'
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return '이메일 또는 비밀번호가 올바르지 않아요.'
    case 'auth/too-many-requests':
      return '시도가 너무 많았어요. 잠시 후 다시 해 주세요.'
    default:
      return '처리 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.'
  }
}

export default function JoinPage() {
  const router = useRouter()
  const { toast } = useUI()

  const classId = typeof router.query.c === 'string' ? router.query.c : ''
  const token = typeof router.query.t === 'string' ? router.query.t : ''

  const [checking, setChecking] = useState(true)
  const [invalid, setInvalid] = useState(false)
  const [classInfo, setClassInfo] = useState<JoinClassInfo | null>(null)

  const [user, setUser] = useState<User | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [joined, setJoined] = useState(false)

  const [mode, setMode] = useState<'signup' | 'login'>('signup')
  const [name, setName] = useState('')
  const [studentNo, setStudentNo] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // 토큰 검증 + 학급 정보 로드 (공개 페이지 — 로그인 가드 없음)
  useEffect(() => {
    if (!router.isReady) return
    if (!classId || !token) {
      setInvalid(true)
      setChecking(false)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/join-info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ classId, token }),
        })
        const data = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok || !data.classInfo) {
          setInvalid(true)
          return
        }
        setClassInfo(data.classInfo as JoinClassInfo)
      } catch (e) {
        console.error(e)
        if (!cancelled) setInvalid(true)
      } finally {
        if (!cancelled) setChecking(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [router.isReady, classId, token])

  // 로그인 상태 감지
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u)
      setAuthReady(true)
    })
    return () => unsub()
  }, [])

  // 기존 계정이면 이름/번호 미리 채우기
  useEffect(() => {
    if (!user) return
    let cancelled = false
    ;(async () => {
      try {
        const { db } = await import('../lib/firebase')
        const snap = await getDoc(doc(db, 'users', user.uid))
        if (cancelled) return
        if (snap.exists()) {
          const data = snap.data()
          setName((prev) => prev || String(data.name || data.displayName || user.displayName || ''))
          setStudentNo((prev) => prev || (data.studentId ? String(data.studentId) : ''))
        } else {
          // 구글로 방금 만든 계정 — 프로필 이름으로 미리 채움
          setName((prev) => prev || String(user.displayName || ''))
        }
      } catch (e) {
        console.error(e)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [user])

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault()
    if (mode === 'signup' && !name.trim()) {
      toast('이름을 입력해 주세요.', 'error')
      return
    }
    if (!email.trim() || !password) {
      toast('이메일과 비밀번호를 입력해 주세요.', 'error')
      return
    }
    setSubmitting(true)
    try {
      if (mode === 'signup') {
        // 학생은 이메일 인증 없이 바로 사용해요.
        await createUserWithEmailAndPassword(auth, email.trim(), password)
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password)
      }
      // onAuthStateChanged 가 확인 카드로 넘겨줍니다.
    } catch (err: any) {
      console.error(err)
      toast(authErrorMessage(err?.code), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleJoin = async () => {
    if (!name.trim()) {
      toast('이름을 입력해 주세요.', 'error')
      return
    }
    if (!auth.currentUser) return
    setSubmitting(true)
    try {
      const idToken = await auth.currentUser.getIdToken()
      const res = await fetch('/api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({
          classId,
          token,
          name: name.trim(),
          studentId: studentNo.trim() || undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast(data?.error || '입장 신청에 실패했어요. 잠시 후 다시 시도해 주세요.', 'error')
        return
      }
      if (data.status === 'approved') {
        toast('이미 우리 반 학생이에요!', 'success')
        router.replace('/student/today')
        return
      }
      if (data.status === 'joined-extra') {
        toast(data.already ? '이미 참여한 반이에요!' : '반 톡방에 참여했어요! 💬', 'success')
        router.replace(`/class-room?classId=${encodeURIComponent(classId)}`)
        return
      }
      setJoined(true)
      toast('입장 신청을 보냈어요.', 'success')
    } catch (err: any) {
      console.error(err)
      toast('입장 신청에 실패했어요. 잠시 후 다시 시도해 주세요.', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleGoogle = async () => {
    setSubmitting(true)
    try {
      const provider = new GoogleAuthProvider()
      provider.setCustomParameters({ prompt: 'select_account' })
      await signInWithPopup(auth, provider)
      // onAuthStateChanged 가 확인 카드로 넘겨줍니다.
    } catch (err: any) {
      const code = err?.code || ''
      if (code !== 'auth/popup-closed-by-user' && code !== 'auth/cancelled-popup-request') {
        console.error(err)
        toast('구글 로그인 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.', 'error')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleSwitchAccount = async () => {
    try {
      await signOut(auth)
      setName('')
      setStudentNo('')
    } catch (e) {
      console.error(e)
    }
  }

  const classLabel = classInfo
    ? `${classInfo.schoolName} ${classInfo.grade}학년 ${classInfo.classNm}반${classInfo.isGroup ? ' 수업' : ''}`
    : ''

  const inputClass =
    'appearance-none block w-full px-4 py-3 border border-gray-300 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-emerald-500 focus:border-emerald-500 text-base text-black'

  let content: React.ReactNode

  if (checking || (!invalid && !authReady)) {
    // 로딩
    content = (
      <div className="flex flex-col items-center py-16">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-emerald-600"></div>
        <p className="mt-4 text-sm text-gray-500">입장 코드를 확인하고 있어요...</p>
      </div>
    )
  } else if (invalid) {
    // (a) 만료/잘못된 토큰
    content = (
      <div className="bg-white shadow-xl rounded-2xl border border-gray-100 p-8 text-center">
        <div className="mx-auto w-16 h-16 rounded-full bg-red-50 flex items-center justify-center">
          <svg className="w-8 h-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h2 className="mt-4 text-xl font-bold text-gray-900">입장 코드를 사용할 수 없어요</h2>
        <p className="mt-2 text-sm text-gray-600 break-keep">
          코드가 만료되었거나 잘못되었어요. 입장 코드는 만들어진 뒤 10분 동안만 쓸 수 있어요.
        </p>
        <div className="mt-5 rounded-xl bg-emerald-50 border border-emerald-100 p-4">
          <p className="text-sm text-emerald-800 break-keep">
            선생님께 화면의 <span className="font-bold">&lsquo;새 코드 만들기&rsquo;</span>를 눌러 새 QR 코드를
            보여 달라고 요청한 뒤, 다시 스캔해 주세요.
          </p>
        </div>
      </div>
    )
  } else if (joined) {
    // 성공
    content = (
      <div className="bg-white shadow-xl rounded-2xl border border-gray-100 p-8 text-center">
        <div className="mx-auto w-16 h-16 rounded-full bg-emerald-50 flex items-center justify-center">
          <svg className="w-8 h-8 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h2 className="mt-4 text-xl font-bold text-gray-900">선생님 승인을 기다리고 있어요</h2>
        <p className="mt-2 text-sm text-gray-600 break-keep">
          {classLabel} 입장 신청을 보냈어요. 선생님이 승인하면 우리 반 소식과 시간표를 볼 수 있어요.
        </p>
        <button
          onClick={() => router.push('/student/today')}
          className="mt-6 w-full flex justify-center py-3 px-4 border border-transparent rounded-xl shadow-sm text-base font-bold text-white bg-emerald-600 hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-500 transition-colors"
        >
          오늘 화면 보러 가기 &rarr;
        </button>
      </div>
    )
  } else if (!user) {
    // (b) 미로그인 — 학생 가입/로그인
    content = (
      <div className="bg-white shadow-xl rounded-2xl border border-gray-100 p-6 sm:p-8">
        <div className="rounded-xl bg-emerald-50 border border-emerald-100 p-4 text-center">
          <p className="text-sm text-emerald-700 font-medium">입장할 반</p>
          <p className="mt-0.5 text-lg font-extrabold text-emerald-900 break-keep">{classLabel}</p>
        </div>

        <h2 className="mt-6 text-lg font-bold text-gray-900 text-center">
          {mode === 'signup' ? '학생 계정을 만들고 입장해요' : '내 계정으로 로그인해요'}
        </h2>

        <button
          type="button"
          onClick={handleGoogle}
          disabled={submitting}
          className="mt-5 w-full flex justify-center items-center gap-2 py-3 px-4 border border-gray-300 rounded-xl shadow-sm text-base font-bold text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0012 23z"/>
            <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 010-4.2V7.06H2.18a11 11 0 000 9.88l3.66-2.84z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 002.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/>
          </svg>
          구글 계정으로 계속하기
        </button>

        <div className="relative py-4">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-gray-200"></div>
          </div>
          <div className="relative flex justify-center text-xs">
            <span className="px-2 bg-white text-gray-400">또는 이메일로</span>
          </div>
        </div>

        <form className="space-y-4" onSubmit={handleAuth}>
          {mode === 'signup' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">이름</label>
              <input
                type="text"
                required
                className={inputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="홍길동"
              />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">이메일</label>
            <input
              type="email"
              required
              className={inputClass}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="student@example.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">비밀번호</label>
            <input
              type="password"
              required
              className={inputClass}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="6자 이상 입력"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full flex justify-center py-3 px-4 border border-transparent rounded-xl shadow-sm text-base font-bold text-white bg-emerald-600 hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {submitting
              ? '처리 중...'
              : mode === 'signup'
                ? '계정 만들고 계속하기'
                : '로그인하고 계속하기'}
          </button>
        </form>

        <button
          onClick={() => setMode(mode === 'signup' ? 'login' : 'signup')}
          className="mt-2 w-full py-3 text-center text-sm font-medium text-emerald-600 hover:text-emerald-500"
        >
          {mode === 'signup' ? '이미 계정이 있어요 → 로그인' : '처음이에요 → 계정 만들기'}
        </button>
      </div>
    )
  } else {
    // (c) 로그인됨 — 입장 확인 카드
    content = (
      <div className="bg-white shadow-xl rounded-2xl border border-gray-100 p-6 sm:p-8">
        <div className="text-center">
          <div className="mx-auto w-14 h-14 rounded-full bg-emerald-50 flex items-center justify-center">
            <svg className="w-7 h-7 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
          </div>
          <h2 className="mt-4 text-xl font-extrabold text-gray-900 break-keep">
            {classLabel}에 입장할까요?
          </h2>
          <p className="mt-1 text-sm text-gray-500">선생님이 승인하면 우리 반 학생이 돼요.</p>
        </div>

        <div className="mt-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">이름</label>
            <input
              type="text"
              required
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="홍길동"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">번호 (선택)</label>
            <input
              type="text"
              inputMode="numeric"
              className={inputClass}
              value={studentNo}
              onChange={(e) => setStudentNo(e.target.value)}
              placeholder="예: 12"
            />
          </div>
          <button
            onClick={handleJoin}
            disabled={submitting}
            className="w-full flex justify-center py-3 px-4 border border-transparent rounded-xl shadow-sm text-base font-bold text-white bg-emerald-600 hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? '신청 중...' : '입장 신청하기'}
          </button>
          <button
            onClick={handleSwitchAccount}
            className="w-full py-3 text-center text-sm font-medium text-gray-400 hover:text-gray-600"
          >
            다른 계정 사용하기
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-center py-10 px-4 sm:px-6">
      <div className="mx-auto w-full max-w-md">
        <div className="text-center mb-6">
          <span className="text-3xl font-extrabold text-emerald-600">Classmate</span>
          <p className="mt-1 text-sm text-gray-500">학급 입장</p>
        </div>
        {content}
      </div>
    </div>
  )
}
