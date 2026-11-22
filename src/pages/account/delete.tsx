import { useEffect, useRef, useState, type JSX } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { onAuthStateChanged, signOut, type User } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth } from '../../lib/firebase'
import {
  ACCOUNT_DELETE_CONFIRM,
  ACCOUNT_DELETE_PATH,
  DELETED_TEACHER_NAME,
  PRIVACY_CONTACT_EMAIL,
  RECENT_LOGIN_MAX_AGE_SEC,
  RELEASED_TEACHER_NAME,
  isRecentLogin,
} from '../../lib/accountDeletion'

// 회원 탈퇴 화면 — 앱 안(선생님 설정, 학생 '오늘' 화면 아래)에서 들어오고,
// 로그인하지 않은 사람도 볼 수 있어 Play Console '계정 삭제 URL'로 씁니다.

type Phase = 'loading' | 'signed-out' | 'ready' | 'done'

const LOGIN_HREF = `/auth/login?next=${encodeURIComponent(ACCOUNT_DELETE_PATH)}`
const MAIL_HREF = `mailto:${PRIVACY_CONTACT_EMAIL}?subject=${encodeURIComponent('[클래스메이트] 계정 삭제 요청')}`

export default function AccountDeletePage(): JSX.Element {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('loading')
  const [user, setUser] = useState<User | null>(null)
  const [name, setName] = useState<string>('')
  const [recent, setRecent] = useState<boolean>(false)
  const [confirmText, setConfirmText] = useState<string>('')
  const [busy, setBusy] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  // 탈퇴 직후 로그아웃되면서 '로그인하지 않음' 화면으로 바뀌지 않게 합니다.
  const doneRef = useRef<boolean>(false)

  useEffect(() => {
    if (!auth) {
      setPhase('signed-out')
      return
    }
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (doneRef.current) return
      if (!u) {
        setUser(null)
        setPhase('signed-out')
        return
      }
      setUser(u)
      try {
        const token = await u.getIdTokenResult()
        setRecent(isRecentLogin(Date.parse(token.authTime) / 1000))
      } catch {
        setRecent(false)
      }
      try {
        const { db } = await import('../../lib/firebase')
        const snap = await getDoc(doc(db, 'users', u.uid))
        const data = snap.exists() ? snap.data() : {}
        setName(String(data.name || data.displayName || u.displayName || ''))
      } catch {
        // 이름은 안내용이라 못 읽어도 탈퇴할 수 있습니다.
      }
      setPhase('ready')
    })
    return () => unsub()
  }, [])

  const handleRelogin = async (): Promise<void> => {
    await signOut(auth).catch(() => {})
    router.push(LOGIN_HREF)
  }

  const handleDelete = async (): Promise<void> => {
    if (!user || busy || confirmText.trim() !== ACCOUNT_DELETE_CONFIRM) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/account/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await user.getIdToken()}` },
        body: JSON.stringify({ confirm: confirmText.trim() }),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string }
      if (!res.ok) {
        if (data.code === 'recent-login-required') setRecent(false)
        setError(data.error || '탈퇴를 끝내지 못했어요. 잠시 후 다시 시도해 주세요.')
        return
      }
      doneRef.current = true
      setPhase('done')
      await signOut(auth).catch(() => {})
    } catch {
      setError('연결이 끊겨 탈퇴하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.')
    } finally {
      setBusy(false)
    }
  }

  const canDelete = confirmText.trim() === ACCOUNT_DELETE_CONFIRM && !busy

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4 sm:px-6 lg:px-8 text-gray-800">
      <Head>
        <title>클래스메이트 - 계정 삭제</title>
        <meta name="description" content="클래스메이트(Classmate) 계정과 데이터를 삭제하는 방법을 안내합니다." />
      </Head>

      <div className="max-w-2xl mx-auto space-y-5">
        <div className="bg-white shadow-sm rounded-lg p-6 sm:p-8">
          <h1 className="text-2xl font-bold text-gray-900">클래스메이트 계정 삭제</h1>
          <p className="mt-2 text-sm leading-relaxed text-gray-600 break-keep">
            클래스메이트(Classmate) 계정과 그동안 남긴 데이터를 삭제하는 곳이에요. 앱에서는 선생님은
            <b> 설정 › 회원 탈퇴</b>, 학생은 <b>&lsquo;오늘&rsquo; 화면 맨 아래 › 회원 탈퇴</b>로 들어올 수
            있어요. 삭제한 계정과 데이터는 되돌릴 수 없어요.
          </p>

          <h2 className="mt-6 text-base font-semibold text-gray-900">바로 삭제되는 정보</h2>
          <ul className="mt-2 list-disc ml-5 space-y-1 text-sm leading-relaxed break-keep">
            <li>로그인 계정과 프로필: 이름, 이메일, 학교·학년·반, 번호, 내 수업 시간표</li>
            <li>알림 설정(푸시 알림 토큰), 알림함, 가방 체크 기록</li>
            <li>내가 보낸 톡방 메시지와 첨부한 사진·파일</li>
            <li>내가 쓴 알림장 댓글, 알림장 읽음·동의 기록</li>
            <li>선생님: 내가 쓴 알림장과 첨부 파일, 거기 달린 댓글·읽음 기록</li>
            <li>급식 별점 투표 기록 (평균 별점에는 누가 줬는지 알 수 없는 합계로만 남아요)</li>
          </ul>

          <h2 className="mt-6 text-base font-semibold text-gray-900">남는 정보</h2>
          <ul className="mt-2 list-disc ml-5 space-y-1 text-sm leading-relaxed break-keep">
            <li>
              선생님이 맡던 반은 학생들이 계속 쓸 수 있게 지우지 않고 담임을 &lsquo;{RELEASED_TEACHER_NAME}&rsquo;으로
              바꿔요.
            </li>
            <li>
              다른 선생님과 주고받은 수업 교환·보결 기록은 상대 선생님 시간표에 필요해서 이름을 &lsquo;
              {DELETED_TEACHER_NAME}&rsquo;으로 바꿔 남겨요. 아직 처리되지 않은 요청은 취소돼요.
            </li>
            <li>학교 시간표 파일을 올렸다면 시간표는 학교 선생님들이 쓰므로 남기고, 올린 사람 이름만 지워요.</li>
            <li>
              다른 사람이 이미 받은 알림(예: 입장 신청 알림)이나 수업 교환으로 바뀐 반 시간표에 적힌 이름은
              남을 수 있어요.
            </li>
          </ul>
        </div>

        <div className="bg-white shadow-sm rounded-lg p-6 sm:p-8">
          {phase === 'loading' && <p className="text-sm text-gray-500">로그인 정보를 확인하고 있어요…</p>}

          {phase === 'signed-out' && (
            <>
              <h2 className="text-lg font-semibold text-gray-900">로그인하고 바로 삭제하기</h2>
              <p className="mt-2 text-sm leading-relaxed text-gray-600 break-keep">
                삭제할 계정으로 로그인하면 이 화면으로 돌아와요.
              </p>
              <Link
                href={LOGIN_HREF}
                className="mt-4 inline-flex w-full justify-center rounded-lg bg-gray-900 px-4 py-3 text-sm font-bold text-white transition hover:bg-gray-700"
              >
                로그인하고 계정 삭제하기
              </Link>
            </>
          )}

          {phase === 'ready' && user && (
            <>
              <h2 className="text-lg font-semibold text-gray-900">내 계정 삭제</h2>
              <p className="mt-2 text-sm text-gray-600 break-all">
                {name ? `${name} · ` : ''}
                {user.email || '이메일 없는 계정'}
              </p>
              {!recent ? (
                <>
                  <p className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-800 break-keep">
                    보안을 위해 최근 {RECENT_LOGIN_MAX_AGE_SEC / 60}분 안에 로그인한 경우에만 탈퇴할 수 있어요.
                    다시 로그인하면 이 화면으로 돌아와요.
                  </p>
                  <button
                    type="button"
                    onClick={handleRelogin}
                    className="mt-4 w-full rounded-lg bg-gray-900 px-4 py-3 text-sm font-bold text-white transition hover:bg-gray-700"
                  >
                    다시 로그인하기
                  </button>
                </>
              ) : (
                <>
                  <label htmlFor="confirm-delete" className="mt-5 block text-sm font-medium text-gray-700 break-keep">
                    정말 삭제하려면 아래 칸에 <b className="text-red-600">{ACCOUNT_DELETE_CONFIRM}</b>를 입력하세요.
                  </label>
                  <input
                    id="confirm-delete"
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    placeholder={ACCOUNT_DELETE_CONFIRM}
                    autoComplete="off"
                    className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500"
                  />
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={!canDelete}
                    className="mt-4 w-full rounded-lg bg-red-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy ? '삭제하는 중…' : '계정과 데이터 영구 삭제'}
                  </button>
                </>
              )}
              {error && (
                <p role="alert" className="mt-3 text-sm text-red-600 break-keep">
                  {error}
                </p>
              )}
            </>
          )}

          {phase === 'done' && (
            <>
              <h2 className="text-lg font-semibold text-gray-900">계정을 삭제했어요</h2>
              <p className="mt-2 text-sm leading-relaxed text-gray-600 break-keep">
                계정과 데이터를 모두 지웠어요. 그동안 클래스메이트를 써 주셔서 고마워요.
              </p>
              <Link href="/" className="mt-4 inline-block text-sm font-semibold text-blue-600 underline">
                처음 화면으로
              </Link>
            </>
          )}
        </div>

        <div className="bg-white shadow-sm rounded-lg p-6 sm:p-8">
          <h2 className="text-base font-semibold text-gray-900">로그인할 수 없나요?</h2>
          <p className="mt-2 text-sm leading-relaxed text-gray-600 break-keep">
            <a href={MAIL_HREF} className="font-medium text-blue-600 underline">
              {PRIVACY_CONTACT_EMAIL}
            </a>
            로 &lsquo;계정 삭제 요청&rsquo; 메일을 보내 주세요. 가입한 이메일 주소와 이름, 학교·학년·반을 적어
            주시면 본인인지 확인한 뒤 늦어도 10일 안에 위와 같은 범위로 삭제해 드려요.
          </p>
          <p className="mt-4 text-xs text-gray-400">
            <Link href="/privacy" className="underline">
              개인정보처리방침
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
