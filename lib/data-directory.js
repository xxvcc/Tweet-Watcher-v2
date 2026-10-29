'use strict';

const fs = require('node:fs');
const path = require('node:path');
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PRODUCTION_ROOT = '/www/tweet-watcher';
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'public');
const pendingDirectorySyncs = new Map();

// Resolve existing ancestors too: a not-yet-created directory below a symlink
// must not evade the production boundary. This reads directory metadata only.
function canonicalPath(value) {
  const pending = [];
  let current = path.resolve(value);
  while (true) {
    try { return path.join(fs.realpathSync.native(current), ...pending); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      // realpath reports ENOENT for dangling symlinks. Resolve the link itself
      // before walking upward, so a missing target cannot hide a forbidden root.
      try {
        const entry = fs.lstatSync(current);
        if (entry.isSymbolicLink()) {
          return path.join(canonicalPath(path.resolve(parent, fs.readlinkSync(current))), ...pending);
        }
      } catch (lookupError) {
        if (lookupError.code !== 'ENOENT') throw lookupError;
      }
      pending.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isWithin(candidate, parent) {
  return candidate === parent || candidate.startsWith(parent + path.sep);
}

function resolveDataDirectory(value = process.env.DATA_DIR) {
  if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.includes('\0'))) {
    throw new Error('DATA_DIR 必须为非空目录路径');
  }
  const requested = path.resolve(PROJECT_ROOT, value === undefined ? 'data' : value);
  const resolved = canonicalPath(requested);
  if (isWithin(resolved, PRODUCTION_ROOT) || isWithin(resolved, canonicalPath(PRODUCTION_ROOT))) {
    throw new Error('DATA_DIR 不得指向旧版生产目录或其子目录');
  }
  // Express serves public without authentication. Refuse both aliases into the
  // static root and lexical paths below it, even if a child symlink points out.
  if (isWithin(requested, PUBLIC_ROOT) || isWithin(resolved, PUBLIC_ROOT)
      || isWithin(resolved, canonicalPath(PUBLIC_ROOT))) {
    throw new Error('DATA_DIR 不得指向公开静态目录 public 或其子目录');
  }
  return resolved;
}

// Recheck before every state/evidence access: a private file mode cannot protect
// an authentication record if another user can replace entries in its directory.
// Never chmod an operator-supplied directory; reject it without changing its data.
function validateDataDirectory(directory, { allowMissing = false } = {}) {
  if (resolveDataDirectory(directory) !== directory) throw new Error('DATA_DIR 路径在运行中发生变化');
  let stat;
  try { stat = fs.lstatSync(directory); }
  catch (error) {
    if (allowMissing && error.code === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isDirectory() || (stat.mode & 0o077)) {
    throw new Error('DATA_DIR 必须为私有目录，不能向组或其他用户开放权限');
  }
  return true;
}

function directoryChain(directory) {
  const chain = [];
  for (let current = directory; ; current = path.dirname(current)) {
    chain.push(current);
    if (path.dirname(current) === current) return chain;
  }
}

// Persist each ancestor's directory entry before allowing the first state write.
// At process startup an existing path may have been created by a process that
// exited before syncing its parents, so its complete chain needs the same barrier.
// Linux permits fsync on read-only directory descriptors; no chmod is performed.
// Keeping the unfinished queue also prevents a failed mkdir/fsync retry from
// treating the now-visible directory as an already durable installation.
function ensureDurableDataDirectory(directory, { create = false } = {}) {
  const exists = validateDataDirectory(directory, { allowMissing: true });
  let pending = pendingDirectorySyncs.get(directory);
  if (!pending || !exists) {
    pending = directoryChain(directory);
    pendingDirectorySyncs.set(directory, pending);
  }
  if (!exists) {
    if (!create) return false;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    validateDataDirectory(directory);
  }
  while (pending.length) {
    const fd = fs.openSync(pending[0], 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    pending.shift();
  }
  return true;
}

module.exports = { resolveDataDirectory, validateDataDirectory, ensureDurableDataDirectory };
