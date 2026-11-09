# Flowlet Tauri/Rust → Electron + Node/TS 平台能力缺口矩阵

> 状态：只读盘点结论（未运行任何 `cargo` / `npm` 构建，未修改 `src-tauri/` 与 `src/`）
> 盘点基线：`main` @ `26fed4c`（2026-11-09）
> Electron 依据：`electron/electron` 的 `main` 分支 API 文档（2026-11 拉取）与 `www.electron.build/docs/*`；本机 `web_fetch` 工具因上游 401 不可用，改用 `curl` 直接读取 `raw.githubusercontent.com` 文档源，见文末「取证方式与限制」
> 产出范围：本文件是 `task-2` 的唯一产物，仅写 `docs/migration/`

---

## 0. 结论摘要

Flowlet 的桌面平台能力面比「标准 Electron 应用」大得多：除了窗口/托盘/自启这些壳能力，真正难替换的是
**（a）第三方控制台抓取的登录态与响应捕获、（b）OS 凭据库、（c）Windows 子进程内核级回收、（d）Android 端**。
代理、存储、路由、Web Host 这些业务核心与平台无关，可以原样（或近原样）用 Node/TS 重写并继续服务。

- **硬缺口：6 个**（任务书点名 5 个 + 附加 1 个：Windows 内核级子进程树回收）。
- **必须降级或改变语义：约 9 项**（控制台抓取登录态、Windows toast 点击、便携版语义、单实例范围、Linux 缩放手柄、Linux 开机自启、SQLite 双 ABI、原生通知、MSI/签名组合）。
- **矩阵共 77 个能力项**（S 32 / M 34 / L 9 / 特殊 2），其中绝大多数为「需要重写但无产品降级」（EQ）：窗口记忆、无边框壳（除 HG-2）、文件监听、LAN 加密、电源抑制等能力 Electron 原生或成熟库即可覆盖。
- **平台侧相对 Rust 的净收益**：控制台抓取从「Windows WebView2 + Linux WebKitGTK + macOS 仅页面注入」三套链路收敛为 **统一 CDP（`webContents.debugger` + `Network.getResponseBody`）**；电源抑制从「Windows-only、其他平台空实现」变成**跨平台 `powerSaveBlocker`**；不再依赖系统 WebView2/WebKitGTK 运行时。
- **最大风险**：不是代理或打包，而是**控制台抓取在 Electron 内嵌 Chromium 中的第三方登录成功率**（SSO 反自动化、既有登录态不可迁移、隐藏窗口视口/UA 差异）；其次是 **Windows 无边框壳（拖动/缩放/双击最大化）** 与 **Node/Electron 双 ABI 的原生 SQLite 模块**。
- **工作量粗估**：平台侧 + 桌面宿主约 **100–150 人日**（不含代理/存储等业务核心的 Node 重写）；其中 6 个硬缺口约 **55–95 人日**（含 Android 15–30；非 Android 硬缺口约 40–65）。详见第 6 节。

**建议决策（详见第 7 节）**：先做 5 个 PoC 再拍板 —— ①控制台抓取（LongCat / Qwen / Z.AI 三条 SSO 链路）；②无边框窗口壳；③Windows 子进程树回收 + toast 身份；④safeStorage 与旧凭据迁移；⑤headless/Node SQLite ABI。Android 端建议「保留 Tauri Android 辅助端」或「改为 Capacitor 只读客户端」，不要在同一轮迁移中强行消除。

---

## 1. 判定口径

| 记号 | 含义 |
| --- | --- |
| **HG** | 硬缺口（Hard Gap）：Electron/Node 无对等 API、或对等 API 存在但**无法保持现有产品行为**，必须降级/保留 Tauri/新增原生产物才能解决 |
| **DG** | 降级项：可以实现，但产品行为、平台覆盖或数据兼容性会变化，且用户可感知 |
| **EQ** | 等价项：需要重写，但不存在产品降级 |
| 工作量 | **S** ≤ 1 人日；**M** 2–5 人日；**L** 6–15 人日（含联调/回归；不含跨平台真机验收） |
| 风险 | 低 = 机械改造；中 = 需要设计决策或平台差异处理；高 = 可能推翻迁移方案、或需要新的原生代码 |

矩阵列顺序固定为：`# / 能力 / Rust 现状（实现位置与行为）/ Electron 方案（具体 API）/ 缺口或降级 / 工作量 / 风险`。
所有「Rust 现状」均可在标注文件中直接定位；所有 Electron API 均为官方文档中的实际名称。

---

## 2. 硬缺口清单（必须正面回答的 6 项）

### HG-1 Android 端：Electron 不支持移动端（绝对缺口）

- **Rust 现状**：
  - 独立移动端入口 `run_mobile()`（`src-tauri/src/lib.rs:947-1057`）：只挂 `tauri-plugin-barcode-scanner`；
    Android 专属 Keyring 初始化 `android_native_keyring_store::Store::new()` + `keyring_core::set_default_store`（`lib.rs:954-959`，依赖见 `src-tauri/Cargo.toml:83-86`）。
  - 移动端 command `src-tauri/src/mobile_commands.rs`（17 个命令：共享设备、共享账号资源、共享设备 Agent、日/小时用量、共享会话、S3 设置/保存/测试、S3 刷新、OpenCode 远程权限列表/回复、LAN 刷新、设备刷新/会话刷新、LAN 探测、LAN 缓存）。
  - 移动端后台任务：每 5 分钟 S3-only pull + LAN probe，发 `mobile-device-sync-updated` 事件（`lib.rs:971-1032`）。
  - 移动配置 `src-tauri/tauri.android.conf.json`（`decorations: true`、`dist-mobile`）；`npm run build:mobile`、`tauri:android:build --apk --target aarch64`（`package.json`）；`src-tauri/gen/android/**`（Gradle/keystore 配置）。
  - CI Release job：Android arm64 签名 APK + `apksigner verify` + GitHub Release + Pgyer 上传（`.github/workflows/build-installers.yml` 的 `android` job）。
- **Electron 方案**：无。Electron 只支持 Windows / macOS / Linux 桌面；无 Android/iOS target，也没有 WebView 桥或移动打包通道。
- **可选路径**：
  1. **保留 Tauri Android 壳**：Android 端继续用现有 Rust 核心（但 Node 迁移后会出现两套业务核心，`FlowletServices` 与 TS server 需要长期双维护；移动端只读 S3/LAN，可改为直接访问 Web Host/Host API 以缩小双核心面）。
  2. **Capacitor / 纯 WebView 客户端**：移动端只做「S3/LAN 只读观测 + 远程权限回复」，复用 `src/mobile/**` 页面 + Web Host 的 HTTP API；代价是移动端能力一次性收窄（本机代理、本机 Agent、原生 Keyring 全部没有），且需要新的 Capacitor 工程与签名链路。
  3. **放弃 Android**：删除 `mobile_commands.rs`、`gen/android`、Android CI job、barcode-scanner 依赖，并明确公告。
- **缺口/降级**：HG。三条路都有代价；**不存在直接平移方案**。如果产品仍要移动辅助端，建议 1（阶段性）→ 2（长期收敛），或先在 2 上验证「移动端真实刚需只有只读观测」。
- **工作量**：L（保留 Tauri：M 的适配 + 长期双维护成本；Capacitor：L；放弃：S 但有产品损失）
- **风险**：**高**（架构分裂、移动端签名/上架链路重做、Keyring Android 后端消失）

### HG-2 无边框窗口的拖动区、窗口控制按钮与缩放手柄（必须重写，且有平台不可控项）

- **Rust 现状**：
  - `tauri.conf.json`：`decorations: false`、`visible: false`、`width/height 1200×720`、`minWidth/minHeight 1200×720`。
  - 前端自绘壳：`src/app/shell/WindowControls.tsx`（整行拖动区 + 最小化/最大化/还原/关闭按钮；`onMouseDown` 手动判定双击最大化；Windows 上避免 `startDragging` 吞掉 dblclick 的注释）+ `src/app/shell/WindowResizeHandles.tsx`（8 向透明热区，调用 `startResizeDragging`；注释明确「Linux/GTK 的无边框窗口没有系统提供的 resize 边框」）+ `src/platform/tauri/window.ts`（`startDragging` / `startResizeDragging` / `minimize` / `toggleMaximize` / `close`）。
  - 弹层与拖动区层级：`src/shared/ui/overlayLayers.ts`（SideSheet 标题/关闭按钮高于窗口标题层；拖动区与二次弹层交互由 `main.tsx:46` 的 `configureSideSheetWindowDragging` 接入）。
  - 最小客户区补偿：`core/window_size.rs`（Windows 无边框仍有不可见 resize frame，按 outer-inner 差值抬 `min_size`，保证 WebView 客户区 ≥1200×720）。
- **Electron 方案**：`BrowserWindow({ frame: false })`；拖动区用 CSS `-webkit-app-region: drag`、控件用 `no-drag`；窗口按钮 `win.minimize()` / `win.maximize()` / `win.unmaximize()` / `win.close()`；缩放 `win.setMinimumSize()` + `useContentSize: true`（无边框时窗口尺寸≈客户区，`window_size.rs` 的 frame 补偿可删）；最大化状态监听 `'maximize'` / `'unmaximize'` / `'resize'`。
- **缺口/降级**：
  - **没有 `startDragging()` / `startResizeDragging(direction)` 的等价 JS API**。Electron 的拖动只能靠 CSS 区域，无法像现在这样在 `mousedown` 里按「是否命中 SideSheet/弹层」动态决定是否开始拖动；只能通过切换 `no-drag` class 做条件区域，并且 **双击拖拽区的最大化行为由平台/Chromium 处理，无法用 JS 拦截**。
  - **八向缩放手柄无法等价实现**：Electron 没有程序化进入系统 resize 模态循环的 API。Windows 无边框窗口通常仍可从边缘缩放；**Linux X11/部分 WM 下无边框窗口可能完全没有 resize 边框**（Electron 文档只说明 Wayland 下无边框窗口默认带 GTK 阴影和扩展 resize 边界），届时要么手写 `mousemove` → `win.setBounds()` 的伪缩放（抖动、无系统吸附），要么放弃无边框、改回系统边框。
  - 现有「SideSheet 层级 > 窗口标题层 > Toast」的交互契约需要逐项重测；`-webkit-app-region: drag` 区域内的按钮必须显式 `no-drag`，否则点击被拖动吞掉。
- **工作量**：M（重写壳 + 3 平台行为验证；若 Linux 必须手写伪缩放则升 L）
- **风险**：**高**（用户每天接触的窗口交互；Linux 可能被迫降级为系统边框）

### HG-3 Windows toast 点击回调 + 便携版 AUMID/ToastActivatorCLSID

