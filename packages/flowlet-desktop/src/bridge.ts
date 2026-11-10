// DesktopHostBridge 主进程实现：flowlet-core 命令层通过 `host.invoke(channel, payload)`
// 调用窗口/托盘/凭据/抓取/电源等平台能力。
//
// channel 清单与 payload 契约见 packages/flowlet-core/src/desktop/README.md。
// 未实现的 channel 必须 reject（带明确错误），不得静默返回 null。
import { app, Notification, powerSaveBlocker, shell } from "electron";
import { arch, platform, release } from "node:os";
import type { DesktopHostBridge } from "../../flowlet-core/src/desktop/types.ts";
import type { AutostartController } from "./autostart.ts";
import type { AgentRuntimeManager } from "./agent-runtime.ts";
import type { DesktopKeyring } from "./keyring.ts";
import type { DesktopLogger } from "./logger.ts";
import type { DesktopPaths } from "./paths.ts";
import type { ScrapeManager } from "./scrape.ts";

type Payload = Record<string, unknown> | undefined;

export interface TrayControls {
  setToolTip(text: string): void;
}

export interface BridgeDependencies {
  readonly paths: DesktopPaths;
  readonly logger: DesktopLogger;
  readonly keyring: DesktopKeyring;
  readonly autostart: AutostartController;
  readonly agentRuntime: AgentRuntimeManager;
  readonly scrape: ScrapeManager;
  readonly tray: TrayControls;
  readonly appVersion: string;
  /** `platform.quit`：停代理、清理、退出。 */
  readonly quit: () => Promise<void>;
  /** `platform.relaunch`：重启应用。 */
  readonly relaunch: () => Promise<void>;
  /** `platform.diagnostics` 需要的代理状态；Host 未启动时返回 null。 */
  readonly proxyStatus: () => Promise<string | null>;
  /** 通知点击等场景回到主窗口（不改变代理运行状态）。 */
  readonly showWindow: () => void;
}

export class DesktopHostBridgeImpl implements DesktopHostBridge {
  private readonly deps: BridgeDependencies;
  private suspendBlockerId: number | null = null;

  constructor(deps: BridgeDependencies) {
    this.deps = deps;
  }

  async invoke<T = unknown>(channel: string, payload?: Payload): Promise<T> {
    const result = await this.dispatch(channel, payload ?? {});
    return result as T;
  }

