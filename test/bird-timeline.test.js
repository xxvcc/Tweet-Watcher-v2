'use strict';
const test = require('node:test');
// All clients below use synthetic responses. Keep the default deny policy in
// production code, and bypass it only for these inherited parser contracts.
test.mock.method(require('../lib/runtime'), 'blocked', () => null);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const adapter = import('../lib/bird-timeline.mjs');
const tweet = (id) => ({ __typename: 'Tweet', rest_id: String(id),
  legacy: { full_text: `Tweet ${id}`, created_at: 'Thu Oct 22 10:00:00 +0000 2026' },
  core: { user_results: { result: { rest_id: '10', legacy: { screen_name: 'alice', name: 'Alice' } } } },
});
const entry = (result) => ({ content: { itemContent: { itemType: 'TimelineTweet', tweet_results: { result } } } });
const bottom = (value) => ({ content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value } });
const page = (entries, extra = [], cursor = 'next') => ({ data: { user: { result: {
  __typename: 'User', timeline: { timeline: { instructions: [
    { type: 'TimelineAddEntries', entries: [...entries, ...(cursor ? [bottom(cursor)] : [])] }, ...extra,
  ] } },
} } } });
function fakeClient(pages) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async getUserIdByUsername() { return { success: true, userId: '10', username: 'alice' }; },
    async getQueryId() { return 'offlineQuery'; },
    getHeaders() { return {}; },
    async refreshQueryIds() { assert.fail('unexpected query refresh'); },
    async fetchWithTimeout() {
      const current = pages[Math.min(calls++, pages.length - 1)];
      return { ok: true, status: 200, json: async () => current };
    },
  };
}

test('strict parser retains pin entries, visibility wrappers and module tweets', async () => {
  const { parseTimelinePage } = await adapter;
  const wrapped = { __typename: 'TweetWithVisibilityResults', tweet: tweet('12') };
  const module = { content: { items: [{ item: { itemContent: entry(tweet('11')).content.itemContent } }] } };
  const result = parseTimelinePage(page([entry(wrapped), module], [
    { type: 'TimelinePinEntry', entry: entry(tweet('1')) },
  ]));
  assert.deepEqual(result.tweets.map((t) => t.id), ['12', '11', '1']);
  assert.equal(result.tweets[2].is_pinned, true);
  assert.equal(result.oldestId, '12', 'old pin/module context cannot prove chronological coverage');
  assert.equal(result.exhausted, false);
});

test('duplicate pin and normal occurrence retain normal coverage', async () => {
  const { parseTimelinePage } = await adapter;
  const fixture = page([entry(tweet('5'))], [{ type: 'TimelinePinEntry', entry: entry(tweet('5')) }]);
  const result = parseTimelinePage(fixture);
  assert.equal(result.tweets.length, 1);
  assert.equal(result.tweets[0].is_pinned, false);
  assert.equal(result.oldestId, '5');
});

test('pin context on an ordinary entry cannot establish historical coverage', async () => {
  const { parseTimelinePage } = await adapter;
  const pin = entry(tweet('1'));
  pin.content.itemContent.socialContext = { contextType: 'Pin' };
  const result = parseTimelinePage(page([pin, entry(tweet('9'))]));
  assert.equal(result.oldestId, '9');
  assert.equal(result.tweets[0].is_pinned, true);
});

test('absent and unavailable timelines fail while explicit empty timelines succeed', async () => {
  const { parseTimelinePage } = await adapter;
  for (const fixture of [{}, { data: { user: { result: { __typename: 'UserUnavailable' } } } },
    { data: { user: { result: { timeline: { timeline: { instructions: [] } } } } } }]) {
    assert.throws(() => parseTimelinePage(fixture), /Incomplete X timeline/);
  }
  const result = parseTimelinePage(page([], [], null));
  assert.deepEqual(result.tweets, []);
  assert.equal(result.exhausted, true);
});

