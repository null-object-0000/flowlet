/** 管理台登录提供方（GitHub）的可持久化配置。
 *
 * 为什么单独一层：provider 以前只能靠 `FLOWLET_GITHUB_*` 环境变量配，改一次就得改 compose + 重启
 * 容器；而 client_secret 又不能明文落盘。这里的做法是：
 *
 * - 非敏感字段 + **加密后的** client_secret 一起存进 `app_meta`（数据卷里的 SQLite）；
 * - 写的时候用 `SecretBox`（数据卷 `secret.key`）加密，读的时候解密后交给
 *   `AdminAuth.applyGithubConfig()` 热替换，进程重启后从库里恢复；
 * - 环境变量仍然生效，作为**没有库内配置时**的种子（老部署不用动）。
 */
import type { GithubConfig } from "./auth.ts";

/** app_meta 里的键；带 v1 方便以后换结构。 */
export const GITHUB_PROVIDER_META_KEY = "auth_provider_github_v1";

/** 落库的形状：secret 只以密文存在。 */
interface StoredGithubProvider {
  client_id: string;
  client_secret_ciphertext: string;
  scopes: string;
  display_name: string;
  allowed_logins: string[];
  allowed_emails: string[];
  allowed_orgs: string[];
  admin_logins: string[];
  admin_emails: string[];
  allow_any: boolean;
  authorize_url: string;
  token_url: string;
  api_base: string;
}

/** 管理台表单提交的形状；`client_secret` 为空串表示「保留已存的」。 */
export interface GithubProviderInput {
  client_id: string;
  client_secret?: string | null;
  scopes?: string | null;
  display_name?: string | null;
  allowed_logins?: string[] | null;
  allowed_emails?: string[] | null;
  allowed_orgs?: string[] | null;
  admin_logins?: string[] | null;
  admin_emails?: string[] | null;
  allow_any?: boolean | null;
  authorize_url?: string | null;
  token_url?: string | null;
  api_base?: string | null;
}

/** 回给管理台的视图：**永不包含 secret 明文或密文**。 */
export interface GithubProviderSummary {
  configured: boolean;
  client_id: string;
  display_name: string;
  scopes: string;
  allowed_logins: string[];
  allowed_emails: string[];
  allowed_orgs: string[];
  admin_logins: string[];
  admin_emails: string[];
  allow_any: boolean;
  authorize_url: string;
  token_url: string;
  api_base: string;
  secret_set: boolean;
}

export interface GithubCheckResult {
  ok: boolean;
  message: string;
}

const DEFAULT_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const DEFAULT_TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEFAULT_API_BASE = "https://api.github.com";

export interface AuthProviderStorage {
  getAppMeta(key: string): string | null;
  setAppMeta(key: string, value: string): void;
}

export interface AuthProviderSecrets {
  encrypt(plaintext: string): string;
  decrypt(encoded: string): string;
}

function cleanList(value: string[] | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const trimmed = String(item ?? "").trim();
    if (trimmed === "") continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function normalizeUrl(value: string | null | undefined, fallback: string): string {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") return fallback;
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`地址必须带 http/https：${trimmed}`);
  }
  return trimmed.replace(/\/+$/, "");
}

function parseStored(raw: string | null): StoredGithubProvider | null {
  if (raw === null || raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.client_id !== "string" || record.client_id.trim() === "") return null;
    if (typeof record.client_secret_ciphertext !== "string") return null;
    return {
      client_id: record.client_id,
      client_secret_ciphertext: record.client_secret_ciphertext,
      scopes: typeof record.scopes === "string" ? record.scopes : "read:user user:email",
      display_name: typeof record.display_name === "string" ? record.display_name : "GitHub",
      allowed_logins: cleanList(record.allowed_logins as string[]),
      allowed_emails: cleanList(record.allowed_emails as string[]),
      allowed_orgs: cleanList(record.allowed_orgs as string[]),
      admin_logins: cleanList(record.admin_logins as string[]),
      admin_emails: cleanList(record.admin_emails as string[]),
      allow_any: record.allow_any === true,
      authorize_url: typeof record.authorize_url === "string" ? record.authorize_url : DEFAULT_AUTHORIZE_URL,
      token_url: typeof record.token_url === "string" ? record.token_url : DEFAULT_TOKEN_URL,
      api_base: typeof record.api_base === "string" ? record.api_base : DEFAULT_API_BASE,
    };
  } catch {
    return null;
  }
}

