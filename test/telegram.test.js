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
