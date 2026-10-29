'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createOutbox } = require('../lib/outbox');
const { migrateState, rollbackState, stateDigest } = require('../lib/migration');
const BINDING = 'a'.repeat(64);

function tweet(value, username = 'alice') {
  return { id: String(value), text: `Post ${value}`, time: '2026-10-29T10:00:00Z',
    url: `https://x.com/${username}/status/${value}`, name: username, is_rt: false,
    author_username: username, is_pinned: false,
    relations: { replyToId: null, quoteId: null, repostId: null, editIds: [String(value)] }, lang: 'en' };
}
function setup(sent = ['99', '100']) {
  const sourceState = { version: 1, accounts: { alice: {
    sent, watermark: '100', pending: [], destination: null, gap: null,
  } } };
  const input = { sourceState, accounts: ['Alice'], destinationBinding: BINDING,
    coverageReport: { version: 1, sourceStateHash: stateDigest(sourceState), destinationBinding: BINDING,
      accounts: { alice: { sinceId: '100', ok: true,
        coverage: { complete: true, reachedSince: true, exhausted: false,
          oldestId: '99', newestId: '102', pages: 1 },
        tweets: [tweet(102), tweet(101), tweet(100), tweet(99)], evidenceHashes: ['b'.repeat(64), 'c'.repeat(64)] } } } };
  return input;
}
function liveOutbox(state) {
  const files = new Map([['delivery_state.json', structuredClone(state)], ['delivery_state.initialized.json', { version: 1 }]]);
  const store = { readState(name) { return files.has(name) ? { status: 'ok', value: structuredClone(files.get(name)) } : { status: 'missing' }; },
    writeJSON(name, value) { files.set(name, structuredClone(value)); } };
  return { box: createOutbox(store, 200), snapshot: () => structuredClone(files.get('delivery_state.json')) };
}
function rollbackInput(input, migrated, currentState = migrated.state) {
  return { originalState: input.sourceState, migratedState: migrated.state, currentState,
    manifest: migrated.manifest, accounts: input.accounts, destinationBinding: BINDING };
}
function expectCode(fn, code) { assert.throws(fn, { code }); }

test('migration queues the verified handover window and does not mutate input or silently baseline new posts', () => {
  const input = setup();
  const before = structuredClone(input);
  input.coverageReport.accounts.alice.tweets.push(tweet(103, 'other'));
  const result = migrateState(input);
  assert.deepEqual(result.state.accounts.alice.sent, ['99', '100']);
  assert.deepEqual(result.state.accounts.alice.pending.map((item) => item.id), ['101', '102']);
  assert.equal(result.state.accounts.alice.acquisitionWatermark, '102');
  assert.equal(result.state.accounts.alice.watermark, '102');
  assert.equal(result.state.accounts.alice.destination, BINDING);
  assert.deepEqual(input.sourceState, before.sourceState);
  assert.equal(result.manifest.sourceStateHash, stateDigest(input.sourceState));
  const restarted = liveOutbox(result.state);
  restarted.box.flush();
  assert.deepEqual(restarted.box.get('alice').pending, result.state.accounts.alice.pending);
});

test('stable digests ignore object insertion order and preserve string identity and array order', () => {
  assert.equal(stateDigest({ z: ['1', '2'], a: { d: true, b: null } }), stateDigest({ a: { b: null, d: true }, z: ['1', '2'] }));
  assert.notEqual(stateDigest(['1', '2']), stateDigest(['2', '1']));
  assert.notEqual(stateDigest(['1']), stateDigest([1]));
});

test('multiple accounts retain separate identities and strict coverage binding', () => {
  const input = setup();
  input.accounts.push('Bob');
  input.sourceState.accounts.bob = structuredClone(input.sourceState.accounts.alice);
  input.sourceState.accounts.bob.sent = ['199', '200'];
  input.sourceState.accounts.bob.watermark = '200';
  input.coverageReport.sourceStateHash = stateDigest(input.sourceState);
  input.coverageReport.accounts.bob = structuredClone(input.coverageReport.accounts.alice);
  input.coverageReport.accounts.bob.sinceId = '200';
  input.coverageReport.accounts.bob.coverage.oldestId = '199';
  input.coverageReport.accounts.bob.coverage.newestId = '202';
  input.coverageReport.accounts.bob.tweets = [202, 201, 200, 199].map((id) => tweet(id, 'bob'));
  const migrated = migrateState(input);
  assert.equal(migrated.state.accounts.bob.pending.length, 2);
  assert.equal(migrated.state.accounts.alice.pending[0].author_username, 'alice');
  assert.equal(migrated.state.accounts.bob.pending[0].author_username, 'bob');
  delete input.coverageReport.accounts.bob;
  expectCode(() => migrateState(input), 'MIGRATION_REPORT_BINDING');
});

