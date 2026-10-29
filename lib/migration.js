'use strict';

// Offline transforms only. Callers must stop the sole sender before taking the
// final snapshot, verify the evidence files, and install the returned candidate.
// No configuration, authentication material, filesystem or network is accessed.
const crypto = require('node:crypto');
const { createOutbox, MAX_BYTES } = require('./outbox');
const MAX_SENT = 200;
const ID = /^(?:0|[1-9]\d{0,31})$/;
const USER = /^[a-z0-9_]{1,15}$/;
const HASH = /^[a-f0-9]{64}$/;
const RECORD_KEYS = new Set(['sent', 'watermark', 'pending', 'destination', 'gap', 'acquisitionWatermark']);
const TWEET_KEYS = ['id', 'text', 'time', 'url', 'name', 'is_rt', 'author_username', 'relations', 'lang'];

function fail(code) { throw Object.assign(new Error(code), { code }); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  fail('MIGRATION_INVALID_JSON');
}
function stateDigest(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}
function id(value) { return typeof value === 'string' && ID.test(value); }
function compare(a, b) { return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0; }
function maximum(values) { return values.reduce((a, b) => compare(a, b) >= 0 ? a : b); }
function sameKeys(value, expected) {
  return object(value) && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}
function accountNames(accounts) {
  if (!Array.isArray(accounts) || !accounts.length || accounts.length > 100) fail('MIGRATION_ACCOUNTS');
  const names = accounts.map((name) => typeof name === 'string' ? name.toLowerCase() : '');
  if (names.some((name) => !USER.test(name)) || new Set(names).size !== names.length) fail('MIGRATION_ACCOUNTS');
  return names;
}
function binding(value) { if (typeof value !== 'string' || !HASH.test(value)) fail('MIGRATION_DESTINATION'); }
function validateState(doc, names, destinationBinding, legacy = false) {
  if (!sameKeys(doc, ['version', 'accounts']) || !sameKeys(doc.accounts, names)) fail('MIGRATION_ACCOUNTS');
  for (const record of Object.values(doc.accounts)) {
    if (!object(record) || Object.keys(record).some((key) => !RECORD_KEYS.has(key))
        || !Array.isArray(record.sent) || !id(record.watermark)
        || !Array.isArray(record.pending) || record.sent.some((value) => !id(value))
        || record.pending.some((tweet) => !object(tweet) || !id(tweet.id)
          || Object.keys(tweet).some((key) => !TWEET_KEYS.includes(key)))
        || (record.acquisitionWatermark !== undefined && !id(record.acquisitionWatermark))) fail('MIGRATION_STATE');
    if (record.gap !== null) fail('MIGRATION_GAP');
    if (record.destination !== null && record.destination !== destinationBinding) fail('MIGRATION_DESTINATION');
    if (legacy && record.pending.some((tweet) => typeof tweet.text !== 'string' || tweet.text.length > 12000)) {
      fail('MIGRATION_LEGACY_TEXT_LIMIT');
    }
  }
  // Exercise the actual runtime validator without allowing state writes.
  const store = { readState(name) {
    return { status: 'ok', value: name === 'delivery_state.json' ? doc : { version: 1 } };
  }, writeJSON() { fail('MIGRATION_UNEXPECTED_WRITE'); } };
  try { createOutbox(store, MAX_SENT).get(names[0]); }
  catch (_) { fail('MIGRATION_STATE'); }
}
function normalizedTweets(tweets, destinationBinding) {
  if (!Array.isArray(tweets) || !tweets.length || tweets.length > 500) fail('MIGRATION_COVERAGE');
  const normalized = tweets.map((tweet) => {
    if (!object(tweet) || !id(tweet.id) || tweet.id === '0'
        || (tweet.is_pinned !== undefined && typeof tweet.is_pinned !== 'boolean')) fail('MIGRATION_COVERAGE');
    return Object.fromEntries(TWEET_KEYS.filter((key) => Object.hasOwn(tweet, key)).map((key) => [key, structuredClone(tweet[key])]));
  });
  if (new Set(normalized.map((tweet) => tweet.id)).size !== normalized.length) fail('MIGRATION_DUPLICATE_TWEET');
  const probe = { version: 1, accounts: { probe: { sent: ['0'], watermark: maximum(normalized.map((tweet) => tweet.id)),
    pending: [...normalized].sort((a, b) => compare(a.id, b.id)), destination: destinationBinding, gap: null } } };
  validateState(probe, ['probe'], destinationBinding);
  return normalized;
}

