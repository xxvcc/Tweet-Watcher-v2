'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const telegram = require('../lib/telegram');
const { createOutbox } = require('../lib/outbox');
test.mock.method(require('../lib/runtime'), 'blocked', () => null);
const photo = 'https://pbs.twimg.com/media/example.jpg';
const video = 'https://video.twimg.com/ext_tw_video/123/pu/vid/video.mp4';
const gif = 'https://video.twimg.com/tweet_video/animation.mp4';
const tweet = { id: '2', text: 'Main original', url: 'https://x.com/alice/status/2',
  relations: { replyToId: null, quoteId: '9', repostId: null, editIds: ['2'] },
  content: { media: [{ type: 'photo', url: photo }, { type: 'photo', url: photo.replace('example', 'second') },
    { type: 'video', url: video }, { type: 'animated_gif', url: gif }],
  quoted: { id: '9', url: 'https://x.com/i/status/9', text: 'Quote body', author_username: 'bob' },
  article: { id: '99', title: 'Article title', text: 'Article body', url: 'https://x.com/i/article/99' },
  thread: [{ id: '3', text: 'Conversation reply', url: 'https://x.com/bob/status/3', author_username: 'bob' }] } };

test('default link mode preserves quote, article, thread and media while all-mode plans native attachments', () => {
  const original = structuredClone(tweet);
  const links = telegram.planTweet(tweet, 'alice', '中文翻译');
  assert.ok(links.every((part) => part.kind === 'text'));
  const allText = links.map((part) => part.text).join('\n');
  for (const expected of ['Main original', '中文翻译', '💬 引用', 'Quote body', 'Article title', 'Article body', 'Conversation reply', photo, video, gif]) {
    assert.ok(allText.includes(expected), expected);
  }
  const native = telegram.planTweet(tweet, 'alice', '', { media_mode: 'all' });
  assert.deepEqual(native.map((part) => part.kind), ['text', 'text', 'text', 'text', 'album', 'animation']);
  assert.deepEqual(native[4].media.map((part) => part.type), ['photo', 'photo', 'video']);
  const photos = telegram.planTweet(tweet, 'alice', '', { media_mode: 'photos' });
  assert.equal(photos.at(-1).kind, 'album');
  assert.ok(photos.filter((part) => part.kind === 'text').some((part) => part.text.includes(video) && part.text.includes(gif)));
  assert.ok(photos.at(-1).media.every((part) => part.type === 'photo'));
  assert.deepEqual(tweet, original);
});

test('long enrichment is independently bounded and preserves complete identifying links and Unicode', () => {
  const value = structuredClone(tweet);
  value.text = 'Main 😀 '.repeat(10000);
  value.content.quoted.text = 'Quote 😀 '.repeat(1000);
  value.content.article.text = 'Article 😀 '.repeat(2500);
  value.content.thread[0].text = 'Thread 😀 '.repeat(1000);
  const parts = telegram.planTweet(value, 'alice', '译文😀'.repeat(5000));
  for (const part of parts) if (part.kind === 'text') {
    assert.ok(part.text.length <= 4096);
    assert.equal(part.text.isWellFormed(), true);
  }
  assert.ok(parts[1].text.includes(value.content.quoted.url));
  assert.ok(parts[2].text.includes(value.content.article.url));
  assert.ok(parts[3].text.includes(value.content.thread[0].url));
  assert.ok(parts[0].text.includes('Main 😀'));
});

