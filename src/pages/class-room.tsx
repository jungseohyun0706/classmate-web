import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useRouter } from 'next/router'
import { onAuthStateChanged } from 'firebase/auth'
import { Timestamp, doc, getDoc } from 'firebase/firestore'
import { auth } from '../lib/firebase'
import { useUI } from '../components/ui/feedback'
import {
  formatNoticeDate,
  getMyReceipts,
  markRead,
  setConsent,
  watchAnnouncements,
  type Announcement,
  type ConsentValue,
  type Receipt,
} from '../lib/notices'
import { CHAT_MAX_LEN, deleteChat, sendChat, watchChat, type ChatMessage } from '../lib/classChat'

// 우리 반 이야기방 — 공지(알림장)와 반 대화가 한 흐름에 섞이는 오픈채팅방.
// 교사(담임)와 승인된 학생이 같은 화면을 사용합니다.

interface MyData {
  role?: string
  displayName?: string
  name?: string
  classId?: string
  schoolName?: string
  grade?: string | number
  classNm?: string | number
  status?: string
}

type FeedItem =
  | { kind: 'notice'; at: number; notice: Announcement }
  | { kind: 'chat'; at: number; msg: ChatMessage }

const atOf = (ts: Timestamp | null): number => (ts ? ts.toMillis() : Number.MAX_SAFE_INTEGER)

