// task-12 测试：SecretBox（ChaCha20-Poly1305）与 service_credentials 持久化。
//
// 覆盖：secret.key 生成/权限/稳定性、加解密往返、篡改/版本/格式/长度/UTF-8 错误、
// 表 CRUD/排序/校验字段更新，以及跨实现兼容（Rust debug headless oracle）：
//   1) Node 写库+Node 生成的 secret.key → Rust `export_service_credentials` 得到明文；
//   2) Rust 写库（save_service_credential 走 mock GitLab）→ Node 解密得到明文。
// Rust 二进制不存在时自动跳过跨实现用例。
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteStorage } from "../index.ts";
import { addColumnIfMissing, migrate, tableHasColumn } from "../schema.ts";
import { SecretBox, secretKeyPath } from "../secret-box.ts";
import {
  credentialTimestamp,
  getServiceCredential,
  listServiceCredentials,
  maskSecret,
  updateServiceCredentialVerification,
  upsertServiceCredential,
  deleteServiceCredential,
} from "../credentials.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const RUST_BIN = "/home/nichangen/代码/self-code/flowlet/src-tauri/target/debug/headless";
const hasRustOracle = existsSync(RUST_BIN);
const ADMIN = "task12-admin-token-0123456789abcdef";
const CLIENT = "task12-client-token-0123456789abc";

function tempDir(name: string): string {
  const dir = path.join(
    process.cwd(),
    ".flowlet-test-tmp",
    `${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHttp(url: string, timeoutMs = 30000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      /* retry */
    }
    await sleep(100);
  }
  return false;
}

interface RustInstance {
  child: ReturnType<typeof spawn>;
  stderr: () => string;
}

async function startRust(dataDir: string, bindAddr: string, webAddr: string): Promise<RustInstance> {
  const child = spawn(RUST_BIN, [], {
    cwd: dataDir,
    env: {
      ...process.env,
      FLOWLET_ADMIN_TOKEN: ADMIN,
      FLOWLET_CLIENT_TOKEN: CLIENT,
      FLOWLET_DB_PATH: path.join(dataDir, "flowlet.sqlite"),
      FLOWLET_CONFIG_PATH: path.join(dataDir, "config.json"),
      FLOWLET_CATALOG_DIR: dataDir,
      FLOWLET_BIND_ADDR: bindAddr,
      FLOWLET_WEB_ADDR: webAddr,
      FLOWLET_STATIC_DIR: path.join(REPO_ROOT, "dist-web"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  if (!(await waitForHttp(`http://${webAddr}/health`))) {
    child.kill("SIGKILL");
    throw new Error(`Rust oracle 未就绪: ${stderr.slice(-2000)}`);
  }
  return { child, stderr: () => stderr };
}