test('prototype-like usernames remain own state and manifest keys', () => {
  const input = setup();
  const record = input.sourceState.accounts.alice;
  const proof = input.coverageReport.accounts.alice;
  input.accounts = ['__proto__'];
  input.sourceState.accounts = Object.fromEntries([['__proto__', record]]);
  input.coverageReport.accounts = Object.fromEntries([['__proto__', proof]]);
  input.coverageReport.sourceStateHash = stateDigest(input.sourceState);
  for (const post of proof.tweets) post.author_username = '__proto__';
  const migrated = migrateState(input);
  assert.equal(Object.hasOwn(migrated.state.accounts, '__proto__'), true);
  assert.equal(Object.hasOwn(migrated.manifest.accounts, '__proto__'), true);
  const rolledBack = rollbackState(rollbackInput(input, migrated));
  assert.equal(Object.hasOwn(rolledBack.state.accounts, '__proto__'), true);
  assert.equal(rolledBack.state.accounts.__proto__.pending.length, 2);
});

test('rollback after actual outbox acknowledgement preserves new pending bodies and explicit delivery confirmation', () => {
  const input = setup();
  const migrated = migrateState(input);
  const runtime = liveOutbox(migrated.state);
  runtime.box.acknowledge('alice', '101', ['99', '100', '101', '102']);
  runtime.box.capture('alice', [tweet(103)], BINDING, null, '103');
  const result = rollbackState(rollbackInput(input, migrated, runtime.snapshot()));
  assert.deepEqual(result.state.accounts.alice.sent, ['99', '100', '101']);
  assert.deepEqual(result.state.accounts.alice.pending.map((item) => item.id), ['102', '103']);
  assert.equal(result.state.accounts.alice.watermark, '103');
  assert.equal(Object.hasOwn(result.state.accounts.alice, 'acquisitionWatermark'), false);
  assert.deepEqual(result.state.accounts.alice.pending[1].relations, tweet(103).relations);
});

test('rollback trims only old confirmed cache entries protected by original watermark', () => {
  const input = setup(Array.from({ length: 100 }, (_, index) => String(index + 1)));
  const original = input.sourceState.accounts.alice;
  original.sent = Array.from({ length: 200 }, (_, index) => String(index + 1));
  original.watermark = '200';
  input.coverageReport.sourceStateHash = stateDigest(input.sourceState);
  Object.assign(input.coverageReport.accounts.alice, { sinceId: '200', tweets: [tweet(201), tweet(200)],
    coverage: { complete: true, reachedSince: true, exhausted: false, oldestId: '200', newestId: '201', pages: 1 } });
  const migrated = migrateState(input);
  const runtime = liveOutbox(migrated.state);
  runtime.box.acknowledge('alice', '201', ['200', '201']);
  const result = rollbackState(rollbackInput(input, migrated, runtime.snapshot()));
  assert.equal(result.state.accounts.alice.sent.length, 200);
  assert.equal(result.state.accounts.alice.sent.includes('201'), true);
  assert.equal(result.state.accounts.alice.sent.includes('1'), false);
  assert.equal(result.manifest.accounts.alice.trimmedOldConfirmedCount, 1);
});

test('migration refuses changed snapshots, accounts, destination, gaps and existing pending', () => {
  for (const [mutate, code] of [
    [(input) => { input.sourceState.accounts.alice.sent.push('98'); }, 'MIGRATION_REPORT_BINDING'],
    [(input) => { input.accounts.push('bob'); }, 'MIGRATION_ACCOUNTS'],
    [(input) => { input.coverageReport.destinationBinding = 'f'.repeat(64); }, 'MIGRATION_REPORT_BINDING'],
    [(input) => { input.sourceState.accounts.alice.gap = { after: '98', before: '100' }; }, 'MIGRATION_GAP'],
    [(input) => { input.sourceState.accounts.alice.destination = 'f'.repeat(64); }, 'MIGRATION_DESTINATION'],
    [(input) => { input.sourceState.accounts.alice.pending = [{ id: '98', text: '', time: '', url: '', name: '', is_rt: false }]; input.sourceState.accounts.alice.destination = BINDING; }, 'MIGRATION_PENDING_SOURCE'],
  ]) {
    const input = setup(); mutate(input); expectCode(() => migrateState(input), code);
  }
});

test('migration rejects ambiguous pinned legacy watermark and incomplete or unsupported live proofs', () => {
  for (const [mutate, code] of [
    [(proof) => { proof.coverage.newestId = '99'; }, 'MIGRATION_CHECKPOINT_AMBIGUOUS'],
    [(proof) => { proof.coverage.complete = false; }, 'MIGRATION_COVERAGE'],
    [(proof) => { proof.coverage.reachedSince = false; }, 'MIGRATION_COVERAGE'],
    [(proof) => { proof.sinceId = '99'; }, 'MIGRATION_COVERAGE'],
    [(proof) => { proof.evidenceHashes.pop(); }, 'MIGRATION_COVERAGE'],
    [(proof) => { proof.tweets[0].is_pinned = true; }, 'MIGRATION_COVERAGE'],
    [(proof) => { proof.tweets[0].author_username = 'other'; }, 'MIGRATION_COVERAGE'],
    [(proof) => { proof.tweets.push(structuredClone(proof.tweets[0])); }, 'MIGRATION_DUPLICATE_TWEET'],
  ]) {
    const input = setup(); mutate(input.coverageReport.accounts.alice); expectCode(() => migrateState(input), code);
  }
});

