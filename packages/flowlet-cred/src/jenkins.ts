// Jenkins API 客户端（Basic 用户名 + API Token）。Owner: node-web.
//
// 权威实现：src-tauri/src/core/jenkins.rs 逐行为等价：
// - 认证只用 HTTP Basic，`Authorization: Basic base64("{username}:{token}")`；
// - 校验身份只能看 `GET /me/api/json`（Jenkins 没有独立 health 接口）；
// - 保留子路径部署（https://host/ci），且 **不** 自动剥 `/api`、`/me`、`/api/json`
//   （Jenkins 的根地址就是 Web UI 根，没有 Dockhand 那样的 `/api` 前缀）；
// - 20s 超时；insecure 时跳过 TLS 校验；错误文案对齐 Rust Display。
import { Agent, request } from "undici";

const DEFAULT_TIMEOUT_MS = 20_000;
const USER_AGENT = "flowlet/0.2.0";

/** 与 Rust `JenkinsIdentity` 同形：两者都取不到时为 null。 */
export interface JenkinsIdentity {
  /** JSON 顶层 `fullName`（非空）否则 `id`（非空），否则 null。 */
  username: string | null;
  /** 响应头 `X-Jenkins`（trim 后非空），否则 null。 */
  version: string | null;
}

/** 与 Rust `JenkinsError` 同形：Display = `Jenkins API {status}: {message}` / `Jenkins API: {message}`。 */
export class JenkinsError extends Error {
  status: number | null;

  constructor(status: number | null, message: string) {
    super(message);
    this.name = "JenkinsError";
    this.status = status;
  }

  override toString(): string {
    return this.status === null
      ? `Jenkins API: ${this.message}`
      : `Jenkins API ${this.status}: ${this.message}`;
  }
}

/**
 * 规范化 Jenkins 地址（契约 §3.3）：与 Rust `normalize_base_url` 一致。
 * - 必须 http/https；拒绝 query / fragment；
 * - 去掉末尾所有 `/`；保留子路径部署（如 https://host/ci）；
 * - 不自动剥 `/api`、`/me`、`/api/json`（Jenkins 没有统一 API 前缀）。
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error("Jenkins 地址不能为空");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Jenkins 地址无法解析：${urlParseErrorDetail(trimmed)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Jenkins 地址必须是 http 或 https");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("Jenkins 地址不能带查询参数或锚点");
  }
  // 模拟 url::Url::as_str()：小写 origin + pathname（根路径归一为 ""），再 trim 末尾斜杠。
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
  const base = `${parsed.origin}${pathname}`.replace(/\/+$/, "");
  if (base === "" || base === "https:" || base === "http:" || parsed.hostname === "") {
    throw new Error("Jenkins 地址缺少主机名");
  }
  return base;
}

function urlParseErrorDetail(raw: string): string {
  // url crate 的常见错误文本（用于保持错误信息可读且接近 Rust）。
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return "relative URL without a base";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/$/.test(raw)) return "empty host";
  return "invalid URL";
}

/**
 * 把 `GET /me/api/json` 拼成完整 URL；拒绝绝对 URL，避免把 token 发到别处。
 * PATH 原样拼在 base 后：不自动加 `/api`，仅补前导 `/`。
 */
