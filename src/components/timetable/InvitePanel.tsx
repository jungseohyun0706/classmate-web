import React, { useCallback, useEffect, useState } from 'react'
import { toDataURL } from 'qrcode'
import { useUI } from '../ui/feedback'
import {
  asApiError,
  createInvitation,
  errorText,
  formatMsDate,
  INVITE_STATE_LABEL,
  listInvitations,
  revokeInvitation,
  termLabel,
  type InvitationRow,
  type InviteState,
  type InviteType,
  type TeacherApiError,
} from '../../lib/timetable/teacherClient'

// 초대 코드 패널 — 학급 초대(소속 학급 등록)와 수업 초대(이 수업만 추가)를 제목·색·문구로 구분합니다.
// 오래 쓰는 다인용 코드(첫 학생이 써도 소진되지 않음): 만료일(기본 30일, 1~180)·사용 인원 제한(기본 없음)을 고르고
// 만들면 QR·공유 링크(window.location.origin + 응답 url)·복사할 수 있는 코드(XXXX-XXXX)를 보여 줍니다.
// 발급한 초대 목록(사용 수·만료·회수·상태)과 회수(확인 대화상자)를 함께 관리합니다.
// 초대 코드는 콘솔에 남기지 않습니다.

export interface InvitePanelProps {
  type: InviteType
  /** 학급 classId 또는 courseId (화면에 표시하지 않음) */
  targetId: string
  /** '3학년 4반' 또는 수업 제목 '영어 B' */
  targetLabel: string
  /** 대상 확인용(만들기 전) — 만든 뒤에는 서버 응답 값을 씁니다 */
  schoolName?: string
  termId?: string | null
  /** 수업 초대: 분반 */
  section?: string | null
  /** 교사 이름(수업: 담당 교사, 학급: 담임) — 만들기 전 확인용 */
  teacherNames?: string[]
  /** 만들 수 없는 이유(예: 종료된 수업) — 있으면 만들기 대신 안내 */
  disabledReason?: string | null
}

interface ShownInvite {
  code: string
  displayCode: string
  url: string
  expiresAt: number | null
  uses: number
  maxUses: number | null
}

const THEME: Record<InviteType, { badge: string; title: string; icon: string; box: string; head: string; badgeCls: string; btn: string; ring: string }> = {
  homeroom: {
    badge: '학급 초대',
    title: '학급 초대 — 소속 학급 등록(담임 승인 필요)',
    icon: '🏠',
    box: 'border-blue-200',
    head: 'bg-blue-50 border-blue-100',
    badgeCls: 'bg-blue-600 text-white',
    btn: 'bg-blue-600 hover:bg-blue-700',
    ring: 'focus-visible:ring-blue-400',
  },
  course: {
    badge: '수업 초대',
    title: '수업 초대 — 원래 학급은 그대로, 이 수업만 추가',
    icon: '📘',
    box: 'border-violet-200',
    head: 'bg-violet-50 border-violet-100',
    badgeCls: 'bg-violet-600 text-white',
    btn: 'bg-violet-600 hover:bg-violet-700',
    ring: 'focus-visible:ring-violet-400',
  },
}

const STATE_STYLE: Record<InviteState, { cls: string; icon: string }> = {
  ok: { cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: '✓' },
  expired: { cls: 'bg-amber-50 text-amber-800 border-amber-200', icon: '⌛' },
  revoked: { cls: 'bg-gray-100 text-gray-600 border-gray-200', icon: '⛔' },
  'used-up': { cls: 'bg-amber-50 text-amber-800 border-amber-200', icon: '👥' },
  ended: { cls: 'bg-gray-100 text-gray-600 border-gray-200', icon: '⛔' },
  'not-found': { cls: 'bg-gray-100 text-gray-600 border-gray-200', icon: '?' },
}

const usesText = (uses: number, maxUses: number | null) =>
  maxUses ? `사용 ${uses}명 / 최대 ${maxUses}명` : `사용 ${uses}명 · 인원 제한 없음`

