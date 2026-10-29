'use strict';
// 配置（config.json）与敏感凭据（secrets.json）的读写与校验。
const store = require('./store');
const { sourceKey, validProxy } = require('./collector-source');
const { DEFAULTS: AI_DEFAULTS, validBaseUrl, validModel } = require('./translation-settings');
const TRANSACTION = 'config_transaction.json';

const LIMITS = {
  MIN_INTERVAL: 30,
  MAX_INTERVAL: 3600,
  MAX_FETCH: 50,
  DEFAULT_FETCH: 10,
  DEFAULT_INTERVAL: 300,
  MAX_SENT: 200,
  MAX_ACCOUNTS: 100,   // 账号数硬上限，防止一次请求塞入海量账号拖垮 tick
  MAX_SESSIONS: 10,
  MAX_KEYWORDS: 30,
};
const CONTENT_DEFAULTS = { media_mode: 'links', enrichment_mode: 'off', enrichment_limit: 2 };
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validId = (v) => typeof v === 'string' && /^[1-9]\d{0,31}$/.test(v);
const validSessionId = (v) => typeof v === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(v)
  && !['default', 'constructor', 'prototype', '__proto__'].includes(v);
function validProxyUrl(value) { return value === undefined || validProxy(value); }
function validFilters(filters) {
  if (filters === undefined) return true;
  if (!object(filters) || Object.keys(filters).some((k) => !['include', 'exclude', 'originals', 'reposts', 'replies', 'quotes'].includes(k))) return false;
  for (const key of ['include', 'exclude']) {
    if (filters[key] !== undefined && (!Array.isArray(filters[key]) || filters[key].length > LIMITS.MAX_KEYWORDS
      || filters[key].some((v) => typeof v !== 'string' || !v.trim() || v.length > 100 || !v.isWellFormed() || /[\x00-\x1f\x7f]/.test(v)))) return false;
  }
  return ['originals', 'reposts', 'replies', 'quotes'].every((key) => filters[key] === undefined || typeof filters[key] === 'boolean');
}
function normalizeFilters(filters = {}) {
  return { include: [...new Set((filters.include || []).map((v) => v.trim()))],
    exclude: [...new Set((filters.exclude || []).map((v) => v.trim()))],
    originals: filters.originals !== false, reposts: filters.reposts !== false,
    replies: filters.replies !== false, quotes: filters.quotes !== false };
}
function validSessions(sessions) {
  if (sessions === undefined) return true;
  if (!Array.isArray(sessions) || sessions.length > LIMITS.MAX_SESSIONS) return false;
  const seen = new Set();
  return sessions.every((s) => {
    if (!object(s) || !validSessionId(s.id) || seen.has(s.id)
      || (s.label !== undefined && (typeof s.label !== 'string' || !s.label.trim() || s.label.length > 80 || !s.label.isWellFormed() || /[\x00-\x1f\x7f]/.test(s.label)))
      || (s.enabled !== undefined && typeof s.enabled !== 'boolean') || !validProxyUrl(s.proxy_url)
      || Object.keys(s).some((key) => !['id', 'label', 'enabled', 'proxy_url'].includes(key))) return false;
    seen.add(s.id); return true;
  });
}
function normalizeSessions(sessions = []) {
  return sessions.map((s) => ({ id: s.id, label: (s.label || s.id).trim(), enabled: s.enabled !== false,
    ...(s.proxy_url ? { proxy_url: s.proxy_url } : {}) }));
}
function validContentSettings(cfg) {
  return (cfg.media_mode === undefined || ['links', 'photos', 'all'].includes(cfg.media_mode))
    && (cfg.enrichment_mode === undefined || ['off', 'detail', 'thread'].includes(cfg.enrichment_mode))
    && (cfg.enrichment_limit === undefined || (Number.isSafeInteger(cfg.enrichment_limit) && cfg.enrichment_limit >= 1 && cfg.enrichment_limit <= 5))
    && validSessions(cfg.x_sessions);
}

