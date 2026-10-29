#!/usr/bin/env node
'use strict';

// Produces a private candidate bundle; never installs it or changes input files.
// Usage: node scripts/migrate-state.cjs migrate|rollback --input /private/input.json --output-dir /private/new-bundle
const fs = require('node:fs');
const path = require('node:path');
const { migrateState, rollbackState, MAX_INPUT_BYTES } = require('../lib/migration');

function refuse(code) { throw Object.assign(new Error(code), { code }); }
function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function privateDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) || stat.uid !== process.getuid()) refuse('MIGRATION_UNSAFE_DIRECTORY');
  if (fs.realpathSync(directory) !== directory) refuse('MIGRATION_SYMLINK');
  for (let cursor = directory; ; cursor = path.dirname(cursor)) {
    if (fs.existsSync(path.join(cursor, '.git'))) refuse('MIGRATION_REPOSITORY_PATH');
    if (path.dirname(cursor) === cursor) break;
  }
}
function readPrivate(file) {
  privateDirectory(path.dirname(file));
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) || stat.uid !== process.getuid()
        || stat.nlink !== 1 || stat.size > MAX_INPUT_BYTES) refuse('MIGRATION_UNSAFE_INPUT');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}
function writePrivate(directory, name, value) {
  const fd = fs.openSync(path.join(directory, name), fs.constants.O_WRONLY | fs.constants.O_CREAT
    | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function main(args) {
  if (args.length !== 5 || !['migrate', 'rollback'].includes(args[0])
      || args[1] !== '--input' || args[3] !== '--output-dir'
      || !path.isAbsolute(args[2]) || !path.isAbsolute(args[4])) refuse('MIGRATION_USAGE');
  const source = path.resolve(args[2]);
  const destination = path.resolve(args[4]);
  privateDirectory(path.dirname(destination));
  if (fs.existsSync(destination)) refuse('MIGRATION_OUTPUT_EXISTS');
  const input = readPrivate(source);
  const result = (args[0] === 'migrate' ? migrateState : rollbackState)(input);
  // A complete manifest is the final bundle entry. A crash before that entry
  // leaves an incomplete candidate, never a partially replaced running state.
  fs.mkdirSync(destination, { mode: 0o700 });
  syncDirectory(path.dirname(destination));
  writePrivate(destination, 'delivery_state.json', result.state);
  writePrivate(destination, 'delivery_state.initialized.json', { version: 1 });
  syncDirectory(destination);
  writePrivate(destination, 'migration-manifest.json', result.manifest);
  syncDirectory(destination);
  process.stdout.write(JSON.stringify({ ok: true, mode: args[0], accounts: Object.keys(result.state.accounts).length,
    pending: Object.values(result.state.accounts).reduce((sum, record) => sum + record.pending.length, 0) }) + '\n');
}

try { main(process.argv.slice(2)); }
catch (error) {
  // Do not echo input paths, JSON parse excerpts or filesystem diagnostics.
  const code = typeof error.code === 'string' && /^MIGRATION_[A-Z_]+$/.test(error.code)
    ? error.code : 'MIGRATION_IO_OR_INPUT';
  process.stderr.write(JSON.stringify({ ok: false, code }) + '\n');
  process.exitCode = 1;
}
