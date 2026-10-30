'use strict';
// One atomic record owns both captured messages and delivery acknowledgements. A failed
// commit stops delivery; its candidate stays in memory for retry without losing the batch.
const FILE = 'delivery_state.json';
const MARKER = 'delivery_state.initialized.json';
const MAX_PENDING_ACCOUNT = 1000;
const MAX_PENDING_TOTAL = 5000;
const MAX_BYTES = 6 * 1024 * 1024; // below store's 8 MiB read limit, including pretty JSON
const ID = /^\d{1,32}$/;
const USER = /^[A-Za-z0-9_]{1,15}$/;
const LANGUAGE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;
const BINDING = /^[a-f0-9]{64}$/;
const TEXT_LIMITS = { text: 100000, time: 256, url: 2048, name: 160 };
const { normalizeTweetContent, mergeTweetContent, normalizeDeliveryParts, deliveryPartsVersion } = require('./tweet-content');
const MAX_DISPOSITIONS = 1000;
const MAX_DELIVERED = 20000;
const MAX_DISCOVERY_SEEN = 10000;
const DISCOVERY_RETENTION_MS = 25 * 3600e3;
const SEARCH_WINDOW_IDS = 86400000n << 22n;
function searchFloor(record, checkpoint = record.acquisitionWatermark ?? record.watermark) {
  const initial = BigInt(record.discoveryFloor ?? record.acquisitionWatermark ?? record.watermark);
  const lower = BigInt(checkpoint) > SEARCH_WINDOW_IDS ? BigInt(checkpoint) - SEARCH_WINDOW_IDS : 0n;
  return initial > lower ? initial : lower;
}
function capacityError(message) {
  return Object.assign(new Error(message || '去重记录已达容量上限；已保留有效重叠窗口内记录且未推进水位'), { code: 'OUTBOX_FULL' });
}
function validSource(key) {
  return typeof key === 'string' && (USER.test(key) || /^replies:[a-z0-9_]{1,15}$/.test(key)
    || /^list:[1-9]\d{0,31}$/.test(key) || /^search:[a-f0-9]{24}$/.test(key));
}
function normalizeDelivery(value) {
  if (!value || ![1, 2].includes(value.version) || !Number.isSafeInteger(value.next) || value.next < 0) throw dataError();
  const parts = normalizeDeliveryParts(value.parts, { version: value.version });
  if (value.next > parts.length) throw dataError();
  return { version: value.version, parts, next: value.next };
}
function disposition(id, status, reason, ruleVersion = '') {
  const version = typeof ruleVersion === 'number' ? String(ruleVersion) : ruleVersion;
  if (typeof id !== 'string' || !ID.test(id) || !['filtered', 'duplicate'].includes(status)
      || typeof reason !== 'string' || !reason || reason.length > 300 || !reason.isWellFormed()
      || typeof version !== 'string' || version.length > 128 || !version.isWellFormed()) throw new TypeError('筛选记录无效');
  return { id, status, reason, ruleVersion: version, at: Date.now() };
}
function addDispositions(record, items) {
  return items.length ? [...(record.dispositions || []), ...items].slice(-MAX_DISPOSITIONS) : record.dispositions;
}

