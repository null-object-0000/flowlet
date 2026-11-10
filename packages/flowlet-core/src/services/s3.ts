// S3-compatible 存储客户端（SigV4，AWS Signature Version 4）。
//
// 权威实现：`src-tauri/src/core/device_sync.rs` 的 `S3SyncConfig` / `S3Store`
// （rusty_s3 + reqwest）。桌面命令批次 2 的账号工作区同步需要同一套对象读写语义，
// 因此在这里用 Node 内置 `fetch` 实现，不引入第三方 SDK。
//
// 契约要点：
// - 配置字段 camelCase（与 Rust `#[serde(rename_all = "camelCase")]` 一致）；
// - Endpoint / Bucket / Region / 前缀校验的错误文案与 Rust `from_input` 对齐；
// - 阿里云 OSS 的 S3-compatible 端点不支持 PutObject 的 If-Match，`supportsConditionalPut`
//   为 false 时省略条件写头（与 Rust 一致，调用方仍会先比较 ETag）；
// - 对象读取上限 64 MB（Rust `MAX_REMOTE_BUNDLE_BYTES`）。
//
// 该模块由 `desktop-device` 的跨设备同步命令复用；新增能力时保持签名向后兼容。
import { createHash, createHmac } from "node:crypto";

export const MAX_REMOTE_OBJECT_BYTES = 64 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const SIGNED_URL_TTL_SECONDS = 60;
const EMPTY_PAYLOAD_SHA256 = createHash("sha256").update("").digest("hex");

/** Rust `S3SyncConfig`（camelCase，持久化在 app_meta）。 */
export interface S3SyncConfig {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  pathStyle: boolean;
}

/** Rust `S3SyncConfigInput`（camelCase，含可写 Secret）。 */
export interface S3SyncConfigInput {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string | null;
  pathStyle: boolean;
}

export interface RemoteObject {
  key: string;
  etag: string;
  size: number;
}

function isHttpLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/** Rust `S3SyncConfig::from_input`：校验并归一化，错误文案逐条对齐。 */
export function parseS3ConfigInput(input: S3SyncConfigInput): S3SyncConfig {
  const endpoint = input.endpoint.trim().replace(/\/+$/, "");
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new Error("S3 Endpoint 格式无效");
  }
  if (
    (endpointUrl.protocol !== "http:" && endpointUrl.protocol !== "https:") ||
    endpointUrl.hostname.length === 0
  ) {
    throw new Error("S3 Endpoint 必须是有效的 HTTP 或 HTTPS 地址");
  }
  if (endpointUrl.protocol === "http:" && !isHttpLocalhost(endpointUrl.hostname)) {
    throw new Error("远程 S3 Endpoint 必须使用 HTTPS；HTTP 仅允许本机 MinIO");
  }
  const bucket = input.bucket.trim();
  if (bucket.length < 3 || bucket.length > 63 || /\s/.test(bucket)) {
    throw new Error("S3 Bucket 长度必须为 3–63 个字符且不能包含空白");
  }
  const accessKeyId = input.accessKeyId.trim();
  if (accessKeyId.length === 0 || accessKeyId.length > 256) {
    throw new Error("Access Key ID 不能为空且不能超过 256 个字符");
  }
  const region = input.region.trim();
  if (region.length === 0 || region.length > 64) {
    throw new Error("S3 Region 不能为空且不能超过 64 个字符");
  }
  const endpointHost = endpointUrl.hostname.toLowerCase();
  if (
    endpointHost.endsWith(".aliyuncs.com") &&
    endpointHost.startsWith(`${bucket.toLowerCase()}.`)
  ) {
    throw new Error(
      "阿里云 OSS Endpoint 不应包含 Bucket 名；上海地域请填写 https://s3.oss-cn-shanghai.aliyuncs.com",
    );
  }
  if (endpointHost.endsWith(".aliyuncs.com") && !endpointHost.startsWith("s3.oss-")) {
    throw new Error(
      "阿里云 OSS 必须使用 S3-compatible Endpoint；上海地域请填写 https://s3.oss-cn-shanghai.aliyuncs.com",
    );
  }
  if (endpointHost.endsWith(".aliyuncs.com") && region.toLowerCase() === "auto") {
    throw new Error("阿里云 OSS Region 不能使用 auto；上海地域请填写 cn-shanghai");
  }
  const prefix = input.prefix
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter((part) => part.length > 0)
    .join("/");
  if (prefix.length > 256 || prefix.split("/").some((part) => part === "..")) {
    throw new Error("S3 路径前缀无效");
  }
  return { endpoint, region, bucket, prefix, accessKeyId, pathStyle: input.pathStyle === true };
}

