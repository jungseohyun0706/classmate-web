import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { onAuthStateChanged, signOut, type User } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth } from '../../lib/firebase'
import { useInstallPrompt } from '../../components/ui/install'
import InviteCodeInput from '../../components/InviteCodeInput'
import {
  clearPendingInvite,
  formatInviteCode,
  invitePath,
  normalizeInviteCode,
  readPendingInvite,
  safeNextPath,
  savePendingInvite,
} from '../../lib/pendingInvite'

// 초대 코드 화면 /i/{code}
// 1) 로그인 없이 /api/invitations preview로 최소 정보(학교·대상·교사·초대 종류)를 먼저 보여 줍니다.
// 2) 로그인 안 됨·익명(둘러보기) 계정 → 초대 코드를 보관하고 로그인/가입으로(돌아올 곳 ?next=/i/{code}).
// 3) 로그인됨 → 지금 계정을 보여 주고 '이 계정으로 참여'(accept) 또는 '다른 계정으로'(로그아웃 후 같은 화면).
// 4) 결과(참여 완료·승인 대기·이미 참여)와 오류(code별)를 구분해 안내합니다.
//    원인을 모르는 오류(네트워크·5xx)는 '만료'나 '없음'으로 보이지 않고 '다시 시도'를 줍니다.
// 학생 명단·uid 등 내부 값은 받지도 보여 주지도 않습니다. 초대 코드를 console에 남기지 않습니다.

type InviteType = 'homeroom' | 'course'
type BadState = 'expired' | 'revoked' | 'used-up' | 'ended' | 'not-found' | 'bad-code'

interface InviteInfo {
  type: InviteType | null
  schoolName: string
  targetLabel: string
  teacherName: string
  termName: string
  expiresAt: number | null
}

type PreviewState =
  | { kind: 'loading' }
  | { kind: 'ok'; info: InviteInfo }
  | { kind: 'invalid'; state: BadState; info: InviteInfo | null }
  | { kind: 'rate-limited' }
  | { kind: 'error'; status: number | null; code: string | null }

interface AcceptResult {
  type: InviteType
  status: string
  enrollmentStatus: string
  homeroomStatus: string
  courseTitle: string
  targetLabel: string
  profileCreated: boolean
  next: string
}

interface AcceptError {
  code: string
  title: string
  message: string
}

interface Profile {
  /** 'none' = users 문서 없음(가입 직후), 'unknown' = 읽지 못함 */
  role: 'student' | 'teacher' | 'other' | 'none' | 'unknown'
  name: string
}

const BAD_STATES: BadState[] = ['expired', 'revoked', 'used-up', 'ended', 'not-found', 'bad-code']

const BAD_STATE_TEXT: Record<BadState, { title: string; body: string }> = {
  expired: {
    title: '초대 기간이 지났어요',
    body: '이 초대 코드는 사용할 수 있는 기간이 끝났어요.',
  },
  revoked: {
    title: '선생님이 회수한 초대예요',
    body: '선생님이 이 초대 코드를 더 이상 쓰지 않도록 거둬들였어요.',
  },
  'used-up': {
    title: '참여 인원이 모두 찼어요',
    body: '이 초대 코드로 참여할 수 있는 인원이 다 찼어요.',
  },
  ended: {
    title: '이미 끝난 수업의 초대예요',
    body: '수업이 끝났거나 지난 학기의 초대라서 참여할 수 없어요.',
  },
  'not-found': {
    title: '초대 코드를 찾을 수 없어요',
    body: '코드를 잘못 입력했거나 없는 초대예요. 받은 코드를 다시 확인해 주세요.',
  },
  'bad-code': {
    title: '초대 코드 형식이 올바르지 않아요',
    body: '초대 코드는 XXXX-XXXX 모양의 8자리예요. 링크나 코드를 다시 확인해 주세요.',
  },
}

