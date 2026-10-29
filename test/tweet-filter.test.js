'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { filterTweet, ruleVersion } = require('../lib/tweet-filter');
test('keyword filters use normalized case-insensitive literal terms and exclude takes priority', () => {
  assert.equal(filterTweet({ text: 'ＡＩ Release' }, { include: ['ai'] }), null);
  assert.equal(filterTweet({ text: 'AI release spam' }, { include: ['AI'], exclude: ['spam'] }), 'excluded-keyword');
  assert.equal(filterTweet({ text: 'hello' }, { include: ['AI'] }), 'required-keyword-missing');
  assert.equal(filterTweet({ text: 'hello' }, { exclude: ['.*'] }), null);
});
test('overlapping reply/quote types honor every disabled type and defaults preserve old behavior', () => {
  const quoteReply = { text: 'hello', relations: { replyToId: '1', quoteId: '2' } };
  assert.equal(filterTweet(quoteReply, { quotes: false }), 'quote-disabled');
  assert.equal(filterTweet(quoteReply, { replies: false }), 'reply-disabled');
  assert.equal(filterTweet(quoteReply, { originals: false }), null);
  assert.equal(filterTweet({ text: 'hello' }, { originals: false }), 'original-disabled');
  assert.equal(filterTweet({ text: 'hello', is_rt: true }), null);
  assert.equal(ruleVersion({ include: ['a', 'b'] }), ruleVersion({ include: ['b', 'a'] }));
  assert.notEqual(ruleVersion({}), ruleVersion({ replies: false }));
});
