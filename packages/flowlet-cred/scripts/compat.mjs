#!/usr/bin/env node
// Rust `flowlet-cred` (legacy) ↔ Node `@flowlet/cred` 兼容性验收。
//
// 用法：node packages/flowlet-cred/scripts/compat.mjs
//   FLOWLET_RUST_CRED=<path>   覆盖 Rust CLI 路径（默认主仓库 debug 构建）
//
// 做法：同一命令序列分别在两个**独立临时目录**跑 Rust 与 Node CLI（同一 mock GitLab /
// mock Flowlet Web），逐条比较 exit/stdout/stderr 与 credentials.env / credentials.json
// （路径与 RFC3339 时间戳归一化）；再做交叉读取验证。绝不打印真实 token：差异行在输出前脱敏。
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");
const NODE_CLI = path.join(PKG_ROOT, "src", "cli.ts");
const MOCK_SERVER = path.join(PKG_ROOT, "src", "__tests__", "mock-server.ts");
// REPO_ROOT 是 .worktrees/electron；主仓库在其上两级（Rust 产物属于主树）。
const RUST_CLI =
  process.env.FLOWLET_RUST_CRED ??
  path.resolve(REPO_ROOT, "..", "..", "src-tauri", "target", "debug", "flowlet-cred");

const GITLAB_TOKEN = "glpat-compat-fixture-token-9z8y";
const ADMIN_TOKEN = "flowlet-admin-token-0123456789";

const children = [];
const tempDirs = [];
let failures = 0;

function tempDir(label) {
  const dir = mkdtempSync(path.join(tmpdir(), `flowlet-cred-compat-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function startMock(options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MOCK_SERVER, JSON.stringify(options)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString();
      const match = /PORT (\d+)\n/.exec(buffer);
      if (match === null) return;
      child.stdout.off("data", onData);
      const port = Number(match[1]);
      resolve({
        baseUrl:
          options.mode === "gitlab" ? `http://127.0.0.1:${port}/gitlab` : `http://127.0.0.1:${port}`,
        close: () => child.kill("SIGKILL"),
      });
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    setTimeout(() => reject(new Error("mock server 启动超时")), 10_000).unref();
  });
}

