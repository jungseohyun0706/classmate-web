/**
 * 시간표 가져오기 → 학생 '수업 담기' 목록 공개·대상 학년 (순수 함수 planImport, 가상 데이터)
 *  - 대상 학년(grades): 수업 칸들의 학급 표시('3-4')에서 뽑음(중복 없이 오름차순). 학급 표시가 없는 수업은 grades 필드 없음
 *    · 교사가 수업 화면에서 정한 대상 학년(gradesBy 'teacher')은 다시 가져와도 덮어쓰거나 지우지 않음
 *  - 공개 선택(catalog)이 있으면 새 수업 + 가져오기가 공개 설정을 맡은 기존 가져오기 수업에만 catalogVisible·invitePolicy를 씀
 *    · 교사가 수업 화면에서 바꾼 수업(catalogBy 'teacher')·예전 수업 그룹(legacyGroupId)이 연결된 수업은 그대로
 *    · 표시가 없는 예전 가져오기 수업은 기본값(비공개·승인 후) 그대로일 때만 — 공개 여부만 따르고 참여 방식은 '승인 후'
 *      (catalogBy 'import-legacy' — 다음 가져오기도 바로 담기로 올리지 않음). 공개·바로 참여로 바뀌어 있으면 교사가 바꾼 것으로 봄
 *  - 공개 선택이 없으면(이전 호출) 새 수업은 예전처럼 비공개·승인 후, 기존 수업은 그대로
 *  - 원복은 이전 값으로
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCandidates,
  courseIdFor,
  existingFromDocs,
  gradesFromClassLabels,
  importCatalogFor,
  importManagesCatalog,
  planImport,
  undoSetOf,
  type BuildResult,
  type CatalogPublishOption,
  type ImportPlan,
  type RawImportRow,
} from '../../src/lib/timetable/importMatch'

const S = 'S1'
const TERM = '2026-2'
const X1 = '20260907'
const X2 = '20261005'

const row = (r: number, weekday: number, period: number, subject: string, teacher: string, classLabel: string | null, extra: Partial<RawImportRow> = {}): RawImportRow => ({
  sourceKind: 'class',
  sheet: '시간표',
  row: r,
  col: 1,
  weekday,
  period,
  subject,
  teacher,
  ...(classLabel ? { classLabel } : {}),
  ...extra,
})

// 3-4 국어(한 학급) · 영어 A(3-4·3-5 이동수업, 분반) · 1-2 수학 · 동아리 A(분반, 학급 표시 없음 — 교사 시간표에서)
const ROWS: RawImportRow[] = [
  row(1, 1, 1, '국어', '김민수', '3-4'),
  row(2, 2, 3, 'A_영어', '이영희', '3-4'),
  row(3, 2, 3, 'A_영어', '이영희', '3-5'),
  row(4, 3, 2, '수학', '오수학', '1-2'),
  row(5, 5, 7, 'A_동아리', '박동아', null, { sourceKind: 'teacher' }),
]
const K_KOR = 'hr|3-4|국어|김민수'
const K_ENG = 'sec|영어|A|이영희'
const K_MATH = 'hr|1-2|수학|오수학'

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
  undo(plan: ImportPlan, validFrom: string) {
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
}

const build = (rows: RawImportRow[] = ROWS): BuildResult => buildCandidates(rows, { schoolCode: S, teachers: [] })
const plan = (r: BuildResult, db: FakeDb, opts: { catalog?: CatalogPublishOption | null; validFrom?: string; batchId?: string } = {}): ImportPlan =>
  planImport({
    schoolCode: S,
    termId: TERM,
    validFrom: opts.validFrom || X1,
    mode: 'merge',
    batchId: opts.batchId || 'b1',
    revision: 1,
    courses: r.courses.filter((c) => !c.blocked),
    keepKeys: r.courses.filter((c) => c.blocked).map((c) => c.importKey),
    existing: db.existing(),
    publisherUid: 'pub',
    catalog: opts.catalog,
  })
const cid = (key: string) => courseIdFor(S, TERM, key)
/** 학급 표시가 없는 분반 수업(동아리 A) — 분반이 있어 발행 대상(학급 미상 'none' 수업은 검토로 발행에서 빠짐) */
const noClassKey = (r: BuildResult) => {
  const c = r.courses.find((x) => x.importKey.startsWith('sec|동아리|'))
  assert.ok(c && !c.blocked && c.classLabels.length === 0, r.courses.map((x) => `${x.importKey}:${x.blocked}`).join(', '))
  return c!.importKey
}

