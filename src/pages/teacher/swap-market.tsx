import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { initFirebase } from '../../lib/firebase'
import { getAuth, onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc, collection, query, where, orderBy, getDocs, updateDoc, deleteDoc } from 'firebase/firestore'

initFirebase()

type SwapRequest = {
  id: string
  requesterId: string
  requesterName: string
  requesterClass: string
  day: string
  dayLabel: string
  period: number
  subject: string
  note: string
  status: 'pending' | 'matched'
  createdAt: any
  accepterName?: string
}

export default function SwapMarket() {
  const router = useRouter()
  const auth = getAuth()
  const [loading, setLoading] = useState(true)
  const [requests, setRequests] = useState<SwapRequest[]>([])
  const [userData, setUserData] = useState<any>(null)
  const [filter, setFilter] = useState<'all' | 'mine'>('all')

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.replace('/auth/login')
        return
      }
      try {
        const { db } = await import('../../lib/firebase')
        
        // 1. 내 정보(학교 코드) 가져오기
        const snap = await getDoc(doc(db, 'users', u.uid))
        if (!snap.exists()) return
        const user = snap.data()
        setUserData(user)

        if (!user.schoolCode) {
          alert('학교 정보가 없습니다. 반 등록을 먼저 해주세요.')
          router.replace('/dashboard')
          return
        }

        // 2. 우리 학교 교환 요청 목록 가져오기
        loadRequests(db, user.schoolCode)

      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    })
    return () => unsub()
  }, [router, auth])

  const loadRequests = async (db: any, schoolCode: string) => {
    try {
      const q = query(
        collection(db, 'school_swaps', schoolCode, 'requests'),
        orderBy('createdAt', 'desc')
      )
      const snapshot = await getDocs(q)
      const list: SwapRequest[] = []
      snapshot.forEach(doc => {
        list.push({ id: doc.id, ...doc.data() } as SwapRequest)
      })
      setRequests(list)
    } catch (e) {
      console.error('Failed to load requests', e)
    }
  }

  // 수락하기
  const handleAccept = async (req: SwapRequest) => {
    if (!confirm(`[${req.requesterName}] 선생님의 ${req.dayLabel}요일 ${req.period}교시 수업을 맡으시겠습니까?`)) return
    
    try {
      const { db } = await import('../../lib/firebase')
      const reqRef = doc(db, 'school_swaps', userData.schoolCode, 'requests', req.id)
      
      await updateDoc(reqRef, {
        status: 'matched',
        accepterId: auth.currentUser?.uid,
        accepterName: userData.displayName,
        matchedAt: new Date()
      })
      
      alert('매칭되었습니다! 선생님께 연락해보세요.')
      loadRequests(db, userData.schoolCode) // 목록 새로고침
    } catch (e) {
      alert('오류가 발생했습니다.')
    }
  }

  // 취소/삭제하기
  const handleDelete = async (id: string) => {
    if (!confirm('정말 삭제하시겠습니까?')) return
    try {
      const { db } = await import('../../lib/firebase')
      await deleteDoc(doc(db, 'school_swaps', userData.schoolCode, 'requests', id))
      loadRequests(db, userData.schoolCode)
    } catch (e) {
      alert('삭제 실패')
    }
  }

  if (loading) return <div className="p-10 text-center">로딩 중...</div>

  const filteredRequests = filter === 'mine' 
    ? requests.filter(r => r.requesterId === auth.currentUser?.uid)
    : requests

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4 sm:px-6 lg:px-8">
      <div className="max-w-5xl mx-auto">
        
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">수업 교환 장터 🛒</h1>
            <p className="text-sm text-gray-600 mt-1">{userData?.schoolName} 선생님들의 요청 목록입니다.</p>
          </div>
          <div className="flex gap-2">
            <button 
              onClick={() => router.push('/teacher/timetable')}
              className="text-gray-500 hover:text-gray-700 font-medium px-3"
            >
              시간표로 돌아가기
            </button>
            <button 
              onClick={() => router.push('/dashboard')}
              className="bg-gray-200 text-gray-700 py-2 px-4 rounded hover:bg-gray-300 transition"
            >
              대시보드
            </button>
          </div>
        </div>

        {/* Filter Tabs */}
        <div className="flex space-x-4 mb-6 border-b border-gray-200 pb-2">
          <button 
            onClick={() => setFilter('all')}
            className={`pb-2 px-1 ${filter === 'all' ? 'border-b-2 border-blue-500 text-blue-600 font-bold' : 'text-gray-500'}`}
          >
            전체 목록
          </button>
          <button 
            onClick={() => setFilter('mine')}
            className={`pb-2 px-1 ${filter === 'mine' ? 'border-b-2 border-blue-500 text-blue-600 font-bold' : 'text-gray-500'}`}
          >
            내 요청
          </button>
        </div>

        {/* Request Grid */}
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {filteredRequests.length === 0 ? (
            <div className="col-span-full text-center py-10 text-gray-500">
              요청 내역이 없습니다. 시간표에서 교환 요청을 등록해보세요!
            </div>
          ) : filteredRequests.map((req) => (
            <div key={req.id} className={`bg-white rounded-xl shadow-md border overflow-hidden ${req.status === 'matched' ? 'border-green-200 bg-green-50' : 'border-gray-100'}`}>
              <div className="p-6">
                <div className="flex justify-between items-start">
                  <div>
                    <span className={`inline-block px-2 py-1 text-xs font-semibold rounded-full mb-2 ${req.status === 'matched' ? 'bg-green-200 text-green-800' : 'bg-red-100 text-red-800'}`}>
                      {req.status === 'matched' ? '매칭 완료' : '교환 대기중'}
                    </span>
                    <h3 className="text-xl font-bold text-gray-900">
                      {req.dayLabel}요일 {req.period}교시
                    </h3>
                    <p className="text-lg text-blue-600 font-medium">{req.subject}</p>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold text-gray-700">{req.requesterName} T</div>
                    <div className="text-xs text-gray-500">{req.requesterClass}</div>
                  </div>
                </div>
                
                <div className="mt-4 p-3 bg-gray-50 rounded-lg text-sm text-gray-600">
                  "{req.note || '메시지가 없습니다.'}"
                </div>

                {req.status === 'matched' && (
                  <div className="mt-4 text-center text-sm font-bold text-green-700">
                    🤝 {req.accepterName} 선생님과 매칭됨!
                  </div>
                )}
              </div>

              <div className="px-6 py-4 bg-gray-50 border-t border-gray-100">
                {req.requesterId === auth.currentUser?.uid ? (
                  <button 
                    onClick={() => handleDelete(req.id)}
                    className="w-full py-2 text-red-600 font-bold hover:bg-red-50 rounded transition"
                  >
                    삭제하기
                  </button>
                ) : (
                  req.status === 'pending' ? (
                    <button 
                      onClick={() => handleAccept(req)}
                      className="w-full py-2 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700 transition shadow-sm"
                    >
                      제가 할게요! 🙋‍♂️
                    </button>
                  ) : (
                    <button disabled className="w-full py-2 text-gray-400 font-bold cursor-not-allowed">
                      이미 마감됨
                    </button>
                  )
                )}
              </div>
            </div>
          ))}
        </div>

      </div>
    </div>
  )
}
