'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

class ClassList {
  constructor(owner, value = '') { this.owner = owner; this.set(value); }
  set(value) { this.values = new Set(String(value).split(/\s+/).filter(Boolean)); }
  sync() { this.owner._className = [...this.values].join(' '); }
  add(...values) { values.forEach((v) => this.values.add(v)); this.sync(); }
  remove(...values) { values.forEach((v) => this.values.delete(v)); this.sync(); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    const on = force === undefined ? !this.contains(value) : !!force;
    if (on) this.add(value); else this.remove(value);
    return on;
  }
}

function matchesSimple(el, selector) {
  selector = selector.trim();
  if (!selector || !el || el.nodeType !== 1) return false;
  const attr = selector.match(/\[([\w-]+)(?:=(?:"([^"]*)"|([^\]]+)))?\]$/);
  if (attr) {
    selector = selector.slice(0, attr.index);
    const actual = attr[1].startsWith('data-')
      ? el.dataset[attr[1].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())]
      : el.attributes[attr[1]];
    const expected = attr[2] ?? attr[3];
    if (expected === undefined ? actual === undefined : String(actual) !== expected) return false;
  }
  if (!selector) return true;
  if (selector[0] === '#') return el.id === selector.slice(1);
  if (selector[0] === '.') return el.classList.contains(selector.slice(1));
  return el.tagName.toLowerCase() === selector.toLowerCase();
}

function matchesSelector(el, selector) {
  const parts = selector.trim().split(/\s+/);
  if (!matchesSimple(el, parts.pop())) return false;
  let ancestor = el.parentNode;
  while (parts.length) {
    const wanted = parts.pop();
    while (ancestor && !matchesSimple(ancestor, wanted)) ancestor = ancestor.parentNode;
    if (!ancestor) return false;
    ancestor = ancestor.parentNode;
  }
  return true;
}

class FakeNode {
  constructor(tagName = 'div', id = '', classes = '') {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.parentNode = null;
    this.childNodes = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.style = {};
    this.value = '';
    this.placeholder = '';
    this.disabled = false;
    this.checked = false;
    this.type = tagName === 'input' ? 'text' : '';
    this._className = classes;
    this.classList = new ClassList(this, classes);
    this._text = '';
  }
  get className() { return this._className; }
  set className(value) { this._className = String(value); this.classList.set(value); }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get textContent() { return this._text + this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.childNodes.forEach((n) => { n.parentNode = null; }); this.childNodes = []; }
  get isConnected() { let n = this; while (n) { if (n.tagName === 'HTML') return true; n = n.parentNode; } return false; }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this; this.childNodes.push(node); return node;
  }
  append(...nodes) { nodes.forEach((n) => this.appendChild(typeof n === 'string' ? new FakeText(n) : n)); }
  insertBefore(node, before) {
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = before ? this.childNodes.indexOf(before) : -1;
    node.parentNode = this;
    if (index < 0) this.childNodes.push(node); else this.childNodes.splice(index, 0, node);
    return node;
  }
  removeChild(node) { const i = this.childNodes.indexOf(node); if (i >= 0) this.childNodes.splice(i, 1); node.parentNode = null; return node; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceWith(node) { if (this.parentNode) { const p = this.parentNode; const i = p.childNodes.indexOf(this); p.removeChild(this); p.childNodes.splice(i, 0, node); node.parentNode = p; } }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'readonly') this.readOnly = true;
    if (name.startsWith('data-')) this.dataset[name.slice(5)] = String(value);
  }
  removeAttribute(name) { delete this.attributes[name]; if (name === 'readonly') this.readOnly = false; }
  addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); }
  matches(selector) { return matchesSelector(this, selector); }
  closest(selector) { let n = this; while (n) { if (matchesSelector(n, selector)) return n; n = n.parentNode; } return null; }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map((s) => s.trim());
    const out = [];
    const visit = (node) => node.children.forEach((child) => {
      if (selectors.some((s) => matchesSelector(child, s))) out.push(child);
      visit(child);
    });
    visit(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
}

class FakeText {
  constructor(value) { this.nodeType = 3; this.parentNode = null; this.textContent = String(value); }
}

function buildDocument() {
  const ids = new Map();
  const html = new FakeNode('html');
  const body = new FakeNode('body');
  html.appendChild(body);
  const document = {
    documentElement: html,
    body,
    activeElement: body,
    cookie: 'tw_csrf=test-csrf',
    listeners: {},
    getElementById: (id) => ids.get(id) || null,
    createElement: (tag) => attach(new FakeNode(tag)),
    createTextNode: (value) => new FakeText(value),
    querySelectorAll: (selector) => html.querySelectorAll(selector),
    addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); },
  };
  function attach(node) { node.ownerDocument = document; return node; }
  attach(html); attach(body);
  function add(parent, id, tag = 'div', classes = '') {
    const node = attach(new FakeNode(tag, id, classes));
    ids.set(id, node); parent.appendChild(node); return node;
  }

  const auth = add(body, 'auth', 'div', 'center hidden');
  ['auth-title', 'auth-sub', 'auth-msg', 'auth-label'].forEach((id) => add(auth, id));
  const form = add(auth, 'auth-form', 'form');
  add(form, 'auth-pw', 'input');
  const pw2 = add(form, 'auth-pw2-wrap', 'div', 'hidden'); add(pw2, 'auth-pw2', 'input');
  const token = add(form, 'auth-token-wrap', 'div', 'hidden'); add(token, 'auth-setup-token', 'input');
  add(form, 'auth-submit', 'button');

  const dash = add(body, 'dash', 'div', 'hidden');
  const live = add(dash, 'livepill'); add(live, 'live-text');
  ['btn-pause', 'btn-resume', 'btn-settings', 'theme-toggle', 'logout'].forEach((id) => add(dash, id, 'button', id === 'btn-pause' || id === 'btn-resume' ? 'hidden' : ''));
  add(dash, 'toast', 'div', 'hidden');
  add(dash, 'runtime-notice');
  ['stat-accounts', 'stat-next', 'stat-pushes', 'stat-uptime', 'acct-count'].forEach((id) => add(dash, id));
  add(dash, 'cards'); add(dash, 'cards-empty', 'div', 'hidden'); add(dash, 'feed');

  const settings = add(body, 'settings', 'div', 'hidden');
  add(settings, 'settings-close', 'button'); add(settings, 'acct-list'); add(settings, 'btn-add-acct', 'button');
  for (const id of ['auth_token', 'ct0', 'tg_bot_token']) add(settings, id, 'input', 'secret');
  for (const id of ['ai_translation_enabled', 'ai_base_url', 'ai_model', 'ai_api_key', 'clear_ai_api_key']) add(settings, id, 'input');
  ids.get('ai_api_key').type = 'password';
  add(settings, 'tg_chat_id', 'input'); add(settings, 'collector-name'); add(settings, 'collector-hint');
  ['btn-detect-collector', 'btn-save', 'btn-test-collector', 'btn-test-tg', 'btn-test-ai', 'pw-toggle'].forEach((id) => add(settings, id, 'button'));
  add(settings, 'ai-test-result', 'div', 'ai-test-result hidden');
  const pwForm = add(settings, 'pw-form', 'div', 'hidden');
  ['old_pw', 'new_pw', 'new_pw2'].forEach((id) => { const input = add(pwForm, id, 'input'); input.type = 'password'; });
  add(pwForm, 'btn-chpw', 'button');
  return { document, ids };
}

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return data; } };
}

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function loadApp(handler, options = {}) {
  const { document, ids } = buildDocument();
  const requests = [];
  class FakeEventSource {
    static CLOSED = 2;
    static instances = [];
    constructor(url) { this.url = url; this.readyState = 1; this.listeners = {}; FakeEventSource.instances.push(this); }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    close() { this.readyState = FakeEventSource.CLOSED; }
  }
  const timers = new Map(), timerDelays = new Map(); let timerId = 0;
  const clock = {
    wall: Date.UTC(2026, 9, 24), monotonic: 0,
    advance(ms) { this.wall += ms; this.monotonic += ms; },
  };
  class BrowserDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.wall])); }
    static now() { return clock.wall; }
  }
  const location = { reloads: 0, reload() { this.reloads++; } };
  const EventSourceImpl = options.EventSource || FakeEventSource;
  const context = {
    document,
    location,
    EventSource: EventSourceImpl,
    AbortController,
    Date: BrowserDate,
    performance: options.withoutPerformance ? undefined : { now: () => clock.monotonic },
    localStorage: { getItem() { return null; }, setItem() {} },
    getComputedStyle: () => ({ getPropertyValue: () => 'disc', webkitTextSecurity: 'disc' }),
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, fn); timerDelays.set(id, delay); return id; },
    clearTimeout(id) { timers.delete(id); timerDelays.delete(id); },
    setInterval() { return ++timerId; },
    clearInterval() {},
    fetch: async (url, opts = {}) => { requests.push({ url, opts }); return handler(url, opts, requests); },
    CSS: { escape: (value) => String(value) },
    console,
    addEventListener() {},
  };
  context.window = context;
  vm.runInNewContext(APP_SOURCE, context, { filename: 'public/app.js' });
  await settle();
  return { context, document, ids, requests, EventSource: EventSourceImpl, timers, timerDelays, clock };
}

