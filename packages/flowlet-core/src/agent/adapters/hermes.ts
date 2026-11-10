// Hermes Agent 全局配置 Adapter。
//
// 权威实现：`src-tauri/src/core/agent_global_config/adapters/hermes.rs`。
//
// `~/.hermes/config.yaml` 的 `model:` 段使用 `provider: "custom"` + `base_url` +
// `default`；API Key 按 Hermes 官方约定写成 `${HERMES_CUSTOM_<host>_API_KEY}` 引用，
// 真值落到 `~/.hermes/.env`。`model.default_headers` 注入 `x-flowlet-client: hermes`
// 归属标记；可选会话桥插件写入 `~/.hermes/plugins/flowlet-session-bridge/`。
import * as nodeFs from "node:fs";
import path from "node:path";

import {
  directoryExists,
  errorText,
  fileExists,
  managedTextFileMatches,
  readText,
  readTextOrNull,
  removeFileIfExists,
  rfc3339Now,
  textFileBytes,
  writeFilesTransactionally,
  writeJsonFile,
} from "../fs.ts";
import {
  isJsonObject,
  readOptionalJsonObject,
} from "../jsonc.ts";
import { isKnownCatalogModel } from "../models.ts";
import { displayPath, hermesSessionBridgeDir, normalizeUrl, pathsEqual } from "../paths.ts";
import { HERMES_SESSION_BRIDGE_MANIFEST, HERMES_SESSION_BRIDGE_SOURCE } from "../resources.ts";
import { backedUpValue, buildReport, type AgentGlobalConfigReport, type BackedUpValue } from "../report.ts";
import { patchYamlEntries, readYamlText, readYamlValue, yamlAt } from "../yaml.ts";
import { parse as parseYamlValueText } from "yaml";

const BACKUP_VERSION = 1;
const HERMES_BACKUP_FILE = "hermes-global-config-backup.json";
const HERMES_PROVIDER = "custom";
const HERMES_CLIENT_MARKER = "hermes";
const HERMES_CLIENT_HEADER = "x-flowlet-client";
const HERMES_SESSION_BRIDGE_NAME = "flowlet-session-bridge";

export interface HermesPaths {
  configPath: string;
  envPath: string;
}

export interface HermesBackup {
  version: number;
  agent_id: string;
  created_at: string;
  config_path: string;
  env_path: string;
  config_existed: boolean;
  env_existed: boolean;
  model: BackedUpValue;
  env_key: string;
  env_value: BackedUpValue;
  plugins: BackedUpValue;
  bridge_files: Record<string, string | null>;
  bridge_dir_existed: boolean;
}

export function hermesBackupPath(configPath: string): string {
  return path.join(path.dirname(configPath), ".flowlet", HERMES_BACKUP_FILE);
}

// ─── .env 与标识派生 ────────────────────────────────────────────────────────

/** 从本地代理 base_url 提取 Hermes 自定义端点身份 `host:port`。 */
export function hermesHostPort(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  const withoutScheme = trimmed.startsWith("http://")
    ? trimmed.slice("http://".length)
    : trimmed.startsWith("https://")
      ? trimmed.slice("https://".length)
      : trimmed;
  return (withoutScheme.split("/")[0] ?? withoutScheme).trim();
}

/** 复刻 Hermes `custom_endpoint_key_env(identity)`：`HERMES_CUSTOM_<slug>_API_KEY`。 */
export function hermesCustomKeyEnv(identity: string): string {
  let slug = "";
  let previousSeparator = false;
  for (const character of identity) {
    if (/[A-Za-z0-9]/u.test(character)) {
      slug += character.toUpperCase();
      previousSeparator = false;
    } else if (!previousSeparator) {
      slug += "_";
      previousSeparator = true;
    }
  }
  const trimmed = slug.replace(/^_+|_+$/gu, "");
  return trimmed === "" ? "HERMES_CUSTOM_API_KEY" : `HERMES_CUSTOM_${trimmed}_API_KEY`;
}

