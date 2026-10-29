'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const runtime = require('./runtime');
const { createEvidenceStore } = require('./evidence');
const parser = require('./twscrape-timeline');
const { normalizeSource, sourceKey, sourceOperation, validProxy } = require('./collector-source');
const catchups = require('./collector-catchup');

const ROOT = path.resolve(__dirname, '..');
const PYTHON = path.join(ROOT, '.venv', 'bin', 'python');
const BRIDGE = path.join(ROOT, 'collector', 'bridge.py');
const SOURCE_COMMIT = '63f61a518e576ea5c132f1156c03dda0520d76c1';
const MAX_LINE_BYTES = 12 * 1024 * 1024;
const MAX_PAGES = 5;
const MAX_POSTS = 500;
const TIMEOUT_MS = 90000;
const ID_RE = /^\d{1,32}$/;
const OPERATIONS = new Set(['UserByScreenName', 'UserTweets', 'UserTweetsAndReplies',
  'ListLatestTweetsTimeline', 'SearchTimeline', 'TweetDetail', 'ListMembers']);
const MESSAGES = Object.freeze({
  COLLECTOR_MISSING: 'Python 采集器未安装，请运行 npm run collector:install',
  COLLECTOR_BUSY: '采集器正在处理另一项请求，请稍后重试',
  COLLECTOR_TIMEOUT: '采集超过时间预算，未推进水位',
  COLLECTOR_PROTOCOL: '采集器响应协议不正确，未推进水位',
  COLLECTOR_EXIT: '采集进程异常结束，未推进水位',
  INVALID_INPUT: '账号、Cookie 或水位格式不正确',
  EVIDENCE_WRITE: '原始页证据未能安全落盘，未推进水位',
  CURSOR_LOOP: '时间线游标重复或循环，未推进水位',
  INCOMPLETE_COVERAGE: '本轮页数预算尚未覆盖上次水位，未推进水位',
  POST_CONFLICT: '同一推文出现不同内容，已保留证据并停止本轮',
  INVALID_PAGE: '时间线页面不完整或结构已变化，未推进水位',
  AUTH_REQUIRED: 'X 登录会话失效或需要验证，请更新 Cookie',
  RATE_LIMITED: 'X 请求受到限流，请稍后重试',
  NETWORK_ERROR: '无法连接 X，请检查网络后重试',
  SIGNING_ERROR: 'X 请求签名初始化失败，请检查会话或采集器版本',
  UPSTREAM_ERROR: 'X 返回错误，已停止本轮采集',
  UNSAFE_URL: '采集器拒绝了不受信任的请求地址或重定向',
  RESPONSE_TOO_LARGE: 'X 响应超过大小上限，已停止本轮采集',
  REQUEST_BUDGET: 'X 签名或请求开销超过安全预算，已停止本轮采集',
  CATCHUP_CORRUPT: '补采状态或页面证据损坏，未推进水位',
  CATCHUP_WRITE: '补采页面与游标未能安全落盘，未推进水位',
  CATCHUP_CAPACITY: '补采达到容量上限，已保留进度且未推进水位',
  CATCHUP_EXPIRED: '补采超过七天，请核对后重建补采；未推进水位',
  CATCHUP_SESSION_CHANGED: '补采绑定的登录会话已变化，请恢复原会话或明确重建补采',
  CATCHUP_CHECKPOINT_CHANGED: '补采绑定的原检查点已变化，请核对补采状态',
  CATCHUP_NOT_READY: '补采尚未完成，仅本地重放不会发起网络请求',
});
const ERROR_ALIASES = Object.freeze({
  INVALID_REQUEST: 'INVALID_INPUT', NOT_INITIALIZED: 'COLLECTOR_PROTOCOL', ALREADY_INITIALIZED: 'COLLECTOR_PROTOCOL',
  URL_BLOCKED: 'UNSAFE_URL', REDIRECT_BLOCKED: 'UNSAFE_URL', UPSTREAM_HTTP: 'UPSTREAM_ERROR',
  TIMEOUT: 'COLLECTOR_TIMEOUT', SIGNING_FAILED: 'SIGNING_ERROR',
  INVALID_RESPONSE: 'INVALID_PAGE', INTERNAL_ERROR: 'COLLECTOR_EXIT', GRAPHQL_ERRORS: 'UPSTREAM_ERROR',
  TIMELINE_INCOMPLETE: 'INVALID_PAGE', USER_UNAVAILABLE: 'UPSTREAM_ERROR', TWEET_UNAVAILABLE: 'INVALID_PAGE',
  IDENTITY_MISMATCH: 'INVALID_PAGE', TWEET_CONFLICT: 'POST_CONFLICT',
});
function failure(code) {
  code = ERROR_ALIASES[code] || code;
  const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'INVALID_PAGE';
  return Object.assign(new Error(MESSAGES[safeCode]), { code: safeCode });
}
function safeRateLimit(value) {
  if (!value || typeof value.operation !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(value.operation)) return null;
  const remaining = value.remaining === null ? null : Number.isSafeInteger(value.remaining)
    && value.remaining >= 0 && value.remaining <= 10000000 ? value.remaining : null;
  const resetAt = value.resetAt === null ? null : Number.isSafeInteger(value.resetAt)
    && value.resetAt >= 0 && value.resetAt <= Date.now() + 86400000 ? value.resetAt : null;
  return remaining === null && resetAt === null ? null : { operation: value.operation, remaining, resetAt };
}
function environment() {
  return { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8',
    PYTHONUNBUFFERED: '1', TWS_TELEMETRY: '0', DO_NOT_TRACK: '1', TWS_HTTP_BACKEND: 'curl' };
}

