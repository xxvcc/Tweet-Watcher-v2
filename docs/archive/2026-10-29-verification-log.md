# v2 验证记录

> 历史记录：保留当时的验证结果、部署快照与未完成事项，不代表当前状态。当前版本请看[验证摘要](../VERIFICATION.md)与[文档索引](../README.md)。

更新：2026-10-29。目标：`0.1.0-beta.2` 基础上的审计修复、AI 翻译及手动连接测试。本文件区分当前功能验证与上线、首次生产切换、先前离线验证和历史实测。修复清单见 [AUDIT_FIXES.md](2026-10-24-audit-fixes.md)，翻译范围见 [AI_TRANSLATION.md](../AI_TRANSLATION.md)。

同日先完成[详细审计与切换评估](2026-10-29-audit.md)，随后按用户授权修复、验证并接管生产。原审计的 258 项结果和缺陷属于修复前记录；当前执行结果见下节及[生产切换记录](2026-10-29-cutover.md)。

## 2026-10-29 添加账号按钮与说明间距

用户截图指出监控账号设置内“添加账号”按钮与下方文字过近。原因是通用 `.hint` 使用 `margin-top:-4px`；仅为 `.btn-add + .hint` 增加局部样式，将上边距设为 **12px**、行高设为 **1.6**，保留按钮及说明内容与原有交互。

- `npm ci --ignore-scripts` 成功；`npm test` **318/318** 通过，0 失败、0 跳过，日志 `/tmp/twv2-spacing-test.log`。此次仅修改 CSS 和文档，没有新增测试用例；`git diff --check` 通过。
- 合成 Chromium 在 **1440/390/320** 宽度使用四个合成账号，等待抽屉动画结束后测量：旧 CSS 的按钮下缘至说明上缘均为 **-4px**，新 CSS 均为 **12px**；说明行高由 **17.4px** 增至 **19.2px**。无重叠、无横向溢出，点击添加账号只将草稿从 4 行增至 5 行，0 请求且配置字节不变。0 浏览器错误/外部请求，前后截图已目视检查；证据 `/tmp/tweet-account-spacing-browser-rKHFGV`，探针 `/tmp/tweet-watcher-account-spacing-browser.cjs`。
- 已部署至 `releases/20261029-e3945ba4427d`，**90** 个文件的源码快照 SHA-256 为 `e3945ba4427d795d07cb1c51d16f0298f10aae07fdd2aff1ef8a5dcd4496d022`。相对上一 release 仅有 `public/style.css` 与三个文档变化；新安装 Node/Python 依赖并通过专用用户采集器版本校验，源码文件哈希核验通过。
- 更新前暂停并等待空闲，在私有 `/var/lib/tweet-watcher-v2-spacing-20261029/pre-upgrade-data` 备份后原子切换，启动时配置/凭据/认证/投递文件哈希保持不变，随后恢复原有未暂停状态。正式服务 active、健康，四账号均完成正常自动检查，0 自动重启；v1 仍 inactive、disabled。
- 正式站点认证 GET-only 浏览器在 **1440/390/320** 宽度复核实际间距均为 **12px**、行高 **19.2px**，无横向溢出；线上 CSS 哈希与新 release 匹配，HTML `no-store`。0 浏览器错误、0 非预期请求，配置/凭据/认证文件哈希不变；报告与截图位于私有 `/var/lib/tweet-watcher-v2-spacing-20261029`，手机截图已目视确认。验证未额外调用 AI/X/Telegram；未提交或推送 Git，执行后文档补记不反写不可变 release。

## 2026-10-29 正式运行横幅精简

用户确认已使用 v2，要求移除正常运行时常驻的黄色模式说明。`runtime-notice` 在正常 live 模式下清空并隐藏，不占布局空间；运行/暂停/连接状态由原有顶栏状态继续展示。加载、开发预览、只读验证及暂停/恢复未确认提示保留，设置故障可从隐藏状态重新显示，成功重试后收起。

