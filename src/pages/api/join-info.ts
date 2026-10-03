import type { NextApiRequest, NextApiResponse } from 'next'
import { getFirestore } from 'firebase-admin/firestore'
import { getAdminApp, isAdminConfigured } from '../../lib/fcm-admin'
import {
  checkJoinToken,
  checkRateLimit,
  CLASS_ID_RE,
  clientIp,
  JOIN_TOKEN_RE,
  linkedCoursesForGroup,
  recordFailure,
  schoolOfClass,
} from '../../lib/invitations'
import { schoolYmdAt } from '../../lib/timetable/dates'
import { TimetableApiError } from '../../lib/timetable/studentData'

// POST /api/join-info
// Body: { classId, token }
// QR의 입장 토큰이 유효하면 학급 표시 정보(최소 정보)를 돌려줍니다.
// 로그인 불필요 — 유효한 토큰 자체가 자격증명입니다. (신규 학생은 아직 계정이 없음)
// 응답: 200 { ok, classInfo: { classId, schoolName, grade, classNm, teacherName?, isGroup, courseTitle? } }
//   courseTitle: 수업 그룹과 연결된 운영 중 수업이 있으면 그 제목(입장하면 그 수업 수강도 함께 만들어짐)
//   학생 명단·uid는 내려주지 않습니다.
// 오류: { error, code } — 400 bad-request(형식), 404 not-found(없는 토큰)/class-not-found, 410 expired,
//       429 rate-limited, 500 server-error, 503 not-configured — 화면이 모든 실패를 '만료'로 보이지 않게 구분합니다.

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
  try {
    checkRateLimit('join', ip)
  } catch (e) {
    if (e instanceof TimetableApiError) return err(res, e.status, e.code, e.message)
    throw e
  }

  const { classId, token } = (req.body ?? {}) as { classId?: unknown; token?: unknown }
  if (typeof classId !== 'string' || !CLASS_ID_RE.test(classId) || typeof token !== 'string' || !JOIN_TOKEN_RE.test(token)) {
    recordFailure('join', ip)
    return err(res, 400, 'bad-request', '입장 코드 형식이 올바르지 않아요. 링크를 다시 확인해 주세요.')
  }

  try {
    const app = getAdminApp()
    if (!app) return err(res, 503, 'not-configured', '서버 초기화에 실패했어요.')
    const db = getFirestore(app)

    const tokenState = await checkJoinToken(db, classId, token)
    if (tokenState === 'not-found') {
      recordFailure('join', ip)
      return err(res, 404, 'not-found', '입장 코드를 찾을 수 없어요. 선생님께 새 코드를 요청해 주세요.')
    }
    if (tokenState === 'expired') {
      return err(res, 410, 'expired', '입장 코드가 만료되었어요. 선생님께 새 코드를 요청해 주세요.')
    }

    const classSnap = await db.collection('classes').doc(classId).get()
    if (!classSnap.exists) {
      return err(res, 404, 'class-not-found', '학급 정보를 찾을 수 없어요.')
    }
    const cls = classSnap.data() || {}
    const isGroup = cls.isGroup === true

    // 담당 교사 이름: 학급 문서에 없으면(예전 그룹 문서) 교사 프로필 이름
    let teacherName = cls.teacherName ? String(cls.teacherName) : ''
    if (!teacherName && typeof cls.teacherId === 'string' && cls.teacherId) {
      const t = await db.collection('users').doc(cls.teacherId).get()
      if (t.exists && t.get('role') === 'teacher') teacherName = String(t.get('name') || t.get('displayName') || '')
    }

    // 수업 그룹과 연결된 운영 중 수업(첫 번째) — 입장 화면에 어떤 수업인지 보여 주기 위해
    let courseTitle: string | undefined
    if (isGroup) {
      const linked = await linkedCoursesForGroup(db, schoolOfClass(cls, classId), classId, schoolYmdAt(Date.now()))
      if (linked.length) courseTitle = String(linked[0].data.title || linked[0].data.subject || '') || undefined
    }

    return res.status(200).json({
      ok: true,
      classInfo: {
        classId,
        schoolName: String(cls.schoolName ?? ''),
        grade: cls.grade ?? '',
        classNm: cls.classNm ?? '',
        teacherName: teacherName || undefined,
        isGroup,
        ...(courseTitle ? { courseTitle } : {}),
      },
    })
  } catch (e) {
    console.error('join-info error:', String((e as Error)?.message || '').slice(0, 200))
    return err(res, 500, 'server-error', '확인 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.')
  }
}
