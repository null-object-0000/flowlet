/** OIDC 准入与展示覆盖、登录方式开关。部署凭据和协议参数始终来自环境变量。 */
import type { OidcConfig } from "./auth.ts";

/** OIDC 提供方配置在 app_meta 里的键；带 v1 方便以后换结构。 */
export const OIDC_PROVIDER_META_KEY = "auth_provider_oidc_v1";
/** 启用哪些登录方式。缺这条时按部署环境推断（见 `readLoginMode`）。 */
export const LOGIN_MODE_META_KEY = "auth_login_mode_v1";

/** 登录方式开关：`oidc` 与 `github` 至少开一个，另一个独立。两个都关 = 只剩静态管理凭据。 */
export interface LoginMode {
  oidc: boolean;
  github: boolean;
}

/** 管理台表单形状；部署字段仅用于兼容旧请求，必须与部署一致。 */
export interface OidcProviderInput {
  issuer?: string | null;
  discovery_url?: string | null;
  client_id?: string | null;
  client_secret?: string | null;
  scopes?: string | null;
  redirect_urls?: string[] | null;
  display_name?: string | null;
  email_claim?: string | null;
  name_claim?: string | null;
  groups_claim?: string | null;
  allowed_subs?: string[] | null;
  allowed_groups?: string[] | null;
  allowed_emails?: string[] | null;
  allowed_domains?: string[] | null;
  admin_subs?: string[] | null;
  admin_emails?: string[] | null;
  allow_any?: boolean | null;
  allow_http_issuer?: boolean | null;
  insecure_http?: boolean | null;
  pkce?: string | null;
  nonce?: string | null;
}

/** 回给管理台的视图：**永不包含 secret 明文或密文**。 */
export interface OidcProviderSummary {
  configured: boolean;
  /** 当前生效的配置来自哪里：库内 vs 环境变量种子。 */
  source: "stored" | "env" | "none";
  issuer: string;
  discovery_url: string;
  client_id: string;
  display_name: string;
  scopes: string;
  redirect_urls: string[];
  email_claim: string;
  name_claim: string;
  groups_claim: string;
  allowed_subs: string[];
  allowed_groups: string[];
  allowed_emails: string[];
  allowed_domains: string[];
  admin_subs: string[];
  admin_emails: string[];
  allow_any: boolean;
  allow_http_issuer: boolean;
  insecure_http: boolean;
  pkce: string;
  nonce: string;
  secret_set: boolean;
}

export interface OidcCheckResult {
  ok: boolean;
  message: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
}

/** 库里存在 OIDC 配置时的 runtime 覆盖：只替换准入与展示，不动部署级字段（issuer / token 端点）。 */
export interface OidcRuntimeOverride {
  scopes: string;
  displayName: string;
  allowedSubs: string[];
  allowedGroups: string[];
  allowedEmails: string[];
  allowedDomains: string[];
  adminSubs: string[];
  adminEmails: string[];
  allowAny: boolean;
}

export interface AuthProviderStorage {
  getAppMeta(key: string): string | null;
  setAppMeta(key: string, value: string): void;
}

const DEFAULT_CLAIMS = { email: "email", name: "name", groups: "groups" } as const;

function cleanList(value: string[] | null | undefined, caseInsensitive = false): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const trimmed = String(item ?? "").trim();
    if (trimmed === "") continue;
    const key = caseInsensitive ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function text(value: string | null | undefined, fallback = ""): string {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? fallback : trimmed;
}

/** 仅持久化准入与展示；部署凭据始终留在部署密钥中。 */
function parseStored(raw: string | null): OidcRuntimeOverride | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v) || v.deleted === true) return null;
    const list = (name: string): string[] => {
      if (!Array.isArray(v[name]) || v[name].some((x: unknown) => typeof x !== "string")) throw new Error("invalid list");
      return cleanList(v[name]);
    };
    const result = {
      scopes: text(v.scopes, "openid"), displayName: text(v.display_name, "OIDC"),
      allowedSubs: list("allowed_subs"), allowedGroups: list("allowed_groups"),
      allowedEmails: list("allowed_emails"), allowedDomains: list("allowed_domains"),
      adminSubs: list("admin_subs"), adminEmails: list("admin_emails"), allowAny: v.allow_any === true,
    };
    if (!result.scopes.split(/\s+/).includes("openid")) return null;
    if (!result.allowAny && ![result.allowedSubs, result.allowedGroups, result.allowedEmails, result.allowedDomains].some(x => x.length)) return null;
    return result;
  } catch { return null; }
}