- `npm ci --ignore-scripts` 成功；`npm run check` 通过 **46** 个 JavaScript 文件，`npm test` **318/318** 通过，0 失败、0 跳过。只调整已有前端模式和失败控制测试的显示断言，没有新增测试用例。日志 `/tmp/twv2-banner-test.log`；`git diff --check` 通过。
- 合成 Chromium 在 **1440/390/320** 宽度验证正常 live 横幅 `display:none`、高度 0、无布局占位，顶栏状态可见；通过 SSE 切换只读、`controlPending`、加载及开发模式，提示均可显示，恢复 live 后重新隐藏。0 溢出、0 浏览器错误、0 外部请求；临时探针 `/tmp/tweet-watcher-runtime-notice-browser.cjs`，截图 `/tmp/tweet-notice-browser-YkkjT9`。
- 已部署至 `releases/20261029-f1bddfa3c356`，**90** 个文件的源码快照 SHA-256 为 `f1bddfa3c356fbf379e8617a0ead86e6cbf1492596ea4ac54be057594963148d`。新安装 Node/Python 依赖并通过专用用户采集器版本校验；文件清单哈希核验通过。相对前一 release 的运行代码仅变更 `public/app.js`，另含前端测试、本次文档和上次真实 AI 复测文档补记。
- 更新前暂停并等待空闲，私有备份位于 `/var/lib/tweet-watcher-v2-banner-20261029/pre-upgrade-data`；原子切换代码、启动后先核对配置/凭据/认证/投递文件哈希，再恢复原有未暂停状态。旧 release 保留。恢复后服务 active、健康，四账号均已完成正常自动检查，无自动重启；v1 仍 inactive、disabled。
- 正式站点的认证 GET-only 浏览器复核在 **1440/390/320** 宽度通过：横幅隐藏、高度 0、顶栏“运行中”可见、无横向溢出；HTML `no-store`，脚本 URL 内容哈希与新 release 一致。0 浏览器错误、0 非预期请求，配置/凭据/认证文件哈希保持不变。报告与私有截图位于 `/var/lib/tweet-watcher-v2-banner-20261029`。
- 本次没有修改采集器、服务端控制或投递实现；验证探针未额外调用真实 AI、X 或 Telegram，正式监控按原配置恢复。未提交或推送 Git；执行后文档补记不反写不可变 release。

## 2026-10-29 当前配置真实多语言复测

用户报告手动 hi 已成功，并明确要求重新测试。本轮先读取当前正式配置，再执行真实请求；此前的 404 与模型列表观察属于当时状态，不能继续作为当前配置不可用的结论。

- 正式服务 `POST /api/test/ai` 使用当前保存配置，HTTP 200、`ok=true`，耗时 **2251 ms**。配置及会话文件哈希不变。
- 对实际部署 `releases/20261029-afffe1f6bd45` 的翻译模块执行独立真实测试，使用相同保存配置和私有 AI Key，仅发送合成短句。限制出站请求为配置中的 AI 地址；不导入 worker、不写生产配置/队列、不调用 X 或 Telegram，也没有重启服务。
- **12/12 场景通过**：8 次真实翻译、3 次本地跳过、1 次缓存命中；加上上述 hi，总计 **9 次真实 AI 请求**，没有重试。所有源文保持不变；纯格式化检查确认译文与原文同时保留且未超消息长度，未实际投递 Telegram。

| 真实翻译样本 | 耗时 | 结果 |
|---|---|---|
| 英文 | 4939 ms | 通过 |
| 法文 | 7575 ms | 通过 |
| 日文 | 5136 ms | 通过 |
| 韩文 | 5602 ms | 通过 |
| 俄文 | 5137 ms | 通过 |
| 阿拉伯文 | 4984 ms | 通过 |
| 中文与英文混合 | 4941 ms | 通过 |
| 品牌、版本、数字及链接 | 7820 ms | 通过 |

英、法、日、韩、俄、阿拉伯语样本表达“更新将于明天 10:00 UTC 发布，现有用户无需再次登录”。独立语义复核确认时间、否定与用户范围均保留，无实质遗漏或增译。法文译文略直译，但含义正确。混合样本保留原有中文句子及链接并翻译英文；品牌样本保留 OpenAI、Toolkit 2.0、25 和原链接。

实际英文结果：“更新将于明天 10:00 UTC 上线。现有用户无需重新登录。”混合内容结果：“现有中文保持不变。更新将于明天推出。阅读更多：https://example.com/news”。

简体中文、繁体中文及纯链接/提及/标签/表情样本均返回 `NO_TRANSLATION_NEEDED`，AI 调用数为 0。再次处理相同英文时译文一致，新增调用数为 0，确认本进程缓存生效。

- 同步重新运行 `npm run verify`：JS **46** 文件、Node **318/318**、Python **36/36** 通过，0 失败、0 跳过；日志 `/tmp/twv2-real-ai-recheck-verify.log`。开发与实际部署的 `lib/translation.js` SHA-256 完全一致：`9ddfd45e76263f59c386d13a79b4566bca2577ad056b165ffba0c1741003a1d7`。
- 测试前后配置、凭据和会话文件哈希不变；v2 持续 active、健康、0 重启，四账号自动检查正常。真实结果与仅含代码的验证脚本位于私有 `/var/lib/tweet-watcher-v2-ai-live-check-20261029`，目录 0700、报告 0600；未保存 Key 或上游响应头/原始错误正文。
- 这些结果证明当前服务配置可完成上述短句翻译与本地跳过/缓存，不代表所有语言、长正文、歧义、恶意指令或模型长期质量均已验收；本轮未验证真实推文经队列到 Telegram 的完整投递。没有代码修改、发布或重启，仅更新验证文档。

