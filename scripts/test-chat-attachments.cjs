const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const exported = {}
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/chatAttachments.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText, { exports: exported })
const { validateChatFiles: validate, canAccessChatFiles: access, matchesImageSignature: image, MAX_CHAT_FILE_BYTES: max } = exported

test('Korean school documents and ordinary photos are supported', () => {
  assert.equal(validate([{ name: '가정통신문.hwpx', size: 1024 }, { name: '수업자료.xlsx', size: 2048 }, { name: '사진.JPG', size: max }]), null)
})
test('Reject oversized, empty, unsafe, too many and excessive total uploads', () => {
  for (const files of [[], [{ name: 'a.pdf', size: max + 1 }], [{ name: 'a.pdf', size: 0 }], [{ name: 'a.exe', size: 1 }], [{ name: 'a.html', size: 1 }], [{ name: 'a.svg', size: 1 }], [{ name: '../a.pdf', size: 1 }], Array(6).fill({ name: 'a.pdf', size: 1 }), Array(3).fill({ name: 'a.pdf', size: max })]) assert.equal(typeof validate(files), 'string')
})
test('Room membership includes extra classes, never pending or unrelated students', () => {
  const cls = { schoolCode: 'school-A' }
  assert(access({ role: 'teacher', schoolCode: 'school-A' }, cls, 'A'))
  assert(access({ role: 'student', status: 'approved', classId: 'A' }, cls, 'A'))
  assert(access({ role: 'student', status: 'approved', classId: 'B', extraClassIds: ['A'] }, cls, 'A'))
  for (const user of [{ role: 'teacher', schoolCode: 'school-B' }, { role: 'student', status: 'pending', classId: 'A' }, { role: 'student', status: 'rejected', extraClassIds: ['A'] }, { role: 'student', status: 'approved', classId: 'B' }, {}]) assert.equal(access(user, cls, 'A'), false)
})
test('Only verified image signatures can be shown inline', () => {
  assert(image(Uint8Array.from([137,80,78,71,13,10,26,10]), 'image/png'))
  assert(image(Uint8Array.from([255,216,255]), 'image/jpeg'))
  assert.equal(image(Buffer.from('<script>alert(1)</script>'), 'image/jpeg'), false)
  assert.equal(image(Buffer.from('<svg>'), 'image/svg+xml'), false)
})
