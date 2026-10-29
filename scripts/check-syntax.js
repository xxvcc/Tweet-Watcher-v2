'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const files = ['server.js'];
function collect(directory) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    if (entry.isDirectory()) collect(`${directory}/${entry.name}`);
    if (entry.isFile() && /\.[cm]?js$/.test(entry.name)) files.push(`${directory}/${entry.name}`);
  }
}
for (const directory of ['lib', 'public', 'scripts', 'test', 'collector/tests']) collect(directory);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax checked ${files.length} JavaScript files.`);
