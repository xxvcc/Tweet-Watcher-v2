# 第二代部署模板

这里的模板属于 v2。`deploy/` 根目录保留的 Nginx/systemd 配置属于第一代，不要覆盖现有生产实例。

## 独立实例

模板采用代码 `/opt/tweet-watcher-v2`、用户 `tweet-watcher-v2`、数据 `/var/lib/tweet-watcher-v2`、回环端口 8788。先安装 Node.js 22+、Python 3.11+ 和 venv。按仓库锁文件执行 `npm ci --ignore-scripts`、`npm run collector:install` 和 `npm run verify`。代码/依赖只需服务用户可读可执行，运行数据才需要可写；安装器不会复制任何生产秘密。

创建专用系统用户，将模板中的 Node 路径核对为实际安装路径，再安装 `tweet-watcher-v2.service`。systemd 会创建 0700 状态目录。首次启动保持 `read-only`；在服务端自己的终端查看一次性初始化令牌并设置密码，不把日志贴到公共渠道。

模板是可选部署资源。本轮没有安装该 systemd 服务，没有配置第二代公网域名，也没有切换第一代。

## 访问来源

首选 SSH/VS Code 转发 `127.0.0.1:8788`。如需公网访问，为 v2 配置独立 HTTPS 来源，并在私有 `/etc/tweet-watcher-v2/runtime.conf` 设置 `PUBLIC_ORIGIN=https://你的独立域名`。不得与 WordPress 或第一代管理面板共用来源。

反向代理必须传入固定 Host，与 PUBLIC_ORIGIN 一致；防止客户端覆盖它。若需要识别真实客户端 IP/HTTPS，设置随机的 `TRUST_PROXY_TOKEN`（32–256 字节），代理覆盖 `X-Tweet-Watcher-Proxy-Token` 为相同值、覆盖 `X-Forwarded-Proto`，并按服务器实际网络拓扑处理 X-Forwarded-For。保持 Node 回环监听；没有受信代理令牌时 Node 不信任客户端伪造的转发头。

不要从第一代原样复制代理 token、登录会话或密码文件。v2 自己初始化这些状态。

## 发送与恢复

在只读模式验证 Cookie 与各目标后，按 [迁移指南](../../docs/MIGRATION.md) 处理生产发送权、队列和水位。只有明确准备好发送时才在 runtime.conf 设置 `TW_RUNTIME_MODE=live` 并重启。

启动模式是进程级控制，暂停状态是用户配置，两者都需要允许调度。Cookie 失效、未知页面、证据写盘失败或追赶超预算会明确报错；不要用清空状态作为默认修复。备份时覆盖整个私有状态目录，保留配套版本，并保护其中的 Cookie、token 和密码哈希。
