import type { NextApiRequest, NextApiResponse } from 'next'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { getAdminApp, isAdminConfigured, sendPushToUser, verifyIdToken } from '../../lib/fcm-admin'

// POST /api/join
// Header: Authorization: Bearer <Firebase ID token>
// Body: { classId, token, name, studentId? }
// 유효한 입장 토큰 + 로그인 계정이면 학생 프로필(users/{uid}, status:'pending')을
// 서버(admin)가 기록하고 담임에게 알림을 보냅니다.
// 서버에서 처리하는 이유: ① 신규 계정은 users 문서가 없어 보안 규칙상 학급/토큰을
// 읽을 수 없음 ② 토큰 검증을 클라이언트에 맡기면 우회 가능 ③ 재입장(반 변경/진급)은
// 규칙상 학생 본인이 classId/status를 바꿀 수 없으므로 서버만 처리 가능.

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
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
  if (decoded.firebase?.sign_in_provider === 'anonymous') {
    return res.status(403).json({ error: '익명 계정으로는 입장할 수 없어요. 계정을 만들어 주세요.' })
  }

  const { classId, token, name, studentId } = (req.body ?? {}) as Record<string, unknown>
  const cleanName = typeof name === 'string' ? name.trim().slice(0, 20) : ''
  const cleanStudentId = typeof studentId === 'string' ? studentId.trim().slice(0, 10) : ''
  if (
    typeof classId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(classId) ||
    typeof token !== 'string' ||
    !/^[a-f0-9]{32}$/.test(token) ||
    !cleanName
  ) {
    return res.status(400).json({ error: '요청 형식이 올바르지 않아요.' })
  }

  try {
    const app = getAdminApp()
    if (!app) return res.status(503).json({ error: '서버 초기화에 실패했어요.' })
    const db = getFirestore(app)

    // 1) 토큰 검증
    const tokenSnap = await db
      .collection('classes')
      .doc(classId)
      .collection('joinTokens')
      .doc(token)
      .get()
    const expiresAt = tokenSnap.exists ? tokenSnap.get('expiresAt') : null
    if (!tokenSnap.exists || !expiresAt || expiresAt.toMillis() <= Date.now()) {
      return res.status(410).json({ error: '입장 코드가 만료되었어요. 선생님께 새 코드를 요청해 주세요.' })
    }

    // 2) 학급 확인
    const classSnap = await db.collection('classes').doc(classId).get()
    if (!classSnap.exists) {
      return res.status(404).json({ error: '학급 정보를 찾을 수 없어요.' })
    }
    const cls = classSnap.data() || {}

    // 3) 기존 계정 상태 확인
    const userRef = db.collection('users').doc(decoded.uid)
    const existing = await userRef.get()
    const prev = existing.exists ? existing.data() || {} : {}
    if (prev.role === 'teacher') {
      return res.status(403).json({ error: '교사 계정으로는 학생 입장을 할 수 없어요.' })
    }

    // 본반이 확정(승인)된 학생: 본반은 그대로 두고, 다른 반 QR은 '추가 반' 참여로 처리
    // (이동수업·교과 반 대응 — 선생님이 직접 보여주는 QR이므로 별도 승인 없이 즉시 참여)
    if (prev.role === 'student' && prev.status === 'approved' && prev.classId) {
      if (prev.classId === classId) {
        return res.status(200).json({ ok: true, status: 'approved', already: true })
      }
      const extras: string[] = Array.isArray(prev.extraClassIds) ? prev.extraClassIds : []
      if (extras.includes(classId)) {
        return res.status(200).json({ ok: true, status: 'joined-extra', already: true })
      }
      await userRef.set({ extraClassIds: FieldValue.arrayUnion(classId) }, { merge: true })
      const extraTeacherId = cls.teacherId ? String(cls.teacherId) : ''
      if (extraTeacherId) {
        try {
          await db.collection('users').doc(extraTeacherId).collection('notifications').add({
            title: '수업 반 참여',
            body: `${String(prev.name || cleanName)} 학생이 ${cls.grade ?? ''}학년 ${cls.classNm ?? ''}반 톡방에 참여했어요`,
            url: '/teacher/students',
            createdAt: FieldValue.serverTimestamp(),
            read: false,
          })
        } catch (e) {
          console.error('join: extra notify failed:', e)
        }
      }
      return res.status(200).json({ ok: true, status: 'joined-extra' })
    }

    // 수업 그룹 QR은 본반(담임 반) 가입 후에만 추가 참여 가능 — 본반은 실제 학급이어야 함
    if (cls.isGroup === true) {
      return res.status(403).json({
        error: '이 QR은 수업 반이에요. 먼저 담임 선생님의 우리 반 QR로 가입한 뒤 다시 찍어 주세요.',
      })
    }

    // 4) 학생 프로필 기록 (재입장/반 이동 포함 — 항상 승인 대기로)
    const profile: Record<string, unknown> = {
      role: 'student',
      status: 'pending',
      classId,
      schoolCode: cls.schoolCode ?? null,
      schoolName: cls.schoolName ?? null,
      grade: cls.grade ?? null,
      classNm: cls.classNm ?? null,
      name: cleanName,
      displayName: cleanName,
      email: decoded.email || null,
    }
    if (cls.officeCode) profile.officeCode = cls.officeCode
    if (cleanStudentId) profile.studentId = cleanStudentId
    if (!existing.exists) profile.createdAt = FieldValue.serverTimestamp()
    await userRef.set(profile, { merge: true })

    // 5) 담임에게 인앱 알림 + 푸시 (실패해도 입장 신청은 성공)
    const teacherId = cls.teacherId ? String(cls.teacherId) : ''
    if (teacherId) {
      const title = '새 학생 입장 신청'
      const body = `${cleanName} 학생이 승인을 기다려요`
      const url = '/teacher/students'
      try {
        await db.collection('users').doc(teacherId).collection('notifications').add({
          title,
          body,
          url,
          createdAt: FieldValue.serverTimestamp(),
          read: false,
        })
        void sendPushToUser(teacherId, { title, body, url })
      } catch (e) {
        console.error('join: teacher notify failed:', e)
      }
    }

    return res.status(200).json({ ok: true, status: 'pending' })
  } catch (e) {
    console.error('join error:', e)
    return res.status(500).json({ error: '입장 신청에 실패했어요. 잠시 후 다시 시도해 주세요.' })
  }
}
