'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const validators = require('../lib/config');
let cfg, secrets, calls, writes, enabled, valid, epoch, operation, pending;
const reset = () => {
  cfg = { revision: 7, tg_chat_id: '1', paused: false, accounts: [{ username: 'alice', fetch_count: 10, check_interval: 30 }],
    media_mode: 'links', enrichment_mode: 'off', enrichment_limit: 2,
    x_sessions: [{ id: 'backup', label: '备用', enabled: true }],
    ai_translation_enabled: false, ai_base_url: 'https://ai.example.test/v1', ai_model: '' };
  secrets = { auth_token: 'synthetic-default-token', ct0: 'synthetic-default-csrf', tg_bot_token: '', ai_api_key: '',
    x_sessions: { backup: { auth_token: 'synthetic-backup-token', ct0: 'synthetic-backup-csrf' } } };
  calls = []; writes = []; enabled = true; valid = true; epoch = 1;
  pending = {};
  operation = async () => ({ ok: true, tweets: [{ id: '123', text: 'synthetic text' }] });
};
reset();
const state = { bus: new EventEmitter(), log() {}, getStatus: () => ({ accounts: {}, configRevision: cfg.revision }), setStatus() {}, getLogs: () => [] };
const modules = new Map([
  ['../lib/config', { ...validators, getConfig: () => structuredClone(cfg), getSecrets: () => structuredClone(secrets),
    saveSettings: (next, nextSecrets) => { writes.push([structuredClone(next), structuredClone(nextSecrets)]); cfg = next; secrets = nextSecrets; } }],
  ['../lib/auth', { hasPassword: () => true, sessionEpoch: () => epoch,
    verifySession: (cookie) => valid && cookie === 'synthetic-session',
    checkCsrf: (cookie, header) => cookie === 'synthetic-csrf' && header === cookie,
    onSessionRevoked: () => () => {} }],
  ['../lib/runtime', { status: () => ({ collectionEnabled: enabled }), blocked: () => enabled ? null : { ok: false, code: 'RUNTIME_DISABLED' } }],
  ['../lib/worker', Object.fromEntries(['testCollector', 'inspectTweet', 'listMembers', 'testSession', 'resetCatchup'].map((name) => [name,
    async (...args) => { calls.push([name, ...args]); return operation(name, ...args); }]).concat([
      ['getDiagnostics', () => {
        if (pending instanceof Error) throw pending;
        return { sessions: { default: { status: 'ready', lastSuccessAt: 123 } }, backfills: {}, pendingCounts: pending };
      }],
      ['configChanged', () => {}], ['start', () => {}],
    ]))],
  ['../lib/store', {}], ['../lib/twscrape', {}], ['../lib/state', state],
]);
const saved = new Map();
for (const [name, exports] of modules) {
  const id = require.resolve(name); saved.set(id, require.cache[id]); require.cache[id] = { id, filename: id, loaded: true, exports };
}
const env = new Map(['PUBLIC_ORIGIN', 'TRUST_PROXY_TOKEN'].map((key) => [key, process.env[key]]));
for (const key of env.keys()) delete process.env[key];
const serverId = require.resolve('../server'); saved.set(serverId, require.cache[serverId]); delete require.cache[serverId];
const listeners = new Map([process.stdout, process.stderr].map((stream) => [stream, new Set(stream.listeners('error'))]));
const { app } = require('../server');
let server, base;
test.before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`; });
test.beforeEach(reset);
test.after(async () => {
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  for (const [id, entry] of saved) { if (entry) require.cache[id] = entry; else delete require.cache[id]; }
  for (const [key, value] of env) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  for (const [stream, original] of listeners) for (const listener of stream.listeners('error')) if (!original.has(listener)) stream.removeListener('error', listener);
});
const headers = { 'content-type': 'application/json', cookie: 'tw_sess=synthetic-session; tw_csrf=synthetic-csrf', 'x-csrf': 'synthetic-csrf' };
const post = (route, body, extra = {}) => fetch(base + route, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
const queries = [
  ['/api/test/session', { session_id: 'default', username: 'alice', config_revision: 7 }, 'testSession', ['default', 'alice']],
  ['/api/inspect/tweet', { id: '12345678901234567890123456789012', kind: 'thread', config_revision: 7 }, 'inspectTweet', ['12345678901234567890123456789012', 'thread']],
  ['/api/list/members', { list_id: '123', config_revision: 7 }, 'listMembers', ['123']],
  ['/api/catchup/reset', { source_key: 'alice', config_revision: 7 }, 'resetCatchup', ['alice']],
];

test('config returns stable source keys and credential presence only, while status exposes safe diagnostics', async () => {
  cfg.accounts.push({ source_type: 'list', list_id: '42', fetch_count: 10, check_interval: 30 });
  const result = await fetch(base + '/api/config', { headers }); const text = await result.text(); const body = JSON.parse(text);
  assert.doesNotMatch(text, /synthetic-(default|backup)-(token|csrf)/);
  assert.deepEqual(body.accounts.map((a) => a.source_key), ['alice', 'list:42']);
  assert.deepEqual(body.secrets.x_sessions, { backup: { hasAuthToken: true, hasCt0: true } });
  assert.equal(body.x_sessions[0].label, '备用');
  const status = await (await fetch(base + '/api/status', { headers })).json();
  assert.equal(status.status.diagnostics.sessions.default.lastSuccessAt, 123);
});

test('source, content policy and session updates commit together and deleted session credentials disappear', async () => {
  const reply = await post('/api/config', { config_revision: 7,
    accounts: [{ source_type: 'search', query: ' AI ', filters: { exclude: ['ads'], reposts: false } }],
    media_mode: 'photos', enrichment_mode: 'detail', enrichment_limit: 3,
    x_sessions: [{ id: 'next', label: '新会话', enabled: true, proxy_url: 'http://127.0.0.1:8080' }],
    x_session_secrets: { next: { auth_token: 'synthetic-new-auth', ct0: 'synthetic-new-csrf' } } });
  assert.equal(reply.status, 200); assert.equal(writes.length, 1);
  assert.equal(cfg.accounts[0].query, 'AI'); assert.equal(cfg.media_mode, 'photos');
  assert.equal(secrets.x_sessions.backup, undefined); assert.equal(secrets.x_sessions.next.auth_token, 'synthetic-new-auth');
  assert.equal(secrets.auth_token, 'synthetic-default-token');
  assert.doesNotMatch(await reply.text(), /synthetic/);
});

test('omitted new settings and blank session secrets preserve saved values', async () => {
  const result = await post('/api/config', { config_revision: 7, x_session_secrets: { backup: { auth_token: '' } } });
  assert.equal(result.status, 200); assert.equal(cfg.x_sessions[0].id, 'backup');
  assert.equal(secrets.x_sessions.backup.auth_token, 'synthetic-backup-token');
  assert.equal(secrets.x_sessions.backup.ct0, 'synthetic-backup-csrf');
});

test('removing or replacing a source with current pending messages requires explicit confirmation', async () => {
  pending = { alice: 3 };
  for (const accounts of [[], [{ username: 'alice', timeline_mode: 'replies' }], [{ source_type: 'list', list_id: '42' }]]) {
    const result = await post('/api/config', { config_revision: 7, accounts });
    assert.equal(result.status, 409);
    const body = await result.json();
    assert.equal(body.code, 'PENDING_REMOVAL_REQUIRES_CONFIRMATION');
    assert.deepEqual(body.removed_pending, [{ source_key: 'alice', pendingCount: 3 }]);
    assert.equal(writes.length, 0);
    assert.equal(cfg.accounts[0].username, 'alice');
  }
  const result = await post('/api/config', { config_revision: 7, accounts: [], discard_removed_pending: true });
  assert.equal(result.status, 200); assert.equal(writes.length, 1); assert.deepEqual(cfg.accounts, []);
});

test('unchanged source identity and removals without pending messages do not require confirmation', async () => {
  pending = { alice: 3 };
  const update = await post('/api/config', { config_revision: 7, accounts: [{ username: 'ALICE', fetch_count: 20 }] });
  assert.equal(update.status, 200);
  pending = {};
  const removal = await post('/api/config', { config_revision: cfg.revision, accounts: [] });
  assert.equal(removal.status, 200); assert.equal(writes.length, 2);
});

test('malformed pending-removal confirmation flags cannot authorize dropping messages', async () => {
  pending = { alice: 3 };
  for (const flag of ['true', 1, null, {}, []]) {
    const result = await post('/api/config', { config_revision: 7, accounts: [], discard_removed_pending: flag });
    assert.equal(result.status, 400); assert.equal(writes.length, 0);
  }
});

test('a failed outbox read cannot make a source-removal save appear to have an empty queue', async () => {
  pending = new Error('synthetic storage unavailable');
  const result = await post('/api/config', { config_revision: 7, accounts: [] });
  assert.equal(result.status, 500); assert.equal(writes.length, 0); assert.equal(cfg.accounts[0].username, 'alice');
});

test('invalid source/session/policy updates leave config and credentials entirely unchanged', async () => {
  for (const patch of [{ accounts: [{ source_type: 'list', list_id: 42 }] }, { accounts: [{ source_type: 'search', query: '' }] },
    { media_mode: 'raw' }, { enrichment_limit: 6 }, { x_sessions: [{ id: 'default' }] },
    { x_sessions: [{ id: 'backup', proxy_url: 'http://user:secret@proxy.test:80' }] },
    { x_sessions: [{ id: 'backup', auth_token: 'must-not-be-metadata' }] },
    { x_session_secrets: { missing: { auth_token: 'synthetic' } } },
    { x_session_secrets: { backup: { ct0: 'bad\nheader' } } }]) {
    const result = await post('/api/config', { config_revision: 7, ...patch }); assert.equal(result.status, 400, JSON.stringify(patch));
  }
  assert.equal(writes.length, 0); assert.equal(cfg.revision, 7); assert.equal(secrets.x_sessions.backup.auth_token, 'synthetic-backup-token');
});

test('every new query requires authentication, CSRF, runtime authorization, current revision and strict parameters', async () => {
  for (const [route, body] of queries) {
    assert.equal((await post(route, body, { cookie: '' })).status, 401);
    assert.equal((await post(route, body, { 'x-csrf': '' })).status, 403);
    enabled = false; assert.equal((await post(route, body)).status, 409); enabled = true;
    assert.equal((await post(route, { ...body, config_revision: undefined })).status, 428);
    assert.equal((await post(route, { ...body, config_revision: 6 })).status, 409);
    assert.equal((await post(route, { ...body, arbitrary: 'forbidden' })).status, 400);
    const result = await post(route, body); assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
  }
  assert.deepEqual(calls, queries.map(([, , name, args]) => [name, ...args]));
  assert.equal(writes.length, 0);
});

test('X read-only queries and collector tests share single-flight and withhold results after session revocation', async () => {
  let finish; operation = () => new Promise((resolve) => { finish = resolve; });
  const pending = post(queries[1][0], queries[1][1]);
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await post(queries[0][0], queries[0][1])).status, 429);
  assert.equal((await post('/api/test/collector', { source_key: 'alice' })).status, 429);
  epoch++; finish({ ok: true, tweets: [{ id: '123', text: 'should-be-withheld' }] });
  const result = await pending; assert.equal(result.status, 401); assert.doesNotMatch(await result.text(), /should-be-withheld/);
});

test('query output strips raw response fields, enforces bounds and releases single-flight on errors', async () => {
  operation = async () => ({ ok: true, raw: 'sensitive-raw-body', evidence: [{ path: '/private' }], members: [], complete: true });
  const first = await post(queries[2][0], queries[2][1]); const text = await first.text();
  assert.doesNotMatch(text, /sensitive|private|evidence|raw/); assert.equal(JSON.parse(text).complete, true);
  operation = async () => ({ ok: true, tweets: [{ id: '1', text: 'x'.repeat(2 * 1024 * 1024) }] });
  const large = await post(queries[1][0], queries[1][1]); assert.equal(large.status, 502);
  assert.equal((await large.json()).code, 'OUTPUT_TOO_LARGE');
  operation = async () => { throw new Error('synthetic-provider-internal'); };
  assert.equal((await post(queries[0][0], queries[0][1])).status, 500);
  operation = async () => ({ ok: true });
  assert.equal((await post(queries[0][0], queries[0][1])).status, 200);
});
