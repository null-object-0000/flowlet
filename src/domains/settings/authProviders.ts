/** 管理台登录提供方（GitHub）设置的命令封装。
 *
 * 只有 Web Host 有「管理员自己配 OAuth」这件事（桌面壳走本地单用户，不存在登录页），
 * 所以这个模块只在 Web Host 下被渲染，命令也只由 Node Host 实现。
 */
import { invokeCommand, toAppError } from "../../platform/tauri/client";

/** 与 Node Host 的 `get_github_auth_provider` 返回一致；**不含 secret**。 */
export type GithubProviderSummary = {
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
};

export type GithubProviderInput = {
  client_id: string;
  /** 留空表示「沿用已保存的 secret」。 */
  client_secret?: string;
  scopes?: string;
  display_name?: string;
  allowed_logins?: string[];
  allowed_emails?: string[];
  allowed_orgs?: string[];
  admin_logins?: string[];
  admin_emails?: string[];
  allow_any?: boolean;
  authorize_url?: string;
  token_url?: string;
  api_base?: string;
};

export type ProviderCheckResult = { ok: boolean; message: string };

export async function getGithubAuthProvider(): Promise<GithubProviderSummary> {
  try {
    return await invokeCommand<GithubProviderSummary>("get_github_auth_provider");
  } catch (error) {
    throw toAppError(error, "auth_provider_read_failed");
  }
}

export async function saveGithubAuthProvider(input: GithubProviderInput): Promise<void> {
  try {
    await invokeCommand<void>("set_github_auth_provider", { ...input });
  } catch (error) {
    throw toAppError(error, "auth_provider_save_failed");
  }
}

export async function deleteGithubAuthProvider(): Promise<void> {
  try {
    await invokeCommand<void>("delete_github_auth_provider");
  } catch (error) {
    throw toAppError(error, "auth_provider_delete_failed");
  }
}

export async function checkGithubAuthProvider(input: GithubProviderInput): Promise<ProviderCheckResult> {
  try {
    return await invokeCommand<ProviderCheckResult>("check_github_auth_provider", { ...input });
  } catch (error) {
    throw toAppError(error, "auth_provider_check_failed");
  }
}

/** 逗号 / 空格 / 换行分隔的输入拆成数组（空串 → 空数组）。 */
export function splitListInput(value: string): string[] {
  return value
    .split(/[\s,，、;；]+/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}
