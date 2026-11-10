// flowlet（Node CLI）端到端测试。Owner: node-web。
//
// 运行：node --test packages/flowlet-cred/src/__tests__/
// 全部用例通过 spawn 真实 CLI 进程（与 Agent 实际用法一致），并使用独立临时目录 +
// 独立子进程 mock GitLab（CE 10.8.7 语义）与 mock Flowlet Web Host。
// 注意：CLI 用 spawnSync 同步调用；因此 HTTP mock 必须跑在**子进程**里（见 mock-server.ts），
// 否则会阻塞本进程事件循环导致 mock 无法应答。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "..", "cli.ts");
const MOCK_SERVER = path.resolve(HERE, "mock-server.ts");
const RUST_CLI = "/home/nichangen/代码/self-code/flowlet/src-tauri/target/debug/flowlet-cred";

const GITLAB_TOKEN = "glpat-test-fixture-token-1a2b";
const DOCKHAND_TOKEN = "dockhand-test-fixture-token-9x8y";
const JENKINS_TOKEN = "jenkins-test-fixture-token-7q2w";
const BESZEL_EMAIL = "fixture@example.com";
const BESZEL_PASSWORD = "beszel-test-fixture-password-8k3m";
const REGISTRY_USER = "robot$flowlet+pull";
const REGISTRY_PASSWORD = "registry-test-fixture-password-4h6k";
const ADMIN_TOKEN = "flowlet-admin-token-0123456789";
const HEADER = [
  "# Flowlet 全局凭据库",
  "# 由 `flowlet` 维护；请在 CLI 中增删（原子写 + 0600），不要手工重排此文件。",
  "# 读取：Agent 可 cat 本文件；写入：请用 `flowlet set KEY`。",
].join("\n");

const processes: Array<import("node:child_process").ChildProcess> = [];
const tempDirs: string[] = [];
after(() => {
  for (const child of processes) child.kill("SIGKILL");
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "flowlet-cred-test-"));
  tempDirs.push(dir);
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
  options: { input?: string; env?: Record<string, string | undefined>; rust?: boolean } = {},
): CliResult {
  const env: NodeJS.ProcessEnv = { ...process.env, FLOWLET_CRED_DIR: dir };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const command = options.rust === true ? RUST_CLI : process.execPath;
  const argv = options.rust === true ? args : [CLI, ...args];
  const result = spawnSync(command, argv, { input: options.input ?? "", env, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function startMock(options: Record<string, unknown>): Promise<{ baseUrl: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MOCK_SERVER, JSON.stringify(options)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    processes.push(child);
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const match = /PORT (\d+)\n/.exec(buffer);
      if (match === null) return;
      child.stdout.off("data", onData);
      const port = Number(match[1]);
      const mode = options.mode;
      resolve({
        baseUrl:
          mode === "gitlab"
            ? `http://127.0.0.1:${port}/gitlab`
            : `http://127.0.0.1:${port}`,
        close: () => child.kill("SIGKILL"),
      });
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    setTimeout(() => reject(new Error("mock server 启动超时")), 10_000).unref();
  });
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
  return text.split(dir).join("<DIR>").replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, "<TS>");
}

function modeOf(target: string): number {
  return statSync(target).mode & 0o777;
}

/** `{PREFIX}_HOST` 的值是 host[:port]（无 scheme），从 mock 的 origin 提取。 */
function hostOf(baseUrl: string): string {
  return new URL(baseUrl).host;
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
    // Windows 没有 POSIX 权限位（chmod/stat 恒为 0666），权限断言只在 POSIX 生效。
    if (process.platform !== "win32") {
      assert.equal(modeOf(dir), 0o700);
      assert.equal(modeOf(path.join(dir, "credentials.env")), 0o600);
      assert.equal(modeOf(path.join(dir, "credentials.json")), 0o600);
    }
    writeFileSync(path.join(dir, "credentials.env"), `${HEADER}\nKEEP=1\n`);
    assert.equal(cli(dir, ["init"]).status, 0);
    assert.equal(envFile(dir), `${HEADER}\nKEEP=1\n`);
  });

  it("set（stdin）+ list 文本/JSON + get 默认掩码/--reveal/--mask", () => {
    const dir = tempDir();
    assert.equal(cli(dir, ["set", "GH_PAT", "--kind=cli_token", "--note=github"], { input: "ghp_abcdefghijk\r\n" }).status, 0);
    assert.equal(cli(dir, ["set", "OPENAI_API_KEY", "--value=sk-test-123"], {}).stdout, "已保存 OPENAI_API_KEY [api_key]\n");
    const list = cli(dir, ["list"]);
    assert.match(list.stdout, /^GH_PAT {2}\[cli_token\] {2}# github {2}\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\)$/m);
    assert.match(list.stdout, /^OPENAI_API_KEY {2}\[api_key\] {2}\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\)$/m);
    const entries = JSON.parse(cli(dir, ["list", "--json"]).stdout) as Array<Record<string, unknown>>;
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
    const unknown = cli(dir, ["nope"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /未知命令：nope/);
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
    assert.equal(cli(dir, ["unset", "A"]).stdout, "已删除 A\n");
    assert.ok(envFile(dir).includes("# keep me"));
    assert.ok(!envFile(dir).includes("A=1"));
    assert.equal(cli(dir, ["unset", "A"]).stdout, "凭据不存在：A\n");
    assert.match(cli(dir, ["clear"]).stdout, /已清空全部凭据/);
    assert.ok(envFile(dir).includes("# keep me"));
    assert.ok(!envFile(dir).includes("B=2"));
    assert.equal(metaFile(dir).trim(), "{}");
  });

  it("run：只把指定凭据注入子进程环境、退出码透传、参数校验", () => {
    const dir = tempDir();
    cli(dir, ["set", "SECRET_ONE", "--value=value-one"]);
    cli(dir, ["set", "SECRET_TWO", "--value=value-two"]);
    const child = "console.log(process.env.SECRET_ONE); console.log(process.env.SECRET_TWO ?? 'unset')";
    const result = cli(dir, ["run", "--with=SECRET_ONE", "--", process.execPath, "-e", child]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "value-one\nunset\n");
    assert.ok(!result.stdout.includes("value-two"));
    assert.equal(cli(dir, ["run", "--with=SECRET_ONE", "--", process.execPath, "-e", "process.exit(7)"]).status, 7);
    assert.equal(cli(dir, ["run", "--", "true"]).stderr, "run 需要 --with=A,B 指定要注入的凭据名\n");
    assert.equal(cli(dir, ["run", "--with=SECRET_ONE", "true"]).stderr, "run 需要 `--` 分隔符，例如：flowlet run --with=GITHUB_PAT -- gh pr list\n");
    assert.equal(cli(dir, ["run", "--with=MISSING", "--", "true"]).stderr, "凭据不存在：MISSING\n");
  });

  it("doctor：未初始化、重复键、缺元数据、权限告警", () => {
    const dir = tempDir();
    assert.match(cli(dir, ["doctor"]).stdout, /状态：尚未初始化/);
    cli(dir, ["init"]);
    const file = path.join(dir, "credentials.env");
    writeFileSync(file, `${HEADER}\nDUP=one\nDUP=two\nKEY_ONE=value\n`);
    // Windows 没有 POSIX 权限位，`chmod 644` 无效且 doctor 按设计不告警（store.ts 仅在非 win32 检查）。
    if (process.platform !== "win32") {
      chmodSync(file, 0o644);
    }
    const report = cli(dir, ["doctor"]).stdout;
    if (process.platform !== "win32") {
      assert.match(report, /警告：环境文件权限为 644/);
    }
    assert.match(report, /警告：重复的键（后者生效）：DUP/);
    assert.match(report, /提示：缺少元数据的键：DUP, KEY_ONE/);
    assert.equal(cli(dir, ["get", "DUP", "--reveal"]).stdout, "two\n");
  });

  it("注释/空行/非法行保留，且原子写不残留临时文件", () => {
    const dir = tempDir();
    cli(dir, ["init"]);
    const file = path.join(dir, "credentials.env");
    writeFileSync(file, `${envFile(dir)}\n# handwritten\nnot a pair\nKEY_ONE=value\n`);
    cli(dir, ["set", "KEY_TWO", "--value=v2"]);
    const text = envFile(dir);
    assert.ok(text.includes("# handwritten"));
    assert.ok(text.includes("not a pair"));
    assert.ok(text.includes("KEY_ONE=value"));
    assert.ok(text.includes("KEY_TWO=v2"));
    // Rust 行为：每次写入都会再前置一次固定文件头（历史注释因此累积）；这里 2 次写入 = 2 份。
    assert.equal(text.split(HEADER).length - 1, 2);
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp-")), []);
  });
});

// ─── GitLab 子命令 ─────────────────────────────────────────────────────────

