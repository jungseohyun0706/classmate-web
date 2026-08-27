// 개발용: 실제 시간표 엑셀 파일들로 timetableParser를 검증한다.
// 실행: node scripts/test-parse-timetable.ts <xlsx파일...> [--out 보고서경로]
// (Node 22.7+ 타입 스트리핑으로 바로 실행 가능)
import * as fs from 'node:fs'
import * as XLSX from 'xlsx'
import {
  parseTimetableSheets,
  compareClassLabels,
  DAYS,
  type SheetInput,
  type ParseResult,
  type TeacherGrid,
} from '../src/lib/timetableParser.ts'

const args = process.argv.slice(2)
const outIdx = args.indexOf('--out')
const outPath = outIdx >= 0 ? args[outIdx + 1] : null
const files = args.filter((a, i) => a !== '--out' && i !== outIdx + 1)

const lines: string[] = []
const log = (s: string) => lines.push(s)

const loadSheets = (paths: string[]): SheetInput[] => {
  const sheets: SheetInput[] = []
  for (const p of paths) {
    const wb = XLSX.read(fs.readFileSync(p), { cellStyles: false })
    for (const name of wb.SheetNames) {
      const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], {
        header: 1,
        blankrows: true,
        defval: null,
        raw: false,
      }) as (string | number | null)[][]
      sheets.push({ name: `${p.split(/[\\/]/).pop()}#${name}`, grid })
    }
  }
  return sheets
}

const gridStats = (r: ParseResult) => {
  let classSlots = 0
  let teacherSlots = 0
  let classCellsWithTeacher = 0
  let classCellsWithRoom = 0
  for (const g of Object.values(r.classes)) {
    for (const day of g) for (const c of day) if (c) {
      classSlots++
      if (c.teacher) classCellsWithTeacher++
      if (c.room) classCellsWithRoom++
    }
  }
  for (const g of Object.values(r.teachers)) {
    for (const day of g) for (const c of day) if (c) teacherSlots++
  }
  return { classSlots, teacherSlots, classCellsWithTeacher, classCellsWithRoom }
}

const teacherGridToText = (name: string, grid: TeacherGrid): string => {
  const rows: string[] = [`  [${name}]`]
  grid.forEach((day, d) => {
    const cells = day.map((c, i) =>
      c ? `${i + 1}:${c.classLabel || '?'} ${c.subject}${c.room ? `@${c.room}` : ''}` : null
    ).filter(Boolean)
    rows.push(`   ${DAYS[d]}: ${cells.join(' | ') || '(없음)'}`)
  })
  return rows.join('\n')
}

// ---------- 1) 전체 파일 병합 파싱 ----------
const all = loadSheets(files)
const merged = parseTimetableSheets(all)
log('=== 병합 파싱 (파일 ' + files.length + '개) ===')
log('소스: ' + JSON.stringify(merged.sources, null, 0))
log(`반 수: ${Object.keys(merged.classes).length}`)
log('반 목록: ' + Object.keys(merged.classes).sort(compareClassLabels).join(', '))
log(`교사 수: ${Object.keys(merged.teachers).length}`)
log('교사 목록: ' + Object.keys(merged.teachers).sort((a, b) => a.localeCompare(b, 'ko')).join(', '))
log(`최대 교시: ${merged.maxPeriod}, 교시 시각: ${JSON.stringify(merged.periodTimes)}`)
log('통계: ' + JSON.stringify(gridStats(merged)))
log('경고 ' + merged.warnings.length + '건: ' + merged.warnings.slice(0, 10).join(' / '))

