'use strict';

// Only safe health metadata is persisted. Cookies remain in the private secrets
// store and are passed to the collector for one pinned acquisition at a time.
const crypto = require('node:crypto');
const FILE = 'x_session_health.json';
const MAX_COOLDOWN = 24 * 3600e3;
const OPERATIONS = new Set(['UserByScreenName', 'UserByRestId', 'UserTweets', 'UserTweetsAndReplies',
  'ListLatestTweetsTimeline', 'SearchTimeline', 'TweetDetail', 'ListMembers', 'AboutAccountQuery']);
const STATUS = new Set(['unknown', 'healthy', 'rate-limited', 'auth-required', 'network-error', 'upstream-error']);
const CREDENTIAL = /^[A-Za-z0-9_%.-]{1,4096}$/;
const ID = /^(?:default|[a-z][a-z0-9_-]{0,31})$/;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0;

function configuredSessions(cfg, secrets) {
  return [{ id: 'default', label: '默认会话', enabled: true }, ...(cfg.x_sessions || [])]
    .filter((s) => s.enabled !== false)
    .map((s) => {
      const credentials = s.id === 'default' ? secrets : secrets.x_sessions?.[s.id] || {};
      const authToken = credentials.auth_token || '';
      const ct0 = credentials.ct0 || '';
      const proxy = s.proxy_url || '';
      return { id: s.id, label: s.label || s.id, authToken, ct0, proxy,
        configured: CREDENTIAL.test(authToken) && CREDENTIAL.test(ct0),
        fingerprint: hash(JSON.stringify([authToken, ct0, proxy])) };
    });
}

