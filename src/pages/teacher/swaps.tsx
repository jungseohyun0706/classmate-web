import React, { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { auth } from '../../lib/firebase'
import { onAuthStateChanged } from 'firebase/auth'
import { collection, doc, getDoc, getDocs, limit, orderBy, query, updateDoc } from 'firebase/firestore'
import { useUI } from '../../components/ui/feedback'
import EnablePush from '../../components/EnablePush'
import {
  acceptDirectRequest,
  acceptPublicRequest,
  cancelRequest,
  declineDirectRequest,
  formatSwapDate,
  listPublic,
  listReceived,
  listSent,
  type DirectSwapRequest,
  type PublicSwapRequest,
  type SwapRequest,
  type SwapStatus,
} from '../../lib/swaps'

type TabKey = 'received' | 'sent' | 'board'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'received', label: '받은 요청' },
  { key: 'sent', label: '보낸 요청' },
  { key: 'board', label: '학교 게시판' },
]

const STATUS_CHIP: Record<SwapStatus, { label: string; cls: string }> = {
  pending: { label: '대기중', cls: 'bg-yellow-100 text-yellow-800' },
  accepted: { label: '수락됨', cls: 'bg-green-100 text-green-700' },
  declined: { label: '거절됨', cls: 'bg-red-100 text-red-600' },
  cancelled: { label: '취소됨', cls: 'bg-gray-100 text-gray-500' },
}

interface InboxNotification {
  id: string
  title?: string
  body?: string
  url?: string
  read?: boolean
  createdAt?: any
}

