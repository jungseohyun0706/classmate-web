import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { initFirebase } from '../../lib/firebase'
import { getAuth, onAuthStateChanged } from 'firebase/auth'
import {
  collection,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'firebase/firestore'
import TeacherLayout from '../../components/Layout'
import { toast } from '../../lib/toast'
import { acceptSwapRequest, declineSwapRequest, cancelSwapRequest, type SwapRequest } from '../../lib/swaps'

initFirebase()

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  pending: { text: '대기 중', cls: 'bg-amber-100 text-amber-800' },
  accepted: { text: '수락됨', cls: 'bg-green-100 text-green-800' },
  declined: { text: '거절됨', cls: 'bg-gray-200 text-gray-600' },
  cancelled: { text: '취소됨', cls: 'bg-gray-100 text-gray-400' },
}

function RequestCard({
  req,
  mine,
  busy,
  onAccept,
  onDecline,
  onCancel,
}: {
  req: SwapRequest & { id: string }
  mine: boolean
  busy: boolean
  onAccept: () => void
  onDecline: () => void
  onCancel: () => void
}) {
  const s = STATUS_LABEL[req.status] || STATUS_LABEL.pending
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm animate-fade-in">
      <div className="flex justify-between items-start gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${s.cls}`}>{s.text}</span>
            <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-blue-50 text-blue-700">
              {req.type === 'substitute' ? '보결 요청' : '수업 맞교환'}
            </span>
          </div>
          <div className="mt-2 text-sm text-gray-900 font-medium">
            {mine ? (
              <>
                <span className="font-bold">{req.toName}</span> 선생님에게 보냄
              </>
            ) : (
              <>
                <span className="font-bold">{req.fromName}</span> 선생님의 요청
              </>
            )}
          </div>
          <div className="mt-1.5 text-sm text-gray-600 space-y-0.5">
            <div>
              📘 {req.a.day}요일 {req.a.period}교시 <b>{req.a.subject}</b>
              {req.type === 'substitute' ? ' 수업을 대신 맡아주세요' : ''}
            </div>
            {req.type === 'swap' && req.b && (
              <div>
                🔄 {req.b.day}요일 {req.b.period}교시 <b>{req.b.subject}</b> 수업과 맞교환
              </div>
            )}
            {req.note && <div className="text-xs text-gray-400">메모: {req.note}</div>}
          </div>
        </div>

        {req.status === 'pending' && (
          <div className="flex flex-col gap-2 shrink-0">
            {mine ? (
              <button
                onClick={onCancel}
                disabled={busy}
                className="px-3 py-1.5 rounded-lg text-xs font-bold border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                요청 취소
              </button>
            ) : (
              <>
                <button
                  onClick={onAccept}
                  disabled={busy}
                  className="px-4 py-2 rounded-lg text-sm font-bold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  수락
                </button>
                <button
                  onClick={onDecline}
                  disabled={busy}
                  className="px-4 py-1.5 rounded-lg text-xs font-bold border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                >
                  거절
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {req.status === 'accepted' && (
        <div className="mt-3 text-xs text-green-700 bg-green-50 border border-green-100 rounded-lg px-3 py-2">
          ✓ 양쪽 시간표에 자동 반영되었고, 학생 화면에는 변경 표시가 붙었습니다.
        </div>
      )}
    </div>
  )
}

export default function RequestsPage() {
  const router = useRouter()
  const auth = getAuth()
  const [tab, setTab] = useState<'received' | 'sent'>('received')
  const [received, setReceived] = useState<(SwapRequest & { id: string })[]>([])
  const [sent, setSent] = useState<(SwapRequest & { id: string })[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      if (!u) {
        router.replace('/auth/login')
        return
      }
      const db = getFirestore()

      const qr = query(collection(db, 'swap_requests'), where('toUid', '==', u.uid), orderBy('createdAt', 'desc'))
      const unsubR = onSnapshot(qr, (snap) => {
        setReceived(snap.docs.map((d) => ({ id: d.id, ...(d.data() as SwapRequest) })))
        setLoading(false)
      }, (e) => { console.error(e); setLoading(false) })

      const qs = query(collection(db, 'swap_requests'), where('fromUid', '==', u.uid), orderBy('createdAt', 'desc'))
      const unsubS = onSnapshot(qs, (snap) => {
        setSent(snap.docs.map((d) => ({ id: d.id, ...(d.data() as SwapRequest) })))
      }, (e) => console.error(e))

      return () => { unsubR(); unsubS() }
    })
    return () => unsub()
  }, [auth, router])

  const act = async (fn: () => Promise<void>, id: string, okMsg: string) => {
    setBusyId(id)
    try {
      await fn()
      toast(okMsg)
    } catch (e: any) {
      console.error(e)
      toast(e?.message || '처리에 실패했습니다.', 'error')
    } finally {
      setBusyId(null)
    }
  }

  const list = tab === 'received' ? received : sent
  const db = getFirestore()

  return (
    <TeacherLayout title="교환 요청함 🔄" subtitle="수락하면 양쪽 시간표가 자동으로 바뀌고, 학생들에게 변경 표시가 보입니다.">
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setTab('received')}
          className={`px-4 py-2 rounded-lg text-sm font-bold ${tab === 'received' ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600'}`}
        >
          받은 요청 {received.filter((r) => r.status === 'pending').length > 0 && (
            <span className="ml-1 text-xs">({received.filter((r) => r.status === 'pending').length})</span>
          )}
        </button>
        <button
          onClick={() => setTab('sent')}
          className={`px-4 py-2 rounded-lg text-sm font-bold ${tab === 'sent' ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600'}`}
        >
          보낸 요청
        </button>
      </div>

      {loading ? (
        <div className="text-center text-gray-400 py-16">로딩 중...</div>
      ) : list.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-dashed border-gray-300">
          <div className="text-3xl mb-2">📭</div>
          <p className="text-gray-500 text-sm">
            {tab === 'received' ? '받은 교환 요청이 없습니다.' : '보낸 교환 요청이 없습니다.'}
          </p>
          <p className="text-gray-400 text-xs mt-1">내 시간표에서 수업 칸을 눌러 교환을 요청해 보세요.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {list.map((r) => (
            <RequestCard
              key={r.id}
              req={r}
              mine={tab === 'sent'}
              busy={busyId === r.id}
              onAccept={() => act(() => acceptSwapRequest(db, r.id, r), r.id, '교환이 완료되었습니다! 시간표에 반영했어요.')}
              onDecline={() => act(() => declineSwapRequest(db, r.id), r.id, '요청을 거절했습니다.')}
              onCancel={() => act(() => cancelSwapRequest(db, r.id), r.id, '요청을 취소했습니다.')}
            />
          ))}
        </div>
      )}
    </TeacherLayout>
  )
}
