// 登录角色（admin / viewer）与只读命令闸门。
//
// 运行：node --test packages/flowlet-core/src/web/__tests__/auth-roles.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  roleForGithub,
  roleForOidc,
  viewerCanRunCommand,
  type GithubConfig,
  type Identity,
  type OidcConfig,
} from "../auth.ts";

function identity(overrides: Partial<Identity> = {}): Identity {
  return {
    sub: "12345",
    email: "me@example.com",
    username: "changen",
    name: "倪常恩",
    groups: [],
    provider: "GitHub",
    ...overrides,
  };
}

function githubConfig(overrides: Partial<GithubConfig> = {}): GithubConfig {
  return {
    clientId: "Ov1",
    clientSecret: "s",
    scopes: "read:user user:email",
    displayName: "GitHub",
    allowedLogins: ["changen", "colleague"],
    allowedEmails: [],
    allowedOrgs: [],
    adminLogins: [],
    adminEmails: [],
    allowAny: false,
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    apiBase: "https://api.github.com",
    ...overrides,
  };
}

const OIDC_BASE: OidcConfig = {
  issuer: "https://idp.example.com",
  discoveryUrl: "https://idp.example.com/.well-known/openid-configuration",
  clientId: "cid",
  clientSecret: "secret",
  scopes: "openid",
  redirectUrl: "http://localhost/api/auth/callback",
  redirectUrls: ["http://localhost/api/auth/callback"],
  displayName: "GitLab",
  emailClaim: "email",
  nameClaim: "name",
  groupsClaim: "groups",
  allowedSubs: [],
  allowedGroups: [],
  allowedEmails: [],
  allowedDomains: [],
  adminSubs: [],
  adminEmails: [],
  allowAny: false,
  allowHttpIssuer: false,
  insecureHttp: false,
  pkce: "auto",
  nonce: "required",
  signingAlgs: ["RS256"],
};

describe("GitHub 角色", () => {
  it("没配管理员名单时，准入者全员 admin（兼容旧配置）", () => {
    assert.equal(roleForGithub(githubConfig(), identity()), "admin");
  });

  it("配了管理员名单后，名单内 admin、名单外 viewer", () => {
    const cfg = githubConfig({ adminLogins: ["changen"] });
    assert.equal(roleForGithub(cfg, identity({ username: "Changen" })), "admin");
    assert.equal(roleForGithub(cfg, identity({ username: "colleague" })), "viewer");
  });

  it("管理员也可以用邮箱命中", () => {
    const cfg = githubConfig({ adminEmails: ["me@example.com"] });
    assert.equal(roleForGithub(cfg, identity()), "admin");
    assert.equal(roleForGithub(cfg, identity({ email: "other@example.com" })), "viewer");
  });
});

describe("OIDC 角色", () => {
  it("没有管理员名单时：sub/邮箱准入者 admin，仅域名准入者 viewer", () => {
    const bySub: OidcConfig = { ...OIDC_BASE, allowedSubs: ["12345"] };
    assert.equal(roleForOidc(bySub, identity()), "admin");

    const byDomain: OidcConfig = { ...OIDC_BASE, allowedDomains: ["example.com"] };
    assert.equal(roleForOidc(byDomain, identity()), "viewer");
  });

  it("有管理员名单时按名单判", () => {
    const cfg: OidcConfig = {
      ...OIDC_BASE,
      allowedSubs: ["12345"],
      allowedDomains: ["example.com"],
      adminSubs: ["99999"],
    };
    assert.equal(roleForOidc(cfg, identity()), "viewer");
    assert.equal(roleForOidc(cfg, identity({ sub: "99999" })), "admin");
  });
});

describe("只读命令闸门", () => {
  it("读类命令放行", () => {
    for (const command of ["list_models", "get_proxy_status", "query_usage", "read_app_meta"]) {
      assert.equal(viewerCanRunCommand(command), true, command);
    }
  });

  it("敏感读命令与写命令一律拦下", () => {
    for (const command of [
      "export_service_credentials",
      "list_service_credentials",
      "get_service_credential",
      "get_github_auth_provider",
      "get_log_capture_config",
      "set_github_auth_provider",
      "delete_github_auth_provider",
      "create_cli_auth_code",
      "list_cli_authorizations",
    ]) {
      assert.equal(viewerCanRunCommand(command), false, command);
    }
  });
});