describe("gitlab 子命令", () => {
  it("gitlab set：先校验后落库，URL 归一/子路径，KIND/备注写入", async () => {
    const mock = await startMock({ mode: "gitlab" });
    const dir = tempDir();
    const ok = cli(dir, ["gitlab", "set", `--url=${mock.baseUrl}/`], { input: GITLAB_TOKEN });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, `已保存 GitLab 凭据：${mock.baseUrl}/api/v4\n用户：Fixture User (@fixture) id=7\n`);
    const meta = JSON.parse(metaFile(dir)) as Record<string, Record<string, unknown>>;
    assert.equal(meta.GITLAB_URL!.kind, "service");
    assert.equal(meta.GITLAB_URL!.note, "gitlab 实例地址（API v4）");
    assert.equal(meta.GITLAB_TOKEN!.kind, "cli_token");
    assert.equal(cli(dir, ["get", "GITLAB_URL", "--reveal"]).stdout, `${mock.baseUrl}\n`);
    mock.close();
  });

  it("gitlab set：token 无效时不落库", async () => {
    const mock = await startMock({ mode: "gitlab" });
    const dir = tempDir();
    const failed = cli(dir, ["gitlab", "set", `--url=${mock.baseUrl}`], { input: "glpat-wrong" });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /^GitLab API 401: 401 Unauthorized（token 无效或已过期/);
    assert.match(failed.stderr, /未保存。请检查实例地址、token 是否有效（需要 api scope）。/);
    assert.ok(!existsSync(path.join(dir, "credentials.env")) || !envFile(dir).includes("GITLAB_URL"));
    mock.close();
  });

  it("gitlab status：10.8.7 / 403 降级 / 未配置错误", async () => {
    const mock = await startMock({ mode: "gitlab" });
    const dir = tempDir();
    cli(dir, ["gitlab", "set", `--url=${mock.baseUrl}`], { input: GITLAB_TOKEN });
    assert.equal(
      cli(dir, ["gitlab", "status"]).stdout,
      `API：${mock.baseUrl}/api/v4\n用户：Fixture User (@fixture) id=7\n版本：10.8.7\n`,
    );
    mock.close();
    const degraded = await startMock({ mode: "gitlab", versionStatus: 403 });
    const degradedDir = tempDir();
    cli(degradedDir, ["gitlab", "set", `--url=${degraded.baseUrl}`], { input: GITLAB_TOKEN });
    assert.match(cli(degradedDir, ["gitlab", "status"]).stdout, /版本：未知（\/version 需要管理员 token/);
    degraded.close();
    const empty = cli(tempDir(), ["gitlab", "status"]);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /尚未配置 GitLab 地址/);
  });

  it("gitlab projects：分页/--limit/--json/空结果", async () => {
    const mock = await startMock({
      mode: "gitlab",
      projectPages: [
        [{ id: 42, path_with_namespace: "group/app", name: "app", default_branch: "main", visibility: "private" }],
        [{ id: 7, path_with_namespace: "team/svc", name: "svc" }],
      ],
    });
    const dir = tempDir();
    cli(dir, ["gitlab", "set", `--url=${mock.baseUrl}`], { input: GITLAB_TOKEN });
    const list = cli(dir, ["gitlab", "projects"]);
    assert.match(list.stdout, /^ {6}42 {2}group\/app {2}main {2}private$/m);
    assert.match(list.stdout, /^ {7}7 {2}team\/svc$/m);
    const json = JSON.parse(cli(dir, ["gitlab", "projects", "--json", "--limit=1"]).stdout) as unknown[];
    assert.equal(json.length, 1);
    assert.equal(cli(dir, ["gitlab", "projects", "--limit=abc"]).stderr, "--limit 需要整数\n");
    mock.close();
    const emptyMock = await startMock({ mode: "gitlab" });
    const emptyDir = tempDir();
    cli(emptyDir, ["gitlab", "set", `--url=${emptyMock.baseUrl}`], { input: GITLAB_TOKEN });
    assert.equal(cli(emptyDir, ["gitlab", "projects"]).stdout, "（没有匹配的项目）\n");
    emptyMock.close();
  });

  it("gitlab api：默认 GET、显式方法、绝对 URL 拒绝、分页提示", async () => {
    const mock = await startMock({
      mode: "gitlab",
      projectPages: [[{ id: 1, path_with_namespace: "g/a" }]],
    });
    const dir = tempDir();
    cli(dir, ["gitlab", "set", `--url=${mock.baseUrl}`], { input: GITLAB_TOKEN });
    const user = cli(dir, ["gitlab", "api", "/user"]);
    assert.equal(user.status, 0);
    assert.equal((JSON.parse(user.stdout) as { username: string }).username, "fixture");
    assert.equal((JSON.parse(cli(dir, ["gitlab", "api", "GET", "/version"]).stdout) as { version: string }).version, "10.8.7");
    const projects = cli(dir, ["gitlab", "api", "/projects"]);
    assert.match(projects.stderr, /分页：page=Some\(1\) next=None total=Some\(1\)/);
    const absolute = cli(dir, ["gitlab", "api", "GET", "https://evil.example.com/x"]);
    assert.equal(absolute.status, 1);
    assert.match(absolute.stderr, /不接受绝对 URL/);
    assert.match(cli(dir, ["gitlab", "api", "POST", "/projects", "--data=not-json"]).stderr, /--data 不是合法 JSON/);
    mock.close();
  });

  it("gitlab env/clear：先检查是否已配置，clear 移除两把键", async () => {
    const mock = await startMock({ mode: "gitlab" });
    const dir = tempDir();
    assert.match(cli(dir, ["gitlab", "env"]).stderr, /尚未配置 GitLab 地址/);
    cli(dir, ["gitlab", "set", `--url=${mock.baseUrl}`], { input: GITLAB_TOKEN });
    const env = cli(dir, ["gitlab", "env"]);
    assert.match(env.stderr, /注意：下面输出包含明文 token/);
    assert.equal(env.stdout, `GITLAB_URL=${mock.baseUrl}\nGITLAB_TOKEN=${GITLAB_TOKEN}\n`);
    assert.equal(cli(dir, ["gitlab", "clear"]).stdout, "已移除 GitLab 凭据\n");
    assert.equal(cli(dir, ["gitlab", "clear"]).stdout, "没有可移除的 GitLab 凭据\n");
    mock.close();
  });
});

  it("gitlab --profile：组合前缀键名、status/env 使用对应实例、clear 只删该 profile", async () => {
    const mock = await startMock({ mode: "gitlab" });
    const dir = tempDir();
    const ok = cli(dir, ["gitlab", "set", `--url=${mock.baseUrl}`, "--profile=work"], { input: GITLAB_TOKEN });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(
      ok.stdout,
      `已保存 GitLab 凭据（profile: WORK）：${mock.baseUrl}/api/v4\n用户：Fixture User (@fixture) id=7\n`,
    );
    const meta = JSON.parse(metaFile(dir)) as Record<string, Record<string, unknown>>;
    assert.equal(meta.GITLAB_WORK_URL!.kind, "service");
    assert.equal(meta.GITLAB_WORK_TOKEN!.kind, "cli_token");
    assert.equal(cli(dir, ["get", "GITLAB_WORK_URL", "--reveal"]).stdout, `${mock.baseUrl}\n`);
    // 默认前缀与 profile 完全独立：没配默认前缀时提示仍指向 flowlet gitlab set。
    assert.match(
      cli(dir, ["gitlab", "env"]).stderr,
      /尚未配置 GitLab 地址，先运行 flowlet gitlab set --url=\.\.\./,
    );
    const status = cli(dir, ["gitlab", "status", "--profile=work"]);
    assert.match(status.stdout, /^API：http:\/\/127\.0\.0\.1:\d+\/gitlab\/api\/v4$/m);
    assert.match(status.stdout, /用户：Fixture User \(@fixture\) id=7/);
    const env = cli(dir, ["gitlab", "env", "--profile=work"]);
    assert.match(env.stderr, /注意：下面输出包含明文 token/);
    assert.equal(env.stdout, `GITLAB_WORK_URL=${mock.baseUrl}\nGITLAB_WORK_TOKEN=${GITLAB_TOKEN}\n`);
    // projects/api 也按 profile 取实例。
    const projects = cli(dir, ["gitlab", "projects", "--profile=work", "--json"]);
    assert.deepEqual(JSON.parse(projects.stdout), []);
    assert.equal(
      (JSON.parse(cli(dir, ["gitlab", "api", "/user", "--profile=work"]).stdout) as { username: string }).username,
      "fixture",
    );
    // clear 只删该 profile，不碰其它前缀。
    assert.equal(
      cli(dir, ["gitlab", "clear", "--profile=work"]).stdout,
      "已移除 GitLab 凭据（profile: WORK）\n",
    );
    assert.equal(
      cli(dir, ["gitlab", "clear", "--profile=work"]).stdout,
      "没有可移除的 GitLab 凭据（profile: WORK）\n",
    );
    assert.match(cli(dir, ["gitlab", "env", "--profile=work"]).stderr, /--profile=WORK/);
    mock.close();
  });

  it("gitlab --profile：别名转大写、非法别名报错", async () => {
    const mock = await startMock({ mode: "gitlab" });
    const dir = tempDir();
    const ok = cli(dir, ["gitlab", "set", `--url=${mock.baseUrl}`, "--profile=team_a"], { input: GITLAB_TOKEN });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(cli(dir, ["get", "GITLAB_TEAM_A_URL", "--reveal"]).stdout, `${mock.baseUrl}\n`);
    assert.equal(
      cli(dir, ["gitlab", "status", "--profile=1bad"]).stderr,
      "--profile 只能包含字母、数字和下划线，且以字母开头\n",
    );
    assert.equal(
      cli(dir, ["gitlab", "status", "--profile=too-long-alias-exceeding-24-chars"]).stderr,
      "--profile 只能包含字母、数字和下划线，且以字母开头\n",
    );
    mock.close();
  });

