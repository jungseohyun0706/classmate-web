/**
 * 시간표 엑셀 가져오기 — 정규화·매칭·발행 계획 (T29~T33) + 정책: 공통 수업은 담임 확인만, 교사 계정 연결은 발행 교사 확인만
 *
 * 테스트 데이터는 모두 가상입니다(tests/fixtures/import/*.json의 note 참고). 실제 학교·교사·학생 자료가 아니며,
 * 실제 엑셀 파일을 확보하지 못해 열 구조를 추정하지 않고 '정규화 행(ImportRow)'만 입력으로 씁니다.
 *   학교 S1, 학기 2026-2, 적용일 2026-09-07(월)
 *   3-4 국어(김민수) · 3-5 국어(김민수) · 영어 A(이영희, 어학실, 3-4·3-5 이동수업) · 영어 B(정하늘, 미가입) · 3-4 음악(최유나, 음악실)
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

import {
  buildCandidates,
  classIdFor,
  courseIdFor,
  docMatches,
  existingFromDocs,
  maskEmail,
  nameKey,
  normalizeClassLabel,
  normalizePeriod,
  normalizeRow,
  normalizeWeekday,
  packOps,
  planDigest,
  planImport,
  resolveTeacherConfirmations,
  seriesIdFor,
  sha256Hex,
  splitConfirmations,
  splitSectionPrefix,
  splitTeachers,
  undoSetOf,
  type BuildResult,
  type CourseCandidate,
  type ImportPlan,
  type RawImportRow,
  type TeacherAccount,
} from '../../src/lib/timetable/importMatch'
import { buildDayTimetable } from '../../src/lib/timetable/engine'
import type { Course, LessonSeries, StudentTimetableInput, Ymd } from '../../src/lib/timetable/types'

// ───────────────────────── 픽스처 ─────────────────────────

interface Fixture {
  note: string
  schoolCode: string
  termId: string
  validFrom: Ymd
  teachers: TeacherAccount[]
  rows: RawImportRow[]
  expected?: Record<string, unknown>
  expectedIssueCodes?: Record<'error' | 'review' | 'info', string[]>
}

function loadFixture(name: string): Fixture {
  // 컴파일 위치(.test-dist/tests/unit)와 원본 위치(tests/unit) 모두에서 찾음
  const candidates = [
    path.resolve(__dirname, '../fixtures/import', name),
    path.resolve(__dirname, '../../../tests/fixtures/import', name),
    path.resolve(process.cwd(), 'tests/fixtures/import', name),
  ]
  const file = candidates.find((p) => fs.existsSync(p))
  if (!file) throw new Error('fixture not found: ' + name)
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Fixture
}

const THREE = loadFixture('three-sources.json')
const AMB = loadFixture('ambiguous.json')
const S = THREE.schoolCode
const TERM = THREE.termId
const X1 = THREE.validFrom // 20260907 (월)
const X2 = '20261005' // 수정본 적용일 (월)

const build = (rows: RawImportRow[], teachers: TeacherAccount[] = THREE.teachers): BuildResult =>
  buildCandidates(rows, { schoolCode: S, teachers })

const byKey = (r: BuildResult, key: string): CourseCandidate => {
  const c = r.courses.find((x) => x.importKey === key)
  assert.ok(c, `수업 후보 없음: ${key} (있는 것: ${r.courses.map((x) => x.importKey).join(', ')})`)
  return c as CourseCandidate
}

/** 결정적 셔플(시드 고정) */
function shuffled<T>(arr: T[], seed: number): T[] {
  const out = arr.slice()
  let s = seed
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648
    const j = s % (i + 1)
    const t = out[i]
    out[i] = out[j]
    out[j] = t
  }
  return out
}

/** 가짜 DB(문서 = 평범한 객체) — 서버와 같은 방식(set merge)으로 계획을 반영하고, 같은 변환으로 기존 자료를 읽음 */
class FakeDb {
  courses: Record<string, Record<string, unknown>> = {}
  series: Record<string, Record<string, unknown>> = {}
  apply(plan: ImportPlan) {
    plan.items.forEach((it) =>
      it.ops.forEach((op) => {
        const coll = op.target === 'course' ? this.courses : this.series
        coll[op.id] = { ...(coll[op.id] || {}), ...JSON.parse(JSON.stringify(op.set)) }
      })
    )
  }
  undo(plan: ImportPlan, validFrom: Ymd) {
    plan.items.forEach((it) =>
      it.ops.forEach((op) => {
        const coll = op.target === 'course' ? this.courses : this.series
        coll[op.id] = { ...(coll[op.id] || {}), ...JSON.parse(JSON.stringify(undoSetOf(op, validFrom))) }
      })
    )
  }
  existing() {
    return existingFromDocs(
      Object.keys(this.courses).map((id) => ({ id, data: this.courses[id] })),
      Object.keys(this.series).map((id) => ({ id, data: this.series[id] }))
    )
  }
  snapshot() {
    return JSON.parse(JSON.stringify({ courses: this.courses, series: this.series }))
  }
}

function plan(
  r: BuildResult,
  db: FakeDb,
  opts: {
    validFrom?: Ymd
    mode?: 'merge' | 'replace'
    batchId?: string
    revision?: number
    confirm?: string[]
    links?: Array<{ nameKey: string; uid: string }>
    publisher?: string | null
  } = {}
): ImportPlan {
  return planImport({
    schoolCode: S,
    termId: TERM,
    validFrom: opts.validFrom || X1,
    mode: opts.mode || 'merge',
    batchId: opts.batchId || 'batch-1',
    revision: opts.revision ?? 1,
    courses: r.courses.filter((c) => !c.blocked),
    keepKeys: r.courses.filter((c) => c.blocked).map((c) => c.importKey),
    existing: db.existing(),
    confirmedTeacherUids: opts.confirm,
    confirmedTeacherLinks: opts.links,
    publisherUid: opts.publisher,
  })
}

/** 계획에서 수업 문서 쓰기(create/update)의 set */
const courseSet = (p: ImportPlan, key: string): Record<string, unknown> | null => {
  const it = p.items.find((i) => i.importKey === key)
  const op = it ? it.ops.find((o) => o.target === 'course') : null
  return op ? op.set : null
}
const KIM = 'uid-test-teacher-kim'
const LEE = 'uid-test-teacher-lee'
const CHOI = 'uid-test-teacher-choi'
const K_KOR34 = 'hr|3-4|국어|김민수'
const K_KOR35 = 'hr|3-5|국어|김민수'
const K_ENGA = 'sec|영어|A|이영희'
const K_ENGB = 'sec|영어|B|정하늘'
const K_MUSIC = 'hr|3-4|음악|최유나'

/** 수정본: 음악 장소 변경(세 자료 모두) + 3-5 국어 목 1교시 → 목 3교시 */
function revisedRows(): RawImportRow[] {
  return THREE.rows.map((r) => {
    const x = { ...r }
    if (nameKey(x.subject) === '음악') x.room = x.room ? '음악실2' : x.room
    if (x.sourceKind === 'room' && nameKey(x.subject) === '음악') x.sheet = '특별실시간표#음악실2'
    if (nameKey(x.subject) === '국어' && x.weekday === 4 && x.period === 1) x.period = 3
    return x
  })
}

// ───────────────────────── 정규화 ─────────────────────────

