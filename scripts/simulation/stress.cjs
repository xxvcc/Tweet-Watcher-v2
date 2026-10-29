#!/usr/bin/env node
'use strict';

// Local TLS peers synthesize X/AI/Telegram; production modules and fsync-backed
// storage run in a separate OS process. SIGKILL is not a power-loss simulation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSimulation, tweet, idAt, sourceKey, waitFor } = require('./harness.cjs');
const { createScenario, verifyDelivery, providerPart, mediaFor, descending } = require('./stress-oracle.cjs');

const args = process.argv.slice(2);
function option(name, fallback) { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; }
const rounds = Number(option('--rounds', 20));
const batch = Number(option('--batch', 5));
assert.ok(Number.isSafeInteger(rounds) && rounds >= 8 && rounds <= 40, '--rounds must be 8..40');
assert.ok(Number.isSafeInteger(batch) && batch >= 1 && batch <= 10, '--batch must be 1..10');
const output = path.resolve(option('--output', `/tmp/twv2-stress-${Date.now()}.json`));
const report = { suite: 'twv2-local-tls-stress', startedAt: new Date().toISOString(), rounds, batch,
  mode: { peers: 'synthetic local TLS', application: 'real Python bridge, parser, worker, AI/Telegram HTTP contracts and fsync store',
    pacing: 'worker 500/2000ms waits become 1/5ms; scheduler clock advanced explicitly',
    crashModel: 'SIGKILL process crash; no claim of power-loss filesystem behavior' }, scenarios: [] };
