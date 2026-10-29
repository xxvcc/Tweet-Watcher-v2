'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutbox, MAX_DELIVERED, MAX_DISCOVERY_SEEN, DISCOVERY_RETENTION_MS } = require('../lib/outbox');
const A = 'a'.repeat(64), B = 'b'.repeat(64);
const source = 'search:' + 'c'.repeat(24);
const parts = [{ kind: 'text', text: 'original message' }, { kind: 'photo', url: 'https://pbs.twimg.com/media/example.jpg' }];

function fixture() {
  const files = new Map();
  const store = {
    readState: (name) => files.has(name) ? { status: 'ok', value: structuredClone(files.get(name)) } : { status: 'missing' },
    writeJSON: (name, value) => files.set(name, structuredClone(value)),
  };
  const box = createOutbox(store, 200);
  return { box, store, files, reload: () => { const restarted = createOutbox(store, 200); restarted.flush(); return restarted; } };
}
const tweet = (id = '2') => ({ id, text: 'original message', author_username: 'alice' });

test('old native v1 is preserved until a new feature needs v2 and multipart state survives restart', () => {
  const { box, files, reload } = fixture();
  box.baseline('alice', ['1']);
  box.capture('alice', [tweet()], A, null, '2');
  assert.equal(files.get('delivery_state.json').version, 1);
  box.prepareDelivery('alice', '2', parts);
  assert.equal(files.get('delivery_state.json').version, 2);
  box.acknowledgePart('alice', '2', 0);
  const restarted = reload();
  assert.equal(restarted.get('alice').acquisitionWatermark, '2');
  assert.equal(restarted.get('alice').pending[0].text, 'original message');
  assert.deepEqual(restarted.get('alice').pending[0].delivery, { version: 1, parts, next: 1 });
  assert.deepEqual(restarted.prepareDelivery('alice', '2', [{ kind: 'text', text: 'do not replan' }]), { version: 1, parts, next: 1 });
  assert.throws(() => restarted.acknowledge('alice', '2', []), /未确认/);
  restarted.acknowledgePart('alice', '2', 1);
  restarted.acknowledge('alice', '2', []);
  assert.equal(restarted.get('alice').pending.length, 0);
  assert.ok(restarted.get('alice').sent.includes('2'));
});

test('shared plans and progress survive removing one source and final dedup is destination scoped', () => {
  const { box, reload } = fixture();
  for (const key of ['alice', 'list:123', source, 'replies:alice']) box.baseline(key, ['1']);
  box.capture('alice', [tweet()], A, null, '2');
  box.capture('list:123', [tweet()], A, null, '2');
  box.capture('replies:alice', [tweet()], B, null, '2');
  box.prepareDelivery('alice', '2', parts);
  box.acknowledgePart('alice', '2', 0);
  box.capture(source, [tweet()], A, null, '2');
  assert.equal(box.get(source).pending[0].delivery.next, 1);
  assert.equal(box.get('replies:alice').pending[0].delivery, undefined);
  box.prune(new Set(['list:123', source, 'replies:alice']));
  const restarted = reload();
  restarted.acknowledgePart('list:123', '2', 1);
  restarted.acknowledge('list:123', '2', []);
  assert.equal(restarted.get(source).pending.length, 0);
  assert.equal(restarted.get(source).sent.includes('2'), false);
  assert.equal(restarted.get(source).dispositions[0].status, 'duplicate');
  assert.equal(restarted.get('replies:alice').pending.length, 1);
  restarted.baseline('bob', ['1']);
  restarted.capture('bob', [tweet()], A, null, '2');
  assert.equal(restarted.get('bob').pending.length, 0);
  assert.equal(restarted.get('bob').dispositions[0].status, 'duplicate');
});

test('baselines never claim delivery and reposts keep their own distinct outer identities', () => {
  const { box } = fixture();
  box.baseline('alice', ['1', '2']);
  box.baseline(source, ['1']);
  box.capture(source, [tweet()], A, null, '2');
  assert.equal(box.get(source).pending.length, 1);
  box.acknowledge(source, '2', []);
  box.capture('alice', [{ ...tweet('3'), is_rt: true, relations: { replyToId: null, quoteId: null, repostId: '2', editIds: [] } }], A, null, '3');
  assert.equal(box.get('alice').pending[0].id, '3');
});

test('filter disposition and checkpoint commit together without marking the filtered post sent', () => {
  const { box, store, files, reload } = fixture();
  box.baseline(source, ['1']);
  const before = structuredClone(files.get('delivery_state.json'));
  const write = store.writeJSON;
  store.writeJSON = () => { throw new Error('synthetic fsync failure'); };
  assert.throws(() => box.capture(source, [], A, null, '3', { filtered: [{ id: '3', reason: 'keyword exclusion' }], ruleVersion: 'v1' }), { code: 'OUTBOX_WRITE' });
  assert.equal(box.ready(), false);
  assert.deepEqual(files.get('delivery_state.json'), before);
  assert.equal(reload().get(source).dispositions, undefined);
  store.writeJSON = write;
  box.flush();
  const state = reload().get(source);
  assert.equal(state.acquisitionWatermark, '3');
  assert.equal(state.watermark, '3');
  assert.deepEqual(state.sent, ['1']);
  assert.equal(state.pending.length, 0);
  assert.equal(state.dispositions[0].ruleVersion, 'v1');
  assert.equal(state.dispositions[0].status, 'filtered');
});

