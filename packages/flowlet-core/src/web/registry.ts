// OCI 镜像仓库（Docker Registry HTTP API V2 / OCI Distribution）客户端。Owner: node-web.
//
// 权威实现：src-tauri/src/core/registry.rs 逐行为等价（契约 .dsh-scratch/registry-contract.md）：
// - 只做行业通用标准：`GET /v2/` 探测 + `WWW-Authenticate` 质询 + Bearer token 换发；
//   Docker Hub / GHCR / Quay / ACR / Harbor 都走同一套，robot account 只是普通「用户名 + 密码/token」，
//   不特判；
// - **不做** Harbor 专属能力：不请求 `/api/v2.0/*`、不探测版本/项目数、不调 `/v2/_catalog`、
//   不按主机名猜 Harbor；
// - 版本只取标准响应头 `docker-distribution-api-version`（如 `registry/2.0`），缺失为 null；
// - 20s 超时；insecure 时跳过 TLS 校验；错误文案逐字对齐契约 §2 / §4。
import type { IncomingHttpHeaders } from "node:http";

import { Agent, request } from "undici";

const DEFAULT_TIMEOUT_MS = 20_000;
const USER_AGENT = "flowlet/0.2.0";

/** 认证失败统一文案（契约 §4.2 逐字）。 */
const AUTH_FAILED = "用户名或 token 无效（registry 认证失败）";
/** Bearer 质询里 realm 缺失/无法解析（契约 §4.2 逐字）。 */
const CHALLENGE_UNPARSABLE = "镜像仓库返回的认证质询无法解析";

/**
 * 与 Rust `RegistryError` 同形：status 用于排查，`message` 是可直接展示的契约文案。
 * 与其它 provider 不同，`toString()` 不再拼 `Registry API {status}:` 前缀——契约 §4.2 的
 * 文案本身已是完整可执行提示，Rust / CLI 也直接输出同一文案，保证三层逐字一致。
 */
export class RegistryError extends Error {
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

/** 校验结果：结构上等价于 credentials.ts 的 `CredentialCheck`，避免反向依赖。 */
export interface RegistryCheck {
  ok: boolean;
  username: string | null;
  version: string | null;
  detail: string | null;
  error: string | null;
}

/**
 * 规范化镜像仓库地址（契约 §2，规则按顺序执行）：
 * 1. trim；空 → `镜像仓库地址不能为空`；
 * 2. 没有 `scheme://` 前缀时补 `https://`；
 * 3. 协议必须是 http/https；
 * 4. 拒绝 query / fragment；
 * 5. 去掉末尾所有 `/`，pathname 为 `/v2` 或 `/v2/` 时也剥掉；处理后必须没有路径；
 * 6. 主机名不能为空；
 * 7. 返回 origin 形式 `http(s)://host[:port]`（无末尾斜杠、无路径）。
 */
export function normalizeRegistryUrl(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") throw new Error("镜像仓库地址不能为空");
  // 用户通常只填 `hub.example.com`（docker login 也是这么填的），补默认 https。
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    const detail = urlParseErrorDetail(candidate);
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
  // 去掉末尾所有 `/`；再兼容用户从文档粘贴的 `/v2`、`/v2/`（不是 Harbor 探测，只是地址清洗）。
  let pathname = parsed.pathname.replace(/\/+$/, "");
  if (pathname === "/v2") pathname = "";
  if (pathname !== "") {
    throw new Error("镜像仓库地址只能是主机（可带端口），不能包含路径");
  }
  if (parsed.hostname === "") throw new Error("镜像仓库地址缺少主机名");
  return parsed.origin;
}

function urlParseErrorDetail(raw: string): string {
  // url crate 的常见错误文本（用于保持错误信息可读且接近 Rust）。
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return "relative URL without a base";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/$/.test(raw)) return "empty host";
  return "invalid URL";
}

/**
 * host 提取（契约 §2）：`host[:port]`，去 scheme、去路径。
 * 用于环境变量值（`{PREFIX}_HOST`）与提示；归一后的 baseUrl 一定是可解析的 origin。
 */
export function registryHost(baseUrl: string): string {
  const trimmed = (baseUrl ?? "").trim();
  if (trimmed === "") return "";
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(candidate).host;
  } catch {
    // 兜底：不抛错，按文本剥掉 scheme 与路径（环境变量生成不该因脏数据失败）。
    return trimmed
      .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "")
      .replace(/[/?#].*$/, "")
      .trim();
  }
}

