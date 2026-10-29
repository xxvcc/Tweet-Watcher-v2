# 隔离拟真演练

这里运行真实 Express、worker、Python 桥接及 twscrape 签名、完整页解析、fsync 存储、队列和 AI/Telegram 请求代码。X、AI、Telegram 的对端由本机 HTTPS 服务模拟，全部账号和 Cookie 为合成值。它不读取生产状态，也不发送真实 Telegram 消息。

## 执行

先按项目指南安装 Node 依赖与 Python 采集器；还需要本机 `openssl`。

```sh
npm run test:simulation
```

依次运行真实 Python 协议/TLS/签名测试、完整链路场景和默认 800 条多来源压力/强杀恢复测试。日志和 JSON 汇总写入命令打印的 `/tmp/twv2-simulation-report-*` 私有目录，失败返回非零退出码。应用临时状态、合成凭据和 TLS 私钥随每个场景关闭而清理。

真实浏览器需要已有 Playwright Core 和 Chromium，可用环境变量指定其安装位置；脚本直接访问实际后端 API，不伪造应用 API 响应：

```sh
PLAYWRIGHT_MODULE=/path/to/playwright-core CHROMIUM_PATH=/path/to/chromium npm run test:simulation:browser
npm run test:simulation:soak
```

`soak` 使用真实时钟、30 秒来源间隔和生产 5 秒调度循环，默认观察约 5 分钟，恢复等待有上限。不会调用手动 tick 或推进逻辑时钟。它是有限时长的调度观察，不能替代整夜或生产长期运行。

可单独执行：

```sh
node --test scripts/simulation/scenarios.cjs
.venv/bin/python scripts/simulation/test_bridge.py -v
node scripts/simulation/stress.cjs --rounds 20 --batch 5 --output /tmp/twv2-stress.json
```

## 保真范围与替代边界

| 环节 | 实际执行 | 测试替代 |
|---|---|---|
| X 请求 | 固定签名算法、桥接 JSON 协议、curl TLS、身份/分页/限流处理 | 合成 bootstrap HTML/JS 与 GraphQL 页面；域名连接映射到本机 TLS |
| AI / Telegram | 实际 URL/表单或 JSON 构造、HTTP 请求、超时与响应验证 | fetch 仅将指定对端映射到本机 TLS，响应由场景控制 |
| 状态 | 真实私有 DATA_DIR、文件写入/rename/fsync、重新读取 | 指定文件操作可注入 EIO 或在前后 SIGKILL |
| 浏览器 | 实际认证、CSRF、配置版本、SSE、API、采集和查看 | 仅外部服务使用合成对端，不使用 `route.fulfill` |
| 主场景与压力 | 实际任务/队列逻辑、所有进程与网络往返 | 显式推进 Date.now；500/2000ms 投递间隔缩至 1/5ms，网络超时不缩短 |
| 实时时钟观察 | 实际生产调度、投递间隔和系统时钟 | 只定时往模拟 X 发布新记录 |

`bridge.py` 是测试专用启动器，生产代码没有增加关闭安全策略或任意重定向的测试开关。TLS 校验保持开启；Python 目标只允许映射 x.com/abs.twimg.com，Node fetch 只允许映射 AI 模拟域名与 Telegram。代理自检使用只向同一本机 TLS 服务转发的 CONNECT 代理。

意外目标请求计数来自这些应用路由检查及浏览器来源检查，未进行操作系统级抓包或全进程出口审计。压力报告的 heap/队列峰值为每轮采样的最大值，不是全程严格上界；`signedRequests` 计数表示包含签名头，完整签名摘要由独立 Python 协议测试校验。

`stress-oracle.cjs` 根据独立生成的预期推文/媒体核对投递，而不是把应用队列中的“已发送”直接当成成功证据。过滤项不能出现在接收端，已经确认的部分不得重发；仅在明确注入“接收方已接受、本地未确认”的强杀窗口允许指定部分重复一次。

## 结果解释

SIGKILL 验证真实进程退出后的恢复，不能证明断电时文件系统行为。模拟对端能验证字段/状态/恢复协议，不能证明 X 搜索完整性、真实账号权限、翻译质量、文章全文、Telegram 文件限制或显示效果。当前实际结果和已修问题见[验证摘要](../../docs/VERIFICATION.md)，每次运行的汇总与原始日志应一并核对。

`scenarios.json` 仅为活动计数，失败场景的清理钩子也可能写入统计；通过与否须读取 `summary.json` 退出码和 `scenarios.log` 的完整测试结果。