function dataError(name, detail) {
  const error = new Error(`${name} 损坏，已拒绝使用或覆盖`);
  error.code = 'DATA_CORRUPT';
  if (detail) error.cause = detail;
  return error;
}
function readRecord(name, fallback) {
  const result = store.readState(name);
  if (result.status === 'corrupt') throw dataError(name, result.error);
  return result.status === 'ok' ? result.value : fallback;
}
function readConfigRecord() {
  const result = store.readState('config.json');
  if (result.status === 'corrupt') throw dataError('config.json', result.error);
  if (result.status === 'ok') return { raw: result.value, persisted: true };

  // config 缺失只在真正的首次配置前合法。敏感配置已经存在时说明这是一个已建立实例，
  // 必须 fail closed。发送状态的完整性由 outbox 另行检查，不在此处导入或重建。
  for (const companion of ['secrets.json']) {
    if (store.readState(companion).status !== 'missing') {
      throw dataError('config.json', new Error(`已有 ${companion}，但 config.json 缺失`));
    }
  }
  return { raw: {}, persisted: false };
}

function validUsername(u) { return typeof u === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(u); }
function validChatId(c) {
  if (c === '') return true;
  if (typeof c === 'number' && !Number.isSafeInteger(c)) return false;
  if (typeof c !== 'string' && typeof c !== 'number') return false;
  return /^-?\d{1,32}$/.test(String(c));
}
function validRevision(v) { return Number.isSafeInteger(v) && v >= 0; }
function nextRevision(current) {
  const value = validRevision(current) ? current : 0;
  // 以墙上时间为下界，兼顾旧配置从 0 升级以及进程重启后的单调性。
  // MAX_SAFE_INTEGER 只可能来自手工篡改；必须 fail-closed，不能回绕复用旧版本号。
  if (value >= Number.MAX_SAFE_INTEGER) throw new RangeError('配置版本已耗尽');
  return Math.max(value + 1, Date.now());
}
function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function normalizeAccounts(list) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(list)) return out;
  for (const entry of list) {
    if (out.length >= LIMITS.MAX_ACCOUNTS) break;
    const a = typeof entry === 'string' ? { username: entry } : entry;
    if (!object(a)) continue;
    const type = a.source_type || 'user';
    let value;
    if (type === 'user') {
      const username = typeof (a.username ?? a.user) === 'string' ? (a.username ?? a.user).replace(/^@/, '').trim() : '';
      if (!validUsername(username)) continue;
      value = { username };
      if (a.source_type !== undefined || a.timeline_mode !== undefined) {
        value.source_type = 'user'; value.timeline_mode = a.timeline_mode || 'posts';
      }
    } else if (type === 'list' && validId(a.list_id)) value = { source_type: 'list', list_id: a.list_id };
    else if (type === 'search' && typeof a.query === 'string' && a.query.trim()) value = { source_type: 'search', query: a.query.trim() };
    else continue;
    const key = sourceKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    value.fetch_count = clampInt(a.fetch_count, 1, LIMITS.MAX_FETCH, LIMITS.DEFAULT_FETCH);
    value.check_interval = clampInt(a.check_interval, LIMITS.MIN_INTERVAL, LIMITS.MAX_INTERVAL, LIMITS.DEFAULT_INTERVAL);
    if (a.filters !== undefined) value.filters = normalizeFilters(a.filters);
    out.push(value);
  }
  return out;
}

