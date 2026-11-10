// Host 无关的周期维护任务：存储清理、模型目录同步、官方余额同步。
// Owner: lead（迁移集成阶段补齐）。
//
// 与 Rust 的对应关系：
// - 周期与地址：core/host_scheduler.rs（STORAGE_CLEANUP / CATALOG_SYNC / MODELS_*_URL）
// - 余额同步编排：core/account_balance.rs::sync_official_balances
// - 目录同步：core/storage_tasks.rs::sync_models_cn_catalog / sync_models_dev_catalog
//
// MVP 差异（已在 docs/migration/docker-node.md 标注）：
// - 不写 background_jobs 后台任务日志（Rust 会写）；只输出结构化 console 行，便于容器日志检索。
// - 目录同步只负责抓取并原子写入 catalogDir，不重建价格表（Node 价格仍来自 config.json）。
// - 控制台抓取类渠道（需桌面 WebView）不在自动余额同步范围（与 Rust headless 一致）。
import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { JsonRow } from "../types.ts";
import type { WebContext } from "../web/context.ts";
import { queryBalance } from "../web/balance.ts";
import { presetSupportsBalance } from "../web/config-state.ts";
import { loadLogCaptureConfig } from "../config/index.ts";

export const STORAGE_CLEANUP_FIRST_DELAY_MS = 15 * 60_000;
export const STORAGE_CLEANUP_INTERVAL_MS = 15 * 60_000;
export const CATALOG_SYNC_FIRST_DELAY_MS = 60 * 60_000;
export const CATALOG_SYNC_INTERVAL_MS = 60 * 60_000;
export const BALANCE_SYNC_FIRST_DELAY_MS = 30_000;
export const BALANCE_SYNC_INTERVAL_MS = 5 * 60_000;

/** 与 Rust host_scheduler.rs 一致。 */
export const MODELS_CN_URL = "https://null-object-0000.github.io/models-cn/api.json";
export const MODELS_DEV_URL = "https://models.dev/api.json";

/** 提供官方余额接口、可在无桌面环境自动同步的渠道（Rust supports_official_balance）。 */
const OFFICIAL_BALANCE_CHANNELS = new Set(["deepseek", "kimi", "openrouter", "vibetoken"]);

interface UsageRetentionConfig {
  balanceSnapshotRetentionDays: number;
  balanceSnapshotMaxPerAccount: number;
}

/** 对齐 Rust config::UsageRetentionConfig::from_config_json（默认 30 天 / 200 条）。 */
export function parseUsageRetentionConfig(configJson: JsonRow): UsageRetentionConfig {
  const section = (configJson?.usage_retention ?? {}) as JsonRow;
  const days = Number(section.balance_snapshot_retention_days ?? 30);
  const maxPerAccount = Number(section.balance_snapshot_max_per_account ?? 200);
  return {
    balanceSnapshotRetentionDays: Number.isFinite(days) ? days : 30,
    balanceSnapshotMaxPerAccount: Number.isFinite(maxPerAccount) ? maxPerAccount : 200,
  };
}

export interface HostSchedulerOptions {
  /** 由 Web Host 暴露的命令上下文：storage / runtimeConfig / config / catalogDir / configPath。 */
  context: WebContext;
  log?: (line: JsonRow | string) => void;
}

export interface HostScheduler {
  start(): void;
  stop(): void;
  runCleanupOnce(): Promise<void>;
  runCatalogSyncOnce(): Promise<void>;
  runBalanceSyncOnce(): Promise<void>;
}

