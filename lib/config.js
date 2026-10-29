'use strict';
// 配置（config.json）与敏感凭据（secrets.json）的读写与校验。
const store = require('./store');
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
};

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
  for (const a of list) {
    if (out.length >= LIMITS.MAX_ACCOUNTS) break;                 // 硬上限
    const rawUsername = typeof a === 'string' ? a : (a && a.username);
    if (typeof rawUsername !== 'string') continue;
    const username = rawUsername.replace(/^@/, '').trim();
    if (!validUsername(username)) continue;
    const key = username.toLowerCase();                          // Twitter 用户名大小写不敏感
    if (seen.has(key)) continue;                                 // 去重，避免重复监控/双重推送
    seen.add(key);
    out.push({
      username,
      fetch_count: clampInt(a && a.fetch_count, 1, LIMITS.MAX_FETCH, LIMITS.DEFAULT_FETCH),
      check_interval: clampInt(a && a.check_interval, LIMITS.MIN_INTERVAL, LIMITS.MAX_INTERVAL, LIMITS.DEFAULT_INTERVAL),
    });
  }
  return out;
}

function validStoredAccounts(list) {
  if (list === undefined) return true;
  if (!Array.isArray(list) || list.length > LIMITS.MAX_ACCOUNTS) return false;
  const seen = new Set();
  for (const account of list) {
    const rawUsername = typeof account === 'string' ? account : (account && account.username);
    if (typeof rawUsername !== 'string') return false;
    const username = rawUsername.replace(/^@/, '').trim();
    if (!validUsername(username) || seen.has(username.toLowerCase())) return false;
    seen.add(username.toLowerCase());
    if (typeof account === 'string') continue;
    if (!account || typeof account !== 'object' || Array.isArray(account)) return false;
    if (account.fetch_count !== undefined
        && (!Number.isSafeInteger(account.fetch_count) || account.fetch_count < 1 || account.fetch_count > LIMITS.MAX_FETCH)) return false;
    if (account.check_interval !== undefined
        && (!Number.isSafeInteger(account.check_interval)
          || account.check_interval < LIMITS.MIN_INTERVAL
          || account.check_interval > LIMITS.MAX_INTERVAL)) return false;
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
    accounts: cfg.accounts,
    _revision: revision,
  };
}

function saveConfig(cfg) {
  // Also recovers any interrupted settings transaction before a pause change.
  const current = getConfig();
  const next = configRecord({ ai_translation_enabled: current.ai_translation_enabled,
    ai_base_url: current.ai_base_url, ai_model: current.ai_model, ...cfg }, current.revision);
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
  return { auth_token: s.auth_token, ct0: s.ct0, tg_bot_token: s.tg_bot_token, ai_api_key: aiKey };
}

function saveSecrets(s) {
  const current = getSecrets();
  const next = secretsRecord({ ai_api_key: current.ai_api_key, ...s });
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
    config: configRecord({ ai_translation_enabled: current.ai_translation_enabled,
      ai_base_url: current.ai_base_url, ai_model: current.ai_model, ...cfg }, current.revision),
    secrets: secretsRecord({ ai_api_key: currentSecrets.ai_api_key, ...secrets }) };
  if (txn.config.ai_translation_enabled && !txn.secrets.ai_api_key.trim()) throw new TypeError('启用 AI 翻译需要 API Key');
  // Write-ahead intent: any interruption is rolled forward before the next read.
  store.writeJSON(TRANSACTION, txn);
  recoverSettings();
}

module.exports = {
  LIMITS,
  validUsername, validChatId, validRevision, nextRevision, normalizeAccounts, validAccounts,
  getConfig, saveConfig, getSecrets, saveSecrets, saveSettings,
};
