/**
 * 로그인 판단·로그인 뒤 갈 곳 — 순수 함수(브라우저·Firebase·React 없이 단위 테스트: tests/unit/auth-routing.test.ts)
 *
 * - 둘러보기(익명) 세션은 '로그인 안 됨'과 같게 봅니다. /meals 별점 집계가 signInAnonymously로 익명 계정을
 *   만들 수 있어, 익명 u를 로그인한 사용자로 보면 서버가 no-profile을 돌려주고 화면이 '가입 미완료'로 잘못 안내합니다.
 *   (/i/…·/join·usePendingInviteResume·student/courses와 같은 정책)
 * - 프로필(users 문서·role)이 없는 계정은 보관된 초대(cm_pending_invite_v1)만으로 초대 화면에 자동으로 보내지 않습니다.
 *   이 브라우저에 남은 초대 때문에 구글로 처음 로그인한 선생님이 교사 인증 단계로 갈 수 없고, 초대를 수락하면
 *   학생 프로필이 생겨 버리기 때문입니다. 초대 화면에서 '로그인하고 참여'를 눌러 ?next=/i/…로 온 경우만 그 초대로 이어갑니다.
 *
 * 경로 문자열 규칙(초대 경로 판별·/i/코드 만들기)은 src/lib/pendingInvite.ts가 맡고, 여기서는 그 결과만 받습니다.
 */

/** 로그인 판단에 필요한 최소 모양(Firebase User의 일부) */
export interface AuthUserLike {
  readonly isAnonymous: boolean
}

/** 실제 계정으로 로그인했는지 — null·익명(둘러보기)은 false */
export function isSignedInUser<T extends AuthUserLike>(u: T | null | undefined): u is T {
  return !!u && !u.isAnonymous
}

/**
 * 로그인 화면 주소(?next=돌아올 주소).
 * 지금 주소(asPath)가 screenPath 화면이면 쿼리(예: ?date=)까지 그대로, 아니면 screenPath로 돌아오게 합니다.
 * (로그인 화면은 next를 같은 사이트 상대 경로만 받습니다 — safeNextPath)
 */
export function loginPathWithNext(asPath: string | null | undefined, screenPath: string): string {
  const back = asPath && asPath.startsWith(screenPath) ? asPath : screenPath
  return `/auth/login?next=${encodeURIComponent(back)}`
}

/** 프로필 없는 계정의 로그인 뒤 단계 */
export type MissingProfileStep =
  /** ?next로 명시된 초대 화면으로 이어감 */
  | { kind: 'invite'; path: string }
  /** 학생(초대로 이어서 참여) / 선생님(교사 인증) 갈래 화면 — resumeCode는 보관된 초대 코드(학생 쪽 버튼에만 씀) */
  | { kind: 'choose'; resumeCode: string | null }

/**
 * 프로필 없는 계정이 로그인한 뒤 갈 곳.
 * @param inviteNext ?next가 초대 경로(/i/…, /join?…)일 때 그 경로, 아니면 null
 * @param pendingCode 이 브라우저에 보관된 초대 코드(없으면 null)
 */
export function missingProfileStep(inviteNext: string | null, pendingCode: string | null): MissingProfileStep {
  if (inviteNext) return { kind: 'invite', path: inviteNext }
  return { kind: 'choose', resumeCode: pendingCode || null }
}
