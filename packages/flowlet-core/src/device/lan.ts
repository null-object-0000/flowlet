// 局域网（LAN）直连同步。Owner: desktop-device。
//
// 权威实现：src-tauri/src/core/lan_sync.rs。必须逐字节兼容的协议细节：
// - 端口：0（OS 分配）发布到 descriptor；客户端支持多端点回退；
// - 路径：/flowlet/v1/ping、/flowlet/v1/snapshot、/flowlet/v1/session/read、
//   /flowlet/v1/opencode/permissions/{sessionId}、.../permissions/{permissionId}/reply；
// - 鉴权头：x-flowlet-timestamp / x-flowlet-nonce / x-flowlet-signature；
//   签名 = hex(HMAC-SHA256(key, METHOD\npath\ntimestamp\nnonce\n + body))，时间窗 ±30s，
//   nonce 30s 内不可重放；
// - 响应：ChaCha20-Poly1305（12 字节随机 nonce，AAD = 请求 nonce 的 ASCII 字节），
//   JSON 为 { nonce: base64, ciphertext: base64 }；
// - 探测/刷新客户端：connect timeout 500ms、总超时 3s；权限回复体
//   {"decision":"allow_once|reject","operationId":uuid}。
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createSocket } from "node:dgram";
import { createServer, request as httpRequest } from "node:http";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  Server as HttpServer,
  ServerResponse,
} from "node:http";
import { networkInterfaces } from "node:os";

import type { DeviceUsageBundle, LanPeerDescriptor, SyncedAgentSession } from "./bundle.ts";
import { parseBundleBytes, validateBundle } from "./bundle.ts";

export const LAN_PROTOCOL_VERSION = 1;
export const AUTH_WINDOW_SECONDS = 30;
export const MAX_AUTH_NONCES = 2048;
export const MAX_INBOUND_EVENTS = 50;
export const DESCRIPTOR_TTL_MINUTES = 20;
export const LAN_CAPABILITIES = [
  "snapshot.read",
  "session.read",
  "opencode.permission.read",
  "opencode.permission.reply",
] as const;

export interface EncryptedPayload {
  nonce: string;
  ciphertext: string;
}

export interface LanInboundEvent {
  remoteAddr: string;
  path: string;
  at: string;
}

export interface LanServerStatus {
  running: boolean;
  endpoints: string[];
  startedAt: string | null;
  error: string | null;
}

export interface LanServerReport {
  status: LanServerStatus;
  inbound: LanInboundEvent[];
}

export interface PingResponse {
  deviceId: string;
  protocolVersion: number;
  capabilities: string[];
  serverTime: string;
}

export interface LanProbeError {
  kind: "unreachable" | "invalid";
  message: string;
}

export interface LanPeerProbe {
  deviceId: string;
  lanPublished: boolean;
  reachable: boolean;
  latencyMs: number | null;
  protocolVersion: number | null;
  errorKind: "unreachable" | "unauthorized" | "outdated" | "invalid" | null;
  error: string | null;
}

export type OpenCodePermissionDecision = "allow_once" | "reject";

function invalid(message: string): never {
  throw new Error(message);
}

// ─── 描述符与端点校验 ───────────────────────────────────────────────────────

function hostWithoutBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const values: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    values.push(value);
  }
  return values;
}

/** Rust `Ipv4Addr::is_private`：10/8、172.16/12、192.168/16。 */
function isPrivateIpv4(address: string): boolean {
  const parts = parseIpv4(address);
  if (parts === null) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

/** Rust `Ipv6Addr::is_unique_local`：fc00::/7。 */
function isUniqueLocalIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  const firstGroup = lower.split(":")[0];
  const value = Number.parseInt(firstGroup === "" ? "0" : firstGroup, 16);
  if (Number.isNaN(value)) return false;
  return (value & 0xfe) === 0xfc;
}

export function isPrivateAddress(address: string): boolean {
  const host = hostWithoutBrackets(address);
  if (host.includes(":")) return isUniqueLocalIpv6(host);
  return isPrivateIpv4(host);
}

/**
 * 显式端口：Node 的 URL 会把显式默认端口（http :80 / https :443）归一化成空串，
 * 而 Rust `Url::port()` 仍返回 Some(80)，因此不能用 `parsed.port` 判断是否带端口。
 */
