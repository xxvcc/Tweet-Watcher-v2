'use strict';

// Startup-only policy: a panel setting cannot enable external IO.
const mode = process.env.TW_RUNTIME_MODE || 'development';
if (!['development', 'read-only', 'live'].includes(mode)) {
  throw new Error('TW_RUNTIME_MODE 必须为 development、read-only 或 live');
}
const collectionEnabled = mode !== 'development';
const deliveryEnabled = mode === 'live';
const translationEnabled = mode === 'live';
const reason = mode === 'development'
  ? 'v2 开发模式：X 采集、AI 翻译与 Telegram 发送已禁用'
  : mode === 'read-only' ? 'v2 只读模式：仅允许手动测试 X 采集；自动监控、AI 翻译与 Telegram 发送已禁用' : '';
const policy = Object.freeze({
  mode,
  collector: 'twscrape',
  collectionEnabled,
  deliveryEnabled,
  translationEnabled,
  schedulingEnabled: deliveryEnabled,
  reason,
});

function status() { return policy; }
function blocked(operation = 'collection') {
  const enabled = operation === 'collection' ? collectionEnabled
    : operation === 'delivery' ? deliveryEnabled
      : operation === 'translation' ? translationEnabled
      : operation === 'scheduling' ? policy.schedulingEnabled : false;
  return enabled ? null : {
    ok: false, disabled: true, code: 'RUNTIME_DISABLED',
    message: reason || '当前运行模式禁止此操作', error: reason || '当前运行模式禁止此操作',
  };
}

module.exports = { status, blocked };
