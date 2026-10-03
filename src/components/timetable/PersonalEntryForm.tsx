import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type JSX, type ReactNode } from 'react'
import { slotMinutes } from '../../lib/timetable/engine'
import { weekdayOf, ymdToIso } from '../../lib/timetable/dates'
import {
  activeCoursesOn,
  courseSchedule,
  linkableCourses,
  weekdayShort,
  type CourseSlotSummary,
  type MyTimetablePayload,
} from '../../lib/timetable/client'
import {
  createPersonalEntry,
  PERSONAL_LIMITS,
  setPersonalEntryLink,
  updatePersonalEntry,
  validatePersonalEntry,
  type PersonalEntryDraft,
  type PersonalEntryErrors,
  type WriteOutcome,
} from '../../lib/timetable/personalEntries'
import type { Course, PeriodTime, PersonalEntry, Weekday, Ymd } from '../../lib/timetable/types'
import { auth } from '../../lib/firebase'
import { useUI } from '../ui/feedback'
import { lessonTitle, shortDateKo } from './LessonCard'

/**
 * 직접 입력 일정 만들기·고치기·공식 수업 연결 (요구 문서 4절, 지시서 8장 B·C)
 * - 제목(1~40), 매주(요일)/특정 날짜, 교시 또는 시작·끝 시각, 교실(≤30), 메모(≤200)
 *   → personalEntries.ts의 검증·저장 함수(create/update/setPersonalEntryLink)만 사용
 * - 저장은 기기에 먼저 반영되고 서버 반영(committed)을 잠깐 기다림. 오프라인이거나 늦으면 '저장 대기'로 닫음
 * - '공식 수업에 연결'은 본인 활성 수강 수업(linkableCourses) 중에서 학생이 직접 고름.
 *   이름이 같다고 자동으로 추천·선택하지 않습니다.
 * - 연결 전 확인: 직접 입력 일정과 그 공식 수업의 같은 요일 차시를 나란히 보여 주고 차이·겹침을 안내
 * - 연결 후: 공식 수업이 표시되고 메모만 붙어요 — 학교 변경이 자동 반영돼요. 연결 해제(null)도 가능
 * - 내부 id(courseId)는 DOM에 넣지 않음(선택지 값은 목록 순번)
 */

// ───────────────────────── 표시 도우미 ─────────────────────────

export interface EntrySlotDraft {
  kind: 'weekly' | 'once'
  weekday: number | null
  date: Ymd | null
  period: number | null
  start: string | null
  end: string | null
  roomName?: string | null
  memo?: string | null
}

/** '매주 화요일' / '10월 6일(화)' */
export function entryWhenText(e: Pick<EntrySlotDraft, 'kind' | 'weekday' | 'date'>): string {
  if (e.kind === 'once') return e.date ? shortDateKo(e.date) : '날짜 미정'
  return e.weekday ? `매주 ${weekdayShort(e.weekday)}요일` : '요일 미정'
}

/** '7교시' / '7교시 (16:00~16:50)' / '16:30~18:00' */
export function entryTimeText(e: Pick<EntrySlotDraft, 'period' | 'start' | 'end'>): string {
  const hm = e.start ? `${e.start}${e.end ? `~${e.end}` : ''}` : ''
  if (e.period != null) return hm ? `${e.period}교시 (${hm})` : `${e.period}교시`
  return hm || '시간 미정'
}

function slotText(s: CourseSlotSummary): string {
  return `${weekdayShort(s.weekday)} ${s.period}교시${s.start ? ` (${s.start}${s.end ? `~${s.end}` : ''})` : ''}`
}

function slotsOverlap(
  a: { period: number | null; start?: string | null; end?: string | null },
  b: { period: number | null; start?: string | null; end?: string | null },
  periodTimes?: PeriodTime[]
): boolean {
  const x = slotMinutes(a, periodTimes)
  const y = slotMinutes(b, periodTimes)
  if (x.start !== null && x.end !== null && y.start !== null && y.end !== null) return x.start < y.end && y.start < x.end
  return a.period != null && a.period === b.period
}

export interface LinkNote {
  tone: 'ok' | 'warn' | 'info'
  text: string
}

export interface LinkCheck {
  /** 직접 입력 일정의 요일(특정 날짜면 그 날짜의 요일) */
  weekday: Weekday | null
  /** 공식 수업의 같은 요일 차시 */
  sameDay: CourseSlotSummary[]
  /** 공식 수업의 모든 차시(오늘 이후 이어지는 것) */
  allSlots: CourseSlotSummary[]
  notes: LinkNote[]
}

/**
 * 연결 전 비교: 직접 입력 일정 ↔ 공식 수업의 같은 요일 차시.
 * 엔진 규칙(연결되면 그 날 개인 일정 대신 공식 수업만 표시, 메모는 같은 교시 → 그 날 차시가 하나면 그 차시)에 맞춰 안내합니다.
 */
