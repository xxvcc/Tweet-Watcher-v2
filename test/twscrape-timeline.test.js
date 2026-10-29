'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUser, parseTimelinePage } = require('../lib/twscrape-timeline');

// Entirely synthetic responses: no credentials, private content or live IO.
const identity = { username: 'alice', userId: '10' };
const author = (id = '10', username = 'alice') => ({ __typename: 'User', rest_id: id,
  core: { screen_name: username, name: username === 'alice' ? 'Alice' : username } });
const tweet = (id = '2111520482914877569') => ({ __typename: 'Tweet', rest_id: id,
  legacy: { id_str: id, full_text: `Tweet ${id}`, created_at: 'Fri Oct 23 10:00:00 +0000 2026', user_id_str: '10' },
  core: { user_results: { result: author() } },
});
const item = (result) => ({ itemType: 'TimelineTweet', tweet_results: { result } });
const entry = (result) => ({ entryId: `tweet-${result.rest_id ?? result.tweet?.rest_id}`, content: { itemContent: item(result) } });
const bottom = (value = 'next') => ({ content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value } });
const moduleEntry = (...results) => ({ entryId: 'module-conversation-1', content: {
  items: results.map((result) => ({ item: { itemContent: item(result) } })),
} });
const page = (entries = [], extra = [], cursor = 'next') => ({ data: { user: { result: {
  __typename: 'User', timeline: { timeline: { instructions: [
    { type: 'TimelineAddEntries', entries: [...entries, ...(cursor === null ? [] : [bottom(cursor)])] }, ...extra,
  ] } },
} } } });
const parse = (data) => parseTimelinePage(data, identity);
const rejects = (data, code = 'TIMELINE_INCOMPLETE') => assert.throws(() => parse(data), { code });

test('valid optional X language survives parsing and missing duplicate metadata is enrichment', () => {
  const english = tweet('200'); english.legacy.lang = 'EN';
  assert.equal(parse(page([entry(english)])).tweets[0].lang, 'en');
  for (const values of [[english, tweet('200')], [tweet('200'), english]]) {
    assert.equal(parse(page(values.map(entry))).tweets[0].lang, 'en');
  }
  for (const lang of [undefined, null, 5, {}, 'en\ninvalid', 'x'.repeat(36)]) {
    const value = tweet('200'); value.legacy.lang = lang;
    assert.equal(Object.hasOwn(parse(page([entry(value)])).tweets[0], 'lang'), false);
  }
});

test('non-English language metadata follows each displayed body including expanded reposts', () => {
  for (const [lang, text] of [
    ['JA', 'これは新しいモデルです。'], ['ru', 'Это новая модель.'],
    ['ar', 'هذا نموذج جديد.'], ['fr', 'Bonjour le monde.'], ['zh-Hant', '這是新的模型。'],
  ]) {
    const value = tweet('200');
    value.legacy.lang = lang;
    value.legacy.full_text = text;
    const parsed = parse(page([entry(value)])).tweets[0];
    assert.equal(parsed.lang, lang.toLowerCase());
    assert.equal(parsed.text, text);
  }
  const outer = tweet('300');
  outer.legacy.full_text = 'RT @bob: preview…';
  outer.legacy.lang = 'zh';
  outer.legacy.retweeted_status_id_str = '200';
  outer.retweeted_status_result = { result: { rest_id: '200',
    legacy: { full_text: 'これは日本語の本文です。', lang: 'JA' } } };
  const repost = parse(page([entry(outer)])).tweets[0];
  assert.equal(repost.lang, 'ja');
  assert.equal(repost.text, 'RT @bob: これは日本語の本文です。');
  assert.equal(repost.id, '300');
  assert.equal(repost.relations.repostId, '200');
});

test('expanded repost language always matches the displayed inner body', () => {
  const outer = tweet('300'); outer.legacy.full_text = 'RT @bob: A short wrapper…'; outer.legacy.lang = 'fr';
  outer.legacy.retweeted_status_id_str = '200';
  const enriched = structuredClone(outer);
  enriched.legacy.retweeted_status_result = { result: { rest_id: '200', legacy: { full_text: 'This is the complete English body.', lang: 'en' } } };
  assert.equal(parse(page([entry(enriched)])).tweets[0].lang, 'en');
  for (const values of [[outer, enriched], [enriched, outer]]) assert.equal(parse(page(values.map(entry))).tweets[0].lang, 'en');
  delete enriched.legacy.retweeted_status_result.result.legacy.lang;
  for (const values of [[enriched], [outer, enriched], [enriched, outer]]) {
    const parsed = parse(page(values.map(entry))).tweets[0];
    assert.equal(parsed.text, 'RT @bob: This is the complete English body.');
    assert.equal(Object.hasOwn(parsed, 'lang'), false);
  }
});

