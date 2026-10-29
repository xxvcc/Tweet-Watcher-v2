'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tweet-watcher-store-tests-'));
process.env.DATA_DIR = temporary;
const store = require('../lib/store');
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

function withMockedFs(writeImpl, fn) {
  const names = ['existsSync', 'openSync', 'writeSync', 'fsyncSync', 'closeSync', 'renameSync', 'unlinkSync'];
  const original = Object.fromEntries(names.map((name) => [name, fs[name]]));
  const calls = { writes: 0, renamed: false, unlinked: false, openFlags: [] };
  try {
    fs.existsSync = () => true;
    fs.openSync = (name, flags) => { calls.openFlags.push(flags); return 10; };
    fs.writeSync = (...args) => { calls.writes++; return writeImpl(...args); };
    fs.fsyncSync = () => {};
    fs.closeSync = () => {};
    fs.renameSync = () => { calls.renamed = true; };
    fs.unlinkSync = () => { calls.unlinked = true; };
    return fn(calls);
  } finally {
    for (const name of names) fs[name] = original[name];
  }
}

test('atomic JSON writes loop until every byte is written', () => {
  withMockedFs((fd, buf, offset, length) => Math.min(3, length), (calls) => {
    store.writeJSON('test.json', { payload: 'long enough for several writes' });
    assert.ok(calls.writes > 1);
    assert.equal(calls.renamed, true);
    assert.ok(calls.openFlags.includes('wx'));
  });
});

test('state reads reject special and oversized files before reading their contents', { concurrency: false }, () => {
  const originalLstat = fs.lstatSync;
  const originalRead = fs.readFileSync;
  let reads = 0;
  try {
    fs.readFileSync = () => { reads++; return '{}'; };
    fs.lstatSync = (name, ...args) => path.basename(name) === 'special.json'
      ? { isFile: () => false, isSymbolicLink: () => false, size: 0 }
      : originalLstat(name, ...args);
    const special = store.readState('special.json');
    assert.equal(special.status, 'corrupt');
    assert.match(special.error.message, /不是普通文件/);

    fs.lstatSync = (name, ...args) => path.basename(name) === 'oversized.json'
      ? { isFile: () => true, isSymbolicLink: () => false, size: 9 * 1024 * 1024 }
      : originalLstat(name, ...args);
    const oversized = store.readState('oversized.json');
    assert.equal(oversized.status, 'corrupt');
    assert.match(oversized.error.message, /超过/);
    assert.equal(reads, 0);
  } finally {
    fs.lstatSync = originalLstat;
    fs.readFileSync = originalRead;
  }
});

test('a zero-byte short write aborts before rename and removes the temp file', () => {
  withMockedFs(() => 0, (calls) => {
    assert.throws(() => store.writeJSON('test.json', { payload: 'x' }), /短写/);
    assert.equal(calls.renamed, false);
    assert.equal(calls.unlinked, true);
  });
});

test('transaction rollback deletion refuses non-file data paths', { concurrency: false }, () => {
  const originalLstat = fs.lstatSync;
  const originalUnlink = fs.unlinkSync;
  let unlinks = 0;
  try {
    fs.lstatSync = (name, ...args) => path.basename(name) === 'config.json'
      ? { isFile: () => false, isSymbolicLink: () => false }
      : originalLstat(name, ...args);
    fs.unlinkSync = () => { unlinks++; };
    assert.throws(() => store.removeJSON('config.json'), /非普通数据文件/);
    assert.equal(unlinks, 0);
  } finally {
    fs.lstatSync = originalLstat;
    fs.unlinkSync = originalUnlink;
  }
});

test('directory sync failure blocks uncertain replacements and deletions until a successful retry', () => {
  const directory = fs.mkdtempSync(path.join(temporary, 'durability-'));
  const child = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    let store = require('./lib/store');
    store.writeJSON('record.json', { revision: 1 });
    const fsync = fs.fsyncSync;
    let failDirectory = true;
    fs.fsyncSync = (fd) => {
      if (failDirectory && fs.fstatSync(fd).isDirectory()) {
        throw Object.assign(new Error('synthetic directory sync failure'), { code: 'EIO' });
      }
      return fsync(fd);
    };
    assert.throws(() => store.writeJSON('record.json', { revision: 2 }), { code: 'EIO' });
    // Rename is visible, but the normal read API must not call it committed.
    assert.equal(JSON.parse(fs.readFileSync(process.env.DATA_DIR + '/record.json')).revision, 2);
    assert.throws(() => store.readState('record.json'), { code: 'EIO' });
    assert.throws(() => store.writeJSON('other.json', {}), { code: 'EIO' });
    assert.equal(fs.existsSync(process.env.DATA_DIR + '/other.json'), false);
    // A newly loaded store also requires a durability barrier before trusting disk.
    delete require.cache[require.resolve('./lib/store')];
    store = require('./lib/store');
    assert.throws(() => store.readState('record.json'), { code: 'EIO' });
    failDirectory = false;
    assert.equal(store.readState('record.json').value.revision, 2);
    failDirectory = true;
    assert.throws(() => store.removeJSON('record.json'), { code: 'EIO' });
    assert.equal(fs.existsSync(process.env.DATA_DIR + '/record.json'), false);
    // Missing after unlink is not enough to report durable deletion.
    assert.throws(() => store.removeJSON('record.json'), { code: 'EIO' });
    assert.throws(() => store.readState('record.json'), { code: 'EIO' });
    failDirectory = false;
    store.removeJSON('record.json');
    assert.equal(store.readState('record.json').status, 'missing');
    assert.deepEqual(fs.readdirSync(process.env.DATA_DIR), []);
    // A filesystem error may also be reported after performing the mutation.
    // Keep the barrier pending before issuing rename/unlink, not only after it.
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      rename(from, to);
      failDirectory = true;
      throw Object.assign(new Error('uncertain rename'), { code: 'EIO' });
    };
    assert.throws(() => store.writeJSON('record.json', { revision: 3 }), { code: 'EIO' });
    assert.throws(() => store.readState('record.json'), { code: 'EIO' });
    fs.renameSync = rename;
    failDirectory = false;
    assert.equal(store.readState('record.json').value.revision, 3);
    const unlink = fs.unlinkSync;
    fs.unlinkSync = (name) => {
      unlink(name);
      failDirectory = true;
      throw Object.assign(new Error('uncertain unlink'), { code: 'EIO' });
    };
    assert.throws(() => store.removeJSON('record.json'), { code: 'EIO' });
    assert.throws(() => store.readState('record.json'), { code: 'EIO' });
    fs.unlinkSync = unlink;
    failDirectory = false;
    store.removeJSON('record.json');
    assert.equal(store.readState('record.json').status, 'missing');
  `], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATA_DIR: directory }, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
});
