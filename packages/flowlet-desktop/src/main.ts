// Flowlet 桌面 Electron 主进程。
//
// 职责：
// 1. app ready 前解析与 Rust/Tauri 一致的数据目录，并重定向 Electron userData；
// 2. 单实例锁；第二次启动聚焦已有窗口；
// 3. 生成随机管理 token，进程内启动 flowlet-core `startHost()`（Node Host +
//    本机 HTTP 命令通道 + dist-desktop 静态资源）；
// 4. 创建无边框主窗口（1200×720 最小客户区）加载 `http://127.0.0.1:<port>/`；
// 5. 托盘、窗口记忆、关闭隐藏到托盘、只有「退出 Flowlet」才停代理并退出；
// 6. 实现 DesktopHostBridge（platform/keyring/agentRuntime/scrape/power）。
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray,
  type Rectangle,
} from "electron";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AgentRuntimeManager } from "./agent-runtime.ts";
import { normalizeBaseUrl } from "./client/config.ts";
import { createClientGateway, type ClientGateway } from "./client/gateway.ts";
import {
  desktopConfigPath,
  isSafeStorageAvailable,
  readStoredDesktopConfig,
  writeStoredDesktopConfig,
} from "./mode-store.ts";
import { openModeWindow } from "./mode-window.ts";
import { RemoteSession } from "./remote-session.ts";
import { AutostartController } from "./autostart.ts";
import { DesktopHostBridgeImpl } from "./bridge.ts";
import { DesktopKeyring } from "./keyring.ts";
import { DesktopLogger } from "./logger.ts";
import {
  applyElectronStoragePaths,
  MAIN_WINDOW_PARTITION,
  resolveDesktopPaths,
  type DesktopPaths,
} from "./paths.ts";
import { ScrapeManager } from "./scrape.ts";
import {
  ensureWindowOnScreen,
  loadWindowState,
  MIN_CONTENT_HEIGHT,
  MIN_CONTENT_WIDTH,
  saveWindowState,
} from "./window-state.ts";

interface CliOptions {
  readonly hidden: boolean;
  readonly screenshotPath: string | null;
  readonly urlFile: string | null;
  readonly dataDir: string | null;
  readonly screenshotWaitMs: number;
  /** `--pages=<dir>`：逐路由冒烟（截图 + console/命令错误报告），CI/回归用。 */
  readonly pagesDir: string | null;
  /** `--routes=/models,/logs`：覆盖逐路由冒烟的路由列表（hash path）。 */
  readonly routes: string[] | null;
  /** `--mode=host|client`：覆盖持久化的运行模式（冒烟/调试用，不写回配置）。 */
  readonly mode: "host" | "client" | null;
  /** `--client-url=https://host`：客户端模式远程地址（覆盖配置）。 */
  readonly clientUrl: string | null;
  /** `--client-token=...`：客户端模式管理凭据（覆盖配置，不落盘）。 */
  readonly clientToken: string | null;
}

interface ResizeSession {
  readonly direction: ResizeDirection;
  readonly startCursor: { x: number; y: number };
  readonly startBounds: Rectangle;
}

type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): CliOptions {
  const screenshotArg = argv.find((arg) => arg.startsWith("--screenshot="));
  const urlFileArg = argv.find((arg) => arg.startsWith("--print-url-file="));
  const dataDirArg = argv.find((arg) => arg.startsWith("--data-dir="));
  const waitArg = argv.find((arg) => arg.startsWith("--screenshot-wait-ms="));
  const waitParsed = waitArg === undefined ? Number.NaN : Number(waitArg.slice("--screenshot-wait-ms=".length));
  const pagesArg = argv.find((arg) => arg.startsWith("--pages="));
  const routesArg = argv.find((arg) => arg.startsWith("--routes="));
  const modeArg = argv.find((arg) => arg.startsWith("--mode="));
  const clientUrlArg = argv.find((arg) => arg.startsWith("--client-url="));
  const clientTokenArg = argv.find((arg) => arg.startsWith("--client-token="));
  return {
    hidden: argv.includes("--hidden") || argv.includes("--minimized"),
    screenshotPath: screenshotArg === undefined ? null : screenshotArg.slice("--screenshot=".length),
    urlFile: urlFileArg === undefined ? null : urlFileArg.slice("--print-url-file=".length),
    dataDir: dataDirArg === undefined ? null : dataDirArg.slice("--data-dir=".length),
    screenshotWaitMs: Number.isFinite(waitParsed) ? Math.max(0, waitParsed) : 1800,
    pagesDir: pagesArg === undefined ? null : pagesArg.slice("--pages=".length),
    routes:
      routesArg === undefined
        ? null
        : routesArg
            .slice("--routes=".length)
            .split(",")
            .map((route) => route.trim())
            .filter((route) => route.length > 0),
    mode:
      modeArg === undefined
        ? null
        : modeArg.slice("--mode=".length) === "client"
          ? "client"
          : "host",
    clientUrl: clientUrlArg === undefined ? null : clientUrlArg.slice("--client-url=".length),
    clientToken: clientTokenArg === undefined ? null : clientTokenArg.slice("--client-token=".length),
  };
}

const cli = parseArgs(process.argv);
// 冒烟/CI 无 GPU：显式 --disable-gpu 时关闭硬件加速，capturePage 才稳定。
if (process.argv.includes("--disable-gpu")) app.disableHardwareAcceleration();
app.setName("Flowlet");
app.setAppUserModelId("site.snewbie.flowlet");

const paths: DesktopPaths = resolveDesktopPaths(cli.dataDir === null ? {} : { dataDirOverride: cli.dataDir });
applyElectronStoragePaths(paths);
const logger = new DesktopLogger(paths.logDir);
logger.info("桌面宿主启动中", {
  dataDir: paths.dataDir,
  portable: paths.portable,
  runtimeRoot: paths.runtimeRoot,
  staticDir: paths.staticDir,
});

const gotLock = app.requestSingleInstanceLock({ launch: process.argv.join(" ") });
if (!gotLock) {
  logger.info("已有 Flowlet 实例在运行，本次启动退出并聚焦已有窗口");
  app.exit(0);
} else {
  void run().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    logger.error("桌面宿主启动失败", message);
    if (app.isReady()) dialog.showErrorBox("Flowlet 启动失败", message);
    app.exit(1);
  });
}

