import React, { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '../../../lib/firebase'
import { useUI } from '../../../components/ui/feedback'
import SeriesEditor from '../../../components/timetable/SeriesEditor'
import InvitePanel from '../../../components/timetable/InvitePanel'
import GradePicker, { ClassLabelsInput, splitClassLabelsText } from '../../../components/timetable/GradePicker'
import { formatYmdKo, ymdToIso } from '../../../lib/timetable/dates'
import {
  asApiError,
  CHANGE_FIELD_LABEL,
  COURSE_SOURCE_LABEL,
  decideEnrollment,
  endCourse,
  ENROLLMENT_SOURCE_LABEL,
  errorText,
  formatMsDate,
  getCourse,
  listChangeSets,
  listCourses,
  listEnrollments,
  listOrphans,
  scheduleChangesHref,
  setCommon,
  termLabel,
  todayYmd,
  updateCourse,
  useTeacherProfile,
  type ChangeSetSummaryView,
  type CourseDetailResponse,
  type EnrolledStudentView,
  type EnrollmentListResponse,
  type InvitePolicy,
  type OrphanView,
  type TeacherApiError,
} from '../../../lib/timetable/teacherClient'
import { checkMyHomeroom, courseEndState, effectiveDateFromIso, type HomeroomCheck } from '../../../lib/timetable/teacherCourseView'
import type { SlotState } from '../../../lib/timetable/types'

// 수업 상세 — 기본 정보(수정·종료), 반복 차시(SeriesEditor), 수업 초대(InvitePanel), 수강생(승인 대기 승인/거절, 수강 종료),
// 공통 수업 설정(담임만), 변경 이력·검토 필요(orphan) 요약 + 일정 변경 화면 링크.
// 권한 없음(403)과 없는 수업(404)은 서로 다른 안내로 보여 주고, 원인을 모르는 오류는 '다시 시도'로 둡니다.
// 운영 여부는 서버와 같은 기준(courseActiveOn(오늘))으로 판정 — 종료일을 미래로 정한 수업은 그날 전까지 '종료 예정'으로 운영 중과 같게 다룹니다.
// 내부 id(uid, courseId 등)는 화면에 보이지 않습니다.

function ErrorBox({ err, title, onRetry }: { err: TeacherApiError; title: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 break-keep">
      <p className="font-bold">⚠️ {title}</p>
      {/* Firestore 직접 읽기 오류는 서버 문구가 없어 빈 문구일 수 있음 */}
      <p className="mt-1">{errorText(err) || (err.code === 'network' ? '서버에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.' : '잠시 후 다시 시도해 주세요.')}</p>
      {onRetry && err.retryable && (
        <button type="button" onClick={onRetry} className="mt-2 min-h-[44px] rounded-lg bg-white border border-red-200 px-4 font-bold text-red-700 hover:bg-red-100">
          다시 시도
        </button>
      )}
    </div>
  )
}

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-sm" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-3">
        <h2 className="text-lg font-bold">{title}</h2>
        {aside}
      </div>
      <div className="p-4">{children}</div>
    </section>
  )
}

const CHANGE_KIND_LABEL: Record<string, string> = {
  cancel: '취소',
  reschedule: '변경',
  makeup: '보강',
  restore: '원래대로',
  base: '기본 시간표 변경',
}

