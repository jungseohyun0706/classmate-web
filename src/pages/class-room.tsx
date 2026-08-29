import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useRouter } from 'next/router'
import { onAuthStateChanged } from 'firebase/auth'
import {
  Timestamp,
  addDoc,
  collection,
  doc,
  getCountFromServer,
  getDoc,
  query,
  serverTimestamp,
  where,
} from 'firebase/firestore'
import { auth, db } from '../lib/firebase'
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

// 우리 반 이야기방 — 카카오톡 오픈채팅 스타일의 반 단톡방.
// 공지도 여기서 보냅니다(선생님 입력창의 📢 토글). 알림장 별도 화면은 관리(명단)용만 유지.

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
  const h = d.getHours()
  const ampm = h < 12 ? '오전' : '오후'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${ampm} ${h12}:${String(d.getMinutes()).padStart(2, '0')}`
}

function minuteKey(ts: Timestamp | null): string {
  if (!ts) return ''
  const d = ts.toDate()
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`
}

function dayKey(ts: Timestamp | null): string {
  if (!ts) return ''
  const d = ts.toDate()
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function formatDayLabel(ts: Timestamp | null): string {
  if (!ts) return ''
  const d = ts.toDate()
  const days = ['일', '월', '화', '수', '목', '금', '토']
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${days[d.getDay()]}요일`
}

/** 이름 첫 글자 아바타 색 (이름 기반 고정) */
const AVATAR_COLORS = ['bg-orange-300', 'bg-rose-300', 'bg-violet-300', 'bg-sky-300', 'bg-lime-300', 'bg-amber-300', 'bg-teal-300', 'bg-fuchsia-300']
function avatarColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 997
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

export default function ClassRoom(): JSX.Element {
  const router = useRouter()
  const { toast, confirm } = useUI()

  const [loading, setLoading] = useState(true)
  const [uid, setUid] = useState<string | null>(null)
  const [me, setMe] = useState<MyData | null>(null)
  const [blocked, setBlocked] = useState<'pending' | 'no-class' | null>(null)
  const [memberCount, setMemberCount] = useState<number | null>(null)

  const [notices, setNotices] = useState<Announcement[]>([])
  const [chat, setChat] = useState<ChatMessage[]>([])
  const [receipts, setReceipts] = useState<Record<string, Receipt>>({})
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [consentBusy, setConsentBusy] = useState<string | null>(null)

  // 공지 배너 + 공지 작성 토글
  const [bannerOpen, setBannerOpen] = useState(false)
  const [noticeMode, setNoticeMode] = useState(false)
  const [askConsent, setAskConsent] = useState(false)

  const feedRef = useRef<HTMLDivElement>(null)
  const stickBottom = useRef(true)

  // 백그라운드에서 돌아오면 구독을 새로 열어 밀린 메시지를 즉시 동기화
  const [wakeTick, setWakeTick] = useState(0)
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') setWakeTick((t) => t + 1)
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

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
        // 인원수(승인 학생 + 선생님) — 백그라운드
        void getCountFromServer(
          query(
            collection(db, 'users'),
            where('classId', '==', String(data.classId)),
            where('role', '==', 'student'),
            where('status', '==', 'approved')
          )
        )
          .then((s) => setMemberCount(s.data().count + 1))
          .catch(() => {})
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
    const un2 = watchChat(classId, setChat, (e) => console.error('채팅 구독 실패', e))
    return () => {
      un1()
      un2()
    }
  }, [classId, uid, wakeTick])

  // 학생: 읽음 확인 로드 + 자동 읽음 처리
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, uid, isTeacher, notices.length])

  const feed = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = [
      ...notices.map((n): FeedItem => ({ kind: 'notice', at: atOf(n.createdAt), notice: n })),
      ...chat.map((m): FeedItem => ({ kind: 'chat', at: atOf(m.createdAt), msg: m })),
    ]
    items.sort((a, b) => a.at - b.at)
    return items
  }, [notices, chat])

  const latestNotice = notices.length > 0 ? notices[notices.length - 1] : null

  useEffect(() => {
    const el = feedRef.current
    if (!el) return
    if (stickBottom.current) el.scrollTop = el.scrollHeight
  }, [feed.length, loading])

  const onFeedScroll = () => {
    const el = feedRef.current
    if (!el) return
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  // 반 구성원들에게 푸시 fan-out (실패해도 무시 — 방을 열어둔 사람은 실시간으로 받음)
  const firePush = (kind: 'chat' | 'notice', preview: string) => {
    void auth.currentUser
      ?.getIdToken()
      .then((t) =>
        fetch('/api/chat-push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
          body: JSON.stringify({ classId, kind, preview }),
        })
      )
      .catch(() => {})
  }

  const handleSend = async () => {
    if (!uid || !classId || sending) return
    const t = text.trim()
    if (!t) return
    setSending(true)
    try {
      if (isTeacher && noticeMode) {
        // 📢 공지로 보내기 — 알림장(announcements)으로 저장되어 읽음/동의 추적
        const firstLine = t.split('\n')[0].slice(0, 30)
        await addDoc(collection(db, 'classes', classId, 'announcements'), {
          title: firstLine,
          body: t,
          authorId: uid,
          authorName: myName,
          createdAt: serverTimestamp(),
          readCount: 0,
          requiresConsent: askConsent,
        })
        setNoticeMode(false)
        setAskConsent(false)
        toast('공지를 올렸어요. 학생들 확인 현황은 [명단]에서 볼 수 있어요.', 'success')
        firePush('notice', t)
      } else {
        await sendChat(classId, { uid, name: myName, role: isTeacher ? 'teacher' : 'student' }, t)
        firePush('chat', t)
      }
      setText('')
      stickBottom.current = true
    } catch (e) {
      console.error(e)
      toast('보내지 못했어요. 잠시 후 다시 시도해 주세요.', 'error')
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

  const classLabel = me ? `${me.grade}학년 ${me.classNm}반` : ''

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center" style={{ background: '#b2c7d9' }}>
        <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-gray-700" />
      </div>
    )
  }

  if (blocked) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-6 text-center text-black">
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
    <div className="flex h-[100dvh] flex-col text-black" style={{ background: '#b2c7d9' }}>
      {/* 헤더 — 카톡 채팅방풍 */}
      <header className="shrink-0" style={{ background: '#a6bdd1' }}>
        <div className="mx-auto flex h-13 max-w-2xl items-center justify-between gap-2 px-2 py-2.5">
          <div className="flex min-w-0 items-center gap-1">
            <button
              onClick={() => router.push(isTeacher ? '/dashboard' : '/student/today')}
              className="shrink-0 rounded-lg p-2 text-gray-700 hover:bg-black/5"
              aria-label="뒤로"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><path d="m15 6-6 6 6 6"/></svg>
            </button>
            <div className="min-w-0">
              <h1 className="flex items-center gap-1.5 truncate text-[15px] font-bold text-gray-900">
                {classLabel} 이야기방
                {memberCount !== null && <span className="text-[13px] font-medium text-gray-600">{memberCount}</span>}
              </h1>
            </div>
          </div>
          {isTeacher && (
            <button
              onClick={() => router.push('/teacher/notices')}
              className="shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-xs font-bold text-gray-700 hover:bg-black/5"
            >
              ☰ 명단
            </button>
          )}
        </div>

        {/* 📢 고정 공지 배너 (카톡 공지) */}
        {latestNotice && (
          <div className="mx-auto max-w-2xl px-2 pb-2">
            <button
              onClick={() => setBannerOpen((v) => !v)}
              className="flex w-full items-center gap-2 rounded-lg bg-white/95 px-3 py-2 text-left shadow-sm"
            >
              <span className="shrink-0 text-sm">📢</span>
              <span className={`min-w-0 flex-1 text-[13px] text-gray-800 ${bannerOpen ? 'break-keep' : 'truncate'}`}>
                {bannerOpen ? latestNotice.body : latestNotice.title}
              </span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${bannerOpen ? 'rotate-180' : ''}`}><path d="m6 9 6 6 6-6"/></svg>
            </button>
            {bannerOpen && !isTeacher && latestNotice.requiresConsent && !receipts[latestNotice.id]?.consent && (
              <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                <button
                  disabled={consentBusy === latestNotice.id}
                  onClick={() => void handleConsent(latestNotice, 'agreed')}
                  className="rounded-lg bg-emerald-600 py-2 text-sm font-bold text-white disabled:opacity-50"
                >
                  동의해요
                </button>
                <button
                  disabled={consentBusy === latestNotice.id}
                  onClick={() => void handleConsent(latestNotice, 'declined')}
                  className="rounded-lg bg-white py-2 text-sm font-bold text-gray-600 disabled:opacity-50"
                >
                  동의 안 해요
                </button>
              </div>
            )}
          </div>
        )}
      </header>

      {/* 피드 */}
      <div ref={feedRef} onScroll={onFeedScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-3 py-3">
          {feed.length === 0 && (
            <p className="py-16 text-center text-sm text-gray-600 break-keep">
              아직 이야기가 없어요. 첫 메시지를 남겨 보세요!
            </p>
          )}

          {feed.map((item, idx) => {
            const ts = item.kind === 'notice' ? item.notice.createdAt : item.msg.createdAt
            const dk = dayKey(ts)
            const showDay = dk && dk !== lastDay
            if (showDay) lastDay = dk

            // 연속 메시지 묶음 계산 (채팅만)
            const prev = idx > 0 ? feed[idx - 1] : null
            const next = idx < feed.length - 1 ? feed[idx + 1] : null
            const sameAuthorAsPrev =
              !showDay &&
              item.kind === 'chat' &&
              prev?.kind === 'chat' &&
              prev.msg.authorId === item.msg.authorId &&
              minuteKey(prev.msg.createdAt) === minuteKey(item.msg.createdAt)
            const sameAuthorAsNext =
              item.kind === 'chat' &&
              next?.kind === 'chat' &&
              next.msg.authorId === item.msg.authorId &&
              minuteKey(next.msg.createdAt) === minuteKey(item.msg.createdAt) &&
              dayKey(next.msg.createdAt) === dk
            const showTime = !sameAuthorAsNext

            return (
              <div key={item.kind === 'notice' ? `n-${item.notice.id}` : `c-${item.msg.id}`}>
                {showDay && (
                  <div className="my-3 flex items-center justify-center">
                    <span className="rounded-full bg-black/10 px-3.5 py-1 text-[11px] font-medium text-gray-700">
                      {formatDayLabel(ts)}
                    </span>
                  </div>
                )}

                {item.kind === 'notice' ? (
                  /* 공지 메시지 — 카톡 공지 카드풍 */
                  <div className="my-2 flex justify-center">
                    <div className="w-full max-w-md overflow-hidden rounded-xl bg-white/95 shadow-sm">
                      <div className="flex items-center gap-1.5 border-b border-gray-100 px-3.5 py-2">
                        <span className="text-[13px]">📢</span>
                        <span className="text-xs font-bold text-gray-700">공지 · {item.notice.authorName} 선생님</span>
                        <span className="ml-auto text-[10px] text-gray-400">{formatTime(item.notice.createdAt)}</span>
                      </div>
                      <div className="px-3.5 py-2.5">
                        <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-gray-800 break-keep">
                          {item.notice.body}
                        </p>
                        {item.notice.attachmentUrl && (
                          <a
                            href={item.notice.attachmentUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-2 flex items-center gap-1.5 rounded-lg bg-gray-50 px-2.5 py-1.5 text-xs text-gray-700"
                          >
                            📎 <span className="min-w-0 flex-1 truncate">{item.notice.attachmentName || '첨부파일'}</span>
                          </a>
                        )}
                        {isTeacher ? (
                          <p className="mt-1.5 text-[11px] text-gray-400">
                            읽음 {item.notice.readCount}명{item.notice.requiresConsent && ' · 동의 필요'}
                          </p>
                        ) : (
                          item.notice.requiresConsent && (
                            <div className="mt-2">
                              {receipts[item.notice.id]?.consent ? (
                                <span
                                  className={`inline-block rounded-full px-2.5 py-1 text-[11px] font-semibold ${
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
                                    className="ml-1.5 underline opacity-60"
                                  >
                                    바꾸기
                                  </button>
                                </span>
                              ) : (
                                <div className="grid grid-cols-2 gap-1.5">
                                  <button
                                    disabled={consentBusy === item.notice.id}
                                    onClick={() => void handleConsent(item.notice, 'agreed')}
                                    className="rounded-lg bg-emerald-600 py-2 text-[13px] font-bold text-white disabled:opacity-50"
                                  >
                                    동의해요
                                  </button>
                                  <button
                                    disabled={consentBusy === item.notice.id}
                                    onClick={() => void handleConsent(item.notice, 'declined')}
                                    className="rounded-lg bg-gray-100 py-2 text-[13px] font-bold text-gray-600 disabled:opacity-50"
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
                  </div>
                ) : (
                  /* 채팅 말풍선 — 카톡풍 */
                  (() => {
                    const m = item.msg
                    const mine = m.authorId === uid
                    if (mine) {
                      return (
                        <div className={`flex items-end justify-end gap-1 ${sameAuthorAsPrev ? 'mt-1' : 'mt-2.5'}`}>
                          {showTime && (
                            <span className="mb-0.5 shrink-0 text-[10px] text-gray-600/80">{formatTime(m.createdAt)}</span>
                          )}
                          <div className="group relative max-w-[72%]">
                            <div
                              className="inline-block whitespace-pre-wrap rounded-2xl rounded-tr-md px-3 py-1.5 text-left text-[13.5px] leading-relaxed text-gray-900 break-keep shadow-sm"
                              style={{ background: '#fee500' }}
                            >
                              {m.text}
                            </div>
                            <button
                              onClick={() => void handleDelete(m.id)}
                              className="absolute -left-8 top-1/2 hidden -translate-y-1/2 rounded p-1 text-[10px] text-gray-500 group-hover:block"
                            >
                              삭제
                            </button>
                          </div>
                        </div>
                      )
                    }
                    return (
                      <div className={`flex items-start gap-2 ${sameAuthorAsPrev ? 'mt-1 pl-10' : 'mt-2.5'}`}>
                        {!sameAuthorAsPrev && (
                          <div
                            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[14px] text-sm font-bold text-white ${
                              m.role === 'teacher' ? 'bg-blue-500' : avatarColor(m.authorName)
                            }`}
                          >
                            {m.role === 'teacher' ? '👩‍🏫' : (m.authorName || '?').charAt(0)}
                          </div>
                        )}
                        <div className="min-w-0 max-w-[72%]">
                          {!sameAuthorAsPrev && (
                            <p className="mb-1 text-[11.5px] text-gray-700">
                              {m.authorName}
                              {m.role === 'teacher' && (
                                <span className="ml-1 rounded bg-blue-500/90 px-1 py-px text-[9px] font-bold text-white align-[1px]">선생님</span>
                              )}
                            </p>
                          )}
                          <div className="flex items-end gap-1">
                            <div className="group relative">
                              <div className="inline-block whitespace-pre-wrap rounded-2xl rounded-tl-md bg-white px-3 py-1.5 text-left text-[13.5px] leading-relaxed text-gray-900 break-keep shadow-sm">
                                {m.text}
                              </div>
                              {isTeacher && (
                                <button
                                  onClick={() => void handleDelete(m.id)}
                                  className="absolute -right-8 top-1/2 hidden -translate-y-1/2 rounded p-1 text-[10px] text-gray-500 group-hover:block"
                                >
                                  삭제
                                </button>
                              )}
                            </div>
                            {showTime && (
                              <span className="mb-0.5 shrink-0 text-[10px] text-gray-600/80">{formatTime(m.createdAt)}</span>
                            )}
                          </div>
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
        className="shrink-0 bg-white px-2 pt-1.5"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.375rem)' }}
      >
        <div className="mx-auto max-w-2xl">
          {isTeacher && (
            <div className="flex items-center gap-2 px-1 pb-1">
              <button
                onClick={() => setNoticeMode((v) => !v)}
                className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${
                  noticeMode ? 'bg-amber-400 text-gray-900' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                }`}
              >
                📢 공지로 보내기
              </button>
              {noticeMode && (
                <label className="flex items-center gap-1.5 text-xs text-gray-600">
                  <input
                    type="checkbox"
                    checked={askConsent}
                    onChange={(e) => setAskConsent(e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  동의 받기
                </label>
              )}
            </div>
          )}
          <div className="flex items-end gap-1.5">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void handleSend()
                }
              }}
              maxLength={CHAT_MAX_LEN}
              rows={1}
              placeholder={noticeMode ? '공지 내용을 입력하세요...' : '메시지 입력'}
              className={`max-h-28 min-w-0 flex-1 resize-none rounded-2xl border-0 px-3.5 py-2.5 text-[14px] text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-0 ${
                noticeMode ? 'bg-amber-50' : 'bg-gray-100'
              }`}
            />
            <button
              onClick={() => void handleSend()}
              disabled={sending || !text.trim()}
              className={`shrink-0 rounded-full px-3.5 py-2.5 text-sm font-bold transition disabled:opacity-30 ${
                text.trim() ? 'text-gray-900' : 'text-gray-400'
              }`}
              style={{ background: text.trim() ? '#fee500' : '#f3f4f6' }}
            >
              전송
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
