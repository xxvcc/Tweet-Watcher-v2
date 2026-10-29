'use strict';
// Browser integration against the real Express app and worker. The harness
// substitutes external services only; application API responses are never mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const VIEWPORTS = [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 740 }];

async function api(page, endpoint, body) {
  return page.evaluate(async ({ endpoint, body }) => {
    const match = document.cookie.match(/(?:^|; )tw_csrf=([^;]*)/);
    const response = await fetch(endpoint, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf': decodeURIComponent(match?.[1] || '') },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let result; try { result = await response.json(); } catch (_) { result = null; }
    return { status: response.status, body: result };
  }, { endpoint, body });
}

async function clickResponse(page, locator, endpoint, options = {}) {
  await revealSettingsControl(page, locator);
  const pending = page.waitForResponse((response) => new URL(response.url()).pathname === endpoint
    && response.request().method() === 'POST', { timeout: options.timeout ?? 110000 });
  pending.catch(() => {}); // A failed click may close the page before this awaited response arrives.
  await locator.click();
  const response = await pending;
  return { status: response.status(), body: options.readBody === false ? null : await response.json() };
}

async function login(page, baseUrl, password) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth').waitFor({ state: 'visible' });
  await page.locator('#auth-pw').fill(password);
  const result = await clickResponse(page, page.locator('#auth-submit'), '/api/login');
  assert.equal(result.status, 200); assert.equal(result.body.ok, true);
  await page.locator('#dash').waitFor({ state: 'visible' });
}

async function openSettings(page) {
  if (await page.locator('#settings').isVisible()) return;
  await page.locator('#btn-settings').click();
  await page.locator('.drawer').evaluate(async (drawer) => {
    await Promise.all(drawer.getAnimations().map((animation) => animation.finished));
  });
}

async function closeSettings(page) {
  if (await page.locator('#settings').isVisible()) await page.locator('#settings-close').click();
}

async function selectSettingsTab(page, name) {
  await openSettings(page);
  const tab = page.locator(`[data-settings-tab="${name}"]`);
  const category = page.locator('#settings-category');
  if (await category.count() && await category.isVisible()) await category.selectOption(name);
  else if (await tab.count()) await tab.click();
  if (await tab.count()) await page.locator(`[data-settings-panel="${name}"]`).waitFor({ state: 'visible' });
}

async function revealSettingsControl(page, locator) {
  const panel = await locator.evaluate((node) => node.closest('[data-settings-panel]')?.dataset.settingsPanel || null);
  if (panel) await selectSettingsTab(page, panel);
  // Use the native summaries so editing follows the same path as a person.
  const closed = locator.locator('xpath=ancestor::details[not(@open)]');
  while (await closed.count()) await closed.first().locator(':scope > summary').click();
}

async function save(page) {
  const result = await clickResponse(page, page.locator('#btn-save'), '/api/config');
  assert.equal(result.status, 200, 'real API must accept the source draft');
  assert.equal(result.body.ok, true);
  await page.waitForFunction(() => !document.querySelector('#btn-save').disabled
    && document.querySelector('#toast').textContent.includes('配置已保存'));
  return result.body;
}

async function query(page, locator, endpoint) {
  const result = await clickResponse(page, locator, endpoint);
  assert.equal(result.status, 200, endpoint + ' HTTP status');
  assert.equal(result.body.ok, true, endpoint + ' must succeed through the actual worker and collector');
  await page.waitForFunction(() => !document.querySelector('#btn-test-collector').disabled);
  return result.body;
}

async function addSource(page, { type = 'user', identity, mode = 'posts' }) {
  await revealSettingsControl(page, page.locator('#btn-add-acct'));
  await page.locator('#btn-add-acct').click();
  const row = page.locator('.acct-row').last();
  await row.locator('[data-role=type]').selectOption(type);
  await row.locator('[data-role=name]').fill(identity);
  if (type === 'user') await row.locator('[data-role=mode]').selectOption(mode);
  return row;
}

