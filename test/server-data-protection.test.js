'use strict';

// Exercise the real configuration, filesystem, outbox and worker together. Only
// synthetic credentials enter temporary private directories; every external
// module is replaced before server/worker loading.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const account = { username: 'alice', fetch_count: 10, check_interval: 30 };
const syntheticSecrets = { auth_token: 'synthetic-auth', ct0: 'synthetic-ct0',
  tg_bot_token: 'synthetic-bot', ai_api_key: 'synthetic-ai' };
const timeline = { ok: true,
  tweets: [{ id: '1', text: 'Older post', author_username: 'alice' },
    { id: '2', text: 'This is the new model.', author_username: 'alice', lang: 'en' }],
  coverage: { complete: true, reachedSince: true, exhausted: false, newestId: '2' } };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function instance(t, { paused = true, collector, translation } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-v2-protection-'));
  const listeners = new Map([process.stdout, process.stderr]
    .map((stream) => [stream, new Set(stream.listeners('error'))]));
  const envNames = ['DATA_DIR', 'TW_RUNTIME_MODE', 'PUBLIC_ORIGIN', 'TRUST_PROXY_TOKEN'];
  const oldEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  process.env.DATA_DIR = dir;
  process.env.TW_RUNTIME_MODE = 'live';
  delete process.env.PUBLIC_ORIGIN;
  delete process.env.TRUST_PROXY_TOKEN;
  const moduleNames = ['../server', '../lib/store', '../lib/config', '../lib/auth', '../lib/state',
    '../lib/worker', '../lib/runtime', '../lib/twscrape', '../lib/translation', '../lib/telegram'];
  const modules = new Map(moduleNames.map((name) => {
    const file = require.resolve(name);
    return [file, require.cache[file]];
  }));
  for (const file of modules.keys()) delete require.cache[file];
  const calls = { collections: 0, translations: 0, sends: 0 };
  const inject = (name, value) => {
    const file = require.resolve(name);
    require.cache[file] = { id: file, filename: file, loaded: true, exports: value };
  };
  inject('../lib/twscrape', { async fetchTweets() {
    calls.collections++;
    if (!collector) throw new Error('unexpected synthetic collection');
    return collector();
  } });
  inject('../lib/translation', { async translateTweet() {
    calls.translations++;
    if (!translation) throw new Error('unexpected synthetic translation');
    return translation();
  } });
  inject('../lib/telegram', { formatTweet: () => 'synthetic message', async sendMessage() {
    calls.sends++;
    return { ok: true };
  } });
  t.mock.method(require('node:child_process'), 'spawn', () => { throw new Error('external process forbidden'); });
  t.mock.method(require('node:https'), 'request', () => { throw new Error('external HTTPS forbidden'); });
  const store = require('../lib/store');
  const config = require('../lib/config');
  config.saveSettings({ accounts: [account], tg_chat_id: '1', paused, revision: 1,
    ai_translation_enabled: true, ai_base_url: 'https://synthetic.invalid/v1', ai_model: 'synthetic' }, syntheticSecrets);
  store.writeJSON('password.json', { hash: '$2b$12$' + 'A'.repeat(53), input_policy: 'utf8-72-v1' });
  const state = require('../lib/state');
  t.mock.method(state, 'log', () => {});
  const box = require('../lib/outbox').createOutbox(store, 200);
  box.baseline('alice', ['1'], '1');
  const auth = require('../lib/auth');
  const cookie = `tw_sess=${auth.makeSession()}; tw_csrf=synthetic-csrf`;
  const { app } = require('../server');
  const worker = require('../lib/worker');
  t.after(() => {
    for (const [stream, existing] of listeners) {
      for (const listener of stream.listeners('error')) {
        if (!existing.has(listener)) stream.removeListener('error', listener);
      }
    }
    for (const [file, entry] of modules) {
      if (entry) require.cache[file] = entry;
      else delete require.cache[file];
    }
    for (const [name, value] of oldEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const handler = (route, method = 'post') => app._router.stack
    .find((layer) => layer.route?.path === route && layer.route.methods[method]).route.stack.at(-1).handle;
  function invoke(route, body, method) {
    const response = { statusCode: 200, body: null,
      status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    handler(route, method)({ body }, response);
    return response;
  }
  return { dir, calls, app, box, config, store, worker, state, cookie, invoke };
}

test('invalid account saves preserve paused pending messages and every existing setting', async (t) => {
  const h = instance(t);
  h.box.capture('alice', [{ id: '2', text: 'Durable pending message' }], 'a'.repeat(64), null);
  const beforeConfig = h.store.readState('config.json').value;
  const beforeSecrets = h.store.readState('secrets.json').value;
  const beforeQueue = h.store.readState('delivery_state.json').value;
  const server = h.app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  try {
    for (const accounts of [
      [{ ...account, username: 'alice!' }], [account, null], [account, { username: 123 }],
      [account, 'ALICE'], 'alice', null,
      Array.from({ length: 101 }, (_, i) => ({ ...account, username: `user_${i}` })),
    ]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/config`, {
        method: 'POST', headers: { cookie: h.cookie, 'x-csrf': 'synthetic-csrf', 'content-type': 'application/json' },
        body: JSON.stringify({ config_revision: 1, accounts, tg_chat_id: '2', tg_bot_token: 'replacement-synthetic' }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).ok, false);
      await h.worker.tick();
      assert.deepEqual(h.store.readState('config.json').value, beforeConfig);
      assert.deepEqual(h.store.readState('secrets.json').value, beforeSecrets);
      assert.deepEqual(h.store.readState('delivery_state.json').value, beforeQueue);
      assert.equal(h.store.readState('config_transaction.json').status, 'missing');
    }
    assert.deepEqual(h.calls, { collections: 0, translations: 0, sends: 0 });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

for (const stage of ['collection', 'translation']) {
  for (const failure of ['rename', 'directory-fsync']) {
    test(`failed pause during ${stage} remains stopped after ${failure} failure and later ticks`, async (t) => {
      const started = deferred();
      const release = deferred();
      const h = instance(t, { paused: false,
        async collector() {
          if (stage === 'collection') { started.resolve(); await release.promise; }
          return timeline;
        },
        async translation() {
          if (stage === 'translation') { started.resolve(); await release.promise; }
          return { ok: true, text: '这是新模型。' };
        } });
      const tick = h.worker.tick();
      await started.promise;
      let injected = false;
      const method = failure === 'rename' ? 'renameSync' : 'fsyncSync';
      const original = fs[method];
      const mock = t.mock.method(fs, method, (...args) => {
        const matches = failure === 'rename' ? args[1] === path.join(h.dir, 'config.json')
          : fs.fstatSync(args[0]).isDirectory();
        if (!injected && matches) {
          injected = true;
          throw Object.assign(new Error('synthetic storage failure'), { code: 'EIO' });
        }
        return original(...args);
      });
      const response = h.invoke('/api/control', { action: 'pause' });
      mock.mock.restore();
      release.resolve();
      await tick;
      assert.equal(injected, true);
      assert.equal(response.statusCode, 500);
      assert.equal(response.body.paused, true);
      assert.equal(response.body.controlPending, true);
      assert.equal(h.config.getConfig().paused, failure === 'directory-fsync', 'rename may already have published the pause');
      const queue = h.store.readState('delivery_state.json').value.accounts.alice;
      assert.equal(queue.pending.length, stage === 'translation' ? 1 : 0);
      assert.equal(queue.acquisitionWatermark, stage === 'translation' ? '2' : '1');
      const calls = { ...h.calls };
      await h.worker.tick();
      await h.worker.tick();
      assert.deepEqual(h.calls, calls, 'disk recovery alone must not restart collection or delivery');
      assert.equal(h.calls.sends, 0);
      const status = h.invoke('/api/status', undefined, 'get').body;
      assert.equal(status.paused, true);
      assert.equal(status.status.controlPending, true);
      assert.equal(status.healthy, false);
    });
  }
}

test('control read failures hold the worker until an explicit successful config or control save', async (t) => {
  const h = instance(t, { paused: false, collector: async () => timeline,
    translation: async () => ({ ok: true, text: '这是新模型。' }) });
  const originalGet = h.config.getConfig;
  const failRead = () => { throw new Error('synthetic unavailable configuration'); };
  for (const recovery of ['pause', 'resume', 'config']) {
    h.config.getConfig = failRead;
    const failed = h.invoke('/api/control', { action: 'pause' });
    h.config.getConfig = originalGet;
    assert.equal(failed.statusCode, 500);
    await h.worker.tick();
    assert.equal(h.calls.collections, 0);
    assert.equal(h.state.getStatus().controlPending, true);
    const originalWrite = h.store.writeJSON;
    h.store.writeJSON = () => { throw new Error('synthetic configuration commit failure'); };
    try {
      const failedConfig = h.invoke('/api/config', { config_revision: h.config.getConfig().revision });
      assert.equal(failedConfig.statusCode, 500);
      assert.equal(h.state.getStatus().controlPending, true, 'a failed config save cannot clear the hold');
    } finally { h.store.writeJSON = originalWrite; }
    if (recovery === 'config') {
      const saved = h.invoke('/api/config', { config_revision: h.config.getConfig().revision });
      assert.equal(saved.statusCode, 200);
    } else {
      const saved = h.invoke('/api/control', { action: recovery });
      assert.equal(saved.statusCode, 200);
    }
    assert.equal(h.state.getStatus().controlPending, false);
    assert.equal(h.state.getStatus().paused, recovery === 'pause');
  }
  assert.deepEqual(h.calls, { collections: 0, translations: 0, sends: 0 });
  await h.worker.tick();
  assert.deepEqual(h.calls, { collections: 1, translations: 1, sends: 1 });
  assert.equal(h.store.readState('delivery_state.json').value.accounts.alice.pending.length, 0);
});

test('failed resume also remains held and unknown controls cannot release the hold', async (t) => {
  const h = instance(t);
  const originalSave = h.config.saveConfig;
  h.config.saveConfig = () => { throw new Error('synthetic save failure'); };
  try {
    const response = h.invoke('/api/control', { action: 'resume' });
    assert.equal(response.statusCode, 500);
    assert.equal(response.body.paused, true);
  } finally { h.config.saveConfig = originalSave; }
  assert.equal(h.invoke('/api/control', { action: 'unknown' }).statusCode, 400);
  await h.worker.tick();
  assert.equal(h.state.getStatus().controlPending, true);
  assert.equal(h.state.getStatus().paused, true);
  assert.deepEqual(h.calls, { collections: 0, translations: 0, sends: 0 });
});