function readEnvValue(text: string, key: string): string | null {
  const prefix = `${key}=`;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(prefix)) {
      const value = trimmed.slice(prefix.length).trim();
      return value === "" ? null : value;
    }
  }
  return null;
}

/** 写入/移除 `.env` 中的变量，保留其它内容与注释。 */
export function patchEnvValue(text: string, key: string, value: string | null): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/u);
  const output: string[] = [];
  let replaced = false;
  for (const line of lines) {
    if (line.trim().startsWith(`${key}=`)) {
      replaced = true;
      if (value !== null) output.push(`${key}=${value}`);
      continue;
    }
    output.push(line);
  }
  if (!replaced && value !== null) {
    if (output.length > 0 && output[output.length - 1] !== "") output.push("");
    output.push(`${key}=${value}`);
  }
  return output.join(newline);
}

// ─── config.yaml 顶层块处理 ─────────────────────────────────────────────────

function isTopLevelKey(line: string, key: string): boolean {
  if (line.startsWith(" ") || line.startsWith("\t")) return false;
  if (!line.startsWith(key)) return false;
  const rest = line.slice(key.length).trimStart();
  return rest === ":" || rest.startsWith(": ");
}

/** 移除顶层 `key:` 块（含更深缩进/空行/注释子行），保留其余内容。 */
function stripTopLevelBlock(text: string, key: string): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/u);
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    if (isTopLevelKey(lines[index], key)) {
      index += 1;
      while (index < lines.length) {
        const line = lines[index];
        const trimmed = line.trimStart();
        if (trimmed === "" || trimmed.startsWith("#") || line.length > trimmed.length) {
          index += 1;
        } else {
          break;
        }
      }
      continue;
    }
    output.push(lines[index]);
    index += 1;
  }
  return output.join(newline);
}

function stripTopLevelModelBlock(text: string): string {
  return stripTopLevelBlock(text, "model");
}

function stripTopLevelPluginsBlock(text: string): string {
  return stripTopLevelBlock(text, "plugins");
}

/** 全新安装时 `model:` 可能是空串/空映射哨兵，先剥离顶层行再按映射写入。 */
function stripModelSentinel(text: string): string {
  let parsed: unknown;
  try {
    parsed = readYamlTextValue(text);
  } catch {
    return text;
  }
  if (!isJsonObject(parsed)) return text;
  const model = parsed.model;
  const needsStrip =
    model === undefined ||
    (model !== null && typeof model === "object" && !Array.isArray(model) && Object.keys(model).length === 0) ||
    typeof model === "string";
  if (!needsStrip) return text;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  return text
    .split(/\r?\n/u)
    .filter((line) => !isTopLevelKey(line, "model"))
    .join(newline);
}

function readYamlTextValue(text: string): unknown {
  return parseYamlValueText(text);
}

function readPluginsEnabled(root: unknown): string[] {
  const value = yamlAt(root, ["plugins", "enabled"]);
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function sessionBridgeInstalled(configPath: string): boolean {
  const dir = hermesSessionBridgeDir(configPath);
  if (!fileExists(path.join(dir, "plugin.yaml")) || !fileExists(path.join(dir, "__init__.py"))) {
    return false;
  }
  try {
    const root = readYamlValue(configPath);
    return readPluginsEnabled(root).includes(HERMES_SESSION_BRIDGE_NAME);
  } catch {
    return false;
  }
}

function hermesModelValue(root: unknown): string | null {
  const value = yamlAt(root, ["model", "default"]) ?? yamlAt(root, ["model", "model"]);
  return typeof value === "string" ? value : null;
}

function snapshotBridgeFiles(dir: string): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const name of ["plugin.yaml", "__init__.py"]) {
    result[name] = readTextOrNull(path.join(dir, name));
  }
  return result;
}

// ─── inspect / apply / restore ──────────────────────────────────────────────

