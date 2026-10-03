import React from 'react'
import { formatYmdKo, weekdayOf } from '../../lib/timetable/dates'
import { diffSlots } from '../../lib/timetable/engine'
import type { ChangeField, PeriodTime, SlotState } from '../../lib/timetable/types'
import {
  slotTimeText,
  WEEKDAY_NAMES,
  type ChangePreviewItem,
  type ConflictEntry,
  type OrphanEntry,
} from '../../lib/timetable/scheduleChangeClient'

// 공식 일정 변경 미리보기·변경 묶음 표시 (교사 화면 전용)
// - 수업별로 '변경 전 → 변경 후'(날짜·교시·시각·교실·교사). 바뀐 항목만 빨간 계열 강조 + 텍스트 배지(색만으로 전달하지 않음)
// - 영향 학생은 '수'만(명단·이름 없음), 충돌(교사·교실·학생 겹침), 기본 변경으로 대상이 사라지는 기존 변경(검토 필요)
// - 내부 id(courseId·occurrenceKey·seriesId)는 표시하지 않습니다.

interface Props {
  changes: ChangePreviewItem[]
  affectedStudentCount?: number | null
  conflicts?: ConflictEntry[]
  orphans?: OrphanEntry[]
  /** 검토 필요 항목의 수업 이름(courseId → 제목). 없으면 '수업' */
  courseTitles?: Record<string, string>
  periodTimes?: PeriodTime[]
  /** 제목(기본 '변경 내용') */
  heading?: string
}

const FIELD_LABEL: Record<ChangeField, { text: string; icon: string }> = {
  date: { text: '날짜 변경', icon: '📅' },
  time: { text: '시간 변경', icon: '⏰' },
  room: { text: '교실 변경', icon: '🚪' },
  teacher: { text: '교사 변경', icon: '👤' },
}