describe('정규화(13-2): 표기 차이만 정리하고 다른 값은 합치지 않음', () => {
  test('요일 표기 → 1..7', () => {
    for (const [v, want] of [
      ['월', 1], ['월요일', 1], ['(화)', 2], ['Mon', 1], ['monday', 1], ['THU', 4], ['일', 7], [5, 5], ['6', 6],
    ] as Array<[string | number, number]>) {
      assert.equal(normalizeWeekday(v), want, `요일 ${v}`)
    }
    for (const bad of ['월화', '', 0, 8, '8', 'xyz', 'constructor', 1.5]) assert.equal(normalizeWeekday(bad), null, `요일 ${String(bad)}`)
  })

  test('교시 표기 → 숫자', () => {
    assert.equal(normalizePeriod('3교시'), 3)
    assert.equal(normalizePeriod('제3교시'), 3)
    assert.equal(normalizePeriod(' 3 '), 3)
    assert.equal(normalizePeriod('3교시(10:50)'), 3)
    assert.equal(normalizePeriod('3교시\n(10:50)'), 3)
    assert.equal(normalizePeriod(7), 7)
    assert.equal(normalizePeriod('10:50'), null, '시각을 교시로 읽지 않음')
    assert.equal(normalizePeriod('3~4'), null)
  })

  test("학년·반 표기 → '3-4'", () => {
    for (const v of ['3학년 4반', '3학년4반', '3-4', '03-4', '3-04', '304', '3/4', '3 - 4', '3-4반', '0304']) {
      assert.equal(normalizeClassLabel(v), '3-4', v)
    }
    assert.equal(normalizeClassLabel('310'), '3-10')
    assert.equal(normalizeClassLabel('111'), '1-11')
    assert.equal(normalizeClassLabel('3학년 반'), null)
    assert.equal(normalizeClassLabel('A반'), null)
    assert.equal(normalizeClassLabel('9-1'), null, '학년 범위 밖')
    assert.equal(classIdFor('S1', '3-4'), 'S1_3_4')
  })

  test("분반 접두어 'A_화작A' → section 'A', subject '화작A'(원문 보존)", () => {
    assert.deepEqual(splitSectionPrefix('A_화작A'), { section: 'A', subject: '화작A' })
    assert.deepEqual(splitSectionPrefix('Ａ_영어'), { section: 'A', subject: '영어' }, '전각 문자')
    assert.deepEqual(splitSectionPrefix('영어 A'), { section: null, subject: '영어 A' }, '접두어가 아니면 그대로')
    const n = normalizeRow({ sourceKind: 'class', sheet: 's', row: 1, weekday: 1, period: 1, subject: 'A_화작A', teacher: '김민수(15)' })
    assert.ok(n.row)
    assert.equal(n.row?.section, 'A')
    assert.equal(n.row?.subject, '화작A')
    assert.equal(n.row?.subjectRaw, 'A_화작A', '원문 보존')
    assert.deepEqual(n.row?.teachers, ['김민수'], '시수 표기 제거')
  })

  test('공백 정리는 하지만 비슷한 이름은 합치지 않음', () => {
    assert.equal(nameKey(' 김 민수 '), nameKey('김민수'))
    assert.equal(nameKey('생활과  과학'), nameKey('생활과과학'))
    assert.notEqual(nameKey('김민수'), nameKey('김민서'))
    assert.notEqual(nameKey('영어'), nameKey('영어I'))
    assert.deepEqual(splitTeachers('김민수, 이영희'), ['김민수', '이영희'])
    assert.deepEqual(splitTeachers('김민수(12)/이영희(3)'), ['김민수', '이영희'])
  })

  test('빈 칸은 조용히 건너뛰고, 잘못된 값은 행 위치와 함께 오류', () => {
    assert.deepEqual(normalizeRow({ sourceKind: 'class', sheet: 's', row: 3, weekday: 1, period: 1, subject: '  ' }), { row: null, issues: [] })
    const bad = normalizeRow({ sourceKind: 'class', sheet: '학급#3-4', row: 9, col: 4, weekday: '월', period: '0교시', subject: '국어', teacher: '김민수' })
    assert.equal(bad.row, null)
    assert.equal(bad.issues[0].code, 'bad-period')
    assert.equal(bad.issues[0].severity, 'error')
    assert.deepEqual(bad.issues[0].rows, [{ sheet: '학급#3-4', row: 9, col: 4 }])
    assert.ok(bad.issues[0].fix.length > 0)
  })
})

describe('결정적 id', () => {
  test('SHA-256 구현이 표준값·node crypto와 같음(한글 포함)', () => {
    assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    for (const s of ['S1|2026-2|hr|3-4|국어|김민수', 'x'.repeat(200), '😀 이모지', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64)]) {
      assert.equal(sha256Hex(s), createHash('sha256').update(s, 'utf8').digest('hex'), s.slice(0, 20))
    }
  })

  test('courseId·seriesId는 입력이 같으면 같고, 학교·학기가 다르면 다름', () => {
    const a = courseIdFor('S1', '2026-2', 'hr|3-4|국어|김민수')
    assert.equal(a, courseIdFor('S1', '2026-2', 'hr|3-4|국어|김민수'))
    assert.match(a, /^im_[0-9a-f]{24}$/)
    assert.notEqual(a, courseIdFor('S2', '2026-2', 'hr|3-4|국어|김민수'))
    assert.notEqual(a, courseIdFor('S1', '2027-1', 'hr|3-4|국어|김민수'))
    assert.match(seriesIdFor(a, 1, 1, '20260907'), /^is_[0-9a-f]{24}$/)
    assert.notEqual(seriesIdFor(a, 1, 1, '20260907'), seriesIdFor(a, 1, 1, '20261005'))
  })
})

// ───────────────────────── T29 ─────────────────────────

describe('T29 세 엑셀 통합: 같은 차시가 여러 자료에 있어도 수업·차시 하나', () => {
  const r = build(THREE.rows)

  test('수업 5개, 차시 9개, 나머지 행은 중복으로 합쳐짐', () => {
    assert.equal(r.stats.rows, THREE.rows.length)
    assert.equal(r.courses.length, 5)
    assert.equal(r.stats.lessons, 9)
    assert.equal(r.stats.duplicatesMerged, THREE.rows.length - 9)
    assert.equal(r.stats.errors, 0, JSON.stringify(r.issues.filter((i) => i.severity === 'error')))
    assert.equal(r.stats.review, 0, JSON.stringify(r.issues.filter((i) => i.severity === 'review')))
  })

  test('학급·교사·특별실·전체 자료의 같은 차시가 출처 목록에 모두 남음', () => {
    const music = byKey(r, 'hr|3-4|음악|최유나')
    assert.equal(music.series.length, 1)
    assert.deepEqual(
      music.sources.map((s) => s.sourceKind).sort(),
      ['class', 'room', 'teacher'],
      '학급표·교사표·특별실표 세 곳'
    )
    assert.equal(music.series[0].roomName, '음악실')
    const kor34 = byKey(r, 'hr|3-4|국어|김민수')
    assert.deepEqual(
      kor34.series.map((s) => [s.weekday, s.period]),
      [[1, 1], [2, 2]]
    )
    assert.ok(kor34.sources.some((s) => s.sourceKind === 'table'), '전체시간표(평면형, 요일·교시 원문 표기)도 같은 차시로 합쳐짐')
    const engA = byKey(r, 'sec|영어|A|이영희')
    assert.equal(engA.series.length, 2)
    assert.equal(engA.sources.length, 6, '학급표 2 + 교사표 2 + 특별실표 2')
  })

  test("공백만 다른 교사 이름(' 김 민수 ')은 같은 교사로, 표시 이름은 가장 많이 쓰인 표기", () => {
    const kor35 = byKey(r, 'hr|3-5|국어|김민수')
    assert.deepEqual(kor35.teacherNames, ['김민수'])
    assert.equal(kor35.series.length, 2)
  })

  test('교사 계정은 masterName 일치 계정을 연결 후보로만(권한 아님)', () => {
    assert.deepEqual(byKey(r, K_KOR34).candidateTeacherUids, [KIM])
    assert.deepEqual(byKey(r, K_ENGB).candidateTeacherUids, [], '가입하지 않은 교사는 후보 없음(이름만)')
    assert.equal(r.stats.unlinkedTeachers, 1, '후보 계정이 없는 이름: 정하늘')
    assert.equal(r.stats.teacherLinkCandidates, 3, '후보가 있는 이름: 김민수·이영희·최유나')
    assert.ok(r.issues.some((i) => i.code === 'teacher-unlinked' && i.severity === 'info'))
    const kim = r.teacherLinks.find((l) => l.name === '김민수')
    assert.equal(kim?.reason, 'candidate')
    assert.deepEqual(kim?.candidates.map((c) => c.uid), [KIM])
    assert.deepEqual(kim?.importKeys, [K_KOR34, K_KOR35], '이 이름이 나오는 수업')
    assert.ok(!('teacherUids' in byKey(r, K_KOR34)), '후보 단계에는 담당 교사 uid가 없음')
  })
})