## 2026-10-29 非中文翻译范围扩展

用户将原先“仅翻译英文”的要求更新为“除中文以外的语言均可翻译”，并要求解释判断依据。旧版先按 X `lang` 与英文词表筛选；本次改为在本地检查实际正文字符，并用 X 标记辅助区分只含汉字的日语/韩语。界面和提示词同步改为非中文及混合正文中的外语部分译成简体中文，已有中文和原文保留。

- 仅为判断移除 URL、@ 提及、RT 前缀与标签；没有文字的链接/数字/表情跳过。正文含非汉字文字即进入翻译，不再限制英文，也不因错误 `zh` 标记而漏掉明显外文。只有汉字时默认按中文跳过（简繁均包含），明确 `ja`/`ko` 标记例外。
- 中外混合文本要求模型保留已有中文并翻译外语部分，保留名称和链接。中文中的拉丁品牌名也可能触发请求；有效结果若与原文完全相同，首次与缓存命中均返回跳过，避免重复展示同一份正文。
- 翻译提示版本增加，旧英文缓存不会复用。允许输出保留日文等名称；现有汉字占比仅是结构性检查，不是完整语言识别或译文质量保证，不能可靠排除带汉字的日文回复。
- 采集器、持久队列和 worker 原已支持通用 `lang`，无需修改运行链路。新增回归覆盖多语言正文与语言标记在解析、转推展开和队列重启后保持对应。认证、网络边界、hi 测试、队列确认及原文兜底不变。

- `npm ci --ignore-scripts` 成功；完整 `npm run verify`：JS **46** 文件语法检查、Node **318/318**、Python **36/36** 通过，0 失败、0 跳过。日志 `/tmp/twv2-multilingual-verify.log`。
- 合成 Chromium 在 1440/390/320 宽度验证新复选框及判断说明、配置保存重载、Key 不回显与只读模式；0 外部请求、0 脚本错误，手机无溢出。截图 `/tmp/tweet-watcher-v2-browser-artifacts-XRhxlT`。旧缓存升级脚本也通过，当前 UI 改动不破坏自动资源版本。
- 已上线至 `releases/20261029-afffe1f6bd45`，90 个文件的源码快照 SHA-256 为 `afffe1f6bd45b0f55c4c60e4596d370f313dc2873871bbd2295f020f0b2e50bf`。新安装 Node/Python 依赖，专用用户采集器校验通过。暂停并等待任务结束后，在私有 `/var/lib/tweet-watcher-v2-multilingual-20261029/pre-upgrade-data` 保存快照，原子更新代码并恢复原暂停状态；恢复前配置、凭据、认证和发送状态文件哈希均不变，旧 release 保留。
- 线上页面已核对新复选框与判断说明、HTML `no-store` 及资源哈希。部署文件的 6 项合成分类检查通过；服务 active、健康、0 重启，四账号均已完成正常自动检查，v1 仍 inactive、disabled。
- 本次不更改用户的模型、Key 或翻译开关；配置中的模型仍与上次 404 的模型相同，未用同一配置重复发起真实 AI 请求。多语言响应与 Telegram 均使用模拟服务，不能当作真实模型翻译质量验收。实际翻译还需要服务可用的模型配置。
- 未提交 Git 或推送远程；执行后文档补记不反写不可变 release。

## 2026-10-29 AI 测试按钮旧缓存修复

用户报告点击“发送 hi 测试”没有反应。现场确认 HTML 已更新，但 JS/CSS 仍引用 `?v=0.1.0-beta.2`；公网 JS 返回 `Cache-Control: public, max-age=14400`，已打开过旧版的浏览器可以保留旧脚本 4 小时。新 HTML 与真实旧 release 脚本组合可复现：按钮可见且未禁用，但没有点击处理器，点击无请求、无提示；当前脚本则正常。此前首次上线的全新浏览器检查没有覆盖保留旧缓存的升级场景。

修复在每次进程启动时读取实际 JS/CSS 内容，为 HTML 中两份资源生成 SHA-256 版本地址，HTML 使用 `no-store`，JS/CSS 使用 `no-cache`。不再依赖手工改包版本来刷新浏览器资源。新增 HTTP 回归核对资源内容、GET/HEAD、缓存与条件请求、文件变更后新 URL，以及不完整模板拒绝启动。

