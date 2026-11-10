// GitLab API v4 客户端（面向 GitLab CE 10.8.7 实测）。Owner: node-web.
//
// 权威实现：src-tauri/src/core/gitlab.rs（444 行）逐行为等价：
// - 认证只用 `PRIVATE-TOKEN` 请求头（10.8 时代 Bearer PAT 尚不可用）；
// - 只用 10.8 已有端点（/user、/projects、/version(仅管理员)）；
// - 分页读 `X-Page` / `X-Next-Page` / `X-Total` 响应头；
// - 允许子路径部署（https://host/gitlab），也接受用户粘贴 /api/v4；
// - 20s 超时；insecure 时跳过 TLS 校验；错误文案对齐 Rust Display。
import { Agent, request } from "undici";

const DEFAULT_TIMEOUT_MS = 20_000;
const USER_AGENT = "flowlet/0.2.0";

export interface ProjectSummary {
  id: number;
  path_with_namespace: string;
  name: string;
  default_branch: string | null;
  visibility: string | null;
  web_url: string | null;
}

export interface Pagination {
  page: number | null;
  nextPage: number | null;
  total: number | null;
}

/** 与 Rust `GitlabError` 同形：Display = `GitLab API {status}: {message}` / `GitLab API: {message}`。 */
export class GitlabError extends Error {
  status: number | null;

  constructor(status: number | null, message: string) {
    super(message);
    this.name = "GitlabError";
    this.status = status;
  }

  override toString(): string {
    return this.status === null ? `GitLab API: ${this.message}` : `GitLab API ${this.status}: ${this.message}`;
  }
}

/**
 * 规范化实例地址：比口径与 Rust `normalize_base_url` 一致。
 * - 必须 http/https；
 * - 去末尾 `/`；粘贴到 `/api/v4` 时自动剥掉；
 * - 保留子路径部署；拒绝 query / fragment。
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error("GitLab 地址不能为空");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`GitLab 地址无法解析：${urlParseErrorDetail(trimmed)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("GitLab 地址必须是 http 或 https");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("GitLab 地址不能带查询参数或锚点");
  }
  // 模拟 url::Url::as_str()：小写 origin + pathname（根路径归一为 ""），再 trim 末尾斜杠。
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
  let base = `${parsed.origin}${pathname}`.replace(/\/+$/, "");
  if (base.endsWith("/api/v4")) base = base.slice(0, -"/api/v4".length).replace(/\/+$/, "");
  if (base === "" || base === "https:" || base === "http:") {
    throw new Error("GitLab 地址缺少主机名");
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
  return `${base}/api/v4`;
}

/** 把 `GET /projects` 拼成完整 URL；拒绝绝对 URL，避免把 token 发到别处。 */
export function resolveApiPath(base: string, rawPath: string): string {
  let path = rawPath.trim();
  if (path === "") throw new Error("API 路径不能为空");
  if (path.startsWith("http://") || path.startsWith("https://")) {
    throw new Error("API 路径必须是相对路径（如 /projects），不接受绝对 URL");
  }
  while (path.startsWith("/api/v4")) path = path.slice("/api/v4".length);
  if (!path.startsWith("/")) path = `/${path}`;
  return `${apiBase(base)}${path}`;
}

export interface GitlabClientOptions {
  /** 内网自签证书：跳过 TLS 校验（对应 Rust `danger_accept_invalid_certs`）。 */
  insecure?: boolean;
}

export class GitlabClient {
  #base: string;
  #token: string;
  #insecure: boolean;

  constructor(url: string, token: string, options: GitlabClientOptions = {}) {
    if (token.trim() === "") throw new Error("GitLab token 不能为空");
    this.#base = normalizeBaseUrl(url);
    this.#token = token.trim();
    this.#insecure = options.insecure ?? false;
  }

