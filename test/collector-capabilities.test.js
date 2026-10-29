'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createCollector, sourceKey, normalizeSource, validProxy } = require('../lib/twscrape');
const { createCatchupStore, MAX_AGE } = require('../lib/collector-catchup');
const { createEvidenceStore } = require('../lib/evidence');
const parser = require('../lib/twscrape-timeline');
const input = { username: 'alice', authToken: 'SYNTHETIC_AUTH_ONLY', ct0: 'SYNTHETIC_CSRF_ONLY', count: 20, sessionId: 'session_A' };
const author = (id = '42', username = 'alice') => ({ __typename: 'User', rest_id: id, core: { screen_name: username, name: username } });
const tweet = (id, username = 'alice') => ({ __typename: 'Tweet', rest_id: id, legacy: { id_str: id, user_id_str: username === 'alice' ? '42' : '43', full_text: `post ${id}`, created_at: 'Fri Oct 23 10:00:00 +0000 2026' }, core: { user_results: { result: author(username === 'alice' ? '42' : '43', username) } } });
const entry = (value) => ({ entryId: `tweet-${value.rest_id}`, content: { itemContent: { itemType: 'TimelineTweet', tweet_results: { result: value } } } });
const cursor = (value, type = 'Bottom') => ({ content: { cursorType: type, value } });
function page(ids, nextCursor = 'next', type = 'user', extras = []) {
  const entries = ids.map((id) => entry(typeof id === 'string' ? tweet(id) : id));
  if (nextCursor) entries.push(cursor(nextCursor));
  const instructions = [{ type: 'TimelineAddEntries', entries }, ...extras];
  if (nextCursor === null) instructions.push({ type: 'TimelineTerminateTimeline', direction: 'Bottom' });
  if (type === 'list') return { data: { list: { rest_id: '123', tweets_timeline: { timeline: { instructions } } } } };
  if (type === 'search') return { data: { search_by_raw_query: { search_timeline: { timeline: { instructions } } } } };
  if (type === 'detail') return { data: { threaded_conversation_with_injections_v2: { instructions } } };
  return { data: { user: { result: { rest_id: '42', timeline: { timeline: { instructions } } } } } };
}
function privateState(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'twv2-catchup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = directory;
  delete require.cache[require.resolve('../lib/store')];
  const priorListeners = process.stderr.listeners('error');
  const storage = require('../lib/store');
  t.after(() => { for (const listener of process.stderr.listeners('error')) if (!priorListeners.includes(listener)) process.stderr.removeListener('error', listener); });
  if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
  return { directory, storage, store: createCatchupStore({ directory, storage }) };
}
function harness(pages, options = {}) {
  const requests = [], sessions = [], persisted = [];
  const h = createCollector({ policy: { blocked: () => null }, maxPages: options.maxPages || 1,
    catchupStore: options.store || null, reuseSessions: options.reuse || false, userCacheTtl: options.cache || 0,
    sessionFactory: () => {
      const s = { closed: false, begins: 0, finishes: 0,
        async request(request) {
          requests.push(request);
          if (options.request) await options.request(request);
          if (request.op === 'init') return { ok: true, protocol: 1 };
          if (request.op === 'user') return { ok: true, data: { data: { user: { result: author() } } } };
          const value = pages.shift();
          if (value instanceof Error) throw value;
          assert.ok(value, 'unexpected upstream request');
          return value.response || { ok: true, data: value };
        },
        close() { s.closed = true; },
        async beginRound() { s.begins++; },
        finishRound() { s.finishes++; },
      }; sessions.push(s); return s;
    },
    evidenceFactory: () => options.directory ? createEvidenceStore(options.directory) : { persist(value) {
      persisted.push(value);
      return { file: 'synthetic', sha256: createHash('sha256').update(JSON.stringify(value.data)).digest('hex') };
    } },
  });
  return { ...h, requests, sessions, persisted };
}