// ─── Dockhand 子命令 ───────────────────────────────────────────────────────

describe("dockhand 子命令", () => {
  it("dockhand set：先校验后落库，URL 归一/去 /api 后缀，KIND/备注写入", async () => {
    const mock = await startMock({ mode: "dockhand" });
    const dir = tempDir();
    const ok = cli(dir, ["dockhand", "set", `--url=${mock.baseUrl}/api/`], { input: DOCKHAND_TOKEN });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, `已保存 Dockhand 凭据：${mock.baseUrl}/api\n环境：2 个\n`);
    const meta = JSON.parse(metaFile(dir)) as Record<string, Record<string, unknown>>;
    assert.equal(meta.DOCKHAND_URL!.kind, "service");
    assert.equal(meta.DOCKHAND_URL!.note, "dockhand 面板地址");
    assert.equal(meta.DOCKHAND_TOKEN!.kind, "cli_token");
    assert.equal(meta.DOCKHAND_TOKEN!.note, "dockhand API token");
    assert.equal(cli(dir, ["get", "DOCKHAND_URL", "--reveal"]).stdout, `${mock.baseUrl}\n`);
    assert.equal(cli(dir, ["get", "DOCKHAND_TOKEN", "--reveal"]).stdout, `${DOCKHAND_TOKEN}\n`);
    mock.close();
  });

  it("dockhand set：token 无效时不落库", async () => {
    const mock = await startMock({ mode: "dockhand" });
    const dir = tempDir();
    const failed = cli(dir, ["dockhand", "set", `--url=${mock.baseUrl}`], { input: "wrong-dockhand-token" });
    assert.equal(failed.status, 1);
    assert.equal(
      failed.stderr,
      "Dockhand API 401: Unauthorized（token 无效或已过期，请到 Dockhand 生成新的 API Token）\n" +
        "未保存。请检查实例地址、token 是否有效（Dockhand 设置 → API 令牌）。\n",
    );
    assert.ok(!existsSync(path.join(dir, "credentials.env")) || !envFile(dir).includes("DOCKHAND_URL"));
    mock.close();
  });

  it("dockhand status：health/环境列表/Docker 版本；未配置时提示", async () => {
    const mock = await startMock({ mode: "dockhand" });
    const dir = tempDir();
    cli(dir, ["dockhand", "set", `--url=${mock.baseUrl}`], { input: DOCKHAND_TOKEN });
    assert.equal(
      cli(dir, ["dockhand", "status"]).stdout,
      `API：${mock.baseUrl}/api\n` +
        "健康：ok\n" +
        "环境：2 个\n" +
        "   2  [CentOS] 10.100.217.60  http://10.100.217.60:2375\n" +
        "   1  本机  http://127.0.0.1:2375\n" +
        "Docker 版本：27.3.1\n",
    );
    mock.close();
    const empty = cli(tempDir(), ["dockhand", "status"]);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /尚未配置 Dockhand 地址/);
  });

  it("dockhand envs：文本与 --json", async () => {
    const mock = await startMock({ mode: "dockhand" });
    const dir = tempDir();
    cli(dir, ["dockhand", "set", `--url=${mock.baseUrl}`], { input: DOCKHAND_TOKEN });
    assert.equal(
      cli(dir, ["dockhand", "envs"]).stdout,
      "   2  [CentOS] 10.100.217.60  http://10.100.217.60:2375\n   1  本机  http://127.0.0.1:2375\n",
    );
    const json = JSON.parse(cli(dir, ["dockhand", "envs", "--json"]).stdout) as Array<Record<string, unknown>>;
    assert.deepEqual(json, [
      { id: 2, name: "[CentOS] 10.100.217.60", host: "10.100.217.60", port: 2375, protocol: "http" },
      { id: 1, name: "本机", host: "127.0.0.1", port: 2375, protocol: "http" },
    ]);
    mock.close();
  });

  it("dockhand stacks：--env 必填/整数校验、文本与 --json", async () => {
    const mock = await startMock({ mode: "dockhand" });
    const dir = tempDir();
    cli(dir, ["dockhand", "set", `--url=${mock.baseUrl}`], { input: DOCKHAND_TOKEN });
    assert.equal(cli(dir, ["dockhand", "stacks"]).stderr, "缺少 --env，例如 --env=2\n");
    assert.equal(cli(dir, ["dockhand", "stacks", "--env=abc"]).stderr, "--env 需要整数，例如 --env=2\n");
    assert.equal(cli(dir, ["dockhand", "stacks", "--env=2"]).stdout, "flowlet  2 个容器\ntools  1 个容器\n");
    const json = JSON.parse(cli(dir, ["dockhand", "stacks", "--env=2", "--json"]).stdout) as Array<{
      name: string;
      containers: string[];
    }>;
    assert.deepEqual(json.map((stack) => [stack.name, stack.containers.length]), [["flowlet", 2], ["tools", 1]]);
    mock.close();
  });

  it("dockhand api：默认 GET、显式方法、/api 前缀与 query、POST 透传、绝对 URL 拒绝", async () => {
    const mock = await startMock({ mode: "dockhand" });
    const dir = tempDir();
    cli(dir, ["dockhand", "set", `--url=${mock.baseUrl}`], { input: DOCKHAND_TOKEN });
    assert.equal((JSON.parse(cli(dir, ["dockhand", "api", "/environments"]).stdout) as unknown[]).length, 2);
    assert.equal(
      (JSON.parse(cli(dir, ["dockhand", "api", "GET", "/api/health"]).stdout) as { status: string }).status,
      "ok",
    );
    assert.equal((JSON.parse(cli(dir, ["dockhand", "api", "/stacks?env=2"]).stdout) as unknown[]).length, 2);
    const echoed = JSON.parse(
      cli(dir, ["dockhand", "api", "POST", "/echo", '--data={"hello":1}']).stdout,
    ) as { method: string; body: unknown };
    assert.deepEqual(echoed, { method: "POST", body: { hello: 1 } });
    assert.equal(
      cli(dir, ["dockhand", "api", "GET", "https://evil.example.com/x"]).stderr,
      "API 路径必须是相对路径（如 /environments），不接受绝对 URL\n",
    );
    assert.match(cli(dir, ["dockhand", "api", "POST", "/echo", "--data=not-json"]).stderr, /--data 不是合法 JSON/);
    mock.close();
  });

  it("dockhand env/clear：先检查是否已配置，clear 移除两把键", async () => {
    const mock = await startMock({ mode: "dockhand" });
    const dir = tempDir();
    assert.match(cli(dir, ["dockhand", "env"]).stderr, /尚未配置 Dockhand 地址/);
    cli(dir, ["dockhand", "set", `--url=${mock.baseUrl}`], { input: DOCKHAND_TOKEN });
    const env = cli(dir, ["dockhand", "env"]);
    assert.match(env.stderr, /注意：下面输出包含明文 token/);
    assert.equal(env.stdout, `DOCKHAND_URL=${mock.baseUrl}\nDOCKHAND_TOKEN=${DOCKHAND_TOKEN}\n`);
    assert.equal(cli(dir, ["dockhand", "clear"]).stdout, "已移除 Dockhand 凭据\n");
    assert.equal(cli(dir, ["dockhand", "clear"]).stdout, "没有可移除的 Dockhand 凭据\n");
    mock.close();
  });
});

  it("dockhand --profile：多实例独立键名，status/envs/stacks/api 用对应 profile，clear 只删该 profile", async () => {
    const na = await startMock({ mode: "dockhand" });
    const sz = await startMock({ mode: "dockhand" });
    const dir = tempDir();
    assert.equal(
      cli(dir, ["dockhand", "set", `--url=${na.baseUrl}`, "--profile=na"], { input: DOCKHAND_TOKEN }).stdout,
      `已保存 Dockhand 凭据（profile: NA）：${na.baseUrl}/api\n环境：2 个\n`,
    );
    assert.equal(
      cli(dir, ["dockhand", "set", `--url=${sz.baseUrl}`, "--profile=sz"], { input: DOCKHAND_TOKEN }).status,
      0,
    );
    const naStatus = cli(dir, ["dockhand", "status", "--profile=na"]).stdout;
    assert.ok(naStatus.startsWith(`API：${na.baseUrl}/api\n健康：ok\n环境：2 个\n`), naStatus);
    const szStatus = cli(dir, ["dockhand", "status", "--profile=sz"]).stdout;
    assert.ok(szStatus.startsWith(`API：${sz.baseUrl}/api\n`), szStatus);
    assert.equal(
      cli(dir, ["dockhand", "envs", "--profile=na"]).stdout,
      "   2  [CentOS] 10.100.217.60  http://10.100.217.60:2375\n   1  本机  http://127.0.0.1:2375\n",
    );
    assert.equal(
      cli(dir, ["dockhand", "stacks", "--env=2", "--profile=sz"]).stdout,
      "flowlet  2 个容器\ntools  1 个容器\n",
    );
    assert.equal(
      (JSON.parse(cli(dir, ["dockhand", "api", "/environments", "--profile=na"]).stdout) as unknown[]).length,
      2,
    );
    const naEnv = cli(dir, ["dockhand", "env", "--profile=na"]);
    assert.match(naEnv.stderr, /注意：下面输出包含明文 token/);
    assert.equal(naEnv.stdout, `DOCKHAND_NA_URL=${na.baseUrl}\nDOCKHAND_NA_TOKEN=${DOCKHAND_TOKEN}\n`);
    // 默认前缀与 profile 独立：未配置默认凭据时提示仍指向 flowlet dockhand set。
    assert.match(cli(dir, ["dockhand", "env"]).stderr, /尚未配置 Dockhand 地址，先运行 flowlet dockhand set/);
    // clear 只删 NA prefix。
    assert.equal(
      cli(dir, ["dockhand", "clear", "--profile=na"]).stdout,
      "已移除 Dockhand 凭据（profile: NA）\n",
    );
    assert.match(cli(dir, ["dockhand", "env", "--profile=na"]).stderr, /--profile=NA/);
    const szEnv = cli(dir, ["dockhand", "env", "--profile=sz"]).stdout;
    assert.ok(szEnv.startsWith(`DOCKHAND_SZ_URL=${sz.baseUrl}\n`), szEnv);
    na.close();
    sz.close();
  });

