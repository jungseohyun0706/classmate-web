import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import Link from 'next/link'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db } from '../../lib/firebase'
import InviteCodeInput from '../../components/InviteCodeInput'
import CoursePicker from '../../components/timetable/CoursePicker'
import PersonalEntryForm, {
  entryTimeText,
  entryWhenText,
  personalWriteErrorText,
  waitForCommit,
} from '../../components/timetable/PersonalEntryForm'
import { lessonTitle } from '../../components/timetable/LessonCard'
import { SyncBanner } from '../../components/timetable/TimetableStateCard'
import { useUI } from '../../components/ui/feedback'
import { invitePath, readPendingInvite } from '../../lib/pendingInvite'
import { awaitingHomeroomApproval } from '../../lib/homeroomStatus'
import {
  activeCoursesOn,
  courseSchedule,
  formatSyncedAt,
  linkableCourses,
  useMyTimetable,
  weekdayShort,
  type CourseSlotSummary,
  type MyTimetablePayload,
  type TimetableFetchError,
} from '../../lib/timetable/client'
import { courseActiveOn } from '../../lib/timetable/engine'
import {
  cartConflicts,
  entryOverlapsSchool,
  myCourseStates,
  myLessonsFrom,
  pickerTitle,
  pickSummaryText,
  type CartConflict,
  type PickerCourse,
  type PickResult,
} from '../../lib/timetable/coursePicker'
import { leaveCourse, leaveErrorText, pickRequestErrorText, requestCourses, useCatalog } from '../../lib/timetable/pickerClient'
import { addDays, schoolYmdAt, toUtcDate } from '../../lib/timetable/dates'
import {
  deletePersonalEntry,
  setPersonalEntryLink,
  subscribePersonalEntries,
} from '../../lib/timetable/personalEntries'
import type { Course, Enrollment, PersonalEntry, Ymd } from '../../lib/timetable/types'

/**
 * 학생 '내 수업' — /student/courses (요구 문서 4절, 지시서 8장, R07·R08·R11)
 *  #mine     참여 중인 수업(활성·시작 예정·승인 대기·종료) — 출처(초대·명단·신청·반 공통 수업·예전 수업 그룹), 요일·교시·교실·교사.
 *            내가 직접 담은 수업(출처 신청)은 '빼기', 학교가 넣어 준 수업은 '선생님께 문의'
 *  #catalog  수업 담기(학교 수업 목록에서 고르기 — 시간표 칸 보기·과목으로 찾기 → 담은 수업 한 번에 담기). 시간표를 만드는 기본 방법
 *  #invite   초대 코드 입력(XXXX-XXXX → /i/{code})
 *  #personal 내가 직접 입력한 일정(학원·자습 같은 학교 밖 일정 — 추가·수정·삭제, 공식 수업 연결·해제, 저장 대기).
 *            같은 요일·교시의 학교 수업이 있으면 담기·연결을 안내(요일·교시로만 — 제목으로 찾지 않음)
 * 상태(요구 3절): 로그인 필요 / 가입 미완료 / 학교 미설정 / 학생 계정 아님 / 네트워크·서버 오류(다시 시도).
 * 자료: /api/timetable/me(본인 수강·수업·차시만 — 다른 학생 정보 없음) + users/{uid}/personalEntries(본인만).
 * 내부 id(uid·courseId)는 화면에 내놓지 않습니다.
 */

const SECTION_IDS = ['mine', 'catalog', 'invite', 'personal'] as const
type SectionId = (typeof SECTION_IDS)[number]

/** 직접 입력 일정 수(규칙으로 개수를 제한할 수 없어 앱에서 제한) */
const MAX_PERSONAL_ENTRIES = 50

/** 수업 그룹(classes/{base}_g_{x})이 소속처럼 저장된 예전 학생 */
const GROUP_CLASS_RE = /_g_[A-Za-z0-9]+$/

interface ProfileLite {
  role?: string
  schoolCode?: string
  schoolName?: string
  classId?: string
  grade?: string | number | null
  classNm?: string | number | null
  status?: string
}

type Gate =
  | { kind: 'checking' }
  | { kind: 'login' }
  | { kind: 'no-profile' }
  | { kind: 'no-school' }
  | { kind: 'not-student' }
  | { kind: 'profile-error'; code: string; offline: boolean }
  | { kind: 'ok'; uid: string; profile: ProfileLite }

// ───────────────────────── 참여 중인 수업 목록 ─────────────────────────

type SourceKey = 'invite' | 'roster' | 'request' | 'admin' | 'legacy-group' | 'common'
type MineStatus = 'active' | 'upcoming' | 'pending' | 'ended'

interface MineRow {
  courseId: string
  course: Course
  status: MineStatus
  source: SourceKey
  from: Ymd | null
  to: Ymd | null
  /** 선생님이 거절한 신청(종료와 구분해 표시) */
  rejected?: boolean
}

const SOURCE_LABEL: Record<SourceKey, string> = {
  invite: '초대',
  roster: '명단',
  request: '신청',
  admin: '선생님 추가',
  'legacy-group': '예전 수업 그룹',
  common: '반 공통 수업',
}

/** 수강 출처: 그룹 QR로 들어온 수강(via 'group-qr')은 '예전 수업 그룹'(서버가 via를 내려줄 때) */
function sourceOf(e: Enrollment): SourceKey {
  const via = (e as Enrollment & { via?: unknown }).via
  if (via === 'group-qr') return 'legacy-group'
  return e.source
}

function statusOf(e: Enrollment, course: Course, today: Ymd): MineStatus {
  if (e.status === 'pending') return 'pending'
  if (e.status === 'ended') return 'ended'
  if (!courseActiveOn(course, today)) return 'ended'
  if (e.to && today >= e.to) return 'ended'
  if (e.from && today < e.from) return 'upcoming'
  return 'active'
}