export default function InvitePanel(props: InvitePanelProps) {
  const { type, targetId, targetLabel, section, teacherNames, disabledReason } = props
  const { toast, confirm } = useUI()
  const theme = THEME[type]

  // 만들기 옵션
  const [days, setDays] = useState('30')
  const [limitOn, setLimitOn] = useState(false)
  const [maxUses, setMaxUses] = useState('40')
  const [formError, setFormError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<TeacherApiError | null>(null)
  // 서버 응답의 대상 정보(학교·학기·교사)
  const [meta, setMeta] = useState<{ schoolName: string; termId: string; teacherName: string } | null>(null)

  // 화면에 띄운 초대(QR·링크·코드)
  const [shown, setShown] = useState<ShownInvite | null>(null)
  const [origin, setOrigin] = useState('')
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [qrFailed, setQrFailed] = useState(false)

  // 발급한 초대 목록
  const [rows, setRows] = useState<InvitationRow[] | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState<TeacherApiError | null>(null)
  const [busyCode, setBusyCode] = useState<string | null>(null)

  useEffect(() => {
    if (typeof window !== 'undefined') setOrigin(window.location.origin)
  }, [])

  const loadList = useCallback(async () => {
    setListLoading(true)
    setListError(null)
    try {
      const r = await listInvitations(targetId, type)
      setRows(r.invitations)
    } catch (e) {
      const err = asApiError(e)
      console.error('invite-panel: 목록 실패', err.code)
      setListError(err)
    } finally {
      setListLoading(false)
    }
  }, [targetId, type])

  useEffect(() => {
    setShown(null)
    setRows(null)
    setMeta(null)
    void loadList()
  }, [loadList])

  const shareUrl = shown && origin ? `${origin}${shown.url}` : ''

  // 링크 → QR 이미지 (기존 학급 QR 화면과 같은 라이브러리·설정)
  useEffect(() => {
    if (!shareUrl) {
      setQrDataUrl('')
      return
    }
    let cancelled = false
    setQrFailed(false)
    toDataURL(shareUrl, { width: 720, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#111827', light: '#ffffff' } })
      .then((d) => {
        if (!cancelled) setQrDataUrl(d)
      })
      .catch(() => {
        if (!cancelled) setQrFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [shareUrl])

  const create = async () => {
    if (creating) return
    setFormError(null)
    setCreateError(null)
    const d = Number(days)
    if (!Number.isInteger(d) || d < 1 || d > 180) {
      setFormError('만료 기간은 1~180일 사이 정수로 정해 주세요.')
      return
    }
    let limit: number | null = null
    if (limitOn) {
      const m = Number(maxUses)
      if (!Number.isInteger(m) || m < 1 || m > 10000) {
        setFormError('사용 인원은 1~10000명 사이 정수로 정하거나 \'제한 없음\'을 골라 주세요.')
        return
      }
      limit = m
    }
    setCreating(true)
    try {
      const r = await createInvitation({ type, targetId, expiresInDays: d, maxUses: limit })
      setMeta({ schoolName: r.schoolName, termId: r.termId, teacherName: r.teacherName })
      setShown({ code: r.code, displayCode: r.displayCode, url: r.url, expiresAt: r.expiresAt, uses: r.uses, maxUses: r.maxUses })
      toast(`${theme.badge} 코드를 만들었어요.`, 'success')
      void loadList()
    } catch (e) {
      const err = asApiError(e)
      console.error('invite-panel: 만들기 실패', err.code)
      setCreateError(err)
    } finally {
      setCreating(false)
    }
  }

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast(`${what}을(를) 복사했어요.`, 'success')
    } catch {
      toast('복사하지 못했어요. 길게 눌러 직접 복사해 주세요.', 'error')
    }
  }

  const share = async () => {
    if (!shareUrl) return
    const nav = navigator as Navigator & { share?: (d: { title?: string; text?: string; url?: string }) => Promise<void> }
    if (typeof nav.share !== 'function') {
      void copy(shareUrl, '초대 링크')
      return
    }
    try {
      await nav.share({ title: `${targetLabel} ${theme.badge}`, text: `${targetLabel} ${theme.badge} 링크예요.`, url: shareUrl })
    } catch {
      // 사용자가 공유 창을 닫은 경우 — 안내 없음
    }
  }

  const revoke = async (row: InvitationRow) => {
    if (busyCode) return
    const ok = await confirm({
      title: '이 초대 코드를 회수할까요?',
      description: `${row.displayCode} 코드와 그 QR·링크로는 더 이상 참여할 수 없어요. 이미 참여한 학생은 그대로예요.`,
      confirmText: '회수하기',
      cancelText: '취소',
      danger: true,
    })
    if (!ok) return
    setBusyCode(row.code)
    try {
      const r = await revokeInvitation(row.code)
      toast(r.already ? '이미 회수된 코드예요.' : '초대 코드를 회수했어요.', 'success')
      if (shown?.code === row.code) setShown(null)
      await loadList()
    } catch (e) {
      const err = asApiError(e)
      console.error('invite-panel: 회수 실패', err.code)
      toast(errorText(err), 'error')
    } finally {
      setBusyCode(null)
    }
  }

  const showRow = (row: InvitationRow) => {
    setShown({ code: row.code, displayCode: row.displayCode, url: row.url, expiresAt: row.expiresAt, uses: row.uses, maxUses: row.maxUses })
  }

  const schoolName = meta?.schoolName || props.schoolName || ''
  const termId = meta?.termId || props.termId || ''
  // 학급: 서버가 정한 담임 이름 우선 / 수업: 수업의 표시용 교사 이름 우선
  const namesText = teacherNames && teacherNames.length ? teacherNames.join(', ') : ''
  const teacherText = (type === 'homeroom' ? meta?.teacherName : '') || namesText || meta?.teacherName || ''

  return (
    <section className={`bg-white rounded-xl shadow border-2 ${theme.box} overflow-hidden text-gray-900`} aria-label={theme.badge}>
      {/* 머리: 종류를 색 + 글자 + 아이콘으로 구분 */}
      <div className={`px-4 py-4 sm:px-5 border-b ${theme.head}`}>
        <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold ${theme.badgeCls}`}>
          <span aria-hidden="true">{theme.icon}</span>
          {theme.badge}
        </span>
        <h3 className="mt-2 text-base sm:text-lg font-bold break-keep">{theme.title}</h3>
        <p className="mt-1 text-sm text-gray-700 break-keep">
          {type === 'homeroom'
            ? `이 코드로 들어온 학생은 ${targetLabel} 소속으로 입장 신청이 되고, 담임 선생님이 승인해야 등록돼요. 이미 다른 반 소속인 학생은 반 이동 신청이 되고, 승인 전까지 원래 소속은 그대로예요.`
            : `학생의 원래 소속 학급은 바뀌지 않아요. 이 수업(${targetLabel})만 학생의 개인 시간표에 추가돼요. 바로 참여할지, 선생님 승인 후 참여할지는 수업 설정을 따라요.`}
        </p>

        {/* 대상 확인 */}
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-gray-500">학교</dt>
          <dd className="min-w-0 break-words">{schoolName || '—'}</dd>
          <dt className="text-gray-500">학기</dt>
          <dd className="min-w-0">{termId ? termLabel(termId) : '이번 학기'}</dd>
          <dt className="text-gray-500">{type === 'homeroom' ? '학급' : '수업'}</dt>
          <dd className="min-w-0 font-semibold break-words">{targetLabel}</dd>
          {type === 'course' && (
            <>
              <dt className="text-gray-500">분반</dt>
              <dd className="min-w-0 break-words">{section || '없음'}</dd>
            </>
          )}
          <dt className="text-gray-500">{type === 'homeroom' ? '담임' : '교사'}</dt>
          <dd className="min-w-0 break-words">{teacherText || '—'}</dd>
        </dl>
      </div>

      <div className="p-4 sm:p-5 space-y-5">
        {/* 만들기 */}
        {disabledReason ? (
          <p className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-3 text-sm text-gray-700 break-keep">{disabledReason}</p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="font-semibold text-gray-800">만료(일)</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={180}
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                  className="mt-1 block w-full min-h-[44px] rounded-lg border border-gray-300 px-3 text-gray-900"
                />
                <span className="mt-1 block text-xs text-gray-500">1~180일, 기본 30일</span>
              </label>
              <fieldset className="text-sm">
                <legend className="font-semibold text-gray-800">사용 인원</legend>
                <label className="mt-1 flex items-center gap-2 min-h-[44px]">
                  <input type="radio" name={`limit-${type}-${targetId}`} checked={!limitOn} onChange={() => setLimitOn(false)} className="h-5 w-5" />
                  <span>제한 없음(권장)</span>
                </label>
                <label className="flex items-center gap-2 min-h-[44px]">
                  <input type="radio" name={`limit-${type}-${targetId}`} checked={limitOn} onChange={() => setLimitOn(true)} className="h-5 w-5" />
                  <span>최대</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={10000}
                    value={maxUses}
                    onChange={(e) => {
                      setMaxUses(e.target.value)
                      setLimitOn(true)
                    }}
                    aria-label="최대 사용 인원"
                    className="w-24 min-h-[44px] rounded-lg border border-gray-300 px-3 text-gray-900"
                  />
                  <span>명</span>
                </label>
              </fieldset>
            </div>
            <p className="text-xs text-gray-600 break-keep">
              여러 학생이 같은 코드를 함께 써요. 첫 학생이 써도 코드가 소진되지 않고, 만료일까지(인원 제한을 두면 그 인원까지) 쓸 수 있어요.
            </p>
            {formError && (
              <p role="alert" className="text-sm text-red-700">
                ⚠️ {formError}
              </p>
            )}
            {createError && (
              <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 break-keep">
                <p>⚠️ {errorText(createError)}</p>
                {createError.retryable && (
                  <button type="button" onClick={() => void create()} className="mt-1 min-h-[44px] font-bold underline">
                    다시 시도
                  </button>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => void create()}
              disabled={creating}
              className={`w-full min-h-[48px] rounded-xl text-white font-bold transition disabled:opacity-50 focus:outline-none focus-visible:ring-2 ${theme.btn} ${theme.ring}`}
            >
              {creating ? '만드는 중...' : `${theme.badge} 코드 만들기`}
            </button>
          </div>
        )}

        {/* 만든(또는 고른) 초대: QR · 코드 · 링크 */}
        {shown && (
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 flex flex-col items-center text-center">
            <p className="text-sm font-bold text-gray-800">{theme.badge} 코드</p>
            <div className="mt-3">
              {qrDataUrl ? (
                <img src={qrDataUrl} alt={`${theme.badge} QR 코드`} className="w-56 h-56 sm:w-64 sm:h-64 rounded-xl border border-gray-200 bg-white" />
              ) : qrFailed ? (
                <p className="text-sm text-red-700">QR을 그리지 못했어요. 아래 코드나 링크를 알려 주세요.</p>
              ) : (
                <div className="w-56 h-56 rounded-xl border border-gray-200 bg-white flex items-center justify-center" aria-label="QR 준비 중">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-500" />
                </div>
              )}
            </div>
            <p className="mt-4 font-mono text-3xl font-extrabold tracking-widest text-gray-900 select-all">{shown.displayCode}</p>
            <div className="mt-3 grid w-full grid-cols-1 gap-2 sm:grid-cols-3">
              <button
                type="button"
                onClick={() => void copy(shown.displayCode, '초대 코드')}
                className="min-h-[44px] rounded-lg border border-gray-300 bg-white px-3 text-sm font-bold text-gray-800 hover:bg-gray-100"
              >
                코드 복사
              </button>
              <button
                type="button"
                onClick={() => void copy(shareUrl, '초대 링크')}
                disabled={!shareUrl}
                className="min-h-[44px] rounded-lg border border-gray-300 bg-white px-3 text-sm font-bold text-gray-800 hover:bg-gray-100 disabled:opacity-50"
              >
                링크 복사
              </button>
              <button
                type="button"
                onClick={() => void share()}
                disabled={!shareUrl}
                className="min-h-[44px] rounded-lg border border-gray-300 bg-white px-3 text-sm font-bold text-gray-800 hover:bg-gray-100 disabled:opacity-50"
              >
                공유하기
              </button>
            </div>
            {shareUrl && <p className="mt-2 w-full break-all text-xs text-gray-600">{shareUrl}</p>}
            <p className="mt-2 text-sm text-gray-700">
              만료 {formatMsDate(shown.expiresAt)} · {usesText(shown.uses, shown.maxUses)}
            </p>
            <p className="mt-2 text-xs text-gray-500 break-keep">
              학생은 카메라로 QR을 찍거나, 링크를 열거나, 앱의 &apos;초대 코드 입력&apos;에 코드를 넣으면 돼요.
            </p>
            <button type="button" onClick={() => setShown(null)} className="mt-2 min-h-[44px] px-3 text-sm text-gray-500 underline">
              QR 닫기
            </button>
          </div>
        )}

        {/* 발급한 초대 목록 */}
        <div>
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-bold text-gray-800">발급한 {theme.badge}</h4>
            <button type="button" onClick={() => void loadList()} disabled={listLoading} className="min-h-[44px] px-2 text-sm text-gray-500 underline disabled:opacity-50">
              {listLoading ? '불러오는 중...' : '새로고침'}
            </button>
          </div>
          {listError ? (
            <div role="alert" className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 break-keep">
              <p>⚠️ 초대 목록을 불러오지 못했어요. {errorText(listError)}</p>
              {listError.retryable && (
                <button type="button" onClick={() => void loadList()} className="mt-1 min-h-[44px] font-bold underline">
                  다시 시도
                </button>
              )}
            </div>
          ) : rows === null ? (
            <p className="mt-2 text-sm text-gray-400">불러오는 중...</p>
          ) : rows.length === 0 ? (
            <p className="mt-2 text-sm text-gray-500">아직 만든 초대 코드가 없어요.</p>
          ) : (
            <ul className="mt-2 divide-y divide-gray-100 rounded-lg border border-gray-200">
              {rows.map((row) => {
                const st = STATE_STYLE[row.state] || STATE_STYLE['not-found']
                return (
                  <li key={row.code} className="px-3 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-base font-bold tracking-wider">{row.displayCode}</span>
                      <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-bold ${st.cls}`}>
                        <span aria-hidden="true">{st.icon}</span>
                        {INVITE_STATE_LABEL[row.state] || row.state}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-gray-700">
                      {usesText(row.uses, row.maxUses)} · 만료 {formatMsDate(row.expiresAt)}
                    </p>
                    <p className="text-xs text-gray-500">
                      {formatMsDate(row.createdAt)} 발급{!row.mine && row.issuedByName ? ` · ${row.issuedByName} 선생님` : ''}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {row.state === 'ok' && (
                        <button
                          type="button"
                          onClick={() => showRow(row)}
                          className="min-h-[44px] rounded-lg border border-gray-300 bg-white px-4 text-sm font-bold text-gray-800 hover:bg-gray-50"
                        >
                          QR 보기
                        </button>
                      )}
                      {!row.revoked && (
                        <button
                          type="button"
                          onClick={() => void revoke(row)}
                          disabled={busyCode === row.code}
                          className="min-h-[44px] rounded-lg border border-red-200 bg-red-50 px-4 text-sm font-bold text-red-700 hover:bg-red-100 disabled:opacity-50"
                        >
                          {busyCode === row.code ? '회수 중...' : '회수'}
                        </button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}
