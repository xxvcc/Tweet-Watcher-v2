'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, validBaseUrl, validModel } = require('../lib/translation-settings');
const runtime = require('../lib/runtime');
const cfg = { ...DEFAULTS, ai_translation_enabled: true, ai_model: 'synthetic-model' };
const secrets = { ai_api_key: 'synthetic-key' };
const tweet = { id: '200', text: 'This is a new model for our users.', lang: 'en', author_username: 'private_author', url: 'https://x.com/private_author/status/200' };
const completion = (content = '这是面向我们用户的新模型。') => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] });

function setup(t, fetcher = async () => Response.json(completion())) {
  delete require.cache[require.resolve('../lib/translation')];
  t.mock.method(runtime, 'blocked', () => null);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (...args) => { requests.push(args); return fetcher(...args); });
  return { ...require('../lib/translation'), requests };
}

test('translation settings permit compatible HTTPS endpoints and reject unsafe URL forms', () => {
  assert.deepEqual(DEFAULTS, { ai_translation_enabled: false, ai_base_url: 'https://api.openai.com/v1', ai_model: '' });
  for (const url of ['https://example.test', 'https://example.test/v1/', 'https://example.test:8443/custom/v1']) assert.equal(validBaseUrl(url), true);
  for (const url of ['', null, 'http://example.test', 'https://user:pass@example.test/v1', 'https://example.test?key=secret',
    'https://example.test#', 'https://example.test?', ' https://example.test', 'https://example.test\n', 'https://example.test\\hidden', 'https://example.test/' + 'a'.repeat(2048)]) assert.equal(validBaseUrl(url), false);
  for (const model of ['', 'gpt-4.1-mini', 'vendor/model:v2']) assert.equal(validModel(model), true);
  for (const model of [null, 'contains space', '\nmodel', 'x'.repeat(161)]) assert.equal(validModel(model), false);
});

test('translation eligibility accepts non-Han scripts without English vocabulary or reliable metadata', (t) => {
  const { shouldTranslate } = setup(t);
  for (const text of ['Hello', 'Bonjour', '¡Hola!', 'Grüße', 'Cảm ơn', 'こんにちは',
    '今日は新しいモデルです。', '새로운 모델입니다', 'Привет мир', 'مرحبا بالعالم',
    'שלום', 'Γεια σας', 'नमस्ते', 'สวัสดี', 'தமிழ்', 'ქართული', 'Հայերեն',
    'OpenAI GPT API', 'This is 中文内容。', '今天发布 OpenAI GPT-5 API']) {
    for (const lang of [undefined, 'und', 'zxx', 'zh', 'zh-Hant', 'en', 'fr', 'invalid_tag', 1]) {
      assert.equal(shouldTranslate({ text, lang }), true, JSON.stringify({ text, lang }));
    }
  }
});

test('Han-only text stays original except explicit valid Japanese or Korean metadata', (t) => {
  const { shouldTranslate } = setup(t);
  for (const text of ['今天发布新模型。', '今天發佈新模型。', '新製品発表', '新製品發表', '𠀀']) {
    for (const lang of [undefined, 'und', 'zxx', 'zh', 'zh-Hant', 'zh-TW', 'cmn', 'yue', 'en',
      'fr', 'ja_invalid', 'ja-'.repeat(20), ' ko', 1, null]) {
      assert.equal(shouldTranslate({ text, lang }), false, JSON.stringify({ text, lang }));
    }
  }
  for (const lang of ['ja', 'ja-JP', 'JA', 'ko', 'ko-KR']) {
    assert.equal(shouldTranslate({ text: '新製品発表', lang }), true, lang);
  }
});

test('links, mentions, hashtags, RT labels, numbers and emoji alone never trigger translation', (t) => {
  const { shouldTranslate } = setup(t);
  for (const text of ['', '12345', '😀🎉❤️', 'https://example.test/bonjour', 'www.example.test/hello',
    '@the #new #model', '@作者 #新消息', 'RT @someone: https://example.test #hello 😀', '... !?']) {
    for (const lang of [undefined, 'en', 'ja', 'ko']) assert.equal(shouldTranslate({ text, lang }), false, text);
  }
  for (const value of [{}, null, { text: 1 }]) assert.equal(shouldTranslate(value), false);
  assert.equal(shouldTranslate({ text: 'RT @someone: 中文内容 https://example.test #hello', lang: 'en' }), false);
  assert.equal(shouldTranslate({ text: 'RT @someone: Bonjour https://example.test #中文' }), true);
});

