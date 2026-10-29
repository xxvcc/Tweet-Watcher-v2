'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../lib/config');
const store = require('../lib/store');

// Legacy fixtures have no pending cross-file settings transaction.
const withoutTransaction = (read) => (name) => name === 'config_transaction.json'
  ? { status: 'missing' } : read(name);

test('account normalization ignores malformed username types instead of throwing', () => {
  const normalized = config.normalizeAccounts([
    { username: 123 },
    { username: {} },
    { username: false },
    { username: '@Valid_User', fetch_count: 999, check_interval: 1 },
  ]);
  assert.deepEqual(normalized, [{ username: 'Valid_User', fetch_count: 50, check_interval: 30 }]);
});

test('submitted account lists reject invalid entries without silently dropping accounts', () => {
  assert.equal(config.validAccounts([]), true, 'an explicit empty list remains a deliberate removal');
  assert.equal(config.validAccounts(['@Alice', { username: 'Bob', fetch_count: 50, check_interval: 30 }]), true);
  for (const list of [
    null, {}, 'alice', [null], [[]], [123], [{ username: 123 }],
    ['alice!'], ['alice', 'ALICE'], ['alice', { username: 'bob!' }],
    [{ username: 'alice', fetch_count: '10' }], [{ username: 'alice', fetch_count: 0 }],
    [{ username: 'alice', check_interval: 29 }], [{ username: 'alice', check_interval: 3601 }],
    Array.from({ length: config.LIMITS.MAX_ACCOUNTS + 1 }, (_, i) => `user_${i}`),
  ]) assert.equal(config.validAccounts(list), false);
});

test('configuration string boundaries reject oversized or unsafe chat IDs', () => {
  assert.equal(config.validChatId('1'.repeat(32)), true);
  assert.equal(config.validChatId('1'.repeat(33)), false);
  assert.equal(config.validChatId(Number.MAX_SAFE_INTEGER + 1), false);
});

test('malformed persisted secret types fail closed without degrading to empty values', () => {
  const original = store.readState;
  try {
    store.readState = withoutTransaction(() => ({ status: 'ok', value: { auth_token: { toString: null }, ct0: 123, tg_bot_token: false } }));
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
    store.readState = withoutTransaction(() => ({ status: 'ok', value: { tg_chat_id: 0, paused: false, accounts: [], _revision: 7 } }));
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
    store.readState = withoutTransaction(() => ({ status: 'corrupt', value: undefined, error: new SyntaxError('injected') }));
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
    store.readState = withoutTransaction((name) => name === 'config.json'
      ? { status: 'missing', value: undefined, error: null }
      : name === 'secrets.json'
        ? { status: 'ok', value: { auth_token: 'secret' }, error: null }
        : { status: 'missing', value: undefined, error: null });
    assert.throws(() => config.getConfig(), (error) => error && error.code === 'DATA_CORRUPT');

    store.readState = withoutTransaction(() => ({ status: 'missing', value: undefined, error: null }));
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
    store.readState = withoutTransaction(() => ({ status: 'ok', value: { paused: 'false', accounts: [] }, error: null }));
    assert.throws(() => config.getConfig(), (error) => error && error.code === 'DATA_CORRUPT');
    assert.throws(() => config.saveConfig({
      tg_chat_id: '', paused: false, accounts: [], revision: 1,
    }), (error) => error && error.code === 'DATA_CORRUPT');
    store.readState = withoutTransaction(() => ({
      status: 'ok',
      value: { paused: false, accounts: [{ username: 123 }] },
      error: null,
    }));
    assert.throws(() => config.getConfig(), (error) => error && error.code === 'DATA_CORRUPT');
    store.readState = withoutTransaction(() => ({
      status: 'ok',
      value: { paused: false, accounts: [{ username: 'alice', fetch_count: {} }] },
      error: null,
    }));
    assert.throws(() => config.getConfig(), (error) => error && error.code === 'DATA_CORRUPT');
    store.readState = withoutTransaction(() => ({ status: 'ok', value: { auth_token: 123 }, error: null }));
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
    store.readState = withoutTransaction(() => ({
      status: 'ok', value: { paused: false, accounts: [{ username: 123 }] }, error: null,
    }));
    assert.throws(() => config.saveConfig({
      tg_chat_id: '', paused: false, accounts: [], revision: 1,
    }), (error) => error && error.code === 'DATA_CORRUPT');

    store.readState = withoutTransaction(() => ({ status: 'ok', value: [], error: null }));
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
    store.readState = withoutTransaction(() => ({
      status: 'ok', value: {
        bird_path: '/untrusted/old-executable', tg_chat_id: '-123', paused: true,
        accounts, _revision: 91,
      },
    }));
    store.writeJSON = (name, value) => { written = { name, value }; };
    const loaded = config.getConfig();
    assert.deepEqual(loaded, {
      tg_chat_id: '-123', paused: true, accounts, revision: 91, persisted: true,
      ai_translation_enabled: false, ai_base_url: 'https://api.openai.com/v1', ai_model: '',
    });
    config.saveConfig({ ...loaded, bird_path: '/another/untrusted/executable' });
    assert.deepEqual(written, {
      name: 'config.json',
      value: { tg_chat_id: '-123', paused: true, accounts, _revision: 91,
        ai_translation_enabled: false, ai_base_url: 'https://api.openai.com/v1', ai_model: '' },
    });
  } finally {
    store.readState = originalRead;
    store.writeJSON = originalWrite;
  }
});

test('legacy and new configuration files have explicit translation defaults and fail closed on malformed AI settings', () => {
  const originalRead = store.readState;
  const base = { tg_chat_id: '', paused: false, accounts: [], _revision: 1 };
  const secrets = { auth_token: '', ct0: '', tg_bot_token: '' };
  let saved = base;
  let savedSecrets = secrets;
  try {
    store.readState = withoutTransaction((name) => ({ status: 'ok', value: name === 'config.json' ? saved : savedSecrets }));
    const loaded = config.getConfig();
    assert.equal(loaded.ai_translation_enabled, false);
    assert.equal(loaded.ai_base_url, 'https://api.openai.com/v1');
    assert.equal(loaded.ai_model, '');
    assert.equal(config.getSecrets().ai_api_key, '');
    for (const patch of [
      { ai_translation_enabled: 'true' }, { ai_base_url: 'http://example.test/v1' },
      { ai_base_url: 'https://user:secret@example.test/v1' }, { ai_base_url: 'https://example.test/v1?token=x' },
      { ai_model: 7 }, { ai_model: 'model\nheader' }, { ai_translation_enabled: true, ai_model: '' },
      { ai_translation_enabled: true, ai_model: 'synthetic-model' },
    ]) {
      saved = { ...base, ...patch };
      assert.throws(() => config.getConfig(), { code: 'DATA_CORRUPT' });
    }
    saved = base;
    for (const ai_api_key of [7, 'synthetic\nheader', 'synthetic\rheader', 'synthetic\0key', 'synthetic key', 'synthetic\tkey', 'x'.repeat(4097)]) {
      savedSecrets = { ...secrets, ai_api_key };
      assert.throws(() => config.getSecrets(), { code: 'DATA_CORRUPT' });
    }
    saved = { ...base, ai_translation_enabled: true, ai_model: 'synthetic-model' };
    savedSecrets = { ...secrets, ai_api_key: 'synthetic-ai-key' };
    assert.equal(config.getConfig().ai_translation_enabled, true);
    assert.equal(config.getSecrets().ai_api_key, 'synthetic-ai-key');
  } finally { store.readState = originalRead; }
});
