import type { NextApiRequest, NextApiResponse } from 'next'
import { getFirestore } from 'firebase-admin/firestore'
import { getAdminApp, isAdminConfigured, verifyIdToken } from '../../lib/fcm-admin'

// GET /api/class-roster?classId=...
// Header: Authorization: Bearer <Firebase ID token>
// 반 구성원 명단/인원수를 서버(admin)에서 내려줍니다.
// 서버에서 처리하는 이유: 본반(classId==) + 추가 참여(extraClassIds array-contains)를
// 합치는 목록 쿼리는 보안 규칙만으로는 증명이 불가능해 클라이언트에서 항상 거부되기 때문.
// - 같은 학교 교사: 전체 명단(승인 대기 포함) + 인원수
//   (이 반 담임이면 다른 반에서 옮겨 오려는 반 이동 신청 학생도 승인 대기로 포함)
// - 이 반의 승인된 학생: 인원수만

// 출석번호는 가입 때 선택 항목이라 없는 학생이 많음. 없거나 숫자가 아니면 0이 아니라 null('번호 없음')로
// 내려줘야 화면에서 0번으로 표시·맨 앞 정렬되지 않음
function toStudentNo(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
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
    const isClassTeacher = isSchoolTeacher && String(cls.teacherId || '') === decoded.uid

    // 본반 학생(승인 대기 포함) + 추가 참여 학생(승인된 학생만) + 반 이동 신청 학생(담임에게만)
    const [homeSnap, extraSnap, moveSnap] = await Promise.all([
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
      isClassTeacher
        ? db
            .collection('users')
            .where('pendingClassId', '==', classId)
            .where('role', '==', 'student')
            .get()
        : null,
    ])

    type Member = {
      id: string
      name: string
      studentId: number | null
      status: 'pending' | 'approved'
      homeClassId?: string
      /** 반 이동 신청 학생의 지금 본반 classId */
      moveFromClassId?: string
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
        studentId: toStudentNo(v.studentId),
        status,
      })
    })
    // 추가 참여보다 먼저 넣음: 예전에 이 반에 추가 참여했던 학생이 이동 신청하면 승인할 수 있게
    moveSnap?.forEach((d) => {
      if (seen[d.id]) return
      const v = d.data()
      if (cls.schoolCode && String(v.schoolCode || '') !== String(cls.schoolCode)) return
      seen[d.id] = true
      members.push({
        id: d.id,
        name: String(v.name || v.displayName || '이름 없음'),
        studentId: toStudentNo(v.pendingStudentId ?? v.studentId),
        status: 'pending',
        moveFromClassId: typeof v.classId === 'string' ? v.classId : undefined,
      })
    })
    extraSnap.forEach((d) => {
      if (seen[d.id]) return
      const v = d.data()
      approvedCount += 1
      members.push({
        id: d.id,
        name: String(v.name || v.displayName || '이름 없음'),
        studentId: toStudentNo(v.studentId),
        status: 'approved',
        homeClassId: typeof v.classId === 'string' ? v.classId : undefined,
      })
    })

    // 인원수 = 승인된 학생 + 담임(그룹이면 소유 교사) 1명
    const count = approvedCount + (cls.teacherId ? 1 : 0)

    if (!isSchoolTeacher) {
      return res.status(200).json({ count })
    }
    return res.status(200).json({ count, members, isClassTeacher })
  } catch (e) {
    console.error('class-roster error:', e)
    return res.status(500).json({ error: '명단을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.' })
  }
}
