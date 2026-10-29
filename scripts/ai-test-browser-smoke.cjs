'use strict';
// Optional real-browser check for the explicit AI "hi" test. It uses an
// isolated, paused live instance with zero accounts and synthetic credentials.
// All outgoing server requests are mocked or rejected; browser traffic is
// restricted to that local instance. No production data or provider is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tweet-watcher-v2-ai-browser-'));
const dataDir = path.join(temporary, 'data');
const artifacts = path.resolve(process.env.BROWSER_SMOKE_ARTIFACTS
  || fs.mkdtempSync(path.join(os.tmpdir(), 'tweet-watcher-v2-ai-browser-artifacts-')));
fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const password = `Synthetic-${crypto.randomBytes(20).toString('hex')}`;
const apiBase = 'https://ai.synthetic.example.test/v1';
const savedKey = 'synthetic-ai-browser-saved-key';
const draftKey = 'synthetic-ai-browser-draft-key';
const reply = 'Hello! <img src=x onerror="window.__aiTestExecuted=true"> '
  + 'longword'.repeat(35);
const observed = [];
const forbidden = [];
let child;
let browser;
let setupToken;

// This function runs only in the isolated child process. Incoming loopback
// HTTP remains available, but every outgoing socket path is rejected.
function isolatedServer(options) {
  const { apiBase, savedKey, draftKey, reply } = options;
  const denied = () => {
    process.send({ forbidden: true });
    throw new Error('Outgoing network is disabled in the AI browser smoke');
  };
  for (const name of ['node:http', 'node:https']) {
    const transport = require(name);
    transport.request = denied;
    transport.get = denied;
  }
  const net = require('node:net');
  net.connect = net.createConnection = denied;
  net.Socket.prototype.connect = denied;
  require('node:tls').connect = denied;
  global.fetch = async (url, init) => {
    if (url !== apiBase + '/chat/completions') return denied();
    const body = JSON.parse(init.body);
    const expectedKey = body.model === 'saved-model' ? savedKey : draftKey;
    const valid = init.method === 'POST' && init.redirect === 'error'
      && new Headers(init.headers).get('authorization') === `Bearer ${expectedKey}`
      && JSON.stringify(body.messages) === JSON.stringify([{ role: 'user', content: 'hi' }])
      && body.stream === false && Number.isSafeInteger(body.max_completion_tokens)
      && body.max_completion_tokens > 0 && body.max_completion_tokens <= 512;
    process.send({ mockRequest: true, model: body.model, valid });
    if (!valid) throw new Error('Synthetic AI request did not match the expected protocol');
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (body.model === 'auth-failure') {
      return new Response(JSON.stringify({ error: { message: `Do not expose ${draftKey}` } }),
        { status: 401, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
      message: { role: 'assistant', content: reply } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const config = require('./lib/config');
  config.saveSettings({ tg_chat_id: '', paused: true, accounts: [],
    ai_translation_enabled: false, ai_base_url: apiBase, ai_model: 'saved-model' },
  { auth_token: '', ct0: '', tg_bot_token: '', ai_api_key: savedKey });
  const server = require('./server').startServer(0, '127.0.0.1');
  server.once('listening', () => {
    process.stdout.write(JSON.stringify({ smokePort: server.address().port }) + '\n');
  });
}

async function start() {
  return new Promise((resolve, reject) => {
    let port;
    let pending = '';
    const timer = setTimeout(() => reject(new Error('isolated server startup timed out')), 15000);
    child = spawn(process.execPath, ['-e', `(${isolatedServer.toString()})(${JSON.stringify({
      apiBase, savedKey, draftKey, reply,
    })});`], { cwd: root, env: { ...process.env, DATA_DIR: dataDir,
      TW_RUNTIME_MODE: 'live', PUBLIC_ORIGIN: '', TRUST_PROXY_TOKEN: '', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.on('message', (message) => {
      if (message.mockRequest) observed.push({ model: message.model, valid: message.valid });
      if (message.forbidden) forbidden.push('server outgoing request');
    });
    child.stdout.on('data', (chunk) => {
      pending = (pending + chunk.toString()).slice(-16384);
      setupToken ||= pending.match(/首次设置令牌[^\n]*?([a-f0-9]{48})/)?.[1];
      port ||= Number(pending.match(/"smokePort":(\d+)/)?.[1]);
      if (setupToken && port) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${port}`);
      }
    });
    // Startup diagnostics may contain the synthetic setup nonce: never print.
    child.stderr.on('data', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('isolated server failed to start')); });
    child.on('exit', () => {
      clearTimeout(timer);
      if (!port || !setupToken) reject(new Error('isolated server exited during startup'));
    });
  });
}

function persistedSettings() {
  return ['config.json', 'secrets.json'].map((name) => ({ name,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(dataDir, name))).digest('hex'),
  }));
}

async function main() {
  const base = await start();
  assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700, 'temporary data directory must be private');
  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const errors = [];
  const mutations = [];
  await context.route('**/*', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base) { forbidden.push('browser external request'); return route.abort(); }
    if (request.method() !== 'GET') mutations.push(url.pathname);
    if (url.pathname.startsWith('/api/test/') && url.pathname !== '/api/test/ai') {
      forbidden.push('unrelated test endpoint');
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', () => errors.push('browser script error'));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-token-wrap').waitFor({ state: 'visible' });
  await page.locator('#auth-pw').fill(password);
  await page.locator('#auth-pw2').fill(password);
  await page.locator('#auth-setup-token').fill(setupToken);
  await page.locator('#auth-submit').click();
  await page.locator('#dash').waitFor({ state: 'visible' });
  const before = persistedSettings();
  await page.locator('#btn-settings').click();
  await page.locator('.drawer').evaluate(async (drawer) => {
    await Promise.all(drawer.getAnimations().map((animation) => animation.finished));
  });
  const button = page.locator('#btn-test-ai');
  const result = page.locator('#ai-test-result');
  assert.equal(await page.locator('#ai_translation_enabled').isChecked(), false);
  assert.equal(await button.isEnabled(), true, 'AI test must work with automatic translation disabled');
  assert.equal(await page.locator('#ai_api_key').inputValue(), '');
  assert.equal(await page.locator('#ai_api_key').getAttribute('type'), 'password');

  async function clickTest() {
    const response = page.waitForResponse((item) => new URL(item.url()).pathname === '/api/test/ai');
    await button.click();
    await page.waitForFunction(() => document.querySelector('#btn-test-ai').disabled);
    assert.equal(await result.getAttribute('aria-busy'), 'true');
    const body = await (await response).json();
    await page.waitForFunction(() => !document.querySelector('#btn-test-ai').disabled);
    return body;
  }

  const savedResult = await clickTest();
  assert.equal(savedResult.ok, true, 'blank draft key should use saved key at its saved destination');
  assert.equal(savedResult.reply, reply);
  assert.deepEqual(persistedSettings(), before, 'testing a saved connection must not write settings');

  await page.locator('#ai_model').fill('draft-model');
  assert.equal(await result.isVisible(), false, 'editing AI settings should clear a stale reply');
  await page.locator('#ai_api_key').fill(draftKey);
  await page.locator('#btn-add-acct').click();
  await page.locator('[data-role=name]').fill('draft_only');
  const draftResult = await clickTest();
  assert.equal(draftResult.ok, true);
  assert.equal(draftResult.reply, reply);
  assert.ok(Number.isFinite(draftResult.elapsedMs) && draftResult.elapsedMs >= 0);
  assert.ok((await result.textContent()).includes(reply), 'reply should be displayed literally');
  assert.equal(await result.locator('img,script,iframe').count(), 0, 'provider content must never become HTML');
  assert.equal(await page.evaluate(() => window.__aiTestExecuted), undefined);
  assert.ok(await page.locator('#ai_api_key').inputValue() === draftKey, 'successful test must preserve draft key');
  assert.equal(await page.locator('#ai_model').inputValue(), 'draft-model');
  assert.equal(await page.locator('[data-role=name]').inputValue(), 'draft_only');
  assert.equal(await page.locator('#ai_translation_enabled').isChecked(), false);
  assert.deepEqual(persistedSettings(), before, 'draft test must not save settings or secrets');

  // Remove the synthetic setup nonce from log text before exporting images.
  await page.evaluate((nonce) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.includes(nonce)) node.textContent = node.textContent.replaceAll(nonce, '[synthetic nonce omitted]');
    }
  }, setupToken);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    await page.setViewportSize(viewport);
    await result.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => {
      const drawer = document.querySelector('.drawer');
      return drawer.scrollWidth <= drawer.clientWidth && document.documentElement.scrollWidth <= innerWidth;
    }), true, `AI settings overflow at ${viewport.width}px`);
    await page.screenshot({ path: path.join(artifacts, `ai-test-${viewport.width}.png`),
      fullPage: false, animations: 'disabled' });
  }

  await page.locator('#ai_model').fill('auth-failure');
  const failedResult = await clickTest();
  assert.equal(failedResult.ok, false);
  assert.match(await result.textContent(), /认证失败|API Key/);
  assert.ok(!(await result.textContent()).includes(draftKey), 'provider errors must not expose a key');
  assert.ok(await page.locator('#ai_api_key').inputValue() === draftKey, 'failed test must preserve draft key');
  assert.equal(await page.locator('#ai_model').inputValue(), 'auth-failure');
  assert.equal(await page.locator('[data-role=name]').inputValue(), 'draft_only');
  assert.equal(await page.locator('#ai_translation_enabled').isChecked(), false);
  assert.deepEqual(persistedSettings(), before, 'failed test must not save settings or secrets');
  assert.equal(mutations.includes('/api/config'), false, 'AI tests must never autosave the form');
  assert.deepEqual(observed, [{ model: 'saved-model', valid: true },
    { model: 'draft-model', valid: true }, { model: 'auth-failure', valid: true }]);
  assert.deepEqual(forbidden, []);
  assert.deepEqual(errors, []);
  await context.close();
  console.log(JSON.stringify({ ok: true, mockedAiRequests: observed.length,
    externalRequests: forbidden.length, clientErrors: errors.length,
    desktop: '1440x1000', mobile: ['390x844', '320x740'],
    checks: ['fixed-hi-message', 'saved-key-reuse', 'translation-disabled-test', 'draft-key-success',
      'no-autosave', 'literal-html-reply', 'safe-auth-error', 'draft-preserved', 'responsive-layout'], artifacts }));
}

main().catch((error) => {
  let message = error.message;
  for (const sensitive of [password, setupToken, savedKey, draftKey].filter(Boolean)) {
    message = message.replaceAll(sensitive, '[synthetic credential omitted]');
  }
  console.error(`AI browser smoke failed: ${message}`);
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close().catch(() => {});
  if (child && child.exitCode === null) {
    await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGKILL'); });
  }
  fs.rmSync(temporary, { recursive: true, force: true });
});
