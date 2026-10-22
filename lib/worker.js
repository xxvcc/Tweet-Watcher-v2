'use strict';
// 调度 worker：按账号间隔拉取、去重、重试推送。与面板同进程。
// 账号之间以受限并发执行（不同账号 -> 不同去重键，无共享状态竞态），避免单个慢/死账号队头阻塞其余账号。
const crypto = require('crypto');
const store = require('./store');
const cfgmod = require('./config');
// Lazy provider selection keeps the legacy runner isolated from v2 collection.
function collector() { return require(runtime.status().mode === 'legacy-live' ? './bird' : './twscrape'); }
const tg = require('./telegram');
const state = require('./state');
const { createOutbox } = require('./outbox');
const runtime = require('./runtime');

const TICK_MS = 5000;
const MAX_CONCURRENT_CHECKS = 4; // 同时在检查的账号上限（也即并发旧 Bird 子进程上限）
const MAX_BACKOFF_MS = 3600e3;   // Telegram 洪泛退避上限
const TWITTER_SNOWFLAKE_EPOCH_MS = 1288834974657n;

const delivery = createOutbox(store, cfgmod.LIMITS.MAX_SENT);
const MAX_DELIVERIES_PER_CHECK = 50;
let lastCheck = Object.create(null); // username -> ts(ms)
let running = false;
let pausedNow = false;               // 易失暂停标志：由 /api/control 直接置位，实现"暂停即时生效"
const tgBackoffs = new Map();         // bot token 指纹 -> { until, noticeAt }，不同 bot 的 429 互不污染
let configGeneration = 0;            // 配置/暂停变更时取消仍在途的旧快照
let persistedConfigSeen = false;      // 防运行中整个 data/ 消失后退化为“首次空配置”并清空去重表

function observeConfigPresence(cfg) {
  // 测试桩和旧调用方没有 persisted 字段，按正常持久配置处理；只有配置模块明确返回 false
  // 才表示当前是合法首启默认值。一个进程见过真实配置后，这个状态不得再倒退。
  if (cfg && cfg.persisted === false) {
    if (persistedConfigSeen) {
      const error = new Error('config.json 运行中缺失，已拒绝回退为空配置');
      error.code = 'DATA_CORRUPT';
      throw error;
    }
    return;
  }
  persistedConfigSeen = true;
}

// 等待期间也维持 worker 心跳。按剩余时长递减，不依赖可回拨的系统墙上时钟。
async function sleep(ms) {
  let remaining = Math.max(0, Number(ms) || 0);
  do {
    const chunk = Math.min(15000, remaining);
    await new Promise((r) => setTimeout(r, chunk));
    remaining -= chunk;
    state.setStatus({ lastTickAt: Date.now() });
  } while (remaining > 0);
}

// 供 Web 路由通知在途任务和其他面板标签页：旧快照不得继续发消息。
function configChanged(revision) {
  configGeneration++;
  // 对外版本来自 config.json，不能在此使用重启后归零的内存计数。
  const persisted = cfgmod.validRevision(revision) ? revision : cfgmod.getConfig().revision;
  state.setStatus({ configRevision: persisted });
}
// 供 /api/control 即时置位暂停态，无需等下一 tick 读盘
function setPaused(v) { pausedNow = !!v; configGeneration++; }

// 从日志字符串里抹掉可能被采集器/错误输出带出的凭据值
function redact(s, secrets) {
  let out = String(s == null ? '' : s);
  for (const v of [secrets.auth_token, secrets.ct0, secrets.tg_bot_token]) {
    if (v && v.length >= 4) out = out.split(v).join('***');
  }
  return out;
}
// 取当前凭据用于脱敏；读盘失败时宁可不记日志内容，也不能裸奔输出
function safeRedact(s) {
  try { return redact(s, cfgmod.getSecrets()); } catch (_) { return '（内容已省略）'; }
}

function botKey(botToken) {
  return crypto.createHash('sha256').update(String(botToken || '')).digest('hex');
}

