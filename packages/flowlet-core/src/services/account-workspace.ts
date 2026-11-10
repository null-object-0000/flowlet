// 桌面账号工作区（S3 工作区同步）领域服务。
//
// 权威实现：`src-tauri/src/core/account_workspace_sync.rs` 与 `src-tauri/src/core/device_sync.rs`
// 的 S3 配置/密钥部分。命令层在 `desktop/account-workspace.ts`，本模块只做纯逻辑：
// ChaCha20-Poly1305 密文包、HMAC 凭据指纹、目录比对合并，以及通过注入的宿主桥读写
// 系统凭据库（`keyring.*`）与 S3 对象。
//
// 关键契约（不允许变化，否则与 Rust 版互不兼容）：
// - 密钥：32 字节，base64 存在 OS 凭据库，service `Flowlet Account Workspace`，
//   username = S3 配置的 `credential_username`；
// - 密文信封：`{ format: "flowlet-account-workspace", version: 1, nonce: base64(12B),
//   ciphertext: base64(ChaCha20-Poly1305 密文 + 16B tag) }`，AAD =
//   `flowlet-account-workspace-v1`，JSON 字段 camelCase；
// - 凭据指纹：HMAC-SHA256(workspace key, channelId.trim() + "\0" + apiKey.trim()) 的 hex；
// - 远端对象 key：`<prefix>/flowlet/v1/workspace/channel-accounts.enc`。
import { createCipheriv, createDecipheriv, createHmac, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { JsonRow } from "../types.ts";
import { localAccountIdForWorkspace } from "../storage/config.ts";
import {
  S3Store,
  parseS3ConfigInput,
  s3CredentialUsername,
  workspaceAccountsKey,
  workspacePrefix,
  type S3SyncConfig,
  type S3SyncConfigInput,
} from "./s3.ts";

export const WORKSPACE_KEYRING_SERVICE = "Flowlet Account Workspace";
export const DEVICE_SYNC_KEYRING_SERVICE = "Flowlet Device Sync";
export const WORKSPACE_ETAG_META_KEY = "account_workspace_etag_v1";
export const DEVICE_SYNC_CONFIG_META_KEY = "device_sync_s3_config_v1";
const ENVELOPE_AAD = Buffer.from("flowlet-account-workspace-v1", "utf8");
const CATALOG_VERSION = 1;
const ENVELOPE_FORMAT = "flowlet-account-workspace";
const DESKTOP_PACKAGE_FORMAT = "flowlet-desktop-account-workspace";

/** 命令层注入的宿主能力（`ctx.desktop.host`）。 */
export interface KeyringHost {
  invoke<T = unknown>(channel: string, payload?: JsonRow): Promise<T>;
}

export interface AccountWorkspaceStorage {
  getAppMeta(key: string): string | null;
  setAppMeta(key: string, value: string): void;
  listChannelAccounts(): JsonRow[];
  saveChannelAccounts(accounts: JsonRow[]): JsonRow[];
  withDatabase<T>(fn: (db: DatabaseSync) => T): T;
}

export interface AccountWorkspaceContext {
  storage: AccountWorkspaceStorage;
  host: KeyringHost;
}

/** Rust `WorkspaceChannelAccount`（camelCase）。 */
export interface WorkspaceChannelAccount {
  id: string;
  channelId: string;
  name: string;
  apiKey: string;
  managementKey: string | null;
  defaultOpenaiBaseUrl: string | null;
  defaultAnthropicBaseUrl: string | null;
  credentialFingerprint: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Rust `AccountWorkspaceCatalog`（camelCase）。 */
export interface AccountWorkspaceCatalog {
  version: number;
  revision: number;
  updatedAt: string;
  accounts: WorkspaceChannelAccount[];
}

/** Rust `AccountWorkspaceSyncResult`（camelCase）。 */
export interface AccountWorkspaceSyncResult {
  revision: number;
  accountCount: number;
  linkedAccounts: number;
  createdLocalAccounts: number;
  uploaded: boolean;
}

/** Rust `AccountWorkspaceStatus`（camelCase）。 */
export interface AccountWorkspaceStatus {
  enabled: boolean;
  linkedAccounts: number;
}

/** Rust `DesktopAccountWorkspacePackage`（camelCase）。 */
export interface DesktopAccountWorkspacePackage {
  format: string;
  version: number;
  s3: S3SyncConfigInput;
  accountWorkspaceKey: string;
}

interface EncryptedCatalogEnvelope {
  format: string;
  version: number;
  nonce: string;
  ciphertext: string;
}

// ─── 凭据库 ──────────────────────────────────────────────────────────────────

async function keyringGet(
  ctx: AccountWorkspaceContext,
  service: string,
  username: string,
): Promise<string | null> {
  const result = await ctx.host.invoke<{ secret?: string | null }>("keyring.get", {
    service,
    username,
  });
  return typeof result?.secret === "string" ? result.secret : null;
}

async function keyringSet(
  ctx: AccountWorkspaceContext,
  service: string,
  username: string,
  secret: string,
): Promise<void> {
  await ctx.host.invoke("keyring.set", { service, username, secret });
}

async function keyringDelete(
  ctx: AccountWorkspaceContext,
  service: string,
  username: string,
): Promise<void> {
  await ctx.host.invoke("keyring.delete", { service, username });
}

// ─── S3 配置（device_sync::load_config / export_connection_config / save_config） ──

function parseStoredS3Config(raw: string): S3SyncConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("S3 同步配置格式无效");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("S3 同步配置格式无效");
  }
  const row = parsed as JsonRow;
  if (
    typeof row.endpoint !== "string" ||
    typeof row.region !== "string" ||
    typeof row.bucket !== "string" ||
    typeof row.prefix !== "string" ||
    typeof row.accessKeyId !== "string" ||
    typeof row.pathStyle !== "boolean"
  ) {
    throw new Error("S3 同步配置格式无效");
  }
  return {
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    prefix: row.prefix,
    accessKeyId: row.accessKeyId,
    pathStyle: row.pathStyle,
  };
}