test('rollback refuses lost handover messages, conflicting pending contents and unsafe legacy checkpoints', () => {
  for (const [mutate, code] of [
    [(state) => { state.accounts.alice.pending.shift(); }, 'MIGRATION_UNACCOUNTED_MESSAGE'],
    [(state) => { state.accounts.alice.pending[0].text = 'changed'; }, 'MIGRATION_PENDING_CONFLICT'],
    [(state) => { state.accounts.alice.watermark = '103'; }, 'MIGRATION_CHECKPOINT_AMBIGUOUS'],
    [(state) => { state.accounts.alice.acquisitionWatermark = '100'; }, 'MIGRATION_CHECKPOINT_AMBIGUOUS'],
    [(state) => { state.accounts.alice.destination = 'f'.repeat(64); }, 'MIGRATION_DESTINATION'],
  ]) {
    const input = setup(); const migrated = migrateState(input); const state = structuredClone(migrated.state);
    mutate(state); expectCode(() => rollbackState(rollbackInput(input, migrated, state)), code);
  }
});

test('rollback refuses pending text v1 cannot store without truncation', () => {
  const input = setup();
  input.coverageReport.accounts.alice.tweets[0].text = 'x'.repeat(12001);
  const migrated = migrateState(input);
  expectCode(() => rollbackState(rollbackInput(input, migrated)), 'MIGRATION_LEGACY_TEXT_LIMIT');
});

test('unchanged migration roundtrip retains all confirmed and pending IDs exactly once', () => {
  const input = setup();
  const migrated = migrateState(input);
  const result = rollbackState(rollbackInput(input, migrated));
  assert.deepEqual(result.state.accounts.alice.sent, input.sourceState.accounts.alice.sent);
  assert.deepEqual(result.state.accounts.alice.pending, migrated.state.accounts.alice.pending);
  assert.equal(new Set([...result.state.accounts.alice.sent, ...result.state.accounts.alice.pending.map((item) => item.id)]).size, 4);
});

test('rollback rejects a candidate produced from a different original snapshot', () => {
  const input = setup();
  const migrated = migrateState(input);
  const params = rollbackInput(input, migrated);
  params.originalState = structuredClone(params.originalState);
  params.originalState.accounts.alice.sent.push('98');
  expectCode(() => rollbackState(params), 'MIGRATION_MANIFEST');
});

test('legacy rollback explicitly refuses multipart progress rather than resending or losing it', () => {
  const input = setup();
  const migrated = migrateState(input);
  const live = liveOutbox(migrated.state);
  live.box.prepareDelivery('alice', '101', [{ kind: 'text', text: 'delivered text' },
    { kind: 'photo', url: 'https://pbs.twimg.com/media/synthetic.jpg' }]);
  live.box.acknowledgePart('alice', '101', 0);
  expectCode(() => rollbackState(rollbackInput(input, migrated, live.snapshot())), 'MIGRATION_EXTENDED_STATE');
  assert.equal(live.box.get('alice').pending[0].delivery.next, 1);
});

test('migration CLI creates private complete candidate without changing inputs and refuses overwrite', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-migrate-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'input.json');
  const serialized = JSON.stringify(setup());
  fs.writeFileSync(file, serialized, { mode: 0o600 });
  const destination = path.join(directory, 'candidate');
  const script = path.resolve(__dirname, '../scripts/migrate-state.cjs');
  const args = [script, 'migrate', '--input', file, '--output-dir', destination];
  const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).pending, 2);
  assert.equal(fs.statSync(destination).mode & 0o777, 0o700);
  for (const name of ['delivery_state.json', 'delivery_state.initialized.json', 'migration-manifest.json']) {
    assert.equal(fs.statSync(path.join(destination, name)).mode & 0o777, 0o600);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), serialized);
  const second = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(second.status, 1);
  assert.equal(JSON.parse(second.stderr).code, 'MIGRATION_OUTPUT_EXISTS');
});

test('migration CLI refuses symlink/private input violations and reports no input contents', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-migrate-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'input.json');
  fs.writeFileSync(file, '{sensitive fixture marker', { mode: 0o600 });
  const symlink = path.join(directory, 'link.json');
  fs.symlinkSync(file, symlink);
  const script = path.resolve(__dirname, '../scripts/migrate-state.cjs');
  for (const input of [file, symlink]) {
    const result = spawnSync(process.execPath, [script, 'migrate', '--input', input, '--output-dir', path.join(directory, 'candidate')], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.includes('sensitive fixture marker'), false);
    assert.equal(fs.existsSync(path.join(directory, 'candidate')), false);
  }
});