test('lookup verifies modern and legacy identity and refuses account ambiguity', () => {
  const lookup = (result) => ({ data: { user: { result } } });
  assert.deepEqual(parseUser(lookup(author()), 'ALICE'), { id: '10', username: 'alice', name: 'Alice' });
  const legacy = author(); legacy.legacy = { screen_name: 'alice', name: 'Alice' }; delete legacy.core;
  assert.deepEqual(parseUser(lookup(legacy), 'alice'), { id: '10', username: 'alice', name: 'Alice' });
  assert.throws(() => parseUser(lookup(author()), 'bob'), { code: 'IDENTITY_MISMATCH' });
  const conflicting = author(); conflicting.legacy = { screen_name: 'bob' };
  assert.throws(() => parseUser(lookup(conflicting), 'alice'), { code: 'TIMELINE_INCOMPLETE' });
  for (const invalid of [null, {}, { __typename: 'UserUnavailable' }, { __typename: 'UserTombstone' }]) {
    assert.throws(() => parseUser(lookup(invalid), 'alice'));
  }
  assert.throws(() => parseUser(lookup({ ...author(), rest_id: 10 }), 'alice'));
  assert.throws(() => parseUser({ ...lookup(author()), errors: [{ message: 'not exposed' }] }, 'alice'), { code: 'GRAPHQL_ERRORS' });
});

test('retains every page entry, pins, modules and visibility wrappers with separate boundaries', () => {
  const visible = { __typename: 'TweetWithVisibilityResults', tweet: tweet('200') };
  const result = parse(page([entry(visible), moduleEntry(tweet('150'), tweet('140'))], [
    { type: 'TimelinePinEntry', entry: entry(tweet('1')) },
  ]));
  assert.deepEqual(result.tweets.map((value) => value.id), ['200', '150', '140', '1']);
  assert.deepEqual(result.boundaryIds, ['200']);
  assert.equal(result.tweets.at(-1).is_pinned, true);
  assert.equal(result.exhausted, false);
  assert.equal(result.nextCursor, 'next');
});

test('pin-only and module-only pages are preserved and cannot prove chronological coverage', () => {
  for (const fixture of [page([], [{ type: 'TimelinePinEntry', entry: entry(tweet()) }]), page([moduleEntry(tweet())])]) {
    const result = parse(fixture);
    assert.equal(result.tweets.length, 1);
    assert.deepEqual(result.boundaryIds, []);
    assert.equal(result.exhausted, false);
  }
  const pinned = entry(tweet()); pinned.content.itemContent.socialContext = { contextType: 'Pinned' };
  assert.deepEqual(parse(page([pinned])).boundaryIds, []);
});

test('normal occurrence overrides duplicate pin context without losing boundaries', () => {
  for (const pinFirst of [true, false]) {
    const fixture = page([entry(tweet('200'))], [{ type: 'TimelinePinEntry', entry: entry(tweet('200')) }]);
    if (pinFirst) fixture.data.user.result.timeline.timeline.instructions.reverse();
    const result = parse(fixture);
    assert.equal(result.tweets.length, 1);
    assert.equal(result.tweets[0].is_pinned, false);
    assert.deepEqual(result.boundaryIds, ['200']);
  }
});

