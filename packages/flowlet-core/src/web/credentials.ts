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
import { GitlabClient, GitlabError, normalizeBaseUrl } from "./gitlab.ts";

export const PROVIDER_GITLAB = "gitlab";

export interface ServiceCredentialView {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
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
  kind?: string;
  note?: string;
  enabled?: boolean;
}

export interface CredentialCheck {
  ok: boolean;
  username: string | null;
  version: string | null;
  error: string | null;
}

export interface ServiceCredentialExport {
  name: string;
  provider: string;
  baseUrl: string;
  token: string;
}

export interface CredentialProvider {
  id: string;
  label: string;
  baseUrlHint: string;
  tokenLabel: string;
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
      available: true,
    },
  ];
}

export function isSupportedProvider(provider: string): boolean {
  return provider === PROVIDER_GITLAB;
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
    return { ok: false, username: null, version: null, error: message(error) };
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
    return { ok: true, username, version, error: null };
  } catch (error) {
    return {
      ok: false,
      username: null,
      version: null,
      error: error instanceof GitlabError ? error.toString() : message(error),
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
    fail(`暂不支持的服务类型：${input.provider}（当前只支持 gitlab）`);
  }
  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(input.baseUrl);
  } catch (error) {
    return fail(message(error));
  }
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

  // 先验证再落库：token 无效或实例不可达时不写坏数据。
  const check = await checkGitlab(baseUrl, token, insecure);
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
    enabled: input.enabled ?? true,
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
  if (provider !== PROVIDER_GITLAB) fail(`暂不支持测试该服务类型：${provider}`);
  const check = await checkGitlab(String(row.base_url ?? ""), token, insecure);
  const verifiedAt = check.ok ? nowRfc3339() : null;
  storage.updateServiceCredentialVerification(id, verifiedAt, check.error);
  return check;
}

export function deleteCredential(ctx: WebContext, id: string): null {
  const removed = storageOf(ctx).deleteServiceCredential(id);
  if (!removed) fail(`凭据不存在：${id}`);
  return null;
}

/** `flowlet-cred pull` 的导出：只导出启用中的凭据（含明文，仅在已鉴权接口返回）。 */
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
      token,
    });
  }
  return exports;
}

/** 供 CLI 拉取时把服务凭据映射成 dotenv 键名（与 Rust `env_keys` 一致）。 */
export function envKeys(item: ServiceCredentialExport): Array<[string, string, string]> {
  if (item.provider === PROVIDER_GITLAB) {
    return [
      ["GITLAB_URL", item.baseUrl, "service"],
      ["GITLAB_TOKEN", item.token, "cli_token"],
    ];
  }
  return [];
}