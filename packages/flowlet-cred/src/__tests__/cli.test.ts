// flowlet-cred Node CLI 端到端测试。Owner: node-web。
//
// 运行：node --test packages/flowlet-cred/src/__tests__/
// 全部用例通过 spawn 真实 CLI 进程（与 Agent 实际用法一致），并使用独立临时目录 +
// mock GitLab（CE 10.8.7 语义）与 mock Flowlet Web Host（export_service_credentials）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "..", "cli.ts");
const RUST_CLI = "/home/nichangen/代码/self-code/flowlet/src-tauri/target/debug/flowlet-cred";

const GITLAB_TOKEN = "glpat-test-fixture-token-1a2b";
const ADMIN_TOKEN = "flowlet-admin-token-0123456789";
const HEADER = [
  "# Flowlet 全局凭据库",
  "# 由 `flowlet-cred` 维护；请在 CLI 中增删（原子写 + 0600），不要手工重排此文件。",
  "# 读取：Agent 可 cat 本文件；写入：请用 `flowlet-cred set KEY`。",
].join("\n");

const cleanup: Array<() => void> = [];
after(() => {
  for (const fn of cleanup.reverse()) fn();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "flowlet-cred-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function cli(
  dir: string,
  args: string[],
  options: { input?: string; env?: Record<string, string | undefined>; cliPath?: string } = {},
): CliResult {
  const env: NodeJS.ProcessEnv = { ...process.env, FLOWLET_CRED_DIR: dir };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync(process.execPath, [options.cliPath ?? CLI, ...args], {
    input: options.input ?? "",
    env,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function read(dir: string, name: string): string {
  return readFileSync(path.join(dir, name), "utf8");
}

function envFile(dir: string): string {
  return read(dir, "credentials.env");
}

function metaFile(dir: string): string {
  return read(dir, "credentials.json");
}

function normalized(text: string, dir: string): string {
  return text
    .split(dir)
    .join("<DIR>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, "<TS>");
}

function modeOf(target: string): number {
  return statSync(target).mode & 0o777;
}

// ─── Mock GitLab CE 10.8.7 ─────────────────────────────────────────────────

class MockGitlab {
  #server: Server | null = null;
  baseUrl = "";
  subpath = "/gitlab";
  versionStatus = 200;
  hiddenVersion = false;
  projectPages: Array<Array<Record<string, unknown>>> = [];
  requests: string[] = [];

  async start(): Promise<void> {
    this.#server = createHttpServer((request, response) => {
      void this.#handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(0, "127.0.0.1", () => {
        const address = this.#server!.address();
        const port = typeof address === "object" && address ? address.port : 0;
        this.baseUrl = `http://127.0.0.1:${port}${this.subpath}`;
        resolve();
      });
    });
    cleanup.push(() => this.#server?.close());
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    this.requests.push(`${request.method} ${url.pathname}${url.search}`);
    const token = request.headers["private-token"];
    const send = (status: number, value: unknown, headers: Record<string, string> = {}): void => {
      const body = Buffer.from(JSON.stringify(value), "utf8");
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": String(body.length),
        ...headers,
      });
      response.end(body);
    };
    const suffix = url.pathname.startsWith(this.subpath)
      ? url.pathname.slice(this.subpath.length)
      : url.pathname;
    if (suffix === "/api/v4/user") {
      if (token !== GITLAB_TOKEN) return send(401, { message: "401 Unauthorized" });
      return send(200, { id: 7, username: "fixture", name: "Fixture User" });
    }
    if (suffix === "/api/v4/version") {
      if (this.hiddenVersion) return send(404, { message: "404 Not Found" });
      if (this.versionStatus !== 200) return send(this.versionStatus, { message: "403 Forbidden" });
      if (token !== GITLAB_TOKEN) return send(401, { message: "401 Unauthorized" });
      return send(200, { version: "10.8.7" });
    }
    if (suffix === "/api/v4/projects") {
      if (token !== GITLAB_TOKEN) return send(401, { message: "401 Unauthorized" });
      const page = Number(url.searchParams.get("page") ?? "1");
      const batch = this.projectPages[page - 1] ?? [];
      const headers: Record<string, string> = { "x-page": String(page) };
      if (page < this.projectPages.length) headers["x-next-page"] = String(page + 1);
      headers["x-total"] = String(this.projectPages.flat().length);
      return send(200, batch, headers);
    }
    send(404, { message: "404 Not Found" });
  }
}