function normalizeBackoffClock(entry, now) {
  if (Number.isFinite(entry.lastNow) && now < entry.lastNow) {
    const rollback = entry.lastNow - now;
    // 平移绝对时间锚点，保持回拨前的剩余退避时长不变。
    entry.until -= rollback;
    if (entry.noticeAt > 0) entry.noticeAt = Math.max(0, entry.noticeAt - rollback);
  }
  entry.lastNow = now;
}

function setTelegramBackoff(botToken, retryAfter) {
  const now = Date.now();
  const rawSeconds = Number(retryAfter);
  const wait = Math.min(
    MAX_BACKOFF_MS,
    Math.max(2000, Number.isFinite(rawSeconds) && rawSeconds > 0 ? rawSeconds * 1000 : 0),
  );
  const key = botKey(botToken);
  for (const [k, entry] of tgBackoffs) {
    normalizeBackoffClock(entry, now);
    if (entry.until <= now) tgBackoffs.delete(k);
  }
  if (!tgBackoffs.has(key) && tgBackoffs.size >= 16) {
    let oldestKey = null;
    let oldestUntil = Infinity;
    for (const [k, entry] of tgBackoffs) {
      if (entry.until < oldestUntil) { oldestKey = k; oldestUntil = entry.until; }
    }
    if (oldestKey) tgBackoffs.delete(oldestKey);
  }
  const previous = tgBackoffs.get(key);
  const until = Math.max(previous ? previous.until : 0, now + wait);
  tgBackoffs.set(key, { until, noticeAt: 0, lastNow: now });
  // 多个并发请求可能先后收到不同 retry_after。调用方需要展示合并后的真实剩余时间，
  // 不能用最后一个（可能更短的）响应误报退避即将结束。
  return until - now;
}

// Telegram 洪泛退避是否生效。日志每分钟最多一行，避免 100 个账号 × 每 5 秒刷屏。
function backoffActive(botToken) {
  const key = botKey(botToken);
  const entry = tgBackoffs.get(key);
  if (!entry) return 0;
  const now = Date.now();
  normalizeBackoffClock(entry, now);
  if (now >= entry.until) { tgBackoffs.delete(key); return 0; }
  if (now - entry.noticeAt > 60000) {
    entry.noticeAt = now;
    state.log(`⏸ Telegram 退避中，还需 ${Math.ceil((entry.until - now) / 1000)}s；期间新推文顺延推送`);
  }
  return entry.until - now;
}

// 受限并发执行：items 逐个交给 fn，最多 limit 个同时在跑
async function runPool(items, limit, fn) {
  const queue = items.slice();
  const workers = [];
  const n = Math.min(limit, queue.length);
  for (let i = 0; i < n; i++) {
    workers.push((async () => {
      while (queue.length) { await fn(queue.shift()); }
    })());
  }
  await Promise.all(workers);
}

function emptyTimelineWatermark(now) {
  const numeric = Number(now);
  const timestamp = Number.isFinite(numeric) && numeric > 0 ? BigInt(Math.trunc(numeric)) : 0n;
  const elapsed = timestamp > TWITTER_SNOWFLAKE_EPOCH_MS
    ? timestamp - TWITTER_SNOWFLAKE_EPOCH_MS : 0n;
  // Snowflake 低 22 位是同毫秒内的 worker/sequence。记录该毫秒之前的最大值，
  // 使同毫秒内的任意真实 ID（包括低 22 位全 0）都会被视为新推文。
  return elapsed > 0n ? ((elapsed << 22n) - 1n).toString() : '0';
}

function destinationKey(cfg, secrets) {
  return crypto.createHash('sha256').update(JSON.stringify([secrets.tg_bot_token, String(cfg.tg_chat_id)])).digest('hex');
}

function gapMessage(gap) {
  return gap ? `抓取窗口未覆盖上次水位 ${gap.after}，可能漏抓历史推文；此告警持续保留，请核对缺口` : null;
}

