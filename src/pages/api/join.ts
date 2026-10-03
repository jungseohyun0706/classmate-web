import type { NextApiRequest, NextApiResponse } from 'next'
import { getFirestore } from 'firebase-admin/firestore'
import { getAdminApp, isAdminConfigured, verifyIdToken } from '../../lib/fcm-admin'
import {
  checkJoinToken,
  checkRateLimit,
  CLASS_ID_RE,
  clientIp,
  courseApproverUids,
  courseJoinDefault,
  decideEnrollment,
  enrollmentWriteData,
  JOIN_TOKEN_RE,
  linkedCoursesForGroup,
  planClassJoin,
  recordFailure,
  schoolOfClass,
} from '../../lib/invitations'
import { schoolYmdAt } from '../../lib/timetable/dates'
import { enrollmentId, notifyUsersOnce, readRevision, schoolRef, writeAudit, writeRevision } from '../../lib/timetable/server'
import { TimetableApiError } from '../../lib/timetable/studentData'

// POST /api/join   (기존 QR 링크 /join?c={classId}&t={token} — 경로·파라미터·응답 모양 유지)
// Header: Authorization: Bearer <Firebase ID token>
// Body: { classId, token, name, studentId? }
// 유효한 입장 토큰 + 로그인 계정이면 학생 프로필(users/{uid})을 서버(admin)가 기록하고 담임에게 알림을 보냅니다.
// 서버에서 처리하는 이유: ① 신규 계정은 users 문서가 없어 보안 규칙상 학급/토큰을 읽을 수 없음
// ② 토큰 검증을 클라이언트에 맡기면 우회 가능 ③ 재입장(반 변경/진급)은 학생 본인이 classId/status를 바꿀 수 없음.
// 처리 규칙은 src/lib/invitations.ts planClassJoin(학급 초대 수락 /api/invitations와 같은 규칙):
// - 승인된 학생이 다른 실반 QR → 반 이동 신청(pendingClassId). 새 담임이 /api/class-membership으로 승인해야 바뀜
// - 승인된 학생이 수업 그룹 QR → 추가 참여(extraClassIds)
// - 승인 전(신청 중) 학생이 수업 그룹 QR → 신청해 둔 소속은 그대로, extraClassIds에만 추가(joined-extra-pending)
// - 같은 반 재신청 → 프로필만 갱신, 교사 알림·푸시를 다시 보내지 않음
// - 승인됐거나 신청 중인 학생의 다른 학교 반 → 403 other-school
// 수업 그룹 QR: 그 그룹과 연결된 운영 중 수업(schools/{s}/courses.legacyGroupId)이 있으면 수강(source 'invite')도
// 같은 트랜잭션에서 만들어 개인 시간표(/api/timetable/me)에 수업이 나오게 합니다. 연결된 수업이 없으면 만들지 않습니다.
// 수강 상태는 수업 초대 수락과 같은 규칙(courseJoinDefault): 수업 참여 방식이 '승인 필요'(invitePolicy 'approval')면
// pending(승인 전에는 시간표에 나오지 않음) + 수업 담당·관리 교사에게 '수강 승인 요청' 알림, 아니면 active.
// 선생님이 끝내거나 거절한 수강은 정책과 상관없이 다시 pending(decideEnrollment).
// 응답: 200 { ok, status: 'pending'|'approved'|'move-pending'|'joined-extra'|'joined-extra-pending', already?,
//             courses: [{courseId, title, status: 'active'|'pending'}] }
// 오류: { error, code } — 400 bad-request/name-required, 401 unauthenticated, 403 anonymous/teacher-account/not-student/other-school,
//       404 not-found(토큰 없음)/class-not-found, 410 expired, 429 rate-limited, 500 server-error, 503 not-configured

