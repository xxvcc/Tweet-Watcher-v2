'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const store = require('../lib/store');
const auth = require('../lib/auth');

test('password policy counts characters and enforces bcrypt 72-byte limit', () => {
  assert.ok(process.stderr.listenerCount('error') > 0);
  assert.equal(auth.passwordError('1234567'), '密码至少 8 位');
  assert.equal(auth.passwordError('😀😀😀😀'), '密码至少 8 位');
  assert.equal(auth.passwordError('😀😀😀😀😀😀😀😀'), '');
  assert.equal(auth.passwordError('a'.repeat(72)), '');
  assert.equal(auth.passwordError('a'.repeat(73)), '密码不能超过 72 个 UTF-8 字节');
  assert.equal(auth.passwordError({ toString: null }), '密码至少 8 位');
});

test('an existing structurally invalid password file fails closed', () => {
  const original = store.readState;
  try {
    store.readState = () => ({ status: 'ok', value: {}, error: null });
    assert.equal(auth.hasPassword(), true);
  } finally {
    store.readState = original;
  }
});

test('login rejects suffixes beyond bcrypt effective input boundary', async () => {
  const original = store.readJSON;
  try {
    const exact = 'a'.repeat(72);
    const hash = await bcrypt.hash(exact, 4);
    store.readJSON = () => ({ hash, input_policy: 'utf8-72-v1' });
    assert.equal(await auth.verifyPassword(exact), true);
    assert.equal(await auth.verifyPassword(exact + 'suffix'), false);
  } finally {
    store.readJSON = original;
  }
});

test('legacy unmarked hashes still accept historical passwords over 72 bytes', async () => {
  const originalRead = store.readJSON;
  const originalWrite = store.writeJSON;
  try {
    const legacy = 'a'.repeat(71) + 'é';
    const hash = await bcrypt.hash(legacy, 4);
    store.readJSON = () => ({ hash });
    store.writeJSON = () => { throw new Error('long legacy passwords must not be marked as migrated'); };
    assert.equal(Buffer.byteLength(legacy, 'utf8'), 73);
    assert.equal(await auth.verifyPassword(legacy), true);
  } finally {
    store.readJSON = originalRead;
    store.writeJSON = originalWrite;
  }
});

test('unknown password input policies fail closed', async () => {
  const original = store.readJSON;
  try {
    const hash = await bcrypt.hash('correct-password', 4);
    store.readJSON = () => ({ hash, input_policy: 'unknown-future-policy' });
    assert.equal(await auth.verifyPassword('correct-password'), false);
  } finally {
    store.readJSON = original;
  }
});

test('unreasonably expensive persisted bcrypt hashes fail closed before comparison', async () => {
  const originalRead = store.readJSON;
  const originalCompare = bcrypt.compare;
  let compares = 0;
  try {
    store.readJSON = () => ({
      hash: '$2b$31$' + 'A'.repeat(53),
      input_policy: 'utf8-72-v1',
    });
    bcrypt.compare = async () => { compares++; return true; };
    assert.equal(await auth.verifyPassword('correct-password'), false);
    assert.equal(compares, 0);
  } finally {
    store.readJSON = originalRead;
    bcrypt.compare = originalCompare;
  }
});

test('epoch overflow rotates the signing key and resets the counter safely', () => {
  const originalReadState = store.readState;
  const originalWriteJSON = store.writeJSON;
  const oldKey = 'a'.repeat(64);
  let written = null;
  try {
    store.readState = () => ({ status: 'ok', value: { key: oldKey, epoch: Number.MAX_SAFE_INTEGER }, error: null });
    store.writeJSON = (name, value) => { if (name === 'session_secret.json') written = value; };
    auth.bumpEpoch();
    assert.equal(written.epoch, 1);
    assert.match(written.key, /^[0-9a-f]{64}$/);
    assert.notEqual(written.key, oldKey);
  } finally {
    store.readState = originalReadState;
    store.writeJSON = originalWriteJSON;
  }
});