function pendingCount(h) { return Object.values(h.read('delivery_state.json')?.accounts || {}).reduce((sum, record) => sum + record.pending.length, 0); }
function note(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function assertPrivateFiles(h) {
  assert.equal(fs.statSync(h.dataDir).mode & 0o777, 0o700);
  for (const file of fs.readdirSync(h.dataDir)) if (fs.statSync(path.join(h.dataDir, file)).isFile()) {
    assert.equal(fs.statSync(path.join(h.dataDir, file)).mode & 0o077, 0, `state file permissions: ${file}`);
  }
  assert.deepEqual(h.forbidden, [], 'unexpected external destination attempted');
  assert.deepEqual(h.events.filter((event) => event.type === 'emulator-error'), [], 'synthetic peer had an internal error');
}
async function drain(h, max = 12) {
  for (let attempt = 0; attempt < max; attempt++) {
    await h.tick(attempt === 0 ? 16 * 60e3 : 31000);
    if (!pendingCount(h) && !Object.keys((await h.rpc('snapshot')).diagnostics.backfills).length) return;
  }
  assert.equal(pendingCount(h), 0, 'backlog did not drain within the bounded recovery rounds');
}

async function sustainedLoad() {
  const scenario = createScenario({ tweet, idAt, rounds, batch });
  const h = await createSimulation({ name: 'sustained-multi-source', config: { accounts: scenario.accounts,
    x_sessions: [{ id: 'backup', label: 'Synthetic backup', enabled: true }] },
    secrets: { x_sessions: { backup: { auth_token: 'SYNTHETIC_backup', ct0: 'SYNTHETIC_CSRF_backup' } } } });
  let wave = -1, tgRateInjected = false, xRateInjected = false, malformedInjected = false, aiFailures = 0;
  let releaseAI, slowAISeen = false;
  const slowAI = new Promise((resolve) => { releaseAI = resolve; });
  const faultLog = [], samples = [];
  try {
    for (const [key, values] of scenario.sources) h.sources.set(key, values);
    await h.start();
    await h.tick(0);
    assert.equal(h.accepted.length, 0, 'baseline must never be delivered');
    assert.equal(Object.keys(h.read('delivery_state.json').accounts).length, scenario.specs.length);
    h.aiFault = async () => {
      if (wave === 0 && !slowAISeen) { slowAISeen = true; await slowAI; }
      if (wave > 0 && wave % 5 === 2 && aiFailures++ % 4 === 0) return { status: 503, body: { error: { message: 'synthetic AI outage' } } };
    };
    h.tgFault = () => {
      if (wave >= 3 && wave <= 5) return { status: 503, body: { ok: false, error_code: 503, description: 'synthetic delivery outage' } };
      if (wave === 6 && !tgRateInjected) {
        tgRateInjected = true; faultLog.push({ kind: 'telegram-429', wave: wave + 1 });
        return { status: 429, body: { ok: false, error_code: 429, parameters: { retry_after: 2 } } };
      }
    };
    h.xFault = (call) => {
      if (wave === 6 && !xRateInjected && call.operation === 'UserTweets' && call.session === 'default') {
        xRateInjected = true; faultLog.push({ kind: 'x-429', wave: wave + 1, session: call.session });
        return { status: 429, headers: { 'x-rate-limit-remaining': '0' }, body: { errors: [{ code: 88, message: 'synthetic rate limit' }] } };
      }
      if (wave === 9 && !malformedInjected && call.operation === 'SearchTimeline') {
        malformedInjected = true; faultLog.push({ kind: 'malformed-search-page', wave: wave + 1 });
        return { body: { data: { search_by_raw_query: { search_timeline: { timeline: {
          instructions: [{ type: 'TimelineAddEntries', entries: [{ entryId: 'broken', content: {} }] }],
        } } } } } };
      }
    };
    let lateCheckpoint;
    for (wave = 0; wave < rounds; wave++) {
      const beforeSeq = h.events.at(-1)?.seq || 0;
      if (scenario.late && wave + 1 === scenario.late.visibleWave) {
        lateCheckpoint = h.read('delivery_state.json').accounts[sourceKey(scenario.specs.at(-1).config)].acquisitionWatermark;
        assert.ok(BigInt(scenario.late.id) < BigInt(lateCheckpoint), 'late index fixture must fall below the observed maximum');
      }
      scenario.publish(wave, h.sources);
      if (wave === 0) {
        await h.tick(31000, { waitForDelivery: false });
        await waitFor(() => slowAISeen, { label: 'slow AI request starts' });
        const requests = h.events.filter((event) => event.type === 'x' && event.seq > beforeSeq && event.sourceKey);
        for (const spec of scenario.specs) assert.ok(requests.some((event) => event.sourceKey === spec.key), `AI blocked collection of ${spec.key}`);
        assert.equal(h.accepted.length, 0, 'held AI response should keep the first delivery in flight');
        releaseAI(); await h.tick(0);
      } else await h.tick(31000);
      const snapshot = await h.rpc('snapshot');
      const pending = pendingCount(h);
      const currentPosts = new Map([...scenario.posts].filter(([id]) => scenario.published.has(id)));
      verifyDelivery({ posts: currentPosts, accepted: h.accepted, complete: false });
      samples.push({ wave: wave + 1, pending, accepted: h.accepted.length,
        heapUsed: snapshot.memory.heapUsed, rss: snapshot.memory.rss,
        xCalls: h.events.filter((event) => event.type === 'x' && event.seq > beforeSeq).length });
      if (wave === 5) assert.ok(pending >= batch * 8, 'delivery outage must leave a real durable backlog');
      if ((wave + 1) % 5 === 0) note({ phase: 'stress', wave: wave + 1, pending, accepted: h.accepted.length });
    }
    h.xFault = h.aiFault = h.tgFault = undefined;
    releaseAI();
    await drain(h);
    const result = verifyDelivery({ posts: scenario.posts, accepted: h.accepted });
    const final = h.read('delivery_state.json');
    for (const spec of scenario.specs) {
      const record = final.accounts[sourceKey(spec.config)];
      assert.equal(record.pending.length, 0);
      const newest = [...h.sources.get(spec.key)].sort(descending)[0].rest_id;
      assert.equal(record.acquisitionWatermark, newest, `source ${spec.key} did not catch up`);
    }
    const sessions = new Set(h.events.filter((event) => event.type === 'x').map((event) => event.session));
    assert.deepEqual([...sessions].sort(), ['backup', 'default']);
    assert.ok(tgRateInjected && xRateInjected, 'intended transient rate failures were not exercised');
    if (rounds >= 10) assert.ok(malformedInjected, 'intended malformed-page fault was not exercised');
    assert.ok(Math.max(...samples.map((sample) => sample.heapUsed)) < 192 * 1024 * 1024, 'Node heap exceeded the bounded stress budget');
    assertPrivateFiles(h);
    return { name: 'sustained-multi-source', generatedPosts: scenario.posts.size, sources: scenario.specs.length,
      sessions: [...sessions].sort(), ...result, lateIndex: { ...scenario.late, priorCheckpoint: lateCheckpoint },
      faults: faultLog, peakPending: Math.max(...samples.map((sample) => sample.pending)),
      peakHeapBytes: Math.max(...samples.map((sample) => sample.heapUsed)), samples,
      signedRequests: h.events.filter((event) => event.type === 'x' && event.signed).length,
      aiRequests: h.events.filter((event) => event.type === 'ai').length };
  } finally { releaseAI(); await h.close(); }
}

async function crashCase(name, point) {
  const baselineId = idAt(Date.now() - 60000, 1);
  const id = idAt(Date.now() - 30000, 2);
  const raw = tweet(id, 'alice', { text: `Synthetic crash stress_keep update ${id}.`, media: mediaFor(id, 2) });
  const posts = new Map([[id, { raw, dropped: false }]]);
  const h = await createSimulation({ name, config: { ai_translation_enabled: false } });
  let allowedDuplicates = new Map(), failure;
  try {
    h.sources.set('user:alice', [tweet(baselineId)]);
    await h.start(); await h.tick(0);
    h.sources.set('user:alice', [raw, tweet(baselineId)]);
    if (point === 'unconfirmed-provider-success') {
      let first = true;
      h.tgFault = () => {
        if (first) { first = false; return { accept: true, delayMs: 1500, body: { ok: true, result: { message_id: 999999 } } }; }
      };
      const running = h.tick(31000).catch((error) => { failure = error.message; });
      await waitFor(() => h.accepted.length === 1, { label: 'provider acceptance before response' });
      const key = providerPart(h.accepted[0]).key;
      allowedDuplicates.set(key, 1);
      assert.equal(h.read('delivery_state.json').accounts.alice.pending[0].delivery.next, 0);
      await h.kill(); await running;
    } else {
      const fault = point === 'capture-before-rename'
        ? { where: 'rename', file: 'delivery_state.json', phase: 'before', pendingId: id }
        : point === 'capture-after-rename'
          ? { where: 'rename', file: 'delivery_state.json', phase: 'after', pendingId: id }
          : point === 'part-after-rename'
            ? { where: 'rename', file: 'delivery_state.json', phase: 'after', pendingId: id, partNext: 1 }
            : { where: 'unlink', file: 'catchup-', phase: 'before' };
      await h.rpc('fault', { ...fault, action: 'kill', times: 1 });
      try { await h.tick(31000); } catch (error) { failure = error.message; }
      assert.ok(h.childEvents.some((event) => event.event === 'fault' && event.action === 'kill'), 'kill point did not execute');
      assert.equal(h.child.signalCode, 'SIGKILL');
      if (point === 'capture-before-rename') assert.equal(h.read('delivery_state.json').accounts.alice.acquisitionWatermark, baselineId);
      if (point === 'part-after-rename') {
        assert.equal(h.accepted.length, 1);
        assert.equal(h.read('delivery_state.json').accounts.alice.pending[0].delivery.next, 1);
      } else assert.equal(h.accepted.length, 0, 'collection/capture crash must precede any provider effect');
    }
    assert.ok(failure, 'SIGKILL must interrupt the in-progress RPC');
    h.tgFault = undefined;
    await h.restart();
    await drain(h);
    const result = verifyDelivery({ posts, accepted: h.accepted, allowedDuplicates });
    assert.equal(result.duplicateParts, point === 'unconfirmed-provider-success' ? 1 : 0);
    assert.equal(h.read('delivery_state.json').accounts.alice.acquisitionWatermark, id);
    assert.equal(pendingCount(h), 0);
    assert.equal(Object.keys((await h.rpc('snapshot')).diagnostics.backfills).length, 0);
    assertPrivateFiles(h);
    return { name, point, signal: 'SIGKILL', ...result,
      allowedDuplicateParts: [...allowedDuplicates.keys()],
      pendingAfterRecovery: 0, orphanCatchupsAfterRecovery: 0 };
  } finally { await h.close(); }
}

async function main() {
  report.scenarios.push(await sustainedLoad());
  for (const point of ['capture-before-rename', 'capture-after-rename', 'capture-before-catchup-cleanup', 'part-after-rename', 'unconfirmed-provider-success']) {
    const result = await crashCase('crash-' + point, point);
    report.scenarios.push(result); note({ phase: 'crash', point, accepted: result.acceptedParts, duplicates: result.duplicateParts });
  }
  report.ok = true;
}
main().catch((error) => { report.ok = false; report.error = { message: error.message, stack: error.stack }; process.exitCode = 1; })
  .finally(() => {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    note({ ok: report.ok, report: output, scenarios: report.scenarios.length, ...(report.error ? { error: report.error.message } : {}) });
  });