async function stopRust(instance: RustInstance): Promise<void> {
  instance.child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        instance.child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve();
    }, 8000);
    instance.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function webCommand(webAddr: string, command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const response = await fetch(`http://${webAddr}/api/commands/${command}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${command} HTTP ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

// ─── SecretBox ──────────────────────────────────────────────────────────────

test("secret.key：自动生成 32 字节 hex、文件 0600、实例间密钥稳定", () => {
  // dataDir 由 loadOrCreate 首次创建时才应用 0700（与 Rust create_dir_all 行为一致）。
  const parent = tempDir("key-gen");
  const dir = path.join(parent, "data-dir");
  try {
    const first = SecretBox.loadOrCreate(dir);
    const keyPath = secretKeyPath(dir);
    assert.ok(existsSync(keyPath));
    const raw = readFileSync(keyPath, "utf8");
    assert.match(raw, /^[0-9a-f]{64}$/);
    assert.equal(Buffer.from(raw, "hex").length, 32);
    assert.equal(statSync(keyPath).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);

    const encoded = first.encrypt("glpat-secret-token");
    assert.ok(encoded.startsWith("v1:"));
    assert.ok(!encoded.includes("glpat"));
    assert.equal(first.decrypt(encoded), "glpat-secret-token");

    // 同目录再次加载：同一 key，能解上一实例的密文。
    const second = SecretBox.loadOrCreate(dir);
    assert.equal(second.decrypt(encoded), "glpat-secret-token");
    // 不同目录不同 key，无法互解。
    const otherDir = tempDir("key-other");
    try {
      const other = SecretBox.loadOrCreate(otherDir);
      assert.throws(() => other.decrypt(encoded), /解密失败/);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("密文格式：Rust 兼容布局 v1:base64(nonce12||ciphertext||tag16)", () => {
  const dir = tempDir("layout");
  try {
    const box = SecretBox.loadOrCreate(dir);
    const key = Buffer.from(readFileSync(secretKeyPath(dir), "utf8"), "hex");
    const encoded = box.encrypt("payload");
    const payload = Buffer.from(encoded.slice("v1:".length), "base64");
    assert.equal(payload.length, 12 + Buffer.byteLength("payload") + 16);
    // 手工按 Rust 布局解析：nonce || ciphertext || tag，并用同 key 解密。
    const nonce = payload.subarray(0, 12);
    const ciphertext = payload.subarray(12, payload.length - 16);
    const tag = payload.subarray(payload.length - 16);
    const decipher = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 }) as never as {
      setAuthTag(tag: Buffer): void;
      update(data: Buffer): Buffer;
      final(): Buffer;
    };
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    assert.equal(plaintext.toString("utf8"), "payload");
    assert.notEqual(nonce.toString("hex"), randomBytes(12).toString("hex"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("解密错误：篡改/错误版本/非法 base64/长度不足/非法 UTF-8 都有明确错误文案", () => {
  const dir = tempDir("decrypt-errors");
  try {
    const box = SecretBox.loadOrCreate(dir);
    const key = Buffer.from(readFileSync(secretKeyPath(dir), "utf8"), "hex");

    const encoded = box.encrypt("token");
    const payload = Buffer.from(encoded.slice(3), "base64");
    const tampered = Buffer.from(payload);
    tampered[tampered.length - 1] ^= 0xff;
    assert.throws(
      () => box.decrypt(`v1:${tampered.toString("base64")}`),
      /凭据解密失败（密钥可能已更换）/,
    );
    assert.throws(() => box.decrypt(payload.toString("base64")), /凭据密文版本不支持/);
    assert.throws(() => box.decrypt("v2:abc"), /凭据密文版本不支持/);
    assert.throws(() => box.decrypt("v1:not-base64!!"), /凭据密文格式无效/);
    assert.throws(() => box.decrypt("v1:abc"), /凭据密文格式无效/); // 长度非 4 的倍数
    assert.throws(() => box.decrypt(`v1:${Buffer.alloc(8).toString("base64")}`), /凭据密文长度无效/);

    // 手工构造非法 UTF-8 明文（Rust String::from_utf8 会拒绝）。
    const nonce = randomBytes(12);
    const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 }) as never as {
      update(data: Buffer): Buffer;
      final(): Buffer;
      getAuthTag(): Buffer;
    };
    const ciphertext = Buffer.concat([cipher.update(Buffer.from([0xff, 0xfe, 0xfd])), cipher.final()]);
    const tag = cipher.getAuthTag();
    const invalidUtf8 = `v1:${Buffer.concat([nonce, ciphertext, tag]).toString("base64")}`;
    assert.throws(() => box.decrypt(invalidUtf8), /凭据明文不是合法 UTF-8/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("secret.key 非法内容：格式错误/长度错误按 Rust 文案报错", () => {
  const badFormatDir = tempDir("bad-format");
  const badLengthDir = tempDir("bad-length");
  try {
    mkdirSync(badFormatDir, { recursive: true });
    writeKeyFile(badFormatDir, "zzzz");
    assert.throws(() => SecretBox.loadOrCreate(badFormatDir), /凭据密钥文件格式无效/);
    writeKeyFile(badLengthDir, "aabb");
    assert.throws(() => SecretBox.loadOrCreate(badLengthDir), /凭据密钥长度无效：期望 32 字节，实际 2 字节/);
  } finally {
    rmSync(badFormatDir, { recursive: true, force: true });
    rmSync(badLengthDir, { recursive: true, force: true });
  }
});

function writeKeyFile(dir: string, content: string): void {
  const file = path.join(dir, "secret.key");
  writeFileSync(file, content);
  chmodSync(file, 0o600);
}

// ─── service_credentials CRUD ────────────────────────────────────────────────

function sampleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cred-1",
    name: "GitLab 主库",
    provider: "gitlab",
    base_url: "https://gitlab.example.com",
    secret_ciphertext: "v1:fake",
    secret_hint: "••••a1b2",
    kind: "cli_token",
    note: "公司实例",
    enabled: true,
    created_at: "2026-11-10T00:00:00Z",
    updated_at: "2026-11-10T00:00:00Z",
    last_verified_at: null,
    last_error: null,
    env_prefix: null,
    ...overrides,
  };
}

test("service_credentials：CRUD / 排序 / enabled 往返 / verification 语义", () => {
  const dir = tempDir("crud");
  try {
    const storage = new SqliteStorage(path.join(dir, "flowlet.sqlite"));
    try {
      assert.deepEqual(storage.listServiceCredentials(), []);
      storage.upsertServiceCredential(
        sampleRow({ id: "cred-b", name: "B", created_at: "2026-11-10T00:00:02Z", env_prefix: "NA" }),
      );
      storage.upsertServiceCredential(sampleRow({ id: "cred-a", name: "A", created_at: "2026-11-10T00:00:01Z", enabled: false }));
      storage.upsertServiceCredential(sampleRow({ id: "cred-c", name: "A", created_at: "2026-11-10T00:00:01Z" }));
      // ORDER BY created_at ASC, name ASC
      assert.deepEqual(
        storage.listServiceCredentials().map((row) => row.id),
        ["cred-a", "cred-c", "cred-b"],
      );

      const fetched = storage.getServiceCredential("cred-a");
      assert.ok(fetched);
      assert.equal(fetched.enabled, false);
      assert.equal(fetched.note, "公司实例");
      assert.equal(fetched.last_verified_at, null);
      assert.equal(fetched.env_prefix, null);
      assert.equal(storage.getServiceCredential("cred-b")!.env_prefix, "NA");
      assert.equal(storage.getServiceCredential("missing"), null);

      // upsert 不覆盖 created_at，其余字段更新。
      storage.upsertServiceCredential(
        sampleRow({
          id: "cred-a",
          name: "A2",
          enabled: true,
          created_at: "2030-01-01T00:00:00Z",
          updated_at: "2026-11-10T01:00:00Z",
        }),
      );
      const updated = storage.getServiceCredential("cred-a")!;
      assert.equal(updated.name, "A2");
      assert.equal(updated.enabled, true);
      assert.equal(updated.created_at, "2026-11-10T00:00:01Z");

      // verification：verifiedAt 有值→写入；null→保留旧值；last_error 总是覆盖。
      storage.updateServiceCredentialVerification("cred-a", "2026-11-10T02:00:00Z", "401 Unauthorized");
      let row = storage.getServiceCredential("cred-a")!;
      assert.equal(row.last_verified_at, "2026-11-10T02:00:00Z");
      assert.equal(row.last_error, "401 Unauthorized");
      storage.updateServiceCredentialVerification("cred-a", "2026-11-10T03:00:00Z", null);
      row = storage.getServiceCredential("cred-a")!;
      assert.equal(row.last_verified_at, "2026-11-10T03:00:00Z");
      assert.equal(row.last_error, null);
      storage.updateServiceCredentialVerification("cred-a", null, "network error");
      row = storage.getServiceCredential("cred-a")!;
      assert.equal(row.last_verified_at, "2026-11-10T03:00:00Z", "null verifiedAt 保留旧值");
      assert.equal(row.last_error, "network error");

      assert.equal(storage.deleteServiceCredential("cred-a"), true);
      assert.equal(storage.deleteServiceCredential("cred-a"), false);
      assert.equal(storage.listServiceCredentials().length, 2);
    } finally {
      storage.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("密码掩码与视图：maskSecret / toServiceCredentialView 与 Rust 一致", async () => {
  const { toServiceCredentialView } = await import("../credentials.ts");
  assert.equal(maskSecret("glpat-1234567890"), "••••7890");
  assert.equal(maskSecret("abc"), "••••");
  assert.equal(maskSecret("abcd"), "••••");
  const view = toServiceCredentialView(sampleRow());
  assert.equal(view.baseUrl, "https://gitlab.example.com");
  assert.equal(view.secretHint, "••••a1b2");
  assert.equal(view.createdAt, "2026-11-10T00:00:00Z");
  assert.equal(view.envPrefix, "GITLAB");
  assert.equal("secret_ciphertext" in view, false);
  assert.equal("env_prefix" in view, false);
  // 旧行 NULL → provider 默认；新行用存下来的大写前缀。
  assert.equal(toServiceCredentialView(sampleRow({ env_prefix: "NA" })).envPrefix, "NA");
  assert.equal(
    toServiceCredentialView(sampleRow({ provider: "dockhand", env_prefix: null })).envPrefix,
    "DOCKHAND",
  );
  assert.equal(credentialTimestamp(new Date("2026-11-10T02:03:04.567Z")), "2026-11-10T02:03:04Z");
});

// ─── 跨实现（Rust debug headless oracle） ────────────────────────────────────

const MOCK_PORT = 18703;
const RUST_BIND = "127.0.0.1:18701";
const RUST_WEB = "127.0.0.1:18702";

async function withMockGitlab(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer((request, response) => {
    if (request.url === "/api/v4/user") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: 1, username: "mock-user" }));
      return;
    }
    if (request.url === "/api/v4/version") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: "17.0.0-mock" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "404 Not Found" }));
  });
  await new Promise<void>((resolve) => server.listen(MOCK_PORT, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${MOCK_PORT}`);
  } finally {
    server.close();
  }
}

