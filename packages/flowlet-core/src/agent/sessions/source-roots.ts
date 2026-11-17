// Read-only source discovery shared by the Electron watcher and native session adapters.
import path from "node:path";
import { claudeConfigDir, codexHome, dshHome, homeDir, hermesHome } from "../paths.ts";
import { AGENTS } from "../registry.ts";
import { hermesDatabaseCandidates, opencodeDatabaseCandidates } from "./timeline.ts";

export interface AgentSourceRoot {
  path: string;
  recursive: boolean;
}

/** Missing roots are returned too, so a running Host can discover newly installed Agents. */
export function discoverAgentSourceRoots(): AgentSourceRoot[] {
  const roots = new Map<string, AgentSourceRoot>();
  const add = (directory: string, recursive: boolean): void => {
    const absolute = path.resolve(directory);
    const existing = roots.get(absolute);
    roots.set(absolute, { path: absolute, recursive: recursive || existing?.recursive === true });
  };
  for (const agent of AGENTS) {
    switch (agent.id) {
      case "claude-code":
        add(path.join(homeDir(), ".claude", "projects"), true);
        add(path.join(claudeConfigDir(), "projects"), true);
        break;
      case "codex":
        add(codexHome(), false); // auth/index/database updates, not recursive caches.
        add(path.join(codexHome(), "sessions"), true);
        break;
      case "pi":
        add(path.join(homeDir(), ".pi", "agent", "sessions"), true);
        break;
      case "deepseek-harness":
        add(path.join(dshHome(), "sessions"), true);
        break;
      case "opencode":
        for (const file of opencodeDatabaseCandidates()) add(path.dirname(file), false);
        break;
      case "hermes":
        add(hermesHome(), false);
        // Profile databases are direct children; never recurse into unrelated memories/caches.
        add(path.join(hermesHome(), "profiles"), false);
        for (const file of hermesDatabaseCandidates()) add(path.dirname(file), false);
        break;
      default:
        throw new Error(`Agent source discovery is not implemented: ${agent.id}`);
    }
  }
  return [...roots.values()];
}