const CHANGE_STATUS: Record<ChangeSetSummaryView['status'], { label: string; cls: string }> = {
  published: { label: '발행됨', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  'pending-approval': { label: '승인 대기', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  rejected: { label: '거절됨', cls: 'bg-gray-100 text-gray-600 border-gray-200' },
}

function slotText(s: SlotState | null): string {
  if (!s) return '없음'
  return `${formatYmdKo(s.date)} ${s.period}교시${s.roomName ? ` · ${s.roomName}` : ''}`
}

function StudentLine({ s, children }: { s: EnrolledStudentView; children?: React.ReactNode }) {
  return (
    <li className="px-3 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center min-w-0">
        <span className="h-9 w-9 shrink-0 rounded-full bg-gray-100 text-gray-700 flex items-center justify-center font-bold text-sm mr-3" aria-label="번호">
          {s.studentId ?? '-'}
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-gray-900 truncate">{s.name}</p>
          <p className="text-xs text-gray-600 break-words">
            소속 {s.homeroomLabel || '확인 필요'} · {ENROLLMENT_SOURCE_LABEL[s.source] || '기타'}
            {s.status === 'active' && s.from ? ` · ${formatYmdKo(s.from)}부터` : ''}
            {s.status === 'ended' && s.to ? ` · ${formatYmdKo(s.to)}부터 빠짐` : ''}
            {s.status === 'ended' && !s.to ? ' · 참여 전 종료(거절 등)' : ''}
          </p>
        </div>
      </div>
      {children}
    </li>
  )
}

export default function TeacherCourseDetailPage() {
  const router = useRouter()
  const { toast, confirm } = useUI()
  const { profile, loading: profileLoading, error: profileError, retry: retryProfile } = useTeacherProfile()
  const today = useMemo(() => todayYmd(), [])
  const courseId = router.isReady && typeof router.query.id === 'string' ? router.query.id : ''

  const [detail, setDetail] = useState<CourseDetailResponse | null>(null)
  const [detailError, setDetailError] = useState<TeacherApiError | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const [enr, setEnr] = useState<EnrollmentListResponse | null>(null)
  const [enrError, setEnrError] = useState<TeacherApiError | null>(null)
  const [enrBusy, setEnrBusy] = useState<string | null>(null)

  const [history, setHistory] = useState<ChangeSetSummaryView[] | null>(null)
  const [historyError, setHistoryError] = useState<TeacherApiError | null>(null)
  const [orphans, setOrphans] = useState<OrphanView[] | null>(null)
  const [orphansError, setOrphansError] = useState<TeacherApiError | null>(null)

  // 내 담임 반 확인 — 읽기 실패('error')를 '담임 아님'('none')과 구분(실패를 권한 없음으로 위장하지 않음)
  const [homeroomCheck, setHomeroomCheck] = useState<HomeroomCheck>({ status: 'loading' })
  const [homeroomAttempt, setHomeroomAttempt] = useState(0)
  const [commonBusy, setCommonBusy] = useState(false)

  // 수정
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({
    title: '',
    subject: '',
    section: '',
    defaultRoomName: '',
    teacherNames: '',
    invitePolicy: 'auto' as InvitePolicy,
    catalogVisible: false,
    grades: [] as number[],
    classLabels: '',
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<TeacherApiError | null>(null)
  // 종료
  const [endOpen, setEndOpen] = useState(false)
  const [endIso, setEndIso] = useState(ymdToIso(today))
  const [ending, setEnding] = useState(false)

  const loadDetail = useCallback(async () => {
    if (!courseId) return
    setDetailLoading(true)
    setDetailError(null)
    try {
      setDetail(await getCourse(courseId))
    } catch (e) {
      const err = asApiError(e)
      console.error('course-detail: 불러오기 실패', err.code)
      setDetailError(err)
    } finally {
      setDetailLoading(false)
    }
  }, [courseId])

  const loadEnrollments = useCallback(async () => {
    if (!courseId) return
    setEnrError(null)
    try {
      setEnr(await listEnrollments(courseId))
    } catch (e) {
      const err = asApiError(e)
      console.error('course-detail: 수강생 실패', err.code)
      setEnrError(err)
    }
  }, [courseId])

  const loadHistory = useCallback(async () => {
    if (!courseId) return
    setHistoryError(null)
    setOrphansError(null)
    await Promise.all([
      listChangeSets(courseId)
        .then(setHistory)
        .catch((e) => {
          const err = asApiError(e)
          console.error('course-detail: 변경 이력 실패', err.code)
          setHistoryError(err)
        }),
      listOrphans(courseId)
        .then(setOrphans)
        .catch((e) => {
          const err = asApiError(e)
          console.error('course-detail: 검토 필요 실패', err.code)
          setOrphansError(err)
        }),
    ])
  }, [courseId])

  useEffect(() => {
    if (!profile || !courseId) return
    void loadDetail()
  }, [profile, courseId, loadDetail])

  // 상세를 볼 수 있을 때만 나머지(권한 없는 사람에게 명단·이력 요청을 보내지 않음)
  const detailOk = !!detail
  useEffect(() => {
    if (!detailOk) return
    void loadEnrollments()
    void loadHistory()
  }, [detailOk, loadEnrollments, loadHistory])

  // 내 담임 반(공통 수업 설정용) — 화면 표시용 확인, 실제 권한은 서버가 판정
  useEffect(() => {
    let cancelled = false
    setHomeroomCheck({ status: 'loading' })
    void checkMyHomeroom({
      homeroomId: profile?.homeroomId,
      uid: profile?.uid,
      readClass: async (id) => {
        if (!db) throw Object.assign(new Error('not-configured'), { code: 'not-configured' })
        const s = await getDoc(doc(db, 'classes', id))
        return s.exists() ? (s.data() as Record<string, any>) : null
      },
      // schoolCode 없는 예전 학급 문서는 규칙상 직접 읽기가 거부됨 → 서버(setCommon과 같은 기준)가 판정한 담임 반 목록으로 확인
      serverHomerooms: async () => (await listCourses()).homerooms,
    }).then((r) => {
      if (cancelled) return
      if (r.status === 'error') console.error('course-detail: 담임 반 확인 실패', (r.error as { code?: string })?.code)
      setHomeroomCheck(r)
    })
    return () => {
      cancelled = true
    }
  }, [profile?.homeroomId, profile?.uid, homeroomAttempt])

  const myHomeroom = homeroomCheck.status === 'ok' ? homeroomCheck.ref : null
  const course = detail?.course || null
  const endState = course ? courseEndState(course, today) : null
  /** 오늘 운영하지 않음(종료일이 오늘이거나 지남) */
  const ended = !!endState?.ended
  /** 종료일을 미래로 정해 둠 — 그 전까지는 승인·초대·차시 편집·정보 수정 모두 가능(서버도 그날 전까지 운영 중으로 봄) */
  const endScheduled = !!endState?.endScheduled

  const startEdit = () => {
    if (!course) return
    setForm({
      title: course.title,
      subject: course.subject,
      section: course.section || '',
      defaultRoomName: course.defaultRoomName || '',
      teacherNames: course.teacherNames.join(', '),
      invitePolicy: course.invitePolicy,
      catalogVisible: course.catalogVisible,
      grades: Array.isArray(course.grades) ? course.grades : [],
      classLabels: Array.isArray(course.classLabels) ? course.classLabels.join(', ') : '',
    })
    setSaveError(null)
    setEditing(true)
  }

  const save = async () => {
    if (!course || saving) return
    if (!form.title.trim() || !form.subject.trim()) {
      toast('수업 이름과 과목을 입력해 주세요.', 'error')
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const r = await updateCourse(course.courseId, {
        title: form.title.trim(),
        subject: form.subject.trim(),
        section: form.section.trim() || null,
        defaultRoomName: form.defaultRoomName.trim() || null,
        teacherNames: form.teacherNames
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
        invitePolicy: form.invitePolicy,
        catalogVisible: form.catalogVisible,
        grades: form.grades,
        classLabels: splitClassLabelsText(form.classLabels),
      })
      toast(r.already ? '바뀐 내용이 없어요.' : '수업 정보를 저장했어요.', 'success')
      setEditing(false)
      await loadDetail()
    } catch (e) {
      const err = asApiError(e)
      if (err.code === 'nothing-to-update') {
        toast('바뀐 내용이 없어요.', 'info')
        setEditing(false)
      } else {
        console.error('course-detail: 저장 실패', err.code)
        setSaveError(err)
      }
    } finally {
      setSaving(false)
    }
  }

  const end = async () => {
    if (!course || ending) return
    // 지난 날짜로 끝내면 지난 학생 시간표에서 수업이 소급해 사라지므로 오늘부터만(차시 종료·추가와 같은 기준)
    const d = effectiveDateFromIso(endIso, today, '종료일을 골라 주세요.')
    if (!d.ok) {
      toast(d.error, 'error')
      return
    }
    const endedOn = d.ymd
    const future = endedOn > today
    const ok = await confirm({
      title: future ? `'${course.title}' 수업을 ${formatYmdKo(endedOn)}부터 끝낼까요?` : `'${course.title}' 수업을 끝낼까요?`,
      description:
        `${formatYmdKo(endedOn)}부터 모든 학생 시간표에서 이 수업이 빠지고, 그 전 날짜 기록은 그대로 남아요. 그날부터 이 수업의 초대 코드도 쓸 수 없어요.` +
        (future ? ' 그 전까지는 지금처럼 운영돼요(초대 코드 참여·승인·차시 편집 가능). 종료일은 그 전에 다시 바꿀 수 있어요.' : ''),
      confirmText: future ? '이 날짜에 끝내기' : '수업 끝내기',
      cancelText: '취소',
      danger: true,
    })
    if (!ok) return
    setEnding(true)
    try {
      const r = await endCourse(course.courseId, endedOn)
      toast(r.already ? '이미 그 날짜로 끝나도록 정해진 수업이에요.' : future ? `${formatYmdKo(endedOn)}부터 끝나도록 정했어요.` : '수업을 끝냈어요.', 'success')
      setEndOpen(false)
      await loadDetail()
    } catch (e) {
      const err = asApiError(e)
      console.error('course-detail: 종료 실패', err.code)
      toast(errorText(err), 'error')
    } finally {
      setEnding(false)
    }
  }

  const decide = async (s: EnrolledStudentView, action: 'approve' | 'reject' | 'end') => {
    if (!course || enrBusy) return
    if (action !== 'approve') {
      const ok = await confirm(
        action === 'reject'
          ? {
              title: `${s.name} 학생의 참여 신청을 거절할까요?`,
              description: '학생 시간표에 이 수업이 들어가지 않아요. 학생이 다시 신청하면 승인 대기로 다시 와요.',
              confirmText: '거절하기',
              cancelText: '취소',
              danger: true,
            }
          : {
              title: `${s.name} 학생의 수강을 끝낼까요?`,
              description: `오늘(${formatYmdKo(today)})부터 이 학생 시간표에서 이 수업이 빠져요. 지난 날짜 기록은 그대로 남고, 학생의 소속 학급은 바뀌지 않아요.`,
              confirmText: '수강 종료',
              cancelText: '취소',
              danger: true,
            }
      )
      if (!ok) return
    }
    setEnrBusy(s.uid)
    try {
      const r = await decideEnrollment(action, course.courseId, s.uid)
      toast(
        r.already ? '이미 처리된 학생이에요.' : action === 'approve' ? `${s.name} 학생을 승인했어요.` : action === 'reject' ? '거절했어요.' : '수강을 끝냈어요.',
        'success'
      )
      await Promise.all([loadEnrollments(), loadDetail()])
    } catch (e) {
      const err = asApiError(e)
      console.error('course-detail: 수강 처리 실패', err.code)
      toast(errorText(err), 'error')
      if (err.code === 'not-pending' || err.code === 'enrollment-not-found') void loadEnrollments()
    } finally {
      setEnrBusy(null)
    }
  }

  const toggleCommon = async (enabled: boolean) => {
    if (!course || !myHomeroom || commonBusy) return
    const ok = await confirm(
      enabled
        ? {
            title: `${myHomeroom.label} 학생 전체의 공통 수업으로 지정할까요?`,
            description: `${myHomeroom.label} 학생 모두(지금과 앞으로 들어올 학생 포함)의 개인 시간표에 이 수업이 들어가요. 반 학생 일부만 듣는 선택·이동 수업이면 지정하지 말고 수업 초대나 수강 명단으로 연결하세요.`,
            confirmText: '반 전체 공통 수업으로 지정',
            cancelText: '취소',
          }
        : {
            title: `${myHomeroom.label} 공통 수업 지정을 해제할까요?`,
            description: `${myHomeroom.label} 학생들의 개인 시간표에서 이 수업이 빠져요. 초대·명단으로 따로 참여한 학생은 그대로예요.`,
            confirmText: '해제하기',
            cancelText: '취소',
            danger: true,
          }
    )
    if (!ok) return
    setCommonBusy(true)
    try {
      const r = await setCommon(course.courseId, myHomeroom.classId, enabled)
      toast(r.already ? '이미 그렇게 돼 있어요.' : enabled ? '반 전체 공통 수업으로 지정했어요.' : '공통 수업 지정을 해제했어요.', 'success')
      await loadDetail()
    } catch (e) {
      const err = asApiError(e)
      console.error('course-detail: 공통 수업 설정 실패', err.code)
      toast(errorText(err), 'error')
    } finally {
      setCommonBusy(false)
    }
  }

  // ───── 화면 ─────

  if (profileError) {
    return (
      <div className="min-h-screen bg-gray-50 px-4 py-10 text-black">
        <div className="max-w-md mx-auto">
          <ErrorBox err={profileError} title="내 정보를 불러오지 못했어요" onRetry={retryProfile} />
        </div>
      </div>
    )
  }

  const backBar = (
    <div className="flex items-center justify-between gap-3">
      <button type="button" onClick={() => router.push('/teacher/courses')} className="shrink-0 whitespace-nowrap min-h-[44px] px-2 text-gray-600 hover:text-gray-800">
        ← 수업 목록
      </button>
      {course && (
        <Link
          href={scheduleChangesHref(course.courseId)}
          className="shrink-0 inline-flex items-center min-h-[44px] rounded-xl bg-red-600 px-4 text-sm font-bold text-white hover:bg-red-700"
        >
          일정 변경
        </Link>
      )}
    </div>
  )

  if (profileLoading || !profile || (!detail && !detailError)) {
    return (
      <div className="min-h-screen bg-gray-50 py-6 px-4 text-gray-900">
        <div className="max-w-3xl mx-auto">
          {backBar}
          <div className="mt-10 flex justify-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" aria-label="불러오는 중" />
          </div>
          {detailLoading && <p className="mt-3 text-center text-sm text-gray-400">수업 정보를 불러오는 중...</p>}
        </div>
      </div>
    )
  }

  if (detailError) {
    const notFound = detailError.kind === 'not-found' || detailError.code === 'invalid-id'
    const forbidden = detailError.kind === 'forbidden'
    return (
      <div className="min-h-screen bg-gray-50 py-6 px-4 text-gray-900">
        <div className="max-w-3xl mx-auto space-y-4">
          {backBar}
          {notFound ? (
            <div role="alert" className="rounded-xl border border-gray-200 bg-white p-6 text-center break-keep">
              <p className="text-3xl" aria-hidden="true">🔍</p>
              <h1 className="mt-2 text-xl font-bold">수업을 찾을 수 없어요</h1>
              <p className="mt-2 text-sm text-gray-600">주소가 잘못됐거나, 우리 학교 수업이 아니거나, 이미 지워진 수업일 수 있어요.</p>
            </div>
          ) : forbidden ? (
            <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-center break-keep">
              <p className="text-3xl" aria-hidden="true">🔒</p>
              <h1 className="mt-2 text-xl font-bold">이 수업을 관리할 권한이 없어요</h1>
              <p className="mt-2 text-sm text-gray-700">수업의 담당·관리 선생님만 볼 수 있어요. 필요하면 담당 선생님께 확인해 주세요.</p>
            </div>
          ) : (
            <ErrorBox err={detailError} title="수업 정보를 불러오지 못했어요" onRetry={() => void loadDetail()} />
          )}
          <button
            type="button"
            onClick={() => router.push('/teacher/courses')}
            className="w-full min-h-[48px] rounded-xl border border-gray-300 bg-white font-bold text-gray-800 hover:bg-gray-50"
          >
            수업 목록으로
          </button>
        </div>
      </div>
    )
  }

  if (!detail || !course) return null
  const counts = enr?.counts || detail.counts
  const students = enr?.students || []
  const pending = students.filter((s) => s.status === 'pending')
  const active = students.filter((s) => s.status === 'active')
  const pastStudents = students.filter((s) => s.status === 'ended')
  const isCommonForMine = !!myHomeroom && course.commonForHomerooms.includes(myHomeroom.classId)

  return (
    <div className="min-h-screen bg-gray-50 py-6 sm:py-10 px-4 sm:px-6 lg:px-8 text-gray-900">
      <div className="max-w-3xl mx-auto space-y-5">
        {backBar}

        {/* 기본 정보 */}
        <section className="rounded-xl border border-gray-200 bg-white shadow-sm p-4" aria-label="기본 정보">
          <div className="flex flex-wrap items-center gap-1.5">
            {ended ? (
              <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-bold text-gray-700">⛔ 종료{course.endedOn ? ` (${formatYmdKo(course.endedOn)}부터)` : ''}</span>
            ) : endScheduled && course.endedOn ? (
              <span className="rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-xs font-bold text-amber-800">⏳ {formatYmdKo(course.endedOn)}부터 종료 예정</span>
            ) : (
              <span className="rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-xs font-bold text-emerald-700">✓ 운영 중</span>
            )}
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-bold text-gray-700">{COURSE_SOURCE_LABEL[course.source] || '수업'}</span>
          </div>
          <h1 className="mt-2 text-2xl font-bold break-words">{course.title}</h1>
          {!editing ? (
            <>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                <dt className="text-gray-500">과목</dt>
                <dd className="min-w-0 break-words">{course.subject || '—'}</dd>
                <dt className="text-gray-500">분반</dt>
                <dd className="min-w-0 break-words">{course.section || '없음'}</dd>
                <dt className="text-gray-500">학기</dt>
                <dd>{termLabel(course.termId)}</dd>
                <dt className="text-gray-500">교사</dt>
                <dd className="min-w-0 break-words">{course.teacherNames.length ? course.teacherNames.join(', ') : '미확인'}</dd>
                <dt className="text-gray-500">기본 수업 교실</dt>
                <dd className="min-w-0 break-words">{course.defaultRoomName || '미정'}</dd>
                <dt className="text-gray-500">초대 참여</dt>
                <dd>{course.invitePolicy === 'approval' ? '선생님 승인 후 참여' : '바로 참여'}</dd>
                <dt className="text-gray-500">학생 수업 담기</dt>
                <dd>{course.catalogVisible ? '공개(학생이 골라 담을 수 있음)' : '공개 안 함'}</dd>
                <dt className="text-gray-500">대상 학년</dt>
                <dd>{Array.isArray(course.grades) && course.grades.length ? course.grades.map((g) => `${g}학년`).join(', ') : '정하지 않음(모든 학년)'}</dd>
                <dt className="text-gray-500">대상 반</dt>
                <dd className="min-w-0 break-words">
                  {Array.isArray(course.classLabels) && course.classLabels.length
                    ? `${course.classLabels.join(', ')}${course.classLabels.length === 1 ? ' (이 반 학생에게만 보임)' : ''}`
                    : '정하지 않음'}
                </dd>
                <dt className="text-gray-500">반 전체 공통</dt>
                <dd className="min-w-0 break-words">{detail.commonHomerooms.length ? detail.commonHomerooms.map((h) => h.label).join(', ') : '없음'}</dd>
                {course.legacyGroupId && (
                  <>
                    <dt className="text-gray-500">예전 수업 그룹</dt>
                    <dd>연결됨(톡방·공지 유지)</dd>
                  </>
                )}
              </dl>
              {!ended && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="button" onClick={startEdit} className="min-h-[44px] rounded-lg border border-gray-300 bg-white px-4 text-sm font-bold hover:bg-gray-50">
                    정보 수정
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      // 종료 예정이면 지금 정해 둔 날짜에서 시작(잘못 고른 종료일을 고칠 수 있게)
                      if (!endOpen) setEndIso(ymdToIso(endScheduled && course.endedOn ? course.endedOn : today))
                      setEndOpen((v) => !v)
                    }}
                    aria-expanded={endOpen}
                    className="min-h-[44px] rounded-lg border border-red-200 bg-red-50 px-4 text-sm font-bold text-red-700 hover:bg-red-100"
                  >
                    {endScheduled ? '종료일 바꾸기' : '수업 종료'}
                  </button>
                </div>
              )}
              {endOpen && !ended && (
                <div className="mt-3 rounded-lg border border-red-200 bg-red-50/50 p-3">
                  <label className="block text-sm">
                    <span className="font-semibold">종료일</span>
                    <input
                      type="date"
                      value={endIso}
                      min={ymdToIso(today)}
                      onChange={(e) => setEndIso(e.target.value)}
                      className="mt-1 block w-full min-h-[44px] rounded-lg border border-gray-300 bg-white px-3"
                    />
                  </label>
                  {endScheduled && course.endedOn && (
                    <p className="mt-1 text-xs font-semibold text-amber-800 break-keep">지금은 {formatYmdKo(course.endedOn)}부터 종료 예정이에요. 다른 날짜를 고르면 종료일이 바뀌어요.</p>
                  )}
                  <p className="mt-1 text-xs text-gray-700 break-keep">
                    종료일부터 모든 학생 시간표에서 빠지고, 그 전 날짜 기록은 그대로 남아요. 종료일 전까지는 지금처럼 운영돼요. 지난 날짜는 고를 수 없어요.
                  </p>
                  <button
                    type="button"
                    onClick={() => void end()}
                    disabled={ending}
                    className="mt-2 w-full min-h-[44px] rounded-lg bg-red-600 px-4 text-sm font-bold text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {ending ? '처리 중...' : '이 날짜부터 수업 끝내기'}
                  </button>
                </div>
              )}
            </>
          ) : (
            <form
              className="mt-3 space-y-3"
              onSubmit={(e) => {
                e.preventDefault()
                void save()
              }}
            >
              <label className="block text-sm">
                <span className="font-semibold">수업 이름</span>
                <input type="text" maxLength={40} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="mt-1 block w-full min-h-[44px] rounded-lg border border-gray-300 px-3" />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm">
                  <span className="font-semibold">과목</span>
                  <input type="text" maxLength={40} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} className="mt-1 block w-full min-h-[44px] rounded-lg border border-gray-300 px-3" />
                </label>
                <label className="block text-sm">
                  <span className="font-semibold">분반</span>
                  <input type="text" maxLength={20} value={form.section} onChange={(e) => setForm({ ...form, section: e.target.value })} className="mt-1 block w-full min-h-[44px] rounded-lg border border-gray-300 px-3" />
                </label>
              </div>
              <label className="block text-sm">
                <span className="font-semibold">기본 수업 교실</span>
                <input
                  type="text"
                  maxLength={30}
                  value={form.defaultRoomName}
                  onChange={(e) => setForm({ ...form, defaultRoomName: e.target.value })}
                  className="mt-1 block w-full min-h-[44px] rounded-lg border border-gray-300 px-3"
                />
              </label>
              <label className="block text-sm">
                <span className="font-semibold">표시할 교사 이름(쉼표로 구분, 5명까지)</span>
                <input type="text" value={form.teacherNames} onChange={(e) => setForm({ ...form, teacherNames: e.target.value })} className="mt-1 block w-full min-h-[44px] rounded-lg border border-gray-300 px-3" />
              </label>
              <fieldset className="text-sm">
                <legend className="font-semibold">초대 코드로 들어온 학생</legend>
                <label className="mt-1 flex items-center gap-2 min-h-[44px]">
                  <input type="radio" name="editPolicy" checked={form.invitePolicy === 'auto'} onChange={() => setForm({ ...form, invitePolicy: 'auto' })} className="h-5 w-5" />
                  <span>바로 참여</span>
                </label>
                <label className="flex items-center gap-2 min-h-[44px]">
                  <input type="radio" name="editPolicy" checked={form.invitePolicy === 'approval'} onChange={() => setForm({ ...form, invitePolicy: 'approval' })} className="h-5 w-5" />
                  <span>선생님 승인 후 참여</span>
                </label>
              </fieldset>
              <GradePicker name="edit" value={form.grades} onChange={(grades) => setForm({ ...form, grades })} disabled={saving} />
              <ClassLabelsInput value={form.classLabels} onChange={(classLabels) => setForm({ ...form, classLabels })} disabled={saving} />
              <label className="flex items-start gap-2 text-sm min-h-[44px]">
                <input type="checkbox" checked={form.catalogVisible} onChange={(e) => setForm({ ...form, catalogVisible: e.target.checked })} className="mt-0.5 h-5 w-5 shrink-0" />
                <span className="break-keep">
                  학생 수업 담기 목록에 공개
                  <span className="block text-xs text-gray-500">켜면 학생이 &lsquo;수업 담기&rsquo;에서 찾아 직접 담을 수 있어요. 바꾸면 시간표 가져오기가 이 설정을 다시 덮어쓰지 않아요.</span>
                </span>
              </label>
              {saveError && <ErrorBox err={saveError} title="저장하지 못했어요" onRetry={() => void save()} />}
              <div className="flex gap-2">
                <button type="submit" disabled={saving} className="flex-1 min-h-[48px] rounded-xl bg-blue-600 text-white font-bold hover:bg-blue-700 disabled:opacity-50">
                  {saving ? '저장하는 중...' : '저장'}
                </button>
                <button type="button" onClick={() => setEditing(false)} className="min-h-[48px] rounded-xl border border-gray-300 bg-white px-5 font-bold text-gray-700">
                  취소
                </button>
              </div>
            </form>
          )}
        </section>

        {/* 반복 차시 */}
        <Section title="반복 차시">
          <SeriesEditor
            courseId={course.courseId}
            series={detail.series}
            defaultRoomName={course.defaultRoomName}
            today={today}
            canEdit={!ended}
            readOnlyReason={ended ? '종료된 수업이라 차시를 바꿀 수 없어요.' : null}
            onChanged={() => void loadDetail()}
          />
          <p className="mt-3 text-xs text-gray-500 break-keep">
            특정 날짜만 옮기거나 취소하려면 &apos;일정 변경&apos;을 쓰세요(그 수업 수강생에게만 변경이 보여요).
          </p>
        </Section>

        {/* 초대 */}
        <InvitePanel
          type="course"
          targetId={course.courseId}
          targetLabel={course.title}
          schoolName={profile.schoolName}
          termId={course.termId}
          section={course.section || null}
          teacherNames={course.teacherNames}
          disabledReason={ended ? '종료된 수업은 새 초대 코드를 만들 수 없어요.' : null}
        />

        {/* 수강생 */}
        <Section
          title="수강생"
          aside={
            <span className="text-sm text-gray-600">
              참여 중 {counts.active}명 · 승인 대기 {counts.pending}명
            </span>
          }
        >
          <p className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-sm text-gray-700 break-keep">
            학생 추가는 위의 <b>수업 초대 코드</b>를 나눠 주거나 <Link href="/teacher/roster-import" className="font-bold text-blue-700 underline">수강 명단 가져오기</Link>로 하세요. 학생의 소속 학급은 바뀌지 않아요.
          </p>
          {enrError ? (
            <div className="mt-3">
              <ErrorBox err={enrError} title="수강생 명단을 불러오지 못했어요" onRetry={() => void loadEnrollments()} />
            </div>
          ) : !enr ? (
            <p className="mt-3 text-sm text-gray-400">명단을 불러오는 중...</p>
          ) : (
            <div className="mt-3 space-y-4">
              {pending.length > 0 && (
                <div>
                  <h3 className="text-sm font-bold text-amber-800">⏳ 승인 대기 {pending.length}명</h3>
                  <ul className="mt-2 divide-y divide-gray-100 rounded-lg border border-amber-200 bg-amber-50/40">
                    {pending.map((s) => (
                      <StudentLine key={s.uid} s={s}>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => void decide(s, 'approve')}
                            disabled={enrBusy === s.uid || ended}
                            className="flex-1 sm:flex-none min-h-[44px] rounded-lg bg-blue-600 px-5 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-50"
                          >
                            승인
                          </button>
                          <button
                            type="button"
                            onClick={() => void decide(s, 'reject')}
                            disabled={enrBusy === s.uid}
                            className="flex-1 sm:flex-none min-h-[44px] rounded-lg bg-red-50 px-5 text-sm font-bold text-red-700 hover:bg-red-100 disabled:opacity-50"
                          >
                            거절
                          </button>
                        </div>
                      </StudentLine>
                    ))}
                  </ul>
                </div>
              )}
              <div>
                <h3 className="text-sm font-bold text-gray-800">참여 중 {active.length}명</h3>
                {active.length === 0 ? (
                  <p className="mt-1 text-sm text-gray-500">아직 참여한 학생이 없어요.</p>
                ) : (
                  <ul className="mt-2 divide-y divide-gray-100 rounded-lg border border-gray-200">
                    {active.map((s) => (
                      <StudentLine key={s.uid} s={s}>
                        <button
                          type="button"
                          onClick={() => void decide(s, 'end')}
                          disabled={enrBusy === s.uid}
                          className="shrink-0 min-h-[44px] rounded-lg border border-gray-300 bg-white px-4 text-sm font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                        >
                          수강 종료
                        </button>
                      </StudentLine>
                    ))}
                  </ul>
                )}
                {active.length > 0 && <p className="mt-1 text-xs text-gray-500 break-keep">수강 종료: 오늘부터 그 학생 시간표에서 빠지고, 지난 날짜 기록은 그대로 남아요.</p>}
              </div>
              {pastStudents.length > 0 && (
                <details className="rounded-lg border border-gray-200">
                  <summary className="cursor-pointer list-none px-3 py-3 min-h-[44px] text-sm font-semibold text-gray-600">지난 수강·거절 {pastStudents.length}명 보기</summary>
                  <ul className="divide-y divide-gray-100 border-t border-gray-100">
                    {pastStudents.map((s) => (
                      <StudentLine key={s.uid} s={s} />
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </Section>

        {/* 공통 수업 설정 */}
        <Section title="반 전체 공통 수업">
          <p className="text-sm text-gray-700 break-keep">
            공통 수업으로 지정된 반의 학생은 <b>모두</b> 따로 참여하지 않아도 이 수업이 개인 시간표에 나와요. 반 학생 일부만 듣는 선택·이동 수업은 지정하지 마세요.
          </p>
          <p className="mt-2 text-sm">
            지정된 반: <b>{detail.commonHomerooms.length ? detail.commonHomerooms.map((h) => h.label).join(', ') : '없음'}</b>
          </p>
          {homeroomCheck.status === 'error' ? (
            <div className="mt-3">
              <ErrorBox err={asApiError(homeroomCheck.error)} title="내 담임 반을 확인하지 못했어요" onRetry={() => setHomeroomAttempt((n) => n + 1)} />
            </div>
          ) : homeroomCheck.status === 'loading' ? (
            <p className="mt-2 text-xs text-gray-400">담임 반 확인 중...</p>
          ) : myHomeroom ? (
            <button
              type="button"
              onClick={() => void toggleCommon(!isCommonForMine)}
              disabled={commonBusy || (ended && !isCommonForMine)}
              className={`mt-3 w-full min-h-[48px] rounded-xl px-4 font-bold disabled:opacity-50 ${
                isCommonForMine ? 'border border-gray-300 bg-white text-gray-800 hover:bg-gray-50' : 'bg-blue-600 text-white hover:bg-blue-700'
              }`}
            >
              {commonBusy ? '처리 중...' : isCommonForMine ? `${myHomeroom.label} 공통 수업 해제` : `${myHomeroom.label} 학생 전체의 공통 수업으로 지정`}
            </button>
          ) : (
            <p className="mt-2 text-xs text-gray-500">공통 수업 지정·해제는 그 반 담임 선생님만 할 수 있어요.</p>
          )}
        </Section>

        {/* 변경 이력·검토 필요 */}
        <Section
          title="변경 이력"
          aside={
            <Link href={scheduleChangesHref(course.courseId)} className="inline-flex items-center min-h-[44px] rounded-lg bg-red-600 px-4 text-sm font-bold text-white hover:bg-red-700">
              일정 변경
            </Link>
          }
        >
          {orphansError ? (
            <ErrorBox err={orphansError} title="검토가 필요한 변경을 확인하지 못했어요" onRetry={() => void loadHistory()} />
          ) : orphans === null ? (
            <p className="text-sm text-gray-400">검토 필요 항목 확인 중...</p>
          ) : orphans.length > 0 ? (
            <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900 break-keep">
              <p className="font-bold">⚠️ 검토가 필요한 변경 {orphans.length}건</p>
              <p className="mt-1 text-xs">기본 시간표(차시)가 바뀌어 원래 대상 차시가 없어진 날짜 변경이에요. 학생 화면에는 적용되지 않으니 일정 변경에서 다시 확인해 주세요.</p>
              <ul className="mt-1 space-y-0.5">
                {orphans.slice(0, 5).map((o) => (
                  <li key={o.overrideId}>
                    {o.originalDate ? formatYmdKo(o.originalDate) : '날짜 미상'} · {CHANGE_KIND_LABEL[o.kind] || '변경'}
                    {o.target ? ` → ${slotText(o.target)}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-gray-600">✓ 검토가 필요한 변경 없음</p>
          )}

          <div className="mt-4">
            {historyError ? (
              <ErrorBox err={historyError} title="변경 이력을 불러오지 못했어요" onRetry={() => void loadHistory()} />
            ) : history === null ? (
              <p className="text-sm text-gray-400">변경 이력을 불러오는 중...</p>
            ) : history.length === 0 ? (
              <p className="text-sm text-gray-500">아직 이 수업의 일정 변경이 없어요.</p>
            ) : (
              <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
                {history.slice(0, 10).map((h) => {
                  const st = CHANGE_STATUS[h.status] || CHANGE_STATUS.published
                  return (
                    <li key={h.changeSetId} className="px-3 py-3 text-sm">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={`rounded-full border px-2 py-0.5 text-xs font-bold ${st.cls}`}>{st.label}</span>
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-bold text-gray-700">
                          {h.scope === 'base' ? '지정일부터 기본 시간표 변경' : '이 날짜만'}
                        </span>
                        <span className="text-xs text-gray-500">
                          {formatMsDate(h.publishedAt || h.createdAt)}
                          {h.createdByName ? ` · ${h.createdByName}` : ''}
                        </span>
                      </div>
                      <ul className="mt-1 space-y-0.5 text-gray-800">
                        {h.changes.slice(0, 4).map((c, i) => (
                          <li key={`${c.occurrenceKey}-${i}`} className="break-words">
                            <b>{c.title}</b> {CHANGE_KIND_LABEL[c.kind] || '변경'}
                            {c.kind === 'cancel' ? ` · ${slotText(c.before)}` : c.after ? ` · ${slotText(c.before)} → ${slotText(c.after)}` : ''}
                            {c.fields.length ? ` (${c.fields.map((f) => CHANGE_FIELD_LABEL[f]).join('·')})` : ''}
                          </li>
                        ))}
                        {h.changes.length > 4 && <li className="text-gray-500">외 {h.changes.length - 4}건</li>}
                      </ul>
                      <p className="mt-1 text-xs text-gray-600">
                        영향 학생 {h.affectedStudentCount}명{h.reason ? ` · 사유: ${h.reason}` : ''}
                      </p>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </Section>
      </div>
    </div>
  )
}
