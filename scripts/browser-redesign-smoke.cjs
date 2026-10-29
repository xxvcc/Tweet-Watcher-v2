'use strict';
// Dashboard/settings checks against real Express, persistence, worker and the
// Python collector. Only external services are replaced by local TLS fixtures.
// No production configuration, credentials, data or network service is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSimulation, tweet, idAt, waitFor } = require('./simulation/harness.cjs');
const { api, login, openSettings, closeSettings, selectSettingsTab, save, setPaused,
  clickResponse, browserContext, revealSettingsControl } = require('./simulation/browser.cjs');

const TABS = ['sources', 'connections', 'delivery', 'tools', 'security'];
const VIEWPORTS = [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 740 }];
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'tweet-watcher-redesign-browser-'));
let h, client, page, releaseAi;
let screenshotCount = 0;

async function capture(name, fullPage = false) {
  await page.screenshot({ path: path.join(artifacts, name + '.png'), fullPage, animations: 'disabled' });
  screenshotCount++;
}

async function assertLayout(label, drawer = false) {
  const result = await page.evaluate((checkDrawer) => {
    const dialog = document.querySelector('.drawer');
    const save = document.querySelector('#btn-save').getBoundingClientRect();
    return {
      pageFits: document.documentElement.scrollWidth <= innerWidth,
      readableText: [...document.querySelectorAll('.meta, .stat-caption, .source-badge, .hint, .ev')].every((node) => parseFloat(getComputedStyle(node).fontSize) >= 12),
      drawerFits: !checkDrawer || dialog.scrollWidth <= dialog.clientWidth,
      saveVisible: !checkDrawer || (save.left >= 0 && save.right <= innerWidth && save.top >= 0 && save.bottom <= innerHeight),
    };
  }, drawer);
  assert.deepEqual(result, { pageFits: true, readableText: true, drawerFits: true, saveVisible: true }, label);
}

async function setTheme(theme) {
  await closeSettings(page);
  for (let i = 0; i < 3; i++) {
    if (await page.locator('html').getAttribute('data-theme') === theme) return;
    await page.locator('#theme-toggle').click();
  }
  assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
}

