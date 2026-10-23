'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { app, requestOrigin, parsePublicOrigin } = require('../server');

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
});

test('forwarded client identity requires both loopback transport and the private proxy token', () => {
  const token = 'p'.repeat(32);
  const request = {
    socket: { remoteAddress: '127.0.0.1', encrypted: false },
    headers: {
      'x-tweet-watcher-proxy-token': 'wrong-token',
      'x-forwarded-for': '198.51.100.7, 203.0.113.9',
      'x-forwarded-proto': 'https',
    },
  };
  assert.deepEqual(requestOrigin(request, token), {
    clientIp: '127.0.0.1', secure: false, trustedProxy: false,
  });

  request.headers['x-tweet-watcher-proxy-token'] = token;
  assert.deepEqual(requestOrigin(request, token), {
    clientIp: '203.0.113.9', secure: true, trustedProxy: true,
  });

  request.socket.remoteAddress = '203.0.113.20';
  assert.deepEqual(requestOrigin(request, token), {
    clientIp: '203.0.113.20', secure: false, trustedProxy: false,
  });
});

test('PUBLIC_ORIGIN accepts only a canonical HTTP(S) origin', () => {
  assert.equal(parsePublicOrigin(undefined), null);
  assert.equal(parsePublicOrigin(''), null);
  assert.equal(parsePublicOrigin('https://watcher.example.test').origin, 'https://watcher.example.test');
  assert.equal(parsePublicOrigin('http://localhost:8788').origin, 'http://localhost:8788');
  for (const value of ['https://watcher.example.test/', 'https://user:password@watcher.example.test',
    'https://watcher.example.test/a', 'https://watcher.example.test?x=1', 'file:///tmp/panel',
    'https://watcher.example.test#fragment', 'watcher.example.test', ' https://watcher.example.test']) {
    assert.throws(() => parsePublicOrigin(value), /PUBLIC_ORIGIN/);
  }
});

test('authenticated Cloudflare forwarding separates visitors sharing one relay', () => {
  const token = 'p'.repeat(32);
  const request = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-tweet-watcher-proxy-token': token, 'x-forwarded-for': '104.16.1.2' },
  };
  for (const visitor of ['198.51.100.7', '203.0.113.9', '2001:db8::123']) {
    request.headers['cf-connecting-ip'] = visitor;
    assert.equal(requestOrigin(request, token).clientIp, visitor);
  }
  request.headers['x-forwarded-for'] = '203.0.113.222, 104.16.1.2';
  request.headers['cf-connecting-ip'] = '198.51.100.7';
  assert.equal(requestOrigin(request, token).clientIp, '198.51.100.7', 'untrusted XFF prefix must not select the visitor');
});

test('Cloudflare visitor header never bypasses transport, proxy-token or rightmost-hop validation', () => {
  const token = 'p'.repeat(32);
  const request = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      'x-tweet-watcher-proxy-token': token,
      'x-forwarded-for': '104.16.1.2',
      'cf-connecting-ip': '198.51.100.7',
    },
  };
  for (const credentials of ['', 'wrong-token']) {
    request.headers['x-tweet-watcher-proxy-token'] = credentials;
    assert.equal(requestOrigin(request, token).clientIp, '127.0.0.1');
  }
  request.headers['x-tweet-watcher-proxy-token'] = token;
  request.socket.remoteAddress = '104.16.1.2';
  assert.equal(requestOrigin(request, token).clientIp, '104.16.1.2', 'even a Cloudflare peer needs the authenticated local proxy');
  request.socket.remoteAddress = '127.0.0.1';
  for (const xff of ['203.0.113.9', '104.16.1.2, 203.0.113.9', '104.16.1.2, invalid', '104.16.1.2,']) {
    request.headers['x-forwarded-for'] = xff;
    assert.equal(requestOrigin(request, token).clientIp, xff.endsWith('203.0.113.9') ? '203.0.113.9' : '127.0.0.1');
  }
});

test('Cloudflare forwarding accepts IPv6 and mapped IPv4 but rejects malformed visitor headers', () => {
  const token = 'p'.repeat(32);
  const request = {
    socket: { remoteAddress: '::1' },
    headers: {
      'x-tweet-watcher-proxy-token': token,
      'x-forwarded-for': '2606:4700::1234',
      'cf-connecting-ip': '2001:db8::9',
    },
  };
  assert.equal(requestOrigin(request, token).clientIp, '2001:db8::9');
  request.headers['x-forwarded-for'] = '::ffff:104.16.1.2';
  request.headers['cf-connecting-ip'] = '::ffff:198.51.100.7';
  assert.equal(requestOrigin(request, token).clientIp, '198.51.100.7');
  for (const visitor of ['', 'invalid', '198.51.100.7, 203.0.113.9', ['198.51.100.7', '203.0.113.9'], '198.51.100.7:443']) {
    request.headers['cf-connecting-ip'] = visitor;
    assert.equal(requestOrigin(request, token).clientIp, '104.16.1.2');
  }
  request.headers['x-forwarded-for'] = '2001:db8::99';
  request.headers['cf-connecting-ip'] = '198.51.100.7';
  assert.equal(requestOrigin(request, token).clientIp, '2001:db8::99', 'already-restored visitor address must remain authoritative');
});

test('panel entrypoint keeps assets relative for reverse-proxy subpaths', async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  const response = await fetch(`${base}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  const version = require('../package.json').version;
  assert.ok(html.includes(`href="style.css?v=${version}"`));
  assert.ok(html.includes(`src="app.js?v=${version}"`));

  const script = await fetch(`${base}/app.js?v=${version}`);
  assert.match(script.headers.get('content-type') || '', /javascript/);
});

test('unknown frontend paths return 404 instead of an invalid asset-base fallback', async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  const response = await fetch(`${base}/nested/`);
  assert.equal(response.status, 404);
});

test('unknown API routes stay JSON 404 responses with security headers', async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  const response = await fetch(`${base}/api/not-a-route`);
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type') || '', /application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.deepEqual(await response.json(), { ok: false, error: '接口不存在' });
});

test('oversized JSON bodies retain the parser 413 status', async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  const response = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'x'.repeat(300 * 1024) }),
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { ok: false, error: '请求无效' });
});

test('malformed JSON remains a client-side 400 error', async (t) => {
  if (listenUnavailable) return t.skip('sandbox does not permit local listen sockets');
  const response = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json',
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { ok: false, error: '请求无效' });
});
