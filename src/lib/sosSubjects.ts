import { DAY_KEYS, cleanSubject } from './timetableConvert'

export function lessonSubject(slot: unknown): string {
  if (typeof slot !== 'string') return ''
  const subject = cleanSubject(
    slot.normalize('NFKC').trim().replace(/^(?:\d+\s*[-–]\s*\d+|\d+\s*학년\s*\d+\s*반)(?:\s+|$)/, '')
  )
  return /^(?:공강|공란|빈\s*시간|수업\s*없음|[-–—])$/.test(subject) ? '' : subject
}

// 시간표에는 정식 과목명과 약칭이 모두 들어올 수 있습니다.
const subjectGroups: [string, RegExp][] = [
  ['과학', /^(?:과학|통과|통합과학|지과|지구과학|지구시스템과학|행성우주과학|물리|물리학|화학|생물|생명|생명과학|과탐실|과학탐구실험|융합과학(?:탐구)?|과학사|생활과과학|역학과에너지|전자기와양자|물질과에너지|화학반응의세계|세포와물질대사|생물의유전|기후변화와환경생태)$/],
  ['국어', /^(?:국어|공통국어|화작|화법과작문|화법과언어|언매|언어와매체|독서|독서와작문|문학|주제탐구독서|문학과영상|매체의사소통|직무의사소통)$/],
  ['수학', /^(?:수학|공통수학|대수|미적분|확통|확률과통계|기하|기본수학|실용수학|경제수학|인공지능수학|수학과제탐구|수학과문화)$/],
  ['영어', /^(?:영어|공통영어|기본영어|영어회화|영어독해와작문|영어발표와토론|영미문학읽기|실생활영어회화|미디어영어|직무영어)$/],
  ['사회', /^(?:사회|통합사회|한국사|세계사|동아시아사|동아시아역사기행|한국지리|세계지리|세계시민과지리|사회문화|사회와문화|경제|정치와법|정법|정치|법과사회|생활과윤리|생윤|윤리와사상|윤사|현대사회와윤리|윤리문제탐구|도덕|역사)$/],
  ['체육', /^(?:체육|운동과건강|스포츠생활|스포츠문화|스포츠과학)$/],
  ['기술·가정', /^(?:기가|기술가정|기술·가정|기술|가정)$/],
]

export function subjectGroup(subject: string): string {
  const name = subject.normalize('NFKC').replace(/[\s·ㆍ]/g, '')
  const withoutLevel = name.replace(/(?:[IV]+|\d+)?[A-Z]?$/i, '')
  return subjectGroups.find(([, pattern]) => pattern.test(withoutLevel))?.[0] ?? name.toLowerCase()
}

export function prioritizeSosTeachers<T extends { subjects: ReadonlySet<string> }>(
  available: T[],
  subject: string
): { recipients: T[]; sameSubject: boolean } {
  const group = subjectGroup(subject)
  const sameSubject = group ? available.filter((teacher) => teacher.subjects.has(group)) : []
  return sameSubject.length
    ? { recipients: sameSubject, sameSubject: true }
    : { recipients: available, sameSubject: false }
}

export function scheduleSubjectGroups(schedule: Record<string, unknown>): Set<string> {
  const subjects = new Set<string>()
  for (const day of DAY_KEYS) {
    const slots = schedule[day]
    if (!Array.isArray(slots)) continue
    for (const slot of slots) {
      const group = subjectGroup(lessonSubject(slot))
      if (group) subjects.add(group)
    }
  }
  return subjects
}
