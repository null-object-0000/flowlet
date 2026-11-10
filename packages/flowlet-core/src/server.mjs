// Flowlet migration PoC — Node command host.
//
// Reimplements the contract served by src-tauri/src/core/web/ (Rust axum
// router) on top of the existing dist-web frontend, so an Electron window can
// load the unchanged Web UI. All SQLite access is READ-ONLY against a copied
// database; the user's real database is never opened.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const DIST_WEB = path.resolve(process.env.FLOWLET_DIST_WEB ?? path.join(REPO_ROOT, "dist-web"));
const DATA_DIR = path.join(HERE, "data");
const DB_PATH = process.env.FLOWLET_DB_PATH ?? path.join(DATA_DIR, "flowlet.sqlite");
const HOST = process.env.FLOWLET_WEB_HOST ?? "127.0.0.1";
const PORT = Number(process.env.FLOWLET_WEB_PORT ?? 18787);
// Same >=24-char rule as src-tauri/src/bin/headless.rs.
const ADMIN_TOKEN = process.env.FLOWLET_ADMIN_TOKEN ?? "flowlet-poc-admin-token-0123456789";
const PUBLIC_PROXY_URL = process.env.FLOWLET_PUBLIC_PROXY_URL ?? "";
const CONFIG_PATH = process.env.FLOWLET_CONFIG_PATH ?? path.join(REPO_ROOT, "config.json");
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".map": "application/json; charset=utf-8",
};

// ─── Read-only SQLite ────────────────────────────────────────────────────────

if (!existsSync(DB_PATH)) {
  console.error(`找不到数据库副本：${DB_PATH}\n请先把真实库复制到 poc/electron-host/data/（见 README）。`);
  process.exit(1);
}
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const dbColumns = (table) =>
  new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
const accountColumns = dbColumns("channel_accounts");
const has = (columns, name) => columns.has(name);
const rows = (sql, params = []) => db.prepare(sql).all(...params).map((row) => ({ ...row }));
const one = (sql, params = []) => ({ ...db.prepare(sql).get(...params) });

// ─── JSON mapping: serde-compatible field shapes ─────────────────────────────

