/**
 * Firebase ID 토큰 검증 (REST).
 *
 * firebase-admin/auth 는 jwks-rsa → jose(ESM 전용)를 require 하는데,
 * Vercel 서버리스 런타임에서 ERR_REQUIRE_ESM 으로 로드에 실패한다.
 * 토큰 검증은 Identity Toolkit REST(accounts:lookup)로 대체한다 —
 * 서명·만료·프로젝트 소속을 Google이 검증해 주므로 안전하다.
 */
export interface VerifiedUser {
  uid: string
  email: string | null
  name: string | null
  emailVerified: boolean
  providers: string[]
}

const LOOKUP_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:lookup'

export async function verifyIdToken(idToken: string): Promise<VerifiedUser | null> {
  const key = process.env.FIREBASE_WEB_API_KEY || process.env.NEXT_PUBLIC_FIREBASE_API_KEY
  if (!key) throw new Error('FIREBASE_WEB_API_KEY(또는 NEXT_PUBLIC_FIREBASE_API_KEY)가 없습니다.')

  const res = await fetch(`${LOOKUP_URL}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  })

  if (!res.ok) return null // 만료/위조/다른 프로젝트 토큰
  const data = await res.json().catch(() => null)
  const u = data?.users?.[0]
  if (!u?.localId) return null

  return {
    uid: u.localId,
    email: u.email ?? null,
    name: u.displayName ?? null,
    emailVerified: Boolean(u.emailVerified),
    providers: Array.isArray(u.providerUserInfo) ? u.providerUserInfo.map((p: any) => p.providerId) : [],
  }
}
