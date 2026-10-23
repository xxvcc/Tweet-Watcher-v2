'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const http = require('node:http');
const origin = 'https://watcher.example.test';
const proxyToken = 'synthetic-proxy-token-for-tests-only';
process.env.PUBLIC_ORIGIN = origin;
process.env.TRUST_PROXY_TOKEN = proxyToken;
const records = {
  'session_secret.json': { key: 'b'.repeat(64), epoch: 1 },
  'password.json': { hash: 'synthetic-password-record' },
};
function inject(name, exports) {
  const filename = require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
inject('../lib/store', {
  readState: (name) => Object.hasOwn(records, name) ? { status: 'ok', value: records[name] } : { status: 'missing' },
  readJSON: (name, fallback) => records[name] ?? fallback,
  writeJSON: (name, value) => { records[name] = value; },
});
inject('../lib/state', { bus: new EventEmitter(), getStatus: () => ({ running: true }), getLogs: () => [], log: () => {} });
inject('../lib/config', { getConfig: () => ({ paused: false, accounts: [] }) });
inject('../lib/twscrape', {});
inject('../lib/worker', {});
const auth = require('../lib/auth');
auth.verifyPassword = async () => true;
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
function headers(extra = {}) {
  return {
    host: 'watcher.example.test', origin, 'x-tweet-watcher-proxy-token': proxyToken,
    'x-forwarded-proto': 'https', ...extra,
  };
}
// Node fetch rewrites Host to the URL host; use a raw HTTP client to exercise
// a reverse proxy's canonical Host while keeping every connection on loopback.
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      res.resume();
      res.once('end', () => resolve({
        status: res.statusCode,
        headers: {
          get: (name) => res.headers[name] ?? null,
          getSetCookie: () => res.headers['set-cookie'] || [],
        },
      }));
    });
    req.once('error', reject);
    req.end(options.body);
  });
}

test('configured HTTPS origin requires canonical Host and authenticated TLS forwarding', async () => {
  const accepted = await request(`${base}/api/session`, { headers: headers() });
  assert.equal(accepted.status, 200);
  for (const [extra, expected] of [
    [{ host: 'example.test' }, 421],
    [{ host: 'example.test', 'x-forwarded-host': 'watcher.example.test' }, 421],
    [{ 'x-tweet-watcher-proxy-token': 'wrong-token' }, 403],
    [{ 'x-forwarded-proto': 'http' }, 403],
  ]) {
    const response = await request(`${base}/api/session`, { headers: headers(extra) });
    assert.equal(response.status, expected);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('unsafe requests reject same-site sibling origins, opaque origins and absent Origin', async () => {
  for (const requestOrigin of ['https://example.test', 'https://evil.example.test', 'null', 'https://watcher.example.test.evil.example', '']) {
    const requestHeaders = headers({ origin: requestOrigin });
    if (!requestOrigin) delete requestHeaders.origin;
    for (const endpoint of ['/api/login', '/api/setup', '/api/logout']) {
      const response = await request(`${base}${endpoint}`, { method: 'POST', headers: requestHeaders });
      assert.equal(response.status, 403, `${endpoint} must reject origin ${requestOrigin || '(absent)'}`);
      assert.equal(response.headers.get('set-cookie'), null);
    }
  }
});

test('login issues host-prefixed Secure cookies without Domain and clears legacy names', async () => {
  const response = await request(`${base}/api/login`, {
    method: 'POST', headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ password: 'synthetic-valid-password' }),
  });
  assert.equal(response.status, 200);
  const cookies = response.headers.getSetCookie();
  const session = cookies.find((line) => line.startsWith('__Host-tw_sess='));
  const csrf = cookies.find((line) => line.startsWith('__Host-tw_csrf='));
  for (const cookie of [session, csrf]) {
    assert.ok(cookie);
    assert.match(cookie, /; Path=\//);
    assert.match(cookie, /; Secure/);
    assert.doesNotMatch(cookie, /; Domain=/i);
  }
  assert.match(session, /; HttpOnly/);
  assert.doesNotMatch(csrf, /; HttpOnly/);
  assert.ok(cookies.some((line) => line.startsWith('tw_sess=;')));
  assert.ok(cookies.some((line) => line.startsWith('tw_csrf=;')));
  const cookie = `${session.split(';')[0]}; ${csrf.split(';')[0]}`;
  const status = await request(`${base}/api/status`, { headers: headers({ cookie }) });
  assert.equal(status.status, 200);
  const logout = await request(`${base}/api/logout`, {
    method: 'POST', headers: headers({ cookie, 'x-csrf': csrf.split(';')[0].split('=')[1] }),
  });
  assert.equal(logout.status, 200);
  assert.ok(logout.headers.getSetCookie().some((line) => line.startsWith('__Host-tw_sess=;') && line.includes('; Secure')));
  assert.equal((await request(`${base}/api/status`, { headers: headers({ cookie }) })).status, 401);
});

test('old-origin cookies cannot authenticate using either legacy or new cookie names', async () => {
  const legacyToken = auth.makeSession();
  const newToken = auth.makeSession(origin);
  for (const cookie of [`tw_sess=${legacyToken}`, `__Host-tw_sess=${legacyToken}`, `tw_sess=${newToken}`]) {
    const response = await request(`${base}/api/status`, { headers: headers({ cookie }) });
    assert.equal(response.status, 401);
  }
  const response = await request(`${base}/api/status`, { headers: headers({ cookie: `__Host-tw_sess=${newToken}` }) });
  assert.equal(response.status, 200);
});
