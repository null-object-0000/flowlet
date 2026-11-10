// 三方服务凭据：类型、校验与业务编排。Owner: node-web.
//
// 权威实现：src-tauri/src/core/service_credentials.rs（349 行）。
// 明文只在保存/校验/导出时短暂出现在内存中；落库的是 SecretBox 密文 + 展示掩码。
// 存储读写全部走 node-storage 的 5 个方fal（snake_case ServiceCredentialRow）；
// 本模块不写 SQL。
import { randomUUID } from "node:crypto";

import type { JsonRow } from "../types.ts";
import { CommandError } from "../types.ts";
import type { WebContext } from "./context.ts";
import {
  BeszelClient,
  BeszelError,
  normalizeBaseUrl as normalizeBeszelBaseUrl,
} from "./beszel.ts";
import {
  DockhandClient,
  DockhandError,
  normalizeBaseUrl as normalizeDockhandBaseUrl,
} from "./dockhand.ts";
import { GitlabClient, GitlabError, normalizeBaseUrl } from "./gitlab.ts";
import {
  JenkinsClient,
  JenkinsError,
  normalizeBaseUrl as normalizeJenkinsBaseUrl,
} from "./jenkins.ts";
import {
  checkRegistry,
  normalizeRegistryUrl,
  normalizeRegistryUsername,
  registryHost,
} from "./registry.ts";
import {
  UptimeKumaClient,
  UptimeKumaError,
  normalizeBaseUrl as normalizeUptimeKumaBaseUrl,
  summarizeMetrics,
} from "./uptime-kuma.ts";

export const PROVIDER_GITLAB = "gitlab";
export const PROVIDER_DOCKHAND = "dockhand";
export const PROVIDER_JENKINS = "jenkins";
export const PROVIDER_BESZEL = "beszel";
export const PROVIDER_UPTIME_KUMA = "uptime-kuma";
export const PROVIDER_REGISTRY = "registry";

export interface ServiceCredentialView {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  /** Jenkins 用户名 / Beszel 登录邮箱 / OCI 镜像仓库用户名（明文，不是密文）；
   * GitLab/Dockhand/Uptime Kuma 恒为 null。 */
  username: string | null;
  /** 第二期：解析后的环境变量前缀（大写）。旧行（env_prefix NULL）按 provider 默认返回。 */
  envPrefix: string;
  kind: string;
  note: string | null;
  enabled: boolean;
  secretHint: string;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt: string | null;
  lastError: string | null;
}

export interface ServiceCredentialInput {
  id?: string;
  name: string;
  provider: string;
  baseUrl: string;
  /** Jenkins 用户名 / Beszel 登录邮箱 / OCI 镜像仓库用户名；仅 jenkins、beszel、registry 生效，
   * 其它 provider 忽略，编辑时为空表示保留原值。 */
  username?: string | null;
  token?: string;
  /** 环境别名（Env 前缀）；空/NULL → provider 默认前缀。 */
  envPrefix?: string | null;
  kind?: string;
  note?: string;
  enabled?: boolean;
}

export interface CredentialCheck {
  ok: boolean;
  username: string | null;
  version: string | null;
  /** provider 专属的补充说明（Dockhand 为「N 个环境」；Beszel 为「N 台系统」；
   * GitLab/Registry 恒 null）。 */
  detail: string | null;
  error: string | null;
}

export interface ServiceCredentialExport {
  name: string;
  provider: string;
  baseUrl: string;
  /** Jenkins 用户名 / Beszel 登录邮箱 / OCI 镜像仓库用户名；GitLab/Dockhand 恒为 null
   * （旧服务端响应可能缺失）。 */
  username: string | null;
  envPrefix: string;
  token: string;
}

export interface CredentialProvider {
  id: string;
  label: string;
  baseUrlHint: string;
  tokenLabel: string;
  /** 需要用户名一起认证时给出输入框标签（Jenkins/Registry 为「用户名」，Beszel 为「邮箱」）；
   * 其它 provider 为 null。 */
  usernameLabel: string | null;
  /** 未设置 envPrefix 时生成的默认环境前缀（前端 placeholder/preview 用）。 */
  defaultEnvPrefix: string;
  available: boolean;
}