// ─── jenkins 子命令 ────────────────────────────────────────────────────────

describe("jenkins 子命令", () => {
  it("jenkins set：先校验后落库，URL 去末尾斜杠，三把键的 kind/note 写入", async () => {
    const mock = await startMock({ mode: "jenkins" });
    const dir = tempDir();
    const ok = cli(dir, ["jenkins", "set", `--url=${mock.baseUrl}/`, "--user=fixture-user"], {
      input: JENKINS_TOKEN,
    });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(
      ok.stdout,
      `已保存 Jenkins 凭据：${mock.baseUrl}\n用户：Fixture User（Jenkins 2.440.1）\n`,
    );
    const meta = JSON.parse(metaFile(dir)) as Record<string, Record<string, unknown>>;
    assert.equal(meta.JENKINS_URL!.kind, "service");
    assert.equal(meta.JENKINS_URL!.note, "jenkins 实例地址");
    assert.equal(meta.JENKINS_USER!.kind, "service");
    assert.equal(meta.JENKINS_USER!.note, "jenkins 用户名");
    assert.equal(meta.JENKINS_TOKEN!.kind, "cli_token");
    assert.equal(meta.JENKINS_TOKEN!.note, "jenkins API token");
    assert.equal(cli(dir, ["get", "JENKINS_URL", "--reveal"]).stdout, `${mock.baseUrl}\n`);
    assert.equal(cli(dir, ["get", "JENKINS_USER", "--reveal"]).stdout, "fixture-user\n");
    assert.equal(cli(dir, ["get", "JENKINS_TOKEN", "--reveal"]).stdout, `${JENKINS_TOKEN}\n`);
    mock.close();
  });

  it("jenkins set：缺少 --url/--user 的提示；空 token/用户名与无效 token 都不落库", async () => {
    const mock = await startMock({ mode: "jenkins" });
    const dir = tempDir();
    const noUrl = cli(dir, ["jenkins", "set", "--user=fixture-user"], { input: JENKINS_TOKEN });
    assert.equal(noUrl.status, 1);
    assert.match(
      noUrl.stderr,
      /^缺少 --url，例如：flowlet jenkins set --url=https:\/\/jenkins\.example\.com --user=NAME\n$/,
    );
    const noUser = cli(dir, ["jenkins", "set", `--url=${mock.baseUrl}`], { input: JENKINS_TOKEN });
    assert.equal(noUser.status, 1);
    assert.match(noUser.stderr, /^缺少 --user，例如：flowlet jenkins set /);
    const emptyUser = cli(dir, ["jenkins", "set", `--url=${mock.baseUrl}`, "--user=   "], {
      input: JENKINS_TOKEN,
    });
    assert.equal(emptyUser.stderr, "Jenkins 用户名不能为空\n");
    const emptyToken = cli(dir, ["jenkins", "set", `--url=${mock.baseUrl}`, "--user=fixture-user"]);
    assert.equal(
      emptyToken.stderr,
      "Jenkins token 不能为空：用 `printf '%s' \"$TOKEN\" | flowlet jenkins set ...`\n",
    );
    const failed = cli(dir, ["jenkins", "set", `--url=${mock.baseUrl}`, "--user=fixture-user"], {
      input: "wrong-jenkins-token",
    });
    assert.equal(failed.status, 1);
    assert.equal(
      failed.stderr,
      "Jenkins API 401: Unauthorized（用户名或 API Token 无效，请到 Jenkins 用户设置页确认 API Token）\n" +
        "未保存。请检查实例地址、用户名与 API Token 是否有效（Jenkins 用户设置 → API Token）。\n",
    );
    assert.ok(!existsSync(path.join(dir, "credentials.env")) || !envFile(dir).includes("JENKINS_URL"));
    mock.close();
  });

  it("jenkins status：URL/版本/用户三行；X-Jenkins 缺失显示未知；未配置时提示", async () => {
    const mock = await startMock({ mode: "jenkins" });
    const dir = tempDir();
    cli(dir, ["jenkins", "set", `--url=${mock.baseUrl}`, "--user=fixture-user"], {
      input: JENKINS_TOKEN,
    });
    assert.equal(
      cli(dir, ["jenkins", "status"]).stdout,
      `URL：${mock.baseUrl}\n版本：2.440.1\n用户：Fixture User\n`,
    );
    mock.close();

    const noVersion = await startMock({ mode: "jenkins", jenkinsVersion: null });
    const dir2 = tempDir();
    cli(dir2, ["jenkins", "set", `--url=${noVersion.baseUrl}`, "--user=fixture-user"], {
      input: JENKINS_TOKEN,
    });
    assert.equal(
      cli(dir2, ["jenkins", "status"]).stdout,
      `URL：${noVersion.baseUrl}\n版本：未知\n用户：Fixture User\n`,
    );
    noVersion.close();

    const empty = cli(tempDir(), ["jenkins", "status"]);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /尚未配置 Jenkins 地址/);
  });

  it("jenkins api：默认 GET、显式方法、PATH 原样（不加 /api）、POST 透传、拒绝绝对 URL 与非法 --data", async () => {
    const mock = await startMock({ mode: "jenkins" });
    const dir = tempDir();
    cli(dir, ["jenkins", "set", `--url=${mock.baseUrl}`, "--user=fixture-user"], {
      input: JENKINS_TOKEN,
    });
    const me = JSON.parse(cli(dir, ["jenkins", "api", "/me/api/json"]).stdout) as {
      fullName: string;
    };
    assert.equal(me.fullName, "Fixture User");
    const job = JSON.parse(cli(dir, ["jenkins", "api", "GET", "/job/flowlet/api/json"]).stdout) as {
      name: string;
    };
    assert.equal(job.name, "flowlet");
    const echoed = JSON.parse(
      cli(dir, ["jenkins", "api", "POST", "/echo", '--data={"build":1}']).stdout,
    ) as { method: string; body: unknown; path: string };
    assert.deepEqual(echoed, { method: "POST", body: { build: 1 }, path: "/echo" });
    assert.equal(
      cli(dir, ["jenkins", "api", "GET", "https://evil.example.com/me/api/json"]).stderr,
      "API 路径必须是相对路径（如 /me/api/json），不接受绝对 URL\n",
    );
    assert.match(
      cli(dir, ["jenkins", "api", "POST", "/echo", "--data=not-json"]).stderr,
      /--data 不是合法 JSON/,
    );
    mock.close();
  });

  it("jenkins env/clear：明文提示 + 三行；clear 幂等移除三把键", async () => {
    const mock = await startMock({ mode: "jenkins" });
    const dir = tempDir();
    assert.match(cli(dir, ["jenkins", "env"]).stderr, /尚未配置 Jenkins 地址/);
    cli(dir, ["jenkins", "set", `--url=${mock.baseUrl}`, "--user=fixture-user"], {
      input: JENKINS_TOKEN,
    });
    const env = cli(dir, ["jenkins", "env"]);
    assert.match(env.stderr, /注意：下面输出包含明文 token/);
    assert.equal(
      env.stdout,
      `JENKINS_URL=${mock.baseUrl}\nJENKINS_USER=fixture-user\nJENKINS_TOKEN=${JENKINS_TOKEN}\n`,
    );
    assert.equal(cli(dir, ["jenkins", "clear"]).stdout, "已移除 Jenkins 凭据\n");
    assert.equal(cli(dir, ["jenkins", "clear"]).stdout, "没有可移除的 Jenkins 凭据\n");
    mock.close();
  });

  it("jenkins --profile：多实例独立键名（含 JENKINS_CI_USER），clear 只删该 profile", async () => {
    const ci = await startMock({ mode: "jenkins" });
    const dir = tempDir();
    assert.equal(
      cli(dir, ["jenkins", "set", `--url=${ci.baseUrl}`, "--user=fixture-user", "--profile=ci"], {
        input: JENKINS_TOKEN,
      }).stdout,
      `已保存 Jenkins 凭据（profile: CI）：${ci.baseUrl}\n用户：Fixture User（Jenkins 2.440.1）\n`,
    );
    assert.equal(
      cli(dir, ["jenkins", "status", "--profile=ci"]).stdout,
      `URL：${ci.baseUrl}\n版本：2.440.1\n用户：Fixture User\n`,
    );
    const env = cli(dir, ["jenkins", "env", "--profile=ci"]);
    assert.match(env.stderr, /注意：下面输出包含明文 token/);
    assert.equal(
      env.stdout,
      `JENKINS_CI_URL=${ci.baseUrl}\nJENKINS_CI_USER=fixture-user\nJENKINS_CI_TOKEN=${JENKINS_TOKEN}\n`,
    );
    // 默认前缀与 profile 独立：未配置默认凭据时提示仍指向 flowlet jenkins set。
    assert.match(cli(dir, ["jenkins", "env"]).stderr, /尚未配置 Jenkins 地址，先运行 flowlet jenkins set/);
    assert.equal(
      cli(dir, ["jenkins", "clear", "--profile=ci"]).stdout,
      "已移除 Jenkins 凭据（profile: CI）\n",
    );
    assert.match(cli(dir, ["jenkins", "env", "--profile=ci"]).stderr, /--profile=CI/);
    ci.close();
  });
});