function dataError(detail) {
  const error = new Error(`${FILE} 损坏或缺失，已停止推送并保留原文件`);
  error.code = 'DATA_CORRUPT';
  error.cause = detail;
  return error;
}
function highest(ids) {
  let high = null;
  for (const id of ids) if (high === null || BigInt(id) > BigInt(high)) high = id;
  return high;
}
function normalizeTweet(tweet) {
  if (!tweet || typeof tweet !== 'object' || typeof tweet.id !== 'string' || !ID.test(tweet.id)) {
    throw new Error('待发送推文 ID 无效');
  }
  const value = { id: tweet.id };
  for (const [key, limit] of Object.entries(TEXT_LIMITS)) {
    const text = tweet[key] === undefined ? '' : tweet[key];
    if (typeof text !== 'string' || text.length > limit) throw new Error('待发送推文内容超过限制或无效');
    value[key] = text;
  }
  if (tweet.relations !== undefined) {
    const relations = tweet.relations;
    if (!relations || typeof relations !== 'object' || Array.isArray(relations)) throw new Error('待发送推文关系无效');
    value.relations = {};
    for (const key of ['replyToId', 'quoteId', 'repostId']) {
      const id = relations[key];
      if (id !== null && (typeof id !== 'string' || !ID.test(id))) throw new Error('待发送推文关系 ID 无效');
      value.relations[key] = id;
    }
    if (!Array.isArray(relations.editIds) || relations.editIds.length > 100
        || relations.editIds.some((id) => typeof id !== 'string' || !ID.test(id))
        || new Set(relations.editIds).size !== relations.editIds.length) throw new Error('待发送推文编辑关系无效');
    value.relations.editIds = relations.editIds.slice();
  }
  value.is_rt = tweet.is_rt === true;
  if (tweet.author_username !== undefined) {
    if (typeof tweet.author_username !== 'string' || !USER.test(tweet.author_username)) throw new Error('待发送推文作者无效');
    value.author_username = tweet.author_username;
  }
  if (tweet.lang !== undefined) {
    if (typeof tweet.lang !== 'string' || tweet.lang.length > 35 || !LANGUAGE.test(tweet.lang)) throw new Error('待发送推文语言无效');
    value.lang = tweet.lang.toLowerCase();
  }
  const content = normalizeTweetContent(tweet.content);
  if (content !== undefined) value.content = content;
  if (tweet.delivery !== undefined) value.delivery = normalizeDelivery(tweet.delivery);
  return value;
}
function compatibleTweet(before, after) {
  const conflict = () => { throw Object.assign(new Error('同一目标的相同推文内容存在冲突'), { code: 'TWEET_CONFLICT' }); };
  for (const key of ['text', 'is_rt']) if (before[key] !== after[key]) conflict();
  for (const key of ['time', 'url', 'author_username', 'lang']) {
    if (before[key] && after[key] && before[key] !== after[key]) conflict();
  }
  if (before.relations && after.relations && JSON.stringify(before.relations) !== JSON.stringify(after.relations)) conflict();
  mergeTweetContent(before.content, after.content);
}
function validate(doc, maxSent) {
  if (!doc || ![1, 2].includes(doc.version) || !doc.accounts || typeof doc.accounts !== 'object'
      || Array.isArray(doc.accounts) || Object.keys(doc.accounts).length > 100) throw dataError();
  if (doc.delivered !== undefined) {
    if (!Array.isArray(doc.delivered) || doc.delivered.length > MAX_DELIVERED) throw dataError();
    const seen = new Set();
    for (const item of doc.delivered) {
      if (!item || !BINDING.test(item.destination) || typeof item.destination !== 'string'
          || typeof item.id !== 'string' || !ID.test(item.id) || !Number.isSafeInteger(item.at) || item.at < 0
          || seen.has(`${item.destination}:${item.id}`)) throw dataError();
      seen.add(`${item.destination}:${item.id}`);
    }
  }
  let pendingCount = 0;
  const sharedPlans = new Map();
  const sharedTweets = new Map();
  const deliveredKeys = new Set((doc.delivered || []).map((item) => `${item.destination}:${item.id}`));
  for (const [user, record] of Object.entries(doc.accounts)) {
    if (!validSource(user) || user !== user.toLowerCase() || !record
        || typeof record !== 'object' || Array.isArray(record)) throw dataError();
    if (record.sent !== null && (!Array.isArray(record.sent) || record.sent.length === 0
        || record.sent.length > maxSent || record.sent.some((id) => typeof id !== 'string' || !ID.test(id))
        || new Set(record.sent).size !== record.sent.length)) throw dataError();
    if (record.watermark !== null && (typeof record.watermark !== 'string' || !ID.test(record.watermark))) throw dataError();
    if (record.acquisitionWatermark !== undefined && (typeof record.acquisitionWatermark !== 'string'
        || !ID.test(record.acquisitionWatermark) || record.sent === null)) throw dataError();
    if (record.discoveryFloor !== undefined && (!user.startsWith('search:') || typeof record.discoveryFloor !== 'string'
        || !ID.test(record.discoveryFloor) || BigInt(record.discoveryFloor) > BigInt(record.acquisitionWatermark ?? record.watermark))) throw dataError();
    if (record.discoverySeen !== undefined) {
      if (!user.startsWith('search:') || !Array.isArray(record.discoverySeen) || record.discoverySeen.length > MAX_DISCOVERY_SEEN) throw dataError();
      const seen = new Set();
      for (const item of record.discoverySeen) {
        if (!item || typeof item.id !== 'string' || !ID.test(item.id) || seen.has(item.id)
            || !Number.isSafeInteger(item.at) || item.at < 0
            || BigInt(item.id) > BigInt(record.watermark)) throw dataError();
        seen.add(item.id);
      }
    }
    if ((record.sent === null) !== (record.watermark === null)) throw dataError();
    if (record.sent && record.sent.some((id) => BigInt(id) > BigInt(record.watermark))) throw dataError();
    if (!Array.isArray(record.pending) || record.pending.length > MAX_PENDING_ACCOUNT) throw dataError();
    if (record.destination !== null && (typeof record.destination !== 'string' || !BINDING.test(record.destination))) throw dataError();
    if (record.pending.length && (!record.destination || !record.watermark)) throw dataError();
    if (record.dispositions !== undefined) {
      if (!Array.isArray(record.dispositions) || record.dispositions.length > MAX_DISPOSITIONS) throw dataError();
      for (const item of record.dispositions) {
        disposition(item?.id, item?.status, item?.reason, item?.ruleVersion);
        if (!Number.isSafeInteger(item.at) || item.at < 0) throw dataError();
      }
    }
    if (record.gap !== null && (!record.gap || typeof record.gap.after !== 'string'
        || typeof record.gap.before !== 'string' || !ID.test(record.gap.after) || !ID.test(record.gap.before)
        || BigInt(record.gap.after) > BigInt(record.gap.before))) throw dataError();
    const seen = new Set();
    let previous = null;
    for (const tweet of record.pending) {
      const normalized = normalizeTweet(tweet);
      if (typeof tweet.is_rt !== 'boolean'
          || Object.keys(TEXT_LIMITS).some((key) => typeof tweet[key] !== 'string')
          || (previous !== null && BigInt(tweet.id) <= previous)) throw dataError();
      previous = BigInt(tweet.id);
      if (seen.has(normalized.id) || record.sent.includes(normalized.id)
          || BigInt(normalized.id) > BigInt(record.watermark)) throw dataError();
      seen.add(normalized.id);
      const key = `${record.destination}:${tweet.id}`;
      const plan = normalized.delivery ? JSON.stringify(normalized.delivery) : null;
      if (sharedPlans.has(key) && sharedPlans.get(key) !== plan) throw dataError();
      if (deliveredKeys.has(key)) throw dataError();
      if (sharedTweets.has(key)) compatibleTweet(sharedTweets.get(key), normalized);
      sharedPlans.set(key, plan);
      sharedTweets.set(key, normalized);
    }
    pendingCount += record.pending.length;
  }
  if (pendingCount > MAX_PENDING_TOTAL || Buffer.byteLength(JSON.stringify(doc, null, 2)) > MAX_BYTES) {
    const error = new Error('待发送队列已达容量上限；已保留原队列且未推进抓取水位，请恢复推送或处理积压');
    error.code = 'OUTBOX_FULL';
    throw error;
  }
}

