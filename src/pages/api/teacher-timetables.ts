import type { NextApiRequest, NextApiResponse } from 'next'
import { getFirestore } from 'firebase-admin/firestore'
import { getAdminApp, isAdminConfigured, verifyIdToken } from '../../lib/fcm-admin'
import {
  isBlankSchedule,
  normalizeName,
  normalizeWeeklySchedule,
  storedTeacherGridToMySchedule,
  type StoredTeacherGrid,
  type WeeklySchedule,
} from '../../lib/timetableConvert'

export interface TeacherTimetable {
  id: string
  name: string
  homeroom?: string
  schedule: WeeklySchedule | null
  excelOnly?: boolean
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'private, no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: '허용되지 않는 요청입니다.' })
  }
  if (!isAdminConfigured()) {
    return res.status(503).json({ error: '시간표 서버에 연결할 수 없어요.' })
  }
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  const user = await verifyIdToken(token)
  if (!user) return res.status(401).json({ error: '다시 로그인해 주세요.' })

  try {
    const app = getAdminApp()
    if (!app) return res.status(503).json({ error: '시간표 서버에 연결할 수 없어요.' })
    const db = getFirestore(app)
    const profile = (await db.collection('users').doc(user.uid).get()).data()
    const schoolCode = profile?.schoolCode
    if (profile?.role !== 'teacher' || typeof schoolCode !== 'string' || !schoolCode) {
      return res.status(403).json({ error: '학교를 등록한 교사만 볼 수 있어요.' })
    }

    const [teacherSnapshot, masterSnapshot] = await Promise.all([
      db.collection('users')
        .where('schoolCode', '==', schoolCode)
        .where('role', '==', 'teacher')
        .select('displayName', 'name', 'masterName', 'grade', 'classNm', 'mySchedule')
        .get(),
      db.collection('school_timetables').doc(schoolCode).get(),
    ])
    const teachers = teacherSnapshot.docs.map((doc) => {
      const { displayName, name, masterName, grade, classNm, mySchedule } = doc.data()
      const names = [displayName, name, masterName]
        .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
        .map((value) => value.trim())
      const keys = new Set(
        [masterName, displayName, name]
          .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
          .map(normalizeName)
      )
      const homeroom = /^\d+$/.test(String(grade)) && /^\d+$/.test(String(classNm))
        ? `${grade}학년 ${classNm}반 담임`
        : undefined
      return { id: doc.id, name: names[0], keys, homeroom, schedule: normalizeWeeklySchedule(mySchedule) }
    })
    const nameCounts = new Map<string, number>()
    for (const teacher of teachers) {
      teacher.keys.forEach((key) => nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1))
    }

    const master = (masterSnapshot.get('teachers') ?? {}) as Record<string, StoredTeacherGrid>
    const excelEntries = Object.entries(master).map(([name, grid]) => ({
      name,
      key: normalizeName(name),
      schedule: storedTeacherGridToMySchedule(grid),
    }))
    const excelByName = new Map<string, (typeof excelEntries)[number] | null>()
    for (const entry of excelEntries) {
      excelByName.set(entry.key, excelByName.has(entry.key) ? null : entry)
    }
    const matched = new Set<string>()
    const timetables: TeacherTimetable[] = []
    for (const teacher of teachers) {
      // 동명이인의 엑셀 시간표를 다른 교사 계정에 연결하지 않습니다.
      const excel = Array.from(teacher.keys)
        .map((key) => nameCounts.get(key) === 1 ? excelByName.get(key) : undefined)
        .find((entry) => Boolean(entry))
      if (excel) matched.add(excel.key)
      if (teacher.id === user.uid || !teacher.name) continue
      const schedule = isBlankSchedule(teacher.schedule) ? excel?.schedule : teacher.schedule
      timetables.push({
        id: teacher.id,
        name: teacher.name,
        homeroom: teacher.homeroom,
        schedule: schedule && !isBlankSchedule(schedule) ? schedule : null,
      })
    }
    for (const entry of excelEntries) {
      if (!matched.has(entry.key) && !isBlankSchedule(entry.schedule)) {
        timetables.push({ id: `excel:${entry.name}`, name: entry.name, schedule: entry.schedule, excelOnly: true })
      }
    }
    timetables.sort((a, b) => a.name.localeCompare(b.name, 'ko') || (a.homeroom ?? '').localeCompare(b.homeroom ?? '', 'ko'))
    return res.status(200).json({ teachers: timetables })
  } catch (error) {
    console.error('교사 시간표 조회 실패', error)
    return res.status(500).json({ error: '교사 시간표를 불러오지 못했어요.' })
  }
}
