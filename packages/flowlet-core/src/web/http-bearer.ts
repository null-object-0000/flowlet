// 通用 HTTP Bearer 凭据客户端（「一个地址 + 一把 Bearer token」的三方服务）。
// Owner: node-web。
//
// 权威实现：src-tauri/src/core/http_bearer.rs 逐行为等价（各包独立副本，互相不依赖）：
// - 地址保留子路径部署（https://host/files），丢弃 fragment；拒绝 query 与账号密码；
// - 认证头 `Authorization: Bearer <token>`；
// - 校验打两次（带 token / 不带），401/403 → 失败；带 token 2xx 而匿名也 2xx →
//   地址不需要认证，无法证明 token 有效，如实标注而不是谎报通过；
// - 不跟随重定向，避免把 token 发到别处；10s 超时；insecure 时跳过 TLS 校验。
import { Agent, request } from "undici";

const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT = "flowlet/0.2.0";

/** 与 Rust `HttpBearerError` 同形：Display = `HTTP Bearer API {status}: {message}`。 */
export class HttpBearerError extends Error {
  status: number | null;

  constructor(status: number | null, message: string) {
    super(message);
    this.name = "HttpBearerError";
    this.status = status;
  }

  override toString(): string {
    return this.status === null
      ? `HTTP Bearer API: ${this.message}`
      : `HTTP Bearer API ${this.status}: ${this.message}`;
  }
}

export interface HttpBearerProbe {
  /** 带 token 请求的状态码。 */
  status: number;
  /** 不带 token 时是否同样能访问（true = 无法从响应证明 token 有效）。 */
  anonymousAccessible: boolean;
  /** 该路径没有端点（HTTP 404/405）：地址可达，但无法据此判断 token。 */
  endpointMissing: boolean;
}

/**
 * 规范化实例地址：与 Rust `normalize_base_url` 一致。
 * - 必须 http/https；
 * - 丢弃 fragment；拒绝 query 与账号密码；
 * - 去掉末尾所有 `/`；保留子路径部署（`https://host/files`）。
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error("地址不能为空");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`地址无法解析：${trimmed}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("地址必须以 http:// 或 https:// 开头");
  }
  if (parsed.search !== "" || parsed.username !== "" || parsed.password !== "") {
    throw new Error("地址不能带查询参数或账号密码");
  }
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
  const base = `${parsed.origin}${pathname}`.replace(/\/+$/, "");
  if (base === "" || parsed.hostname === "") throw new Error("地址缺少主机名");
  return base;
}

export function authorizationHeader(token: string): string {
  return `Bearer ${token}`;
}

export interface HttpBearerClientOptions {
  /** 内网自签证书：跳过 TLS 校验（对应 Rust `danger_accept_invalid_certs`）。 */
  insecure?: boolean;
}

export class HttpBearerClient {
  #base: string;
  #token: string;
  #insecure: boolean;

  constructor(url: string, token: string, options: HttpBearerClientOptions = {}) {
    if (token.trim() === "") throw new Error("Token 不能为空");
    this.#base = normalizeBaseUrl(url);
    this.#token = token.trim();
    this.#insecure = options.insecure ?? false;
  }

  base(): string {
    return this.#base;
  }

  async #probeOnce(url: string, token: string | null): Promise<number> {
    const headers: Record<string, string> = { accept: "application/json, */*;q=0.8" };
    if (token !== null) headers.authorization = authorizationHeader(token);
    let response: Awaited<ReturnType<typeof request>>;
    try {
      response = await request(url, {
        method: "GET",
        headers: { ...headers, "user-agent": USER_AGENT },
        dispatcher: this.#insecure
          ? new Agent({ connect: { rejectUnauthorized: false } })
          : undefined,
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        headersTimeout: DEFAULT_TIMEOUT_MS,
        bodyTimeout: DEFAULT_TIMEOUT_MS,
      });
    } catch (error) {
      throw new HttpBearerError(
        null,
        `请求 ${this.#base} 失败：${errorMessage(error)}（内网自签证书请加 --insecure）`,
      );
    }
    // 丢掉响应体，避免连接泄漏。
    await response.body.dump();
    return response.statusCode;
  }

  async probe(): Promise<HttpBearerProbe> {
    // 子路径部署（https://host/files）常见「无斜杠 → 301 到带斜杠」的重定向，
    // 所以 3xx 时在同一地址上补一个 `/` 重试（不跟随 Location，token 不会因此
    // 发到别处），成功就用那次的结果。
    let target = this.#base;
    let status = await this.#probeOnce(target, this.#token);
    if (status >= 300 && status < 400 && !target.endsWith("/")) {
      const withSlash = `${target}/`;
      const retried = await this.#probeOnce(withSlash, this.#token);
      if (retried >= 200 && retried < 300) {
        target = withSlash;
        status = retried;
      }
    }
    if (status >= 300 && status < 400) {
      throw new HttpBearerError(
        status,
        `${target} 返回重定向（HTTP ${status}）：请直接填写最终地址；凭据不会跟随重定向`,
      );
    }
    if (status === 401 || status === 403) {
      throw new HttpBearerError(
        status,
        `已拒绝这把 token（HTTP ${status}），请确认 token 是否有效或已过期`,
      );
    }
    if (status === 404 || status === 405) {
      // 通用 provider 猜不到服务的端点布局：裸根 404 很常见
      // （https://api.cloudflare.com/client/v4 就是），这不能说明 token 无效。
      return { status, anonymousAccessible: false, endpointMissing: true };
    }
    if (status < 200 || status >= 300) {
      throw new HttpBearerError(
        status,
        `${target} 返回 HTTP ${status}：请检查实例地址与网络连通性`,
      );
    }

    let anonymousAccessible = false;
    try {
      const anonymous = await this.#probeOnce(target, null);
      anonymousAccessible = anonymous >= 200 && anonymous < 300;
    } catch {
      // 对照请求失败（网络/证书）按「匿名不可访问」处理，与 Rust 侧一致。
    }
    return { status, anonymousAccessible, endpointMissing: false };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}