describe('대상 학년 뽑기(gradesFromClassLabels)', () => {
  test('학급 표시 → 학년(중복 없이 오름차순), 알 수 없는 표시는 건너뜀', () => {
    assert.deepEqual(gradesFromClassLabels(['3-5', '3-4', '1-2', '3학년 4반', '304']), [1, 3])
    assert.deepEqual(gradesFromClassLabels(['2-1', null, undefined, '', '반', '9-1']), [2])
    assert.deepEqual(gradesFromClassLabels([]), [])
  })
})

describe('가져오기 수업의 대상 학년(grades)', () => {
  const r = build()
  test('후보: 학급 표시가 이 수업 칸들에서 나옴', () => {
    assert.deepEqual(r.courses.find((c) => c.importKey === K_ENG)?.classLabels, ['3-4', '3-5'])
  })
  test('새 수업: 학급 표시에서 grades, 학급 표시가 없는 수업은 grades 필드 없음', () => {
    const db = new FakeDb()
    db.apply(plan(r, db))
    assert.deepEqual(db.courses[cid(K_KOR)].grades, [3])
    assert.deepEqual(db.courses[cid(K_ENG)].grades, [3])
    assert.deepEqual(db.courses[cid(K_MATH)].grades, [1])
    assert.ok(!('grades' in db.courses[cid(noClassKey(r))]), '학급 표시 없음 → grades 없음')
  })
  test('같은 파일 다시 올리기 → 모두 같음(grades 때문에 갱신되지 않음)', () => {
    const db = new FakeDb()
    db.apply(plan(r, db))
    const again = plan(r, db, { batchId: 'b2' })
    assert.deepEqual(Array.from(new Set(again.items.map((i) => i.status))), ['same'])
  })
  test('새 수업의 학급 표시 학년은 gradesBy import(교사가 정한 값과 구분)', () => {
    const db = new FakeDb()
    db.apply(plan(r, db))
    assert.equal(db.courses[cid(K_KOR)].gradesBy, 'import')
    assert.ok(!('gradesBy' in db.courses[cid(noClassKey(r))]), '학년이 없으면 표시도 없음')
  })
  test('교사가 수업 화면에서 정한 대상 학년(gradesBy teacher)은 다시 가져와도 그대로 — 학급 표시가 있어도·없어도', () => {
    const db = new FakeDb()
    db.apply(plan(r, db))
    const club = cid(noClassKey(r))
    db.courses[cid(K_KOR)] = { ...db.courses[cid(K_KOR)], grades: [2, 3], gradesBy: 'teacher' }
    db.courses[club] = { ...db.courses[club], grades: [1], gradesBy: 'teacher' }
    db.courses[cid(K_ENG)] = { ...db.courses[cid(K_ENG)], grades: [], gradesBy: 'teacher' } // 교사가 '학년 미상'으로 비움
    const p = plan(r, db, { validFrom: X2, batchId: 'b2' })
    for (const k of [K_KOR, K_ENG, noClassKey(r)]) assert.equal(p.items.find((i) => i.importKey === k)?.status, 'same', k)
    // 다른 변경이 있어 수업을 갱신해도 대상 학년은 쓰지 않음
    const moreKor = build(ROWS.concat([row(9, 4, 4, '국어', '김민수', '3-4')]))
    const p2 = plan(moreKor, db, { validFrom: X2, batchId: 'b3' })
    const kor = p2.items.find((i) => i.importKey === K_KOR)
    assert.equal(kor?.status, 'update')
    assert.ok(!kor?.changes.includes('grades'), JSON.stringify(kor?.changes))
    const set = kor?.ops.find((o) => o.target === 'course')?.set || {}
    assert.ok(!('grades' in set) && !('gradesBy' in set), JSON.stringify(set))
    db.apply(p2)
    assert.deepEqual(db.courses[cid(K_KOR)].grades, [2, 3])
    assert.deepEqual(db.courses[cid(K_ENG)].grades, [])
    assert.deepEqual(db.courses[club].grades, [1])
  })
  test('예전 가져오기 수업(grades 없음)은 다시 올리면 grades를 채움(변경 grades), 원복하면 다시 없음(null)', () => {
    const db = new FakeDb()
    db.apply(plan(r, db))
    delete db.courses[cid(K_KOR)].grades
    const p = plan(r, db, { validFrom: X2, batchId: 'b2' })
    const it = p.items.find((i) => i.importKey === K_KOR)
    assert.equal(it?.status, 'update')
    assert.deepEqual(it?.changes, ['grades'])
    db.apply(p)
    assert.deepEqual(db.courses[cid(K_KOR)].grades, [3])
    assert.equal(db.courses[cid(K_KOR)].gradesBy, 'import')
    db.undo(p, X2)
    assert.equal(db.courses[cid(K_KOR)].grades, null)
  })
})

