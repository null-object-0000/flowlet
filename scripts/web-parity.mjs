#!/usr/bin/env node
// Flowlet Web Host 对拍：Rust `headless` ↔ Node host。
//
// 用法：npm run node:parity
//   FLOWLET_PARITY_DB=<源库副本>        默认 /home/nichangen/.local/state/flowlet-docker-migration-20261109/flowlet.sqlite
//   FLOWLET_RUST_HEADLESS=<二进制>      默认 <主仓库>/src-tauri/target/release/headless
//   FLOWLET_PARITY_KEEP=1               保留两侧数据库副本（默认保留，便于排查）
//
// 服务凭据对拍：脚本内启动 mock GitLab（CE 10.8.7 语义：/api/v4/user、/api/v4/version），
// 两侧以 insecure + http 指向它，验证 providers/list/save/test/export/delete 与错误文案。
//
// 规则（docs/migration/node-host.md §6.2）：
// - 两侧使用**不同的** DB 副本文件，绝不复用同一个文件；
// - 同一命令序列分别在两侧执行，再逐条深比较 JSON；时间戳/端口/设备标识归一化；
// - 需要真实上游网络的命令跳过并报告：query_balance、test_connection、
//   fetch_channel_models、sync_models_cn_catalog、sync_models_dev_catalog；
// - 绝不打印账号 API Key / 管理凭据 / 客户端 Token：差异只输出字段路径，不输出值。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SOURCE_DB =
  process.env.FLOWLET_PARITY_DB ??
  "/home/nichangen/.local/state/flowlet-docker-migration-20261109/flowlet.sqlite";
const RUST_HEADLESS =
  process.env.FLOWLET_RUST_HEADLESS ??
  (() => {
    // REPO 是 .worktrees/electron；仓库主树在其上两级（Rust 二进制属于主树）。
    // 优先 debug（包含 SSO + 服务凭据的最新全功能构建），缺失再回退 release。
    const mainRepo = path.resolve(REPO, "..", "..");
    const debug = path.join(mainRepo, "src-tauri", "target", "debug", "headless");
    if (existsSync(debug)) return debug;
    return path.join(mainRepo, "src-tauri", "target", "release", "headless");
  })();
const NODE_ENTRY =
  process.env.FLOWLET_NODE_ENTRY ?? path.join(REPO, "packages", "flowlet-core", "src", "index.ts");
const STATIC_DIR = path.join(REPO, "dist-web");
const ADMIN_TOKEN = "flowlet-parity-admin-token-0123456789";
const PARITY_GITLAB_TOKEN = "glpat-parity-valid-token";
const PARITY_GITLAB_BAD_TOKEN = "glpat-parity-invalid-token";
const CLIENT_TOKEN = "flowlet-parity-client-token-0123456789";
const PUBLIC_PROXY_URL = "https://flowlet.example.test";
const PARITY_DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const WORK_ROOT = path.join(REPO, ".flowlet-dev-data", "parity");
const RUN_DIR = path.join(WORK_ROOT, new Date().toISOString().replace(/[:.]/g, "-"));
const SKIPPED_COMMANDS = [
  "query_balance",
  "test_connection",
  "fetch_channel_models",
  "sync_models_cn_catalog",
  "sync_models_dev_catalog",
];
const SENSITIVE_KEY = /api_key|management_key|authorization|token|secret|password/i;

/** 输出差异路径时脱敏：只展示字段路径，不展示值。 */
function safePathLabel(parts) {
  return parts.length === 0 ? "<root>" : parts.join(".");
}

function normalize(value, side) {
  const ports = side.ports;
  const walk = (node, keyPath) => {
    if (Array.isArray(node)) return node.map((item, index) => walk(item, [...keyPath, `[${index}]`]));
    if (node !== null && typeof node === "object") {
      const out = {};
      for (const [key, item] of Object.entries(node)) {
        if (key === "started_at") {
          out[key] = item === null ? null : "<started_at>";
          continue;
        }
        if ((key === "appVersion" || key === "app_version") && typeof item === "string") {
          out[key] = "<app_version>";
          continue;
        }
        if ((key === "deviceId" || key === "device_id") && typeof item === "string") {
          out[key] = "<device_id>";
          continue;
        }
        // 启动期写入的时间戳 / 当前设备元数据 / 本侧监听端口：两侧进程天然不同，归一化。
        if (
          key === "updated_at" ||
          key === "lastSeenAt" ||
          key === "createdAt" ||
          key === "updatedAt" ||
          key === "lastVerifiedAt"
        ) {
          out[key] = item === null ? null : "<runtime_written>";
          continue;
        }
        if (key === "platform") {
          out[key] = "<platform>";
          continue;
        }
        if (key === "port" && typeof item === "number" && item === ports.bind) {
          out[key] = "<bind_port>";
          continue;
        }
        out[key] = walk(item, [...keyPath, key]);
      }
      return out;
    }
    if (typeof node === "string") {
      let text = node;
      // 两侧独立生成的 UUID（如服务凭据 id）必然不同；掩码后再比较其余字段。
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) {
        return "<uuid>";
      }
      // proxy_status.bind_addr / app_meta 中的 bind JSON 都带本侧监听端口。
      text = text.replace(new RegExp(`:${ports.bind}\\b`, "g"), ":<bind_port>");
      text = text.replace(new RegExp(`:${ports.web}\\b`, "g"), ":<web_port>");
      text = text.replace(new RegExp(`"port":${ports.bind}\\b`, "g"), '"port":<bind_port>');
      return text;
    }
    return node;
  };
  return walk(value, []);
}

