import { invokeCommand, toAppError } from "../../platform/tauri/client";

/**
 * 千问平台 device-flow 登录 + 官方 HTTP 接口直连同步的类型化命令边界。
 *
 * Rust 侧命令契约（字段已 camelCase）：
 * - qwen_platform_status        → 当前账号的平台登录态
 * - qwen_platform_login_start   → 授权链接与轮询参数
 * - qwen_platform_login_poll    → 轮询结果
 * - qwen_platform_logout        → 清除本机保存的平台登录态
 * - qwen_platform_sync          → 余额 + 免费额度（rawScrapedJson 与控制台抓取的
 *                                  slot bundle 同构，可直接交给 parseQwenFreeTierDetails）
 *
 * 页面与组件只能经此模块调用，不得直接拼写 Tauri command 名称。
 */

/** device-flow 轮询结果；`slow_down` 表示应按约定增大轮询间隔后继续。 */
export type QwenPlatformLoginPollStatus =
  | "pending"
  | "slow_down"
  | "complete"
  | "expired"
  | "denied";

export type QwenPlatformStatus = {
  accountId: string;
  loggedIn: boolean;
  aliyunId: string | null;
  email: string | null;
  expiresAt: string | null;
};

export type QwenPlatformLoginStart = {
  verificationUrl: string;
  expiresInSeconds: number;
  intervalSeconds: number;
};

export type QwenPlatformLoginPoll = {
  status: QwenPlatformLoginPollStatus;
};

export type QwenPlatformSyncResult = {
  accountId: string;
  balance: number | null;
  currency: string | null;
  syncedAt: string;
  /** 与控制台抓取同构的 slot bundle（billing_amount / fq_instance / settle_bill）。 */
  rawScrapedJson: string;
};

/** 登录启动要打开浏览器并等待上游创建授权会话，给比默认更宽的窗口。 */
const LOGIN_START_TIMEOUT_MS = 30_000;
/** 同步会直连千问官方接口拉取余额与免费额度，允许较长的网络等待。 */
const SYNC_TIMEOUT_MS = 60_000;

function toAppErr(code: string) {
  return (error: unknown) => {
    throw toAppError(error, code);
  };
}

export const qwenPlatformCommands = {
  status: (accountId: string): Promise<QwenPlatformStatus> =>
    invokeCommand<QwenPlatformStatus>("qwen_platform_status", { accountId }).catch(
      toAppErr("qwen_platform_status_failed"),
    ),

  loginStart: (accountId: string): Promise<QwenPlatformLoginStart> =>
    invokeCommand<QwenPlatformLoginStart>(
      "qwen_platform_login_start",
      { accountId },
      LOGIN_START_TIMEOUT_MS,
    ).catch(toAppErr("qwen_platform_login_start_failed")),

  loginPoll: (accountId: string): Promise<QwenPlatformLoginPoll> =>
    invokeCommand<QwenPlatformLoginPoll>("qwen_platform_login_poll", { accountId }).catch(
      toAppErr("qwen_platform_login_poll_failed"),
    ),

  logout: (accountId: string): Promise<null> =>
    invokeCommand<null>("qwen_platform_logout", { accountId }).catch(
      toAppErr("qwen_platform_logout_failed"),
    ),

  sync: (accountId: string): Promise<QwenPlatformSyncResult> =>
    invokeCommand<QwenPlatformSyncResult>(
      "qwen_platform_sync",
      { accountId },
      SYNC_TIMEOUT_MS,
    ).catch(toAppErr("qwen_platform_sync_failed")),
};