async function checkAccount(acct, cfg, secrets, startedAt, generation) {
  const user = acct.username;
  state.setAccount(user, { checking: true });
  try {
    let record = delivery.get(user);
    // Observed/contextual IDs can be newer than the ordinary timeline. Keep
    // acquisition coverage separate from the largest queued/delivered ID.
    const priorCheckpoint = record && (record.acquisitionWatermark ?? record.watermark);
    const destination = destinationKey(cfg, secrets);
    if (record && record.pending.length && record.destination !== destination) {
      state.setAccount(user, {
        checking: false, lastCheck: startedAt, ok: false, lastPushed: 0,
        lastError: '待发送队列绑定的 Telegram Bot / Chat ID 已变更；已保留旧队列并停止该账号。恢复原目标可继续发送；移除账号会明确丢弃其队列',
      });
      return;
    }
    // Collection has its own hard deadline. Keep liveness visible during its
    // bounded wait, which can legitimately exceed the 60-second health window.
    const heartbeat = setInterval(() => state.setStatus({ lastTickAt: Date.now() }), 15000);
    heartbeat.unref?.();
    let res;
    try {
      res = await collector().fetchTweets({
        birdPath: cfg.bird_path, username: user, count: acct.fetch_count,
        authToken: secrets.auth_token, ct0: secrets.ct0,
        sinceId: priorCheckpoint || undefined,
      });
    } finally { clearInterval(heartbeat); }

    if (pausedNow || generation !== configGeneration) return;
    let fetchError = null;
    let captureError = null;
    const legacyProvider = runtime.status().mode === 'legacy-live';
    const newestId = res.coverage?.newestId;
    const checkpointOK = legacyProvider || (typeof newestId === 'string' && /^\d{1,32}$/.test(newestId)
      && Array.isArray(res.tweets) && res.tweets.some((tweet) => tweet.id === newestId
        && (!tweet.author_username || tweet.author_username.toLowerCase() === user.toLowerCase())))
      || (newestId === null && res.coverage?.exhausted === true);
    const acquisitionOK = res.ok && (legacyProvider && !res.coverage || (res.coverage && res.coverage.complete === true
      && checkpointOK
      && (res.tweets.length > 0 || res.coverage.exhausted === true)
      && (legacyProvider || !record || !record.watermark || res.coverage.reachedSince === true || res.coverage.exhausted === true)));
    const tweets = acquisitionOK ? res.tweets : [];
    if (!acquisitionOK) {
      fetchError = res.ok ? '时间线页面不完整，未推进抓取水位'
        : redact([res.error, res.raw].filter(Boolean).join('：') || '未知', secrets);
      state.log(`✗ 拉取 @${user} 失败：${fetchError}`);
    } else if (!record || !Array.isArray(record.sent)) {
      // The initial snapshot remains a baseline, never a historical replay. Both empty
      // and nonempty baselines must reach disk before they can affect future delivery.
      const ids = tweets.length ? tweets.map((tweet) => String(tweet.id)) : [emptyTimelineWatermark(startedAt)];
      delivery.baseline(user, ids, legacyProvider ? undefined : newestId ?? emptyTimelineWatermark(startedAt));
      state.log(tweets.length
        ? `@${user} 首次运行，记录 ${new Set(ids).size} 条推文 ID，不推送`
        : `@${user} 首次拉取为空，已记录时间水位，不推送历史推文`);
      state.setAccount(user, { checking: false, lastCheck: startedAt, ok: true, lastError: null, lastPushed: 0 });
      return;
    } else {
      const known = new Set([...record.sent, ...record.pending.map((tweet) => tweet.id)]);
      const seen = new Set();
      const fresh = tweets.filter((tweet) => {
        const id = String(tweet.id);
        if (known.has(id) || seen.has(id)) return false;
        // Conversation modules can include other authors. Preserve their raw
        // evidence, but do not announce their posts as the monitored author's.
        if (!legacyProvider && tweet.author_username && tweet.author_username.toLowerCase() !== user.toLowerCase()) return false;
        seen.add(id);
        return BigInt(id) > BigInt(priorCheckpoint);
      }).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
      // A prior high watermark must be reached by a complete page (pinned tweets do
      // not establish coverage). Once a gap occurs, later success cannot hide it.
      const covered = res.coverage
        ? res.coverage.complete === true && (res.coverage.reachedSince === true || res.coverage.exhausted === true)
        : tweets.some((tweet) => String(tweet.id) === priorCheckpoint);
      const gap = !covered && !record.gap && (res.coverage || fresh.length)
        ? { after: priorCheckpoint, before: fresh.length ? String(fresh[0].id) : priorCheckpoint } : null;
      const nextCheckpoint = legacyProvider ? undefined
        : newestId !== null && BigInt(newestId) > BigInt(priorCheckpoint) ? newestId : priorCheckpoint;
      try { delivery.capture(user, fresh, destination, gap, nextCheckpoint); }
      catch (e) {
        if (e.code !== 'OUTBOX_FULL') throw e;
        // Capacity failure must not prevent draining the already durable backlog.
        // The acquisition checkpoint stays put so the next poll tries the same range.
        captureError = e.message;
        state.log(`✗ @${user} ${captureError}`);
      }
    }

    record = delivery.get(user);
    let pushed = 0;
    let deliveryError = null;
    let interrupted = false;
    const pending = record ? record.pending.slice(0, MAX_DELIVERIES_PER_CHECK) : [];
    for (const tweet of pending) {
      if (pausedNow || generation !== configGeneration) { interrupted = true; break; }
      if (!delivery.ready()) throw new Error('待发送队列仍有未落盘事务，已停止推送');
      if (backoffActive(secrets.tg_bot_token)) { deliveryError = 'Telegram 退避中，推送已顺延'; break; }
      const text = tg.formatTweet(tweet, user);
      let ok = false;
      let sendError = '发送失败';
      for (let attempt = 0; attempt < 3; attempt++) {
        if (pausedNow || generation !== configGeneration) { interrupted = true; break; }
        if (!delivery.ready()) throw new Error('待发送队列仍有未落盘事务，已停止推送');
        if (backoffActive(secrets.tg_bot_token)) { deliveryError = 'Telegram 退避中，推送已顺延'; break; }
        const send = await tg.sendMessage({ botToken: secrets.tg_bot_token, chatId: cfg.tg_chat_id, text });
        if (send.ok) { ok = true; break; }
        sendError = redact(send.description || '发送失败', secrets);
        if (send.rateLimited) {
          const wait = setTelegramBackoff(secrets.tg_bot_token, send.retryAfter);
          if (pausedNow || generation !== configGeneration) { interrupted = true; break; }
          deliveryError = `Telegram 限流，推送顺延 ${Math.round(wait / 1000)}s`;
          state.log(`⏸ ${deliveryError}`);
          break;
        }
        if (pausedNow || generation !== configGeneration) { interrupted = true; break; }
        if (backoffActive(secrets.tg_bot_token)) { deliveryError = 'Telegram 退避中，推送已顺延'; break; }
        if (send.permanent) { state.log(`  Telegram(永久失败，不重试): ${sendError}`); break; }
        if (attempt === 2) { state.log(`  Telegram: ${sendError}`); break; }
        state.log(`↻ 重试 @${user}: ${tweet.id}（2s 后）`);
        await sleep(2000);
      }
      if (ok) {
        // The only unavoidable duplicate window is Telegram success followed by a
        // crash before this atomic acknowledgement; pending content is never lost.
        delivery.acknowledge(user, tweet.id, tweets.map((item) => String(item.id)));
        pushed++;
        if (!pausedNow && generation === configGeneration) state.addPush(user, tweet);
        state.log(`✓ 推送 @${user}: ${tweet.id}`);
      } else {
        if (!interrupted && !deliveryError) deliveryError = `Telegram 推送失败：${sendError}`;
        if (deliveryError) state.log(`✗ 推送失败 @${user}: ${tweet.id}（${deliveryError}）`);
        break;
      }
      await sleep(500);
    }
    if (pausedNow || generation !== configGeneration) return;
    record = delivery.get(user);
    const errors = [fetchError, captureError, deliveryError, record && gapMessage(record.gap)].filter(Boolean);
    if (record && record.pending.length && !deliveryError) errors.push(`待发送队列仍有 ${record.pending.length} 条，后续检查继续推送`);
    if (!pending.length && !errors.length) state.log(`@${user} 无新推文`);
    state.pushHistory(user, pushed);
    const patch = { checking: false, lastCheck: startedAt, lastPushed: pushed };
    if (errors.length) { patch.ok = false; patch.lastError = errors.join('；'); }
    else if (!interrupted) { patch.ok = true; patch.lastError = null; }
    state.setAccount(user, patch);
  } finally {
    const s = state.getStatus().accounts[user];
    if (s && s.checking) state.setAccount(user, { checking: false });
  }
}