/** 无 SSO 的旧 oracle：token 模式 /api/session 只有 {authenticated:true}，形状归一。 */
function normalizeLegacySession(result) {
  const next = JSON.parse(JSON.stringify(result ?? null));
  if (next && typeof next === "object" && next.json && typeof next.json === "object") {
    if (next.json.authenticated === true && next.json.mode === undefined) {
      next.json = { authenticated: true, mode: "token", csrf_token: null };
    }
  }
  if (next && typeof next === "object" && "contentLength" in next) delete next.contentLength;
  return next;
}

function collectDiffs(actual, expected, base, out) {
  if (out.length >= 40) return;
  const actualType = Array.isArray(actual) ? "array" : actual === null ? "null" : typeof actual;
  const expectedType = Array.isArray(expected) ? "array" : expected === null ? "null" : typeof expected;
  if (actualType !== expectedType) {
    out.push({ path: safePathLabel(base), kind: "type", actualType, expectedType });
    return;
  }
  if (actualType === "array") {
    if (actual.length !== expected.length) {
      out.push({ path: safePathLabel(base), kind: "length", actual: actual.length, expected: expected.length });
    }
    const length = Math.min(actual.length, expected.length);
    for (let index = 0; index < length; index += 1) {
      collectDiffs(actual[index], expected[index], [...base, `[${index}]`], out);
    }
    return;
  }
  if (actualType === "object") {
    const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
    for (const key of keys) {
      if (!(key in actual)) {
        out.push({ path: safePathLabel([...base, key]), kind: "missing_in_rust" });
        continue;
      }
      if (!(key in expected)) {
        out.push({ path: safePathLabel([...base, key]), kind: "missing_in_node" });
        continue;
      }
      collectDiffs(actual[key], expected[key], [...base, key], out);
    }
    return;
  }
  if (actual !== expected) {
    out.push({ path: safePathLabel(base), kind: "value", sensitive: SENSITIVE_KEY.test(safePathLabel(base)) });
  }
}

