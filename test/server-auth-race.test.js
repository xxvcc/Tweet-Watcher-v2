'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');

let epoch = 1;
let verifyPassword = async () => false;
let setPassword = async () => {};
let hashPassword = async () => '$2b$12$' + 'A'.repeat(53);
let savePasswordHash = () => {};
let configWrites = 0;
let savedConfigs = [];
let persistedRevision = 3;
let saveSecrets = () => { configWrites++; };
let stateLogs = [];
let configPersisted = true;
let configRemovals = 0;
const recordConfig = (config) => {
  configWrites++; savedConfigs.push(config);
  if (Number.isSafeInteger(config.revision)) persistedRevision = config.revision;
};
let saveConfig = recordConfig;
const status = { configRevision: 3, accounts: Object.create(null) };

const authMock = {
  hasPassword: () => true,
  verifySession: () => true,
  checkCsrf: () => true,
  verifyPassword: (password) => verifyPassword(password),
  passwordError: () => '',
  setPassword: (...args) => setPassword(...args),
  hashPassword: (...args) => hashPassword(...args),
  savePasswordHash: (...args) => savePasswordHash(...args),
  sessionEpoch: () => epoch,
  bumpEpoch: () => { epoch++; },
  onSessionRevoked: () => () => {},
  makeSession: () => `session-${epoch}`,
  makeCsrf: () => 'csrf-token',
};

const configMock = {
  LIMITS: { MAX_ACCOUNTS: 100 },
  getConfig: () => ({
    tg_chat_id: '1', paused: false, accounts: [],
    revision: persistedRevision, persisted: configPersisted,
  }),
  getSecrets: () => ({ auth_token: '', ct0: '', tg_bot_token: '' }),
  normalizeAccounts: () => [],
  validRevision: (value) => Number.isSafeInteger(value) && value >= 0,
  nextRevision: (value) => value + 1,
  validChatId: (value) => {
    if (value === '') return true;
    if (typeof value === 'number' && !Number.isSafeInteger(value)) return false;
    if (typeof value !== 'string' && typeof value !== 'number') return false;
    return /^-?\d{1,32}$/.test(String(value));
  },
  saveConfig: (...args) => saveConfig(...args),
  saveSecrets: (...args) => saveSecrets(...args),
};

const stateMock = {
  bus: new EventEmitter(),
  log: () => {},
  getStatus: () => status,
  getLogs: (limit) => stateLogs.slice(-limit),
  setStatus: (patch) => Object.assign(status, patch),
};

const moduleMocks = new Map([
  [require.resolve('../lib/auth'), authMock],
  [require.resolve('../lib/config'), configMock],
  [require.resolve('../lib/store'), {
    sweepTmp: () => {},
    removeJSON: () => { configRemovals++; persistedRevision = 0; },
  }],
  [require.resolve('../lib/twscrape'), { detectTwscrape: async () => ({ found: false }) }],
  [require.resolve('../lib/state'), stateMock],
  [require.resolve('../lib/worker'), {
    start: () => {}, setPaused: () => {}, configChanged: (revision) => { status.configRevision = revision; },
    testCollector: async () => ({ ok: true }), testTelegram: async () => ({ ok: true }),
  }],
]);

const savedModules = new Map();
for (const [filename, exports] of moduleMocks) {
  savedModules.set(filename, require.cache[filename]);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
const serverFilename = require.resolve('../server');
const savedServer = require.cache[serverFilename];
delete require.cache[serverFilename];
const { app } = require('../server');

let server;
let base;
let listenUnavailable = false;

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  } catch (e) {
    if (e && e.code === 'EPERM') { listenUnavailable = true; return; }
    throw e;
  }
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server && server.listening) await new Promise((resolve) => server.close(resolve));
  for (const [filename, entry] of savedModules) {
    if (entry) require.cache[filename] = entry;
    else delete require.cache[filename];
  }
  if (savedServer) require.cache[serverFilename] = savedServer;
  else delete require.cache[serverFilename];
});