// ───────────────────────── T30 ─────────────────────────

describe('T30 재업로드: 같은 파일·순서 바꿈·수정본', () => {
  const first = build(THREE.rows)

  test('행 순서를 바꿔도 결과(수업·차시·이슈·통계)가 완전히 같음', () => {
    for (const seed of [1, 7, 42, 2026]) {
      const again = build(shuffled(THREE.rows, seed))
      assert.deepEqual(again, first, `seed ${seed}`)
    }
    const amb = build(AMB.rows, AMB.teachers)
    assert.deepEqual(build(shuffled(AMB.rows, 99), AMB.teachers), amb, '오류·검토 이슈도 순서와 무관')
  })

  test('첫 발행은 모두 신규, 같은 파일 재업로드는 모두 동일(쓰기 0)', () => {
    const db = new FakeDb()
    const p1 = plan(first, db, { batchId: 'b1', revision: 1 })
    assert.deepEqual(
      p1.items.map((i) => i.status),
      ['new', 'new', 'new', 'new', 'new']
    )
    db.apply(p1)
    assert.equal(Object.keys(db.courses).length, 5)
    assert.equal(Object.keys(db.series).length, 9)
    for (const c of first.courses) assert.ok(db.courses[courseIdFor(S, TERM, c.importKey)], c.importKey)

    const p2 = plan(build(shuffled(THREE.rows, 5)), db, { batchId: 'b2', revision: 2 })
    assert.deepEqual(p2.items.map((i) => i.status), ['same', 'same', 'same', 'same', 'same'])
    assert.equal(p2.opCount, 0)
    const p3 = plan(first, db, { batchId: 'b3', revision: 2, validFrom: X2 })
    assert.equal(p3.opCount, 0, '적용일만 다른 같은 내용도 동일')
  })

  test('수정본은 바뀐 수업만 갱신(update), 기존 차시는 적용일에 끝나고 새 차시가 적용일부터', () => {
    const db = new FakeDb()
    db.apply(plan(first, db, { batchId: 'b1', revision: 1 }))
    const before = db.snapshot()
    const rev = build(revisedRows())
    assert.equal(rev.stats.errors + rev.stats.review, 0, JSON.stringify(rev.issues))
    const p = plan(rev, db, { batchId: 'b2', revision: 2, validFrom: X2 })
    const status = Object.fromEntries(p.items.map((i) => [i.importKey, i.status]))
    assert.deepEqual(status, {
      'hr|3-4|국어|김민수': 'same',
      'hr|3-4|음악|최유나': 'update',
      'hr|3-5|국어|김민수': 'update',
      'sec|영어|A|이영희': 'same',
      'sec|영어|B|정하늘': 'same',
    })
    const music = p.items.find((i) => i.importKey === 'hr|3-4|음악|최유나')
    assert.deepEqual(music?.ops.map((o) => `${o.target}:${o.kind}`), ['course:update', 'series:close', 'series:create'])
    db.apply(p)
    const musicId = courseIdFor(S, TERM, 'hr|3-4|음악|최유나')
    const oldId = seriesIdFor(musicId, 4, 4, X1)
    const newId = seriesIdFor(musicId, 4, 4, X2)
    assert.equal(db.series[oldId].validFrom, X1)
    assert.equal(db.series[oldId].validTo, X2, '과거 차시 보존: 적용일 전날까지')
    assert.equal(db.series[oldId].roomName, '음악실')
    assert.equal(db.series[newId].validFrom, X2)
    assert.equal(db.series[newId].validTo, null)
    assert.equal(db.series[newId].roomName, '음악실2')
    const korId = courseIdFor(S, TERM, 'hr|3-5|국어|김민수')
    assert.equal(db.series[seriesIdFor(korId, 4, 1, X1)].validTo, X2, '없어진 목 1교시는 적용일에 종료(삭제 아님)')
    assert.equal(db.series[seriesIdFor(korId, 4, 3, X2)].validFrom, X2)
    assert.equal(db.series[seriesIdFor(korId, 1, 2, X1)].validTo, null, '바뀌지 않은 월 2교시는 그대로')

    // 원복(그 배치의 쓰기만 되돌림) → 처음 상태와 같음
    db.undo(p, X2)
    const after = db.snapshot()
    for (const id of Object.keys(before.series)) {
      for (const k of ['validFrom', 'validTo', 'status', 'roomName', 'weekday', 'period']) {
        assert.deepEqual(after.series[id][k], before.series[id][k], `${id}.${k}`)
      }
    }
    assert.equal(after.series[newId].status, 'retired', '그 배치가 만든 차시는 종료')
    assert.equal(after.series[newId].validTo, X2, '빈 기간으로 닫힘')
    for (const id of Object.keys(before.courses)) {
      for (const k of ['title', 'teacherNames', 'commonForHomerooms', 'revision', 'importBatchId', 'status']) {
        assert.deepEqual(after.courses[id][k], before.courses[id][k], `${id}.${k}`)
      }
    }
  })

  test('같은 적용일로 고친 수정본은 같은 id 차시를 그 자리에서 고침(중복 차시 없음)', () => {
    const db = new FakeDb()
    db.apply(plan(first, db, { batchId: 'b1', revision: 1 }))
    const p = plan(build(revisedRows()), db, { batchId: 'b2', revision: 2, validFrom: X1 })
    const music = p.items.find((i) => i.importKey === 'hr|3-4|음악|최유나')
    assert.deepEqual(music?.ops.map((o) => `${o.target}:${o.kind}`), ['course:update', 'series:overwrite'])
    const kor = p.items.find((i) => i.importKey === 'hr|3-5|국어|김민수')
    assert.deepEqual(kor?.ops.map((o) => `${o.target}:${o.kind}`).sort(), ['course:update', 'series:create', 'series:retire'])
    db.apply(p)
    const active = Object.values(db.series).filter((s) => s.status === 'active')
    assert.equal(active.length, 9, '차시 수는 그대로 9개')
  })

  test("replace: 이번 파일에 없는 import 수업은 적용일부터 종료(삭제하지 않음), merge는 그대로", () => {
    const db = new FakeDb()
    db.apply(plan(first, db, { batchId: 'b1', revision: 1 }))
    const withoutMusic = THREE.rows.filter((r) => nameKey(r.subject) !== '음악')
    const merge = plan(build(withoutMusic), db, { batchId: 'b2', revision: 2, validFrom: X2 })
    assert.equal(merge.opCount, 0)
    const replace = plan(build(withoutMusic), db, { batchId: 'b2', revision: 2, validFrom: X2, mode: 'replace' })
    const retired = replace.items.filter((i) => i.status === 'retire')
    assert.equal(retired.length, 1)
    assert.equal(retired[0].importKey, 'hr|3-4|음악|최유나')
    db.apply(replace)
    const musicId = courseIdFor(S, TERM, 'hr|3-4|음악|최유나')
    assert.ok(db.courses[musicId], '수업 문서는 남음')
    assert.equal(db.series[seriesIdFor(musicId, 4, 4, X1)].validTo, X2)
  })

  test('replace로 끝난 수업을 더 이른 적용일로 다시 올리면 차시도 다시 이어짐(수업만 재활성되지 않음)', () => {
    const db = new FakeDb()
    db.apply(plan(first, db, { batchId: 'b1', revision: 1 }))
    const withoutMusic = THREE.rows.filter((r) => nameKey(r.subject) !== '음악')
    db.apply(plan(build(withoutMusic), db, { batchId: 'b2', revision: 2, validFrom: X2, mode: 'replace' }))
    const X15 = '20260914'
    const p = plan(first, db, { batchId: 'b3', revision: 3, validFrom: X15 })
    const music = p.items.find((i) => i.importKey === 'hr|3-4|음악|최유나')
    assert.equal(music?.status, 'update')
    assert.deepEqual(music?.ops.map((o) => `${o.target}:${o.kind}`), ['course:update', 'series:close', 'series:create'])
    db.apply(p)
    const musicId = courseIdFor(S, TERM, 'hr|3-4|음악|최유나')
    assert.equal(db.series[seriesIdFor(musicId, 4, 4, X1)].validTo, X15)
    assert.equal(db.series[seriesIdFor(musicId, 4, 4, X15)].validTo, null, '적용일부터 계속')
    assert.equal(db.courses[musicId].importRetiredOn, null)
    assert.equal(p.items.filter((i) => i.status !== 'same').length, 1, '다른 수업은 그대로')
  })

  test('미래 적용일 버전이 이미 있으면 futureVersions로 보고(서버가 error로 막음)', () => {
    const db = new FakeDb()
    db.apply(plan(first, db, { batchId: 'b1', revision: 1 }))
    db.apply(plan(build(revisedRows()), db, { batchId: 'b2', revision: 2, validFrom: X2 }))
    const p = plan(first, db, { batchId: 'b3', revision: 3, validFrom: '20260914' })
    assert.deepEqual(
      Array.from(new Set(p.futureVersions.map((f) => f.importKey))).sort(),
      ['hr|3-4|음악|최유나', 'hr|3-5|국어|김민수']
    )
  })

  test('미리보기·확정 비교용 해시는 같은 상태에서 같고, 상태가 바뀌면 다름', () => {
    const db = new FakeDb()
    const a = planDigest(plan(first, db), [])
    assert.equal(a, planDigest(plan(build(shuffled(THREE.rows, 3)), db), []))
    db.apply(plan(first, db))
    assert.notEqual(a, planDigest(plan(first, db), []))
  })

  test('쓰기 묶음은 400개 이하로 나뉘고 한 수업의 쓰기는 같은 묶음', () => {
    const db = new FakeDb()
    const p = plan(first, db)
    const packs = packOps(p.items, 4)
    assert.ok(packs.every((x) => x.length <= 4))
    assert.equal(packs.reduce((n, x) => n + x.length, 0), p.opCount)
    for (const pack of packs) {
      const courses = new Set(pack.map((o) => o.courseId))
      for (const cid of Array.from(courses)) {
        const all = p.items.find((i) => i.courseId === cid)?.ops.length || 0
        if (all <= 4) assert.equal(pack.filter((o) => o.courseId === cid).length, all, cid)
      }
    }
  })

  test('원복 검증: 이후 수동 수정으로 바뀐 문서는 이번 배치 값과도, 이전 값과도 다름', () => {
    const db = new FakeDb()
    const p = plan(first, db, { batchId: 'b1', revision: 1 })
    db.apply(p)
    const op = p.items[0].ops[0]
    assert.ok(docMatches(db.courses[op.id], op.set))
    db.courses[op.id] = { ...db.courses[op.id], title: '수동으로 바꾼 이름', revision: 5 }
    assert.equal(docMatches(db.courses[op.id], op.set), false)
    assert.equal(docMatches(db.courses[op.id], undoSetOf(op, X1)), false)
  })
})