async function run(): Promise<void> {
  const adminToken = randomBytes(32).toString("base64url");
  if (adminToken.length < 24) throw new Error("生成的管理 token 长度不足 24 字符");
  const appVersion = app.getVersion();

  // 运行模式：CLI 覆盖 > 持久化配置 > 主机模式（老用户升级后默认行为不变）。
  const stored = readStoredDesktopConfig();
  const clientMode = (cli.mode ?? stored.config.mode) === "client";
  /** preload 暴露给渲染进程的管理凭据：主机模式是本机随机 token，客户端模式是远程凭据。 */
  let bootstrapAdminToken = clientMode ? "" : adminToken;
  let clientBaseUrl = "";
  let gateway: ClientGateway | null = null;
  let remoteSession: RemoteSession | null = null;
  /** 启动后需要用户补全连接配置（缺 token / SSO 未登录）时自动打开运行模式窗口。 */
  let needsModeSetup = false;

  if (clientMode && stored.token === null && !stored.tokenDecryptable) {
    logger.warn("已保存的远程管理凭据无法解密，需要在“运行模式”窗口重新填写");
  }

  // flowlet-core 通过 process.env 读取管理鉴权与启动参数（与 Docker/headless 一致）。
  // 客户端模式不启动 Node Host，因此不设置管理 token 环境变量。
  if (!clientMode) {
    process.env.FLOWLET_ADMIN_AUTH_MODE = "token";
    process.env.FLOWLET_ADMIN_TOKEN = adminToken;
  }
  process.env.FLOWLET_APP_VERSION = appVersion;
  if (!app.isPackaged && process.env.FLOWLET_DISABLE_BACKGROUND_TASKS === undefined) {
    // 开发/冒烟默认关闭后台余额同步等任务，避免用本地真实凭据打上游；
    // 安装版保持与 Rust 一致（默认开启）。
    process.env.FLOWLET_DISABLE_BACKGROUND_TASKS = "1";
  }
  // core bundle 内的 import.meta.url 由构建插件替换为 runtime 根下的虚拟路径。
  process.env.FLOWLET_RUNTIME_ROOT_URL = pathToFileURL(paths.runtimeRoot).href;

  let mainWindow: BrowserWindow | null = null;
  let modeWindow: BrowserWindow | null = null;
  let tray: Tray | null = null;
  let quitting = false;
  let webUrl: string | null = null;
  let host: { close(): Promise<void>; webAddr: string } | null = null;

  const keyring = new DesktopKeyring({ dataDir: paths.dataDir, logger });
  const autostart = new AutostartController(logger);
  const agentRuntime = new AgentRuntimeManager(logger);
  const scrape = new ScrapeManager({ logger, webviewRoot: paths.webviewRoot });

  const getWindow = (): BrowserWindow | null =>
    mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : null;

  function showWindow(): void {
    const win = getWindow();
    if (win === null) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  function saveState(): void {
    const win = getWindow();
    if (win !== null) saveWindowState(paths.dataDir, win);
  }

  async function callAdminCommand(command: string): Promise<unknown> {
    // 客户端模式没有本机 Node Host：代理/桌面命令都不存在，直接跳过。
    if (clientMode || webUrl === null) return null;
    const response = await fetch(`${webUrl}/api/commands/${encodeURIComponent(command)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(`命令 ${command} 失败（HTTP ${response.status}）`);
    }
    return await response.json();
  }

  async function quitApp(reason: string): Promise<void> {
    if (quitting) return;
    quitting = true;
    logger.info("开始退出 Flowlet", { reason });
    saveState();
    if (clientMode) {
      // 客户端模式只关本地网关，不碰任何代理/远程状态。
      try {
        await gateway?.close();
      } catch (error) {
        logger.warn("关闭客户端网关失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      try {
        // AGENTS.md §3：只有真正退出才停代理，且由持有代理的 Node Host 执行。
        await callAdminCommand("stop_proxy");
        logger.info("已请求 Node Host 停止代理");
      } catch (error) {
        logger.warn("退出前停止代理失败（Host 关闭时仍会 dispose）", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        await agentRuntime.stopAll();
      } catch (error) {
        logger.warn("停止托管 Agent 运行时失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        await host?.close();
      } catch (error) {
        logger.warn("关闭 Node Host 失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    tray?.destroy();
    tray = null;
    app.exit(0);
  }

  // ─── 启动 Node Host ──────────────────────────────────────────────────────

  const hostBridge = new DesktopHostBridgeImpl({
    paths,
    logger,
    keyring,
    autostart,
    agentRuntime,
    scrape,
    appVersion,
    tray: {
      setToolTip: (text: string) => tray?.setToolTip(text),
    },
    quit: () => quitApp("platform.quit"),
    relaunch: async () => {
      app.relaunch();
      await quitApp("platform.relaunch");
    },
    proxyStatus: async () => {
      const status = (await callAdminCommand("proxy_status")) as { running?: unknown } | null;
      return typeof status?.running === "boolean" ? (status.running ? "running" : "stopped") : null;
    },
    showWindow: () => showWindow(),
  });

  await app.whenReady();

  // 托盘常驻：关闭/销毁窗口不退出进程（代理继续运行）。必须在任何窗口创建前注册，
  // 否则自检/抓取窗口销毁触发 window-all-closed 时 Electron 默认会直接退出。
  app.on("window-all-closed", () => {
    logger.info("所有窗口已关闭，托盘常驻，不退出进程");
  });

  try {
    if (clientMode) {
      // ─── 客户端模式：本地网关 + 远程 Web Host ────────────────────────────
      const profile = stored.config.client;
      const baseUrl = normalizeBaseUrl(cli.clientUrl ?? profile?.baseUrl ?? "");
      const authKind: "token" | "session" =
        cli.clientToken !== null ? "token" : (profile?.auth.kind ?? "token");
      const remoteToken = cli.clientToken ?? stored.token ?? "";
      if (authKind === "token" && remoteToken === "") {
        // 不直接退出：先把界面拉起来（登录页会显示未授权），再自动弹出运行模式窗口。
        needsModeSetup = true;
      }
      clientBaseUrl = baseUrl;
      const clientLogger = { warn: (message: string, detail?: unknown) => logger.warn(message, detail) };
      const clientGateway =
        authKind === "token"
          ? createClientGateway({
              staticDir: paths.staticDir,
              remoteBase: new URL(baseUrl),
              resolveAuth: async () => ({ authorization: `Bearer ${remoteToken}` }),
              logger: clientLogger,
            })
          : (() => {
              const session = new RemoteSession({ baseUrl, logger });
              remoteSession = session;
              return createClientGateway({
                staticDir: paths.staticDir,
                remoteBase: new URL(baseUrl),
                resolveAuth: () => session.authFor(),
                logger: clientLogger,
              });
            })();
      gateway = clientGateway;
      if (authKind === "token") bootstrapAdminToken = remoteToken;
      if (authKind === "session" && remoteSession !== null) {
        const status = await remoteSession.status();
        if (!status.authenticated) needsModeSetup = true;
      }
      const address = await clientGateway.listen("127.0.0.1", 0);
      webUrl = `http://${address.host}:${address.port}`;
      logger.info("客户端模式已启动", { webUrl, remote: baseUrl, authKind });
    } else {
    // 延迟 import：core bundle 依赖上面设置的 FLOWLET_RUNTIME_ROOT_URL。
    const coreHostModule: string = "./core-host.mjs";
    const { startFlowletHost } = (await import(coreHostModule)) as {
      startFlowletHost: (options: {
        host: DesktopHostBridgeImpl;
        appVersion: string;
        dataDir: string;
        portable: boolean;
        dbPath: string;
        configPath: string;
        catalogDir: string;
        staticDir: string;
        adminToken: string;
        bindAddr: string;
        webAddr: string;
      }) => Promise<{ close(): Promise<void>; webAddr: string }>;
    };
    host = await startFlowletHost({
      host: hostBridge,
      appVersion,
      dataDir: paths.dataDir,
      portable: paths.portable,
      dbPath: paths.dbPath,
      configPath: paths.configPath,
      catalogDir: paths.catalogDir,
      staticDir: paths.staticDir,
      adminToken,
      // 模型入口沿用 Rust 默认端口；被占用时 Host 会给出明确错误。
      bindAddr: process.env.FLOWLET_BIND_ADDR ?? "127.0.0.1:18640",
      webAddr: "127.0.0.1:0",
    });
    webUrl = `http://${host.webAddr}`;
    logger.info("Node Host 已启动", { webUrl });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Node Host 启动失败", message);
    dialog.showErrorBox("Flowlet 启动失败", `无法启动本地服务：${message}`);
    app.exit(1);
    return;
  }

  if (cli.urlFile !== null) {
    try {
      writeFileSync(cli.urlFile, `${webUrl}\n`, "utf8");
    } catch (error) {
      logger.warn("写 web URL 文件失败", { error: error instanceof Error ? error.message : String(error) });
    }
  }
  console.log(`FLOWLET_WEB_URL=${webUrl}`);

  if (process.argv.includes("--host-self-test")) {
    await runHostSelfTest(hostBridge, logger);
    await quitApp("host-self-test.done");
    return;
  }

  registerWindowsAppUserModelId();

  function openModeSettings(): void {
    if (modeWindow !== null && !modeWindow.isDestroyed()) {
      modeWindow.show();
      modeWindow.focus();
      return;
    }
    modeWindow = openModeWindow({
      preloadPath: join(HERE, "preload-mode.cjs"),
      htmlPath: join(app.getPath("userData"), "mode-window.html"),
      parent: getWindow(),
      logger,
    });
    modeWindow.on("closed", () => {
      modeWindow = null;
    });
  }

  registerModeIpcHandlers({
    logger,
    openSettings: () => openModeSettings(),
    closeSender: (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win !== null && win !== getWindow()) win.close();
    },
    loadState: () => ({
      mode: clientMode ? "client" : "host",
      baseUrl: clientBaseUrl || stored.config.client?.baseUrl || "",
      authKind: stored.config.client?.auth.kind ?? "token",
      hasToken: stored.token !== null,
      safeStorage: isSafeStorageAvailable(),
      configPath: desktopConfigPath(),
    }),
    loginRemote: async (baseUrl: string) => {
      const session = remoteSession ?? new RemoteSession({ baseUrl, logger });
      if (remoteSession === null) remoteSession = session;
      else session.setBaseUrl(baseUrl);
      const status = await session.login();
      return {
        ok: true,
        message: `登录成功${status.identity === null ? "" : `：${status.identity}`}。保存并重启后生效。`,
      };
    },
    save: async (payload) => {
      if (payload.mode === "host") {
        writeStoredDesktopConfig({ version: 1, mode: "host", client: null }, null);
      } else {
        const baseUrl = normalizeBaseUrl(payload.baseUrl ?? "");
        const authKind = payload.authKind === "session" ? "session" : "token";
        const token = payload.token !== undefined && payload.token !== "" ? payload.token : stored.token;
        if (authKind === "token" && (token === null || token === "")) {
          return { ok: false, message: "请填写管理凭据（token），或改用企业 SSO 登录" };
        }
        writeStoredDesktopConfig(
          { version: 1, mode: "client", client: { baseUrl, auth: { kind: authKind } } },
          authKind === "token" ? token : null,
        );
        if (authKind === "token" && !isSafeStorageAvailable()) {
          logger.warn("当前环境没有可用的系统密钥链，管理凭据已降级为本地明文保存");
        }
      }
      logger.info("运行模式已更新，准备重启", { mode: payload.mode });
      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 120);
      return { ok: true };
    },
  });

  // IPC 必须在窗口加载前注册：preload 会同步读取管理 token。
  registerIpcHandlers({
    getWindow,
    showWindow,
    saveState,
    quitApp,
    resize: { current: null },
    logger,
    bootstrap: () => ({
      adminToken: bootstrapAdminToken,
      mode: clientMode ? "client" : "host",
      clientBaseUrl,
    }),
  });
  mainWindow = createMainWindow(paths, webUrl, cli);
  app.on("second-instance", () => {
    logger.info("收到第二次启动请求，聚焦已有窗口");
    showWindow();
  });
  try {
    tray = createTray(
      paths,
      {
        showWindow,
        quit: () => void quitApp("tray.quit"),
        openModeSettings,
        clientMode,
        remoteHost: clientBaseUrl === "" ? "" : new URL(clientBaseUrl).host,
      },
      logger,
    );
  } catch (error) {
    // 无 StatusNotifier/AppIndicator 的 Linux 环境创建托盘会失败；不能因此阻止应用运行。
    logger.warn("系统托盘不可用，主窗口关闭后将保持隐藏（无托盘入口）", {
      error: error instanceof Error ? error.message : String(error),
    });
    tray = null;
  }
  applyInitialWindowState(mainWindow, paths, cli);

  // 窗口事件：关闭=隐藏到托盘；最大化状态推给渲染进程。
  mainWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    saveState();
    mainWindow?.hide();
    logger.info("主窗口已隐藏到托盘，代理继续运行");
  });
  const notifyMaximized = (): void => {
    const win = getWindow();
    if (win === null) return;
    win.webContents.send("window:maximized-changed", { maximized: win.isMaximized() });
  };
  mainWindow.on("maximize", notifyMaximized);
  mainWindow.on("unmaximize", notifyMaximized);
  let saveTimer: NodeJS.Timeout | null = null;
  const scheduleSave = (): void => {
    if (saveTimer !== null) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveState();
    }, 500);
  };
  mainWindow.on("move", scheduleSave);
  mainWindow.on("resize", scheduleSave);

  // OS/Dock 退出路径也走统一清理：先 preventDefault，停代理/关 Host 后再 exit。
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    void quitApp("before-quit");
  });

  if (needsModeSetup && cli.screenshotPath === null && cli.pagesDir === null) {
    logger.info("客户端模式缺少有效凭据，打开运行模式窗口");
    openModeSettings();
  }

  if (cli.screenshotPath !== null) {
    await runScreenshotMode(mainWindow, cli.screenshotPath, webUrl, cli.screenshotWaitMs, logger);
    await quitApp("screenshot.done");
    return;
  }

  if (cli.pagesDir !== null) {
    await runPagesMode(
      mainWindow,
      webUrl,
      cli.pagesDir,
      cli.routes ?? DEFAULT_PAGE_ROUTES,
      cli.screenshotWaitMs,
      logger,
    );
    await quitApp("pages.done");
    return;
  }

  if (!cli.hidden) {
    mainWindow.show();
  } else {
    logger.info("以 --hidden 启动：主窗口保持隐藏，托盘常驻");
  }
  logger.info("桌面宿主就绪", { windowVisible: !cli.hidden });
}

function withSelfTestTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** 冒烟用：逐个验证 host channel（keyring / 自启 / 电源 / 运行时/抓取）。 */
async function runHostSelfTest(bridge: DesktopHostBridgeImpl, logger: DesktopLogger): Promise<void> {
  const results: Record<string, unknown> = {};
  const attempt = async (name: string, task: () => Promise<unknown>): Promise<void> => {
    const startedMs = Date.now();
    try {
      // 每个 channel 单独限时，避免某个平台能力卡住整个自检。
      results[name] = await withSelfTestTimeout(task(), 8_000, `host channel ${name} 调用超时（8000ms）`);
    } catch (error) {
      results[name] = { error: error instanceof Error ? error.message : String(error) };
    }
    logger.info(`自检步骤完成：${name}`, { elapsedMs: Date.now() - startedMs });
  };
  await attempt("appInfo", () => bridge.invoke("platform.appInfo"));
  await attempt("diagnostics", () => bridge.invoke("platform.diagnostics"));
  await attempt("autostartGet", () => bridge.invoke("platform.autostart.get"));
  await attempt("powerOn", () => bridge.invoke("power.preventSuspend", { enabled: true }));
  await attempt("powerOff", () => bridge.invoke("power.preventSuspend", { enabled: false }));
  await attempt("trayTooltip", () => bridge.invoke("platform.trayTooltip", { text: "Flowlet 自检" }));
  await attempt("agentRuntimeStatus", () => bridge.invoke("agentRuntime.status"));
  await attempt("scrapeOpen", () =>
    bridge.invoke("scrape.openConsole", { accountId: "flowlet-self-test-account" }),
  );
  await attempt("scrapeEvaluate", () =>
    bridge.invoke("scrape.evaluate", {
      accountId: "flowlet-self-test-account",
      source: "(bundle, credential) => ({ sum: bundle.a + bundle.b, credential, title: document.title })",
      bundle: { a: 1, b: 2 },
      credential: { keyPrefix: "sk-", keyLastFour: "abcd" },
    }),
  );
  await attempt("scrapeClose", () =>
    bridge.invoke("scrape.closeConsole", { accountId: "flowlet-self-test-account" }),
  );
  await attempt("keyringSet", () =>
    bridge.invoke("keyring.set", { service: "Flowlet Self Test", username: "smoke", secret: "flowlet-smoke-secret" }),
  );
  await attempt("keyringGet", () =>
    bridge.invoke("keyring.get", { service: "Flowlet Self Test", username: "smoke" }),
  );
  await attempt("keyringDelete", () =>
    bridge.invoke("keyring.delete", { service: "Flowlet Self Test", username: "smoke" }),
  );
  await attempt("unknownChannel", () => bridge.invoke("platform.doesNotExist"));
  console.log(`FLOWLET_HOST_SELF_TEST=${JSON.stringify(results)}`);
  logger.info("host channel 自检完成", results);
}