- **Rust 现状**：
  - 启动时幂等写注册表：`core/notification_registry.rs` 在 `HKCU\Software\Classes\AppUserModelId\<identifier>` 下写 `DisplayName` / `IconUri`（`lib.rs:422-428` 调用，identifier = `site.snewbie.flowlet`）。目的：**便携版没有安装器/开始菜单快捷方式时，WinRT toast 不被系统静默丢弃**。
  - `tauri-plugin-notification` 只做初始化（`lib.rs:313`）；**当前 Rust 代码没有实际发送原生通知的调用**（全仓库 grep 无 `NotificationExt` / `Toast` 调用；`src` 也没有 `@tauri-apps/plugin-notification` 用法）。
  - `src-tauri/Cargo.toml:96-100` 仍保留 `tauri-winrt-notification`，注释写明「Windows toast 点击回调（on_activated）需要直接构造 toast，tauri-plugin-notification 不透出点击事件」——说明点击回调的能力是**预留但未落地**。
- **Electron 方案**：`Notification`（main）或 Web Notifications；事件 `'click'` / `'action'` / `'reply'` / `'failed'`；Windows 集中激活回调 `Notification.handleActivation(callback)`（支持冷启动、通知中心历史通知）；AUMID 用 `app.setAppUserModelId(id)`。
- **缺口/降级**：
  - Electron 官方文档明确：Windows 通知要求 **开始菜单快捷方式带有 AppUserModelID 和对应的 ToastActivatorCLSID**；Electron 会为 Squirrel/安装器场景自动化处理，**便携 ZIP（当前 Windows 主要产物之一）没有快捷方式**，仅调 `setAppUserModelId` 不保证 toast 可显示/可点击。
  - Electron **不会**替应用写 `HKCU\Software\Classes\AppUserModelId\...` 注册表，也没有 ToastActivatorCLSID 注册入口；要保住当前便携版行为，需要自己写注册表（`reg.exe` / 原生 addon）或改用安装器 + 快捷方式。
  - macOS 要求 app 被 code-signed 才能收到通知事件（当前 Tauri CI 仅 ad-hoc 签名）；Linux 走 `libnotify`，点击回调取决于桌面通知守护进程。
- **缺口结论**：HG（若要求「便携版 + 可点击 toast」同时成立）；可接受降级是「原生通知仅在安装版可用；便携版降级为应用内 Toast/托盘气泡」。
- **工作量**：M（发送 + 激活路由 + 安装器 AUMID 验证；若自写 CLSID 注册需原生产物则 L）
- **风险**：**高**（Windows 通知是系统集成黑盒，易出现「开发机可见、用户机静默丢弃」）

### HG-4 跨平台密钥存储的兼容与迁移（已有用户密钥数据）

- **Rust 现状**（仅两处业务密钥走 OS 凭据库；账号 API Key 在 SQLite 明文，见 `storage.rs:748`）：
  - S3 Secret Access Key：`core/device_sync.rs:21,579-587,798-880` —— `keyring::Entry::new("Flowlet Device Sync", "s3-" + sha256(endpoint\0bucket\0access_key_id))`，`set_password` / `get_password` / `delete_credential`；`save_config` 在 endpoint/bucket/AK 变化时删除旧条目。
  - 账号工作区密钥（32 字节，base64）：`core/account_workspace_sync.rs:13,96-99,101-145` —— `keyring::Entry::new("Flowlet Account Workspace", 同一 credential_username)`；用于 ChaCha20-Poly1305 加解密 S3 上的账号目录（`ENVELOPE_AAD = b"flowlet-account-workspace-v1"`）。
  - Android：`android-native-keyring-store` → Android Keystore（`lib.rs:954-959`）。
  - 后端由 `keyring` crate 决定：Windows Credential Manager、macOS Keychain、Linux Secret Service（GNOME Keyring / KWallet）。
- **Electron 方案**：`safeStorage.encryptStringAsync()` / `decryptStringAsync()`（Electron 46 起同步 API 已移除，只能用异步；返回 `shouldReEncrypt` 支持密钥轮换）+ 自行把密文写入应用数据文件；后端分别是 macOS Keychain、Windows DPAPI、Linux Secret Service/KWallet/Portal Secret。
- **缺口/降级**：
  - **`safeStorage` 不能读取 `keyring` crate 写入的 Generic Password 条目**（服务名/用户名/密文格式都不同，且 `safeStorage` 不提供枚举/读取 OS 条目的 API）。**已有用户的 S3 Secret 与工作区密钥无法自动沿用**，除非做一次性迁移。
  - 一次性迁移只能通过原生 API 或系统 CLI 读旧条目（Windows `CredRead`/`cmdkey`、macOS `security find-generic-password -s "Flowlet Device Sync"`、Linux `secret-tool lookup service ...`），再由 Electron 侧用新算法重新加密；这需要维护「旧 keyring 读取器」（Rust 小工具或原生 addon/CLI 调用），且 macOS 会弹 Keychain 授权、Linux 依赖 Secret Service 可用性。
  - `safeStorage` 在无 Secret Service 的 Linux 环境会**降级为 `basic_text`（硬编码口令的弱加密）**，必须检测 `safeStorage.getSelectedStorageBackend()` 并提示用户；macOS 未签名/签名不一致会导致 Keychain 每次更新都重新授权（文档明确要求签名一致）。
  - 可接受降级：**S3 Secret 与工作区密钥要求用户重新输入/重新导入**（当前 `read_secret` 的错误文案本来就是「未找到 S3 Secret，请重新填写并保存」），工作区密钥可由桌面端「导出工作区接入包」重新分发。
- **工作量**：M（safeStorage 封装 + 重输引导）；若要无缝迁移则 L（双读旧 keyring + 迁移工具 + 三平台验证）
- **风险**：**高**（丢失 S3 凭据会导致多设备同步「静默失效」；Linux 弱加密有安全语义变化）

### HG-5 控制台抓取对第三方站点登录态的保持

- **Rust 现状**：
  - 每个账号独立 WebView 数据目录：`core/scrape_console.rs:221-300`（`scrape-webview-<account_id>`；`webview_profile.rs:22-34` 决定根目录：便携版 `exe/data/webview`，安装版 `app_local_data_dir`），因此 Cookie / localStorage / IndexedDB 完全隔离。
  - 登录态不依赖进程保活：`commands/scrape.rs:795-818` 注释明确「登录态保存在 per-account 数据目录里，窗口 `destroy()` 不会让用户重新登录」。
  - 交互式登录保护：`scrape_interaction_required` / `scrape_interactive_sessions` 避免后台同步导航打断用户登录（`lib.rs:53-60`、`commands/scrape.rs`）。
  - 针对 Linux WebKitGTK 的设备检测绕过：LongCat 抓取窗口固定桌面 Chrome UA（`scrape_console.rs:282-290`），因为隐藏窗口 `innerWidth=0` 会被 LongCat 判定为移动端。
  - 抓取页依赖第三方 SSO（Qwen 阿里云 SSO、Friday 等），且现在**用的是系统 WebView2/WebKitGTK 的真实登录态**。
- **Electron 方案**：`session.fromPartition('persist:scrape-<account_id>')` + `BrowserWindow({ webPreferences: { partition } })`；`session.setPermissionRequestHandler` / `setPermissionCheckHandler` 默认拒绝；`ses.cookies` 可清理/导出；`webContents.setUserAgent()` 覆盖 UA。
- **缺口/降级**：
  - **旧登录态不能迁移**：WebView2 的 `EBWebView` 目录、WebKitGTK 的 profile 与 Electron/Chromium 的 `Partitions/<name>` 格式不兼容。迁移后**所有控制台渠道必须让用户重新登录一次**（这是用户可感知的降级）。
  - **内嵌 Chromium 的 SSO 反自动化风险更高**：阿里云/Google 等 SSO 可能对 Electron/无头特征、UA、`navigator.webdriver`、第三方 Cookie 策略做拦截；现有 WebView2/WebKitGTK 链路是「系统可信浏览器」，Electron 是「自带 Chromium」，结果必须逐渠道实测。
  - 隐藏窗口视口差异：当前已有 LongCat 隐藏窗口 `innerWidth=0` 的坑；Electron 隐藏 `BrowserWindow` 的布局/视口行为不同（仍会布局，但 `paintWhenInitiallyHidden`、GPU/合成器状态需验证），可能改善也可能出现新的反自动化判定。
  - 安全面扩大：抓取窗口加载任意第三方页面，必须 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、`setPermissionRequestHandler` 全拒、`setWindowOpenHandler` 拒绝弹窗，并把页面 IPC 收敛为白名单。
- **工作量**：L（3–5 个渠道 × 登录 + 抓取 + 多阶段导航 + 回归；含用户重登引导）
- **风险**：**高**（这是整个迁移的可行性闸门；若某渠道在 Electron 中登不上，只能保留 Tauri 抓取进程或做独立浏览器自动化）

### HG-6（附加）Windows 子进程树的内核级回收（Job Object 无 Node 等价）

- **Rust 现状**：`core/win_process_job.rs` 用 `CreateJobObjectW` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 绑定 DSH Web 托管运行时（`core/agent_runtime.rs` 的 `ManagedRuntime.job`）。Flowlet 崩溃/被强杀时，内核关闭句柄即杀掉 `cmd.exe → node.exe` 整棵树，避免 3080 端口被孤儿占用；正常退出路径仍先 `taskkill /T /F`。
- **Electron 方案**：`child_process.spawn(..., { windowsHide: true })` + 优雅路径 `taskkill /T /F`（或 `tree-kill` npm）；Unix 侧 `spawn({ detached: true })` 建进程组，退出时 `process.kill(-pid)`。
- **缺口/降级**：Node 核心**没有** Job Object / `AssignProcessToJobObject` 绑定能力。崩溃、任务管理器强杀、非 `before-quit` 退出时**必然留下孤儿进程树**（DSH Web 继续占端口）。可选方案：原生 addon（node-ffi/NAPI 调 Win32 Job API）、外置 watchdog 进程（父进程消失即杀子进程）、或接受「下次启动检测外部进程并提示」的降级（当前 `agent_runtime.start` 已有「外部进程不接管」提示）。
- **工作量**：M（原生 addon/watchdog）或 S（接受降级）
- **风险**：**高**（孤儿进程占端口是已发生过的真实缺陷；降级需产品确认）

---

## 3. 能力矩阵

> 说明：Electron API 均以 main 分支文档为准；「现状」列给出文件与关键行为；未特别说明时，Electron 侧运行在主进程（main），渲染进程通过 `ipcMain.handle` / `contextBridge` 调用。

### 3.1 进程、生命周期与数据目录

