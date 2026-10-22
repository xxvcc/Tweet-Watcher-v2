'use strict';

const fs = require('node:fs');
const path = require('node:path');
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PRODUCTION_ROOT = '/www/tweet-watcher';
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'public');

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

module.exports = { resolveDataDirectory };