test('duplicate pins and ordinary rows merge omitted profiles and retain the known display name in either order', () => {
  for (const pinFirst of [true, false]) {
    for (const pinHasProfile of [true, false]) {
      const pin = tweet('200'), ordinary = tweet('200');
      delete (pinHasProfile ? ordinary : pin).core;
      const fixture = page([entry(ordinary)], [{ type: 'TimelinePinEntry', entry: entry(pin) }]);
      if (pinFirst) fixture.data.user.result.timeline.timeline.instructions.reverse();
      const result = parse(fixture);
      assert.equal(result.tweets.length, 1);
      assert.equal(result.tweets[0].name, 'Alice');
      assert.equal(result.tweets[0].is_pinned, false);
      assert.deepEqual(result.boundaryIds, ['200']);
    }
  }
  const renamed = tweet('200'); renamed.core.user_results.result.core.name = 'Alice Renamed';
  assert.equal(parse(page([entry(tweet('200')), entry(renamed)])).tweets[0].name, 'Alice Renamed');
  const changed = tweet('200'); delete changed.core; changed.legacy.full_text = 'Changed body';
  rejects(page([entry(tweet('200')), entry(changed)]), 'TWEET_CONFLICT');
  const foreign = tweet('200'); foreign.core.user_results.result = author('20', 'bob'); foreign.legacy.user_id_str = '20';
  const conflictingAuthor = structuredClone(foreign);
  conflictingAuthor.core.user_results.result.rest_id = '21'; conflictingAuthor.legacy.user_id_str = '21';
  rejects(page([entry(foreign), entry(conflictingAuthor)]), 'TWEET_CONFLICT');
});

test('same-ID content changes are explicit conflicts instead of silent deduplication', () => {
  for (const mutate of [
    (value) => { value.legacy.full_text = 'Changed body'; },
    (value) => { value.legacy.in_reply_to_status_id_str = '7'; },
    (value) => { value.legacy.created_at = 'Sat Oct 24 10:00:00 +0000 2026'; },
  ]) {
    const changed = tweet(); mutate(changed);
    rejects(page([entry(tweet()), entry(changed)]), 'TWEET_CONFLICT');
  }
  assert.equal(parse(page([entry(tweet()), entry(tweet())])).tweets.length, 1);
});

test('processes all AddEntries instructions even when the first is empty', () => {
  const fixture = page([entry(tweet())]);
  fixture.data.user.result.timeline.timeline.instructions.unshift({ type: 'TimelineAddEntries', entries: [] });
  assert.equal(parse(fixture).tweets.length, 1);
  assert.equal(parse(fixture).exhausted, false);
});

test('empty cursor pages remain nonterminal; only recognized terminal responses exhaust history', () => {
  const empty = parse(page([], [], null));
  assert.deepEqual(empty, { tweets: [], nextCursor: null, exhausted: true, boundaryIds: [] });
  const notEmpty = parse(page());
  assert.equal(notEmpty.exhausted, false);
  assert.equal(notEmpty.nextCursor, 'next');
  const freshEmpty = page([], [{ type: 'TimelineClearCache' }], null);
  assert.equal(parse(freshEmpty).exhausted, true, 'ClearCache does not negate an explicit wholly empty AddEntries response');
  const ended = parse(page([entry(tweet())], [{ type: 'TimelineTerminateTimeline', direction: 'Bottom' }], null));
  assert.equal(ended.exhausted, true);
  assert.equal(ended.nextCursor, null);
  const withCursor = parse(page([entry(tweet())], [{ type: 'TimelineTerminateTimeline', direction: 'Bottom' }]));
  assert.equal(withCursor.exhausted, true);
  assert.equal(withCursor.nextCursor, null);
  rejects(page([entry(tweet())], [], null));
  rejects(page([], [{ type: 'TimelinePinEntry', entry: entry(tweet()) }], null));
  rejects(page([bottom('')], [], null));
  rejects(page([], [{ type: 'TimelineTerminateTimeline', direction: 'Left' }], null));
});

test('top cursor, unknown cursor, conflicting cursor and unknown instructions never prove an end', () => {
  const top = bottom('top'); top.content.cursorType = 'Top';
  rejects(page([top], [], null));
  const gap = bottom('gap'); gap.content.cursorType = 'ShowMore';
  rejects(page([gap]));
  rejects(page([bottom('other')]));
  rejects(page([], [{ type: 'UnknownInstructions', entries: [entry(tweet())] }]));
  const cleared = page(); cleared.data.user.result.timeline.timeline.instructions = [{ type: 'TimelineClearCache' }];
  rejects(cleared);
  const topOnly = page(); topOnly.data.user.result.timeline.timeline.instructions = [{ type: 'TimelineTerminateTimeline', direction: 'Top' }];
  rejects(topOnly);
});