| # | 能力 | Rust 现状（实现位置与行为） | Electron 方案（具体 API） | 缺口或降级 | 工作量 | 风险 |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | 单实例锁 | `main.rs:15-21`；Windows `CreateMutexW("Local\\FlowletDesktopSingleInstance")`（`main.rs:39-62`）；Linux/macOS 对 `exe/.flowlet.lock` 加 BSD `flock`（`main.rs:64-139`）。第二个实例**静默退出**，不唤起已有窗口 | `app.requestSingleInstanceLock()`；`app.on('second-instance', (event, argv, cwd, additionalData) => ...)`；拿不到锁则 `app.quit()` | DG：Electron 锁按 `userData`/应用身份而非 exe 目录；**两个不同安装目录/便携副本会互相拦截**（需按 exe 目录 `app.setPath('userData', ...)` 实现「不同目录=不同实例」）。二次启动可顺便唤起主窗口（相对现状是增强） | M | 中 |
| A2 | 关闭主窗口=隐藏到托盘；只有「退出 Flowlet」才停止代理并退出 | `lib.rs:541-563` `on_window_event(CloseRequested)` → `save_window_state` + `hide()` + `api.prevent_close()`；tray `quit`（`lib.rs:603-621`）先标记 `app_exiting`、`proxy.stop()`、`agent_runtimes.stop_all()`、`app.exit(0)`；`app_exiting` 防止销毁事件清空独立窗口记录（`lib.rs:609-615`） | `win.on('close', e => { e.preventDefault(); saveBounds(); win.hide(); })` + `isQuitting` 标志；`app.on('before-quit')` 置标志并异步清理；`app.on('will-quit')` 兜底；`app.exit(0)` | EQ：行为可完全等价。注意 `window-all-closed` 不退出、`before-quit` 内异步清理需 `preventDefault` 后手动 `app.quit()`，否则会与事件循环竞态 | M | 中 |
| A3 | 托盘/二次启动把窗口带到前台 | `toggle_window_to_front`（`lib.rs:1063-1090`）：`show` + `unminimize` + `set_focus`；Windows 额外 `set_always_on_top(true/false)` 抢前台；Linux/macOS 不做置顶避免 restack 闪烁 | `win.show()`；`win.focus()`；`win.restore()`（最小化时）；Windows 可复用 `setAlwaysOnTop(true)` → `focus()` → `false` | EQ | S | 低 |
| A4 | 启动隐藏（自启/`--hidden`） | `lib.rs:306` 读取 `--hidden` / `--minimized`；自启插件参数 `Some(vec!["--hidden"])`（`lib.rs:308-311`）；窗口 `visible: false` 由 `create:false` 配置，setup 中非 hidden 才 show（`lib.rs:542-546`） | `BrowserWindow({ show: false })`；`process.argv.includes('--hidden')`；自启参数由 `app.setLoginItemSettings({ args: ['--hidden'] })` | EQ | S | 低 |
| A5 | 退出清理（代理、Agent 运行时） | `lib.rs:603-621`；`agent_runtime::stop_all()`（`core/agent_runtime.rs`）；正常退出前 `taskkill /T /F` | `app.on('before-quit', e => { e.preventDefault(); await stopProxy(); await stopRuntimes(); app.exit(0); })`；渲染进程 `beforeunload` 不可靠，不要放业务清理 | EQ：需保证「先停代理/运行时、再退出」的顺序，并防止异步清理期间二次退出触发重入 | M | 中 |
| A6 | 崩溃/panic 日志 | `core/logging.rs`：`init_file_logging()` + `install_panic_hook()`，`main.rs:4-7` 启动即装；`write_emergency_log` 兜底 | `process.on('uncaughtException' / 'unhandledRejection')`；`crashReporter.start()`（可选，需上传端）；日志用 pino/winston + 自实现轮转 | EQ | S | 低 |
| A7 | 日志文件与轮转 | `tracing-appender`，默认写 `exe/logs`（与 SQLite 同级） | `app.getPath('logs')` / `app.setAppLogsPath(path)`；`pino` + `pino-roll` 或 `winston-daily-rotate-file` | EQ | S | 低 |
| A8 | 数据目录自包含（便携版：SQLite/config/logs/device/WebView 全在 exe 旁） | `lib.rs:225-240` 数据库=exe 旁；`lib.rs:242-257` 便携版 config=exe 旁；`webview_profile.rs:15-34` 便携版 WebView 根=exe/data/webview；`scripts/build-portable.mjs:130-147` 复制 config + 写 `portable.tag` | `app.setPath('userData', dirname(process.execPath))` + `app.setPath('sessionData', ...)`（必须在 `ready` 前、任何 session 创建前调用）；`app.getPath('userData')`；`app.setAppLogsPath()` | DG：Electron 默认把 userData 放 `%APPDATA%/AppData`；便携语义需要显式重定向并处理「Program Files 只读」；Chromium 缓存/Partitions 会落在 `sessionData` 下，需与 Tauri 的 per-WebView 目录语义对齐 | M | 中 |
| A9 | SIGTERM/SIGINT 优雅退出（headless/桌面共用服务层） | `src/bin/headless.rs:shutdown()`：`SIGTERM` / `ctrl_c` → `services.stop_proxy()`；Docker `STOPSIGNAL SIGTERM` + `stop_grace_period: 30s`（`docker-compose.yml`） | `process.on('SIGTERM'/'SIGINT')` + 关闭 server/proxy + SQLite checkpoint；Electron 桌面侧对应 `before-quit` | EQ | S | 低 |
| A10 | 后台定时任务（S3 同步 15min、存储清理 15min、模型目录 1h） | `lib.rs:642-742`（S3 + 工作区同步，5s 首跑）、`744-768`（存储清理）、`770-791`（目录同步）；headless 侧 `src/bin/headless.rs` 三个 `spawn_*` | Node `setInterval`/`setTimeout`（`timers`）；注意 Electron 主进程不会因窗口隐藏而暂停，行为与 Tauri runtime 一致 | EQ | S | 低 |

### 3.2 窗口与布局

| # | 能力 | Rust 现状（实现位置与行为） | Electron 方案（具体 API） | 缺口或降级 | 工作量 | 风险 |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | 窗口尺寸/位置/最大化记忆 | `tauri-plugin-window-state`，仅 `SIZE + POSITION + MAXIMIZED`（`lib.rs:317-321`），不恢复 VISIBLE；关闭时手动 `save_window_state`（`lib.rs:555-557`），托盘隐藏时也保存（`lib.rs:1068-1069`） | 无官方插件：`win.getBounds()` / `win.setBounds(bounds)` + 持久化 JSON；`screen.getDisplayMatching(rect)` 校正；社区库 `electron-window-state` 可省事 | EQ：需自实现（约 150 行）并处理多屏/DPI/最大化状态；`electron-window-state` 不在 Electron 官方 API 内，长期维护需自担 | M | 中 |
| B2 | 最小客户区 1200×720（Windows 不可见 resize frame 补偿） | `core/window_size.rs`：`MIN_CONTENT_WIDTH/HEIGHT=1200/720`；`minimum_outer_size_for_content` 用 outer-inner 差值（DPI 感知）抬 `set_min_size`；启动后再校正一次（`lib.rs:475-491`） | `new BrowserWindow({ minWidth: 1200, minHeight: 720, useContentSize: true })`；`win.setMinimumSize(1200, 720)` | EQ：Electron 无边框窗口的 `useContentSize` 让最小尺寸直接等于内容尺寸，frame 补偿逻辑可删（**净简化**） | S | 低 |
| B3 | 多显示器下窗口完整可见 | `core/window_visibility.rs:ensure_window_on_screen`：按窗口中心选显示器，clamp 到 work_area；启动 400ms 后兜底 | `screen.getAllDisplays()` / `screen.getPrimaryDisplay()` / `screen.getDisplayMatching(rect)`，读 `workArea` 后 clamp `win.setBounds` | EQ | S | 低 |
| B4 | 无边框窗口拖动区 + 最小化/最大化/关闭按钮 | `decorations:false`（`tauri.conf.json`）；`WindowControls.tsx` 自绘按钮 + `startDragging()`；双击拖拽区在 `mousedown` 手动 `toggleMaximize()`（因为 Windows `startDragging` 会进入系统模态循环吞掉 dblclick） | `frame:false`；CSS `-webkit-app-region: drag` / `no-drag`；`win.minimize()` / `win.maximize()` / `win.unmaximize()` / `win.close()`；`'maximize'`/`'unmaximize'` 事件同步按钮图标 | **HG-2**：无 `startDragging()` API；拖拽区无法按弹层动态拦截（只能切 class）；双击最大化由平台处理，行为需实测 | M | 高 |
| B5 | 八向无边框缩放（Linux/GTK 无系统 resize 边框） | `WindowResizeHandles.tsx` 8 个透明热区 → `startResizeDragging(direction)`；层级：边缘 1000 < 拖拽区 1001 < 按钮 1002 < 四角 1003 | 无等价 API。Windows/Linux 部分 WM 可从窗口边缘缩放；Wayland 无边框默认有扩展 resize 边界（Electron 文档），X11/其他 WM 不可靠。兜底：手写 `mousemove` + `win.setBounds()` 伪缩放 | **HG-2**：Linux 可能只能降级为系统边框，或接受伪缩放无吸附/抖动 | M（若伪缩放则 L） | 高 |
| B6 | 弹层/Toast 与窗口标题层的层级契约 | `src/shared/ui/overlayLayers.ts`：Toast > 二级 Modal > SideSheet > 窗口标题层；SideSheet 头部可拖动/双击最大化（`main.tsx:46`） | 仍是前端 DOM 层级；窗口拖动改用 CSS 区域后，SideSheet 头部拖动逻辑需重写（可对 header 设 `app-region: drag`，但按钮/内容区必须 `no-drag`） | DG：交互契约需重测，Toast 层级可保持 | S | 中 |
| B7 | 窗口标题/图标/用户代理 | `tauri.conf.json`：`userAgent: "Flowlet"`，`title: "Flowlet"`；主 WebView 用独立 `data_directory(main-webview)`（`lib.rs:449-457`） | `BrowserWindow({ title, icon })`；`webContents.setUserAgent('Flowlet')`；主窗口用 `session.fromPartition('persist:main')` 或默认 session | EQ（注意 UA `Flowlet` 会影响抓取页设备检测的既有逻辑，仅主界面使用） | S | 低 |

### 3.3 托盘、通知、开机自启

