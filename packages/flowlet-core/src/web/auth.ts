// Web Host 管理端鉴权（token / OIDC 两种模式）。Owner: node-web.
//
// 权威实现：src-tauri/src/core/web/auth.rs（1430 行）逐行为等价：
// - token 模式：Bearer + HMAC-SHA256 常量时间比较（保持旧行为）；
// - oidc 模式：GitLab 等标准 OIDC 授权码登录 + 进程内 HttpOnly Cookie 会话 + CSRF，
//   可选 ALLOW_TOKEN_LOGIN 兜底 Bearer。
//
// 只使用 node:crypto / 全局 fetch，不引入第三方依赖。会话默认在内存中；Node Host
// （Docker / headless）会注入文件型 AdminSessionStore，把会话落到 `/data`，
// 这样容器重启/升级不再把管理台登录态全部踢掉（见 web/session-store.ts）。
// Rust 桌面/headless 仍为纯内存实现，行为差异只在「重启后是否重新登录」。
import { createHash, createPublicKey, createHmac, randomUUID, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import { readFileSync } from "node:fs";

import type { JsonRow } from "../types.ts";
import type { AdminSessionStore, PersistedAdminSession } from "./session-store.ts";

const ADMIN_COOKIE = "flowlet-admin";
const ADMIN_COOKIE_SECURE = "__Host-flowlet-admin";
const BROWSER_COOKIE = "flowlet-oidc-browser";
const BROWSER_COOKIE_SECURE = "__Host-flowlet-oidc-browser";
const CSRF_HEADER = "x-csrf-token";
const BROWSER_COOKIE_TTL_MS = 24 * 60 * 60 * 1000;
const DISCOVERY_TTL_MS = 3600 * 1000;
const JWKS_TTL_MS = 3600 * 1000;
const TRANSACTION_TTL_MS = 600 * 1000;
const OIDC_HTTP_TIMEOUT_MS = 30 * 1000;

export type AuthMode = "token" | "oidc";
type PkceMode = "auto" | "required" | "off";
type NonceMode = "required" | "best_effort" | "off";

export interface OidcConfig {
  issuer: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  redirectUrl: string;
  /** 允许的完整回调地址白名单：登录时按请求来源挑一个，回调换 token 时复用同一个。 */
  redirectUrls: string[];
  displayName: string;
  emailClaim: string;
  nameClaim: string;
  groupsClaim: string;
  allowedSubs: string[];
  allowedGroups: string[];
  allowedEmails: string[];
  allowedDomains: string[];
  /** 管理员名单：命中者 admin，其余准入者 viewer；两边都空时按 sub/邮箱准入者算 admin。 */
  adminSubs: string[];
  adminEmails: string[];
  allowAny: boolean;
  allowHttpIssuer: boolean;
  insecureHttp: boolean;
  pkce: PkceMode;
  nonce: NonceMode;
  signingAlgs: string[];
}

export interface AdminAuthConfig {
  mode: AuthMode;
  adminToken: string;
  allowTokenLogin: boolean;
  /** 规范化后的第一个对外地址（默认回调、日志用）。 */
  publicWebUrl: string;
  /** 允许的对外来源白名单（协议 + 主机 + 端口），支持同时挂 IP 与公网域名。 */
  publicWebUrls: string[];
  /** `always` / `never` 强制；`scheme` = 跟随每个请求的实际协议（多入口用这个）。 */
  cookieSecureMode: "always" | "never" | "scheme";
  /** `scheme` 模式下请求头缺失时的兜底值。 */
  cookieSecure: boolean;
  sessionIdleMs: number;
  sessionTtlMs: number;
  oidc: OidcConfig | null;
  /** 第二提供方：GitHub OAuth（可选）。 */
  github: GithubConfig | null;
}

/** 登录提供方：目前支持自建 OIDC（公司 GitLab）与 GitHub OAuth。 */
export type AuthProviderId = "oidc" | "github";

/** GitHub OAuth App 配置。
 *
 * GitHub 不是 OIDC：token 响应里没有 id_token，只能拿 access_token 再调 `/user` 取身份，
 * 所以这里的 authorize/token/userinfo 三个地址都做成可覆盖的（测试打本地 mock 用）。
 */
export interface GithubConfig {
  clientId: string;
  clientSecret: string;
  /** 空格分隔；默认 `read:user user:email`。 */
  scopes: string;
  displayName: string;
  /** 准入：GitHub 登录名（大小写不敏感）。 */
  allowedLogins: string[];
  /** 准入：邮箱（大小写不敏感）。 */
  allowedEmails: string[];
  /** 准入：GitHub 组织（需要 `read:org` scope 才会去查）。 */
  allowedOrgs: string[];
  /** 管理员名单：命中者 admin，其余准入者 viewer；两边都空时准入者全员 admin（兼容旧配置）。 */
  adminLogins: string[];
  adminEmails: string[];
  allowAny: boolean;
  authorizeUrl: string;
  tokenUrl: string;
  apiBase: string;
}

export interface Identity {
  sub: string;
  email: string | null;
  username: string | null;
  name: string | null;
  groups: string[];
  provider: string;
  /** 登录后的角色：`admin` 全权，`viewer` 只读。缺省（旧会话）按 admin 处理。 */
  role?: IdentityRole;
}

/**
 * 角色只有两档：管理员与只读。
 *
 * 为什么要它：准入名单解决的是「谁能进来」，但管理台能读全部服务凭据，
 * 把同事加进名单就等于把凭据给他。有了角色就能「放人进来看看，但不给改」。
 */
export type IdentityRole = "admin" | "viewer";

/**
 * 只读角色能跑哪些命令：读类动词开头、且名字里不含敏感字样。
 *
 * 白名单式放宽 + 关键字兜底，比枚举几百条命令更可控；漏放最多是功能受限，
 * 不会误放（新加的命令默认属于管理员）。
 */
export function viewerCanRunCommand(command: string): boolean {
  if (!/^(get|list|read|query|describe|check)_/.test(command)) return false;
  return !/(credential|secret|token|auth|cli|export|key|reveal|config|setting)/i.test(
    command.replace(/^[a-z]+_/, ""),
  );
}

export interface AuthContext {
  viaCookie: boolean;
  csrfToken: string | null;
  identity: Identity | null;
  sessionKey: string | null;
}

/** 与 axum handler 对齐的响应形状；由 web/index.ts 负责写回。 */
export interface AuthResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
}

export interface AuthRequestInfo {
  /** Node IncomingHttpHeaders。 */
  headers: Record<string, string | string[] | undefined>;
  /** path + query（例如 /api/auth/callback?code=...）。 */
  url: string;
}

interface Session {
  identity: Identity;
  csrfToken: string;
  createdMs: number;
  lastSeenMs: number;
  absoluteExpireMs: number;
  /** 最近一次写回持久化存储的时间（0 = 尚未写回）；用于限流 lastSeen 落盘。 */
  persistedAtMs: number;
}

/** lastSeen 落盘间隔：空闲超时是分钟级，60s 的精度足够，且避免每个请求都写文件。 */
const SESSION_PERSIST_INTERVAL_MS = 60 * 1000;

interface Transaction {
  nonce: string;
  verifier: string | null;
  browserHash: string;
  createdMs: number;
  /** 本次授权实际用的回调地址：换 token 时必须逐字复用。 */
  redirectUri: string;
  /** 本次授权所在 origin 的 Secure 取值，回写 cookie 时沿用。 */
  cookieSecure: boolean;
  /** 这次授权走的是哪个提供方；回调据此决定怎么换身份。 */
  provider: AuthProviderId;
}

interface DiscoveryDoc {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string | null;
  jwks_uri: string;
  code_challenge_methods_supported: string[] | null;
}

interface Jwk {
  kty: string;
  kid: string | null;
  n: string | null;
  e: string | null;
  alg: string | null;
}

interface Cached<T> {
  value: T;
  fetchedMs: number;
}

// ─── 环境变量解析（与 Rust auth.rs 的 env_trim/env_bool/env_csv 逐字一致） ────

function envTrim(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function envBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = envTrim(env, name)?.toLowerCase();
  switch (value) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return fallback;
  }
}

