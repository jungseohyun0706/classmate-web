import '@/styles/globals.css'
import type { AppProps } from 'next/app'
import Head from 'next/head'
import dynamic from 'next/dynamic'
import { useEffect } from 'react'
import { UIProvider } from '@/components/ui/feedback'
import { InstallProvider } from '@/components/ui/install'

// 전역 푸시 연결(포그라운드 토스트·토큰 재등록·로그아웃 시 토큰 정리·알림 클릭 이동).
// Firebase SDK를 불러오므로 첫 화면 번들과 분리해 브라우저에서만 불러옵니다.
const PushBridge = dynamic(
  () => import('@/components/EnablePush').then((m) => m.PushBridge),
  { ssr: false }
)

export default function App({ Component, pageProps }: AppProps) {
  // 하이드레이션 완료 표시(자식 효과가 모두 끝난 뒤 실행) — 자동화 테스트가 입력 전에 기다리는 신호
  useEffect(() => {
    document.documentElement.setAttribute('data-hydrated', '1')
  }, [])

  useEffect(() => {
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // 서비스 워커 등록 실패는 앱 동작에 영향을 주지 않으므로 무시
      })
    }
  }, [])

  // 로그아웃·계정 전환 시 개인 시간표 캐시(localStorage 'cm_tt_*') 삭제 — 다른 계정 자료가 남지 않게.
  // Firebase SDK는 첫 화면 번들과 분리해 브라우저에서만 불러옵니다.
  useEffect(() => {
    let cancelled = false
    let unsub: (() => void) | null = null
    let lastUid: string | null | undefined
    Promise.all([import('@/lib/firebase'), import('firebase/auth'), import('@/lib/timetable/client')])
      .then(([fb, fbAuth, tt]) => {
        if (cancelled || !fb.auth) return
        unsub = fbAuth.onAuthStateChanged(fb.auth, (u) => {
          const uid = u ? u.uid : null
          if (!uid || (lastUid !== undefined && lastUid !== uid)) {
            tt.clearTimetableCache()
          } else {
            // 같은 계정: 이전에 남은 다른 계정 캐시만 정리
            tt.clearTimetableCache(uid)
          }
          lastUid = uid
        })
      })
      .catch(() => {
        // 캐시 정리 실패는 화면 동작에 영향 없음(각 화면이 uid별 키로만 읽음)
      })
    return () => {
      cancelled = true
      if (unsub) unsub()
    }
  }, [])

  return (
    <>
      <Head>
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        {/* 기본 제목(페이지가 따로 정하면 그 값). 제목이 없으면 화면 이동 안내(route announcer)가
            주소 경로(예: /teacher/courses/<수업 id>)를 읽어 내부 id가 노출되므로 항상 둠 */}
        <title key="title">클래스메이트</title>
      </Head>
      <UIProvider>
        <InstallProvider>
          <Component {...pageProps} />
        </InstallProvider>
        <PushBridge />
      </UIProvider>
    </>
  )
}