function formatTime(ts: Timestamp | null): string {
  if (!ts) return ''
  const d = ts.toDate()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 날짜 구분선용 (YYYY-M-D) */
function dayKey(ts: Timestamp | null): string {
  if (!ts) return ''
  const d = ts.toDate()
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

export default function ClassRoom(): JSX.Element {
  const router = useRouter()
  const { toast, confirm } = useUI()

  const [loading, setLoading] = useState(true)
  const [uid, setUid] = useState<string | null>(null)
  const [me, setMe] = useState<MyData | null>(null)
  const [blocked, setBlocked] = useState<'pending' | 'no-class' | null>(null)

  const [notices, setNotices] = useState<Announcement[]>([])
  const [chat, setChat] = useState<ChatMessage[]>([])
  const [receipts, setReceipts] = useState<Record<string, Receipt>>({})
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [consentBusy, setConsentBusy] = useState<string | null>(null)

  const feedRef = useRef<HTMLDivElement>(null)
  const stickBottom = useRef(true)

  const isTeacher = me?.role === 'teacher'
  const myName = me?.name || me?.displayName || (isTeacher ? '선생님' : '학생')
  const classId = me?.classId || ''

  // 로그인 + 역할/반 확인
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.replace('/auth/login')
        return
      }
      try {
        const { db } = await import('../lib/firebase')
        const snap = await getDoc(doc(db, 'users', u.uid))
        const data = snap.exists() ? (snap.data() as MyData) : null
        if (!data) {
          router.replace('/auth/login')
          return
        }
        if (!data.classId) {
          setBlocked('no-class')
          setLoading(false)
          return
        }
        if (data.role === 'student' && data.status !== 'approved') {
          setBlocked('pending')
          setLoading(false)
          return
        }
        setUid(u.uid)
        setMe(data)
      } catch (e) {
        console.error(e)
        setLoading(false)
      }
    })
    return () => unsub()
  }, [router])

  // 공지 + 채팅 실시간 구독
  useEffect(() => {
    if (!classId || !uid) return
    let first = true
    const done = () => {
      if (first) {
        first = false
        setLoading(false)
      }
    }
    const un1 = watchAnnouncements(
      classId,
      (list) => {
        setNotices(list)
        done()
      },
      (e) => {
        console.error('공지 구독 실패', e)
        done()
      }
    )
    const un2 = watchChat(
      classId,
      (list) => {
        setChat(list)
        done()
      },
      (e) => console.error('채팅 구독 실패', e)
    )
    return () => {
      un1()
      un2()
    }
  }, [classId, uid])

  // 학생: 내 읽음 확인 로드 + 새 공지 자동 읽음 처리
  useEffect(() => {
    if (!classId || !uid || isTeacher || notices.length === 0) return
    let cancelled = false
    ;(async () => {
      try {
        const mine = await getMyReceipts(classId, notices.map((n) => n.id), uid)
        if (cancelled) return
        setReceipts(mine)
        for (const n of notices) {
          if (!mine[n.id]) {
            markRead(classId, n.id, uid, myName)
              .then(() => {
                if (!cancelled) {
                  setReceipts((prev) => ({
                    ...prev,
                    [n.id]: { readAt: Timestamp.now(), studentName: myName },
                  }))
                }
              })
              .catch(() => {})
          }
        }
      } catch (e) {
        console.error(e)
      }
    })()
    return () => {
      cancelled = true
    }
    // notices.length만 봐서 새 공지 도착 시에만 재실행
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, uid, isTeacher, notices.length])

  // 병합 피드
  const feed = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = [
      ...notices.map((n): FeedItem => ({ kind: 'notice', at: atOf(n.createdAt), notice: n })),
      ...chat.map((m): FeedItem => ({ kind: 'chat', at: atOf(m.createdAt), msg: m })),
    ]
    items.sort((a, b) => a.at - b.at)
    return items
  }, [notices, chat])

  // 새 메시지 오면 (바닥 근처일 때) 자동 스크롤
  useEffect(() => {
    const el = feedRef.current
    if (!el) return
    if (stickBottom.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [feed.length, loading])

  const onFeedScroll = () => {
    const el = feedRef.current
    if (!el) return
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  const handleSend = async () => {
    if (!uid || !classId || sending) return
    const t = text.trim()
    if (!t) return
    setSending(true)
    try {
      await sendChat(classId, { uid, name: myName, role: isTeacher ? 'teacher' : 'student' }, t)
      setText('')
      stickBottom.current = true
    } catch (e) {
      console.error(e)
      toast('메시지를 보내지 못했어요. 잠시 후 다시 시도해 주세요.', 'error')
    } finally {
      setSending(false)
    }
  }

  const handleDelete = async (mid: string) => {
    if (!classId) return
    const ok = await confirm({ title: '메시지를 삭제할까요?', confirmText: '삭제', cancelText: '취소', danger: true })
    if (!ok) return
    try {
      await deleteChat(classId, mid)
    } catch (e) {
      console.error(e)
      toast('삭제하지 못했어요.', 'error')
    }
  }

  const handleConsent = async (n: Announcement, value: ConsentValue) => {
    if (!uid || !classId || consentBusy) return
    if (receipts[n.id]?.consent === value) return
    setConsentBusy(n.id)
    try {
      await setConsent(classId, n.id, uid, myName, value)
      setReceipts((prev) => ({
        ...prev,
        [n.id]: {
          readAt: prev[n.id]?.readAt ?? null,
          studentName: myName,
          consent: value,
          consentAt: Timestamp.now(),
        },
      }))
      toast(value === 'agreed' ? '동의를 전달했어요.' : "'동의하지 않음'으로 전달했어요.", 'success')
    } catch (e) {
      console.error(e)
      toast('저장하지 못했어요.', 'error')
    } finally {
      setConsentBusy(null)
    }
  }

  const accent = isTeacher ? 'blue' : 'emerald'
  const classLabel = me ? `${me.grade}학년 ${me.classNm}반` : ''

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className={`h-12 w-12 animate-spin rounded-full border-b-2 ${isTeacher ? 'border-blue-600' : 'border-emerald-600'}`} />
      </div>
    )
  }

  if (blocked) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-6 text-center">
        <p className="text-3xl">💬</p>
        <p className="mt-3 font-bold text-gray-900">
          {blocked === 'pending' ? '선생님 승인을 기다리고 있어요' : '아직 소속된 반이 없어요'}
        </p>
        <p className="mt-1 text-sm text-gray-500 break-keep">
          {blocked === 'pending'
            ? '승인이 끝나면 우리 반 이야기방에 들어올 수 있어요.'
            : '반에 들어가면 이야기방이 열려요.'}
        </p>
        <button
          onClick={() => router.replace(blocked === 'pending' ? '/student/today' : '/dashboard')}
          className="mt-5 rounded-xl bg-gray-900 px-6 py-3 text-sm font-bold text-white"
        >
          돌아가기
        </button>
      </div>
    )
  }

  let lastDay = ''

  return (
    <div className="flex h-[100dvh] flex-col bg-gray-100 text-black">
      {/* 헤더 */}
      <header className="shrink-0 border-b border-gray-200 bg-white">
        <div className="mx-auto flex h-14 max-w-2xl items-center justify-between gap-2 px-3">
          <div className="flex min-w-0 items-center gap-2">
            <button
              onClick={() => router.push(isTeacher ? '/dashboard' : '/student/today')}
              className="shrink-0 rounded-lg p-2 text-gray-500 hover:bg-gray-100"
              aria-label="뒤로"
            >
              ←
            </button>
            <div className="min-w-0">
              <h1 className="truncate text-base font-bold text-gray-900">{classLabel} 이야기방</h1>
              <p className="truncate text-[11px] text-gray-400">{me?.schoolName}</p>
            </div>
          </div>
          {isTeacher && (
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                onClick={() => router.push('/teacher/notice/write')}
                className="whitespace-nowrap rounded-lg bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-700"
              >
                ✏️ 공지
              </button>
              <button
                onClick={() => router.push('/teacher/notices')}
                className="whitespace-nowrap rounded-lg border border-gray-200 px-3 py-2 text-xs font-bold text-gray-600 hover:bg-gray-50"
              >
                확인 명단
              </button>
            </div>
          )}
        </div>
      </header>

      {/* 피드 */}
      <div ref={feedRef} onScroll={onFeedScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-3 px-3 py-4">
          {feed.length === 0 && (
            <p className="py-16 text-center text-sm text-gray-400 break-keep">
              아직 이야기가 없어요. 첫 메시지를 남겨 보세요!
            </p>
          )}

          {feed.map((item) => {
            const ts = item.kind === 'notice' ? item.notice.createdAt : item.msg.createdAt
            const dk = dayKey(ts)
            const showDay = dk && dk !== lastDay
            if (showDay) lastDay = dk

            return (
              <div key={item.kind === 'notice' ? `n-${item.notice.id}` : `c-${item.msg.id}`}>
                {showDay && (
                  <div className="my-4 flex items-center justify-center">
                    <span className="rounded-full bg-gray-200/80 px-3 py-1 text-[11px] font-medium text-gray-500">
                      {formatNoticeDate(ts)}
                    </span>
                  </div>
                )}

                {item.kind === 'notice' ? (
                  /* 공지 카드 */
                  <div className="overflow-hidden rounded-2xl border border-amber-200 bg-white shadow-sm">
                    <div className="flex items-center justify-between gap-2 bg-amber-50 px-4 py-2">
                      <span className="text-xs font-bold text-amber-700">
                        📢 공지 · {item.notice.authorName} 선생님
                      </span>
                      <span className="text-[11px] text-amber-600/70">{formatTime(item.notice.createdAt)}</span>
                    </div>
                    <div className="px-4 py-3">
                      <p className="font-bold text-gray-900 break-keep">{item.notice.title}</p>
                      <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-gray-700 break-keep">
                        {item.notice.body}
                      </p>
                      {item.notice.attachmentUrl && (
                        <a
                          href={item.notice.attachmentUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-2.5 flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700 ring-1 ring-gray-200 hover:bg-gray-100"
                        >
                          📎 <span className="min-w-0 flex-1 truncate">{item.notice.attachmentName || '첨부파일'}</span>
                          <span className="shrink-0 text-xs font-bold text-emerald-600">열기</span>
                        </a>
                      )}

                      {/* 교사: 읽음 현황 / 학생: 동의 버튼 */}
                      {isTeacher ? (
                        <p className="mt-2.5 text-xs text-gray-400">
                          읽음 {item.notice.readCount}명
                          {item.notice.requiresConsent && ' · 동의 필요 공지'}
                        </p>
                      ) : (
                        item.notice.requiresConsent && (
                          <div className="mt-3">
                            {receipts[item.notice.id]?.consent ? (
                              <span
                                className={`inline-block rounded-full px-2.5 py-1 text-xs font-semibold ${
                                  receipts[item.notice.id].consent === 'agreed'
                                    ? 'bg-emerald-100 text-emerald-800'
                                    : 'bg-gray-200 text-gray-600'
                                }`}
                              >
                                {receipts[item.notice.id].consent === 'agreed' ? '✓ 동의했어요' : '동의하지 않았어요'}
                                <button
                                  onClick={() =>
                                    void handleConsent(
                                      item.notice,
                                      receipts[item.notice.id].consent === 'agreed' ? 'declined' : 'agreed'
                                    )
                                  }
                                  className="ml-2 underline opacity-60"
                                >
                                  바꾸기
                                </button>
                              </span>
                            ) : (
                              <div className="grid grid-cols-2 gap-2">
                                <button
                                  disabled={consentBusy === item.notice.id}
                                  onClick={() => void handleConsent(item.notice, 'agreed')}
                                  className="rounded-xl bg-emerald-600 py-2.5 text-sm font-bold text-white disabled:opacity-50"
                                >
                                  동의해요
                                </button>
                                <button
                                  disabled={consentBusy === item.notice.id}
                                  onClick={() => void handleConsent(item.notice, 'declined')}
                                  className="rounded-xl bg-white py-2.5 text-sm font-bold text-gray-600 ring-1 ring-gray-300 disabled:opacity-50"
                                >
                                  동의 안 해요
                                </button>
                              </div>
                            )}
                          </div>
                        )
                      )}
                    </div>
                  </div>
                ) : (
                  /* 채팅 말풍선 */
                  (() => {
                    const m = item.msg
                    const mine = m.authorId === uid
                    return (
                      <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[85%] ${mine ? 'text-right' : 'text-left'}`}>
                          {!mine && (
                            <p className="mb-0.5 px-1 text-[11px] text-gray-400">
                              {m.role === 'teacher' ? (
                                <span className="font-bold text-blue-600">👩‍🏫 {m.authorName} 선생님</span>
                              ) : (
                                m.authorName
                              )}
                            </p>
                          )}
                          <div className="flex items-end gap-1.5">
                            {mine && (
                              <span className="order-first shrink-0 text-[10px] text-gray-400">{formatTime(m.createdAt)}</span>
                            )}
                            <div
                              className={`inline-block rounded-2xl px-3.5 py-2 text-left text-sm leading-relaxed break-keep ${
                                mine
                                  ? isTeacher
                                    ? 'rounded-tr-sm bg-blue-600 text-white'
                                    : 'rounded-tr-sm bg-emerald-600 text-white'
                                  : m.role === 'teacher'
                                    ? 'rounded-tl-sm bg-blue-50 text-blue-900 ring-1 ring-blue-100'
                                    : 'rounded-tl-sm bg-white text-gray-800 ring-1 ring-gray-200'
                              }`}
                            >
                              {m.text}
                            </div>
                            {!mine && (
                              <span className="shrink-0 text-[10px] text-gray-400">{formatTime(m.createdAt)}</span>
                            )}
                          </div>
                          {(mine || isTeacher) && (
                            <button
                              onClick={() => void handleDelete(m.id)}
                              className="px-1 py-0.5 text-[10px] text-gray-300 hover:text-red-400"
                            >
                              삭제
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })()
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* 입력 바 */}
      <div
        className="shrink-0 border-t border-gray-200 bg-white px-3 py-2.5"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.625rem)' }}
      >
        <div className="mx-auto flex max-w-2xl items-center gap-2">
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleSend()
            }}
            maxLength={CHAT_MAX_LEN}
            placeholder={`${classLabel}에 메시지 보내기...`}
            className={`min-w-0 flex-1 rounded-full border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-900 placeholder-gray-400 focus:bg-white focus:outline-none focus:ring-1 ${
              accent === 'blue' ? 'focus:border-blue-400 focus:ring-blue-400' : 'focus:border-emerald-400 focus:ring-emerald-400'
            }`}
          />
          <button
            onClick={() => void handleSend()}
            disabled={sending || !text.trim()}
            className={`shrink-0 rounded-full px-4 py-3 text-sm font-bold text-white transition disabled:opacity-40 ${
              accent === 'blue' ? 'bg-blue-600 hover:bg-blue-700' : 'bg-emerald-600 hover:bg-emerald-700'
            }`}
          >
            보내기
          </button>
        </div>
      </div>
    </div>
  )
}