const baseConfig = (revision = 10, overrides = {}) => ({
  tg_chat_id: '', accounts: [], collector: { name: 'twscrape', fixed: true },
  ai_translation_enabled: false, ai_base_url: 'https://api.openai.com/v1', ai_model: '',
  configRevision: revision,
  secrets: { hasAuthToken: true, hasCt0: true, hasTgBotToken: true, hasAiApiKey: false },
  ...overrides,
});

test('restricted runtime policy stays visible and disables collection and delivery controls', async () => {
  const app = await loadApp(async (url) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') return response(baseConfig());
    throw new Error(`unexpected request: ${url}`);
  });
  const stream = app.EventSource.instances.at(-1);
  stream.listeners.status({ data: JSON.stringify({
    running: true, paused: false, accounts: {},
    runtime: { mode: 'development', collectionEnabled: false, deliveryEnabled: false },
  }) });
  assert.equal(app.ids.get('live-text').textContent, '开发预览');
  assert.match(app.ids.get('runtime-notice').textContent, /采集.*发送已关闭/);
  assert.equal(app.ids.get('runtime-notice').classList.contains('hidden'), false);
  assert.equal(app.ids.get('btn-test-collector').disabled, true);
  assert.equal(app.ids.get('btn-test-tg').disabled, true);
  assert.equal(app.ids.get('btn-pause').classList.contains('hidden'), true);
  assert.equal(app.ids.get('btn-resume').classList.contains('hidden'), true);
  await app.ids.get('btn-test-collector').onclick();
  await app.ids.get('btn-test-tg').onclick();
  assert.equal(app.requests.some((request) => request.url.startsWith('api/test/')), false);
  stream.listeners.status({ data: JSON.stringify({
    running: false, paused: false, accounts: {},
    runtime: { mode: 'read-only', collectionEnabled: true, deliveryEnabled: false },
  }) });
  assert.match(app.ids.get('runtime-notice').textContent, /只读验证.*自动监控.*发送已关闭/);
  assert.equal(app.ids.get('runtime-notice').classList.contains('hidden'), false);
  assert.equal(app.ids.get('btn-test-collector').disabled, false);
  assert.equal(app.ids.get('btn-test-tg').disabled, true);
  assert.equal(app.ids.get('btn-pause').classList.contains('hidden'), true);
  assert.equal(app.ids.get('btn-resume').classList.contains('hidden'), true);
  assert.equal(app.ids.get('live-text').textContent, '只读验证');
  stream.listeners.status({ data: JSON.stringify({
    running: true, paused: false, accounts: {},
    runtime: { mode: 'live', collectionEnabled: true, deliveryEnabled: true },
  }) });
  assert.equal(app.ids.get('runtime-notice').textContent, '');
  assert.equal(app.ids.get('runtime-notice').classList.contains('hidden'), true);
  assert.equal(app.ids.get('btn-test-collector').disabled, false);
  assert.equal(app.ids.get('btn-test-tg').disabled, false);
  assert.equal(app.ids.get('live-text').textContent, '运行中');
  assert.equal(app.ids.get('collector-name').textContent, 'twscrape');
});

test('failed controls show the stopped state and keep retry controls available only in live mode', async () => {
  const runtime = { mode: 'live', collectionEnabled: true, deliveryEnabled: true };
  let attempts = 0;
  const app = await loadApp(async (url) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') return response(baseConfig(10, { runtime }));
    if (url === 'api/control') {
      attempts++;
      return attempts === 1 ? response({ ok: false, paused: true, controlPending: true, error: '存储失败，监控保持停止' }, 500)
        : response({ ok: true, paused: true, runtime });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  const stream = app.EventSource.instances.at(-1);
  stream.listeners.status({ data: JSON.stringify({ running: true, paused: false, accounts: {}, runtime }) });
  assert.equal(app.ids.get('runtime-notice').classList.contains('hidden'), true);
  await app.ids.get('btn-pause').onclick();
  assert.equal(app.ids.get('live-text').textContent, '已停止，等待确认');
  assert.match(app.ids.get('runtime-notice').textContent, /请重试暂停或恢复/);
  assert.equal(app.ids.get('runtime-notice').classList.contains('hidden'), false);
  assert.equal(app.ids.get('btn-pause').classList.contains('hidden'), false);
  assert.equal(app.ids.get('btn-resume').classList.contains('hidden'), false);
  assert.equal(app.ids.get('btn-pause').disabled, false);
  assert.equal(app.ids.get('btn-resume').disabled, false);
  stream.listeners.status({ data: JSON.stringify({ running: false, paused: true, controlPending: true, accounts: {}, runtime }) });
  await app.ids.get('btn-pause').onclick();
  assert.equal(attempts, 2);
  assert.equal(app.ids.get('live-text').textContent, '已暂停');
  assert.equal(app.ids.get('runtime-notice').textContent, '');
  assert.equal(app.ids.get('runtime-notice').classList.contains('hidden'), true);
  assert.equal(app.ids.get('btn-pause').classList.contains('hidden'), true);
  assert.equal(app.ids.get('btn-resume').classList.contains('hidden'), false);
  stream.listeners.status({ data: JSON.stringify({ running: false, paused: true, controlPending: true, accounts: {},
    runtime: { mode: 'read-only', collectionEnabled: true, deliveryEnabled: false } }) });
  assert.equal(app.ids.get('live-text').textContent, '只读验证');
  assert.equal(app.ids.get('btn-pause').classList.contains('hidden'), true);
  assert.equal(app.ids.get('btn-resume').classList.contains('hidden'), true);
});

test('CSRF submission supports relative paths and prefers secure host-only cookies', async () => {
  const app = await loadApp(async (url) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') return response(baseConfig());
    if (url === 'api/control') return response({ ok: true, paused: true });
    throw new Error(`unexpected request: ${url}`);
  });
  for (const [cookie, expected, base] of [
    ['other=value; tw_csrf=local%2Dcsrf', 'local-csrf', 'http://localhost:8788/panel/'],
    ['tw_csrf=stale-local; __Host-tw_csrf=host%2Dcsrf', 'host-csrf', 'https://panel.example/'],
    ['__Host-tw_csrf=rotated-csrf; tw_csrf=stale-local', 'rotated-csrf', 'https://panel.example/'],
    ['__Host-tw_csrf=; tw_csrf=local-csrf', 'local-csrf', 'http://localhost:8788/'],
  ]) {
    app.document.cookie = cookie;
    await app.ids.get('btn-pause').onclick();
    const request = app.requests.at(-1);
    assert.equal(request.url, 'api/control', 'relative API paths preserve an optional proxy mount');
    assert.equal(new URL(request.url, base).href, `${base}api/control`);
    assert.equal(request.opts.method, 'POST');
    assert.equal(request.opts.credentials, 'same-origin');
    assert.equal(request.opts.headers['x-csrf'], expected);
  }
  for (const request of app.requests.filter((item) => item.opts.method === 'GET')) {
    assert.equal(request.opts.headers['x-csrf'], undefined);
  }
});

test('same-content remote revision preserves a local draft and advances its save base', async () => {
  let config = baseConfig(10);
  let posted = null;
  const app = await loadApp(async (url, opts) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config' && (!opts.method || opts.method === 'GET')) return response(config);
    if (url === 'api/config' && opts.method === 'POST') {
      posted = JSON.parse(opts.body);
      config = baseConfig(12, { tg_chat_id: posted.tg_chat_id });
      return response({ ok: true, warnings: [] });
    }
    throw new Error(`unexpected request: ${opts.method || 'GET'} ${url}`);
  });

  await app.ids.get('btn-save').onclick();
  assert.equal(posted, null, 'unchanged settings must not create a new revision');

  app.ids.get('btn-settings').onclick();
  app.ids.get('tg_chat_id').value = '333';
  for (const fn of app.ids.get('settings').listeners.input) fn({ target: app.ids.get('tg_chat_id') });

  config = baseConfig(11); // another tab performed a no-op save
  app.EventSource.instances[0].listeners.status({ data: JSON.stringify({ running: true, accounts: {}, configRevision: 11 }) });
  await settle();
  assert.equal(app.ids.get('tg_chat_id').value, '333');

  await app.ids.get('btn-save').onclick();
  assert.equal(posted.config_revision, 11);
  assert.equal(posted.tg_chat_id, '333');
});

