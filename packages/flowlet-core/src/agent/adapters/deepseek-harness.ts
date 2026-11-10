// DeepSeek Harness 全局配置 Adapter。
//
// 权威实现：`src-tauri/src/core/agent_global_config/adapters/deepseek_harness.rs`。
//
// 受管内容：
// - `~/.dsh/settings.yaml`：`llm-pi-ai.providers.flowlet` 与 `agent-default-model.*`；
// - `~/.dsh/.credentials.yaml`：`refs.FLOWLET_CLIENT_TOKEN`（新版）或根级同名键（旧版）；
// - 每个 base-bundle Profile 的 `cordis.patch.yml`：可选「精确会话关联」桥与 MCP 服务器块；
// - 可选受管插件文件 `.flowlet/flowlet-session-bridge.mjs`。
//
// YAML 使用 Document API 保留注释；受管块（session bridge / MCP）沿用 Rust 的
// flowlet-managed 标记整块替换/移除；写者锁按 DSH 官方 `<file>.lock` 协议实现。
import * as requireFs from "node:fs";
import path from "node:path";

import {
  directoryExists,
  errorText,
  fileExists,
  managedTextFileMatches,
  readText,
  readTextOrNull,
  removeFileIfExists,
  textFileBytes,
  writeFilesTransactionally,
  writeJsonFile,
} from "../fs.ts";
import {
  isJsonObject,
  readOptionalJsonObject,
} from "../jsonc.ts";
import { parse as parseYamlDocumentValue } from "yaml";
import { isKnownCatalogModel, type McpServerSpecInput } from "../models.ts";
import { displayPath, normalizeUrl } from "../paths.ts";
import { DSH_SESSION_BRIDGE_SOURCE } from "../resources.ts";
import { backedUpValue, buildReport, type AgentGlobalConfigReport, type BackedUpValue } from "../report.ts";
import { patchYamlEntries, readYamlText, readYamlValue, yamlAt, yamlQuote } from "../yaml.ts";

const BACKUP_VERSION = 1;
const FLOWLET_DIR = ".flowlet";
const PROVIDER_ID = "flowlet";
const TOKEN_REF = "FLOWLET_CLIENT_TOKEN";
const CREDENTIAL_REFS = "refs";
const LLM_NAMESPACE = "llm-pi-ai";
const DEFAULT_MODEL_NAMESPACE = "agent-default-model";
const LOCK_TIMEOUT_MS = 2000;
const SESSION_BRIDGE_DIR = ".flowlet";
const SESSION_BRIDGE_FILE = "flowlet-session-bridge.mjs";
const SESSION_BRIDGE_START = "# flowlet-managed:start deepseek-harness-session-bridge";
const SESSION_BRIDGE_END = "# flowlet-managed:end deepseek-harness-session-bridge";
const MCP_SERVERS_START = "# flowlet-managed:start deepseek-harness-mcp-servers";
const MCP_SERVERS_END = "# flowlet-managed:end deepseek-harness-mcp-servers";
const MCP_CLIENT_PACKAGE = "@deepseek-ai/dsh-mcp-client";
const MCP_MAX_SERVER_NAME = 32;

export interface BackedUpText {
  present: boolean;
  content: string;
}

export interface DshProfileBackup {
  profile: string;
  patch: BackedUpText;
  plugin: BackedUpText;
}

export interface DshConfigBackup {
  version: number;
  agent_id: string;
  provider: BackedUpValue;
  default_provider: BackedUpValue;
  default_model: BackedUpValue;
  credential: BackedUpValue;
  profiles: DshProfileBackup[];
}

interface ManagedSnapshot {
  provider: BackedUpValue;
  default_provider: BackedUpValue;
  default_model: BackedUpValue;
  credential: BackedUpValue;
}

export interface DshProfile {
  profile: string;
  root: string;
}

export function dshBackupPath(home: string): string {
  return path.join(home, FLOWLET_DIR, "deepseek-harness-global-config-backup.json");
}

/** 读取 `~/.dsh/profiles/*` 中声明了 `@deepseek-ai/dsh-base` bundle 的 Profile。 */
export function dshProfiles(home: string): DshProfile[] {
  const root = path.join(home, "profiles");
  if (!directoryExists(root)) return [];
  const profiles: DshProfile[] = [];
  for (const entry of requireFs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const profileRoot = path.join(root, entry.name);
    if (!profileUsesBaseBundle(profileRoot)) continue;
    profiles.push({ profile: entry.name, root: profileRoot });
  }
  profiles.sort((left, right) => (left.profile < right.profile ? -1 : left.profile > right.profile ? 1 : 0));
  return profiles;
}