describe('학생 수업 담기 공개(catalog) — 새 수업', () => {
  const r = build()
  test('공개 선택 없음(이전 호출) → 예전처럼 비공개·승인 후', () => {
    const db = new FakeDb()
    db.apply(plan(r, db))
    for (const id of Object.keys(db.courses)) {
      assert.equal(db.courses[id].catalogVisible, false)
      assert.equal(db.courses[id].invitePolicy, 'approval')
      assert.equal(db.courses[id].catalogBy, 'import')
    }
  })
  test('공개 + 바로 담기 → 새 수업 모두 catalogVisible true·invitePolicy auto', () => {
    const db = new FakeDb()
    db.apply(plan(r, db, { catalog: { visible: true, policy: 'auto' } }))
    for (const id of Object.keys(db.courses)) {
      assert.equal(db.courses[id].catalogVisible, true, id)
      assert.equal(db.courses[id].invitePolicy, 'auto', id)
      assert.deepEqual(db.courses[id].commonForHomerooms, [], '공통 수업은 여전히 담임 확인만')
    }
  })
  test('공개 + 선생님 승인 후 → approval', () => {
    const db = new FakeDb()
    db.apply(plan(r, db, { catalog: { visible: true, policy: 'approval' } }))
    assert.equal(db.courses[cid(K_ENG)].invitePolicy, 'approval')
    assert.equal(db.courses[cid(K_ENG)].catalogVisible, true)
  })
  test('잘못된 공개 선택 값은 무시(예전 동작)', () => {
    const db = new FakeDb()
    db.apply(plan(r, db, { catalog: { visible: 'yes', policy: 'x' } as unknown as CatalogPublishOption }))
    assert.equal(db.courses[cid(K_ENG)].catalogVisible, false)
  })
})

