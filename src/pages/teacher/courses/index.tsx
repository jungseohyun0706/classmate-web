import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { useUI } from '../../../components/ui/feedback'
import GradePicker from '../../../components/timetable/GradePicker'
import { formatYmdKo } from '../../../lib/timetable/dates'
import {
  asApiError,
  createCourse,
  errorText,
  fromHomeroomTimetable,
  homeroomLabelFromId,
  listCourses,
  loadCommonCandidates,
  scheduleChangesHref,
  seriesSummary,
  setCommon,
  termLabel,
  todayYmd,
  useTeacherProfile,
  type CommonCandidate,
  type CourseListItem,
  type CourseListResponse,
  type FromHomeroomResponse,
  type HomeroomRef,
  type InvitePolicy,
  type TeacherApiError,
} from '../../../lib/timetable/teacherClient'
import { courseEndState, listCountsOf, type ListCounts } from '../../../lib/timetable/teacherCourseView'
import type { Ymd } from '../../../lib/timetable/types'

// 수업 관리 — 내가 담당·관리하는 수업 목록(요일·교시 요약, 수강생·승인 대기 수, 반 전체 공통 수업 표시),
// 수업 만들기, 담임 반 '학급 시간표 → 우리 반 공통 수업으로 연결', 시간표 가져오기가 남긴 '공통 수업 후보' 확인·해제.
// 수업(수업반)은 학생의 소속 학급과 별개입니다. 실제 권한은 서버(/api/courses)가 다시 판정합니다.
// 인원 수는 목록 응답의 수업별 counts{active, pending}만 씁니다 — 예전처럼 수업마다 get(승인 대기 학생 명단·uid 포함)을
// 부르지 않습니다. counts가 없으면(예전 서버) '인원 —'.

interface CandidateState {
  loading: boolean
  error: TeacherApiError | null
  items: CommonCandidate[]
}

const ROLE_LABEL: Record<CourseListItem['role'], string> = {
  teacher: '담당',
  manager: '관리',
  homeroom: '우리 반 공통',
}

function ErrorBox({ err, title, onRetry }: { err: TeacherApiError; title: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 break-keep">
      <p className="font-bold">⚠️ {title}</p>
      <p className="mt-1">{errorText(err)}</p>
      {onRetry && err.retryable && (
        <button type="button" onClick={onRetry} className="mt-2 min-h-[44px] rounded-lg bg-white border border-red-200 px-4 font-bold text-red-700 hover:bg-red-100">
          다시 시도
        </button>
      )}
    </div>
  )
}

function commonLabel(classId: string, homerooms: HomeroomRef[]): string {
  return homerooms.find((h) => h.classId === classId)?.label || homeroomLabelFromId(classId)
}

function CourseCard({ c, homerooms, today }: { c: CourseListItem; homerooms: HomeroomRef[]; today: Ymd }) {
  // 서버와 같은 기준(courseActiveOn(오늘)) — 종료일을 미래로 정한 수업은 '종료 예정'(그 전까지 운영 중)
  const { ended, endScheduled } = courseEndState(c, today)
  const count: ListCounts | null = c.canManage ? listCountsOf(c) : null
  const body = (
    <div className="p-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-bold text-gray-700">{ROLE_LABEL[c.role]}</span>
        {ended && <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-bold text-gray-700">⛔ 종료{c.endedOn ? ` (${formatYmdKo(c.endedOn)}부터)` : ''}</span>}
        {endScheduled && c.endedOn && (
          <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-800">⏳ {formatYmdKo(c.endedOn)}부터 종료 예정</span>
        )}
      </div>
      <h3 className="mt-1.5 text-lg font-bold text-gray-900 break-words">{c.title}</h3>
      <p className="text-sm text-gray-600 break-words">
        {c.subject || '과목 미정'}
        {c.section ? ` · 분반 ${c.section}` : ''} · {termLabel(c.termId)}
      </p>
      {c.teacherNames.length > 0 && <p className="text-sm text-gray-600 break-words">교사 {c.teacherNames.join(', ')}</p>}
      <p className="mt-1 text-sm text-gray-800 break-words">
        <span aria-hidden="true">📅 </span>
        {seriesSummary(c.series, today)}
      </p>
      {c.defaultRoomName && (
        <p className="text-sm text-gray-600 break-words">
          <span className="text-gray-500">수업 교실 · </span>
          {c.defaultRoomName}
        </p>
      )}
      {c.commonForHomerooms.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {c.commonForHomerooms.map((id) => (
            <span key={id} className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-bold text-blue-800">
              🏫 반 전체 공통 수업 · {commonLabel(id, homerooms)}
            </span>
          ))}
        </div>
      )}
      <div className="mt-2 text-sm">
        {!c.canManage ? (
          <span className="text-gray-500">담당 선생님이 관리하는 수업이에요(우리 반 학생 모두에게 보임).</span>
        ) : !count ? (
          <span className="text-gray-500">인원 —</span>
        ) : (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-gray-800">수강생 {count.active}명</span>
            {count.pending > 0 ? (
              <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-800">⏳ 승인 대기 {count.pending}명</span>
            ) : (
              <span className="text-gray-500">승인 대기 0명</span>
            )}
          </span>
        )}
      </div>
    </div>
  )
  if (!c.canManage) return <div className="rounded-xl border border-gray-200 bg-white shadow-sm">{body}</div>
  return (
    <Link
      href={`/teacher/courses/${encodeURIComponent(c.courseId)}`}
      className="block rounded-xl border border-gray-200 bg-white shadow-sm hover:border-blue-300 hover:shadow-md transition"
      aria-label={`${c.title} 수업 관리`}
    >
      {body}
      <div className="border-t border-gray-100 px-4 py-2.5 text-right text-sm font-bold text-blue-700">관리하기 →</div>
    </Link>
  )
}