// ---------- 2) 교차 검증: 교사시간표 직접 vs 전체시간표 역산 ----------
const isTeacherFile = (p: string) => /교사시간표|주간시간표/.test(p)
const teacherFiles = files.filter(isTeacherFile)
const classFiles = files.filter((p) => /전체시간표/.test(p))
if (teacherFiles.length > 0 && classFiles.length > 0) {
  const direct = parseTimetableSheets(loadSheets(teacherFiles))
  const derived = parseTimetableSheets(loadSheets(classFiles))
  log('\n=== 교차 검증: 직접(교사/주간표) vs 역산(전체표) ===')
  log(`직접 교사 수: ${Object.keys(direct.teachers).length}, 역산 교사 수: ${Object.keys(derived.teachers).length}`)
  const onlyDirect = Object.keys(direct.teachers).filter((t) => !derived.teachers[t])
  const onlyDerived = Object.keys(derived.teachers).filter((t) => !direct.teachers[t])
  log('직접에만 있음: ' + (onlyDirect.join(', ') || '없음'))
  log('역산에만 있음: ' + (onlyDerived.join(', ') || '없음'))
  let match = 0
  let mismatch = 0
  let onlyInDirect = 0
  let onlyInDerived = 0
  const mismatchSamples: string[] = []
  for (const [t, dg] of Object.entries(direct.teachers)) {
    const vg = derived.teachers[t]
    if (!vg) continue
    for (let d = 0; d < 5; d++) {
      const maxP = Math.max(dg[d]?.length || 0, vg[d]?.length || 0)
      for (let p = 0; p < maxP; p++) {
        const a = dg[d]?.[p]
        const b = vg[d]?.[p]
        if (!a && !b) continue
        if (a && !b) { onlyInDirect++; continue }
        if (!a && b) { onlyInDerived++; continue }
        if (a!.classLabel === b!.classLabel) match++
        else {
          mismatch++
          if (mismatchSamples.length < 10) {
            mismatchSamples.push(`${t} ${DAYS[d]}${p + 1}: 직접=${a!.classLabel}/${a!.subject} vs 역산=${b!.classLabel}/${b!.subject}`)
          }
        }
      }
    }
  }
  log(`슬롯 일치: ${match}, 반 불일치: ${mismatch}, 직접에만: ${onlyInDirect}, 역산에만: ${onlyInDerived}`)
  if (mismatchSamples.length) log('불일치 샘플:\n  ' + mismatchSamples.join('\n  '))
}

// ---------- 2b) 역방향 검증: 교사표만으로 반 시간표 역산 ----------
if (teacherFiles.length > 0 && classFiles.length > 0) {
  const fromTeachers = parseTimetableSheets(loadSheets(teacherFiles))
  const fromClasses = parseTimetableSheets(loadSheets(classFiles))
  log(`\n=== 역방향 검증: 교사표만 → 반 ${Object.keys(fromTeachers.classes).length}개 생성 (전체표 기준 ${Object.keys(fromClasses.classes).length}개)`)
  let m = 0
  let mm = 0
  let aOnly = 0
  let bOnly = 0
  const samples: string[] = []
  for (const [label, cg] of Object.entries(fromClasses.classes)) {
    const dg = fromTeachers.classes[label]
    for (let d = 0; d < 5; d++) {
      const maxP = Math.max(cg[d]?.length || 0, dg?.[d]?.length || 0)
      for (let p = 0; p < maxP; p++) {
        const a = cg[d]?.[p]
        const b = dg?.[d]?.[p]
        if (!a && !b) continue
        if (a && !b) { aOnly++; continue }
        if (!a && b) { bOnly++; continue }
        if (a!.teacher === b!.teacher) m++
        else {
          mm++
          if (samples.length < 8) samples.push(`${label} ${DAYS[d]}${p + 1}: 전체=${a!.subject}/${a!.teacher} vs 역산=${b!.subject}/${b!.teacher}`)
        }
      }
    }
  }
  log(`교사 일치: ${m}, 불일치: ${mm}, 전체표에만: ${aOnly}, 역산에만: ${bOnly}`)
  if (samples.length) log('불일치 샘플:\n  ' + samples.join('\n  '))
}

// ---------- 2c) 특별실 단독 업로드 안전성 ----------
const roomFiles = files.filter((p) => /특별실/.test(p))
if (roomFiles.length > 0) {
  const r = parseTimetableSheets(loadSheets(roomFiles))
  log(`\n=== 특별실 단독: 반 ${Object.keys(r.classes).length}개, 교사 ${Object.keys(r.teachers).length}명 (0/0이어야 안전), 경고: ${r.warnings.join(' / ') || '없음'}`)
}

// ---------- 3) 샘플 출력 ----------
log('\n=== 샘플 ===')
const sampleTeachers = ['조혜선', '이영민', '옥찬휘'].filter((t) => merged.teachers[t])
for (const t of sampleTeachers) log(teacherGridToText(t, merged.teachers[t]))
const sampleClass = Object.keys(merged.classes).sort(compareClassLabels)[0]
if (sampleClass) {
  log(`  [${sampleClass}]`)
  merged.classes[sampleClass].forEach((day, d) => {
    log(`   ${DAYS[d]}: ` + day.map((c, i) => (c ? `${i + 1}:${c.subject}(${c.teacher || '?'}${c.room ? '@' + c.room : ''})` : null)).filter(Boolean).join(' | '))
  })
}

const report = lines.join('\n')
if (outPath) fs.writeFileSync(outPath, report, 'utf8')
console.log(outPath ? `written: ${outPath}` : report)
