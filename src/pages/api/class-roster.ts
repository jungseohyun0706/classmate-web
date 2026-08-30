import type { NextApiRequest, NextApiResponse } from 'next'
import { getFirestore } from 'firebase-admin/firestore'
import { getAdminApp, isAdminConfigured, verifyIdToken } from '../../lib/fcm-admin'

// GET /api/class-roster?classId=...
// Header: Authorization: Bearer <Firebase ID token>
// 반 구성원 명단/인원수를 서버(admin)에서 내려줍니다.
// 서버에서 처리하는 이유: 본반(classId==) + 추가 참여(extraClassIds array-contains)를
// 합치는 목록 쿼리는 보안 규칙만으로는 증명이 불가능해 클라이언트에서 항상 거부되기 때문.
// - 같은 학교 교사: 전체 명단(승인 대기 포함) + 인원수
// - 이 반의 승인된 학생: 인원수만

// 출석번호 등 숫자 필드가 '12번' 같은 값이어도 JSON에 NaN(null)이 새지 않게 정규화
function toFiniteNumber(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: '허용되지 않는 요청입니다.' })
  }
  if (!isAdminConfigured()) {
    return res.status(503).json({ error: '서버 설정이 없어요. 관리자에게 문의해 주세요.' })
  }

  const authHeader = req.headers.authorization || ''
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  const decoded = await verifyIdToken(idToken)
  if (!decoded) {
    return res.status(401).json({ error: '로그인이 필요해요. 다시 로그인해 주세요.' })
  }

  const classId = typeof req.query.classId === 'string' ? req.query.classId : ''
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(classId)) {
    return res.status(400).json({ error: '요청 형식이 올바르지 않아요.' })
  }

  try {
    const app = getAdminApp()
    if (!app) return res.status(503).json({ error: '서버 초기화에 실패했어요.' })
    const db = getFirestore(app)

    const [meSnap, classSnap] = await Promise.all([
      db.collection('users').doc(decoded.uid).get(),
      db.collection('classes').doc(classId).get(),
    ])
    if (!classSnap.exists) return res.status(404).json({ error: '학급 정보를 찾을 수 없어요.' })
    const me = meSnap.exists ? meSnap.data() || {} : {}
    const cls = classSnap.data() || {}

    const isSchoolTeacher =
      me.role === 'teacher' && String(me.schoolCode || '') === String(cls.schoolCode || '')
    const isClassStudent =
      me.role === 'student' &&
      me.status === 'approved' &&
      (me.classId === classId ||
        (Array.isArray(me.extraClassIds) && me.extraClassIds.includes(classId)))
    if (!isSchoolTeacher && !isClassStudent) {
      return res.status(403).json({ error: '이 반의 구성원만 볼 수 있어요.' })
    }

    // 본반 학생(승인 대기 포함) + 추가 참여 학생(승인된 학생만)
    const [homeSnap, extraSnap] = await Promise.all([
      db
        .collection('users')
        .where('classId', '==', classId)
        .where('role', '==', 'student')
        .get(),
      db
        .collection('users')
        .where('extraClassIds', 'array-contains', classId)
        .where('role', '==', 'student')
        .where('status', '==', 'approved')
        .get(),
    ])

    type Member = {
      id: string
      name: string
      studentId: number
      status: 'pending' | 'approved'
      homeClassId?: string
    }
    const seen: Record<string, true> = {}
    const members: Member[] = []
    let approvedCount = 0

    homeSnap.forEach((d) => {
      const v = d.data()
      if (v.status === 'rejected') return
      seen[d.id] = true
      const status: Member['status'] = v.status === 'approved' ? 'approved' : 'pending'
      if (status === 'approved') approvedCount += 1
      members.push({
        id: d.id,
        name: String(v.name || v.displayName || '이름 없음'),
        studentId: toFiniteNumber(v.studentId),
        status,
      })
    })
    extraSnap.forEach((d) => {
      if (seen[d.id]) return
      const v = d.data()
      approvedCount += 1
      members.push({
        id: d.id,
        name: String(v.name || v.displayName || '이름 없음'),
        studentId: toFiniteNumber(v.studentId),
        status: 'approved',
        homeClassId: typeof v.classId === 'string' ? v.classId : undefined,
      })
    })

    // 인원수 = 승인된 학생 + 담임(그룹이면 소유 교사) 1명
    const count = approvedCount + (cls.teacherId ? 1 : 0)

    if (!isSchoolTeacher) {
      return res.status(200).json({ count })
    }
    return res.status(200).json({ count, members })
  } catch (e) {
    console.error('class-roster error:', e)
    return res.status(500).json({ error: '명단을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.' })
  }
}