async function exerciseSettings() {
  await selectSettingsTab(page, 'sources');
  const source = page.locator('.acct-row').first();
  assert.equal(await page.locator('details.acct-row').count(), 4);
  assert.equal(await page.locator('details.acct-row[open]').count(), 0, 'saved sources start as compact summaries');
  const pristine = await page.locator('#settings-save-state').getAttribute('data-state');
  await source.locator('.source-editor-summary').click();
  assert.equal(await source.getAttribute('open') !== null, true);
  assert.equal(await page.locator('#settings-save-state').getAttribute('data-state'), pristine,
    'opening an editor must not mark configuration dirty');
  await source.locator('[data-role=iv]').fill('45');
  await source.locator('.source-editor-summary').click();
  assert.equal(await source.locator('[data-role=iv]').isVisible(), false);
  assert.match(await source.locator('.source-editor-summary').textContent(), /45/);
  await source.locator('.source-editor-summary').click();
  assert.equal(await source.locator('[data-role=iv]').inputValue(), '45', 'collapsing preserves the field node and draft');
  await page.locator('#btn-add-acct').click();
  const newRow = page.locator('.acct-row').last();
  assert.equal(await newRow.getAttribute('open') !== null, true, 'new sources open for immediate editing');
  assert.equal(await newRow.locator('[data-role=name]').evaluate((node) => document.activeElement === node), true);
  await newRow.locator('.btn-x').click();
  assert.equal(await page.locator('.acct-row').count(), 4);
  await selectSettingsTab(page, 'connections');
  await page.locator('.session-row [data-role=auth_token]').fill('SYNTHETIC_backup_draft');
  await selectSettingsTab(page, 'delivery');
  await page.locator('#ai_model').fill('simulation-model-draft');
  await selectSettingsTab(page, 'tools');
  await page.locator('#inspect-tweet-id').fill('1234567890123456789');
  await selectSettingsTab(page, 'security');
  assert.equal(await page.locator('#settings-save-state').getAttribute('data-state'), 'dirty');
  await selectSettingsTab(page, 'sources');
  assert.equal(await source.locator('[data-role=iv]').inputValue(), '45');
  await selectSettingsTab(page, 'connections');
  assert.ok(await page.locator('.session-row [data-role=auth_token]').inputValue() === 'SYNTHETIC_backup_draft');
  await selectSettingsTab(page, 'delivery');
  assert.equal(await page.locator('#ai_model').inputValue(), 'simulation-model-draft');
  await selectSettingsTab(page, 'tools');
  assert.equal(await page.locator('#inspect-tweet-id').inputValue(), '1234567890123456789');

  const savesBefore = client.requests.filter((r) => r.path === '/api/config' && r.method === 'POST').length;
  await selectSettingsTab(page, 'sources');
  await source.locator('[data-role=name]').fill('');
  await source.locator('.source-editor-summary').click();
  assert.equal(await source.locator('[data-role=name]').isVisible(), false);
  await selectSettingsTab(page, 'security');
  await page.locator('#btn-save').click();
  await page.waitForFunction(() => document.activeElement?.dataset.role === 'name');
  assert.equal(await source.getAttribute('open') !== null, true, 'invalid collapsed source is expanded before focus');
  assert.equal(await page.locator('[data-settings-tab=sources]').getAttribute('aria-selected'), 'true');
  await source.locator('[data-role=name]').fill('alice');
  await selectSettingsTab(page, 'delivery');
  await page.locator('#enrichment_limit').fill('999');
  await selectSettingsTab(page, 'security');
  await page.locator('#btn-save').click();
  await page.waitForFunction(() => document.activeElement?.id === 'enrichment_limit');
  assert.equal(await page.locator('[data-settings-tab=delivery]').getAttribute('aria-selected'), 'true');
  assert.equal(client.requests.filter((r) => r.path === '/api/config' && r.method === 'POST').length, savesBefore,
    'hidden invalid fields must be revealed before a request is sent');
  await page.locator('#enrichment_limit').fill('2');
  const before = (await api(page, '/api/config')).body;
  await page.locator('#ai_base_url').fill('http://ai.sim.test/v1');
  await selectSettingsTab(page, 'security');
  await page.locator('#btn-save').click();
  await page.waitForFunction(() => document.activeElement?.id === 'ai_base_url');
  assert.equal(await page.locator('[data-settings-tab=delivery]').getAttribute('aria-selected'), 'true');
  assert.equal(client.requests.filter((r) => r.path === '/api/config' && r.method === 'POST').length, savesBefore,
    'the non-HTTPS URL must be rejected locally without posting any draft');
  assert.equal((await api(page, '/api/config')).body.configRevision, before.configRevision,
    'a rejected URL must not persist any draft');
  assert.equal(await source.locator('[data-role=iv]').inputValue(), '45');
  assert.ok(await page.locator('.session-row [data-role=auth_token]').inputValue() === 'SYNTHETIC_backup_draft');
  await page.locator('#ai_base_url').fill('https://ai.sim.test/v1');
  await save(page);
  const after = (await api(page, '/api/config')).body;
  assert.ok(after.configRevision > before.configRevision);
  assert.equal(after.accounts[0].check_interval, 45);
  assert.equal(await source.getAttribute('open') !== null, true, 'saving preserves the source being edited');
  assert.equal(after.ai_model, 'simulation-model-draft');
  assert.equal(await page.locator('.session-row [data-role=auth_token]').inputValue(), '');
  assert.doesNotMatch(JSON.stringify(after), /SYNTHETIC_backup_draft/);
  assert.equal(await page.locator('#settings-save-state').getAttribute('data-state'), 'saved');
  await closeSettings(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#dash').waitFor({ state: 'visible' });
  await selectSettingsTab(page, 'sources');
  assert.equal(await page.locator('details.acct-row[open]').count(), 0, 'a fresh page starts with compact source summaries');
  assert.equal(await source.locator('[data-role=iv]').inputValue(), '45');
  await selectSettingsTab(page, 'delivery');
  assert.equal(await page.locator('#ai_model').inputValue(), 'simulation-model-draft');

  await selectSettingsTab(page, 'sources');
  await page.locator('[data-settings-tab=sources]').focus();
  for (const [key, selected] of [['ArrowRight', 'connections'], ['End', 'security'], ['Home', 'sources']]) {
    await page.keyboard.press(key);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.settingsTab), selected);
    assert.equal(await page.locator(`[data-settings-tab=${selected}]`).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('[data-settings-tab][tabindex="0"]').count(), 1);
  }
  for (let i = 0; i < 65; i++) {
    await page.keyboard.press(i < 40 ? 'Tab' : 'Shift+Tab');
    assert.equal(await page.evaluate(() => {
      const active = document.activeElement;
      if (!active?.closest('.drawer') || active.closest('.hidden, [hidden], [inert]')) return false;
      let node = active;
      while (node && node.id !== 'settings') {
        if (node.tagName === 'DETAILS' && !node.open && active !== node.querySelector('summary')) return false;
        node = node.parentElement;
      }
      return active.getClientRects().length > 0;
    }), true, 'modal keyboard focus must stay on visible controls');
  }
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#settings').isVisible(), false);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'btn-settings');

  await selectSettingsTab(page, 'delivery');
  let aiHeld = false;
  const gate = new Promise((resolve) => { releaseAi = resolve; });
  h.aiFault = async () => { aiHeld = true; await gate; };
  const pending = clickResponse(page, page.locator('#btn-test-ai'), '/api/test/ai');
  pending.catch(() => {});
  await waitFor(() => aiHeld, { label: 'hi request at local TLS service' });
  assert.equal(await page.locator('#btn-test-ai').isDisabled(), true);
  assert.equal(await page.locator('#ai-test-result').getAttribute('aria-busy'), 'true');
  await selectSettingsTab(page, 'security');
  await selectSettingsTab(page, 'delivery');
  assert.equal(await page.locator('#btn-test-ai').isDisabled(), true);
  releaseAi();
  const result = await pending;
  assert.equal(result.status, 200); assert.equal(result.body.ok, true);
  await page.waitForFunction(() => !document.querySelector('#btn-test-ai').disabled);
  assert.match(await page.locator('#ai-test-result').textContent(), /你好，拟真服务已收到/);
  assert.equal((await api(page, '/api/config')).body.configRevision, after.configRevision, 'hi must not save config');
  assert.equal(h.events.filter((event) => event.type === 'ai').length, 1);
  assert.equal(h.events.find((event) => event.type === 'ai').body.messages.at(-1).content, 'hi');
  h.aiFault = undefined;
  await capture('hi-real-local-tls');
  await closeSettings(page);
}

