/** User identities, sessions, personal credentials and audit share the Host database. */
import type { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { SqliteStorage } from "./index.ts";
import type { PersistedAdminSession } from "../web/session-store.ts";
import type { ManagedUser } from "../web/users.ts";
export function migrateSecuritySchema(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS security_users (id TEXT PRIMARY KEY, email TEXT UNIQUE, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS security_identities (identity_key TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES security_users(id), issuer TEXT, subject TEXT);
      CREATE INDEX IF NOT EXISTS security_identity_user ON security_identities(user_id);
      CREATE UNIQUE INDEX IF NOT EXISTS security_identity_subject ON security_identities(issuer, subject) WHERE issuer IS NOT NULL AND subject IS NOT NULL;
      CREATE TABLE IF NOT EXISTS security_sessions (id TEXT PRIMARY KEY, user_id TEXT, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS security_session_user ON security_sessions(user_id);
      CREATE TABLE IF NOT EXISTS security_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES security_users(id), name TEXT NOT NULL, scope TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_used_at TEXT);
      CREATE INDEX IF NOT EXISTS security_token_user ON security_tokens(user_id);
      CREATE TABLE IF NOT EXISTS security_model_requests (request_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, credential_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS security_model_user ON security_model_requests(user_id);
      CREATE TABLE IF NOT EXISTS security_cli_owners (token_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES security_users(id));
      CREATE TABLE IF NOT EXISTS security_audit (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, user_id TEXT, credential_id TEXT, action TEXT NOT NULL, target_id TEXT, outcome TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS security_audit_time ON security_audit(created_at DESC);
    `);
}

export class SecurityStorage {
    private storage: SqliteStorage;
    constructor(storage: SqliteStorage) {
        this.storage = storage;

    }
    transaction<T>(fn: (db: DatabaseSync) => T): T {
        return this.storage.withDatabase(db => { db.exec("BEGIN IMMEDIATE"); try {
            const value = fn(db);
            db.exec("COMMIT");
            return value;
        }
        catch (e) {
            db.exec("ROLLBACK");
            throw e;
        } });
    }
    migrated(key: string): boolean { return this.storage.getAppMeta(key) !== null; }
    readUsers(db?: DatabaseSync): ManagedUser[] {
        const read = (db: DatabaseSync) => (db.prepare("SELECT value FROM security_users ORDER BY id").all() as {
            value: string;
        }[]).map(row => JSON.parse(row.value));
        return db ? read(db) : this.storage.withDatabase(read);
    }
    writeUser(db: DatabaseSync, user: ManagedUser, identity?: {
        key: string;
        issuer: string;
        subject: string;
    }) {
        db.prepare("INSERT INTO security_users(id,email,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,value=excluded.value").run(user.id, user.email, JSON.stringify(user));
        if (user.identities.length)
            db.prepare(`DELETE FROM security_identities WHERE user_id=? AND identity_key NOT IN (${user.identities.map(() => "?").join(",")})`).run(user.id, ...user.identities);
        else
            db.prepare("DELETE FROM security_identities WHERE user_id=?").run(user.id);
        for (const key of user.identities) {
            const owner = db.prepare("SELECT user_id FROM security_identities WHERE identity_key=?").get(key) as {
                user_id: string;
            } | undefined;
            if (owner && owner.user_id !== user.id)
                throw new Error("登录身份已绑定其他用户");
            db.prepare("INSERT INTO security_identities(identity_key,user_id,issuer,subject) VALUES(?,?,?,?) ON CONFLICT(identity_key) DO NOTHING").run(key, user.id, key === identity?.key ? identity.issuer : null, key === identity?.key ? identity.subject : null);
        }
    }
    migrateUsers(users: ManagedUser[]) {
        this.transaction(db => {
            if (db.prepare("SELECT 1 FROM app_meta WHERE key='security_users_migrated_v1'").get())
                return;
            for (const user of users) {
                if (!user || typeof user.id !== "string" || !Array.isArray(user.identities) || user.identities.some(x => typeof x !== "string") || !["admin", "viewer"].includes(user.role) || typeof user.enabled !== "boolean" || (user.email !== null && typeof user.email !== "string"))
                    throw new Error("旧用户目录格式无效，迁移已回滚");
                const current = db.prepare("SELECT 1 FROM security_users WHERE id=?").get(user.id);
                if (!current)
                    this.writeUser(db, { ...user, email: user.email?.trim().toLowerCase() || null });
            }
            db.prepare("INSERT INTO app_meta(key,value,updated_at) VALUES('security_users_migrated_v1','true',datetime('now'))").run();
        });
    }
    migrateSessions(sessions: PersistedAdminSession[]) {
        this.transaction(db => {
            if (db.prepare("SELECT 1 FROM app_meta WHERE key='security_sessions_migrated_v1'").get())
                return;
            for (const session of sessions)
                db.prepare("INSERT OR IGNORE INTO security_sessions(id,user_id,value) VALUES(?,?,?)").run(session.key, session.identity.userId ?? null, JSON.stringify(session));
            db.prepare("INSERT INTO app_meta(key,value,updated_at) VALUES('security_sessions_migrated_v1','true',datetime('now'))").run();
        });
    }
    sessions(): PersistedAdminSession[] { return this.storage.withDatabase(db => (db.prepare("SELECT value FROM security_sessions").all() as {
        value: string;
    }[]).map(row => JSON.parse(row.value))); }
    session(key: string): PersistedAdminSession | null { return this.storage.withDatabase(db => { const row = db.prepare("SELECT value FROM security_sessions WHERE id=?").get(key) as {
        value: string;
    } | undefined; return row ? JSON.parse(row.value) : null; }); }
    saveSession(session: PersistedAdminSession) { this.storage.withDatabase(db => db.prepare("INSERT INTO security_sessions(id,user_id,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,value=excluded.value").run(session.key, session.identity.userId ?? null, JSON.stringify(session))); }
    removeSession(key: string) { this.storage.withDatabase(db => db.prepare("DELETE FROM security_sessions WHERE id=?").run(key)); }
    tokens(userId: string) { return this.storage.withDatabase(db => db.prepare("SELECT id,user_id AS userId,name,scope,prefix,created_at AS createdAt,expires_at AS expiresAt,last_used_at AS lastUsedAt FROM security_tokens WHERE user_id=? ORDER BY created_at DESC").all(userId)); }
    createToken(userId: string, name: string, scope: string, days: number) {
        if (!name.trim() || name.length > 100 || !["observe", "credentials:read", "models:invoke"].includes(scope) || !Number.isInteger(days) || days < 1 || days > 90)
            throw new Error("凭据名称、作用域或有效期无效（1–90天）");
        const token = "flwpat_" + randomBytes(32).toString("base64url"), id = randomUUID(), expiresAt = new Date(Date.now() + days * 86400000).toISOString();
        this.transaction(db => {
            const user = this.readUsers(db).find(u => u.id === userId);
            if (!user?.enabled || (scope !== "observe" && user.role !== "admin"))
                throw new Error("当前用户无权创建该凭据");
            if (Number((db.prepare("SELECT count(*) n FROM security_tokens WHERE user_id=?").get(userId) as {
                n: number;
            }).n) >= 25)
                throw new Error("最多保留25个个人凭据");
            db.prepare("INSERT INTO security_tokens(id,user_id,name,scope,hash,prefix,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)").run(id, userId, name.trim(), scope, createHash("sha256").update(token).digest("hex"), token.slice(0, 14), new Date().toISOString(), expiresAt);
        });
        return { id, token, expiresAt };
    }
    revokeToken(userId: string, id: string) { this.storage.withDatabase(db => db.prepare("DELETE FROM security_tokens WHERE id=? AND user_id=?").run(id, userId)); }
    authenticateToken(token: string) {
        if (!token.startsWith("flwpat_"))
            return null;
        return this.storage.withDatabase(db => {
            const row = db.prepare("SELECT id,user_id AS userId,scope,expires_at AS expiresAt FROM security_tokens WHERE hash=?").get(createHash("sha256").update(token).digest("hex")) as {
                id: string;
                userId: string;
                scope: string;
                expiresAt: string;
            } | undefined;
            if (!row || !Number.isFinite(Date.parse(row.expiresAt)) || Date.parse(row.expiresAt) <= Date.now() || !["observe", "credentials:read", "models:invoke"].includes(row.scope))
                return null;
            const user = this.readUsers(db).find(u => u.id === row.userId);
            if (!user?.enabled || (row.scope !== "observe" && user.role !== "admin"))
                return null;
            db.prepare("UPDATE security_tokens SET last_used_at=? WHERE id=?").run(new Date().toISOString(), row.id);
            return { ...row, user };
        });
    }
    recordModelOwner(requestId: string, userId: string, credentialId: string) {
        this.storage.withDatabase(db => db.prepare("INSERT OR IGNORE INTO security_model_requests(request_id,user_id,credential_id) VALUES(?,?,?)").run(requestId, userId, credentialId));
    }
    modelOwners(requestIds: string[]): Record<string, {
        userId: string;
        credentialId: string;
    }> {
        if (!requestIds.length)
            return {};
        return this.storage.withDatabase(db => Object.fromEntries((db.prepare(`SELECT request_id,user_id,credential_id FROM security_model_requests WHERE request_id IN (${requestIds.map(() => "?").join(",")})`).all(...requestIds) as {
            request_id: string;
            user_id: string;
            credential_id: string;
        }[]).map(row => [row.request_id, { userId: row.user_id, credentialId: row.credential_id }])));
    }
    bindCli(tokenId: string, userId: string) { this.storage.withDatabase(db => db.prepare("INSERT INTO security_cli_owners(token_id,user_id) VALUES(?,?)").run(tokenId, userId)); }
    cliOwner(tokenId: string): string | null { return this.storage.withDatabase(db => (db.prepare("SELECT user_id FROM security_cli_owners WHERE token_id=?").get(tokenId) as {
        user_id: string;
    } | undefined)?.user_id ?? null); }
    audit(userId: string | null, credentialId: string | null, action: string, targetId: string | null, outcome: string) {
        const id = randomUUID();
        this.storage.withDatabase(db => db.prepare("INSERT INTO security_audit(id,created_at,user_id,credential_id,action,target_id,outcome) VALUES(?,?,?,?,?,?,?)").run(id, new Date().toISOString(), userId, credentialId, action, targetId?.slice(0, 200) ?? null, outcome));
        return id;
    }
    finishAudit(id: string, outcome: string) { this.storage.withDatabase(db => db.prepare("UPDATE security_audit SET outcome=? WHERE id=?").run(outcome, id)); }
    auditEntries() { return this.storage.withDatabase(db => db.prepare("SELECT id,created_at AS createdAt,user_id AS userId,credential_id AS credentialId,action,target_id AS targetId,outcome FROM security_audit ORDER BY created_at DESC LIMIT 200").all()); }
}
