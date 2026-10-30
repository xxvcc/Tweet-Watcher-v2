'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSimulation, tweet, idAt, waitFor, sourceKey } = require('./harness.cjs');
const results = [];
const baseTime = Date.now() - 120000;
const id = (n) => idAt(baseTime + n * 1000);
const photo = (n) => ({ type: 'photo', media_url_https: `https://pbs.twimg.com/media/simulation-${n}.jpg` });
const video = (n, type = 'video') => ({ type, media_url_https: `https://pbs.twimg.com/ext_tw_video_thumb/${n}/pu/img/a.jpg`,
  video_info: { duration_millis: 1000, variants: [{ content_type: 'video/mp4', bitrate: 200000,
    url: `https://video.twimg.com/ext_tw_video/${n}/pu/vid/320x180/a.mp4` }] } });
async function scenario(t, options = {}) {
  const h = await createSimulation({ name: t.name, ...options });
  t.after(async () => {
    try {
      assert.deepEqual(h.forbidden, [], 'no unexpected external destination');
      assert.deepEqual(h.events.filter((e) => e.type === 'emulator-error'), [], 'fixture protocol must stay valid');
      results.push({ name: t.name, xRequests: h.events.filter((e) => e.type === 'x').length,
        aiRequests: h.events.filter((e) => e.type === 'ai').length, telegramAccepted: h.accepted.length,
        faults: h.childEvents.filter((e) => e.event === 'fault').map(({ where, phase, file, action }) => ({ where, phase, file, action })) });
    } finally { await h.close(); }
  });
  return h;
}
const checkpoint = (h, key = 'alice') => h.read('delivery_state.json').accounts[key].acquisitionWatermark;
const pending = (h, key = 'alice') => h.read('delivery_state.json').accounts[key].pending;
function telegramText(call) {
  if (call.method === 'sendMediaGroup') return JSON.parse(call.fields.media)[0]?.caption || '';
  return call.fields.text || call.fields.caption || '';
}
const mainTexts = (h, value) => h.accepted.map(telegramText)
  .filter((text) => text.includes('X链接：') && text.includes('/status/' + value));

test('full TLS pipeline: sources, filters, non-Chinese translation, quote/article, native media and durable dedup', async (t) => {
  const accounts = [{ username: 'alice', fetch_count: 20, check_interval: 30, filters: { exclude: ['discard'] } },
    { source_type: 'list', list_id: '123', fetch_count: 20, check_interval: 30, filters: { exclude: ['discard'] } },
    { source_type: 'search', query: 'simulation topic', fetch_count: 20, check_interval: 30 },
    { username: 'bob', timeline_mode: 'replies', fetch_count: 20, check_interval: 30 }];
  const h = await scenario(t, { config: { accounts } });
  for (const key of ['user:alice', 'list:123', 'search:simulation topic']) h.sources.set(key, [tweet(id(0))]);
  h.sources.set('replies:bob', [tweet(id(0), 'bob')]);
  await h.start(); await h.tick(0); assert.equal(h.accepted.length, 0, 'baseline must never replay history');
  const quote = tweet(id(-1), 'carol', { text: 'Quoted context' });
  const posts = [tweet(id(6), 'alice', { text: 'discard this advertisement' }),
    tweet(id(5), 'alice', { text: '纯中文正文不应调用翻译', lang: 'zh' }),
    tweet(id(4), 'alice', { text: 'Animation update', media: [video(4, 'animated_gif')] }),
    tweet(id(3), 'alice', { text: 'Video update', media: [video(3)] }),
    tweet(id(2), 'alice', { text: 'Album update', media: [photo(21), photo(22)] }),
    tweet(id(1), 'alice', { text: 'English photo and article', media: [photo(1)], quote,
      article: { rest_id: '99', title: 'Synthetic Article', preview_text: 'Synthetic article preview' } }), tweet(id(0))];
  h.sources.set('user:alice', posts); h.sources.set('list:123', posts);
  h.sources.set('replies:bob', [tweet(id(7), 'bob', { text: 'Reply update', replyTo: id(0) }), tweet(id(0), 'bob')]);
  h.sources.set('search:simulation topic', [tweet(id(8), 'carol', { text: 'Topic discovery' }), tweet(id(0))]);
  await h.tick();
  for (let n = 1; n <= 8; n++) assert.equal(mainTexts(h, id(n)).length, n === 6 ? 0 : 1, 'per-ID original delivery');
  for (const method of ['sendPhoto', 'sendMediaGroup', 'sendVideo', 'sendAnimation']) assert.equal(h.accepted.filter((e) => e.method === method).length, 1, method);
  assert.match(mainTexts(h, id(1))[0], /AI 中文翻译：[\s\S]*原文：[\s\S]*English photo/);
  assert.doesNotMatch(mainTexts(h, id(5))[0], /AI 中文翻译/);
  for (const call of h.accepted.filter((e) => e.method !== 'sendMessage')) {
    assert.ok(telegramText(call).includes('X链接：'), 'short media carries its original text instead of a separate message');
    assert.ok(telegramText(call).length <= 1024);
    if (call.method === 'sendMediaGroup') {
      assert.ok(JSON.parse(call.fields.media).slice(1).every((item) => item.caption === undefined));
    }
  }
  assert.ok(h.accepted.some((e) => e.fields.text?.includes('Quoted context')));
  assert.ok(h.accepted.some((e) => e.fields.text?.includes('Synthetic article preview')));
  assert.equal(h.events.filter((e) => e.type === 'ai').length, 6);
  assert.equal(h.read('delivery_state.json').accounts.alice.dispositions[0].id, id(6));
  assert.equal(checkpoint(h), id(6));
  const count = h.accepted.length;
  await h.restart(); await h.tick(); assert.equal(h.accepted.length, count, 'restart/repeated collection must not redeliver');
  for (const record of Object.values(h.read('delivery_state.json').accounts)) assert.equal(record.pending.length, 0);
});

