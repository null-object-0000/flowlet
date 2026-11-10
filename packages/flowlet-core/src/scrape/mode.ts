// 抓取模式的解析：config.json 的 `channels_config.scrape` + 自定义描述符。
//
// 权威行为：src-tauri/src/core/scrape_console.rs 的 `resolve_scrape_mode` /
// `resolve_builtin_scrape_mode`。命令层只负责「按账号解析出抓取描述」，
// 渠道差异全部来自 config.json 与自定义描述符，不对渠道硬编码。
import type { DesktopContext } from "../desktop/types.ts";
import type { JsonRow } from "../types.ts";
import { customScrapeRegistry, resolveCustomScrapeMode } from "./custom-registry.ts";
import { consoleScrapeModeKey, defaultResourceMode, type ScrapeMode } from "./slot-engine.ts";

/** config.json 的 `channels_config`（Web 与桌面上下文都只保存这一层）。 */
export function channelsConfigSection(ctx: DesktopContext): JsonRow {
  const value = ctx.channelsConfig;
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Rust `ChannelsConfig::scrape_config`：先取 `channels[]` 的 id，再取该渠道的 mode。 */
export function builtinScrapeModeConfig(
  ctx: DesktopContext,
  channelId: string,
  modeKey: string,
): JsonRow | null {
  const channels = channelsConfigSection(ctx).channels;
  if (!Array.isArray(channels)) return null;
  const channel = (channels as JsonRow[]).find((item) => item?.id === channelId);
  if (channel === undefined || channel === null) return null;
  const scrape = channel.scrape;
  if (scrape === null || typeof scrape !== "object" || Array.isArray(scrape)) return null;
  const mode = (scrape as JsonRow)[modeKey];
  if (mode === null || typeof mode !== "object" || Array.isArray(mode)) return null;
  return mode as JsonRow;
}

/** 渠道预设（`channels_config.channels[]`）。 */
export function channelPreset(ctx: DesktopContext, channelId: string): JsonRow | null {
  const channels = channelsConfigSection(ctx).channels;
  if (!Array.isArray(channels)) return null;
  const preset = (channels as JsonRow[]).find((item) => item?.id === channelId);
  return preset === undefined ? null : preset;
}

/** Rust `ChannelPreset::supports_scrape_balance`。 */
export function presetSupportsScrape(ctx: DesktopContext, channelId: string): boolean {
  return channelPreset(ctx, channelId)?.supports_scrape_balance === true;
}

/** Rust `ChannelPreset::supports_balance_query`。 */
export function presetSupportsBalanceQuery(ctx: DesktopContext, channelId: string): boolean {
  return channelPreset(ctx, channelId)?.supports_balance_query === true;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Rust `resolve_scrape_mode`：先查内置渠道抓取配置，再回退到自定义描述符。
 *
 * `resourceMode` 为空或无法映射时回退到渠道默认资源模式（与前端
 * `defaultResourceMode` 一致），避免把合法账号误判为「不支持控制台抓取」。
 */
export function resolveScrapeMode(
  ctx: DesktopContext,
  channelId: string,
  resourceMode: string | null,
  accountName: string | null,
): ScrapeMode | null {
  const builtin = resolveBuiltinScrapeMode(ctx, channelId, resourceMode);
  if (builtin !== null) return builtin;
  const custom = resolveCustomScrapeMode(channelId, accountName, resourceMode, customScrapeRegistry());
  if (custom === null) return null;
  return {
    consoleUrl: custom.consoleUrl,
    consoleUrlSecondary: custom.consoleUrlSecondary,
    consoleUrlTertiary: custom.consoleUrlTertiary,
    interceptorJs: custom.interceptorJs,
    extractorJs: custom.extractorJs,
    aggregate: custom.aggregate,
    requiredSlots: custom.requiredSlots,
    slotRules: custom.slots,
    login: custom.login,
    summaryPlan: custom.summary.plan,
  };
}

function resolveBuiltinScrapeMode(
  ctx: DesktopContext,
  channelId: string,
  resourceMode: string | null,
): ScrapeMode | null {
  if (!presetSupportsScrape(ctx, channelId)) return null;
  const modeKey =
    consoleScrapeModeKey(channelId, resourceMode) ??
    consoleScrapeModeKey(channelId, defaultResourceMode(channelId));
  if (modeKey === null) return null;
  const config = builtinScrapeModeConfig(ctx, channelId, modeKey);
  if (config === null) return null;
  return {
    consoleUrl: stringOrEmpty(config.console_url),
    consoleUrlSecondary: stringOrNull(config.console_url_secondary),
    consoleUrlTertiary: stringOrNull(config.console_url_tertiary),
    interceptorJs: stringOrEmpty(config.interceptor_js),
    extractorJs: stringOrEmpty(config.extractor_js),
    aggregate: config.aggregate === true,
    requiredSlots: stringArray(config.required_slots),
    slotRules: null,
    login: null,
    summaryPlan: null,
  };
}