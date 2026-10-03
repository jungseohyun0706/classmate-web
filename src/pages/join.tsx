import React, { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
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
import InviteCodeInput from '../components/InviteCodeInput'
import { useHydrated } from '../lib/useHydrated'

// 기존 QR 입장 링크 /join?c={classId}&t={token} (10분 토큰) — 경로·파라미터 유지(T42)
// 입장 검증·신청은 전부 서버(/api/join-info, /api/join)에서 처리 —
// 신규 계정은 보안 규칙상 학급/토큰 문서를 직접 읽을 수 없기 때문.
// - join-info 오류는 code로 구분해 보여 줌(형식 오류·없음·학급 없음·만료·시도 초과·서버 설정·서버 오류·네트워크).
//   원인을 모르는 오류(네트워크·5xx)를 '만료'로 보이지 않고 '다시 시도'를 줍니다.
// - 익명(둘러보기) 계정은 로그인 안 된 것으로 보고 가입·로그인 폼을 보여 줍니다.
// - 가입·로그인은 이 화면 안에서 끝납니다(같은 탭 — 토큰이 URL에만 있으므로 다른 화면으로 보내지 않음).
// 입장 토큰을 console에 남기지 않습니다.
interface JoinClassInfo {
  classId: string
  schoolName: string
  grade: string | number
  classNm: string | number
  teacherName?: string
  isGroup?: boolean
  /** 수업 그룹과 연결된 운영 중 수업 제목(있으면 입장 때 그 수업 수강도 함께 만들어짐) */
  courseTitle?: string
}

type InfoErrorKind =
  | 'bad-request'
  | 'not-found'
  | 'class-not-found'
  | 'expired'
  | 'rate-limited'
  | 'not-configured'
  | 'server'
  | 'network'

const TERMINAL_KINDS: InfoErrorKind[] = ['bad-request', 'not-found', 'class-not-found', 'expired']

const INFO_ERROR_TEXT: Record<InfoErrorKind, { title: string; body: string }> = {
  'bad-request': {
    title: '입장 링크가 올바르지 않아요',
    body: '링크 일부가 빠졌거나 잘못 복사됐어요. QR을 다시 찍거나 선생님께 받은 링크 전체를 열어 주세요.',
  },
  'not-found': {
    title: '입장 코드를 찾을 수 없어요',
    body: '선생님이 새 코드를 만들었거나 잘못된 링크예요. 선생님께 지금 화면의 QR을 다시 보여 달라고 요청해 주세요.',
  },
  'class-not-found': {
    title: '학급 정보를 찾을 수 없어요',
    body: '이 링크의 학급이 더 이상 없어요. 선생님께 새 QR이나 초대 코드를 요청해 주세요.',
  },
  expired: {
    title: '입장 코드가 만료되었어요',
    body: '입장 코드는 만들어진 뒤 10분 동안만 쓸 수 있어요.',
  },
  'rate-limited': {
    title: '시도가 너무 많아요',
    body: '잠시 후 다시 시도해 주세요.',
  },
  'not-configured': {
    title: '지금은 입장 코드를 확인할 수 없어요',
    body: '서버 설정 문제로 확인하지 못했어요. 잠시 후 다시 시도해 주세요.',
  },
  server: {
    title: '입장 코드를 확인하지 못했어요',
    body: '서버에서 문제가 생겼어요. 잠시 후 다시 시도해 주세요.',
  },
  network: {
    title: '입장 코드를 확인하지 못했어요',
    body: '인터넷 연결을 확인하고 다시 시도해 주세요.',
  },
}

function infoErrorKind(status: number, code: string | null): InfoErrorKind {
  if (status === 400) return 'bad-request'
  if (status === 404) return code === 'class-not-found' ? 'class-not-found' : 'not-found'
  if (status === 410) return 'expired'
  if (status === 429) return 'rate-limited'
  if (status === 503) return 'not-configured'
  return 'server'
}

/** /api/join 오류 code → 안내 문구 */
const JOIN_ERROR_TEXT: Record<string, string> = {
  'name-required': '이름을 입력해 주세요.',
  unauthenticated: '로그인이 만료됐어요. 다시 로그인해 주세요.',
  anonymous: '둘러보기(익명) 계정으로는 입장할 수 없어요. 학생 계정을 만들거나 로그인해 주세요.',
  'teacher-account': '교사 계정으로는 학생 입장을 할 수 없어요. 학생 계정으로 로그인해 주세요.',
  'not-student': '학생 계정에서만 입장할 수 있어요. 학생 계정으로 로그인해 주세요.',
  'other-school': '다른 학교 반이에요. 지금 계정은 다른 학교에 등록되어 있어요. 전학했다면 지금 학교 선생님께 문의해 주세요.',
  'rate-limited': '시도가 너무 많아요. 잠시 후 다시 시도해 주세요.',
  'not-configured': '서버 설정 문제로 지금은 입장할 수 없어요. 잠시 후 다시 시도해 주세요.',
}

interface JoinResult {
  status: string
  already: boolean
  courses: Array<{ title: string; status: string }>
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
    case 'auth/network-request-failed':
      return '인터넷 연결을 확인하고 다시 시도해 주세요.'
    default:
      return '처리 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.'
  }
}

