import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { SqliteStorage } from "../../storage/index.ts";
import { UserDirectory } from "../users.ts";
import { SqliteAdminSessionStore } from "../session-store.ts";
import { AdminAuth, adminAuthConfigFromEnv, type Identity } from "../auth.ts";
import { createCliAuth } from "../cli-auth.ts";
import { COMMAND_PERMISSIONS, commandPermission } from "../permissions.ts";
import { createWebHost } from "../index.ts";
const identity = (sub: string, role: "admin" | "viewer" = "admin"): Identity => ({ sub, email: `${sub}@example.com`, emailVerified: true, name: sub, username: null, groups: [], provider: "SSO", identityIssuer: "https://issuer.example", role });
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "flowlet-security-"));
    const db = new SqliteStorage(join(dir, "host.sqlite"));
    const file = join(dir, "users.json");
    const users = new UserDirectory(file, db);
    const sessions = new SqliteAdminSessionStore(users.security, join(dir, "sessions.json"));
    const auth = AdminAuth.fromConfig(adminAuthConfigFromEnv({ FLOWLET_ADMIN_AUTH_MODE: "oidc", FLOWLET_PUBLIC_WEB_URL: "http://localhost", FLOWLET_ADMIN_TOKEN: "x".repeat(32), FLOWLET_OIDC_ISSUER: "https://issuer.example", FLOWLET_OIDC_CLIENT_ID: "test", FLOWLET_OIDC_CLIENT_SECRET: "secret", FLOWLET_OIDC_ALLOWED_SUBS: "a,b" }), sessions);
    auth.userDirectory = users;
    const a = users.login(identity("a")), b = users.login(identity("b"));
    function cookie(user: typeof a, raw: string) {
        const key = createHash("sha256").update(raw).digest("hex"), now = Date.now();
        sessions.save({ key, identity: { ...identity(user.name!), userId: user.id }, csrfToken: "csrf", createdMs: now, lastSeenMs: now, absoluteExpireMs: now + 3600000 });
        return { key, headers: { cookie: `flowlet-admin=${raw}`, "x-csrf-token": "csrf", origin: "http://localhost" } };
    }
    return { dir, db, file, users, sessions, auth, a, b, cookie, close() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
test("legacy users migrate atomically with stable IDs; old files never overwrite SQLite", () => {
    const f = fixture();
    try {
        writeFileSync(f.file, JSON.stringify([{ ...f.a, enabled: false }]));
        const second = new UserDirectory(f.file, f.db);
        assert.equal(second.find(f.a.id)?.enabled, true);
        second.update(f.a.id, "viewer", true);
        assert.equal(f.users.find(f.a.id)?.role, "viewer");
        const otherFile = join(f.dir, "new.sqlite");
        const db = new SqliteStorage(otherFile);
        try {
            writeFileSync(f.file, JSON.stringify([f.a, f.b]));
            const migrated = new UserDirectory(f.file, db);
            assert.equal(migrated.find(f.a.id)?.id, f.a.id);
            assert.equal(migrated.list().length, 2);
        }
        finally {
            db.close();
        }
    }
    finally {
        f.close();
    }
});
test("identity conflicts roll back the whole migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "flowlet-migrate-")), db = new SqliteStorage(join(dir, "host.sqlite"));
    try {
        const file = join(dir, "users.json"), base = { id: "one", email: "one@example.com", name: "one", identities: ["same"], role: "admin", enabled: true, createdAt: "now", lastLoginAt: "now" };
        writeFileSync(file, JSON.stringify([base, { ...base, id: "two", email: "two@example.com" }]));
        assert.throws(() => new UserDirectory(file, db), /绑定/);
        assert.equal(db.withDatabase(db => (db.prepare("SELECT count(*) n FROM security_users").get() as {
            n: number;
        }).n), 0);
        assert.equal(db.getAppMeta("security_users_migrated_v1"), null);
    }
    finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
test("migrated sessions cannot be resurrected and cached sessions honor cross-store revocation", () => {
    const f = fixture();
    try {
        const one = f.cookie(f.a, "first"), other = f.cookie(f.b, "second");
        assert.ok(f.auth.authenticate(one.headers));
        f.auth.revokeSession(f.b.id, one.key);
        assert.ok(f.auth.authenticate(one.headers));
        const second = new SqliteAdminSessionStore(f.users.security, join(f.dir, "sessions.json"));
        second.remove(one.key);
        assert.equal(f.auth.authenticate(one.headers), null);
        assert.ok(f.auth.authenticate(other.headers));
        writeFileSync(join(f.dir, "sessions.json"), JSON.stringify({ schemaVersion: 1, sessions: [] }));
        new SqliteAdminSessionStore(f.users.security, join(f.dir, "sessions.json"));
        assert.equal(f.sessions.load(one.key), null);
    }
    finally {
        f.close();
    }
});
test("personal tokens persist hashes only, enforce owners, and follow live roles and disable", () => {
    const f = fixture();
    try {
        const token = f.users.security.createToken(f.a.id, "inspection", "observe", 7);
        const model = f.users.security.createToken(f.a.id, "model", "models:invoke", 7);
        const secret = f.users.security.createToken(f.a.id, "sync", "credentials:read", 7);
        assert.equal(f.users.security.authenticateToken(token.token)?.userId, f.a.id);
        assert.ok(f.auth.authenticate({ authorization: `Bearer ${token.token}` }));
        assert.equal(f.auth.authenticate({ authorization: `Bearer ${model.token}` }), null);
        assert.ok(!JSON.stringify(f.users.security.tokens(f.a.id)).includes(token.token));
        const hashes = f.db.withDatabase(db => db.prepare("SELECT hash FROM security_tokens").all());
        assert.ok(!JSON.stringify(hashes).includes(token.token));
        f.users.security.revokeToken(f.b.id, token.id);
        assert.ok(f.users.security.authenticateToken(token.token));
        f.users.update(f.a.id, "viewer", true);
        assert.equal(f.users.security.authenticateToken(model.token), null);
        assert.equal(f.users.security.authenticateToken(secret.token), null);
        assert.ok(f.users.security.authenticateToken(token.token));
        f.users.update(f.a.id, "viewer", false);
        assert.equal(f.users.security.authenticateToken(token.token), null);
        f.users.security.revokeToken(f.a.id, token.id);
        assert.equal(f.users.security.tokens(f.a.id).length, 2);
    }
    finally {
        f.close();
    }
});
test("explicit permission declarations cover dispatch and never grant guessed commands", () => {
    const source = readFileSync(new URL("../commands.ts", import.meta.url), "utf8");
    for (const [, command] of source.matchAll(/case "([^"]+)":/g))
        assert.ok(COMMAND_PERMISSIONS[command], command);
    for (const name of ["get_future_secret", "list_new_sensitive_table", "read_app_meta", "list_channel_accounts", "get_request_log_detail", "inspect_a2a_agent"])
        assert.notEqual(commandPermission(name), "observe");
});
test("CLI exchange binds the grant owner, rechecks user state, and audits no secrets", () => {
    const f = fixture();
    try {
        const allowed = (id: string) => { const user = f.users.find(id); return Boolean(user?.enabled && user.role === "admin"); };
        const cli = createCliAuth(f.db, Date.now, { userAllowed: allowed, bindOwner: (id, user) => { if (user)
                f.users.security.bindCli(id, user); }, ownerAllowed: id => { const user = f.users.security.cliOwner(id); return !user || allowed(user); } });
        const verifier = randomBytes(32).toString("base64url"), challenge = createHash("sha256").update(verifier).digest("base64url");
        const input = { redirectUri: "http://127.0.0.1:45000/callback", state: "state-0123456789abcdef", codeChallenge: challenge, name: "terminal" };
        const code = new URL(cli.authorize(input, f.a.id).redirectUrl).searchParams.get("code");
        const result = cli.exchange({ code, codeVerifier: verifier }), row = cli.authenticate({ authorization: `Bearer ${result.token}` });
        assert.ok(row);
        assert.equal(f.users.security.cliOwner(String(row.id)), f.a.id);
        f.users.update(f.a.id, "viewer", true);
        assert.equal(cli.authenticate({ authorization: `Bearer ${result.token}` }), null);
        const deniedCode = new URL(cli.authorize(input, f.a.id).redirectUrl).searchParams.get("code");
        assert.throws(() => cli.exchange({ code: deniedCode, codeVerifier: verifier }), /停用|失去/);
        const id = f.users.security.audit(f.a.id, String(row.id), "export_service_credentials", null, "pending");
        f.users.security.finishAudit(id, "success");
        assert.ok(!JSON.stringify(f.users.security.auditEntries()).includes(result.token));
    }
    finally {
        f.close();
    }
});
test("HTTP permissions enforce scoped personal tokens and user-owned session operations", async () => {
    const f = fixture();
    let host: ReturnType<typeof createWebHost> | undefined;
    try {
        host = createWebHost({ auth: f.auth, storage: f.db, proxy: { status: () => ({ running: true }) } as any, runtimeConfig: { snapshot: () => ({}) } as any, catalogDir: f.dir, configPath: join(f.dir, "config.json"), staticDir: f.dir, clientToken: "model-only" } as any);
        await host.listen("127.0.0.1:0");
        const base = `http://127.0.0.1:${host.address()!.port}`;
        const session = f.cookie(f.a, "http-cookie"), other = f.cookie(f.b, "other-cookie");
        const pat = f.users.security.createToken(f.a.id, "observe", "observe", 7);
        const call = (cmd: string, headers: Record<string, string>, body = {}) => fetch(`${base}/api/commands/${cmd}`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
        assert.equal((await call("ipc_ping", { authorization: `Bearer ${pat.token}` })).status, 200);
        assert.equal((await call("list_managed_users", { authorization: `Bearer ${pat.token}` })).status, 403);
        assert.equal((await call("create_personal_token", { authorization: `Bearer ${pat.token}` })).status, 403);
        const malformed = await fetch(`${base}/api/commands/create_personal_token`, {method:"POST",headers:{...session.headers,"Content-Type":"application/json"},body:"null"});
        assert.equal(malformed.status,400);
        const minted=await call("create_personal_token",session.headers,{name:"own",scope:"observe",days:7,userId:f.b.id});
        assert.equal(minted.status,200);
        const mintedBody=await minted.json() as {token:string};
        assert.equal(f.users.security.authenticateToken(mintedBody.token)?.userId,f.a.id);

        assert.equal((await call("revoke_my_session", session.headers, { id: other.key })).status, 200);
        assert.ok(f.auth.authenticate(other.headers));
        assert.equal((await call("revoke_my_session", session.headers, { id: session.key })).status, 200);
        assert.equal(f.auth.authenticate(session.headers), null);
        const audit = JSON.stringify(f.users.security.auditEntries());
        assert.ok(!audit.includes(pat.token));
        assert.ok(audit.includes('"outcome":"denied"'));
    }
    finally {
        await host?.close();
        f.close();
    }
});


test("imports genuine legacy user/session files once, keeping cookies and stable identity IDs", () => {
  const dir=mkdtempSync(join(tmpdir(),"flowlet-legacy-security-"));
  const file=join(dir,"users.json"),sessionFile=join(dir,"admin-sessions.json");
  const oldUser={id:"legacy-id",email:"a@example.com",name:"a",role:"admin",enabled:true,identities:["https://issuer.example:a"],createdAt:"2026-01-01T00:00:00Z",lastLoginAt:"2026-01-01T00:00:00Z"};
  const key=createHash("sha256").update("old-browser-cookie").digest("hex"),now=Date.now();
  writeFileSync(file,JSON.stringify([oldUser]));
  writeFileSync(sessionFile,JSON.stringify({schemaVersion:1,sessions:[{key,identity:{...identity("a"),userId:"legacy-id"},csrfToken:"old-csrf",createdMs:now,lastSeenMs:now,absoluteExpireMs:now+3600000}]}));
  const db=new SqliteStorage(join(dir,"host.sqlite"));
  try {
    const users=new UserDirectory(file,db),sessions=new SqliteAdminSessionStore(users.security,sessionFile);
    assert.equal(sessions.load(key)?.identity.userId,"legacy-id");
    assert.equal(sessions.load(key)?.csrfToken,"old-csrf");
    const migrated=users.login(identity("a"));assert.equal(migrated.id,"legacy-id");assert.equal(migrated.identities.length,1);
    sessions.remove(key);
    const restarted=new SqliteAdminSessionStore(users.security,sessionFile);assert.equal(restarted.load(key),null);
    const pat=users.security.createToken(migrated.id,"expired","observe",1);
    db.withDatabase(db=>db.prepare("UPDATE security_tokens SET expires_at='not-a-date' WHERE id=?").run(pat.id));
    assert.equal(users.security.authenticateToken(pat.token),null);
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});

test("instance policy migrates once, namespaces legacy rules, and decouples provider changes", async () => {
    const { AccessPolicyStore, ACCESS_POLICY_KEY } = await import("../access-policy.ts");
    const f = fixture();
    try {
        const policy = new AccessPolicyStore(f.db, f.users, f.auth.config);
        assert.equal(policy.admit(identity("a")).role, "admin");
        assert.equal(policy.admit({...identity("a"),email:"new@example.com",identityIssuer:"https://other.example"}).allowed, false);
        assert.equal(f.db.getAppMeta(ACCESS_POLICY_KEY)!.includes("clientSecret"), false);
        f.auth.config.oidc!.allowedSubs = ["new"];
        new AccessPolicyStore(f.db, f.users, f.auth.config);
        assert.equal(policy.admit(identity("new")).allowed, false);
        const next = policy.save({generation:1,mode:"rules",emails:["NEW@EXAMPLE.COM"],domains:["company.com"],clearLegacy:true});
        assert.equal(next.legacyRules.length, 0);
        assert.deepEqual(policy.admit({...identity("new"),identityIssuer:"https://other.example"}),{allowed:true,role:"viewer"});
        assert.equal(policy.admit({...identity("new"),emailVerified:false}).allowed, false);
        assert.equal(policy.admit({...identity("x"),email:"x@sub.company.com"}).allowed, false);
        assert.equal(policy.admit({...identity("x"),email:"x@company.com"}).allowed, true);
        assert.throws(()=>policy.save({generation:1,mode:"all",emails:[],domains:[]}),/已变更/);
        f.users.update(f.a.id,"viewer",false);
        assert.equal(policy.admit({...identity("another"),email:f.a.email,identityIssuer:"https://other.example"}).allowed,false);
        policy.save({generation:2,mode:"existing",emails:[],domains:[]});
        assert.equal(policy.admit(identity("new")).allowed,false);
        assert.deepEqual(policy.admit(identity("b")),{allowed:true,role:"admin"});
    } finally { f.close(); }
});

test("migrated org access remains available after provider-only settings remove old roster", async () => {
    const { AccessPolicyStore } = await import("../access-policy.ts");
    const f = fixture();
    try {
        const config = adminAuthConfigFromEnv({FLOWLET_ADMIN_AUTH_MODE:"oidc",FLOWLET_PUBLIC_WEB_URL:"http://localhost",FLOWLET_ADMIN_TOKEN:"x".repeat(32),FLOWLET_GITHUB_CLIENT_ID:"client",FLOWLET_GITHUB_CLIENT_SECRET:"secret",FLOWLET_GITHUB_ALLOWED_ORGS:"team",FLOWLET_GITHUB_ADMIN_LOGINS:"owner"});
        const policy = new AccessPolicyStore(f.db,f.users,config);
        const issuer = config.github!.apiBase;
        const { saveGithubProvider, readGithubProvider } = await import("../auth-providers.ts");
        const secrets = {encrypt:(value:string)=>`test:${value}`,decrypt:(value:string)=>value.slice(5)};
        saveGithubProvider(f.db,secrets,{client_id:"client",client_secret:"secret",allowed_orgs:["team"]});
        const snapshot = JSON.stringify(policy.read());
        saveGithubProvider(f.db,secrets,{client_id:"changed"});
        assert.equal(readGithubProvider(f.db,secrets)?.clientId,"changed");
        assert.equal(readGithubProvider(f.db,secrets)?.scopes.includes("read:org"),true);
        assert.equal(JSON.stringify(new AccessPolicyStore(f.db,f.users,{...config,github:readGithubProvider(f.db,secrets)}).read()),snapshot);
        assert.equal(policy.needsGithubGroups(issuer),true);
        assert.deepEqual(policy.admit({...identity("org-user"),username:"member",identityIssuer:issuer,groups:["team"]}),{allowed:true,role:"viewer"});
        assert.equal(policy.admit({...identity("org-user"),username:"member",identityIssuer:"https://another",groups:["team"]}).allowed,false);
        policy.save({generation:1,mode:"rules",emails:[],domains:[],clearLegacy:true});
        assert.equal(policy.needsGithubGroups(issuer),false);
    } finally { f.close(); }
});