test('module updates and replacements retain evidence without creating chronological boundaries', () => {
  const result = parse(page([], [
    { type: 'TimelineReplaceEntry', entry: entry(tweet('1')) },
    { type: 'TimelineAddToModule', moduleItems: [{ item: { itemContent: item(tweet('2')) } }] },
  ]));
  assert.deepEqual(result.tweets.map((value) => value.id), ['1', '2']);
  assert.deepEqual(result.boundaryIds, []);
  rejects(page([], [{ type: 'TimelineAddToModule', moduleItems: [] }]));
});

test('verified own-user ID fills missing repeated profile but cannot invent another author', () => {
  for (const profile of [undefined, {}, { __typename: 'User', rest_id: '10' }]) {
    const missing = tweet(); missing.core.user_results.result = profile;
    const result = parse(page([entry(missing)]));
    assert.equal(result.tweets[0].url, `https://x.com/alice/status/${missing.rest_id}`);
    assert.equal(result.tweets[0].name, 'alice');
    assert.deepEqual(result.boundaryIds, [missing.rest_id]);
  }
  const foreign = tweet(); delete foreign.core; foreign.legacy.user_id_str = '20';
  rejects(page([entry(foreign)]));
  const absent = tweet(); delete absent.core; delete absent.legacy.user_id_str;
  rejects(page([entry(absent)]));
  const mismatch = tweet(); mismatch.core.user_results.result.core.screen_name = 'bob';
  rejects(page([entry(mismatch)]), 'IDENTITY_MISMATCH');
  const conflictingId = tweet(); conflictingId.legacy.user_id_str = '20';
  rejects(page([entry(conflictingId)]));
  const renamedIdentity = tweet(); renamedIdentity.legacy.user_id_str = '20'; renamedIdentity.core.user_results.result.rest_id = '20';
  rejects(page([entry(renamedIdentity)]), 'IDENTITY_MISMATCH');
});

test('foreign conversation context is retained without allowing its ID to establish coverage', () => {
  const foreign = tweet('1'); foreign.core.user_results.result = author('20', 'bob'); foreign.legacy.user_id_str = '20';
  const result = parse(page([entry(tweet('200')), moduleEntry(foreign), entry(foreign)]));
  assert.equal(result.tweets.length, 2);
  assert.deepEqual(result.boundaryIds, ['200']);
  assert.equal(result.tweets[1].url, 'https://x.com/bob/status/1');
});

test('recommendation and unknown social contexts never establish chronological coverage', () => {
  for (const context of ['Like', 'Recommendation', 'Follow', 'FutureContext']) {
    const contextual = entry(tweet('1'));
    contextual.content.itemContent.socialContext = { contextType: context };
    const result = parse(page([entry(tweet('200')), contextual]));
    assert.deepEqual(result.tweets.map((value) => value.id), ['200', '1']);
    assert.deepEqual(result.boundaryIds, ['200']);
  }
  const repost = tweet('201'); repost.legacy.retweeted_status_result = { result: tweet('1') };
  const contextual = entry(repost); contextual.content.itemContent.socialContext = { contextType: 'Retweet' };
  assert.deepEqual(parse(page([contextual])).boundaryIds, ['201']);
  delete repost.legacy.retweeted_status_result;
  assert.deepEqual(parse(page([contextual])).boundaryIds, []);
});

test('out-of-order own posts cannot use an old entry as a false coverage boundary', () => {
  rejects(page([entry(tweet('100')), entry(tweet('300'))]));
  const split = page([entry(tweet('100'))], [{ type: 'TimelineAddEntries', entries: [entry(tweet('300'))] }]);
  rejects(split);
  const result = parse(page([entry(tweet('300')), moduleEntry(tweet('400')), entry(tweet('100'))], [
    { type: 'TimelinePinEntry', entry: entry(tweet('500')) },
  ]));
  assert.deepEqual(result.boundaryIds, ['300', '100']);
});