export function inspectHermes(paths: HermesPaths, expectedBaseUrl: string): AgentGlobalConfigReport {
  const { configPath, envPath } = paths;
  const backupAvailable = fileExists(hermesBackupPath(configPath));
  const settingsExists = fileExists(configPath);
  const envKey = hermesCustomKeyEnv(hermesHostPort(expectedBaseUrl));
  const bridgeInstalled = sessionBridgeInstalled(configPath);
  const base = {
    agent_id: "hermes",
    settings_path: displayPath(configPath),
    credentials_path: displayPath(envPath),
    settings_exists: settingsExists,
    backup_available: backupAvailable,
    session_extension: bridgeInstalled,
  };
  if (!settingsExists) {
    return buildReport({ ...base, state: "not_configured" });
  }

  let root: Record<string, unknown>;
  try {
    root = readYamlValue(configPath);
  } catch (error) {
    return buildReport({ ...base, state: "invalid", error: errorText(error) });
  }
  const provider = yamlAt(root, ["model", "provider"]);
  const baseUrlRaw = yamlAt(root, ["model", "base_url"]);
  const baseUrl = typeof baseUrlRaw === "string" ? baseUrlRaw : null;
  const apiKeyRaw = yamlAt(root, ["model", "api_key"]);
  const apiKey =
    typeof apiKeyRaw === "string" && apiKeyRaw.trim() !== "" ? apiKeyRaw.trim() : null;
  const clientHeader = yamlAt(root, ["model", "default_headers", HERMES_CLIENT_HEADER]);
  const primaryModel = hermesModelValue(root);
  const apiKeyIsEnvRef = apiKey === `\${${envKey}}`;
  const envText = readTextOrNull(envPath);
  const envToken = envText === null ? null : readEnvValue(envText, envKey);
  const apiKeyConfigured = envToken !== null || apiKey !== null;
  const normalizedExpected = normalizeUrl(expectedBaseUrl);
  const baseUrlMatches = baseUrl !== null && normalizeUrl(baseUrl) === normalizedExpected;
  const state =
    provider === HERMES_PROVIDER &&
    primaryModel !== null &&
    isKnownCatalogModel(primaryModel) &&
    baseUrlMatches &&
    apiKeyIsEnvRef &&
    envToken !== null &&
    clientHeader === HERMES_CLIENT_MARKER
      ? "flowlet"
      : baseUrl !== null && normalizeUrl(baseUrl) !== normalizedExpected
        ? "other_gateway"
        : clientHeader === HERMES_CLIENT_MARKER || provider === HERMES_PROVIDER || apiKeyIsEnvRef
          ? "partial"
          : "not_configured";

  return buildReport({
    ...base,
    state,
    base_url: baseUrl,
    auth_token_configured: apiKeyConfigured,
    api_key_configured: apiKeyConfigured,
    primary_model: primaryModel,
  });
}