export function checkLink(entry: EntrySlotDraft, course: Course, payload: MyTimetablePayload, today: Ymd, uid?: string | null): LinkCheck {
  const title = lessonTitle(course)
  const refDate: Ymd = entry.kind === 'once' && entry.date ? entry.date : today
  const wd: Weekday | null =
    entry.kind === 'once' ? (entry.date ? weekdayOf(entry.date) : null) : entry.weekday && entry.weekday >= 1 && entry.weekday <= 7 ? (entry.weekday as Weekday) : null
  const allSlots = courseSchedule(payload, course.courseId, refDate)
  const sameDay = wd ? allSlots.filter((s) => s.weekday === wd) : []
  const pt = payload.periodTimes
  const notes: LinkNote[] = []
  const hasTime = entry.period != null || !!entry.start

  if (!allSlots.length) {
    notes.push({
      tone: 'warn',
      text: `공식 수업 ‘${title}’에는 아직 등록된 시간표가 없어요 — 연결하면 시간표가 등록될 때까지 이 일정이 내 시간표에 보이지 않아요.`,
    })
  } else if (wd && !sameDay.length) {
    const where = entry.kind === 'once' && entry.date ? `${shortDateKo(entry.date)}` : `${weekdayShort(wd)}요일`
    notes.push({
      tone: 'warn',
      text: `‘${title}’ 수업은 ${weekdayShort(wd)}요일에 없어요(${allSlots.map(slotText).join(', ')}) — 연결하면 ${where}에는 이 일정이 보이지 않아요.`,
    })
  } else if (sameDay.length) {
    const hit = hasTime ? sameDay.filter((s) => slotsOverlap(entry, s, pt)) : []
    if (hit.length) {
      notes.push({
        tone: 'ok',
        text: `같은 시간이에요(${hit.map(slotText).join(', ')}) — 지금은 직접 입력과 공식 수업이 겹쳐 따로 보이지만, 연결하면 공식 수업 하나만 보여요.`,
      })
    } else {
      notes.push({
        tone: 'warn',
        text: `시간이 달라요: 직접 입력 ${entryTimeText(entry)} · 공식 수업 ${sameDay.map((s) => `${s.period}교시`).join(', ')} — 연결하면 공식 수업 시간으로 표시돼요.`,
      })
    }
    const rooms = Array.from(new Set(sameDay.map((s) => s.roomName).filter((r): r is string => !!r)))
    if (entry.roomName && rooms.length && !rooms.includes(entry.roomName)) {
      notes.push({
        tone: 'info',
        text: `교실이 달라요: 직접 입력 ${entry.roomName} · 공식 수업 ${rooms.join(', ')} — 연결하면 공식 수업 교실로 표시돼요.`,
      })
    }
  }

  if (entry.memo) {
    const attaches = sameDay.length === 1 || (entry.period != null && sameDay.some((s) => s.period === entry.period))
    if (attaches) notes.push({ tone: 'ok', text: '메모는 공식 수업 카드에 붙어요.' })
    else if (sameDay.length > 1) {
      notes.push({ tone: 'warn', text: '이 요일에 공식 수업이 여러 번 있어 메모가 붙지 않을 수 있어요 — 교시를 공식 수업과 맞춰 주세요.' })
    }
  }

  // 지금 직접 입력 시간과 겹치는 다른 공식 수업(잘못 고른 수업인지 확인용)
  if (wd && hasTime) {
    const others = activeCoursesOn(payload, refDate, uid).filter((c) => c.courseId !== course.courseId)
    let count = 0
    for (const c of others) {
      if (count >= 2) break
      const hit = courseSchedule(payload, c.courseId, refDate).find((s) => s.weekday === wd && slotsOverlap(entry, s, pt))
      if (hit) {
        count++
        notes.push({
          tone: 'info',
          text: `직접 입력 시간은 ‘${lessonTitle(c)}’ ${slotText(hit)}와도 겹쳐요 — 연결할 수업이 맞는지 확인해 주세요.`,
        })
      }
    }
  }
  return { weekday: wd, sameDay, allSlots, notes }
}

// ───────────────────────── 저장 결과 기다리기 ─────────────────────────

export type CommitResult = { kind: 'saved' } | { kind: 'pending' } | { kind: 'failed'; code: string }

const SAVE_WAIT_MS = 5000

function errCode(e: unknown): string {
  const c = (e as { code?: unknown })?.code
  return typeof c === 'string' && c ? c.replace(/^firestore\//, '') : 'unknown'
}

/**
 * 서버 반영을 잠깐 기다림. 오프라인이거나 늦으면 'pending'(저장 대기 — 연결되면 자동 반영).
 * 이미 'pending'으로 닫은 뒤 규칙 등에 막히면 onLateFailure로 알림(기기에 먼저 보인 변경은 Firestore가 되돌림).
 */
export function waitForCommit(committed: Promise<void>, onLateFailure?: (code: string) => void): Promise<CommitResult> {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false
  return new Promise<CommitResult>((resolve) => {
    let done = false
    const timer = setTimeout(
      () => {
        if (done) return
        done = true
        resolve({ kind: 'pending' })
      },
      offline ? 0 : SAVE_WAIT_MS
    )
    committed.then(
      () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ kind: 'saved' })
      },
      (e) => {
        const code = errCode(e)
        if (done) {
          onLateFailure?.(code)
          return
        }
        done = true
        clearTimeout(timer)
        resolve({ kind: 'failed', code })
      }
    )
  })
}

