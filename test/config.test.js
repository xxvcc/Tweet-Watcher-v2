'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../lib/config');
const store = require('../lib/store');

test('account normalization ignores malformed username types instead of throwing', () => {
  const normalized = config.normalizeAccounts([
    { username: 123 },
    { username: {} },
    { username: false },
    { username: '@Valid_User', fetch_count: 999, check_interval: 1 },
  ]);
  assert.deepEqual(normalized, [{ username: 'Valid_User', fetch_count: 50, check_interval: 30 }]);
});

test('configuration string boundaries reject oversized or unsafe chat IDs', () => {
  assert.equal(config.validChatId('1'.repeat(32)), true);
  assert.equal(config.validChatId('1'.repeat(33)), false);
  assert.equal(config.validChatId(Number.MAX_SAFE_INTEGER + 1), false);
});

test('malformed persisted secret types fail closed without degrading to empty values', () => {
  const original = store.readState;
  try {
    store.readState = () => ({ status: 'ok', value: { auth_token: { toString: null }, ct0: 123, tg_bot_token: false } });
    assert.throws(() => config.getSecrets(), (error) => error && error.code === 'DATA_CORRUPT');
  } finally {
    store.readState = original;
  }
});

test('persisted config keeps a durable revision and rejects truthy non-boolean pause values', () => {
  const original = store.readState;
  const originalWrite = store.writeJSON;
  let written = null;
  try {
    store.readState = () => ({ status: 'ok', value: { tg_chat_id: 0, paused: false, accounts: [], _revision: 7 } });
    store.writeJSON = (name, value) => { written = { name, value }; };
    const loaded = config.getConfig();
    assert.equal(loaded.tg_chat_id, '0');
    assert.equal(loaded.paused, false);
    assert.equal(loaded.revision, 7);
    assert.equal(loaded.persisted, true);
    assert.ok(config.nextRevision(loaded.revision) > loaded.revision);
    assert.throws(() => config.nextRevision(Number.MAX_SAFE_INTEGER), /\u7248\u672c/);
    config.saveConfig({ ...loaded, revision: 8 });
    assert.equal(written.name, 'config.json');
    assert.equal(written.value._revision, 8);
    assert.equal(Object.prototype.hasOwnProperty.call(written.value, 'revision'), false);
  } finally {
    store.readState = original;
    store.writeJSON = originalWrite;
  }
});

test('corrupt config and secrets files cannot be read as defaults or overwritten', () => {
  const originalRead = store.readState;
  const originalWrite = store.writeJSON;
  let writes = 0;
  try {
    store.readState = () => ({ status: 'corrupt', value: undefined, error: new SyntaxError('injected') });
    store.writeJSON = () => { writes++; };
    assert.throws(() => config.getConfig(), (error) => error && error.code === 'DATA_CORRUPT');
    assert.throws(() => config.getSecrets(), (error) => error && error.code === 'DATA_CORRUPT');
    assert.throws(() => config.saveConfig({}), (error) => error && error.code === 'DATA_CORRUPT');
    assert.throws(() => config.saveSecrets({}), (error) => error && error.code === 'DATA_CORRUPT');
    assert.equal(writes, 0);
  } finally {
    store.readState = originalRead;
    store.writeJSON = originalWrite;
  }
});

test('a missing config rejects established secrets but permits an unconfigured fresh instance', () => {
  const originalRead = store.readState;
  try {
    store.readState = (name) => name === 'config.json'
      ? { status: 'missing', value: undefined, error: null }
      : name === 'secrets.json'
        ? { status: 'ok', value: { auth_token: 'secret' }, error: null }
        : { status: 'missing', value: undefined, error: null };
    assert.throws(() => config.getConfig(), (error) => error && error.code === 'DATA_CORRUPT');

    store.readState = () => ({ status: 'missing', value: undefined, error: null });
    const fresh = config.getConfig();
    assert.deepEqual(fresh.accounts, []);
    assert.equal(fresh.revision, 0);
    assert.equal(fresh.persisted, false);
  } finally {
    store.readState = originalRead;
  }
});

test('structurally invalid persisted config also fails closed', () => {
  const originalRead = store.readState;
  const originalWrite = store.writeJSON;
  let writes = 0;
  try {
    store.writeJSON = () => { writes++; };
    store.readState = () => ({ status: 'ok', value: { paused: 'false', accounts: [] }, error: null });
    assert.throws(() => config.getConfig(), (error) => error && error.code === 'DATA_CORRUPT');
    assert.throws(() => config.saveConfig({
      tg_chat_id: '', paused: false, accounts: [], revision: 1,
    }), (error) => error && error.code === 'DATA_CORRUPT');
    store.readState = () => ({
      status: 'ok',
      value: { paused: false, accounts: [{ username: 123 }] },
      error: null,
    });
    assert.throws(() => config.getConfig(), (error) => error && error.code === 'DATA_CORRUPT');
    store.readState = () => ({
      status: 'ok',
      value: { paused: false, accounts: [{ username: 'alice', fetch_count: {} }] },
      error: null,
    });
    assert.throws(() => config.getConfig(), (error) => error && error.code === 'DATA_CORRUPT');
    store.readState = () => ({ status: 'ok', value: { auth_token: 123 }, error: null });
    assert.throws(() => config.saveSecrets({ auth_token: '', ct0: '', tg_bot_token: '' }),
      (error) => error && error.code === 'DATA_CORRUPT');
    assert.equal(writes, 0);
  } finally {
    store.readState = originalRead;
    store.writeJSON = originalWrite;
  }
});

test('structurally invalid files cannot be overwritten through direct save calls', () => {
  const originalRead = store.readState;
  const originalWrite = store.writeJSON;
  let writes = 0;
  try {
    store.writeJSON = () => { writes++; };
    store.readState = () => ({
      status: 'ok', value: { paused: false, accounts: [{ username: 123 }] }, error: null,
    });
    assert.throws(() => config.saveConfig({
      tg_chat_id: '', paused: false, accounts: [], revision: 1,
    }), (error) => error && error.code === 'DATA_CORRUPT');

    store.readState = () => ({ status: 'ok', value: [], error: null });
    assert.throws(() => config.saveSecrets({ auth_token: '', ct0: '', tg_bot_token: '' }),
      (error) => error && error.code === 'DATA_CORRUPT');
    assert.equal(writes, 0);
  } finally {
    store.readState = originalRead;
    store.writeJSON = originalWrite;
  }
});

test('obsolete executable settings are ignored without resetting accounts, pause or revision', () => {
  const originalRead = store.readState;
  const originalWrite = store.writeJSON;
  const accounts = [{ username: 'alice', fetch_count: 20, check_interval: 60 }];
  let written;
  try {
    store.readState = () => ({
      status: 'ok', value: {
        bird_path: '/untrusted/old-executable', tg_chat_id: '-123', paused: true,
        accounts, _revision: 91,
      },
    });
    store.writeJSON = (name, value) => { written = { name, value }; };
    const loaded = config.getConfig();
    assert.deepEqual(loaded, {
      tg_chat_id: '-123', paused: true, accounts, revision: 91, persisted: true,
    });
    config.saveConfig({ ...loaded, bird_path: '/another/untrusted/executable' });
    assert.deepEqual(written, {
      name: 'config.json',
      value: { tg_chat_id: '-123', paused: true, accounts, _revision: 91 },
    });
  } finally {
    store.readState = originalRead;
    store.writeJSON = originalWrite;
  }
});
