# 第二代工作交接

更新：2026-10-23，当前开发版本 `0.1.0-beta.2`。

用户授权在独立 v2 目录完整开发并充分测试，可直接使用第一代现有 X Cookie 做验证。没有要求接管生产发送或发送真实 Telegram 测试消息；本轮不执行这些操作。

## 目录

- v2：`/www/tweet-watcher-v2` → `https://github.com/xxvcc/Tweet-Watcher-v2`
- v1 生产：`/www/tweet-watcher`，服务 `tweet-watcher.service`
- v1 开发：`/www/tweet-watcher-v1-dev`
- VS Code 多目录工作区：`/www/tweet-watcher-development.code-workspace`

源码从第一代 v3.5.0 派生，保留历史和 MIT。v2 仅保留自己的 origin remote，不与旧版共享可写 Git 对象或运行数据。

## 已实现

Python 桥接固定 twscrape 签名/操作源码和 wheel 哈希，Node 完成严格整页解析、受限翻页与私有证据持久化。真实 Cookie 只读验证首轮 20 条、追赶 39 条 / 2 页，水位覆盖成功。没有把 Cookie 写入仓库，也未导入 Telegram 凭据。

面板、调度和持久 outbox 已选择新采集器；字符串 ID、引用/回复/转发/编辑关系及长正文保留。默认 development 全部禁外部操作；read-only 只手动采集，关闭调度和发送；live 显式开启完整流程。twscrape 是唯一采集器。旧 Bird 文件/依赖、运行模式、配置字段、API 别名、独有测试、部署模板和文档副本已清理。

完整测试、浏览器证据和具体限制记录在 [VERIFICATION.md](VERIFICATION.md)。开发说明以 [DEVELOPMENT.md](DEVELOPMENT.md) 为准。V2_DEVELOPMENT_PLAN.md 记录当前结构和后续范围；研究目录保留脱敏的历史选型证据，不参与应用运行。

## 本机预览

临时 `tweet-watcher-v2-preview.service` 在 `127.0.0.1:8788` 提供只读面板，DynamicUser、独立 `/var/lib/tweet-watcher-v2-preview`，未导入生产凭据。首次设置令牌由用户自己在终端 `journalctl -u tweet-watcher-v2-preview -n 30 --no-pager` 查看。VS Code 转发 8788 即可访问。此临时预览不随主机重启自动恢复。

## 运行与待办

第一代仍负责生产发送；v2 的生产迁移方案见 [MIGRATION.md](MIGRATION.md)，尚未执行。登录账号池、自动登录、长期历史补采、生产状态一键迁移不属于本版本实现。

CI 模板在 `.github/ci-template.yml`，当前授权无法写 GitHub workflows；离线验证可完整本地运行。代码/远程/预览实际状态应使用 Git 和进程检查，不能仅据本文推断。

保留原 VS Code 对话窗口，在另一个窗口打开 v2 或多目录工作区即可浏览代码。新聊天读取 AGENTS.md、本文与开发指南来恢复项目决策；文件夹切换不保证旧对话自动迁移。
