// OpenCode 权限确认桥（Rust core/opencode_control.rs 的 TS 移植）。
//
// Owner: desktop-observability。两条通道：
// 1. 权限桥：OpenCode 侧受管桥接把实时状态写入 `<home>/.flowlet/opencode-control/state-*.json`
//    （5 秒内有效）；回复写 `reply-<permissionId>.json`。
// 2. 控制服务回退：`http://127.0.0.1:4096` 的 `/permission` 与
//    `/permission/{id}/reply`。
//
// 字段命名：Rust 结构是 `#[serde(rename_all = "camelCase")]`，输出 `serverUrl` 等；
// 输入侧兼容 OpenCode 自己的 `sessionID` / `messageID` / `callID` 写法。
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { JsonRow } from "../types.ts";

const BRIDGE_FRESHNESS_MILLIS = 5_000;
const LEGACY_CONTROL_URL = "http://127.0.0.1:4096";

export const ALLOW_ONCE = "allow_once";
export const REJECT = "reject";
export type OpenCodePermissionDecision = "allow_once" | "reject";

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

function asRow(value: unknown): JsonRow | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRow)
    : null;
}

function textField(value: JsonRow, field: string): string {
  const raw = value[field];
  return typeof raw === "string" ? raw : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** 反序列化一条 OpenCode 权限请求（兼容 sessionID / messageID / callID 大小写别名）。 */
function parsePermission(value: unknown): OpenCodePermissionRequest | null {
  const row = asRow(value);
  if (row === null) return null;
  const id = textField(row, "id");
  const sessionId = textField(row, "sessionId") || textField(row, "sessionID");
  const permission = textField(row, "permission");
  const toolRow = asRow(row.tool);
  const tool =
    toolRow === null
      ? null
      : {
          messageId: textField(toolRow, "messageId") || textField(toolRow, "messageID"),
          callId: textField(toolRow, "callId") || textField(toolRow, "callID"),
        };
  return {
    id,
    sessionId,
    permission,
    patterns: stringArray(row.patterns),
    metadata: row.metadata === undefined ? null : row.metadata,
    always: stringArray(row.always),
    tool,
  };
}

function bridgeRoot(): string | null {
  try {
    const home = homedir();
    return home === "" ? null : path.join(home, ".flowlet", "opencode-control");
  } catch {
    return null;
  }
}

function freshBridgeStates(): OpenCodeBridgeState[] {
  const root = bridgeRoot();
  if (root === null) return [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const now = Date.now();
  const states: OpenCodeBridgeState[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!(entry.name.startsWith("state-") && entry.name.endsWith(".json"))) continue;
    let parsed: JsonRow | null = null;
    try {
      parsed = asRow(JSON.parse(readFileSync(path.join(root, entry.name), "utf8")));
    } catch {
      continue;
    }
    if (parsed === null) continue;
    const serverUrl = textField(parsed, "serverUrl");
    const updatedAt = typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0;
    if (now - updatedAt > BRIDGE_FRESHNESS_MILLIS) continue;
    const permissions = Array.isArray(parsed.permissions)
      ? parsed.permissions
          .map(parsePermission)
          .filter((item): item is OpenCodePermissionRequest => item !== null)
      : [];
    states.push({ serverUrl, updatedAt, permissions });
  }
  return states;
}

function listBridgePermissions(sessionId: string): OpenCodePermissionReport | null {
  const states = freshBridgeStates();
  if (states.length === 0) return null;
  const serverUrl = states[0]?.serverUrl ?? LEGACY_CONTROL_URL;
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
  return { available: true, serverUrl, permissions, error: null };
}

function listBridgePermissionsAll(): OpenCodePermissionReport | null {
  const states = freshBridgeStates();
  if (states.length === 0) return null;
  const serverUrl = states[0]?.serverUrl ?? LEGACY_CONTROL_URL;
  const seen = new Set<string>();
  const permissions: OpenCodePermissionRequest[] = [];
  for (const state of states) {
    for (const permission of state.permissions) {
      if (seen.has(permission.id)) continue;
      seen.add(permission.id);
      permissions.push(permission);
    }
  }
  return { available: true, serverUrl, permissions, error: null };
}

function bridgeServerForPermission(permissionId: string): string | null {
  for (const state of freshBridgeStates()) {
    if (state.permissions.some((permission) => permission.id === permissionId)) {
      return state.serverUrl;
    }
  }
  return null;
}

function writeBridgeReply(permissionId: string, decision: OpenCodePermissionDecision): void {
  const root = bridgeRoot();
  if (root === null) throw new Error("无法确定 OpenCode 权限桥接目录");
  try {
    mkdirSync(root, { recursive: true });
  } catch (error) {
    throw new Error(`创建 OpenCode 权限桥接目录失败：${errorMessage(error)}`);
  }
  try {
    writeFileSync(
      path.join(root, `reply-${permissionId}.json`),
      JSON.stringify({ permissionId, reply: decision === ALLOW_ONCE ? "once" : "reject" }),
    );
  } catch (error) {
    throw new Error(`提交 OpenCode 权限回复失败：${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validatePermissionId(permissionId: string): void {
  if (permissionId === "" || !/^[A-Za-z0-9_-]+$/.test(permissionId)) {
    throw new Error("OpenCode 权限请求 ID 无效");
  }
}

/** Rust `list_permissions`：全部会话的待确认权限（桥接优先，控制服务回退）。 */
export async function listPermissions(): Promise<OpenCodePermissionReport> {
  const bridge = listBridgePermissionsAll();
  if (bridge !== null) return bridge;
  return listPermissionsFrom(LEGACY_CONTROL_URL, null);
}

/** Rust `pending_session_ids`：控制服务不可用时返回空集合。 */
export async function pendingSessionIds(): Promise<Set<string>> {
  const report = await listPermissions();
  if (!report.available) return new Set();
  return new Set(report.permissions.map((permission) => permission.sessionId));
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
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/permission`, {
      signal: AbortSignal.timeout(2_000),
    });
  } catch (error) {
    return unavailable(`无法连接 OpenCode 控制服务：${errorMessage(error)}`);
  }
  if (!response.ok) {
    return unavailable(`OpenCode 控制服务返回 HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return unavailable(`无法解析 OpenCode 权限请求：${errorMessage(error)}`);
  }
  if (!Array.isArray(body)) {
    return unavailable("无法解析 OpenCode 权限请求：invalid type, expected a sequence");
  }
  const permissions = body
    .map(parsePermission)
    .filter((item): item is OpenCodePermissionRequest => item !== null)
    .filter((item) => sessionId === null || item.sessionId === sessionId);
  return { available: true, serverUrl: baseUrl, permissions, error: null };
}

/** Rust `list_session_permissions`：桥接优先，控制服务回退；永不抛错。 */
export async function listSessionPermissions(sessionId: string): Promise<OpenCodePermissionReport> {
  const bridge = listBridgePermissions(sessionId);
  if (bridge !== null) return bridge;
  return listPermissionsFrom(LEGACY_CONTROL_URL, sessionId);
}

async function replyPermissionAt(
  baseUrl: string,
  permissionId: string,
  decision: OpenCodePermissionDecision,
): Promise<void> {
  validatePermissionId(permissionId);
  const url = new URL(baseUrl);
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  segments.push("permission", encodeURIComponent(permissionId), "reply");
  url.pathname = `/${segments.join("/")}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reply: decision === ALLOW_ONCE ? "once" : "reject" }),
      signal: AbortSignal.timeout(2_000),
    });
  } catch (error) {
    throw new Error(`无法向 OpenCode 提交操作：${errorMessage(error)}`);
  }
  if (!response.ok) {
    throw new Error(`OpenCode 拒绝了本次操作（HTTP ${response.status}）`);
  }
  let accepted: unknown;
  try {
    accepted = await response.json();
  } catch (error) {
    throw new Error(`无法解析 OpenCode 操作结果：${errorMessage(error)}`);
  }
  if (accepted !== true) {
    throw new Error("OpenCode 未接受本次操作，权限请求可能已经结束");
  }
}

/** Rust `reply_permission`。 */
export async function replyPermission(
  permissionId: string,
  decision: OpenCodePermissionDecision,
): Promise<void> {
  validatePermissionId(permissionId);
  if (bridgeServerForPermission(permissionId) !== null) {
    writeBridgeReply(permissionId, decision);
    return;
  }
  await replyPermissionAt(LEGACY_CONTROL_URL, permissionId, decision);
}

/** 解析并校验前端传入的 decision 字符串（Rust serde 枚举拒绝其它值）。 */
export function parsePermissionDecision(value: unknown): OpenCodePermissionDecision {
  if (value === ALLOW_ONCE || value === REJECT) return value;
  // 与 serde 枚举反序列化错误文案一致：字符串值不带引号。
  const rendered = String(value);
  throw new Error(`unknown variant \`${rendered}\`, expected \`allow_once\` or \`reject\``);
}