function profileUsesBaseBundle(root: string): boolean {
  const text = readTextOrNull(path.join(root, "package.json"));
  if (text === null) return false;
  try {
    const value: unknown = JSON.parse(text);
    if (!isJsonObject(value)) return false;
    const dsh = value.dsh;
    if (!isJsonObject(dsh)) return false;
    const profile = dsh.profile;
    if (!isJsonObject(profile)) return false;
    const bundles = profile.bundles;
    return Array.isArray(bundles) && bundles.some((bundle) => bundle === "@deepseek-ai/dsh-base");
  } catch {
    return false;
  }
}

function profilePaths(root: string): { patch: string; plugin: string } {
  return {
    patch: path.join(root, "cordis.patch.yml"),
    plugin: path.join(root, SESSION_BRIDGE_DIR, SESSION_BRIDGE_FILE),
  };
}

function readCredentialValue(credentialsPath: string): string | null {
  const credentials = readYamlValue(credentialsPath);
  const nested = yamlAt(credentials, [CREDENTIAL_REFS, TOKEN_REF]);
  const flat = yamlAt(credentials, [TOKEN_REF]);
  const value = nested ?? flat;
  return typeof value === "string" && value !== "" ? value : null;
}

function backedUpText(file: string): BackedUpText {
  if (!fileExists(file)) return { present: false, content: "" };
  return { present: true, content: readText(file) };
}

function captureSnapshot(settingsPath: string, credentialsPath: string): ManagedSnapshot {
  const settings = readYamlValue(settingsPath);
  const credentials = readYamlValue(credentialsPath);
  const provider = yamlAt(settings, [LLM_NAMESPACE, "providers", PROVIDER_ID]);
  const defaultProvider = yamlAt(settings, [DEFAULT_MODEL_NAMESPACE, "provider"]);
  const defaultModel = yamlAt(settings, [DEFAULT_MODEL_NAMESPACE, "model"]);
  const nestedCredential = yamlAt(credentials, [CREDENTIAL_REFS, TOKEN_REF]);
  const credential = nestedCredential !== undefined ? nestedCredential : yamlAt(credentials, [TOKEN_REF]);
  return {
    provider: backedUpValue(provider),
    default_provider: backedUpValue(defaultProvider),
    default_model: backedUpValue(defaultModel),
    credential: backedUpValue(credential),
  };
}

// ─── DSH 写者锁 ─────────────────────────────────────────────────────────────

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** 按 DSH 官方 `<file>.lock` 协议获取独占锁（创建 + 指数退避，最多 2 秒）。 */
function acquireDshLock(target: string): () => void {
  const parent = path.dirname(target);
  try {
    requireFs.mkdirSync(parent, { recursive: true });
  } catch (error) {
    throw new Error(`创建 DSH 配置目录 ${displayPath(parent)} 失败：${errorText(error)}`);
  }
  const lockPath = `${target}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let delay = 20;
  for (;;) {
    try {
      const descriptor = requireFs.openSync(lockPath, "wx");
      try {
        requireFs.writeSync(descriptor, `${process.pid}\n`);
      } finally {
        requireFs.closeSync(descriptor);
      }
      return () => {
        try {
          requireFs.rmSync(lockPath, { force: true });
        } catch {
          // 释放失败不覆盖主流程错误。
        }
      };
    } catch (error) {
      const code = isJsonObject(error) || error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== "EEXIST") {
        throw new Error(`创建 DSH 配置锁 ${displayPath(lockPath)} 失败：${errorText(error)}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `等待 DSH 配置锁超时：${displayPath(lockPath)}。请稍后重试；Flowlet 不会删除其他进程的锁。`,
        );
      }
      sleepSync(delay);
      delay = Math.min(delay * 2, 200);
    }
  }
}

// ─── cordis.patch.yml 受管块 ────────────────────────────────────────────────

function sessionBridgeBlock(expectedBaseUrl: string): string {
  return `${SESSION_BRIDGE_START}\n- insert:\n    - id: flowlet-session-bridge\n      name: ./.flowlet/${SESSION_BRIDGE_FILE}\n      config:\n        provider: flowlet\n        baseURL: ${normalizeUrl(expectedBaseUrl)}\n${SESSION_BRIDGE_END}`;
}

