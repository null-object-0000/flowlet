// Jenkins API 客户端（面向 Jenkins LTS 的 `/me/api/json` 身份端点）。Owner: node-web.
//
// 权威实现：src-tauri/src/core/jenkins.rs 逐行为等价：
// - 认证只用 HTTP Basic：`Authorization: Basic base64("{username}:{token}")`；
//   Jenkins API Token 必须与用户名一起认证，单独 token 无法确认身份；
// - 校验端点固定为 `/me/api/json`：只有登录用户自己能访问，能同时确认用户名与 token 有效；
//   `/api/json`（根信息）匿名可访问，不能用来校验凭据；
// - 版本取响应的 `X-Jenkins` 头（Jenkins 没有 GitLab 那样的 `/version` 端点）；
// - Jenkins 使用上下文路径部署（`https://host/ci`）时 `/me/api/json` 直接拼在上下文路径后，
//   因此地址归一保留子路径，**不**自动剥 `/api`、`/me`、`/api/json`；
// - 20s 超时；insecure 时跳过 TLS 校验；错误文案对齐 Rust Display。
import { Agent, request } from "undici";

const DEFAULT_TIMEOUT_MS = 20_000;
const USER_AGENT = "flowlet/0.2.0";

/** 当前凭据的身份投影：只保留用户名与 Jenkins 版本，避免把 `<me>` 大对象塞进上下文。 */
export interface JenkinsIdentity {
  username: string | null;
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
 * 规范化实例地址：口径与 Rust `normalize_base_url` 一致。
 * - 必须 http/https；
 * - 去掉末尾所有 `/`；
 * - 保留子路径部署（`https://host/ci`）；
 * - **不**自动剥 `/api`、`/me`、`/api/json`；
 * - 拒绝 query / fragment。
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

/** 把 `GET /me/api/json` 这类路径拼成完整 URL；拒绝绝对 URL，避免把凭据发到别处。 */
export function resolveApiPath(base: string, rawPath: string): string {
  const path = rawPath.trim();
  if (path === "") throw new Error("API 路径不能为空");
  if (path.startsWith("http://") || path.startsWith("https://")) {
    throw new Error("API 路径必须是相对路径（如 /me/api/json），不接受绝对 URL");
  }
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/** `Authorization` 头值：`Basic base64("{username}:{token}")`。 */
export function authorizationHeader(username: string, token: string): string {
  const encoded = Buffer.from(`${username}:${token}`, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

/** `/me/api/json` 顶层字段：`fullName` 是显示名，`id` 是登录名；优先非空 `fullName`。 */
export function parseUsername(value: unknown): string | null {
  const text = (key: string): string | null => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const item = (value as Record<string, unknown>)[key];
    if (typeof item !== "string") return null;
    const trimmed = item.trim();
    return trimmed === "" ? null : trimmed;
  };
  return text("fullName") ?? text("id");
}

/** 版本只来自 `X-Jenkins` 头；缺失或空白时返回 null，不要伪造版本。 */
export function parseVersion(header: string | undefined | null): string | null {
  if (typeof header !== "string") return null;
  const trimmed = header.trim();
  return trimmed === "" ? null : trimmed;
}

export interface JenkinsClientOptions {
  /** 内网自签证书：跳过 TLS 校验（对应 Rust `danger_accept_invalid_certs`）。 */
  insecure?: boolean;
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

  username(): string {
    return this.#username;
  }

  #dispatcher(): Agent | undefined {
    // 每个客户端实例一个 Agent，避免跨请求复用不同 TLS 策略。
    return this.#insecure ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined;
  }

  /** 通用透传：给 Agent 用任意 Jenkins JSON 端点。 */
  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const { value } = await this.#send(method, path, body);
    return value;
  }

  async #send(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ value: unknown; version: string | null }> {
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
          authorization: authorizationHeader(this.#username, this.#token),
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
    // `X-Jenkins` 是版本号的唯一来源，必须在消费 body 之前取。
    const rawVersion =
      typeof response.headers["x-jenkins"] === "string" ? response.headers["x-jenkins"] : undefined;
    const version = parseVersion(rawVersion);
    let text: string;
    try {
      text = await response.body.text();
    } catch (error) {
      throw new JenkinsError(status, `读取响应失败：${errorMessage(error)}`);
    }
    const value = parseBody(text);
    if (status < 200 || status >= 300) {
      throw new JenkinsError(status, describeError(status, value));
    }
    return { value, version };
  }

  /** `/me/api/json` 是唯一能同时确认「用户名 + API Token」有效的端点。 */
  async identity(): Promise<JenkinsIdentity> {
    const { value, version } = await this.#send("GET", "/me/api/json");
    return { username: parseUsername(value), version };
  }
}

function parseBody(text: string): unknown {
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * 把 Jenkins 的错误转成可执行提示。Jenkins 的反向代理/登录页经常返回 HTML 错误页，
 * 原始 HTML 一律不拼进 message；只有 JSON 体的 `message` / `error` 可以拼在提示前。
 * 文案与 Rust `describe_error` 逐字一致。
 */
export function describeError(status: number, value: unknown): string {
  let detail = "";
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    // 与 Rust `Value::get("message").or_else(get("error"))` 一致：键存在即采用，
    // 即使值是 null（Rust 会把它渲染成 "null"），不能按 nullish 回退。
    const item = Object.prototype.hasOwnProperty.call(row, "message") ? row.message : row.error;
    if (item !== undefined) {
      detail = typeof item === "string" ? item : JSON.stringify(item);
    }
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
  return detail.trim() === "" ? hint : `${detail}（${hint}）`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestErrorDetail(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const base = errorMessage(error);
  return cause instanceof Error ? `${base}: ${cause.message}` : base;
}