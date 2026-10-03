/**
 * 공식 수업 일정 변경 화면(/teacher/schedule-changes)의 순수 판정 도우미
 * (Firebase·React와 분리 — 단위 테스트 대상. scheduleChangeClient.ts는 firebase를 불러오므로 여기서 import하지 않음)
 *
 * - 변경 목록(draft) 합치기: 같은 차시 항목은 새 내용으로 바꾸고(일정 변경끼리는 합침), 범위('이 날짜만'/'기본 시간표')는 섞지 않음
 * - 검토 필요 '원래대로': 작성 중인 변경 목록·사유를 말없이 덮어쓰지 않음(같은 범위면 목록에 추가, 다르면 확인 후 바꾸기)
 * - 보강 추가 패널의 대상 수업: 수업 선택에서 뺀 수업으로 보강을 추가하지 않음
 */

/** 변경 목록 항목의 최소 모양 — scheduleChangeClient.ts의 ChangeItemInput과 구조가 맞음 */
export interface DraftItemLike {
  op: string
  courseId: string
  occurrenceKey?: string
  seriesId?: string
  target?: object
}

export interface DraftEntryOf<I extends DraftItemLike> {
  id: string
  label: string
  item: I
}

export type DraftScope = 'date' | 'base'

/** 변경 목록의 범위 — 첫 항목이 기본 시간표 변경이면 'base', 아니면(비어 있어도) 'date' */
export function draftScopeOf(entries: ReadonlyArray<{ item: { op: string } }>): DraftScope {
  return entries.length && entries[0].item.op === 'base' ? 'base' : 'date'
}

/** 같은 대상(차시·반복 차시)인지 가리는 키 — 보강은 늘 새 차시라 null(겹치지 않음) */
export function draftItemKey(it: DraftItemLike): string | null {
  return it.op === 'base' ? `series:${it.seriesId}` : it.op === 'makeup' ? null : `${it.courseId}|${it.occurrenceKey}`
}

export type DraftMergeResult<I extends DraftItemLike> =
  | { ok: true; next: DraftEntryOf<I>[]; replaced: boolean; merged: boolean }
  | { ok: false; error: 'scope-mismatch' | 'too-many' }

/**
 * 변경 목록에 항목 추가(화면의 addItems와 같은 규칙)
 * - '이 날짜만'과 '기본 시간표 변경'은 한 목록에 섞지 않음 → scope-mismatch
 * - 같은 차시의 일정 변경 두 개(예: 교실 + 교사)는 한 항목으로 합침(나중 값 우선), 그 밖의 같은 차시 항목은 새 내용으로 바꿈
 * - 결과가 max개를 넘으면 → too-many(목록은 그대로)
 */
export function mergeDraftEntries<I extends DraftItemLike>(
  draft: ReadonlyArray<DraftEntryOf<I>>,
  entries: ReadonlyArray<{ label: string; item: I }>,
  opts: { max: number; newId: () => string }
): DraftMergeResult<I> {
  if (!entries.length) return { ok: true, next: draft.slice(), replaced: false, merged: false }
  const isBase = entries[0].item.op === 'base'
  if (draft.length && (draftScopeOf(draft) === 'base') !== isBase) return { ok: false, error: 'scope-mismatch' }
  let next = draft.slice()
  let replaced = false
  let merged = false
  for (const e of entries) {
    const k = draftItemKey(e.item)
    const prev = k ? next.find((d) => draftItemKey(d.item) === k) : undefined
    if (prev && prev.item.op === 'reschedule' && e.item.op === 'reschedule') {
      const item = { ...e.item, target: { ...(prev.item.target || {}), ...(e.item.target || {}) } } as I
      next = next.map((d) => (d === prev ? { id: d.id, label: `${d.label} / ${e.label}`, item } : d))
      merged = true
      continue
    }
    if (prev) {
      next = next.filter((d) => d !== prev)
      replaced = true
    }
    next.push({ id: opts.newId(), label: e.label, item: e.item })
  }
  if (next.length > opts.max) return { ok: false, error: 'too-many' }
  return { ok: true, next, replaced, merged }
}

// ───────────────────────── 검토 필요 '원래대로' ─────────────────────────

export const ORPHAN_RESTORE_REASON = '기본 시간표 변경 후 검토 필요 정리'

export type OrphanRestorePlan<I extends DraftItemLike> =
  /** 목록에 추가(기존 항목 유지) — 사유는 비어 있을 때만 채움. kept: 원래 있던 항목 수 */
  | { kind: 'add'; next: DraftEntryOf<I>[]; reason: string; kept: number; replaced: boolean; merged: boolean }
  /** 기본 시간표 변경 목록을 지우고 이 항목으로 바꿈 — 화면은 확인(confirm)을 받은 뒤에만 적용 */
  | { kind: 'replace'; next: DraftEntryOf<I>[]; reason: string; dropped: number; hadReason: boolean }
  | { kind: 'too-many' }

/**
 * 변경 이력 탭 '검토 필요'의 '원래대로'를 변경 목록에 넣는 계획
 * 예전에는 작성 중인 변경 목록과 사유를 확인 없이 이 항목 하나로 덮어써서, 발행하지 않은 변경이 말없이 사라졌음.
 * - 목록이 비었거나 '이 날짜만' 목록 → 그 목록에 추가(지우지 않음)
 * - '기본 시간표 변경' 목록 → 한 번에 발행할 수 없어 바꿔야 함(kind 'replace' — 확인 필요)
 */
export function planOrphanRestore<I extends DraftItemLike>(
  draft: ReadonlyArray<DraftEntryOf<I>>,
  entry: { label: string; item: I },
  reason: string,
  opts: { max: number; newId: () => string; defaultReason?: string }
): OrphanRestorePlan<I> {
  const defaultReason = opts.defaultReason ?? ORPHAN_RESTORE_REASON
  if (draft.length && draftScopeOf(draft) !== draftScopeOf([entry])) {
    return { kind: 'replace', next: [{ id: opts.newId(), label: entry.label, item: entry.item }], reason: defaultReason, dropped: draft.length, hadReason: !!reason.trim() }
  }
  const r = mergeDraftEntries(draft, [entry], opts)
  if (!r.ok) return { kind: 'too-many' }
  return { kind: 'add', next: r.next, reason: reason.trim() ? reason : defaultReason, kept: draft.length, replaced: r.replaced, merged: r.merged }
}

// ───────────────────────── 보강 추가 패널 ─────────────────────────

/** 보강 추가 패널의 대상 수업 — 고른 수업이 수업 선택에서 빠졌으면 남은 첫 수업(없으면 '') */
export function makeupCourseFor(mCourse: string, selectedIds: readonly string[]): string {
  return mCourse && selectedIds.includes(mCourse) ? mCourse : selectedIds[0] || ''
}

/**
 * 수업 선택에서 한 수업을 뺄 때의 다음 상태
 * 예전에는 보강 패널의 대상 수업(mCourse)이 그대로 남아, 화면 목록에는 없는 그 수업으로 보강이 추가됐음.
 * - 보강 패널이 그 수업을 대상으로 하고 있었으면 패널을 닫음(closeMakeup)
 * - 대상 수업은 남은 선택 안에서 다시 정함
 */
export function deselectCourse(
  selectedIds: readonly string[],
  removedId: string,
  mCourse: string
): { selectedIds: string[]; mCourse: string; closeMakeup: boolean } {
  const rest = selectedIds.filter((x) => x !== removedId)
  return {
    selectedIds: rest,
    mCourse: makeupCourseFor(mCourse, rest),
    closeMakeup: makeupCourseFor(mCourse, selectedIds) === removedId,
  }
}