class HttpError extends Error {
  constructor(message, response) {
    super(message);
    this.response = response;
  }
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(baseUrl + pathname, {
    method: options.method ?? "GET",
    redirect: "manual",
    headers: options.headers ?? {},
    body: options.body,
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  const headers = {};
  for (const [key, value] of response.headers.entries()) headers[key.toLowerCase()] = value;
  let json = null;
  if ((headers["content-type"] ?? "").includes("application/json") && buffer.length > 0) {
    try {
      json = JSON.parse(buffer.toString("utf8"));
    } catch {
      json = null;
    }
  }
  return { status: response.status, headers, body: buffer, json };
}

async function callCommand(side, command, args, expectError = false) {
  const response = await request(side.baseUrl, `/api/commands/${encodeURIComponent(command)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(args ?? {}),
  });
  if (!expectError && response.status !== 200) {
    const detail = response.body.length > 0 ? ` ${response.body.toString("utf8").slice(0, 300)}` : "";
    throw new HttpError(`${command} 返回 HTTP ${response.status}（${side.name}）${detail}`, response);
  }
  return response;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function prepareSideData(name, sourceDb) {
  const dir = path.join(RUN_DIR, name);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(sourceDb)) {
    throw new Error(`找不到对拍数据副本：${sourceDb}（可用 FLOWLET_PARITY_DB 指定）`);
  }
  cpSync(sourceDb, path.join(dir, "flowlet.sqlite"));
  // config.json：优先用源库同目录副本；否则用仓库内置默认配置。
  const sourceConfig = path.join(path.dirname(sourceDb), "config.json");
  if (existsSync(sourceConfig)) {
    cpSync(sourceConfig, path.join(dir, "config.json"));
  } else {
    cpSync(path.join(REPO, "config.json"), path.join(dir, "config.json"));
  }
  // 目录文件（models-cn / models.dev）：真实库副本同目录存在时一并复制，
  // 否则两侧都读不到目录，价格/规格类命令的对比会失去意义。
  const sourceCatalogs = path.join(path.dirname(sourceDb), "catalogs");
  if (existsSync(sourceCatalogs)) {
    cpSync(sourceCatalogs, path.join(dir, "catalogs"), { recursive: true });
  }
  // Rust DeviceIdentity 使用 #[serde(rename_all = "camelCase")]，磁盘文件是 camelCase；
  // Node host 读写同一格式（见 packages/flowlet-core/src/index.ts）。两侧写入同一 device_id，
  // 避免 known_devices / usage 的当前设备标识天然不同。
  const identity = {
    schemaVersion: 1,
    deviceId: PARITY_DEVICE_ID,
    createdAt: "2026-01-01T00:00:00+00:00",
    displayName: "Flowlet Host",
    platform: "linux",
  };
  writeFileSync(path.join(dir, "flowlet-device.json"), `${JSON.stringify(identity, null, 2)}\n`);
  return dir;
}

function startProcess(label, command, args, env, logFile) {
  const stream = [];
  const child = spawn(command, args, {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (chunk) => {
    stream.push(chunk.toString());
    if (stream.length > 200) stream.shift();
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  let exited = false;
  child.once("exit", (code, signal) => {
    exited = true;
    if (label === "node" && process.env.FLOWLET_PARITY_VERBOSE === "1") {
      console.error(`[node] exited code=${code} signal=${signal}`);
    }
  });
  return {
    label,
    child,
    isRunning: () => !exited,
    tail: () => stream.join("").slice(-4000),
    logFile,
  };
}

async function waitForHealth(url, processHandle, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processHandle.isRunning()) {
      throw new Error(`${processHandle.label} 进程提前退出：\n${processHandle.tail()}`);
    }
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.status === 200) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${processHandle.label} 启动超时：\n${processHandle.tail()}`);
}

function parseConfigForFilter(side) {
  // 只用于构造合法 LogsFilter 参数，不读取敏感字段。
  return { page: 1, page_size: 25, status: "all", client_id: "", channel_id: "", search: "" };
}

function buildSteps(options = {}) {
  const steps = [];
  const add = (command, args, options = {}) => steps.push({ command, args, ...options });
  const addError = (command, args) => steps.push({ command, args, expectError: true });

  add("ipc_ping", {});
  add("list_channel_presets", {});
  add("list_channel_accounts", {}, { capture: (state, response) => (state.accounts = response.json) });
  add("list_route_candidates", {}, { capture: (state, response) => (state.routes = response.json) });
  add("list_virtual_models", {});
  add("list_channel_models", {});
  add("latest_balance_snapshots", {});
  add("usage_today_tokens", {});
  add("list_request_log_clients", {});
  add("list_request_log_models", {});
  add("list_request_logs", {}, { prepare: () => ({ filter: parseConfigForFilter() }) });
  add("get_request_log_detail", { requestId: "parity-missing-request-id" });
  add("list_known_devices", {});
  add("device_daily_usage", {});
  add("device_hourly_usage", {});
  add("list_agent_sessions", { filter: { page: 1, page_size: 25 } });
  add("list_agent_session_children", { agentType: "codex-cli", parentSessionId: "parity-missing" });
  add("account_routing_scores", {});
  add("usage_summary", { groupBy: "day" });
  add("usage_summary", { groupBy: "hour" });
  add("usage_summary", {
    groupBy: "day",
    startAt: "2020-01-01T00:00:00Z",
    endAt: "2030-01-01T00:00:00Z",
  });
  add("get_log_capture_config", {}, { capture: (state, response) => (state.capture = response.json) });
  add("read_app_meta", { key: "proxy_bind_config" });
  add("read_app_meta", { key: "model_exposure_mode" });
  add("get_models_cn_catalog", {});
  add("get_models_dev_provider_catalog", { providerId: "openai" });
  add("get_models_cn_currencies", {});
  add("get_upstream_proxy_config", {});
  add("get_proxy_bind_config", {});
  add("web_connection_info", {});
  add("proxy_status", {});
  add("list_custom_scrape_channels", {});

  add("stop_proxy", {});
  add("proxy_status", {});
  add("start_proxy", {});
  add("proxy_status", {});

  add("save_virtual_models", { models: [] });
  add("save_route_candidates", {}, { prepare: (state) => ({ routes: state.routes }) });
  add("list_route_candidates", {});
  add("save_channel_accounts", {}, { prepare: (state) => ({ accounts: state.accounts }) });
  add("cleanup_old_logs", { keepDays: 3650 });
  add("save_balance_snapshot", {
    snapshot: {
      id: "parity-balance-snapshot",
      account_id: "parity-account",
      balance: 12.5,
      currency: "CNY",
      token_pack_total: null,
      token_pack_used: null,
      token_pack_remaining: null,
      token_pack_expire_at: null,
      token_packs: null,
      raw_scraped_json: null,
      source: "parity",
      synced_at: "2026-01-01T00:00:00Z",
      remark: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  });
  add("write_app_meta", { key: "model_exposure_mode", value: "selected" });
  add("read_app_meta", { key: "model_exposure_mode" });
  addError("write_app_meta", { key: "theme", value: "dark" });
  add("set_log_capture_config", {}, {
    prepare: (state) => ({ config: { ...state.capture, redact_sensitive_headers: true } }),
  });
  add("get_log_capture_config", {});
  add("set_upstream_proxy_config", { config: { enabled: true, url: "http://127.0.0.1:7890" } });
  add("get_upstream_proxy_config", {});
  add("set_upstream_proxy_config", { config: { enabled: false, url: "" } });
  add("set_proxy_bind_config", {
    config: { host: "127.0.0.1", port: 0, allow_lan: false, default_client_token: "parity-reset-token" },
  });
  add("get_proxy_bind_config", {});
  add("read_app_meta", { key: "proxy_bind_config" });

  addError("usage_summary", { groupBy: "week" });
  addError("usage_summary", { groupBy: "day", startAt: "2030-01-01T00:00:00Z", endAt: "2020-01-01T00:00:00Z" });
  addError("cleanup_old_logs", { keepDays: -1 });
  addError("definitely_not_a_command", {});

  // ── 三方服务凭据（依赖脚本内 mock GitLab；Rust oracle 不支持时整体跳过） ──
  if (options.includeCredentials && options.gitlabBaseUrl) {
    const gitlabBaseUrl = options.gitlabBaseUrl;
    add("list_credential_providers", {});
    add("list_service_credentials", {});
    add(
      "save_service_credential",
      {
        input: {
          name: "parity-gitlab",
          provider: "gitlab",
          baseUrl: gitlabBaseUrl,
          token: PARITY_GITLAB_TOKEN,
          note: "parity",
        },
        insecure: true,
      },
      {
        capture: (state, response) => {
          state.credentialId = response.json?.id;
          if (process.env.FLOWLET_PARITY_DEBUG === "1") {
            console.error(
              `[debug] save capture: status=${response.status} keys=${Object.keys(response.json ?? {}).join(",")} idLen=${String(
                state.credentialId ?? "",
              ).length}`,
            );
          }
        },
      },
    );
    add("list_service_credentials", {});
    add(
      "test_service_credential",
      {},
      { prepare: (state) => ({ id: state.credentialId, insecure: true }) },
    );
    add("export_service_credentials", {});
    addError("save_service_credential", {
      input: {
        name: "parity-gitlab",
        provider: "gitlab",
        baseUrl: gitlabBaseUrl,
        token: PARITY_GITLAB_BAD_TOKEN,
      },
      insecure: true,
    });
    add("list_service_credentials", {});
    add(
      "delete_service_credential",
      {},
      { prepare: (state) => ({ id: state.credentialId }) },
    );
    add("list_service_credentials", {});
  }

  add("ipc_ping", {});
  return steps;
}

async function runSideSteps(side, options = {}) {
  const state = {};
  const steps = buildSteps(options);
  const results = [];
  for (const step of steps) {
    const args = step.prepare ? step.prepare(state) : (step.args ?? {});
    let response;
    try {
      response = await callCommand(side, step.command, args, step.expectError);
    } catch (error) {
      if (error instanceof HttpError) {
        throw new Error(`${side.name} ${step.command}: ${error.message}`);
      }
      throw error;
    }
    results.push({ step, response, side });
    if (step.capture) step.capture(state, response);
  }
  return results;
}

/** 凭据 id 是各侧保存时随机生成的 UUID；对拍时归一化（其余字段仍严格比较）。 */
function maskCredentialIds(command, value) {
  if (!command.includes("credential")) return value;
  const clone = JSON.parse(JSON.stringify(value ?? null));
  const mask = (item) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item) && typeof item.id === "string") {
      item.id = "<credential_id>";
    }
  };
  if (Array.isArray(clone)) clone.forEach(mask);
  else mask(clone);
  return clone;
}

