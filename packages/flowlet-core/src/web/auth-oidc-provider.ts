/** OIDC（自建 GitLab）提供方的可持久化配置：**部署字段 + 准入/角色 + 登录方式开关**。
 *
 * 为什么整份都落库：以前 issuer / client 凭据只能写进 compose，换一个应用或者 GitLab 地址变了
 * 就得改部署、重启容器；而「谁能登录」「谁能管理」又天然是管理员日常操作。v0.7 起两者都在
 * 管理台自助维护：
 *
 * - 库内配置**完整优先**。有一份能解析的库内记录时，环境变量 `FLOWLET_OIDC_*` 整个被忽略
 *   （GitHub 提供方一直是这个语义）——否则「界面上删了 issuer」会被环境变量悄悄补回来，
 *   管理员看到的状态就不可信。
 * - 从没有库内记录时，环境变量继续作为种子：老部署升级后行为不变，打开页面看到的就是
 *   当前生效的配置，保存一次就接管了。
 * - `client_secret` 用 `SecretBox` 加密后存 app_meta；读接口永不返回明文或密文。
 * - 记录带 `generation`：每次保存 +1，用它校验「表单看到的版本 = 正在保存的版本」，
 *   防止两个标签页互相覆盖。
 *
 * 边界：本模块只做「解析 / 校验 / 持久化 / 映射成运行时配置」，不碰会话与登录流程；
 * 登录流程仍由 `auth.ts` 的 `AdminAuth` 负责。
 */
import type { IdentityRole, NonceMode, OidcConfig, PkceMode } from "./auth.ts";

/** OIDC 提供方配置在 app_meta 里的键；带 v1 方便以后换结构。 */
export const OIDC_PROVIDER_META_KEY = "auth_provider_oidc_v1";
/** 启用哪些登录方式。缺这条时按部署环境推断（见 `readLoginMode`）。 */
export const LOGIN_MODE_META_KEY = "auth_login_mode_v1";

/** 登录方式开关：`oidc` 与 `github` 至少开一个，另一个独立。两个都关 = 只剩静态管理凭据。 */
export interface LoginMode {
  oidc: boolean;
  github: boolean;
}

/** 管理台表单提交的形状。`client_secret` 为空串表示「沿用已存的」。 */
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
  /** 乐观锁：表单载入时的版本；传了就必须与库内一致，否则拒绝覆盖。 */
  generation?: number | null;
}

/** 回给管理台的视图：**永不包含 secret 明文或密文**。 */
export interface OidcProviderSummary {
  configured: boolean;
  /** 当前生效的配置来自哪里：库内 vs 环境变量种子。 */
  source: "stored" | "env" | "none";
  /** 详情表单的字段（来源数据库）；无关详情页布局，按功能分组展示。 */
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
  /** 库内记录版本；`source=env` 时为 0（未接管）。 */
  generation: number;
}

/** 校验（连通性自检）结果的一条：界面按条展示，不只在 Toast 里丢一句话。 */
export interface OidcCheckItem {
  key: "issuer" | "discovery" | "endpoints" | "client" | "pkce" | "redirect";
  status: "ok" | "warning" | "error";
  message: string;
}

export interface OidcCheckResult {
  ok: boolean;
  message: string;
  items: OidcCheckItem[];
  authorization_endpoint?: string;
  token_endpoint?: string;
}

/** 校验过程中从 discovery 取到的端点（保存时可能顺手接管，见 `saveOidcProvider`）。 */
export interface DiscoveryHints {
  /** 校验时实际访问的 discovery 地址。 */
  discoveryUrl?: string;
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  jwksUri?: string;
  supportsPkceS256?: boolean;
}

export interface AuthProviderStorage {
  getAppMeta(key: string): string | null;
  setAppMeta(key: string, value: string): void;
}

export interface AuthProviderSecrets {
  encrypt(plaintext: string): string;
  decrypt(encoded: string): string;
}

const DEFAULT_CLAIMS = { email: "email", name: "name", groups: "groups" } as const;
const DEFAULT_DISPLAY_NAME = "GitLab";

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

function normalizeIssuer(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) throw new Error(`issuer 必须带 http/https：${trimmed || "（空）"}`);
  return trimmed;
}

function normalizeEndpoint(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return fallback;
  if (!/^https?:\/\//i.test(trimmed)) throw new Error(`地址必须带 http/https：${trimmed}`);
  return trimmed.replace(/\/+$/, "");
}

function parsePkce(value: string | null | undefined): PkceMode {
  const raw = (value ?? "").trim();
  if (raw === "" || raw === "auto") return "auto";
  if (raw === "required") return "required";
  if (raw === "off") return "off";
  throw new Error(`PKCE 只能是 auto / required / off，收到：${raw}`);
}

function parseNonce(value: string | null | undefined): NonceMode {
  const raw = (value ?? "").trim();
  if (raw === "" || raw === "required") return "required";
  if (raw === "best_effort") return "best_effort";
  if (raw === "off") return "off";
  throw new Error(`nonce 只能是 required / best_effort / off，收到：${raw}`);
}

/** 落库的完整形状：secret 只以密文存在。 */
interface StoredOidcProvider {
  generation: number;
  issuer: string;
  discovery_url: string;
  redirect_urls: string[];
  client_id: string;
  client_secret_ciphertext: string;
  scopes: string;
  display_name: string;
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
  pkce: PkceMode;
  nonce: NonceMode;
}

type StoredParse =
  | { kind: "none" }
  | { kind: "tombstone" }
  | { kind: "invalid" }
  | { kind: "ok"; value: StoredOidcProvider };

function parseStored(raw: string | null): StoredParse {
  if (raw === null || raw.trim() === "") return { kind: "none" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "invalid" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "invalid" };
  const record = parsed as Record<string, unknown>;
  if (record.deleted === true) return { kind: "tombstone" };
  const str = (key: string): string => (typeof record[key] === "string" ? (record[key] as string) : "");
  const list = (key: string, ci = false): string[] =>
    cleanList(Array.isArray(record[key]) ? (record[key] as string[]).map((item) => String(item)) : [], ci);
  const issuer = str("issuer");
  const clientId = str("client_id");
  const ciphertext = str("client_secret_ciphertext");
  if (issuer === "" || clientId === "" || ciphertext === "") return { kind: "invalid" };
  const generation = typeof record.generation === "number" && Number.isFinite(record.generation)
    ? Math.max(0, Math.trunc(record.generation))
    : 0;
  return {
    kind: "ok",
    value: {
      generation,
      issuer,
      discovery_url: str("discovery_url"),
      redirect_urls: list("redirect_urls"),
      client_id: clientId,
      client_secret_ciphertext: ciphertext,
      scopes: text(str("scopes"), "openid"),
      display_name: text(str("display_name"), DEFAULT_DISPLAY_NAME),
      email_claim: text(str("email_claim"), DEFAULT_CLAIMS.email),
      name_claim: text(str("name_claim"), DEFAULT_CLAIMS.name),
      groups_claim: text(str("groups_claim"), DEFAULT_CLAIMS.groups),
      allowed_subs: list("allowed_subs"),
      allowed_groups: list("allowed_groups"),
      allowed_emails: list("allowed_emails", true),
      allowed_domains: list("allowed_domains", true),
      admin_subs: list("admin_subs"),
      admin_emails: list("admin_emails", true),
      allow_any: record.allow_any === true,
      allow_http_issuer: record.allow_http_issuer === true,
      insecure_http: record.insecure_http === true,
      pkce: record.pkce === "required" || record.pkce === "off" ? record.pkce : "auto",
      nonce: record.nonce === "best_effort" || record.nonce === "off" ? record.nonce : "required",
    },
  };
}

/** 存储里有没有这条记录（含墓碑）：用来判断该不该继续用环境变量当种子。 */
export function hasStoredOidcProvider(storage: AuthProviderStorage): boolean {
  return storage.getAppMeta(OIDC_PROVIDER_META_KEY) !== null;
}

function effectiveDiscoveryUrl(issuer: string, discoveryUrl: string): string {
  return discoveryUrl !== "" ? discoveryUrl : `${issuer}/.well-known/openid-configuration`;
}

/** 每个对外地址各一个回调，外加显式登记的（兼容反代改写路径）。与部署期同一套规则。 */
function callbackUrlsFor(publicWebUrls: string[], explicit: string[]): string[] {
  const out: string[] = [];
  const push = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed !== "" && !out.includes(trimmed)) out.push(trimmed);
  };
  for (const item of explicit) push(item);
  for (const origin of publicWebUrls) push(`${origin}/api/auth/callback`);
  return out;
}