function envCsv(env: NodeJS.ProcessEnv, name: string): string[] {
  const value = envTrim(env, name);
  if (value === null) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function readSecret(env: NodeJS.ProcessEnv, name: string, fileEnvName: string): string | null {
  const value = envTrim(env, name);
  if (value !== null) return value;
  const path = envTrim(env, fileEnvName);
  if (path === null) return null;
  try {
    const content = readFileSync(path, "utf8").trim();
    return content === "" ? null : content;
  } catch {
    return null;
  }
}

function parseUnsignedEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = envTrim(env, name);
  if (value === null || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function validateHttpsEndpoint(value: string, allowHttp: boolean): void {
  if (value.startsWith("https://") || (allowHttp && value.startsWith("http://"))) return;
  throw new Error(`只接受 https 地址：${value}`);
}

function parsePublicWebUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("FLOWLET_PUBLIC_WEB_URL 不是合法 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("FLOWLET_PUBLIC_WEB_URL 只支持 http/https");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("FLOWLET_PUBLIC_WEB_URL 不支持子路径");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("FLOWLET_PUBLIC_WEB_URL 不允许查询串或片段");
  }
  return trimmed;
}

/** Rust `AdminAuthConfig::from_env`。 */
export function adminAuthConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fallbackAdminToken?: string,
): AdminAuthConfig {
  const modeRaw = envTrim(env, "FLOWLET_ADMIN_AUTH_MODE");
  let mode: AuthMode;
  if (modeRaw === null || modeRaw === "token") {
    mode = "token";
  } else if (modeRaw === "oidc") {
    mode = "oidc";
  } else {
    throw new Error(`未知的 FLOWLET_ADMIN_AUTH_MODE：${modeRaw}`);
  }

  const envToken = envTrim(env, "FLOWLET_ADMIN_TOKEN");
  const fallback = fallbackAdminToken?.trim() ?? "";
  const adminToken = envToken ?? (fallback === "" ? "" : fallback);
  const allowTokenLogin = envBool(env, "FLOWLET_ADMIN_ALLOW_TOKEN_LOGIN", false);

  // 多入口：FLOWLET_PUBLIC_WEB_URLS（逗号分隔，第一条为默认）优先，
  // 兼容旧的单值 FLOWLET_PUBLIC_WEB_URL。内网 IP 与公网域名可同时放进来。
  const publicWebUrlsRaw = envTrim(env, "FLOWLET_PUBLIC_WEB_URLS");
  const publicWebUrlRaw = envTrim(env, "FLOWLET_PUBLIC_WEB_URL");
  const publicWebUrlListRaw = publicWebUrlsRaw ?? publicWebUrlRaw;
  const publicWebUrls: string[] = [];
  if (publicWebUrlListRaw !== null) {
    const seen = new Set<string>();
    for (const item of publicWebUrlListRaw.split(",")) {
      const trimmed = item.trim();
      if (trimmed === "") continue;
      const parsed = parsePublicWebUrl(trimmed);
      if (seen.has(parsed)) continue;
      seen.add(parsed);
      publicWebUrls.push(parsed);
    }
  }
  const publicWebUrl = publicWebUrls[0] ?? "";
  if (publicWebUrl === "") {
    if (mode === "oidc") {
      throw new Error("OIDC 模式必须设置 FLOWLET_PUBLIC_WEB_URL 或 FLOWLET_PUBLIC_WEB_URLS");
    }
  }

  const sessionIdleMinutes = Math.max(1, parseUnsignedEnv(env, "FLOWLET_ADMIN_SESSION_IDLE_MINUTES", 30));
  const sessionTtlHours = Math.max(1, parseUnsignedEnv(env, "FLOWLET_ADMIN_SESSION_TTL_HOURS", 8));
  const sessionIdleMs = sessionIdleMinutes * 60 * 1000;
  const sessionTtlMs = sessionTtlHours * 3600 * 1000;
  if (sessionIdleMs > sessionTtlMs) throw new Error("空闲超时不能大于绝对超时");

  const cookieSecureRaw = envTrim(env, "FLOWLET_ADMIN_COOKIE_SECURE");
  // 多入口下不能再按「唯一对外地址的协议」定死：http 入口拿到的 Secure cookie 会被
  // 浏览器直接丢弃，表现为登录后立刻又跳回登录页。默认改成跟随每个请求。
  const cookieSecureMode: "always" | "never" | "scheme" =
    cookieSecureRaw === "always" ? "always" : cookieSecureRaw === "never" ? "never" : "scheme";
  const cookieSecure =
    cookieSecureMode === "always"
      ? true
      : cookieSecureMode === "never"
        ? false
        : publicWebUrl.startsWith("https://");

  // 第二提供方：不配 FLOWLET_GITHUB_CLIENT_ID 就是没启用。
  const github = githubConfigFromEnv(env);

  if (mode === "token") {
    if (adminToken.length < 24) {
      throw new Error("FLOWLET_ADMIN_TOKEN 必须至少包含 24 个字符");
    }
    return {
      mode,
      adminToken,
      allowTokenLogin,
      publicWebUrl,
      publicWebUrls,
      cookieSecureMode,
      cookieSecure,
      sessionIdleMs,
      sessionTtlMs,
      oidc: null,
      github: null,
    };
  }

  if (allowTokenLogin && adminToken.length < 24) {
    throw new Error("开启 ALLOW_TOKEN_LOGIN 时 FLOWLET_ADMIN_TOKEN 必须至少包含 24 个字符");
  }
  const issuer = envTrim(env, "FLOWLET_OIDC_ISSUER");
  if (issuer === null) {
    // 没配 OIDC：只要配了 GitHub 就还能用（公网入口常见的组合）。
    if (github === null) {
      throw new Error(
        "OIDC 模式必须设置 FLOWLET_OIDC_ISSUER，或改用 FLOWLET_GITHUB_CLIENT_ID(_SECRET) 启用 GitHub 登录",
      );
    }
    return {
      mode,
      adminToken,
      allowTokenLogin,
      publicWebUrl,
      publicWebUrls,
      cookieSecureMode,
      cookieSecure,
      sessionIdleMs,
      sessionTtlMs,
      oidc: null,
      github,
    };
  }
  const allowHttpIssuer = envBool(env, "FLOWLET_OIDC_ALLOW_HTTP_ISSUER", false);
  const insecureHttp = envBool(env, "FLOWLET_OIDC_INSECURE_HTTP", false);
  const issuerIsHttps = issuer.startsWith("https://");
  if (!issuerIsHttps && !allowHttpIssuer && !insecureHttp) {
    throw new Error("issuer 非 https；旧自建 GitLab 请显式设置 FLOWLET_OIDC_ALLOW_HTTP_ISSUER=1");
  }
  let discoveryUrl = envTrim(env, "FLOWLET_OIDC_DISCOVERY_URL");
  if (discoveryUrl === null) {
    if (!issuerIsHttps) {
      throw new Error("issuer 为 http 时必须显式设置 https 的 FLOWLET_OIDC_DISCOVERY_URL");
    }
    discoveryUrl = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  }
  validateHttpsEndpoint(discoveryUrl, insecureHttp);

  const clientId = envTrim(env, "FLOWLET_OIDC_CLIENT_ID");
  if (clientId === null) throw new Error("OIDC 模式必须设置 FLOWLET_OIDC_CLIENT_ID");
  const clientSecret = readSecret(env, "FLOWLET_OIDC_CLIENT_SECRET", "FLOWLET_OIDC_CLIENT_SECRET_FILE");
  if (clientSecret === null) {
    throw new Error("OIDC 模式必须设置 FLOWLET_OIDC_CLIENT_SECRET(_FILE)");
  }
  const scopes = envTrim(env, "FLOWLET_OIDC_SCOPES") ?? "openid";
  const allowedSubs = envCsv(env, "FLOWLET_OIDC_ALLOWED_SUBS");
  const allowedGroups = envCsv(env, "FLOWLET_OIDC_ALLOWED_GROUPS");
  const allowedEmails = envCsv(env, "FLOWLET_OIDC_ALLOWED_EMAILS");
  const allowedDomains = envCsv(env, "FLOWLET_OIDC_ALLOWED_DOMAINS");
  const adminSubs = envCsv(env, "FLOWLET_OIDC_ADMIN_SUBS");
  const adminEmails = envCsv(env, "FLOWLET_OIDC_ADMIN_EMAILS");
  const allowAny = envBool(env, "FLOWLET_OIDC_ALLOW_ANY", false);
  if (
    !allowAny &&
    allowedSubs.length === 0 &&
    allowedGroups.length === 0 &&
    allowedEmails.length === 0 &&
    allowedDomains.length === 0
  ) {
    throw new Error("OIDC 模式必须配置准入名单，或显式设置 ALLOW_ANY=1");
  }

  const pkceRaw = envTrim(env, "FLOWLET_OIDC_PKCE");
  let pkce: PkceMode;
  if (pkceRaw === null || pkceRaw === "auto") {
    pkce = "auto";
  } else if (pkceRaw === "required") {
    pkce = "required";
  } else if (pkceRaw === "off") {
    pkce = "off";
  } else {
    throw new Error(`未知的 FLOWLET_OIDC_PKCE：${pkceRaw}`);
  }

  const nonceRaw = envTrim(env, "FLOWLET_OIDC_NONCE");
  let nonce: NonceMode;
  if (nonceRaw === null || nonceRaw === "required") {
    nonce = "required";
  } else if (nonceRaw === "best_effort") {
    nonce = "best_effort";
  } else if (nonceRaw === "off") {
    nonce = "off";
  } else {
    throw new Error(`未知的 FLOWLET_OIDC_NONCE：${nonceRaw}`);
  }

  const explicitRedirect = envTrim(env, "FLOWLET_OIDC_REDIRECT_URL");
  const explicitRedirectList = envTrim(env, "FLOWLET_OIDC_REDIRECT_URLS");
  // 回调白名单：每个对外地址各一个 /api/auth/callback，外加显式配置的（兼容
  // 反代改写路径的场景）。登录时按请求来源从中挑，回调换 token 必须用同一个。
  const redirectUrls: string[] = [];
  const pushRedirect = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed !== "" && !redirectUrls.includes(trimmed)) redirectUrls.push(trimmed);
  };
  if (explicitRedirectList !== null) {
    for (const item of explicitRedirectList.split(",")) pushRedirect(item);
  }
  if (explicitRedirect !== null) pushRedirect(explicitRedirect);
  for (const origin of publicWebUrls) pushRedirect(`${origin}/api/auth/callback`);
  const redirectUrl =
    explicitRedirect ?? (publicWebUrls[0] ? `${publicWebUrls[0]}/api/auth/callback` : "");
  const signingAlgRaw = envTrim(env, "FLOWLET_OIDC_SIGNING_ALGS");
  const signingAlgs =
    signingAlgRaw === null
      ? ["RS256"]
      : signingAlgRaw
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item !== "");
  if (signingAlgs.some((alg) => alg !== "RS256")) {
    throw new Error("当前实现只支持 RS256 ID token");
  }

  return {
    mode,
    adminToken,
    allowTokenLogin,
    publicWebUrl,
    publicWebUrls,
    cookieSecureMode,
    cookieSecure,
    sessionIdleMs,
    sessionTtlMs,
    oidc: {
      issuer,
      discoveryUrl,
      clientId,
      clientSecret,
      scopes,
      redirectUrl,
      redirectUrls,
      displayName: envTrim(env, "FLOWLET_OIDC_DISPLAY_NAME") ?? "GitLab",
      emailClaim: envTrim(env, "FLOWLET_OIDC_EMAIL_CLAIM") ?? "email",
      nameClaim: envTrim(env, "FLOWLET_OIDC_NAME_CLAIM") ?? "name",
      groupsClaim: envTrim(env, "FLOWLET_OIDC_GROUPS_CLAIM") ?? "groups",
      allowedSubs,
      allowedGroups,
      allowedEmails,
      allowedDomains,
      adminSubs,
      adminEmails,
      allowAny,
      allowHttpIssuer,
      insecureHttp,
      pkce,
      nonce,
      signingAlgs,
    },
    github,
  };
}

