// Web Host 进程级配置：log_capture / upstream_proxy / bind config。Owner: node-web.
//
// 初始化顺序与 Rust `FlowletServices::open` 一致：
// - `log_capture_config`：app_meta 优先（严格 serde 解析失败则回落），缺失回落 config.json.log_capture；
// - `upstream_proxy_config`：app_meta 优先，缺失回落 config.json.network.upstream_proxy。
// 保存命令只写回 app_meta（与 core/web/commands.rs 一致），进程内状态同步更新。
import { readFileSync } from "node:fs";

import type { ProxyBindConfig } from "../types.ts";
import type { JsonRow } from "../types.ts";
import type { SqliteStorage } from "../storage/index.ts";
import {
  defaultLogCaptureConfig,
  extractLogCapture as extractLogCaptureConfig,
  loadLogCaptureConfig,
  loadUpstreamProxyConfig,
  normalizeUpstreamProxyConfig,
  validateUpstreamProxyConfig,
} from "../config/index.ts";
import { argError, argObject, invalidType, requireFields } from "./errors.ts";

export const LOG_CAPTURE_META_KEY = "log_capture_config";
export const UPSTREAM_PROXY_META_KEY = "upstream_proxy_config";

export type LogCaptureConfig = {
  capture_req_headers: boolean;
  capture_req_body: boolean;
  capture_res_headers: boolean;
  capture_res_body: boolean;
  max_body_bytes: number;
  redact_sensitive_headers: boolean;
  body_retention_days: number;
  body_max_size_mb: number;
  body_prune_ratio: number;
};

export type UpstreamProxyConfig = {
  enabled: boolean;
  url: string;
};

export const DEFAULT_LOG_CAPTURE: LogCaptureConfig = defaultLogCaptureConfig() as LogCaptureConfig;

const LOG_CAPTURE_FIELDS = Object.keys(DEFAULT_LOG_CAPTURE) as (keyof LogCaptureConfig)[];

/** 读取 config.json 原文；失败返回空对象（Rust 侧 read_config_raw 失败同样是 None）。 */
export function readConfigJson(configPath: string): JsonRow {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRow)
      : {};
  } catch {
    return {};
  }
}

/** Rust `extract_log_capture`：config.json 的 log_capture 缺失字段逐个回落默认值。 */
export function extractLogCapture(config: JsonRow): LogCaptureConfig {
  return extractLogCaptureConfig(config) as LogCaptureConfig;
}

/** 严格 serde 解析（app_meta 中的 LogCaptureConfig 必须包含全部字段）。 */
export function parseStoredLogCapture(raw: string): LogCaptureConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as JsonRow;
  for (const field of LOG_CAPTURE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(obj, field)) return null;
  }
  return { ...(obj as LogCaptureConfig) };
}

export function resolveLogCaptureConfig(storage: SqliteStorage, config: JsonRow): LogCaptureConfig {
  return loadLogCaptureConfig(storage, config) as LogCaptureConfig;
}

/** `set_log_capture_config` 参数解析（serde 结构体：9 个字段全必填）。 */
export function parseLogCaptureArg(args: JsonRow): LogCaptureConfig {
  const value = argObject(args, "config", "LogCaptureConfig");
  requireFields(value, "config", LOG_CAPTURE_FIELDS as string[]);
  for (const field of LOG_CAPTURE_FIELDS) {
    const raw = value[field];
    if (field === "body_prune_ratio") {
      if (typeof raw !== "number") throw argError("config", `field \`${field}\`: invalid type: ${describe(raw)}, expected f64`);
    } else if (field === "max_body_bytes" || field === "body_retention_days" || field === "body_max_size_mb") {
      if (typeof raw !== "number" || !Number.isInteger(raw)) {
        throw argError("config", `field \`${field}\`: invalid type: ${describe(raw)}, expected i64`);
      }
    } else if (typeof raw !== "boolean") {
      throw argError("config", `field \`${field}\`: invalid type: ${describe(raw)}, expected a boolean`);
    }
  }
  return { ...(value as LogCaptureConfig) };
}

function describe(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  if (typeof value === "number") return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
  if (typeof value === "boolean") return `boolean \`${value}\``;
  return Array.isArray(value) ? "sequence" : "map";
}

// ─── Upstream proxy ─────────────────────────────────────────────────────────

/** Rust `UpstreamProxyConfig::normalized`（url 去空白，空 url → disabled）。 */
export function normalizeUpstreamProxy(config: Partial<UpstreamProxyConfig>): UpstreamProxyConfig {
  return normalizeUpstreamProxyConfig(config) as UpstreamProxyConfig;
}

export function resolveUpstreamProxyConfig(
  storage: SqliteStorage,
  config: JsonRow,
): UpstreamProxyConfig {
  return loadUpstreamProxyConfig(storage, config) as UpstreamProxyConfig;
}

/** `set_upstream_proxy_config` 参数解析（字段均有 serde default）。 */
export function parseUpstreamProxyArg(args: JsonRow): UpstreamProxyConfig {
  const value = argObject(args, "config", "UpstreamProxyConfig");
  const enabled = value.enabled;
  const url = value.url;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw argError("config", `field \`enabled\`: invalid type: ${describe(enabled)}, expected a boolean`);
  }
  if (url !== undefined && typeof url !== "string") {
    throw argError("config", `field \`url\`: invalid type: ${describe(url)}, expected a string`);
  }
  return normalizeUpstreamProxy({ enabled: enabled === true, url: typeof url === "string" ? url : "" });
}

/** Rust `UpstreamProxyConfig::validate`（错误文本逐字一致）。 */
export function validateUpstreamProxy(config: UpstreamProxyConfig): void {
  validateUpstreamProxyConfig(config);
}

