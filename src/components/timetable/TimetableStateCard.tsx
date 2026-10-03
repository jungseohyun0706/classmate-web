import type { JSX, ReactNode } from 'react'
import Link from 'next/link'
import { invitePath, readPendingInvite } from '../../lib/pendingInvite'
import type { TimetableErrorKind } from '../../lib/timetable/client'
import type { DayState } from '../../lib/timetable/types'

/**
 * 개인 시간표 상태 카드 — 요구 문서 3절 상태표의 문구·버튼 그대로.
 * 원인을 모르는 오류는 '수업이 없어요'로 표시하지 않습니다(server·offline은 다시 시도).
 */
export type TimetableStateKind =
  | 'login' // 로그인 필요
  | 'no-profile' // 가입 미완료
  | 'no-school' // 학교 미설정
  | 'no-homeroom' // 소속 학급 미설정(그룹이 소속처럼 저장된 예전 학생 포함)
  | 'no-courses' // 참여한 수업 없음
  | 'not-registered' // 시간표 미등록
  | 'outside-term' // 학기 밖
  | 'no-lessons' // 수업 없는 정상 날짜
  | 'holiday' // 휴업일
  | 'offline' // 오프라인·캐시 없음
  | 'forbidden' // 권한 오류
  | 'not-student' // 학생 계정 아님
  | 'server' // 서버 오류

/** 내 수업 화면(U2) 앵커 */
export const COURSES_LINKS = {
  manage: '/student/courses',
  invite: '/student/courses#invite',
  catalog: '/student/courses#catalog',
  personal: '/student/courses#personal',
} as const

/** '내 정보 확인' — 학생 전용 내 정보 화면이 없어 내 수업 화면(소속·참여 수업 표시)으로 */
export const PROFILE_HREF = COURSES_LINKS.manage

export function stateKindForError(kind: TimetableErrorKind): TimetableStateKind {
  switch (kind) {
    case 'unauthenticated':
      return 'login'
    case 'no-profile':
      return 'no-profile'
    case 'no-school':
      return 'no-school'
    case 'not-student':
      return 'not-student'
    case 'forbidden':
      return 'forbidden'
    case 'offline':
      return 'offline'
    default:
      return 'server'
  }
}

export function stateKindForDay(state: DayState): TimetableStateKind | null {
  switch (state) {
    case 'no-courses':
    case 'not-registered':
    case 'outside-term':
    case 'no-lessons':
    case 'holiday':
      return state
    default:
      return null
  }
}

export interface TimetableStateCardProps {
  kind: TimetableStateKind
  compact?: boolean
  /** 보고 있는 날짜가 오늘인지(휴일 문구 '오늘은'/'이 날은', '오늘로' 버튼) */
  isToday?: boolean
  offDayName?: string | null
  /** 서버 오류 code */
  code?: string | null
  onRetry?: () => void
  onGoToday?: () => void
  /** '학급 시간표(참고)' 펼치기 — 볼 수 없으면 생략(버튼 숨김) */
  onShowClassReference?: (() => void) | null
}

type Tone = 'neutral' | 'info' | 'warn' | 'error'

interface Spec {
  title: string
  desc?: string
  tone: Tone
  icon: 'calendar' | 'moon' | 'link' | 'user' | 'lock' | 'wifi' | 'alert' | 'school' | 'book'
  role?: 'status' | 'alert'
}

const TONE: Record<Tone, { box: string; icon: string }> = {
  neutral: { box: 'bg-gray-50 ring-gray-100', icon: 'bg-white text-gray-500 ring-1 ring-gray-200' },
  info: { box: 'bg-emerald-50/60 ring-emerald-100', icon: 'bg-white text-emerald-600 ring-1 ring-emerald-200' },
  warn: { box: 'bg-amber-50 ring-amber-200', icon: 'bg-white text-amber-600 ring-1 ring-amber-200' },
  error: { box: 'bg-rose-50 ring-rose-200', icon: 'bg-white text-rose-600 ring-1 ring-rose-200' },
}