test('an SSE revision received during save is reloaded after the save completes', async () => {
  let getCount = 0;
  let resolveStaleGet;
  let staleGetStartedResolve;
  const staleGetStarted = new Promise((resolve) => { staleGetStartedResolve = resolve; });
  const staleGet = new Promise((resolve) => { resolveStaleGet = resolve; });
  const app = await loadApp(async (url, opts) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config' && (!opts.method || opts.method === 'GET')) {
      getCount++;
      if (getCount === 1) return response(baseConfig(10));
      if (getCount === 2) { staleGetStartedResolve(); return staleGet; }
      return response(baseConfig(12, { tg_chat_id: '222' }));
    }
    if (url === 'api/config' && opts.method === 'POST') return response({ ok: true, warnings: [] });
    throw new Error(`unexpected request: ${opts.method || 'GET'} ${url}`);
  });

  app.ids.get('btn-settings').onclick();
  app.ids.get('tg_chat_id').value = '111';
  for (const fn of app.ids.get('settings').listeners.input) fn({ target: app.ids.get('tg_chat_id') });
  const saving = app.ids.get('btn-save').onclick();
  await staleGetStarted;
  app.EventSource.instances[0].listeners.status({
    data: JSON.stringify({ running: true, accounts: {}, configRevision: 12 }),
  });
  resolveStaleGet(response(baseConfig(11, { tg_chat_id: '111' })));
  await saving;
  await settle();
  assert.equal(getCount, 3);
  assert.equal(app.ids.get('tg_chat_id').value, '222');
});

test('a late save conflict reloads remote config after the settings drawer was closed', async () => {
  let saveStartedResolve;
  let getCount = 0;
  const saveStarted = new Promise((resolve) => { saveStartedResolve = resolve; });
  let finishSave;
  const pendingSave = new Promise((resolve) => { finishSave = resolve; });
  const app = await loadApp(async (url, opts) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config' && (!opts.method || opts.method === 'GET')) {
      getCount++;
      return getCount === 1
        ? response(baseConfig(10))
        : response(baseConfig(11, { tg_chat_id: '222' }));
    }
    if (url === 'api/config' && opts.method === 'POST') {
      saveStartedResolve();
      return pendingSave;
    }
    throw new Error(`unexpected request: ${opts.method || 'GET'} ${url}`);
  });

  app.ids.get('btn-settings').onclick();
  app.ids.get('tg_chat_id').value = '111';
  for (const listener of app.ids.get('settings').listeners.input || []) {
    listener({ target: app.ids.get('tg_chat_id') });
  }
  const saving = app.ids.get('btn-save').onclick();
  await saveStarted;
  app.ids.get('settings-close').onclick();
  finishSave(response({ ok: false, error: '配置已被其他页面修改' }, 409));
  await saving;
  await settle();

  assert.equal(getCount, 2);
  assert.equal(app.ids.get('tg_chat_id').value, '222');
});

test('a synchronous EventSource construction failure leaves a usable panel and schedules reconnect', async () => {
  class BrokenEventSource {
    static CLOSED = 2;
    constructor() { throw new Error('EventSource unavailable'); }
  }
  const app = await loadApp(async (url) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') return response(baseConfig());
    throw new Error(`unexpected request: ${url}`);
  }, { EventSource: BrokenEventSource });
  assert.equal(app.ids.get('auth').classList.contains('hidden'), true);
  assert.equal(app.ids.get('dash').classList.contains('hidden'), false);
  assert.deepEqual([...app.timerDelays.values()].sort((a, b) => a - b), [1000, 5000]);
});

test('a late collector detection result cannot overwrite a reopened form or its configuration', async () => {
  let resolveDetection;
  const pendingDetection = new Promise((resolve) => { resolveDetection = resolve; });
  const app = await loadApp(async (url, opts) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') return response(baseConfig());
    if (url === 'api/detect-collector' && opts.method === 'POST') return pendingDetection;
    throw new Error(`unexpected request: ${opts.method || 'GET'} ${url}`);
  });
  app.ids.get('btn-settings').onclick();
  const detecting = app.ids.get('btn-detect-collector').onclick();
  app.ids.get('settings-close').onclick();
  app.ids.get('btn-settings').onclick();
  app.ids.get('tg_chat_id').value = '444';
  for (const fn of app.ids.get('settings').listeners.input) fn({ target: app.ids.get('tg_chat_id') });
  resolveDetection(response({ found: true, version: '1.0.0' }));
  await detecting;
  assert.equal(app.ids.get('tg_chat_id').value, '444');
});

test('configuration tests do not perform a no-op save', async () => {
  const app = await loadApp(async (url) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') return response(baseConfig(10, { runtime: { mode: 'read-only', collectionEnabled: true, deliveryEnabled: false } }));
    if (url === 'api/test/collector') return response({ ok: true, message: 'ok' });
    throw new Error(`unexpected request: ${url}`);
  });
  await app.ids.get('btn-test-collector').onclick();
  assert.equal(app.requests.filter((r) => r.url === 'api/config' && r.opts.method === 'POST').length, 0);
  assert.equal(app.requests.filter((r) => r.url === 'api/test/collector').length, 1);
});

test('clearing a saved account preserves the draft and blocks save and both configuration tests', async () => {
  const runtime = { mode: 'live', collectionEnabled: true, deliveryEnabled: true };
  const app = await loadApp(async (url, opts) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config' && opts.method === 'GET') return response(baseConfig(10, {
      runtime, accounts: [{ username: 'alice', fetch_count: 10, check_interval: 300 }],
    }));
    throw new Error(`unexpected request: ${url}`);
  });
  const row = app.ids.get('acct-list').children[0];
  const name = row.querySelector('.col-name');
  name.value = '  ';
  app.ids.get('auth_token').value = 'synthetic-unsaved-secret';
  for (const fn of app.ids.get('settings').listeners.input) fn({ target: name });
  for (const button of ['btn-save', 'btn-test-collector', 'btn-test-tg']) {
    await app.ids.get(button).onclick();
    assert.match(app.ids.get('toast').textContent, /用户名不能为空/);
    assert.equal(name.value, '  ');
    assert.equal(row.parentNode, app.ids.get('acct-list'));
    assert.equal(app.ids.get('auth_token').value, 'synthetic-unsaved-secret');
  }
  assert.equal(app.requests.filter((r) => r.opts.method === 'POST').length, 0);
});

test('a rejected account autosave never starts collection or Telegram and preserves an editable draft', async () => {
  const runtime = { mode: 'live', collectionEnabled: true, deliveryEnabled: true };
  let config = baseConfig(10, { runtime, accounts: [{ username: 'alice', fetch_count: 10, check_interval: 300 }] });
  let saves = 0;
  const app = await loadApp(async (url, opts) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') {
      if (opts.method === 'POST') {
        saves++;
        const body = JSON.parse(opts.body);
        if (body.accounts[0].username === 'alice!') return response({ ok: false, error: '账号列表无效；配置未保存' }, 400);
        config = baseConfig(11, { runtime, accounts: body.accounts });
        return response({ ok: true, warnings: [] });
      }
      return response(config);
    }
    throw new Error(`unexpected request: ${url}`);
  });
  const name = app.ids.get('acct-list').children[0].querySelector('.col-name');
  name.value = 'alice!';
  app.ids.get('auth_token').value = 'synthetic-unsaved-secret';
  for (const fn of app.ids.get('settings').listeners.input) fn({ target: name });
  for (const button of ['btn-test-collector', 'btn-test-tg']) {
    await app.ids.get(button).onclick();
    assert.match(app.ids.get('toast').textContent, /配置未保存/);
    assert.equal(name.value, 'alice!');
    assert.equal(app.ids.get('auth_token').value, 'synthetic-unsaved-secret');
    assert.equal(app.ids.get('btn-save').disabled, false);
  }
  assert.equal(saves, 2);
  assert.equal(app.requests.some((r) => r.url.startsWith('api/test/')), false);
  name.value = 'alice';
  for (const fn of app.ids.get('settings').listeners.input) fn({ target: name });
  await app.ids.get('btn-save').onclick();
  assert.equal(saves, 3);
  assert.equal(app.ids.get('auth_token').value, '');
});

