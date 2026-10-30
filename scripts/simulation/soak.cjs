'use strict';
// Five minutes of real wall-clock scheduling. Only publish synthetic upstream
// posts; never drive worker.tick or advance the application's clock manually.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSimulation, tweet, idAt, waitFor, delay } = require('./harness.cjs');

const MINIMUM_MS = 5 * 60 * 1000;
const MAXIMUM_MS = 6 * 60 * 1000;
const PAUSED_OBSERVATION_MS = 30000;

function partIdentity(call) {
  if (call.method === 'sendMessage') {
    const id = call.fields.text?.match(/https:\/\/x\.com\/(?:alice|bob)\/status\/(\d+)/)?.[1];
    return id ? `${id}:text` : null;
  }
  if (call.method === 'sendPhoto') {
    const id = call.fields.photo?.match(/\/soak-(\d+)\.jpg$/)?.[1];
    return id ? `${id}:photo` : null;
  }
  if (call.method === 'sendMediaGroup') {
    const media = JSON.parse(call.fields.media || '[]');
    const ids = media.map((item) => item.media.match(/\/soak-(\d+)(?:-second)?\.(?:jpg|mp4)$/)?.[1]);
    assert.equal(media.length, 3); assert.deepEqual(media.map((item) => item.type), ['photo', 'photo', 'video']);
    assert.ok(ids[0] && ids.every((id) => id === ids[0]));
    return `${ids[0]}:album`;
  }
  return null;
}

async function authenticatedControl(h) {
  const login = await fetch(h.baseUrl + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: h.password }) });
  assert.equal(login.status, 200);
  const cookies = login.headers.getSetCookie().map((cookie) => cookie.split(';', 1)[0]);
  const csrf = cookies.find((cookie) => cookie.startsWith('tw_csrf='))?.slice('tw_csrf='.length);
  assert.ok(csrf);
  return async (action) => {
    const response = await fetch(h.baseUrl + '/api/control', { method: 'POST', headers: {
      'content-type': 'application/json', cookie: cookies.join('; '), 'x-csrf': decodeURIComponent(csrf),
    }, body: JSON.stringify({ action }) });
    assert.equal(response.status, 200); const result = await response.json();
    assert.equal(result.ok, true); assert.equal(result.paused, action === 'pause');
    return result;
  };
}