async function screenshots(page, directory, prefix) {
  await closeSettings(page);
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
      `dashboard overflows ${viewport.width}px viewport`);
    await page.screenshot({ path: path.join(directory, `${prefix}-panel-${viewport.width}.png`), animations: 'disabled' });
    await openSettings(page);
    await selectSettingsTab(page, 'sources');
    await page.locator('.drawer').evaluate((drawer) => { drawer.scrollTop = 0; });
    assert.equal(await page.evaluate(() => {
      const drawer = document.querySelector('.drawer');
      return drawer.scrollWidth <= drawer.clientWidth && document.documentElement.scrollWidth <= innerWidth;
    }), true, `settings overflow ${viewport.width}px viewport`);
    await page.screenshot({ path: path.join(directory, `${prefix}-settings-${viewport.width}.png`), animations: 'disabled' });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#settings').isVisible(), false);
  }
  await page.setViewportSize(VIEWPORTS[0]);
}

async function browserContext(baseUrl) {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [] });
  const context = await browser.newContext({ viewport: VIEWPORTS[0], locale: 'zh-CN', serviceWorkers: 'block' });
  const requests = [], forbidden = [], errors = [];
  const origin = new URL(baseUrl).origin;
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { forbidden.push(url.origin); return route.abort(); }
    requests.push({ path: url.pathname, method: route.request().method() });
    return route.continue();
  });
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  return { browser, context, requests, forbidden, errors };
}

async function configureSources(page) {
  await openSettings(page);
  await addSource(page, { identity: 'alice' });
  await addSource(page, { identity: 'alice', mode: 'replies' });
  const list = await addSource(page, { type: 'list', identity: '123' });
  await revealSettingsControl(page, list.locator('[data-role=include]'));
  await list.locator('[data-role=include]').fill('Simulation, 开发');
  await list.locator('[data-role=exclude]').fill('advertisement');
  await list.locator('[data-role=reposts]').uncheck();
  await addSource(page, { type: 'search', identity: 'Simulation lang:en' });
  await revealSettingsControl(page, page.locator('#btn-add-session'));
  await page.locator('#btn-add-session').click();
  const session = page.locator('.session-row');
  await session.locator('[data-role=id]').fill('backup');
  await session.locator('[data-role=label]').fill('拟真备用会话');
  await session.locator('[data-role=auth_token]').fill('SYNTHETIC_backup');
  await session.locator('[data-role=ct0]').fill('SYNTHETIC_CSRF_backup');
  await revealSettingsControl(page, page.locator('#media_mode'));
  await page.locator('#media_mode').selectOption('all');
  await page.locator('#enrichment_mode').selectOption('thread');
  await page.locator('#enrichment_limit').fill('3');
  await save(page);
  const result = await api(page, '/api/config');
  assert.equal(result.status, 200);
  const config = result.body;
  assert.deepEqual(config.accounts.slice(0, 3).map((a) => a.source_key), ['alice', 'replies:alice', 'list:123']);
  assert.match(config.accounts[3].source_key, /^search:[a-f0-9]{24}$/);
  assert.equal(config.accounts[2].filters.reposts, false);
  assert.deepEqual(config.accounts[2].filters.include, ['Simulation', '开发']);
  assert.deepEqual(config.accounts[2].filters.exclude, ['advertisement']);
  assert.equal(config.media_mode, 'all'); assert.equal(config.enrichment_mode, 'thread');
  assert.equal(config.enrichment_limit, 3);
  assert.equal(config.secrets.x_sessions.backup.hasAuthToken, true);
  assert.equal(await page.locator('.session-row [data-role=auth_token]').inputValue(), '');
  assert.equal(await page.locator('.session-row [data-role=ct0]').inputValue(), '');
  assert.doesNotMatch(JSON.stringify(config), /SYNTHETIC_(?:CSRF_)?backup/);
}