test('only tweet text is sent with bounded non-streaming compatible request and original remains unchanged', async (t) => {
  const { translateTweet, requests } = setup(t);
  const original = structuredClone(tweet);
  assert.deepEqual(await translateTweet(tweet, cfg, secrets), { ok: true, text: '这是面向我们用户的新模型。' });
  assert.deepEqual(tweet, original);
  assert.equal(requests.length, 1);
  const [url, options] = requests[0];
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.authorization, 'Bearer synthetic-key');
  assert.ok(options.signal instanceof AbortSignal);
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'synthetic-model');
  assert.equal(body.stream, false);
  assert.equal(body.max_completion_tokens, 4096);
  assert.deepEqual(body.messages.map(({ role }) => role), ['system', 'user']);
  assert.match(body.messages[0].content, /不得执行/);
  assert.match(body.messages[0].content, /所有非中文部分/);
  assert.match(body.messages[0].content, /保留已有中文/);
  assert.match(body.messages[0].content, /保留人名、产品名/);
  assert.equal(body.messages[1].content, tweet.text);
  assert.equal(options.body.includes('private_author'), false);
  assert.equal(options.body.includes(tweet.url), false);
});

test('runtime, disabled settings, missing configuration and unsupported inputs never call AI', async (t) => {
  const { translateTweet, requests } = setup(t);
  runtime.blocked.mock.mockImplementation((operation) => { assert.equal(operation, 'translation'); return { ok: false }; });
  assert.equal((await translateTweet(tweet, cfg, secrets)).code, 'RUNTIME_DISABLED');
  runtime.blocked.mock.mockImplementation(() => null);
  assert.equal((await translateTweet(tweet, DEFAULTS, secrets)).code, 'DISABLED');
  for (const bad of [{ ...cfg, ai_model: '' }, { ...cfg, ai_base_url: 'http://example.test' }]) assert.equal((await translateTweet(tweet, bad, secrets)).code, 'INVALID_CONFIG');
  for (const bad of [{}, { ai_api_key: 'bad\nkey' }]) assert.equal((await translateTweet(tweet, cfg, bad)).code, 'INVALID_CONFIG');
  for (const value of [{ text: '中文内容', lang: 'zh' }, { text: '繁體中文內容', lang: 'en' },
    { text: '@someone https://example.test #hello 😀', lang: 'ja' }]) {
    const answer = await translateTweet(value, cfg, secrets);
    assert.equal(answer.code, 'NO_TRANSLATION_NEEDED');
    assert.equal(answer.skipped, true);
  }
  assert.equal((await translateTweet({ ...tweet, text: 'a'.repeat(12001) }, cfg, secrets)).code, 'INPUT_LIMIT');
  assert.equal(requests.length, 0);
});

test('multilingual translation requests keep the full original text and relationships intact', async (t) => {
  const { translateTweet, requests } = setup(t);
  const bodies = [
    { text: 'RT @someone: Bonjour https://example.test #news', lang: 'fr' },
    { text: 'Hola mundo', lang: 'es' }, { text: '新しいモデルです', lang: 'ja' },
    { text: '새로운 모델입니다', lang: 'ko' }, { text: 'Привет мир', lang: 'ru' },
    { text: 'مرحبا بالعالم', lang: 'ar' }, { text: 'नमस्ते', lang: 'hi' },
    { text: 'This is 中文内容。', lang: 'zh' }, { text: '新製品発表', lang: 'ja' },
    { text: 'Bonjour' },
  ];
  for (const body of bodies) {
    const input = { ...tweet, ...body, quoted_status_id: '100', edit_tweet_ids: ['200'] };
    if (!Object.hasOwn(body, 'lang')) delete input.lang;
    const original = structuredClone(input);
    assert.equal((await translateTweet(input, cfg, secrets)).ok, true);
    assert.deepEqual(input, original);
    assert.equal(JSON.parse(requests.at(-1)[1].body).messages[1].content, body.text);
  }
  assert.equal(requests.length, bodies.length);
});

