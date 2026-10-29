'use strict';
// 通过 Telegram Bot API 发送消息（用 Node 内置 fetch）。
const runtime = require('./runtime');
const { normalizeTweetContent, normalizeDeliveryParts } = require('./tweet-content');
const TRUNCATED_SUFFIX = '\n\n…（内容已截断）';

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
  return `${cut}${TRUNCATED_SUFFIX}`;
}

// Unlike the legacy truncate helper, this includes the notice in its budget.
function fitText(text, budget) {
  return text.length <= budget ? text : truncate(text, budget - TRUNCATED_SUFFIX.length);
}

function formatTweet(t, account, translationText = '') {
  let timeStr = '';
  if (t.time) {
    const ts = parseTweetTime(t.time);
    timeStr = Number.isNaN(ts)
      ? String(t.time)
      : new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  }
  const label = t.is_rt ? '🔁 转推' : t.relations?.replyToId ? '↩️ 回复' : t.relations?.quoteId ? '💬 引用' : '🐦 新推文';
  const header = `${label} @${account}\n\n发布时间：${timeStr}\nX链接：${t.url || ''}`;
  const original = String(t.text || '');
  const translated = typeof translationText === 'string' ? translationText.trim() : '';
  if (!translated) return truncate(`${header}\n内容：\n${original}`, 4000);

  // Keep both sections visible for long posts. Short sections release their
  // unused space to the other; translation receives 60% when both are long.
  const boundedHeader = fitText(header, 3000);
  const translatedLabel = '\n\nAI 中文翻译：\n';
  const originalLabel = '\n\n原文：\n';
  const available = 4096 - boundedHeader.length - translatedLabel.length - originalLabel.length;
  const translatedBudget = Math.min(translated.length,
    Math.max(Math.floor(available * 0.6), available - original.length));
  return boundedHeader + translatedLabel + fitText(translated, translatedBudget)
    + originalLabel + fitText(original, available - translatedBudget);
}

// Persist this exact plan before starting any request. A restart uses its next
// index rather than re-running translation or optional enrichment.
function planTweet(tweet, sourceLabel, translationText = '', { media_mode = 'links' } = {}) {
  if (!['links', 'photos', 'all'].includes(media_mode)) throw new TypeError('媒体发送模式无效');
  const content = normalizeTweetContent(tweet.content) || {};
  const parts = [{ kind: 'text', text: formatTweet(tweet, sourceLabel, translationText) }];
  const quoted = content.quoted;
  if (quoted) {
    const header = `💬 引用${quoted.author_username ? ` @${quoted.author_username}` : ''}\n${quoted.url}\n\n`;
    parts.push({ kind: 'text', text: header + fitText(quoted.text ?? '引用正文不可用', 4096 - header.length) });
  } else if (tweet.relations?.quoteId) {
    parts.push({ kind: 'text', text: `💬 引用正文不可用\nhttps://x.com/i/status/${tweet.relations.quoteId}` });
  }
  if (content.article) {
    const article = content.article;
    const header = `📰 ${article.title}\n${article.url || `https://x.com/i/article/${article.id}`}\n\n`;
    parts.push({ kind: 'text', text: header + fitText(article.text ?? article.previewText ?? '', 4096 - header.length) });
  }
  for (const entry of content.thread || []) {
    const header = `🧵 会话${entry.author_username ? ` @${entry.author_username}` : ''}\n${entry.url}\n\n`;
    parts.push({ kind: 'text', text: header + fitText(entry.text, 4096 - header.length) });
  }
  const native = [], links = [];
  for (const item of content.media || []) {
    if (media_mode === 'all' || (media_mode === 'photos' && item.type === 'photo')) native.push(item);
    else links.push(item);
  }
  let linkText = '';
  for (const item of links) {
    const line = `${item.type === 'photo' ? '🖼 图片' : item.type === 'video' ? '🎬 视频' : '🎞 动图'}\n${item.url}`;
    if (linkText && linkText.length + line.length + 2 > 4096) {
      parts.push({ kind: 'text', text: linkText });
      linkText = '';
    }
    linkText += `${linkText ? '\n\n' : ''}${line}`;
  }
  if (linkText) parts.push({ kind: 'text', text: linkText });
  let album = [];
  const flushAlbum = () => {
    if (album.length === 1) parts.push({ kind: album[0].type, url: album[0].url });
    else if (album.length > 1) parts.push({ kind: 'album', media: album });
    album = [];
  };
  for (const item of native) {
    if (item.type === 'animated_gif') {
      flushAlbum();
      parts.push({ kind: 'animation', url: item.url });
    } else album.push({ type: item.type, url: item.url });
  }
  flushAlbum();
  return normalizeDeliveryParts(parts);
}