test('new empty account placeholders are ignored while an explicit delete removes a saved row', async () => {
  let config = baseConfig(10, { accounts: [{ username: 'alice', fetch_count: 10, check_interval: 300 }] });
  const submitted = [];
  const app = await loadApp(async (url, opts) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') {
      if (opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        submitted.push(body.accounts);
        config = baseConfig(config.configRevision + 1, { accounts: body.accounts });
        return response({ ok: true, warnings: [] });
      }
      return response(config);
    }
    throw new Error(`unexpected request: ${url}`);
  });
  app.ids.get('btn-add-acct').onclick();
  await app.ids.get('btn-save').onclick();
  assert.deepEqual(submitted[0], [{ username: 'alice', fetch_count: 10, check_interval: 300 }]);
  const row = app.ids.get('acct-list').children[0];
  assert.match(row.querySelector('.btn-x').attributes['aria-label'], /待发送消息/);
  row.querySelector('.btn-x').onclick();
  await app.ids.get('btn-save').onclick();
  assert.deepEqual(submitted[1], []);
});

test('successful first setup falls back to login mode if panel loading fails', async () => {
  const app = await loadApp(async (url) => {
    if (url === 'api/session') return response({ hasPassword: false, authed: false });
    if (url === 'api/setup') return response({ ok: true });
    if (url === 'api/config') throw new Error('configuration unavailable');
    throw new Error(`unexpected request: ${url}`);
  });
  app.ids.get('auth-pw').value = 'password1';
  app.ids.get('auth-pw2').value = 'password1';
  app.ids.get('auth-setup-token').value = 'a'.repeat(48);
  const submit = app.ids.get('auth-form').listeners.submit[0];
  await submit({ preventDefault() {} });
  assert.equal(app.ids.get('auth-label').textContent, '密码');
  assert.equal(app.ids.get('auth-pw2-wrap').classList.contains('hidden'), true);
  assert.equal(app.ids.get('auth-msg').textContent, 'configuration unavailable');
  assert.equal(app.ids.get('auth-msg').classList.contains('hidden'), false);
});

test('password confirmation blocks typos before any password request', async () => {
  const app = await loadApp(async (url) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') return response(baseConfig());
    if (url === 'api/password') throw new Error('password endpoint should not be called');
    throw new Error(`unexpected request: ${url}`);
  });
  app.ids.get('pw-toggle').onclick();
  app.ids.get('old_pw').value = 'old-password';
  app.ids.get('new_pw').value = 'new-password';
  app.ids.get('new_pw2').value = 'different-password';
  await app.ids.get('btn-chpw').onclick();
  assert.equal(app.requests.filter((r) => r.url === 'api/password').length, 0);
  assert.equal(app.ids.get('toast').textContent, '两次新密码不一致');
});

test('logout network failure does not pretend success by reloading', async () => {
  const app = await loadApp(async (url) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') return response(baseConfig());
    if (url === 'api/logout') throw new Error('network unavailable');
    throw new Error(`unexpected request: ${url}`);
  });
  await app.ids.get('logout').onclick();
  assert.equal(app.context.location.reloads, 0);
  assert.equal(app.ids.get('logout').disabled, false);
  assert.equal(app.ids.get('toast').textContent, '登出失败：network unavailable');
});

async function runPollTimer(app) {
  const entry = [...app.timerDelays].find(([, delay]) => delay === 5000);
  assert.ok(entry, 'a polling retry is scheduled');
  const [id] = entry;
  const callback = app.timers.get(id);
  app.timers.delete(id); app.timerDelays.delete(id);
  app.clock.advance(5000);
  callback();
  await settle();
}

const snapshot = (pushesToday, extra = {}) => ({
  status: { accounts: {}, running: false, pushesToday, ...extra },
  paused: false,
  runtime: { mode: 'read-only', collectionEnabled: true, deliveryEnabled: false },
});

test('HTTP snapshots show status and bounded deduplicated logs without SSE or overwriting a settings draft', async () => {
  let pushes = 3, revision = 10;
  let config = baseConfig();
  const logs = Array.from({ length: 200 }, (_, i) => ({ id: `log-${i}`, t: '2026-10-23T10:00:00Z', msg: `event ${i}` }));
  const app = await loadApp(async (url) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') return response(config);
    if (url === 'api/status') return response(snapshot(pushes, { configRevision: revision }));
    if (url === 'api/logs') return response({ logs });
    throw new Error(`unexpected request: ${url}`);
  });
  assert.equal(app.ids.get('stat-pushes').textContent, '3');
  assert.equal(app.ids.get('live-text').textContent, '只读验证');
  assert.equal(app.ids.get('feed').children.length, 60);
  assert.match(app.ids.get('feed').firstChild.textContent, /event 199/);
  app.ids.get('btn-settings').onclick();
  app.ids.get('tg_chat_id').value = 'unsaved draft';
  for (const fn of app.ids.get('settings').listeners.input) fn({ target: app.ids.get('tg_chat_id') });
  pushes = 4;
  revision = 11;
  config = baseConfig(revision, { tg_chat_id: 'remote change' });
  await runPollTimer(app);
  assert.equal(app.ids.get('stat-pushes').textContent, '4');
  assert.equal(app.ids.get('tg_chat_id').value, 'unsaved draft');
  assert.equal(app.requests.filter((r) => r.url === 'api/config').length, 2);
  assert.match(app.ids.get('toast').textContent, /其他标签页已更新配置.*未保存内容已保留/);
  assert.equal(app.ids.get('feed').children.length, 60);
  assert.match(app.ids.get('feed').firstChild.textContent, /event 199/);
});

test('HTTP polling synchronizes a remote configuration revision when there is no local draft', async () => {
  let config = baseConfig(10);
  const app = await loadApp(async (url) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') return response(config);
    if (url === 'api/status') return response(snapshot(0, { configRevision: config.configRevision }));
    if (url === 'api/logs') return response({ logs: [] });
    throw new Error(`unexpected request: ${url}`);
  });
  config = baseConfig(11, { tg_chat_id: 'remote channel' });
  await runPollTimer(app);
  assert.equal(app.ids.get('tg_chat_id').value, 'remote channel');
  assert.equal(app.requests.filter((r) => r.url === 'api/config').length, 2);
  await runPollTimer(app);
  assert.equal(app.requests.filter((r) => r.url === 'api/config').length, 2, 'matching revisions must not reload configuration');
});

test('a configuration refresh started by polling cannot overwrite a newer login', async () => {
  let configReads = 0, statusReads = 0, resolveOldConfig;
  const oldConfig = new Promise((resolve) => { resolveOldConfig = resolve; });
  const app = await loadApp(async (url) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') {
      configReads++;
      if (configReads === 2) return oldConfig;
      return response(baseConfig(configReads === 1 ? 10 : 20, { tg_chat_id: configReads === 1 ? 'first session' : 'new session' }));
    }
    if (url === 'api/status') return response(snapshot(0, { configRevision: ++statusReads === 1 ? 11 : 20 }));
    if (url === 'api/logs') return response({ logs: [] });
    if (url === 'api/logout' || url === 'api/login') return response({ ok: true });
    throw new Error(`unexpected request: ${url}`);
  });
  assert.equal(configReads, 2);
  await app.ids.get('logout').onclick();
  app.ids.get('auth-pw').value = 'new-session-password';
  await app.ids.get('auth-form').listeners.submit[0]({ preventDefault() {} });
  await settle();
  assert.equal(app.ids.get('tg_chat_id').value, 'new session');
  resolveOldConfig(response(baseConfig(11, { tg_chat_id: 'stale old session' })));
  await settle();
  assert.equal(app.ids.get('tg_chat_id').value, 'new session');
  assert.equal(app.context.location.reloads, 1);
  assert.doesNotMatch(app.ids.get('toast').textContent, /配置刷新失败/);
});

test('SSE supersedes an in-flight snapshot and polling resumes only after the stream fails', async () => {
  let resolveStatus, reads = 0;
  const pendingStatus = new Promise((resolve) => { resolveStatus = resolve; });
  const app = await loadApp(async (url) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') return response(baseConfig());
    if (url === 'api/status') return ++reads === 1 ? pendingStatus : response(snapshot(12));
    if (url === 'api/logs') return response({ logs: [] });
    throw new Error(`unexpected request: ${url}`);
  });
  const stream = app.EventSource.instances[0];
  stream.listeners.status({ data: JSON.stringify(snapshot(9).status) });
  resolveStatus(response(snapshot(1)));
  await settle();
  assert.equal(app.ids.get('stat-pushes').textContent, '9');
  await runPollTimer(app);
  assert.equal(reads, 1, 'healthy SSE suppresses HTTP snapshot requests');
  await stream.onerror();
  await runPollTimer(app);
  assert.equal(reads, 2);
  assert.equal(app.ids.get('stat-pushes').textContent, '12');
});