// ─── Proxy bind config ──────────────────────────────────────────────────────

export const DEFAULT_CLIENT_TOKEN = "flowlet-local-token";

/** Rust `ProxyBindConfig::normalized`：host 由 allow_lan 决定，port 0 → 18640。 */
export function normalizeBindConfig(config: ProxyBindConfig): ProxyBindConfig {
  return {
    host: config.allow_lan ? "0.0.0.0" : "127.0.0.1",
    port: config.port === 0 ? 18640 : config.port,
    allow_lan: config.allow_lan,
    default_client_token: config.default_client_token,
  };
}

/** Rust `set_bind_config` 的校验：监听地址必须能 parse 成 SocketAddr。 */
export function validateBindConfig(config: ProxyBindConfig): void {
  const addr = `${config.host}:${config.port}`;
  if (!isSocketAddr(addr)) {
    throw CommandBindError();
  }
}

function CommandBindError(): Error {
  // 保持与 Rust 相同的错误文本 / 形状（400 command_failed）。
  const error = new Error("代理监听地址无效") as Error & { status?: number; code?: string };
  error.status = 400;
  error.code = "command_failed";
  return error;
}

function isSocketAddr(addr: string): boolean {
  const match = /^([^:]*):(\d+)$/.exec(addr);
  if (!match) return false;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port > 65535) return false;
  const host = match[1];
  if (host === "") return false;
  if (host.includes(":")) return false; // IPv6 原样形式不在 Web 场景使用
  return true;
}

/** `set_proxy_bind_config` 参数解析（default_client_token 有 serde default）。 */
export function parseBindConfigArg(args: JsonRow): ProxyBindConfig {
  const value = argObject(args, "config", "ProxyBindConfig");
  requireFields(value, "config", ["host", "port", "allow_lan"]);
  if (typeof value.host !== "string") {
    throw argError("config", `field \`host\`: invalid type: ${describe(value.host)}, expected a string`);
  }
  if (typeof value.port !== "number" || !Number.isInteger(value.port)) {
    throw argError("config", `field \`port\`: invalid type: ${describe(value.port)}, expected u16`);
  }
  if (value.port < 0 || value.port > 65535) {
    throw argError("config", `field \`port\`: invalid value: integer \`${value.port}\`, expected u16`);
  }
  if (typeof value.allow_lan !== "boolean") {
    throw argError("config", `field \`allow_lan\`: invalid type: ${describe(value.allow_lan)}, expected a boolean`);
  }
  if (value.default_client_token !== undefined && typeof value.default_client_token !== "string") {
    throw invalidType(value.default_client_token, "a string", "config");
  }
  return {
    host: value.host,
    port: value.port,
    allow_lan: value.allow_lan,
    default_client_token:
      typeof value.default_client_token === "string" ? value.default_client_token : DEFAULT_CLIENT_TOKEN,
  };
}

// ─── Channels config（models 端点解析） ─────────────────────────────────────

export function readChannelsConfig(config: JsonRow): JsonRow {
  const value = config.channels_config;
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRow) : {};
}

/** Rust `sync::openai_models_url`。 */
export function openaiModelsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
}

/** Rust `ChannelsConfig::models_endpoint_url`（账号级 Base URL 覆盖优先）。 */
export function modelsEndpointUrl(channelsConfig: JsonRow, channelId: string): string | null {
  const endpoints = channelsConfig.endpoints;
  if (endpoints !== null && typeof endpoints === "object" && !Array.isArray(endpoints)) {
    const overrides = (endpoints as JsonRow)[channelId];
    if (overrides !== null && typeof overrides === "object" && !Array.isArray(overrides)) {
      const url = (overrides as JsonRow).models;
      if (typeof url === "string") return url;
    }
  }
  const presets = channelsConfig.channels;
  if (!Array.isArray(presets)) return null;
  const preset = presets.find((item) => item !== null && typeof item === "object" && (item as JsonRow).id === channelId);
  if (!preset) return null;
  const base = typeof (preset as JsonRow).openai_base_url === "string" ? ((preset as JsonRow).openai_base_url as string) : "";
  const trimmed = base.replace(/\/+$/, "");
  switch (channelId) {
    case "kimi":
    case "deepseek":
      return `${base}/models`;
    case "qwen":
    case "zhipu":
    case "openrouter":
    case "vibetoken":
      return `${trimmed}/models`;
    default:
      return `${base}/v1/models`;
  }
}

/** Rust `account_models_url` / test_connection 的 URL 解析（account override 优先）。 */
export function accountModelsUrl(account: JsonRow, channelsConfig: JsonRow): string | null {
  const override = effectiveOpenaiBaseUrl(account);
  if (override) return openaiModelsUrl(override);
  return modelsEndpointUrl(channelsConfig, String(account.channel_id ?? ""));
}

export function effectiveOpenaiBaseUrl(account: JsonRow): string | null {
  const own = account.base_url_override;
  if (typeof own === "string" && own.trim() !== "") return own.trim();
  const shared = account.workspace_default_base_url;
  if (typeof shared === "string" && shared.trim() !== "") return shared.trim();
  return null;
}

/** 渠道是否声明支持官方余额查询（与内置 preset 的 supports_balance_query 对齐）。 */
export function presetSupportsBalance(runtimeConfig: JsonRow, channelId: string): boolean {
  const channels = runtimeConfig.channels;
  if (!Array.isArray(channels)) return false;
  return channels.some(
    (preset) =>
      preset !== null &&
      typeof preset === "object" &&
      (preset as JsonRow).id === channelId &&
      (preset as JsonRow).supports_balance_query === true,
  );
}