/** node-storage 的凭据方法（与 Rust storage_credentials.rs 一一对应）。 */
interface CredentialStorage {
  listServiceCredentials(): JsonRow[];
  getServiceCredential(id: string): JsonRow | null;
  upsertServiceCredential(row: JsonRow): void;
  updateServiceCredentialVerification(id: string, verifiedAt: string | null, lastError: string | null): void;
  deleteServiceCredential(id: string): boolean;
}

function storageOf(ctx: WebContext): CredentialStorage {
  return ctx.storage as unknown as CredentialStorage;
}

export function providers(): CredentialProvider[] {
  return [
    {
      id: PROVIDER_GITLAB,
      label: "GitLab",
      baseUrlHint: "https://gitlab.example.com",
      tokenLabel: "Personal Access Token（需要 api scope）",
      usernameLabel: null,
      defaultEnvPrefix: "GITLAB",
      available: true,
    },
    {
      id: PROVIDER_DOCKHAND,
      label: "Dockhand",
      baseUrlHint: "http://dockhand.example.com:3000",
      tokenLabel: "API Token（Dockhand 设置 → API 令牌）",
      usernameLabel: null,
      defaultEnvPrefix: "DOCKHAND",
      available: true,
    },
    {
      id: PROVIDER_JENKINS,
      label: "Jenkins",
      baseUrlHint: "https://jenkins.example.com",
      tokenLabel: "API Token（Jenkins 用户设置 → API Token）",
      usernameLabel: "用户名",
      defaultEnvPrefix: "JENKINS",
      available: true,
    },
    {
      id: PROVIDER_UPTIME_KUMA,
      label: "Uptime Kuma",
      baseUrlHint: "https://uptime-kuma.example.com/uptime-kuma",
      tokenLabel: "API Key（设置 → API 密钥；仅用于读取 /metrics 指标）",
      usernameLabel: null,
      defaultEnvPrefix: "UPTIME_KUMA",
      available: true,
    },
    {
      id: PROVIDER_BESZEL,
      label: "Beszel",
      baseUrlHint: "http://beszel.example.com:8090",
      tokenLabel: "登录密码（Beszel 用户密码）",
      usernameLabel: "邮箱",
      defaultEnvPrefix: "BESZEL",
      available: true,
    },
    {
      id: PROVIDER_REGISTRY,
      label: "OCI 镜像仓库",
      baseUrlHint: "https://hub.example.com（只填仓库地址，不要带路径）",
      tokenLabel: "密码 / Token（docker login 的密码；Harbor robot account 填其 token）",
      usernameLabel: "用户名",
      defaultEnvPrefix: "REGISTRY",
      available: true,
    },
  ];
}

export function isSupportedProvider(provider: string): boolean {
  return (
    provider === PROVIDER_GITLAB ||
    provider === PROVIDER_DOCKHAND ||
    provider === PROVIDER_JENKINS ||
    provider === PROVIDER_UPTIME_KUMA ||
    provider === PROVIDER_BESZEL ||
    provider === PROVIDER_REGISTRY
  );
}

/** 按 provider 归一地址（各 Host 的报错文案各自带 provider 前缀）。 */
function normalizeProviderBaseUrl(provider: string, raw: string): string {
  if (provider === PROVIDER_DOCKHAND) return normalizeDockhandBaseUrl(raw);
  if (provider === PROVIDER_JENKINS) return normalizeJenkinsBaseUrl(raw);
  if (provider === PROVIDER_UPTIME_KUMA) return normalizeUptimeKumaBaseUrl(raw);
  if (provider === PROVIDER_BESZEL) return normalizeBeszelBaseUrl(raw);
  if (provider === PROVIDER_REGISTRY) return normalizeRegistryUrl(raw);
  return normalizeBaseUrl(raw);
}