test("跨实现：Node 写库 + Node 生成 secret.key → Rust export_service_credentials 解出明文", { skip: !hasRustOracle }, async () => {
  const dir = tempDir("node-to-rust");
  try {
    const token = `glpat-node-${randomBytes(6).toString("hex")}`;
    const secrets = SecretBox.loadOrCreate(dir);
    const storage = new SqliteStorage(path.join(dir, "flowlet.sqlite"));
    try {
      const timestamp = credentialTimestamp();
      storage.upsertServiceCredential({
        id: "cred-node",
        name: "Node 写入",
        provider: "gitlab",
        base_url: `http://127.0.0.1:${MOCK_PORT}`,
        secret_ciphertext: secrets.encrypt(token),
        secret_hint: maskSecret(token),
        kind: "cli_token",
        note: null,
        enabled: true,
        created_at: timestamp,
        updated_at: timestamp,
        last_verified_at: timestamp,
        last_error: null,
      });
    } finally {
      storage.close();
    }
    const rust = await startRust(dir, RUST_BIND, RUST_WEB);
    let exported: Array<Record<string, string>> = [];
    let listed: Array<Record<string, unknown>> = [];
    try {
      exported = (await webCommand(RUST_WEB, "export_service_credentials")) as Array<Record<string, string>>;
      listed = (await webCommand(RUST_WEB, "list_service_credentials")) as Array<Record<string, unknown>>;
    } finally {
      await stopRust(rust);
    }
    assert.equal(exported.length, 1);
    assert.equal(exported[0].token, token, "Rust 必须能解密 Node 写的密文");
    assert.equal(exported[0].name, "Node 写入");
    assert.equal(exported[0].provider, "gitlab");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].secretHint, maskSecret(token));
    assert.equal(listed[0].secretCiphertext, undefined, "视图不得包含密文/明文");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("跨实现：Rust 写库（mock GitLab 校验）→ Node 用同一 secret.key 解密", { skip: !hasRustOracle }, async () => {
  const dir = tempDir("rust-to-node");
  try {
    const token = `glpat-rust-${randomBytes(6).toString("hex")}`;
    await withMockGitlab(async (baseUrl) => {
      const rust = await startRust(dir, RUST_BIND, RUST_WEB);
      try {
        const view = (await webCommand(RUST_WEB, "save_service_credential", {
          input: {
            name: "Rust 写入",
            provider: "gitlab",
            baseUrl,
            token,
            kind: "cli_token",
            note: "rust-created",
            enabled: true,
          },
          insecure: true,
        })) as Record<string, unknown>;
        assert.equal(view.secretHint, maskSecret(token));
      } finally {
        await stopRust(rust);
      }
    });

    // Rust 创建了 secret.key 与 SQLite；Node 用同一目录加载。
    assert.ok(existsSync(secretKeyPath(dir)), "Rust 应已生成 secret.key");
    const secrets = SecretBox.loadOrCreate(dir);
    const storage = new SqliteStorage(path.join(dir, "flowlet.sqlite"));
    try {
      const rows = storage.listServiceCredentials();
      assert.equal(rows.length, 1);
      const row = rows[0];
      assert.equal(row.name, "Rust 写入");
      assert.equal(row.provider, "gitlab");
      assert.equal(row.enabled, true);
      assert.equal(row.secret_hint, maskSecret(token));
      assert.ok(row.last_verified_at, "Rust 保存后应记录校验时间");
      assert.equal(row.last_error, null);
      assert.equal(secrets.decrypt(String(row.secret_ciphertext)), token, "Node 必须能解密 Rust 写的密文");
    } finally {
      storage.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// ─── schema 迁移（phase2 spec §1.3：只 ALTER TABLE ADD COLUMN，不重建表） ────

const LEGACY_SERVICE_CREDENTIALS_SQL = `
CREATE TABLE service_credentials (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    provider           TEXT NOT NULL,
    base_url           TEXT NOT NULL,
    secret_ciphertext  TEXT NOT NULL,
    secret_hint        TEXT NOT NULL,
    kind               TEXT NOT NULL DEFAULT 'cli_token',
    note               TEXT,
    enabled            INTEGER NOT NULL DEFAULT 1,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    last_verified_at   TEXT,
    last_error         TEXT
);
`;

test("迁移：旧库 service_credentials 幂等补 env_prefix 列，旧行保留 NULL 且数据不丢", () => {
  const dir = tempDir("migrate-env-prefix");
  const dbPath = path.join(dir, "flowlet.sqlite");
  try {
    // 模拟第一期数据库：表已存在但没有 env_prefix 列。
    const legacy = new DatabaseSync(dbPath);
    try {
      legacy.exec(LEGACY_SERVICE_CREDENTIALS_SQL);
      legacy
        .prepare(
          `INSERT INTO service_credentials (
             id, name, provider, base_url, secret_ciphertext, secret_hint, kind, note,
             enabled, created_at, updated_at, last_verified_at, last_error
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
        )
        .run(
          "legacy-cred",
          "旧凭据",
          "gitlab",
          "https://gitlab.example.com",
          "v1:fake",
          "••••a1b2",
          "cli_token",
          null,
          1,
          "2026-11-10T00:00:00Z",
          "2026-11-10T00:00:00Z",
          null,
          null,
        );
      assert.equal(tableHasColumn(legacy, "service_credentials", "env_prefix"), false);
    } finally {
      legacy.close();
    }

    // 生产入口（SqliteStorage 构造）执行 migrate。
    const storage = new SqliteStorage(dbPath);
    try {
      const rows = storage.listServiceCredentials();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, "旧凭据");
      assert.equal(rows[0].env_prefix, null, "旧行读取为 NULL，由业务层按 provider 默认解析");
      // 新行写入解析后的前缀，upsert 可覆盖旧行。
      storage.upsertServiceCredential({ ...rows[0], env_prefix: "GITLAB" });
      assert.equal(storage.getServiceCredential("legacy-cred")!.env_prefix, "GITLAB");
    } finally {
      storage.close();
    }

    // 幂等：再次迁移不报错、不重建表、不丢数据。
    const verify = new DatabaseSync(dbPath);
    try {
      assert.equal(tableHasColumn(verify, "service_credentials", "env_prefix"), true);
      migrate(verify);
      migrate(verify);
      addColumnIfMissing(verify, "service_credentials", "env_prefix", "TEXT");
      assert.equal(tableHasColumn(verify, "service_credentials", "env_prefix"), true);
      const row = verify
        .prepare("SELECT name, provider, env_prefix FROM service_credentials WHERE id = ?1")
        .get("legacy-cred") as Record<string, unknown>;
      assert.equal(row.name, "旧凭据");
      assert.equal(row.provider, "gitlab");
      assert.equal(row.env_prefix, "GITLAB");
    } finally {
      verify.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("新库：service_credentials 建表即含 env_prefix；无旧列残留", () => {
  const dir = tempDir("fresh-env-prefix");
  try {
    const storage = new SqliteStorage(path.join(dir, "flowlet.sqlite"));
    try {
      assert.equal(storage.listServiceCredentials().length, 0);
    } finally {
      storage.close();
    }
    const db = new DatabaseSync(path.join(dir, "flowlet.sqlite"));
    try {
      assert.equal(tableHasColumn(db, "service_credentials", "env_prefix"), true);
      const row = db
        .prepare(
          `SELECT name, type, "notnull" AS not_null, dflt_value
             FROM pragma_table_info('service_credentials') WHERE name = 'env_prefix'`,
        )
        .get() as Record<string, unknown>;
      assert.equal(row.type, "TEXT");
      assert.equal(row.not_null, 0, "env_prefix 必须可空，旧行保持 NULL");
      assert.equal(row.dflt_value, null);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
