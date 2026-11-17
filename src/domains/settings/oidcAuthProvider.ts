/** 管理台登录提供方（OIDC / 自建 GitLab）与「启用哪些登录方式」的命令封装。
 *
 * 只有 Web Host 有「管理员自己配登录方式」这件事（桌面壳走本地单用户，不存在登录页），
 * 所以这个模块只在 Web Host 下被渲染，命令也只由 Node Host 实现。
 */
import { invokeCommand, toAppError } from "../../platform/host/client";

/** 与 Node Host 的 `get_oidc_auth_provider` 返回一致；**不含 secret**。 */
export type OidcProviderSummary = {
  configured: boolean;
  /** `stored` = 管理台里配过；`env` = 沿用了部署环境变量；`none` = 都没有。 */
  source: "stored" | "env" | "none";
  issuer: string;
  /** 留空表示按 issuer 推导标准 discovery 地址。 */
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
  /** 库内记录版本；用于防止两个窗口互相覆盖。 */
  generation: number;
};

export type OidcProviderInput = {
  issuer?: string;
  discovery_url?: string;
  client_id?: string;
  /** 留空表示「沿用已保存的 secret」。 */
  client_secret?: string;
  scopes?: string;
  redirect_urls?: string[];
  display_name?: string;
  email_claim?: string;
  name_claim?: string;
  groups_claim?: string;
  allowed_subs?: string[];
  allowed_groups?: string[];
  allowed_emails?: string[];
  allowed_domains?: string[];
  admin_subs?: string[];
  admin_emails?: string[];
  allow_any?: boolean;
  allow_http_issuer?: boolean;
  insecure_http?: boolean;
  pkce?: string;
  nonce?: string;
  generation?: number;
};

export type OidcCheckItem = {
  key: "issuer" | "discovery" | "endpoints" | "client" | "pkce" | "redirect";
  status: "ok" | "warning" | "error";
  message: string;
};

export type OidcCheckResult = {
  ok: boolean;
  message: string;
  items: OidcCheckItem[];
  discovery_url?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
};

export type OidcSaveResult = { generation: number; adopted_endpoints: boolean };

export type LoginProviderId = "oidc" | "github";

export type AdminLoginMode = {
  enabled: LoginProviderId[];
  /** `stored` = 管理台里设过；`env` = 按部署环境推断。 */
  source: "stored" | "env" | "none";
  oidc_configured: boolean;
  github_configured: boolean;
  token_login: boolean;
};

export async function getOidcAuthProvider(): Promise<OidcProviderSummary> {
  try {
    return await invokeCommand<OidcProviderSummary>("get_oidc_auth_provider");
  } catch (error) {
    throw toAppError(error, "auth_provider_read_failed");
  }
}

export async function saveOidcAuthProvider(input: OidcProviderInput): Promise<OidcSaveResult> {
  try {
    return await invokeCommand<OidcSaveResult>("set_oidc_auth_provider", { ...input });
  } catch (error) {
    throw toAppError(error, "auth_provider_save_failed");
  }
}

export async function deleteOidcAuthProvider(): Promise<void> {
  try {
    await invokeCommand<void>("delete_oidc_auth_provider");
  } catch (error) {
    throw toAppError(error, "auth_provider_delete_failed");
  }
}

export async function checkOidcAuthProvider(input: OidcProviderInput): Promise<OidcCheckResult> {
  try {
    return await invokeCommand<OidcCheckResult>("check_oidc_auth_provider", { ...input });
  } catch (error) {
    throw toAppError(error, "auth_provider_check_failed");
  }
}

export async function getAdminLoginMode(): Promise<AdminLoginMode> {
  try {
    return await invokeCommand<AdminLoginMode>("get_admin_login_mode");
  } catch (error) {
    throw toAppError(error, "auth_provider_read_failed");
  }
}

export async function saveAdminLoginMode(enabled: LoginProviderId[]): Promise<void> {
  try {
    await invokeCommand<void>("set_admin_login_mode", { enabled: [...enabled] });
  } catch (error) {
    throw toAppError(error, "auth_provider_save_failed");
  }
}
