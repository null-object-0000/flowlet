// OpenCode 权限桥接 / 控制服务。Owner: desktop-device。
//
// 权威实现：src-tauri/src/core/opencode_control.rs。跨设备同步只需要其中三条入口：
// - `pendingSessionIds`：快照里把 OpenCode 待确认会话标成 waiting_user；
// - `listSessionPermissions`：LAN `/opencode/permissions/{sessionId}`；
// - `replyPermission`：LAN `/opencode/permissions/{permissionId}/reply`。
//
// 桥接协议（本机文件）与 Rust 一致：桌面端 OpenCode 插件把权限请求写到
// `~/.flowlet/opencode-control/state-*.json`，Flowlet 把决策写到 `reply-{permissionId}.json`；
// 新鲜窗口 5 秒。桥接不可用时回退到 OpenCode 控制服务 `http://127.0.0.1:4096`。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";

export const BRIDGE_FRESHNESS_MILLIS = 5_000;
export const LEGACY_CONTROL_URL = "http://127.0.0.1:4096";

export interface OpenCodePermissionTool {
  messageId: string;
  callId: string;
}

export interface OpenCodePermissionRequest {
  id: string;
  sessionId: string;
  permission: string;
  patterns: string[];
  metadata: unknown;
  always: string[];
  tool: OpenCodePermissionTool | null;
}

export interface OpenCodePermissionReport {
  available: boolean;
  serverUrl: string;
  permissions: OpenCodePermissionRequest[];
  error: string | null;
}

interface OpenCodeBridgeState {
  serverUrl: string;
  updatedAt: number;
  permissions: OpenCodePermissionRequest[];
}

function bridgeRoot(): string | null {
  const home = homedir();
  return home === "" ? null : path.join(home, ".flowlet", "opencode-control");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizePermission(value: unknown): OpenCodePermissionRequest | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = asString(record.id).trim();
  const sessionId = asString(record.sessionId ?? record.sessionID).trim();
  if (id === "" || sessionId === "") return null;
  const toolRecord =
    record.tool !== null && typeof record.tool === "object" && !Array.isArray(record.tool)
      ? (record.tool as Record<string, unknown>)
      : null;
  return {
    id,
    sessionId,
    permission: asString(record.permission),
    patterns: Array.isArray(record.patterns) ? record.patterns.map((item) => String(item)) : [],
    metadata: record.metadata ?? null,
    always: Array.isArray(record.always) ? record.always.map((item) => String(item)) : [],
    tool:
      toolRecord === null
        ? null
        : {
            messageId: asString(toolRecord.messageId ?? toolRecord.messageID),
            callId: asString(toolRecord.callId ?? toolRecord.callID),
          },
  };
}

function freshBridgeStates(): OpenCodeBridgeState[] {
  const root = bridgeRoot();
  if (root === null || !existsSync(root)) return [];
  const now = Date.now();
  const states: OpenCodeBridgeState[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  for (const name of entries) {
    if (!name.startsWith("state-") || !name.endsWith(".json")) continue;
    let content: string;
    try {
      content = readFileSync(path.join(root, name), "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    const updatedAt = Number(record.updatedAt ?? 0);
    if (!Number.isFinite(updatedAt) || now - updatedAt > BRIDGE_FRESHNESS_MILLIS) continue;
    const permissions: OpenCodePermissionRequest[] = [];
    if (Array.isArray(record.permissions)) {
      for (const item of record.permissions) {
        const permission = normalizePermission(item);
        if (permission !== null) permissions.push(permission);
      }
    }
    states.push({
      serverUrl: asString(record.serverUrl),
      updatedAt,
      permissions,
    });
  }
  return states;
}

function bridgeServerUrl(states: OpenCodeBridgeState[]): string {
  return states.length > 0 && states[0].serverUrl !== ""
    ? states[0].serverUrl
    : LEGACY_CONTROL_URL;
}

function listBridgePermissions(sessionId: string): OpenCodePermissionReport | null {
  const states = freshBridgeStates();
  if (states.length === 0) return null;
  const seen = new Set<string>();
  const permissions: OpenCodePermissionRequest[] = [];
  for (const state of states) {
    for (const permission of state.permissions) {
      if (permission.sessionId !== sessionId) continue;
      if (seen.has(permission.id)) continue;
      seen.add(permission.id);
      permissions.push(permission);
    }
  }
  return { available: true, serverUrl: bridgeServerUrl(states), permissions, error: null };
}

function listBridgePermissionsAll(): OpenCodePermissionReport | null {
  const states = freshBridgeStates();
  if (states.length === 0) return null;
  const seen = new Set<string>();
  const permissions: OpenCodePermissionRequest[] = [];
  for (const state of states) {
    for (const permission of state.permissions) {
      if (seen.has(permission.id)) continue;
      seen.add(permission.id);
      permissions.push(permission);
    }
  }
  return { available: true, serverUrl: bridgeServerUrl(states), permissions, error: null };
}

function bridgeServerForPermission(permissionId: string): string | null {
  for (const state of freshBridgeStates()) {
    if (state.permissions.some((permission) => permission.id === permissionId)) {
      return state.serverUrl;
    }
  }
  return null;
}

function apiReply(decision: "allow_once" | "reject"): string {
  return decision === "allow_once" ? "once" : "reject";
}

function writeBridgeReply(
  permissionId: string,
  decision: "allow_once" | "reject",
): void {
  const root = bridgeRoot();
  if (root === null) throw new Error("无法确定 OpenCode 权限桥接目录");
  try {
    mkdirSync(root, { recursive: true });
  } catch (error) {
    throw new Error(
      `创建 OpenCode 权限桥接目录失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const body = JSON.stringify({ permissionId, reply: apiReply(decision) });
  try {
    writeFileSync(path.join(root, `reply-${permissionId}.json`), body, "utf8");
  } catch (error) {
    throw new Error(
      `提交 OpenCode 权限回复失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validatePermissionId(permissionId: string): void {
  if (permissionId === "" || !/^[A-Za-z0-9_-]+$/.test(permissionId)) {
    throw new Error("OpenCode 权限请求 ID 无效");
  }
}

interface ControlResponse {
  status: number;
  body: Buffer;
}

/** Rust `control_client`：connect 800ms / total 2s，本机控制服务。 */
function controlRequest(
  baseUrl: string,
  method: string,
  pathname: string,
  body: Buffer | null,
): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      reject(new Error(`OpenCode 控制地址无效：${baseUrl}`));
      return;
    }
    const clientRequest = httpRequest(
      {
        hostname: url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname,
        port: url.port === "" ? 80 : Number(url.port),
        path: pathname,
        method,
        headers:
          body === null
            ? {}
            : { "content-type": "application/json", "content-length": String(body.byteLength) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) });
        });
      },
    );
    clientRequest.setTimeout(2_000, () => {
      clientRequest.destroy(new Error("OpenCode 控制请求超时"));
    });
    clientRequest.on("error", reject);
    if (body !== null) clientRequest.write(body);
    clientRequest.end();
  });
}

