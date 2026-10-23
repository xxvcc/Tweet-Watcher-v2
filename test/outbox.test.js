'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutbox, MAX_PENDING_ACCOUNT, MAX_PENDING_TOTAL, MAX_BYTES } = require('../lib/outbox');
const BINDING = 'a'.repeat(64);

function harness(initial) {
  const files = new Map(initial || []);
  const writes = [];
  const store = {
    readState(name) {
      return files.has(name) ? { status: 'ok', value: structuredClone(files.get(name)) } : { status: 'missing' };
    },
    writeJSON(name, value) {
      const snapshot = structuredClone(value);
      files.set(name, snapshot);
      writes.push(snapshot);
    },
  };
  return { files, writes, box: createOutbox(store, 200), store };
}
function tweets(start, count, text = '') {
  return Array.from({ length: count }, (_, i) => ({ id: String(start + i), text }));
}

test('a baseline larger than the dedup history retains the newest acquisition checkpoint', () => {
  const { box, files } = harness();
  box.flush();
  box.baseline('alice', tweets(1, 500).reverse().map((tweet) => tweet.id));
  assert.equal(box.get('alice').sent.length, 200);
  assert.equal(box.get('alice').watermark, '500');
  const restarted = createOutbox({
    readState(name) { return { status: 'ok', value: structuredClone(files.get(name)) }; },
    writeJSON() { throw new Error('must not write when loading'); },
  }, 200);
  restarted.flush();
  assert.equal(restarted.get('alice').watermark, '500');
});

test('per-account capacity preserves the previous queue and permits drainage and later admission', () => {
  const { box, writes, files } = harness();
  box.flush();
  box.baseline('alice', ['1']);
  box.capture('alice', tweets(2, MAX_PENDING_ACCOUNT), BINDING, null);
  const committed = structuredClone(files.get('delivery_state.json'));
  const count = writes.length;
  assert.throws(() => box.capture('alice', tweets(MAX_PENDING_ACCOUNT + 2, 1), BINDING, null), { code: 'OUTBOX_FULL' });
  assert.equal(writes.length, count);
  assert.deepEqual(files.get('delivery_state.json'), committed);
  assert.equal(box.ready(), true);
  box.acknowledge('alice', '2', []);
  box.capture('alice', tweets(MAX_PENDING_ACCOUNT + 2, 1), BINDING, null);
  assert.equal(box.get('alice').pending.length, MAX_PENDING_ACCOUNT);
  assert.equal(box.get('alice').watermark, String(MAX_PENDING_ACCOUNT + 2));
});

test('the global pending count is bounded across accounts without dropping an earlier queue', () => {
  const { box, files } = harness();
  box.flush();
  for (let i = 0; i < MAX_PENDING_TOTAL / MAX_PENDING_ACCOUNT; i++) {
    box.baseline(`user${i}`, ['1']);
    box.capture(`user${i}`, tweets(2, MAX_PENDING_ACCOUNT), BINDING, null);
  }
  box.baseline('extra', ['1']);
  const committed = structuredClone(files.get('delivery_state.json'));
  assert.throws(() => box.capture('extra', tweets(2, 1), BINDING, null), { code: 'OUTBOX_FULL' });
  assert.deepEqual(files.get('delivery_state.json'), committed);
  assert.equal(box.get('extra').watermark, '1');
});

test('UTF-8 JSON size is bounded independently of message count before any disk replacement', () => {
  const { box, files, writes } = harness();
  box.flush();
  box.baseline('alice', ['1']);
  box.capture('alice', tweets(2, 1, 'retained'), BINDING, null);
  const committed = structuredClone(files.get('delivery_state.json'));
  const count = writes.length;
  assert.throws(() => box.capture('alice', tweets(3, 200, '中'.repeat(12000)), BINDING, null), { code: 'OUTBOX_FULL' });
  assert.equal(writes.length, count);
  assert.deepEqual(files.get('delivery_state.json'), committed);
  assert.ok(Buffer.byteLength(JSON.stringify(committed, null, 2)) < MAX_BYTES);
});