function createOutbox(store, maxSent) {
  let current = null;
  let committed = false;
  let initialized = false;
  let candidate = null;
  function read(name) {
    return store.readState(name);
  }
  function checkMarker() {
    const marker = read(MARKER);
    if (marker.status === 'corrupt' || (initialized && marker.status !== 'ok')) throw dataError(marker.error);
    if (marker.status === 'ok') {
      if (!marker.value || marker.value.version !== 1 || Array.isArray(marker.value)) throw dataError();
      initialized = true;
    }
  }
  function load() {
    if (current) return;
    checkMarker();
    const saved = read(FILE);
    if (initialized && saved.status !== 'ok') throw dataError(saved.error);
    if (saved.status === 'corrupt') throw dataError(saved.error);
    if (saved.status === 'ok') {
      try { validate(saved.value, maxSent); } catch (e) { throw dataError(e); }
      current = saved.value;
      committed = true;
      return;
    }
    // A pre-v2 dedup file is not a new instance. Refuse to silently rebuild its
    // baseline; migration must be explicit and must not discard queued history.
    if (read('sent_ids.json').status !== 'missing') {
      const error = new Error('检测到旧版 sent_ids.json；请使用独立 v2 数据目录或先显式迁移状态');
      error.code = 'DATA_CORRUPT';
      throw error;
    }
    current = { version: 1, accounts: Object.create(null) };
    validate(current, maxSent);
  }
  function checkDisk() {
    checkMarker();
    const saved = read(FILE);
    if (saved.status === 'corrupt' || ((committed || initialized) && saved.status !== 'ok')) throw dataError(saved.error);
    if (saved.status === 'ok') {
      try { validate(saved.value, maxSent); } catch (e) { throw dataError(e); }
    }
  }
  function commit(next) {
    // Old code must refuse state with durable multipart progress rather than
    // silently treating the remaining media as one acknowledged text message.
    const extended = next.delivered !== undefined || Object.entries(next.accounts).some(([key, record]) =>
      key.includes(':') || record.dispositions !== undefined || record.pending.some((tweet) => tweet.content || tweet.delivery));
    next = { ...next, version: next.version === 2 || extended ? 2 : 1 };
    // Validate before accepting the candidate: a full queue must preserve the previous record.
    validate(next, maxSent);
    candidate = next;
    flush();
  }
  function flush() {
    load();
    checkDisk();
    try {
      if (candidate) {
        store.writeJSON(FILE, candidate);
        current = candidate;
        candidate = null;
        committed = true;
      }
      // State must precede its durable marker. A crash between these writes is safe:
      // the complete state is loaded and the marker is retried before any send.
      // Once marked, missing state can never masquerade as a fresh installation.
      if (committed && !initialized) {
        store.writeJSON(MARKER, { version: 1 });
        initialized = true;
      }
    } catch (cause) {
      const error = new Error('待发送队列保存失败，已停止推送；恢复磁盘写入后自动重试');
      error.code = 'OUTBOX_WRITE';
      error.cause = cause;
      throw error;
    }
  }
  function get(user) {
    load();
    const key = user.toLowerCase();
    return Object.prototype.hasOwnProperty.call(current.accounts, key) ? current.accounts[key] : null;
  }
  function save(user, record) {
    load();
    if (candidate || (committed && !initialized)) throw new Error('待发送队列仍有未落盘事务，已停止推送');
    commit({ ...current, accounts: { ...current.accounts, [user.toLowerCase()]: record } });
  }
  function saveAccounts(accounts, extra = {}) {
    load();
    if (candidate || (committed && !initialized)) throw new Error('待发送队列仍有未落盘事务，已停止推送');
    commit({ ...current, ...extra, accounts });
  }
  function sharedDelivery(destination, id) {
    for (const record of Object.values(current.accounts)) {
      if (record.destination !== destination) continue;
      const tweet = record.pending.find((item) => item.id === id);
      if (tweet?.delivery) return tweet.delivery;
    }
    return null;
  }
  function ledgerForAdmission(destination, id) {
    const searchWindows = Object.entries(current.accounts).filter(([key]) => key.startsWith('search:'))
      .map(([, record]) => searchFloor(record));
    const lowestSearchFloor = searchWindows.reduce((lowest, floor) => lowest === null || floor < lowest ? floor : lowest, null);
    const delivered = (current.delivered || []).filter((item) => item.at >= Date.now() - DISCOVERY_RETENTION_MS
      || (lowestSearchFloor !== null && BigInt(item.id) > lowestSearchFloor));
    const reserved = new Set(delivered.map((item) => `${item.destination}:${item.id}`));
    for (const record of Object.values(current.accounts)) {
      for (const tweet of record.pending) if (tweet.delivery) reserved.add(`${record.destination}:${tweet.id}`);
    }
    reserved.add(`${destination}:${id}`);
    if (reserved.size > MAX_DELIVERED) throw capacityError();
    return delivered;
  }
  return {
    flush,
    get,
    ready() { return candidate === null && (!committed || initialized); },
    initialize() {
      // The worker calls this only after a saved config has selected the active
      // accounts. Persist their state before the first collection or send.
      flush();
      if (!committed) commit(current);
    },
    prune(active) {
      load();
      const keys = new Set([...active].map((user) => user.toLowerCase()));
      const accounts = Object.fromEntries(Object.entries(current.accounts).filter(([user]) => keys.has(user)));
      if (Object.keys(accounts).length !== Object.keys(current.accounts).length) saveAccounts(accounts);
    },
    baseline(user, ids, acquisitionWatermark) {
      const unique = [...new Set(ids)];
      const sent = unique.slice(-maxSent);
      save(user, { sent, watermark: highest(unique), pending: [], destination: null, gap: null,
        ...(acquisitionWatermark === undefined ? {} : { acquisitionWatermark }),
        ...(user.startsWith('search:') ? { discoveryFloor: acquisitionWatermark ?? highest(unique), discoverySeen: [] } : {}) });
    },
    capture(user, tweets, destination, gap, acquisitionWatermark, options = {}) {
      const prior = get(user);
      if (!prior || prior.sent === null) throw new Error('尚未建立抓取基线');
      if (prior.pending.length && prior.destination !== destination) throw new Error('待发送队列目标与当前 Telegram 配置不一致');
      if (typeof destination !== 'string' || !BINDING.test(destination)) throw new TypeError('发送目标无效');
      if (!options || typeof options !== 'object' || (options.filtered !== undefined && !Array.isArray(options.filtered))) throw new TypeError('筛选记录无效');
      let audit = (options.filtered || []).map((item) => disposition(item.id, 'filtered', item.reason, item.ruleVersion ?? options.ruleVersion ?? ''));
      let normalized = tweets.map(({ delivery, ...tweet }) => normalizeTweet(tweet));
      let discoverySeen;
      if (user.startsWith('search:')) {
        const now = Date.now();
        // Search queries use checkpoint-minus-24h, not wall-clock-minus-24h.
        // A quiet source can retain the same window for days; its seen IDs must
        // remain until that actual window advances, otherwise they replay.
        const floor = searchFloor(prior, acquisitionWatermark ?? prior.acquisitionWatermark ?? prior.watermark);
        const recent = (prior.discoverySeen || []).filter((item) => BigInt(item.id) > floor);
        const known = new Set([...recent.map((item) => item.id), ...prior.sent, ...prior.pending.map((item) => item.id)]);
        const isNew = (item) => !known.has(item.id) && BigInt(item.id) > BigInt(prior.discoveryFloor ?? prior.acquisitionWatermark ?? prior.watermark);
        normalized = normalized.filter(isNew);
        audit = audit.filter(isNew);
        const captured = [...new Set([...normalized, ...audit].map((item) => item.id))].map((id) => ({ id, at: now }));
        discoverySeen = [...recent, ...captured];
        if (discoverySeen.length > MAX_DISCOVERY_SEEN) throw capacityError();
      }
      const additions = [];
      for (const tweet of normalized) {
        if ((current.delivered || []).some((item) => item.id === tweet.id && item.destination === destination)) {
          audit.push(disposition(tweet.id, 'duplicate', '同一目标已由其他来源送达'));
          continue;
        }
        const plan = sharedDelivery(destination, tweet.id);
        additions.push(plan ? { ...tweet, delivery: structuredClone(plan) } : tweet);
      }
      const pending = prior.pending.concat(additions).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
      if (pending.length > MAX_PENDING_ACCOUNT) {
        const error = new Error('该账号待发送队列已达容量上限；已保留原队列且未推进抓取水位，请恢复推送或处理积压');
        error.code = 'OUTBOX_FULL';
        throw error;
      }
      if (acquisitionWatermark !== undefined && (typeof acquisitionWatermark !== 'string' || !ID.test(acquisitionWatermark)
          || BigInt(acquisitionWatermark) < BigInt(prior.acquisitionWatermark ?? prior.watermark))) {
        throw new Error('抓取检查点无效或发生回退');
      }
      if (!additions.length && !audit.length && !gap && (acquisitionWatermark === undefined || acquisitionWatermark === prior.acquisitionWatermark)) return;
      const dispositions = addDispositions(prior, audit);
      save(user, {
        ...prior, pending,
        destination: pending.length ? destination : null,
        watermark: highest([prior.watermark, ...normalized.map((tweet) => tweet.id), ...audit.map((item) => item.id)]),
        gap: prior.gap || gap || null,
        ...(dispositions ? { dispositions } : {}),
        ...(acquisitionWatermark === undefined ? {} : { acquisitionWatermark }),
        ...(discoverySeen ? { discoverySeen } : {}),
      });
    },
    enrich(user, id, content) {
      const prior = get(user);
      if (!prior || !prior.pending.some((tweet) => tweet.id === id)) throw new Error('待发送队列补充不匹配');
      const pending = prior.pending.map((tweet) => tweet.id === id
        ? { ...tweet, content: mergeTweetContent(tweet.content, content) } : tweet);
      save(user, { ...prior, pending });
    },
    prepareDelivery(user, id, parts) {
      const prior = get(user);
      if (!prior || !prior.pending.some((tweet) => tweet.id === id)) throw new Error('待发送队列计划不匹配');
      const existing = sharedDelivery(prior.destination, id);
      const normalized = existing ? null : normalizeDeliveryParts(parts);
      const delivery = existing ? structuredClone(existing)
        : { version: deliveryPartsVersion(normalized), parts: normalized, next: 0 };
      const delivered = ledgerForAdmission(prior.destination, id);
      const accounts = { ...current.accounts };
      let changed = false;
      for (const [key, record] of Object.entries(accounts)) {
        if (record.destination !== prior.destination) continue;
        const pending = record.pending.map((tweet) => {
          if (tweet.id !== id || JSON.stringify(tweet.delivery) === JSON.stringify(delivery)) return tweet;
          changed = true;
          return { ...tweet, delivery: structuredClone(delivery) };
        });
        accounts[key] = { ...record, pending };
      }
      if (changed) saveAccounts(accounts, current.delivered !== undefined ? { delivered } : {});
      return structuredClone(delivery);
    },
    acknowledgePart(user, id, index) {
      const prior = get(user);
      const delivery = prior && sharedDelivery(prior.destination, id);
      if (!delivery || index !== delivery.next || index >= delivery.parts.length) throw new Error('投递部分确认顺序不匹配');
      const next = { ...delivery, next: index + 1 };
      const accounts = Object.fromEntries(Object.entries(current.accounts).map(([key, record]) => [key,
        record.destination === prior.destination ? { ...record, pending: record.pending.map((tweet) =>
          tweet.id === id ? { ...tweet, delivery: structuredClone(next) } : tweet) } : record]));
      saveAccounts(accounts);
      return structuredClone(next);
    },
    acknowledge(user, id, visibleIds) {
      const prior = get(user);
      if (!prior || !prior.pending.some((tweet) => tweet.id === id)) throw new Error('待发送队列确认不匹配');
      const plan = sharedDelivery(prior.destination, id);
      if (plan && plan.next !== plan.parts.length) throw new Error('推文仍有未确认的投递部分');
      const visible = new Set(visibleIds);
      const uniq = [...new Set([...prior.sent, id])];
      const keep = uniq.filter((sentId) => visible.has(sentId)).slice(-maxSent);
      const rest = uniq.filter((sentId) => !visible.has(sentId));
      const room = Math.max(0, maxSent - keep.length);
      const sent = (room ? rest.slice(-room) : []).concat(keep);
      const pending = prior.pending.filter((tweet) => tweet.id !== id);
      const accounts = { ...current.accounts, [user.toLowerCase()]: { ...prior, sent, pending,
        destination: pending.length ? prior.destination : null } };
      for (const [key, record] of Object.entries(accounts)) {
        if (key === user.toLowerCase() || record.destination !== prior.destination
            || !record.pending.some((tweet) => tweet.id === id)) continue;
        const remaining = record.pending.filter((tweet) => tweet.id !== id);
        accounts[key] = { ...record, pending: remaining, destination: remaining.length ? record.destination : null,
          dispositions: addDispositions(record, [disposition(id, 'duplicate', '同一目标已由其他来源送达')]) };
      }
      const delivered = [...ledgerForAdmission(prior.destination, id).filter((item) => !(item.id === id && item.destination === prior.destination)),
        { id, destination: prior.destination, at: Date.now() }];
      saveAccounts(accounts, { delivered });
    },
  };
}

module.exports = { createOutbox, MAX_PENDING_ACCOUNT, MAX_PENDING_TOTAL, MAX_BYTES, MAX_DISPOSITIONS, MAX_DELIVERED,
  MAX_DISCOVERY_SEEN, DISCOVERY_RETENTION_MS, validSource };
