// 교사 일정 변경·수강 명단 화면 검토 결함(라운드 2: 10·13·14·15)의 회귀 테스트 — 순수 로직, 가상 데이터
//  [10] 보강 추가 패널의 대상 수업은 지금 수업 선택에 있는 수업만 — 선택에서 빼면 패널을 닫고 대상 수업을 다시 정함
//  [15] 검토 필요 '원래대로'는 작성 중인 변경 목록·사유를 말없이 덮어쓰지 않음(같은 범위면 추가, 다르면 확인 후 바꾸기)
//  [13] 수강 명단 미리보기 뒤 적용 시작일·학기를 바꾸면 그 미리보기로는 저장하지 않음(다시 미리보기)
//  [14] '읽지 못한 행 빼고 계속하기' 동의는 동의할 때의 파일·시트·머리글·열 매핑에만 유효
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  deselectCourse,
  draftItemKey,
  draftScopeOf,
  makeupCourseFor,
  mergeDraftEntries,
  ORPHAN_RESTORE_REASON,
  planOrphanRestore,
  type DraftEntryOf,
  type DraftItemLike,
} from '../../src/lib/timetable/scheduleChangeView'
import { canStageRoster, rosterSourceKey, rosterStageKey, skipConsentValid, stagedIsStale } from '../../src/lib/timetable/rosterImportView'

/** 화면 소스(정적 검사용) — 컴파일 위치(.test-dist/tests/unit)와 원본 위치 모두에서 찾음 */
function src(rel: string): string {
  const cands = [path.resolve(__dirname, '../../..', rel), path.resolve(__dirname, '../..', rel), path.resolve(process.cwd(), rel)]
  const f = cands.find((p) => fs.existsSync(p))
  if (!f) throw new Error(`소스 없음: ${rel}`)
  return fs.readFileSync(f, 'utf8')
}

// ───────────────────────── 일정 변경 화면 ─────────────────────────

interface Item extends DraftItemLike {
  op: 'cancel' | 'restore' | 'reschedule' | 'makeup' | 'base'
  target?: Record<string, unknown>
}
type Entry = DraftEntryOf<Item>

let seq = 0
const newId = () => `d${++seq}`
const OPTS = { max: 40, newId }
const dateEntry = (id: string, courseId: string, occ: string, op: Item['op'] = 'cancel'): Entry => ({ id, label: `${courseId} ${occ} ${op}`, item: { op, courseId, occurrenceKey: occ } })
const baseEntry = (id: string, seriesId: string): Entry => ({ id, label: `기본 ${seriesId}`, item: { op: 'base', courseId: 'engB', seriesId } })
const orphan = (occ: string) => ({ label: `영어 B ${occ} 원래대로 (검토 필요 정리)`, item: { op: 'restore' as const, courseId: 'engB', occurrenceKey: occ } })

describe('[10] 보강 추가 패널의 대상 수업', () => {
  test('고른 수업이 선택에 있으면 그대로, 빠졌으면 남은 첫 수업, 남은 수업이 없으면 빈 값', () => {
    assert.equal(makeupCourseFor('A', ['A', 'B']), 'A')
    assert.equal(makeupCourseFor('A', ['B', 'C']), 'B')
    assert.equal(makeupCourseFor('A', []), '')
    assert.equal(makeupCourseFor('', ['B']), 'B')
  })

  test('패널의 수업(A)을 선택에서 빼면 → 패널 닫음, 대상 수업은 B(목록에 없는 A로 보강을 추가하지 않음)', () => {
    const r = deselectCourse(['A', 'B'], 'A', 'A')
    assert.deepEqual(r, { selectedIds: ['B'], mCourse: 'B', closeMakeup: true })
  })

  test('패널 수업이 아닌 다른 수업을 빼면 → 패널 유지, 대상 수업 그대로', () => {
    assert.deepEqual(deselectCourse(['A', 'B'], 'B', 'A'), { selectedIds: ['A'], mCourse: 'A', closeMakeup: false })
  })

  test('패널 수업을 연 직후(mCourse가 선택 첫 수업)·마지막 수업을 빼면 → 닫고 빈 값', () => {
    assert.deepEqual(deselectCourse(['A'], 'A', 'A'), { selectedIds: [], mCourse: '', closeMakeup: true })
    // mCourse가 비어 있어도 화면이 보이는 수업(첫 수업)이 빠지면 닫음
    assert.equal(deselectCourse(['A', 'B'], 'A', '').closeMakeup, true)
  })

  test('A를 뺐다가 다시 고르면 대상 수업이 A로 되돌아가지 않음(지금 보이는 B 유지)', () => {
    const r = deselectCourse(['A', 'B'], 'A', 'A')
    assert.equal(makeupCourseFor(r.mCourse, [...r.selectedIds, 'A']), 'B')
  })

  test('화면: 수업 선택 해제가 deselectCourse를 쓰고, 보강 select·교실 안내·추가가 모두 선택 안의 수업(makeupCourse)을 씀', () => {
    const page = src('src/pages/teacher/schedule-changes.tsx')
    assert.match(page, /deselectCourse\(selectedIds, id, mCourse\)/)
    assert.match(page, /if \(nextSel\.closeMakeup\) setMakeupOpen\(false\)/)
    assert.match(page, /const makeupCourse = makeupCourseFor\(mCourse, selectedIds\)/)
    assert.match(page, /aria-label="보강 수업" className=\{inputCls\} value=\{makeupCourse\}/)
    assert.match(page, /courseById\.get\(makeupCourse\)\?\.course\.defaultRoomName/)
    assert.match(page, /const courseId = makeupCourse\n/)
    assert.doesNotMatch(page, /mCourse \|\| selectedIds\[0\]/)
  })
})