// ───────────────────────── T31 ─────────────────────────

describe('T31 원본 오류: 잘못된 교시·미연결 교사·중복 분반·모호한 매칭을 미리보기에서 검출', () => {
  const r = build(AMB.rows, AMB.teachers)
  const codesOf = (sev: string) => Array.from(new Set(r.issues.filter((i) => i.severity === sev).map((i) => i.code))).sort()

  test('픽스처가 기대한 오류·검토·안내 코드가 모두 나옴', () => {
    const exp = AMB.expectedIssueCodes as Record<string, string[]>
    assert.deepEqual(codesOf('error'), exp.error.slice().sort())
    for (const c of exp.review) assert.ok(codesOf('review').indexOf(c) >= 0, `review ${c}`)
    for (const c of exp.info) assert.ok(codesOf('info').indexOf(c) >= 0, `info ${c}`)
  })

  test('오류에는 시트·행 번호와 고칠 방법이 있음', () => {
    const period = r.issues.find((i) => i.code === 'bad-period')
    assert.deepEqual(period?.rows, [{ sheet: '학급시간표#3학년 6반', row: 14, col: 2 }])
    assert.match(period?.message || '', /14행/)
    assert.ok((period?.fix || '').length > 10)
    for (const i of r.issues.filter((x) => x.severity !== 'info')) {
      assert.ok(i.fix, `${i.code} fix`)
      if (i.code !== 'future-version') assert.ok(i.rows.length > 0, `${i.code} rows`)
    }
  })

  test('교사 충돌(같은 시간 서로 다른 학급·과목)은 error — 그 수업들은 발행 불가', () => {
    const conflict = r.issues.find((i) => i.code === 'teacher-conflict')
    assert.equal(conflict?.severity, 'error')
    assert.equal(byKey(r, 'hr|3-6|국어|김민수').blocked, 'error')
    assert.equal(byKey(r, 'hr|3-7|문학|김민수').blocked, 'error')
  })

  test("모호한 매칭: 교사 없는 '영어'를 이영희·정하늘 중 하나로 정하지 않음", () => {
    const amb = r.issues.find((i) => i.code === 'ambiguous-match')
    assert.ok(amb)
    assert.match(amb?.message || '', /이영희, 정하늘/)
    const engA = byKey(r, 'sec|영어|A|이영희')
    assert.equal(engA.sources.length, 1, '교사 없는 학급표 행을 A 분반에 붙이지 않음')
    assert.equal(byKey(r, 'hr|3-6|영어|').blocked, 'review')
  })

  test('같은 학급·같은 시간 분반 없는 두 과목 → 이동수업/선택 가능(review), 공통 수업으로 발행하지 않음', () => {
    const i = r.issues.find((x) => x.code === 'class-slot-multiple' && /3-7반/.test(x.message))
    assert.ok(i)
    assert.match(i?.message || '', /분반 코드 필요/)
    assert.equal(byKey(r, 'hr|3-7|화작|강민지').blocked, 'review')
    assert.equal(byKey(r, 'hr|3-7|언매|윤서준').blocked, 'review')
  })

  test('중복 분반·장소 불일치·합반·교사 미확인·자료 불일치는 review', () => {
    assert.deepEqual(
      r.issues.find((i) => i.code === 'duplicate-section')?.importKeys,
      ['sec|수학|A|오세진', 'sec|수학|A|한도윤']
    )
    assert.match(r.issues.find((i) => i.code === 'room-mismatch')?.message || '', /음악실 \/ 음악실2/)
    assert.equal(byKey(r, 'hr|3-6|음악|최유나').series[0].roomName, null, '장소를 마지막 자료로 정하지 않음')
    const combined = byKey(r, 'mc|3-6+3-7|과학|오세진')
    assert.deepEqual(combined.commonCandidates, [], '여러 학급 수업은 공통 수업 후보도 아님')
    assert.ok(r.issues.some((i) => i.code === 'teacher-missing' && /체육/.test(i.message)))
    assert.ok(r.issues.some((i) => i.code === 'source-mismatch' && /김민수 선생님 교사시간표/.test(i.message)))
  })

  test('후보 계정 없는 교사 5명, 동명이인(masterName 같은 계정 둘)은 둘 다 후보로 보여 주고 자동 연결하지 않음', () => {
    assert.equal(r.stats.unlinkedTeachers, 5)
    assert.ok(r.issues.some((i) => i.code === 'teacher-ambiguous' && /최유나/.test(i.message)))
    assert.deepEqual(byKey(r, 'hr|3-6|음악|최유나').candidateTeacherUids, ['uid-test-teacher-choi', 'uid-test-teacher-choi2'])
    assert.equal(r.teacherLinks.find((l) => l.name === '최유나')?.reason, 'ambiguous')
  })

  test('검토 수업은 계획에서 빠지고(keepKeys), 오류 행은 차시로 만들지 않음', () => {
    const p = plan(r, new FakeDb())
    const planned = p.items.map((i) => i.importKey).sort()
    assert.deepEqual(planned, ['sec|영어|A|이영희', 'sec|영어|B|정하늘'])
    assert.ok(!r.courses.some((c) => c.series.some((s) => s.period > 10)))
  })
})

// ───────────────────────── T33 ─────────────────────────

