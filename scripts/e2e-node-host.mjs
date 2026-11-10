#!/usr/bin/env node
// 端到端冒烟：Node Host（Web 管理端 + 模型入口）在真实库副本上跑起来。
//
// 覆盖：/health、管理命令、静态资源、未知命令 501、/v1/models、
// 以及通过 mock 上游验证 OpenAI / Anthropic 两种流式透传是否读到终止标记，
// 最后检查 request_logs / usage_records 是否落库。
//
// 用法：node scripts/e2e-node-host.mjs
// 退出码：0 = 全部关键项通过；1 = 有失败项（打印失败清单）。
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEV_DATA = process.env.FLOWLET_DEV_DATA ?? path.join(ROOT, ".flowlet-dev-data", "e2e");
const FIXTURE =
  process.env.FLOWLET_FIXTURE_DB ??
  "/home/nichangen/.local/state/flowlet-docker-migration-20261109/flowlet.sqlite";
const ADMIN = "e2e-admin-token-0123456789abcdef";
const CLIENT = "e2e-client-token-0123456789abcdef";
const WEB_PORT = 18080 + Math.floor(Math.random() * 200);
const BIND_PORT = 19640 + Math.floor(Math.random() * 200);

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ─── mock 上游 ───────────────────────────────────────────────────────────────
function startMockUpstream() {
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
      return;
    }
    if (url.includes("/messages")) {
      // Anthropic SSE
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const events = [
        { type: "message_start", message: { id: "msg_mock", type: "message", role: "assistant", model: "mock", content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
        { type: "message_stop" },
      ];
      for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      res.end();
      return;
    }
    // OpenAI chat completions (stream 优先)
    const body = [];
    req.on("data", (c) => body.push(c));
    req.on("end", () => {
      let stream = false;
      try {
        stream = JSON.parse(Buffer.concat(body).toString("utf8")).stream === true;
      } catch {}
      if (!stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion",
            model: "mock",
            choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const chunk of ["你", "好", "！"]) {
        res.write(`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", model: "mock", choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

// ─── 数据准备：复制副本 + 把第一条可用账号指向 mock ──────────────────────────
function resetDataDir() {
  rmSync(DEV_DATA, { recursive: true, force: true });
  mkdirSync(path.join(DEV_DATA, "catalogs"), { recursive: true });
  cpSync(FIXTURE, path.join(DEV_DATA, "flowlet.sqlite"));
}

/** 首次启动一次 host：让 storage 跑完幂等迁移（补列/建索引），再改测试数据。 */
async function migrateFixtureOnce() {
  const { child, logs } = startHost();
  const healthy = await waitHealthy(logs);
  child.kill("SIGTERM");
  await sleep(400);
  if (!healthy) {
    console.error("首次迁移启动失败：\n" + logs.join(""));
    throw new Error("fixture 迁移失败");
  }
}

function prepareDatabase(mockBaseUrl) {
  const db = new DatabaseSync(path.join(DEV_DATA, "flowlet.sqlite"));
  const account = db
    .prepare("select id, channel_id from channel_accounts where coalesce(api_key,'') <> '' and enabled = 1 limit 1")
    .get();
  if (!account) throw new Error("fixture 中没有可用账号");
  db.prepare(
    "update channel_accounts set base_url_override = ?, anthropic_base_url_override = ?, api_key = 'sk-e2e-mock', use_upstream_proxy = 0 where id = ?",
  ).run(mockBaseUrl, mockBaseUrl, account.id);
  const route = db
    .prepare("select virtual_model_id, client_protocol from virtual_model_routes where account_id = ? and enabled = 1 limit 1")
    .get(account.id);
  if (!route) throw new Error("fixture 中没有该账号的可用路由");
  db.close();
  return { accountId: account.id, model: route.virtual_model_id, protocol: route.client_protocol };
}

// ─── 启动 Node Host ─────────────────────────────────────────────────────────
function startHost() {
  const child = spawn(process.execPath, [path.join(ROOT, "packages/flowlet-core/src/index.ts")], {
    cwd: ROOT,
    env: {
      ...process.env,
      FLOWLET_ADMIN_TOKEN: ADMIN,
      FLOWLET_CLIENT_TOKEN: CLIENT,
      FLOWLET_DB_PATH: path.join(DEV_DATA, "flowlet.sqlite"),
      FLOWLET_CONFIG_PATH: path.join(DEV_DATA, "config.json"),
      FLOWLET_CATALOG_DIR: path.join(DEV_DATA, "catalogs"),
      FLOWLET_STATIC_DIR: path.join(ROOT, "dist-web"),
      FLOWLET_WEB_ADDR: `127.0.0.1:${WEB_PORT}`,
      FLOWLET_BIND_ADDR: `127.0.0.1:${BIND_PORT}`,
      FLOWLET_DISABLE_BACKGROUND_TASKS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (d) => logs.push(d.toString()));
  child.stderr.on("data", (d) => logs.push(d.toString()));
  return { child, logs };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(logs) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${WEB_PORT}/health`);
      if (res.ok) return true;
    } catch {}
    if (logs.join("").includes("启动失败")) return false;
    await sleep(250);
  }
  return false;
}

async function admin(command, args = {}) {
  const res = await fetch(`http://127.0.0.1:${WEB_PORT}/api/commands/${command}`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function modelCall(pathname, payload, { stream = true } = {}) {
  const res = await fetch(`http://127.0.0.1:${BIND_PORT}${pathname}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CLIENT}`,
      "x-api-key": CLIENT,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, text };
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────
const mock = await startMockUpstream();
const mockBase = `http://127.0.0.1:${mock.port}`;
resetDataDir();
await migrateFixtureOnce();
const route = prepareDatabase(mockBase);
const { child, logs } = startHost();
let ok = true;
try {
  const healthy = await waitHealthy(logs);
  check("GET /health 200", healthy);
  if (!healthy) {
    console.error("host 日志：\n" + logs.join(""));
  }

  // 鉴权
  const unauth = await fetch(`http://127.0.0.1:${WEB_PORT}/api/session`);
  check("未鉴权 /api/session 401", unauth.status === 401, `status=${unauth.status}`);
  const session = await fetch(`http://127.0.0.1:${WEB_PORT}/api/session`, { headers: { authorization: `Bearer ${ADMIN}` } });
  check("鉴权 /api/session 200", session.status === 200, `status=${session.status}`);

  // 管理命令
  const commands = [
    ["ipc_ping", {}],
    ["list_channel_presets", {}],
    ["list_channel_accounts", {}],
    ["list_route_candidates", {}],
    ["list_virtual_models", {}],
    ["list_channel_models", {}],
    ["proxy_status", {}],
    ["get_proxy_bind_config", {}],
    ["get_log_capture_config", {}],
    ["get_upstream_proxy_config", {}],
    ["usage_today_tokens", {}],
    ["latest_balance_snapshots", {}],
    ["read_app_meta", { key: "schema_version" }],
    ["get_models_cn_catalog", {}],
  ];
  let commandOk = 0;
  for (const [name, args] of commands) {
    const { status } = await admin(name, args);
    if (status === 200) commandOk += 1;
    else console.log(`  命令 ${name} -> ${status}`);
  }
  check(`管理命令 ${commands.length} 条返回 200`, commandOk === commands.length, `${commandOk}/${commands.length}`);
  const unknown = await admin("not_a_real_command");
  check("未知命令 501", unknown.status === 501, `status=${unknown.status}`);

  // 静态资源
  const index = await fetch(`http://127.0.0.1:${WEB_PORT}/`);
  const indexText = await index.text();
  check("GET / 返回 SPA", index.status === 200 && indexText.includes("<div id=\"root\""), `status=${index.status}`);
  const api404 = await fetch(`http://127.0.0.1:${WEB_PORT}/api/nope`);
  check("未知 /api/* 404", api404.status === 404, `status=${api404.status}`);

  // 模型入口
  const modelsRes = await fetch(`http://127.0.0.1:${BIND_PORT}/v1/models`, { headers: { authorization: `Bearer ${CLIENT}` } });
  check("/v1/models 200", modelsRes.status === 200, `status=${modelsRes.status}`);

  const openai = await modelCall("/v1/chat/completions", {
    model: route.model,
    messages: [{ role: "user", content: "你好" }],
    stream: true,
  });
  check("OpenAI 流式读到 data: [DONE]", openai.status === 200 && openai.text.includes("data: [DONE]"), `status=${openai.status}`);

  const anthropic = await modelCall("/anthropic/v1/messages", {
    model: route.model,
    max_tokens: 16,
    messages: [{ role: "user", content: "你好" }],
    stream: true,
  });
  check("Anthropic 流式读到 message_stop", anthropic.status === 200 && anthropic.text.includes("message_stop"), `status=${anthropic.status}`);

  // 落库
  await sleep(500);
  const db = new DatabaseSync(path.join(DEV_DATA, "flowlet.sqlite"));
  const logsCount = db.prepare("select count(*) n from request_logs").get().n;
  const usageCount = db.prepare("select count(*) n from usage_records").get().n;
  db.close();
  check("request_logs 已落库", logsCount > 0, `rows=${logsCount}`);
  check("usage_records 已落库", usageCount > 0, `rows=${usageCount}`);

  ok = results.every((r) => r.ok);
} catch (error) {
  console.error("e2e 异常：", error);
  ok = false;
} finally {
  child.kill("SIGTERM");
  mock.server.close();
  await sleep(300);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n===== e2e 结果：${results.length - failed.length}/${results.length} 通过 =====`);
if (failed.length > 0) {
  console.log("失败项：\n" + failed.map((r) => ` - ${r.name} ${r.detail}`).join("\n"));
  console.log("\nhost 日志（末尾）：\n" + logs.join("").split("\n").slice(-40).join("\n"));
}
process.exit(ok ? 0 : 1);