export function explicitEndpointPort(endpoint: string): number | null {
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/.exec(endpoint);
  if (match === null) return null;
  let authority = match[1];
  const at = authority.lastIndexOf("@");
  if (at >= 0) authority = authority.slice(at + 1);
  let portText: string | null = null;
  if (authority.startsWith("[")) {
    const closing = authority.indexOf("]");
    if (closing < 0) return null;
    const rest = authority.slice(closing + 1);
    if (!rest.startsWith(":")) return null;
    portText = rest.slice(1);
  } else {
    const colon = authority.lastIndexOf(":");
    if (colon < 0) return null;
    portText = authority.slice(colon + 1);
  }
  if (portText === "" || !/^\d+$/.test(portText)) return null;
  const port = Number(portText);
  return port >= 0 && port <= 65_535 ? port : null;
}

/** Rust `validate_endpoint`。错误文案逐句对齐。 */
export function validateLanEndpoint(endpoint: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    invalid("局域网设备端点无效");
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    explicitEndpointPort(endpoint) === null
  ) {
    invalid("局域网设备端点格式无效");
  }
  const host = hostWithoutBrackets(parsed.hostname);
  const isIpv4 = parseIpv4(host) !== null;
  const isIpv6 = host.includes(":");
  if (!isIpv4 && !isIpv6) invalid("局域网设备端点必须使用内网 IP");
  if (isIpv4) {
    if (!isPrivateIpv4(host)) invalid("局域网设备端点不在允许的内网地址范围");
    return;
  }
  const lower = host.toLowerCase();
  if (!isUniqueLocalIpv6(lower)) invalid("局域网设备端点不在允许的内网地址范围");
  if (
    lower === "::" ||
    lower === "::1" ||
    lower === "0:0:0:0:0:0:0:1"
  ) {
    invalid("局域网设备端点不在允许的内网地址范围");
  }
}

export function endpointPort(endpoint: string): number | null {
  return explicitEndpointPort(endpoint);
}

/** Rust `descriptor_is_fresh`：未过期、协议版本一致、密钥与至少一个端点有效。 */
export function descriptorIsFresh(descriptor: LanPeerDescriptor | null | undefined): boolean {
  if (descriptor === null || descriptor === undefined) return false;
  const expires = Date.parse(descriptor.expiresAt);
  if (Number.isNaN(expires) || expires <= Date.now()) return false;
  if (descriptor.protocolVersion !== LAN_PROTOCOL_VERSION) return false;
  if (!hasValidDescriptorKey(descriptor)) return false;
  return descriptor.endpoints.some((endpoint) => {
    try {
      validateLanEndpoint(endpoint);
      return true;
    } catch {
      return false;
    }
  });
}

export function hasValidDescriptorKey(descriptor: LanPeerDescriptor): boolean {
  try {
    return descriptorKey(descriptor).byteLength === 32;
  } catch {
    return false;
  }
}

export function descriptorKey(descriptor: LanPeerDescriptor): Buffer {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(descriptor.authKey, "base64");
  } catch {
    invalid("局域网设备认证材料无效");
  }
  if (decoded.byteLength !== 32) invalid("局域网设备认证材料长度无效");
  return decoded;
}

export function randomAuthKey(): Buffer {
  return randomBytes(32);
}

// ─── 本机 LAN 地址发现 ──────────────────────────────────────────────────────

/**
 * Rust `format!("http://{address}:{port}")`：IPv6 地址不加方括号，因此 ULA IPv6 候选
 * 会因 URL 无效被 `validate_endpoint` 过滤掉（与 Rust 行为一致）。
 */
function formatEndpointHost(address: string): string {
  return address;
}

/** Rust `candidate_lan_addresses`（UDP routing 启发式 → 网卡枚举）。 */
export async function candidateLanAddresses(): Promise<string[]> {
  const candidates: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.internal) continue;
      if (address.family !== "IPv4" && address.family !== "IPv6") continue;
      const value = hostWithoutBrackets(address.address);
      if (value === "" || value === "::" || value === "0.0.0.0") continue;
      if (!isPrivateAddress(value)) continue;
      if (!candidates.includes(value)) candidates.push(value);
    }
  }
  const routed = await routedLocalAddress();
  if (routed !== null) {
    const rest = candidates.filter((value) => value !== routed);
    rest.unshift(routed);
    return rest;
  }
  return candidates;
}

