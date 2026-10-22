# CI 模板与启用状态

模板位于 [ci-template.yml](ci-template.yml)，包含 Node.js 22/24、按锁文件安装依赖、语法检查和离线应用测试，Actions 依赖固定到已核验的提交。

**自动 CI 尚未启用。** 2026-10-23 首次推送时，GitHub 拒绝当前 OAuth 登录创建 `.github/workflows/ci.yml`，原因为缺少 `workflow` scope；本机也没有可用的 GitHub SSH 授权。为完整发布应用代码，模板保存在非自动执行位置。

取得具备工作流写权限的 GitHub 授权后，将模板移到 `.github/workflows/ci.yml`，提交并推送即可启用。由用户在 GitHub 授权界面完成权限配置，不要把凭据写进仓库或聊天。

当前可以在本地执行：

```sh
npm ci --ignore-scripts
npm run check
npm test
```

本机 Node.js 24.18.0 已通过语法检查和 157 项测试。Node.js 22 的 CI 矩阵尚未运行，不能把模板已准备当作验证通过。
