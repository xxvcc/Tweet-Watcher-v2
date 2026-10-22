'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createEvidenceStore, MAX_FILES, RETENTION_MS } = require('../lib/evidence');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'twscrape-evidence-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, store: createEvidenceStore(directory) };
}
function record(extra = {}) {
  return { runId: crypto.randomUUID(), page: 1, username: 'synthetic', operation: 'timeline',
    data: { text: 'synthetic post', id: '12345678901234567890' }, ...extra };
}

test('evidence is immutable private JSON with full string IDs and verified hash', (t) => {
  const { directory, store } = fixture(t);
  const input = record();
  const result = store.persist(input);
  const file = path.join(directory, result.file);
  const saved = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(saved.data, input.data);
  assert.equal(saved.sha256, crypto.createHash('sha256').update(JSON.stringify(input.data)).digest('hex'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => store.persist(input), /EEXIST/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).data, input.data);
});

test('any credential echoed in an upstream body is removed before persistence', (t) => {
  const { directory, store } = fixture(t);
  const secret = 'SYNTHETIC"CREDENTIAL';
  const result = store.persist(record({ data: { message: `echo ${secret}` }, secrets: [secret] }));
  const saved = JSON.parse(fs.readFileSync(path.join(directory, result.file)));
  assert.equal(saved.data.message, 'echo [REDACTED]');
});

test('bounded retention evicts old rounds and never follows evidence symlinks', (t) => {
  const { directory, store } = fixture(t);
  for (let i = 0; i < MAX_FILES + 3; i++) store.persist(record());
  assert.equal(fs.readdirSync(directory).length, MAX_FILES);
  const oldest = fs.readdirSync(directory)[0];
  fs.utimesSync(path.join(directory, oldest), 0, (Date.now() - RETENTION_MS - 1000) / 1000);
  store.persist(record());
  assert.equal(fs.existsSync(path.join(directory, oldest)), false);
  const link = `evidence-${crypto.randomUUID()}-1.json`;
  fs.symlinkSync('/etc/passwd', path.join(directory, link));
  assert.throws(() => store.persist(record()), /unsafe evidence/);
});

test('public directories and excessive raw pages fail closed', (t) => {
  const { directory, store } = fixture(t);
  fs.chmodSync(directory, 0o755);
  assert.throws(() => store.persist(record()), /private/);
  fs.chmodSync(directory, 0o700);
  assert.throws(() => store.persist(record({ data: { text: 'x'.repeat(8 * 1024 * 1024) } })), /too large/);
  assert.equal(fs.readdirSync(directory).length, 0);
});