// ─── Mock Flowlet Web Host（export_service_credentials） ───────────────────

class MockFlowletWeb {
  #server: Server | null = null;
  baseUrl = "";
  entries: Array<Record<string, string>> = [];
  requestCount = 0;

  async start(): Promise<void> {
    this.#server = createHttpServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        this.requestCount += 1;
        const authorized = request.headers.authorization === `Bearer ${ADMIN_TOKEN}`;
        const body = Buffer.from(
          JSON.stringify(
            authorized ? this.entries : { code: "unauthorized", message: "管理凭据无效，请重新登录" },
          ),
          "utf8",
        );
        response.writeHead(authorized ? 200 : 401, {
          "content-type": "application/json",
          "content-length": String(body.length),
        });
        response.end(body);
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(0, "127.0.0.1", () => {
        const address = this.#server!.address();
        const port = typeof address === "object" && address ? address.port : 0;
        this.baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
    cleanup.push(() => this.#server?.close());
  }
}

// ─── 本地凭据库 ─────────────────────────────────────────────────────────────

describe("本地凭据库", () => {
  it("init：创建目录/文件、权限 700/600、固定文件头", () => {
    const dir = tempDir();
    const result = cli(dir, ["init"]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `已初始化：${path.join(dir, "credentials.env")}\n`);
    assert.equal(envFile(dir), `${HEADER}\n`);
    assert.equal(metaFile(dir), "{}");
    assert.equal(modeOf(dir), 0o700);
    assert.equal(modeOf(path.join(dir, "credentials.env")), 0o600);
    assert.equal(modeOf(path.join(dir, "credentials.json")), 0o600);
    // 二次 init 保留内容
    writeFileSync(path.join(dir, "credentials.env"), `${HEADER}\nKEEP=1\n`);
    assert.equal(cli(dir, ["init"]).status, 0);
    assert.equal(envFile(dir), `${HEADER}\nKEEP=1\n`);
  });

  it("set（stdin）+ list 文本/JSON + get 默认掩码/--reveal/--mask", () => {
    const dir = tempDir();
    assert.equal(cli(dir, ["set", "GH_PAT", "--kind=cli_token", "--note=github"], { input: "ghp_abcdefghijk\r\n" }).status, 0);
    assert.equal(cli(dir, ["set", "OPENAI_API_KEY", "--value=sk-test-123"], {}).stdout, "已保存 OPENAI_API_KEY [api_key]\n");
    const list = cli(dir, ["list"]);
    assert.equal(list.status, 0);
    assert.match(list.stdout, /^GH_PAT {2}\[cli_token\] {2}# github {2}\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\)$/m);
    assert.match(list.stdout, /^OPENAI_API_KEY {2}\[api_key\] {2}\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\)$/m);
    const json = cli(dir, ["list", "--json"]);
    const entries = JSON.parse(json.stdout) as Array<Record<string, unknown>>;
    assert.deepEqual(Object.keys(entries[0]!), ["key", "kind", "note", "created_at", "updated_at"]);
    assert.equal(entries[0]!.note, "github");

    assert.equal(cli(dir, ["get", "GH_PAT"]).stdout, "ghp_…hijk\n");
    assert.equal(cli(dir, ["get", "GH_PAT", "--mask"]).stdout, "ghp_…hijk\n");
    assert.equal(cli(dir, ["get", "GH_PAT", "--reveal"]).stdout, "ghp_abcdefghijk\n");

    const missing = cli(dir, ["get", "NOPE"]);
    assert.equal(missing.status, 1);
    assert.equal(missing.stderr, "凭据不存在：NOPE\n");
    const invalid = cli(dir, ["get", "1BAD"]);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /非法的凭据名/);
  });

  it("tricky 值单引号编码与回读；短值掩码规则", () => {
    const dir = tempDir();
    const tricky = "a b $HOME `x` it's";
    cli(dir, ["set", "TRICKY"], { input: tricky });
    assert.ok(envFile(dir).includes(`TRICKY='a b $HOME \`x\` it'\\''s'`));
    assert.equal(cli(dir, ["get", "TRICKY", "--reveal"]).stdout, `${tricky}\n`);
    cli(dir, ["set", "SHORT", "--value=abc"]);
    assert.equal(cli(dir, ["get", "SHORT"]).stdout, "•••\n");
    cli(dir, ["set", "EIGHT", "--value=12345678"]);
    assert.equal(cli(dir, ["get", "EIGHT"]).stdout, "••••••••\n");
    cli(dir, ["set", "NINE", "--value=123456789"]);
    assert.equal(cli(dir, ["get", "NINE"]).stdout, "1234…6789\n");
  });

  it("非法键/非法类型/空值/未知格式的错误文案", () => {
    const dir = tempDir();
    assert.equal(cli(dir, ["set", "1BAD", "--value=x"]).stderr, "非法的凭据名 `1BAD`：只能使用字母、数字和下划线，且不能以数字开头\n");
    assert.equal(
      cli(dir, ["set", "OK", "--kind=Bad Kind", "--value=x"]).stderr,
      "非法的凭据类型 `Bad Kind`：使用小写字母、数字、下划线或连字符（如 api_key / cli_token / mcp_token）\n",
    );
    assert.equal(cli(dir, ["set", "EMPTY"], { input: "" }).stderr, "凭据值不能为空（用 stdin 或 --value=V 传入）\n");
    assert.equal(cli(dir, ["export", "--format=yaml"]).stderr, "未知格式：yaml（dotenv|shell|json）\n");
    assert.equal(cli(dir, ["nope"]).status, 1);
    assert.match(cli(dir, ["nope"]).stderr, /未知命令：nope/);
  });

  it("env/export：--only 顺序、缺失键报错、json 排序", () => {
    const dir = tempDir();
    cli(dir, ["set", "B_KEY", "--value=two words"]);
    cli(dir, ["set", "A_KEY", "--value=one"]);
    assert.equal(cli(dir, ["env"]).stdout, "B_KEY='two words'\nA_KEY=one\n");
    assert.equal(cli(dir, ["env", "--only=A_KEY"]).stdout, "A_KEY=one\n");
    assert.equal(cli(dir, ["env", "--only=MISSING"]).status, 1);
    assert.equal(cli(dir, ["export", "--only=B_KEY", "--format=shell"]).stdout, "export B_KEY='two words';\n");
    assert.equal(cli(dir, ["export", "--format=json"]).stdout, '{\n  "A_KEY": "one",\n  "B_KEY": "two words"\n}\n');
  });

  it("unset/clear：删除单键、清空保留注释与文件头", () => {
    const dir = tempDir();
    cli(dir, ["init"]);
    const file = path.join(dir, "credentials.env");
    writeFileSync(file, `${HEADER}\n# keep me\nA=1\nB=2\n`);
    const unset = cli(dir, ["unset", "A"]);
    assert.equal(unset.stdout, "已删除 A\n");
    assert.ok(envFile(dir).includes("# keep me"));
    assert.ok(!envFile(dir).includes("A=1"));
    assert.equal(cli(dir, ["unset", "A"]).stdout, "凭据不存在：A\n");
    const cleared = cli(dir, ["clear"]);
    assert.match(cleared.stdout, /已清空全部凭据/);
    assert.ok(envFile(dir).includes("# keep me"));
    assert.ok(!envFile(dir).includes("B=2"));
    assert.equal(metaFile(dir).trim(), "{}");
  });

  it("run：只把指定凭据注入子进程环境、退出码透传、参数校验", () => {
    const dir = tempDir();
    cli(dir, ["set", "SECRET_ONE", "--value=value-one"]);
    cli(dir, ["set", "SECRET_TWO", "--value=value-two"]);
    const child = `console.log(process.env.SECRET_ONE); console.log(process.env.SECRET_TWO ?? "unset")`;
    const result = cli(dir, ["run", "--with=SECRET_ONE", "--", process.execPath, "-e", child]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "value-one\nunset\n");
    assert.ok(!result.stdout.includes("value-two"));
    const exitCode = cli(dir, ["run", "--with=SECRET_ONE", "--", process.execPath, "-e", "process.exit(7)"]);
    assert.equal(exitCode.status, 7);
    assert.equal(cli(dir, ["run", "--", "true"]).stderr, "run 需要 --with=A,B 指定要注入的凭据名\n");
    assert.equal(cli(dir, ["run", "--with=SECRET_ONE", "true"]).stderr, "run 需要 `--` 分隔符，例如：flowlet-cred run --with=GITHUB_PAT -- gh pr list\n");
    assert.equal(cli(dir, ["run", "--with=MISSING", "--", "true"]).stderr, "凭据不存在：MISSING\n");
  });

  it("doctor：未初始化、重复键、缺元数据、权限告警", () => {
    const dir = tempDir();
    const uninitialized = cli(dir, ["doctor"]);
    assert.match(uninitialized.stdout, /状态：尚未初始化/);
    cli(dir, ["init"]);
    const file = path.join(dir, "credentials.env");
    writeFileSync(file, `${HEADER}\nDUP=one\nDUP=two\nKEY_ONE=value\n`);
    chmodSync(file, 0o644);
    const report = cli(dir, ["doctor"]).stdout;
    assert.match(report, /警告：环境文件权限为 644/);
    assert.match(report, /警告：重复的键（后者生效）：DUP/);
    assert.match(report, /提示：缺少元数据的键：DUP, KEY_ONE/);
    assert.equal(cli(dir, ["get", "DUP", "--reveal"]).stdout, "two\n");
  });

  it("注释/空行/非法行保留，且原子写不残留临时文件", () => {
    const dir = tempDir();
    cli(dir, ["init"]);
    const file = path.join(dir, "credentials.env");
    const current = envFile(dir);
    writeFileSync(file, `${current}\n# handwritten\nnot a pair\nKEY_ONE=value\n`);
    cli(dir, ["set", "KEY_TWO", "--value=v2"]);
    const text = envFile(dir);
    assert.ok(text.includes("# handwritten"));
    assert.ok(text.includes("not a pair"));
    assert.ok(text.includes("KEY_ONE=value"));
    assert.ok(text.includes("KEY_TWO=v2"));
    // Rust 行为：每次写入都会再前置一次固定文件头（历史注释因此累积），Node 逐字节兼容。
    assert.equal(text.split(HEADER).length - 1, 3);
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes(".tmp-")),
      [],
    );
  });
});

