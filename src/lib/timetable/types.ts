/**
 * 개인 시간표 도메인 타입 (순수 데이터 — Firebase 의존 없음)
 *
 * 개념 구분
 * - 소속 학급(Homeroom): 행정상 소속. 기존 classes/{학교_학년_반} 문서. 학생 users.classId.
 * - 수업반(Course): 학생이 실제로 듣는 수업 집단. schools/{학교}/courses/{courseId}.
 *   과목명·교사명·교실명으로 식별하지 않고 courseId로만 식별합니다.
 * - 수업 장소(Room): 수업이 열리는 장소. 학급과 이름이 같아도 별개(roomId/roomName).
 * - 수강(Enrollment): 학생 ↔ 수업반 관계(기간·상태·출처).
 * - 반복 차시(LessonSeries): 수업반의 요일·교시 반복 일정(적용 기간·버전).
 * - 차시(Occurrence): 특정 날짜의 한 차시. id = `${seriesId}@${원래 날짜}` (보강은 `mk:${changeId}`).
 * - 변경(Override): 한 차시의 '최종 상태'를 기록. 같은 차시에 여러 변경이 있으면 revision이 가장 큰 것만 유효.
 * - 개인 일정(PersonalEntry): 학생이 직접 입력. 공식 수업과 연결되지 않으면 자동 반영되지 않음.
 *
 * 날짜는 학교 시간대(기본 Asia/Seoul)의 'YYYYMMDD' 문자열. 기간은 [from, to) — 시작일 포함, 종료일 미포함.
 */

export type Ymd = string

/** ISO 요일: 월=1 … 일=7 */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7

export interface PeriodTime {
  period: number
  /** 'HH:MM' */
  start: string
  /** 'HH:MM' */
  end: string
}

export type CourseStatus = 'active' | 'ended'

export interface Course {
  courseId: string
  schoolCode: string
  termId: string
  /** 화면 제목. 예: '영어 B' */
  title: string
  /** 과목명. 예: '영어' (식별용 아님) */
  subject: string
  /** 분반명/코드. 예: 'B' */
  section?: string
  /** 인증된 교사 계정 uid (권한 판정용) */
  teacherUids: string[]
  /** 표시용 교사 이름 (엑셀 등에서 온 이름 — 계정 연결 근거로 쓰지 않음) */
  teacherNames: string[]
  /**
   * 관리 교사 uid(예: 학급 시간표로 공통 수업을 만든 담임). 일정 변경·수강 관리 권한만 있고 교사 충돌 판정에는 쓰지 않음.
   * 서버 전용 — 학생 자료(/api/timetable/me)에는 넣지 않음
   */
  managerUids?: string[]
  status: CourseStatus
  /** 수업 종료일(이 날짜부터 수업 없음). 없으면 계속 */
  endedOn?: Ymd | null
  /** 이 학급 학생 모두가 듣는 공통 수업으로 '명시'된 소속 학급 id 목록 */
  commonForHomerooms: string[]
  /** 기본 수업 장소(차시별로 바뀔 수 있음) */
  defaultRoomId?: string | null
  defaultRoomName?: string | null
}

export type EnrollmentStatus = 'active' | 'pending' | 'ended'
export type EnrollmentSource = 'invite' | 'roster' | 'request' | 'admin' | 'legacy-group'

export interface Enrollment {
  courseId: string
  uid: string
  status: EnrollmentStatus
  /** 적용 시작일(포함). 없으면 처음부터 */
  from?: Ymd | null
  /** 적용 종료일(미포함). 없으면 계속 */
  to?: Ymd | null
  source: EnrollmentSource
  /** 예전 수업 그룹 QR로 생긴 수강이면 'group-qr'(출처 표시용) */
  via?: 'group-qr' | null
  /** 선생님이 거절한 수강(status 'ended')인지 — 종료와 구분해 표시 */
  rejected?: boolean
}

export interface HomeroomMembership {
  homeroomId: string
  from?: Ymd | null
  to?: Ymd | null
}

export interface LessonSeries {
  seriesId: string
  courseId: string
  weekday: Weekday
  period: number
  /** 명시 시각이 있으면 교시표보다 우선 */
  start?: string | null
  end?: string | null
  roomId?: string | null
  roomName?: string | null
  teacherNames?: string[]
  teacherUids?: string[]
  validFrom: Ymd
  /** 미포함. null이면 계속 */
  validTo: Ymd | null
  status: 'active' | 'retired'
  /**
   * 학급 시간표로 만든 공통 수업 차시면 그 소속 학급 id(기본 시간표 변경으로 이어진 차시에도 이어 붙임).
   * 학급 시간표 → 공통 수업 재실행이 이 학급 차시를 찾는 근거. 관리용 필드 — 학급 id라 학생 자료에 있어도 새 정보가 아님
   * (같은 수업의 commonForHomerooms에 이미 있음)
   */
  sourceHomeroomId?: string | null
}

/** 한 차시의 상태(변경 후 최종 상태 또는 기본 상태) */
export interface SlotState {
  date: Ymd
  period: number
  start?: string | null
  end?: string | null
  roomId?: string | null
  roomName?: string | null
  teacherNames?: string[]
  teacherUids?: string[]
}

export type OverrideKind =
  | 'cancel' // 이 차시 취소
  | 'reschedule' // 날짜·교시·시각·교실·교사 중 하나 이상 변경(같은 날 교시 이동, 날짜 이동, 교실/교사 변경 포함)
  | 'makeup' // 기본 일정에 없던 차시 추가(보강)
  | 'restore' // 원래 일정으로 복원(이력은 남김)