test('nonempty pages without a bottom boundary never become empty timeline success', async () => {
  const { parseTimelinePage } = await adapter;
  const user = { content: { itemContent: { itemType: 'TimelineUser', user_results: {
    result: { __typename: 'User', rest_id: '10' },
  } } } };
  const top = { content: { cursorType: 'Top', value: 'top' } };
  for (const entries of [[user], [top], [{ content: { items: [] } }]]) {
    assert.throws(() => parseTimelinePage(page(entries, [], null)), /Incomplete X timeline/);
  }
  const moduleUpdate = { type: 'TimelineAddToModule', moduleItems: [
    { item: { itemContent: entry(tweet('5')).content.itemContent } },
  ] };
  assert.throws(() => parseTimelinePage(page([], [moduleUpdate], null)), /missing page boundary/);
  assert.equal(parseTimelinePage(page([user], [{ type: 'TimelineTerminateTimeline', direction: 'Bottom' }], null)).exhausted, true);
});

test('one malformed entry or GraphQL partial response rejects the entire page', async () => {
  const { parseTimelinePage } = await adapter;
  const noAuthor = tweet('3'); delete noAuthor.core;
  const noTime = tweet('3'); delete noTime.legacy.created_at;
  const noText = tweet('3'); delete noText.legacy.full_text;
  const unsafeId = tweet('3'); unsafeId.rest_id = Number.MAX_SAFE_INTEGER + 1;
  for (const bad of [entry(noAuthor), entry(noTime), entry(noText), entry(unsafeId),
    entry({ __typename: 'TweetWithVisibilityResults' }),
    entry({ __typename: 'TweetTombstone' }),
    { content: { itemContent: { itemType: 'TimelineTweet' } } },
    { content: { items: [null] } }]) {
    assert.throws(() => parseTimelinePage(page([entry(tweet('4')), bad])), /Incomplete X timeline/);
  }
  const partial = page([entry(tweet('4'))]); partial.errors = [{ message: 'Partial failure' }];
  assert.throws(() => parseTimelinePage(partial), /GraphQL errors/);
  assert.throws(() => parseTimelinePage(page([entry(tweet('4'))], [], null)), /missing page boundary/);
  assert.throws(() => parseTimelinePage(page([], [{ type: 'UnknownInstructions', entries: [entry(tweet('4'))] }])));
});

test('fetch retains complete pages including items beyond requested count', async () => {
  const { fetchTimeline } = await adapter;
  const client = fakeClient([page([entry(tweet('4')), entry(tweet('3'))])]);
  const result = await fetchTimeline(client, { username: 'alice', count: 1 });
  assert.deepEqual(result.tweets.map((t) => t.id), ['4', '3']);
  assert.equal(result.coverage.complete, true);
  assert.equal(client.calls, 1);
});

test('initial snapshot follows pin-only pages and rejects a bounded empty nonterminal window', async () => {
  const { fetchTimeline } = await adapter;
  const pin = { type: 'TimelinePinEntry', entry: entry(tweet('1')) };
  const client = fakeClient([page([], [pin], 'page2'), page([entry(tweet('9'))], [], 'page3')]);
  const result = await fetchTimeline(client, { username: 'alice', count: 1 });
  assert.equal(client.calls, 2);
  assert.deepEqual(result.tweets.map((t) => t.id), ['1', '9']);
  assert.equal(result.coverage.oldestId, '9');
  const empty = fakeClient(Array.from({ length: 10 }, (_, i) => page([], [], `cursor${i}`)));
  await assert.rejects(fetchTimeline(empty, { username: 'alice', count: 1 }), /missing chronological boundary/);
  const pinsOnly = fakeClient(Array.from({ length: 10 }, (_, i) => page([], [pin], `cursor${i}`)));
  await assert.rejects(fetchTimeline(pinsOnly, { username: 'alice', count: 1 }), /missing chronological boundary/);
});