test('canonical sources preserve exact query identity and reject malformed proxies', () => {
  assert.equal(sourceKey({ username: 'Alice' }), 'alice');
  assert.equal(sourceKey({ username: 'Alice', timeline_mode: 'replies' }), 'replies:alice');
  assert.equal(sourceKey({ source_type: 'list', list_id: '123' }), 'list:123');
  assert.notEqual(sourceKey({ source_type: 'search', query: 'hello' }), sourceKey({ source_type: 'search', query: ' hello' }));
  for (const value of [{ source_type: 'search', query: '\ud800' }, { source_type: 'list', list_id: '0' }, { username: 'a', timeline_mode: 'other' }]) assert.throws(() => normalizeSource(value));
  for (const proxy of ['', 'http://proxy.test:80', 'https://proxy.test:443/', 'http://[::1]:8080']) assert.equal(validProxy(proxy), true, proxy);
  for (const proxy of ['http://proxy.test', 'http://a:b@proxy.test:80', '\0http://proxy.test:80', 'http://proxy.test:80\x7f', 'http://\ud800:80', 'http://proxy.test:0']) assert.equal(validProxy(proxy), false, proxy);
});

test('persistent catchup resumes after collector restart and survives ordinary evidence eviction until acknowledgement', async (t) => {
  const state = privateState(t);
  let h = harness([page(['120', '119'], 'A')], state);
  const first = await h.fetchTweets({ ...input, sinceId: '100' });
  assert.equal(first.code, 'INCOMPLETE_COVERAGE');
  assert.equal(first.tweets, null);
  assert.equal(h.getCatchups().alice.pages, 1);
  assert.equal(fs.statSync(path.join(state.directory, fs.readdirSync(state.directory).find((f) => f.startsWith('catchup-')))).mode & 0o777, 0o600);
  for (const name of fs.readdirSync(state.directory).filter((f) => f.startsWith('evidence-'))) fs.unlinkSync(path.join(state.directory, name));
  h = harness([page(['118', '100', '99'], 'B')], state);
  const result = await h.fetchTweets({ ...input, sinceId: '100' });
  assert.equal(result.ok, true, result.error);
  assert.equal(h.requests.some((r) => r.op === 'user'), false);
  assert.equal(h.requests.find((r) => r.op === 'timeline').cursor, 'A');
  assert.deepEqual(result.tweets.map((t) => t.id), ['120', '119', '118', '100', '99']);
  assert.equal(result.coverage.newestId, '120');
  assert.equal(h.getCatchups().alice.status, 'ready');
  const replay = harness([], state);
  assert.equal((await replay.fetchTweets({ ...input, sinceId: '100' })).ok, true);
  assert.equal(replay.requests.length, 0, 'completed staging retries outbox capture without any upstream request');
  replay.ackCatchup('alice');
  assert.deepEqual(replay.getCatchups(), {});
});

test('crash after outbox capture permits cleanup only at the matching completed checkpoint', async (t) => {
  const state = privateState(t);
  const h = harness([page(['120', '100'], 'A'), page(['121', '120'], 'B')], state);
  assert.equal((await h.fetchTweets({ ...input, sinceId: '100' })).ok, true);
  const mismatch = await h.fetchTweets({ ...input, sinceId: '119' });
  assert.equal(mismatch.code, 'CATCHUP_CHECKPOINT_CHANGED');
  const result = await h.fetchTweets({ ...input, sinceId: '120' });
  assert.equal(result.ok, true);
  assert.equal(result.coverage.newestId, '121');
});

test('unfinished stages bind credentials, proxy, session identity and original checkpoint', async (t) => {
  const state = privateState(t);
  const h = harness([page(['120'], 'A')], state);
  await h.fetchTweets({ ...input, sinceId: '100' });
  const requests = h.requests.length;
  for (const change of [{ authToken: 'OTHER_AUTH' }, { proxy: 'http://proxy.test:8080' }, { sessionId: 'session_B' }]) {
    assert.equal((await h.fetchTweets({ ...input, sinceId: '100', ...change })).code, 'CATCHUP_SESSION_CHANGED');
  }
  assert.equal((await h.fetchTweets({ ...input, sinceId: '99' })).code, 'CATCHUP_CHECKPOINT_CHANGED');
  assert.equal(h.requests.length, requests);
  assert.throws(() => h.ackCatchup('alice'), { code: 'CATCHUP_CHECKPOINT_CHANGED' });
  h.resetCatchup('alice');
  assert.deepEqual(h.getCatchups(), {});
});

