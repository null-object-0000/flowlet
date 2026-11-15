# 安装包自动构建

桌面端使用 `.github/workflows/desktop-electron.yml`（Electron + Node Host），
Android 使用 `.github/workflows/build-installers.yml`（Tauri/Rust）。Tauri 桌面构建、
发布与便携版脚本已退役；保留 Android 工程和 Node Host 核心。

`src-tauri/` 已进一步裁剪为 Android 同步查看器，不再包含旧桌面、headless 或 Rust CLI。
Cargo 默认 feature 为 `mobile`；Android CI 先运行核心 Rust 测试再构建 APK。
边界与数据兼容说明见 [Android Rust 裁剪](android-rust-boundary.md)。

## 触发与产物

两个工作流都支持手动运行及 GitHub Release 发布触发；发布时将对应产物上传至该 Release。
Electron 也保留 `v*-beta*` 标签推送触发，标签推送仅保存 workflow artifacts。

| 平台 | 架构 | 产物 |
| --- | --- | --- |
| Windows | x64 | NSIS `.exe`、应用 `.zip`、带 `portable.tag` 的便携 `.zip` |
| Linux | x64 | AppImage、Debian `.deb` |
| macOS | arm64 / x64 | `.dmg`，ad-hoc 签名，未公证 |
| Android | arm64 | 正式签名 `.apk`，实验性移动辅助端 |

各平台任务独立。Linux 桌面 job 包含 Node 测试、154 条冻结命令兼容基线检查、
首屏与全部页面冒烟；Windows/macOS 跑类型检查与 Node 测试并打包。
这些 CI 定义的更新尚需在线运行验证；构建成功不代表跨平台真机回归完成。
当前主要开发环境为 Windows 11 原生环境，Linux/macOS 仍需真机验证。

发布前执行 `npm run version:set -- <semver>`：同步根包、Electron 包和 Android
Rust crate 版本；Tauri 配置从根 `package.json` 读取版本。

## 本地构建

```bash
npm ci
npm run fetch:catalogs
npm run desktop:dist
npm run desktop:portable
```

共享图标、Agent 扩展源码分别位于 `resources/icons/` 与 `resources/agent-plugins/`；
共享模型目录由抓取脚本生成到 `resources/catalogs/`，Electron 和 Android 均从这里读取。
macOS 使用 `resources/icons/macos-icon.icns`，其余桌面平台使用通用图标。
模型目录未入库，缺失时构建会报告需先拉取，不会静默打出缺少目录的 Electron 包。

Android 使用 `npm run tauri:android:init`、`npm run tauri:android:build`，
AAB 使用 `npm run tauri:android:build:aab`。Android CLI、签名与上传蒲公英步骤保留。
根脚本 `tauri` 保留给 Android Gradle 的 `android-studio-script` 回调使用；
桌面入口 `tauri:dev`、`tauri:build` 和 Tauri 便携版脚本已移除。

## Android 签名

Release job 需要 GitHub Actions Secrets：`ANDROID_KEYSTORE_BASE64`、
`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`；
上传蒲公英另需 `PGYER_API_KEY`。CI 使用 Android SDK `apksigner` 验证正式签名，
keystore 与临时配置不入库、不作为 artifact 上传。

## 桌面签名

Windows 安装包当前未签名。macOS 使用 electron-builder `identity: "-"` 进行 ad-hoc
签名，在上传前运行 `codesign --verify --deep --strict` 并检查签名类型。ad-hoc 不代表
开发者身份或 Apple 公证；Gatekeeper 仍可能阻止首次启动。正式分发需补充 Developer ID、
Apple notarization/stapling 与 Windows 代码签名。