function runCli(kind, dir, args, input = "", env = {}) {
  const command = kind === "rust" ? RUST_CLI : process.execPath;
  const argv = kind === "rust" ? args : [NODE_CLI, ...args];
  const result = spawnSync(command, argv, {
    input,
    env: { ...process.env, FLOWLET_CRED_DIR: dir, ...env },
    encoding: "utf8",
  });
  if (result.error !== undefined) {
    return { status: null, stdout: "", stderr: `${kind} CLI 启动失败：${result.error.message}` };
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function normalize(text, dir) {
  return text
    .split(dir)
    .join("<DIR>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, "<TS>");
}

/** 差异输出脱敏：包含 token/secret 的行只显示前缀。 */
function redact(line) {
  if (/token|secret|authorization/i.test(line)) return "<redacted line>";
  return line;
}

function firstLineDifference(actual, expected) {
  const a = actual.split("\n");
  const b = expected.split("\n");
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) {
      return `line ${index + 1}: rust=${redact(b[index] ?? "<eof>")} node=${redact(a[index] ?? "<eof>")}`;
    }
  }
  return "<no difference>";
}

function compare(label, actual, expected) {
  if (actual === expected) return;
  failures += 1;
  console.log(`  ✖ ${label}: ${firstLineDifference(actual, expected)}`);
}

function readOrEmpty(dir, name) {
  try {
    return readFileSync(path.join(dir, name), "utf8");
  } catch {
    return "";
  }
}

function fileMode(dir, name) {
  try {
    return statSync(path.join(dir, name)).mode & 0o777;
  } catch {
    return -1;
  }
}

async function main() {
  const gitlab = await startMock({
    mode: "gitlab",
    gitlabToken: GITLAB_TOKEN,
    adminToken: ADMIN_TOKEN,
    projectPages: [
      [
        { id: 42, path_with_namespace: "group/app", name: "app", default_branch: "main", visibility: "private" },
      ],
      [{ id: 7, path_with_namespace: "team/svc", name: "svc" }],
    ],
  });
  const web = await startMock({
    mode: "flowlet-web",
    adminToken: ADMIN_TOKEN,
    entries: [
      { name: "主实例", provider: "gitlab", baseUrl: "https://gitlab.example.com", token: "glpat-pulled-fixture" },
    ],
  });

  const dirs = { rust: tempDir("rust"), node: tempDir("node") };
  const sequence = [
    { args: ["init"] },
    { args: ["set", "KEY_A", "--kind=api_key", "--note=first"], input: "value-a" },
    { args: ["set", "KEY_B", "--value=two words", "--kind=cli_token", "--note=second"] },
    { args: ["list"] },
    { args: ["list", "--json"] },
    { args: ["get", "KEY_A", "--mask"] },
    { args: ["env"] },
    { args: ["export", "--format=json"] },
    { args: ["doctor"] },
    { args: ["run", "--with=KEY_A", "--", process.execPath, "-e", "console.log(process.env.KEY_A)"] },
    { args: ["gitlab", "set", `--url=${gitlab.baseUrl}`], input: GITLAB_TOKEN },
    { args: ["gitlab", "status"] },
    { args: ["gitlab", "projects"] },
    { args: ["gitlab", "api", "/user"] },
    { args: ["gitlab", "api", "/projects"] },
    { args: ["pull", `--server=${web.baseUrl}`, `--token=${ADMIN_TOKEN}`] },
    { args: ["list"] },
    { args: ["env"] },
    { args: ["unset", "KEY_A"] },
    { args: ["doctor"] },
  ];

  console.log("命令序列（Rust legacy ↔ Node 默认实现）");
  for (const step of sequence) {
    const rust = runCli("rust", dirs.rust, step.args, step.input ?? "");
    const node = runCli("node", dirs.node, step.args, step.input ?? "");
    const label = step.args.join(" ");
    compare(`exit(${label})`, String(node.status), String(rust.status));
    compare(`stdout(${label})`, normalize(node.stdout, dirs.node), normalize(rust.stdout, dirs.rust));
    compare(`stderr(${label})`, normalize(node.stderr, dirs.node), normalize(rust.stderr, dirs.rust));
    if (node.status === rust.status && normalize(node.stdout, dirs.node) === normalize(rust.stdout, dirs.rust)) {
      console.log(`  ✔ ${label}`);
    }
  }

  console.log("文件对比");
  compare(
    "credentials.env",
    normalize(readOrEmpty(dirs.node, "credentials.env"), dirs.node),
    normalize(readOrEmpty(dirs.rust, "credentials.env"), dirs.rust),
  );
  compare(
    "credentials.json",
    normalize(readOrEmpty(dirs.node, "credentials.json"), dirs.node),
    normalize(readOrEmpty(dirs.rust, "credentials.json"), dirs.rust),
  );
  compare("env mode", String(fileMode(dirs.node, "credentials.env")), String(fileMode(dirs.rust, "credentials.env")));
  compare("meta mode", String(fileMode(dirs.node, "credentials.json")), String(fileMode(dirs.rust, "credentials.json")));
  if (failures === 0) console.log("  ✔ credentials.env / credentials.json / 权限一致");

  console.log("交叉读取");
  const nodeReadsRust = runCli("node", dirs.rust, ["list"]);
  const rustReadsNode = runCli("rust", dirs.node, ["list"]);
  compare(
    "Node 读 Rust 库",
    normalize(nodeReadsRust.stdout, dirs.rust),
    normalize(runCli("rust", dirs.rust, ["list"]).stdout, dirs.rust),
  );
  compare(
    "Rust 读 Node 库",
    normalize(rustReadsNode.stdout, dirs.node),
    normalize(runCli("node", dirs.node, ["list"]).stdout, dirs.node),
  );
  const nodeGetRust = runCli("node", dirs.rust, ["get", "KEY_B", "--reveal"]);
  const rustGetRust = runCli("rust", dirs.rust, ["get", "KEY_B"]);
  compare("Node 读取 Rust 库的值", nodeGetRust.stdout, rustGetRust.stdout);
  if (failures === 0) console.log("  ✔ 双向交叉读取一致");

  console.log(
    failures === 0
      ? "\n结论：Node CLI 与 Rust legacy CLI 在同一序列下输出与文件字节级一致（时间戳归一化）。"
      : `\n结论：发现 ${failures} 处差异。`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error("兼容性验证失败：", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const child of children) child.kill("SIGKILL");
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });