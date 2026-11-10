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
  displayName: string;
  emailClaim: string;
  nameClaim: string;
  groupsClaim: string;
  allowedSubs: string[];
  allowedGroups: string[];
  allowedEmails: string[];
  allowedDomains: string[];
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
  publicWebUrl: string;
  cookieSecure: boolean;
  sessionIdleMs: number;
  sessionTtlMs: number;
  oidc: OidcConfig | null;
}

export interface Identity {
  sub: string;
  email: string | null;
  username: string | null;
  name: string | null;
  groups: string[];
  provider: string;
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

  const publicWebUrlRaw = envTrim(env, "FLOWLET_PUBLIC_WEB_URL");
  let publicWebUrl: string;
  if (publicWebUrlRaw !== null) {
    publicWebUrl = parsePublicWebUrl(publicWebUrlRaw);
  } else if (mode === "oidc") {
    throw new Error("OIDC 模式必须设置 FLOWLET_PUBLIC_WEB_URL");
  } else {
    publicWebUrl = "";
  }

  const sessionIdleMinutes = Math.max(1, parseUnsignedEnv(env, "FLOWLET_ADMIN_SESSION_IDLE_MINUTES", 30));
  const sessionTtlHours = Math.max(1, parseUnsignedEnv(env, "FLOWLET_ADMIN_SESSION_TTL_HOURS", 8));
  const sessionIdleMs = sessionIdleMinutes * 60 * 1000;
  const sessionTtlMs = sessionTtlHours * 3600 * 1000;
  if (sessionIdleMs > sessionTtlMs) throw new Error("空闲超时不能大于绝对超时");

  const cookieSecureRaw = envTrim(env, "FLOWLET_ADMIN_COOKIE_SECURE");
  const cookieSecure =
    cookieSecureRaw === "always"
      ? true
      : cookieSecureRaw === "never"
        ? false
        : publicWebUrl.startsWith("https://");

  if (mode === "token") {
    if (adminToken.length < 24) {
      throw new Error("FLOWLET_ADMIN_TOKEN 必须至少包含 24 个字符");
    }
    return {
      mode,
      adminToken,
      allowTokenLogin,
      publicWebUrl,
      cookieSecure,
      sessionIdleMs,
      sessionTtlMs,
      oidc: null,
    };
  }

  if (allowTokenLogin && adminToken.length < 24) {
    throw new Error("开启 ALLOW_TOKEN_LOGIN 时 FLOWLET_ADMIN_TOKEN 必须至少包含 24 个字符");
  }
  const issuer = envTrim(env, "FLOWLET_OIDC_ISSUER");
  if (issuer === null) throw new Error("OIDC 模式必须设置 FLOWLET_OIDC_ISSUER");
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