test('sessions issued far in the future fail closed after a clock rollback', () => {
  const originalNow = Date.now;
  const base = originalNow();
  try {
    Date.now = () => base + 24 * 3600 * 1000;
    const futureSession = auth.makeSession();
    Date.now = () => base;
    assert.equal(auth.verifySession(futureSession), false);
  } finally {
    Date.now = originalNow;
  }
});

test('sessions are scoped to the configured origin and reject legacy tokens after migration', () => {
  const local = auth.makeSession();
  const isolated = auth.makeSession('https://watcher.example.test');
  assert.equal(auth.verifySession(local), true);
  assert.equal(auth.verifySession(local, 'https://watcher.example.test'), false);
  assert.equal(auth.verifySession(isolated, 'https://watcher.example.test'), true);
  assert.equal(auth.verifySession(isolated, 'https://example.test'), false);
  assert.equal(auth.verifySession(isolated), false);
});

test('revocation notifies synchronously after persistence and isolates listener failures', () => {
  const originalWrite = store.writeJSON;
  const calls = [];
  const token = auth.makeSession();
  const unsubscribeBad = auth.onSessionRevoked(() => { calls.push('bad'); throw new Error('synthetic'); });
  const unsubscribeGood = auth.onSessionRevoked(() => {
    assert.equal(auth.verifySession(token), false);
    calls.push('good');
  });
  try {
    store.writeJSON = () => { calls.push('persisted'); };
    auth.bumpEpoch();
    assert.deepEqual(calls, ['persisted', 'bad', 'good']);
    unsubscribeBad(); unsubscribeGood();
    calls.length = 0;
    auth.bumpEpoch();
    assert.deepEqual(calls, ['persisted']);
  } finally {
    unsubscribeBad(); unsubscribeGood();
    store.writeJSON = originalWrite;
  }
});

test('failed epoch persistence never reports a revocation that disappears on restart', () => {
  const originalWrite = store.writeJSON;
  const token = auth.makeSession();
  let called = false;
  const unsubscribe = auth.onSessionRevoked(() => { called = true; });
  try {
    store.writeJSON = () => { throw new Error('synthetic disk full'); };
    assert.throws(() => auth.bumpEpoch(), /disk full/);
    assert.equal(called, false);
    assert.equal(auth.verifySession(token), true);
  } finally {
    unsubscribe();
    store.writeJSON = originalWrite;
  }
});

test('directory fsync failure never reports a successful epoch change and recovery remains durable', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tweet-watcher-auth-sync-'));
  try {
    const child = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const store = require('./lib/store');
      store.writeJSON('session_secret.json', { key: 'a'.repeat(64), epoch: 1 });
      const auth = require('./lib/auth');
      const token = auth.makeSession();
      let revocations = 0;
      auth.onSessionRevoked(() => { revocations++; });
      const fsync = fs.fsyncSync;
      let failDirectory = true;
      fs.fsyncSync = (fd) => {
        if (failDirectory && fs.fstatSync(fd).isDirectory()) {
          throw Object.assign(new Error('synthetic directory sync failure'), { code: 'EIO' });
        }
        return fsync(fd);
      };
      assert.throws(() => auth.bumpEpoch(), { code: 'EIO' });
      assert.equal(auth.sessionEpoch(), 1);
      assert.equal(revocations, 0);
      assert.throws(() => auth.hasPassword(), { code: 'EIO' });
      failDirectory = false;
      auth.bumpEpoch();
      assert.equal(auth.sessionEpoch(), 2);
      assert.equal(revocations, 1);
      assert.equal(auth.verifySession(token), false);
      delete require.cache[require.resolve('./lib/auth')];
      const restarted = require('./lib/auth');
      assert.equal(restarted.sessionEpoch(), 2);
      assert.equal(restarted.verifySession(token), false);
    `], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATA_DIR: directory }, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