/** provider 默认环境前缀：gitlab → GITLAB、dockhand → DOCKHAND、jenkins → JENKINS、
 * uptime-kuma → UPTIME_KUMA、beszel → BESZEL、registry → REGISTRY。 */
export function defaultEnvPrefix(provider: string): string {
  if (provider === PROVIDER_GITLAB) return "GITLAB";
  if (provider === PROVIDER_DOCKHAND) return "DOCKHAND";
  if (provider === PROVIDER_JENKINS) return "JENKINS";
  if (provider === PROVIDER_UPTIME_KUMA) return "UPTIME_KUMA";
  if (provider === PROVIDER_BESZEL) return "BESZEL";
  if (provider === PROVIDER_REGISTRY) return "REGISTRY";
  // save/test 会先做 provider 校验；这里只兜底旧库中可能存在的未知 provider 行。
  return provider.trim().toUpperCase();
}

/**
 * 环境前缀归一（phase2-spec §1.2，文案与 Rust `normalize_env_prefix` 一致）：
 * - 空 → provider 默认前缀；
 * - 只做 ASCII 大写（对应 Rust `to_ascii_uppercase`，避免 `ß`→`SS` 这类 Unicode 上标）；
 * - 长度按 UTF-8 字节计（对应 Rust `String::len`）；
 * - 正则 `^[A-Z][A-Z0-9_]{0,23}$`。
 */
export function normalizeEnvPrefix(raw: string | null | undefined, provider: string): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return defaultEnvPrefix(provider);
  const upper = trimmed.replace(/[a-z]/g, (char) => char.toUpperCase());
  if (Buffer.byteLength(upper, "utf8") > 24) throw new Error("环境前缀不能超过 24 个字符");
  if (!/^[A-Z][A-Z0-9_]{0,23}$/.test(upper)) {
    throw new Error("环境前缀只能包含字母、数字和下划线，且以字母开头");
  }
  return upper;
}

/** 行里存的解析后前缀；旧行 `env_prefix` NULL 时按 provider 默认。 */
function resolveEnvPrefix(row: JsonRow): string {
  const stored = typeof row.env_prefix === "string" ? row.env_prefix : "";
  return stored === "" ? defaultEnvPrefix(String(row.provider ?? "")) : stored;
}

/**
 * 环境前缀唯一性校验（phase2-spec §1.2）：只在启用中的凭据间比较（不同 provider 也算冲突，
 * 因为生成的环境变量名相同）。返回错误文案；无冲突返回 null。
 * `selfId` 用于编辑时排除自己。
 */
export function validateEnvPrefixConflict(
  rows: JsonRow[],
  selfId: string | null,
  provider: string,
  rawPrefix: string,
): string | null {
  const prefix = normalizeEnvPrefix(rawPrefix, provider);
  for (const row of rows) {
    if (!Boolean(row.enabled)) continue;
    if (selfId !== null && String(row.id ?? "") === selfId) continue;
    if (resolveEnvPrefix(row) !== prefix) continue;
    return `环境前缀已被「${String(row.name ?? "")}」占用：${prefix}（同一前缀会生成相同的环境变量名）`;
  }
  return null;
}