- `npm ci --ignore-scripts` 成功；`npm run verify` 的 Node **311/311**、Python **36/36** 通过，0 失败、0 跳过。完整日志 `/tmp/twv2-asset-fix-verify.log`；新增浏览器脚本后最终语法检查 **46** 文件通过，日志 `/tmp/twv2-asset-fix-syntax.log`。
- `scripts/asset-cache-browser-smoke.cjs` 使用真实 Chromium HTTP 缓存：先载入旧 release 并缓存 JS/CSS 4 小时；同 URL 新 HTML 复用 2 份缓存、按钮无处理器，点击无反馈，服务器未收到新脚本请求；切换修复版且不清缓存后，自动请求新的哈希资源，按钮处理器安装成功，点击立即显示输入校验。0 外网请求、0 脚本错误、0 配置修改。临时服务、合成认证及私有数据已清理。
- 已部署至 `releases/20261029-cd3f2723118e`，90 文件源码清单 SHA-256 `cd3f2723118ed907bd81bf8fc06c686c52d2acddba4af6414e4ee31f4242c965`。新依赖安装、专用用户采集器校验通过；暂停并等待任务结束后备份私有数据、原子切换、启动并恢复原暂停状态。恢复前配置、凭据、认证和发送状态文件哈希不变；旧 release 保留，未改变数据格式。上线后四账号自动检查正常，v2 健康、0 重启，v1 仍停止并禁用。
- 公网 HTML 实际返回 `no-store`，资源 URL 中完整 SHA-256 与部署文件内容一致。源站为 JS/CSS 设置 `no-cache`，但 Cloudflare 现场仍将公网资产响应改为 `max-age=14400`；本次修复依靠内容变化自动改变 URL，已实际确认新 URL 返回正确字节，不能声称 CDN 缓存已关闭。
- 公网 Chromium 使用当前保存的真实 AI 配置，准确点击 **1 次** hi 测试，未编辑或保存字段；按钮处理器存在、POST 发出、错误结果正常显示，无脚本错误或额外请求。上游返回 404，接口安全分类为 `MODEL_OR_ENDPOINT_NOT_FOUND`，因此没有取得模型回复。配置及会话文件哈希不变。私有结果位于 `/var/lib/tweet-watcher-v2-asset-fix-20261029/production-hi-private-result.json`，未把凭据放入报告或开发仓库。
- 随后只读查询该 Key 的模型目录，HTTP 200，22 个模型；当前填写模型未出现在可用列表，列表包含 `gpt-5.4-mini`。地址基础路径为 `/v1`，不存在重复追加 `/chat/completions`。未擅自更改用户所选模型或关闭其已启用的自动翻译。按钮无响应问题已修复；真实回复仍需使用有效的服务/模型配置验证。
- 本次源码及文档仍未提交 Git 或推送远程。执行后补记的文档不反写不可变 release。

## 2026-10-29 AI 发送 hi 测试首次上线

- 新增 `POST /api/test/ai` 和 AI 设置中的“发送 hi 测试”，使用未保存草稿发送固定用户消息 `hi`，显示纯文本回复与耗时。无需开启自动翻译，不保存配置、不操作队列或 Telegram。
- `npm ci --ignore-scripts` 成功；`npm run verify`：Node.js 24.18.0 下 JS **43** 文件语法检查、Node **308/308**、Python **36/36** 通过，0 失败、0 跳过。完整日志 `/tmp/twv2-ai-test-verify.log`。相对首次切换新增 22 项 Node 回归。
- 新增覆盖草稿/已保存 Key 的地址作用域、配置版本、认证与 CSRF、异步会话撤销、并发保护、固定 hi 请求、普通英文回复、超时/大小/重定向限制、上游错误脱敏、缓存隔离，以及前端忙碌/取消/远端配置更新。
- `scripts/ai-test-browser-smoke.cjs` 在独立暂停的 live 实例通过 Chromium 验证：3 次模拟 AI 请求，已保存 Key 和草稿 Key 均可测试，401 错误正确显示，HTML 回复保持纯文本；配置及凭据文件哈希不变，无配置保存；1440/390/320 像素无横向溢出，0 浏览器脚本错误、0 外网请求。截图 `/tmp/tweet-watcher-v2-ai-browser-artifacts-wNyoT7`。
- 真实模型尚未验证：本次成功回复来自模拟服务，未使用真实 AI Key、未执行真实 AI 计费请求。本阶段未重复 Node 22 或禁用 SSE 浏览器模式。
- 首次上线完成时：`/opt/tweet-watcher-v2/current` 指向 `releases/20261029-6be21acca97c`；源码清单记录 87 个文件，SHA-256 为 `6be21acca97ccf51f07444de950a3ccdbee219385da2bdc7947c526a720887d5`。新安装 Node 依赖与固定 Python venv，专用运行用户下采集器版本检查和 `pip check` 通过。执行后文档补记不修改不可变源码快照；未创建 Git release 或推送远程。
- 升级过程：暂停并确认无检查任务，停止 v2，将数据备份至仓库外私有 `/var/lib/tweet-watcher-v2-ai-test-20261029/pre-upgrade-data`，原子切换代码链接后启动。恢复前核对配置、凭据、认证及发送状态文件哈希均不变，最后恢复原来的未暂停状态。旧 release 保留，可回切代码；本次没有变更数据格式或重新迁移 v1。
- 上线后 `tweet-watcher-v2.service` active、enabled、健康且无重启；longlan、Warcraft、Blizzard_Ent、Wowhead 均完成正常自动检查。v1 仍 inactive、disabled。首次上线核验时 AI 关闭，模型和 Key 未配置。
- 真实公网 Chromium 验证 `https://tweet.lanny.me`：按钮可见且可用，空模型在浏览器内提示（0 POST），合成模型草稿及空 Key 返回 HTTP 400 `KEY_REQUIRED`（1 次接口校验，0 次真实 AI 请求）。配置版本及配置/凭据/会话文件哈希不变，0 意外修改、0 客户端错误。私有裁剪截图与结果保存在 `/var/lib/tweet-watcher-v2-ai-test-20261029/`，不含凭据值。该检查验证线上按钮及输入校验，不证明真实模型可调用。

