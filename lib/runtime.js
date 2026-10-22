'use strict';

// Startup-only policy: a panel setting cannot enable external IO.
const mode = process.env.TW_RUNTIME_MODE || 'development';
if (!['development', 'read-only', 'live', 'legacy-live'].includes(mode)) {
  throw new Error('TW_RUNTIME_MODE 必须为 development、read-only、live 或 legacy-live');
}
const collectionEnabled = mode !== 'development';
const deliveryEnabled = mode === 'live' || mode === 'legacy-live';
const reason = mode === 'development'
  ? 'v2 开发模式：X 采集与 Telegram 发送已禁用'
  : mode === 'read-only' ? 'v2 只读模式：仅允许手动测试 X 采集；自动监控与 Telegram 发送已禁用' : '';
const policy = Object.freeze({
  mode,
  collector: mode === 'legacy-live' ? 'bird-legacy' : 'twscrape',
  collectionEnabled,
  deliveryEnabled,
  schedulingEnabled: deliveryEnabled,
  reason,
});

function status() { return policy; }
function blocked(operation = 'collection') {
  const enabled = operation === 'collection' ? collectionEnabled
    : operation === 'delivery' ? deliveryEnabled
      : operation === 'scheduling' ? policy.schedulingEnabled
        : operation === 'legacy' ? mode === 'legacy-live' : false;
  return enabled ? null : {
    ok: false, disabled: true, code: 'RUNTIME_DISABLED',
    message: reason || '当前运行模式禁止此操作', error: reason || '当前运行模式禁止此操作',
  };
}

module.exports = { status, blocked };