async function exerciseQueries(page, detailId) {
  await revealSettingsControl(page, page.locator('#session-test-user'));
  await page.locator('#session-test-user').fill('alice');
  await query(page, page.locator('.session-row [data-query]'), '/api/test/session');
  await page.waitForFunction(() => document.querySelector('#session-health').textContent.includes('拟真备用会话 · 最近请求成功'));
  const health = await api(page, '/api/status');
  assert.equal(health.body.diagnostics.sessions.backup.status, 'healthy');
  assert.ok(health.body.diagnostics.sessions.backup.lastSuccessAt > 0);
  for (let index = 0; index < 4; index++) {
    await query(page, page.locator('.acct-row').nth(index).getByRole('button', { name: '测试此来源', exact: true, includeHidden: true }), '/api/test/collector');
    assert.match(await page.locator('#x-test-result').textContent(), /成功/);
  }
  await revealSettingsControl(page, page.locator('#import-list-id'));
  await page.locator('#import-list-id').fill('123');
  const members = await query(page, page.locator('#btn-list-preview'), '/api/list/members');
  assert.ok(members.members.some((member) => member.username === 'alice'));
  assert.ok(members.members.some((member) => member.username === 'bob'));
  const before = (await api(page, '/api/config')).body.accounts.length;
  await page.locator('#list-preview label').filter({ hasText: /@alice\b/ }).locator('input').check();
  await page.locator('#list-preview label').filter({ hasText: /@bob\b/ }).locator('input').check();
  await page.locator('#btn-list-import').click();
  assert.equal(await page.locator('.acct-row').count(), before + 1, 'member import should skip the already configured user/posts source');
  assert.equal((await api(page, '/api/config')).body.accounts.length, before, 'member import must remain a draft until save');
  await save(page);
  assert.equal((await api(page, '/api/config')).body.accounts.at(-1).username, 'bob');
  await revealSettingsControl(page, page.locator('#inspect-tweet-id'));
  await page.locator('#inspect-tweet-id').fill(detailId);
  const detail = await query(page, page.locator('#btn-inspect-detail'), '/api/inspect/tweet');
  assert.ok(detail.tweets.some((tweet) => tweet.id === detailId));
  assert.match(await page.locator('#inspect-result').textContent(), /Simulation detail/);
  assert.match(await page.locator('#inspect-result').textContent(), /Simulation quote/);
  assert.match(await page.locator('#inspect-result').textContent(), /Simulation article/);
  assert.match(await page.locator('#inspect-result').textContent(), /<img src=x onerror=/);
  assert.equal(await page.locator('#inspect-result img').count(), 0);
  assert.equal(await page.locator('#inspect-result .media-link').count(), 1);
  const thread = await query(page, page.locator('#btn-inspect-thread'), '/api/inspect/tweet');
  assert.ok(thread.tweets.length >= 2);
  assert.match(await page.locator('#inspect-result').textContent(), /Simulation thread reply/);
  await query(page, page.locator('.acct-row').first().getByRole('button', { name: '重新开始补采', exact: true, includeHidden: true }), '/api/catchup/reset');
}

async function exerciseProviderTests(page) {
  await revealSettingsControl(page, page.locator('#ai_model'));
  await page.locator('#ai_model').fill('simulation-model');
  await page.locator('#ai_api_key').fill('synthetic-simulation-key');
  const before = (await api(page, '/api/config')).body;
  const result = await clickResponse(page, page.locator('#btn-test-ai'), '/api/test/ai');
  assert.equal(result.status, 200); assert.equal(result.body.ok, true); assert.ok(result.body.reply);
  assert.match(await page.locator('#ai-test-result').textContent(), /测试成功/);
  assert.equal((await api(page, '/api/config')).body.configRevision, before.configRevision,
    'hi test must not save other pending settings');
  await save(page);
  const telegram = await clickResponse(page, page.locator('#btn-test-tg'), '/api/test/telegram');
  assert.equal(telegram.status, 200); assert.equal(telegram.body.ok, true);
}

async function setPaused(page, paused) {
  await closeSettings(page);
  const button = page.locator(paused ? '#btn-pause' : '#btn-resume');
  await button.waitFor({ state: 'visible' });
  const result = await clickResponse(page, button, '/api/control');
  assert.equal(result.status, 200); assert.equal(result.body.paused, paused);
  assert.equal((await api(page, '/api/status')).body.paused, paused);
}