async function tick() {
  const blocked = runtime.blocked('scheduling');
  if (blocked) {
    state.setStatus({ running: false, lastTickAt: null, runtime: runtime.status() });
    return;
  }
  let cfg;
  let secrets;
  try {
    cfg = cfgmod.getConfig();
    observeConfigPresence(cfg);
    secrets = cfgmod.getSecrets();
    delivery.flush();
    // Removal deliberately discards the account baseline and pending messages.
    // A legacy-only migration survives the legitimate unconfigured first boot.
    if (cfg.persisted !== false) {
      delivery.prune(new Set(cfg.accounts.map((acct) => acct.username)));
      delivery.initialize();
    }
  }
  catch (e) {
    // 配置损坏时不能继续更新心跳并对外谎报 healthy。文件修复后下轮会自动恢复。
    state.setStatus({ running: false, lastTickAt: null });
    throw e;
  }
  state.setStatus({ running: true, lastTickAt: Date.now(), configRevision: cfg.revision });
  // 配置快照与代次必须一起捕获。排队任务不能在稍后取得槽位时给旧快照套上新代次。
  const tickGeneration = configGeneration;
  pausedNow = !!cfg.paused;
  state.setStatus({ paused: pausedNow });

  // 清理已删除账号的去重记录/计时/状态
  const active = cfg.accounts.map((a) => a.username);
  const activeSet = new Set(active);
  for (const u of Object.keys(lastCheck)) if (!activeSet.has(u)) delete lastCheck[u];
  state.pruneAccounts(active);

  if (!pausedNow) {
    const now = Date.now();
    const due = cfg.accounts.filter((a) => {
      const previous = lastCheck[a.username];
      // 墙上时钟可能因 NTP/人工校时回拨。若仍直接做差，回拨一天就会让该账号
      // 在心跳持续正常的同时停查一天；检测到回拨时立即重新建立调度锚点。
      return previous == null || now < previous || now - previous >= a.check_interval * 1000;
    });
    await runPool(due, runtime.status().mode === 'legacy-live' ? MAX_CONCURRENT_CHECKS : 1, async (acct) => {
      if (pausedNow || tickGeneration !== configGeneration) return;
      // 排队账号只有在真正获得池槽时才算“开始检查”；暂停时未启动的账号保持立即到期。
      const startedAt = Date.now();
      lastCheck[acct.username] = startedAt;
      try { await checkAccount(acct, cfg, secrets, startedAt, tickGeneration); }
      catch (e) {
        const detail = redact((e && e.message) || e, secrets);
        state.log(`检查 @${acct.username} 异常：${detail}`);
        if (!pausedNow && tickGeneration === configGeneration) {
          state.setAccount(acct.username, { checking: false, ok: false, lastCheck: startedAt, lastError: detail });
        }
      }
      // 暂停或配置变更取消了本次工作时不消耗检查周期；恢复/新配置应立即重新检查。
      if (tickGeneration !== configGeneration) delete lastCheck[acct.username];
      state.setStatus(delivery.ready() ? { lastTickAt: Date.now() } : { running: false, lastTickAt: null });
    });
  }

  state.setStatus(delivery.ready() ? { lastTickAt: Date.now() } : { running: false, lastTickAt: null });
}

