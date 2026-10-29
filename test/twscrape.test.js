'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCollector } = require('../lib/twscrape');

const input = { username: 'example', authToken: 'FAKE_AUTH_VALUE', ct0: 'FAKE_CSRF_VALUE', count: 20 };
function tweet(id, text = id) {
  return { id, text, time: '2026-10-23T00:00:00Z', url: `https://x.com/example/status/${id}`,
    name: 'example', is_rt: false, is_pinned: false,
    relations: { replyToId: null, quoteId: null, repostId: null, editIds: [id] } };
}
function page(ids, nextCursor = 'next', extra = {}) {
  return { tweets: ids.map((id) => tweet(id)), nextCursor, exhausted: nextCursor === null, boundaryIds: ids, ...extra };
}
function rawPage(ids, cursor, { omitProfile = false, repostBody } = {}) {
  const entries = ids.map((id) => {
    const result = { __typename: 'Tweet', rest_id: id,
      legacy: { id_str: id, user_id_str: '42', full_text: `Tweet ${id}`, created_at: 'Fri Oct 23 10:00:00 +0000 2026' } };
    if (!omitProfile) result.core = { user_results: { result: { __typename: 'User', rest_id: '42',
      core: { screen_name: 'example', name: 'Example Display Name' } } } };
    if (repostBody !== undefined) {
      result.legacy.full_text = 'RT @bob: Preview…';
      result.legacy.retweeted_status_id_str = '90';
      if (repostBody !== null) result.legacy.retweeted_status_result = {
        result: { rest_id: '90', legacy: { full_text: repostBody } },
      };
    }
    return { entryId: `tweet-${id}`, content: { itemContent: { itemType: 'TimelineTweet', tweet_results: { result } } } };
  });
  entries.push({ content: { cursorType: 'Bottom', value: cursor } });
  return { data: { user: { result: { timeline: { timeline: { instructions: [
    { type: 'TimelineAddEntries', entries },
  ] } } } } } };
}
function parsedPage(ids, cursor, options) {
  const { parseTimelinePage } = require('../lib/twscrape-timeline');
  return parseTimelinePage(rawPage(ids, cursor, options), { username: 'example', userId: '42' });
}
function harness(pages, options = {}) {
  const requests = [], persisted = [];
  let closed = 0, parsed = 0, pageIndex = 0;
  const instance = createCollector({
    policy: { blocked: () => null },
    sessionFactory: () => ({
      async request(request) {
        requests.push(request);
        if (options.request) await options.request(request);
        if (request.op === 'init') return { ok: true, protocol: 1 };
        if (request.op === 'user') return { ok: true, data: { user: 'example' } };
        const data = pages[pageIndex++];
        if (data instanceof Error) throw data;
        return { ok: true, data };
      },
      close() { closed++; },
    }),
    evidenceFactory: () => ({ persist(record) {
      if (options.persist) options.persist(record);
      persisted.push(record);
      return { file: `page-${record.page}`, sha256: 'synthetic' };
    } }),
    pageParser: {
      parseUser(data) {
        assert.equal(persisted.at(-1).data, data);
        return { id: '42', username: 'example' };
      },
      parseTimelinePage(data) {
        parsed++;
        assert.equal(persisted.at(-1).data, data, 'persist full response before parsing boundaries');
        if (options.parse) return options.parse(data);
        return data;
      },
    },
    maxPages: options.maxPages || 5,
  });
  return { ...instance, requests, persisted, get closed() { return closed; }, get parsed() { return parsed; } };
}

