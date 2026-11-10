// OCI 镜像仓库客户端（Docker Registry HTTP API V2 / OCI Distribution）。Owner: node-web.
//
// 权威实现：src-tauri/src/core/registry.rs 与 Node Host `packages/flowlet-core/src/web/registry.ts`
// 逐行为等价（契约 .dsh-scratch/registry-contract.md，v7）：
// - 只按行业通用标准：`GET {base}/v2/` 带 Basic；401 的 `WWW-Authenticate: Bearer` 质询用
//   realm / service / scope 换 token，再用 Bearer 重试；Harbor / Docker Hub / GHCR / Quay / ACR
//   都走同一套，robot account 只是普通「用户名 + 密码/token」，不特判；
// - **不做** Harbor 专属探测：不请求 `/api/v2.0/*`、不请求 `/v2/_catalog`、不按主机名猜 Harbor；
// - 20s 超时；insecure 时跳过 TLS 校验；错误文案逐字对齐契约 §4（与 Rust / Node Host 一致）。
import { Agent, request } from "undici";

const DEFAULT_TIMEOUT_MS = 20_000;
const USER_AGENT = "flowlet/0.2.0";
/** `GET /v2/` 成功响应头：如 `registry/2.0`。 */
const VERSION_HEADER = "docker-distribution-api-version";

/** 校验结果（与 Node Host `checkRegistry` / Rust `RegistryCheck` 同形）。 */
export interface RegistryCheckResult {
  /** 响应头 `docker-distribution-api-version`（如 `registry/2.0`），缺失时 null。 */
  version: string | null;
  /** 契约恒为 null（保留字段以便与其它 provider 的 check 结果同形）。 */
  detail: string | null;
  /** 入参用户名（registry 没有独立的身份查询接口）。 */
  username: string;
}

/**
 * registry 错误。与 Jenkins / Beszel 不同，契约 §4 的文案本身已是完整可执行提示
 * （如 `用户名或 token 无效（registry 认证失败）`），因此 `toString()` 不再拼
 * `Registry API {status}:` 前缀——CLI 直接输出该文案即可与 Node Host / Rust 逐字一致。
 */
export class RegistryError extends Error {
  /** HTTP 状态码；网络/解析类错误为 null。 */
  status: number | null;

  constructor(status: number | null, message: string) {
    super(message);
    this.name = "RegistryError";
    this.status = status;
  }

  override toString(): string {
    return this.message;
  }
}

/**
 * 规范化镜像仓库地址（契约 §2）：
 * 1. trim；空 → `镜像仓库地址不能为空`；
 * 2. 没有 `scheme://` 前缀时补 `https://`；
 * 3. 协议必须是 http/https；
 * 4. 拒绝 query / fragment；
 * 5. 去掉末尾所有 `/`；`/v2`、`/v2/` 也去掉（兼容从文档粘贴），处理后仍带路径 → 报错；
 * 6. 主机名不能为空；
 * 7. 返回 origin 形式 `http(s)://host[:port]`（无末尾斜杠）。
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error("镜像仓库地址不能为空");
  const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    const detail = urlParseErrorDetail(withScheme);
    // 与 Rust `Url::parse("https://")` 的 empty host 对齐：主机号缺失是独立文案。
    if (detail === "empty host") throw new Error("镜像仓库地址缺少主机名");
    throw new Error(`镜像仓库地址无法解析：${detail}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("镜像仓库地址必须是 http 或 https");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("镜像仓库地址不能带查询参数或锚点");
  }
  let pathname = parsed.pathname.replace(/\/+$/, "");
  if (pathname === "/v2") pathname = "";
  if (pathname !== "") {
    throw new Error("镜像仓库地址只能是主机（可带端口），不能包含路径");
  }
  if (parsed.hostname === "") throw new Error("镜像仓库地址缺少主机名");
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * 提取 `host[:port]`（去 scheme、去路径），用于环境变量 `{PREFIX}_HOST` 与提示。
 * 入参可以是 origin（`https://hub.example.com`）也可以是 pull 落库的裸 host；
 * 裸 host 按 https 补全后再取 host，因此 `registryHost("hub.example.com:5000")` =
 * `"hub.example.com:5000"`。脏数据不抛错（环境变量生成不该因此失败），按文本剥 scheme/路径兜底。
 */
export function registryHost(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (trimmed === "") return "";
  const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    return new URL(withScheme).host;
  } catch {
    return trimmed
      .replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "")
      .replace(/[/?#].*$/, "")
      .trim();
  }
}

