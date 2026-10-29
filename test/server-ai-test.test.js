'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');

const savedConfig = { revision: 7, ai_translation_enabled: false,
  ai_base_url: 'https://saved.example.test/v1', ai_model: 'saved-model',
  accounts: [{ username: 'alice', fetch_count: 10, check_interval: 30 }], tg_chat_id: '1', paused: false };
const savedSecrets = { ai_api_key: 'synthetic-saved-key', auth_token: 'synthetic-auth',
  ct0: 'synthetic-ct0', tg_bot_token: 'synthetic-telegram' };
let cfg, secrets, mode, epoch, sessionValid, writes, workerCalls, calls, connection;
const reset = () => {
  cfg = structuredClone(savedConfig); secrets = structuredClone(savedSecrets);
  mode = 'live'; epoch = 1; sessionValid = true; writes = 0; workerCalls = 0; calls = [];
  connection = async () => ({ ok: true, reply: 'Hello!', elapsedMs: 3 });
};
reset();
const state = { bus: new EventEmitter(), log() {}, getStatus: () => ({}), setStatus() {}, getLogs: () => [] };
const modules = new Map([
  ['../lib/config', { getConfig: () => cfg, getSecrets: () => secrets,
    validRevision: (n) => Number.isSafeInteger(n) && n >= 0,
    saveSettings() { writes++; }, saveConfig() { writes++; } }],
  ['../lib/auth', { hasPassword: () => true, sessionEpoch: () => epoch,
    verifySession: (cookie) => sessionValid && cookie === 'synthetic-session',
    checkCsrf: (cookie, header) => cookie === 'synthetic-csrf' && header === cookie,
    bumpEpoch() { epoch++; }, onSessionRevoked: () => () => {} }],
  ['../lib/translation', { testConnection: async (...args) => { calls.push(structuredClone(args)); return connection(...args); } }],
  ['../lib/runtime', { status: () => ({ mode }), blocked: () => mode === 'live' ? null : { ok: false } }],
  ['../lib/worker', { start() { workerCalls++; }, configChanged() { workerCalls++; },
    setPaused() { workerCalls++; }, testTelegram() { workerCalls++; }, testCollector() { workerCalls++; } }],
  ['../lib/store', {}], ['../lib/twscrape', {}], ['../lib/state', state],
]);
const savedModules = new Map();
for (const [name, value] of modules) {
  const filename = require.resolve(name);
  savedModules.set(filename, require.cache[filename]);
  require.cache[filename] = { id: filename, filename, loaded: true, exports: value };
}
const env = new Map(['PUBLIC_ORIGIN', 'TRUST_PROXY_TOKEN'].map((name) => [name, process.env[name]]));
for (const name of env.keys()) delete process.env[name];
const filename = require.resolve('../server');
savedModules.set(filename, require.cache[filename]);
delete require.cache[filename];
const existingListeners = new Map([process.stdout, process.stderr].map((stream) => [stream, new Set(stream.listeners('error'))]));
const { app } = require('../server');
let server, base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(reset);
test.after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  for (const [file, entry] of savedModules) {
    if (entry) require.cache[file] = entry;
    else delete require.cache[file];
  }
  for (const [name, value] of env) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const [stream, original] of existingListeners) {
    for (const listener of stream.listeners('error')) if (!original.has(listener)) stream.removeListener('error', listener);
  }
});

const draft = (patch = {}) => ({ config_revision: 7, ai_base_url: savedConfig.ai_base_url,
  ai_model: 'unsaved-model', ...patch });
const headers = { 'content-type': 'application/json',
  cookie: 'tw_sess=synthetic-session; tw_csrf=synthetic-csrf', 'x-csrf': 'synthetic-csrf' };
const post = (body = draft(), extraHeaders = {}) => fetch(`${base}/api/test/ai`, {
  method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body),
});
function assertUnchanged() {
  assert.equal(writes, 0); assert.equal(workerCalls, 0);
  assert.deepEqual(cfg, savedConfig); assert.deepEqual(secrets, savedSecrets);
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('AI endpoint requires session, CSRF and live mode before accessing the provider', async () => {
  assert.equal((await post(draft(), { cookie: '' })).status, 401);
  assert.equal((await post(draft(), { 'x-csrf': '' })).status, 403);
  for (const blockedMode of ['development', 'read-only']) {
    mode = blockedMode;
    const response = await post();
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'RUNTIME_DISABLED');
  }
  assert.equal(calls.length, 0);
  assertUnchanged();
});

