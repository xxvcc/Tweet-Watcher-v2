'use strict';
// Tweet Watcher —— 单进程：既是网页面板，又是监控 worker。
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const express = require('express');
const proxyAddr = require('proxy-addr');
// Snapshot of https://www.cloudflare.com/ips-v4 and /ips-v6, reviewed with the
// deployment realip list. Never fetch or widen this trust boundary at runtime.
const cloudflareAddress = proxyAddr.compile(require('./lib/cloudflare-ranges.json'));
const cfgmod = require('./lib/config');
const store = require('./lib/store');
const auth = require('./lib/auth');
function collector() { return require(runtime.status().mode === 'legacy-live' ? './lib/bird' : './lib/twscrape'); }
const state = require('./lib/state');
const worker = require('./lib/worker');
const runtime = require('./lib/runtime');

const PORT = process.env.PORT || 8788;
const HOST = process.env.HOST || '127.0.0.1';
// 独立管理域名部署时固定浏览器来源。省略时保留本地开发和子路径代理兼容性。
function parsePublicOrigin(value) {
  if (value === undefined || value === '') return null;
  let parsed;
  try { parsed = new URL(value); } catch (_) { throw new Error('PUBLIC_ORIGIN 必须为完整的 HTTP(S) 来源'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.origin !== value) {
    throw new Error('PUBLIC_ORIGIN 必须仅包含协议、主机和可选端口，不能包含路径或凭据');
  }
  return parsed;
}
const PUBLIC_URL = parsePublicOrigin(process.env.PUBLIC_ORIGIN);
const PUBLIC_ORIGIN = PUBLIC_URL ? PUBLIC_URL.origin : '';
const HOST_COOKIES = !!PUBLIC_URL && PUBLIC_URL.protocol === 'https:';
const SESSION_COOKIE = HOST_COOKIES ? '__Host-tw_sess' : 'tw_sess';
const CSRF_COOKIE = HOST_COOKIES ? '__Host-tw_csrf' : 'tw_csrf';

const app = express();
app.disable('x-powered-by');
// Express 的 loopback trust proxy 仍允许同机任意进程直连端口并伪造 XFF。只有同时来自
// 回环地址且携带 Nginx 注入的私密令牌时，才采信转发 IP/协议。
app.set('trust proxy', false);
const TRUST_PROXY_TOKEN = typeof process.env.TRUST_PROXY_TOKEN === 'string'
  ? process.env.TRUST_PROXY_TOKEN : '';
if (TRUST_PROXY_TOKEN && (Buffer.byteLength(TRUST_PROXY_TOKEN, 'utf8') < 32
  || Buffer.byteLength(TRUST_PROXY_TOKEN, 'utf8') > 256 || TRUST_PROXY_TOKEN.includes('\0'))) {
  throw new Error('TRUST_PROXY_TOKEN 必须为 32-256 字节且不能包含 NUL');
}
function normalizeIp(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.startsWith('::ffff:') && net.isIP(raw.slice(7)) === 4) return raw.slice(7);
  return raw;
}
function loopbackIp(value) {
  const ip = normalizeIp(value);
  return ip === '::1' || (net.isIP(ip) === 4 && ip.startsWith('127.'));
}
function tokenMatches(actual, expected) {
  if (!expected || typeof actual !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function requestOrigin(req, expectedToken = TRUST_PROXY_TOKEN) {
  const remoteIp = normalizeIp(req && req.socket && req.socket.remoteAddress) || 'unknown';
  const headers = req && req.headers ? req.headers : {};
  const trustedProxy = loopbackIp(remoteIp)
    && tokenMatches(headers['x-tweet-watcher-proxy-token'], expectedToken);
  let clientIp = remoteIp;
  let secure = !!(req && req.socket && req.socket.encrypted);
  if (trustedProxy) {
    const xff = typeof headers['x-forwarded-for'] === 'string' ? headers['x-forwarded-for'] : '';
    const forwardedIp = normalizeIp(xff.split(',').pop());
    if (net.isIP(forwardedIp)) {
      clientIp = forwardedIp;
      // Nginx appends its transport peer as the last XFF hop. Only a validated
      // Cloudflare peer may supply this visitor header; an arbitrary client or
      // same-machine process cannot opt into it by forging the header alone.
      const cloudflareVisitor = normalizeIp(headers['cf-connecting-ip']);
      if (cloudflareAddress(forwardedIp) && net.isIP(cloudflareVisitor)) clientIp = cloudflareVisitor;
    }
    secure = typeof headers['x-forwarded-proto'] === 'string'
      && headers['x-forwarded-proto'].trim().toLowerCase() === 'https';
  }
  return { clientIp, secure, trustedProxy };
}
app.use((req, res, next) => {
  const origin = requestOrigin(req);
  req.twClientIp = origin.clientIp;
  req.twSecure = origin.secure;
  next();
});

// —— 统一安全响应头 ——
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  // 脚本与样式均严格同源，无 unsafe-inline（index.html 已无内联 style 属性）。
  // 注意 app.js 里的 el.style.x = … 属 CSSOM 写入，不受 style-src 约束。
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
  next();
});