test('real bridge GET retries, broken connection, partial GraphQL and durable shared cooldown recover without advancing unknown coverage', async (t) => {
  const h = await scenario(t);
  h.sources.set('user:alice', [tweet(id(0))]); await h.start(); await h.tick(0);
  let attempts = 0;
  h.xFault = (call) => call.operation === 'UserTweets' && ++attempts < 3 ? { status: 503, body: {} } : undefined;
  h.sources.set('user:alice', [tweet(id(1)), tweet(id(0))]); await h.tick();
  assert.equal(attempts, 3); assert.equal(mainTexts(h, id(1)).length, 1);
  attempts = 0; h.xFault = (call) => call.operation === 'UserTweets' ? (++attempts, { disconnect: true }) : undefined;
  h.sources.set('user:alice', [tweet(id(2)), tweet(id(1)), tweet(id(0))]); await h.tick();
  assert.equal(attempts, 3); assert.equal(checkpoint(h), id(1));
  h.xFault = (call) => call.operation === 'UserTweets' ? { body: { data: {}, errors: [{ code: 999, message: 'Synthetic partial page' }] } } : undefined;
  await h.tick(); assert.equal(checkpoint(h), id(1)); assert.equal(mainTexts(h, id(2)).length, 0);
  assert.ok(fs.readdirSync(h.dataDir).some((f) => f.startsWith('evidence-')));
  h.xFault = (call) => call.operation === 'UserTweets' ? { status: 429, headers: { 'x-rate-limit-remaining': 'invalid', 'x-rate-limit-reset': 'invalid' }, body: {} } : undefined;
  await h.tick();
  const calls = h.events.filter((e) => e.type === 'x').length;
  await h.restart(); await h.tick(); assert.equal(h.events.filter((e) => e.type === 'x').length, calls, 'cooldown survives restart');
  h.xFault = null; await h.tick(16 * 60000);
  assert.equal(checkpoint(h), id(2)); assert.equal(mainTexts(h, id(2)).length, 1);
});

test('persistent multi-round catchup survives SIGKILL and ordinary evidence removal before committing the complete interval', async (t) => {
  const h = await scenario(t, { config: { ai_translation_enabled: false } });
  h.pageSize = 1; h.sources.set('user:alice', [tweet(id(0))]); await h.start(); await h.tick(0);
  h.sources.set('user:alice', Array.from({ length: 9 }, (_, n) => tweet(id(8 - n))));
  await h.tick(); assert.equal(checkpoint(h), id(0)); assert.equal(h.accepted.length, 0);
  const progress = (await h.rpc('snapshot')).diagnostics.backfills.alice;
  assert.equal(progress.pages, 5);
  for (const file of fs.readdirSync(h.dataDir).filter((f) => f.startsWith('evidence-'))) fs.unlinkSync(path.join(h.dataDir, file));
  await h.restart(); const before = h.events.length; await h.tick();
  const first = h.events.slice(before).find((e) => e.type === 'x' && e.operation === 'UserTweets');
  assert.equal(first.variables.cursor, 'page:5'); assert.equal(checkpoint(h), id(8));
  for (let n = 1; n <= 8; n++) assert.equal(mainTexts(h, id(n)).length, 1);
  assert.deepEqual((await h.rpc('snapshot')).diagnostics.backfills, {});
});