/** GitHub OAuth 配置：不配 `FLOWLET_GITHUB_CLIENT_ID` 就是没启用。 */
export function githubConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GithubConfig | null {
  const clientId = envTrim(env, "FLOWLET_GITHUB_CLIENT_ID");
  if (clientId === null) return null;
  const clientSecret = readSecret(
    env,
    "FLOWLET_GITHUB_CLIENT_SECRET",
    "FLOWLET_GITHUB_CLIENT_SECRET_FILE",
  );
  if (clientSecret === null) {
    throw new Error("启用 GitHub 登录必须同时设置 FLOWLET_GITHUB_CLIENT_SECRET(_FILE)");
  }
  const allowedLogins = envCsv(env, "FLOWLET_GITHUB_ALLOWED_LOGINS");
  const allowedEmails = envCsv(env, "FLOWLET_GITHUB_ALLOWED_EMAILS");
  const allowedOrgs = envCsv(env, "FLOWLET_GITHUB_ALLOWED_ORGS");
  const adminLogins = envCsv(env, "FLOWLET_GITHUB_ADMIN_LOGINS");
  const adminEmails = envCsv(env, "FLOWLET_GITHUB_ADMIN_EMAILS");
  const allowAny = envBool(env, "FLOWLET_GITHUB_ALLOW_ANY", false);
  if (
    !allowAny &&
    allowedLogins.length === 0 &&
    allowedEmails.length === 0 &&
    allowedOrgs.length === 0
  ) {
    // 管理台能读全部服务凭据，这里绝不默认放开。
    throw new Error(
      "GitHub 登录必须配置准入名单（FLOWLET_GITHUB_ALLOWED_LOGINS / ALLOWED_EMAILS / ALLOWED_ORGS），或显式设置 FLOWLET_GITHUB_ALLOW_ANY=1",
    );
  }
  const scopes =
    envTrim(env, "FLOWLET_GITHUB_SCOPES") ??
    (allowedOrgs.length > 0 ? "read:user user:email read:org" : "read:user user:email");
  return {
    clientId,
    clientSecret,
    scopes,
    displayName: envTrim(env, "FLOWLET_GITHUB_DISPLAY_NAME") ?? "GitHub",
    allowedLogins,
    allowedEmails,
    allowedOrgs,
    adminLogins,
    adminEmails,
    allowAny,
    authorizeUrl:
      envTrim(env, "FLOWLET_GITHUB_AUTHORIZE_URL") ?? "https://github.com/login/oauth/authorize",
    tokenUrl:
      envTrim(env, "FLOWLET_GITHUB_TOKEN_URL") ?? "https://github.com/login/oauth/access_token",
    apiBase: (envTrim(env, "FLOWLET_GITHUB_API_BASE") ?? "https://api.github.com").replace(
      /\/+$/,
      "",
    ),
  };
}

// ─── 小工具 ─────────────────────────────────────────────────────────────────

function nowMs(): number {
  return Date.now();
}

function randomToken(): string {
  return `${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function tokenMatches(expected: string, candidate: string): boolean {
  if (expected === "") return false;
  const mac = (value: string): Buffer => createHmac("sha256", "flowlet-web-admin").update(value, "utf8").digest();
  return timingSafeEqual(mac(candidate), mac(expected));
}

function maskSecret(value: string): string {
  if (value.length <= 8) return "***";
  return `${value.slice(0, 8)}…`;
}

/** Rust base64 URL_SAFE_NO_PAD 解码（拒绝 padding）。 */
function decodeBase64Url(value: string): Buffer {
  if (value.includes("=") || !/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error("invalid base64url");
  }
  if (value.length % 4 === 1) throw new Error("invalid base64url length");
  return Buffer.from(value, "base64url");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as JsonRow)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function jsonResponse(status: number, value: unknown, extra: Record<string, string | string[]> = {}): AuthResponse {
  const body = Buffer.from(stableStringify(value), "utf8");
  return {
    status,
    headers: {
      "content-type": "application/json",
      "content-length": String(body.length),
      ...extra,
    },
    body,
  };
}

function jsonError(status: number, code: string, message: string): AuthResponse {
  return jsonResponse(status, { code, message });
}

function redirectResponse(status: number, location: string, cookies: string[]): AuthResponse {
  const headers: Record<string, string | string[]> = {
    location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-length": "0",
  };
  if (cookies.length === 1) headers["set-cookie"] = cookies[0];
  else if (cookies.length > 1) headers["set-cookie"] = cookies;
  return { status, headers, body: Buffer.alloc(0) };
}

function buildCookie(name: string, value: string, secure: boolean, maxAgeSeconds: number | null): string {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (secure) parts.push("Secure");
  if (maxAgeSeconds !== null) parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join("; ");
}

function cookieValue(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const raw = headers.cookie;
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  for (const header of list) {
    for (const item of header.split(";")) {
      const trimmed = item.trim();
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (key !== name) continue;
      const value = trimmed.slice(eq + 1).trim();
      if (value !== "") return value;
    }
  }
  return null;
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const value = headers[name];
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** 请求的实际协议：优先 `X-Forwarded-Proto`（Cloudflare 隧道 / 反代），其次是 `X-Forwarded-Scheme`。 */
function requestScheme(
  headers: Record<string, string | string[] | undefined>,
): "http" | "https" | null {
  const raw =
    headerValue(headers, "x-forwarded-proto") ?? headerValue(headers, "x-forwarded-scheme");
  const first = raw?.split(",")[0]?.trim().toLowerCase();
  if (first === "https" || first === "http") return first;
  return null;
}

/**
 * 请求来源（协议 + Host），用于挑选 OIDC 回调地址与 CSRF 校验。
 * 只用于**比对白名单**，绝不能直接拿来拼 redirect_uri —— 那等于把 Host 头注入
 * 变成开放重定向。返回 null 表示判断不了，调用方应回落到默认值。
 */
function requestOriginOf(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const scheme = requestScheme(headers);
  if (scheme === null) return null;
  const hostRaw =
    headerValue(headers, "x-forwarded-host") ?? headerValue(headers, "host") ?? "";
  const host = hostRaw.split(",")[0]?.trim() ?? "";
  if (host === "") return null;
  // Host 头里可能出现非 ASCII 或非法字符，URL 解析失败就当作判断不了。
  try {
    return new URL(`${scheme}://${host}`).origin;
  } catch {
    return null;
  }
}

