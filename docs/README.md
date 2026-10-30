# 文档索引

适用版本：`0.2.0-beta.2`，已发布 GitHub 预发布版本；本机部署位置与发布入口见[维护交接](SESSION_HANDOFF.md)。日常使用和开发先看当前文档；带日期的审计、切换与逐次测试记录集中保存在历史归档。

| 文档 | 内容 |
|---|---|
| [项目说明](../README.md) | 功能、安装与启动模式 |
| [开发与配置](DEVELOPMENT.md) | 环境变量、数据持久性、采集约束与验证命令 |
| [架构与后续范围](ARCHITECTURE.md) | 当前实现、模块分工与未实现能力 |
| [AI 翻译](AI_TRANSLATION.md) | 非中文判断、模型配置、hi 测试与失败回退 |
| [来源、内容与会话](COLLECTION_FEATURES.md) | List/搜索/回复、筛选、媒体、限流、账号池与持续补采 |
| [部署说明](../deploy/v2/README.md) | 独立实例、HTTPS 代理与进程模式 |
| [迁移与回退](MIGRATION.md) | 状态转换、唯一发送实例与回退限制 |
| [当前验证摘要](VERIFICATION.md) | 本版测试结果、真实验证范围与限制 |
| [完整链路拟真演练](../scripts/simulation/README.md) | 本机 TLS 对端、故障/强杀、800 条压力、实际 API 浏览器和真实时钟观察 |
| [维护交接](SESSION_HANDOFF.md) | 本机运行位置、发布流程与下一步 |
| [首页与设置界面](DASHBOARD_REDESIGN.md) | 布局、设置分组、交互行为和统计口径 |

历史证据见 [archive](archive/README.md)，采集器选型材料见 [research](../research/twscrape-20261023/README.md)，本次扩展的设计依据见 [twscrape 功能评估（2026-10-29）](../research/twscrape-20261029-capabilities/README.md)。研究报告保留当时的候选评估，当前实现以功能指南为准；历史记录中的旧版本号、失败响应和“尚未发布”等描述仅适用于当时阶段。

维护时将当前行为写入对应指南，测试结论集中到验证摘要；逐次操作日志归档，不在多个指南中重复。文档不存放运行数据、凭据、原始敏感响应或备份。