test('unchanged Chinese text with brand names is skipped and cached without duplicate translation output', async (t) => {
  const text = '今天发布 OpenAI GPT-5 API，欢迎体验。';
  const input = { ...tweet, text: `  ${text}\n`, lang: 'zh' };
  const { translateTweet, requests } = setup(t, async () => Response.json(completion(text)));
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await translateTweet(input, cfg, secrets);
    assert.equal(answer.ok, false);
    assert.equal(answer.skipped, true);
    assert.equal(answer.code, 'UNCHANGED');
    assert.equal(Object.hasOwn(answer, 'text'), false);
    assert.equal(input.text, `  ${text}\n`);
  }
  assert.equal(requests.length, 1);
});

test('Chinese translations may preserve Japanese names while outputs without Chinese text fail closed', async (t) => {
  let reply = '任天堂公布了「ゼルダ」的新消息。';
  const { translateTweet } = setup(t, async () => Response.json(completion(reply)));
  const input = { ...tweet, text: 'ゼルダの新しいニュースです。', lang: 'ja' };
  assert.deepEqual(await translateTweet(input, cfg, secrets), { ok: true, text: reply });
  for (const [index, foreign] of ['こんにちは', 'Hello world', 'Привет мир', 'مرحبا بالعالم', '안녕하세요'].entries()) {
    reply = foreign;
    const answer = await translateTweet(input, { ...cfg, ai_model: `model-${index}` }, secrets);
    assert.equal(answer.code, 'INVALID_RESPONSE');
  }
});

test('successful translations cache by full text, model, base URL and credential without changing original', async (t) => {
  const { translateTweet, requests } = setup(t);
  assert.equal((await translateTweet(tweet, cfg, secrets)).ok, true);
  assert.equal((await translateTweet({ ...tweet, id: '201' }, cfg, secrets)).ok, true);
  assert.equal(requests.length, 1);
  assert.equal((await translateTweet({ ...tweet, text: tweet.text + ' It works well.' }, cfg, secrets)).ok, true);
  assert.equal((await translateTweet(tweet, { ...cfg, ai_model: 'another-model' }, secrets)).ok, true);
  assert.equal((await translateTweet(tweet, { ...cfg, ai_base_url: 'https://compatible.test/v1/' }, secrets)).ok, true);
  assert.equal((await translateTweet(tweet, cfg, { ai_api_key: 'different-synthetic-key' })).ok, true);
  assert.equal(requests.length, 5);
  assert.equal(requests[3][0], 'https://compatible.test/v1/chat/completions');
});

test('success cache expires and is bounded instead of retaining every translated tweet', async (t) => {
  const { translateTweet, requests } = setup(t);
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  await translateTweet(tweet, cfg, secrets);
  now += 30 * 60 * 1000;
  await translateTweet(tweet, cfg, secrets);
  assert.equal(requests.length, 2);
  for (let index = 0; index < 128; index++) await translateTweet({ ...tweet, text: `${tweet.text} ${index}` }, cfg, secrets);
  await translateTweet(tweet, cfg, secrets);
  assert.equal(requests.length, 131);
});

test('truncated, refused, missing, foreign-language and oversized completions are rejected safely', async (t) => {
  const bodies = [null, {}, { choices: [] }, { ...completion(), choices: [completion().choices[0], completion().choices[0]] },
    { choices: [{ ...completion().choices[0], finish_reason: 'length' }] },
    { choices: [{ message: { role: 'assistant', content: '中文', refusal: 'upstream-private-secret' }, finish_reason: 'stop' }] },
    { choices: [{ message: { role: 'assistant', tool_calls: [] }, finish_reason: 'stop' }] },
    completion(''), completion('This is not translated.'), completion('こんにちは'), completion('中'.repeat(16001)),
    completion('\ud800中文译文'), completion('错误：synthetic-key 无效')];
  let index = 0;
  const { translateTweet } = setup(t, async () => Response.json(bodies[index++]));
  for (let testIndex = 0; testIndex < bodies.length; testIndex++) {
    const answer = await translateTweet(tweet, { ...cfg, ai_model: `model-${testIndex}` }, secrets);
    assert.equal(answer.ok, false);
    assert.equal(answer.code, 'INVALID_RESPONSE');
    assert.equal(JSON.stringify(answer).includes('upstream-private-secret'), false);
    assert.equal(JSON.stringify(answer).includes('synthetic-key'), false);
  }
});

