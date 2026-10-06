// Run with: node --test scripts/test-teacher-home.cjs
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../src/lib/teacherHomeTimetable.ts'), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
}).outputText
const moduleExports = {}
vm.runInNewContext(compiled, { exports: moduleExports })
const readDay = (schedule, date) => JSON.parse(JSON.stringify(moduleExports.teacherHomeTimetable(schedule, date)))

test('Tuesday uses personal classes and preserves the third and fifth periods', () => {
  const week = {
    mon: ['1-2 과학'],
    tue: ['', '', '3-9 지학2A', '', '1-1 통과', '', ''],
  }
  assert.deepEqual(readDay(week, '20261006'), {
    hasSchedule: true,
    periods: [{ period: 3, subject: '3-9 지학2A' }, { period: 5, subject: '1-1 통과' }],
  })
})

test('No classes today differs from an unregistered or empty weekly timetable', () => {
  assert.deepEqual(readDay({ mon: ['1-2 과학'], tue: [] }, '20261006'), { hasSchedule: true, periods: [] })
  for (const week of [null, undefined, {}, { tue: ['', '   '] }]) {
    assert.deepEqual(readDay(week, '20261006'), { hasSchedule: false, periods: [] })
  }
})

test('Calendar date selects weekdays consistently, including weekends', () => {
  const week = { mon: ['월'], tue: ['화'], wed: ['수'], thu: ['목'], fri: ['금'] }
  for (const [date, subject] of [['20261005', '월'], ['20261006', '화'], ['20261007', '수'], ['20261008', '목'], ['20261009', '금']]) {
    assert.deepEqual(readDay(week, date).periods, [{ period: 1, subject }])
  }
  assert.deepEqual(readDay(week, '20261010').periods, [])
  assert.deepEqual(readDay(week, '20261011').periods, [])
})

test('Malformed slots cannot render object or numeric garbage as a lesson', () => {
  assert.deepEqual(readDay({ tue: [null, {}, 0, '  2-1 국어  '] }, '20261006'), {
    hasSchedule: true, periods: [{ period: 4, subject: '2-1 국어' }],
  })
})