test('login cannot mint a new-epoch session from a stale password result', { concurrency: false }, async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  let release;
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  verifyPassword = () => {
    startedResolve();
    return new Promise((resolve) => { release = resolve; });
  };

  const pending = fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'correct-password' }),
  });
  await started;
  authMock.bumpEpoch();
  release(true);

  const response = await pending;
  assert.equal(response.status, 409);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('new logins are rejected while a password change is in flight', { concurrency: false }, async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  let release;
  let startedResolve;
  let loginCompareCalls = 0;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  verifyPassword = (password) => {
    if (password === 'old-password') {
      startedResolve();
      return new Promise((resolve) => { release = resolve; });
    }
    loginCompareCalls++;
    return Promise.resolve(true);
  };

  const changing = fetch(`${base}/api/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'tw_sess=x; tw_csrf=y', 'x-csrf': 'y' },
    body: JSON.stringify({ old_password: 'old-password', new_password: 'new-password' }),
  });
  await started;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'old-password' }),
  });
  assert.equal(login.status, 503);
  assert.equal(loginCompareCalls, 0);

  release(false);
  assert.equal((await changing).status, 400);
});

test('global logout cancels an in-flight password change', { concurrency: false }, async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  let release;
  let startedResolve;
  let passwordWrites = 0;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  verifyPassword = () => {
    startedResolve();
    return new Promise((resolve) => { release = resolve; });
  };
  savePasswordHash = () => { passwordWrites++; };

  try {
    const changing = fetch(`${base}/api/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'tw_sess=x; tw_csrf=y', 'x-csrf': 'y' },
      body: JSON.stringify({ old_password: 'old-password', new_password: 'new-password' }),
    });
    await started;
    const logout = await fetch(`${base}/api/logout`, {
      method: 'POST',
      headers: { Cookie: 'tw_sess=x; tw_csrf=y', 'x-csrf': 'y' },
    });
    assert.equal(logout.status, 200);

    release(true);
    const response = await changing;
    assert.equal(response.status, 409);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(passwordWrites, 0);
  } finally {
    savePasswordHash = () => {};
  }
});

