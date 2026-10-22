# 第二代开发指南

更新：2026-10-23。版本：`0.1.0-beta.1`。已完成 twscrape 适配与只读真实验证；第一代生产服务继续运行，第二代没有接管生产发送。

## 项目与运行

第二代代码在 `/www/tweet-watcher-v2`，远程 `xxvcc/Tweet-Watcher-v2`。第一代生产在 `/www/tweet-watcher`，第一代开发副本在 `/www/tweet-watcher-v1-dev`。不共享可写数据目录或登录会话存储。

```sh
npm ci --ignore-scripts
npm run collector:install
npm run verify
TW_RUNTIME_MODE=read-only npm start
```

安装器将固定版本及 wheel 哈希写入独立 `.venv`，不使用上游自动更新或源码安装脚本。运行需要 Node.js 22+ / Python 3.11+。Python 的 `--version` 入口验证固定源码哈希和依赖导入，不发起网络请求。面板的“检测采集器”使用该入口。

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT` | `8788` | v2 独立端口 |
| `DATA_DIR` | 项目 `data/` | 本实例独占私有目录，运行用户需有写权限 |
| `TW_RUNTIME_MODE` | `development` | 禁止外部采集、调度和发送 |
| `PUBLIC_ORIGIN` | 未设置 | 公网部署时指定独立 HTTPS 来源 |
| `TRUST_PROXY_TOKEN` | 未设置 | 仅受信任反向代理使用，见部署指南 |

`read-only` 允许手动测试采集，调度和 Telegram 均关闭；`live` 启用 twscrape 调度和发送；`legacy-live` 仅为旧 Bird 回归兼容入口。旧 Bird 低层出口也只接受 `legacy-live`。这些模式不能通过网页配置改变。

配置包含监控目标、每页请求条数（1–50）、检查间隔（30–3600 秒）、暂停状态、Telegram 目标。`bird_path` 只为旧配置迁移兼容保留；新面板不提供任意可执行路径设置。X Cookie 与 Telegram token 仍保存于实例私有 `secrets.json`，不回显已有值。

## 采集结构

```text
面板 / worker
  → lib/twscrape.js（串行会话、90 秒总截止、最多 5 页）
  → collector/bridge.py（stdin JSON；固定 twscrape 签名和操作元数据）
  → X 单页 GraphQL 响应
  → lib/evidence.js（私有证据原子落盘）
  → lib/twscrape-timeline.js（严格整页校验）
  → 完整覆盖后写持久 outbox，再逐条发送与确认
```

使用固定 twscrape 提交 `63f61a518e576ea5c132f1156c03dda0520d76c1`，该提交仍声明 0.20.1，不宣称上游已正式发布 0.21.0。适配器调用其签名算法及 GraphQL 操作/feature 定义；没有使用会静默丢页的高层迭代器、模型解析器或账户池。

一轮只使用一个凭据会话，凭据通过子进程标准输入传递，不进入命令行参数。Python 仅允许 HTTPS `x.com` 的固定入口，以及不带凭据的 `abs.twimg.com` 脚本。所有重定向、环境代理、遥测和上游 dump 均关闭。代码不提供密码/邮箱/TOTP 登录。

每个响应在进入 Node 前将大整数与 ID 转为字符串。响应文档中 GraphQL 错误不会被忽略；未知结构、混合坏条目、身份冲突、重复 ID 内容变化、缺失游标或循环游标都会使本轮失败。引用/转发对象的正文缺失不会抹掉完整父推文及已知关系 ID。完整长正文保存在证据和待发送队列，Telegram 按长度限制展示。其他作者的回复模块记录只保留证据，不以监控账号名义推送。已遇到的历史编辑关系会保留，但最新 ID 增量监控不能发现所有旧帖后续编辑。

首次采集不会历史重推：取得包含已验证普通时间线条目的整页或终点后建立基线。后续翻页到非置顶、非模块的普通条目覆盖旧水位，或明确终点。每页完整保留；`fetch_count` 是请求提示，不是截断长度。5 页内未覆盖旧水位时返回失败，不推进水位。没有自动“跳过缺口”按钮。

超出追赶范围不是简单等待就能恢复的情况：重试仍从最新页开始。可以增大每页条数；若仍超过 5 页，必须人工核对并制定历史补采/重建基线策略。本版本没有持久化跨轮追赶游标，不能宣称无限历史补采。

## 证据与持久性

证据保存为 `DATA_DIR/evidence-<round>-<page>.json`，包括操作、时间、规范化响应文档和 SHA-256。不保存请求头/Cookie；万一响应回显当前凭据，落盘前先替换。ID 的字符串化和凭据脱敏意味着它是保留内容的 JSON 证据，不是逐字节网络抓包。

数据目录必须权限 0700，证据文件 0600；文件和目录 fsync 完成后才解析覆盖边界。单个证据最多 8 MiB，累计最多 64 MiB / 128 文件，保留最多 7 天；清理在下次写入时执行，不在当前轮内清理本轮证据。它是有限诊断窗口，不是永久归档库。

后页失败时保留已收到页的证据，但整轮不推进采集水位。采集水位与发送确认分开：`acquisitionWatermark` 只来自普通时间线的已验证边界，旧 `watermark` 保留已观察到的最大 ID 以校验队列；较新的置顶/模块记录不能抬高采集检查点。完整记录先落入 outbox，发送成功后才确认。状态损坏、目标改变、容量满或写盘失败会明确停止。队列上限保持每账号 1000 条、总共 5000 条、6 MiB。Telegram 成功后确认前崩溃存在不可避免的重发窗口。

## 验证与维护

`npm run verify` 运行 JS 语法检查、全部 Node 测试和 Python 测试；浏览器验证独立运行 `scripts/browser-smoke.cjs`，见[验证记录](VERIFICATION.md)。普通测试不访问 X 或 Telegram，Python 原生传输测试只访问临时本机 TLS 服务。

真实验证须由操作人员明确提供已有私有 Cookie；不用自动读取第一代作为常规运行依赖。当前会话已授权的一次性验证直接读取第一代凭据，只保存脱敏结果与独立证据，没有修改第一代状态。

CI 模板还未启用：GitHub OAuth 缺少 workflow 权限。本地验证不依赖这一权限，不能把模板当成 Actions 已运行。生产迁移参见 [MIGRATION.md](MIGRATION.md)。