function urlParseErrorDetail(raw: string): string {
  // url crate 的常见错误文本（用于保持错误信息可读且接近 Rust）。
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return "relative URL without a base";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/$/.test(raw)) return "empty host";
  return "invalid URL";
}

/** 用户名长度上限（按 Unicode 字符计）。 */
export const MAX_REGISTRY_USERNAME_LENGTH = 255;

/**
 * 规范化 registry 用户名（契约 §3）：
 * - 必填；trim 后为空 → `镜像仓库需要填写用户名（docker login 需要用户名 + 密码/token）`；
 * - 长度 ≤ 255 个 Unicode 字符；
 * - 不能包含 `:`、空白或控制字符；
 * - 允许 `$`、`+`、`_`、`-`（Harbor robot account 形如 `robot$project+name`）。
 *
 * CLI `set --user` 必填；「传空保留原值」的编辑语义在 Node Host 保存流程里处理。
 */
export function normalizeUsername(raw: string): string {
  const username = raw.trim();
  if (username === "") {
    throw new Error("镜像仓库需要填写用户名（docker login 需要用户名 + 密码/token）");
  }
  if ([...username].length > MAX_REGISTRY_USERNAME_LENGTH) {
    throw new Error(`用户名不能超过 ${MAX_REGISTRY_USERNAME_LENGTH} 个字符`);
  }
  if (username.includes(":") || /[\s\u0000-\u001F\u007F]/.test(username)) {
    throw new Error("用户名不能包含冒号、空格或控制字符");
  }
  return username;
}

export interface RegistryClientOptions {
  /** 内网自签证书：跳过 TLS 校验（对应 Rust `danger_accept_invalid_certs`）。 */
  insecure?: boolean;
}

interface RawResponse {
  status: number;
  text: string;
  headers: Record<string, string | string[] | undefined>;
}

/** 解析后的 `WWW-Authenticate` 质询：scheme + 参数（参数名小写）。 */
export interface AuthChallenge {
  scheme: string;
  params: Map<string, string>;
}

/**
 * 解析 `WWW-Authenticate`（如 `Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"`）。
 * 只解析第一个 scheme + 其后的 `name="value"` / `name=token` 参数；无 scheme 时返回 null。
 */
export function parseWwwAuthenticate(header: string): AuthChallenge | null {
  const match = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*(.*)$/s.exec(header);
  if (match === null) return null;
  const scheme = match[1]!;
  const rest = match[2] ?? "";
  const params = new Map<string, string>();
  const pattern = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g;
  for (;;) {
    const param = pattern.exec(rest);
    if (param === null) break;
    const key = param[1]!.toLowerCase();
    const quoted = param[2];
    const value = quoted === undefined ? param[3]! : quoted.replace(/\\(.)/g, "$1");
    params.set(key, value);
  }
  return { scheme, params };
}

const INVALID_CREDENTIALS = "用户名或 token 无效（registry 认证失败）";

/**
 * Registry V2 认证客户端（契约 §4）：
 * `GET {base}/v2/` 带 Basic；200 直接成功；401 时解析 Bearer 质询换 token 再重试。
 */
export class RegistryClient {
  #base: string;
  #username: string;
  #password: string;
  #insecure: boolean;

  constructor(
    url: string,
    username: string,
    password: string,
    options: RegistryClientOptions = {},
  ) {
    this.#base = normalizeBaseUrl(url);
    this.#username = normalizeUsername(username);
    if (password.trim() === "") throw new Error("镜像仓库密码/token 不能为空");
    this.#password = password;
    this.#insecure = options.insecure ?? false;
  }

  withInsecure(insecure: boolean): RegistryClient {
    this.#insecure = insecure;
    return this;
  }

  /** 归一后的 origin（`http(s)://host[:port]`，无末尾斜杠）。 */
  base(): string {
    return this.#base;
  }