const ACCEPT_ERROR_TEXT: Record<string, { title: string; message: string }> = {
  'teacher-account': {
    title: '교사 계정은 학생 초대를 수락할 수 없어요',
    message: '학생 계정으로 다시 로그인한 뒤 참여해 주세요.',
  },
  'not-student': {
    title: '학생 계정에서만 참여할 수 있어요',
    message: '지금 계정은 학생 계정이 아니에요. 학생 계정으로 다시 로그인해 주세요.',
  },
  'other-school': {
    title: '다른 학교의 초대예요',
    message: '지금 계정은 다른 학교에 등록되어 있어요. 전학했다면 지금 학교 선생님께 문의하고, 계정을 잘못 골랐다면 다른 계정으로 로그인해 주세요.',
  },
  anonymous: {
    title: '둘러보기 상태에서는 참여할 수 없어요',
    message: '로그인하거나 새로 가입한 뒤 참여해 주세요.',
  },
  unauthenticated: {
    title: '로그인이 필요해요',
    message: '로그인이 끝났거나 만료됐어요. 다시 로그인하면 이 초대로 돌아와요.',
  },
  'name-required': {
    title: '이름이 필요해요',
    message: '이 초대로 참여하려면 이름이 필요해요. 이름을 입력하고 다시 눌러 주세요.',
  },
  'rate-limited': {
    title: '시도가 너무 많아요',
    message: '잠시 후 다시 시도해 주세요.',
  },
  'not-configured': {
    title: '지금은 참여할 수 없어요',
    message: '서버 설정 문제로 처리하지 못했어요. 잠시 후 다시 시도해 주세요.',
  },
}

/** 계정과 관련된 오류(다른 계정으로 바꾸면 해결될 수 있음) */
const ACCOUNT_ERRORS = ['teacher-account', 'not-student', 'other-school']

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function parseInfo(d: Record<string, unknown> | null): InviteInfo | null {
  if (!d) return null
  const type = d.type === 'course' ? 'course' : d.type === 'homeroom' ? 'homeroom' : null
  const info: InviteInfo = {
    type,
    schoolName: str(d.schoolName),
    targetLabel: str(d.targetLabel),
    teacherName: str(d.teacherName),
    termName: str(d.termName),
    expiresAt: typeof d.expiresAt === 'number' && Number.isFinite(d.expiresAt) ? d.expiresAt : null,
  }
  return info.type || info.schoolName || info.targetLabel ? info : null
}

function isBadState(v: unknown): v is BadState {
  return typeof v === 'string' && (BAD_STATES as string[]).includes(v)
}

function formatUntil(ms: number): string {
  try {
    return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(ms))
  } catch {
    return ''
  }
}

function parseResult(d: Record<string, unknown>): AcceptResult {
  const type: InviteType = d.type === 'homeroom' ? 'homeroom' : 'course'
  return {
    type,
    status: str(d.status),
    enrollmentStatus: str(d.enrollmentStatus),
    homeroomStatus: str(d.homeroomStatus),
    courseTitle: str(d.courseTitle),
    targetLabel: str(d.targetLabel),
    profileCreated: d.profileCreated === true,
    next: safeNextPath(d.next) || (type === 'course' ? '/student/timetable' : '/student/today'),
  }
}

function resultText(r: AcceptResult, info: InviteInfo | null): { title: string; body: string; cta: string; waiting: boolean } {
  if (r.type === 'course') {
    const title = r.courseTitle || info?.targetLabel || '이'
    if (r.status === 'enrolled') {
      return {
        title: `${title} 수업이 내 시간표에 추가됐어요`,
        body: '원래 소속 학급은 그대로예요. 내 시간표에서 이 수업을 확인해 보세요.',
        cta: '내 시간표 보기',
        waiting: false,
      }
    }
    if (r.status === 'pending') {
      return {
        title: `${title} 수업 참여를 신청했어요`,
        body: '담당 선생님이 승인하면 내 시간표에 추가돼요. 원래 소속 학급은 그대로예요.',
        cta: '내 시간표 보기',
        waiting: true,
      }
    }
    if (r.enrollmentStatus === 'pending') {
      return {
        title: '이미 참여를 신청한 수업이에요',
        body: `${title} 수업은 담당 선생님 승인을 기다리고 있어요.`,
        cta: '내 시간표 보기',
        waiting: true,
      }
    }
    return {
      title: '이미 참여 중인 수업이에요',
      body: `${title} 수업은 이미 내 시간표에 있어요.`,
      cta: '내 시간표 보기',
      waiting: false,
    }
  }
  const label = r.targetLabel || info?.targetLabel || '학급'
  if (r.status === 'homeroom-pending') {
    return {
      title: `${label} 등록을 신청했어요`,
      body: '담임 선생님이 승인하면 이 반이 내 소속 학급으로 등록돼요.',
      cta: '오늘 화면 보기',
      waiting: true,
    }
  }
  if (r.status === 'move-pending') {
    return {
      title: '반 이동 신청을 보냈어요',
      body: `새 담임 선생님이 승인하면 ${label}(으)로 바뀌어요. 그때까지는 지금 반을 그대로 써요.`,
      cta: '오늘 화면 보기',
      waiting: true,
    }
  }
  if (r.status === 'already') {
    if (r.homeroomStatus === 'approved') {
      return { title: '이미 이 반 학생이에요', body: `${label}은(는) 이미 내 소속 학급이에요.`, cta: '오늘 화면 보기', waiting: false }
    }
    if (r.homeroomStatus === 'move-pending') {
      return {
        title: '이미 이 반으로 이동 신청 중이에요',
        body: '새 담임 선생님 승인을 기다리고 있어요. 그때까지는 지금 반을 그대로 써요.',
        cta: '오늘 화면 보기',
        waiting: true,
      }
    }
    if (r.homeroomStatus === 'pending') {
      return { title: '이미 등록을 신청했어요', body: `${label} 담임 선생님 승인을 기다리고 있어요.`, cta: '오늘 화면 보기', waiting: true }
    }
    return { title: '이미 참여했어요', body: `${label}에 이미 참여한 상태예요.`, cta: '오늘 화면 보기', waiting: false }
  }
  return { title: '참여했어요', body: `${label}에 참여했어요.`, cta: '오늘 화면 보기', waiting: false }
}