/**
 * coverageReport = {version:1, sourceStateHash, destinationBinding, accounts:{
 *   lowercaseUsername:{sinceId, ok:true, coverage:fetchResult.coverage,
 *     tweets:fetchResult.tweets, evidenceHashes:fetchResult.evidence.map(e=>e.sha256)}
 * }}. The caller must verify these hashes against durable evidence produced by
 * the current collector. A report is a local attestation, not a signature.
 */
function migrateState({ sourceState, accounts, destinationBinding, coverageReport }) {
  const names = accountNames(accounts);
  binding(destinationBinding);
  validateState(sourceState, names, destinationBinding, true);
  if (Object.values(sourceState.accounts).some((record) => record.pending.length)) fail('MIGRATION_PENDING_SOURCE');
  if (!object(coverageReport) || coverageReport.version !== 1
      || coverageReport.sourceStateHash !== stateDigest(sourceState)
      || coverageReport.destinationBinding !== destinationBinding
      || !sameKeys(coverageReport.accounts, names)) fail('MIGRATION_REPORT_BINDING');
  const state = structuredClone(sourceState);
  const manifestAccounts = Object.create(null);
  for (const name of names) {
    const source = sourceState.accounts[name];
    const proof = coverageReport.accounts[name];
    const coverage = proof?.coverage;
    if (!object(proof) || proof.ok !== true || proof.sinceId !== source.watermark
        || !object(coverage) || coverage.complete !== true
        || (coverage.reachedSince !== true && coverage.exhausted !== true)
        || !id(coverage.newestId) || !id(coverage.oldestId)
        || compare(coverage.oldestId, coverage.newestId) > 0
        || (coverage.reachedSince === true && compare(coverage.oldestId, proof.sinceId) > 0)
        || !Number.isSafeInteger(coverage.pages) || coverage.pages < 1 || coverage.pages > 5
        || !Array.isArray(proof.evidenceHashes) || proof.evidenceHashes.length !== coverage.pages + 1
        || proof.evidenceHashes.some((hash) => typeof hash !== 'string' || !HASH.test(hash))) fail('MIGRATION_COVERAGE');
    if (compare(coverage.newestId, source.watermark) < 0
        || (source.acquisitionWatermark !== undefined && compare(coverage.newestId, source.acquisitionWatermark) < 0)) {
      fail('MIGRATION_CHECKPOINT_AMBIGUOUS');
    }
    const tweets = normalizedTweets(proof.tweets, destinationBinding);
    const newest = proof.tweets.find((tweet) => tweet.id === coverage.newestId);
    if (!newest || newest.is_pinned === true || typeof newest.author_username !== 'string'
        || newest.author_username.toLowerCase() !== name) fail('MIGRATION_COVERAGE');
    if (!tweets.some((tweet) => tweet.id === coverage.oldestId)) fail('MIGRATION_COVERAGE');
    const known = new Set(source.sent);
    const pending = tweets.filter((tweet) => {
      if (typeof tweet.author_username !== 'string') fail('MIGRATION_COVERAGE');
      return tweet.author_username.toLowerCase() === name && !known.has(tweet.id)
        && compare(tweet.id, source.watermark) > 0;
    }).sort((a, b) => compare(a.id, b.id));
    state.accounts[name] = { ...source, pending, destination: pending.length ? destinationBinding : null,
      watermark: maximum([source.watermark, ...pending.map((tweet) => tweet.id)]),
      acquisitionWatermark: coverage.newestId };
    manifestAccounts[name] = { sourceWatermark: source.watermark, acquisitionWatermark: coverage.newestId,
      originalSentCount: source.sent.length, pendingIds: pending.map((tweet) => tweet.id),
      evidenceHashes: proof.evidenceHashes.slice() };
  }
  validateState(state, names, destinationBinding);
  return { state, manifest: { version: 1, kind: 'v1-to-v2', sourceStateHash: stateDigest(sourceState),
    migratedStateHash: stateDigest(state), coverageReportHash: stateDigest(coverageReport),
    destinationBinding, accounts: manifestAccounts } };
}