/** 读库内配置并解密成 `GithubConfig`；没配/解不开都返回 null（不抛，别让坏配置挡住启动）。 */
export function readGithubProvider(
  storage: AuthProviderStorage,
  secrets: AuthProviderSecrets,
): GithubConfig | null {
  const stored = parseStored(storage.getAppMeta(GITHUB_PROVIDER_META_KEY));
  if (stored === null) return null;
  let clientSecret: string;
  try {
    clientSecret = secrets.decrypt(stored.client_secret_ciphertext);
  } catch (error) {
    console.warn(`读取库内 GitHub 配置失败（secret 解不开）：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  if (clientSecret === "") return null;
  return {
    clientId: stored.client_id,
    clientSecret,
    scopes: stored.scopes,
    displayName: stored.display_name,
    allowedLogins: stored.allowed_logins,
    allowedEmails: stored.allowed_emails,
    allowedOrgs: stored.allowed_orgs,
    adminLogins: stored.admin_logins,
    adminEmails: stored.admin_emails,
    allowAny: stored.allow_any,
    authorizeUrl: stored.authorize_url,
    tokenUrl: stored.token_url,
    apiBase: stored.api_base,
  };
}

/** 管理台展示用；不含 secret。 */
export function readGithubProviderSummary(
  storage: AuthProviderStorage,
  envConfig: GithubConfig | null,
): GithubProviderSummary {
  const raw = storage.getAppMeta(GITHUB_PROVIDER_META_KEY);
  const stored = parseStored(raw);
  if (stored !== null) {
    return {
      configured: true,
      client_id: stored.client_id,
      display_name: stored.display_name,
      scopes: stored.scopes,
      allowed_logins: stored.allowed_logins,
      allowed_emails: stored.allowed_emails,
      allowed_orgs: stored.allowed_orgs,
      admin_logins: stored.admin_logins,
      admin_emails: stored.admin_emails,
      allow_any: stored.allow_any,
      authorize_url: stored.authorize_url,
      token_url: stored.token_url,
      api_base: stored.api_base,
      secret_set: stored.client_secret_ciphertext !== "",
    };
  }
  if (raw !== null) {
    // 墓碑：管理员在界面上点过「关闭」，就别再回落到环境变量。
    return {
      configured: false,
      client_id: "",
      display_name: "GitHub",
      scopes: "read:user user:email",
      allowed_logins: [],
      allowed_emails: [],
      allowed_orgs: [],
      admin_logins: [],
      admin_emails: [],
      allow_any: false,
      authorize_url: DEFAULT_AUTHORIZE_URL,
      token_url: DEFAULT_TOKEN_URL,
      api_base: DEFAULT_API_BASE,
      secret_set: false,
    };
  }
  if (envConfig !== null) {
    // 环境变量兜底：表单要能显示「当前生效的是什么」，但不回传 secret。
    return {
      configured: true,
      client_id: envConfig.clientId,
      display_name: envConfig.displayName,
      scopes: envConfig.scopes,
      allowed_logins: envConfig.allowedLogins,
      allowed_emails: envConfig.allowedEmails,
      allowed_orgs: envConfig.allowedOrgs,
      admin_logins: envConfig.adminLogins,
      admin_emails: envConfig.adminEmails,
      allow_any: envConfig.allowAny,
      authorize_url: envConfig.authorizeUrl,
      token_url: envConfig.tokenUrl,
      api_base: envConfig.apiBase,
      secret_set: envConfig.clientSecret !== "",
    };
  }
  return {
    configured: false,
    client_id: "",
    display_name: "GitHub",
    scopes: "read:user user:email",
    allowed_logins: [],
    allowed_emails: [],
    allowed_orgs: [],
    admin_logins: [],
    admin_emails: [],
    allow_any: false,
    authorize_url: DEFAULT_AUTHORIZE_URL,
    token_url: DEFAULT_TOKEN_URL,
    api_base: DEFAULT_API_BASE,
    secret_set: false,
  };
}

/**
 * 写库并返回可直接生效的 `GithubConfig`。
 *
 * `client_secret` 传空时沿用已存的密文（编辑表单不回显 secret，用户不改就不填）。
 */
export function saveGithubProvider(
  storage: AuthProviderStorage,
  secrets: AuthProviderSecrets,
  input: GithubProviderInput,
): GithubConfig {
  const clientId = (input.client_id ?? "").trim();
  if (clientId === "") throw new Error("client_id 不能为空");

  const previous = parseStored(storage.getAppMeta(GITHUB_PROVIDER_META_KEY));
  const incomingSecret = (input.client_secret ?? "").trim();
  let ciphertext: string;
  let clientSecret: string;
  if (incomingSecret !== "") {
    ciphertext = secrets.encrypt(incomingSecret);
    clientSecret = incomingSecret;
  } else if (previous !== null) {
    ciphertext = previous.client_secret_ciphertext;
    clientSecret = secrets.decrypt(ciphertext);
  } else {
    throw new Error("client_secret 不能为空");
  }

  const allowedLogins = cleanList(input.allowed_logins);
  const allowedEmails = cleanList(input.allowed_emails);
  const allowedOrgs = cleanList(input.allowed_orgs);
  const adminLogins = cleanList(input.admin_logins);
  const adminEmails = cleanList(input.admin_emails);
  const allowAny = input.allow_any === true;
  if (!allowAny && allowedLogins.length === 0 && allowedEmails.length === 0 && allowedOrgs.length === 0) {
    // 管理台能读全部服务凭据：不填准入就等于对全世界开放。
    throw new Error("必须至少配置一种准入（登录名 / 邮箱 / 组织），或显式允许任何人登录");
  }

  const scopes =
    (input.scopes ?? "").trim() === ""
      ? allowedOrgs.length > 0
        ? "read:user user:email read:org"
        : "read:user user:email"
      : (input.scopes ?? "").trim();

  const stored: StoredGithubProvider = {
    client_id: clientId,
    client_secret_ciphertext: ciphertext,
    scopes,
    display_name: (input.display_name ?? "").trim() === "" ? "GitHub" : (input.display_name ?? "").trim(),
    allowed_logins: allowedLogins,
    allowed_emails: allowedEmails,
    allowed_orgs: allowedOrgs,
    admin_logins: adminLogins,
    admin_emails: adminEmails,
    allow_any: allowAny,
    authorize_url: normalizeUrl(input.authorize_url, DEFAULT_AUTHORIZE_URL),
    token_url: normalizeUrl(input.token_url, DEFAULT_TOKEN_URL),
    api_base: normalizeUrl(input.api_base, DEFAULT_API_BASE),
  };
  storage.setAppMeta(GITHUB_PROVIDER_META_KEY, JSON.stringify(stored));
  return {
    clientId,
    clientSecret,
    scopes,
    displayName: stored.display_name,
    allowedLogins,
    allowedEmails,
    allowedOrgs,
    adminLogins,
    adminEmails,
    allowAny,
    authorizeUrl: stored.authorize_url,
    tokenUrl: stored.token_url,
    apiBase: stored.api_base,
  };
}

export function deleteGithubProvider(storage: AuthProviderStorage): void {
  // 写墓碑而不是清空 key：否则重启后 env 里的 FLOWLET_GITHUB_* 又把它拉起来，
  // 用户在界面上点过「关闭」就应该是真的关掉。
  storage.setAppMeta(GITHUB_PROVIDER_META_KEY, JSON.stringify({ deleted: true }));
}

/** 库里有没有这条记录（含墓碑）：用来判断该不该继续用环境变量当种子。 */
export function hasStoredGithubProvider(storage: AuthProviderStorage): boolean {
  return storage.getAppMeta(GITHUB_PROVIDER_META_KEY) !== null;
}

/**
 * 校验 client_id / client_secret 是不是一对有效的 GitHub OAuth App 凭据。
 *
 * GitHub 没有「验证应用凭据」的独立接口，但只要拿一个**无效的授权码**去换 token：
 * 凭据正确 → 返回 `bad_verification_code`；凭据错误 → 返回 `incorrect_client_credentials`。
 * 这样能在不要求用户登录的前提下把配对验掉，且不产生任何副作用。
 */
export async function checkGithubProvider(
  config: Pick<GithubConfig, "clientId" | "clientSecret" | "tokenUrl">,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubCheckResult> {
  const body = new URLSearchParams();
  body.append("client_id", config.clientId);
  body.append("client_secret", config.clientSecret);
  body.append("code", "flowlet-connectivity-check");
  body.append("grant_type", "authorization_code");
  let status: number;
  let text: string;
  try {
    const response = await fetchImpl(config.tokenUrl, {
      method: "POST",
      redirect: "manual",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "flowlet-admin-auth",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(20000),
    });
    status = response.status;
    text = await response.text();
  } catch (error) {
    return {
      ok: false,
      message: `连不上 ${config.tokenUrl}：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    parsed = null;
  }
  const errorCode = typeof parsed?.error === "string" ? parsed.error : "";
  if (errorCode === "incorrect_client_credentials") {
    return { ok: false, message: "GitHub 判定 client_id 与 client_secret 不匹配" };
  }
  if (errorCode === "bad_verification_code" || errorCode === "") {
    // 走到这里说明 GitHub 认了这对凭据（只是 code 无效），正是我们要的结论。
    if (status >= 200 && status < 400) {
      return { ok: true, message: "凭据有效：GitHub 认可这对 client_id / client_secret" };
    }
    return { ok: false, message: `换 token 端点返回 HTTP ${status}` };
  }
  return { ok: false, message: `GitHub 返回 ${errorCode}` };
}
