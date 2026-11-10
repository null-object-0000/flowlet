// Beszel API 客户端（开源服务器监控 Hub，PocketBase 底座，默认端口 8090）。Owner: node-web.
//
// 权威实现：src-tauri/src/core/beszel.rs 逐行为等价：
// - Beszel 没有长期 API Token：只能用「邮箱 + 密码」调
//   `POST /api/collections/users/auth-with-password` 换 PocketBase 短期 token（默认 14 天）；
//   后续请求带 `Authorization: <token>`（PocketBase 原生 token，**不加** `Bearer`）；
// - Hub 版本走需认证的 `GET /api/beszel/info`（`{ "v": "0.21.1", ... }`）；
//   该接口失败不致命，不能把「拿不到版本」当成凭据无效；
// - 系统列表走 PocketBase 集合 `GET /api/collections/systems/records`（`totalItems` 用于
//   校验结果的 detail 文案）；
// - 地址归一会剥掉用户粘贴的 `/api` 与 PocketBase 管理面板 `/_/` 后缀；
// - 20s 超时；insecure 时跳过 TLS 校验；错误文案对齐 Rust Display。
import { Agent, request } from "undici";

const DEFAULT_TIMEOUT_MS = 20_000;
const USER_AGENT = "flowlet/0.2.0";

/** `auth-with-password` 的身份投影：只保留登录邮箱/显示名/角色，避免把整条 record 塞进上下文。 */
export interface BeszelAuth {
  /** PocketBase token：后续请求的 `Authorization` 头值（不带 `Bearer`）。 */
  token: string;
  email: string | null;
  name: string | null;
  role: string | null;
}

/** systems 集合投影：只保留排查需要的字段，字段缺失一律空串（不伪造数据）。 */
export interface BeszelSystem {
  id: string;
  name: string;
  host: string;
  status: string;
  port: string;
}

export interface BeszelSystemsPage {
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
 * 规范化 Hub 地址：口径与 Rust `normalize_base_url` 一致。
 * - 必须 http/https；拒绝 query / fragment；
 * - 反复剥掉末尾的 `/`、`/api`、`/_`、`/_/`（用户可能粘贴 `http://host:8090/api`
 *   或 PocketBase 管理面板 `http://host:8090/_/`）；
 * - 保留其它子路径部署；
 * - 返回不带末尾斜杠的根地址（如 `http://10.1.1.1:8090`）。
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
  // 模拟 url::Url::as_str()：小写 origin + pathname（根路径归一为 ""），再 trim 末尾斜杠。
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
  let base = `${parsed.origin}${pathname}`.replace(/\/+$/, "");
  // 反复剥：`/api`（API 前缀）与 `/_`（PocketBase 管理面板）；`/_/` 会先被斜杠规则吃掉。
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const suffix of ["/api", "/_"]) {
      if (base.endsWith(suffix)) {
        base = base.slice(0, -suffix.length).replace(/\/+$/, "");
        stripped = true;
      }
    }
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

export function apiBase(base: string): string {
  return `${base}/api`;
}

/**
 * 把 `/collections/systems/records?perPage=1` 这类路径拼成完整 URL；
 * 拒绝绝对 URL，避免把凭据发到别处。允许粘贴 `/api` 前缀（只剥一层）。
 */
export function resolveApiPath(base: string, rawPath: string): string {
  let path = rawPath.trim();
  if (path === "") throw new Error("API 路径不能为空");
  if (path.startsWith("http://") || path.startsWith("https://")) {
    throw new Error("API 路径必须是相对路径（如 /collections/systems/records），不接受绝对 URL");
  }
  // 与 Rust `resolve_api_path` 一致，只剥一层前缀，query 原样保留。
  if (path.startsWith("/api")) path = path.slice("/api".length);
  if (!path.startsWith("/")) path = `/${path}`;
  return `${apiBase(base)}${path}`;
}

export interface BeszelClientOptions {
  /** 内网自签证书：跳过 TLS 校验（对应 Rust `danger_accept_invalid_certs`）。 */
  insecure?: boolean;
}

/**
 * Beszel 客户端：邮箱 + 密码换 token；token 缓存在实例内，一次命令只认证一次。
 * 系统列表默认每页 200 条（Hub 侧上限），校验时用 `systems(1)` 只取 `totalItems`。
 */
export class BeszelClient {
  #base: string;
  #email: string;
  #password: string;
  #insecure: boolean;
  #token: string | null = null;

  constructor(url: string, email: string, password: string, options: BeszelClientOptions = {}) {
    if (password.trim() === "") throw new Error("Beszel 密码不能为空");
    if (email.trim() === "") throw new Error("Beszel 邮箱不能为空");
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

  email(): string {
    return this.#email;
  }

  /** 缓存的 token（未认证时为 null）；测试与 CLI 只需读，不应外部注入。 */
  token(): string | null {
    return this.#token;
  }

  #dispatcher(): Agent | undefined {
    // 每个客户端实例一个 Agent，避免跨请求复用不同 TLS 策略。
    return this.#insecure ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined;
  }

