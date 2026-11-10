# Electron 桌面宿主（packages/flowlet-desktop）

> 状态：**实现中 / 冒烟通过**（2026-11-10）。Rust/Tauri 版仍是行为权威参考
> （`src-tauri/**` 只读）；本包是桌面端迁移到 Electron + Node/TS 后的正式宿主。
>
> 设计决策见 [`electron-migration-plan.md`](./electron-migration-plan.md)、
> [`migration/platform-gap-matrix.md`](./migration/platform-gap-matrix.md)、
> [`migration/node-host.md`](./migration/node-host.md)、
> [`migration/commands-and-schema.md`](./migration/commands-and-schema.md)。

---

## 1. 架构与进程结构

```text
Electron main（Node 24 / ESM，dist-host/main.mjs）
  ├─ 解析数据目录（与 Rust 一致）→ app.setPath(userData/sessionData)
  ├─ 单实例锁 + 第二次启动聚焦
  ├─ 生成随机管理 token（32B base64url，≥24 字符）
  ├─ 动态 import dist-host/core-host.mjs
  │    └─ flowlet-core startHost()（同进程）
  │         ├─ SQLite（node:sqlite，直接打开 Rust 同库）
  │         ├─ 本地代理 127.0.0.1:18640（可配）
  │         ├─ Web Host 127.0.0.1:0（随机端口，静态服务 dist-desktop）
  │         └─ `/api/commands/*` 桌面命令超集（DesktopHostBridge → main）
  ├─ BrowserWindow（frame:false，1200×720 最小客户区，preload.cjs）
  │    └─ 加载 http://127.0.0.1:<port>/（React 前端 dist-desktop）
  ├─ 托盘（打开主窗口 / 退出 Flowlet）
  └─ DesktopHostBridge：platform.* / keyring.* / agentRuntime.* / scrape.* / power.*
```

关键点：

- **前端零重写**：桌面模式（`vite --mode desktop`）仍然通过本机 HTTP
  `POST /api/commands/{command}` 调命令；管理 token 由 preload 注入
  `window.flowletDesktop.adminToken`，不再需要登录页。
- **主进程不直接 import Electron 到 core**：`flowlet-core` 只认
  `DesktopHostBridge.invoke(channel, payload)`，平台能力全部收口在
  `packages/flowlet-desktop/src/bridge.ts`。
- **core-host 独立 bundle**：`flowlet-core` 内部用 `import.meta.url` 定位
  config/model 目录与 capture-cleanup worker；bundle 会改变路径。构建脚本用
  esbuild 插件把这些 URL 重写到运行期 `FLOWLET_RUNTIME_ROOT_URL` 下的虚拟目录树
  （`packages/flowlet-core/src/...`），因此 core 与 main 必须分成两个 bundle，
  且 main 在动态 import core-host 之前设置该环境变量。

### 启动链路（谁启动谁）

1. `scripts/build-desktop.mjs`：`vite build --mode desktop --outDir dist-desktop`
   → `scripts/build-desktop-host.mjs`（bundle + runtime 资源）。
2. Electron 启动 `dist-host/main.mjs` → 解析路径、单实例锁。
3. `main` 生成 admin token，设置 `FLOWLET_ADMIN_*` / `FLOWLET_RUNTIME_ROOT_URL`。
4. `main` 动态 import `core-host.mjs` → `startHost()`（同进程，非 sidecar）。
5. `startHost` 返回真实 `webAddr`（`127.0.0.1:0` 由系统分配）。
6. `main` 创建窗口加载 `http://<webAddr>/`，再创建托盘。
7. 退出：托盘「退出 Flowlet」/ `platform.quit` → `stop_proxy` 命令 →
   `host.close()`（dispose 代理）→ `agentRuntime.stopAll()` → `app.exit(0)`。

窗口关闭（标题栏 × 或 `window:close`）只隐藏到托盘，代理继续运行；
`window-all-closed` 不退出进程。

---

## 2. 数据目录（必须与 Rust/Tauri 版一致）

权威实现：

- `src-tauri/src/lib.rs::app_database_path`：**SQLite 始终在 exe 同级目录**；
- `src-tauri/src/core/webview_profile.rs::is_portable`：exe 旁存在
  `portable.tag` 即便携版；
- `scripts/build-portable.mjs`：复制 `config.json` / 模型目录并写入
  `portable.tag`。

Electron 侧解析（`packages/flowlet-desktop/src/paths.ts`）：

| 形态 | 数据目录（DB/config/logs/凭据密文） | WebView / partition 根 | 前端静态资源 |
| --- | --- | --- | --- |
| 便携版（exe 旁 `portable.tag`） | `dirname(exe)` | `dirname(exe)/data/webview` | `resources/desktop-static` |
| 安装版 | `dirname(exe)`（不可写时降级 `%LOCALAPPDATA%/site.snewbie.flowlet`） | Windows `%LOCALAPPDATA%/site.snewbie.flowlet`；Linux `$XDG_DATA_HOME/site.snewbie.flowlet`；macOS `~/Library/Application Support/site.snewbie.flowlet` | `resources/desktop-static` |
| 开发（`app.isPackaged=false`） | `<repo>/.flowlet-dev-data/desktop`（可用 `--data-dir` 覆盖） | `<dataDir>/webview` | `<repo>/dist-desktop` |

- **不使用 Electron 默认 `userData`**：`app.setPath("userData", <webviewRoot>/main-webview)`、
  `app.setPath("sessionData", <webviewRoot>)` 必须在 `ready` 前调用。
- 主窗口 partition：`persist:main-webview`；抓取窗口：`persist:scrape-<accountId>`。
  与 Rust 的 per-account user-data-dir 相比，目录名不同（`Partitions/` 下），但
  cookie/localStorage/IndexedDB/cache 同样按账号隔离；**既有 WebView2/WebKitGTK
  登录态无法迁移**（HG-5），用户需要重新登录。
- 首次启动会把随包 `config.json` / `model-catalog.json` / `models-cn.json` /
  `models-dev.json` 复制到数据目录（目标已存在则跳过），与 Rust setup 行为一致。
- 窗口记忆：`<dataDir>/window-state.json`（只保存 SIZE/POSITION/MAXIMIZED，
  不保存可见性；启动后按 workArea 校正到可见屏幕）。
- 日志：`<dataDir>/logs/flowlet-desktop.log`（5MB 轮转）。
- 凭据密文：`<dataDir>/desktop-secrets.json`（0600）。

> ⚠️ 便携版判定以 `portable.tag` 为准；Electron 的 `app.requestSingleInstanceLock()`
> 锁按 userData 生效，因此不同数据目录的便携副本可以各自独立运行。

### 便携版构建与更新（Electron）

Tauri 时代的 `tauri:build:portable` / `tauri:update:portable` 只认 `src-tauri/target/release`
和 `flowlet(.exe)`，**Electron 桌面端不走这套**。对应命令：

```bash
npm run desktop:portable           # 前端+host → electron-builder --dir → 组装便携目录 → 打 zip
npm run desktop:update:portable    # 构建 → 停进程 → 覆盖程序文件（保留数据）→ 重启
```

产物（`scripts/build-desktop-portable.mjs`）：

| 路径 | 内容 |
| --- | --- |
| `packages/flowlet-desktop/release/<platform>-unpacked/` | electron-builder `--dir` 原始产物 |
| `packages/flowlet-desktop/release/portable/Flowlet_<ver>_<platform>_<arch>_portable/` | 便携目录：可执行文件 + `resources/` + `portable.tag` + 仓库 `config.json` |
| `…/Flowlet_<ver>_<platform>_<arch>_portable.zip` | 便携版压缩包 |

- 可执行文件会被统一改名成 `Flowlet.exe`（Windows）/ `flowlet`（Linux）；electron-builder
  按 `package.json` 的 name/productName 命名，构建脚本会自己认出来再改名。
- **Linux** 额外生成 `Flowlet.sh` 启动器（带 `--no-sandbox`）：便携目录里的
  `chrome-sandbox` 没有 root+setuid，直接双击会因为 sandbox 校验失败 abort。
- 首次打包需要能访问 `github.com/electron/electron/releases` 下 electron 二进制，
  受限网络先 `export HTTPS_PROXY=http://127.0.0.1:7890`。

`scripts/update-portable.mjs` 现在**两种布局都认**（`--layout auto|tauri|electron`，
按目录里的 `resources/app.asar` 或 `flowlet_lib.*` 判断）：

- `npm run desktop:update:portable` → `--layout electron`
- `npm run tauri:update:portable` → `--layout tauri --replace-config`（保持旧行为）
- 覆盖时保留：`config.json`、`portable.tag`、`flowlet.sqlite*`、`data/`、`logs/`、`desktop-config.json`
- `--skip-build` 可跳过构建直接用现有产物；`--dry-run` 只打印识别结果

---

## 3. Host channel 契约

契约来源：`packages/flowlet-core/src/desktop/README.md`。main 侧实现
`DesktopHostBridge`（`src/bridge.ts`）。**未知 channel 会 reject
`未实现的桌面宿主 channel：...`**，不静默返回 null。

| channel | 实现要点 |
| --- | --- |
| `platform.appInfo` | `{version,dataDir,portable,platform,arch}` |
| `platform.openExternal` | 仅 `http/https`；`shell.openExternal` |
| `platform.logFromFrontend` | 写主进程日志（`platform.diagnostics` 可见） |
| `platform.diagnostics` | 版本/路径/safeStorage backend/代理状态/日志尾部 |
| `platform.notify` | `Notification.isSupported()`；不支持时 reject 可读错误 |
| `platform.trayTooltip` | `tray.setToolTip` |
| `platform.autostart.get/set` | win/mac `app.setLoginItemSettings`；Linux 写 `~/.config/autostart/flowlet.desktop`（`Exec="<exe>" --hidden`） |
| `platform.relaunch` | `app.relaunch()` + 正常退出流程 |
| `platform.quit` | 停代理 → 关 Host → 停运行时 → `app.exit(0)` |
| `keyring.get/set/delete` | safeStorage 密文文件；首次读到 Rust keyring 旧条目时迁移；删除同步清旧条目 |
| `agentRuntime.start/stop/status` | 目前实现 DSH：`dsh web --no-open` 或 `npx @deepseek-ai/dsh web --no-open`，健康检查 127.0.0.1:3080（20s），外部进程不接管 |
| `scrape.openConsole/closeConsole/runPlan/cancel/probeLogin/evaluate` | CDP + 隐藏 BrowserWindow + per-account partition，见 §4；`evaluate` 在已打开窗口内直接执行 extractor（不导航、不等网络），供 `scrape_balance` 复用 probe 阶段响应 |
| `power.preventSuspend` | `powerSaveBlocker.start("prevent-app-suspension")` / `stop`（不阻止熄屏） |

### keyring 与 Rust 旧条目

Rust 只把两类密钥放 OS 凭据库（账号 API Key 仍在 SQLite 明文，与现状一致）：

- S3 Secret：service `Flowlet Device Sync`，username
  `s3-<sha256(endpoint\0bucket\0access_key_id)>`；
- 账号工作区密钥：service `Flowlet Account Workspace`，username 同上。

兼容读取：

- Linux：`secret-tool lookup service <service> username <username>`（兼容 `account`）；
- macOS：`security find-generic-password -s <service> -a <username> -w`；
- Windows：PowerShell P/Invoke `CredRead`，target 依次尝试
  `<service>.<username>`、`<service>`。

读到旧值后立即用 safeStorage 重新加密写入 `desktop-secrets.json`；**迁移失败只
告警**，不影响本次读取。Linux 无 Secret Service 时 safeStorage 会退化为
`basic_text`（弱加密），`platform.diagnostics.safeStorageBackend` 会显式暴露。

---

## 4. 控制台抓取（CDP）与 runPlan 最小契约

- 每个账号一个隐藏 `BrowserWindow`（1440×900，`show:false`）+ partition
  `persist:scrape-<accountId>`；登录态保存在 partition 中，`destroy()` 不丢登录。
- `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`；
  `setPermissionRequestHandler` 全拒、`setWindowOpenHandler` 拒绝弹窗。
- UA：默认 Chromium UA；`channelId === "longcat"` 时固定
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/126.0.0.0 Safari/537.36`
  （沿用 Rust `scrape_console.rs` 策略；Qwen 走阿里云 SSO，不覆盖 UA）。
- 响应捕获：`webContents.debugger.attach("1.3")` →
  `Network.enable`（maxResourceBufferSize 8MB）→ `Network.responseReceived` +
  `Network.loadingFinished` → `Network.getResponseBody`。
- 同时保留最多 3 个窗口（Rust `SCRAPE_WEBVIEW_MAX_LIVE`）；超限回收最旧窗口。

### `scrape.runPlan` 的 plan（最小可用定义，与 desktop-scrape 对接）

```ts
interface ScrapePlan {
  consoleUrl?: string;              // 第 1 阶段导航
  consoleUrlSecondary?: string;     // 第 2 阶段
  consoleUrlTertiary?: string;      // 第 3 阶段
  interceptorJs?: string;           // document-start 注入（兼容 Rust config 的 __TAURI_INTERNALS__ 调用）
  extractorJs?: string;             // 捕获后执行：async (bundle, credential) => unknown
  requiredSlots?: string[];         // 收齐这些槽位才算捕获完成
  slotRules?: {
    slot: string;
    urlContains?: string[];
    urlRegex?: string;
    fallback?: boolean;             // 无显式规则命中时兜底（custom_scrape match.kind=fallback）
  }[];
  aggregate?: boolean;              // 多阶段同槽位 JSON 数组合并
  credential?: unknown;             // extractor 第二参数；命令层传 { keyPrefix, keyLastFour }
  timeoutMs?: number;               // 默认 30s
}
```

返回 `{ result }`：`result` 默认是 `{ [slot]: parsedJson }`；提供 `extractorJs`
时取 extractor 返回值。

另有 `scrape.evaluate`（payload `{accountId, source, bundle, credential, timeoutMs?}`）：
在**已存在的** per-account 抓取窗口里执行 `(<source>)(bundle, credential)`，
不导航、不等网络，返回 `{ result }`；脚本抛错/超时（默认 10s，对齐 Rust
`eval_with_callback`）reject 可读错误，窗口不存在返回「抓取窗口未打开」。
用于 Rust `scrape_balance` 复用 probe 阶段已捕获响应的场景。`interceptorJs` 在 main world 注入，目前提供
`__TAURI_INTERNALS__.invoke` 兼容 shim（resolve null），因此沿用 Rust config 的
内置 interceptor 不会报错；**响应捕获以 CDP 为准**，不依赖页面 IPC 回传。

> `probeLogin` 当前是 URL/页面文本启发式（`login|signin|auth|sso` 或
> "登录/扫码登录"），待 desktop-scrape 提供渠道级登录页规则后替换。
> `scrape.ts` 的 `onCdpMessage` 对非文本 MIME 直接跳过；大响应（>8MB）丢弃。

---

## 5. 窗口、托盘与自启

- 无边框：`frame:false`、`useContentSize:true`、`minWidth/minHeight 1200×720`，
  并用 `win.setMinimumSize(1200,720)` 二次约束。
- 记忆尺寸/位置/最大化；启动 400ms 后 `ensureWindowOnScreen` 校正。
- `maximize`/`unmaximize` → 向渲染进程发 `window:maximized-changed`
  （payload `{maximized}`；preload 归一成 boolean 回调）。
- 标题栏拖动：**优先 CSS `-webkit-app-region: drag`**；preload 同时提供
  `window.startDragging()`（IPC 模拟：pointermove → main `setPosition`）兜底。
- 八向缩放：`window.startResizeDragging(direction)` / `resizeBegin`，preload 转发
  pointermove/pointerup，main 用 `setBounds` 跟随（节流由渲染进程 pointermove 频率决定）。
- 托盘菜单只有「打开主窗口」「退出 Flowlet」；**不提供暂停代理入口**。
  左键点击托盘显示/聚焦主窗口。
- 自启：win/mac `setLoginItemSettings`；Linux 写 XDG autostart，参数 `--hidden`，
  启动时隐藏到托盘。

---

## 6. 开发 / 构建 / 打包

```bash
# 前端 desktop 产物（frontend-desktop 负责）
npm run build:desktop            # tsc && vite build --mode desktop --outDir dist-desktop

# 桌面壳 bundle（main/preload/core-host/runtime）
node scripts/build-desktop-host.mjs

# 完整构建（前端 + 宿主）
npm run desktop:build            # node scripts/build-desktop.mjs

# 开发启动（构建后拉起 Electron）
npm run desktop:dev              # node scripts/build-desktop.mjs --dev
npm run desktop:dev -- --data-dir=/tmp/flowlet-dev   # 隔离数据目录

# 打包（electron-builder；Linux 出 AppImage+deb，Windows nsis+zip，mac dmg）
npm run desktop:dist
# 已在本机验证（linux x64）：
#   release/Flowlet-0.2.0.AppImage         (131 MB)
#   release/flowlet-desktop_0.2.0_amd64.deb (92 MB)

# 类型检查
npx tsc -p packages/flowlet-desktop/tsconfig.json
npm run node:typecheck

# xvfb 冒烟（截图 + /health + preload 证据）
npm run desktop:smoke

# host channel 自检（keyring/自启/电源/运行时/未知 channel 错误）
xvfb-run -a packages/flowlet-desktop/node_modules/electron/dist/electron \
  packages/flowlet-desktop --no-sandbox --disable-gpu --host-self-test --data-dir=/tmp/flowlet-selftest
```

`desktop:build` 会按顺序执行：`vite build --mode desktop --outDir dist-desktop` →
`build-desktop-host.mjs`。若 desktop 前端构建失败，可加 `--fallback-static` 临时
把 `dist-web` 复制成 `dist-desktop` 做壳层冒烟（汇报中必须注明）。

### Electron 二进制获取（本机无系统 Electron）

本机 `~/.cache/electron/5a625dfd.../electron-v44.7.0-linux-x64.zip` 已有可用
linux-x64 包。直接 `npm i -D electron@44.7.0` 在受限网络下可能失败，可手工安装：

```bash
cd packages/flowlet-desktop
ELECTRON_CACHE=$HOME/.cache/electron npm install --no-package-lock --no-save \
  --workspaces=false electron@44.7.0 esbuild@0.28.2
# npm 若跳过 install 脚本，手工解压：
cd node_modules/electron
mkdir -p dist
unzip -q -o "$HOME/.cache/electron/5a625dfd3df3efc3971556afe64989f9aa6ea0f4cd6e33889c1951789041498f/electron-v44.7.0-linux-x64.zip" -d dist
chmod +x dist/electron
printf 'electron' > path.txt
```

开发脚本会自动在 `chrome-sandbox` 非 root:4755 时追加 `--no-sandbox`，并在
`DISPLAY` 存在时追加 `--ozone-platform=x11`（Wayland 环境不指定会不映射窗口）。

---

## 7. 验证记录（2026-11-10，本机 xvfb）

```bash
npm run desktop:build
# → vite build --mode desktop --outDir dist-desktop
# → build-desktop-host.mjs（main 69KB / core-host 1.9MB / preload 2.9KB / runtime）
```

```bash
npm run desktop:smoke
# 关键输出：
FLOWLET_UI_TITLE=Flowlet
FLOWLET_UI_TEXT_LENGTH=573
FLOWLET_UI_TEXT_HEAD=Flowlet v0.2.0 工作台 运行概览 模型服务 服务凭据 运行记录 请求日志 会话管理 分析 用量统计 用量洞察 应用设置 运行中 本地代理 · 已运行 0分钟 今日消耗 —Tokens 客户端接入 OpenAI Anthropic 接入详情 http://127.0.0.1:18640/v1
FLOWLET_DESKTOP_BRIDGE=present
FLOWLET_ADMIN_TOKEN_LENGTH=43
FLOWLET_SCREENSHOT=.../flowlet-desktop-smoke.png 1200x720

===== SMOKE REPORT =====
{
  "exitCode": 0,
  "healthUrl": "http://127.0.0.1:42183",
  "healthStatus": 200,
  "healthBody": "{\"status\":\"ok\"}",
  "screenshot": { "exists": true, "bytes": 141509 },
  "evidence": {
    "desktopBridge": "present",
    "adminTokenLength": "43",
    "uiTitle": "Flowlet"
  }
}
SMOKE OK
```

截图见 `.flowlet-dev-data/desktop-smoke/flowlet-desktop-smoke.png`（gitignore 排除）：
React 概览页完整渲染（service-strip、渠道账号、开放模型、AI Agent 接入、窗口控制按钮），
代理显示“运行中”，管理 token 掩码显示。

```bash
npx tsc -p packages/flowlet-desktop/tsconfig.json   # 0 errors（桌面包自身文件）
npm run node:typecheck                              # 见下方“验证说明”
```

### 打包产物验证

```bash
cd packages/flowlet-desktop
# 本机 ~/.cache 只读时用 XDG_CACHE_HOME 重定向；desktop:dist 已内置该检测
XDG_CACHE_HOME=<repo>/.tmp-cache node node_modules/electron-builder/out/cli/cli.js --linux dir
# → release/linux-unpacked/{flowlet-desktop, resources/app.asar, resources/runtime,
#   resources/desktop-static}

xvfb-run -a -s "-screen 0 1280x800x24" release/linux-unpacked/flowlet-desktop \
  --no-sandbox --disable-gpu --ozone-platform=x11 \
  --screenshot=.../pkg.png --print-url-file=.../url.txt --data-dir=.../data
# 关键输出：
FLOWLET_WEB_URL=http://127.0.0.1:46289
FLOWLET_UI_TITLE=Flowlet
FLOWLET_DESKTOP_BRIDGE=present
FLOWLET_ADMIN_TOKEN_LENGTH=43
FLOWLET_SCREENSHOT=.../pkg.png 1200x720
```

打包产物（linux x64，已实测）：`release/Flowlet-0.2.0.AppImage`（131 MB）、
`release/flowlet-desktop_0.2.0_amd64.deb`（92 MB）、`release/linux-unpacked/`。
`electron-builder` 首次打包会从 GitHub 下载 electron zip / appimage / fpm 工具；
受限环境需可写缓存（`desktop:dist` 在 `~/.cache` 不可写时自动重定向到仓库 `.tmp-cache`）。

安装版路径验证要点：`resources/runtime`（config/model 目录 + capture-cleanup worker）、
`resources/desktop-static`（dist-desktop）都能被 Host 正确读取；数据目录用
`--data-dir` 覆盖时，WebView 根也落在该目录下（便于隔离冒烟）。

### Host channel 自检（`--host-self-test`）

```bash
xvfb-run -a ... electron packages/flowlet-desktop --no-sandbox --disable-gpu \
  --host-self-test --data-dir=/tmp/flowlet-selftest
```

实测输出（摘录）：

```json
{
  "appInfo": {"version":"0.2.0","portable":false,"platform":"linux","arch":"x64"},
  "diagnostics": {"database":"healthy","proxy":"running","electron":"44.7.0",
                  "node":"24.21.0","safeStorageBackend":"gnome_libsecret",
                  "safeStorageAvailable":true},
  "autostartGet": {"enabled": false},
  "powerOn": null, "powerOff": null, "trayTooltip": null,
  "agentRuntimeStatus": {"running": true, "external": true, "managed": false},
  "scrapeOpen": {"opened": true},
  "scrapeEvaluate": {"result": {"sum": 3, "title": "", "credential": {"keyPrefix": "sk-", "keyLastFour": "abcd"}}},
  "scrapeClose": null,
  "keyringSet": null,
  "keyringGet": {"secret": "flowlet-smoke-secret"},
  "keyringDelete": null,
  "unknownChannel": {"error": "未实现的桌面宿主 channel：platform.doesNotExist"}
}
```

即：safeStorage 在当前 Linux Secret Service 环境可用（非 basic_text），keyring
set/get/delete 往返成功，未知 channel 明确报错。

### 单实例与旧数据库原地打开

```bash
# 第二次启动：进程立即 exit 0，第一个实例日志出现“收到第二次启动请求，聚焦已有窗口”
xvfb-run ... release/linux-unpacked/flowlet-desktop ... --hidden --data-dir=<dir> &   # 第一个
xvfb-run ... release/linux-unpacked/flowlet-desktop ... --hidden --data-dir=<dir>     # 第二个 exit 0

# 旧数据目录兼容：把已有的 flowlet.sqlite 放进 <data-dir> 后启动
cp <旧数据>/flowlet.sqlite <data-dir>/flowlet.sqlite
xvfb-run ... flowlet-desktop --screenshot=... --data-dir=<data-dir>
# → 界面直接显示旧库的 14 个渠道账号 / 13 个开放模型 / 今日 24 Tokens
#   （数据链路：SQLite → Node Host 命令 → React，无需迁移脚本）
```

### 验证说明

- 桌面宿主包自身的 TS 文件（`packages/flowlet-desktop/**`）在
  `packages/flowlet-desktop/tsconfig.json` 下 0 错误；该 tsconfig 会沿 import 图
  进入 `packages/flowlet-core/src/**`，因此 core 的并行迁移批次未完成时也会报出
  core 内部错误（不是桌面壳错误）。
- `npm run desktop:smoke` 会先构建宿主 bundle；如果 `dist-desktop` 不存在会先构建
  前端（可用 `--fallback-static` 回退 `dist-web` 做纯壳层冒烟）。
- 生产打包前需确保 `packages/flowlet-desktop/node_modules`
  已按 `devDependencies` 安装（`electron` / `esbuild` / `electron-builder`）。当前
  工作区为受限网络环境，三者是用 workspace 内 cache 手工安装的，根 `package-lock.json`
  尚未重新生成；CI/新环境执行一次仓库根 `npm install` 即可。

---

## 7.1 验证命令（迁移期门禁）

| 命令 | 覆盖 | 通过标准 |
| --- | --- | --- |
| `npm run node:typecheck` | flowlet-core TS | 0 error |
| `node --test packages/flowlet-core/src` | Node Host + 桌面命令 | 0 fail |
| `npm run check` | 前端 TS | 0 error |
| `node scripts/desktop-command-parity.mjs` | Rust 154 条桌面命令覆盖度 | missing = 0 |
| `npm run desktop:smoke` | Electron 启动 + 首屏 + `/health` + preload 桥 | `SMOKE OK` |
| `npm run desktop:smoke:pages` | 逐路由渲染 + 截图 + console/命令错误 | 全部路由 ok、0 console error、0 命令失败 |
| `npm run desktop:dist` | electron-builder 出包 | AppImage/deb 生成 |

`desktop:smoke:pages` 默认用空数据目录（新用户路径）；传 `--db=<sqlite>` 用已有数据库副本
（老用户升级路径）。报告与截图在 `.flowlet-dev-data/desktop-pages/`（`report.json` +
每路由 PNG），失败会以非 0 退出码结束。

> 若在 `ELECTRON_RUN_AS_NODE=1` 的 shell（例如某些 Electron 宿主终端）里执行，冒烟脚本会
> 主动清掉该变量，否则 Electron 二进制会被当成 Node 启动。

## 7.2 运行模式：主机 / 客户端

桌面端有两种互斥的运行模式，配置文件在 `<userData>/desktop-config.json`（不依赖 SQLite，
客户端模式本机没有数据库）：

| 模式 | 本机做什么 | 命令通道 | 可用能力 |
| --- | --- | --- | --- |
| **host**（默认） | 启动完整 Node Host：SQLite、模型代理 18640、本机管理 API、桌面命令超集 | 同进程 `POST /api/commands/{command}` | 全部 154 条桌面命令（Agent 接入、抓取、跨设备同步、自启…） |
| **client** | **不启动 Host**，只跑 Client Gateway（静态界面 + `/api` 反代） | 本机网关 → 远程 Docker/Web Host 的 66 条管理命令 | 远程观测 + 管理（账号/模型/日志/会话/用量/服务凭据/远程设置）；本机 Agent 接入、抓取、跨设备同步、自启**不可用** |

### 调用链（客户端模式）

```text
renderer（同一份 dist-desktop，按 Web 管理台渲染）
  └─ fetch /api/commands/{cmd}（同源，指向本机 127.0.0.1:<port>）
       └─ Client Gateway（Electron main，packages/flowlet-desktop/src/client/gateway.ts）
            ├ 静态资源：dist-desktop（SPA fallback）
            └ 反向代理：/api/* 与 /health → https://<远程主机>
                 ├ token 模式：Authorization: Bearer <safeStorage 加密保存的 token>
                 └ OIDC 模式：Cookie（persist:flowlet-remote 分区）+ X-CSRF-Token
```

设计要点：

- **渲染进程拿不到远程凭据**：token 只在主进程内存/加密文件；OIDC Cookie 在独立持久化分区，
  网关每次请求现取。渲染进程的 `Authorization` / `Cookie` 头一律丢弃。
- **不需要改远程 CORS/白名单**：网关在本机同源提供界面，远程只看到普通管理 API 调用。
- **只代理 `/api/*` 与 `/health`**：不代理任意路径；静态资源做路径穿越校验；请求体 16 MiB 上限。
- **OIDC 登录**：托盘/设置页打开「运行模式…」，填地址后点「打开登录窗口」，窗口加载远程
  管理台走企业 SSO；主进程轮询 `/api/session` 直到登录成功并缓存 CSRF token。
- **功能门控**：客户端模式复用 Web Host 语义（`isWebHost = true`），页面隐藏本机 Agent 接入、
  控制台抓取、跨设备同步与开机自启；远程 Web 白名单之外的命令会返回 501，UI 不伪造成功。
- **入口展示**：概览 service-strip 在客户端模式显示「远程代理」；模型入口优先用远程
  `web_connection_info` 给出的 `base_url / base_urls`（生产 Docker 的 `FLOWLET_PUBLIC_PROXY_URL`），
  为空时回退到「远程主机 + 默认代理端口 18640」，**不会**回退成本机网关地址。
- **压缩语义**：网关向远程请求强制 `accept-encoding: identity`，按流转发不再做解压，
  避免丢 `content-encoding` 后把压缩字节交给前端。
- **本地信任边界**：网关只监听 `127.0.0.1` 随机端口，凭据留在主进程；同用户本机进程可通过该
  回环端口使用已登录的远程管理会话（与主窗口调试端口同权限模型）。如需更强隔离，后续给网关
  加一次性本地 IPC token 即可（不影响本设计）。

### 切换与验证

- 切换：托盘菜单「运行模式…」或客户端模式「应用设置 → 运行模式」→ 保存后自动重启（`app.relaunch`）。
  首次升级默认仍是主机模式，不改变老用户行为。
- 快速指定（冒烟/调试，不写配置）：`--mode=client --client-url=https://host --client-token=…`。
- 端到端冒烟：`npm run desktop:smoke:client` —— 脚本会先在 127.0.0.1 起一个真实 Node Host
  当远程主机（可 `--remote-db=<sqlite>` 带数据），再以客户端模式启动 Electron 并逐路由断言
  （0 console error、0 失败命令、截图齐全）。
- 纯函数/网关单测：`node --test packages/flowlet-desktop/src/client`（URL 归一、配置解析、
  认证头注入、CSRF、401/502 映射、路径穿越、SPA fallback）。

## 8. 已知缺口与风险

| 缺口 | 影响 | 现状/后续 |
| --- | --- | --- |
| Windows Job Object | Flowlet 崩溃/被强杀时 DSH 进程树可能残留（HG-6） | 已用 detached 进程组 + `taskkill /T /F` 做正常退出回收；强杀缺口未解 |
| Windows toast / AUMID | 便携版 toast 可能被系统静默丢弃（HG-3） | `platform.notify` 仅 `Notification`，未写 HKCU AUMID；安装版需快捷方式 + CLSID |
| Linux 无边框缩放/装饰 | X11 下八向缩放靠 IPC 模拟，无吸附/无系统边缘 | 可接受；若体验差允许安装版退化为 `frame:true`（未启用） |
| Android / iOS | Electron 无移动端 target（HG-1） | 本轮不做，保留 Tauri Android 辅助端 |
| 抓取登录态迁移 | WebView2/WebKitGTK 登录态无法迁移（HG-5） | 用户需重新登录；`partition` 提供新的隔离存储 |
| `scrape.runPlan` / `scrape.evaluate` 契约 | plan 仍是“最小定义”；`probeLogin` 是 URL/文本启发式 | 已按 desktop-scrape 要求补 `scrape.evaluate` 与 credential/fallback 放宽；登录页规则待渠道实现提供 |
| `agentRuntime` 覆盖 | 目前仅 DSH；检测/启动策略比 Rust `agent_environment` 简化 | 依赖 PATH 的 `dsh` 或 `npx`，未解析 npx/npm 安装方式 |
| Linux `safeStorage` | 无 Secret Service 时 `basic_text` 弱加密 | 诊断暴露 backend；未强制阻断 |
| 安装版 exe 目录只读 | Program Files/`/usr/bin` 下无法写 DB | 自动降级到 `%LOCALAPPDATA%` 并告警（与 Rust 行为不同，属必要偏差） |
| 多显示器/DPI | `ensureWindowOnScreen` 只做 workArea clamp | 未做 DPI 缩放换算 |
| 深色/浅色主题托盘图标 | 只使用 `tray.png` | 未按主题切换 |
| 通知点击 / Windows AUMID | 便携版 toast 可能被系统丢弃（HG-3） | 已实现通知点击回到主窗口，并在 Windows 启动时幂等写 `HKCU\Software\Classes\AppUserModelId\site.snewbie.flowlet`（DisplayName/IconUri，与 Rust 对齐）；未真机验证 |
| 自定义抓取描述符发现根 | Node 无「exe 同级」概念 | 探 `process.execPath` 目录 + 脚本目录 + `~/.flowlet/custom-scrape`，可用 `FLOWLET_CUSTOM_SCRAPE_DIRS` 覆盖（部署/测试用） |

### 安全说明

- 管理 token 只存在于主进程内存 + preload 同步 IPC，不落盘、不写日志、不出现在
  进程 argv；渲染进程 `contextIsolation:true`、`sandbox:true`、`nodeIntegration:false`。
- 抓取窗口加载任意第三方页面，权限请求全部拒绝、禁止 `window.open`。
- 账号 API Key 仍按现状存 SQLite 明文（与 Rust 一致，本次未改变安全边界）。