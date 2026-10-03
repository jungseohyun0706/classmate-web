import React, { useEffect, useMemo, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { useInstallPrompt } from '../components/ui/install'
import { useUI } from '../components/ui/feedback'
import { formatInviteCode, invitePath, normalizeInviteCode } from '../lib/pendingInvite'

// 설치 안내 /install (?code=초대 코드)
// 저장소에서 확인되는 실제 설치 경로는 웹앱(PWA, 홈 화면에 추가)뿐입니다.
// - 스토어 앱: 저장소에 Play·App Store 주소가 없어(assetlinks.json의 TWA 패키지만 있음) 스토어 버튼·문구를 넣지 않습니다.
// - Android Chrome 등: 브라우저가 설치 이벤트(beforeinstallprompt)를 줄 때만 '설치' 버튼을 보여 줍니다(InstallProvider 재사용).
// - iOS: 자동 설치가 없어 '공유 → 홈 화면에 추가' 단계만 안내합니다.
// - 이미 설치된 앱(display-mode: standalone)에서 열면 '앱에서 열려 있어요'.
// 초대 코드가 있으면 설치 안내보다 먼저 코드와 '원래 초대 링크 다시 열기'를 보여 줍니다.
// (iOS는 Safari와 홈 화면 앱의 저장 공간이 따로라 초대·로그인이 자동으로 이어지지 않을 수 있음)

type Env = 'ios-safari' | 'ios-other' | 'in-app' | 'android' | 'desktop' | 'unknown'

function detectEnv(): Env {
  if (typeof window === 'undefined') return 'unknown'
  const ua = window.navigator.userAgent
  const ios = /iPhone|iPad|iPod/i.test(ua) || (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1)
  // 카카오톡·네이버·인스타그램 등 앱 안 브라우저는 설치할 수 없음(InstallProvider와 같은 기준)
  if (/KAKAOTALK|NAVER\(inapp|Instagram|FBAN|FBAV|Line\//i.test(ua)) return 'in-app'
  if (ios) return /CriOS|FxiOS|EdgiOS|OPiOS|Whale/i.test(ua) ? 'ios-other' : 'ios-safari'
  if (/Android/i.test(ua)) return 'android'
  return 'desktop'
}

function StepList({ steps }: { steps: React.ReactNode[] }) {
  return (
    <ol className="mt-3 space-y-2.5">
      {steps.map((s, i) => (
        <li key={i} className="flex items-start gap-3 text-sm text-gray-700">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-800">
            {i + 1}
          </span>
          <span className="pt-1 break-keep">{s}</span>
        </li>
      ))}
    </ol>
  )
}

export default function InstallPage() {
  const router = useRouter()
  const { toast } = useUI()
  const { canInstall, promptInstall, isStandalone } = useInstallPrompt()
  const [env, setEnv] = useState<Env>('unknown')
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    setEnv(detectEnv())
  }, [])

  const code = useMemo(() => normalizeInviteCode(typeof router.query.code === 'string' ? router.query.code : ''), [router.query.code])
  const display = code ? formatInviteCode(code) : ''

  const copyText = async (text: string, done: string) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
      } else {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        if (!ok) throw new Error('copy failed')
      }
      toast(done, 'success')
    } catch {
      toast('복사하지 못했어요. 길게 눌러 직접 복사해 주세요.', 'error')
    }
  }

  const onInstall = async () => {
    setInstalling(true)
    try {
      await promptInstall()
    } finally {
      setInstalling(false)
    }
  }

  const startHref = code ? invitePath(code) : '/auth/login'

  let guide: React.ReactNode
  if (env === 'unknown') {
    // 첫 렌더(서버 생성 HTML)에는 기기를 모름 — 다른 기기 안내가 잠깐 보이지 않게
    guide = (
      <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm text-sm text-gray-500" role="status">
        이 기기에 맞는 설치 방법을 확인하고 있어요...
      </div>
    )
  } else if (isStandalone) {
    guide = (
      <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-5">
        <h2 className="text-lg font-bold text-emerald-900">앱에서 열려 있어요</h2>
        <p className="mt-1 text-sm text-emerald-800 break-keep">
          이미 홈 화면에 추가한 클래스메이트 앱으로 보고 있어요. 따로 설치할 필요가 없어요.
        </p>
        <Link
          href={code ? invitePath(code) : '/dashboard'}
          className="mt-4 w-full min-h-[44px] flex justify-center items-center rounded-xl bg-emerald-600 text-base font-bold text-white hover:bg-emerald-700"
        >
          {code ? '초대 이어서 열기' : '홈으로'}
        </Link>
      </div>
    )
  } else {
    let steps: React.ReactNode[] = []
    let title = '홈 화면에 추가하기'
    let note: React.ReactNode = null
    if (env === 'in-app') {
      title = '먼저 기본 브라우저로 열어 주세요'
      steps = [
        <>
          지금은 카카오톡 같은 <b>앱 안 브라우저</b>라 설치할 수 없어요.
        </>,
        <>
          화면의 메뉴(<b>⋯</b> 또는 <b>⋮</b>)에서 <b>&lsquo;Safari로 열기&rsquo;</b> 또는 <b>&lsquo;다른 브라우저로 열기&rsquo;</b>를 눌러 주세요.
        </>,
        <>열린 브라우저에서 이 화면의 안내를 따라 홈 화면에 추가해요.</>,
      ]
      note = (
        <button
          type="button"
          onClick={() => copyText(window.location.href, '이 화면 주소를 복사했어요')}
          className="mt-4 w-full min-h-[44px] rounded-xl border border-gray-300 bg-white text-sm font-bold text-gray-700 hover:bg-gray-50"
        >
          이 화면 주소 복사
        </button>
      )
    } else if (env === 'ios-safari') {
      title = 'iPhone·iPad (Safari)'
      steps = [
        <>
          Safari 화면의 <b>공유 버튼</b>(네모 위 화살표)을 눌러요. iPhone은 아래쪽, iPad는 위쪽에 있어요.
        </>,
        <>
          메뉴에서 <b>&lsquo;홈 화면에 추가&rsquo;</b>를 골라요. 안 보이면 메뉴를 아래로 내려 보세요.
        </>,
        <>
          <b>추가</b>를 누르면 홈 화면에 클래스메이트 아이콘이 생겨요. 그 아이콘으로 열어요.
        </>,
      ]
      note = <p className="mt-3 text-xs text-gray-500 break-keep">iPhone·iPad에는 누르면 바로 설치되는 버튼이 없어요. 위 순서대로 직접 추가해 주세요.</p>
    } else if (env === 'ios-other') {
      title = 'iPhone·iPad'
      steps = [
        <>
          브라우저의 <b>공유 버튼</b>을 눌러 <b>&lsquo;홈 화면에 추가&rsquo;</b>가 있는지 확인해요.
        </>,
        <>메뉴에 없으면 이 주소를 Safari에서 열고, Safari의 공유 버튼 → &lsquo;홈 화면에 추가&rsquo;를 눌러요.</>,
        <>홈 화면에 생긴 클래스메이트 아이콘으로 열어요.</>,
      ]
      note = (
        <button
          type="button"
          onClick={() => copyText(window.location.href, '이 화면 주소를 복사했어요')}
          className="mt-4 w-full min-h-[44px] rounded-xl border border-gray-300 bg-white text-sm font-bold text-gray-700 hover:bg-gray-50"
        >
          Safari에서 열 주소 복사
        </button>
      )
    } else {
      title = env === 'desktop' ? '컴퓨터 브라우저' : 'Android (Chrome 등)'
      steps =
        env === 'desktop'
          ? [
              <>
                주소창 오른쪽의 <b>설치 아이콘</b>이나 브라우저 메뉴(<b>⋮</b>)를 눌러요.
              </>,
              <>
                <b>&lsquo;앱 설치&rsquo;</b> 또는 <b>&lsquo;클래스메이트 설치&rsquo;</b>를 골라요.
              </>,
            ]
          : [
              <>
                브라우저 오른쪽 위 메뉴(<b>⋮</b>)를 눌러요.
              </>,
              <>
                <b>&lsquo;앱 설치&rsquo;</b> 또는 <b>&lsquo;홈 화면에 추가&rsquo;</b>를 골라요.
              </>,
              <>홈 화면에 생긴 클래스메이트 아이콘으로 열어요.</>,
            ]
      note = (
        <p className="mt-3 text-xs text-gray-500 break-keep">
          메뉴에 설치 항목이 없으면 이 브라우저가 설치를 지원하지 않거나 이미 설치된 상태일 수 있어요. 설치하지 않아도 브라우저에서 그대로 쓸 수 있어요.
        </p>
      )
    }
    guide = (
      <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
        {canInstall ? (
          <div className="mb-5">
            <p className="text-sm text-gray-600 break-keep">이 브라우저는 바로 설치할 수 있어요.</p>
            <button
              type="button"
              onClick={onInstall}
              disabled={installing}
              className="mt-2 w-full min-h-[44px] flex justify-center items-center rounded-xl bg-emerald-600 text-base font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {installing ? '설치 창을 여는 중...' : '설치'}
            </button>
            <p className="mt-2 text-xs text-gray-500 break-keep">설치 창이 뜨지 않으면 아래 순서대로 직접 추가해 주세요.</p>
          </div>
        ) : null}
        <h2 className="text-base font-bold text-gray-900">{title}</h2>
        <StepList steps={steps} />
        {note}
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4 sm:px-6">
      <Head>
        <title>설치 안내 · 클래스메이트</title>
        <meta name="description" content="클래스메이트 웹앱을 홈 화면에 추가하는 방법" />
        <meta name="referrer" content="no-referrer" />
      </Head>
      <div className="mx-auto w-full max-w-md space-y-4">
        <header className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icons/icon-192.png" alt="클래스메이트 아이콘" width={56} height={56} className="h-14 w-14 rounded-2xl shadow" />
          <div className="min-w-0">
            <h1 className="text-xl font-extrabold text-gray-900 leading-tight">
              클래스메이트 <span className="text-base font-bold text-gray-400">Classmate</span>
            </h1>
            <p className="mt-0.5 text-sm text-gray-600 break-keep">학생과 선생님이 함께 쓰는 학급·시간표 웹앱</p>
          </div>
        </header>

        {code ? (
          <section aria-label="초대 코드" className="rounded-2xl border-2 border-emerald-200 bg-white p-5 shadow-sm">
            <p className="text-sm font-bold text-emerald-800">받은 초대가 있어요</p>
            <p className="mt-1 text-sm text-gray-700 break-keep">설치 후 앱을 열고 이 초대 코드를 입력하세요:</p>
            <div className="mt-3 flex items-center gap-2">
              <span className="min-w-0 flex-1 rounded-xl bg-gray-50 border border-gray-200 px-4 py-2.5 text-center font-mono text-2xl font-extrabold tracking-[0.2em] text-gray-900">
                {display}
              </span>
              <button
                type="button"
                onClick={() => copyText(display, '초대 코드를 복사했어요')}
                className="shrink-0 min-h-[44px] px-4 rounded-xl border border-gray-300 bg-white text-sm font-bold text-gray-700 hover:bg-gray-50"
              >
                복사
              </button>
            </div>
            <Link
              href={invitePath(code)}
              className="mt-3 w-full min-h-[44px] flex justify-center items-center rounded-xl bg-emerald-600 text-base font-bold text-white hover:bg-emerald-700"
            >
              원래 초대 링크 다시 열기
            </Link>
            <ul className="mt-3 space-y-1.5 text-xs text-gray-600 break-keep">
              <li>
                <b>iPhone·iPad</b>: Safari와 홈 화면 앱은 저장 공간이 따로라 로그인과 초대가 자동으로 이어지지 않을 수 있어요. 앱에서 다시 로그인한 뒤 이 코드를 입력해 주세요.
              </li>
              <li>
                <b>Android Chrome</b>: 대부분 로그인과 초대가 이어지지만, 이어지지 않으면 이 코드를 입력해 주세요.
              </li>
            </ul>
          </section>
        ) : null}

        <section aria-label="설치 방법">
          <p className="mb-2 text-sm text-gray-600 break-keep">
            클래스메이트는 브라우저에서 바로 쓰는 웹앱이에요. 홈 화면에 추가하면 앱처럼 열 수 있어요.
          </p>
          {guide}
        </section>

        {!isStandalone ? (
          <Link
            href={startHref}
            className="w-full min-h-[44px] flex justify-center items-center rounded-xl border border-gray-300 bg-white text-base font-bold text-gray-700 hover:bg-gray-50"
          >
            {code ? '설치하지 않고 브라우저에서 계속하기' : '설치하지 않고 브라우저에서 시작하기'}
          </Link>
        ) : null}

        <p className="text-center text-sm">
          <Link href="/" className="inline-flex min-h-[44px] items-center px-2 text-gray-400 hover:text-gray-600">
            클래스메이트 처음 화면
          </Link>
        </p>
      </div>
    </div>
  )
}