test('repeated SSE failures cannot start overlapping HTTP polls', async () => {
  let resolveStatus;
  const pendingStatus = new Promise((resolve) => { resolveStatus = resolve; });
  const app = await loadApp(async (url) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') return response(baseConfig());
    if (url === 'api/status') return pendingStatus;
    if (url === 'api/logs') return response({ logs: [] });
    throw new Error(`unexpected request: ${url}`);
  });
  const stream = app.EventSource.instances[0];
  await stream.onerror(); await stream.onerror();
  await runPollTimer(app);
  assert.equal(app.requests.filter((r) => r.url === 'api/status').length, 1);
  assert.equal(app.requests.filter((r) => r.url === 'api/logs').length, 1);
  resolveStatus(response(snapshot(6)));
  await settle();
  assert.equal(app.ids.get('stat-pushes').textContent, '6');
  assert.equal([...app.timerDelays.values()].filter((delay) => delay === 5000).length, 1);
});

test('an opened stream without a status frame keeps polling and a ten-second HTTP timeout allows retry', async () => {
  let reads = 0;
  const app = await loadApp(async (url, opts) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') return response(baseConfig());
    if (url === 'api/status') {
      if (++reads > 1) return response(snapshot(8));
      return new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
      });
    }
    if (url === 'api/logs') return response({ logs: [] });
    throw new Error(`unexpected request: ${url}`);
  });
  app.EventSource.instances[0].onopen();
  const [timeoutId] = [...app.timerDelays].find(([, delay]) => delay === 10000);
  const timeout = app.timers.get(timeoutId);
  app.timers.delete(timeoutId); app.timerDelays.delete(timeoutId);
  timeout();
  await settle();
  assert.equal(app.requests.find((r) => r.url === 'api/status').opts.signal.aborted, true);
  await runPollTimer(app);
  assert.equal(reads, 2, 'onopen alone must not mark the event stream healthy');
  assert.equal(app.ids.get('stat-pushes').textContent, '8');
});

test('a polling 401 stops timers and SSE, aborts remaining requests, and returns to login once', async () => {
  let resolveLogs;
  const pendingLogs = new Promise((resolve) => { resolveLogs = resolve; });
  const app = await loadApp(async (url) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') return response(baseConfig());
    if (url === 'api/status') return response({ error: '未登录' }, 401);
    if (url === 'api/logs') return pendingLogs;
    throw new Error(`unexpected request: ${url}`);
  });
  assert.equal(app.context.location.reloads, 1);
  assert.equal(app.EventSource.instances[0].readyState, app.EventSource.CLOSED);
  assert.equal([...app.timerDelays.values()].includes(5000), false);
  assert.equal(app.requests.find((r) => r.url === 'api/logs').opts.signal.aborted, true);
  resolveLogs(response({ logs: [{ id: 'late', t: '2026-10-23T10:00:00Z', msg: 'old session' }] }));
  await settle();
  assert.equal(app.ids.get('feed').children.length, 0);
  assert.equal(app.context.location.reloads, 1);
});

test('logout cancels polls and late responses from the old session cannot affect a new login', async () => {
  let resolveOldStatus, reads = 0;
  const oldStatus = new Promise((resolve) => { resolveOldStatus = resolve; });
  const app = await loadApp(async (url) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') return response(baseConfig());
    if (url === 'api/status') return ++reads === 1 ? oldStatus : response(snapshot(42));
    if (url === 'api/logs') return response({ logs: [] });
    if (url === 'api/logout' || url === 'api/login') return response({ ok: true });
    throw new Error(`unexpected request: ${url}`);
  });
  const oldStream = app.EventSource.instances[0];
  await oldStream.onerror(); // a fallback timer now exists while the old request is pending
  await app.ids.get('logout').onclick();
  assert.equal(app.context.location.reloads, 1);
  assert.equal(oldStream.readyState, app.EventSource.CLOSED);
  assert.equal([...app.timerDelays.values()].includes(5000), false);
  assert.equal(app.requests.find((r) => r.url === 'api/status').opts.signal.aborted, true);
  app.ids.get('auth-pw').value = 'new-session-password';
  await app.ids.get('auth-form').listeners.submit[0]({ preventDefault() {} });
  await settle();
  assert.equal(app.ids.get('stat-pushes').textContent, '42');
  resolveOldStatus(response({ error: 'old session expired' }, 401));
  await settle();
  oldStream.listeners.status({ data: JSON.stringify(snapshot(2).status) });
  assert.equal(app.context.location.reloads, 1, 'old 401 must not expire the new session');
  assert.equal(app.ids.get('stat-pushes').textContent, '42');
});

test('a silent stream expires after its first frame, reports stale state, and resumes HTTP after clock rollback', async () => {
  const runtime = { mode: 'live', collectionEnabled: true, deliveryEnabled: true };
  let reads = 0, finishRecovery;
  const recovery = new Promise((resolve) => { finishRecovery = resolve; });
  const app = await loadApp(async (url) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') return response(baseConfig(10, { runtime }));
    if (url === 'api/status') {
      reads++;
      return reads === 1 ? response({ status: { running: true, accounts: {}, runtime } }) : recovery;
    }
    if (url === 'api/logs') return response({ logs: [] });
    throw new Error(`unexpected request: ${url}`);
  });
  app.EventSource.instances[0].listeners.status({ data: JSON.stringify({ running: true, accounts: {}, runtime, pushesToday: 9 }) });
  assert.equal(app.ids.get('live-text').textContent, '运行中');
  // Moving the wall clock backwards must not extend the monotonic freshness deadline.
  app.clock.wall -= 3600000;
  for (let i = 0; i < 5; i++) await runPollTimer(app);
  assert.equal(reads, 1, 'fresh SSE suppresses HTTP for the first 25 seconds');
  await runPollTimer(app);
  assert.equal(reads, 2, 'at 30 seconds a silent SSE connection no longer suppresses HTTP');
  assert.match(app.ids.get('live-text').textContent, /状态已过期/);
  assert.equal(app.ids.get('livepill').classList.contains('off'), true);
  finishRecovery(response({ status: { running: true, accounts: {}, runtime, pushesToday: 10 } }));
  await settle();
  assert.equal(app.ids.get('stat-pushes').textContent, '10');
  assert.equal(app.ids.get('live-text').textContent, '运行中');
  await runPollTimer(app);
  assert.equal(reads, 3, 'HTTP polling continues until the stream actually supplies another status');
});

test('HTTP failure after silent SSE shows a connection error, then new SSE supersedes the retry', async () => {
  let reads = 0, finishRetry;
  const retry = new Promise((resolve) => { finishRetry = resolve; });
  const app = await loadApp(async (url) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') return response(baseConfig());
    if (url === 'api/status') {
      reads++;
      if (reads === 2) throw new Error('network unavailable');
      if (reads === 3) return retry;
      return response(snapshot(1));
    }
    if (url === 'api/logs') return response({ logs: [] });
    throw new Error(`unexpected request: ${url}`);
  });
  const stream = app.EventSource.instances[0];
  const runtime = snapshot(0).runtime;
  stream.listeners.status({ data: JSON.stringify({ ...snapshot(5).status, runtime }) });
  app.clock.advance(25000);
  await runPollTimer(app);
  assert.equal(reads, 2);
  assert.equal(app.ids.get('live-text').textContent, '状态连接中断');
  await runPollTimer(app);
  stream.listeners.status({ data: JSON.stringify({ ...snapshot(7).status, runtime }) });
  finishRetry(response(snapshot(2)));
  await settle();
  assert.equal(app.ids.get('stat-pushes').textContent, '7');
  assert.equal(app.ids.get('live-text').textContent, '只读验证');
  await runPollTimer(app);
  assert.equal(reads, 3, 'a fresh status from the recovered stream suppresses HTTP again');
});