// ─── beszel 子命令 ────────────────────────────────────────────────────────

describe("beszel 子命令", () => {
  it("beszel set：先认证再落库，URL 归一（/_/ → 根地址），三把键的 kind/note 写入", async () => {
    const mock = await startMock({ mode: "beszel" });
    const dir = tempDir();
    const ok = cli(dir, ["beszel", "set", `--url=${mock.baseUrl}/_/`, `--email=${BESZEL_EMAIL}`], {
      input: BESZEL_PASSWORD,
    });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(
      ok.stdout,
      `已保存 Beszel 凭据：${mock.baseUrl}\n邮箱：${BESZEL_EMAIL}（Beszel 0.21.1）\n系统：3 台\n`,
    );
    const meta = JSON.parse(metaFile(dir)) as Record<string, Record<string, unknown>>;
    assert.equal(meta.BESZEL_URL!.kind, "service");
    assert.equal(meta.BESZEL_URL!.note, "beszel 实例地址");
    assert.equal(meta.BESZEL_EMAIL!.kind, "service");
    assert.equal(meta.BESZEL_EMAIL!.note, "beszel 登录邮箱");
    assert.equal(meta.BESZEL_PASSWORD!.kind, "cli_token");
    assert.equal(meta.BESZEL_PASSWORD!.note, "beszel 登录密码");
    assert.equal(cli(dir, ["get", "BESZEL_URL", "--reveal"]).stdout, `${mock.baseUrl}\n`);
    assert.equal(cli(dir, ["get", "BESZEL_EMAIL", "--reveal"]).stdout, `${BESZEL_EMAIL}\n`);
    assert.equal(cli(dir, ["get", "BESZEL_PASSWORD", "--reveal"]).stdout, `${BESZEL_PASSWORD}\n`);
    mock.close();
  });

  it("beszel set：缺少 --url/--email、空密码、密码错误都不落库", async () => {
    const mock = await startMock({ mode: "beszel" });
    const dir = tempDir();
    const noUrl = cli(dir, ["beszel", "set", `--email=${BESZEL_EMAIL}`], { input: BESZEL_PASSWORD });
    assert.equal(noUrl.status, 1);
    assert.match(
      noUrl.stderr,
      /^缺少 --url，例如：flowlet beszel set --url=http:\/\/beszel\.example\.com:8090 --email=you@example\.com\n$/,
    );
    const noEmail = cli(dir, ["beszel", "set", `--url=${mock.baseUrl}`], {
      input: BESZEL_PASSWORD,
    });
    assert.equal(noEmail.status, 1);
    assert.equal(
      noEmail.stderr,
      "缺少 --email，例如：flowlet beszel set --url=http://beszel.example.com:8090 --email=you@example.com\n",
    );
    const emptyPassword = cli(dir, ["beszel", "set", `--url=${mock.baseUrl}`, `--email=${BESZEL_EMAIL}`]);
    assert.equal(
      emptyPassword.stderr,
      "Beszel 密码不能为空：用 `printf '%s' \"$PASSWORD\" | flowlet beszel set ...`\n",
    );
    const failed = cli(dir, ["beszel", "set", `--url=${mock.baseUrl}`, `--email=${BESZEL_EMAIL}`], {
      input: "wrong-password",
    });
    assert.equal(failed.status, 1);
    assert.equal(
      failed.stderr,
      "Beszel API 400: Failed to authenticate.（邮箱或密码错误，请确认是 Beszel 用户账号（不是 PocketBase 超级管理员））\n" +
        "未保存。请检查实例地址、邮箱与密码是否有效（Beszel 用户账号，不是 PocketBase 超级管理员）。\n",
    );
    assert.ok(
      !existsSync(path.join(dir, "credentials.env")) || !envFile(dir).includes("BESZEL_URL"),
    );
    mock.close();
  });

  it("beszel status：URL/版本/邮箱/系统四行；info 失败显示版本未知；未配置时提示", async () => {
    const mock = await startMock({ mode: "beszel" });
    const dir = tempDir();
    cli(dir, ["beszel", "set", `--url=${mock.baseUrl}`, `--email=${BESZEL_EMAIL}`], {
      input: BESZEL_PASSWORD,
    });
    assert.equal(
      cli(dir, ["beszel", "status"]).stdout,
      `URL：${mock.baseUrl}\n版本：0.21.1\n邮箱：${BESZEL_EMAIL}\n系统：3 台\n`,
    );
    mock.close();

    const infoDown = await startMock({ mode: "beszel", beszelInfoStatus: 404 });
    const dir2 = tempDir();
    cli(dir2, ["beszel", "set", `--url=${infoDown.baseUrl}`, `--email=${BESZEL_EMAIL}`], {
      input: BESZEL_PASSWORD,
    });
    assert.equal(
      cli(dir2, ["beszel", "status"]).stdout,
      `URL：${infoDown.baseUrl}\n版本：未知\n邮箱：${BESZEL_EMAIL}\n系统：3 台\n`,
    );
    infoDown.close();

    const empty = cli(tempDir(), ["beszel", "status"]);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /尚未配置 Beszel 地址/);
  });

  it("beszel systems：默认文本列表与 --json", async () => {
    const mock = await startMock({ mode: "beszel" });
    const dir = tempDir();
    cli(dir, ["beszel", "set", `--url=${mock.baseUrl}`, `--email=${BESZEL_EMAIL}`], {
      input: BESZEL_PASSWORD,
    });
    const text = cli(dir, ["beszel", "systems"]).stdout;
    assert.match(text, /sys-1.*web-01.*up.*10\.0\.0\.11:45876/);
    assert.match(text, /sys-3.*cache-01.*down/);
    const json = JSON.parse(cli(dir, ["beszel", "systems", "--json"]).stdout) as Array<
      Record<string, unknown>
    >;
    assert.equal(json.length, 3);
    assert.deepEqual(json[0], {
      id: "sys-1",
      name: "web-01",
      host: "10.0.0.11",
      status: "up",
      port: "45876",
    });
    mock.close();
  });

  it("beszel api：默认 GET、显式方法、PATH 可带 /api、POST 透传、拒绝绝对 URL 与非法 --data", async () => {
    const mock = await startMock({ mode: "beszel" });
    const dir = tempDir();
    cli(dir, ["beszel", "set", `--url=${mock.baseUrl}`, `--email=${BESZEL_EMAIL}`], {
      input: BESZEL_PASSWORD,
    });
    const info = JSON.parse(cli(dir, ["beszel", "api", "/beszel/info"]).stdout) as { v: string };
    assert.equal(info.v, "0.21.1");
    const page = JSON.parse(
      cli(dir, ["beszel", "api", "GET", "/api/collections/systems/records?perPage=1"]).stdout,
    ) as { totalItems: number };
    assert.equal(page.totalItems, 3);
    const echoed = JSON.parse(
      cli(dir, ["beszel", "api", "POST", "/echo", '--data={"probe":1}']).stdout,
    ) as { method: string; body: unknown; path: string };
    assert.deepEqual(echoed, { method: "POST", body: { probe: 1 }, path: "/api/echo" });
    assert.equal(
      cli(dir, ["beszel", "api", "GET", "https://evil.example.com/collections/systems/records"])
        .stderr,
      "API 路径必须是相对路径（如 /collections/systems/records），不接受绝对 URL\n",
    );
    assert.match(
      cli(dir, ["beszel", "api", "POST", "/echo", "--data=not-json"]).stderr,
      /--data 不是合法 JSON/,
    );
    mock.close();
  });

  it("beszel env/clear：明文密码提示 + 三行；clear 幂等移除三把键", async () => {
    const mock = await startMock({ mode: "beszel" });
    const dir = tempDir();
    assert.match(cli(dir, ["beszel", "env"]).stderr, /尚未配置 Beszel 地址/);
    cli(dir, ["beszel", "set", `--url=${mock.baseUrl}`, `--email=${BESZEL_EMAIL}`], {
      input: BESZEL_PASSWORD,
    });
    const env = cli(dir, ["beszel", "env"]);
    assert.match(env.stderr, /注意：下面输出包含明文密码/);
    assert.equal(
      env.stdout,
      `BESZEL_URL=${mock.baseUrl}\nBESZEL_EMAIL=${BESZEL_EMAIL}\nBESZEL_PASSWORD=${BESZEL_PASSWORD}\n`,
    );
    assert.equal(cli(dir, ["beszel", "clear"]).stdout, "已移除 Beszel 凭据\n");
    assert.equal(cli(dir, ["beszel", "clear"]).stdout, "没有可移除的 Beszel 凭据\n");
    mock.close();
  });

  it("beszel --profile：多实例独立键名（BESZEL_MON_EMAIL/_PASSWORD），clear 只删该 profile", async () => {
    const mon = await startMock({ mode: "beszel" });
    const dir = tempDir();
    assert.equal(
      cli(dir, ["beszel", "set", `--url=${mon.baseUrl}`, `--email=${BESZEL_EMAIL}`, "--profile=mon"], {
        input: BESZEL_PASSWORD,
      }).stdout,
      `已保存 Beszel 凭据（profile: MON）：${mon.baseUrl}\n邮箱：${BESZEL_EMAIL}（Beszel 0.21.1）\n系统：3 台\n`,
    );
    const env = cli(dir, ["beszel", "env", "--profile=mon"]);
    assert.equal(
      env.stdout,
      `BESZEL_MON_URL=${mon.baseUrl}\nBESZEL_MON_EMAIL=${BESZEL_EMAIL}\nBESZEL_MON_PASSWORD=${BESZEL_PASSWORD}\n`,
    );
    assert.equal(
      cli(dir, ["beszel", "status", "--profile=mon"]).stdout,
      `URL：${mon.baseUrl}\n版本：0.21.1\n邮箱：${BESZEL_EMAIL}\n系统：3 台\n`,
    );
    assert.match(cli(dir, ["beszel", "env"]).stderr, /尚未配置 Beszel 地址，先运行 flowlet beszel set/);
    assert.equal(
      cli(dir, ["beszel", "clear", "--profile=mon"]).stdout,
      "已移除 Beszel 凭据（profile: MON）\n",
    );
    assert.match(cli(dir, ["beszel", "env", "--profile=mon"]).stderr, /--profile=MON/);
    mon.close();
  });
});