| # | 能力 | Rust 现状（实现位置与行为） | Electron 方案（具体 API） | 缺口或降级 | 工作量 | 风险 |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | 系统托盘图标 + 菜单（显示/隐藏、重启代理、退出） | `lib.rs:565-635`：`TrayIconBuilder` + `Menu`（toggle / start_proxy / quit），`show_menu_on_left_click(false)`，左键 `toggle_window_to_front`；图标 `icons/tray.png` | `new Tray(nativeImage)`；`Menu.buildFromTemplate([...])`；`tray.setContextMenu(menu)`；`tray.on('click', ...)`；`tray.setToolTip` | EQ，但 **Linux**：StatusNotifierItem 的 click 语义由桌面环境决定（可能双击才算激活），右键菜单是主交互；与 Tauri（同样走系统托盘）行为接近 | M | 中 |
| C2 | 托盘 tooltip 实时反映代理状态 | `update_tray_tooltip`（`lib.rs:1092-1108`），文案「代理运行中 ✅ / 代理已停止 ⏹」 | `tray.setToolTip(text)`；Linux 部分 appindicator 不显示 tooltip，需菜单项冗余展示 | DG（Linux tooltip 可能不可见，非阻塞） | S | 低 |
| C3 | 开机自启（Windows / macOS） | `tauri-plugin-autostart`，macOS `LaunchAgent`，参数 `--hidden`（`lib.rs:308-311`）；命令 `is_autostart_enabled` / `enable_autostart` / `disable_autostart`（`commands/maintenance.rs:264-282`） | `app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] })` / `app.getLoginItemSettings()`；macOS 需签名/公证才可靠（文档明确） | EQ（macOS 当前 ad-hoc 签名，自启可能静默失败 → 与现状同类风险） | S | 中 |
| C4 | 开机自启（Linux） | 同上；Tauri 插件内部写 XDG autostart `.desktop` | **Electron `setLoginItemSettings` 仅 macOS/Windows**。Linux 需自己写 `~/.config/autostart/flowlet.desktop`（`Exec=... --hidden`）并处理 XDG_DESKTOP_DIR | DG：Linux 自启需自实现 | M | 中 |
| C5 | 原生桌面通知（发送） | 当前**未实现发送**：仅 `tauri-plugin-notification::init()`（`lib.rs:313`）；无 Rust/前端发送调用 | `new Notification({ title, body }).show()`；`Notification.isSupported()`；渲染进程可直接用 Web Notifications | DG/HG：现状本来就没有原生通知，迁移期可**整体延后**；若要做，按 HG-3 处理 Windows 身份与点击 | M | 中 |
| C6 | Windows toast 点击回调 + 便携版 AUMID | `notification_registry.rs` 写 HKCU AppUserModelId（DisplayName/IconUri）；`Cargo.toml` 保留 `tauri-winrt-notification` 但**未调用** | `Notification.handleActivation(cb)`（Windows 集中处理点击/回复/按钮，含冷启动）；`app.setAppUserModelId(id)`；`Notification` 的 `'click'/'action'` 事件 | **HG-3**：需要安装器快捷方式 + ToastActivatorCLSID；便携 ZIP 无快捷方式，toast 可能被静默丢弃；Electron 不写 HKCU 注册表 | M | 高 |
| C7 | 通知权限/前端提示 | 前端用 Semi `Toast`（应用内提示），非系统通知 | 渲染进程 Web Notifications 需 `session.setPermissionRequestHandler` 放行 `notifications`；应用内 Toast 不变 | EQ | S | 低 |

### 3.4 电源与系统状态

| # | 能力 | Rust 现状（实现位置与行为） | Electron 方案（具体 API） | 缺口或降级 | 工作量 | 风险 |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | 有活动请求时抑制系统自动待机 | `core/power.rs`：`ActivityTracker.track()` 计数 0→1 调 `SetThreadExecutionState(ES_CONTINUOUS + ES_SYSTEM_REQUIRED)`，1→0 清除；**非 Windows 平台是空实现**（`power.rs:104-109`）；代理请求入口 `proxy.rs:1125` 持有 `ActivityPermit` | `powerSaveBlocker.start('prevent-app-suspension')` / `powerSaveBlocker.stop(id)`（跨平台；`prevent-display-sleep` 优先级更高，不需要）；在请求开始/结束处配对调用 | EQ（**净增强**：macOS/Linux 也生效）；注意不要用 `prevent-display-sleep`（会阻止熄屏，耗电） | S | 低 |
| D2 | suspend/resume 事件 | 未订阅；`docs/windows-suspend-resume-network-resilience.md` 记录了 S0 Modern Standby 冻结进程导致流式请求失败的问题 | `powerMonitor.on('suspend' / 'resume')`；可选 `'lock-screen'/'unlock-screen'`（macOS/Windows） | EQ（**净增强**：可做恢复后连接池重建/重试提示） | S | 低 |
| D3 | 待机恢复后的网络/连接池恢复 | 现状无显式恢复逻辑（仅日志分析文档）；reqwest 连接池在恢复后可能命中死连接 | `powerMonitor.on('resume')` 中重建 undici `Agent`/`ProxyAgent`；或 `session.clearHostResolverCache()`；对进行中 SSE 请求做超时/重试提示 | DG：Node 网络栈与 reqwest 行为不同，需要重新设计恢复策略 | M | 中 |

### 3.5 凭据与本地存储

| # | 能力 | Rust 现状（实现位置与行为） | Electron 方案（具体 API） | 缺口或降级 | 工作量 | 风险 |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | S3 Secret Access Key 安全存储 | `keyring` crate：service `"Flowlet Device Sync"`，username `s3-<sha256(endpoint\0bucket\0access_key_id)>`（`device_sync.rs:21,579-587,798-808`）；`set_password` / `get_password` / `delete_credential`，配置变化时清旧条目（`device_sync.rs:860-882`） | `safeStorage.encryptStringAsync()` + 把密文写入 userData 下单独文件；`decryptStringAsync()` 读取；或引入 keytar（**已停止维护，不建议**） | **HG-4**：safeStorage 读不到旧 keyring 条目；Linux 可能 `basic_text`；macOS 需签名一致 | M | 高 |
| E2 | 账号工作区密钥（32B） | `keyring`：service `"Flowlet Account Workspace"`，username 同上（`account_workspace_sync.rs:13,96-99`）；base64 存 `set_password`；用于 ChaCha20-Poly1305 目录加解密（`account_workspace_sync.rs:201-260`） | 同 E1：`safeStorage` 密文文件；算法仍用 Node `crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 })`，AAD 保持 `flowlet-account-workspace-v1` | **HG-4** | M | 高 |
| E3 | 已有密钥数据迁移 | 旧条目由 keyring 写入 OS：Windows Credential Manager / macOS Keychain / Linux Secret Service；Android Keystore | 一次性迁移器：用 OS API/CLI 读旧条目 → `safeStorage` 重新加密；或提示用户重新输入/重新导入工作区接入包 | **HG-4**：无自动读取 capability；建议默认「重新输入 + 提供导入包」，迁移器作为可选 | L | 高 |
| E4 | 账号 API Key / 管理凭据存储 | 现状为 SQLite 明文（`core/storage.rs:748` `api_key TEXT NOT NULL`），**未走 keyring**；Web Host 管理凭据只存环境变量/内存 | 保持不变（继续 SQLite）；不建议顺手用 safeStorage 加密 DB 字段（会引入迁移/查询复杂度，且不改变「本机用户可读」的安全边界） | EQ（无新增缺口）；需在文档中明确「API Key 明文」现状不变 | S | 低 |
| E5 | 设备身份文件 | `core/device_identity.rs`：`flowlet-device.json`，schema v1，`device_id` UUID，原子写（临时文件 + rename，`persist_new`） | `crypto.randomUUID()` + `fs.writeFile` 临时文件 + `fs.rename` | EQ | S | 低 |

### 3.6 控制台抓取（迁移核心风险区）

背景：当前是**三条链路**——Windows 走 WebView2 原生 `WebResourceResponseReceived`（`scrape_console.rs:315-455`）、Linux 走 WebKitGTK `resource-load-started` + `WebResource.data`（`scrape_console.rs:477-560`）、macOS 没有原生捕获、只能靠页面注入 fallback。Electron 可把三条收敛为 **CDP（`webContents.debugger` + `Network.getResponseBody`）**。