/**
 * 库内记录 → 可直接交给 `AdminAuth` 的 `OidcConfig`。
 *
 * `publicWebUrls` 来自部署（对外地址是部署事实，不是应用配置），用来生成回调白名单。
 * secret 解不开时返回 null 并告警：坏配置不能挡住宿主启动，也不能悄悄放行。
 */
export function oidcConfigFromStored(
  stored: StoredOidcProvider,
  secrets: AuthProviderSecrets,
  publicWebUrls: string[],
): OidcConfig | null {
  let clientSecret: string;
  try {
    clientSecret = secrets.decrypt(stored.client_secret_ciphertext);
  } catch (error) {
    console.warn(
      `读取库内 OIDC 配置失败（secret 解不开）：${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
  if (clientSecret === "") return null;
  const envPublic = publicWebUrls.filter((item) => item !== "");
  const redirectUrls = callbackUrlsFor(envPublic, stored.redirect_urls);
  return {
    issuer: stored.issuer,
    discoveryUrl: effectiveDiscoveryUrl(stored.issuer, stored.discovery_url),
    clientId: stored.client_id,
    clientSecret,
    scopes: stored.scopes,
    redirectUrl: redirectUrls[0] ?? "",
    redirectUrls,
    displayName: stored.display_name,
    emailClaim: stored.email_claim,
    nameClaim: stored.name_claim,
    groupsClaim: stored.groups_claim,
    allowedSubs: stored.allowed_subs,
    allowedGroups: stored.allowed_groups,
    allowedEmails: stored.allowed_emails,
    allowedDomains: stored.allowed_domains,
    adminSubs: stored.admin_subs,
    adminEmails: stored.admin_emails,
    allowAny: stored.allow_any,
    allowHttpIssuer: stored.allow_http_issuer,
    insecureHttp: stored.insecure_http,
    pkce: stored.pkce,
    nonce: stored.nonce,
    signingAlgs: ["RS256"],
    source: "stored",
  };
}

/**
 * 启动时把库内配置套到 `AdminAuth` 上。
 *
 * - 没有库内记录：不动（环境变量种子照旧生效）；
 * - 墓碑：OIDC 关掉，不回落环境变量（管理员点过「移除」就是真移除）；
 * - 记录损坏 / secret 解不开：同样关掉并告警，绝不带病放行。
 *
 * 返回给宿主的信息只用于日志，不参与登录。
 */
export function applyStoredOidcOnStartup(
  auth: {
    config: { oidc: OidcConfig | null; publicWebUrls: string[] };
    applyOidcConfig(next: OidcConfig | null): void;
  },
  storage: AuthProviderStorage,
  secrets: AuthProviderSecrets,
): { source: "stored" | "env" | "tombstone" | "invalid" } {
  // v1 originally held only policy overrides; migrate that exact legacy shape
  // using deployment credentials, without falling back for malformed full records.
  const raw = storage.getAppMeta(OIDC_PROVIDER_META_KEY);
  let legacy: Record<string, unknown> | null = null;
  try {
    const value = raw === null ? null : JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) legacy = value;
  } catch { /* parseStored handles invalid JSON below */ }
  const lists = ["allowed_subs", "allowed_groups", "allowed_emails", "allowed_domains", "admin_subs", "admin_emails"];
  const keys = [...lists, "scopes", "display_name", "allow_any"];
  const env = auth.config.oidc;
  if (env && legacy && Object.keys(legacy).every(key => keys.includes(key)) &&
      typeof legacy.scopes === "string" && legacy.scopes.split(/\s+/).includes("openid") &&
      typeof legacy.display_name === "string" && typeof legacy.allow_any === "boolean" &&
      lists.every(key => Array.isArray(legacy![key]) && (legacy![key] as unknown[]).every(item => typeof item === "string")) &&
      (legacy.allow_any || lists.slice(0, 4).some(key => (legacy![key] as string[]).some(item => item.trim())))) {
    const migrated = {
      ...legacy, generation: 1, issuer: env.issuer, discovery_url: env.discoveryUrl,
      redirect_urls: env.redirectUrls, client_id: env.clientId,
      client_secret_ciphertext: secrets.encrypt(env.clientSecret),
      email_claim: env.emailClaim, name_claim: env.nameClaim, groups_claim: env.groupsClaim,
      allow_http_issuer: env.allowHttpIssuer, insecure_http: env.insecureHttp,
      pkce: env.pkce, nonce: env.nonce,
    };
    storage.setAppMeta(OIDC_PROVIDER_META_KEY, JSON.stringify(migrated));
  }
  const parsed = parseStored(storage.getAppMeta(OIDC_PROVIDER_META_KEY));
  if (parsed.kind === "none") return { source: "env" };
  if (parsed.kind === "tombstone") {
    auth.applyOidcConfig(null);
    return { source: "tombstone" };
  }
  if (parsed.kind === "invalid") {
    console.warn("库内 OIDC 配置无法解析，已停用 OIDC 登录；请在「设置 → 登录与访问」重新配置");
    auth.applyOidcConfig(null);
    return { source: "invalid" };
  }
  const config = oidcConfigFromStored(parsed.value, secrets, auth.config.publicWebUrls);
  if (config === null) {
    console.warn("库内 OIDC secret 解不开，已停用 OIDC 登录；请在「设置 → 登录与访问」重新填写");
    auth.applyOidcConfig(null);
    return { source: "invalid" };
  }
  auth.applyOidcConfig(config);
  return { source: "stored" };
}

/** 环境变量种子（`FLOWLET_OIDC_*` 解析后的 `OidcConfig`）→ 管理台视图。 */
function summaryFromEnv(env: OidcConfig): OidcProviderSummary {
  return {
    configured: true,
    source: "env",
    issuer: env.issuer,
    // 与 issuer 推出来的默认地址一致时不重复展示（std 的 http issuer + https discovery 会显式给出）
    discovery_url: env.discoveryUrl === effectiveDiscoveryUrl(env.issuer, "")
      ? ""
      : env.discoveryUrl,
    client_id: env.clientId,
    display_name: env.displayName,
    scopes: env.scopes,
    redirect_urls: [],
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
    generation: 0,
  };
}

function summaryFromStored(stored: StoredOidcProvider): OidcProviderSummary {
  return {
    configured: true,
    source: "stored",
    issuer: stored.issuer,
    discovery_url: stored.discovery_url,
    client_id: stored.client_id,
    display_name: stored.display_name,
    scopes: stored.scopes,
    redirect_urls: stored.redirect_urls,
    email_claim: stored.email_claim,
    name_claim: stored.name_claim,
    groups_claim: stored.groups_claim,
    allowed_subs: stored.allowed_subs,
    allowed_groups: stored.allowed_groups,
    allowed_emails: stored.allowed_emails,
    allowed_domains: stored.allowed_domains,
    admin_subs: stored.admin_subs,
    admin_emails: stored.admin_emails,
    allow_any: stored.allow_any,
    allow_http_issuer: stored.allow_http_issuer,
    insecure_http: stored.insecure_http,
    pkce: stored.pkce,
    nonce: stored.nonce,
    secret_set: stored.client_secret_ciphertext !== "",
    generation: stored.generation,
  };
}

const EMPTY_SUMMARY: OidcProviderSummary = {
  configured: false,
  source: "none",
  issuer: "",
  discovery_url: "",
  client_id: "",
  display_name: DEFAULT_DISPLAY_NAME,
  scopes: "openid",
  redirect_urls: [],
  email_claim: DEFAULT_CLAIMS.email,
  name_claim: DEFAULT_CLAIMS.name,
  groups_claim: DEFAULT_CLAIMS.groups,
  allowed_subs: [],
  allowed_groups: [],
  allowed_emails: [],
  allowed_domains: [],
  admin_subs: [],
  admin_emails: [],
  allow_any: false,
  allow_http_issuer: false,
  insecure_http: false,
  pkce: "auto",
  nonce: "required",
  secret_set: false,
  generation: 0,
};

/**
 * 管理台展示用的 OIDC 摘要：库内 > 环境变量种子 > 空表单。
 *
 * 库内墓碑记录不回落到环境变量——那是「已移除」的标记。
 */
export function readOidcProviderSummary(
  storage: AuthProviderStorage,
  envConfig: OidcConfig | null,
): OidcProviderSummary {
  const parsed = parseStored(storage.getAppMeta(OIDC_PROVIDER_META_KEY));
  if (parsed.kind === "ok") return summaryFromStored(parsed.value);
  if (parsed.kind === "tombstone" || parsed.kind === "invalid") {
    return { ...EMPTY_SUMMARY, allowed_subs: [], admin_subs: [] };
  }
  if (envConfig !== null) return summaryFromEnv(envConfig);
  return { ...EMPTY_SUMMARY };
}

/** 保存结果：新的运行配置 + 供调用方热替换 / 写日志的信息。 */
export interface OidcSaveResult {
  config: OidcConfig;
  generation: number;
  /** 是否顺手把校验时探测到的端点写进了库（`adopt_endpoints`）。 */
  adoptedEndpoints: boolean;
}

/**
 * 校验并写库，返回可直接交给 `AdminAuth.applyOidcConfig()` 的配置。
 *
 * 规则：
 * - `issuer` / `client_id` / `client_secret` 必填（secret 留空表示沿用已存的）；
 * - 未勾「允许任何人登录」时准入必须非空（管理台能读全部服务凭据，fail-closed）；
 * - http issuer 必须显式确认（与服务端校验同一把锁）；
 * - 传了 `generation` 且与库内不一致时拒绝覆盖（另一个标签页先改过了）。
 */
export function saveOidcProvider(
  storage: AuthProviderStorage,
  secrets: AuthProviderSecrets,
  input: OidcProviderInput,
  options: { envConfig: OidcConfig | null; publicWebUrls: string[]; discovery?: DiscoveryHints | null },
): OidcSaveResult {
  const previous = parseStored(storage.getAppMeta(OIDC_PROVIDER_META_KEY));
  const stored = previous.kind === "ok" ? previous.value : null;
  const currentGeneration = stored?.generation ?? 0;
  if (typeof input.generation === "number" && input.generation !== currentGeneration) {
    throw new Error("配置已被其它窗口修改，请刷新后重试");
  }

  const issuerRaw = text(input.issuer, stored?.issuer ?? options.envConfig?.issuer ?? "");
  if (issuerRaw === "") {
    throw new Error("必须填写 issuer（公司 GitLab 地址，例如 http://git.example.com）");
  }
  const issuer = normalizeIssuer(issuerRaw);
  const clientId = text(input.client_id, stored?.client_id ?? options.envConfig?.clientId ?? "");
  if (clientId === "") throw new Error("Application ID 不能为空");

  const incomingSecret = (input.client_secret ?? "").trim();
  let ciphertext: string;
  if (incomingSecret !== "") {
    ciphertext = secrets.encrypt(incomingSecret);
  } else if (stored !== null) {
    ciphertext = stored.client_secret_ciphertext;
  } else if (options.envConfig !== null && options.envConfig.clientSecret !== "") {
    // 从环境变量接管：secret 只在部署密钥里，管理员不该为了这件事重新贴一遍。
    ciphertext = secrets.encrypt(options.envConfig.clientSecret);
  } else {
    throw new Error("Application Secret 不能为空");
  }

  const allowedSubs = cleanList(input.allowed_subs);
  const allowedGroups = cleanList(input.allowed_groups);
  const allowedEmails = cleanList(input.allowed_emails, true);
  const allowedDomains = cleanList(input.allowed_domains, true);
  const allowAny = input.allow_any === true;
  if (!allowAny && allowedSubs.length + allowedGroups.length + allowedEmails.length + allowedDomains.length === 0) {
    throw new Error("必须至少配置一种准入（用户 ID / 组 / 邮箱 / 邮箱域），或显式允许任何人登录");
  }

  const allowHttpIssuer = input.allow_http_issuer === true;
  const insecureHttp = input.insecure_http === true || stored?.insecure_http === true;
  const issuerIsHttps = issuer.startsWith("https://");
  if (!issuerIsHttps && !allowHttpIssuer && !insecureHttp) {
    throw new Error(
      "issuer 不是 https：请勾选「允许 http issuer」（旧自建 GitLab）。只有你明确确认过内网链路时才这样做",
    );
  }

  // discovery 地址：显式填写就原样存；只填了 issuer 且刚刚校验通过，就把校验到的
  // issuer / 端点一并接管，免得上线后第一次登录才发现「issuer 与 discovery 不一致」。
  let discoveryUrl = text(input.discovery_url, "");
  let adoptedEndpoints = false;
  if (discoveryUrl === "" && options.discovery != null) {
    const hinted = options.discovery;
    if (hinted.issuer != null && normalizeIssuer(hinted.issuer) !== issuer) {
      throw new Error(
        `issuer 与 discovery 声明的 issuer 不一致：配置 ${issuer}，discovery 声明 ${hinted.issuer}`,
      );
    }
    adoptedEndpoints = hinted.discoveryUrl != null && hinted.discoveryUrl !== "";
    discoveryUrl = hinted.discoveryUrl ?? "";
  }
  discoveryUrl = discoveryUrl === "" ? "" : normalizeEndpoint(discoveryUrl, "");

  const storedScopes = stored?.scopes ?? options.envConfig?.scopes ?? "openid";
  const scopes = text(input.scopes, storedScopes);
  if (!scopes.split(/\s+/).includes("openid")) {
    throw new Error("scopes 必须包含 openid（否则拿不到 id_token，无法确认登录者身份）");
  }

  const redirectUrls = cleanList(input.redirect_urls).map((item) => {
    if (!/^https?:\/\//i.test(item)) throw new Error(`回调地址必须带 http/https：${item}`);
    return item.replace(/\/+$/, "");
  });

  const next: StoredOidcProvider = {
    generation: currentGeneration + 1,
    issuer,
    discovery_url: discoveryUrl,
    redirect_urls: redirectUrls,
    client_id: clientId,
    client_secret_ciphertext: ciphertext,
    scopes,
    display_name: text(input.display_name, stored?.display_name ?? DEFAULT_DISPLAY_NAME),
    email_claim: text(input.email_claim, DEFAULT_CLAIMS.email),
    name_claim: text(input.name_claim, DEFAULT_CLAIMS.name),
    groups_claim: text(input.groups_claim, DEFAULT_CLAIMS.groups),
    allowed_subs: allowedSubs,
    allowed_groups: allowedGroups,
    allowed_emails: allowedEmails,
    allowed_domains: allowedDomains,
    admin_subs: cleanList(input.admin_subs),
    admin_emails: cleanList(input.admin_emails, true),
    allow_any: allowAny,
    allow_http_issuer: allowHttpIssuer,
    insecure_http: insecureHttp,
    pkce: parsePkce(input.pkce ?? stored?.pkce ?? null),
    nonce: parseNonce(input.nonce ?? stored?.nonce ?? null),
  };
  storage.setAppMeta(OIDC_PROVIDER_META_KEY, JSON.stringify(next));
  const config = oidcConfigFromStored(next, secrets, options.publicWebUrls);
  if (config === null) throw new Error("保存后无法解密 Application Secret，请重新填写");
  return { config, generation: next.generation, adoptedEndpoints };
}

/** 点过「移除」：写墓碑。之后既不回落环境变量，也不会在重启后被悄悄拉起来。 */
export function deleteOidcProvider(storage: AuthProviderStorage): void {
  storage.setAppMeta(OIDC_PROVIDER_META_KEY, JSON.stringify({ deleted: true }));
}

/** 当前角色判据的中文说明（界面直接展示，避免「不填管理员就都是管理员」这种误解）。 */
export function describeRolePolicy(summary: Pick<OidcProviderSummary, "admin_subs" | "admin_emails">): string {
  return summary.admin_subs.length + summary.admin_emails.length > 0
    ? "管理员名单生效：命中者是管理员，其余可登录者只读"
    : "未单独指定管理员：直接列入「可登录」的个人是管理员，按组/域进来的只读";
}

/** 用摘要预测某个身份的角色（仅用于测试与界面说明，不参与登录判权）。 */
export function roleForSummary(
  summary: Pick<OidcProviderSummary, "allowed_subs" | "allowed_groups" | "allowed_emails" | "allowed_domains" | "admin_subs" | "admin_emails" | "allow_any">,
  identity: { sub: string; email: string | null; groups: string[] },
): IdentityRole | "denied" {
  const email = (identity.email ?? "").toLowerCase();
  const allowed =
    summary.allow_any ||
    summary.allowed_subs.includes(identity.sub) ||
    summary.allowed_groups.some((item) => identity.groups.includes(item)) ||
    (email !== "" && summary.allowed_emails.some((item) => item.toLowerCase() === email)) ||
    (email !== "" && summary.allowed_domains.some((item) => item.toLowerCase() === email.slice(email.lastIndexOf("@") + 1)));
  if (!allowed) return "denied";
  const hasAdminList = summary.admin_subs.length + summary.admin_emails.length > 0;
  if (hasAdminList) {
    return summary.admin_subs.includes(identity.sub) ||
      (email !== "" && summary.admin_emails.some((item) => item.toLowerCase() === email))
      ? "admin"
      : "viewer";
  }
  return summary.allowed_subs.includes(identity.sub) ||
    (email !== "" && summary.allowed_emails.some((item) => item.toLowerCase() === email))
    ? "admin"
    : "viewer";
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
      /* 落库内容坏了按环境推断 */
    }
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
 * 校验 issuer / discovery / client 凭据是否可用（不要求先登录）。
 *
 * 逐条返回结果，界面按条展示：
 * - discovery 能取到，且 `issuer` 与配置一致；
 * - authorization / token / jwks 端点存在且是 https（或显式允许 http）；
 * - GitLab 等标准 OIDC 对无效授权码返回 `invalid_grant` → 说明 IdP 认了这对 client；
 *   `invalid_client` / 401 才是凭据不对；
 * - 没有声明 PKCE S256 时给警告（PKCE=required 会直接拒绝登录）；
 * - 回调地址能否在 GitLab 应用里登记只能由人核对，这里给出可复制清单。
 */
export async function checkOidcProvider(
  input: {
    issuer: string;
    discoveryUrl: string;
    clientId: string;
    clientSecret: string;
    insecureHttp: boolean;
    redirectUrls?: string[];
    pkce?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<OidcCheckResult> {
  const items: OidcCheckItem[] = [];
  const rawIssuer = input.issuer.trim();
  const issuer = rawIssuer.replace(/\/+$/, "");
  if (issuer === "") {
    return {
      ok: false,
      message: "请先填写 issuer",
      items: [{ key: "issuer", status: "error", message: "issuer 为空" }],
    };
  }
  const allowHttp = input.insecureHttp || issuer.startsWith("http://");
  if (!/^https?:\/\//i.test(issuer)) {
    items.push({ key: "issuer", status: "error", message: `issuer 不是合法 URL：${issuer}` });
    return { ok: false, message: "issuer 不是合法 URL", items };
  }
  items.push({
    key: "issuer",
    status: allowHttp && !issuer.startsWith("https://") ? "warning" : "ok",
    message: allowHttp && !issuer.startsWith("https://")
      ? `issuer 使用 http：${issuer}（内网可用，公网入口务必改 https）`
      : `issuer：${issuer}`,
  });

  const discoveryUrl = effectiveDiscoveryUrl(issuer, input.discoveryUrl.trim());
  let doc: Record<string, unknown>;
  try {
    const response = await fetchImpl(discoveryUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      items.push({ key: "discovery", status: "error", message: `discovery 返回 HTTP ${response.status}（${discoveryUrl}）` });
      return { ok: false, message: "discovery 不可用", items };
    }
    const parsed: unknown = await response.json();
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      items.push({ key: "discovery", status: "error", message: "discovery 响应不是 JSON 对象" });
      return { ok: false, message: "discovery 响应不合法", items };
    }
    doc = parsed as Record<string, unknown>;
  } catch (error) {
    items.push({
      key: "discovery",
      status: "error",
      message: `连不上 ${discoveryUrl}：${error instanceof Error ? error.message : String(error)}。请确认 Flowlet 容器能访问到 GitLab`,
    });
    return { ok: false, message: "discovery 不可达", items };
  }

  const docIssuer = typeof doc.issuer === "string" ? doc.issuer : "";
  if (docIssuer !== "" && docIssuer.replace(/\/+$/, "") !== issuer) {
    items.push({
      key: "discovery",
      status: "error",
      message: `issuer 不一致：配置 ${issuer}，discovery 声明 ${docIssuer}（issuer 必须逐字一致）`,
    });
    return { ok: false, message: "issuer 不一致", items };
  }
  items.push({ key: "discovery", status: "ok", message: `discovery 可用：${discoveryUrl}` });

  const authorizationEndpoint = typeof doc.authorization_endpoint === "string" ? doc.authorization_endpoint : "";
  const tokenEndpoint = typeof doc.token_endpoint === "string" ? doc.token_endpoint : "";
  const jwksUri = typeof doc.jwks_uri === "string" ? doc.jwks_uri : "";
  let endpointsOk = true;
  for (const [name, value] of [
    ["authorization_endpoint", authorizationEndpoint],
    ["token_endpoint", tokenEndpoint],
    ["jwks_uri", jwksUri],
  ] as const) {
    if (value === "") {
      endpointsOk = false;
      items.push({ key: "endpoints", status: "error", message: `discovery 缺少 ${name}` });
    } else if (!value.startsWith("https://") && !(allowHttp && value.startsWith("http://"))) {
      endpointsOk = false;
      items.push({ key: "endpoints", status: "error", message: `${name} 不是 https：${value}` });
    }
  }
  if (endpointsOk) {
    items.push({ key: "endpoints", status: "ok", message: "授权 / token / JWKS 端点齐全" });
  }

  const methods = Array.isArray(doc.code_challenge_methods_supported)
    ? (doc.code_challenge_methods_supported as unknown[]).map((item) => String(item))
    : [];
  const pkceSupported = methods.includes("S256");
  items.push({
    key: "pkce",
    status: pkceSupported ? "ok" : input.pkce === "required" ? "error" : "warning",
    message: pkceSupported
      ? "IdP 支持 PKCE S256"
      : "IdP 未声明 PKCE S256；PKCE 选 required 时登录会被拒绝",
  });

  const redirectList = input.redirectUrls ?? [];
  items.push({
    key: "redirect",
    status: "ok",
    message: redirectList.length > 0
      ? `回调地址（${redirectList.length} 个）需要在 GitLab 应用的 Redirect URI 里逐字登记：${redirectList.join("，")}`
      : "回调地址需要在 GitLab 应用里逐字登记（见下方「回调地址」）",
  });

  if (input.clientId.trim() === "" || input.clientSecret === "") {
    items.push({ key: "client", status: "warning", message: "未填 Application 凭据，跳过凭据校验" });
    const ok = items.every((item) => item.status !== "error");
    return { ok, message: ok ? "discovery 可用（凭据未校验）" : "配置有问题", items, authorization_endpoint: authorizationEndpoint, token_endpoint: tokenEndpoint };
  }

  // 与 GitHub 校验同一思路：拿一个无效 code 打 token 端点，看 IdP 是「认」还是「不认」这对 client。
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: "flowlet-connectivity-check",
      client_id: input.clientId.trim(),
      client_secret: input.clientSecret,
      redirect_uri: redirectList[0] ?? "urn:flowlet:oauth-check",
    });
    const response = await fetchImpl(tokenEndpoint, {
      method: "POST",
      redirect: "manual",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(20000),
    });
    const raw = await response.text();
    let errorCode = "";
    let errorDescription = "";
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        errorCode = typeof record.error === "string" ? record.error : "";
        errorDescription = typeof record.error_description === "string" ? record.error_description : "";
      }
    } catch {
      /* 非 JSON：只看状态码 */
    }
    if (errorCode === "invalid_client" || response.status === 401) {
      items.push({
        key: "client",
        status: "error",
        message: `GitLab 判定 Application ID / Secret 不匹配（invalid_client${errorDescription ? `：${errorDescription}` : ""}）`,
      });
    } else if (response.status >= 500) {
      items.push({ key: "client", status: "error", message: `token 端点异常：HTTP ${response.status}` });
    } else if (response.ok) {
      items.push({ key: "client", status: "ok", message: "token 端点接受这对凭据（异常地返回了 token）" });
    } else {
      items.push({
        key: "client",
        status: "ok",
        message: `凭据有效：token 端点以 ${errorCode || `HTTP ${response.status}`} 拒绝了无效授权码（这是预期结果）`,
      });
    }
  } catch (error) {
    items.push({
      key: "client",
      status: "error",
      message: `连不上 token 端点 ${tokenEndpoint}：${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const ok = items.every((item) => item.status !== "error");
  const warnings = items.filter((item) => item.status === "warning").length;
  return {
    ok,
    message: ok
      ? warnings > 0
        ? `校验通过（${warnings} 条提示）`
        : "校验通过"
      : "校验未通过，请按下面的条目修正",
    items,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
  };
}

/** 从校验结果里取出端点提示，供 `saveOidcProvider` 接管 discovery 地址。 */
export function discoveryHintsFromCheck(
  result: OidcCheckResult,
  discoveryUrl: string,
): DiscoveryHints | null {
  if (!result.items.some((item) => item.key === "discovery" && item.status === "ok")) return null;
  return {
    discoveryUrl: discoveryUrl.trim() === "" ? undefined : discoveryUrl.trim(),
    authorizationEndpoint: result.authorization_endpoint,
    tokenEndpoint: result.token_endpoint,
  };
}
