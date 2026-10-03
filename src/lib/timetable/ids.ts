/**
 * 결정적 문서 id 규칙 (서버 전용 — node crypto 사용)
 * 같은 입력을 다시 처리해도 같은 id가 나와 중복 생성되지 않습니다.
 * scripts/migrate-timetable.mjs도 같은 규칙을 씁니다(바꾸면 함께 바꿔야 함).
 */
import { createHash } from 'crypto'

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex')

/** 담임이 '우리 반 공통 수업'으로 확인한 학급 시간표의 (학기, 과목, 교사)별 수업 — 학기가 바뀌면 새 수업 */
export function homeroomCourseId(classId: string, termId: string, subject: string, teacher: string | null | undefined): string {
  return `hc_${classId}_${sha1(`${termId}|${subject}|${teacher || ''}`).slice(0, 10)}`
}

/** 위 수업의 반복 차시(학급·학기·요일·교시·적용 시작일·교실별) */
export function homeroomSeriesId(
  classId: string,
  termId: string,
  weekday: number,
  period: number,
  validFrom: string,
  courseId: string,
  roomName: string | null | undefined
): string {
  return `hcs_${classId}_${termId}_${weekday}${period}_${validFrom}_${sha1(`${courseId}|${roomName || ''}`).slice(0, 10)}`
}

/** 예전 수업 그룹(classes/{학급}_g_{x})에서 옮긴 수업 */
export function legacyGroupCourseId(groupId: string): string {
  return `lg_${groupId}`
}

export function enrollmentDocId(courseId: string, uid: string): string {
  return `${courseId}__${uid}`
}

export function changeSetIdOf(mutationId: string): string {
  return `cs_${mutationId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80)}`
}