// ─── GitLab 子命令 ─────────────────────────────────────────────────────────

describe("gitlab 子命令", () => {
  it("gitlab set：先校验后落库，URL 归一/子路径，KIND/备注写入", async () => {
    const mock = new MockGitlab();
    await mock.start();
    const dir = tempDir();
    const ok = cli(dir, ["gitlab", "set", `--url=${mock.baseUrl}/`], { input: GITLAB_TOKEN });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, `已保存 GitLab 凭据：http://127.0.0.1:${new URL(mock.baseUrl).port}/gitlab/api/v4\n用户：Fixture User (@fixture) id=7\n`);
    const meta = JSON.parse(metaFile(dir)) as Record<string, Record<string, unknown>>;
    assert.equal(meta.GITLAB_URL!.kind, "service");
    assert.equal(meta.GITLAB_URL!.note, "gitlab 实例地址（API v4）");
    assert.equal(meta.GITLAB_TOKEN!.kind, "cli_token");
    assert.equal(cli(dir, ["get", "GITLAB_URL", "--reveal"]).stdout, `${mock.baseUrl}\n`);
  });

  it("gitlab set：token 无效时不落库", async () => {
    const mock = new MockGitlab();
    await mock.start();
    const dir = tempDir();
    const failed = cli(dir, ["gitlab", "set", `--url=${mock.baseUrl}`], { input: "glpat-wrong" });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /^GitLab API 401: 401 Unauthorized（token 无效或已过期/);
    assert.match(failed.stderr, /未保存。请检查实例地址、token 是否有效（需要 api scope）。/);
    assert.ok(!existsSync(path.join(dir, "credentials.env")) || !envFile(dir).includes("GITLAB_URL"));
  });

  it("gitlab status：10.8.7 / 403 降级 / 未配置错误", async () => {
    const mock = new MockGitlab();
    await mock.start();
    const dir = tempDir();
    cli(dir, ["gitlab", "set", `--url=${mock.baseUrl}`], { input: GITLAB_TOKEN });
    const status = cli(dir, ["gitlab", "status"]);
    assert.equal(status.stdout, `API：${mock.baseUrl}/api/v4\n用户：Fixture User (@fixture) id=7\n版本：10.8.7\n`);
    mock.versionStatus = 403;
    assert.match(cli(dir, ["gitlab", "status"]).stdout, /版本：未知（\/version 需要管理员 token/);
    const empty = cli(tempDir(), ["gitlab", "status"]);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /尚未配置 GitLab 地址/);
  });

  it("gitlab projects：分页/--limit/--json/空结果", async () => {
    const mock = new MockGitlab();
    await mock.start();
    mock.projectPages = [
      [
        { id: 42, path_with_namespace: "group/app", name: "app", default_branch: "main", visibility: "private" },
      ],
      [{ id: 7, path_with_namespace: "team/svc", name: "svc" }],
    ];
    const dir = tempDir();
    cli(dir, ["gitlab", "set", `--url=${mock.baseUrl}`], { input: GITLAB_TOKEN });
    const list = cli(dir, ["gitlab", "projects"]);
    assert.match(list.stdout, /^ {7}42 {2}group\/app {2}main {2}private$/);
    assert.match(list.stdout, /^ {7}7 {2}team\/svc$/);
    const json = JSON.parse(cli(dir, ["gitlab", "projects", "--json", "--limit=1"]).stdout) as unknown[];
    assert.equal(json.length, 1);
    mock.projectPages = [];
    assert.equal(cli(dir, ["gitlab", "projects"]).stdout, "（没有匹配的项目）\n");
    assert.equal(cli(dir, ["gitlab", "projects", "--limit=abc"]).stderr, "--limit 需要整数\n");
  });

  it("gitlab api：默认 GET、显式方法、绝对 URL 拒绝、分页提示", async () => {
    const mock = new MockGitlab();
    await mock.start();
    const dir = tempDir();
    cli(dir, ["gitlab", "set", `--url=${mock.baseUrl}`], { input: GITLAB_TOKEN });
    const user = cli(dir, ["gitlab", "api", "/user"]);
    assert.equal(user.status, 0);
    assert.equal(JSON.parse(user.stdout).username, "fixture");
    const explicit = cli(dir, ["gitlab", "api", "GET", "/version"]);
    assert.equal(JSON.parse(explicit.stdout).version, "10.8.7");
    mock.projectPages = [[{ id: 1, path_with_namespace: "g/a" }]];
    const projects = cli(dir, ["gitlab", "api", "/projects"]);
    assert.match(projects.stderr, /分页：page=Some\(1\) next=None total=Some\(1\)/);
    const absolute = cli(dir, ["gitlab", "api", "GET", "https://evil.example.com/x"]);
    assert.equal(absolute.status, 1);
    assert.match(absolute.stderr, /不接受绝对 URL/);
    const badData = cli(dir, ["gitlab", "api", "POST", "/projects", "--data=not-json"]);
    assert.match(badData.stderr, /--data 不是合法 JSON/);
  });

  it("gitlab env/clear：先检查是否已配置，clear 移除两把键", async () => {
    const mock = new MockGitlab();
    await mock.start();
    const dir = tempDir();
    assert.match(cli(dir, ["gitlab", "env"]).stderr, /尚未配置 GitLab 地址/);
    cli(dir, ["gitlab", "set", `--url=${mock.baseUrl}`], { input: GITLAB_TOKEN });
    const env = cli(dir, ["gitlab", "env"]);
    assert.match(env.stderr, /注意：下面输出包含明文 token/);
    assert.equal(env.stdout, `GITLAB_URL=${mock.baseUrl}\nGITLAB_TOKEN=${GITLAB_TOKEN}\n`);
    assert.equal(cli(dir, ["gitlab", "clear"]).stdout, "已移除 GitLab 凭据\n");
    assert.equal(cli(dir, ["gitlab", "clear"]).stdout, "没有可移除的 GitLab 凭据\n");
  });
});