test('failed part acknowledgement freezes mutations and resumes from the durable index after a crash', () => {
  const { box, store, reload } = fixture();
  for (const key of ['alice', source]) {
    box.baseline(key, ['1']);
    box.capture(key, [tweet()], A, null);
  }
  box.prepareDelivery('alice', '2', parts);
  const write = store.writeJSON;
  store.writeJSON = () => { throw new Error('synthetic disk failure'); };
  assert.throws(() => box.acknowledgePart('alice', '2', 0), { code: 'OUTBOX_WRITE' });
  assert.equal(box.ready(), false);
  assert.throws(() => box.prune(new Set([source])), /未落盘事务/);
  assert.equal(reload().get('alice').pending[0].delivery.next, 0, 'remote success cannot erase the unconfirmed duplicate window');
  store.writeJSON = write;
  box.flush();
  const restarted = reload();
  assert.equal(restarted.get('alice').pending[0].delivery.next, 1);
  assert.equal(restarted.get(source).pending[0].delivery.next, 1);
  assert.throws(() => restarted.acknowledgePart(source, '2', 0), /顺序/);
});

test('stored invalid progress and conflicting cross-source bodies fail closed without overwriting evidence', () => {
  const { box, files, reload } = fixture();
  for (const key of ['alice', source]) box.baseline(key, ['1']);
  box.capture('alice', [tweet()], A, null);
  const before = structuredClone(files.get('delivery_state.json'));
  assert.throws(() => box.capture(source, [{ ...tweet(), text: 'changed body' }], A, null), { code: 'TWEET_CONFLICT' });
  assert.deepEqual(files.get('delivery_state.json'), before);
  box.prepareDelivery('alice', '2', parts);
  box.capture(source, [tweet()], A, null);
  const valid = structuredClone(files.get('delivery_state.json'));
  for (const corrupt of [
    (doc) => { doc.accounts.alice.pending[0].delivery.next = 3; },
    (doc) => { doc.accounts.alice.pending[0].delivery.parts[1].url = 'https://127.0.0.1/media/a.jpg'; },
    (doc) => { delete doc.accounts[source].pending[0].delivery; },
  ]) {
    const doc = structuredClone(valid); corrupt(doc);
    files.set('delivery_state.json', doc);
    assert.throws(reload, { code: 'DATA_CORRUPT' });
    assert.deepEqual(files.get('delivery_state.json'), doc);
  }
});

test('optional enrichment persists content without replacing original text, identities or relations', () => {
  const { box, reload } = fixture();
  box.baseline('alice', ['1']);
  const original = { ...tweet(), relations: { replyToId: null, quoteId: '10', repostId: null, editIds: ['2'] } };
  box.capture('alice', [original], A, null, '2');
  box.enrich('alice', '2', { quoted: { id: '10', url: 'https://x.com/i/status/10', text: 'Quoted body' } });
  const saved = reload().get('alice').pending[0];
  assert.equal(saved.text, original.text);
  assert.deepEqual(saved.relations, original.relations);
  assert.equal(saved.content.quoted.text, 'Quoted body');
  assert.throws(() => box.enrich('alice', '2', { quoted: { id: '10', url: 'https://x.com/i/status/10', text: 'Edited quote' } }), { code: 'TWEET_CONFLICT' });
});

test('search discovery floor prevents initial history replay while late indexing below the later checkpoint is accepted once', () => {
  const { box, files, reload } = fixture();
  box.baseline(source, ['1', '5'], '5');
  assert.equal(box.get(source).discoveryFloor, '5');
  box.capture(source, [tweet('3'), tweet('6'), tweet('10')], A, null, '10');
  assert.deepEqual(box.get(source).pending.map((item) => item.id), ['6', '10']);
  box.acknowledge(source, '6', []);
  box.acknowledge(source, '10', []);
  const restarted = reload();
  restarted.capture(source, [tweet('6'), tweet('8')], A, null, '10');
  assert.deepEqual(restarted.get(source).pending.map((item) => item.id), ['8']);
  assert.deepEqual(restarted.get(source).discoverySeen.map((item) => item.id), ['6', '10', '8']);
  const corrupt = structuredClone(files.get('delivery_state.json'));
  corrupt.accounts[source].discoveryFloor = '11';
  files.set('delivery_state.json', corrupt);
  assert.throws(reload, { code: 'DATA_CORRUPT' });
});