function preparePatchListForAppend(text: string): string {
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  const content = lines
    .map((line, index) => ({ index, trimmed: line.trim() }))
    .filter((entry) => entry.trimmed !== "" && !entry.trimmed.startsWith("#") && entry.trimmed !== "---");
  if (content.length === 1 && content[0].trimmed === "[]") {
    return lines
      .filter((_line, index) => index !== content[0].index)
      .join("\n")
      .replace(/[\r\n]+$/u, "");
  }
  if (content.length > 0 && content[0].trimmed.startsWith("[")) {
    throw new Error(
      "DSH cordis.patch.yml 使用了无法安全追加的行内数组或文档结束标记，请先改为块级 YAML 数组",
    );
  }
  if (content.some((entry) => entry.trimmed === "...")) {
    throw new Error(
      "DSH cordis.patch.yml 使用了无法安全追加的行内数组或文档结束标记，请先改为块级 YAML 数组",
    );
  }
  return text.replace(/[\r\n]+$/u, "");
}

function ensurePatchListAfterRemoval(text: string): string {
  const hasEntry = text
    .replace(/\r\n/gu, "\n")
    .split("\n")
    .some((line) => {
      const trimmed = line.trim();
      return trimmed !== "" && !trimmed.startsWith("#") && trimmed !== "---";
    });
  if (hasEntry) return text.replace(/[\r\n]+$/u, "");
  const comments = text.replace(/[\r\n]+$/u, "");
  return comments === "" ? "[]" : `${comments}\n[]`;
}

function patchBlock(
  text: string,
  startMarker: string,
  endMarker: string,
  renderedBlock: string,
  incompleteError: string,
): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const normalized = text.replace(/\r\n/gu, "\n");
  const start = normalized.indexOf(startMarker);
  const end = normalized.indexOf(endMarker);
  let unmanaged: string;
  if (start < 0 && end < 0) {
    unmanaged = normalized.replace(/[\r\n]+$/u, "");
  } else if (start >= 0 && end >= 0 && end >= start) {
    const value = `${normalized.slice(0, start)}${normalized.slice(end + endMarker.length)}`;
    unmanaged = value.replace(/\n{3,}/gu, "\n\n").replace(/[\r\n]+$/u, "");
  } else {
    throw new Error(incompleteError);
  }
  unmanaged = preparePatchListForAppend(unmanaged);
  if (unmanaged !== "") unmanaged += "\n\n";
  unmanaged += renderedBlock;
  return unmanaged.replace(/\n/gu, newline);
}

function removeBlock(
  text: string,
  startMarker: string,
  endMarker: string,
  incompleteError: string,
): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const normalized = text.replace(/\r\n/gu, "\n");
  const start = normalized.indexOf(startMarker);
  const end = normalized.indexOf(endMarker);
  if (start < 0 && end < 0) return text;
  if (!(start >= 0 && end >= 0 && end >= start)) throw new Error(incompleteError);
  const value = `${normalized.slice(0, start)}${normalized.slice(end + endMarker.length)}`;
  const output = ensurePatchListAfterRemoval(value.replace(/\n{3,}/gu, "\n\n"));
  return output === "" ? "" : `${output.replace(/\n/gu, newline)}${newline}`;
}

export function patchSessionBridge(text: string, expectedBaseUrl: string): string {
  return patchBlock(
    text,
    SESSION_BRIDGE_START,
    SESSION_BRIDGE_END,
    sessionBridgeBlock(expectedBaseUrl),
    "DSH cordis.patch.yml 中的 Flowlet 会话桥接标记不完整，拒绝覆盖",
  );
}

export function removeSessionBridge(text: string): string {
  return removeBlock(
    text,
    SESSION_BRIDGE_START,
    SESSION_BRIDGE_END,
    "DSH cordis.patch.yml 中的 Flowlet 会话桥接标记不完整，拒绝覆盖",
  );
}

function profileBridgeMatches(root: string, expectedBaseUrl: string): boolean {
  const { patch, plugin } = profilePaths(root);
  if (!fileExists(plugin) || !managedTextFileMatches(plugin, DSH_SESSION_BRIDGE_SOURCE)) return false;
  const text = readTextOrNull(patch);
  if (text === null) return false;
  return (
    text.includes(SESSION_BRIDGE_START) &&
    text.includes(SESSION_BRIDGE_END) &&
    text.includes(`baseURL: ${normalizeUrl(expectedBaseUrl)}`)
  );
}

