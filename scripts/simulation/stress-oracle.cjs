'use strict';

// The oracle describes provider-visible effects independently of outbox state.
// All identities, posts and CDN paths are synthetic and unique to this run.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const descending = (a, b) => BigInt(a.rest_id) > BigInt(b.rest_id) ? -1 : BigInt(a.rest_id) < BigInt(b.rest_id) ? 1 : 0;

function mediaFor(id, kind) {
  const photo = (index) => ({ type: 'photo', media_url_https: `https://pbs.twimg.com/media/stress-${id}-${index}.jpg`, ext_alt_text: 'Synthetic photo' });
  if (kind === 1) return [photo(1)];
  if (kind === 2) return [photo(1), photo(2)];
  if (kind === 3 || kind === 4) return [{ type: kind === 3 ? 'video' : 'animated_gif',
    media_url_https: `https://pbs.twimg.com/ext_tw_video_thumb/${id}/pu/img/stress.jpg`,
    video_info: { duration_millis: 1000, variants: [{ content_type: 'video/mp4', bitrate: 200000,
      url: kind === 3 ? `https://video.twimg.com/ext_tw_video/${id}/pu/vid/stress.mp4`
        : `https://video.twimg.com/tweet_video/stress-${id}.mp4` }] } }];
  return undefined;
}
function mediaId(url) {
  const match = String(url).match(/(?:\/media\/stress-|\/ext_tw_video\/|\/tweet_video\/stress-)(\d+)/);
  assert.ok(match, 'provider received an unexpected media URL');
  return match[1];
}
function providerPart(call) {
  const fields = call.fields || call.body;
  if (call.method === 'sendMessage') {
    const match = fields.text.match(/https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/(\d+)/);
    assert.ok(match, 'provider received an unexpected message without its original post URL');
    return { id: match[1], key: `${match[1]}/text` };
  }
  if (call.method === 'sendMediaGroup') {
    const media = JSON.parse(fields.media);
    assert.ok(Array.isArray(media) && media.length >= 2);
    const ids = new Set(media.map((item) => mediaId(item.media)));
    assert.equal(ids.size, 1, 'one album cannot mix unrelated posts');
    const id = [...ids][0];
    return { id, key: `${id}/album/${hash(media.map((item) => [item.type, item.media]))}` };
  }
  const field = { sendPhoto: 'photo', sendVideo: 'video', sendAnimation: 'animation' }[call.method];
  assert.ok(field, 'provider received an unexpected Telegram method');
  const id = mediaId(fields[field]);
  return { id, key: `${id}/${field}/${hash(fields[field])}` };
}
function expectedParts(raw) {
  const id = raw.rest_id;
  const media = raw.legacy.extended_entities?.media || [];
  // Generated stress bodies (including their optional translation) fit the
  // caption limit, so a media post has one combined provider-visible effect.
  const keys = media.length ? [] : [`${id}/text`];
  if (media.length > 1) {
    assert.ok(media.every((item) => item.type === 'photo'), 'stress albums contain two known photos');
    keys.push(`${id}/album/${hash(media.map((item) => ['photo', item.media_url_https]))}`);
  } else if (media.length) {
    const item = media[0];
    const kind = item.type === 'animated_gif' ? 'animation' : item.type;
    const url = kind === 'photo' ? item.media_url_https : item.video_info.variants[0].url;
    keys.push(`${id}/${kind}/${hash(url)}`);
  }
  return keys;
}