## 2026-10-29 缺陷修复与生产切换

- `npm ci --ignore-scripts`、JS 41 文件语法检查、Node **286/286**、Python **36/36**、`pip check`、`git diff --check` 通过。新增回归包括输入误删、暂停存储失败/恢复、前端草稿/控制状态、截断正文和迁移回退；完整日志 `/tmp/twv2-cutover-verify.log`。
- 隔离 Chromium 在 SSE 模式完成首次设置、登录、配置、AI 设置和 1440×1000、390×844、320×740 布局验证；0 客户端错误、0 外部请求。日志 `/tmp/twv2-cutover-browser.log`。本阶段未重复执行 Node 22 或禁用 SSE 浏览器模式。
- **当前源码真实 X 验证**：longlan 20、Warcraft 20、Blizzard_Ent 21、Wowhead 20 条，均 1 页且覆盖旧检查点；8 份证据哈希核验成功。正式只读服务在专用用户/systemd 环境中的四账号测试也通过。并非只复用了早期 beta.1 证据。
- 14 项合成迁移测试；真实状态副本演练保留确认集合，并模拟新增确认和 pending，实际 v1 队列加载/确认/重载通过。停机最终快照与验证报告一致，导入 4 个账号、633 个确认 ID、0 pending。
- 正式 v2 在独立 8789 端口以 live 接管，v1 停止且禁用开机启动；两个完整自动检查周期四账号均正常，pending=0、gap=0。真实 Telegram 测试投递成功，公网主页 200、未认证 API 401，真实公网浏览器登录和健康状态验证通过，AI 关闭。
- 此时没有自然新增推文，真实测试消息不证明新推文入队至确认的完整链路；未进行长期压力测试或真实 AI 请求。实际生产回退未执行；已完成离线演练与接管后回退候选校验。

## 2026-10-29 AI 翻译功能验证

| 检查 | 环境 | 结果 |
|---|---|---|
| Node 依赖安装 | `npm ci --ignore-scripts` | 成功，未新增依赖；安装时公告查询为 0 个已知漏洞 |
| JS 语法检查 | Node.js 24.18.0 | 37 个文件通过 |
| Node 完整测试 | Node.js 24.18.0 | 258/258 通过，0 失败、0 跳过 |
| Python 采集器测试 | Python 3.13.5 / 独立 `.venv` | 36/36 通过 |
| 真实 Chromium | 正常 SSE / 禁用 SSE 后 HTTP 轮询 | 两种模式的 AI 配置保存、重新登录、Key 不回显及桌面/手机布局通过；各 0 脚本错误、0 浏览器外部请求 |
| 代码空白/补丁检查 | `git diff --check` | 通过 |
| 文档本地链接 | README 与 5 份功能/开发/验证文档 | 37 个链接有效 |

```sh
npm ci --ignore-scripts
npm run verify
git diff --check
```

完整验证日志：`/tmp/tweet-watcher-v2-ai-verify.log`。相比 2026-10-24 的 227 项新增 31 项 Node 测试，覆盖英文与其他语言判断、转推语言传播、旧队列/配置/事务兼容、密钥与地址更换保护、翻译响应校验、超时和流取消、缓存过期与配置隔离、失败原文兜底、翻译前原文持久入队、Telegram 重试仅翻译一次、等待 AI 时暂停/改配置取消旧发送、双语长度/emoji，以及 UI 草稿保护和密钥清除。

完整测试后收紧直接敏感配置写入对 `ai_api_key: null` 的拒绝，针对最终配置/事务代码补跑 `node --test test/config.test.js test/config-transaction.test.js`，17/17 通过，日志 `/tmp/tweet-watcher-v2-ai-config-final.log`。

