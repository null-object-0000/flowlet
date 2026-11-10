// Agent 桌面命令的最小 HTTP 客户端（npm registry、ChatGPT usage、Google/Antigravity）。
//
// Rust 侧使用 `reqwest` + 全局上游代理配置。Node 侧复用 `undici`：
// - 未显式启用上游代理时使用 `EnvHttpProxyAgent`（近似 reqwest 的 env 代理行为）；
// - 显式启用时使用 `ProxyAgent`；
// - Antigravity 本地回环 https 自签证书需要 `rejectUnauthorized: false`。
import { Agent, EnvHttpProxyAgent, ProxyAgent, request, type Dispatcher } from "undici";

export interface AgentProxySettings {
  enabled: boolean;
  url: string;
}

let envDispatcher: EnvHttpProxyAgent | null = null;
let insecureDispatcher: Agent | null = null;
const proxyDispatchers = new Map<string, ProxyAgent>();

function dispatcherFor(proxy: AgentProxySettings | null | undefined, insecure: boolean): Dispatcher {
  if (insecure) {
    insecureDispatcher ??= new Agent({ connect: { rejectUnauthorized: false }, keepAliveTimeout: 10_000 });
    return insecureDispatcher;
  }
  if (proxy !== null && proxy !== undefined && proxy.enabled && proxy.url.trim() !== "") {
    const url = proxy.url.trim();
    let dispatcher = proxyDispatchers.get(url);
    if (dispatcher === undefined) {
      dispatcher = new ProxyAgent({ uri: url, keepAliveTimeout: 10_000 });
      proxyDispatchers.set(url, dispatcher);
    }
    return dispatcher;
  }
  envDispatcher ??= new EnvHttpProxyAgent({ keepAliveTimeout: 10_000 });
  return envDispatcher;
}

export interface HttpJsonOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  proxy?: AgentProxySettings | null;
  insecure?: boolean;
}

export interface HttpJsonResponse {
  status: number;
  value: unknown;
  text: string;
}

/** 发起 HTTP 请求并解析 JSON；非 2xx 也会返回（由调用方决定错误语义）。 */
export async function httpJson(url: string, options: HttpJsonOptions): Promise<HttpJsonResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await request(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      dispatcher: dispatcherFor(options.proxy, options.insecure === true),
      signal: controller.signal,
      headersTimeout: options.timeoutMs,
      bodyTimeout: options.timeoutMs,
    });
    const text = await response.body.text();
    let value: unknown = null;
    try {
      value = text === "" ? null : JSON.parse(text);
    } catch {
      value = null;
    }
    return { status: response.statusCode, value, text };
  } finally {
    clearTimeout(timer);
  }
}

/** 把网络异常转成 Rust 风格的可读消息片段（不包含 URL/凭据）。 */
export function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError" || /abort/iu.test(error.message)) return "请求超时";
    return error.message;
  }
  return String(error);
}