test('the Date fallback treats negative status age as stale', async () => {
  let reads = 0;
  const app = await loadApp(async (url) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') return response(baseConfig());
    if (url === 'api/status') { reads++; return response(snapshot(reads)); }
    if (url === 'api/logs') return response({ logs: [] });
    throw new Error(`unexpected request: ${url}`);
  }, { withoutPerformance: true });
  app.EventSource.instances[0].listeners.status({ data: JSON.stringify(snapshot(9).status) });
  app.clock.wall -= 3600000;
  await runPollTimer(app);
  assert.equal(reads, 2);
  assert.equal(app.ids.get('stat-pushes').textContent, '2');
});

test('repeated SSE errors preserve fresh HTTP status and cannot hide an HTTP failure', async () => {
  let failHttp = false;
  const app = await loadApp(async (url) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') return response(baseConfig());
    if (url === 'api/status') {
      if (failHttp) throw new Error('HTTP unavailable');
      return response(snapshot(1));
    }
    if (url === 'api/logs') return response({ logs: [] });
    throw new Error(`unexpected request: ${url}`);
  });
  const stream = app.EventSource.instances[0];
  assert.equal(app.ids.get('live-text').textContent, '只读验证');
  app.clock.advance(1000);
  await stream.onerror();
  assert.equal(app.ids.get('live-text').textContent, '只读验证', 'SSE retry failure does not invalidate fresh HTTP');
  failHttp = true;
  await runPollTimer(app);
  assert.equal(app.ids.get('live-text').textContent, '状态连接中断');
  await stream.onerror();
  assert.equal(app.ids.get('live-text').textContent, '状态连接中断', 'SSE retry cannot clear the actual HTTP failure');
  failHttp = false;
  await runPollTimer(app);
  await stream.onerror();
  assert.equal(app.ids.get('live-text').textContent, '只读验证');
  app.clock.advance(30000);
  await stream.onerror();
  assert.match(app.ids.get('live-text').textContent, /状态已过期/, 'the last successful HTTP snapshot still expires');
});

test('SSE construction failures preserve HTTP health but do not hide an expired status', async () => {
  class BrokenEventSource {
    static CLOSED = 2;
    constructor() { throw new Error('EventSource unavailable'); }
  }
  const app = await loadApp(async (url) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') return response(baseConfig());
    if (url === 'api/status') return response(snapshot(1));
    if (url === 'api/logs') return response({ logs: [] });
    throw new Error(`unexpected request: ${url}`);
  }, { EventSource: BrokenEventSource });
  async function runReconnect(delay) {
    const [id] = [...app.timerDelays].find(([, ms]) => ms === delay);
    const callback = app.timers.get(id);
    app.timers.delete(id); app.timerDelays.delete(id);
    app.clock.advance(delay);
    callback();
    await settle();
  }
  assert.equal(app.ids.get('live-text').textContent, '只读验证');
  await runReconnect(1000);
  assert.equal(app.ids.get('live-text').textContent, '只读验证');
  app.clock.advance(30000);
  await runReconnect(2000);
  assert.match(app.ids.get('live-text').textContent, /状态已过期/);
});

test('collection and Telegram tests retain independent busy state across status updates and configuration saves', async () => {
  const runtime = { mode: 'live', collectionEnabled: true, deliveryEnabled: true };
  let finishCollection, finishTelegram, config = baseConfig(10, { runtime });
  const collection = new Promise((resolve) => { finishCollection = resolve; });
  const telegram = new Promise((resolve) => { finishTelegram = resolve; });
  const app = await loadApp(async (url, opts) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') {
      if (opts.method === 'POST') {
        config = baseConfig(11, { runtime, tg_chat_id: JSON.parse(opts.body).tg_chat_id });
        return response({ ok: true, warnings: [] });
      }
      return response(config);
    }
    if (url === 'api/status') return response({ status: { running: true, accounts: {}, runtime, configRevision: config.configRevision } });
    if (url === 'api/logs') return response({ logs: [] });
    if (url === 'api/test/collector') return collection;
    if (url === 'api/test/telegram') return telegram;
    throw new Error(`unexpected request: ${url}`);
  });
  const collectButton = app.ids.get('btn-test-collector'), tgButton = app.ids.get('btn-test-tg');
  const collecting = collectButton.onclick();
  await settle();
  assert.equal(collectButton.disabled, true);
  assert.equal(tgButton.disabled, false, 'one kind of test does not block the other');
  const sending = tgButton.onclick();
  await settle();
  app.EventSource.instances[0].listeners.status({ data: JSON.stringify({ running: true, accounts: {}, runtime, configRevision: 10 }) });
  assert.equal(collectButton.disabled, true);
  assert.equal(tgButton.disabled, true);
  app.ids.get('btn-settings').onclick();
  app.ids.get('tg_chat_id').value = '123';
  for (const fn of app.ids.get('settings').listeners.input) fn({ target: app.ids.get('tg_chat_id') });
  await app.ids.get('btn-save').onclick();
  assert.equal(collectButton.disabled, true);
  assert.equal(tgButton.disabled, true, 'save/reload does not clear either test busy flag');
  await collectButton.onclick(); await tgButton.onclick();
  assert.equal(app.requests.filter((r) => r.url === 'api/test/collector').length, 1);
  assert.equal(app.requests.filter((r) => r.url === 'api/test/telegram').length, 1);
  finishCollection(response({ ok: true, message: 'collection complete' }));
  await collecting;
  assert.equal(collectButton.disabled, false);
  assert.equal(tgButton.disabled, true);
  finishTelegram(response({ ok: true, message: 'telegram complete' }));
  await sending;
  assert.equal(tgButton.disabled, false);
});

test('logout cancels a test and its late 401 cannot clear a new session test or show stale feedback', async () => {
  const runtime = { mode: 'live', collectionEnabled: true, deliveryEnabled: true };
  let testCount = 0, finishOld, finishNew;
  const oldTest = new Promise((resolve) => { finishOld = resolve; });
  const newTest = new Promise((resolve) => { finishNew = resolve; });
  const app = await loadApp(async (url) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') return response(baseConfig(10, { runtime }));
    if (url === 'api/status') return response({ status: { running: true, accounts: {}, runtime } });
    if (url === 'api/logs') return response({ logs: [] });
    if (url === 'api/test/telegram') return ++testCount === 1 ? oldTest : newTest;
    if (url === 'api/logout' || url === 'api/login') return response({ ok: true });
    throw new Error(`unexpected request: ${url}`);
  });
  const button = app.ids.get('btn-test-tg');
  const first = button.onclick(); await settle();
  const oldRequest = app.requests.find((r) => r.url === 'api/test/telegram');
  await app.ids.get('logout').onclick();
  assert.equal(oldRequest.opts.signal.aborted, true);
  app.ids.get('auth-pw').value = 'new-session-password';
  await app.ids.get('auth-form').listeners.submit[0]({ preventDefault() {} });
  const second = button.onclick(); await settle();
  finishOld(response({ error: 'old session expired' }, 401)); await first;
  assert.equal(app.context.location.reloads, 1);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, '测试中…');
  assert.doesNotMatch(app.ids.get('toast').textContent, /old session|会话/);
  finishNew(response({ ok: true, message: 'new session test complete' })); await second;
  assert.equal(button.disabled, false);
  assert.match(app.ids.get('toast').textContent, /new session test complete/);
});

test('a test waiting on an old-session draft save cannot launch collection or overwrite a new draft', async () => {
  const runtime = { mode: 'read-only', collectionEnabled: true, deliveryEnabled: false };
  let finishSave;
  const pendingSave = new Promise((resolve) => { finishSave = resolve; });
  const app = await loadApp(async (url, opts) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') return opts.method === 'POST' ? pendingSave : response(baseConfig(10, { runtime }));
    if (url === 'api/status') return response(snapshot(1));
    if (url === 'api/logs') return response({ logs: [] });
    if (url === 'api/logout' || url === 'api/login') return response({ ok: true });
    throw new Error(`unexpected request: ${url}`);
  });
  app.ids.get('btn-settings').onclick();
  app.ids.get('tg_chat_id').value = '123';
  for (const fn of app.ids.get('settings').listeners.input) fn({ target: app.ids.get('tg_chat_id') });
  const collecting = app.ids.get('btn-test-collector').onclick(); await settle();
  await app.ids.get('logout').onclick();
  app.ids.get('auth-pw').value = 'new-session-password';
  await app.ids.get('auth-form').listeners.submit[0]({ preventDefault() {} });
  app.ids.get('auth_token').value = 'synthetic new draft';
  finishSave(response({ ok: true, warnings: [] })); await collecting;
  assert.equal(app.ids.get('auth_token').value, 'synthetic new draft');
  assert.equal(app.requests.filter((r) => r.url === 'api/test/collector').length, 0);
  assert.equal(app.ids.get('btn-save').disabled, false);
  assert.doesNotMatch(app.ids.get('toast').textContent, /旧会话/);
});