  /** 通用透传：给 Agent 用任意 PocketBase / Hub JSON 端点（CLI `beszel api`）。 */
  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const { value } = await this.#send(method, path, body, true);
    return value;
  }

  /** `POST /api/collections/users/auth-with-password`：邮箱 + 密码换 token。 */
  async auth(): Promise<BeszelAuth> {
    const { value } = await this.#send(
      "POST",
      "/collections/users/auth-with-password",
      { identity: this.#email, password: this.#password },
      false,
    );
    const auth = parseAuth(value);
    this.#token = auth.token;
    return auth;
  }

  /** 已认证时直接复用 token；一次命令只认证一次。 */
  async #ensureToken(): Promise<string> {
    if (this.#token !== null) return this.#token;
    const auth = await this.auth();
    return auth.token;
  }

  /** `GET /api/beszel/info`（需认证）→ Hub 版本；取不到 `v` 时返回 null。 */
  async info(): Promise<string | null> {
    const { value } = await this.#send("GET", "/beszel/info", undefined, true);
    return parseVersion(value);
  }

  /**
   * `GET /api/collections/systems/records`：默认取 200 条做系统列表；
   * 校验用 `systems(1)` 只关心 `totalItems`。
   */
  async systems(perPage = 200): Promise<BeszelSystemsPage> {
    const { value } = await this.#send(
      "GET",
      `/collections/systems/records?page=1&perPage=${perPage}&sort=name&fields=id,name,host,status,port`,
      undefined,
      true,
    );
    return parseSystems(value);
  }

  async #send(
    method: string,
    path: string,
    body: unknown,
    authenticated: boolean,
  ): Promise<{ value: unknown }> {
    let url: string;
    try {
      url = resolveApiPath(this.#base, path);
    } catch (error) {
      throw new BeszelError(null, errorMessage(error));
    }
    let authorization: string | undefined;
    if (authenticated) {
      // 认证失败抛 BeszelError；调用方的错误处理与普通请求一致。
      authorization = await this.#ensureToken();
    }
    let response;
    try {
      response = await request(url, {
        method: method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        headers: {
          accept: "application/json",
          "user-agent": USER_AGENT,
          ...(authorization === undefined ? {} : { authorization }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
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
    const value = parseBody(text);
    if (status < 200 || status >= 300) {
      // auth 端点的 400 是「邮箱或密码错误」，与其它端点的 400 提示不同。
      throw new BeszelError(status, describeError(status, value, { auth: !authenticated }));
    }
    return { value };
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

/** PocketBase 的 auth 响应：`token` 必填，`record.email/name/role` 可选。 */
export function parseAuth(value: unknown): BeszelAuth {
  const row = asRecord(value);
  const token = text(row, "token");
  if (token === null) throw new BeszelError(null, "解析认证响应失败：缺少 token");
  const record = asRecord(row?.record);
  return {
    token,
    email: text(record, "email"),
    name: text(record, "name"),
    role: text(record, "role"),
  };
}

/** `GET /api/beszel/info`：只取 `v`；缺失/非字符串 → null（版本不是校验必要条件）。 */
export function parseVersion(value: unknown): string | null {
  return text(asRecord(value), "v");
}

/**
 * 解析系统列表：`items` 非数组 → `解析系统列表失败：expected a sequence`；
 * 单行不是对象时跳过（PocketBase 不会返回这种行，但不要让整页解析失败）；
 * 字段缺失 → 空串。
 */
export function parseSystems(value: unknown): BeszelSystemsPage {
  const row = asRecord(value);
  if (row === null || !Array.isArray(row.items)) {
    throw new BeszelError(null, "解析系统列表失败：expected a sequence");
  }
  const items: BeszelSystem[] = [];
  for (const item of row.items) {
    const system = asRecord(item);
    if (system === null) continue;
    items.push({
      id: text(system, "id") ?? "",
      name: text(system, "name") ?? "",
      host: text(system, "host") ?? "",
      status: text(system, "status") ?? "",
      port: text(system, "port") ?? "",
    });
  }
  return {
    page: number(row, "page"),
    perPage: number(row, "perPage"),
    totalItems: number(row, "totalItems"),
    totalPages: number(row, "totalPages"),
    items,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(row: Record<string, unknown> | null, key: string): string | null {
  if (row === null) return null;
  const item = row[key];
  if (typeof item !== "string") return null;
  const trimmed = item.trim();
  return trimmed === "" ? null : trimmed;
}

function number(row: Record<string, unknown>, key: string): number {
  const item = row[key];
  return typeof item === "number" && Number.isFinite(item) ? item : 0;
}

/**
 * 把 PocketBase / Beszel 的错误转成可执行提示：
 * detail 取 body 的 `message`，其次 `error`，否则原文；有 detail 时拼成 `detail（hint）`。
 * 文案与契约 §4.3 / Rust `describe_error` 逐字一致。
 */
export function describeError(
  status: number,
  value: unknown,
  options: { auth?: boolean } = {},
): string {
  let detail = "";
  const row = asRecord(value);
  if (row !== null) {
    // PocketBase 错误体形如 `{ "code": 400, "message": "Failed to authenticate.", "data": {} }`；
    // `error` 是 Beszel 其它端点的兜底字段。
    const item = row.message ?? row.error;
    if (item !== undefined) {
      detail = typeof item === "string" ? item : JSON.stringify(item);
    }
  } else if (typeof value === "string" && value.trim() !== "") {
    // 原始文本（反向代理错误页、纯文本响应）按契约作为 detail 原文。
    detail = value.trim();
  }
  const hint =
    status === 400 && options.auth === true
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