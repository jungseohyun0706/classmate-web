import React from 'react'
import Head from 'next/head'

/** 오프라인 폴백 페이지 (서비스워커가 네트워크 실패 시 표시) */
export default function Offline() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-6">
      <Head><title>오프라인 — Classmate</title></Head>
      <div className="text-center">
        <div className="text-4xl mb-3">📡</div>
        <h1 className="text-xl font-extrabold text-gray-900">인터넷 연결이 끊겼어요</h1>
        <p className="mt-2 text-sm text-gray-500">
          연결이 돌아오면 자동으로 최신 시간표를 불러옵니다.<br />
          마지막으로 본 시간표는 다시 접속하면 바로 보여드릴게요.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="mt-6 px-6 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition"
        >
          다시 시도
        </button>
      </div>
    </div>
  )
}