/** 본인 수강 + 소속 학급 공통 수업 → 화면 행(courseId 중복 없음, 개별 수강 우선) */
function mineRows(payload: MyTimetablePayload, uid: string, today: Ymd): { rows: MineRow[]; missing: number } {
  const byId = new Map(payload.courses.map((c) => [c.courseId, c] as const))
  const rows: MineRow[] = []
  const seen = new Set<string>()
  let missing = 0
  payload.enrollments
    .filter((e) => e.uid === uid && e.courseId)
    .forEach((e) => {
      if (seen.has(e.courseId)) return
      seen.add(e.courseId)
      const course = byId.get(e.courseId)
      if (!course) {
        if (e.status !== 'ended') missing++
        return
      }
      rows.push({ courseId: e.courseId, course, status: statusOf(e, course, today), source: sourceOf(e), from: e.from ?? null, to: e.to ?? null, rejected: e.rejected === true })
    })
  const homeroomIds = payload.homerooms.map((h) => h.homeroomId)
  payload.courses.forEach((c) => {
    if (seen.has(c.courseId)) return
    if (!c.commonForHomerooms.some((id) => homeroomIds.includes(id))) return
    seen.add(c.courseId)
    rows.push({ courseId: c.courseId, course: c, status: courseActiveOn(c, today) ? 'active' : 'ended', source: 'common', from: null, to: null })
  })
  const order: Record<MineStatus, number> = { active: 0, upcoming: 1, pending: 2, ended: 3 }
  rows.sort((a, b) => order[a.status] - order[b.status] || lessonTitle(a.course).localeCompare(lessonTitle(b.course), 'ko'))
  return { rows, missing }
}

/** '10월 12일' */
function monthDay(ymd: Ymd): string {
  const d = toUtcDate(ymd)
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`
}

/** '화 3교시, 금 3교시 · 3학년 5반 교실' (교실이 여럿이면 차시마다) */
function scheduleText(slots: CourseSlotSummary[]): string {
  if (!slots.length) return '아직 등록된 시간표가 없어요'
  const rooms = Array.from(new Set(slots.map((s) => s.roomName).filter((r): r is string => !!r)))
  if (rooms.length <= 1) return `${slots.map((s) => `${weekdayShort(s.weekday)} ${s.period}교시`).join(', ')}${rooms[0] ? ` · ${rooms[0]}` : ''}`
  return slots.map((s) => `${weekdayShort(s.weekday)} ${s.period}교시${s.roomName ? `(${s.roomName})` : ''}`).join(', ')
}

// ───────────────────────── 직접 입력 일정 구독(관리 화면용) ─────────────────────────

interface EntriesState {
  status: 'loading' | 'ready' | 'error'
  entries: PersonalEntry[]
  error: string | null
  fromCache: boolean
}

const LOADING_ENTRIES: EntriesState = { status: 'loading', entries: [], error: null, fromCache: false }

/**
 * personalEntries.subscribePersonalEntries 위에서 첫 결과를 받을 때까지 '불러오는 중'을 유지(빈 목록으로 단정하지 않음).
 * 오류면 code와 함께 '다시 시도'(attempt를 올려 다시 구독).
 */
function useEntriesForManage(uid: string | null, attempt: number): EntriesState {
  const [st, setSt] = useState<{ key: string; value: EntriesState }>({ key: '', value: LOADING_ENTRIES })
  const key = uid ? `${uid}#${attempt}` : ''
  useEffect(() => {
    if (!uid) return
    const k = `${uid}#${attempt}`
    return subscribePersonalEntries(
      uid,
      (entries, meta) => setSt({ key: k, value: { status: 'ready', entries, error: null, fromCache: meta.fromCache } }),
      (e) => setSt({ key: k, value: { status: 'error', entries: [], error: String((e as { code?: unknown })?.code || 'error'), fromCache: false } })
    )
  }, [uid, attempt])
  return key && st.key === key ? st.value : LOADING_ENTRIES
}

function sortEntries(list: PersonalEntry[]): PersonalEntry[] {
  const t = (e: PersonalEntry) => (e.period != null ? e.period * 100 : 0) + (e.start ? Number(e.start.replace(':', '')) / 10000 : 0)
  return [...list].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'weekly' ? -1 : 1
    if (a.kind === 'weekly') return (a.weekday ?? 9) - (b.weekday ?? 9) || t(a) - t(b) || a.title.localeCompare(b.title, 'ko')
    return (a.date ?? '').localeCompare(b.date ?? '') || t(a) - t(b) || a.title.localeCompare(b.title, 'ko')
  })
}

// ───────────────────────── 작은 화면 조각 ─────────────────────────

const btnPrimary =
  'inline-flex min-h-11 items-center justify-center rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:opacity-60'
const btnSecondary =
  'inline-flex min-h-11 items-center justify-center rounded-xl bg-white px-4 text-sm font-semibold text-emerald-700 ring-1 ring-emerald-200 transition-colors hover:bg-emerald-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:opacity-60'
const btnSmall =
  'inline-flex min-h-11 items-center justify-center rounded-xl bg-white px-3 text-xs font-semibold text-gray-700 ring-1 ring-gray-300 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:opacity-60'
const btnSmallDanger =
  'inline-flex min-h-11 items-center justify-center rounded-xl bg-white px-3 text-xs font-semibold text-red-700 ring-1 ring-red-200 transition-colors hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:opacity-60'

type Tone = 'info' | 'warn' | 'error' | 'neutral'
const TONE: Record<Tone, string> = {
  info: 'bg-emerald-50/60 ring-emerald-100',
  warn: 'bg-amber-50 ring-amber-200',
  error: 'bg-rose-50 ring-rose-200',
  neutral: 'bg-gray-50 ring-gray-100',
}

function StateBox({
  tone,
  title,
  desc,
  alert,
  children,
}: {
  tone: Tone
  title: string
  desc?: string
  alert?: boolean
  children?: ReactNode
}): JSX.Element {
  return (
    <div role={alert ? 'alert' : 'status'} className={`rounded-xl px-4 py-5 ring-1 ${TONE[tone]}`}>
      <p className="text-sm font-semibold text-gray-900 break-keep wrap-anywhere">{title}</p>
      {desc && <p className="mt-1 text-xs leading-relaxed text-gray-600 break-keep">{desc}</p>}
      {children && <div className="mt-4">{children}</div>}
    </div>
  )
}