test('capture I/O failure sends nothing and restart recovers the complete durable raw interval', async (t) => {
  const h = await scenario(t);
  h.sources.set('user:alice', [tweet(id(0))]); await h.start(); await h.tick(0);
  h.sources.set('user:alice', [tweet(id(1)), tweet(id(0))]);
  await h.rpc('fault', { where: 'rename', file: 'delivery_state.json', phase: 'before', pendingId: id(1), action: 'error' });
  await h.tick(); assert.equal(checkpoint(h), id(0)); assert.equal(h.accepted.length, 0);
  assert.equal((await h.rpc('snapshot')).diagnostics.backfills.alice.status, 'ready');
  await h.restart(); const before = h.events.filter((e) => e.type === 'x').length;
  await h.tick(); assert.equal(h.events.filter((e) => e.type === 'x').length, before, 'ready recovery must remain local');
  assert.equal(mainTexts(h, id(1)).length, 1); assert.equal(pending(h).length, 0);
});

test('partial album confirmation retains its pending part and resumes after restart without resending confirmed text', async (t) => {
  const h = await scenario(t);
  h.sources.set('user:alice', [tweet(id(0))]); await h.start(); await h.tick(0);
  h.aiFault = () => ({ body: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '完整中文相册说明。'.repeat(120) } }] } });
  h.sources.set('user:alice', [tweet(id(1), 'alice', { text: 'Long album description. '.repeat(50), media: [photo(1), photo(2)] }), tweet(id(0))]);
  h.tgFault = (call) => call.method === 'sendMediaGroup' ? { body: { ok: true, result: [{ message_id: 100 }] } } : undefined;
  await h.tick(); assert.equal(mainTexts(h, id(1)).length, 1); assert.equal(pending(h)[0].delivery.next, 1);
  const ai = h.events.filter((e) => e.type === 'ai').length;
  await h.restart(); h.tgFault = null; const before = h.accepted.length; await h.tick();
  assert.deepEqual(h.accepted.slice(before).map((e) => e.method), ['sendMediaGroup']);
  assert.equal(mainTexts(h, id(1)).length, 1); assert.equal(pending(h).length, 0);
  assert.equal(h.events.filter((e) => e.type === 'ai').length, ai, 'frozen plan does not repeat translation');
});

test('long bilingual text survives numbered splitting, Telegram 429 and restart without truncation or confirmed-part replay', async (t) => {
  const h = await scenario(t);
  h.sources.set('user:alice', [tweet(id(0))]); await h.start(); await h.tick(0);
  const original = Array.from({ length: 110 }, (_, n) => `Paragraph ${n}: synthetic English text with emoji 😀 and preserved whitespace.\n\n`).join('');
  const translated = Array.from({ length: 160 }, (_, n) => `第${n}段：完整保留的中文译文与表情😀，不得省略或重复。\n\n`).join('');
  h.aiFault = () => ({ body: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: translated } }] } });
  h.sources.set('user:alice', [tweet(id(1), 'alice', { text: original, media: [photo(1)] }), tweet(id(0))]);
  let textAttempts = 0;
  h.tgFault = (call) => call.method === 'sendMessage' && ++textAttempts === 2
    ? { status: 429, body: { ok: false, error_code: 429, parameters: { retry_after: 60 } } } : undefined;
  await h.tick();
  assert.equal(h.accepted.length, 1);
  assert.equal(pending(h)[0].delivery.next, 1);
  const first = telegramText(h.accepted[0]);
  const attempts = h.events.filter((e) => e.type === 'telegram').length;
  await h.tick(0);
  assert.equal(h.events.filter((e) => e.type === 'telegram').length, attempts, 'rate backoff must stop immediate retries');
  await h.restart(); h.tgFault = null; await h.tick(61000);
  const texts = h.accepted.filter((e) => e.method === 'sendMessage').map(telegramText);
  assert.ok(texts.length > 2);
  for (const [index, text] of texts.entries()) {
    assert.ok(text.startsWith(`「${index + 1}/${texts.length}」\n`), 'all text chunks carry a consistent sequence');
    assert.ok(text.length <= 4096 && text.isWellFormed());
  }
  const complete = texts.map((text) => text.replace(/^「\d+\/\d+」\n/, '')).join('');
  assert.ok(complete.endsWith(`\n\nAI 中文翻译：\n${translated.trim()}\n\n原文：\n${original}`), 'all original and translated characters must reach the TLS receiver');
  assert.doesNotMatch(complete, /内容已截断/);
  assert.equal(texts.filter((text) => text === first).length, 1, 'confirmed first chunk must not repeat');
  assert.equal(h.accepted.at(-1).method, 'sendPhoto', 'long-text media follows every text chunk');
  assert.equal(h.accepted.at(-1).fields.caption, undefined);
  assert.equal(h.events.filter((e) => e.type === 'ai').length, 1, 'restart uses the frozen translation and plan');
  assert.equal(pending(h).length, 0);
});

