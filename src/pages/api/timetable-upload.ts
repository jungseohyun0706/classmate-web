import type { NextApiRequest, NextApiResponse } from 'next'
import { createHash } from 'crypto'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { getAdminApp, isAdminConfigured, verifyIdToken } from '../../lib/fcm-admin'
import {
  DAY_KEYS,
  PERIOD_COUNT,
  normalizeName,
  sanitizeUploadPayload,
  storedClassGridToInfoTimetable,
  storedTeacherGridToMySchedule,
  classLabelToParts,
  type DayKey,
  type StoredClassGrid,
  type StoredTeacherGrid,
} from '../../lib/timetableConvert'

// POST /api/timetable-upload
// Header: Authorization: Bearer <Firebase ID token>
// Body: {
//   data: SanitizedUpload 형태,
//   direct?: { classes: string[], teachers: string[] }  // 파일에 직접 들어 있던(역산이 아닌) 반·교사
//   mode?: 'merge' | 'replace',                          // 기본 merge
//   overwriteTeachers?: boolean,
//   schoolCode?: string,                                 // 화면이 업로드 대상으로 알고 있는 학교
// }
//
// 같은 학교 교사가 엑셀에서 파싱한 학교 시간표를 올리면:
//  1) school_timetables/{schoolCode} 마스터 문서로 저장 (미가입 교사가 나중에 불러가는 원본)
//     - merge(기본): 파일에 있는 반·교사만 갱신하고, 파일에 없는 반·교사·교시 시각은 보존
//     - replace('새 파일로 교체'): 마스터를 이 파일 내용으로 통째로 교체
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

type Grid<T> = Record<DayKey, (T | null)[]>
type Schedule = Record<DayKey, string[]>

const own = (map: object, key: string): boolean => Object.prototype.hasOwnProperty.call(map, key)

const dayCells = (grid: unknown, key: DayKey): unknown[] => {
  const day = grid && typeof grid === 'object' ? (grid as Record<string, unknown>)[key] : undefined
  return Array.isArray(day) ? day : []
}

/**
 * 파일에 직접 들어 있지 않고 역산으로만 만들어진 그리드를 기존 그리드에 합칩니다.
 * 새 값이 있는 칸은 새 값으로, 빈 칸은 이번 파일이 다시 알려 준 기존 칸(isReplaced)만 비우고
 * 나머지 기존 칸은 그대로 둡니다. (교사 한 명분 파일로 그 교사가 가르치는 반 시간표 전체가
 * 그 교사 수업만 남도록 지워지는 것을 막기 위함)
 */
const mergeDerivedGrid = <T>(prev: unknown, next: Grid<T>, isReplaced: (old: T) => boolean): Grid<T> => {
  const out = {} as Grid<T>
  for (const key of DAY_KEYS) {
    const prevDay = dayCells(prev, key)
    out[key] = next[key].map((cell, i) => {
      if (cell) return cell
      const old = prevDay[i]
      return old && typeof old === 'object' && !isReplaced(old as T) ? (old as T) : null
    })
  }
  return out
}

/** Firestore의 mySchedule 값을 {mon..fri: string[7]}로 정규화 (비교·해시용) */
const toSchedule = (raw: unknown): Schedule => {
  const out = {} as Schedule
  for (const key of DAY_KEYS) {
    const day = dayCells(raw, key)
    out[key] = Array.from({ length: PERIOD_COUNT }, (_, i) => (typeof day[i] === 'string' ? (day[i] as string) : ''))
  }
  return out
}

const scheduleHash = (s: Schedule): string =>
  createHash('sha256')
    .update(JSON.stringify(DAY_KEYS.map((k) => s[k])))
    .digest('hex')

