'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const runtime = require('./runtime');
const { createEvidenceStore } = require('./evidence');
const parser = require('./twscrape-timeline');

const ROOT = path.resolve(__dirname, '..');
const PYTHON = path.join(ROOT, '.venv', 'bin', 'python');
const BRIDGE = path.join(ROOT, 'collector', 'bridge.py');
const SOURCE_COMMIT = '63f61a518e576ea5c132f1156c03dda0520d76c1';
const MAX_LINE_BYTES = 12 * 1024 * 1024;
const MAX_PAGES = 5;
const MAX_POSTS = 500;
const TIMEOUT_MS = 90000;
const ID_RE = /^\d{1,32}$/;
const MESSAGES = Object.freeze({
  COLLECTOR_MISSING: 'Python 采集器未安装，请运行 npm run collector:install',
  COLLECTOR_BUSY: '采集器正在处理另一项请求，请稍后重试',
  COLLECTOR_TIMEOUT: '采集超过时间预算，未推进水位',
  COLLECTOR_PROTOCOL: '采集器响应协议不正确，未推进水位',
  COLLECTOR_EXIT: '采集进程异常结束，未推进水位',
  INVALID_INPUT: '账号、Cookie 或水位格式不正确',
  EVIDENCE_WRITE: '原始页证据未能安全落盘，未推进水位',
  CURSOR_LOOP: '时间线游标重复或循环，未推进水位',
  INCOMPLETE_COVERAGE: '本轮页数预算未覆盖上次水位，未推进水位；增加每页条数后仍失败时需核对积压并安排补采',
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
      if (!data.ok) pending.reject(failure(data.code));
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
}

function createCollector({ sessionFactory = () => new PythonSession(), evidenceFactory = () => createEvidenceStore(),
  pageParser = parser, policy = runtime, maxPages = MAX_PAGES } = {}) {
  let busy = false;
  async function fetchTweets({ username, count, authToken, ct0, sinceId } = {}) {
    const blocked = policy.blocked('collection');
    if (blocked) return { ...blocked, tweets: null, raw: '' };
    if (busy) return { ok: false, tweets: null, code: 'COLLECTOR_BUSY', error: MESSAGES.COLLECTOR_BUSY, raw: '' };
    const credentialOK = (value) => typeof value === 'string' && /^[A-Za-z0-9_%.-]{1,4096}$/.test(value);
    if (!/^[A-Za-z0-9_]{1,15}$/.test(username || '') || !credentialOK(authToken) || !credentialOK(ct0)
      || (sinceId !== undefined && (typeof sinceId !== 'string' || !ID_RE.test(sinceId)))) {
      return { ok: false, tweets: null, code: 'INVALID_INPUT', error: MESSAGES.INVALID_INPUT, raw: '' };
    }
    busy = true;
    let session;
    const evidence = [];
    const runId = crypto.randomUUID();
    try {
      session = sessionFactory();
      const initialized = await session.request({ op: 'init', authToken, ct0 });
      if (initialized.protocol !== 1) throw failure('COLLECTOR_PROTOCOL');
      const storage = evidenceFactory();
      function save(data, page, operation) {
        try { evidence.push(storage.persist({ runId, page, username, operation, data, secrets: [authToken, ct0] })); }
        catch (_) { throw failure('EVIDENCE_WRITE'); }
      }
      const profile = await session.request({ op: 'user', username });
      save(profile.data, 0, 'user');
      const user = pageParser.parseUser(profile.data, username);
      const tweets = new Map();
      const cursors = new Set();
      const boundaries = new Set();
      let cursor;
      let oldestId = null;
      let newestId = null;
      for (let page = 1; page <= maxPages; page++) {
        const response = await session.request({ op: 'timeline', userId: user.id,
          count: Math.min(50, Math.max(1, Number.parseInt(count, 10) || 20)), ...(cursor ? { cursor } : {}) });
        save(response.data, page, 'timeline');
        const parsed = pageParser.parseTimelinePage(response.data, { username: user.username, userId: user.id });
        if (parsed.nextCursor && cursors.has(parsed.nextCursor)) throw failure('CURSOR_LOOP');
        for (const tweet of parsed.tweets) {
          const previous = tweets.get(tweet.id);
          tweets.set(tweet.id, parser.mergeTweet(previous, tweet));
        }
        if (tweets.size > MAX_POSTS) throw failure('RESPONSE_TOO_LARGE');
        for (const id of parsed.boundaryIds) {
          if (!boundaries.has(id) && oldestId !== null && BigInt(id) > BigInt(oldestId)) throw failure('INVALID_PAGE');
          boundaries.add(id);
          if (newestId === null || BigInt(id) > BigInt(newestId)) newestId = id;
          if (oldestId === null || BigInt(id) < BigInt(oldestId)) oldestId = id;
        }
        const reachedSince = sinceId !== undefined && parsed.boundaryIds.some((id) => BigInt(id) <= BigInt(sinceId));
        // Pins and conversation modules do not establish a chronological
        // baseline either. Keep paging until an ordinary row or a true end.
        if ((sinceId === undefined && parsed.boundaryIds.length > 0) || reachedSince || parsed.exhausted) {
          return { ok: true, tweets: [...tweets.values()], coverage: { complete: true,
            exhausted: parsed.exhausted, reachedSince, oldestId, newestId, pages: page,
            reason: reachedSince ? 'reached-since' : parsed.exhausted ? 'exhausted' : 'initial-snapshot' },
          evidence, error: null, raw: '' };
        }
        if (!parsed.nextCursor) throw failure('INVALID_PAGE');
        cursors.add(parsed.nextCursor);
        cursor = parsed.nextCursor;
      }
      throw failure('INCOMPLETE_COVERAGE');
    } catch (error) {
      const safe = failure(error.code);
      return { ok: false, tweets: null, code: safe.code, error: safe.message, raw: '', evidence,
        coverage: { complete: false, exhausted: false, reachedSince: false, oldestId: null } };
    } finally {
      if (session) session.close();
      busy = false;
    }
  }
  return { fetchTweets };
}

const collector = createCollector();
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

module.exports = { ...collector, detectTwscrape, createCollector, PythonSession, SOURCE_COMMIT };