class PythonSession {
  constructor() {
    if (!fs.existsSync(PYTHON) || !fs.existsSync(BRIDGE)) throw failure('COLLECTOR_MISSING');
    this.pending = null;
    this.buffer = Buffer.alloc(0);
    this.dead = null;
    this.child = spawn(PYTHON, ['-I', BRIDGE], { cwd: ROOT, env: environment(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.timer = setTimeout(() => this.abort(failure('COLLECTOR_TIMEOUT')), TIMEOUT_MS);
    this.timer.unref();
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    // Never surface the child stderr: third-party exceptions can contain URLs,
    // response bodies, headers, or credentials. Drain it without retention.
    this.child.stderr.on('data', () => {});
    this.child.on('error', () => this.abort(failure('COLLECTOR_MISSING')));
    this.child.on('close', () => this.abort(failure('COLLECTOR_EXIT')));
    this.child.stdin.on('error', () => this.abort(failure('COLLECTOR_EXIT')));
  }
  onData(chunk) {
    if (this.dead) return;
    if (this.buffer.length + chunk.length > MAX_LINE_BYTES) return this.abort(failure('RESPONSE_TOO_LARGE'));
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let end;
    while ((end = this.buffer.indexOf(10)) !== -1) {
      const line = this.buffer.subarray(0, end).toString('utf8');
      this.buffer = this.buffer.subarray(end + 1);
      if (!this.pending) return this.abort(failure('COLLECTOR_PROTOCOL'));
      let data;
      try { data = JSON.parse(line); } catch (_) { return this.abort(failure('COLLECTOR_PROTOCOL')); }
      if (!data || typeof data !== 'object' || typeof data.ok !== 'boolean') return this.abort(failure('COLLECTOR_PROTOCOL'));
      const pending = this.pending;
      this.pending = null;
      if (!data.ok) pending.reject(Object.assign(failure(data.code), { rateLimit: safeRateLimit(data.rateLimit) }));
      else pending.resolve(data);
    }
  }
  request(message) {
    if (this.dead) return Promise.reject(this.dead);
    if (this.pending) return Promise.reject(failure('COLLECTOR_PROTOCOL'));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.child.stdin.write(JSON.stringify(message) + '\n', (error) => {
        if (error) this.abort(failure('COLLECTOR_EXIT'));
      });
    });
  }
  abort(error) {
    if (this.dead) return;
    this.dead = error;
    clearTimeout(this.timer);
    if (this.pending) this.pending.reject(error);
    this.pending = null;
    this.buffer = Buffer.alloc(0);
    this.child.kill('SIGKILL');
    this.child.stdin.destroy();
  }
  close() { this.abort(failure('COLLECTOR_EXIT')); }
  async beginRound() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.abort(failure('COLLECTOR_TIMEOUT')), TIMEOUT_MS);
    this.timer.unref();
    return this.request({ op: 'begin' });
  }
  finishRound() { clearTimeout(this.timer); }
}

