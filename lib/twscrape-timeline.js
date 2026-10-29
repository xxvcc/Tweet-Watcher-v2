'use strict';

// Parse only the raw single-request response. The upstream iterable/model
// parser can discard pages or individual records and is not a coverage proof.
// The caller must persist the complete response before using these boundaries.
const ID = /^[1-9]\d{0,31}$/;
const USERNAME = /^[A-Za-z0-9_]{1,15}$/;
const LANGUAGE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
// Collection-only provenance keeps optional profile/body enrichment separate
// from immutable post content without changing the persisted tweet schema.
const tweetDetails = new WeakMap();

function failure(detail, code = 'TIMELINE_INCOMPLETE') {
  // Never put response bodies, server error messages or credentials in errors.
  return Object.assign(new Error(`Incomplete X timeline: ${detail}`), { code });
}

function id(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) throw failure(`invalid ${label}`);
  return value;
}

function optionalId(value, label) {
  return value === undefined || value === null ? null : id(value, label);
}

function checkedResponse(data) {
  if (!object(data) || (own(data, 'errors') && (!Array.isArray(data.errors) || data.errors.length))) {
    throw failure('GraphQL errors', 'GRAPHQL_ERRORS');
  }
  const user = data.data?.user?.result;
  if (!object(user) || (user.__typename !== undefined && user.__typename !== 'User')) {
    throw failure('user unavailable', 'USER_UNAVAILABLE');
  }
  return user;
}

function profileName(user, expectedUsername) {
  const modern = user.core?.screen_name;
  const legacy = user.legacy?.screen_name;
  for (const name of [modern, legacy]) {
    if (name !== undefined && (typeof name !== 'string' || !USERNAME.test(name))) throw failure('invalid author username');
  }
  if (modern && legacy && modern.toLowerCase() !== legacy.toLowerCase()) throw failure('conflicting author username');
  const username = modern ?? legacy;
  if (!username || (expectedUsername && username.toLowerCase() !== expectedUsername.toLowerCase())) {
    throw failure('author identity mismatch', 'IDENTITY_MISMATCH');
  }
  const name = user.core?.name ?? user.legacy?.name ?? username;
  if (typeof name !== 'string' || name.length > 160) throw failure('invalid author name');
  return { username, name };
}

function parseUser(data, username) {
  if (typeof username !== 'string' || !USERNAME.test(username)) throw failure('invalid requested username');
  const user = checkedResponse(data);
  return { id: id(user.rest_id, 'user ID'), ...profileName(user, username) };
}

function unwrap(raw) {
  if (object(raw) && raw.__typename === 'TweetWithVisibilityResults') raw = raw.tweet;
  return raw;
}

function relationId(tweet, kind) {
  const legacy = tweet.legacy;
  const label = kind === 'quote' ? 'quoted_status' : 'retweeted_status';
  const explicit = optionalId(legacy[`${label}_id_str`], `${kind} ID`);
  const containers = [tweet[`${label}_result`], legacy[`${label}_result`],
    kind === 'quote' ? tweet.quotedRefResult : undefined];
  let nestedId = null;
  for (const container of containers) {
    if (container === undefined || container === null) continue;
    if (!object(container)) throw failure(`invalid ${kind} relationship`);
    const nested = unwrap(container.result);
    // A deleted/withheld quoted object can omit its body. Its explicit parent
    // relationship still survives, without fabricating a body or author.
    if (!object(nested)) {
      if (!explicit) throw failure(`missing ${kind} identity`);
      continue;
    }
    const restId = optionalId(nested.rest_id, `${kind} ID`);
    const legacyId = optionalId(nested.legacy?.id_str, `${kind} ID`);
    if (restId && legacyId && restId !== legacyId) throw failure(`conflicting ${kind} identity`);
    const value = restId ?? legacyId;
    if (!value && !explicit) throw failure(`missing ${kind} identity`);
    if (value && nestedId && nestedId !== value) throw failure(`conflicting ${kind} identity`);
    if (value) nestedId = value;
  }
  if (explicit && nestedId && explicit !== nestedId) throw failure(`conflicting ${kind} identity`);
  return explicit ?? nestedId;
}

