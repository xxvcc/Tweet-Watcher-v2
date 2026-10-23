'use strict';
// 配置（config.json）与敏感凭据（secrets.json）的读写与校验。
const store = require('./store');

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

function getConfig() {
  const { raw, persisted } = readConfigRecord();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw dataError('config.json');
  if (raw.tg_chat_id !== undefined && !validChatId(raw.tg_chat_id)) throw dataError('config.json');
  if (raw.paused !== undefined && typeof raw.paused !== 'boolean') throw dataError('config.json');
  if (!validStoredAccounts(raw.accounts)) throw dataError('config.json');
  if (raw._revision !== undefined && !validRevision(raw._revision)) throw dataError('config.json');
  const accounts = normalizeAccounts(raw.accounts);
  return {
    tg_chat_id: validChatId(raw.tg_chat_id) ? (raw.tg_chat_id === '' ? '' : String(raw.tg_chat_id)) : '',
    paused: raw.paused === true,
    accounts,
    revision: validRevision(raw._revision) ? raw._revision : 0,
    // 仅供 worker 区分真正首启与运行中配置消失；API 不向浏览器暴露该字段。
    persisted,
  };
}

function saveConfig(cfg) {
  // 读取时的 fail-closed 还不够：直接调用 saveConfig 也不得把已损坏文件覆盖掉。
  const current = getConfig();
  if (!cfg || typeof cfg !== 'object'
      || !validChatId(cfg.tg_chat_id)
      || typeof cfg.paused !== 'boolean'
      || !Array.isArray(cfg.accounts)
      || !validStoredAccounts(cfg.accounts)
      || (cfg.revision !== undefined && !validRevision(cfg.revision))) {
    throw new TypeError('拒绝写入非法配置');
  }
  const revision = validRevision(cfg && cfg.revision) ? cfg.revision : current.revision;
  store.writeJSON('config.json', {
    tg_chat_id: cfg.tg_chat_id,
    paused: cfg.paused === true,
    accounts: cfg.accounts,
    _revision: revision,
  });
}

function getSecrets() {
  const s = readRecord('secrets.json', {});
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw dataError('secrets.json');
  for (const key of ['auth_token', 'ct0', 'tg_bot_token']) {
    if (s[key] !== undefined && (typeof s[key] !== 'string' || Buffer.byteLength(s[key], 'utf8') > 4096)) {
      throw dataError('secrets.json');
    }
  }
  const value = (v) => typeof v === 'string' ? v.trim() : '';
  return {
    auth_token: value(s && s.auth_token),
    ct0: value(s && s.ct0),
    tg_bot_token: value(s && s.tg_bot_token),
  };
}

function saveSecrets(s) {
  // 即使调用方已经拿到旧快照，写前仍重新验证当前文件，防止损坏文件被覆盖。
  getSecrets();
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new TypeError('拒绝写入非法敏感配置');
  for (const key of ['auth_token', 'ct0', 'tg_bot_token']) {
    if (typeof s[key] !== 'string' || Buffer.byteLength(s[key], 'utf8') > 4096) {
      throw new TypeError('拒绝写入非法敏感配置');
    }
  }
  store.writeJSON('secrets.json', s);
}

module.exports = {
  LIMITS,
  validUsername, validChatId, validRevision, nextRevision, normalizeAccounts,
  getConfig, saveConfig, getSecrets, saveSecrets,
};
