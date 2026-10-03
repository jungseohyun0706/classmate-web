import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/router'
import { auth, db } from '../../lib/firebase'
import { onAuthStateChanged } from 'firebase/auth'
import {
  addDoc,
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from 'firebase/firestore'
import { toDataURL } from 'qrcode'
import { issueJoinToken, JOIN_TOKEN_TTL_MS } from '../../lib/join'
import { useUI } from '../../components/ui/feedback'
import InvitePanel from '../../components/timetable/InvitePanel'
import { findCourseForLegacyGroup } from '../../lib/timetable/teacherClient'

interface PendingStudent {
  id: string
  name: string
  studentId?: string
  /** 반 이동 신청이면 지금 본반 classId */
  moveFromClassId?: string
}

/** classId → '1학년 3반' (수업 그룹이면 '1학년 3반 수업') */
function classLabelOf(classId: string): string {
  const isGroup = /_g_[A-Za-z0-9]+$/.test(classId)
  const parts = classId.replace(/_g_[A-Za-z0-9]+$/, '').split('_')
  if (parts.length < 3) return classId
  const base = `${parts[parts.length - 2]}학년 ${parts[parts.length - 1]}반`
  return isGroup ? `${base} 수업` : base
}

function byStudentNo(a: PendingStudent, b: PendingStudent): number {
  const an = parseInt(a.studentId ?? '', 10)
  const bn = parseInt(b.studentId ?? '', 10)
  const av = Number.isFinite(an) ? an : 9999
  const bv = Number.isFinite(bn) ? bn : 9999
  if (av !== bv) return av - bv
  return a.name.localeCompare(b.name, 'ko')
}

const RING_RADIUS = 16
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

export default function ClassQrPage() {
  const router = useRouter()
  const { toast } = useUI()

  const [loading, setLoading] = useState(true)
  const [userData, setUserData] = useState<any>(null)
  // 대상 반 — ?classId= 로 수업 반도 지정 가능 (기본: 담임 반)
  const [targetClass, setTargetClass] = useState<{
    classId: string
    grade: string | number
    classNm: string | number
    schoolName: string
    schoolCode: string
    isGroup: boolean
    /** 이 반 teacherId가 나인지 — 반 이동 신청은 담임만 처리 */
    isClassTeacher: boolean
  } | null>(null)

  const [issuing, setIssuing] = useState(false)
  const [joinUrl, setJoinUrl] = useState('')
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [expiresAtMs, setExpiresAtMs] = useState(0)
  const [nowMs, setNowMs] = useState(() => Date.now())

  // 실시간 입장 신청 목록 (QR을 띄운 채 바로 승인)
  const [homePending, setHomePending] = useState<PendingStudent[]>([])
  // 다른 반에서 옮겨 오려는 반 이동 신청 (학생 관리와 같은 기준: 이 반 담임에게만)
  const [movePending, setMovePending] = useState<PendingStudent[]>([])
  const pending = useMemo(
    () =>
      [...homePending, ...movePending.filter((m) => !homePending.some((p) => p.id === m.id))].sort(
        byStudentNo
      ),
    [homePending, movePending]
  )
  const [busyId, setBusyId] = useState<string | null>(null)
  const [approvedCount, setApprovedCount] = useState(0)
  // 예전 수업 그룹이면 연결된 수업(course.legacyGroupId) — undefined: 확인 중, null: 없음(또는 확인 실패)
  const [linkedCourse, setLinkedCourse] = useState<{ courseId: string; title: string } | null | undefined>(undefined)
  const pendingRef = useRef<HTMLDivElement>(null)
  const prevPendingCount = useRef(0)

  // 첫 신청이 들어오면 (모바일에서 화면 밖에 있는) 신청 패널로 스크롤
  useEffect(() => {
    if (prevPendingCount.current === 0 && pending.length > 0) {
      pendingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
    prevPendingCount.current = pending.length
  }, [pending.length])

  // 토큰 발급 (로드 시 자동 + 새 코드 만들기)
  const issue = useCallback(
    async (classId: string) => {
      setIssuing(true)
      try {
        const { url, expiresAtMs: expiry } = await issueJoinToken(classId)
        setJoinUrl(url)
        setExpiresAtMs(expiry)
      } catch (e) {
        console.error(e)
        toast('입장 코드를 만들지 못했어요. 잠시 후 다시 시도해 주세요.', 'error')
      } finally {
        setIssuing(false)
      }
    },
    [toast]
  )

  // 교사 가드 + 자동 발급
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.replace('/auth/login')
        return
      }
      try {
        const { db } = await import('../../lib/firebase')
        const snap = await getDoc(doc(db, 'users', u.uid))
        if (snap.exists()) {
          const data = snap.data()
          if (data.role === 'student') {
            router.replace('/student/today')
            return
          }
          const requested = new URLSearchParams(window.location.search).get('classId')
          const target = requested || String(data.classId || '')
          if (!target) {
            toast('먼저 반을 등록하거나 학생 관리에서 수업 반을 추가해 주세요.', 'error')
            router.replace('/teacher/students')
            return
          }
          const clsSnap = await getDoc(doc(db, 'classes', target))
          if (!clsSnap.exists() || String(clsSnap.data().schoolCode) !== String(data.schoolCode)) {
            toast('반 정보를 찾을 수 없어요.', 'error')
            router.replace('/teacher/students')
            return
          }
          const cls = clsSnap.data()
          setTargetClass({
            classId: target,
            grade: cls.grade,
            classNm: cls.classNm,
            schoolName: String(cls.schoolName || data.schoolName || ''),
            schoolCode: String(data.schoolCode),
            isGroup: cls.isGroup === true,
            isClassTeacher: cls.teacherId === u.uid,
          })
          setUserData(data)
          void issue(target)
        } else {
          router.replace('/dashboard')
          return
        }
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    })
    return () => unsub()
  }, [router, toast, issue])

  // 수업 그룹(예전 방식): 연결된 수업이 있으면 그 수업 상세로 안내
  useEffect(() => {
    const classId = targetClass?.classId
    const schoolCode = targetClass?.schoolCode
    if (!classId || !schoolCode || !targetClass?.isGroup) {
      setLinkedCourse(undefined)
      return
    }
    let cancelled = false
    findCourseForLegacyGroup(schoolCode, classId)
      .then((c) => {
        if (!cancelled) setLinkedCourse(c)
      })
      .catch((e) => {
        console.error('연결된 수업 확인 실패', (e as { code?: string })?.code)
        if (!cancelled) setLinkedCourse(null)
      })
    return () => {
      cancelled = true
    }
  }, [targetClass?.classId, targetClass?.schoolCode, targetClass?.isGroup])

  // 1초 카운트다운 틱
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  // 입장 신청 실시간 구독 — 학생이 신청하면 QR 아래에 바로 나타남
  useEffect(() => {
    const classId = targetClass?.classId
    if (!classId) return
    const q = query(
      collection(db, 'users'),
      where('classId', '==', String(classId)),
      where('role', '==', 'student')
    )
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: PendingStudent[] = []
        snap.forEach((d) => {
          const v = d.data()
          if (v.status === 'pending') {
            list.push({
              id: d.id,
              name: String(v.name || v.displayName || '이름 없음'),
              studentId: v.studentId ? String(v.studentId) : undefined,
            })
          }
        })
        setHomePending(list)
      },
      (e) => console.error('입장 신청 구독 실패', e)
    )
    return () => unsub()
  }, [targetClass?.classId])

  // 반 이동 신청 실시간 구독 — 같은 학교 조건은 보안 규칙(같은 학교 교사만 읽기)을 통과시키기 위함
  useEffect(() => {
    const classId = targetClass?.classId
    const schoolCode = targetClass?.schoolCode
    if (!classId || !schoolCode || !targetClass?.isClassTeacher) {
      setMovePending([])
      return
    }
    const q = query(
      collection(db, 'users'),
      where('pendingClassId', '==', String(classId)),
      where('role', '==', 'student'),
      where('schoolCode', '==', schoolCode)
    )
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: PendingStudent[] = []
        snap.forEach((d) => {
          const v = d.data()
          const no = v.pendingStudentId ?? v.studentId
          list.push({
            id: d.id,
            name: String(v.name || v.displayName || '이름 없음'),
            studentId: no ? String(no) : undefined,
            moveFromClassId: String(v.classId || ''),
          })
        })
        setMovePending(list)
      },
      (e) => console.error('반 이동 신청 구독 실패', e)
    )
    return () => unsub()
  }, [targetClass?.classId, targetClass?.schoolCode, targetClass?.isClassTeacher])

  // 승인 + 학생에게 알림 (실패 시 목록은 스냅샷이 되돌려줌)
  const approveOne = useCallback(
    async (student: PendingStudent) => {
      if (busyId) return
      const classId = targetClass?.classId
      if (!classId) return
      setBusyId(student.id)
      try {
        // 반 이동 신청: 서버가 학생 문서를 다시 확인해 본반을 옮기고 학생에게 알림까지 보냄
        if (student.moveFromClassId) {
          const token = await auth.currentUser?.getIdToken()
          const resp = await fetch('/api/class-membership', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ action: 'approve-move', classId, studentUid: student.id }),
          })
          if (resp.status === 409) {
            toast(`${student.name} 학생의 신청은 이미 처리되었어요.`, 'info')
            setMovePending((list) => list.filter((p) => p.id !== student.id))
            return
          }
          if (!resp.ok) {
            const data = await resp.json().catch(() => ({}))
            throw new Error(data?.error || `class-membership ${resp.status}`)
          }
          setApprovedCount((n) => n + 1)
          toast(`${student.name} 승인 완료`, 'success')
          return
        }
        // 화면의 목록이 늦게 갱신되는 사이 학생이 다른 반 QR로 다시 신청했을 수 있으니,
        // 지금도 이 반에 대기 중일 때만 승인 (아니면 다른 반 승인 없이 입장돼 버림)
        const result = await runTransaction(db, async (tx) => {
          const ref = doc(db, 'users', student.id)
          const snap = await tx.get(ref)
          if (!snap.exists()) return 'done' as const
          const v = snap.data()
          if (String(v.classId ?? '') !== String(classId)) return 'moved' as const
          if (v.status !== 'pending') return 'done' as const
          tx.update(ref, { status: 'approved' })
          return 'approved' as const
        })
        if (result !== 'approved') {
          toast(
            result === 'moved'
              ? `${student.name} 학생이 다른 반으로 신청을 옮겼어요.`
              : `${student.name} 학생의 신청은 이미 처리되었어요.`,
            'info'
          )
          setHomePending((list) => list.filter((p) => p.id !== student.id))
          return
        }
        setApprovedCount((n) => n + 1)
        toast(`${student.name} 승인 완료`, 'success')
        try {
          const title = '우리 반 입장 완료 🎉'
          const body = `${targetClass?.schoolName || ''} ${targetClass?.grade || ''}학년 ${targetClass?.classNm || ''}반 학생이 되었어요!`
          const url = '/student/today'
          await addDoc(collection(db, 'users', student.id, 'notifications'), {
            title,
            body,
            url,
            createdAt: serverTimestamp(),
            read: false,
          })
          void auth.currentUser?.getIdToken().then((t) =>
            fetch('/api/notify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
              body: JSON.stringify({ toUid: student.id, title, body, url }),
            }).catch(() => {})
          )
        } catch (notifyErr) {
          console.error(notifyErr)
        }
      } catch (e) {
        console.error(e)
        toast('승인에 실패했어요. 다시 시도해 주세요.', 'error')
      } finally {
        setBusyId(null)
      }
    },
    [busyId, toast, targetClass]
  )

  const approveAll = useCallback(async () => {
    for (const s of pending) {
      // eslint-disable-next-line no-await-in-loop
      await approveOne(s)
    }
  }, [pending, approveOne])

  // 링크 → QR 이미지
  useEffect(() => {
    if (!joinUrl) return
    let cancelled = false
    toDataURL(joinUrl, {
      width: 720,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#111827', light: '#ffffff' },
    })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl)
      })
      .catch((e) => {
        console.error(e)
        toast('QR 코드를 그리지 못했어요.', 'error')
      })
    return () => {
      cancelled = true
    }
  }, [joinUrl, toast])

  const handleCopy = async () => {
    if (!joinUrl) return
    try {
      await navigator.clipboard.writeText(joinUrl)
      toast('입장 링크를 복사했어요.', 'success')
    } catch {
      toast('복사하지 못했어요. 링크를 길게 눌러 복사해 주세요.', 'error')
    }
  }

  if (loading) return <div className="p-10 text-center text-black">로딩 중...</div>

  const totalSec = JOIN_TOKEN_TTL_MS / 1000
  const remainingSec = expiresAtMs ? Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000)) : 0
  const expired = !!joinUrl && remainingSec <= 0
  const frac = totalSec > 0 ? remainingSec / totalSec : 0
  const mm = String(Math.floor(remainingSec / 60)).padStart(2, '0')
  const ss = String(remainingSec % 60).padStart(2, '0')

  return (
    <div className="min-h-screen bg-gray-50 py-8 sm:py-10 px-4 sm:px-6 lg:px-8">
      <div className="max-w-lg mx-auto">
        <div className="flex justify-between items-center mb-6 text-black">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">학급 QR 입장코드</h1>
            <p className="text-sm text-gray-600 break-keep">
              {targetClass?.isGroup ? '예전 수업 그룹 입장 QR이에요.' : '학생들을 우리 반에 초대해요. 오래 쓰는 초대 코드를 권장해요.'}
            </p>
          </div>
          <button
            onClick={() => router.push('/dashboard')}
            className="shrink-0 whitespace-nowrap min-h-[44px] text-gray-500 hover:text-gray-700 font-medium px-3"
          >
            나가기
          </button>
        </div>

        {/* 오래 쓰는 학급 초대 코드(권장) — 담임 반만. 수업 그룹은 수업 관리의 수업 초대로 안내 */}
        {targetClass && !targetClass.isGroup && targetClass.isClassTeacher && (
          <div className="mb-6">
            <h2 className="text-lg font-bold text-gray-900">오래 쓰는 초대 코드(권장)</h2>
            <p className="mb-3 text-sm text-gray-600 break-keep">
              한 번 만들면 만료일까지 반 학생 모두가 같은 코드·QR·링크로 들어올 수 있어요. 앱을 설치하거나 로그인한 뒤에도 이어서 참여할 수 있어요.
            </p>
            <InvitePanel
              type="homeroom"
              targetId={targetClass.classId}
              targetLabel={`${targetClass.grade}학년 ${targetClass.classNm}반`}
              schoolName={targetClass.schoolName}
              teacherNames={userData?.displayName || userData?.name ? [String(userData.displayName || userData.name)] : []}
            />
          </div>
        )}
        {targetClass?.isGroup && (
          <div role="note" className="mb-6 rounded-xl border-2 border-amber-300 bg-amber-50 p-4 text-amber-900">
            <p className="font-bold break-keep">이 그룹은 예전 방식입니다 — 수업 관리에서 수업 초대를 쓰세요</p>
            <p className="mt-1 text-sm break-keep">
              수업 초대는 학생의 원래 소속 학급을 그대로 두고 이 수업만 시간표에 추가해요. 아래 10분 QR은 예전처럼 계속 쓸 수 있어요.
            </p>
            {linkedCourse === undefined ? (
              <p className="mt-2 text-sm text-amber-800">연결된 수업 확인 중...</p>
            ) : (
              <button
                type="button"
                onClick={() =>
                  router.push(linkedCourse ? `/teacher/courses/${encodeURIComponent(linkedCourse.courseId)}` : '/teacher/courses')
                }
                className="mt-3 w-full min-h-[44px] rounded-xl bg-amber-600 px-4 text-sm font-bold text-white hover:bg-amber-700 break-keep"
              >
                {linkedCourse ? `연결된 수업 '${linkedCourse.title}'에서 수업 초대 만들기 →` : '수업 관리로 가기 →'}
              </button>
            )}
          </div>
        )}

        <h2 className="mb-2 text-lg font-bold text-gray-900">10분 입장 QR{targetClass && !targetClass.isGroup && targetClass.isClassTeacher ? '(예전 방식)' : ''}</h2>
        <div className="bg-white shadow-lg rounded-xl border border-gray-100 overflow-hidden">
          <div className="p-6 sm:p-8 flex flex-col items-center text-center">
            <h2 className="text-xl sm:text-2xl font-extrabold text-gray-900 break-keep">
              {targetClass?.schoolName} {targetClass?.grade}학년 {targetClass?.classNm}반
              {targetClass?.isGroup && <span className="ml-1.5 align-middle rounded-full bg-cyan-100 px-2 py-0.5 text-xs font-bold text-cyan-700">수업</span>}
            </h2>
            <p className="mt-1 text-sm text-gray-500">카메라로 QR 코드를 스캔하면 입장할 수 있어요.</p>

            {/* QR */}
            <div className="relative mt-6">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt="학급 입장 QR 코드"
                  className={`w-64 h-64 sm:w-80 sm:h-80 rounded-xl border border-gray-200 transition-opacity ${
                    expired || issuing ? 'opacity-20' : 'opacity-100'
                  }`}
                />
              ) : (
                <div className="w-64 h-64 sm:w-80 sm:h-80 rounded-xl border border-gray-200 bg-gray-50 flex items-center justify-center">
                  <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600"></div>
                </div>
              )}
              {expired && (
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-lg font-bold text-gray-900">코드가 만료되었어요</span>
                  <span className="mt-1 text-sm text-gray-500">새 코드를 만들어 주세요.</span>
                </div>
              )}
            </div>

            {/* 카운트다운 */}
            <div className="mt-5 flex items-center justify-center gap-3">
              <svg className="w-10 h-10 -rotate-90" viewBox="0 0 40 40" aria-hidden="true">
                <circle cx="20" cy="20" r={RING_RADIUS} fill="none" stroke="#e5e7eb" strokeWidth="4" />
                <circle
                  cx="20"
                  cy="20"
                  r={RING_RADIUS}
                  fill="none"
                  stroke={expired ? '#ef4444' : remainingSec <= 60 ? '#f59e0b' : '#2563eb'}
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeDasharray={RING_CIRCUMFERENCE}
                  strokeDashoffset={RING_CIRCUMFERENCE * (1 - frac)}
                  style={{ transition: 'stroke-dashoffset 1s linear' }}
                />
              </svg>
              <div className="text-left">
                <p className={`text-xl font-bold tabular-nums ${expired ? 'text-red-500' : 'text-gray-900'}`}>
                  {expired ? '00:00' : `${mm}:${ss}`}
                </p>
                <p className="text-xs text-gray-500">{expired ? '만료됨' : '남은 시간 (10분 유효)'}</p>
              </div>
            </div>

            {/* 새 코드 만들기 */}
            <button
              onClick={() => targetClass?.classId && issue(targetClass.classId)}
              disabled={issuing}
              className="mt-5 w-full sm:w-auto inline-flex justify-center items-center gap-2 py-3 px-8 border border-transparent shadow-sm text-base font-bold rounded-xl text-white bg-blue-600 hover:bg-blue-700 focus:outline-none disabled:opacity-50"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {issuing ? '만드는 중...' : '새 코드 만들기'}
            </button>

            {/* 링크 복사 */}
            {joinUrl && (
              <button
                onClick={handleCopy}
                className="mt-3 w-full flex items-center justify-between gap-2 rounded-lg border border-gray-200 bg-gray-50 hover:bg-gray-100 px-3 py-2 text-left transition"
                title="입장 링크 복사"
              >
                <span className="text-xs text-gray-600 truncate">{joinUrl}</span>
                <span className="flex-shrink-0 inline-flex items-center gap-1 text-xs font-bold text-blue-600">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  복사
                </span>
              </button>
            )}
          </div>

          <div className="bg-gray-50 px-6 py-4 border-t border-gray-100">
            <p className="text-sm text-gray-600 break-keep text-center">
              💡 사용법: 교실 TV나 화면에 이 QR을 띄우고, 학생들이 스마트폰 카메라로 스캔하면 돼요.
            </p>
          </div>
        </div>

        {/* 실시간 입장 신청 — QR을 띄운 채 바로 승인 */}
        <div ref={pendingRef} className="mt-6 bg-white shadow-lg rounded-xl border border-gray-100 p-5">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h3 className="font-bold text-gray-900 flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
              </span>
              입장 신청 {pending.length > 0 && <span className="text-emerald-600">{pending.length}명</span>}
            </h3>
            {pending.length > 1 && (
              <button
                onClick={approveAll}
                disabled={!!busyId}
                className="whitespace-nowrap text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 px-4 py-2 rounded-xl disabled:opacity-50 transition"
              >
                ✓ 모두 승인 ({pending.length})
              </button>
            )}
          </div>

          {pending.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-4">
              {approvedCount > 0
                ? `이번에 ${approvedCount}명을 승인했어요. 새 신청을 기다리는 중...`
                : '학생이 QR을 스캔해 신청하면 여기에 실시간으로 나타나요.'}
            </p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {pending.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <span className="font-bold text-gray-900">{s.name}</span>
                    {s.studentId && <span className="ml-2 text-sm text-gray-400">{s.studentId}번</span>}
                    {s.moveFromClassId && (
                      <p className="text-xs text-gray-500">
                        반 이동 신청 · 현재{' '}
                        {/_g_[A-Za-z0-9]+$/.test(s.moveFromClassId) ? '소속 학급 미설정' : classLabelOf(s.moveFromClassId)}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => approveOne(s)}
                    disabled={!!busyId}
                    className="whitespace-nowrap shrink-0 text-sm font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 px-5 py-2.5 min-h-[44px] rounded-lg disabled:opacity-50 transition"
                  >
                    승인
                  </button>
                </li>
              ))}
            </ul>
          )}

          <button
            onClick={() => router.push('/teacher/students')}
            className="mt-3 w-full text-center text-sm text-gray-400 hover:text-gray-600 py-3 min-h-[44px]"
          >
            거절·전체 명단은 학생 관리에서 →
          </button>
        </div>
      </div>
    </div>
  )
}
