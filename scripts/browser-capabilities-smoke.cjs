'use strict';
// Fully intercepted browser fixture: no application process, credentials or upstream requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { sourceKey } = require('../lib/collector-source');
const cfgmod = require('../lib/config');
const { revealSettingsControl, selectSettingsTab } = require('./simulation/browser.cjs');
const root = path.resolve(__dirname, '..');
const origin = 'http://tweet-watcher.synthetic.test';
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'tweet-watcher-capabilities-browser-'));
let browser;

async function main() {
  let revision = 10;
  const runtime = { mode: 'read-only', collectionEnabled: true, deliveryEnabled: false, translationEnabled: false, collector: 'twscrape' };
  let config = { configRevision: revision, tg_chat_id: '', accounts: [{ username: 'alice', fetch_count: 10, check_interval: 300, source_key: 'alice' }],
    x_sessions: [], media_mode: 'links', enrichment_mode: 'off', enrichment_limit: 2,
    ai_translation_enabled: false, ai_base_url: 'https://api.openai.com/v1', ai_model: '', runtime,
    secrets: { hasAuthToken: true, hasCt0: true, hasTgBotToken: false, hasAiApiKey: false, x_sessions: {} } };
  const calls = [], blocked = [], errors = [], confirmations = [];
  const pendingCounts = { alice: 3 }; let confirmedRemovals = 0;
  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { blocked.push(url.origin); return route.abort(); }
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (['index.html', 'app.js', 'style.css'].includes(filename)) return route.fulfill({ status: 200,
      contentType: filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html',
      body: fs.readFileSync(path.join(root, 'public', filename), 'utf8') });
    calls.push(url.pathname);
    if (url.pathname === '/api/session') return json({ hasPassword: true, authed: true });
    if (url.pathname === '/api/stream') return route.abort();
    if (url.pathname === '/api/config') {
      if (request.method() === 'POST') {
        const data = request.postDataJSON();
        if (data.config_revision !== revision || !cfgmod.validAccounts(data.accounts) || !cfgmod.validContentSettings(data)
          || !cfgmod.validSessionSecrets(data.x_session_secrets)) return json({ error: 'synthetic config invalid' }, 400);
        const nextKeys = new Set(cfgmod.normalizeAccounts(data.accounts).map(sourceKey));
        const removed = config.accounts.filter((a) => !nextKeys.has(a.source_key) && pendingCounts[a.source_key])
          .map((a) => ({ source_key: a.source_key, pendingCount: pendingCounts[a.source_key] }));
        if (removed.length && data.discard_removed_pending !== true) return json({ error: '队列需要确认',
          code: 'PENDING_REMOVAL_REQUIRES_CONFIRMATION', removed_pending: removed }, 409);
        if (removed.length) { confirmedRemovals++; removed.forEach((a) => { delete pendingCounts[a.source_key]; }); }
        revision++;
        config = { ...config, configRevision: revision,
          accounts: cfgmod.normalizeAccounts(data.accounts).map((a) => ({ ...a, source_key: sourceKey(a) })),
          x_sessions: cfgmod.normalizeSessions(data.x_sessions), media_mode: data.media_mode,
          enrichment_mode: data.enrichment_mode, enrichment_limit: data.enrichment_limit,
          secrets: { ...config.secrets, x_sessions: Object.fromEntries(data.x_sessions.map(({ id }) => [id, {
            hasAuthToken: !!data.x_session_secrets[id]?.auth_token || !!config.secrets.x_sessions[id]?.hasAuthToken,
            hasCt0: !!data.x_session_secrets[id]?.ct0 || !!config.secrets.x_sessions[id]?.hasCt0,
          }])) } };
        return json({ ok: true, warnings: [] });
      }
      return json(config);
    }
    if (url.pathname === '/api/logs') return json({ logs: [] });
    if (url.pathname === '/api/status') return json({ runtime, paused: true, status: { runtime, paused: true, configRevision: revision, accounts: {}, diagnostics: {
      pendingCounts,
      sessions: { default: { lastSuccessAt: Date.now(), status: 'ready' }, backup: { lastFailureAt: Date.now(), status: 'rate-limited', nextRetryAt: Date.now() + 60000 } },
      backfills: { alice: { status: 'collecting', pages: 3, posts: 60, updatedAt: Date.now() } },
    } } });
    if (url.pathname === '/api/detect-collector') return json({ found: true, version: 'synthetic', sourceCommit: 'synthetic' });
    if (url.pathname === '/api/list/members') return json({ ok: true, complete: false, members: [{ id: '1', username: 'alice' }, { id: '2', username: 'bob', name: '<b>Bob</b>' }] });
    if (url.pathname === '/api/inspect/tweet') return json({ ok: true, tweets: [{ id: '123', author_username: 'alice', text: 'Synthetic detail <img src=x onerror=alert(1)>',
      content: { quoted: { author_username: 'bob', text: 'Synthetic quote' }, article: { title: 'Synthetic article', previewText: 'Article preview' },
        media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/synthetic.jpg' }] } }] });
    if (url.pathname === '/api/test/session' || url.pathname === '/api/test/collector') return json({ ok: true, message: '合成请求成功' });
    if (url.pathname === '/api/catchup/reset') return json({ ok: true, message: '合成补采已重建，检查点与队列保留' });
    throw new Error('Unexpected local route: ' + url.pathname);
  });
  const page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.locator('#dash').waitFor({ state: 'visible' });
  await page.locator('#btn-settings').click();
  await page.locator('#btn-add-acct').click();
  const listRow = page.locator('.acct-row').nth(1);
  await listRow.locator('[data-role=type]').selectOption('list'); await listRow.locator('[data-role=name]').fill('42');
  await revealSettingsControl(page, listRow.locator('[data-role=include]')); await listRow.locator('[data-role=include]').fill('AI, 开发'); await listRow.locator('[data-role=reposts]').uncheck();
  await page.locator('#btn-add-acct').click();
  const searchRow = page.locator('.acct-row').nth(2);
  await searchRow.locator('[data-role=type]').selectOption('search'); await searchRow.locator('[data-role=name]').fill('AI lang:en');
  await revealSettingsControl(page, page.locator('#btn-add-session'));
  await page.locator('#btn-add-session').click();
  const session = page.locator('.session-row');
  await session.locator('[data-role=id]').fill('backup'); await session.locator('[data-role=label]').fill('备用登录');
  await session.locator('[data-role=auth_token]').fill('synthetic-auth'); await session.locator('[data-role=ct0]').fill('synthetic-csrf');
  await session.locator('[data-role=proxy]').fill('http://127.0.0.1:8080');
  await revealSettingsControl(page, page.locator('#media_mode'));
  await page.locator('#media_mode').selectOption('photos'); await page.locator('#enrichment_mode').selectOption('detail'); await page.locator('#enrichment_limit').fill('3');
  await page.locator('#btn-save').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('配置已保存'));
  assert.equal(config.accounts.length, 3); assert.equal(config.accounts[1].filters.reposts, false);
  assert.equal(config.media_mode, 'photos'); assert.equal(config.enrichment_limit, 3);
  assert.equal(await session.locator('[data-role=auth_token]').inputValue(), '');
  assert.match(await session.locator('[data-role=auth_token]').getAttribute('placeholder'), /已保存/);
  await revealSettingsControl(page, page.locator('#session-test-user'));
  await page.locator('#session-test-user').fill('alice'); await session.locator('[data-query]').click();
  await page.waitForFunction(() => document.querySelector('#x-test-result').textContent.includes('成功'));
  await selectSettingsTab(page, 'sources');
  await revealSettingsControl(page, page.locator('.acct-row').nth(2).locator('[data-query]').first());
  await page.locator('.acct-row').nth(2).locator('[data-query]').first().click();
  await page.waitForFunction(() => !document.querySelector('#btn-test-collector').disabled);
  await selectSettingsTab(page, 'sources');
  await revealSettingsControl(page, page.locator('.acct-row').nth(2).getByRole('button', { name: '重新开始补采', includeHidden: true }));
  await page.locator('.acct-row').nth(2).getByRole('button', { name: '重新开始补采' }).click();
  await page.waitForFunction(() => document.querySelector('#x-test-result').textContent.includes('合成补采已重建'));
  await revealSettingsControl(page, page.locator('#import-list-id'));
  await page.locator('#import-list-id').fill('42'); await page.locator('#btn-list-preview').click();
  await page.waitForFunction(() => document.querySelector('#list-preview').textContent.includes('部分结果'));
  await page.locator('#list-preview [data-role=member]').nth(1).check(); await page.locator('#btn-list-import').click();
  assert.equal(await page.locator('.acct-row').count(), 4); assert.equal(config.accounts.length, 3);
  await page.locator('#btn-save').click(); await page.waitForFunction(() => document.querySelector('#stat-accounts').textContent === '4');
  await revealSettingsControl(page, page.locator('#inspect-tweet-id'));
  await page.locator('#inspect-tweet-id').fill('123'); await page.locator('#btn-inspect-thread').click();
  await page.waitForFunction(() => document.querySelector('#inspect-result').textContent.includes('Synthetic detail'));
  assert.equal(await page.locator('#inspect-result img').count(), 0);
  assert.match(await page.locator('#inspect-result').textContent(), /Synthetic article/);
  assert.equal(await page.locator('#inspect-result .media-link').count(), 1);
  await selectSettingsTab(page, 'sources');
  await revealSettingsControl(page, page.locator('.acct-row').first().locator('[data-role=mode]'));
  await page.locator('.acct-row').first().locator('[data-role=mode]').selectOption('replies');
  page.once('dialog', async (dialog) => { confirmations.push(dialog.message()); await dialog.dismiss(); });
  await page.locator('#btn-save').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已取消保存'));
  assert.equal(config.accounts[0].timeline_mode, 'posts'); assert.equal(confirmedRemovals, 0);
  assert.equal(await page.locator('.acct-row').first().locator('[data-role=mode]').inputValue(), 'replies');
  page.once('dialog', async (dialog) => { confirmations.push(dialog.message()); await dialog.accept(); });
  await page.locator('#btn-save').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('配置已保存'));
  assert.equal(config.accounts[0].timeline_mode, 'replies'); assert.equal(confirmedRemovals, 1);
  assert.equal(confirmations.length, 2); confirmations.forEach((message) => assert.match(message, /@alice：3 条待发送消息/));
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    await page.setViewportSize(viewport);
    await selectSettingsTab(page, 'sources');
    assert.equal(await page.evaluate(() => { const drawer = document.querySelector('.drawer'); return drawer.scrollWidth <= drawer.clientWidth && document.documentElement.scrollWidth <= innerWidth; }), true);
    await page.locator('.drawer').evaluate((drawer) => { drawer.scrollTop = 0; });
    await page.locator('#toast').evaluate((toast) => toast.classList.add('hidden'));
    await page.screenshot({ path: path.join(artifacts, `sources-${viewport.width}.png`), animations: 'disabled' });
    await revealSettingsControl(page, page.locator('#session-list'));
    await page.locator('#session-list').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, `sessions-${viewport.width}.png`), animations: 'disabled' });
  }
  assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
  for (const route of ['/api/test/session', '/api/test/collector', '/api/list/members', '/api/inspect/tweet', '/api/catchup/reset']) assert.ok(calls.includes(route));
  console.log(JSON.stringify({ ok: true, network: 'all requests intercepted with synthetic fixtures',
    checks: ['source-save', 'filters', 'sessions', 'credential-clearing', 'content-policy', 'list-preview-import', 'session-test', 'source-test', 'catchup-reset', 'thread-inspection', 'quoted-article-media', 'pending-replacement-cancel-confirm', 'text-rendering', 'desktop-mobile-layout'],
    clientErrors: errors.length, externalRequests: blocked.length, artifacts }));
}
main().catch((error) => { console.error('Capability browser smoke failed: ' + error.message); process.exitCode = 1; })
  .finally(async () => { if (browser) await browser.close(); });