const isBlankSchedule = (s: Schedule): boolean => DAY_KEYS.every((k) => s[k].every((v) => v.trim() === ''))

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

  // 학교 소속은 서버가 읽은 users/{uid}.schoolCode로만 판단한다.
  // (classes 문서는 클라이언트가 아무 학교로나 만들 수 있어 소속 증빙이 되지 못하고,
  //  담임 반이 없는 교과 전담 교사도 업로드할 수 있어야 한다)
  const body = (req.body ?? {}) as {
    data?: unknown
    direct?: unknown
    mode?: unknown
    overwriteTeachers?: unknown
    schoolCode?: unknown
  }
  if (typeof body.schoolCode === 'string' && body.schoolCode !== schoolCode) {
    return res.status(403).json({
      error: '내 학교 정보가 바뀌었어요. 페이지를 새로고침한 뒤 다시 올려 주세요.',
    })
  }

  const data = sanitizeUploadPayload(body.data)
  if (!data) {
    return res.status(400).json({ error: '업로드할 시간표 데이터가 올바르지 않아요.' })
  }
  // Firestore 문서 1MiB 제한 보호 (마스터 문서 전체가 한 문서에 들어감)
  if (JSON.stringify(data).length > 800_000) {
    return res.status(400).json({ error: '시간표 데이터가 너무 커요. 파일을 나눠서 올려주세요.' })
  }
  const overwriteTeachers = body.overwriteTeachers === true // 기본: 기존 개인 시간표는 보존
  const replaceAll = body.mode === 'replace' // 기본: 병합

  // 파일에 직접 들어 있던 반·교사. 나머지는 반표↔교사표 역산으로만 만들어진 부분 그리드다.
  // (direct가 없는 예전 화면에서 오면 전부 역산으로 보고 기존 칸을 지우지 않는다)
  const direct = (body.direct && typeof body.direct === 'object' ? body.direct : {}) as {
    classes?: unknown
    teachers?: unknown
  }
  const pickKeys = (raw: unknown, map: object): Set<string> =>
    new Set(
      (Array.isArray(raw) ? raw : [])
        .filter((k): k is string => typeof k === 'string')
        .map((k) => k.trim())
        .filter((k) => own(map, k))
    )
  const directClasses = pickKeys(direct.classes, data.classes)
  const directTeachers = pickKeys(direct.teachers, data.teachers)
  const directTeacherKeys = new Set(Array.from(directTeachers).map(normalizeName))

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

    // 1) 마스터 문서 — 기존 값과 합쳐야 하므로 읽고 쓰는 동안 다른 업로드가 끼지 않게 트랜잭션으로
    const masterRef = db.collection('school_timetables').doc(schoolCode)
    const master = await db.runTransaction(async (tx) => {
      const snap = await tx.get(masterRef)
      const prev = (snap.exists ? snap.data() : undefined) || {}
      const prevClasses = (prev.classes && typeof prev.classes === 'object' ? prev.classes : {}) as Record<string, unknown>
      const prevTeachers = (prev.teachers && typeof prev.teachers === 'object' ? prev.teachers : {}) as Record<string, unknown>

      // 파일에 직접 들어 있는 반·교사는 통째로 교체하고, 역산으로만 만들어진 반은
      // 이번 파일에 시간표가 있는 교사의 칸만, 역산 교사는 이번 파일에 있는 반의 칸만 바꾼다.
      const classes: Record<string, StoredClassGrid> = {}
      for (const [label, grid] of Object.entries(data.classes)) {
        classes[label] =
          replaceAll || directClasses.has(label) || !own(prevClasses, label)
            ? grid
            : mergeDerivedGrid(
                prevClasses[label],
                grid,
                (old) => typeof old.teacher === 'string' && directTeacherKeys.has(normalizeName(old.teacher))
              )
      }
      const teachers: Record<string, StoredTeacherGrid> = {}
      for (const [name, grid] of Object.entries(data.teachers)) {
        teachers[name] =
          replaceAll || directTeachers.has(name) || !own(prevTeachers, name)
            ? grid
            : mergeDerivedGrid(
                prevTeachers[name],
                grid,
                (old) => typeof old.classLabel === 'string' && directClasses.has(old.classLabel)
              )
      }

      const meta = {
        sources: data.sources,
        uploadedBy: decoded.uid,
        uploadedByName: typeof me.displayName === 'string' ? me.displayName : '',
        uploadedAt: FieldValue.serverTimestamp(),
      }
      if (replaceAll) {
        // '새 파일로 교체': 파일에 없는 반·교사·교시 시각까지 지우도록 merge 없이 통째로 쓴다
        tx.set(masterRef, { classes, teachers, periodTimes: data.periodTimes, ...meta })
      } else {
        // 기본(병합): merge:true라 이번 파일에 없는 반·교사·교시 키는 그대로 남는다.
        // 빈 맵은 merge에서도 기존 값을 {}로 덮어쓰므로, 비어 있으면 아예 넣지 않는다.
        const masterUpdate: Record<string, unknown> = { ...meta }
        if (Object.keys(classes).length > 0) masterUpdate.classes = classes
        if (Object.keys(teachers).length > 0) masterUpdate.teachers = teachers
        if (Object.keys(data.periodTimes).length > 0) masterUpdate.periodTimes = data.periodTimes
        tx.set(masterRef, masterUpdate, { merge: true })
      }
      return { classes, teachers, prevClasses, prevTeachers }
    })

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
    const foundClasses: { label: string; ref: FirebaseFirestore.DocumentReference; legacy: boolean }[] = []
    classSnaps.forEach((snap, i) => {
      const { label, ref } = classRefs[i]
      if (!snap.exists) {
        report.classesNotFound.push(label)
        return
      }
      foundClasses.push({ label, ref, legacy: snap.get('timetable') !== undefined })
    })

    // 역산으로만 만들어진 반은 담임이 고쳐 둔 칸까지 살려야 하므로 지금 학급 시간표를 읽어 둔다
    const partialClasses = replaceAll ? [] : foundClasses.filter((c) => !directClasses.has(c.label))
    const infoSnaps =
      partialClasses.length > 0
        ? await db.getAll(...partialClasses.map((c) => c.ref.collection('info').doc('timetable')))
        : []
    const prevInfo = new Map<string, FirebaseFirestore.DocumentData>()
    infoSnaps.forEach((s, i) => {
      if (s.exists) prevInfo.set(partialClasses[i].label, s.data() || {})
    })

    for (const { label, ref, legacy } of foundClasses) {
      const old = prevInfo.get(label)
      let info: Record<DayKey, string[]>
      if (old) {
        const nextGrid = data.classes[label]
        const nextInfo = storedClassGridToInfoTimetable(nextGrid)
        const prevGrid = own(master.prevClasses, label) ? master.prevClasses[label] : undefined
        info = {} as Record<DayKey, string[]>
        for (const key of DAY_KEYS) {
          const oldDay = dayCells(old, key)
          const prevDay = dayCells(prevGrid, key)
          info[key] = nextInfo[key].map((subject, i) => {
            if (nextGrid[key][i]) return subject
            const prevLesson = prevDay[i] as { teacher?: unknown } | null | undefined
            const teacher = prevLesson && typeof prevLesson === 'object' ? prevLesson.teacher : undefined
            if (typeof teacher === 'string' && directTeacherKeys.has(normalizeName(teacher))) return ''
            return typeof oldDay[i] === 'string' ? (oldDay[i] as string) : ''
          })
        }
      } else {
        info = storedClassGridToInfoTimetable(master.classes[label])
      }
      add((b) => b.set(ref.collection('info').doc('timetable'), info))
      // 모바일 앱이 남긴 구형 timetable 필드는 새 시간표를 가리므로 제거
      if (legacy) {
        add((b) => b.update(ref, { timetable: FieldValue.delete() }))
      }
      report.classesUpdated++
    }

    // 3) 교사 자동 매칭: 같은 학교 교사 계정의 displayName과 엑셀 이름을 대조
    const teacherSnap = await db
      .collection('users')
      .where('schoolCode', '==', schoolCode)
      .where('role', '==', 'teacher')
      .get()

    const byName = new Map<
      string,
      { uid: string; hasSchedule: boolean; scheduleHash: string; autoHash: unknown }[]
    >()
    teacherSnap.forEach((docSnap) => {
      const d = docSnap.data()
      const current = toSchedule(d.mySchedule)
      // masterName(교사가 직접 연결한 엑셀 이름) 우선, displayName·name도 함께 매칭
      const keys = new Set(
        [d.masterName, d.displayName, d.name]
          .filter((n): n is string => typeof n === 'string' && n.length > 0)
          .map((n) => normalizeName(n))
      )
      for (const key of Array.from(keys)) {
        const list = byName.get(key) || []
        list.push({
          uid: docSnap.id,
          // 모든 칸이 빈 시간표(빈 채로 저장만 누른 경우)는 미입력으로 본다
          hasSchedule: Boolean(d.mySchedule) && !isBlankSchedule(current),
          scheduleHash: scheduleHash(current),
          autoHash: d.myScheduleAutoHash,
        })
        byName.set(key, list)
      }
    })

    const prevTeacherByName = new Map<string, unknown>()
    Object.entries(master.prevTeachers).forEach(([n, g]) => prevTeacherByName.set(normalizeName(n), g))

    for (const [name, grid] of Object.entries(master.teachers)) {
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
      const { uid, hasSchedule, scheduleHash: currentHash, autoHash } = matches[0]
      // 업로드로 자동 등록된 뒤 손대지 않은 시간표는 '직접 입력'이 아니므로 갱신한다.
      // 자동 등록 때 남긴 해시(myScheduleAutoHash)와 같으면 미수정이고, 해시가 없던 예전
      // 자동 등록분(또는 '엑셀에서 불러오기'로 가져온 것)은 직전 마스터 시간표와 같은지로 본다.
      const prevGrid = prevTeacherByName.get(normalizeName(name))
      const untouchedAuto =
        autoHash === currentHash ||
        (prevGrid !== undefined &&
          scheduleHash(storedTeacherGridToMySchedule(prevGrid as Partial<StoredTeacherGrid>)) === currentHash)
      if (hasSchedule && !untouchedAuto && !overwriteTeachers) {
        report.teachersSkippedExisting.push(name)
        continue
      }
      const nextSchedule = storedTeacherGridToMySchedule(grid)
      const nextHash = scheduleHash(nextSchedule)
      report.teachersMatched.push(name)
      if (nextHash === currentHash) {
        // 내용이 그대로면 알림 없이 자동 등록 표식만 맞춘다
        if (autoHash !== nextHash) {
          add((b) => b.set(db.collection('users').doc(uid), { myScheduleAutoHash: nextHash }, { merge: true }))
        }
        continue
      }
      add((b) =>
        b.set(
          db.collection('users').doc(uid),
          { mySchedule: nextSchedule, myScheduleAutoHash: nextHash },
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
    }

    if (ops > 0) commits.push(batch.commit())
    await Promise.all(commits)

    return res.status(200).json({ ok: true, report })
  } catch (e) {
    console.error('timetable-upload error:', e)
    return res.status(500).json({ error: '등록 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.' })
  }
}