// ─── MCP 服务器受管块 ───────────────────────────────────────────────────────

function isValidToken(value: string): boolean {
  return value !== "" && /^[A-Za-z0-9_-]+$/u.test(value);
}

export function validateMcpServers(servers: ReadonlyArray<McpServerSpecInput>): void {
  const ids = new Set<string>();
  const serverNames = new Set<string>();
  for (const server of servers) {
    if (!isValidToken(server.id)) {
      throw new Error(`MCP 服务器 id 只能包含字母、数字、下划线和连字符：${server.id}`);
    }
    if (ids.has(server.id)) throw new Error(`MCP 服务器 id 重复：${server.id}`);
    ids.add(server.id);
    if (
      server.serverName === "" ||
      server.serverName.length > MCP_MAX_SERVER_NAME ||
      !isValidToken(server.serverName)
    ) {
      throw new Error(
        `MCP serverName 必须是 1-${MCP_MAX_SERVER_NAME} 位字母、数字、下划线或连字符：${server.serverName}`,
      );
    }
    if (serverNames.has(server.serverName)) {
      throw new Error(`MCP serverName 重复：${server.serverName}`);
    }
    serverNames.add(server.serverName);
    if (server.transport === "stdio") {
      if (server.command === undefined || server.command === "") {
        throw new Error(`MCP 服务器 ${server.id} 使用 stdio 传输时必须提供 command`);
      }
    } else if (server.transport === "streamable-http") {
      if (server.url === undefined || server.url === "") {
        throw new Error(`MCP 服务器 ${server.id} 使用 streamable-http 传输时必须提供 url`);
      }
    } else {
      throw new Error(`MCP 服务器 ${server.id} 的 transport 必须是 stdio 或 streamable-http`);
    }
  }
}

function mcpServersBlock(servers: ReadonlyArray<McpServerSpecInput>): string {
  let block = MCP_SERVERS_START;
  for (const server of servers) {
    block += "\n- insert:\n";
    block += `    - id: mcp-${server.id}\n`;
    block += `      name: '${MCP_CLIENT_PACKAGE}'\n`;
    block += "      config:\n";
    block += `        serverName: ${server.serverName}\n`;
    block += `        transport: ${server.transport}\n`;
    if (server.transport === "stdio") {
      if (server.command !== undefined) {
        block += `        command: ${yamlQuote(server.command)}\n`;
      }
      if (server.args !== undefined && server.args.length > 0) {
        block += `        args: [${server.args.map(yamlQuote).join(", ")}]\n`;
      }
      if (server.cwd !== undefined) {
        block += `        cwd: ${yamlQuote(server.cwd)}\n`;
      }
      if (server.env !== undefined && Object.keys(server.env).length > 0) {
        block += "        env:\n";
        for (const [key, value] of Object.entries(server.env)) {
          block += `          ${yamlQuote(key)}: ${yamlQuote(value)}\n`;
        }
      }
    } else {
      if (server.url !== undefined) {
        block += `        url: ${yamlQuote(server.url)}\n`;
      }
      if (server.headers !== undefined && Object.keys(server.headers).length > 0) {
        block += "        headers:\n";
        for (const [key, value] of Object.entries(server.headers)) {
          block += `          ${yamlQuote(key)}: ${yamlQuote(value)}\n`;
        }
      }
    }
  }
  block += MCP_SERVERS_END;
  return block;
}

function patchMcpServers(text: string, servers: ReadonlyArray<McpServerSpecInput>): string {
  return patchBlock(
    text,
    MCP_SERVERS_START,
    MCP_SERVERS_END,
    mcpServersBlock(servers),
    "DSH cordis.patch.yml 中的 Flowlet MCP 受管标记不完整，拒绝覆盖",
  );
}

function removeMcpServers(text: string): string {
  return removeBlock(
    text,
    MCP_SERVERS_START,
    MCP_SERVERS_END,
    "DSH cordis.patch.yml 中的 Flowlet MCP 受管标记不完整，拒绝覆盖",
  );
}