export function hasStoredOidcProvider(storage: AuthProviderStorage): boolean {
  return storage.getAppMeta(OIDC_PROVIDER_META_KEY) !== null;
}

export function readOidcProviderOverride(
  storage: AuthProviderStorage,
): OidcRuntimeOverride | null {
  const raw = storage.getAppMeta(OIDC_PROVIDER_META_KEY);
  const result = parseStored(raw);
  if (raw !== null && result === null) {
    let deleted = false;
    try { deleted = JSON.parse(raw).deleted === true; } catch { /* invalid persisted policy */ }
    if (!deleted) throw new Error("库内 OIDC 准入配置损坏，请恢复配置后重启");
  }
  return result;
}

/** 环境变量种子（`FLOWLET_OIDC_*` 解析后的 `OidcConfig`）→ 管理台视图。 */
function summaryFromEnv(env: OidcConfig): OidcProviderSummary {
  return {
    configured: true,
    source: "env",
    issuer: env.issuer,
    discovery_url: env.discoveryUrl,
    client_id: env.clientId,
    display_name: env.displayName,
    scopes: env.scopes,
    redirect_urls: env.redirectUrls,
    email_claim: env.emailClaim,
    name_claim: env.nameClaim,
    groups_claim: env.groupsClaim,
    allowed_subs: env.allowedSubs,
    allowed_groups: env.allowedGroups,
    allowed_emails: env.allowedEmails,
    allowed_domains: env.allowedDomains,
    admin_subs: env.adminSubs,
    admin_emails: env.adminEmails,
    allow_any: env.allowAny,
    allow_http_issuer: env.allowHttpIssuer,
    insecure_http: env.insecureHttp,
    pkce: env.pkce,
    nonce: env.nonce,
    secret_set: env.clientSecret !== "",
  };
}

/** 只展示当前部署和已生效的准入，不展示或复制 client secret。 */
export function readOidcProviderSummary(
  storage: AuthProviderStorage,
  envConfig: OidcConfig | null,
): OidcProviderSummary {
  const override = readOidcProviderOverride(storage);
  if (envConfig !== null) {
    const effective = override ? { ...envConfig, ...override } : envConfig;
    return { ...summaryFromEnv(effective), source: override ? "stored" : "env" };
  }
  return {
    configured: false, source: "none", issuer: "", discovery_url: "", client_id: "",
    display_name: "OIDC", scopes: "openid", redirect_urls: [],
    email_claim: DEFAULT_CLAIMS.email, name_claim: DEFAULT_CLAIMS.name, groups_claim: DEFAULT_CLAIMS.groups,
    allowed_subs: [], allowed_groups: [], allowed_emails: [], allowed_domains: [],
    admin_subs: [], admin_emails: [], allow_any: false, allow_http_issuer: false,
    insecure_http: false, pkce: "auto", nonce: "required", secret_set: false,
  };
}

