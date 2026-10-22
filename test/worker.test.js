'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function makeState() {
  const status = { accounts: Object.create(null) };
  const logs = [];
  return {
    status,
    logs,
    setStatus(patch) { Object.assign(status, patch); },
    setAccount(user, patch) { status.accounts[user] = { ...(status.accounts[user] || {}), ...patch }; },
    getStatus() { return status; },
    pruneAccounts(users) {
      const active = new Set(users);
      for (const user of Object.keys(status.accounts)) if (!active.has(user)) delete status.accounts[user];
    },
    pushHistory() {},
    addPush() {},
    log(message) { logs.push(String(message)); },
  };
}

function loadWorker({ config, bird, telegram, state = makeState(), storedSent = {}, storedDelivery, secrets, writeError, files: sharedFiles, twscrape, mode = 'legacy-live' }) {
  const paths = {
    worker: require.resolve('../lib/worker'),
    store: require.resolve('../lib/store'),
    config: require.resolve('../lib/config'),
    bird: require.resolve('../lib/bird'),
    twscrape: require.resolve('../lib/twscrape'),
    telegram: require.resolve('../lib/telegram'),
    state: require.resolve('../lib/state'),
    runtime: require.resolve('../lib/runtime'),
  };
  const writes = [];
  const files = sharedFiles || new Map([['sent_ids.json', structuredClone(storedSent)]]);
  if (storedDelivery !== undefined) files.set('delivery_state.json', structuredClone(storedDelivery));
  const saved = new Map(Object.values(paths).map((p) => [p, require.cache[p]]));
  const put = (p, exports) => { require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  put(paths.store, {
    readState: (name) => files.has(name)
      ? { status: 'ok', value: structuredClone(files.get(name)) }
      : { status: 'missing' },
    readJSON: (name, fallback) => files.has(name) ? structuredClone(files.get(name)) : fallback,
    writeJSON: (name, value) => {
      if (writeError) writeError(name, value);
      const copy = structuredClone(value);
      writes.push({ name, value: copy });
      files.set(name, copy);
    },
  });
  put(paths.config, {
    LIMITS: { MAX_SENT: 200 },
    validRevision: (value) => Number.isSafeInteger(value) && value >= 0,
    getConfig: () => {
      const value = typeof config === 'function' ? config() : config;
      return { ...value, revision: Number.isSafeInteger(value.revision) ? value.revision : 0 };
    },
    getSecrets: () => typeof secrets === 'function'
      ? secrets()
      : (secrets || { auth_token: 'auth', ct0: 'ct0x', tg_bot_token: 'bot' }),
  });
  put(paths.bird, bird);
  put(paths.twscrape, twscrape);
  put(paths.telegram, telegram);
  put(paths.state, state);
  put(paths.runtime, {
    blocked: (operation) => mode === 'read-only' && operation !== 'collection'
      ? { ok: false, disabled: true, code: 'RUNTIME_DISABLED', message: '只读模式', error: '只读模式' } : null,
    status: () => ({ mode, collector: mode === 'legacy-live' ? 'bird-legacy' : 'twscrape' }),
  });
  delete require.cache[paths.worker];
  const worker = require(paths.worker);
  return {
    worker,
    state,
    writes,
    files,
    restore() {
      for (const [p, entry] of saved) {
        if (entry) require.cache[p] = entry;
        else delete require.cache[p];
      }
    },
  };
}

function account(username) {
  return { username, fetch_count: 10, check_interval: 30 };
}

const noSendTelegram = {
  formatTweet: (tweet) => tweet.id,
  sendMessage: async () => { throw new Error('sendMessage should not be called'); },
};

test('queued accounts skipped by pause remain immediately due after resume', { concurrency: false }, async () => {
  const config = {
    bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false,
    accounts: ['a', 'b', 'c', 'd', 'e'].map(account),
  };
  const started = [];
  let release;
  let readyResolve;
  let released = false;
  const blocked = new Promise((resolve) => { release = () => { released = true; resolve(); }; });
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const harness = loadWorker({
    config,
    bird: {
      async fetchTweets({ username }) {
        started.push(username);
        if (started.length === 4) readyResolve();
        if (!released) await blocked;
        return { ok: true, tweets: [] };
      },
    },
    telegram: noSendTelegram,
  });
  try {
    const firstTick = harness.worker.tick();
    await ready;
    harness.worker.setPaused(true);
    release();
    await firstTick;
    assert.deepEqual(started.sort(), ['a', 'b', 'c', 'd']);

    harness.worker.setPaused(false);
    await harness.worker.tick();
    assert.equal(started.filter((user) => user === 'e').length, 1);
  } finally { harness.restore(); }
});

test('a wall-clock rollback cannot suspend account checks until the old timestamp catches up', { concurrency: false }, async () => {
  const originalNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  let fetches = 0;
  const harness = loadWorker({
    config: {
      bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false,
      accounts: [account('alice')],
    },
    bird: { async fetchTweets() { fetches++; return { ok: true, tweets: [] }; } },
    telegram: noSendTelegram,
  });
  try {
    await harness.worker.tick();
    assert.equal(fetches, 1);
    now = 50000;
    await harness.worker.tick();
    assert.equal(fetches, 2);
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test('a successful empty first fetch persists a watermark and delivers the first later tweet', { concurrency: false }, async () => {
  const originalNow = Date.now;
  const originalSetTimeout = global.setTimeout;
  const twitterEpoch = 1288834974657;
  let now = twitterEpoch + 1_000_000;
  Date.now = () => now;
  const config = {
    bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false,
    accounts: [account('alice')],
  };
  let first;
  let second;
  let persisted;
  try {
    first = loadWorker({
      config,
      bird: {
        async fetchTweets() {
          // 模拟慢请求：推文在请求开始后发布，但未进入这次空快照。
          now += 10_000;
          return { ok: true, tweets: [] };
        },
      },
      telegram: noSendTelegram,
    });
    await first.worker.tick();
    persisted = first.files.get('delivery_state.json');
    assert.match(persisted.accounts.alice.watermark, /^\d+$/);
    first.restore();
    first = null;

    // 低 22 位全 0 是同毫秒边界；发布时刻落在首次请求期间。
    const tweetAt = now - 5_000;
    const tweetId = (BigInt(tweetAt - twitterEpoch) << 22n).toString();
    now += 30_001;
    const sent = [];
    second = loadWorker({
      config,
      storedDelivery: persisted,
      bird: { async fetchTweets() { return { ok: true, tweets: [{ id: tweetId }] }; } },
      telegram: {
        formatTweet: (tweet) => tweet.id,
        async sendMessage({ text }) { sent.push(text); return { ok: true }; },
      },
    });
    global.setTimeout = (fn, ms) => {
      if (ms !== 5000) queueMicrotask(fn);
      return 0;
    };
    second.worker.start();
    for (let i = 0; i < 20 && sent.length === 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(sent, [tweetId]);
  } finally {
    Date.now = originalNow;
    global.setTimeout = originalSetTimeout;
    if (first) first.restore();
    if (second) second.restore();
  }
});

test('worker status uses the persistent config revision across start and changes', { concurrency: false }, async () => {
  const config = { bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false, accounts: [], revision: 42 };
  const harness = loadWorker({
    config,
    bird: { async fetchTweets() { return { ok: true, tweets: [] }; } },
    telegram: noSendTelegram,
  });
  const originalSetTimeout = global.setTimeout;
  try {
    global.setTimeout = () => 0;
    harness.worker.start();
    assert.equal(harness.state.status.configRevision, 42);
    config.revision = 43;
    harness.worker.configChanged();
    assert.equal(harness.state.status.configRevision, 43);
    // 让 loop() 的 finally 在恢复真实定时器前运行，避免测试遗留一个常驻 5 秒调度。
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    global.setTimeout = originalSetTimeout;
    harness.restore();
  }
});

test('a corrupt config blocks checks without crashing the web service startup', { concurrency: false }, async () => {
  const harness = loadWorker({
    config: () => { throw Object.assign(new Error('config.json 损坏'), { code: 'DATA_CORRUPT' }); },
    bird: { async fetchTweets() { throw new Error('must not fetch with corrupt config'); } },
    telegram: noSendTelegram,
  });
  const originalSetTimeout = global.setTimeout;
  try {
    global.setTimeout = () => 0;
    assert.doesNotThrow(() => harness.worker.start());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.state.status.running, false);
    assert.equal(harness.state.status.lastTickAt, null);
    assert.match(harness.state.logs.join('\n'), /配置读取失败/);
  } finally {
    global.setTimeout = originalSetTimeout;
    harness.restore();
  }
});

test('corrupt secrets stop the worker and cannot leave a healthy heartbeat', { concurrency: false }, async () => {
  const config = { bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false, accounts: [], revision: 2 };
  const harness = loadWorker({
    config,
    secrets: () => { throw Object.assign(new Error('secrets.json 损坏'), { code: 'DATA_CORRUPT' }); },
    bird: { async fetchTweets() { throw new Error('must not fetch with corrupt secrets'); } },
    telegram: noSendTelegram,
  });
  try {
    await assert.rejects(harness.worker.tick(), (error) => error && error.code === 'DATA_CORRUPT');
    assert.equal(harness.state.status.running, false);
    assert.equal(harness.state.status.lastTickAt, null);
  } finally { harness.restore(); }
});

test('a runtime data-directory disappearance cannot clear an established dedup snapshot', { concurrency: false }, async () => {
  let present = true;
  let fetches = 0;
  const harness = loadWorker({
    config: () => ({
      bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false,
      accounts: present ? [account('alice')] : [], persisted: present,
    }),
    storedSent: { alice: ['1'] },
    bird: { async fetchTweets() { fetches++; return { ok: true, tweets: [{ id: '1' }] }; } },
    telegram: noSendTelegram,
  });
  try {
    await harness.worker.tick();
    assert.equal(fetches, 1);
    present = false;
    await assert.rejects(harness.worker.tick(), (error) => error && error.code === 'DATA_CORRUPT');
    assert.equal(fetches, 1);
    assert.equal(harness.state.status.running, false);
    assert.equal(harness.state.status.lastTickAt, null);
  } finally { harness.restore(); }
});

test('a dedup-only migration is retained until the first config is persisted', { concurrency: false }, async () => {
  let configured = false;
  const harness = loadWorker({
    config: () => ({
      bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false,
      accounts: configured ? [account('alice')] : [], persisted: configured,
    }),
    storedSent: { alice: ['1'] },
    bird: { async fetchTweets() { return { ok: true, tweets: [{ id: '1' }] }; } },
    telegram: noSendTelegram,
  });
  const originalSetTimeout = global.setTimeout;
  try {
    global.setTimeout = () => 0;
    harness.worker.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.files.has('delivery_state.json'), false);
    assert.equal(harness.files.has('delivery_state.initialized.json'), false);
    assert.equal(harness.writes.length, 0);
    configured = true;
    await harness.worker.tick();
    assert.match(harness.state.logs.join('\n'), /无新推文/);
    assert.doesNotMatch(harness.state.logs.join('\n'), /首次运行/);
    assert.equal(capturedState(harness).watermark, '1');
    assert.deepEqual(capturedState(harness).sent, ['1']);
    assert.deepEqual(harness.files.get('delivery_state.initialized.json'), { version: 1 });
  } finally {
    global.setTimeout = originalSetTimeout;
    harness.restore();
  }
});

test('a config change cancels the whole queued snapshot and does not consume its interval', { concurrency: false }, async () => {
  const config = {
    bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false,
    accounts: ['a', 'b', 'c', 'd', 'e'].map(account),
  };
  const started = [];
  let release;
  let readyResolve;
  let released = false;
  const blocked = new Promise((resolve) => { release = () => { released = true; resolve(); }; });
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const harness = loadWorker({
    config,
    bird: {
      async fetchTweets({ username }) {
        started.push(username);
        if (started.length === 4) readyResolve();
        if (!released) await blocked;
        return { ok: true, tweets: [] };
      },
    },
    telegram: noSendTelegram,
  });
  try {
    const staleTick = harness.worker.tick();
    await ready;
    harness.worker.configChanged();
    release();
    await staleTick;
    assert.deepEqual(started.slice().sort(), ['a', 'b', 'c', 'd']);

    await harness.worker.tick();
    assert.equal(started.length, 9);
    for (const user of ['a', 'b', 'c', 'd']) {
      assert.equal(started.filter((item) => item === user).length, 2);
    }
    assert.equal(started.filter((item) => item === 'e').length, 1);
  } finally { harness.restore(); }
});

test('a restored empty dedup list rebuilds a baseline instead of mass-pushing', { concurrency: false }, async () => {
  const config = { bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false, accounts: [account('alice')] };
  let sends = 0;
  const harness = loadWorker({
    config,
    storedSent: { alice: [] },
    bird: { async fetchTweets() { return { ok: true, tweets: [{ id: '2' }, { id: '1' }] }; } },
    telegram: {
      formatTweet: (tweet) => tweet.id,
      async sendMessage() { sends++; return { ok: true }; },
    },
  });
  const originalSetTimeout = global.setTimeout;
  try {
    // start() is the production path that restores sent_ids. Suppress only the recurring 5s loop;
    // short worker sleeps still resolve through microtasks so the test also fails cleanly on a regression.
    global.setTimeout = (fn, ms) => {
      if (ms !== 5000) queueMicrotask(fn);
      return 0;
    };
    harness.worker.start();
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      const accountState = harness.state.status.accounts.alice;
      if (accountState && accountState.checking === false) break;
    }
    assert.equal(sends, 0);
    assert.match(harness.state.logs.join('\n'), /首次运行，记录 2 条推文 ID，不推送/);
  } finally {
    global.setTimeout = originalSetTimeout;
    harness.restore();
  }
});

test('a failed older tweet blocks newer delivery and marks the account unhealthy', { concurrency: false }, async () => {
  const originalNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  const config = { bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false, accounts: [account('alice')] };
  let fetchRound = 0;
  const sent = [];
  const harness = loadWorker({
    config,
    bird: {
      async fetchTweets() {
        fetchRound++;
        return fetchRound === 1
          ? { ok: true, tweets: [{ id: '1' }] }
          : { ok: true, tweets: [{ id: '3' }, { id: '2' }, { id: '1' }] };
      },
    },
    telegram: {
      formatTweet: (tweet) => tweet.id,
      async sendMessage({ text }) { sent.push(text); return { ok: false, permanent: true, description: 'bad chat' }; },
    },
  });
  try {
    await harness.worker.tick();
    now += 30001;
    await harness.worker.tick();
    assert.deepEqual(sent, ['2']);
    assert.equal(harness.state.status.accounts.alice.ok, false);
    assert.match(harness.state.status.accounts.alice.lastError, /Telegram 推送失败/);
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test('pause during a failed send prevents every retry', { concurrency: false }, async () => {
  const originalNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  const config = { bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false, accounts: [account('alice')] };
  let fetchRound = 0;
  let resolveSend;
  let sendStartedResolve;
  const sendStarted = new Promise((resolve) => { sendStartedResolve = resolve; });
  let sendCalls = 0;
  const harness = loadWorker({
    config,
    bird: {
      async fetchTweets() {
        fetchRound++;
        return fetchRound === 1
          ? { ok: true, tweets: [{ id: '1' }] }
          : { ok: true, tweets: [{ id: '2' }, { id: '1' }] };
      },
    },
    telegram: {
      formatTweet: (tweet) => tweet.id,
      sendMessage() {
        sendCalls++;
        sendStartedResolve();
        return new Promise((resolve) => { resolveSend = resolve; });
      },
    },
  });
  try {
    await harness.worker.tick();
    now += 30001;
    const activeTick = harness.worker.tick();
    await sendStarted;
    harness.worker.setPaused(true);
    resolveSend({ ok: false, description: 'network down' });
    await activeTick;
    assert.equal(sendCalls, 1);
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test('a 429 received during pause is still honored after resume', { concurrency: false }, async () => {
  const originalNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  const config = { bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false, accounts: [account('alice')] };
  let fetchRound = 0;
  let resolveSend;
  let sendStartedResolve;
  const sendStarted = new Promise((resolve) => { sendStartedResolve = resolve; });
  let sendCalls = 0;
  const harness = loadWorker({
    config,
    bird: {
      async fetchTweets() {
        fetchRound++;
        return fetchRound === 1
          ? { ok: true, tweets: [{ id: '1' }] }
          : { ok: true, tweets: [{ id: '2' }, { id: '1' }] };
      },
    },
    telegram: {
      formatTweet: (tweet) => tweet.id,
      sendMessage() {
        sendCalls++;
        sendStartedResolve();
        return new Promise((resolve) => { resolveSend = resolve; });
      },
    },
  });
  try {
    await harness.worker.tick();
    now += 30001;
    const activeTick = harness.worker.tick();
    await sendStarted;
    harness.worker.setPaused(true);
    resolveSend({ ok: false, rateLimited: true, retryAfter: 60, description: 'too many requests' });
    await activeTick;

    harness.worker.setPaused(false);
    await harness.worker.tick();
    assert.equal(sendCalls, 1);
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test('a Telegram 429 creates global deferral without sleeping or retrying', { concurrency: false }, async () => {
  const originalNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  const config = { bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false, accounts: [account('alice')] };
  let fetchRound = 0;
  let sendCalls = 0;
  const harness = loadWorker({
    config,
    bird: {
      async fetchTweets() {
        fetchRound++;
        return fetchRound === 1
          ? { ok: true, tweets: [{ id: '1' }] }
          : { ok: true, tweets: [{ id: '2' }, { id: '1' }] };
      },
    },
    telegram: {
      formatTweet: (tweet) => tweet.id,
      async sendMessage() {
        sendCalls++;
        return { ok: false, rateLimited: true, retryAfter: 30, description: 'too many requests' };
      },
    },
  });
  try {
    await harness.worker.tick();
    now += 30001;
    await harness.worker.tick();
    assert.equal(sendCalls, 1);
    assert.match(harness.state.status.accounts.alice.lastError, /限流/);
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test('the Telegram test endpoint shares the worker bot backoff', { concurrency: false }, async () => {
  const originalNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  const config = { bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false, accounts: [account('alice')] };
  let fetchRound = 0;
  let sendCalls = 0;
  const harness = loadWorker({
    config,
    bird: {
      async fetchTweets() {
        fetchRound++;
        return fetchRound === 1
          ? { ok: true, tweets: [{ id: '1' }] }
          : { ok: true, tweets: [{ id: '2' }, { id: '1' }] };
      },
    },
    telegram: {
      formatTweet: (tweet) => tweet.id,
      async sendMessage() {
        sendCalls++;
        return { ok: false, rateLimited: true, retryAfter: 60, description: 'too many requests' };
      },
    },
  });
  try {
    const result = await harness.worker.testTelegram();
    assert.equal(result.ok, false);
    const repeated = await harness.worker.testTelegram();
    assert.match(repeated.message, /退避中/);
    await harness.worker.tick();
    now += 30001;
    await harness.worker.tick();
    assert.equal(sendCalls, 1);
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test('a wall-clock rollback preserves Telegram backoff duration instead of extending it', { concurrency: false }, async () => {
  const originalNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  let sendCalls = 0;
  const harness = loadWorker({
    config: { bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false, accounts: [] },
    bird: { async fetchTweets() { return { ok: true, tweets: [] }; } },
    telegram: {
      formatTweet: (tweet) => tweet.id,
      async sendMessage() {
        sendCalls++;
        return { ok: false, rateLimited: true, retryAfter: 60, description: 'too many requests' };
      },
    },
  });
  try {
    assert.equal((await harness.worker.testTelegram()).ok, false);
    now = 50000;
    const repeated = await harness.worker.testTelegram();
    assert.match(repeated.message, /60 秒后/);
    assert.equal(sendCalls, 1);
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test('Telegram backoff is isolated between bot tokens', { concurrency: false }, async () => {
  const originalNow = Date.now;
  Date.now = () => 100000;
  const config = { bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false, accounts: [] };
  let token = 'bot-a';
  const calls = [];
  const harness = loadWorker({
    config,
    secrets: () => ({ auth_token: 'auth', ct0: 'ct0x', tg_bot_token: token }),
    bird: { async fetchTweets() { return { ok: true, tweets: [] }; } },
    telegram: {
      formatTweet: (tweet) => tweet.id,
      async sendMessage({ botToken }) {
        calls.push(botToken);
        return botToken === 'bot-a'
          ? { ok: false, rateLimited: true, retryAfter: 60, description: 'too many requests' }
          : { ok: true };
      },
    },
  });
  try {
    assert.equal((await harness.worker.testTelegram()).ok, false);
    token = 'bot-b';
    assert.equal((await harness.worker.testTelegram()).ok, true);
    assert.deepEqual(calls, ['bot-a', 'bot-b']);
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test('newly pinned old tweets are not backfilled and new tweets keep delivery order', { concurrency: false }, async () => {
  const config = { bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false, accounts: [account('alice')] };
  const sent = [];
  const harness = loadWorker({
    config,
    storedSent: { alice: ['100'] },
    // A newly pinned old tweet can precede the newest tweet in bird's output.
    bird: { async fetchTweets() { return { ok: true, tweets: [{ id: '50' }, { id: '110' }, { id: '100' }] }; } },
    telegram: {
      formatTweet: (tweet) => tweet.id,
      async sendMessage({ text }) { sent.push(text); return { ok: true }; },
    },
  });
  const originalSetTimeout = global.setTimeout;
  try {
    global.setTimeout = (fn, ms) => {
      if (ms !== 5000) queueMicrotask(fn);
      return 0;
    };
    harness.worker.start();
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      const accountState = harness.state.status.accounts.alice;
      if (accountState && accountState.checking === false) break;
    }
    assert.deepEqual(sent, ['110']);
  } finally {
    global.setTimeout = originalSetTimeout;
    harness.restore();
  }
});

test('a config change during final delivery throttling cannot recreate a deleted account', { concurrency: false }, async () => {
  const originalNow = Date.now;
  const originalSetTimeout = global.setTimeout;
  let now = 100000;
  Date.now = () => now;
  const config = { bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false, accounts: [account('alice')], revision: 1 };
  let round = 0;
  let releaseThrottle;
  let throttleStartedResolve;
  const throttleStarted = new Promise((resolve) => { throttleStartedResolve = resolve; });
  const harness = loadWorker({
    config,
    bird: {
      async fetchTweets() {
        round++;
        return round === 1
          ? { ok: true, tweets: [{ id: '100' }] }
          : { ok: true, tweets: [{ id: '101' }, { id: '100' }] };
      },
    },
    telegram: {
      formatTweet: (tweet) => tweet.id,
      async sendMessage() { return { ok: true }; },
    },
  });
  try {
    global.setTimeout = (fn, ms) => {
      if (ms === 500) {
        releaseThrottle = fn;
        throttleStartedResolve();
      } else queueMicrotask(fn);
      return 0;
    };
    await harness.worker.tick();
    now += 30001;
    const secondTick = harness.worker.tick();
    await throttleStarted;
    config.accounts = [];
    config.revision = 2;
    harness.worker.configChanged(2);
    harness.state.pruneAccounts([]);
    releaseThrottle();
    await secondTick;
    assert.equal(Object.prototype.hasOwnProperty.call(harness.state.status.accounts, 'alice'), false);
  } finally {
    Date.now = originalNow;
    global.setTimeout = originalSetTimeout;
    harness.restore();
  }
});

test('concurrent 429 responses report the longest active bot backoff', { concurrency: false }, async () => {
  const config = {
    bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false,
    accounts: [account('alice'), account('bob')],
  };
  let releaseBoth;
  const bothStarted = new Promise((resolve) => { releaseBoth = resolve; });
  let calls = 0;
  const harness = loadWorker({
    config,
    storedSent: { alice: ['1'], bob: ['1'] },
    bird: { async fetchTweets() { return { ok: true, tweets: [{ id: '2' }, { id: '1' }] }; } },
    telegram: {
      formatTweet: (tweet, user) => user,
      async sendMessage({ text }) {
        calls++;
        if (calls === 2) releaseBoth();
        await bothStarted;
        return {
          ok: false,
          rateLimited: true,
          retryAfter: text === 'alice' ? 60 : 2,
          description: 'too many requests',
        };
      },
    },
  });
  const originalNow = Date.now;
  const originalSetTimeout = global.setTimeout;
  Date.now = () => 100000;
  try {
    global.setTimeout = () => 0; // suppress only the recurring loop; the 429 path does not sleep
    harness.worker.start();
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      const states = harness.state.status.accounts;
      if (states.alice && states.bob && !states.alice.checking && !states.bob.checking) break;
    }
    assert.equal(calls, 2);
    assert.match(harness.state.status.accounts.alice.lastError, /60s/);
    assert.match(harness.state.status.accounts.bob.lastError, /60s/);
  } finally {
    Date.now = originalNow;
    global.setTimeout = originalSetTimeout;
    harness.restore();
  }
});

function fastTimers() {
  const previous = global.setTimeout;
  global.setTimeout = (fn, ms) => {
    if (ms !== 5000) queueMicrotask(fn);
    return 0;
  };
  return () => { global.setTimeout = previous; };
}

function watcherConfig() {
  return { bird_path: '/usr/bin/bird', tg_chat_id: '1', paused: false, accounts: [account('alice')] };
}

function capturedState(harness) { return harness.files.get('delivery_state.json').accounts.alice; }

test('captured messages survive a 429, a lost fetch window, and restart with original content', { concurrency: false }, async () => {
  const restoreTimers = fastTimers();
  const previousNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  const config = watcherConfig();
  let harness;
  const attempts = [];
  try {
    harness = loadWorker({
      config, storedSent: { alice: ['1'] },
      bird: { async fetchTweets({ sinceId }) {
        assert.equal(sinceId, '1');
        return { ok: true, tweets: [{ id: '3', text: 'original third' }, { id: '2', text: 'original second' }, { id: '1' }] };
      } },
      telegram: {
        formatTweet: (tweet) => tweet.text,
        async sendMessage({ text }) {
          attempts.push(text);
          // Both the failed message and every later message are already durable.
          assert.deepEqual(capturedState(harness).pending.map((tweet) => tweet.id), ['2', '3']);
          assert.equal(capturedState(harness).watermark, '3');
          return { ok: false, rateLimited: true, retryAfter: 30, description: 'rate limited' };
        },
      },
    });
    await harness.worker.tick();
    const files = harness.files;
    harness.restore();
    now += 31000;
    harness = loadWorker({
      config, files,
      bird: { async fetchTweets({ sinceId }) {
        assert.equal(sinceId, '3');
        return { ok: true, tweets: [{ id: '5', text: 'fifth' }, { id: '4', text: 'fourth' }],
          coverage: { complete: true, reachedSince: false, exhausted: false } };
      } },
      telegram: {
        formatTweet: (tweet) => tweet.text,
        async sendMessage({ text }) { attempts.push(text); return { ok: true }; },
      },
    });
    await harness.worker.tick();
    assert.deepEqual(attempts, ['original second', 'original second', 'original third', 'fourth', 'fifth']);
    assert.deepEqual(capturedState(harness).pending, []);
    assert.deepEqual(capturedState(harness).sent, ['1', '2', '3', '4', '5']);
    assert.equal(harness.state.status.accounts.alice.ok, false);
    assert.match(harness.state.status.accounts.alice.lastError, /未覆盖上次水位 3/);
  } finally { if (harness) harness.restore(); restoreTimers(); Date.now = previousNow; }
});

test('an X outage does not prevent delivery of the durable backlog after restart', { concurrency: false }, async () => {
  const restoreTimers = fastTimers();
  let harness;
  try {
    const config = watcherConfig();
    harness = loadWorker({
      config, storedSent: { alice: ['1'] },
      bird: { async fetchTweets() { return { ok: true, tweets: [{ id: '2', text: 'saved body' }, { id: '1' }] }; } },
      telegram: { formatTweet: (tweet) => tweet.text, async sendMessage() { return { ok: false, permanent: true }; } },
    });
    await harness.worker.tick();
    const files = harness.files;
    harness.restore();
    const delivered = [];
    harness = loadWorker({
      config, files,
      bird: { async fetchTweets() { return { ok: false, error: 'X unavailable' }; } },
      telegram: { formatTweet: (tweet) => tweet.text, async sendMessage({ text }) { delivered.push(text); return { ok: true }; } },
    });
    await harness.worker.tick();
    assert.deepEqual(delivered, ['saved body']);
    assert.deepEqual(capturedState(harness).pending, []);
    assert.match(harness.state.status.accounts.alice.lastError, /X unavailable/);
  } finally { if (harness) harness.restore(); restoreTimers(); }
});

test('a failed capture commit sends nothing and retains the entire candidate until storage recovers', { concurrency: false }, async () => {
  const restoreTimers = fastTimers();
  const previousNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  let fail = false;
  let round = 0;
  const delivered = [];
  const harness = loadWorker({
    config: watcherConfig(),
    writeError(name, value) { if (name === 'delivery_state.json' && fail && value.accounts.alice.pending.length) throw new Error('synthetic disk full'); },
    bird: { async fetchTweets() {
      const ids = [[1], [3, 2, 1], [5, 4, 3]][round++];
      return { ok: true, tweets: ids.map((id) => ({ id: String(id) })), coverage: { complete: true, reachedSince: true } };
    } },
    telegram: { formatTweet: (tweet) => tweet.id, async sendMessage({ text }) { delivered.push(text); return { ok: true }; } },
  });
  try {
    await harness.worker.tick();
    fail = true;
    now += 31000;
    await harness.worker.tick();
    assert.deepEqual(delivered, []);
    assert.equal(capturedState(harness).watermark, '1');
    assert.match(harness.state.status.accounts.alice.lastError, /保存失败/);
    fail = false;
    now += 31000;
    await harness.worker.tick();
    assert.deepEqual(delivered, ['2', '3', '4', '5']);
    assert.equal(capturedState(harness).watermark, '5');
  } finally { harness.restore(); restoreTimers(); Date.now = previousNow; }
});

test('a failed acknowledgement stops newer sends and recovery commits before continuing', { concurrency: false }, async () => {
  const restoreTimers = fastTimers();
  const previousNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  let failAck = true;
  const delivered = [];
  const harness = loadWorker({
    config: watcherConfig(), storedSent: { alice: ['1'] },
    writeError(name, value) { if (name === 'delivery_state.json' && failAck && value.accounts.alice.sent.includes('2')) throw new Error('synthetic ack write failure'); },
    bird: { async fetchTweets() { return { ok: true, tweets: [{ id: '3' }, { id: '2' }, { id: '1' }] }; } },
    telegram: { formatTweet: (tweet) => tweet.id, async sendMessage({ text }) { delivered.push(text); return { ok: true }; } },
  });
  try {
    await harness.worker.tick();
    assert.deepEqual(delivered, ['2']);
    assert.deepEqual(capturedState(harness).pending.map((tweet) => tweet.id), ['2', '3']);
    assert.match(harness.state.status.accounts.alice.lastError, /保存失败/);
    // While the ack is still unwritable, no poll or send may proceed.
    now += 31000;
    await assert.rejects(harness.worker.tick(), /保存失败/);
    assert.deepEqual(delivered, ['2']);
    failAck = false;
    await harness.worker.tick();
    assert.deepEqual(delivered, ['2', '3']);
    assert.deepEqual(capturedState(harness).pending, []);
  } finally { harness.restore(); restoreTimers(); Date.now = previousNow; }
});

test('changed bot or chat cannot receive the old queue; restoring the target resumes it', { concurrency: false }, async () => {
  const restoreTimers = fastTimers();
  const previousNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  const config = watcherConfig();
  let token = 'bot-original';
  let fail = true;
  let fetches = 0;
  const delivered = [];
  const harness = loadWorker({
    config, storedSent: { alice: ['1'] },
    secrets: () => ({ auth_token: 'auth', ct0: 'csrf', tg_bot_token: token }),
    bird: { async fetchTweets() { fetches++; return { ok: true, tweets: [{ id: '2', text: 'original' }, { id: '1' }] }; } },
    telegram: {
      formatTweet: (tweet) => tweet.text,
      async sendMessage({ botToken, chatId, text }) {
        if (fail) return { ok: false, permanent: true };
        delivered.push({ botToken, chatId, text }); return { ok: true };
      },
    },
  });
  try {
    await harness.worker.tick();
    fail = false;
    for (const change of ['chat', 'bot']) {
      now += 31000;
      config.tg_chat_id = change === 'chat' ? '2' : '1';
      token = change === 'bot' ? 'bot-other' : 'bot-original';
      harness.worker.configChanged();
      await harness.worker.tick();
      assert.equal(fetches, 1);
      assert.deepEqual(delivered, []);
      assert.match(harness.state.status.accounts.alice.lastError, /恢复原目标/);
      assert.equal(capturedState(harness).pending.length, 1);
    }
    now += 31000;
    token = 'bot-original';
    harness.worker.configChanged();
    await harness.worker.tick();
    assert.deepEqual(delivered, [{ botToken: 'bot-original', chatId: '1', text: 'original' }]);
  } finally { harness.restore(); restoreTimers(); Date.now = previousNow; }
});

test('account removal discards its queue and a later re-add starts a fresh baseline', { concurrency: false }, async () => {
  const config = watcherConfig();
  const harness = loadWorker({
    config, storedSent: { alice: ['1'] },
    bird: { async fetchTweets() { return { ok: true, tweets: [{ id: '2' }, { id: '1' }] }; } },
    telegram: { formatTweet: (tweet) => tweet.id, async sendMessage() { return { ok: false, permanent: true }; } },
  });
  try {
    await harness.worker.tick();
    assert.equal(capturedState(harness).pending.length, 1);
    config.accounts = [];
    harness.worker.configChanged();
    await harness.worker.tick();
    assert.deepEqual(harness.files.get('delivery_state.json').accounts, {});
    config.accounts = [account('alice')];
    harness.worker.configChanged();
    await harness.worker.tick();
    assert.equal(capturedState(harness).pending.length, 0);
    assert.equal(harness.state.status.accounts.alice.ok, true);
    assert.match(harness.state.logs.at(-1), /首次运行/);
  } finally { harness.restore(); }
});

test('a recorded acquisition gap stays unhealthy across successful later checks and restart', { concurrency: false }, async () => {
  const restoreTimers = fastTimers();
  let harness;
  const config = watcherConfig();
  try {
    harness = loadWorker({
      config, storedSent: { alice: ['1'] },
      bird: { async fetchTweets() { return { ok: true, tweets: [{ id: '4' }], coverage: { complete: true, reachedSince: false, exhausted: false } }; } },
      telegram: { formatTweet: (tweet) => tweet.id, async sendMessage() { return { ok: true }; } },
    });
    await harness.worker.tick();
    assert.equal(harness.state.status.accounts.alice.ok, false);
    const files = harness.files;
    harness.restore();
    harness = loadWorker({
      config, files,
      bird: { async fetchTweets() { return { ok: true, tweets: [{ id: '4' }], coverage: { complete: true, reachedSince: true, exhausted: false } }; } },
      telegram: noSendTelegram,
    });
    await harness.worker.tick();
    assert.equal(harness.state.status.accounts.alice.ok, false);
    assert.match(harness.state.status.accounts.alice.lastError, /未覆盖上次水位 1/);
  } finally { if (harness) harness.restore(); restoreTimers(); }
});

test('a missing established queue cannot silently revert to legacy sent ids', { concurrency: false }, async () => {
  const harness = loadWorker({
    config: watcherConfig(),
    bird: { async fetchTweets() { return { ok: true, tweets: [{ id: '1' }] }; } },
    telegram: noSendTelegram,
  });
  try {
    await harness.worker.tick();
    harness.files.delete('delivery_state.json');
    await assert.rejects(harness.worker.tick(), /delivery_state.json/);
    assert.equal(harness.state.status.running, false);
    assert.equal(harness.state.status.lastTickAt, null);
  } finally { harness.restore(); }
});

test('a partial page cannot enqueue messages or advance a previously durable checkpoint', { concurrency: false }, async () => {
  const harness = loadWorker({
    config: watcherConfig(), storedSent: { alice: ['1'] },
    bird: { async fetchTweets() { return { ok: true, tweets: [{ id: '3' }], coverage: { complete: false, reachedSince: true } }; } },
    telegram: noSendTelegram,
  });
  try {
    await harness.worker.tick();
    assert.equal(capturedState(harness).watermark, '1');
    assert.deepEqual(capturedState(harness).pending, []);
    assert.match(harness.state.status.accounts.alice.lastError, /页面不完整/);
    assert.equal(harness.state.status.accounts.alice.ok, false);
  } finally { harness.restore(); }
});

test('a bounded poll with no overlap warns even if its returned tweets are all already known', { concurrency: false }, async () => {
  const harness = loadWorker({
    config: watcherConfig(), storedSent: { alice: ['1', '2'] },
    bird: { async fetchTweets() { return { ok: true, tweets: [{ id: '1', is_pinned: true }],
      coverage: { complete: true, reachedSince: false, exhausted: false } }; } },
    telegram: noSendTelegram,
  });
  try {
    await harness.worker.tick();
    assert.equal(capturedState(harness).watermark, '2');
    assert.equal(harness.state.status.accounts.alice.ok, false);
    assert.match(harness.state.status.accounts.alice.lastError, /未覆盖上次水位 2/);
  } finally { harness.restore(); }
});

test('an in-flight send is durably acknowledged after removal without recreating account UI state', { concurrency: false }, async () => {
  const restoreTimers = fastTimers();
  const config = watcherConfig();
  let releaseSend;
  let announceSend;
  const sending = new Promise((resolve) => { announceSend = resolve; });
  const harness = loadWorker({
    config, storedSent: { alice: ['1'] },
    bird: { async fetchTweets() { return { ok: true, tweets: [{ id: '2' }, { id: '1' }] }; } },
    telegram: { formatTweet: (tweet) => tweet.id, sendMessage() {
      announceSend(); return new Promise((resolve) => { releaseSend = resolve; });
    } },
  });
  harness.state.addPush = (user) => harness.state.setAccount(user, { pushed: true });
  try {
    const activeTick = harness.worker.tick();
    await sending;
    config.accounts = [];
    harness.worker.configChanged();
    harness.state.pruneAccounts([]);
    releaseSend({ ok: true });
    await activeTick;
    assert.equal(capturedState(harness).pending.length, 0);
    assert.equal(Object.hasOwn(harness.state.status.accounts, 'alice'), false);
  } finally { harness.restore(); restoreTimers(); }
});

test('a case-only username edit preserves and delivers the same account queue', { concurrency: false }, async () => {
  const restoreTimers = fastTimers();
  const config = watcherConfig();
  let fail = true;
  const delivered = [];
  const harness = loadWorker({
    config, storedSent: { Alice: ['1'] },
    bird: { async fetchTweets({ username }) {
      return { ok: true, tweets: username === 'alice' ? [{ id: '2', text: 'retained body' }, { id: '1' }]
        : [{ id: '3', text: 'third' }, { id: '2' }], coverage: { complete: true, reachedSince: true } };
    } },
    telegram: { formatTweet: (tweet) => tweet.text, async sendMessage({ text }) {
      if (fail) return { ok: false, permanent: true };
      delivered.push(text); return { ok: true };
    } },
  });
  try {
    await harness.worker.tick();
    assert.equal(capturedState(harness).pending[0].text, 'retained body');
    config.accounts = [account('ALICE')];
    harness.worker.configChanged();
    fail = false;
    await harness.worker.tick();
    assert.deepEqual(delivered, ['retained body', 'third']);
    assert.deepEqual(Object.keys(harness.files.get('delivery_state.json').accounts), ['alice']);
    assert.equal(harness.state.status.accounts.ALICE.ok, true);
  } finally { harness.restore(); restoreTimers(); }
});

test('failure to persist initial state or marker blocks polling and sends until restart repairs it', { concurrency: false }, async () => {
  const restoreTimers = fastTimers();
  let harness;
  const config = watcherConfig();
  try {
    for (const failedFile of ['delivery_state.json', 'delivery_state.initialized.json']) {
      let fetches = 0;
      harness = loadWorker({
        config, storedSent: { alice: ['1'] },
        writeError(name) { if (name === failedFile) throw new Error('synthetic initialization failure'); },
        bird: { async fetchTweets() { fetches++; return { ok: true, tweets: [{ id: '2' }, { id: '1' }] }; } },
        telegram: noSendTelegram,
      });
      await assert.rejects(harness.worker.tick(), /保存失败/);
      assert.equal(harness.state.status.running, false);
      assert.equal(harness.state.status.lastTickAt, null);
      assert.equal(fetches, 0);
      const files = harness.files;
      assert.equal(files.has('delivery_state.initialized.json'), false);
      assert.deepEqual(files.get('sent_ids.json'), { alice: ['1'] });
      if (failedFile === 'delivery_state.initialized.json') {
        assert.equal(capturedState(harness).watermark, '1');
        assert.deepEqual(capturedState(harness).pending, []);
      }
      harness.restore();
      const delivered = [];
      harness = loadWorker({
        config, files,
        bird: { async fetchTweets() {
          assert.deepEqual(files.get('delivery_state.initialized.json'), { version: 1 });
          return { ok: true, tweets: [{ id: '2', text: 'new body' }, { id: '1' }] };
        } },
        telegram: { formatTweet: (tweet) => tweet.text, async sendMessage({ text }) {
          delivered.push(text); return { ok: true };
        } },
      });
      await harness.worker.tick();
      assert.deepEqual(delivered, ['new body']);
      assert.equal(capturedState(harness).pending.length, 0);
      harness.restore();
      harness = null;
    }
  } finally { if (harness) harness.restore(); restoreTimers(); }
});

test('an empty nonterminal fetch cannot create a first-run time watermark', { concurrency: false }, async () => {
  const harness = loadWorker({
    config: watcherConfig(),
    bird: { async fetchTweets() { return { ok: true, tweets: [], coverage: { complete: true, exhausted: false } }; } },
    telegram: noSendTelegram,
  });
  try {
    await harness.worker.tick();
    assert.deepEqual(harness.files.get('delivery_state.json').accounts, {});
    assert.equal(harness.state.status.accounts.alice.ok, false);
    assert.match(harness.state.status.accounts.alice.lastError, /页面不完整/);
  } finally { harness.restore(); }
});

test('an unchanged timeline durably migrates legacy IDs before polling and refuses queue loss after restart', { concurrency: false }, async () => {
  const config = { ...watcherConfig(), persisted: true };
  let harness;
  try {
    harness = loadWorker({
      config, storedSent: { alice: ['3', '1', '2'], removed: ['9'] },
      bird: { async fetchTweets({ sinceId }) {
        assert.equal(sinceId, '3');
        assert.deepEqual(Object.keys(harness.files.get('delivery_state.json').accounts), ['alice']);
        assert.deepEqual(harness.files.get('delivery_state.initialized.json'), { version: 1 });
        return { ok: true, tweets: [{ id: '3' }, { id: '2' }, { id: '1' }] };
      } },
      telegram: noSendTelegram,
    });
    await harness.worker.tick();
    assert.deepEqual(capturedState(harness), {
      sent: ['3', '1', '2'], watermark: '3', pending: [], destination: null, gap: null,
    });
    assert.equal(harness.state.status.accounts.alice.ok, true);
    const writeCount = harness.writes.length;
    await harness.worker.tick();
    assert.equal(harness.writes.length, writeCount);
    const files = harness.files;
    files.delete('delivery_state.json');
    harness.restore();
    harness = loadWorker({
      config, files,
      bird: { async fetchTweets() { throw new Error('must not poll after queue loss'); } },
      telegram: noSendTelegram,
    });
    await assert.rejects(harness.worker.tick(), { code: 'DATA_CORRUPT' });
    assert.equal(files.has('delivery_state.json'), false);
    assert.equal(harness.state.status.running, false);
    assert.equal(harness.state.status.lastTickAt, null);
  } finally { if (harness) harness.restore(); }
});

test('a saved unchanged config initializes legacy state even when pruning has no changes', { concurrency: false }, async () => {
  const harness = loadWorker({
    config: { ...watcherConfig(), persisted: true }, storedSent: { alice: ['1'] },
    bird: { async fetchTweets({ sinceId }) {
      assert.equal(sinceId, '1');
      assert.equal(capturedState(harness).watermark, '1');
      assert.deepEqual(harness.files.get('delivery_state.initialized.json'), { version: 1 });
      return { ok: true, tweets: [{ id: '1' }] };
    } },
    telegram: noSendTelegram,
  });
  try {
    await harness.worker.tick();
    assert.deepEqual(capturedState(harness).sent, ['1']);
    assert.deepEqual(capturedState(harness).pending, []);
    assert.equal(harness.state.status.accounts.alice.lastPushed, 0);
    assert.equal(harness.state.status.accounts.alice.ok, true);
  } finally { harness.restore(); }
});

test('read-only scheduler never touches config or outbox while manual collection remains available', { concurrency: false }, async () => {
  let reads = 0;
  let fetches = 0;
  const harness = loadWorker({
    mode: 'read-only',
    config: () => { reads++; return watcherConfig(); },
    twscrape: { async fetchTweets() {
      fetches++;
      return { ok: true, tweets: [{ id: '3', text: 'synthetic' }], coverage: { complete: true, reachedSince: false, exhausted: false, newestId: '3' } };
    } },
    telegram: noSendTelegram,
  });
  try {
    harness.worker.start();
    await harness.worker.tick();
    assert.equal(reads, 0);
    assert.equal(harness.writes.length, 0);
    assert.equal((await harness.worker.testTelegram()).disabled, true);
    const result = await harness.worker.testCollector('alice');
    assert.equal(result.ok, true);
    assert.equal(result.collector, 'twscrape');
    assert.equal(fetches, 1);
    assert.equal(harness.writes.length, 0);
  } finally { harness.restore(); }
});

test('live twscrape durable delivery preserves relationships across failed send and process restart', { concurrency: false }, async () => {
  const restoreTimers = fastTimers();
  const relations = { replyToId: '7', quoteId: '8', repostId: null, editIds: ['9', '11'] };
  const post = { id: '11', text: 'durable synthetic body', relations };
  let harness;
  let calls = 0;
  let attempt = 0;
  try {
    harness = loadWorker({
      config: watcherConfig(), mode: 'live',
      twscrape: { async fetchTweets({ sinceId }) {
        calls++;
        if (!sinceId) return { ok: true, tweets: [{ id: '10' }], coverage: { complete: true, exhausted: false, reachedSince: false, newestId: '10' } };
        return { ok: true, tweets: [post, { id: '10' }], coverage: { complete: true, exhausted: false, reachedSince: true, newestId: '11' } };
      } },
      telegram: {
        formatTweet: (tweet) => tweet.text,
        async sendMessage() {
          attempt++;
          const persisted = capturedState(harness);
          assert.equal(persisted.watermark, '11');
          assert.deepEqual(persisted.pending[0].relations, relations);
          assert.equal(persisted.pending[0].text, post.text);
          return { ok: false, permanent: true, description: 'synthetic outage' };
        },
      },
    });
    await harness.worker.tick();
    assert.equal(capturedState(harness).watermark, '10');
    assert.equal(attempt, 0, 'initial snapshot establishes baseline without historical delivery');
    // A fresh worker also verifies first restart loads baseline without replay.
    const files = harness.files;
    const provider = require.cache[require.resolve('../lib/twscrape')].exports;
    const telegram = require.cache[require.resolve('../lib/telegram')].exports;
    harness.restore();
    harness = loadWorker({ config: watcherConfig(), mode: 'live', files, twscrape: provider, telegram });
    await harness.worker.tick();
    assert.equal(attempt, 1);
    assert.equal(capturedState(harness).pending.length, 1);
    harness.restore();
    const delivered = [];
    harness = loadWorker({
      config: watcherConfig(), mode: 'live', files,
      twscrape: { async fetchTweets({ sinceId }) {
        assert.equal(sinceId, '11');
        return { ok: false, code: 'NETWORK_ERROR', error: 'synthetic X outage' };
      } },
      telegram: {
        formatTweet: (tweet) => { assert.deepEqual(tweet.relations, relations); return tweet.text; },
        async sendMessage({ text }) { delivered.push(text); return { ok: true }; },
      },
    });
    await harness.worker.tick();
    assert.deepEqual(delivered, [post.text], 'saved body remains deliverable while X is unavailable');
    assert.equal(capturedState(harness).pending.length, 0);
    assert.ok(capturedState(harness).sent.includes('11'));
    assert.equal(calls, 2);
  } finally { if (harness) harness.restore(); restoreTimers(); }
});

test('live twscrape missing coverage or an unreached checkpoint cannot advance the durable watermark', { concurrency: false }, async () => {
  for (const coverage of [undefined, { complete: true, exhausted: false, reachedSince: false }]) {
    const harness = loadWorker({
      mode: 'live', config: watcherConfig(), storedSent: { alice: ['10'] },
      twscrape: { async fetchTweets() { return { ok: true, tweets: [{ id: '11' }], coverage }; } },
      telegram: noSendTelegram,
    });
    try {
      await harness.worker.tick();
      assert.equal(capturedState(harness).watermark, '10');
      assert.deepEqual(capturedState(harness).pending, []);
      assert.equal(harness.state.status.accounts.alice.ok, false);
    } finally { harness.restore(); }
  }
});

test('live collection serializes targets that share one X login', { concurrency: false }, async () => {
  let active = 0;
  let peak = 0;
  const checked = [];
  const harness = loadWorker({
    mode: 'live', config: { ...watcherConfig(), accounts: ['alice', 'bob', 'carol'].map(account) },
    twscrape: { async fetchTweets({ username }) {
      active++;
      peak = Math.max(peak, active);
      checked.push(username);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return { ok: true, tweets: [{ id: '10' }], coverage: { complete: true, exhausted: false, reachedSince: false, newestId: '10' } };
    } },
    telegram: noSendTelegram,
  });
  try {
    await harness.worker.tick();
    assert.deepEqual(checked, ['alice', 'bob', 'carol']);
    assert.equal(peak, 1);
  } finally { harness.restore(); }
});

test('newer pin and module context cannot hide later chronological posts after restart', { concurrency: false }, async () => {
  const restoreTimers = fastTimers();
  let harness;
  const delivered = [];
  try {
    harness = loadWorker({
      mode: 'live', config: watcherConfig(),
      twscrape: { async fetchTweets({ sinceId }) {
        assert.equal(sinceId, undefined);
        return { ok: true, tweets: [{ id: '500', is_pinned: true }, { id: '450', text: 'module context' }, { id: '300' }],
          coverage: { complete: true, exhausted: false, reachedSince: false, newestId: '300' } };
      } },
      telegram: noSendTelegram,
    });
    await harness.worker.tick();
    assert.equal(capturedState(harness).watermark, '500');
    assert.equal(capturedState(harness).acquisitionWatermark, '300');
    const files = harness.files;
    harness.restore();
    harness = loadWorker({
      mode: 'live', config: watcherConfig(), files,
      twscrape: { async fetchTweets({ sinceId }) {
        assert.equal(sinceId, '300');
        return { ok: true, tweets: [{ id: '500', is_pinned: true }, { id: '450', text: 'module context' }, { id: '350' }, { id: '300' }],
          coverage: { complete: true, exhausted: false, reachedSince: true, newestId: '350' } };
      } },
      telegram: { formatTweet: (tweet) => tweet.id, async sendMessage({ text }) { delivered.push(text); return { ok: true }; } },
    });
    await harness.worker.tick();
    assert.deepEqual(delivered, ['350']);
    assert.equal(capturedState(harness).watermark, '500');
    assert.equal(capturedState(harness).acquisitionWatermark, '350');
    assert.equal(harness.state.status.accounts.alice.ok, true);
  } finally { if (harness) harness.restore(); restoreTimers(); }
});

test('previously observed context can advance acquisition when it later becomes chronological without redelivery', { concurrency: false }, async () => {
  const previousNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  let round = 0;
  const harness = loadWorker({
    mode: 'live', config: watcherConfig(),
    twscrape: { async fetchTweets({ sinceId }) {
      assert.equal(sinceId, [undefined, '300', '500'][round]);
      return { ok: true, tweets: [{ id: '500' }, { id: '300' }],
        coverage: { complete: true, exhausted: false, reachedSince: round > 0, newestId: round++ ? '500' : '300' } };
    } },
    telegram: noSendTelegram,
  });
  try {
    await harness.worker.tick();
    assert.equal(capturedState(harness).acquisitionWatermark, '300');
    now += 31000;
    await harness.worker.tick();
    assert.equal(capturedState(harness).acquisitionWatermark, '500');
    assert.deepEqual(capturedState(harness).pending, []);
    now += 31000;
    await harness.worker.tick();
    assert.equal(round, 3);
    assert.equal(harness.state.status.accounts.alice.ok, true);
  } finally { harness.restore(); Date.now = previousNow; }
});

test('foreign conversation context is never delivered under the monitored account', { concurrency: false }, async () => {
  const restoreTimers = fastTimers();
  const delivered = [];
  const harness = loadWorker({
    mode: 'live', config: watcherConfig(), storedSent: { alice: ['300'] },
    twscrape: { async fetchTweets({ sinceId }) {
      assert.equal(sinceId, '300');
      return { ok: true, tweets: [
        { id: '999', author_username: 'bob', text: 'foreign module context' },
        { id: '350', author_username: 'ALICE', text: 'own new post' },
        { id: '300', author_username: 'alice' },
      ], coverage: { complete: true, exhausted: false, reachedSince: true, newestId: '350' } };
    } },
    telegram: { formatTweet: (tweet) => tweet.text, async sendMessage({ text }) { delivered.push(text); return { ok: true }; } },
  });
  try {
    await harness.worker.tick();
    assert.deepEqual(delivered, ['own new post']);
    assert.equal(capturedState(harness).acquisitionWatermark, '350');
    assert.ok(!capturedState(harness).sent.includes('999'));
  } finally { harness.restore(); restoreTimers(); }
});

test('live collection missing or invalid chronological identity cannot advance state', { concurrency: false }, async () => {
  for (const newestId of [undefined, null, 11, 'bad', '12']) {
    const harness = loadWorker({
      mode: 'live', config: watcherConfig(), storedSent: { alice: ['10'] },
      twscrape: { async fetchTweets() { return { ok: true, tweets: [{ id: '11' }, { id: '10' }],
        coverage: { complete: true, exhausted: false, reachedSince: true, newestId } }; } },
      telegram: noSendTelegram,
    });
    try {
      await harness.worker.tick();
      assert.equal(capturedState(harness).watermark, '10');
      assert.deepEqual(capturedState(harness).pending, []);
      assert.equal(harness.state.status.accounts.alice.ok, false);
    } finally { harness.restore(); }
  }
});

test('bounded slow collection keeps a fresh heartbeat and always clears its heartbeat timer', { concurrency: false }, async (t) => {
  let heartbeat;
  let cleared = false;
  let now = 100000;
  const timer = { unref() {} };
  t.mock.method(Date, 'now', () => now);
  t.mock.method(global, 'setInterval', (callback, delay) => { assert.equal(delay, 15000); heartbeat = callback; return timer; });
  t.mock.method(global, 'clearInterval', (value) => { assert.equal(value, timer); cleared = true; });
  const harness = loadWorker({
    mode: 'live', config: watcherConfig(),
    twscrape: { async fetchTweets() {
      now += 61000;
      heartbeat();
      assert.equal(harness.state.status.lastTickAt, now);
      throw new Error('synthetic bounded request timeout');
    } },
    telegram: noSendTelegram,
  });
  try {
    await harness.worker.tick();
    assert.equal(cleared, true);
    assert.equal(harness.state.status.accounts.alice.ok, false);
    assert.deepEqual(harness.files.get('delivery_state.json').accounts, {});
  } finally { harness.restore(); }
});