test('global logout cancels a password change while the new hash is in flight', { concurrency: false }, async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  let releaseHash;
  let hashStartedResolve;
  let passwordWrites = 0;
  const hashStarted = new Promise((resolve) => { hashStartedResolve = resolve; });
  verifyPassword = async () => true;
  hashPassword = () => {
    hashStartedResolve();
    return new Promise((resolve) => { releaseHash = resolve; });
  };
  savePasswordHash = () => { passwordWrites++; };

  try {
    const changing = fetch(`${base}/api/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'tw_sess=x; tw_csrf=y', 'x-csrf': 'y' },
      body: JSON.stringify({ old_password: 'old-password', new_password: 'new-password' }),
    });
    await hashStarted;
    const logout = await fetch(`${base}/api/logout`, {
      method: 'POST',
      headers: { Cookie: 'tw_sess=x; tw_csrf=y', 'x-csrf': 'y' },
    });
    assert.equal(logout.status, 200);

    releaseHash('$2b$12$' + 'A'.repeat(53));
    const response = await changing;
    assert.equal(response.status, 409);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(passwordWrites, 0);
  } finally {
    hashPassword = async () => '$2b$12$' + 'A'.repeat(53);
    savePasswordHash = () => {};
  }
});

test('SSE log frames carry IDs and resume after Last-Event-ID', { concurrency: false }, async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  stateLogs = [
    { id: 'instance:1', t: '2026-01-01T00:00:01.000Z', msg: 'one' },
    { id: 'instance:2', t: '2026-01-01T00:00:02.000Z', msg: 'two' },
    { id: 'instance:3', t: '2026-01-01T00:00:03.000Z', msg: 'three' },
  ];
  let reader;
  try {
    const response = await fetch(`${base}/api/stream`, {
      headers: { Cookie: 'tw_sess=x', 'Last-Event-ID': 'instance:1' },
    });
    assert.equal(response.status, 200);
    reader = response.body.getReader();
    let body = '';
    while (!body.includes('id: instance:3')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      body += Buffer.from(chunk.value).toString('utf8');
    }
    assert.match(body, /event: status\n/);
    assert.doesNotMatch(body, /id: instance:1\n/);
    assert.match(body, /event: log\nid: instance:2\n/);
    assert.match(body, /event: log\nid: instance:3\n/);
  } finally {
    stateLogs = [];
    if (reader) await reader.cancel();
  }
});

test('a heartbeat left in the future after clock rollback is not reported healthy', { concurrency: false }, async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  const originalNow = Date.now;
  try {
    status.running = true;
    status.lastTickAt = 100000;
    Date.now = () => 50000;
    const response = await fetch(`${base}/api/status`, { headers: { Cookie: 'tw_sess=x' } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).healthy, false);
  } finally {
    Date.now = originalNow;
    delete status.running;
    delete status.lastTickAt;
  }
});

test('stale panel revisions cannot overwrite newer configuration', { concurrency: false }, async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  persistedRevision = 3;
  configWrites = 0;
  const response = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'tw_sess=x; tw_csrf=y', 'x-csrf': 'y' },
    body: JSON.stringify({ config_revision: 2, accounts: [] }),
  });
  assert.equal(response.status, 409);
  assert.equal(configWrites, 0);
});

test('persisted revisions still reject stale panels after runtime state resets', { concurrency: false }, async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  persistedRevision = 7;
  status.configRevision = 0; // 模拟服务重启后旧实现的内存计数归零
  configWrites = 0;
  const response = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'tw_sess=x; tw_csrf=y', 'x-csrf': 'y' },
    body: JSON.stringify({ config_revision: 0, accounts: [] }),
  });
  assert.equal(response.status, 409);
  assert.equal(configWrites, 0);
});

test('negative configuration revisions are rejected as malformed input', { concurrency: false }, async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  persistedRevision = 3;
  configWrites = 0;
  const response = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'tw_sess=x; tw_csrf=y', 'x-csrf': 'y' },
    body: JSON.stringify({ config_revision: -1, accounts: [] }),
  });
  assert.equal(response.status, 400);
  assert.equal(configWrites, 0);
});

test('configuration writes cannot bypass optimistic locking by omitting the revision', { concurrency: false }, async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  persistedRevision = 3;
  configWrites = 0;
  const response = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'tw_sess=x; tw_csrf=y', 'x-csrf': 'y' },
    body: JSON.stringify({ accounts: [] }),
  });
  assert.equal(response.status, 428);
  assert.equal(configWrites, 0);
});

test('secret write failures roll back both config content and its persistent revision', { concurrency: false }, async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  persistedRevision = 3;
  status.configRevision = 3;
  configWrites = 0;
  savedConfigs = [];
  saveSecrets = () => { throw new Error('injected secrets write failure'); };
  try {
    const response = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'tw_sess=x; tw_csrf=y', 'x-csrf': 'y' },
      body: JSON.stringify({ config_revision: 3, tg_chat_id: '-99' }),
    });
    assert.equal(response.status, 500);
    assert.equal(persistedRevision, 3);
    assert.equal(status.configRevision, 3);
    assert.equal(savedConfigs.length, 2);
    assert.equal(savedConfigs[0].revision, 4);
    assert.equal(savedConfigs[1].revision, 3);
  } finally {
    saveSecrets = () => { configWrites++; };
  }
});

test('a failed first secret write restores the absence of config.json', { concurrency: false }, async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  persistedRevision = 0;
  status.configRevision = 0;
  configPersisted = false;
  configRemovals = 0;
  savedConfigs = [];
  saveSecrets = () => { throw new Error('injected first secrets write failure'); };
  try {
    const response = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'tw_sess=x; tw_csrf=y', 'x-csrf': 'y' },
      body: JSON.stringify({ config_revision: 0, accounts: [{ username: 'alice' }] }),
    });
    assert.equal(response.status, 500);
    assert.equal(configRemovals, 1);
    assert.equal(savedConfigs.length, 1);
    assert.equal(persistedRevision, 0);
    assert.equal(status.configRevision, 0);
  } finally {
    configPersisted = true;
    saveSecrets = () => { configWrites++; };
  }
});

test('a failed rollback reports the effective persistent revision without hiding partial commit', { concurrency: false }, async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  persistedRevision = 3;
  status.configRevision = 3;
  configWrites = 0;
  savedConfigs = [];
  let attempts = 0;
  saveConfig = (config) => {
    attempts++;
    if (attempts === 2) throw new Error('injected rollback failure');
    recordConfig(config);
  };
  saveSecrets = () => { throw new Error('injected secrets write failure'); };
  try {
    const response = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'tw_sess=x; tw_csrf=y', 'x-csrf': 'y' },
      body: JSON.stringify({ config_revision: 3, tg_chat_id: '-100' }),
    });
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(body.partial, true);
    assert.equal(persistedRevision, 4);
    assert.equal(status.configRevision, 4);
  } finally {
    saveConfig = recordConfig;
    saveSecrets = () => { configWrites++; };
  }
});

test('unsafe numeric Telegram chat IDs are rejected before string conversion', { concurrency: false }, async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  persistedRevision = 3;
  status.configRevision = 3;
  configWrites = 0;
  savedConfigs = [];
  const response = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'tw_sess=x; tw_csrf=y', 'x-csrf': 'y' },
    body: JSON.stringify({ config_revision: 3, tg_chat_id: Number.MAX_SAFE_INTEGER + 1 }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.tg_chat_id, '1');
  assert.match(body.warnings.join('\n'), /Chat ID/);
  assert.equal(savedConfigs[0].tg_chat_id, '1');
});

test('string Telegram chat IDs retain whitespace normalization', { concurrency: false }, async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  persistedRevision = 3;
  status.configRevision = 3;
  savedConfigs = [];
  const response = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'tw_sess=x; tw_csrf=y', 'x-csrf': 'y' },
    body: JSON.stringify({ config_revision: 3, tg_chat_id: '  -12345  ' }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.tg_chat_id, '-12345');
  assert.deepEqual(body.warnings, []);
  assert.equal(savedConfigs[0].tg_chat_id, '-12345');
});

test('removed collector routes return 404 while the fixed collector endpoint remains available', { concurrency: false }, async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  const options = {
    method: 'POST',
    headers: { Cookie: 'tw_sess=x; tw_csrf=y', 'x-csrf': 'y' },
  };
  for (const route of ['/api/detect-bird', '/api/test/bird']) {
    const response = await fetch(`${base}${route}`, options);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { ok: false, error: '接口不存在' });
  }
  const response = await fetch(`${base}/api/detect-collector`, options);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { found: false });
});

test('configuration API exposes a fixed collector and cannot select an executable', { concurrency: false }, async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  persistedRevision = 3;
  savedConfigs = [];
  const loaded = await fetch(`${base}/api/config`, { headers: { Cookie: 'tw_sess=x' } });
  assert.equal(loaded.status, 200);
  const current = await loaded.json();
  assert.deepEqual(current.collector, { name: 'twscrape', fixed: true });
  assert.equal(Object.hasOwn(current, 'bird_path'), false);

  const saved = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'tw_sess=x; tw_csrf=y', 'x-csrf': 'y' },
    body: JSON.stringify({ config_revision: 3, bird_path: '/untrusted/executable' }),
  });
  assert.equal(saved.status, 200);
  assert.equal(Object.hasOwn(await saved.json(), 'bird_path'), false);
  assert.deepEqual(savedConfigs, [{
    tg_chat_id: '1', paused: false, accounts: [], revision: 4,
  }]);
});