function stringMapFrom(value: unknown): Record<string, string> {
  if (!isJsonObject(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") result[key] = item;
  }
  return result;
}

function parseYamlValue(text: string): unknown {
  // 受管块内部使用标准 YAML；仅做结构解析，不关心注释保留。
  return parseYamlDocumentValue(text);
}

function parseMcpPlugin(value: unknown): McpServerSpecInput | null {
  if (!isJsonObject(value)) return null;
  const idValue = value.id;
  if (typeof idValue !== "string" || !idValue.startsWith("mcp-")) return null;
  const config = value.config;
  if (!isJsonObject(config)) return null;
  const serverName = config.serverName;
  const transport = config.transport;
  if (typeof serverName !== "string" || typeof transport !== "string") return null;
  const stringField = (key: string): string | undefined => {
    const field = config[key];
    return typeof field === "string" ? field : undefined;
  };
  const args = Array.isArray(config.args)
    ? config.args.filter((item): item is string => typeof item === "string")
    : undefined;
  const spec: McpServerSpecInput = {
    id: idValue.slice("mcp-".length),
    serverName,
    transport,
  };
  const command = stringField("command");
  if (command !== undefined) spec.command = command;
  if (args !== undefined) spec.args = args;
  if (config.env !== undefined) spec.env = stringMapFrom(config.env);
  const cwd = stringField("cwd");
  if (cwd !== undefined) spec.cwd = cwd;
  const url = stringField("url");
  if (url !== undefined) spec.url = url;
  if (config.headers !== undefined) spec.headers = stringMapFrom(config.headers);
  return spec;
}

export function parseMcpServers(text: string): McpServerSpecInput[] {
  const normalized = text.replace(/\r\n/gu, "\n");
  const start = normalized.indexOf(MCP_SERVERS_START);
  if (start < 0) return [];
  const end = normalized.indexOf(MCP_SERVERS_END);
  if (end < 0) throw new Error("DSH cordis.patch.yml 中的 Flowlet MCP 受管标记不完整");
  if (end < start) throw new Error("DSH cordis.patch.yml 中的 Flowlet MCP 受管标记顺序错误");
  const newlineOffset = normalized.slice(start).indexOf("\n");
  const bodyStart = newlineOffset >= 0 ? start + newlineOffset + 1 : end;
  const body = normalized.slice(bodyStart, end).trim();
  if (body === "") return [];
  const entries = parseYamlValue(body);
  if (!Array.isArray(entries)) return [];
  const servers: McpServerSpecInput[] = [];
  for (const entry of entries) {
    if (!isJsonObject(entry)) continue;
    const insert = entry.insert;
    if (!Array.isArray(insert) || insert.length === 0) continue;
    const spec = parseMcpPlugin(insert[0]);
    if (spec !== null) servers.push(spec);
  }
  return servers;
}

function collectMcpServers(profiles: ReadonlyArray<DshProfile>): McpServerSpecInput[] {
  const byId = new Map<string, McpServerSpecInput>();
  for (const { root } of profiles) {
    const patch = readYamlText(profilePaths(root).patch);
    for (const server of parseMcpServers(patch)) {
      if (!byId.has(server.id)) byId.set(server.id, server);
    }
  }
  return [...byId.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

// ─── settings / credentials 生成 ────────────────────────────────────────────

function providerProfile(expectedBaseUrl: string, model: string): Record<string, unknown> {
  return {
    displayName: "Flowlet",
    apiKeyEnv: TOKEN_REF,
    api: "openai-completions",
    baseURL: normalizeUrl(expectedBaseUrl),
    models: [{ id: model }],
  };
}

function applySettingsText(text: string, expectedBaseUrl: string, model: string): string {
  return patchYamlEntries(text, "settings.yaml", [
    {
      parents: [LLM_NAMESPACE, "providers"],
      key: PROVIDER_ID,
      value: providerProfile(expectedBaseUrl, model),
    },
    { parents: [DEFAULT_MODEL_NAMESPACE], key: "provider", value: PROVIDER_ID },
    { parents: [DEFAULT_MODEL_NAMESPACE], key: "model", value: model },
  ]);
}

function applyCredentialsText(text: string, clientToken: string): string {
  return patchCredentialValue(text, clientToken);
}

function patchCredentialValue(text: string, value: string | undefined): string {
  const parsed = text.trim() === "" ? {} : parseYamlValue(text);
  if (!isJsonObject(parsed)) {
    throw new Error(".credentials.yaml 的根节点必须是 YAML 对象");
  }
  // DSH 0.1.1 起使用 `version: 1` + `refs:`；旧预发布版本使用根级扁平映射。
  const versioned =
    yamlAt(parsed, ["version"]) !== undefined ||
    yamlAt(parsed, [CREDENTIAL_REFS]) !== undefined ||
    yamlAt(parsed, ["records"]) !== undefined;
  if (versioned) {
    const nested = patchYamlEntries(text, ".credentials.yaml", [
      { parents: [CREDENTIAL_REFS], key: TOKEN_REF, value },
    ]);
    return patchYamlEntries(nested, ".credentials.yaml", [{ parents: [], key: TOKEN_REF, value: undefined }]);
  }
  return patchYamlEntries(text, ".credentials.yaml", [{ parents: [], key: TOKEN_REF, value }]);
}

function restoreSettingsText(text: string, snapshot: ManagedSnapshot): string {
  return patchYamlEntries(text, "settings.yaml", [
    {
      parents: [LLM_NAMESPACE, "providers"],
      key: PROVIDER_ID,
      value: snapshot.provider.present ? snapshot.provider.value : undefined,
    },
    {
      parents: [DEFAULT_MODEL_NAMESPACE],
      key: "provider",
      value: snapshot.default_provider.present ? snapshot.default_provider.value : undefined,
    },
    {
      parents: [DEFAULT_MODEL_NAMESPACE],
      key: "model",
      value: snapshot.default_model.present ? snapshot.default_model.value : undefined,
    },
  ]);
}

function restoreCredentialsText(text: string, snapshot: ManagedSnapshot): string {
  return patchCredentialValue(text, snapshot.credential.present ? (snapshot.credential.value as string) : undefined);
}

// ─── inspect / apply / restore ──────────────────────────────────────────────

export function inspectDshAt(home: string, expectedBaseUrl: string): AgentGlobalConfigReport {
  const settingsPath = path.join(home, "settings.yaml");
  const credentialsPath = path.join(home, ".credentials.yaml");
  const backupAvailable = fileExists(dshBackupPath(home));
  const profiles = dshProfiles(home);
  const sessionExtension =
    profiles.length > 0 && profiles.every(({ root }) => profileBridgeMatches(root, expectedBaseUrl));
  const mcpServers = collectMcpServers(profiles);
  const base = {
    agent_id: "deepseek-harness",
    settings_path: displayPath(settingsPath),
    credentials_path: displayPath(credentialsPath),
    settings_exists: fileExists(settingsPath),
    backup_available: backupAvailable,
    external_environment_overrides: process.env[TOKEN_REF] !== undefined ? [TOKEN_REF] : [],
    session_extension: sessionExtension,
    mcp_servers: mcpServers,
  };
  if (!fileExists(settingsPath)) {
    return buildReport({ ...base, state: "not_configured" });
  }

  let settings: Record<string, unknown>;
  try {
    settings = readYamlValue(settingsPath);
  } catch (error) {
    return buildReport({ ...base, state: "invalid", error: errorText(error) });
  }

  const provider = yamlAt(settings, [LLM_NAMESPACE, "providers", PROVIDER_ID]);
  const providerRow = isJsonObject(provider) ? provider : null;
  const baseUrl = providerRow !== null && typeof providerRow.baseURL === "string" ? providerRow.baseURL : null;
  const keyRefMatches = providerRow !== null && providerRow.apiKeyEnv === TOKEN_REF;
  const apiMatches = providerRow !== null && providerRow.api === "openai-completions";
  const modelRaw = yamlAt(settings, [DEFAULT_MODEL_NAMESPACE, "model"]);
  const model = typeof modelRaw === "string" ? modelRaw : null;
  const defaultProvider = yamlAt(settings, [DEFAULT_MODEL_NAMESPACE, "provider"]);
  const token =
    process.env[TOKEN_REF] !== undefined || readCredentialValue(credentialsPath) !== null;
  const baseMatches = baseUrl !== null && normalizeUrl(baseUrl) === normalizeUrl(expectedBaseUrl);
  const state =
    baseMatches &&
    keyRefMatches &&
    apiMatches &&
    token &&
    defaultProvider === PROVIDER_ID &&
    model !== null &&
    isKnownCatalogModel(model)
      ? "flowlet"
      : baseUrl !== null && normalizeUrl(baseUrl) !== normalizeUrl(expectedBaseUrl)
        ? "other_gateway"
        : provider !== undefined || defaultProvider === PROVIDER_ID
          ? "partial"
          : "not_configured";

  return buildReport({
    ...base,
    state,
    base_url: baseUrl,
    auth_token_configured: token,
    api_key_configured: token,
    primary_model: model,
  });
}

export interface DshApplyInput {
  home: string;
  expectedBaseUrl: string;
  clientToken: string;
  sessionExtension: boolean;
  primaryModel: string;
  mcpServers: ReadonlyArray<McpServerSpecInput> | null;
}

export function applyDsh(input: DshApplyInput): AgentGlobalConfigReport {
  const { home, expectedBaseUrl, clientToken, sessionExtension, primaryModel, mcpServers } = input;
  // 服务器列表校验是纯函数，先于任何锁与文件操作执行。
  if (mcpServers !== null && mcpServers.length > 0) validateMcpServers(mcpServers);

  const settingsPath = path.join(home, "settings.yaml");
  const credentialsPath = path.join(home, ".credentials.yaml");
  const backup = dshBackupPath(home);
  const releaseSettings = acquireDshLock(settingsPath);
  let releaseCredentials: (() => void) | null = null;
  try {
    releaseCredentials = acquireDshLock(credentialsPath);
    const settingsText = readYamlText(settingsPath);
    const credentialsText = readYamlText(credentialsPath);
    const current = captureSnapshot(settingsPath, credentialsPath);
    const settingsOutput = applySettingsText(settingsText, expectedBaseUrl, primaryModel);
    const credentialsOutput = applyCredentialsText(credentialsText, clientToken);
    const profiles = dshProfiles(home);
    if (sessionExtension && profiles.length === 0) {
      throw new Error(
        "尚未发现可安装 Flowlet 会话插件的 DSH Profile；请先启动一次 DeepSeek Harness，或关闭可选的精确会话关联",
      );
    }
    if (mcpServers !== null && mcpServers.length > 0 && profiles.length === 0) {
      throw new Error(
        "尚未发现可部署 MCP 服务器的 DSH Profile；请先启动一次 DeepSeek Harness，或移除 MCP 服务器",
      );
    }
    const createdBackup = !fileExists(backup);
    const backupValue = createdBackup
      ? {
          version: BACKUP_VERSION,
          agent_id: "deepseek-harness",
          provider: current.provider,
          default_provider: current.default_provider,
          default_model: current.default_model,
          credential: current.credential,
          profiles: [] as DshProfileBackup[],
        }
      : parseDshBackup(readOptionalJsonObject(backup));
    if (backupValue.version !== BACKUP_VERSION || backupValue.agent_id !== "deepseek-harness") {
      throw new Error("DeepSeek Harness 配置备份版本不受支持");
    }
    for (const { profile, root } of profiles) {
      if (backupValue.profiles.some((item) => item.profile === profile)) continue;
      const { patch, plugin } = profilePaths(root);
      backupValue.profiles.push({
        profile,
        patch: backedUpText(patch),
        plugin: backedUpText(plugin),
      });
    }
    const writes: Array<readonly [string, Buffer | null]> = [
      [settingsPath, textFileBytes(settingsOutput)],
      [credentialsPath, textFileBytes(credentialsOutput)],
    ];
    for (const { profile, root } of profiles) {
      const { patch, plugin } = profilePaths(root);
      let patchText = readYamlText(patch);
      let patchChanged = false;
      if (sessionExtension) {
        patchText = patchSessionBridge(patchText, expectedBaseUrl);
        patchChanged = true;
        writes.push([plugin, textFileBytes(DSH_SESSION_BRIDGE_SOURCE)]);
      } else {
        const patchOutput = removeSessionBridge(patchText);
        if (patchOutput !== patchText) {
          patchText = patchOutput;
          patchChanged = true;
        }
        const previousPlugin = backupValue.profiles
          .find((item) => item.profile === profile)
          ?.plugin;
        const previousContent =
          previousPlugin !== undefined && previousPlugin.present
            ? textFileBytes(previousPlugin.content)
            : null;
        if (managedTextFileMatches(plugin, DSH_SESSION_BRIDGE_SOURCE)) {
          writes.push([plugin, previousContent]);
        }
      }
      if (mcpServers !== null) {
        if (mcpServers.length === 0) {
          const patchOutput = removeMcpServers(patchText);
          if (patchOutput !== patchText) {
            patchText = patchOutput;
            patchChanged = true;
          }
        } else {
          patchText = patchMcpServers(patchText, mcpServers);
          patchChanged = true;
        }
      }
      if (patchChanged) writes.push([patch, textFileBytes(patchText)]);
    }
    writeJsonFile(backup, backupValue);
    try {
      writeFilesTransactionally("DeepSeek Harness 配置与 Flowlet 会话插件", writes);
    } catch (error) {
      if (createdBackup && error instanceof Error && /已回滚/u.test(error.message)) {
        removeFileIfExists(backup, "清理 DSH 配置备份失败");
      }
      throw error;
    }
  } finally {
    if (releaseCredentials !== null) releaseCredentials();
    releaseSettings();
  }
  return inspectDshAt(home, expectedBaseUrl);
}

export function restoreDshAt(home: string, expectedBaseUrl: string): AgentGlobalConfigReport {
  const settingsPath = path.join(home, "settings.yaml");
  const credentialsPath = path.join(home, ".credentials.yaml");
  const backupPath = dshBackupPath(home);
  if (!fileExists(backupPath)) {
    throw new Error("没有可恢复的 DeepSeek Harness 接入前配置");
  }
  const backup = parseDshBackup(readOptionalJsonObject(backupPath));
  if (backup.version !== BACKUP_VERSION || backup.agent_id !== "deepseek-harness") {
    throw new Error("DeepSeek Harness 配置备份版本不受支持");
  }
  const snapshot: ManagedSnapshot = {
    provider: backup.provider,
    default_provider: backup.default_provider,
    default_model: backup.default_model,
    credential: backup.credential,
  };
  const releaseSettings = acquireDshLock(settingsPath);
  let releaseCredentials: (() => void) | null = null;
  try {
    releaseCredentials = acquireDshLock(credentialsPath);
    const writes: Array<readonly [string, Buffer | null]> = [
      [settingsPath, textFileBytes(restoreSettingsText(readYamlText(settingsPath), snapshot))],
      [
        credentialsPath,
        textFileBytes(restoreCredentialsText(readYamlText(credentialsPath), snapshot)),
      ],
    ];
    const profilesRoot = path.join(home, "profiles");
    for (const profile of backup.profiles) {
      if (
        profile.profile === "" ||
        profile.profile.includes("/") ||
        profile.profile.includes("\\") ||
        profile.profile === "." ||
        profile.profile === ".."
      ) {
        throw new Error("DeepSeek Harness 配置备份包含无效 Profile 名称");
      }
      const root = path.join(profilesRoot, profile.profile);
      const { patch, plugin } = profilePaths(root);
      writes.push([patch, profile.patch.present ? textFileBytes(profile.patch.content) : null]);
      writes.push([plugin, profile.plugin.present ? textFileBytes(profile.plugin.content) : null]);
    }
    writeFilesTransactionally("DeepSeek Harness 配置与 Flowlet 会话插件", writes);
  } finally {
    if (releaseCredentials !== null) releaseCredentials();
    releaseSettings();
  }
  removeFileIfExists(backupPath, "删除 DSH 配置备份失败");
  return inspectDshAt(home, expectedBaseUrl);
}

export function parseDshBackup(value: Record<string, unknown>): DshConfigBackup {
  const backed = (entry: unknown): BackedUpValue => {
    if (!isJsonObject(entry)) return { present: false, value: null };
    return { present: entry.present === true, value: entry.value ?? null };
  };
  const profiles: DshProfileBackup[] = [];
  if (Array.isArray(value.profiles)) {
    for (const item of value.profiles) {
      if (!isJsonObject(item)) continue;
      const patch = isJsonObject(item.patch) ? item.patch : {};
      const plugin = isJsonObject(item.plugin) ? item.plugin : {};
      profiles.push({
        profile: typeof item.profile === "string" ? item.profile : "",
        patch: {
          present: patch.present === true,
          content: typeof patch.content === "string" ? patch.content : "",
        },
        plugin: {
          present: plugin.present === true,
          content: typeof plugin.content === "string" ? plugin.content : "",
        },
      });
    }
  }
  return {
    version: typeof value.version === "number" ? value.version : 0,
    agent_id: typeof value.agent_id === "string" ? value.agent_id : "",
    provider: backed(value.provider),
    default_provider: backed(value.default_provider),
    default_model: backed(value.default_model),
    credential: backed(value.credential),
    profiles,
  };
}