/** UDP connect 到 1.1.1.1:53 只为让 OS 选默认路由，不真正发包。 */
function routedLocalAddress(): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* socket 可能已经关闭 */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 300);
    socket.once("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    socket.connect(53, "1.1.1.1", () => {
      clearTimeout(timer);
      try {
        const address = socket.address().address;
        const value = hostWithoutBrackets(address);
        finish(
          value !== "" && value !== "0.0.0.0" && value !== "::" && isPrivateAddress(value)
            ? value
            : null,
        );
      } catch {
        finish(null);
      }
    });
  });
}

// ─── 签名 / 加密 ────────────────────────────────────────────────────────────

function signaturePayload(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: Buffer,
): Buffer {
  return Buffer.concat([
    Buffer.from(`${method}\n${path}\n${timestamp}\n${nonce}\n`, "utf8"),
    body,
  ]);
}

export function signLanRequest(
  key: Buffer,
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: Buffer,
): string {
  return createHmac("sha256", key)
    .update(signaturePayload(method, path, timestamp, nonce, body))
    .digest("hex");
}

export function verifyLanSignature(
  key: Buffer,
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: Buffer,
  signatureHex: string,
): void {
  if (!/^[0-9a-fA-F]*$/.test(signatureHex) || signatureHex.length % 2 !== 0) {
    invalid("局域网签名无效");
  }
  const supplied = Buffer.from(signatureHex, "hex");
  if (supplied.byteLength !== 32) invalid("局域网签名无效");
  const expected = createHmac("sha256", key)
    .update(signaturePayload(method, path, timestamp, nonce, body))
    .digest();
  if (!timingSafeEqual(supplied, expected)) invalid("局域网签名不匹配");
}

