'use strict';
// 运行时状态 + 日志环形缓冲 + 事件总线（供 SSE 实时推送给面板）。
const crypto = require('crypto');
const EventEmitter = require('events');

const bus = new EventEmitter();
// 有界上限：足够容纳受控数量的 SSE 连接（每连接 2 个监听器）+ 余量。
bus.setMaxListeners(64);

const MAX_LOGS = 500;
const MAX_LOG_CHARS = 4096;
const HISTORY_LEN = 12; // 每账号保留最近多少次检查的推送量（供 sparkline）
const COALESCE_MS = 200; // status 广播合并窗口
const logs = [];
const logInstance = crypto.randomBytes(8).toString('hex');
let logSequence = 0;
let stdoutUsable = true;
// stream 的异步 error 不会被 write() 周围的 try/catch 捕获；安装监听器防止 EPIPE 变成未捕获异常。
if (process.stdout && typeof process.stdout.on === 'function') {
  process.stdout.on('error', () => { stdoutUsable = false; });
}

let status = {
  runtime: require('./runtime').status(),
  running: false,      // worker 是否已启动
  paused: false,       // 是否被面板暂停监控
  startedAt: null,     // 服务启动时间
  lastTickAt: null,    // 最近一次 worker tick 完成时间（心跳）
  pushesToday: 0,      // 今日已推送总数
  pushesTodayDate: null, // 今日日期（YYYY-MM-DD），跨天归零
  accounts: Object.create(null), // username -> 运行时状态
};

function nowISO() { return new Date().toISOString(); }
// 用展示时区（Asia/Shanghai）的日期作"今日"键，避免 UTC 日界与界面时间错位 8 小时
function today() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); }

// 跨天归零。必须在每个读/写 status 的入口调用：若只在 addPush 里做，
// 零点后一直没有新推文时，面板会持续显示昨天的计数。
function rollDay() {
  const d = today();
  if (status.pushesTodayDate === d) return false;
  status.pushesToday = 0;
  status.pushesTodayDate = d;
  return true;
}

// 一轮 tick 会产生 O(账号数) 次状态变更；若逐次广播，每个 SSE 客户端都要把
// 整个 status（含全部账号）重新序列化一遍，形成 O(账号数 × 客户端数 × 账号数) 放大。
// 这里把窗口内的变更合并成一帧发出。
let emitTimer = null;
function emitStatus() {
  if (emitTimer) return;
  emitTimer = setTimeout(() => { emitTimer = null; bus.emit('status', status); }, COALESCE_MS);
  if (emitTimer.unref) emitTimer.unref();
}

function log(msg) {
  let text = String(msg);
  if (text.length > MAX_LOG_CHARS) {
    let clipped = text.slice(0, MAX_LOG_CHARS);
    const last = clipped.charCodeAt(clipped.length - 1);
    if (last >= 0xD800 && last <= 0xDBFF) clipped = clipped.slice(0, -1);
    text = `${clipped}…（日志已截断）`;
  }
  const line = { id: `${logInstance}:${++logSequence}`, t: nowISO(), msg: text };
  logs.push(line);
  if (logs.length > MAX_LOGS) logs.shift();
  bus.emit('log', line);
  // 打到 stdout 交给 journald；写失败(如 EPIPE)不得冒泡，否则会拖垮调用方(worker loop)。
  if (stdoutUsable) {
    try { process.stdout.write(`[${line.t}] ${line.msg}\n`); } catch (_) { stdoutUsable = false; }
  }
}

function getLogs(limit = 200) { return logs.slice(-limit); }
function getStatus() { if (rollDay()) emitStatus(); return status; }

function setStatus(patch) {
  rollDay();
  status = { ...status, ...patch };
  emitStatus();
}

function acct(user) {
  return status.accounts[user] || (status.accounts[user] = {});
}

function setAccount(user, patch) {
  status.accounts[user] = { ...acct(user), ...patch };
  emitStatus();
}

// 记录一次成功推送：全局今日计数（跨天归零）+ 该账号累计/最近推文
function addPush(user, tweet) {
  rollDay();
  status.pushesToday++;
  const a = acct(user);
  a.pushedTotal = (a.pushedTotal || 0) + 1;
  a.lastPushAt = Date.now();
  a.lastTweet = { text: String((tweet && tweet.text) || '').slice(0, 160), time: (tweet && tweet.time) || '', id: String((tweet && tweet.id) || '') };
  emitStatus();
}

// 记录一次检查的推送量（供 sparkline），保留最近 HISTORY_LEN 次
function pushHistory(user, n) {
  const a = acct(user);
  a.history = (a.history || []).concat(Number(n) || 0).slice(-HISTORY_LEN);
  emitStatus();
}

function pruneAccounts(activeUsers) {
  const set = new Set(activeUsers);
  let changed = false;
  for (const u of Object.keys(status.accounts)) {
    if (!set.has(u)) { delete status.accounts[u]; changed = true; }
  }
  if (changed) emitStatus();
}

module.exports = { bus, log, getLogs, getStatus, setStatus, setAccount, addPush, pushHistory, pruneAccounts };
