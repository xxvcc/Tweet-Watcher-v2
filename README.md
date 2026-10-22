# Tweet Watcher v2

使用 **twscrape 采集 X、通过 Telegram 推送**的中文监控面板。当前开发版本 **0.1.0-beta.1**，已接通真实采集、分页追赶、管理界面与持久发送队列。默认关闭外部请求，支持独立的只读验证模式。

源自 [Tweet-Watcher v3.5.0](https://github.com/xxvcc/Tweet-Watcher/releases/tag/v3.5.0)，保留历史与 MIT 归属。第一代继续维护；v2 使用独立目录、凭据、状态与端口。这里的 v2 表示架构代际。

## 功能

- 配置多个监控目标、每页条数与检查间隔；首轮建立基线，后续只推送新记录。
- 固定 twscrape 源码提交，Python 负责请求签名和单页传输，Node 严格校验整页与分页覆盖。
- 置顶、回复模块、转发、引用、回复与编辑 ID 保留；置顶和模块不能冒充时间线边界。
- 原始响应证据先持久化，再判断水位。坏页、循环游标、磁盘失败和追赶预算耗尽均不推进水位。
- 持久发送队列支持失败重试与进程重启恢复，保留完整长正文；Telegram 消息按平台长度限制展示。
- 密码认证、CSRF、独立来源、请求限速及安全响应头沿用第一代安全修复。

首次接入使用一个 X Cookie 会话，多个监控目标串行共享该会话。暂未开放 twscrape 多登录账号池、密码登录或自动验证码处理。

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

| 启动模式 | 手动采集 | 定时监控 | Telegram 发送 |
|---|---|---|---|
| 默认 `development` | 关闭 | 关闭 | 关闭 |
| `TW_RUNTIME_MODE=read-only` | 开启 | 关闭 | 关闭 |
| `TW_RUNTIME_MODE=live` | 开启 | 开启 | 开启 |

先使用 `TW_RUNTIME_MODE=read-only npm start`，在面板保存监控目标和 X 的 `auth_token`、`ct0`，再点击“测试采集”。发送需要显式切换到 `live` 并配置 Bot/Chat ID。模式只能在进程启动时选择，面板不能绕过开关。

`DATA_DIR` 默认是项目内被 Git 忽略的 `data/`；部署时使用本实例独占的私有目录。它会拒绝第一代生产目录、公开静态目录和指向这些目录的软链接。

## 已验证与边界

真实只读验证已取得首个完整页 **20 条**，跨页追赶取得 **39 条 / 2 页**并覆盖指定水位；没有发送真实 Telegram 消息。离线测试覆盖认证、队列重启恢复、坏页、限流、Cookie 作用域、重定向和响应上限；浏览器完成首次设置、登录、配置保存及桌面/移动界面检查。最终测试计数和复现命令见[验证记录](docs/VERIFICATION.md)。

X 网页接口可能改变，Cookie 可能失效；错误会明确显示，不会伪装成“没有新推文”。每轮最多 5 页 / 500 条 / 90 秒，超过范围会停止并保留旧水位。长时间停机后的历史补采和生产迁移需要单独核对。Telegram 采用至少一次交付：消息发送成功但本地确认前崩溃，恢复时可能重发。

## 文档

- [开发与配置](docs/DEVELOPMENT.md)、[验证记录](docs/VERIFICATION.md)
- [第二代部署说明](deploy/v2/README.md)、[生产迁移与回退](docs/MIGRATION.md)
- [工作交接](docs/SESSION_HANDOFF.md)、[原始开发方案](docs/V2_DEVELOPMENT_PLAN.md)
- [twscrape 研究](research/twscrape-20261023/README.md)、[采集协议与依赖](collector/README.md)
- [变更记录](CHANGELOG.md)、[安全报告](SECURITY.md)、[CI 状态](.github/CI.md)

第一代文档保存在 `docs/LEGACY_V1_*`；`deploy/` 根目录的旧配置仍属于第一代。采用 [MIT License](LICENSE)。twscrape 的许可证和固定源码位于 `collector/vendor/`。
