# 安装包自动构建

仓库通过 `.github/workflows/build-installers.yml` 构建桌面安装包。

## 触发方式

- 在 GitHub 仓库的 **Actions → Build installers → Run workflow** 中手动触发。构建结果保存在该次运行的 Artifacts 中。
- 发布 GitHub Release 时自动触发。构建结果除保存在 Artifacts 外，还会自动上传到对应 Release。

Release 应指向需要构建的版本提交。发布前请同步更新 `package.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 中的版本号。

## 平台验证状态

当前主要开发与完整回归环境是 **Windows 11 原生环境**，开发流程未启用或依赖 WSL。

GitHub Actions 会为 Windows、Linux 和 macOS 生成产物，但“自动构建成功”不等同于已经完成
对应系统的真机功能回归。Linux 与 macOS 当前尚未完成作者真机回归验证；后续在对应环境完成
安装、启动、代理、托盘、Agent 接入与核心数据链路测试后，再更新支持状态。

## 构建产物

| 平台 | 架构 | 产物 | 当前验证状态 |
| --- | --- | --- | --- |
| Windows 11 | x64 | NSIS `.exe`、MSI `.msi`、便携版 `.zip` | 主要开发与完整回归环境（原生、无 WSL） |
| Linux | x64 | AppImage、Debian `.deb` | CI 自动构建，尚未完成作者真机回归 |
| macOS | Apple Silicon | `.dmg` | CI 自动构建，尚未完成作者真机回归 |
| macOS | Intel | `.dmg` | CI 自动构建，尚未完成作者真机回归 |

四个平台任务彼此独立；单个平台失败不会取消其他平台正在执行的构建。

## 签名说明

当前流程生成未签名安装包，不需要额外仓库 Secret。正式对外分发前，建议补充 Windows 代码签名以及 macOS Developer ID 签名和公证，否则系统可能显示未知发布者或阻止直接打开。