function createScenario({ tweet, idAt, rounds = 20, batch = 5, epoch = Date.now() - 60000 }) {
  const specs = [
    { key: 'user:alice', username: 'alice', config: { username: 'alice' } },
    { key: 'user:bob', username: 'bob', config: { username: 'bob' } },
    { key: 'user:carol', username: 'carol', config: { username: 'carol' } },
    { key: 'user:dave', username: 'dave', config: { username: 'dave' } },
    { key: 'replies:alice', username: 'alice', config: { username: 'alice', source_type: 'user', timeline_mode: 'replies' } },
    { key: 'list:77', username: 'listone', config: { source_type: 'list', list_id: '77' } },
    { key: 'list:88', username: 'listtwo', config: { source_type: 'list', list_id: '88' } },
    { key: 'search:stress topic', username: 'finder', config: { source_type: 'search', query: 'stress topic' } },
  ];
  const sources = new Map(), posts = new Map(), published = new Set();
  const waves = Array.from({ length: rounds }, () => []);
  let serial = 0, late;
  for (let index = 0; index < specs.length; index++) {
    const spec = specs[index];
    sources.set(spec.key, [tweet(idAt(epoch, index + 1), spec.username, { text: `Synthetic baseline ${spec.key}` })]);
  }
  for (let wave = 0; wave < rounds; wave++) {
    for (const spec of specs) for (let index = 0; index < batch; index++) {
      const number = ++serial;
      const id = idAt(epoch + 1000 + wave * 1000, number);
      const dropped = number % 10 === 0;
      const raw = tweet(id, spec.username, { text: `Synthetic stress ${dropped ? 'stress_drop' : 'stress_keep'} update ${id}.`,
        media: mediaFor(id, number % 6), ...(spec.key.startsWith('replies:') ? { replyTo: sources.get(spec.key)[0].rest_id } : {}) });
      posts.set(id, { raw, dropped, wave, source: spec.key });
      let visibleWave = wave;
      if (rounds >= 8 && spec.key.startsWith('search:') && wave === 3 && index === 0) {
        visibleWave = 6; late = { id, createdWave: wave + 1, visibleWave: visibleWave + 1 };
      }
      waves[visibleWave].push({ key: spec.key, raw });
      // Duplicate identity through independent acquisition paths must produce
      // one destination-scoped delivery, including media progress.
      if (spec.key === 'user:alice') waves[wave].push({ key: 'list:77', raw });
      if (spec.key === 'user:bob') waves[wave].push({ key: 'list:88', raw });
      if (spec.key === 'user:carol' && index % 2 === 0) waves[wave].push({ key: 'search:stress topic', raw });
    }
  }
  function publish(wave, target) {
    for (const { key, raw } of waves[wave]) { sources.get(key).push(raw); published.add(raw.rest_id); }
    for (const [key, values] of sources) target.set(key, [...values].sort(descending));
  }
  return { specs, sources, posts, published, waves, late, publish,
    accounts: specs.map((spec) => ({ ...spec.config, check_interval: 30, fetch_count: 50, filters: { exclude: ['stress_drop'] } })) };
}

function verifyDelivery({ posts, accepted, allowedDuplicates = new Map(), complete = true }) {
  const expected = new Map();
  for (const [id, record] of posts) if (!record.dropped) for (const key of expectedParts(record.raw)) expected.set(key, id);
  const counts = new Map();
  for (const call of accepted) {
    const { id, key } = providerPart(call);
    assert.ok(expected.has(key), `unexpected provider effect: ${key}`);
    counts.set(key, (counts.get(key) || 0) + 1);
    assert.ok(counts.get(key) <= 1 + (allowedDuplicates.get(key) || 0), `unexplained repeated provider effect: ${key}`);
    const body = call.method === 'sendMessage' ? call.fields.text
      : call.method === 'sendMediaGroup' ? JSON.parse(call.fields.media)[0]?.caption : call.fields.caption;
    assert.ok(body?.includes(posts.get(id).raw.legacy.full_text), 'delivered original body changed or media caption is missing');
    assert.ok(body.includes('/status/' + id), 'body must belong to the same post as its media');
    assert.ok(body.length <= (call.method === 'sendMessage' ? 4096 : 1024));
    if (call.method === 'sendMediaGroup') {
      assert.ok(JSON.parse(call.fields.media).slice(1).every((item) => item.caption === undefined), 'album must not duplicate its caption');
    }
  }
  const missing = [...expected.keys()].filter((key) => !counts.has(key));
  if (complete) assert.deepEqual(missing.slice(0, 20), [], `${missing.length} expected provider effects are missing`);
  return { posts: [...posts.values()].filter((value) => !value.dropped).length,
    filteredPosts: [...posts.values()].filter((value) => value.dropped).length,
    expectedParts: expected.size, acceptedParts: accepted.length, uniqueParts: counts.size,
    duplicateParts: accepted.length - counts.size, missingParts: missing.length };
}

module.exports = { createScenario, verifyDelivery, providerPart, expectedParts, mediaFor, descending };