test('AI settings join save payload, busy state, reload and private key clearing', async () => {
  let config = baseConfig();
  let posted, finishSave;
  const pendingSave = new Promise((resolve) => { finishSave = resolve; });
  const app = await loadApp(async (url, opts) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config' && opts.method === 'GET') return response(config);
    if (url === 'api/config' && opts.method === 'POST') {
      posted = JSON.parse(opts.body);
      config = baseConfig(11, { ai_translation_enabled: posted.ai_translation_enabled,
        ai_base_url: posted.ai_base_url, ai_model: posted.ai_model,
        secrets: { hasAuthToken: true, hasCt0: true, hasTgBotToken: true, hasAiApiKey: true } });
      return pendingSave;
    }
    if (url === 'api/logout') return response({ ok: true });
    throw new Error(`unexpected request: ${url}`);
  });
  const field = (id) => app.ids.get(id);
  app.ids.get('btn-settings').onclick();
  assert.equal(field('ai_translation_enabled').checked, false);
  assert.equal(field('ai_base_url').value, 'https://api.openai.com/v1');
  assert.equal(field('ai_api_key').type, 'password');
  field('ai_translation_enabled').checked = true;
  field('ai_base_url').value = 'https://synthetic.example.test/v1';
  field('ai_model').value = 'synthetic-model';
  field('ai_api_key').value = 'synthetic-key';
  for (const fn of field('settings').listeners.input) fn({ target: field('ai_translation_enabled') });
  const pending = field('btn-save').onclick(); await settle();
  for (const id of ['ai_translation_enabled', 'ai_base_url', 'ai_model', 'ai_api_key', 'clear_ai_api_key']) {
    assert.equal(field(id).disabled, true, id);
  }
  assert.equal(posted.ai_translation_enabled, true);
  assert.equal(posted.ai_base_url, 'https://synthetic.example.test/v1');
  assert.equal(posted.ai_model, 'synthetic-model');
  assert.equal(posted.ai_api_key, 'synthetic-key');
  assert.equal(posted.clear_ai_api_key, false);
  finishSave(response({ ok: true, warnings: [] })); await pending;
  assert.equal(field('ai_api_key').value, '');
  assert.equal(field('ai_api_key').placeholder, '••••••••••••');
  assert.equal(field('ai_translation_enabled').checked, true);
  assert.equal(field('ai_model').value, 'synthetic-model');
  assert.equal(field('ai_api_key').disabled, false);
  field('ai_api_key').value = 'synthetic-unsaved-key';
  field('clear_ai_api_key').checked = true;
  await field('logout').onclick();
  assert.equal(field('ai_api_key').value, '');
  assert.equal(field('ai_api_key').type, 'password');
  assert.equal(field('clear_ai_api_key').checked, false);
});

test('remote AI changes and a key deletion draft participate in configuration conflict protection', async () => {
  for (const caseName of ['remote-model', 'local-key-deletion']) {
    let config = baseConfig(10);
    let writes = 0;
    const app = await loadApp(async (url, opts) => {
      if (url === 'api/session') return response({ hasPassword: true, authed: true });
      if (url === 'api/config') {
        if (opts.method === 'POST') { writes++; return response({ ok: true, warnings: [] }); }
        return response(config);
      }
      throw new Error(`unexpected request: ${url}`);
    });
    app.ids.get('btn-settings').onclick();
    const draft = app.ids.get(caseName === 'remote-model' ? 'tg_chat_id' : 'clear_ai_api_key');
    draft.value = '333'; draft.checked = true;
    for (const fn of app.ids.get('settings').listeners.input) fn({ target: draft });
    config = baseConfig(11, caseName === 'remote-model' ? { ai_model: 'remote-model' } : {});
    app.EventSource.instances[0].listeners.status({ data: JSON.stringify({ running: true, accounts: {}, configRevision: 11 }) });
    await settle();
    await app.ids.get('btn-save').onclick();
    assert.equal(writes, 0, caseName);
    assert.match(app.ids.get('toast').textContent, /其他标签页/);
    app.ids.get('settings-close').onclick(); await settle();
    assert.equal(app.ids.get('ai_model').value, config.ai_model);
    assert.equal(app.ids.get('clear_ai_api_key').checked, false);
  }
});

const aiTestRuntime = { mode: 'live', collectionEnabled: true, deliveryEnabled: true, translationEnabled: true };
const aiTestConfig = (revision = 10, overrides = {}) => baseConfig(revision, {
  runtime: aiTestRuntime, ai_model: 'synthetic-model',
  secrets: { hasAuthToken: true, hasCt0: true, hasTgBotToken: true, hasAiApiKey: true }, ...overrides,
});

async function loadAiTestApp(handle, initialConfig = aiTestConfig()) {
  return loadApp(async (url, opts) => {
    const custom = await handle(url, opts);
    if (custom !== undefined) return custom;
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config' && opts.method === 'GET') return response(initialConfig);
    if (url === 'api/status') return response({ status: { running: true, accounts: {}, runtime: initialConfig.runtime, configRevision: initialConfig.configRevision } });
    if (url === 'api/logs') return response({ logs: [] });
    if (url === 'api/logout' || url === 'api/login') return response({ ok: true });
    throw new Error(`unexpected request: ${url}`);
  });
}

function editAiField(app, id, value) {
  const field = app.ids.get(id);
  if (typeof value === 'boolean') field.checked = value;
  else field.value = value;
  for (const fn of app.ids.get('settings').listeners.input) fn({ target: field });
}

test('AI hi test sends only the current draft without saving or enabling translation and renders replies as text', async () => {
  let payload;
  const app = await loadAiTestApp(async (url, opts) => {
    if (url === 'api/test/ai') { payload = JSON.parse(opts.body); return response({ ok: true, reply: '<b>Hello!</b>\nHow can I help?', elapsedMs: 13 }); }
  });
  app.ids.get('btn-settings').onclick();
  editAiField(app, 'ai_base_url', 'https://draft.example.test/v1');
  editAiField(app, 'ai_model', 'draft-model');
  editAiField(app, 'ai_api_key', 'synthetic-draft-key');
  app.ids.get('auth_token').value = 'synthetic-x-draft';
  app.ids.get('tg_chat_id').value = 'unsaved-chat';
  await app.ids.get('btn-test-ai').onclick();
  assert.deepEqual(payload, { config_revision: 10, ai_base_url: 'https://draft.example.test/v1', ai_model: 'draft-model', clear_ai_api_key: false, ai_api_key: 'synthetic-draft-key' });
  assert.equal(app.requests.filter((r) => r.url === 'api/config' && r.opts.method === 'POST').length, 0);
  assert.equal(app.ids.get('ai_translation_enabled').checked, false);
  assert.equal(app.ids.get('ai_api_key').value, 'synthetic-draft-key');
  assert.equal(app.ids.get('auth_token').value, 'synthetic-x-draft');
  assert.equal(app.ids.get('tg_chat_id').value, 'unsaved-chat');
  const result = app.ids.get('ai-test-result');
  assert.equal(result.textContent, '测试成功（13 毫秒）\nAI 回复：\n<b>Hello!</b>\nHow can I help?');
  assert.equal(result.children.length, 0, 'provider markup is never inserted into the document');
  assert.equal(result.attributes['aria-busy'], 'false');
  assert.equal(app.ids.get('btn-test-ai').disabled, false);
});

test('AI test shows structured and HTTP errors while preserving the draft and saved-key reuse intent', async () => {
  for (const status of [200, 400]) {
    let payload;
    const app = await loadAiTestApp(async (url, opts) => {
      if (url === 'api/test/ai') { payload = JSON.parse(opts.body); return response({ ok: false, code: 'ai_key_required', message: '更换 API 地址时请重新填写 API Key' }, status); }
    });
    editAiField(app, 'ai_base_url', 'https://draft.example.test/v1');
    await app.ids.get('btn-test-ai').onclick();
    assert.equal(Object.hasOwn(payload, 'ai_api_key'), false, 'a blank key asks the server to validate saved-key reuse');
    assert.match(app.ids.get('ai-test-result').textContent, /测试失败：更换 API 地址时请重新填写 API Key/);
    assert.equal(app.ids.get('ai_base_url').value, 'https://draft.example.test/v1');
    assert.equal(app.ids.get('ai_api_key').value, '');
    assert.equal(app.ids.get('btn-test-ai').disabled, false);
    assert.equal(app.requests.some((r) => r.url === 'api/config' && r.opts.method === 'POST'), false);
  }
});