function createCollector({ sessionFactory = () => new PythonSession(), evidenceFactory = () => createEvidenceStore(),
  pageParser = parser, policy = runtime, maxPages = MAX_PAGES, catchupStore = null,
  reuseSessions = false, userCacheTtl = 0 } = {}) {
  let busy = false;
  const sessions = new Map(), users = new Map();
  const credentialOK = (value) => typeof value === 'string' && /^[A-Za-z0-9_%.-]{1,4096}$/.test(value);
  const fingerprint = (input) => crypto.createHash('sha256')
    .update(JSON.stringify([input.authToken, input.ct0, input.proxy || ''])).digest('hex');
  function credentials(input) {
    if (!credentialOK(input.authToken) || !credentialOK(input.ct0) || !validProxy(input.proxy || '')) throw failure('INVALID_INPUT');
  }
  function dropSession(key) {
    const item = sessions.get(key);
    if (item) { clearTimeout(item.timer); item.session.close(); sessions.delete(key); }
  }
  async function acquire(input, binding) {
    const previous = sessions.get(binding);
    if (previous && !previous.session.dead && Date.now() - previous.born < 180000 && previous.rounds < 8) {
      clearTimeout(previous.timer);
      try { await previous.session.beginRound(); previous.rounds++; return previous.session; }
      catch { dropSession(binding); }
    } else dropSession(binding);
    const session = sessionFactory();
    try {
      const initialized = await session.request({ op: 'init', authToken: input.authToken, ct0: input.ct0,
        ...(input.proxy ? { proxy: input.proxy } : {}) });
      if (initialized.protocol !== 1) throw failure('COLLECTOR_PROTOCOL');
      if (reuseSessions && typeof session.beginRound === 'function' && typeof session.finishRound === 'function') {
        while (sessions.size >= 4) dropSession(sessions.keys().next().value);
        sessions.set(binding, { session, born: Date.now(), rounds: 1 });
      }
      return session;
    } catch (error) { session.close(); throw error; }
  }
  function release(session, binding, healthy) {
    if (!session) return;
    if (healthy && sessions.get(binding)?.session === session && !session.dead) {
      session.finishRound();
      const item = sessions.get(binding);
      item.timer = setTimeout(() => dropSession(binding), 30000);
      item.timer.unref?.();
    } else if (sessions.get(binding)?.session === session) dropSession(binding);
    else session.close();
  }
  function statusOf(value) { return value?.pages.length ? catchups.summary(value) : undefined; }
  function responseRates(rates) {
    const rateLimits = [...rates.values()];
    return rateLimits.length ? { rateLimits, rateLimit: rateLimits.at(-1) } : {};
  }
  function failedOperation(error) {
    return OPERATIONS.has(error?.failedOperation) ? { failedOperation: error.failedOperation } : {};
  }
  async function request(session, message, rates, operation) {
    const known = rates.get(operation);
    if (known?.remaining === 0 && (known.resetAt === null || known.resetAt > Date.now())) throw Object.assign(failure('RATE_LIMITED'), { rateLimit: known, failedOperation: operation });
    try {
      const result = await session.request(message);
      const rate = safeRateLimit(result.rateLimit);
      if (rate) rates.set(rate.operation, rate);
      return result;
    } catch (error) {
      const rate = safeRateLimit(error?.rateLimit);
      if (rate) rates.set(rate.operation, rate);
      throw Object.assign(failure(error?.code), { failedOperation: operation });
    }
  }
  function classify(response, operation) {
    if (['AUTH_REQUIRED', 'RATE_LIMITED'].includes(response.responseError)) throw Object.assign(failure(response.responseError), { failedOperation: operation });
  }
  function save(storage, evidence, data, runId, page, key, operation, input) {
    let record;
    try { record = storage.persist({ runId, page, username: key, operation, data, secrets: [input.authToken, input.ct0] }); }
    catch { throw failure('EVIDENCE_WRITE'); }
    evidence.push(record);
    return record;
  }
  async function resolveUser(source, session, storage, evidence, runId, input, rates, binding) {
    const key = binding + ':' + source.username.toLowerCase();
    const existing = users.get(key);
    if (existing && existing.expires > Date.now()) return existing.value;
    users.delete(key);
    const response = await request(session, { op: 'user', username: source.username }, rates, 'UserByScreenName');
    save(storage, evidence, response.data, runId, 0, sourceKey(source), 'user', input);
    classify(response, 'UserByScreenName');
    const value = pageParser.parseUser(response.data, source.username);
    if (userCacheTtl > 0) {
      users.set(key, { value, expires: Date.now() + Math.min(userCacheTtl, 900000) });
      while (users.size > 128) users.delete(users.keys().next().value);
    }
    return value;
  }
  function parse(data, source, user) {
    return source.source_type === 'user'
      ? pageParser.parseTimelinePage(data, { username: user.username, userId: user.id })
      : pageParser.parseSourcePage(data, source);
  }
  function accumulator(source, user, sinceId, upperId = null) {
    const tweets = new Map(), cursors = new Set(), boundaries = new Set();
    let oldestId = null, newestId = null, cursor, exhausted = false, reachedSince = false, pageCount = 0;
    return {
      add(data) {
        const parsed = parse(data, source, user);
        if (parsed.nextCursor && cursors.has(parsed.nextCursor)) throw failure('CURSOR_LOOP');
        for (const tweet of parsed.tweets) {
          tweets.set(tweet.id, parser.mergeTweet(tweets.get(tweet.id), tweet));
        }
        if (tweets.size > (catchupStore && sinceId ? catchups.MAX_POSTS : MAX_POSTS)) throw failure(catchupStore && sinceId ? 'CATCHUP_CAPACITY' : 'RESPONSE_TOO_LARGE');
        for (const id of parsed.boundaryIds) {
          if (!boundaries.has(id) && oldestId !== null && BigInt(id) > BigInt(oldestId)) throw failure('INVALID_PAGE');
          boundaries.add(id);
          if (newestId === null || BigInt(id) > BigInt(newestId)) newestId = id;
          if (oldestId === null || BigInt(id) < BigInt(oldestId)) oldestId = id;
        }
        if (upperId === null && boundaries.size) upperId = [...tweets.keys()].reduce((a, b) => BigInt(a) > BigInt(b) ? a : b);
        reachedSince ||= sinceId !== undefined && parsed.boundaryIds.some((id) => BigInt(id) <= BigInt(sinceId));
        exhausted = parsed.exhausted;
        cursor = parsed.nextCursor;
        if (cursor) cursors.add(cursor);
        pageCount++;
        return parsed;
      },
      get upperId() { return upperId; },
      get cursor() { return cursor; },
      get size() { return tweets.size; },
      get complete() { return (sinceId === undefined && boundaries.size > 0) || reachedSince || exhausted; },
      result() {
        // Exhausting a module-only replies timeline is a stronger boundary than
        // an individual module; only then may its own posts establish a baseline.
        if (exhausted && newestId === null && tweets.size) {
          const eligible = [...tweets.values()].filter((tweet) => source.source_type !== 'user'
            || tweet.author_username?.toLowerCase() === source.username.toLowerCase());
          if (eligible.length) newestId = eligible.reduce((a, b) => BigInt(a.id) > BigInt(b.id) ? a : b).id;
        }
        const values = [...tweets.values()].filter((tweet) => sinceId === undefined || upperId === null || BigInt(tweet.id) <= BigInt(upperId));
        return { tweets: values, coverage: { complete: this.complete, exhausted, reachedSince, oldestId, newestId,
          pages: pageCount, reason: reachedSince ? 'reached-since' : exhausted ? 'exhausted' : 'initial-snapshot' } };
      },
    };
  }
  async function fetchTweets(input = {}) {
    const blocked = policy.blocked('collection');
    if (blocked) return { ...blocked, tweets: null, raw: '' };
    if (busy) return { ok: false, tweets: null, code: 'COLLECTOR_BUSY', error: MESSAGES.COLLECTOR_BUSY, raw: '' };
    let source, key, binding, session, stage, healthy = false, replayAtCommittedCheckpoint = false;
    const rates = new Map(), evidence = [];
    try {
      credentials(input);
      source = normalizeSource(input.source || { username: input.username });
      key = sourceKey(source); binding = fingerprint(input);
      if (input.sinceId !== undefined && (typeof input.sinceId !== 'string' || !/^\d{1,32}$/.test(input.sinceId))) throw failure('INVALID_INPUT');
      busy = true;
      if (catchupStore && input.catchup !== false) stage = catchupStore.load(key);
      if (stage && stage.binding !== binding) throw failure('CATCHUP_SESSION_CHANGED');
      if (stage?.sessionId && stage.sessionId !== input.sessionId) throw failure('CATCHUP_SESSION_CHANGED');
      if (stage && stage.sinceId !== input.sinceId) {
        if (stage.completed && stage.coverage?.newestId === input.sinceId) {
          if (input.localOnly === true) replayAtCommittedCheckpoint = true;
          else { catchupStore.remove(key); stage = null; }
        }
        else throw failure('CATCHUP_CHECKPOINT_CHANGED');
      }
      if (stage && Date.now() - stage.startedAt > catchups.MAX_AGE) throw failure('CATCHUP_EXPIRED');
      if (input.localOnly === true && !stage?.completed) throw failure('CATCHUP_NOT_READY');
      const runId = crypto.randomUUID();
      const storage = evidenceFactory();
      // After durable outbox capture but before ack, the caller may already
      // hold this stage's newest checkpoint. Replay against its original lower
      // boundary, then verify the committed checkpoint from the actual pages.
      const replaySinceId = replayAtCommittedCheckpoint ? stage.sinceId : input.sinceId;
      const windowStartId = source.source_type === 'search' && replaySinceId
        ? String(BigInt(replaySinceId) > (86400000n << 22n) ? BigInt(replaySinceId) - (86400000n << 22n) : 1n) : replaySinceId;
      let user = stage?.user;
      let acc = user || source.source_type !== 'user' ? accumulator(source, user, windowStartId, stage?.upperId) : null;
      if (stage) {
        for (const page of stage.pages) { acc.add(page.data); if (page.evidence) evidence.push(page.evidence); }
        if (stage.cursor !== acc.cursor || stage.items !== acc.size || stage.upperId !== acc.upperId
            || stage.completed !== acc.complete || stage.windowStartId !== windowStartId) throw failure('CATCHUP_CORRUPT');
        if (acc.complete) {
          const result = acc.result();
          if (replayAtCommittedCheckpoint && result.coverage.newestId !== input.sinceId) throw failure('CATCHUP_CORRUPT');
          return { ok: true, ...result, coverage: { ...result.coverage,
            ...(source.source_type === 'search' ? { discovery: true, windowStartId } : {}) },
          catchup: statusOf(stage), evidence, error: null, raw: '' };
        }
      }
      if (input.localOnly === true) throw failure('CATCHUP_NOT_READY');
      session = await acquire(input, binding);
      if (source.source_type === 'user' && !user) user = await resolveUser(source, session, storage, evidence, runId, input, rates, binding);
      acc ||= accumulator(source, user, windowStartId);
      const persist = catchupStore && input.catchup !== false && input.sinceId !== undefined;
      stage ||= persist ? { schema: 1, sourceKey: key, source, binding, sinceId: input.sinceId,
        sessionId: typeof input.sessionId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(input.sessionId) ? input.sessionId : null,
        windowStartId, user, startedAt: Date.now(), updatedAt: Date.now(), pages: [], completed: false,
        cursor: undefined, upperId: null, items: 0 } : null;
      let query = source.query;
      if (source.source_type === 'search' && windowStartId) query = `(${query}) since_id:${windowStartId}`;
      for (let page = 1; page <= maxPages; page++) {
        if (stage && stage.pages.length >= catchups.MAX_PAGES) throw failure('CATCHUP_CAPACITY');
        const op = source.source_type === 'user' ? source.timeline_mode === 'replies' ? 'replies' : 'timeline' : source.source_type;
        const response = await request(session, { op, count: Math.min(50, Math.max(1, Number.parseInt(input.count, 10) || 20)),
          ...(user ? { userId: user.id } : {}), ...(source.list_id ? { listId: source.list_id } : {}),
          ...(query ? { query } : {}), ...(acc.cursor ? { cursor: acc.cursor } : {}) }, rates, sourceOperation(source));
        const descriptor = save(storage, evidence, response.data, runId, page, key, op, input);
        classify(response, sourceOperation(source));
        const protectedPage = catchups.evidencePage(response.data, op, descriptor, [input.authToken, input.ct0]);
        // A persisted stage must parse exactly the redacted document it will
        // replay after restart. Nonpersistent injected parsers retain identity.
        acc.add(stage ? protectedPage.data : response.data);
        const result = acc.result();
        if (stage) {
          const next = { ...stage, pages: [...stage.pages, protectedPage], upperId: acc.upperId,
            cursor: acc.cursor, items: acc.size, updatedAt: Date.now(), completed: acc.complete,
            ...(acc.complete ? { coverage: result.coverage } : {}) };
          catchupStore.save(next);
          stage = next;
        }
        if (acc.complete) {
          healthy = true;
          return { ok: true, ...result, coverage: { ...result.coverage,
            ...(source.source_type === 'search' ? { discovery: true, windowStartId: windowStartId ?? null } : {}) },
          ...(stage ? { catchup: statusOf(stage) } : {}), evidence, error: null, raw: '', ...responseRates(rates) };
        }
        if (!acc.cursor) throw failure('INVALID_PAGE');
      }
      healthy = true;
      throw failure('INCOMPLETE_COVERAGE');
    } catch (error) {
      const safe = failure(error.code);
      if (error.code === 'IDENTITY_MISMATCH' && source?.source_type === 'user') users.delete(binding + ':' + source.username.toLowerCase());
      return { ok: false, tweets: null, code: safe.code, error: safe.message, raw: '', evidence,
        ...(stage ? { catchup: statusOf(stage) } : {}), ...responseRates(rates), ...failedOperation(error),
        coverage: { complete: false, exhausted: false, reachedSince: false, oldestId: null,
          ...(source?.source_type === 'search' ? { discovery: true } : {}) } };
    } finally { release(session, binding, healthy); busy = false; }
  }
  async function inspect(input = {}, kind) {
    const blocked = policy.blocked('collection');
    if (blocked) return blocked;
    if (busy) return { ok: false, code: 'COLLECTOR_BUSY', error: MESSAGES.COLLECTOR_BUSY };
    let session, binding, healthy = false;
    const rates = new Map(), evidence = [], values = new Map(), seen = new Set();
    function linked(id) {
      const tweet = values.get(id);
      if (!tweet) return [];
      const conversationId = tweet.content?.conversationId;
      const included = new Map([[tweet.id, tweet]]);
      for (let pass = 0; pass < values.size; pass++) {
        const before = included.size;
        for (const value of values.values()) {
          if ((conversationId && value.content?.conversationId === conversationId)
              || (value.relations?.replyToId && included.has(value.relations.replyToId))
              || [...included.values()].some((other) => other.relations?.replyToId === value.id)) included.set(value.id, value);
        }
        if (before === included.size) break;
      }
      return [...included.values()];
    }
    try {
      credentials(input);
      const id = kind === 'members' ? input.listId : input.id;
      if (typeof id !== 'string' || !/^[1-9]\d{0,31}$/.test(id)) throw failure('INVALID_INPUT');
      const queryKind = input.kind || 'detail';
      if (kind !== 'members' && !['detail', 'thread'].includes(queryKind)) throw failure('INVALID_INPUT');
      if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)) throw failure('INVALID_INPUT');
      const extraLimit = input.limit ?? 50;
      busy = true; binding = fingerprint(input);
      session = await acquire(input, binding);
      const storage = evidenceFactory(), runId = crypto.randomUUID();
      const pageLimit = kind !== 'members' && queryKind === 'detail' ? 1 : maxPages;
      const pending = [{ id }];
      let complete = true, truncated = false;
      for (let page = 1; page <= pageLimit && pending.length; page++) {
        const next = pending.shift();
        const identity = next.id + ':' + (next.cursor || '');
        if (seen.has(identity)) throw failure('CURSOR_LOOP');
        seen.add(identity);
        const response = await request(session, kind === 'members'
          ? { op: 'list_members', listId: id, count: 50, ...(next.cursor ? { cursor: next.cursor } : {}) }
          : { op: queryKind, tweetId: next.id, ...(next.cursor ? { cursor: next.cursor } : {}) }, rates, kind === 'members' ? 'ListMembers' : 'TweetDetail');
        save(storage, evidence, response.data, runId, page, kind + ':' + id, kind, input);
        classify(response, kind === 'members' ? 'ListMembers' : 'TweetDetail');
        const parsed = kind === 'members' ? pageParser.parseListMembersPage(response.data, id) : pageParser.parseDetailPage(response.data);
        for (const value of kind === 'members' ? parsed.users : parsed.tweets) {
          if (kind === 'members') {
            if (values.has(value.id) && values.get(value.id).username.toLowerCase() !== value.username.toLowerCase()) throw failure('POST_CONFLICT');
            values.set(value.id, value);
          } else values.set(value.id, parser.mergeTweet(values.get(value.id), value));
        }
        if (values.size > 500) throw failure('RESPONSE_TOO_LARGE');
        const continuations = parsed.nextCursors ?? (parsed.nextCursor ? [parsed.nextCursor] : []);
        for (const cursor of continuations) {
          const candidate = next.id + ':' + cursor;
          if (seen.has(candidate) || pending.some((item) => item.id + ':' + (item.cursor || '') === candidate)) throw failure('CURSOR_LOOP');
          pending.push({ id: next.id, cursor });
        }
        if (!parsed.exhausted && !continuations.length) complete = false;
        if (kind !== 'members') {
          if (page === 1 && !values.has(id)) throw failure('TWEET_UNAVAILABLE');
          const related = linked(id);
          if (queryKind === 'thread' && related.length >= extraLimit + 1) { truncated = true; complete = false; break; }
          const rootId = values.get(id)?.content?.conversationId;
          if (queryKind === 'thread' && rootId && rootId !== id && !values.has(rootId)
              && !seen.has(rootId + ':') && !pending.some((item) => item.id === rootId)) pending.unshift({ id: rootId });
        }
      }
      complete &&= pending.length === 0;
      healthy = true;
      if (kind === 'members') return { ok: true, members: [...values.values()], users: [...values.values()], complete, evidence, ...responseRates(rates) };
      const tweet = values.get(id);
      if (!tweet) throw failure('TWEET_UNAVAILABLE');
      const related = linked(id);
      truncated ||= related.length > extraLimit + 1 || pending.length > 0;
      if (truncated) complete = false;
      const visible = related.slice(0, extraLimit + 1);
      return { ok: true, tweet, tweets: visible, thread: visible, complete, truncated, evidence, ...responseRates(rates) };
    } catch (error) { const safe = failure(error.code); return { ok: false, code: safe.code, error: safe.message, evidence, ...responseRates(rates), ...failedOperation(error) }; }
    finally { release(session, binding, healthy); busy = false; }
  }
  function ackCatchup(key) {
    const value = catchupStore?.load(key);
    if (!value) return;
    if (!value.completed) throw failure('CATCHUP_CHECKPOINT_CHANGED');
    catchupStore.remove(key);
  }
  function getCatchups() { return catchupStore ? catchupStore.list() : {}; }
  function resetCatchup(key) {
    if (busy) throw failure('COLLECTOR_BUSY');
    catchupStore?.remove(key);
  }
  function pruneCatchups(activeKeys) {
    if (busy) return;
    const active = new Set(activeKeys);
    for (const key of Object.keys(getCatchups())) if (!active.has(key)) catchupStore.remove(key);
  }
  function close() { for (const key of [...sessions.keys()]) dropSession(key); users.clear(); }
  return { fetchTweets, inspectTweet: (input) => inspect(input, 'tweet'), listMembers: (input) => inspect(input, 'members'),
    ackCatchup, getCatchups, getDiagnostics: getCatchups, pruneCatchups, resetCatchup, close };
}

const collector = createCollector({ catchupStore: catchups.createCatchupStore(), reuseSessions: true, userCacheTtl: 900000 });
function detectTwscrape() {
  return new Promise((resolve) => {
    execFile(PYTHON, ['-I', BRIDGE, '--version'], { cwd: ROOT, env: environment(), timeout: 5000,
      killSignal: 'SIGKILL', maxBuffer: 4096 }, (error, stdout) => {
      let info;
      try { info = JSON.parse(stdout); } catch (_) {}
      if (error || info?.protocol !== 1 || info?.sourceCommit !== SOURCE_COMMIT) {
        resolve({ found: false, path: BRIDGE, version: null });
      } else resolve({ found: true, path: BRIDGE, version: info.version, sourceCommit: SOURCE_COMMIT });
    });
  });
}

module.exports = { ...collector, detectTwscrape, createCollector, PythonSession, SOURCE_COMMIT, sourceKey, normalizeSource, sourceOperation, validProxy, safeRateLimit };