/**
 * 이 기기의 로그인이 풀렸거나(다른 탭에서 로그아웃·세션 만료) 다른 계정으로 바뀌었는지.
 * 이때 쓰면 규칙(본인만)에 막혀 permission-denied가 오므로 다시 로그인을 안내합니다. 알 수 없으면 false
 */
function sessionLost(uid?: string | null): boolean {
  if (!auth) return false
  const u = auth.currentUser
  return !u || (!!uid && u.uid !== uid)
}

/**
 * 쓰기 오류 문구(Firestore 오류 code 기준). uid를 주면 다른 계정으로 바뀐 경우도 로그인 문제로 봅니다.
 * permission-denied는 로그인이 풀렸을 때만 다시 로그인을 안내 — 로그인 상태에서 막히면(입력은 화면에서 이미 검증)
 * 새 규칙 배포 전후처럼 잠깐 저장할 수 없는 경우라 중립 문구로 안내합니다.
 */
export function personalWriteErrorText(code: string, linking = false, uid?: string | null): string {
  switch (code) {
    case 'permission-denied':
      if (sessionLost(uid)) return '로그인이 풀렸거나 다른 계정으로 바뀌었어요. 다시 로그인해 주세요.'
      return linking
        ? '참여 중인(승인된) 공식 수업에만 연결할 수 있어요. 내 수업 목록을 새로 고친 뒤 다시 골라 주세요.'
        : '지금은 저장할 수 없어요. 잠시 후 다시 시도해 주세요.'
    case 'unauthenticated':
      return '로그인이 필요해요. 다시 로그인해 주세요.'
    case 'unavailable':
      return '인터넷 연결을 확인해 주세요.'
    case 'not-found':
      return '이미 삭제된 일정이에요.'
    default:
      return `저장하지 못했어요 (${code}). 잠시 후 다시 시도해 주세요.`
  }
}

// ───────────────────────── 폼 ─────────────────────────

export interface PersonalEntryFormDone {
  entryId: string
  /** 서버 반영 전에 닫음(저장 대기) */
  pending: boolean
  /** 바뀐 것이 없어 저장하지 않음 */
  unchanged?: boolean
}

export interface PersonalEntryFormProps {
  uid: string
  /** 고칠 일정(없으면 새로 만들기) */
  entry?: PersonalEntry | null
  /** 'link' = 기존 일정의 공식 수업 연결만 고르기 */
  mode?: 'edit' | 'link'
  /** /api/timetable/me 자료 — 연결할 수 있는 수업·차시 비교용(없으면 연결 선택 불가 안내) */
  payload: MyTimetablePayload | null
  today: Ymd
  onDone: (r: PersonalEntryFormDone) => void
  onCancel: () => void
}

interface FormValues {
  title: string
  kind: 'weekly' | 'once'
  weekday: string
  dateIso: string
  period: string
  start: string
  end: string
  roomName: string
  memo: string
  /** 연결할 공식 수업('' = 연결하지 않음). 화면(DOM)에는 넣지 않고 선택지 순번으로만 표시 */
  linkCourseId: string
}

interface LinkOption {
  courseId: string
  course: Course | null
  label: string
  /** 지금 참여 중이라 새로 연결할 수 있는지(아니면 이미 연결돼 있던 수업 — 유지·해제만) */
  usable: boolean
}

const WEEKDAYS: Array<{ v: Weekday; label: string }> = [
  { v: 1, label: '월요일' },
  { v: 2, label: '화요일' },
  { v: 3, label: '수요일' },
  { v: 4, label: '목요일' },
  { v: 5, label: '금요일' },
  { v: 6, label: '토요일' },
  { v: 7, label: '일요일' },
]

const PERIODS = Array.from({ length: PERSONAL_LIMITS.periodMax - PERSONAL_LIMITS.periodMin + 1 }, (_, i) => PERSONAL_LIMITS.periodMin + i)

const inputCls =
  'mt-1 block min-h-11 w-full min-w-0 appearance-none rounded-xl border bg-white px-3 py-2 text-base text-black shadow-sm placeholder-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500'
const btnPrimary =
  'inline-flex min-h-11 items-center justify-center rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:opacity-60'
const btnGhost =
  'inline-flex min-h-11 items-center justify-center rounded-xl bg-slate-100 px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:opacity-60'

