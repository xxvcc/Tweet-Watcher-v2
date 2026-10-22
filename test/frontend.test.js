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
  const attr = selector.match(/\[([\w-]+)(?:="([^"]*)")?\]$/);
  if (attr) {
    selector = selector.slice(0, attr.index);
    const actual = attr[1].startsWith('data-')
      ? el.dataset[attr[1].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())]
      : el.attributes[attr[1]];
    if (attr[2] === undefined ? actual === undefined : String(actual) !== attr[2]) return false;
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
  add(settings, 'tg_chat_id', 'input'); add(settings, 'bird_path', 'input'); add(settings, 'bird-hint');
  ['btn-detect-bird', 'btn-save', 'btn-test-bird', 'btn-test-tg', 'pw-toggle'].forEach((id) => add(settings, id, 'button'));
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
  const timers = new Map(); let timerId = 0;
  const location = { reloads: 0, reload() { this.reloads++; } };
  const EventSourceImpl = options.EventSource || FakeEventSource;
  const context = {
    document,
    location,
    EventSource: EventSourceImpl,
    localStorage: { getItem() { return null; }, setItem() {} },
    getComputedStyle: () => ({ getPropertyValue: () => 'disc', webkitTextSecurity: 'disc' }),
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
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
  return { context, document, ids, requests, EventSource: EventSourceImpl, timers };
}

const baseConfig = (revision = 10, overrides = {}) => ({
  bird_path: '/usr/local/bin/bird', tg_chat_id: '', accounts: [], birdOk: true,
  configRevision: revision,
  secrets: { hasAuthToken: true, hasCt0: true, hasTgBotToken: true },
  ...overrides,
});

test('runtime policy stays visible and disables collection and delivery controls', async () => {
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
  assert.equal(app.ids.get('btn-test-bird').disabled, true);
  assert.equal(app.ids.get('btn-test-tg').disabled, true);
  assert.equal(app.ids.get('btn-pause').classList.contains('hidden'), true);
  assert.equal(app.ids.get('btn-resume').classList.contains('hidden'), true);
  stream.listeners.status({ data: JSON.stringify({
    running: true, paused: false, accounts: {},
    runtime: { mode: 'legacy-live', collectionEnabled: true, deliveryEnabled: true },
  }) });
  assert.match(app.ids.get('runtime-notice').textContent, /旧版 Bird/);
  assert.equal(app.ids.get('btn-test-bird').disabled, false);
  assert.equal(app.ids.get('btn-test-tg').disabled, false);
  assert.equal(app.ids.get('live-text').textContent, '运行中');
});

test('CSRF submission supports the legacy subpath and prefers host-only cookies after migration', async () => {
  const app = await loadApp(async (url) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') return response(baseConfig());
    if (url === 'api/control') return response({ ok: true, paused: true });
    throw new Error(`unexpected request: ${url}`);
  });
  for (const [cookie, expected, base] of [
    ['other=value; tw_csrf=legacy%2Dcsrf', 'legacy-csrf', 'https://lanny.me/a/'],
    ['tw_csrf=stale-legacy; __Host-tw_csrf=host%2Dcsrf', 'host-csrf', 'https://tweet.lanny.me/'],
    ['__Host-tw_csrf=rotated-csrf; tw_csrf=stale-legacy', 'rotated-csrf', 'https://tweet.lanny.me/'],
    ['__Host-tw_csrf=; tw_csrf=local-csrf', 'local-csrf', 'http://localhost:8787/'],
  ]) {
    app.document.cookie = cookie;
    await app.ids.get('btn-pause').onclick();
    const request = app.requests.at(-1);
    assert.equal(request.url, 'api/control', 'relative API paths preserve the /a/ proxy mount');
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
      config = baseConfig(12, { bird_path: posted.bird_path });
      return response({ ok: true, warnings: [] });
    }
    throw new Error(`unexpected request: ${opts.method || 'GET'} ${url}`);
  });

  await app.ids.get('btn-save').onclick();
  assert.equal(posted, null, 'unchanged settings must not create a new revision');

  app.ids.get('btn-settings').onclick();
  app.ids.get('bird_path').value = '/opt/custom/bird';
  for (const fn of app.ids.get('settings').listeners.input) fn({ target: app.ids.get('bird_path') });

  config = baseConfig(11); // another tab performed a no-op save
  app.EventSource.instances[0].listeners.status({ data: JSON.stringify({ running: true, accounts: {}, configRevision: 11 }) });
  await settle();
  assert.equal(app.ids.get('bird_path').value, '/opt/custom/bird');

  await app.ids.get('btn-save').onclick();
  assert.equal(posted.config_revision, 11);
  assert.equal(posted.bird_path, '/opt/custom/bird');
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
      return response(baseConfig(12, { bird_path: '/remote/bird' }));
    }
    if (url === 'api/config' && opts.method === 'POST') return response({ ok: true, warnings: [] });
    throw new Error(`unexpected request: ${opts.method || 'GET'} ${url}`);
  });

  app.ids.get('btn-settings').onclick();
  app.ids.get('bird_path').value = '/local/bird';
  for (const fn of app.ids.get('settings').listeners.input) fn({ target: app.ids.get('bird_path') });
  const saving = app.ids.get('btn-save').onclick();
  await staleGetStarted;
  app.EventSource.instances[0].listeners.status({
    data: JSON.stringify({ running: true, accounts: {}, configRevision: 12 }),
  });
  resolveStaleGet(response(baseConfig(11, { bird_path: '/local/bird' })));
  await saving;
  await settle();
  assert.equal(getCount, 3);
  assert.equal(app.ids.get('bird_path').value, '/remote/bird');
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
        : response(baseConfig(11, { bird_path: '/remote/bird' }));
    }
    if (url === 'api/config' && opts.method === 'POST') {
      saveStartedResolve();
      return pendingSave;
    }
    throw new Error(`unexpected request: ${opts.method || 'GET'} ${url}`);
  });

  app.ids.get('btn-settings').onclick();
  app.ids.get('bird_path').value = '/local/bird';
  for (const listener of app.ids.get('settings').listeners.input || []) {
    listener({ target: app.ids.get('bird_path') });
  }
  const saving = app.ids.get('btn-save').onclick();
  await saveStarted;
  app.ids.get('settings-close').onclick();
  finishSave(response({ ok: false, error: '配置已被其他页面修改' }, 409));
  await saving;
  await settle();

  assert.equal(getCount, 2);
  assert.equal(app.ids.get('bird_path').value, '/remote/bird');
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
  assert.equal(app.timers.size, 1);
});

