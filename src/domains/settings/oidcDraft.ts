/** 「登录与访问」的草稿 / 提交逻辑：与渲染分离，便于单测与复用。
 *
 * 规则（与 Node Host 侧一致，这里只做提前提示，最终仍以服务端校验为准）：
 * - 名单按「一行一个」：含 @ 的算邮箱，纯数字算 GitLab 用户 ID，其余按标签处理；
 * - 未开「允许任何人登录」时准入必须非空；
 * - 未启用时也必须能保存（先建好配置、之后再打开）。
 */
import { splitListInput } from "./authProviders";
import type { OidcProviderInput, OidcProviderSummary } from "./oidcAuthProvider";

export type RolePreview = { sub: string; email: string | null; groups: string[] };

export type OidcDraft = {
  enabled: boolean;
  issuer: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  displayName: string;
  scopes: string;
  allowedUsers: string;
  allowedGroups: string;
  allowedDomains: string;
  admins: string;
  allowAny: boolean;
  allowHttpIssuer: boolean;
  pkce: "auto" | "required" | "off";
  nonce: "required" | "best_effort" | "off";
  claims: { email: string; name: string; groups: string };
  redirectUrls: string;
};

export const EMPTY_OIDC_DRAFT: OidcDraft = {
  enabled: false,
  issuer: "",
  discoveryUrl: "",
  clientId: "",
  clientSecret: "",
  displayName: "GitLab",
  scopes: "openid",
  allowedUsers: "",
  allowedGroups: "",
  allowedDomains: "",
  admins: "",
  allowAny: false,
  allowHttpIssuer: false,
  pkce: "auto",
  nonce: "required",
  claims: { email: "email", name: "name", groups: "groups" },
  redirectUrls: "",
};

/** GitLab 的 sub 是纯数字、邮箱一定带 @：严格按行归还，避免「谁能登录」写错人。 */
export function splitSubsAndEmails(value: string): { subs: string[]; emails: string[] } {
  const items = splitListInput(value);
  return {
    subs: items.filter((item) => !item.includes("@")),
    emails: items.filter((item) => item.includes("@")),
  };
}

export function draftFromSummary(
  summary: OidcProviderSummary,
  enabled: boolean,
  callbackOrigin: string,
): OidcDraft {
  return {
    enabled,
    issuer: summary.issuer,
    discoveryUrl: summary.discovery_url,
    clientId: summary.client_id,
    clientSecret: "",
    displayName: summary.display_name || "GitLab",
    scopes: summary.scopes || "openid",
    allowedUsers: [...summary.allowed_subs, ...summary.allowed_emails].join("\n"),
    allowedGroups: summary.allowed_groups.join("\n"),
    allowedDomains: summary.allowed_domains.join("\n"),
    admins: [...summary.admin_subs, ...summary.admin_emails].join("\n"),
    allowAny: summary.allow_any,
    allowHttpIssuer: summary.allow_http_issuer || summary.insecure_http,
    pkce: summary.pkce === "required" || summary.pkce === "off" ? summary.pkce : "auto",
    nonce: summary.nonce === "best_effort" || summary.nonce === "off" ? summary.nonce : "required",
    claims: {
      email: summary.email_claim || "email",
      name: summary.name_claim || "name",
      groups: summary.groups_claim || "groups",
    },
    redirectUrls: summary.redirect_urls.length > 0 ? summary.redirect_urls.join("\n") : `${callbackOrigin}/api/auth/callback`,
  };
}

/** 草稿 → 表单提交体。`generation` 只在接管库内记录时才带，避免误触发乐观锁。 */
export function payloadFromDraft(draft: OidcDraft, generation: number | null): OidcProviderInput {
  const users = splitSubsAndEmails(draft.allowedUsers);
  const admins = splitSubsAndEmails(draft.admins);
  const redirects = splitListInput(draft.redirectUrls);
  return {
    issuer: draft.issuer.trim(),
    discovery_url: draft.discoveryUrl.trim(),
    client_id: draft.clientId.trim(),
    client_secret: draft.clientSecret,
    display_name: draft.displayName.trim() || "GitLab",
    scopes: draft.scopes.trim() || "openid",
    allowed_subs: users.subs,
    allowed_emails: users.emails,
    allowed_groups: splitListInput(draft.allowedGroups),
    allowed_domains: splitListInput(draft.allowedDomains),
    admin_subs: admins.subs,
    admin_emails: admins.emails,
    allow_any: draft.allowAny,
    allow_http_issuer: draft.allowHttpIssuer,
    pkce: draft.pkce,
    nonce: draft.nonce,
    email_claim: draft.claims.email.trim() || "email",
    name_claim: draft.claims.name.trim() || "name",
    groups_claim: draft.claims.groups.trim() || "groups",
    redirect_urls: redirects,
    ...(generation !== null ? { generation } : {}),
  };
}

