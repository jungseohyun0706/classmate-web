import type { NextApiRequest, NextApiResponse } from 'next'
import { getFirestore } from 'firebase-admin/firestore'
import { getAdminApp, isAdminConfigured } from '../../lib/fcm-admin'

// POST /api/join-info
// Body: { classId, token }
// QR의 입장 토큰이 유효하면 학급 표시 정보를 돌려줍니다.
// 로그인 불필요 — 유효한 토큰 자체가 자격증명입니다. (신규 학생은 아직 계정이 없음)

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '허용되지 않는 요청입니다.' })
  }
  if (!isAdminConfigured()) {
    return res.status(503).json({ error: '서버 설정이 없어요. 관리자에게 문의해 주세요.' })
  }

  const { classId, token } = (req.body ?? {}) as { classId?: unknown; token?: unknown }
  if (
    typeof classId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(classId) ||
    typeof token !== 'string' ||
    !/^[a-f0-9]{32}$/.test(token)
  ) {
    return res.status(400).json({ error: '입장 코드가 올바르지 않아요.' })
  }

  try {
    const app = getAdminApp()
    if (!app) return res.status(503).json({ error: '서버 초기화에 실패했어요.' })
    const db = getFirestore(app)

    const tokenSnap = await db
      .collection('classes')
      .doc(classId)
      .collection('joinTokens')
      .doc(token)
      .get()
    const expiresAt = tokenSnap.exists ? tokenSnap.get('expiresAt') : null
    if (!tokenSnap.exists || !expiresAt || expiresAt.toMillis() <= Date.now()) {
      return res.status(410).json({ error: '입장 코드가 만료되었거나 잘못되었어요.' })
    }

    const classSnap = await db.collection('classes').doc(classId).get()
    if (!classSnap.exists) {
      return res.status(404).json({ error: '학급 정보를 찾을 수 없어요.' })
    }
    const cls = classSnap.data() || {}
    return res.status(200).json({
      ok: true,
      classInfo: {
        classId,
        schoolName: String(cls.schoolName ?? ''),
        grade: cls.grade ?? '',
        classNm: cls.classNm ?? '',
        teacherName: cls.teacherName ? String(cls.teacherName) : undefined,
      },
    })
  } catch (e) {
    console.error('join-info error:', e)
    return res.status(500).json({ error: '확인 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.' })
  }
}
