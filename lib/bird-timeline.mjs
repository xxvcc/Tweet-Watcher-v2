// Only Bird's pinned auth transport, feature flags and field mapper are reused.
// Its permissive timeline parser and pagination are deliberately not called.
import { TwitterClientBase } from '@steipete/bird/dist/lib/twitter-client-base.js';
import { withUserLookup } from '@steipete/bird/dist/lib/twitter-client-user-lookup.js';
import { buildUserTweetsFeatures } from '@steipete/bird/dist/lib/twitter-client-features.js';
import { TWITTER_API_BASE } from '@steipete/bird/dist/lib/twitter-client-constants.js';
import { mapTweetResult } from '@steipete/bird/dist/lib/twitter-client-utils.js';
import runtime from './runtime.js';

const ID = /^\d{1,32}$/;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const incomplete = (detail) => new Error(`Incomplete X timeline: ${detail}`);

// Parse and validate the entire page before exposing any of its tweets/cursors.
// Unknown tweet-bearing structures fail closed rather than silently skipping.
export function parseTimelinePage(data) {
  if (!object(data) || (data.errors !== undefined
      && (!Array.isArray(data.errors) || data.errors.length))) throw incomplete('GraphQL errors');
  const user = data.data?.user?.result;
  if (!object(user) || (user.__typename && user.__typename !== 'User')) throw incomplete('user unavailable');
  const instructions = user.timeline?.timeline?.instructions;
  if (!Array.isArray(instructions) || !instructions.length || instructions.length > 1000) {
    throw incomplete('missing or malformed instructions');
  }
  const tweets = new Map();
  let cursor;
  let terminated = false;
  let sawEntries = false;
  let entryCount = 0;
  let oldestId = null;

  function readTweet(raw, pinned, chronological) {
    let result = raw;
    if (object(result) && result.__typename === 'TweetWithVisibilityResults') result = result.tweet;
    if (!object(result) || (result.__typename && result.__typename !== 'Tweet')
        || typeof result.rest_id !== 'string' || !ID.test(result.rest_id)) throw incomplete('invalid tweet');
    const author = result.core?.user_results?.result;
    const username = author?.legacy?.screen_name ?? author?.core?.screen_name;
    if (!object(author) || typeof author.rest_id !== 'string' || !ID.test(author.rest_id)
        || typeof username !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(username)
        || !object(result.legacy) || typeof result.legacy.created_at !== 'string'
        || !result.legacy.created_at || !Number.isFinite(Date.parse(result.legacy.created_at))) {
      throw incomplete('missing tweet author or timestamp');
    }
    const mapped = mapTweetResult(result, { quoteDepth: 0 });
    if (!mapped || typeof mapped.text !== 'string' || !mapped.text.trim()) throw incomplete('missing tweet text');
    const prior = tweets.get(mapped.id);
    tweets.set(mapped.id, { ...mapped, is_pinned: pinned && (!prior || prior.is_pinned) });
    if (!pinned && chronological && (oldestId === null || BigInt(mapped.id) < BigInt(oldestId))) oldestId = mapped.id;
  }

  function readItem(item, pinned, chronological = false) {
    if (!object(item)) throw incomplete('invalid timeline item');
    // Some X responses annotate an ordinary entry as pinned instead of using
    // TimelinePinEntry. It must not satisfy a historical coverage boundary.
    pinned = pinned || ['Pin', 'Pinned'].includes(item.socialContext?.contextType);
    if (Object.hasOwn(item, 'tweet_results')) {
      readTweet(item.tweet_results?.result, pinned, chronological);
      return;
    }
    // These are explicit non-tweet renderers. Tombstones and unknown renderers
    // are not treated as successful empty tweets.
    if (item.itemType === 'TimelineUser' && object(item.user_results?.result)) return;
    throw incomplete('unsupported timeline item');
  }

  function readEntry(entry, pinned = false, chronological = false) {
    if (!object(entry) || !object(entry.content) || ++entryCount > 1000) throw incomplete('invalid entry');
    const content = entry.content;
    if (Object.hasOwn(content, 'cursorType')) {
      if (!['Top', 'Bottom'].includes(content.cursorType)
          || typeof content.value !== 'string' || !content.value || content.value.length > 8192) {
        throw incomplete('invalid or gap cursor');
      }
      if (content.cursorType === 'Bottom') {
        if (cursor && cursor !== content.value) throw incomplete('conflicting bottom cursors');
        cursor = content.value;
      }
      return;
    }
    if (Object.hasOwn(content, 'itemContent')) return readItem(content.itemContent, pinned, chronological);
    if (object(content.item) && Object.hasOwn(content.item, 'itemContent')) return readItem(content.item.itemContent, pinned, chronological);
    if (Array.isArray(content.items)) {
      if (!content.items.length) throw incomplete('empty module');
      for (const item of content.items) {
        if (!object(item)) throw incomplete('invalid module item');
        readItem(item.item?.itemContent ?? item.itemContent ?? item.content?.itemContent, pinned);
      }
      return;
    }
    throw incomplete('unsupported entry');
  }

  for (const instruction of instructions) {
    if (!object(instruction)) throw incomplete('invalid instruction');
    switch (instruction.type) {
      case 'TimelineAddEntries':
        if (!Array.isArray(instruction.entries)) throw incomplete('invalid entry list');
        sawEntries = true;
        for (const entry of instruction.entries) readEntry(entry, false, true);
        break;
      case 'TimelinePinEntry':
        readEntry(instruction.entry, true);
        break;
      case 'TimelineReplaceEntry':
        readEntry(instruction.entry);
        break;
      case 'TimelineAddToModule':
        if (!Array.isArray(instruction.moduleItems) || !instruction.moduleItems.length) throw incomplete('invalid module update');
        entryCount += instruction.moduleItems.length;
        for (const item of instruction.moduleItems) readItem(item?.item?.itemContent ?? item?.itemContent, false);
        break;
      case 'TimelineTerminateTimeline':
        if (!['Top', 'Bottom'].includes(instruction.direction)) throw incomplete('invalid termination');
        if (instruction.direction === 'Bottom') terminated = true;
        break;
      case 'TimelineClearCache':
        break;
      default:
        throw incomplete('unsupported instruction');
    }
  }
  if (!sawEntries && !terminated) throw incomplete('missing timeline entries');
  // An empty, explicit AddEntries page is a valid terminal page. A nonempty
  // page without either a cursor or bottom termination is not proof of an end.
  if (entryCount && !cursor && !terminated) throw incomplete('missing page boundary');
  if (tweets.size > 100) throw incomplete('oversized page');
  return { tweets: [...tweets.values()], cursor, oldestId, exhausted: terminated || !cursor };
}