/** Rust `device_sync::load_config`：未配置返回 null，格式损坏报错。 */
export function loadS3Config(storage: AccountWorkspaceStorage): S3SyncConfig | null {
  const raw = storage.getAppMeta(DEVICE_SYNC_CONFIG_META_KEY);
  if (raw === null) return null;
  return parseStoredS3Config(raw);
}

async function readS3Secret(
  ctx: AccountWorkspaceContext,
  config: S3SyncConfig,
): Promise<string> {
  const secret = await keyringGet(ctx, DEVICE_SYNC_KEYRING_SERVICE, s3CredentialUsername(config));
  if (secret === null || secret.length === 0) {
    throw new Error("未找到 S3 Secret Access Key，请重新填写并保存");
  }
  return secret;
}

/** Rust `device_sync::export_connection_config`（含 Secret，camelCase）。 */
export async function exportS3ConnectionConfig(
  ctx: AccountWorkspaceContext,
  config: S3SyncConfig,
): Promise<S3SyncConfigInput> {
  return {
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    prefix: config.prefix,
    accessKeyId: config.accessKeyId,
    secretAccessKey: await readS3Secret(ctx, config),
    pathStyle: config.pathStyle,
  };
}

/** Rust `device_sync::save_config`：Secret 先写凭据库，再落 app_meta；旧身份凭据删除。 */
export async function saveS3Config(
  ctx: AccountWorkspaceContext,
  input: S3SyncConfigInput,
): Promise<S3SyncConfig> {
  const previous = loadS3Config(ctx.storage);
  const config = parseS3ConfigInput(input);
  const providedSecret =
    typeof input.secretAccessKey === "string" && input.secretAccessKey.trim().length > 0
      ? input.secretAccessKey.trim()
      : null;
  if (providedSecret !== null) {
    await keyringSet(
      ctx,
      DEVICE_SYNC_KEYRING_SERVICE,
      s3CredentialUsername(config),
      providedSecret,
    );
  } else {
    await readS3Secret(ctx, config);
  }
  ctx.storage.setAppMeta(DEVICE_SYNC_CONFIG_META_KEY, JSON.stringify(config));
  if (previous !== null && s3CredentialUsername(previous) !== s3CredentialUsername(config)) {
    await keyringDelete(ctx, DEVICE_SYNC_KEYRING_SERVICE, s3CredentialUsername(previous)).catch(
      () => undefined,
    );
  }
  return config;
}

