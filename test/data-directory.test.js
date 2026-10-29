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

test('all state and evidence access rejects existing nonprivate directories without chmod', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweet-watcher-v2-private-'));
  try {
    const child = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const store = require('./lib/store');
      const auth = require('./lib/auth');
      const config = require('./lib/config');
      const { createEvidenceStore } = require('./lib/evidence');
      store.writeJSON('password.json', { hash: 'synthetic-password-record' });
      const evidence = createEvidenceStore();
      const before = fs.readFileSync(process.env.DATA_DIR + '/password.json');
      for (const mode of [0o755, 0o770, 0o777]) {
        fs.chmodSync(process.env.DATA_DIR, mode);
        for (const access of [
          () => auth.hasPassword(),
          () => config.getConfig(),
          () => config.getSecrets(),
          () => store.readState('password.json'),
          () => store.writeJSON('password.json', {}),
          () => store.removeJSON('password.json'),
          () => store.sweepTmp(),
          () => evidence.persist({ runId: '11111111-1111-1111-1111-111111111111',
            page: 0, username: 'alice', operation: 'user', data: {} }),
        ]) assert.throws(access, /私有目录/);
        assert.equal(fs.statSync(process.env.DATA_DIR).mode & 0o777, mode);
        assert.deepEqual(fs.readFileSync(process.env.DATA_DIR + '/password.json'), before);
        assert.deepEqual(fs.readdirSync(process.env.DATA_DIR), ['password.json']);
      }
      fs.chmodSync(process.env.DATA_DIR, 0o700);
      assert.equal(auth.hasPassword(), true);
      assert.equal(store.readState('password.json').status, 'ok');
    `], { cwd: root, env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a nonexistent isolated data directory is created privately without modifying its parent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweet-watcher-v2-create-private-'));
  const data = path.join(dir, 'new-data');
  try {
    const parentMode = fs.statSync(dir).mode & 0o777;
    const child = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const store = require('./lib/store');
      assert.equal(store.readState('synthetic.json').status, 'missing');
      assert.equal(fs.existsSync(process.env.DATA_DIR), false);
      store.writeJSON('synthetic.json', { synthetic: true });
      assert.equal(fs.statSync(process.env.DATA_DIR).mode & 0o777, 0o700);
      assert.equal(fs.statSync(process.env.DATA_DIR + '/synthetic.json').mode & 0o777, 0o600);
      assert.equal(store.readState('synthetic.json').value.synthetic, true);
    `], { cwd: root, env: { ...process.env, DATA_DIR: data }, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(fs.statSync(dir).mode & 0o777, parentMode);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('new nested directories cannot accept state or evidence before ancestor sync succeeds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweet-watcher-v2-ancestor-sync-'));
  try {
    for (const kind of ['state', 'evidence']) {
      const data = path.join(dir, kind, 'new-parent', 'new-data');
      const child = spawnSync(process.execPath, ['-e', `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const path = require('node:path');
        const open = fs.openSync, fsync = fs.fsyncSync;
        const opened = new Map(), synced = [];
        const parent = path.dirname(process.env.DATA_DIR);
        let failParent = true;
        fs.openSync = (name, ...args) => {
          const fd = open(name, ...args);
          opened.set(fd, path.resolve(name));
          return fd;
        };
        fs.fsyncSync = (fd) => {
          const name = opened.get(fd);
          if (failParent && name === parent) {
            throw Object.assign(new Error('synthetic parent directory sync failure'), { code: 'EIO' });
          }
          fsync(fd);
          synced.push(name);
        };
        function writer() {
          if (${JSON.stringify(kind)} === 'state') {
            const store = require('./lib/store');
            return () => store.writeJSON('synthetic.json', { synthetic: true });
          }
          const evidence = require('./lib/evidence').createEvidenceStore();
          return () => evidence.persist({ runId: '11111111-1111-1111-1111-111111111111',
            page: 0, username: 'alice', operation: 'user', data: {} });
        }
        let write = writer();
        assert.throws(write, { code: 'EIO' });
        assert.equal(fs.statSync(parent).mode & 0o777, 0o700);
        assert.equal(fs.statSync(process.env.DATA_DIR).mode & 0o777, 0o700);
        assert.deepEqual(fs.readdirSync(process.env.DATA_DIR), []);
        assert.throws(write, { code: 'EIO' });
        assert.deepEqual(fs.readdirSync(process.env.DATA_DIR), []);
        // A fresh module state sees the visible directory, but must still sync
        // its ancestors before accepting any evidence or application record.
        for (const module of ['./lib/store', './lib/evidence', './lib/data-directory']) {
          delete require.cache[require.resolve(module)];
        }
        write = writer();
        assert.throws(write, { code: 'EIO' });
        assert.deepEqual(fs.readdirSync(process.env.DATA_DIR), []);
        failParent = false;
        write();
        assert.equal(fs.readdirSync(process.env.DATA_DIR).length, 1);
        for (let ancestor = process.env.DATA_DIR; ; ancestor = path.dirname(ancestor)) {
          assert.ok(synced.includes(ancestor), 'ancestor was not synced: ' + ancestor);
          if (path.dirname(ancestor) === ancestor) break;
        }
      `], { cwd: root, env: { ...process.env, DATA_DIR: data }, encoding: 'utf8', timeout: 10000 });
      assert.equal(child.status, 0, kind + ': ' + child.stderr);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a non-root service can initialize private state under readable shared ancestors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweet-watcher-v2-service-user-'));
  let executableFd;
  try {
    // Copy only source helpers; no instance state or credentials are involved.
    fs.mkdirSync(path.join(dir, 'lib'));
    for (const name of ['store.js', 'data-directory.js']) {
      fs.copyFileSync(path.join(root, 'lib', name), path.join(dir, 'lib', name));
    }
    const options = {};
    let executable = process.execPath;
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      fs.chownSync(dir, 65534, 65534);
      options.uid = options.gid = 65534;
      // npx runtimes can live below /root. Execute this same Linux binary through
      // an inherited descriptor so dropping privileges does not require access
      // to the developer's private package cache.
      executableFd = fs.openSync(process.execPath, 'r');
      executable = '/proc/self/fd/3';
      options.stdio = ['ignore', 'pipe', 'pipe', executableFd];
    }
    const child = spawnSync(executable, ['-e', `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      assert.notEqual(process.getuid(), 0);
      const store = require('./lib/store');
      store.writeJSON('synthetic.json', { synthetic: true });
      assert.equal(store.readState('synthetic.json').value.synthetic, true);
      assert.equal(fs.statSync(process.env.DATA_DIR).mode & 0o777, 0o700);
      assert.equal(fs.statSync(process.env.DATA_DIR + '/synthetic.json').mode & 0o777, 0o600);
    `], { cwd: dir, env: { ...process.env, DATA_DIR: path.join(dir, 'new-parent', 'new-data') },
      ...options, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.error?.message || child.stderr);
  } finally {
    if (executableFd !== undefined) fs.closeSync(executableFd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
