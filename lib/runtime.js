'use strict';

// Startup-only policy: changing a panel setting must never enable external IO.
// legacy-live retains the inherited Bird implementation for explicit compatibility
// work. It is not the future twscrape collector.
const mode = process.env.TW_RUNTIME_MODE || 'development';
if (!['development', 'legacy-live'].includes(mode)) {
  throw new Error('TW_RUNTIME_MODE 必须为 development 或 legacy-live');
}
const enabled = mode === 'legacy-live';
const policy = Object.freeze({
  mode,
  collector: 'bird-legacy',
  collectionEnabled: enabled,
  deliveryEnabled: enabled,
  reason: enabled ? '' : 'v2 开发模式：X 采集与 Telegram 发送已禁用，twscrape 尚未接入',
});

function status() { return policy; }
function blocked() {
  return enabled ? null : {
    ok: false, disabled: true, code: 'RUNTIME_DISABLED', message: policy.reason, error: policy.reason,
  };
}

module.exports = { status, blocked };
