import { useCallback, useEffect, useState, type JSX } from 'react'
import type { MessagePayload } from 'firebase/messaging'
import { useUI } from './ui/feedback'
import { attachForegroundHandler, enablePush, isPushSupported } from '../lib/messaging'

const ENABLED_KEY = 'classmate_push_enabled'
const DISMISSED_KEY = 'classmate_push_dismissed_at'
const DISMISS_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000 // 7일

type CardState = 'checking' | 'unsupported' | 'denied' | 'enabled' | 'prompt'

function readEnabledFlag(): boolean {
  try {
    return window.localStorage.getItem(ENABLED_KEY) === '1'
  } catch {
    return false
  }
}

function writeEnabledFlag(): void {
  try {
    window.localStorage.setItem(ENABLED_KEY, '1')
  } catch {
    // localStorage 사용 불가 시 무시
  }
}

function isRecentlyDismissed(): boolean {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY)
    if (!raw) return false
    const ts = Number(raw)
    return Number.isFinite(ts) && Date.now() - ts < DISMISS_INTERVAL_MS
  } catch {
    return false
  }
}

function writeDismissed(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, String(Date.now()))
  } catch {
    // localStorage 사용 불가 시 무시
  }
}

function BellIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  )
}

/**
 * 푸시 알림 켜기 카드.
 * - 미지원 브라우저 / 이미 켜짐 / 최근에 닫음 → 아무것도 렌더링하지 않음
 * - 권한 차단됨 → 해제 방법 안내 카드
 * - 그 외 → '알림 켜기' 카드
 */
export default function EnablePush(): JSX.Element | null {
  const { toast } = useUI()
  const [state, setState] = useState<CardState>('checking')
  const [dismissed, setDismissed] = useState<boolean>(false)
  const [busy, setBusy] = useState<boolean>(false)

  const onForeground = useCallback(
    (payload: MessagePayload) => {
      const title =
        payload.notification?.title || payload.data?.title || '새 알림이 도착했어요.'
      toast(title, 'info')
    },
    [toast]
  )

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const supported = await isPushSupported()
      if (cancelled) return
      if (!supported) {
        setState('unsupported')
        return
      }
      const permission = Notification.permission
      if (permission === 'denied') {
        setState('denied')
        return
      }
      if (permission === 'granted' && readEnabledFlag()) {
        setState('enabled')
        // 이미 켜져 있어도 포그라운드 수신 토스트는 동작해야 함
        attachForegroundHandler(onForeground)
        return
      }
      setDismissed(isRecentlyDismissed())
      setState('prompt')
    })()
    return () => {
      cancelled = true
    }
  }, [onForeground])

  const handleEnable = async () => {
    setBusy(true)
    try {
      const result = await enablePush(onForeground)
      if (result.ok) {
        writeEnabledFlag()
        setState('enabled')
        toast('알림을 켰어요. 중요한 소식을 바로 알려드릴게요.', 'success')
        return
      }
      switch (result.reason) {
        case 'permission-denied':
          setState('denied')
          toast('브라우저에서 알림이 차단되어 있어요.', 'error')
          break
        case 'permission-dismissed':
          toast('알림 권한 요청이 닫혔어요. 다시 시도해 주세요.', 'info')
          break
        case 'not-signed-in':
          toast('로그인 후 알림을 켤 수 있어요.', 'error')
          break
        case 'vapid-key-missing':
        case 'firebase-env-missing':
          toast('알림 기능이 아직 설정되지 않았어요. 관리자에게 문의해 주세요.', 'error')
          break
        default:
          toast('알림을 켜지 못했어요. 잠시 후 다시 시도해 주세요.', 'error')
      }
    } finally {
      setBusy(false)
    }
  }

  const handleDismiss = () => {
    writeDismissed()
    setDismissed(true)
  }

  if (state === 'checking' || state === 'unsupported' || state === 'enabled') return null

  // 권한이 차단된 경우: 해제 안내
  if (state === 'denied') {
    if (dismissed) return null
    return (
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gray-200 text-gray-500">
            <BellIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-gray-700">알림이 차단되어 있어요</p>
            <p className="mt-1 text-xs leading-relaxed text-gray-500 break-keep">
              브라우저 주소창의 자물쇠(사이트 설정)에서 알림을 &lsquo;허용&rsquo;으로
              바꾸면 교환 요청과 아침 브리핑을 받아볼 수 있어요.
            </p>
          </div>
          <button
            type="button"
            aria-label="닫기"
            className="shrink-0 rounded-full p-1 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600"
            onClick={handleDismiss}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </div>
    )
  }

  // 기본: 알림 켜기 카드
  if (dismissed) return null
  return (
    <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-100 text-blue-600">
          <BellIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-900">알림 켜기</p>
          <p className="mt-1 text-xs leading-relaxed text-gray-600 break-keep">
            교환 요청·보결 SOS·아침 브리핑을 놓치지 마세요
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={handleEnable}
              disabled={busy}
              className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50"
            >
              {busy ? '켜는 중...' : '켜기'}
            </button>
            <button
              type="button"
              onClick={handleDismiss}
              className="rounded-xl px-3 py-2 text-sm font-medium text-gray-500 transition-colors hover:bg-blue-100 hover:text-gray-700"
            >
              나중에
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
