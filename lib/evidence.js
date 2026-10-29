'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveDataDirectory, ensureDurableDataDirectory } = require('./data-directory');

const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 128;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const FILE_RE = /^evidence-[0-9a-f-]{36}-[0-9]{1,2}\.json$/;

// Evidence is private, bounded, and committed before the corresponding response
// can establish a checkpoint. Never save HTTP headers, cookies or diagnostics.
function createEvidenceStore(directory = resolveDataDirectory()) {
  const root = resolveDataDirectory(directory);
  function validate() {
    ensureDurableDataDirectory(root, { create: true });
  }
  function persist({ runId, page, username, operation, data, secrets = [] }) {
    validate();
    const name = `evidence-${runId}-${page}.json`;
    if (!FILE_RE.test(name)) throw new Error('invalid evidence identity');
    let raw = JSON.stringify(data);
    for (const secret of secrets) {
      if (typeof secret === 'string' && secret.length) {
        // JSON-escape the needle as well, so quoted/escaped credentials cannot
        // escape redaction if an upstream diagnostic happens to echo them.
        const escaped = JSON.stringify(secret).slice(1, -1);
        raw = raw.split(escaped).join('[REDACTED]');
      }
    }
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const buffer = Buffer.from(JSON.stringify({ protocol: 1, collectedAt: new Date().toISOString(),
      runId, page, username, operation, sha256: hash, data: JSON.parse(raw) }));
    if (buffer.length > MAX_PAGE_BYTES) throw new Error('evidence page too large');
    const now = Date.now();
    const files = fs.readdirSync(root).filter((entry) => FILE_RE.test(entry)).map((entry) => {
      const stat = fs.lstatSync(path.join(root, entry));
      if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('unsafe evidence file');
      return { name: entry, size: stat.size, mtime: stat.mtimeMs };
    }).sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
    let total = files.reduce((sum, file) => sum + file.size, 0);
    let count = files.length;
    for (const file of files) {
      if (now - file.mtime <= RETENTION_MS && total + buffer.length <= MAX_TOTAL_BYTES && count < MAX_FILES) continue;
      // Do not evict pages from this round before its checkpoint decision.
      if (file.name.startsWith(`evidence-${runId}-`)) continue;
      fs.unlinkSync(path.join(root, file.name));
      total -= file.size;
      count--;
    }
    if (total + buffer.length > MAX_TOTAL_BYTES || count >= MAX_FILES) throw new Error('evidence capacity exceeded');
    const target = path.join(root, name);
    const temp = path.join(root, `.evidence-${crypto.randomUUID()}.tmp`);
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, buffer); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      // A run/page is immutable. Exclusive linking refuses replacement and
      // never follows an existing destination symlink.
      fs.linkSync(temp, target);
      fs.unlinkSync(temp);
      const dirfd = fs.openSync(root, 'r');
      try { fs.fsyncSync(dirfd); } finally { fs.closeSync(dirfd); }
    } catch (error) {
      try { fs.unlinkSync(temp); } catch (_) {}
      throw error;
    }
    return { file: name, sha256: hash };
  }
  return { persist };
}

module.exports = { createEvidenceStore, MAX_PAGE_BYTES, MAX_TOTAL_BYTES, MAX_FILES, RETENTION_MS };
