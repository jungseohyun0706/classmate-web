import React, { useId, useState } from 'react'
import { useRouter } from 'next/router'
import { formatInviteCode, invitePath, normalizeInviteCode } from '../lib/pendingInvite'
import { useHydrated } from '../lib/useHydrated'

// 초대 코드 입력(XXXX-XXXX) → /i/{code}
// - 입력하는 대로 대문자·하이픈을 맞춰 주고, 초대 링크 전체를 붙여넣어도 코드만 꺼냅니다.
// - 형식이 틀리면 이유를 안내합니다(헷갈리는 0·1·I·L·O는 초대 코드에 쓰지 않음).
// - 서버 확인(만료·회수 등)은 /i/{code} 화면이 합니다.
// 다른 화면(대시보드·학생 화면)에서도 쓰므로 props 이름을 바꾸지 마세요.

interface InviteCodeInputProps {
  autoFocus?: boolean
  /** 한 줄(입력칸 + 버튼)로 작게 */
  compact?: boolean
}

/** 입력 중 표시: 영문·숫자만 남겨 대문자로, 8자까지, 4자 뒤에 하이픈 */
function liveFormat(raw: string): string {
  const s = raw.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8)
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s
}

/** 링크·하이픈·공백이 섞인 값이면 먼저 정규화해 보고, 안 되면 입력 중 표시로 */
function toDisplay(raw: string): string {
  const code = normalizeInviteCode(raw)
  return code ? formatInviteCode(code) : liveFormat(raw)
}

export default function InviteCodeInput({ autoFocus, compact }: InviteCodeInputProps) {
  const router = useRouter()
  const id = useId()
  const inputId = `invite-code-${id}`
  const errorId = `invite-code-error-${id}`
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [going, setGoing] = useState(false)
  // 하이드레이션 전 Enter·클릭은 브라우저 기본 제출(페이지 새로고침)이 되므로 연결된 뒤에만 제출
  const hydrated = useHydrated()

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setValue(toDisplay(e.target.value))
    if (error) setError(null)
  }

  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text')
    const code = normalizeInviteCode(text)
    if (code) {
      e.preventDefault()
      setValue(formatInviteCode(code))
      setError(null)
    }
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (going) return
    const code = normalizeInviteCode(value)
    if (!code) {
      const compactValue = value.replace(/[^0-9A-Z]/gi, '')
      if (!compactValue) setError('선생님께 받은 초대 코드 8자리를 입력해 주세요.')
      else if (/[01ILO]/i.test(compactValue)) {
        setError('초대 코드에는 숫자 0·1과 영문 I·L·O가 없어요. 비슷한 글자를 다시 확인해 주세요.')
      } else setError('초대 코드는 8자리예요 (예: ABCD-2345). 다시 확인해 주세요.')
      return
    }
    setGoing(true)
    try {
      await router.push(invitePath(code))
    } finally {
      setGoing(false)
    }
  }

  const input = (
    <input
      id={inputId}
      type="text"
      inputMode="text"
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="characters"
      spellCheck={false}
      enterKeyHint="go"
      autoFocus={autoFocus}
      value={value}
      onChange={onChange}
      onPaste={onPaste}
      placeholder="XXXX-XXXX"
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
      className={`appearance-none block w-full min-w-0 min-h-[44px] px-4 py-2.5 border rounded-xl shadow-sm placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 font-mono tracking-[0.2em] text-lg text-black bg-white ${
        error ? 'border-red-400' : 'border-gray-300'
      }`}
    />
  )

  const errorText = error ? (
    <p id={errorId} role="alert" className="mt-1.5 text-sm text-red-600 break-keep">
      <span aria-hidden="true">⚠️ </span>
      {error}
    </p>
  ) : null

  if (compact) {
    return (
      <form method="post" onSubmit={onSubmit} noValidate className="w-full">
        <label htmlFor={inputId} className="sr-only">
          초대 코드
        </label>
        <div className="flex gap-2">
          {input}
          <button
            type="submit"
            disabled={!hydrated || going}
            className="shrink-0 min-h-[44px] px-4 rounded-xl bg-emerald-600 text-white text-base font-bold hover:bg-emerald-700 disabled:opacity-50 transition-colors"
          >
            확인
          </button>
        </div>
        {errorText}
      </form>
    )
  }

  return (
    <form method="post" onSubmit={onSubmit} noValidate className="w-full">
      <label htmlFor={inputId} className="block text-sm font-medium text-gray-700 mb-1">
        초대 코드
      </label>
      {input}
      {errorText}
      <p className="mt-1.5 text-xs text-gray-500 break-keep">
        선생님께 받은 8자리 코드(예: ABCD-2345)나 초대 링크를 그대로 붙여넣어도 돼요.
      </p>
      <button
        type="submit"
        disabled={!hydrated || going}
        className="mt-3 w-full min-h-[44px] flex justify-center items-center py-3 px-4 rounded-xl shadow-sm text-base font-bold text-white bg-emerald-600 hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-500 disabled:opacity-50 transition-colors"
      >
        {going ? '여는 중...' : '초대 확인하기'}
      </button>
    </form>
  )
}