function Badge({ tone, icon, children }: { tone: 'emerald' | 'amber' | 'sky' | 'gray' | 'white'; icon?: 'check' | 'clock' | 'calendar' | 'stop' | 'link'; children: ReactNode }): JSX.Element {
  const cls = {
    emerald: 'bg-emerald-100 text-emerald-800 ring-emerald-200 font-bold',
    amber: 'bg-amber-50 text-amber-800 ring-amber-200 font-bold',
    sky: 'bg-sky-50 text-sky-800 ring-sky-200 font-semibold',
    gray: 'bg-gray-100 text-gray-700 ring-gray-200 font-semibold',
    white: 'bg-white text-gray-600 ring-gray-300 font-medium',
  }[tone]
  const path = icon
    ? {
        check: <path d="m5 12 5 5 9-10" />,
        clock: (
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </>
        ),
        calendar: (
          <>
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M8 3v4M16 3v4M3 10h18" />
          </>
        ),
        stop: (
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="M8 12h8" />
          </>
        ),
        link: (
          <>
            <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
            <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
          </>
        ),
      }[icon]
    : null
  return (
    <span className={`inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ring-1 break-keep ${cls}`}>
      {path && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 shrink-0" aria-hidden="true">
          {path}
        </svg>
      )}
      <span className="min-w-0">{children}</span>
    </span>
  )
}

function Section({ id, title, desc, children }: { id: SectionId; title: string; desc?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20 rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
      <h2 id={`${id}-title`} className="text-base font-bold text-gray-900">
        {title}
      </h2>
      {desc && <p className="mt-0.5 text-xs leading-relaxed text-gray-500 break-keep">{desc}</p>}
      <div className="mt-3">{children}</div>
    </section>
  )
}

function MineItem({
  row,
  payload,
  today,
  busy,
  onLeave,
}: {
  row: MineRow
  payload: MyTimetablePayload
  today: Ymd
  busy?: boolean
  /** 내가 직접 담은 수업(출처 신청) 빼기 — 없으면 버튼 없음 */
  onLeave?: () => void
}): JSX.Element {
  const c = row.course
  const title = lessonTitle(c)
  const selfPicked = row.source === 'request' && row.status !== 'ended'
  const slots = row.status === 'ended' ? [] : courseSchedule(payload, row.courseId, row.status === 'upcoming' && row.from ? row.from : today)
  return (
    <article aria-label={title} className={`rounded-xl border px-4 py-3 ${row.status === 'ended' ? 'border-gray-200 bg-gray-50' : 'border-gray-200 bg-white'}`}>
      <h3 className="text-[15px] font-semibold text-gray-900 break-keep wrap-anywhere">{title}</h3>
      <p className="mt-0.5 text-xs text-gray-600 break-keep wrap-anywhere">
        {c.teacherNames.length ? `${c.teacherNames.join(', ')} 선생님` : '담당 선생님 정보 없음'}
      </p>
      {row.status !== 'ended' && <p className="text-xs text-gray-600 break-keep wrap-anywhere">{scheduleText(slots)}</p>}
      <div className="mt-1.5 flex flex-wrap gap-1">
        {row.status === 'active' && (
          <Badge tone="emerald" icon="check">
            참여 중
          </Badge>
        )}
        {row.status === 'upcoming' && row.from && (
          <Badge tone="sky" icon="calendar">
            {monthDay(row.from)}부터
          </Badge>
        )}
        {row.status === 'pending' && (
          <Badge tone="amber" icon="clock">
            승인 대기
          </Badge>
        )}
        {row.status === 'ended' && (
          <Badge tone="gray" icon="stop">
            {row.rejected ? '거절됨 · 선생님이 신청을 받지 않았어요' : row.to ? `종료 · ${monthDay(addDays(row.to, -1))}까지` : '종료'}
          </Badge>
        )}
        <Badge tone="white">출처 · {SOURCE_LABEL[row.source]}</Badge>
      </div>
      {row.status === 'pending' && (
        <p className="mt-1.5 text-xs leading-relaxed text-amber-900 break-keep">
          {title} 수업 승인을 기다리고 있어요 · 선생님이 승인하면 내 시간표에 나타나요
        </p>
      )}
      {selfPicked && onLeave ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" onClick={onLeave} disabled={busy} aria-label={`${title} 빼기`} className={btnSmall}>
            {row.status === 'pending' ? '신청 취소(빼기)' : '빼기'}
          </button>
          <span className="text-[11px] text-gray-500 break-keep">내가 담은 수업이라 직접 뺄 수 있어요</span>
        </div>
      ) : (
        row.status !== 'ended' && (
          <p className="mt-1.5 text-[11px] text-gray-500 break-keep">
            {row.source === 'common' ? '반 공통 수업이에요' : '학교에서 넣어 준 수업이에요'} · 빼거나 바꾸려면 선생님께 문의해 주세요
          </p>
        )
      )}
    </article>
  )
}