describe('학생 수업 담기 공개(catalog) — 기존 수업은 가져오기가 맡은 수업만', () => {
  const r = build()
  const seed = () => {
    const db = new FakeDb()
    db.apply(plan(r, db)) // 비공개·승인 후, catalogBy 'import'
    return db
  }

  test('가져오기가 정한 값(catalogBy import) → 새 선택으로 바뀜(변경 catalog), 원복하면 이전 값', () => {
    const db = seed()
    const p = plan(r, db, { catalog: { visible: true, policy: 'auto' }, validFrom: X2, batchId: 'b2' })
    const it = p.items.find((i) => i.importKey === K_ENG)
    assert.equal(it?.status, 'update')
    assert.deepEqual(it?.changes, ['catalog'])
    db.apply(p)
    assert.equal(db.courses[cid(K_ENG)].catalogVisible, true)
    assert.equal(db.courses[cid(K_ENG)].invitePolicy, 'auto')
    db.undo(p, X2)
    assert.equal(db.courses[cid(K_ENG)].catalogVisible, false)
    assert.equal(db.courses[cid(K_ENG)].invitePolicy, 'approval')
    assert.equal(db.courses[cid(K_ENG)].catalogBy, 'import')
  })

  test('같은 선택으로 다시 올리면 변경 없음', () => {
    const db = new FakeDb()
    db.apply(plan(r, db, { catalog: { visible: true, policy: 'auto' } }))
    const again = plan(r, db, { catalog: { visible: true, policy: 'auto' }, batchId: 'b2' })
    assert.deepEqual(Array.from(new Set(again.items.map((i) => i.status))), ['same'])
  })

  test('교사가 수업 화면에서 정한 수업(catalogBy teacher)은 그대로 — 공개를 끄든 켜든', () => {
    const db = seed()
    db.courses[cid(K_KOR)] = { ...db.courses[cid(K_KOR)], catalogVisible: false, invitePolicy: 'approval', catalogBy: 'teacher' }
    db.courses[cid(K_ENG)] = { ...db.courses[cid(K_ENG)], catalogVisible: true, invitePolicy: 'auto', catalogBy: 'teacher' }
    const on = plan(r, db, { catalog: { visible: true, policy: 'auto' }, validFrom: X2, batchId: 'b2' })
    assert.equal(on.items.find((i) => i.importKey === K_KOR)?.status, 'same')
    const off = plan(r, db, { catalog: { visible: false, policy: 'approval' }, validFrom: X2, batchId: 'b3' })
    assert.equal(off.items.find((i) => i.importKey === K_ENG)?.status, 'same')
    db.apply(on)
    db.apply(off)
    assert.equal(db.courses[cid(K_KOR)].catalogVisible, false)
    assert.equal(db.courses[cid(K_ENG)].catalogVisible, true)
  })

  test('표시 없는 예전 가져오기 수업: 기본값(비공개·승인 후)이면 맡음, 공개·바로 참여로 바뀌어 있으면 교사가 바꾼 것으로 보고 그대로', () => {
    const db = seed()
    for (const id of [cid(K_KOR), cid(K_ENG), cid(K_MATH)]) delete db.courses[id].catalogBy
    db.courses[cid(K_ENG)] = { ...db.courses[cid(K_ENG)], catalogVisible: true }
    db.courses[cid(K_MATH)] = { ...db.courses[cid(K_MATH)], invitePolicy: 'auto' }
    const p = plan(r, db, { catalog: { visible: true, policy: 'approval' }, validFrom: X2, batchId: 'b2' })
    db.apply(p)
    assert.equal(db.courses[cid(K_KOR)].catalogVisible, true, '기본값 그대로였던 수업은 공개')
    assert.equal(db.courses[cid(K_KOR)].catalogBy, 'import-legacy')
    assert.equal(p.items.find((i) => i.importKey === K_ENG)?.status, 'same', '교사가 공개했던 수업은 그대로')
    assert.equal(db.courses[cid(K_MATH)].invitePolicy, 'auto', '교사가 바로 참여로 바꿨던 수업은 그대로')
    assert.equal(db.courses[cid(K_MATH)].catalogVisible, false)
  })

  test("표시 없던 예전 가져오기 수업은 '바로 담기'로 발행해도 참여 방식은 '승인 후' — 다음 가져오기도 올리지 않고, 공개 끄기는 따름", () => {
    const db = seed()
    delete db.courses[cid(K_KOR)].catalogBy
    const p = plan(r, db, { catalog: { visible: true, policy: 'auto' }, validFrom: X2, batchId: 'b2' })
    db.apply(p)
    assert.equal(db.courses[cid(K_KOR)].catalogVisible, true)
    assert.equal(db.courses[cid(K_KOR)].invitePolicy, 'approval', '교사가 일부러 고른 승인 후일 수 있어 바로 담기로 올리지 않음')
    assert.equal(db.courses[cid(K_KOR)].catalogBy, 'import-legacy')
    assert.equal(db.courses[cid(K_ENG)].invitePolicy, 'auto', '가져오기가 만든(표시 있는) 수업은 고른 대로')
    const again = plan(r, db, { catalog: { visible: true, policy: 'auto' }, validFrom: X2, batchId: 'b3' })
    assert.equal(again.items.find((i) => i.importKey === K_KOR)?.status, 'same')
    const off = plan(r, db, { catalog: { visible: false, policy: 'auto' }, validFrom: X2, batchId: 'b4' })
    db.apply(off)
    assert.equal(db.courses[cid(K_KOR)].catalogVisible, false)
    db.undo(off, X2)
    db.undo(p, X2)
    assert.equal(db.courses[cid(K_KOR)].catalogVisible, false)
    assert.equal(db.courses[cid(K_KOR)].catalogBy, null, '원복하면 표시도 이전 값(없음)')
  })

  test('예전 수업 그룹(legacyGroupId — 톡방·공지)이 연결된 가져오기 수업은 공개 설정을 맡지 않음(담으면 그룹에도 들어가므로)', () => {
    const db = seed()
    db.courses[cid(K_ENG)] = { ...db.courses[cid(K_ENG)], legacyGroupId: 'grpEngA' }
    delete db.courses[cid(K_MATH)].catalogBy
    db.courses[cid(K_MATH)] = { ...db.courses[cid(K_MATH)], legacyGroupId: 'grpMath' }
    const p = plan(r, db, { catalog: { visible: true, policy: 'auto' }, validFrom: X2, batchId: 'b2' })
    assert.equal(p.items.find((i) => i.importKey === K_ENG)?.status, 'same')
    assert.equal(p.items.find((i) => i.importKey === K_MATH)?.status, 'same')
    db.apply(p)
    assert.equal(db.courses[cid(K_ENG)].catalogVisible, false)
    assert.equal(db.courses[cid(K_ENG)].invitePolicy, 'approval')
    assert.equal(db.courses[cid(K_KOR)].catalogVisible, true, '그룹이 없는 수업은 그대로 공개')
  })

  test('공개 선택 없음(이전 호출) → 기존 수업 공개·참여 방식은 건드리지 않음', () => {
    const db = new FakeDb()
    db.apply(plan(r, db, { catalog: { visible: true, policy: 'auto' } }))
    const p = plan(r, db, { batchId: 'b2' })
    assert.deepEqual(Array.from(new Set(p.items.map((i) => i.status))), ['same'])
  })

  test('importManagesCatalog: 가져오기 출처가 아닌 수업(직접 만든 수업·학급 공통 수업·이전 자료)은 맡지 않음', () => {
    const base = { catalogBy: null, catalogVisible: false, invitePolicy: 'approval' as const }
    assert.equal(importManagesCatalog({ ...base, source: 'import' }), true)
    for (const source of ['manual', 'homeroom-common', 'legacy-group', 'migration']) {
      assert.equal(importManagesCatalog({ ...base, source }), false, source)
    }
    assert.equal(importManagesCatalog({ ...base, source: 'import', catalogBy: 'teacher' }), false)
    assert.equal(importManagesCatalog({ source: 'import', catalogBy: 'import', catalogVisible: true, invitePolicy: 'auto' }), true)
    assert.equal(importManagesCatalog({ source: 'import', catalogBy: null, catalogVisible: true, invitePolicy: 'approval' }), false)
    assert.equal(importManagesCatalog({ source: 'import', catalogBy: null, catalogVisible: false, invitePolicy: null }), true)
    assert.equal(importManagesCatalog({ source: 'import', catalogBy: 'import-legacy', catalogVisible: true, invitePolicy: 'approval' }), true)
    assert.equal(importManagesCatalog({ source: 'import', catalogBy: 'import', catalogVisible: false, invitePolicy: 'approval', legacyGroupId: 'g1' }), false)
  })

  test('importCatalogFor: 가져오기가 만든 수업은 고른 대로, 표시 없는·예전 수업은 승인 후 고정, 맡지 않으면 null', () => {
    const opt: CatalogPublishOption = { visible: true, policy: 'auto' }
    assert.deepEqual(importCatalogFor({ source: 'import', catalogBy: 'import', catalogVisible: false, invitePolicy: 'approval' }, opt), { visible: true, policy: 'auto', by: 'import' })
    assert.deepEqual(importCatalogFor({ source: 'import', catalogBy: null, catalogVisible: false, invitePolicy: 'approval' }, opt), { visible: true, policy: 'approval', by: 'import-legacy' })
    assert.deepEqual(importCatalogFor({ source: 'import', catalogBy: 'import-legacy', catalogVisible: true, invitePolicy: 'approval' }, opt), { visible: true, policy: 'approval', by: 'import-legacy' })
    assert.equal(importCatalogFor({ source: 'import', catalogBy: 'teacher', catalogVisible: false, invitePolicy: 'approval' }, opt), null)
    assert.equal(importCatalogFor({ source: 'import', catalogBy: 'import', catalogVisible: false, invitePolicy: 'approval', legacyGroupId: 'g' }, opt), null)
  })
})
