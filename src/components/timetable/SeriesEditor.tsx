import React, { useMemo, useState } from 'react'
import { useUI } from '../ui/feedback'
import { formatYmdKo, ymdToIso } from '../../lib/timetable/dates'
import {
  addSeries,
  asApiError,
  errorText,
  retireSeries,
  seriesCurrentOrUpcoming,
  timeRangeText,
  WEEKDAY_KO,
  type SeriesConflict,
  type TeacherApiError,
} from '../../lib/timetable/teacherClient'
import {
  acknowledgedRequest,
  addSeriesImpactText,
  buildSeriesAddRequest,
  effectiveDateFromIso,
  isPastDateCode,
  PAST_DATE_TEXT,
  retireSeriesImpactText,
  type SeriesAddRequest,
} from '../../lib/timetable/teacherCourseView'
import type { LessonSeries, Weekday, Ymd } from '../../lib/timetable/types'

// 반복 차시 편집 — 요일·교시·시각(선택)·수업 교실·적용 시작일로 차시를 추가하고(addSeries),
// 차시를 적용일부터 끝냅니다(retireSeries — 그 전 날짜는 그대로).
// 추가·종료 적용일은 오늘(학교 시간대)부터만 고를 수 있어요(지난 학생 시간표를 소급해 바꾸지 않음 — 서버도 400 'past-date').
// 추가·종료 전 확인 대화상자에 영향(이 수업 수강생의 그날 이후 시간표가 바뀜)을 보여 줍니다.
// '수업 교실'은 수업이 열리는 장소예요. 학생의 소속 학급과 이름이 같아도 별개입니다.
// 특정 날짜만 바꾸는 일정 변경은 /teacher/schedule-changes에서 합니다.

export interface SeriesEditorProps {
  courseId: string
  series: LessonSeries[]
  /** 수업 기본 교실(차시에 교실이 없을 때 표시) */
  defaultRoomName?: string | null
  /** 학교 시간대 오늘 */
  today: Ymd
  /** 담당·관리 교사이고 수업이 운영 중일 때만 */
  canEdit: boolean
  /** 편집할 수 없는 이유(예: 종료된 수업) */
  readOnlyReason?: string | null
  onChanged: () => void
}

const PERIODS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
const WEEKDAYS: Weekday[] = [1, 2, 3, 4, 5, 6, 7]

function roomText(s: LessonSeries, defaultRoomName?: string | null): string {
  if (s.roomName) return s.roomName
  if (defaultRoomName) return `${defaultRoomName} (기본 교실)`
  return '교실 미정'
}

function SeriesRow({
  s,
  defaultRoomName,
  right,
}: {
  s: LessonSeries
  defaultRoomName?: string | null
  right?: React.ReactNode
}) {
  const time = timeRangeText(s)
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="font-bold text-gray-900">
          {WEEKDAY_KO[s.weekday]}요일 {s.period}교시
          {time && <span className="ml-1.5 text-sm font-medium text-gray-500">{time}</span>}
        </p>
        <p className="text-sm text-gray-700 break-words">
          <span className="text-gray-500">수업 교실 · </span>
          {roomText(s, defaultRoomName)}
        </p>
        <p className="text-xs text-gray-500">
          {formatYmdKo(s.validFrom)}부터
          {s.validTo ? ` · ${formatYmdKo(s.validTo)}부터 빠짐` : ''}
        </p>
      </div>
      {right}
    </div>
  )
}

