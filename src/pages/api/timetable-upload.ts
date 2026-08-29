import type { NextApiRequest, NextApiResponse } from 'next'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { getAdminApp, isAdminConfigured, verifyIdToken } from '../../lib/fcm-admin'
import {
  normalizeName,
  sanitizeUploadPayload,
  storedClassGridToInfoTimetable,
  storedTeacherGridToMySchedule,
  classLabelToParts,
} from '../../lib/timetableConvert'

// POST /api/timetable-upload
// Header: Authorization: Bearer <Firebase ID token>
// Body: { data: SanitizedUpload 형태, overwriteTeachers?: boolean }
//
// 같은 학교 교사가 엑셀에서 파싱한 학교 시간표를 올리면:
//  1) school_timetables/{schoolCode} 마스터 문서로 저장 (미가입 교사가 나중에 불러가는 원본)
//  2) 존재하는 학급의 classes/{id}/info/timetable 을 갱신
//  3) displayName이 일치하는 교사 계정의 users/{uid}.mySchedule 을 자동 등록
// firebase-admin으로 쓰므로 보안 규칙을 우회합니다. 대신 여기서 직접
// 요청자가 이 학교의 교사인지 확인하고, 요청자의 학교에만 씁니다.

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
}

interface UploadReport {
  classesUpdated: number
  classesNotFound: string[]
  teachersMatched: string[]
  teachersSkippedExisting: string[]
  teachersAmbiguous: string[]
  teachersUnmatched: string[]
}