export const TimelineClient = withUserLookup(TwitterClientBase);

async function fetchPage(client, userId, count, cursor) {
  const variables = { userId, count, includePromotedContent: false,
    withQuickPromoteEligibilityTweetFields: true, withVoice: true, ...(cursor ? { cursor } : {}) };
  const params = new URLSearchParams({ variables: JSON.stringify(variables),
    features: JSON.stringify(buildUserTweetsFeatures()),
    fieldToggles: JSON.stringify({ withArticlePlainText: false }) });
  for (let refresh = 0; refresh < 2; refresh++) {
    const ids = new Set([await client.getQueryId('UserTweets'), 'Wms1GvIiHXAPBaCr9KblaA']);
    for (const queryId of ids) {
      if (typeof queryId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(queryId)) throw incomplete('invalid query ID');
      const response = await client.fetchWithTimeout(`${TWITTER_API_BASE}/${queryId}/UserTweets?${params}`, {
        method: 'GET', headers: client.getHeaders(),
      });
      if (response.status === 404) continue;
      if (!response.ok) throw new Error(`X timeline HTTP ${response.status}`);
      return parseTimelinePage(await response.json());
    }
    if (refresh === 0) await client.refreshQueryIds();
  }
  throw new Error('X timeline HTTP 404');
}

// Bound catch-up work. The worker receives an explicit gap if its watermark is
// still outside these verified pages; it never mistakes a truncated window for
// evidence that every intervening tweet has been seen.
export async function fetchTimeline(client, { username, count, sinceId }) {
  const blocked = runtime.blocked();
  if (blocked) throw Object.assign(new Error(blocked.message), { code: blocked.code });
  if (!/^[A-Za-z0-9_]{1,15}$/.test(username) || !Number.isInteger(count) || count < 1 || count > 50
      || (sinceId !== undefined && (typeof sinceId !== 'string' || !ID.test(sinceId)))) throw new Error('Invalid timeline request');
  const lookup = await client.getUserIdByUsername(username);
  if (!lookup.success || typeof lookup.userId !== 'string' || !ID.test(lookup.userId)
      || typeof lookup.username !== 'string' || lookup.username.toLowerCase() !== username.toLowerCase()) {
    throw new Error('X account lookup failed');
  }
  const tweets = new Map();
  const cursors = new Set();
  let cursor;
  let oldestId = null;
  let exhausted = false;
  let reachedSince = false;
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    const page = await fetchPage(client, lookup.userId, sinceId ? 20 : Math.min(20, count), cursor);
    for (const tweet of page.tweets) {
      const prior = tweets.get(tweet.id);
      tweets.set(tweet.id, { ...tweet, is_pinned: tweet.is_pinned && (!prior || prior.is_pinned) });
    }
    if (tweets.size > 500) throw incomplete('catch-up capacity exceeded');
    if (page.oldestId !== null && (oldestId === null || BigInt(page.oldestId) < BigInt(oldestId))) oldestId = page.oldestId;
    reachedSince = !!sinceId && oldestId !== null && BigInt(oldestId) <= BigInt(sinceId);
    exhausted = page.exhausted;
    if (exhausted || reachedSince || (!sinceId && oldestId !== null && tweets.size >= count) || tweets.size >= 400) break;
    if (!page.cursor || cursors.has(page.cursor)) throw incomplete('pagination cursor did not advance');
    cursors.add(page.cursor);
    cursor = page.cursor;
  }
  if ((!tweets.size || (!sinceId && oldestId === null)) && !exhausted) {
    throw incomplete('missing chronological boundary');
  }
  return { tweets: [...tweets.values()], coverage: { complete: true, oldestId, exhausted, reachedSince } };
}