// ─── pull（Flowlet Web Host → 本地 .env） ──────────────────────────────────

describe("pull", () => {
  it("成功写入 GITLAB_URL/GITLAB_TOKEN 并保留已有注释/非凭据键", async () => {
    const web = new MockFlowletWeb();
    await web.start();
    web.entries = [
      { name: "主实例", provider: "gitlab", baseUrl: "https://gitlab.example.com", token: "glpat-pulled-1" },
    ];
    const dir = tempDir();
    cli(dir, ["init"]);
    const file = path.join(dir, "credentials.env");
    writeFileSync(file, `${envFile(dir)}# keep\nOTHER_KEY=keep-me\n`);
    const pulled = cli(dir, ["pull", `--server=${web.baseUrl}/`, `--token=${ADMIN_TOKEN}`]);
    assert.equal(pulled.status, 0, pulled.stderr);
    assert.match(pulled.stdout, /已写入 GITLAB_URL（来自 gitlab \/ 主实例）/);
    assert.match(pulled.stdout, /已写入 GITLAB_TOKEN（来自 gitlab \/ 主实例）/);
    assert.match(pulled.stdout, /完成：写入 2 个键 → /);
    assert.equal(cli(dir, ["get", "GITLAB_URL", "--reveal"]).stdout, "https://gitlab.example.com\n");
    assert.equal(cli(dir, ["get", "OTHER_KEY", "--reveal"]).stdout, "keep-me\n");
    assert.ok(envFile(dir).includes("# keep"));
    const meta = JSON.parse(metaFile(dir)) as Record<string, Record<string, unknown>>;
    assert.equal(meta.GITLAB_TOKEN!.note, "gitlab / 主实例");
    assert.equal(meta.GITLAB_URL!.kind, "service");
  });

  it("--dry-run 不写文件；401 与空列表行为", async () => {
    const web = new MockFlowletWeb();
    await web.start();
    web.entries = [
      { name: "主实例", provider: "gitlab", baseUrl: "https://gitlab.example.com", token: "glpat-pulled-1" },
    ];
    const dir = tempDir();
    const dry = cli(dir, ["pull", `--server=${web.baseUrl}`, `--token=${ADMIN_TOKEN}`, "--dry-run"]);
    assert.equal(dry.status, 0);
    assert.match(dry.stdout, /将写入 GITLAB_URL/);
    assert.match(dry.stdout, /dry-run：未写入任何凭据/);
    assert.ok(!existsSync(path.join(dir, "credentials.env")));

    const unauthorized = cli(dir, ["pull", `--server=${web.baseUrl}`, "--token=wrong-admin-token"]);
    assert.equal(unauthorized.status, 1);
    assert.equal(unauthorized.stderr, "管理凭据无效（401）：请检查 --token / FLOWLET_ADMIN_TOKEN\n");

    web.entries = [];
    const empty = cli(dir, ["pull", `--server=${web.baseUrl}`, `--token=${ADMIN_TOKEN}`]);
    assert.equal(empty.stdout, "服务端没有启用中的服务凭据\n");

    assert.equal(cli(dir, ["pull", `--server=${web.baseUrl}`], { env: { FLOWLET_ADMIN_TOKEN: undefined } }).stderr, "缺少管理凭据：用 --token=... 或设置 FLOWLET_ADMIN_TOKEN\n");
    const fallback = cli(dir, ["pull", `--server=${web.baseUrl}`], {
      env: { FLOWLET_ADMIN_TOKEN: ADMIN_TOKEN },
    });
    assert.equal(fallback.status, 0);
    assert.equal(cli(dir, ["pull", "--server=ftp://x"]).stderr, "--server 必须是 http 或 https 地址\n");
  });

  it("未知服务类型跳过并写 stderr，不写该凭据", async () => {
    const web = new MockFlowletWeb();
    await web.start();
    web.entries = [
      { name: "未知", provider: "github", baseUrl: "https://github.com", token: "ghp-x" },
    ];
    const dir = tempDir();
    cli(dir, ["init"]);
    const pulled = cli(dir, ["pull", `--server=${web.baseUrl}`, `--token=${ADMIN_TOKEN}`]);
    assert.equal(pulled.status, 0);
    assert.ok(pulled.stderr.includes("跳过未知服务类型：github（未知）"));
    assert.ok(!envFile(dir).includes("GITHUB_URL"));
    assert.match(pulled.stdout, /完成：写入 0 个键/);
  });
});

