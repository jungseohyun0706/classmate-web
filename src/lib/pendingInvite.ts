/**
 * 초대 코드 입력·보관·이어가기 — 클라이언트 전용(브라우저)
 *
 * - 초대 코드 형식은 서버(src/lib/invitations.ts)와 같습니다: 헷갈리는 0·1·I·L·O를 뺀 31자 알파벳 8자리, 표시 XXXX-XXXX.
 *   서버 파일은 firebase-admin을 불러오므로 클라이언트에서 import하지 않고 같은 규칙을 여기 둡니다.
 * - 로그인·가입 화면으로 갔다가 돌아올 때 초대가 사라지지 않게 localStorage에 '코드만' 7일 동안 보관합니다
 *   (이름·학교 등 개인정보는 저장하지 않음). 설치한 앱(특히 iOS 홈 화면 앱)은 브라우저 저장소를 공유하지 않을 수 있어
 *   이 값이 항상 이어진다고 가정하지 않습니다 — 화면은 언제나 코드 입력·원래 링크 다시 열기를 함께 제공합니다.
 * - 로그인 뒤 이동할 경로(?next=)는 safeNextPath로 같은 사이트 상대 경로만 허용합니다(임의 리디렉션 방지).
 * - 초대 코드·토큰을 console에 남기지 마세요.
 *
 * Firebase SDK는 usePendingInviteResume 안에서만 필요할 때 불러옵니다(랜딩 등 첫 화면 번들을 키우지 않게).
 */
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/router'

/** 헷갈리는 문자(0·1·I·L·O)를 뺀 31자 — src/lib/invitations.ts INVITE_ALPHABET과 같아야 합니다 */
export const INVITE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
export const INVITE_CODE_LENGTH = 8
const INVITE_CODE_RE = new RegExp(`^[${INVITE_ALPHABET}]{${INVITE_CODE_LENGTH}}$`)

const STORAGE_KEY = 'cm_pending_invite_v1'
/** 보관 기간 7일 — 지나면 읽을 때 지웁니다 */
export const PENDING_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 자동 이어가기를 이 탭에서 이미 한 코드(같은 초대로 계속 끌려가지 않게) */
const RESUMED_KEY = 'cm_pending_invite_resumed_v1'

/**
 * 사람이 입력·붙여넣은 값 → 정규화된 8자 코드. 형식이 틀리면 null.
 * 하이픈·공백·소문자를 허용하고, 초대 링크 전체(…/i/ABCD-2345)를 붙여넣어도 코드만 꺼냅니다.
 * (서버 normalizeInviteCode와 같은 규칙)
 */
export function normalizeInviteCode(input: unknown): string | null {
  if (typeof input !== 'string') return null
  let s = input.trim()
  if (!s || s.length > 200) return null
  const m = /\/i\/([^/?#\s]+)/.exec(s)
  if (m) s = m[1]
  try {
    s = decodeURIComponent(s)
  } catch {
    // 잘못된 % 인코딩은 그대로 두고 아래 형식 검사에서 거름
  }
  s = s.replace(/[\s\-‐-―_.]/g, '').toUpperCase()
  return INVITE_CODE_RE.test(s) ? s : null
}

/** 'ABCD2345' → 'ABCD-2345' */
export function formatInviteCode(code: string): string {
  return code.length === INVITE_CODE_LENGTH ? `${code.slice(0, 4)}-${code.slice(4)}` : code
}

/** 초대 화면 경로 */
export function invitePath(code: string): string {
  return `/i/${code}`
}

/** 초대(새 초대 코드 /i/… 또는 예전 QR 링크 /join?…)로 가는 경로인지 */
export function isInvitePath(path: string | null | undefined): boolean {
  if (!path) return false
  return path.startsWith('/i/') || path === '/join' || path.startsWith('/join?')
}

function storage(kind: 'local' | 'session'): Storage | null {
  try {
    if (typeof window === 'undefined') return null
    return kind === 'local' ? window.localStorage : window.sessionStorage
  } catch {
    // 사파리 프라이빗 모드 등 저장소를 쓸 수 없는 환경
    return null
  }
}

/** 초대 코드를 7일 동안 보관(코드만). 형식이 틀린 값은 저장하지 않음 */
export function savePendingInvite(code: string): void {
  const normalized = normalizeInviteCode(code)
  const ls = storage('local')
  if (!normalized || !ls) return
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify({ code: normalized, savedAt: Date.now() }))
  } catch {
    // 저장 공간 부족 등 — 초대 화면이 코드 입력 경로를 함께 보여 주므로 무시
  }
}

