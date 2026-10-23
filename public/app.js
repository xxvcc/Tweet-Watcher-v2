'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const getCookie = (n) => {
    const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)'));
    if (!m) return '';
    try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; }
  };

  // ---------- 主题：深色 / 浅色 / 跟随系统 ----------
  const THEME_KEY = 'tw_theme';
  const THEME_ORDER = ['system', 'light', 'dark'];
  const THEME_ICON = { system: '🌗', light: '☀️', dark: '🌙' };
  const THEME_NAME = { system: '跟随系统', light: '浅色', dark: '深色' };
  const curTheme = () => {
    let t = null;
    try { t = localStorage.getItem(THEME_KEY); } catch (_) {}
    return THEME_ORDER.indexOf(t) > -1 ? t : 'system';
  };
  function applyTheme(t) {
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    const b = $('theme-toggle');
    if (b) { b.textContent = THEME_ICON[t]; b.title = '主题：' + THEME_NAME[t] + '（点击切换）'; }
  }
  applyTheme(curTheme());
  if ($('theme-toggle')) $('theme-toggle').onclick = () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(curTheme()) + 1) % THEME_ORDER.length];
    try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
    applyTheme(next);
  };

  // 这几个接口的 401 是业务语义（密码错误 / 未登录探测），不应触发跳转
  const KEEP_ON_401 = new Set(['api/session', 'api/login', 'api/setup']);

  async function api(method, path, body, request = {}) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (request.signal) opts.signal = request.signal;
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    if (method !== 'GET') opts.headers['x-csrf'] = getCookie('__Host-tw_csrf') || getCookie('tw_csrf');
    const res = await fetch(path, opts);
    let data = null; try { data = await res.json(); } catch (_) {}
    if (request.generation != null && (!panelActive || request.generation !== panelGeneration)) {
      throw new Error('已忽略旧会话响应');
    }
    if (res.status === 401 && !KEEP_ON_401.has(path)) {
      stopPanelUpdates();
      location.reload(); // 会话已失效：回登录页，而不是让面板停在过期数据上
      throw new Error('会话已失效，请重新登录');
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || ('HTTP ' + res.status));
      err.status = res.status;
      throw err;
    }
    return data || {};
  }

  function toast(msg, kind) {
    const t = $('toast');
    t.textContent = msg; t.className = 'msg ' + (kind || 'ok'); t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), 6000);
  }

  function relTime(ts) {
    if (!ts) return '—';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 5) return '刚刚';
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.floor(s / 60) + ' 分前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }
  function mmss(sec) {
    if (sec < 0) sec = 0;
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }
  function renderUptime(ms) {
    const box = $('stat-uptime');
    box.textContent = '';
    if (!ms) { box.textContent = '—'; return; }
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    const part = (value, unit, spaced) => {
      if (spaced) box.appendChild(document.createTextNode(' '));
      box.appendChild(document.createTextNode(String(value)));
      box.appendChild(el('small', null, unit));
    };
    if (h >= 24) { part(Math.floor(h / 24), '天'); part(h % 24, 'h', true); }
    else if (h > 0) { part(h, 'h'); part(m, 'm', true); }
    else part(m, 'm');
  }

  // ---------- 认证 ----------
  let mode = 'login';
  function showAuth(needSetup) {
    stopPanelUpdates();
    mode = needSetup ? 'setup' : 'login';
    $('dash').classList.add('hidden'); $('settings').classList.add('hidden');
    $('btn-settings').setAttribute('aria-expanded', 'false');
    document.body.classList.remove('drawer-open');
    clearPasswordForm();
    $('auth').classList.remove('hidden');
    $('auth-title').textContent = needSetup ? '设置访问密码' : 'Tweet Watcher v2';
    $('auth-sub').textContent = needSetup ? '首次使用，请设置一个密码' : '请输入密码访问';
    $('auth-label').textContent = needSetup ? '设置密码' : '密码';
    $('auth-pw').placeholder = needSetup ? '至少 8 位' : '访问密码';
    $('auth-pw').setAttribute('autocomplete', needSetup ? 'new-password' : 'current-password');
    $('auth-pw2-wrap').classList.toggle('hidden', !needSetup);
    $('auth-token-wrap').classList.toggle('hidden', !needSetup);
    $('auth-submit').textContent = needSetup ? '🔐 设置并进入' : '🔓 登录';
    $('auth-pw').value = ''; $('auth-pw2').value = ''; $('auth-setup-token').value = '';
  }
  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('auth-pw').value, m = $('auth-msg'), submit = $('auth-submit');
    const wasSetup = mode === 'setup';
    m.classList.add('hidden');
    submit.disabled = true;
    try {
      if (wasSetup) {
        if ([...pw].length < 8) throw new Error('密码至少 8 位');
        if (pw !== $('auth-pw2').value) throw new Error('两次密码不一致');
        const token = $('auth-setup-token').value.trim();
        if (!token) throw new Error('请输入首次设置令牌（见服务端日志）');
        await api('POST', 'api/setup', { password: pw, setup_token: token });
      } else {
        await api('POST', 'api/login', { password: pw });
      }
      $('auth-pw').value = ''; $('auth-pw2').value = ''; $('auth-setup-token').value = '';
      // setup 已经成功后，即使随后加载面板失败，也不能把用户留在一个永远只会返回
      // “已设置过密码”的 setup 表单里。退回登录模式后可直接重试或刷新恢复已签发会话。
      if (wasSetup) showAuth(false);
      await startPanel();
    } catch (err) { m.textContent = err.message; m.classList.remove('hidden'); }
    finally { submit.disabled = false; }
  });

  // ---------- 数据 ----------
  let es = null;
  let panelActive = false;
  let panelGeneration = 0;
  let statusData = { accounts: {}, running: false };
  let accountsCfg = [];
  let configRevision = null;
  let configReloadInFlight = false;
  let configReloadRequested = false;
  let configLoadSequence = 0;
  let configAppliedSequence = 0;
  let configSaveInFlight = false;
  let settingsDirty = false;
  let remoteConfigPending = false;
  let remoteConfigRevision = null;
  let loadedConfigSignature = null;
  const feedBuf = [];
  const feedSeen = new Set(); // 活动流去重键（防 SSE 重连回放重复）

  async function startPanel() {
    stopPanelUpdates();
    const generation = panelGeneration;
    // 配置加载成功后再切换视图；失败时登录区仍可显示错误，不会留下空白面板和未处理拒绝。
    await loadConfig();
    if (generation !== panelGeneration) return;
    panelActive = true;
    $('auth').classList.add('hidden');
    $('dash').classList.remove('hidden');
    renderAll();
    pollPanel();
    try { connectStream(); }
    catch (e) {
      $('livepill').className = 'livepill off';
      $('live-text').textContent = '实时连接不可用';
      toast('实时状态连接失败：' + e.message, 'err');
    }
  }

  // ---------- 采集程序安装状态 ----------
  let collectorOk = true;
  let collectorDetectInFlight = false;
  let settingsViewGeneration = 0;
  function collectorHintColor(h, kind) { h.style.color = kind === 'warn' ? 'var(--bad)' : kind === 'ok' ? 'var(--good)' : ''; }
  function setCollectorHint(kind, text) { const h = $('collector-hint'); if (!h) return; h.textContent = text; collectorHintColor(h, kind); }     // 动态值走 textContent（防注入）
  function setCollectorInstallHint(kind, before, after) {
    const h = $('collector-hint'); if (!h) return;
    h.textContent = before;
    h.appendChild(el('code', null, 'npm run collector:install'));
    h.appendChild(document.createTextNode(after));
    collectorHintColor(h, kind);
  }
  async function detectCollector(auto) {
    const btn = $('btn-detect-collector');
    if (collectorDetectInFlight) {
      if (!auto) toast('采集程序检查正在进行，请稍候', 'err');
      return;
    }
    const startingRevision = configRevision;
    const startingViewGeneration = settingsViewGeneration;
    let old;
    collectorDetectInFlight = true;
    if (btn) btn.disabled = true;
    if (btn && !auto) { old = btn.textContent; btn.textContent = '检测中…'; }
    try {
      const r = await api('POST', 'api/detect-collector', {});
      // 检测可能持续数十秒。期间的手工输入、保存回载或关闭抽屉都代表原上下文已失效，
      // 旧响应不得再覆盖当前路径或更新与当前配置不符的提示。
      const stale = configSaveInFlight
        || $('settings').classList.contains('hidden')
        || settingsViewGeneration !== startingViewGeneration
        || configRevision !== startingRevision;
      if (stale) {
        if (!auto) toast('检测已完成，但表单状态已变化，未更新安装状态', 'err');
        return;
      }
      if (r.found) {
        collectorOk = true;
        setCollectorHint('ok', '✅ 采集程序已就绪' + (r.version ? '（' + r.version + '）' : '') + '。');
        if (!auto) toast('✅ 采集程序已就绪', 'ok');
      } else {
        collectorOk = false;
        setCollectorInstallHint('warn', '⚠ 采集程序不完整。请管理员在应用目录运行 ', '，然后重新检查。');
        if (!auto) toast('采集程序不完整，请联系管理员修复安装', 'err');
      }
    } catch (e) { if (!auto) toast(e.message, 'err'); }
    finally {
      collectorDetectInFlight = false;
      if (btn) btn.disabled = configSaveInFlight;
      if (btn && !auto) btn.textContent = old;
    }
  }

  function configSignature(c) {
    const secrets = c && c.secrets && typeof c.secrets === 'object' ? c.secrets : {};
    return JSON.stringify({
      tg_chat_id: (c && c.tg_chat_id) || '',
      accounts: Array.isArray(c && c.accounts) ? c.accounts : [],
      secrets: {
        hasAuthToken: !!secrets.hasAuthToken,
        hasCt0: !!secrets.hasCt0,
        hasTgBotToken: !!secrets.hasTgBotToken,
      },
    });
  }
  function hasSecretDraft() {
    return ['auth_token', 'ct0', 'tg_bot_token'].some((id) => !!$(id).value);
  }
  function noteRemoteConfigConflict(revision) {
    if (!remoteConfigPending) toast('其他标签页已更新配置；当前未保存内容已保留，关闭设置后将载入新版本', 'err');
    remoteConfigPending = true;
    remoteConfigRevision = Number.isSafeInteger(revision) ? revision : null;
  }

  async function loadConfig(fromStream) {
    const generation = panelGeneration;
    const sequence = ++configLoadSequence;
    const c = await api('GET', 'api/config', undefined, fromStream ? { generation } : {});
    if (generation !== panelGeneration) return false;
    const loadedRevision = Number.isSafeInteger(c.configRevision) ? c.configRevision : null;
    const signature = configSignature(c);
    // GET 发出后用户仍可能开始编辑或保存；流同步不能在响应回来时覆盖这些新输入。
    if (fromStream && configSaveInFlight) return false;
    // 并行 GET 可能乱序完成；旧响应不得覆盖较新的表单。请求序列负责页面内的响应顺序，
    // 持久化 revision 负责标识服务端配置版本。
    if (sequence < configAppliedSequence) return false;
    configAppliedSequence = sequence;

    if (fromStream && settingsDirty) {
      // 另一个标签页即使保存了完全相同的普通配置，服务端 revision 也会递增。
      // 内容快照相同且本页没有待写密钥时，可以只推进基准 revision，保留本地草稿；
      // 密钥只返回“是否存在”，有密钥草稿时无法证明远端值未变，必须保守判冲突。
      if (signature === loadedConfigSignature && !hasSecretDraft()) {
        configRevision = loadedRevision;
        remoteConfigPending = false;
        remoteConfigRevision = null;
        return false;
      }
      noteRemoteConfigConflict(loadedRevision);
      return false;
    }

    configRevision = loadedRevision;
    loadedConfigSignature = signature;
    accountsCfg = c.accounts || [];
    $('collector-name').textContent = 'twscrape';
    if (c.runtime) { statusData.runtime = c.runtime; renderTop(); }
    $('tg_chat_id').value = c.tg_chat_id || '';
    // 远端刷新意味着本地未保存密钥已被明确放弃；不能只更新 placeholder 后把旧 value 留着，
    // 否则下一次保存会用旧密钥覆盖刚同步的新版本。
    $('auth_token').value = ''; $('ct0').value = ''; $('tg_bot_token').value = '';
    const DOTS = '••••••••••••';
    $('auth_token').placeholder = c.secrets.hasAuthToken ? DOTS : '';
    $('ct0').placeholder = c.secrets.hasCt0 ? DOTS : '';
    $('tg_bot_token').placeholder = c.secrets.hasTgBotToken ? DOTS : '';
    renderAcctRows(accountsCfg);
    ['auth_token', 'ct0', 'tg_bot_token'].forEach(refreshReveal);
    if (!collectorOk) setCollectorInstallHint('warn', '⚠ 采集程序不完整。请管理员在应用目录运行 ', '，然后重新检查。');
    else setCollectorHint('', '采集器由服务器固定部署；点击“检查安装”确认环境。');
    settingsDirty = false;
    remoteConfigPending = false;
    remoteConfigRevision = null;
    return true;
  }

  async function reloadConfigFromStream(expectedRevision) {
    // 保存期间收到的外部 revision 不能丢弃。本地保存后的 GET 可能已经拿到旧响应；
    // 把事件排队，并在保存 finally 中再核对一次服务端最终版本。
    if (configSaveInFlight) { configReloadRequested = true; return; }
    if (Number.isSafeInteger(expectedRevision) && remoteConfigPending && remoteConfigRevision === expectedRevision) return;
    configReloadRequested = true;
    if (configReloadInFlight) return;
    const generation = panelGeneration;
    configReloadInFlight = true;
    try {
      do {
        configReloadRequested = false;
        try {
          const applied = await loadConfig(true);
          if (generation !== panelGeneration) return;
          if (applied) renderAll();
          // 响应等待期间可能又收到更高 revision；即使本次因草稿保护未应用，
          // 也要再核对一次已排队的更新，不能把最后一个状态帧静默丢掉。
          if (!applied && !configReloadRequested) return;
        }
        catch (e) { if (generation === panelGeneration) toast('配置刷新失败：' + e.message, 'err'); return; }
      } while (configReloadRequested);
    }
    finally { if (generation === panelGeneration) configReloadInFlight = false; }
  }

  // ---------- 顶栏 / 指标 ----------
  function renderTop() {
    const st = statusData || {};
    const runtime = st.runtime;
    const canCollect = runtime?.collectionEnabled === true;
    const canDeliver = runtime?.deliveryEnabled === true;
    const pill = $('livepill'), txt = $('live-text');
    $('runtime-notice').textContent = !runtime ? '正在读取运行模式…'
      : !canCollect && !canDeliver ? '开发预览：X 采集与 Telegram 发送已关闭。'
      : !canDeliver ? '只读验证：可手动测试 X 采集；自动监控与 Telegram 发送已关闭。'
        : '正式运行模式：twscrape 自动采集并向 Telegram 推送新推文。';
    $('btn-test-collector').disabled = !canCollect;
    $('btn-test-tg').disabled = !canDeliver;
    pill.className = 'livepill';
    if (!canCollect) { pill.classList.add('off'); txt.textContent = runtime ? '开发预览' : '连接中…'; }
    else if (!canDeliver) { pill.classList.add('off'); txt.textContent = '只读验证'; }
    else if (!st.running) { pill.classList.add('off'); txt.textContent = '未运行'; }
    else if (st.paused) { pill.classList.add('paused'); txt.textContent = '已暂停'; }
    else { txt.textContent = '运行中'; }
    $('btn-pause').classList.toggle('hidden', !canCollect || !st.running || st.paused);
    $('btn-resume').classList.toggle('hidden', !canCollect || !st.running || !st.paused);
  }
  // 从未检查过的账号返回 null（区别于 rem=0，避免误显示"0:00 / 满格"）
  function nextCheckSec(cfgAcct) {
    const s = (statusData.accounts || {})[cfgAcct.username];
    if (!s || !s.lastCheck) return null;
    return (s.lastCheck + cfgAcct.check_interval * 1000 - Date.now()) / 1000;
  }
  function renderStats() {
    $('stat-accounts').textContent = accountsCfg.length;
    $('stat-pushes').textContent = statusData.pushesToday || 0;
    renderUptime(statusData.startedAt ? Date.now() - statusData.startedAt : 0);
    let next = Infinity;
    if (!statusData.paused && statusData.running) {
      accountsCfg.forEach((a) => { const n = nextCheckSec(a); if (n != null && n < next) next = n; });
    }
    $('stat-next').textContent = (next !== Infinity) ? mmss(next) : '—';
  }

  // ---------- 账号卡片 ----------
  function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }

  function statusOf(s) {
    if (s.checking) return { cls: 'wait', label: '检查中…' };
    if (s.ok === false) return { cls: 'err', label: '异常' };
    if (s.ok === true) return { cls: 'ok', label: '正常' };
    return { cls: 'idle', label: '等待' };
  }
  function buildBadge(cls, label) {
    const st = el('span', 'st ' + cls); st.appendChild(el('span', 'd')); st.appendChild(document.createTextNode(label));
    return st;
  }
  function buildBody(s) {
    if (s.ok === false && s.lastError) return el('div', 'errline', '⚠ ' + s.lastError);
    if (s.lastTweet && s.lastTweet.id) {
      const tw = el('div', 'tweet');
      const th = el('div', 'th'); th.appendChild(el('span', null, '最近推送')); th.appendChild(el('span', null, s.lastTweet.time || ''));
      tw.appendChild(th); tw.appendChild(document.createTextNode(s.lastTweet.text || ''));
      return tw;
    }
    return el('div', 'tweet empty', '暂无推送（自启动起无新推文）');
  }
  function buildSpark(s) {
    const spark = el('div', 'spark'); spark.title = '近期每次检查的推送量';
    const hist = Array.isArray(s.history) ? s.history.slice(-10) : [];
    const mx = Math.max(1, ...hist);
    for (let i = 0; i < 10; i++) {
      const v = hist[hist.length - 10 + i];
      const bar = el('i'); const h = (v == null) ? 0 : v;
      bar.style.height = (h > 0 ? Math.round(4 + (h / mx) * 18) : 4) + 'px';
      if (!h) bar.className = 'z';
      spark.appendChild(bar);
    }
    return spark;
  }

  function makeCard(cfgAcct) {
    const user = cfgAcct.username;
    const s = (statusData.accounts || {})[user] || {};
    const { cls, label } = statusOf(s);
    const card = el('div', 'card ' + cls); card.dataset.user = user;

    const top = el('div', 'card-top');
    const handle = el('span', 'handle'); handle.appendChild(el('span', 'at', '@')); handle.appendChild(document.createTextNode(user));
    top.appendChild(handle); top.appendChild(buildBadge(cls, label)); card.appendChild(top);

    const meta = el('div', 'meta');
    const m1 = el('span'); m1.appendChild(document.createTextNode('上次检查 ')); m1.appendChild(el('b', 'js-lastcheck', relTime(s.lastCheck)));
    const m2 = el('span'); m2.appendChild(document.createTextNode('上次推送 ')); m2.appendChild(el('b', 'js-lastpush', relTime(s.lastPushAt)));
    meta.appendChild(m1); meta.appendChild(m2); card.appendChild(meta);

    card.appendChild(buildBody(s));

    const foot = el('div', 'foot');
    foot.appendChild(buildSpark(s));
    const next = el('div', 'next');
    const lbl = el('div', 'lbl');
    lbl.appendChild(el('span', 'js-nextlbl', s.ok === false ? '下次重试' : '下次检查'));
    lbl.appendChild(el('span', 'tnum js-next', ''));
    const bar = el('div', 'bar'); const span = el('span', 'js-bar'); bar.appendChild(span);
    next.appendChild(lbl); next.appendChild(bar);
    foot.appendChild(next); card.appendChild(foot);

    updateCardTime(card, cfgAcct);
    return card;
  }

  // 原地更新已有卡片（避免每次 status 全量重建导致闪烁 / 进度条动画重置）
  function updateCard(card, cfgAcct) {
    const s = (statusData.accounts || {})[cfgAcct.username] || {};
    const { cls, label } = statusOf(s);
    card.className = 'card ' + cls;
    const oldBadge = card.querySelector('.st'); if (oldBadge) oldBadge.replaceWith(buildBadge(cls, label));
    const oldBody = card.querySelector('.tweet, .errline'); if (oldBody) oldBody.replaceWith(buildBody(s));
    const oldSpark = card.querySelector('.spark'); if (oldSpark) oldSpark.replaceWith(buildSpark(s));
    const lbl = card.querySelector('.js-nextlbl'); if (lbl) lbl.textContent = s.ok === false ? '下次重试' : '下次检查';
    updateCardTime(card, cfgAcct);
  }

  function updateCardTime(card, cfgAcct) {
    const s = (statusData.accounts || {})[cfgAcct.username] || {};
    const rem = nextCheckSec(cfgAcct);
    const nextEl = card.querySelector('.js-next'), barEl = card.querySelector('.js-bar');
    if (s.checking) { if (nextEl) nextEl.textContent = '进行中'; if (barEl) barEl.style.width = '100%'; }
    else if (!statusData.running || statusData.paused) { if (nextEl) nextEl.textContent = '—'; if (barEl) barEl.style.width = '0%'; }
    else if (rem == null) { if (nextEl) nextEl.textContent = '待检查'; if (barEl) barEl.style.width = '0%'; }
    else {
      if (nextEl) nextEl.textContent = mmss(rem);
      const prog = 1 - Math.max(0, rem) / cfgAcct.check_interval;
      if (barEl) { barEl.style.width = Math.min(100, Math.max(0, prog * 100)) + '%'; barEl.style.background = s.ok === false ? 'var(--bad)' : ''; }
    }
    const lc = card.querySelector('.js-lastcheck'); if (lc) lc.textContent = relTime(s.lastCheck);
    const lp = card.querySelector('.js-lastpush'); if (lp) lp.textContent = relTime(s.lastPushAt);
  }

  function sameUsers() {
    const cur = [].map.call($('cards').querySelectorAll('.card'), (c) => c.dataset.user);
    const want = accountsCfg.map((a) => a.username);
    return cur.length === want.length && cur.every((u, i) => u === want[i]);
  }
  function renderCards() {
    $('acct-count').textContent = accountsCfg.length;
    $('cards-empty').classList.toggle('hidden', accountsCfg.length > 0);
    const box = $('cards');
    if (sameUsers()) {
      accountsCfg.forEach((a) => { const card = box.querySelector('.card[data-user="' + (window.CSS && CSS.escape ? CSS.escape(a.username) : a.username) + '"]'); if (card) updateCard(card, a); });
    } else {
      box.textContent = '';
      accountsCfg.forEach((a) => box.appendChild(makeCard(a)));
    }
  }

  // 每秒只更新时间派生的文字/进度，不重建 DOM
  function tickTimes() {
    if ($('dash').classList.contains('hidden')) return;
    renderStats();
    [].forEach.call(document.querySelectorAll('#cards .card'), (card) => {
      const a = accountsCfg.find((x) => x.username === card.dataset.user);
      if (a) updateCardTime(card, a);
    });
  }

  // ---------- 活动流 ----------
  function classifyLog(msg) {
    if (msg.indexOf('✓') === 0 || msg.indexOf('✓ 推送') > -1) return { c: 'ok', i: '✓' };
    if (msg.indexOf('✗') === 0 || msg.indexOf('失败') > -1) return { c: 'err', i: '✗' };
    if (msg.indexOf('无新推文') > -1) return { c: 'mut', i: '○' };
    if (msg.indexOf('重试') > -1) return { c: 'mut', i: '↻' };
    return { c: 'mut', i: '◆' };
  }
  function feedLine(l) {
    const k = classifyLog(l.msg);
    const ev = el('div', 'ev ' + k.c);
    ev.appendChild(el('span', 'ico', k.i));
    const tx = el('div', 'tx');
    tx.appendChild(document.createTextNode(l.msg));
    let hhmmss = '';
    try { hhmmss = new Date(l.t).toLocaleTimeString('zh-CN', { hour12: false }); } catch (_) {}
    tx.appendChild(el('div', 't mono', hhmmss));
    ev.appendChild(tx);
    return ev;
  }
  function pushFeed(l) {
    const logKey = (line) => {
      const id = line && line.id;
      return (typeof id === 'string' || Number.isSafeInteger(id)) ? 'id:' + id : line.t + '|' + line.msg;
    };
    const key = logKey(l);
    if (feedSeen.has(key)) return; // 去重：SSE 重连回放的历史行不再重复插入
    feedSeen.add(key);
    feedBuf.push(l);
    while (feedBuf.length > 120) { const old = feedBuf.shift(); feedSeen.delete(logKey(old)); }
    const box = $('feed');
    box.insertBefore(feedLine(l), box.firstChild);
    while (box.children.length > 60) box.removeChild(box.lastChild);
  }

  function renderAll() { renderTop(); renderStats(); renderCards(); }

  // ---------- 实时更新：SSE 优先，不支持流式响应的代理使用 HTTP 轮询 ----------
  let streamRetryTimer = null;
  let streamRetryMs = 1000;
  let streamProbeInFlight = false;
  let streamHealthy = false;
  let streamVersion = 0;
  let pollTimer = null;
  let pollRequest = null;
  let pollTimeout = null;
  function stopPanelUpdates() {
    panelActive = false;
    panelGeneration++;
    streamHealthy = false;
    streamVersion++;
    configReloadInFlight = false;
    configReloadRequested = false;
    clearTimeout(pollTimer); pollTimer = null;
    clearTimeout(pollTimeout); pollTimeout = null;
    clearTimeout(streamRetryTimer); streamRetryTimer = null;
    if (pollRequest) pollRequest.abort();
    pollRequest = null;
    if (es) es.close();
    es = null;
    streamRetryMs = 1000;
  }
  function schedulePoll() {
    if (!panelActive || pollTimer) return;
    pollTimer = setTimeout(() => { pollTimer = null; pollPanel(); }, 5000);
  }
  function applyStatus(next, syncConfig) {
    if (!next || typeof next !== 'object' || Array.isArray(next)) return;
    statusData = { ...next, accounts: next.accounts || {} };
    const nextRevision = Number.isSafeInteger(statusData.configRevision) ? statusData.configRevision : null;
    if (syncConfig && configRevision != null && nextRevision != null && nextRevision !== configRevision) reloadConfigFromStream(nextRevision);
    renderAll();
  }
  async function pollPanel() {
    if (!panelActive || pollRequest) return;
    if (streamHealthy) { schedulePoll(); return; }
    const generation = panelGeneration, version = streamVersion;
    const controller = new AbortController();
    pollRequest = controller;
    pollTimeout = setTimeout(() => controller.abort(), 10000);
    const request = { generation, signal: controller.signal };
    try {
      const [snapshot, recent] = await Promise.all([
        api('GET', 'api/status', undefined, request),
        api('GET', 'api/logs', undefined, request),
      ]);
      // SSE 可能在 HTTP 请求期间恢复；旧快照不能覆盖较新的流事件或新登录会话。
      if (!panelActive || generation !== panelGeneration || version !== streamVersion || streamHealthy) return;
      if (snapshot.status) applyStatus({ ...snapshot.status, runtime: snapshot.runtime || snapshot.status.runtime, paused: snapshot.paused ?? snapshot.status.paused }, true);
      // 服务端返回 200 条，界面只保留最近 60 条；限制回放避免挤出日志去重窗口。
      if (Array.isArray(recent.logs)) recent.logs.slice(-60).forEach(pushFeed);
    } catch (_) { /* 短暂网络失败由下一轮重试；401 已停止更新并返回登录页。 */ }
    finally {
      // 某一个请求失败时也取消另一个，避免下一轮与残留 HTTP 请求重叠。
      controller.abort();
      if (pollRequest === controller) {
        pollRequest = null;
        clearTimeout(pollTimeout); pollTimeout = null;
      }
      if (panelActive && generation === panelGeneration) schedulePoll();
    }
  }
  function scheduleStreamReconnect() {
    if (!panelActive || streamRetryTimer) return;
    if (es) es.close();
    streamRetryTimer = setTimeout(() => {
      streamRetryTimer = null;
      connectStream();
    }, streamRetryMs);
    streamRetryMs = Math.min(30000, streamRetryMs * 2);
  }
  function connectStream() {
    if (!panelActive) return;
    if (es) es.close();
    streamHealthy = false;
    let source;
    try { source = new EventSource('api/stream'); }
    catch (_) {
      es = null;
      const pill = $('livepill'), txt = $('live-text');
      if (pill && txt) { pill.className = 'livepill off'; txt.textContent = '重连中'; }
      scheduleStreamReconnect();
      return;
    }
    es = source;
    source.onopen = () => {
      if (es !== source) return;
      streamRetryMs = 1000;
    };
    source.addEventListener('status', (e) => {
      if (!panelActive || es !== source) return;
      try {
        const next = JSON.parse(e.data);
        if (!next || typeof next !== 'object' || Array.isArray(next)) return;
        streamHealthy = true;
        streamVersion++;
        applyStatus(next, true);
      } catch (_) {}
    });
    source.addEventListener('log', (e) => { if (panelActive && es === source) { try { pushFeed(JSON.parse(e.data)); } catch (_) {} } });
    source.onerror = async () => {
      if (!panelActive || es !== source) return;
      streamHealthy = false;
      schedulePoll();
      const pill = $('livepill'), txt = $('live-text');
      if (pill && txt) { pill.className = 'livepill off'; txt.textContent = '重连中'; }
      // 网络断开由 EventSource 自行重连；永久关闭还可能是 SSE 满载/反代错误，不能一律刷新页面。
      if (source.readyState !== EventSource.CLOSED || streamProbeInFlight) return;
      streamProbeInFlight = true;
      let authed = null;
      try { authed = !!(await api('GET', 'api/session')).authed; } catch (_) {}
      finally { streamProbeInFlight = false; }
      if (!panelActive || es !== source) return;
      if (authed === false) { stopPanelUpdates(); location.reload(); }
      else scheduleStreamReconnect();
    };
  }

  // ---------- 设置抽屉 ----------
  let autoDetectTried = false;
  let settingsReturnFocus = null;
  function openSettings() {
    if (!$('settings').classList.contains('hidden')) return;
    settingsViewGeneration++;
    settingsReturnFocus = document.activeElement;
    $('settings').classList.remove('hidden');
    $('btn-settings').setAttribute('aria-expanded', 'true');
    document.body.classList.add('drawer-open');
    $('settings-close').focus();
    if (!collectorOk && !autoDetectTried) { autoDetectTried = true; detectCollector(true); }
  }
  function closeSettings() {
    settingsViewGeneration++;
    $('settings').classList.add('hidden');
    $('btn-settings').setAttribute('aria-expanded', 'false');
    document.body.classList.remove('drawer-open');
    clearPasswordForm();
    if (remoteConfigPending) {
      settingsDirty = false;
      remoteConfigRevision = null;
      reloadConfigFromStream();
    }
    if (settingsReturnFocus && settingsReturnFocus.isConnected && typeof settingsReturnFocus.focus === 'function') settingsReturnFocus.focus();
    settingsReturnFocus = null;
  }
  $('btn-detect-collector').onclick = () => detectCollector(false);
  $('btn-settings').onclick = openSettings;
  $('settings-close').onclick = closeSettings;
  $('settings').addEventListener('click', (e) => { if (e.target === $('settings')) closeSettings(); });
  document.addEventListener('keydown', (e) => {
    if ($('settings').classList.contains('hidden')) return;
    if (e.key === 'Escape') { closeSettings(); return; }
    if (e.key !== 'Tab') return;
    const focusable = [].filter.call($('settings').querySelectorAll('button, input'), (node) => !node.disabled && !node.closest('.hidden'));
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // 账号编辑行
  function makeAcctRow(a) {
    a = a || { username: '', fetch_count: 10, check_interval: 300 };
    const row = el('div', 'acct-row');
    const name = document.createElement('input');
    name.type = 'text'; name.className = 'col-name'; name.placeholder = 'elonmusk'; name.value = a.username || ''; name.maxLength = 16;
    name.autocomplete = 'off'; name.spellcheck = false; name.setAttribute('autocapitalize', 'off'); name.setAttribute('aria-label', '用户名'); name.setAttribute('data-role', 'name');
    const fc = document.createElement('input');
    fc.type = 'number'; fc.className = 'col-num'; fc.min = 1; fc.max = 50; fc.step = 1; fc.value = a.fetch_count || 10; fc.setAttribute('aria-label', '每次拉取条数'); fc.setAttribute('data-role', 'fc');
    const iv = document.createElement('input');
    iv.type = 'number'; iv.className = 'col-num'; iv.min = 30; iv.max = 3600; iv.step = 1; iv.value = a.check_interval || 300; iv.setAttribute('aria-label', '检查频率（秒）'); iv.setAttribute('data-role', 'iv');
    const del = document.createElement('button');
    del.className = 'btn-x col-x'; del.type = 'button'; del.textContent = '✕';
    del.setAttribute('aria-label', '删除此账号行');
    del.onclick = () => { row.remove(); settingsDirty = true; };
    row.append(name, fc, iv, del);
    return row;
  }
  function renderAcctRows(list) {
    const box = $('acct-list'); box.textContent = '';
    (list || []).forEach((a) => box.appendChild(makeAcctRow(a)));
  }
  function collectAccounts() {
    const out = [];
    $('acct-list').querySelectorAll('.acct-row').forEach((r) => {
      const u = r.querySelector('[data-role=name]').value.trim().replace(/^@/, '');
      if (!u) return;
      out.push({
        username: u,
        fetch_count: parseInt(r.querySelector('[data-role=fc]').value, 10) || 10,
        check_interval: parseInt(r.querySelector('[data-role=iv]').value, 10) || 300,
      });
    });
    return out;
  }
  $('btn-add-acct').onclick = () => {
    const r = makeAcctRow(); $('acct-list').appendChild(r); r.querySelector('input').focus(); settingsDirty = true;
  };
  $('settings').addEventListener('input', (e) => {
    if (!e.target || !e.target.matches('input')) return;
    if (e.target.closest('#acct-list') || ['tg_chat_id', 'auth_token', 'ct0', 'tg_bot_token'].includes(e.target.id)) {
      settingsDirty = true;
    }
  });

  // 密钥字段显示切换（空字段隐藏眼睛；.secret 字段用 CSS 打码 + readonly 防自动填充）
  function addReveal(id) {
    const input = $(id);
    if (!input || (input.parentNode && input.parentNode.classList.contains('pw-wrap'))) return;
    const wrap = el('div', 'pw-wrap');
    input.parentNode.insertBefore(wrap, input); wrap.appendChild(input);
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'pw-reveal'; btn.textContent = '👁'; btn.setAttribute('aria-label', '显示/隐藏');
    let isSecret = input.classList.contains('secret');
    if (isSecret) {
      input.setAttribute('readonly', '');
      const unlock = () => input.removeAttribute('readonly');
      input.addEventListener('focus', unlock); input.addEventListener('mousedown', unlock);
      // .secret 字段是 type=text + CSS 打码（避免密码管理器自动填充站点登录密码）。
      // 若 -webkit-text-security 不被支持、或样式表没加载成功，凭据就会明文显示；
      // 此时退回 type=password —— readonly-until-focus 仍在，自动填充风险远小于明文暴露。
      const cs = getComputedStyle(input);
      const masked = (cs.getPropertyValue('-webkit-text-security') || cs.webkitTextSecurity || '') === 'disc';
      if (!masked) { input.classList.remove('secret'); input.type = 'password'; isSecret = false; }
    }
    const showing = () => isSecret ? input.classList.contains('reveal') : input.type === 'text';
    const setShow = (on) => {
      if (isSecret) input.classList.toggle('reveal', on); else input.type = on ? 'text' : 'password';
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
      btn.setAttribute('aria-label', on ? '隐藏内容' : '显示内容');
    };
    const sync = () => { const has = !!input.value; btn.style.display = has ? '' : 'none'; if (!has) setShow(false); };
    btn.onclick = () => setShow(!showing());
    input.addEventListener('input', sync);
    input._revealSync = sync; wrap.appendChild(btn); sync();
  }
  ['auth_token', 'ct0', 'tg_bot_token', 'old_pw', 'new_pw', 'new_pw2'].forEach(addReveal);
  function refreshReveal(id) { const e2 = $(id); if (e2 && e2._revealSync) e2._revealSync(); }

  function collectPayload() {
    const p = { tg_chat_id: $('tg_chat_id').value.trim(), accounts: collectAccounts() };
    if (Number.isSafeInteger(configRevision)) p.config_revision = configRevision;
    const at = $('auth_token').value.trim(), ct = $('ct0').value.trim(), bt = $('tg_bot_token').value.trim();
    if (at) p.auth_token = at; if (ct) p.ct0 = ct; if (bt) p.tg_bot_token = bt;
    return p;
  }
  function setConfigEditorDisabled(disabled) {
    const selector = '#tg_chat_id, #auth_token, #ct0, #tg_bot_token, #acct-list input, #acct-list button, #btn-add-acct, #btn-detect-collector, #btn-save';
    $('settings').querySelectorAll(selector).forEach((control) => { control.disabled = disabled; });
    $('btn-detect-collector').disabled = disabled || collectorDetectInFlight;
  }
  async function saveConfig() {
    if (configSaveInFlight) throw new Error('配置正在保存，请稍候');
    if (remoteConfigPending) throw new Error('配置已在其他标签页更新，请先关闭设置载入新版本');
    configSaveInFlight = true;
    setConfigEditorDisabled(true);
    try {
      const r = await api('POST', 'api/config', collectPayload());
      $('auth_token').value = ''; $('ct0').value = ''; $('tg_bot_token').value = '';
      ['auth_token', 'ct0', 'tg_bot_token'].forEach(refreshReveal);
      await loadConfig();
      renderAll();
      return r;
    } catch (e) {
      if (e.status === 409) noteRemoteConfigConflict();
      throw e;
    } finally {
      configSaveInFlight = false;
      setConfigEditorDisabled(false);
      // 保存等待期间允许关闭抽屉。若 409 冲突在关闭后才返回，closeSettings() 当时还看不到
      // remoteConfigPending；这里必须主动追赶远端版本，不能让隐藏表单和账号卡片长期停在旧配置。
      const closedConflict = remoteConfigPending && $('settings').classList.contains('hidden');
      if (closedConflict) settingsDirty = false;
      if (configReloadRequested || closedConflict) {
        reloadConfigFromStream(remoteConfigRevision);
      }
    }
  }
  async function saveDraftForTest() {
    if (remoteConfigPending) throw new Error('配置已在其他标签页更新，请先关闭设置载入新版本');
    return settingsDirty ? saveConfig() : { warnings: [] };
  }
  $('btn-save').onclick = async () => {
    if (!settingsDirty) { toast('配置没有变化', 'ok'); return; }
    try { const r = await saveConfig(); toast(r.warnings && r.warnings.length ? '⚠ ' + r.warnings.join('；') : '✅ 配置已保存', r.warnings && r.warnings.length ? 'err' : 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };
  $('btn-test-collector').onclick = async () => {
    const btn = $('btn-test-collector'); btn.disabled = true; const old = btn.textContent; btn.textContent = '测试中…';
    try {
      // 无改动时不要做一次空保存：空保存也会推进 revision 并取消 worker 在途任务。
      const saved = await saveDraftForTest();
      if (saved.warnings && saved.warnings.length) throw new Error('配置未完全保存：' + saved.warnings.join('；'));
      const r = await api('POST', 'api/test/collector', {}); toast((r.ok ? '✅ ' : '❌ ') + r.message, r.ok ? 'ok' : 'err');
    }
    catch (e) { toast(e.message, 'err'); } finally { btn.textContent = old; renderTop(); }
  };
  $('btn-test-tg').onclick = async () => {
    const btn = $('btn-test-tg'); btn.disabled = true; const old = btn.textContent; btn.textContent = '测试中…';
    try {
      const saved = await saveDraftForTest();
      if (saved.warnings && saved.warnings.length) throw new Error('配置未完全保存：' + saved.warnings.join('；'));
      const r = await api('POST', 'api/test/telegram', {}); toast((r.ok ? '✅ ' : '❌ ') + r.message, r.ok ? 'ok' : 'err');
    }
    catch (e) { toast(e.message, 'err'); } finally { btn.textContent = old; renderTop(); }
  };

  let controlInFlight = false;
  async function setPaused(action) {
    if (controlInFlight) return;
    controlInFlight = true;
    $('btn-pause').disabled = true; $('btn-resume').disabled = true;
    try {
      const r = await api('POST', 'api/control', { action });
      statusData.paused = !!r.paused;
      renderTop();
    } catch (e) { toast(e.message, 'err'); }
    finally { controlInFlight = false; $('btn-pause').disabled = false; $('btn-resume').disabled = false; }
  }
  $('btn-pause').onclick = () => setPaused('pause');
  $('btn-resume').onclick = () => setPaused('resume');

  function clearPasswordForm() {
    ['old_pw', 'new_pw', 'new_pw2'].forEach((id) => { if ($(id)) { $(id).value = ''; refreshReveal(id); } });
    if ($('pw-form')) $('pw-form').classList.add('hidden');
    if ($('pw-toggle')) $('pw-toggle').setAttribute('aria-expanded', 'false');
  }
  $('pw-toggle').onclick = () => {
    const closing = !$('pw-form').classList.contains('hidden');
    if (closing) clearPasswordForm();
    else { $('pw-form').classList.remove('hidden'); $('pw-toggle').setAttribute('aria-expanded', 'true'); $('old_pw').focus(); }
  };
  $('btn-chpw').onclick = async () => {
    const btn = $('btn-chpw');
    if (btn.disabled) return;
    try {
      const nextPassword = $('new_pw').value;
      if ([...nextPassword].length < 8) throw new Error('新密码至少 8 位');
      if (nextPassword !== $('new_pw2').value) throw new Error('两次新密码不一致');
      btn.disabled = true;
      await api('POST', 'api/password', { old_password: $('old_pw').value, new_password: $('new_pw').value });
      clearPasswordForm();
      toast('✅ 密码已修改');
    } catch (e) { toast(e.message, 'err'); }
    finally { btn.disabled = false; }
  };

  $('logout').onclick = async () => {
    const btn = $('logout');
    if (btn.disabled) return;
    btn.disabled = true;
    try { await api('POST', 'api/logout'); stopPanelUpdates(); location.reload(); }
    catch (e) { toast('登出失败：' + e.message, 'err'); btn.disabled = false; }
  };

  // 从浏览器前进/后退缓存恢复的 DOM 可能仍含登出前的面板数据；恢复时强制重新校验会话。
  window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });

  setInterval(tickTimes, 1000);

  // ---------- 启动 ----------
  (async function init() {
    try {
      const s = await api('GET', 'api/session');
      if (!s.hasPassword) showAuth(true);
      else if (!s.authed) showAuth(false);
      else await startPanel();
    } catch (e) {
      showAuth(false);
      $('auth-msg').textContent = '面板加载失败：' + e.message;
      $('auth-msg').classList.remove('hidden');
    }
  })();
})();
