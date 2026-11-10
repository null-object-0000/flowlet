// Beszel API 客户端（开源服务器监控 Hub，PocketBase 底座，默认端口 8090）。Owner: node-web.
//
// 权威实现：src-tauri/src/core/beszel.rs 逐行为等价：
// - Beszel 没有长期 API Token：用「邮箱 + 密码」调
//   `POST /api/collections/users/auth-with-password` 换短期 token，之后请求带
//   `Authorization: <token>`（PocketBase 原生 token，**不是** `Bearer`）；
// - 校验身份只能走 auth 端点；版本看 `GET /api/beszel/info`（失败不致命）；
//   系统数量看 `GET /api/collections/systems/records` 的 `totalItems`；
// - 地址反复剥末尾 `/`、`/api`、`/_`、`/_/`（用户可能粘贴 PocketBase 管理面板地址），保留子路径部署；
// - 20s 超时；insecure 时跳过 TLS 校验；错误文案对齐 Rust Display。
import { Agent, request } from "undici";

const DEFAULT_TIMEOUT_MS = 20_000;
const USER_AGENT = "flowlet/0.2.0";
const AUTH_PATH = "/collections/users/auth-with-password";

/** 与 Rust `BeszelAuth` 同形：record 字段缺失时为 null。 */
export interface BeszelAuth {
  token: string;
  email: string | null;
  name: string | null;
  role: string | null;
}

/** 与 Rust `BeszelSystem` 同形：字段缺失时为空串。 */
export interface BeszelSystem {
  id: string;
  name: string;
  host: string;
  status: string;
  port: string;
}

/** PocketBase `records` 响应：`items` 已投影为 BeszelSystem。 */
export interface BeszelSystems {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: BeszelSystem[];
}

/** 与 Rust `BeszelError` 同形：Display = `Beszel API {status}: {message}` / `Beszel API: {message}`。 */
export class BeszelError extends Error {
  status: number | null;

  constructor(status: number | null, message: string) {
    super(message);
    this.name = "BeszelError";
    this.status = status;
  }

  override toString(): string {
    return this.status === null
      ? `Beszel API: ${this.message}`
      : `Beszel API ${this.status}: ${this.message}`;
  }
}

/**
 * 规范化 Hub 地址（契约 §2）：与 Rust `normalize_base_url` 一致。
 * - 必须 http/https；拒绝 query / fragment；
 * - 反复剥掉末尾 `/`、`/api`、`/_`、`/_/`（用户可能粘贴 `http://host:8090/api`
 *   或 PocketBase 管理面板 `http://host:8090/_/`）；
 * - 保留其它子路径部署（如 https://host/beszel）。
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error("Beszel 地址不能为空");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Beszel 地址无法解析：${urlParseErrorDetail(trimmed)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Beszel 地址必须是 http 或 https");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("Beszel 地址不能带查询参数或锚点");
  }
  // 模拟 url::Url::as_str()：小写 origin + pathname（根路径归一为 ""）。
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
  let base = `${parsed.origin}${pathname}`;
  // 反复剥：先削末尾斜杠，再削 /api、/_；处理 "/_/" 这类组合。
  for (;;) {
    const before = base;
    base = base.replace(/\/+$/, "");
    if (base.endsWith("/api")) base = base.slice(0, -"/api".length);
    else if (base.endsWith("/_")) base = base.slice(0, -"/_".length);
    if (base === before) break;
  }
  if (base === "" || base === "https:" || base === "http:" || parsed.hostname === "") {
    throw new Error("Beszel 地址缺少主机名");
  }
  return base;
}

function urlParseErrorDetail(raw: string): string {
  // url crate 的常见错误文本（用于保持错误信息可读且接近 Rust）。
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return "relative URL without a base";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/$/.test(raw)) return "empty host";
  return "invalid URL";
}

/** PocketBase API 根：`{base}/api`。 */
export function apiBase(base: string): string {
  return `${base}/api`;
}

/**
 * 把 `GET /collections/systems/records` 拼成完整 URL（契约 §3）；拒绝绝对 URL，
 * 避免邮箱/密码换来的 token 被发到别处。PATH 可带 `/api` 前缀与 query。
 */
export function resolveApiPath(base: string, rawPath: string): string {
  let path = rawPath.trim();
  if (path === "") throw new Error("API 路径不能为空");
  if (path.startsWith("http://") || path.startsWith("https://")) {
    throw new Error(
      "API 路径必须是相对路径（如 /collections/systems/records），不接受绝对 URL",
    );
  }
  if (!path.startsWith("/")) path = `/${path}`;
  // 用户可能粘贴完整 `/api/...`；与 `normalizeBaseUrl` 剥 `/api` 的后缀语义一致。
  while (path.startsWith("/api")) path = path.slice("/api".length);
  if (!path.startsWith("/")) path = `/${path}`;
  return `${apiBase(base)}${path}`;
}

export interface BeszelClientOptions {
  /** 内网自签证书：跳过 TLS 校验（对应 Rust `danger_accept_invalid_certs`）。 */
  insecure?: boolean;
}

export class BeszelClient {
  #base: string;
  #email: string;
  #password: string;
  #insecure: boolean;
  /** token 缓存在实例内：一次命令只认证一次（契约 §4.1）。 */
  #auth: BeszelAuth | null = null;

  constructor(url: string, email: string, password: string, options: BeszelClientOptions = {}) {
    if (email.trim() === "") throw new Error("Beszel 邮箱不能为空");
    if (password.trim() === "") throw new Error("Beszel 密码不能为空");
    this.#base = normalizeBaseUrl(url);
    this.#email = email.trim();
    this.#password = password.trim();
    this.#insecure = options.insecure ?? false;
  }