export function applyHermes(
  paths: HermesPaths,
  expectedBaseUrl: string,
  clientToken: string,
  primaryModel: string,
  sessionExtension: boolean | undefined,
): AgentGlobalConfigReport {
  const { configPath, envPath } = paths;
  if (clientToken.trim() === "") {
    throw new Error("Flowlet 默认 Client Token 未配置，无法写入 Hermes Agent");
  }
  const envKey = hermesCustomKeyEnv(hermesHostPort(expectedBaseUrl));
  const configExisted = fileExists(configPath);
  const envExisted = fileExists(envPath);
  const originalText = readYamlText(configPath);
  const originalRoot = readYamlValue(configPath);
  const originalEnvText = envExisted ? readText(envPath) : "";
  const bridgeDir = hermesSessionBridgeDir(configPath);

  const backup = hermesBackupPath(configPath);
  const backupCreated = !fileExists(backup);
  if (backupCreated) {
    const snapshot: HermesBackup = {
      version: BACKUP_VERSION,
      agent_id: "hermes",
      created_at: rfc3339Now(),
      config_path: displayPath(configPath),
      env_path: displayPath(envPath),
      config_existed: configExisted,
      env_existed: envExisted,
      model: backedUpValue(yamlAt(originalRoot, ["model"])),
      env_key: envKey,
      env_value: backedUpValue(readEnvValue(originalEnvText, envKey) ?? undefined),
      plugins: backedUpValue(yamlAt(originalRoot, ["plugins"])),
      bridge_files: snapshotBridgeFiles(bridgeDir),
      bridge_dir_existed: directoryExists(bridgeDir),
    };
    writeJsonFile(backup, snapshot);
  }

  let text = stripModelSentinel(originalText);
  text = patchYamlEntries(text, "config.yaml", [
    { parents: ["model"], key: "provider", value: HERMES_PROVIDER },
    { parents: ["model"], key: "default", value: primaryModel },
    { parents: ["model"], key: "base_url", value: normalizeUrl(expectedBaseUrl) },
    { parents: ["model"], key: "api_key", value: `\${${envKey}}` },
    {
      parents: ["model", "default_headers"],
      key: HERMES_CLIENT_HEADER,
      value: HERMES_CLIENT_MARKER,
    },
  ]);
  if (sessionExtension !== undefined) {
    const enabled = readPluginsEnabled(originalRoot);
    let next = enabled;
    if (sessionExtension && !enabled.includes(HERMES_SESSION_BRIDGE_NAME)) {
      next = [...enabled, HERMES_SESSION_BRIDGE_NAME];
    } else if (!sessionExtension) {
      next = enabled.filter((name) => name !== HERMES_SESSION_BRIDGE_NAME);
    }
    text = patchYamlEntries(text, "config.yaml", [
      { parents: ["plugins"], key: "enabled", value: next },
    ]);
  }
  const envText = patchEnvValue(originalEnvText, envKey, clientToken.trim());

  const writes: Array<readonly [string, Buffer | null]> = [
    [configPath, textFileBytes(text)],
    [envPath, envText.trim() === "" ? null : textFileBytes(envText)],
  ];
  if (sessionExtension === true) {
    writes.push([path.join(bridgeDir, "plugin.yaml"), textFileBytes(HERMES_SESSION_BRIDGE_MANIFEST)]);
    writes.push([path.join(bridgeDir, "__init__.py"), textFileBytes(HERMES_SESSION_BRIDGE_SOURCE)]);
  } else if (sessionExtension === false) {
    if (managedTextFileMatches(path.join(bridgeDir, "plugin.yaml"), HERMES_SESSION_BRIDGE_MANIFEST)) {
      writes.push([path.join(bridgeDir, "plugin.yaml"), null]);
    }
    if (managedTextFileMatches(path.join(bridgeDir, "__init__.py"), HERMES_SESSION_BRIDGE_SOURCE)) {
      writes.push([path.join(bridgeDir, "__init__.py"), null]);
    }
  }
  try {
    writeFilesTransactionally("Hermes config.yaml、.env 与会话桥插件", writes);
  } catch (error) {
    if (backupCreated && error instanceof Error && /已回滚/u.test(error.message)) {
      removeFileIfExists(backup, "清理 Hermes 配置备份失败");
    }
    throw error;
  }
  return inspectHermes(paths, expectedBaseUrl);
}

