> **历史资料：第一代 v3.5.0。** 下文保留原版使用与部署说明，命令、服务名、端口及 Bird 采集流程仅适用于第一代。第二代当前状态与运行方式见[当前 README](../README.md)。历史相对文件链接已指向原仓库的固定基线提交。

# 🐦 Tweet Watcher

极简 Node.js 推特监控 → Telegram 推送工具。基于固定版本的 [bird](https://github.com/steipete/bird) 库及本项目的严格时间线适配器，纯 Node.js 实现，带 Web 管理面板，网页与后台 worker 同进程运行，开箱即用。核心仅需一个 `server.js` 加 `lib/` 下的几个小模块，使用 JSON 文件管理配置，运行依赖由锁文件管理，包括 `express`、`bcryptjs`、`proxy-addr` 和固定的 Bird 库。

> 💡 版本 `3.5.0`：加入持久待发送队列、完整页面校验及有界追页；修复受信任 Cloudflare 代理后的访客识别和 SSE 会话吊销，更新安全依赖，并支持独立管理来源与 `__Host-` Cookie。升级与回滚说明见 [安全修复记录](https://github.com/xxvcc/Tweet-Watcher/blob/baf0c2da0927d4448b6f4525676652b49975c1fb/SECURITY_FIXES_20261023.md)。
>
> ⚠️ **从 3.4.1 或更早版本升级，请务必同步更新 systemd 与 Nginx 配置**：生成 `TRUST_PROXY_TOKEN`，并加入文档中的 `EnvironmentFile` 和 Nginx `include`。若从 3.2.x 升级，还需加入 `X-Forwarded-For`（`X-Real-IP` 不能替代它）。缺少共享令牌时服务端会忽略 XFF/XFP，公网请求将共用回环 IP 限流桶，且 HTTPS 登录无法签发 Secure Cookie（见[生产部署](#6-生产部署systemd--nginx)）。

采集器替代方案的源码审查、离线验证与接入建议见 [twscrape 研究报告](https://github.com/xxvcc/Tweet-Watcher/blob/baf0c2da0927d4448b6f4525676652b49975c1fb/research/twscrape-20261023/README.md)。该研究尚未接入运行时，当前版本继续使用固定的 Bird 库与严格时间线适配器。

## ✨ 功能

- 📡 监控多个 Twitter/X 账号的新推文
- 📲 新推文实时推送到 Telegram（区分原创 / 转推）
- ⚙️ 网页面板与后台 worker 同进程，worker 随服务自动启动，无需 Cron、无需独立守护进程
- 🖥️ **监控台式面板**：打开即见每账号状态卡片（状态灯 / 上次检查·推送 / 最近推文 / 推送量走势 / 下次检查倒计时）+ 顶部指标（账号数·今日推送·运行时长·下次检查）+ 实时活动流；配置收进右上角 ⚙ 设置抽屉
- 🌗 深色 / 浅色 / 跟随系统 主题一键切换（记忆选择）
- 🔍 固定采集程序随应用发布，面板可检查安装状态
- 🔒 密码保护 + 安全加固（bcrypt、无状态签名会话、CSRF、登录限流、防敏感字段回显、data 目录隔离）
- 🧠 智能去重（ID 集合，首次运行不推送旧推文）
- ♻️ 每账号独立设置拉取条数和检查频率，保存后下一轮自动热加载，无需重启
- 🔁 瞬时网络失败自动重试（最多 3 次、间隔 2 秒）；Telegram 429 会立即进入全局退避并按 `retry_after` 顺延推送
- ✂️ 超长推文自动截断（>4000 字符），避免 Telegram API 报错
- 📋 Web 端实时查看运行日志（SSE 推送，内存环形缓冲 500 条，同时打到 journald）
- 🚀 纯 Node，无前端框架、无构建步骤

## 📌 项目定位

`Tweet-Watcher` 面向以下场景：

- 想以极低依赖部署一个 Twitter/X → Telegram 监控工具
- 希望直接在服务器上用 Node.js + bird CLI 跑通，不引入复杂框架
- 需要一个简单可视化的 Web 面板管理 Cookie、Bot Token、监控账号和监控开关
- 接受当前项目以单机部署、轻量运维为主，而不是大规模分布式设计

如果你想要的是一个超轻量、可直接用 systemd 常驻 + Nginx 反代的监控工具，这个仓库就是为这种用途准备的。

## 📁 文件结构

```text
├── server.js               # 单 Node 进程：Web 面板 + 后台监控 worker
├── package.json            # 依赖与启动脚本
├── lib/
│   ├── config.js           # config.json / secrets.json 读写与字段校验
│   ├── auth.js             # bcrypt 密码、HMAC 签名会话、CSRF 令牌
│   ├── state.js            # 运行时状态 + 日志环形缓冲 + 事件总线（SSE 源）
│   ├── store.js            # 原子 JSON 读写（临时文件 + rename）
│   ├── bird.js             # 调用固定采集入口并校验输出
│   ├── bird-timeline.mjs   # 完整时间线校验及有界追页
│   ├── outbox.js           # 持久待发送队列及交付确认
│   ├── telegram.js         # 消息格式化 + Telegram Bot API 发送
│   └── worker.js           # 调度：按账号间隔拉取、去重、重试推送
├── bin/bird                # 固定 Node 采集入口
├── public/                 # 纯静态前端（无构建、无框架）
│   ├── index.html          # 面板页面
│   ├── app.js              # 前端逻辑
│   └── style.css           # 样式
├── test/                   # Node 内置测试运行器的回归测试
├── SECURITY.md             # 私密漏洞报告说明
├── README.md               # 项目说明
├── LICENSE                 # 开源许可证
└── data/                   # 运行时数据（自动创建，位于静态 Web 根 public/ 之外）
    ├── config.json         # 普通配置（账号、tg_chat_id、bird_path、paused）
    ├── secrets.json        # 敏感凭据（auth_token / ct0 / tg_bot_token，明文）
    ├── password.json       # 访问密码（bcrypt 哈希）
    ├── session_secret.json # 会话 HMAC 密钥 + epoch
    ├── sent_ids.json       # 旧版已推送 ID，仅用于首次迁移
    ├── delivery_state.json # 待发送内容、已交付 ID 与抓取水位
    └── delivery_state.initialized.json # 防止交付状态丢失后误用旧 ID 的迁移标记
```

## 📋 前置要求

| 依赖 | 说明 |
|------|------|
| Node.js ≥ 22 | 运行环境（实测 v24.18.0，与固定的 bird 0.8.0 要求一致）；使用内置 `fetch`、`execFile` 等，无需额外扩展 |
| npm 依赖 | `npm ci --ignore-scripts` 按锁文件安装全部运行依赖 |
| 采集程序 | 仓库 `bin/bird` 与本地依赖 `@steipete/bird@0.8.0`，无需全局安装 |
| Telegram Bot | Bot Token + Chat ID |
| Twitter Cookie | `auth_token` + `ct0` |

> 💡 无需 PHP，也不依赖 `pcntl` / `posix` / `proc_open` 之类的能力。监控 worker 在 Node 进程内直接作为定时循环运行，不 fork 独立守护进程。
>
> 采集入口固定为仓库 `bin/bird`，由当前 Node 可执行文件启动，带 30 秒超时。面板不能指定宿主机其他程序；安装目录应由 root 持有并对服务用户只读。

## 🚀 安装

### 1. 准备 Node.js

安装 Node.js ≥ 22。无需安装或修改全局 Bird CLI，应用使用锁文件中的库和随仓库发布的严格适配器。

### 2. 拉取代码并安装依赖

```bash
git clone https://github.com/xxvcc/Tweet-Watcher.git
cd Tweet-Watcher
npm ci --ignore-scripts
```

### 3. 启动服务

```bash
node server.js
# 或
npm start
```

默认监听 `127.0.0.1:8787`，可用环境变量覆盖：

```bash
HOST=0.0.0.0 PORT=9000 node server.js
```

服务启动后，网页面板与后台监控 worker 会在同一个进程内一起运行，日志同时打到终端（stdout）。

### 4. 首次设置密码

先从启动终端日志取得一次性 `setup_token`；systemd 部署可执行 `journalctl -u tweet-watcher -n 20` 查看。浏览器访问面板地址（本机为 `http://127.0.0.1:8787`），输入该令牌并设置访问密码（至少 8 个字符、最多 72 个 UTF-8 字节）。

### 5. Web 页面配置

登录后进入**监控台**（默认视图）：账号状态卡片、顶部指标、右侧实时活动流一目了然。点右上角 **⚙ 设置** 打开配置抽屉，填写：

1. **监控账号列表**：每个账号可单独设置拉取条数和检查频率
2. **Twitter 认证**：`auth_token` 和 `ct0`（已保存时显示一行圆点，留空即保持不变；点 👁 可明文核对）
3. **Telegram 推送**：Bot Token 和 Chat ID
4. **采集程序**：位置只读，可点 **🔍 检查安装** 查看状态
5. 点击 💾 **保存配置**（几秒内热加载生效，无需重启）
6. 点击各个 🧪 **测试** 按钮验证连接是否正常

> 右上角 **🌙** 可在 深色 / 浅色 / 跟随系统 间切换主题；**⏸ 暂停 / ▶ 恢复** 可随时停/启监控。

保存后 worker 会在下一轮 tick（几秒内）自动读取新配置，**无需重启**。

### 6. 生产部署（systemd + Nginx）

**systemd 常驻** —— 先创建独立、不可登录的服务用户和数据目录。不要复用 Nginx/PHP 的 `www` 用户；独立 UID 同时隔离运行时数据、子进程环境与会话凭据。

```bash
useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin tweet-watcher
chown -R root:root /www/tweet-watcher
chmod 0755 /www/tweet-watcher
install -d -o tweet-watcher -g tweet-watcher -m 0700 /www/tweet-watcher/data
chown -R tweet-watcher:tweet-watcher /www/tweet-watcher/data
find /www/tweet-watcher/data -type f -exec chmod 0600 {} +
```

再生成一份只允许 root 读取的反代共享令牌；Nginx 用它认证转发头，Node 服务通过 systemd 环境文件读取同一个值：

```bash
install -d -o root -g root -m 0700 /etc/tweet-watcher
PROXY_TOKEN="$(openssl rand -hex 32)"
printf 'TRUST_PROXY_TOKEN=%s\n' "$PROXY_TOKEN" > /etc/tweet-watcher/proxy-token.env
printf 'proxy_set_header X-Tweet-Watcher-Proxy-Token "%s";\n' "$PROXY_TOKEN" > /etc/tweet-watcher/proxy-token-nginx.conf
chmod 0600 /etc/tweet-watcher/proxy-token.env /etc/tweet-watcher/proxy-token-nginx.conf
unset PROXY_TOKEN
```

代码保持 `root:root` 只读，只有 `data/`（包括升级时已有的配置文件）归服务用户所有并允许写入。然后新建 `/etc/systemd/system/tweet-watcher.service`：

```ini
[Unit]
Description=Tweet Watcher
After=network.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=tweet-watcher
Group=tweet-watcher
WorkingDirectory=/www/tweet-watcher
ExecStart=/usr/bin/node server.js
Environment=HOST=127.0.0.1
Environment=PORT=8787
EnvironmentFile=/etc/tweet-watcher/proxy-token.env
UMask=0077
Restart=on-failure
RestartSec=3

# 基础沙箱：仅 data/ 可写；网络仍保留给 Twitter 与 Telegram
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/www/tweet-watcher/data
ProtectProc=invisible
ProcSubset=pid
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
```

启用并查看日志：

```bash
systemctl daemon-reload
systemctl enable --now tweet-watcher
journalctl -u tweet-watcher -f
```

升级旧部署时先用 `systemctl list-unit-files | grep tweet-watcher` 核对只启用了一个服务单元；两个单元同时启动同一目录会争用 `8787` 端口并触发 `EADDRINUSE`。上面的启动频率限制会在持续失败时停止重试，修复原因后执行 `systemctl reset-failed tweet-watcher` 再启动。

**Nginx 反代 + HTTPS** —— 面板只监听回环，由 Nginx 对外提供 HTTPS：

```nginx
server {
    listen 443 ssl;
    server_name 你的域名;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;

        # $proxy_add_x_forwarded_for 把 Nginx 看到的真实连接 IP 追加为最右项；
        # 服务端只在下面的私密令牌验证成功后使用该项。
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        include /etc/tweet-watcher/proxy-token-nginx.conf;

        # SSE 实时日志：关闭缓冲，保持长连接
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

> ⚠️ **令牌文件、`X-Forwarded-For` 和 `X-Forwarded-Proto` 缺一不可。** 未经私密令牌认证的转发头会被忽略，防止同机进程直连 `8787` 后轮换伪造 IP 绕过登录限流。直接访问 Node、不使用反代时可以不设置 `TRUST_PROXY_TOKEN`，此时只采用真实 socket 地址且不会信任任何转发头。
>
> ⚠️ 面板端口只监听回环，请务必只从本机 Nginx 反代，不要直接对公网开放。

若站点经过 Cloudflare，Nginx 应仅对 Cloudflare 官方网段信任 `CF-Connecting-IP`，恢复真实访客地址后再转发。本应用也兼容旧反代：只有本机代理令牌有效、最右 XFF 地址属于随版本核对的 Cloudflare 网段、且访客头为单个合法 IP 时，才使用该访客头；其他来源的同名头被忽略。

管理面板应使用独立来源，例如 `https://tweet.lanny.me`，与 WordPress 等站点隔离。为服务设置 `PUBLIC_ORIGIN=https://tweet.lanny.me` 后，要求精确 Host、可信 HTTPS，以及所有修改请求的匹配 Origin；使用绑定来源的 `__Host-tw_sess` / `__Host-tw_csrf`。旧来源会话不能迁移复用，需要重新登录。不要在新入口可用之前启用该环境变量。

本机宝塔集成示例位于 `deploy/nginx/panel-proxy.conf`，应放入该独立虚拟主机的 extension 目录；保留宝塔已有证书路径、验证目录与续期任务。旧入口只跳转落地页，旧 API 返回 410。详细发布和回滚要求见 [安全修复记录](https://github.com/xxvcc/Tweet-Watcher/blob/baf0c2da0927d4448b6f4525676652b49975c1fb/SECURITY_FIXES_20261023.md)。

> 💡 无需 `.htaccess`：仓库内的 `data/` 与 `public/` 并列，Node 只静态伺服 `public/`，因此运行时数据不经 Web 暴露。

## ⚙️ 配置说明

Twitter、Telegram 与监控配置均通过 Web 页面管理。生产反代另有一份只含 `TRUST_PROXY_TOKEN` 的 root-only systemd 环境文件；业务数据持久化到 `data/` 目录下的几个 JSON 文件：

| 文件 | 内容 |
|------|------|
| `config.json` | 账号列表、`tg_chat_id`、`bird_path`、`paused`（暂停开关）及内部配置版本 |
| `secrets.json` | `auth_token`、`ct0`、`tg_bot_token`（明文存储，目录权限保护） |
| `password.json` | 访问密码的 bcrypt 哈希 |
| `session_secret.json` | 会话 HMAC 密钥与 epoch |
| `sent_ids.json` | 旧版已推送 ID，仅首次迁移时读取 |
| `delivery_state.json` | 待发送正文、已交付 ID、抓取水位、目标指纹及缺口告警 |
| `delivery_state.initialized.json` | 已建立交付状态的持久标记，必须与状态文件一起备份/恢复 |

首次运行无需任何配置文件即可启动，`config.js` 内置默认值（当然需要在 Web 页面填写 Token 才能正常工作）。

### 配置项一览

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `bird_path` | 只读兼容字段，旧路径自动映射到固定入口 | 应用目录的 `bin/bird` |
| `auth_token` | Twitter Cookie 认证令牌 | - |
| `ct0` | Twitter Cookie CSRF Token | - |
| `tg_bot_token` | Telegram Bot Token | - |
| `tg_chat_id` | Telegram Chat ID | - |
| `accounts` | 监控的 Twitter 账号列表（对象数组） | `[]` |

每个账号对象支持以下字段：

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `username` | Twitter 用户名（不含 @，需匹配 `^[A-Za-z0-9_]{1,15}$`） | （必填） |
| `fetch_count` | 首次拉取目标条数（1–50）；完整保留响应页，后续按原有水位有界追页 | `10` |
| `check_interval` | 检查频率（秒，30–3600） | `300` |

> 💡 修改任何配置后点击「保存配置」即可生效，worker 会在下一轮 tick（每 5 秒一轮）自动读取新值，**无需重启**。已保存的密文字段（`auth_token` / `ct0` / `tg_bot_token`）在页面上不回显，**留空即保持不变**。

### 获取 Twitter Cookie

1. 浏览器登录 [x.com](https://x.com)
2. 按 `F12` 打开开发者工具
3. 切换到 **Application**（应用程序）标签页
4. 左侧找到 **Cookies** → `https://x.com`
5. 复制 `auth_token` 和 `ct0` 的值

> ⚠️ Cookie 会过期。如果推送停止工作，请重新获取 Cookie 并在 Web 页面更新。

### 获取 Telegram Bot Token

1. 在 Telegram 搜索 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot`，按提示创建
3. 获得格式如 `123456789:ABCdefGHIjklMNOpqrsTUVwxyz` 的 Token

### 获取 Telegram Chat ID

1. 在 Telegram 搜索 [@userinfobot](https://t.me/userinfobot)
2. 发送任意消息，获得你的 Chat ID

> 💡 推送到群组：把 Bot 拉入群组，使用群组 Chat ID（以 `-` 开头）。

## 🔒 安全特性

- 首次访问 Web 页面时需设置密码（至少 8 位）
- 密码以 **bcrypt**（cost 12）哈希存储在 `data/password.json`；兼容旧 `$2y$` 前缀（自动改写为 `$2b$`）。新密码要求至少 8 个字符且不超过 72 个 UTF-8 字节（bcrypt 的有效输入上限）；旧版生成的未标记哈希保持登录兼容，并在安全边界内自动升级元数据。结构非法或工作因子异常高的持久哈希会快速 fail-closed，避免登录请求陷入指数级 CPU 消耗
- 密码使用**异步 bcrypt**（不阻塞事件循环），错误时固定延迟 1 秒响应（防暴力破解）
- **登录限流**（按经过私密代理令牌认证的 `X-Forwarded-For` 末项分桶；未经认证的转发头一律忽略）：累计失败 5 次锁 5 分钟、10 次锁 30 分钟、20 次锁 60 分钟。锁定期满只放行下一次尝试而**不清零计数**，因此升级档位真正可达；计数在**登录成功**或**1 小时无新失败**时清除。限流表有界（惰性回收 + 硬上限，防内存耗尽）
- **首次设置令牌**：无密码时服务端启动会先吊销全部旧会话，再在日志打印一次性 `setup_token`；`/api/setup` 必须携带它才能设密，杜绝公网面板的无认证首次抢注（TOFU）。若 `password.json` 损坏（包括合法 JSON 但结构非法），`hasPassword` 判定为 fail-closed（视为已设置），不会重开无认证设置
- **会话**：HMAC-SHA256 签名的无状态 Cookie（有效期 7 天），内含 epoch —— 登出或改密会 `bump` epoch，使所有已签发会话**立即失效**；签发时间会严格校验并只容忍 5 分钟时钟偏差，畸形 Cookie/会话一律返回 401（不再有 500 堆栈泄露）
- **CSRF 双提交令牌**：所有改动型接口校验，`timingSafeEqual` 常量时间比较；`/api/logout` 仅在持有效会话+CSRF 时才全局吊销，未认证请求无法借此制造登出 DoS
- **安全响应头**：CSP（脚本与样式均严格同源，无 `unsafe-inline`；含 `form-action 'none'`）、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy`，并关闭 `X-Powered-By`；所有 `/api/*` 响应带 `Cache-Control: no-store`
- 凭据（`auth_token` / `ct0` / `tg_bot_token`）在日志输出中自动 redact，替换为 `***`
- `data/` 目录权限 `0700`、文件写入 `0600`，并位于静态 Web 根 `public/` 之外（Node 只对 `public/` 使用 `express.static`）
- 文件写入使用原子替换（临时文件 + `fsync` + `rename` + 目录 `fsync`），防止崩溃/断电导致半写损坏；读取时区分「文件不存在」与「存在但损坏」，损坏不静默当作「未设置」
- 损坏或结构非法的 `config.json` / `secrets.json` 会 fail-closed；已有敏感配置、或当前 worker 已加载过有效配置时，意外缺失的 `config.json` 也不会被当成首次空配置（包括运行中 `data/` 挂载消失）。单独迁移 `sent_ids.json` 仍受支持，配置落盘前 worker 会保留其中的去重记录。系统不会覆盖损坏文件，worker 会停止并报为不健康，Web 进程保持在线。请从 journald 查看错误并从备份恢复，不要直接删除敏感配置后带空值继续运行
- 采集入口固定为应用 `bin/bird`，通过当前 Node 启动；拒绝从面板选择其他可执行文件。安装目录由 root 持有，仅数据目录允许服务用户写入。
- 子进程调用 bird 带 30 秒超时保护，防止挂起；Twitter Cookie 通过 bird 0.8.0 支持的 `AUTH_TOKEN` / `CT0` 环境变量传递，不进入可被其他本机用户读取的进程命令行，并且子进程只继承运行所需的最小环境变量集合
- 忘记密码时，需**停服 → 删除 `password.json` → 重启**，重启后从服务端日志读取新的一次性 `setup_token` 再走首次设置：

```bash
systemctl stop tweet-watcher
rm /www/tweet-watcher/data/password.json
systemctl start tweet-watcher
journalctl -u tweet-watcher -n 20 | grep 首次设置令牌   # 取出 setup_token
```

重启后下次访问面板会回到「首次设置密码」流程，需在页面填入日志中的令牌。

## 📬 Telegram 推送格式

**原创推文：**
```text
🐦 新推文 @elonmusk

发布时间：2026/2/26 10:00:00
X链接：https://x.com/elonmusk/status/1234567890
内容：
推文内容在这里...
```

**转推：**
```text
🔁 转推 @elonmusk

发布时间：2026/2/26 10:05:00
X链接：https://x.com/elonmusk/status/1234567890
内容：
转推内容在这里...
```

> 💡 时间由推文原始时间戳解析后转为北京时间（`Asia/Shanghai`），以 `zh-CN`、24 小时制显示；无法解析时原样保留。整条消息超过 4000 字符会自动截断并追加「…（内容已截断）」。

## 🧠 去重机制

| 策略 | 说明 |
|------|------|
| ID 集合 | 每个账号维护已推送 ID、抓取水位及待发送队列，原子持久化到 `delivery_state.json` |
| 首次静默 | 账号首次运行只记录当前推文 ID，不推送旧推文；若首次时间线为空，则持久化当前 Twitter Snowflake 时间水位，确保之后发布的第一条推文不会再次被当成基线漏掉 |
| 集合上限 | 每个账号最多保留 200 条 ID |
| 置顶推保护 | 淘汰时优先保留"仍出现在本次拉取窗口内"的 ID —— 否则长期置顶的推文会被挤出去重表并每满 200 条重推一次 |
| 历史推文保护 | 未知但小于或等于已知最高雪花 ID 的条目视为置顶/扩窗带回的旧推文，不补发；真正的新推文按 ID 从旧到新发送 |
| 孤立清理 | 从配置中删除账号后，worker 清理其交付状态及待发送队列；只修改用户名大小写不会丢队列 |
| 转推识别 | 兼容显式转推字段，并识别 bird 0.8.0 精简输出中的标准 `RT @账号:` 前缀；转推标记为 🔁，原创推文标记为 🐦 |
| 先保存再发送 | 完整保存新抓取内容后才发送；每条发送成功立即确认落盘。Telegram 成功到确认落盘之间崩溃，可能重发，但不会因为窗口移动丢掉已保存内容 |
| 损坏即停止 | 状态或标记损坏、已存在标记但状态缺失时停止推送；运行中丢失已加载文件也会停止。重启时状态完整而标记缺失可安全补建标记；两文件同时丢失无法识别历史初始化，必须从完整备份恢复。首次导入旧 ID 保留旧版空账号基线兼容 |
| 缺口检测 | 完整页面校验后最多追赶 10 页；仍无法覆盖原水位会持续显示缺口告警，后续成功不掩盖该告警 |
| 目标绑定 | 待发送队列绑定 Bot/Chat 指纹；改变目标时冻结旧队列，恢复原目标才继续，移除账号会明确丢弃队列 |
| 容量限制 | 每账号最多 1,000 条，全局 5,000 条，JSON 最多 6 MiB；达到上限保留旧队列并停止推进抓取水位 |

瞬时网络失败最多重试 3 次，重试间隔为 2 秒。Telegram 429 建立 bot 级全局退避（最长 1 小时），已保存的正文跨检查和重启保留；退避期间仍可采集。永久性 4xx 不在本轮重试。每账号每轮最多交付 50 条；旧消息失败时不会跳过它发送后续消息。抓取失败时，已持久化且目标匹配的旧队列仍可继续交付。删除账号会丢弃它的积压，请先核对状态。

## 📋 日志查看

**Web 页面：** 监控台右侧的「实时活动」列即为日志流。日志通过 SSE（`/api/stream`）从服务端实时推送到面板，来源是内存里的环形缓冲（最多保留 500 条）。

**命令行 / 服务器：** 日志同时写到进程 stdout，交给 systemd/journald 留存与轮转：

```bash
# 查看最近日志
journalctl -u tweet-watcher -n 50

# 实时跟踪
journalctl -u tweet-watcher -f
```

> 💡 本项目不再写 `data/cron.log` 文件，也没有 2MB 上限那套自建日志轮转 —— 落盘与轮转交给 journald 处理。

### 供外部脚本使用的接口

面板本身走 SSE，不调用下面两个接口；它们是留给健康检查与日志抓取的（均需携带有效会话 Cookie）：

| 接口 | 用途 |
|------|------|
| `GET /api/status` | 运行状态 + 每账号指标；`healthy` 表示 worker 在 60 秒内有过心跳（长 tick 期间也会持续更新，不会误判） |
| `GET /api/logs` | 取最近 200 条日志（JSON 数组） |

## 🔄 迁移

迁移到新服务器：

1. 拷贝整个项目目录（含 `server.js`、`lib/`、`bin/`、`public/`、`package.json`、`package-lock.json`）
2. 新服务器安装 Node.js ≥ 22
3. 在应用目录执行 `npm ci --omit=dev --ignore-scripts`，按锁文件安装运行依赖
4. 拷贝完整 `data/` 以保留配置、凭据、密码、待发送队列及迁移标记；不要仅复制旧 `sent_ids.json` 来替代 3.5.0 的交付状态。首次迁移旧版本时仍支持仅导入旧 ID 文件
5. 配好 systemd / Nginx 后启动服务，访问面板确认状态

> 💡 拷贝 `data/` 后请确认目录权限仍为 `0700`、文件为 `0600`，且属主是运行服务的用户。

## ❓ 常见问题

### Q: 推送突然不工作了？

1. 查看日志：面板「实时日志」或 `journalctl -u tweet-watcher -n 50`
2. 检查面板「监控状态」是否为运行中、是否被「暂停监控」
3. 在设置中点击「测试 Twitter 拉取」，确认固定采集程序及已保存的 Twitter Cookie 可用；测试只读取时间线
4. 重新获取 Cookie，在 Web 页面更新即可（下一轮 tick 自动生效）

### Q: 面板打不开 / 打开空白？

1. 确认服务在运行：`systemctl status tweet-watcher`
2. 确认监听地址端口：默认 `127.0.0.1:8787`，可用 `HOST` / `PORT` 环境变量覆盖
3. 若通过公网访问，确认 Nginx 已正确反代到 `127.0.0.1:8787` 并配好 HTTPS

### Q: 点「测试 Twitter 拉取」报错？

确认 Cookie 有效，点击「检查安装」。依赖缺失时由管理员在应用目录执行 `npm ci --ignore-scripts`。页面结构不完整、用户不可用或分页异常会明确失败，不能将错误响应解释为空时间线。不要把全局 CLI 的宽松解析输出作为完整性证明。

### Q: 想用别的方式常驻，而不是 systemd？

监控 worker 在 `node server.js` 进程内随服务自动启动，只要保证这个进程一直活着即可。除了 systemd，也可以用 `pm2`、`supervisor` 等进程管理器守护。注意本项目没有 `start` / `stop` 守护进程子命令，也没有 Cron 单次运行模式 —— 面板上的「暂停 / 恢复监控」控制的是同一个进程里的监控开关，而不是进程本身的启停。

### Q: 想推送到多个 Telegram 账号？

- 创建 Telegram 群组，把 Bot 和所有人拉进去，使用群组 Chat ID（以 `-` 开头）
- 或复制项目到另一个目录、用不同的 `PORT` 再跑一份，配置不同的 Chat ID

### Q: 修改了检查频率 / 账号，需要重启吗？

不需要。保存配置后 worker 会在下一轮 tick（每 5 秒一轮）读取最新的 `config.json`，账号增删、频率与条数调整都会自动生效。

## 🤝 贡献

欢迎提交 Issue、Pull Request 或部署经验反馈。请只依据代码中真实存在的能力提交问题与改进，附上**脱敏后的**日志（凭据在服务端日志中已自动 redact）与环境信息（Node 版本、bird 版本、部署方式）。

## 🧭 支持与反馈

如果你在使用中遇到问题，建议按以下顺序排查：

1. 阅读本 README 对应章节
2. 查看面板「实时日志」或 `journalctl -u tweet-watcher -f`
3. 检查 bird CLI、Twitter Cookie 和 Telegram 配置（用面板的 🧪 测试按钮）
4. 提交 Issue，并附上脱敏后的日志与环境信息

## 📜 License

本项目基于 MIT License 开源，详见 [`LICENSE`](https://github.com/xxvcc/Tweet-Watcher/blob/baf0c2da0927d4448b6f4525676652b49975c1fb/LICENSE)。

## 🙏 致谢

推特数据拉取由 [bird](https://github.com/steipete/bird) CLI 提供支持。