describe('T33 동명이인·같은 과목명 다른 분반: 잘못 합치지 않음', () => {
  const base = { sourceKind: 'class' as const, sheet: '학급시간표#3학년 4반', classLabel: '3-4' }

  test('같은 과목명 다른 분반 → 다른 수업', () => {
    const r = build([
      { ...base, row: 1, weekday: 1, period: 1, subject: 'A_영어', teacher: '이영희' },
      { ...base, row: 2, weekday: 2, period: 1, subject: 'B_영어', teacher: '이영희' },
    ])
    assert.deepEqual(r.courses.map((c) => c.importKey), ['sec|영어|A|이영희', 'sec|영어|B|이영희'])
    assert.deepEqual(r.courses.map((c) => c.title), ['영어 A', '영어 B'])
  })

  test('같은 과목명·같은 학급이라도 교사가 다르면 다른 수업', () => {
    const r = build([
      { ...base, row: 1, weekday: 1, period: 1, subject: '영어', teacher: '이영희' },
      { ...base, row: 2, weekday: 3, period: 2, subject: '영어', teacher: 'John Smith' },
    ])
    assert.equal(r.courses.length, 2)
    assert.notEqual(courseIdFor(S, TERM, r.courses[0].importKey), courseIdFor(S, TERM, r.courses[1].importKey))
  })

  test('비슷한 교사 이름(김민수/김민서)은 합치지 않음', () => {
    const r = build([
      { ...base, row: 1, weekday: 1, period: 1, subject: '국어', teacher: '김민수' },
      { ...base, row: 2, weekday: 1, period: 2, subject: '국어', teacher: '김민서' },
    ])
    assert.deepEqual(r.courses.map((c) => c.teacherNames[0]).sort(), ['김민서', '김민수'])
  })

  test('같은 masterName 교사 계정이 둘이면 둘 다 후보(동명이인) — 확인 없이는 연결하지 않음(이름만)', () => {
    const r = build(
      [{ ...base, row: 1, weekday: 1, period: 1, subject: '국어', teacher: '김민수' }],
      [
        { uid: 'uid-test-kim-1', masterName: '김민수', name: '김민수' },
        { uid: 'uid-test-kim-2', masterName: '김민수', name: '김민수' },
      ]
    )
    assert.deepEqual(r.courses[0].candidateTeacherUids, ['uid-test-kim-1', 'uid-test-kim-2'])
    assert.deepEqual(r.courses[0].teacherNames, ['김민수'])
    assert.equal(r.teacherLinks[0].reason, 'ambiguous')
    const p = plan(r, new FakeDb())
    assert.deepEqual(courseSet(p, r.courses[0].importKey)?.teacherUids, [])
  })

  test('masterName이 아닌 displayName·name은 후보 근거도 아님', () => {
    const r = build(
      [{ ...base, row: 1, weekday: 1, period: 1, subject: '국어', teacher: '김민수' }],
      [{ uid: 'uid-test-kim', masterName: null, name: '김민수' }]
    )
    assert.deepEqual(r.courses[0].candidateTeacherUids, [])
    assert.equal(r.teacherLinks[0].reason, 'no-account')
  })
})

// ───────────────────────── T32 ─────────────────────────

/** 가짜 DB의 수업·차시 → 엔진 입력 */
function engineData(db: FakeDb): { courses: Course[]; series: LessonSeries[] } {
  const courses: Course[] = Object.keys(db.courses).map((id) => {
    const d = db.courses[id] as any
    return {
      courseId: id,
      schoolCode: S,
      termId: TERM,
      title: d.title,
      subject: d.subject,
      section: d.section || undefined,
      teacherUids: d.teacherUids,
      teacherNames: d.teacherNames,
      status: d.status,
      endedOn: d.endedOn,
      commonForHomerooms: d.commonForHomerooms,
    }
  })
  const series: LessonSeries[] = Object.keys(db.series).map((id) => {
    const d = db.series[id] as any
    return {
      seriesId: id,
      courseId: d.courseId,
      weekday: d.weekday,
      period: d.period,
      start: d.start,
      end: d.end,
      roomName: d.roomName,
      teacherNames: d.teacherNames,
      validFrom: d.validFrom,
      validTo: d.validTo,
      status: d.status,
    }
  })
  return { courses, series }
}

function dayOf(db: FakeDb, date: Ymd, extra: Partial<StudentTimetableInput>): ReturnType<typeof buildDayTimetable> {
  const { courses, series } = engineData(db)
  return buildDayTimetable({
    uid: 'uid-test-student-a',
    day: { date },
    homerooms: [],
    enrollments: [],
    courses,
    series,
    overrides: [],
    personalEntries: [],
    ...extra,
  })
}

/** 담임이 /api/courses setCommon으로 확인한 것과 같은 효과(서버는 commonForHomerooms arrayUnion + revision 변경) */
function setCommonLikeHomeroom(db: FakeDb, courseId: string, homeroomId: string, revision: number) {
  const d = db.courses[courseId]
  const list = Array.isArray(d.commonForHomerooms) ? (d.commonForHomerooms as string[]) : []
  db.courses[courseId] = { ...d, commonForHomerooms: list.concat(list.indexOf(homeroomId) < 0 ? [homeroomId] : []), revision }
}

