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
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  where,
} from 'firebase/firestore'
import { auth, db } from '../lib/firebase'
import { useUI } from '../components/ui/feedback'
import {
  checkNotice,
  formatNoticeDate,
  getMyReceipts,
  markRead,
  watchAnnouncements,
  type Announcement,
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

/** classId → '1학년 3반' (수업 그룹 `{base}_g_{uid6}`이면 '1학년 3반 수업') */
function labelOf(classId: string): string {
  const isGroup = /_g_[A-Za-z0-9]+$/.test(classId)
  const parts = classId.replace(/_g_[A-Za-z0-9]+$/, '').split('_')
  if (parts.length < 3) return classId
  const base = `${parts[parts.length - 2]}학년 ${parts[parts.length - 1]}반`
  return isGroup ? `${base} 수업` : base
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
  // 교사: 현재 보고 있는 반 + 전환 가능한 반 목록 (담임 반 + 수업 반)
  const [roomClassId, setRoomClassId] = useState('')
  const [managed, setManaged] = useState<string[]>([])

  const [notices, setNotices] = useState<Announcement[]>([])
  const [chat, setChat] = useState<ChatMessage[]>([])
  const [receipts, setReceipts] = useState<Record<string, Receipt>>({})
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [consentBusy, setConsentBusy] = useState<string | null>(null)

  // 공지 배너 + 공지 작성 토글
  const [bannerOpen, setBannerOpen] = useState(false)
  const [noticeMode, setNoticeMode] = useState(false)

  // 교사용: 공지 확인 명단 시트
  const [rosterFor, setRosterFor] = useState<Announcement | null>(null)
  const [rosterStudents, setRosterStudents] = useState<{ id: string; name: string; no: number }[] | null>(null)
  const [rosterChecked, setRosterChecked] = useState<Record<string, Timestamp | null>>({})

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
  const classId = roomClassId

  // 반 전환 (교사)
  const switchRoom = (id: string) => {
    if (id === roomClassId) return
    setNotices([])
    setChat([])
    setReceipts({})
    setRosterFor(null)
    setRosterStudents(null)
    setBannerOpen(false)
    setMemberCount(null)
    setRoomClassId(id)
  }

  // 인원수(본반 + 추가 참여 학생 + 담임) — 반이 바뀔 때마다
  useEffect(() => {
    if (!classId) return
    void Promise.all([
      getCountFromServer(
        query(
          collection(db, 'users'),
          where('classId', '==', classId),
          where('role', '==', 'student'),
          where('status', '==', 'approved')
        )
      ),
      getCountFromServer(
        query(
          collection(db, 'users'),
          where('extraClassIds', 'array-contains', classId),
          where('role', '==', 'student'),
          where('status', '==', 'approved')
        )
      ),
    ])
      .then(([a, b]) => setMemberCount(a.data().count + b.data().count + 1))
      .catch(() => {})
  }, [classId])

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
        if (data.role === 'student') {
          if (!data.classId) {
            setBlocked('no-class')
            setLoading(false)
            return
          }
          if (data.status !== 'approved') {
            setBlocked('pending')
            setLoading(false)
            return
          }
          // 본반 + 추가 참여 반
          const extras: string[] = Array.isArray((data as any).extraClassIds)
            ? (data as any).extraClassIds.filter((x: unknown) => typeof x === 'string')
            : []
          const m = [String(data.classId), ...extras.filter((id) => id !== data.classId)]
          setManaged(m)
          const requested = new URLSearchParams(window.location.search).get('classId')
          setRoomClassId(requested && m.includes(requested) ? requested : m[0])
        } else {
          // 교사: 담임 반 + 수업 반 중 선택 (?classId= 우선)
          const teachingIds: string[] = Array.isArray((data as any).teachingClassIds)
            ? (data as any).teachingClassIds.filter((x: unknown) => typeof x === 'string')
            : []
          const m = [...(data.classId ? [String(data.classId)] : []), ...teachingIds]
          setManaged(m)
          const requested = new URLSearchParams(window.location.search).get('classId')
          const target = requested || m[0] || ''
          if (!target) {
            setBlocked('no-class')
            setLoading(false)
            return
          }
          setRoomClassId(target)
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
          checkCount: 0,
          requiresConsent: false,
        })
        setNoticeMode(false)
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

  // 학생: 공지 확인 체크
  const handleCheck = async (n: Announcement) => {
    if (!uid || !classId || consentBusy) return
    if (receipts[n.id]?.consent === 'agreed') return
    setConsentBusy(n.id)
    try {
      await checkNotice(classId, n.id, uid, myName)
      setReceipts((prev) => ({
        ...prev,
        [n.id]: {
          readAt: prev[n.id]?.readAt ?? null,
          studentName: myName,
          consent: 'agreed',
          consentAt: Timestamp.now(),
        },
      }))
      toast('확인 체크 완료! ✔', 'success')
    } catch (e) {
      console.error(e)
      toast('저장하지 못했어요.', 'error')
    } finally {
      setConsentBusy(null)
    }
  }

  // 교사: 공지 확인 명단 시트 — 학생 목록 1회 로드 + 확인(receipts) 실시간 구독
  useEffect(() => {
    if (!isTeacher || !rosterFor || !classId) return
    let cancelled = false
    if (!rosterStudents) {
      void Promise.all([
        getDocs(
          query(
            collection(db, 'users'),
            where('classId', '==', classId),
            where('role', '==', 'student'),
            where('status', '==', 'approved')
          )
        ),
        getDocs(
          query(
            collection(db, 'users'),
            where('extraClassIds', 'array-contains', classId),
            where('role', '==', 'student'),
            where('status', '==', 'approved')
          )
        ),
      ]).then(([homeSnap, extraSnap]) => {
        if (cancelled) return
        const seen = new Set<string>()
        const list: { id: string; name: string; no: number }[] = []
        for (const d of [...homeSnap.docs, ...extraSnap.docs]) {
          if (seen.has(d.id)) continue
          seen.add(d.id)
          const v = d.data()
          const no = parseInt(String(v.studentId ?? ''), 10)
          list.push({
            id: d.id,
            name: String(v.name || v.displayName || '이름 없음'),
            no: Number.isFinite(no) ? no : 9999,
          })
        }
        list.sort((a, b) => (a.no !== b.no ? a.no - b.no : a.name.localeCompare(b.name, 'ko')))
        setRosterStudents(list)
      })
    }
    const unsub = onSnapshot(
      collection(db, 'classes', classId, 'announcements', rosterFor.id, 'receipts'),
      (snap) => {
        if (cancelled) return
        const map: Record<string, Timestamp | null> = {}
        snap.forEach((d) => {
          const v = d.data()
          if (v.consent === 'agreed') {
            map[d.id] = v.consentAt instanceof Timestamp ? v.consentAt : null
          }
        })
        setRosterChecked(map)
      },
      (e) => console.error('명단 구독 실패', e)
    )
    return () => {
      cancelled = true
      unsub()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTeacher, rosterFor?.id, classId])

  const classLabel = classId ? labelOf(classId) : me ? `${me.grade}학년 ${me.classNm}반` : ''
  const roomOptions = managed.includes(classId) || !classId ? managed : [...managed, classId]

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
            ? '승인이 끝나면 우리 반 톡방에 들어올 수 있어요.'
            : '반에 들어가면 톡방이 열려요. 선생님은 학생 관리에서 수업 반을 추가해 주세요.'}
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
              {roomOptions.length > 1 ? (
                <div className="flex items-center gap-1.5">
                  <select
                    value={classId}
                    onChange={(e) => switchRoom(e.target.value)}
                    className="max-w-[13rem] truncate appearance-none rounded-xl border border-black/10 bg-white/70 pl-3 pr-8 py-2 text-base font-bold text-gray-900 shadow-sm focus:outline-none"
                    style={{
                      backgroundImage:
                        "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23555' stroke-width='2.5' stroke-linecap='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
                      backgroundRepeat: 'no-repeat',
                      backgroundPosition: 'right 0.6rem center',
                      backgroundSize: '1rem',
                    }}
                  >
                    {roomOptions.map((id) => (
                      <option key={id} value={id}>
                        {id === me?.classId ? `🏠 ${labelOf(id)}` : labelOf(id)}
                      </option>
                    ))}
                  </select>
                  <span className="text-[15px] font-bold text-gray-900">톡방</span>
                  {memberCount !== null && (
                    <span className="text-[13px] font-medium text-gray-600">{memberCount}</span>
                  )}
                </div>
              ) : (
                <h1 className="flex items-center gap-1.5 truncate text-[15px] font-bold text-gray-900">
                  {classLabel} 톡방
                  {memberCount !== null && <span className="text-[13px] font-medium text-gray-600">{memberCount}</span>}
                </h1>
              )}
            </div>
          </div>
          {isTeacher && classId === me?.classId && (
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
            {bannerOpen && !isTeacher && receipts[latestNotice.id]?.consent !== 'agreed' && (
              <button
                disabled={consentBusy === latestNotice.id}
                onClick={() => void handleCheck(latestNotice)}
                className="mt-1.5 w-full rounded-lg bg-emerald-600 py-2.5 text-sm font-bold text-white disabled:opacity-50"
              >
                ✔ 공지 확인했어요
              </button>
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
                          <button
                            onClick={() => setRosterFor(item.notice)}
                            className="mt-2 flex w-full items-center justify-between rounded-lg bg-emerald-50 px-3 py-2 text-left ring-1 ring-emerald-100 transition hover:bg-emerald-100"
                          >
                            <span className="text-[12px] font-bold text-emerald-700">
                              ✔ 확인 {item.notice.checkCount}명
                            </span>
                            <span className="text-[11px] font-semibold text-emerald-600">명단 보기 ›</span>
                          </button>
                        ) : (
                          <div className="mt-2">
                            {receipts[item.notice.id]?.consent === 'agreed' ? (
                              <span className="inline-block rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold text-emerald-800">
                                ✔ 확인 완료
                              </span>
                            ) : (
                              <button
                                disabled={consentBusy === item.notice.id}
                                onClick={() => void handleCheck(item.notice)}
                                className="w-full rounded-lg bg-emerald-600 py-2.5 text-[13px] font-bold text-white disabled:opacity-50"
                              >
                                ✔ 공지 확인했어요
                              </button>
                            )}
                          </div>
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
                <span className="text-xs text-gray-400">학생들에게 확인 체크 버튼이 함께 가요</span>
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

      {/* 교사: 공지 확인 명단 시트 (실시간) */}
      {isTeacher && rosterFor && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end" onClick={() => setRosterFor(null)}>
          <div className="absolute inset-0 bg-black/40" />
          <div
            className="relative max-h-[80vh] overflow-hidden rounded-t-2xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mt-2.5 h-1.5 w-10 rounded-full bg-gray-200" />
            <div className="border-b border-gray-100 px-5 py-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-gray-900">공지 확인 명단</h3>
                  <p className="mt-0.5 truncate text-xs text-gray-400">{rosterFor.title}</p>
                </div>
                <button
                  onClick={() => setRosterFor(null)}
                  className="shrink-0 p-2 -m-1 text-lg text-gray-400 hover:text-gray-600"
                >
                  ✕
                </button>
              </div>
            </div>

            <div
              className="overflow-y-auto px-5 py-4"
              style={{ maxHeight: 'calc(80vh - 90px)', paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)' }}
            >
              {!rosterStudents ? (
                <p className="py-8 text-center text-sm text-gray-400">명단을 불러오는 중...</p>
              ) : (
                (() => {
                  const checked = rosterStudents.filter((s) => rosterChecked[s.id] !== undefined)
                  const unchecked = rosterStudents.filter((s) => rosterChecked[s.id] === undefined)
                  return (
                    <>
                      <div className="mb-4 grid grid-cols-2 gap-2 text-center">
                        <div className="rounded-xl bg-emerald-50 py-2.5">
                          <p className="text-lg font-extrabold text-emerald-700">{checked.length}</p>
                          <p className="text-[11px] text-emerald-600">확인 완료</p>
                        </div>
                        <div className="rounded-xl bg-gray-100 py-2.5">
                          <p className="text-lg font-extrabold text-gray-500">{unchecked.length}</p>
                          <p className="text-[11px] text-gray-400">미확인</p>
                        </div>
                      </div>

                      <ul className="space-y-1.5">
                        {rosterStudents.map((s) => {
                          const done = rosterChecked[s.id] !== undefined
                          const at = rosterChecked[s.id]
                          return (
                            <li
                              key={s.id}
                              className={`flex items-center justify-between rounded-lg px-3 py-2.5 ${
                                done ? 'bg-emerald-50' : 'bg-gray-50'
                              }`}
                            >
                              <span className={`text-sm ${done ? 'font-semibold text-gray-900' : 'text-gray-400'}`}>
                                {s.no !== 9999 ? `${s.no}번 ` : ''}
                                {s.name}
                              </span>
                              {done ? (
                                <span className="flex items-center gap-1.5 text-xs font-bold text-emerald-600">
                                  ✔ 확인
                                  {at && <span className="font-normal text-emerald-500/70">{formatTime(at)}</span>}
                                </span>
                              ) : (
                                <span className="text-xs text-gray-300">아직</span>
                              )}
                            </li>
                          )
                        })}
                        {rosterStudents.length === 0 && (
                          <p className="py-6 text-center text-sm text-gray-400">승인된 학생이 아직 없어요.</p>
                        )}
                      </ul>
                    </>
                  )
                })()
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
