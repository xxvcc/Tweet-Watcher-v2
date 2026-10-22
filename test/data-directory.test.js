'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveDataDirectory } = require('../lib/data-directory');
const root = path.resolve(__dirname, '..');

test('data directory defaults to this project and accepts an isolated explicit location', () => {
  assert.equal(resolveDataDirectory('data'), path.join(root, 'data'));
  assert.equal(resolveDataDirectory('/var/lib/tweet-watcher-v2'), '/var/lib/tweet-watcher-v2');
  for (const invalid of ['', ' ', 'bad\0path']) assert.throws(() => resolveDataDirectory(invalid), /DATA_DIR/);
});

test('production roots, normalized paths, symlinks and dangling aliases are rejected before access', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweet-watcher-v2-path-'));
  try {
    const alias = path.join(dir, 'production-alias');
    const missingAlias = path.join(dir, 'production-missing');
    fs.symlinkSync('/www/tweet-watcher', alias);
    fs.symlinkSync('/www/tweet-watcher/synthetic-missing-directory', missingAlias);
    for (const forbidden of ['/www/tweet-watcher', '/www/tweet-watcher/data',
      '/www/tweet-watcher-v2/../tweet-watcher/data', path.join(alias, 'data'),
      path.join(alias, 'data/new-directory'), path.join(missingAlias, 'data')]) {
      assert.throws(() => resolveDataDirectory(forbidden), /旧版生产/);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('public roots, normalized paths and symlink aliases cannot expose data through static serving', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweet-watcher-v2-public-'));
  const publicRoot = path.join(root, 'public');
  try {
    const alias = path.join(dir, 'public-alias');
    const missingAlias = path.join(dir, 'public-missing');
    fs.symlinkSync(publicRoot, alias);
    fs.symlinkSync(path.join(publicRoot, 'synthetic-missing-directory'), missingAlias);
    for (const forbidden of ['public', 'data/../public', publicRoot,
      path.join(publicRoot, 'data'), alias, path.join(alias, 'new-directory'), missingAlias]) {
      assert.throws(() => resolveDataDirectory(forbidden), /公开静态目录/);
    }
    // A name sharing the prefix is outside the served tree.
    assert.equal(resolveDataDirectory('public-private'), path.join(root, 'public-private'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a symlinked public root and outward public child links retain the static boundary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweet-watcher-v2-static-root-'));
  try {
    const fixtureRoot = path.join(dir, 'project');
    const staticRoot = path.join(dir, 'served-assets');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(path.join(fixtureRoot, 'lib'), { recursive: true });
    fs.mkdirSync(staticRoot);
    fs.mkdirSync(outside);
    fs.copyFileSync(path.join(root, 'lib/data-directory.js'), path.join(fixtureRoot, 'lib/data-directory.js'));
    fs.symlinkSync(staticRoot, path.join(fixtureRoot, 'public'));
    fs.symlinkSync(outside, path.join(staticRoot, 'outward-link'));
    const resolveFixture = require(path.join(fixtureRoot, 'lib/data-directory.js')).resolveDataDirectory;
    for (const forbidden of [staticRoot, path.join(staticRoot, 'data'), 'public/outward-link/data']) {
      assert.throws(() => resolveFixture(forbidden), /公开静态目录/);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('storage writes only to DATA_DIR and detects replacement by production or public symlinks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweet-watcher-v2-store-'));
  const data = path.join(dir, 'isolated');
  try {
    const child = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const store = require('./lib/store');
      store.writeJSON('synthetic.json', { synthetic: true });
      assert.equal(store.readState('synthetic.json').value.synthetic, true);
      assert.throws(() => store.writeJSON('../outside.json', {}), /数据文件名/);
      fs.renameSync(process.env.DATA_DIR, process.env.DATA_DIR + '-original');
      fs.symlinkSync('/www/tweet-watcher/data', process.env.DATA_DIR);
      assert.throws(() => store.readState('synthetic.json'), /旧版生产/);
      assert.throws(() => store.writeJSON('synthetic.json', {}), /旧版生产/);
      assert.throws(() => store.sweepTmp(), /旧版生产/);
      fs.unlinkSync(process.env.DATA_DIR);
      fs.symlinkSync(require('node:path').resolve('public'), process.env.DATA_DIR);
      assert.throws(() => store.readState('synthetic.json'), /公开静态目录/);
      assert.throws(() => store.writeJSON('synthetic.json', {}), /公开静态目录/);
      assert.throws(() => store.sweepTmp(), /公开静态目录/);
    `], { cwd: root, env: { ...process.env, DATA_DIR: data }, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(fs.existsSync(path.join(data + '-original', 'synthetic.json')), true);
    assert.equal(fs.existsSync(path.join(dir, 'outside.json')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