function Icon({ name }: { name: Spec['icon'] }): JSX.Element {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: 'h-5 w-5',
    'aria-hidden': true,
  }
  switch (name) {
    case 'moon':
      return (
        <svg {...common}>
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
        </svg>
      )
    case 'link':
      return (
        <svg {...common}>
          <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
          <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
        </svg>
      )
    case 'user':
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21a8 8 0 0 1 16 0" />
        </svg>
      )
    case 'lock':
      return (
        <svg {...common}>
          <rect x="4" y="10" width="16" height="11" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </svg>
      )
    case 'wifi':
      return (
        <svg {...common}>
          <path d="M2 2l20 20" />
          <path d="M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5.2-2.8M12 20h.01M16.7 11.1A10 10 0 0 1 19 13M2 8.8a15 15 0 0 1 4.2-2.7M10.7 5.1A15 15 0 0 1 22 8.8" />
        </svg>
      )
    case 'alert':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5M12 16h.01" />
        </svg>
      )
    case 'school':
      return (
        <svg {...common}>
          <path d="M3 10.5 12 5l9 5.5" />
          <path d="M5 10v9h14v-9M10 19v-5h4v5" />
        </svg>
      )
    case 'book':
      return (
        <svg {...common}>
          <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z" />
          <path d="M4 19a2 2 0 0 1 2-2h13" />
        </svg>
      )
    default:
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M8 3v4M16 3v4M3 10h18" />
        </svg>
      )
  }
}

function specOf(props: TimetableStateCardProps): Spec {
  const { kind, isToday, offDayName, code } = props
  switch (kind) {
    case 'login':
      return { title: '로그인이 필요해요', tone: 'info', icon: 'user' }
    case 'no-profile':
      return {
        title: '가입이 아직 끝나지 않았어요',
        desc: '선생님께 받은 초대 코드를 입력하거나, 받은 초대 링크(QR)를 다시 열어 주세요.',
        tone: 'info',
        icon: 'link',
      }
    case 'no-school':
      return { title: '학교 정보가 없어요', desc: '초대 링크로 학급·수업에 먼저 참여해 주세요.', tone: 'warn', icon: 'school' }
    case 'no-homeroom':
      return {
        title: '소속 학급이 아직 없어요(수업은 따로 볼 수 있음)',
        desc: '담임 선생님의 학급 QR이나 초대 코드로 소속 학급을 등록해 주세요.',
        tone: 'warn',
        icon: 'school',
      }
    case 'no-courses':
      return {
        title: '아직 연결된 수업이 없어요',
        desc: '선생님께 받은 초대 코드로 수업에 참여하거나, 공식 수업을 찾거나, 직접 입력할 수 있어요.',
        tone: 'info',
        icon: 'link',
      }
    case 'not-registered':
      return { title: '수업은 연결됐지만 선생님이 아직 시간표를 등록하지 않았어요', tone: 'warn', icon: 'book' }
    case 'outside-term':
      return { title: '이 날짜는 등록된 학기 밖이에요', tone: 'neutral', icon: 'calendar' }
    case 'no-lessons':
      return { title: '이 날은 수업이 없어요', tone: 'neutral', icon: 'calendar' }
    case 'holiday':
      return {
        title: `${isToday ? '오늘은' : '이 날은'} 쉬는 날이에요${offDayName ? ` (${offDayName})` : ''}`,
        tone: 'neutral',
        icon: 'moon',
      }
    case 'offline':
      return { title: '인터넷 연결을 확인해 주세요', desc: '연결되면 다시 시도해 주세요.', tone: 'warn', icon: 'wifi', role: 'alert' }
    case 'forbidden':
      return { title: '이 시간표를 볼 권한이 없어요', tone: 'error', icon: 'lock', role: 'alert' }
    case 'not-student':
      return {
        title: '이 시간표를 볼 권한이 없어요',
        desc: '학생 개인 시간표는 학생 계정에서 볼 수 있어요.',
        tone: 'error',
        icon: 'lock',
        role: 'alert',
      }
    default:
      return {
        title: `시간표를 불러오지 못했어요${code ? ` (${code})` : ''}`,
        desc: '잠시 후 다시 시도해 주세요.',
        tone: 'error',
        icon: 'alert',
        role: 'alert',
      }
  }
}

