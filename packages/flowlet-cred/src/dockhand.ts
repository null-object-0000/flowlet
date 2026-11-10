// Dockhand API 客户端（公司内部 fnsys/dockhand Docker 管理面板）。Owner: node-web.
//
// 权威实现：src-tauri/src/core/dockhand.rs 逐行为等价：
// - 认证只用 `Authorization: Bearer <API Token>`；
// - 校验 token 只能看 `GET /api/environments`（`/api/health` 匿名可访问，不能证明 token 有效）；
// - 除 `/environments`、`/health` 外的资源接口都要 `?env=<id>`；
// - 允许子路径部署（https://host/dockhand），也接受用户粘贴 /api 后缀；
// - 20s 超时；insecure 时跳过 TLS 校验；错误文案对齐 Rust Display。
import { Agent, request } from "undici";

const DEFAULT_TIMEOUT_MS = 20_000;
const USER_AGENT = "flowlet/0.2.0";

/** 与 Rust `DockhandEnvironment` 同形：字段缺失时 host/port/protocol 为 null。 */
export interface DockhandEnvironment {
  id: number;
  name: string;
  host: string | null;
  port: number | null;
  protocol: string | null;
}

/** 与 Rust `DockhandError` 同形：Display = `Dockhand API {status}: {message}` / `Dockhand API: {message}`。 */
export class DockhandError extends Error {
  status: number | null;

  constructor(status: number | null, message: string) {
    super(message);
    this.name = "DockhandError";
    this.status = status;
  }

  override toString(): string {
    return this.status === null
      ? `Dockhand API: ${this.message}`
      : `Dockhand API ${this.status}: ${this.message}`;
  }
}

/**
 * 规范化面板地址：与 Rust `normalize_base_url` 一致。
 * - 必须 http/https；拒绝 query / fragment；
 * - 去末尾 `/`；粘贴到 `/api` 时自动剥掉；
 * - 保留子路径部署（如 https://host/dockhand）。
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error("Dockhand 地址不能为空");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Dockhand 地址无法解析：${urlParseErrorDetail(trimmed)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Dockhand 地址必须是 http 或 https");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("Dockhand 地址不能带查询参数或锚点");
  }
  // 模拟 url::Url::as_str()：小写 origin + pathname（根路径归一为 ""），再 trim 末尾斜杠。
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
  let base = `${parsed.origin}${pathname}`.replace(/\/+$/, "");
  if (base.endsWith("/api")) base = base.slice(0, -"/api".length).replace(/\/+$/, "");
  if (base === "" || base === "https:" || base === "http:") {
    throw new Error("Dockhand 地址缺少主机名");
  }
  return base;
}

function urlParseErrorDetail(raw: string): string {
  // url crate 的常见错误文本（用于保持错误信息可读且接近 Rust）。
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return "relative URL without a base";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/$/.test(raw)) return "empty host";
  return "invalid URL";
}

export function apiBase(base: string): string {
  return `${base}/api`;
}

/** 把 `GET /environments` 拼成完整 URL；拒绝绝对 URL，避免把 token 发到别处。 */
export function resolveApiPath(base: string, rawPath: string): string {
  let path = rawPath.trim();
  if (path === "") throw new Error("API 路径不能为空");
  if (path.startsWith("http://") || path.startsWith("https://")) {
    throw new Error("API 路径必须是相对路径（如 /environments），不接受绝对 URL");
  }
  // 用户可能粘贴完整 `/api/environments`；与 `normalizeBaseUrl` 剥 `/api` 的后缀语义一致。
  while (path.startsWith("/api")) path = path.slice("/api".length);
  if (!path.startsWith("/")) path = `/${path}`;
  return `${apiBase(base)}${path}`;
}

export interface DockhandClientOptions {
  /** 内网自签证书：跳过 TLS 校验（对应 Rust `danger_accept_invalid_certs`）。 */
  insecure?: boolean;
}

export class DockhandClient {
  #base: string;
  #token: string;
  #insecure: boolean;