export default function TeacherCoursesPage() {
  const router = useRouter()
  const { toast, confirm } = useUI()
  const { profile, loading: profileLoading, error: profileError, retry: retryProfile } = useTeacherProfile()
  const today = useMemo(() => todayYmd(), [])

  const [allTerms, setAllTerms] = useState(false)
  const [list, setList] = useState<CourseListResponse | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState<TeacherApiError | null>(null)
  const generation = useRef(0)

  // 수업 만들기
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({
    title: '',
    subject: '',
    section: '',
    defaultRoomName: '',
    invitePolicy: 'auto' as InvitePolicy,
    catalogVisible: false,
    grades: [] as number[],
  })
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<TeacherApiError | null>(null)

  // 담임 반
  const [hrBusy, setHrBusy] = useState<string | null>(null)
  const [hrResult, setHrResult] = useState<Record<string, FromHomeroomResponse>>({})
  const [hrError, setHrError] = useState<Record<string, TeacherApiError | null>>({})
  const [candidates, setCandidates] = useState<Record<string, CandidateState>>({})
  const [commonBusy, setCommonBusy] = useState<string | null>(null)

  const schoolCode = profile?.schoolCode || ''

  const loadCandidates = useCallback(
    async (classId: string, termId: string | null) => {
      if (!schoolCode) return
      setCandidates((m) => ({ ...m, [classId]: { loading: true, error: null, items: m[classId]?.items || [] } }))
      try {
        const items = await loadCommonCandidates(schoolCode, classId, termId)
        setCandidates((m) => ({ ...m, [classId]: { loading: false, error: null, items } }))
      } catch (e) {
        const err = asApiError(e)
        console.error('courses: 공통 수업 후보 실패', err.code)
        setCandidates((m) => ({ ...m, [classId]: { loading: false, error: err, items: [] } }))
      }
    },
    [schoolCode]
  )

  const loadList = useCallback(async () => {
    if (!schoolCode) return
    const gen = ++generation.current
    setListLoading(true)
    setListError(null)
    try {
      const r = await listCourses(allTerms ? { termId: 'all' } : {})
      if (gen !== generation.current) return
      setList(r)
      r.homerooms.forEach((h) => void loadCandidates(h.classId, r.termId))
    } catch (e) {
      if (gen !== generation.current) return
      const err = asApiError(e)
      console.error('courses: 목록 실패', err.code)
      setListError(err)
    } finally {
      if (gen === generation.current) setListLoading(false)
    }
  }, [schoolCode, allTerms, loadCandidates])

  useEffect(() => {
    void loadList()
  }, [loadList])

  const submitCreate = async () => {
    if (creating) return
    setCreateError(null)
    const title = form.title.trim()
    const subject = form.subject.trim()
    if (!title || !subject) {
      toast('수업 이름과 과목을 입력해 주세요.', 'error')
      return
    }
    setCreating(true)
    try {
      const r = await createCourse({
        title,
        subject,
        section: form.section.trim() || null,
        defaultRoomName: form.defaultRoomName.trim() || null,
        invitePolicy: form.invitePolicy,
        catalogVisible: form.catalogVisible,
        ...(form.grades.length ? { grades: form.grades } : {}),
      })
      toast('수업을 만들었어요. 차시와 초대를 설정해 주세요.', 'success')
      router.push(`/teacher/courses/${encodeURIComponent(r.courseId)}`)
    } catch (e) {
      const err = asApiError(e)
      console.error('courses: 만들기 실패', err.code)
      setCreateError(err)
    } finally {
      setCreating(false)
    }
  }

  const runFromHomeroom = async (h: HomeroomRef) => {
    if (hrBusy) return
    const ok = await confirm({
      title: `${h.label} 학급 시간표로 공통 수업을 만들까요?`,
      description:
        '반 학생 모두가 같은 수업을 듣는 과목만 공통 수업이 됩니다. 선택·이동 수업이 섞여 있으면 수업별로 따로 만들고 초대·명단으로 연결하세요.',
      confirmText: '공통 수업 만들기',
      cancelText: '취소',
    })
    if (!ok) return
    setHrBusy(h.classId)
    setHrError((m) => ({ ...m, [h.classId]: null }))
    try {
      const r = await fromHomeroomTimetable(h.classId)
      setHrResult((m) => ({ ...m, [h.classId]: r }))
      toast(r.already ? '바뀐 내용이 없어요.' : `${h.label} 공통 수업을 연결했어요.`, 'success')
      void loadList()
    } catch (e) {
      const err = asApiError(e)
      console.error('courses: 학급 시간표 연결 실패', err.code)
      setHrError((m) => ({ ...m, [h.classId]: err }))
    } finally {
      setHrBusy(null)
    }
  }

  const toggleCommon = async (h: HomeroomRef, courseId: string, title: string, enabled: boolean) => {
    if (commonBusy) return
    const ok = await confirm(
      enabled
        ? {
            title: `'${title}'을(를) ${h.label} 공통 수업으로 확인할까요?`,
            description: `${h.label} 학생 모두의 개인 시간표에 이 수업이 들어가요. 반 학생 일부만 듣는 선택·이동 수업이면 취소하고 수업 초대나 수강 명단으로 연결하세요.`,
            confirmText: '공통 수업으로 확인',
            cancelText: '취소',
          }
        : {
            title: `'${title}' 공통 수업을 해제할까요?`,
            description: `${h.label} 학생들의 개인 시간표에서 이 수업이 빠져요. 초대·명단으로 따로 참여한 학생은 그대로이고, 수업 자체는 지워지지 않아요.`,
            confirmText: '해제하기',
            cancelText: '취소',
            danger: true,
          }
    )
    if (!ok) return
    setCommonBusy(courseId)
    try {
      const r = await setCommon(courseId, h.classId, enabled)
      toast(r.already ? '이미 그렇게 돼 있어요.' : enabled ? '공통 수업으로 확인했어요.' : '공통 수업을 해제했어요.', 'success')
      await loadList()
    } catch (e) {
      const err = asApiError(e)
      console.error('courses: 공통 수업 설정 실패', err.code)
      toast(errorText(err), 'error')
    } finally {
      setCommonBusy(null)
    }
  }

  if (profileError) {
    return (
      <div className="min-h-screen bg-gray-50 px-4 py-10 text-black">
        <div className="max-w-md mx-auto">
          <ErrorBox err={profileError} title="내 정보를 불러오지 못했어요" onRetry={retryProfile} />
        </div>
      </div>
    )
  }
  if (profileLoading || !profile) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" aria-label="불러오는 중" />
      </div>
    )
  }

  const homerooms = list?.homerooms || []
  const mine = (list?.courses || []).filter((c) => c.canManage)
  const others = (list?.courses || []).filter((c) => !c.canManage)

  return (
    <div className="min-h-screen bg-gray-50 py-6 sm:py-10 px-4 sm:px-6 lg:px-8 text-gray-900">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold">수업 관리</h1>
            <p className="text-sm text-gray-600 break-keep">
              {profile.schoolName} · {list ? (allTerms ? '모든 학기' : termLabel(list.termId)) : '불러오는 중'}
            </p>
          </div>
          <button type="button" onClick={() => router.push('/dashboard')} className="shrink-0 whitespace-nowrap min-h-[44px] px-2 text-gray-500 hover:text-gray-700">
            ← 대시보드로
          </button>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-700 break-keep">
          <p>
            <b>수업</b>은 학생의 <b>소속 학급</b>과 별개예요. 학생은 원래 반에 그대로 있고, 수업 초대나 수강 명단으로 이 수업만 개인 시간표에 추가돼요.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Link href="/teacher/timetable-import" className="inline-flex items-center min-h-[44px] rounded-lg border border-gray-300 px-3 font-semibold hover:bg-gray-50">
              시간표 가져오기
            </Link>
            <Link href="/teacher/roster-import" className="inline-flex items-center min-h-[44px] rounded-lg border border-gray-300 px-3 font-semibold hover:bg-gray-50">
              수강 명단 가져오기
            </Link>
            <Link href={scheduleChangesHref()} className="inline-flex items-center min-h-[44px] rounded-lg border border-gray-300 px-3 font-semibold hover:bg-gray-50">
              시간표 변경
            </Link>
          </div>
        </div>

        {/* 수업 만들기 */}
        <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <button
            type="button"
            onClick={() => setCreateOpen((v) => !v)}
            aria-expanded={createOpen}
            className="w-full min-h-[52px] px-4 text-left font-bold text-blue-700 flex items-center justify-between"
          >
            <span>+ 새 수업 만들기</span>
            <span aria-hidden="true">{createOpen ? '▲' : '▼'}</span>
          </button>
          {createOpen && (
            <form
              className="border-t border-gray-100 p-4 space-y-3"
              onSubmit={(e) => {
                e.preventDefault()
                void submitCreate()
              }}
            >
              <label className="block text-sm">
                <span className="font-semibold">수업 이름</span>
                <input
                  type="text"
                  required
                  maxLength={40}
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="예: 영어 B"
                  className="mt-1 block w-full min-h-[44px] rounded-lg border border-gray-300 px-3"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm">
                  <span className="font-semibold">과목</span>
                  <input
                    type="text"
                    required
                    maxLength={40}
                    value={form.subject}
                    onChange={(e) => setForm({ ...form, subject: e.target.value })}
                    placeholder="예: 영어"
                    className="mt-1 block w-full min-h-[44px] rounded-lg border border-gray-300 px-3"
                  />
                </label>
                <label className="block text-sm">
                  <span className="font-semibold">분반(선택)</span>
                  <input
                    type="text"
                    maxLength={20}
                    value={form.section}
                    onChange={(e) => setForm({ ...form, section: e.target.value })}
                    placeholder="예: B"
                    className="mt-1 block w-full min-h-[44px] rounded-lg border border-gray-300 px-3"
                  />
                </label>
              </div>
              <label className="block text-sm">
                <span className="font-semibold">기본 수업 교실(선택)</span>
                <input
                  type="text"
                  maxLength={30}
                  value={form.defaultRoomName}
                  onChange={(e) => setForm({ ...form, defaultRoomName: e.target.value })}
                  placeholder="예: 3학년 5반 교실, 영어전용실"
                  className="mt-1 block w-full min-h-[44px] rounded-lg border border-gray-300 px-3"
                />
                <span className="mt-1 block text-xs text-gray-500 break-keep">수업이 열리는 장소예요. 학생 소속 학급과는 별개예요.</span>
              </label>
              <fieldset className="text-sm">
                <legend className="font-semibold">초대 코드로 들어온 학생</legend>
                <label className="mt-1 flex items-center gap-2 min-h-[44px]">
                  <input type="radio" name="invitePolicy" checked={form.invitePolicy === 'auto'} onChange={() => setForm({ ...form, invitePolicy: 'auto' })} className="h-5 w-5" />
                  <span>바로 참여</span>
                </label>
                <label className="flex items-center gap-2 min-h-[44px]">
                  <input
                    type="radio"
                    name="invitePolicy"
                    checked={form.invitePolicy === 'approval'}
                    onChange={() => setForm({ ...form, invitePolicy: 'approval' })}
                    className="h-5 w-5"
                  />
                  <span>선생님 승인 후 참여</span>
                </label>
              </fieldset>
              <GradePicker name="create" value={form.grades} onChange={(grades) => setForm({ ...form, grades })} disabled={creating} />
              <label className="flex items-start gap-2 text-sm min-h-[44px]">
                <input type="checkbox" checked={form.catalogVisible} onChange={(e) => setForm({ ...form, catalogVisible: e.target.checked })} className="mt-0.5 h-5 w-5 shrink-0" />
                <span className="break-keep">
                  학생 수업 담기 목록에 공개
                  <span className="block text-xs text-gray-500">켜면 같은 학교 학생이 &lsquo;수업 담기&rsquo;에서 요일·교시로 찾아 직접 담을 수 있어요(위 참여 방식대로 바로 참여 또는 승인 후).</span>
                </span>
              </label>
              {createError && <ErrorBox err={createError} title="수업을 만들지 못했어요" onRetry={() => void submitCreate()} />}
              <button type="submit" disabled={creating} className="w-full min-h-[48px] rounded-xl bg-blue-600 text-white font-bold hover:bg-blue-700 disabled:opacity-50">
                {creating ? '만드는 중...' : '수업 만들기'}
              </button>
            </form>
          )}
        </section>

        {listError && <ErrorBox err={listError} title="수업 목록을 불러오지 못했어요" onRetry={() => void loadList()} />}

        {/* 수업 목록 */}
        <section>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-bold">내 수업 {list ? `${mine.length}개` : ''}</h2>
            <label className="flex items-center gap-2 text-sm text-gray-600 min-h-[44px]">
              <input type="checkbox" checked={allTerms} onChange={(e) => setAllTerms(e.target.checked)} className="h-5 w-5" />
              지난 학기 수업도 보기
            </label>
          </div>
          {!list && listLoading ? (
            <p className="mt-3 text-sm text-gray-400">수업 목록을 불러오는 중...</p>
          ) : list && mine.length === 0 ? (
            <div className="mt-3 rounded-xl border border-dashed border-gray-300 bg-white p-6 text-center text-sm text-gray-600 break-keep">
              <p className="font-semibold">아직 담당·관리하는 수업이 없어요.</p>
              <p className="mt-1">위에서 수업을 만들거나, 시간표 가져오기로 학교 시간표의 수업을 한 번에 만들 수 있어요.</p>
            </div>
          ) : (
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {mine.map((c) => (
                <CourseCard key={c.courseId} c={c} homerooms={homerooms} today={today} />
              ))}
            </div>
          )}
        </section>

        {/* 담임 반: 학급 시간표 → 공통 수업, 공통 수업 후보 */}
        {homerooms.map((h) => {
          const result = hrResult[h.classId]
          const err = hrError[h.classId]
          const cand = candidates[h.classId]
          const confirmed = (list?.courses || []).filter((c) => c.commonForHomerooms.includes(h.classId))
          return (
            <section key={h.classId} className="rounded-xl border-2 border-blue-200 bg-white shadow-sm overflow-hidden" aria-label={`${h.label} 공통 수업`}>
              <div className="bg-blue-50 px-4 py-3 border-b border-blue-100">
                <h2 className="text-lg font-bold break-keep">🏫 {h.label} 담임 — 우리 반 공통 수업</h2>
                <p className="mt-1 text-sm text-gray-700 break-keep">
                  공통 수업은 반 학생 <b>모두</b>의 개인 시간표에 들어가요. 반 학생 모두가 같은 수업을 듣는 과목만 공통 수업으로 연결하고, 선택·이동 수업은 수업 초대나 수강 명단으로 연결하세요.
                </p>
              </div>
              <div className="p-4 space-y-4">
                <div>
                  <button
                    type="button"
                    onClick={() => void runFromHomeroom(h)}
                    disabled={!!hrBusy}
                    className="w-full min-h-[48px] rounded-xl bg-blue-600 px-4 text-white font-bold hover:bg-blue-700 disabled:opacity-50"
                  >
                    {hrBusy === h.classId ? '연결하는 중...' : '학급 시간표 → 우리 반 공통 수업으로 연결'}
                  </button>
                  {err && (
                    <div className="mt-2">
                      <ErrorBox err={err} title="공통 수업을 만들지 못했어요" onRetry={() => void runFromHomeroom(h)} />
                      {err.code === 'no-class-timetable' && (
                        <Link href="/teacher/class-timetable" className="mt-2 inline-flex items-center min-h-[44px] text-sm font-bold text-blue-700 underline">
                          학급 시간표 관리로 가기 →
                        </Link>
                      )}
                    </div>
                  )}
                  {result && (
                    <div role="status" className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-900 break-keep">
                      <p className="font-bold">
                        {result.already ? '바뀐 내용이 없어요 — 이미 학급 시간표와 같은 공통 수업이 연결돼 있어요.' : `✓ ${h.label} 공통 수업을 연결했어요.`}
                      </p>
                      <ul className="mt-1 space-y-0.5">
                        <li>
                          만든 수업 {result.coursesCreated}개 · 연결된 공통 수업 {result.courses}개 ({formatYmdKo(result.effectiveFrom)}부터)
                        </li>
                        <li>
                          차시: 새로 {result.seriesCreated}개 · 끝낸 차시 {result.seriesRetired}개 · 그대로 {result.seriesUnchanged}개
                        </li>
                        <li>
                          교사 미확인 칸 {result.cellsWithoutTeacher}개 · 교실 미확인 칸 {result.cellsWithoutRoom}개
                        </li>
                      </ul>
                      {(result.cellsWithoutTeacher > 0 || result.cellsWithoutRoom > 0) && (
                        <p className="mt-1 text-xs">
                          학교 시간표에서 같은 칸·같은 과목을 찾지 못해 교사·교실을 비워 둔 칸이에요(학급 이름을 교실로 추정하지 않아요). 각 수업 관리에서 고칠 수 있어요.
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* 확인된 공통 수업 */}
                <div>
                  <h3 className="text-sm font-bold text-gray-800">확인된 {h.label} 공통 수업 {confirmed.length}개</h3>
                  {confirmed.length === 0 ? (
                    <p className="mt-1 text-sm text-gray-500">아직 없어요.</p>
                  ) : (
                    <ul className="mt-2 divide-y divide-gray-100 rounded-lg border border-gray-200">
                      {confirmed.map((c) => (
                        <li key={c.courseId} className="flex items-center justify-between gap-3 px-3 py-2.5">
                          <div className="min-w-0">
                            <p className="font-semibold break-words">{c.title}</p>
                            <p className="text-xs text-gray-600 break-words">
                              {c.teacherNames.length ? `${c.teacherNames.join(', ')} · ` : ''}
                              {seriesSummary(c.series, today)}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => void toggleCommon(h, c.courseId, c.title, false)}
                            disabled={commonBusy === c.courseId}
                            className="shrink-0 min-h-[44px] rounded-lg border border-gray-300 bg-white px-3 text-sm font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          >
                            해제
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* 공통 수업 후보(시간표 가져오기) */}
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-bold text-gray-800">공통 수업 후보(시간표 가져오기)</h3>
                    <button
                      type="button"
                      onClick={() => void loadCandidates(h.classId, list?.termId ?? null)}
                      disabled={cand?.loading}
                      className="min-h-[44px] px-2 text-sm text-gray-500 underline disabled:opacity-50"
                    >
                      새로고침
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-gray-600 break-keep">
                    시간표 가져오기에서 이 반 수업으로 보인 과목이에요. 아직 공통 수업이 아니에요. 반 학생 모두가 듣는 수업만 확인하고, 선택·이동 수업(분반이 나뉜 수업)은 확인하지 마세요.
                  </p>
                  {!cand || (cand.loading && !cand.items.length) ? (
                    <p className="mt-2 text-sm text-gray-400">불러오는 중...</p>
                  ) : cand.error ? (
                    <div className="mt-2">
                      <ErrorBox err={cand.error} title="공통 수업 후보를 불러오지 못했어요" onRetry={() => void loadCandidates(h.classId, list?.termId ?? null)} />
                    </div>
                  ) : cand.items.length === 0 ? (
                    <p className="mt-2 text-sm text-gray-500">확인할 후보가 없어요.</p>
                  ) : (
                    <ul className="mt-2 divide-y divide-gray-100 rounded-lg border border-amber-200 bg-amber-50/40">
                      {cand.items.map((c) => (
                        <li key={c.courseId} className="px-3 py-3">
                          <p className="font-semibold break-words">
                            {c.title}
                            {c.section ? <span className="ml-1 text-sm font-normal text-gray-600">분반 {c.section}</span> : null}
                          </p>
                          <p className="text-sm text-gray-700 break-words">
                            {c.subject || '과목 미정'} · 교사 {c.teacherNames.length ? c.teacherNames.join(', ') : '미확인'}
                          </p>
                          <p className="text-sm text-gray-700 break-words">📅 {seriesSummary(c.series, today)}</p>
                          <button
                            type="button"
                            onClick={() => void toggleCommon(h, c.courseId, c.title, true)}
                            disabled={commonBusy === c.courseId}
                            className="mt-2 w-full sm:w-auto min-h-[44px] rounded-lg bg-blue-600 px-4 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-50"
                          >
                            반 학생 모두가 듣는 수업이면 확인
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </section>
          )
        })}

        {others.length > 0 && (
          <section>
            <h2 className="text-lg font-bold">우리 반 공통 수업(다른 선생님 담당) {others.length}개</h2>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {others.map((c) => (
                <CourseCard key={c.courseId} c={c} homerooms={homerooms} today={today} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
