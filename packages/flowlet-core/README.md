# Flowlet Node/TS Core

以下 `src/`、`bin/` 路径相对本包目录；npm 命令从仓库根运行。

当前 Electron 桌面与独立 Web/Docker 共用的 Node 核心，不保留 Rust/Tauri 实现或回滚构建。

## 入口与职责

- `src/index.ts`：`startHost()` 装配 SQLite、配置、模型代理、管理 HTTP 与后台维护；
- `src/config/index.ts`：外部/随包默认配置、渠道合并与运行时快照；
- `src/web/commands.ts` / `src/web/permissions.ts`：显式管理命令与权限白名单；
- `src/desktop/commands.ts`：仅 `ctx.desktop` 存在时可用的桌面能力，见 [桌面命令](src/desktop/README.md)；
- `src/proxy/`、`src/storage/`、`src/agent/`、`src/device/`、`src/services/`：转发、存储、Agent 与桌面同步。

命令经 `POST /api/commands/{command}`，管理凭据与模型 Client Token 分开鉴权。
core 不导入 electron，平台能力只走 `ctx.desktop.host.invoke(channel, payload)`。
Web/Docker 不扫描个人 Agent 文件、不写本机 Agent 配置、不执行桌面控制台抓取。
ACP 程序需按部署显式启用；官方 Go ACP 辅助程序继续保留，不是旧宿主依赖。

## 开发与验证（仓库根运行）

使用 Node.js 26 与根目录统一 npm 安装：

```bash
npm ci
npm run build:web
# 先设置独立数据路径与随机 FLOWLET_ADMIN_TOKEN，避免误用真实用户库
npm run node:host
npm run node:typecheck
npm run node:commands
node --test packages/flowlet-core/src
npm run node:e2e
```

`node:commands` 仅检查静态命令名、注册与 Web 权限白名单，不验证动态调用、参数、返回值或行为覆盖率。
具体测试应使用临时目录和 mock，不调用付费模型。

## 共享资源与兼容

根 `config.json`、`model-catalog.json`、`plugin-registry.json` 是默认配置和受控声明。
随包图标/规格快照/可选扩展分别在根 `resources/icons`、`resources/catalogs`、`resources/agent-plugins`；
真实上游配置及会话 fixture 位于本包 `test-fixtures/`。

必须保留 SQLite 增量迁移、设备身份、版本化快照、S3/LAN 与加密账号工作区契约；
不能因移除旧宿主而重建用户数据或把观测摘要扩大成凭据/原始报文同步。
当前架构、配置与运行细节见 [架构](../../docs/architecture.md)、[配置](../../docs/config.md)、
[Docker](../../docs/docker.md)；`docs/migration/` 是已归档的历史记录。
