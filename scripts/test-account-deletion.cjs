// Run with: node --test scripts/test-account-deletion.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const exported = {}
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/accountDeletion.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText, { exports: exported, URL })
const { isRecentLogin: recent, isSafeDocId: safeId, filesUnder, legacyNoticeFilePath: legacy, anonymizeRequestPatch: patch, DELETED_TEACHER_NAME: GONE, RECENT_LOGIN_MAX_AGE_SEC: maxAge } = exported
const plain = (v) => JSON.parse(JSON.stringify(v))

test('Deletion needs a sign-in from the last ten minutes', () => {
  const now = 1_800_000_000_000
  assert(recent(now / 1000 - 30, now))
  assert(recent(now / 1000 - maxAge, now))
  for (const t of [now / 1000 - maxAge - 1, undefined, null, '1800000000', NaN]) assert.equal(recent(t, now), false)
})
test('Only plain document IDs reach Firestore paths', () => {
  assert(safeId('7010057_1_9'))
  assert(safeId('7010057_1_9_g_abc123'))
  for (const v of ['', 'users/other', '../x', 'a b', 'x'.repeat(81), 12, null]) assert.equal(safeId(v), false)
})
test('Attachment cleanup stays inside the message folder', () => {
  const prefix = 'chat-files/C1/M1/'
  assert.deepEqual(plain(filesUnder(prefix, [{ path: 'chat-files/C1/M1/a' }, { path: 'chat-files/C1/M2/b' }, { path: 'chat-files/C1/M1/../M2/c' }, { name: 'no-path' }, null, 'x'])), ['chat-files/C1/M1/a'])
  assert.deepEqual(plain(filesUnder(prefix, undefined)), [])
})
test('Legacy notice files are read only from the default bucket notices folder', () => {
  const bucket = 'classmate-mvp-9f855.appspot.com'
  const url = (b, p) => `https://firebasestorage.googleapis.com/v0/b/${b}/o/${encodeURIComponent(p)}?alt=media&token=t`
  assert.equal(legacy(url(bucket, 'notices/1700000000000_가정통신문.pdf'), bucket), 'notices/1700000000000_가정통신문.pdf')
  for (const u of [url('other-bucket', 'notices/a.pdf'), url(bucket, 'users/a.pdf'), url(bucket, 'notices/../users/a.pdf'), 'https://evil.example/v0/b/x/o/notices%2Fa', 'http://firebasestorage.googleapis.com/v0/b/x/o/notices%2Fa', 'not a url', null]) assert.equal(legacy(u, bucket), null)
  assert.equal(legacy(url(bucket, 'notices/a.pdf'), undefined), null)
})
test('Open swap requests close and names are replaced', () => {
  assert.deepEqual(plain(patch('swap', { requesterId: 'u', requesterName: '김선생', toId: 'v', toName: '이선생', status: 'pending' }, 'u')), { set: { requesterName: GONE, status: 'cancelled' }, now: ['cancelledAt'] })
  assert.deepEqual(plain(patch('swap', { requesterId: 'v', requesterName: '이선생', toId: 'u', toName: '김선생' }, 'u')), { set: { toName: GONE, status: 'declined', declinerName: GONE }, now: ['declinedAt'] })
  assert.deepEqual(plain(patch('swap', { fromId: 'u', fromName: '김선생', status: 'accepted', accepterId: 'v', accepterName: '이선생' }, 'u')), { set: { fromName: GONE }, now: [] })
  assert.deepEqual(plain(patch('swap', { requesterId: 'v', status: 'accepted', accepterId: 'u', accepterName: '김선생' }, 'u')), { set: { accepterName: GONE }, now: [] })
  assert.equal(patch('swap', { requesterId: 'u', requesterName: GONE, status: 'cancelled' }, 'u'), null)
  assert.equal(patch('swap', { requesterId: 'v', toId: 'w' }, 'u'), null)
})
test('Open SOS requests are cancelled; finished ones keep the record', () => {
  assert.deepEqual(plain(patch('sos', { requesterId: 'u', requesterName: '김선생' }, 'u')), { set: { requesterName: GONE, status: 'cancelled' }, now: ['cancelledAt'] })
  assert.deepEqual(plain(patch('sos', { requesterId: 'v', status: 'assigned', assignedTo: 'u', assignedName: '김선생' }, 'u')), { set: { assignedName: GONE }, now: [] })
  assert.equal(patch('sos', { requesterId: 'v', status: 'open' }, 'u'), null)
})
