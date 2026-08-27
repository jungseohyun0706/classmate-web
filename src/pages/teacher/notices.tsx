import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { auth, db } from '../../lib/firebase'
import { onAuthStateChanged } from 'firebase/auth'
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getCountFromServer,
  query,
  where,
  orderBy,
  limit,
  Timestamp,
} from 'firebase/firestore'
import { useUI } from '../../components/ui/feedback'

// 교사용 알림장 목록: 읽음/전체 카운터 + 동의 현황 + 행별 확장 명단(읽은 학생 / 미확인)

type NoticeRow = {
  id: string
  title: string
  createdAt: Timestamp | null
  requiresConsent: boolean
  readCount: number
  consentCount: number
}

type Receipt = {
  uid: string
  studentName: string
  readAt: Timestamp | null
  consent?: 'agreed' | 'declined'
}

type StudentLite = {
  id: string
  name: string
  studentId: number
}

const MAX_NOTICES = 30

function formatDate(ts: Timestamp | null): string {
  if (!ts) return ''
  const d = ts.toDate()
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`
}

function formatReadAt(ts: Timestamp | null): string {
  if (!ts) return ''
  const d = ts.toDate()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`
}

function ConsentChip({ consent }: { consent?: 'agreed' | 'declined' }) {
  if (consent === 'agreed') {
    return <span className="shrink-0 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[11px] font-bold">동의</span>
  }
  if (consent === 'declined') {
    return <span className="shrink-0 px-2 py-0.5 rounded-full bg-red-100 text-red-600 text-[11px] font-bold">거절</span>
  }
  return <span className="shrink-0 px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 text-[11px] font-bold">응답 전</span>
}

