import { invokeCommand, toAppError } from "../../platform/tauri/client";
import { ErrorCode } from "../../shared/errors/codes";
import type { AppError } from "../../shared/errors/AppError";
import type { ProxyBindConfig, ProxyStatus } from "./types";

/**
 * Proxy lifecycle command adapter. The ONLY proxy-domain module in src allowed to
 * reference the proxy command names. Pages / features call these functions
 * and never spell "start_proxy" etc.
 */

function mapProxyError(err: unknown, fallbackCode: string): AppError {
  const app = toAppError(err, fallbackCode);
  // Rust surfaces a few recognizable situations; map them to stable codes
  // without relying on fragile substring logic for business decisions.
  const lower = (app.message ?? "").toLowerCase();
  if (lower.includes("已经在运行") || lower.includes("already running")) {
    return { ...app, code: ErrorCode.ProxyAlreadyRunning, retryable: false };
  }
  if (lower.includes("未运行") || lower.includes("not running")) {
    return { ...app, code: ErrorCode.ProxyNotRunning, retryable: true };
  }
  if (lower.includes("监听地址无效") || lower.includes("invalid bind")) {
    return { ...app, code: ErrorCode.InvalidBindAddr, retryable: false };
  }
  return app;
}

export const proxyCommands = {
  status: (): Promise<ProxyStatus> => invokeCommand<ProxyStatus>("proxy_status"),

  start: (): Promise<void> =>
    invokeCommand<void>("start_proxy").catch((err) => {
      throw mapProxyError(err, ErrorCode.ProxyStartFailed);
    }),

  stop: (): Promise<void> =>
    invokeCommand<void>("stop_proxy").catch((err) => {
      throw mapProxyError(err, ErrorCode.ProxyStopFailed);
    }),

  /** Idempotent restart: stop (ignore not-running) then start. */
  restart: async (): Promise<void> => {
    try {
      await proxyCommands.stop();
    } catch (err) {
      if (toAppError(err).code !== ErrorCode.ProxyNotRunning) {
        throw err;
      }
    }
    await proxyCommands.start();
  },

  bindConfig: (): Promise<ProxyBindConfig> =>
    invokeCommand<ProxyBindConfig>("get_proxy_bind_config"),

  setBindConfig: (config: ProxyBindConfig): Promise<void> =>
    invokeCommand<void>("set_proxy_bind_config", { config }),
};

export type { AppError };