function initialValues(entry: PersonalEntry | null | undefined, today: Ymd): FormValues {
  const wdToday = weekdayOf(today)
  return {
    title: entry?.title ?? '',
    kind: entry?.kind ?? 'weekly',
    weekday: String(entry?.weekday ?? (wdToday <= 5 ? wdToday : 1)),
    dateIso: ymdToIso(entry?.date ?? today),
    period: entry?.period != null ? String(entry.period) : '',
    start: entry?.start ?? '',
    end: entry?.end ?? '',
    roomName: entry?.roomName ?? '',
    memo: entry?.memo ?? '',
    linkCourseId: entry?.linkedCourseId ?? '',
  }
}

function toDraft(v: FormValues): PersonalEntryDraft {
  return {
    title: v.title,
    kind: v.kind,
    weekday: v.kind === 'weekly' ? v.weekday : null,
    date: v.kind === 'once' ? v.dateIso : null,
    period: v.period === '' ? null : v.period,
    start: v.start || null,
    end: v.end || null,
    roomName: v.roomName,
    memo: v.memo,
    linkedCourseId: v.linkCourseId || null,
  }
}

/** 비교용 일정 모양(검증 전 입력값) */
function slotDraftOf(v: FormValues): EntrySlotDraft {
  const p = v.period === '' ? null : Number(v.period)
  const date = v.dateIso ? v.dateIso.replace(/-/g, '') : null
  return {
    kind: v.kind,
    weekday: v.kind === 'weekly' ? Number(v.weekday) || null : null,
    date: v.kind === 'once' && date && /^\d{8}$/.test(date) ? date : null,
    period: p != null && Number.isInteger(p) ? p : null,
    start: v.start || null,
    end: v.end || null,
    roomName: v.roomName.trim() || null,
    memo: v.memo.trim() || null,
  }
}

function NoteIcon({ tone }: { tone: LinkNote['tone'] }): JSX.Element {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: 'mt-0.5 h-3.5 w-3.5 shrink-0',
    'aria-hidden': true,
  }
  if (tone === 'ok') {
    return (
      <svg {...common}>
        <path d="m5 12 5 5 9-10" />
      </svg>
    )
  }
  if (tone === 'warn') {
    return (
      <svg {...common}>
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        <path d="M12 9v4M12 17h.01" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  )
}