test('invalid stored queues fail closed without overwriting the file', () => {
  for (const mutate of [
    (value) => { value.accounts.alice.pending[0].id = 'invalid'; },
    (value) => { value.accounts.alice.destination = null; },
    (value) => { value.accounts.alice.sent.push('2'); },
    (value) => { value.accounts.alice.watermark = '1'; },
    (value) => { value.accounts.alice.pending[0].text = {}; },
    (value) => { value.accounts.alice.pending[0].id = 2; },
    (value) => { value.accounts.alice.pending[0].id = 9007199254740992; value.accounts.alice.watermark = '9007199254740992'; },
    (value) => { value.accounts.alice.pending[0].is_rt = 'false'; },
    (value) => { delete value.accounts.alice.pending[0].time; },
    (value) => { value.accounts.alice.gap = { after: 1, before: '2' }; },
    (value) => { value.accounts.Alice = structuredClone(value.accounts.alice); },
  ]) {
    const first = harness();
    first.box.flush();
    first.box.baseline('alice', ['1']);
    first.box.capture('alice', tweets(2, 1), BINDING, null);
    const corrupt = structuredClone(first.files.get('delivery_state.json'));
    mutate(corrupt);
    const restarted = harness([['delivery_state.json', corrupt]]);
    assert.throws(() => restarted.box.flush(), { code: 'DATA_CORRUPT' });
    assert.equal(restarted.writes.length, 0);
    assert.deepEqual(restarted.files.get('delivery_state.json'), corrupt);
  }
});

test('a failed ack survives a crash as pending and cannot erase a different in-flight ack', () => {
  const { box, store, files } = harness();
  box.flush();
  box.baseline('alice', ['1']);
  box.baseline('bob', ['1']);
  box.capture('alice', tweets(2, 1), BINDING, null);
  box.capture('bob', tweets(2, 1), BINDING, null);
  const write = store.writeJSON;
  store.writeJSON = () => { throw new Error('synthetic I/O failure'); };
  assert.throws(() => box.acknowledge('alice', '2', []), { code: 'OUTBOX_WRITE' });
  assert.equal(box.ready(), false);
  assert.throws(() => box.acknowledge('bob', '2', []), /未落盘事务/);
  const restarted = createOutbox(store, 200);
  restarted.flush();
  assert.equal(restarted.get('alice').pending[0].id, '2');
  assert.equal(restarted.get('bob').pending[0].id, '2');
  store.writeJSON = write;
  box.flush();
  assert.equal(files.get('delivery_state.json').accounts.alice.pending.length, 0);
  assert.equal(files.get('delivery_state.json').accounts.bob.pending.length, 1);
});

test('a durable initialization marker prevents silent reinitialization after queue loss and restart', () => {
  const { box, store, files, writes } = harness();
  box.baseline('alice', ['1']);
  box.capture('alice', tweets(2, 1), BINDING, null);
  assert.deepEqual(files.get('delivery_state.initialized.json'), { version: 1 });
  files.delete('delivery_state.json');
  const count = writes.length;
  const restarted = createOutbox(store, 200);
  assert.throws(() => restarted.flush(), { code: 'DATA_CORRUPT' });
  assert.equal(writes.length, count);
  assert.equal(files.has('delivery_state.json'), false);
});