export default function SeriesEditor({ courseId, series, defaultRoomName, today, canEdit, readOnlyReason, onChanged }: SeriesEditorProps) {
  const { toast, confirm } = useUI()

  const current = useMemo(
    () => series.filter((s) => seriesCurrentOrUpcoming(s, today)).sort((a, b) => a.weekday - b.weekday || a.period - b.period || a.validFrom.localeCompare(b.validFrom)),
    [series, today]
  )
  const past = useMemo(
    () =>
      series
        .filter((s) => !seriesCurrentOrUpcoming(s, today) && !(s.validTo && s.validTo <= s.validFrom))
        .sort((a, b) => (b.validTo || '').localeCompare(a.validTo || '') || a.weekday - b.weekday || a.period - b.period),
    [series, today]
  )

  // 추가 폼
  const [weekday, setWeekday] = useState<Weekday>(1)
  const [period, setPeriod] = useState(1)
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [roomName, setRoomName] = useState('')
  const [validFromIso, setValidFromIso] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<TeacherApiError | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  /**
   * 겹침 확인 패널 — 409를 받은 '그 입력'을 함께 둡니다. '겹쳐도 추가'는 이 입력만 보내고,
   * 패널이 뜬 뒤 입력을 바꾸면 패널을 닫아 다시 확인받게 합니다(보지 않은 새 칸이 확인 없이 저장되던 문제).
   */
  const [conflicts, setConflicts] = useState<{ items: SeriesConflict[]; req: SeriesAddRequest } | null>(null)
  /** 저장은 됐지만 겹침이 있는 차시(확인 후 추가) */
  const [savedWithConflicts, setSavedWithConflicts] = useState<SeriesConflict[] | null>(null)

  // 종료 폼(차시별)
  const [retiringId, setRetiringId] = useState<string | null>(null)
  const [retireIso, setRetireIso] = useState(ymdToIso(today))
  const [retireBusy, setRetireBusy] = useState(false)

  const todayIso = ymdToIso(today)
  /** 서버가 지난 날짜를 거부한 경우(400 'past-date')도 같은 문구로 */
  const seriesErrorText = (err: TeacherApiError) => (isPastDateCode(err.code) ? PAST_DATE_TEXT : errorText(err))

  /** 추가 폼 입력이 바뀜 — 떠 있던 겹침 확인은 이전 입력에 대한 것이므로 무효 */
  const formChanged = () => {
    if (!conflicts) return
    setConflicts(null)
    setFormError("입력을 바꿔서 겹침 확인을 취소했어요. 바뀐 내용으로 '차시 추가'를 다시 눌러 확인해 주세요.")
  }

  const formValues = () => ({ weekday, period, start, end, roomName, validFromIso })

  const send = async (req: SeriesAddRequest, acknowledgeConflicts: boolean) => {
    setAdding(true)
    try {
      const r = await addSeries({
        courseId,
        weekday: req.weekday,
        period: req.period,
        start: req.start,
        end: req.end,
        roomName: req.roomName,
        ...(req.validFrom ? { validFrom: req.validFrom } : {}),
        ...(acknowledgeConflicts ? { acknowledgeConflicts: true } : {}),
      })
      setConflicts(null)
      if (r.conflicts && r.conflicts.length) setSavedWithConflicts(r.conflicts)
      toast(`${WEEKDAY_KO[req.weekday]}요일 ${req.period}교시 차시를 추가했어요.`, 'success')
      setStart('')
      setEnd('')
      onChanged()
    } catch (e) {
      const err = asApiError(e)
      if (err.code === 'conflicts' && Array.isArray(err.extra.conflicts)) {
        setConflicts({ items: err.extra.conflicts as SeriesConflict[], req })
      } else {
        console.error('series-editor: 추가 실패', err.code)
        setConflicts(null)
        setAddError(err)
      }
    } finally {
      setAdding(false)
    }
  }

  const submit = async () => {
    if (adding) return
    setAddError(null)
    setFormError(null)
    setSavedWithConflicts(null)
    const built = buildSeriesAddRequest(formValues(), today)
    if (!built.ok) {
      setConflicts(null)
      setFormError(built.error)
      return
    }
    const { req } = built
    const ok = await confirm({
      title: `${WEEKDAY_KO[req.weekday]}요일 ${req.period}교시 차시를 추가할까요?`,
      description: addSeriesImpactText(req.validFrom),
      confirmText: '차시 추가하기',
      cancelText: '취소',
    })
    if (!ok) return
    await send(req, false)
  }

  /** '겹쳐도 추가' — 겹침을 확인한 그 입력만 보냄(추가 전 확인 대화상자는 같은 입력으로 이미 거침) */
  const submitAcknowledged = async () => {
    if (adding || !conflicts) return
    const req = acknowledgedRequest(conflicts.req, formValues(), today)
    if (!req) {
      formChanged()
      return
    }
    setAddError(null)
    setFormError(null)
    setSavedWithConflicts(null)
    await send(req, true)
  }

  const retire = async (s: LessonSeries) => {
    const d = effectiveDateFromIso(retireIso, today, '종료 적용일을 골라 주세요.')
    if (!d.ok) {
      toast(d.error, 'error')
      return
    }
    const eff = d.ymd
    const ok = await confirm({
      title: `${WEEKDAY_KO[s.weekday]}요일 ${s.period}교시 차시를 끝낼까요?`,
      description: retireSeriesImpactText(eff),
      confirmText: '차시 끝내기',
      cancelText: '취소',
      danger: true,
    })
    if (!ok) return
    setRetireBusy(true)
    try {
      const r = await retireSeries(s.seriesId, eff)
      toast(r.already ? '이미 그 날짜 전에 끝난 차시예요.' : '차시를 끝냈어요.', 'success')
      setRetiringId(null)
      onChanged()
    } catch (e) {
      const err = asApiError(e)
      console.error('series-editor: 종료 실패', err.code)
      toast(seriesErrorText(err), 'error')
    } finally {
      setRetireBusy(false)
    }
  }

  return (
    <div className="space-y-4 text-gray-900">
      {/* 현재·예정 차시 */}
      {current.length === 0 ? (
        <p className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-3 text-sm text-amber-900 break-keep">
          ⚠️ 등록된 차시가 없어요. 차시가 없으면 학생 시간표에 이 수업이 나오지 않아요(&apos;시간표 미등록&apos;으로 보여요).
        </p>
      ) : (
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
          {current.map((s) => (
            <li key={s.seriesId} className="px-3 py-3">
              <SeriesRow
                s={s}
                defaultRoomName={defaultRoomName}
                right={
                  canEdit && !s.validTo ? (
                    <button
                      type="button"
                      onClick={() => {
                        setRetiringId(retiringId === s.seriesId ? null : s.seriesId)
                        setRetireIso(ymdToIso(s.validFrom > today ? s.validFrom : today))
                      }}
                      className="shrink-0 self-start min-h-[44px] rounded-lg border border-gray-300 bg-white px-4 text-sm font-bold text-gray-700 hover:bg-gray-50"
                    >
                      종료
                    </button>
                  ) : null
                }
              />
              {canEdit && retiringId === s.seriesId && (
                <div className="mt-3 rounded-lg bg-gray-50 border border-gray-200 p-3">
                  <label className="block text-sm">
                    <span className="font-semibold">종료 적용일</span>
                    <input
                      type="date"
                      value={retireIso}
                      min={todayIso}
                      onChange={(e) => setRetireIso(e.target.value)}
                      className="mt-1 block w-full min-h-[44px] rounded-lg border border-gray-300 px-3"
                    />
                  </label>
                  <p className="mt-1 text-xs text-gray-600 break-keep">이 날짜부터 이 수업 수강생 시간표에서 빠지고, 그 전 날짜는 그대로 남아요. 지난 날짜는 고를 수 없어요.</p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => void retire(s)}
                      disabled={retireBusy}
                      className="flex-1 min-h-[44px] rounded-lg bg-red-600 px-4 text-sm font-bold text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {retireBusy ? '처리 중...' : '이 날짜부터 끝내기'}
                    </button>
                    <button type="button" onClick={() => setRetiringId(null)} className="min-h-[44px] rounded-lg px-4 text-sm text-gray-600">
                      취소
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {past.length > 0 && (
        <details className="rounded-lg border border-gray-200 bg-white">
          <summary className="cursor-pointer list-none px-3 py-3 min-h-[44px] text-sm font-semibold text-gray-600">지난 차시 {past.length}개 보기</summary>
          <ul className="divide-y divide-gray-100 border-t border-gray-100">
            {past.map((s) => (
              <li key={s.seriesId} className="px-3 py-3 opacity-80">
                <SeriesRow s={s} defaultRoomName={defaultRoomName} />
              </li>
            ))}
          </ul>
        </details>
      )}

      {savedWithConflicts && savedWithConflicts.length > 0 && (
        <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900">
          <p className="font-bold">⚠️ 겹침을 확인하고 추가했어요</p>
          <ConflictList items={savedWithConflicts} />
        </div>
      )}

      {/* 추가 */}
      {!canEdit ? (
        readOnlyReason ? <p className="text-sm text-gray-600 break-keep">{readOnlyReason}</p> : null
      ) : (
        <form
          className="rounded-xl border border-gray-200 bg-gray-50 p-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <p className="text-sm font-bold text-gray-800">차시 추가(매주 반복)</p>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="font-semibold">요일</span>
              <select
                value={weekday}
                onChange={(e) => {
                  setWeekday(Number(e.target.value) as Weekday)
                  formChanged()
                }}
                className="mt-1 block w-full min-h-[44px] rounded-lg border border-gray-300 bg-white px-3"
              >
                {WEEKDAYS.map((w) => (
                  <option key={w} value={w}>
                    {WEEKDAY_KO[w]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="font-semibold">교시</span>
              <select
                value={period}
                onChange={(e) => {
                  setPeriod(Number(e.target.value))
                  formChanged()
                }}
                className="mt-1 block w-full min-h-[44px] rounded-lg border border-gray-300 bg-white px-3"
              >
                {PERIODS.map((p) => (
                  <option key={p} value={p}>
                    {p}교시
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="font-semibold">시작 시각(선택)</span>
              <input
                type="time"
                value={start}
                onChange={(e) => {
                  setStart(e.target.value)
                  formChanged()
                }}
                className="mt-1 block w-full min-h-[44px] rounded-lg border border-gray-300 bg-white px-3" />
            </label>
            <label className="block text-sm">
              <span className="font-semibold">끝 시각(선택)</span>
              <input
                type="time"
                value={end}
                onChange={(e) => {
                  setEnd(e.target.value)
                  formChanged()
                }}
                className="mt-1 block w-full min-h-[44px] rounded-lg border border-gray-300 bg-white px-3" />
            </label>
          </div>
          <label className="block text-sm">
            <span className="font-semibold">수업 교실</span>
            <input
              type="text"
              value={roomName}
              maxLength={30}
              onChange={(e) => {
                setRoomName(e.target.value)
                formChanged()
              }}
              placeholder={defaultRoomName ? `비우면 기본 교실(${defaultRoomName})` : '예: 3학년 5반 교실, 과학실'}
              className="mt-1 block w-full min-h-[44px] rounded-lg border border-gray-300 bg-white px-3"
            />
            <span className="mt-1 block text-xs text-gray-500 break-keep">
              수업이 열리는 장소예요. 학생의 소속 학급(반)과는 별개라서, 다른 반 교실에서 수업해도 학생 소속은 바뀌지 않아요.
            </span>
          </label>
          <label className="block text-sm">
            <span className="font-semibold">적용 시작일(선택)</span>
            <input
              type="date"
              value={validFromIso}
              min={todayIso}
              onChange={(e) => {
                setValidFromIso(e.target.value)
                formChanged()
              }}
              className="mt-1 block w-full min-h-[44px] rounded-lg border border-gray-300 bg-white px-3"
            />
            <span className="mt-1 block text-xs text-gray-500 break-keep">
              비우면 오늘부터(학기 시작 전이면 학기 시작일부터) 적용돼요. 지난 날짜는 고를 수 없어요(지난 시간표는 바뀌지 않아요).
            </span>
          </label>

          {formError && (
            <p role="alert" className="text-sm text-red-700">
              ⚠️ {formError}
            </p>
          )}

          {addError && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 break-keep">
              <p>⚠️ {seriesErrorText(addError)}</p>
              {addError.retryable && (
                <button type="button" onClick={() => void submit()} className="mt-1 min-h-[44px] font-bold underline">
                  다시 시도
                </button>
              )}
            </div>
          )}

          {conflicts && (
            <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900">
              <p className="font-bold">
                ⚠️ {WEEKDAY_KO[conflicts.req.weekday]}요일 {conflicts.req.period}교시 차시가 다른 수업과 시간이 겹쳐요
              </p>
              <ConflictList items={conflicts.items} />
              <p className="mt-2 text-xs break-keep">함께 쓰는 교실이거나 공동 수업처럼 겹쳐도 되는 경우에만 추가하세요. 입력을 바꾸면 이 확인은 취소되고 다시 확인해요.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void submitAcknowledged()}
                  disabled={adding}
                  className="min-h-[44px] rounded-lg bg-amber-600 px-4 text-sm font-bold text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  겹쳐도 추가
                </button>
                <button type="button" onClick={() => setConflicts(null)} className="min-h-[44px] rounded-lg px-4 text-sm text-amber-900 underline">
                  취소
                </button>
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={adding}
            className="w-full min-h-[48px] rounded-xl bg-gray-900 text-white font-bold hover:bg-gray-800 disabled:opacity-50"
          >
            {adding ? '추가하는 중...' : '차시 추가'}
          </button>
        </form>
      )}
    </div>
  )
}

function ConflictList({ items }: { items: SeriesConflict[] }) {
  const kindLabel = { teacher: '교사', room: '교실', students: '학생' } as const
  return (
    <ul className="mt-1 space-y-1">
      {items.map((c, i) => (
        <li key={`${c.seriesId}-${c.kind}-${i}`} className="break-words">
          <span className="font-semibold">[{kindLabel[c.kind] || '겹침'}]</span> {c.courseTitle || '다른 수업'} · {WEEKDAY_KO[c.weekday as Weekday] || ''}요일 {c.period}교시 — {c.detail}
        </li>
      ))}
    </ul>
  )
}