async function loop() {
  try { await tick(); }
  catch (e) {
    // DATA_CORRUPT 消息只包含固定文件名，直接告知面板；其他异常仍必须经凭据脱敏。
    const detail = e && e.code === 'DATA_CORRUPT' ? e.message : safeRedact((e && e.message) || e);
    state.log(`tick 异常：${detail}`);
  }
  finally { setTimeout(loop, TICK_MS); } // 无论如何都排下一轮，杜绝调度永久停摆
}

function start() {
  const blocked = runtime.blocked('scheduling');
  if (blocked) {
    state.setStatus({ running: false, lastTickAt: null, runtime: runtime.status() });
    state.log(blocked.message);
    return;
  }
  if (running) return;
  running = true;
  let revision = 0;
  try {
    const cfg = cfgmod.getConfig();
    observeConfigPresence(cfg);
    revision = cfg.revision;
  }
  catch (e) { state.log(`配置读取失败，监控将保持停止：${(e && e.message) || e}`); }
  state.setStatus({ running: true, startedAt: Date.now(), configRevision: revision });
  state.log('监控服务已启动');
  loop();
}

// —— 供面板即时调用的测试 ——
async function testCollector(username) {
  const blocked = runtime.blocked('collection');
  if (blocked) return blocked;
  const cfg = cfgmod.getConfig();
  const secrets = cfgmod.getSecrets();
  const requested = typeof username === 'string' ? username : '';
  const user = (requested || (cfg.accounts[0] && cfg.accounts[0].username) || 'elonmusk').replace(/^@/, '').trim();
  const res = await collector().fetchTweets({ birdPath: cfg.bird_path, username: user, count: 1, authToken: secrets.auth_token, ct0: secrets.ct0 });
  if (!res.ok) return { ok: false, code: res.code || 'COLLECTION_FAILED', message: redact([res.error, res.raw].filter(Boolean).join('：') || '拉取失败', secrets) };
  if (!res.coverage || res.coverage.complete !== true || (!res.tweets.length && res.coverage.exhausted !== true)) {
    return { ok: false, code: 'INCOMPLETE_COVERAGE', message: '时间线页面不完整，未保存检查点' };
  }
  const ownTweets = res.tweets.filter((tweet) => !tweet.author_username || tweet.author_username.toLowerCase() === user.toLowerCase());
  const t = ownTweets.reduce((newest, tweet) => !newest || BigInt(tweet.id) > BigInt(newest.id) ? tweet : newest, null);
  return { ok: true, collector: runtime.status().collector, count: res.tweets.length, coverage: res.coverage, message: t ? `拉取 @${user} 成功，最新推文：${(t.text || '').slice(0, 80)}` : `@${user} 无推文，但连接正常` };
}

async function testTelegram() {
  const blocked = runtime.blocked('delivery');
  if (blocked) return blocked;
  const cfg = cfgmod.getConfig();
  const secrets = cfgmod.getSecrets();
  const remaining = backoffActive(secrets.tg_bot_token);
  if (remaining > 0) {
    return { ok: false, message: `Telegram 退避中，请 ${Math.ceil(remaining / 1000)} 秒后再测试` };
  }
  const r = await tg.sendMessage({ botToken: secrets.tg_bot_token, chatId: cfg.tg_chat_id, text: '🐦 Tweet Watcher 测试消息 — 配置正确！' });
  if (r.rateLimited) {
    const wait = setTelegramBackoff(secrets.tg_bot_token, r.retryAfter);
    state.log(`⏸ Telegram 测试触发限流，推送顺延 ${Math.round(wait / 1000)}s`);
  }
  return { ok: r.ok, message: r.ok ? 'Telegram 测试消息已发送' : ('发送失败：' + redact(r.description || '', secrets)) };
}

// tick 导出仅作测试/手动触发用；常态调度由 start() 内的 loop 驱动
module.exports = { start, tick, setPaused, configChanged, testCollector, testBird: testCollector, testTelegram };
