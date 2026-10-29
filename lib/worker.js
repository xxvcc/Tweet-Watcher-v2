'use strict';
// 调度 worker：按账号间隔拉取、去重、重试推送。与面板同进程。
// 多个目标共享一个 X 登录会话，按顺序执行有明确截止时间的采集。
const crypto = require('crypto');
const store = require('./store');
const cfgmod = require('./config');
const collector = require('./twscrape');
const tg = require('./telegram');
const state = require('./state');
const { createOutbox } = require('./outbox');
const runtime = require('./runtime');
const translation = require('./translation');
const { createSessionPool, configuredSessions } = require('./x-sessions');
const { filterTweet, ruleVersion } = require('./tweet-filter');
const { mergeTweetContent, normalizeTweetContent } = require('./tweet-content');
const sessions = createSessionPool({ store });
let xBusy = false;
let tickBusy = false;
let deliveryFlight = null;
let deliveryOffset = 0;

const TICK_MS = 5000;
const MAX_BACKOFF_MS = 3600e3;   // Telegram 洪泛退避上限
const TWITTER_SNOWFLAKE_EPOCH_MS = 1288834974657n;

const delivery = createOutbox(store, cfgmod.LIMITS.MAX_SENT);
const MAX_DELIVERIES_PER_CHECK = 50;
let lastCheck = Object.create(null); // username -> ts(ms)
let running = false;
let pausedNow = false;               // 易失暂停标志：由 /api/control 直接置位，实现"暂停即时生效"
let controlPending = false;          // 控制保存失败后保持停止，直到显式保存成功；不由 tick 清除
const tgBackoffs = new Map();         // bot token 指纹 -> { until, noticeAt }，不同 bot 的 429 互不污染
let configGeneration = 0;            // 配置/暂停变更时取消仍在途的旧快照
let persistedConfigSeen = false;      // 防运行中整个 data/ 消失后退化为“首次空配置”并清空去重表