/** Rust `S3SyncConfig::credential_username`：sha256(endpoint \0 bucket \0 accessKeyId)。 */
export function s3CredentialUsername(config: S3SyncConfig): string {
  const digest = createHash("sha256");
  digest.update(config.endpoint);
  digest.update("\0");
  digest.update(config.bucket);
  digest.update("\0");
  digest.update(config.accessKeyId);
  return `s3-${digest.digest("hex")}`;
}

/** 设备同步对象前缀（`load_config` 之外的 commands 不使用，保留给调用方）。 */
export function deviceObjectPrefix(config: S3SyncConfig): string {
  return config.prefix.length === 0
    ? "flowlet/v1/devices/"
    : `${config.prefix}/flowlet/v1/devices/`;
}

/** 账号工作区目录对象 key（Rust `workspace_accounts_key`）。 */
export function workspaceAccountsKey(config: S3SyncConfig): string {
  return config.prefix.length === 0
    ? "flowlet/v1/workspace/channel-accounts.enc"
    : `${config.prefix}/flowlet/v1/workspace/channel-accounts.enc`;
}

/** 账号工作区对象前缀（Rust `workspace_prefix`）。 */
export function workspacePrefix(config: S3SyncConfig): string {
  return config.prefix.length === 0
    ? "flowlet/v1/workspace/"
    : `${config.prefix}/flowlet/v1/workspace/`;
}

function supportsConditionalPut(config: S3SyncConfig): boolean {
  try {
    return !new URL(config.endpoint).hostname.toLowerCase().endsWith(".aliyuncs.com");
  } catch {
    return true;
  }
}