浏览器验证使用临时只读实例与合成 AI 地址/密钥，填写并保存开关、地址、模型，重新登录后核对，确认 API 不回显 Key；桌面 1440×1000、手机 390×844 / 320×740 均无横向溢出。正常 SSE 与禁用 SSE 的 HTTP 轮询两种模式均通过，后者确认至少两轮状态/日志刷新。截图分别为 `/tmp/tweet-watcher-v2-ai-browser-sse/`、`/tmp/tweet-watcher-v2-ai-browser-poll/`，日志为对应路径加 `.log`。结束时清理临时服务和私有测试状态。

本次 AI 请求/响应与 Telegram 使用 mock；Python 原生传输测试只访问临时本机 TLS 服务。没有真实 AI 计费调用、真实模型译文质量验证、认证后的 X 采集或 Telegram 投递，没有发布或重启现有服务。本次未重新执行 Node 22；下方跨版本结果属于 2026-10-24 的历史代码，不能当成新增翻译功能的跨版本验证。

## 2026-10-24 审计修复验证（历史记录）

| 检查 | 环境 | 结果 |
|---|---|---|
| JS 语法检查 | Node.js 24.18.0 | 34 个文件通过 |
| Node 完整测试 | Node.js 24.18.0 | 227/227 通过，0 失败、0 跳过 |
| Node 完整测试 | Node.js 22.23.4 | 227/227 通过，0 失败、0 跳过 |
| Python 采集器测试 | Python 3.13.5 / 独立 `.venv` | 36/36 通过，0 失败、0 跳过 |
| 真实 Chromium | 正常 SSE / 禁用 SSE | 两种模式通过；各 0 脚本错误、0 外部请求 |
| 依赖一致性 | `pip check` | 通过 |
| npm 生产依赖公告检查 | `npm audit --omit=dev` | 本次数据库返回 0 个已知漏洞 |
| systemd 模板 | `systemd-analyze verify` | 通过；不代表已安装生产服务 |
| 代码空白/补丁检查 | `git diff --check` | 通过 |

Node 22/24 是同一套回归在两个运行时复核，不算两倍独立测试案例。Python 最低要求 3.11，但本机实际执行的是 3.13.5。公告检查只说明当时查询结果，不替代源码审查。

```sh
npm ci --ignore-scripts
npm run collector:install
npm run verify
# 可选的第二个 Node 运行时复核
npx --yes --package=node@22.23.4 node --test
.venv/bin/python -m pip check
npm audit --omit=dev
systemd-analyze verify deploy/v2/tweet-watcher-v2.service
git diff --check
```

最终完整测试日志：`/tmp/tweet-watcher-v2-fix-verify.log`、`/tmp/tweet-watcher-v2-fix-node22.log`；依赖安装和公告查询记录分别为 `/tmp/tweet-watcher-v2-fix-install.log`、`/tmp/tweet-watcher-v2-fix-collector-install.log`、`/tmp/tweet-watcher-v2-fix-npm-audit.json`。测试使用临时私有目录和合成凭据，未读取真实 Cookie 或 Telegram token。

本次新增 28 项 Node 回归，覆盖目录同步失败及重试、rename/unlink 已执行再返回 EIO、认证 epoch 与 outbox 提交屏障、新建嵌套目录及祖先同步、非 root 用户初始化、配置事务中断/损坏恢复、重复推文资料合并、转推长正文持久化、SSE 静默与测试按钮异步状态。额外验证 HTTP 正常时 SSE 重试/构造失败不能误报断连，以及真正 HTTP 失败或状态过期仍能显示异常。配置事务回归在多个提交阶段直接退出子进程，重新启动后检查完整旧版/新版或明确失败；另用合成 EIO 检查目录同步失败路径。这些测试验证错误处理和恢复逻辑，不代表实施过真实断电。

Python 36 项中已补充请求关闭推广内容的断言；固定 vendor 与依赖哈希未变。本次修改了自有桥接器请求参数和 Node 解析器，未重新执行认证后的真实 X 采集，也没有真实 Telegram 投递、发布或重启现有服务。

## 2026-10-23 清理验证（历史记录）

当日 JS 语法检查 33 个文件、Node 24/22 各 199/199、Python 36/36 通过。历史日志为 `/tmp/tweet-watcher-v2-public-verify.log`、`/tmp/tweet-watcher-v2-public-node22.log`。

beta.1 的 Node 测试为 212 项；当日删除 Bird 解析器、执行器和旧迁移功能对应的测试，将仍适用的队列、配置、权限和运行边界测试改为验证 twscrape。现有测试同时检查旧模式启动失败、旧 API 返回 404、未知执行器字段不会持久化，以及原生 v2 队列继续读取和恢复。测试计数变化不表示对真实 X 的新增验证。

