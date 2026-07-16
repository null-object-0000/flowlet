# 安装包自动构建

仓库通过 `.github/workflows/build-installers.yml` 构建桌面安装包。

## 触发方式

- 在 GitHub 仓库的 **Actions → Build installers → Run workflow** 中手动触发。构建结果保存在该次运行的 Artifacts 中。
- 发布 GitHub Release 时自动触发。构建结果除保存在 Artifacts 外，还会自动上传到对应 Release。

Release 应指向需要构建的版本提交。发布前请同步更新 `package.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 中的版本号。

## 构建产物

| 平台 | 架构 | 产物 |
| --- | --- | --- |
| Windows | x64 | NSIS `.exe`、MSI `.msi`、便携版 `.zip` |
| Linux | x64 | AppImage、Debian `.deb` |
| macOS | Apple Silicon | `.dmg` |
| macOS | Intel | `.dmg` |

四个平台任务彼此独立；单个平台失败不会取消其他平台正在执行的构建。

## 签名说明

当前流程生成未签名安装包，不需要额外仓库 Secret。正式对外分发前，建议补充 Windows 代码签名以及 macOS Developer ID 签名和公证，否则系统可能显示未知发布者或阻止直接打开。