function Badge({ icon, text, tone = 'red' }: { icon: string; text: string; tone?: 'red' | 'gray' | 'amber' }) {
  const cls =
    tone === 'red'
      ? 'bg-red-50 text-red-800 ring-red-300'
      : tone === 'amber'
        ? 'bg-amber-50 text-amber-900 ring-amber-300'
        : 'bg-gray-100 text-gray-700 ring-gray-300'
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ring-1 ${cls}`}>
      <span aria-hidden>{icon}</span>
      {text}
    </span>
  )
}

/** 변경 종류 배지(텍스트) */
export function changeBadges(c: Pick<ChangePreviewItem, 'kind' | 'fields' | 'effectiveFrom'>): Array<{ icon: string; text: string }> {
  switch (c.kind) {
    case 'cancel':
      return [{ icon: '✕', text: '취소' }]
    case 'makeup':
      return [{ icon: '➕', text: '보강' }]
    case 'restore':
      return [{ icon: '↩', text: '복원' }]
    case 'base': {
      const out = [{ icon: '🗓', text: `기본 시간표 변경(적용일 ${c.effectiveFrom ? formatYmdKo(c.effectiveFrom) : '지정일'}부터)` }]
      return out.concat((c.fields || []).map((f) => (f === 'date' ? { text: '요일 변경', icon: '📅' } : FIELD_LABEL[f])))
    }
    default:
      return (c.fields || []).map((f) => FIELD_LABEL[f])
  }
}

const periodText = (s: SlotState) => (s.period > 0 ? `${s.period}교시` : '0교시')
const roomText = (s: SlotState) => s.roomName || '교실 미정'
const teacherText = (s: SlotState) => ((s.teacherNames || []).length ? (s.teacherNames || []).join(', ') : '교사 미정')
const sameTeachers = (a: SlotState, b: SlotState) => teacherText(a) === teacherText(b)

/** 한 줄: '변경 전 → 변경 후' 또는 바뀌지 않은 값 */
function Row({ label, before, after, changed }: { label: string; before: string; after: string; changed: boolean }) {
  return (
    <div className={`flex gap-2 py-1 text-sm ${changed ? 'rounded-md bg-red-50 px-2 -mx-2' : ''}`}>
      <dt className="w-14 shrink-0 text-gray-500">{label}</dt>
      <dd className="min-w-0 flex-1 break-keep text-gray-900">
        {changed ? (
          <>
            <span className="text-gray-600">{before}</span> → <strong className="font-bold text-red-700">{after}</strong>
          </>
        ) : (
          after
        )}
      </dd>
    </div>
  )
}

/** 시각 줄: 교시가 같아도 시각이 바뀌면 시각을 비교해 보여 줌 */
function timeLine(before: SlotState | null, after: SlotState, periodTimes?: PeriodTime[]): { before: string; after: string; changed: boolean } | null {
  const b = before ? slotTimeText(before, periodTimes) : null
  const a = slotTimeText(after, periodTimes)
  if (!a && !b) return null
  if (before && b !== a) return { before: b || '시각 미정', after: a || '교시표 시각', changed: true }
  return a ? { before: '', after: a, changed: false } : null
}

function SlotRows({ before, after, fields, periodTimes, weekly }: { before: SlotState | null; after: SlotState; fields: ChangeField[]; periodTimes?: PeriodTime[]; weekly?: boolean }) {
  const has = (f: ChangeField) => !!before && fields.includes(f)
  const dayText = (s: SlotState) => (weekly ? `매주 ${WEEKDAY_NAMES[weekdayOf(s.date)]}요일` : formatYmdKo(s.date))
  const periodChanged = !!before && before.period !== after.period
  const tl = timeLine(before, after, periodTimes)
  return (
    <dl className="mt-2">
      <Row label={weekly ? '요일' : '날짜'} before={before ? dayText(before) : ''} after={dayText(after)} changed={has('date') && (!weekly || weekdayOf(before!.date) !== weekdayOf(after.date))} />
      <Row label="교시" before={before ? periodText(before) : ''} after={periodText(after)} changed={has('time') && periodChanged} />
      {tl && <Row label="시각" before={tl.before} after={tl.after} changed={has('time') && tl.changed} />}
      <Row label="교실" before={before ? roomText(before) : ''} after={roomText(after)} changed={has('room') && !!before && roomText(before) !== roomText(after)} />
      <Row label="교사" before={before ? teacherText(before) : ''} after={teacherText(after)} changed={has('teacher') && !!before && !sameTeachers(before, after)} />
    </dl>
  )
}

function slotSummary(s: SlotState, periodTimes?: PeriodTime[]): string {
  const t = slotTimeText(s, periodTimes)
  return `${formatYmdKo(s.date)} ${periodText(s)}${t ? ` (${t})` : ''} · ${roomText(s)} · ${teacherText(s)}`
}

function ChangeCard({ c, periodTimes }: { c: ChangePreviewItem; periodTimes?: PeriodTime[] }) {
  const badges = changeBadges(c)
  const restoreFields = c.kind === 'restore' && c.before && c.after ? diffSlots(c.before, c.after) : c.fields || []
  return (
    <li className="rounded-xl border-2 border-red-300 bg-white p-3">
      <div className="flex flex-wrap gap-1.5">
        {badges.length ? badges.map((b) => <Badge key={b.text} icon={b.icon} text={b.text} />) : <Badge icon="•" text="변경" tone="gray" />}
      </div>
      {c.kind === 'cancel' && (
        <p className="mt-2 text-sm text-gray-900 break-keep">
          {c.before ? <span className="text-gray-600">{slotSummary(c.before, periodTimes)}</span> : '이 차시'} → <strong className="text-red-700">취소됨</strong>
        </p>
      )}
      {c.kind === 'makeup' && c.after && (
        <>
          <p className="mt-2 text-sm text-gray-700">새 차시를 추가해요(원래 시간표에 없던 수업).</p>
          <SlotRows before={null} after={c.after} fields={[]} periodTimes={periodTimes} />
        </>
      )}
      {c.kind === 'restore' && c.after && (
        <>
          {c.before ? (
            <SlotRows before={c.before} after={c.after} fields={restoreFields} periodTimes={periodTimes} />
          ) : (
            <p className="mt-2 text-sm text-gray-900 break-keep">
              <span className="text-gray-600">취소됨</span> → <strong className="text-red-700">원래 일정 {slotSummary(c.after, periodTimes)}</strong>
            </p>
          )}
        </>
      )}
      {c.kind === 'restore' && !c.after && <p className="mt-2 text-sm text-gray-700">기존 변경을 거두고 원래 일정으로 되돌려요.</p>}
      {c.kind === 'reschedule' && c.after && (
        <>
          {!c.before && <p className="mt-2 text-sm text-gray-700">취소됐던 차시를 다시 열어요.</p>}
          <SlotRows before={c.before} after={c.after} fields={c.before ? c.fields : []} periodTimes={periodTimes} />
        </>
      )}
      {c.kind === 'base' && c.after && (
        <>
          <SlotRows before={c.before} after={c.after} fields={c.fields} periodTimes={periodTimes} weekly />
          <p className="mt-1 text-xs text-gray-500 break-keep">
            {c.effectiveFrom ? `${formatYmdKo(c.effectiveFrom)}부터 매주 적용 · ` : ''}첫 수업 {formatYmdKo(c.after.date)}. 그 전 날짜는 지금 시간표 그대로예요.
          </p>
        </>
      )}
    </li>
  )
}

const dayPeriod = (s: SlotState) => `${formatYmdKo(s.date)} ${periodText(s)}`
const weekdayPeriod = (s: SlotState) => `매주 ${WEEKDAY_NAMES[weekdayOf(s.date)]}요일 ${periodText(s)}`

/** 한 줄 요약(이력·승인 목록): '영어 B · 10월 6일 (화) 3교시 → 2교시' */
export function changeSummaryText(c: ChangePreviewItem): string {
  const title = c.title || '수업'
  const b = c.before
  const a = c.after
  switch (c.kind) {
    case 'cancel':
      return `${title} · ${b ? dayPeriod(b) + ' ' : ''}취소`
    case 'makeup':
      return `${title} · 보강 ${a ? dayPeriod(a) : ''}`
    case 'restore':
      return `${title} · ${a ? dayPeriod(a) + ' ' : ''}원래대로`
    case 'base':
      return `${title} · 기본 시간표 ${b ? weekdayPeriod(b) + ' → ' : ''}${a ? weekdayPeriod(a) : ''}${c.effectiveFrom ? ` (${formatYmdKo(c.effectiveFrom)}부터)` : ''}`
    default: {
      if (!a) return `${title} · 변경`
      const extras: string[] = []
      if ((c.fields || []).includes('room')) extras.push(`교실 ${roomText(a)}`)
      if ((c.fields || []).includes('teacher')) extras.push(`교사 ${teacherText(a)}`)
      const moved = !b || b.date !== a.date || b.period !== a.period || (c.fields || []).includes('time')
      const head = b ? dayPeriod(b) : '취소됐던 차시'
      const to = moved ? ` → ${b && b.date === a.date ? periodText(a) : dayPeriod(a)}` : ''
      return `${title} · ${head}${to}${extras.length ? (moved ? ', ' : ' ') + extras.join(', ') : ''}`
    }
  }
}

function conflictText(c: ConflictEntry): { label: string; detail: string } {
  if (c.kind === 'teacher') return { label: '교사 겹침', detail: c.detail }
  if (c.kind === 'room') return { label: '교실 겹침', detail: c.detail }
  if (c.detail === 'same-course') return { label: '같은 수업 겹침', detail: '같은 수업의 두 차시가 같은 시간이에요' }
  const n = Number(c.detail)
  return { label: '학생 겹침', detail: Number.isFinite(n) ? `두 수업을 함께 듣는 학생 ${n}명` : c.detail }
}

const ORPHAN_KIND: Record<OrphanEntry['kind'], string> = {
  cancel: '취소',
  reschedule: '일정 변경',
  makeup: '보강',
  restore: '복원',
}

export function ConflictList({ conflicts }: { conflicts: ConflictEntry[] }) {
  if (!conflicts.length) return null
  return (
    <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-3" role="group" aria-label="충돌">
      <p className="text-sm font-bold text-amber-900">
        <span aria-hidden>⚠️ </span>충돌 {conflicts.length}건 — 시간이 겹치는 수업이 있어요
      </p>
      <ul className="mt-2 space-y-2">
        {conflicts.map((c, i) => {
          const t = conflictText(c)
          return (
            <li key={`${c.kind}-${c.date}-${i}`} className="rounded-lg bg-white p-2 text-sm text-gray-900 ring-1 ring-amber-200 break-keep">
              <span className="mr-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-xs font-bold text-amber-900">{t.label}</span>
              {formatYmdKo(c.date)} · {c.aTitle || '수업'} {c.aPeriod}교시 ↔ {c.bTitle || '수업'} {c.bPeriod}교시
              <div className="mt-0.5 text-gray-700">
                {t.label === '교사 겹침' ? `같은 선생님: ${t.detail}` : t.label === '교실 겹침' ? `같은 교실: ${t.detail}` : t.detail}
                {c.possible && <span className="ml-1 font-bold text-amber-800">(이름이 같아 같은 {c.kind === 'room' ? '교실' : '사람'}일 수 있음 — 확인 필요)</span>}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export function OrphanList({ orphans, courseTitles, periodTimes, intro }: { orphans: OrphanEntry[]; courseTitles?: Record<string, string>; periodTimes?: PeriodTime[]; intro?: string }) {
  if (!orphans.length) return null
  return (
    <div className="rounded-xl border-2 border-orange-300 bg-orange-50 p-3" role="group" aria-label="검토 필요">
      <p className="text-sm font-bold text-orange-900">
        <span aria-hidden>🔎 </span>검토 필요 {orphans.length}건
      </p>
      <p className="mt-0.5 text-xs text-orange-900 break-keep">{intro || '기본 시간표가 바뀌면 아래 기존 변경은 대상 차시가 없어져 학생 화면에 적용되지 않아요. 확인 후 원래대로 정리하거나 다시 지정해 주세요.'}</p>
      <ul className="mt-2 space-y-2">
        {orphans.map((o, i) => (
          <li key={`${o.originalDate}-${i}`} className="rounded-lg bg-white p-2 text-sm text-gray-900 ring-1 ring-orange-200 break-keep">
            <span className="mr-1 inline-block rounded bg-orange-100 px-1.5 py-0.5 text-xs font-bold text-orange-900">검토 필요</span>
            {courseTitles?.[o.courseId] || '수업'} · {o.originalDate ? `${formatYmdKo(o.originalDate)} 차시` : '보강 차시'}의 {ORPHAN_KIND[o.kind]}
            {o.target && <div className="mt-0.5 text-gray-700">변경 내용: {slotSummary(o.target, periodTimes)}</div>}
            {o.reason && <div className="mt-0.5 text-gray-500">사유: {o.reason}</div>}
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function ChangePreview({ changes, affectedStudentCount, conflicts = [], orphans = [], courseTitles, periodTimes, heading = '변경 내용' }: Props) {
  // 수업별 묶기(응답 순서 유지)
  const groups: Array<{ id: string; title: string; items: ChangePreviewItem[] }> = []
  changes.forEach((c) => {
    let g = groups.find((x) => x.id === c.courseId)
    if (!g) {
      g = { id: c.courseId, title: c.title || '수업', items: [] }
      groups.push(g)
    }
    g.items.push(c)
  })
  const titles: Record<string, string> = { ...(courseTitles || {}) }
  groups.forEach((g) => {
    if (!titles[g.id]) titles[g.id] = g.title
  })

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-bold text-gray-900">{heading}</h3>
        {typeof affectedStudentCount === 'number' && (
          <p className="text-sm text-gray-800">
            영향 학생 <strong className="text-lg text-gray-900">{affectedStudentCount}명</strong>
          </p>
        )}
      </div>
      {groups.map((g) => (
        <section key={g.id} aria-label={`${g.title} 변경`}>
          <h4 className="mb-1.5 text-sm font-bold text-gray-800">{g.title}</h4>
          <ul className="space-y-2">
            {g.items.map((c, i) => (
              <ChangeCard key={`${c.occurrenceKey}-${i}`} c={c} periodTimes={periodTimes} />
            ))}
          </ul>
        </section>
      ))}
      {!changes.length && <p className="text-sm text-gray-500">변경 내용이 없어요.</p>}
      <ConflictList conflicts={conflicts} />
      <OrphanList orphans={orphans} courseTitles={titles} periodTimes={periodTimes} />
    </div>
  )
}
