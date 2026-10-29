#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'twv2-simulation-report-'));
const report = { startedAt: new Date().toISOString(), directory, checks: [] };
async function run(name, command, args, env = {}) {
  const startedAt = Date.now();
  const log = fs.createWriteStream(path.join(directory, name + '.log'), { mode: 0o600 });
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { log.write(chunk); process.stdout.write(chunk); });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  await new Promise((resolve) => log.end(resolve));
  report.checks.push({ name, exitCode: code, elapsedMs: Date.now() - startedAt });
  if (code !== 0) throw new Error(name + ' failed');
}
(async () => {
  await run('bridge', path.join(root, '.venv/bin/python'), ['scripts/simulation/test_bridge.py', '-v']);
  await run('scenarios', process.execPath, ['--test', 'scripts/simulation/scenarios.cjs'],
    { SIMULATION_REPORT: path.join(directory, 'scenarios.json') });
  await run('stress', process.execPath, ['scripts/simulation/stress.cjs', '--output', path.join(directory, 'stress.json')]);
  report.ok = true;
})().catch((error) => { report.ok = false; report.error = error.message; process.exitCode = 1; })
  .finally(() => {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify({ ok: report.ok, report: path.join(directory, 'summary.json') }) + '\n');
  });
