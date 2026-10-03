import type { NextApiRequest, NextApiResponse } from 'next'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { getAdminApp, isAdminConfigured, sendPushToUser, verifyIdToken } from '../../lib/fcm-admin'

// POST /api/class-membership
// Header: Authorization: Bearer <Firebase ID token>
// Body: { action, classId, studentUid }
// 담임(그룹이면 소유 교사)이 학생의 반 소속을 바꿉니다.
// - 'approve-move': 반 이동 신청(pendingClassId) 승인 → 본반을 이 반으로 옮김
// - 'reject-move' : 반 이동 신청 거절 → 신청만 지우고 지금 반은 그대로
// - 'remove-extra': 추가 참여(extraClassIds)에서 이 반을 뺌 (본반은 빼지 않음)
// 서버에서 처리하는 이유: 교사 수정 규칙은 status/classId/grade/classNm만 허용해
// 이동 신청 필드·extraClassIds·studentId를 클라이언트에서 바꿀 수 없기 때문.

type Action = 'approve-move' | 'reject-move' | 'remove-extra'

const GROUP_RE = /_g_[A-Za-z0-9]+$/

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

  const { action, classId, studentUid } = (req.body ?? {}) as Record<string, unknown>
  if (
    (action !== 'approve-move' && action !== 'reject-move' && action !== 'remove-extra') ||
    typeof classId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(classId) ||
    typeof studentUid !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(studentUid)
  ) {
    return res.status(400).json({ error: '요청 형식이 올바르지 않아요.' })
  }
  const act = action as Action

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
    if (me.role !== 'teacher' || String(cls.teacherId || '') !== decoded.uid) {
      return res.status(403).json({ error: '이 반 담임 선생님만 할 수 있어요.' })
    }
    // 반 이동은 실반으로만 (수업 그룹은 QR로 바로 추가 참여)
    if (act === 'approve-move' && cls.isGroup === true) {
      return res.status(400).json({ error: '수업 반으로는 반을 옮길 수 없어요.' })
    }

    const studentRef = db.collection('users').doc(studentUid)
    // 학생 문서를 트랜잭션 안에서 다시 읽어, 그사이 신청이 바뀌었으면 처리하지 않습니다.
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(studentRef)
      if (!snap.exists) return { status: 404, error: '학생 정보를 찾을 수 없어요.' }
      const v = snap.data() || {}
      if (v.role !== 'student') return { status: 404, error: '학생 정보를 찾을 수 없어요.' }
      const extras: string[] = Array.isArray(v.extraClassIds)
        ? v.extraClassIds.filter((x: unknown): x is string => typeof x === 'string')
        : []

      if (act === 'remove-extra') {
        if (String(v.classId || '') === classId) {
          return { status: 400, error: '본반에서는 내보낼 수 없어요.' }
        }
        if (!extras.includes(classId)) return { status: 409, stale: true }
        tx.update(studentRef, { extraClassIds: FieldValue.arrayRemove(classId) })
        return { status: 200 }
      }

      if (String(v.pendingClassId || '') !== classId) return { status: 409, stale: true }
      const clearPending = {
        pendingClassId: FieldValue.delete(),
        pendingStudentId: FieldValue.delete(),
        pendingAt: FieldValue.delete(),
      }
      if (act === 'reject-move') {
        // 거절해도 지금 본반·승인 상태·추가 반은 그대로 둡니다.
        tx.update(studentRef, clearPending)
        return { status: 200 }
      }

      // approve-move: 다른 학교 학생은 옮기지 않음 (join에서 막지만 한 번 더 확인)
      //  schoolCode가 없는 예전 문서는 classId 첫 토막(학교 코드)으로 판정
      const classSchool = String(cls.schoolCode || classId.split('_')[0])
      const studentSchool = String(v.schoolCode || String(v.classId || '').split('_')[0])
      if (classSchool !== studentSchool) {
        return { status: 403, error: '다른 학교 학생은 이 반으로 옮길 수 없어요.' }
      }
      const prevHome = String(v.classId || '')
      // 새 본반은 추가 반 목록에서 빼고, 이전 본반이 수업 그룹이면 그 톡방은 추가 반으로 남깁니다.
      // (이전 본반이 실반이면 남기지 않음 — 옮기면 그 반 소속이 아님)
      const nextExtras = extras.filter((id) => id !== classId)
      if (prevHome && prevHome !== classId && GROUP_RE.test(prevHome) && !nextExtras.includes(prevHome)) {
        nextExtras.push(prevHome)
      }
      const update: Record<string, unknown> = {
        ...clearPending,
        classId,
        status: 'approved',
        grade: cls.grade ?? null,
        classNm: cls.classNm ?? null,
        schoolCode: cls.schoolCode ?? v.schoolCode ?? null,
        schoolName: cls.schoolName ?? v.schoolName ?? null,
      }
      if (cls.officeCode) update.officeCode = cls.officeCode
      if (v.pendingStudentId) update.studentId = v.pendingStudentId
      if (nextExtras.length !== extras.length || nextExtras.some((id, i) => id !== extras[i])) {
        update.extraClassIds = nextExtras
      }
      tx.update(studentRef, update)
      return { status: 200 }
    })

    if (result.status === 409) {
      return res
        .status(409)
        .json({ error: '이미 처리되었거나 학생이 신청을 바꿨어요.', reason: 'stale' })
    }
    if (result.status !== 200) {
      return res.status(result.status).json({ error: result.error })
    }

    if (act === 'approve-move') {
      // 학생에게 인앱 알림 + 푸시 (실패해도 승인은 성공)
      const title = '반 이동 승인'
      const body = `${cls.schoolName || ''} ${cls.grade ?? ''}학년 ${cls.classNm ?? ''}반 학생이 되었어요!`.trim()
      const url = '/student/today'
      try {
        await studentRef.collection('notifications').add({
          title,
          body,
          url,
          createdAt: FieldValue.serverTimestamp(),
          read: false,
        })
        // 응답 뒤에는 서버리스 인스턴스가 멈춰 발송이 유실될 수 있어 최대 3초까지만 기다립니다.
        let pushTimer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          sendPushToUser(studentUid, { title, body, url }),
          new Promise<void>((resolve) => {
            pushTimer = setTimeout(resolve, 3000)
          }),
        ])
        clearTimeout(pushTimer)
      } catch (e) {
        console.error('class-membership: student notify failed:', e)
      }
    }

    return res.status(200).json({ ok: true })
  } catch (e) {
    console.error('class-membership error:', e)
    return res.status(500).json({ error: '처리하지 못했어요. 잠시 후 다시 시도해 주세요.' })
  }
}