export interface Override {
  overrideId: string
  courseId: string
  /**
   * 대상 차시 식별자. 반복 차시는 `${seriesId}@${originalDate}`, 보강으로 생긴 차시는 `mk:${id}`.
   * 날짜·교시·교실·교사를 바꿔도 이 값은 그대로 — 같은 차시라는 정체성을 유지합니다.
   */
  occurrenceKey: string
  /** 같은 묶음(교시 교환 등)의 변경 id — 묶음 전체가 함께 발행/표시 */
  changeSetId: string
  /**
   * 같은 묶음에 든 변경들의 `${courseId}|${occurrenceKey}` 목록(묶음 완전성 확인용).
   * 학생이 보는 수업의 변경 중 하나라도 빠졌으면 묶음 전체를 적용하지 않습니다(중간 상태 노출 방지).
   */
  changeSetKeys?: string[]
  kind: OverrideKind
  /** 대상 반복 차시와 원래 날짜. makeup은 없음 */
  seriesId?: string | null
  originalDate?: Ymd | null
  /** cancel/restore가 아닌 경우의 최종 상태 */
  target?: SlotState | null
  reason?: string
  /** 학교 시간표 버전(단조 증가). 같은 차시에 여러 변경이 있으면 가장 큰 것이 유효 */
  revision: number
  status: 'published' | 'withdrawn'
  /** 발행 시각(ms) — 표시용 */
  publishedAt?: number | null
}

export interface PersonalEntry {
  entryId: string
  title: string
  kind: 'weekly' | 'once'
  weekday?: Weekday | null
  date?: Ymd | null
  period?: number | null
  start?: string | null
  end?: string | null
  roomName?: string | null
  memo?: string | null
  /** 공식 수업과 연결되면 그 courseId — 연결되면 개인 일정 대신 공식 수업을 표시하고 메모만 붙임 */
  linkedCourseId?: string | null
  /** 서버 반영 전(오프라인 등) */
  pendingSync?: boolean
}

export interface DayContext {
  date: Ymd
  /** 학기 기간 [startDate, endDate) — 밖이면 'outside-term' */
  term?: { startDate: Ymd; endDate: Ymd } | null
  /** 학교 일정상 쉬는 날(휴업일·공휴일·방학) — 모르면 null */
  offDay?: { name: string } | null
  /** 교시 시각표(학교/학급) — 없으면 교시 번호로만 정렬·충돌 판정 */
  periodTimes?: PeriodTime[]
}

export interface StudentTimetableInput {
  uid: string
  day: DayContext
  homerooms: HomeroomMembership[]
  enrollments: Enrollment[]
  courses: Course[]
  series: LessonSeries[]
  overrides: Override[]
  personalEntries: PersonalEntry[]
}

export type ChangeField = 'date' | 'time' | 'room' | 'teacher'

export interface ChangeInfo {
  kind: 'reschedule' | 'makeup'
  fields: ChangeField[]
  before: SlotState | null
  after: SlotState
  reason?: string
  publishedAt?: number | null
  changeSetId: string
  revision: number
}

export type LessonSource = 'enrolled' | 'common' | 'personal'

export interface LessonView {
  /** 화면 key — 같은 날 같은 차시는 한 번만 */
  key: string
  occurrenceId: string | null
  courseId: string | null
  title: string
  subject?: string
  section?: string
  period: number | null
  start: string | null
  end: string | null
  roomName: string | null
  teacherNames: string[]
  /**
   * 변경 후 최종 담당 교사 uid(공식 수업만 — 개인 일정은 없음). 교사 '내 수업' 판정(teacherDay.ts)이 uid로만 비교하는 근거.
   * 학생 자료(/api/timetable/me)에 이미 있는 courses·series·overrides의 값이라 새 정보가 아님
   */
  teacherUids?: string[]
  source: LessonSource
  /** 공식 수업과 연결되어 학교 변경이 자동 반영되는지 */
  synced: boolean
  change: ChangeInfo | null
  /** 연결된 개인 메모 */
  memo?: string | null
  pendingSync?: boolean
}

export interface NoticeView {
  key: string
  kind: 'cancelled' | 'moved-out' | 'holiday-suppressed'
  /** 보강 차시에 대한 안내인지 */
  makeup?: boolean
  courseId: string
  title: string
  original: SlotState
  /** moved-out이면 옮겨 간 곳 */
  movedTo?: SlotState | null
  reason?: string
}

export interface ConflictView {
  keys: [string, string]
  /** 'official' = 공식 수업끼리, 'personal' = 개인 일정과 겹침 */
  kind: 'official' | 'personal'
}

export type DayState =
  | 'lessons' // 수업 있음
  | 'no-lessons' // 연결된 수업의 기본 시간표가 등록돼 있고 이 날 수업이 없음(정상)
  | 'holiday' // 쉬는 날
  | 'outside-term' // 학기 기간 밖 — '수업 없음'으로 단정하지 않음
  | 'not-registered' // 연결된 수업은 있으나 이 날 적용되는 기본 시간표가 하나도 등록되지 않음
  | 'no-courses' // 연결된 공식 수업도 개인 일정도 없음

export interface DayTimetable {
  date: Ymd
  state: DayState
  lessons: LessonView[]
  notices: NoticeView[]
  conflicts: ConflictView[]
  /** 대상 차시가 더 이상 없는 변경(기본 시간표 버전 변경 등) — 검토 필요 */
  orphanOverrides: Override[]
  /** 승인 대기 중인 수강 */
  pendingCourseIds: string[]
  /** 연결은 됐지만 이 날 적용되는 기본 시간표가 없는 수업(일부만 연결된 불완전 시간표 안내용) */
  coursesWithoutSchedule: string[]
  /** 묶음 일부가 빠져 적용하지 않은 변경 묶음 id */
  incompleteChangeSets: string[]
  activeCourseIds: string[]
  offDayName: string | null
}
