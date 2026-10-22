# CI 模板与启用状态

模板位于 [ci-template.yml](ci-template.yml)，包含 Node.js 22/24、按锁文件安装依赖、语法检查、Node 离线应用测试与 Python 采集器测试，Actions 依赖固定到已核验的提交。

**自动 CI 尚未启用。** 2026-10-23 首次推送时，GitHub 拒绝当前 OAuth 登录创建 `.github/workflows/ci.yml`，原因为缺少 `workflow` scope；本机也没有可用的 GitHub SSH 授权。为完整发布应用代码，模板保存在非自动执行位置。

取得具备工作流写权限的 GitHub 授权后，将模板移到 `.github/workflows/ci.yml`，提交并推送即可启用。由用户在 GitHub 授权界面完成权限配置，不要把凭据写进仓库或聊天。

当前可以在本地执行：

```sh
npm ci --ignore-scripts
npm run collector:install
npm run verify
```

本地 Node.js 22/24 与 Python 的最终测试结果见 [验证记录](../docs/VERIFICATION.md)。自动 CI 尚未运行，不能把模板已准备当作 Actions 验证通过。
