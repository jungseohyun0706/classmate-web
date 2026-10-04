import { useEffect, useId, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import {
  activeOrPendingIds,
  buildPickerGrid,
  cartConflicts,
  catalogEmptyState,
  cellKey,
  filterForStudent,
  myCourseIds,
  pickerTitle,
  type CartConflict,
  type GridCell,
  type MyCourseState,
  type MyLesson,
  type PickerCourse,
  type PickerSlot,
  type PickResult,
} from '../../lib/timetable/coursePicker'
import { catalogLoadErrorText, type CatalogState } from '../../lib/timetable/pickerClient'

/**
 * 학생 '수업 담기(학교 수업 목록에서 고르기)' — 학교가 공개한 공식 수업을 골라 담는 화면(요구 R20)
 *  - 시간표 칸 보기: 요일 × 교시 칸. 칸을 누르면 그 시간에 열리는 수업(제목·분반·선생님·교실)이 보이고 거기서 담음.
 *    칸에는 이미 내 시간표에 있는 수업(참여·시작 예정·승인 대기·반 공통)과 담은 수업이 표시됨
 *  - 과목으로 찾기: 과목명 검색 목록(검색은 목록만 좁힘 — 이름이 같다고 자동으로 담지 않음)
 *  - 기본은 내 학년·반 수업(서버가 정한 offer 'mine' — 대상 반·학년을 정하지 않은 수업 포함) + 이미 내 것인 수업.
 *    '다른 반·학년 수업도 보기'로 다른 반·학년의 여러 반(선택·이동) 수업·다른 학년 수업도. 다른 반의 반별 수업은 서버가 보내지 않아
 *    보기를 켜도 없음(그 반의 정규 수업)
 *  - 빈 화면 구분: 학교에 공개 수업이 없음 / 내 학년·반 수업이 없음('다른 반·학년 수업도 보기' 버튼) / 요일·교시가 등록된 수업이 없음
 *  - 390px: 칸 버튼은 44×44 이상 — 토·일까지 7칸이면 표가 자기 상자 안에서만 옆으로 밀리고(교시 열 고정) 화면은 옆으로 밀리지 않음
 *  - 담은 수업(장바구니): 같은 요일·교시 겹침(담은 수업끼리, 이미 듣는 수업과)을 경고로 보여 줌 — 그대로 담거나 뺄 수 있음
 *  - '내 시간표에 담기' → 화면(부모)이 확인 시트를 띄우고 한 번에 요청(requestMany) → 수업마다 결과
 *    (추가됨 / 선생님 승인 대기 / 이미 있음 / 담지 못함 + 이유)
 *  - 내가 직접 담은 수업(출처 신청)은 '빼기', 학교가 넣어 준 수업은 '선생님께 문의' 안내
 * 내부 id(courseId)는 화면·DOM 속성에 내놓지 않습니다(목록 key로만 씀).
 */

const WD = ['', '월', '화', '수', '목', '금', '토', '일']

export type PickerView = 'grid' | 'list'

/** 화면에 보이는 내 상태: 참여 중(시작 예정·반 공통 포함) / 승인 대기 / 끝남 / 없음 */
export type ShownStatus = 'active' | 'pending' | 'ended' | null

export interface CoursePickerProps {
  catalog: CatalogState
  /** 이전 목록을 보이며 다시 받는 중 */
  refreshing?: boolean
  onReloadCatalog: () => void
  /** 내 시간표 자료로 계산한 이미 있는 수업의 요일·교시(칸 표시·겹침 경고 — 아직 못 받았으면 null) */
  mine: MyLesson[] | null
  /**
   * 내 시간표 자료로 계산한 수업별 내 상태·출처(myCourseStates — 차시 없는 수업·끝낸 수강 포함).
   * 아직 못 받았으면 null — 목록 응답의 myStatus를 씀
   */
  myStates: Map<string, MyCourseState> | null
  /**
   * 담은 수업 한 번에 담기(부모: 확인 시트 → requestMany → 내 시간표 다시 받기).
   * 수업마다 결과 / 요청 전체 실패면 { error } / 취소면 null
   */
  onSubmit: (picks: PickerCourse[], conflicts: CartConflict[]) => Promise<PickResult[] | { error: string } | null>
  /** 내가 직접 담은 수업 빼기(부모: 확인 시트 → leave). pending이면 '신청 취소' 문구 */
  onLeave: (courseId: string, title: string, pending: boolean) => Promise<void>
  /** 다른 요청(빼기 등) 중 */
  busy?: boolean
}

const btnPrimary =
  'inline-flex min-h-11 items-center justify-center rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-1 disabled:opacity-60'
const btnSecondary =
  'inline-flex min-h-11 items-center justify-center rounded-xl bg-white px-4 text-sm font-semibold text-emerald-700 ring-1 ring-emerald-200 transition-colors hover:bg-emerald-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:opacity-60'
const btnSmall =
  'inline-flex min-h-11 items-center justify-center rounded-xl bg-white px-3 text-xs font-semibold text-gray-700 ring-1 ring-gray-300 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:opacity-60'

export function slotsText(slots: PickerSlot[]): string {
  if (!slots.length) return '아직 등록된 시간표가 없어요'
  const rooms = Array.from(new Set(slots.map((s) => s.roomName).filter((r): r is string => !!r)))
  if (rooms.length <= 1) return `${slots.map((s) => `${WD[s.weekday]} ${s.period}교시`).join(', ')}${rooms[0] ? ` · ${rooms[0]}` : ''}`
  return slots.map((s) => `${WD[s.weekday]} ${s.period}교시${s.roomName ? `(${s.roomName})` : ''}`).join(', ')
}

function teacherText(names: string[]): string {
  return names.length ? `${names.join(', ')} 선생님` : '담당 선생님 정보 없음'
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, '')

/** '3-4' → '3학년 4반' */
const labelKo = (l: string): string => {
  const [g, c] = l.split('-')
  return `${g}학년 ${c}반`
}

/** 대상 반 표시: '3-4반' / '3-4·3-5반' */
function classesText(labels: string[]): string {
  return `${labels.join('·')}반`
}

/** 칸 표 최소 너비: 교시 열(1.5rem) + 요일마다 44px 버튼 + 칸 사이(2px) — 이보다 좁으면 표 상자 안에서만 옆으로 밀림 */
export function gridMinWidthPx(days: number): number {
  return 24 + days * 44 + (days + 2) * 2
}

function Pill({ tone, children }: { tone: 'emerald' | 'amber' | 'sky' | 'gray' | 'white' | 'rose'; children: ReactNode }): JSX.Element {
  const cls = {
    emerald: 'bg-emerald-100 text-emerald-800 ring-emerald-200 font-bold',
    amber: 'bg-amber-50 text-amber-800 ring-amber-200 font-bold',
    sky: 'bg-sky-50 text-sky-800 ring-sky-200 font-semibold',
    gray: 'bg-gray-100 text-gray-700 ring-gray-200 font-semibold',
    white: 'bg-white text-gray-700 ring-gray-300 font-medium',
    rose: 'bg-rose-50 text-rose-800 ring-rose-200 font-bold',
  }[tone]
  return <span className={`inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-[11px] ring-1 break-keep ${cls}`}>{children}</span>
}

function sourceNote(source: MyCourseState['source']): string {
  if (source === 'common') return '반 공통 수업 · 바꾸려면 선생님께 문의'
  if (source === 'request') return '내가 담은 수업'
  return '학교에서 넣어 준 수업 · 빼려면 선생님께 문의'
}

/** 수업 카드(칸 목록·과목 목록 공통) */
function CourseCard({
  c,
  status,
  source,
  inCart,
  notice,
  disabled,
  onToggle,
  onLeave,
}: {
  c: PickerCourse
  status: ShownStatus
  /** 지금 내 수업이면 출처(모르면 null) — '빼기'는 'request'만 */
  source: MyCourseState['source'] | null
  inCart: boolean
  /** 방금 담은 결과 — 지금 상태와 같을 때만 안내 */
  notice: 'active' | 'pending' | null
  disabled: boolean
  onToggle: () => void
  onLeave: () => void
}): JSX.Element {
  const title = pickerTitle(c)
  const canPick = status === null || status === 'ended'
  return (
    <article aria-label={title} className={`rounded-xl border bg-white px-4 py-3 ${inCart ? 'border-sky-300 ring-1 ring-sky-200' : 'border-gray-200'}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold text-gray-900 break-keep wrap-anywhere">{title}</h3>
          <p className="mt-0.5 text-xs text-gray-600 break-keep wrap-anywhere">
            과목 {c.subject || c.title}
            {c.section ? ` · 분반 ${c.section}` : ''}
            {c.classLabels.length ? ` · ${classesText(c.classLabels)}` : c.grades.length ? ` · ${c.grades.map((g) => `${g}학년`).join(', ')}` : ''}
          </p>
          <p className="text-xs text-gray-600 break-keep wrap-anywhere">{teacherText(c.teacherNames)}</p>
          <p className="text-xs text-gray-600 break-keep wrap-anywhere">{slotsText(c.slots)}</p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {c.invitePolicy === 'approval' ? <Pill tone="white">선생님 승인 필요</Pill> : <Pill tone="sky">바로 담기</Pill>}
            {c.offer === 'other' && status !== 'active' && status !== 'pending' && <Pill tone="gray">다른 반·학년 수업</Pill>}
            {status === 'active' && <Pill tone="emerald">참여 중</Pill>}
            {status === 'pending' && <Pill tone="amber">승인 대기</Pill>}
            {inCart && <Pill tone="sky">담음</Pill>}
          </div>
          {notice && status === notice && (
            <p role="status" className={`mt-2 rounded-lg px-3 py-2 text-xs font-semibold break-keep ${notice === 'active' ? 'bg-emerald-50 text-emerald-900' : 'bg-amber-50 text-amber-900'}`}>
              {notice === 'active' ? '내 시간표에 추가됐어요' : '선생님 승인을 기다려요'}
            </p>
          )}
          {source && status !== null && status !== 'ended' && source !== 'request' && <p className="mt-1.5 text-xs text-gray-500 break-keep">{sourceNote(source)}</p>}
        </div>
        <div className="flex shrink-0 flex-col gap-1">
          {canPick && (
            <button
              type="button"
              onClick={onToggle}
              disabled={disabled}
              aria-pressed={inCart}
              aria-label={`${title} ${inCart ? '담기 취소' : status === 'ended' ? '다시 담기' : '담기'}`}
              className={inCart ? `${btnSmall} px-3` : `${btnPrimary} px-3`}
            >
              {inCart ? '담기 취소' : status === 'ended' ? '다시 담기' : '담기'}
            </button>
          )}
          {!canPick && source === 'request' && (
            <button type="button" onClick={onLeave} disabled={disabled} aria-label={`${title} 빼기`} className={btnSmall}>
              빼기
            </button>
          )}
        </div>
      </div>
    </article>
  )
}

export default function CoursePicker({ catalog, refreshing, onReloadCatalog, mine, myStates, onSubmit, onLeave, busy }: CoursePickerProps): JSX.Element {
  const searchId = useId()
  const hintId = useId()
  const panelId = useId()
  const gradeId = useId()
  const [view, setView] = useState<PickerView>('grid')
  /** '다른 반·학년 수업도 보기' */
  const [showOthers, setShowOthers] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [cart, setCart] = useState<string[]>([])
  const [cartOpen, setCartOpen] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [results, setResults] = useState<Array<PickResult & { title: string }> | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  /**
   * 방금 담은 결과 — 내 시간표 자료(myStates)가 그 수업을 다시 알려 줄 때까지만 상태로 씀(아래 effect가 지움).
   * 그 뒤로는 내 시간표 자료가 기준이라, 이번에 담았다가 빼거나 선생님이 거절해도 상태가 남지 않음
   */
  const [recent, setRecent] = useState<Record<string, 'active' | 'pending'>>({})
  /** 방금 담은 결과 안내('내 시간표에 추가됐어요' 등) — 지금 상태와 같을 때만 보임(빼면 자연히 사라짐) */
  const [notice, setNotice] = useState<Record<string, 'active' | 'pending'>>({})
  const panelRef = useRef<HTMLDivElement | null>(null)
  const cartRef = useRef<HTMLElement | null>(null)
  /** 담은 수업 막대 높이(보일 때만) — 칸 목록·포커스가 막대 뒤로 숨지 않게 */
  const [cartH, setCartH] = useState(0)

  const all = useMemo(() => (catalog.status === 'ready' ? catalog.courses : []), [catalog])
  const me = catalog.status === 'ready' ? catalog.me : null
  const withheld = catalog.status === 'ready' ? catalog.withheld : 0
  const byId = useMemo(() => new Map(all.map((c) => [c.courseId, c] as const)), [all])
  const mineList = useMemo(() => mine || [], [mine])
  const mineIds = useMemo(() => myCourseIds(mineList), [mineList])
  // 거르기와 상관없이 내 것으로 보이는 수업: 칸에 있는 내 수업 + 내 시간표 자료의 참여·승인 대기(차시 없는 수업 포함) + 방금 담은 수업
  const keepIds = useMemo(() => {
    const out = activeOrPendingIds(myStates)
    mineIds.forEach((id) => out.add(id))
    Object.keys(recent).forEach((id) => out.add(id))
    return out
  }, [myStates, mineIds, recent])
  const { shown, hidden } = useMemo(() => filterForStudent(all, showOthers, keepIds), [all, showOthers, keepIds])
  const empty = catalogEmptyState({ total: all.length, withheld, shown: shown.length, hidden, showAll: showOthers })
  const grid = useMemo(() => buildPickerGrid(shown, mineList), [shown, mineList])
  const picks = useMemo(() => cart.map((id) => byId.get(id)).filter((c): c is PickerCourse => !!c), [cart, byId])
  const conflicts = useMemo(() => cartConflicts(picks, mineList), [picks, mineList])
  const conflictIds = useMemo(() => new Set(conflicts.flatMap((x) => x.courseIds)), [conflicts])
  const conflictCells = useMemo(() => new Set(conflicts.map((x) => cellKey(x.weekday, x.period))), [conflicts])
  const noSlotCount = shown.filter((c) => !c.slots.length).length

  // 목록이 바뀌어 없어진 수업은 장바구니에서 뺌(학교가 공개를 끄거나 끝낸 수업)
  useEffect(() => {
    if (catalog.status !== 'ready') return
    setCart((prev) => {
      const next = prev.filter((id) => byId.has(id))
      return next.length === prev.length ? prev : next
    })
  }, [catalog.status, byId])

  // 내 시간표 자료가 새로 와서 그 수업을 알려 주면(어떤 상태든) 방금 담은 결과 대신 그 자료를 씀
  useEffect(() => {
    if (!myStates) return
    setRecent((prev) => {
      const ids = Object.keys(prev)
      const keep = ids.filter((id) => !myStates.has(id))
      if (keep.length === ids.length) return prev
      const next: Record<string, 'active' | 'pending'> = {}
      keep.forEach((id) => (next[id] = prev[id]))
      return next
    })
  }, [myStates])

  /**
   * 화면 상태: 방금 담은 결과(내 시간표 자료가 아직 모를 때만) → 내 시간표 자료(차시 없는 수업·끝낸 수강 포함) →
   * 목록 응답의 myStatus(내 시간표 자료를 아직 못 받았거나, 그 자료에 이 수업 기록이 없을 때 — 목록이 더 최신)
   */
  const statusOf = (c: PickerCourse): ShownStatus => {
    const r = recent[c.courseId]
    if (r) return r
    const s = myStates ? myStates.get(c.courseId) : undefined
    if (s) return s.status
    return c.myStatus
  }
  /** '빼기'·출처 안내용 출처: 방금 담은 수업은 'request', 아니면 내 시간표 자료(지금 내 수업일 때만) */
  const sourceOf = (c: PickerCourse): MyCourseState['source'] | null => {
    if (recent[c.courseId]) return 'request'
    const s = myStates ? myStates.get(c.courseId) : undefined
    return s && s.status !== 'ended' ? s.source : null
  }

  const toggle = (c: PickerCourse): void => {
    setResults(null)
    setSubmitError(null)
    setCart((prev) => (prev.includes(c.courseId) ? prev.filter((x) => x !== c.courseId) : prev.length >= 20 ? prev : prev.concat(c.courseId)))
    setCartOpen(true)
  }

  const pickCell = (k: string): void => {
    setSelected((cur) => (cur === k ? null : k))
  }
  useEffect(() => {
    if (!selected) return
    const raf = window.requestAnimationFrame(() => panelRef.current?.scrollIntoView({ block: 'nearest' }))
    return () => window.cancelAnimationFrame(raf)
  }, [selected])

  // 담은 수업 막대 높이 — 보이는 동안만 잼(내용이 바뀌면 다시)
  const cartShown = cart.length > 0 || !!results
  useEffect(() => {
    const el = cartRef.current
    if (!cartShown || !el) return
    const update = (): void => setCartH(Math.ceil(el.getBoundingClientRect().height))
    update()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [cartShown])
  const barH = cartShown ? cartH : 0
  // 막대가 보이는 동안 문서 아래쪽 scroll-padding: 키보드로 옮겨 간 칸·버튼이 화면 아래 붙은 막대 뒤로 숨지 않게(사라지면 되돌림)
  useEffect(() => {
    if (!barH) return
    const root = document.documentElement
    const prev = root.style.scrollPaddingBottom
    root.style.scrollPaddingBottom = `${barH + 8}px`
    return () => {
      root.style.scrollPaddingBottom = prev
    }
  }, [barH])

  const submit = async (): Promise<void> => {
    if (!picks.length || submitting) return
    setSubmitting(true)
    setSubmitError(null)
    const out = await onSubmit(picks, conflicts)
    setSubmitting(false)
    if (!out) return
    if (!Array.isArray(out)) {
      // 요청 전체 실패 — 장바구니는 그대로(다시 시도하거나 뺄 수 있게)
      setSubmitError(out.error)
      return
    }
    const titled = out.map((r) => ({ ...r, title: byId.get(r.courseId) ? pickerTitle(byId.get(r.courseId) as PickerCourse) : '수업' }))
    setResults(titled)
    const nextRecent: Record<string, 'active' | 'pending'> = {}
    out.forEach((r) => {
      if (r.kind === 'added') nextRecent[r.courseId] = 'active'
      if (r.kind === 'pending') nextRecent[r.courseId] = 'pending'
    })
    setRecent((prev) => ({ ...prev, ...nextRecent }))
    setNotice((prev) => ({ ...prev, ...nextRecent }))
    // 담긴(또는 이미 있던) 수업은 장바구니에서 빼고, 담지 못한 수업만 남김(다시 시도하거나 뺄 수 있게)
    const failed = new Set(out.filter((r) => r.kind === 'failed').map((r) => r.courseId))
    setCart((prev) => prev.filter((id) => failed.has(id)))
  }

  const disabled = !!busy || submitting
  const q = norm(query)
  const matches = (c: PickerCourse): boolean => norm(`${c.title} ${c.subject}`).includes(q)
  const listShown = q ? shown.filter(matches) : shown
  // 검색어와 맞지만 기본 보기에서 숨긴(다른 반·학년) 수업 수 — '다른 반·학년 수업도 보기' 안내
  const hiddenMatches = q && !showOthers ? all.filter(matches).length - listShown.length : 0

  /** 내 학년·반 수업이 없을 때(공개 수업은 있음) — 칸 보기·과목으로 찾기 공통 */
  const noMineBox = (canShowOthers: boolean): JSX.Element => (
    <div role="status" className="rounded-xl bg-gray-50 px-4 py-5 text-center ring-1 ring-gray-100">
      <p className="text-sm font-semibold text-gray-900 break-keep">내 학년·반 수업이 아직 없어요</p>
      <p className="mt-1 text-xs leading-relaxed text-gray-500 break-keep">
        {canShowOthers
          ? `다른 반·학년 수업 ${hidden}개가 공개돼 있어요. 선택·이동 수업이면 아래 버튼을 눌러 찾아 담을 수 있어요.`
          : me && me.classLabel === null && withheld > 0
            ? '내 반 정보가 없어 반별 수업이 보이지 않아요. 담임 선생님의 학급 초대로 소속 학급을 등록해 주세요.'
            : '다른 반의 반별 수업은 그 반 학생만 담을 수 있어요. 선생님께 받은 초대 코드로 참여하거나, 학교 밖 일정은 직접 입력할 수 있어요.'}
      </p>
      {canShowOthers && (
        <button type="button" onClick={() => setShowOthers(true)} className={`${btnSecondary} mt-3`}>
          다른 반·학년 수업도 보기
        </button>
      )}
    </div>
  )
  const selCell: GridCell | null = selected ? grid.cells[selected] || null : null

  const conflictText = (x: CartConflict): string => {
    const where = `${WD[x.weekday]} ${x.period}교시`
    const names = x.courseIds.map((id) => (byId.get(id) ? pickerTitle(byId.get(id) as PickerCourse) : '수업')).join(', ')
    if (x.kind === 'picks') return `${where}: 담은 수업끼리 겹쳐요 (${names})`
    const mineNames = x.mine.map((m) => `${m.title}${m.status === 'pending' ? '(승인 대기)' : ''}`).join(', ')
    return `${where}: 이미 있는 내 수업(${mineNames})과 겹쳐요 — ${names}`
  }

  const card = (c: PickerCourse): JSX.Element => (
    <CourseCard
      c={c}
      status={statusOf(c)}
      source={sourceOf(c)}
      inCart={cart.includes(c.courseId)}
      notice={notice[c.courseId] ?? null}
      disabled={disabled}
      onToggle={() => toggle(c)}
      onLeave={() => void onLeave(c.courseId, pickerTitle(c), statusOf(c) === 'pending')}
    />
  )

  if (catalog.status === 'loading') {
    return (
      <div className="animate-pulse space-y-2" role="status" aria-label="학교 수업 목록을 불러오는 중">
        <div className="h-10 rounded-xl bg-gray-100" />
        <div className="h-48 rounded-xl bg-gray-100" />
      </div>
    )
  }
  if (catalog.status === 'error') {
    const t = catalogLoadErrorText(catalog.failure)
    return (
      <div role="alert" className="rounded-xl bg-rose-50 px-4 py-4 ring-1 ring-rose-200">
        <p className="text-sm font-semibold text-gray-900 break-keep wrap-anywhere">{t.title}</p>
        {t.desc && <p className="mt-1 text-xs leading-relaxed text-gray-600 break-keep">{t.desc}</p>}
        <button type="button" onClick={onReloadCatalog} className={`${btnPrimary} mt-3`}>
          다시 시도
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* 보기 전환 + 학년 */}
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="보기 방식" className="inline-flex rounded-xl bg-gray-100 p-1">
          {(
            [
              ['grid', '시간표 칸 보기'],
              ['list', '과목으로 찾기'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={`min-h-11 rounded-lg px-3 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
                view === v ? 'bg-white text-emerald-800 shadow-sm' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {refreshing && (
          <span role="status" className="text-xs text-gray-500">
            새로 고치는 중…
          </span>
        )}
      </div>

      <div className="text-xs text-gray-600 break-keep" aria-live="polite">
        {catalog.term ? `${catalog.term.name} · ` : ''}
        {showOthers || !me || (me.grade === null && me.classLabel === null)
          ? `학교가 공개한 수업 ${shown.length}개`
          : me.classLabel
            ? `내 학년·반(${labelKo(me.classLabel)}) 수업 ${shown.length}개`
            : `내 학년(${me.grade}학년) 수업 ${shown.length}개`}
        {hidden > 0 ? ` · 다른 반·학년 수업 ${hidden}개 숨김` : ''}
      </div>
      {(hidden > 0 || showOthers) && (
        <label htmlFor={gradeId} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-gray-700">
          <input id={gradeId} type="checkbox" checked={showOthers} onChange={(e) => setShowOthers(e.target.checked)} className="h-5 w-5 accent-emerald-600" />
          다른 반·학년 수업도 보기
        </label>
      )}
      {withheld > 0 && me && me.classLabel === null && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200 break-keep">
          내 반 정보가 없어 반별 수업(한 반만 듣는 수업)은 보이지 않아요. 담임 선생님의 학급 초대로 소속 학급을 등록하면 우리 반 수업이 보여요.
        </p>
      )}

      {empty?.kind === 'no-public' ? (
        <div role="status" className="rounded-xl bg-gray-50 px-4 py-5 text-center ring-1 ring-gray-100">
          <p className="text-sm font-semibold text-gray-900 break-keep">지금 학교에 공개된 수업이 없어요</p>
          <p className="mt-1 text-xs leading-relaxed text-gray-500 break-keep">
            선생님께 받은 초대 코드로 참여하거나, 학교 밖 일정은 직접 입력할 수 있어요.
          </p>
        </div>
      ) : view === 'grid' ? (
        <div className="space-y-2">
          {empty?.kind === 'no-mine' ? (
            noMineBox(empty.canShowOthers)
          ) : (
            grid.periods.length === 0 && (
              <p role="status" className="rounded-xl bg-gray-50 px-4 py-4 text-center text-sm text-gray-600 ring-1 ring-gray-100 break-keep">
                요일·교시가 등록된 수업이 아직 없어요 — &lsquo;과목으로 찾기&rsquo;에서 볼 수 있어요.
              </p>
            )
          )}
          {grid.periods.length > 0 && (
            // 칸 버튼은 44×44 이상: 요일이 많아(토·일) 상자보다 넓으면 이 상자 안에서만 옆으로 밀리고 교시 열은 고정(화면은 옆으로 밀리지 않음)
            <div className="-mx-1 overflow-x-auto overscroll-x-contain px-1 pb-1" data-testid="picker-grid-scroll">
              <table
                className="w-full table-fixed border-separate border-spacing-0.5"
                style={{ minWidth: `${gridMinWidthPx(grid.weekdays.length)}px` }}
                aria-label="수업 담기 시간표 칸"
              >
                <thead>
                  <tr>
                    <th scope="col" className="sticky left-0 z-[1] w-6 bg-white text-[11px] font-medium text-gray-400">
                      <span className="sr-only">교시</span>
                    </th>
                    {grid.weekdays.map((w) => (
                      <th key={w} scope="col" className="py-1 text-xs font-semibold text-gray-600">
                        {WD[w]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {grid.periods.map((p) => (
                    <tr key={p}>
                      <th scope="row" className="sticky left-0 z-[1] bg-white text-center text-xs font-semibold text-gray-500">
                        {p}
                        <span className="sr-only">교시</span>
                      </th>
                      {grid.weekdays.map((w) => {
                        const k = cellKey(w, p)
                        const cell = grid.cells[k]
                        const mineHere = cell ? cell.mine : []
                        const offered = cell ? cell.offered : []
                        const others = offered.filter((c) => !mineIds.has(c.courseId) && statusOf(c) !== 'active' && statusOf(c) !== 'pending')
                        const picked = offered.filter((c) => cart.includes(c.courseId))
                        const conflict = conflictCells.has(k)
                        const isSel = selected === k
                        if (!mineHere.length && !offered.length) {
                          return (
                            <td key={w} className="p-0">
                              <span aria-hidden="true" className="block h-14 rounded-md bg-gray-50" />
                            </td>
                          )
                        }
                        const first = mineHere[0]
                        const tone = conflict
                          ? 'bg-rose-50 ring-rose-300'
                          : picked.length
                            ? 'bg-sky-50 ring-sky-300'
                            : first
                              ? first.status === 'pending'
                                ? 'bg-amber-50 ring-amber-200'
                                : 'bg-emerald-50 ring-emerald-200'
                              : 'bg-white ring-gray-200'
                        const label = [
                          `${WD[w]}요일 ${p}교시`,
                          mineHere.length ? `내 수업 ${mineHere.map((m) => `${m.title}${m.status === 'pending' ? '(승인 대기)' : ''}`).join(', ')}` : '',
                          picked.length ? `담은 수업 ${picked.map((c) => pickerTitle(c)).join(', ')}` : '',
                          others.length ? `고를 수 있는 수업 ${others.length}개` : '',
                          conflict ? '겹침' : '',
                        ]
                          .filter(Boolean)
                          .join(' · ')
                        return (
                          <td key={w} className="p-0">
                            <button
                              type="button"
                              onClick={() => pickCell(k)}
                              aria-label={label}
                              aria-expanded={isSel}
                              aria-controls={isSel ? panelId : undefined}
                              className={`flex h-14 w-full min-w-11 flex-col items-stretch justify-between rounded-md px-1 py-1 text-left ring-1 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 ${tone} ${
                                isSel ? 'outline-2 -outline-offset-2 outline-emerald-600' : ''
                              }`}
                            >
                              <span className="block min-w-0 truncate text-[11px] font-semibold leading-tight text-gray-900">
                                {first ? first.title : picked[0] ? pickerTitle(picked[0]) : ''}
                              </span>
                              <span className="flex min-w-0 items-center gap-0.5 text-[10px] leading-tight">
                                {/* 좁은 칸이라 한 가지만: 겹침 > 담음 > 승인 대기 */}
                                {conflict ? (
                                  <span className="truncate font-bold text-rose-700">겹침</span>
                                ) : picked.length > 0 ? (
                                  <span className="truncate font-semibold text-sky-800">담음</span>
                                ) : first?.status === 'pending' ? (
                                  <span className="truncate font-semibold text-amber-800">대기</span>
                                ) : null}
                                {others.length > picked.length && (
                                  <span className="ml-auto shrink-0 rounded bg-white px-1 font-semibold text-gray-600 ring-1 ring-gray-200">+{others.length - picked.length}</span>
                                )}
                              </span>
                            </button>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {grid.periods.length > 0 && grid.weekdays.length >= 7 && (
            <p className="text-[11px] text-gray-500 break-keep sm:hidden">좁은 화면에서는 표를 옆으로 밀면 주말 칸이 보여요.</p>
          )}
          {grid.periods.length > 0 && (
            <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-600" aria-label="칸 표시 안내">
              <li className="flex items-center gap-1">
                <span aria-hidden="true" className="h-3 w-3 rounded-sm bg-emerald-50 ring-1 ring-emerald-200" />내 수업
              </li>
              <li className="flex items-center gap-1">
                <span aria-hidden="true" className="h-3 w-3 rounded-sm bg-amber-50 ring-1 ring-amber-200" />승인 대기
              </li>
              <li className="flex items-center gap-1">
                <span aria-hidden="true" className="h-3 w-3 rounded-sm bg-sky-50 ring-1 ring-sky-300" />담음
              </li>
              <li className="flex items-center gap-1">
                <span aria-hidden="true" className="h-3 w-3 rounded-sm bg-rose-50 ring-1 ring-rose-300" />겹침
              </li>
              <li>+숫자: 고를 수 있는 수업</li>
            </ul>
          )}
          {noSlotCount > 0 && (
            <p className="text-xs text-gray-500 break-keep">요일·교시가 아직 없는 수업 {noSlotCount}개는 &lsquo;과목으로 찾기&rsquo;에서 볼 수 있어요.</p>
          )}

          {selCell && selected && (
            <div
              ref={panelRef}
              id={panelId}
              role="region"
              aria-label={`${WD[selCell.weekday]}요일 ${selCell.period}교시 수업`}
              className="scroll-mt-20 space-y-2 rounded-xl bg-gray-50 p-3 ring-1 ring-gray-200"
              style={barH ? { scrollMarginBottom: `${barH + 8}px` } : undefined}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-bold text-gray-900">
                  {WD[selCell.weekday]}요일 {selCell.period}교시
                </p>
                <button type="button" onClick={() => setSelected(null)} className={btnSmall} aria-label="칸 닫기">
                  닫기
                </button>
              </div>
              {selCell.mine
                .filter((m) => !selCell.offered.some((c) => c.courseId === m.courseId))
                .map((m) => (
                  <p key={m.courseId} className="rounded-lg bg-white px-3 py-2 text-xs text-gray-700 ring-1 ring-gray-200 break-keep wrap-anywhere">
                    <span className="font-semibold text-gray-900">내 수업 · {m.title}</span>
                    {m.status === 'pending' ? ' (승인 대기)' : ''}
                    {m.roomName ? ` · ${m.roomName}` : ''}
                    <span className="block text-gray-500">{sourceNote(m.source)}</span>
                  </p>
                ))}
              {selCell.offered.length === 0 ? (
                <p className="text-xs text-gray-600 break-keep">이 시간에 고를 수 있는 공개 수업이 없어요.</p>
              ) : (
                <ul className="space-y-2" aria-label="이 시간 수업 목록">
                  {selCell.offered.map((c) => (
                    <li key={c.courseId}>{card(c)}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label htmlFor={searchId} className="block text-sm font-medium text-gray-700">
              과목명으로 찾기
            </label>
            <input
              id={searchId}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value.slice(0, 40))}
              placeholder="예: 영어"
              autoComplete="off"
              enterKeyHint="search"
              aria-describedby={hintId}
              className="mt-1 block min-h-11 w-full min-w-0 appearance-none rounded-xl border border-gray-300 bg-white px-3 py-2 text-base text-black shadow-sm placeholder-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <p id={hintId} className="mt-1 text-xs leading-relaxed text-gray-500 break-keep">
              검색은 목록만 좁혀요. 이름이 같아도 자동으로 담지 않으니, 과목·분반·선생님·요일을 확인하고 &lsquo;담기&rsquo;를 눌러 주세요.
            </p>
          </div>
          {listShown.length === 0 ? (
            q ? (
              <div role="status" className="rounded-xl bg-gray-50 px-4 py-5 text-center ring-1 ring-gray-100">
                <p className="text-sm font-semibold text-gray-900 break-keep wrap-anywhere">{`‘${query.trim()}’와(과) 맞는 ${showOthers ? '' : '내 학년·반 '}수업이 없어요`}</p>
                {hiddenMatches > 0 && (
                  <p className="mt-1 text-xs leading-relaxed text-gray-500 break-keep">다른 반·학년 수업 중 {hiddenMatches}개가 맞아요.</p>
                )}
                <div className="mt-3 flex flex-wrap justify-center gap-2">
                  {hiddenMatches > 0 && (
                    <button type="button" onClick={() => setShowOthers(true)} className={btnPrimary}>
                      다른 반·학년 수업도 보기
                    </button>
                  )}
                  <button type="button" onClick={() => setQuery('')} className={btnSecondary}>
                    검색 지우기
                  </button>
                </div>
              </div>
            ) : (
              noMineBox(!showOthers && hidden > 0)
            )
          ) : (
            <ul className="space-y-2" aria-label="학교 수업 목록">
              {listShown.map((c) => (
                <li key={c.courseId}>{card(c)}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 담은 수업(장바구니) — 섹션 아래쪽에 붙어 따라옴 */}
      {(cart.length > 0 || results) && (
        // 홈 표시줄(iPhone) 위로: 아래 여백은 safe-area와 0.75rem 중 큰 값. 막대 높이만큼 문서 scroll-padding을 두어(아래 effect)
        // 키보드로 옮겨 간 칸·열린 칸 목록이 막대 뒤로 숨지 않음. 이 화면(/student/courses)에는 아래쪽 탭 막대가 없음
        <section
          ref={cartRef}
          aria-label="담은 수업"
          className="sticky bottom-0 z-10 -mx-4 border-t border-gray-200 bg-white/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 shadow-[0_-4px_12px_rgba(0,0,0,0.06)] backdrop-blur"
        >
          {cart.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-bold text-gray-900">담은 수업 {cart.length}</p>
                {conflicts.length > 0 && <Pill tone="rose">겹침 {conflicts.length}곳</Pill>}
                <button type="button" onClick={() => setCartOpen((v) => !v)} aria-expanded={cartOpen} className={`${btnSmall} ml-auto`}>
                  {cartOpen ? '접기' : '목록'}
                </button>
              </div>
              {cartOpen && (
                <ul className="mt-2 max-h-[40vh] space-y-1.5 overflow-y-auto" aria-label="담은 수업 목록">
                  {picks.map((c) => (
                    <li key={c.courseId} className={`flex items-center gap-2 rounded-lg px-3 py-1.5 ring-1 ${conflictIds.has(c.courseId) ? 'bg-rose-50 ring-rose-200' : 'bg-gray-50 ring-gray-200'}`}>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-gray-900">{pickerTitle(c)}</p>
                        <p className="truncate text-[11px] text-gray-600">
                          {slotsText(c.slots)}
                          {c.invitePolicy === 'approval' ? ' · 승인 필요' : ''}
                        </p>
                      </div>
                      <button type="button" onClick={() => toggle(c)} disabled={disabled} aria-label={`${pickerTitle(c)} 담은 목록에서 빼기`} className={btnSmall}>
                        빼기
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {cart.length >= 20 && <p className="mt-2 text-xs text-gray-600 break-keep">한 번에 20개까지 담을 수 있어요. 먼저 담은 뒤 더 골라 주세요.</p>}
              {conflicts.length > 0 && (
                <ul role="status" aria-label="겹침 경고" className="mt-2 space-y-1 rounded-lg bg-rose-50 px-3 py-2 ring-1 ring-rose-200">
                  {conflicts.map((x) => (
                    <li key={`${x.kind}-${x.weekday}-${x.period}`} className="text-xs leading-relaxed text-rose-900 break-keep wrap-anywhere">
                      <span aria-hidden="true">⚠️ </span>
                      {conflictText(x)}
                    </li>
                  ))}
                  <li className="text-[11px] text-rose-800 break-keep">겹쳐도 담을 수 있어요. 맞지 않는 수업은 빼고 담아 주세요.</li>
                </ul>
              )}
              {submitError && (
                <p role="alert" className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 ring-1 ring-rose-200 break-keep">
                  <span aria-hidden="true">⚠️ </span>
                  {submitError}
                </p>
              )}
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={() => setCart([])} disabled={disabled} className={`${btnSmall} shrink-0`}>
                  비우기
                </button>
                <button type="button" onClick={() => void submit()} disabled={disabled || !picks.length} className={`${btnPrimary} flex-1`}>
                  {submitting ? '담는 중…' : `내 시간표에 담기 (${cart.length})`}
                </button>
              </div>
            </>
          )}
          {results && (
            <div role="status" aria-label="담기 결과" className={`${cart.length ? 'mt-3 border-t border-gray-100 pt-2' : ''}`}>
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-bold text-gray-900">담기 결과</p>
                <button type="button" onClick={() => setResults(null)} className={btnSmall} aria-label="담기 결과 닫기">
                  닫기
                </button>
              </div>
              <ul className="mt-1 space-y-1">
                {results.map((r) => (
                  <li key={r.courseId} className="text-xs leading-relaxed text-gray-800 break-keep wrap-anywhere">
                    <span className="font-semibold text-gray-900">{r.title}</span> —{' '}
                    <span
                      className={
                        r.kind === 'added' ? 'font-bold text-emerald-700' : r.kind === 'pending' ? 'font-bold text-amber-700' : r.kind === 'already' ? 'font-semibold text-gray-700' : 'font-bold text-rose-700'
                      }
                    >
                      {r.label}
                    </span>
                    {r.detail ? <span className="text-gray-600"> · {r.detail}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