test('preserves string reply, quote, repost and edit identities without expanding quoted bodies', () => {
  const value = tweet('2111520482914877569');
  value.legacy.in_reply_to_status_id_str = '2111520482914877000';
  value.legacy.quoted_status_id_str = '2111520482914877001';
  value.quoted_status_result = { result: { __typename: 'Tweet', rest_id: '2111520482914877001', legacy: { created_at: 'bad' } } };
  value.legacy.retweeted_status_result = { result: { __typename: 'TweetWithVisibilityResults', tweet: { rest_id: '2111520482914877002' } } };
  value.edit_control = { edit_control_initial: { edit_tweet_ids: ['2111520482914877003', value.rest_id] } };
  const result = parse(page([entry(value)])).tweets[0];
  assert.equal(result.id, value.rest_id);
  assert.equal(result.is_rt, true);
  assert.deepEqual(result.relations, { replyToId: '2111520482914877000', quoteId: '2111520482914877001',
    repostId: '2111520482914877002', editIds: ['2111520482914877003', value.rest_id] });
  assert.equal(parse(page([entry(value)])).tweets.length, 1);
});

test('embedded quote does not suppress the same post when it is an independent entry', () => {
  const outer = tweet('200'); outer.legacy.quoted_status_id_str = '100'; outer.quoted_status_result = { result: tweet('100') };
  const result = parse(page([entry(outer), entry(tweet('100'))]));
  assert.deepEqual(result.tweets.map((value) => value.id), ['200', '100']);
  const repost = tweet('300'); repost.legacy.retweeted_status_result = { result: tweet('100') };
  assert.deepEqual(parse(page([entry(repost), entry(tweet('100'))])).tweets.map((value) => value.id), ['300', '100']);
});

test('truncated reposts recover complete legacy or note text without changing outer identity or relationships', () => {
  for (const note of [false, true]) {
    const outer = tweet('300'); outer.legacy.full_text = 'RT @bob: Full…';
    outer.legacy.truncated = true;
    outer.legacy.in_reply_to_status_id_str = '290';
    const original = tweet('200'); original.legacy.user_id_str = '20';
    original.core.user_results.result = author('20', 'bob');
    original.legacy.full_text = note ? 'Short preview…' : 'Full original &amp; uncut';
    if (note) {
      original.legacy.truncated = true;
      original.note_tweet = { note_tweet_results: { result: { text: 'Full original &amp; ' + '字'.repeat(20000) } } };
    }
    outer.legacy.retweeted_status_result = { result: { __typename: 'TweetWithVisibilityResults', tweet: original } };
    const result = parse(page([entry(outer)])).tweets[0];
    assert.equal(result.text, 'RT @bob: Full original & ' + (note ? '字'.repeat(20000) : 'uncut'));
    assert.equal(result.id, '300');
    assert.equal(result.author_username, 'alice');
    assert.equal(result.url, 'https://x.com/alice/status/300');
    assert.equal(result.time, outer.legacy.created_at);
    assert.equal(result.is_rt, true);
    assert.equal(result.relations.repostId, '200');
    assert.equal(result.relations.replyToId, '290');
  }
});

test('unavailable or incomplete referenced bodies preserve the parent and its known repost identity', () => {
  for (const nested of [
    { __typename: 'TweetTombstone' },
    { rest_id: '200' },
    { rest_id: '200', legacy: { full_text: 'Preview…', truncated: true } },
    { rest_id: '200', legacy: { full_text: 'Preview…' }, note_tweet: {} },
    { rest_id: '200', legacy: { full_text: 'Untrusted author' }, core: { user_results: { result: author('20', 'charlie') } } },
  ]) {
    const outer = tweet('300'); outer.legacy.full_text = 'RT @bob: Parent preview…';
    outer.legacy.retweeted_status_id_str = '200';
    outer.legacy.retweeted_status_result = { result: nested };
    const result = parse(page([entry(outer)])).tweets[0];
    assert.equal(result.text, outer.legacy.full_text);
    assert.equal(result.relations.repostId, '200');
    outer.legacy.truncated = true;
    rejects(page([entry(outer)]));
  }
  const outer = tweet('300'); outer.legacy.full_text = 'RT @bob: Parent preview…';
  outer.legacy.retweeted_status_result = { result: { rest_id: '200', legacy: { full_text: 'Full without repeated author profile' } } };
  assert.equal(parse(page([entry(outer)])).tweets[0].text, 'RT @bob: Full without repeated author profile');
});