| # | 能力 | Rust 现状（实现位置与行为） | Electron 方案（具体 API） | 缺口或降级 | 工作量 | 风险 |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | 每账号隔离的隐藏抓取窗口 + 独立登录态目录 | `build_scrape_webview`（`core/scrape_console.rs:221-300`）：label `scrape-<account_id>`，初始 `about:blank`（避免中断 SSO），`visible(false)`，`inner_size(1440,900)`，`data_directory = webview_data_root/scrape-webview-<account_id>`（`webview_profile.rs:22-34`）；`initialization_script(interceptor)` + `initialization_script_for_all_frames` | `new BrowserWindow({ show:false, width:1440, height:900, webPreferences:{ partition:'persist:scrape-<account_id>', preload, contextIsolation:true, sandbox:true, nodeIntegration:false } })`；`session.fromPartition()`；缓存限额用 `app.commandLine.appendSwitch('disk-cache-size', '16777216')` / `'media-cache-size'` / `'--disable-features=...'`（替代 `WINDOWS_CACHE_LIMIT_BROWSER_ARGS`，`webview_profile.rs:146-152`） | DG：`partition` 只隔离 cookie/localStorage/IndexedDB/cache，不像独立 `user-data-dir` 那样隔离 GPU/进程级状态；目录布局不可迁移（HG-5）；创建前 `loadURL('about:blank')` 与监听安装顺序必须保持「先监听后导航」 | M | 高 |
| F2 | Windows 抓取响应体（WebView2 原生） | `install_windows_response_capture` + `attach_webview2_response_capture`（`scrape_console.rs:315-457`）：`ICoreWebView2_2::add_WebResourceResponseReceived` → `Response.GetContent` → `IStream` 分块读取，单响应上限 8 MB（`read_webview2_response_body`），按 account 写入 `scrape_pending`，成功标记 `scrape_native_ready`；失败回退页面注入 | `wc.debugger.attach('1.3')` → `sendCommand('Network.enable', { maxTotalBufferSize, maxResourceBufferSize })` → `on('message')` 收 `Network.responseReceived` → `sendCommand('Network.getResponseBody', { requestId })` → `base64Encoded ? Buffer.from(body,'base64').toString('utf8')`；`wc.debugger.on('detach')` 重挂/降级；窗口销毁前 `detach()` | EQ（且 macOS 同源可用）；风险：body 竞态（导航/重定向/304/被逐出）、大 body 截断、requestId→槽位映射、`getResponseBody` 可能失败需记录并降级 | M | 中 |
| F3 | Linux 抓取响应体（WebKitGTK 原生） | `install_linux_response_capture`（`scrape_console.rs:477-560`）：`webview.connect_resource_load_started` + `resource.connect_finished` + `resource.data(None, cb)`，8 MB 上限；窗口创建前 `ensure_scrape_webview_budget`（fd≥80%、可用内存<512 MB 拒绝，`scrape_console.rs:690-805`），因为 webkitgtk 子进程创建失败会 `abort()` 整个进程 | 与 F2 同一套 CDP；Chromium 渲染进程崩溃不会 `abort()` 主进程（主进程仍有崩溃风险，但由 Electron 自身隔离）；保留内存/fd 余量检查（`process.getProcessMemoryInfo()`、`/proc/self/fd`） | EQ（**净简化**：删掉 webkit2gtk 依赖与 Linux 专属 abort 防护） | M | 低 |
| F4 | document-start 页面注入、IPC 回传、ready ACK、extractor 执行 | `initialization_script` 注入 interceptor（`scrape_console.rs:236-267`），页面通过 `__TAURI_INTERNALS__.invoke('handle_scrape_interceptor_ready')` 回 ACK；`config.json` 中 4 处 `interceptor_js` 直接调用 `window.__TAURI_INTERNALS__?.invoke('handle_intercepted_response', {channelId,url,body})`；页面 stash `window.__flowlet_scrape_stash`（最多 8 条）；`drain_scrape_page_stash` 用 `eval_with_callback`（`commands/scrape.rs:1490-1560`）；extractor 经 `build_extractor_call` + `eval_with_callback` 执行，10 s 超时（`commands/scrape.rs:2464-2485`） | 方案 A（推荐，兼容配置）：`webPreferences.preload` 在 document-start 注入 `window.__TAURI_INTERNALS__ = { invoke(cmd,args){ return ipcRenderer.invoke('tauri-compat', cmd, args) } }` 的兼容 shim，主进程实现 `handle_scrape_interceptor_ready` / `handle_intercepted_response`；extractor 用 `wc.executeJavaScript('(' + extractor_js + ')(bundle, credential)')`（或 CDP `Runtime.evaluate` + `returnByValue:true`）。方案 B：改写全部 `config.json` / 自定义抓取描述符里的 JS | **配置耦合型硬缺口**：页面 hook 必须运行在 main world（`contextIsolation:true` 时 preload 默认在 isolated world；需 `contextIsolation:false` + preload，或 `Page.addScriptToEvaluateOnNewDocument`）；shim 可让现有内置配置与 `custom_scrape` 文件夹描述符零改动工作 | M | 中 |
| F5 | 多阶段导航（1–3 个 console_url）、槽位分类、聚合、登录页识别 | `ScrapeModeRuntime` 含 `console_url` / `_secondary` / `_tertiary`（`scrape_console.rs:21-40`）；`ScrapeSlotEngine.classify/satisfies/merge`；`classify_response_url`、`aggregate_complete`、`is_explicit_login_url`（`channel_capability_adapter`）；`probe_scrape_login` 状态机 `Captured/LoginRequired/ConsoleActionRequired/CaptureTimeout`（`commands/scrape.rs:589-594, 2130-2150`）；自定义描述符走 `custom_scrape::SlotRule` | `win.loadURL()` 串行导航 + `did-navigate` / `did-fail-load` / `did-finish-load` 事件；槽位/聚合/登录判断逻辑整体移植到 TS（纯逻辑，无平台依赖）；`webContents.getURL()` 取当前页 | EQ（纯逻辑移植，风险在行为细节） | M | 中 |
| F6 | 交互式登录窗口展示、与后台同步互斥、窗口上限与回收 | `surface_scrape_webview`（`commands/scrape.rs:2258-2280`）：登录/需人工处理时把隐藏窗口 `set_size(1440,900)`、`set_position(100,100)`、`show()`、`set_focus()`；`SCRAPE_WEBVIEW_MAX_LIVE=3`；`reclaim_stale_scrape_webviews` / `destroy_scrape_webview`（`commands/scrape.rs:795-818`）；`scrape_interaction_required` / `scrape_interactive_sessions` 防止后台同步打断用户登录 | `win.setBounds({x:100,y:100,width:1440,height:900})` + `win.show()` + `win.focus()`；`Map<accountId, BrowserWindow>` + `win.destroy()`；窗口上限与资源余量检查保留；后台轮次用 `interactive=false` 路径 | EQ | S | 中 |
| F7 | 第三方控制台登录态保持、SSO 反自动化、UA/隐藏视口 | 每账号独立数据目录持久化登录态（`scrape_console.rs:221-232` 注释）；LongCat 固定桌面 Chrome UA（`scrape_console.rs:282-290`），因为隐藏 WebView 的 `innerWidth=0` 会被判成移动端；Qwen 保持默认 UA（阿里云 SSO 对 UA 敏感）；FB/Friday 等第三方 SSO | `session.fromPartition('persist:...')` 持久化；`webContents.setUserAgent()`；隐藏窗口布局需实测（`paintWhenInitiallyHidden`、`show:false` 时的视口/合成器状态）；必要时先 `showInactive()` 再隐藏/移出屏幕来获得真实视口 | **HG-5**：既有 WebView2/WebKitGTK 登录态不可迁移；内嵌 Chromium 可能被 SSO 拦截；必须逐渠道真机验证 | L | 高 |
| F8 | 抓取页面安全边界 | Tauri `security.csp = null`（`tauri.conf.json`），命令白名单 + 初始化脚本；抓取页可加载任意第三方 HTTPS | `sandbox:true`、`contextIsolation:true`、`nodeIntegration:false`；`session.setPermissionRequestHandler((wc,p,cb)=>cb(false))`；`webContents.setWindowOpenHandler(()=>({action:'deny'}))`；`will-navigate` 只允许白名单 origin；独立 partition；不放行 `openExternal`/证书错误 | DG：Electron 攻击面更接近浏览器，需要新的安全基线（比 Tauri 更依赖应用层约束） | S | 中 |
| F9 | macOS 抓取原生捕获 | 无原生实现：`scrape_console.rs` 只 `#[cfg(windows)]` / `#[cfg(target_os="linux")]`，macOS 依赖页面注入 fallback | 同 F2/F3 的 CDP，macOS 与 Windows/Linux 用同一实现 | EQ（**净增强**：macOS 首次拥有原生响应捕获） | S | 低 |
| F10 | 系统 WebView 运行时依赖 | Windows 依赖 WebView2 Runtime；Linux 依赖系统 `libwebkit2gtk-4.1`（CI 安装 `libwebkit2gtk-4.1-dev`，`build-installers.yml`）；macOS WKWebView | Electron 自带 Chromium：不需要 WebView2/WebKitGTK，但仍依赖 GTK/X11 运行库；安装包增大（约 +150 MB 量级）、内存占用升高 | DG：运行时依赖消失、包体与内存上升；CI 可删除 WebKitGTK 依赖 | S | 低 |

### 3.7 子进程、文件监听、LAN 与网络栈

| # | 能力 | Rust 现状（实现位置与行为） | Electron 方案（具体 API） | 缺口或降级 | 工作量 | 风险 |
| --- | --- | --- | --- | --- | --- | --- |
| G1 | 托管 Agent Web Runtime 子进程（DSH Web） | `core/agent_runtime.rs`：tokio `Command` 启动 `cmd.exe → node.exe`（`CREATE_NO_WINDOW` 静默）、健康检查 `START_TIMEOUT=20s`、输出捕获上限 24 KB、`stop_all()`；Windows 绑定 Job Object（`win_process_job.rs`）实现崩溃回收；正常停止用 `taskkill /T /F` | `child_process.spawn(program, args, { windowsHide:true, stdio:['ignore','pipe','pipe'] })`；优雅停止 `taskkill /T /F` 或 `tree-kill`；Unix `spawn({detached:true})` + `process.kill(-pid)`；健康检查 `fetch('http://127.0.0.1:3080/...')` | **HG-6**：Node 无 Job Object；崩溃/强杀会留下孤儿进程树 | L | 高 |
| G2 | CLI 探测子进程（Agent 环境/版本） | `core/agent_environment/process.rs`：`Command` + Windows `CREATE_NO_WINDOW`；Windows 控制台输出按 ANSI 代码页 `MultiByteToWideChar(CP_ACP)` 解码（`process.rs:145-170`） | `child_process.execFile(file, args, { windowsHide:true, timeout, encoding:'buffer' })`；Windows 输出用 `iconv-lite`/`TextDecoder('gbk')` 解码；注意 `cmd.exe` 与 `.cmd` 垫片的引号规则 | EQ（需重写 Windows 编码/引号处理） | M | 中 |
| G3 | 打开外部 URL / 本机 OAuth | `tauri_plugin_opener::open_url`（`commands/agent.rs:188,356`）；`antigravity_oauth::authorize(..., open_url)` 回调 | `shell.openExternal(url)`；配 `app.setAsDefaultProtocolClient` 可选 | EQ | S | 低 |
| G4 | 导入/导出文件对话框 | 前端 `@tauri-apps/plugin-dialog` 的 `open` / `save`（`src/pages/settings/tabs/SyncTab.tsx:4`）；Rust 侧 `export_config` / `import_config` 走路径参数 | `dialog.showOpenDialog({ properties:['openFile'] })` / `dialog.showSaveDialog()`，经 `ipcMain.handle` 暴露给渲染进程 | EQ | S | 低 |
| G5 | Agent 原生数据源文件监听 | `core/agent_source_watcher.rs`：`notify::recommended_watcher`，监听 `native_agent_source_watches()` 给出的路径（recursive 可选），只关心 `.jsonl/.db/.sqlite/.wal` 与 `session_index.jsonl`，按 agent 类型 750 ms 防抖，emit `agent-source-changed` | `chokidar.watch(paths, { ignoreInitial:true, awaitWriteFinish:true })`；或 `fs.watch(dir,{recursive:true})`；同样按扩展名过滤 + 防抖；`webContents.send('agent-source-changed', ...)` | EQ；注意 Linux inotify `max_user_watches` 上限与递归监听成本 | S | 中 |
| G6 | 局域网直连服务（同信任域设备加速） | `core/lan_sync.rs`：axum `TcpListener::bind("0.0.0.0:0")` 随机端口；HMAC-SHA256 签名 + 30 s 时间窗 + nonce 重放缓存；ChaCha20-Poly1305 加密 payload；`candidate_lan_addresses` 用网卡枚举 + UDP connect 启发式（`lan_sync.rs:310-352`）；`probe_and_cache_lan_peers` | `http.createServer()` 随机端口；`crypto.createHmac('sha256')` + `crypto.timingSafeEqual`；`crypto.createCipheriv('chacha20-poly1305', key, nonce, {authTagLength:16})`；`os.networkInterfaces()` + `dgram`/UDP connect 启发式 | EQ（协议可保持不变）；需做「Rust ↔ Node 双实现互操作」回归（签名串、nonce 窗口、AAD） | M | 中 |
| G7 | S3 设备用量/账号工作区同步 | `core/device_sync.rs`（rusty-s3 预签名 URL、ETag、64 MB bundle 上限、15 min 定时）；`core/account_workspace_sync.rs`（ChaCha20-Poly1305 目录） | `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`（SigV4 预签名）；加密/解密用 Node `crypto`；定时任务同上 | EQ（Node 生态更成熟；需验证 endpoint/path-style 与 S3 兼容实现） | M | 中 |
| G8 | 上游代理与出站网络栈（含 SSE 流式） | reqwest + `hyper-util` 代理；`core/upstream_proxy.rs` 全局代理；每账号出口策略（直连/代理）；SSE 流式透传与超时（`proxy.rs`） | `undici` `ProxyAgent` / `EnvHttpProxyAgent` + `fetch()` 流式 `ReadableStream`；或 `https.Agent`/`http-proxy-agent`；SSE 透传需保持「不缓冲、逐块转发」 | DG：Node 网络栈语义（连接池、超时、代理环境变量）需重新实现并回归；不是平台 API 缺口但属于迁移主干 | M | 中 |
| G9 | 请求/响应体捕获（gzip/deflate/br/zstd 解压） | `request_capture.rs` / `proxy_http.rs`：落库前解压，支持 brotli / zlib / zstd；Body 捕获受 `log_capture` 配置控制 | Node `zlib.gunzipSync` / `inflateSync` / `brotliDecompressSync`；zstd 需 `node:zlib` 的 zstd 支持或 `@mongodb-js/zstd`；保持按配置捕获与体积上限 | EQ | S | 低 |

### 3.8 前端桥、安全与其他桌面能力

