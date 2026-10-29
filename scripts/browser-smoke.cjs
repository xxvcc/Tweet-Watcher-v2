'use strict';
// Optional real-browser smoke check. Supply PLAYWRIGHT_MODULE and CHROMIUM_PATH
// when Playwright and Chromium are installed outside this repository. It starts
// an isolated read-only server, uses only synthetic local credentials, and never
// calls collection or delivery endpoints. No production configuration is read.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { selectSettingsTab } = require('./simulation/browser.cjs');
const root = path.resolve(__dirname, '..');
const disableSse = process.env.BROWSER_SMOKE_DISABLE_SSE === '1';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tweet-watcher-v2-browser-'));
const artifacts = path.resolve(process.env.BROWSER_SMOKE_ARTIFACTS
  || fs.mkdtempSync(path.join(os.tmpdir(), 'tweet-watcher-v2-browser-artifacts-')));
fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const password = `Synthetic-${crypto.randomBytes(20).toString('hex')}`;
let child;
let browser;

async function start() {
  return new Promise((resolve, reject) => {
    let token;
    let port;
    let pending = '';
    const timer = setTimeout(() => reject(new Error('isolated server startup timed out')), 15000);
    child = spawn(process.execPath, ['-e', `
      const server = require('./server').startServer(0, '127.0.0.1');
      server.once('listening', () => process.stdout.write(JSON.stringify({ smokePort: server.address().port }) + '\\n'));
    `], { cwd: root, env: { ...process.env, DATA_DIR: path.join(temporary, 'data'),
      TW_RUNTIME_MODE: 'read-only', PUBLIC_ORIGIN: '', TRUST_PROXY_TOKEN: '', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => {
      pending = (pending + chunk.toString()).slice(-16384);
      token ||= pending.match(/首次设置令牌[^\n]*?([a-f0-9]{48})/)?.[1];
      port ||= Number(pending.match(/"smokePort":(\d+)/)?.[1]);
      if (token && port) { clearTimeout(timer); resolve({ token, base: `http://127.0.0.1:${port}` }); }
    });
    // Startup diagnostics may contain the temporary setup token: do not print.
    child.stderr.on('data', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('isolated server failed to start')); });
    child.on('exit', () => { clearTimeout(timer); if (!port || !token) reject(new Error('isolated server exited during startup')); });
  });
}

