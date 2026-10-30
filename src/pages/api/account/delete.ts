import type { NextApiRequest, NextApiResponse } from 'next'
import { getAdminApp, verifyIdToken } from '../../../lib/fcm-admin'
import { deleteAccount } from '../../../lib/account-delete-admin'
import { ACCOUNT_DELETE_CONFIRM, isRecentLogin } from '../../../lib/accountDeletion'

// POST /api/account/delete
// Header: Authorization: Bearer <Firebase ID token>
// Body: { confirm: '탈퇴' }
// 로그인한 본인 계정과 그 사람이 남긴 데이터를 지웁니다 (Google Play 계정 삭제 요건).
// 최근 10분 안에 로그인한 경우만 받습니다 — 오래 켜 둔 기기는 다시 로그인한 뒤 탈퇴합니다.
// 지우는 범위와 순서는 src/lib/account-delete-admin.ts, 설명은 docs/account-deletion.md.

export const config = { maxDuration: 60, api: { bodyParser: { sizeLimit: '1kb' } } }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'private, no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: '허용되지 않는 요청입니다.' })
  const decoded = await verifyIdToken((req.headers.authorization || '').replace(/^Bearer /, ''))
  if (!decoded) return res.status(401).json({ error: '다시 로그인해 주세요.' })
  if (!isRecentLogin(decoded.auth_time)) {
    return res
      .status(401)
      .json({ error: '보안을 위해 다시 로그인한 뒤 탈퇴해 주세요.', code: 'recent-login-required' })
  }
  if ((req.body || {}).confirm !== ACCOUNT_DELETE_CONFIRM) {
    return res.status(400).json({ error: `확인란에 '${ACCOUNT_DELETE_CONFIRM}'를 입력해 주세요.` })
  }
  const app = getAdminApp()
  if (!app) return res.status(503).json({ error: '지금은 탈퇴를 처리할 수 없어요. 잠시 후 다시 시도해 주세요.' })

  try {
    const summary = await deleteAccount(app, decoded.uid)
    console.info('account-delete: done', summary)
    return res.status(200).json({ ok: true })
  } catch (e) {
    console.error('account-delete:', e instanceof Error ? e.message : 'failed')
    return res.status(500).json({
      error: '탈퇴를 끝내지 못했어요. 잠시 후 다시 시도해 주세요. 계속 안 되면 메일로 요청해 주세요.',
    })
  }
}
