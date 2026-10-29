'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../lib/config');
const store = require('../lib/store');

function memoryStore(run) {
  const original = { readState: store.readState, writeJSON: store.writeJSON, removeJSON: store.removeJSON };
  const files = new Map();
  store.readState = (name) => files.has(name) ? { status: 'ok', value: structuredClone(files.get(name)) } : { status: 'missing' };
  store.writeJSON = (name, value) => files.set(name, structuredClone(value));
  store.removeJSON = (name) => files.delete(name);
  try { run(files); } finally { Object.assign(store, original); }
}
const base = { tg_chat_id: '', paused: false, accounts: [], revision: 1 };
const privateDefaults = { auth_token: 'synthetic-default', ct0: 'synthetic-csrf', tg_bot_token: '' };

test('legacy usernames retain their identity while reply, List and search sources have independent stable keys', () => {
  const sources = [{ username: '@Alice', fetch_count: 10, check_interval: 30 },
    { source_type: 'user', username: 'Alice', timeline_mode: 'replies' },
    { source_type: 'list', list_id: '12345678901234567890123456789012' },
    { source_type: 'search', query: '  AI lang:en  ' }];
  assert.equal(config.validAccounts(sources), true);
  const normalized = config.normalizeAccounts(sources);
  assert.deepEqual(normalized[0], { username: 'Alice', fetch_count: 10, check_interval: 30 });
  assert.equal(config.sourceKey(normalized[0]), 'alice');
  assert.equal(config.sourceKey(normalized[1]), 'replies:alice');
  assert.equal(config.sourceKey(normalized[2]), 'list:12345678901234567890123456789012');
  assert.match(config.sourceKey(normalized[3]), /^search:[a-f0-9]{24}$/);
  assert.equal(config.sourceKey(normalized[3]), config.sourceKey({ source_type: 'search', query: 'AI lang:en' }));
  assert.equal(config.validAccounts([{ username: 'Alice' }, { username: 'alice', source_type: 'user', timeline_mode: 'posts' }]), false);
  assert.equal(config.validAccounts([{ source_type: 'search', query: ' AI ' }, { source_type: 'search', query: 'AI' }]), false);
  assert.equal(config.normalizeAccounts([{ user: 'alice' }])[0].username, 'alice');
});

test('malformed source or filter rows reject the entire submitted list', () => {
  for (const row of [null, { username: 'alice', source_type: null }, { source_type: 'other' }, { source_type: 'list', list_id: 42 },
    { source_type: 'list', list_id: '0' }, { source_type: 'list', list_id: '1'.repeat(33) },
    { source_type: 'search', query: '\uD800' }, { source_type: 'search', query: 'a\nsecret' },
    { source_type: 'search', query: 'a'.repeat(513) }, { username: 'alice', timeline_mode: 'all' },
    { username: 'alice', filters: { reposts: 'false' } }, { username: 'alice', filters: { include: [''] } },
    { username: 'alice', filters: { include: Array(31).fill('AI') } }, { username: 'alice', filters: { typo: true } },
    { username: 'alice', filters: { exclude: ['x'.repeat(101)] } }, { username: 'alice', filters: { include: ['\uD800'] } }, { username: 'alice', fetch_count: 0 }]) {
    assert.equal(config.validAccounts([{ username: 'valid' }, row]), false, JSON.stringify(row));
  }
  assert.deepEqual(config.normalizeFilters({ include: [' AI ', 'AI'], reposts: false }), {
    include: ['AI'], exclude: [], originals: true, reposts: false, replies: true, quotes: true,
  });
});

test('additional session metadata and private credentials reject aliases, malformed maps and implicit proxies', () => {
  for (const proxy_url of ['http://proxy.test', 'https://user:secret@proxy.test:443', 'socks5://proxy.test:1080',
    'http://proxy.test:80/path', 'http://proxy.test:80/?token=secret', 'http://proxy.test:80/#fragment',
    'http://proxy.test:0', 'http://proxy.test:65536', '\u0000http://proxy.test:80']) {
    assert.equal(config.validSessions([{ id: 'backup', proxy_url }]), false, proxy_url);
  }
  for (const proxy_url of ['http://127.0.0.1:8080', 'https://proxy.test:443/', 'http://[::1]:80']) {
    assert.equal(config.validSessions([{ id: 'backup', proxy_url, enabled: true }]), true, proxy_url);
  }
  for (const id of ['default', '__proto__', 'constructor', 'Mixed', 'x'.repeat(33)]) {
    assert.equal(config.validSessions([{ id }]), false);
  }
  assert.equal(config.validSessions([{ id: 'a' }, { id: 'a' }]), false);
  assert.equal(config.validSessions(Array.from({ length: 11 }, (_, i) => ({ id: 's' + i }))), false);
  assert.equal(config.validSessionSecrets({ backup: { auth_token: 'secret\nheader' } }), false);
  assert.equal(config.validSessionSecrets(JSON.parse('{"__proto__":{"auth_token":"synthetic"}}')), false);
  assert.equal(config.validSessionSecrets({ backup: { proxy_url: 'http://proxy:80' } }), false);
});

test('settings round-trip preserves source policies and additional sessions across pause-only and secret-only updates', () => memoryStore((files) => {
  const accounts = config.normalizeAccounts([{ source_type: 'search', query: 'AI', filters: { exclude: ['ads'], quotes: false } }]);
  config.saveSettings({ ...base, accounts, media_mode: 'photos', enrichment_mode: 'thread', enrichment_limit: 5,
    x_sessions: [{ id: 'backup', label: '备用会话', enabled: true, proxy_url: 'http://127.0.0.1:8080' }] },
  { ...privateDefaults, x_sessions: { backup: { auth_token: 'synthetic-backup', ct0: 'synthetic-backup-csrf' } } });
  const loaded = config.getConfig();
  assert.deepEqual(loaded.accounts, accounts);
  assert.equal(loaded.enrichment_limit, 5);
  assert.equal(JSON.stringify(loaded).includes('synthetic-backup'), false);
  config.saveConfig({ ...loaded, paused: true });
  config.saveSecrets({ ...privateDefaults, tg_bot_token: 'synthetic-bot' });
  assert.equal(config.getConfig().media_mode, 'photos');
  assert.equal(config.getConfig().x_sessions[0].label, '备用会话');
  assert.equal(config.getSecrets().x_sessions.backup.auth_token, 'synthetic-backup');
  assert.equal(files.has('config_transaction.json'), false);
  for (const patch of [{ media_mode: 'download' }, { enrichment_limit: 0 }, { enrichment_mode: true }, { x_sessions: [{ id: 'default' }] }]) {
    files.set('config.json', { ...files.get('config.json'), ...patch });
    assert.throws(() => config.getConfig(), { code: 'DATA_CORRUPT' });
    files.set('config.json', { ...loaded, _revision: loaded.revision });
  }
}));