describe('변경 목록 합치기(addItems와 검토 필요 정리가 같은 규칙)', () => {
  test('범위: 빈 목록·이 날짜만은 date, 기본 시간표 변경은 base', () => {
    assert.equal(draftScopeOf([]), 'date')
    assert.equal(draftScopeOf([dateEntry('x', 'engB', 'k1')]), 'date')
    assert.equal(draftScopeOf([baseEntry('x', 's1')]), 'base')
  })

  test('같은 차시 일정 변경 두 개는 한 항목으로 합침(나중 값 우선), 다른 종류는 새 내용으로 바꿈', () => {
    const d0: Entry[] = [{ id: 'r1', label: '교실', item: { op: 'reschedule', courseId: 'engB', occurrenceKey: 'k1', target: { roomName: '시청각실', period: 2 } } }]
    const m = mergeDraftEntries(d0, [{ label: '교사', item: { op: 'reschedule', courseId: 'engB', occurrenceKey: 'k1', target: { period: 3, teacherNames: ['박'] } } }], OPTS)
    assert.ok(m.ok)
    assert.equal(m.next.length, 1)
    assert.equal(m.next[0].id, 'r1')
    assert.equal(m.merged, true)
    assert.deepEqual(m.next[0].item.target, { roomName: '시청각실', period: 3, teacherNames: ['박'] })
    const c = mergeDraftEntries(d0, [{ label: '취소', item: { op: 'cancel', courseId: 'engB', occurrenceKey: 'k1' } }], OPTS)
    assert.ok(c.ok)
    assert.equal(c.replaced, true)
    assert.deepEqual(c.next.map((e) => e.item.op), ['cancel'])
  })

  test('보강은 겹치지 않음, 범위 섞기·최대 개수 초과는 거부(목록 그대로)', () => {
    assert.equal(draftItemKey({ op: 'makeup', courseId: 'engB' }), null)
    const mk = { label: '보강', item: { op: 'makeup' as const, courseId: 'engB', target: { date: '20261007', period: 1 } } }
    const two = mergeDraftEntries([{ id: 'm1', ...mk }], [mk], OPTS)
    assert.ok(two.ok && two.next.length === 2)
    assert.deepEqual(mergeDraftEntries([baseEntry('b1', 's1')], [orphan('k9')], OPTS), { ok: false, error: 'scope-mismatch' })
    const full = Array.from({ length: 40 }, (_, i) => dateEntry(`e${i}`, 'engB', `k${i}`))
    assert.deepEqual(mergeDraftEntries(full, [orphan('k99')], OPTS), { ok: false, error: 'too-many' })
  })
})