  withInsecure(insecure: boolean): GitlabClient {
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
    body?: unknown,
  ): Promise<{ status: number; value: unknown; pagination: Pagination }> {
    let url: string;
    try {
      url = resolveApiPath(this.#base, path);
    } catch (error) {
      throw new GitlabError(null, errorMessage(error));
    }
    let response;
    try {
      response = await request(url, {
        method: method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        headers: {
          "private-token": this.#token,
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
      throw new GitlabError(
        null,
        `请求 ${url} 失败：${requestErrorDetail(error)}（内网自签证书请加 --insecure）`,
      );
    }
    const status = response.statusCode;
    const pagination = paginationFromHeaders(response.headers);
    let text: string;
    try {
      text = await response.body.text();
    } catch (error) {
      throw new GitlabError(status, `读取响应失败：${errorMessage(error)}`);
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
      throw new GitlabError(status, describeError(status, value));
    }
    return { status, value, pagination };
  }

  async currentUser(): Promise<unknown> {
    const { value } = await this.#send("GET", "/user");
    return value;
  }

  /** `/version` 在 10.8 只对管理员开放；非管理员时返回 null（不报错）。 */
  async version(): Promise<string | null> {
    try {
      const { value } = await this.#send("GET", "/version");
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const version = (value as Record<string, unknown>).version;
        return typeof version === "string" ? version : null;
      }
      return null;
    } catch (error) {
      if (error instanceof GitlabError && (error.status === 401 || error.status === 403 || error.status === 404)) {
        return null;
      }
      throw error;
    }
  }

  async projects(search: string | null, membership: boolean, limit: number): Promise<ProjectSummary[]> {
    const projects: ProjectSummary[] = [];
    let page = 1;
    const perPage = Math.min(100, Math.max(1, limit));
    for (;;) {
      let path = `/projects?per_page=${perPage}&page=${page}&order_by=last_activity_at`;
      if (membership) path += "&membership=true";
      const searchTerm = search?.trim() ?? "";
      if (searchTerm !== "") path += `&search=${urlencode(searchTerm)}`;
      const { value, pagination } = await this.#send("GET", path);
      const batch = parseProjects(value);
      if (batch.length === 0) break;
      projects.push(...batch);
      if (projects.length >= limit) {
        projects.length = limit;
        break;
      }
      if (pagination.nextPage !== null && pagination.nextPage > page) {
        page = pagination.nextPage;
      } else {
        break;
      }
    }
    return projects;
  }

  /** 通用透传：给 Agent 用 10.8 已有的任意端点。 */
  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ value: unknown; pagination: Pagination }> {
    const { value, pagination } = await this.#send(method, path, body);
    return { value, pagination };
  }
}

export function parseProjects(value: unknown): ProjectSummary[] {
  if (!Array.isArray(value)) {
    throw new GitlabError(null, `解析项目列表失败：expected a sequence`);
  }
  return value.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new GitlabError(null, "解析项目列表失败：expected a map");
    }
    const row = item as Record<string, unknown>;
    return {
      id: typeof row.id === "number" ? row.id : 0,
      path_with_namespace:
        typeof row.path_with_namespace === "string" ? row.path_with_namespace : "",
      name: typeof row.name === "string" ? row.name : "",
      default_branch: typeof row.default_branch === "string" ? row.default_branch : null,
      visibility: typeof row.visibility === "string" ? row.visibility : null,
      web_url: typeof row.web_url === "string" ? row.web_url : null,
    };
  });
}

function paginationFromHeaders(headers: Record<string, string | string[] | undefined>): Pagination {
  const number = (name: string): number | null => {
    const raw = headers[name];
    const text = Array.isArray(raw) ? raw[0] : raw;
    if (typeof text !== "string") return null;
    if (!/^\d+$/.test(text.trim())) return null;
    return Number(text.trim());
  };
  const nextPage = number("x-next-page");
  return {
    page: number("x-page"),
    nextPage: nextPage !== null && nextPage > 0 ? nextPage : null,
    total: number("x-total"),
  };
}

/** 把 GitLab 错误体转成可执行提示（与 Rust `describe_error` 文案一致）。 */
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
      ? "token 无效或已过期，请重新生成个人访问令牌（需 api scope）"
      : status === 403
        ? "权限不足；该接口可能需要管理员权限，或 token 缺少 api scope"
        : status === 404
          ? "资源不存在，或该接口在 GitLab 10.8.7 中不存在"
          : status === 429
            ? "触发 GitLab 限流，稍后重试"
            : "请检查 token、实例地址与网络连通性";
  return detail === "" ? hint : `${detail}（${hint}）`;
}

/** Rust `urlencode`：保留 unreserved，空格 %20，其余 UTF-8 逐字节 %XX。 */
function urlencode(value: string): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    if (
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2d ||
      byte === 0x5f ||
      byte === 0x2e ||
      byte === 0x7e
    ) {
      out += String.fromCharCode(byte);
    } else if (byte === 0x20) {
      out += "%20";
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestErrorDetail(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const base = errorMessage(error);
  return cause instanceof Error ? `${base}: ${cause.message}` : base;
}