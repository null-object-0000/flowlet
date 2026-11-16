import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserDirectory } from "../users.ts";
import { viewerCanRunCommand, type Identity } from "../auth.ts";
const identity = (sub: string, extra: Partial<Identity> = {}): Identity => ({ sub, email: "Person@Example.com", emailVerified: true, name: "Person", username: null, groups: [], provider: "SSO", identityIssuer: "https://issuer.example", role: "admin", ...extra });
test("verified email links providers, preserves IDs, roles, and disable across restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "flowlet-users-"));
  try {
    const file = join(dir, "users.json");
    const store = new UserDirectory(file);
    const first = store.login(identity("a"));
    const linked = store.login(identity("b", { identityIssuer: "https://other.example", role: "viewer" }));
    assert.equal(first.id, linked.id);
    assert.equal(linked.role, "admin");
    assert.equal(store.list().length, 1);
    assert.throws(() => store.update(first.id, "viewer", true), /保留一名管理员/);
    const second = store.login(identity("c", { email: "other@example.com" }));
    store.update(first.id, "viewer", true);
    assert.equal(store.login(identity("a")).role, "viewer");
    store.update(first.id, "viewer", false);
    const restored = new UserDirectory(file);
    assert.throws(() => restored.login(identity("a")), /停用/);
    assert.equal(restored.find(second.id)?.enabled, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("unverified emails and differing issuers do not link; changing a verified email preserves user ID", () => {
  const dir = mkdtempSync(join(tmpdir(), "flowlet-users-"));
  try {
    const store = new UserDirectory(join(dir, "users.json"));
    const first = store.login(identity("a"));
    assert.notEqual(store.login(identity("b", { emailVerified: false })).id, first.id);
    assert.notEqual(store.login(identity("a", { emailVerified: false, identityIssuer: "https://evil.example" })).id, first.id);
    assert.equal(store.login(identity("a", { email: "new@example.com" })).id, first.id);
    assert.equal(viewerCanRunCommand("list_managed_users"), false);
    assert.equal(viewerCanRunCommand("update_managed_user"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