describe("[15] 검토 필요 '원래대로'는 작성 중인 변경 목록을 덮어쓰지 않음", () => {
  test('작성 중인 이 날짜만 변경 2건 + 사유 → 목록에 추가(기존 2건·id·사유 유지)', () => {
    const draft = [dateEntry('a', 'engB', 'k1', 'cancel'), dateEntry('b', 'sciA', 'k2', 'cancel')]
    const p = planOrphanRestore(draft, orphan('k9'), '체육대회', OPTS)
    assert.equal(p.kind, 'add')
    if (p.kind !== 'add') return
    assert.equal(p.next.length, 3)
    assert.deepEqual(p.next.slice(0, 2), draft)
    assert.equal(p.next[2].item.op, 'restore')
    assert.equal(p.next[2].item.occurrenceKey, 'k9')
    assert.equal(p.reason, '체육대회')
    assert.equal(p.kept, 2)
  })

  test('빈 목록 → 그 항목 하나, 사유가 비었으면 정리 사유로 채우고 입력한 사유는 유지', () => {
    const p = planOrphanRestore([], orphan('k9'), '', OPTS)
    assert.equal(p.kind, 'add')
    if (p.kind !== 'add') return
    assert.equal(p.next.length, 1)
    assert.equal(p.reason, ORPHAN_RESTORE_REASON)
    assert.equal(p.kept, 0)
    const typed = planOrphanRestore([], orphan('k9'), '보충 정리', OPTS)
    assert.equal(typed.kind === 'add' && typed.reason, '보충 정리')
  })

  test('기본 시간표 변경 목록 → replace(지울 건수·사유 여부를 알려 확인을 받아야 함)', () => {
    const draft = [baseEntry('b1', 's1'), baseEntry('b2', 's2')]
    const p = planOrphanRestore(draft, orphan('k9'), '시간표 개편', OPTS)
    assert.equal(p.kind, 'replace')
    if (p.kind !== 'replace') return
    assert.equal(p.dropped, 2)
    assert.equal(p.hadReason, true)
    assert.equal(p.next.length, 1)
    assert.equal(p.next[0].item.op, 'restore')
    assert.equal(p.reason, ORPHAN_RESTORE_REASON)
    // 계획만 세움 — 원래 목록은 그대로
    assert.equal(draft.length, 2)
  })

  test('목록이 가득(40건) → too-many(아무것도 바꾸지 않음)', () => {
    const full = Array.from({ length: 40 }, (_, i) => dateEntry(`e${i}`, 'engB', `k${i}`))
    assert.deepEqual(planOrphanRestore(full, orphan('k99'), '', OPTS), { kind: 'too-many' })
  })

  test('같은 차시 항목이 이미 있으면 그 항목만 원래대로로 바꿈(나머지 유지)', () => {
    const draft = [dateEntry('a', 'engB', 'k9', 'cancel'), dateEntry('b', 'sciA', 'k2', 'cancel')]
    const p = planOrphanRestore(draft, orphan('k9'), '', OPTS)
    assert.ok(p.kind === 'add' && p.replaced)
    if (p.kind !== 'add') return
    assert.deepEqual(p.next.map((e) => `${e.item.courseId}|${e.item.occurrenceKey}|${e.item.op}`), ['sciA|k2|cancel', 'engB|k9|restore'])
  })

  test("화면: restoreOrphan이 계획을 쓰고, 'replace'는 confirm 뒤에만 적용(취소하면 아무것도 바꾸지 않음)", () => {
    const page = src('src/pages/teacher/schedule-changes.tsx')
    const start = page.indexOf('const restoreOrphan = async')
    assert.ok(start > 0, 'restoreOrphan은 확인 대화상자를 기다리는 async')
    const body = page.slice(start, page.indexOf('// ───────────────────────── 렌더', start))
    assert.match(body, /planOrphanRestore\(draft, entry, reason,/)
    const conf = body.indexOf('await confirm(')
    const bail = body.indexOf('if (!ok) return')
    const set = body.indexOf('setDraft(plan.next)')
    assert.ok(conf > 0 && bail > conf && set > bail, '확인 → 취소면 중단 → 그다음에만 목록 바꾸기')
    assert.ok(body.indexOf("setTab('new')") > set && body.indexOf('runPreview(plan.next, plan.reason)') > set)
    assert.doesNotMatch(body, /setDraft\(entries\)/)
  })
})

// ───────────────────────── 수강 명단 화면 ─────────────────────────

const MAP = { studentKey: null, grade: 0, classNm: 1, number: 2, name: 3, courseCode: null, subject: 4, section: 5, teacher: null }
const SRC = { fileHash: 'h1', sheetName: '명단.xlsx#Sheet1', headerRow: 0, mapping: MAP }

describe('[13] 미리보기 뒤 적용 시작일·학기를 바꾸면 그 미리보기로 저장하지 않음', () => {
  const staged = rosterStageKey({ ...SRC, validFrom: '20261005', termId: '' })

  test('같은 입력이면 그대로 저장 가능', () => {
    assert.equal(stagedIsStale(staged, rosterStageKey({ ...SRC, validFrom: '20261005', termId: '' })), false)
    // 열 매핑 객체의 키 순서만 다른 것은 같은 입력
    const reordered = Object.fromEntries(Object.entries(MAP).reverse())
    assert.equal(stagedIsStale(staged, rosterStageKey({ ...SRC, mapping: reordered, validFrom: '20261005', termId: '' })), false)
  })

  test('적용 시작일 20261005 → 20261101, 학기 입력 → 다시 미리보기 필요', () => {
    assert.equal(stagedIsStale(staged, rosterStageKey({ ...SRC, validFrom: '20261101', termId: '' })), true)
    assert.equal(stagedIsStale(staged, rosterStageKey({ ...SRC, validFrom: '20261005', termId: '2026-2' })), true)
  })

  test('응답을 기다리는 사이 열 매핑·머리글이 바뀐 결과, 키가 없는 결과도 저장하지 않음', () => {
    assert.equal(stagedIsStale(staged, rosterStageKey({ ...SRC, mapping: { ...MAP, grade: 6 }, validFrom: '20261005', termId: '' })), true)
    assert.equal(stagedIsStale(staged, rosterStageKey({ ...SRC, headerRow: 1, validFrom: '20261005', termId: '' })), true)
    assert.equal(stagedIsStale(null, staged), true)
  })

  test('화면: 저장 버튼·commit이 previewStale을 막고, 날짜·학기 입력이 결과를 비우며, 확인 문구에 저장될 학기·날짜', () => {
    const page = src('src/pages/teacher/roster-import.tsx')
    assert.match(page, /const canCommit = [^\n]*!previewStale/)
    assert.match(page, /if \(!staged \|\| previewStale\) return/)
    assert.match(page, /setStagedKey\(key\)/)
    assert.match(page, /setValidFrom\(y\)\n\s*\/\/[^\n]*\n\s*resetResults\(\)/)
    assert.match(page, /setTermId\(t\)\n\s*resetResults\(\)/)
    assert.match(page, /학기 \$\{staged\.termId\} · \$\{formatYmdKo\(staged\.validFrom\)\}부터/)
  })
})

describe("[14] '읽지 못한 행 빼고 계속하기' 동의는 그때의 시트·머리글·열 매핑에만 유효", () => {
  const consent = rosterSourceKey(SRC)

  test('동의한 입력 그대로면 유효(미리보기 가능)', () => {
    assert.equal(skipConsentValid(consent, rosterSourceKey({ ...SRC })), true)
    assert.equal(canStageRoster({ rowCount: 98, tooMany: false, badRowCount: 2, consentKey: consent, sourceKey: rosterSourceKey(SRC) }), true)
  })

  test('학년 열을 바꾸면(읽지 못한 행 2 → 300) 동의 풀림 → 미리보기 막힘', () => {
    const now = rosterSourceKey({ ...SRC, mapping: { ...MAP, grade: 5 } })
    assert.equal(skipConsentValid(consent, now), false)
    assert.equal(canStageRoster({ rowCount: 10, tooMany: false, badRowCount: 300, consentKey: consent, sourceKey: now }), false)
  })

  test('머리글 행·시트·파일을 바꿔도 동의 풀림, 동의 안 함(null)은 늘 무효', () => {
    assert.equal(skipConsentValid(consent, rosterSourceKey({ ...SRC, headerRow: 2 })), false)
    assert.equal(skipConsentValid(consent, rosterSourceKey({ ...SRC, sheetName: '명단.xlsx#Sheet2' })), false)
    assert.equal(skipConsentValid(consent, rosterSourceKey({ ...SRC, fileHash: 'h2' })), false)
    assert.equal(skipConsentValid(null, consent), false)
    // 매핑에서 비운 항목(null)과 없는 항목은 같은 매핑
    const noTeacher = { studentKey: null, grade: 0, classNm: 1, number: 2, name: 3, courseCode: null, subject: 4, section: 5 }
    assert.equal(skipConsentValid(consent, rosterSourceKey({ ...SRC, mapping: noTeacher })), true)
  })

  test('읽지 못한 행이 없으면 동의 없이도, 읽은 행이 없거나 너무 많으면 동의가 있어도 막음', () => {
    assert.equal(canStageRoster({ rowCount: 10, tooMany: false, badRowCount: 0, consentKey: null, sourceKey: consent }), true)
    assert.equal(canStageRoster({ rowCount: 0, tooMany: false, badRowCount: 2, consentKey: consent, sourceKey: consent }), false)
    assert.equal(canStageRoster({ rowCount: 9000, tooMany: true, badRowCount: 0, consentKey: consent, sourceKey: consent }), false)
  })

  test('화면: 동의는 키로 저장하고 체크 상태·미리보기 버튼·stage()가 모두 지금 키 기준', () => {
    const page = src('src/pages/teacher/roster-import.tsx')
    assert.doesNotMatch(page, /skipBadRows/)
    assert.match(page, /checked=\{skipOk\} onChange=\{\(e\) => setSkipConsent\(e\.target\.checked \? sourceKey : null\)\}/)
    assert.match(page, /disabled=\{!!busy \|\| !stageReady\}/)
    assert.match(page, /if \(!me \|\| !mapped \|\| !fileHash \|\| !stageReady\) return/)
    assert.match(page, /setSkipConsent\(null\)/)
  })
})