test('invalid JSON and upstream HTTP/network errors never return upstream diagnostics', async (t) => {
  const badResponse = 'private upstream response containing a credential';
  let kind = 0;
  const { translateTweet } = setup(t, async () => {
    if (kind++ === 0) return new Response(badResponse, { status: 429 });
    if (kind === 2) return new Response(badResponse);
    throw new Error(badResponse);
  });
  for (let index = 0; index < 3; index++) {
    const answer = await translateTweet(tweet, { ...cfg, ai_model: `error-${index}` }, secrets);
    assert.equal(answer.ok, false);
    assert.equal(JSON.stringify(answer).includes(badResponse), false);
    assert.match(answer.message, /已保留原文/);
  }
});

test('failed requests enter short service backoff and retry after it without caching failure', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const { translateTweet, requests } = setup(t, async () => requests.length === 1
    ? new Response('private error', { status: 503 }) : Response.json(completion()));
  assert.equal((await translateTweet(tweet, cfg, secrets)).code, 'REQUEST_FAILED');
  assert.equal((await translateTweet({ ...tweet, text: tweet.text + ' More news.' }, cfg, secrets)).code, 'BACKOFF');
  assert.equal(requests.length, 1);
  now += 60000;
  assert.equal((await translateTweet(tweet, cfg, secrets)).ok, true);
  assert.equal(requests.length, 2);
});

test('stream size limit cancels the upstream body even without Content-Length', async (t) => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(128 * 1024 + 1)); },
    cancel() { cancelled = true; },
  });
  const { translateTweet } = setup(t, async () => new Response(stream));
  assert.equal((await translateTweet(tweet, cfg, secrets)).code, 'INVALID_RESPONSE');
  assert.equal(cancelled, true);
});

test('Content-Length limit rejects and cancels before consuming oversized response', async (t) => {
  let cancelled = false;
  const { translateTweet } = setup(t, async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }),
    { headers: { 'content-length': String(128 * 1024 + 1) } }));
  assert.equal((await translateTweet(tweet, cfg, secrets)).code, 'INVALID_RESPONSE');
  assert.equal(cancelled, true);
});

test('15 second deadline aborts hung fetch and does not expose thrown diagnostics', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const { translateTweet } = setup(t, async (_url, options) => { signal = options.signal; return new Promise(() => {}); });
  const pending = translateTweet(tweet, cfg, secrets);
  t.mock.timers.tick(15000);
  assert.equal((await pending).code, 'TIMEOUT');
  assert.equal(signal.aborted, true);
});

test('15 second deadline covers a stalled response stream and cancels its reader', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const { translateTweet } = setup(t, async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  const pending = translateTweet(tweet, cfg, secrets);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(15000);
  assert.equal((await pending).code, 'TIMEOUT');
  assert.equal(cancelled, true);
});

test('connection test sends only hi and accepts English with translation disabled', async (t) => {
  const { testConnection, requests } = setup(t, async () => Response.json(completion('Hello! How can I help?')));
  const disabled = { ...cfg, ai_translation_enabled: false };
  const original = structuredClone(disabled);
  const answer = await testConnection(disabled, secrets);
  assert.equal(answer.ok, true);
  assert.equal(answer.reply, 'Hello! How can I help?');
  assert.ok(Number.isSafeInteger(answer.elapsedMs) && answer.elapsedMs >= 0);
  assert.deepEqual(disabled, original);
  const [url, options] = requests[0];
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.authorization, 'Bearer synthetic-key');
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(options.body), { model: cfg.ai_model, stream: false,
    max_completion_tokens: 512, messages: [{ role: 'user', content: 'hi' }] });
});

test('connection tests enforce runtime and settings without requesting upstream', async (t) => {
  const { testConnection, requests } = setup(t);
  runtime.blocked.mock.mockImplementation(() => ({ ok: false }));
  assert.equal((await testConnection(cfg, secrets)).code, 'RUNTIME_DISABLED');
  runtime.blocked.mock.mockImplementation(() => null);
  for (const bad of [null, {}, { ...cfg, ai_model: '' }, { ...cfg, ai_base_url: 'http://example.test' }]) {
    assert.equal((await testConnection(bad, secrets)).code, 'INVALID_CONFIG');
  }
  for (const key of ['', 'bad key', 'bad\nkey', '\ud800', 'x'.repeat(4097), null]) {
    assert.equal((await testConnection(cfg, { ai_api_key: key })).code, 'INVALID_CONFIG');
  }
  assert.equal(requests.length, 0);
});