const BATCH_LIMIT = 400

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '허용되지 않는 요청입니다.' })
  }

  if (!isAdminConfigured()) {
    return res.status(503).json({
      error:
        '서버에 관리자 인증(FIREBASE_SERVICE_ACCOUNT_JSON)이 설정되지 않아 자동 등록을 사용할 수 없어요.',
    })
  }

  const authHeader = req.headers.authorization || ''
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  const decoded = await verifyIdToken(idToken)
  if (!decoded) {
    return res.status(401).json({ error: '인증에 실패했어요. 다시 로그인해 주세요.' })
  }

  const app = getAdminApp()
  if (!app) {
    return res.status(503).json({ error: '서버 초기화에 실패했어요.' })
  }
  const db = getFirestore(app)

  // 요청자 확인: 반드시 교사 + 학교 소속이어야 하고, 그 학교에만 쓸 수 있다.
  const meSnap = await db.collection('users').doc(decoded.uid).get()
  const me = meSnap.exists ? meSnap.data() || {} : {}
  const schoolCode = typeof me.schoolCode === 'string' ? me.schoolCode : ''
  if (me.role !== 'teacher' || !schoolCode) {
    return res.status(403).json({
      error: '학교가 등록된 교사 계정만 시간표를 업로드할 수 있어요. 먼저 학교/반을 등록해 주세요.',
    })
  }

  // 요청자가 실제로 이 학교에 등록된 반의 담임인지 확인
  // (자기 users 문서의 schoolCode는 스스로 바꿀 수 있으므로, 그것만 믿지 않는다)
  const myClassSnap = await db
    .collection('classes')
    .where('teacherId', '==', decoded.uid)
    .where('schoolCode', '==', schoolCode)
    .limit(1)
    .get()
  if (myClassSnap.empty) {
    return res.status(403).json({
      error: '이 학교에 등록된 반이 있는 선생님만 시간표를 업로드할 수 있어요.',
    })
  }

  const body = (req.body ?? {}) as { data?: unknown; overwriteTeachers?: unknown }
  const data = sanitizeUploadPayload(body.data)
  if (!data) {
    return res.status(400).json({ error: '업로드할 시간표 데이터가 올바르지 않아요.' })
  }
  // Firestore 문서 1MiB 제한 보호 (마스터 문서 전체가 한 문서에 들어감)
  if (JSON.stringify(data).length > 800_000) {
    return res.status(400).json({ error: '시간표 데이터가 너무 커요. 파일을 나눠서 올려주세요.' })
  }
  const overwriteTeachers = body.overwriteTeachers === true // 기본: 기존 개인 시간표는 보존

  const report: UploadReport = {
    classesUpdated: 0,
    classesNotFound: [],
    teachersMatched: [],
    teachersSkippedExisting: [],
    teachersAmbiguous: [],
    teachersUnmatched: [],
  }

  try {
    // 배치 쓰기 (한 배치 400개 제한으로 안전하게 쪼갬)
    let batch = db.batch()
    let ops = 0
    const commits: Promise<unknown>[] = []
    const add = (fn: (b: FirebaseFirestore.WriteBatch) => void) => {
      fn(batch)
      ops++
      if (ops >= BATCH_LIMIT) {
        commits.push(batch.commit())
        batch = db.batch()
        ops = 0
      }
    }

    // 1) 마스터 문서 — merge:true라 부분 업로드(교사표만/학급표만)가
    //    기존에 저장된 다른 쪽 데이터를 지우지 않는다.
    const masterUpdate: Record<string, unknown> = {
      periodTimes: data.periodTimes,
      sources: data.sources,
      uploadedBy: decoded.uid,
      uploadedByName: typeof me.displayName === 'string' ? me.displayName : '',
      uploadedAt: FieldValue.serverTimestamp(),
    }
    if (Object.keys(data.classes).length > 0) masterUpdate.classes = data.classes
    if (Object.keys(data.teachers).length > 0) masterUpdate.teachers = data.teachers
    add((b) =>
      b.set(db.collection('school_timetables').doc(schoolCode), masterUpdate, { merge: true })
    )

    // 2) 학급 시간표: 존재하는 학급 문서만 갱신
    const classLabels = Object.keys(data.classes)
    const classRefs = classLabels
      .map((label) => {
        const parts = classLabelToParts(label)
        return parts
          ? { label, ref: db.collection('classes').doc(`${schoolCode}_${parts.grade}_${parts.classNm}`) }
          : null
      })
      .filter((x): x is { label: string; ref: FirebaseFirestore.DocumentReference } => x !== null)

    const classSnaps = classRefs.length > 0 ? await db.getAll(...classRefs.map((c) => c.ref)) : []
    classSnaps.forEach((snap, i) => {
      const { label, ref } = classRefs[i]
      if (!snap.exists) {
        report.classesNotFound.push(label)
        return
      }
      add((b) => b.set(ref.collection('info').doc('timetable'), storedClassGridToInfoTimetable(data.classes[label])))
      // 모바일 앱이 남긴 구형 timetable 필드는 새 시간표를 가리므로 제거
      if (snap.get('timetable') !== undefined) {
        add((b) => b.update(ref, { timetable: FieldValue.delete() }))
      }
      report.classesUpdated++
    })

    // 3) 교사 자동 매칭: 같은 학교 교사 계정의 displayName과 엑셀 이름을 대조
    const teacherSnap = await db
      .collection('users')
      .where('schoolCode', '==', schoolCode)
      .where('role', '==', 'teacher')
      .get()

    const byName = new Map<string, { uid: string; hasSchedule: boolean }[]>()
    teacherSnap.forEach((docSnap) => {
      const d = docSnap.data()
      // masterName(교사가 직접 연결한 엑셀 이름) 우선, displayName·name도 함께 매칭
      const keys = new Set(
        [d.masterName, d.displayName, d.name]
          .filter((n): n is string => typeof n === 'string' && n.length > 0)
          .map((n) => normalizeName(n))
      )
      for (const key of Array.from(keys)) {
        const list = byName.get(key) || []
        list.push({ uid: docSnap.id, hasSchedule: Boolean(d.mySchedule) })
        byName.set(key, list)
      }
    })

    for (const [name, grid] of Object.entries(data.teachers)) {
      const matches = byName.get(normalizeName(name)) || []
      if (matches.length === 0) {
        report.teachersUnmatched.push(name)
        continue
      }
      if (matches.length > 1) {
        // 동명이인: 잘못된 계정에 쓰는 것보다 건너뛰는 게 안전
        report.teachersAmbiguous.push(name)
        continue
      }
      const { uid, hasSchedule } = matches[0]
      if (hasSchedule && !overwriteTeachers) {
        report.teachersSkippedExisting.push(name)
        continue
      }
      add((b) =>
        b.set(
          db.collection('users').doc(uid),
          { mySchedule: storedTeacherGridToMySchedule(grid) },
          { merge: true }
        )
      )
      // 본인이 아닌 교사에게는 인박스 알림을 남겨 조용한 덮어쓰기를 방지
      if (uid !== decoded.uid) {
        const uploaderName = typeof me.displayName === 'string' && me.displayName ? me.displayName : '동료 선생님'
        add((b) =>
          b.set(db.collection('users').doc(uid).collection('notifications').doc(), {
            title: '내 수업 시간표 자동 등록',
            body: `${uploaderName} 선생님이 학교 시간표 엑셀을 올려 내 수업 시간표가 ${hasSchedule ? '갱신' : '등록'}되었어요.`,
            url: '/teacher/my-schedule',
            createdAt: FieldValue.serverTimestamp(),
            read: false,
          })
        )
      }
      report.teachersMatched.push(name)
    }

    if (ops > 0) commits.push(batch.commit())
    await Promise.all(commits)

    return res.status(200).json({ ok: true, report })
  } catch (e) {
    console.error('timetable-upload error:', e)
    return res.status(500).json({ error: '등록 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.' })
  }
}