const inputClass =
  'appearance-none block w-full min-h-[44px] px-4 py-3 border border-gray-300 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-emerald-500 focus:border-emerald-500 text-base text-black'
const primaryBtn =
  'w-full min-h-[44px] flex justify-center items-center py-3 px-4 border border-transparent rounded-xl shadow-sm text-base font-bold text-white bg-emerald-600 hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors'
const secondaryBtn =
  'w-full min-h-[44px] flex justify-center items-center py-3 px-4 border border-gray-300 rounded-xl text-base font-bold text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-500 disabled:opacity-50 transition-colors'

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center py-10" role="status" aria-live="polite">
      <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600" aria-hidden="true"></div>
      <p className="mt-3 text-sm text-gray-500">{label}</p>
    </div>
  )
}

/** 초대 정보 카드 — 화면 맨 위에 둬서 설치 안내 등에 묻히지 않게 */
function InviteCard({ info, code, dimmed }: { info: InviteInfo | null; code: string | null; dimmed?: boolean }) {
  const type = info?.type || null
  const until = info?.expiresAt ? formatUntil(info.expiresAt) : ''
  return (
    <section
      aria-label="초대 정보"
      className={`bg-white shadow-xl rounded-2xl border border-gray-100 p-5 sm:p-6 ${dimmed ? 'opacity-90' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {type === 'course' ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 border border-blue-100 px-2.5 py-1 text-xs font-bold text-blue-700">
            <span aria-hidden="true">📘</span> 수업 초대
          </span>
        ) : type === 'homeroom' ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 border border-emerald-100 px-2.5 py-1 text-xs font-bold text-emerald-700">
            <span aria-hidden="true">🏫</span> 학급 초대
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-bold text-gray-600">초대</span>
        )}
        {info?.schoolName ? <span className="min-w-0 text-sm text-gray-600 break-keep">{info.schoolName}</span> : null}
      </div>

      {info?.targetLabel ? (
        <h1 className="mt-3 text-2xl font-extrabold text-gray-900 break-words">
          {info.targetLabel}
          {type === 'course' ? <span className="text-lg font-bold text-gray-500"> 수업</span> : null}
        </h1>
      ) : (
        <h1 className="mt-3 text-xl font-extrabold text-gray-900">초대 확인</h1>
      )}

      <dl className="mt-2 space-y-1 text-sm text-gray-600">
        {info?.teacherName ? (
          <div className="flex gap-1.5 min-w-0">
            <dt className="shrink-0 text-gray-400">{type === 'homeroom' ? '담임' : '담당'}</dt>
            <dd className="min-w-0 break-words">{info.teacherName} 선생님</dd>
          </div>
        ) : null}
        {type === 'course' && info?.termName ? (
          <div className="flex gap-1.5">
            <dt className="shrink-0 text-gray-400">학기</dt>
            <dd className="min-w-0 break-words">{info.termName}</dd>
          </div>
        ) : null}
        {code ? (
          <div className="flex gap-1.5 items-baseline">
            <dt className="shrink-0 text-gray-400">초대 코드</dt>
            <dd className="font-mono font-bold tracking-widest text-gray-900">{formatInviteCode(code)}</dd>
          </div>
        ) : null}
        {until && !dimmed ? (
          <div className="flex gap-1.5">
            <dt className="shrink-0 text-gray-400">사용 기간</dt>
            <dd>{until}까지</dd>
          </div>
        ) : null}
      </dl>

      {type && !dimmed ? (
        <div
          className={`mt-4 rounded-xl border p-3.5 text-sm break-keep ${
            type === 'course' ? 'bg-blue-50 border-blue-100 text-blue-900' : 'bg-emerald-50 border-emerald-100 text-emerald-900'
          }`}
        >
          {type === 'course' ? (
            <>
              <p className="font-bold">수업 초대 — 이 수업만 내 시간표에 추가</p>
              <p className="mt-1">원래 학급은 그대로, 이 수업만 내 시간표에 추가돼요.</p>
            </>
          ) : (
            <>
              <p className="font-bold">학급 초대 — 소속 학급 등록(담임 승인 필요)</p>
              <p className="mt-1">이 반을 내 소속 학급으로 등록해요. 담임 선생님이 승인하면 완료돼요.</p>
            </>
          )}
        </div>
      ) : null}
    </section>
  )
}

export default function InvitePage() {
  const router = useRouter()
  const { isStandalone } = useInstallPrompt()

  const rawCode = typeof router.query.code === 'string' ? router.query.code : ''
  const code = useMemo(() => normalizeInviteCode(rawCode), [rawCode])

  const [preview, setPreview] = useState<PreviewState>({ kind: 'loading' })
  const previewSeq = useRef(0)

  const [user, setUser] = useState<User | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [profile, setProfile] = useState<Profile | null>(null)

  const [name, setName] = useState('')
  const [studentNo, setStudentNo] = useState('')
  const [needName, setNeedName] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement | null>(null)

  const [accepting, setAccepting] = useState(false)
  const acceptingRef = useRef(false)
  const [acceptError, setAcceptError] = useState<AcceptError | null>(null)
  const [result, setResult] = useState<AcceptResult | null>(null)
  const [switching, setSwitching] = useState(false)

  const loggedIn = !!user && !user.isAnonymous
  const nextQuery = code ? `?next=${encodeURIComponent(invitePath(code))}` : ''

  // 주소의 코드를 정규화된 모양(/i/ABCD2345)으로 맞춤
  useEffect(() => {
    if (!router.isReady || !code || rawCode === code) return
    router.replace(invitePath(code))
  }, [router, router.isReady, rawCode, code])

  const loadPreview = useCallback(async (c: string) => {
    const seq = ++previewSeq.current
    setPreview({ kind: 'loading' })
    try {
      const res = await fetch('/api/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'preview', code: c }),
      })
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (seq !== previewSeq.current) return
      if (res.ok && data && data.state === 'ok') {
        const info = parseInfo(data)
        if (info) {
          setPreview({ kind: 'ok', info })
          return
        }
      }
      const errCode = data && typeof data.code === 'string' ? data.code : null
      if (res.status === 429) {
        setPreview({ kind: 'rate-limited' })
        return
      }
      if (res.status === 400 && errCode === 'bad-code') {
        setPreview({ kind: 'invalid', state: 'bad-code', info: null })
        if (readPendingInvite() === c) clearPendingInvite()
        return
      }
      if ((res.status === 404 || res.status === 410) && data && isBadState(data.state)) {
        setPreview({ kind: 'invalid', state: data.state, info: parseInfo(data) })
        // 다시 열어도 쓸 수 없는 초대 — 로그인 뒤 자동으로 이어가지 않게 보관 값을 지움
        if (readPendingInvite() === c) clearPendingInvite()
        return
      }
      setPreview({ kind: 'error', status: res.status, code: errCode })
    } catch {
      if (seq === previewSeq.current) setPreview({ kind: 'error', status: null, code: null })
    }
  }, [])

  useEffect(() => {
    if (!router.isReady) return
    setResult(null)
    setAcceptError(null)
    setNeedName(false)
    setNameError(null)
    if (!code) {
      previewSeq.current++
      setPreview({ kind: 'invalid', state: 'bad-code', info: null })
      return
    }
    if (rawCode !== code) return // 정규화된 주소로 바꾼 뒤 불러옴
    loadPreview(code)
  }, [router.isReady, code, rawCode, loadPreview])

  // 로그인 상태
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u)
      setAuthReady(true)
    })
    return () => unsub()
  }, [])

  // 로그인한 계정의 프로필(이름 미리 채우기, 프로필 없는 가입 직후 계정 판별)
  const uid = loggedIn && user ? user.uid : null
  useEffect(() => {
    setProfile(null)
    setResult(null)
    setAcceptError(null)
    setNeedName(false)
    setNameError(null)
    setName('')
    setStudentNo('')
    if (!uid || !user) return
    let cancelled = false
    ;(async () => {
      try {
        const { db } = await import('../../lib/firebase')
        const snap = await getDoc(doc(db, 'users', uid))
        if (cancelled) return
        if (!snap.exists()) {
          setProfile({ role: 'none', name: '' })
          setName((prev) => prev || String(user.displayName || '').slice(0, 20))
          return
        }
        const d = snap.data() as Record<string, unknown>
        const role = d.role === 'student' ? 'student' : d.role === 'teacher' ? 'teacher' : d.role ? 'other' : 'none'
        const nm = str(d.name) || str(d.displayName) || String(user.displayName || '')
        setProfile({ role, name: nm })
        setName((prev) => prev || nm.slice(0, 20))
        setStudentNo((prev) => prev || (d.studentId != null && d.studentId !== '' ? String(d.studentId).replace(/[^0-9]/g, '') : ''))
      } catch {
        // 읽지 못해도 진행 가능(이름이 필요하면 서버가 name-required로 알려 줌)
        if (!cancelled) {
          setProfile({ role: 'unknown', name: '' })
          setName((prev) => prev || String(user.displayName || '').slice(0, 20))
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid])

  // 로그인 안 됨(또는 익명)인데 쓸 수 있는 초대 → 로그인·가입 뒤 이어가도록 코드만 보관
  useEffect(() => {
    if (!code || !authReady || loggedIn || preview.kind !== 'ok') return
    savePendingInvite(code)
  }, [code, authReady, loggedIn, preview.kind])

  const info = preview.kind === 'ok' ? preview.info : preview.kind === 'invalid' ? preview.info : null
  const inviteType = preview.kind === 'ok' ? preview.info.type : null
  const showName = inviteType === 'homeroom' || needName || (inviteType === 'course' && profile?.role === 'none')
  const showStudentNo = inviteType === 'homeroom'

  const accept = async () => {
    if (acceptingRef.current || !code) return
    const u = auth.currentUser
    if (!u || u.isAnonymous) return
    const nm = name.trim()
    if (showName && !nm) {
      setNameError('이름을 입력해 주세요.')
      nameRef.current?.focus()
      return
    }
    if (showName && nm.length > 20) {
      setNameError('이름은 20자까지 쓸 수 있어요.')
      nameRef.current?.focus()
      return
    }
    setNameError(null)
    acceptingRef.current = true
    setAccepting(true)
    setAcceptError(null)
    try {
      const idToken = await u.getIdToken()
      const body: Record<string, unknown> = { action: 'accept', code }
      if (showName) body.name = nm
      const no = studentNo.replace(/[^0-9]/g, '').slice(0, 10)
      if (showStudentNo && no) body.studentId = no
      const res = await fetch('/api/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify(body),
      })
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (res.ok && data && data.ok === true) {
        clearPendingInvite()
        setResult(parseResult(data))
        return
      }
      const errCode = data && typeof data.code === 'string' ? data.code : ''
      if ((res.status === 404 || res.status === 410) && data && isBadState(data.state)) {
        setPreview({ kind: 'invalid', state: data.state, info: parseInfo(data) || info })
        if (readPendingInvite() === code) clearPendingInvite()
        return
      }
      if (errCode === 'bad-code') {
        setPreview({ kind: 'invalid', state: 'bad-code', info: null })
        return
      }
      if (errCode === 'name-required') {
        setNeedName(true)
        setNameError('이름을 입력해 주세요.')
        setAcceptError({ code: errCode, ...ACCEPT_ERROR_TEXT['name-required'] })
        setTimeout(() => nameRef.current?.focus(), 0)
        return
      }
      if (ACCOUNT_ERRORS.includes(errCode)) {
        // 계정 문제 — 다른 계정으로 바꿀 때 다시 보관하므로 지금 계정으로는 자동 이어가기를 멈춤
        clearPendingInvite()
      }
      const known = ACCEPT_ERROR_TEXT[errCode] || (res.status === 429 ? ACCEPT_ERROR_TEXT['rate-limited'] : null)
      if (known) {
        setAcceptError({ code: errCode || 'rate-limited', ...known })
        return
      }
      setAcceptError({
        code: 'server',
        title: '참여 처리 중 문제가 생겼어요',
        message: `잠시 후 다시 시도해 주세요. 같은 초대로 다시 눌러도 두 번 참여되지 않아요. (오류 ${res.status})`,
      })
    } catch {
      setAcceptError({
        code: 'network',
        title: '서버에 연결하지 못했어요',
        message: '인터넷 연결을 확인하고 다시 시도해 주세요. 같은 초대로 다시 눌러도 두 번 참여되지 않아요.',
      })
    } finally {
      acceptingRef.current = false
      setAccepting(false)
    }
  }

  /** 프로필 없는 계정이 사실 선생님인 경우: 학생 초대를 이어가지 않고 로그아웃 → 로그인 화면의 '선생님: 교사 인증'으로 */
  const goTeacherSignup = async () => {
    setSwitching(true)
    clearPendingInvite()
    try {
      await signOut(auth)
    } catch {
      // 로그아웃 실패해도 로그인 화면으로 — 거기서 다시 로그인하면 갈래 화면이 나옴
    }
    router.push('/auth/login')
  }

  const switchAccount = async () => {
    if (!code) return
    setSwitching(true)
    savePendingInvite(code)
    try {
      await signOut(auth)
    } catch {
      // 로그아웃 실패 시 화면 그대로 — 다시 누를 수 있음
    } finally {
      setSwitching(false)
    }
  }

  const loginLinks = (
    <div className="space-y-3">
      <Link href={`/auth/login${nextQuery}`} onClick={() => code && savePendingInvite(code)} className={primaryBtn}>
        로그인하고 참여
      </Link>
      <Link href={`/auth/register${nextQuery}`} onClick={() => code && savePendingInvite(code)} className={secondaryBtn}>
        처음이에요 (가입)
      </Link>
    </div>
  )

  let action: React.ReactNode = null
  if (preview.kind === 'loading') {
    action = <Spinner label="초대 정보를 확인하고 있어요..." />
  } else if (preview.kind === 'invalid') {
    const t = BAD_STATE_TEXT[preview.state]
    action = (
      <div className="bg-white shadow-xl rounded-2xl border border-gray-100 p-5 sm:p-6" role="alert">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600" aria-hidden="true">
            !
          </span>
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-gray-900 break-keep">{t.title}</h2>
            <p className="mt-1 text-sm text-gray-600 break-keep">{t.body}</p>
            <p className="mt-2 text-sm font-medium text-gray-800 break-keep">선생님께 새 초대를 요청하세요.</p>
          </div>
        </div>
        <div className="mt-5 border-t border-gray-100 pt-4">
          <p className="mb-2 text-sm text-gray-600 break-keep">다른 초대 코드를 받았다면 입력해 주세요.</p>
          <InviteCodeInput compact />
        </div>
      </div>
    )
  } else if (preview.kind === 'rate-limited' || preview.kind === 'error') {
    const limited = preview.kind === 'rate-limited'
    const notConfigured = preview.kind === 'error' && preview.code === 'not-configured'
    action = (
      <div className="bg-white shadow-xl rounded-2xl border border-gray-100 p-5 sm:p-6" role="alert">
        <h2 className="text-lg font-bold text-gray-900 break-keep">
          {limited ? '시도가 너무 많아요' : notConfigured ? '지금은 초대를 확인할 수 없어요' : '초대 정보를 불러오지 못했어요'}
        </h2>
        <p className="mt-1 text-sm text-gray-600 break-keep">
          {limited
            ? '잠시 후 다시 시도해 주세요.'
            : notConfigured
              ? '서버 설정 문제로 확인하지 못했어요. 잠시 후 다시 시도해 주세요.'
              : preview.kind === 'error' && preview.status
                ? `서버에서 문제가 생겼어요. 잠시 후 다시 시도해 주세요. (오류 ${preview.status})`
                : '인터넷 연결을 확인하고 다시 시도해 주세요.'}
        </p>
        <button type="button" onClick={() => code && loadPreview(code)} className={`mt-4 ${primaryBtn}`}>
          다시 시도
        </button>
      </div>
    )
  } else if (!authReady) {
    action = <Spinner label="로그인 상태를 확인하고 있어요..." />
  } else if (result) {
    const t = resultText(result, info)
    action = (
      <div className="bg-white shadow-xl rounded-2xl border border-gray-100 p-5 sm:p-6" role="status" aria-live="polite">
        <div className="flex items-start gap-3">
          <span
            className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${t.waiting ? 'bg-amber-50 text-amber-600' : 'bg-emerald-50 text-emerald-600'}`}
            aria-hidden="true"
          >
            {t.waiting ? '⏳' : '✓'}
          </span>
          <div className="min-w-0">
            <p className="text-xs font-bold text-gray-500">{t.waiting ? '승인 대기' : '참여 완료'}</p>
            <h2 className="text-lg font-bold text-gray-900 break-words">{t.title}</h2>
            <p className="mt-1 text-sm text-gray-600 break-keep">{t.body}</p>
            {result.type === 'course' && result.profileCreated ? (
              <p className="mt-2 text-sm text-gray-600 break-keep">
                아직 소속 학급은 없어요. 담임 선생님께 학급 초대 코드를 받으면 소속 학급도 등록할 수 있어요.
              </p>
            ) : null}
          </div>
        </div>
        <Link href={result.next} className={`mt-5 ${primaryBtn}`}>
          {t.cta}
        </Link>
      </div>
    )
  } else if (!loggedIn) {
    action = (
      <div className="bg-white shadow-xl rounded-2xl border border-gray-100 p-5 sm:p-6">
        <h2 className="text-lg font-bold text-gray-900">참여하려면 로그인이 필요해요</h2>
        <p className="mt-1 text-sm text-gray-600 break-keep">
          로그인하거나 가입하면 이 초대 화면으로 돌아와서 이어서 참여해요.
        </p>
        {user?.isAnonymous ? (
          <p className="mt-2 rounded-lg bg-amber-50 border border-amber-100 px-3 py-2 text-sm text-amber-900 break-keep">
            지금은 둘러보기(익명) 상태라 참여할 수 없어요. 내 계정으로 로그인하거나 새로 가입해 주세요.
          </p>
        ) : null}
        <div className="mt-5">{loginLinks}</div>
      </div>
    )
  } else {
    const isTeacher = profile?.role === 'teacher'
    action = (
      <div className="bg-white shadow-xl rounded-2xl border border-gray-100 p-5 sm:p-6">
        <p className="text-sm text-gray-500">참여할 계정</p>
        <p className="mt-0.5 text-base font-bold text-gray-900 break-all">{user?.email || '이메일이 없는 계정'}</p>
        {isTeacher ? (
          <p className="mt-2 rounded-lg bg-amber-50 border border-amber-100 px-3 py-2 text-sm text-amber-900 break-keep">
            <span aria-hidden="true">⚠️ </span>지금 선생님 계정으로 로그인되어 있어요. 학생 초대는 학생 계정으로 참여해요.
          </p>
        ) : null}
        {profile?.role === 'none' ? (
          <p className="mt-2 rounded-lg bg-sky-50 border border-sky-100 px-3 py-2 text-sm text-sky-900 break-keep">
            <span aria-hidden="true">ℹ️ </span>아직 가입이 끝나지 않은 계정이에요. 참여하면 이 계정이 <b>학생</b>으로 등록돼요. 선생님이라면 아래 &lsquo;선생님이에요&rsquo;를 눌러 교사 인증으로 가입해 주세요.
          </p>
        ) : null}

        {showName || showStudentNo ? (
          <div className="mt-4 space-y-4">
            {showName ? (
              <div>
                <label htmlFor="invite-name" className="block text-sm font-medium text-gray-700 mb-1">
                  이름 <span className="text-gray-400">(필수)</span>
                </label>
                <input
                  id="invite-name"
                  ref={nameRef}
                  type="text"
                  autoComplete="name"
                  maxLength={20}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value)
                    if (nameError) setNameError(null)
                  }}
                  aria-invalid={nameError ? true : undefined}
                  aria-describedby={nameError ? 'invite-name-error' : undefined}
                  className={inputClass}
                  placeholder="홍길동"
                />
                {nameError ? (
                  <p id="invite-name-error" role="alert" className="mt-1 text-sm text-red-600">
                    {nameError}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-gray-500 break-keep">선생님이 알아볼 수 있게 실제 이름을 써 주세요.</p>
                )}
              </div>
            ) : null}
            {showStudentNo ? (
              <div>
                <label htmlFor="invite-no" className="block text-sm font-medium text-gray-700 mb-1">
                  번호 <span className="text-gray-400">(선택)</span>
                </label>
                <input
                  id="invite-no"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={10}
                  value={studentNo}
                  onChange={(e) => setStudentNo(e.target.value.replace(/[^0-9]/g, ''))}
                  className={inputClass}
                  placeholder="예: 12"
                />
              </div>
            ) : null}
          </div>
        ) : null}

        {acceptError ? (
          <div className="mt-4 rounded-xl bg-red-50 border border-red-100 p-3.5" role="alert">
            <p className="text-sm font-bold text-red-800 break-keep">
              <span aria-hidden="true">⚠️ </span>
              {acceptError.title}
            </p>
            <p className="mt-1 text-sm text-red-700 break-keep">{acceptError.message}</p>
            {acceptError.code === 'unauthenticated' || acceptError.code === 'anonymous' ? (
              <div className="mt-3">{loginLinks}</div>
            ) : null}
          </div>
        ) : null}

        <div className="mt-5 space-y-3">
          <button type="button" onClick={accept} disabled={accepting || switching} className={primaryBtn}>
            {accepting ? '참여하는 중...' : '이 계정으로 참여'}
          </button>
          <button type="button" onClick={switchAccount} disabled={accepting || switching} className={secondaryBtn}>
            {switching ? '로그아웃하는 중...' : '다른 계정으로'}
          </button>
          {profile?.role === 'none' ? (
            <button type="button" onClick={goTeacherSignup} disabled={accepting || switching} className={secondaryBtn}>
              선생님이에요 (교사 인증)
            </button>
          ) : null}
          {acceptError && ACCOUNT_ERRORS.includes(acceptError.code) ? (
            <p className="text-xs text-gray-500 text-center break-keep">
              &lsquo;다른 계정으로&rsquo;를 누르면 로그아웃되고, 이 초대는 그대로 남아 다른 계정으로 이어서 참여할 수 있어요.
            </p>
          ) : null}
        </div>
      </div>
    )
  }

  const showInstallCard = !!code && !isStandalone && (preview.kind === 'ok' || !!result)

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4 sm:px-6">
      <Head>
        <title>초대 확인 · 클래스메이트</title>
        <meta name="robots" content="noindex" />
        <meta name="referrer" content="no-referrer" />
      </Head>
      <div className="mx-auto w-full max-w-md">
        <header className="flex items-center gap-3 mb-5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icons/icon-192.png" alt="" width={40} height={40} className="h-10 w-10 rounded-xl shadow-sm" />
          <div className="min-w-0">
            <p className="text-lg font-extrabold text-gray-900 leading-tight">
              클래스메이트 <span className="text-sm font-bold text-gray-400">Classmate</span>
            </p>
            <p className="text-xs text-gray-500">선생님이 보낸 초대</p>
          </div>
        </header>

        <div className="space-y-4">
          {preview.kind === 'ok' || (preview.kind === 'invalid' && (preview.info || code)) ? (
            <InviteCard info={info} code={preview.kind === 'invalid' && preview.state === 'bad-code' ? null : code} dimmed={preview.kind === 'invalid'} />
          ) : null}

          {action}

          {showInstallCard ? (
            <aside className="rounded-xl border border-gray-200 bg-white p-4 flex items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-lg" aria-hidden="true">
                📲
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-800">앱처럼 쓰고 싶다면</p>
                <p className="text-xs text-gray-500 break-keep">홈 화면에 추가하는 방법과 설치 뒤 이 초대를 이어가는 방법</p>
              </div>
              <Link
                href={`/install?code=${code}`}
                className="shrink-0 min-h-[44px] inline-flex items-center px-3 rounded-lg border border-gray-300 text-sm font-semibold text-gray-700 hover:bg-gray-50"
              >
                설치 안내
              </Link>
            </aside>
          ) : null}

          <p className="text-center text-sm">
            <Link href="/" className="inline-flex min-h-[44px] items-center px-2 text-gray-400 hover:text-gray-600">
              클래스메이트 처음 화면
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
