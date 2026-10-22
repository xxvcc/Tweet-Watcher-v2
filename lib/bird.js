'use strict';
// 通过固定的随应用发布的 Bird 适配器拉取推文并解析为统一结构。
const fs = require('fs');
const { execFile } = require('child_process');
const { validUsername, validBirdPath, BUNDLED_BIRD } = require('./config');
const runtime = require('./runtime');

const MAX_TWEET_ID_DIGITS = 32;
const MAX_TWEET_TEXT = 12000;
const MAX_TWEET_TIME = 256;
const MAX_TWEET_URL = 2048;
const MAX_AUTHOR_NAME = 160;
const MAX_TWEETS_PER_FETCH = 500;
const TWEET_ID_RE = new RegExp(`^\\d{1,${MAX_TWEET_ID_DIGITS}}$`);

async function detectBird() {
  try {
    const version = require('@steipete/bird/package.json').version;
    fs.accessSync(BUNDLED_BIRD, fs.constants.R_OK);
    if (version !== '0.8.0' || !fs.statSync(BUNDLED_BIRD).isFile()) throw new Error('unsupported install');
    return { found: true, path: BUNDLED_BIRD, version: `${version} + strict timeline adapter` };
  } catch (_) {
    return { found: false, path: BUNDLED_BIRD, version: null };
  }
}

function extractJSON(text) {
  const t = (text || '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch (_) {}
  const fb = t.indexOf('['), lb = t.lastIndexOf(']');
  if (fb !== -1 && lb > fb) { try { return JSON.parse(t.slice(fb, lb + 1)); } catch (_) {} }
  const ob = t.indexOf('{'), obl = t.lastIndexOf('}');
  if (ob !== -1 && obl > ob) { try { return JSON.parse(t.slice(ob, obl + 1)); } catch (_) {} }
  return null;
}

// 取第一个"存在且非空"的标量值。不能用 ?? 链：它只跨过 null/undefined，
// 于是 text:"" 的纯媒体推文会吃掉后面的 full_text，推出一条空正文。
function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v !== '') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return '';
}

function clip(s, max) {
  s = String(s || '');
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xD800 && last <= 0xDBFF) out = out.slice(0, -1);
  return out;
}

function normalizeTweets(data, account) {
  let items = data;
  if (data && !Array.isArray(data)) items = data.tweets || data.results || data;
  if (!Array.isArray(items)) return null;
  if (items.length > MAX_TWEETS_PER_FETCH) return null;
  const out = [];
  for (const it of items) {
    // user-tweets 的数组契约中每项都必须是 TweetData。混合批次里哪怕只有一项漂移，
    // 静默跳过也会让其余条目把本轮标成成功，并永久漏掉这条无法识别的真实推文。
    if (!it || typeof it !== 'object' || Array.isArray(it)) return null;
    // 优先取字符串型 id（id_str/rest_id）：数字型 id 会在 JSON.parse 阶段被双精度舍入，
    // 令相邻雪花 id 坍缩碰撞而漏推；对象型 id 无法得到稳定字符串键，直接跳过。
    const idRaw = it.id_str ?? it.rest_id ?? it.tweet_id ?? it.id ?? null;
    if (idRaw == null) return null;
    let id;
    if (typeof idRaw === 'string') id = idRaw.trim();
    else if (typeof idRaw === 'number' && Number.isSafeInteger(idRaw)) id = String(idRaw);
    // 只要 bird 明确给出了 ID 却无法无损表示，就让整批失败。若仅跳过该项，
    // 同批合法推文会让检查显示成功，而这个精度已损坏的真实推文会被永久漏掉。
    else return null;
    if (!TWEET_ID_RE.test(id)) return null;
    let name = it.author ?? (it.user && it.user.name) ?? it.name ?? account;
    if (name && typeof name === 'object') name = name.name || name.screen_name || name.username || account;
    const providedUrl = typeof it.url === 'string' ? it.url.trim() : '';
    const text = clip(firstNonEmpty(it.text, it.full_text, it.content), MAX_TWEET_TEXT);
    out.push({
      id,
      text,
      time: clip(firstNonEmpty(it.created_at, it.createdAt, it.time, it.date, it.published_at), MAX_TWEET_TIME),
      // 只接受字符串型 url；对象/数字会被 String() 变成 "[object Object]" 之类的垃圾链接
      url: providedUrl ? clip(providedUrl, MAX_TWEET_URL) : `https://x.com/${account}/status/${id}`,
      name: clip(typeof name === 'string' ? name : account, MAX_AUTHOR_NAME),
      // bird 0.8.0 的精简 TweetData 不带 retweet 布尔字段，但 Twitter 的转推正文仍使用
      // 稳定的 `RT @handle:` 前缀。保留旧/扩展字段兼容，并为固定版本补上文本识别。
      is_rt: !!(it.is_retweet ?? it.retweeted_status) || /^RT @[A-Za-z0-9_]{1,15}:/.test(text),
      is_pinned: it.is_pinned === true,
    });
  }
  // 非空数组却一个合法 tweet 都没有，通常意味着 bird 输出契约已变化。
  // 必须显式失败，不能伪装成“连接正常但无推文”而长期静默失盲。
  if (items.length > 0 && out.length === 0) return null;
  return out;
}

