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
// - 控制台抓取类渠道（需桌面 WebView）不在自动余额同步范围（与 Rust headless 一致）；
//   例外是千问：登录千问平台后走官方 HTTP 接口，Node Host 直接参与周期同步。
import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { JsonRow } from "../types.ts";
import type { WebContext } from "../web/context.ts";
import { queryBalance } from "../web/balance.ts";
import { resolveAccountCredentials, syncAccount } from "../web/qwen-platform.ts";
import { presetSupportsBalance } from "../web/config-state.ts";
import { loadLogCaptureConfig } from "../config/index.ts";
import { cleanupScheduledBodies } from "../storage/maintenance.ts";
import { cleanupA2aBodies } from "../storage/a2a.ts";
import type { CaptureRewrite, CaptureRewriteJob } from "../storage/capture-compaction.ts";

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
/** 千问账号通过千问平台 HTTP 接口自动同步（余额 + 免费额度 + Token Plan 订阅）。 */
const QWEN_PLATFORM_CHANNEL = "qwen";

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
  stop(): Promise<void>;
  runCleanupOnce(): Promise<void>;
  runCatalogSyncOnce(): Promise<void>;
  runBalanceSyncOnce(): Promise<void>;
}

export function createHostScheduler(options: HostSchedulerOptions): HostScheduler {
  const { context } = options;
  const log = options.log ?? ((line: JsonRow | string) => console.log(line));
  const timers = new Set<NodeJS.Timeout>();
  let stopped = false;
  let cleanupAbort: AbortController | undefined;
  let cleanup: Promise<void> | undefined;

  function schedule(firstDelayMs: number, intervalMs: number, task: () => Promise<void>): void {
    let timer: NodeJS.Timeout;
    const tick = (): void => {
      timers.delete(timer);
      if (stopped) return;
      void task()
        .catch((error: unknown) => {
          log({ level: "warn", task: "scheduler", error: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => {
          if (stopped) return;
          timer = setTimeout(tick, intervalMs);
          timers.add(timer);
        });
    };
    timer = setTimeout(tick, firstDelayMs);
    timers.add(timer);
  }

  function runCleanupOnce(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (cleanup) return cleanup;
    const controller = new AbortController();
    cleanupAbort = controller;
    cleanup = runStorageCleanup(controller.signal).finally(() => {
      cleanup = undefined;
      cleanupAbort = undefined;
    });
    return cleanup;
  }

  async function runStorageCleanup(signal: AbortSignal): Promise<void> {
    const { storage } = context;
    const logCapture = loadLogCaptureConfig(storage, context.config);
    const retention = parseUsageRetentionConfig(context.config);
    const before = storage.getTotalBodySizeBytes();
    let worker: Worker | undefined;
    let workerError: Error | undefined;
    let rejectJob: ((error: Error) => void) | undefined;

    function rewrite(job: CaptureRewriteJob): Promise<CaptureRewrite> {
      if (!worker) {
        worker = new Worker(new URL("./capture-cleanup-worker.ts", import.meta.url), {
          workerData: storage.captureStore().rootPath(),
        });
        const fail = (error: Error) => {
          workerError = error;
          rejectJob?.(error);
        };
        worker.on("error", fail);
        worker.on("exit", (code) => fail(new Error(`捕获清理 worker 已退出（${code}）`)));
      }
      if (workerError) return Promise.reject(workerError);
      const activeWorker = worker;
      return new Promise((resolve, reject) => {
        const receive = (reply: { result: CaptureRewrite } | { error: string }) => {
          rejectJob = undefined;
          if ("error" in reply) reject(new Error(reply.error));
          else resolve(reply.result);
        };
        rejectJob = (error) => {
          activeWorker.off("message", receive);
          rejectJob = undefined;
          reject(error);
        };
        activeWorker.once("message", receive);
        activeWorker.postMessage(job);
      });
    }

    try {
      const { expiredBodies, prunedBodies } = await cleanupScheduledBodies(storage.database(), storage.captureStore(), {
        retentionDays: logCapture.body_retention_days,
        maxBytes: logCapture.body_max_size_mb * 1024 * 1024,
        pruneRatio: logCapture.body_prune_ratio,
        signal,
      }, rewrite);
      if (signal.aborted) return;
      storage.withDatabase(db => cleanupA2aBodies(db, logCapture.body_retention_days, logCapture.body_max_size_mb));
      const [expiredSnapshots, overLimitSnapshots] = storage.pruneBalanceSnapshots(
        retention.balanceSnapshotRetentionDays,
        retention.balanceSnapshotMaxPerAccount,
      );
      const orphanSnapshots = storage.cleanupOrphanBalanceSnapshots();
      log({
        task: "storage-cleanup",
        expiredBodies,
        prunedBodies,
        bodyBytesBefore: before,
        bodyBytesAfter: storage.getTotalBodySizeBytes(),
        expiredSnapshots,
        overLimitSnapshots,
        orphanSnapshots,
      });
    } finally {
      await worker?.terminate();
    }
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
        // 与 Rust sync_catalog_file 一致：目录更新后重建价格表（两个来源独立重建无害）。
        const priceCount = context.storage.rebuildPriceTable(context.catalogDir, context.config);
        log({ task: "catalog-sync", file, bytes: text.length, prices: priceCount });
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
    // 千问：有平台登录态的账号走 HTTP 同步（余额/免费额度/订阅），
    // 与桌面端「已登录后自动同步」一致；未登录的账号跳过，不刷失败日志。
    let qwenAttempted = 0;
    for (const account of accounts) {
      if (!account || account.enabled !== true) continue;
      if (String(account.channel_id ?? "") !== QWEN_PLATFORM_CHANNEL) continue;
      const accountId = String(account.id ?? "");
      if (accountId === "") continue;
      const credentials = resolveAccountCredentials(context.catalogDir, accountId);
      if (credentials.state !== "ok") continue;
      qwenAttempted += 1;
      try {
        await syncAccount(context, accountId);
        succeeded += 1;
      } catch (error) {
        failed += 1;
        log({
          task: "balance-sync",
          channel: "qwen",
          accountId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (targets.length > 0 || qwenAttempted > 0) {
      log({ task: "balance-sync", attempted: targets.length + qwenAttempted, qwen: qwenAttempted, succeeded, failed });
    }
  }

  return {
    start(): void {
      stopped = false;
      schedule(BALANCE_SYNC_FIRST_DELAY_MS, BALANCE_SYNC_INTERVAL_MS, runBalanceSyncOnce);
      schedule(STORAGE_CLEANUP_FIRST_DELAY_MS, STORAGE_CLEANUP_INTERVAL_MS, runCleanupOnce);
      schedule(CATALOG_SYNC_FIRST_DELAY_MS, CATALOG_SYNC_INTERVAL_MS, runCatalogSyncOnce);
    },
    async stop(): Promise<void> {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      cleanupAbort?.abort();
      await cleanup?.catch(() => {}); // 调度器负责记录任务异常。
    },
    runCleanupOnce,
    runCatalogSyncOnce,
    runBalanceSyncOnce,
  };
}