/** 部署字段只读；拒绝看似保存成功、实际并未生效的修改。 */
export function saveOidcProvider(
  storage: AuthProviderStorage,
  input: OidcProviderInput,
  envConfig: OidcConfig | null = null,
): OidcRuntimeOverride {
  if (!envConfig) throw new Error("请先在部署环境配置 OIDC issuer 与 client 凭据");
  const fields = {
    issuer: envConfig.issuer, discovery_url: envConfig.discoveryUrl, client_id: envConfig.clientId,
    client_secret: envConfig.clientSecret, email_claim: envConfig.emailClaim,
    name_claim: envConfig.nameClaim, groups_claim: envConfig.groupsClaim,
    allow_http_issuer: envConfig.allowHttpIssuer, insecure_http: envConfig.insecureHttp,
    pkce: envConfig.pkce, nonce: envConfig.nonce, redirect_urls: envConfig.redirectUrls,
  };
  for (const [key, expected] of Object.entries(fields)) {
    const actual = input[key as keyof OidcProviderInput];
    if (actual != null && actual !== "" && JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${key} 是部署级只读配置，请在部署环境修改`);
    }
  }
  const scopes = text(input.scopes, envConfig.scopes);
  if (!scopes.split(/\s+/).includes("openid")) throw new Error("scopes 必须包含 openid");
  const result: OidcRuntimeOverride = {
    scopes, displayName: text(input.display_name, envConfig.displayName),
    allowedSubs: cleanList(input.allowed_subs), allowedGroups: cleanList(input.allowed_groups),
    allowedEmails: cleanList(input.allowed_emails, true), allowedDomains: cleanList(input.allowed_domains, true),
    adminSubs: cleanList(input.admin_subs), adminEmails: cleanList(input.admin_emails, true),
    allowAny: input.allow_any === true,
  };
  if (!result.allowAny && ![result.allowedSubs, result.allowedGroups, result.allowedEmails, result.allowedDomains].some(x => x.length)) {
    throw new Error("必须至少配置一种准入（用户 ID / 组 / 邮箱 / 邮箱域），或显式允许任何人登录");
  }
  storage.setAppMeta(OIDC_PROVIDER_META_KEY, JSON.stringify({
    scopes: result.scopes, display_name: result.displayName,
    allowed_subs: result.allowedSubs, allowed_groups: result.allowedGroups,
    allowed_emails: result.allowedEmails, allowed_domains: result.allowedDomains,
    admin_subs: result.adminSubs, admin_emails: result.adminEmails, allow_any: result.allowAny,
  }));
  return result;
}

/** 移除界面覆盖：写墓碑，回落到部署默认值。 */
export function deleteOidcProvider(storage: AuthProviderStorage): void {
  storage.setAppMeta(OIDC_PROVIDER_META_KEY, JSON.stringify({ deleted: true }));
}

/** 读登录方式开关；从未保存过时按部署环境推断（配了谁就开谁）。 */
export function readLoginMode(
  storage: AuthProviderStorage,
  hints: { oidc: boolean; github: boolean },
): { mode: LoginMode; source: "stored" | "env" | "none" } {
  const raw = storage.getAppMeta(LOGIN_MODE_META_KEY);
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (typeof record.oidc === "boolean" && typeof record.github === "boolean") {
          return { mode: { oidc: record.oidc, github: record.github }, source: "stored" };
        }
      }
    } catch {
      /* 不回落到可能重新开放入口的环境默认值。 */
    }
    throw new Error("库内登录方式配置损坏，请恢复配置后重启");
  }
  return {
    mode: { oidc: hints.oidc, github: hints.github },
    source: hints.oidc || hints.github ? "env" : "none",
  };
}

export function saveLoginMode(storage: AuthProviderStorage, mode: LoginMode): LoginMode {
  const next: LoginMode = { oidc: mode.oidc === true, github: mode.github === true };
  storage.setAppMeta(LOGIN_MODE_META_KEY, JSON.stringify(next));
  return next;
}

/**
 * 检查部署 OIDC 的 discovery 与 token 端点（管理员命令）。
 *
 * - discovery 能取到，且 `issuer` 与配置一致；
 * - 拿到 authorization / token / jwks 端点；
 * - 端点是 https（或显式允许 http）；
 * - invalid_client 明确提示凭据错误；invalid_grant 仅证明测试授权码被拒，仍需真实登录验收。
 */
export async function checkOidcProvider(
  input: {
    issuer: string;
    discoveryUrl: string;
    clientId: string;
    clientSecret: string;
    insecureHttp: boolean;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<OidcCheckResult> {
  const issuer = input.issuer.trim();
  const discoveryUrl =
    input.discoveryUrl.trim() !== ""
      ? input.discoveryUrl.trim()
      : `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const allowHttp = input.insecureHttp;
  try {
    const url = new URL(discoveryUrl);
    if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:"))) {
      return { ok: false, message: "discovery 必须是无凭据的 HTTPS 地址（HTTP 需要部署显式允许）" };
    }
  } catch { return { ok: false, message: "discovery 地址无效" }; }
  let doc: Record<string, unknown>;
  try {
    const response = await fetchImpl(discoveryUrl, {
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      return { ok: false, message: `discovery 端点返回 HTTP ${response.status}（${discoveryUrl}）` };
    }
    const parsed: unknown = await response.json();
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, message: "discovery 响应不是合法 JSON 对象" };
    }
    doc = parsed as Record<string, unknown>;
  } catch (error) {
    return {
      ok: false,
      message: `连不上 ${discoveryUrl}：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const docIssuer = typeof doc.issuer === "string" ? doc.issuer : "";
  if (docIssuer !== issuer) {
    return {
      ok: false,
      message: `issuer 不一致：配置 ${issuer}，discovery 声明 ${docIssuer}`,
    };
  }
  const authorizationEndpoint = typeof doc.authorization_endpoint === "string" ? doc.authorization_endpoint : "";
  const tokenEndpoint = typeof doc.token_endpoint === "string" ? doc.token_endpoint : "";
  const jwksUri = typeof doc.jwks_uri === "string" ? doc.jwks_uri : "";
  for (const [name, value] of [
    ["authorization_endpoint", authorizationEndpoint],
    ["token_endpoint", tokenEndpoint],
    ["jwks_uri", jwksUri],
  ] as const) {
    if (value === "") return { ok: false, message: `discovery 缺少 ${name}` };
    let valid = false;
    try {
      const url = new URL(value);
      valid = !url.username && !url.password && !url.hash &&
        (url.protocol === "https:" || (allowHttp && url.protocol === "http:"));
    } catch { /* invalid endpoint */ }
    if (!valid) {
      return { ok: false, message: `${name} 不是 https：${value}` };
    }
  }
  const methods = Array.isArray(doc.code_challenge_methods_supported)
    ? (doc.code_challenge_methods_supported as unknown[]).map((item) => String(item))
    : [];
  const base = { ok: true, authorization_endpoint: authorizationEndpoint, token_endpoint: tokenEndpoint };
  if (input.clientId.trim() === "" || input.clientSecret === "") {
    return { ...base, message: "discovery 可用；未填 client 凭据，跳过凭据校验" };
  }
  // 与 GitHub 校验同一思路：拿一个无效 code 打 token 端点，看 IdP 是「认」
  // 还是「不认」这对 client 凭据。
  try {
    const response = await fetchImpl(tokenEndpoint, {
      method: "POST",
      redirect: "manual",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${input.clientId.trim()}:${input.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "flowlet-connectivity-check",
        redirect_uri: "urn:flowlet:oauth-check",
      }).toString(),
      signal: AbortSignal.timeout(20000),
    });
    const body = await response.text();
    let errorCode = "";
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        errorCode = typeof record.error === "string" ? record.error : "";
      }
    } catch {
      /* 非 JSON 响应：只看状态码 */
    }
    if (errorCode === "invalid_client" || response.status === 401) {
      return { ...base, ok: false, message: "IdP 判定 client_id 与 client_secret 不匹配（invalid_client）" };
    }
    if (response.status !== 400 || errorCode !== "invalid_grant") {
      return { ...base, ok: false, message: `token 端点返回 HTTP ${response.status}，无法确认 client 凭据是否有效` };
    }
    const pkceNote = methods.includes("S256") ? "支持 PKCE S256" : "未声明 PKCE S256（PKCE=required 会拒绝登录）";
    return {
      ...base,
      message: `discovery 可用，token 端点拒绝了测试授权码；请通过实际登录确认 client 凭据；${pkceNote}`,
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      message: `discovery 可用，但连不上 token 端点 ${tokenEndpoint}：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
