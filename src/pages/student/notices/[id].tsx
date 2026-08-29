import { useEffect, useState, type JSX } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { onAuthStateChanged } from 'firebase/auth'
import { Timestamp, doc, getDoc } from 'firebase/firestore'
import { auth } from '../../../lib/firebase'
import { useUI } from '../../../components/ui/feedback'
import {
  COMMENT_MAX_LEN,
  addComment,
  deleteComment,
  formatNoticeDate,
  getAnnouncement,
  getReceipt,
  markRead,
  notifyTeacherOfComment,
  setConsent,
  watchComments,
  type Announcement,
  type ConsentValue,
  type NoticeComment,
  type Receipt,
} from '../../../lib/notices'

function formatCommentTime(ts: Timestamp | null): string {
  if (!ts) return ''
  const d = ts.toDate()
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

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

  // 댓글(의견 나누기)
  const [comments, setComments] = useState<NoticeComment[]>([])
  const [commentText, setCommentText] = useState<string>('')
  const [sendingComment, setSendingComment] = useState<boolean>(false)
  const [commentsBlocked, setCommentsBlocked] = useState<boolean>(false)

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

  // 댓글 실시간 구독 (승인된 학생만 — 권한 없으면 조용히 잠금)
  useEffect(() => {
    const classId = userData?.classId
    if (!uid || !classId || !aid || !notice) return
    if (userData?.status !== 'approved') {
      setCommentsBlocked(true)
      return
    }
    const unsub = watchComments(
      classId,
      aid,
      (list) => {
        setComments(list)
        setCommentsBlocked(false)
      },
      () => setCommentsBlocked(true)
    )
    return () => unsub()
  }, [uid, userData?.classId, userData?.status, aid, notice])

  const handleSendComment = async (): Promise<void> => {
    const classId = userData?.classId
    if (!uid || !classId || !aid || sendingComment) return
    const text = commentText.trim()
    if (!text) return
    const studentName = userData?.name || userData?.displayName || '학생'
    setSendingComment(true)
    try {
      await addComment(classId, aid, { uid, name: studentName, role: 'student' }, text)
      setCommentText('')
      void notifyTeacherOfComment(classId, notice?.title || '알림장', studentName)
    } catch (e) {
      console.error(e)
      toast('의견을 보내지 못했어요. 잠시 후 다시 시도해 주세요.', 'error')
    } finally {
      setSendingComment(false)
    }
  }

  const handleDeleteComment = async (cid: string): Promise<void> => {
    const classId = userData?.classId
    if (!classId || !aid) return
    const ok = await confirm({
      title: '의견을 삭제할까요?',
      confirmText: '삭제',
      cancelText: '취소',
      danger: true,
    })
    if (!ok) return
    try {
      await deleteComment(classId, aid, cid)
    } catch (e) {
      console.error(e)
      toast('삭제하지 못했어요.', 'error')
    }
  }

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
          <>
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
                <div className="flex flex-col items-start gap-1.5">
                  <p className="text-sm font-semibold text-gray-700">보호자/본인 동의가 필요해요</p>
                  {receipt?.consent && (
                    <span
                      className={`max-w-full rounded-full px-2.5 py-1 text-xs font-semibold ${
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

          {/* 의견 나누기 (댓글) — 반 오픈채팅 느낌 */}
          <section className="mt-4 overflow-hidden rounded-xl border border-gray-100 bg-white shadow-lg">
            <div className="border-b border-gray-100 px-5 py-3.5">
              <h2 className="text-sm font-bold text-gray-900">
                💬 의견 나누기 {comments.length > 0 && <span className="text-emerald-600">{comments.length}</span>}
              </h2>
            </div>

            {commentsBlocked ? (
              <p className="px-5 py-6 text-center text-sm text-gray-400 break-keep">
                선생님 승인이 끝나면 의견을 나눌 수 있어요.
              </p>
            ) : (
              <>
                <div className="max-h-96 space-y-3 overflow-y-auto px-4 py-4">
                  {comments.length === 0 && (
                    <p className="py-3 text-center text-sm text-gray-400">
                      첫 의견을 남겨 보세요!
                    </p>
                  )}
                  {comments.map((c) => {
                    const mine = c.authorId === uid
                    return (
                      <div key={c.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[85%] ${mine ? 'text-right' : 'text-left'}`}>
                          <p className="mb-0.5 px-1 text-[11px] text-gray-400">
                            {c.role === 'teacher' ? (
                              <span className="font-bold text-blue-600">👩‍🏫 {c.authorName} 선생님</span>
                            ) : (
                              <span className={mine ? 'font-semibold text-emerald-700' : ''}>{c.authorName}</span>
                            )}
                            <span className="ml-1.5">{formatCommentTime(c.createdAt)}</span>
                          </p>
                          <div
                            className={`inline-block rounded-2xl px-3.5 py-2 text-left text-sm leading-relaxed break-keep ${
                              c.role === 'teacher'
                                ? 'bg-blue-50 text-blue-900 ring-1 ring-blue-100'
                                : mine
                                  ? 'rounded-tr-sm bg-emerald-600 text-white'
                                  : 'rounded-tl-sm bg-gray-100 text-gray-800'
                            }`}
                          >
                            {c.text}
                          </div>
                          {mine && (
                            <button
                              onClick={() => void handleDeleteComment(c.id)}
                              className="ml-1 p-1 text-[11px] text-gray-300 hover:text-red-400"
                            >
                              삭제
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>

                <div className="flex items-center gap-2 border-t border-gray-100 bg-gray-50/60 px-3 py-2.5">
                  <input
                    type="text"
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleSendComment()
                    }}
                    maxLength={COMMENT_MAX_LEN}
                    placeholder="의견을 입력하세요..."
                    className="min-w-0 flex-1 rounded-full border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                  />
                  <button
                    onClick={() => void handleSendComment()}
                    disabled={sendingComment || !commentText.trim()}
                    className="shrink-0 rounded-full bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-emerald-700 disabled:opacity-40"
                  >
                    보내기
                  </button>
                </div>
              </>
            )}
          </section>
          </>
        )}
      </main>
    </div>
  )
}
