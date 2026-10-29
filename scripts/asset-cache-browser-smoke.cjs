'use strict';
// Reproduce a deployment with a real warm Chromium HTTP cache, then verify
// content-hashed assets repair it without clearing that cache. Set
// ASSET_CACHE_PREVIOUS_RELEASE to an earlier source release without the AI
// test button. Only its public source files are read; all state is synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(__dirname, '..');
const previous = process.env.ASSET_CACHE_PREVIOUS_RELEASE;
if (!previous) throw new Error('Set ASSET_CACHE_PREVIOUS_RELEASE to the previous source release');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tweet-watcher-v2-asset-cache-'));
let child;
let browser;
let phaseResolve;
const assets = [];
const forbidden = [];

async function isolatedServer(options) {
  const fs = require('node:fs');
  const path = require('node:path');
  const http = require('node:http');
  const deny = () => { process.send({ forbidden: true }); throw new Error('Outgoing network denied'); };
  global.fetch = deny;
  for (const name of ['node:http', 'node:https']) {
    const transport = require(name);
    transport.request = transport.get = deny;
  }
  const net = require('node:net');
  net.connect = net.createConnection = net.Socket.prototype.connect = deny;
  require('node:tls').connect = deny;
  const cfg = require('./lib/config');
  cfg.saveSettings({ tg_chat_id: '', paused: true, accounts: [], ai_translation_enabled: false,
    ai_base_url: 'https://synthetic.example.test/v1', ai_model: '' },
  { auth_token: '', ct0: '', tg_bot_token: '', ai_api_key: '' });
  const auth = require('./lib/auth');
  await auth.setPassword('Synthetic-cache-check-only');
  const { app } = require('./server');
  const oldPublic = path.join(options.previous, 'public');
  const oldHtml = fs.readFileSync(path.join(oldPublic, 'index.html'), 'utf8');
  const oldJsRef = oldHtml.match(/src="(app\.js\?v=[^"]+)"/)[1];
  const oldCssRef = oldHtml.match(/href="(style\.css\?v=[^"]+)"/)[1];
  const mixedHtml = fs.readFileSync('./public/index.html', 'utf8')
    .replace(/app\.js\?v=[^"]+/, oldJsRef)
    .replace(/style\.css\?v=[^"]+/, oldCssRef);
  let phase = 'old';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      process.send({ forbidden: true });
      res.writeHead(405).end();
      return;
    }
    if (url.pathname === '/app.js' || url.pathname === '/style.css') {
      process.send({ asset: true, phase, pathname: url.pathname, query: url.search });
    }
    if (phase !== 'fixed' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(phase === 'old' ? oldHtml : mixedHtml);
      return;
    }
    if (phase !== 'fixed' && (url.pathname === '/app.js' || url.pathname === '/style.css')) {
      const asset = path.join(phase === 'old' ? oldPublic : path.join(process.cwd(), 'public'), url.pathname.slice(1));
      res.writeHead(200, { 'content-type': url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css',
        'cache-control': 'public, max-age=14400' });
      res.end(fs.readFileSync(asset));
      return;
    }
    app(req, res);
  });
  server.listen(0, '127.0.0.1', () => {
    process.send({ ready: true, port: server.address().port,
      session: auth.makeSession(''), csrf: auth.makeCsrf() });
  });
  process.on('message', (message) => {
    if (['mixed', 'fixed'].includes(message.phase)) {
      phase = message.phase;
      process.send({ phase });
    }
  });
}

async function start() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('isolated cache server startup timed out')), 15000);
    child = spawn(process.execPath, ['-e', `(${isolatedServer.toString()})(${JSON.stringify({ previous })})
      .catch(() => process.exit(1));`], { cwd: root,
    env: { ...process.env, DATA_DIR: path.join(temporary, 'data'), TW_RUNTIME_MODE: 'live',
      PUBLIC_ORIGIN: '', TRUST_PROXY_TOKEN: '', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    child.on('message', (message) => {
      if (message.ready) { clearTimeout(timer); resolve(message); }
      if (message.asset) assets.push({ phase: message.phase, pathname: message.pathname, query: message.query });
      if (message.forbidden) forbidden.push('server network or mutation request');
      if (message.phase && !message.asset && phaseResolve) { phaseResolve(); phaseResolve = null; }
    });
    child.on('error', () => { clearTimeout(timer); reject(new Error('isolated cache server startup failed')); });
    child.on('exit', () => { clearTimeout(timer); reject(new Error('isolated cache server exited')); });
  });
}

