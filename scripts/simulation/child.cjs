'use strict';
// Test-only process entrypoint. Application modules, Python protocol, persistence,
// parsers and delivery contracts are real. Only external routing and time change.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const options = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const realNow = Date.now;
let offset = options.offset || 0;
Date.now = () => realNow() + offset;
const realTimeout = global.setTimeout;
if (options.fastPacing) global.setTimeout = (fn, ms, ...args) => realTimeout(fn,
  ms === 500 ? 1 : ms === 2000 ? 5 : ms, ...args);
const pythonChildren = new Set();
const spawn = cp.spawn;
cp.spawn = function(file, args, opts) {
  if (args?.includes(path.join(root, 'collector/bridge.py'))) {
    args = ['-I', path.join(__dirname, 'bridge.py'), String(options.tlsPort), options.cert];
  } else throw new Error('Simulation blocked an unexpected child process');
  const child = spawn(file, args, opts);
  pythonChildren.add(child);
  child.once('exit', () => {
    pythonChildren.delete(child);
    if (process.connected) process.send({ event: 'python-exit', pid: child.pid });
  });
  process.send?.({ event: 'python', pid: child.pid });
  return child;
};
const fetch = global.fetch;
global.fetch = async function(input, init) {
  const url = new URL(typeof input === 'string' ? input : input.url || String(input));
  if (url.protocol !== 'https:' || !['api.telegram.org', 'ai.sim.test'].includes(url.hostname)) {
    process.send?.({ event: 'blocked-network', host: url.hostname });
    throw new Error('Simulation blocked unexpected external fetch');
  }
  const originalHost = url.hostname;
  url.hostname = '127.0.0.1'; url.port = String(options.tlsPort);
  return fetch(url, { ...init, headers: { ...init?.headers, 'x-simulation-host': originalHost } });
};
let fault;
function shouldFault(where, filename, phase, candidate) {
  if (!fault || fault.where !== where || fault.phase !== phase || !path.basename(filename).startsWith(fault.file)) return false;
  if (fault.pendingId || fault.partNext !== undefined) {
    const pending = Object.values(candidate?.accounts || {}).flatMap((a) => a.pending || []);
    if (!pending.some((t) => (!fault.pendingId || t.id === fault.pendingId)
      && (fault.partNext === undefined || t.delivery?.next === fault.partNext))) return false;
  }
  const match = fault;
  if (--fault.times <= 0) fault = null;
  process.send?.({ event: 'fault', where, phase, file: path.basename(filename), action: match.action });
  if (match.action === 'kill') process.kill(process.pid, 'SIGKILL');
  if (match.action === 'error') throw Object.assign(new Error('Synthetic storage I/O failure'), { code: 'EIO' });
  return true;
}
const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  let candidate;
  if (fault?.where === 'rename' && String(to).startsWith(options.dataDir)) {
    try { candidate = JSON.parse(fs.readFileSync(from, 'utf8')); } catch (_) {}
    shouldFault('rename', to, 'before', candidate);
  }
  const result = rename(from, to);
  if (String(to).startsWith(options.dataDir)) shouldFault('rename', to, 'after', candidate);
  return result;
};
const unlink = fs.unlinkSync;
fs.unlinkSync = function(filename) {
  if (String(filename).startsWith(options.dataDir)) shouldFault('unlink', filename, 'before');
  const result = unlink(filename);
  if (String(filename).startsWith(options.dataDir)) shouldFault('unlink', filename, 'after');
  return result;
};
const cfg = require('../../lib/config');
const auth = require('../../lib/auth');
const worker = require('../../lib/worker');
const collector = require('../../lib/twscrape');
const state = require('../../lib/state');
const store = require('../../lib/store');
let server;
async function main() {
  if (!fs.existsSync(path.join(options.dataDir, 'config.json'))) cfg.saveSettings(options.config, options.secrets);
  if (!auth.hasPassword()) await auth.setPassword(options.password);
  store.sweepTmp();
  const { app } = require('../../server');
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  process.send({ event: 'ready', port: server.address().port });
  if (options.autoStart) worker.start();
}
process.on('message', async ({ id, op, payload = {} }) => {
  try {
    let result;
    if (op === 'tick') {
      offset += payload.advanceMs || 0;
      await worker.tick({ waitForDelivery: payload.waitForDelivery !== false });
      result = state.getStatus();
    } else if (op === 'advance') { offset += payload.ms || 0; result = Date.now(); }
    else if (op === 'config') {
      cfg.saveSettings({ ...cfg.getConfig(), ...payload.config }, { ...cfg.getSecrets(), ...payload.secrets });
      const current = cfg.getConfig(); worker.configChanged(current.revision, { paused: current.paused });
      result = { revision: current.revision };
    } else if (op === 'snapshot') result = { status: state.getStatus(), diagnostics: worker.getDiagnostics(),
      memory: process.memoryUsage(), clock: Date.now(), offset };
    else if (op === 'fault') { fault = payload ? { times: 1, ...payload } : null; result = true; }
    else if (op === 'close') {
      collector.close(); server.closeAllConnections(); server.close();
      process.send({ id, ok: true, result: true }, () => process.exit(0)); return;
    } else throw new Error('Unknown simulation command');
    process.send?.({ id, ok: true, result });
  } catch (error) { process.send?.({ id, ok: false, error: String(error.message), code: error.code }); }
});
main().catch((error) => { process.send?.({ event: 'fatal', error: error.message }); process.exit(1); });