// API 响应一律不缓存，包括来源校验失败的响应。
app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.use((req, res, next) => {
  if (!PUBLIC_URL) return next();
  // 不信任 X-Forwarded-Host；Nginx 必须向后端传递固定的面板 Host。
  if (typeof req.headers.host !== 'string' || req.headers.host.toLowerCase() !== PUBLIC_URL.host) {
    return res.status(421).json({ ok: false, error: '访问来源不匹配' });
  }
  if (HOST_COOKIES && !req.twSecure) return res.status(403).json({ ok: false, error: '请使用 HTTPS 访问' });
  // 同站子域之间 SameSite Cookie 仍可发送，必须再校验完整 Origin（包含登录和首次设置）。
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== PUBLIC_ORIGIN) {
    return res.status(403).json({ ok: false, error: '请求来源不匹配' });
  }
  next();
});

// 请求体只接受 JSON：前端全部走 JSON，urlencoded 无消费者，去掉可缩小攻击面
app.use(express.json({ limit: '256kb' }));

// —— cookie 解析（无第三方依赖）——
app.use((req, res, next) => {
  req.cookies = Object.create(null);
  const h = req.headers.cookie;
  if (h) for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) {
      const k = part.slice(0, i).trim();
      let v = part.slice(i + 1).trim();
      try { v = decodeURIComponent(v); } catch (_) { /* 畸形百分号编码：保留原值，不让单个坏 Cookie 使整请求 500 */ }
      req.cookies[k] = v;
    }
  }
  next();
});

// async 路由包装：把 rejected promise 交给统一错误中间件，避免 Express4 下请求永久挂起
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// 只使用经过代理令牌认证的协议，直接读取 X-Forwarded-Proto 会允许本机伪造。
function cookieSecure(req) { return !!req.twSecure; }
function validSession(req) { return auth.verifySession(req.cookies[SESSION_COOKIE], PUBLIC_ORIGIN); }
function validCsrf(req) { return auth.checkCsrf(req.cookies[CSRF_COOKIE], req.headers['x-csrf']); }
function clearAuthCookies(req, res) {
  const options = { path: '/', secure: HOST_COOKIES || cookieSecure(req), sameSite: 'lax' };
  res.clearCookie(SESSION_COOKIE, { ...options, httpOnly: true });
  res.clearCookie(CSRF_COOKIE, options);
  if (HOST_COOKIES) {
    res.clearCookie('tw_sess', { path: '/' });
    res.clearCookie('tw_csrf', { path: '/' });
  }
}
function setAuthCookies(req, res) {
  const secure = HOST_COOKIES || cookieSecure(req);
  const maxAge = 7 * 24 * 3600 * 1000;
  if (HOST_COOKIES) {
    res.clearCookie('tw_sess', { path: '/' });
    res.clearCookie('tw_csrf', { path: '/' });
  }
  res.cookie(SESSION_COOKIE, auth.makeSession(PUBLIC_ORIGIN), { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge });
  res.cookie(CSRF_COOKIE, auth.makeCsrf(), { httpOnly: false, sameSite: 'lax', secure, path: '/', maxAge });
}
function requireAuth(req, res, next) {
  if (auth.hasPassword() && validSession(req)) return next();
  res.status(401).json({ ok: false, error: '未登录' });
}
function requireCsrf(req, res, next) {
  if (validCsrf(req)) return next();
  res.status(403).json({ ok: false, error: 'CSRF 校验失败' });
}