/**
 * Windows 便携版 toast 的 AppUserModelID 注册（HG-3 的部分缓解）。
 *
 * 与 Rust `core/notification_registry.rs` 幂等对齐：写
 * `HKCU\Software\Classes\AppUserModelId\<aumid>` 的 DisplayName / IconUri，
 * 否则没有开始菜单快捷方式的便携版通知会被系统静默丢弃。非 Windows 或失败只告警。
 */
function registerWindowsAppUserModelId(): void {
  if (process.platform !== "win32") return;
  const aumid = "site.snewbie.flowlet";
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${aumid}`;
  const exe = app.getPath("exe");
  const entries: Array<[string, string]> = [
    ["DisplayName", "Flowlet"],
    ["IconUri", exe],
  ];
  for (const [name, value] of entries) {
    try {
      const result = spawnSync("reg", ["add", key, "/v", name, "/t", "REG_SZ", "/d", value, "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      if (result.status !== 0) {
        logger.warn("写入 AppUserModelID 失败", { name, code: result.status });
      }
    } catch (error) {
      logger.warn("写入 AppUserModelID 异常", {
        name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function createMainWindow(paths: DesktopPaths, webUrl: string, cli: CliOptions): BrowserWindow {
  const stored = loadWindowState(paths.dataDir);
  const win = new BrowserWindow({
    width: stored?.width ?? MIN_CONTENT_WIDTH,
    height: stored?.height ?? MIN_CONTENT_HEIGHT,
    x: stored?.x,
    y: stored?.y,
    minWidth: MIN_CONTENT_WIDTH,
    minHeight: MIN_CONTENT_HEIGHT,
    useContentSize: true,
    frame: false,
    show: false,
    title: "Flowlet",
    backgroundColor: "#0b0d12",
    webPreferences: {
      partition: MAIN_WINDOW_PARTITION,
      preload: join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.setMinimumSize(MIN_CONTENT_WIDTH, MIN_CONTENT_HEIGHT);
  win.webContents.setWindowOpenHandler(({ url }) => {
    // 与 Rust open_external_url 语义一致：外部链接交给系统浏览器，不开新窗口。
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void import("electron").then(({ shell }) => shell.openExternal(url));
    }
    return { action: "deny" };
  });
  win.webContents.on("did-fail-load", (_event, code, description, url) => {
    console.error(`页面加载失败 (${code}) ${description}: ${url}`);
  });
  win.webContents.on("did-finish-load", () => {
    console.log(`FLOWLET_WINDOW_LOADED=${webUrl}`);
  });
  void win.loadURL(`${webUrl}/`);
  return win;
}

function applyInitialWindowState(win: BrowserWindow, paths: DesktopPaths, cli: CliOptions): void {
  const stored = loadWindowState(paths.dataDir);
  setTimeout(() => {
    if (win.isDestroyed()) return;
    if (stored?.maximized === true) win.maximize();
    ensureWindowOnScreen(win, win.getBounds());
    if (cli.screenshotPath !== null) {
      win.showInactive();
      win.focus();
    }
  }, 400);
}

function createTray(
  paths: DesktopPaths,
  options: {
    showWindow: () => void;
    quit: () => void;
    openModeSettings: () => void;
    clientMode: boolean;
    remoteHost: string;
  },
  logger: DesktopLogger,
): Tray {
  const candidates = [
    join(paths.repoRoot, "src-tauri", "icons", "tray.png"),
    join(paths.runtimeRoot, "icons", "tray.png"),
    join(paths.runtimeRoot, "icons", "icon.png"),
  ];
  let image = nativeImage.createEmpty();
  for (const candidate of candidates) {
    const loaded = nativeImage.createFromPath(candidate);
    if (!loaded.isEmpty()) {
      image = loaded;
      break;
    }
  }
  if (image.isEmpty()) {
    // 无图标时 Tray 构造会失败；用一个 1x1 透明图兜底并记录缺口。
    image = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    );
    logger.warn("未找到托盘图标，使用透明占位图");
  }
  const tray = new Tray(image);
  tray.setToolTip(options.clientMode ? `Flowlet · 客户端模式（${options.remoteHost}）` : "Flowlet · 主机模式");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开主窗口", click: options.showWindow },
      {
        label: options.clientMode ? "运行模式（当前：客户端）…" : "运行模式（当前：主机）…",
        click: options.openModeSettings,
      },
      { type: "separator" },
      // 按要求：托盘不提供暂停代理入口，只有真正退出才停代理。
      { label: "退出 Flowlet", click: options.quit },
    ]),
  );
  tray.on("click", options.showWindow);
  return tray;
}

interface DesktopBootstrap {
  /** 管理凭据：主机模式=本机随机 token；客户端模式=远程管理凭据（token 模式）。 */
  adminToken: string;
  /** host / client，渲染进程据此决定加载桌面壳还是 Web 管理台界面。 */
  mode: "host" | "client";
  /** 客户端模式的远程管理台地址（仅展示/诊断用）。 */
  clientBaseUrl: string;
}

interface ModeIpcDeps {
  logger: DesktopLogger;
  /** 渲染进程请求打开「运行模式」窗口（客户端模式的设置页入口）。 */
  openSettings: () => void;
  closeSender: (event: Electron.IpcMainInvokeEvent) => void;
  loadState: () => {
    mode: "host" | "client";
    baseUrl: string;
    authKind: "token" | "session";
    hasToken: boolean;
    safeStorage: boolean;
    configPath: string;
  };
  loginRemote: (baseUrl: string) => Promise<{ ok: boolean; message: string }>;
  save: (payload: {
    mode: "host" | "client";
    baseUrl?: string;
    authKind?: "token" | "session";
    token?: string;
  }) => Promise<{ ok: boolean; message?: string }>;
}

/** 「运行模式」窗口的 IPC：读取配置、测试连接、SSO 登录、保存并重启。 */
function registerModeIpcHandlers(deps: ModeIpcDeps): void {
  const testRemote = async (payload: {
    baseUrl?: string;
    authKind?: "token" | "session";
    token?: string;
  }): Promise<{ ok: boolean; message: string }> => {
    let baseUrl: string;
    try {
      baseUrl = normalizeBaseUrl(String(payload.baseUrl ?? ""));
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    let health: Response;
    try {
      health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(8_000) });
    } catch (error) {
      return {
        ok: false,
        message: `无法连接远程主机：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!health.ok) return { ok: false, message: `远程主机健康检查失败（HTTP ${health.status}）` };

    const authKind = payload.authKind === "session" ? "session" : "token";
    if (authKind === "token") {
      const token = String(payload.token ?? "").trim();
      if (token === "") return { ok: false, message: "请填写管理凭据（token）" };
      try {
        const response = await fetch(`${baseUrl}/api/session`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(8_000),
        });
        if (response.status === 401) return { ok: false, message: "管理凭据无效，请确认 FLOWLET_ADMIN_TOKEN" };
        if (!response.ok) return { ok: false, message: `登录校验失败（HTTP ${response.status}）` };
        const body = (await response.json()) as { mode?: unknown };
        return { ok: true, message: `连接成功（${body.mode === "oidc" ? "OIDC" : "token"} 模式）` };
      } catch (error) {
        return {
          ok: false,
          message: `登录校验失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    const session = new RemoteSession({ baseUrl, logger: deps.logger });
    const status = await session.status();
    if (!status.authenticated) {
      return { ok: true, message: "主机可达，但尚未登录；请点「打开登录窗口」完成企业 SSO" };
    }
    return { ok: true, message: `连接成功，已登录（${status.identity ?? status.mode}）` };
  };

  ipcMain.handle("mode:open-settings", () => {
    deps.openSettings();
  });
  ipcMain.handle("mode:load", () => deps.loadState());
  ipcMain.handle("mode:test", async (_event, payload: unknown) =>
    testRemote((payload ?? {}) as { baseUrl?: string; authKind?: "token" | "session"; token?: string }),
  );
  ipcMain.handle("mode:login", async (_event, payload: unknown) => {
    const input = (payload ?? {}) as { baseUrl?: string };
    let baseUrl: string;
    try {
      baseUrl = normalizeBaseUrl(String(input.baseUrl ?? ""));
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    try {
      return await deps.loginRemote(baseUrl);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle("mode:save", async (_event, payload: unknown) =>
    deps.save((payload ?? {}) as Parameters<ModeIpcDeps["save"]>[0]),
  );
  ipcMain.handle("mode:close", (event) => {
    deps.closeSender(event);
  });
}

interface IpcDeps {
  getWindow: () => BrowserWindow | null;
  showWindow: () => void;
  saveState: () => void;
  quitApp: (reason: string) => Promise<void>;
  resize: { current: ResizeSession | null };
  logger: DesktopLogger;
  bootstrap: () => DesktopBootstrap;
}

function registerIpcHandlers(deps: IpcDeps): void {
  const fromMainWindow = (event: Electron.IpcMainInvokeEvent): BrowserWindow => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win === null || win !== deps.getWindow()) {
      throw new Error("拒绝来自非主窗口的 IPC 调用");
    }
    return win;
  };

  // preload 在页面脚本执行前同步取管理 token（避免 token 出现在进程 argv 里）。
  ipcMain.on("desktop:bootstrap", (event) => {
    event.returnValue = deps.bootstrap();
  });

  ipcMain.handle("window:minimize", (event) => {
    fromMainWindow(event).minimize();
  });
  ipcMain.handle("window:toggle-maximize", (event) => {
    const win = fromMainWindow(event);
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle("window:is-maximized", (event) => fromMainWindow(event).isMaximized());
  ipcMain.handle("window:close", (event) => {
    fromMainWindow(event).close();
  });
  ipcMain.handle("window:start-dragging", (event) => {
    const win = fromMainWindow(event);
    dragSession = {
      startCursor: screen.getCursorScreenPoint(),
      startBounds: win.getBounds(),
    };
  });
  ipcMain.handle("window:drag-move", (event, payload: { screenX?: unknown; screenY?: unknown }) => {
    fromMainWindow(event);
    if (dragSession === null) return;
    const win = deps.getWindow();
    if (win === null) return;
    const x = Number(payload?.screenX);
    const y = Number(payload?.screenY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    win.setPosition(
      Math.round(dragSession.startBounds.x + (x - dragSession.startCursor.x)),
      Math.round(dragSession.startBounds.y + (y - dragSession.startCursor.y)),
      false,
    );
  });
  ipcMain.handle("window:drag-end", (event) => {
    fromMainWindow(event);
    dragSession = null;
    deps.saveState();
  });

  const beginResize = (win: BrowserWindow, direction: ResizeDirection, cursor?: { x: number; y: number }): void => {
    deps.resize.current = {
      direction,
      startCursor: cursor ?? screen.getCursorScreenPoint(),
      startBounds: win.getBounds(),
    };
  };
  ipcMain.handle("window:start-resize-dragging", (event, direction: unknown) => {
    const win = fromMainWindow(event);
    if (!isResizeDirection(direction)) throw new Error(`无效的缩放方向：${String(direction)}`);
    beginResize(win, direction);
  });
  ipcMain.handle(
    "window:resize-begin",
    (event, payload: { edge?: unknown; direction?: unknown; screenX?: unknown; screenY?: unknown }) => {
      const win = fromMainWindow(event);
      const raw = payload?.direction ?? payload?.edge;
      if (!isResizeDirection(raw)) throw new Error(`无效的缩放方向：${String(raw)}`);
      const x = Number(payload?.screenX);
      const y = Number(payload?.screenY);
      beginResize(
        win,
        raw,
        Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined,
      );
    },
  );
  ipcMain.handle("window:resize-move", (event, payload: { screenX?: unknown; screenY?: unknown }) => {
    fromMainWindow(event);
    applyResize(deps.resize.current, deps.getWindow(), payload?.screenX, payload?.screenY);
  });
  ipcMain.handle("window:resize-end", (event) => {
    fromMainWindow(event);
    deps.resize.current = null;
    deps.saveState();
  });
  // Tauri plugin-dialog 兼容 shim：src/pages/settings/tabs/SyncTab.tsx 仍静态 import
  // @tauri-apps/plugin-dialog。只放行 open/save 两个命令，避免把通用 invoke 暴露给渲染进程。
  ipcMain.handle("tauri:compat-invoke", async (event, command: unknown, args: unknown) => {
    fromMainWindow(event);
    if (command !== "plugin:dialog|open" && command !== "plugin:dialog|save") {
      throw new Error(`不允许的 Tauri 兼容命令：${String(command)}`);
    }
    const options = (args as { options?: Record<string, unknown> } | null)?.options ?? {};
    if (command === "plugin:dialog|open") {
      const result = await dialog.showOpenDialog({
        title: typeof options["title"] === "string" ? options["title"] : undefined,
        defaultPath: typeof options["defaultPath"] === "string" ? options["defaultPath"] : undefined,
        properties: [
          ...(options["directory"] === true ? (["openDirectory"] as const) : (["openFile"] as const)),
          ...(options["multiple"] === true ? (["multiSelections"] as const) : []),
        ],
        filters: normalizeDialogFilters(options["filters"]),
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return options["multiple"] === true ? result.filePaths : result.filePaths[0];
    }
    const result = await dialog.showSaveDialog({
      title: typeof options["title"] === "string" ? options["title"] : undefined,
      defaultPath: typeof options["defaultPath"] === "string" ? options["defaultPath"] : undefined,
      filters: normalizeDialogFilters(options["filters"]),
    });
    return result.canceled ? null : (result.filePath ?? null);
  });
  ipcMain.handle("platform:open-external", async (event, url: unknown) => {
    fromMainWindow(event);
    if (typeof url !== "string") throw new Error("openExternal 参数必须是字符串");
    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new Error("openExternal 仅允许 http/https URL");
    }
    const { shell } = await import("electron");
    await shell.openExternal(target.toString());
  });
}

let dragSession: { startCursor: { x: number; y: number }; startBounds: Rectangle } | null = null;

function normalizeDialogFilters(raw: unknown): { name: string; extensions: string[] }[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const filters: { name: string; extensions: string[] }[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const name = (item as { name?: unknown }).name;
    const extensions = (item as { extensions?: unknown }).extensions;
    if (typeof name !== "string" || !Array.isArray(extensions)) continue;
    filters.push({
      name,
      extensions: extensions.filter((ext): ext is string => typeof ext === "string" && ext !== ""),
    });
  }
  return filters.length === 0 ? undefined : filters;
}

function isResizeDirection(value: unknown): value is ResizeDirection {
  return (
    value === "East" ||
    value === "North" ||
    value === "NorthEast" ||
    value === "NorthWest" ||
    value === "South" ||
    value === "SouthEast" ||
    value === "SouthWest" ||
    value === "West"
  );
}

function applyResize(
  session: ResizeSession | null,
  win: BrowserWindow | null,
  rawX: unknown,
  rawY: unknown,
): void {
  if (session === null || win === null) return;
  const x = Number(rawX);
  const y = Number(rawY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const dx = x - session.startCursor.x;
  const dy = y - session.startCursor.y;
  const start = session.startBounds;
  let left = start.x;
  let top = start.y;
  let width = start.width;
  let height = start.height;
  const dir = session.direction;
  if (dir.includes("East")) width = start.width + dx;
  if (dir.includes("West")) {
    width = start.width - dx;
    left = start.x + dx;
  }
  if (dir.includes("South")) height = start.height + dy;
  if (dir.includes("North")) {
    height = start.height - dy;
    top = start.y + dy;
  }
  // 最小客户区：frame:false 时外框≈客户区，直接用 1200×720 约束。
  if (width < MIN_CONTENT_WIDTH) {
    if (dir.includes("West")) left = start.x + start.width - MIN_CONTENT_WIDTH;
    width = MIN_CONTENT_WIDTH;
  }
  if (height < MIN_CONTENT_HEIGHT) {
    if (dir.includes("North")) top = start.y + start.height - MIN_CONTENT_HEIGHT;
    height = MIN_CONTENT_HEIGHT;
  }
  win.setBounds({ x: Math.round(left), y: Math.round(top), width: Math.round(width), height: Math.round(height) }, false);
}

async function runScreenshotMode(
  win: BrowserWindow,
  target: string,
  webUrl: string,
  waitMs: number,
  logger: DesktopLogger,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let uiReady = false;
  while (Date.now() < deadline) {
    try {
      uiReady = Boolean(
        await win.webContents.executeJavaScript(
          `document.body !== null && (document.body.innerText.includes("渠道账号") || document.body.innerText.includes("Flowlet") || document.body.innerText.includes("登录"))`,
          true,
        ),
      );
    } catch {
      uiReady = false;
    }
    if (uiReady) break;
    await delay(250);
  }
  if (!uiReady) logger.warn("截图前未检测到期望 UI 文本，仍尝试捕获");
  try {
    const probe = (await win.webContents.executeJavaScript(
      `({
        title: document.title,
        textLength: document.body?.innerText?.length ?? 0,
        textHead: (document.body?.innerText ?? "").replace(/\\s+/g, " ").slice(0, 160),
        hasDesktopBridge: typeof window.flowletDesktop === "object" && window.flowletDesktop !== null,
        adminTokenLength: typeof window.flowletDesktop?.adminToken === "string" ? window.flowletDesktop.adminToken.length : 0,
      })`,
      true,
    )) as {
      title?: unknown;
      textLength?: unknown;
      textHead?: unknown;
      hasDesktopBridge?: unknown;
      adminTokenLength?: unknown;
    };
    console.log(`FLOWLET_UI_TITLE=${String(probe.title ?? "")}`);
    console.log(`FLOWLET_UI_TEXT_LENGTH=${String(probe.textLength ?? 0)}`);
    console.log(`FLOWLET_UI_TEXT_HEAD=${String(probe.textHead ?? "")}`);
    console.log(`FLOWLET_DESKTOP_BRIDGE=${probe.hasDesktopBridge === true ? "present" : "missing"}`);
    console.log(`FLOWLET_ADMIN_TOKEN_LENGTH=${String(probe.adminTokenLength ?? 0)}`);
  } catch (error) {
    logger.warn("读取 UI 证据失败", { error: error instanceof Error ? error.message : String(error) });
  }
  await delay(waitMs);
  win.showInactive();
  await delay(600);
  let image = await win.webContents.capturePage();
  if (image.isEmpty()) {
    await delay(800);
    image = await win.webContents.capturePage();
  }
  if (image.isEmpty()) throw new Error("capturePage 返回空图像（无 GPU/显示服务器限制）");
  writeFileSync(target, image.toPNG());
  const size = image.getSize();
  console.log(`FLOWLET_SCREENSHOT=${target} ${size.width}x${size.height}`);
  console.log(`FLOWLET_SCREENSHOT_URL=${webUrl}`);
  logger.info("已保存窗口截图", { target, width: size.width, height: size.height });
}


/** 逐路由冒烟默认路由（HashRouter path，与 src/app/router.tsx 一一对应）。 */
const DEFAULT_PAGE_ROUTES: readonly string[] = [
  "/overview",
  "/models",
  "/logs",
  "/credentials",
  "/sessions",
  "/usage",
  "/usage-analysis",
  "/settings",
];

interface RouteProbeResult {
  route: string;
  ok: boolean;
  hash: string;
  title: string;
  mainTextLength: number;
  mainTextHead: string;
  consoleErrors: string[];
  commandFailures: string[];
  screenshot: string | null;
}

/**
 * 逐路由冒烟：依次切换 HashRouter 路由，采集页面正文、console error 与失败命令，
 * 并逐页截图。用于迁移期「每个桌面页面都能在 Electron 里真正渲染」的回归门禁。
 */
async function runPagesMode(
  win: BrowserWindow,
  webUrl: string,
  targetDir: string,
  routes: readonly string[],
  waitMs: number,
  logger: DesktopLogger,
): Promise<void> {
  mkdirSync(targetDir, { recursive: true });
  const baseUrl = webUrl.replace(/\/+$/, "");
  const perRoute: RouteProbeResult[] = [];
  let currentRoute = "/";
  let consoleErrors: string[] = [];
  let commandFailures: string[] = [];

  win.webContents.session.webRequest.onCompleted({ urls: ["*://*/api/commands/*"] }, (details) => {
    if (details.statusCode >= 400) {
      commandFailures.push(`${details.method} ${details.url} -> ${details.statusCode}`);
    }
  });
  win.webContents.session.webRequest.onErrorOccurred({ urls: ["*://*/api/commands/*"] }, (details) => {
    commandFailures.push(`${details.method} ${details.url} -> ${details.error}`);
  });
  win.webContents.on("console-message", (details) => {
    if (details.level === "error") {
      consoleErrors.push(details.message);
    }
  });

  // 等首屏渲染完成再开始逐路由切换，避免把首屏的慢查询算到第一个路由头上。
  const firstDeadline = Date.now() + 30_000;
  while (Date.now() < firstDeadline) {
    const ready = await win.webContents
      .executeJavaScript(
        `document.body !== null && (document.body.innerText.includes("渠道账号") || document.body.innerText.includes("Flowlet"))`,
        true,
      )
      .catch(() => false);
    if (ready === true) break;
    await delay(250);
  }

  win.showInactive();
  await delay(300);

  for (const route of routes) {
    currentRoute = route;
    consoleErrors = [];
    commandFailures = [];
    const targetHash = `#${route.startsWith("/") ? route : `/${route}`}`;
    await win.webContents
      .executeJavaScript(`location.hash = ${JSON.stringify(targetHash)}; true`, true)
      .catch(() => undefined);
    // 等路由切换后的正文渲染（有 Suspense 懒加载）。最多等 waitMs + 6s。
    const routeDeadline = Date.now() + waitMs + 6_000;
    let mainTextLength = 0;
    while (Date.now() < routeDeadline) {
      const probe = (await win.webContents
        .executeJavaScript(
          `(() => {
             const main = document.querySelector("main");
             const text = (main?.innerText ?? document.body?.innerText ?? "").replace(/\\s+/g, " ").trim();
             return { length: text.length, head: text.slice(0, 220) };
           })()`,
          true,
        )
        .catch(() => ({ length: 0, head: "" }))) as { length?: number; head?: string };
      mainTextLength = Number(probe.length ?? 0);
      if (mainTextLength > 40) break;
      await delay(200);
    }
    await delay(waitMs);
    const probe = (await win.webContents
      .executeJavaScript(
        `({
           hash: location.hash,
           title: document.title,
           textLength: (document.querySelector("main")?.innerText ?? "").replace(/\\s+/g, " ").trim().length,
           textHead: (document.querySelector("main")?.innerText ?? document.body?.innerText ?? "").replace(/\\s+/g, " ").trim().slice(0, 220),
         })`,
        true,
      )
      .catch(() => ({ hash: "", title: "", textLength: 0, textHead: "" }))) as {
      hash?: unknown;
      title?: unknown;
      textLength?: unknown;
      textHead?: unknown;
    };
    const slug = route === "/" ? "index" : route.replace(/^\//, "").replace(/[^a-z0-9-]/gi, "_");
    const target = join(targetDir, `${slug}.png`);
    win.showInactive();
    await delay(200);
    let image = await win.webContents.capturePage();
    if (image.isEmpty()) {
      await delay(800);
      image = await win.webContents.capturePage();
    }
    if (!image.isEmpty()) {
      writeFileSync(target, image.toPNG());
    }
    const result: RouteProbeResult = {
      route,
      ok: consoleErrors.length === 0 && commandFailures.length === 0 && Number(probe.textLength ?? 0) > 0,
      hash: String(probe.hash ?? ""),
      title: String(probe.title ?? ""),
      mainTextLength: Number(probe.textLength ?? 0) || mainTextLength,
      mainTextHead: String(probe.textHead ?? ""),
      consoleErrors: [...consoleErrors],
      commandFailures: [...commandFailures],
      screenshot: image.isEmpty() ? null : target,
    };
    perRoute.push(result);
    console.log(
      `FLOWLET_PAGE route=${route} ok=${result.ok} hash=${result.hash} text=${result.mainTextLength} consoleErrors=${consoleErrors.length} commandFailures=${commandFailures.length}`,
    );
    if (consoleErrors.length > 0) console.log(`FLOWLET_PAGE_CONSOLE_ERRORS ${route}: ${consoleErrors.join(" | ")}`);
    if (commandFailures.length > 0) console.log(`FLOWLET_PAGE_COMMAND_FAILURES ${route}: ${commandFailures.join(" | ")}`);
  }

  const report = {
    webUrl: baseUrl,
    routes: perRoute,
    failures: perRoute.filter((item) => !item.ok).length,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(join(targetDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`FLOWLET_PAGES_REPORT=${join(targetDir, "report.json")}`);
  console.log(`FLOWLET_PAGES_SUMMARY=${perRoute.length - report.failures}/${perRoute.length} ok`);
  logger.info("逐路由冒烟完成", { targetDir, failures: report.failures });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}