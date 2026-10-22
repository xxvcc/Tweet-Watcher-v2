'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tweet-watcher-v2-runtime-'));
// Each node:test file has its own process. Do not inherit a developer's live
// mode or data path into this default-policy suite.
delete process.env.TW_RUNTIME_MODE;
process.env.DATA_DIR = path.join(temporary, 'data');
const runtime = require('../lib/runtime');
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

function run(script, extraEnv = {}) {
  return spawnSync(process.execPath, ['-e', script], {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8', timeout: 10000,
  });
}

test('default development policy stays disabled even under NODE_ENV=production', () => {
  assert.equal(runtime.status().mode, 'development');
  assert.equal(runtime.status().collector, 'twscrape');
  assert.equal(runtime.status().collectionEnabled, false);
  assert.equal(runtime.status().deliveryEnabled, false);
  const child = run("console.log(JSON.stringify(require('./lib/runtime').status()))", { NODE_ENV: 'production' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).collectionEnabled, false);
});

test('runtime mode requires an explicit collection and delivery policy', () => {
  const live = run("console.log(JSON.stringify(require('./lib/runtime').status()))", { TW_RUNTIME_MODE: 'legacy-live' });
  assert.equal(live.status, 0, live.stderr);
  assert.equal(JSON.parse(live.stdout).collector, 'bird-legacy');
  assert.equal(JSON.parse(live.stdout).collectionEnabled, true);
  for (const [mode, sends] of [['read-only', false], ['live', true]]) {
    const child = run("console.log(JSON.stringify(require('./lib/runtime').status()))", { TW_RUNTIME_MODE: mode });
    assert.equal(child.status, 0, child.stderr);
    const policy = JSON.parse(child.stdout);
    assert.equal(policy.collector, 'twscrape');
    assert.equal(policy.collectionEnabled, true);
    assert.equal(policy.deliveryEnabled, sends);
    assert.equal(policy.schedulingEnabled, sends);
  }
  for (const mode of ['production', 'twscrape', 'DEVELOPMENT', 'readonly']) {
    const rejected = run("require('./lib/runtime')", { TW_RUNTIME_MODE: mode });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /TW_RUNTIME_MODE/);
  }
});

test('Bird and Telegram exits refuse valid synthetic requests before any external IO', async (t) => {
  let externalCalls = 0;
  t.mock.method(require('node:child_process'), 'execFile', () => { externalCalls++; throw new Error('must not spawn'); });
  t.mock.method(global, 'fetch', async () => { externalCalls++; throw new Error('must not fetch'); });
  const bird = require('../lib/bird');
  const telegram = require('../lib/telegram');
  const fetched = await bird.fetchTweets({
    birdPath: require('../lib/config').BUNDLED_BIRD, username: 'synthetic', count: 1,
    authToken: 'FAKE_AUTH', ct0: 'FAKE_CSRF',
  });
  const sent = await telegram.sendMessage({ botToken: '1:FAKE_BOT', chatId: '1', text: 'synthetic' });
  for (const result of [fetched, sent]) {
    assert.equal(result.ok, false);
    assert.equal(result.disabled, true);
    assert.equal(result.code, 'RUNTIME_DISABLED');
  }
  assert.equal(externalCalls, 0);
  const { fetchTimeline } = await import('../lib/bird-timeline.mjs');
  await assert.rejects(fetchTimeline({
    getUserIdByUsername() { externalCalls++; throw new Error('must not resolve account'); },
  }, { username: 'synthetic', count: 1 }), { code: 'RUNTIME_DISABLED' });
  assert.equal(externalCalls, 0);
});

test('worker start, ticks and manual tests do not read configuration or alter delivery state when disabled', async (t) => {
  const cfg = require('../lib/config');
  let reads = 0;
  t.mock.method(cfg, 'getConfig', () => { reads++; throw new Error('must not read configuration'); });
  t.mock.method(cfg, 'getSecrets', () => { reads++; throw new Error('must not read secrets'); });
  const worker = require('../lib/worker');
  const state = require('../lib/state');
  t.mock.method(state, 'log', () => {});
  worker.start();
  await worker.tick();
  assert.equal((await worker.testBird('synthetic')).disabled, true);
  assert.equal((await worker.testTelegram()).disabled, true);
  assert.equal(state.getStatus().running, false);
  assert.equal(reads, 0);
  assert.equal(fs.existsSync(process.env.DATA_DIR), false);
});