function createSessionPool({ store, now = Date.now } = {}) {
  let loaded = false;
  let state = { version: 1, sessions: {} };
  function corrupt() {
    return Object.assign(new Error('X 会话健康状态损坏，已停止采集；请检查私有状态文件'), { code: 'DATA_CORRUPT' });
  }
  function load() {
    if (loaded) return;
    const r = store.readState(FILE);
    if (r.status === 'corrupt') throw corrupt();
    if (r.status === 'ok') {
      const doc = r.value;
      if (!doc || doc.version !== 1 || !doc.sessions || Array.isArray(doc.sessions)
          || typeof doc.sessions !== 'object' || Object.keys(doc.sessions).length > 21) throw corrupt();
      for (const [id, entry] of Object.entries(doc.sessions)) {
        if (!ID.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)
            || !entry || typeof entry !== 'object' || !/^[a-f0-9]{64}$/.test(entry.fingerprint)
            || !STATUS.has(entry.status) || !entry.operations || Array.isArray(entry.operations)
            || typeof entry.operations !== 'object'
            || !['lastSuccessAt', 'lastFailureAt', 'lastUsedAt', 'retryAt', 'failures'].every((k) => timestamp(entry[k]))) throw corrupt();
        for (const [operation, info] of Object.entries(entry.operations)) {
          if (!OPERATIONS.has(operation) || !info || !timestamp(info.until) || !timestamp(info.observedAt)
              || !(info.remaining === null || (Number.isSafeInteger(info.remaining) && info.remaining >= 0 && info.remaining <= 10000000))) throw corrupt();
        }
      }
      state = doc;
    }
    loaded = true;
  }
  function save(next) {
    // Do not expose a candidate in memory before the store's durability barrier.
    try { store.writeJSON(FILE, next); }
    catch (_) { loaded = false; throw Object.assign(new Error('X 会话状态保存失败，已停止本次采集'), { code: 'SESSION_STATE_WRITE' }); }
    state = next;
  }
  function entryFor(session) {
    const entry = state.sessions[session.id];
    if (entry?.fingerprint === session.fingerprint) return structuredClone(entry);
    return { fingerprint: session.fingerprint, status: 'unknown', operations: {},
      lastSuccessAt: 0, lastFailureAt: 0, lastUsedAt: 0, retryAt: 0, failures: 0 };
  }
  function until(entry, operations, time) {
    let value = Math.min(entry.retryAt, time + MAX_COOLDOWN);
    for (const op of operations) value = Math.max(value, Math.min(entry.operations[op]?.until || 0, time + MAX_COOLDOWN));
    return value;
  }
  function choose(cfg, secrets, operations, { sessionId, force = false } = {}) {
    load();
    const time = now();
    const ops = Array.isArray(operations) ? operations : [operations];
    if (!ops.length || ops.some((op) => !OPERATIONS.has(op))) throw new TypeError('未知 X 操作');
    const all = configuredSessions(cfg, secrets).filter((s) => s.configured && (!sessionId || s.id === sessionId));
    const available = all.filter((s) => {
      const entry = entryFor(s);
      return (force || entry.status !== 'auth-required') && until(entry, ops, time) <= time;
    });
    available.sort((a, b) => entryFor(a).lastUsedAt - entryFor(b).lastUsedAt || a.id.localeCompare(b.id));
    if (!available.length) {
      const retry = all.map((s) => until(entryFor(s), ops, time)).filter((x) => x > time);
      return { ok: false, code: retry.length ? 'RATE_LIMITED' : 'AUTH_REQUIRED',
        nextRetryAt: retry.length ? Math.min(...retry) : null,
        error: retry.length ? 'X 会话正在冷却，采集已顺延' : '没有可用的 X 登录会话，请检查 Cookie 和会话开关' };
    }
    const session = available[0];
    const entry = entryFor(session);
    entry.lastUsedAt = time;
    const active = new Set(configuredSessions(cfg, secrets).map((s) => s.id));
    const sessions = Object.fromEntries(Object.entries(state.sessions).filter(([id]) => active.has(id)));
    sessions[session.id] = entry;
    save({ version: 1, sessions });
    return { ok: true, session };
  }
  function record(session, operation, result) {
    load();
    const time = now();
    const entry = entryFor(session);
    for (const item of result.rateLimits || (result.rateLimit ? [result.rateLimit] : [])) {
      if (!item || !OPERATIONS.has(item.operation)) continue;
      const remaining = Number.isSafeInteger(item.remaining) && item.remaining >= 0 && item.remaining <= 10000000
        ? item.remaining : null;
      const resetAt = timestamp(item.resetAt) ? Math.min(item.resetAt, time + MAX_COOLDOWN) : 0;
      const prior = entry.operations[item.operation];
      entry.operations[item.operation] = { remaining, observedAt: time,
        until: remaining === 0 ? Math.max(prior?.until || 0, resetAt > time ? resetAt : time + 60e3) : prior?.until || 0 };
    }
    if (result.ok || result.code === 'INCOMPLETE_COVERAGE') {
      entry.lastSuccessAt = time;
      entry.status = 'healthy';
      entry.failures = 0;
      entry.retryAt = 0;
    } else if (!String(result.code || '').startsWith('CATCHUP_')
        && !['COLLECTOR_BUSY', 'EVIDENCE_WRITE', 'OUTBOX_FULL'].includes(result.code)) {
      entry.lastFailureAt = time;
      entry.failures = Math.min(20, entry.failures + 1);
      if (result.code === 'AUTH_REQUIRED') {
        entry.status = 'auth-required';
        entry.retryAt = 0;
      } else if (result.code === 'RATE_LIMITED') {
        entry.status = 'rate-limited';
        const explicit = (result.rateLimits || (result.rateLimit ? [result.rateLimit] : []))
          .filter((item) => OPERATIONS.has(item?.operation) && item.remaining === 0);
        const knownFailure = OPERATIONS.has(result.failedOperation);
        const failed = knownFailure ? result.failedOperation : operation;
        // Earlier successful requests may also have exhausted a different
        // operation. Their headers cannot replace the actual failure's cooldown.
        if (knownFailure ? !explicit.some((item) => item.operation === failed) : !explicit.length) {
          const reset = entry.operations[failed]?.until;
          entry.operations[failed] = { remaining: 0, observedAt: time,
            until: reset > time ? reset : time + 15 * 60e3 };
        }
      } else {
        entry.status = ['NETWORK_ERROR', 'COLLECTOR_TIMEOUT'].includes(result.code) ? 'network-error' : 'upstream-error';
        entry.retryAt = time + Math.min(300e3, 5000 * (2 ** (entry.failures - 1)));
      }
    }
    if (entry.status === 'healthy' && Object.values(entry.operations).some((op) => op.until > time)) entry.status = 'rate-limited';
    save({ version: 1, sessions: { ...state.sessions, [session.id]: entry } });
  }
  function diagnostics(cfg, secrets) {
    load();
    const time = now();
    return Object.fromEntries(configuredSessions(cfg, secrets).map((session) => {
      const entry = entryFor(session);
      const rateLimitedUntil = Math.max(0, ...Object.values(entry.operations).map((op) => Math.min(op.until, time + MAX_COOLDOWN)));
      const nextRetryAt = Math.max(entry.retryAt, rateLimitedUntil);
      const status = !session.configured ? 'unconfigured'
        : entry.status === 'rate-limited' && nextRetryAt <= time ? (entry.lastSuccessAt ? 'healthy' : 'unknown') : entry.status;
      return [session.id, { label: session.label, status, lastSuccessAt: entry.lastSuccessAt || null,
        lastFailureAt: entry.lastFailureAt || null, rateLimitedUntil: rateLimitedUntil > time ? rateLimitedUntil : null,
        nextRetryAt: nextRetryAt > time ? nextRetryAt : null,
        operations: Object.fromEntries(Object.entries(entry.operations).map(([op, info]) => [op, {
          remaining: info.remaining, nextRetryAt: info.until > time ? info.until : null,
        }])) }];
    }));
  }
  return { choose, record, diagnostics };
}

module.exports = { createSessionPool, configuredSessions };
