'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractTweetContent, normalizeTweetContent, mergeTweetContent, normalizeDeliveryParts } = require('../lib/tweet-content');

const photo = 'https://pbs.twimg.com/media/example.jpg';
const video = 'https://video.twimg.com/ext_tw_video/123/pu/vid/320x180/small.mp4?tag=12';
const quoted = { id: '22', url: 'https://x.com/i/status/22', text: 'A & B', author_username: 'alice' };

test('optional raw evidence extracts controlled media, quote, article and conversation metadata', () => {
  const result = extractTweetContent({ rest_id: '30', legacy: {
    conversation_id_str: '10', in_reply_to_screen_name: 'bob', quoted_status_id_str: '22', favorite_count: 42,
    extended_entities: { media: [
      { type: 'photo', media_url_https: photo, ext_alt_text: 'A photo' },
      { type: 'video', media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img/preview.jpg',
        video_info: { duration_millis: 1200, variants: [
          { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/ext_tw_video/123/pu/pl/video.m3u8' },
          { content_type: 'video/mp4', bitrate: 2000000, url: video.replace('small', 'large') },
          { content_type: 'video/mp4', bitrate: 200000, url: video },
        ] } },
    ] },
  }, views: { count: '123' }, quoted_status_result: { result: { rest_id: '22', legacy: { full_text: 'A &amp; B', lang: 'en' },
    core: { user_results: { result: { core: { screen_name: 'alice' } } } } } },
  article: { article_results: { result: { rest_id: '99', title: 'Article', preview_text: 'Preview',
    content_state: { blocks: [{ text: 'First paragraph' }, { text: 'Second paragraph' }] },
    cover_media: { media_info: { original_img_url: photo } } } } } });
  assert.equal(result.conversationId, '10');
  assert.equal(result.replyToUsername, 'bob');
  assert.deepEqual(result.media.map((item) => [item.type, item.url, item.sourceId]), [['photo', photo, '30'], ['video', video, '30']]);
  assert.equal(result.media[1].durationMs, 1200);
  assert.equal(result.quoted.text, 'A & B');
  assert.equal(result.quoted.unavailable, false);
  assert.equal(result.article.text, 'First paragraph\nSecond paragraph');
  assert.deepEqual(result.metrics, { likes: 42, views: 123 });
});

test('bad optional fields do not discard valid media or invent unavailable quote text', () => {
  const result = extractTweetContent({ rest_id: '30', legacy: { quoted_status_id_str: '22', extended_entities: { media: [
    { type: 'photo', media_url_https: 'http://127.0.0.1/private' },
    { type: 'photo', media_url_https: photo },
  ] } }, quoted_status_result: { result: { rest_id: '22', legacy: { full_text: 'A truncated preview', truncated: true } } },
  article: { article_results: { result: { rest_id: '99', title: 'Article', preview_text: 'Preview',
    content_state: { blocks: [{ text: 'x'.repeat(30001) }] } } } } });
  assert.equal(result.media.length, 1);
  assert.equal(result.quoted.unavailable, true);
  assert.equal(result.quoted.text, undefined);
  assert.equal(result.article.previewText, 'Preview');
  assert.equal(result.article.text, undefined);
});

test('combined optional content limits retain article preview instead of rejecting the parent post', () => {
  const result = extractTweetContent({ rest_id: '30', legacy: { quoted_status_id_str: '22', extended_entities: {
    media: Array.from({ length: 10 }, (_, index) => ({ type: 'photo', media_url_https: photo.replace('example', String(index)), ext_alt_text: '图'.repeat(2000) })),
  } }, quoted_status_result: { result: { rest_id: '22', legacy: { full_text: '引'.repeat(12000) } } },
  article: { article_results: { result: { rest_id: '99', title: 'Article', preview_text: '预'.repeat(4000),
    content_state: { blocks: [{ text: '文'.repeat(30000) }] } } } } });
  assert.equal(result.media.length, 10);
  assert.equal(result.quoted.text.length, 12000);
  assert.equal(result.article.previewText.length, 4000);
  assert.equal(result.article.text, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 128 * 1024);
});

test('expanded repost presentation follows the verified inner ID without changing outer conversation evidence', () => {
  const raw = { rest_id: '30', legacy: { conversation_id_str: '30' }, retweeted_status_result: { result: {
    rest_id: '20', legacy: { conversation_id_str: '20', extended_entities: { media: [{ type: 'photo', media_url_https: photo }] } },
  } } };
  assert.equal(extractTweetContent(raw, { repostId: '20', useRepostBody: true }).media[0].sourceId, '20');
  assert.equal(extractTweetContent(raw, { repostId: '20', useRepostBody: true }).conversationId, '30');
  assert.equal(extractTweetContent(raw, { repostId: '21', useRepostBody: true }).media, undefined);
  assert.equal(extractTweetContent(raw).media, undefined);
});

test('persisted metadata rejects unsafe URLs, mismatched identities and resource overflows', () => {
  for (const url of ['http://pbs.twimg.com/media/example.jpg', 'https://pbs.twimg.com.evil.test/media/a.jpg',
    'https://alice:secret@pbs.twimg.com/media/a.jpg', 'https://pbs.twimg.com:444/media/a.jpg',
    'https://pbs.twimg.com/media/a.jpg#fragment', 'https://127.0.0.1/media/a.jpg', 'https://pbs.twimg.com/other/a.jpg']) {
    assert.throws(() => normalizeTweetContent({ media: [{ type: 'photo', url }] }), /附加内容/);
  }
  assert.throws(() => normalizeTweetContent({ quoted: { ...quoted, url: 'https://x.com/i/status/23' } }));
  assert.throws(() => normalizeTweetContent({ article: { id: '99', title: 'Article', url: 'https://x.com/settings' } }));
  assert.throws(() => normalizeTweetContent({ media: Array.from({ length: 11 }, () => ({ type: 'photo', url: photo })) }));
  assert.throws(() => normalizeTweetContent({ quoted: { ...quoted, text: '\ud800' } }));
  assert.throws(() => normalizeTweetContent({ metrics: { views: Number.MAX_SAFE_INTEGER + 1 } }));
  assert.throws(() => normalizeDeliveryParts([{ kind: 'album', media: [{ type: 'photo', url: photo }] }]));
});

test('optional omissions merge both ways, metrics refresh, known quote and article bodies cannot silently change', () => {
  const content = { quoted, media: [{ type: 'photo', url: photo }], metrics: { likes: 1 } };
  assert.deepEqual(mergeTweetContent(undefined, content), normalizeTweetContent(content));
  assert.deepEqual(mergeTweetContent(content, undefined), normalizeTweetContent(content));
  const partial = { quoted: { id: '22', url: quoted.url, unavailable: true }, metrics: { likes: 2, views: 7 } };
  const merged = mergeTweetContent(content, partial);
  assert.equal(merged.quoted.text, 'A & B');
  assert.equal(merged.quoted.unavailable, false);
  assert.deepEqual(merged.metrics, { likes: 2, views: 7 });
  assert.throws(() => mergeTweetContent(content, { quoted: { ...quoted, text: 'changed' } }), { code: 'TWEET_CONFLICT' });
  assert.throws(() => mergeTweetContent({ article: { id: '99', title: 'Title', text: 'first' } },
    { article: { id: '99', title: 'Title', text: 'changed' } }), { code: 'TWEET_CONFLICT' });
});

test('bounded thread metadata retains string identities, strips nesting and rejects conflicting bodies', () => {
  const entry = { id: '40', text: 'A reply', url: 'https://x.com/bob/status/40', author_username: 'bob', lang: 'EN',
    content: { media: [{ type: 'photo', url: photo }] } };
  const normalized = normalizeTweetContent({ thread: [entry] });
  assert.equal(normalized.thread[0].lang, 'en');
  assert.equal(normalized.thread[0].content, undefined);
  assert.throws(() => normalizeTweetContent({ thread: [entry, entry] }));
  assert.throws(() => normalizeTweetContent({ thread: [{ ...entry, text: 'x'.repeat(12001) }] }));
  assert.throws(() => mergeTweetContent(normalized, { thread: [{ ...entry, text: 'edited' }] }), { code: 'TWEET_CONFLICT' });
});
