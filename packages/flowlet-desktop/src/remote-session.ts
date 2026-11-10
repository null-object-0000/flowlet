// 客户端模式的远程会话（OIDC Cookie + CSRF）。
//
// 远程 Docker/Web Host 的生产实例多为 OIDC-only：浏览器登录后服务端下发 HttpOnly
// 会话 Cookie。桌面客户端要复用同一会话，做法是：
//
// 1. 用独立持久化分区 `persist:flowlet-remote` 打开一个登录窗口指向远程管理台；
// 2. 用户在窗口里走企业 SSO，Cookie 落在该分区的远端 origin 上；
// 3. 主进程轮询 `/api/session` 确认已登录，并缓存 `csrf_token`；
// 4. Client Gateway 用 `session.cookies.get()` 拼 Cookie 头 + `X-CSRF-Token` 反代，
//    渲染进程始终看不到 Cookie / token。
//
// token 模式的凭据不在这里，由 `mode-store.ts` 用 safeStorage 加密保存。
import { BrowserWindow, session, type Session } from "electron";
import { remoteUrl } from "./client/config.ts";
import type { GatewayAuth } from "./client/gateway.ts";
import {
  buildCookieHeader,
  EMPTY_REMOTE_SESSION,
  parseRemoteSessionPayload,
  type RemoteSessionSnapshot,
} from "./client/session-state.ts";
import type { DesktopLogger } from "./logger.ts";

export const REMOTE_SESSION_PARTITION = "persist:flowlet-remote";

export type RemoteSessionStatus = RemoteSessionSnapshot;

export class RemoteSession {
  #baseUrl: string;
  #logger: DesktopLogger;
  #csrf: string | null = null;
  #lastStatus: RemoteSessionStatus = { ...EMPTY_REMOTE_SESSION };

  constructor(options: { baseUrl: string; logger: DesktopLogger }) {
    this.#baseUrl = options.baseUrl;
    this.#logger = options.logger;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  setBaseUrl(baseUrl: string): void {
    this.#baseUrl = baseUrl;
    this.#csrf = null;
    this.#lastStatus = { ...EMPTY_REMOTE_SESSION };
  }

  #session(): Session {
    return session.fromPartition(REMOTE_SESSION_PARTITION);
  }

  /** 供 Gateway 反代使用：Cookie 原样 + 最近一次拿到的 CSRF token。 */
  async authFor(): Promise<GatewayAuth> {
    const cookie = await this.#cookieHeader();
    return {
      ...(cookie === "" ? {} : { cookie }),
      ...(this.#csrf === null ? {} : { csrf: this.#csrf }),
    };
  }

  async #cookieHeader(): Promise<string> {
    try {
      const cookies = await this.#session().cookies.get({ url: this.#baseUrl });
      return buildCookieHeader(cookies);
    } catch (error) {
      this.#logger.warn("读取远程会话 Cookie 失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      return "";
    }
  }

  /** 读取远程 `/api/session`，同时刷新 CSRF token 与身份信息。 */
  async status(): Promise<RemoteSessionStatus> {
    const cookie = await this.#cookieHeader();
    if (cookie === "") {
      this.#lastStatus = { ...EMPTY_REMOTE_SESSION };
      return this.#lastStatus;
    }
    try {
      const response = await fetch(remoteUrl(this.#baseUrl, "/api/session"), {
        headers: { cookie, accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        this.#lastStatus = { ...EMPTY_REMOTE_SESSION };
        return this.#lastStatus;
      }
      const parsed = parseRemoteSessionPayload(await response.json());
      this.#csrf = parsed.csrf;
      this.#lastStatus = parsed;
      return this.#lastStatus;
    } catch (error) {
      this.#logger.warn("读取远程会话状态失败", {
        baseUrl: this.#baseUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ...EMPTY_REMOTE_SESSION };
    }
  }

  /**
   * 打开远程管理台登录窗口，等待 SSO 完成。
   * 返回最终状态；用户关闭窗口或超时抛错（由调用方转成可读提示）。
   */
  async login(options: { timeoutMs?: number } = {}): Promise<RemoteSessionStatus> {
    const timeoutMs = options.timeoutMs ?? 180_000;
    const win = new BrowserWindow({
      width: 980,
      height: 760,
      title: "登录远程主机",
      autoHideMenuBar: true,
      webPreferences: {
        partition: REMOTE_SESSION_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    let closedByUser = false;
    win.on("closed", () => {
      closedByUser = true;
    });
    await win.loadURL(remoteUrl(this.#baseUrl, "/"));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (closedByUser) throw new Error("已取消远程登录");
      const status = await this.status();
      if (status.authenticated) {
        this.#logger.info("远程主机登录成功", { baseUrl: this.#baseUrl, mode: status.mode });
        if (!win.isDestroyed()) win.close();
        return status;
      }
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
    if (!win.isDestroyed()) win.close();
    throw new Error("远程登录超时，请重试");
  }

  async logout(): Promise<void> {
    try {
      await this.#session().clearStorageData();
    } catch (error) {
      this.#logger.warn("清理远程会话失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.#csrf = null;
    this.#lastStatus = { ...EMPTY_REMOTE_SESSION };
  }
}