test('AI tests require the process translation permission but not the translation checkbox, and reject an empty model', async () => {
  for (const runtime of [undefined,
    { mode: 'development', collectionEnabled: false, deliveryEnabled: false, translationEnabled: false },
    { mode: 'read-only', collectionEnabled: true, deliveryEnabled: false, translationEnabled: false },
    { mode: 'live', collectionEnabled: true, deliveryEnabled: true }]) {
    const app = await loadAiTestApp(async () => {}, aiTestConfig(10, { runtime }));
    assert.equal(app.ids.get('btn-test-ai').disabled, true);
    await app.ids.get('btn-test-ai').onclick();
    assert.equal(app.requests.some((r) => r.url === 'api/test/ai'), false);
  }
  const app = await loadAiTestApp(async () => {});
  assert.equal(app.ids.get('ai_translation_enabled').checked, false);
  assert.equal(app.ids.get('btn-test-ai').disabled, false);
  editAiField(app, 'ai_model', '  ');
  await app.ids.get('btn-test-ai').onclick();
  assert.match(app.ids.get('ai-test-result').textContent, /请先填写模型名称/);
  assert.equal(app.requests.some((r) => r.url === 'api/test/ai'), false);
});

test('AI tests retain independent busy state across status updates and unrelated configuration saves', async () => {
  let config = aiTestConfig(), finishTest, finishSave;
  const pendingTest = new Promise((resolve) => { finishTest = resolve; });
  const pendingSave = new Promise((resolve) => { finishSave = resolve; });
  const app = await loadAiTestApp(async (url, opts) => {
    if (url === 'api/test/ai') return pendingTest;
    if (url === 'api/config') {
      if (opts.method === 'POST') { config = aiTestConfig(11, { tg_chat_id: JSON.parse(opts.body).tg_chat_id }); return pendingSave; }
      return response(config);
    }
  });
  const button = app.ids.get('btn-test-ai');
  const testing = button.onclick(); await settle();
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, '发送中…');
  assert.equal(app.ids.get('ai-test-result').attributes['aria-busy'], 'true');
  assert.equal(app.ids.get('btn-test-collector').disabled, false);
  app.EventSource.instances[0].listeners.status({ data: JSON.stringify({ running: true, accounts: {}, runtime: aiTestRuntime, configRevision: 10 }) });
  assert.equal(button.disabled, true);
  app.ids.get('btn-settings').onclick();
  editAiField(app, 'tg_chat_id', '123');
  const saving = app.ids.get('btn-save').onclick(); await settle();
  assert.equal(button.disabled, true);
  finishSave(response({ ok: true, warnings: [] })); await saving;
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, '发送中…');
  await button.onclick();
  assert.equal(app.requests.filter((r) => r.url === 'api/test/ai').length, 1);
  finishTest(response({ ok: true, reply: 'Hello', elapsedMs: 50 })); await testing;
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, '发送 hi 测试');
});

test('editing an AI setting cancels and clears its test and ignores late responses without disturbing a new test', async () => {
  for (const [field, value] of [['ai_base_url', 'https://new.example.test/v1'], ['ai_model', 'new-model'],
    ['ai_api_key', 'synthetic-new-key'], ['clear_ai_api_key', true], ['ai_translation_enabled', true]]) {
    let count = 0, finishOld, finishNew;
    const oldTest = new Promise((resolve) => { finishOld = resolve; });
    const newTest = new Promise((resolve) => { finishNew = resolve; });
    const app = await loadAiTestApp(async (url) => { if (url === 'api/test/ai') return ++count === 1 ? oldTest : newTest; });
    const button = app.ids.get('btn-test-ai'), result = app.ids.get('ai-test-result');
    const first = button.onclick(); await settle();
    const oldRequest = app.requests.find((r) => r.url === 'api/test/ai');
    editAiField(app, field, value);
    assert.equal(oldRequest.opts.signal.aborted, true, field);
    assert.equal(result.classList.contains('hidden'), true, field);
    assert.equal(result.textContent, '', field);
    const second = button.onclick(); await settle();
    finishOld(response({ error: 'old draft expired' }, 401)); await first;
    assert.equal(app.context.location.reloads, 0, 'an aborted stale draft cannot expire the current session');
    assert.equal(button.disabled, true);
    assert.equal(button.textContent, '发送中…');
    assert.doesNotMatch(result.textContent, /old draft/);
    finishNew(response({ ok: true, reply: 'new draft reply', elapsedMs: 5 })); await second;
    assert.match(result.textContent, /new draft reply/);
    editAiField(app, field, value);
    assert.equal(result.classList.contains('hidden'), true, 'editing also clears a completed result');
  }
});

test('logout cancels the AI test and late old-session results cannot overwrite a new-session result', async () => {
  let count = 0, finishOld, finishNew;
  const oldTest = new Promise((resolve) => { finishOld = resolve; });
  const newTest = new Promise((resolve) => { finishNew = resolve; });
  const app = await loadAiTestApp(async (url) => { if (url === 'api/test/ai') return ++count === 1 ? oldTest : newTest; });
  const button = app.ids.get('btn-test-ai');
  const first = button.onclick(); await settle();
  const oldRequest = app.requests.find((r) => r.url === 'api/test/ai');
  await app.ids.get('logout').onclick();
  assert.equal(oldRequest.opts.signal.aborted, true);
  assert.equal(app.ids.get('ai-test-result').classList.contains('hidden'), true);
  app.ids.get('auth-pw').value = 'synthetic-login-password';
  await app.ids.get('auth-form').listeners.submit[0]({ preventDefault() {} });
  const second = button.onclick(); await settle();
  finishOld(response({ error: 'old session expired' }, 401)); await first;
  assert.equal(app.context.location.reloads, 1);
  assert.equal(button.disabled, true);
  finishNew(response({ ok: true, reply: 'new session reply', elapsedMs: 1 })); await second;
  assert.match(app.ids.get('ai-test-result').textContent, /new session reply/);
  assert.equal(button.disabled, false);
});

test('AI test timeout restores the button and ignores late success while a retry is pending', async () => {
  let count = 0, finishOld, finishNew;
  const oldTest = new Promise((resolve) => { finishOld = resolve; });
  const newTest = new Promise((resolve) => { finishNew = resolve; });
  const app = await loadAiTestApp(async (url) => { if (url === 'api/test/ai') return ++count === 1 ? oldTest : newTest; });
  const button = app.ids.get('btn-test-ai');
  const first = button.onclick(); await settle();
  const timeout = [...app.timerDelays].find(([, delay]) => delay === 20000);
  assert.ok(timeout);
  app.timers.get(timeout[0])();
  assert.equal(app.requests.find((r) => r.url === 'api/test/ai').opts.signal.aborted, true);
  assert.equal(button.disabled, false);
  assert.match(app.ids.get('ai-test-result').textContent, /超时/);
  const second = button.onclick(); await settle();
  finishOld(response({ ok: true, reply: 'old timed out reply' })); await first;
  assert.equal(button.disabled, true);
  assert.doesNotMatch(app.ids.get('ai-test-result').textContent, /old timed out/);
  finishNew(response({ ok: true, reply: 'retry reply', elapsedMs: 1 })); await second;
  assert.match(app.ids.get('ai-test-result').textContent, /retry reply/);
});

test('a remote configuration revision cancels an AI test even when saved-key presence is unchanged', async () => {
  let config = aiTestConfig(), finishTest;
  const pendingTest = new Promise((resolve) => { finishTest = resolve; });
  const app = await loadAiTestApp(async (url, opts) => {
    if (url === 'api/config' && opts.method === 'GET') return response(config);
    if (url === 'api/test/ai') return pendingTest;
  });
  const testing = app.ids.get('btn-test-ai').onclick(); await settle();
  const request = app.requests.find((r) => r.url === 'api/test/ai');
  config = aiTestConfig(11);
  app.EventSource.instances[0].listeners.status({ data: JSON.stringify({ running: true, accounts: {}, runtime: aiTestRuntime, configRevision: 11 }) });
  await settle();
  assert.equal(request.opts.signal.aborted, true, 'a saved key may have been rotated remotely');
  assert.equal(app.ids.get('ai-test-result').classList.contains('hidden'), true);
  finishTest(response({ ok: true, reply: 'reply from old saved key', elapsedMs: 2 })); await testing;
  assert.equal(app.ids.get('ai-test-result').textContent, '');
  assert.equal(app.ids.get('btn-test-ai').disabled, false);
});