清理后的首次验证为 191 项；随后为临时公网入口增加前端轮询兜底及 8 项回归，达到 199 项。覆盖无状态帧、断流恢复、超时、单飞、未保存草稿保护、配置同步、401 和旧会话结果隔离。临时公网入口已撤除，轮询功能及其测试保留。

- 运行源码、前端、脚本、package.json 和锁文件均无 Bird 或旧运行模式依赖；重新安装 Node 依赖后，完整依赖树无 Bird。
- 第一代部署模板和文档副本已移除；保留 v2 模板、MIT 归属和 Git 历史。Git 仅保留 v2 的 origin。
- 研究资料保留历史选型语境，SHA256SUMS 全部通过；历史变更说明和负向测试中的旧名称是有意保留的记录。
- 配置只保存当前字段；已有 v2 队列不重建基线。仅存在第一代 ID 文件时明确拒绝自动迁移，避免误丢历史。

## 覆盖的关键失败场景

- 整页保留，不能按 count 截断；混合坏记录、未知结构、GraphQL 部分错误或不明确终点失败关闭。
- 置顶、模块、未知社交上下文、其他作者不能建立时间覆盖边界；普通条目顺序异常拒绝。
- 所有历史游标参与循环检测；页预算耗尽、后页请求失败、原始证据写入失败均不推进水位。
- 采集检查点与最大已观察 ID 分离。置顶 500 / 普通 300 后出现普通 350 的回归确认不会漏推；第三方模块记录不按监控作者发送。
- 较小的新推文与已有较大 ID 队列正确合并；无新投递时检查点仍可推进；写盘失败、重启、损坏文件和目标变更的行为可核验。
- 引用、回复、转发、编辑 ID 和完整长正文跨队列重启保留，Telegram 文本长度受限。
- 默认关闭请求、只读禁止调度和发送；仅支持 development / read-only / live，接口与最底层出口均有守卫。
- 凭据经 stdin 传递，URL/HTTPS/主机限制、错误脱敏、总截止时间和协议大小限制。
- 真实 curl + 本机临时 TLS 服务验证：Cookie/CSRF 作用域、连接复用、重定向不跟随、超大响应实际中止；不是只检查 mock 参数。
- UTF-8 中文及 emoji 大文本穿过真实 Python 子进程时不被不必要的 ASCII 转义放大。

Telegram 发送与重启重试采用模拟发送端，没有对真实 Bot/Chat 发送测试消息。

## beta.1 的真实 X 只读验证（历史记录）

以下为清理前已完成的实测。2026-10-23 beta.2 清理没有再次请求真实 X 或发送 Telegram，当时采集器源码、解析器和固定依赖未更改。2026-10-24 审计修复已调整自有桥接器与解析器，因此以下历史结果不能替代修复版本的真实认证验证。

经用户授权，由进程直接读取正在运行的第一代 X Cookie，只传入采集进程，不在终端、报告或仓库显示。验证数据在独立私有 `/var/lib/tweet-watcher-v2-validation`，不写第一代状态。

| 场景 | 实际结果 |
|---|---|
| 签名初始化 | 当前 X 页面声明 1118 个资源引用，但直接定位到签名脚本；2 次请求完成初始化 |
| 初始快照 | 请求提示 10 条，完整返回并保留 20 条；1 页，非终点 |
| 有意跨页追赶 | 以首轮最老普通条目之前的水位继续查询；39 条 / 2 页，`reachedSince=true` |
| 重叠关系 | 跨页结果含首轮全部 20 条；23 条记录带引用/回复/转发关系 |
| v1 本地状态对照 | 首轮 20 个 ID 全部存在于该账号 v1 已发送集合；0 个处于待发送集合 |
| 最终解析器离线重放真实证据 | 首轮 20 条、跨页 39 条全部通过，普通边界数分别 20、39 |

初次实测曾因对脚本列表数量的过严限制失败，已修改为优先使用明确签名资源，并添加离线回归。没有放宽 Cookie/主机或重定向限制。

这些结果证明本次会话、该账号和当时响应结构可用，证明真实跨页覆盖能够完成。v1 对照读取的是本地交付状态，没有额外调用 Bird。它不证明所有账号类型、未来接口、历史编辑或长期运行都已经验证。

## 2026-10-24 浏览器验证

真实 Chromium 执行首次设置、登录/登出、合成配置保存、安装检测与只读控件检查。桌面 1440×1000、手机 390×844 和 320×740 均无横向溢出；0 脚本错误、0 外部网络请求，未调用采集或发送测试端点。布局检查与截图等待抽屉动画完成，手机设置截图限于视口。测试账号、密码与临时服务在结束后清理，截图去除了临时设置令牌。