test('catch-up follows pages to previous watermark without using old pins', async () => {
  const { fetchTimeline } = await adapter;
  const client = fakeClient([
    page([entry(tweet('5'))], [{ type: 'TimelinePinEntry', entry: entry(tweet('1')) }], 'page2'),
    page([entry(tweet('4')), entry(tweet('3'))], [], 'page3'),
  ]);
  const result = await fetchTimeline(client, { username: 'alice', count: 1, sinceId: '3' });
  assert.equal(client.calls, 2);
  assert.deepEqual(result.tweets.map((t) => t.id), ['5', '1', '4', '3']);
  assert.equal(result.coverage.reachedSince, true);
  assert.equal(result.coverage.oldestId, '3');
});

test('later partial page fails the full fetch and cannot expose an earlier cursor', async () => {
  const { fetchTimeline } = await adapter;
  const client = fakeClient([page([entry(tweet('5'))]), {}]);
  await assert.rejects(fetchTimeline(client, { username: 'alice', count: 1, sinceId: '3' }), /Incomplete X timeline/);
  assert.equal(client.calls, 2);
});

test('bounded catch-up exposes an unresolved gap and repeated cursors fail closed', async () => {
  const { fetchTimeline } = await adapter;
  const client = fakeClient(Array.from({ length: 10 }, (_, i) => page([entry(tweet(String(30 - i)))], [], `cursor${i}`)));
  const result = await fetchTimeline(client, { username: 'alice', count: 1, sinceId: '1' });
  assert.equal(client.calls, 10);
  assert.equal(result.coverage.reachedSince, false);
  assert.equal(result.coverage.exhausted, false);
  const repeated = fakeClient([page([entry(tweet('5'))])]);
  await assert.rejects(fetchTimeline(repeated, { username: 'alice', count: 1, sinceId: '1' }), /cursor did not advance/);
});

test('explicit bottom termination establishes exhausted history', async () => {
  const { fetchTimeline } = await adapter;
  const client = fakeClient([page([entry(tweet('5'))], [{ type: 'TimelineTerminateTimeline', direction: 'Bottom' }], null)]);
  const result = await fetchTimeline(client, { username: 'alice', count: 1, sinceId: '1' });
  assert.equal(result.coverage.exhausted, true);
  assert.equal(result.coverage.reachedSince, false);
});

test('bundled runner exercises pinned Bird transport and strict adapter with offline fetch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweet-watcher-runner-'));
  const preload = path.join(dir, 'offline.mjs');
  try {
    const lookup = { data: { user: { result: { __typename: 'User', rest_id: '10',
      legacy: { screen_name: 'alice', name: 'Alice' } } } } };
    const timeline = page([entry({ __typename: 'TweetWithVisibilityResults', tweet: tweet('2') })],
      [{ type: 'TimelinePinEntry', entry: entry(tweet('1')) }]);
    fs.writeFileSync(preload, `globalThis.fetch = async (url) => {
      const operation = new URL(url).pathname.split('/').at(-1);
      const data = operation === 'UserByScreenName' ? ${JSON.stringify(lookup)}
        : operation === 'UserTweets' ? ${JSON.stringify(timeline)} : null;
      if (!data) throw new Error('unexpected offline operation');
      return { ok: true, status: 200, json: async () => data };
    };\n`);
    const output = execFileSync(process.execPath,
      ['--import', preload, path.resolve(__dirname, '../bin/bird'), 'alice', '1'], {
        encoding: 'utf8', timeout: 5000,
        env: { AUTH_TOKEN: 'offline-auth', CT0: 'offline-ct0', TW_RUNTIME_MODE: 'legacy-live' },
      });
    const result = JSON.parse(output);
    assert.deepEqual(result.tweets.map((t) => t.id), ['2', '1']);
    assert.equal(result.coverage.complete, true);
    assert.equal(result.coverage.oldestId, '2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
