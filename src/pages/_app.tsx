import '@/styles/globals.css'
import type { AppProps } from 'next/app'
import Head from 'next/head'
import { Toaster } from '../lib/toast'

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#2563eb" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
      </Head>
      <Component {...pageProps} />
      <Toaster />
    </>
  )
}