function rollbackState({ originalState, migratedState, currentState, manifest, accounts, destinationBinding }) {
  const names = accountNames(accounts);
  binding(destinationBinding);
  validateState(originalState, names, destinationBinding, true);
  validateState(migratedState, names, destinationBinding);
  validateState(currentState, names, destinationBinding);
  if (!object(manifest) || manifest.version !== 1 || manifest.kind !== 'v1-to-v2'
      || manifest.sourceStateHash !== stateDigest(originalState)
      || manifest.migratedStateHash !== stateDigest(migratedState)
      || manifest.destinationBinding !== destinationBinding || !sameKeys(manifest.accounts, names)) fail('MIGRATION_MANIFEST');
  const state = { version: 1, accounts: Object.create(null) };
  const resultAccounts = Object.create(null);
  for (const name of names) {
    const original = originalState.accounts[name];
    const initial = migratedState.accounts[name];
    const current = currentState.accounts[name];
    if (!id(current.acquisitionWatermark) || !id(initial.acquisitionWatermark)
        || compare(current.acquisitionWatermark, initial.acquisitionWatermark) < 0
        || compare(current.watermark, initial.watermark) < 0
        || compare(current.watermark, current.acquisitionWatermark) > 0) fail('MIGRATION_CHECKPOINT_AMBIGUOUS');
    const pendingById = new Map(current.pending.map((tweet) => [tweet.id, tweet]));
    const delivered = new Set([...original.sent, ...current.sent]);
    // Every message handed over at migration must still have an explicit fate.
    for (const tweet of [...original.pending, ...initial.pending]) {
      const remaining = pendingById.get(tweet.id);
      if (!remaining && !delivered.has(tweet.id)) fail('MIGRATION_UNACCOUNTED_MESSAGE');
      if (remaining && stateDigest(remaining) !== stateDigest(tweet)) fail('MIGRATION_PENDING_CONFLICT');
    }
    if (current.pending.some((tweet) => delivered.has(tweet.id))) fail('MIGRATION_PENDING_CONFLICT');
    const allSent = [...delivered].sort(compare);
    const newSent = allSent.filter((value) => compare(value, original.watermark) > 0);
    const oldSent = allSent.filter((value) => compare(value, original.watermark) <= 0);
    if (newSent.length > MAX_SENT) fail('MIGRATION_ACK_RETENTION');
    const room = MAX_SENT - newSent.length;
    const sent = [...(room ? oldSent.slice(-room) : []), ...newSent];
    // Only old confirmed IDs below the original checkpoint may leave the bounded
    // dedup cache. V1's watermark excludes them on every later collection.
    const pending = structuredClone(current.pending);
    state.accounts[name] = { sent, watermark: maximum([current.watermark, current.acquisitionWatermark]),
      pending, destination: pending.length ? destinationBinding : null, gap: null };
    resultAccounts[name] = { sentCount: sent.length, pendingCount: pending.length,
      newConfirmedCount: newSent.length, trimmedOldConfirmedCount: allSent.length - sent.length,
      watermark: state.accounts[name].watermark };
  }
  validateState(state, names, destinationBinding, true);
  return { state, manifest: { version: 1, kind: 'v2-to-v1', destinationBinding,
    originalStateHash: stateDigest(originalState), migratedStateHash: stateDigest(migratedState),
    currentStateHash: stateDigest(currentState), rollbackStateHash: stateDigest(state), accounts: resultAccounts } };
}

module.exports = { migrateState, rollbackState, stateDigest, MAX_INPUT_BYTES: MAX_BYTES * 5 };