test('initial snapshot retains the whole received page even when requested count is one', async () => {
  const h = harness([page(['105', '104', '103'])]);
  const result = await h.fetchTweets({ ...input, count: 1 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.tweets.map((t) => t.id), ['105', '104', '103']);
  assert.equal(result.coverage.reason, 'initial-snapshot');
  assert.equal(h.persisted.length, 2);
  assert.equal(h.closed, 1);
  assert.equal(h.requests[2].count, 1);
});

test('catchup persists every complete page and includes the complete boundary page', async () => {
  const h = harness([page(['110', '109'], 'a'), page(['108', '107'], 'b'), page(['106', '105', '104'], 'c')]);
  const result = await h.fetchTweets({ ...input, sinceId: '105' });
  assert.equal(result.ok, true);
  assert.equal(result.coverage.reachedSince, true);
  assert.equal(result.coverage.oldestId, '104');
  assert.equal(result.tweets.length, 7);
  assert.equal(h.requests[3].cursor, 'a');
  assert.equal(h.requests[4].cursor, 'b');
});

test('pins and modules cannot stop catchup and an empty terminal page is meaningful', async () => {
  const h = harness([page(['1'], 'a', { boundaryIds: [] }), page(['120'], 'b'), page([], null)]);
  const result = await h.fetchTweets({ ...input, sinceId: '100' });
  assert.equal(result.ok, true);
  assert.equal(result.coverage.exhausted, true);
  assert.equal(result.coverage.reachedSince, false);
  assert.equal(result.coverage.pages, 3);
});

test('a pin-only initial page cannot establish the first chronological baseline', async () => {
  const h = harness([page(['1'], 'a', { boundaryIds: [] }), page(['120', '119'], 'b')]);
  const result = await h.fetchTweets(input);
  assert.equal(result.ok, true);
  assert.equal(result.coverage.pages, 2);
  assert.deepEqual(result.tweets.map((item) => item.id), ['1', '120', '119']);
});

test('initial pages with only pins, modules or empty cursors fail when no chronological boundary is reached', async () => {
  for (const ids of [['1'], []]) {
    const h = harness([page(ids, 'a', { boundaryIds: [] }), page(ids, 'b', { boundaryIds: [] })], { maxPages: 2 });
    const result = await h.fetchTweets(input);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INCOMPLETE_COVERAGE');
    assert.equal(result.tweets, null);
    assert.equal(result.coverage.complete, false);
    assert.equal(result.evidence.length, 3);
  }
});

test('budget exhaustion returns failure and no partial post list or checkpoint', async () => {
  const h = harness([page(['120'], 'a'), page(['119'], 'b')], { maxPages: 2 });
  const result = await h.fetchTweets({ ...input, sinceId: '100' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INCOMPLETE_COVERAGE');
  assert.equal(result.tweets, null);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.evidence.length, 3);
});

test('later transport failure preserves earlier evidence without accepting partial coverage', async () => {
  const h = harness([page(['120'], 'a'), Object.assign(new Error('SECRET ERROR'), { code: 'RATE_LIMITED' })]);
  const result = await h.fetchTweets({ ...input, sinceId: '100' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RATE_LIMITED');
  assert.equal(result.evidence.length, 2);
  assert.equal(result.tweets, null);
  assert.doesNotMatch(JSON.stringify(result), /SECRET ERROR/);
});

test('explicitly truncated bodies prevent both baseline and catchup checkpoints while preserving full page evidence', async () => {
  const { parseTimelinePage } = require('../lib/twscrape-timeline');
  for (const sinceId of [undefined, '100']) {
    const incomplete = rawPage(['110', '100'], 'b');
    const truncated = incomplete.data.user.result.timeline.timeline.instructions[0].entries[0].content.itemContent.tweet_results.result;
    truncated.legacy.full_text = 'Preview only…';
    truncated.legacy.truncated = true;
    const h = harness([...(sinceId ? [rawPage(['120'], 'a')] : []), incomplete], {
      parse: (data) => parseTimelinePage(data, { username: 'example', userId: '42' }),
    });
    const result = await h.fetchTweets({ ...input, sinceId });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID_PAGE');
    assert.equal(result.tweets, null);
    assert.equal(result.coverage.complete, false);
    assert.equal(result.coverage.reachedSince, false);
    assert.equal(result.coverage.newestId, undefined, 'no partial checkpoint escapes the failed round');
    assert.equal(result.evidence.length, sinceId ? 3 : 2);
    assert.equal(h.persisted.at(-1).data, incomplete);
    assert.equal(h.closed, 1);
  }
});

test('evidence persistence failure prevents parsing and further requests', async () => {
  const h = harness([page(['120'], 'a')], { persist(record) { if (record.page === 1) throw new Error('disk full'); } });
  const result = await h.fetchTweets(input);
  assert.equal(result.code, 'EVIDENCE_WRITE');
  assert.equal(h.parsed, 0);
  assert.equal(h.closed, 1);
});

test('all previously seen cursors are tracked, including A to B to A cycles', async () => {
  for (const pages of [[page(['120'], 'a'), page(['119'], 'a')],
    [page(['120'], 'a'), page(['119'], 'b'), page(['118'], 'a')]]) {
    const h = harness(pages);
    const result = await h.fetchTweets({ ...input, sinceId: '100' });
    assert.equal(result.code, 'CURSOR_LOOP');
    assert.equal(result.tweets, null);
  }
});

test('content changes under the same id stop the round rather than being silently deduplicated', async () => {
  const h = harness([page(['120'], 'a'), page(['120', '99'], 'b', { tweets: [tweet('120', 'changed'), tweet('99')] })]);
  const result = await h.fetchTweets({ ...input, sinceId: '100' });
  assert.equal(result.code, 'POST_CONFLICT');
});

test('new chronological IDs cannot run backward across page boundaries', async () => {
  const h = harness([page(['120', '119'], 'a'), page(['125', '100'], 'b')]);
  const result = await h.fetchTweets({ ...input, sinceId: '100' });
  assert.equal(result.code, 'INVALID_PAGE');
  assert.equal(result.tweets, null);
});

test('identical overlap across pages and a pin seen again chronologically keep full identity', async () => {
  const pinned = { ...tweet('120'), is_pinned: true };
  const h = harness([page(['120', '125'], 'a', { tweets: [pinned, tweet('125')], boundaryIds: ['125'] }),
    page(['125', '120'], 'b'), page(['100'], null)]);
  const result = await h.fetchTweets({ ...input, sinceId: '100' });
  assert.equal(result.ok, true);
  assert.equal(result.tweets.length, 3);
  assert.equal(result.tweets.find((item) => item.id === '120').is_pinned, false);
});

test('actual parser output merges omitted author profiles across pages while preserving coverage and known names', async () => {
  for (const firstOmitted of [true, false]) {
    const h = harness([parsedPage(['120'], 'a', { omitProfile: firstOmitted }),
      parsedPage(['120', '100'], 'b', { omitProfile: !firstOmitted })]);
    const result = await h.fetchTweets({ ...input, sinceId: '100' });
    assert.equal(result.ok, true);
    assert.equal(result.coverage.reachedSince, true);
    assert.equal(result.coverage.pages, 2);
    assert.equal(result.tweets.length, 2);
    assert.equal(result.tweets.find((value) => value.id === '120').name, 'Example Display Name');
  }
});

test('cross-page repost enrichment preserves the complete body and rejects conflicting known originals', async () => {
  for (const firstBody of [null, 'Complete original']) {
    const h = harness([parsedPage(['120'], 'a', { repostBody: firstBody }),
      parsedPage(['120', '100'], 'b', { repostBody: firstBody === null ? 'Complete original' : null })]);
    const result = await h.fetchTweets({ ...input, sinceId: '100' });
    assert.equal(result.ok, true);
    assert.equal(result.coverage.reachedSince, true);
    assert.equal(result.tweets.find((value) => value.id === '120').text, 'RT @bob: Complete original');
  }
  const h = harness([parsedPage(['120'], 'a', { repostBody: 'Original body' }),
    parsedPage(['120', '100'], 'b', { repostBody: 'Changed body' })]);
  const result = await h.fetchTweets({ ...input, sinceId: '100' });
  assert.equal(result.code, 'POST_CONFLICT');
  assert.equal(result.tweets, null);
  assert.equal(result.coverage.complete, false);
});

test('concurrent manual requests share a bounded single collector slot', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const h = harness([page(['120'])], { request: (req) => req.op === 'init' ? held : undefined });
  const first = h.fetchTweets(input);
  const second = await h.fetchTweets(input);
  assert.equal(second.code, 'COLLECTOR_BUSY');
  release();
  assert.equal((await first).ok, true);
});

test('invalid credentials and IDs are rejected before starting a child', async () => {
  const h = harness([]);
  for (const patch of [{ username: '../etc/passwd' }, { authToken: 'x\r\nCookie:y' }, { ct0: 'x;other=y' },
    { sinceId: 12345678901234567890 }, { sinceId: '-1' }, { authToken: 'x'.repeat(4097) }]) {
    assert.equal((await h.fetchTweets({ ...input, ...patch })).code, 'INVALID_INPUT');
  }
  assert.equal(h.requests.length, 0);
});

test('parser exception contents cannot leak credentials into result diagnostics', async () => {
  const h = harness([page(['120'])], { parse() { throw new Error(input.authToken); } });
  const result = await h.fetchTweets(input);
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /FAKE_AUTH_VALUE/);
});
