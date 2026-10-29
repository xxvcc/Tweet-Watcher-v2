'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const express = require('express');
const { publicAssets } = require('../lib/public-assets');

async function serve(t, directory) {
  const app = express();
  app.use(publicAssets(directory));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const assetUrls = (html) => [...html.matchAll(/(?:src|href)="((?:app.js|style.css)\?v=[a-f0-9]{64})"/g)]
  .map((match) => match[1]).sort();

test('both public HTML entrypoints and HEAD expose content-hashed assets with explicit cache policy', async (t) => {
  const directory = path.join(__dirname, '../public');
  const base = await serve(t, directory);
  const expected = ['app.js', 'style.css'].map((file) => `${file}?v=${hash(fs.readFileSync(path.join(directory, file)))}`).sort();
  for (const entry of ['/', '/index.html', '/%69ndex.html']) {
    const response = await fetch(base + entry);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-type'), /^text\/html/);
    const html = await response.text();
    assert.deepEqual(assetUrls(html), expected);
    assert.doesNotMatch(html, /__(?:APP_JS|STYLE_CSS)_VERSION__/);
    const head = await fetch(base + entry, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('cache-control'), 'no-store');
    assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(html));
    assert.equal(await head.text(), '');
  }
  for (const asset of expected) {
    const response = await fetch(`${base}/${asset}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), asset.split('=')[1]);
    const revalidated = await fetch(`${base}/${asset}`, { headers: {
      'if-none-match': response.headers.get('etag'), 'cache-control': 'max-age=0',
    } });
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.headers.get('cache-control'), 'no-cache');
    const head = await fetch(`${base}/${asset}`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('cache-control'), 'no-cache');
    assert.equal(await head.text(), '');
  }
  assert.equal((await fetch(base + '/unknown')).status, 404);
  assert.equal((await fetch(base + '/', { method: 'POST' })).status, 404);
});

test('loading changed asset bytes creates fresh URLs without changing package metadata', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-public-assets-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'index.html'), '<link href="style.css?v=__STYLE_CSS_VERSION__"><script src="app.js?v=__APP_JS_VERSION__"></script>');
  fs.writeFileSync(path.join(directory, 'app.js'), 'window.testVersion = 1;');
  fs.writeFileSync(path.join(directory, 'style.css'), 'body { color: black; }');
  const first = await serve(t, directory);
  const oldUrls = assetUrls(await (await fetch(first)).text());
  fs.writeFileSync(path.join(directory, 'app.js'), 'window.testVersion = 2;');
  fs.writeFileSync(path.join(directory, 'style.css'), 'body { color: white; }');
  const second = await serve(t, directory);
  const newUrls = assetUrls(await (await fetch(second)).text());
  assert.equal(oldUrls.length, 2);
  assert.equal(newUrls.length, 2);
  for (let index = 0; index < oldUrls.length; index++) {
    assert.notEqual(newUrls[index], oldUrls[index]);
    const response = await fetch(`${second}/${newUrls[index]}`);
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), newUrls[index].split('=')[1]);
  }
});

test('missing or repeated asset references fail startup rather than serve an unversioned shell', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-public-template-'));
  try {
    fs.writeFileSync(path.join(directory, 'app.js'), '');
    fs.writeFileSync(path.join(directory, 'style.css'), '');
    for (const html of ['', '<script src="app.js?v=__APP_JS_VERSION__"></script>'.repeat(2)]) {
      fs.writeFileSync(path.join(directory, 'index.html'), html);
      assert.throws(() => publicAssets(directory), /资源版本占位符/);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