function editIds(tweet) {
  if (tweet.edit_control === undefined || tweet.edit_control === null) return [];
  if (!object(tweet.edit_control)) throw failure('invalid edit relationship');
  const control = tweet.edit_control;
  const initial = control.edit_control_initial;
  if (initial !== undefined && !object(initial)) throw failure('invalid initial edit relationship');
  const chain = control.edit_tweet_ids ?? initial?.edit_tweet_ids;
  if (chain === undefined) throw failure('missing edit identities');
  if (!Array.isArray(chain) || !chain.length || chain.length > 100) throw failure('invalid edit identities');
  const result = chain.map((value) => id(value, 'edit ID'));
  if (new Set(result).size !== result.length || !result.includes(tweet.rest_id)) throw failure('conflicting edit identities');
  if (control.edit_tweet_ids && initial?.edit_tweet_ids
      && JSON.stringify(control.edit_tweet_ids) !== JSON.stringify(initial.edit_tweet_ids)) {
    throw failure('conflicting edit identities');
  }
  return result;
}

function decodeText(text) {
  return text.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, entity) => ({
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'",
  })[entity]);
}

function optionalLanguage(value) {
  return typeof value === 'string' && value.length <= 35 && LANGUAGE.test(value) ? value.toLowerCase() : undefined;
}

function recoveredRepostText(tweet, repostId, text) {
  const prefix = /^RT @([A-Za-z0-9_]{1,15}): /.exec(text);
  if (!repostId || !prefix || (!text.endsWith('…') && tweet.legacy.truncated !== true)) return null;
  let recovered = null;
  for (const container of [tweet.retweeted_status_result, tweet.legacy.retweeted_status_result]) {
    const nested = unwrap(container?.result);
    // An unavailable reference never invalidates its complete parent. Only use
    // a body explicitly attached to the already checked repost identity.
    if (!object(nested) || (nested.__typename !== undefined && nested.__typename !== 'Tweet')
        || (nested.rest_id ?? nested.legacy?.id_str) !== repostId || !object(nested.legacy)) continue;
    const author = nested.core?.user_results?.result;
    const names = [author?.core?.screen_name, author?.legacy?.screen_name].filter((name) => name !== undefined);
    if (names.some((name) => typeof name !== 'string' || name.toLowerCase() !== prefix[1].toLowerCase())) continue;
    if (author?.rest_id && nested.legacy.user_id_str && author.rest_id !== nested.legacy.user_id_str) continue;
    const hasNote = nested.note_tweet !== undefined && nested.note_tweet !== null;
    const body = hasNote ? nested.note_tweet?.note_tweet_results?.result?.text : nested.legacy.full_text;
    if (typeof body !== 'string' || (!hasNote && nested.legacy.truncated === true)) continue;
    const expanded = prefix[0] + decodeText(body);
    if (expanded.length > 100000) throw failure('oversized repost text');
    if (recovered !== null && recovered.text !== expanded) throw failure('conflicting repost body', 'TWEET_CONFLICT');
    recovered = { text: expanded, lang: optionalLanguage(nested.legacy.lang) ?? recovered?.lang };
  }
  return recovered;
}