export default function NoticeList() {
  const router = useRouter()
  const { toast } = useUI()

  const [loading, setLoading] = useState(true)
  const [userData, setUserData] = useState<any>(null)
  const [notices, setNotices] = useState<NoticeRow[]>([])
  const [totalStudents, setTotalStudents] = useState(0)

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [receiptsMap, setReceiptsMap] = useState<Record<string, Receipt[]>>({})
  const [students, setStudents] = useState<StudentLite[] | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.replace('/auth/login')
        return
      }
      try {
        const snap = await getDoc(doc(db, 'users', u.uid))
        if (!snap.exists()) {
          router.replace('/auth/login')
          return
        }
        const data = snap.data()
        if (data.role !== 'teacher') {
          router.replace('/dashboard')
          return
        }
        if (!data.classId) {
          toast('담당 학급이 없어요. 먼저 반을 등록해 주세요.', 'error')
          router.replace('/dashboard')
          return
        }
        setUserData(data)
        const cid: string = data.classId

        // 전체(승인된 학생) 수
        const totalSnap = await getCountFromServer(
          query(
            collection(db, 'users'),
            where('classId', '==', cid),
            where('role', '==', 'student'),
            where('status', '==', 'approved')
          )
        )
        setTotalStudents(totalSnap.data().count)

        // 알림장 최신순 + 행별 읽음/동의 카운트
        const annSnap = await getDocs(
          query(
            collection(db, 'classes', cid, 'announcements'),
            orderBy('createdAt', 'desc'),
            limit(MAX_NOTICES)
          )
        )
        const rows = await Promise.all(
          annSnap.docs.map(async (annDoc) => {
            const a = annDoc.data()
            const requiresConsent = a.requiresConsent === true
            const receiptsCol = collection(db, 'classes', cid, 'announcements', annDoc.id, 'receipts')
            const readSnap = await getCountFromServer(receiptsCol)
            let consentCount = 0
            if (requiresConsent) {
              const consentSnap = await getCountFromServer(
                query(receiptsCol, where('consent', '==', 'agreed'))
              )
              consentCount = consentSnap.data().count
            }
            return {
              id: annDoc.id,
              title: typeof a.title === 'string' && a.title ? a.title : '(제목 없음)',
              createdAt: (a.createdAt as Timestamp) ?? null,
              requiresConsent,
              readCount: readSnap.data().count,
              consentCount,
            } as NoticeRow
          })
        )
        setNotices(rows)
      } catch (e) {
        console.error(e)
        toast('알림장 목록을 불러오지 못했어요.', 'error')
      } finally {
        setLoading(false)
      }
    })
    return () => unsub()
  }, [router, toast])

  const toggleExpand = async (aid: string) => {
    if (expandedId === aid) {
      setExpandedId(null)
      return
    }
    setExpandedId(aid)
    if (!userData?.classId) return
    if (receiptsMap[aid] && students) return

    setDetailLoading(true)
    try {
      const cid: string = userData.classId

      // 승인된 학생 명단은 한 번만 가져와요 (미확인 명단 계산용)
      if (!students) {
        const sSnap = await getDocs(
          query(
            collection(db, 'users'),
            where('classId', '==', cid),
            where('role', '==', 'student'),
            where('status', '==', 'approved')
          )
        )
        const list: StudentLite[] = sSnap.docs.map((d) => {
          const s = d.data()
          return {
            id: d.id,
            name: (typeof s.name === 'string' && s.name) || (typeof s.displayName === 'string' && s.displayName) || '이름 없음',
            studentId: Number(s.studentId ?? 0),
          }
        })
        list.sort((a, b) => a.studentId - b.studentId)
        setStudents(list)
      }

      if (!receiptsMap[aid]) {
        const rSnap = await getDocs(
          query(
            collection(db, 'classes', cid, 'announcements', aid, 'receipts'),
            orderBy('readAt', 'asc')
          )
        )
        const list: Receipt[] = rSnap.docs.map((d) => {
          const r = d.data()
          return {
            uid: d.id,
            studentName: typeof r.studentName === 'string' && r.studentName ? r.studentName : '학생',
            readAt: (r.readAt as Timestamp) ?? null,
            consent: r.consent === 'agreed' || r.consent === 'declined' ? r.consent : undefined,
          }
        })
        setReceiptsMap((prev) => ({ ...prev, [aid]: list }))
      }
    } catch (e) {
      console.error(e)
      toast('확인 명단을 불러오지 못했어요.', 'error')
    } finally {
      setDetailLoading(false)
    }
  }

  if (loading) return <div className="p-10 text-center">로딩 중...</div>

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-2xl mx-auto">

        {/* 헤더 */}
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-between sm:items-center mb-6">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900">알림장 목록</h1>
            <p className="text-sm text-gray-600 mt-0.5">
              {userData?.schoolName} {userData?.grade}학년 {userData?.classNm}반 · 학생 {totalStudents}명
            </p>
          </div>
          <button
            onClick={() => router.push('/dashboard')}
            className="shrink-0 whitespace-nowrap min-h-[44px] px-2 text-gray-500 hover:text-gray-700"
          >
            &larr; 대시보드로
          </button>
        </div>

        {/* 알림장 쓰기 */}
        <button
          onClick={() => router.push('/teacher/notice/write')}
          className="w-full mb-6 flex justify-center items-center py-3.5 px-4 rounded-xl shadow-sm text-base font-bold text-white bg-blue-600 hover:bg-blue-700 transition-colors"
        >
          알림장 쓰기 ✏️
        </button>

        {/* 목록 */}
        {notices.length === 0 ? (
          <div className="bg-white shadow rounded-xl p-10 text-center text-gray-500">
            <p>아직 보낸 알림장이 없어요.</p>
            <p className="text-sm mt-2">위의 버튼으로 첫 알림장을 보내 보세요.</p>
          </div>
        ) : (
          <div className="bg-white shadow rounded-xl overflow-hidden">
            <ul className="divide-y divide-gray-200">
              {notices.map((n) => {
                const receipts = receiptsMap[n.id] ?? []
                const readUids = new Set(receipts.map((r) => r.uid))
                const unread = (students ?? []).filter((s) => !readUids.has(s.id))
                const expanded = expandedId === n.id
                return (
                  <li key={n.id}>
                    <button
                      onClick={() => toggleExpand(n.id)}
                      className="w-full text-left px-4 py-4 hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-gray-900 truncate">{n.title}</span>
                            {n.requiresConsent && (
                              <span className="shrink-0 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[11px] font-bold">
                                동의 필요
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-gray-500 mt-1">{formatDate(n.createdAt)}</div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-sm font-bold text-blue-600">
                            읽음 {n.readCount} / 전체 {totalStudents}
                          </div>
                          {n.requiresConsent && (
                            <div className="text-xs font-semibold text-emerald-600 mt-0.5">
                              동의 {n.consentCount}
                            </div>
                          )}
                        </div>
                      </div>
                    </button>

                    {/* 확장 패널: 읽은 학생 + 미확인 명단 */}
                    {expanded && (
                      <div className="px-4 pb-5 bg-gray-50 border-t border-gray-100">
                        {detailLoading && !receiptsMap[n.id] ? (
                          <div className="py-6 text-center text-sm text-gray-500">명단을 불러오는 중...</div>
                        ) : (
                          <>
                            <div className="pt-4">
                              <h3 className="text-xs font-bold text-gray-500 mb-2">
                                읽은 학생 {receipts.length}명
                              </h3>
                              {receipts.length === 0 ? (
                                <p className="text-sm text-gray-400">아직 읽은 학생이 없어요.</p>
                              ) : (
                                <ul className="space-y-1.5">
                                  {receipts.map((r) => (
                                    <li
                                      key={r.uid}
                                      className="flex items-center justify-between bg-white rounded-lg px-3 py-2"
                                    >
                                      <span className="text-sm text-gray-900 truncate">{r.studentName}</span>
                                      <span className="flex items-center gap-2 shrink-0">
                                        <span className="text-xs text-gray-400">{formatReadAt(r.readAt)}</span>
                                        {n.requiresConsent && <ConsentChip consent={r.consent} />}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>

                            <div className="pt-4">
                              <h3 className="text-xs font-bold text-gray-500 mb-2">
                                미확인 {unread.length}명
                              </h3>
                              {unread.length === 0 ? (
                                <p className="text-sm text-emerald-600 font-medium">모든 학생이 확인했어요 🎉</p>
                              ) : (
                                <div className="flex flex-wrap gap-1.5">
                                  {unread.map((s) => (
                                    <span
                                      key={s.id}
                                      className="px-2.5 py-1 rounded-full bg-white border border-gray-200 text-xs text-gray-600"
                                    >
                                      {s.studentId ? `${s.studentId}번 ` : ''}
                                      {s.name}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
