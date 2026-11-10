// Upstream transport: undici dispatchers, timeouts, cancellation and retry.
//
// 关键约束（proxy-core.md §5.3）：
// - 绝不用 fetch（会自动解压并改写 content-encoding）；undici.request 原样返回压缩字节。
// - 超时自己实现（headers 超时 / 缓冲体超时 / 流式每块空闲超时），不依赖 undici 语义。
// - 上游代理失败必须作为原候选的网络错误，绝不静默改直连；显式代理连接失败只重试一次。
import { Agent, EnvHttpProxyAgent, ProxyAgent, request, type Dispatcher } from "undici";
import type { Readable } from "node:stream";
import { isRecord } from "./util.ts";

export interface UpstreamProxySettings {
  enabled: boolean;
  url: string;
}

export interface UpstreamResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: Readable;
}

export type ForwardErrorKind = "network" | "timeout" | "proxy_configuration";

/** 与 Rust `ProxyForwardError` 对应的错误类型（route_reason 由 kind/phase 派生）。 */
export class ForwardError extends Error {
  readonly kind: ForwardErrorKind;
  readonly phase: string;
  readonly causeValue: unknown;

  constructor(kind: ForwardErrorKind, phase: string, detail: string, causeValue?: unknown) {
    super(detail);
    this.name = "ForwardError";
    this.kind = kind;
    this.phase = phase;
    this.causeValue = causeValue;
  }

  get routeReason(): string {
    if (this.kind === "timeout") return "timeout";
    if (this.kind === "proxy_configuration") return "upstream_proxy_configuration_error";
    return "network_error";
  }

  static timeout(phase: string, timeoutSeconds: number): ForwardError {
    return new ForwardError("timeout", phase, `上游${phase}等待超过 ${timeoutSeconds} 秒`);
  }

  static network(error: unknown): ForwardError {
    const detail = error instanceof Error ? error.message : String(error);
    return new ForwardError("network", "网络", detail, error);
  }

  static proxyConfiguration(detail: string): ForwardError {
    return new ForwardError("proxy_configuration", "上游代理", detail);
  }
}

export function normalizeProxySettings(raw: unknown): UpstreamProxySettings {
  if (!isRecord(raw)) return { enabled: false, url: "" };
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const enabled = raw.enabled === true && url !== "";
  return { enabled, url };
}

