'use strict';
// Offline, synthetic-only probe. No production state or upstream fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const baseline = process.env.TW_PROBE_BASELINE_DIR;
assert.ok(baseline, 'Historical probe: set TW_PROBE_BASELINE_DIR to an isolated b7bf16b source snapshot; see README.md');
for (const [file, expected] of Object.entries({
  'lib/twscrape-timeline.js': '99eb21f4009ea3518be180da0b89cafac57d7c47854e2685d6bd6db698270f55',
  'lib/outbox.js': 'c261fe1509ce7a870b809574617ac3cd605e24d5a81e8e8dbaa953d43f4db7c0',
})) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(baseline, file))).digest('hex'), expected,
  'Historical baseline source differs: ' + file);
const { parseTimelinePage, mergeTweet } = require(path.resolve(baseline, 'lib/twscrape-timeline'));
const { createOutbox } = require(path.resolve(baseline, 'lib/outbox'));
let networkRequests = 0;
const denied = () => { networkRequests++; throw new Error('Network is forbidden'); };
global.fetch = denied;
for (const name of ['node:http', 'node:https']) {
  const transport = require(name);
  transport.request = transport.get = denied;
}
const net = require('node:net');
net.connect = net.createConnection = net.Socket.prototype.connect = denied;
require('node:tls').connect = denied;

const raw = {
  __typename: 'Tweet', rest_id: '200',
  legacy: {
    id_str: '200', user_id_str: '10', full_text: 'Synthetic parent comment', lang: 'en',
    created_at: 'Fri Oct 23 10:00:00 +0000 2026', quoted_status_id_str: '100',
    extended_entities: { media: [{ type: 'photo',
      media_url_https: 'https://pbs.twimg.com/media/synthetic-never-requested.jpg' }] },
  },
  quoted_status_result: { result: { rest_id: '100', legacy: { full_text: 'Synthetic quoted body', lang: 'fr' } } },
  core: { user_results: { result: { __typename: 'User', rest_id: '10',
    core: { screen_name: 'alice', name: 'Synthetic Alice' } } } },
};
const page = { data: { user: { result: { timeline: { timeline: { instructions: [{
  type: 'TimelineAddEntries', entries: [
    { entryId: 'tweet-200', content: { itemContent: { itemType: 'TimelineTweet', tweet_results: { result: raw } } } },
    { content: { cursorType: 'Bottom', value: 'synthetic-cursor' } },
  ],
}] } } } } } };
const tweet = parseTimelinePage(page, { username: 'alice', userId: '10' }).tweets[0];
assert.equal(tweet.relations.quoteId, '100');
assert.equal(Object.hasOwn(tweet, 'media'), false);
assert.equal(Object.hasOwn(tweet, 'quotedTweet'), false);
assert.equal(Object.hasOwn(tweet, 'extended_entities'), false);
assert.equal(JSON.stringify(tweet).includes('Synthetic quoted body'), false);

const files = new Map();
const store = {
  readState: (name) => files.has(name) ? { status: 'ok', value: structuredClone(files.get(name)) } : { status: 'missing' },
  writeJSON: (name, value) => files.set(name, structuredClone(value)),
};
const box = createOutbox(store, 200);
box.baseline('alice', ['1']);
box.capture('alice', [{ ...tweet, media: { photos: ['synthetic-media'] },
  quotedTweet: { id: '100', text: 'Synthetic quoted body' } }], 'a'.repeat(64), null);
const restarted = createOutbox(store, 200);
restarted.flush();
const pending = restarted.get('alice').pending[0];
assert.equal(pending.relations.quoteId, '100');
assert.equal(Object.hasOwn(pending, 'media'), false);
assert.equal(Object.hasOwn(pending, 'quotedTweet'), false);

for (const extra of [{ media: { photos: ['synthetic-media'] } },
  { quotedTweet: { id: '100', text: 'Synthetic quoted body' } }]) {
  assert.throws(() => mergeTweet({ ...tweet, ...extra }, tweet), { code: 'TWEET_CONFLICT' });
  assert.throws(() => mergeTweet(tweet, { ...tweet, ...extra }), { code: 'TWEET_CONFLICT' });
}
assert.equal(networkRequests, 0);
console.log(JSON.stringify({ ok: true, data: 'synthetic-in-memory', networkRequests,
  parserKeepsQuoteIdentity: true, parserDropsMediaAndQuoteBody: true,
  outboxDropsExtraMediaAndQuoteFieldsAcrossReload: true,
  directlyAddingEitherOptionalFieldConflictsInBothMergeOrders: true }));