/** 연결 전 확인: 직접 입력 ↔ 공식 수업(같은 요일 차시) 나란히 + 차이·겹침 안내 */
export function LinkPreview({
  title,
  entry,
  course,
  check,
}: {
  title: string
  entry: EntrySlotDraft
  course: Course
  check: LinkCheck
}): JSX.Element {
  const courseTitle = lessonTitle(course)
  const noteTone = { ok: 'text-emerald-900', warn: 'text-amber-900', info: 'text-sky-900' }
  return (
    <div role="group" aria-label="연결 전 확인" className="mt-3 rounded-xl bg-white p-3 ring-1 ring-emerald-100">
      <p className="text-xs font-semibold text-gray-700">연결 전 확인</p>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <div className="min-w-0 rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 p-2.5">
          <p className="text-[11px] font-semibold text-gray-500">직접 입력</p>
          <p className="mt-0.5 text-sm font-semibold text-gray-900 break-keep wrap-anywhere">{title.trim() || '제목 없음'}</p>
          <p className="mt-0.5 text-xs text-gray-700 break-keep wrap-anywhere">{entryWhenText(entry)}</p>
          <p className="text-xs text-gray-700 break-keep wrap-anywhere">{entryTimeText(entry)}</p>
          {entry.roomName && <p className="text-xs text-gray-600 break-keep wrap-anywhere">{entry.roomName}</p>}
        </div>
        <div className="min-w-0 rounded-lg border border-emerald-200 bg-emerald-50/60 p-2.5">
          <p className="text-[11px] font-semibold text-emerald-700">공식 수업</p>
          <p className="mt-0.5 text-sm font-semibold text-gray-900 break-keep wrap-anywhere">{courseTitle}</p>
          {check.sameDay.length ? (
            <ul className="mt-0.5 space-y-0.5">
              {check.sameDay.map((s) => (
                <li key={`${s.weekday}-${s.period}-${s.roomName ?? ''}`} className="text-xs text-gray-700 break-keep wrap-anywhere">
                  {slotText(s)}
                  {s.roomName ? ` · ${s.roomName}` : ''}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-0.5 text-xs text-gray-700 break-keep wrap-anywhere">
              {check.weekday ? `${weekdayShort(check.weekday)}요일 수업 없음` : '요일을 먼저 골라 주세요'}
            </p>
          )}
          {course.teacherNames.length > 0 && (
            <p className="text-xs text-gray-600 break-keep wrap-anywhere">{course.teacherNames.join(', ')} 선생님</p>
          )}
        </div>
      </div>
      {check.notes.length > 0 && (
        <ul className="mt-2 space-y-1">
          {check.notes.map((n) => (
            <li key={n.text} className={`flex items-start gap-1.5 text-xs leading-relaxed break-keep wrap-anywhere ${noteTone[n.tone]}`}>
              <NoteIcon tone={n.tone} />
              <span className="min-w-0">{n.text}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 rounded-lg bg-emerald-50 px-2.5 py-2 text-xs font-medium leading-relaxed text-emerald-900 break-keep">
        연결하면 공식 수업이 표시되고 메모만 붙어요 — 학교 변경이 자동 반영돼요.
      </p>
    </div>
  )
}

function FieldError({ id, text }: { id: string; text?: string }): JSX.Element | null {
  if (!text) return null
  return (
    <p id={id} className="mt-1 text-xs font-medium text-red-600 break-keep">
      <span aria-hidden="true">⚠️ </span>
      {text}
    </p>
  )
}

function Field({ label, htmlFor, children, hint }: { label: string; htmlFor: string; children: ReactNode; hint?: ReactNode }): JSX.Element {
  return (
    <div className="min-w-0">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-gray-700">
        {label}
      </label>
      {children}
      {hint}
    </div>
  )
}

export default function PersonalEntryForm({ uid, entry, mode = 'edit', payload, today, onDone, onCancel }: PersonalEntryFormProps): JSX.Element {
  const { toast, confirm } = useUI()
  const base = useId()
  const fid = (k: string) => `${base}-${k}`
  const linkOnly = mode === 'link' && !!entry
  const formRef = useRef<HTMLFormElement | null>(null)

  // 연결 선택지: 본인 활성 수강 수업(학생이 직접 고름) + 이미 연결돼 있지만 지금은 참여하지 않는 수업(유지·해제만)
  const linkable = useMemo<Course[]>(() => (payload ? linkableCourses(payload, today, uid) : []), [payload, today, uid])
  const linkableIds = useMemo(() => linkable.map((c) => c.courseId), [linkable])
  const options = useMemo<LinkOption[]>(() => {
    const out: LinkOption[] = linkable.map((c) => ({
      courseId: c.courseId,
      course: c,
      label: `${lessonTitle(c)}${c.teacherNames.length ? ` · ${c.teacherNames.join(', ')} 선생님` : ''}`,
      usable: true,
    }))
    const cur = entry?.linkedCourseId
    if (cur && !out.some((o) => o.courseId === cur)) {
      const c = payload?.courses.find((x) => x.courseId === cur) ?? null
      out.push({ courseId: cur, course: c, label: `${c ? lessonTitle(c) : '연결했던 수업'} (지금은 참여하지 않음)`, usable: false })
    }
    return out
  }, [linkable, entry?.linkedCourseId, payload])

  const [values, setValues] = useState<FormValues>(() => initialValues(entry, today))
  const [errors, setErrors] = useState<PersonalEntryErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState<boolean>(false)

  // 열릴 때 첫 입력칸으로(연결만 고를 때는 수업 선택)
  useEffect(() => {
    const el = formRef.current?.querySelector<HTMLElement>(linkOnly ? 'select[data-field="link"]' : 'input[data-field="title"]')
    formRef.current?.scrollIntoView({ block: 'nearest' })
    el?.focus({ preventScroll: true })
  }, [linkOnly])

  const set = <K extends keyof FormValues>(k: K, v: FormValues[K]): void => {
    setValues((prev) => ({ ...prev, [k]: v }))
    if (formError) setFormError(null)
  }

  const currentLink = entry?.linkedCourseId ?? null
  const selectedLink = values.linkCourseId || null
  const selectedIdx = selectedLink ? options.findIndex((o) => o.courseId === selectedLink) : -1
  const selected = selectedIdx >= 0 ? options[selectedIdx] : null
  const linkChanged = selectedLink !== currentLink
  const slotDraft = slotDraftOf(values)
  const check = selected && selected.course && payload && linkChanged ? checkLink(slotDraft, selected.course, payload, today, uid) : null
  const titleForPreview = linkOnly && entry ? entry.title : values.title

  const errorFor = (k: keyof PersonalEntryErrors): string | undefined => errors[k]
  const described = (k: keyof PersonalEntryErrors): string | undefined => (errors[k] ? fid(`${k}-err`) : undefined)

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (saving) return
    setFormError(null)
    const draft: PersonalEntryDraft = linkOnly && entry
      ? {
          title: entry.title,
          kind: entry.kind,
          weekday: entry.weekday ?? null,
          date: entry.date ?? null,
          period: entry.period ?? null,
          start: entry.start ?? null,
          end: entry.end ?? null,
          roomName: entry.roomName ?? null,
          memo: entry.memo ?? null,
          linkedCourseId: selectedLink,
        }
      : toDraft(values)
    const opts = { activeCourseIds: linkableIds }
    // 새로 연결하는 수업은 지금 참여 중인 수업이어야 함(이미 연결돼 있던 수업은 유지 가능)
    const v = validatePersonalEntry(draft, linkChanged && selectedLink ? opts : {})
    if (!v.ok) {
      setErrors(v.errors)
      const first = (['title', 'weekday', 'date', 'period', 'start', 'end', 'when', 'roomName', 'memo', 'linkedCourseId'] as const).find((k) => v.errors[k])
      const sel = first === 'linkedCourseId' ? 'select[data-field="link"]' : first ? `[data-field="${first === 'when' ? 'period' : first}"]` : null
      if (sel) formRef.current?.querySelector<HTMLElement>(sel)?.focus()
      return
    }
    setErrors({})

    const linking = linkChanged && !!selectedLink
    if (linking && selected) {
      const c = selected.course
      const name = c ? lessonTitle(c) : '이 수업'
      const ok = await confirm({
        title: `${name}에 연결할까요?`,
        description: `‘${draft.title}’ 대신 공식 수업 ‘${name}’이 시간표에 표시되고 메모만 붙어요. 학교 변경이 자동 반영돼요. 같은 수업이 맞는지 꼭 확인해 주세요.`,
        confirmText: '연결',
      })
      if (!ok) return
    }

    setSaving(true)
    let out: WriteOutcome
    try {
      out = entry
        ? linkOnly
          ? setPersonalEntryLink(uid, entry, selectedLink, opts)
          : updatePersonalEntry(uid, entry, draft, opts)
        : createPersonalEntry(uid, draft, opts)
    } catch (err) {
      setSaving(false)
      setFormError(personalWriteErrorText(errCode(err), linking, uid))
      return
    }
    if (!out.ok) {
      setSaving(false)
      setErrors(out.errors)
      return
    }
    if (out.changed && out.changed.length === 0) {
      setSaving(false)
      toast('바뀐 내용이 없어요')
      onDone({ entryId: out.entryId, pending: false, unchanged: true })
      return
    }
    const entryId = out.entryId
    const res = await waitForCommit(out.committed, (code) => {
      toast(`저장 대기였던 일정을 저장하지 못했어요 — ${personalWriteErrorText(code, linking, uid)}`, 'error')
    })
    if (res.kind === 'failed') {
      setSaving(false)
      setFormError(personalWriteErrorText(res.code, linking, uid))
      return
    }
    setSaving(false)
    if (res.kind === 'pending') {
      toast('저장 대기 — 인터넷에 연결되면 자동으로 저장돼요')
      onDone({ entryId, pending: true })
      return
    }
    if (linking) toast('공식 수업에 연결했어요 — 공식 수업이 표시되고 메모만 붙어요', 'success')
    else if (linkChanged && !selectedLink) toast('연결을 해제했어요 — 다시 직접 입력 일정으로 표시돼요', 'success')
    else toast(entry ? '고쳤어요' : '저장했어요', 'success')
    onDone({ entryId, pending: false })
  }

  const formLabel = linkOnly ? '공식 수업 연결' : entry ? '직접 입력 일정 수정' : '직접 입력 일정 추가'
  const noLinkable = !payload
    ? '참여 중인 수업 정보를 불러오지 못해 지금은 공식 수업에 연결할 수 없어요.'
    : options.length === 0
      ? '참여 중인 공식 수업이 없어 연결할 수 없어요. 초대 코드나 공식 수업 찾기로 먼저 참여해 주세요.'
      : null

  const linkSelect = (
    <div className="min-w-0">
      <label htmlFor={fid('link')} className="block text-sm font-medium text-gray-700">
        연결할 공식 수업 {linkOnly ? '' : <span className="font-normal text-gray-500">(선택)</span>}
      </label>
      {noLinkable ? (
        <p className="mt-1 rounded-lg bg-gray-50 px-3 py-2 text-xs leading-relaxed text-gray-600 ring-1 ring-gray-200 break-keep">{noLinkable}</p>
      ) : (
        <>
          <select
            id={fid('link')}
            data-field="link"
            value={selectedIdx >= 0 ? String(selectedIdx) : ''}
            onChange={(e) => set('linkCourseId', e.target.value === '' ? '' : options[Number(e.target.value)]?.courseId ?? '')}
            aria-invalid={errors.linkedCourseId ? true : undefined}
            aria-describedby={[fid('link-hint'), described('linkedCourseId')].filter(Boolean).join(' ')}
            className={`${inputCls} ${errors.linkedCourseId ? 'border-red-400' : 'border-gray-300'}`}
          >
            <option value="">연결하지 않음 (직접 입력으로 두기)</option>
            {options.map((o, i) => (
              <option key={o.courseId} value={String(i)}>
                {o.label}
              </option>
            ))}
          </select>
          <p id={fid('link-hint')} className="mt-1 text-xs leading-relaxed text-gray-500 break-keep">
            참여 중인 공식 수업만 고를 수 있어요. 이름이 같아도 자동으로 연결하지 않으니, 같은 수업일 때만 직접 골라 주세요.
          </p>
        </>
      )}
      <FieldError id={fid('linkedCourseId-err')} text={errorFor('linkedCourseId')} />
      {selected && !linkChanged && (
        <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium leading-relaxed text-emerald-900 break-keep">
          {selected.usable
            ? '연결됨 — 공식 수업이 표시되고 메모만 붙어요. 학교 변경이 자동 반영돼요.'
            : '연결했던 수업에 지금은 참여하지 않아 내 시간표에는 직접 입력 일정으로 보여요. 연결을 해제할 수 있어요.'}
        </p>
      )}
      {!selected && currentLink && (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium leading-relaxed text-amber-900 break-keep">
          연결을 해제하면 다시 ‘직접 입력 · 학교 시간표와 연결되지 않음’ 일정으로 보이고, 학교 변경이 자동으로 반영되지 않아요.
        </p>
      )}
      {check && selected?.course && <LinkPreview title={titleForPreview} entry={slotDraft} course={selected.course} check={check} />}
    </div>
  )

  return (
    <form
      ref={formRef}
      onSubmit={(e) => void onSubmit(e)}
      noValidate
      aria-label={formLabel}
      className="scroll-mt-20 space-y-4 rounded-xl bg-emerald-50/40 p-4 ring-1 ring-emerald-100"
    >
      <p className="text-sm font-bold text-gray-900">{formLabel}</p>

      {linkOnly && entry ? (
        <div className="rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 px-3 py-2.5">
          <p className="text-sm font-semibold text-gray-900 break-keep wrap-anywhere">{entry.title}</p>
          <p className="text-xs text-gray-700 break-keep wrap-anywhere">
            {entryWhenText({ kind: entry.kind, weekday: entry.weekday ?? null, date: entry.date ?? null })} · {entryTimeText({ period: entry.period ?? null, start: entry.start ?? null, end: entry.end ?? null })}
            {entry.roomName ? ` · ${entry.roomName}` : ''}
          </p>
          {entry.memo && <p className="mt-0.5 text-xs text-gray-600 break-keep wrap-anywhere">메모 {entry.memo}</p>}
        </div>
      ) : (
        <>
          <Field
            label="제목"
            htmlFor={fid('title')}
            hint={
              <>
                <p className="mt-1 flex justify-between gap-2 text-xs text-gray-500">
                  <span className="break-keep">예: 수학 보충, 방과후 코딩</span>
                  <span aria-hidden="true">
                    {values.title.trim().length}/{PERSONAL_LIMITS.titleMax}
                  </span>
                </p>
                <FieldError id={fid('title-err')} text={errorFor('title')} />
              </>
            }
          >
            <input
              id={fid('title')}
              data-field="title"
              type="text"
              value={values.title}
              maxLength={PERSONAL_LIMITS.titleMax + 10}
              onChange={(e) => set('title', e.target.value)}
              autoComplete="off"
              aria-invalid={errors.title ? true : undefined}
              aria-describedby={described('title')}
              className={`${inputCls} ${errors.title ? 'border-red-400' : 'border-gray-300'}`}
            />
          </Field>

          <fieldset className="min-w-0">
            <legend className="text-sm font-medium text-gray-700">반복</legend>
            <div className="mt-1 grid grid-cols-2 gap-2">
              {(
                [
                  { v: 'weekly', label: '매주' },
                  { v: 'once', label: '특정 날짜' },
                ] as const
              ).map((o) => (
                <label
                  key={o.v}
                  className={`flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold ring-1 transition-colors ${
                    values.kind === o.v ? 'bg-emerald-600 text-white ring-emerald-600' : 'bg-white text-gray-700 ring-gray-300 hover:bg-gray-50'
                  }`}
                >
                  <input
                    type="radio"
                    name={fid('kind')}
                    value={o.v}
                    checked={values.kind === o.v}
                    onChange={() => set('kind', o.v)}
                    className="h-4 w-4 accent-emerald-700"
                  />
                  {o.label}
                </label>
              ))}
            </div>
          </fieldset>

          {values.kind === 'weekly' ? (
            <Field label="요일" htmlFor={fid('weekday')} hint={<FieldError id={fid('weekday-err')} text={errorFor('weekday')} />}>
              <select
                id={fid('weekday')}
                data-field="weekday"
                value={values.weekday}
                onChange={(e) => set('weekday', e.target.value)}
                aria-invalid={errors.weekday ? true : undefined}
                aria-describedby={described('weekday')}
                className={`${inputCls} ${errors.weekday ? 'border-red-400' : 'border-gray-300'}`}
              >
                {WEEKDAYS.map((w) => (
                  <option key={w.v} value={String(w.v)}>
                    {w.label}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label="날짜" htmlFor={fid('date')} hint={<FieldError id={fid('date-err')} text={errorFor('date')} />}>
              <input
                id={fid('date')}
                data-field="date"
                type="date"
                value={values.dateIso}
                onChange={(e) => set('dateIso', e.target.value)}
                aria-invalid={errors.date ? true : undefined}
                aria-describedby={described('date')}
                className={`${inputCls} ${errors.date ? 'border-red-400' : 'border-gray-300'}`}
              />
            </Field>
          )}

          <fieldset className="min-w-0">
            <legend className="text-sm font-medium text-gray-700">시간</legend>
            <p className="mt-0.5 text-xs text-gray-500 break-keep">교시나 시작 시각 중 하나는 꼭 입력해 주세요.</p>
            <div className="mt-2">
              <Field label="교시" htmlFor={fid('period')} hint={<FieldError id={fid('period-err')} text={errorFor('period')} />}>
                <select
                  id={fid('period')}
                  data-field="period"
                  value={values.period}
                  onChange={(e) => set('period', e.target.value)}
                  aria-invalid={errors.period || errors.when ? true : undefined}
                  aria-describedby={[described('period'), errors.when ? fid('when-err') : undefined].filter(Boolean).join(' ') || undefined}
                  className={`${inputCls} ${errors.period || errors.when ? 'border-red-400' : 'border-gray-300'}`}
                >
                  <option value="">교시 없음</option>
                  {PERIODS.map((p) => {
                    const t = payload?.periodTimes.find((x) => x.period === p)
                    return (
                      <option key={p} value={String(p)}>
                        {p}교시{t ? ` (${t.start}~${t.end})` : ''}
                      </option>
                    )
                  })}
                </select>
              </Field>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Field label="시작 시각" htmlFor={fid('start')} hint={<FieldError id={fid('start-err')} text={errorFor('start')} />}>
                <input
                  id={fid('start')}
                  data-field="start"
                  type="time"
                  value={values.start}
                  onChange={(e) => set('start', e.target.value)}
                  aria-invalid={errors.start || errors.when ? true : undefined}
                  aria-describedby={described('start')}
                  className={`${inputCls} ${errors.start || errors.when ? 'border-red-400' : 'border-gray-300'}`}
                />
              </Field>
              <Field label="끝 시각" htmlFor={fid('end')} hint={<FieldError id={fid('end-err')} text={errorFor('end')} />}>
                <input
                  id={fid('end')}
                  data-field="end"
                  type="time"
                  value={values.end}
                  onChange={(e) => set('end', e.target.value)}
                  aria-invalid={errors.end ? true : undefined}
                  aria-describedby={described('end')}
                  className={`${inputCls} ${errors.end ? 'border-red-400' : 'border-gray-300'}`}
                />
              </Field>
            </div>
            <FieldError id={fid('when-err')} text={errorFor('when')} />
          </fieldset>

          <Field
            label="교실 (선택)"
            htmlFor={fid('room')}
            hint={<FieldError id={fid('roomName-err')} text={errorFor('roomName')} />}
          >
            <input
              id={fid('room')}
              data-field="roomName"
              type="text"
              value={values.roomName}
              maxLength={PERSONAL_LIMITS.roomMax + 10}
              onChange={(e) => set('roomName', e.target.value)}
              autoComplete="off"
              placeholder="예: 수학실"
              aria-invalid={errors.roomName ? true : undefined}
              aria-describedby={described('roomName')}
              className={`${inputCls} ${errors.roomName ? 'border-red-400' : 'border-gray-300'}`}
            />
          </Field>

          <Field
            label="메모 (선택)"
            htmlFor={fid('memo')}
            hint={
              <>
                <p className="mt-1 text-right text-xs text-gray-500" aria-hidden="true">
                  {values.memo.trim().length}/{PERSONAL_LIMITS.memoMax}
                </p>
                <FieldError id={fid('memo-err')} text={errorFor('memo')} />
              </>
            }
          >
            <textarea
              id={fid('memo')}
              data-field="memo"
              value={values.memo}
              rows={2}
              maxLength={PERSONAL_LIMITS.memoMax + 20}
              onChange={(e) => set('memo', e.target.value)}
              aria-invalid={errors.memo ? true : undefined}
              aria-describedby={described('memo')}
              className={`${inputCls} ${errors.memo ? 'border-red-400' : 'border-gray-300'} resize-y`}
            />
          </Field>
        </>
      )}

      {linkSelect}

      {!linkOnly && !selected && !currentLink && (
        <p className="rounded-lg bg-white px-3 py-2 text-xs leading-relaxed text-gray-600 ring-1 ring-gray-200 break-keep">
          직접 입력한 일정은 ‘직접 입력 · 학교 시간표와 연결되지 않음’으로 표시돼요. 선생님이 시간표를 바꿔도 자동으로 바뀌지 않아요.
        </p>
      )}

      {formError && (
        <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800 break-keep">
          <span aria-hidden="true">⚠️ </span>
          {formError}
        </p>
      )}

      <div className="flex gap-2">
        <button type="button" onClick={onCancel} disabled={saving} className={`${btnGhost} flex-1`}>
          취소
        </button>
        <button type="submit" disabled={saving || (linkOnly && (!selected || !linkChanged))} className={`${btnPrimary} flex-1`}>
          {saving ? '저장 중…' : linkOnly ? (selectedLink || !linkChanged ? '이 수업에 연결' : '연결 해제') : '저장'}
        </button>
      </div>
    </form>
  )
}
