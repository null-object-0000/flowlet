// Flowlet Node host entry point — behavioural replacement for the Rust
// `headless` binary (src-tauri/src/bin/headless.rs). Owner: lead.
//
// 启动顺序必须与 Rust 一致：凭据校验 → DB/配置 → presets → bind config →
// 自动 start_proxy → 静态目录校验 → 启动 Web 服务 → 后台任务 → 信号优雅退出。
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeviceIdentity, HostOptions, ProxyBindConfig } from "./types.ts";
import {
  channelsConfigToJson,
  loadChannelsConfig,
  loadOrCreateConfig,
  loadRuntimeSnapshot,
  loadUpstreamProxyConfig,
  upstreamProxyIsActive,
} from "./config/index.ts";
import { loadModelCatalog } from "./catalog/index.ts";
import { SqliteStorage } from "./storage/index.ts";
import { createProxyController } from "./proxy/index.ts";
import { createWebHost } from "./web/index.ts";
import { AdminAuth } from "./web/auth.ts";
import { openAdminSessionStore } from "./web/session-store.ts";
import { createHostScheduler } from "./host/scheduler.ts";
import { SecretBox } from "./storage/secret-box.ts";
import {
  currentOsFamily,
  detectPlatform,
  resolveDeviceDisplayName,
  resolvePlatform,
} from "./storage/devices.ts";

/** 与 Rust core/device_identity.rs 一致。 */
const DEVICE_IDENTITY_SCHEMA_VERSION = 1;

// 仓库根：本文件位于 <repo>/packages/flowlet-core/src/index.ts，上溯三级即仓库根。
// 必须用 fileURLToPath（中文/空格路径时 pathname 是 percent-encoded）。
const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function envOr(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

/** 进程退出相关的默认值：宽限 1s 让短请求收尾，5s 硬超时兜底。 */
const DEFAULT_SHUTDOWN_ABORT_MS = 250;
const DEFAULT_HARD_EXIT_MS = 2000;

function readNonNegativeMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

/** 与 Rust headless 完全一致的 env → HostOptions 解析。 */
export function readHostOptions(env: NodeJS.ProcessEnv = process.env): HostOptions {
  // 管理端凭据校验由 AdminAuth.from_env() 负责（与 Rust 一致：token 模式 ≥24 字符；
  // OIDC 模式可空，仅 ALLOW_TOKEN_LOGIN 启用时才要求）。
  const adminToken = (env.FLOWLET_ADMIN_TOKEN ?? "").trim();
  const dbPath = resolve(envOr("FLOWLET_DB_PATH", "flowlet-data/flowlet.sqlite"));
  const dataDir = dirname(dbPath);
  mkdirSync(dataDir, { recursive: true });
  const configPath = resolve(envOr("FLOWLET_CONFIG_PATH", join(dataDir, "config.json")));
  const catalogDir = resolve(envOr("FLOWLET_CATALOG_DIR", dataDir));
  return {
    dbPath,
    configPath,
    catalogDir,
    staticDir: resolve(envOr("FLOWLET_STATIC_DIR", "dist-web")),
    adminToken,
    clientToken: (env.FLOWLET_CLIENT_TOKEN ?? "").trim(),
    bindAddr: envOr("FLOWLET_BIND_ADDR", "127.0.0.1:18640"),
    webAddr: envOr("FLOWLET_WEB_ADDR", "127.0.0.1:8080"),
    publicProxyUrl: env.FLOWLET_PUBLIC_PROXY_URL ?? "",
  };
}

/** 版本号：优先环境变量，其次仓库 package.json，最后 unknown（镜像里可 COPY）。 */
function resolveAppVersion(): string {
  const fromEnv = (process.env.FLOWLET_APP_VERSION ?? "").trim();
  if (fromEnv) return fromEnv;
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version?: string };
    if (typeof pkg.version === "string" && pkg.version.trim()) return pkg.version.trim();
  } catch {
    /* 忽略：镜像里可能没有 package.json */
  }
  return "unknown";
}

/**
 * 设备身份持久化在数据卷，重启后 device_id 不变。
 *
 * 文件格式严格对齐 Rust `core/device_identity.rs`：该结构体是
 * `#[serde(rename_all = "camelCase")]`，即磁盘上是
 * `{ schemaVersion, deviceId, createdAt, displayName, platform }`；
 * 进程内统一用 snake_case，读写时做一次映射。这样 Rust 镜像与 Node 镜像
 * 可以共用同一个 `/data` 卷来回切换。
 */
interface SerializedDeviceIdentity {
  schemaVersion: number;
  deviceId: string;
  createdAt: string;
  displayName: string;
  platform: string;
}

