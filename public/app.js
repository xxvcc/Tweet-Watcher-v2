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
  const THEME_ICON = { system: 'i-moon', light: 'i-sun', dark: 'i-moon' };
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
    if (b) {
      setIconLabel(b, THEME_ICON[t], '');
      b.title = '主题：' + THEME_NAME[t] + '（点击切换）';
      b.setAttribute('aria-label', b.title);
    }
  }
  function setIconLabel(button, icon, label) {
    button.textContent = '';
    if (typeof document.createElementNS === 'function') {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#' + icon); svg.appendChild(use); button.appendChild(svg);
    }
    if (label) button.appendChild(document.createTextNode(label));
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
    if (request.signal?.aborted) throw new Error('请求已取消');
    if (res.status === 401 && !KEEP_ON_401.has(path)) {
      stopPanelUpdates();
      location.reload(); // 会话已失效：回登录页，而不是让面板停在过期数据上
      throw new Error('会话已失效，请重新登录');
    }
    if (!res.ok) {
      const err = new Error((data && (data.error || data.message)) || ('HTTP ' + res.status));
      err.status = res.status;
      err.controlPending = data?.controlPending === true;
      err.code = data?.code;
      if (data?.code === 'PENDING_REMOVAL_REQUIRES_CONFIRMATION') err.removedPending = data.removed_pending;
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
  let sessionsCfg = [];
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
  let loadedAiKeyPresent = false;
  let loadedAiSettings = null;
  let configuredSessionIds = new Set();
  let settingsSaved = false;
  const SECRET_FIELDS = ['auth_token', 'ct0', 'tg_bot_token', 'ai_api_key'];
  const AI_FIELDS = ['ai_translation_enabled', 'ai_base_url', 'ai_model', 'ai_api_key', 'clear_ai_api_key'];
  const testRequests = { collector: null, telegram: null };
  let aiTestRequest = null;
  const feedBuf = [];
  const feedSeen = new Set(); // 活动流去重键（防 SSE 重连回放重复）
  const feedNodes = new Map(); // 同一条活动复用节点，保留错误详情的展开状态。

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
      ai_translation_enabled: !!(c && c.ai_translation_enabled),
      ai_base_url: (c && c.ai_base_url) || 'https://api.openai.com/v1',
      ai_model: (c && c.ai_model) || '',
      media_mode: c?.media_mode || 'links', enrichment_mode: c?.enrichment_mode || 'off',
      enrichment_limit: c?.enrichment_limit || 2, x_sessions: c?.x_sessions || [],
      secrets: {
        hasAuthToken: !!secrets.hasAuthToken,
        hasCt0: !!secrets.hasCt0,
        hasTgBotToken: !!secrets.hasTgBotToken,
        hasAiApiKey: !!secrets.hasAiApiKey,
        x_sessions: secrets.x_sessions || {},
      },
    });
  }
  function hasSecretDraft() {
    return SECRET_FIELDS.some((id) => !!$(id).value) || $('clear_ai_api_key').checked
      || [...$('session-list').querySelectorAll('input[type=password]')].some((input) => !!input.value);
  }
  function noteRemoteConfigConflict(revision) {
    if (!remoteConfigPending) toast('其他标签页已更新配置；当前未保存内容已保留，关闭设置后将载入新版本', 'err');
    remoteConfigPending = true;
    remoteConfigRevision = Number.isSafeInteger(revision) ? revision : null;
    renderSaveState();
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
    // A remote revision may rotate a saved key even when its presence flag is unchanged.
    if (fromStream && loadedRevision !== configRevision) clearAiTest();

    if (fromStream && settingsDirty) {
      // 另一个标签页即使保存了完全相同的普通配置，服务端 revision 也会递增。
      // 内容快照相同且本页没有待写密钥时，可以只推进基准 revision，保留本地草稿；
      // 密钥只返回“是否存在”，有密钥草稿时无法证明远端值未变，必须保守判冲突。
      if (signature === loadedConfigSignature && !hasSecretDraft()) {
        configRevision = loadedRevision;
        remoteConfigPending = false;
        remoteConfigRevision = null;
        renderSaveState();
        return false;
      }
      noteRemoteConfigConflict(loadedRevision);
      return false;
    }

    if ($('ai_base_url').value !== (c.ai_base_url || 'https://api.openai.com/v1')
      || $('ai_model').value !== (c.ai_model || '')
      || $('ai_translation_enabled').checked !== (c.ai_translation_enabled === true)
      || loadedAiKeyPresent !== !!c.secrets?.hasAiApiKey
      || $('clear_ai_api_key').checked) clearAiTest();
    configRevision = loadedRevision;
    loadedConfigSignature = signature;
    loadedAiKeyPresent = !!c.secrets?.hasAiApiKey;
    loadedAiSettings = { enabled: c.ai_translation_enabled === true, baseUrl: c.ai_base_url || 'https://api.openai.com/v1',
      configured: !!(c.ai_model && c.secrets?.hasAiApiKey) };
    configuredSessionIds = new Set((c.x_sessions || []).filter((session) => session.enabled !== false
      && c.secrets?.x_sessions?.[session.id]?.hasAuthToken && c.secrets?.x_sessions?.[session.id]?.hasCt0).map((session) => session.id));
    if (c.secrets?.hasAuthToken && c.secrets?.hasCt0) configuredSessionIds.add('default');
    accountsCfg = c.accounts || [];
    sessionsCfg = c.x_sessions || [];
    $('media_mode').value = c.media_mode || 'links';
    $('enrichment_mode').value = c.enrichment_mode || 'off';
    $('enrichment_limit').value = c.enrichment_limit || 2;
    renderSessionRows(sessionsCfg, c.secrets?.x_sessions || {});
    $('collector-name').textContent = 'twscrape';
    if (c.runtime) { statusData.runtime = c.runtime; renderTop(); }
    $('tg_chat_id').value = c.tg_chat_id || '';
    $('ai_translation_enabled').checked = c.ai_translation_enabled === true;
    $('ai_base_url').value = c.ai_base_url || 'https://api.openai.com/v1';
    $('ai_model').value = c.ai_model || '';
    $('clear_ai_api_key').checked = false;
    // 远端刷新意味着本地未保存密钥已被明确放弃；不能只更新 placeholder 后把旧 value 留着，
    // 否则下一次保存会用旧密钥覆盖刚同步的新版本。
    SECRET_FIELDS.forEach((id) => { $(id).value = ''; });
    const DOTS = '••••••••••••';
    $('auth_token').placeholder = c.secrets.hasAuthToken ? DOTS : '';
    $('ct0').placeholder = c.secrets.hasCt0 ? DOTS : '';
    $('tg_bot_token').placeholder = c.secrets.hasTgBotToken ? DOTS : '';
    $('ai_api_key').placeholder = c.secrets.hasAiApiKey ? DOTS : '';
    renderAcctRows(accountsCfg);
    if (!$('session-test-user').value) $('session-test-user').value = accountsCfg.find((a) => (a.source_type || 'user') === 'user')?.username || 'elonmusk';
    SECRET_FIELDS.forEach(refreshReveal);
    if (!collectorOk) setCollectorInstallHint('warn', '⚠ 采集程序不完整。请管理员在应用目录运行 ', '，然后重新检查。');
    else setCollectorHint('', '采集器由服务器固定部署；点击“检查安装”确认环境。');
    settingsDirty = false;
    remoteConfigPending = false;
    remoteConfigRevision = null;
    renderSaveState();
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
    const canControl = canCollect && canDeliver;
    const pill = $('livepill'), txt = $('live-text');
    const notice = $('runtime-notice');
    notice.textContent = !runtime ? '正在读取运行模式…'
      : !canCollect && !canDeliver ? '开发预览：X 采集与 Telegram 发送已关闭。'
      : !canDeliver ? '只读验证：可手动测试 X 采集；自动监控与 Telegram 发送已关闭。'
        : st.controlPending ? '暂停/恢复设置未确认；监控保持停止。请重试暂停或恢复，或重新保存配置。'
          : '';
    notice.classList.toggle('hidden', !notice.textContent);
    $('btn-test-collector').disabled = !canCollect || !!testRequests.collector;
    $('btn-test-tg').disabled = !canDeliver || !!testRequests.telegram;
    renderQueryControls();
    renderAiTestControl();
    pill.className = 'livepill';
    if (panelActive && (statusUnavailable || !statusIsFresh(lastStatusAt))) {
      pill.classList.add('off');
      txt.textContent = statusUnavailable ? '状态连接中断' : lastStatusAt === null ? '连接中…' : '状态已过期，重连中';
    }
    else if (!canCollect) { pill.classList.add('off'); txt.textContent = runtime ? '开发预览' : '连接中…'; }
    else if (!canDeliver) { pill.classList.add('off'); txt.textContent = '只读验证'; }
    else if (st.controlPending) { pill.classList.add('paused'); txt.textContent = '已停止，等待确认'; }
    else if (st.paused) { pill.classList.add('paused'); txt.textContent = '已暂停'; }
    else if (!st.running) { pill.classList.add('off'); txt.textContent = '未运行'; }
    else { txt.textContent = '运行中'; }
    $('btn-pause').classList.toggle('hidden', !canControl || (!st.controlPending && (!st.running || st.paused)));
    $('btn-resume').classList.toggle('hidden', !canControl || (!st.controlPending && !st.paused));
    const pauseLabel = st.controlPending ? '重新暂停' : '暂停';
    if ($('btn-pause').dataset.label !== pauseLabel) {
      $('btn-pause').dataset.label = pauseLabel;
      setIconLabel($('btn-pause'), 'i-pause', pauseLabel);
    }
  }
  // 从未检查过的账号返回 null（区别于 rem=0，避免误显示"0:00 / 满格"）
  function nextCheckSec(cfgAcct) {
    const s = (statusData.accounts || {})[accountKey(cfgAcct)];
    if (!s || !s.lastCheck) return null;
    return (s.lastCheck + cfgAcct.check_interval * 1000 - Date.now()) / 1000;
  }
  function renderStats() {
    $('stat-accounts').textContent = accountsCfg.length;
    $('stat-pushes').textContent = statusData.pushesToday || 0;
    const pending = pendingTotal();
    if ($('stat-pending')) {
      $('stat-pending').textContent = pending === null ? '—' : String(pending);
      $('stat-pending').dataset.state = pending === null ? 'unknown' : pending > 0 ? 'pending' : 'clear';
    }
    renderUptime(statusData.startedAt ? Date.now() - statusData.startedAt : 0);
    let next = Infinity;
    if (!statusData.paused && statusData.running) {
      accountsCfg.forEach((a) => { const n = nextCheckSec(a); if (n != null && n < next) next = n; });
    }
    $('stat-next').textContent = (next !== Infinity) ? mmss(next) : '—';
  }

  // ---------- 账号卡片 ----------
  function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function accountKey(a) { return a.source_key || ((a.timeline_mode === 'replies' ? 'replies:' : '') + (a.username || '').toLowerCase()); }
  function accountLabel(a) { return a.source_type === 'list' ? 'List ' + a.list_id
    : a.source_type === 'search' ? '搜索：' + a.query : '@' + a.username + (a.timeline_mode === 'replies' ? '（含回复）' : ''); }
  function sourceTypeLabel(a) { return a.source_type === 'list' ? 'List' : a.source_type === 'search' ? '搜索'
    : a.timeline_mode === 'replies' ? '帖子与回复' : '帖子'; }
  function pendingCounts() {
    const counts = statusData.diagnostics?.pendingCounts;
    if (!statusIsFresh(lastStatusAt) || !counts || typeof counts !== 'object' || Array.isArray(counts)
      || Object.values(counts).some((value) => !Number.isSafeInteger(value) || value < 0)
      || accountsCfg.some((source) => !Object.prototype.hasOwnProperty.call(counts, accountKey(source)))) return null;
    return counts;
  }
  function pendingTotal() {
    const counts = pendingCounts();
    if (!counts) return null;
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    return Number.isSafeInteger(total) ? total : null;
  }
  function catchupLabel(job) {
    return ({ collecting: '补采中', ready: '已覆盖，等待入队' })[job.status] || '补采状态待确认';
  }
  function savedCount(value) { return Number.isSafeInteger(value) && value >= 0 ? value : '—'; }
  function catchupSummary(job) {
    return (statusIsFresh(lastStatusAt) ? '' : '上次记录：') + catchupLabel(job) + ' · 已保存 '
      + savedCount(job.pages) + ' 页 / ' + savedCount(job.posts ?? job.items) + ' 条';
  }
  function buildCardDetails(source) {
    const box = el('div', 'card-details');
    const counts = pendingCounts(), count = counts?.[accountKey(source)];
    const pending = el('span', 'card-pending', '待发送 ' + (count === undefined ? '—' : count));
    pending.dataset.state = count === undefined ? 'unknown' : count > 0 ? 'pending' : 'clear';
    box.appendChild(pending);
    const job = statusData.diagnostics?.backfills?.[accountKey(source)];
    if (job && typeof job === 'object') {
      const catchup = el('div', 'card-catchup');
      catchup.appendChild(el('span', 'card-catchup-summary', catchupSummary(job)));
      if (job.error) catchup.appendChild(el('div', 'diagnostic-error', String(job.error).slice(0, 500)));
      box.appendChild(catchup);
    }
    return box;
  }

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
  function errorSummary(message, markStale = true) {
    const text = String(message);
    let summary;
    if (/Telegram.*(?:推送|发送).*失败|^✗?\s*推送失败(?:\s|[:：])/i.test(text)) summary = '消息推送遇到问题';
    else if (/配置读取失败，监控将保持停止/.test(text)) summary = '无法读取配置，监控已停止';
    else if (/本轮页数预算尚未覆盖上次水位/.test(text)) summary = '历史内容尚未补齐';
    else if (/限流|退避|(?:^|\D)429(?:\D|$)/.test(text)) summary = '请求暂时受限';
    else if (/Cookie|X.*登录|认证失败|身份验证失败/i.test(text)) summary = '登录会话需要检查';
    else if (/超时|timeout/i.test(text)) summary = '本次请求超时';
    else if (/水位|覆盖|分页|游标|截断|解析|坏页|^✗\s*拉取 .+ 失败/.test(text)) summary = '本次采集未完成';
    else summary = '本次检查遇到问题';
    return (markStale && !statusIsFresh(lastStatusAt) ? '上次记录：' : '') + summary;
  }
  function buildBody(s) {
    if (s.ok === false && s.lastError) {
      const details = el('details', 'errline');
      const summary = el('summary', 'err-summary');
      summary.append(el('span', 'error-summary-text', errorSummary(s.lastError)), el('span', 'error-detail-label', '查看原因'));
      details.append(summary, el('div', 'error-original', String(s.lastError)));
      details._errorMessage = String(s.lastError);
      return details;
    }
    if (s.lastTweet && s.lastTweet.id) {
      const tw = el('div', 'tweet');
      const th = el('div', 'th'); th.appendChild(el('span', null, '最近推送')); th.appendChild(el('span', null, s.lastTweet.time || ''));
      tw.appendChild(th); tw.appendChild(document.createTextNode(s.lastTweet.text || ''));
      return tw;
    }
    return el('div', 'tweet empty', '本次运行暂无推送');
  }
  function buildSpark(s) {
    const hist = Array.isArray(s.history) ? s.history.slice(-10).filter((value) => Number.isFinite(value) && value >= 0) : [];
    if (!hist.some((value) => value > 0)) return null;
    const spark = el('div', 'spark'); spark.title = '近期每次检查的推送量';
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
    const user = accountKey(cfgAcct);
    const s = (statusData.accounts || {})[user] || {};
    const { cls, label } = statusOf(s);
    const card = el('div', 'card ' + cls); card.dataset.user = user;

    const top = el('div', 'card-top');
    const handle = el('span', 'handle', accountLabel(cfgAcct));
    const identity = el('div', 'card-identity');
    identity.append(handle, el('span', 'source-badge', sourceTypeLabel(cfgAcct)));
    top.appendChild(identity); top.appendChild(buildBadge(cls, label)); card.appendChild(top);

    const meta = el('div', 'meta');
    const m1 = el('span'); m1.appendChild(document.createTextNode('上次检查 ')); m1.appendChild(el('b', 'js-lastcheck', relTime(s.lastCheck)));
    const m2 = el('span'); m2.appendChild(document.createTextNode('上次推送 ')); m2.appendChild(el('b', 'js-lastpush', relTime(s.lastPushAt)));
    meta.appendChild(m1); meta.appendChild(m2); card.appendChild(meta);
    card.appendChild(buildCardDetails(cfgAcct));

    card.appendChild(buildBody(s));

    const foot = el('div', 'foot');
    const spark = buildSpark(s); if (spark) foot.appendChild(spark);
    const next = el('div', 'next');
    const lbl = el('div', 'lbl');
    lbl.appendChild(el('span', 'js-nextlbl', s.ok === false ? '预计下次重试' : '预计下次检查'));
    lbl.appendChild(el('span', 'tnum js-next', ''));
    const bar = el('div', 'bar'); const span = el('span', 'js-bar'); bar.appendChild(span);
    next.appendChild(lbl); next.appendChild(bar);
    foot.appendChild(next); card.appendChild(foot);

    updateCardTime(card, cfgAcct);
    return card;
  }

  // 原地更新已有卡片（避免每次 status 全量重建导致闪烁 / 进度条动画重置）
  function updateCard(card, cfgAcct) {
    const s = (statusData.accounts || {})[accountKey(cfgAcct)] || {};
    const { cls, label } = statusOf(s);
    card.className = 'card ' + cls;
    const handle = card.querySelector('.handle'); if (handle) handle.textContent = accountLabel(cfgAcct);
    const type = card.querySelector('.source-badge'); if (type) type.textContent = sourceTypeLabel(cfgAcct);
    const oldBadge = card.querySelector('.st'); if (oldBadge) oldBadge.replaceWith(buildBadge(cls, label));
    const oldBody = card.querySelector('.tweet, .errline');
    if (oldBody && !(oldBody.classList.contains('errline') && s.ok === false
      && oldBody._errorMessage === String(s.lastError))) {
      const nextBody = buildBody(s);
      if (oldBody.classList.contains('errline') && nextBody.classList.contains('errline')) nextBody.open = oldBody.open;
      oldBody.replaceWith(nextBody);
    }
    const details = card.querySelector('.card-details'); if (details) details.replaceWith(buildCardDetails(cfgAcct));
    const oldSpark = card.querySelector('.spark'), spark = buildSpark(s);
    if (oldSpark && spark) oldSpark.replaceWith(spark);
    else if (oldSpark) oldSpark.remove();
    else if (spark) { const foot = card.querySelector('.foot'); foot.insertBefore(spark, foot.firstChild); }
    const lbl = card.querySelector('.js-nextlbl'); if (lbl) lbl.textContent = s.ok === false ? '预计下次重试' : '预计下次检查';
    updateCardTime(card, cfgAcct);
  }

  function updateCardTime(card, cfgAcct) {
    const s = (statusData.accounts || {})[accountKey(cfgAcct)] || {};
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
    const errorText = card.querySelector('.error-summary-text');
    if (errorText && s.lastError) {
      const summary = errorSummary(s.lastError);
      if (errorText.textContent !== summary) errorText.textContent = summary;
    }
    const pending = card.querySelector('.card-pending'), count = pendingCounts()?.[accountKey(cfgAcct)];
    if (pending) {
      pending.textContent = '待发送 ' + (count === undefined ? '—' : count);
      pending.dataset.state = count === undefined ? 'unknown' : count > 0 ? 'pending' : 'clear';
    }
    const catchup = card.querySelector('.card-catchup-summary'), job = statusData.diagnostics?.backfills?.[accountKey(cfgAcct)];
    if (catchup && job) {
      const summary = catchupSummary(job);
      if (catchup.textContent !== summary) catchup.textContent = summary;
    }
  }

  function sameUsers() {
    const cur = [].map.call($('cards').querySelectorAll('.card'), (c) => c.dataset.user);
    const want = accountsCfg.map(accountKey);
    return cur.length === want.length && cur.every((u, i) => u === want[i]);
  }
  function renderCards() {
    $('acct-count').textContent = accountsCfg.length;
    $('cards-empty').classList.toggle('hidden', accountsCfg.length > 0);
    const box = $('cards');
    if (sameUsers()) {
      accountsCfg.forEach((a) => { const card = [...box.querySelectorAll('.card')].find((node) => node.dataset.user === accountKey(a)); if (card) updateCard(card, a); });
    } else {
      box.textContent = '';
      accountsCfg.forEach((a) => box.appendChild(makeCard(a)));
    }
  }

  // 每秒只更新时间派生的文字/进度，不重建 DOM
  function tickTimes() {
    if ($('dash').classList.contains('hidden')) return;
    renderTop();
    renderStats();
    renderDiagnostics();
    [].forEach.call(document.querySelectorAll('#cards .card'), (card) => {
      const a = accountsCfg.find((x) => accountKey(x) === card.dataset.user);
      if (a) updateCardTime(card, a);
    });
  }

  // ---------- 活动流 ----------
  function classifyLog(msg) {
    if (/✗|失败|异常|错误|失效|未完成|无法|不可用|损坏|拒绝|限流|退避|超时/i.test(msg)) return { c: 'err', i: '!' };
    if (msg.indexOf('✓') === 0 || msg.indexOf('✓ 推送') > -1) return { c: 'ok', i: '✓' };
    if (msg.indexOf('无新推文') > -1) return { c: 'mut', i: '○' };
    if (msg.indexOf('重试') > -1) return { c: 'mut', i: '↻' };
    return { c: 'mut', i: '◆' };
  }
  function feedLine(l) {
    const k = classifyLog(l.msg);
    const ev = el('div', 'ev ' + k.c);
    ev.appendChild(el('span', 'ico', k.i));
    const tx = el('div', 'tx');
    if (k.c === 'err') {
      const details = el('details', 'activity-error');
      const identity = l.msg.match(/^✗\s*(?:拉取\s+|推送失败\s+)?(@[A-Za-z0-9_]{1,15}|List\s+\d+)(?=\s|[:：（(])/);
      const subject = identity ? identity[1] : /^(?:⏸\s*)?Telegram\s/.test(l.msg) ? 'Telegram' : '';
      const summary = el('summary', 'err-summary');
      summary.append(el('span', 'error-summary-text', (subject ? subject + ' · ' : '') + errorSummary(l.msg, false)),
        el('span', 'error-detail-label', '查看原因'));
      details.append(summary, el('div', 'error-original', l.msg));
      tx.appendChild(details);
    } else tx.appendChild(document.createTextNode(l.msg));
    let hhmmss = '';
    try { hhmmss = new Date(l.t).toLocaleTimeString('zh-CN', { hour12: false }); } catch (_) {}
    tx.appendChild(el('div', 't mono', hhmmss));
    ev.appendChild(tx);
    return ev;
  }
  function logKey(line) {
    const id = line && line.id;
    return (typeof id === 'string' || Number.isSafeInteger(id)) ? 'id:' + id : line.t + '|' + line.msg;
  }
  function pushFeed(l) {
    if (!l || typeof l.msg !== 'string') return;
    const key = logKey(l);
    if (feedSeen.has(key)) return; // 去重：SSE 重连回放的历史行不再重复插入
    feedSeen.add(key);
    feedBuf.push(l);
    while (feedBuf.length > 120) { const old = logKey(feedBuf.shift()); feedSeen.delete(old); feedNodes.delete(old); }
    renderFeed();
  }
  function renderFeed(resetScroll = false) {
    const filter = $('activity-filter')?.value || 'important';
    const lines = feedBuf.filter((line) => filter === 'all' || classifyLog(line.msg).c === 'err'
      || (filter !== 'errors' && !line.msg.includes('无新推文'))).slice(-60).reverse();
    const box = $('feed'), scrollTop = resetScroll ? 0 : box.scrollTop;
    const desired = lines.map((line) => {
      const key = logKey(line);
      if (!feedNodes.has(key)) feedNodes.set(key, feedLine(line));
      return feedNodes.get(key);
    });
    if (!lines.length) {
      const empty = box.querySelector('.feed-empty') || el('div', 'feed-empty');
      const message = filter === 'errors' ? '暂无异常活动'
        : feedBuf.length ? '暂无重要活动，可切换查看全部' : '等待活动记录';
      if (empty.textContent !== message) empty.textContent = message;
      desired.push(empty);
    }
    const retained = new Set(desired);
    [...box.children].forEach((node) => { if (!retained.has(node)) node.remove(); });
    // Do not detach retained entries: a new log must not steal keyboard focus
    // from an expanded error summary already in the feed.
    desired.forEach((node, index) => {
      const current = box.children[index];
      if (current !== node) box.insertBefore(node, current || null);
    });
    if ($('feed-count')) $('feed-count').textContent = lines.length;
    if (Number.isFinite(scrollTop)) box.scrollTop = scrollTop;
  }
  if ($('activity-filter')) $('activity-filter').addEventListener('change', () => renderFeed(true));

  function renderAll() { renderTop(); renderStats(); renderCards(); renderDiagnostics(); }

  // ---------- 实时更新：SSE 优先，不支持流式响应的代理使用 HTTP 轮询 ----------
  let streamRetryTimer = null;
  let streamRetryMs = 1000;
  let streamProbeInFlight = false;
  let streamHealthy = false;
  let streamVersion = 0;
  const STATUS_FRESH_MS = 30000;
  const statusClock = () => typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now() : Date.now();
  let lastStreamStatusAt = null;
  let lastStatusAt = null;
  let statusUnavailable = false;
  function statusIsFresh(at) {
    if (at === null) return false;
    const age = statusClock() - at;
    // 单调时间不受系统校时影响；旧环境回退墙上时间时，负年龄也必须重新确认状态。
    return Number.isFinite(age) && age >= 0 && age < STATUS_FRESH_MS;
  }
  let pollTimer = null;
  let pollRequest = null;
  let pollTimeout = null;
  function stopPanelUpdates() {
    panelActive = false;
    panelGeneration++;
    streamHealthy = false;
    streamVersion++;
    lastStreamStatusAt = null;
    lastStatusAt = null;
    statusUnavailable = false;
    configReloadInFlight = false;
    configReloadRequested = false;
    configSaveInFlight = false;
    settingsSaved = false;
    renderDiagnostics.healthSignature = null;
    clearAiTest();
    setConfigEditorDisabled(false);
    for (const kind of Object.keys(testRequests)) {
      const request = testRequests[kind];
      if (!request) continue;
      request.controller.abort();
      request.button.textContent = request.label;
      testRequests[kind] = null;
    }
    clearTimeout(pollTimer); pollTimer = null;
    clearTimeout(pollTimeout); pollTimeout = null;
    clearTimeout(streamRetryTimer); streamRetryTimer = null;
    if (pollRequest) pollRequest.abort();
    pollRequest = null;
    if (es) es.close();
    es = null;
    streamRetryMs = 1000;
    SECRET_FIELDS.forEach((id) => { $(id).value = ''; refreshReveal(id); });
    $('session-list').querySelectorAll('input[type=password]').forEach((input) => { input.value = ''; });
    ['inspect-result', 'x-test-result', 'list-preview', 'session-health', 'backfill-progress'].forEach((id) => { $(id).textContent = ''; });
    $('btn-list-import').classList.add('hidden');
    $('clear_ai_api_key').checked = false;
    feedBuf.length = 0; feedSeen.clear(); feedNodes.clear(); $('feed').textContent = '';
    if ($('feed-count')) $('feed-count').textContent = '0';
  }
  function schedulePoll() {
    if (!panelActive || pollTimer) return;
    pollTimer = setTimeout(() => { pollTimer = null; pollPanel(); }, 5000);
  }
  function applyStatus(next, syncConfig) {
    if (!next || typeof next !== 'object' || Array.isArray(next)) return;
    lastStatusAt = statusClock();
    statusUnavailable = false;
    statusData = { ...next, accounts: next.accounts || {} };
    const nextRevision = Number.isSafeInteger(statusData.configRevision) ? statusData.configRevision : null;
    if (syncConfig && configRevision != null && nextRevision != null && nextRevision !== configRevision) reloadConfigFromStream(nextRevision);
    renderAll();
  }
  async function pollPanel() {
    if (!panelActive || pollRequest) return;
    // SSE 的注释心跳对脚本不可见。曾收到状态帧不能永久证明连接可用，静默后用 HTTP 重新核对。
    if (streamHealthy && statusIsFresh(lastStreamStatusAt)) { schedulePoll(); return; }
    streamHealthy = false;
    renderTop();
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
      if (!snapshot.status || typeof snapshot.status !== 'object' || Array.isArray(snapshot.status)) throw new Error('状态响应无效');
      applyStatus({ ...snapshot.status, runtime: snapshot.runtime || snapshot.status.runtime, paused: snapshot.paused ?? snapshot.status.paused }, true);
      // 服务端返回 200 条，界面只保留最近 60 条；限制回放避免挤出日志去重窗口。
      if (Array.isArray(recent.logs)) recent.logs.slice(-60).forEach(pushFeed);
    } catch (_) {
      // 旧请求失败不能遮盖已恢复的 SSE 或新登录会话；当前 HTTP 失败不得继续展示旧的“运行中”。
      if (panelActive && generation === panelGeneration && version === streamVersion && !streamHealthy) {
        statusUnavailable = true;
        renderTop();
      }
    }
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
      // SSE 不可用仍可能有正常 HTTP 刷新；保持最近状态的新鲜度及 HTTP 错误判定。
      renderTop();
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
        lastStreamStatusAt = statusClock();
        streamVersion++;
        applyStatus(next, true);
      } catch (_) {}
    });
    source.addEventListener('log', (e) => { if (panelActive && es === source) { try { pushFeed(JSON.parse(e.data)); } catch (_) {} } });
    source.onerror = async () => {
      if (!panelActive || es !== source) return;
      streamHealthy = false;
      schedulePoll();
      renderTop();
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
  let selectedSettingsTab = 'sources';
  function selectSettingsTab(name, focus = false) {
    const tabs = [...$('settings').querySelectorAll('[data-settings-tab]')];
    if (!tabs.some((tab) => tab.dataset.settingsTab === name)) return;
    const changed = selectedSettingsTab !== name;
    selectedSettingsTab = name;
    const category = $('settings-category');
    if (category) category.value = name;
    const mobileNavigation = category && typeof category.getClientRects === 'function' && category.getClientRects().length > 0;
    tabs.forEach((tab) => {
      const selected = tab.dataset.settingsTab === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus && !mobileNavigation) tab.focus();
      if (selected && !mobileNavigation && typeof tab.scrollIntoView === 'function') tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    $('settings').querySelectorAll('[data-settings-panel]').forEach((panel) => {
      panel.classList.toggle('hidden', panel.dataset.settingsPanel !== name);
      panel.setAttribute('role', 'tabpanel');
    });
    const body = $('settings').querySelector('.drawer-body');
    if (changed && body) body.scrollTop = 0;
    if (focus && mobileNavigation) category.focus();
  }
  if ($('settings-category')) $('settings-category').addEventListener('change', () => selectSettingsTab($('settings-category').value));
  $('settings').querySelectorAll('[data-settings-tab]').forEach((tab) => {
    tab.onclick = () => selectSettingsTab(tab.dataset.settingsTab);
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...$('settings').querySelectorAll('[data-settings-tab]')];
      const index = tabs.indexOf(tab), direction = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + direction + tabs.length) % tabs.length;
      selectSettingsTab(tabs[next].dataset.settingsTab, true);
    });
  });
  function revealSettingsControl(control, focus = false) {
    if (!control) return;
    if ($('settings').classList.contains('hidden')) {
      if (!focus) return;
      openSettings();
    }
    const panel = control.closest('[data-settings-panel]');
    if (panel) selectSettingsTab(panel.dataset.settingsPanel);
    let ancestor = control.parentNode;
    while (ancestor && ancestor !== $('settings')) {
      if (ancestor.tagName === 'DETAILS') ancestor.open = true;
      ancestor = ancestor.parentNode;
    }
    if (focus) control.focus();
  }
  function invalidSetting(control, message) {
    revealSettingsControl(control, true);
    if (typeof control?.reportValidity === 'function') control.reportValidity();
    throw new Error(message);
  }
  function validateNativeSetting(control, label) {
    if (control?.validity && !control.validity.valid) invalidSetting(control, label + '格式不正确，请检查输入');
  }
  function aiValidationIssue() {
    const baseUrl = $('ai_base_url').value.trim(), model = $('ai_model').value.trim(), key = $('ai_api_key').value.trim();
    const clearing = $('clear_ai_api_key').checked, enabled = $('ai_translation_enabled').checked;
    const issue = (id, message) => ({ control: $(id), message });
    let validUrl = false;
    try {
      const url = new URL(baseUrl);
      validUrl = !!baseUrl && baseUrl.length <= 2048 && !/[\s\\?#]/.test(baseUrl)
        && url.protocol === 'https:' && !!url.hostname && !url.username && !url.password && !url.search && !url.hash;
    } catch (_) {}
    if (!validUrl) return issue('ai_base_url', 'AI 接口需为完整 HTTPS 地址，不能包含凭据、查询参数或片段');
    if (model.length > 160 || (model && !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model))) {
      return issue('ai_model', '模型名称格式无效，请检查字母、数字和 . _ : / - 字符');
    }
    const keyBytes = [...key].reduce((size, char) => {
      const code = char.codePointAt(0); return size + (code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4);
    }, 0);
    if (keyBytes > 4096 || /[\s\x00-\x1f\x7f]/.test(key)) return issue('ai_api_key', 'API Key 格式无效，不能包含空白或控制字符，长度最多 4096 字节');
    if (clearing && key) return issue('clear_ai_api_key', '清除和设置 AI API Key 不能同时提交');
    if (enabled && !model) return issue('ai_model', '启用 AI 翻译需要填写模型');
    if (enabled && (!key && (!loadedAiKeyPresent || clearing))) return issue('ai_api_key', '启用 AI 翻译需要填写 API Key');
    if (loadedAiKeyPresent && loadedAiSettings?.baseUrl !== baseUrl && !key && !(clearing && !enabled)) {
      return issue('ai_api_key', '更换 AI API 地址时请重新填写 API Key，或关闭翻译并清除已保存的 Key');
    }
    return null;
  }
  function serverValidationTarget(message) {
    if (/AI/.test(message)) {
      const issue = aiValidationIssue();
      return issue ? { control: issue.control } : { panel: 'delivery' };
    }
    if (/账号列表/.test(message)) return { panel: 'sources' };
    if (/会话/.test(message)) return { panel: 'connections' };
    return null;
  }
  function renderSaveState() {
    const indicator = $('settings-save-state'); if (!indicator) return;
    const state = configSaveInFlight ? 'saving' : remoteConfigPending ? 'conflict' : settingsDirty ? 'dirty' : settingsSaved ? 'saved' : 'clean';
    indicator.dataset.state = state;
    indicator.textContent = ({ saving: '正在保存…', conflict: '远端配置已更新，草稿已保留', dirty: '有未保存的更改', saved: '配置已保存', clean: '配置已载入' })[state];
  }
  function markSettingsDirty() { settingsDirty = true; settingsSaved = false; renderSaveState(); }
  function openSettings() {
    if (!$('settings').classList.contains('hidden')) return;
    settingsViewGeneration++;
    settingsReturnFocus = document.activeElement;
    $('settings').classList.remove('hidden');
    $('btn-settings').setAttribute('aria-expanded', 'true');
    document.body.classList.add('drawer-open');
    selectSettingsTab(selectedSettingsTab); renderSaveState();
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
      renderSaveState();
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
    const focusable = [].filter.call($('settings').querySelectorAll('button, input, select, summary, a[href]'), (node) => {
      if (node.disabled || node.tabIndex < 0 || node.closest('.hidden')) return false;
      if (typeof node.getClientRects === 'function' && node.getClientRects().length === 0) return false;
      let ancestor = node.parentNode;
      while (ancestor && ancestor !== $('settings')) {
        if (ancestor.tagName === 'DETAILS' && !ancestor.open && !(node.tagName === 'SUMMARY' && node.parentNode === ancestor)) return false;
        ancestor = ancestor.parentNode;
      }
      return true;
    });
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  function field(role, value, label, type = 'text') {
    const input = document.createElement('input'); input.type = type; input.value = value ?? '';
    input.setAttribute('data-role', role); input.setAttribute('aria-label', label); input.autocomplete = 'off';
    input.spellcheck = false; input.setAttribute('autocapitalize', 'off'); return input;
  }
  function select(role, options, value, label) {
    const input = document.createElement('select'); input.setAttribute('data-role', role); input.setAttribute('aria-label', label);
    options.forEach(([key, text]) => { const option = el('option', '', text); option.value = key; input.appendChild(option); });
    input.value = value; return input;
  }
  function labelled(text, input) { const label = el('label', '', text); label.appendChild(input); return label; }
  function makeAcctRow(a) {
    const existing = !!(a?.username || a?.list_id || a?.query);
    a = a || { username: '', fetch_count: 10, check_interval: 300 };
    const row = el('details', 'acct-row'); row.dataset.existing = existing ? 'true' : 'false'; row.open = !existing;
    const summary = el('summary', 'source-editor-summary');
    const identity = el('div', 'source-editor-identity');
    const summaryName = el('span', 'source-editor-name');
    const summaryType = el('span', 'source-editor-type');
    const summaryMeta = el('span', 'source-editor-meta');
    identity.append(summaryName, summaryType, summaryMeta);
    const action = el('span', 'source-editor-action');
    action.append(el('span', 'source-editor-edit', '编辑'), el('span', 'source-editor-collapse', '收起'));
    summary.append(identity, action);
    const body = el('div', 'source-editor-body'); row.append(summary, body);
    const type = select('type', [['user', '账号'], ['list', 'List'], ['search', '关键词搜索']], a.source_type || 'user', '来源类型');
    const name = field('name', a.username || a.list_id || a.query || '', '来源用户名、List ID 或查询'); name.className = 'col-name';
    const mode = select('mode', [['posts', '帖子'], ['replies', '帖子与回复']], a.timeline_mode || 'posts', '账号时间线范围');
    const syncType = () => { name.maxLength = type.value === 'user' ? 16 : type.value === 'list' ? 32 : 512;
      name.placeholder = type.value === 'user' ? '用户名' : type.value === 'list' ? 'List 数字 ID' : '例如 AI lang:en';
      mode.classList.toggle('hidden', type.value !== 'user'); };
    type.onchange = () => { syncType(); markSettingsDirty(); }; syncType();
    const del = el('button', 'btn-x col-x', '✕'); del.type = 'button'; del.setAttribute('aria-label', '删除此来源，保存后移除其待发送消息');
    del.onclick = () => { row.remove(); markSettingsDirty(); };
    const main = el('div', 'source-main'); main.append(type, name, del); body.appendChild(main);
    const fc = field('fc', a.fetch_count || 10, '每页条数', 'number'); fc.min = 1; fc.max = 50; fc.step = 1;
    const iv = field('iv', a.check_interval || 300, '检查频率（秒）', 'number'); iv.min = 30; iv.max = 3600; iv.step = 1;
    const timing = el('div', 'source-timing'); timing.append(labelled('每页条数', fc), labelled('间隔（秒）', iv)); body.append(timing, mode);
    const filters = a.filters || {};
    const policy = el('details', 'source-policy'); policy.appendChild(el('summary', '', '推送筛选'));
    const types = el('div', 'source-types');
    for (const [key, text] of [['originals', '原创'], ['reposts', '转推'], ['replies', '回复'], ['quotes', '引用']]) {
      const input = field(key, '', text, 'checkbox'); input.checked = filters[key] !== false;
      const label = el('label', 'check-label'); label.append(input, document.createTextNode(text)); types.appendChild(label);
    }
    policy.appendChild(types);
    const include = field('include', (filters.include || []).join(', '), '包含关键词'); include.placeholder = '任一包含词，用逗号分隔'; include.maxLength = 3030;
    const exclude = field('exclude', (filters.exclude || []).join(', '), '排除关键词'); exclude.placeholder = '任一排除词，用逗号分隔'; exclude.maxLength = 3030;
    policy.append(labelled('包含关键词', include), labelled('排除关键词', exclude)); body.appendChild(policy);
    const test = el('button', 'btn-ghost btn-sm source-query', '测试此来源'); test.type = 'button'; test.setAttribute('data-query', 'true');
    test.onclick = () => { const identity = name.value.trim(); const selectedType = type.value; const selectedMode = mode.value;
      return runXQuery(test, 'api/test/collector', () => {
        const source = accountsCfg.find((entry) => (entry.source_type || 'user') === selectedType
          && (selectedType === 'list' ? entry.list_id === identity : selectedType === 'search' ? entry.query === identity
            : entry.username.toLowerCase() === identity.replace(/^@/, '').toLowerCase() && (entry.timeline_mode || 'posts') === selectedMode));
        if (!source) throw new Error('请先填写完整来源');
        return { source_key: accountKey(source) };
      }, showXResult); };
    const actions = el('div', 'inline-actions source-actions'); actions.appendChild(test);
    const reset = el('button', 'btn-ghost btn-sm source-query', '重新开始补采'); reset.type = 'button'; reset.setAttribute('data-query', 'true');
    reset.onclick = () => {
      const identity = name.value.trim(), selectedType = type.value, selectedMode = mode.value;
      return runXQuery(reset, 'api/catchup/reset', () => {
        const source = accountsCfg.find((entry) => (entry.source_type || 'user') === selectedType
          && (selectedType === 'list' ? entry.list_id === identity : selectedType === 'search' ? entry.query === identity
            : entry.username.toLowerCase() === identity.replace(/^@/, '').toLowerCase() && (entry.timeline_mode || 'posts') === selectedMode));
        if (!source) throw new Error('请先填写完整来源');
        return { source_key: accountKey(source) };
      }, showXResult);
    };
    actions.appendChild(reset);
    body.append(actions, el('div', 'hint mt-12', '重新补采会重建分页进度，保留原采集检查点和待发送队列。'));
    const refreshSummary = () => {
      const value = name.value.trim();
      summaryName.textContent = !value ? '未填写的来源' : type.value === 'user' ? '@' + value.replace(/^@/, '')
        : type.value === 'list' ? 'List ' + value : value;
      summaryType.textContent = sourceTypeLabel({ source_type: type.value, timeline_mode: mode.value });
      const interval = Number(iv.value), count = Number(fc.value);
      const frequency = Number.isSafeInteger(interval) && interval >= 30 && interval <= 3600
        ? '每 ' + (interval % 60 === 0 ? interval / 60 + ' 分钟' : interval + ' 秒') : '检查间隔待完善';
      const pageSize = Number.isSafeInteger(count) && count >= 1 && count <= 50 ? count + ' 条/页' : '每页条数待完善';
      const filtered = !!(include.value.trim() || exclude.value.trim())
        || ['originals', 'reposts', 'replies', 'quotes'].some((role) => !row.querySelector('[data-role=' + role + ']').checked);
      summaryMeta.textContent = frequency + ' · ' + pageSize + ' · ' + (filtered ? '已设置筛选' : '全部内容');
    };
    row.addEventListener('input', refreshSummary);
    row.addEventListener('change', refreshSummary);
    refreshSummary();
    return row;
  }
  function editorIdentity(row) {
    const type = row.querySelector('[data-role=type]')?.value;
    const value = row.querySelector('[data-role=name]')?.value.trim();
    const mode = row.querySelector('[data-role=mode]')?.value;
    if (!type || !value) return null;
    return JSON.stringify(type === 'user' ? [type, value.replace(/^@/, '').toLowerCase(), mode || 'posts'] : [type, value]);
  }
  function renderAcctRows(list) {
    const box = $('acct-list');
    const opened = new Set([...box.querySelectorAll('.acct-row')].filter((row) => row.open).map(editorIdentity).filter(Boolean));
    box.textContent = '';
    (list || []).forEach((a) => { const row = makeAcctRow(a); if (opened.has(editorIdentity(row))) row.open = true; box.appendChild(row); });
    renderQueryControls();
  }
  function collectAccounts() {
    const out = [];
    $('acct-list').querySelectorAll('.acct-row').forEach((r) => {
      const get = (role) => r.querySelector('[data-role=' + role + ']');
      const type = get('type').value; const value = get('name').value.trim();
      if (!value) {
        if (r.dataset.existing === 'true') invalidSetting(get('name'), '已有账号的用户名不能为空；其他来源也需填写标识。如需删除，请点击该行的删除按钮');
        return;
      }
      if (type === 'user' && !/^@?[A-Za-z0-9_]{1,15}$/.test(value)) invalidSetting(get('name'), '用户名需为 1–15 位字母、数字或下划线');
      if (type === 'list' && !/^[1-9]\d{0,31}$/.test(value)) invalidSetting(get('name'), 'List ID 需为不以 0 开头的数字');
      for (const [role, label, min, max] of [['fc', '每页条数', 1, 50], ['iv', '检查频率', 30, 3600]]) {
        const input = get(role), number = Number(input.value);
        if (!Number.isSafeInteger(number) || number < min || number > max) invalidSetting(input, label + '需为 ' + min + '–' + max + ' 的整数');
      }
      const keywords = (role) => get(role).value.split(/[,，]/).map((word) => word.trim()).filter(Boolean);
      const filters = { include: keywords('include'), exclude: keywords('exclude') };
      ['originals', 'reposts', 'replies', 'quotes'].forEach((key) => { filters[key] = get(key).checked; });
      const source = type === 'user' ? { username: value.replace(/^@/, ''), source_type: 'user', timeline_mode: get('mode').value }
        : type === 'list' ? { source_type: 'list', list_id: value } : { source_type: 'search', query: value };
      out.push({ ...source, fetch_count: Number(get('fc').value), check_interval: Number(get('iv').value), filters });
    });
    return out;
  }
  $('btn-add-acct').onclick = () => {
    const r = makeAcctRow(); $('acct-list').appendChild(r); r.querySelector('input').focus(); markSettingsDirty(); renderQueryControls();
  };
  $('settings').addEventListener('input', (e) => {
    if (!e.target || !e.target.matches('input, select')) return;
    if (AI_FIELDS.includes(e.target.id)) clearAiTest();
    if (e.target.closest('#acct-list') || e.target.closest('#session-list')
      || ['tg_chat_id', 'media_mode', 'enrichment_mode', 'enrichment_limit', ...SECRET_FIELDS, ...AI_FIELDS].includes(e.target.id)) markSettingsDirty();
  });
  $('settings').addEventListener('change', (e) => {
    if (e.target?.matches('select') && e.target.id !== 'settings-category') markSettingsDirty();
  });

  function renderSessionRows(sessions, flags = {}) {
    const box = $('session-list'); box.textContent = '';
    sessions.forEach((session) => box.appendChild(makeSessionRow(session, flags[session.id])));
    renderQueryControls();
  }
  function makeSessionRow(session, flags = {}) {
    const existing = !!session?.id; session = session || { id: '', label: '', enabled: true };
    const row = el('div', 'session-row'); row.dataset.existing = existing ? 'true' : 'false';
    const id = field('id', session.id, '会话 ID'); id.maxLength = 32; id.placeholder = '会话 ID，例如 backup'; id.readOnly = existing;
    const label = field('label', session.label, '会话名称'); label.maxLength = 80; label.placeholder = '显示名称';
    const enabled = field('enabled', '', '启用会话', 'checkbox'); enabled.checked = session.enabled !== false;
    const enabledLabel = el('label', 'check-label'); enabledLabel.append(enabled, document.createTextNode('启用此会话'));
    const del = el('button', 'btn-x', '✕'); del.type = 'button'; del.setAttribute('aria-label', '删除此会话与凭据');
    del.onclick = () => { row.remove(); markSettingsDirty(); };
    const main = el('div', 'session-main'); main.append(id, del); row.append(main, label, enabledLabel);
    for (const [key, present] of [['auth_token', flags.hasAuthToken], ['ct0', flags.hasCt0]]) {
      const input = field(key, '', key, 'password'); input.autocomplete = 'new-password'; input.maxLength = 4096;
      input.placeholder = present ? '已保存，留空保留' : '填写 ' + key; row.appendChild(labelled(key, input));
    }
    const proxy = field('proxy', session.proxy_url || '', '显式 HTTP(S) 代理', 'url'); proxy.maxLength = 2048;
    proxy.placeholder = '可选，例如 http://127.0.0.1:8080'; row.appendChild(labelled('代理地址', proxy));
    const button = el('button', 'btn-ghost btn-sm', '验证此会话'); button.type = 'button'; button.setAttribute('data-query', 'true');
    button.onclick = () => { const sessionId = id.value.trim(); return runXQuery(button, 'api/test/session',
      () => ({ session_id: sessionId, username: $('session-test-user').value.trim().replace(/^@/, '') }), showXResult); };
    row.appendChild(button); return row;
  }
  function collectSessions() {
    const metadata = []; const secrets = {};
    $('session-list').querySelectorAll('.session-row').forEach((row) => {
      const get = (role) => row.querySelector('[data-role=' + role + ']');
      const id = get('id').value.trim();
      if (!id) invalidSetting(get('id'), '请填写会话 ID，或删除未使用的会话行');
      validateNativeSetting(get('proxy'), '代理地址');
      metadata.push({ id, label: get('label').value.trim() || id, enabled: get('enabled').checked, proxy_url: get('proxy').value.trim() });
      const authToken = get('auth_token').value.trim(), ct0 = get('ct0').value.trim();
      if (authToken || ct0) Object.defineProperty(secrets, id, { enumerable: true, value: {
        ...(authToken ? { auth_token: authToken } : {}), ...(ct0 ? { ct0 } : {}) } });
    });
    return { metadata, secrets };
  }
  $('btn-add-session').onclick = () => {
    if ($('session-list').querySelectorAll('.session-row').length >= 10) return toast('最多添加 10 个额外登录会话', 'err');
    const row = makeSessionRow(); $('session-list').appendChild(row); row.querySelector('input').focus(); markSettingsDirty(); renderQueryControls();
  };
  function dateLabel(value) {
    const timestamp = typeof value === 'string' ? Date.parse(value) : value;
    return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toLocaleString('zh-CN') : '尚未记录';
  }
  function renderDiagnostics() {
    const diagnostic = statusData.diagnostics || {};
    const health = $('session-health');
    const abnormalities = [], successful = [];
    const current = statusIsFresh(lastStatusAt);
    const sessionList = [{ id: 'default', label: '默认会话', enabled: true }, ...sessionsCfg];
    const healthSignature = JSON.stringify({ sessions: diagnostic.sessions, sessionList, current,
      cooling: sessionList.map((session) => Number(diagnostic.sessions?.[session.id]?.rateLimitedUntil || 0) > Date.now()) });
    const refreshHealth = renderDiagnostics.healthSignature !== healthSignature;
    if (refreshHealth) { health.textContent = ''; renderDiagnostics.healthSignature = healthSignature; }
    const labels = { healthy: '最近请求成功', ready: '最近请求成功', unknown: '等待验证', unconfigured: '凭据未配齐',
      'rate-limited': '限流冷却中', 'auth-required': '请更新 Cookie', 'network-error': '网络异常', 'upstream-error': 'X 接口异常', disabled: '已停用' };
    for (const session of sessionList) {
      const entry = diagnostic.sessions?.[session.id] || {};
      const cooling = Number(entry.rateLimitedUntil || 0) > Date.now();
      const state = session.enabled === false ? '已停用' : cooling ? '限流冷却中'
        : labels[entry.status] || '等待验证';
      if (session.enabled !== false) {
        if (cooling || ['rate-limited', 'auth-required', 'network-error', 'upstream-error', 'unconfigured'].includes(entry.status)) {
          abnormalities.push(session.label + '：' + state);
        }
        if (entry.lastSuccessAt && configuredSessionIds.has(session.id)) successful.push(entry.lastSuccessAt);
      }
      if (refreshHealth) {
        const row = el('div');
        row.appendChild(el('strong', '', session.label + ' · ' + (!current && diagnostic.sessions?.[session.id] ? '上次记录：' : '') + state));
        row.appendChild(el('div', '', '最近成功：' + dateLabel(entry.lastSuccessAt)));
        if (entry.lastFailureAt) row.appendChild(el('div', '', '最近失败：' + dateLabel(entry.lastFailureAt)));
        if (entry.nextRetryAt || entry.rateLimitedUntil) row.appendChild(el('div', '', '下次重试：' + dateLabel(entry.nextRetryAt || entry.rateLimitedUntil)));
        if (entry.lastError) row.appendChild(el('div', 'diagnostic-error', String(entry.lastError).slice(0, 500)));
        health.appendChild(row);
      }
    }
    if ($('session-summary')) {
      const summary = $('session-summary');
      summary.dataset.state = abnormalities.length ? 'warning' : !current || !diagnostic.sessions ? 'unknown' : successful.length ? 'known' : 'unknown';
      const base = !current || !diagnostic.sessions ? '会话状态待确认'
        : '已配置 ' + configuredSessionIds.size + ' · 最近成功 ' + successful.length
          + (successful.length ? '' : ' · 等待验证');
      summary.textContent = base + (abnormalities.length ? '；' + abnormalities.join('；') : '');
    }
    const progress = $('backfill-progress');
    const jobs = Object.values(diagnostic.backfills || {}).filter((job) => job && typeof job === 'object');
    const errors = jobs.filter((job) => job.error).length;
    progress.textContent = !current || !diagnostic.backfills ? '补采状态待确认' : !jobs.length ? '无待补采'
      : jobs.length + ' 个任务' + (errors ? ' · ' + errors + ' 个异常' : '') + ' · 详情见来源卡片';
    progress.dataset.state = !current || !diagnostic.backfills ? 'unknown' : errors ? 'warning' : jobs.length ? 'pending' : 'clear';
    if ($('overview-ai')) {
      $('overview-ai').textContent = !loadedAiSettings ? '配置待载入' : !loadedAiSettings.enabled ? '未启用'
        : !loadedAiSettings.configured ? '已启用 · 配置未完整' : statusData.runtime?.translationEnabled !== true
          ? '已配置启用 · 当前模式禁止请求' : '已配置启用 · 连通性请使用 hi 测试';
    }
    if ($('overview-delivery')) {
      const total = pendingTotal();
      $('overview-delivery').textContent = total === null ? '队列状态待确认'
        : (total ? total + ' 条待发送' : '无待发送消息')
          + (statusData.paused || statusData.controlPending ? ' · 已暂停' : statusData.runtime?.deliveryEnabled !== true ? ' · 当前模式禁止投递' : '');
      $('overview-delivery').dataset.state = total === null ? 'unknown' : total > 0 ? 'pending' : 'clear';
    }
  }
  function renderQueryControls() {
    const disabled = configSaveInFlight || !!testRequests.collector || statusData.runtime?.collectionEnabled !== true;
    $('settings').querySelectorAll('[data-query]').forEach((button) => { button.disabled = disabled; });
  }
  async function runXQuery(button, endpoint, getBody, show) {
    if (!panelActive || statusData.runtime?.collectionEnabled !== true || testRequests.collector || configSaveInFlight) return;
    const request = { generation: panelGeneration, controller: new AbortController(), button, label: button.textContent,
      tab: selectedSettingsTab, viewGeneration: settingsViewGeneration };
    const current = () => panelActive && request.generation === panelGeneration && testRequests.collector === request;
    testRequests.collector = request; button.textContent = '查询中…'; renderTop();
    const timeout = setTimeout(() => request.controller.abort(), 100000);
    try {
      const options = { generation: request.generation, signal: request.controller.signal };
      const saved = await saveDraftForTest(options);
      if (!current() || statusData.runtime?.collectionEnabled !== true) return;
      if (saved.warnings?.length) throw new Error('配置未完全保存：' + saved.warnings.join('；'));
      const result = await api('POST', endpoint, { ...getBody(), config_revision: configRevision }, options);
      if (current()) show(result, { reveal: request.tab === selectedSettingsTab && request.viewGeneration === settingsViewGeneration });
    } catch (error) { if (current()) toast(error.message, 'err'); }
    finally {
      clearTimeout(timeout);
      if (current()) { testRequests.collector = null; button.textContent = request.label; renderTop(); }
    }
  }
  function showXResult(result, options = {}) {
    const box = $('x-test-result'); box.classList.remove('hidden');
    box.textContent = (result.ok ? '成功：' : '未完成：') + (result.message || result.error || (result.ok ? '本次请求已完成' : result.code || '查询失败'));
    if (options.reveal) revealSettingsControl(box);
    toast(box.textContent, result.ok ? 'ok' : 'err');
  }
  function showTweetResult(result, options = {}) {
    const box = $('inspect-result'); box.classList.remove('hidden'); box.textContent = '';
    if (options.reveal) revealSettingsControl(box);
    if (!result.ok) { box.textContent = result.error || result.message || '查询未完成'; return; }
    const tweets = Array.isArray(result.tweets) ? result.tweets : [];
    box.appendChild(el('div', '', '取得 ' + tweets.length + ' 条记录；展示最多 50 条，不代表完整对话。'));
    tweets.slice(0, 50).forEach((tweet) => {
      const row = el('div', 'query-tweet'); row.appendChild(el('strong', '', '@' + (tweet.author_username || '未知作者') + ' · ' + tweet.id));
      row.appendChild(el('div', '', String(tweet.text || '').slice(0, 8000)));
      const content = tweet.content || {};
      if (content.quoted) row.appendChild(el('div', 'mt-12', '引用' + (content.quoted.author_username ? ' @' + content.quoted.author_username : '')
        + '\n' + String(content.quoted.text ?? '引用正文不可用').slice(0, 8000)));
      if (content.article) row.appendChild(el('div', 'mt-12', '文章：' + String(content.article.title || '').slice(0, 500)
        + '\n' + String(content.article.text ?? content.article.previewText ?? '正文未提供').slice(0, 8000)));
      for (const media of (Array.isArray(content.media) ? content.media : []).slice(0, 10)) {
        try {
          const url = new URL(media.url);
          if (url.protocol !== 'https:' || !['pbs.twimg.com', 'video.twimg.com'].includes(url.hostname)
            || url.username || url.password || (url.port && url.port !== '443')) continue;
          const link = el('a', 'media-link', ({ photo: '图片', video: '视频', animated_gif: '动图' }[media.type] || '媒体') + ' · 点击查看');
          link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.appendChild(link);
        } catch (_) { /* A malformed optional URL must never become executable markup. */ }
      }
      if (/^[1-9]\d{0,31}$/.test(tweet.id)) {
        const link = el('a', '', '在 X 查看'); link.href = 'https://x.com/i/status/' + tweet.id; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.appendChild(link);
      }
      box.appendChild(row);
    });
  }
  $('btn-test-default-session').onclick = () => runXQuery($('btn-test-default-session'), 'api/test/session',
    () => ({ session_id: 'default', username: $('session-test-user').value.trim().replace(/^@/, '') }), showXResult);
  for (const kind of ['detail', 'thread']) $('btn-inspect-' + kind).onclick = () => {
    const id = $('inspect-tweet-id').value.trim();
    return runXQuery($('btn-inspect-' + kind), 'api/inspect/tweet', () => ({ id, kind }), showTweetResult);
  };
  $('btn-list-preview').onclick = () => {
    const listId = $('import-list-id').value.trim();
    return runXQuery($('btn-list-preview'), 'api/list/members', () => ({ list_id: listId }), (result) => {
      const box = $('list-preview'); box.textContent = ''; box.classList.remove('hidden'); $('btn-list-import').classList.add('hidden');
      if (!result.ok) { box.textContent = result.error || result.message || '成员查询未完成'; return; }
      const members = (Array.isArray(result.members) ? result.members : []).filter((m) => /^[A-Za-z0-9_]{1,15}$/.test(m.username));
      box.appendChild(el('div', '', 'List ' + listId + '：' + members.length + ' 个成员' + (result.complete ? '' : '（当前仅为部分结果）')));
      members.slice(0, 1000).forEach((member) => {
        const input = field('member', member.username, '@' + member.username, 'checkbox'); input.checked = false;
        const label = el('label', 'check-label'); label.append(input, document.createTextNode('@' + member.username + (member.name ? ' · ' + member.name : ''))); box.appendChild(label);
      });
      $('btn-list-import').classList.toggle('hidden', members.length === 0);
    });
  };
  $('btn-list-import').onclick = () => {
    try {
      if (configSaveInFlight) return;
      const existing = collectAccounts(); const seen = new Set(existing.filter((a) => a.source_type === 'user' && a.timeline_mode !== 'replies').map((a) => a.username.toLowerCase()));
      const selected = [...$('list-preview').querySelectorAll('[data-role=member]')].filter((input) => input.checked).map((input) => input.value);
      const additions = selected.filter((username) => { const key = username.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
      if (existing.length + additions.length > 100) throw new Error('导入后超过 100 个来源上限，请减少勾选');
      additions.forEach((username) => $('acct-list').appendChild(makeAcctRow({ username, fetch_count: 10, check_interval: 300 })));
      if (additions.length) markSettingsDirty(); renderQueryControls(); toast('已将 ' + additions.length + ' 个账号加入草稿，请保存', 'ok');
    } catch (error) { toast(error.message, 'err'); }
  };

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
  [...SECRET_FIELDS, 'old_pw', 'new_pw', 'new_pw2'].forEach(addReveal);
  function refreshReveal(id) { const e2 = $(id); if (e2 && e2._revealSync) e2._revealSync(); }

  function collectPayload() {
    for (const [id, label] of [['ai_base_url', 'AI 接口地址'], ['tg_chat_id', 'Telegram Chat ID'], ['ai_model', 'AI 模型']]) {
      validateNativeSetting($(id), label);
    }
    const aiIssue = aiValidationIssue();
    if (aiIssue) invalidSetting(aiIssue.control, aiIssue.message);
    const enrichmentLimit = Number($('enrichment_limit').value);
    if (!Number.isSafeInteger(enrichmentLimit) || enrichmentLimit < 1 || enrichmentLimit > 5) invalidSetting($('enrichment_limit'), '背景补充数量需为 1–5 的整数');
    const sessions = collectSessions();
    const p = { tg_chat_id: $('tg_chat_id').value.trim(), accounts: collectAccounts(),
      media_mode: $('media_mode').value, enrichment_mode: $('enrichment_mode').value,
      enrichment_limit: Number($('enrichment_limit').value), x_sessions: sessions.metadata, x_session_secrets: sessions.secrets,
      ai_translation_enabled: $('ai_translation_enabled').checked,
      ai_base_url: $('ai_base_url').value.trim(), ai_model: $('ai_model').value.trim(),
      clear_ai_api_key: $('clear_ai_api_key').checked };
    if (Number.isSafeInteger(configRevision)) p.config_revision = configRevision;
    const at = $('auth_token').value.trim(), ct = $('ct0').value.trim(), bt = $('tg_bot_token').value.trim();
    if (at) p.auth_token = at; if (ct) p.ct0 = ct; if (bt) p.tg_bot_token = bt;
    if ($('ai_api_key').value.trim()) p.ai_api_key = $('ai_api_key').value.trim();
    return p;
  }
  function setConfigEditorDisabled(disabled) {
    const selector = '#tg_chat_id, #auth_token, #ct0, #tg_bot_token, #ai_translation_enabled, #ai_base_url, #ai_model, #ai_api_key, #clear_ai_api_key, #acct-list input, #acct-list select, #acct-list button, #session-list input, #session-list button, #media_mode, #enrichment_mode, #enrichment_limit, #btn-add-session, #btn-list-import, #btn-add-acct, #btn-detect-collector, #btn-save';
    $('settings').querySelectorAll(selector).forEach((control) => { control.disabled = disabled; });
    $('btn-detect-collector').disabled = disabled || collectorDetectInFlight;
    renderAiTestControl();
    renderQueryControls();
  }
  function sourceIdentity(source) {
    const type = source.source_type || 'user';
    return JSON.stringify(type === 'search' ? [type, source.query?.trim()]
      : type === 'list' ? [type, source.list_id]
        : ['user', (source.username || '').replace(/^@/, '').toLowerCase(), source.timeline_mode || 'posts']);
  }
  function removedPendingSources(accounts) {
    const identities = new Set(accounts.map(sourceIdentity));
    return accountsCfg.filter((source) => !identities.has(sourceIdentity(source))).map((source) => {
      const key = accountKey(source);
      const count = statusData.diagnostics?.pendingCounts?.[key] ?? statusData.accounts?.[key]?.pendingCount ?? 0;
      return { source_key: key, pendingCount: count };
    }).filter((source) => Number.isSafeInteger(source.pendingCount) && source.pendingCount > 0);
  }
  function confirmPendingRemoval(sources) {
    if (!Array.isArray(sources) || !sources.length || sources.some((source) => typeof source?.source_key !== 'string'
      || !Number.isSafeInteger(source.pendingCount) || source.pendingCount <= 0)) {
      throw new Error('无法核对待发送队列，请重新载入后再保存');
    }
    const lines = sources.map((item) => {
      const source = accountsCfg.find((entry) => accountKey(entry) === item.source_key);
      return (source ? accountLabel(source) : item.source_key) + '：' + item.pendingCount + ' 条待发送消息';
    });
    if (!window.confirm('本次保存会删除或替换以下来源，并移除其尚未发送的队列：\n\n' + lines.join('\n')
      + '\n\n替换后的来源将建立新基线。若要保留旧队列，请取消并新增一行。确认移除这些队列并保存？')) {
      throw new Error('已取消保存，来源草稿和待发送队列已保留');
    }
  }
  async function saveConfig(request = {}) {
    if (configSaveInFlight) throw new Error('配置正在保存，请稍候');
    if (remoteConfigPending) throw new Error('配置已在其他标签页更新，请先关闭设置载入新版本');
    const generation = panelGeneration;
    // Validate every tab while fields can still receive focus and native validity hints.
    const payload = collectPayload();
    const removed = removedPendingSources(payload.accounts);
    if (removed.length) { confirmPendingRemoval(removed); payload.discard_removed_pending = true; }
    configSaveInFlight = true;
    let rejectedTarget = null;
    renderSaveState();
    setConfigEditorDisabled(true);
    try {
      const options = { generation, signal: request.signal };
      let r;
      try { r = await api('POST', 'api/config', payload, options); }
      catch (error) {
        if (error.code !== 'PENDING_REMOVAL_REQUIRES_CONFIRMATION') throw error;
        // Newly queued messages may be absent from the last status frame. The
        // server refuses the save first and supplies the authoritative counts.
        confirmPendingRemoval(error.removedPending);
        if (!panelActive || generation !== panelGeneration || request.signal?.aborted) throw new Error('请求已取消');
        r = await api('POST', 'api/config', { ...payload, discard_removed_pending: true }, options);
      }
      SECRET_FIELDS.forEach((id) => { $(id).value = ''; });
      SECRET_FIELDS.forEach(refreshReveal);
      await loadConfig();
      if (!panelActive || generation !== panelGeneration) throw new Error('已忽略旧会话响应');
      settingsSaved = true;
      renderAll();
      return r;
    } catch (e) {
      if (generation === panelGeneration && e.status === 400) rejectedTarget = serverValidationTarget(e.message);
      if (generation === panelGeneration && e.status === 409 && e.code !== 'PENDING_REMOVAL_REQUIRES_CONFIRMATION') noteRemoteConfigConflict();
      throw e;
    } finally {
      if (generation === panelGeneration) {
        configSaveInFlight = false;
        renderSaveState();
        setConfigEditorDisabled(false);
        if (rejectedTarget && !$('settings').classList.contains('hidden')) {
          if (rejectedTarget.control) revealSettingsControl(rejectedTarget.control, true);
          else if (rejectedTarget.panel) selectSettingsTab(rejectedTarget.panel, true);
        }
        // 保存等待期间允许关闭抽屉。若 409 冲突在关闭后才返回，closeSettings() 当时还看不到
        // remoteConfigPending；这里必须主动追赶远端版本，不能让隐藏表单和账号卡片长期停在旧配置。
        const closedConflict = remoteConfigPending && $('settings').classList.contains('hidden');
        if (closedConflict) settingsDirty = false;
        if (configReloadRequested || closedConflict) {
          reloadConfigFromStream(remoteConfigRevision);
        }
      }
    }
  }
  async function saveDraftForTest(request) {
    if (remoteConfigPending) throw new Error('配置已在其他标签页更新，请先关闭设置载入新版本');
    return settingsDirty ? saveConfig(request) : { warnings: [] };
  }
  $('btn-save').onclick = async () => {
    if (!settingsDirty) { toast('配置没有变化', 'ok'); return; }
    const generation = panelGeneration;
    try {
      const r = await saveConfig();
      if (panelActive && generation === panelGeneration) toast(r.warnings && r.warnings.length ? '⚠ ' + r.warnings.join('；') : '✅ 配置已保存', r.warnings && r.warnings.length ? 'err' : 'ok');
    }
    catch (e) { if (panelActive && generation === panelGeneration) toast(e.message, 'err'); }
  };
  async function runConfigTest(kind, buttonId) {
    const allowed = () => kind === 'collector' ? statusData.runtime?.collectionEnabled === true : statusData.runtime?.deliveryEnabled === true;
    if (!panelActive || !allowed() || testRequests[kind]) return;
    const button = $(buttonId);
    const request = { generation: panelGeneration, controller: new AbortController(), button, label: button.textContent };
    const current = () => panelActive && request.generation === panelGeneration && testRequests[kind] === request;
    testRequests[kind] = request;
    button.disabled = true;
    button.textContent = '测试中…';
    try {
      // 无改动时不要做一次空保存：空保存也会推进 revision 并取消 worker 在途任务。
      const options = { generation: request.generation, signal: request.controller.signal };
      const saved = await saveDraftForTest(options);
      if (!current() || !allowed()) return;
      if (saved.warnings && saved.warnings.length) throw new Error('配置未完全保存：' + saved.warnings.join('；'));
      const r = await api('POST', 'api/test/' + kind, {}, options);
      if (current()) toast((r.ok ? '✅ ' : '❌ ') + r.message, r.ok ? 'ok' : 'err');
    }
    catch (e) { if (current()) toast(e.message, 'err'); }
    finally {
      if (current()) {
        testRequests[kind] = null;
        button.textContent = request.label;
        renderTop();
      }
    }
  }
  $('btn-test-collector').onclick = () => runConfigTest('collector', 'btn-test-collector');
  $('btn-test-tg').onclick = () => runConfigTest('telegram', 'btn-test-tg');

  function renderAiTestControl() {
    const allowed = statusData.runtime?.translationEnabled === true;
    const button = $('btn-test-ai');
    button.disabled = !panelActive || !allowed || configSaveInFlight || !!aiTestRequest;
    button.textContent = aiTestRequest ? '发送中…' : '发送 hi 测试';
    button.title = allowed ? '' : '仅在 live 模式下允许请求 AI';
  }
  function showAiTestResult(message, kind) {
    const result = $('ai-test-result');
    result.textContent = message;
    result.className = 'ai-test-result' + (kind ? ' ' + kind : '');
    result.setAttribute('aria-busy', String(kind === 'pending'));
    if (kind !== 'pending' && result.closest('[data-settings-panel]')?.classList.contains('hidden')) {
      toast('AI 测试已完成，可在设置的“推送”页查看回复', kind);
    }
  }
  function clearAiTest() {
    if (aiTestRequest) {
      aiTestRequest.controller.abort();
      clearTimeout(aiTestRequest.timeout);
      aiTestRequest = null;
    }
    const result = $('ai-test-result');
    result.textContent = '';
    result.className = 'ai-test-result hidden';
    result.setAttribute('aria-busy', 'false');
    renderAiTestControl();
  }
  $('btn-test-ai').onclick = async () => {
    if (!panelActive || statusData.runtime?.translationEnabled !== true || configSaveInFlight || aiTestRequest) return;
    // This endpoint tests only the AI draft. It must never save unrelated settings or enable translation.
    const body = {
      config_revision: configRevision,
      ai_base_url: $('ai_base_url').value.trim(),
      ai_model: $('ai_model').value.trim(),
      clear_ai_api_key: $('clear_ai_api_key').checked,
    };
    if ($('ai_api_key').value.trim()) body.ai_api_key = $('ai_api_key').value.trim();
    if (!body.ai_model) { showAiTestResult('测试失败：请先填写模型名称', 'err'); return; }
    const request = { generation: panelGeneration, controller: new AbortController(), timeout: null };
    const current = () => panelActive && request.generation === panelGeneration && aiTestRequest === request;
    aiTestRequest = request;
    renderAiTestControl();
    showAiTestResult('正在发送 hi，等待 AI 回复…', 'pending');
    request.timeout = setTimeout(() => {
      if (!current()) return;
      request.controller.abort();
      aiTestRequest = null;
      showAiTestResult('测试失败：等待 AI 回复超时，请稍后重试', 'err');
      renderAiTestControl();
    }, 20000);
    try {
      const r = await api('POST', 'api/test/ai', body, { generation: request.generation, signal: request.controller.signal });
      if (!current()) return;
      if (!r.ok) { showAiTestResult('测试失败：' + (r.message || '未取得有效回复'), 'err'); return; }
      const timing = Number.isFinite(r.elapsedMs) && r.elapsedMs >= 0 ? '（' + Math.round(r.elapsedMs) + ' 毫秒）' : '';
      showAiTestResult('测试成功' + timing + '\nAI 回复：\n' + r.reply, 'ok');
    } catch (e) {
      if (current()) showAiTestResult('测试失败：' + e.message, 'err');
    } finally {
      clearTimeout(request.timeout);
      if (current()) { aiTestRequest = null; renderAiTestControl(); }
    }
  };

  let controlInFlight = false;
  async function setPaused(action) {
    if (controlInFlight) return;
    controlInFlight = true;
    $('btn-pause').disabled = true; $('btn-resume').disabled = true;
    try {
      const r = await api('POST', 'api/control', { action });
      statusData.paused = !!r.paused;
      statusData.controlPending = false;
      renderTop();
    } catch (e) {
      if (e.controlPending) {
        statusData.paused = true;
        statusData.controlPending = true;
        statusData.running = false;
        renderTop();
      }
      toast(e.message, 'err');
    }
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