function validStoredAccounts(list) {
  if (list === undefined) return true;
  if (!Array.isArray(list) || list.length > LIMITS.MAX_ACCOUNTS) return false;
  const seen = new Set();
  for (const entry of list) {
    const account = typeof entry === 'string' ? { username: entry } : entry;
    if (!object(account)) return false;
    const type = account.source_type === undefined ? 'user' : account.source_type;
    if (!['user', 'list', 'search'].includes(type) || !validFilters(account.filters)) return false;
    let key;
    if (type === 'user') {
      const raw = account.username ?? account.user;
      if (typeof raw !== 'string') return false;
      const username = raw.replace(/^@/, '').trim();
      if (!validUsername(username) || (account.timeline_mode !== undefined && !['posts', 'replies'].includes(account.timeline_mode))) return false;
      if (account.username !== undefined && account.user !== undefined && account.username !== account.user) return false;
      key = sourceKey({ ...account, username });
    } else if (type === 'list') {
      if (!validId(account.list_id) || account.timeline_mode !== undefined) return false;
      key = sourceKey(account);
    } else {
      if (typeof account.query !== 'string' || !account.query.trim() || account.query.length > 512 || !account.query.isWellFormed()
        || /[\x00-\x1f\x7f]/.test(account.query) || account.timeline_mode !== undefined) return false;
      key = sourceKey({ ...account, query: account.query.trim() });
    }
    if (seen.has(key)) return false;
    seen.add(key);
    if (account.fetch_count !== undefined && (!Number.isSafeInteger(account.fetch_count)
      || account.fetch_count < 1 || account.fetch_count > LIMITS.MAX_FETCH)) return false;
    if (account.check_interval !== undefined && (!Number.isSafeInteger(account.check_interval)
      || account.check_interval < LIMITS.MIN_INTERVAL || account.check_interval > LIMITS.MAX_INTERVAL)) return false;
  }
  return true;
}

// Submitted lists are all-or-nothing: filtering an invalid entry would turn a
// typing mistake into an account removal, which also discards its outbox.
function validAccounts(list) { return Array.isArray(list) && validStoredAccounts(list); }

function getConfig() {
  recoverSettings();
  const { raw, persisted } = readConfigRecord();
  validateConfigRecord(raw);
  if (raw.ai_translation_enabled === true) {
    const secrets = readRecord('secrets.json', {});
    validateSecretsRecord(secrets);
    if (!secrets.ai_api_key || !secrets.ai_api_key.trim()) throw dataError('secrets.json');
  }
  const accounts = normalizeAccounts(raw.accounts);
  return {
    tg_chat_id: validChatId(raw.tg_chat_id) ? (raw.tg_chat_id === '' ? '' : String(raw.tg_chat_id)) : '',
    paused: raw.paused === true,
    ai_translation_enabled: raw.ai_translation_enabled === true,
    ai_base_url: raw.ai_base_url ?? AI_DEFAULTS.ai_base_url,
    ai_model: raw.ai_model ?? AI_DEFAULTS.ai_model,
    media_mode: raw.media_mode ?? CONTENT_DEFAULTS.media_mode,
    enrichment_mode: raw.enrichment_mode ?? CONTENT_DEFAULTS.enrichment_mode,
    enrichment_limit: raw.enrichment_limit ?? CONTENT_DEFAULTS.enrichment_limit,
    x_sessions: normalizeSessions(raw.x_sessions),
    accounts,
    revision: validRevision(raw._revision) ? raw._revision : 0,
    // 仅供 worker 区分真正首启与运行中配置消失；API 不向浏览器暴露该字段。
    persisted,
  };
}

function validateConfigRecord(raw, name = 'config.json') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || (raw.tg_chat_id !== undefined && !validChatId(raw.tg_chat_id))
      || (raw.paused !== undefined && typeof raw.paused !== 'boolean')
      || (raw.ai_translation_enabled !== undefined && typeof raw.ai_translation_enabled !== 'boolean')
      || (raw.ai_base_url !== undefined && !validBaseUrl(raw.ai_base_url))
      || (raw.ai_model !== undefined && !validModel(raw.ai_model))
      || (raw.ai_translation_enabled === true && !raw.ai_model)
      || !validContentSettings(raw)
      || !validStoredAccounts(raw.accounts)
      || (raw._revision !== undefined && !validRevision(raw._revision))) throw dataError(name);
}