复现需要 Playwright/Chromium；可用自己的安装路径：

```sh
PLAYWRIGHT_MODULE=/path/to/playwright-core \
CHROMIUM_PATH=/path/to/chrome \
BROWSER_SMOKE_ARTIFACTS=/tmp/v2-browser-artifacts \
node scripts/browser-smoke.cjs
```

最终浏览器验证分别覆盖正常 SSE 与禁用 SSE 两种情况，后者确认状态与日志至少完成两轮 HTTP 读取，设置、保存、登录和桌面/手机布局同样通过。每种模式保留 6 张截图，位于 `/tmp/tweet-watcher-v2-fix-browser-sse/` 和 `/tmp/tweet-watcher-v2-fix-browser-poll/`，对应日志为同名 `.log` 文件。复现禁用 SSE 的情况时，在上述命令增加 `BROWSER_SMOKE_DISABLE_SSE=1`。首帧后静默、时钟回拨及跨会话响应竞争另由前端状态机回归模拟验证；没有模拟真实代理设备故障。

本机复用隔离的 Playwright/Chromium 和共享库路径，没有安装系统包：

```sh
LD_LIBRARY_PATH=/tmp/tweet-watcher-browser-smoke/libs/usr/lib/x86_64-linux-gnu \
PLAYWRIGHT_MODULE=/tmp/tweet-watcher-browser-smoke/node_modules/playwright-core \
CHROMIUM_PATH=/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome \
BROWSER_SMOKE_ARTIFACTS=/tmp/tweet-watcher-v2-fix-browser-sse \
node scripts/browser-smoke.cjs
```

## 2026-10-23 预览与公网撤除（历史记录）

以下服务和公网状态最后核验于 2026-10-23。本次审计修复未重启或部署现有服务；上述浏览器测试使用自行创建并清理的隔离实例，不证明现有预览已加载修复。

独立预览启动在 `127.0.0.1:8788`，临时 unit 为 `tweet-watcher-v2-preview.service`，采用 DynamicUser、0700 私有状态目录和 `read-only` 模式。没有导入生产配置或凭据。首次设置令牌只从自己的终端查看：

```sh
journalctl -u tweet-watcher-v2-preview -n 30 --no-pager
```

预览是临时服务，不随服务器重启自动恢复。当前通过 SSH 或 VS Code 转发 8788，在自己的浏览器访问 `http://localhost:8788`，详见[工作交接](../SESSION_HANDOFF.md)。预览没有生产发送权。

beta.2 代码清理后的历史核验：重启预览后页面返回 HTTP 200、资源版本为 beta.2，监听本机 8788 并保持 read-only；当时第一代服务为 active，第一代工作区保持干净。

临时公网入口开放期间的历史核验：HTTPS 页面及安全响应头、HTTP 跳转、未登录私有 API 返回 401、跨来源登录和缺失设置令牌被拒绝；真实 Chromium 确认公网首次设置页面显示且无脚本错误。未通过公网创建密码或导入凭据；登录后的轮询功能使用上述独立合成浏览器实例验证。

2026-10-23 按用户要求撤除临时公网入口：移除专用 tunnel/gateway 服务、cloudflared 程序、私有公网配置目录及预览服务的 `public.conf` 覆盖配置，恢复本机端口转发访问。保留 v2 私有数据、只读模式和前端轮询功能。以上 HTTP 及浏览器结果是撤除前已有证据，不是本次撤除后的重新测试。

本次撤除后另行核验：tunnel/gateway unit 均为 `not-found`、`inactive`，18788 不再监听；预览进程不再设置 `PUBLIC_ORIGIN` / `TRUST_PROXY_TOKEN`，仍以 `read-only` 模式监听 `127.0.0.1:8788`，页面返回 HTTP 200、未登录私有 API 返回 401。旧临时公网地址返回 HTTP 530，已不能进入面板；第一代服务保持 active，第一代 Git 工作区干净。

## 尚未验证或有意保留的限制

- 已完成真实 Telegram 测试投递、生产切换及离线迁移回退演练；尚无自然新增推文的真实端到端投递案例，也未进行实际生产回退或整夜压力测试。
- 每轮 5 页 / 500 条 / 90 秒，未实现跨轮游标恢复；积压超界时持续失败关闭，需要核对后补采。
- 单 Cookie 会话；未实现多登录账号池、自动登录、验证码、完整文章正文或旧帖全量编辑扫描。
- 消息交付是至少一次，发送成功与本地确认之间崩溃可能重发。
- 证据按容量/保留期轮转，是诊断材料，不是无限期历史归档。
- GitHub Actions 因 workflow 授权限制未启用。现有结果来自本机实测，不是 CI 运行记录。
