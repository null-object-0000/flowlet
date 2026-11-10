// flowlet login / logout / pull 本机授权的端到端测试。Owner: node-web。
//
// 与 cli.test.ts 一致：全部用例 spawn 真实 CLI 进程；mock Flowlet Web Host 跑在独立子进程里。
// login 的 loopback 回调是 CLI 进程内真实监听的 127.0.0.1 随机端口；「浏览器」由测试进程扮演：
// 拿到 CLI 打印的授权 URL 后 fetch 它（mock 校验参数后直接 302 回 loopback，等价浏览器完成授权）。
// 安全断言：CLI stdout/stderr 绝不能出现明文 token；fixture token 固定以便检查。
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
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

const ADMIN_TOKEN = "flowlet-admin-token-0123456789";
const CLI_TOKEN = `flwcli_${"F".repeat(43)}`;
const CLI_TOKEN_A = `flwcli_${"A".repeat(43)}`;
const CLI_TOKEN_B = `flwcli_${"B".repeat(43)}`;
const ENTRIES = [
  { name: "主实例", provider: "gitlab", baseUrl: "https://gitlab.example.com", token: "glpat-pulled-1" },
];

const processes: ChildProcess[] = [];
const tempDirs: string[] = [];
after(() => {
  for (const child of processes) child.kill("SIGKILL");
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "flowlet-auth-test-"));
  tempDirs.push(dir);
  return dir;
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface MockHandle {
  baseUrl: string;
  close: () => void;
}

function startMock(options: Record<string, unknown>): Promise<MockHandle> {
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
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => child.kill("SIGKILL"),
      });
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    setTimeout(() => reject(new Error("mock server 启动超时")), 10_000).unref();
  });
}

function cliEnv(dir: string, overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FLOWLET_CRED_DIR: dir };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** 同步 CLI（用于参数校验、pull、logout 等不等待浏览器回调用例）。 */
function cli(
  dir: string,
  args: string[],
  options: { env?: Record<string, string | undefined> } = {},
): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env: cliEnv(dir, options.env ?? {}),
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

interface RunningCli {
  child: ChildProcess;
  done: Promise<CliResult>;
  stdout: () => string;
  stderr: () => string;
}

/** 异步 CLI（login 要等浏览器回调，不能用 spawnSync 阻塞测试进程）。 */
function spawnCli(
  dir: string,
  args: string[],
  options: { env?: Record<string, string | undefined> } = {},
): RunningCli {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: cliEnv(dir, options.env ?? {}),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const done = new Promise<CliResult>((resolve) => {
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  return {
    child,
    done,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForOutput(
  getOutput: () => string,
  pattern: RegExp,
  label: string,
  timeoutMs = 15_000,
): Promise<RegExpExecArray> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = pattern.exec(getOutput());
    if (match !== null) return match;
    await sleep(20);
  }
  throw new Error(`等待 ${label} 超时；已输出：${getOutput()}`);
}

const AUTHORIZE_URL_PATTERN = /(http:\/\/\S+\/api\/auth\/cli\/start\?[^\s]+)/;

/** 跑完整 login 流程：CLI 打印授权 URL → 测试扮演浏览器 fetch 它（跟随 302 到 loopback）。 */
async function loginThroughBrowser(
  dir: string,
  server: string,
  extraArgs: string[] = [],
  timeoutMs = 15_000,
): Promise<{ result: CliResult; authorizeUrl: string }> {
  const running = spawnCli(dir, [
    "login",
    `--server=${server}`,
    "--no-browser",
    "--timeout=20",
    ...extraArgs,
  ]);
  try {
    const match = await waitForOutput(
      running.stdout,
      AUTHORIZE_URL_PATTERN,
      "login 授权 URL",
      timeoutMs,
    );
    const authorizeUrl = match[1]!;
    const page = await fetch(authorizeUrl);
    assert.equal(page.status, 200, "浏览器完成授权后 loopback 应返回 200 页面");
    const result = await running.done;
    return { result, authorizeUrl };
  } finally {
    running.child.kill("SIGKILL");
  }
}

function readJson(name: string, dir: string): unknown {
  return JSON.parse(readFileSync(path.join(dir, name), "utf8"));
}

interface AuthFileShape {
  version: number;
  servers: Record<
    string,
    { token: string; expiresAt: string; name: string; savedAt: string }
  >;
}

function readAuth(dir: string): AuthFileShape {
  return readJson("auth.json", dir) as AuthFileShape;
}

function writeAuth(dir: string, servers: Record<string, unknown>): void {
  writeFileSync(
    path.join(dir, "auth.json"),
    `${JSON.stringify({ version: 1, servers }, null, 2)}\n`,
  );
}

function modeOf(target: string): number {
  return statSync(target).mode & 0o777;
}

function noTempFiles(dir: string): void {
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.includes(".tmp-")),
    [],
  );
}

