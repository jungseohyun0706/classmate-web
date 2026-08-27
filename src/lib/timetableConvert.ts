// 파싱된 시간표(ParseResult)를 Firestore 저장 형태로 변환/검증하는 공용 모듈.
// 클라이언트(업로드 페이지, 내 시간표 불러오기)와 서버(API 라우트) 양쪽에서 사용합니다.
// Firestore는 "배열 안의 배열"을 허용하지 않으므로 grid[day][period]를
// { mon..fri: (칸|null)[] } 형태(요일 키 맵)로 눕혀 저장합니다.

import type { Lesson, ParseResult, TeacherSlot } from './timetableParser'

export const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri'] as const
export type DayKey = (typeof DAY_KEYS)[number]

export const PERIOD_COUNT = 7 // 앱 전체가 7교시 고정 (class-timetable / my-schedule 과 동일)

/** Firestore에 저장되는 학교 시간표 마스터 문서: school_timetables/{schoolCode} */
export interface StoredSchoolTimetable {
  classes: Record<string, StoredClassGrid>
  teachers: Record<string, StoredTeacherGrid>
  periodTimes: Record<string, string>
  sources: string[]
  uploadedBy?: string
  uploadedByName?: string
  uploadedAt?: unknown
}

export type StoredClassGrid = Record<DayKey, (Lesson | null)[]>
export type StoredTeacherGrid = Record<DayKey, (TeacherSlot | null)[]>

/** "A_화작A" → "화작A" 같은 분반 그룹 접두어 제거 (표시용) */
export const cleanSubject = (subject: string): string =>
  subject.replace(/^[A-Z]{1,2}_/, '').trim()

/** "1-11" → { grade: 1, classNm: 11 } */
export const classLabelToParts = (label: string): { grade: number; classNm: number } | null => {
  const m = label.match(/^(\d{1,2})-(\d{1,2})$/)
  if (!m) return null
  return { grade: parseInt(m[1], 10), classNm: parseInt(m[2], 10) }
}

const padToPeriods = <T>(arr: (T | null)[] | undefined): (T | null)[] => {
  const out = (arr || []).slice(0, PERIOD_COUNT)
  while (out.length < PERIOD_COUNT) out.push(null)
  return out
}

/** ParseResult의 grid[day][period] → 요일 키 맵 (Firestore 저장용) */
export const gridToStored = <T>(grid: (T | null)[][]): Record<DayKey, (T | null)[]> => {
  const out = {} as Record<DayKey, (T | null)[]>
  DAY_KEYS.forEach((key, day) => {
    out[key] = padToPeriods(grid[day])
  })
  return out
}

/** 교사 슬롯 → "1-5 국어" 표시 문자열 */
export const teacherSlotToText = (slot: TeacherSlot | null): string => {
  if (!slot) return ''
  const subject = cleanSubject(slot.subject || '')
  return [slot.classLabel, subject].filter(Boolean).join(' ').trim()
}

/** 저장된 교사 그리드 → users/{uid}.mySchedule ({mon..fri: string[7]}) */
export const storedTeacherGridToMySchedule = (
  grid: Partial<StoredTeacherGrid> | undefined
): Record<DayKey, string[]> => {
  const out = {} as Record<DayKey, string[]>
  DAY_KEYS.forEach((key) => {
    out[key] = padToPeriods(grid?.[key]).map(teacherSlotToText)
  })
  return out
}

/** 저장된 학급 그리드 → classes/{classId}/info/timetable ({mon..fri: string[7]}) */
export const storedClassGridToInfoTimetable = (
  grid: Partial<StoredClassGrid> | undefined
): Record<DayKey, string[]> => {
  const out = {} as Record<DayKey, string[]>
  DAY_KEYS.forEach((key) => {
    out[key] = padToPeriods(grid?.[key]).map((c) => (c ? cleanSubject(c.subject || '') : ''))
  })
  return out
}

// ── 업로드 페이로드 검증 (서버에서 신뢰 경계로 사용) ─────────────

const NAME_RE = /^[가-힣a-zA-Z0-9·\s]{1,20}$/
const CLASS_LABEL_RE = /^\d{1,2}-\d{1,2}$/
const MAX_CLASSES = 150
const MAX_TEACHERS = 300
const MAX_TEXT = 40