const btnPrimary =
  'inline-flex min-h-11 items-center justify-center rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400'
const btnSecondary =
  'inline-flex min-h-11 items-center justify-center rounded-xl bg-white px-4 text-sm font-semibold text-emerald-700 ring-1 ring-emerald-200 transition-colors hover:bg-emerald-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400'

function LinkBtn({ href, children, primary }: { href: string; children: ReactNode; primary?: boolean }): JSX.Element {
  return (
    <Link href={href} className={primary ? btnPrimary : btnSecondary}>
      {children}
    </Link>
  )
}

function ActionBtn({ onClick, children, primary }: { onClick: () => void; children: ReactNode; primary?: boolean }): JSX.Element {
  return (
    <button type="button" onClick={onClick} className={primary ? btnPrimary : btnSecondary}>
      {children}
    </button>
  )
}

function actionsOf(props: TimetableStateCardProps): JSX.Element[] {
  const { kind, onRetry, onGoToday, onShowClassReference, isToday } = props
  const out: JSX.Element[] = []
  switch (kind) {
    case 'login':
      out.push(
        <LinkBtn key="login" href="/auth/login" primary>
          로그인
        </LinkBtn>
      )
      break
    case 'no-profile': {
      out.push(
        <LinkBtn key="invite" href={COURSES_LINKS.invite} primary>
          초대 코드 입력
        </LinkBtn>
      )
      // 로그인·설치 전에 열었던 초대(코드만 보관)가 있으면 그 초대 화면으로 다시
      const saved = typeof window !== 'undefined' ? readPendingInvite() : null
      if (saved) {
        out.push(
          <LinkBtn key="reopen" href={invitePath(saved)}>
            초대 링크 다시 열기
          </LinkBtn>
        )
      }
      break
    }
    case 'no-school':
    case 'forbidden':
      out.push(
        <LinkBtn key="profile" href={PROFILE_HREF} primary>
          내 정보 확인
        </LinkBtn>
      )
      break
    case 'not-student':
      out.push(
        <LinkBtn key="dash" href="/dashboard" primary>
          선생님 화면으로
        </LinkBtn>
      )
      break
    case 'no-homeroom':
      out.push(
        <LinkBtn key="invite" href={COURSES_LINKS.invite} primary>
          담임 초대 코드 입력
        </LinkBtn>
      )
      break
    case 'no-courses':
      out.push(
        <LinkBtn key="invite" href={COURSES_LINKS.invite} primary>
          초대 코드 입력
        </LinkBtn>,
        <LinkBtn key="catalog" href={COURSES_LINKS.catalog}>
          공식 수업 찾기
        </LinkBtn>,
        <LinkBtn key="personal" href={COURSES_LINKS.personal}>
          직접 입력
        </LinkBtn>
      )
      if (onShowClassReference) {
        out.push(
          <ActionBtn key="ref" onClick={onShowClassReference}>
            학급 시간표(참고) 보기
          </ActionBtn>
        )
      }
      break
    case 'not-registered':
      if (onShowClassReference) {
        out.push(
          <ActionBtn key="ref" onClick={onShowClassReference}>
            학급 시간표(참고)
          </ActionBtn>
        )
      }
      break
    case 'outside-term':
      if (onGoToday && !isToday) {
        out.push(
          <ActionBtn key="today" onClick={onGoToday} primary>
            오늘로
          </ActionBtn>
        )
      }
      break
    case 'offline':
    case 'server':
      if (onRetry) {
        out.push(
          <ActionBtn key="retry" onClick={onRetry} primary>
            다시 시도
          </ActionBtn>
        )
      }
      break
    default:
      break
  }
  return out
}

