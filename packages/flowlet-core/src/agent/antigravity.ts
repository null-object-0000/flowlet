// Antigravity 本机额度观测。权威实现：`src-tauri/src/core/antigravity_account.rs`。
//
// 只做只读观测：发现本机 Antigravity language server 进程（命令行含 antigravity +
// language_server 且带 --csrf_token），探测其监听端口，调用本地 Connect RPC 读取额度。
// 不修改客户端、不读取凭据；RPC 错误与响应头一律不透出（可能含短期 CSRF 密钥）。
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

import type { JsonRow } from "../types.ts";
import { httpJson } from "./http.ts";

export interface AntigravityQuota {
  id: string;
  label: string;
  remaining_fraction: number | null;
  reset_at: string | null;
  description: string | null;
  disabled: boolean;
}

export interface AntigravityAccountReport {
  account_id: string;
  source: string;
  stale: boolean;
  reauthorization_required: boolean;
  email: string | null;
  plan: string | null;
  quotas: AntigravityQuota[];
  quota_source: string | null;
  updated_at: string;
  error: string | null;
}

export interface AntigravityAccountsReport {
  accounts: AntigravityAccountReport[];
}

export interface AntigravityServer {
  pid: number;
  csrf: string;
  extensionPort: number | null;
  extensionCsrf: string | null;
}