function mergeTweet(previous, current) {
  if (!previous) return current;
  const before = tweetDetails.get(previous) ?? { sourceText: previous.text, sourceLang: previous.lang, hasName: true };
  const after = tweetDetails.get(current) ?? { sourceText: current.text, sourceLang: current.lang, hasName: true };
  const content = ({ name, text, lang, is_pinned, ...value }) => JSON.stringify(value);
  if (content(previous) !== content(current) || before.sourceText !== after.sourceText
      || (before.authorId && after.authorId && before.authorId !== after.authorId)
      || (before.repostText !== null && before.repostText !== undefined
        && after.repostText !== null && after.repostText !== undefined && before.repostText !== after.repostText)) {
    throw failure('same ID has conflicting contents', 'TWEET_CONFLICT');
  }
  const repostText = after.repostText ?? before.repostText ?? null;
  const sourceLang = after.sourceLang ?? before.sourceLang;
  const repostLang = after.repostLang ?? before.repostLang;
  const lang = repostText === null ? sourceLang : repostLang;
  const merged = { ...current,
    name: after.hasName || !before.hasName ? current.name : previous.name,
    text: repostText ?? after.sourceText,
    is_pinned: previous.is_pinned && current.is_pinned };
  delete merged.lang;
  if (lang !== undefined) merged.lang = lang;
  tweetDetails.set(merged, { ...before, ...after, hasName: before.hasName || after.hasName, repostText, sourceLang, repostLang });
  return merged;
}

function validTimestamp(value) {
  if (typeof value !== 'string' || value.length > 256 || !Number.isFinite(Date.parse(value))) return false;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    return new Date(value).toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z'));
  }
  const parts = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/.exec(value);
  if (!parts) return false;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(parts[2]);
  const day = Number(parts[3]);
  const year = Number(parts[10]);
  const date = new Date(Date.UTC(year, month, day));
  return year >= 2006 && day >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() === month
    && date.getUTCDate() === day && Number(parts[4]) < 24 && Number(parts[5]) < 60
    && Number(parts[6]) < 60 && Number(parts[8]) < 24 && Number(parts[9]) < 60;
}

function tweetFields(raw, identity) {
  const tweet = unwrap(raw);
  if (!object(tweet) || (tweet.__typename !== undefined && tweet.__typename !== 'Tweet')) {
    throw failure('tweet unavailable or malformed', 'TWEET_UNAVAILABLE');
  }
  const tweetId = id(tweet.rest_id, 'tweet ID');
  const legacy = tweet.legacy;
  if (!object(legacy)) throw failure('missing tweet fields');
  if (legacy.id_str !== undefined && id(legacy.id_str, 'legacy tweet ID') !== tweetId) throw failure('conflicting tweet identity');
  const author = tweet.core?.user_results?.result;
  if (author !== undefined && author !== null && !object(author)) throw failure('invalid author profile');
  const legacyAuthor = optionalId(legacy.user_id_str, 'author ID');
  let authorId;
  let authorProfile;
  let hasName = false;
  if (object(author) && (author.core?.screen_name !== undefined || author.legacy?.screen_name !== undefined)) {
    if (author.__typename !== undefined && author.__typename !== 'User') throw failure('invalid author type');
    authorId = id(author.rest_id, 'author ID');
    authorProfile = profileName(author, authorId === identity.userId ? identity.username : undefined);
    hasName = typeof author.core?.name === 'string' || typeof author.legacy?.name === 'string';
    if (authorProfile.username.toLowerCase() === identity.username.toLowerCase() && authorId !== identity.userId) {
      throw failure('author identity mismatch', 'IDENTITY_MISMATCH');
    }
  } else {
    // X sometimes removes the repeated profile on the requested user's own
    // tweets. Only an exact, previously resolved ID can fill that omission.
    const embeddedId = object(author) ? optionalId(author.rest_id, 'author ID') : null;
    authorId = embeddedId ?? legacyAuthor;
    if (authorId !== identity.userId || (object(author) && author.__typename
        && !['User', 'UserUnavailable', 'UserTombstone'].includes(author.__typename))) {
      throw failure('missing verified author');
    }
    authorProfile = { username: identity.username, name: identity.username };
  }
  if (legacyAuthor && legacyAuthor !== authorId) throw failure('conflicting author identity');
  const time = legacy.created_at;
  if (!validTimestamp(time)) throw failure('invalid tweet timestamp');
  let text = legacy.full_text;
  const hasNote = tweet.note_tweet !== undefined && tweet.note_tweet !== null;
  if (hasNote) {
    const note = tweet.note_tweet?.note_tweet_results?.result;
    if (!object(note) || typeof note.text !== 'string') throw failure('incomplete long tweet');
    text = note.text;
  }
  // An explicitly empty body is valid for media-only posts. An absent body is
  // not. Do not truncate a page or a post during integrity validation.
  if (typeof text !== 'string' || text.length > 100000) throw failure('missing or oversized tweet text');
  const relations = {
    replyToId: optionalId(legacy.in_reply_to_status_id_str, 'reply ID'),
    quoteId: relationId(tweet, 'quote'),
    repostId: relationId(tweet, 'repost'),
    editIds: editIds(tweet),
  };
  if (legacy.is_quote_status === true && !relations.quoteId) throw failure('missing quote identity');
  const sourceText = decodeText(text);
  const repost = recoveredRepostText(tweet, relations.repostId, sourceText);
  // An explicit truncation marker makes the parent's body incomplete. A full
  // note or a verified, complete repost body can repair it; unavailable quoted
  // or reposted objects cannot make this preview safe to checkpoint.
  if (legacy.truncated === true && !hasNote && repost === null) throw failure('truncated tweet text');
  const repostText = repost?.text ?? null;
  const sourceLang = optionalLanguage(legacy.lang);
  const repostLang = repost?.lang;
  const lang = repost === null ? sourceLang : repostLang;
  const value = { id: tweetId, text: repostText ?? sourceText, time,
    url: `https://x.com/${authorProfile.username}/status/${tweetId}`, name: authorProfile.name,
    author_username: authorProfile.username,
    is_rt: relations.repostId !== null, is_pinned: false, relations };
  if (lang !== undefined) value.lang = lang;
  tweetDetails.set(value, { authorId, hasName, sourceText, repostText, sourceLang, repostLang });
  return { authorId, value };
}