async function main() {
  const { token, base } = await start();
  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const requests = [];
  const forbidden = [];
  const errors = [];
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (!url.startsWith(`${base}/`)) { forbidden.push(new URL(url).origin); return route.abort(); }
    const pathname = new URL(url).pathname;
    requests.push(pathname);
    if (pathname.startsWith('/api/test/')) { forbidden.push(pathname); return route.abort(); }
    if (disableSse && pathname === '/api/stream') return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => { if (response.status() >= 500) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`); });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-token-wrap').waitFor({ state: 'visible' });
  await page.locator('#auth-pw').fill(password);
  await page.locator('#auth-pw2').fill(password);
  await page.locator('#auth-setup-token').fill(token);
  await page.locator('#auth-submit').click();
  await page.locator('#dash').waitFor({ state: 'visible' });
  if (disableSse) {
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/status') && response.status() === 200
        && requests.filter((url) => url === '/api/status').length >= 2, { timeout: 15000 }),
      page.waitForResponse((response) => response.url().endsWith('/api/logs') && response.status() === 200
        && requests.filter((url) => url === '/api/logs').length >= 2, { timeout: 15000 }),
    ]);
    assert.ok(requests.filter((url) => url === '/api/status').length >= 2, 'status polling continues without SSE');
    assert.ok(requests.filter((url) => url === '/api/logs').length >= 2, 'log polling continues without SSE');
  }
  assert.match(await page.locator('#runtime-notice').textContent(), /只读验证/);
  assert.equal(await page.locator('#btn-test-tg').isDisabled(), true);
  // The now-expired synthetic setup nonce is an internal log entry; omit it
  // from exported screenshots while retaining all functional UI assertions.
  async function omitSetupNonce() {
    await page.evaluate((nonce) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.textContent.includes(nonce)) node.textContent = node.textContent.replaceAll(nonce, '[synthetic nonce omitted]');
      }
    }, token);
  }
  async function openSettledSettings() {
    await page.locator('#btn-settings').click();
    await page.locator('.drawer').evaluate(async (drawer) => {
      // Visibility alone does not mean the slide-in transform/opacity reached
      // its final state. Wait before both layout assertions and screenshots.
      await Promise.all(drawer.getAnimations().map((animation) => animation.finished));
    });
  }
  await omitSetupNonce();
  await page.screenshot({ path: path.join(artifacts, 'desktop-panel.png'), fullPage: true, animations: 'disabled' });

  await openSettledSettings();
  await selectSettingsTab(page, 'security');
  assert.equal(await page.locator('#collector-name').textContent(), 'twscrape');
  assert.equal(await page.locator('#btn-test-collector').isEnabled(), true);
  await selectSettingsTab(page, 'sources');
  await page.locator('#btn-add-acct').click();
  await page.locator('[data-role=name]').fill('synthetic_demo');
  await page.locator('[data-role=fc]').fill('20');
  await page.locator('[data-role=iv]').fill('300');
  await selectSettingsTab(page, 'delivery');
  assert.equal(await page.locator('#ai_translation_enabled').isChecked(), false);
  await page.locator('#ai_translation_enabled').check();
  await page.locator('#ai_base_url').fill('https://synthetic.example.test/v1');
  await page.locator('#ai_model').fill('synthetic-model');
  await page.locator('#ai_api_key').fill('synthetic-browser-key');
  assert.equal(await page.locator('#ai_api_key').getAttribute('type'), 'password');
  await page.locator('#btn-save').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('配置已保存'));
  assert.equal(await page.locator('#ai_api_key').inputValue(), '');
  assert.equal(await page.locator('#ai_api_key').getAttribute('placeholder'), '••••••••••••');
  assert.equal(await page.locator('#ai_translation_enabled').isChecked(), true);
  assert.equal(await page.locator('#ai_model').inputValue(), 'synthetic-model');
  const aiSettings = await page.evaluate(async () => (await fetch('api/config')).json());
  assert.equal(aiSettings.secrets.hasAiApiKey, true);
  assert.equal(JSON.stringify(aiSettings).includes('synthetic-browser-key'), false);
  await selectSettingsTab(page, 'security');
  const detection = page.waitForResponse((response) => response.url().endsWith('/api/detect-collector'));
  await page.locator('#btn-detect-collector').click();
  assert.equal((await detection).status(), 200);
  await page.waitForFunction(() => !document.querySelector('#btn-detect-collector').disabled);
  await page.locator('#toast').waitFor({ state: 'hidden', timeout: 10000 });
  await omitSetupNonce();
  await page.screenshot({ path: path.join(artifacts, 'desktop-settings.png'), fullPage: true, animations: 'disabled' });
  await page.locator('#settings-close').click();
  assert.equal(await page.locator('#stat-accounts').textContent(), '1');

  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 740 }]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
      `panel overflows ${viewport.width}px viewport`);
    await page.screenshot({ path: path.join(artifacts, `mobile-${viewport.width}-panel.png`), fullPage: true, animations: 'disabled' });
    await openSettledSettings();
    await selectSettingsTab(page, 'sources');
    assert.equal(await page.evaluate(() => {
      const drawer = document.querySelector('.drawer');
      return drawer.scrollWidth <= drawer.clientWidth && document.documentElement.scrollWidth <= innerWidth;
    }), true, `settings overflow ${viewport.width}px viewport`);
    await page.screenshot({ path: path.join(artifacts, `mobile-${viewport.width}-settings.png`), fullPage: false, animations: 'disabled' });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#settings').isVisible(), false);
  }
  await page.locator('#logout').click();
  await page.locator('#auth').waitFor({ state: 'visible' });
  await page.locator('#auth-pw').fill(password);
  await page.locator('#auth-submit').click();
  await page.locator('#dash').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#stat-accounts').textContent(), '1');
  assert.equal(await page.locator('#ai_translation_enabled').isChecked(), true);
  assert.equal(await page.locator('#ai_model').inputValue(), 'synthetic-model');
  assert.equal(await page.locator('#ai_api_key').inputValue(), '');
  assert.deepEqual(errors, []);
  assert.deepEqual(forbidden, []);
  assert.equal(requests.some((url) => url.startsWith('/api/test/')), false);
  console.log(JSON.stringify({ ok: true, desktop: '1440x1000', mobile: ['390x844', '320x740'],
    streamMode: disableSse ? 'http-polling' : 'sse',
    checks: ['setup', 'login', 'logout', 'config-save', 'ai-settings-save-reload', 'ai-key-redaction', 'collector-detection', 'read-only-policy', 'responsive-layout'],
    clientErrors: errors.length, externalRequests: forbidden.length, artifacts }));
}

main().catch((error) => { console.error(`Browser smoke failed: ${error.message}`); process.exitCode = 1; })
  .finally(async () => {
    if (browser) await browser.close().catch(() => {});
    if (child && child.exitCode === null) {
      await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGKILL'); });
    }
    // Remove the temporary password/session state; screenshots live separately.
    fs.rmSync(temporary, { recursive: true, force: true });
  });