test('slow real HTTP translation does not block another source or interval and pause cancels stale delivery', async (t) => {
  const h = await scenario(t, { config: { accounts: ['alice', 'bob'].map((username) => ({ username, fetch_count: 20, check_interval: 30 })) } });
  for (const user of ['alice', 'bob']) h.sources.set('user:' + user, [tweet(id(0), user)]);
  await h.start(); await h.tick(0);
  let release; const gate = new Promise((r) => { release = r; }); t.after(() => release());
  h.aiFault = async () => { await gate; return undefined; };
  for (const user of ['alice', 'bob']) h.sources.get('user:' + user).unshift(tweet(id(user === 'alice' ? 1 : 2), user));
  await h.tick(31000, { waitForDelivery: false });
  await waitFor(() => h.events.some((e) => e.type === 'ai'));
  assert.equal(checkpoint(h, 'bob'), id(2));
  h.sources.get('user:bob').unshift(tweet(id(3), 'bob'));
  await h.tick(31000, { waitForDelivery: false }); assert.equal(checkpoint(h, 'bob'), id(3));
  await h.rpc('config', { config: { paused: true } }); release();
  await waitFor(() => h.events.find((e) => e.type === 'ai').respondedAt);
  await h.tick(0); assert.equal(h.accepted.length, 0);
  h.aiFault = null; await h.rpc('config', { config: { paused: false } }); await h.tick(0);
  for (const n of [1, 2, 3]) assert.equal(mainTexts(h, id(n)).length, 1);
});

test('search delayed indexing stays unique across a day of inactivity and process restart', async (t) => {
  const account = { source_type: 'search', query: 'simulation topic', fetch_count: 20, check_interval: 30 };
  const h = await scenario(t, { config: { accounts: [account], ai_translation_enabled: false } });
  h.sources.set('search:simulation topic', [tweet(id(0))]); await h.start(); await h.tick(0);
  h.sources.get('search:simulation topic').unshift(tweet(id(5))); await h.tick();
  h.sources.set('search:simulation topic', [tweet(id(5)), tweet(id(3)), tweet(id(0))]); await h.tick();
  assert.equal(checkpoint(h, sourceKey(account)), id(5)); assert.equal(mainTexts(h, id(3)).length, 1);
  await h.tick(26 * 3600000); await h.restart(); await h.tick();
  assert.equal(mainTexts(h, id(3)).length, 1); assert.equal(mainTexts(h, id(5)).length, 1);
});

