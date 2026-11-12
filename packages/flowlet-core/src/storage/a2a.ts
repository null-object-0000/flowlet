import type { DatabaseSync } from "node:sqlite";

export interface A2aAgent {
  id: string;
  name: string;
  cardUrl: string;
  endpoint: string;
  card: Record<string, unknown>;
  enabled: boolean;
  allowPrivateNetwork: boolean;
  timeoutSeconds: number;
  tokenCipher: string | null;
  updatedAt: string;
}

export interface A2aCall {
  id: string;
  agentId: string;
  keyId: string;
  method: string;
  startedAt: string;
  durationMs: number;
  httpStatus: number | null;
  taskId: string | null;
  contextId: string | null;
  state: string | null;
  error: string | null;
  requestBody: string | null;
  responseBody: string | null;
}

/** Additive Node Host tables; old Rust hosts ignore them. No model/request-log schema changes. */
export class A2aStore {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS a2a_agents (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS a2a_keys (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        agent_ids TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS a2a_calls (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, started_at TEXT NOT NULL, value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_a2a_calls_agent_time ON a2a_calls(agent_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_a2a_calls_time ON a2a_calls(started_at DESC);
    `);
  }
  agents(): A2aAgent[] {
    return this.db
      .prepare("SELECT value FROM a2a_agents ORDER BY id")
      .all()
      .map((r) => JSON.parse(String(r.value)));
  }
  agent(id: string): A2aAgent | null {
    const row = this.db
      .prepare("SELECT value FROM a2a_agents WHERE id=?")
      .get(id);
    return row ? JSON.parse(String(row.value)) : null;
  }
  save(agent: A2aAgent): void {
    this.db
      .prepare(
        "INSERT INTO a2a_agents(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(agent.id, JSON.stringify(agent));
  }
  remove(id: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM a2a_agents WHERE id=?").run(id);
      for (const key of this.keys()) {
        this.db
          .prepare("UPDATE a2a_keys SET agent_ids=? WHERE id=?")
          .run(
            JSON.stringify(key.agentIds.filter((agentId) => agentId !== id)),
            key.id,
          );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  keys() {
    return this.db
      .prepare(
        "SELECT id,name,agent_ids,created_at FROM a2a_keys ORDER BY created_at DESC",
      )
      .all()
      .map((r) => ({
        id: String(r.id),
        name: String(r.name),
        agentIds: JSON.parse(String(r.agent_ids)) as string[],
        createdAt: String(r.created_at),
      }));
  }
  createKey(id: string, name: string, hash: string, agentIds: string[]): void {
    this.db
      .prepare("INSERT INTO a2a_keys VALUES (?,?,?,?,?)")
      .run(id, name, hash, JSON.stringify(agentIds), new Date().toISOString());
  }
  authorize(hash: string, agentId: string): string | null {
    const row = this.db
      .prepare("SELECT id,agent_ids FROM a2a_keys WHERE token_hash=?")
      .get(hash);
    return row &&
      (JSON.parse(String(row.agent_ids)) as string[]).includes(agentId)
      ? String(row.id)
      : null;
  }
  revokeKey(id: string): void {
    this.db.prepare("DELETE FROM a2a_keys WHERE id=?").run(id);
  }
  record(call: A2aCall): void {
    this.db
      .prepare("INSERT OR REPLACE INTO a2a_calls VALUES (?,?,?,?)")
      .run(call.id, call.agentId, call.startedAt, JSON.stringify(call));
    // Bounded metadata/body retention independent of model usage accounting.
    this.db
      .prepare(
        "DELETE FROM a2a_calls WHERE id IN (SELECT id FROM a2a_calls ORDER BY started_at DESC LIMIT -1 OFFSET 2000)",
      )
      .run();
  }
  calls(agentId?: string): A2aCall[] {
    const rows = agentId
      ? this.db
          .prepare(
            "SELECT value FROM a2a_calls WHERE agent_id=? ORDER BY started_at DESC LIMIT 100",
          )
          .all(agentId)
      : this.db
          .prepare(
            "SELECT value FROM a2a_calls ORDER BY started_at DESC LIMIT 100",
          )
          .all();
    return rows.map((r) => JSON.parse(String(r.value)));
  }
  pruneBodies(retentionDays: number, maxMb: number): void {
    if (retentionDays >= 0) {
      const cutoff = new Date(
        Date.now() - Math.max(0, retentionDays) * 86400000,
      ).toISOString();
      this.db
        .prepare(
          `UPDATE a2a_calls SET value=json_set(value,'$.requestBody',NULL,'$.responseBody',NULL)
      WHERE started_at <= ?`,
        )
        .run(cutoff);
    }
    if (maxMb <= 0) return;
    this.db
      .prepare(
        `UPDATE a2a_calls SET value=json_set(value,'$.requestBody',NULL,'$.responseBody',NULL)
      WHERE id IN (SELECT id FROM (
        SELECT id, SUM(COALESCE(length(CAST(json_extract(value,'$.requestBody') AS BLOB)),0)+COALESCE(length(CAST(json_extract(value,'$.responseBody') AS BLOB)),0))
        OVER (ORDER BY started_at DESC, id DESC) AS bytes FROM a2a_calls
      ) WHERE bytes > ?)`,
      )
      .run(Math.max(0, maxMb) * 1024 * 1024);
  }
}

/** Existing databases without A2A stay untouched by the periodic maintenance job. */
export function cleanupA2aBodies(db: DatabaseSync, retentionDays: number, maxMb: number): void {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='a2a_calls'").get()) {
    new A2aStore(db).pruneBodies(retentionDays, maxMb);
  }
}