/** 보관 중인 초대 코드(정규화된 8자). 없거나 7일이 지났거나 형식이 틀리면 null(지난 값은 지움) */
export function readPendingInvite(): string | null {
  const ls = storage('local')
  if (!ls) return null
  try {
    const raw = ls.getItem(STORAGE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as { code?: unknown; savedAt?: unknown }
    const code = normalizeInviteCode(v && v.code)
    const savedAt = typeof v?.savedAt === 'number' ? v.savedAt : NaN
    const age = Date.now() - savedAt
    if (!code || !Number.isFinite(savedAt) || age > PENDING_INVITE_TTL_MS || age < -PENDING_INVITE_TTL_MS) {
      ls.removeItem(STORAGE_KEY)
      return null
    }
    return code
  } catch {
    try {
      ls.removeItem(STORAGE_KEY)
    } catch {}
    return null
  }
}

export function clearPendingInvite(): void {
  const ls = storage('local')
  if (ls) {
    try {
      ls.removeItem(STORAGE_KEY)
    } catch {}
  }
  const ss = storage('session')
  if (ss) {
    try {
      ss.removeItem(RESUMED_KEY)
    } catch {}
  }
}

const SAFE_NEXT_BASE = 'https://classmate.invalid'

/**
 * 로그인·가입 뒤 이동할 경로 검증: '/'로 시작하는 같은 사이트 상대 경로만 허용하고 아니면 null.
 * '//' · '/\' (다른 사이트로 해석됨), 역슬래시, 제어문자·탭·줄바꿈(브라우저가 지워 '//'가 될 수 있음), 스킴(javascript: 등)은 거부.
 * 반환값은 정리된 경로(pathname + search + hash).
 */
export function safeNextPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw
  if (!v || v.length > 512) return null
  if (v[0] !== '/') return null
  if (v.startsWith('//') || v.startsWith('/\\')) return null
  if (/[\u0000-\u001f\u007f\\]/.test(v)) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null
  try {
    const u = new URL(v, SAFE_NEXT_BASE)
    if (u.origin !== SAFE_NEXT_BASE) return null
    const out = u.pathname + u.search + u.hash
    if (!out.startsWith('/') || out.startsWith('//')) return null
    return out
  } catch {
    return null
  }
}

/**
 * 로그인(익명 제외)되어 있고 보관 중인 초대가 있으면 한 번만 router.replace('/i/'+code).
 * 대시보드·학생 화면 등 로그인 뒤 처음 도착하는 화면에서 호출합니다.
 * - 같은 탭에서 같은 코드로는 한 번만 이어갑니다(만료·교사 계정 등으로 수락하지 못한 초대에 계속 끌려가지 않게).
 * - 이미 초대 화면(/i/…)이면 아무것도 하지 않습니다.
 * 반환값: 초대 화면으로 이동을 시작했으면 true(화면은 잠깐 로딩 표시를 유지하면 됨).
 */
export function usePendingInviteResume(): boolean {
  const router = useRouter()
  const doneRef = useRef(false)
  const [resuming, setResuming] = useState(false)

  useEffect(() => {
    if (!router.isReady) return
    if (router.pathname === '/i/[code]') return
    let cancelled = false
    let unsub: (() => void) | null = null
    ;(async () => {
      try {
        const [{ auth }, { onAuthStateChanged }] = await Promise.all([import('./firebase'), import('firebase/auth')])
        if (cancelled || !auth) return
        unsub = onAuthStateChanged(auth, (u) => {
          if (cancelled || doneRef.current || !u || u.isAnonymous) return
          const code = readPendingInvite()
          if (!code) return
          const ss = storage('session')
          try {
            if (ss && ss.getItem(RESUMED_KEY) === code) return
            if (ss) ss.setItem(RESUMED_KEY, code)
          } catch {}
          doneRef.current = true
          setResuming(true)
          router.replace(invitePath(code)).catch(() => setResuming(false))
        })
      } catch {
        // Firebase를 불러오지 못하면 이어가기를 건너뜀(화면의 초대 코드 입력으로 진행 가능)
      }
    })()
    return () => {
      cancelled = true
      if (unsub) unsub()
    }
  }, [router, router.isReady, router.pathname])

  return resuming
}