test('page, cursor and manifest corruption fail before any network and never erase evidence', async (t) => {
  const state = privateState(t);
  const h = harness([page(['120'], 'A')], state);
  await h.fetchTweets({ ...input, sinceId: '100' });
  const name = fs.readdirSync(state.directory).find((f) => f.startsWith('catchup-'));
  const original = JSON.parse(fs.readFileSync(path.join(state.directory, name)));
  for (const mutate of [(v) => v.pages[0].data.data = {}, (v) => v.pages.pop(), (v) => { v.cursor = 'wrong'; }, (v) => { v.sessionId = '<script>'; }]) {
    const broken = structuredClone(original); mutate(broken); state.storage.writeJSON(name, broken);
    const resumed = harness([], state);
    assert.equal((await resumed.fetchTweets({ ...input, sinceId: '100' })).code, 'CATCHUP_CORRUPT');
    assert.equal(resumed.requests.length, 0);
    assert.ok(fs.existsSync(path.join(state.directory, name)));
  }
});

test('catchup expiration requires explicit reset and cursor loops are remembered across rounds', async (t) => {
  const state = privateState(t);
  const h = harness([page(['120'], 'A'), page(['119'], 'B'), page(['118'], 'A')], state);
  await h.fetchTweets({ ...input, sinceId: '100' });
  const stage = state.store.load('alice');
  stage.startedAt = Date.now() - MAX_AGE - 1;
  state.store.save(stage);
  assert.equal((await h.fetchTweets({ ...input, sinceId: '100' })).code, 'CATCHUP_EXPIRED');
  stage.startedAt = Date.now(); stage.updatedAt = stage.startedAt; state.store.save(stage);
  assert.equal((await h.fetchTweets({ ...input, sinceId: '100' })).code, 'INCOMPLETE_COVERAGE');
  assert.equal((await h.fetchTweets({ ...input, sinceId: '100' })).code, 'CURSOR_LOOP');
  assert.equal(state.store.load('alice').cursor, 'B');
});

test('failed stage commit preserves old durable cursor and exposes no partial tweet list', async (t) => {
  const state = privateState(t);
  const h = harness([page(['120'], 'A')], state);
  await h.fetchTweets({ ...input, sinceId: '100' });
  const brokenStore = createCatchupStore({ directory: state.directory, storage: { ...state.storage, writeJSON() { throw new Error('SYNTHETIC_AUTH_ONLY disk failed'); } } });
  const resumed = harness([page(['119', '100'], 'B')], { ...state, store: brokenStore });
  const result = await resumed.fetchTweets({ ...input, sinceId: '100' });
  assert.equal(result.code, 'CATCHUP_WRITE');
  assert.equal(result.tweets, null);
  assert.equal(state.store.load('alice').cursor, 'A');
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_AUTH_ONLY/);
});

test('capacity failure does not evict protected pages or advance the durable cursor', async (t) => {
  const state = privateState(t);
  const h = harness([page(['120'], 'A')], state);
  await h.fetchTweets({ ...input, sinceId: '100' });
  const huge = page(['119'], 'B'); huge.padding = 'x'.repeat(6 * 1024 * 1024);
  const resumed = harness([huge], state);
  const result = await resumed.fetchTweets({ ...input, sinceId: '100' });
  assert.equal(result.code, 'CATCHUP_CAPACITY');
  assert.equal(state.store.load('alice').pages.length, 1);
});

test('successful last-quota page can complete; incomplete catchup stops before a second rate-limited request', async (t) => {
  const rateLimit = { operation: 'UserTweets', remaining: 0, resetAt: Date.now() + 60000 };
  const done = harness([{ response: { ok: true, data: page(['120', '100'], 'A'), rateLimit } }], { maxPages: 3 });
  const result = await done.fetchTweets({ ...input, sinceId: '100' });
  assert.equal(result.ok, true); assert.deepEqual(result.rateLimits, [rateLimit]);
  const state = privateState(t);
  const h = harness([{ response: { ok: true, data: page(['120'], 'A'), rateLimit } }], { ...state, maxPages: 3 });
  const limited = await h.fetchTweets({ ...input, sinceId: '100' });
  assert.equal(limited.code, 'RATE_LIMITED'); assert.deepEqual(limited.rateLimit, rateLimit);
  assert.equal(h.requests.filter((r) => r.op === 'timeline').length, 1);
  assert.equal(state.store.load('alice').pages.length, 1);
});