// ─── 与 Rust legacy CLI 的兼容性（同序列、不同目录） ─────────────────────

const RUST_AVAILABLE = existsSync(RUST_CLI);

describe("Rust CLI 兼容性", { skip: !RUST_AVAILABLE }, () => {
  it("同一序列的 stdout/文件内容与 Rust 一致（时间戳归一化）", () => {
    const rustDir = tempDir();
    const nodeDir = tempDir();
    const sequence: Array<{ args: string[]; input?: string }> = [
      { args: ["init"] },
      { args: ["set", "LONGKEY", "--note=note here"], input: "abcdefgh1234" },
      { args: ["set", "TRICKY", "--kind=cli_token"], input: "a b $HOME `x` it's" },
      { args: ["list"] },
      { args: ["get", "LONGKEY", "--mask"] },
      { args: ["env"] },
      { args: ["export", "--format=json"] },
      { args: ["doctor"] },
      { args: ["unset", "LONGKEY"] },
    ];
    for (const step of sequence) {
      const rust = cli(rustDir, step.args, { input: step.input, cliPath: RUST_CLI });
      const node = cli(nodeDir, step.args, { input: step.input });
      assert.equal(node.status, rust.status, `exit for ${step.args.join(" ")}: ${node.stderr}`);
      assert.equal(
        normalized(node.stdout, nodeDir),
        normalized(rust.stdout, rustDir),
        `stdout for ${step.args.join(" ")}`,
      );
      assert.equal(normalized(node.stderr, nodeDir), normalized(rust.stderr, rustDir));
    }
    assert.equal(normalized(envFile(nodeDir), nodeDir), normalized(envFile(rustDir), rustDir));
    assert.equal(normalized(metaFile(nodeDir), nodeDir), normalized(metaFile(rustDir), rustDir));
    assert.equal(modeOf(path.join(nodeDir, "credentials.env")), modeOf(path.join(rustDir, "credentials.env")));
    assert.equal(modeOf(path.join(nodeDir, "credentials.json")), modeOf(path.join(rustDir, "credentials.json")));
  });

  it("交叉读取：Node 能读 Rust 写出的库，Rust 能读 Node 写出的库", () => {
    const rustDir = tempDir();
    const nodeDir = tempDir();
    cli(rustDir, ["set", "RUST_KEY"], { input: "rust-value", cliPath: RUST_CLI });
    cli(nodeDir, ["set", "NODE_KEY"], { input: "node-value" });

    // Node 读 Rust：list/get/env 一致
    assert.match(cli(rustDir, ["list"]).stdout, /^RUST_KEY {2}\[api_key\]/m);
    assert.equal(cli(rustDir, ["get", "RUST_KEY", "--mask"]).stdout, "rust…alue\n");
    // Rust 读 Node：list/get 一致
    assert.match(cli(nodeDir, ["list"], { cliPath: RUST_CLI }).stdout, /^NODE_KEY {2}\[api_key\]/m);
    assert.equal(cli(nodeDir, ["get", "NODE_KEY"], { cliPath: RUST_CLI }).stdout, "node-value\n");
    // 在 Node 写的库上继续用 Rust 写，Node 仍可读
    cli(nodeDir, ["set", "MIXED"], { input: "mixed", cliPath: RUST_CLI });
    assert.equal(cli(nodeDir, ["get", "MIXED", "--reveal"]).stdout, "mixed\n");
  });
});