function isJsonObject(value: unknown): value is JsonRow {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function flag(command: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`(?:^|\\s)--${escaped}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|(\\S+))`, "u");
  const match = pattern.exec(command);
  if (match === null) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

export function parseServer(pid: number, command: string): AntigravityServer | null {
  const normalized = command.replace(/\\/gu, "/").toLowerCase();
  if (!normalized.includes("antigravity")) return null;
  if (!normalized.includes("language_server") && !normalized.includes("language-server")) return null;
  const csrf = flag(command, "csrf_token");
  if (csrf === null) return null;
  const extensionPortText = flag(command, "extension_server_port");
  const extensionPort =
    extensionPortText !== null && /^\d+$/u.test(extensionPortText) ? Number(extensionPortText) : null;
  return {
    pid,
    csrf,
    extensionPort: extensionPort !== null && extensionPort > 0 ? extensionPort : null,
    extensionCsrf: flag(command, "extension_server_csrf_token"),
  };
}

interface CommandResult {
  ok: boolean;
  stdout: string;
}

function commandOutput(program: string, args: ReadonlyArray<string>): CommandResult {
  const result = spawnSync(program, [...args], {
    timeout: 4000,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error !== undefined && result.error !== null) return { ok: false, stdout: "" };
  return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

function discoverServers(): AntigravityServer[] {
  if (process.platform === "win32") {
    const result = commandOutput("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*language*server*' -and $_.CommandLine -like '*antigravity*' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ]);
    if (!result.ok) throw new Error("无法查询 Antigravity 本地进程");
    const output = result.stdout.trim();
    if (output === "") return [];
    let value: unknown;
    try {
      value = JSON.parse(output);
    } catch {
      throw new Error("无法解析 Antigravity 本地进程");
    }
    const entries = Array.isArray(value) ? value : [value];
    const servers: AntigravityServer[] = [];
    for (const entry of entries) {
      if (!isJsonObject(entry)) continue;
      const pid = entry.ProcessId;
      const commandLine = entry.CommandLine;
      if (typeof pid !== "number" || typeof commandLine !== "string") continue;
      const server = parseServer(pid, commandLine);
      if (server !== null) servers.push(server);
    }
    return servers;
  }
  const result = commandOutput("ps", ["-x", "-o", "pid=,command="]);
  if (!result.ok) throw new Error("无法查询 Antigravity 本地进程");
  const servers: AntigravityServer[] = [];
  for (const rawLine of result.stdout.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const match = /^(\d+)\s+(.*)$/u.exec(line);
    if (match === null) continue;
    const server = parseServer(Number(match[1]), match[2].trim());
    if (server !== null) servers.push(server);
  }
  return servers;
}

function linuxPorts(pid: number): number[] {
  const root = `/proc/${pid}`;
  const socketIds = new Set<string>();
  try {
    for (const entry of fs.readdirSync(`${root}/fd`)) {
      try {
        const link = fs.readlinkSync(`${root}/fd/${entry}`);
        const match = /^socket:\[(\d+)\]$/u.exec(link);
        if (match !== null) socketIds.add(match[1]);
      } catch {
        // fd 可能在读取时消失。
      }
    }
  } catch {
    return [];
  }
  const ports = new Set<number>();
  for (const table of ["net/tcp", "net/tcp6"]) {
    let content: string;
    try {
      content = fs.readFileSync(`${root}/${table}`, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/u);
      if (fields.length <= 9) continue;
      if (fields[3] !== "0A") continue;
      if (!socketIds.has(fields[9])) continue;
      const local = fields[1];
      const portHex = local.slice(local.lastIndexOf(":") + 1);
      const port = Number.parseInt(portHex, 16);
      if (Number.isInteger(port) && port > 0) ports.add(port);
    }
  }
  return [...ports];
}

function listeningPorts(pid: number): number[] {
  if (process.platform === "linux") return linuxPorts(pid);
  if (process.platform === "win32") {
    const script = `Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort`;
    const result = commandOutput("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
    if (!result.ok) throw new Error("无法查询 Antigravity 本地进程");
    return result.stdout
      .split(/\r?\n/u)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((port) => Number.isInteger(port) && port > 0);
  }
  const result = commandOutput("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"]);
  if (!result.ok) throw new Error("无法查询 Antigravity 本地进程");
  return result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("n"))
    .map((line) => Number.parseInt(line.slice(line.lastIndexOf(":") + 1), 10))
    .filter((port) => Number.isInteger(port) && port > 0);
}

export function string(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function resetAt(value: unknown): string | null {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  let seconds: number | null = null;
  if (typeof value === "number" && Number.isInteger(value)) seconds = value;
  else if (typeof value === "string" && /^-?\d+$/u.test(value)) seconds = Number(value);
  if (seconds === null) return null;
  return new Date(seconds * 1000).toISOString();
}

export function fraction(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(Math.max(value, 0), 1);
}

function valueAt(root: unknown, key: string): unknown {
  return isJsonObject(root) ? root[key] : undefined;
}

export function validResponse(value: unknown): boolean {
  if (!isJsonObject(value)) return false;
  const code = value.code;
  if (code === undefined || code === null) return true;
  if (typeof code === "number") return code === 0;
  if (typeof code === "string") return ["0", "ok", "success"].includes(code.toLowerCase());
  return false;
}

export function summaryQuotas(value: unknown): AntigravityQuota[] {
  if (!validResponse(value)) return [];
  const root = isJsonObject(value)
    ? (value.response ?? value.summary ?? value)
    : value;
  const groups = valueAt(root, "groups");
  if (!Array.isArray(groups)) return [];
  const quotas: AntigravityQuota[] = [];
  for (const group of groups) {
    const buckets = valueAt(group, "buckets");
    if (!Array.isArray(buckets)) continue;
    for (const bucket of buckets) {
      const id = string(valueAt(bucket, "bucketId")) ?? string(valueAt(bucket, "id"));
      if (id === null) continue;
      const label =
        string(valueAt(bucket, "displayName")) ?? string(valueAt(bucket, "name")) ?? id;
      const groupName =
        string(valueAt(group, "displayName")) ?? string(valueAt(group, "name"));
      const remaining = valueAt(bucket, "remaining");
      quotas.push({
        id,
        label: groupName === null ? label : `${groupName} · ${label}`,
        remaining_fraction:
          fraction(valueAt(bucket, "remainingFraction")) ??
          fraction(valueAt(remaining, "remainingFraction")) ??
          (valueAt(remaining, "case") === "remainingFraction"
            ? fraction(valueAt(remaining, "value"))
            : null),
        reset_at: resetAt(valueAt(bucket, "resetTime")),
        description: string(valueAt(bucket, "description")),
        disabled: valueAt(bucket, "disabled") === true,
      });
    }
  }
  return quotas;
}

export function modelQuotas(value: unknown): AntigravityQuota[] {
  if (!validResponse(value)) return [];
  const configs =
    pointer(value, ["userStatus", "cascadeModelConfigData", "clientModelConfigs"]) ??
    valueAt(value, "clientModelConfigs");
  if (!Array.isArray(configs)) return [];
  const quotas: AntigravityQuota[] = [];
  for (const model of configs) {
    const quota = valueAt(model, "quotaInfo");
    if (!isJsonObject(quota)) continue;
    const id =
      string(pointer(model, ["modelOrAlias", "model"])) ?? string(valueAt(model, "label"));
    if (id === null) continue;
    quotas.push({
      id,
      label: string(valueAt(model, "label")) ?? id,
      remaining_fraction: fraction(valueAt(quota, "remainingFraction")),
      reset_at: resetAt(valueAt(quota, "resetTime")),
      description: null,
      disabled: false,
    });
  }
  return quotas;
}

function pointer(value: unknown, keys: ReadonlyArray<string>): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!isJsonObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

async function rpc(
  scheme: string,
  port: number,
  csrf: string,
  method: string,
  body: JsonRow,
): Promise<JsonRow | null> {
  let response;
  try {
    response = await httpJson(
      `${scheme}://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/${method}`,
      {
        method: "POST",
        timeoutMs: 2000,
        insecure: true,
        headers: {
          "x-codeium-csrf-token": csrf,
          "connect-protocol-version": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
  } catch {
    return null;
  }
  if (response.status < 200 || response.status >= 300) return null;
  if (!validResponse(response.value)) return null;
  return response.value as JsonRow;
}

/** 查询单个已发现的本机 language server（导出以便用本地 fixture 服务测试）。 */
export async function queryAntigravityServer(server: AntigravityServer): Promise<AntigravityAccountReport> {
  const report: AntigravityAccountReport = {
    account_id: `local-${server.pid}`,
    source: "local",
    stale: false,
    reauthorization_required: false,
    email: null,
    plan: null,
    quotas: [],
    quota_source: null,
    updated_at: new Date().toISOString(),
    error: null,
  };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), 18_000);
  });
  const work = (async (): Promise<
    | { kind: "ok"; status: JsonRow | null; quotas: AntigravityQuota[]; source: string }
    | { kind: "error"; message: string }
  > => {
    let ports: number[];
    try {
      ports = listeningPorts(server.pid);
    } catch (error) {
      if (server.extensionPort === null) {
        return { kind: "error", message: error instanceof Error ? error.message : String(error) };
      }
      ports = [];
    }
    if (server.extensionPort !== null) ports.push(server.extensionPort);
    const metadata = {
      metadata: { ideName: "antigravity", extensionName: "antigravity", locale: "en" },
    };
    let best: { status: JsonRow | null; quotas: AntigravityQuota[]; source: string } | null = null;
    for (const port of ports.filter((item) => item > 0).slice(0, 12)) {
      for (const scheme of ["https", "http"] as const) {
        const csrf =
          scheme === "http" && port === server.extensionPort
            ? (server.extensionCsrf ?? server.csrf)
            : server.csrf;
        const summary = await rpc(scheme, port, csrf, "RetrieveUserQuotaSummary", {
          forceRefresh: false,
        });
        let quotas = summary === null ? [] : summaryQuotas(summary);
        const status = await rpc(scheme, port, csrf, "GetUserStatus", metadata);
        let source = "summary";
        if (quotas.length === 0) {
          source = "models";
          quotas = status === null ? [] : modelQuotas(status);
        }
        if (quotas.length === 0) {
          source = "models";
          const configs = await rpc(scheme, port, csrf, "GetCommandModelConfigs", metadata);
          quotas = configs === null ? [] : modelQuotas(configs);
        }
        if (pointer(status, ["userStatus"]) === undefined && quotas.length === 0) continue;
        if (quotas.length > 0) return { kind: "ok", status, quotas, source };
        best = { status, quotas, source };
      }
    }
    if (best === null) {
      return {
        kind: "error",
        message: "无法读取 Antigravity 额度，请确认客户端已登录且本地服务已就绪",
      };
    }
    return { kind: "ok", ...best };
  })();
  const result = await Promise.race([work, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  if ("kind" in result && result.kind === "timeout") {
    report.error = "Antigravity 额度查询超时，请稍后刷新";
    return report;
  }
  if ("kind" in result && result.kind === "error") {
    report.error = result.message;
    return report;
  }
  const success = result as { status: JsonRow | null; quotas: AntigravityQuota[]; source: string };
  report.quota_source = success.source;
  report.email = string(pointer(success.status, ["userStatus", "email"]));
  report.account_id = report.email ?? report.account_id;
  report.plan =
    string(pointer(success.status, ["userStatus", "userTier", "name"])) ??
    (() => {
      const info = pointer(success.status, ["userStatus", "planStatus", "planInfo"]);
      for (const key of ["planDisplayName", "displayName", "productName", "planName", "planShortName"]) {
        const value = string(valueAt(info, key));
        if (value !== null) return value;
      }
      return null;
    })();
  report.quotas = success.quotas;
  return report;
}

type Quality = [boolean, boolean, boolean, number];

function reportQuality(report: AntigravityAccountReport): Quality {
  return [
    report.error === null,
    report.quotas.some((quota) => !quota.disabled && quota.remaining_fraction !== null),
    report.quota_source === "summary",
    report.quotas.length,
  ];
}

function compareQuality(left: Quality, right: Quality): number {
  const a = [left[0] ? 1 : 0, left[1] ? 1 : 0, left[2] ? 1 : 0, left[3]] as const;
  const b = [right[0] ? 1 : 0, right[1] ? 1 : 0, right[2] ? 1 : 0, right[3]] as const;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export async function queryAntigravityAccounts(): Promise<AntigravityAccountsReport> {
  const servers = discoverServers();
  const queried = await Promise.all(servers.slice(0, 8).map(queryAntigravityServer));
  const deduplicated: AntigravityAccountReport[] = [];
  for (const account of queried) {
    const existing = deduplicated.find((item) => item.account_id === account.account_id);
    if (existing === undefined) deduplicated.push(account);
    else if (compareQuality(reportQuality(account), reportQuality(existing)) > 0) {
      deduplicated[deduplicated.indexOf(existing)] = account;
    }
  }
  return { accounts: deduplicated };
}
