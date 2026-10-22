'use strict';
// 通过 Telegram Bot API 发送消息（用 Node 内置 fetch）。
const runtime = require('./runtime');

// 解析推文时间：若原始串不含时区信息，Date.parse 会按【服务器本地时区】解释，
// 随后又渲染为 Asia/Shanghai，导致非 +08 服务器上"发布时间"系统性偏错。
// 因此对裸时间（无 Z / 无 ±hh:mm 偏移 / 无 GMT/UTC）显式按 UTC 解释。
function parseTweetTime(raw) {
  const s = String(raw || '').trim();
  if (!s) return NaN;
  const hasTz = /(?:[zZ]$)|(?:[+-]\d{2}:?\d{2})|GMT|UTC/.test(s);
  const bare = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(s);
  if (bare && !hasTz) return Date.parse(s.replace(' ', 'T') + 'Z');
  return Date.parse(s);
}

// Telegram 的 4096 上限按 UTF-16 单元计，故用 .length 度量；但直接 slice 可能把
// 一个 emoji 的代理对劈开，留下孤立代理项，编码成 UTF-8 时变成 U+FFFD（�）。
function truncate(s, max) {
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xD800 && last <= 0xDBFF) cut = cut.slice(0, -1); // 末尾是高位代理项：连同丢弃
  return `${cut}\n\n…（内容已截断）`;
}

function formatTweet(t, account) {
  let timeStr = '';
  if (t.time) {
    const ts = parseTweetTime(t.time);
    timeStr = Number.isNaN(ts)
      ? String(t.time)
      : new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  }
  const label = t.is_rt ? '🔁 转推' : '🐦 新推文';
  const msg = `${label} @${account}\n\n发布时间：${timeStr}\nX链接：${t.url || ''}\n内容：\n${t.text || ''}`;
  return truncate(msg, 4000);
}

// 返回 { ok, description, retryAfter, permanent }
//   retryAfter: 429 时 Telegram 要求的等待秒数（供调用方退避）
//   permanent : 确定性失败（配置无效 / 4xx 参数错误），不值得重试
async function sendMessage({ botToken, chatId, text }) {
  const blocked = runtime.blocked();
  if (blocked) return { ...blocked, description: blocked.message, permanent: true };
  const validChatType = typeof chatId === 'string' || (typeof chatId === 'number' && Number.isSafeInteger(chatId));
  const validToken = typeof botToken === 'string'
    && botToken.length > 0
    && !botToken.includes('\0')
    && Buffer.byteLength(botToken, 'utf8') <= 4096;
  if (!validToken || !validChatType || !chatId || !/^-?\d{1,32}$/.test(String(chatId))
      || typeof text !== 'string' || text.length === 0 || text.length > 4096) {
    return { ok: false, description: 'Telegram 配置无效（Bot Token / Chat ID）', permanent: true };
  }
  let url;
  try { url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`; }
  catch (_) { return { ok: false, description: 'Telegram Bot Token 格式无效', permanent: true }; }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ chat_id: String(chatId), text: String(text) }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => null);
    // 只有 HTTP 成功且契约中的 ok 为布尔 true 才能记为已送达；冲突/漂移响应必须 fail closed，
    // 否则 worker 会把未确认的推文写入去重表并永久漏推。
    if (res.status >= 200 && res.status < 300 && data && data.ok === true) return { ok: true };
    const bodyRetry = data && data.parameters && Number(data.parameters.retry_after);
    // 代理或故障页可能返回无 JSON 的 429，但仍通过标准头给出等待秒数。
    // 优先 Telegram JSON 参数，缺失时才回退 Retry-After 响应头。
    const headerValue = res.headers && typeof res.headers.get === 'function'
      ? Number(res.headers.get('retry-after'))
      : NaN;
    const rawRetry = Number.isFinite(bodyRetry) && bodyRetry > 0 ? bodyRetry : headerValue;
    const retryAfter = Number.isFinite(rawRetry) && rawRetry > 0 ? rawRetry : 0;
    const errorCode = Number(data && data.error_code) || res.status;
    const rateLimited = res.status === 429 || errorCode === 429;
    // Telegram 有时会在 HTTP 200 中用 error_code 表达业务错误，分类时不能只看 HTTP 状态。
    // 408/409/425 都可能在稍后成功，不应像凭据/参数类 4xx 一样永久放弃本轮重试。
    const retryableClientError = errorCode === 408 || errorCode === 409 || errorCode === 425;
    const permanent = errorCode >= 400 && errorCode < 500 && !rateLimited && !retryableClientError;
    const description = String((data && data.description) || `HTTP ${res.status}`).slice(0, 500);
    return { ok: false, description, retryAfter, rateLimited, permanent };
  } catch (e) {
    // 超时/网络错误属瞬时，可重试
    const description = e && e.name === 'TimeoutError'
      ? '请求超时'
      : ((e && e.message) || String(e || '网络请求失败'));
    return { ok: false, description: String(description).slice(0, 500) };
  }
}

module.exports = { sendMessage, formatTweet, truncate };
