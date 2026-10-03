// firestore.indexes.json이 코드의 쿼리와 맞는지(운영 점검 0·1·4) — 정적 검사, 네트워크 없음
//  - 꼭 필요한 복합 인덱스: classes(schoolCode, grade, classNm)(/teacher/view-timetables), changeSets(affectedCourseIds CONTAINS, createdAt DESC)
//  - 쓰는 쿼리가 없는 복합 인덱스는 두지 않음, 컬렉션 그룹 쿼리가 없으니 COLLECTION_GROUP 범위·fieldOverrides도 없음
//  - 내 승인 대기 목록은 status를 쿼리에서 거름(limit 뒤 메모리 필터면 처리된 묶음에 밀려 대기 요청이 잘림)
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/** 저장소 파일 — 컴파일 위치(.test-dist/tests/unit)와 원본 위치 모두에서 찾음 */
function repoPath(rel: string): string {
  const cands = [path.resolve(__dirname, '../../..', rel), path.resolve(__dirname, '../..', rel), path.resolve(process.cwd(), rel)]
  const f = cands.find((p) => fs.existsSync(p))
  if (!f) throw new Error(`파일 없음: ${rel}`)
  return f
}
const read = (rel: string) => fs.readFileSync(repoPath(rel), 'utf8')

interface IndexField {
  fieldPath: string
  order?: 'ASCENDING' | 'DESCENDING'
  arrayConfig?: 'CONTAINS'
}
interface IndexDef {
  collectionGroup: string
  queryScope: string
  fields: IndexField[]
}
const file = JSON.parse(read('firestore.indexes.json')) as { indexes: IndexDef[]; fieldOverrides: unknown[] }
const sig = (ix: IndexDef) =>
  `${ix.queryScope}:${ix.collectionGroup}(${ix.fields.map((f) => `${f.fieldPath} ${f.arrayConfig || f.order}`).join(', ')})`
const sigs = file.indexes.map(sig)

describe('firestore.indexes.json', () => {
  test('꼭 필요한 복합 인덱스가 있음', () => {
    assert.ok(sigs.includes('COLLECTION:classes(schoolCode ASCENDING, grade ASCENDING, classNm ASCENDING)'), sigs.join('\n'))
    assert.ok(sigs.includes('COLLECTION:changeSets(affectedCourseIds CONTAINS, createdAt DESCENDING)'), sigs.join('\n'))
  })

  test('쓰는 쿼리가 없는 복합 인덱스는 없음', () => {
    for (const unused of [
      'COLLECTION:enrollments(uid ASCENDING, status ASCENDING)',
      'COLLECTION:courses(commonForHomerooms CONTAINS, status ASCENDING)',
      'COLLECTION:courses(termId ASCENDING, catalogVisible ASCENDING, status ASCENDING)',
      'COLLECTION:series(courseId ASCENDING, validFrom ASCENDING)',
      'COLLECTION:overrides(courseId ASCENDING, status ASCENDING)',
    ]) {
      assert.ok(!sigs.includes(unused), unused)
    }
  })

  test('중복 없음, 모두 컬렉션 범위, fieldOverrides 없음', () => {
    assert.equal(new Set(sigs).size, sigs.length)
    assert.ok(file.indexes.every((ix) => ix.queryScope === 'COLLECTION' && ix.fields.length >= 2), sigs.join('\n'))
    assert.deepEqual(file.fieldOverrides, [])
  })
})

describe('인덱스가 맞춰야 하는 쿼리', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) out.push(p)
    }
    return out
  }

  test('src/·scripts/에 컬렉션 그룹 쿼리 없음(생기면 COLLECTION_GROUP 범위 인덱스를 함께 추가)', () => {
    const files = walk(repoPath('src')).concat(walk(repoPath('scripts')))
    assert.ok(files.length > 10)
    const hits = files.filter((f) => /collectionGroup\s*\(/.test(fs.readFileSync(f, 'utf8')))
    assert.deepEqual(hits, [])
  })

  test('/teacher/view-timetables 학급 목록 쿼리가 classes 인덱스와 같은 모양', () => {
    const s = read('src/pages/teacher/view-timetables.tsx').replace(/\s+/g, ' ')
    assert.match(s, /collection\(db, 'classes'\), where\('schoolCode', '==', [^)]+\), orderBy\('grade', 'asc'\), orderBy\('classNm', 'asc'\)/)
  })

  test('내 승인 대기 목록: status 등호를 limit 전에 쿼리에 걸고, 복합 인덱스가 필요한 정렬은 붙이지 않음', () => {
    const s = read('src/pages/api/schedule-changes.ts').replace(/\s+/g, ' ')
    const m = s.match(/csCol\(ctx\)\s*\.where\('approverUids', 'array-contains', ctx\.u\.uid\)([^;]*?)\.get\(\)/)
    assert.ok(m, 'approverUids 쿼리를 찾지 못함')
    const chain = m[1]
    assert.match(chain, /^\s*\.where\('status', '==', 'pending-approval'\)\s*\.limit\(\d+\)\s*$/)
    assert.doesNotMatch(chain, /orderBy/)
  })
})