test('search dedup keeps its whole overlap window beyond short sent history and fails before evicting active IDs', () => {
  const { box, files, reload } = fixture();
  box.baseline(source, ['1'], '1');
  const now = Date.now();
  const populated = structuredClone(files.get('delivery_state.json'));
  populated.accounts[source].watermark = String(MAX_DISCOVERY_SEEN + 1);
  populated.accounts[source].acquisitionWatermark = String(MAX_DISCOVERY_SEEN + 1);
  populated.accounts[source].discoverySeen = Array.from({ length: MAX_DISCOVERY_SEEN }, (_, index) => ({ id: String(index + 2), at: now }));
  files.set('delivery_state.json', populated);
  const full = reload();
  full.capture(source, [tweet('2')], A, null, String(MAX_DISCOVERY_SEEN + 1));
  assert.equal(full.get(source).pending.length, 0, 'recent ID omitted from short sent list still deduplicates');
  assert.throws(() => full.capture(source, [tweet(String(MAX_DISCOVERY_SEEN + 2))], A, null, String(MAX_DISCOVERY_SEEN + 2)), { code: 'OUTBOX_FULL' });
  assert.deepEqual(files.get('delivery_state.json'), populated);
  assert.equal(full.ready(), true, 'capacity refusal is not a pending disk transaction');
  populated.accounts[source].discoverySeen[0].at = now - DISCOVERY_RETENTION_MS - 1000;
  files.set('delivery_state.json', populated);
  const quiet = reload();
  assert.throws(() => quiet.capture(source, [tweet(String(MAX_DISCOVERY_SEEN + 2))], A, null, String(MAX_DISCOVERY_SEEN + 2)), { code: 'OUTBOX_FULL' },
    'passing wall time cannot evict IDs inside a quiet checkpoint window');
  const advancedId = String((86400000n << 22n) + 2n);
  quiet.capture(source, [tweet(advancedId)], A, null, advancedId);
  assert.equal(quiet.get(source).pending.length, 1);
  assert.equal(quiet.get(source).discoverySeen.length, MAX_DISCOVERY_SEEN);
  assert.equal(quiet.get(source).discoverySeen.some((item) => item.id === '2'), false);
});

test('global ledger reserves capacity before sending and only releases entries outside the overlap window', () => {
  const { box, files, reload } = fixture();
  box.baseline('alice', ['1']);
  box.capture('alice', [tweet()], A, null, '2');
  const full = structuredClone(files.get('delivery_state.json'));
  full.version = 2;
  const now = Date.now();
  full.delivered = Array.from({ length: MAX_DELIVERED }, (_, index) => ({ id: String(index + 100), destination: B, at: now }));
  files.set('delivery_state.json', full);
  assert.throws(() => reload().prepareDelivery('alice', '2', parts), { code: 'OUTBOX_FULL' });
  assert.deepEqual(files.get('delivery_state.json'), full);
  assert.equal(full.accounts.alice.pending[0].delivery, undefined);
  full.delivered[0].at = now - DISCOVERY_RETENTION_MS - 1000;
  files.set('delivery_state.json', full);
  const room = reload();
  room.prepareDelivery('alice', '2', parts);
  room.baseline('bob', ['1']);
  room.capture('bob', [tweet('3')], A, null, '3');
  assert.throws(() => room.prepareDelivery('bob', '3', parts), { code: 'OUTBOX_FULL' }, 'first pending plan reserves the last ledger slot');
  room.acknowledgePart('alice', '2', 0);
  room.acknowledgePart('alice', '2', 1);
  room.acknowledge('alice', '2', []);
  assert.equal(files.get('delivery_state.json').delivered.length, MAX_DELIVERED);
  assert.ok(files.get('delivery_state.json').delivered.some((entry) => entry.id === '2' && entry.destination === A));
});

test('cross-source ledger outlives wall time while a quiet search can still discover that ID', () => {
  const { box, files, reload } = fixture();
  box.baseline('alice', ['1']);
  box.baseline(source, ['1'], '1');
  box.capture('alice', [tweet('5')], A, null, '5');
  box.acknowledge('alice', '5', []);
  const old = structuredClone(files.get('delivery_state.json'));
  old.delivered[0].at = Date.now() - DISCOVERY_RETENTION_MS - 1000;
  files.set('delivery_state.json', old);
  const quiet = reload();
  quiet.capture('alice', [tweet('6')], A, null, '6');
  quiet.prepareDelivery('alice', '6', parts);
  assert.ok(files.get('delivery_state.json').delivered.some((entry) => entry.id === '5'));
  quiet.capture(source, [tweet('5')], A, null, '5');
  assert.equal(quiet.get(source).pending.length, 0);
  assert.equal(quiet.get(source).dispositions[0].status, 'duplicate');
  const advancedId = String((86400000n << 22n) + 5n);
  quiet.capture(source, [], A, null, advancedId);
  quiet.acknowledgePart('alice', '6', 0);
  quiet.acknowledgePart('alice', '6', 1);
  quiet.acknowledge('alice', '6', []);
  assert.equal(files.get('delivery_state.json').delivered.some((entry) => entry.id === '5'), false);
});