export function restoreHermes(paths: HermesPaths, expectedBaseUrl: string): AgentGlobalConfigReport {
  const { configPath, envPath } = paths;
  const backupPath = hermesBackupPath(configPath);
  if (!fileExists(backupPath)) {
    throw new Error("没有可恢复的 Hermes Agent 全局配置备份");
  }
  const backup = parseHermesBackup(readOptionalJsonObject(backupPath));
  if (backup.version !== BACKUP_VERSION || backup.agent_id !== "hermes") {
    throw new Error("Hermes Agent 全局配置备份版本不受支持");
  }
  if (!pathsEqual(backup.config_path, configPath) || !pathsEqual(backup.env_path, envPath)) {
    throw new Error("Hermes Agent 配置备份路径与当前用户配置不一致");
  }

  // 整块移除 Flowlet 写的 model，再按备份写回接入前的 model。
  let text = stripTopLevelModelBlock(readYamlText(configPath));
  text = patchYamlEntries(text, "config.yaml", [
    { parents: [], key: "model", value: backup.model.present ? backup.model.value : undefined },
  ]);
  // 还原 plugins 块：整块移除受管内容后写回接入前的值。
  text = stripTopLevelPluginsBlock(text);
  text = patchYamlEntries(text, "config.yaml", [
    { parents: [], key: "plugins", value: backup.plugins.present ? backup.plugins.value : undefined },
  ]);

  const envTextCurrent = readTextOrNull(envPath) ?? "";
  const envValue =
    backup.env_value.present && typeof backup.env_value.value === "string"
      ? backup.env_value.value
      : null;
  const envText = patchEnvValue(envTextCurrent, backup.env_key, envValue);

  const bridgeDir = hermesSessionBridgeDir(configPath);
  const writes: Array<readonly [string, Buffer | null]> = [
    [
      configPath,
      isRestoredConfigEmpty(text, backup.config_existed) ? null : textFileBytes(text),
    ],
    [envPath, !backup.env_existed && envText.trim() === "" ? null : textFileBytes(envText)],
  ];
  for (const name of ["plugin.yaml", "__init__.py"]) {
    const content = backup.bridge_files[name] ?? null;
    writes.push([path.join(bridgeDir, name), content === null ? null : textFileBytes(content)]);
  }
  writeFilesTransactionally("Hermes config.yaml、.env 与会话桥插件", writes);
  // 接入前插件目录不存在且已清空时，顺手删除空目录。
  if (!backup.bridge_dir_existed && directoryExists(bridgeDir) && isDirectoryEmpty(bridgeDir)) {
    try {
      nodeFs.rmdirSync(bridgeDir);
    } catch {
      // 清理空目录失败不影响恢复结果。
    }
  }
  removeFileIfExists(backupPath, "配置已恢复，但清理 Flowlet 备份标记失败");
  return inspectHermes(paths, expectedBaseUrl);
}

function isRestoredConfigEmpty(text: string, configExisted: boolean): boolean {
  if (configExisted) return false;
  if (text.trim() === "") return true;
  try {
    const value = readYamlTextValue(text);
    return isJsonObject(value) && Object.keys(value).length === 0;
  } catch {
    return false;
  }
}

function isDirectoryEmpty(dir: string): boolean {
  return nodeFs.readdirSync(dir).length === 0;
}

export function parseHermesBackup(value: Record<string, unknown>): HermesBackup {
  const backed = (entry: unknown): BackedUpValue => {
    if (!isJsonObject(entry)) return { present: false, value: null };
    return { present: entry.present === true, value: entry.value ?? null };
  };
  const bridgeFiles: Record<string, string | null> = {};
  if (isJsonObject(value.bridge_files)) {
    for (const [name, content] of Object.entries(value.bridge_files)) {
      bridgeFiles[name] = typeof content === "string" ? content : null;
    }
  }
  return {
    version: typeof value.version === "number" ? value.version : 0,
    agent_id: typeof value.agent_id === "string" ? value.agent_id : "",
    created_at: typeof value.created_at === "string" ? value.created_at : "",
    config_path: typeof value.config_path === "string" ? value.config_path : "",
    env_path: typeof value.env_path === "string" ? value.env_path : "",
    config_existed: value.config_existed === true,
    env_existed: value.env_existed === true,
    model: backed(value.model),
    env_key: typeof value.env_key === "string" ? value.env_key : "",
    env_value: backed(value.env_value),
    plugins: backed(value.plugins),
    bridge_files: bridgeFiles,
    bridge_dir_existed: value.bridge_dir_existed === true,
  };
}