export function encryptLanPayload(
  key: Buffer,
  aad: Buffer,
  value: unknown,
): EncryptedPayload {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return {
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptLanPayload<T>(key: Buffer, aad: Buffer, payload: EncryptedPayload): T {
  let nonce: Buffer;
  try {
    nonce = Buffer.from(payload.nonce, "base64");
  } catch {
    invalid("局域网响应 nonce 无效");
  }
  if (nonce.byteLength !== 12) invalid("局域网响应 nonce 长度无效");
  let ciphertext: Buffer;
  try {
    ciphertext = Buffer.from(payload.ciphertext, "base64");
  } catch {
    invalid("局域网响应正文无效");
  }
  if (ciphertext.byteLength < 16) invalid("局域网响应认证失败");
  const tag = ciphertext.subarray(ciphertext.byteLength - 16);
  const body = ciphertext.subarray(0, ciphertext.byteLength - 16);
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    invalid("局域网响应认证失败");
  }
  try {
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch (error) {
    invalid(
      `解析局域网响应失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ─── 客户端 ─────────────────────────────────────────────────────────────────

interface SignedResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  key: Buffer;
  nonce: string;
}

function httpSend(
  endpoint: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(`${endpoint.replace(/\/+$/, "")}${path}`);
    } catch (error) {
      reject(error);
      return;
    }
    const clientRequest = httpRequest(
      {
        hostname: hostWithoutBrackets(url.hostname),
        port: url.port === "" ? 80 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method,
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    clientRequest.setTimeout(3_000, () => {
      clientRequest.destroy(new Error("局域网请求超时"));
    });
    clientRequest.on("error", reject);
    if (body.byteLength > 0) clientRequest.write(body);
    clientRequest.end();
  });
}

async function sendSigned(
  descriptor: LanPeerDescriptor,
  endpoint: string,
  method: string,
  path: string,
  body: Buffer,
): Promise<SignedResponse> {
  try {
    validateLanEndpoint(endpoint);
  } catch (error) {
    return Promise.reject({
      kind: "invalid",
      message: error instanceof Error ? error.message : String(error),
    } satisfies LanProbeError);
  }
  let key: Buffer;
  try {
    key = descriptorKey(descriptor);
  } catch (error) {
    return Promise.reject({
      kind: "invalid",
      message: error instanceof Error ? error.message : String(error),
    } satisfies LanProbeError);
  }
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  const signature = signLanRequest(key, method, path, timestamp, nonce, body);
  try {
    const response = await httpSend(
      endpoint,
      method,
      path,
      {
        "x-flowlet-timestamp": timestamp,
        "x-flowlet-nonce": nonce,
        "x-flowlet-signature": signature,
        "content-type": "application/json",
      },
      body,
    );
    return { ...response, key, nonce };
  } catch (error) {
    return Promise.reject({
      kind: "unreachable",
      message: `局域网设备不可达：${error instanceof Error ? error.message : String(error)}`,
    } satisfies LanProbeError);
  }
}

async function requestFrom<T>(
  descriptor: LanPeerDescriptor,
  endpoint: string,
  method: string,
  path: string,
  body: Buffer,
): Promise<T> {
  let response: SignedResponse;
  try {
    response = await sendSigned(descriptor, endpoint, method, path, body);
  } catch (error) {
    const probeError = error as LanProbeError;
    invalid(probeError.message);
  }
  if (response.status < 200 || response.status >= 300) {
    invalid(`局域网设备返回 HTTP ${response.status}`);
  }
  let payload: EncryptedPayload;
  try {
    payload = JSON.parse(response.body.toString("utf8")) as EncryptedPayload;
  } catch (error) {
    invalid(
      `读取局域网响应失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    typeof payload.nonce !== "string" ||
    typeof payload.ciphertext !== "string"
  ) {
    invalid("读取局域网响应失败：响应结构无效");
  }
  return decryptLanPayload<T>(response.key, Buffer.from(response.nonce, "utf8"), payload);
}

/** Rust `fetch_snapshot`：遍历端点，任一成功即可。 */
export async function fetchLanSnapshot(
  descriptor: LanPeerDescriptor,
): Promise<DeviceUsageBundle> {
  let lastError = "没有可用的局域网端点";
  for (const endpoint of descriptor.endpoints) {
    try {
      return await requestFrom<DeviceUsageBundle>(
        descriptor,
        endpoint,
        "GET",
        "/flowlet/v1/snapshot",
        Buffer.alloc(0),
      );
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  invalid(lastError);
}

/** Rust `probe_peer`。 */
export async function probeLanPeer(
  descriptor: LanPeerDescriptor,
  expectedDeviceId: string,
): Promise<LanPeerProbe> {
  const probe: LanPeerProbe = {
    deviceId: expectedDeviceId,
    lanPublished: true,
    reachable: false,
    latencyMs: null,
    protocolVersion: null,
    errorKind: null,
    error: null,
  };
  let lastError: { kind: LanPeerProbe["errorKind"]; message: string } | null = null;
  for (const endpoint of descriptor.endpoints) {
    const started = Date.now();
    let response: SignedResponse;
    try {
      response = await sendSigned(
        descriptor,
        endpoint,
        "GET",
        "/flowlet/v1/ping",
        Buffer.alloc(0),
      );
    } catch (error) {
      const probeError = error as LanProbeError;
      lastError = {
        kind: probeError.kind === "invalid" ? "invalid" : "unreachable",
        message: probeError.message,
      };
      continue;
    }
    if (response.status === 401) {
      lastError = { kind: "unauthorized", message: "局域网认证失败，连接信息可能已过期" };
      continue;
    }
    if (response.status === 404) {
      lastError = { kind: "outdated", message: "对端版本过旧，缺少 ping 端点" };
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      lastError = { kind: "invalid", message: `局域网设备返回 HTTP ${response.status}` };
      continue;
    }
    let payload: EncryptedPayload;
    try {
      payload = JSON.parse(response.body.toString("utf8")) as EncryptedPayload;
    } catch (error) {
      lastError = {
        kind: "invalid",
        message: `读取局域网响应失败：${error instanceof Error ? error.message : String(error)}`,
      };
      continue;
    }
    try {
      const pong = decryptLanPayload<PingResponse>(
        response.key,
        Buffer.from(response.nonce, "utf8"),
        payload,
      );
      probe.reachable = true;
      probe.latencyMs = Date.now() - started;
      probe.protocolVersion = pong.protocolVersion;
      probe.deviceId = pong.deviceId;
      return probe;
    } catch (error) {
      lastError = {
        kind: "invalid",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (lastError !== null) {
    probe.errorKind = lastError.kind;
    probe.error = lastError.message;
  }
  return probe;
}

/** Rust `list_remote_permissions`。 */
export async function fetchRemotePermissions<T>(
  descriptor: LanPeerDescriptor,
  sessionId: string,
): Promise<T> {
  const path = `/flowlet/v1/opencode/permissions/${sessionId}`;
  let lastError = "没有可用的局域网端点";
  for (const endpoint of descriptor.endpoints) {
    try {
      return await requestFrom<T>(descriptor, endpoint, "GET", path, Buffer.alloc(0));
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return invalid(lastError);
}

/** Rust `reply_remote_permission`：operationId 在端点循环外生成一次，保持幂等。 */
export async function replyRemotePermission(
  descriptor: LanPeerDescriptor,
  permissionId: string,
  decision: OpenCodePermissionDecision,
): Promise<void> {
  const path = `/flowlet/v1/opencode/permissions/${permissionId}/reply`;
  const body = Buffer.from(
    JSON.stringify({ decision, operationId: randomUUID() }),
    "utf8",
  );
  let lastError = "没有可用的局域网端点";
  for (const endpoint of descriptor.endpoints) {
    try {
      const result = await requestFrom<{ Ok?: null; Err?: string }>(
        descriptor,
        endpoint,
        "POST",
        path,
        body,
      );
      if (result !== null && typeof result === "object" && "Err" in result) {
        lastError = String(result.Err);
        continue;
      }
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  invalid(lastError);
}

// ─── 服务端 ─────────────────────────────────────────────────────────────────

export interface LanServerDependencies {
  /** 本机设备 ID（ping 响应里的 deviceId）。 */
  deviceId: string;
  /** 发布/刷新 descriptor（写 app_meta `device_lan_descriptor_v1`）。 */
  publishDescriptor(descriptor: LanPeerDescriptor): Promise<void> | void;
  /** 构建本机设备用量快照（复用 device_usage_snapshot 的实现）。 */
  buildSnapshot(): Promise<DeviceUsageBundle>;
  /** 读取单个会话快照（session/read）。 */
  buildSession(agentType: string, sessionId: string): Promise<SyncedAgentSession | null>;
  /** OpenCode 权限列表（permission list handler）。 */
  listPermissions(sessionId: string): Promise<unknown>;
  /** OpenCode 权限回复（permission reply handler）。 */
  replyPermission(permissionId: string, decision: OpenCodePermissionDecision): Promise<void>;
}

interface LanRuntime {
  server: HttpServer;
  status: LanServerStatus;
  inbound: LanInboundEvent[];
  authKey: Buffer;
  nonces: Map<string, number>;
  deps: LanServerDependencies;
}

let runtime: LanRuntime | null = null;
let starting: Promise<LanServerStatus> | null = null;

export function readLanServerReport(): LanServerReport {
  const current = runtime;
  if (current === null) {
    return {
      status: { running: false, endpoints: [], startedAt: null, error: null },
      inbound: [],
    };
  }
  return {
    status: { ...current.status, endpoints: [...current.status.endpoints] },
    inbound: [...current.inbound].reverse().map((event) => ({ ...event })),
  };
}

function setServerStatus(update: Partial<LanServerStatus>): void {
  if (runtime === null) return;
  runtime.status = { ...runtime.status, ...update };
}

function recordInbound(remoteAddr: string | undefined, path: string): void {
  if (runtime === null || remoteAddr === undefined) return;
  const events = runtime.inbound;
  if (events.length >= MAX_INBOUND_EVENTS) events.shift();
  events.push({ remoteAddr, path, at: new Date().toISOString() });
}

function headerValue(message: IncomingMessage, name: string): string | null {
  const value = message.headers[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

function authorize(
  message: IncomingMessage,
  method: string,
  path: string,
  body: Buffer,
): string | null {
  if (runtime === null) return "局域网认证状态不可用";
  const timestamp = headerValue(message, "x-flowlet-timestamp");
  if (timestamp === null) return "缺少 x-flowlet-timestamp";
  const timestampValue = Number(timestamp);
  if (!Number.isInteger(timestampValue)) return "认证时间无效";
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestampValue) > AUTH_WINDOW_SECONDS) return "局域网认证已过期";
  const nonce = headerValue(message, "x-flowlet-nonce");
  if (nonce === null) return "缺少 x-flowlet-nonce";
  const signature = headerValue(message, "x-flowlet-signature");
  if (signature === null) return "缺少 x-flowlet-signature";
  try {
    verifyLanSignature(
      runtime.authKey,
      method,
      path,
      timestamp,
      nonce,
      body,
      signature,
    );
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const nonces = runtime.nonces;
  for (const [seenNonce, seenAt] of nonces) {
    if (now - seenAt > AUTH_WINDOW_SECONDS) nonces.delete(seenNonce);
  }
  if (nonces.has(nonce)) return "局域网请求已重复";
  if (nonces.size >= MAX_AUTH_NONCES) nonces.clear();
  nonces.set(nonce, now);
  return null;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.byteLength),
  });
  response.end(body);
}

function encryptedResponse(
  message: IncomingMessage,
  response: ServerResponse,
  value: unknown,
): void {
  if (runtime === null) {
    sendJson(response, 500, "局域网认证状态不可用");
    return;
  }
  const requestNonce = headerValue(message, "x-flowlet-nonce");
  if (requestNonce === null) {
    sendJson(response, 500, "缺少 x-flowlet-nonce");
    return;
  }
  try {
    const payload = encryptLanPayload(
      runtime.authKey,
      Buffer.from(requestNonce, "utf8"),
      value,
    );
    sendJson(response, 200, payload);
  } catch (error) {
    sendJson(response, 500, error instanceof Error ? error.message : String(error));
  }
}

function readBody(
  message: IncomingMessage,
  maxBytes = 4 * 1024 * 1024,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    message.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        reject(new Error("请求体过大"));
        message.destroy();
        return;
      }
      chunks.push(chunk);
    });
    message.on("error", reject);
    message.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function handleRequest(
  message: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (runtime === null) {
    sendJson(response, 503, "局域网服务未运行");
    return;
  }
  const method = message.method ?? "GET";
  const path = new URL(message.url ?? "/", "http://localhost").pathname;
  const remoteAddr = message.socket.remoteAddress?.replace(/^::ffff:/, "");

  if (method === "GET" && path === "/flowlet/v1/ping") {
    const authError = authorize(message, method, path, Buffer.alloc(0));
    if (authError !== null) {
      sendJson(response, 401, authError);
      return;
    }
    recordInbound(remoteAddr, path);
    encryptedResponse(message, response, {
      deviceId: runtime.deps.deviceId,
      protocolVersion: LAN_PROTOCOL_VERSION,
      capabilities: [...LAN_CAPABILITIES],
      serverTime: new Date().toISOString(),
    } satisfies PingResponse);
    return;
  }

  if (method === "GET" && path === "/flowlet/v1/snapshot") {
    const authError = authorize(message, method, path, Buffer.alloc(0));
    if (authError !== null) {
      sendJson(response, 401, authError);
      return;
    }
    recordInbound(remoteAddr, path);
    try {
      const bundle = await runtime.deps.buildSnapshot();
      encryptedResponse(message, response, bundle);
    } catch (error) {
      sendJson(response, 500, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (method === "POST" && path === "/flowlet/v1/session/read") {
    const body = await readBody(message);
    const authError = authorize(message, method, path, body);
    if (authError !== null) {
      sendJson(response, 401, authError);
      return;
    }
    let input: { agentType?: unknown; sessionId?: unknown };
    try {
      input = JSON.parse(body.toString("utf8")) as { agentType?: unknown; sessionId?: unknown };
    } catch {
      sendJson(response, 400, "无效的会话读取参数");
      return;
    }
    const agentType =
      typeof input.agentType === "string" ? input.agentType.trim() : "";
    const sessionId =
      typeof input.sessionId === "string" ? input.sessionId.trim() : "";
    if (agentType === "" || sessionId === "") {
      sendJson(response, 400, "无效的会话读取参数");
      return;
    }
    recordInbound(remoteAddr, path);
    try {
      const session = await runtime.deps.buildSession(agentType, sessionId);
      if (session === null) {
        sendJson(response, 404, "未找到会话");
        return;
      }
      encryptedResponse(message, response, {
        generatedAt: new Date().toISOString(),
        session,
      });
    } catch (error) {
      sendJson(response, 500, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  const permissionList = /^\/flowlet\/v1\/opencode\/permissions\/([^/]+)$/.exec(path);
  if (method === "GET" && permissionList !== null) {
    const authError = authorize(message, method, path, Buffer.alloc(0));
    if (authError !== null) {
      sendJson(response, 401, authError);
      return;
    }
    recordInbound(remoteAddr, path);
    try {
      encryptedResponse(message, response, await runtime.deps.listPermissions(permissionList[1]));
    } catch (error) {
      sendJson(response, 500, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  const permissionReply = /^\/flowlet\/v1\/opencode\/permissions\/([^/]+)\/reply$/.exec(path);
  if (method === "POST" && permissionReply !== null) {
    const body = await readBody(message);
    const authError = authorize(message, method, path, body);
    if (authError !== null) {
      sendJson(response, 401, authError);
      return;
    }
    recordInbound(remoteAddr, path);
    let input: { decision?: unknown; operationId?: unknown };
    try {
      input = JSON.parse(body.toString("utf8")) as { decision?: unknown; operationId?: unknown };
    } catch {
      sendJson(response, 400, "无效的确认操作");
      return;
    }
    const operationId =
      typeof input.operationId === "string" ? input.operationId.trim() : "";
    if (operationId === "") {
      sendJson(response, 400, "无效的确认操作");
      return;
    }
    if (input.decision !== "allow_once" && input.decision !== "reject") {
      sendJson(response, 400, "无效的确认操作");
      return;
    }
    try {
      await runtime.deps.replyPermission(permissionReply[1], input.decision);
      encryptedResponse(message, response, { Ok: null });
    } catch (error) {
      encryptedResponse(message, response, {
        Err: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  sendJson(response, 404, "未找到局域网端点");
}

/**
 * 启动 LAN 服务（幂等）。Rust 在桌面应用启动时调用 `start_server`；Node 桌面宿主没有
 * 对应的启动 channel，因此命令层在第一次需要 LAN 描述符时惰性调用本函数，
 * 行为等价（descriptor 在生成快照时刷新）。
 */
export async function ensureLanServer(
  dependencies: LanServerDependencies,
): Promise<LanServerStatus> {
  if (runtime !== null) return { ...runtime.status, endpoints: [...runtime.status.endpoints] };
  if (starting !== null) return starting;
  starting = (async (): Promise<LanServerStatus> => {
    const addresses = await candidateLanAddresses();
    const authKey = randomAuthKey();
    const server = createServer(handleRequest);
    let port: number;
    try {
      port = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "0.0.0.0", () => {
          const address = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("读取局域网同步端口失败"));
            return;
          }
          resolve(address.port);
        });
      });
    } catch (error) {
      try {
        server.close();
      } catch {
        /* 启动失败时关闭 socket 失败无额外影响 */
      }
      throw new Error(`启动局域网同步服务失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const endpoints = addresses
      .map((address) => `http://${formatEndpointHost(address)}:${port}`)
      .filter((endpoint) => {
        try {
          validateLanEndpoint(endpoint);
          return true;
        } catch {
          return false;
        }
      });
    if (endpoints.length === 0) {
      server.close();
      throw new Error("未找到可发布的局域网地址");
    }
    const now = new Date();
    const descriptor: LanPeerDescriptor = {
      protocolVersion: LAN_PROTOCOL_VERSION,
      endpoints,
      authKey: authKey.toString("base64"),
      capabilities: [...LAN_CAPABILITIES],
      startedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + DESCRIPTOR_TTL_MINUTES * 60_000).toISOString(),
    };
    await dependencies.publishDescriptor(descriptor);
    runtime = {
      server,
      status: {
        running: true,
        endpoints,
        startedAt: descriptor.startedAt,
        error: null,
      },
      inbound: [],
      authKey,
      nonces: new Map(),
      deps: dependencies,
    };
    server.on("error", (error: Error) => {
      setServerStatus({ running: false, error: error.message });
    });
    return { ...runtime.status, endpoints: [...endpoints] };
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

/** 测试用：关闭并清空进程内 LAN 服务状态。 */
export async function shutdownLanServerForTests(): Promise<void> {
  const current = runtime;
  runtime = null;
  if (current === null) return;
  await new Promise<void>((resolve) => {
    current.server.close(() => resolve());
    setTimeout(resolve, 200);
  });
}

/** 桌面端启动失败时记录原因（Rust `record_start_failure`）。 */
export function recordLanStartFailure(error: string): void {
  if (runtime !== null) {
    setServerStatus({ running: false, error });
  }
}
