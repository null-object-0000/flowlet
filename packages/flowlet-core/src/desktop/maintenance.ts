// 桌面设置/维护命令（批次 2）。Owner: desktop-maintenance。
//
// 负责：save_channel_presets / analyze_usage / account_stats / list_route_rules /
// save_route_rules / export_config / import_config / db_stats / storage_usage_summary /
// compact_database / get_app_version / get_app_data_dir / get_app_diagnostics /
// cleanup_expired_body_data / prune_oldest_body_data / get_total_body_size_bytes /
// read_config / write_config / log_from_frontend / is_autostart_enabled /
// enable_autostart / disable_autostart。
//
// 权威行为：src-tauri/src/commands/maintenance.rs、channels.rs、usage.rs 与
// src-tauri/src/commands/scrape.rs（route rules / account_stats）。
// 字段风格与 Rust 逐字段一致：这些命令返回的配置结构是 snake_case，
// 存储统计结构（StorageUsageSummary / DatabaseCompactionResult）是 camelCase；
// db_stats 是三元组数组；`()` 返回 null。
import { readFileSync, statSync, writeFileSync } from "node:fs";

import { CommandError } from "../types.ts";
import type { JsonRow } from "../types.ts";
import type { DesktopContext, DesktopHandlerMap } from "./types.ts";
import {
  argArray,
  argError,
  argFloat,
  argInteger,
  argString,
  argsObject,
  requireFields,
  serdeTypeName,
} from "../web/errors.ts";
import {
  compactDatabase,
  dbStats,
  storageUsageSummary,
  type StorageUsageFileMetrics,
} from "../storage/settings-domain.ts";
import type { ModelPrice, ModelPriceSchedule, ModelPriceTier } from "../storage/prices.ts";

// ─── 参数结构校验（复刻 serde 的必填字段） ────────────────────────────────────

const CHANNEL_PRESET_REQUIRED = [
  "id",
  "name",
  "vendor",
  "supported_protocols",
  "openai_base_url",
  "anthropic_base_url",
  "openai_auth",
  "anthropic_auth",
  "default_model",
  "supports_model_list",
  "supports_model_detail",
  "supports_balance_query",
  "supports_quota_query",
  "supports_usage_query",
  "supports_scrape_balance",
  "supports_files_api",
  "created_at",
  "updated_at",
];
const ROUTE_RULE_REQUIRED = [
  "id",
  "name",
  "enabled",
  "priority",
  "target_channel_id",
  "target_account_id",
  "target_upstream_model",
  "created_at",
  "updated_at",
];
// ChannelAccount 的 Option / #[serde(default)] 字段允许缺省（与 Rust serde 一致）。
const CHANNEL_ACCOUNT_REQUIRED = [
  "id",
  "channel_id",
  "name",
  "api_key",
  "enabled",
  "priority",
  "created_at",
  "updated_at",
];
const ROUTE_CANDIDATE_REQUIRED = [
  "id",
  "virtual_model_id",
  "channel_id",
  "account_id",
  "upstream_model",
  "client_protocol",
  "priority",
  "enabled",
  "created_at",
  "updated_at",
];
const VIRTUAL_MODEL_REQUIRED = [
  "id",
  "name",
  "protocol_type",
  "routing_strategy",
  "enabled",
  "created_at",
  "updated_at",
];
const MODEL_PRICE_REQUIRED = [
  "id",
  "channel_id",
  "upstream_model",
  "input_uncached_price",
  "input_cached_price",
  "output_price",
  "currency",
  "unit",
  "created_at",
  "updated_at",
];
const CONFIG_BUNDLE_REQUIRED = [
  "version",
  "exported_at",
  "channels",
  "accounts",
  "routes",
  "rules",
  "prices",
  "virtual_models",
];

const PROTOCOL_VARIANTS = ["openai", "anthropic", "responses"] as const;
const AUTH_VARIANTS = ["bearer", "x_api_key"] as const;