async function listPermissionsFrom(
  baseUrl: string,
  sessionId: string | null,
): Promise<OpenCodePermissionReport> {
  const unavailable = (message: string): OpenCodePermissionReport => ({
    available: false,
    serverUrl: baseUrl,
    permissions: [],
    error: message,
  });
  let response: ControlResponse;
  try {
    response = await controlRequest(baseUrl, "GET", "/permission", null);
  } catch (error) {
    return unavailable(
      `无法连接 OpenCode 控制服务：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    return unavailable(`OpenCode 控制服务返回 HTTP ${response.status}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body.toString("utf8"));
  } catch (error) {
    return unavailable(
      `无法解析 OpenCode 权限请求：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const permissions: OpenCodePermissionRequest[] = [];
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const permission = normalizePermission(item);
      if (permission === null) continue;
      if (sessionId !== null && permission.sessionId !== sessionId) continue;
      permissions.push(permission);
    }
  }
  return { available: true, serverUrl: baseUrl, permissions, error: null };
}

async function replyPermissionAt(
  baseUrl: string,
  permissionId: string,
  decision: "allow_once" | "reject",
): Promise<void> {
  validatePermissionId(permissionId);
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (error) {
    throw new Error(
      `OpenCode 控制地址无效：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const pathname = `${url.pathname.replace(/\/+$/, "")}/permission/${permissionId}/reply`;
  const body = Buffer.from(JSON.stringify({ reply: apiReply(decision) }), "utf8");
  let response: ControlResponse;
  try {
    response = await controlRequest(baseUrl, "POST", pathname, body);
  } catch (error) {
    throw new Error(
      `无法向 OpenCode 提交操作：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`OpenCode 拒绝了本次操作（HTTP ${response.status}）`);
  }
  let accepted: unknown;
  try {
    accepted = JSON.parse(response.body.toString("utf8"));
  } catch (error) {
    throw new Error(
      `无法解析 OpenCode 操作结果：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (accepted !== true) {
    throw new Error("OpenCode 未接受本次操作，权限请求可能已经结束");
  }
}

/** Rust `list_session_permissions`。 */
export async function listSessionPermissions(
  sessionId: string,
): Promise<OpenCodePermissionReport> {
  const bridged = listBridgePermissions(sessionId);
  if (bridged !== null) return bridged;
  return listPermissionsFrom(LEGACY_CONTROL_URL, sessionId);
}

/** Rust `pending_session_ids`：控制服务不可用时返回空集合。 */
export async function pendingSessionIds(): Promise<Set<string>> {
  const report = await listPermissions();
  if (!report.available) return new Set();
  return new Set(report.permissions.map((permission) => permission.sessionId));
}

export async function listPermissions(): Promise<OpenCodePermissionReport> {
  const bridged = listBridgePermissionsAll();
  if (bridged !== null) return bridged;
  return listPermissionsFrom(LEGACY_CONTROL_URL, null);
}

/** Rust `reply_permission`。 */
export async function replyPermission(
  permissionId: string,
  decision: "allow_once" | "reject",
): Promise<void> {
  validatePermissionId(permissionId);
  if (bridgeServerForPermission(permissionId) !== null) {
    writeBridgeReply(permissionId, decision);
    return;
  }
  await replyPermissionAt(LEGACY_CONTROL_URL, permissionId, decision);
}

/** 测试/诊断用途：权限桥接目录内容摘要（不暴露正文）。 */
export function bridgeStateDigest(): string {
  const states = freshBridgeStates();
  return createHash("sha256").update(JSON.stringify(states)).digest("hex");
}