test('connection tests neither read nor update translation cache and service backoff', async (t) => {
  let failure = false;
  const { testConnection, translateTweet, requests } = setup(t, async (_url, options) => {
    const testing = JSON.parse(options.body).messages.length === 1;
    return failure ? new Response('private upstream details', { status: 500 })
      : Response.json(completion(testing ? 'Hello!' : '这是翻译。'));
  });
  assert.equal((await translateTweet(tweet, cfg, secrets)).ok, true);
  failure = true;
  assert.equal((await testConnection(cfg, secrets)).code, 'REQUEST_FAILED');
  failure = false;
  assert.equal((await translateTweet({ ...tweet, text: tweet.text + ' New text.' }, cfg, secrets)).ok, true);
  assert.equal((await translateTweet(tweet, cfg, secrets)).ok, true);
  assert.equal(requests.length, 3, 'test failure does not create translation backoff or clear cache');
  failure = true;
  assert.equal((await translateTweet({ ...tweet, text: tweet.text + ' More text.' }, cfg, secrets)).code, 'REQUEST_FAILED');
  failure = false;
  assert.equal((await testConnection(cfg, secrets)).reply, 'Hello!');
  assert.equal((await testConnection(cfg, secrets)).reply, 'Hello!');
  assert.equal(requests.length, 6, 'each explicit test makes a fresh request despite translation backoff');
});

test('connection errors classify safe HTTP status without returning provider diagnostics', async (t) => {
  let status = 400;
  const { testConnection } = setup(t, async () => new Response('private provider details synthetic-key', { status }));
  for (const [http, code] of [[400, 'INVALID_REQUEST'], [401, 'AUTH_FAILED'], [403, 'ACCESS_DENIED'],
    [404, 'MODEL_OR_ENDPOINT_NOT_FOUND'], [429, 'RATE_LIMITED'], [500, 'REQUEST_FAILED']]) {
    status = http;
    const answer = await testConnection(cfg, secrets);
    assert.equal(answer.code, code);
    assert.doesNotMatch(JSON.stringify(answer), /private provider|synthetic-key/);
  }
  fetch.mock.mockImplementation(async () => { throw new Error('private network diagnostic synthetic-key'); });
  assert.equal((await testConnection(cfg, secrets)).code, 'REQUEST_FAILED');
});

test('connection test rejects unfinished, tool, refused, secret echo and malformed text replies', async (t) => {
  const valid = completion('Hello!').choices[0];
  const bodies = [null, {}, completion(''), completion('synthetic-key'), completion('\ud800'),
    completion('hello\u0001world'), completion('x'.repeat(4001)), { error: { message: 'private' }, ...completion('Hello') },
    { choices: [{ ...valid, finish_reason: 'length' }] }, { choices: [{ ...valid, finish_reason: 'tool_calls' }] },
    { choices: [{ ...valid, message: { ...valid.message, tool_calls: [] } }] },
    { choices: [{ ...valid, message: { ...valid.message, refusal: 'private refusal' } }] },
    { choices: [{ ...valid, message: { ...valid.message, function_call: {} } }] }];
  let index = 0;
  const { testConnection } = setup(t, async () => Response.json(bodies[index++]));
  for (let i = 0; i < bodies.length; i++) {
    const answer = await testConnection(cfg, secrets);
    assert.equal(answer.code, 'INVALID_RESPONSE');
    assert.doesNotMatch(JSON.stringify(answer), /private|synthetic-key/);
  }
});

test('connection test shares deadline, cancellation and byte bounds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  let cancelled = false;
  const { testConnection } = setup(t, async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  });
  const pending = testConnection(cfg, secrets);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(15000);
  assert.equal((await pending).code, 'TIMEOUT');
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
  cancelled = false;
  fetch.mock.mockImplementation(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(128 * 1024 + 1)); },
    cancel() { cancelled = true; },
  })));
  assert.equal((await testConnection(cfg, secrets)).code, 'INVALID_RESPONSE');
  assert.equal(cancelled, true);
});