function fieldTypeError(name: string, field: string, value: unknown, expected: string): CommandError {
  return CommandError.badRequest(
    `参数 ${name}: field \`${field}\`: invalid type: ${serdeTypeName(value)}, expected ${expected}`,
  );
}

function requireString(row: JsonRow, name: string, field: string): void {
  if (typeof row[field] !== "string") throw fieldTypeError(name, field, row[field], "a string");
}

function requireBool(row: JsonRow, name: string, field: string): void {
  if (typeof row[field] !== "boolean") throw fieldTypeError(name, field, row[field], "a boolean");
}

function requireEnum(
  row: JsonRow,
  name: string,
  field: string,
  variants: readonly string[],
): void {
  const value = row[field];
  if (typeof value !== "string" || !(variants as readonly string[]).includes(value)) {
    throw argError(
      name,
      `unknown variant \`${String(value)}\`, expected one of ${variants
        .map((variant) => `\`${variant}\``)
        .join(", ")}`,
    );
  }
}

/** 逐字段复刻 `ChannelPreset` 的 serde 反序列化（枚举 / 可选字段 / bool）。 */
function validateChannelPreset(row: JsonRow, name: string): void {
  requireFields(row, name, CHANNEL_PRESET_REQUIRED);
  for (const field of ["id", "name", "vendor", "openai_base_url", "anthropic_base_url", "default_model"]) {
    requireString(row, name, field);
  }
  if (!Array.isArray(row.supported_protocols)) {
    throw fieldTypeError(name, "supported_protocols", row.supported_protocols, "a sequence");
  }
  for (const protocol of row.supported_protocols) {
    if (typeof protocol !== "string" || !(PROTOCOL_VARIANTS as readonly string[]).includes(protocol)) {
      throw argError(
        name,
        `unknown variant \`${String(protocol)}\`, expected one of ${PROTOCOL_VARIANTS.map(
          (variant) => `\`${variant}\``,
        ).join(", ")}`,
      );
    }
  }
  requireEnum(row, name, "openai_auth", AUTH_VARIANTS);
  requireEnum(row, name, "anthropic_auth", AUTH_VARIANTS);
  for (const field of [
    "supports_model_list",
    "supports_model_detail",
    "supports_balance_query",
    "supports_quota_query",
    "supports_usage_query",
    "supports_scrape_balance",
    "supports_files_api",
  ]) {
    requireBool(row, name, field);
  }
  if (row.enabled !== undefined && typeof row.enabled !== "boolean") {
    throw fieldTypeError(name, "enabled", row.enabled, "a boolean");
  }
  if (row.timeout_seconds !== null && row.timeout_seconds !== undefined) {
    if (typeof row.timeout_seconds !== "number" || !Number.isInteger(row.timeout_seconds)) {
      throw fieldTypeError(name, "timeout_seconds", row.timeout_seconds, "u64");
    }
  }
}

/** `RouteRule` 的 serde 反序列化：match_* 是 Option，其余必填。 */
function validateRouteRule(row: JsonRow, name: string): void {
  requireFields(row, name, ROUTE_RULE_REQUIRED);
  for (const field of ["id", "name", "target_channel_id", "target_account_id", "target_upstream_model"]) {
    requireString(row, name, field);
  }
  requireBool(row, name, "enabled");
  if (typeof row.priority !== "number" || !Number.isInteger(row.priority)) {
    throw fieldTypeError(name, "priority", row.priority, "i64");
  }
  if (row.match_protocol !== null && row.match_protocol !== undefined) {
    requireEnum(row, name, "match_protocol", PROTOCOL_VARIANTS);
  }
}

function structArray(
  args: JsonRow,
  name: string,
  structName: string,
  validate: (row: JsonRow, name: string) => void,
): JsonRow[] {
  const rows = argArray(args, name, structName);
  for (const row of rows) validate(row, name);
  return rows;
}

function badRequest(error: unknown): CommandError {
  if (error instanceof CommandError) return error;
  return CommandError.badRequest(error instanceof Error ? error.message : String(error));
}

function snapshotArray(ctx: DesktopContext, field: string): JsonRow[] {
  const value = ctx.runtimeConfig.snapshot()[field];
  return Array.isArray(value) ? (value as JsonRow[]) : [];
}

function fileBytes(filePath: string): number {
  try {
    return Math.min(statSync(filePath).size, Number.MAX_SAFE_INTEGER);
  } catch {
    return 0;
  }
}

/** Rust `export_config` 的 `exported_at` 使用 chrono RFC3339（+00:00 偏移）。 */
function rfc3339Now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00").replace("Z", "+00:00");
}

/** Rust `get_app_diagnostics` 的 `std::env::consts::{OS,ARCH}` 命名。 */
function rustPlatform(): string {
  const os =
    process.platform === "darwin"
      ? "macos"
      : process.platform === "win32"
        ? "windows"
        : process.platform;
  const arch =
    process.arch === "x64"
      ? "x86_64"
      : process.arch === "arm64"
        ? "aarch64"
        : process.arch === "ia32"
          ? "x86"
          : process.arch;
  return `${os} ${arch}`;
}

export const handlers: DesktopHandlerMap = {
  // ─── 渠道 / 路由规则（channels.rs / scrape.rs） ────────────────────────────

  save_channel_presets: (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const presets = structArray(args, "presets", "ChannelPreset", validateChannelPreset);
    try {
      ctx.storage.saveChannelPresets(presets);
    } catch (error) {
      throw badRequest(error);
    }
    // Rust update_after：保存成功后才把入参发布进运行时快照（不重新读取）。
    ctx.runtimeConfig.update((draft) => {
      draft.channels = presets;
    });
    return null;
  },

  list_route_rules: (ctx) => snapshotArray(ctx, "rules"),

  save_route_rules: (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const rules = structArray(args, "rules", "RouteRule", validateRouteRule);
    try {
      ctx.storage.saveRouteRules(rules);
    } catch (error) {
      throw badRequest(error);
    }
    ctx.runtimeConfig.update((draft) => {
      draft.rules = rules;
    });
    return null;
  },

  // ─── 用量 ──────────────────────────────────────────────────────────────────

  analyze_usage: (ctx) => {
    try {
      const parsed = ctx.storage.repairCapturedUsage("all");
      const inserted = ctx.storage.repairUnknownUsage("all");
      ctx.storage.repairUsageCosts("all");
      return parsed + inserted;
    } catch (error) {
      throw badRequest(error);
    }
  },

  account_stats: (ctx) => {
    try {
      return ctx.storage.accountStats();
    } catch (error) {
      throw badRequest(error);
    }
  },

  // ─── 配置读写 / 导入导出（maintenance.rs） ─────────────────────────────────

  read_config: (ctx) => {
    try {
      return readFileSync(ctx.configPath, "utf8");
    } catch {
      throw CommandError.badRequest("config.json 不存在或读取失败");
    }
  },

  write_config: (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const content = argString(args, "content");
    // Rust core::proxy::write_config_raw：先 serde_json 解析，再要求顶层为对象/数组。
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw CommandError.badRequest(
        `JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (parsed === null || typeof parsed !== "object") {
      throw CommandError.badRequest("config.json 顶层必须是对象或数组");
    }
    try {
      writeFileSync(ctx.configPath, content);
    } catch (error) {
      throw CommandError.badRequest(
        `写入失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return null;
  },

  export_config: (ctx) => {
    try {
      // 字段顺序与 Rust ConfigBundle 一致；价格来自内存价格表（不落库）。
      const bundle = {
        version: "1",
        exported_at: rfc3339Now(),
        channels: ctx.storage.listChannelPresets(),
        accounts: ctx.storage.listChannelAccounts(),
        routes: ctx.storage.listRouteCandidates(),
        rules: ctx.storage.listRouteRules(),
        prices: ctx.storage.prices(),
        virtual_models: ctx.storage.listVirtualModels(),
      };
      return JSON.stringify(bundle, null, 2);
    } catch (error) {
      throw badRequest(error);
    }
  },

  import_config: (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const json = argString(args, "json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      // Rust 返回 serde_json 原始错误文本，这里保留解析器消息以保留可诊断性。
      throw CommandError.badRequest(error instanceof Error ? error.message : String(error));
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw CommandError.badRequest("invalid type: expected struct ConfigBundle");
    }
    const bundle = parsed as JsonRow;
    requireFields(bundle, "json", CONFIG_BUNDLE_REQUIRED);
    const channels = bundleArray(bundle, "channels", "ChannelPreset", validateChannelPreset);
    const accounts = bundleArray(bundle, "accounts", "ChannelAccount", (row, name) =>
      requireFields(row, name, CHANNEL_ACCOUNT_REQUIRED),
    );
    const routes = bundleArray(bundle, "routes", "RouteCandidate", (row, name) =>
      requireFields(row, name, ROUTE_CANDIDATE_REQUIRED),
    );
    const rules = bundleArray(bundle, "rules", "RouteRule", validateRouteRule);
    const prices = bundleArray(bundle, "prices", "ModelPrice", (row, name) =>
      requireFields(row, name, MODEL_PRICE_REQUIRED),
    ).map(normalizeModelPrice);
    const virtualModels = bundleArray(
      bundle,
      "virtual_models",
      "VirtualModel",
      (row, name) => requireFields(row, name, VIRTUAL_MODEL_REQUIRED),
    );
    try {
      ctx.storage.saveChannelPresets(channels);
      ctx.storage.saveChannelAccounts(accounts);
      ctx.storage.saveRouteCandidates(routes);
      ctx.storage.saveRouteRules(rules);
      ctx.storage.saveVirtualModels(virtualModels);
      // 价格不持久化到数据库；导入时直接更新内存价格副本（Rust set_prices）。
      ctx.storage.setPrices(prices);
      // 导入后从数据库重新读取并整体替换运行时快照（Rust import_config）。
      ctx.runtimeConfig.replace({
        channels: ctx.storage.listChannelPresets(),
        accounts: ctx.storage.listChannelAccounts(),
        routes: ctx.storage.listRouteCandidates(),
        rules: ctx.storage.listRouteRules(),
        virtual_models: ctx.storage.listVirtualModels(),
      });
    } catch (error) {
      throw badRequest(error);
    }
    return null;
  },

  // ─── 存储维护 ──────────────────────────────────────────────────────────────

  db_stats: (ctx) => {
    try {
      return ctx.storage.withDatabase((db) => dbStats(db));
    } catch (error) {
      throw badRequest(error);
    }
  },

  storage_usage_summary: (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    // Rust 命令体只读取 scanId 用于事件关联；Node 侧事件由宿主实现，这里仍校验参数。
    argString(args, "scanId");
    try {
      const dbPath = ctx.storage.dbPath();
      const capture = ctx.storage.captureDiskUsage();
      const fileMetrics: StorageUsageFileMetrics = {
        mainFileBytes: dbPath === ":memory:" ? 0 : fileBytes(dbPath),
        walBytes: dbPath === ":memory:" ? 0 : fileBytes(`${dbPath}-wal`),
        sharedMemoryBytes: dbPath === ":memory:" ? 0 : fileBytes(`${dbPath}-shm`),
        configBytes: fileBytes(ctx.configPath),
        captureFiles: capture.segments,
        captureBytes: capture.bytes,
      };
      return ctx.storage.withDatabase((db) => storageUsageSummary(db, fileMetrics));
    } catch (error) {
      throw badRequest(error);
    }
  },

  compact_database: (ctx) => {
    // Rust：代理运行中禁止压缩（重写数据库期间会积压日志写入）。
    if (ctx.proxy.status().running) {
      throw CommandError.badRequest("优化数据库前必须先暂停代理服务");
    }
    try {
      return ctx.storage.withDatabase((db) => compactDatabase(db));
    } catch (error) {
      throw badRequest(error);
    }
  },

  cleanup_expired_body_data: (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const retentionDays = argInteger(args, "retentionDays", "i64");
    try {
      return ctx.storage.cleanupExpiredBodyData(retentionDays);
    } catch (error) {
      throw badRequest(error);
    }
  },

  prune_oldest_body_data: (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const targetBytes = argInteger(args, "targetBytes", "i64");
    const pruneRatio = argFloat(args, "pruneRatio");
    try {
      return ctx.storage.pruneOldestBodyData(targetBytes, pruneRatio);
    } catch (error) {
      throw badRequest(error);
    }
  },

  get_total_body_size_bytes: (ctx) => {
    try {
      return ctx.storage.getTotalBodySizeBytes();
    } catch (error) {
      throw badRequest(error);
    }
  },

  // ─── 应用信息 / 日志 / 自启 ────────────────────────────────────────────────

  get_app_version: (ctx) => ctx.desktop.appVersion,

  get_app_data_dir: (ctx) => ctx.desktop.dataDir,

  get_app_diagnostics: (ctx) => ({
    os: rustPlatform(),
    database: "healthy",
    proxy: ctx.proxy.status().running ? "running" : "stopped",
  }),

  log_from_frontend: async (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const level = argString(args, "level");
    const message = argString(args, "message");
    await ctx.desktop.host.invoke("platform.logFromFrontend", { level, message });
    return null;
  },

  is_autostart_enabled: async (ctx) => {
    try {
      const result = await ctx.desktop.host.invoke<{ enabled?: boolean }>(
        "platform.autostart.get",
        {},
      );
      return result?.enabled === true;
    } catch (error) {
      throw CommandError.badRequest(
        `检查自启动状态失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },

  enable_autostart: async (ctx) => {
    try {
      await ctx.desktop.host.invoke("platform.autostart.set", { enabled: true });
      return null;
    } catch (error) {
      throw CommandError.badRequest(
        `启用自启动失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },

  disable_autostart: async (ctx) => {
    try {
      await ctx.desktop.host.invoke("platform.autostart.set", { enabled: false });
      return null;
    } catch (error) {
      throw CommandError.badRequest(
        `禁用自启动失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
};

/** 读取 ConfigBundle 中的结构体数组（顶层字段缺失时给出 `参数 json: missing field`）。 */
function bundleArray(
  bundle: JsonRow,
  field: string,
  structName: string,
  validate: (row: JsonRow, name: string) => void,
): JsonRow[] {
  const rows = argArray(bundle, field, structName);
  for (const row of rows) validate(row, field);
  return rows;
}

/** 把 ConfigBundle 的价格项归一为内存价格表结构（tiers/schedules 缺省为空）。 */
function normalizeModelPrice(price: JsonRow): ModelPrice {
  const tiers = Array.isArray(price.tiers) ? (price.tiers as ModelPriceTier[]) : [];
  const schedules = Array.isArray(price.schedules)
    ? (price.schedules as ModelPriceSchedule[])
    : [];
  return {
    id: String(price.id),
    channel_id: String(price.channel_id),
    upstream_model: String(price.upstream_model),
    input_uncached_price: Number(price.input_uncached_price),
    input_cached_price: Number(price.input_cached_price),
    input_cache_write_price:
      price.input_cache_write_price === null || price.input_cache_write_price === undefined
        ? null
        : Number(price.input_cache_write_price),
    output_price: Number(price.output_price),
    tiers,
    schedules,
    currency: String(price.currency),
    unit: String(price.unit),
    source_url: price.source_url === undefined ? null : (price.source_url as string | null),
    price_version:
      price.price_version === undefined ? null : (price.price_version as string | null),
    created_at: String(price.created_at),
    updated_at: String(price.updated_at),
  };
}