  withInsecure(insecure: boolean): BeszelClient {
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

  async #send(
    method: string,
    path: string,
    body: unknown,
    token: string | null,
    fromAuth: boolean,
  ): Promise<unknown> {
    let url: string;
    try {
      url = resolveApiPath(this.#base, path);
    } catch (error) {
      throw new BeszelError(null, errorMessage(error));
    }
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": USER_AGENT,
    };
    if (token !== null) headers.authorization = token;
    if (body !== undefined) headers["content-type"] = "application/json";
    let response;
    try {
      response = await request(url, {
        method: method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        dispatcher: this.#dispatcher(),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        headersTimeout: DEFAULT_TIMEOUT_MS,
        bodyTimeout: DEFAULT_TIMEOUT_MS,
      });
    } catch (error) {
      throw new BeszelError(
        null,
        `请求 ${url} 失败：${requestErrorDetail(error)}（内网自签证书请加 --insecure）`,
      );
    }
    const status = response.statusCode;
    let text: string;
    try {
      text = await response.body.text();
    } catch (error) {
      throw new BeszelError(status, `读取响应失败：${errorMessage(error)}`);
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
      throw new BeszelError(status, describeError(status, value, fromAuth));
    }
    return value;
  }

  /** 邮箱 + 密码换 token；结果缓存在实例内。 */
  async auth(): Promise<BeszelAuth> {
    if (this.#auth !== null) return this.#auth;
    const value = await this.#send(
      "POST",
      AUTH_PATH,
      { identity: this.#email, password: this.#password },
      null,
      true,
    );
    const token = field(value, "token");
    if (token === null) throw new BeszelError(null, "认证响应缺少 token");
    const record = objectField(value, "record");
    this.#auth = {
      token,
      email: record === null ? null : field(record, "email"),
      name: record === null ? null : field(record, "name"),
      role: record === null ? null : field(record, "role"),
    };
    return this.#auth;
  }

  async #authed(method: string, path: string, body?: unknown): Promise<unknown> {
    const auth = await this.auth();
    return this.#send(method, path, body, auth.token, false);
  }

  /** Hub 版本（`/api/beszel/info` 的 `v`）；取不到时为 null（失败不致命）。 */
  async info(): Promise<string | null> {
    const value = await this.#authed("GET", "/beszel/info");
    const version = field(value, "v");
    return version === null || version === "" ? null : version;
  }

  /**
   * 系统列表（默认 perPage=200）；校验时传 perPage=1 只取 `totalItems`。
   * `items` 投影为 `{id,name,host,status,port}`，非数组视为响应格式错误。
   */
  async systems(perPage = 200): Promise<BeszelSystems> {
    const value = await this.#authed(
      "GET",
      `/collections/systems/records?page=1&perPage=${perPage}&sort=name&fields=id,name,host,status,port,updated`,
    );
    return parseSystems(value);
  }

  /** 通用透传：给 Agent 用 Hub/PocketBase 已有端点（PATH 可带 /api 前缀与 query）。 */
  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    return this.#authed(method, path, body);
  }
}

/** 解析 `records` 响应；`items` 非数组时报契约 §4.2 的文案。 */
export function parseSystems(value: unknown): BeszelSystems {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BeszelError(null, "解析系统列表失败：expected a sequence");
  }
  const row = value as Record<string, unknown>;
  const rawItems = row.items;
  if (!Array.isArray(rawItems)) {
    throw new BeszelError(null, "解析系统列表失败：expected a sequence");
  }
  const items: BeszelSystem[] = [];
  for (const rawItem of rawItems) {
    if (rawItem === null || typeof rawItem !== "object" || Array.isArray(rawItem)) continue;
    const item = rawItem as Record<string, unknown>;
    items.push({
      id: stringField(item, "id"),
      name: stringField(item, "name"),
      host: stringField(item, "host"),
      status: stringField(item, "status"),
      port: stringField(item, "port"),
    });
  }
  const totalItems =
    typeof row.totalItems === "number" && Number.isInteger(row.totalItems)
      ? row.totalItems
      : items.length;
  return {
    page: numberField(row, "page"),
    perPage: numberField(row, "perPage"),
    totalItems,
    totalPages: numberField(row, "totalPages"),
    items,
  };
}

function numberField(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

function field(value: unknown, key: string): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate !== "" ? candidate : null;
}

function objectField(value: unknown, key: string): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[key];
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  return candidate as Record<string, unknown>;
}

/** 字符串字段：缺失/非字符串时为 ""；数字（如 PocketBase 的 port）按十进制转成字符串。 */
function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/**
 * 把 Beszel/PocketBase 错误体转成可执行提示（契约 §4.3，与 Rust `describe_error` 文案一致）。
 * `fromAuth=true` 时 400 用「邮箱或密码错误」提示（PocketBase 认证失败返回 400）。
 */
export function describeError(status: number, value: unknown, fromAuth = false): string {
  let detail = "";
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    const item = row.message ?? row.error;
    if (typeof item === "string" && item.trim() !== "") detail = item.trim();
  } else if (typeof value === "string" && value.trim() !== "") {
    detail = value.trim();
  }
  const hint =
    fromAuth && status === 400
      ? "邮箱或密码错误，请确认是 Beszel 用户账号（不是 PocketBase 超级管理员）"
      : status === 401
        ? "token 无效或已过期，请重新用邮箱+密码登录"
        : status === 403
          ? "密码登录可能被禁用（DISABLE_PASSWORD_AUTH），或账号没有读取权限"
          : status === 404
            ? "接口不存在：请确认填写的是 Beszel Hub 根地址（默认端口 8090）"
            : status === 429
              ? "触发 Beszel 限流，稍后重试"
              : "请检查邮箱、密码、实例地址与网络连通性";
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