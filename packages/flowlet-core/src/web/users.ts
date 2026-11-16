import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Identity } from "./auth.ts";

export interface ManagedUser {
  id: string; email: string | null; name: string | null;
  identities: string[]; role: "admin" | "viewer"; roleOverride?: boolean;
  enabled: boolean; createdAt: string; lastLoginAt: string;
}
/** Verified email links login identities; stable IDs survive email changes. */
export class UserDirectory {
  private users: ManagedUser[];
  private file: string;
  constructor(file: string) {
    this.file = file;
    this.users = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
    if (!Array.isArray(this.users)) throw new Error("用户目录格式无效");
  }
  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(this.users), { mode: 0o600 });
    renameSync(temp, this.file);
  }
  list() { return structuredClone(this.users); }
  find(id: string) { return this.users.find(user => user.id === id); }
  login(identity: Identity) {
    const key = `${identity.identityIssuer ?? identity.provider}:${identity.sub}`;
    const email = identity.email?.trim().toLowerCase() || null;
    let user = this.users.find(user => user.identities.includes(key));
    if (!user && email && identity.emailVerified) user = this.users.find(user => user.email === email);
    if (!user) {
      user = { id: randomUUID(), email: identity.emailVerified ? email : null, name: identity.name,
        identities: [], role: identity.role ?? "viewer", enabled: true,
        createdAt: new Date().toISOString(), lastLoginAt: new Date().toISOString() };
      this.users.push(user);
    }
    if (!user.enabled) throw new Error("用户已停用");
    if (identity.emailVerified && email && this.users.some(other => other.id !== user!.id && other.email === email)) {
      throw new Error("邮箱已关联其他用户，请联系管理员");
    }
    if (!user.identities.includes(key)) user.identities.push(key);
    if (identity.emailVerified && email) user.email = email;
    user.name = identity.name ?? user.name;
    user.lastLoginAt = new Date().toISOString();
    this.save();
    return user;
  }
  update(id: string, role: unknown, enabled: unknown) {
    const user = this.find(id);
    if (!user) throw new Error("用户不存在");
    if ((role !== "admin" && role !== "viewer") || typeof enabled !== "boolean") throw new Error("用户设置无效");
    if (user.enabled && user.role === "admin" && (!enabled || role !== "admin") &&
        this.users.filter(item => item.enabled && item.role === "admin").length <= 1) throw new Error("请至少保留一名管理员");
    user.role = role; user.enabled = enabled; user.roleOverride = true;
    this.save();
    return structuredClone(user);
  }
}