/**
 * 用户名规则（契约 §3，与 Rust `normalize_username` 的 registry 分支一致）：
 * - 必填（docker login 需要用户名 + 密码/token）；编辑时传空表示保留原值，原值也空同样报错；
 * - 长度 ≤ 255 个 Unicode 字符；
 * - 不能包含 `:`、空白或控制字符（Basic 认证用 `:` 分隔用户名与密码）；
 * - 明确允许 `$`、`+`、`_`、`-`（Harbor robot account 形如 `robot$project+name`）。
 */
export function normalizeRegistryUsername(
  raw: string | null | undefined,
  existing: string | null,
): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") {
    const previous = (existing ?? "").trim();
    if (previous === "") {
      throw new Error("镜像仓库需要填写用户名（docker login 需要用户名 + 密码/token）");
    }
    validateRegistryUsername(previous);
    return previous;
  }
  validateRegistryUsername(trimmed);
  return trimmed;
}

function validateRegistryUsername(username: string): void {
  if ([...username].length > 255) throw new Error("用户名不能超过 255 个字符");
  if (
    [...username].some(
      (char) => /[\s:]/.test(char) || /[\u0000-\u001f\u007f]/.test(char),
    )
  ) {
    throw new Error("用户名不能包含冒号、空格或控制字符");
  }
}