function PersonalItem({
  entry,
  payload,
  activeIds,
  canLink,
  busy,
  overlapsSchool,
  onEdit,
  onLink,
  onUnlink,
  onDelete,
}: {
  entry: PersonalEntry
  payload: MyTimetablePayload | null
  activeIds: Set<string> | null
  canLink: boolean
  busy: boolean
  /** 연결하지 않은 일정이 같은 요일·교시의 학교 수업(내 수업·공개 수업)과 겹침 — 담기·연결 안내 */
  overlapsSchool?: boolean
  onEdit: () => void
  onLink: () => void
  onUnlink: () => void
  onDelete: () => void
}): JSX.Element {
  const linkedId = entry.linkedCourseId ?? null
  const linkedCourse = linkedId && payload ? payload.courses.find((c) => c.courseId === linkedId) ?? null : null
  // 연결돼 있고 그 수업에 지금 참여 중이면 공식 수업으로 표시(엔진과 같은 기준). 자료를 못 받았으면 연결 표시만
  const linkedActive = !!linkedId && (activeIds ? activeIds.has(linkedId) : true)
  const where = [entryWhenText({ kind: entry.kind, weekday: entry.weekday ?? null, date: entry.date ?? null }), entryTimeText({ period: entry.period ?? null, start: entry.start ?? null, end: entry.end ?? null })]
  if (entry.roomName) where.push(entry.roomName)
  return (
    <article
      aria-label={entry.title}
      className={`rounded-xl px-4 py-3 ${linkedActive ? 'border border-emerald-200 bg-white' : 'border-2 border-dashed border-gray-300 bg-gray-50'}`}
    >
      <h3 className="text-[15px] font-semibold text-gray-900 break-keep wrap-anywhere">{entry.title}</h3>
      <p className="mt-0.5 text-xs text-gray-700 break-keep wrap-anywhere">{where.join(' · ')}</p>
      {entry.memo && (
        <p className="mt-0.5 text-xs text-gray-600 break-keep wrap-anywhere">
          <span className="font-semibold text-gray-500">메모</span> {entry.memo}
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap gap-1">
        {linkedActive ? (
          <Badge tone="emerald" icon="link">
            공식 수업에 연결됨{linkedCourse ? ` · ${lessonTitle(linkedCourse)}` : ''}
          </Badge>
        ) : (
          <Badge tone="white">직접 입력 · 학교 시간표와 연결되지 않음</Badge>
        )}
        {entry.pendingSync && (
          <Badge tone="gray" icon="clock">
            저장 대기
          </Badge>
        )}
      </div>
      {linkedActive && (
        <p className="mt-1.5 text-xs leading-relaxed text-emerald-900 break-keep">공식 수업이 표시되고 메모만 붙어요 — 학교 변경이 자동 반영돼요</p>
      )}
      {!linkedId && overlapsSchool && (
        <p className="mt-1.5 flex items-start gap-1 text-xs leading-relaxed text-sky-900 break-keep">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v5M12 8h.01" />
          </svg>
          <span className="min-w-0">
            학교 수업과 시간이 겹쳐요 — <a href="#catalog" className="font-semibold underline underline-offset-2">담기</a>/연결하면 변경이 자동 반영돼요
          </span>
        </p>
      )}
      {linkedId && !linkedActive && (
        <p className="mt-1.5 text-xs leading-relaxed text-amber-900 break-keep">
          연결했던 공식 수업{linkedCourse ? `(${lessonTitle(linkedCourse)})` : ''}에 지금은 참여하지 않아 직접 입력 일정으로 보여요.
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={onEdit} disabled={busy} aria-label={`${entry.title} 수정`} className={btnSmall}>
          수정
        </button>
        {linkedId ? (
          <button type="button" onClick={onUnlink} disabled={busy} aria-label={`${entry.title} 연결 해제`} className={btnSmall}>
            연결 해제
          </button>
        ) : (
          canLink && (
            <button type="button" onClick={onLink} disabled={busy} aria-label={`${entry.title} 공식 수업에 연결`} className={btnSmall}>
              공식 수업에 연결
            </button>
          )
        )}
        <button type="button" onClick={onDelete} disabled={busy} aria-label={`${entry.title} 삭제`} className={btnSmallDanger}>
          삭제
        </button>
      </div>
    </article>
  )
}

function errorTextOf(err: TimetableFetchError): { title: string; offline: boolean } {
  if (err.kind === 'offline') return { title: '인터넷 연결을 확인해 주세요', offline: true }
  if (err.kind === 'forbidden') return { title: '이 시간표를 볼 권한이 없어요', offline: false }
  return { title: `참여 중인 수업을 불러오지 못했어요 (${err.code})`, offline: false }
}

// ───────────────────────── 화면 ─────────────────────────

type Editor = { mode: 'create' } | { mode: 'edit' | 'link'; entryId: string } | null

export default function StudentCoursesPage(): JSX.Element {
  const { toast, confirm } = useUI()
  const [gate, setGate] = useState<Gate>({ kind: 'checking' })
  const [profileAttempt, setProfileAttempt] = useState<number>(0)
  const [today, setToday] = useState<Ymd>(() => schoolYmdAt(Date.now()))
  const [entriesAttempt, setEntriesAttempt] = useState<number>(0)
  const [editor, setEditor] = useState<Editor>(null)
  const [busyEntry, setBusyEntry] = useState<string | null>(null)
  const [hash, setHash] = useState<string>('')

  // 화면 복귀 때 오늘 날짜 확인(자정 경계)
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') setToday(schoolYmdAt(Date.now()))
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  // 로그인 확인 + 프로필(역할·학교·소속 표시용 — 권한 판단은 서버 API·규칙이 함)
  useEffect(() => {
    let cancelled = false
    const unsub = onAuthStateChanged(auth, (u) => {
      setHash(typeof window !== 'undefined' ? window.location.hash : '')
      if (!u || u.isAnonymous) {
        setGate({ kind: 'login' })
        return
      }
      setGate({ kind: 'checking' })
      void (async () => {
        try {
          const snap = await getDoc(doc(db, 'users', u.uid))
          if (cancelled || (auth.currentUser && auth.currentUser.uid !== u.uid)) return
          const d = snap.exists() ? (snap.data() as ProfileLite) : null
          if (!d) setGate({ kind: 'no-profile' })
          else if (d.role !== 'student') setGate({ kind: 'not-student' })
          else if (!d.schoolCode) setGate({ kind: 'no-school' })
          else setGate({ kind: 'ok', uid: u.uid, profile: d })
        } catch (e) {
          if (cancelled) return
          const code = String((e as { code?: unknown })?.code || 'error').replace(/^firestore\//, '')
          const offline = (typeof navigator !== 'undefined' && navigator.onLine === false) || code === 'unavailable'
          setGate({ kind: 'profile-error', code, offline })
        }
      })()
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [profileAttempt])

  const uid = gate.kind === 'ok' ? gate.uid : null
  const profile = gate.kind === 'ok' ? gate.profile : null
  const tt = useMyTimetable(uid, uid ? today : null, { schoolCode: profile?.schoolCode ?? null })
  const entriesState = useEntriesForManage(uid, entriesAttempt)
  const catalog = useCatalog(uid)
  const [leaving, setLeaving] = useState<string | null>(null)

  const payload = tt.payload
  const mine = useMemo(() => (payload && uid ? mineRows(payload, uid, today) : null), [payload, uid, today])
  // 수업 담기·직접 입력 안내용: 이미 내 시간표에 있는 수업의 요일·교시
  const myLessons = useMemo(() => (payload && uid ? myLessonsFrom(payload, uid, today) : null), [payload, uid, today])
  // 수업 담기 카드의 내 상태·출처(차시 없는 수업·끝낸 수강 포함)
  const myStates = useMemo(() => (payload && uid ? myCourseStates(payload, uid, today) : null), [payload, uid, today])
  const catalogCourses = useMemo(() => (catalog.state.status === 'ready' ? catalog.state.courses : null), [catalog.state])
  const activeIds = useMemo(() => (payload ? new Set(activeCoursesOn(payload, today, uid).map((c) => c.courseId)) : null), [payload, today, uid])
  const canLinkAny = useMemo(() => (payload ? linkableCourses(payload, today, uid).length > 0 : false), [payload, today, uid])
  const entries = useMemo(() => sortEntries(entriesState.entries), [entriesState.entries])
  const editingEntry = editor && editor.mode !== 'create' ? entries.find((e) => e.entryId === editor.entryId) ?? null : null

  // 해시 앵커(#invite·#mine·#catalog·#personal)로 들어오면 그 섹션으로. 자료가 들어와 위 섹션 높이가 바뀌면 한 번 더 맞춤(사용자가 손대기 전까지).
  // 위쪽 섹션은 따로따로 늦게 채워짐 — 참여 중인 수업(내 시간표 자료)·수업 담기(공개 목록, 칸 표가 그 뒤에 그려짐)·직접 입력 —
  // 그래서 셋이 각각 **처음** 자리를 잡을 때마다 다시 맞춤(#invite는 수업 담기 아래라, 공개 목록이 늦게 오면 밀려 내려가므로).
  // 처음 한 번뿐: '다시 시도'로 다시 불러오는 것(불러오는 중 → 다 됨)은 새로 맞추지 않음 — 다시 시도를 누른 사람을 옮기지 않게.
  // 사용자가 손대면(휠·터치·키·마우스 누름) 그 뒤로는 맞추지 않음
  const userScrolledRef = useRef(false)
  const scrolledForRef = useRef<string>('')
  const settledOnceRef = useRef({ mine: false, entries: false, catalog: false })
  useEffect(() => {
    const mark = (): void => {
      userScrolledRef.current = true
    }
    window.addEventListener('wheel', mark, { passive: true })
    window.addEventListener('touchstart', mark, { passive: true })
    window.addEventListener('pointerdown', mark, { passive: true })
    window.addEventListener('keydown', mark)
    return () => {
      window.removeEventListener('wheel', mark)
      window.removeEventListener('touchstart', mark)
      window.removeEventListener('pointerdown', mark)
      window.removeEventListener('keydown', mark)
    }
  }, [])
  const mineSettled = !!payload || (!!tt.error && !tt.loading)
  const entriesSettled = entriesState.status !== 'loading'
  const catalogSettled = catalog.state.status !== 'loading'
  useEffect(() => {
    if (gate.kind !== 'ok') return
    const id = hash.replace(/^#/, '')
    if (!(SECTION_IDS as readonly string[]).includes(id)) return
    // 자료마다 '처음 자리를 잡음'만 기억(한 번 true면 그대로) — 다시 불러와도 같은 단계라 다시 맞추지 않음
    const once = settledOnceRef.current
    once.mine = once.mine || mineSettled
    once.entries = once.entries || entriesSettled
    once.catalog = once.catalog || catalogSettled
    const stage = `${id}|${once.mine ? 1 : 0}|${once.entries ? 1 : 0}|${once.catalog ? 1 : 0}`
    if (scrolledForRef.current === stage) return
    if (scrolledForRef.current && userScrolledRef.current) return
    scrolledForRef.current = stage
    // 두 프레임 뒤: 자료가 들어온 렌더 다음에 그려지는 칸 표·목록까지 자리를 잡은 뒤 맞춤
    let raf2 = 0
    const raf = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }))
    })
    return () => {
      window.cancelAnimationFrame(raf)
      window.cancelAnimationFrame(raf2)
    }
  }, [gate.kind, hash, mineSettled, entriesSettled, catalogSettled])

  // 같은 화면 안에서 앵커를 바꾸면(상태 카드의 버튼 등) 기억해 둠
  useEffect(() => {
    const onHash = (): void => setHash(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const retryProfile = useCallback(() => {
    setGate({ kind: 'checking' })
    setProfileAttempt((n) => n + 1)
  }, [])

  const closeEditor = useCallback(() => setEditor(null), [])

  /**
   * 골라 담은 수업 한 번에 담기(수업 담기 장바구니·직접 입력의 '이 시간 학교 수업' 공통):
   * 확인 시트(겹침 경고 포함) → requestMany 한 번 → 결과 안내 → 내 시간표·목록 다시 받기
   */
  const pickCourses = async (picks: PickerCourse[], conflicts: CartConflict[]): Promise<PickResult[] | { error: string } | null> => {
    if (!picks.length) return null
    const n = picks.length
    const approval = picks.filter((c) => c.invitePolicy === 'approval').length
    const ok = await confirm({
      title: n === 1 ? `${pickerTitle(picks[0])} 수업을 담을까요?` : `수업 ${n}개를 내 시간표에 담을까요?`,
      description:
        `${picks.map(pickerTitle).join(', ')}.` +
        (approval < n ? ' 바로 담기 수업은 오늘부터 내 시간표에 들어가요.' : '') +
        (approval ? ` 선생님 승인이 필요한 수업 ${approval}개는 승인 후 들어가요.` : '') +
        (conflicts.length ? ` 겹치는 시간이 ${conflicts.length}곳 있어요 — 그대로 담아도 되고, 취소하고 빼도 돼요.` : '') +
        ' 담은 수업은 선생님이 시간표를 바꾸면 자동으로 반영돼요.',
      confirmText: '담기',
    })
    if (!ok) return null
    const r = await requestCourses(picks.map((c) => c.courseId))
    if (!r.ok) {
      const msg = pickRequestErrorText(r.failure)
      toast(msg, 'error')
      // 응답을 못 받았으면 실제로는 담겼을 수 있어 다시 받음, 수업 상태가 바뀐 경우(끝남 등)도 목록을 새로
      if (r.failure.code === 'timeout') tt.retry()
      if (r.failure.code === 'timeout' || r.failure.code === 'course-ended' || r.failure.status === 409) catalog.reload()
      return { error: msg }
    }
    const okCount = r.results.filter((x) => x.kind !== 'failed').length
    toast(pickSummaryText(r.results), okCount ? 'success' : 'error')
    if (r.changed > 0) tt.retry()
    catalog.reload()
    return r.results
  }

  /** 내가 직접 담은 수업 빼기(출처 신청만 — 서버도 확인) */
  const leavePicked = async (courseId: string, title: string, pending: boolean): Promise<void> => {
    if (leaving) return
    const ok = await confirm({
      title: pending ? `${title} 신청을 취소할까요?` : `${title} 수업을 내 시간표에서 뺄까요?`,
      description: pending
        ? '선생님 승인을 기다리던 신청이 취소돼요. 나중에 다시 담을 수 있어요.'
        : '오늘부터 내 시간표에서 빠지고, 지난 날짜 기록은 그대로 남아요. 나중에 다시 담을 수 있어요.',
      confirmText: '빼기',
      danger: true,
    })
    if (!ok) return
    setLeaving(courseId)
    const r = await leaveCourse(courseId)
    setLeaving(null)
    if (!r.ok) {
      toast(leaveErrorText(r.failure), 'error')
      return
    }
    toast(r.already ? '이미 뺀 수업이에요' : `${title} 수업을 뺐어요`, 'success')
    tt.retry()
    catalog.reload()
  }

  /** 직접 입력 화면의 '이 시간 학교 수업' 담기 — 같은 담기 흐름(확인 시트 → requestMany)으로 한 개만 */
  const quickPick = async (c: PickerCourse): Promise<PickResult | null> => {
    const res = await pickCourses([c], cartConflicts([c], myLessons || []))
    return Array.isArray(res) ? res.find((r) => r.courseId === c.courseId) ?? null : null
  }

  const onDelete = async (entry: PersonalEntry): Promise<void> => {
    if (!uid || busyEntry) return
    const ok = await confirm({
      title: `‘${entry.title}’ 일정을 삭제할까요?`,
      description: '삭제하면 내 시간표에서도 사라져요. 공식 수업에는 영향이 없어요.',
      confirmText: '삭제',
      danger: true,
    })
    if (!ok) return
    setBusyEntry(entry.entryId)
    if (editor && editor.mode !== 'create' && editor.entryId === entry.entryId) setEditor(null)
    let committed: Promise<void>
    try {
      committed = deletePersonalEntry(uid, entry.entryId).committed
    } catch (e) {
      setBusyEntry(null)
      toast(personalWriteErrorText(String((e as { code?: unknown })?.code || 'unknown')), 'error')
      return
    }
    const r = await waitForCommit(committed, (code) => toast(`삭제하지 못했어요 — ${personalWriteErrorText(code)}`, 'error'))
    setBusyEntry(null)
    if (r.kind === 'saved') toast('삭제했어요', 'success')
    else if (r.kind === 'pending') toast('삭제 대기 — 인터넷에 연결되면 반영돼요')
    else toast(`삭제하지 못했어요 — ${personalWriteErrorText(r.code)}`, 'error')
  }

  const onUnlink = async (entry: PersonalEntry): Promise<void> => {
    if (!uid || busyEntry) return
    const ok = await confirm({
      title: '공식 수업 연결을 해제할까요?',
      description: `‘${entry.title}’이 다시 ‘직접 입력 · 학교 시간표와 연결되지 않음’ 일정으로 표시되고, 학교 변경이 자동으로 반영되지 않아요.`,
      confirmText: '연결 해제',
    })
    if (!ok) return
    setBusyEntry(entry.entryId)
    const out = setPersonalEntryLink(uid, entry, null)
    if (!out.ok) {
      setBusyEntry(null)
      toast('연결을 해제하지 못했어요. 일정 내용을 확인해 주세요.', 'error')
      return
    }
    const r = await waitForCommit(out.committed, (code) => toast(`연결을 해제하지 못했어요 — ${personalWriteErrorText(code)}`, 'error'))
    setBusyEntry(null)
    if (r.kind === 'saved') toast('연결을 해제했어요 — 다시 직접 입력 일정으로 표시돼요', 'success')
    else if (r.kind === 'pending') toast('저장 대기 — 인터넷에 연결되면 연결 해제가 반영돼요')
    else toast(`연결을 해제하지 못했어요 — ${personalWriteErrorText(r.code)}`, 'error')
  }

  // ── 상단(뒤로·제목) ──
  const header = (
    <header className="sticky top-0 z-40 border-b border-gray-200 bg-white">
      <div className="mx-auto flex h-14 max-w-2xl items-center gap-1 px-2">
        <Link
          href="/student/today"
          aria-label="오늘 화면으로"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-gray-600 transition-colors hover:bg-gray-100"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden="true">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-lg font-bold text-gray-900">내 수업</h1>
        {gate.kind === 'ok' && (
          <Link
            href="/student/timetable"
            className="inline-flex min-h-11 shrink-0 items-center rounded-xl px-3 text-sm font-semibold text-emerald-700 transition-colors hover:bg-emerald-50"
          >
            내 시간표
          </Link>
        )}
      </div>
    </header>
  )

  const shell = (children: ReactNode): JSX.Element => (
    <div className="min-h-screen bg-gray-50 text-black">
      {header}
      <main className="mx-auto max-w-2xl space-y-4 px-4 py-4" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 2rem)' }}>
        {children}
      </main>
    </div>
  )

  // ── 요구 3절 상태 ──
  const apiBlock = tt.error && !payload ? tt.error.kind : null
  if (gate.kind === 'checking') {
    return shell(
      <div className="flex justify-center py-16" role="status" aria-label="불러오는 중">
        <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-emerald-600" />
      </div>
    )
  }
  if (gate.kind === 'login' || apiBlock === 'unauthenticated') {
    const next = `/student/courses${hash && (SECTION_IDS as readonly string[]).includes(hash.slice(1)) ? hash : ''}`
    return shell(
      <StateBox tone="info" title="로그인이 필요해요" desc="로그인하면 내 수업과 직접 입력한 일정을 볼 수 있어요.">
        <Link href={`/auth/login?next=${encodeURIComponent(next)}`} className={btnPrimary}>
          로그인
        </Link>
      </StateBox>
    )
  }
  if (gate.kind === 'no-profile' || apiBlock === 'no-profile') {
    const saved = readPendingInvite()
    return shell(
      <StateBox tone="info" title="가입이 아직 끝나지 않았어요" desc="선생님께 받은 초대 코드를 입력하거나, 받은 초대 링크(QR)를 다시 열어 주세요.">
        <InviteCodeInput />
        {saved && (
          <Link href={invitePath(saved)} className={`${btnSecondary} mt-3 w-full`}>
            초대 링크 다시 열기
          </Link>
        )}
      </StateBox>
    )
  }
  if (gate.kind === 'not-student' || apiBlock === 'not-student') {
    return shell(
      <StateBox tone="error" alert title="이 시간표를 볼 권한이 없어요" desc="내 수업 화면은 학생 계정에서 쓸 수 있어요.">
        <Link href="/dashboard" className={btnPrimary}>
          선생님 화면으로
        </Link>
      </StateBox>
    )
  }
  if (gate.kind === 'no-school' || apiBlock === 'no-school') {
    return shell(
      <StateBox tone="warn" title="학교 정보가 없어요" desc="초대 링크나 초대 코드로 학급·수업에 먼저 참여해 주세요. 참여하면 학교가 정해져요.">
        <InviteCodeInput />
      </StateBox>
    )
  }
  if (gate.kind === 'profile-error') {
    return shell(
      <StateBox
        tone={gate.offline ? 'warn' : 'error'}
        alert
        title={gate.offline ? '인터넷 연결을 확인해 주세요' : `내 정보를 불러오지 못했어요 (${gate.code})`}
        desc={gate.offline ? '연결되면 다시 시도해 주세요.' : '잠시 후 다시 시도해 주세요.'}
      >
        <button type="button" onClick={retryProfile} className={btnPrimary}>
          다시 시도
        </button>
      </StateBox>
    )
  }

  // gate.kind === 'ok'
  const p = gate.profile
  const classId = p.status === 'rejected' ? '' : String(p.classId || '')
  const isGroupLegacy = GROUP_CLASS_RE.test(classId)
  const hr = payload?.homeroom ?? null
  const homeroomMissing = !classId || isGroupLegacy
  const homeroomLabel = !classId
    ? null
    : isGroupLegacy
      ? '소속 학급 확인 필요'
      : (() => {
          const label =
            hr && hr.classId === classId && !hr.isGroupLegacy && hr.label
              ? hr.label
              : p.grade && p.classNm
                ? `${p.grade}학년 ${p.classNm}반`
                : '학급'
          // '승인 대기'는 실제 학급 신청이 있을 때만(today.tsx 배너와 같은 판단)
          return awaitingHomeroomApproval(p) ? `${label} (승인 대기)` : label
        })()
  const schoolName = String(hr?.schoolName || p.schoolName || '')
  const initialHash = hash.replace(/^#/, '')

  const ended = mine ? mine.rows.filter((r) => r.status === 'ended') : []
  const current = mine ? mine.rows.filter((r) => r.status !== 'ended') : []
  const syncedLabel = tt.syncedAt ? formatSyncedAt(tt.syncedAt) : null

  return shell(
    <>
      <div>
        <p className="text-sm text-gray-600 break-keep wrap-anywhere">
          {schoolName ? `${schoolName} · ` : ''}
          {homeroomLabel ?? '소속 학급 미설정'}
        </p>
        {homeroomMissing && (
          <div role="status" className="mt-2 rounded-xl bg-amber-50 px-4 py-3 ring-1 ring-amber-200">
            <p className="text-sm font-semibold text-gray-900 break-keep">소속 학급이 아직 없어요(수업은 따로 볼 수 있음)</p>
            <p className="mt-0.5 text-xs leading-relaxed text-gray-600 break-keep">담임 선생님의 학급 QR이나 초대 코드로 소속 학급을 등록해 주세요.</p>
            <a href="#invite" className={`${btnSecondary} mt-2`}>
              담임 초대 코드 입력
            </a>
          </div>
        )}
      </div>

      <nav aria-label="내 수업 바로가기">
        <ul className="flex flex-wrap gap-2">
          {(
            [
              ['mine', '참여 중인 수업'],
              ['catalog', '수업 담기'],
              ['invite', '초대 코드'],
              ['personal', '직접 입력'],
            ] as const
          ).map(([id, label]) => (
            <li key={id}>
              <a
                href={`#${id}`}
                className="inline-flex min-h-11 items-center rounded-full bg-white px-4 text-sm font-semibold text-gray-700 ring-1 ring-gray-200 transition-colors hover:bg-emerald-50 hover:text-emerald-800"
              >
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <Section id="mine" title="참여 중인 수업" desc="학교 시간표와 연결된 공식 수업이에요. 선생님이 시간표를 바꾸면 내 시간표에 자동으로 반영돼요.">
        {!mine || !payload ? (
          tt.error && !tt.loading ? (
            (() => {
              const t = errorTextOf(tt.error)
              return (
                <StateBox tone={t.offline ? 'warn' : 'error'} alert title={t.title} desc={t.offline ? '연결되면 다시 시도해 주세요.' : '잠시 후 다시 시도해 주세요.'}>
                  <button type="button" onClick={tt.retry} className={btnPrimary}>
                    다시 시도
                  </button>
                </StateBox>
              )
            })()
          ) : (
            <div className="animate-pulse space-y-2" role="status" aria-label="참여 중인 수업을 불러오는 중">
              <div className="h-20 rounded-xl bg-gray-100" />
              <div className="h-20 rounded-xl bg-gray-100" />
            </div>
          )
        ) : (
          <div className="space-y-3">
            {tt.error && (tt.error.kind === 'offline' || tt.error.kind === 'server') && (
              <SyncBanner kind={tt.error.kind} syncedLabel={syncedLabel} code={tt.error.code} onRetry={tt.retry} retrying={tt.loading} />
            )}
            {current.length === 0 ? (
              <StateBox tone="info" title="아직 연결된 수업이 없어요" desc="학교 수업 목록에서 내 수업을 골라 담거나, 선생님께 받은 초대 코드로 참여하거나, 학교 밖 일정은 직접 입력할 수 있어요.">
                <div className="flex flex-wrap gap-2">
                  <a href="#catalog" className={btnPrimary}>
                    수업 담기
                  </a>
                  <a href="#invite" className={btnSecondary}>
                    초대 코드 입력
                  </a>
                  <a href="#personal" className={btnSecondary}>
                    직접 입력
                  </a>
                </div>
              </StateBox>
            ) : (
              <ul className="space-y-2" aria-label="참여 중인 수업 목록">
                {current.map((r) => (
                  <li key={r.courseId}>
                    <MineItem
                      row={r}
                      payload={payload}
                      today={today}
                      busy={!!leaving}
                      onLeave={() => void leavePicked(r.courseId, lessonTitle(r.course), r.status === 'pending')}
                    />
                  </li>
                ))}
              </ul>
            )}
            {mine.missing > 0 && (
              <p className="text-xs text-gray-500 break-keep">정보를 찾을 수 없는 수업 {mine.missing}개가 있어요. 선생님께 확인해 주세요.</p>
            )}
            {ended.length > 0 && (
              <details className="group">
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 text-sm font-semibold text-gray-600 [&::-webkit-details-marker]:hidden">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 transition-transform group-open:rotate-90" aria-hidden="true">
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                  종료된 수업 {ended.length}개
                </summary>
                <ul className="mt-1 space-y-2" aria-label="종료된 수업 목록">
                  {ended.map((r) => (
                    <li key={r.courseId}>
                      <MineItem row={r} payload={payload} today={today} />
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </Section>

      <Section
        id="catalog"
        title="수업 담기 (학교 수업 목록에서 고르기)"
        desc="학교가 공개한 수업을 시간표 칸이나 과목으로 찾아 골라 담아요. 담은 수업은 선생님이 시간표를 바꾸면 내 시간표에 자동으로 반영돼요. 수업에 따라 바로 담기거나 선생님 승인 후 들어가요."
      >
        {uid && (
          <CoursePicker
            catalog={catalog.state}
            refreshing={catalog.refreshing}
            onReloadCatalog={catalog.reload}
            mine={myLessons}
            myStates={myStates}
            busy={!!leaving}
            onSubmit={pickCourses}
            onLeave={leavePicked}
          />
        )}
      </Section>

      <Section id="invite" title="초대 코드로 참여" desc="담임 선생님의 학급 초대와 다른 선생님의 수업 초대 모두 여기에 입력해요. 소속 학급은 그대로 두고 수업만 더해져요.">
        <InviteCodeInput autoFocus={initialHash === 'invite'} />
      </Section>

      <Section
        id="personal"
        title="직접 입력한 일정"
        desc="학원·자습처럼 학교 밖 일정을 적어 두는 곳이에요. 직접 입력한 일정은 학교 시간표와 연결되지 않아 선생님의 변경이 자동으로 반영되지 않아요 — 학교 수업은 ‘수업 담기’에서 골라 담아 주세요."
      >
        <div className="space-y-3">
          {entriesState.status === 'loading' && (
            <div className="animate-pulse space-y-2" role="status" aria-label="직접 입력한 일정을 불러오는 중">
              <div className="h-16 rounded-xl bg-gray-100" />
            </div>
          )}
          {entriesState.status === 'error' && (
            <StateBox tone="error" alert title={`직접 입력한 일정을 불러오지 못했어요 (${entriesState.error})`} desc="잠시 후 다시 시도해 주세요.">
              <button type="button" onClick={() => setEntriesAttempt((n) => n + 1)} className={btnPrimary}>
                다시 시도
              </button>
            </StateBox>
          )}
          {entriesState.status === 'ready' && (
            <>
              {entriesState.fromCache && typeof navigator !== 'undefined' && navigator.onLine === false && (
                <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200 break-keep">
                  오프라인이에요 · 이 기기에 저장된 일정만 보여요. 연결되면 저장 대기 중인 변경이 반영돼요.
                </p>
              )}
              {editor?.mode === 'create' && uid ? (
                <PersonalEntryForm
                  uid={uid}
                  payload={payload}
                  today={today}
                  catalog={catalogCourses}
                  onQuickPick={quickPick}
                  onDone={closeEditor}
                  onCancel={closeEditor}
                />
              ) : entries.length >= MAX_PERSONAL_ENTRIES ? (
                <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600 ring-1 ring-gray-200 break-keep">
                  직접 입력 일정은 {MAX_PERSONAL_ENTRIES}개까지 둘 수 있어요. 쓰지 않는 일정을 지운 뒤 추가해 주세요.
                </p>
              ) : (
                <button type="button" onClick={() => setEditor({ mode: 'create' })} className={`${btnSecondary} w-full`}>
                  <span aria-hidden="true" className="mr-1 text-base leading-none">
                    +
                  </span>
                  직접 입력 추가
                </button>
              )}
              {entries.length === 0 && editor?.mode !== 'create' && (
                <p className="rounded-xl bg-gray-50 px-4 py-4 text-center text-sm text-gray-600 ring-1 ring-gray-100 break-keep">아직 직접 입력한 일정이 없어요</p>
              )}
              {entries.length > 0 && (
                <ul className="space-y-2" aria-label="직접 입력한 일정 목록">
                  {entries.map((e) => (
                    <li key={e.entryId}>
                      {uid && editingEntry && editingEntry.entryId === e.entryId && editor && editor.mode !== 'create' ? (
                        <PersonalEntryForm
                          uid={uid}
                          entry={editingEntry}
                          mode={editor.mode === 'link' ? 'link' : 'edit'}
                          payload={payload}
                          today={today}
                          catalog={catalogCourses}
                          onQuickPick={quickPick}
                          onDone={closeEditor}
                          onCancel={closeEditor}
                        />
                      ) : (
                        <PersonalItem
                          entry={e}
                          payload={payload}
                          activeIds={activeIds}
                          canLink={canLinkAny}
                          busy={busyEntry === e.entryId}
                          overlapsSchool={
                            !e.linkedCourseId &&
                            entryOverlapsSchool(
                              { kind: e.kind, weekday: e.weekday ?? null, date: e.date ?? null, period: e.period ?? null, start: e.start ?? null, end: e.end ?? null, linkedCourseId: e.linkedCourseId ?? null },
                              catalogCourses || [],
                              myLessons || [],
                              payload?.periodTimes || []
                            )
                          }
                          onEdit={() => setEditor({ mode: 'edit', entryId: e.entryId })}
                          onLink={() => setEditor({ mode: 'link', entryId: e.entryId })}
                          onUnlink={() => void onUnlink(e)}
                          onDelete={() => void onDelete(e)}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <Link
            href="/student/timetable"
            className="flex min-h-11 items-center justify-between rounded-xl bg-white px-4 py-3 text-sm font-semibold text-gray-800 ring-1 ring-gray-200 transition-colors hover:bg-emerald-50"
          >
            <span className="break-keep">내 시간표에서 확인하기</span>
            <span aria-hidden="true" className="text-emerald-600">
              &rarr;
            </span>
          </Link>
        </div>
      </Section>
    </>
  )
}