export default function SwapsInboxPage() {
  const router = useRouter()
  const { toast, confirm } = useUI()

  const [loading, setLoading] = useState(true)
  const [uid, setUid] = useState<string | null>(null)
  const [userData, setUserData] = useState<any>(null)

  const [tab, setTab] = useState<TabKey>('received')
  const [received, setReceived] = useState<DirectSwapRequest[]>([])
  const [sent, setSent] = useState<SwapRequest[]>([])
  const [board, setBoard] = useState<PublicSwapRequest[]>([])
  const [notifications, setNotifications] = useState<InboxNotification[]>([])
  const [processingId, setProcessingId] = useState<string | null>(null)

  const loadAll = useCallback(async (userId: string, schoolCode: string) => {
    try {
      const { db } = await import('../../lib/firebase')
      const [r, s, b, n] = await Promise.all([
        listReceived(userId, schoolCode),
        listSent(userId, schoolCode),
        listPublic(schoolCode),
        getDocs(query(collection(db, 'users', userId, 'notifications'), orderBy('createdAt', 'desc'), limit(10))),
      ])
      setReceived(r)
      setSent(s)
      setBoard(b)
      const notis: InboxNotification[] = []
      n.forEach((d) => notis.push({ id: d.id, ...(d.data() as Omit<InboxNotification, 'id'>) }))
      setNotifications(notis)
    } catch (e) {
      console.error(e)
      toast('목록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.', 'error')
    }
  }, [toast])

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.replace('/auth/login')
        return
      }
      setUid(u.uid)
      try {
        const { db } = await import('../../lib/firebase')
        const snap = await getDoc(doc(db, 'users', u.uid))
        const data = snap.exists() ? snap.data() : null
        if (data?.role === 'student') {
          router.replace('/student/today')
          return
        }
        setUserData(data)
        if (data?.schoolCode) {
          await loadAll(u.uid, String(data.schoolCode))
        }
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    })
    return () => unsub()
  }, [router, loadAll])

  const refresh = useCallback(async () => {
    if (uid && userData?.schoolCode) {
      await loadAll(uid, String(userData.schoolCode))
    }
  }, [uid, userData, loadAll])

  const actor = () => ({
    uid: uid as string,
    name: userData?.displayName || '선생님',
    classId: userData?.classId || null,
  })

  const handleAccept = async (req: DirectSwapRequest) => {
    setProcessingId(req.id)
    try {
      await acceptDirectRequest(req, actor())
      toast('교환을 수락했어요! 요청한 선생님께 알려드릴게요.', 'success')
      await refresh()
    } catch (e: any) {
      toast(e?.message || '처리에 실패했어요. 잠시 후 다시 시도해 주세요.', 'error')
    } finally {
      setProcessingId(null)
    }
  }

  const handleDecline = async (req: DirectSwapRequest) => {
    const ok = await confirm({
      title: '요청을 거절할까요?',
      description: `${req.requesterName} 선생님의 ${formatSwapDate(req)} ${req.period}교시 교환 요청을 거절해요.`,
      confirmText: '거절하기',
      danger: true,
    })
    if (!ok) return
    setProcessingId(req.id)
    try {
      await declineDirectRequest(req, actor())
      toast('요청을 거절했어요.', 'info')
      await refresh()
    } catch (e: any) {
      toast(e?.message || '처리에 실패했어요. 잠시 후 다시 시도해 주세요.', 'error')
    } finally {
      setProcessingId(null)
    }
  }

  const handleCancel = async (req: SwapRequest) => {
    const ok = await confirm({
      title: '요청을 취소할까요?',
      description: `${formatSwapDate(req)} ${req.period}교시(${req.subject}) 요청을 취소해요.`,
      confirmText: '요청 취소',
      danger: true,
    })
    if (!ok) return
    setProcessingId(req.id)
    try {
      await cancelRequest(req)
      toast('요청을 취소했어요.', 'info')
      await refresh()
    } catch (e: any) {
      toast(e?.message || '처리에 실패했어요. 잠시 후 다시 시도해 주세요.', 'error')
    } finally {
      setProcessingId(null)
    }
  }

  const handleAcceptPublic = async (req: PublicSwapRequest) => {
    const ok = await confirm({
      title: '품앗이를 수락할까요?',
      description: `${req.requesterName} 선생님의 ${formatSwapDate(req)} ${req.period}교시(${req.subject}) 수업을 맡아요.`,
      confirmText: '수락하기',
    })
    if (!ok) return
    setProcessingId(req.id)
    try {
      await acceptPublicRequest(req, actor())
      toast('품앗이를 수락했어요! 요청한 선생님께 알려드릴게요.', 'success')
      await refresh()
    } catch (e: any) {
      toast(e?.message || '처리에 실패했어요. 잠시 후 다시 시도해 주세요.', 'error')
    } finally {
      setProcessingId(null)
    }
  }

  const handleNotificationClick = async (n: InboxNotification) => {
    if (uid) {
      try {
        const { db } = await import('../../lib/firebase')
        await updateDoc(doc(db, 'users', uid, 'notifications', n.id), { read: true })
        setNotifications((prev) => prev.map((item) => (item.id === n.id ? { ...item, read: true } : item)))
      } catch (e) {
        console.error(e)
      }
    }
    if (n.url) {
      router.push(n.url)
    }
  }

  const StatusChip = ({ status }: { status: SwapStatus }) => {
    const chip = STATUS_CHIP[status] ?? STATUS_CHIP.pending
    return (
      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold ${chip.cls}`}>
        {chip.label}
      </span>
    )
  }

  const RequestMeta = ({ req }: { req: SwapRequest }) => (
    <div className="mt-1 text-sm text-gray-600">
      <span className="font-medium text-gray-800">{formatSwapDate(req)}</span>
      <span className="mx-1 text-gray-300">·</span>
      <span>{req.period}교시</span>
      {req.subject && (
        <>
          <span className="mx-1 text-gray-300">·</span>
          <span className="text-blue-600 font-bold">{req.subject}</span>
        </>
      )}
    </div>
  )

  const EmptyState = ({ message, sub }: { message: string; sub?: string }) => (
    <div className="bg-white rounded-xl border border-dashed border-gray-200 py-12 px-6 text-center">
      <div className="text-3xl mb-2">🍃</div>
      <p className="text-gray-700 font-bold">{message}</p>
      {sub && <p className="text-sm text-gray-400 mt-1">{sub}</p>}
    </div>
  )

  if (loading) return <div className="p-10 text-center text-black">로딩 중...</div>

  if (!userData?.schoolCode) {
    return (
      <div className="min-h-screen bg-gray-50 py-10 px-4">
        <div className="max-w-2xl mx-auto">
          <h1 className="text-2xl font-bold text-gray-900 mb-4">교환 인박스 📮</h1>
          <EmptyState message="학교 정보가 아직 없어요." sub="먼저 학교와 학급을 등록해 주세요." />
          <button
            onClick={() => router.push('/teacher/register-class')}
            className="mt-4 w-full bg-blue-600 text-white font-bold py-3 rounded-xl hover:bg-blue-700 transition"
          >
            학교/반 등록하러 가기
          </button>
        </div>
      </div>
    )
  }

  const pendingReceived = received.filter((r) => r.status === 'pending').length

  return (
    <div className="min-h-screen bg-gray-50 py-6 sm:py-10 px-4 sm:px-6 lg:px-8">
      <div className="max-w-2xl mx-auto">
        {/* 헤더 */}
        <div className="flex justify-between items-center mb-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">교환 인박스 📮</h1>
            <p className="text-sm text-gray-600">받은 교시 품앗이 요청을 확인하고 처리하세요.</p>
          </div>
          <button onClick={() => router.push('/dashboard')} className="whitespace-nowrap min-h-[44px] text-gray-500 hover:text-gray-700 px-3 shrink-0">
            나가기
          </button>
        </div>

        {/* 푸시 알림 켜기 카드 */}
        <div className="mb-4">
          <EnablePush />
        </div>

        {/* 탭 */}
        <div className="bg-white rounded-xl border border-gray-200 p-1 flex mb-4 shadow-sm">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex-1 py-2 rounded-lg text-sm font-bold transition ${
                tab === t.key ? 'bg-blue-600 text-white shadow' : 'text-gray-500 hover:bg-gray-50'
              }`}
            >
              {t.label}
              {t.key === 'received' && pendingReceived > 0 && (
                <span
                  className={`ml-1.5 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full text-xs font-bold ${
                    tab === 'received' ? 'bg-white text-blue-600' : 'bg-red-500 text-white'
                  }`}
                >
                  {pendingReceived}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* 받은 요청 */}
        {tab === 'received' && (
          <div className="space-y-3">
            {received.length === 0 && (
              <EmptyState message="아직 받은 요청이 없어요." sub="다른 선생님이 교환을 요청하면 여기에 표시돼요." />
            )}
            {received.map((req) => (
              <div key={req.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="font-bold text-gray-900">
                      {req.requesterName} 선생님
                      {req.requesterClass && <span className="ml-2 text-xs font-medium text-gray-400">{req.requesterClass}</span>}
                    </div>
                    <RequestMeta req={req} />
                  </div>
                  <StatusChip status={req.status} />
                </div>
                {req.status === 'pending' && (
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => handleAccept(req)}
                      disabled={processingId === req.id}
                      className="flex-1 bg-blue-600 text-white font-bold py-3 rounded-lg hover:bg-blue-700 transition disabled:opacity-50"
                    >
                      수락
                    </button>
                    <button
                      onClick={() => handleDecline(req)}
                      disabled={processingId === req.id}
                      className="flex-1 bg-gray-100 text-gray-600 font-bold py-3 rounded-lg hover:bg-gray-200 transition disabled:opacity-50"
                    >
                      거절
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* 보낸 요청 */}
        {tab === 'sent' && (
          <div className="space-y-3">
            {sent.length === 0 && (
              <EmptyState message="보낸 요청이 없어요." sub="내 수업 시간표에서 교환을 요청해 보세요." />
            )}
            {sent.map((req) => (
              <div key={`${req.kind}_${req.id}`} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="font-bold text-gray-900">
                      {req.kind === 'direct'
                        ? `→ ${req.toName || '선생님'} 선생님`
                        : '📢 학교 게시판 공개 요청'}
                    </div>
                    <RequestMeta req={req} />
                    {req.status === 'accepted' && req.accepterName && (
                      <p className="mt-1 text-xs text-green-600 font-medium">{req.accepterName} 선생님이 수락했어요.</p>
                    )}
                  </div>
                  <StatusChip status={req.status} />
                </div>
                {req.status === 'pending' && (
                  <div className="mt-3">
                    <button
                      onClick={() => handleCancel(req)}
                      disabled={processingId === req.id}
                      className="w-full bg-gray-100 text-gray-600 font-bold py-3 rounded-lg hover:bg-gray-200 transition disabled:opacity-50"
                    >
                      요청 취소
                    </button>
                  </div>
                )}
              </div>
            ))}
            <button
              onClick={() => router.push('/teacher/my-schedule')}
              className="w-full bg-white border border-blue-200 text-blue-600 font-bold py-3 rounded-xl hover:bg-blue-50 transition"
            >
              + 새 교환 요청 보내러 가기
            </button>
          </div>
        )}

        {/* 학교 게시판 */}
        {tab === 'board' && (
          <div className="space-y-3">
            {board.length === 0 && (
              <EmptyState message="게시판에 올라온 요청이 없어요." sub="공개 요청을 등록하면 학교 전체 선생님이 볼 수 있어요." />
            )}
            {board.map((req) => {
              const mine = req.requesterId === uid
              return (
                <div key={req.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-bold text-gray-900">
                        {req.requesterName} 선생님
                        {mine && <span className="ml-2 text-xs font-bold text-blue-500">내 요청</span>}
                        {!mine && req.requesterClass && (
                          <span className="ml-2 text-xs font-medium text-gray-400">{req.requesterClass}</span>
                        )}
                      </div>
                      <RequestMeta req={req} />
                      {req.note && <p className="mt-1 text-sm text-gray-500 break-keep">💬 {req.note}</p>}
                    </div>
                    <StatusChip status={req.status} />
                  </div>
                  {req.status === 'pending' && !mine && (
                    <div className="mt-3">
                      <button
                        onClick={() => handleAcceptPublic(req)}
                        disabled={processingId === req.id}
                        className="w-full bg-blue-600 text-white font-bold py-3 rounded-lg hover:bg-blue-700 transition disabled:opacity-50"
                      >
                        품앗이 수락하기
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* 알림 */}
        <div className="mt-8">
          <h2 className="text-sm font-bold text-gray-500 uppercase mb-2">알림</h2>
          {notifications.length === 0 ? (
            <p className="text-sm text-gray-400 bg-white rounded-xl border border-gray-100 p-4 text-center">
              아직 알림이 없어요.
            </p>
          ) : (
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm divide-y divide-gray-100 overflow-hidden">
              {notifications.map((n) => (
                <button
                  key={n.id}
                  onClick={() => handleNotificationClick(n)}
                  className={`w-full text-left px-4 py-3 hover:bg-gray-50 transition flex items-start gap-3 ${
                    n.read ? 'opacity-60' : ''
                  }`}
                >
                  <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${n.read ? 'bg-gray-300' : 'bg-blue-500'}`} />
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-gray-900 truncate">{n.title || '알림'}</span>
                    {n.body && <span className="block text-sm text-gray-500 break-keep">{n.body}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