function readDeviceIdentityFile(file: string): DeviceIdentity | null {
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<SerializedDeviceIdentity>;
  if (raw.schemaVersion !== DEVICE_IDENTITY_SCHEMA_VERSION) {
    throw new Error(`设备身份文件版本不受支持：${String(raw.schemaVersion)}`);
  }
  const deviceId = String(raw.deviceId ?? "");
  const platform = String(raw.platform ?? "");
  return {
    schema_version: DEVICE_IDENTITY_SCHEMA_VERSION,
    device_id: deviceId,
    created_at: String(raw.createdAt ?? new Date().toISOString()),
    display_name: String(raw.displayName ?? ""),
    platform,
  };
}

function writeDeviceIdentityFile(file: string, identity: DeviceIdentity): void {
  const serialized: SerializedDeviceIdentity = {
    schemaVersion: identity.schema_version,
    deviceId: identity.device_id,
    createdAt: identity.created_at,
    displayName: identity.display_name,
    platform: identity.platform,
  };
  writeFileSync(file, `${JSON.stringify(serialized, null, 2)}\n`);
}

function loadOrCreateDeviceIdentity(dataDir: string): DeviceIdentity {
  const file = join(dataDir, "flowlet-device.json");
  const appVersion = resolveAppVersion();
  const existing = readDeviceIdentityFile(file);
  const detected = detectPlatform();
  if (existing) {
    existing.platform = resolvePlatform(existing.platform, detected, currentOsFamily());
    existing.app_version = appVersion;
    return existing;
  }
  const deviceId = randomUUID();
  const identity: DeviceIdentity = {
    schema_version: DEVICE_IDENTITY_SCHEMA_VERSION,
    device_id: deviceId,
    created_at: new Date().toISOString(),
    display_name: resolveDeviceDisplayName("", detected, deviceId),
    platform: detected,
    app_version: appVersion,
  };
  writeDeviceIdentityFile(file, identity);
  return identity;
}

function parseAddr(addr: string): { host: string; port: number } {
  const idx = addr.lastIndexOf(":");
  if (idx <= 0) throw new Error(`无效监听地址：${addr}`);
  return { host: addr.slice(0, idx), port: Number(addr.slice(idx + 1)) };
}