  #dispatcher(): Agent | undefined {
    // 每个客户端实例一个 Agent，避免跨请求复用不同 TLS 策略。
    return this.#insecure ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined;
  }

  #authorization(): string {
    return `Basic ${Buffer.from(`${this.#username}:${this.#password}`, "utf8").toString("base64")}`;
  }

  async #send(url: string, authorization: string): Promise<RawResponse> {
    let response;
    try {
      response = await request(url, {
        method: "GET",
        headers: {
          authorization,
          accept: "application/json",
          "user-agent": USER_AGENT,
        },
        dispatcher: this.#dispatcher(),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        headersTimeout: DEFAULT_TIMEOUT_MS,
        bodyTimeout: DEFAULT_TIMEOUT_MS,
      });
    } catch (error) {
      throw new RegistryError(
        null,
        `请求 ${url} 失败：${requestErrorDetail(error)}（内网自签证书请加 --insecure）`,
      );
    }
    let text: string;
    try {
      text = await response.body.text();
    } catch (error) {
      throw new RegistryError(response.statusCode, `读取响应失败：${errorMessage(error)}`);
    }
    return { status: response.statusCode, text, headers: response.headers };
  }

  /** 标准流程：Basic `GET /v2/` → （401 时）Bearer 质询换 token → Bearer 重试。 */
  async check(): Promise<RegistryCheckResult> {
    const mainUrl = `${this.#base}/v2/`;
    const basic = this.#authorization();
    const first = await this.#send(mainUrl, basic);
    if (isSuccess(first.status)) return this.#result(first, null);
    if (first.status === 401) return this.#afterChallenge(first, mainUrl, basic);
    throw this.#statusError(first.status);
  }

  async #afterChallenge(
    first: RawResponse,
    mainUrl: string,
    basic: string,
  ): Promise<RegistryCheckResult> {
    const raw = headerValue(first.headers, "www-authenticate");
    // 没有质询 / 质询不是 Bearer（如 Basic）→ 认证失败，不尝试任何 Harbor 专属接口。
    if (raw === null) throw new RegistryError(401, INVALID_CREDENTIALS);
    const challenge = parseWwwAuthenticate(raw);
    if (challenge === null || challenge.scheme.toLowerCase() !== "bearer") {
      throw new RegistryError(401, INVALID_CREDENTIALS);
    }
    const realmRaw = challenge.params.get("realm") ?? "";
    let realm: URL;
    try {
      realm = new URL(realmRaw);
    } catch {
      throw new RegistryError(401, "镜像仓库返回的认证质询无法解析");
    }
    if (realm.protocol !== "http:" && realm.protocol !== "https:") {
      throw new RegistryError(401, "镜像仓库返回的认证质询无法解析");
    }
    const service = challenge.params.get("service");
    if (service !== undefined && service !== "") realm.searchParams.set("service", service);
    const scope = challenge.params.get("scope");
    if (scope !== undefined && scope !== "") realm.searchParams.set("scope", scope);
    const tokenUrl = realm.toString();

    const tokenResponse = await this.#send(tokenUrl, basic);
    // token 端点 401/403 → 认证失败；其它非 200 → 与主请求一致的状态码文案；
    // 200 但没有 token 字段 → 认证失败（契约 §4.2）。
    let token: string | null = null;
    if (tokenResponse.status === 401 || tokenResponse.status === 403) {
      throw new RegistryError(tokenResponse.status, INVALID_CREDENTIALS);
    }
    if (tokenResponse.status !== 200) throw this.#statusError(tokenResponse.status);
    token = parseToken(tokenResponse.text);
    if (token === null) throw new RegistryError(200, INVALID_CREDENTIALS);

    const retry = await this.#send(mainUrl, `Bearer ${token}`);
    if (!isSuccess(retry.status)) throw new RegistryError(retry.status, INVALID_CREDENTIALS);
    // version 优先取重试响应头，其次 token 响应头，都缺失为 null。
    return this.#result(retry, tokenResponse);
  }

  #result(response: RawResponse, tokenResponse: RawResponse | null): RegistryCheckResult {
    return {
      version:
        headerValue(response.headers, VERSION_HEADER) ??
        (tokenResponse === null ? null : headerValue(tokenResponse.headers, VERSION_HEADER)),
      detail: null,
      username: this.#username,
    };
  }

  #statusError(status: number): RegistryError {
    if (status === 403) {
      return new RegistryError(
        403,
        "认证被拒绝（403）：用户名或 token 无效，或该账号无权访问",
      );
    }
    if (status === 404) {
      return new RegistryError(
        404,
        "接口不存在：请确认填写的是镜像仓库根地址（如 https://hub.example.com），不要带路径",
      );
    }
    if (status === 429) return new RegistryError(429, "镜像仓库触发限流，稍后重试");
    return new RegistryError(status, `镜像仓库返回 HTTP ${status}`);
  }
}

/** token 端点响应体：`token` 优先，其次 `access_token`；都缺失/非字符串/空串时为 null。 */
export function parseToken(text: string): string | null {
  if (text.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  for (const key of ["token", "access_token"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestErrorDetail(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const base = errorMessage(error);
  return cause instanceof Error ? `${base}: ${cause.message}` : base;
}