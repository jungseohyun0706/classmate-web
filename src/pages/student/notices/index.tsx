import { useEffect, useState, type JSX } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth } from '../../../lib/firebase'
import { StudentTabBar } from '../today'
import {
  formatNoticeDate,
  getMyReceipts,
  listAnnouncements,
  type Announcement,
  type Receipt,
} from '../../../lib/notices'

interface StudentData {
  role?: string
  displayName?: string
  name?: string
  classId?: string
  status?: 'pending' | 'approved' | 'rejected'
}

export default function StudentNotices(): JSX.Element {
  const router = useRouter()
  const [loading, setLoading] = useState<boolean>(true)
  const [uid, setUid] = useState<string | null>(null)
  const [userData, setUserData] = useState<StudentData | null>(null)
  const [notices, setNotices] = useState<Announcement[]>([])
  const [receipts, setReceipts] = useState<Record<string, Receipt>>({})
  const [listLoading, setListLoading] = useState<boolean>(true)

  // 로그인 + 학생 역할 가드
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.replace('/auth/login')
        return
      }
      try {
        const { db } = await import('../../../lib/firebase')
        const snap = await getDoc(doc(db, 'users', u.uid))
        const data = snap.exists() ? (snap.data() as StudentData) : null
        if (!data || data.role !== 'student') {
          router.replace('/dashboard')
          return
        }
        if (!data.classId) {
          router.replace('/student/today')
          return
        }
        setUid(u.uid)
        setUserData(data)
        setLoading(false)
      } catch (e) {
        console.error(e)
        setLoading(false)
      }
    })
    return () => unsub()
  }, [router])

  // 알림장 목록 + 내 읽음 확인
  useEffect(() => {
    const classId = userData?.classId
    if (!uid || !classId) return
    let cancelled = false
    ;(async () => {
      try {
        const list = await listAnnouncements(classId, 30)
        const mine = await getMyReceipts(classId, list.map((a) => a.id), uid)
        if (cancelled) return
        setNotices(list)
        setReceipts(mine)
      } catch {
        // 승인 전 등 권한이 없으면 빈 목록으로 표시
        if (!cancelled) setNotices([])
      } finally {
        if (!cancelled) setListLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [uid, userData?.classId])

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-emerald-600" />
      </div>
    )
  }

  if (!userData) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-sm rounded-xl border border-gray-100 bg-white p-8 text-center shadow-lg">
          <p className="text-sm text-gray-600 break-keep">정보를 불러오지 못했어요.</p>
          <button
            type="button"
            onClick={() => router.reload()}
            className="mt-4 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-700"
          >
            다시 시도
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 text-black">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-2 px-4">
          <h1 className="text-lg font-bold text-gray-900">알림장</h1>
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
            우리 반 소식
          </span>
        </div>
      </header>

      <main
        className="mx-auto max-w-2xl px-4 py-5"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 6.5rem)' }}
      >
        {userData?.status === 'pending' && (
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800 break-keep">
            선생님 승인을 기다리고 있어요
          </div>
        )}

        {listLoading ? (
          <div className="animate-pulse space-y-2">
            <div className="h-16 rounded-xl bg-gray-100" />
            <div className="h-16 rounded-xl bg-gray-100" />
            <div className="h-16 rounded-xl bg-gray-100" />
          </div>
        ) : notices.length === 0 ? (
          <div className="rounded-xl border border-gray-100 bg-white px-4 py-12 text-center shadow-lg">
            <p className="text-sm text-gray-500 break-keep">아직 볼 수 있는 알림장이 없어요</p>
            <p className="mt-1 text-xs text-gray-400 break-keep">
              선생님이 알림장을 보내면 여기에 보여요
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {notices.map((a) => {
              const receipt = receipts[a.id]
              const unread = !receipt
              const needsConsent = a.requiresConsent && !receipt?.consent
              return (
                <li key={a.id}>
                  <Link
                    href={`/student/notices/${a.id}`}
                    className="flex items-center gap-3 rounded-xl border border-gray-100 bg-white px-4 py-3.5 shadow-sm transition-all hover:border-emerald-200 hover:shadow-md"
                  >
                    <span
                      aria-hidden="true"
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        unread ? 'bg-emerald-500' : 'bg-transparent'
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <p
                        className={`truncate text-sm ${
                          unread ? 'font-semibold text-gray-900' : 'text-gray-700'
                        }`}
                      >
                        {a.title}
                      </p>
                      <p className="mt-0.5 text-xs text-gray-400">
                        {formatNoticeDate(a.createdAt)} · {a.authorName}
                      </p>
                    </div>
                    {needsConsent && (
                      <span className="shrink-0 rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-600 ring-1 ring-rose-200">
                        동의 필요
                      </span>
                    )}
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-4 w-4 shrink-0 text-gray-300"
                      aria-hidden="true"
                    >
                      <path d="m9 6 6 6-6 6" />
                    </svg>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </main>

      <StudentTabBar active="notices" />
    </div>
  )
}
