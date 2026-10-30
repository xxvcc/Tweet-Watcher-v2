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

test('long bilingual formatting retains all original and translated text before splitting', () => {
  for (const metadata of [
    { time: '', url: 'https://x.com/alice/status/1' },
    { time: 'x'.repeat(256), url: 'https://example.com/' + 'x'.repeat(2028) },
  ]) {
    const text = 'Original English 😀 '.repeat(5000);
    const translation = '中文翻译😀'.repeat(2000);
    const message = telegram.formatTweet({ text, ...metadata }, 'alice', translation);
    assert.equal(message.isWellFormed(), true);
    assert.ok(message.includes(metadata.url));
    assert.ok(message.endsWith('\n\nAI 中文翻译：\n' + translation + '\n\n原文：\n' + text));
    const parts = telegram.splitText(message);
    assert.ok(parts.length > 24, 'the full original exceeds the old 24-part limit');
    assert.equal(parts.map((part, index) => {
      const prefix = `「${index + 1}/${parts.length}」\n`;
      assert.ok(part.startsWith(prefix));
      assert.ok(part.length <= 4096);
      assert.equal(part.isWellFormed(), true);
      return part.slice(prefix.length);
    }).join(''), message);
  }
});

test('splitting preserves boundary text, paragraphs, Unicode graphemes and exact whitespace', () => {
  const family = '👨‍👩‍👧‍👦';
  const samples = [
    'a'.repeat(4096), 'a'.repeat(4097), 'a'.repeat(4085) + '😀tail',
    'a'.repeat(4085) + family + 'b'.repeat(500),
    'a'.repeat(4085) + 'e\u0301' + 'b'.repeat(500),
    'a'.repeat(4085) + '\r\n' + 'b'.repeat(500),
    'a'.repeat(3300) + '\n\n' + 'b'.repeat(1300),
    'a'.repeat(3200) + '\n\n' + 'b'.repeat(800) + '\n' + 'c'.repeat(500),
    'a'.repeat(3300) + '\n' + 'b'.repeat(1300),
    'a'.repeat(3300) + ' ' + 'b'.repeat(1300),
    ' \n\t' + 'line 😀\r\n'.repeat(1000) + '  \n',
    'a' + '\u0301'.repeat(9000), // one grapheme longer than a Telegram message
  ];
  for (const sample of samples) {
    const parts = telegram.splitText(sample);
    assert.equal(parts.map((part, index) => {
      assert.ok(part.length <= 4096);
      assert.ok(part.isWellFormed());
      if (parts.length === 1) return part;
      const prefix = `「${index + 1}/${parts.length}」\n`;
      assert.ok(part.startsWith(prefix));
      return part.slice(prefix.length);
    }).join(''), sample);
  }
  assert.ok(telegram.splitText(samples[3])[1].slice('「2/2」\n'.length).startsWith(family));
  assert.ok(telegram.splitText(samples[4])[1].slice('「2/2」\n'.length).startsWith('e\u0301'));
  assert.ok(telegram.splitText(samples[5])[1].slice('「2/2」\n'.length).startsWith('\r\n'));
  assert.ok(telegram.splitText(samples[6])[0].endsWith('\n\n'));
  assert.ok(telegram.splitText(samples[7])[0].endsWith('\n\n'), 'paragraph preferred over later newline');
  assert.ok(telegram.splitText(samples[8])[0].endsWith('\n'));
  assert.ok(telegram.splitText(samples[9])[0].endsWith(' '));
  assert.throws(() => telegram.splitText('a'.repeat(4096 * 129)), /超过限制/);
  assert.throws(() => telegram.splitText('bad\ud800'), /正文无效/);
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