/** 阻断保存的问题（返回 null 表示可以保存）。 */
export function validateDraft(draft: OidcDraft, hasStoredSecret = false): string | null {
  if (draft.issuer.trim() === "") return "请填写 issuer（公司 GitLab 地址）";
  if (!/^https?:\/\//i.test(draft.issuer.trim())) return "issuer 必须以 http:// 或 https:// 开头";
  if (draft.issuer.trim().startsWith("http://") && !draft.allowHttpIssuer) {
    return "issuer 是 http：请展开「高级设置」勾选「允许 http issuer」";
  }
  if (draft.clientId.trim() === "") return "请填写 GitLab 应用的 Application ID";
  if (draft.clientSecret.trim() === "" && !hasStoredSecret) {
    return "请填写 GitLab 应用的 Application Secret";
  }
  if (!draft.allowAny && splitListInput(draft.allowedUsers).length + splitListInput(draft.allowedGroups).length + splitListInput(draft.allowedDomains).length === 0) {
    return "至少填一个可登录的用户，或打开「允许任何人登录」";
  }
  return null;
}

/**
 * 不阻断保存的提醒：管理员可能靠组/域准入，真实判定在服务端，这里只提醒「可能登不进来」。
 */
export function admissionWarnings(draft: OidcDraft): string[] {
  const admins = splitListInput(draft.admins);
  const allowed = new Set([...splitListInput(draft.allowedUsers), ...splitListInput(draft.allowedGroups)].map((item) => item.toLowerCase()));
  const domains = splitListInput(draft.allowedDomains).map((item) => item.toLowerCase());
  return admins
    .filter((item) => {
      const key = item.toLowerCase();
      return !allowed.has(key) && !domains.some((domain) => key.endsWith(`@${domain}`));
    })
    .map((item) => `管理员「${item}」不在「可登录」个人名单里，也不命中任何可登录组/邮箱域；除非它确实在某个组里，否则保存后仍无法登录。`);
}

/** 判断某个身份按当前草稿能否登录、是什么角色——纯展示用，最终判权在服务端。 */
export function previewRole(draft: OidcDraft, identity: RolePreview): "admin" | "viewer" | "denied" {
  const email = (identity.email ?? "").toLowerCase();
  const allowedUsers = splitSubsAndEmails(draft.allowedUsers);
  const admins = splitSubsAndEmails(draft.admins);
  const groups = splitListInput(draft.allowedGroups);
  const domains = splitListInput(draft.allowedDomains).map((item) => item.toLowerCase());
  const allowed =
    draft.allowAny ||
    allowedUsers.subs.includes(identity.sub) ||
    groups.some((group) => identity.groups.includes(group)) ||
    (email !== "" && allowedUsers.emails.some((item) => item.toLowerCase() === email)) ||
    (email !== "" && domains.some((domain) => email.endsWith(`@${domain}`)));
  if (!allowed) return "denied";
  const hasAdminList = admins.subs.length + admins.emails.length > 0;
  if (hasAdminList) {
    return admins.subs.includes(identity.sub) || (email !== "" && admins.emails.some((item) => item.toLowerCase() === email))
      ? "admin"
      : "viewer";
  }
  return allowedUsers.subs.includes(identity.sub) ||
    (email !== "" && allowedUsers.emails.some((item) => item.toLowerCase() === email))
    ? "admin"
    : "viewer";
}

/** 「这组人」的清单摘要：给卡片展示用，不暴露敏感信息。 */
export function rosterSummary(draft: OidcDraft): { users: number; groups: number; domains: number; admins: number } {
  const users = splitSubsAndEmails(draft.allowedUsers);
  const admins = splitSubsAndEmails(draft.admins);
  return {
    users: users.subs.length + users.emails.length,
    groups: splitListInput(draft.allowedGroups).length,
    domains: splitListInput(draft.allowedDomains).length,
    admins: admins.subs.length + admins.emails.length,
  };
}
