'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const JOURNAL = 'config_transaction.json';
const oldConfig = { tg_chat_id: '-1001', paused: false, accounts: [{ username: 'alice', fetch_count: 10, check_interval: 30 }], revision: 1 };
const nextConfig = { ...oldConfig, tg_chat_id: '-1002', revision: 2,
  media_mode: 'photos', enrichment_mode: 'detail', enrichment_limit: 3,
  x_sessions: [{ id: 'backup', label: '备用会话', enabled: true, proxy_url: 'http://127.0.0.1:8080' }] };
const oldSecrets = { auth_token: 'synthetic-auth', ct0: 'synthetic-csrf', tg_bot_token: 'synthetic-old-bot' };
const nextSecrets = { ...oldSecrets, tg_bot_token: 'synthetic-new-bot',
  x_sessions: { backup: { auth_token: 'synthetic-backup-auth', ct0: 'synthetic-backup-csrf' } } };

function child(dir, script) {
  return spawnSync(process.execPath, ['-e', script], {
    cwd: root, env: { ...process.env, DATA_DIR: dir, TW_RUNTIME_MODE: 'development' }, encoding: 'utf8', timeout: 10000,
  });
}
function snapshot(dir) {
  const result = child(dir, `const cfg = require('./lib/config');
    process.stdout.write(JSON.stringify({config:cfg.getConfig(),secrets:cfg.getSecrets()}));`);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function initialize(dir) {
  const result = child(dir, `const cfg = require('./lib/config');
    cfg.saveConfig(${JSON.stringify(oldConfig)}); cfg.saveSecrets(${JSON.stringify(oldSecrets)});`);
  assert.equal(result.status, 0, result.stderr);
}

test('every settings commit crash boundary restarts with an entire old or new pair', () => {
  for (const boundary of ['before-intent', 'after-intent', 'after-config', 'after-secrets', 'after-cleanup']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-config-crash-'));
    try {
      initialize(dir);
      const result = child(dir, `
        const fs = require('node:fs'), path = require('node:path');
        const cfg = require('./lib/config'), store = require('./lib/store');
        const boundary = ${JSON.stringify(boundary)};
        const write = store.writeJSON, remove = store.removeJSON;
        store.writeJSON = (name, value) => {
          if (boundary === 'before-intent' && name === '${JOURNAL}') process.exit(79);
          write(name, value);
          if ((boundary === 'after-intent' && name === '${JOURNAL}')
            || (boundary === 'after-config' && name === 'config.json')
            || (boundary === 'after-secrets' && name === 'secrets.json')) process.exit(79);
        };
        store.removeJSON = (name) => { remove(name); if (boundary === 'after-cleanup') process.exit(79); };
        cfg.saveSettings(${JSON.stringify(nextConfig)}, ${JSON.stringify(nextSecrets)});
      `);
      assert.equal(result.status, 79, boundary + ': ' + result.stderr);
      if (fs.existsSync(path.join(dir, JOURNAL))) assert.equal(fs.statSync(path.join(dir, JOURNAL)).mode & 0o777, 0o600);
      const loaded = snapshot(dir);
      const expectNew = boundary !== 'before-intent';
      assert.equal(loaded.config.tg_chat_id, expectNew ? nextConfig.tg_chat_id : oldConfig.tg_chat_id, boundary);
      assert.equal(loaded.config.revision, expectNew ? 2 : 1, boundary);
      assert.equal(loaded.config.media_mode, expectNew ? 'photos' : 'links', boundary);
      assert.deepEqual(loaded.config.x_sessions, expectNew ? nextConfig.x_sessions : [], boundary);
      assert.deepEqual(loaded.secrets, { ai_api_key: '', x_sessions: {}, ...(expectNew ? nextSecrets : oldSecrets) }, boundary);
      assert.equal(fs.existsSync(path.join(dir, JOURNAL)), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a first-save crash recovers the selected accounts instead of presenting an empty configuration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-config-first-'));
  try {
    const result = child(dir, `const cfg = require('./lib/config'), store = require('./lib/store');
      const write = store.writeJSON;
      store.writeJSON = (name,value) => { write(name,value); if(name === '${JOURNAL}') process.exit(79); };
      cfg.saveSettings(${JSON.stringify(nextConfig)}, ${JSON.stringify(nextSecrets)});`);
    assert.equal(result.status, 79, result.stderr);
    const loaded = snapshot(dir);
    assert.equal(loaded.config.persisted, true);
    assert.deepEqual(loaded.config.accounts, nextConfig.accounts);
    assert.deepEqual(loaded.secrets, { ai_api_key: '', x_sessions: {}, ...nextSecrets });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('persistent recovery failure blocks both config and secrets until the whole transaction completes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-config-fault-'));
  try {
    initialize(dir);
    const result = child(dir, `const assert = require('node:assert/strict');
      const cfg = require('./lib/config'), store = require('./lib/store');
      const write = store.writeJSON;
      store.writeJSON = (name,value) => { if(name === 'secrets.json') throw new Error('injected'); write(name,value); };
      assert.throws(() => cfg.saveSettings(${JSON.stringify(nextConfig)}, ${JSON.stringify(nextSecrets)}), {code:'CONFIG_COMMIT_PENDING'});
      assert.throws(() => cfg.getConfig(), {code:'CONFIG_COMMIT_PENDING'});
      assert.throws(() => cfg.getSecrets(), {code:'CONFIG_COMMIT_PENDING'});
      store.writeJSON = write;
      assert.equal(cfg.getSecrets().tg_bot_token, 'synthetic-new-bot');
      assert.equal(cfg.getConfig().tg_chat_id, '-1002');
      cfg.saveConfig({...cfg.getConfig(),paused:true});
      assert.equal(cfg.getConfig().paused,true);
      assert.equal(cfg.getSecrets().tg_bot_token,'synthetic-new-bot');`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(dir, JOURNAL)), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a directory sync failure after config rename cannot expose a mixed settings pair', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-config-sync-'));
  try {
    initialize(dir);
    const result = child(dir, `const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
      const cfg = require('./lib/config');
      const rename = fs.renameSync, sync = fs.fsyncSync;
      let fail = false;
      fs.renameSync = (from,to) => { rename(from,to); if(path.basename(to) === 'config.json') fail = true; };
      fs.fsyncSync = (fd) => { if(fail && fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('synthetic I/O failure'),{code:'EIO'}); sync(fd); };
      assert.throws(() => cfg.saveSettings(${JSON.stringify(nextConfig)}, ${JSON.stringify(nextSecrets)}));
      assert.throws(() => cfg.getConfig()); assert.throws(() => cfg.getSecrets());
      fs.fsyncSync = sync; fs.renameSync = rename;
      assert.equal(cfg.getConfig().tg_chat_id,'-1002');
      assert.equal(cfg.getSecrets().tg_bot_token,'synthetic-new-bot');`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(snapshot(dir).config.revision, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt transaction records stop reads and cannot overwrite the original files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-config-corrupt-'));
  try {
    initialize(dir);
    const configBefore = fs.readFileSync(path.join(dir, 'config.json'));
    const secretsBefore = fs.readFileSync(path.join(dir, 'secrets.json'));
    for (const invalid of ['{', JSON.stringify({version:1,config:{},secrets:{}}), JSON.stringify({version:2})]) {
      fs.writeFileSync(path.join(dir, JOURNAL), invalid, {mode:0o600});
      const result = child(dir, `const assert = require('node:assert/strict'), cfg = require('./lib/config');
        assert.throws(() => cfg.getConfig(), {code:'DATA_CORRUPT'});
        assert.throws(() => cfg.getSecrets(), {code:'DATA_CORRUPT'});
        assert.throws(() => cfg.saveSettings(${JSON.stringify(nextConfig)}, ${JSON.stringify(nextSecrets)}), {code:'DATA_CORRUPT'});`);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(fs.readFileSync(path.join(dir, 'config.json')), configBefore);
      assert.deepEqual(fs.readFileSync(path.join(dir, 'secrets.json')), secretsBefore);
      assert.equal(fs.readFileSync(path.join(dir, JOURNAL),'utf8'),invalid);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an interrupted legacy transaction without AI fields recovers with translation disabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-config-legacy-'));
  try {
    const { revision, ...legacyConfig } = nextConfig;
    fs.writeFileSync(path.join(dir, JOURNAL), JSON.stringify({ version: 1,
      config: { ...legacyConfig, _revision: revision }, secrets: nextSecrets }), { mode: 0o600 });
    const loaded = snapshot(dir);
    assert.equal(loaded.config.ai_translation_enabled, false);
    assert.equal(loaded.config.ai_base_url, 'https://api.openai.com/v1');
    assert.equal(loaded.config.ai_model, '');
    assert.equal(loaded.secrets.ai_api_key, '');
    assert.equal(loaded.secrets.tg_bot_token, nextSecrets.tg_bot_token);
    assert.equal(fs.existsSync(path.join(dir, JOURNAL)), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('AI provider and its key recover atomically across config-write crashes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-config-ai-'));
  try {
    initialize(dir);
    const aiConfig = { ...nextConfig, ai_translation_enabled: true,
      ai_base_url: 'https://synthetic.example.test/v1', ai_model: 'synthetic-model' };
    const aiSecrets = { ...nextSecrets, ai_api_key: 'synthetic-ai-key' };
    const result = child(dir, `const cfg = require('./lib/config'), store = require('./lib/store');
      const write = store.writeJSON;
      store.writeJSON = (name,value) => { write(name,value); if(name === 'config.json') process.exit(79); };
      cfg.saveSettings(${JSON.stringify(aiConfig)}, ${JSON.stringify(aiSecrets)});`);
    assert.equal(result.status, 79, result.stderr);
    const loaded = snapshot(dir);
    assert.equal(loaded.config.ai_translation_enabled, true);
    assert.equal(loaded.config.ai_base_url, aiConfig.ai_base_url);
    assert.equal(loaded.config.ai_model, aiConfig.ai_model);
    assert.equal(loaded.secrets.ai_api_key, aiSecrets.ai_api_key);
    assert.equal(fs.statSync(path.join(dir, 'secrets.json')).mode & 0o777, 0o600);
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))), 'ai_api_key'), false);
    assert.equal(fs.existsSync(path.join(dir, JOURNAL)), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