test('duplicate reposts merge optional body enrichment but reject changed known body or identity', () => {
  const outer = tweet('300'); outer.legacy.full_text = 'RT @bob: Preview…';
  outer.legacy.retweeted_status_id_str = '200';
  const enriched = structuredClone(outer);
  enriched.legacy.retweeted_status_result = { result: { rest_id: '200', legacy: { full_text: 'Complete original' } } };
  for (const records of [[outer, enriched], [enriched, outer]]) {
    assert.equal(parse(page(records.map(entry))).tweets[0].text, 'RT @bob: Complete original');
  }
  const changed = structuredClone(enriched);
  changed.legacy.retweeted_status_result.result.legacy.full_text = 'Changed original';
  rejects(page([entry(enriched), entry(changed)]), 'TWEET_CONFLICT');
  const conflicting = structuredClone(enriched);
  conflicting.legacy.retweeted_status_result.result.legacy.id_str = '201';
  rejects(page([entry(conflicting)]));
});

test('recovered long repost text survives queue serialization and reload before Telegram display truncation', () => {
  const { createOutbox } = require('../lib/outbox');
  const { formatTweet } = require('../lib/telegram');
  const files = new Map();
  const store = {
    readState(name) { return files.has(name) ? { status: 'ok', value: JSON.parse(files.get(name)) } : { status: 'missing' }; },
    writeJSON(name, value) { files.set(name, JSON.stringify(value)); },
  };
  const outer = tweet('300'); outer.legacy.full_text = 'RT @bob: Preview…';
  const fullText = 'RT @bob: ' + '字'.repeat(20000) + 'END_MARKER';
  outer.legacy.retweeted_status_result = { result: { rest_id: '200', legacy: {},
    note_tweet: { note_tweet_results: { result: { text: fullText.slice('RT @bob: '.length) } } } } };
  const box = createOutbox(store, 200);
  box.flush(); box.baseline('alice', ['100']);
  box.capture('alice', parse(page([entry(outer)])).tweets, 'a'.repeat(64), null);
  const restored = createOutbox(store, 200).get('alice').pending[0];
  assert.equal(restored.text, fullText);
  assert.equal(restored.relations.repostId, '200');
  assert.equal(restored.id, '300');
  const formatted = formatTweet(restored, 'alice');
  assert.ok(formatted.length <= 4096);
  assert.match(formatted, /RT @bob: 字/);
  assert.match(formatted, /内容已截断/);
});

test('unexpected promoted entries still reject the entire page without using an advertising boundary', () => {
  for (const level of ['entry', 'content', 'item']) {
    const ad = entry(tweet('200'));
    const target = level === 'entry' ? ad : level === 'content' ? ad.content : ad.content.itemContent;
    target.promotedMetadata = { advertiserId: '10' };
    rejects(page([entry(tweet('300')), ad]));
  }
});

test('deleted quote retains explicit link and malformed or conflicting relationship identity fails', () => {
  const value = tweet(); value.legacy.quoted_status_id_str = '100';
  value.quoted_status_result = { result: { __typename: 'TweetTombstone' } };
  assert.equal(parse(page([entry(value)])).tweets[0].relations.quoteId, '100');
  for (const mutate of [
    (bad) => { bad.legacy.in_reply_to_status_id_str = 9007199254740994; },
    (bad) => { bad.legacy.quoted_status_id_str = '100'; bad.quoted_status_result = { result: { rest_id: '101' } }; },
    (bad) => { bad.quoted_status_result = { result: {} }; },
    (bad) => { bad.legacy.is_quote_status = true; },
    (bad) => { bad.edit_control = { edit_tweet_ids: ['100'] }; },
    (bad) => { bad.edit_control = { edit_tweet_ids: [bad.rest_id, bad.rest_id] }; },
    (bad) => { bad.edit_control = { edit_tweet_ids: [9007199254740994] }; },
  ]) { const bad = tweet(); mutate(bad); rejects(page([entry(bad)])); }
});

test('long tweets, explicit empty media text and escaped text are preserved without truncation', () => {
  const long = tweet(); long.note_tweet = { note_tweet_results: { result: { text: '字'.repeat(20000) } } };
  assert.equal(parse(page([entry(long)])).tweets[0].text.length, 20000);
  const empty = tweet(); empty.legacy.full_text = '';
  assert.equal(parse(page([entry(empty)])).tweets[0].text, '');
  const escaped = tweet(); escaped.legacy.full_text = '&lt;tag&gt; &amp; &quot;text&quot;';
  assert.equal(parse(page([entry(escaped)])).tweets[0].text, '<tag> & "text"');
  for (const mutate of [
    (bad) => { delete bad.legacy.full_text; },
    (bad) => { bad.note_tweet = {}; },
    (bad) => { bad.note_tweet = { note_tweet_results: { result: {} } }; },
    (bad) => { bad.legacy.full_text = 'x'.repeat(100001); },
  ]) { const bad = tweet(); mutate(bad); rejects(page([entry(bad)])); }
});