export default function TimetableStateCard(props: TimetableStateCardProps): JSX.Element {
  const spec = specOf(props)
  const tone = TONE[spec.tone]
  const actions = actionsOf(props)
  const compact = props.compact === true
  return (
    <div
      role={spec.role ?? 'status'}
      className={`rounded-xl ring-1 ${tone.box} ${compact ? 'px-4 py-4' : 'px-4 py-6'} ${compact ? 'text-left' : 'text-center'}`}
    >
      <div className={compact ? 'flex items-start gap-3' : ''}>
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tone.icon} ${compact ? '' : 'mx-auto'}`}
        >
          <Icon name={spec.icon} />
        </span>
        <div className={compact ? 'min-w-0 flex-1' : 'mt-3'}>
          <p className="text-sm font-semibold text-gray-900 break-keep wrap-anywhere">{spec.title}</p>
          {spec.desc && <p className="mt-1 text-xs leading-relaxed text-gray-500 break-keep">{spec.desc}</p>}
        </div>
      </div>
      {actions.length > 0 && (
        <div className={`mt-4 flex flex-wrap gap-2 ${compact ? '' : 'justify-center'}`}>{actions}</div>
      )}
    </div>
  )
}

/** 최초 로딩 스켈레톤 */
export function TimetableSkeleton({ rows = 4 }: { rows?: number }): JSX.Element {
  const items: JSX.Element[] = []
  for (let i = 0; i < rows; i++) items.push(<div key={i} className="h-16 rounded-xl bg-gray-100" />)
  return (
    <div className="animate-pulse space-y-2" role="status" aria-label="시간표를 불러오는 중">
      {items}
    </div>
  )
}

/**
 * 자료는 보이지만 최신 확인에 실패했을 때의 배너.
 * - offline: '마지막 동기화 HH:MM · 최근 변경이 반영되지 않았을 수 있어요' + 다시 시도
 * - server: '최신 시간표를 확인하지 못했어요 (code) · 마지막 동기화 HH:MM' + 다시 시도
 */
export function SyncBanner({
  kind,
  syncedLabel,
  code,
  onRetry,
  retrying,
}: {
  kind: 'offline' | 'server'
  syncedLabel: string | null
  code?: string | null
  onRetry?: () => void
  retrying?: boolean
}): JSX.Element {
  return (
    <div role="status" className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 ring-1 ring-amber-200">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true">
        {kind === 'offline' ? (
          <>
            <path d="M2 2l20 20" />
            <path d="M8.5 16.5a5 5 0 0 1 7 0M12 20h.01M16.7 11.1A10 10 0 0 1 19 13M5 13a10 10 0 0 1 5.2-2.8" />
          </>
        ) : (
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v5M12 16h.01" />
          </>
        )}
      </svg>
      <p className="min-w-0 flex-1 text-xs leading-relaxed text-amber-900 break-keep">
        {kind === 'offline' ? (
          <>
            <span className="font-semibold">마지막 동기화 {syncedLabel ?? '알 수 없음'}</span> · 최근 변경이 반영되지 않았을 수 있어요
          </>
        ) : (
          <>
            <span className="font-semibold">최신 시간표를 확인하지 못했어요{code ? ` (${code})` : ''}</span>
            {syncedLabel ? ` · 마지막 동기화 ${syncedLabel}` : ''}
          </>
        )}
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="-my-1.5 min-h-11 shrink-0 rounded-lg px-3 text-xs font-semibold text-amber-800 ring-1 ring-amber-300 transition-colors hover:bg-amber-100 disabled:opacity-60"
        >
          {retrying ? '확인 중…' : '다시 시도'}
        </button>
      )}
    </div>
  )
}