  constructor(url: string, token: string, options: DockhandClientOptions = {}) {
    if (token.trim() === "") throw new Error("Dockhand token 不能为空");
    this.#base = normalizeBaseUrl(url);
    this.#token = token.trim();
    this.#insecure = options.insecure ?? false;
  }

  withInsecure(insecure: boolean): DockhandClient {
    this.#insecure = insecure;
    return this;
  }

  base(): string {
    return this.#base;
  }

  apiBase(): string {
    return apiBase(this.#base);
  }

  #dispatcher(): Agent | undefined {
    // 每个客户端实例一个 Agent，避免跨请求复用不同 TLS 策略。
    return this.#insecure ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined;
  }

  async #send(method: string, path: string, body?: unknown): Promise<unknown> {
    let url: string;
    try {
      url = resolveApiPath(this.#base, path);
    } catch (error) {
      throw new DockhandError(null, errorMessage(error));
    }
    let response;
    try {
      response = await request(url, {
        method: method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        headers: {
          authorization: `Bearer ${this.#token}`,
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
      throw new DockhandError(
        null,
        `请求 ${url} 失败：${requestErrorDetail(error)}（内网自签证书请加 --insecure）`,
      );
    }
    const status = response.statusCode;
    let text: string;
    try {
      text = await response.body.text();
    } catch (error) {
      throw new DockhandError(status, `读取响应失败：${errorMessage(error)}`);
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
      throw new DockhandError(status, describeError(status, value));
    }
    return value;
  }

  /** 校验 token 的唯一可靠方式：未认证时该接口返回 401。 */
  async environments(): Promise<DockhandEnvironment[]> {
    const value = await this.#send("GET", "/environments");
    return parseEnvironments(value);
  }

  /** `/health` 匿名可访问，只能说明面板进程活着，不能用来校验 token。 */
  async health(): Promise<unknown> {
    return this.#send("GET", "/health");
  }

  async system(envId: number): Promise<unknown> {
    return this.#send("GET", `/system?env=${envId}`);
  }

  async stacks(envId: number): Promise<unknown> {
    return this.#send("GET", `/stacks?env=${envId}`);
  }

  /** 通用透传：给 Agent 用面板已有端点（path 可带 /api 前缀与 query）。 */
  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    return this.#send(method, path, body);
  }
}

/**
 * 解析环境列表：`id` 缺失/非数字的行跳过（资源接口依赖 env id，缺 id 的行无法使用）；
 * `name` 缺失按空串处理。非数组视为响应格式错误。
 */
export function parseEnvironments(value: unknown): DockhandEnvironment[] {
  if (!Array.isArray(value)) {
    throw new DockhandError(null, "解析环境列表失败：expected a sequence");
  }
  const environments: DockhandEnvironment[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "number" || !Number.isInteger(row.id)) continue;
    environments.push({
      id: row.id,
      name: typeof row.name === "string" ? row.name : "",
      host: typeof row.host === "string" ? row.host : null,
      port: typeof row.port === "number" && Number.isInteger(row.port) ? row.port : null,
      protocol: typeof row.protocol === "string" ? row.protocol : null,
    });
  }
  return environments;
}

/** 把 Dockhand 错误体转成可执行提示（与 Rust `describe_error` 文案一致）。 */
export function describeError(status: number, value: unknown): string {
  let detail = "";
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    const item = row.message ?? row.error;
    if (item !== undefined) {
      detail = typeof item === "string" ? item : JSON.stringify(item);
    }
  }
  if (detail === "" && typeof value === "string" && value.trim() !== "") {
    detail = value;
  }
  const hint =
    status === 401
      ? "token 无效或已过期，请到 Dockhand 生成新的 API Token"
      : status === 403
        ? "权限不足：该 API Token 可能缺少管理员权限，或账号未启用"
        : status === 404
          ? "接口不存在：请确认填写的是 Dockhand 面板根地址（如 http://host:3000）"
          : status === 429
            ? "触发 Dockhand 限流，稍后重试"
            : "请检查 token、实例地址与网络连通性";
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