test('explicitly truncated ordinary and quote bodies require a complete note before establishing coverage', () => {
  for (const quoted of [false, true]) {
    const value = tweet('200'); value.legacy.full_text = 'Only a preview…'; value.legacy.truncated = true;
    if (quoted) {
      value.legacy.is_quote_status = true;
      value.legacy.quoted_status_id_str = '100';
      value.quoted_status_result = { result: { __typename: 'TweetTombstone' } };
    }
    for (const note of [undefined, null, {}, { note_tweet_results: { result: {} } }]) {
      value.note_tweet = note;
      rejects(page([entry(value), entry(tweet('100'))]));
    }
    value.note_tweet = { note_tweet_results: { result: { text: 'Complete body &amp; ending.' } } };
    const recovered = parse(page([entry(value), entry(tweet('100'))]));
    assert.equal(recovered.tweets[0].text, 'Complete body & ending.');
    assert.deepEqual(recovered.boundaryIds, ['200', '100']);
    assert.equal(recovered.tweets[0].relations.quoteId, quoted ? '100' : null);
  }
  const complete = tweet('200'); complete.legacy.full_text = 'Intentional ending…';
  assert.equal(parse(page([entry(complete)])).tweets[0].text, complete.legacy.full_text,
    'punctuation alone is not proof of truncation');
});

test('any malformed record rejects the entire otherwise valid page without returning partial tweets', () => {
  for (const mutate of [
    (bad) => { bad.rest_id = 9007199254740994; },
    (bad) => { bad.legacy.id_str = '123'; },
    (bad) => { bad.legacy.created_at = 'not a date'; },
    (bad) => { bad.legacy.created_at = '1'; },
    (bad) => { bad.legacy.created_at = 'Fri Feb 31 10:00:00 +0000 2026'; },
    (bad) => { delete bad.legacy.created_at; },
    (bad) => { delete bad.legacy; },
    (bad) => { bad.core.user_results.result.rest_id = 10; },
    (bad) => { bad.core.user_results.result = 'malformed'; },
  ]) { const bad = tweet(); mutate(bad); rejects(page([entry(tweet('300')), entry(bad)])); }
  for (const unavailable of [{ __typename: 'TweetTombstone' }, { __typename: 'TweetUnavailable' }, { __typename: 'TweetWithVisibilityResults' }]) {
    rejects(page([entry(tweet('300')), entry(unavailable)]), 'TWEET_UNAVAILABLE');
  }
  const partial = page([entry(tweet())]); partial.errors = [{ message: 'private upstream body' }];
  assert.throws(() => parse(partial), (error) => error.code === 'GRAPHQL_ERRORS' && !error.message.includes('private'));
  for (const errors of [null, {}, 'bad']) rejects({ ...page([entry(tweet())]), errors }, 'GRAPHQL_ERRORS');
});

test('malformed modules, item shapes, identities and resource overflows fail closed', () => {
  for (const invalid of [null, { content: { items: [] } }, { content: { items: [null] } },
    { content: { itemContent: { itemType: 'TimelineTweet' } } },
    { content: { cursorType: 'Bottom', value: 'cursor', itemContent: item(tweet()) } },
    { content: { entryType: 'UnknownChronology', itemContent: item(tweet()) } },
    { content: { __typename: 'TimelineTimelineModule', itemContent: item(tweet()) } },
    { content: { itemContent: { ...item(tweet()), __typename: 'UnknownItem' } } },
    { entryId: 'tweet-123', content: { itemContent: item(tweet()) } },
  ]) rejects(page([invalid]));
  const badIdentity = page(); badIdentity.data.user.result.rest_id = '20';
  rejects(badIdentity, 'IDENTITY_MISMATCH');
  rejects(page(Array.from({ length: 501 }, (_, index) => entry(tweet(String(501 - index))))));
  const badUser = page(); badUser.data.user.result.__typename = 'UserUnavailable';
  rejects(badUser, 'USER_UNAVAILABLE');
  rejects({}, 'USER_UNAVAILABLE');
});