function validateProxySettings(settings: UpstreamProxySettings): void {
  if (!settings.enabled) return;
  const url = settings.url.trim();
  if (url === "") throw ForwardError.proxyConfiguration("上游代理地址不能为空");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw ForwardError.proxyConfiguration(
      `上游代理地址无效：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw ForwardError.proxyConfiguration("仅支持 http/https 上游代理（不支持 socks 代理）");
  }
}

/** 与 Rust 渠道能力声明一致：当前只有 openai-api 渠道历史上默认走上游代理。 */
const LEGACY_PROXY_CHANNELS = new Set(["openai-api"]);

export interface SelectedClient {
  dispatcher: Dispatcher;
  proxyUsed: boolean | null;
  retryConnect: boolean;
}

const CONNECT_TIMEOUT_MS = 10_000;
const KEEP_ALIVE_TIMEOUT_MS = 60_000;

export class UpstreamTransport {
  #direct: Agent;
  #systemProxy: EnvHttpProxyAgent;
  #proxyAgents = new Map<string, ProxyAgent>();
  #closed = false;

  constructor() {
    const common = {
      connect: { timeout: CONNECT_TIMEOUT_MS },
      keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
      keepAliveMaxTimeout: 600_000,
    } as const;
    this.#direct = new Agent(common);
    // Node/undici 默认完全不用系统代理，而 Rust reqwest 默认使用；用 EnvHttpProxyAgent
    // 近似 http_proxy/https_proxy/no_proxy 语义（平台系统设置仍需后续补齐）。
    this.#systemProxy = new EnvHttpProxyAgent(common);
  }

  /** 按账号/全局配置选择 dispatcher（Rust `model_forwarding_client`）。 */
  select(account: {
    channel_id: string;
    use_upstream_proxy: boolean | null;
  }, global: UpstreamProxySettings, url: string): SelectedClient {
    if (this.#closed) throw ForwardError.network(new Error("上游连接池已关闭"));
    const legacyUsesProxy = LEGACY_PROXY_CHANNELS.has(account.channel_id);
    const enabled =
      account.use_upstream_proxy ??
      (global.enabled && global.url !== "" && legacyUsesProxy);
    const settings: UpstreamProxySettings = { enabled, url: global.url };

    if (account.use_upstream_proxy === false) {
      return { dispatcher: this.#direct, proxyUsed: false, retryConnect: false };
    }
    if (!settings.enabled) {
      return { dispatcher: this.#systemProxy, proxyUsed: systemProxyUsed(url), retryConnect: false };
    }
    validateProxySettings(settings);
    const key = settings.url.trim();
    let agent = this.#proxyAgents.get(key);
    if (!agent) {
      agent = new ProxyAgent({
        uri: key,
        connect: { timeout: CONNECT_TIMEOUT_MS },
        keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
      });
      this.#proxyAgents.set(key, agent);
    }
    return { dispatcher: agent, proxyUsed: true, retryConnect: true };
  }

  /**
   * 发起上游请求；只等待到响应头返回。显式代理连接失败重试一次（150ms 退避），
   * 整个重试在同一个外层超时内。
   */
  async execute(options: {
    method: string;
    url: string;
    headers: Record<string, string | string[]>;
    body: Buffer | null;
    dispatcher: Dispatcher;
    timeoutSeconds: number;
    timeoutPhase: string;
    retryConnect: boolean;
    channelId: string;
  }): Promise<UpstreamResponse> {
    const timeoutMs = options.timeoutSeconds * 1000;
    const deadline = Date.now() + timeoutMs;

    const attempt = async (): Promise<UpstreamResponse> => {
      const remaining = Math.max(deadline - Date.now(), 1);
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, remaining);
      try {
        const response = await request(options.url, {
          method: options.method as Dispatcher.HttpMethod,
          headers: options.headers,
          body: options.body ?? undefined,
          dispatcher: options.dispatcher,
          signal: controller.signal,
          // 使用自建超时，禁用 undici 默认语义。
          headersTimeout: 0,
          bodyTimeout: 0,
        });
        return {
          statusCode: response.statusCode,
          headers: response.headers as Record<string, string | string[]>,
          body: response.body,
        };
      } catch (error) {
        if (timedOut) throw ForwardError.timeout(options.timeoutPhase, options.timeoutSeconds);
        throw ForwardError.network(error);
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      return await attempt();
    } catch (error) {
      if (
        error instanceof ForwardError &&
        error.kind === "network" &&
        options.retryConnect &&
        isConnectError(error.causeValue)
      ) {
        await sleep(150);
        return attempt();
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const agents: Dispatcher[] = [this.#direct, this.#systemProxy, ...this.#proxyAgents.values()];
    this.#proxyAgents.clear();
    await Promise.all(
      agents.map(async (agent) => {
        try {
          await agent.close();
        } catch {
          /* 关闭失败不影响进程退出 */
        }
      }),
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export function isConnectError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const code = typeof error.code === "string" ? error.code : undefined;
  if (code !== undefined && CONNECT_ERROR_CODES.has(code)) return true;
  const name = typeof error.name === "string" ? error.name : "";
  if (name === "ConnectTimeoutError") return true;
  if (isRecord(error.cause) && isConnectError(error.cause)) return true;
  return false;
}

/** 读取整个上游响应体（绝对超时，Rust `read_buffered_body`）。 */
export function readBodyWithTimeout(body: Readable, timeoutSeconds: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      body.destroy();
      action();
    };
    const timer = setTimeout(() => {
      finish(() => reject(ForwardError.timeout("响应体", timeoutSeconds)));
    }, timeoutSeconds * 1000);
    body.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    body.on("end", () => {
      finish(() => resolve(Buffer.concat(chunks)));
    });
    body.on("error", (error: unknown) => {
      finish(() => reject(ForwardError.network(error)));
    });
  });
}

/** 连接失败时对 OpenAI 渠道保留 cause 细节（Rust `model_network_error`）。 */
export function modelNetworkError(channelId: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (!LEGACY_PROXY_CHANNELS.has(channelId)) return detail;
  return `${detail} [after_connect]`;
}

// ─── System proxy detection (env 近似) ─────────────────────────────────────

function envValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function noProxyMatches(host: string, port: number, pattern: string): boolean {
  const hostLower = host.toLowerCase();
  const portText = String(port);
  for (const rawToken of pattern.split(",")) {
    let token = rawToken.trim().toLowerCase();
    if (token === "") continue;
    if (token === "*") return true;
    let tokenPort: string | undefined;
    const colon = token.lastIndexOf(":");
    if (colon > 0 && !token.startsWith("[")) {
      tokenPort = token.slice(colon + 1);
      token = token.slice(0, colon);
    }
    if (tokenPort !== undefined && tokenPort !== portText) continue;
    if (token.startsWith(".")) token = token.slice(1);
    if (hostLower === token || hostLower.endsWith(`.${token}`)) return true;
  }
  return false;
}

/** 近似 Rust `Matcher::from_system`：环境变量代理是否作用于该 URL。 */
export function systemProxyUsed(url: string): boolean | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const noProxy = envValue("no_proxy", "NO_PROXY");
  const port = parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port);
  if (noProxy !== undefined && noProxyMatches(parsed.hostname, port, noProxy)) return false;
  const proxy =
    parsed.protocol === "https:"
      ? envValue("https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY")
      : envValue("http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY");
  return proxy !== undefined;
}