export function resolveApiPath(base: string, rawPath: string): string {
  const path = rawPath.trim();
  if (path === "") throw new Error("API 路径不能为空");
  if (path.startsWith("http://") || path.startsWith("https://")) {
    throw new Error("API 路径必须是相对路径（如 /me/api/json），不接受绝对 URL");
  }
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export interface JenkinsClientOptions {
  /** 内网自签证书：跳过 TLS 校验（对应 Rust `danger_accept_invalid_certs`）。 */
  insecure?: boolean;
}

interface SendResult {
  status: number;
  value: unknown;
  headers: Record<string, string | string[] | undefined>;
}

export class JenkinsClient {
  #base: string;
  #username: string;
  #token: string;
  #insecure: boolean;

  constructor(url: string, username: string, token: string, options: JenkinsClientOptions = {}) {
    if (token.trim() === "") throw new Error("Jenkins token 不能为空");
    if (username.trim() === "") throw new Error("Jenkins 用户名不能为空");
    this.#base = normalizeBaseUrl(url);
    this.#username = username.trim();
    this.#token = token.trim();
    this.#insecure = options.insecure ?? false;
  }

  withInsecure(insecure: boolean): JenkinsClient {
    this.#insecure = insecure;
    return this;
  }

  base(): string {
    return this.#base;
  }

  #dispatcher(): Agent | undefined {
    // 每个客户端实例一个 Agent，避免跨请求复用不同 TLS 策略。
    return this.#insecure ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined;
  }

  #authorization(): string {
    return `Basic ${Buffer.from(`${this.#username}:${this.#token}`, "utf8").toString("base64")}`;
  }

  async #send(method: string, path: string, body?: unknown): Promise<SendResult> {
    let url: string;
    try {
      url = resolveApiPath(this.#base, path);
    } catch (error) {
      throw new JenkinsError(null, errorMessage(error));
    }
    let response;
    try {
      response = await request(url, {
        method: method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        headers: {
          authorization: this.#authorization(),
          accept: "application/json",
          "user-agent": USER_AGENT,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        dispatcher: this.#dispatcher(),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        headersTimeout: DEFAULT_TIMEOUT_MS,
        bodyTimeout: DEFAULT_TIMEOUT_MS,
      });
    } catch (error) {
      throw new JenkinsError(
        null,
        `请求 ${url} 失败：${requestErrorDetail(error)}（内网自签证书请加 --insecure）`,
      );
    }
    const status = response.statusCode;
    const headers = response.headers;
    let text: string;
    try {
      text = await response.body.text();
    } catch (error) {
      throw new JenkinsError(status, `读取响应失败：${errorMessage(error)}`);
    }
    let value: unknown;
    if (text.trim() === "") {
      value = null;
    } else {
      try {
        value = JSON.parse(text);
      } catch {
        value = text;
      }
    }
    if (status < 200 || status >= 300) {
      throw new JenkinsError(status, describeError(status, value));
    }
    return { status, value, headers };
  }

  /** 校验身份的唯一可靠方式：未认证时 `/me/api/json` 返回 401。 */
  async identity(): Promise<JenkinsIdentity> {
    const { value, headers } = await this.#send("GET", "/me/api/json");
    return {
      username: parseIdentityUsername(value),
      version: headerValue(headers, "x-jenkins"),
    };
  }

  /** 通用透传：给 Agent 用 Jenkins 已有端点（PATH 原样拼在 base 后，不自动加 /api）。 */
  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    return (await this.#send(method, path, body)).value;
  }
}

/** `fullName`（非空字符串）优先，其次 `id`（非空字符串）；都没有时为 null。 */
export function parseIdentityUsername(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  for (const key of ["fullName", "id"] as const) {
    const candidate = row[key];
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  return null;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const raw = headers[name];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== "string") return null;
  const trimmed = first.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 把 Jenkins 错误体转成可执行提示（与 Rust `describe_error` 文案一致）。
 * 不把上游 HTML 错误页塞进 message：只有 JSON 体的 `message`/`error` 才会拼在前缀。
 */
export function describeError(status: number, value: unknown): string {
  let detail = "";
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    const item = row.message ?? row.error;
    if (typeof item === "string" && item.trim() !== "") detail = item.trim();
  }
  const hint =
    status === 401
      ? "用户名或 API Token 无效，请到 Jenkins 用户设置页确认 API Token"
      : status === 403
        ? "权限不足：该 Jenkins 用户可能缺少 Overall/Read 权限"
        : status === 404
          ? "接口不存在：请确认填写的是 Jenkins 根地址（如 https://jenkins.example.com），不要带 /me 或 /api/json"
          : status === 429
            ? "触发 Jenkins 限流，稍后重试"
            : "请检查用户名、token、实例地址与网络连通性";
  return detail === "" ? hint : `${detail}（${hint}）`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestErrorDetail(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const base = errorMessage(error);
  return cause instanceof Error ? `${base}: ${cause.message}` : base;
}