test('state is written before its marker and interrupted marker creation is recoverable before sends', () => {
  const { box, store, files } = harness();
  box.flush();
  const write = store.writeJSON;
  store.writeJSON = (name, value) => {
    if (name === 'delivery_state.initialized.json') throw new Error('synthetic marker failure');
    write(name, value);
  };
  assert.throws(() => box.baseline('alice', ['1'], '1'), { code: 'OUTBOX_WRITE' });
  assert.equal(files.get('delivery_state.json').accounts.alice.acquisitionWatermark, '1');
  assert.equal(files.has('delivery_state.initialized.json'), false);
  assert.equal(box.ready(), false);
  assert.throws(() => box.capture('alice', tweets(2, 1), BINDING, null, '2'), /未落盘事务/);
  const restarted = createOutbox(store, 200);
  assert.throws(() => restarted.flush(), { code: 'OUTBOX_WRITE' });
  assert.equal(restarted.ready(), false);
  store.writeJSON = write;
  restarted.flush();
  assert.equal(restarted.ready(), true);
  assert.equal(restarted.get('alice').acquisitionWatermark, '1');
  assert.deepEqual(files.get('delivery_state.initialized.json'), { version: 1 });
  restarted.capture('alice', tweets(2, 1, 'captured after marker repair'), BINDING, null, '2');
  assert.equal(restarted.get('alice').pending[0].text, 'captured after marker repair');
});

test('pre-v2 dedup state is refused without importing, overwriting or treating it as a fresh instance', () => {
  for (const value of [{ Alice: ['9000'], alice: ['2'] }, {}, null, ['invalid']]) {
    const { box, files, writes } = harness([['sent_ids.json', value]]);
    assert.throws(() => box.flush(), (error) => error.code === 'DATA_CORRUPT' && /显式迁移/.test(error.message));
    assert.equal(writes.length, 0);
    assert.equal(files.has('delivery_state.json'), false);
    assert.equal(files.has('delivery_state.initialized.json'), false);
    assert.deepEqual(files.get('sent_ids.json'), value);
  }
  const box = createOutbox({
    readState(name) { return { status: name === 'sent_ids.json' ? 'corrupt' : 'missing' }; },
    writeJSON() { assert.fail('must not write on rejected state'); },
  }, 200);
  assert.throws(() => box.flush(), { code: 'DATA_CORRUPT' });
});

test('existing native schema one remains readable without an acquisition checkpoint', () => {
  const state = { version: 1, accounts: {
    alice: { sent: ['1'], watermark: '1', pending: [], destination: null, gap: null },
  } };
  const { box, store } = harness([['delivery_state.json', state]]);
  box.flush();
  assert.equal(box.get('ALICE').watermark, '1');
  box.capture('Alice', tweets(2, 1), BINDING, null, '2');
  const restarted = createOutbox(store, 200);
  restarted.flush();
  assert.equal(restarted.get('alice').acquisitionWatermark, '2');
  assert.equal(restarted.get('ALICE').pending[0].id, '2');
});

test('complete long-form text and relationship IDs survive durable storage and restart', () => {
  const { box, store, files } = harness();
  box.baseline('alice', ['1']);
  const text = '中文😀'.repeat(15000);
  const relations = { replyToId: '9007199254740993', quoteId: '3', repostId: null,
    editIds: Array.from({ length: 100 }, (_, i) => String(i + 2)) };
  box.capture('alice', [{ id: '101', text, relations }], BINDING, null);
  const restarted = createOutbox(store, 200);
  restarted.flush();
  const post = restarted.get('alice').pending[0];
  assert.equal(post.text, text);
  assert.deepEqual(post.relations, relations);
  const message = require('../lib/telegram').formatTweet(post, 'alice');
  assert.ok(message.length <= 4096);
  assert.match(message, /内容已截断/);
  const before = structuredClone(files.get('delivery_state.json'));
  assert.throws(() => restarted.capture('alice', tweets(102, 100, text), BINDING, null), { code: 'OUTBOX_FULL' });
  assert.deepEqual(files.get('delivery_state.json'), before);
  assert.equal(restarted.get('alice').watermark, '101');
});