async function removePendingSource(page, key, count) {
  await openSettings(page);
  await selectSettingsTab(page, 'sources');
  const before = (await api(page, '/api/config')).body;
  const index = before.accounts.findIndex((account) => account.source_key === key);
  assert.ok(index >= 0);
  const rejection = await api(page, '/api/config', { config_revision: before.configRevision,
    accounts: before.accounts.filter((_, current) => current !== index) });
  assert.equal(rejection.status, 409); assert.equal(rejection.body.code, 'PENDING_REMOVAL_REQUIRES_CONFIRMATION');
  assert.ok(rejection.body.removed_pending.some((entry) => entry.source_key === key && entry.pendingCount === count));
  const remove = page.locator('.acct-row').nth(index).locator('.btn-x');
  await revealSettingsControl(page, remove);
  await remove.click();
  let message = '';
  page.once('dialog', async (dialog) => { message = dialog.message(); await dialog.dismiss(); });
  await page.locator('#btn-save').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已取消保存'));
  assert.ok(message.includes(count + ' 条待发送消息'));
  assert.equal((await api(page, '/api/config')).body.accounts.length, before.accounts.length);
  assert.equal((await api(page, '/api/status')).body.diagnostics.pendingCounts[key], count);
  page.once('dialog', async (dialog) => { message = dialog.message(); await dialog.accept(); });
  const committed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/config'
    && response.request().method() === 'POST' && response.status() === 200);
  await page.locator('#btn-save').click();
  assert.equal((await (await committed).json()).ok, true);
  await page.waitForFunction(() => !document.querySelector('#btn-save').disabled
    && document.querySelector('#toast').textContent.includes('配置已保存'));
  assert.equal((await api(page, '/api/config')).body.accounts.length, before.accounts.length - 1);
}