// 返回 { ok, description, retryAfter, permanent }
//   retryAfter: 429 时 Telegram 要求的等待秒数（供调用方退避）
//   permanent : 确定性失败（配置无效 / 4xx 参数错误），不值得重试
async function telegramRequest({ botToken, chatId, method, fields, validateResult }) {
  const blocked = runtime.blocked('delivery');
  if (blocked) return { ...blocked, description: blocked.message, permanent: true };
  const validChatType = typeof chatId === 'string' || (typeof chatId === 'number' && Number.isSafeInteger(chatId));
  const validToken = typeof botToken === 'string'
    && botToken.length > 0
    && !botToken.includes('\0')
    && Buffer.byteLength(botToken, 'utf8') <= 4096;
  if (!validToken || !validChatType || !chatId || !/^-?\d{1,32}$/.test(String(chatId))
      || !fields) {
    return { ok: false, description: 'Telegram 配置无效（Bot Token / Chat ID）', permanent: true };
  }
  let url;
  try { url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/${method}`; }
  catch (_) { return { ok: false, description: 'Telegram Bot Token 格式无效', permanent: true }; }
  try {
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ chat_id: String(chatId), ...fields }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => null);
    // 只有 HTTP 成功且契约中的 ok 为布尔 true 才能记为已送达；冲突/漂移响应必须 fail closed，
    // 否则 worker 会把未确认的推文写入去重表并永久漏推。
    if (res.status >= 200 && res.status < 300 && data && data.ok === true) {
      if (!validateResult || validateResult(data.result)) return { ok: true };
      return { ok: false, description: 'Telegram 返回的媒体确认不完整' };
    }
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
    const description = redactDescription((data && data.description) || `HTTP ${res.status}`, botToken);
    return { ok: false, description, retryAfter, rateLimited, permanent };
  } catch (e) {
    // 超时/网络错误属瞬时，可重试
    const description = e && e.name === 'TimeoutError'
      ? '请求超时'
      : ((e && e.message) || String(e || '网络请求失败'));
    return { ok: false, description: redactDescription(description, botToken) };
  }
}

function redactDescription(value, token) {
  let text = String(value);
  for (const secret of [token, encodeURIComponent(token)]) if (secret) text = text.split(secret).join('[redacted]');
  return text.slice(0, 500);
}

async function sendMessage({ botToken, chatId, text }) {
  const valid = typeof text === 'string' && text.length > 0 && text.length <= 4096 && text.isWellFormed();
  return telegramRequest({ botToken, chatId, method: 'sendMessage', fields: valid ? { text } : null });
}

async function sendTweetPart({ botToken, chatId, part }) {
  let normalized;
  try { [normalized] = normalizeDeliveryParts([part]); }
  catch (_) { return { ok: false, description: 'Telegram 投递部分无效', permanent: true }; }
  if (normalized.kind === 'text') return sendMessage({ botToken, chatId, text: normalized.text });
  const validMessage = (value) => value && Number.isSafeInteger(value.message_id) && value.message_id > 0;
  if (normalized.kind === 'album') {
    return telegramRequest({ botToken, chatId, method: 'sendMediaGroup', fields: {
      media: JSON.stringify(normalized.media.map((item) => ({ type: item.type, media: item.url }))),
    }, validateResult: (result) => Array.isArray(result) && result.length === normalized.media.length
      && result.every(validMessage) && new Set(result.map((item) => item.message_id)).size === result.length });
  }
  const methods = { photo: 'sendPhoto', video: 'sendVideo', animation: 'sendAnimation' };
  return telegramRequest({ botToken, chatId, method: methods[normalized.kind],
    fields: { [normalized.kind]: normalized.url }, validateResult: validMessage });
}

module.exports = { sendMessage, sendTweetPart, planTweet, formatTweet, truncate };
