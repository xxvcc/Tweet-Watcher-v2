'use strict';
const crypto = require('node:crypto');
function filterTweet(tweet, filters = {}) {
  const reply = !!tweet.relations?.replyToId;
  const quote = !!tweet.relations?.quoteId;
  const repost = tweet.is_rt === true || !!tweet.relations?.repostId;
  if (repost && filters.reposts === false) return 'repost-disabled';
  if (reply && filters.replies === false) return 'reply-disabled';
  if (quote && filters.quotes === false) return 'quote-disabled';
  if (!reply && !quote && !repost && filters.originals === false) return 'original-disabled';
  const text = String(tweet.text || '').normalize('NFKC').toLocaleLowerCase('und');
  const contains = (keyword) => text.includes(keyword.normalize('NFKC').toLocaleLowerCase('und'));
  if ((filters.exclude || []).some(contains)) return 'excluded-keyword';
  if (filters.include?.length && !filters.include.some(contains)) return 'required-keyword-missing';
  return null;
}
function ruleVersion(filters = {}) {
  return crypto.createHash('sha256').update(JSON.stringify({
    originals: filters.originals !== false, reposts: filters.reposts !== false,
    replies: filters.replies !== false, quotes: filters.quotes !== false,
    include: [...(filters.include || [])].sort(), exclude: [...(filters.exclude || [])].sort(),
  })).digest('hex');
}
module.exports = { filterTweet, ruleVersion };