| # | 能力 | Rust 现状（实现位置与行为） | Electron 方案（具体 API） | 缺口或降级 | 工作量 | 风险 |
| --- | --- | --- | --- | --- | --- | --- |
| H1 | Tauri command IPC（100+ 命令） | `lib.rs:800-942` 的 `invoke_handler(generate_handler![...])`；前端 `src/platform/tauri/client.ts` 的 `invokeCommand()` 带 15 s 超时；Web Host 已有 HTTP 适配 `src/platform/web/client.ts` | `ipcMain.handle(channel, handler)`（可按域分组，或单通道 `command` + 白名单路由）；preload 用 `contextBridge.exposeInMainWorld` 暴露 `invoke`；复用现有 `src/platform` 抽象新增 `platform/electron/client.ts` | EQ（机械但量大的重写；命令清单即契约） | L | 中 |
| H2 | 主进程 → 前端事件 | `app.emit`：`agent-source-changed`（`agent_source_watcher.rs:42-47`）、`mobile-device-sync-updated`（`lib.rs:1030`）、存储用量进度事件（`commands/maintenance.rs`） | `win.webContents.send(channel, payload)` + preload 暴露 `ipcRenderer.on`；窗口销毁时移除监听，避免泄漏 | EQ | M | 中 |
| H3 | 前端平台层分叉（Tauri / Web / Mobile） | `src/platform/tauri/*`、`src/platform/web/*`、`src/platform/web/mode.ts`（`isWebHost`）；`src/mobile/*` 用 Tauri 手机 API | 新增 `src/platform/electron/*`（命令 + 窗口 + 事件 + 对话框），保留 Web 适配供 headless/浏览器使用；按构建 mode 注入不同实现 | EQ | M | 中 |
| H4 | 安全模型（命令白名单/CSP/权限） | Tauri `capabilities/`（`src-tauri/capabilities`）+ `security.csp = null`；命令白名单；Web Host 用显式命令白名单（`core/web/commands.rs`） | `contextIsolation:true`、`sandbox:true`、`nodeIntegration:false`；CSP `default-src 'self'`；`session.setPermissionRequestHandler`/`setPermissionCheckHandler` 默认拒绝；IPC 参数类型校验；不暴露 `shell`/`fs` 到渲染进程 | DG：安全基线需要重新建立并审计（Electron 更依赖应用层防护） | M | 中 |
| H5 | 剪贴板 | 前端 `navigator.clipboard.writeText`（多处，如 `OverviewPage.tsx`、`AboutTab.tsx`） | 渲染进程 `navigator.clipboard` 可直接用（Electron 安全上下文）；主进程可用 `clipboard.writeText` | EQ | S | 低 |
| H6 | 多窗口（主窗口 + 每账号抓取窗口） | 主窗口 1 个（`tauri.conf.json`）+ 动态 `scrape-<account_id>` 窗口（`scrape_console.rs:221-300`）；无其他业务窗口 | `BrowserWindow` 多个；抓取窗口用独立 partition；统一窗口生命周期 Map 与退出清理 | EQ | S | 低 |
| H7 | 应用激活/单实例唤起/macOS open-url | Tauri 默认 `activate` 行为 + 单实例锁；无自定义 URL scheme | `app.on('activate')`（macOS Dock 点击）；`second-instance` 唤起；`app.setAsDefaultProtocolClient`（如未来需要） | EQ（当前未使用 URL scheme） | S | 低 |

### 3.9 打包、签名与发布（与现有 CI 对比）

| # | 能力 | Rust 现状（实现位置与行为） | Electron 方案（具体 API / electron-builder 配置） | 缺口或降级 | 工作量 | 风险 |
| --- | --- | --- | --- | --- | --- | --- |
| I1 | Windows NSIS + MSI | `tauri.conf.json bundle.targets="all"`；CI `--bundles nsis,msi`（`build-installers.yml` Windows job）；未签名 | electron-builder `win.target: ['nsis','msi']`；`msi` 由内置 WiX Toolset 生成（`www.electron.build/docs/msi`）；`artifactName` 控制命名 | EQ；MSI 依赖 WiX 工具链（electron-builder 自动下载） | M | 中 |
| I2 | Windows 便携版 ZIP（exe 旁数据、`portable.tag`、`config.json`） | `scripts/build-portable.mjs`：复制 exe + `flowlet_lib.dll`（旧）/config + 写 `portable.tag` + Python zip；CI 上传 `flowlet-windows-x64-portable` 产物并附 Release | electron-builder `win.target: ['zip']`（保留目录结构）或 `portable`（**单 exe 自解压到临时目录**）；主进程 `app.setPath('userData', dirname(process.execPath))` 恢复「exe 旁数据」；`portable.tag` 判定可保留 | **DG + HG-3**：`portable` target 语义是解压运行，不等于当前 ZIP 目录；要保住现有语义应选 `zip` + 自定义脚本；便携版 toast/AUMID 仍是硬缺口 | M | 高 |
| I3 | Linux AppImage + deb | CI `--bundles appimage,deb`；依赖 `libwebkit2gtk-4.1-dev` 等系统包 | electron-builder `linux.target: ['AppImage','deb']`；无需 WebKitGTK，但仍需 GTK/X11 运行库；AppImage 需 FUSE/`--appimage-extract-and-run` 兼容说明 | EQ | M | 低 |
| I4 | macOS dmg（aarch64 + x64） | CI `--bundles dmg`，`APPLE_SIGNING_IDENTITY=-` ad-hoc，构建后 `codesign --verify` + 校验 `Signature=adhoc` 才上传；文档说明未公证、需 `xattr -dr com.apple.quarantine`（`docs/release-builds.md`） | electron-builder `mac.target: ['dmg']`；ad-hoc：`mac.sign.identity: "-"`（electron-builder 文档；ad-hoc 应用仅适合自有分发，正式分发要 Developer ID + notarization）；公证：`mac.notarize`（@electron/notarize，需 Apple 凭据） | DG：可复制现有 ad-hoc 分发策略；一旦要公证需证书/Apple ID/Team ID，CI secrets 增加 | M | 中 |
| I5 | Android 签名 APK | `tauri:android:build --apk --target aarch64`；CI 用 4 个 secrets 写 keystore + `keystore.properties`，`apksigner verify`，上传 Release + Pgyer（`build-installers.yml` android job） | **无**（Electron 无 Android target） | **HG-1**：见第 2 节 HG-1；若保留 Tauri Android，则此 job 原样保留（构建的是 Rust 核心而非 Electron） | L | 高 |
| I6 | Windows 代码签名 | 当前未签名（`docs/release-builds.md` 明确）；CI 不加签名 | electron-builder Windows 签名：`signtool`（`WindowsSignOptions`）、Azure Trusted Signing、HSM/PKCS#11（`/docs/api` 中 `WindowsAzureSigningConfig` 等）；需证书与 CI secrets | DG：现状同样未签名，可保持一致；正式分发前补签名是同一待办 | M | 中 |
| I7 | CI 构建矩阵 | `build-installers.yml`：4 个桌面 job（windows/linux/mac arm+intel）+ android job；步骤含 Rust toolchain、WebKitGTK 依赖、模型目录抓取重试、`tauri-apps/tauri-action@v1`、mac ad-hoc 校验、portable ZIP、Pgyer | GitHub Actions matrix：`npm ci` + electron-builder（`--win/--linux/--mac`）；缓存 Electron 二进制；删除 Rust/WebKitGTK/Android SDK 步骤（Android 视决策保留）；mac 签名/公证步骤；产物上传与 Release | DG：CI 重写；构建时间/缓存策略变化；Android job 是否保留取决于 HG-1 | M | 中 |
| I8 | 自动更新 | 未启用：`uploadUpdaterJson: false`（`build-installers.yml`），无 updater 插件 | `electron-updater`（可选）；当前可继续不做 | EQ（无现状缺口） | S | 低 |
| I9 | 随包资源（config.json / models-cn / models-dev） | `tauri.conf.json bundle.resources`；首次启动从 resource_dir 复制到 exe 旁（`lib.rs:326-348`） | electron-builder `extraResources` + 主进程首启复制到 userData/exe 旁；`process.resourcesPath` 定位 | EQ | S | 低 |
| I10 | 图标/托盘资源 | `src-tauri/icons/*`、`tray.png`、`macos-icon.icns`、`icon-manifest.json`；macOS 专用图标处理（`docs/release-builds.md`） | electron-builder `icon`（ico/icns/png 目录）；`nativeImage.createFromPath('icons/tray.png')`；macOS Template Image 注意 Retina | EQ | S | 低 |

### 3.10 平台覆盖矩阵（移动端与浏览器 Host）

| # | 能力 | Rust 现状（实现位置与行为） | Electron 方案（具体 API） | 缺口或降级 | 工作量 | 风险 |
| --- | --- | --- | --- | --- | --- | --- |
| K1 | Android 移动辅助端 | `run_mobile()`（`lib.rs:947-1057`）+ `mobile_commands.rs`（17 命令）+ `tauri.android.conf.json` + `gen/android` + barcode scanner + Android Keystore + CI APK/Pgyer | 无（Electron 无 Android） | **HG-1** | L | 高 |
| K2 | iOS 端 | `tauri.ios.conf.json` 存在；`Cargo.toml` 为 `cfg(any(android,ios))` 引入 barcode-scanner；`mobile_commands.rs` 可编译到 iOS；CI 无 iOS job | 无（Electron 无 iOS） | **HG-1**（范围扩大；当前 iOS 未发布，可随 Android 决策一并放弃或保留 Tauri） | L | 高 |
| K3 | 浏览器 Web Host | 已有：`src/bin/headless.rs` + `core/web/{mod,commands}.rs` + 前端 `vite --mode web`（`src/platform/web/client.ts`、`src/web/WebApp.tsx`）；桌面端不依赖它 | 无需改前端；Node 服务端复用同一套 TS 命令/路由，见第 5 节 | EQ（Node 重写后自然继承） | — | — |

---

## 4. 打包产物对比（现有 CI vs electron-builder）

现有 CI 产物矩阵来自 `.github/workflows/build-installers.yml` 与 `docs/release-builds.md`：

| 平台 | 现有产物 / CI 参数 | electron-builder 等价 target | 签名差异 | 风险/备注 |
| --- | --- | --- | --- | --- |
| Windows 11 x64 | NSIS `.exe` + MSI `.msi`（`--bundles nsis,msi`），**未签名**；另加便携 ZIP（`scripts/build-portable.mjs`） | `win.target: ['nsis','msi']`；便携语义用 `zip`（保目录结构）或 `portable`（单 exe 自解压，语义不同） | 均为未签名；electron-builder 可用 `signtool`/Azure Trusted Signing/HSM（需证书） | MSI 依赖 WiX；便携版 toast/AUMID 见 HG-3；`portable` target 会改变「exe 旁数据目录」语义 |
| Linux x64 | AppImage + Debian `.deb`（`--bundles appimage,deb`）；CI 装 `libwebkit2gtk-4.1-dev` 等 | `linux.target: ['AppImage','deb']` | 无签名要求 | 不再需要 WebKitGTK 开发包；AppImage 需说明 FUSE/`--appimage-extract-and-run`；文件管理器/桌面集成行为不同需回归 |
| macOS Apple Silicon | `.dmg` + ad-hoc（`APPLE_SIGNING_IDENTITY=-`），CI `codesign --verify` 断言 `Signature=adhoc` | `mac.target: ['dmg']` + `mac.sign.identity: "-"`（ad-hoc） | ad-hoc 不能公证；正式分发需 Developer ID + `mac.notarize`（@electron/notarize） | 当前分发依赖 `xattr -dr com.apple.quarantine`；electron-builder 的 ad-hoc 文档措辞是「仅可在构建机运行」，实际分发策略需 PoC 确认 |
| macOS Intel | 同上 | 同上（`--x64`） | 同上 | 同上 |
| Windows 便携 ZIP | `Flowlet_<ver>_<arch>_portable.zip`：exe + config.json + `portable.tag`，数据在 exe 旁 | 自定义 `zip`/`dir` target + 首启路径重定向 | 无 | 与 I2 同一缺口：Electron 默认 userData 与 toast 身份都需要额外工作 |
| Android arm64 | 签名 APK（4 个 secrets + `apksigner verify`）+ Release + Pgyer | **无** | keystore 签名流程保留在 Tauri/Android 工程 | **HG-1**；Electron 迁移后若保留 Tauri Android，则 CI 的 android job 与 Gradle 工程原样保留 |
| 自动更新 | 未启用（`uploadUpdaterJson: false`） | `electron-updater`（可选） | — | 现状无缺口，可继续关闭 |

