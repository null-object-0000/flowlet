// 出口 HTTP 请求（Web 管理命令中的网络能力）。Owner: node-web.
//
// 迁移说明：Rust 命令用 reqwest；Node 侧统一走 undici。上游代理语义
// （docs/migration/proxy-core.md R6 / AGENTS.md §5）：账号显式 use_upstream_proxy
// 优先，未声明时仅 openai-api 这类 Adapter 声明代理转发的渠道沿用全局代理。
import { ProxyAgent, request, type Dispatcher } from "undici";

import type { JsonRow } from "../types.ts";
import type { UpstreamProxyConfig } from "./config-state.ts";

export interface UpstreamResponse {
  status: number;
  body: string;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  proxy?: UpstreamProxyConfig;
  /** 账号是否使用上游代理（None 时由渠道 Adapter 策略决定）。 */
  useUpstreamProxy?: boolean | null;
  channelId?: string;
  method?: "GET" | "POST";
}

/** 仅 ChatGPT API 适配器声明「模型转发默认使用全局代理」的既有策略。 */
const LEGACY_PROXY_CHANNELS = new Set(["openai-api"]);

function shouldUseProxy(options: RequestOptions): boolean {
  if (options.useUpstreamProxy === false) return false;
  if (!options.proxy?.enabled) return false;
  if (options.useUpstreamProxy === true) return true;
  return LEGACY_PROXY_CHANNELS.has(options.channelId ?? "");
}

export function dispatcherFor(options: RequestOptions): Dispatcher | undefined {
  if (!shouldUseProxy(options)) return undefined;
  return new ProxyAgent(options.proxy?.url ?? "");
}

/** 统一的 GET 请求；网络异常抛 Error（由命令层转成 400 command_failed）。 */
export async function getUpstream(url: string, options: RequestOptions = {}): Promise<UpstreamResponse> {
  const dispatcher = dispatcherFor(options);
  const abort = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const response = await request(url, {
    method: options.method ?? "GET",
    headers: { accept: "application/json", ...(options.headers ?? {}) },
    dispatcher,
    signal: abort,
    headersTimeout: options.timeoutMs ?? 15_000,
    bodyTimeout: options.timeoutMs ?? 15_000,
  });
  const body = await response.body.text();
  return { status: response.statusCode, body };
}

/** 网络错误文案（reqwest 的详细错误链无法逐字复刻，保留可读摘要）。 */
export function requestErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
  }
  return String(error);
}

/** 从 runtimeConfig snapshot 里按 id 找账号。 */
export function findAccount(runtimeConfig: JsonRow, accountId: string): JsonRow | null {
  const accounts = runtimeConfig.accounts;
  if (!Array.isArray(accounts)) return null;
  return (accounts as JsonRow[]).find((account) => account?.id === accountId) ?? null;
}