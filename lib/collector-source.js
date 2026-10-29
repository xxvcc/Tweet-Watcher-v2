'use strict';

const { createHash } = require('node:crypto');
const USERNAME = /^[A-Za-z0-9_]{1,15}$/;
const ID = /^[1-9][0-9]{0,31}$/;
function invalid() { return Object.assign(new Error('采集来源配置无效'), { code: 'INVALID_INPUT' }); }
function normalizeSource(value = {}) {
  const source_type = value.source_type ?? 'user';
  if (source_type === 'user') {
    if (!USERNAME.test(value.username || '') || !['posts', 'replies'].includes(value.timeline_mode ?? 'posts')) throw invalid();
    return { source_type, username: value.username, timeline_mode: value.timeline_mode ?? 'posts' };
  }
  if (source_type === 'list' && typeof value.list_id === 'string' && ID.test(value.list_id)) {
    return { source_type, list_id: value.list_id };
  }
  if (source_type === 'search' && typeof value.query === 'string' && value.query.trim()
      && value.query.length <= 512 && value.query.isWellFormed() && !/[\u0000-\u001f\u007f]/.test(value.query)) {
    return { source_type, query: value.query };
  }
  throw invalid();
}
function sourceKey(source) {
  const value = normalizeSource(source);
  if (value.source_type === 'user') return (value.timeline_mode === 'replies' ? 'replies:' : '') + value.username.toLowerCase();
  if (value.source_type === 'list') return 'list:' + value.list_id;
  return 'search:' + createHash('sha256').update(value.query).digest('hex').slice(0, 24);
}
function sourceOperation(source) {
  if (source.source_type === 'list') return 'ListLatestTweetsTimeline';
  if (source.source_type === 'search') return 'SearchTimeline';
  return source.timeline_mode === 'replies' ? 'UserTweetsAndReplies' : 'UserTweets';
}
function validProxy(value) {
  if (value === '') return true;
  if (typeof value !== 'string' || !value.isWellFormed() || value.length > 2048 || /[\x00-\x20\x7f\\?#]/.test(value)) return false;
  try {
    const url = new URL(value);
    // An explicit port makes the selected proxy endpoint unambiguous. URL
    // canonicalization drops default ports, so check the original authority.
    return ['http:', 'https:'].includes(url.protocol)
      && !!url.hostname && !url.username && !url.password && ['', '/'].includes(url.pathname)
      && /:\d+\/?$/.test(value) && Number(value.match(/:(\d+)\/?$/)[1]) >= 1
      && Number(value.match(/:(\d+)\/?$/)[1]) <= 65535;
  } catch { return false; }
}
module.exports = { normalizeSource, sourceKey, sourceOperation, validProxy };
