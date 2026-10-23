'use strict';

// Exercise real session signing and revocation with isolated in-memory storage.
// No production credentials, workers, Telegram requests or X requests are used.
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const crypto = require('node:crypto');
const records = {
  'session_secret.json': { key: 'a'.repeat(64), epoch: 1 },
  'password.json': { hash: 'synthetic-password-record' },
};
let failPasswordRead = false;
function inject(name, exports) {
  const filename = require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
inject('../lib/store', {
  readState: (name) => {
    if (failPasswordRead && name === 'password.json') throw new Error('synthetic storage failure');
    return Object.hasOwn(records, name) ? { status: 'ok', value: records[name] } : { status: 'missing' };
  },
  readJSON: (name, fallback) => records[name] ?? fallback,
  writeJSON: (name, value) => { records[name] = value; },
});
const bus = new EventEmitter();
inject('../lib/state', { bus, getStatus: () => ({ running: true }), getLogs: () => [], log: () => {} });
inject('../lib/config', { getConfig: () => ({ paused: false, accounts: [] }) });
inject('../lib/twscrape', {});
inject('../lib/worker', {});
const auth = require('../lib/auth');
const { app } = require('../server');
let server;
let base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

async function openStream() {
  const cookie = `tw_sess=${auth.makeSession()}; tw_csrf=synthetic-csrf`;
  const response = await fetch(`${base}/api/stream`, { headers: { cookie }, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const initial = await reader.read();
  assert.match(Buffer.from(initial.value).toString(), /event: status/);
  assert.equal(bus.listenerCount('log'), 1);
  return { cookie, reader };
}
async function assertClosed(reader) {
  assert.equal(bus.listenerCount('log'), 0);
  assert.equal(bus.listenerCount('status'), 0);
  const frame = await reader.read();
  assert.equal(frame.done, true, 'invalidated stream must close without sending a new frame');
}

test('legacy session payloads without an origin field remain valid before the domain cutover', async () => {
  const meta = records['session_secret.json'];
  const payload = Buffer.from(JSON.stringify({ a: 1, iat: Date.now(), e: meta.epoch })).toString('base64url');
  const signature = crypto.createHmac('sha256', meta.key).update(payload).digest('base64url');
  const cookie = `tw_sess=${payload}.${signature}; tw_csrf=synthetic-csrf`;
  const response = await fetch(`${base}/api/status`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.equal(auth.verifySession(`${payload}.${signature}`, 'https://watcher.example.test'), false);
});

test('logout closes an established SSE stream before any later log or status event', async () => {
  const { cookie, reader } = await openStream();
  const logout = await fetch(`${base}/api/logout`, {
    method: 'POST', headers: { cookie, 'x-csrf': 'synthetic-csrf' },
  });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(`${base}/api/status`, { headers: { cookie } })).status, 401);
  bus.emit('log', { id: 'synthetic:1', msg: 'POST_REVOCATION_LOG' });
  bus.emit('status', { marker: 'POST_REVOCATION_STATUS' });
  await assertClosed(reader);
});

test('password change closes old SSE streams and issues a working replacement session', async () => {
  const { cookie, reader } = await openStream();
  const originalVerify = auth.verifyPassword;
  const originalHash = auth.hashPassword;
  try {
    auth.verifyPassword = async () => true;
    auth.hashPassword = async () => '$2b$12$' + 'A'.repeat(53);
    const changed = await fetch(`${base}/api/password`, {
      method: 'POST', headers: { cookie, 'x-csrf': 'synthetic-csrf', 'content-type': 'application/json' },
      body: JSON.stringify({ old_password: 'old-password', new_password: 'new-password' }),
    });
    assert.equal(changed.status, 200);
    const sessionCookie = changed.headers.getSetCookie().find((line) => line.startsWith('tw_sess='));
    assert.equal((await fetch(`${base}/api/status`, { headers: { cookie: sessionCookie.split(';')[0] } })).status, 200);
    await assertClosed(reader);
  } finally {
    auth.verifyPassword = originalVerify;
    auth.hashPassword = originalHash;
  }
});

test('expired SSE session cannot receive events before the next heartbeat', async () => {
  const { reader } = await openStream();
  const originalNow = Date.now;
  const expired = originalNow() + 7 * 24 * 3600 * 1000;
  try {
    Date.now = () => expired;
    bus.emit('log', { id: 'synthetic:2', msg: 'AFTER_EXPIRY' });
  } finally { Date.now = originalNow; }
  await assertClosed(reader);
});

test('password removal closes SSE before a reset/setup log can be delivered', async () => {
  const { reader } = await openStream();
  const password = records['password.json'];
  try {
    delete records['password.json'];
    bus.emit('log', { id: 'synthetic:3', msg: 'SYNTHETIC_SETUP_TOKEN' });
    await assertClosed(reader);
  } finally { records['password.json'] = password; }
});

test('storage failure during an SSE event closes the stream without throwing into the worker', async () => {
  const { reader } = await openStream();
  try {
    failPasswordRead = true;
    assert.doesNotThrow(() => bus.emit('status', { marker: 'UNREADABLE_AUTH_STATE' }));
    await assertClosed(reader);
  } finally { failPasswordRead = false; }
});
