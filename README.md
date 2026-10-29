# Tweet Watcher v2

使用 **twscrape 采集 X、通过 Telegram 推送**的中文监控面板。当前版本 **0.2.0-beta.1**，支持账号/回复、List、关键词来源、持续补采和持久媒体投递。本机已部署，并发布 [GitHub 预发布版本](https://github.com/xxvcc/Tweet-Watcher-v2/releases/tag/v0.2.0-beta.1)。默认关闭外部请求，支持独立的只读验证模式。

源自 [Tweet-Watcher v3.5.0](https://github.com/xxvcc/Tweet-Watcher/releases/tag/v3.5.0)，保留历史与 MIT 归属。v2 使用独立目录、凭据、状态与端口。这里的 v2 表示架构代际。

## 功能

- 配置账号帖子/回复、List 或 Latest 搜索来源；支持 List 成员预览导入、帖子类型和关键词筛选。首轮建立基线，后续推送新记录。
- 固定 twscrape 源码提交，Python 负责请求签名和单页传输，Node 严格校验整页与分页覆盖。
- 置顶、回复模块、转发、引用、回复与编辑 ID 保留；置顶和模块不能冒充时间线边界。
- 原始响应证据先持久化，再判断水位。坏页、循环游标、磁盘失败和追赶预算耗尽均不推进水位。
- 持久发送队列支持引用、媒体、Article 与按需对话背景；图片、视频、相册和动画逐部分确认，重启继续未完成部分。采集与投递独立调度。
- 可选 AI 中文翻译：结合正文文字与 X 语言标记，跳过纯中文，将其他语言及混合正文中的外语部分译成简体中文；通过可配置的 OpenAI 兼容接口请求，Telegram 保留原文，翻译失败仍推送原文。见[判断规则与边界](docs/AI_TRANSLATION.md)。
- AI 设置提供“发送 hi 测试”：使用当前填写的地址、模型和 Key 显示 AI 回复及耗时，不保存配置、不启用翻译；仅在 live 模式可用，翻译开关关闭时也能测试。
- 首页统一展示来源、运行概况与活动；设置按五类组织，来源可折叠编辑，手机直接选择分类；支持深浅主题、跨分类草稿和固定保存入口。
- 密码认证、CSRF、独立来源、请求限速及安全响应头沿用第一代安全修复。
- 配置与凭据使用可恢复的事务提交；状态持久化失败停止使用，SSE 静默超时后自动改用 HTTP 刷新。

支持默认 X Cookie 和额外登录会话，按会话与操作管理限流/健康；会话不等于监控目标。可配置受控 HTTP(S) 代理，不提供密码登录或自动验证码。新功能的开关、限制和状态升级见[来源、内容与会话](docs/COLLECTION_FEATURES.md)。

## 启动

需要 **Node.js 22+、Python 3.11+**，Python 需支持 `venv`。在 Linux 上：

```sh
git clone https://github.com/xxvcc/Tweet-Watcher-v2.git
cd Tweet-Watcher-v2
npm ci --ignore-scripts
npm run collector:install
npm run verify
npm start
```

访问 `http://127.0.0.1:8788`，用启动终端的一次性设置令牌创建管理密码。远程主机可使用 VS Code 转发 8788 端口。不要把令牌、Cookie 或密码贴入聊天或 Issue。

| 启动模式 | 手动采集 | 定时监控 | Telegram 发送 | AI 自动翻译 | AI 手动测试 |
|---|---|---|---|---|---|
| 默认 `development` | 关闭 | 关闭 | 关闭 | 关闭 | 关闭 |
| `TW_RUNTIME_MODE=read-only` | 开启 | 关闭 | 关闭 | 关闭 | 关闭 |
| `TW_RUNTIME_MODE=live` | 开启 | 开启 | 开启 | 配置后可开启 | 可发送 hi 测试 |

先使用 `TW_RUNTIME_MODE=read-only npm start`，在面板保存监控目标和 X 的 `auth_token`、`ct0`，再点击“测试采集”。发送需要显式切换到 `live` 并配置 Bot/Chat ID。模式只能在进程启动时选择，面板不能绕过开关。

`DATA_DIR` 默认是项目内被 Git 忽略的 `data/`；部署时使用本实例独占的私有目录。它会拒绝第一代生产目录、公开静态目录和指向这些目录的软链接。

## 已验证与边界

本版的离线回归、电脑/手机浏览器、真实 X 验证与未验证项目集中记录在[当前验证摘要](docs/VERIFICATION.md)。2026-10-30 的本机升级见[部署记录](docs/archive/2026-10-30-upgrade.md)；本机部署和远程发布分别管理。

已发布 beta.3 曾完成四账号采集、生产交接、Telegram 测试及 AI 多语言验证；本次能力扩展使用独立测试状态。当前正式代码位置见[维护交接](docs/SESSION_HANDOFF.md)，历史结果不替代新媒体真实投递或自然新增推文的端到端验收。

X 网页接口可能改变，Cookie 可能失效；错误会明确显示，不会伪装成“没有新推文”。每轮最多 5 页 / 90 秒；增量缺口按完整页保存并跨轮恢复，单任务上限 100 页 / 1000 条 / 6 MiB / 7 天。超限、坏页或未知覆盖保持旧水位，恢复入口与其他容量限制见功能指南。Telegram 采用至少一次交付：消息发送成功但本地确认前崩溃，恢复时可能重发。

## 文档

- [文档索引](docs/README.md)：当前指南与历史归档入口
- [开发与配置](docs/DEVELOPMENT.md)、[AI 翻译与 hi 测试](docs/AI_TRANSLATION.md)
- [部署说明](deploy/v2/README.md)、[生产迁移与回退](docs/MIGRATION.md)
- [验证摘要](docs/VERIFICATION.md)、[架构与后续范围](docs/ARCHITECTURE.md)
- [变更记录](CHANGELOG.md)、[安全报告](SECURITY.md)、[CI 状态](.github/CI.md)

第一代历史文档和部署文件请到 [第一代仓库](https://github.com/xxvcc/Tweet-Watcher/tree/v3.5.0) 查看。本目录仅保留第二代运行代码与部署模板。采用 [MIT License](LICENSE)。twscrape 的许可证和固定源码位于 `collector/vendor/`。
