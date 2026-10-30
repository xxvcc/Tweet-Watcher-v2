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
  assert.deepEqual(native.map((part) => part.kind), ['album', 'text', 'text', 'text', 'animation']);
  assert.deepEqual(native[0].media.map((part) => part.type), ['photo', 'photo', 'video']);
  assert.equal(native[0].caption, telegram.formatTweet(tweet, 'alice'));
  const photos = telegram.planTweet(tweet, 'alice', '', { media_mode: 'photos' });
  assert.equal(photos[0].kind, 'album');
  assert.ok(photos.filter((part) => part.kind === 'text').some((part) => part.text.includes(video) && part.text.includes(gif)));
  assert.ok(photos[0].media.every((part) => part.type === 'photo'));
  assert.deepEqual(tweet, original);
});

test('long main text, translation and enrichment are delivered completely in bounded Unicode parts', () => {
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
  const full = parts.map((part) => part.text.replace(/^「\d+\/\d+」\n/, '')).join('');
  for (const expected of [value.text, '译文😀'.repeat(5000), value.content.quoted.text,
    value.content.article.text, value.content.thread[0].text, value.content.quoted.url,
    value.content.article.url, value.content.thread[0].url, photo, video, gif]) assert.ok(full.includes(expected));
  assert.doesNotMatch(full, /内容已截断/);
});

test('short native media carries the complete bilingual caption only once and the 1024 boundary is exact', () => {
  for (const [type, url, kind] of [['photo', photo, 'photo'], ['video', video, 'video'], ['animated_gif', gif, 'animation']]) {
    const value = { text: 'Hello', content: { media: [{ type, url }] } };
    const expected = telegram.formatTweet(value, 'alice', '你好');
    assert.deepEqual(telegram.planTweet(value, 'alice', '你好', { media_mode: 'all' }), [{ kind, url, caption: expected }]);
  }
  const value = { text: '', content: { media: [{ type: 'photo', url: photo }] } };
  value.text = 'x'.repeat(1024 - telegram.formatTweet(value, 'alice').length);
  const exact = telegram.planTweet(value, 'alice', '', { media_mode: 'photos' });
  assert.equal(exact.length, 1);
  assert.equal(exact[0].caption.length, 1024);
  value.text += 'x';
  const over = telegram.planTweet(value, 'alice', '', { media_mode: 'photos' });
  assert.deepEqual(over.map((part) => part.kind), ['text', 'photo']);
  assert.equal(over[0].text.length, 1025);
  assert.equal(over[1].caption, undefined);
  value.text = 'short original';
  const translated = telegram.planTweet(value, 'alice', '译文'.repeat(600), { media_mode: 'photos' });
  assert.deepEqual(translated.map((part) => part.kind), ['text', 'photo']);
  assert.ok(translated[0].text.includes('译文'.repeat(600)));
});

test('long bilingual text finishes all numbered parts before native media without mutating the source', () => {
  const value = { text: 'Original 😀\n'.repeat(1500), url: 'https://x.com/alice/status/1',
    content: { media: [{ type: 'photo', url: photo }, { type: 'animated_gif', url: gif }] } };
  const original = structuredClone(value);
  const translation = '译文😀\n'.repeat(1000);
  const parts = telegram.planTweet(value, 'alice', translation, { media_mode: 'all' });
  assert.deepEqual(parts.slice(-2), [{ kind: 'photo', url: photo }, { kind: 'animation', url: gif }]);
  const text = parts.slice(0, -2);
  assert.ok(text.length > 1 && text.every((part) => part.kind === 'text'));
  assert.equal(text.map((part, i) => {
    const prefix = `「${i + 1}/${text.length}」\n`;
    assert.ok(part.text.startsWith(prefix) && part.text.length <= 4096);
    return part.text.slice(prefix.length);
  }).join(''), telegram.formatTweet(value, 'alice', translation));
  assert.deepEqual(value, original);
});

test('native methods send only allowlisted URLs with no X authentication and reject incomplete album confirmations', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  let result = [{ message_id: 1 }, { message_id: 2 }];
  try {
    global.fetch = async (url, options) => { calls.push({ url, options }); return { status: 200, json: async () => ({ ok: true, result }) }; };
    const caption = '完整中文与原文 😀\n<plain text>&';
    const part = { kind: 'album', caption, media: [{ type: 'photo', url: photo }, { type: 'video', url: video }] };
    assert.equal((await telegram.sendTweetPart({ botToken: '1:synthetic-token', chatId: '2', part })).ok, true);
    const call = calls[0];
    assert.equal(new URL(call.url).hostname, 'api.telegram.org');
    assert.ok(call.url.endsWith('/sendMediaGroup'));
    assert.equal(call.options.redirect, 'error');
    assert.deepEqual(Object.keys(call.options.headers), ['Content-Type']);
    assert.deepEqual(JSON.parse(call.options.body.get('media')), [{ type: 'photo', media: photo, caption }, { type: 'video', media: video }]);
    assert.doesNotMatch(String(call.options.body), /auth_token|ct0|cookie/i);
    for (const bad of [[{ message_id: 1 }], [{ message_id: 1 }, { message_id: 1 }], [{}, {}], null]) {
      result = bad;
      assert.equal((await telegram.sendTweetPart({ botToken: '1:synthetic-token', chatId: '2', part })).ok, false);
    }
    result = { message_id: 3 };
    for (const [kind, url, method] of [['photo', photo, 'sendPhoto'], ['video', video, 'sendVideo'], ['animation', gif, 'sendAnimation']]) {
      assert.equal((await telegram.sendTweetPart({ botToken: '1:synthetic-token', chatId: '2', part: { kind, url, caption } })).ok, true);
      assert.ok(calls.at(-1).url.endsWith('/' + method));
      assert.equal(calls.at(-1).options.body.get(kind), url);
      assert.equal(calls.at(-1).options.body.get('caption'), caption);
      assert.equal(calls.at(-1).options.body.has('parse_mode'), false);
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
  box.capture('alice', [{ id: '2', text: 'Original'.repeat(200), content: { media: [{ type: 'photo', url: photo }] } }], 'a'.repeat(64), null, '2');
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
