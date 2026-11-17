/** Instance access policy. Provider configuration never owns admission or roles. */
import type { SqliteStorage } from "../storage/index.ts";
import type { UserDirectory } from "./users.ts";
import { allowlisted, githubAllowlisted, roleForGithub, roleForOidc, type AdminAuthConfig, type Identity, type OidcConfig, type GithubConfig } from "./auth.ts";
export const ACCESS_POLICY_KEY = "auth_access_policy_v1";
interface LegacyRule { issuer: string; kind: "oidc" | "github"; values: Record<string, unknown> }
export interface AccessPolicy { generation: number; mode: "existing" | "rules" | "all"; emails: string[]; domains: string[]; legacyRules: LegacyRule[] }
const OIDC_FIELDS = ["allowedSubs", "allowedGroups", "allowedEmails", "allowedDomains", "adminSubs", "adminEmails", "allowAny"];
const GITHUB_FIELDS = ["allowedLogins", "allowedEmails", "allowedOrgs", "adminLogins", "adminEmails", "allowAny"];
export class AccessPolicyStore {
  private storage: SqliteStorage;
  private users: UserDirectory;
  constructor(storage: SqliteStorage, users: UserDirectory, config: AdminAuthConfig) {
    this.storage = storage; this.users = users;
    if (storage.getAppMeta(ACCESS_POLICY_KEY) === null) {
      const legacyRules: LegacyRule[] = [];
      if (config.oidc) legacyRules.push({issuer:config.oidc.issuer,kind:"oidc",values:Object.fromEntries(OIDC_FIELDS.map(key=>[key,(config.oidc as unknown as Record<string,unknown>)[key]]))});
      if (config.github) legacyRules.push({issuer:config.github.apiBase,kind:"github",values:Object.fromEntries(GITHUB_FIELDS.map(key=>[key,(config.github as unknown as Record<string,unknown>)[key]]))});
      users.security.transaction(() => { if (storage.getAppMeta(ACCESS_POLICY_KEY) === null) storage.setAppMeta(ACCESS_POLICY_KEY,JSON.stringify({generation:1,mode:legacyRules.length?"rules":"existing",emails:[],domains:[],legacyRules})); });
    }
    this.read();
  }
  read(): AccessPolicy {
    const value=JSON.parse(this.storage.getAppMeta(ACCESS_POLICY_KEY) ?? "null") as AccessPolicy;
    if (!value || !["existing","rules","all"].includes(value.mode) || !Number.isInteger(value.generation) || !Array.isArray(value.emails) || !Array.isArray(value.domains) || [...value.emails,...value.domains].some(item=>typeof item!=="string") || !Array.isArray(value.legacyRules)) throw new Error("实例访问策略无效");
    for (const rule of value.legacyRules) {
      if (!rule || typeof rule.issuer!=="string" || !["oidc","github"].includes(rule.kind) || !rule.values) throw new Error("旧访问规则无效");
      for (const field of rule.kind==="oidc"?OIDC_FIELDS:GITHUB_FIELDS) {
        const item=rule.values[field];
        if (field==="allowAny" ? typeof item!=="boolean" : !Array.isArray(item)||item.some(x=>typeof x!=="string")) throw new Error("旧访问规则无效");
      }
    }
    return value;
  }
  save(input: Record<string,unknown>): AccessPolicy {
    return this.users.security.transaction(()=>{
      const previous=this.read();
      if(input.generation!==previous.generation) throw new Error("访问策略已变更，请刷新后重试");
      if(!["existing","rules","all"].includes(String(input.mode))) throw new Error("登录准入模式无效");
      const list=(key:string)=>{
        const raw=input[key];if(!Array.isArray(raw)||raw.some(x=>typeof x!=="string"))throw new Error("邮箱与域名必须为列表");
        return [...new Set((raw as string[]).map(x=>x.trim().toLowerCase()).filter(Boolean))];
      };
      const emails=list("emails"),domains=list("domains");
      if(emails.some(x=>!/^\S+@[^\s@]+$/.test(x))||domains.some(x=>!/^([a-z0-9-]+\.)*[a-z0-9-]+$/.test(x)))throw new Error("邮箱或域名格式无效");
      const next:AccessPolicy={generation:previous.generation+1,mode:input.mode as AccessPolicy["mode"],emails,domains,legacyRules:input.clearLegacy===true?[]:previous.legacyRules};
      this.storage.setAppMeta(ACCESS_POLICY_KEY,JSON.stringify(next));return next;
    });
  }
  needsGithubGroups(issuer: string): boolean {
    const policy = this.read();
    return policy.mode !== "existing" && policy.legacyRules.some(rule => rule.kind === "github" && rule.issuer === issuer && (rule.values.allowedOrgs as string[]).length > 0);
  }
  admit(identity: Identity): {allowed:boolean;role:"admin"|"viewer"} {
    const existing=this.users.resolve(identity);
    if(existing)return {allowed:existing.enabled,role:existing.role};
    const policy=this.read();
    if(policy.mode==="existing")return {allowed:false,role:"viewer"};
    const email=identity.emailVerified?identity.email?.trim().toLowerCase():null;
    const rule=policy.legacyRules.find(rule=>rule.issuer===identity.identityIssuer && (rule.kind==="oidc"?allowlisted(rule.values as unknown as OidcConfig,identity):githubAllowlisted(rule.values as unknown as GithubConfig,identity)));
    const allowed=policy.mode==="all" || Boolean(email&&(policy.emails.includes(email)||policy.domains.includes(email.split("@")[1]))) || Boolean(rule);
    const role=rule ? rule.kind==="oidc"?roleForOidc(rule.values as unknown as OidcConfig,identity):roleForGithub(rule.values as unknown as GithubConfig,identity):"viewer";
    return {allowed,role};
  }
}
