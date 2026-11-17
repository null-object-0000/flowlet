# 安装包自动构建

当前仅发布 **Electron + Node/TS 桌面端**；Rust/Tauri 安装包、回滚构建及移动分发已移除。
Web/Docker 部署见 [Docker 部署文档](docker.md)，官网部署见 [website/README.md](../website/README.md)。

## 触发方式

正式安装包由 `.github/workflows/build-installers.yml` 构建：

- Actions → **Build installers → Run workflow**：产物保存在本次 Artifacts；
- 发布 GitHub Release：构建并上传到对应 Release。Release 必须指向需要发布的版本提交。

`.github/workflows/desktop-electron.yml` 提供独立的 Electron 构建与 Linux 冒烟；
具体触发条件与矩阵以工作流文件为准，不再与旧宿主双轨发版。

发布前用 `npm run version:set -- <版本号>` 同步版本；脚本更新根 `package.json`、锁文件与
`packages/flowlet-desktop/package.json`；其它 workspace 版本如需独立发布须单独核对。不再维护 Cargo 或旧宿主配置版本。

## 依赖与本地构建

CI 使用 Node.js 26、Go 1.27.x（官方 ACP Go 辅助程序）和 Python 3（Windows/Linux 便携 ZIP）。
Electron 与 electron-builder 版本来自 `packages/flowlet-desktop/package.json`。
保留 Go ACP 桥不表示仍有 Rust 运行时依赖。

```bash
npm ci
npm run node:commands
npm run check
npm run node:typecheck
npm run desktop:typecheck
npm run fetch:catalogs
npm run desktop:dist
# Windows/Linux 便携 ZIP：
node scripts/build-desktop-portable.mjs --no-build
```

`npm run node:commands` 运行 `scripts/check-command-contract.mjs`，只核对静态命令名称、
Node 注册和 Web 权限白名单；不验证参数、返回值、动态调用或实际行为覆盖率。
发布仍需相关 Node 测试、`npm run node:e2e` 和 Electron 冒烟，不能用静态检查代替。

## 构建产物

产物目录为 `packages/flowlet-desktop/release/`，命名模板为
`Flowlet_${version}_${os}_${arch}.${ext}`（electron-builder 实际生成的安装器后缀以 Release 为准）。

| 平台 | 架构 | 产物 |
| --- | --- | --- |
| Windows | x64 | NSIS `.exe`、`.zip`、带 `portable.tag` 的便携 ZIP；不再提供 MSI |
| Linux | x64 | AppImage、Debian `.deb`、便携 ZIP |
| macOS | Apple Silicon / Intel | `.dmg` |

便携目录位于 `release/portable/Flowlet_<ver>_<platform>_<arch>_portable/`。
`npm run desktop:update:portable` 只更新 Electron 布局，保留配置、SQLite、日志及用户数据；
操作前应退出并备份，详见 [Electron 宿主](desktop-electron.md#便携版构建与更新electron)。

## 平台验证状态

既有完整回归主要来自 Windows 11 原生环境（无 WSL）。CI 能构建 Windows/Linux/macOS
不等于已完成当前版本的真机验证。每次发版都应记录实际验证的版本、系统与结果；
不能将旧迁移记录或某一次 Linux xvfb 冒烟当作当前全部平台已通过。

人工回归至少涵盖安装/升级、旧库打开、代理及流式请求、托盘关闭/退出、Agent 配置
inspect→apply→reapply→restore、S3/LAN 同步、账号工作区与 host/client 模式边界。
未验证项必须留在发布说明中。

## 桌面签名说明

Windows 安装包当前未配置正式代码签名。macOS 的 electron-builder 配置为 `identity: "-"`
（ad-hoc），正式发布工作流会挂载 DMG 并运行 `codesign --verify`，确认签名类型为 `adhoc`
后才上传。ad-hoc 不代表开发者身份，也不等同于 Apple 公证。

只对从官方 Release 下载且核对 SHA-256 的文件手动放行：先在系统设置的“隐私与安全性”
中尝试“仍要打开”；如仍被隔离，可执行：

```bash
xattr -dr com.apple.quarantine /Applications/Flowlet.app
open /Applications/Flowlet.app
```

正式签名后应改为 Developer ID、notarization 与 stapling，并删除不再需要的手动放行说明。

## 资源来源

- 图标：仓库根 `resources/icons/`，electron-builder 的 `buildResources` 与平台 icon 指向此处；
- 模型规格/价格快照：`resources/catalogs/models-cn.json`、`resources/catalogs/models-dev.json`；
- 可选受管 Agent 扩展：`resources/agent-plugins/`；
- `scripts/build-desktop-host.mjs` 将运行时资源装配到 `dist-host/runtime`，最终随包放在
  `resources/runtime`；前端位于随包 `resources/desktop-static`。

不要将应用资源目录与用户数据目录混淆。用户数据定位以
`packages/flowlet-desktop/src/paths.ts` 为准。
