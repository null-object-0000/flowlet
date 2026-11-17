import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { startAgentSourceWatcher } from "./agent-source-watcher.ts";
import { discoverAgentSourceRoots } from "../../flowlet-core/src/agent/sessions/source-roots.ts";
import { setHomeDirForTests } from "../../flowlet-core/src/agent/paths.ts";

test("source discovery reuses compiled Agent roots and official environment overrides", () => {
  const keys = ["CODEX_HOME", "DSH_HOME", "HERMES_HOME", "CLAUDE_CONFIG_DIR"] as const;
  const saved = keys.map((key) => process.env[key]);
  const savedHome = process.env.HOME;
  const home = path.resolve("/flowlet-source-test-home");
  process.env.HOME = home;
  setHomeDirForTests(home);
  for (const key of keys) process.env[key] = path.join(home, key.toLowerCase());
  try {
    const roots = discoverAgentSourceRoots();
    assert.ok(roots.some((root) => root.path === path.join(process.env.CODEX_HOME!, "sessions") && root.recursive));
    assert.ok(roots.some((root) => root.path === path.join(process.env.DSH_HOME!, "sessions") && root.recursive));
    assert.ok(roots.some((root) => root.path === path.join(process.env.HERMES_HOME!, "profiles") && !root.recursive));
    assert.ok(roots.some((root) => root.path === path.join(process.env.CLAUDE_CONFIG_DIR!, "projects") && root.recursive));
    assert.ok(roots.some((root) => root.path === path.join(home, ".pi", "agent", "sessions")));
    assert.ok(roots.some((root) => root.path.endsWith(`${path.sep}opencode`) && !root.recursive));
    assert.equal(new Set(roots.map((root) => root.path)).size, roots.length);
    assert.ok(roots.every((root) => path.isAbsolute(root.path)));
  } finally {
    setHomeDirForTests(null);
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
  }
});

test("watcher emits real changes, discovers new roots, recovers failures, and closes once", () => {
  let exists = false;
  let changes = 0;
  let closes = 0;
  let subscriptions = 0;
  let warnings = 0;
  let changed!: () => void;
  let failed!: (error: Error) => void;
  const watcher = startAgentSourceWatcher({
    discover: () => [{ path: "/controlled/sessions", recursive: true }],
    emit: () => { changes++; },
    warn: () => { warnings++; },
    isDirectory: () => exists,
    watchDirectory: (_root, onChange, onError) => {
      subscriptions++;
      changed = onChange;
      failed = onError;
      return { close: () => { closes++; } };
    },
  });
  try {
    assert.equal(subscriptions, 0);
    exists = true;
    watcher.refresh(); watcher.refresh();
    assert.equal(subscriptions, 1);
    assert.equal(changes, 0, "watch installation must not trigger synchronization");
    changed();
    assert.equal(changes, 1);
    failed(new Error("watch limit"));
    assert.equal(warnings, 1);
    assert.equal(closes, 1);
    watcher.refresh();
    assert.equal(subscriptions, 2);
    watcher.close(); watcher.close();
    changed(); watcher.refresh();
    assert.equal(changes, 1);
    assert.equal(closes, 2);
    assert.equal(subscriptions, 2);
  } finally { watcher.close(); }
});
