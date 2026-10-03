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
  useEffect(() => {
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // 서비스 워커 등록 실패는 앱 동작에 영향을 주지 않으므로 무시
      })
    }
  }, [])

  return (
    <>
      <Head>
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
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
