import { useEffect, useState, type JSX } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { onAuthStateChanged } from 'firebase/auth'
import { Timestamp, doc, getDoc } from 'firebase/firestore'
import { auth } from '../../../lib/firebase'
import { useUI } from '../../../components/ui/feedback'
import {
  formatNoticeDate,
  getAnnouncement,
  getReceipt,
  markRead,
  setConsent,
  type Announcement,
  type ConsentValue,
  type Receipt,
} from '../../../lib/notices'

interface StudentData {
  role?: string
  displayName?: string
  name?: string
  classId?: string
  status?: 'pending' | 'approved' | 'rejected'
}

export default function StudentNoticeDetail(): JSX.Element {
  const router = useRouter()
  const { toast, confirm } = useUI()
  const aid = typeof router.query.id === 'string' ? router.query.id : ''

  const [loading, setLoading] = useState<boolean>(true)
  const [uid, setUid] = useState<string | null>(null)
  const [userData, setUserData] = useState<StudentData | null>(null)
  const [notice, setNotice] = useState<Announcement | null>(null)
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [notFound, setNotFound] = useState<boolean>(false)
  const [saving, setSaving] = useState<boolean>(false)

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
      } catch (e) {
        console.error(e)
        setLoading(false)
      }
    })
    return () => unsub()
  }, [router])

  // 알림장 + 내 읽음 확인 로드, 읽음 처리
  useEffect(() => {
    const classId = userData?.classId
    if (!uid || !classId || !aid) return
    let cancelled = false
    ;(async () => {
      const studentName = userData?.name || userData?.displayName || '학생'
      try {
        const [a, r] = await Promise.all([
          getAnnouncement(classId, aid),
          getReceipt(classId, aid, uid).catch(() => null),
        ])
        if (cancelled) return
        if (!a) {
          setNotFound(true)
          return
        }
        setNotice(a)
        setReceipt(r)
        // 읽음 처리 — 이미 receipt가 있으면 내부에서 건너뜀. 실패(권한 등)해도 열람은 가능.
        if (!r) {
          try {
            await markRead(classId, aid, uid, studentName)
            if (!cancelled) {
              setReceipt({ readAt: Timestamp.now(), studentName })
            }
          } catch {
            // 승인 전 등 권한이 없으면 읽음 확인을 남기지 못함 — 무시
          }
        }
      } catch (e) {
        console.error(e)
        if (!cancelled) setNotFound(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [uid, userData, aid])

  const handleConsent = async (value: ConsentValue): Promise<void> => {
    const classId = userData?.classId
    if (!uid || !classId || !aid || saving) return
    if (receipt?.consent === value) return

    if (value === 'declined') {
      const ok = await confirm({
        title: '동의하지 않을까요?',
        description: "선생님께 '동의하지 않음'으로 전달돼요. 나중에 언제든 바꿀 수 있어요.",
        confirmText: '동의 안 함',
        cancelText: '돌아가기',
        danger: true,
      })
      if (!ok) return
    }

    const studentName = userData?.name || userData?.displayName || '학생'
    setSaving(true)
    try {
      await setConsent(classId, aid, uid, studentName, value)
      setReceipt((prev) => ({
        readAt: prev?.readAt ?? null,
        studentName,
        consent: value,
        consentAt: Timestamp.now(),
      }))
      toast(value === 'agreed' ? '동의를 전달했어요.' : "'동의하지 않음'으로 전달했어요.", 'success')
    } catch (e) {
      console.error(e)
      toast('저장하지 못했어요. 잠시 후 다시 시도해 주세요.', 'error')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-emerald-600" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 text-black">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-1 px-2">
          <Link
            href="/student/notices"
            className="flex items-center gap-1 rounded-lg p-2 text-sm font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
              aria-hidden="true"
            >
              <path d="m15 6-6 6 6 6" />
            </svg>
            알림장
          </Link>
        </div>
      </header>

      <main
        className="mx-auto max-w-2xl px-4 py-5"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 3rem)' }}
      >
        {notFound || !notice ? (
          <div className="rounded-xl border border-gray-100 bg-white px-4 py-12 text-center shadow-lg">
            <p className="text-sm text-gray-500 break-keep">알림장을 찾을 수 없어요</p>
            <Link
              href="/student/notices"
              className="mt-3 inline-block text-sm font-semibold text-emerald-600 hover:text-emerald-700"
            >
              목록으로 돌아가기 &rarr;
            </Link>
          </div>
        ) : (
          <article className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-lg">
            <div className="border-b border-gray-100 px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <h1 className="text-xl font-bold text-gray-900 break-keep">{notice.title}</h1>
                {notice.requiresConsent && (
                  <span className="mt-1 shrink-0 rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-600 ring-1 ring-rose-200">
                    동의 필요
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-xs text-gray-400">
                {formatNoticeDate(notice.createdAt)} · {notice.authorName}
              </p>
            </div>

            <div className="px-5 py-5">
              <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-gray-800 break-keep">
                {notice.body}
              </p>

              {notice.attachmentUrl && (
                <a
                  href={notice.attachmentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-5 flex items-center gap-2.5 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 transition-colors hover:border-emerald-300 hover:bg-emerald-50"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-4 w-4 shrink-0 text-gray-400"
                    aria-hidden="true"
                  >
                    <path d="m21.4 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                  </svg>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-700">
                    {notice.attachmentName || '첨부파일'}
                  </span>
                  <span className="shrink-0 text-xs font-semibold text-emerald-600">열기</span>
                </a>
              )}
            </div>

            {/* 동의 응답 */}
            {notice.requiresConsent && (
              <div className="border-t border-gray-100 bg-gray-50/60 px-5 py-5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-gray-700">보호자/본인 동의가 필요해요</p>
                  {receipt?.consent && (
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
                        receipt.consent === 'agreed'
                          ? 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200'
                          : 'bg-gray-200 text-gray-600 ring-1 ring-gray-300'
                      }`}
                    >
                      {receipt.consent === 'agreed' ? '동의했어요' : '동의하지 않았어요'}
                      {receipt.consentAt ? ` · ${formatNoticeDate(receipt.consentAt)}` : ''}
                    </span>
                  )}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void handleConsent('agreed')}
                    className={`rounded-xl py-4 text-base font-bold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:opacity-50 ${
                      receipt?.consent === 'agreed'
                        ? 'bg-emerald-600 text-white'
                        : 'bg-white text-emerald-700 ring-1 ring-emerald-300 hover:bg-emerald-50'
                    }`}
                  >
                    동의해요
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void handleConsent('declined')}
                    className={`rounded-xl py-4 text-base font-bold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 disabled:opacity-50 ${
                      receipt?.consent === 'declined'
                        ? 'bg-gray-700 text-white'
                        : 'bg-white text-gray-600 ring-1 ring-gray-300 hover:bg-gray-100'
                    }`}
                  >
                    동의하지 않아요
                  </button>
                </div>
                <p className="mt-2 text-xs text-gray-400 break-keep">
                  응답은 선생님께 전달되고, 나중에 다시 바꿀 수 있어요.
                </p>
              </div>
            )}
          </article>
        )}
      </main>
    </div>
  )
}
