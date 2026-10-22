# Tweet Watcher v2

面向 twscrape 的第二代 X → Telegram 监控工具，当前开发版本为 **0.1.0-alpha.1**。目前完成项目骨架与运行隔离，**twscrape 尚未接入，尚不具备可验收的第二代采集能力**。

本项目源自 [Tweet-Watcher v3.5.0](https://github.com/xxvcc/Tweet-Watcher/releases/tag/v3.5.0)，保留原有 Git 历史、MIT 许可证与归属。这里的 v1/v2 表示架构代际；第一代的软件版本继续使用 3.x，第二代独立编号与维护。

## 当前状态

- 沿用 Node.js 管理面板、认证、调度和持久发送队列，保留其回归测试。
- 默认关闭外部采集和 Telegram 消息发送；配置账号或点击测试按钮不会绕过运行开关。
- 开发服务默认监听 `127.0.0.1:8788`，使用独立数据位置，避免与第一代生产实例共用状态。
- Bird 相关代码与依赖暂留，作为迁移参照和回归基线；它们不是已经完成的 twscrape 适配。
- 后续计划使用 Python 采集器提供受控单页请求，由应用校验完整性、保存证据并管理检查点。
- 本机 Node.js 24 的 157 项测试通过；[自动 CI 模板](.github/CI.md) 已准备，等待 GitHub 工作流权限启用。

## 本地开发

需要 Node.js ≥ 22。首次初始化不需要提供 X Cookie 或 Telegram 凭据。

```bash
git clone https://github.com/xxvcc/Tweet-Watcher-v2.git
cd Tweet-Watcher-v2
npm ci --ignore-scripts
npm test
npm start
```

浏览器访问 `http://127.0.0.1:8788`。首次设置管理密码仍使用启动终端给出的一次性设置令牌；只在自己的终端和浏览器中使用，不要放入 Issue、聊天或提交。远程开发可使用 VS Code 端口转发访问回环地址。

默认 `TW_RUNTIME_MODE=development`；数据存放于本仓库 `data/`，可用 `DATA_DIR` 指定第二代专用路径。详细配置与验证步骤见[开发指南](docs/DEVELOPMENT.md)。本仓库尚未提供可直接替换第一代生产实例的发行版；原有部署说明已归档，不能作为第二代部署操作依据。

## 在 VS Code 中继续开发

保留当前窗口，在新窗口连接同一 SSH 主机并打开 `/www/tweet-watcher-v2`。本机也提供 `/www/tweet-watcher-development.code-workspace`，同时包含两代开发目录。新聊天先读 `AGENTS.md` 和[工作交接](docs/SESSION_HANDOFF.md)；打开新目录不保证现有聊天自动切换工作目录。

## 文档

- [第二代开发方案](docs/V2_DEVELOPMENT_PLAN.md)：两代并行维护、适配与迁移顺序。
- [开发指南](docs/DEVELOPMENT.md)：运行边界、协议要求与验收阶段。
- [工作交接](docs/SESSION_HANDOFF.md)：项目决策与下一步，可用于继续开发。
- [twscrape 研究报告](research/twscrape-20261023/README.md)：固定版本源码审查、离线证据及接入限制。
- [第二代变更记录](CHANGELOG.md)、[贡献指南](CONTRIBUTING.md)、[安全问题报告](SECURITY.md)。
- [第一代历史 README](docs/LEGACY_V1_README.md) 与[历史变更记录](docs/LEGACY_V1_CHANGELOG.md)。

采用 [MIT License](LICENSE)，Copyright (c) 2026 xxvcc。
