import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { SqliteStorage } from "../storage/index.ts";
import { SecurityStorage } from "../storage/security.ts";
import type { Identity } from "./auth.ts";
export interface ManagedUser {
    id: string;
    email: string | null;
    name: string | null;
    identities: string[];
    role: "admin" | "viewer";
    roleOverride?: boolean;
    enabled: boolean;
    createdAt: string;
    lastLoginAt: string;
}
/** Verified email links login identities; stable IDs survive email changes. */
export class UserDirectory {
    readonly security: SecurityStorage;
    private ownedStorage?: SqliteStorage;
    constructor(file: string, storage?: SqliteStorage) {
        if (!storage)
            this.ownedStorage = storage = new SqliteStorage(file + ".sqlite");
        this.security = new SecurityStorage(storage);
        const users = !this.security.migrated("security_users_migrated_v1") && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
        if (!Array.isArray(users))
            throw new Error("用户目录格式无效");
        this.security.migrateUsers(users);
    }
    close() { this.ownedStorage?.close(); }
    list() { return this.security.readUsers(); }
    find(id: string) { return this.list().find(user => user.id === id); }
    login(identity: Identity) {
        return this.security.transaction(db => {
            const users = this.security.readUsers(db);
            const key = JSON.stringify([identity.identityIssuer ?? identity.provider, identity.sub]);
            const legacyKey = `${identity.identityIssuer ?? identity.provider}:${identity.sub}`;
            const email = identity.email?.trim().toLowerCase() || null;
            let user = users.find(user => user.identities.includes(key) || user.identities.includes(legacyKey));
            if (!user && email && identity.emailVerified)
                user = users.find(user => user.email === email);
            if (!user) {
                user = { id: randomUUID(), email: identity.emailVerified ? email : null, name: identity.name,
                    identities: [], role: identity.role ?? "viewer", enabled: true,
                    createdAt: new Date().toISOString(), lastLoginAt: new Date().toISOString() };
                users.push(user);
            }
            if (!user.enabled)
                throw new Error("用户已停用");
            if (identity.emailVerified && email && users.some(other => other.id !== user!.id && other.email === email)) {
                throw new Error("邮箱已关联其他用户，请联系管理员");
            }
            user.identities = user.identities.map(item => item === legacyKey ? key : item);
            if (!user.identities.includes(key))
                user.identities.push(key);
            if (identity.emailVerified && email)
                user.email = email;
            user.name = identity.name ?? user.name;
            user.lastLoginAt = new Date().toISOString();
            this.security.writeUser(db, user, { key, issuer: identity.identityIssuer ?? identity.provider, subject: identity.sub });
            return user;
        });
    }
    update(id: string, role: unknown, enabled: unknown) {
        return this.security.transaction(db => {
            const users = this.security.readUsers(db);
            const user = users.find(user => user.id === id);
            if (!user)
                throw new Error("用户不存在");
            if ((role !== "admin" && role !== "viewer") || typeof enabled !== "boolean")
                throw new Error("用户设置无效");
            if (user.enabled && user.role === "admin" && (!enabled || role !== "admin") &&
                users.filter(item => item.enabled && item.role === "admin").length <= 1)
                throw new Error("请至少保留一名管理员");
            user.role = role;
            user.enabled = enabled;
            user.roleOverride = true;
            this.security.writeUser(db, user);
            return structuredClone(user);
        });
    }
}