// ─── login（浏览器授权） ───────────────────────────────────────────────────

describe("login（浏览器授权）", () => {
  it("PKCE + loopback 回调换 token，auth.json 0600 原子写，输出不含明文 token", async () => {
    const mock = await startMock({
      mode: "flowlet-web",
      cliAuth: true,
      cliToken: CLI_TOKEN,
      entries: ENTRIES,
    });
    const dir = tempDir();
    try {
      // server 带尾斜杠：auth.json key 必须归一为 scheme://host[:port]。
      const { result, authorizeUrl } = await loginThroughBrowser(dir, `${mock.baseUrl}/`, [
        "--name=runner-a",
      ]);
      assert.equal(result.status, 0, result.stderr);

      const parsed = new URL(authorizeUrl);
      assert.equal(`${parsed.origin}${parsed.pathname}`, `${mock.baseUrl}/api/auth/cli/start`);
      assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");
      assert.match(parsed.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
      assert.match(parsed.searchParams.get("state") ?? "", /^[A-Za-z0-9_-]{43}$/);
      assert.equal(parsed.searchParams.get("name"), "runner-a");
      const redirectUri = new URL(parsed.searchParams.get("redirect_uri") ?? "");
      assert.equal(redirectUri.protocol, "http:");
      assert.equal(redirectUri.hostname, "127.0.0.1");
      assert.equal(redirectUri.pathname, "/callback");
      assert.ok(Number(redirectUri.port) > 0, "loopback 必须是真实随机端口");

      assert.ok(result.stdout.includes("请在浏览器中完成授权："));
      assert.ok(result.stdout.includes(`  ${authorizeUrl}`));
      assert.ok(result.stdout.includes("等待授权回调（20 秒）…"));
      assert.ok(result.stdout.includes(`已登录 ${mock.baseUrl}\n`));
      assert.ok(result.stdout.includes("授权：runner-a（仅可用于 flowlet pull 同步服务凭据）\n"));
      assert.ok(result.stdout.includes(`接下来：flowlet pull --server=${mock.baseUrl}\n`));
      // 安全边界：任何输出都不得出现明文 token。
      assert.ok(!result.stdout.includes(CLI_TOKEN), "login stdout 不能包含明文 token");
      assert.ok(!result.stderr.includes(CLI_TOKEN), "login stderr 不能包含明文 token");

      const auth = readAuth(dir);
      assert.equal(auth.version, 1);
      assert.deepEqual(Object.keys(auth.servers), [mock.baseUrl]);
      const record = auth.servers[mock.baseUrl]!;
      assert.equal(record.token, CLI_TOKEN);
      assert.equal(record.name, "runner-a");
      assert.match(record.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.match(record.savedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      // Windows 没有 POSIX 权限位（chmod/stat 恒为 0666），权限断言只在 POSIX 生效。
      if (process.platform !== "win32") {
        assert.equal(modeOf(path.join(dir, "auth.json")), 0o600);
        assert.equal(modeOf(dir), 0o700);
      }
      noTempFiles(dir);
    } finally {
      mock.close();
    }
  });

  it("重复 login 覆盖该 server 记录，多 server 记录互不影响", async () => {
    const mockA = await startMock({
      mode: "flowlet-web",
      cliAuth: true,
      cliToken: CLI_TOKEN_A,
      entries: ENTRIES,
    });
    const mockB = await startMock({
      mode: "flowlet-web",
      cliAuth: true,
      cliToken: CLI_TOKEN_B,
      entries: ENTRIES,
    });
    const dir = tempDir();
    try {
      const first = await loginThroughBrowser(dir, mockA.baseUrl, ["--name=runner-a1"]);
      assert.equal(first.result.status, 0, first.result.stderr);
      const second = await loginThroughBrowser(dir, mockB.baseUrl, ["--name=runner-b"]);
      assert.equal(second.result.status, 0, second.result.stderr);
      const third = await loginThroughBrowser(dir, mockA.baseUrl, ["--name=runner-a2"]);
      assert.equal(third.result.status, 0, third.result.stderr);

      const auth = readAuth(dir);
      assert.deepEqual(Object.keys(auth.servers).sort(), [mockA.baseUrl, mockB.baseUrl].sort());
      assert.equal(auth.servers[mockA.baseUrl]!.name, "runner-a2");
      assert.equal(auth.servers[mockA.baseUrl]!.token, CLI_TOKEN_A);
      assert.equal(auth.servers[mockB.baseUrl]!.name, "runner-b");
      assert.equal(auth.servers[mockB.baseUrl]!.token, CLI_TOKEN_B);
      // Windows 没有 POSIX 权限位（chmod/stat 恒为 0666），权限断言只在 POSIX 生效。
      if (process.platform !== "win32") assert.equal(modeOf(path.join(dir, "auth.json")), 0o600);
      noTempFiles(dir);
    } finally {
      mockA.close();
      mockB.close();
    }
  });

  it("state 不匹配：loopback 返回 400、CLI 退出码 1、不落盘", async () => {
    const mock = await startMock({ mode: "flowlet-web", cliAuth: true, cliToken: CLI_TOKEN });
    const dir = tempDir();
    const running = spawnCli(dir, [
      "login",
      `--server=${mock.baseUrl}`,
      "--no-browser",
      "--timeout=20",
    ]);
    try {
      const match = await waitForOutput(running.stdout, AUTHORIZE_URL_PATTERN, "login 授权 URL");
      const parsed = new URL(match[1]!);
      const redirectUri = parsed.searchParams.get("redirect_uri") ?? "";
      const response = await fetch(`${redirectUri}?code=bogus-code&state=wrong-state`);
      assert.equal(response.status, 400);
      assert.match(await response.text(), /state 不匹配/);
      const result = await running.done;
      assert.equal(result.status, 1);
      assert.match(result.stderr, /state 不匹配/);
      assert.ok(!existsSync(path.join(dir, "auth.json")));
    } finally {
      running.child.kill("SIGKILL");
      mock.close();
    }
  });

  it("换 token 失败：loopback 返回错误页、CLI 透出服务端可读文案", async () => {
    const mock = await startMock({ mode: "flowlet-web", cliAuth: true, cliToken: CLI_TOKEN });
    const dir = tempDir();
    const running = spawnCli(dir, [
      "login",
      `--server=${mock.baseUrl}`,
      "--no-browser",
      "--timeout=20",
    ]);
    try {
      const match = await waitForOutput(running.stdout, AUTHORIZE_URL_PATTERN, "login 授权 URL");
      const parsed = new URL(match[1]!);
      const redirectUri = parsed.searchParams.get("redirect_uri") ?? "";
      const state = parsed.searchParams.get("state") ?? "";
      const response = await fetch(
        `${redirectUri}?code=bogus-code&state=${encodeURIComponent(state)}`,
      );
      assert.equal(response.status, 502);
      assert.match(await response.text(), /授权失败/);
      const result = await running.done;
      assert.equal(result.status, 1);
      assert.match(result.stderr, /授权换取 token 失败（400）：授权码无效或已过期/);
      assert.ok(!existsSync(path.join(dir, "auth.json")));
    } finally {
      running.child.kill("SIGKILL");
      mock.close();
    }
  });

  it("超时：--timeout=1 秒后退出码 1 并提示重新 login", async () => {
    const mock = await startMock({ mode: "flowlet-web", cliAuth: true, cliToken: CLI_TOKEN });
    const dir = tempDir();
    try {
      const running = spawnCli(dir, [
        "login",
        `--server=${mock.baseUrl}`,
        "--no-browser",
        "--timeout=1",
      ]);
      const result = await running.done;
      assert.equal(result.status, 1);
      assert.match(result.stderr, /授权超时（1 秒）/);
      assert.match(result.stderr, /请重新运行 flowlet login/);
      assert.ok(!result.stderr.includes(CLI_TOKEN));
      assert.ok(!existsSync(path.join(dir, "auth.json")));
    } finally {
      mock.close();
    }
  });

  it("参数校验：缺 --server、非 http(s)、非法 --timeout、过长 --name", () => {
    const mock = tempDir();
    assert.equal(cli(mock, ["login"]).stderr, "login 需要 --server=http://<flowlet-web-host>:<port>\n");
    assert.equal(
      cli(mock, ["login", "--server=ftp://example.com"]).stderr,
      "--server 必须是 http 或 https 地址\n",
    );
    assert.equal(
      cli(mock, ["login", "--server=http://127.0.0.1:20134", "--timeout=abc"]).stderr,
      "--timeout 需要正整数秒（默认 180）\n",
    );
    assert.equal(
      cli(mock, ["login", "--server=http://127.0.0.1:20134", "--timeout=0"]).stderr,
      "--timeout 需要正整数秒（默认 180）\n",
    );
    assert.equal(
      cli(mock, ["login", "--server=http://127.0.0.1:20134", `--name=${"x".repeat(121)}`]).stderr,
      "--name 最多 120 个字符\n",
    );
    assert.ok(!existsSync(path.join(mock, "auth.json")));
  });
});

// ─── logout ───────────────────────────────────────────────────────────────

describe("logout", () => {
  it("未登录时退出码 0；登录后删除本机记录，再 logout 提示未找到", async () => {
    const mock = await startMock({
      mode: "flowlet-web",
      cliAuth: true,
      cliToken: CLI_TOKEN,
      entries: ENTRIES,
    });
    const dir = tempDir();
    try {
      assert.equal(
        cli(dir, ["logout", `--server=${mock.baseUrl}`]).stdout,
        `未找到 ${mock.baseUrl} 的登录记录\n`,
      );
      const login = await loginThroughBrowser(dir, mock.baseUrl, ["--name=runner-a"]);
      assert.equal(login.result.status, 0, login.result.stderr);
      assert.equal(cli(dir, ["logout"]).stderr, "logout 需要 --server=http://<flowlet-web-host>:<port>\n");
      const removed = cli(dir, ["logout", `--server=${mock.baseUrl}/`]);
      assert.equal(removed.status, 0);
      assert.equal(removed.stdout, `已退出 ${mock.baseUrl}\n`);
      assert.deepEqual(readAuth(dir).servers, {});
      assert.equal(
        cli(dir, ["logout", `--server=${mock.baseUrl}`]).stdout,
        `未找到 ${mock.baseUrl} 的登录记录\n`,
      );
      // 文件保留（空 servers），权限仍为 0600。
      // Windows 没有 POSIX 权限位（chmod/stat 恒为 0666），权限断言只在 POSIX 生效。
      if (process.platform !== "win32") assert.equal(modeOf(path.join(dir, "auth.json")), 0o600);
      noTempFiles(dir);
    } finally {
      mock.close();
    }
  });
});

// ─── pull 凭据解析（--token > FLOWLET_ADMIN_TOKEN > 本机授权） ─────────────

describe("pull 凭据解析", () => {
  it("正确口令：--token 优先于本机授权", async () => {
    const web = await startMock({ mode: "flowlet-web", entries: ENTRIES });
    const dir = tempDir();
    try {
      writeAuth(dir, {
        [web.baseUrl]: {
          token: "flwcli-stale-local-token",
          expiresAt: "2030-01-01T00:00:00Z",
          name: "stale",
          savedAt: "2026-11-10T00:00:00Z",
        },
      });
      const pulled = cli(dir, ["pull", `--server=${web.baseUrl}`, `--token=${ADMIN_TOKEN}`]);
      assert.equal(pulled.status, 0, pulled.stderr);
      assert.match(pulled.stdout, /已写入 GITLAB_URL/);
    } finally {
      web.close();
    }
  });

  it("正确口令：FLOWLET_ADMIN_TOKEN 优先于本机授权", async () => {
    const web = await startMock({ mode: "flowlet-web", entries: ENTRIES });
    const dir = tempDir();
    try {
      writeAuth(dir, {
        [web.baseUrl]: {
          token: "flwcli-stale-local-token",
          expiresAt: "2030-01-01T00:00:00Z",
          name: "stale",
          savedAt: "2026-11-10T00:00:00Z",
        },
      });
      const pulled = cli(dir, ["pull", `--server=${web.baseUrl}`], {
        env: { FLOWLET_ADMIN_TOKEN: ADMIN_TOKEN },
      });
      assert.equal(pulled.status, 0, pulled.stderr);
      assert.match(pulled.stdout, /已写入 GITLAB_URL/);
    } finally {
      web.close();
    }
  });

  it("真实 login 后 pull 自动使用 auth.json token；--dry-run 不写文件；输出不含 token", async () => {
    const web = await startMock({
      mode: "flowlet-web",
      cliAuth: true,
      cliToken: CLI_TOKEN,
      entries: ENTRIES,
    });
    const dir = tempDir();
    try {
      const login = await loginThroughBrowser(dir, `${web.baseUrl}/`, ["--name=runner-a"]);
      assert.equal(login.result.status, 0, login.result.stderr);

      const dry = cli(dir, ["pull", `--server=${web.baseUrl}`, "--dry-run"], {
        env: { FLOWLET_ADMIN_TOKEN: undefined },
      });
      assert.equal(dry.status, 0, dry.stderr);
      assert.match(dry.stdout, /将写入 GITLAB_URL/);
      assert.match(dry.stdout, /dry-run：未写入任何凭据/);
      assert.ok(!existsSync(path.join(dir, "credentials.env")));
      assert.ok(!dry.stdout.includes(CLI_TOKEN));

      const pulled = cli(dir, ["pull", `--server=${web.baseUrl}`], {
        env: { FLOWLET_ADMIN_TOKEN: undefined },
      });
      assert.equal(pulled.status, 0, pulled.stderr);
      assert.match(pulled.stdout, /已写入 GITLAB_URL（来自 gitlab \/ 主实例）/);
      assert.match(pulled.stdout, /已写入 GITLAB_TOKEN（来自 gitlab \/ 主实例）/);
      assert.match(pulled.stdout, /完成：写入 2 个键/);
      // pull 输出只报键名，不得打印凭据值。
      assert.ok(!pulled.stdout.includes(CLI_TOKEN));
      assert.ok(!pulled.stdout.includes("glpat-pulled-1"));
      const envFile = readFileSync(path.join(dir, "credentials.env"), "utf8");
      assert.ok(envFile.includes("GITLAB_URL=https://gitlab.example.com"));
      assert.ok(envFile.includes("GITLAB_TOKEN=glpat-pulled-1"));
    } finally {
      web.close();
    }
  });

  it("都没有凭据：提示先 flowlet login；本机 token 401：提示重新 login", async () => {
    const web = await startMock({ mode: "flowlet-web", entries: ENTRIES });
    const dir = tempDir();
    try {
      const missing = cli(dir, ["pull", `--server=${web.baseUrl}`], {
        env: { FLOWLET_ADMIN_TOKEN: undefined },
      });
      assert.equal(missing.status, 1);
      assert.equal(
        missing.stderr,
        `缺少凭据：先运行 flowlet login --server=${web.baseUrl}（或 --token=管理凭据 / FLOWLET_ADMIN_TOKEN）\n`,
      );

      // 本机有 token 但服务端不认（未启用的 CLI 授权 / 已撤销 / 已过期）→ 401。
      writeAuth(dir, {
        [web.baseUrl]: {
          token: CLI_TOKEN,
          expiresAt: "2030-01-01T00:00:00Z",
          name: "runner-a",
          savedAt: "2026-11-10T00:00:00Z",
        },
      });
      const expired = cli(dir, ["pull", `--server=${web.baseUrl}`], {
        env: { FLOWLET_ADMIN_TOKEN: undefined },
      });
      assert.equal(expired.status, 1);
      assert.equal(
        expired.stderr,
        `登录已过期或被撤销，请重新 flowlet login --server=${web.baseUrl}\n`,
      );
    } finally {
      web.close();
    }
  });

  it("本机 token 被服务端 403（作用域不足）：提示重新 login，而不是过期", async () => {
    const web = await startMock({
      mode: "flowlet-web",
      cliAuth: true,
      cliToken: CLI_TOKEN,
      cliForbidden: true,
      entries: ENTRIES,
    });
    const dir = tempDir();
    try {
      writeAuth(dir, {
        [web.baseUrl]: {
          token: CLI_TOKEN,
          expiresAt: "2030-01-01T00:00:00Z",
          name: "runner-a",
          savedAt: "2026-11-10T00:00:00Z",
        },
      });
      const forbidden = cli(dir, ["pull", `--server=${web.baseUrl}`], {
        env: { FLOWLET_ADMIN_TOKEN: undefined },
      });
      assert.equal(forbidden.status, 1);
      assert.equal(
        forbidden.stderr,
        `该凭据只能同步服务凭据，请重新 flowlet login --server=${web.baseUrl}\n`,
      );
    } finally {
      web.close();
    }
  });

  it("auth.json 损坏时报可读错误；显式 --token 不受本机文件影响", async () => {
    const web = await startMock({ mode: "flowlet-web", entries: ENTRIES });
    const dir = tempDir();
    try {
      writeFileSync(path.join(dir, "auth.json"), "{not json");
      const broken = cli(dir, ["pull", `--server=${web.baseUrl}`], {
        env: { FLOWLET_ADMIN_TOKEN: undefined },
      });
      assert.equal(broken.status, 1);
      assert.match(broken.stderr, /解析本机授权文件失败/);

      const explicit = cli(dir, ["pull", `--server=${web.baseUrl}`, `--token=${ADMIN_TOKEN}`]);
      assert.equal(explicit.status, 0, explicit.stderr);
      assert.match(explicit.stdout, /已写入 GITLAB_URL/);
    } finally {
      web.close();
    }
  });
});