const bool = (value) => value !== 0 && value !== null && value !== undefined;
const parseJson = (raw, fallback) => {
  if (typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

function mapPreset(row) {
  return {
    id: row.id,
    name: row.name,
    vendor: row.vendor,
    // serde renames ProtocolType to lowercase strings.
    supported_protocols: parseJson(row.supported_protocols, []),
    openai_base_url: row.openai_base_url,
    anthropic_base_url: row.anthropic_base_url,
    openai_auth: row.openai_auth === "x_api_key" ? "x_api_key" : "bearer",
    anthropic_auth: row.anthropic_auth === "x_api_key" ? "x_api_key" : "bearer",
    default_model: row.default_model,
    small_model: row.small_model ?? null,
    timeout_seconds: row.timeout_seconds ?? null,
    supports_model_list: bool(row.supports_model_list),
    supports_model_detail: bool(row.supports_model_detail),
    supports_balance_query: bool(row.supports_balance_query),
    supports_quota_query: bool(row.supports_quota_query),
    supports_usage_query: bool(row.supports_usage_query),
    supports_scrape_balance: bool(row.supports_scrape_balance),
    supports_files_api: bool(row.supports_files_api),
    platform_url: row.platform_url ?? null,
    enabled: bool(row.enabled),
    created_at: row.created_at ?? "",
    updated_at: row.updated_at ?? "",
  };
}

function listPresets() {
  return rows(
    `SELECT id, name, vendor, supported_protocols, openai_base_url, anthropic_base_url,
            openai_auth, anthropic_auth, default_model, small_model, timeout_seconds,
            supports_model_list, supports_model_detail, supports_balance_query,
            supports_quota_query, supports_usage_query, supports_scrape_balance,
            supports_files_api, platform_url, enabled, created_at, updated_at
     FROM channel_presets ORDER BY id ASC`,
  ).map(mapPreset);
}

function mapAccount(row) {
  return {
    id: row.id,
    workspace_account_id: row.workspace_account_id ?? null,
    channel_id: row.channel_id,
    name: row.name,
    api_key: row.api_key,
    management_key: row.management_key ?? null,
    enabled: bool(row.enabled),
    priority: row.priority,
    remark: row.remark ?? null,
    resource_mode: row.resource_mode ?? null,
    resource_sync_mode: row.resource_sync_mode ?? "manual",
    base_url_override: row.base_url_override ?? null,
    // Proxy is not started by this PoC host; inactive proxy => false, matching
    // runtime_config.rs's "None => Some(proxy_active && adapter policy)".
    use_upstream_proxy: has(accountColumns, "use_upstream_proxy") ? row.use_upstream_proxy ?? false : false,
    anthropic_base_url_override: row.anthropic_base_url_override ?? null,
    workspace_default_base_url: row.workspace_default_base_url ?? null,
    workspace_default_anthropic_base_url: row.workspace_default_anthropic_base_url ?? null,
    last_used_at: row.last_used_at ?? null,
    last_error: row.last_error ?? null,
    credential_status: row.credential_status ?? "healthy",
    synced_models: parseJson(row.synced_models, null),
    models_synced_at: row.models_synced_at ?? null,
    exposed_models: parseJson(row.exposed_models, null),
    created_at: row.created_at ?? "",
    updated_at: row.updated_at ?? "",
  };
}

function listAccounts() {
  const accounts = rows(
    `SELECT ca.id, links.workspace_account_id, ca.channel_id, ca.name, ca.api_key,
            ca.management_key, ca.enabled, ca.priority, ca.remark, ca.resource_mode,
            ca.resource_sync_mode, ca.base_url_override, ca.anthropic_base_url_override,
            defaults.openai_base_url AS workspace_default_base_url,
            defaults.anthropic_base_url AS workspace_default_anthropic_base_url,
            ca.last_used_at, ca.last_error, ca.credential_status, ca.synced_models,
            ca.models_synced_at, ca.exposed_models, ca.created_at, ca.updated_at
     FROM channel_accounts ca
     LEFT JOIN channel_account_workspace_links links ON links.local_account_id = ca.id
     LEFT JOIN channel_account_workspace_defaults defaults
            ON defaults.workspace_account_id = links.workspace_account_id
     ORDER BY ca.channel_id ASC, ca.priority ASC, ca.id ASC`,
  );
  // Same migration filter as services.rs load_runtime_snapshot().
  return accounts
    .filter((row) => !(row.id === "account-default" && String(row.api_key ?? "").trim() === ""))
    .map(mapAccount);
}

function listRoutes(accounts, presets) {
  const protocol = (raw) => (raw === "anthropic" || raw === "responses" ? raw : "openai");
  return rows(
    `SELECT id, virtual_model_id, channel_id, account_id, upstream_model, client_protocol,
            priority, enabled, created_at, updated_at
     FROM virtual_model_routes
     ORDER BY virtual_model_id ASC, priority ASC, id ASC`,
  )
    .filter((route) => route.id !== "route-auto-default" && route.account_id !== "account-default")
    .filter((route) => {
      if (!bool(route.enabled)) return true; // disabled rows are kept as-is
      const account = accounts.find((item) => item.id === route.account_id);
      return (
        String(route.upstream_model ?? "").trim() !== "" &&
        presets.some((preset) => preset.id === route.channel_id) &&
        Boolean(account) &&
        account.channel_id === route.channel_id &&
        account.enabled &&
        account.api_key.trim() !== ""
      );
    })
    .map((route) => ({
      id: route.id,
      virtual_model_id: route.virtual_model_id,
      channel_id: route.channel_id,
      account_id: route.account_id,
      upstream_model: route.upstream_model,
      client_protocol: protocol(route.client_protocol),
      priority: route.priority,
      enabled: bool(route.enabled),
      created_at: route.created_at ?? "",
      updated_at: route.updated_at ?? "",
    }));
}

function listVirtualModels() {
  const protocol = (raw) => (raw === "anthropic" || raw === "responses" ? raw : "openai");
  return rows(
    `SELECT id, name, protocol_type, routing_strategy, enabled, created_at, updated_at
     FROM virtual_models ORDER BY id ASC`,
  ).map((row) => ({
    id: row.id,
    name: row.name,
    protocol_type: protocol(row.protocol_type),
    routing_strategy: row.routing_strategy,
    enabled: bool(row.enabled),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

function latestBalanceSnapshots() {
  return rows(
    `SELECT s.id, s.account_id, s.balance, s.currency, s.token_pack_total, s.token_pack_used,
            s.token_pack_remaining, s.token_pack_expire_at, s.token_packs, s.raw_scraped_json,
            s.source, s.synced_at, s.remark, s.created_at, s.updated_at
     FROM account_balance_snapshots s
     INNER JOIN (
         SELECT account_id, MAX(created_at) AS max_created
         FROM account_balance_snapshots GROUP BY account_id
     ) latest ON s.account_id = latest.account_id AND s.created_at = latest.max_created
     ORDER BY s.account_id ASC`,
  );
}

// Ported 1:1 from storage_usage.rs usage_today_summary () — same three sources
// (proxy usage, native agent events, synced device daily snapshots), one row.
const USAGE_TODAY_SQL = `
WITH today_sources (
    total_tokens, input_tokens, input_cached_tokens, input_uncached_tokens,
    cache_measured_input_tokens, output_tokens
) AS (
    SELECT
        coalesce(sum(ur.total_tokens), 0), coalesce(sum(ur.input_tokens), 0),
        coalesce(sum(ur.input_cached_tokens), 0), coalesce(sum(ur.input_uncached_tokens), 0),
        coalesce(sum(CASE WHEN ur.input_cached_tokens IS NOT NULL THEN ur.input_tokens ELSE 0 END), 0),
        coalesce(sum(ur.output_tokens), 0)
    FROM usage_records ur
    LEFT JOIN request_logs rl ON rl.request_id = ur.request_id AND rl.is_last_attempt = 1
    WHERE strftime('%Y-%m-%d', coalesce(rl.created_at, ur.created_at), 'localtime') = date('now', 'localtime')
    UNION ALL
    SELECT
        coalesce(sum(a.total_tokens), 0),
        coalesce(sum(CASE WHEN a.agent_type IN ('codex-desktop', 'codex-cli')
            THEN max(a.input_tokens - a.cached_input_tokens - a.cache_write_input_tokens, 0)
            ELSE a.input_tokens END), 0)
            + coalesce(sum(a.cached_input_tokens), 0) + coalesce(sum(a.cache_write_input_tokens), 0),
        coalesce(sum(a.cached_input_tokens), 0),
        coalesce(sum(CASE WHEN a.agent_type IN ('codex-desktop', 'codex-cli')
            THEN max(a.input_tokens - a.cached_input_tokens - a.cache_write_input_tokens, 0)
            ELSE a.input_tokens END), 0),
        coalesce(sum(CASE WHEN a.agent_type IN ('codex-desktop', 'codex-cli')
            THEN max(a.input_tokens - a.cached_input_tokens - a.cache_write_input_tokens, 0)
            ELSE a.input_tokens END), 0)
            + coalesce(sum(a.cached_input_tokens), 0) + coalesce(sum(a.cache_write_input_tokens), 0),
        coalesce(sum(a.output_tokens), 0)
    FROM agent_usage_events a
    WHERE strftime('%Y-%m-%d', a.event_time, 'localtime') = date('now', 'localtime')
      AND NOT EXISTS (
          SELECT 1 FROM request_logs rl
          WHERE rl.agent_type = a.agent_type AND rl.agent_session_id = a.session_id
      )
    UNION ALL
    SELECT
        coalesce(sum(d.known_tokens + d.native_total_tokens), 0),
        coalesce(sum(d.input_tokens + d.native_input_tokens + d.native_cached_input_tokens
            + d.native_cache_write_input_tokens), 0),
        coalesce(sum(d.input_cached_tokens + d.native_cached_input_tokens), 0),
        coalesce(sum(d.input_uncached_tokens + d.native_input_tokens), 0),
        coalesce(sum(d.cache_measured_input_tokens + d.native_input_tokens
            + d.native_cached_input_tokens + d.native_cache_write_input_tokens), 0),
        coalesce(sum(d.output_tokens + d.native_output_tokens), 0)
    FROM device_daily_usage d
    WHERE d.usage_date = date('now', 'localtime')
)
SELECT coalesce(sum(total_tokens), 0) AS total_tokens,
       coalesce(sum(input_tokens), 0) AS input_tokens,
       coalesce(sum(input_cached_tokens), 0) AS input_cached_tokens,
       coalesce(sum(input_uncached_tokens), 0) AS input_uncached_tokens,
       coalesce(sum(cache_measured_input_tokens), 0) AS cache_measured_input_tokens,
       coalesce(sum(output_tokens), 0) AS output_tokens
FROM today_sources`;

function usageTodayTokens() {
  const summary = one(USAGE_TODAY_SQL);
  return {
    total_tokens: Number(summary.total_tokens),
    input_tokens: Number(summary.input_tokens),
    input_cached_tokens: Number(summary.input_cached_tokens),
    input_uncached_tokens: Number(summary.input_uncached_tokens),
    cache_measured_input_tokens: Number(summary.cache_measured_input_tokens),
    output_tokens: Number(summary.output_tokens),
  };
}

function readJsonConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}
const fileConfig = readJsonConfig();
const bindConfig = fileConfig.bind ?? {};

// ─── Command dispatch (whitelist, mirrors core/web/commands.rs) ─────────────

const commands = {
  ipc_ping: () => ({ ok: true, host: "web" }),
  list_channel_presets: () => listPresets(),
  list_channel_accounts: () => listAccounts(),
  list_route_candidates: () => listRoutes(listAccounts(), listPresets()),
  list_virtual_models: () => listVirtualModels(),
  list_channel_models: () =>
    rows("SELECT * FROM channel_models ORDER BY channel_id ASC, model ASC").map((row) => ({
      id: row.id,
      channel_id: row.channel_id,
      model: row.model,
      display_name: row.display_name ?? null,
      supported_protocols: parseJson(row.supported_protocols, []),
      context_window: row.context_window ?? null,
      max_output_tokens: row.max_output_tokens ?? null,
      supports_stream: bool(row.supports_stream),
      enabled: bool(row.enabled),
      source: row.source,
      synced_at: row.synced_at ?? null,
      created_at: row.created_at ?? "",
      updated_at: row.updated_at ?? "",
      pricing: parseJson(row.pricing_json, null),
    })),
  latest_balance_snapshots: () => latestBalanceSnapshots(),
  usage_today_tokens: () => usageTodayTokens(),
  proxy_status: () => ({
    running: false,
    bind_addr: `${bindConfig.host ?? "127.0.0.1"}:${bindConfig.port ?? 18640}`,
    started_at: null,
  }),
  web_connection_info: () => ({
    base_url: PUBLIC_PROXY_URL || `http://${bindConfig.host ?? "127.0.0.1"}:${bindConfig.port ?? 18640}`,
    client_token: bindConfig.default_client_token ?? "flowlet-local-token",
  }),
  read_app_meta: (args) => {
    const key = argString(args, "key");
    const row = one("SELECT value FROM app_meta WHERE key = ?", [key]);
    return row?.value ?? null;
  },
  get_log_capture_config: () =>
    parseJson(
      one("SELECT value FROM app_meta WHERE key = 'log_capture_config'")?.value,
      fileConfig.log_capture ?? {
        capture_req_headers: true,
        capture_req_body: true,
        capture_res_headers: true,
        capture_res_body: true,
        max_body_bytes: 1048576,
        redact_sensitive_headers: false,
        body_retention_days: 7,
        body_max_size_mb: 1024,
        body_prune_ratio: 0.1,
      },
    ),
};

function argString(args, name) {
  const value = args?.[name];
  if (typeof value !== "string") throw new CommandError(400, "command_failed", `参数 ${name}: 缺少字符串参数`);
  return value;
}

class CommandError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function dispatch(command, args) {
  const handler = commands[command];
  if (!handler) {
    throw new CommandError(501, "unsupported_in_web", `此功能需要桌面端：${command}`);
  }
  return handler(args ?? {});
}

// ─── HTTP server ────────────────────────────────────────────────────────────

function checkAuth(header) {
  const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !ADMIN_TOKEN) return false;
  const mac = (value) => createHmac("sha256", "flowlet-web-admin").update(value).digest();
  return timingSafeEqual(mac(token), mac(ADMIN_TOKEN));
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function sendUnauthorized(response) {
  sendJson(response, 401, { code: "unauthorized", message: "管理凭据无效，请重新登录" });
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new CommandError(413, "payload_too_large", "请求体超过 4 MiB");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CommandError(400, "command_failed", "请求体不是合法 JSON");
  }
}

async function serveStatic(response, urlPath) {
  let relative;
  try {
    relative = decodeURIComponent(urlPath);
  } catch {
    relative = "/";
  }
  const resolved = path.resolve(DIST_WEB, `.${relative === "/" ? "/index.html" : relative}`);
  const insideDist = resolved.startsWith(`${DIST_WEB}${path.sep}`);
  let file = insideDist && existsSync(resolved) ? resolved : path.join(DIST_WEB, "index.html");
  if (!existsSync(file)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("dist-web/index.html not found");
    return;
  }
  const body = await readFile(file);
  response.writeHead(200, {
    "Content-Type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
    "Content-Length": body.length,
  });
  response.end(body);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  try {
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (url.pathname === "/api/session" && request.method === "GET") {
      if (!checkAuth(request.headers.authorization)) return sendUnauthorized(response);
      sendJson(response, 200, { authenticated: true });
      return;
    }
    if (url.pathname.startsWith("/api/commands/") && request.method === "POST") {
      if (!checkAuth(request.headers.authorization)) return sendUnauthorized(response);
      const command = decodeURIComponent(url.pathname.slice("/api/commands/".length));
      const args = await readBody(request);
      const result = await dispatch(command, args);
      const size = Array.isArray(result) ? `${result.length} 条` : "对象";
      console.log(`[cmd] ${command} -> 200 (${size})`);
      sendJson(response, 200, result);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (request.method === "GET" || request.method === "HEAD") {
      await serveStatic(response, url.pathname);
      return;
    }
    response.writeHead(405);
    response.end();
  } catch (error) {
    if (error instanceof CommandError) {
      console.log(`[cmd] ${url.pathname} -> ${error.status} ${error.code}: ${error.message}`);
      sendJson(response, error.status, { code: error.code, message: error.message });
    } else {
      console.error("[server] 未处理错误", error);
      sendJson(response, 500, { code: "internal_error", message: String(error?.message ?? error) });
    }
  }
});

export function startServer() {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : PORT;
      const url = `http://${HOST}:${port}`;
      console.log("Flowlet Node command host ready", JSON.stringify({ url, staticDir: DIST_WEB, db: DB_PATH }));
      resolve({ server, url, close: () => { server.close(); db.close(); } });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startServer();
  console.log(`管理凭据: ${ADMIN_TOKEN}  (Authorization: Bearer <token>；≥24 字符)`);
  console.log(`本地模型服务地址（展示用）: ${PUBLIC_PROXY_URL || "http://127.0.0.1:18640"}`);
  process.on("SIGINT", () => { console.log("\n关闭…"); db.close(); process.exit(0); });
}