// —— 首次设置令牌：无密码时于启动打印，/api/setup 须携带它，杜绝无认证首次抢注(TOFU) ——
let setupToken = null;
let setupInFlight = false;
function refreshSetupToken() {
  if (!auth.hasPassword()) {
    if (!setupToken) {
      // 密码重置流程会删除 password.json；先持久化吊销旧 Cookie，防旧会话读取日志中的新 setup token。
      // 写盘失败必须向上抛出并由致命错误处理退出，不能在恢复窗口 fail-open。
      auth.bumpEpoch();
      setupToken = crypto.randomBytes(24).toString('hex');
      state.log(`⚙ 首次设置令牌（用于 /api/setup，仅本进程有效）：${setupToken}`);
    }
  } else {
    setupToken = null;
  }
}
function checkSetupToken(v) {
  if (!setupToken || !v) return false;
  try {
    const a = Buffer.from(String(v)), b = Buffer.from(setupToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) { return false; }
}

// —— 登录限流（内存，按 IP）——
const loginFails = new Map();
const LOGIN_MAX_ENTRIES = 5000;
function pruneLoginFails(now) {
  for (const [k, r] of loginFails) if (now - r.last > 3600e3) loginFails.delete(k); // 每次写入惰性回收过期项
  if (loginFails.size > LOGIN_MAX_ENTRIES) { // 硬上限：仍超限则淘汰最旧，杜绝无界增长
    const sorted = [...loginFails.entries()].sort((a, b) => a[1].last - b[1].last);
    for (let i = 0; i < sorted.length && loginFails.size > LOGIN_MAX_ENTRIES; i++) loginFails.delete(sorted[i][0]);
  }
}
function loginBlockedMinutes(ip) {
  const r = loginFails.get(ip);
  if (!r || r.count < 5) return null;
  const lock = r.count >= 20 ? 3600e3 : r.count >= 10 ? 1800e3 : 300e3;
  const rem = lock - (Date.now() - r.last);
  // 锁定期满只放行下一次尝试，不清零 count——否则被锁时 recordFail 不执行、解锁又删表，
  // count 恒不超过 5，10 次/20 次的升级档位永远不可达。
  // 计数由这两条路径清除：登录成功（delete）、或 1 小时无新失败（pruneLoginFails 惰性回收）。
  if (rem <= 0) return null;
  return Math.ceil(rem / 60000);
}
function recordFail(ip) {
  const now = Date.now();
  pruneLoginFails(now);
  const r = loginFails.get(ip) || { count: 0, last: 0 };
  r.count++; r.last = now; loginFails.set(ip, r);
}

// ===== 认证相关 =====
let passwordChangeInFlight = false;
app.get('/api/session', (req, res) => {
  const hasPassword = auth.hasPassword();
  res.json({ hasPassword, authed: hasPassword && validSession(req) });
});
app.post('/api/setup', wrap(async (req, res) => {
  if (auth.hasPassword()) return res.status(400).json({ ok: false, error: '已设置过密码' });
  const token = (req.body && req.body.setup_token) || req.headers['x-setup-token'] || '';
  if (!checkSetupToken(token)) return res.status(403).json({ ok: false, error: '首次设置令牌无效，请查看服务端日志获取' });
  const pw = req.body && typeof req.body.password === 'string' ? req.body.password : '';
  const invalid = auth.passwordError(pw);
  if (invalid) return res.status(400).json({ ok: false, error: invalid });
  // bcrypt 会让出事件循环；必须在 await 前抢占单飞锁，防两个 setup 同时通过检查并互相覆盖密码。
  if (setupInFlight) return res.status(409).json({ ok: false, error: '首次设置正在进行，请稍候' });
  setupInFlight = true;
  try {
    await auth.setPassword(pw);
    setupToken = null;
    setAuthCookies(req, res);
    res.json({ ok: true });
  } finally { setupInFlight = false; }
}));
let loginChecksInFlight = 0;
const LOGIN_MAX_IN_FLIGHT = 4;
app.post('/api/login', wrap(async (req, res) => {
  const ip = req.twClientIp || 'unknown';
  const blk = loginBlockedMinutes(ip);
  if (blk) return res.status(429).json({ ok: false, error: `尝试过多，请 ${blk} 分钟后再试` });
  if (loginChecksInFlight >= LOGIN_MAX_IN_FLIGHT) {
    res.setHeader('Retry-After', '2');
    return res.status(503).json({ ok: false, error: '登录服务繁忙，请稍后重试' });
  }
  if (passwordChangeInFlight) {
    res.setHeader('Retry-After', '2');
    return res.status(503).json({ ok: false, error: '密码正在修改，请稍后重试' });
  }
  const pw = req.body && typeof req.body.password === 'string' ? req.body.password : '';
  const loginEpoch = auth.sessionEpoch();
  // 先同步记账再校验：与闸门判定处于同一同步临界区（其间无 await），杜绝"并发请求在自增前全部放行"的绕过
  recordFail(ip);
  loginChecksInFlight++;
  try {
    if (await auth.verifyPassword(pw)) {
      loginFails.delete(ip);
      // bcrypt 比较期间可能发生全局登出或改密。不得用新的 epoch 给旧校验结果补签会话。
      if (passwordChangeInFlight || auth.sessionEpoch() !== loginEpoch) {
        return res.status(409).json({ ok: false, error: '认证状态已变化，请重试' });
      }
      setAuthCookies(req, res);
      return res.json({ ok: true });
    }
    await new Promise((r) => setTimeout(r, 1000));
    res.status(401).json({ ok: false, error: '密码错误' });
  } finally { loginChecksInFlight--; }
}));
app.post('/api/logout', (req, res) => {
  // 仅在持有有效会话 + CSRF 时才全局吊销(bumpEpoch)，否则任意未认证请求可借此制造全局登出 DoS。
  // 无论是否认证都清掉本请求的 Cookie（即便会话已过期也能正常登出）。
  if (validSession(req) && validCsrf(req)) {
    auth.bumpEpoch();
  }
  clearAuthCookies(req, res);
  res.json({ ok: true });
});
app.post('/api/password', requireAuth, requireCsrf, wrap(async (req, res) => {
  if (passwordChangeInFlight) return res.status(409).json({ ok: false, error: '另一次改密正在进行，请稍候' });
  passwordChangeInFlight = true;
  try {
    const { old_password, new_password } = req.body || {};
    const oldPassword = typeof old_password === 'string' ? old_password : '';
    const passwordEpoch = auth.sessionEpoch();
    if (!(await auth.verifyPassword(oldPassword))) return res.status(400).json({ ok: false, error: '当前密码错误' });
    // bcrypt 校验期间可能有另一个标签页登出并吊销当前会话。不能让这个旧授权结果
    // 随后改写密码并取得新会话，否则全局登出的安全边界会被在途请求绕过。
    if (auth.sessionEpoch() !== passwordEpoch) {
      return res.status(409).json({ ok: false, error: '认证状态已变化，请重新登录' });
    }
    const nextPassword = typeof new_password === 'string' ? new_password : '';
    const invalid = auth.passwordError(nextPassword);
    if (invalid) return res.status(400).json({ ok: false, error: `新${invalid}` });
    // 哈希期间旧会话仍保持可验证，使另一标签页的全局登出能够推进 epoch；哈希完成后
    // 再核对一次，随后同步执行 bump + 写盘，中间没有 await，其他请求无法穿插。
    const nextHash = await auth.hashPassword(nextPassword);
    if (auth.sessionEpoch() !== passwordEpoch) {
      return res.status(409).json({ ok: false, error: '认证状态已变化，请重新登录' });
    }
    // 若写盘失败，旧密码仍可重新登录，但 bump 已确保持有旧 Cookie 的会话不会复活。
    auth.bumpEpoch();
    auth.savePasswordHash(nextHash);
    setAuthCookies(req, res);  // 给当前用户换发新会话，避免被自己登出
    res.json({ ok: true });
  } finally { passwordChangeInFlight = false; }
}));

// ===== 配置 =====
app.get('/api/config', requireAuth, (req, res) => {
  const cfg = cfgmod.getConfig();
  const s = cfgmod.getSecrets();
  res.json({
    bird_path: cfg.bird_path, tg_chat_id: cfg.tg_chat_id, accounts: cfg.accounts,
    collector: { name: runtime.status().collector, fixed: true },
    runtime: runtime.status(), configRevision: cfg.revision,
    secrets: { hasAuthToken: !!s.auth_token, hasCt0: !!s.ct0, hasTgBotToken: !!s.tg_bot_token },
  });
});
app.post('/api/config', requireAuth, requireCsrf, (req, res) => {
  const b = req.body || {};
  const cur = cfgmod.getConfig();
  const currentRevision = cur.revision;
  // 必须带上实际编辑的版本；若允许省略，旧标签页/旧 API 客户端仍可绕过乐观锁。
  if (b.config_revision === undefined) {
    return res.status(428).json({ ok: false, error: '缺少配置版本，请重新载入后再保存' });
  }
  if (!cfgmod.validRevision(b.config_revision)) {
    return res.status(400).json({ ok: false, error: '配置版本无效' });
  }
  if (b.config_revision !== currentRevision) {
    return res.status(409).json({ ok: false, error: '配置已被其他页面修改，请重新载入后再保存' });
  }
  const warnings = [];
  // 与 bird_path / tg_chat_id 一致的局部更新语义：字段缺省即保留原值。
  // 否则一个只改 tg_chat_id 的请求会把 accounts 静默清空。
  let accounts = cur.accounts;
  if (b.accounts !== undefined) {
    if (!Array.isArray(b.accounts)) {
      warnings.push('accounts 必须是数组，已保留原值');
    } else {
      accounts = cfgmod.normalizeAccounts(b.accounts);
      if (accounts.length < b.accounts.length) {
        warnings.push(`部分账号被忽略（非法用户名/重复/超出上限 ${cfgmod.LIMITS.MAX_ACCOUNTS}）`);
      }
    }
  }
  let bird_path = cur.bird_path;
  if (typeof b.bird_path === 'string' && b.bird_path.trim()) {
    const bp = b.bird_path.trim();
    if (cfgmod.validBirdPath(bp)) bird_path = bp;
    else warnings.push('bird 路径固定为随应用部署的可信执行器，已保留原值');
  }
  let tg_chat_id = cur.tg_chat_id;
  if (b.tg_chat_id !== undefined) {
    const validType = typeof b.tg_chat_id === 'string' || typeof b.tg_chat_id === 'number';
    const v = validType ? String(b.tg_chat_id).trim() : '';
    const valueToValidate = typeof b.tg_chat_id === 'string' ? v : b.tg_chat_id;
    // 数字必须在转为字符串前校验，否则超出安全整数范围的 JSON 数字已发生精度丢失，
    // String(...) 会把它伪装成一个格式合法但可能错误的 Chat ID。
    if (validType && cfgmod.validChatId(valueToValidate)) tg_chat_id = v;
    else warnings.push('Telegram Chat ID 非法（须为整数），已保留原值');
  }
  const sec = cfgmod.getSecrets();
  const ns = { ...sec };
  const updateSecret = (key, label) => {
    if (typeof b[key] !== 'string' || !b[key].trim()) return;
    const value = b[key].trim();
    if (Buffer.byteLength(value, 'utf8') > 4096) warnings.push(`${label} 过长，已保留原值`);
    else ns[key] = value;
  };
  updateSecret('auth_token', 'auth_token');
  updateSecret('ct0', 'ct0');
  updateSecret('tg_bot_token', 'Telegram Bot Token');
  const nextRevision = cfgmod.nextRevision(currentRevision);
  const nextConfig = { bird_path, tg_chat_id, paused: cur.paused, accounts, revision: nextRevision };
  cfgmod.saveConfig(nextConfig);
  try {
    cfgmod.saveSecrets(ns);
  } catch (e) {
    // secrets 的原子写失败时旧文件仍在；把先写入的普通配置回滚，避免一次请求只提交一半。
    let rollbackError = null;
    try {
      // 首次保存前 config.json 不存在。此时写回默认对象会把“未配置”错误地变成
      // “已持久化的空配置”，并令 worker 清掉受支持的 sent_ids-only 迁移数据。
      if (cur.persisted === false) store.removeJSON('config.json');
      else cfgmod.saveConfig(cur);
    } catch (re) { rollbackError = re; }
    let effectiveRevision = currentRevision;
    if (rollbackError) {
      effectiveRevision = nextRevision;
      // 原子写语义下通常仍是前一份有效文件；若连读取也失败，保留已知的新版本并继续回传 partial 警告。
      try { effectiveRevision = cfgmod.getConfig().revision; } catch (_) {}
    }
    worker.configChanged(effectiveRevision);
    if (rollbackError) {
      state.log('配置保存失败且回滚失败：普通配置可能已更新，敏感配置保持原值');
      return res.status(500).json({ ok: false, partial: true, error: '配置仅部分保存，请重新载入核对' });
    }
    state.log('敏感配置保存失败，普通配置已回滚');
    return res.status(500).json({ ok: false, error: '配置保存失败，已回滚' });
  }
  // worker 的 generation 负责取消旧任务；对外版本必须使用已落盘值。
  worker.configChanged(nextRevision);
  // 回传服务端最终采用的值，便于前端核对被静默保留的字段
  res.json({ ok: true, accounts, bird_path, tg_chat_id, warnings });
});

// ===== 状态 / 日志 / 控制 / 测试 =====
app.get('/api/status', requireAuth, (req, res) => {
  const cfg = cfgmod.getConfig();
  const st = state.getStatus();
  const heartbeatAge = st.lastTickAt == null ? NaN : Date.now() - st.lastTickAt;
  const healthy = st.running && Number.isFinite(heartbeatAge) && heartbeatAge >= 0 && heartbeatAge < 60000;
  res.json({ status: st, paused: cfg.paused, accounts: cfg.accounts, healthy, runtime: runtime.status() });
});
app.get('/api/logs', requireAuth, (req, res) => { res.json({ logs: state.getLogs(200) }); });

app.post('/api/control', requireAuth, requireCsrf, (req, res) => {
  const action = req.body && req.body.action;
  const cfg = cfgmod.getConfig();
  if (action === 'pause') cfg.paused = true;
  else if (action === 'resume') cfg.paused = false;
  else return res.status(400).json({ ok: false, error: '未知操作' });
  cfgmod.saveConfig(cfg);
  worker.setPaused(cfg.paused); // 即时生效，不必等下一 tick 读盘
  state.setStatus({ paused: cfg.paused });
  const blocked = runtime.blocked('scheduling');
  state.log(blocked ? `${blocked.message}；暂停设置已保存` : (cfg.paused ? '监控已暂停' : '监控已恢复'));
  res.json({ ok: true, paused: cfg.paused, runtime: runtime.status() });
});

// 固定采集器安装检查（单飞）；旧路由作为兼容别名。
let detectInFlight = false;
app.post(['/api/detect-collector', '/api/detect-bird'], requireAuth, requireCsrf, wrap(async (req, res) => {
  if (detectInFlight) return res.status(429).json({ found: false, error: '检测进行中，请稍候' });
  detectInFlight = true;
  try {
    const provider = collector();
    res.json(await (runtime.status().mode === 'legacy-live' ? provider.detectBird() : provider.detectTwscrape()));
  }
  finally { detectInFlight = false; }
}));

// test 端点：单飞，防止认证后并发派生大量子进程/出站请求（子进程风暴）
let birdTestInFlight = false;
let tgTestInFlight = false;
app.post(['/api/test/collector', '/api/test/bird'], requireAuth, requireCsrf, wrap(async (req, res) => {
  const blocked = runtime.blocked('collection');
  if (blocked) return res.status(409).json(blocked);
  if (birdTestInFlight) return res.status(429).json({ ok: false, error: '上一次测试仍在进行，请稍候' });
  birdTestInFlight = true;
  try { res.json(await worker.testCollector((req.body && req.body.username) || '')); }
  finally { birdTestInFlight = false; }
}));
app.post('/api/test/telegram', requireAuth, requireCsrf, wrap(async (req, res) => {
  const blocked = runtime.blocked('delivery');
  if (blocked) return res.status(409).json(blocked);
  if (tgTestInFlight) return res.status(429).json({ ok: false, error: '上一次测试仍在进行，请稍候' });
  tgTestInFlight = true;
  try { res.json(await worker.testTelegram()); }
  finally { tgTestInFlight = false; }
}));

// ===== SSE 实时流（状态 + 日志）=====
let sseCount = 0;
const SSE_MAX = 25;
const SSE_MAX_BUFFER = 1 << 20; // 单连接待发缓冲上限 1MB
app.get('/api/stream', requireAuth, (req, res) => {
  if (sseCount >= SSE_MAX) return res.status(503).end(); // 连接数上限，防 fd/内存耗尽
  sseCount++;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });

  let closing = false;
  let released = false;
  let ka = null;
  let unsubscribeRevocation = null;
  const stopProducing = () => {
    if (closing) return;
    closing = true;
    if (ka) clearInterval(ka);
    if (unsubscribeRevocation) unsubscribeRevocation();
    state.bus.off('status', onStatus); state.bus.off('log', onLog);
  };
  const cleanup = () => {
    stopProducing();
    if (released) return;
    released = true;
    sseCount--;
  };
  const closeStream = (force) => {
    stopProducing();
    // 连接数只在真实 close 事件中释放。慢客户端即使长期排空也始终占用一个配额槽。
    try {
      if (force) res.destroy();
      else res.end();
    } catch (_) { try { res.destroy(); } catch (_) {} }
  };
  const send = (event, data, id) => {
    if (closing) return;
    // 每一帧都验证：覆盖过期、密码文件被删除，以及心跳触发前产生的新事件。
    if (!sessionIsValid()) { closeStream(); return; }
    // 慢客户端不得让待发数据在进程内无界堆积：超过阈值直接断开，由前端重连
    if (res.writableLength > SSE_MAX_BUFFER) { closeStream(true); return; }
    const idLine = id == null ? '' : `id: ${id}\n`;
    try { res.write(`event: ${event}\n${idLine}data: ${JSON.stringify(data)}\n\n`); } catch (_) { closeStream(true); }
  };
  const onStatus = (s) => send('status', s);
  const onLog = (l) => send('log', l, l.id);
  const sessionIsValid = () => {
    try { return auth.hasPassword() && validSession(req); }
    catch (_) { return false; } // 读盘故障时关闭流，不让总线回调异常拖垮 worker。
  };

  // 先注册完整生命周期，再回放初始帧。若大回放触发慢客户端断开，cleanup 才能清掉全部资源。
  req.on('close', cleanup);
  res.on('close', cleanup);
  state.bus.on('status', onStatus);
  state.bus.on('log', onLog);
  unsubscribeRevocation = auth.onSessionRevoked(() => closeStream());
  ka = setInterval(() => {
    // 会话被登出/改密/过期后主动断流，避免向已吊销会话持续推送
    if (!sessionIsValid()) { closeStream(); return; }
    try { res.write(': ping\n\n'); } catch (_) { closeStream(); }
  }, 25000);

  send('status', state.getStatus());
  // 标准 SSE id 让浏览器自动重连时携带 Last-Event-ID。只补发该 ID 之后的日志；
  // ID 已淘汰或服务重启时回放最新 60 条，与前端可见窗口一致，不混入断线前的陈旧行。
  const recentLogs = state.getLogs(60);
  const lastEventId = typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : '';
  const resumeAt = lastEventId ? recentLogs.findIndex((line) => line.id === lastEventId) : -1;
  const replayLogs = resumeAt >= 0 ? recentLogs.slice(resumeAt + 1) : recentLogs;
  for (const l of replayLogs) send('log', l, l.id);
});