function encodeKeyPath(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

interface SignedRequest {
  url: URL;
  headers: Record<string, string>;
}

/**
 * AWS SigV4 头签名。签名头固定为 host / x-amz-content-sha256 / x-amz-date
 * （以及 PUT 的 content-type），其余头不参与签名但仍会发送。
 */
function signRequest(
  config: S3SyncConfig,
  secret: string,
  method: string,
  url: URL,
  payload: Uint8Array | null,
  extraHeaders: Record<string, string>,
): SignedRequest {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = payload === null ? EMPTY_PAYLOAD_SHA256 : sha256Hex(payload);
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...extraHeaders,
  };
  const signedHeaderNames = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${String(headers[name]).trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([key, value]) => [encodeQueryValue(key), encodeQueryValue(value)] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const canonicalUri = url.pathname.length === 0 ? "/" : url.pathname;
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${secret}`, dateStamp), config.region), "s3"),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return {
    url,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlElement(body: string, name: string): string | null {
  const startTag = `<${name}>`;
  const endTag = `</${name}>`;
  const start = body.indexOf(startTag);
  if (start < 0) return null;
  const valueStart = start + startTag.length;
  const end = body.indexOf(endTag, valueStart);
  if (end < 0) return null;
  const value = body.slice(valueStart, end).trim();
  return value.length > 0 && value.length <= 256 ? decodeXmlEntities(value) : null;
}

function s3ErrorDetail(body: string): string {
  const code = xmlElement(body, "Code");
  const requestId = xmlElement(body, "RequestId");
  if (code !== null && requestId !== null) {
    return `，Code: ${code}，RequestId: ${requestId}`;
  }
  if (code !== null) return `，Code: ${code}`;
  if (requestId !== null) return `，RequestId: ${requestId}`;
  return "";
}

function objectUrl(config: S3SyncConfig, key?: string): URL {
  const endpoint = new URL(config.endpoint);
  let base: URL;
  if (config.pathStyle) {
    base = new URL(config.endpoint);
    base.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/${encodeURIComponent(config.bucket)}`;
  } else {
    base = new URL(config.endpoint);
    base.hostname = `${config.bucket}.${endpoint.hostname}`;
    base.port = endpoint.port;
  }
  if (key === undefined) return base;
  const encodedKey = encodeKeyPath(key);
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/${encodedKey}`;
  return base;
}

async function checkedResponse(response: Response, action: string): Promise<Response> {
  if (response.ok) return response;
  const body = await response.text().catch(() => "");
  throw new Error(`${action}失败（HTTP ${response.status}${s3ErrorDetail(body)}）`);
}

/** Rust `S3Store`：对象列举 / 读取 / 写入 / ETag 探测 / 删除。 */
export class S3Store {
  #config: S3SyncConfig;
  #secret: string;
  #conditionalPut: boolean;

  constructor(config: S3SyncConfig, secret: string) {
    if (secret.length === 0) throw new Error("S3 Secret Access Key 不能为空");
    this.#config = config;
    this.#secret = secret;
    this.#conditionalPut = supportsConditionalPut(config);
  }

  async #send(
    method: string,
    url: URL,
    options: { body?: Uint8Array | null; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const payload = options.body ?? null;
    const extraHeaders: Record<string, string> = { ...(options.headers ?? {}) };
    const signed = signRequest(this.#config, this.#secret, method, url, payload, extraHeaders);
    return fetch(signed.url, {
      method,
      headers: signed.headers,
      body: payload === null ? undefined : new Uint8Array(payload),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  async headBucket(): Promise<void> {
    const response = await this.#send("HEAD", objectUrl(this.#config)).catch((error) => {
      throw new Error(`检查 Bucket时网络请求失败：${errorText(error)}`);
    });
    await checkedResponse(response, "检查 Bucket");
  }

  async list(prefix: string): Promise<RemoteObject[]> {
    const objects: RemoteObject[] = [];
    let continuation: string | null = null;
    for (;;) {
      const url = objectUrl(this.#config);
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", prefix);
      if (continuation !== null) url.searchParams.set("continuation-token", continuation);
      let response: Response;
      try {
        response = await this.#send("GET", url);
      } catch (error) {
        throw new Error(`列举对象时网络请求失败：${errorText(error)}`);
      }
      const checked = await checkedResponse(response, "列举对象");
      const body = await checked.text();
      const parsed = parseListObjectsV2(body);
      objects.push(...parsed.objects);
      continuation = parsed.nextContinuationToken;
      if (continuation === null) break;
    }
    return objects;
  }

  async get(key: string): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await this.#send("GET", objectUrl(this.#config, key));
    } catch (error) {
      throw new Error(`下载对象时网络请求失败：${errorText(error)}`);
    }
    const checked = await checkedResponse(response, "下载对象");
    const declaredLength = Number(checked.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_REMOTE_OBJECT_BYTES) {
      throw new Error("远端设备快照超过 64 MB 限制");
    }
    const bytes = new Uint8Array(await checked.arrayBuffer());
    if (bytes.byteLength > MAX_REMOTE_OBJECT_BYTES) {
      throw new Error("远端设备快照超过 64 MB 限制");
    }
    return bytes;
  }

  async headEtag(key: string): Promise<string | null> {
    let response: Response;
    try {
      response = await this.#send("HEAD", objectUrl(this.#config, key));
    } catch (error) {
      throw new Error(`读取对象元信息时网络请求失败：${errorText(error)}`);
    }
    const checked = await checkedResponse(response, "读取对象元信息");
    return checked.headers.get("etag");
  }

  async put(key: string, body: Uint8Array, ifMatch?: string | null): Promise<string | null> {
    const conditional = ifMatch != null && this.#conditionalPut ? ifMatch : null;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (conditional !== null) headers["if-match"] = conditional;
    let response: Response;
    try {
      response = await this.#send("PUT", objectUrl(this.#config, key), { body, headers });
    } catch (error) {
      throw new Error(`上传 S3 设备快照时网络请求失败：${errorText(error)}`);
    }
    if (response.status === 412) {
      throw new Error("远端设备快照已被其他写入者修改，可能存在重复设备 ID");
    }
    const checked = await checkedResponse(response, "上传设备快照");
    return checked.headers.get("etag");
  }

  async delete(key: string): Promise<void> {
    let response: Response;
    try {
      response = await this.#send("DELETE", objectUrl(this.#config, key));
    } catch (error) {
      throw new Error(`删除测试对象时网络请求失败：${errorText(error)}`);
    }
    await checkedResponse(response, "删除测试对象");
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 解析 ListObjectsV2 XML（只提取 key / etag / size / 续传 token）。 */
export function parseListObjectsV2(body: string): {
  objects: RemoteObject[];
  nextContinuationToken: string | null;
} {
  const objects: RemoteObject[] = [];
  const contentsPattern = /<Contents>([\s\S]*?)<\/Contents>/g;
  for (const match of body.matchAll(contentsPattern)) {
    const block = match[1] ?? "";
    const key = xmlElement(block, "Key");
    if (key === null) continue;
    const etag = xmlElement(block, "ETag") ?? "";
    const size = Number(xmlElement(block, "Size") ?? 0);
    objects.push({ key, etag: etag.replace(/^"|"$/g, ""), size: Number.isFinite(size) ? size : 0 });
  }
  return { objects, nextContinuationToken: xmlElement(body, "NextContinuationToken") };
}

/** 供测试/诊断：当前签名 TTL 常量（秒）。 */
export const SIGNED_URL_TTL = SIGNED_URL_TTL_SECONDS;