test('malformed persisted relation IDs fail closed on restart', () => {
  for (const relations of [
    { replyToId: 9007199254740993, quoteId: null, repostId: null, editIds: [] },
    { replyToId: null, quoteId: 'invalid', repostId: null, editIds: [] },
    { replyToId: null, quoteId: null, repostId: null, editIds: ['2', '2'] },
    { replyToId: null, quoteId: null, repostId: null, editIds: [2] },
  ]) {
    const { box, store, files, writes } = harness();
    box.baseline('alice', ['1']);
    box.capture('alice', [{ id: '2' }], BINDING, null);
    files.get('delivery_state.json').accounts.alice.pending[0].relations = relations;
    const count = writes.length;
    assert.throws(() => createOutbox(store, 200).flush(), { code: 'DATA_CORRUPT' });
    assert.equal(writes.length, count);
  }
});

test('context observations retain their identity without raising the acquisition checkpoint', () => {
  const { box, store } = harness();
  box.baseline('alice', ['500', '300', '100'], '300');
  assert.equal(box.get('alice').watermark, '500');
  assert.equal(box.get('alice').acquisitionWatermark, '300');
  const restarted = createOutbox(store, 200);
  restarted.flush();
  assert.equal(restarted.get('alice').acquisitionWatermark, '300');
  restarted.capture('alice', [{ id: '350', text: 'later ordinary post' }], BINDING, null, '350');
  assert.equal(restarted.get('alice').watermark, '500');
  assert.equal(restarted.get('alice').acquisitionWatermark, '350');
  assert.deepEqual(restarted.get('alice').pending.map((tweet) => tweet.id), ['350']);
});

test('new ordinary posts merge below pending context IDs and checkpoint-only progress persists', () => {
  const { box, store } = harness();
  box.baseline('alice', ['300'], '300');
  box.capture('alice', [{ id: '500', text: 'context observed early' }], BINDING, null, '300');
  box.capture('alice', [{ id: '350', text: 'later ordinary post' }], BINDING, null, '350');
  assert.deepEqual(box.get('alice').pending.map((tweet) => tweet.id), ['350', '500']);
  box.capture('alice', [], BINDING, null, '500');
  assert.equal(box.get('alice').acquisitionWatermark, '500');
  const restarted = createOutbox(store, 200);
  restarted.flush();
  assert.equal(restarted.get('alice').acquisitionWatermark, '500');
  assert.deepEqual(restarted.get('alice').pending.map((tweet) => tweet.id), ['350', '500']);
});

test('failed contextual capture leaves checkpoint and queue atomic across restart and recovery', () => {
  const { box, store, files } = harness();
  box.baseline('alice', ['500', '300'], '300');
  const before = structuredClone(files.get('delivery_state.json'));
  const write = store.writeJSON;
  store.writeJSON = () => { throw new Error('synthetic checkpoint write failure'); };
  assert.throws(() => box.capture('alice', [{ id: '350' }], BINDING, null, '350'), { code: 'OUTBOX_WRITE' });
  assert.deepEqual(files.get('delivery_state.json'), before);
  const restarted = createOutbox(store, 200);
  restarted.flush();
  assert.equal(restarted.get('alice').acquisitionWatermark, '300');
  assert.deepEqual(restarted.get('alice').pending, []);
  assert.equal(box.ready(), false);
  store.writeJSON = write;
  box.flush();
  assert.equal(files.get('delivery_state.json').accounts.alice.acquisitionWatermark, '350');
  assert.equal(files.get('delivery_state.json').accounts.alice.pending[0].id, '350');
});

test('corrupt acquisition checkpoints fail closed instead of dropping the fallback watermark', () => {
  for (const invalid of ['bad', 300, null]) {
    const { box, store, files, writes } = harness();
    box.baseline('alice', ['500', '300'], '300');
    files.get('delivery_state.json').accounts.alice.acquisitionWatermark = invalid;
    const count = writes.length;
    assert.throws(() => createOutbox(store, 200).flush(), { code: 'DATA_CORRUPT' });
    assert.equal(writes.length, count);
  }
});
