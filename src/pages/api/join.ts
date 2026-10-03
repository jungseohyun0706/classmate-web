import type { NextApiRequest, NextApiResponse } from 'next'
import { FieldValue, getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore'
import { getAdminApp, isAdminConfigured, sendPushToUser, verifyIdToken } from '../../lib/fcm-admin'

// src/lib/join.ts의 JOIN_TOKEN_TTL_MS와 같은 값 (그 파일은 클라이언트 SDK를 불러와 서버에서 import하지 않음)
const JOIN_TOKEN_TTL_MS = 10 * 60 * 1000

// POST /api/join
// Header: Authorization: Bearer <Firebase ID token>
// Body: { classId, token, name, studentId? }
// 유효한 입장 토큰 + 로그인 계정이면 학생 프로필(users/{uid}, status:'pending')을
// 서버(admin)가 기록하고 담임에게 알림을 보냅니다.
// 서버에서 처리하는 이유: ① 신규 계정은 users 문서가 없어 보안 규칙상 학급/토큰을
// 읽을 수 없음 ② 토큰 검증을 클라이언트에 맡기면 우회 가능 ③ 재입장(반 변경/진급)은
// 규칙상 학생 본인이 classId/status를 바꿀 수 없으므로 서버만 처리 가능.
// 승인된 학생이 다른 실반 QR을 찍으면 본반은 그대로 두고 반 이동 신청(pendingClassId)만
// 기록합니다. 새 담임이 /api/class-membership으로 승인해야 본반이 바뀝니다.

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
  const cleanStudentId =
    typeof studentId === 'string' ? studentId.replace(/[^0-9]/g, '').slice(0, 10) : ''
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
    //    만료는 교사 기기 시계로 계산된 expiresAt이 아니라 서버가 기록한 createdAt 기준으로 판정
    //    (createdAt이 없는 예전 토큰만 expiresAt으로 판정)
    const createdAt = tokenSnap.exists ? tokenSnap.get('createdAt') : null
    const expiresAt = tokenSnap.exists ? tokenSnap.get('expiresAt') : null
    const expiresAtMs =
      createdAt instanceof Timestamp
        ? createdAt.toMillis() + JOIN_TOKEN_TTL_MS
        : expiresAt instanceof Timestamp
          ? expiresAt.toMillis()
          : 0
    if (!tokenSnap.exists || expiresAtMs <= Date.now()) {
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

    // 본반이 확정(승인)된 학생
    // - 수업 그룹 QR → '추가 반' 참여 (선생님이 직접 보여주는 QR이므로 별도 승인 없이 즉시 참여)
    // - 다른 실반 QR → 반 이동 신청. 새 담임이 승인하기 전까지 본반·승인 상태·추가 반은 그대로라
    //   거절되거나 승인을 기다리는 동안에도 지금 반·그룹 톡방을 계속 씁니다.
    if (prev.role === 'student' && prev.status === 'approved' && prev.classId) {
      if (prev.classId === classId) {
        return res.status(200).json({ ok: true, status: 'approved', already: true })
      }
      // schoolCode가 없는 예전 문서는 classId 첫 토막(학교 코드)으로 판정 (보안 규칙과 같은 기준)
      const classSchool = String(cls.schoolCode || classId.split('_')[0])
      const mySchool = String(prev.schoolCode || String(prev.classId).split('_')[0])
      if (classSchool !== mySchool) {
        return res
          .status(403)
          .json({ error: '다른 학교 반에는 들어갈 수 없어요. 전학했다면 선생님께 문의해 주세요.' })
      }
      if (cls.isGroup !== true) {
        if (prev.pendingClassId === classId) {
          return res.status(200).json({ ok: true, status: 'move-pending', already: true })
        }
        await userRef.set(
          {
            pendingClassId: classId,
            pendingStudentId: cleanStudentId || null,
            pendingAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
        await notifyTeacher(db, cls.teacherId ? String(cls.teacherId) : '', {
          title: '반 이동 신청',
          body: `${String(prev.name || cleanName)} 학생이 우리 반으로 옮기고 싶어해요`,
          url: '/teacher/students',
        })
        return res.status(200).json({ ok: true, status: 'move-pending' })
      } else {
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
    }

    // 4) 학생 프로필 기록 (승인 전 학생의 재신청 포함 — 항상 승인 대기로)
    //    수업 그룹 QR도 그대로 허용: 담임이 아직 앱에 없으면 그룹이 임시 본반이 되고,
    //    그룹 소유 교사가 승인합니다. (실반 담임이 등록하면 위 반 이동 신청으로 전환)
    //    그룹에는 여러 반 학생이 섞이므로 학년·반은 그룹 원본 반 값으로 채우지 않습니다.
    const isGroup = cls.isGroup === true
    const profile: Record<string, unknown> = {
      role: 'student',
      status: 'pending',
      classId,
      schoolCode: cls.schoolCode ?? null,
      schoolName: cls.schoolName ?? null,
      grade: isGroup ? null : cls.grade ?? null,
      classNm: isGroup ? null : cls.classNm ?? null,
      name: cleanName,
      displayName: cleanName,
      email: decoded.email || null,
      pendingClassId: FieldValue.delete(),
      pendingStudentId: FieldValue.delete(),
      pendingAt: FieldValue.delete(),
    }
    if (cls.officeCode) profile.officeCode = cls.officeCode
    if (cleanStudentId) profile.studentId = cleanStudentId
    if (!existing.exists) profile.createdAt = FieldValue.serverTimestamp()
    await userRef.set(profile, { merge: true })

    // 5) 담임에게 인앱 알림 + 푸시 (실패해도 입장 신청은 성공)
    await notifyTeacher(db, cls.teacherId ? String(cls.teacherId) : '', {
      title: '새 학생 입장 신청',
      body: `${cleanName} 학생이 승인을 기다려요`,
      url: '/teacher/students',
    })

    return res.status(200).json({ ok: true, status: 'pending' })
  } catch (e) {
    console.error('join error:', e)
    return res.status(500).json({ error: '입장 신청에 실패했어요. 잠시 후 다시 시도해 주세요.' })
  }
}

// 담임에게 인앱 알림 + 푸시 (실패해도 신청 자체는 성공으로 둡니다)
async function notifyTeacher(
  db: Firestore,
  teacherId: string,
  msg: { title: string; body: string; url: string }
): Promise<void> {
  if (!teacherId) return
  try {
    await db.collection('users').doc(teacherId).collection('notifications').add({
      ...msg,
      createdAt: FieldValue.serverTimestamp(),
      read: false,
    })
    // 응답 뒤에는 서버리스 인스턴스가 멈춰 발송이 유실될 수 있어 응답 전에 기다립니다.
    // (sendPushToUser는 throw하지 않음. 입장 신청 응답이 늦어지지 않게 최대 3초까지만)
    let pushTimer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      sendPushToUser(teacherId, msg),
      new Promise<void>((resolve) => {
        pushTimer = setTimeout(resolve, 3000)
      }),
    ])
    clearTimeout(pushTimer)
  } catch (e) {
    console.error('join: teacher notify failed:', e)
  }
}
