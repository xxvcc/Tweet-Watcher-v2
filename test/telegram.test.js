'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const telegram = require('../lib/telegram');
// These inherited transport-contract tests use fake fetch implementations. Keep
// the process in development mode and bypass only the mocked module boundary.
test.mock.method(require('../lib/runtime'), 'blocked', () => null);

test('Telegram business error_code controls permanent and rate-limit classification', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      status: 200,
      json: async () => ({ ok: false, error_code: 400, description: 'bad request' }),
    });
    const bad = await telegram.sendMessage({ botToken: '1:token', chatId: '1', text: 'x' });
    assert.equal(bad.permanent, true);
    assert.equal(bad.rateLimited, false);

    global.fetch = async () => ({
      status: 429,
      json: async () => ({ ok: false, error_code: 429, parameters: { retry_after: 3 } }),
    });
    const limited = await telegram.sendMessage({ botToken: '1:token', chatId: '1', text: 'x' });
    assert.equal(limited.rateLimited, true);
    assert.equal(limited.permanent, false);
    assert.equal(limited.retryAfter, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test('message truncation does not leave a dangling surrogate', () => {
  const out = telegram.truncate('a'.repeat(9) + '😀tail', 10);
  assert.notEqual(out.charCodeAt(9), 0xD83D);
  assert.match(out, /内容已截断/);
});

test('translation formatting preserves original-only messages and includes both complete short texts', () => {
  const tweet = { text: 'Hello, world!', url: 'https://x.com/alice/status/1' };
  const original = '🐦 新推文 @alice\n\n发布时间：\nX链接：https://x.com/alice/status/1\n内容：\nHello, world!';
  for (const translation of [undefined, '', '   ']) {
    assert.equal(telegram.formatTweet(tweet, 'alice', translation), original);
  }
  const bilingual = telegram.formatTweet(tweet, 'alice', '你好，世界！');
  assert.ok(bilingual.includes('X链接：https://x.com/alice/status/1'));
  assert.ok(bilingual.endsWith('\n\nAI 中文翻译：\n你好，世界！\n\n原文：\nHello, world!'));
  assert.equal(tweet.text, 'Hello, world!');
});

test('long bilingual messages reserve space for both texts without cutting emoji or exceeding Telegram limits', () => {
  for (const metadata of [
    { time: '', url: 'https://x.com/alice/status/1' },
    { time: 'x'.repeat(256), url: 'https://example.com/' + 'x'.repeat(2028) },
  ]) {
    const text = 'Original English 😀 '.repeat(5000);
    const translation = '中文翻译😀'.repeat(5000);
    const message = telegram.formatTweet({ text, ...metadata }, 'alice', translation);
    assert.ok(message.length <= 4096);
    assert.equal(message.isWellFormed(), true);
    assert.ok(message.includes(metadata.url), 'valid complete link remains visible');
    const translatedBody = message.split('\n\nAI 中文翻译：\n')[1].split('\n\n原文：\n')[0];
    const originalBody = message.split('\n\n原文：\n')[1];
    assert.ok(translatedBody.startsWith('中文翻译😀'));
    assert.ok(originalBody.startsWith('Original English 😀 '));
    assert.match(translatedBody, /内容已截断/);
    assert.match(originalBody, /内容已截断/);
    assert.ok(translatedBody.length > originalBody.length);
  }
});

test('short original or translation releases its unused message space to the longer section', () => {
  const longText = 'English 😀 '.repeat(1000);
  const longTranslation = '中文😀'.repeat(1000);
  const shortOriginal = telegram.formatTweet({ text: 'Hello!' }, 'alice', longTranslation);
  assert.ok(shortOriginal.length <= 4096);
  assert.equal(shortOriginal.isWellFormed(), true);
  assert.ok(shortOriginal.endsWith('\n\n原文：\nHello!'));
  assert.ok(shortOriginal.split('\n\nAI 中文翻译：\n')[1].split('\n\n原文：\n')[0].length > 3500);

  const shortTranslation = telegram.formatTweet({ text: longText }, 'alice', '你好！');
  assert.ok(shortTranslation.length <= 4096);
  assert.equal(shortTranslation.isWellFormed(), true);
  assert.ok(shortTranslation.includes('\n\nAI 中文翻译：\n你好！\n\n原文：\n'));
  assert.ok(shortTranslation.split('\n\n原文：\n')[1].length > 3500);
});

test('HTTP Retry-After survives a non-JSON Telegram 429 response', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      status: 429,
      headers: { get: (name) => name === 'retry-after' ? '17' : null },
      json: async () => { throw new Error('not JSON'); },
    });
    const limited = await telegram.sendMessage({ botToken: '1:token', chatId: '1', text: 'x' });
    assert.equal(limited.rateLimited, true);
    assert.equal(limited.retryAfter, 17);
  } finally {
    global.fetch = originalFetch;
  }
});

test('transient HTTP client errors remain retryable', async () => {
  const originalFetch = global.fetch;
  try {
    for (const status of [408, 409, 425]) {
      global.fetch = async () => ({
        status,
        json: async () => ({ ok: false, error_code: status, description: 'try later' }),
      });
      const result = await telegram.sendMessage({ botToken: '1:token', chatId: '1', text: 'x' });
      assert.equal(result.permanent, false, `HTTP ${status}`);
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test('malformed Telegram inputs fail permanently without calling fetch', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  try {
    global.fetch = async () => { calls++; throw new Error('must not fetch'); };
    for (const input of [
      { botToken: '\uD800', chatId: '1', text: 'x' },
      { botToken: '1:token', chatId: Number.MAX_SAFE_INTEGER + 1, text: 'x' },
      { botToken: '1:token', chatId: '1', text: 'x'.repeat(4097) },
    ]) {
      const result = await telegram.sendMessage(input);
      assert.equal(result.ok, false);
      assert.equal(result.permanent, true);
    }
    assert.equal(calls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Telegram success requires both 2xx and boolean true API acknowledgement', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({ status: 500, json: async () => ({ ok: true }) });
    assert.equal((await telegram.sendMessage({ botToken: '1:token', chatId: '1', text: 'x' })).ok, false);

    global.fetch = async () => ({ status: 200, json: async () => ({ ok: 'true' }) });
    assert.equal((await telegram.sendMessage({ botToken: '1:token', chatId: '1', text: 'x' })).ok, false);

    global.fetch = async () => ({ status: 200, json: async () => ({ ok: true }) });
    assert.equal((await telegram.sendMessage({ botToken: '1:token', chatId: '1', text: 'x' })).ok, true);
  } finally {
    global.fetch = originalFetch;
  }
});