describe('T32 학생 자료 없음: 시간표만으로 개인 시간표를 만들지 않음(공통 수업은 담임 확인만)', () => {
  const r = build(THREE.rows)
  const kor34 = courseIdFor(S, TERM, K_KOR34)
  const engA = courseIdFor(S, TERM, K_ENGA)

  test('hr 수업도 commonForHomerooms는 비어 있고, 학급은 공통 수업 후보(importCommon)로만', () => {
    assert.deepEqual(byKey(r, K_KOR34).commonCandidates, ['S1_3_4'])
    for (const c of r.courses.filter((x) => x.keyKind === 'sec')) assert.deepEqual(c.commonCandidates, [], `분반 수업은 후보도 아님: ${c.importKey}`)
    for (const c of r.courses) assert.ok(!('commonForHomerooms' in c), '후보 단계에 commonForHomerooms 없음')
    const db = new FakeDb()
    const p = plan(r, db)
    for (const it of p.items) {
      const set = courseSet(p, it.importKey) as Record<string, unknown>
      assert.deepEqual(set.commonForHomerooms, [], `${it.importKey}: 새 수업의 commonForHomerooms는 []`)
    }
    assert.deepEqual(courseSet(p, K_KOR34)?.importCommon, ['S1_3_4'])
    assert.deepEqual(courseSet(p, K_ENGA)?.importCommon, [])
    db.apply(p)
    assert.deepEqual(db.courses[kor34].commonForHomerooms, [])
    assert.deepEqual(db.courses[kor34].importCommon, ['S1_3_4'])
    assert.equal(db.courses[engA].catalogVisible, false, '학생 공개 목록에 자동 노출하지 않음')
  })

  test('3-4 학생(수강 자료 없음): 발행만으로는 아무 수업도 없음 → 담임이 공통 수업으로 확인하면 3-4 국어만', () => {
    const db = new FakeDb()
    db.apply(plan(r, db))
    const before = dayOf(db, '20260908', { homerooms: [{ homeroomId: 'S1_3_4' }] }) // 화
    assert.deepEqual(before.lessons, [], '공통 수업 후보는 학생에게 연결되지 않음')
    assert.equal(before.state, 'no-courses')
    setCommonLikeHomeroom(db, kor34, 'S1_3_4', 2)
    const after = dayOf(db, '20260908', { homerooms: [{ homeroomId: 'S1_3_4' }] })
    assert.deepEqual(after.lessons.map((l) => l.title), ['국어'])
    assert.ok(!after.lessons.some((l) => l.title.startsWith('영어')), '분반 수업(영어 A)은 공통 수업으로 연결되지 않음')
    const other = dayOf(db, '20260908', { homerooms: [{ homeroomId: 'S1_3_5' }] })
    assert.deepEqual(other.lessons, [], '다른 학급(3-5)은 그대로')
  })

  test('영어 A 수강(초대·명단 등으로 연결)한 뒤에만 영어 A가 보임', () => {
    const db = new FakeDb()
    db.apply(plan(r, db))
    setCommonLikeHomeroom(db, kor34, 'S1_3_4', 2)
    const tue = dayOf(db, '20260908', {
      homerooms: [{ homeroomId: 'S1_3_4' }],
      enrollments: [{ courseId: engA, uid: 'uid-test-student-a', status: 'active', source: 'roster' }],
    })
    assert.deepEqual(tue.lessons.map((l) => l.title), ['국어', '영어 A'])
    assert.equal(tue.lessons[1].roomName, '어학실')
  })

  test('소속도 수강도 없는 학생에게는 아무 수업도 만들지 않음', () => {
    const db = new FakeDb()
    db.apply(plan(r, db))
    const tue = dayOf(db, '20260908', {})
    assert.equal(tue.lessons.length, 0)
    assert.equal(tue.state, 'no-courses')
  })

  test('담임이 확인한 공통 수업은 재업로드·수정본이 덮어쓰지 않음(가져오기는 commonForHomerooms를 쓰지 않음)', () => {
    const db = new FakeDb()
    db.apply(plan(r, db, { batchId: 'b1', revision: 1 }))
    setCommonLikeHomeroom(db, kor34, 'S1_3_4', 2)
    const same = plan(build(shuffled(THREE.rows, 11)), db, { batchId: 'b2', revision: 3 })
    assert.equal(same.items.find((i) => i.importKey === K_KOR34)?.status, 'same', '후보가 같으면 변경 없음')
    // 3-4 국어 교사 표기만 바뀐 수정본(같은 수업 키) → 수업 문서를 갱신해도 commonForHomerooms는 쓰지 않음
    const renamed = THREE.rows.map((x) => (nameKey(x.subject) === '국어' && /3학년 4반|^304$|^3-4$/.test(String(x.classLabel)) ? { ...x, room: '3-4 교실' } : x))
    const p = plan(build(renamed), db, { batchId: 'b3', revision: 4, validFrom: X2 })
    assert.equal(p.items.find((i) => i.importKey === K_KOR34)?.status, 'update', '3-4 국어 수업 문서를 실제로 갱신하는 경우')
    for (const it of p.items) {
      for (const op of it.ops.filter((o) => o.target === 'course' && o.kind === 'update')) {
        assert.ok(!('commonForHomerooms' in op.set), `${it.importKey}: update가 commonForHomerooms를 쓰지 않음`)
        assert.ok(!('commonForHomerooms' in (op.restore || {})), `${it.importKey}: 원복도 commonForHomerooms를 되돌리지 않음`)
      }
    }
    db.apply(p)
    assert.deepEqual(db.courses[kor34].commonForHomerooms, ['S1_3_4'], '담임 확인 유지')
  })

  test("변경 감지(changes 'common')는 importCommon 차이로만", () => {
    const db = new FakeDb()
    db.apply(plan(r, db, { batchId: 'b1', revision: 1 }))
    // commonForHomerooms가 달라도(담임 확인) 후보가 같으면 'common' 변경 아님
    setCommonLikeHomeroom(db, kor34, 'S1_3_4', 2)
    assert.equal(plan(r, db, { batchId: 'b2', revision: 3 }).items.find((i) => i.importKey === K_KOR34)?.changes.indexOf('common'), -1)
    // 예전 문서처럼 importCommon이 없으면 후보를 기록하는 'common' 변경
    db.courses[kor34] = { ...db.courses[kor34], importCommon: null }
    const p = plan(r, db, { batchId: 'b3', revision: 3 })
    const it = p.items.find((i) => i.importKey === K_KOR34)
    assert.deepEqual(it?.changes, ['common'])
    assert.deepEqual(courseSet(p, K_KOR34)?.importCommon, ['S1_3_4'])
    assert.ok(!('commonForHomerooms' in (courseSet(p, K_KOR34) || {})))
  })

  test('원복 일관성: 담임이 확인한(이후 수정된) 수업은 원복 대상 값과 달라 건너뜀, 확인 전 수업은 원복', () => {
    const db = new FakeDb()
    const p = plan(r, db, { batchId: 'b1', revision: 1 })
    db.apply(p)
    const kOp = p.items.find((i) => i.importKey === K_KOR34)?.ops.find((o) => o.target === 'course')
    const mOp = p.items.find((i) => i.importKey === K_MUSIC)?.ops.find((o) => o.target === 'course')
    assert.ok(kOp && mOp)
    setCommonLikeHomeroom(db, kor34, 'S1_3_4', 2)
    assert.equal(docMatches(db.courses[kor34], (kOp as any).set), false, '담임 확인 뒤에는 이 배치가 쓴 값과 다름 → 원복 건너뜀')
    assert.equal(docMatches(db.courses[kor34], undoSetOf(kOp as any, X1)), false)
    assert.equal(docMatches(db.courses[(mOp as any).id], (mOp as any).set), true, '확인 전 수업은 그대로 원복 가능')
  })
})

// ───────────────────────── 교사 계정 연결: 발행 교사 확인 ─────────────────────────