// 返回 { ok, tweets|null, error, raw }
function fetchTweets({ birdPath, username, count, authToken, ct0, sinceId }) {
  const blocked = runtime.blocked('legacy');
  if (blocked) return Promise.resolve({ ...blocked, tweets: null, error: blocked.message, raw: '' });
  return new Promise((resolve) => {
    if (!validUsername(username)) return resolve({ ok: false, tweets: null, error: '账号名非法', raw: '' });
    if (!validBirdPath(birdPath)) return resolve({ ok: false, tweets: null, error: 'bird 可执行文件路径非法', raw: '' });
    if (sinceId !== undefined && (typeof sinceId !== 'string' || !TWEET_ID_RE.test(sinceId))) {
      return resolve({ ok: false, tweets: null, error: '推文水位非法', raw: '' });
    }
    if (!authToken || !ct0) return resolve({ ok: false, tweets: null, error: '缺少 auth_token / ct0', raw: '' });
    const invalidCredential = (v) => typeof v !== 'string' || v.includes('\0') || Buffer.byteLength(v, 'utf8') > 4096;
    if (invalidCredential(authToken) || invalidCredential(ct0)) {
      return resolve({ ok: false, tweets: null, error: 'auth_token / ct0 格式非法', raw: '' });
    }
    const n = Math.min(50, Math.max(1, parseInt(count, 10) || 1));
    // 凭据不得进入 argv：同机其他 UID 通常能读取
    // /proc/<pid>/cmdline，而受系统 ptrace 边界保护的 environ 不向这些 UID 开放。
    const args = [BUNDLED_BIRD, username, String(n), ...(sinceId === undefined ? [] : [sinceId])];
    const env = {};
    // 只继承 CLI 运行所需的通用环境，避免把 Web 服务的代理密钥等无关变量传给子进程。
    for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TMP', 'TEMP']) {
      if (typeof process.env[key] === 'string') env[key] = process.env[key];
    }
    env.AUTH_TOKEN = authToken;
    env.CT0 = ct0;
    env.TW_RUNTIME_MODE = runtime.status().mode;
    // timeout 默认只发 SIGTERM；子进程可捕获/忽略它，令 Promise 和一个 worker 槽永久悬挂。
    // bird 是无状态短命 CLI，超时后直接 SIGKILL，确保回调和调度槽一定能够回收。
    execFile(process.execPath, args, {
      env, timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') {
          return resolve({ ok: false, tweets: null, error: `bird 可执行文件不存在: ${birdPath}`, raw: '' });
        }
        // 非零退出 / 超时 / 缓冲溢出一律判失败——绝不因"碰巧能解析出 JSON（含空数组）"而误判成功，
        // 否则鉴权过期等错误会被伪装成"无新推文"造成静默失盲。
        const error = err.killed ? 'bird 执行超时' : `bird 执行失败（退出码 ${err.code ?? '非零'}）`;
        return resolve({ ok: false, tweets: null, error, raw: clip(stderr || stdout || '', 400) });
      }
      // 只解析 stdout；stderr 仅作诊断，避免其中的括号污染 JSON 抽取而把成功拉取误判为失败。
      let data;
      try { data = JSON.parse(String(stdout || '').trim()); } catch (_) { data = null; }
      if (data === null) {
        let isJsonNull = false;
        try { isJsonNull = JSON.parse(String(stdout || '').trim()) === null; } catch (_) {}
        return resolve({
          ok: false,
          tweets: null,
          error: isJsonNull ? 'bird 输出结构不受支持' : 'bird 输出非 JSON',
          raw: clip(stdout || '', 400),
        });
      }
      const tweets = normalizeTweets(data, username);
      const coverage = data?.coverage;
      if (tweets === null || !coverage || coverage.complete !== true
          || typeof coverage.exhausted !== 'boolean' || typeof coverage.reachedSince !== 'boolean'
          || !(coverage.oldestId === null || (typeof coverage.oldestId === 'string' && TWEET_ID_RE.test(coverage.oldestId)))) {
        return resolve({ ok: false, tweets: null, error: 'bird 输出结构不受支持', raw: clip(stdout || '', 400) });
      }
      resolve({ ok: true, tweets, coverage, error: null, raw: '' });
    });
  });
}

module.exports = { fetchTweets, extractJSON, normalizeTweets, detectBird };