// ─── AdminAuth ──────────────────────────────────────────────────────────────

export class AdminAuth {
  readonly config: AdminAuthConfig;
  #sessions = new Map<string, Session>();
  #transactions = new Map<string, Transaction>();
  #discovery: Cached<DiscoveryDoc> | null = null;
  #jwks: Cached<Jwk[]> | null = null;
  #sessionStore: AdminSessionStore | null;

  private constructor(config: AdminAuthConfig, sessionStore: AdminSessionStore | null = null) {
    this.config = config;
    this.#sessionStore = sessionStore;
  }

  static fromConfig(config: AdminAuthConfig, sessionStore: AdminSessionStore | null = null): AdminAuth {
    return new AdminAuth(config, sessionStore);
  }

  /**
   * 热替换 GitHub 提供方配置：管理台里保存/删除后立即生效，不用重启进程。
   * 传 null 表示关闭这个提供方（其它提供方不受影响）。
   */
  applyGithubConfig(github: GithubConfig | null): void {
    this.config.github = github;
  }

  /**
   * Rust `AdminAuth::from_env`；fallbackToken 仅用于宿主程序化注入（测试/embedding）。
   * sessionStore 仅由 Node Host 注入：提供时 cookie 会话跨进程重启保留。
   */
  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    fallbackToken?: string,
    sessionStore: AdminSessionStore | null = null,
  ): AdminAuth {
    return new AdminAuth(adminAuthConfigFromEnv(env, fallbackToken), sessionStore);
  }

  mode(): AuthMode {
    return this.config.mode;
  }

  displayName(): string | null {
    return this.config.oidc?.displayName ?? null;
  }

  staticToken(): string | null {
    return this.config.adminToken === "" ? null : this.config.adminToken;
  }

  /** Secure 与否决定 cookie 名（`__Host-` 前缀强制要求 Secure）。 */
  adminCookieName(secure: boolean = this.config.cookieSecure): string {
    return secure ? ADMIN_COOKIE_SECURE : ADMIN_COOKIE;
  }

  browserCookieName(secure: boolean = this.config.cookieSecure): string {
    return secure ? BROWSER_COOKIE_SECURE : BROWSER_COOKIE;
  }

  /** 读会话 cookie：两个名字都试一遍，协议判断有偏差时也不至于读不到。 */
  #readAdminCookie(headers: Record<string, string | string[] | undefined>): string | null {
    return cookieValue(headers, ADMIN_COOKIE_SECURE) ?? cookieValue(headers, ADMIN_COOKIE);
  }

  #readBrowserCookie(headers: Record<string, string | string[] | undefined>): string | null {
    return cookieValue(headers, BROWSER_COOKIE_SECURE) ?? cookieValue(headers, BROWSER_COOKIE);
  }

  /** 本次请求该用 Secure 吗：`scheme` 模式跟随实际协议，避免 http 入口被浏览器丢 cookie。 */
  #secureFor(headers: Record<string, string | string[] | undefined>): boolean {
    if (this.config.cookieSecureMode === "always") return true;
    if (this.config.cookieSecureMode === "never") return false;
    const scheme = requestScheme(headers);
    if (scheme === "https") return true;
    if (scheme === "http") return false;
    return this.config.cookieSecure;
  }

  // ── 会话 / CSRF ──────────────────────────────────────────────────────────

  authenticate(headers: Record<string, string | string[] | undefined>): AuthContext | null {
    const authorization = headerValue(headers, "authorization");
    if (authorization !== null && authorization.startsWith("Bearer ")) {
      const token = authorization.slice("Bearer ".length);
      const bearerAllowed =
        this.config.mode === "token" ||
        (this.config.mode === "oidc" && this.config.allowTokenLogin);
      if (bearerAllowed && tokenMatches(this.config.adminToken, token)) {
        return { viaCookie: false, csrfToken: null, identity: null, sessionKey: null };
      }
    }
    if (this.config.mode !== "oidc") return null;
    const cookie = this.#readAdminCookie(headers);
    if (cookie === null) return null;
    const key = sha256Hex(cookie);
    const now = nowMs();
    const session = this.#loadSession(key);
    if (session === null) return null;
    if (now >= session.absoluteExpireMs || now - session.lastSeenMs > this.config.sessionIdleMs) {
      this.#sessions.delete(key);
      this.#sessionStore?.remove(key);
      return null;
    }
    session.lastSeenMs = now;
    this.#persistSession(key, session, now, false);
    return {
      viaCookie: true,
      csrfToken: session.csrfToken,
      identity: { ...session.identity, groups: [...session.identity.groups] },
      sessionKey: key,
    };
  }

  /** 内存优先；缺失时尝试从持久化存储恢复（容器重启后的第一次请求）。 */
  #loadSession(key: string): Session | null {
    const inMemory = this.#sessions.get(key);
    if (inMemory !== undefined) return inMemory;
    const store = this.#sessionStore;
    if (store === null) return null;
    const persisted = store.load(key);
    if (persisted === null) return null;
    const restored: Session = {
      identity: {
        ...persisted.identity,
        groups: [...persisted.identity.groups],
        // 旧会话文件没有 role：按 admin 恢复，升级不踢人。
        role: persisted.identity.role === "viewer" ? "viewer" : "admin",
      },
      csrfToken: persisted.csrfToken,
      createdMs: persisted.createdMs,
      lastSeenMs: persisted.lastSeenMs,
      absoluteExpireMs: persisted.absoluteExpireMs,
      persistedAtMs: persisted.lastSeenMs,
    };
    this.#sessions.set(key, restored);
    return restored;
  }

  /**
   * 写回持久化存储。lastSeen 变更按 SESSION_PERSIST_INTERVAL_MS 限流；
   * force=true 用于新建/销毁这类必须立即落盘的动作。
   */
  #persistSession(key: string, session: Session, now: number, force: boolean): void {
    const store = this.#sessionStore;
    if (store === null) return;
    if (!force && now - session.persistedAtMs < SESSION_PERSIST_INTERVAL_MS) return;
    session.persistedAtMs = now;
    store.save({
      key,
      identity: { ...session.identity, groups: [...session.identity.groups] },
      csrfToken: session.csrfToken,
      createdMs: session.createdMs,
      lastSeenMs: session.lastSeenMs,
      absoluteExpireMs: session.absoluteExpireMs,
    });
  }

  #sessionExpired(session: PersistedAdminSession, now: number): boolean {
    return now >= session.absoluteExpireMs || now - session.lastSeenMs > this.config.sessionIdleMs;
  }

  verifyCsrf(
    headers: Record<string, string | string[] | undefined>,
    context: AuthContext,
  ): boolean {
    if (!context.viaCookie) return true;
    const expected = context.csrfToken;
    if (expected === null) return false;
    const actual = headerValue(headers, CSRF_HEADER);
    if (actual === null || actual !== expected) return false;
    const origin = headerValue(headers, "origin");
    if (origin === null) return false;
    const allowed =
      this.config.publicWebUrls.length > 0
        ? this.config.publicWebUrls
        : [this.config.publicWebUrl].filter((item) => item !== "");
    return allowed.some((url) => originOf(url) === origin);
  }

  /** 按请求来源挑一个白名单内的回调地址；不在白名单一律回落默认值。 */
  #redirectUriFor(info: AuthRequestInfo, oidc: OidcConfig): string {
    const origin = requestOriginOf(info.headers);
    if (origin !== null) {
      const candidate = `${origin}/api/auth/callback`;
      if (oidc.redirectUrls.includes(candidate)) return candidate;
    }
    // 直连内网 IP 时不会带 X-Forwarded-Proto，协议判断不出来；此时按 Host 匹配
    // 白名单里的 origin，免得把 http 入口的登录拽到公网 https 上去。
    const hostRaw =
      headerValue(info.headers, "x-forwarded-host") ?? headerValue(info.headers, "host") ?? "";
    const host = hostRaw.split(",")[0]?.trim() ?? "";
    if (host !== "") {
      for (const url of oidc.redirectUrls) {
        try {
          if (new URL(url).host === host) return url;
        } catch {
          /* 白名单里理论不会有非法 URL；忽略 */
        }
      }
    }
    return oidc.redirectUrl;
  }

  #sessionCookie(value: string, secure: boolean): string {
    return buildCookie(this.adminCookieName(secure), value, secure, Math.floor(this.config.sessionTtlMs / 1000));
  }

  /** 退出登录时两个名字都清：调用方拿不到可靠协议时也不会漏清。 */
  #clearSessionCookie(): string[] {
    return [
      buildCookie(ADMIN_COOKIE_SECURE, "", true, 0),
      buildCookie(ADMIN_COOKIE, "", false, 0),
    ];
  }

  #browserCookie(value: string, secure: boolean): string {
    return buildCookie(this.browserCookieName(secure), value, secure, Math.floor(BROWSER_COOKIE_TTL_MS / 1000));
  }

  /** 清浏览器绑定 cookie：两个名字都清，避免协议判断不一致时残留。 */
  #clearBrowserCookie(): string[] {
    return [
      buildCookie(BROWSER_COOKIE_SECURE, "", true, 0),
      buildCookie(BROWSER_COOKIE, "", false, 0),
    ];
  }

  #createSession(identity: Identity): { raw: string; csrf: string } {
    const raw = randomToken();
    const key = sha256Hex(raw);
    const csrf = randomToken();
    const now = nowMs();
    for (const [sessionKey, session] of this.#sessions) {
      const expired =
        now >= session.absoluteExpireMs || now - session.lastSeenMs > this.config.sessionIdleMs;
      if (expired) {
        this.#sessions.delete(sessionKey);
        this.#sessionStore?.remove(sessionKey);
      }
    }
    this.#sessionStore?.prune((session) => this.#sessionExpired(session, now));
    const session: Session = {
      identity: { ...identity, groups: [...identity.groups] },
      csrfToken: csrf,
      createdMs: now,
      lastSeenMs: now,
      absoluteExpireMs: now + this.config.sessionTtlMs,
      persistedAtMs: now,
    };
    this.#sessions.set(key, session);
    this.#persistSession(key, session, now, true);
    return { raw, csrf };
  }

  #destroySession(context: AuthContext): boolean {
    if (context.sessionKey === null) return false;
    const removed = this.#sessions.delete(context.sessionKey);
    this.#sessionStore?.remove(context.sessionKey);
    return removed;
  }

  // ── OIDC discovery / JWKS ────────────────────────────────────────────────

  async #fetchJson(url: string): Promise<{ status: number; body: string }> {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(OIDC_HTTP_TIMEOUT_MS),
    });
    return { status: response.status, body: await response.text() };
  }

  async #discoveryDoc(): Promise<DiscoveryDoc> {
    const oidc = this.config.oidc;
    if (oidc === null) throw new Error("OIDC 未配置");
    if (this.#discovery !== null && nowMs() - this.#discovery.fetchedMs < DISCOVERY_TTL_MS) {
      return this.#discovery.value;
    }
    let response: { status: number; body: string };
    try {
      response = await this.#fetchJson(oidc.discoveryUrl);
    } catch {
      throw new Error("无法访问 OIDC discovery 端点");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`OIDC discovery 返回 HTTP ${response.status}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new Error("OIDC discovery 响应不是合法 JSON");
    }
    const doc = parseDiscoveryDoc(parsed);
    if (doc === null) throw new Error("OIDC discovery 响应不是合法 JSON");
    if (doc.issuer !== oidc.issuer) {
      throw new Error(`OIDC issuer 不一致：配置 ${oidc.issuer}，discovery ${doc.issuer}`);
    }
    validateHttpsEndpoint(doc.authorization_endpoint, oidc.insecureHttp);
    validateHttpsEndpoint(doc.token_endpoint, oidc.insecureHttp);
    validateHttpsEndpoint(doc.jwks_uri, oidc.insecureHttp);
    if (doc.userinfo_endpoint !== null) validateHttpsEndpoint(doc.userinfo_endpoint, oidc.insecureHttp);
    this.#discovery = { value: doc, fetchedMs: nowMs() };
    return doc;
  }

  async #loadJwks(force: boolean): Promise<Jwk[]> {
    if (!force && this.#jwks !== null && nowMs() - this.#jwks.fetchedMs < JWKS_TTL_MS) {
      return this.#jwks.value;
    }
    const doc = await this.#discoveryDoc();
    let response: { status: number; body: string };
    try {
      response = await this.#fetchJson(doc.jwks_uri);
    } catch {
      throw new Error("无法访问 OIDC JWKS");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`OIDC JWKS 返回 HTTP ${response.status}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new Error("OIDC JWKS 响应不是合法 JSON");
    }
    const keys = parseJwks(parsed);
    if (keys === null) throw new Error("OIDC JWKS 响应不是合法 JSON");
    this.#jwks = { value: keys, fetchedMs: nowMs() };
    return keys;
  }

  // ── handlers ─────────────────────────────────────────────────────────────

  configHandler(): AuthResponse {
    const oidc = this.config.oidc;
    return jsonResponse(
      200,
      {
        mode: this.config.mode,
        provider: { display_name: oidc?.displayName ?? this.config.github?.displayName ?? null },
        // 登录页据此渲染按钮：公网入口用 GitHub，内网入口用公司 OIDC（`?provider=` 可覆盖）。
        providers: [
          ...(oidc === null ? [] : [{ id: "oidc", display_name: oidc.displayName }]),
          ...(this.config.github === null
            ? []
            : [{ id: "github", display_name: this.config.github.displayName }]),
        ],
        login_path: "/api/auth/login",
        token_login:
          this.config.mode === "token" ||
          (this.config.mode === "oidc" && this.config.allowTokenLogin),
      },
      { "cache-control": "no-store" },
    );
  }

  sessionHandler(context: AuthContext): AuthResponse {
    if (this.config.mode === "token") {
      return jsonResponse(200, { authenticated: true, mode: "token", csrf_token: null });
    }
    if (context.identity === null) {
      return jsonError(401, "unauthorized", "会话无效");
    }
    return jsonResponse(200, {
      authenticated: true,
      mode: "oidc",
      identity: publicIdentity(context.identity),
      csrf_token: context.csrfToken,
    });
  }

  /** 登录入口：按 `?provider=` 或入口协议挑一个提供方。 */
  async loginHandler(info: AuthRequestInfo): Promise<AuthResponse> {
    const providerId = this.#providerFor(info);
    if (providerId === null) {
      return jsonError(404, "auth_not_configured", "当前未启用任何登录提供方");
    }
    if (providerId === "github") return this.#githubLogin(info);
    return this.#oidcLogin(info);
  }

  /** 本次请求该走哪个提供方：显式 `?provider=` 优先，否则公网 https 入口走 GitHub。 */
  #providerFor(info: AuthRequestInfo): AuthProviderId | null {
    let explicit: string | null = null;
    try {
      explicit = new URL(info.url, "http://localhost").searchParams.get("provider");
    } catch {
      explicit = null;
    }
    const wanted = (explicit ?? "").trim().toLowerCase();
    if (wanted !== "") {
      if (wanted === "github") return this.config.github === null ? null : "github";
      if (wanted === "oidc" || wanted === "gitlab") {
        return this.config.oidc === null ? null : "oidc";
      }
      return null;
    }
    // 没指定：https 入口（公网域名 / 隧道）走 GitHub，内网 http 入口走公司 OIDC。
    if (requestScheme(info.headers) === "https" && this.config.github !== null) return "github";
    if (this.config.oidc !== null) return "oidc";
    return this.config.github === null ? null : "github";
  }

  async #oidcLogin(info: AuthRequestInfo): Promise<AuthResponse> {
    const oidc = this.config.oidc;
    if (oidc === null) return jsonError(404, "auth_not_configured", "当前未启用 OIDC");
    let discovery: DiscoveryDoc;
    try {
      discovery = await this.#discoveryDoc();
    } catch (error) {
      console.warn(`OIDC discovery failed: ${errorMessage(error)}`);
      return redirectResponse(303, "/?auth_error=provider_unavailable", []);
    }
    const secure = this.#secureFor(info.headers);
    const redirectUri = this.#redirectUriFor(info, oidc);
    const stateToken = randomToken();
    const nonce = randomToken();
    const browser = this.#readBrowserCookie(info.headers) ?? randomToken();
    const browserHash = sha256Hex(browser);
    const pkceSupported = (discovery.code_challenge_methods_supported ?? []).includes("S256");
    if (oidc.pkce === "required" && !pkceSupported) {
      return jsonError(503, "provider_unavailable", "OIDC 未声明 PKCE S256");
    }
    const usePkce = pkceSupported && oidc.pkce !== "off";
    const verifier = usePkce ? randomToken() : null;
    const challenge = verifier === null ? null : sha256Base64Url(verifier);
    const now = nowMs();
    for (const [key, transaction] of this.#transactions) {
      if (now - transaction.createdMs >= TRANSACTION_TTL_MS) this.#transactions.delete(key);
    }
    this.#transactions.set(sha256Hex(stateToken), {
      nonce,
      verifier,
      browserHash,
      createdMs: now,
      redirectUri,
      cookieSecure: secure,
      provider: "oidc",
    });

    let authorizeUrl: URL;
    try {
      authorizeUrl = new URL(discovery.authorization_endpoint);
    } catch {
      return jsonError(500, "internal_error", "authorization_endpoint 不是合法 URL");
    }
    // 顺序与 Rust url::Url::query_pairs_mut 追加顺序一致。
    authorizeUrl.searchParams.append("response_type", "code");
    authorizeUrl.searchParams.append("client_id", oidc.clientId);
    authorizeUrl.searchParams.append("redirect_uri", redirectUri);
    authorizeUrl.searchParams.append("scope", oidc.scopes);
    authorizeUrl.searchParams.append("state", stateToken);
    authorizeUrl.searchParams.append("nonce", nonce);
    if (challenge !== null) {
      authorizeUrl.searchParams.append("code_challenge", challenge);
      authorizeUrl.searchParams.append("code_challenge_method", "S256");
    }
    return redirectResponse(302, authorizeUrl.toString(), [this.#browserCookie(browser, secure)]);
  }

  /** 请求来源 origin，必须命中对外地址白名单；否则回落默认地址。 */
  #originFor(info: AuthRequestInfo): string | null {
    const origin = requestOriginOf(info.headers);
    if (origin !== null && this.config.publicWebUrls.includes(origin)) return origin;
    const hostRaw =
      headerValue(info.headers, "x-forwarded-host") ?? headerValue(info.headers, "host") ?? "";
    const host = hostRaw.split(",")[0]?.trim() ?? "";
    if (host !== "") {
      for (const url of this.config.publicWebUrls) {
        try {
          const parsed = new URL(url);
          if (parsed.host === host) return parsed.origin;
        } catch {
          /* 白名单里不会有非法 URL */
        }
      }
    }
    return this.config.publicWebUrls[0] ?? null;
  }

  /** GitHub 授权跳转：GitHub 不是 OIDC，没有 nonce/PKCE，回调地址带 `/github` 后缀。 */
  #githubLogin(info: AuthRequestInfo): AuthResponse {
    const github = this.config.github;
    if (github === null) return jsonError(404, "auth_not_configured", "当前未启用 GitHub 登录");
    const origin = this.#originFor(info);
    if (origin === null) {
      return jsonError(500, "internal_error", "没有可用的回调地址（未配置对外访问地址）");
    }
    const redirectUri = `${origin}/api/auth/callback/github`;
    const secure = this.#secureFor(info.headers);
    const stateToken = randomToken();
    const browser = this.#readBrowserCookie(info.headers) ?? randomToken();
    const now = nowMs();
    for (const [key, transaction] of this.#transactions) {
      if (now - transaction.createdMs >= TRANSACTION_TTL_MS) this.#transactions.delete(key);
    }
    this.#transactions.set(sha256Hex(stateToken), {
      nonce: "",
      verifier: null,
      browserHash: sha256Hex(browser),
      createdMs: now,
      redirectUri,
      cookieSecure: secure,
      provider: "github",
    });
    let authorizeUrl: URL;
    try {
      authorizeUrl = new URL(github.authorizeUrl);
    } catch {
      return jsonError(500, "internal_error", "GitHub 授权地址不是合法 URL");
    }
    authorizeUrl.searchParams.append("client_id", github.clientId);
    authorizeUrl.searchParams.append("redirect_uri", redirectUri);
    authorizeUrl.searchParams.append("scope", github.scopes);
    authorizeUrl.searchParams.append("state", stateToken);
    return redirectResponse(302, authorizeUrl.toString(), [this.#browserCookie(browser, secure)]);
  }

  /** 调 GitHub REST；失败返回 null（调用方按登录失败处理，不抛）。 */
  async #githubJson(
    github: GithubConfig,
    path: string,
    accessToken: string,
  ): Promise<unknown> {
    try {
      const response = await fetch(`${github.apiBase}${path}`, {
        method: "GET",
        redirect: "manual",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${accessToken}`,
          "user-agent": "flowlet-admin-auth",
          "x-github-api-version": "2022-11-28",
        },
        signal: AbortSignal.timeout(OIDC_HTTP_TIMEOUT_MS),
      });
      if (response.status < 200 || response.status >= 300) {
        console.warn(`GitHub API ${path} -> HTTP ${response.status}`);
        return null;
      }
      return JSON.parse(await response.text());
    } catch (error) {
      console.warn(`GitHub API ${path} failed: ${errorMessage(error)}`);
      return null;
    }
  }

  /** 用授权码换身份：code → access_token → /user（+ /user/emails、/user/orgs）。 */
  async #githubIdentity(
    github: GithubConfig,
    transaction: Transaction,
    code: string,
  ): Promise<Identity | string> {
    const form = new URLSearchParams();
    form.append("client_id", github.clientId);
    form.append("client_secret", github.clientSecret);
    form.append("code", code);
    form.append("redirect_uri", transaction.redirectUri);
    let accessToken: string | null = null;
    try {
      const response = await fetch(github.tokenUrl, {
        method: "POST",
        redirect: "manual",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "flowlet-admin-auth",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(OIDC_HTTP_TIMEOUT_MS),
      });
      if (response.status < 200 || response.status >= 300) {
        console.warn(`GitHub token endpoint rejected the code: HTTP ${response.status}`);
        return "login_failed";
      }
      const parsed: unknown = JSON.parse(await response.text());
      const value =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>).access_token
          : null;
      accessToken = typeof value === "string" && value !== "" ? value : null;
    } catch (error) {
      console.warn(`GitHub token request failed: ${errorMessage(error)}`);
      return "provider_unavailable";
    }
    if (accessToken === null) {
      console.warn("GitHub token response did not include access_token");
      return "login_failed";
    }

    const user = await this.#githubJson(github, "/user", accessToken);
    if (user === null || typeof user !== "object" || Array.isArray(user)) {
      return "login_failed";
    }
    const record = user as Record<string, unknown>;
    const id = typeof record.id === "number" ? record.id : null;
    const login = stringClaim(record, "login");
    if (id === null || login === null) {
      console.warn("GitHub /user 响应缺少 id/login");
      return "login_failed";
    }
    const identity: Identity = {
      sub: String(id),
      email: null,
      username: login,
      name: stringClaim(record, "name"),
      groups: [],
      provider: github.displayName,
    };
    const directEmail = stringClaim(record, "email");
    if (directEmail !== null) {
      identity.email = directEmail;
    } else {
      // 用户把邮箱设为私有时 /user 里是 null，改查 /user/emails（primary + verified）。
      const emails = await this.#githubJson(github, "/user/emails", accessToken);
      if (Array.isArray(emails)) {
        const primary = emails.find(
          (item): item is Record<string, unknown> =>
            item !== null &&
            typeof item === "object" &&
            (item as Record<string, unknown>).primary === true &&
            (item as Record<string, unknown>).verified === true,
        );
        const address = primary ? stringClaim(primary, "email") : null;
        if (address !== null) identity.email = address;
      }
    }
    if (github.allowedOrgs.length > 0) {
      const orgs = await this.#githubJson(github, "/user/orgs", accessToken);
      if (Array.isArray(orgs)) {
        identity.groups = orgs
          .map((item) => (item !== null && typeof item === "object" ? stringClaim(item, "login") : null))
          .filter((item): item is string => item !== null);
      }
    }
    return identity;
  }

  /** OIDC 换身份：code → token → 校验 id_token → 合并 userinfo。失败返回 auth_error 代码。 */
  async #oidcIdentity(
    oidc: OidcConfig,
    transaction: Transaction,
    code: string,
  ): Promise<Identity | string> {
    let discovery: DiscoveryDoc;
    try {
      discovery = await this.#discoveryDoc();
    } catch (error) {
      console.warn(`OIDC discovery failed during callback: ${errorMessage(error)}`);
      return "provider_unavailable";
    }

    const form = new URLSearchParams();
    form.append("grant_type", "authorization_code");
    form.append("code", code);
    form.append("redirect_uri", transaction.redirectUri);
    if (transaction.verifier !== null) form.append("code_verifier", transaction.verifier);
    let tokenPayload: { id_token?: unknown; access_token?: unknown };
    try {
      const basic = Buffer.from(`${oidc.clientId}:${oidc.clientSecret}`, "utf8").toString("base64");
      const response = await fetch(discovery.token_endpoint, {
        method: "POST",
        redirect: "manual",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${basic}`,
        },
        body: form.toString(),
        signal: AbortSignal.timeout(OIDC_HTTP_TIMEOUT_MS),
      });
      if (response.status < 200 || response.status >= 300) {
        console.warn(`OIDC token endpoint rejected the code: HTTP ${response.status}`);
        return "login_failed";
      }
      const parsed: unknown = JSON.parse(await response.text());
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return "login_failed";
      }
      tokenPayload = parsed as { id_token?: unknown; access_token?: unknown };
    } catch (error) {
      console.warn(`OIDC token request failed: ${errorMessage(error)}`);
      return "provider_unavailable";
    }
    const idToken = typeof tokenPayload.id_token === "string" ? tokenPayload.id_token : null;
    if (idToken === null) {
      console.warn("OIDC token response did not include id_token");
      return "login_failed";
    }
    let claims: IdTokenClaims;
    try {
      claims = await this.#verifyIdToken(idToken, oidc, transaction.nonce);
    } catch (error) {
      console.warn(`OIDC id_token validation failed: ${errorMessage(error)}`);
      return "login_failed";
    }

    const identity: Identity = {
      sub: claims.sub,
      email: null,
      username: null,
      name: null,
      groups: [],
      provider: oidc.displayName,
    };
    const accessToken =
      typeof tokenPayload.access_token === "string" ? tokenPayload.access_token : null;
    if (discovery.userinfo_endpoint !== null && accessToken !== null) {
      try {
        const response = await fetch(discovery.userinfo_endpoint, {
          method: "GET",
          redirect: "manual",
          headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(OIDC_HTTP_TIMEOUT_MS),
        });
        if (response.status >= 200 && response.status < 300) {
          const userinfo: unknown = JSON.parse(await response.text());
          const userinfoSub = stringClaim(userinfo, "sub");
          if (userinfoSub !== claims.sub) {
            console.warn("OIDC userinfo sub does not match id_token");
            return "login_failed";
          }
          applyClaims(identity, oidc, userinfo);
        }
      } catch {
        /* Rust 在 userinfo 失败/非 JSON 时只告警忽略 */
      }
    }
    return identity;
  }

  async callbackHandler(info: AuthRequestInfo): Promise<AuthResponse> {
    let searchParams: URLSearchParams;
    try {
      searchParams = new URL(info.url, "http://localhost").searchParams;
    } catch {
      searchParams = new URLSearchParams();
    }
    const browser = this.#readBrowserCookie(info.headers) ?? "";
    const errorParam = searchParams.get("error");
    if (errorParam !== null) {
      console.info(`OIDC callback returned an error: ${errorParam}`);
      return redirectResponse(303, "/?auth_error=access_denied", [...this.#clearBrowserCookie()]);
    }
    const code = searchParams.get("code");
    const stateToken = searchParams.get("state");
    if (code === null || stateToken === null) {
      return redirectResponse(303, "/?auth_error=login_failed", [...this.#clearBrowserCookie()]);
    }
    const transactionKey = sha256Hex(stateToken);
    const transaction = this.#transactions.get(transactionKey) ?? null;
    this.#transactions.delete(transactionKey);
    if (transaction === null) {
      return redirectResponse(303, "/?auth_error=state_invalid", [...this.#clearBrowserCookie()]);
    }
    if (
      nowMs() - transaction.createdMs > TRANSACTION_TTL_MS ||
      browser === "" ||
      sha256Hex(browser) !== transaction.browserHash
    ) {
      return redirectResponse(303, "/?auth_error=state_invalid", [...this.#clearBrowserCookie()]);
    }
    const obtained: Identity | string =
      transaction.provider === "github"
        ? this.config.github === null
          ? "auth_not_configured"
          : await this.#githubIdentity(this.config.github, transaction, code)
        : this.config.oidc === null
          ? "auth_not_configured"
          : await this.#oidcIdentity(this.config.oidc, transaction, code);
    if (typeof obtained === "string") {
      console.warn(`SSO 登录失败：provider=${transaction.provider} reason=${obtained}`);
      return redirectResponse(303, `/?auth_error=${obtained}`, [...this.#clearBrowserCookie()]);
    }
    const identity = obtained;
    const allowed =
      transaction.provider === "github"
        ? this.config.github !== null && githubAllowlisted(this.config.github, identity)
        : this.config.oidc !== null && allowlisted(this.config.oidc, identity);
    if (!allowed) {
      console.info(
        `SSO 登录被准入名单拒绝：provider=${transaction.provider} sub=${maskSecret(identity.sub)}`,
      );
      return redirectResponse(303, "/?auth_error=allowlist_denied", [...this.#clearBrowserCookie()]);
    }
    // 角色：准入只决定「能进来」，能做什么由角色决定（管理台能读全部凭据）。
    identity.role =
      transaction.provider === "github"
        ? this.config.github === null
          ? "admin"
          : roleForGithub(this.config.github, identity)
        : this.config.oidc === null
          ? "admin"
          : roleForOidc(this.config.oidc, identity);
    const session = this.#createSession(identity);
    console.info(
      `SSO 登录成功：provider=${transaction.provider} sub=${maskSecret(identity.sub)} role=${identity.role}`,
    );
    return redirectResponse(303, "/", [
      this.#sessionCookie(session.raw, transaction.cookieSecure),
      ...this.#clearBrowserCookie(),
    ]);
  }


  logoutHandler(context: AuthContext): AuthResponse {
    this.#destroySession(context);
    return {
      status: 204,
      headers: { "set-cookie": this.#clearSessionCookie(), "content-length": "0" },
      body: Buffer.alloc(0),
    };
  }

  // ── ID token 校验 ────────────────────────────────────────────────────────

  async #verifyIdToken(token: string, oidc: OidcConfig, expectedNonce: string): Promise<IdTokenClaims> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("id_token 不是合法 JWT");
    let headerRaw: Buffer;
    try {
      headerRaw = decodeBase64Url(parts[0]);
    } catch {
      throw new Error("id_token header 不是 base64url");
    }
    let header: JsonRow;
    try {
      const decoded: unknown = JSON.parse(headerRaw.toString("utf8"));
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
        throw new Error("header");
      }
      header = decoded as JsonRow;
    } catch {
      throw new Error("id_token header 不是 JSON");
    }
    const alg = typeof header.alg === "string" ? header.alg : "";
    if (!oidc.signingAlgs.includes(alg)) {
      throw new Error(`不支持的 id_token 签名算法：${alg}`);
    }
    if (alg !== "RS256") throw new Error("当前只支持 RS256");
    const kid = typeof header.kid === "string" ? header.kid : null;
    const signingInput = `${parts[0]}.${parts[1]}`;
    let signature: Buffer;
    try {
      signature = decodeBase64Url(parts[2]);
    } catch {
      throw new Error("id_token 签名不是 base64url");
    }
    let keys = await this.#loadJwks(false);
    if (kid !== null && !keys.some((key) => key.kid === kid)) {
      keys = await this.#loadJwks(true);
    }
    let verified = false;
    for (const key of keys) {
      if (key.kty !== "RSA") continue;
      if (key.alg !== null && key.alg !== "RS256") continue;
      if (key.n === null || key.e === null) continue;
      let modulus: Buffer;
      let exponent: Buffer;
      try {
        modulus = decodeBase64Url(key.n);
        exponent = decodeBase64Url(key.e);
      } catch {
        continue;
      }
      // ring 的 RSA_PKCS1_2048_8192_SHA256 只接受 2048–8192 bit 的 RSA 公钥。
      if (modulus.length < 256 || modulus.length > 1024) continue;
      try {
        const publicKey = createPublicKey({
          key: { kty: "RSA", n: key.n, e: key.e },
          format: "jwk",
        });
        if (cryptoVerify("RSA-SHA256", Buffer.from(signingInput, "utf8"), publicKey, signature)) {
          verified = true;
          break;
        }
      } catch {
        /* 单把 key 不可用则继续尝试 */
      }
    }
    if (!verified) throw new Error("id_token 签名校验失败");

    let payloadRaw: Buffer;
    try {
      payloadRaw = decodeBase64Url(parts[1]);
    } catch {
      throw new Error("id_token payload 不是 base64url");
    }
    let claimsRaw: unknown;
    try {
      claimsRaw = JSON.parse(payloadRaw.toString("utf8"));
    } catch {
      throw new Error("id_token payload 不是合法 claims");
    }
    const claims = parseIdTokenClaims(claimsRaw);
    if (claims === null) throw new Error("id_token payload 不是合法 claims");
    if (claims.iss !== oidc.issuer) throw new Error("id_token issuer 不匹配");
    const audOk = Array.isArray(claims.aud)
      ? claims.aud.some((value) => typeof value === "string" && value === oidc.clientId)
      : claims.aud === oidc.clientId;
    if (!audOk) throw new Error("id_token audience 不匹配");
    if (claims.azp !== null && claims.azp !== oidc.clientId) {
      throw new Error("id_token azp 不匹配");
    }
    const nowSeconds = Math.floor(nowMs() / 1000);
    if (claims.exp + 60 < nowSeconds) throw new Error("id_token 已过期");
    if (claims.iat > nowSeconds + 60) throw new Error("id_token iat 在未来");
    if (oidc.nonce === "required") {
      if (claims.nonce !== expectedNonce) throw new Error("id_token nonce 不匹配");
    } else if (oidc.nonce === "best_effort") {
      if (claims.nonce !== null && claims.nonce !== expectedNonce) {
        throw new Error("id_token nonce 不匹配");
      }
      if (claims.nonce === null) {
        console.warn("id_token 缺少 nonce（FLOWLET_OIDC_NONCE=best_effort）");
      }
    }
    return claims;
  }
}

interface IdTokenClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  iat: number;
  sub: string;
  nonce: string | null;
  azp: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseDiscoveryDoc(value: unknown): DiscoveryDoc | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as JsonRow;
  if (typeof row.issuer !== "string") return null;
  if (typeof row.authorization_endpoint !== "string") return null;
  if (typeof row.token_endpoint !== "string") return null;
  if (typeof row.jwks_uri !== "string") return null;
  const userinfo = row.userinfo_endpoint;
  if (userinfo !== undefined && userinfo !== null && typeof userinfo !== "string") return null;
  const methods = row.code_challenge_methods_supported;
  if (methods !== undefined && methods !== null) {
    if (!Array.isArray(methods) || methods.some((item) => typeof item !== "string")) return null;
  }
  return {
    issuer: row.issuer,
    authorization_endpoint: row.authorization_endpoint,
    token_endpoint: row.token_endpoint,
    userinfo_endpoint: typeof userinfo === "string" ? userinfo : null,
    jwks_uri: row.jwks_uri,
    code_challenge_methods_supported: Array.isArray(methods) ? (methods as string[]) : null,
  };
}

function parseJwks(value: unknown): Jwk[] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = (value as JsonRow).keys;
  if (!Array.isArray(keys)) return null;
  const parsed: Jwk[] = [];
  for (const key of keys) {
    if (key === null || typeof key !== "object" || Array.isArray(key)) return null;
    const row = key as JsonRow;
    if (typeof row.kty !== "string") return null;
    const optional = (name: string): string | null => {
      const item = row[name];
      if (item === undefined || item === null) return null;
      return typeof item === "string" ? item : null;
    };
    parsed.push({
      kty: row.kty,
      kid: optional("kid"),
      n: optional("n"),
      e: optional("e"),
      alg: optional("alg"),
    });
  }
  return parsed;
}

function parseIdTokenClaims(value: unknown): IdTokenClaims | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as JsonRow;
  if (typeof row.iss !== "string") return null;
  const aud = row.aud;
  if (typeof aud !== "string" && !(Array.isArray(aud) && aud.every((item) => typeof item === "string"))) {
    return null;
  }
  if (typeof row.exp !== "number" || !Number.isSafeInteger(row.exp) || row.exp < 0) return null;
  if (typeof row.iat !== "number" || !Number.isSafeInteger(row.iat) || row.iat < 0) return null;
  if (typeof row.sub !== "string") return null;
  return {
    iss: row.iss,
    aud: aud as string | string[],
    exp: row.exp,
    iat: row.iat,
    sub: row.sub,
    nonce: typeof row.nonce === "string" ? row.nonce : null,
    azp: typeof row.azp === "string" ? row.azp : null,
  };
}

function publicIdentity(identity: Identity): JsonRow {
  return {
    email: identity.email,
    username: identity.username,
    name: identity.name,
    provider: identity.provider,
    role: identity.role ?? "admin",
  };
}

function stringClaim(value: unknown, key: string): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const item = (value as JsonRow)[key];
  return typeof item === "string" ? item : null;
}

/** Rust `apply_claims`：ID token 优先，UserInfo 只补缺失字段。 */
function applyClaims(identity: Identity, oidc: OidcConfig, value: unknown): void {
  const email = stringClaim(value, oidc.emailClaim);
  if (email !== null) identity.email = email;
  for (const key of ["preferred_username", "nickname"]) {
    if (identity.username === null) {
      const username = stringClaim(value, key);
      if (username !== null) identity.username = username;
    }
  }
  if (identity.name === null) {
    const name = stringClaim(value, oidc.nameClaim);
    if (name !== null) identity.name = name;
  }
  if (identity.groups.length === 0 && value !== null && typeof value === "object" && !Array.isArray(value)) {
    const raw = (value as JsonRow)[oidc.groupsClaim];
    if (Array.isArray(raw)) {
      identity.groups = raw.filter((item): item is string => typeof item === "string");
    }
  }
}

/** Rust `allowlisted`：任一命中即通过（sub / groups / email / email domain）。 */
export function allowlisted(oidc: OidcConfig, identity: Identity): boolean {
  if (oidc.allowAny) return true;
  if (oidc.allowedSubs.includes(identity.sub)) return true;
  if (oidc.allowedGroups.some((item) => identity.groups.includes(item))) return true;
  if (identity.email !== null) {
    const email = identity.email;
    if (oidc.allowedEmails.some((item) => item.toLowerCase() === email.toLowerCase())) return true;
    const at = email.lastIndexOf("@");
    if (at >= 0) {
      const domain = email.slice(at + 1);
      if (oidc.allowedDomains.some((item) => item.toLowerCase() === domain.toLowerCase())) return true;
    }
  }
  return false;
}

/** GitHub 准入：登录名 / 邮箱（都大小写不敏感）或组织成员。 */
export function githubAllowlisted(github: GithubConfig, identity: Identity): boolean {
  if (github.allowAny) return true;
  if (identity.username !== null) {
    const login = identity.username.toLowerCase();
    if (github.allowedLogins.some((item) => item.toLowerCase() === login)) return true;
  }
  if (identity.email !== null) {
    const email = identity.email.toLowerCase();
    if (github.allowedEmails.some((item) => item.toLowerCase() === email)) return true;
  }
  if (github.allowedOrgs.some((item) => identity.groups.includes(item))) return true;
  return false;
}

/**
 * GitHub 角色：命中管理员名单 → admin，其余准入者 → viewer。
 * 管理员名单为空时退回旧行为（准入者全员 admin），避免升级后把人锁在外面。
 */
export function roleForGithub(github: GithubConfig, identity: Identity): IdentityRole {
  const hasAdminList = github.adminLogins.length > 0 || github.adminEmails.length > 0;
  if (!hasAdminList) return "admin";
  const login = identity.username?.toLowerCase() ?? "";
  if (login !== "" && github.adminLogins.some((item) => item.toLowerCase() === login)) return "admin";
  const email = identity.email?.toLowerCase() ?? "";
  if (email !== "" && github.adminEmails.some((item) => item.toLowerCase() === email)) return "admin";
  return "viewer";
}

/**
 * OIDC 角色：有管理员名单就按名单；没有名单时「sub / 邮箱准入」算 admin，
 * 「域 / 组准入」算 viewer —— 前者是本人，后者通常是一群人。
 */
export function roleForOidc(oidc: OidcConfig, identity: Identity): IdentityRole {
  const hasAdminList = oidc.adminSubs.length > 0 || oidc.adminEmails.length > 0;
  const email = identity.email?.toLowerCase() ?? "";
  if (hasAdminList) {
    if (oidc.adminSubs.includes(identity.sub)) return "admin";
    if (email !== "" && oidc.adminEmails.some((item) => item.toLowerCase() === email)) return "admin";
    return "viewer";
  }
  if (oidc.allowedSubs.includes(identity.sub)) return "admin";
  if (email !== "" && oidc.allowedEmails.some((item) => item.toLowerCase() === email)) return "admin";
  return "viewer";
}