// ─── registry（OCI 镜像仓库）子命令 ───────────────────────────────────────

describe("registry 子命令", () => {
  it("registry set：先校验后落库，URL 归一（去 /v2/），三把键的 kind/note 写入", async () => {
    const mock = await startMock({ mode: "registry" });
    const dir = tempDir();
    const ok = cli(
      dir,
      ["registry", "set", `--url=${mock.baseUrl}/v2/`, `--user=${REGISTRY_USER}`],
      { input: REGISTRY_PASSWORD },
    );
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, `已保存 OCI 镜像仓库 凭据：${mock.baseUrl}\n`);
    const meta = JSON.parse(metaFile(dir)) as Record<string, Record<string, unknown>>;
    assert.equal(meta.REGISTRY_HOST!.kind, "service");
    assert.equal(meta.REGISTRY_HOST!.note, "OCI 镜像仓库地址");
    assert.equal(meta.REGISTRY_USER!.kind, "service");
    assert.equal(meta.REGISTRY_USER!.note, "OCI 镜像仓库用户名");
    assert.equal(meta.REGISTRY_TOKEN!.kind, "cli_token");
    assert.equal(meta.REGISTRY_TOKEN!.note, "OCI 镜像仓库密码/token");
    assert.equal(cli(dir, ["get", "REGISTRY_HOST", "--reveal"]).stdout, `${mock.baseUrl}\n`);
    assert.equal(cli(dir, ["get", "REGISTRY_USER", "--reveal"]).stdout, `${REGISTRY_USER}\n`);
    assert.equal(cli(dir, ["get", "REGISTRY_TOKEN", "--reveal"]).stdout, `${REGISTRY_PASSWORD}\n`);
    mock.close();
  });

  it("registry set：缺少 --url/--user、非法用户名、空 token、带路径与无效密码都不落库", async () => {
    const mock = await startMock({ mode: "registry" });
    const dir = tempDir();
    const noUrl = cli(dir, ["registry", "set", `--user=${REGISTRY_USER}`], {
      input: REGISTRY_PASSWORD,
    });
    assert.equal(noUrl.status, 1);
    assert.match(
      noUrl.stderr,
      /^缺少 --url，例如：flowlet registry set --url=hub\.example\.com --user=NAME\n$/,
    );
    const noUser = cli(dir, ["registry", "set", `--url=${mock.baseUrl}`], {
      input: REGISTRY_PASSWORD,
    });
    assert.equal(noUser.status, 1);
    assert.equal(
      noUser.stderr,
      "registry set 需要 --user=<用户名>（docker login 需要用户名 + 密码/token）\n",
    );
    const badUser = cli(dir, ["registry", "set", `--url=${mock.baseUrl}`, "--user=a:b"], {
      input: REGISTRY_PASSWORD,
    });
    assert.equal(badUser.stderr, "用户名不能包含冒号、空格或控制字符\n");
    const badPath = cli(
      dir,
      ["registry", "set", `--url=${mock.baseUrl}/api/v2.0/`, `--user=${REGISTRY_USER}`],
      { input: REGISTRY_PASSWORD },
    );
    assert.equal(
      badPath.stderr,
      "镜像仓库地址只能是主机（可带端口），不能包含路径\n" +
        "未保存。请检查镜像仓库地址、用户名与密码/token 是否有效。\n",
    );
    const emptyToken = cli(dir, ["registry", "set", `--url=${mock.baseUrl}`, `--user=${REGISTRY_USER}`]);
    assert.equal(
      emptyToken.stderr,
      "镜像仓库密码/token 不能为空：用 `printf '%s' \"$TOKEN\" | flowlet registry set ...`\n",
    );
    const failed = cli(dir, ["registry", "set", `--url=${mock.baseUrl}`, `--user=${REGISTRY_USER}`], {
      input: "wrong-registry-password",
    });
    assert.equal(failed.status, 1);
    assert.equal(
      failed.stderr,
      "用户名或 token 无效（registry 认证失败）\n" +
        "未保存。请检查镜像仓库地址、用户名与密码/token 是否有效。\n",
    );
    assert.ok(
      !existsSync(path.join(dir, "credentials.env")) || !envFile(dir).includes("REGISTRY_HOST"),
    );
    mock.close();
  });

  it("registry status：仓库/Registry V2 认证/用户三行；版本缺失省略括号；未配置时提示", async () => {
    const mock = await startMock({ mode: "registry" });
    const dir = tempDir();
    cli(dir, ["registry", "set", `--url=${mock.baseUrl}`, `--user=${REGISTRY_USER}`], {
      input: REGISTRY_PASSWORD,
    });
    assert.equal(
      cli(dir, ["registry", "status"]).stdout,
      `仓库：${hostOf(mock.baseUrl)}\n认证：Registry V2（registry/2.0）\n用户：${REGISTRY_USER}\n`,
    );
    mock.close();

    const noVersion = await startMock({ mode: "registry", registryVersion: null });
    const dir2 = tempDir();
    cli(dir2, ["registry", "set", `--url=${noVersion.baseUrl}`, `--user=${REGISTRY_USER}`], {
      input: REGISTRY_PASSWORD,
    });
    assert.equal(
      cli(dir2, ["registry", "status"]).stdout,
      `仓库：${hostOf(noVersion.baseUrl)}\n认证：Registry V2\n用户：${REGISTRY_USER}\n`,
    );
    noVersion.close();

    const empty = cli(tempDir(), ["registry", "status"]);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /尚未配置 OCI 镜像仓库地址/);
  });

  it("registry env/clear：明文提示 + 三行（_HOST 去 scheme）；clear 幂等移除三把键", async () => {
    const mock = await startMock({ mode: "registry" });
    const dir = tempDir();
    assert.match(cli(dir, ["registry", "env"]).stderr, /尚未配置 OCI 镜像仓库地址/);
    cli(dir, ["registry", "set", `--url=${mock.baseUrl}`, `--user=${REGISTRY_USER}`], {
      input: REGISTRY_PASSWORD,
    });
    const env = cli(dir, ["registry", "env"]);
    assert.match(env.stderr, /注意：下面输出包含明文密码\/token/);
    assert.equal(
      env.stdout,
      `REGISTRY_HOST=${hostOf(mock.baseUrl)}\nREGISTRY_USER=${REGISTRY_USER}\nREGISTRY_TOKEN=${REGISTRY_PASSWORD}\n`,
    );
    assert.equal(cli(dir, ["registry", "clear"]).stdout, "已移除 OCI 镜像仓库凭据\n");
    assert.equal(cli(dir, ["registry", "clear"]).stdout, "没有可移除的 OCI 镜像仓库凭据\n");
    mock.close();
  });

  it("registry --profile：多实例独立键名（REGISTRY_NA_HOST/_USER/_TOKEN），clear 只删该 profile", async () => {
    const na = await startMock({ mode: "registry" });
    const dir = tempDir();
    assert.equal(
      cli(
        dir,
        ["registry", "set", `--url=${na.baseUrl}`, `--user=${REGISTRY_USER}`, "--profile=na"],
        { input: REGISTRY_PASSWORD },
      ).stdout,
      `已保存 OCI 镜像仓库 凭据（profile: NA）：${na.baseUrl}\n`,
    );
    const env = cli(dir, ["registry", "env", "--profile=na"]);
    assert.match(env.stderr, /注意：下面输出包含明文密码\/token/);
    assert.equal(
      env.stdout,
      `REGISTRY_NA_HOST=${hostOf(na.baseUrl)}\n` +
        `REGISTRY_NA_USER=${REGISTRY_USER}\n` +
        `REGISTRY_NA_TOKEN=${REGISTRY_PASSWORD}\n`,
    );
    assert.equal(
      cli(dir, ["registry", "status", "--profile=na"]).stdout,
      `仓库：${hostOf(na.baseUrl)}\n认证：Registry V2（registry/2.0）\n用户：${REGISTRY_USER}\n`,
    );
    // 默认前缀与 profile 独立：未配置默认凭据时提示仍指向 flowlet registry set。
    assert.match(cli(dir, ["registry", "env"]).stderr, /尚未配置 OCI 镜像仓库地址，先运行 flowlet registry set/);
    assert.equal(
      cli(dir, ["registry", "clear", "--profile=na"]).stdout,
      "已移除 OCI 镜像仓库凭据（profile: NA）\n",
    );
    assert.match(cli(dir, ["registry", "env", "--profile=na"]).stderr, /--profile=NA/);
    na.close();
  });
});