test('a late bird detection result cannot overwrite a reopened or manually edited form', async () => {
  let resolveDetection;
  const pendingDetection = new Promise((resolve) => { resolveDetection = resolve; });
  const app = await loadApp(async (url, opts) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') return response(baseConfig());
    if (url === 'api/detect-bird' && opts.method === 'POST') return pendingDetection;
    throw new Error(`unexpected request: ${opts.method || 'GET'} ${url}`);
  });
  app.ids.get('btn-settings').onclick();
  const detecting = app.ids.get('btn-detect-bird').onclick();
  app.ids.get('settings-close').onclick();
  app.ids.get('btn-settings').onclick();
  app.ids.get('bird_path').value = '/manual/path/bird';
  for (const fn of app.ids.get('settings').listeners.input) fn({ target: app.ids.get('bird_path') });
  resolveDetection(response({ found: true, path: '/detected/path/bird', version: '1.0.0' }));
  await detecting;
  assert.equal(app.ids.get('bird_path').value, '/manual/path/bird');
});

test('configuration tests do not perform a no-op save', async () => {
  const app = await loadApp(async (url) => {
    if (url === 'api/session') return response({ hasPassword: true, authed: true });
    if (url === 'api/config') return response(baseConfig());
    if (url === 'api/test/bird') return response({ ok: true, message: 'ok' });
    throw new Error(`unexpected request: ${url}`);
  });
  await app.ids.get('btn-test-bird').onclick();
  assert.equal(app.requests.filter((r) => r.url === 'api/config' && r.opts.method === 'POST').length, 0);
  assert.equal(app.requests.filter((r) => r.url === 'api/test/bird').length, 1);
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
