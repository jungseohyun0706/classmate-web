// 회원 탈퇴 공통 규칙 — 탈퇴 화면(클라이언트)과 /api/account/delete(서버)가 함께 씁니다.
// Firebase SDK를 불러오지 않는 순수 함수만 둡니다. (검사: node --test scripts/test-account-deletion.cjs)

/** 탈퇴 확인란에 그대로 입력해야 하는 낱말 */
export const ACCOUNT_DELETE_CONFIRM = '탈퇴'

/** 탈퇴 화면 주소 — Play Console 데이터 보안 양식의 '계정 삭제 URL'로도 씁니다. */
export const ACCOUNT_DELETE_PATH = '/account/delete'

/** 개인정보 문의·삭제 요청을 받는 메일 주소 (개인정보처리방침과 같은 값) */
export const PRIVACY_CONTACT_EMAIL = 'jungseohyun7@gmail.com'

/** 다른 선생님 기록(수업 교환·보결·학교 시간표 업로드)에 남기는 이름 */
export const DELETED_TEACHER_NAME = '탈퇴한 선생님'

/** 담임 자리를 비울 때 반 문서에 쓰는 이름 (반 바꾸기와 같은 값) */
export const RELEASED_TEACHER_NAME = '담임 미정'

/**
 * 이 시간 안에 로그인한 경우만 탈퇴를 받습니다.
 * 로그인해 둔 기기를 다른 사람이 집어 탈퇴시키는 일을 막으려는 것으로, Firebase가 계정 삭제에
 * 최근 로그인을 요구하는 것과 같은 취지입니다.
 */
export const RECENT_LOGIN_MAX_AGE_SEC = 10 * 60

/** 마지막 로그인 시각(초)이 RECENT_LOGIN_MAX_AGE_SEC 안인지 */
export function isRecentLogin(authTimeSec: unknown, nowMs: number = Date.now()): boolean {
  return (
    typeof authTimeSec === 'number' &&
    Number.isFinite(authTimeSec) &&
    nowMs / 1000 - authTimeSec <= RECENT_LOGIN_MAX_AGE_SEC
  )
}

/** Firestore 문서 ID로 써도 되는 값인지 (users 문서의 반 ID 등을 경로에 넣기 전에 확인) */
export function isSafeDocId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)
}

/**
 * 첨부 목록에서 prefix 폴더 안의 파일 경로만 고릅니다.
 * (메시지: chat-files/{classId}/{messageId}/, 전송 전 임시본: chat-staging/{classId}/{requestId}/)
 */
export function filesUnder(prefix: string, attachments: unknown): string[] {
  if (!Array.isArray(attachments)) return []
  return attachments
    .map((a) => (a && typeof a === 'object' ? (a as { path?: unknown }).path : undefined))
    .filter((p): p is string => typeof p === 'string' && p.startsWith(prefix) && !p.includes('..'))
}

/**
 * 예전 알림장 첨부(attachmentUrl)는 기본 Storage 버킷의 notices/ 아래에 올렸습니다.
 * Firebase 다운로드 주소에서 그 파일 경로를 꺼냅니다. 다른 버킷·폴더이거나 형식이 다르면 null.
 */
export function legacyNoticeFilePath(url: unknown, bucket: string | undefined): string | null {
  if (typeof url !== 'string' || !bucket) return null
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' || u.hostname !== 'firebasestorage.googleapis.com') return null
    const m = u.pathname.match(/^\/v0\/b\/([^/]+)\/o\/([^/]+)$/)
    if (!m || m[1] !== bucket) return null
    const path = decodeURIComponent(m[2])
    return path.startsWith('notices/') && !path.includes('..') ? path : null
  } catch {
    return null
  }
}

/** 문서에 덮어쓸 값과 서버 시각을 넣을 필드 */
export interface RecordPatch {
  set: Record<string, string>
  now: string[]
}

/**
 * 수업 교환·보결 요청 문서에서 탈퇴하는 선생님(uid)의 이름을 지우고,
 * 아직 처리되지 않은 요청은 상대가 기다리지 않게 닫습니다. 바꿀 것이 없으면 null.
 * - 'swap': school_swaps/{학교}/direct_requests·requests (예전 문서는 requesterId 대신 fromId)
 * - 'sos' : school_sos/{학교}/requests
 * 끝난 교환·보결은 상대 선생님 시간표의 근거라 기록을 남기고 이름만 바꿉니다.
 */
export function anonymizeRequestPatch(
  kind: 'swap' | 'sos',
  data: Record<string, unknown>,
  uid: string
): RecordPatch | null {
  const set: Record<string, string> = {}
  const now: string[] = []
  const rename = (field: string): void => {
    if (typeof data[field] === 'string' && data[field] !== DELETED_TEACHER_NAME) set[field] = DELETED_TEACHER_NAME
  }

  if (kind === 'sos') {
    const open = (data.status ?? 'open') === 'open'
    if (data.requesterId === uid) {
      rename('requesterName')
      if (open) {
        set.status = 'cancelled'
        now.push('cancelledAt')
      }
    }
    if (data.assignedTo === uid) rename('assignedName')
  } else {
    // status가 없는 예전 문서는 대기로 봅니다 (swaps.ts의 normalizeStatus, 보안 규칙의 swapOpen과 같음)
    const open = !['accepted', 'declined', 'cancelled'].includes(String(data.status ?? 'pending'))
    const requester = data.requesterId === uid || data.fromId === uid
    if (requester) {
      rename('requesterName')
      rename('fromName')
      if (open) {
        set.status = 'cancelled'
        now.push('cancelledAt')
      }
    }
    if (data.toId === uid) {
      rename('toName')
      if (open && !requester) {
        set.status = 'declined'
        set.declinerName = DELETED_TEACHER_NAME
        now.push('declinedAt')
      }
    }
    if (data.accepterId === uid) rename('accepterName')
    if (data.declinerId === uid) rename('declinerName')
  }

  return Object.keys(set).length > 0 || now.length > 0 ? { set, now } : null
}