// ─── 工作区密钥 ──────────────────────────────────────────────────────────────

function workspaceEntryContext(config: S3SyncConfig): { service: string; username: string } {
  return { service: WORKSPACE_KEYRING_SERVICE, username: s3CredentialUsername(config) };
}

/** Rust `save_workspace_key`：base64(32B) 写 OS 凭据库。 */
export async function saveWorkspaceKey(
  ctx: AccountWorkspaceContext,
  config: S3SyncConfig,
  key: Buffer,
): Promise<void> {
  await keyringSet(ctx, WORKSPACE_KEYRING_SERVICE, workspaceEntryContext(config).username, key.toString("base64"));
}

/** Rust `read_workspace_key`：缺失/格式错误/长度错误的文案逐条对齐。 */
export async function readWorkspaceKey(
  ctx: AccountWorkspaceContext,
  config: S3SyncConfig,
): Promise<Buffer> {
  const encoded = await keyringGet(ctx, WORKSPACE_KEYRING_SERVICE, workspaceEntryContext(config).username);
  if (encoded === null) {
    throw new Error("缺少账号工作区密钥，请导入桌面端工作区接入包");
  }
  const bytes = Buffer.from(encoded, "base64");
  // Buffer.from 对非法 base64 宽容，先做一次严格校验（与 Rust BASE64.decode 对齐）。
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded.replace(/\s+/g, "")) || bytes.length === 0) {
    throw new Error("账号工作区密钥格式无效");
  }
  if (bytes.length !== 32) {
    throw new Error("账号工作区密钥长度无效");
  }
  return bytes;
}

export async function isEnabled(
  ctx: AccountWorkspaceContext,
  config: S3SyncConfig | null,
): Promise<boolean> {
  if (config === null) return false;
  try {
    await readWorkspaceKey(ctx, config);
    return true;
  } catch {
    return false;
  }
}

/** Rust `generate_workspace_key`：两个 UUID v4 的字节拼成 32 字节。 */
export function generateWorkspaceKey(): Buffer {
  const first = Buffer.from(randomUUID().replace(/-/g, ""), "hex");
  const second = Buffer.from(randomUUID().replace(/-/g, ""), "hex");
  return Buffer.concat([first, second]);
}

// ─── 加密 / 指纹 ─────────────────────────────────────────────────────────────

/** Rust `credential_fingerprint`：HMAC-SHA256(key, channel_id \0 api_key) hex。 */
export function credentialFingerprint(key: Buffer, channelId: string, apiKey: string): string {
  return createHmac("sha256", key)
    .update(channelId.trim(), "utf8")
    .update("\0", "utf8")
    .update(apiKey.trim(), "utf8")
    .digest("hex");
}

