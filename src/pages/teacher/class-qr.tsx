import React, { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { auth } from '../../lib/firebase'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { toDataURL } from 'qrcode'
import { issueJoinToken, JOIN_TOKEN_TTL_MS } from '../../lib/join'
import { useUI } from '../../components/ui/feedback'

const RING_RADIUS = 16
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

export default function ClassQrPage() {
  const router = useRouter()
  const { toast } = useUI()

  const [loading, setLoading] = useState(true)
  const [userData, setUserData] = useState<any>(null)

  const [issuing, setIssuing] = useState(false)
  const [joinUrl, setJoinUrl] = useState('')
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [expiresAtMs, setExpiresAtMs] = useState(0)
  const [nowMs, setNowMs] = useState(() => Date.now())

  // 토큰 발급 (로드 시 자동 + 새 코드 만들기)
  const issue = useCallback(
    async (classId: string) => {
      setIssuing(true)
      try {
        const { url, expiresAtMs: expiry } = await issueJoinToken(classId)
        setJoinUrl(url)
        setExpiresAtMs(expiry)
      } catch (e) {
        console.error(e)
        toast('입장 코드를 만들지 못했어요. 잠시 후 다시 시도해 주세요.', 'error')
      } finally {
        setIssuing(false)
      }
    },
    [toast]
  )

  // 교사 가드 + 자동 발급
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.replace('/auth/login')
        return
      }
      try {
        const { db } = await import('../../lib/firebase')
        const snap = await getDoc(doc(db, 'users', u.uid))
        if (snap.exists()) {
          const data = snap.data()
          if (data.role === 'student') {
            router.replace('/student/today')
            return
          }
          if (!data.classId) {
            toast('먼저 반을 등록해야 해요.', 'error')
            router.replace('/dashboard')
            return
          }
          setUserData(data)
          void issue(String(data.classId))
        } else {
          router.replace('/dashboard')
          return
        }
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    })
    return () => unsub()
  }, [router, toast, issue])

  // 1초 카운트다운 틱
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  // 링크 → QR 이미지
  useEffect(() => {
    if (!joinUrl) return
    let cancelled = false
    toDataURL(joinUrl, {
      width: 720,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#111827', light: '#ffffff' },
    })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl)
      })
      .catch((e) => {
        console.error(e)
        toast('QR 코드를 그리지 못했어요.', 'error')
      })
    return () => {
      cancelled = true
    }
  }, [joinUrl, toast])

  const handleCopy = async () => {
    if (!joinUrl) return
    try {
      await navigator.clipboard.writeText(joinUrl)
      toast('입장 링크를 복사했어요.', 'success')
    } catch {
      toast('복사하지 못했어요. 링크를 길게 눌러 복사해 주세요.', 'error')
    }
  }

  if (loading) return <div className="p-10 text-center text-black">로딩 중...</div>

  const totalSec = JOIN_TOKEN_TTL_MS / 1000
  const remainingSec = expiresAtMs ? Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000)) : 0
  const expired = !!joinUrl && remainingSec <= 0
  const frac = totalSec > 0 ? remainingSec / totalSec : 0
  const mm = String(Math.floor(remainingSec / 60)).padStart(2, '0')
  const ss = String(remainingSec % 60).padStart(2, '0')

  return (
    <div className="min-h-screen bg-gray-50 py-8 sm:py-10 px-4 sm:px-6 lg:px-8">
      <div className="max-w-lg mx-auto">
        <div className="flex justify-between items-center mb-6 text-black">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">학급 QR 입장코드</h1>
            <p className="text-sm text-gray-600">학생들을 우리 반에 초대해요.</p>
          </div>
          <button
            onClick={() => router.push('/dashboard')}
            className="shrink-0 whitespace-nowrap text-gray-500 hover:text-gray-700 font-medium px-3"
          >
            나가기
          </button>
        </div>

        <div className="bg-white shadow-lg rounded-xl border border-gray-100 overflow-hidden">
          <div className="p-6 sm:p-8 flex flex-col items-center text-center">
            <h2 className="text-xl sm:text-2xl font-extrabold text-gray-900 break-keep">
              {userData?.schoolName} {userData?.grade}학년 {userData?.classNm}반
            </h2>
            <p className="mt-1 text-sm text-gray-500">카메라로 QR 코드를 스캔하면 입장할 수 있어요.</p>

            {/* QR */}
            <div className="relative mt-6">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt="학급 입장 QR 코드"
                  className={`w-64 h-64 sm:w-80 sm:h-80 rounded-xl border border-gray-200 transition-opacity ${
                    expired || issuing ? 'opacity-20' : 'opacity-100'
                  }`}
                />
              ) : (
                <div className="w-64 h-64 sm:w-80 sm:h-80 rounded-xl border border-gray-200 bg-gray-50 flex items-center justify-center">
                  <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600"></div>
                </div>
              )}
              {expired && (
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-lg font-bold text-gray-900">코드가 만료되었어요</span>
                  <span className="mt-1 text-sm text-gray-500">새 코드를 만들어 주세요.</span>
                </div>
              )}
            </div>

            {/* 카운트다운 */}
            <div className="mt-5 flex items-center justify-center gap-3">
              <svg className="w-10 h-10 -rotate-90" viewBox="0 0 40 40" aria-hidden="true">
                <circle cx="20" cy="20" r={RING_RADIUS} fill="none" stroke="#e5e7eb" strokeWidth="4" />
                <circle
                  cx="20"
                  cy="20"
                  r={RING_RADIUS}
                  fill="none"
                  stroke={expired ? '#ef4444' : remainingSec <= 60 ? '#f59e0b' : '#2563eb'}
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeDasharray={RING_CIRCUMFERENCE}
                  strokeDashoffset={RING_CIRCUMFERENCE * (1 - frac)}
                  style={{ transition: 'stroke-dashoffset 1s linear' }}
                />
              </svg>
              <div className="text-left">
                <p className={`text-xl font-bold tabular-nums ${expired ? 'text-red-500' : 'text-gray-900'}`}>
                  {expired ? '00:00' : `${mm}:${ss}`}
                </p>
                <p className="text-xs text-gray-500">{expired ? '만료됨' : '남은 시간 (10분 유효)'}</p>
              </div>
            </div>

            {/* 새 코드 만들기 */}
            <button
              onClick={() => userData?.classId && issue(String(userData.classId))}
              disabled={issuing}
              className="mt-5 w-full sm:w-auto inline-flex justify-center items-center gap-2 py-3 px-8 border border-transparent shadow-sm text-base font-bold rounded-xl text-white bg-blue-600 hover:bg-blue-700 focus:outline-none disabled:opacity-50"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {issuing ? '만드는 중...' : '새 코드 만들기'}
            </button>

            {/* 링크 복사 */}
            {joinUrl && (
              <button
                onClick={handleCopy}
                className="mt-3 w-full flex items-center justify-between gap-2 rounded-lg border border-gray-200 bg-gray-50 hover:bg-gray-100 px-3 py-2 text-left transition"
                title="입장 링크 복사"
              >
                <span className="text-xs text-gray-600 truncate">{joinUrl}</span>
                <span className="flex-shrink-0 inline-flex items-center gap-1 text-xs font-bold text-blue-600">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  복사
                </span>
              </button>
            )}
          </div>

          <div className="bg-gray-50 px-6 py-4 border-t border-gray-100">
            <p className="text-sm text-gray-600 break-keep text-center">
              💡 사용법: 교실 TV나 화면에 이 QR을 띄우고, 학생들이 스마트폰 카메라로 스캔하면 돼요.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
