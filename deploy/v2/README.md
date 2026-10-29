# 第二代部署模板

这里的模板只适用于 v2。第一代部署文件已移至其自身仓库维护。

## 独立实例

模板采用代码 `/opt/tweet-watcher-v2`、用户 `tweet-watcher-v2`、数据 `/var/lib/tweet-watcher-v2`、回环端口 8788。先安装 Node.js 22+、Python 3.11+ 和 venv。按仓库锁文件执行 `npm ci --ignore-scripts`、`npm run collector:install` 和 `npm run verify`。代码/依赖只需服务用户可读可执行，运行数据才需要可写；安装器不会复制任何生产秘密。

创建专用系统用户，将模板中的 Node 路径核对为实际安装路径，再安装 `tweet-watcher-v2.service`。systemd 会创建 0700 状态目录。首次启动保持 `read-only`；在服务端自己的终端查看一次性初始化令牌并设置密码，不把日志贴到公共渠道。

运行用户还需能读取数据目录的祖先目录；首次使用会同步目录及祖先目录，文件系统必须支持目录 fsync。已有数据目录如向组或其他用户开放权限会被拒绝，不会由应用自动 chmod。配置保存使用私有 `config_transaction.json` 恢复中断提交；它包含凭据，不能公开，且降级到旧代码前必须先完成未结束的事务。

模板以 8788/只读为默认值，安装时按实例调整。已有生产实例使用独立快照与端口，当前状态见[维护交接](../../docs/SESSION_HANDOFF.md)，首次迁移过程见[历史记录](../../docs/archive/2026-10-29-cutover.md)。AI 自动翻译另由面板开关控制，不能根据首次部署时的值推断当前配置。

## 访问来源

首选 SSH/VS Code 转发 `127.0.0.1:8788`。如需公网访问，为 v2 配置独立 HTTPS 来源，并在私有 `/etc/tweet-watcher-v2/runtime.conf` 设置 `PUBLIC_ORIGIN=https://你的独立域名`。不得与 WordPress 或第一代管理面板共用来源。

反向代理必须传入固定 Host，与 PUBLIC_ORIGIN 一致；防止客户端覆盖它。若需要识别真实客户端 IP/HTTPS，设置随机的 `TRUST_PROXY_TOKEN`（32–256 字节），代理覆盖 `X-Tweet-Watcher-Proxy-Token` 为相同值、覆盖 `X-Forwarded-Proto`，并按服务器实际网络拓扑处理 X-Forwarded-For。保持 Node 回环监听；没有受信代理令牌时 Node 不信任客户端伪造的转发头。

不要从第一代原样复制代理 token、登录会话或密码文件。v2 自己初始化这些状态。

## 发送与恢复

在只读模式验证 Cookie 与各目标后，按 [迁移指南](../../docs/MIGRATION.md) 处理生产发送权、队列和水位。只有明确准备好发送时才在 runtime.conf 设置 `TW_RUNTIME_MODE=live` 并重启。

启动模式是进程级控制，暂停状态是用户配置，两者都需要允许调度。Cookie 失效、未知页面、证据写盘失败或追赶超预算会明确报错；不要用清空状态作为默认修复。备份时覆盖整个私有状态目录，保留配套版本，并保护其中的 Cookie、token 和密码哈希。