/** Rust `encrypt_catalog`：ChaCha20-Poly1305，12B nonce，AAD 固定，密文后接 tag。 */
export function encryptCatalog(catalog: AccountWorkspaceCatalog, key: Buffer): Uint8Array {
  const nonce = Buffer.from(randomUUID().replace(/-/g, ""), "hex").subarray(0, 12);
  const plaintext = Buffer.from(JSON.stringify(catalog), "utf8");
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  cipher.setAAD(ENVELOPE_AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope: EncryptedCatalogEnvelope = {
    format: ENVELOPE_FORMAT,
    version: CATALOG_VERSION,
    nonce: nonce.toString("base64"),
    ciphertext: Buffer.concat([ciphertext, tag]).toString("base64"),
  };
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

/** Rust `decrypt_catalog`。 */
export function decryptCatalog(bytes: Uint8Array, key: Buffer): AccountWorkspaceCatalog {
  let envelope: EncryptedCatalogEnvelope;
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid envelope");
    }
    envelope = parsed as EncryptedCatalogEnvelope;
  } catch {
    throw new Error("账号工作区密文格式无效");
  }
  if (envelope.format !== ENVELOPE_FORMAT || envelope.version !== CATALOG_VERSION) {
    throw new Error("账号工作区版本不受支持");
  }
  const nonce = Buffer.from(envelope.nonce ?? "", "base64");
  if (nonce.length !== 12) {
    throw new Error("账号工作区 nonce 长度无效");
  }
  const payload = Buffer.from(envelope.ciphertext ?? "", "base64");
  if (payload.length < 16) {
    throw new Error("账号工作区密文无效");
  }
  const ciphertext = payload.subarray(0, payload.length - 16);
  const tag = payload.subarray(payload.length - 16);
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
    decipher.setAAD(ENVELOPE_AAD);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("账号工作区解密失败，请确认接入包来自同一工作区");
  }
  let catalog: AccountWorkspaceCatalog;
  try {
    catalog = JSON.parse(plaintext.toString("utf8")) as AccountWorkspaceCatalog;
  } catch {
    throw new Error("账号工作区内容格式无效");
  }
  if (catalog === null || typeof catalog !== "object" || !Array.isArray(catalog.accounts)) {
    throw new Error("账号工作区内容格式无效");
  }
  if (catalog.version !== CATALOG_VERSION) {
    throw new Error("账号工作区内容版本不受支持");
  }
  return catalog;
}

// ─── 目录构建 / 合并 ────────────────────────────────────────────────────────

function rfc3339Now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00").replace("Z", "+00:00");
}

