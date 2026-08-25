import type { AccountBalanceSnapshot, ChannelAccount } from "../../domains/account/types";
import { effectiveOpenAiBaseUrl } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import { isQwenTokenPlanAccount, isQwenPayAsYouGoAccount, isZhipuPayAsYouGoAccount } from "../../domains/channel/types";
import type { CodexAccountReport } from "../../domains/agent/types";
import { CHANNEL_RESOURCE_SYNC_INTERVAL_MS } from "../background-tasks/ChannelResourceAutoSync";
import { CODEX_ACCOUNT_SYNC_INTERVAL_MS } from "../background-tasks/CodexAccountAutoSync";

/** 账号资源数据的新鲜度。null 表示账号不参与自动同步，不需要提示。 */
export type AccountSyncStatus = "fresh" | "stale";

/** 账号是否参与渠道资源自动同步。必须与 Rust 侧
 *  `sync_scrape_balances` 的 `channel_resource_sync_method` 保持一致：
 *  - 官方余额 API 渠道（`supports_balance_query === true`，当前 DeepSeek / Kimi /
 *    OpenRouter）默认周期同步（不受 resource_sync_mode 控制），自定义 OpenAI
 *    端点覆盖的账号不保证官方余额接口语义，跳过；
 *  - LongCat 控制台抓取账号仅 `resource_sync_mode === "auto"` 时自动同步；
 *  - Qwen 的 Token Plan 订阅账号与 API 按量付费账号（福利页免费额度抓取）在
 *    `resource_sync_mode === "auto"` 时均参与控制台抓取自动同步；
 *  - Z.AI 按量付费账号（资源包管理页抓取余额与额度包）在
 *    `resource_sync_mode === "auto"` 时参与控制台抓取自动同步；
 *  - 未启用账号不参与自动同步。 */
export function hasChannelAutoSync(
  account: ChannelAccount,
  preset: ChannelPreset | undefined,
): boolean {
  if (!account.enabled) return false;

  const isOfficialBalanceApi =
    preset?.supports_balance_query === true &&
    !effectiveOpenAiBaseUrl(account);
  if (isOfficialBalanceApi) return true;

  return (
    account.resource_sync_mode === "auto" &&
    (account.channel_id === "longcat"
      || isQwenTokenPlanAccount(account)
      || isQwenPayAsYouGoAccount(account)
      || isZhipuPayAsYouGoAccount(account))
  );
}

/** 判断账号数据是否过期：自动同步账号超过两轮同步周期（最后同步时间 + 调度周期 × 2）
 *  仍未更新成功即视为过期。从未同步过的账号没有快照，直接视为过期。 */
export function accountSyncStatus(
  account: ChannelAccount,
  snapshot: AccountBalanceSnapshot | undefined,
  preset: ChannelPreset | undefined,
  now: number = Date.now(),
): AccountSyncStatus | null {
  if (!hasChannelAutoSync(account, preset)) return null;
  if (!snapshot?.synced_at) return "stale";

  const syncedAtMs = new Date(snapshot.synced_at).getTime();
  if (Number.isNaN(syncedAtMs)) return "stale";
  return syncedAtMs + CHANNEL_RESOURCE_SYNC_INTERVAL_MS * 2 < now ? "stale" : "fresh";
}

/** Codex 账号同样有资源用量自动同步（见 CodexAccountAutoSync）。过期判断：
 *  - `report.stale` 表示最近一轮刷新失败（Rust 保留旧快照并标记），直接视为过期；
 *  - 否则按「最后成功更新时间 + 两轮同步周期」对比，超过两轮未更新成功即过期。 */
export function codexSyncStatus(
  report: CodexAccountReport,
  now: number = Date.now(),
): AccountSyncStatus {
  if (report.stale) return "stale";

  const updatedAtMs = new Date(report.updated_at).getTime();
  if (Number.isNaN(updatedAtMs)) return "stale";
  return updatedAtMs + CODEX_ACCOUNT_SYNC_INTERVAL_MS * 2 < now ? "stale" : "fresh";
}