  const redirectUrl = envTrim(env, "FLOWLET_OIDC_REDIRECT_URL") ?? `${publicWebUrl}/api/auth/callback`;
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
      displayName: envTrim(env, "FLOWLET_OIDC_DISPLAY_NAME") ?? "GitLab",
      emailClaim: envTrim(env, "FLOWLET_OIDC_EMAIL_CLAIM") ?? "email",
      nameClaim: envTrim(env, "FLOWLET_OIDC_NAME_CLAIM") ?? "name",
      groupsClaim: envTrim(env, "FLOWLET_OIDC_GROUPS_CLAIM") ?? "groups",
      allowedSubs,
      allowedGroups,
      allowedEmails,
      allowedDomains,
      allowAny,
      allowHttpIssuer,
      insecureHttp,
      pkce,
      nonce,
      signingAlgs,
    },
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

  adminCookieName(): string {
    return this.config.cookieSecure ? ADMIN_COOKIE_SECURE : ADMIN_COOKIE;
  }

  browserCookieName(): string {
    return this.config.cookieSecure ? BROWSER_COOKIE_SECURE : BROWSER_COOKIE;
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
    const cookie = cookieValue(headers, this.adminCookieName());
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
      identity: { ...persisted.identity, groups: [...persisted.identity.groups] },
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
    return origin === originOf(this.config.publicWebUrl);
  }

  #sessionCookie(value: string): string {
    return buildCookie(this.adminCookieName(), value, this.config.cookieSecure, Math.floor(this.config.sessionTtlMs / 1000));
  }

  #clearSessionCookie(): string {
    return buildCookie(this.adminCookieName(), "", this.config.cookieSecure, 0);
  }

  #browserCookie(value: string): string {
    return buildCookie(this.browserCookieName(), value, this.config.cookieSecure, Math.floor(BROWSER_COOKIE_TTL_MS / 1000));
  }

  #clearBrowserCookie(): string {
    return buildCookie(this.browserCookieName(), "", this.config.cookieSecure, 0);
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
        provider: { display_name: oidc?.displayName ?? null },
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

  async loginHandler(info: AuthRequestInfo): Promise<AuthResponse> {
    const oidc = this.config.oidc;
    if (oidc === null) return jsonError(404, "auth_not_configured", "当前未启用 OIDC");
    let discovery: DiscoveryDoc;
    try {
      discovery = await this.#discoveryDoc();
    } catch (error) {
      console.warn(`OIDC discovery failed: ${errorMessage(error)}`);
      return redirectResponse(303, "/?auth_error=provider_unavailable", []);
    }
    const stateToken = randomToken();
    const nonce = randomToken();
    const browser =
      cookieValue(info.headers, this.browserCookieName()) ?? randomToken();
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
    authorizeUrl.searchParams.append("redirect_uri", oidc.redirectUrl);
    authorizeUrl.searchParams.append("scope", oidc.scopes);
    authorizeUrl.searchParams.append("state", stateToken);
    authorizeUrl.searchParams.append("nonce", nonce);
    if (challenge !== null) {
      authorizeUrl.searchParams.append("code_challenge", challenge);
      authorizeUrl.searchParams.append("code_challenge_method", "S256");
    }
    return redirectResponse(302, authorizeUrl.toString(), [this.#browserCookie(browser)]);
  }

  async callbackHandler(info: AuthRequestInfo): Promise<AuthResponse> {
    let searchParams: URLSearchParams;
    try {
      searchParams = new URL(info.url, "http://localhost").searchParams;
    } catch {
      searchParams = new URLSearchParams();
    }
    const browser = cookieValue(info.headers, this.browserCookieName()) ?? "";
    const errorParam = searchParams.get("error");
    if (errorParam !== null) {
      console.info(`OIDC callback returned an error: ${errorParam}`);
      return redirectResponse(303, "/?auth_error=access_denied", [this.#clearBrowserCookie()]);
    }
    const code = searchParams.get("code");
    const stateToken = searchParams.get("state");
    if (code === null || stateToken === null) {
      return redirectResponse(303, "/?auth_error=login_failed", [this.#clearBrowserCookie()]);
    }
    const transactionKey = sha256Hex(stateToken);
    const transaction = this.#transactions.get(transactionKey) ?? null;
    this.#transactions.delete(transactionKey);
    if (transaction === null) {
      return redirectResponse(303, "/?auth_error=state_invalid", [this.#clearBrowserCookie()]);
    }
    if (
      nowMs() - transaction.createdMs > TRANSACTION_TTL_MS ||
      browser === "" ||
      sha256Hex(browser) !== transaction.browserHash
    ) {
      return redirectResponse(303, "/?auth_error=state_invalid", [this.#clearBrowserCookie()]);
    }
    const oidc = this.config.oidc;
    if (oidc === null) return jsonError(404, "auth_not_configured", "当前未启用 OIDC");
    let discovery: DiscoveryDoc;
    try {
      discovery = await this.#discoveryDoc();
    } catch (error) {
      console.warn(`OIDC discovery failed during callback: ${errorMessage(error)}`);
      return redirectResponse(303, "/?auth_error=provider_unavailable", []);
    }

    const form = new URLSearchParams();
    form.append("grant_type", "authorization_code");
    form.append("code", code);
    form.append("redirect_uri", oidc.redirectUrl);
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
        return redirectResponse(303, "/?auth_error=login_failed", []);
      }
      const parsed: unknown = JSON.parse(await response.text());
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return redirectResponse(303, "/?auth_error=login_failed", []);
      }
      tokenPayload = parsed as { id_token?: unknown; access_token?: unknown };
    } catch (error) {
      console.warn(`OIDC token request failed: ${errorMessage(error)}`);
      return redirectResponse(303, "/?auth_error=provider_unavailable", []);
    }
    const idToken = typeof tokenPayload.id_token === "string" ? tokenPayload.id_token : null;
    if (idToken === null) {
      console.warn("OIDC token response did not include id_token");
      return redirectResponse(303, "/?auth_error=login_failed", []);
    }
    let claims: IdTokenClaims;
    try {
      claims = await this.#verifyIdToken(idToken, oidc, transaction.nonce);
    } catch (error) {
      console.warn(`OIDC id_token validation failed: ${errorMessage(error)}`);
      return redirectResponse(303, "/?auth_error=login_failed", []);
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
            return redirectResponse(303, "/?auth_error=login_failed", []);
          }
          applyClaims(identity, oidc, userinfo);
        }
      } catch {
        /* Rust 在 userinfo 失败/非 JSON 时只告警忽略 */
      }
    }
    if (!allowlisted(oidc, identity)) {
      console.info(`OIDC login denied by allowlist: sub=${maskSecret(identity.sub)}`);
      return redirectResponse(303, "/?auth_error=allowlist_denied", [this.#clearBrowserCookie()]);
    }
    const session = this.#createSession(identity);
    console.info(`OIDC login succeeded: sub=${maskSecret(claims.sub)}`);
    return redirectResponse(303, "/", [
      this.#sessionCookie(session.raw),
      this.#clearBrowserCookie(),
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