async function exerciseActivityFocus() {
  await closeSettings(page);
  await page.locator('#activity-filter').selectOption('important');
  const details = page.locator('.activity-error').first();
  await details.waitFor({ state: 'visible' });
  const summary = details.locator(':scope > summary');
  await summary.focus();
  if (await details.getAttribute('open') === null) await page.keyboard.press('Enter');
  assert.equal(await details.locator('.error-original').isVisible(), true);
  const before = Number(await page.locator('#feed-count').textContent());
  const paused = await api(page, '/api/control', { action: 'pause' });
  assert.equal(paused.status, 200); assert.equal(paused.body.paused, true);
  await page.waitForFunction((count) => Number(document.querySelector('#feed-count').textContent) > count, before);
  assert.equal(await summary.evaluate((node) => node === document.activeElement), true,
    'an actual incoming SSE log must preserve keyboard focus on the existing error summary');
  assert.equal(await details.getAttribute('open') !== null, true);
}

async function focusOnly() {
  const now = Date.now();
  h = await createSimulation({ name: 'activity-focus-polish', config: {
    paused: true, ai_translation_enabled: false, media_mode: 'links',
    accounts: [{ username: 'alice', fetch_count: 1, check_interval: 30 }],
  } });
  const baseline = tweet(idAt(now, 1), 'alice', { text: 'Synthetic focus baseline' });
  h.sources.set('user:alice', [baseline]);
  await h.start(); await h.tick(0);
  client = await browserContext(h.baseUrl); page = await client.context.newPage();
  await login(page, h.baseUrl, h.password);
  await setPaused(page, false); await h.tick(0);
  h.sources.set('user:alice', [tweet(idAt(now, 2), 'alice', { text: 'Synthetic pending focus update' }), baseline]);
  h.tgFault = () => ({ status: 503, body: { ok: false, error_code: 503, description: 'Synthetic delivery outage' } });
  await h.tick(61000);
  await exerciseActivityFocus();
  assert.deepEqual(client.errors, []); assert.deepEqual(client.forbidden, []); assert.deepEqual(h.forbidden, []);
  assert.equal(h.accepted.length, 0);
  const result = { ok: true, artifacts, mode: 'focused-activity-keyboard', appApiMocked: false, productionAccess: false,
    transport: 'real Express, durable state, worker, Python signer/parser and local TLS external services',
    checks: ['keyboard-expands-original-error', 'new-log-via-real-control-api-and-sse', 'keyboard-focus-preserved', 'expanded-detail-preserved'],
    realApiRequests: client.requests.filter((r) => r.path.startsWith('/api/')).length,
    xRequests: h.events.filter((event) => event.type === 'x').length,
    simulatedTelegramRequests: h.events.filter((event) => event.type === 'telegram').length,
    simulatedTelegramAccepted: 0, clientErrors: 0, blockedUnexpectedRequests: 0 };
  fs.writeFileSync(path.join(artifacts, 'summary.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}

async function main() {
  const now = Date.now();
  const search = 'AI 开发 工具 lang:en';
  h = await createSimulation({ name: 'dashboard-redesign', config: {
    paused: true, ai_translation_enabled: false, media_mode: 'links',
    accounts: [
      { username: 'alice', fetch_count: 1, check_interval: 30 },
      { username: 'bob', timeline_mode: 'replies', fetch_count: 1, check_interval: 30 },
      { source_type: 'list', list_id: '123', fetch_count: 1, check_interval: 30 },
      { source_type: 'search', query: search, fetch_count: 1, check_interval: 30 },
    ], x_sessions: [{ id: 'backup', label: '拟真备用会话', enabled: true }],
  }, secrets: { x_sessions: { backup: { auth_token: 'SYNTHETIC_backup', ct0: 'SYNTHETIC_CSRF_backup' } } } });
  const baseline = tweet(idAt(now, 1), 'alice', { text: 'Simulation baseline' });
  const bobBase = tweet(idAt(now, 2), 'bob', { text: 'Simulation reply baseline' });
  const listBase = tweet(idAt(now, 3), 'carol', { text: 'Simulation List baseline' });
  h.sources.set('user:alice', [baseline]);
  h.sources.set('replies:bob', [bobBase]);
  h.sources.set('list:123', [listBase]);
  h.sources.set('search:' + search, [tweet(idAt(now, 4), 'dave', { text: 'Simulation search baseline' })]);
  await h.start(); await h.tick(0);
  client = await browserContext(h.baseUrl);
  page = await client.context.newPage();
  await login(page, h.baseUrl, h.password);
  await page.waitForFunction(() => document.querySelector('#stat-accounts').textContent === '4');
  await page.locator('#btn-resume').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.source-badge').count(), 4);
  const sourceLabels = await page.locator('.source-badge').allTextContents();
  assert.equal(new Set(sourceLabels).size, 4, 'source types must be visibly distinct');
  assert.equal(await page.locator('#session-summary').getAttribute('data-state'), 'unknown');
  assert.match(await page.locator('#session-summary').textContent(), /等待验证/);
  assert.equal(await page.locator('.spark').count(), 0, 'empty history must not render decorative fake charts');
  assert.equal(await page.getByText('本次运行暂无推送', { exact: true }).count(), 4);
  assert.equal(await page.locator('#btn-resume').isVisible(), true);
  await capture('initial-unknown-paused-1440', true);
  await exerciseSettings();

  await setPaused(page, false); await h.tick(0);
  assert.equal(Object.keys(h.read('delivery_state.json').accounts).length, 4);
  await page.waitForFunction(() => document.querySelector('#session-summary').dataset.state === 'known');
  await capture('baseline-success-1440', true);
  h.pageSize = 1;
  h.sources.set('user:alice', [...Array.from({ length: 8 }, (_, i) => tweet(idAt(now, 20 - i), 'alice', {
    text: 'Simulation catchup update ' + i })), baseline]);
  h.sources.set('replies:bob', [tweet(idAt(now, 30), 'bob', { text: 'Simulation pending reply', replyTo: bobBase.rest_id }), bobBase]);
  h.sources.set('list:123', [tweet(idAt(now, 31), 'carol', { text: 'Simulation pending List update' }), listBase]);
  h.tgFault = () => ({ status: 503, body: { ok: false, error_code: 503, description: 'Synthetic delivery outage' } });
  await h.tick(61000);
  const status = (await api(page, '/api/status')).body;
  assert.equal(status.diagnostics.backfills.alice.pages, 5);
  assert.equal(h.read('delivery_state.json').accounts.alice.acquisitionWatermark, baseline.rest_id);
  const pendingCount = Object.values(status.diagnostics.pendingCounts).reduce((sum, count) => sum + count, 0);
  assert.ok(pendingCount > 0); assert.equal(h.accepted.length, 0);
  await page.waitForFunction((count) => document.querySelector('#stat-pending').textContent === String(count), pendingCount);
  await page.waitForFunction(() => document.querySelector('.card-catchup')?.textContent.includes('5 页'));
  assert.doesNotMatch(await page.locator('.card-catchup').textContent(), /%/);
  const errorCard = page.locator('.card[data-user="alice"]');
  const errorDetails = errorCard.locator('details.errline');
  assert.equal(await errorDetails.count(), 1);
  assert.match(await errorDetails.locator('.err-summary').textContent(), /历史内容.*补齐/);
  assert.equal(await errorDetails.locator('.error-original').isVisible(), false);
  assert.equal(await errorDetails.locator('.error-original').textContent(), status.status.accounts.alice.lastError);
  await errorDetails.locator('summary').click();
  assert.equal(await errorDetails.locator('.error-original').isVisible(), true);
  await h.tick(0);
  await page.waitForTimeout(1200);
  assert.equal(await errorDetails.getAttribute('open') !== null, true, 'status updates preserve open error details');
  await errorDetails.locator('summary').click();
  await selectSettingsTab(page, 'connections');
  await page.locator('#session-test-user').fill('alice');
  h.xFault = (call) => call.session === 'backup' && call.operation === 'UserTweets'
    ? { status: 429, headers: { 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 3600) },
      body: { errors: [{ code: 88, message: 'Synthetic rate limit' }] } } : undefined;
  const rateLimit = await clickResponse(page, page.locator('.session-row [data-query]'), '/api/test/session');
  assert.equal(rateLimit.status, 200); assert.equal(rateLimit.body.ok, false);
  assert.equal(rateLimit.body.code, 'RATE_LIMITED');
  await closeSettings(page);
  await page.waitForFunction(() => document.querySelector('#session-summary').textContent.includes('限流冷却中'));
  assert.equal(await page.locator('#session-summary').getAttribute('data-state'), 'warning');
  const allLogs = (await api(page, '/api/logs')).body;
  await page.locator('#activity-filter').selectOption('all');
  assert.ok(Number(await page.locator('#feed-count').textContent()) > 0);
  await page.locator('#activity-filter').selectOption('errors');
  assert.match(await page.locator('#feed').textContent(), /失败|限流|异常/);
  const activityError = page.locator('.activity-error').first();
  assert.ok(await activityError.count());
  const rawActivity = await activityError.locator('.error-original').textContent();
  const retainedLogs = Array.isArray(allLogs) ? allLogs : allLogs.logs;
  assert.ok(retainedLogs.some((log) => log.msg === rawActivity), 'activity details retain the exact original log');
  assert.equal(await activityError.locator('.error-original').isVisible(), false);
  await activityError.locator('summary').click();
  assert.equal(await activityError.locator('.error-original').isVisible(), true);
  await page.locator('#activity-filter').selectOption('all');
  await page.locator('#activity-filter').selectOption('errors');
  assert.equal(await activityError.getAttribute('open') !== null, true,
    'changing activity filters preserves expanded error details');
  await activityError.locator('summary').click();
  await page.locator('#activity-filter').selectOption('important');

  for (const theme of ['light', 'dark']) {
    await setTheme(theme);
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await closeSettings(page);
      await assertLayout(`${theme} dashboard ${viewport.width}`);
      await capture(`${theme}-dashboard-${viewport.width}`, true);
      await page.locator('#session-details > summary').click();
      await capture(`${theme}-sessions-${viewport.width}`, true);
      await page.locator('#session-details > summary').click();
      for (const tab of TABS) {
        await selectSettingsTab(page, tab);
        await page.locator('.drawer-body').evaluate((node) => { node.scrollTop = 0; });
        const mobileCategory = page.locator('#settings-category');
        assert.equal(await mobileCategory.isVisible(), viewport.width <= 760,
          'phone navigation exposes a complete category selector');
        assert.equal(await mobileCategory.inputValue(), tab, 'desktop tabs and mobile selector remain synchronized');
        if (viewport.width <= 760) {
          assert.equal(await mobileCategory.locator('option').count(), TABS.length);
          assert.deepEqual(await mobileCategory.locator('option').evaluateAll((nodes) => nodes.map((node) => node.value)), TABS);
        }
        const saveState = await page.locator('#settings-save-state').getAttribute('data-state');
        assert.notEqual(saveState, 'dirty', 'navigation alone must not create a draft');
        if (tab === 'sources') {
          const openRows = page.locator('details.acct-row[open]');
          while (await openRows.count()) await openRows.first().locator('.source-editor-summary').click();
        }
        await assertLayout(`${theme} settings ${tab} ${viewport.width}`, true);
        await capture(`${theme}-settings-${tab}-${viewport.width}`);
        if (tab === 'sources') {
          await revealSettingsControl(page, page.locator('.acct-row').first().locator('[data-role=include]'));
          await page.locator('.drawer-body').evaluate((node) => { node.scrollTop = 0; });
          await assertLayout(`${theme} source editor ${viewport.width}`, true);
          await capture(`${theme}-source-editor-open-${viewport.width}`);
        }
      }
      await closeSettings(page);
    }
  }
  await setPaused(page, true);
  assert.equal(await page.locator('#btn-resume').isVisible(), true);
  await page.waitForFunction(() => document.querySelector('#overview-delivery').textContent.includes('已暂停'));
  assert.match(await page.locator('#overview-delivery').textContent(), /已暂停/);
  await capture('paused-with-pending-320', true);
  await exerciseActivityFocus();
  const beforeCsrf = (await api(page, '/api/config')).body.configRevision;
  const csrfStatus = await page.evaluate(async () => (await fetch('/api/config', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused: false }) })).status);
  assert.equal(csrfStatus, 403);
  assert.equal((await api(page, '/api/config')).body.configRevision, beforeCsrf);
  const unauth = await client.browser.newContext();
  for (const endpoint of ['/api/config', '/api/status']) assert.equal((await unauth.request.get(h.baseUrl + endpoint)).status(), 401);
  await unauth.close();
  await clickResponse(page, page.locator('#logout'), '/api/logout', { readBody: false });
  await page.locator('#auth').waitFor({ state: 'visible' });
  assert.equal((await api(page, '/api/config')).status, 401);
  assert.deepEqual(client.errors, []); assert.deepEqual(client.forbidden, []); assert.deepEqual(h.forbidden, []);
  assert.equal(h.events.some((event) => event.type === 'emulator-error'), false);
  const result = { ok: true, artifacts, screenshots: screenshotCount,
    transport: 'real Express, durable state, worker, Python signer/parser and local TLS external services',
    appApiMocked: false, productionAccess: false, networkScope: 'application routing guards; no OS packet capture',
    sourceTypes: sourceLabels, pendingCount, catchupPages: 5, savedLogs: Array.isArray(allLogs) ? allLogs.length : undefined,
    realApiRequests: client.requests.filter((r) => r.path.startsWith('/api/')).length,
    xRequests: h.events.filter((event) => event.type === 'x').length,
    aiRequests: h.events.filter((event) => event.type === 'ai').length,
    simulatedTelegramRequests: h.events.filter((event) => event.type === 'telegram').length,
    simulatedTelegramAccepted: h.accepted.length, clientErrors: 0, blockedUnexpectedRequests: 0,
    checks: ['four-source-types', 'unknown-not-healthy', 'empty-preview', 'no-fake-chart', 'cross-tab-drafts',
      'compact-source-summaries', 'new-source-opens', 'readable-minimum-12px', 'expand-collapse-preserves-draft', 'collapsed-invalid-field-navigation', 'hidden-invalid-field-navigation', 'client-http-url-rejection-focus', 'save-reload', 'secret-redaction', 'keyboard-tabs', 'modal-focus-trap',
      'escape-restores-focus', 'hi-busy-across-tabs', 'hi-local-tls-reply', 'hi-no-save', 'durable-pending-count',
      'catchup-without-fake-percentage', 'actual-429-cooldown', 'activity-filters', 'light-dark-1440-390-320',
      'five-settings-panels', 'mobile-all-categories', 'navigation-not-dirty', 'readable-error-summary-and-original', 'error-detail-expansion-preserved', 'activity-original-and-expansion-preserved', 'activity-keyboard-focus-survives-new-sse-log', 'visible-save-footer', 'pause', 'csrf', 'unauthenticated-401', 'logout'] };
  fs.writeFileSync(path.join(artifacts, 'summary.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}

(process.env.UI_POLISH_FOCUS_ONLY === '1' ? focusOnly() : main()).catch(async (error) => {
  if (page) await capture('failure').catch(() => {});
  console.error(JSON.stringify({ ok: false, error: error.message,
    location: error.stack?.split('\n').filter((line) => line.includes('browser-redesign-smoke.cjs')).join('\n'), artifacts })); process.exitCode = 1;
}).finally(async () => {
  releaseAi?.();
  if (client) await client.browser.close().catch(() => {});
  if (h) { await h.close(); assert.equal(fs.existsSync(h.directory), false); }
});