async function setPhase(phase) {
  await new Promise((resolve) => { phaseResolve = resolve; child.send({ phase }); });
}

async function main() {
  const ready = await start();
  const base = `http://127.0.0.1:${ready.port}`;
  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([
    { name: 'tw_sess', value: ready.session, url: base, httpOnly: true, sameSite: 'Lax' },
    { name: 'tw_csrf', value: ready.csrf, url: base, httpOnly: false, sameSite: 'Lax' },
  ]);
  // Playwright routing disables Chromium's HTTP cache. Keep routing OFF and
  // enforce the read-only same-origin browser boundary in its fetch function.
  await context.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.__deniedRequests = 0;
    window.fetch = (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const method = String(init.method || (typeof input === 'object' ? input.method : 'GET') || 'GET').toUpperCase();
      if (url.origin !== location.origin || method !== 'GET') {
        window.__deniedRequests++;
        return Promise.reject(new Error('Browser cache smoke permits only same-origin reads'));
      }
      return original(input, init);
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', () => errors.push('browser script error'));
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== base) forbidden.push('browser external request');
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const cachedRequests = new Set();
  cdp.on('Network.requestServedFromCache', (event) => cachedRequests.add(event.requestId));

  await page.goto(base + '/?phase=old', { waitUntil: 'domcontentloaded' });
  await page.locator('#dash').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#btn-test-ai').count(), 0, 'previous source must precede the AI test button');
  assert.equal(assets.filter((asset) => asset.phase === 'old' && asset.pathname === '/app.js').length, 1);

  await setPhase('mixed');
  await page.goto(base + '/?phase=mixed', { waitUntil: 'domcontentloaded' });
  await page.locator('#dash').waitFor({ state: 'visible' });
  await page.locator('#btn-settings').click();
  const button = page.locator('#btn-test-ai');
  await button.waitFor({ state: 'visible' });
  assert.equal(await button.evaluate((element) => element.onclick), null,
    'warm old script should leave the newly rendered button without a handler');
  await button.click();
  assert.equal(await page.locator('#ai-test-result').isVisible(), false);
  assert.equal(await page.evaluate(() => window.__deniedRequests), 0);
  assert.equal(assets.some((asset) => asset.phase === 'mixed' && asset.pathname === '/app.js'), false,
    'Chromium must reuse the actual warm HTTP cache without fetching app.js');
  assert.ok(cachedRequests.size > 0, 'Chromium should report warm-cache responses');

  await setPhase('fixed');
  const fixedResponse = await page.goto(base + '/?phase=fixed', { waitUntil: 'domcontentloaded' });
  assert.equal(fixedResponse.headers()['cache-control'], 'no-store');
  await page.locator('#dash').waitFor({ state: 'visible' });
  await page.locator('#btn-settings').click();
  await button.waitFor({ state: 'visible' });
  assert.equal(await button.evaluate((element) => typeof element.onclick), 'function');
  assert.equal(await button.isEnabled(), true);
  await button.click();
  await page.waitForFunction(() => document.querySelector('#ai-test-result').textContent.includes('请先填写模型名称'));
  assert.equal(await page.evaluate(() => window.__deniedRequests), 0);
  const newScript = assets.find((asset) => asset.phase === 'fixed' && asset.pathname === '/app.js');
  const newStyle = assets.find((asset) => asset.phase === 'fixed' && asset.pathname === '/style.css');
  assert.match(newScript?.query || '', /^\?v=[a-f0-9]{64}$/);
  assert.match(newStyle?.query || '', /^\?v=[a-f0-9]{64}$/);
  assert.deepEqual(errors, []);
  assert.deepEqual(forbidden, []);
  await context.close();
  console.log(JSON.stringify({ ok: true, mixedCacheReproduced: true, repairedWithoutClearingCache: true,
    cachedResponses: cachedRequests.size, clientErrors: errors.length, externalRequests: forbidden.length,
    checks: ['actual-old-assets-cached', 'new-html-old-script-inert-button', 'zero-mutation-requests',
      'content-hash-fetches-new-assets', 'new-handler-local-validation', 'no-store-html'] }));
}

main().catch((error) => {
  console.error(`Asset cache browser smoke failed: ${error.message}`);
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close().catch(() => {});
  if (child && child.exitCode === null) {
    await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGKILL'); });
  }
  fs.rmSync(temporary, { recursive: true, force: true });
});