/** `Authorization: Basic base64("{username}:{password}")`（docker login 的同一套凭证）。 */
export function basicAuthorization(username: string, password: string): string {
  const encoded = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

/** `WWW-Authenticate` 质询解析结果；`scheme` 为小写首质询方案，无质询时为空串。 */
export interface RegistryChallenge {
  scheme: string;
  realm: string | null;
  service: string | null;
  scope: string | null;
}

/**
 * 解析 `WWW-Authenticate`（RFC 6750 / Docker token auth）：
 * 形如 `Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:x:pull"`。
 * 只解析首个质询方案；参数值支持 `"..."` 与转义。值缺失/空白归一为 null。
 */
export function parseRegistryChallenge(raw: string | null | undefined): RegistryChallenge {
  const text = (raw ?? "").trim();
  if (text === "") return { scheme: "", realm: null, service: null, scope: null };
  const space = text.search(/\s/);
  const scheme = (space < 0 ? text : text.slice(0, space)).toLowerCase();
  if (scheme !== "bearer") return { scheme, realm: null, service: null, scope: null };
  const params = parseChallengeParams(space < 0 ? "" : text.slice(space + 1));
  return {
    scheme,
    realm: blankToNull(params.get("realm")),
    service: blankToNull(params.get("service")),
    scope: blankToNull(params.get("scope")),
  };
}

function parseChallengeParams(raw: string): Map<string, string> {
  const params = new Map<string, string>();
  const pattern = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  for (const match of raw.matchAll(pattern)) {
    const key = match[1]!.toLowerCase();
    if (params.has(key)) continue;
    const value =
      match[2] !== undefined ? match[2].replace(/\\(.)/g, "$1") : (match[3] ?? "");
    params.set(key, value);
  }
  return params;
}

function blankToNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 校验一个 OCI 镜像仓库凭据；返回结构化结果而不是抛错（契约 §4）。
 *
 * 流程：`GET {base}/v2/`（Basic）→ 200 直接成功；401 且 Bearer 质询则用 realm/service/scope
 * 换 token → 携带 `Bearer` 重试 `GET {base}/v2/`。任何 Harbor 专属探测都不会发生。
 * 成功时 `version` 取 `docker-distribution-api-version`（重试响应优先，其次 token 响应），
 * `detail` 恒 null，`username` 为入参用户名。
 */
export async function checkRegistry(
  baseUrl: string,
  username: string,
  password: string,
  insecure: boolean,
): Promise<RegistryCheck> {
  let base: string;
  try {
    base = normalizeRegistryUrl(baseUrl);
  } catch (error) {
    return failed(message(error));
  }
  const user = (username ?? "").trim();
  const apiUrl = `${base}/v2/`;
  const basicHeaders: Record<string, string> = {
    authorization: basicAuthorization(user, password ?? ""),
    accept: "application/json",
    "user-agent": USER_AGENT,
  };

  let main: ResponseSnapshot;
  try {
    main = await sendRequest(apiUrl, basicHeaders, insecure);
  } catch (error) {
    return failed(message(error));
  }
  if (main.status >= 200 && main.status < 300) {
    return succeeded(user, distributionVersion(main.headers));
  }
  if (main.status !== 401) return failed(statusError(main.status));

  // 401：只接受 Bearer 质询；Basic 质询或不带 Bearer 说明用户名/密码不对。
  const challenge = parseRegistryChallenge(headerValue(main.headers, "www-authenticate"));
  if (challenge.scheme !== "bearer") return failed(AUTH_FAILED);
  const tokenUrl = buildTokenUrl(challenge);
  if (tokenUrl === null) return failed(CHALLENGE_UNPARSABLE);

  let tokenResponse: ResponseSnapshot;
  try {
    tokenResponse = await sendRequest(tokenUrl, basicHeaders, insecure);
  } catch (error) {
    return failed(message(error));
  }
  if (tokenResponse.status === 401 || tokenResponse.status === 403) return failed(AUTH_FAILED);
  if (tokenResponse.status !== 200) return failed(statusError(tokenResponse.status));
  const token = parseToken(tokenResponse.text);
  if (token === null) return failed(AUTH_FAILED);

  let retried: ResponseSnapshot;
  try {
    retried = await sendRequest(
      apiUrl,
      {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
      insecure,
    );
  } catch (error) {
    return failed(message(error));
  }
  if (retried.status >= 200 && retried.status < 300) {
    // 重试响应头优先，其次 token 响应头（契约 §4.2）。
    return succeeded(
      user,
      distributionVersion(retried.headers) ?? distributionVersion(tokenResponse.headers),
    );
  }
  return failed(AUTH_FAILED);
}

interface ResponseSnapshot {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

async function sendRequest(
  url: string,
  headers: Record<string, string>,
  insecure: boolean,
): Promise<ResponseSnapshot> {
  // 每个请求一个 Agent，避免跨请求复用不同 TLS 策略。
  const dispatcher = insecure ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined;
  let response;
  try {
    response = await request(url, {
      method: "GET",
      headers,
      dispatcher,
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
    throw new RegistryError(response.statusCode, `读取响应失败：${message(error)}`);
  }
  return {
    status: response.statusCode,
    headers: response.headers as unknown as IncomingHttpHeaders,
    text,
  };
}

/** 版本唯一来源：标准头 `docker-distribution-api-version`；缺失/空白为 null，不伪造。 */
function distributionVersion(headers: IncomingHttpHeaders): string | null {
  return headerValue(headers, "docker-distribution-api-version");
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
  const raw = headers[name];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 构造 token 端点 URL：`{realm}?service={service}[&scope={scope}]`。
 * realm 缺失或不是 http(s) 绝对地址 → null（调用方报 `认证质询无法解析`）。
 */
function buildTokenUrl(challenge: RegistryChallenge): string | null {
  if (challenge.realm === null) return null;
  let url: URL;
  try {
    url = new URL(challenge.realm);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (challenge.service !== null) url.searchParams.set("service", challenge.service);
  if (challenge.scope !== null) url.searchParams.set("scope", challenge.scope);
  return url.toString();
}

/** token 端点响应体：`token` 优先，其次 OAuth2 兼容的 `access_token`；都为空为 null。 */
function parseToken(text: string): string | null {
  if (text.trim() === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  for (const key of ["token", "access_token"]) {
    const item = row[key];
    if (typeof item === "string" && item.trim() !== "") return item.trim();
  }
  return null;
}

/** 非 401 的状态码映射（契约 §4.2 逐字）。 */
function statusError(status: number): string {
  if (status === 403) return "认证被拒绝（403）：用户名或 token 无效，或该账号无权访问";
  if (status === 404) {
    return "接口不存在：请确认填写的是镜像仓库根地址（如 https://hub.example.com），不要带路径";
  }
  if (status === 429) return "镜像仓库触发限流，稍后重试";
  return `镜像仓库返回 HTTP ${status}`;
}

function succeeded(username: string, version: string | null): RegistryCheck {
  return { ok: true, username, version, detail: null, error: null };
}

function failed(error: string): RegistryCheck {
  return { ok: false, username: null, version: null, detail: null, error };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestErrorDetail(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const base = message(error);
  return cause instanceof Error ? `${base}: ${cause.message}` : base;
}