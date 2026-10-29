'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveDataDirectory, validateDataDirectory } = require('./data-directory');
const { sourceKey } = require('./collector-source');
const MAX_BYTES = 6 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_TASKS = 32;
const MAX_PAGES = 100;
const MAX_POSTS = 1000;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const NAME = /^catchup-[a-f0-9]{64}\.json$/;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fileName = (key) => `catchup-${hash(key)}.json`;
function failure(code = 'CATCHUP_CORRUPT') { return Object.assign(new Error('补采状态不可用，原水位未改变'), { code }); }
const validId = (value) => typeof value === 'string' && /^[1-9]\d{0,31}$/.test(value);
const validCheckpoint = (value) => typeof value === 'string' && /^\d{1,32}$/.test(value);
function integrity(value) { const { integrity: _digest, ...data } = value; return hash(JSON.stringify(data)); }

function validate(value, key, checkIntegrity = true) {
  if (!value || value.schema !== 1 || value.sourceKey !== key || sourceKey(value.source) !== key
      || typeof value.binding !== 'string' || !/^[a-f0-9]{64}$/.test(value.binding)
      || !validCheckpoint(value.sinceId) || !validCheckpoint(value.windowStartId)
      || (value.upperId !== null && !validId(value.upperId))
      || (value.sessionId !== null && (typeof value.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.sessionId)))
      || (value.cursor !== null && value.cursor !== undefined && (typeof value.cursor !== 'string'
        || !value.cursor || value.cursor.length > 4096 || !value.cursor.isWellFormed() || /[\x00-\x1f\x7f]/.test(value.cursor)))
      || !Number.isSafeInteger(value.items) || value.items < 0 || value.items > MAX_POSTS
      || !Array.isArray(value.pages) || !value.pages.length || value.pages.length > MAX_PAGES
      || !Number.isSafeInteger(value.startedAt) || !Number.isSafeInteger(value.updatedAt)
      || value.startedAt < 0 || value.updatedAt < value.startedAt || value.updatedAt > Date.now() + 60000
      || (checkIntegrity && value.integrity !== integrity(value))
      || typeof value.completed !== 'boolean' || Buffer.byteLength(JSON.stringify(value, null, 2)) > MAX_BYTES) throw failure();
  if (value.source.source_type === 'user' && (!validId(value.user?.id)
      || typeof value.user?.username !== 'string' || value.user.username.toLowerCase() !== value.source.username.toLowerCase())) throw failure();
  const operation = value.source.source_type === 'user' ? value.source.timeline_mode === 'replies' ? 'replies' : 'timeline' : value.source.source_type;
  for (const page of value.pages) {
    if (!page || !page.data || page.operation !== operation || typeof page.sha256 !== 'string'
        || hash(JSON.stringify(page.data)) !== page.sha256) throw failure();
  }
  return value;
}

function evidencePage(data, operation, evidence, secrets = []) {
  let raw = JSON.stringify(data);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret) raw = raw.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]');
  }
  return { data: JSON.parse(raw), operation, sha256: hash(raw), evidence };
}

// Full page evidence is embedded in each bounded, private atomic checkpoint.
// Ordinary evidence retention cannot evict an unfinished catchup's source pages.
function createCatchupStore({ storage = require('./store'), directory = resolveDataDirectory() } = {}) {
  function entries() {
    if (!validateDataDirectory(directory, { allowMissing: true })) return [];
    return fs.readdirSync(directory).filter((name) => NAME.test(name)).map((name) => {
      const stat = fs.lstatSync(path.join(directory, name));
      if (!stat.isFile() || (stat.mode & 0o077)) throw failure();
      return { name, size: stat.size };
    });
  }
  function load(key) {
    if (validateDataDirectory(directory, { allowMissing: true })) {
      try {
        const stat = fs.lstatSync(path.join(directory, fileName(key)));
        if (!stat.isFile() || (stat.mode & 0o077)) throw failure();
      } catch (error) { if (error.code !== 'ENOENT') throw failure(); }
    }
    const state = storage.readState(fileName(key));
    if (state.status === 'missing') return null;
    if (state.status !== 'ok') throw failure();
    try { return validate(state.value, key); } catch { throw failure(); }
  }
  function save(value) {
    value = { ...value, integrity: integrity(value) };
    const name = fileName(value.sourceKey);
    const bytes = Buffer.byteLength(JSON.stringify(value, null, 2));
    if (bytes > MAX_BYTES || value.pages.length > MAX_PAGES) throw failure('CATCHUP_CAPACITY');
    validate(value, value.sourceKey);
    const others = entries().filter((entry) => entry.name !== name);
    if (others.length >= MAX_TASKS || others.reduce((n, entry) => n + entry.size, 0) + bytes > MAX_TOTAL_BYTES) throw failure('CATCHUP_CAPACITY');
    try { storage.writeJSON(name, value); }
    catch { throw failure('CATCHUP_WRITE'); }
  }
  function remove(key) { storage.removeJSON(fileName(key)); }
  function list() {
    const result = {};
    for (const entry of entries()) {
      const state = storage.readState(entry.name);
      if (state.status !== 'ok' || !state.value?.sourceKey || fileName(state.value.sourceKey) !== entry.name) throw failure();
      const value = validate(state.value, state.value.sourceKey);
      result[value.sourceKey] = summary(value);
    }
    return result;
  }
  return { load, save, remove, list };
}
function summary(value) {
  return { sourceKey: value.sourceKey, sessionId: value.sessionId ?? null, active: true,
    status: value.completed ? 'ready' : 'collecting', pages: value.pages.length,
    items: value.items ?? 0, startedAt: value.startedAt, updatedAt: value.updatedAt };
}
module.exports = { createCatchupStore, evidencePage, summary, MAX_PAGES, MAX_POSTS, MAX_AGE, MAX_BYTES };