function observeConfigPresence(cfg) {
  // 只有配置模块明确返回 persisted: false 才表示合法首启默认值。
  // 一个进程见过真实配置后，这个状态不得再倒退。
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
function configChanged(revision, { paused } = {}) {
  configGeneration++;
  lastCheck = Object.create(null);
  // Only a confirmed configuration save supplies its pause value. A failed
  // commit still cancels old work, but must not release a failed-control hold.
  if (typeof paused === 'boolean') {
    controlPending = false;
    pausedNow = paused;
    state.setStatus({ paused, controlPending: false });
  }
  // 对外版本来自 config.json，不能在此使用重启后归零的内存计数。
  const persisted = cfgmod.validRevision(revision) ? revision : cfgmod.getConfig().revision;
  state.setStatus({ configRevision: persisted });
}
// 供 /api/control 即时置位暂停态，无需等下一 tick 读盘
function setPaused(v, { hold = false } = {}) {
  controlPending = hold;
  pausedNow = hold || !!v;
  configGeneration++;
  state.setStatus({ paused: pausedNow, controlPending,
    ...(hold ? { running: false, lastTickAt: null } : {}) });
}

// 从日志字符串里抹掉可能被采集器/错误输出带出的凭据值
function redact(s, secrets) {
  let out = String(s == null ? '' : s);
  for (const v of [secrets.auth_token, secrets.ct0, secrets.tg_bot_token, secrets.ai_api_key,
    ...Object.values(secrets.x_sessions || {}).flatMap((entry) => [entry.auth_token, entry.ct0])]) {
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

function sourceKey(acct) {
  if (acct.source_type === 'list') return `list:${acct.list_id}`;
  if (acct.source_type === 'search') return `search:${crypto.createHash('sha256').update(acct.query).digest('hex').slice(0, 24)}`;
  return `${acct.timeline_mode === 'replies' ? 'replies:' : ''}${acct.username.toLowerCase()}`;
}
function sourceLabel(acct) {
  return acct.source_type === 'list' ? `List ${acct.list_id}`
    : acct.source_type === 'search' ? `搜索 ${acct.query.slice(0, 80)}` : `@${acct.username}`;
}
function operationFor(acct) {
  return acct.source_type === 'list' ? 'ListLatestTweetsTimeline'
    : acct.source_type === 'search' ? 'SearchTimeline'
      : acct.timeline_mode === 'replies' ? 'UserTweetsAndReplies' : 'UserTweets';
}
function ownTweet(tweet, acct) {
  return ['list', 'search'].includes(acct.source_type) || !tweet.author_username
    || tweet.author_username.toLowerCase() === acct.username.toLowerCase();
}
function catchups() { return typeof collector.getCatchups === 'function' ? collector.getCatchups() : {}; }
function getDiagnostics() {
  const cfg = cfgmod.getConfig();
  return { sessions: sessions.diagnostics(cfg, cfgmod.getSecrets()), backfills: catchups(),
    pendingCounts: Object.fromEntries(cfg.accounts.map((acct) => {
      const key = sourceKey(acct);
      return [key, delivery.get(key)?.pending.length || 0];
    })) };
}
function publishDiagnostics(cfg, secrets) {
  const pendingCounts = Object.fromEntries(cfg.accounts.map((acct) => {
    const key = sourceKey(acct);
    return [key, delivery.get(key)?.pending.length || 0];
  }));
  state.setStatus({ diagnostics: { sessions: sessions.diagnostics(cfg, secrets), backfills: catchups(), pendingCounts } });
}
async function callX(cfg, secrets, operation, invoke, { sessionId, force = false, needsProfile = false, localOnly = false } = {}) {
  if (xBusy) return { ok: false, code: 'COLLECTOR_BUSY', error: '采集器忙，请稍后重试' };
  const localSession = localOnly && configuredSessions(cfg, secrets).find((s) => s.id === sessionId && s.configured);
  const selected = localOnly
    ? localSession ? { ok: true, session: localSession } : { ok: false, code: 'AUTH_REQUIRED', error: '补采原会话已移除，请重置补采后重新核对' }
    : sessions.choose(cfg, secrets, needsProfile ? ['UserByScreenName', operation] : [operation], { sessionId, force });
  if (!selected.ok) return selected;
  xBusy = true;
  try {
    let result;
    try { result = await invoke(selected.session); }
    catch (_) { result = { ok: false, code: 'COLLECTOR_EXIT', error: '采集操作未完成，未推进水位' }; }
    if (!result || typeof result.ok !== 'boolean') result = { ok: false, code: 'COLLECTOR_PROTOCOL', error: '采集结果无效' };
    if (!localOnly) sessions.record(selected.session, operation, result);
    return { ...result, session_id: selected.session.id };
  } finally { xBusy = false; publishDiagnostics(cfg, secrets); }
}
function requestCredentials(session) {
  return { authToken: session.authToken, ct0: session.ct0, proxy: session.proxy, sessionId: session.id };
}

async function checkAccount(acct, cfg, secrets, startedAt, generation) {
  const key = sourceKey(acct);
  const label = sourceLabel(acct);
  state.setAccount(key, { checking: true });
  try {
    const record = delivery.get(key);
    const priorCheckpoint = record && (record.acquisitionWatermark ?? record.watermark);
    const destination = destinationKey(cfg, secrets);
    if (record?.pending.length && record.destination !== destination) {
      state.setAccount(key, { ok: false, lastCheck: startedAt, lastPushed: 0,
        lastError: '待发送队列绑定的 Telegram Bot / Chat ID 已变更；已保留旧队列并停止该来源。恢复原目标可继续发送' });
      return;
    }
    const heartbeat = setInterval(() => state.setStatus({ lastTickAt: Date.now() }), 15000);
    heartbeat.unref?.();
    let res;
    try {
      const pinned = catchups()[key];
      const localOnly = pinned?.status === 'ready';
      res = await callX(cfg, secrets, operationFor(acct), (session) => collector.fetchTweets({
        username: acct.username, source: acct, count: acct.fetch_count,
        ...requestCredentials(session), sinceId: priorCheckpoint || undefined, ...(localOnly ? { localOnly: true } : {}),
      }), { needsProfile: !['list', 'search'].includes(acct.source_type), sessionId: pinned?.sessionId, localOnly });
    } finally { clearInterval(heartbeat); }
    if (pausedNow || generation !== configGeneration) return;
    const newestId = res.coverage?.newestId;
    const checkpointOK = (typeof newestId === 'string' && /^\d{1,32}$/.test(newestId)
      && Array.isArray(res.tweets) && res.tweets.some((tweet) => tweet.id === newestId && ownTweet(tweet, acct)))
      || (newestId === null && res.coverage?.exhausted === true);
    const acquisitionOK = res.ok && res.coverage?.complete === true && checkpointOK
      && (res.tweets.length > 0 || res.coverage.exhausted === true)
      && (!record?.watermark || res.coverage.reachedSince === true || res.coverage.exhausted === true);
    if (!acquisitionOK) {
      if (res.code === 'COLLECTOR_BUSY') delete lastCheck[key];
      const error = res.ok ? '时间线页面不完整，未推进抓取水位' : redact(res.error || '采集未完成', secrets);
      state.log(`✗ 拉取 ${label} 失败：${error}`);
      state.setAccount(key, { ok: false, lastCheck: startedAt, lastError: error, lastPushed: 0,
        catchup: res.catchup || null, nextRetryAt: res.nextRetryAt || null });
      return;
    }
    const tweets = res.tweets;
    if (!record || !Array.isArray(record.sent)) {
      const ids = tweets.length ? tweets.map((tweet) => String(tweet.id)) : [emptyTimelineWatermark(startedAt)];
      delivery.baseline(key, ids, newestId ?? emptyTimelineWatermark(startedAt));
      collector.ackCatchup?.(key);
      state.log(tweets.length ? `${label} 首次运行，记录 ${new Set(ids).size} 条推文 ID，不推送`
        : `${label} 首次拉取为空，已记录时间水位，不推送历史推文`);
      state.setAccount(key, { lastCheck: startedAt, ok: true, lastError: null, lastPushed: 0, catchup: null });
      return;
    }
    const known = new Set([...record.sent, ...record.pending.map((t) => t.id), ...(record.dispositions || []).map((t) => t.id),
      ...(record.discoverySeen || []).map((t) => t.id)]);
    const seen = new Set();
    const fresh = tweets.filter((tweet) => {
      const id = String(tweet.id);
      if (known.has(id) || seen.has(id) || !ownTweet(tweet, acct)) return false;
      seen.add(id);
      // Search results may arrive late inside the explicit overlap window. They
      // are deduplicated by identity, not discarded solely for being below max ID.
      return acct.source_type === 'search' ? BigInt(id) > BigInt(record.discoveryFloor || '0')
        : BigInt(id) > BigInt(priorCheckpoint);
    }).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
    const accepted = [];
    const filtered = [];
    for (const tweet of fresh) {
      const reason = filterTweet(tweet, acct.filters);
      if (reason) filtered.push({ id: tweet.id, reason });
      else accepted.push(tweet);
    }
    const nextCheckpoint = newestId !== null && BigInt(newestId) > BigInt(priorCheckpoint) ? newestId : priorCheckpoint;
    try {
      delivery.capture(key, accepted, destination, null, nextCheckpoint, { filtered, ruleVersion: ruleVersion(acct.filters) });
      collector.ackCatchup?.(key);
    } catch (error) {
      if (error.code !== 'OUTBOX_FULL') throw error;
      state.log(`✗ ${label} ${error.message}`);
      state.setAccount(key, { lastCheck: startedAt, ok: false, lastError: error.message, lastPushed: 0 });
      return;
    }
    state.setAccount(key, { lastCheck: startedAt, ok: !record.gap,
      lastError: gapMessage(record.gap), lastPushed: 0, filtered: filtered.length, catchup: null, nextRetryAt: null });
    if (!fresh.length && !record.pending.length) state.log(`${label} 无新推文`);
  } finally {
    if (state.getStatus().accounts[key]?.checking) state.setAccount(key, { checking: false });
  }
}

async function enrichForDelivery(tweet, cfg, secrets, generation) {
  if (!cfg.enrichment_mode || cfg.enrichment_mode === 'off' || !collector.inspectTweet || xBusy) return tweet;
  const result = await callX(cfg, secrets, 'TweetDetail', (session) => collector.inspectTweet({
    id: tweet.id,
    kind: cfg.enrichment_mode, limit: cfg.enrichment_limit || 2, ...requestCredentials(session),
  }));
  if (generation !== configGeneration || pausedNow || !result.ok || !Array.isArray(result.tweets)) return tweet;
  const detail = result.tweets.find((t) => t.id === tweet.id);
  // Enrichment is presentation-only. Never replace captured identity/body or
  // relationship evidence with a second observation taken at another time.
  const enriched = { ...tweet };
  try { enriched.content = mergeTweetContent(tweet.content, detail?.content); }
  catch (_) { /* conflicting later observations do not replace captured evidence */ }
  if (cfg.enrichment_mode === 'thread') {
    const clip = (text) => {
      let value = String(text || '').slice(0, 12000);
      if (/[\uD800-\uDBFF]$/.test(value)) value = value.slice(0, -1);
      return value;
    };
    try { enriched.content = normalizeTweetContent({ ...(enriched.content || {}),
      thread: result.tweets.filter((t) => t.id !== tweet.id).slice(0, cfg.enrichment_limit || 2).map((t) => ({
        id: t.id, text: clip(t.text), url: t.url, ...(t.author_username ? { author_username: t.author_username } : {}),
        ...(t.lang ? { lang: t.lang } : {}),
      })),
    }); } catch (_) { /* optional background never blocks the captured post */ }
  }
  return enriched;
}

async function deliverOne(acct, cfg, secrets, generation) {
  const key = sourceKey(acct);
  const label = sourceLabel(acct);
  const record = delivery.get(key);
  if (!record?.pending.length) return 'empty';
  if (record.destination !== destinationKey(cfg, secrets)) return 'blocked';
  if (pausedNow || generation !== configGeneration) return 'blocked';
  if (!delivery.ready()) throw new Error('待发送队列仍有未落盘事务，已停止推送');
  if (backoffActive(secrets.tg_bot_token)) return 'blocked';
  const tweet = record.pending[0];
  let plan = tweet.delivery;
  if (!plan) {
    const presentation = await enrichForDelivery(tweet, cfg, secrets, generation);
    if (pausedNow || generation !== configGeneration) return 'blocked';
    let translatedText = '';
    if (cfg.ai_translation_enabled === true) {
      const heartbeat = setInterval(() => state.setStatus({ lastTickAt: Date.now() }), 5000);
      heartbeat.unref?.();
      let translated;
      try { translated = await translation.translateTweet(presentation, cfg, secrets); }
      catch (_) { translated = { ok: false }; }
      finally { clearInterval(heartbeat); }
      if (pausedNow || generation !== configGeneration) return 'blocked';
      if (translated?.ok && typeof translated.text === 'string' && translated.text.trim()) translatedText = translated.text;
      else if (!translated?.skipped) state.log(`⚠ ${label}: ${tweet.id} AI 翻译未完成，本条使用原文推送`);
    }
    if (pausedNow || generation !== configGeneration) return 'blocked';
    const author = tweet.author_username || acct.username || label;
    const parts = typeof tg.planTweet === 'function'
      ? tg.planTweet(presentation, author, translatedText, { media_mode: cfg.media_mode || 'links' })
      : [{ kind: 'text', text: tg.formatTweet(presentation, author, translatedText) }];
    plan = delivery.prepareDelivery ? delivery.prepareDelivery(key, tweet.id, parts) : { parts, next: 0 };
  }
  for (let index = plan.next; index < plan.parts.length; index++) {
    let sent = false;
    let sendError = '发送失败';
    for (let attempt = 0; attempt < 3; attempt++) {
      if (pausedNow || generation !== configGeneration || backoffActive(secrets.tg_bot_token)) return 'blocked';
      if (!delivery.ready()) throw new Error('待发送队列仍有未落盘事务，已停止推送');
      const response = typeof tg.sendTweetPart === 'function'
        ? await tg.sendTweetPart({ botToken: secrets.tg_bot_token, chatId: cfg.tg_chat_id, part: plan.parts[index] })
        : await tg.sendMessage({ botToken: secrets.tg_bot_token, chatId: cfg.tg_chat_id, text: plan.parts[index].text });
      if (response.ok) {
        // Confirm an in-flight successful request even if pause/config changed
        // during the await; never repeat a confirmed part on the next attempt.
        delivery.acknowledgePart?.(key, tweet.id, index);
        sent = true;
        break;
      }
      sendError = redact(response.description || '发送失败', secrets);
      if (response.rateLimited) {
        const wait = setTelegramBackoff(secrets.tg_bot_token, response.retryAfter);
        sendError = `Telegram 限流，推送顺延 ${Math.round(wait / 1000)}s`;
        state.log(`⏸ ${sendError}`);
        break;
      }
      if (pausedNow || generation !== configGeneration || response.permanent || attempt === 2) break;
      if (backoffActive(secrets.tg_bot_token)) break;
      state.log(`↻ 重试 ${label}: ${tweet.id}（2s 后）`);
      await sleep(2000);
    }
    if (!sent) {
      state.log(`✗ 推送失败 ${label}: ${tweet.id}（${sendError}）`);
      if (!pausedNow && generation === configGeneration) state.setAccount(key, { ok: false, lastError: `Telegram 推送失败：${sendError}` });
      return 'blocked';
    }
  }
  delivery.acknowledge(key, tweet.id, []);
  if (!pausedNow && generation === configGeneration) {
    state.addPush(key, tweet);
    state.setAccount(key, { lastPushed: (state.getStatus().accounts[key]?.lastPushed || 0) + 1 });
  }
  state.log(`✓ 推送 ${label}: ${tweet.id}`);
  await sleep(500);
  return 'sent';
}

function launchDelivery(cfg, secrets, generation) {
  if (deliveryFlight || pausedNow || runtime.blocked('delivery')) return deliveryFlight;
  const accounts = cfg.accounts;
  const start = deliveryOffset++ % Math.max(1, accounts.length);
  const ordered = accounts.slice(start).concat(accounts.slice(0, start));
  const counts = new Map();
  const stopped = new Set();
  deliveryFlight = (async () => {
    for (let round = 0; round < MAX_DELIVERIES_PER_CHECK; round++) {
      let progress = false;
      for (const acct of ordered) {
        if (pausedNow || generation !== configGeneration) return;
        const key = sourceKey(acct);
        if (stopped.has(key)) continue;
        let result;
        try { result = await deliverOne(acct, cfg, secrets, generation); }
        catch (error) {
          if (!pausedNow && generation === configGeneration) state.setAccount(key, {
            ok: false, lastError: redact(error.message || '投递状态保存失败', secrets),
          });
          throw error;
        }
        if (result === 'sent') { progress = true; counts.set(key, (counts.get(key) || 0) + 1); }
        else if (result === 'blocked') stopped.add(key);
      }
      if (!progress) break;
    }
  })().catch((error) => {
    state.log(`投递调度异常：${redact(error.message || '队列状态异常', secrets)}`);
    if (!delivery.ready()) state.setStatus({ running: false, lastTickAt: null });
  }).finally(() => {
    for (const [key, n] of counts) state.pushHistory(key, n);
    deliveryFlight = null;
  });
  return deliveryFlight;
}

async function tick({ waitForDelivery = true } = {}) {
  const blocked = runtime.blocked('scheduling');
  if (blocked) { state.setStatus({ running: false, lastTickAt: null, runtime: runtime.status() }); return; }
  if (controlPending) { state.setStatus({ running: false, lastTickAt: null, paused: true, controlPending: true }); return; }
  if (tickBusy) return;
  tickBusy = true;
  try {
    let cfg;
    let secrets;
    try {
      cfg = cfgmod.getConfig();
      observeConfigPresence(cfg);
      secrets = cfgmod.getSecrets();
      delivery.flush();
      if (cfg.persisted !== false) {
        // An old delivery may still be acknowledging an in-flight send. Defer
        // removal until it has finished; generation cancellation blocks new IO.
        if (!deliveryFlight) {
          const activeKeys = new Set(cfg.accounts.map(sourceKey));
          delivery.prune(activeKeys);
          if (!xBusy) collector.pruneCatchups?.(activeKeys);
        }
        delivery.initialize();
      }
    } catch (error) { state.setStatus({ running: false, lastTickAt: null }); throw error; }
    state.setStatus({ running: true, lastTickAt: Date.now(), configRevision: cfg.revision });
    const generation = configGeneration;
    pausedNow = !!cfg.paused;
    state.setStatus({ paused: pausedNow });
    const active = cfg.accounts.map(sourceKey);
    const activeSet = new Set(active);
    for (const key of Object.keys(lastCheck)) if (!activeSet.has(key)) delete lastCheck[key];
    state.pruneAccounts(active);
    if (!pausedNow) {
      const now = Date.now();
      const due = cfg.accounts.filter((acct) => {
        const previous = lastCheck[sourceKey(acct)];
        return previous == null || now < previous || now - previous >= acct.check_interval * 1000;
      });
      for (const acct of due) {
        if (pausedNow || generation !== configGeneration) break;
        const key = sourceKey(acct);
        const startedAt = Date.now();
        lastCheck[key] = startedAt;
        try { await checkAccount(acct, cfg, secrets, startedAt, generation); }
        catch (error) {
          const detail = redact(error.message || '采集异常', secrets);
          state.log(`检查 ${sourceLabel(acct)} 异常：${detail}`);
          if (!pausedNow && generation === configGeneration) state.setAccount(key, { checking: false, ok: false, lastCheck: startedAt, lastError: detail });
        }
        if (generation !== configGeneration) delete lastCheck[key];
        if (!pausedNow && generation === configGeneration && (!cfg.enrichment_mode || cfg.enrichment_mode === 'off')) {
          launchDelivery(cfg, secrets, generation);
        }
      }
      if (!pausedNow && generation === configGeneration) launchDelivery(cfg, secrets, generation);
      if (waitForDelivery && deliveryFlight) await deliveryFlight;
    }
    publishDiagnostics(cfg, secrets);
    state.setStatus(delivery.ready() ? { lastTickAt: Date.now() } : { running: false, lastTickAt: null });
  } finally { tickBusy = false; }
}

async function loop() {
  try { await tick({ waitForDelivery: false }); }
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
async function testCollector(requested) {
  const blocked = runtime.blocked('collection');
  if (blocked) return blocked;
  const cfg = cfgmod.getConfig();
  const secrets = cfgmod.getSecrets();
  const name = typeof requested === 'string' ? requested.trim().replace(/^@/, '') : '';
  const acct = cfg.accounts.find((a) => sourceKey(a) === name.toLowerCase() || a.username?.toLowerCase() === name.toLowerCase())
    || (!name ? cfg.accounts[0] : null) || { username: name || 'elonmusk' };
  const res = await callX(cfg, secrets, operationFor(acct), (session) => collector.fetchTweets({
    source: acct, username: acct.username, count: 1, catchup: false, ...requestCredentials(session),
  }), { needsProfile: !['list', 'search'].includes(acct.source_type), force: true });
  if (!res.ok) return { ok: false, code: res.code || 'COLLECTION_FAILED', message: redact(res.error || '拉取失败', secrets) };
  if (!res.coverage?.complete || (!res.tweets.length && !res.coverage.exhausted)) {
    return { ok: false, code: 'INCOMPLETE_COVERAGE', message: '时间线页面不完整，未保存检查点' };
  }
  const tweets = res.tweets.filter((t) => ownTweet(t, acct));
  const latest = tweets.reduce((a, b) => !a || BigInt(b.id) > BigInt(a.id) ? b : a, null);
  return { ok: true, collector: runtime.status().collector, count: tweets.length, coverage: res.coverage,
    message: latest ? `拉取 ${sourceLabel(acct)} 成功，最新推文：${(latest.text || '').slice(0, 80)}` : `${sourceLabel(acct)} 无推文，但连接正常` };
}
async function testSession(sessionId, username) {
  const blocked = runtime.blocked('collection');
  if (blocked) return blocked;
  const cfg = cfgmod.getConfig();
  const secrets = cfgmod.getSecrets();
  const user = username || cfg.accounts.find((a) => a.username)?.username || 'elonmusk';
  if (typeof user !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(user)) return { ok: false, code: 'INVALID_INPUT', message: '用户名无效' };
  const result = await callX(cfg, secrets, 'UserTweets', (session) => collector.fetchTweets({
    username: user, count: 1, catchup: false, ...requestCredentials(session),
  }), { sessionId, force: true, needsProfile: true });
  return { ok: result.ok, code: result.code, message: result.ok ? 'X 会话真实采集验证成功' : redact(result.error || '验证失败', secrets),
    diagnostics: sessions.diagnostics(cfg, secrets) };
}
async function inspectTweet(id, kind = 'detail') {
  const blocked = runtime.blocked('collection');
  if (blocked) return blocked;
  if (!/^\d{1,32}$/.test(id) || !['detail', 'thread'].includes(kind)) return { ok: false, error: '推文 ID 或查看类型无效' };
  const cfg = cfgmod.getConfig();
  return callX(cfg, cfgmod.getSecrets(), 'TweetDetail', (session) => collector.inspectTweet({ id, kind,
    limit: cfg.enrichment_limit || 2, ...requestCredentials(session) }));
}
async function listMembers(listId) {
  const blocked = runtime.blocked('collection');
  if (blocked) return blocked;
  if (typeof listId !== 'string' || !/^\d{1,32}$/.test(listId)) return { ok: false, error: 'List ID 无效' };
  const cfg = cfgmod.getConfig();
  return callX(cfg, cfgmod.getSecrets(), 'ListMembers', (session) => collector.listMembers({ listId, ...requestCredentials(session) }));
}
function resetCatchup(key) {
  const blocked = runtime.blocked('collection');
  if (blocked) return blocked;
  const cfg = cfgmod.getConfig();
  if (typeof key !== 'string' || !cfg.accounts.some((acct) => sourceKey(acct) === key)) {
    return { ok: false, code: 'INVALID_INPUT', error: '补采来源不存在' };
  }
  if (xBusy) return { ok: false, code: 'COLLECTOR_BUSY', error: '采集正在进行，请结束后重试' };
  const result = collector.resetCatchup(key);
  if (result?.ok === false) return result;
  delete lastCheck[key];
  publishDiagnostics(cfg, cfgmod.getSecrets());
  return { ok: true, message: '补采过程已重置，旧采集检查点和待发队列已保留，下轮从最新页重新核对缺口' };
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
module.exports = { start, tick, setPaused, configChanged, testCollector, testTelegram, testSession, inspectTweet, listMembers, resetCatchup, getDiagnostics, sourceKey };