export function createHostScheduler(options: HostSchedulerOptions): HostScheduler {
  const { context } = options;
  const log = options.log ?? ((line: JsonRow | string) => console.log(line));
  const timers = new Set<NodeJS.Timeout>();
  let stopped = false;

  function schedule(firstDelayMs: number, intervalMs: number, task: () => Promise<void>): void {
    const tick = (): void => {
      if (stopped) return;
      void task()
        .catch((error: unknown) => {
          log({ level: "warn", task: "scheduler", error: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => {
          if (stopped) return;
          const timer = setTimeout(tick, intervalMs);
          timers.add(timer);
        });
    };
    const timer = setTimeout(tick, firstDelayMs);
    timers.add(timer);
  }

  async function runCleanupOnce(): Promise<void> {
    const logCapture = loadLogCaptureConfig(context.storage, context.config);
    const retention = parseUsageRetentionConfig(context.config);
    const before = context.storage.getTotalBodySizeBytes();
    const expiredBodies = context.storage.cleanupExpiredBodyData(logCapture.body_retention_days);
    let prunedBodies = 0;
    if (logCapture.body_max_size_mb > 0) {
      prunedBodies = context.storage.pruneOldestBodyDataToGoal(
        logCapture.body_max_size_mb * 1024 * 1024,
        logCapture.body_prune_ratio,
      );
    }
    const [expiredSnapshots, overLimitSnapshots] = context.storage.pruneBalanceSnapshots(
      retention.balanceSnapshotRetentionDays,
      retention.balanceSnapshotMaxPerAccount,
    );
    const orphanSnapshots = context.storage.cleanupOrphanBalanceSnapshots();
    const after = context.storage.getTotalBodySizeBytes();
    log({
      task: "storage-cleanup",
      expiredBodies,
      prunedBodies,
      bodyBytesBefore: before,
      bodyBytesAfter: after,
      expiredSnapshots,
      overLimitSnapshots,
      orphanSnapshots,
    });
  }

  async function fetchCatalog(url: string): Promise<string> {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`目录同步失败：${url} -> HTTP ${response.status}`);
    const text = await response.text();
    JSON.parse(text); // 校验是合法 JSON，避免把错误页写进数据卷
    return text;
  }

  async function runCatalogSyncOnce(): Promise<void> {
    // 与 Rust 一致：两个目录相互独立，单个失败不影响另一个。
    const targets: Array<[string, string]> = [
      ["models-cn.json", MODELS_CN_URL],
      ["models-dev.json", MODELS_DEV_URL],
    ];
    for (const [file, url] of targets) {
      try {
        const text = await fetchCatalog(url);
        const target = path.join(context.catalogDir, file);
        const temporary = `${target}.tmp-${process.pid}`;
        writeFileSync(temporary, text, { mode: 0o644 });
        renameSync(temporary, target);
        log({ task: "catalog-sync", file, bytes: text.length });
      } catch (error) {
        log({
          task: "catalog-sync",
          file,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async function runBalanceSyncOnce(): Promise<void> {
    const snapshot = context.runtimeConfig.snapshot();
    const accounts = Array.isArray(snapshot.accounts) ? (snapshot.accounts as JsonRow[]) : [];
    const targets = accounts.filter((account) => {
      if (!account || account.enabled !== true) return false;
      const channelId = String(account.channel_id ?? "");
      if (!OFFICIAL_BALANCE_CHANNELS.has(channelId)) return false;
      if (!presetSupportsBalance(snapshot, channelId)) return false;
      // 账号级自定义端点不保证官方余额语义（Rust 同口径）。
      const openaiOverride = String(account.base_url_override ?? "").trim();
      const workspaceDefault = String(account.workspace_default_base_url ?? "").trim();
      return openaiOverride === "" && workspaceDefault === "";
    });
    let succeeded = 0;
    let failed = 0;
    for (const account of targets) {
      try {
        const result = await queryBalance(context, String(account.id));
        if (result.error === null) succeeded += 1;
        else failed += 1;
      } catch (error) {
        failed += 1;
        log({
          task: "balance-sync",
          accountId: account.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (targets.length > 0) log({ task: "balance-sync", attempted: targets.length, succeeded, failed });
  }

  return {
    start(): void {
      stopped = false;
      schedule(BALANCE_SYNC_FIRST_DELAY_MS, BALANCE_SYNC_INTERVAL_MS, runBalanceSyncOnce);
      schedule(STORAGE_CLEANUP_FIRST_DELAY_MS, STORAGE_CLEANUP_INTERVAL_MS, runCleanupOnce);
      schedule(CATALOG_SYNC_FIRST_DELAY_MS, CATALOG_SYNC_INTERVAL_MS, runCatalogSyncOnce);
    },
    stop(): void {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
    runCleanupOnce,
    runCatalogSyncOnce,
    runBalanceSyncOnce,
  };
}