const cleanText = (v: unknown): string =>
  typeof v === 'string' ? v.trim().slice(0, MAX_TEXT) : ''

const sanitizeLesson = (v: unknown): Lesson | null => {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const subject = cleanText(o.subject)
  if (!subject) return null
  const lesson: Lesson = { subject }
  const teacher = cleanText(o.teacher)
  const room = cleanText(o.room)
  if (teacher) lesson.teacher = teacher
  if (room) lesson.room = room
  return lesson
}

const sanitizeTeacherSlot = (v: unknown): TeacherSlot | null => {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const subject = cleanText(o.subject)
  const classLabel = cleanText(o.classLabel)
  if (!subject && !classLabel) return null
  const slot: TeacherSlot = { classLabel, subject }
  const room = cleanText(o.room)
  if (room) slot.room = room
  return slot
}

const sanitizeStoredGrid = <T>(
  raw: unknown,
  sanitizeCell: (v: unknown) => T | null
): Record<DayKey, (T | null)[]> | null => {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const out = {} as Record<DayKey, (T | null)[]>
  for (const key of DAY_KEYS) {
    const day = o[key]
    const cells = Array.isArray(day) ? day.slice(0, PERIOD_COUNT) : []
    out[key] = padToPeriods(cells.map(sanitizeCell))
  }
  return out
}

export interface SanitizedUpload {
  classes: Record<string, StoredClassGrid>
  teachers: Record<string, StoredTeacherGrid>
  periodTimes: Record<string, string>
  sources: string[]
}

/**
 * 클라이언트가 보낸 업로드 페이로드를 검증/정화합니다.
 * 형식이 어긋나는 항목은 조용히 버리고, 전체가 비면 null을 돌려줍니다.
 */
export const sanitizeUploadPayload = (raw: unknown): SanitizedUpload | null => {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>

  const classes: Record<string, StoredClassGrid> = {}
  if (o.classes && typeof o.classes === 'object') {
    for (const [label, grid] of Object.entries(o.classes as Record<string, unknown>)) {
      if (!CLASS_LABEL_RE.test(label)) continue
      if (Object.keys(classes).length >= MAX_CLASSES) break
      const clean = sanitizeStoredGrid(grid, sanitizeLesson)
      if (clean) classes[label] = clean
    }
  }

  const teachers: Record<string, StoredTeacherGrid> = {}
  if (o.teachers && typeof o.teachers === 'object') {
    for (const [name, grid] of Object.entries(o.teachers as Record<string, unknown>)) {
      const trimmed = name.trim()
      if (!NAME_RE.test(trimmed)) continue
      if (Object.keys(teachers).length >= MAX_TEACHERS) break
      const clean = sanitizeStoredGrid(grid, sanitizeTeacherSlot)
      if (clean) teachers[trimmed] = clean
    }
  }

  if (Object.keys(classes).length === 0 && Object.keys(teachers).length === 0) return null

  const periodTimes: Record<string, string> = {}
  if (o.periodTimes && typeof o.periodTimes === 'object') {
    for (const [k, v] of Object.entries(o.periodTimes as Record<string, unknown>)) {
      if (/^\d{1,2}$/.test(k) && typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v)) {
        periodTimes[k] = v
      }
    }
  }

  const sources = Array.isArray(o.sources)
    ? o.sources.filter((s): s is string => typeof s === 'string').map((s) => s.slice(0, 120)).slice(0, 20)
    : []

  return { classes, teachers, periodTimes, sources }
}

/** 업로드 직전 클라이언트에서 ParseResult → 전송용 페이로드로 변환 */
export const parseResultToUpload = (result: ParseResult): SanitizedUpload => {
  const classes: Record<string, StoredClassGrid> = {}
  for (const [label, grid] of Object.entries(result.classes)) {
    classes[label] = gridToStored(grid)
  }
  const teachers: Record<string, StoredTeacherGrid> = {}
  for (const [name, grid] of Object.entries(result.teachers)) {
    teachers[name] = gridToStored(grid)
  }
  const periodTimes: Record<string, string> = {}
  for (const [p, t] of Object.entries(result.periodTimes)) periodTimes[String(p)] = t
  return { classes, teachers, periodTimes, sources: result.sources }
}

/** 이름 매칭용 정규화 (공백 제거) */
export const normalizeName = (name: string): string => name.replace(/\s+/g, '').trim()