// 未知接口返回 JSON 404，而不是被下面的 SPA 兜底路由回一个 200 的 HTML
app.use('/api', (req, res) => res.status(404).json({ ok: false, error: '接口不存在' }));

// ===== 静态面板 =====
app.use(express.static(path.join(__dirname, 'public')));
// 面板没有客户端路由。未知页面返回 404，避免深路径错误解析相对静态资源。

// ===== 统一错误处理：绝不回传堆栈/绝对路径 =====
app.use((err, req, res, next) => {
  const clientStatus = Number(err && (err.status || err.statusCode));
  if (err && ((clientStatus >= 400 && clientStatus < 500) || err.type === 'entity.parse.failed')) {
    if (!res.headersSent) return res.status(clientStatus >= 400 && clientStatus < 500 ? clientStatus : 400).json({ ok: false, error: '请求无效' });
    return next(err);
  }
  state.log(`请求处理异常：${(err && err.message) || err}`);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: '服务器内部错误' });
});

// 兜底：进程遇到本应致命的错误时，记录后交给 systemd 干净重启，而非在未定义状态下带病续跑
let shuttingDown = false;
function fatal(kind, e) {
  try { state.log(`${kind}：${(e && e.stack) || e}`); } catch (_) {}
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => process.exit(1), 100);
}
function installFatalHandlers() {
  process.on('unhandledRejection', (e) => fatal('未处理的 Promise 拒绝', e));
  process.on('uncaughtException', (e) => fatal('未捕获异常', e));
}

function startServer(port = PORT, host = HOST) {
  return app.listen(port, host, () => {
    store.sweepTmp();       // 清理原子写残留的孤儿 .tmp
    refreshSetupToken();    // 无密码时打印一次性首次设置令牌
    state.log(`面板/服务已监听 http://${host}:${port}`);
    worker.start();
  });
}

if (require.main === module) {
  installFatalHandlers();
  startServer();
}

module.exports = { app, startServer, requestOrigin, parsePublicOrigin };