**结论**：桌面 5 类产物中 4 类可平替（NSIS/MSI/AppImage/deb/dmg），差异集中在 **Windows 便携语义**、**macOS 签名/公证**、**Windows 代码签名** 三处；Android 无对等 target。

---

## 5. Headless / Docker Host：Node 直接复用同一 server 代码

### 5.1 现有 Rust Host 结构

- 独立入口 `src-tauri/src/bin/headless.rs`：`cargo build --no-default-features --bin headless`（`Dockerfile` 的 `server` stage），不链接 Tauri/WebKitGTK。
- 环境变量契约（`headless.rs` + `docker-compose.yml` + `docs/docker.md`）：
  `FLOWLET_ADMIN_TOKEN`（必填，≥24 字符）、`FLOWLET_CLIENT_TOKEN`（可选）、`FLOWLET_DB_PATH`、`FLOWLET_CONFIG_PATH`、
  `FLOWLET_BIND_ADDR`（模型入口，默认 `127.0.0.1:18640`）、`FLOWLET_WEB_ADDR`（管理入口，默认 `127.0.0.1:8080`）、
  `FLOWLET_STATIC_DIR`、`FLOWLET_PUBLIC_PROXY_URL`、`FLOWLET_CATALOG_DIR`、`RUST_LOG`。
- 服务复用：`FlowletServices::open(db_path, config_path)?.with_client_auth()` 后 `start_proxy()`；Web 路由 `core/web/mod.rs::create_web_router`：
  - 静态资源 `tower-http::ServeDir` + SPA fallback（`ServeFile(index.html)`）；
  - 管理 API 前缀 `/api`，`authenticate` 中间件做 HMAC 常量时间校验，`/api/commands/{command}` **显式命令白名单**（`core/web/commands.rs`），`/api/{*path}` 未匹配返回 404（避免 SPA 吞掉 API 错误）；
  - `/health` 供 Docker healthcheck；
  - 管理凭据与模型调用凭据分离：`with_client_auth()` + `ProxyBindConfig.default_client_token`；headless 强制二者不同（`headless.rs` 校验）。
- 后台任务：余额同步（30 s 首跑、5 min 周期）、存储清理（15 min）、模型目录同步（1 h）；`shutdown()` 监听 SIGTERM/Ctrl-C。
- 能力裁剪：Web Host 不提供桌面 command（本机 Agent 配置写入、WebView 抓取、本机 OAuth、S3 设备同步/LAN 在 Web Host 不运行）。

### 5.2 Node/TS 复用方案

**目标形态**：新增 `server/`（或 `src-server/`）作为独立 Node 入口，**只依赖业务核心模块**（proxy/storage/channels/routing/usage/agent 数据读取），不 import Electron、不用 `app`/`BrowserWindow`；Electron 主进程与 headless 入口复用同一套 server 模块（Electron 侧可 in-process 或 sidecar 方式启动）。

| # | 改造点 | Rust 现状 | Node 方案 | 缺口或降级 | 工作量 | 风险 |
| --- | --- | --- | --- | --- | --- | --- |
| J1 | 独立 server 入口 + 服务复用 | `src/bin/headless.rs`：`FlowletServices::open`、`create_web_router`、`axum::serve` | `server/main.ts`：`createServer()` 组装 storage/proxy/web router；`node --enable-source-maps dist-server/main.js`；不 import `electron`/`tauri` | EQ（业务核心需先完成 Node 重写；入口本身不难） | L | 中 |
| J2 | 静态资源/SPA/API 404 | `ServeDir` + `ServeFile(index.html)`；`/api/{*path}` 显式 404 | `express.static(dist-web)` + SPA fallback（`GET *` 返回 index.html，但 `/api/*` 先返回 JSON 404） | EQ | S | 低 |
| J3 | 管理凭据/模型入口鉴权 | `check_auth`：HMAC-SHA256 + 常量时间比较，`FLOWLET_ADMIN_TOKEN`；`with_client_auth()`；headless 校验管理凭据≠调用密钥 | `crypto.createHmac('sha256', 'flowlet-web-admin')` + `crypto.timingSafeEqual`；常量时间比较；`FLOWLET_ADMIN_TOKEN` ≥24；`FLOWLET_CLIENT_TOKEN` 独立，未提供时随机生成并持久化到 SQLite `proxy_bind_config`；`/v1/*` 只接受调用密钥 | EQ（**必须保留双凭据分离**，不能用同一 token） | M | 中 |
| J4 | 后台定时任务 + 优雅退出 | `headless.rs`：余额 5 min、清理 15 min、目录 1 h；`shutdown()` SIGTERM/Ctrl-C | `setInterval` + `AbortController`；`process.on('SIGTERM'/'SIGINT')` → 停 proxy、关 server、SQLite checkpoint、`process.exit(0)`；Docker `stop_grace_period` 对齐 | EQ | M | 低 |
| J5 | SQLite 驱动与双 ABI（Electron vs plain Node） | `rusqlite`（bundled SQLite），桌面与 headless 同一二进制/ABI | **关键架构选择**：`better-sqlite3` 需为 Electron ABI 重建（`electron-rebuild`），不能同时被 plain Node 加载；`node:sqlite`（Node 22+ 内置，Node 26 已可用）可避开 ABI，但需确认 API/事务/`WAL` 能力；或 headless 用独立 webpack/esbuild 产物 + 单独安装的 Node 原生模块 | **DG/架构风险**：同一份代码在 Electron main 与 plain Node 之间必须解决原生模块 ABI；推荐 `node:sqlite` 或把存储层做成 sidecar 进程 | L | 高 |
| J6 | Dockerfile / Compose | 三阶段：node 构建 `dist-web` → rust `headless` → debian-slim 运行（UID 10001、`/data` 卷、healthcheck、SIGTERM） | 两阶段：node 构建前端+server → `node:26-slim` 运行（非 root、`/data` 卷、healthcheck `GET /health`、SIGTERM）；保持相同环境变量契约 | EQ | M | 低 |

### 5.3 明确不随 headless 迁移的桌面能力

以下能力在 Rust Web Host 中已经缺失或在 `core/web/commands.rs` 白名单外，Node 方案必须保持同样的裁剪（不要为了复用页面而开放桌面命令，AGENTS.md 第 1 节）：

- 本机 Agent 全局配置写入（Claude Code / Codex / OpenCode / Pi / DSH）；
- 桌面 WebView 控制台抓取（LongCat/Qwen/Z.AI/Friday）；
- 本机 OAuth 授权（Antigravity 等）；
- 本机文件系统扫描、Agent 原生会话采集（依赖本机 `~/.claude` 等目录）；
- 开机自启、托盘、窗口控制；
- S3 设备同步与 LAN 直连服务（`docs/docker.md` 明确 Web Host 不运行）；
- keyring / safeStorage 凭据存储（Web Host 用环境变量）。

---

## 6. 工作量与风险汇总

### 6.1 计数（矩阵行）

| 工作量 | 行数 | 说明 |
| --- | --- | --- |
| S | 32 | 机械替换或纯前端/配置调整 |
| M | 34 | 需要设计决策、平台差异处理或中等规模重写 |
| L | 9 | 硬缺口、跨平台 PoC 或架构级改造 |
| 特殊 | 2 | B5（无边框缩放手柄：正常 M、Linux 需伪缩放则 L）、K3（无独立工作量，随 Node 重写继承） |

### 6.2 人日粗估（含联调；不含真机验收等待）

| 工作包 | 估算 | 依据 |
| --- | --- | --- |
| 桌面壳与系统集成（单实例/窗口/托盘/自启/电源/日志/目录/事件） | **18–28 人日** | A/B/C/D 组 S/M 项；无边框壳与多平台验证占大头 |
| 控制台抓取（窗口/隔离 profile/CDP/注入 shim/多阶段/登录态） | **20–30 人日** | F 组；登录态验证取决于渠道数量与 SSO 结果 |
| 凭据存储与迁移 | **5–10 人日** | E 组；若做无缝迁移则 +5 |
| 子进程/文件/LAN/S3/网络栈 | **20–30 人日** | G 组；Job Object 与 S3/代理重写占大头 |
| 前端 IPC/安全桥/平台层 | **12–20 人日** | H 组；100+ command 的机械重写 |
| 打包/签名/CI | **10–15 人日** | I 组；mac 签名/公证与 portable 语义 |
| Headless/Docker（含 SQLite ABI 决策） | **12–20 人日** | J 组；若选 sidecar 会更高 |
| **合计（平台侧 + 桌面宿主，不含代理/存储等业务核心重写）** | **约 100–150 人日** | 业务核心 Node 重写另计（估计 40–80 人日，取决于是否逐行移植） |
| Android 另计（保留 Tauri / Capacitor / 放弃） | **15–30 人日** | HG-1；长期双核心维护成本另计 |

> 说明：矩阵里的 S/M/L 是「单项复杂度」，人日区间是「工作包」级估算，两者不是简单求和关系（多个 S 项常合并为一次会话/窗口层重写）。真实排期建议先做第 7 节的 PoC，再按 PoC 结果重估。

### 6.3 Top 风险

1. **控制台抓取登录态（HG-5）**：若某个渠道在内嵌 Chromium 中无法完成 SSO/登录，迁移就只能在「保留 Tauri 抓取 sidecar」与「放弃该渠道自动余额」之间选择。这是唯一可能推翻整轮迁移的技术风险。
2. **无边框窗口壳（HG-2）**：Linux 无 `startResizeDragging` 等价能力，可能被迫改回系统边框，违反 AGENTS.md 第 10 节「桌面窗口必须保持无系统边框模式」。
3. **Windows 子进程树孤儿（HG-6）**：DSH Web 占 3080 端口；没有 Job Object 等价物时，崩溃/强杀场景回归。
4. **SQLite/原生模块双 ABI（J5）**：若代理/存储在 Electron main 内运行，plain Node 的 headless 不能复用同一份原生模块；需要 sidecar 或 `node:sqlite`。
5. **凭据迁移（HG-4）**：现有用户的 S3 Secret/工作区密钥无法被 safeStorage 读取；Linux `basic_text` 是安全降级，必须显式提示。
6. **打包身份组合（HG-3 + I2）**：便携版 + toast + 自启 + 签名在 Windows 上互相牵连，需一次性验证组合矩阵。

---

## 7. 建议决策