describe('교사 계정 연결은 발행 교사가 확인한 후보만(교사 이름·masterName만으로 권한 없음)', () => {
  const r = build(THREE.rows)

  test('확인 목록 없이 발행하면 모든 수업 teacherUids·importLinkedUids가 비어 있음(이름만)', () => {
    const p = plan(r, new FakeDb())
    for (const it of p.items) {
      const set = courseSet(p, it.importKey) as Record<string, unknown>
      assert.deepEqual(set.teacherUids, [], it.importKey)
      assert.deepEqual(set.importLinkedUids, [], it.importKey)
      assert.ok((set.teacherNames as string[]).length > 0, '교사 이름은 표시')
      assert.ok(!('managerUids' in set), '발행 교사를 넘기지 않으면 managerUids 없음')
    }
  })

  test('확인 목록의 후보만 연결 — 그 교사가 후보인 수업에만', () => {
    const p = plan(r, new FakeDb(), { confirm: [LEE] })
    assert.deepEqual(courseSet(p, K_ENGA)?.teacherUids, [LEE])
    assert.deepEqual(courseSet(p, K_ENGA)?.importLinkedUids, [LEE])
    for (const k of [K_KOR34, K_KOR35, K_MUSIC, K_ENGB]) assert.deepEqual(courseSet(p, k)?.teacherUids, [], `${k}: 이영희가 후보가 아닌 수업`)
    const p2 = plan(r, new FakeDb(), { confirm: [KIM, CHOI] })
    assert.deepEqual(courseSet(p2, K_KOR34)?.teacherUids, [KIM])
    assert.deepEqual(courseSet(p2, K_KOR35)?.teacherUids, [KIM])
    assert.deepEqual(courseSet(p2, K_MUSIC)?.teacherUids, [CHOI])
    assert.deepEqual(courseSet(p2, K_ENGA)?.teacherUids, [])
  })

  test('후보가 아닌 uid를 보내도 무시(다른 학교 교사·학생·임의 값)', () => {
    const confirm = ['uid-other-school-kim', 'uid-test-student-a', 'x', LEE, LEE]
    assert.deepEqual(splitConfirmations(r.courses, confirm), { accepted: [LEE], ignored: ['uid-other-school-kim', 'uid-test-student-a', 'x'] })
    // planImport에 직접 넣어도 후보가 아니면 연결되지 않음
    const p = plan(r, new FakeDb(), { confirm })
    const all = p.items.flatMap((i) => ((courseSet(p, i.importKey)?.teacherUids as string[]) || []))
    assert.deepEqual(all, [LEE])
  })

  test('다른 교사 이름을 masterName으로 정한 교사: 후보로는 보이지만 확인 없이는 권한 없음, 확인해도 실제 교사만 체크하면 그 교사만', () => {
    const evil = { uid: 'uid-test-teacher-evil', masterName: '최 유나', name: '최유나' }
    const re = build(THREE.rows, THREE.teachers.concat([evil]))
    const music = byKey(re, K_MUSIC)
    assert.deepEqual(music.candidateTeacherUids, [CHOI, evil.uid].sort())
    assert.equal(re.teacherLinks.find((l) => l.name === '최유나')?.reason, 'ambiguous')
    assert.deepEqual(courseSet(plan(re, new FakeDb()), K_MUSIC)?.teacherUids, [], '확인 없이 → 아무도 연결 안 됨')
    assert.deepEqual(courseSet(plan(re, new FakeDb(), { confirm: [CHOI] }), K_MUSIC)?.teacherUids, [CHOI])
    // 계정이 없는 교사(정하늘) 이름을 차지한 경우: 유일한 후보라도 확인 없이는 연결 안 됨
    const evil2 = { uid: 'uid-test-teacher-evil', masterName: '정하늘' }
    const re2 = build(THREE.rows, THREE.teachers.concat([evil2]))
    assert.deepEqual(byKey(re2, K_ENGB).candidateTeacherUids, [evil2.uid])
    assert.deepEqual(courseSet(plan(re2, new FakeDb()), K_ENGB)?.teacherUids, [])
  })

  test('새 수업만 managerUids에 발행 교사(기존 수업의 managerUids는 건드리지 않음)', () => {
    const db = new FakeDb()
    const p = plan(r, db, { publisher: 'uid-publisher' })
    for (const it of p.items) assert.deepEqual(courseSet(p, it.importKey)?.managerUids, ['uid-publisher'], it.importKey)
    db.apply(p)
    db.courses[courseIdFor(S, TERM, K_MUSIC)].managerUids = ['uid-publisher', 'uid-other-manager']
    const p2 = plan(build(revisedRows()), db, { batchId: 'b2', revision: 2, validFrom: X2, publisher: 'uid-second' })
    for (const it of p2.items) {
      for (const op of it.ops.filter((o) => o.target === 'course')) assert.ok(!('managerUids' in op.set), `${it.importKey}: 기존 수업 managerUids 유지`)
    }
    db.apply(p2)
    assert.deepEqual(db.courses[courseIdFor(S, TERM, K_MUSIC)].managerUids, ['uid-publisher', 'uid-other-manager'])
  })

  test('이전에 확인된 연결은 재업로드에서 유지(후보로 남아 있을 때만), 사람이 넣은 uid도 유지', () => {
    const db = new FakeDb()
    db.apply(plan(r, db, { batchId: 'b1', revision: 1, confirm: [KIM] }))
    const kor34 = courseIdFor(S, TERM, K_KOR34)
    assert.deepEqual(db.courses[kor34].teacherUids, [KIM])
    // 사람이 직접 넣은 담당 교사(importLinkedUids에 없음)
    db.courses[kor34] = { ...db.courses[kor34], teacherUids: [KIM, 'uid-manual'] }
    const again = plan(build(shuffled(THREE.rows, 3)), db, { batchId: 'b2', revision: 2 })
    assert.equal(again.items.find((i) => i.importKey === K_KOR34)?.status, 'same', '확인 목록 없이 다시 올려도 연결 유지')
    // 그 교사가 masterName을 바꿔 더 이상 후보가 아니면 가져오기 연결만 빠지고 사람이 넣은 uid는 남음
    const noKim = build(THREE.rows, THREE.teachers.filter((t) => t.uid !== KIM))
    const p = plan(noKim, db, { batchId: 'b3', revision: 3 })
    assert.deepEqual(courseSet(p, K_KOR34)?.teacherUids, ['uid-manual'])
    assert.deepEqual(courseSet(p, K_KOR34)?.importLinkedUids, [])
    // 사람이 담당에서 뺀 교사는 다시 넣지 않음(확인 목록에 있으면 새로 연결)
    db.courses[kor34] = { ...db.courses[kor34], teacherUids: ['uid-manual'] }
    assert.deepEqual(courseSet(plan(r, db, { batchId: 'b4', revision: 3 }), K_KOR34)?.teacherUids, ['uid-manual'])
    assert.deepEqual(courseSet(plan(r, db, { batchId: 'b4', revision: 3, confirm: [KIM] }), K_KOR34)?.teacherUids, ['uid-manual', KIM])
  })

  test('미리보기 비교 해시는 확인 목록과 무관(확인 없이 만든 계획) — 같은 미리보기면 같은 값', () => {
    const db = new FakeDb()
    const d1 = planDigest(plan(r, db), [])
    const d2 = planDigest(plan(build(shuffled(THREE.rows, 9)), db, { confirm: [], publisher: null }), [])
    assert.equal(d1, d2)
    assert.notEqual(planDigest(plan(r, db, { confirm: [KIM] }), []), d1, '확인 목록을 넣은 계획은 다름 → 서버는 해시를 확인 없는 계획으로 계산')
  })

  test('확인으로 연결한 배치 원복 → 연결 전 담당 교사로', () => {
    const db = new FakeDb()
    db.apply(plan(r, db, { batchId: 'b1', revision: 1 }))
    const p = plan(r, db, { batchId: 'b2', revision: 2, confirm: [LEE] })
    assert.equal(p.items.find((i) => i.importKey === K_ENGA)?.status, 'update')
    assert.deepEqual(p.items.find((i) => i.importKey === K_ENGA)?.changes, ['teachers'])
    db.apply(p)
    const engA = courseIdFor(S, TERM, K_ENGA)
    assert.deepEqual(db.courses[engA].teacherUids, [LEE])
    db.undo(p, X1)
    assert.deepEqual(db.courses[engA].teacherUids, [])
    assert.deepEqual(db.courses[engA].importLinkedUids, [])
  })

  test("이메일 일부 가림 'ab***@도메인'", () => {
    assert.equal(maskEmail('abcdef@school.kr'), 'ab***@school.kr')
    assert.equal(maskEmail('ab@x.kr'), 'a***@x.kr')
    assert.equal(maskEmail('김민수@학교.kr'), '김민***@학교.kr')
    assert.equal(maskEmail('no-at-sign'), null)
    assert.equal(maskEmail('@x.kr'), null)
    assert.equal(maskEmail(null), null)
  })
})

// ───────────────────────── 검토에서 확인된 결함 회귀 ─────────────────────────

describe('행 단위 검토 이슈는 그 행으로 만든 수업에 연결 — 제외 동의 시 그 수업은 발행에서 빠짐', () => {
  const row = (o: Partial<RawImportRow>): RawImportRow => ({ sourceKind: 'table', sheet: '전체', row: 2, col: null, weekday: 1, period: 1, subject: '', ...o })

  test("분반 칸('B')과 과목 접두어('A_영어')가 다른 행 → 그 수업 blocked 'review', 발행 계획에서 제외", () => {
    const r = build([row({ row: 2, subject: 'A_영어', section: 'B', teacher: '김민수' }), row({ row: 3, weekday: 2, subject: '국어', teacher: '이영희', classLabel: '3-4' })])
    const mm = r.issues.find((i) => i.code === 'section-mismatch')
    assert.ok(mm, 'section-mismatch 검토 이슈')
    assert.deepEqual(mm?.importKeys, ['sec|영어|B|김민수'], '이슈가 그 행으로 만든 수업을 가리킴')
    const c = byKey(r, 'sec|영어|B|김민수')
    assert.equal(c.blocked, 'review')
    assert.ok(c.issueCodes.includes('section-mismatch'))
    assert.equal(byKey(r, 'hr|3-4|국어|이영희').blocked, null, '다른 수업은 그대로')
    const p = plan(r, new FakeDb())
    assert.ok(!p.items.some((i) => i.importKey === 'sec|영어|B|김민수'), '검토 수업은 발행 계획에 없음(acceptReview = 제외하고 발행)')
    assert.ok(p.items.some((i) => i.importKey === 'hr|3-4|국어|이영희'))
  })

  test("알 수 없는 학급 표기 행이 다른 자료의 같은 차시와 합쳐진 'hr' 수업 → blocked 'review'", () => {
    const cls: RawImportRow = { sourceKind: 'class', sheet: '학급시간표#3학년 4반', row: 3, col: 2, weekday: 1, period: 1, subject: '국어', teacher: '김민수', classLabel: '3-4' }
    const tch: RawImportRow = { sourceKind: 'teacher', sheet: '교사시간표#김민수', row: 3, col: 2, weekday: 1, period: 1, subject: '국어', teacher: '김민수', classLabel: '3반4' }
    const good = build([cls, { ...tch, classLabel: '304' }])
    assert.equal(byKey(good, K_KOR34).blocked, null, '(대조) 학급 표기가 맞으면 검토 없음')
    const r = build([cls, tch])
    const bad = r.issues.find((i) => i.code === 'bad-class-label')
    assert.deepEqual(bad?.importKeys, [K_KOR34])
    assert.equal(byKey(r, K_KOR34).blocked, 'review')
    assert.equal(r.stats.review, 1)
    assert.equal(plan(r, new FakeDb()).items.length, 0, '발행할 수업 없음')
  })
})