const err = (res: NextApiResponse, status: number, code: string, error: string) => res.status(status).json({ error, code })

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'private, no-store')
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return err(res, 405, 'method-not-allowed', '허용되지 않는 요청입니다.')
  }
  if (!isAdminConfigured()) {
    return err(res, 503, 'not-configured', '서버 설정이 없어요. 관리자에게 문의해 주세요.')
  }
  const ip = clientIp(req)

  const authHeader = req.headers.authorization || ''
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  const decoded = await verifyIdToken(idToken)
  if (!decoded) {
    return err(res, 401, 'unauthenticated', '로그인이 필요해요. 다시 로그인해 주세요.')
  }
  if (decoded.firebase?.sign_in_provider === 'anonymous') {
    return err(res, 403, 'anonymous', '익명 계정으로는 입장할 수 없어요. 계정을 만들어 주세요.')
  }

  try {
    checkRateLimit('join', ip, decoded.uid)
  } catch (e) {
    if (e instanceof TimetableApiError) return err(res, e.status, e.code, e.message)
    throw e
  }

  const { classId, token, name, studentId } = (req.body ?? {}) as Record<string, unknown>
  const cleanName = typeof name === 'string' ? name.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 20) : ''
  const cleanStudentId =
    typeof studentId === 'string' || typeof studentId === 'number' ? String(studentId).replace(/[^0-9]/g, '').slice(0, 10) : ''
  if (typeof classId !== 'string' || !CLASS_ID_RE.test(classId) || typeof token !== 'string' || !JOIN_TOKEN_RE.test(token)) {
    recordFailure('join', ip, decoded.uid)
    return err(res, 400, 'bad-request', '요청 형식이 올바르지 않아요.')
  }
  if (!cleanName) {
    return err(res, 400, 'name-required', '이름을 입력해 주세요.')
  }

  try {
    const app = getAdminApp()
    if (!app) return err(res, 503, 'not-configured', '서버 초기화에 실패했어요.')
    const db = getFirestore(app)
    const today = schoolYmdAt(Date.now())

    // 1) 토큰 검증 — 없는 토큰만 실패로 셈(만료된 진짜 토큰은 무차별 대입이 아님)
    const tokenState = await checkJoinToken(db, classId, token)
    if (tokenState === 'not-found') {
      recordFailure('join', ip, decoded.uid)
      return err(res, 404, 'not-found', '입장 코드를 찾을 수 없어요. 선생님께 새 코드를 요청해 주세요.')
    }
    if (tokenState === 'expired') {
      return err(res, 410, 'expired', '입장 코드가 만료되었어요. 선생님께 새 코드를 요청해 주세요.')
    }

    // 2) 학급 확인
    const classSnap = await db.collection('classes').doc(classId).get()
    if (!classSnap.exists) {
      return err(res, 404, 'class-not-found', '학급 정보를 찾을 수 없어요.')
    }
    const cls = classSnap.data() || {}
    const classSchool = schoolOfClass(cls, classId)

    // 3) 수업 그룹이면 연결된 수업(트랜잭션 밖에서 찾고, 수강 문서는 트랜잭션 안에서 읽음)
    const linked = cls.isGroup === true ? await linkedCoursesForGroup(db, classSchool, classId, today) : []

    const userRef = db.collection('users').doc(decoded.uid)
    const sref = schoolRef(db, classSchool)
    const enrRefs = linked.map((c) => sref.collection('enrollments').doc(enrollmentId(c.courseId, decoded.uid)))

    // 4) 프로필 + (그룹이면) 연결 수업 수강을 한 트랜잭션으로
    const result = await db.runTransaction(async (tx) => {
      const prevSnap = await tx.get(userRef)
      const enrSnaps = enrRefs.length ? await tx.getAll(...enrRefs) : []
      const rev0 = enrRefs.length ? await readRevision(tx, db, classSchool) : 0
      const plan = planClassJoin({
        uid: decoded.uid,
        email: decoded.email || null,
        classId,
        cls,
        prev: prevSnap.exists ? prevSnap.data() || {} : null,
        name: cleanName,
        studentId: cleanStudentId,
        today,
      })
      if (plan.userWrite) tx.set(userRef, plan.userWrite, { merge: true })

      const courses: Array<{ courseId: string; title: string; status: string }> = []
      const changed: Array<{ courseId: string; status: string; before: string | null }> = []
      const approvals: Array<{ courseId: string; title: string; teachers: string[] }> = []
      if (plan.linkGroupCourses) {
        linked.forEach((c, i) => {
          const cur = enrSnaps[i] && enrSnaps[i].exists ? enrSnaps[i].data() || {} : null
          // 그룹 QR도 수업의 참여 방식(승인 필요)을 따름 — 예전에는 항상 active라 승인을 건너뛰는 경로였음
          const d = decideEnrollment(cur, courseJoinDefault(c.data))
          courses.push({ courseId: c.courseId, title: String(c.data.title || c.data.subject || '수업'), status: d.status })
          if (!d.changed) return
          tx.set(
            enrRefs[i],
            enrollmentWriteData({
              cur,
              courseId: c.courseId,
              course: c.data,
              uid: decoded.uid,
              schoolCode: classSchool,
              status: d.status,
              today,
              source: 'invite',
              extra: { via: 'group-qr', legacyGroupId: classId },
            }),
            { merge: true }
          )
          changed.push({ courseId: c.courseId, status: d.status, before: cur ? String(cur.status ?? '') : null })
          if (d.status === 'pending') {
            approvals.push({ courseId: c.courseId, title: String(c.data.title || c.data.subject || '수업'), teachers: courseApproverUids(c.data) })
          }
        })
      }
      let rev = rev0
      if (changed.length) {
        rev = rev0 + 1
        writeRevision(tx, db, classSchool, rev)
        changed.forEach((c) =>
          writeAudit(tx, db, classSchool, {
            action: 'enrollment.group-qr',
            actorUid: decoded.uid,
            target: `enrollments/${enrollmentId(c.courseId, decoded.uid)}`,
            revision: rev,
            before: c.before ? { status: c.before } : null,
            after: { status: c.status, from: c.status === 'active' ? today : null },
            meta: { groupId: classId },
          })
        )
      }
      const prev = prevSnap.exists ? prevSnap.data() || {} : {}
      return { plan, courses, approvals, rev, studentName: String(prev.name || cleanName || '학생') }
    })

    // 5) 담당 교사 알림(같은 신청은 한 번만, 실패해도 입장 처리는 성공)
    const { plan, courses, approvals, rev, studentName } = result
    if (plan.notify) {
      try {
        await notifyUsersOnce(db, [plan.notify.teacherId], plan.notify.dedupeId, {
          title: plan.notify.title,
          body: plan.notify.body,
          url: plan.notify.url,
        })
      } catch (e) {
        console.error('join: teacher notify failed', (e as Error)?.message)
      }
    }
    // 승인이 필요한 연결 수업: 수업 담당·관리 교사에게 수강 승인 요청(수업 초대 수락과 같은 알림).
    // id는 이번 변경의 학교 revision — 재전송·더블 탭은 수강이 이미 pending이라 여기까지 오지 않음
    for (const a of approvals) {
      if (!a.teachers.length) continue
      try {
        await notifyUsersOnce(db, a.teachers, `grpq_${a.courseId}__${decoded.uid}_r${rev}`, {
          title: '수강 승인 요청',
          body: `${studentName} 학생이 ${a.title} 수업 참여 승인을 기다려요`,
          url: '/teacher/courses',
        })
      } catch (e) {
        console.error('join: course approval notify failed', (e as Error)?.message)
      }
    }

    return res.status(200).json({ ok: true, status: plan.status, ...(plan.already ? { already: true } : {}), courses })
  } catch (e) {
    if (e instanceof TimetableApiError) return res.status(e.status).json({ error: e.message, code: e.code, ...(e.extra || {}) })
    console.error('join error:', String((e as Error)?.message || '').slice(0, 200))
    return err(res, 500, 'server-error', '입장 신청에 실패했어요. 잠시 후 다시 시도해 주세요.')
  }
}