// ─── pull（Flowlet Web Host → 本地 .env） ──────────────────────────────────

describe("pull", () => {
  it("成功写入 GITLAB_URL/GITLAB_TOKEN 并保留已有注释/非凭据键", async () => {
    const web = await startMock({
      mode: "flowlet-web",
      entries: [
        { name: "主实例", provider: "gitlab", baseUrl: "https://gitlab.example.com", token: "glpat-pulled-1" },
      ],
    });
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
    web.close();
  });

  it("dockhand 条目映射为 DOCKHAND_URL / DOCKHAND_TOKEN", async () => {
    const web = await startMock({
      mode: "flowlet-web",
      entries: [
        { name: "主实例", provider: "gitlab", baseUrl: "https://gitlab.example.com", token: "glpat-pulled-1" },
        {
          name: "预发面板",
          provider: "dockhand",
          baseUrl: "http://dockhand.example.com:3000",
          token: "dck-pulled-1",
        },
      ],
    });
    const dir = tempDir();
    cli(dir, ["init"]);
    const pulled = cli(dir, ["pull", `--server=${web.baseUrl}`, `--token=${ADMIN_TOKEN}`]);
    assert.equal(pulled.status, 0, pulled.stderr);
    assert.match(pulled.stdout, /已写入 DOCKHAND_URL（来自 dockhand \/ 预发面板）/);
    assert.match(pulled.stdout, /已写入 DOCKHAND_TOKEN（来自 dockhand \/ 预发面板）/);
    assert.match(pulled.stdout, /完成：写入 4 个键 → /);
    assert.equal(cli(dir, ["get", "DOCKHAND_URL", "--reveal"]).stdout, "http://dockhand.example.com:3000\n");
    assert.equal(cli(dir, ["get", "DOCKHAND_TOKEN", "--reveal"]).stdout, "dck-pulled-1\n");
    const meta = JSON.parse(metaFile(dir)) as Record<string, Record<string, unknown>>;
    assert.equal(meta.DOCKHAND_URL!.kind, "service");
    assert.equal(meta.DOCKHAND_TOKEN!.kind, "cli_token");
    assert.equal(meta.DOCKHAND_TOKEN!.note, "dockhand / 预发面板");
    web.close();
  });

  it("uptime-kuma 条目映射为 UPTIME_KUMA_URL / UPTIME_KUMA_API_KEY", async () => {
    const web = await startMock({
      mode: "flowlet-web",
      entries: [
        {
          name: "TW Kuma",
          provider: "uptime-kuma",
          baseUrl: "https://tcwireless.qa.17usoft.com/uptime-kuma",
          token: "uk1-pulled-1",
          envPrefix: "UPTIME_KUMA_TW",
        },
      ],
    });
    const dir = tempDir();
    const pulled = cli(dir, ["pull", `--server=${web.baseUrl}`, `--token=${ADMIN_TOKEN}`]);
    assert.equal(pulled.status, 0, pulled.stderr);
    assert.match(pulled.stdout, /已写入 UPTIME_KUMA_TW_URL（来自 uptime-kuma \/ TW Kuma）/);
    assert.match(pulled.stdout, /已写入 UPTIME_KUMA_TW_API_KEY（来自 uptime-kuma \/ TW Kuma）/);
    assert.match(pulled.stdout, /完成：写入 2 个键 → /);
    assert.equal(
      cli(dir, ["get", "UPTIME_KUMA_TW_API_KEY", "--reveal"]).stdout,
      "uk1-pulled-1\n",
    );
    // 密钥键必须是 _API_KEY，不能同时出现 _TOKEN（与其它 provider 的键名区分）。
    assert.equal(cli(dir, ["get", "UPTIME_KUMA_TW_TOKEN"]).status, 1);
    web.close();
  });

  it("pull 使用导出条目的 envPrefix（多实例），旧服务端缺失时回退 provider 大写", async () => {
    const web = await startMock({
      mode: "flowlet-web",
      entries: [
        {
          name: "北美",
          provider: "dockhand",
          baseUrl: "http://na.dockhand.example.com:3000",
          token: "dck-na-pulled",
          envPrefix: "DOCKHAND_NA",
        },
        {
          name: "旧服务端",
          provider: "gitlab",
          baseUrl: "https://gitlab.example.com",
          token: "glpat-old",
        },
      ],
    });
    const dir = tempDir();
    const pulled = cli(dir, ["pull", `--server=${web.baseUrl}`, `--token=${ADMIN_TOKEN}`]);
    assert.equal(pulled.status, 0, pulled.stderr);
    assert.match(pulled.stdout, /已写入 DOCKHAND_NA_URL（来自 dockhand \/ 北美）/);
    assert.match(pulled.stdout, /已写入 DOCKHAND_NA_TOKEN（来自 dockhand \/ 北美）/);
    assert.match(pulled.stdout, /已写入 GITLAB_URL（来自 gitlab \/ 旧服务端）/);
    assert.match(pulled.stdout, /完成：写入 4 个键 → /);
    assert.equal(
      cli(dir, ["get", "DOCKHAND_NA_URL", "--reveal"]).stdout,
      "http://na.dockhand.example.com:3000\n",
    );
    assert.equal(cli(dir, ["get", "GITLAB_URL", "--reveal"]).stdout, "https://gitlab.example.com\n");
    const meta = JSON.parse(metaFile(dir)) as Record<string, Record<string, unknown>>;
    assert.equal(meta.DOCKHAND_NA_TOKEN!.kind, "cli_token");
    assert.equal(meta.DOCKHAND_NA_TOKEN!.note, "dockhand / 北美");
    web.close();
  });

  it("jenkins 条目映射为 JENKINS_URL / JENKINS_USER / JENKINS_TOKEN（缺失 username 写空串）", async () => {
    const web = await startMock({
      mode: "flowlet-web",
      entries: [
        {
          name: "预发 Jenkins",
          provider: "jenkins",
          baseUrl: "https://jenkins.example.com",
          token: "jenkins-pulled-1",
          username: "alice",
        },
        {
          name: "旧导出",
          provider: "jenkins",
          baseUrl: "https://ci.example.com",
          token: "jenkins-pulled-2",
          envPrefix: "JENKINS_CI",
        },
      ],
    });
    const dir = tempDir();
    cli(dir, ["init"]);
    const pulled = cli(dir, ["pull", `--server=${web.baseUrl}`, `--token=${ADMIN_TOKEN}`]);
    assert.equal(pulled.status, 0, pulled.stderr);
    assert.match(pulled.stdout, /已写入 JENKINS_URL（来自 jenkins \/ 预发 Jenkins）/);
    assert.match(pulled.stdout, /已写入 JENKINS_USER（来自 jenkins \/ 预发 Jenkins）/);
    assert.match(pulled.stdout, /已写入 JENKINS_CI_USER（来自 jenkins \/ 旧导出）/);
    assert.match(pulled.stdout, /完成：写入 6 个键 → /);
    assert.equal(cli(dir, ["get", "JENKINS_URL", "--reveal"]).stdout, "https://jenkins.example.com\n");
    assert.equal(cli(dir, ["get", "JENKINS_USER", "--reveal"]).stdout, "alice\n");
    assert.equal(cli(dir, ["get", "JENKINS_TOKEN", "--reveal"]).stdout, "jenkins-pulled-1\n");
    // 旧导出没有 username：USER 仍写入（空串），凭证键的三键结构不变。
    assert.equal(cli(dir, ["get", "JENKINS_CI_USER", "--reveal"]).stdout, "\n");
    const meta = JSON.parse(metaFile(dir)) as Record<string, Record<string, unknown>>;
    assert.equal(meta.JENKINS_URL!.kind, "service");
    assert.equal(meta.JENKINS_USER!.kind, "service");
    assert.equal(meta.JENKINS_USER!.note, "jenkins / 预发 Jenkins");
    assert.equal(meta.JENKINS_TOKEN!.kind, "cli_token");
    assert.equal(meta.JENKINS_CI_USER!.kind, "service");
    assert.equal(meta.JENKINS_CI_USER!.note, "jenkins / 旧导出");
    web.close();
  });

  it("beszel 条目映射为 BESZEL_URL / BESZEL_EMAIL / BESZEL_PASSWORD（缺失 username 写空串）", async () => {
    const web = await startMock({
      mode: "flowlet-web",
      entries: [
        {
          name: "监控 Hub",
          provider: "beszel",
          baseUrl: "http://beszel.example.com:8090",
          token: "beszel-password-1",
          username: "ops@example.com",
        },
        {
          name: "旧导出",
          provider: "beszel",
          baseUrl: "http://mon.example.com:8090",
          token: "beszel-password-2",
          envPrefix: "BESZEL_MON",
        },
      ],
    });
    const dir = tempDir();
    cli(dir, ["init"]);
    const pulled = cli(dir, ["pull", `--server=${web.baseUrl}`, `--token=${ADMIN_TOKEN}`]);
    assert.equal(pulled.status, 0, pulled.stderr);
    assert.match(pulled.stdout, /已写入 BESZEL_EMAIL（来自 beszel \/ 监控 Hub）/);
    assert.match(pulled.stdout, /已写入 BESZEL_MON_PASSWORD（来自 beszel \/ 旧导出）/);
    assert.match(pulled.stdout, /完成：写入 6 个键 → /);
    assert.equal(cli(dir, ["get", "BESZEL_EMAIL", "--reveal"]).stdout, "ops@example.com\n");
    assert.equal(cli(dir, ["get", "BESZEL_PASSWORD", "--reveal"]).stdout, "beszel-password-1\n");
    // 旧导出没有 username：EMAIL 仍写入（空串），凭证键的三键结构不变。
    assert.equal(cli(dir, ["get", "BESZEL_MON_EMAIL", "--reveal"]).stdout, "\n");
    const meta = JSON.parse(metaFile(dir)) as Record<string, Record<string, unknown>>;
    assert.equal(meta.BESZEL_URL!.kind, "service");
    assert.equal(meta.BESZEL_EMAIL!.kind, "service");
    assert.equal(meta.BESZEL_PASSWORD!.kind, "cli_token");
    assert.equal(meta.BESZEL_MON_EMAIL!.note, "beszel / 旧导出");
    web.close();
  });

  it("registry 条目映射为 REGISTRY_HOST / REGISTRY_USER / REGISTRY_TOKEN（缺失 username 写空串）", async () => {
    const web = await startMock({
      mode: "flowlet-web",
      entries: [
        {
          name: "主仓库",
          provider: "registry",
          baseUrl: "https://hub.example.com",
          token: "registry-pulled-1",
          username: "robot$flowlet+pull",
        },
        {
          name: "旧导出",
          provider: "registry",
          baseUrl: "http://registry.example.com:5000",
          token: "registry-pulled-2",
          envPrefix: "REGISTRY_NA",
        },
      ],
    });
    const dir = tempDir();
    cli(dir, ["init"]);
    const pulled = cli(dir, ["pull", `--server=${web.baseUrl}`, `--token=${ADMIN_TOKEN}`]);
    assert.equal(pulled.status, 0, pulled.stderr);
    assert.match(pulled.stdout, /已写入 REGISTRY_HOST（来自 registry \/ 主仓库）/);
    assert.match(pulled.stdout, /已写入 REGISTRY_TOKEN（来自 registry \/ 主仓库）/);
    assert.match(pulled.stdout, /已写入 REGISTRY_NA_HOST（来自 registry \/ 旧导出）/);
    assert.match(pulled.stdout, /完成：写入 6 个键 → /);
    // HOST 是 host[:port]（无 scheme），与 docker login / helm registry login 的用法一致。
    assert.equal(cli(dir, ["get", "REGISTRY_HOST", "--reveal"]).stdout, "hub.example.com\n");
    assert.equal(cli(dir, ["get", "REGISTRY_USER", "--reveal"]).stdout, "robot$flowlet+pull\n");
    assert.equal(cli(dir, ["get", "REGISTRY_TOKEN", "--reveal"]).stdout, "registry-pulled-1\n");
    assert.equal(
      cli(dir, ["get", "REGISTRY_NA_HOST", "--reveal"]).stdout,
      "registry.example.com:5000\n",
    );
    // 旧导出没有 username：USER 仍写入（空串），三键结构不变。
    assert.equal(cli(dir, ["get", "REGISTRY_NA_USER", "--reveal"]).stdout, "\n");
    const meta = JSON.parse(metaFile(dir)) as Record<string, Record<string, unknown>>;
    assert.equal(meta.REGISTRY_HOST!.kind, "service");
    assert.equal(meta.REGISTRY_USER!.kind, "service");
    assert.equal(meta.REGISTRY_TOKEN!.kind, "cli_token");
    assert.equal(meta.REGISTRY_NA_USER!.note, "registry / 旧导出");
    web.close();
  });

  it("--dry-run 不写文件；401 与空列表行为；环境变量凭据兜底", async () => {
    const web = await startMock({
      mode: "flowlet-web",
      entries: [
        { name: "主实例", provider: "gitlab", baseUrl: "https://gitlab.example.com", token: "glpat-pulled-1" },
      ],
    });
    const dir = tempDir();
    const dry = cli(dir, ["pull", `--server=${web.baseUrl}`, `--token=${ADMIN_TOKEN}`, "--dry-run"]);
    assert.equal(dry.status, 0);
    assert.match(dry.stdout, /将写入 GITLAB_URL/);
    assert.match(dry.stdout, /dry-run：未写入任何凭据/);
    assert.ok(!existsSync(path.join(dir, "credentials.env")));

    assert.equal(
      cli(dir, ["pull", `--server=${web.baseUrl}`, "--token=wrong-admin-token"]).stderr,
      "管理凭据无效（401）：请检查 --token / FLOWLET_ADMIN_TOKEN\n",
    );
    assert.equal(
      cli(dir, ["pull", `--server=${web.baseUrl}`], { env: { FLOWLET_ADMIN_TOKEN: undefined } }).stderr,
      `缺少凭据：先运行 flowlet login --server=${web.baseUrl}（或 --token=管理凭据 / FLOWLET_ADMIN_TOKEN）\n`,
    );
    assert.equal(cli(dir, ["pull", `--server=${web.baseUrl}`], { env: { FLOWLET_ADMIN_TOKEN: ADMIN_TOKEN } }).status, 0);
    assert.equal(cli(dir, ["pull", "--server=ftp://x"]).stderr, "--server 必须是 http 或 https 地址\n");
    web.close();

    const emptyWeb = await startMock({ mode: "flowlet-web", entries: [] });
    assert.equal(cli(dir, ["pull", `--server=${emptyWeb.baseUrl}`, `--token=${ADMIN_TOKEN}`]).stdout, "服务端没有启用中的服务凭据\n");
    emptyWeb.close();
  });

  it("未知服务类型跳过并写 stderr，不写该凭据", async () => {
    const web = await startMock({
      mode: "flowlet-web",
      entries: [{ name: "未知", provider: "github", baseUrl: "https://github.com", token: "ghp-x" }],
    });
    const dir = tempDir();
    cli(dir, ["init"]);
    const pulled = cli(dir, ["pull", `--server=${web.baseUrl}`, `--token=${ADMIN_TOKEN}`]);
    assert.equal(pulled.status, 0);
    assert.ok(pulled.stderr.includes("跳过未知服务类型：github（未知）"));
    assert.ok(!envFile(dir).includes("GITHUB_URL"));
    assert.match(pulled.stdout, /完成：写入 0 个键/);
    web.close();
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
      const rust = cli(rustDir, step.args, { input: step.input, rust: true });
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
    cli(rustDir, ["set", "RUST_KEY"], { input: "rust-value", rust: true });
    cli(nodeDir, ["set", "NODE_KEY"], { input: "node-value" });

    assert.match(cli(rustDir, ["list"]).stdout, /^RUST_KEY {2}\[api_key\]/m);
    assert.equal(cli(rustDir, ["get", "RUST_KEY", "--mask"]).stdout, "rust…alue\n");
    assert.match(cli(nodeDir, ["list"], { rust: true }).stdout, /^NODE_KEY {2}\[api_key\]/m);
    assert.equal(cli(nodeDir, ["get", "NODE_KEY"], { rust: true }).stdout, "node-value\n");
    cli(nodeDir, ["set", "MIXED"], { input: "mixed", rust: true });
    assert.equal(cli(nodeDir, ["get", "MIXED", "--reveal"]).stdout, "mixed\n");
  });
});