test('direct bundled Bird runner also fails closed in development mode', () => {
  const child = spawnSync(process.execPath, ['bin/bird', 'synthetic', '1'], {
    cwd: root, env: { ...process.env, AUTH_TOKEN: 'FAKE_AUTH', CT0: 'FAKE_CSRF' },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, '');
  assert.match(child.stderr, /开发模式/);
  assert.doesNotMatch(child.stderr, /FAKE_AUTH|FAKE_CSRF/);
});

test('authenticated manual APIs and resume keep the development boundary visible', async (t) => {
  const auth = require('../lib/auth');
  for (const name of ['hasPassword', 'verifySession', 'checkCsrf']) t.mock.method(auth, name, () => true);
  const cfg = require('../lib/config');
  t.mock.method(cfg, 'getConfig', () => ({ paused: false, accounts: [], revision: 0 }));
  t.mock.method(cfg, 'saveConfig', () => {});
  const worker = require('../lib/worker');
  let calls = 0;
  for (const name of ['testCollector', 'testBird', 'testTelegram']) t.mock.method(worker, name, async () => { calls++; });
  t.mock.method(require('../lib/state'), 'log', () => {});
  const { app } = require('../server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const endpoint of ['collector', 'bird', 'telegram']) {
      const response = await fetch(`${base}/api/test/${endpoint}`, { method: 'POST' });
      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(body.disabled, true);
      assert.match(body.error, /开发模式/);
    }
    const response = await fetch(`${base}/api/control`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'resume' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).runtime.collectionEnabled, false);
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.runtime.deliveryEnabled, false);
    assert.equal(status.healthy, false);
    assert.equal(calls, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('read-only blocks Telegram and every direct legacy Bird exit before IO', () => {
  const child = run(`
    const assert = require('node:assert/strict');
    require('node:child_process').execFile = () => { throw new Error('unexpected subprocess'); };
    global.fetch = () => { throw new Error('unexpected network'); };
    (async () => {
      const telegram = await require('./lib/telegram').sendMessage({ botToken: '1:FAKE', chatId: '1', text: 'test' });
      const bird = await require('./lib/bird').fetchTweets({ birdPath: require('./lib/config').BUNDLED_BIRD,
        username: 'alice', count: 1, authToken: 'FAKE_AUTH', ct0: 'FAKE_CSRF' });
      for (const result of [telegram, bird]) assert.equal(result.code, 'RUNTIME_DISABLED');
      const { fetchTimeline } = await import('./lib/bird-timeline.mjs');
      await assert.rejects(fetchTimeline({}, { username: 'alice', count: 1 }), { code: 'RUNTIME_DISABLED' });
      console.log('blocked');
    })().catch(() => { process.exitCode = 1; });
  `, { TW_RUNTIME_MODE: 'read-only' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'blocked');
});

test('read-only API permits manual collection while refusing delivery and exposing disabled scheduling', async (t) => {
  const policy = { mode: 'read-only', collector: 'twscrape', collectionEnabled: true, deliveryEnabled: false, schedulingEnabled: false };
  t.mock.method(runtime, 'status', () => policy);
  t.mock.method(runtime, 'blocked', (operation) => operation === 'collection' ? null
    : { ok: false, disabled: true, code: 'RUNTIME_DISABLED', message: '只读模式', error: '只读模式' });
  const auth = require('../lib/auth');
  for (const name of ['hasPassword', 'verifySession', 'checkCsrf']) t.mock.method(auth, name, () => true);
  const cfg = require('../lib/config');
  t.mock.method(cfg, 'getConfig', () => ({ paused: false, accounts: [], revision: 0 }));
  const worker = require('../lib/worker');
  let collections = 0;
  let deliveries = 0;
  t.mock.method(worker, 'testCollector', async () => { collections++; return { ok: true, collector: 'twscrape' }; });
  t.mock.method(worker, 'testTelegram', async () => { deliveries++; throw new Error('must not send'); });
  const server = require('../server').app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const endpoint of ['collector', 'bird']) {
      const response = await fetch(`${base}/api/test/${endpoint}`, { method: 'POST' });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).collector, 'twscrape');
    }
    const rejected = await fetch(`${base}/api/test/telegram`, { method: 'POST' });
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).code, 'RUNTIME_DISABLED');
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.runtime.schedulingEnabled, false);
    assert.equal(collections, 2);
    assert.equal(deliveries, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