test('GraphQL errors are durably saved and classified without accepting partial data', async () => {
  const data = { ...page(['120'], 'A'), errors: [{ code: 89, message: 'SYNTHETIC_AUTH_ONLY' }] };
  const h = harness([{ response: { ok: true, data, responseError: 'AUTH_REQUIRED' } }]);
  const result = await h.fetchTweets(input);
  assert.equal(result.code, 'AUTH_REQUIRED'); assert.equal(result.tweets, null);
  assert.equal(h.persisted.at(-1).data, data);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_AUTH_ONLY/);
});

test('source operations route replies, list and search without unnecessary profile requests', async () => {
  for (const [source, type, op] of [[{ source_type: 'user', username: 'alice', timeline_mode: 'replies' }, 'user', 'replies'],
    [{ source_type: 'list', list_id: '123' }, 'list', 'list'], [{ source_type: 'search', query: 'from:alice "hello"' }, 'search', 'search']]) {
    const h = harness([page(['120'], 'A', type)]);
    const result = await h.fetchTweets({ ...input, source });
    assert.equal(result.ok, true, result.error);
    assert.equal(h.requests.at(-1).op, op);
    assert.equal(h.requests.some((r) => r.op === 'user'), type === 'user');
  }
});

test('search re-discovers late indexed IDs in a bounded 24-hour overlap and declares discovery coverage', async () => {
  const old = 2111520482914877569n;
  const recent = String(old - 1000n), next = String(old + 1000n);
  const h = harness([page([next, recent], null, 'search')]);
  const result = await h.fetchTweets({ ...input, source: { source_type: 'search', query: 'topic OR from:alice' }, sinceId: String(old) });
  assert.equal(result.ok, true); assert.equal(result.coverage.discovery, true);
  assert.equal(result.coverage.windowStartId, String(old - (86400000n << 22n)));
  assert.ok(result.tweets.some((t) => t.id === recent));
  assert.equal(h.requests.at(-1).query, `(topic OR from:alice) since_id:${result.coverage.windowStartId}`);
});

test('list/search require complete embedded authors and reject mismatched list identity', () => {
  const data = page([tweet('120'), tweet('119', 'bob')], 'A', 'list');
  const result = parser.parseSourcePage(data, { source_type: 'list', list_id: '123' });
  assert.deepEqual(result.tweets.map((t) => t.author_username), ['alice', 'bob']);
  assert.deepEqual(result.boundaryIds, ['120', '119']);
  assert.throws(() => parser.parseSourcePage(data, { source_type: 'list', list_id: '124' }), { code: 'IDENTITY_MISMATCH' });
  delete data.data.list.tweets_timeline.timeline.instructions[0].entries[1].content.itemContent.tweet_results.result.core;
  assert.throws(() => parser.parseSourcePage(data, { source_type: 'list', list_id: '123' }));
});

test('reply modules cannot establish a boundary until explicit exhaustion', async () => {
  const module = { content: { items: [tweet('120'), tweet('119', 'bob')].map((value) => ({ item: { itemContent: entry(value).content.itemContent } })) } };
  const data = page([], 'A'); data.data.user.result.timeline.timeline.instructions[0].entries.unshift(module);
  const h = harness([data]);
  assert.equal((await h.fetchTweets({ ...input, source: { username: 'alice', timeline_mode: 'replies' } })).code, 'INCOMPLETE_COVERAGE');
  const ended = page([], null); ended.data.user.result.timeline.timeline.instructions[0].entries.push(module);
  const result = await harness([ended]).fetchTweets({ ...input, source: { username: 'alice', timeline_mode: 'replies' } });
  assert.equal(result.ok, true); assert.equal(result.coverage.newestId, '120');
});