### 7.1 总体判断

**迁移在技术上可行，但不是「换壳」级别的工程**：业务核心与平台层的边界清楚，Electron 能覆盖大多数系统能力（窗口/托盘/自启/电源/对话框/外部打开/文件监听/CDP 抓取），
真正的成本集中在 6 个硬缺口与「前端 IPC 边界重写 + 打包 CI 重写」。建议**分阶段 + 用 PoC 设门禁**，不要一次性切换。

### 7.2 必须先方案验证（Gate，未过不进入主迁移）

| PoC | 要验证什么 | 通过标准 | 预估 |
| --- | --- | --- | --- |
| P0-A 控制台抓取 | LongCat / Qwen / Z.AI（或 Friday）三条 SSO 链路：Electron `partition` 登录、CDP `Network.getResponseBody` 抓取、多阶段导航、隐藏/可见窗口视口、UA 覆盖 | 至少核心付费渠道（LongCat、Qwen、Z.AI）能稳定抓到余额；登录态重启后保持；响应体与 Rust 现网字段一致 | 8–12 人日 |
| P0-B 无边框窗口壳 | Windows 11 + Ubuntu X11 + Wayland：拖动、8 向缩放、双击最大化、SideSheet 拖动/层级、1200×720 最小客户区 | 三平台可完成基本窗口操作；Linux 无边框可缩放（或明确接受降级） | 4–6 人日 |
| P0-C Windows 子进程与通知身份 | Job Object 等价（原生 addon/watchdog）；portable + toast AUMID/点击；安装版 toast `Notification.handleActivation` | 强杀主进程后 DSH Web 进程树不残留；便携版与安装版 toast 行为符合降级决策 | 4–6 人日 |
| P0-D 凭据 | Windows/macOS/Linux（GNOME/KWallet/无 Secret Service）下 safeStorage 可用性；旧 keyring 一次性读取/重输流程 | 三平台可加密存储；旧数据迁移或重输路径明确；Linux `basic_text` 有提示 | 3–5 人日 |
| P0-E Headless/ABI | plain Node + Electron main 的 SQLite 方案；Docker 构建/健康检查/SIGTERM；`/api/commands` 白名单 | Node server 可独立跑通代理+管理 API；Docker 镜像启动即健康 | 3–5 人日 |

### 7.3 可以降级（需产品确认，不阻塞迁移）

- **原生桌面通知**：当前 Rust **没有实际发送代码**（只有 plugin init + AUMID 注册），可整体延后；先保留应用内 Semi Toast 与托盘状态。
- **便携版 toast**：降级为「安装版才支持系统通知；便携版用应用内提示」。
- **单实例语义**：从「exe 目录互不干扰」改为「同一 userData 单实例」；若必须保留便携多副本并存，用 per-directory `userData` 模拟。
- **Linux 开机自启**：自写 `~/.config/autostart/*.desktop`，不追求与 Windows/macOS 同 API。
- **macOS 签名**：继续 ad-hoc + 手动放行（与现状一致），公证不在本轮范围。
- **MSI**：若 NSIS 已覆盖用户，可暂缓 MSI（减少 WiX 维护面）。
- **Windows 代码签名**：现状未签名，可保持；正式分发前补。
- **控制台登录态**：接受「升级后需重新登录一次控制台」。
- **SQLite 里 API Key 明文**：现状不变，不在本轮引入加密。
- **自动更新**：保持关闭。

### 7.4 不可降级（否则迁移不成立或违反项目硬约束）

- **Android 端**：若产品仍要移动辅助端，必须保留 Tauri Android 或改用 Capacitor；不能「Electron 顺带解决」。
- **无边框窗口 + 可用窗口控制**：AGENTS.md 第 10 节硬性要求；Linux 若无法缩放，必须给出可用替代（如系统边框需产品/规范修订）。
- **DSH Web 子进程回收**：孤儿进程占端口是已发生缺陷，不能用「下次提示」替代崩溃兜底。
- **控制台抓取可用性**：若核心渠道抓不到余额，等于移除余额功能，需产品显式接受。
- **凭据可用性**：S3 同步与工作区密钥是付费/多设备功能入口，不能静默失效。

### 7.5 推荐迁移顺序

1. **阶段 0（3–4 周）**：完成 P0-A ~ P0-E；产出「抓取可行性结论 + 窗口壳方案 + ABI 决策 + 凭据迁移方案」。
2. **阶段 1（6–8 周）**：Node 业务核心 + server/headless（复用现有 SQLite schema/command 契约）+ Electron 壳（单实例/窗口/托盘/自启/电源/日志/数据目录）+ 前端 `platform/electron` 适配；先不发版，内部 dogfood。
3. **阶段 2（6–8 周）**：控制台抓取（CDP + partition + 注入 shim）、凭据 safeStorage + 迁移、打包/CI/签名、便携版语义。
4. **阶段 3（2–3 周）**：三平台真机回归（Windows 11 为基线、Linux/macOS 按 `docs/release-builds.md` 现状推进）+ Android 决策落地（保留 Tauri / Capacitor / 放弃）。
5. **长期**：若保留 Tauri Android，明确「桌面 Node 核心 + 移动 Rust 核心」的边界与共享契约（HTTP API、SQLite schema、S3/LAN 协议），避免第二套业务逻辑。

---

## 8. 取证方式与限制（「未确认」项）

- 本文所有 Rust 现状均来自对 `src-tauri/src/**`、`src-tauri/Cargo.toml`、`src-tauri/tauri*.conf.json`、`src-tauri/gen/android`、`.github/workflows/build-installers.yml`、`scripts/build-portable.mjs`、`Dockerfile`、`docker-compose.yml`、`docs/*.md`、`src/platform/**`、`src/app/shell/**`、`package.json` 的直接阅读；未运行 `cargo`/`npm` 构建，未修改 `src-tauri/` 与 `src/` 下任何文件。
- Electron API 依据 `electron/electron` **main 分支**文档（2026-11 拉取）：`docs/api/app.md`、`power-save-blocker.md`、`power-monitor.md`、`safe-storage.md`、`notification.md`、`tray.md`、`debugger.md`、`session.md`、`web-contents.md`、`browser-window.md`、`structures/base-window-options.md`、`tutorial/notifications.md`、`tutorial/custom-window-styles.md`。注意 main 分支可能领先当前稳定版（例如 safeStorage 同步 API 在 Electron 46 移除），**迁移时需锁定目标 Electron 版本重读对应版本文档**。
- electron-builder 依据 `www.electron.build/docs/{targets,nsis,msi,linux,mac,appimage,dmg}`（2026-11 拉取）。
- 本机 `web_fetch` 工具因上游 API 401 不可用，改用 `curl` 读取 `raw.githubusercontent.com` 文档源；属于只读取证，不影响结论。
- **未确认（需 PoC/真机）**：
  1. electron-builder NSIS/MSI 生成的快捷方式是否写入 AppUserModelID/ToastActivatorCLSID（影响 HG-3）；便携 ZIP 下的 toast 实际行为。
  2. Linux X11（非 Wayland）无边框 Electron 窗口是否具有可用缩放边缘；Wayland 的「扩展 resize 边界」是否满足产品体验。
  3. Electron 隐藏 `BrowserWindow` 在 LongCat/Qwen 控制台的视口、UA、反自动化判定结果（影响 HG-5）。
  4. `safeStorage` 在目标 Linux 桌面环境（GNOME/KDE/无 Secret Service）的实际后端与 `basic_text` 概率；旧 keyring 条目一次性读取在各平台的可行性。
  5. Windows Job Object 等价的可用原生 addon（NAPI/ffi）与 Electron ABI 兼容性；watchdog 方案的进程可靠性。
  6. Node 侧 SQLite 选择（`node:sqlite` vs `better-sqlite3` + `electron-rebuild`）在 Electron main 与 plain Node 双场景下的最终形态。
  7. 前端 100+ command 的 IPC 重写工作量（按域分组后实际命令数仍需盘点，`lib.rs:800-942` 为清单来源）。

---

## 9. 参考链接

- Electron API：
  - [app](https://www.electronjs.org/docs/latest/api/app)（`requestSingleInstanceLock`、`second-instance`、`setLoginItemSettings`、`setAppUserModelId`、`setPath/getPath`、`before-quit/will-quit`）
  - [powerSaveBlocker](https://www.electronjs.org/docs/latest/api/power-save-blocker)、[powerMonitor](https://www.electronjs.org/docs/latest/api/power-monitor)
  - [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)（`isAsyncEncryptionAvailable`、`encryptStringAsync`、`decryptStringAsync`、`getSelectedStorageBackend`、`basic_text`）
  - [Notification](https://www.electronjs.org/docs/latest/api/notification)、[Notifications tutorial](https://www.electronjs.org/docs/latest/tutorial/notifications)（Windows 快捷方式 AUMID + ToastActivatorCLSID、macOS 签名要求）
  - [Tray](https://www.electronjs.org/docs/latest/api/tray)、[BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)、[custom window styles](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles)
  - [webContents.debugger / Debugger](https://www.electronjs.org/docs/latest/api/debugger)、[webContents](https://www.electronjs.org/docs/latest/api/web-contents)、[session](https://www.electronjs.org/docs/latest/api/session)（`fromPartition`、`setPermissionRequestHandler`、`webRequest`）、[webRequest](https://www.electronjs.org/docs/latest/api/web-request)
  - [dialog](https://www.electronjs.org/docs/latest/api/dialog)、[screen](https://www.electronjs.org/docs/latest/api/screen)
- electron-builder：
  - [targets](https://www.electron.build/docs/targets)、[NSIS](https://www.electron.build/docs/nsis)、[MSI](https://www.electron.build/docs/msi)、[Linux](https://www.electron.build/docs/linux)、[AppImage](https://www.electron.build/docs/appimage)、[macOS](https://www.electron.build/docs/mac)、[DMG](https://www.electron.build/docs/dmg)
  - [macOS code signing / notarization](https://www.electron.build/docs/features/code-signing/notarization)、[Windows code signing](https://www.electron.build/docs/features/code-signing/code-signing-win)
- 仓库内证据：
  - `src-tauri/src/main.rs`、`src-tauri/src/lib.rs`、`src-tauri/src/bin/headless.rs`
  - `src-tauri/src/core/{window_size,window_visibility,power,win_process_job,notification_registry,agent_source_watcher,scrape_console,webview_profile,device_identity,device_sync,account_workspace_sync,lan_sync,services}.rs`
  - `src-tauri/src/core/web/{mod,commands}.rs`、`src-tauri/src/mobile_commands.rs`、`src-tauri/src/commands/{scrape,maintenance,agent}.rs`
  - `src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`src-tauri/tauri.android.conf.json`、`src-tauri/tauri.ios.conf.json`、`src-tauri/gen/android/**`
  - `src/app/shell/{WindowControls,WindowResizeHandles}.tsx`、`src/platform/{tauri,web}/**`、`src/shared/ui/overlayLayers.ts`
  - `.github/workflows/build-installers.yml`、`scripts/build-portable.mjs`、`Dockerfile`、`docker-compose.yml`
  - `docs/{release-builds,docker,windows-suspend-resume-network-resilience}.md`