async function runSoak() {
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'tweet-watcher-real-clock-soak-'));
  const h = await createSimulation({ name: 'five-minute-real-clock', fastPacing: false,
    config: { paused: false, accounts: ['alice', 'bob'].map((username) => ({ username, fetch_count: 20, check_interval: 30 })),
      media_mode: 'all', enrichment_mode: 'off', ai_translation_enabled: true } });
  const initialTime = Date.now();
  const baselines = Object.fromEntries(['alice', 'bob'].map((username, index) => [username, idAt(initialTime, index)]));
  for (const username of ['alice', 'bob']) h.sources.set('user:' + username,
    [tweet(baselines[username], username, { text: 'Synthetic soak initial baseline ' + username })]);
  const expected = [], samples = [], publications = [];
  let injected429 = null, delayedAi = null, startedAt, pausedAt = null, pauseEvents = null, publishedRounds = 0;
  h.tgFault = (call) => {
    if (!injected429) {
      injected429 = call;
      return { status: 429, headers: { 'retry-after': '2' }, body: { ok: false, error_code: 429,
        description: 'Synthetic flood control', parameters: { retry_after: 2 } } };
    }
  };
  h.aiFault = (call) => {
    if (!delayedAi) {
      delayedAi = call;
      return { delayMs: 1000, body: { choices: [{ finish_reason: 'stop', message: { role: 'assistant',
        content: '中文慢响应译文：' + call.body.messages.at(-1).content } }] } };
    }
  };
  const count = (type) => h.events.filter((event) => event.type === type).length;
  const pending = () => Object.values(h.read('delivery_state.json')?.accounts || {}).reduce((sum, record) => sum + record.pending.length, 0);
  const delivered = () => {
    if (publishedRounds !== 10 || pending() !== 0) return false;
    const state = h.read('delivery_state.json');
    return expected.every((item) => state?.accounts[item.username]?.sent.includes(item.id));
  };
  async function sample(stage) {
    const snapshot = await h.rpc('snapshot');
    assert.equal(snapshot.offset, 0, 'real-clock soak must never advance its application clock');
    assert.ok(Math.abs(snapshot.clock - Date.now()) < 2000);
    const entry = { elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), stage, publishedRounds,
      publishedTweets: expected.length, xRequests: count('x'), aiRequests: count('ai'),
      telegramRequests: count('telegram'), acceptedParts: h.accepted.length, pending: pending(),
      heapMiB: +(snapshot.memory.heapUsed / 1048576).toFixed(2), rssMiB: +(snapshot.memory.rss / 1048576).toFixed(2),
      lastTickAt: snapshot.status.lastTickAt, paused: snapshot.status.paused, clockOffset: snapshot.offset };
    samples.push(entry); console.log(JSON.stringify({ soak: entry }));
    return entry;
  }
  function publish(round) {
    const publishedAt = Date.now();
    for (const [index, username] of ['alice', 'bob'].entries()) {
      const id = idAt(publishedAt, index);
      const photo = { type: 'photo', media_url_https: `https://pbs.twimg.com/media/soak-${id}.jpg` };
      const media = username === 'alice' ? [photo] : [photo,
        { type: 'photo', media_url_https: `https://pbs.twimg.com/media/soak-${id}-second.jpg` },
        { type: 'video', media_url_https: `https://pbs.twimg.com/ext_tw_video_thumb/${id}/pu/img/preview.jpg`,
          video_info: { duration_millis: 1200, variants: [{ content_type: 'video/mp4', bitrate: 200000,
            url: `https://video.twimg.com/ext_tw_video/${id}/pu/vid/soak-${id}.mp4` }] } },
      ];
      h.sources.get('user:' + username).unshift(tweet(id, username,
        { text: `Synthetic real-clock round ${round} from ${username}, item ${id}`, media }));
      expected.push({ username, id, round, publishedAt, parts: [username === 'alice' ? 'photo' : 'album'] });
    }
    publishedRounds = round; publications.push({ round, at: publishedAt, elapsedSeconds: (publishedAt - startedAt) / 1000 });
  }
  try {
    await h.start({ autoStart: true }); startedAt = Date.now();
    const control = await authenticatedControl(h);
    await waitFor(() => {
      const state = h.read('delivery_state.json');
      return Object.entries(baselines).every(([username, id]) => state?.accounts[username]?.sent.includes(id));
    }, { timeout: 20000, label: 'automatic scheduler to establish both initial baselines' });
    assert.equal(h.accepted.length, 0, 'the initial timeline must establish baselines without replay');
    await sample('baseline');
    let nextSample = 30000;
    while (Date.now() - startedAt < MAXIMUM_MS) {
      const elapsed = Date.now() - startedAt;
      if (publishedRounds < 10 && elapsed >= 5000 + publishedRounds * 25000) publish(publishedRounds + 1);
      if (elapsed >= nextSample) { await sample(pausedAt ? 'paused-observation' : 'running'); nextSample += 30000; }
      if (!pausedAt && elapsed >= MINIMUM_MS - PAUSED_OBSERVATION_MS && delivered()) {
        await control('pause'); pausedAt = Date.now();
        pauseEvents = { x: count('x'), ai: count('ai'), telegram: count('telegram'), accepted: h.accepted.length };
        await sample('pause-after-drain');
      }
      if (pausedAt && elapsed >= MINIMUM_MS && Date.now() - pausedAt >= PAUSED_OBSERVATION_MS) break;
      await delay(1000);
    }
    assert.ok(pausedAt, 'both queues must drain before the observation deadline');
    assert.ok(Date.now() - pausedAt >= PAUSED_OBSERVATION_MS, 'pause must be observed for at least 30 real seconds');
    assert.ok(Date.now() - startedAt >= MINIMUM_MS);
    assert.equal(publishedRounds, 10); assert.equal(expected.length, 20); assert.equal(pending(), 0);
    assert.deepEqual({ x: count('x'), ai: count('ai'), telegram: count('telegram'), accepted: h.accepted.length }, pauseEvents,
      'paused scheduler must not start collection, translation or delivery');
    const accepted = h.accepted.map(partIdentity);
    assert.equal(accepted.length, 20); assert.equal(new Set(accepted).size, accepted.length);
    const expectedParts = expected.flatMap((item) => item.parts.map((part) => `${item.id}:${part}`));
    assert.deepEqual(accepted.slice().sort(), expectedParts.slice().sort());
    const finalState = h.read('delivery_state.json');
    for (const item of expected) assert.equal(finalState.accounts[item.username].sent.filter((id) => id === item.id).length, 1);
    for (const call of h.accepted) {
      const caption = call.method === 'sendMediaGroup' ? JSON.parse(call.fields.media)[0]?.caption : call.fields.caption;
      assert.ok(caption?.includes('Synthetic real-clock round '), 'each short post must retain its body in the media caption');
      assert.ok(caption.length <= 1024 && caption.isWellFormed());
    }
    assert.ok(injected429 && delayedAi); assert.equal(count('telegram'), 21); assert.equal(count('ai'), 20);
    const retry = h.events.find((event) => event.type === 'telegram' && event.seq > injected429.seq);
    assert.ok(retry.at - injected429.respondedAt >= 1900, 'Telegram retry_after must be respected by real timers');
    assert.ok(delayedAi.respondedAt - delayedAi.at >= 950, 'the slow AI response must use real elapsed time');
    assert.deepEqual(h.forbidden, []); assert.equal(count('emulator-error'), 0);
    assert.ok(h.events.filter((event) => event.type === 'x').every((event) => event.signed));
    await sample('complete');
    const result = { ok: true, startedAt: new Date(startedAt).toISOString(), durationSeconds: +(Date.now() - startedAt) / 1000,
      scheduler: 'real worker.start and 5-second loop; two sources at 30-second intervals',
      fastPacing: false, manualTicks: 0, clockAdvances: 0, rounds: publishedRounds, expectedTweets: expected.length,
      acceptedParts: accepted.length, telegramAttempts: count('telegram'), aiRequests: count('ai'), xRequests: count('x'),
      injectedTelegram429: 1, telegramRetryDelayMs: retry.at - injected429.respondedAt,
      injectedAiDelayMs: delayedAi.respondedAt - delayedAi.at, pausedObservationSeconds: (Date.now() - pausedAt) / 1000,
      pending: 0, missingParts: 0, duplicateAcceptedParts: 0, blockedUnexpectedRequests: h.forbidden.length,
      networkScope: 'application routing guards; no OS packet capture',
      scope: 'Five-minute local simulation; this does not establish long-term reliability or real provider behavior.',
      expected, publications, samples, artifacts };
    fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ok: true, durationSeconds: result.durationSeconds, expectedTweets: expected.length,
      acceptedParts: accepted.length, pending: 0, missingParts: 0, duplicateAcceptedParts: 0, artifacts }));
    return result;
  } catch (error) {
    const report = { ok: false, error: error.message, durationSeconds: startedAt ? (Date.now() - startedAt) / 1000 : 0,
      expected, publications, samples, artifacts };
    fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    console.error(JSON.stringify({ ok: false, error: error.message, artifacts })); throw error;
  } finally {
    await h.close();
    const privateStateRemoved = !fs.existsSync(h.directory);
    const reportPath = path.join(artifacts, 'report.json');
    if (fs.existsSync(reportPath)) {
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      report.privateStateRemoved = privateStateRemoved;
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    }
    assert.equal(privateStateRemoved, true, 'soak private state must be removed');
  }
}

module.exports = { runSoak, partIdentity };
if (require.main === module) runSoak().catch(() => { process.exitCode = 1; });