function configRecord(cfg, currentRevision) {
  if (!cfg || typeof cfg !== 'object'
      || !validChatId(cfg.tg_chat_id)
      || typeof cfg.paused !== 'boolean'
      || (cfg.ai_translation_enabled !== undefined && typeof cfg.ai_translation_enabled !== 'boolean')
      || (cfg.ai_base_url !== undefined && !validBaseUrl(cfg.ai_base_url))
      || (cfg.ai_model !== undefined && !validModel(cfg.ai_model))
      || (cfg.ai_translation_enabled === true && !cfg.ai_model)
      || !validContentSettings(cfg)
      || !Array.isArray(cfg.accounts)
      || !validStoredAccounts(cfg.accounts)
      || (cfg.revision !== undefined && !validRevision(cfg.revision))) {
    throw new TypeError('拒绝写入非法配置');
  }
  const revision = validRevision(cfg.revision) ? cfg.revision : currentRevision;
  return {
    tg_chat_id: cfg.tg_chat_id,
    paused: cfg.paused === true,
    ai_translation_enabled: cfg.ai_translation_enabled === true,
    ai_base_url: cfg.ai_base_url ?? AI_DEFAULTS.ai_base_url,
    ai_model: cfg.ai_model ?? AI_DEFAULTS.ai_model,
    media_mode: cfg.media_mode ?? CONTENT_DEFAULTS.media_mode,
    enrichment_mode: cfg.enrichment_mode ?? CONTENT_DEFAULTS.enrichment_mode,
    enrichment_limit: cfg.enrichment_limit ?? CONTENT_DEFAULTS.enrichment_limit,
    x_sessions: normalizeSessions(cfg.x_sessions),
    accounts: cfg.accounts,
    _revision: revision,
  };
}

function saveConfig(cfg) {
  // Also recovers any interrupted settings transaction before a pause change.
  const current = getConfig();
  const next = configRecord({ ...current, ...cfg }, current.revision);
  if (next.ai_translation_enabled && !getSecrets().ai_api_key) throw new TypeError('启用 AI 翻译需要 API Key');
  store.writeJSON('config.json', next);
}

function getSecrets() {
  recoverSettings();
  const s = readRecord('secrets.json', {});
  validateSecretsRecord(s);
  const value = (v) => typeof v === 'string' ? v.trim() : '';
  return {
    auth_token: value(s.auth_token), ct0: value(s.ct0), tg_bot_token: value(s.tg_bot_token), ai_api_key: value(s.ai_api_key),
    x_sessions: Object.fromEntries(Object.entries(s.x_sessions || {}).map(([id, credentials]) =>
      [id, { auth_token: value(credentials.auth_token), ct0: value(credentials.ct0) }])),
  };
}

function validateSecretsRecord(s, name = 'secrets.json') {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw dataError(name);
  for (const key of ['auth_token', 'ct0', 'tg_bot_token', 'ai_api_key']) {
    if (s[key] !== undefined && (typeof s[key] !== 'string' || Buffer.byteLength(s[key], 'utf8') > 4096)) {
      throw dataError(name);
    }
  }
  if (typeof s.ai_api_key === 'string'
      && (/[\r\n\0]/.test(s.ai_api_key) || /[\s\x00-\x1f\x7f]/.test(s.ai_api_key.trim()))) throw dataError(name);
  if (!validSessionSecrets(s.x_sessions)) throw dataError(name);
}

function validSessionSecrets(sessions) {
  if (sessions === undefined) return true;
  return object(sessions) && Object.keys(sessions).length <= LIMITS.MAX_SESSIONS
    && Object.entries(sessions).every(([id, s]) => validSessionId(id) && object(s)
      && Object.keys(s).every((key) => ['auth_token', 'ct0'].includes(key))
      && ['auth_token', 'ct0'].every((key) => s[key] === undefined || (typeof s[key] === 'string'
        && s[key].length <= 4096 && (s[key] === '' || /^[A-Za-z0-9_%.-]+$/.test(s[key])))));
}