const primaryBtn =
  'w-full min-h-[44px] flex justify-center items-center py-3 px-4 border border-transparent rounded-xl shadow-sm text-base font-bold text-white bg-emerald-600 hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors'
const secondaryBtn =
  'w-full min-h-[44px] flex justify-center items-center py-3 px-4 border border-gray-300 rounded-xl text-base font-bold text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-500 disabled:opacity-50 transition-colors'

export default function JoinPage() {
  const hydrated = useHydrated()
  const router = useRouter()
  const { toast } = useUI()

  const classId = typeof router.query.c === 'string' ? router.query.c : ''
  const token = typeof router.query.t === 'string' ? router.query.t : ''

  const [checking, setChecking] = useState(true)
  const [infoError, setInfoError] = useState<InfoErrorKind | null>(null)
  const [classInfo, setClassInfo] = useState<JoinClassInfo | null>(null)
  const infoSeq = useRef(0)

  const [user, setUser] = useState<User | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [result, setResult] = useState<JoinResult | null>(null)
  const [joinError, setJoinError] = useState<string | null>(null)
  // 신청하는 사이 토큰이 만료되는 등 — 계정은 이미 만들어졌을 수 있음을 함께 안내
  const [lateFailure, setLateFailure] = useState(false)

  const [mode, setMode] = useState<'signup' | 'login'>('signup')
  const [name, setName] = useState('')
  const [studentNo, setStudentNo] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const nameRef = useRef<HTMLInputElement | null>(null)

  // 익명(둘러보기) 계정은 입장할 수 없음 → 로그인 안 된 것으로 보고 가입·로그인 폼
  const loggedIn = !!user && !user.isAnonymous

  // 토큰 검증 + 학급 정보 로드 (공개 페이지 — 로그인 가드 없음)
  const loadInfo = useCallback(async () => {
    const seq = ++infoSeq.current
    setChecking(true)
    setInfoError(null)
    try {
      const res = await fetch('/api/join-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classId, token }),
      })
      const data = await res.json().catch(() => null)
      if (seq !== infoSeq.current) return
      if (res.ok && data && data.classInfo) {
        setClassInfo(data.classInfo as JoinClassInfo)
        return
      }
      setInfoError(infoErrorKind(res.status, data && typeof data.code === 'string' ? data.code : null))
    } catch {
      if (seq === infoSeq.current) setInfoError('network')
    } finally {
      if (seq === infoSeq.current) setChecking(false)
    }
  }, [classId, token])

  useEffect(() => {
    if (!router.isReady) return
    if (!classId || !token) {
      setInfoError('bad-request')
      setChecking(false)
      return
    }
    loadInfo()
  }, [router.isReady, classId, token, loadInfo])

  // 로그인 상태 감지
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u)
      setAuthReady(true)
    })
    return () => unsub()
  }, [])

  // 기존 계정이면 이름/번호 미리 채우기
  const uid = loggedIn && user ? user.uid : null
  useEffect(() => {
    if (!uid || !user) return
    let cancelled = false
    ;(async () => {
      try {
        const { db } = await import('../lib/firebase')
        const snap = await getDoc(doc(db, 'users', uid))
        if (cancelled) return
        if (snap.exists()) {
          const data = snap.data()
          setName((prev) => prev || String(data.name || data.displayName || user.displayName || ''))
          setStudentNo((prev) => prev || (data.studentId ? String(data.studentId) : ''))
        } else {
          // 구글로 방금 만든 계정 — 프로필 이름으로 미리 채움
          setName((prev) => prev || String(user.displayName || ''))
        }
      } catch {
        // 미리 채우기 실패는 무시(직접 입력)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid])

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
        // 학생은 이메일 인증 없이 바로 사용해요. (둘러보기 익명 계정이면 새 계정으로 바뀜)
        await createUserWithEmailAndPassword(auth, email.trim(), password)
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password)
      }
      // onAuthStateChanged 가 확인 카드로 넘겨줍니다.
    } catch (err: any) {
      toast(authErrorMessage(err?.code), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleJoin = async () => {
    if (submittingRef.current) return
    if (!name.trim()) {
      setJoinError('이름을 입력해 주세요.')
      nameRef.current?.focus()
      return
    }
    const u = auth.currentUser
    if (!u || u.isAnonymous) return
    submittingRef.current = true
    setSubmitting(true)
    setJoinError(null)
    try {
      const idToken = await u.getIdToken()
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
      const data = await res.json().catch(() => null)
      if (res.ok && data && data.ok) {
        const courses = Array.isArray(data.courses)
          ? (data.courses as Array<Record<string, unknown>>).map((c) => ({
              title: typeof c.title === 'string' ? c.title : '수업',
              status: typeof c.status === 'string' ? c.status : '',
            }))
          : []
        setResult({ status: String(data.status || ''), already: data.already === true, courses })
        return
      }
      const code = data && typeof data.code === 'string' ? data.code : ''
      if (res.status === 404 || res.status === 410 || code === 'bad-request') {
        // 화면을 연 뒤 10분이 지나는 등 — 만료/없음 카드로 바꾸고 계정은 그대로 쓸 수 있음을 안내
        setLateFailure(true)
        setInfoError(code === 'bad-request' ? 'bad-request' : infoErrorKind(res.status, code))
        return
      }
      if (code === 'unauthenticated') {
        try {
          await signOut(auth)
        } catch {}
        toast(JOIN_ERROR_TEXT.unauthenticated, 'error')
        return
      }
      if (code === 'name-required') nameRef.current?.focus()
      const msg = JOIN_ERROR_TEXT[code] || (res.status === 429 ? JOIN_ERROR_TEXT['rate-limited'] : null)
      setJoinError(msg || `입장 신청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요. (오류 ${res.status})`)
    } catch {
      setJoinError('서버에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요. 다시 눌러도 두 번 신청되지 않아요.')
    } finally {
      submittingRef.current = false
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
      setJoinError(null)
      setResult(null)
    } catch {
      toast('로그아웃하지 못했어요. 잠시 후 다시 시도해 주세요.', 'error')
    }
  }

  const isGroup = classInfo?.isGroup === true
  const gradeClass = classInfo ? `${classInfo.grade}학년 ${classInfo.classNm}반` : ''
  // 수업 그룹이면 연결된 수업 제목을 먼저(없으면 예전처럼 '학년 반 수업')
  const targetTitle = classInfo
    ? isGroup
      ? classInfo.courseTitle
        ? `${classInfo.courseTitle} 수업`
        : `${gradeClass} 수업`
      : gradeClass
    : ''
  const classLabel = classInfo ? `${classInfo.schoolName} ${targetTitle}`.trim() : ''

  const inputClass =
    'appearance-none block w-full min-h-[44px] px-4 py-3 border border-gray-300 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-emerald-500 focus:border-emerald-500 text-base text-black'

  const targetCard = classInfo ? (
    <div className="rounded-xl bg-emerald-50 border border-emerald-100 p-4 text-center">
      <p className="text-sm text-emerald-700 font-medium">{isGroup ? '참여할 수업' : '입장할 반'}</p>
      <p className="mt-0.5 text-lg font-extrabold text-emerald-900 break-words">{targetTitle}</p>
      <p className="mt-0.5 text-sm text-emerald-800 break-keep">
        {classInfo.schoolName}
        {classInfo.teacherName ? ` · ${classInfo.teacherName} 선생님` : ''}
      </p>
      {isGroup && classInfo.courseTitle ? (
        <p className="mt-1 text-xs text-emerald-700 break-keep">{gradeClass} 수업 그룹</p>
      ) : null}
    </div>
  ) : null

  let content: React.ReactNode

  if (checking || (!infoError && !authReady)) {
    // 로딩
    content = (
      <div className="flex flex-col items-center py-16" role="status">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-emerald-600" aria-hidden="true"></div>
        <p className="mt-4 text-sm text-gray-500">입장 코드를 확인하고 있어요...</p>
      </div>
    )
  } else if (infoError) {
    const t = INFO_ERROR_TEXT[infoError]
    const terminal = TERMINAL_KINDS.includes(infoError)
    content = (
      <div className="bg-white shadow-xl rounded-2xl border border-gray-100 p-6 sm:p-8 text-center" role="alert">
        <div className="mx-auto w-16 h-16 rounded-full bg-red-50 flex items-center justify-center">
          <svg className="w-8 h-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h2 className="mt-4 text-xl font-bold text-gray-900 break-keep">{t.title}</h2>
        <p className="mt-2 text-sm text-gray-600 break-keep">{t.body}</p>
        {terminal ? (
          <>
            <div className="mt-5 rounded-xl bg-emerald-50 border border-emerald-100 p-4">
              <p className="text-sm text-emerald-800 break-keep">
                선생님께 화면의 <span className="font-bold">&lsquo;새 코드 만들기&rsquo;</span>를 눌러 새 QR 코드를
                보여 달라고 요청한 뒤, 다시 스캔해 주세요.
              </p>
            </div>
            {lateFailure && loggedIn ? (
              <p className="mt-3 text-sm text-gray-600 break-keep">
                계정은 그대로 있어요. 새 QR을 찍거나 초대 코드를 입력하면 이 계정으로 이어서 참여할 수 있어요.
              </p>
            ) : null}
            <div className="mt-5 text-left">
              <p className="mb-2 text-sm text-gray-600 break-keep">선생님께 받은 초대 코드(XXXX-XXXX)가 있다면 입력해 주세요.</p>
              <InviteCodeInput compact />
            </div>
          </>
        ) : (
          <button type="button" onClick={loadInfo} className={`mt-5 ${primaryBtn}`}>
            다시 시도
          </button>
        )}
      </div>
    )
  } else if (result) {
    const hasCourses = result.courses.length > 0
    const courseNames = result.courses.map((c) => c.title).join(', ')
    let title = ''
    let body = ''
    let waiting = false
    if (result.status === 'approved') {
      title = '이미 우리 반 학생이에요'
      body = `${classLabel}에 이미 등록되어 있어요.`
    } else if (result.status === 'move-pending') {
      title = result.already ? '이미 이 반으로 이동 신청 중이에요' : '반 이동 신청을 보냈어요'
      body = '새 담임 선생님이 승인하면 반이 바뀌어요. 그때까지는 지금 반을 그대로 쓸 수 있어요.'
      waiting = true
    } else if (result.status === 'joined-extra') {
      title = result.already ? '이미 참여한 수업이에요' : `${targetTitle}에 참여했어요`
      body = '원래 소속 학급은 그대로예요.'
    } else if (result.status === 'joined-extra-pending') {
      title = result.already ? '이미 참여한 수업이에요' : `${targetTitle}에 참여했어요`
      body = '먼저 신청한 소속 학급은 그대로 담임 선생님 승인을 기다리고 있어요. 이 수업은 따로 추가됐어요.'
      waiting = true
    } else {
      // pending: 새 입장 신청(또는 같은 반 재신청)
      title = result.already ? '이미 입장 신청을 했어요' : '선생님 승인을 기다리고 있어요'
      body = isGroup
        ? `${classLabel} 참여를 신청했어요. 선생님이 승인하면 우리 반 소식을 볼 수 있어요.`
        : `${classLabel} 입장 신청을 보냈어요. 선생님이 승인하면 우리 반 소식과 시간표를 볼 수 있어요.`
      waiting = true
    }
    content = (
      <div className="bg-white shadow-xl rounded-2xl border border-gray-100 p-6 sm:p-8 text-center" role="status">
        <div className={`mx-auto w-16 h-16 rounded-full flex items-center justify-center ${waiting ? 'bg-amber-50' : 'bg-emerald-50'}`}>
          <span className="text-2xl" aria-hidden="true">
            {waiting ? '⏳' : '✓'}
          </span>
        </div>
        <p className="mt-3 text-xs font-bold text-gray-500">{waiting ? '승인 대기' : '참여 완료'}</p>
        <h2 className="mt-1 text-xl font-bold text-gray-900 break-words">{title}</h2>
        {result.status === 'move-pending' ? (
          <p className="mt-1 text-sm font-medium text-emerald-700 break-keep">{classLabel}</p>
        ) : null}
        <p className="mt-2 text-sm text-gray-600 break-keep">{body}</p>
        {hasCourses ? (
          <p className="mt-3 rounded-lg bg-blue-50 border border-blue-100 px-3 py-2 text-sm text-blue-900 break-words">
            내 시간표에 추가된 수업: <b>{courseNames}</b>
          </p>
        ) : null}
        <div className="mt-6 space-y-3">
          {hasCourses ? (
            <Link href="/student/timetable" className={primaryBtn}>
              내 시간표 보기
            </Link>
          ) : null}
          {result.status === 'joined-extra' && !hasCourses ? (
            <Link href={`/class-room?classId=${encodeURIComponent(classId)}`} className={primaryBtn}>
              수업 톡방 열기
            </Link>
          ) : null}
          <Link href="/student/today" className={hasCourses || result.status === 'joined-extra' ? secondaryBtn : primaryBtn}>
            오늘 화면 보러 가기 &rarr;
          </Link>
        </div>
      </div>
    )
  } else if (!loggedIn) {
    // (b) 미로그인(또는 익명) — 학생 가입/로그인
    content = (
      <div className="bg-white shadow-xl rounded-2xl border border-gray-100 p-6 sm:p-8">
        {targetCard}

        <h2 className="mt-6 text-lg font-bold text-gray-900 text-center">
          {mode === 'signup' ? '학생 계정을 만들고 입장해요' : '내 계정으로 로그인해요'}
        </h2>
        {user?.isAnonymous ? (
          <p className="mt-2 rounded-lg bg-amber-50 border border-amber-100 px-3 py-2 text-sm text-amber-900 break-keep">
            지금은 둘러보기(익명) 상태라 입장할 수 없어요. 학생 계정을 만들거나 로그인해 주세요.
          </p>
        ) : null}

        <button
          type="button"
          onClick={handleGoogle}
          disabled={submitting}
          className="mt-5 w-full min-h-[44px] flex justify-center items-center gap-2 py-3 px-4 border border-gray-300 rounded-xl shadow-sm text-base font-bold text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 transition-colors"
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

        <form className="space-y-4" method="post" onSubmit={handleAuth}>
          {mode === 'signup' && (
            <div>
              <label htmlFor="join-signup-name" className="block text-sm font-medium text-gray-700 mb-1">
                이름
              </label>
              <input
                id="join-signup-name"
                type="text"
                required
                maxLength={20}
                autoComplete="name"
                className={inputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="홍길동"
              />
            </div>
          )}
          <div>
            <label htmlFor="join-email" className="block text-sm font-medium text-gray-700 mb-1">
              이메일
            </label>
            <input
              id="join-email"
              type="email"
              required
              autoComplete="email"
              className={inputClass}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="student@example.com"
            />
          </div>
          <div>
            <label htmlFor="join-password" className="block text-sm font-medium text-gray-700 mb-1">
              비밀번호
            </label>
            <input
              id="join-password"
              type="password"
              required
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              className={inputClass}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="6자 이상 입력"
            />
          </div>
          <button type="submit" disabled={!hydrated || submitting} className={primaryBtn}>
            {submitting
              ? '처리 중...'
              : mode === 'signup'
                ? '계정 만들고 계속하기'
                : '로그인하고 계속하기'}
          </button>
        </form>

        <button
          type="button"
          onClick={() => setMode(mode === 'signup' ? 'login' : 'signup')}
          className="mt-2 w-full min-h-[44px] py-3 text-center text-sm font-medium text-emerald-600 hover:text-emerald-500"
        >
          {mode === 'signup' ? '이미 계정이 있어요 → 로그인' : '처음이에요 → 계정 만들기'}
        </button>
      </div>
    )
  } else {
    // (c) 로그인됨 — 입장 확인 카드
    content = (
      <div className="bg-white shadow-xl rounded-2xl border border-gray-100 p-6 sm:p-8">
        {targetCard}
        <div className="mt-5 text-center">
          <h2 className="text-xl font-extrabold text-gray-900 break-words">
            {isGroup ? `${targetTitle}에 참여할까요?` : `${classLabel}에 입장할까요?`}
          </h2>
          <p className="mt-1 text-sm text-gray-500 break-keep">
            {isGroup
              ? '이미 소속 학급이 있다면 그대로 유지되고, 이 수업만 추가돼요.'
              : '선생님이 승인하면 우리 반 학생이 돼요.'}
          </p>
        </div>

        <div className="mt-4 rounded-lg bg-gray-50 border border-gray-100 px-3 py-2 text-sm text-gray-700">
          <span className="text-gray-500">신청할 계정 </span>
          <span className="font-bold break-all">{user?.email || '이메일이 없는 계정'}</span>
        </div>

        <div className="mt-5 space-y-4">
          <div>
            <label htmlFor="join-name" className="block text-sm font-medium text-gray-700 mb-1">
              이름
            </label>
            <input
              id="join-name"
              ref={nameRef}
              type="text"
              required
              maxLength={20}
              autoComplete="name"
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="홍길동"
            />
          </div>
          <div>
            <label htmlFor="join-no" className="block text-sm font-medium text-gray-700 mb-1">
              번호 (선택)
            </label>
            <input
              id="join-no"
              type="text"
              inputMode="numeric"
              maxLength={10}
              className={inputClass}
              value={studentNo}
              onChange={(e) => setStudentNo(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="예: 12"
            />
          </div>
          {joinError ? (
            <p className="rounded-lg bg-red-50 border border-red-100 px-3 py-2 text-sm text-red-700 break-keep" role="alert">
              <span aria-hidden="true">⚠️ </span>
              {joinError}
            </p>
          ) : null}
          <button type="button" onClick={handleJoin} disabled={submitting} className={primaryBtn}>
            {submitting ? '신청 중...' : '입장 신청하기'}
          </button>
          <button
            type="button"
            onClick={handleSwitchAccount}
            className="w-full min-h-[44px] py-3 text-center text-sm font-medium text-gray-500 hover:text-gray-700"
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
          <p className="mt-1 text-sm text-gray-500">{isGroup ? '수업 참여' : '학급 입장'}</p>
        </div>
        {content}
      </div>
    </div>
  )
}
