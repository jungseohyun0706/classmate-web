import '@/styles/globals.css'
import type { AppProps } from 'next/app'
import Head from 'next/head'
import { useEffect } from 'react'
import { UIProvider } from '@/components/ui/feedback'
import { InstallProvider } from '@/components/ui/install'

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
      </UIProvider>
    </>
  )
}