function secretsRecord(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new TypeError('拒绝写入非法敏感配置');
  for (const key of ['auth_token', 'ct0', 'tg_bot_token']) {
    if (typeof s[key] !== 'string' || Buffer.byteLength(s[key], 'utf8') > 4096) {
      throw new TypeError('拒绝写入非法敏感配置');
    }
  }
  const aiKey = s.ai_api_key === undefined ? '' : s.ai_api_key;
  if (typeof aiKey !== 'string' || Buffer.byteLength(aiKey, 'utf8') > 4096
      || /[\r\n\0]/.test(aiKey) || /[\s\x00-\x1f\x7f]/.test(aiKey.trim())) {
    throw new TypeError('拒绝写入非法敏感配置');
  }
  if (!validSessionSecrets(s.x_sessions)) throw new TypeError('拒绝写入非法 X 会话凭据');
  return { auth_token: s.auth_token, ct0: s.ct0, tg_bot_token: s.tg_bot_token, ai_api_key: aiKey,
    x_sessions: Object.fromEntries(Object.entries(s.x_sessions || {}).map(([id, credentials]) =>
      [id, { auth_token: credentials.auth_token || '', ct0: credentials.ct0 || '' }])) };
}

function saveSecrets(s) {
  const current = getSecrets();
  const next = secretsRecord({ ...current, ...s });
  if (getConfig().ai_translation_enabled && !next.ai_api_key.trim()) throw new TypeError('启用 AI 翻译需要 API Key');
  store.writeJSON('secrets.json', next);
}

function recoverSettings() {
  const saved = store.readState(TRANSACTION);
  if (saved.status === 'missing') return;
  if (saved.status !== 'ok') throw dataError(TRANSACTION);
  const txn = saved.value;
  if (!txn || txn.version !== 1 || !txn.config || !txn.secrets
      || !Object.hasOwn(txn.config, '_revision') || !Object.hasOwn(txn.config, 'accounts')
      || !Object.hasOwn(txn.config, 'paused') || !Object.hasOwn(txn.config, 'tg_chat_id')) throw dataError(TRANSACTION);
  validateConfigRecord(txn.config, TRANSACTION);
  validateSecretsRecord(txn.secrets, TRANSACTION);
  if (txn.config.ai_translation_enabled === true && !txn.secrets.ai_api_key?.trim()) throw dataError(TRANSACTION);
  if (['auth_token', 'ct0', 'tg_bot_token'].some((key) => typeof txn.secrets[key] !== 'string')) throw dataError(TRANSACTION);
  // A valid intent permits completing missing files, but never overwrites corrupt
  // external state silently. No consumer can observe the pair until recovery ends.
  for (const [name, validate] of [['config.json', validateConfigRecord], ['secrets.json', validateSecretsRecord]]) {
    const existing = store.readState(name);
    if (existing.status === 'corrupt') throw dataError(name);
    if (existing.status === 'ok') validate(existing.value);
  }
  try {
    // Re-sync the intent before touching either file, including recovery after a
    // rename whose directory fsync failed. The private journal contains secrets.
    store.writeJSON(TRANSACTION, txn);
    store.writeJSON('config.json', configRecord({ ...txn.config, revision: txn.config._revision }, txn.config._revision));
    store.writeJSON('secrets.json', secretsRecord(txn.secrets));
    store.removeJSON(TRANSACTION);
  } catch (_) {
    const error = new Error('配置事务未完成，已停止使用配置；恢复存储后将完成提交，请重新载入核对');
    error.code = 'CONFIG_COMMIT_PENDING';
    throw error;
  }
}

function saveSettings(cfg, secrets) {
  const current = getConfig();
  const currentSecrets = getSecrets();
  const txn = { version: 1,
    config: configRecord({ ...current, ...cfg }, current.revision),
    secrets: secretsRecord({ ...currentSecrets, ...secrets }) };
  if (txn.config.ai_translation_enabled && !txn.secrets.ai_api_key.trim()) throw new TypeError('启用 AI 翻译需要 API Key');
  // Write-ahead intent: any interruption is rolled forward before the next read.
  store.writeJSON(TRANSACTION, txn);
  recoverSettings();
}

module.exports = {
  LIMITS,
  validUsername, validChatId, validRevision, nextRevision, normalizeAccounts, validAccounts,
  sourceKey, validId, validSessionId, validSessions, normalizeSessions, validSessionSecrets,
  validContentSettings, validProxyUrl, normalizeFilters, CONTENT_DEFAULTS,
  getConfig, saveConfig, getSecrets, saveSecrets, saveSettings,
};