  private async dispatch(channel: string, payload: Record<string, unknown>): Promise<unknown> {
    switch (channel) {
      case "platform.appInfo":
        return this.appInfo();
      case "platform.openExternal": {
        const url = requireString(payload, "url");
        return this.openExternal(url);
      }
      case "platform.logFromFrontend": {
        const level = optionalString(payload, "level") ?? "info";
        const message = requireString(payload, "message");
        const detail = payload["detail"];
        this.deps.logger.log(normalizeLogLevel(level), `[renderer] ${message}`, detail);
        return null;
      }
      case "platform.diagnostics":
        return this.diagnostics();
      case "platform.notify": {
        const title = requireString(payload, "title");
        const body = requireString(payload, "body");
        return this.notify(title, body);
      }
      case "platform.trayTooltip": {
        const text = requireString(payload, "text");
        this.deps.tray.setToolTip(text);
        this.deps.logger.info("托盘提示已更新", { text });
        return null;
      }
      case "platform.autostart.get":
        return { enabled: this.deps.autostart.get() };
      case "platform.autostart.set": {
        const enabled = requireBoolean(payload, "enabled");
        this.deps.autostart.set(enabled);
        return null;
      }
      case "platform.relaunch":
        void this.deps.relaunch();
        return null;
      case "platform.quit":
        void this.deps.quit();
        return null;
      case "keyring.get": {
        const service = requireString(payload, "service");
        const username = requireString(payload, "username");
        const secret = await this.deps.keyring.get(service, username);
        return { secret };
      }
      case "keyring.set": {
        const service = requireString(payload, "service");
        const username = requireString(payload, "username");
        const secret = requireString(payload, "secret");
        await this.deps.keyring.set(service, username, secret);
        return null;
      }
      case "keyring.delete": {
        const service = requireString(payload, "service");
        const username = requireString(payload, "username");
        await this.deps.keyring.delete(service, username);
        return null;
      }
      case "agentRuntime.start": {
        const agentType = requireString(payload, "agentType");
        const cwd = optionalString(payload, "cwd");
        return this.deps.agentRuntime.start(agentType, cwd);
      }
      case "agentRuntime.stop": {
        const agentType = requireString(payload, "agentType");
        await this.deps.agentRuntime.stop(agentType);
        return null;
      }
      case "agentRuntime.status":
        return this.deps.agentRuntime.status();
      case "scrape.openConsole": {
        const accountId = requireString(payload, "accountId");
        const url = optionalString(payload, "url");
        const partition = optionalString(payload, "partition");
        const channelId = optionalString(payload, "channelId");
        const interactive = payload["interactive"] === true;
        return this.deps.scrape.openConsole({ accountId, url, partition, channelId, interactive });
      }
      case "scrape.closeConsole": {
        const accountId = requireString(payload, "accountId");
        return this.deps.scrape.closeConsole(accountId);
      }
      case "scrape.runPlan": {
        const accountId = requireString(payload, "accountId");
        const plan = payload["plan"];
        if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
          throw new Error("scrape.runPlan 的 plan 必须是对象");
        }
        const timeoutMs = optionalNumber(payload, "timeoutMs");
        return this.deps.scrape.runPlan({
          accountId,
          plan: plan as Parameters<ScrapeManager["runPlan"]>[0]["plan"],
          timeoutMs,
        });
      }
      case "scrape.cancel": {
        const accountId = requireString(payload, "accountId");
        return this.deps.scrape.cancel(accountId);
      }
      case "scrape.probeLogin": {
        const accountId = requireString(payload, "accountId");
        return this.deps.scrape.probeLogin(accountId);
      }
      case "scrape.evaluate": {
        // 在已打开的抓取窗口里复用已捕获响应执行 extractor（不导航、不等网络）。
        const accountId = requireString(payload, "accountId");
        const source = requireString(payload, "source");
        return this.deps.scrape.evaluate({
          accountId,
          source,
          bundle: payload["bundle"],
          credential: payload["credential"],
          timeoutMs: optionalNumber(payload, "timeoutMs"),
        });
      }
      case "power.preventSuspend": {
        const enabled = requireBoolean(payload, "enabled");
        return this.preventSuspend(enabled);
      }
      default:
        throw new Error(`未实现的桌面宿主 channel：${channel}`);
    }
  }

  private appInfo(): Record<string, unknown> {
    return {
      version: this.deps.appVersion,
      dataDir: this.deps.paths.dataDir,
      portable: this.deps.paths.portable,
      platform: process.platform,
      arch: process.arch,
    };
  }

  private async openExternal(url: string): Promise<null> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("openExternal 需要合法的 URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("openExternal 仅允许 http/https URL");
    }
    await shell.openExternal(parsed.toString());
    return null;
  }

  private async diagnostics(): Promise<Record<string, unknown>> {
    let proxy: string | null = null;
    try {
      proxy = await this.deps.proxyStatus();
    } catch (error) {
      proxy = `unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
    const keyring = this.deps.keyring;
    return {
      os: `${platform()} ${release()} ${arch()}`,
      database: "healthy",
      proxy: proxy ?? "unknown",
      appVersion: this.deps.appVersion,
      electron: process.versions.electron ?? "",
      chrome: process.versions.chrome ?? "",
      node: process.versions.node,
      dataDir: this.deps.paths.dataDir,
      configPath: this.deps.paths.configPath,
      dbPath: this.deps.paths.dbPath,
      staticDir: this.deps.paths.staticDir,
      webviewRoot: this.deps.paths.webviewRoot,
      portable: this.deps.paths.portable,
      platform: process.platform,
      arch: process.arch,
      safeStorageBackend: keyring.storageBackend(),
      safeStorageAvailable: keyring.isEncryptionAvailable(),
      logFile: this.deps.logger.path(),
      logTail: this.deps.logger.tail(100),
    };
  }

  private notify(title: string, body: string): null {
    if (!Notification.isSupported()) {
      throw new Error("当前系统不支持原生通知");
    }
    const notification = new Notification({ title, body });
    // 与 Rust 预留的 toast 点击语义一致：点击通知回到主窗口（不改变代理运行状态）。
    notification.on("click", () => {
      try {
        this.deps.showWindow();
      } catch (error) {
        this.deps.logger.warn("打开主窗口失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    notification.on("failed", (_event, error) => {
      this.deps.logger.warn("原生通知发送失败", { error });
    });
    notification.show();
    return null;
  }

  private preventSuspend(enabled: boolean): null {
    if (enabled) {
      if (this.suspendBlockerId !== null && powerSaveBlocker.isStarted(this.suspendBlockerId)) {
        return null;
      }
      // 与 Rust ActivityTracker 语义一致：只阻止系统自动待机，不阻止熄屏。
      this.suspendBlockerId = powerSaveBlocker.start("prevent-app-suspension");
      this.deps.logger.info("已启用电源抑制", { id: this.suspendBlockerId });
      return null;
    }
    if (this.suspendBlockerId !== null) {
      if (powerSaveBlocker.isStarted(this.suspendBlockerId)) {
        powerSaveBlocker.stop(this.suspendBlockerId);
      }
      this.deps.logger.info("已解除电源抑制", { id: this.suspendBlockerId });
      this.suspendBlockerId = null;
    }
    return null;
  }
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`host channel 参数 ${key} 必须是非空字符串`);
  }
  return value;
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`host channel 参数 ${key} 必须是字符串`);
  return value;
}

function requireBoolean(payload: Record<string, unknown>, key: string): boolean {
  const value = payload[key];
  if (typeof value !== "boolean") throw new Error(`host channel 参数 ${key} 必须是布尔值`);
  return value;
}

function optionalNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`host channel 参数 ${key} 必须是数字`);
  }
  return value;
}

function normalizeLogLevel(level: string): "debug" | "info" | "warn" | "error" {
  switch (level) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return level;
    default:
      return "info";
  }
}