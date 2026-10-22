'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const store = require('../lib/store');

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
    assert.equal(calls.openFlags[0], 'wx');
  });
});

test('state reads reject special and oversized files before reading their contents', { concurrency: false }, () => {
  const originalLstat = fs.lstatSync;
  const originalRead = fs.readFileSync;
  let reads = 0;
  try {
    fs.readFileSync = () => { reads++; return '{}'; };
    fs.lstatSync = () => ({ isFile: () => false, isSymbolicLink: () => false, size: 0 });
    const special = store.readState('special.json');
    assert.equal(special.status, 'corrupt');
    assert.match(special.error.message, /不是普通文件/);

    fs.lstatSync = () => ({ isFile: () => true, isSymbolicLink: () => false, size: 9 * 1024 * 1024 });
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
    fs.lstatSync = () => ({ isFile: () => false, isSymbolicLink: () => false });
    fs.unlinkSync = () => { unlinks++; };
    assert.throws(() => store.removeJSON('config.json'), /非普通数据文件/);
    assert.equal(unlinks, 0);
  } finally {
    fs.lstatSync = originalLstat;
    fs.unlinkSync = originalUnlink;
  }
});
