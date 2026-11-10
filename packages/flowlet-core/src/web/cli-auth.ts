// CLI 浏览器授权（`flowlet login`）服务端实现。Owner: node-web.
//
// 为什么需要：Docker/Web Host 会以 OIDC-only 部署（`FLOWLET_ADMIN_ALLOW_TOKEN_LOGIN=0`），
// 管理 API 拒绝一切 Bearer，`flowlet pull --token=…` 必然 401。这里给 CLI 一条
// **独立作用域**的授权路径，而不是放开管理面：
//
//   1. CLI 生成 PKCE(S256) + state，起 loopback 回调，打开
//      `GET /api/auth/cli/start?redirect_uri=…&state=…&code_challenge=…`；
//   2. 用户在已登录的管理台会话里点「授权」，页面调
//      `POST /api/commands/create_cli_auth_code`（走现有 Cookie+CSRF 鉴权）；
//   3. 服务端返回带一次性 code 的 302 目标，CLI 回调拿到 code 后
//      `POST /api/auth/cli/exchange`（公开，但必须提供 PKCE verifier）换 token；
//   4. token 形如 `flwcli_<43 字符 base64url>`，库内只存 SHA-256，作用域固定
//      `credentials:read`，只允许 `export_service_credentials`，TTL 30 天。
//
// 设计约束：token 不能登录管理台、不能读日志/改配置；撤销即时生效（查库）。
import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { JsonRow } from "../types.ts";
import { CommandError } from "../types.ts";
import { hashCliAuthToken, toCliAuthTokenView } from "../storage/cli-auth.ts";

/** token 前缀：用于与普通管理 Bearer 区分（只有该前缀才查库）。 */
export const CLI_TOKEN_PREFIX = "flwcli_";
/** 唯一作用域：只读服务凭据。 */
export const CLI_TOKEN_SCOPE = "credentials:read";
/** 授权码有效期：120 秒（够用户点一次授权 + 浏览器跳转）。 */
export const CLI_AUTH_CODE_TTL_MS = 120_000;
/** token 有效期：30 天。 */
export const CLI_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 允许 CLI token 调用的命令白名单（其余一律 403）。 */
export const CLI_ALLOWED_COMMANDS: ReadonlySet<string> = new Set(["export_service_credentials"]);
/** 待处理授权码上限，防止无界内存增长。 */
const MAX_PENDING_CODES = 64;
const CODE_LENGTH = 43;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

interface PendingCode {
  codeChallenge: string;
  redirectUri: string;
  name: string;
  expiresAtMs: number;
}

/** node-storage 的 cli_auth_tokens 方法（本模块不写 SQL）。 */
export interface CliAuthStorage {
  insertCliAuthToken(row: {
    id?: string;
    name: string;
    tokenHash: string;
    scope: string;
    expiresAt: string;
  }): JsonRow;
  listCliAuthTokens(): JsonRow[];
  findCliAuthTokenByHash(tokenHash: string): JsonRow | null;
  touchCliAuthToken(id: string): void;
  deleteCliAuthToken(id: string): boolean;
  deleteExpiredCliAuthTokens(): number;
}

export interface CliAuthCodeRequest {
  redirectUri: string;
  state: string;
  codeChallenge: string;
  name?: string | null;
}

export interface CliAuth {
  /** `GET /api/auth/cli/start` 的返回值：HTML 授权页（参数不合法时 400）。 */
  startPage(params: URLSearchParams): { status: number; html: string };
  /** 已登录管理会话调用：登记授权码并返回 302 目标。 */
  authorize(input: CliAuthCodeRequest): { redirectUrl: string };
  /** `POST /api/auth/cli/exchange`：PKCE 校验 + 签发 token。 */
  exchange(body: unknown): { token: string; expiresAt: string };
  /** 受保护路由兜底：`Authorization: Bearer flwcli_*` 校验，返回 token 行或 null。 */
  authenticate(headers: Record<string, string | string[] | undefined>): JsonRow | null;
  /** 管理 API：列出已授权 CLI（不含 token/哈希）。 */
  list(): JsonRow[];
  /** 管理 API：撤销（幂等）。 */
  revoke(id: string): null;
}

/** 秒级 RFC3339 UTC（与其它业务时间戳一致）。 */
function rfc3339Seconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sha256Base64url(value: string): string {
  return base64url(createHash("sha256").update(value, "utf8").digest());
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function singleLine(value: string, max: number): string {
  // 控制字符一律拒绝（state / name 会回显到 HTML 与重定向 URL）。
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

/** 只允许 loopback 回调；返回归一后的 URL（保留 path/query，去掉 fragment）。 */
export function validateCliRedirectUri(raw: unknown): string {
  const value = text(raw).trim();
  if (value === "") throw new CommandError(400, "command_failed", "redirectUri 不能为空");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CommandError(400, "command_failed", "redirectUri 不是合法 URL");
  }
  if (url.protocol !== "http:") {
    throw new CommandError(400, "command_failed", "redirectUri 只支持 http://127.0.0.1:<port>");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new CommandError(
      400,
      "command_failed",
      "redirectUri 只允许 127.0.0.1 / localhost / [::1]（CLI 本机回调）",
    );
  }
  if (url.port === "") {
    throw new CommandError(400, "command_failed", "redirectUri 必须显式包含端口");
  }
  if (url.username !== "" || url.password !== "") {
    throw new CommandError(400, "command_failed", "redirectUri 不允许包含用户信息");
  }
  if (url.hash !== "") {
    throw new CommandError(400, "command_failed", "redirectUri 不允许包含 fragment");
  }
  return url.toString();
}

function validateState(raw: unknown): string {
  const value = text(raw);
  if (value === "") throw new CommandError(400, "command_failed", "state 不能为空");
  const cleaned = singleLine(value, 512);
  if (cleaned !== value || cleaned.length > 512) {
    throw new CommandError(400, "command_failed", "state 非法（最多 512 个可见字符）");
  }
  return cleaned;
}

function validateChallenge(raw: unknown): string {
  const value = text(raw).trim();
  // S256 challenge 是 SHA-256 的 base64url（无填充）固定 43 字符。
  if (value.length !== CODE_LENGTH || !BASE64URL.test(value)) {
    throw new CommandError(
      400,
      "command_failed",
      "codeChallenge 必须是 PKCE S256 的 43 字符 base64url",
    );
  }
  return value;
}

function validateName(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  const value = singleLine(text(raw), 120);
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 把数据嵌进 `<script>`：转义 `<` 避免提前闭合脚本标签。 */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function renderPage(title: string, body: string, script: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)} · Flowlet</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif;
         background: #f5f6f7; color: #1f2329; padding: 24px; }
  main { width: 100%; max-width: 460px; background: #fff; border: 1px solid #e5e6eb; border-radius: 12px;
         padding: 28px 28px 24px; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06); }
  h1 { margin: 0 0 12px; font-size: 18px; line-height: 26px; }
  p { margin: 0 0 12px; color: #4e5969; }
  code { background: #f2f3f5; border-radius: 4px; padding: 1px 5px; font-size: 12.5px;
         word-break: break-all; }
  .kv { background: #f7f8fa; border-radius: 8px; padding: 12px 14px; margin: 16px 0; font-size: 13px; }
  .kv div + div { margin-top: 6px; }
  .muted { color: #86909c; font-size: 12.5px; }
  button { appearance: none; border: 0; border-radius: 8px; padding: 10px 18px; font-size: 14px;
           font-weight: 600; cursor: pointer; background: #1664ff; color: #fff; }
  button:disabled { opacity: .6; cursor: default; }
  a { color: #1664ff; }
  .error { color: #cb2634; }
  .ok { color: #00875a; }
  .hidden { display: none; }
</style>
</head>
<body>
<main>
${body}
</main>
<script>
${script}
</script>
</body>
</html>
`;
}

function errorPage(message: string, detail = ""): string {
  return renderPage(
    "无法完成授权",
    `<h1>无法完成授权</h1>
<p class="error">${escapeHtml(message)}</p>
${detail === "" ? "" : `<p class="muted">${escapeHtml(detail)}</p>`}
<p class="muted">请回到终端重新执行 <code>flowlet login</code>。</p>`,
    "/* 参数错误页不需要脚本 */",
  );
}

export function createCliAuth(
  storage: CliAuthStorage,
  now: () => number = Date.now,
): CliAuth {
  const pending = new Map<string, PendingCode>();

  const prunePending = (current: number): void => {
    for (const [code, entry] of pending) {
      if (entry.expiresAtMs <= current) pending.delete(code);
    }
    // Map 按插入顺序迭代：超过上限时删除最旧的。
    while (pending.size > MAX_PENDING_CODES) {
      const oldest = pending.keys().next();
      if (oldest.done === true) break;
      pending.delete(oldest.value);
    }
  };

  const readBearer = (
    headers: Record<string, string | string[] | undefined>,
  ): string | null => {
    const raw = headers["authorization"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string") return null;
    if (!value.startsWith("Bearer ")) return null;
    return value.slice("Bearer ".length).trim();
  };

  return {
    startPage(params: URLSearchParams): { status: number; html: string } {
      let redirectUri: string;
      let state: string;
      let codeChallenge: string;
      let name: string;
      try {
        redirectUri = validateCliRedirectUri(params.get("redirect_uri"));
        state = validateState(params.get("state"));
        const method = params.get("code_challenge_method");
        if (method !== null && method !== "" && method !== "S256") {
          throw new CommandError(400, "command_failed", "只支持 code_challenge_method=S256");
        }
        codeChallenge = validateChallenge(params.get("code_challenge"));
        name = validateName(params.get("name"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { status: 400, html: errorPage(message) };
      }

      const payload = scriptJson({ redirectUri, state, codeChallenge, name });
      const body = `<h1>授权 flowlet CLI</h1>
<p>一个终端正在请求 Flowlet 凭据。授权后它只能用<strong>只读</strong>方式同步「服务凭据」，
不能登录管理台、不能修改配置。</p>
<div class="kv">
  <div>请求来源：<code>${escapeHtml(name === "" ? "未命名机器" : name)}</code></div>
  <div>作用域：<code>${CLI_TOKEN_SCOPE}</code>（仅 <code>export_service_credentials</code>）</div>
  <div>有效期：30 天，可在「服务凭据 → 本机接入」随时撤销</div>
</div>
<div id="state-loading"><p class="muted">正在检查管理台登录状态…</p></div>
<div id="state-login" class="hidden">
  <p class="error">需要先登录 Flowlet 管理台。</p>
  <p class="muted">登录后回到终端重新执行 <code>flowlet login</code>，或先在新标签页打开
  <a href="/" target="_blank" rel="noreferrer">Flowlet 管理台</a> 完成登录。</p>
</div>
<div id="state-token" class="hidden">
  <p>当前实例使用 <strong>token 模式</strong>，无需浏览器授权。</p>
  <p class="muted">请在终端直接执行：<br><code id="token-cmd"></code></p>
</div>
<div id="state-approve" class="hidden">
  <button id="approve" type="button">授权并继续</button>
  <p id="approve-error" class="error hidden"></p>
</div>`;

      const script = `(function () {
  var payload = ${payload};
  var origin = window.location.origin;
  function show(id) {
    ["state-loading", "state-login", "state-token", "state-approve"].forEach(function (key) {
      var node = document.getElementById(key);
      if (node) node.classList.toggle("hidden", key !== id);
    });
  }
  function fail(message) {
    show("state-approve");
    var button = document.getElementById("approve");
    if (button) button.disabled = true;
    var error = document.getElementById("approve-error");
    if (error) {
      error.textContent = message;
      error.classList.remove("hidden");
    }
  }
  fetch("/api/auth/config", { credentials: "same-origin" })
    .then(function (response) { return response.json(); })
    .then(function (config) {
      if (config && config.mode === "token") {
        var command = document.getElementById("token-cmd");
        if (command) command.textContent = "flowlet pull --server=" + origin + " --token=<管理凭据>";
        show("state-token");
        return;
      }
      return fetch("/api/session", { credentials: "same-origin" }).then(function (session) {
        if (session.status === 401) {
          show("state-login");
          return;
        }
        if (!session.ok) throw new Error("无法读取管理会话（HTTP " + session.status + "）");
        return session.json().then(function (info) {
          if (!info || info.mode !== "oidc") {
            show("state-login");
            return;
          }
          var button = document.getElementById("approve");
          show("state-approve");
          button.addEventListener("click", function () {
            button.disabled = true;
            fetch("/api/commands/create_cli_auth_code", {
              method: "POST",
              credentials: "same-origin",
              headers: { "content-type": "application/json", "x-csrf-token": info.csrf_token || "" },
              body: JSON.stringify({
                redirectUri: payload.redirectUri,
                state: payload.state,
                codeChallenge: payload.codeChallenge,
                name: payload.name
              })
            }).then(function (response) {
              return response.json().then(function (data) {
                if (!response.ok) throw new Error((data && data.message) || ("HTTP " + response.status));
                if (!data || typeof data.redirectUrl !== "string") throw new Error("服务端未返回跳转地址");
                window.location.href = data.redirectUrl;
              });
            }).catch(function (error) {
              fail("授权失败：" + (error && error.message ? error.message : String(error)));
            });
          });
        });
      });
    })
    .catch(function (error) {
      fail("读取授权状态失败：" + (error && error.message ? error.message : String(error)));
    });
})();`;

      return { status: 200, html: renderPage("授权 flowlet CLI", body, script) };
    },

    authorize(input: CliAuthCodeRequest): { redirectUrl: string } {
      const current = now();
      prunePending(current);
      const redirectUri = validateCliRedirectUri(input.redirectUri);
      const state = validateState(input.state);
      const codeChallenge = validateChallenge(input.codeChallenge);
      const name = validateName(input.name);
      const code = base64url(randomBytes(32));
      pending.set(code, {
        codeChallenge,
        redirectUri,
        name,
        expiresAtMs: current + CLI_AUTH_CODE_TTL_MS,
      });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      target.searchParams.set("state", state);
      return { redirectUrl: target.toString() };
    },

    exchange(body: unknown): { token: string; expiresAt: string } {
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new CommandError(400, "invalid_request", "请求体必须是 JSON 对象");
      }
      const record = body as Record<string, unknown>;
      const code = text(record.code).trim();
      const verifier = text(record.codeVerifier).trim();
      if (code === "" || verifier === "") {
        throw new CommandError(400, "invalid_request", "code 与 codeVerifier 均为必填");
      }
      if (code.length !== CODE_LENGTH || !BASE64URL.test(code)) {
        throw new CommandError(400, "invalid_grant", "授权码无效或已过期");
      }
      if (verifier.length < 43 || verifier.length > 128 || !BASE64URL.test(verifier)) {
        throw new CommandError(400, "invalid_grant", "codeVerifier 非法");
      }
      const current = now();
      const entry = pending.get(code);
      // 一次性：无论校验成功与否都作废，避免重放探测。
      pending.delete(code);
      if (entry === undefined || entry.expiresAtMs <= current) {
        throw new CommandError(400, "invalid_grant", "授权码无效或已过期");
      }
      if (sha256Base64url(verifier) !== entry.codeChallenge) {
        throw new CommandError(400, "invalid_grant", "授权码无效或已过期");
      }
      const token = `${CLI_TOKEN_PREFIX}${base64url(randomBytes(32))}`;
      const expiresAt = rfc3339Seconds(new Date(current + CLI_TOKEN_TTL_MS));
      try {
        storage.deleteExpiredCliAuthTokens();
      } catch {
        // 清理失败不影响签发（下一轮再清）。
      }
      const row = storage.insertCliAuthToken({
        id: randomUUID(),
        name: entry.name,
        tokenHash: hashCliAuthToken(token),
        scope: CLI_TOKEN_SCOPE,
        expiresAt,
      });
      if (row.id === undefined || row.id === null) {
        throw new CommandError(500, "command_failed", "签发 CLI 凭据失败");
      }
      return { token, expiresAt };
    },

    authenticate(headers: Record<string, string | string[] | undefined>): JsonRow | null {
      const raw = readBearer(headers);
      if (raw === null || !raw.startsWith(CLI_TOKEN_PREFIX)) return null;
      const row = storage.findCliAuthTokenByHash(hashCliAuthToken(raw));
      if (row === null) return null;
      const expiresAt = Date.parse(String(row.expires_at));
      if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
        // 过期即删，避免死行累积。
        try {
          storage.deleteCliAuthToken(String(row.id));
        } catch {
          /* 忽略清理失败 */
        }
        return null;
      }
      try {
        storage.touchCliAuthToken(String(row.id));
      } catch {
        /* last_used_at 更新失败不影响鉴权 */
      }
      return row;
    },

    list(): JsonRow[] {
      try {
        storage.deleteExpiredCliAuthTokens();
      } catch {
        /* 忽略清理失败 */
      }
      return storage.listCliAuthTokens().map(toCliAuthTokenView);
    },

    revoke(id: string): null {
      storage.deleteCliAuthToken(id);
      return null;
    },
  };
}
