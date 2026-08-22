import React, { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { initFirebase } from '../lib/firebase'
import { getAuth, onAuthStateChanged, signOut } from 'firebase/auth'
import { collection, getFirestore, onSnapshot, query, where } from 'firebase/firestore'

initFirebase()

/** 교사용 공통 셸: 상단 네비 + 받은 교환요청 배지 */
export default function TeacherLayout({
  children,
  title,
  subtitle,
}: {
  children: React.ReactNode
  title?: string
  subtitle?: string
}) {
  const router = useRouter()
  const auth = getAuth()
  const [pendingCount, setPendingCount] = useState(0)
  const [email, setEmail] = useState<string | null>(null)

  useEffect(() => {
    const unsubAuth = onAuthStateChanged(auth, (u) => {
      setEmail(u?.email ?? null)
      if (!u) return
      const db = getFirestore()
      const q = query(
        collection(db, 'swap_requests'),
        where('toUid', '==', u.uid),
        where('status', '==', 'pending'),
      )
      const unsubSnap = onSnapshot(q, (snap) => setPendingCount(snap.size), () => setPendingCount(0))
      return () => unsubSnap()
    })
    return () => unsubAuth()
  }, [auth])

  const handleLogout = async () => {
    await signOut(auth)
    router.replace('/auth/login')
  }

  const nav = [
    { href: '/dashboard', label: '홈' },
    { href: '/teacher/my-schedule', label: '내 시간표' },
    { href: '/teacher/requests', label: '교환 요청', badge: pendingCount },
    { href: '/teacher/view-timetables', label: '전체 시간표' },
    { href: '/teacher/upload-timetable', label: '시간표 업로드' },
  ]

  return (
    <div className="min-h-screen bg-gray-50 text-black">
      <nav className="bg-white shadow-sm border-b border-gray-200 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 h-14 flex justify-between items-center">
          <div className="flex items-center gap-6 min-w-0">
            <Link href="/dashboard" className="flex items-center shrink-0">
              <span className="text-xl font-extrabold text-blue-600">Classmate</span>
              <span className="ml-2 px-1.5 py-0.5 bg-blue-100 text-blue-800 text-[10px] font-semibold rounded-full">
                Teacher
              </span>
            </Link>
            <div className="hidden md:flex items-center gap-1 overflow-x-auto">
              {nav.map((n) => {
                const active = router.pathname === n.href
                return (
                  <Link
                    key={n.href}
                    href={n.href}
                    className={`relative px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                      active ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100'
                    }`}
                  >
                    {n.label}
                    {!!n.badge && (
                      <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
                        {n.badge > 9 ? '9+' : n.badge}
                      </span>
                    )}
                  </Link>
                )
              })}
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className="text-gray-500 text-xs hidden sm:block">{email}</span>
            <Link href="/teacher/settings" className="text-gray-500 hover:text-gray-800 text-sm">설정</Link>
            <button onClick={handleLogout} className="text-gray-500 hover:text-red-600 text-sm font-medium">
              로그아웃
            </button>
          </div>
        </div>
        {/* 모바일 하단 네비 대용 — 상단 스크롤 바 */}
        <div className="md:hidden border-t border-gray-100 px-2 py-1.5 flex gap-1 overflow-x-auto">
          {nav.map((n) => {
            const active = router.pathname === n.href
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`relative whitespace-nowrap px-3 py-1 rounded-full text-xs font-medium ${
                  active ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'
                }`}
              >
                {n.label}
                {!!n.badge && (
                  <span className="ml-1 inline-flex min-w-4 h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold items-center justify-center">
                    {n.badge > 9 ? '9+' : n.badge}
                  </span>
                )}
              </Link>
            )
          })}
        </div>
      </nav>

      <main className="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
        {(title || subtitle) && (
          <div className="mb-6">
            {title && <h1 className="text-2xl font-bold text-gray-900">{title}</h1>}
            {subtitle && <p className="mt-1 text-sm text-gray-600">{subtitle}</p>}
          </div>
        )}
        {children}
      </main>
    </div>
  )
}