/** RFC3339 秒级 UTC（与 Rust `to_rfc3339_opts(SecondsFormat::Secs, true)` 一致）。 */
export function nowRfc3339(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** 展示掩码：按 Unicode code point 计长，保留最后 4 位（Rust char 语义）。 */
export function maskSecret(secret: string): string {
  const chars = [...secret];
  if (chars.length <= 4) return "••••";
  return `••••${chars.slice(chars.length - 4).join("")}`;
}

function viewOf(row: JsonRow): ServiceCredentialView {
  return {
    id: String(row.id ?? ""),
    name: String(row.name ?? ""),
    provider: String(row.provider ?? ""),
    baseUrl: String(row.base_url ?? ""),
    username: typeof row.username === "string" ? row.username : null,
    envPrefix: resolveEnvPrefix(row),
    kind: String(row.kind ?? "cli_token"),
    note: typeof row.note === "string" ? row.note : null,
    enabled: Boolean(row.enabled),
    secretHint: String(row.secret_hint ?? ""),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    lastVerifiedAt: typeof row.last_verified_at === "string" ? row.last_verified_at : null,
    lastError: typeof row.last_error === "string" ? row.last_error : null,
  };
}

export function list(ctx: WebContext): ServiceCredentialView[] {
  return storageOf(ctx).listServiceCredentials().map(viewOf);
}

/** 校验一个 GitLab 凭据；返回结构化结果而不是抛错（与 Rust `check_gitlab` 一致）。 */
export async function checkGitlab(
  baseUrl: string,
  token: string,
  insecure: boolean,
): Promise<CredentialCheck> {
  let client: GitlabClient;
  try {
    client = new GitlabClient(baseUrl, token, { insecure });
  } catch (error) {
    return { ok: false, username: null, version: null, detail: null, error: message(error) };
  }
  try {
    const user = await client.currentUser();
    const username =
      user !== null && typeof user === "object" && !Array.isArray(user) &&
      typeof (user as JsonRow).username === "string"
        ? ((user as JsonRow).username as string)
        : null;
    let version: string | null = null;
    try {
      version = await client.version();
    } catch {
      version = null;
    }
    return { ok: true, username, version, detail: null, error: null };
  } catch (error) {
    return {
      ok: false,
      username: null,
      version: null,
      detail: null,
      error: error instanceof GitlabError ? error.toString() : message(error),
    };
  }
}

/**
 * 校验一个 Dockhand 凭据；返回结构化结果而不是抛错（与 Rust `check_dockhand` 一致）。
 * Dockhand 没有「当前 token 用户」接口，username/version 恒为 null；认证通过即返回环境数量。
 */
export async function checkDockhand(
  baseUrl: string,
  token: string,
  insecure: boolean,
): Promise<CredentialCheck> {
  let client: DockhandClient;
  try {
    client = new DockhandClient(baseUrl, token, { insecure });
  } catch (error) {
    return { ok: false, username: null, version: null, detail: null, error: message(error) };
  }
  try {
    const environments = await client.environments();
    return {
      ok: true,
      username: null,
      version: null,
      detail: `${environments.length} 个环境`,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      username: null,
      version: null,
      detail: null,
      error: error instanceof DockhandError ? error.toString() : message(error),
    };
  }
}

/**
 * 校验一个 Jenkins 凭据；返回结构化结果而不是抛错（与 Rust `check_jenkins` 一致）。
 * `/me/api/json` 同时确认用户名与 API Token：Jenkins 的 token 必须与用户名一起用
 * Basic 认证，单独校验 token 没有意义。版本取 `X-Jenkins` 响应头。
 */
export async function checkJenkins(
  baseUrl: string,
  username: string,
  token: string,
  insecure: boolean,
): Promise<CredentialCheck> {
  let client: JenkinsClient;
  try {
    client = new JenkinsClient(baseUrl, username, token, { insecure });
  } catch (error) {
    return { ok: false, username: null, version: null, detail: null, error: message(error) };
  }
  try {
    const identity = await client.identity();
    return {
      ok: true,
      username: identity.username,
      version: identity.version,
      detail: null,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      username: null,
      version: null,
      detail: null,
      error: error instanceof JenkinsError ? error.toString() : message(error),
    };
  }
}

/**
 * 校验一个 Beszel 凭据；返回结构化结果而不是抛错（与 Rust `check_beszel` 一致）。
 * Beszel 没有长期 token：先用邮箱 + 密码换 PocketBase 短期 token（auth 失败即失败），
 * `GET /api/beszel/info` 取 Hub 版本（失败不致命），`systems?perPage=1` 取 `totalItems`
 * 作为 detail。成功时 username 用服务端记录的邮箱（为空回退入参邮箱）。
 */
export async function checkBeszel(
  baseUrl: string,
  email: string,
  password: string,
  insecure: boolean,
): Promise<CredentialCheck> {
  let client: BeszelClient;
  try {
    client = new BeszelClient(baseUrl, email, password, { insecure });
  } catch (error) {
    return { ok: false, username: null, version: null, detail: null, error: message(error) };
  }
  try {
    const auth = await client.auth();
    let version: string | null = null;
    try {
      version = await client.info();
    } catch {
      version = null;
    }
    const systems = await client.systems(1);
    const recordEmail = auth.email;
    return {
      ok: true,
      username:
        recordEmail !== null && recordEmail.trim() !== "" ? recordEmail : email.trim(),
      version,
      detail: `${systems.totalItems} 台系统`,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      username: null,
      version: null,
      detail: null,
      error: error instanceof BeszelError ? error.toString() : message(error),
    };
  }
}

/**
 * 校验一个 Uptime Kuma 凭据；返回结构化结果而不是抛错（与 Rust `check_uptime_kuma` 一致）。
 * 2.x 没有监控管理 REST API，`/metrics` 是唯一能确认 API Key 的端点；
 * `/metrics` 用 Basic 认证（用户名空、密码为 Key）。版本取内部构建版本
 * `app_version{version="0.0.28"}`，监控数量与 up/down 作为 detail。
 */
export async function checkUptimeKuma(
  baseUrl: string,
  token: string,
  insecure: boolean,
): Promise<CredentialCheck> {
  let client: UptimeKumaClient;
  try {
    client = new UptimeKumaClient(baseUrl, token, { insecure });
  } catch (error) {
    return { ok: false, username: null, version: null, detail: null, error: message(error) };
  }
  try {
    const metrics = await client.metrics();
    return {
      ok: true,
      username: null,
      version: metrics.version,
      detail: summarizeMetrics(metrics),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      username: null,
      version: null,
      detail: null,
      error: error instanceof UptimeKumaError ? error.toString() : message(error),
    };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(text: string): never {
  throw CommandError.badRequest(text);
}

/**
 * 归一保存入参的 username（契约 §3.2 / §6，与 Rust `normalize_username` 一致）：
 * - gitlab / dockhand / uptime-kuma：忽略入参，恒落库 null；
 * - jenkins：trim 后必须非空（编辑时传空表示保留原值）、不超过 64 个字符，
 *   且不能含冒号/空白/控制字符（Basic 认证用 `:` 分隔，含冒号会改变凭据含义）；
 * - beszel：username 列存**登录邮箱**，规则与 jenkins 同构（必填可回退 existing、
 *   不超过 254 个字符、基本 @ 校验）；
 * - registry：username 列存 docker login 用户名（必填可回退 existing、不超过 255 个字符、
 *   不能含冒号/空白/控制字符；规则见 registry.ts `normalizeRegistryUsername`）。
 */
function normalizeUsername(
  provider: string,
  raw: string | null | undefined,
  existing: JsonRow | null,
): string | null {
  if (provider === PROVIDER_REGISTRY) {
    return normalizeRegistryUsername(
      raw,
      typeof existing?.username === "string" ? existing.username : null,
    );
  }
  if (provider === PROVIDER_BESZEL) {
    const trimmed = (raw ?? "").trim();
    if (trimmed === "") {
      const previous = typeof existing?.username === "string" ? existing.username.trim() : "";
      if (previous === "") fail("Beszel 需要填写邮箱（Beszel 用邮箱 + 密码登录）");
      validateBeszelEmail(previous);
      return previous;
    }
    validateBeszelEmail(trimmed);
    return trimmed;
  }
  if (provider !== PROVIDER_JENKINS) return null;
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") {
    const previous = typeof existing?.username === "string" ? existing.username.trim() : "";
    if (previous === "") fail("Jenkins 需要填写用户名（API Token 必须与用户名一起认证）");
    validateJenkinsUsername(previous);
    return previous;
  }
  validateJenkinsUsername(trimmed);
  return trimmed;
}

/** Beszel 邮箱：≤254 个字符（Rust `chars().count()`），trim 后恰好一个 `@` 且两侧非空。 */
function validateBeszelEmail(email: string): void {
  if ([...email].length > 254) fail("Beszel 邮箱不能超过 254 个字符");
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@") || at === email.length - 1) {
    fail("Beszel 邮箱格式不正确");
  }
}

function validateJenkinsUsername(username: string): void {
  if ([...username].length > 64) fail("Jenkins 用户名不能超过 64 个字符");
  if ([...username].some((char) => /[\s:]/.test(char) || (char.codePointAt(0) ?? 0) < 0x20)) {
    fail("Jenkins 用户名不能包含冒号、空格或控制字符");
  }
}

export async function save(
  ctx: WebContext,
  input: ServiceCredentialInput,
  insecure: boolean,
): Promise<ServiceCredentialView> {
  const name = input.name.trim();
  if (name === "") fail("凭据名称不能为空");
  if ([...name].length > 64) fail("凭据名称不能超过 64 个字符");
  if (!isSupportedProvider(input.provider)) {
    fail(
      `暂不支持的服务类型：${input.provider}（当前支持 gitlab、dockhand、jenkins、uptime-kuma、beszel、registry）`,
    );
  }
  let baseUrl: string;
  try {
    baseUrl = normalizeProviderBaseUrl(input.provider, input.baseUrl);
  } catch (error) {
    return fail(message(error));
  }
  let envPrefix: string;
  try {
    envPrefix = normalizeEnvPrefix(input.envPrefix ?? "", input.provider);
  } catch (error) {
    return fail(message(error));
  }
  const enabled = input.enabled ?? true;
  const kind =
    typeof input.kind === "string" && input.kind.trim() !== "" ? input.kind.trim() : "cli_token";

  const storage = storageOf(ctx);
  let existing: JsonRow | null = null;
  if (typeof input.id === "string") {
    existing = storage.getServiceCredential(input.id);
    if (existing === null) fail(`凭据不存在：${input.id}`);
  }
  const providedToken =
    typeof input.token === "string" && input.token.trim() !== "" ? input.token.trim() : null;
  let token: string;
  if (providedToken !== null) {
    token = providedToken;
  } else if (existing !== null) {
    try {
      token = ctx.secrets.decrypt(String(existing.secret_ciphertext ?? ""));
    } catch (error) {
      return fail(`原凭据无法解密：${message(error)}`);
    }
  } else {
    return fail("新建凭据时必须填写 token");
  }
  // 只有 jenkins / beszel 使用 username 列；其它 provider 一律落 NULL。
  // 编辑时传空表示保留原行用户名/邮箱。
  const username = normalizeUsername(input.provider, input.username, existing);

  // 环境前缀唯一性：只在启用中的凭据间检查，避免 pull 生成同名环境变量把另一个实例覆盖。
  // 放在网络校验之前，冲突属于纯配置错误，不必为必然失败的保存发请求。
  if (enabled) {
    const conflict = validateEnvPrefixConflict(
      storage.listServiceCredentials(),
      typeof input.id === "string" ? input.id : null,
      input.provider,
      envPrefix,
    );
    if (conflict !== null) return fail(conflict);
  }

  // 先验证再落库：token 无效或实例不可达时不写坏数据。
  const check =
    input.provider === PROVIDER_DOCKHAND
      ? await checkDockhand(baseUrl, token, insecure)
      : input.provider === PROVIDER_JENKINS
        ? await checkJenkins(baseUrl, username ?? "", token, insecure)
        : input.provider === PROVIDER_UPTIME_KUMA
          ? await checkUptimeKuma(baseUrl, token, insecure)
          : input.provider === PROVIDER_BESZEL
            ? await checkBeszel(baseUrl, username ?? "", token, insecure)
            : input.provider === PROVIDER_REGISTRY
              ? await checkRegistry(baseUrl, username ?? "", token, insecure)
              : await checkGitlab(baseUrl, token, insecure);
  if (!check.ok) {
    return fail(`校验失败，未保存：${check.error ?? "未知错误"}`);
  }
  const verifiedAt = nowRfc3339();
  let ciphertext: string;
  try {
    ciphertext = ctx.secrets.encrypt(token);
  } catch (error) {
    return fail(`加密凭据失败：${message(error)}`);
  }
  const timestamp = nowRfc3339();
  const row: JsonRow = {
    id: typeof input.id === "string" ? input.id : randomUUID(),
    name,
    provider: input.provider,
    base_url: baseUrl,
    secret_ciphertext: ciphertext,
    secret_hint: maskSecret(token),
    kind,
    note: typeof input.note === "string" && input.note.trim() !== "" ? input.note.trim() : null,
    env_prefix: envPrefix,
    username,
    enabled,
    created_at: existing !== null ? String(existing.created_at ?? timestamp) : timestamp,
    updated_at: timestamp,
    last_verified_at: verifiedAt,
    last_error: null,
  };
  storage.upsertServiceCredential(row);
  return viewOf(row);
}

export async function test(
  ctx: WebContext,
  id: string,
  insecure: boolean,
): Promise<CredentialCheck> {
  const storage = storageOf(ctx);
  const row = storage.getServiceCredential(id);
  if (row === null) fail(`凭据不存在：${id}`);
  let token: string;
  try {
    token = ctx.secrets.decrypt(String(row.secret_ciphertext ?? ""));
  } catch (error) {
    return fail(`凭据无法解密：${message(error)}`);
  }
  const provider = String(row.provider ?? "");
  if (!isSupportedProvider(provider)) fail(`暂不支持测试该服务类型：${provider}`);
  const baseUrl = String(row.base_url ?? "");
  const check =
    provider === PROVIDER_DOCKHAND
      ? await checkDockhand(baseUrl, token, insecure)
      : provider === PROVIDER_JENKINS
        ? await checkJenkins(
            baseUrl,
            typeof row.username === "string" ? row.username : "",
            token,
            insecure,
          )
        : provider === PROVIDER_UPTIME_KUMA
          ? await checkUptimeKuma(baseUrl, token, insecure)
          : provider === PROVIDER_BESZEL
            ? await checkBeszel(
                baseUrl,
                typeof row.username === "string" ? row.username : "",
                token,
                insecure,
              )
            : provider === PROVIDER_REGISTRY
              ? await checkRegistry(
                  baseUrl,
                  typeof row.username === "string" ? row.username : "",
                  token,
                  insecure,
                )
              : await checkGitlab(baseUrl, token, insecure);
  const verifiedAt = check.ok ? nowRfc3339() : null;
  storage.updateServiceCredentialVerification(id, verifiedAt, check.error);
  return check;
}

export function deleteCredential(ctx: WebContext, id: string): null {
  const removed = storageOf(ctx).deleteServiceCredential(id);
  if (!removed) fail(`凭据不存在：${id}`);
  return null;
}

export interface ServiceCredentialReveal {
  id: string;
  name: string;
  provider: string;
  /** Jenkins 用户名 / Beszel 登录邮箱 / OCI 镜像仓库用户名（明文）；
   * GitLab/Dockhand/Uptime Kuma 恒为 null。 */
  username: string | null;
  envPrefix: string;
  /** 明文 token：只返回给已鉴权的管理调用，不写日志、不落库、不缓存。 */
  token: string;
}

/**
 * 管理台「查看原始 token」：解密单条已保存凭据。
 *
 * 权限：只走管理鉴权（Cookie 会话 + CSRF / token 模式 Bearer）；`flowlet login` 签发的
 * CLI token 作用域仅 `credentials:read` 且白名单只有 `export_service_credentials`，
 * 因此不能调用本命令。
 */
export function revealCredential(ctx: WebContext, id: string): ServiceCredentialReveal {
  const row = storageOf(ctx).getServiceCredential(id);
  if (row === null) fail(`凭据不存在：${id}`);
  const name = String(row!.name ?? "");
  let token: string;
  try {
    token = ctx.secrets.decrypt(String(row!.secret_ciphertext ?? ""));
  } catch (error) {
    return fail(`凭据 ${name} 无法解密：${message(error)}`);
  }
  return {
    id: String(row!.id ?? id),
    name,
    provider: String(row!.provider ?? ""),
    username: typeof row!.username === "string" ? row!.username : null,
    envPrefix: resolveEnvPrefix(row!),
    token,
  };
}

/** `flowlet pull` 的导出：只导出启用中的凭据（含明文，仅在已鉴权接口返回）。 */
export function exportCredentials(ctx: WebContext): ServiceCredentialExport[] {
  const rows = storageOf(ctx).listServiceCredentials().filter((row) => Boolean(row.enabled));
  const exports: ServiceCredentialExport[] = [];
  for (const row of rows) {
    let token: string;
    try {
      token = ctx.secrets.decrypt(String(row.secret_ciphertext ?? ""));
    } catch (error) {
      return fail(`凭据 ${String(row.name ?? "")} 无法解密：${message(error)}`);
    }
    exports.push({
      name: String(row.name ?? ""),
      provider: String(row.provider ?? ""),
      baseUrl: String(row.base_url ?? ""),
      username: typeof row.username === "string" ? row.username : null,
      envPrefix: resolveEnvPrefix(row),
      token,
    });
  }
  return exports;
}

/** 供 CLI 拉取时把服务凭据映射成 dotenv 键名（与 Rust `env_keys` 一致）。 */
export function envKeys(item: ServiceCredentialExport): Array<[string, string, string]> {
  // 未登记的 provider pull 侧跳过；旧服务端的导出可能没有 envPrefix，回退 provider 默认。
  if (!isSupportedProvider(item.provider)) return [];
  const prefix =
    item.envPrefix.trim() === "" ? defaultEnvPrefix(item.provider) : item.envPrefix;
  // Jenkins 需要 Basic 认证：多输出一把 USER（取导出的 username，缺失时为空串）。
  if (item.provider === PROVIDER_JENKINS) {
    return [
      [`${prefix}_URL`, item.baseUrl, "service"],
      [`${prefix}_USER`, item.username ?? "", "service"],
      [`${prefix}_TOKEN`, item.token, "cli_token"],
    ];
  }
  // Beszel 用「邮箱 + 密码」登录：多输出一把 EMAIL（取导出的 username，旧服务端缺失时为空串），
  // 密码变量名是 `_PASSWORD`（不是 token）。
  if (item.provider === PROVIDER_BESZEL) {
    return [
      [`${prefix}_URL`, item.baseUrl, "service"],
      [`${prefix}_EMAIL`, item.username ?? "", "service"],
      [`${prefix}_PASSWORD`, item.token, "cli_token"],
    ];
  }
  // OCI 镜像仓库：地址键是 `_HOST`（值不带 scheme/路径，可直接 `docker login $REGISTRY_HOST`），
  // 三把键固定顺序 HOST / USER / TOKEN；旧服务端导出没有 username 时 USER 写空串。
  if (item.provider === PROVIDER_REGISTRY) {
    return [
      [`${prefix}_HOST`, registryHost(item.baseUrl), "service"],
      [`${prefix}_USER`, item.username ?? "", "service"],
      [`${prefix}_TOKEN`, item.token, "cli_token"],
    ];
  }
  // Uptime Kuma 的 Key 只用于 `/metrics` 鉴权，变量名沿用公司 infra skill 的
  // `UPTIME_KUMA_API_KEY`（其它 provider 仍用 `_TOKEN`）。
  const tokenKey = item.provider === PROVIDER_UPTIME_KUMA ? `${prefix}_API_KEY` : `${prefix}_TOKEN`;
  return [
    [`${prefix}_URL`, item.baseUrl, "service"],
    [tokenKey, item.token, "cli_token"],
  ];
}