async function runBrowserSimulation() {
  const { createSimulation, tweet, author, idAt, waitFor } = require('./harness.cjs');
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'tweet-watcher-real-api-browser-'));
  const results = [];
  async function scenario(name, config, setup, exercise) {
    const h = await createSimulation({ name: 'browser-' + name,
      config: { paused: true, ai_translation_enabled: false, ...config } });
    let client, page;
    try {
      const fixtures = await setup(h);
      await h.start(); await h.tick(0);
      client = await browserContext(h.baseUrl);
      page = await client.context.newPage();
      await login(page, h.baseUrl, h.password);
      await exercise(h, page, client, fixtures);
      assert.deepEqual(client.errors, []); assert.deepEqual(client.forbidden, []); assert.deepEqual(h.forbidden, []);
      assert.equal(h.events.some((event) => event.type === 'emulator-error'), false);
      const result = { name, ok: true, realApiRequests: client.requests.filter((request) => request.path.startsWith('/api/')).length,
        xRequests: h.events.filter((event) => event.type === 'x').length,
        aiRequests: h.events.filter((event) => event.type === 'ai').length,
        telegramRequests: h.events.filter((event) => event.type === 'telegram').length,
        acceptedTelegramRequests: h.accepted.length, clientErrors: client.errors.length,
        blockedUnexpectedRequests: client.forbidden.length + h.forbidden.length,
        networkScope: 'application routing guards; no OS packet capture' };
      results.push(result); console.log(JSON.stringify({ progress: result }));
    } catch (error) {
      if (page) await page.screenshot({ path: path.join(artifacts, name + '-failure.png'), animations: 'disabled' }).catch(() => {});
      throw Object.assign(new Error(name + ': ' + error.message), { cause: error });
    } finally {
      if (client) await client.browser.close().catch(() => {});
      await h.close();
      const privateStateRemoved = !fs.existsSync(h.directory);
      const result = results.find((item) => item.name === name);
      if (result) result.privateStateRemoved = privateStateRemoved;
      assert.equal(privateStateRemoved, true, 'scenario private state must be removed');
    }
  }
  try {
    await scenario('features', { accounts: [] }, async (h) => {
      const now = Date.now(), detailId = idAt(now, 5);
      const baseline = tweet(idAt(now, 1), 'alice', { text: 'Simulation source baseline' });
      h.sources.set('user:alice', [baseline]); h.sources.set('replies:alice', [baseline]);
      h.sources.set('list:123', [baseline]); h.sources.set('search:Simulation lang:en', [baseline]);
      h.sources.set('user:bob', [tweet(idAt(now, 2), 'bob', { text: 'Simulation Bob baseline' })]);
      h.members.set('123', [author('alice'), author('bob')]);
      h.details.set(detailId, [tweet(detailId, 'alice', {
        text: 'Simulation detail <img src=x onerror=alert(1)>',
        quote: tweet(idAt(now, 3), 'bob', { text: 'Simulation quote' }),
        media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/simulation.jpg' }],
        article: { rest_id: idAt(now, 4), title: 'Simulation article', preview_text: 'Simulation article preview',
          content_state: { blocks: [{ text: 'Simulation article body' }] } },
      }), tweet(idAt(now, 6), 'bob', { text: 'Simulation thread reply', replyTo: detailId })]);
      return { detailId };
    }, async (h, page, client, { detailId }) => {
      await configureSources(page);
      await exerciseQueries(page, detailId);
      await exerciseProviderTests(page);
      await screenshots(page, artifacts, 'features');
      for (const operation of ['UserByScreenName', 'UserTweets', 'UserTweetsAndReplies', 'ListLatestTweetsTimeline',
        'SearchTimeline', 'ListMembers', 'TweetDetail']) assert.ok(h.events.some((event) => event.type === 'x'
        && event.operation === operation && event.signed), operation + ' must traverse the real signed Python bridge');
      assert.ok(h.events.some((event) => event.type === 'x' && event.session === 'backup'));
      assert.equal(h.events.filter((event) => event.type === 'ai').length, 1);
      assert.equal(h.events.find((event) => event.type === 'ai').body.messages.at(-1).content, 'hi');
      assert.equal(h.accepted.length, 1); assert.equal(h.accepted[0].method, 'sendMessage');
      assert.equal(Object.keys(h.read('delivery_state.json').accounts).length, 0,
        'manual queries must not create outbox baselines or pending messages');
    });

    await scenario('catchup-pending', { accounts: [{ username: 'alice', fetch_count: 1, check_interval: 30 }],
      media_mode: 'links', enrichment_mode: 'off' }, async (h) => {
      const now = Date.now(), initial = tweet(idAt(now), 'alice', { text: 'Simulation baseline' });
      h.sources.set('user:alice', [initial]); h.pageSize = 1;
      h.tgFault = () => ({ status: 503, body: { ok: false, description: 'Synthetic transient failure' } });
      return { now, initial };
    }, async (h, page, client, { now, initial }) => {
      await setPaused(page, false); await h.tick(0);
      assert.equal(h.read('delivery_state.json').accounts.alice.acquisitionWatermark, initial.rest_id);
      const additions = Array.from({ length: 8 }, (_, index) => tweet(idAt(now, 8 - index), 'alice', { text: 'Simulation catchup ' + index }));
      h.sources.set('user:alice', [...additions, initial]);
      await h.tick();
      let status = (await api(page, '/api/status')).body;
      assert.equal(status.diagnostics.backfills.alice.pages, 5);
      assert.equal(h.read('delivery_state.json').accounts.alice.acquisitionWatermark, initial.rest_id);
      await page.waitForFunction(() => document.querySelector('.card-catchup')?.textContent.includes('5 页'));
      await openSettings(page);
      await query(page, page.locator('.acct-row').first().getByRole('button', { name: '重新开始补采', exact: true, includeHidden: true }), '/api/catchup/reset');
      assert.deepEqual((await api(page, '/api/status')).body.diagnostics.backfills, {});
      assert.equal(h.read('delivery_state.json').accounts.alice.acquisitionWatermark, initial.rest_id);
      await h.tick(); await h.tick();
      status = (await api(page, '/api/status')).body;
      assert.equal(status.diagnostics.pendingCounts.alice, 8);
      assert.equal(h.read('delivery_state.json').accounts.alice.pending.length, 8);
      assert.equal(h.accepted.length, 0);
      await setPaused(page, true);
      await screenshots(page, artifacts, 'pending');
      await removePendingSource(page, 'alice', 8);
      await h.tick(0);
      assert.equal(h.read('delivery_state.json').accounts.alice, undefined);
      assert.equal(h.accepted.length, 0);
    });

    await scenario('pause-auth', { accounts: [{ username: 'alice', fetch_count: 10, check_interval: 30 }],
      media_mode: 'links', enrichment_mode: 'off' }, async (h) => {
      const now = Date.now(), initial = tweet(idAt(now), 'alice', { text: 'Simulation baseline before pause' });
      const added = tweet(idAt(now, 1), 'alice', { text: 'Simulation new message after resume' });
      h.sources.set('user:alice', [initial]);
      h.details.set(added.rest_id, [added]);
      return { initial, added };
    }, async (h, page, client, { initial, added }) => {
      await setPaused(page, false); await h.tick(0);
      h.sources.set('user:alice', [added, initial]);
      let held = false, release;
      let gate = new Promise((resolve) => { release = resolve; });
      h.xFault = async (call) => { if (call.operation === 'UserTweets') { held = true; await gate; } };
      const pendingTick = h.tick();
      pendingTick.catch(() => {});
      await waitFor(() => held, { label: 'real worker collection to reach held TLS response' });
      await setPaused(page, true); release(); await pendingTick;
      assert.equal(h.read('delivery_state.json').accounts.alice.acquisitionWatermark, initial.rest_id);
      assert.equal(h.read('delivery_state.json').accounts.alice.pending.length, 0);
      assert.equal(h.accepted.length, 0);
      h.xFault = undefined;
      await setPaused(page, false); await h.tick();
      assert.equal(h.accepted.length, 1);
      assert.match(h.accepted[0].fields.text, /Simulation new message after resume/);
      assert.equal(h.read('delivery_state.json').accounts.alice.pending.length, 0);
      await setPaused(page, true);
      await openSettings(page);
      await revealSettingsControl(page, page.locator('#inspect-tweet-id'));
      await page.locator('#inspect-tweet-id').fill(added.rest_id);
      held = false; gate = new Promise((resolve) => { release = resolve; });
      h.xFault = async (call) => { if (call.operation === 'TweetDetail') { held = true; await gate; } };
      const oldResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/inspect/tweet')
        .then((response) => ({ response }), (error) => ({ error }));
      await page.locator('#btn-inspect-detail').click();
      await waitFor(() => held, { label: 'real detail query to reach held TLS response' });
      assert.equal(await page.locator('#btn-inspect-thread').isDisabled(), true);
      const other = await client.context.newPage(); await other.goto(h.baseUrl, { waitUntil: 'domcontentloaded' });
      await other.locator('#dash').waitFor({ state: 'visible' });
      // Logout intentionally navigates immediately. Its body can disappear
      // from Chromium's protocol cache; the status and revoked query are the
      // behavior under test, so do not race navigation to reread that body.
      const loggedOut = await clickResponse(other, other.locator('#logout'), '/api/logout', { readBody: false });
      assert.equal(loggedOut.status, 200); release();
      const oldResult = await oldResponse;
      if (oldResult.error) throw oldResult.error;
      assert.equal(oldResult.response.status(), 401, 'revoked credentials must not receive the held query result');
      await page.locator('#auth').waitFor({ state: 'visible', timeout: 15000 });
      assert.equal(await page.locator('#inspect-result').isVisible(), false);
      assert.doesNotMatch(await page.locator('#inspect-result').textContent(), /Simulation new message/);
      await other.close();
    });
    const result = { ok: true, transport: 'real Express API, worker, Python signer/parser and local TLS services',
      appApiMocked: false, blockedUnexpectedRequests: results.reduce((sum, item) => sum + item.blockedUnexpectedRequests, 0),
      networkScope: 'application routing guards; no OS packet capture', scenarios: results, artifacts };
    fs.writeFileSync(path.join(artifacts, 'summary.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    return result;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message, artifacts })); throw error;
  }
}

module.exports = { api, clickResponse, login, openSettings, closeSettings, selectSettingsTab, revealSettingsControl,
  save, query, addSource, screenshots, browserContext,
  configureSources, exerciseQueries, exerciseProviderTests, setPaused, removePendingSource, runBrowserSimulation };

if (require.main === module) runBrowserSimulation().catch(() => { process.exitCode = 1; });
