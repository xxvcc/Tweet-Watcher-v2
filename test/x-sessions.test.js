'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionPool } = require('../lib/x-sessions');
function fixture() {
  const files = new Map();
  let clock = 1700000000000;
  let fail = false;
  const store = {
    readState: (name) => files.has(name) ? { status: 'ok', value: structuredClone(files.get(name)) } : { status: 'missing' },
    writeJSON(name, data) { if (fail) throw new Error('disk failure'); files.set(name, structuredClone(data)); },
  };
  const options = { store, now: () => clock };
  return { files, options, pool: createSessionPool(options), advance(ms) { clock += ms; }, fail() { fail = true; } };
}
const cfg = { x_sessions: [{ id: 'spare', label: '备用', enabled: true }] };
const sec = { auth_token: 'synthetic-default', ct0: 'synthetic-ct0',
  x_sessions: { spare: { auth_token: 'synthetic-spare', ct0: 'synthetic-spare-ct0' } } };

test('successful last quota page remains successful while only that session and operation cool down', () => {
  const f = fixture();
  const chosen = f.pool.choose(cfg, sec, 'UserTweets').session;
  f.pool.record(chosen, 'UserTweets', { ok: true, rateLimit: { operation: 'UserTweets', remaining: 0, resetAt: 1700000060000 } });
  const info = f.pool.diagnostics(cfg, sec)[chosen.id];
  assert.equal(info.status, 'rate-limited');
  assert.equal(info.lastSuccessAt, 1700000000000);
  assert.equal(f.pool.choose(cfg, sec, 'UserTweets', { sessionId: chosen.id }).code, 'RATE_LIMITED');
  assert.equal(f.pool.choose(cfg, sec, 'TweetDetail', { sessionId: chosen.id }).ok, true);
  assert.notEqual(f.pool.choose(cfg, sec, 'UserTweets').session.id, chosen.id);
  const restarted = createSessionPool(f.options);
  assert.equal(restarted.choose(cfg, sec, 'UserTweets', { sessionId: chosen.id }).code, 'RATE_LIMITED');
  f.advance(60001);
  assert.equal(restarted.choose(cfg, sec, 'UserTweets', { sessionId: chosen.id }).ok, true);
});

test('no-header 429 has finite cooldown, auth failures fail over, new credentials invalidate old health', () => {
  const f = fixture();
  const first = f.pool.choose(cfg, sec, 'UserTweets').session;
  f.pool.record(first, 'UserTweets', { ok: false, code: 'AUTH_REQUIRED' });
  assert.notEqual(f.pool.choose(cfg, sec, 'UserTweets').session.id, first.id);
  assert.equal(f.pool.choose(cfg, sec, 'UserTweets', { sessionId: first.id }).code, 'AUTH_REQUIRED');
  const replacement = { ...sec, auth_token: 'synthetic-replacement' };
  assert.equal(first.id, 'default');
  assert.equal(f.pool.choose(cfg, replacement, 'UserTweets', { sessionId: 'default' }).ok, true);
  const session = f.pool.choose(cfg, replacement, 'UserTweets', { sessionId: 'default' }).session;
  f.pool.record(session, 'UserTweets', { ok: false, code: 'RATE_LIMITED' });
  assert.equal(f.pool.choose(cfg, replacement, 'UserTweets', { sessionId: 'default' }).nextRetryAt, 1700000900000);
  f.advance(900001);
  assert.equal(f.pool.choose(cfg, replacement, 'UserTweets', { sessionId: 'default' }).ok, true);
});

test('required session never silently rotates and safe durable health never stores credentials', () => {
  const f = fixture();
  const session = f.pool.choose(cfg, sec, 'UserTweets', { sessionId: 'spare' }).session;
  f.pool.record(session, 'UserTweets', { ok: false, code: 'NETWORK_ERROR', error: sec.x_sessions.spare.auth_token });
  assert.equal(f.pool.choose(cfg, sec, 'UserTweets', { sessionId: 'spare' }).ok, false);
  assert.equal(f.pool.choose(cfg, sec, 'UserTweets').session.id, 'default');
  const serialized = JSON.stringify([...f.files.values()]);
  for (const value of [sec.auth_token, sec.ct0, sec.x_sessions.spare.auth_token, sec.x_sessions.spare.ct0]) assert.equal(serialized.includes(value), false);
  assert.equal(JSON.stringify(f.pool.diagnostics(cfg, sec)).includes('fingerprint'), false);
});

test('storage failure prevents session use and malformed stored state is refused', () => {
  const f = fixture();
  f.fail();
  assert.throws(() => f.pool.choose(cfg, sec, 'UserTweets'), { code: 'SESSION_STATE_WRITE' });
  const bad = fixture();
  bad.files.set('x_session_health.json', { version: 1, sessions: { default: { status: 'healthy' } } });
  assert.throws(() => bad.pool.choose(cfg, sec, 'UserTweets'), { code: 'DATA_CORRUPT' });
});

test('a failed operation without headers still cools down when an earlier operation exhausted its quota', () => {
  const f = fixture();
  const session = f.pool.choose(cfg, sec, ['UserByScreenName', 'UserTweets'], { sessionId: 'default' }).session;
  f.pool.record(session, 'UserTweets', { ok: false, code: 'RATE_LIMITED', failedOperation: 'UserTweets',
    rateLimits: [{ operation: 'UserByScreenName', remaining: 0, resetAt: 1700000060000 }] });
  const info = f.pool.diagnostics(cfg, sec).default;
  assert.equal(info.operations.UserByScreenName.nextRetryAt, 1700000060000);
  assert.equal(info.operations.UserTweets?.nextRetryAt, 1700000900000);
  f.advance(60001);
  const restarted = createSessionPool(f.options);
  assert.equal(restarted.choose(cfg, sec, 'UserByScreenName', { sessionId: 'default' }).ok, true);
  assert.equal(restarted.choose(cfg, sec, 'UserTweets', { sessionId: 'default' }).code, 'RATE_LIMITED');
  assert.equal(restarted.choose(cfg, sec, 'TweetDetail', { sessionId: 'default' }).ok, true);
});

test('explicit metadata on the actual failing operation controls cooldown without penalizing the requested wrapper', () => {
  const f = fixture();
  const session = f.pool.choose(cfg, sec, 'UserTweets', { sessionId: 'default' }).session;
  f.pool.record(session, 'UserTweets', { ok: false, code: 'RATE_LIMITED', failedOperation: 'UserByScreenName',
    rateLimits: [{ operation: 'UserByScreenName', remaining: 0, resetAt: 1700000030000 }] });
  const info = f.pool.diagnostics(cfg, sec).default;
  assert.equal(info.operations.UserByScreenName.nextRetryAt, 1700000030000);
  assert.equal(info.operations.UserTweets, undefined);
  assert.equal(f.pool.choose(cfg, sec, 'UserTweets', { sessionId: 'default' }).ok, true);
  assert.equal(f.pool.choose(cfg, sec, ['UserByScreenName', 'UserTweets'], { sessionId: 'default' }).code, 'RATE_LIMITED');
  f.advance(30001);
  assert.equal(f.pool.choose(cfg, sec, ['UserByScreenName', 'UserTweets'], { sessionId: 'default' }).ok, true);
});