test('native methods send only allowlisted URLs with no X authentication and reject incomplete album confirmations', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  let result = [{ message_id: 1 }, { message_id: 2 }];
  try {
    global.fetch = async (url, options) => { calls.push({ url, options }); return { status: 200, json: async () => ({ ok: true, result }) }; };
    const part = { kind: 'album', media: [{ type: 'photo', url: photo }, { type: 'video', url: video }] };
    assert.equal((await telegram.sendTweetPart({ botToken: '1:synthetic-token', chatId: '2', part })).ok, true);
    const call = calls[0];
    assert.equal(new URL(call.url).hostname, 'api.telegram.org');
    assert.ok(call.url.endsWith('/sendMediaGroup'));
    assert.equal(call.options.redirect, 'error');
    assert.deepEqual(Object.keys(call.options.headers), ['Content-Type']);
    assert.deepEqual(JSON.parse(call.options.body.get('media')), [{ type: 'photo', media: photo }, { type: 'video', media: video }]);
    assert.doesNotMatch(String(call.options.body), /auth_token|ct0|cookie/i);
    for (const bad of [[{ message_id: 1 }], [{ message_id: 1 }, { message_id: 1 }], [{}, {}], null]) {
      result = bad;
      assert.equal((await telegram.sendTweetPart({ botToken: '1:synthetic-token', chatId: '2', part })).ok, false);
    }
    result = { message_id: 3 };
    for (const [kind, url, method] of [['photo', photo, 'sendPhoto'], ['video', video, 'sendVideo'], ['animation', gif, 'sendAnimation']]) {
      assert.equal((await telegram.sendTweetPart({ botToken: '1:synthetic-token', chatId: '2', part: { kind, url } })).ok, true);
      assert.ok(calls.at(-1).url.endsWith('/' + method));
      assert.equal(calls.at(-1).options.body.get(kind), url);
    }
    const count = calls.length;
    assert.equal((await telegram.sendTweetPart({ botToken: '1:synthetic-token', chatId: '2', part: { kind: 'photo', url: 'https://127.0.0.1/media/a.jpg' } })).permanent, true);
    assert.equal(calls.length, count);
  } finally { global.fetch = originalFetch; }
});

test('failed media delivery resumes only unconfirmed parts from disk and never repeats the confirmed text', async () => {
  const files = new Map();
  const store = {
    readState: (name) => files.has(name) ? { status: 'ok', value: structuredClone(files.get(name)) } : { status: 'missing' },
    writeJSON: (name, data) => files.set(name, structuredClone(data)),
  };
  let box = createOutbox(store, 200);
  box.baseline('alice', ['1']);
  box.capture('alice', [{ id: '2', text: 'Original', content: { media: [{ type: 'photo', url: photo }] } }], 'a'.repeat(64), null, '2');
  box.prepareDelivery('alice', '2', telegram.planTweet(box.get('alice').pending[0], 'alice', '', { media_mode: 'photos' }));
  const originalFetch = global.fetch;
  const requests = [];
  let failMedia = true;
  global.fetch = async (url) => {
    const method = new URL(url).pathname.split('/').at(-1);
    requests.push(method);
    return method === 'sendPhoto' && failMedia
      ? { status: 503, json: async () => ({ ok: false }) }
      : { status: 200, json: async () => ({ ok: true, result: { message_id: requests.length } }) };
  };
  const deliver = async () => {
    while (box.get('alice').pending[0].delivery.next < box.get('alice').pending[0].delivery.parts.length) {
      const { next, parts } = box.get('alice').pending[0].delivery;
      const result = await telegram.sendTweetPart({ botToken: '1:synthetic', chatId: '2', part: parts[next] });
      if (!result.ok) return result;
      box.acknowledgePart('alice', '2', next);
    }
    box.acknowledge('alice', '2', []);
    return { ok: true };
  };
  try {
    assert.equal((await deliver()).ok, false);
    assert.equal(box.get('alice').pending[0].delivery.next, 1);
    box = createOutbox(store, 200); box.flush();
    failMedia = false;
    assert.equal((await deliver()).ok, true);
    assert.deepEqual(requests, ['sendMessage', 'sendPhoto', 'sendPhoto']);
    assert.equal(box.get('alice').pending.length, 0);
  } finally { global.fetch = originalFetch; }
});

test('provider and transport errors redact the bot credential before reporting diagnostics', async () => {
  const originalFetch = global.fetch;
  const token = '123:synthetic-token';
  try {
    global.fetch = async () => { throw new Error(`request to https://api.telegram.org/bot${encodeURIComponent(token)}/sendPhoto failed`); };
    const input = { botToken: token, chatId: '2', part: { kind: 'photo', url: photo } };
    const transport = await telegram.sendTweetPart(input);
    assert.equal(transport.ok, false);
    assert.doesNotMatch(transport.description, /synthetic-token/);
    global.fetch = async () => ({ status: 400, json: async () => ({ ok: false, description: `bad ${token}` }) });
    const provider = await telegram.sendTweetPart(input);
    assert.equal(provider.permanent, true);
    assert.doesNotMatch(provider.description, /synthetic-token/);
  } finally { global.fetch = originalFetch; }
});