function parseTimelinePage(data, { username, userId } = {}) {
  if (typeof username !== 'string' || !USERNAME.test(username)) throw failure('invalid requested username');
  id(userId, 'requested user ID');
  const user = checkedResponse(data);
  if (user.rest_id !== undefined && id(user.rest_id, 'timeline user ID') !== userId) throw failure('timeline identity mismatch', 'IDENTITY_MISMATCH');
  if (user.core?.screen_name !== undefined || user.legacy?.screen_name !== undefined) profileName(user, username);
  const instructions = user.timeline?.timeline?.instructions;
  if (!Array.isArray(instructions) || !instructions.length || instructions.length > 1000) throw failure('missing or malformed instructions');
  const tweets = new Map();
  const boundaries = new Set();
  let nextCursor = null;
  let terminated = false;
  let sawEntries = false;
  let entryCount = 0;

  function consume() {
    if (++entryCount > 2000) throw failure('oversized page');
  }

  function readItem(item, pinned, chronological = false, entryId) {
    if (!object(item)) throw failure('invalid timeline item');
    if (item.socialContext !== undefined && item.socialContext !== null && !object(item.socialContext)) {
      throw failure('invalid timeline context');
    }
    pinned ||= ['Pin', 'Pinned'].includes(item.socialContext?.contextType);
    if (own(item, 'tweet_results')) {
      if ((item.itemType !== undefined && item.itemType !== 'TimelineTweet')
          || (item.__typename !== undefined && item.__typename !== 'TimelineTweet')) throw failure('conflicting timeline item type');
      if (item.promotedMetadata !== undefined) throw failure('unexpected promoted tweet');
      const { value, authorId } = tweetFields(item.tweet_results?.result, { username, userId });
      // A recommendation/like/future social renderer is not evidence of the
      // user's chronological feed, even if its embedded author is this user.
      // A known repost context additionally needs an actual outer repost ID.
      if (item.socialContext && !(item.socialContext.contextType === 'Retweet' && value.is_rt)) chronological = false;
      if (typeof entryId === 'string' && /^tweet-\d+$/.test(entryId) && entryId.slice(6) !== value.id) throw failure('entry identity mismatch');
      value.is_pinned = pinned;
      const previous = tweets.get(value.id);
      tweets.set(value.id, mergeTweet(previous, value));
      if (!pinned && chronological && authorId === userId) boundaries.add(value.id);
      if (tweets.size > 500) throw failure('oversized page');
      return;
    }
    if (item.itemType === 'TimelineUser' && object(item.user_results?.result)
        && (item.__typename === undefined || item.__typename === 'TimelineUser')) return;
    throw failure('unsupported timeline item');
  }

  function readEntry(entry, pinned = false, chronological = false) {
    consume();
    if (!object(entry) || !object(entry.content)) throw failure('invalid timeline entry');
    const content = entry.content;
    if (entry.promotedMetadata !== undefined || content.promotedMetadata !== undefined) throw failure('unexpected promoted entry');
    const item = content.itemContent ?? content.item?.itemContent;
    const shapes = [own(content, 'cursorType'), item !== undefined, own(content, 'items')].filter(Boolean).length;
    if (shapes !== 1) throw failure('unsupported or conflicting entry shape');
    const expectedType = own(content, 'cursorType') ? 'TimelineTimelineCursor'
      : item !== undefined ? 'TimelineTimelineItem' : 'TimelineTimelineModule';
    if ((content.entryType !== undefined && content.entryType !== expectedType)
        || (content.__typename !== undefined && content.__typename !== expectedType)) throw failure('unsupported entry type');
    if (own(content, 'cursorType')) {
      if (!['Top', 'Bottom'].includes(content.cursorType) || typeof content.value !== 'string'
          || !content.value || content.value.length > 8192) throw failure('invalid or gap cursor');
      if (content.cursorType === 'Bottom') {
        if (nextCursor !== null && nextCursor !== content.value) throw failure('conflicting bottom cursors');
        nextCursor = content.value;
      }
      return;
    }
    if (item !== undefined) return readItem(item, pinned, chronological, entry.entryId);
    if (!Array.isArray(content.items) || !content.items.length) throw failure('invalid module');
    for (const moduleItem of content.items) {
      consume();
      if (!object(moduleItem)) throw failure('invalid module item');
      readItem(moduleItem.item?.itemContent ?? moduleItem.itemContent ?? moduleItem.content?.itemContent, pinned);
    }
  }

  for (const instruction of instructions) {
    if (!object(instruction)) throw failure('invalid timeline instruction');
    switch (instruction.type) {
      case 'TimelineAddEntries':
        if (!Array.isArray(instruction.entries)) throw failure('invalid entry list');
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
        if (!Array.isArray(instruction.moduleItems) || !instruction.moduleItems.length) throw failure('invalid module update');
        for (const item of instruction.moduleItems) {
          consume();
          readItem(item?.item?.itemContent ?? item?.itemContent, false);
        }
        break;
      case 'TimelineTerminateTimeline':
        if (!['Top', 'Bottom'].includes(instruction.direction)) throw failure('invalid termination');
        if (instruction.direction === 'Bottom') terminated = true;
        break;
      case 'TimelineClearCache':
        break;
      default:
        throw failure('unsupported timeline instruction');
    }
  }
  // A complete response containing explicit AddEntries([]) and no entries at
  // all is the empty-timeline terminal contract. Empty pages WITH a cursor are
  // nonterminal. Nonempty pages need either Bottom termination or a cursor.
  const emptyTerminal = sawEntries && entryCount === 0;
  if (!terminated && !emptyTerminal && nextCursor === null) throw failure('missing page boundary');
  const boundaryIds = [...boundaries];
  for (let index = 1; index < boundaryIds.length; index++) {
    if (BigInt(boundaryIds[index]) > BigInt(boundaryIds[index - 1])) {
      // Reordered/recommended entries and edits at an old timeline position
      // cannot safely establish a newest-ID acquisition checkpoint.
      throw failure('nonchronological page boundary');
    }
  }
  return { tweets: [...tweets.values()], nextCursor: terminated ? null : nextCursor,
    exhausted: terminated || emptyTerminal, boundaryIds };
}

module.exports = { parseUser, parseTimelinePage, mergeTweet };