test('detail and thread preserve requested identity and include only linked conversation records', async () => {
  const focal = tweet('120'); focal.legacy.conversation_id_str = '118'; focal.legacy.in_reply_to_status_id_str = '118';
  const parent = tweet('118'); parent.legacy.conversation_id_str = '118';
  const sibling = tweet('121', 'bob'); sibling.legacy.conversation_id_str = '118'; sibling.legacy.in_reply_to_status_id_str = '120';
  const h = harness([page([focal, parent, sibling, tweet('999')], null, 'detail')]);
  const result = await h.inspectTweet({ ...input, id: '120', kind: 'thread' });
  assert.equal(result.ok, true, result.error); assert.equal(result.tweet.id, '120');
  assert.deepEqual(result.tweets.map((v) => v.id), ['120', '118', '121']);
  const missing = await harness([page(['121'], null, 'detail')]).inspectTweet({ ...input, id: '120' });
  assert.equal(missing.ok, false);
});

test('list member queries retain verified string identities with bounded continuation', async () => {
  const data = { data: { list: { rest_id: '123', members_timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [
    { content: { itemContent: { itemType: 'TimelineUser', user_results: { result: author() } } } }, cursor('A'),
  ] }] } } } } };
  const h = harness([data]);
  const result = await h.listMembers({ ...input, listId: '123' });
  assert.equal(result.ok, true); assert.equal(result.complete, false);
  assert.deepEqual(result.members, [{ id: '42', username: 'alice', name: 'alice' }]);
  assert.equal(h.requests.at(-1).op, 'list_members');
});

test('bounded Python-session and user-ID reuse remains scoped to credentials and proxy', async (t) => {
  const h = harness(Array.from({ length: 11 }, () => page(['120'], 'A')), { reuse: true, cache: 900000 });
  t.after(h.close);
  for (let n = 0; n < 9; n++) assert.equal((await h.fetchTweets(input)).ok, true);
  assert.equal(h.sessions.length, 2); assert.equal(h.sessions[0].closed, true);
  assert.equal(h.sessions[0].begins, 7);
  assert.equal(h.requests.filter((r) => r.op === 'user').length, 1);
  await h.fetchTweets({ ...input, authToken: 'ANOTHER_AUTH' });
  await h.fetchTweets({ ...input, proxy: 'http://proxy.test:80' });
  assert.equal(h.sessions.length, 4);
  assert.equal(h.requests.filter((r) => r.op === 'user').length, 3);
});

test('active collector prevents resetting or pruning an in-flight stage', async (t) => {
  const state = privateState(t);
  const start = harness([page(['120'], 'A')], state);
  await start.fetchTweets({ ...input, sinceId: '100' });
  let release, started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const h = harness([page(['119', '100'], 'B')], { ...state, request: async (r) => {
    if (r.op === 'timeline') { started(); await new Promise((resolve) => { release = resolve; }); }
  } });
  const pending = h.fetchTweets({ ...input, sinceId: '100' });
  await waiting;
  assert.throws(() => h.resetCatchup('alice'), { code: 'COLLECTOR_BUSY' });
  h.pruneCatchups([]); assert.ok(state.store.load('alice'));
  release(); assert.equal((await pending).ok, true);
  h.pruneCatchups([]); assert.equal(state.store.load('alice'), null);
});

test('zero checkpoint is supported while source IDs remain positive strings', async (t) => {
  const state = privateState(t);
  const h = harness([page(['120'], null)], state);
  assert.equal((await h.fetchTweets({ ...input, sinceId: '0' })).ok, true);
  assert.equal(state.store.load('alice').sinceId, '0');
});

test('thread limit stops after parsing the entire current page and returns explicit truncation', async () => {
  const focal = tweet('120'); focal.legacy.conversation_id_str = '120';
  const replies = ['121', '122', '123'].map((id) => { const value = tweet(id, 'bob'); value.legacy.conversation_id_str = '120'; return value; });
  const h = harness([page([focal, ...replies], 'A', 'detail')], { maxPages: 5 });
  const result = await h.inspectTweet({ ...input, id: '120', kind: 'thread', limit: 1 });
  assert.equal(result.ok, true); assert.equal(result.complete, false); assert.equal(result.truncated, true);
  assert.deepEqual(result.tweets.map((v) => v.id), ['120', '121']);
  assert.equal(h.requests.filter((r) => r.op === 'thread').length, 1);
  assert.equal(h.persisted[0].data.data.threaded_conversation_with_injections_v2.instructions[0].entries.length, 5);
});

