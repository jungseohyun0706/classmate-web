import React, { useState, useEffect } from 'react'
import { useRouter } from 'next/router'
import { auth } from '../../lib/firebase'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc, collection, query, orderBy, limit, onSnapshot } from 'firebase/firestore'
import { useUI } from '../../components/ui/feedback'
import {
  createSos,
  acceptSos,
  cancelSos,
  todayKstYmd,
  formatYmd,
  SosStateError,
} from '../../lib/sos'

const PERIODS = [1, 2, 3, 4, 5, 6, 7]

// YYYYMMDD ↔ input[type=date] 값(YYYY-MM-DD) 변환
const ymdToInput = (ymd: string) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
const inputToYmd = (v: string) => v.replace(/-/g, '')

const STATUS_CHIP: Record<string, { label: string; cls: string }> = {
  open: { label: '모집중', cls: 'bg-red-100 text-red-600' },
  assigned: { label: '배정됨', cls: 'bg-green-100 text-green-700' },
  cancelled: { label: '취소됨', cls: 'bg-gray-100 text-gray-500' },
}

export default function SosPage() {
  const router = useRouter()
  const { toast, confirm } = useUI()

  const [loading, setLoading] = useState(true)
  const [userData, setUserData] = useState<any>(null)
  const [uid, setUid] = useState<string | null>(null)

  // SOS 발행 폼
  const [dateInput, setDateInput] = useState(() => ymdToInput(todayKstYmd()))
  const [period, setPeriod] = useState(1)
  const [reason, setReason] = useState('')
  const [sending, setSending] = useState(false)

  // 우리 학교 SOS 목록
  const [requests, setRequests] = useState<any[]>([])
  const [workingId, setWorkingId] = useState<string | null>(null)

  // 로그인 + 교사 역할 가드
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.replace('/auth/login')
        return
      }
      try {
        const { db } = await import('../../lib/firebase')
        const snap = await getDoc(doc(db, 'users', u.uid))
        if (!snap.exists()) {
          router.replace('/dashboard')
          return
        }
        const data = snap.data()
        if (data.role !== 'teacher') {
          toast('선생님만 이용할 수 있는 페이지예요.', 'error')
          router.replace('/dashboard')
          return
        }
        if (!data.schoolCode) {
          toast('학교 정보가 없어요. 설정에서 학교를 등록해 주세요.', 'error')
          router.replace('/dashboard')
          return
        }
        setUid(u.uid)
        setUserData(data)
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    })
    return () => unsub()
  }, [router, toast])

  // 우리 학교 SOS 실시간 구독 (최근 20건, 최신순)
  useEffect(() => {
    if (!userData?.schoolCode) return
    let unsub: (() => void) | undefined
    let cancelled = false
    ;(async () => {
      const { db } = await import('../../lib/firebase')
      if (cancelled) return
      const q = query(
        collection(db, 'school_sos', userData.schoolCode, 'requests'),
        orderBy('createdAt', 'desc'),
        limit(20)
      )
      unsub = onSnapshot(
        q,
        (snap) => {
          setRequests(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
        },
        (e) => console.error(e)
      )
    })()
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [userData?.schoolCode])

  // SOS 발행
  const handleSend = async () => {
    const ymd = inputToYmd(dateInput)
    if (!/^\d{8}$/.test(ymd)) {
      toast('날짜를 선택해 주세요.', 'error')
      return
    }
    const ok = await confirm({
      title: '보결 SOS를 보낼까요?',
      description: `${formatYmd(ymd)} ${period}교시 보결 요청을 우리 학교 선생님들께 알려요.`,
      confirmText: 'SOS 보내기',
      danger: true,
    })
    if (!ok) return

    setSending(true)
    try {
      const { notified } = await createSos({
        date: ymd,
        period,
        reason,
        requesterId: uid!,
        requesterName: userData.displayName || '선생님',
        requesterClass: userData.grade ? `${userData.grade}학년 ${userData.classNm}반` : '담임 없음',
        schoolCode: userData.schoolCode,
      })
      if (notified > 0) {
        toast(`SOS를 보냈어요! 빈 시간 선생님 ${notified}명에게 알림을 전했어요.`, 'success')
      } else {
        toast('SOS를 등록했어요. 지금은 그 시간이 빈 선생님을 찾지 못해 알림은 못 보냈어요.', 'info')
      }
      setReason('')
    } catch (e) {
      console.error(e)
      toast('SOS 발행에 실패했어요. 잠시 후 다시 시도해 주세요.', 'error')
    } finally {
      setSending(false)
    }
  }

  // 수락 (선착순)
  const handleAccept = async (req: any) => {
    const ok = await confirm({
      title: '보결을 맡을까요?',
      description: `${formatYmd(req.date)} ${req.period}교시, ${req.requesterName} 선생님 반의 보결을 맡아요.`,
      confirmText: '내가 맡을게요',
    })
    if (!ok) return

    setWorkingId(req.id)
    try {
      await acceptSos({
        schoolCode: userData.schoolCode,
        reqId: req.id,
        accepterId: uid!,
        accepterName: userData.displayName || '선생님',
      })
      toast('보결을 맡았어요! 요청하신 선생님께 알려드렸어요.', 'success')
    } catch (e) {
      if (e instanceof SosStateError) {
        toast(e.code === 'not-open' ? '앗, 이미 다른 선생님이 맡았거나 마감된 SOS예요.' : e.message, 'error')
      } else {
        console.error(e)
        toast('수락에 실패했어요. 잠시 후 다시 시도해 주세요.', 'error')
      }
    } finally {
      setWorkingId(null)
    }
  }

  // 요청자 본인 취소
  const handleCancel = async (req: any) => {
    const ok = await confirm({
      title: 'SOS를 취소할까요?',
      description: `${formatYmd(req.date)} ${req.period}교시 보결 요청을 취소해요.`,
      confirmText: '취소하기',
      danger: true,
    })
    if (!ok) return

    setWorkingId(req.id)
    try {
      await cancelSos(userData.schoolCode, req.id, uid!)
      toast('SOS를 취소했어요.', 'success')
    } catch (e) {
      if (e instanceof SosStateError) {
        toast(e.message, 'error')
      } else {
        console.error(e)
        toast('취소에 실패했어요. 잠시 후 다시 시도해 주세요.', 'error')
      }
    } finally {
      setWorkingId(null)
    }
  }

  if (loading) return <div className="p-10 text-center text-black">로딩 중...</div>
  if (!userData) return null

  const hasMySchedule = !!userData.mySchedule

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4 sm:px-6">
      <div className="max-w-lg mx-auto">
        {/* 헤더 */}
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">보결 SOS 🚨</h1>
            <p className="text-sm text-gray-600">갑자기 자리를 비워야 할 때, 빈 시간 선생님을 찾아요.</p>
          </div>
          <button onClick={() => router.push('/dashboard')} className="text-gray-500 hover:text-gray-700 px-2 shrink-0">
            나가기
          </button>
        </div>

        {/* SOS 발행 폼 */}
        <div className="bg-white shadow rounded-xl border border-gray-200 p-5 mb-8">
          <h2 className="text-lg font-bold text-gray-900 mb-4">SOS 발행하기</h2>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="sos-date" className="block text-xs font-bold text-gray-500 uppercase mb-1">
                  날짜
                </label>
                <input
                  id="sos-date"
                  type="date"
                  value={dateInput}
                  onChange={(e) => setDateInput(e.target.value)}
                  className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:ring-2 focus:ring-red-400 focus:border-red-400"
                />
              </div>
              <div>
                <label htmlFor="sos-period" className="block text-xs font-bold text-gray-500 uppercase mb-1">
                  교시
                </label>
                <select
                  id="sos-period"
                  value={period}
                  onChange={(e) => setPeriod(Number(e.target.value))}
                  className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm text-gray-900 bg-white focus:ring-2 focus:ring-red-400 focus:border-red-400"
                >
                  {PERIODS.map((p) => (
                    <option key={p} value={p}>
                      {p}교시
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="sos-reason" className="block text-xs font-bold text-gray-500 uppercase mb-1">
                사유 (선택)
              </label>
              <input
                id="sos-reason"
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={50}
                placeholder="예: 병가, 출장, 연수"
                className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-red-400 focus:border-red-400"
              />
            </div>

            <button
              onClick={handleSend}
              disabled={sending}
              className="w-full bg-red-500 hover:bg-red-600 text-white font-bold py-4 rounded-xl text-lg transition disabled:opacity-50"
            >
              {sending ? '보내는 중...' : '🚨 보결 SOS 보내기'}
            </button>

            <p className="text-xs text-gray-500 leading-relaxed break-keep">
              그 시간에 수업이 없는 우리 학교 선생님들께 알림이 가요. 내 시간표를 등록해야 SOS 알림을 정확히 받아요.
            </p>

            {!hasMySchedule && (
              <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800 break-keep">
                아직 내 시간표가 없어요. 시간표를 등록하지 않으면 다른 선생님의 SOS 알림을 받지 못해요.{' '}
                <button
                  onClick={() => router.push('/teacher/my-schedule')}
                  className="font-bold underline text-amber-900"
                >
                  내 시간표 등록하기
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 우리 학교 SOS 목록 */}
        <h2 className="text-lg font-bold text-gray-900 mb-3">우리 학교 SOS</h2>

        {requests.length === 0 && (
          <div className="bg-white rounded-xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-400">
            아직 등록된 SOS가 없어요.
          </div>
        )}

        <div className="space-y-3">
          {requests.map((req) => {
            const chip = STATUS_CHIP[req.status] ?? STATUS_CHIP.cancelled
            const isMine = req.requesterId === uid
            return (
              <div key={req.id} className="bg-white shadow-sm rounded-xl border border-gray-200 p-4">
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0">
                    <div className="font-bold text-gray-900">
                      {formatYmd(req.date)} {req.period}교시
                    </div>
                    <div className="text-sm text-gray-600 mt-0.5">
                      {req.requesterName} 선생님 · {req.requesterClass || '담임 없음'}
                      {isMine && <span className="ml-1 text-blue-600 font-bold">(내 요청)</span>}
                    </div>
                    {req.reason && <div className="text-xs text-gray-500 mt-1 break-keep">사유: {req.reason}</div>}
                  </div>
                  <span className={`shrink-0 text-xs font-bold px-2.5 py-1 rounded-full ${chip.cls}`}>
                    {chip.label}
                  </span>
                </div>

                {req.status === 'assigned' && req.assignedName && (
                  <div className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 break-keep">
                    ✅ {req.assignedName} 선생님이 맡아주셨어요
                  </div>
                )}

                {req.status === 'open' && !isMine && (
                  <button
                    onClick={() => handleAccept(req)}
                    disabled={workingId === req.id}
                    className="mt-3 w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 rounded-xl text-sm transition disabled:opacity-50"
                  >
                    {workingId === req.id ? '처리 중...' : '내가 맡을게요 🙋'}
                  </button>
                )}

                {req.status === 'open' && isMine && (
                  <button
                    onClick={() => handleCancel(req)}
                    disabled={workingId === req.id}
                    className="mt-3 w-full border border-gray-300 text-gray-600 hover:bg-gray-50 font-bold py-2.5 rounded-xl text-sm transition disabled:opacity-50"
                  >
                    {workingId === req.id ? '처리 중...' : '요청 취소하기'}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