export async function startHost(
  options: HostOptions,
): Promise<{ close(): Promise<void>; webAddr: string }> {
  const dataDir = dirname(options.dbPath);
  // 管理端 OIDC 会话持久化：容器重启/升级不再让所有管理台登录失效（token 模式不产生会话）。
  const sessionStore = openAdminSessionStore(join(dataDir, "admin-sessions.json"));
  // 与 Rust headless 顺序一致：先解析管理端鉴权配置（配置错误在打开数据库之前失败）。
  const auth = AdminAuth.fromEnv(process.env, undefined, sessionStore);
  const deviceIdentity = loadOrCreateDeviceIdentity(dataDir);
  // 三方服务凭据的静态加密密钥：secret.key 随数据卷（Docker /data）持久化。
  const secrets = SecretBox.loadOrCreate(dataDir);
  const configJson = loadOrCreateConfig(options.configPath, join(REPO_ROOT, "config.json"));
  const channelsConfig = loadChannelsConfig(configJson);
  // Web 命令层必须拿到与代理/运行时同一份「已合并内置模板」的渠道配置：数据卷里的
  // config.json 可能早于当前版本，缺渠道会让 fetch_channel_models / query_balance 失败。
  const webChannelsConfig = channelsConfigToJson(channelsConfig);

  const storage = new SqliteStorage(options.dbPath);
  // 上游代理配置必须在构建运行时快照之前读取：账号 use_upstream_proxy 的迁移依赖它。
  const upstreamProxy = loadUpstreamProxyConfig(storage, configJson);
  const runtimeConfig = loadRuntimeSnapshot(storage, channelsConfig, {
    upstreamProxyActive: upstreamProxyIsActive(upstreamProxy),
  });

  // bind config: 数据卷优先于 config.json 默认值；client token 缺失时生成并持久化。
  const socket = parseAddr(options.bindAddr);
  const saved = storage.getAppMeta("proxy_bind_config");
  const savedBind: ProxyBindConfig | null = saved ? (JSON.parse(saved) as ProxyBindConfig) : null;
  const current = savedBind?.default_client_token ?? "";
  const clientToken =
    options.clientToken ||
    (current && current !== "flowlet-local-token" ? current : randomUUID());
  const staticAdminToken = auth.staticToken();
  if (staticAdminToken !== null && staticAdminToken === clientToken) {
    throw new Error("管理凭据与模型调用密钥必须不同");
  }
  const bindConfig: ProxyBindConfig = {
    host: socket.host,
    port: socket.port,
    allow_lan: !(socket.host === "127.0.0.1" || socket.host === "::1" || socket.host === "localhost"),
    default_client_token: clientToken,
  };
  storage.setAppMeta("proxy_bind_config", JSON.stringify(bindConfig));

  const catalog = loadModelCatalog(options.catalogDir, REPO_ROOT);
  // 与 Rust FlowletServices::open 一致：启动时按 model-catalog + models-cn/dev + config 覆盖
  // 重建价格表，供 proxy 的 usage 成本估算与 Web 用量页使用。
  storage.rebuildPriceTable(options.catalogDir, configJson);
  const proxy = createProxyController({
    storage,
    catalog,
    runtimeConfig,
    clientToken,
    bindConfig,
    configPath: options.configPath,
    shutdownAbortMs: readNonNegativeMs(process.env.FLOWLET_SHUTDOWN_ABORT_MS, DEFAULT_SHUTDOWN_ABORT_MS),
  });
  await proxy.start();

  if (!existsSync(join(options.staticDir, "index.html"))) {
    await proxy.stop();
    throw new Error("找不到 Web 界面，请运行 npm run build:web 或设置 FLOWLET_STATIC_DIR");
  }

  const web = createWebHost({
    storage,
    proxy,
    runtimeConfig,
    bindConfig,
    catalogDir: options.catalogDir,
    configPath: options.configPath,
    channelsConfig: webChannelsConfig,
    adminToken: options.adminToken,
    auth,
    secrets,
    clientToken,
    staticDir: options.staticDir,
    publicProxyUrl: options.publicProxyUrl,
    deviceIdentity,
    // 桌面（Electron）宿主：命令面升级为桌面超集。Web Host / Docker 为 undefined。
    desktop: options.desktop,
  });
  await web.listen(options.webAddr);
  // 桌面宿主用 127.0.0.1:0 让系统分配端口，必须回传真实监听地址（Web/Docker 也返回同一格式）。
  const bound = web.address();
  const webAddr = bound === null ? options.webAddr : `${bound.host}:${bound.port}`;

  // 与 Rust headless 一致的后台维护：余额(5m) / 存储清理(15m) / 目录同步(1h)。
  // 冒烟/对拍/单测可设 FLOWLET_DISABLE_BACKGROUND_TASKS=1 关闭，避免用真实凭据
  // 向真实上游发起余额请求。
  const disableBackgroundTasks = process.env.FLOWLET_DISABLE_BACKGROUND_TASKS === "1";
  const scheduler = disableBackgroundTasks
    ? null
    : createHostScheduler({ context: web.context });
  scheduler?.start();

  let closing = false;
  let signalled = false;
  let signalledAt = 0;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    const startedMs = Date.now();
    const stopScheduler = scheduler?.stop();
    const schedulerMs = Date.now() - startedMs;
    await web.close();
    const webMs = Date.now() - startedMs - schedulerMs;
    // dispose 而不是 stop：Docker 升级时容器 stop 不能等长 SSE 自然结束，
    // 否则 stop_grace_period（30s）就是使用端的停机时间。
    await proxy.dispose();
    const proxyMs = Date.now() - startedMs - schedulerMs - webMs;
    await stopScheduler;
    storage.close();
    const storageMs = Date.now() - startedMs - schedulerMs - webMs - proxyMs;
    console.log(
      `关闭阶段耗时：web ${webMs}ms / proxy ${proxyMs}ms / storage ${storageMs}ms / 合计 ${Date.now() - startedMs}ms`,
    );
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    // 第二次信号 = 立即退出（运维手动 kill 时不用再等）。
    if (signalled) {
      console.error(`Flowlet Node Host 收到第二个 ${signal}，立即退出`);
      process.exit(0);
    }
    signalled = true;
    signalledAt = Date.now();
    console.log(`Flowlet Node Host 收到 ${signal}，开始优雅关闭`);
    const hardExitMs = readNonNegativeMs(process.env.FLOWLET_SHUTDOWN_HARD_EXIT_MS, DEFAULT_HARD_EXIT_MS);
    const hardExit = setTimeout(() => {
      console.error(`Flowlet Node Host 关闭超过 ${hardExitMs}ms，强制退出`);
      process.exit(0);
    }, hardExitMs);
    hardExit.unref?.();
    void close().then(
      () => {
        console.log(`关闭完成：收到 ${signal} 到进程退出 ${Date.now() - signalledAt}ms`);
        process.exit(0);
      },
      (error: unknown) => {
        console.error("Flowlet Node Host 关闭异常：", error instanceof Error ? error.message : error);
        process.exit(0);
      },
    );
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  return { close, webAddr };
}

if (import.meta.main ?? process.argv[1]?.endsWith("/index.ts")) {
  startHost(readHostOptions())
    .then(() => {
      // 监听地址由 web/proxy 模块打印
    })
    .catch((error: unknown) => {
      console.error("Flowlet Node Host 启动失败：", error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