describe('미리보기 비교 해시: 학교 버전(수강 변경)만 오르면 같고, 수업·차시·교사 후보가 바뀌면 다름', () => {
  test('revision 값만 다른 계획(새 수업·갱신·replace 종료)은 같은 해시', () => {
    const db = new FakeDb()
    const r = build(THREE.rows)
    assert.equal(planDigest(plan(r, db, { revision: 1 }), []), planDigest(plan(r, db, { revision: 8 }), []), '새 수업')
    db.apply(plan(r, db, { batchId: 'b1', revision: 1 }))
    const rv = build(revisedRows())
    assert.equal(planDigest(plan(rv, db, { validFrom: X2, revision: 2 }), []), planDigest(plan(rv, db, { validFrom: X2, revision: 9 }), []), '갱신')
    const noMusic = build(THREE.rows.filter((x) => nameKey(x.subject) !== '음악'))
    const p2 = plan(noMusic, db, { validFrom: X2, mode: 'replace', revision: 2 })
    assert.ok(p2.items.some((i) => i.status === 'retire'))
    assert.equal(planDigest(p2, []), planDigest(plan(noMusic, db, { validFrom: X2, mode: 'replace', revision: 9 }), []), 'replace 종료')
  })

  test('수업 문서를 다른 곳에서 고치면(계획의 restore가 달라짐) 해시가 다름', () => {
    const db = new FakeDb()
    const r = build(THREE.rows)
    db.apply(plan(r, db, { batchId: 'b1', revision: 1 }))
    const rv = build(revisedRows())
    const before = planDigest(plan(rv, db, { validFrom: X2, revision: 2 }), [])
    const music = courseIdFor(S, TERM, K_MUSIC)
    db.courses[music] = { ...db.courses[music], title: '음악(담당 수정)', revision: 5 }
    assert.notEqual(planDigest(plan(rv, db, { validFrom: X2, revision: 2 }), []), before)
  })

  test('교사 후보 매핑을 넣으면: 같은 후보면 같고, 미리보기 뒤 masterName이 바뀌면 다름', () => {
    const db = new FakeDb()
    const r = build(THREE.rows)
    const d = planDigest(plan(r, db), [], r.teacherLinks)
    assert.equal(planDigest(plan(build(shuffled(THREE.rows, 5)), db), [], build(shuffled(THREE.rows, 5)).teacherLinks), d)
    const moved = THREE.teachers.map((t) => (t.uid === CHOI ? { ...t, masterName: '이영희' } : t))
    const r2 = build(THREE.rows, moved)
    assert.equal(planDigest(plan(r2, db), []), planDigest(plan(r, db), []), '수업·차시 계획 자체는 같음(확인 없이)')
    assert.notEqual(planDigest(plan(r2, db), [], r2.teacherLinks), d, '후보 매핑이 달라 다시 미리보기')
  })
})

describe('교사 연결 확인은 (엑셀 이름, 계정) 쌍 — 미리보기 뒤 masterName을 바꿔도 다른 이름의 수업에 연결되지 않음', () => {
  const rows: RawImportRow[] = [
    { sourceKind: 'class', sheet: '학급시간표#3학년 4반', row: 3, col: 2, weekday: 1, period: 1, subject: '국어', teacher: '김철수', classLabel: '3-4' },
    { sourceKind: 'class', sheet: '학급시간표#3학년 4반', row: 4, col: 2, weekday: 1, period: 2, subject: '수학', teacher: '박영희', classLabel: '3-4' },
  ]
  const T1 = 'uid-test-t1'
  const T2 = 'uid-test-t2'
  const before: TeacherAccount[] = [
    { uid: T1, masterName: '김철수' },
    { uid: T2, masterName: '박영희' },
  ]
  // 미리보기 뒤 T1이 자기 masterName을 '박영희'로 바꿈(규칙상 허용)
  const after: TeacherAccount[] = [
    { uid: T1, masterName: '박영희' },
    { uid: T2, masterName: '박영희' },
  ]
  const C1 = 'hr|3-4|국어|김철수'
  const C2 = 'hr|3-4|수학|박영희'
  const keysOf = (r: BuildResult) => r.courses.filter((c) => !c.blocked).map((c) => c.importKey)

  test('teacherLinks에 이름키(key), 수업마다 이름별 후보(candidateTeacherLinks)', () => {
    const r = build(rows, before)
    assert.deepEqual(
      r.teacherLinks.map((l) => [l.key, l.candidates.map((c) => c.uid)]),
      [
        ['김철수', [T1]],
        ['박영희', [T2]],
      ]
    )
    assert.deepEqual(byKey(r, C1).candidateTeacherLinks, [{ nameKey: '김철수', uids: [T1] }])
    assert.deepEqual(byKey(r, C2).candidateTeacherLinks, [{ nameKey: '박영희', uids: [T2] }])
  })

  test('쌍 확인은 그 이름이 나오는 수업에만 연결', () => {
    const r = build(rows, before)
    const res = resolveTeacherConfirmations(r.teacherLinks, keysOf(r), [{ nameKey: '김철수', uid: T1 }])
    assert.deepEqual(res, { accepted: [{ nameKey: '김철수', uid: T1 }], acceptedUids: [T1], ignored: 0 })
    const p = plan(r, new FakeDb(), { links: res.accepted })
    assert.deepEqual(courseSet(p, C1)?.teacherUids, [T1])
    assert.deepEqual(courseSet(p, C2)?.teacherUids, [])
    // 다른 이름으로 보낸 쌍(박영희 = T1)은 후보가 아니라 무시
    const wrong = resolveTeacherConfirmations(r.teacherLinks, keysOf(r), [{ nameKey: '박영희', uid: T1 }])
    assert.deepEqual(wrong, { accepted: [], acceptedUids: [], ignored: 1 })
  })

  test("미리보기 뒤 masterName 변경: 해시가 달라지고, '김철수 = T1' 확인은 박영희 수업에 연결되지 않음", () => {
    const pre = build(rows, before)
    const post = build(rows, after)
    const db = new FakeDb()
    assert.notEqual(planDigest(plan(post, db), [], post.teacherLinks), planDigest(plan(pre, db), [], pre.teacherLinks), '다시 미리보기 필요(409)')
    const res = resolveTeacherConfirmations(post.teacherLinks, keysOf(post), [{ nameKey: '김철수', uid: T1 }])
    assert.deepEqual(res.accepted, [])
    assert.equal(res.ignored, 1)
    // 서버가 거르지 않은 쌍을 그대로 넘겨도 planImport가 수업별 이름 후보로 다시 확인
    const p = plan(post, db, { links: [{ nameKey: '김철수', uid: T1 }] })
    assert.deepEqual(courseSet(p, C2)?.teacherUids, [], 'T1이 박영희 수업 담당이 되지 않음')
    assert.deepEqual(courseSet(p, C1)?.teacherUids, [])
  })

  test('이전 형식(uid만)은 발행할 수업의 이름 정확히 하나의 후보일 때만 그 이름으로 해석, 이름키는 공백·전각 차이를 흡수', () => {
    const r = build(rows, before)
    const legacy = resolveTeacherConfirmations(r.teacherLinks, keysOf(r), [], [T2, 'uid-not-candidate'])
    assert.deepEqual(legacy, { accepted: [{ nameKey: '박영희', uid: T2 }], acceptedUids: [T2], ignored: 1 })
    // 그 이름의 수업이 모두 발행에서 빠지면(검토 제외) 받지 않음
    assert.deepEqual(resolveTeacherConfirmations(r.teacherLinks, [C1], [], [T2]).accepted, [])
    assert.deepEqual(resolveTeacherConfirmations(r.teacherLinks, [C1], [{ nameKey: '박영희', uid: T2 }], []).ignored, 1)
    const spaced = resolveTeacherConfirmations(r.teacherLinks, keysOf(r), [{ nameKey: '김 철수', uid: T1 }])
    assert.deepEqual(spaced.accepted, [{ nameKey: '김철수', uid: T1 }])
  })
})
