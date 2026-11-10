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
  DockhandClient,
  DockhandError,
  normalizeBaseUrl as normalizeDockhandBaseUrl,
} from "./dockhand.ts";
import { GitlabClient, GitlabError, normalizeBaseUrl } from "./gitlab.ts";

export const PROVIDER_GITLAB = "gitlab";
export const PROVIDER_DOCKHAND = "dockhand";

export interface ServiceCredentialView {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
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
  /** provider 专属的补充说明（Dockhand 为「N 个环境」；GitLab 恒 null）。 */
  detail: string | null;
  error: string | null;
}

export interface ServiceCredentialExport {
  name: string;
  provider: string;
  baseUrl: string;
  envPrefix: string;
  token: string;
}

export interface CredentialProvider {
  id: string;
  label: string;
  baseUrlHint: string;
  tokenLabel: string;
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
      defaultEnvPrefix: "GITLAB",
      available: true,
    },
    {
      id: PROVIDER_DOCKHAND,
      label: "Dockhand",
      baseUrlHint: "http://dockhand.example.com:3000",
      tokenLabel: "API Token（Dockhand 设置 → API 令牌）",
      defaultEnvPrefix: "DOCKHAND",
      available: true,
    },
  ];
}

export function isSupportedProvider(provider: string): boolean {
  return provider === PROVIDER_GITLAB || provider === PROVIDER_DOCKHAND;
}

/** 按 provider 归一地址（两套 Host 的报错文案各自带 provider 前缀）。 */
function normalizeProviderBaseUrl(provider: string, raw: string): string {
  return provider === PROVIDER_DOCKHAND
    ? normalizeDockhandBaseUrl(raw)
    : normalizeBaseUrl(raw);
}

/** provider 默认环境前缀：gitlab → GITLAB、dockhand → DOCKHAND。 */
export function defaultEnvPrefix(provider: string): string {
  if (provider === PROVIDER_GITLAB) return "GITLAB";
  if (provider === PROVIDER_DOCKHAND) return "DOCKHAND";
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(text: string): never {
  throw CommandError.badRequest(text);
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
    fail(`暂不支持的服务类型：${input.provider}（当前支持 gitlab、dockhand）`);
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
  return [
    [`${prefix}_URL`, item.baseUrl, "service"],
    [`${prefix}_TOKEN`, item.token, "cli_token"],
  ];
}