function workspaceRecord(
  account: JsonRow,
  workspaceId: string,
  key: Buffer,
): WorkspaceChannelAccount {
  const channelId = String(account.channel_id ?? "");
  const apiKey = String(account.api_key ?? "");
  return {
    id: workspaceId,
    channelId,
    name: String(account.name ?? ""),
    apiKey,
    managementKey: optionalString(account.management_key),
    defaultOpenaiBaseUrl: optionalString(account.workspace_default_base_url),
    defaultAnthropicBaseUrl: optionalString(account.workspace_default_anthropic_base_url),
    credentialFingerprint: credentialFingerprint(key, channelId, apiKey),
    archived: false,
    createdAt: String(account.created_at ?? ""),
    updatedAt: String(account.updated_at ?? ""),
  };
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Rust `apply_catalog`：把远端目录合并回本机账号表。
 * 返回 [linked, created, catalogChanged]。
 */
export function applyCatalog(
  storage: AccountWorkspaceStorage,
  catalog: AccountWorkspaceCatalog,
  key: Buffer,
): [number, number, boolean] {
  const local = storage.listChannelAccounts().map((account) => ({ ...account }));
  let linked = 0;
  let created = 0;
  let catalogChanged = false;
  const archivedLocalIds = new Set<string>();

  for (const account of local) {
    const channelId = String(account.channel_id ?? "");
    const apiKey = String(account.api_key ?? "");
    const fingerprint = credentialFingerprint(key, channelId, apiKey);
    const workspaceAccountId = optionalString(account.workspace_account_id);
    let index = -1;
    if (workspaceAccountId !== null) {
      index = catalog.accounts.findIndex((record) => record.id === workspaceAccountId);
    }
    if (index < 0) {
      index = catalog.accounts.findIndex(
        (record) => record.channelId === channelId && record.credentialFingerprint === fingerprint,
      );
    }
    if (index >= 0) {
      const record = catalog.accounts[index];
      if (record.archived) {
        archivedLocalIds.add(String(account.id));
        continue;
      }
      account.workspace_account_id = record.id;
      account.name = record.name;
      account.api_key = record.apiKey;
      account.management_key = record.managementKey;
      account.workspace_default_base_url = record.defaultOpenaiBaseUrl;
      account.workspace_default_anthropic_base_url = record.defaultAnthropicBaseUrl;
      linked += 1;
    } else {
      const workspaceId = catalog.accounts.some((record) => record.id === String(account.id))
        ? `account-${randomUUID()}`
        : String(account.id);
      account.workspace_account_id = workspaceId;
      catalog.accounts.push(workspaceRecord(account, workspaceId, key));
      linked += 1;
      catalogChanged = true;
    }
  }
  const remaining = local.filter((account) => !archivedLocalIds.has(String(account.id)));

  let nextPriority =
    remaining.reduce((max, account) => Math.max(max, Number(account.priority ?? 0)), -1) + 1;
  for (const record of catalog.accounts.filter((entry) => !entry.archived)) {
    if (
      remaining.some((account) => optionalString(account.workspace_account_id) === record.id)
    ) {
      continue;
    }
    const mapped = storage.withDatabase((db: DatabaseSync) =>
      localAccountIdForWorkspace(db, record.id),
    );
    remaining.push({
      use_upstream_proxy: false,
      id: mapped ?? record.id,
      workspace_account_id: record.id,
      channel_id: record.channelId,
      name: record.name,
      api_key: record.apiKey,
      management_key: record.managementKey,
      enabled: false,
      priority: nextPriority,
      remark: null,
      resource_mode: null,
      resource_sync_mode: "manual",
      base_url_override: null,
      anthropic_base_url_override: null,
      workspace_default_base_url: record.defaultOpenaiBaseUrl,
      workspace_default_anthropic_base_url: record.defaultAnthropicBaseUrl,
      last_used_at: null,
      last_error: null,
      credential_status: "healthy",
      synced_models: null,
      models_synced_at: null,
      exposed_models: null,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    });
    nextPriority += 1;
    created += 1;
  }
  storage.saveChannelAccounts(remaining);
  return [linked, created, catalogChanged];
}

// ─── 对外流程 ────────────────────────────────────────────────────────────────

/** Rust `status`：enabled = 已配置 S3 且可读取工作区密钥。 */
export async function status(ctx: AccountWorkspaceContext): Promise<AccountWorkspaceStatus> {
  const config = loadS3Config(ctx.storage);
  const linkedAccounts = ctx.storage
    .listChannelAccounts()
    .filter((account) => optionalString(account.workspace_account_id) !== null).length;
  return { enabled: await isEnabled(ctx, config), linkedAccounts };
}

/** Rust `export_desktop_package`。 */
export async function exportDesktopPackage(
  ctx: AccountWorkspaceContext,
): Promise<DesktopAccountWorkspacePackage> {
  const config = loadS3Config(ctx.storage);
  if (config === null) throw new Error("尚未配置 S3 同步");
  const key = await readWorkspaceKey(ctx, config);
  return {
    format: DESKTOP_PACKAGE_FORMAT,
    version: CATALOG_VERSION,
    s3: await exportS3ConnectionConfig(ctx, config),
    accountWorkspaceKey: key.toString("base64"),
  };
}

async function openStore(
  ctx: AccountWorkspaceContext,
): Promise<{ config: S3SyncConfig; store: S3Store; key: Buffer }> {
  const config = loadS3Config(ctx.storage);
  if (config === null) throw new Error("尚未配置 S3 同步");
  const secret = await readS3Secret(ctx, config);
  const key = await readWorkspaceKey(ctx, config);
  return { config, store: new S3Store(config, secret), key };
}

/** Rust `initialize`（去掉 background job 记录）：首次创建工作区目录并上传。 */
export async function initialize(
  ctx: AccountWorkspaceContext,
): Promise<AccountWorkspaceSyncResult> {
  const config = loadS3Config(ctx.storage);
  if (config === null) throw new Error("尚未配置 S3 同步");
  const secret = await readS3Secret(ctx, config);
  const store = new S3Store(config, secret);
  const objectKey = workspaceAccountsKey(config);
  const existing = await store.list(workspacePrefix(config));
  if (existing.some((object) => object.key === objectKey)) {
    throw new Error("远端已存在账号工作区，请导入桌面端工作区接入包后加入");
  }
  const key = generateWorkspaceKey();
  const now = rfc3339Now();
  const local = ctx.storage.listChannelAccounts().map((account) => ({ ...account }));
  const catalog: AccountWorkspaceCatalog = {
    version: CATALOG_VERSION,
    revision: 1,
    updatedAt: now,
    accounts: [],
  };
  for (const account of local) {
    const workspaceId =
      optionalString(account.workspace_account_id) ?? String(account.id);
    account.workspace_account_id = workspaceId;
    catalog.accounts.push(workspaceRecord(account, workspaceId, key));
  }
  await saveWorkspaceKey(ctx, config, key);
  let etag: string | null;
  try {
    etag = await store.put(objectKey, encryptCatalog(catalog, key), null);
    if (etag === null) etag = await store.headEtag(objectKey);
  } catch (error) {
    await keyringDelete(
      ctx,
      WORKSPACE_KEYRING_SERVICE,
      workspaceEntryContext(config).username,
    ).catch(() => undefined);
    throw error;
  }
  ctx.storage.saveChannelAccounts(local);
  if (etag !== null) ctx.storage.setAppMeta(WORKSPACE_ETAG_META_KEY, etag);
  return {
    revision: catalog.revision,
    accountCount: catalog.accounts.length,
    linkedAccounts: local.length,
    createdLocalAccounts: 0,
    uploaded: true,
  };
}

/** Rust `sync`（去掉 background job 记录）。 */
export async function sync(ctx: AccountWorkspaceContext): Promise<AccountWorkspaceSyncResult> {
  const { config, store, key } = await openStore(ctx);
  const objectKey = workspaceAccountsKey(config);
  const remoteEtag = await store.headEtag(objectKey);
  const bytes = await store.get(objectKey);
  const catalog = decryptCatalog(bytes, key);
  const [linked, created, changed] = applyCatalog(ctx.storage, catalog, key);
  let uploaded = false;
  if (changed) {
    catalog.revision += 1;
    catalog.updatedAt = rfc3339Now();
    const uploadedEtag =
      (await store.put(objectKey, encryptCatalog(catalog, key), remoteEtag)) ??
      (await store.headEtag(objectKey));
    if (uploadedEtag !== null) ctx.storage.setAppMeta(WORKSPACE_ETAG_META_KEY, uploadedEtag);
    uploaded = true;
  } else if (remoteEtag !== null) {
    ctx.storage.setAppMeta(WORKSPACE_ETAG_META_KEY, remoteEtag);
  }
  return {
    revision: catalog.revision,
    accountCount: catalog.accounts.length,
    linkedAccounts: linked,
    createdLocalAccounts: created,
    uploaded,
  };
}

/** Rust `import_desktop_package`：校验接入包、验证远端密文、写入配置与密钥。 */
export async function importDesktopPackage(
  ctx: AccountWorkspaceContext,
  pkg: DesktopAccountWorkspacePackage,
): Promise<void> {
  if (pkg.format !== DESKTOP_PACKAGE_FORMAT || pkg.version !== CATALOG_VERSION) {
    throw new Error("桌面端账号工作区接入包版本不受支持");
  }
  const keyText = typeof pkg.accountWorkspaceKey === "string" ? pkg.accountWorkspaceKey.trim() : "";
  const key = Buffer.from(keyText, "base64");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(keyText) || key.length === 0) {
    throw new Error("桌面端账号工作区密钥格式无效");
  }
  if (key.length !== 32) {
    throw new Error("桌面端账号工作区密钥长度无效");
  }
  const config = parseS3ConfigInput(pkg.s3);
  const secret =
    typeof pkg.s3.secretAccessKey === "string" ? pkg.s3.secretAccessKey.trim() : "";
  if (secret.length === 0) {
    throw new Error("桌面端账号工作区接入包缺少 S3 Secret Access Key");
  }
  const store = new S3Store(config, secret);
  const encrypted = await store.get(workspaceAccountsKey(config));
  decryptCatalog(encrypted, key);
  await saveS3Config(ctx, { ...pkg.s3, secretAccessKey: secret });
  await saveWorkspaceKey(ctx, config, key);
}

/** 生成一次性描述用的错误文本（保持异常链可诊断）。 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}