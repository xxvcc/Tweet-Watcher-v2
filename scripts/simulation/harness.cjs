'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { fork, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const sourceKey = require('../../lib/collector-source').sourceKey;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, { timeout = 20000, interval = 10, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  do { const result = await check(); if (result) return result; await delay(interval); } while (Date.now() < end);
  throw new Error('Timed out waiting for ' + label);
}
function idAt(ms = Date.now(), sequence = 0) { return (((BigInt(ms) - 1288834974657n) << 22n) + BigInt(sequence)).toString(); }
function author(username = 'alice', id) {
  id ||= (BigInt('0x' + createHash('sha256').update(username).digest('hex').slice(0, 12)) + 1n).toString();
  return { __typename: 'User', rest_id: String(id), core: { screen_name: username, name: username },
    legacy: { screen_name: username, name: username } };
}
function tweet(id, username = 'alice', extra = {}) {
  const user = author(username);
  const { text = 'Synthetic update ' + id, lang = 'en', media, quote, article, replyTo, ...rest } = extra;
  const legacy = { id_str: String(id), user_id_str: user.rest_id, full_text: text, lang,
    created_at: 'Fri Oct 30 01:00:00 +0000 2026', conversation_id_str: String(replyTo || id),
    ...(replyTo ? { in_reply_to_status_id_str: String(replyTo), in_reply_to_user_id_str: user.rest_id } : {}),
    ...(media ? { extended_entities: { media } } : {}),
    ...(quote ? { quoted_status_id_str: quote.rest_id } : {}), ...rest.legacy };
  return { __typename: 'Tweet', rest_id: String(id), ...rest, legacy,
    core: { user_results: { result: user } },
    ...(quote ? { quoted_status_result: { result: quote } } : {}),
    ...(article ? { article: { article_results: { result: article } } } : {}) };
}
function page(tweets, cursor = null, type = 'user', identity = 'alice') {
  const entries = tweets.map((t) => ({ entryId: 'tweet-' + t.rest_id,
    content: { itemContent: { itemType: 'TimelineTweet', tweet_results: { result: t } } } }));
  if (cursor) entries.push({ entryId: 'cursor-bottom', content: { cursorType: 'Bottom', value: cursor } });
  const instructions = [{ type: 'TimelineAddEntries', entries }];
  if (!cursor) instructions.push({ type: 'TimelineTerminateTimeline', direction: 'Bottom' });
  if (type === 'list') return { data: { list: { rest_id: identity, tweets_timeline: { timeline: { instructions } } } } };
  if (type === 'search') return { data: { search_by_raw_query: { search_timeline: { timeline: { instructions } } } } };
  if (type === 'detail') return { data: { threaded_conversation_with_injections_v2: { instructions } } };
  return { data: { user: { result: { rest_id: author(identity).rest_id, timeline: { timeline: { instructions } } } } } };
}
async function createSimulation({ name = 'scenario', config = {}, secrets = {}, fastPacing = true, runtimeMode = 'live' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'twv2-simulation-'));
  const dataDir = path.join(directory, 'data'); fs.mkdirSync(dataDir, { mode: 0o700 });
  const cert = path.join(directory, 'cert.pem'), key = path.join(directory, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=x.com', '-addext', 'subjectAltName=DNS:x.com,DNS:abs.twimg.com,DNS:ai.sim.test,DNS:api.telegram.org,IP:127.0.0.1'], { stdio: 'ignore' });
  const h = { name, directory, dataDir, cert, sources: new Map(), details: new Map(), members: new Map(),
    events: [], accepted: [], childEvents: [], forbidden: [], password: 'Synthetic-simulation-only-2026',
    config: { accounts: [{ username: 'alice', fetch_count: 20, check_interval: 30 }], paused: false,
      tg_chat_id: '123456', media_mode: 'all', enrichment_mode: 'off', enrichment_limit: 2,
      ai_translation_enabled: true, ai_base_url: 'https://ai.sim.test/v1', ai_model: 'simulation-model',
      x_sessions: [], ...config },
    secrets: { auth_token: 'SYNTHETIC_default', ct0: 'SYNTHETIC_CSRF_default',
      tg_bot_token: '123456:SYNTHETIC_BOT', ai_api_key: 'SYNTHETIC_AI_KEY', ...secrets },
  };
  let sequence = 0, messageId = 1, child, requestId = 0, offset = 0;
  const pending = new Map(), pythonPids = new Set(), sockets = new Set();
  const event = (type, info) => { const value = { seq: ++sequence, at: Date.now(), type, ...info }; h.events.push(value); return value; };
  function findUser(id) {
    for (const [key, values] of h.sources) {
      if (/^(user|replies):/.test(key) && author(key.split(':')[1]).rest_id === id) return key.split(':')[1];
      for (const value of values) if (value.core?.user_results?.result?.rest_id === id) return value.core.user_results.result.core.screen_name;
    }
    return id === author('alice').rest_id ? 'alice' : 'unknown';
  }
  async function respond(req, res) {
    const url = new URL(req.url, 'https://x.com');
    const host = req.headers['x-simulation-host'] || String(req.headers.host).split(':')[0];
    if (!['x.com', 'abs.twimg.com', 'api.telegram.org', 'ai.sim.test'].includes(host)) throw new Error('Unexpected emulator host');
    if (host === 'abs.twimg.com' || (host === 'x.com' && !url.pathname.includes('/i/api/graphql/'))) {
      if (host === 'abs.twimg.com' && (req.headers.cookie || req.headers.authorization || req.headers['x-csrf-token'])) throw new Error('Credentials leaked to asset');
      const filename = host === 'x.com' ? 'bootstrap.html' : 'sign.o-simulation.js';
      const body = fs.readFileSync(path.join(__dirname, filename));
      event('bootstrap', { host, path: url.pathname });
      res.writeHead(200, { 'content-type': host === 'x.com' ? 'text/html' : 'application/javascript' }); res.end(body); return;
    }
    let chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    let call, result;
    if (host === 'x.com') {
      const operation = url.pathname.split('/').at(-1);
      const variables = JSON.parse(url.searchParams.get('variables') || '{}');
      const session = /SYNTHETIC_backup/.test(req.headers.cookie || '') ? 'backup' : 'default';
      const type = operation === 'ListLatestTweetsTimeline' ? 'list' : operation === 'SearchTimeline' ? 'search' : 'user';
      let query = String(variables.rawQuery || '');
      if (/\s+since_id:\d+$/.test(query)) {
        query = query.replace(/\s+since_id:\d+$/, '');
        if (query.startsWith('(') && query.endsWith(')')) query = query.slice(1, -1);
      }
      const identity = type === 'list' ? variables.listId : type === 'search' ? query : findUser(variables.userId);
      const key = (operation === 'UserTweetsAndReplies' ? 'replies' : type) + ':' + identity;
      call = event('x', { operation, variables, session, sourceKey: key,
        signed: !!req.headers['x-client-transaction-id'] });
      if (!call.signed) throw new Error('Real Python signer did not sign request');
      result = await h.xFault?.(call);
      if (!result) {
        let body;
        if (operation === 'UserByScreenName') body = { data: { user: { result: author(variables.screen_name) } } };
        else if (operation === 'TweetDetail') {
          const values = h.details.get(variables.focalTweetId)
            || [...h.sources.values()].flat().filter((t) => t.rest_id === variables.focalTweetId);
          body = page(values, null, 'detail');
        } else if (operation === 'ListMembers') {
          const values = h.members.get(variables.listId) || [author('alice'), author('bob')];
          body = { data: { list: { rest_id: variables.listId, members_timeline: { timeline: { instructions: [
            { type: 'TimelineAddEntries', entries: values.map((user) => ({ entryId: 'user-' + user.rest_id,
              content: { itemContent: { itemType: 'TimelineUser', user_results: { result: user } } } })) },
            { type: 'TimelineTerminateTimeline', direction: 'Bottom' },
          ] } } } } };
        } else {
          const values = h.sources.get(key) || [];
          const start = variables.cursor ? Number(String(variables.cursor).split(':')[1]) : 0;
          const size = h.pageSize || variables.count || 20;
          const end = start + size;
          body = page(values.slice(start, end), end < values.length ? 'page:' + end : null, type, identity);
        }
        result = { body };
      }
      result.headers = { 'x-rate-limit-remaining': '100000', 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 60), ...result.headers };
    } else if (host === 'ai.sim.test') {
      const body = JSON.parse(raw);
      call = event('ai', { body, method: req.method, path: url.pathname });
      result = await h.aiFault?.(call);
      if (!result) result = { body: { choices: [{ finish_reason: 'stop', message: { role: 'assistant',
        content: body.messages.at(-1).content === 'hi' ? '你好，拟真服务已收到。' : '中文拟真译文：' + body.messages.at(-1).content } }] } };
    } else {
      const fields = Object.fromEntries(new URLSearchParams(raw));
      call = event('telegram', { method: url.pathname.split('/').at(-1), fields, body: fields, accepted: false });
      result = await h.tgFault?.(call);
      if (!result) result = { body: { ok: true, result: call.method === 'sendMediaGroup'
        ? JSON.parse(fields.media).map(() => ({ message_id: messageId++ })) : { message_id: messageId++ } } };
      if (result.accept || ((result.status || 200) < 300 && result.body?.ok === true)) {
        call.accepted = true; h.accepted.push(call);
      }
    }
    call.status = result.status || 200;
    if (result.delayMs) await delay(result.delayMs);
    if (result.disconnect) { res.destroy(); return; }
    res.writeHead(result.status || 200, { 'content-type': 'application/json', ...result.headers });
    res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? {}));
    call.respondedAt = Date.now();
  }
  const server = https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, (req, res) => {
    respond(req, res).catch((error) => { event('emulator-error', { error: error.message }); res.writeHead(500); res.end('{}'); });
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
  h.tlsPort = server.address().port;
  h.read = (filename) => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, filename), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  h.rpc = (op, payload = {}) => new Promise((resolve, reject) => {
    if (op === 'advance') offset += payload.ms || 0;
    const id = ++requestId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Simulation RPC timed out: ' + op)); }, 120000);
    pending.set(id, { resolve, reject, timer });
    if (!child?.connected) { clearTimeout(timer); pending.delete(id); reject(new Error('Simulation child is not running')); return; }
    child.send({ id, op, payload });
  });
  h.start = async ({ autoStart = false } = {}) => {
    if (child && child.exitCode === null && child.signalCode === null) throw new Error('Simulation child already running');
    const options = { dataDir, cert, tlsPort: h.tlsPort, config: h.config, secrets: h.secrets, password: h.password,
      fastPacing, offset, autoStart };
    const file = path.join(directory, 'options.json'); fs.writeFileSync(file, JSON.stringify(options), { mode: 0o600 });
    child = fork(path.join(__dirname, 'child.cjs'), [file], { cwd: root,
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8', DATA_DIR: dataDir, TW_RUNTIME_MODE: runtimeMode,
        NODE_EXTRA_CA_CERTS: cert, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    h.child = child;
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Simulation startup timed out')), 15000);
      child.on('message', (msg) => {
        if (msg.event === 'ready') { clearTimeout(timer); h.baseUrl = 'http://127.0.0.1:' + msg.port; resolve(h); }
        if (msg.event === 'fatal') { clearTimeout(timer); reject(new Error(msg.error)); }
        if (msg.event === 'python') pythonPids.add(msg.pid);
        if (msg.event === 'python-exit') pythonPids.delete(msg.pid);
        if (msg.event === 'blocked-network') h.forbidden.push(msg);
        if (msg.event) h.childEvents.push(msg);
        if (msg.id && pending.has(msg.id)) {
          const item = pending.get(msg.id); pending.delete(msg.id); clearTimeout(item.timer);
          if (msg.ok) item.resolve(msg.result); else item.reject(Object.assign(new Error(msg.error), { code: msg.code }));
        }
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer); reject(new Error(`Simulation child exited ${code}/${signal}`));
        for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(`Simulation child exited ${code}/${signal}`)); }
        pending.clear();
        for (const pid of pythonPids) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} } pythonPids.clear();
      });
    });
    return ready;
  };
  h.tick = async (advanceMs = 31000, opts = {}) => { offset += advanceMs; return h.rpc('tick', { advanceMs, ...opts }); };
  h.kill = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((r) => child.once('exit', r)); child.kill('SIGKILL'); await exited;
    }
  };
  h.restart = async () => { await h.kill(); return h.start(); };
  h.close = async () => {
    if (child?.connected) { try { await h.rpc('close'); } catch (_) {} }
    await h.kill(); for (const socket of sockets) socket.destroy();
    await new Promise((r) => server.close(r));
    fs.rmSync(directory, { recursive: true, force: true });
  };
  return h;
}
module.exports = { createSimulation, tweet, author, page, sourceKey, idAt, waitFor, delay };