test('AI test requires the current configuration revision before stored-key reuse', async () => {
  for (const [revision, status, code] of [[undefined, 428, 'REVISION_REQUIRED'],
    ['7', 400, 'INVALID_REVISION'], [-1, 400, 'INVALID_REVISION'], [6, 409, 'CONFIG_CHANGED']]) {
    const response = await post(draft({ config_revision: revision }));
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, code);
  }
  assert.equal(calls.length, 0);
  assertUnchanged();
});

test('AI test uses unsaved fields with the saved endpoint key without enabling or saving translation', async () => {
  const response = await post(draft({ ai_api_key: '' }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { ok: true, reply: 'Hello!', elapsedMs: 3 });
  assert.deepEqual(calls, [[{ ai_base_url: savedConfig.ai_base_url, ai_model: 'unsaved-model' },
    { ai_api_key: 'synthetic-saved-key' }]]);
  assertUnchanged();
});

test('AI test allows a draft provider only with its own explicitly supplied key', async () => {
  for (const url of ['https://other.example.test/v1', savedConfig.ai_base_url + '/']) {
    const response = await post(draft({ ai_base_url: url }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'KEY_REQUIRED');
  }
  assert.equal(calls.length, 0);
  const response = await post(draft({ ai_base_url: 'https://other.example.test/v1', ai_api_key: 'synthetic-draft-key' }));
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0], [{ ai_base_url: 'https://other.example.test/v1', ai_model: 'unsaved-model' },
    { ai_api_key: 'synthetic-draft-key' }]);
  assert.doesNotMatch(await response.text(), /synthetic-(draft|saved)-key/);
  assertUnchanged();
});

test('AI test rejects malformed fields, deletion conflicts and requests without a usable key', async () => {
  const bad = [[], null, draft({ message: 'not hi' }), draft({ ai_translation_enabled: true }),
    draft({ ai_model: null }), draft({ ai_model: '' }), draft({ ai_model: 'model\nheader' }),
    draft({ ai_base_url: 'http://other.test/v1' }), draft({ ai_base_url: 'https://user:pass@other.test/v1' }),
    draft({ ai_base_url: 'https://other.test/v1?key=private' }), draft({ clear_ai_api_key: 'true' }),
    draft({ clear_ai_api_key: true }), draft({ clear_ai_api_key: true, ai_api_key: 'synthetic-draft-key' })];
  for (const key of [null, 1, {}, 'bad\nkey', 'bad key', ' key ', '\ud800', 'x'.repeat(4097)]) bad.push(draft({ ai_api_key: key }));
  for (const body of bad) {
    const response = await post(body);
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /synthetic-(draft|saved)-key|user:pass/);
  }
  assert.equal(calls.length, 0);
  assertUnchanged();
  secrets.ai_api_key = '';
  assert.equal((await post()).status, 400);
  assert.equal(calls.length, 0);
});

test('AI endpoint single-flight rejects overlaps and releases after provider failure', async () => {
  const started = deferred(), release = deferred();
  connection = async () => { started.resolve(); return release.promise; };
  const first = post();
  await started.promise;
  const overlapping = await post();
  assert.equal(overlapping.status, 429);
  assert.equal((await overlapping.json()).code, 'TEST_IN_PROGRESS');
  assert.equal(calls.length, 1);
  release.resolve({ ok: false, code: 'TIMEOUT', message: 'AI 测试超时' });
  assert.equal((await (await first).json()).code, 'TIMEOUT');
  connection = async () => ({ ok: true, reply: 'Hello again', elapsedMs: 4 });
  assert.equal((await (await post()).json()).reply, 'Hello again');
  assert.equal(calls.length, 2);
  assertUnchanged();
});

for (const revocation of ['epoch', 'expired-session']) {
  test(`AI result is withheld after ${revocation} changes during the provider request`, async () => {
    const started = deferred(), release = deferred();
    connection = async () => { started.resolve(); return release.promise; };
    const first = post();
    await started.promise;
    if (revocation === 'epoch') epoch++;
    else sessionValid = false;
    release.resolve({ ok: true, reply: 'private reply', elapsedMs: 4 });
    const response = await first;
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.code, 'AUTH_CHANGED');
    assert.doesNotMatch(JSON.stringify(body), /private reply/);
    assertUnchanged();
  });
}