function compareCommandResults(rustResults, nodeResults, sides) {
  const diffs = [];
  for (let index = 0; index < Math.min(rustResults.length, nodeResults.length); index += 1) {
    const rust = rustResults[index];
    const node = nodeResults[index];
    const label = `${rust.step.command}${rust.step.expectError ? "(错误路径)" : ""}`;
    if (rust.response.status !== node.response.status) {
      diffs.push({ command: label, path: "<status>", kind: "status", actualType: rust.response.status, expectedType: node.response.status });
      continue;
    }
    try {
      const expected = normalize(maskCredentialIds(rust.step.command, rust.response.json), sides.rust);
      const actual = normalize(maskCredentialIds(node.step.command, node.response.json), sides.node);
      const commandDiffs = [];
      collectDiffs(actual, expected, [], commandDiffs);
      for (const diff of commandDiffs) diffs.push({ command: label, ...diff });
    } catch (error) {
      diffs.push({ command: label, path: "<body>", kind: "parse", note: String(error) });
    }
  }
  return diffs;
}

async function runHttpChecks(side, options = {}) {
  const checks = [];
  const add = (name, result, expectation) => checks.push({ name, result, expectation });

  const health = await request(side.baseUrl, "/health");
  add("GET /health", { status: health.status, contentType: health.headers["content-type"], json: health.json }, { status: 200, contentType: "application/json", json: { status: "ok" } });

  const sessionUnauthorized = await request(side.baseUrl, "/api/session");
  add("GET /api/session 无凭据", { status: sessionUnauthorized.status, json: sessionUnauthorized.json, cache: sessionUnauthorized.headers["cache-control"] ?? null }, { status: 401, json: { code: "unauthorized", message: "管理凭据无效，请重新登录" }, cache: null });

  const session = await request(side.baseUrl, "/api/session", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  add("GET /api/session 鉴权", { status: session.status, json: session.json, cache: session.headers["cache-control"] ?? null }, { status: 200, json: { authenticated: true }, cache: "no-store" });

  const root = await request(side.baseUrl, "/");
  add("GET /", { status: root.status, contentType: root.headers["content-type"], hash: createHash("sha256").update(root.body).digest("hex") }, { status: 200, contentType: "text/html" });

  const spa = await request(side.baseUrl, "/models");
  add("GET /models（SPA fallback）", { status: spa.status, contentType: spa.headers["content-type"], hash: createHash("sha256").update(spa.body).digest("hex") }, { status: 404, contentType: "text/html", hash: createHash("sha256").update(root.body).digest("hex") });

  const assetsDir = path.join(STATIC_DIR, "assets");
  const assetFiles = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
  const jsFile = assetFiles.find((file) => file.endsWith(".js"));
  const cssFile = assetFiles.find((file) => file.endsWith(".css"));
  if (jsFile) {
    const asset = await request(side.baseUrl, `/assets/${jsFile}`);
    add("GET assets/*.js", { status: asset.status, contentType: asset.headers["content-type"] }, { status: 200, contentType: "text/javascript" });
  }
  if (cssFile) {
    const asset = await request(side.baseUrl, `/assets/${cssFile}`);
    add("GET assets/*.css", { status: asset.status, contentType: asset.headers["content-type"] }, { status: 200, contentType: "text/css" });
  }

  const unknownApi = await request(side.baseUrl, "/api/unknown");
  add("GET /api/unknown", { status: unknownApi.status, length: unknownApi.body.length }, { status: 404, length: 0 });

  const putApi = await request(side.baseUrl, "/api/unknown", { method: "PUT" });
  add("PUT /api/unknown", { status: putApi.status, allow: putApi.headers.allow ?? null }, { status: 405, allow: "GET,HEAD,POST" });

  const getCommand = await request(side.baseUrl, "/api/commands/ipc_ping", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  add("GET /api/commands/ipc_ping", { status: getCommand.status, allow: getCommand.headers.allow ?? null, cache: getCommand.headers["cache-control"] ?? null }, { status: 405, allow: "POST", cache: "no-store" });

  const noContentType = await request(side.baseUrl, "/api/commands/ipc_ping", {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    body: "{}",
  });
  add("POST 命令缺少 Content-Type", { status: noContentType.status, contentType: noContentType.headers["content-type"], cache: noContentType.headers["cache-control"] ?? null }, { status: 415, contentType: "text/plain; charset=utf-8", cache: "no-store" });

  const malformed = await request(side.baseUrl, "/api/commands/ipc_ping", {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: "not-json",
  });
  add("POST 非法 JSON", { status: malformed.status, contentType: malformed.headers["content-type"], cache: malformed.headers["cache-control"] ?? null }, { status: 400, contentType: "text/plain; charset=utf-8", cache: "no-store" });

  // ── 管理端鉴权（SSO / token 模式）─────────────────────────────────────────
  // oracle 二进制若尚未包含 SSO（/api/auth/config 404），这些检查会整体跳过，
  // 并在 main() 里打印明确警告（Node 侧已按合并后的 Rust auth.rs 实现）。
  if (options.includeSso) {
  const authConfig = await request(side.baseUrl, "/api/auth/config");
  add("GET /api/auth/config", { status: authConfig.status, json: authConfig.json, cache: authConfig.headers["cache-control"] ?? null }, { status: 200 });

  const authConfigHead = await request(side.baseUrl, "/api/auth/config", { method: "HEAD" });
  add("HEAD /api/auth/config", { status: authConfigHead.status, cache: authConfigHead.headers["cache-control"] ?? null }, { status: 200 });

  const authLogin = await request(side.baseUrl, "/api/auth/login");
  add("GET /api/auth/login（token 模式）", { status: authLogin.status, json: authLogin.json, location: authLogin.headers.location ?? null }, { status: 404 });

  const authCallback = await request(side.baseUrl, "/api/auth/callback?code=x&state=y");
  add("GET /api/auth/callback（无会话）", { status: authCallback.status, location: authCallback.headers.location ?? null, setCookie: Boolean(authCallback.headers["set-cookie"]) }, { status: 303 });

  const logoutNoAuth = await request(side.baseUrl, "/api/auth/logout", { method: "POST" });
  add("POST /api/auth/logout 无凭据", { status: logoutNoAuth.status, json: logoutNoAuth.json }, { status: 401 });

  const logoutToken = await request(side.baseUrl, "/api/auth/logout", { method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  add("POST /api/auth/logout 带 token", { status: logoutToken.status, json: logoutToken.json, cache: logoutToken.headers["cache-control"] ?? null }, { status: 200 });

  const sessionWithMode = await request(side.baseUrl, "/api/session", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  add("GET /api/session 鉴权（含 mode）", { status: sessionWithMode.status, json: sessionWithMode.json }, { status: 200 });
  }

  const head = await request(side.baseUrl, "/index.html", { method: "HEAD" });
  add("HEAD /index.html", { status: head.status, contentType: head.headers["content-type"], contentLength: head.headers["content-length"] }, { status: 200, contentType: "text/html" });

  const postStatic = await request(side.baseUrl, "/index.html", { method: "POST" });
  add("POST /index.html", { status: postStatic.status, allow: postStatic.headers.allow ?? null }, { status: 405, allow: "GET,HEAD" });

  const healthPost = await request(side.baseUrl, "/health", { method: "POST" });
  add("POST /health", { status: healthPost.status, allow: healthPost.headers.allow ?? null }, { status: 405, allow: "GET,HEAD" });

  const headHealth = await request(side.baseUrl, "/health", { method: "HEAD" });
  add("HEAD /health", { status: headHealth.status, contentType: headHealth.headers["content-type"], contentLength: headHealth.headers["content-length"] }, { status: 200, contentType: "application/json" });

  const headSession = await request(side.baseUrl, "/api/session", { method: "HEAD", headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  add("HEAD /api/session", { status: headSession.status, cache: headSession.headers["cache-control"] ?? null, contentLength: headSession.headers["content-length"] }, { status: 200, cache: "no-store" });

  const postSession = await request(side.baseUrl, "/api/session", { method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  add("POST /api/session", { status: postSession.status, allow: postSession.headers.allow ?? null, cache: postSession.headers["cache-control"] ?? null }, { status: 405, allow: "GET,HEAD", cache: "no-store" });

  const commandsBare = await request(side.baseUrl, "/api/commands");
  add("GET /api/commands", { status: commandsBare.status, length: commandsBare.body.length }, { status: 404, length: 0 });

  const commandsEmpty = await request(side.baseUrl, "/api/commands/", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  add("GET /api/commands/", { status: commandsEmpty.status, length: commandsEmpty.body.length }, { status: 404, length: 0 });

  const commandsNested = await request(side.baseUrl, "/api/commands/ipc_ping/extra", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  add("GET /api/commands/x/y", { status: commandsNested.status, length: commandsNested.body.length }, { status: 404, length: 0 });

  const dirNoSlash = await request(side.baseUrl, "/assets");
  add("GET /assets（无尾斜杠）", { status: dirNoSlash.status, location: dirNoSlash.headers.location ?? null }, { status: 307 });

  const customJson = await request(side.baseUrl, "/api/commands/ipc_ping", {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/vnd.flowlet+json" },
    body: "{}",
  });
  add("POST 命令 +json Content-Type", { status: customJson.status, json: customJson.json }, { status: 200 });

  const oversized = await request(side.baseUrl, "/api/commands/ipc_ping", {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: "x".repeat(4 * 1024 * 1024 + 16),
  });
  add("POST 命令超过 4 MiB", { status: oversized.status, contentType: oversized.headers["content-type"], cache: oversized.headers["cache-control"] ?? null, length: oversized.body.length }, { status: 413 });

  return checks;
}

// ─── Mock GitLab CE 10.8.7（服务凭据对拍） ──────────────────────────────────

class MockGitlab {
  server = null;
  baseUrl = "";
  subpath = "/gitlab";

  async start() {
    this.server = createHttpServer((request, response) => {
      void this.#handle(request, response);
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        this.baseUrl = `http://127.0.0.1:${port}${this.subpath}`;
        resolve();
      });
    });
  }

  async close() {
    await new Promise((resolve) => this.server?.close(() => resolve()));
  }

  async #handle(request, response) {
    const url = new URL(request.url ?? "/", "http://localhost");
    const token = request.headers["private-token"];
    const send = (status, value) => {
      const body = Buffer.from(JSON.stringify(value), "utf8");
      response.writeHead(status, { "content-type": "application/json", "content-length": String(body.length) });
      response.end(body);
    };
    const suffix = url.pathname.startsWith(this.subpath)
      ? url.pathname.slice(this.subpath.length)
      : url.pathname;
    if (suffix === "/api/v4/user") {
      if (token !== PARITY_GITLAB_TOKEN) return send(401, { message: "401 Unauthorized" });
      return send(200, { id: 1, username: "parity-user", name: "Parity User" });
    }
    if (suffix === "/api/v4/version") {
      if (token !== PARITY_GITLAB_TOKEN) return send(401, { message: "401 Unauthorized" });
      return send(200, { version: "10.8.7" });
    }
    send(404, { message: "404 Not Found" });
  }
}

async function main() {
  if (!existsSync(STATIC_DIR)) throw new Error(`找不到静态界面目录：${STATIC_DIR}`);
  if (!existsSync(RUST_HEADLESS)) throw new Error(`找不到 Rust headless 二进制：${RUST_HEADLESS}（可用 FLOWLET_RUST_HEADLESS 指定）`);
  if (!existsSync(NODE_ENTRY)) throw new Error(`找不到 Node host 入口：${NODE_ENTRY}`);
  mkdirSync(RUN_DIR, { recursive: true });
  console.log(`对拍工作目录：${RUN_DIR}`);

  const rustDir = prepareSideData("rust", SOURCE_DB);
  const nodeDir = prepareSideData("node", SOURCE_DB);

  // mock GitLab：服务凭据命令需要真实 HTTP 上游（10.8.7 语义）。
  const gitlab = new MockGitlab();
  await gitlab.start();

  const rustPorts = { web: await freePort(), bind: await freePort() };
  const nodePorts = { web: await freePort(), bind: await freePort() };
  const sides = {
    rust: { name: "rust", ports: rustPorts, baseUrl: `http://127.0.0.1:${rustPorts.web}` },
    node: { name: "node", ports: nodePorts, baseUrl: `http://127.0.0.1:${nodePorts.web}` },
  };

  const commonEnv = (dir, ports) => ({
    FLOWLET_ADMIN_TOKEN: ADMIN_TOKEN,
    FLOWLET_CLIENT_TOKEN: CLIENT_TOKEN,
    FLOWLET_DB_PATH: path.join(dir, "flowlet.sqlite"),
    FLOWLET_CONFIG_PATH: path.join(dir, "config.json"),
    FLOWLET_CATALOG_DIR: dir,
    FLOWLET_STATIC_DIR: STATIC_DIR,
    FLOWLET_WEB_ADDR: `127.0.0.1:${ports.web}`,
    FLOWLET_BIND_ADDR: `127.0.0.1:${ports.bind}`,
    FLOWLET_PUBLIC_PROXY_URL: PUBLIC_PROXY_URL,
  });

  const rustProcess = startProcess(
    "rust",
    RUST_HEADLESS,
    [],
    { ...commonEnv(rustDir, rustPorts), RUST_LOG: "warn" },
    path.join(RUN_DIR, "rust.log"),
  );
  const nodeProcess = startProcess(
    "node",
    process.execPath,
    [NODE_ENTRY],
    commonEnv(nodeDir, nodePorts),
    path.join(RUN_DIR, "node.log"),
  );

  let diffs = [];
  let httpDiffs = [];
  let oracleHasSso = null;
  let oracleHasCredentials = null;
  let rustResults = [];
  let nodeResults = [];
  try {
    await Promise.all([
      waitForHealth(sides.rust.baseUrl, rustProcess),
      waitForHealth(sides.node.baseUrl, nodeProcess),
    ]);
    console.log("两侧均已启动，开始逐命令对拍…");

    // oracle 能力探测：合并 SSO 前的旧 Rust 二进制没有 /api/auth/config。
    const ssoProbe = await request(sides.rust.baseUrl, "/api/auth/config");
    oracleHasSso = ssoProbe.status !== 404;
    if (!oracleHasSso) {
      console.warn(
        "[warn] Rust oracle 未包含 SSO 路由（/api/auth/config → 404）；\n" +
          "       跳过 SSO HTTP 检查，并把旧 token 模式 /api/session 形状归一化。\n" +
          "       Node 侧 SSO 行为已按合并后的 src-tauri/src/core/web/auth.rs 实现，\n" +
          "       如需严格对拍请用 SSO 版本 Rust headless（FLOWLET_RUST_HEADLESS=...）。",
      );
    }

    // oracle 能力探测：旧 Rust 二进制没有服务凭据白名单命令（→ 501）。
    const credentialProbe = await request(sides.rust.baseUrl, "/api/commands/list_credential_providers", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    oracleHasCredentials = credentialProbe.status === 200;
    if (!oracleHasCredentials) {
      console.warn(
        "[warn] Rust oracle 未包含服务凭据命令（list_credential_providers → " +
          credentialProbe.status +
          "）；跳过凭据命令对拍。" +
          "如需覆盖请用包含 credentials 的 Rust headless（FLOWLET_RUST_HEADLESS=...）。",
      );
    }
    const stepOptions = {
      includeCredentials: oracleHasCredentials,
      gitlabBaseUrl: gitlab.baseUrl,
    };

    rustResults = await runSideSteps({ ...sides.rust }, stepOptions);
    nodeResults = await runSideSteps({ ...sides.node }, stepOptions);
    diffs = compareCommandResults(rustResults, nodeResults, sides);

    const rustChecks = await runHttpChecks(sides.rust, { includeSso: oracleHasSso });
    const nodeChecks = await runHttpChecks(sides.node, { includeSso: oracleHasSso });
    for (let index = 0; index < Math.min(rustChecks.length, nodeChecks.length); index += 1) {
      const rust = rustChecks[index];
      const node = nodeChecks[index];
      const legacySession = !oracleHasSso && rust.name.includes("/api/session");
      const rustResult = legacySession ? normalizeLegacySession(rust.result) : rust.result;
      const nodeResult = legacySession ? normalizeLegacySession(node.result) : node.result;
      const checks = [];
      collectDiffs(nodeResult, rustResult, [], checks);
      if (process.env.FLOWLET_PARITY_DEBUG === "1" && checks.length > 0) {
        console.error(`[debug] ${rust.name}\n  rust=${JSON.stringify(rust.result)}\n  node=${JSON.stringify(node.result)}`);
      }
      for (const diff of checks) httpDiffs.push({ check: rust.name, ...diff });
    }
  } finally {
    for (const processHandle of [rustProcess, nodeProcess]) {
      if (processHandle.isRunning()) {
        processHandle.child.kill("SIGTERM");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    for (const processHandle of [rustProcess, nodeProcess]) {
      if (processHandle.isRunning()) processHandle.child.kill("SIGKILL");
    }
    await gitlab.close();
    if (process.env.FLOWLET_PARITY_KEEP !== "1") {
      try {
        rmSync(path.join(RUN_DIR, "rust", "flowlet.sqlite-wal"), { force: true });
        rmSync(path.join(RUN_DIR, "node", "flowlet.sqlite-wal"), { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  const printDiffs = (title, list) => {
    console.log(`\n${title}：${list.length} 处差异`);
    for (const diff of list.slice(0, 40)) {
      const location = diff.command ?? diff.check;
      const sensitive = diff.sensitive ? "（敏感字段，值已隐藏）" : "";
      if (diff.kind === "value") {
        console.log(`  - ${location} → ${diff.path}${sensitive}`);
      } else if (diff.kind === "length") {
        console.log(`  - ${location} → ${diff.path} 长度 rust=${diff.actual} node=${diff.expected}`);
      } else if (diff.kind === "status") {
        console.log(`  - ${location} → HTTP 状态 rust=${diff.actualType} node=${diff.expectedType}`);
      } else {
        console.log(`  - ${location} → ${diff.path} [${diff.kind}]${diff.note ? ` note=${diff.note}` : ""}`);
      }
    }
  };

  console.log(`\n命令序列：${rustResults.length} 步；HTTP 检查：${httpDiffs.length >= 0 ? "已完成" : ""}`);
  console.log(`跳过的网络命令：${SKIPPED_COMMANDS.join("、")}`);
  printDiffs("命令返回差异", diffs);
  printDiffs("HTTP 层差异", httpDiffs);

  const total = diffs.length + httpDiffs.length;
  if (typeof oracleHasSso === "boolean") {
    console.log(`Rust oracle SSO 能力：${oracleHasSso ? "有（严格对拍）" : "无（SSO 检查已跳过）"}`);
  }
  if (typeof oracleHasCredentials === "boolean") {
    console.log(
      `Rust oracle 服务凭据能力：${oracleHasCredentials ? "有（含 mock GitLab 对拍）" : "无（凭据命令已跳过）"}`,
    );
  }
  console.log(`\n结论：命令差异 ${diffs.length}，HTTP 差异 ${httpDiffs.length}，合计 ${total}`);
  console.log(`日志：${path.join(RUN_DIR, "rust.log")} / ${path.join(RUN_DIR, "node.log")}`);
  if (total > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("对拍失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