test('thread root is fetched only after verified target metadata and shares the page budget', async () => {
  const focal = tweet('120'); focal.legacy.conversation_id_str = '118'; focal.legacy.in_reply_to_status_id_str = '118';
  const root = tweet('118'); root.legacy.conversation_id_str = '118';
  const h = harness([page([focal], null, 'detail'), page([root], null, 'detail')], { maxPages: 3 });
  const result = await h.inspectTweet({ ...input, id: '120', kind: 'thread', limit: 5 });
  assert.equal(result.ok, true); assert.equal(result.complete, true);
  assert.deepEqual(h.requests.filter((r) => r.op === 'thread').map((r) => r.tweetId), ['120', '118']);
  assert.deepEqual(result.tweets.map((v) => v.id), ['120', '118']);
});

test('detail accepts a valid focal response without claiming an absent thread boundary', async () => {
  const data = page(['120'], 'A', 'detail');
  data.data.threaded_conversation_with_injections_v2.instructions[0].entries.pop();
  const result = await harness([data]).inspectTweet({ ...input, id: '120' });
  assert.equal(result.ok, true); assert.equal(result.complete, false);
});

test('multiple detail continuations remain explicit, bounded and checked for loops', async () => {
  const data = page(['120'], 'A', 'detail');
  data.data.threaded_conversation_with_injections_v2.instructions[0].entries.push(cursor('B', 'ShowMoreThreads'));
  assert.deepEqual(parser.parseDetailPage(data).nextCursors, ['A', 'B']);
  const h = harness([data, page(['120'], 'A', 'detail')], { maxPages: 3 });
  assert.equal((await h.inspectTweet({ ...input, id: '120', kind: 'thread' })).code, 'CURSOR_LOOP');
});

test('credential echoes are redacted inside protected raw evidence and replayed content', async (t) => {
  const state = privateState(t);
  const first = page(['120'], 'A'); first.data.user.result.timeline.timeline.instructions[0].entries[0].content.itemContent.tweet_results.result.legacy.full_text = input.authToken;
  const h = harness([first, page(['100'], 'B')], state);
  await h.fetchTweets({ ...input, sinceId: '100' });
  const stateText = fs.readdirSync(state.directory).map((name) => fs.readFileSync(path.join(state.directory, name), 'utf8')).join('');
  assert.doesNotMatch(stateText, /SYNTHETIC_AUTH_ONLY/);
  const result = await h.fetchTweets({ ...input, sinceId: '100' });
  assert.equal(result.ok, true); assert.equal(result.tweets[0].text, '[REDACTED]');
});

test('user-ID cache expires and Python reuse ends at the age bound', async (t) => {
  const realNow = Date.now; let time = realNow(); Date.now = () => time;
  const h = harness([page(['120'], 'A'), page(['120'], 'A'), page(['120'], 'A')], { reuse: true, cache: 1000 });
  t.after(() => { Date.now = realNow; h.close(); });
  await h.fetchTweets(input);
  time += 1001; await h.fetchTweets(input);
  assert.equal(h.requests.filter((r) => r.op === 'user').length, 2);
  assert.equal(h.sessions.length, 1);
  time += 180000; await h.fetchTweets(input);
  assert.equal(h.sessions.length, 2); assert.equal(h.sessions[0].closed, true);
});

test('quota zero without a valid reset still stops further same-operation requests', async () => {
  const rateLimit = { operation: 'UserTweets', remaining: 0, resetAt: null };
  const h = harness([{ response: { ok: true, data: page(['120'], 'A'), rateLimit } }], { maxPages: 5 });
  const result = await h.fetchTweets({ ...input, sinceId: '100' });
  assert.equal(result.code, 'RATE_LIMITED'); assert.deepEqual(result.rateLimit, rateLimit);
  assert.equal(h.requests.filter((r) => r.op === 'timeline').length, 1);
});

test('request failures name the fixed failed operation even when rate headers are absent', async () => {
  const scenarios = [
    { op: 'user', expected: 'UserByScreenName', invoke: (h) => h.fetchTweets(input) },
    { op: 'timeline', expected: 'UserTweets', invoke: (h) => h.fetchTweets(input) },
    { op: 'replies', expected: 'UserTweetsAndReplies', invoke: (h) => h.fetchTweets({ ...input, source: { username: 'alice', timeline_mode: 'replies' } }) },
    { op: 'list', expected: 'ListLatestTweetsTimeline', invoke: (h) => h.fetchTweets({ ...input, source: { source_type: 'list', list_id: '123' } }) },
    { op: 'search', expected: 'SearchTimeline', invoke: (h) => h.fetchTweets({ ...input, source: { source_type: 'search', query: 'hello' } }) },
    { op: 'detail', expected: 'TweetDetail', invoke: (h) => h.inspectTweet({ ...input, id: '120' }) },
    { op: 'list_members', expected: 'ListMembers', invoke: (h) => h.listMembers({ ...input, listId: '123' }) },
  ];
  for (const { op, expected, invoke } of scenarios) {
    const h = harness([], { request: async (r) => {
      if (r.op === op) throw Object.assign(new Error('SYNTHETIC_AUTH_ONLY private diagnostics'), { code: 'RATE_LIMITED', failedOperation: 'UNTRUSTED_RESPONSE_VALUE' });
    } });
    const result = await invoke(h);
    assert.equal(result.code, 'RATE_LIMITED'); assert.equal(result.failedOperation, expected);
    assert.equal(result.rateLimit, undefined);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_AUTH_ONLY|UNTRUSTED_RESPONSE_VALUE/);
  }
});

test('successful-HTTP GraphQL failures and quota prechecks retain fixed operation attribution', async () => {
  const h = harness([{ response: { ok: true, data: page(['120'], 'A'), responseError: 'RATE_LIMITED' } }]);
  const result = await h.fetchTweets(input);
  assert.equal(result.failedOperation, 'UserTweets');
  assert.equal(h.persisted.length, 2, 'full GraphQL response is persisted before classification');
  const limited = harness([{ response: { ok: true, data: page(['120'], 'A'), rateLimit: { operation: 'UserTweets', remaining: 0, resetAt: null } } }], { maxPages: 5 });
  assert.equal((await limited.fetchTweets({ ...input, sinceId: '100' })).failedOperation, 'UserTweets');
});

test('local-only mode replays a ready stage with no Python session or state mutation', async (t) => {
  const state = privateState(t);
  const prepare = harness([page(['120', '100'], 'A')], state);
  const online = await prepare.fetchTweets({ ...input, sinceId: '100' });
  assert.equal(online.ok, true);
  const before = fs.readdirSync(state.directory).map((name) => [name, fs.readFileSync(path.join(state.directory, name), 'utf8')]);
  const local = harness([], state);
  const replay = await local.fetchTweets({ ...input, sinceId: '100', localOnly: true });
  assert.equal(replay.ok, true); assert.deepEqual(replay.tweets, online.tweets); assert.deepEqual(replay.coverage, online.coverage);
  assert.equal(replay.catchup.status, 'ready'); assert.equal(local.sessions.length, 0); assert.equal(local.requests.length, 0);
  assert.equal(replay.failedOperation, undefined); assert.equal(replay.rateLimits, undefined);
  assert.deepEqual(fs.readdirSync(state.directory).map((name) => [name, fs.readFileSync(path.join(state.directory, name), 'utf8')]), before);
});

test('local-only mode fails closed without acquiring a session when a network round would be needed', async (t) => {
  const state = privateState(t);
  const empty = harness([], state);
  assert.equal((await empty.fetchTweets({ ...input, sinceId: '100', localOnly: true })).code, 'CATCHUP_NOT_READY');
  assert.equal(empty.sessions.length, 0);
  const noStore = harness([]);
  assert.equal((await noStore.fetchTweets({ ...input, localOnly: true })).code, 'CATCHUP_NOT_READY');
  assert.equal(noStore.sessions.length, 0);
  await harness([page(['120'], 'A')], state).fetchTweets({ ...input, sinceId: '100' });
  const incomplete = harness([], state);
  assert.equal((await incomplete.fetchTweets({ ...input, sinceId: '100', localOnly: true })).code, 'CATCHUP_NOT_READY');
  assert.equal(incomplete.sessions.length, 0); assert.equal(state.store.load('alice').cursor, 'A');
  await harness([page(['100'], 'B')], state).fetchTweets({ ...input, sinceId: '100' });
  const ready = harness([], state);
  assert.equal((await ready.fetchTweets({ ...input, sinceId: '120', localOnly: true })).ok, true);
  assert.equal((await ready.fetchTweets({ ...input, sinceId: '100', catchup: false, localOnly: true })).code, 'CATCHUP_NOT_READY');
  assert.equal(ready.sessions.length, 0); assert.equal(state.store.load('alice').completed, true, 'local-only calls never delete an acknowledged-but-not-cleaned stage');
});