test('an authenticated-session failure moves subsequent work to a different Cookie without losing the failed source interval', async (t) => {
  const h = await scenario(t, { config: { accounts: ['alice', 'bob'].map((username) => ({ username, fetch_count: 20, check_interval: 30 })),
    x_sessions: [{ id: 'backup', label: '备用', enabled: true }] },
    secrets: { x_sessions: { backup: { auth_token: 'SYNTHETIC_backup', ct0: 'SYNTHETIC_CSRF_backup' } } } });
  h.sources.set('user:alice', [tweet(id(0))]); h.sources.set('user:bob', [tweet(id(1), 'bob')]);
  await h.start(); await h.tick(0);
  h.sources.get('user:alice').unshift(tweet(id(2))); h.sources.get('user:bob').unshift(tweet(id(3), 'bob'));
  h.xFault = (call) => call.session === 'default' ? { status: 401, body: {} } : undefined;
  await h.tick();
  const failedSource = h.events.find((e) => e.type === 'x' && e.session === 'default' && e.status === 401).sourceKey.split(':')[1];
  assert.ok(['alice', 'bob'].includes(failedSource));
  assert.equal(checkpoint(h, failedSource), id(failedSource === 'alice' ? 0 : 1));
  assert.equal(checkpoint(h, failedSource === 'alice' ? 'bob' : 'alice'), id(failedSource === 'alice' ? 3 : 2));
  const failedCalls = h.events.filter((e) => e.type === 'x' && e.session === 'default').length;
  await h.tick(); assert.equal(checkpoint(h), id(2)); assert.equal(checkpoint(h, 'bob'), id(3));
  assert.equal(h.events.filter((e) => e.type === 'x' && e.session === 'default').length, failedCalls);
  assert.equal((await h.rpc('snapshot')).diagnostics.sessions.default.status, 'auth-required');
  for (const n of [2, 3]) assert.equal(mainTexts(h, id(n)).length, 1);
});

test('corrupted protected catchup evidence after restart blocks collection and delivery until original evidence is restored', async (t) => {
  const h = await scenario(t, { config: { ai_translation_enabled: false } });
  h.pageSize = 1; h.sources.set('user:alice', [tweet(id(0))]); await h.start(); await h.tick(0);
  h.sources.set('user:alice', Array.from({ length: 8 }, (_, n) => tweet(id(7 - n)))); await h.tick();
  const filename = path.join(h.dataDir, fs.readdirSync(h.dataDir).find((name) => name.startsWith('catchup-')));
  const original = fs.readFileSync(filename);
  await h.kill(); const modified = JSON.parse(original); modified.pages[0].data = { data: {} };
  fs.writeFileSync(filename, JSON.stringify(modified), { mode: 0o600 });
  await h.start(); const requests = h.events.filter((e) => e.type === 'x').length;
  await assert.rejects(h.tick(), /补采|状态/);
  assert.equal(h.events.filter((e) => e.type === 'x').length, requests);
  assert.equal(checkpoint(h), id(0)); assert.equal(h.accepted.length, 0);
  await h.kill(); fs.writeFileSync(filename, original, { mode: 0o600 }); await h.start(); await h.tick();
  assert.equal(checkpoint(h), id(7)); for (let n = 1; n <= 7; n++) assert.equal(mainTexts(h, id(n)).length, 1);
});

test('all sources honor process mode gates even when enabled synthetic credentials are present', async (t) => {
  for (const runtimeMode of ['development', 'read-only']) {
    const h = await createSimulation({ name: 'gates-' + runtimeMode, runtimeMode });
    try {
      h.sources.set('user:alice', [tweet(id(0))]); await h.start(); await h.tick(0);
      assert.equal(h.events.length, 0); assert.equal(h.read('delivery_state.json'), null);
      const login = await fetch(h.baseUrl + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: h.password }) });
      assert.equal(login.status, 200);
      const cookies = login.headers.getSetCookie().map((s) => s.split(';')[0]);
      const csrf = cookies.find((s) => s.startsWith('tw_csrf=')).slice('tw_csrf='.length);
      const response = await fetch(h.baseUrl + '/api/test/session', { method: 'POST', headers: {
        'content-type': 'application/json', cookie: cookies.join('; '), 'x-csrf': csrf,
      }, body: JSON.stringify({ session_id: 'default', username: 'alice', config_revision: h.read('config.json')._revision }) });
      if (runtimeMode === 'development') { assert.equal(response.status, 409); assert.equal((await response.json()).code, 'RUNTIME_DISABLED'); assert.equal(h.events.length, 0); }
      else { assert.equal(response.status, 200); assert.equal((await response.json()).ok, true); assert.ok(h.events.some((e) => e.type === 'x')); }
      assert.equal(h.accepted.length, 0); assert.equal(h.events.filter((e) => e.type === 'ai').length, 0);
    } finally { await h.close(); }
  }
});

test.after(() => {
  if (process.env.SIMULATION_REPORT) fs.writeFileSync(process.env.SIMULATION_REPORT,
    JSON.stringify({ mode: 'isolated-loopback-TLS', time: new Date().toISOString(), scenarios: results }, null, 2), { mode: 0o600 });
});
