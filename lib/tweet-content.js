'use strict';

// Optional presentation evidence, separate from the immutable parent body.
// Extraction tolerates absent upstream fields; durable input is strict.
const ID = /^[1-9]\d{0,31}$/;
const USER = /^[A-Za-z0-9_]{1,15}$/;
const LANG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;
const MAX_MEDIA = 10;
const MAX_CONTENT_BYTES = 128 * 1024;
const MAX_DELIVERY_PARTS = 128;
const LEGACY_DELIVERY_PARTS = 24;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const unwrap = (v) => v?.__typename === 'TweetWithVisibilityResults' ? v.tweet : v;
const fail = () => { throw new TypeError('推文附加内容无效'); };
const decodeText = (text) => text.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, entity) => ({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'",
})[entity]);
function string(v, max, empty = true) {
  if (typeof v !== 'string' || !v.isWellFormed() || v.length > max || (!empty && !v)
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) fail();
  return v;
}
function webUrl(v, hosts) {
  string(v, 2048, false);
  let url;
  try { url = new URL(v); } catch (_) { return fail(); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || url.hash || (hosts && !hosts.includes(url.hostname))) fail();
  return url.href;
}
function mediaUrl(v, type) {
  const value = webUrl(v, type === 'photo' ? ['pbs.twimg.com'] : ['video.twimg.com']);
  const pathname = new URL(value).pathname;
  if (type === 'photo' ? !/^\/(?:media|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//.test(pathname)
    : !/^\/(?:ext_tw_video|amplify_video|tweet_video)\//.test(pathname)) fail();
  return value;
}
function statusUrl(value, id) {
  const url = webUrl(value, ['x.com', 'twitter.com']);
  if (!new RegExp(`^/(?:[A-Za-z0-9_]{1,15}|i)/status/${id}$`).test(new URL(url).pathname)) fail();
  return url;
}
function normalizeTweetContent(value) {
  if (value === undefined) return undefined;
  if (!object(value)) fail();
  const out = {};
  if (value.conversationId !== undefined) {
    if (typeof value.conversationId !== 'string' || !ID.test(value.conversationId)) fail();
    out.conversationId = value.conversationId;
  }
  if (value.replyToUsername !== undefined) {
    if (!USER.test(value.replyToUsername) || typeof value.replyToUsername !== 'string') fail();
    out.replyToUsername = value.replyToUsername;
  }
  if (value.media !== undefined) {
    if (!Array.isArray(value.media) || value.media.length > MAX_MEDIA) fail();
    out.media = value.media.map((item) => {
      if (!object(item) || !['photo', 'video', 'animated_gif'].includes(item.type)) fail();
      const media = { type: item.type, url: mediaUrl(item.url, item.type) };
      if (item.previewUrl !== undefined) media.previewUrl = mediaUrl(item.previewUrl, 'photo');
      if (item.alt !== undefined) media.alt = string(item.alt, 2000);
      if (item.sourceId !== undefined) {
        if (typeof item.sourceId !== 'string' || !ID.test(item.sourceId)) fail();
        media.sourceId = item.sourceId;
      }
      if (item.durationMs !== undefined) {
        if (!Number.isSafeInteger(item.durationMs) || item.durationMs < 0 || item.durationMs > 24 * 3600e3) fail();
        media.durationMs = item.durationMs;
      }
      return media;
    });
  }
  if (value.quoted !== undefined) {
    const quote = value.quoted;
    if (!object(quote) || typeof quote.id !== 'string' || !ID.test(quote.id)) fail();
    out.quoted = { id: quote.id, url: statusUrl(quote.url, quote.id) };
    if (quote.text !== undefined) out.quoted.text = string(quote.text, 12000);
    if (quote.author_username !== undefined) {
      if (typeof quote.author_username !== 'string' || !USER.test(quote.author_username)) fail();
      out.quoted.author_username = quote.author_username;
    }
    if (quote.lang !== undefined) {
      if (typeof quote.lang !== 'string' || quote.lang.length > 35 || !LANG.test(quote.lang)) fail();
      out.quoted.lang = quote.lang.toLowerCase();
    }
    if (quote.unavailable !== undefined) {
      if (typeof quote.unavailable !== 'boolean') fail();
      out.quoted.unavailable = quote.unavailable;
    }
  }
  if (value.article !== undefined) {
    const article = value.article;
    if (!object(article) || typeof article.id !== 'string' || !ID.test(article.id)) fail();
    out.article = { id: article.id, title: string(article.title, 500) };
    for (const [key, max] of [['previewText', 4000], ['text', 30000]]) {
      if (article[key] !== undefined) out.article[key] = string(article[key], max);
    }
    if (article.url !== undefined) {
      out.article.url = webUrl(article.url, ['x.com', 'twitter.com']);
      if (new URL(out.article.url).pathname !== `/i/article/${article.id}`) fail();
    }
    if (article.coverUrl !== undefined) out.article.coverUrl = mediaUrl(article.coverUrl, 'photo');
  }
  if (value.thread !== undefined) {
    if (!Array.isArray(value.thread) || value.thread.length > 10) fail();
    const seen = new Set();
    out.thread = value.thread.map((item) => {
      if (!object(item) || typeof item.id !== 'string' || !ID.test(item.id) || seen.has(item.id)) fail();
      seen.add(item.id);
      const entry = { id: item.id, text: string(item.text, 12000), url: statusUrl(item.url, item.id) };
      if (item.author_username !== undefined) {
        if (typeof item.author_username !== 'string' || !USER.test(item.author_username)) fail();
        entry.author_username = item.author_username;
      }
      if (item.lang !== undefined) {
        if (typeof item.lang !== 'string' || item.lang.length > 35 || !LANG.test(item.lang)) fail();
        entry.lang = item.lang.toLowerCase();
      }
      return entry;
    });
  }
  if (value.metrics !== undefined) {
    if (!object(value.metrics)) fail();
    out.metrics = {};
    for (const key of ['replies', 'reposts', 'likes', 'quotes', 'bookmarks', 'views']) {
      if (value.metrics[key] !== undefined) {
        if (!Number.isSafeInteger(value.metrics[key]) || value.metrics[key] < 0) fail();
        out.metrics[key] = value.metrics[key];
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(out)) > MAX_CONTENT_BYTES) fail();
  return Object.keys(out).length ? out : undefined;
}

// Keep optional failures local: a bad attachment must not discard the parent's
// complete post or turn an unavailable quoted post into an invented body.
function extractTweetContent(raw, { repostId = null, useRepostBody = false } = {}) {
  const original = unwrap(raw);
  if (!object(original)) return undefined;
  let body = original;
  if (useRepostBody && repostId) {
    for (const slot of [original.retweeted_status_result, original.legacy?.retweeted_status_result]) {
      const nested = unwrap(slot?.result);
      if (nested && (nested.rest_id ?? nested.legacy?.id_str) === repostId) { body = nested; break; }
    }
  }
  const out = {};
  const take = (field, value) => {
    try {
      const normalized = normalizeTweetContent({ ...out, [field]: value });
      if (normalized?.[field] !== undefined) { out[field] = normalized[field]; return true; }
    }
    catch (_) { /* optional, untrusted upstream metadata */ }
    return false;
  };
  take('conversationId', original.legacy?.conversation_id_str);
  take('replyToUsername', original.legacy?.in_reply_to_screen_name);
  const media = [];
  for (const item of (Array.isArray(body.legacy?.extended_entities?.media) ? body.legacy.extended_entities.media : []).slice(0, MAX_MEDIA)) {
    try {
      const sourceId = body.rest_id ?? body.legacy?.id_str;
      const attachment = { type: item.type };
      if (typeof sourceId === 'string' && ID.test(sourceId)) attachment.sourceId = sourceId;
      if (item.type === 'photo') attachment.url = item.media_url_https;
      else {
        const variants = (Array.isArray(item.video_info?.variants) ? item.video_info.variants : [])
          .filter((v) => v.content_type === 'video/mp4' && typeof v.url === 'string')
          .sort((a, b) => (a.bitrate ?? 0) - (b.bitrate ?? 0));
        // Prefer the smallest supplied MP4; Telegram fetches the allowlisted URL.
        attachment.url = variants[0]?.url;
        attachment.previewUrl = item.media_url_https;
        if (item.video_info?.duration_millis !== undefined) attachment.durationMs = item.video_info.duration_millis;
      }
      if (typeof item.ext_alt_text === 'string') attachment.alt = item.ext_alt_text.slice(0, 2000);
      media.push(normalizeTweetContent({ media: [attachment] }).media[0]);
    } catch (_) { /* malformed or unsupported attachment is not a valid URL */ }
  }
  if (media.length) take('media', media);
  const quoteId = body.legacy?.quoted_status_id_str;
  const nestedQuote = unwrap((body.quoted_status_result ?? body.legacy?.quoted_status_result ?? body.quotedRefResult)?.result);
  const nestedId = nestedQuote?.rest_id ?? nestedQuote?.legacy?.id_str;
  const quotedId = quoteId ?? nestedId;
  if (typeof quotedId === 'string' && ID.test(quotedId) && (!quoteId || !nestedId || quoteId === nestedId)) {
    const quote = { id: quotedId, url: `https://x.com/i/status/${quotedId}`, unavailable: true };
    const note = nestedQuote?.note_tweet?.note_tweet_results?.result?.text;
    const text = typeof note === 'string' ? note : nestedQuote?.legacy?.truncated === true ? undefined : nestedQuote?.legacy?.full_text;
    if (typeof text === 'string' && text.length <= 12000) { quote.text = decodeText(text); quote.unavailable = false; }
    const profile = nestedQuote?.core?.user_results?.result;
    const username = profile?.core?.screen_name ?? profile?.legacy?.screen_name;
    if (typeof username === 'string' && USER.test(username)) quote.author_username = username;
    const lang = nestedQuote?.legacy?.lang;
    if (typeof lang === 'string' && lang.length <= 35 && LANG.test(lang)) quote.lang = lang;
    if (!take('quoted', quote)) take('quoted', { id: quotedId, url: quote.url, unavailable: true });
  }
  const article = body.article?.article_results?.result;
  if (object(article)) {
    const value = { id: article.rest_id, title: typeof article.title === 'string' ? article.title : '' };
    if (typeof article.preview_text === 'string' && article.preview_text.length <= 4000) value.previewText = article.preview_text;
    if (Array.isArray(article.content_state?.blocks)) {
      const blocks = article.content_state.blocks;
      if (blocks.length <= 1000 && blocks.every((block) => typeof block.text === 'string')) {
        const text = blocks.map((block) => block.text).join('\n');
        if (text.length <= 30000) value.text = text;
      }
    }
    value.url = `https://x.com/i/article/${article.rest_id}`;
    const cover = article.cover_media?.media_info?.original_img_url;
    if (typeof cover === 'string') {
      try { value.coverUrl = mediaUrl(cover, 'photo'); } catch (_) {}
    }
    if (!take('article', value)) {
      delete value.text;
      if (!take('article', value)) take('article', { id: value.id, title: value.title, url: value.url });
    }
  }
  const metrics = {};
  for (const [name, key] of [['replies', 'reply_count'], ['reposts', 'retweet_count'], ['likes', 'favorite_count'], ['quotes', 'quote_count'], ['bookmarks', 'bookmark_count']]) {
    const value = original.legacy?.[key];
    if (Number.isSafeInteger(value) && value >= 0) metrics[name] = value;
  }
  const views = original.views?.count;
  if (typeof views === 'string' && /^\d+$/.test(views) && Number.isSafeInteger(Number(views))) metrics.views = Number(views);
  if (Object.keys(metrics).length) take('metrics', metrics);
  return normalizeTweetContent(out);
}

function mergeTweetContent(before, after) {
  const first = normalizeTweetContent(before);
  const second = normalizeTweetContent(after);
  if (!first) return second;
  if (!second) return first;
  const conflict = () => { throw Object.assign(new Error('同一推文附加内容存在冲突'), { code: 'TWEET_CONFLICT' }); };
  const out = { ...first, ...second };
  for (const field of ['conversationId', 'replyToUsername']) {
    if (first[field] !== undefined && second[field] !== undefined && first[field] !== second[field]) conflict();
  }
  for (const field of ['quoted', 'article']) {
    if (!first[field] || !second[field]) continue;
    const a = first[field], b = second[field];
    if (a.id !== b.id || (a.text !== undefined && b.text !== undefined && a.text !== b.text)) conflict();
    out[field] = { ...a, ...b };
    if (field === 'quoted' && out[field].text !== undefined) out[field].unavailable = false;
  }
  if (first.media?.length && second.media?.length) {
    const all = [...first.media, ...second.media];
    out.media = [...new Map(all.map((item) => [`${item.type}:${item.url}`, item])).values()];
    if (out.media.length > MAX_MEDIA) conflict();
  } else if (first.media?.length) out.media = first.media;
  if (first.metrics && second.metrics) out.metrics = { ...first.metrics, ...second.metrics };
  if (first.thread && second.thread) {
    const entries = new Map(first.thread.map((entry) => [entry.id, entry]));
    for (const entry of second.thread) {
      const previous = entries.get(entry.id);
      if (previous && previous.text !== entry.text) conflict();
      entries.set(entry.id, { ...previous, ...entry });
    }
    if (entries.size > 10) conflict();
    out.thread = [...entries.values()];
  }
  return normalizeTweetContent(out);
}

function normalizeDeliveryParts(parts, { version = 2 } = {}) {
  if (![1, 2].includes(version) || !Array.isArray(parts) || !parts.length
      || parts.length > (version === 1 ? LEGACY_DELIVERY_PARTS : MAX_DELIVERY_PARTS)) fail();
  return parts.map((part) => {
    if (!object(part)) fail();
    const hasCaption = Object.hasOwn(part, 'caption');
    // Old readers discard unknown fields. Never let caption-bearing plans use
    // their format, or a downgrade could silently send media without its body.
    if (hasCaption && (version === 1 || part.kind === 'text')) fail();
    const caption = hasCaption ? { caption: string(part.caption, 1024) } : {};
    if (part.kind === 'text') return { kind: 'text', text: string(part.text, 4096, false) };
    if (['photo', 'video', 'animation'].includes(part.kind)) return { kind: part.kind,
      url: mediaUrl(part.url, part.kind === 'photo' ? 'photo' : 'video'), ...caption };
    if (part.kind === 'album' && Array.isArray(part.media) && part.media.length >= 2 && part.media.length <= 10) {
      return { kind: 'album', media: part.media.map((item) => {
        if (!object(item) || !['photo', 'video'].includes(item.type) || Object.hasOwn(item, 'caption')) fail();
        return { type: item.type, url: mediaUrl(item.url, item.type) };
      }), ...caption };
    }
    return fail();
  });
}

// Call only with normalized parts so invalid captions cannot be downgraded.
function deliveryPartsVersion(parts) {
  return parts.length > LEGACY_DELIVERY_PARTS || parts.some((part) => Object.hasOwn(part, 'caption')) ? 2 : 1;
}

module.exports = { extractTweetContent, normalizeTweetContent, mergeTweetContent, normalizeDeliveryParts,
  deliveryPartsVersion, mediaUrl, MAX_MEDIA, MAX_CONTENT_BYTES, MAX_DELIVERY_PARTS };