test('local-only replay still rejects invalid binding, checkpoint, expired or corrupt evidence without networking', async (t) => {
  const state = privateState(t);
  await harness([page(['120', '100'], 'A')], state).fetchTweets({ ...input, sinceId: '100' });
  const h = harness([], state);
  assert.equal((await h.fetchTweets({ ...input, authToken: 'OTHER_CREDENTIAL', sinceId: '100', localOnly: true })).code, 'CATCHUP_SESSION_CHANGED');
  assert.equal((await h.fetchTweets({ ...input, sinceId: '99', localOnly: true })).code, 'CATCHUP_CHECKPOINT_CHANGED');
  const stage = state.store.load('alice'); stage.startedAt = Date.now() - MAX_AGE - 1; state.store.save(stage);
  assert.equal((await h.fetchTweets({ ...input, sinceId: '100', localOnly: true })).code, 'CATCHUP_EXPIRED');
  const name = fs.readdirSync(state.directory).find((f) => f.startsWith('catchup-'));
  const broken = JSON.parse(fs.readFileSync(path.join(state.directory, name))); broken.pages[0].sha256 = 'invalid'; state.storage.writeJSON(name, broken);
  assert.equal((await h.fetchTweets({ ...input, sinceId: '100', localOnly: true })).code, 'CATCHUP_CORRUPT');
  assert.equal(h.sessions.length, 0); assert.equal(h.requests.length, 0);
});

test('local-only replay recovers a committed checkpoint after capture-before-ack without network or premature deletion', async (t) => {
  const state = privateState(t);
  const initial = await harness([page(['120', '100'], 'A')], state).fetchTweets({ ...input, sinceId: '100' });
  assert.equal(initial.coverage.newestId, '120');
  const file = fs.readdirSync(state.directory).find((name) => name.startsWith('catchup-'));
  const before = fs.readFileSync(path.join(state.directory, file), 'utf8');
  const restarted = harness([], state);
  const replay = await restarted.fetchTweets({ ...input, sinceId: '120', localOnly: true });
  assert.equal(replay.ok, true, replay.error);
  assert.deepEqual(replay.tweets, initial.tweets); assert.deepEqual(replay.coverage, initial.coverage);
  assert.equal(restarted.sessions.length, 0); assert.equal(restarted.requests.length, 0);
  assert.equal(fs.readFileSync(path.join(state.directory, file), 'utf8'), before);
  restarted.ackCatchup('alice'); assert.equal(state.store.load('alice'), null);
});

test('committed-checkpoint local replay verifies newest ID from the protected pages before accepting stored metadata', async (t) => {
  const state = privateState(t);
  await harness([page(['120', '100'], 'A')], state).fetchTweets({ ...input, sinceId: '100' });
  const stage = state.store.load('alice'); stage.coverage.newestId = '121'; state.store.save(stage);
  const h = harness([], state);
  const result = await h.fetchTweets({ ...input, sinceId: '121', localOnly: true });
  assert.equal(result.code, 'CATCHUP_CORRUPT'); assert.equal(result.tweets, null);
  assert.equal(h.sessions.length, 0); assert.equal(h.requests.length, 0); assert.ok(state.store.load('alice'));
});

test('committed-checkpoint search replay retains the original overlap window', async (t) => {
  const state = privateState(t);
  const source = { source_type: 'search', query: 'topic' };
  const old = 2111520482914877569n, latest = String(old + 1000n), late = String(old - 1000n);
  const initial = await harness([page([latest, late], null, 'search')], state).fetchTweets({ ...input, source, sinceId: String(old) });
  const h = harness([], state);
  const result = await h.fetchTweets({ ...input, source, sinceId: latest, localOnly: true });
  assert.equal(result.ok, true, result.error); assert.deepEqual(result.tweets, initial.tweets);
  assert.equal(result.coverage.windowStartId, initial.coverage.windowStartId);
  assert.equal(h.sessions.length, 0); assert.equal(h.requests.length, 0);
});
