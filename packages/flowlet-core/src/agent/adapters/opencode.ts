// OpenCode 全局配置 Adapter。
//
// 权威实现：`src-tauri/src/core/agent_global_config/adapters/opencode.rs`。
// 配置位置：`~/.config/opencode/opencode.jsonc`（回退 opencode.json）、
// `~/.local/share/opencode/auth.json`，以及受管权限事件插件
// `~/.config/opencode/plugins/flowlet.ts`。
//
// 编辑策略：JSONC 使用 `jsonc-parser` 的 CST 级 modify/applyEdits，保留注释与格式；
// 这正是 Rust `jsonc_parser::cst` 的等价实现。
import path from "node:path";

import {
  errorText,
  fileExists,
  jsonFileBytes,
  managedTextFileMatches,
  readText,
  removeFileIfExists,
  rfc3339Now,
  textFileBytes,
  writeFilesTransactionally,
  writeJsonFile,
} from "../fs.ts";
import {
  hasJsonProperty,
  isJsonObject,
  jsonPointer,
  jsoncDelete,
  jsoncSet,
  jsoncSetOrDelete,
  parseJsoncObject,
  readJsoncSettings,
  readOptionalJsonObject,
} from "../jsonc.ts";
import { isKnownCatalogModel } from "../models.ts";
import { displayPath, normalizeUrl, pathsEqual } from "../paths.ts";
import { OPENCODE_PERMISSION_PLUGIN_SOURCE } from "../resources.ts";
import {
  backedUpValue,
  buildReport,
  type AgentGlobalConfigReport,
  type BackedUpValue,
} from "../report.ts";

const BACKUP_VERSION = 1;
const OPENCODE_PROVIDER_ID = "flowlet";
const OPENCODE_BACKUP_FILE = "opencode-global-config-backup.json";
const OPENCODE_DEFAULT_SCHEMA = "https://opencode.ai/config.json";

export interface OpencodeBackup {
  version: number;
  agent_id: string;
  created_at: string;
  settings_path: string;
  auth_path: string;
  settings_existed: boolean;
  auth_existed: boolean;
  provider_existed: boolean;
  schema: BackedUpValue;
  model: BackedUpValue;
  small_model: BackedUpValue;
  disabled_providers: BackedUpValue;
  enabled_providers: BackedUpValue;
  server: BackedUpValue | null;
  flowlet_provider: BackedUpValue;
  flowlet_auth: BackedUpValue;
  permission_plugin_path: string;
  permission_plugin_previous: BackedUpValue;
}

export function opencodeBackupPath(settingsPath: string): string {
  return path.join(path.dirname(settingsPath), ".flowlet", OPENCODE_BACKUP_FILE);
}

function settingsLabel(settingsPath: string): string {
  return displayPath(settingsPath);
}

function parseSettingsText(text: string, settingsPath: string): Record<string, unknown> {
  try {
    return parseJsoncObject(text, settingsLabel(settingsPath));
  } catch (error) {
    throw new Error(`解析 ${settingsLabel(settingsPath)} 失败：${errorText(error)}`);
  }
}

function modelRefValue(model: string): string {
  return `${OPENCODE_PROVIDER_ID}/${model}`;
}

function modelRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const prefix = `${OPENCODE_PROVIDER_ID}/`;
  if (!value.startsWith(prefix)) return null;
  const model = value.slice(prefix.length);
  return model.trim() === "" ? null : model;
}

function arrayContains(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.some((item) => item === expected);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function inspectOpencode(
  settingsPath: string,
  authPath: string,
  permissionPluginPath: string,
  expectedBaseUrl: string,
): AgentGlobalConfigReport {
  const settingsExists = fileExists(settingsPath);
  const backupAvailable = fileExists(opencodeBackupPath(settingsPath));
  const permissionBridge = managedTextFileMatches(permissionPluginPath, OPENCODE_PERMISSION_PLUGIN_SOURCE);
  const externalEnvironmentOverrides = ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT"].filter(
    (name) => process.env[name] !== undefined,
  );
  const base = {
    agent_id: "opencode",
    settings_path: displayPath(settingsPath),
    credentials_path: displayPath(authPath),
    backup_available: backupAvailable,
    external_environment_overrides: externalEnvironmentOverrides,
    opencode_permission_bridge: permissionBridge,
  };

  if (!settingsExists) {
    return buildReport({ ...base, settings_exists: false, state: "not_configured" });
  }

  let settings: Record<string, unknown>;
  try {
    settings = readJsoncSettings(settingsPath);
  } catch (error) {
    return buildReport({ ...base, settings_exists: true, state: "invalid", error: errorText(error) });
  }
  let auth: Record<string, unknown>;
  try {
    auth = readOptionalJsonObject(authPath);
  } catch (error) {
    return buildReport({ ...base, settings_exists: true, state: "invalid", error: errorText(error) });
  }

  const provider = jsonPointer(settings, "/provider/flowlet");
  const providerRow = isJsonObject(provider) ? provider : null;
  const options = providerRow !== null && isJsonObject(providerRow.options) ? providerRow.options : null;
  const baseUrl = options !== null ? stringValue(options.baseURL) : null;
  const flowletAuth = isJsonObject(auth.flowlet) ? auth.flowlet : null;
  const apiKeyConfigured = flowletAuth !== null && stringValue(flowletAuth.key) !== null;
  const authTypeMatches = flowletAuth !== null && flowletAuth.type === "api";
  const primaryModel = stringValue(settings.model);
  const fastModel = stringValue(settings.small_model);
  const primaryRef = modelRef(primaryModel);
  const fastRef = modelRef(fastModel);
  const providerModels = providerRow !== null && isJsonObject(providerRow.models) ? providerRow.models : null;
  const providerShapeMatches =
    providerRow !== null &&
    providerRow.npm === "@ai-sdk/openai-compatible" &&
    primaryRef !== null &&
    isKnownCatalogModel(primaryRef) &&
    providerModels !== null &&
    hasJsonProperty(providerModels, primaryRef) &&
    fastRef !== null &&
    isKnownCatalogModel(fastRef) &&
    hasJsonProperty(providerModels, fastRef);
  const disabled = arrayContains(settings.disabled_providers, OPENCODE_PROVIDER_ID);
  const enabled =
    settings.enabled_providers === undefined ||
    arrayContains(settings.enabled_providers, OPENCODE_PROVIDER_ID);
  const providerEnabled = !disabled && enabled;
  const normalizedExpected = normalizeUrl(expectedBaseUrl);
  const baseUrlMatches = baseUrl !== null && normalizeUrl(baseUrl) === normalizedExpected;
  const state =
    baseUrlMatches && apiKeyConfigured && authTypeMatches && providerShapeMatches && providerEnabled && permissionBridge
      ? "flowlet"
      : baseUrl !== null && normalizeUrl(baseUrl) !== normalizedExpected
        ? "other_gateway"
        : provider !== undefined ||
            auth.flowlet !== undefined ||
            (primaryModel?.startsWith("flowlet/") ?? false) ||
            (fastModel?.startsWith("flowlet/") ?? false) ||
            permissionBridge
          ? "partial"
          : "not_configured";

  return buildReport({
    ...base,
    settings_exists: true,
    state,
    base_url: baseUrl,
    auth_token_configured: apiKeyConfigured,
    api_key_configured: apiKeyConfigured,
    primary_model: primaryModel,
    fast_model: fastModel,
  });
}

export interface OpencodeApplyPaths {
  settingsPath: string;
  authPath: string;
  permissionPluginPath: string;
}

export function applyOpencode(
  paths: OpencodeApplyPaths,
  expectedBaseUrl: string,
  clientToken: string,
  primaryModel: string,
  fastModel: string,
): AgentGlobalConfigReport {
  const { settingsPath, authPath, permissionPluginPath } = paths;
  if (clientToken.trim() === "") {
    throw new Error("Flowlet 默认 Client Token 未配置，无法写入 OpenCode");
  }
  const settingsExisted = fileExists(settingsPath);
  const authExisted = fileExists(authPath);
  const permissionPluginPrevious = fileExists(permissionPluginPath) ? readText(permissionPluginPath) : null;
  let auth = readOptionalJsonObject(authPath);
  let text = settingsExisted ? readText(settingsPath) : "{}\n";
  const settings = parseSettingsText(text, settingsPath);
  const providerExisted = hasJsonProperty(settings, "provider");
  if (settings.provider !== undefined && !isJsonObject(settings.provider)) {
    throw new Error("OpenCode 配置中的 provider 必须是 JSON 对象");
  }
  if (settings.server !== undefined && !isJsonObject(settings.server)) {
    throw new Error("OpenCode 配置中的 server 必须是 JSON 对象");
  }

  const backup = opencodeBackupPath(settingsPath);
  const backupCreated = !fileExists(backup);
  if (backupCreated) {
    const snapshot: OpencodeBackup = {
      version: BACKUP_VERSION,
      agent_id: "opencode",
      created_at: rfc3339Now(),
      settings_path: displayPath(settingsPath),
      auth_path: displayPath(authPath),
      settings_existed: settingsExisted,
      auth_existed: authExisted,
      provider_existed: providerExisted,
      schema: backedUpValue(settings.$schema),
      model: backedUpValue(settings.model),
      small_model: backedUpValue(settings.small_model),
      disabled_providers: backedUpValue(settings.disabled_providers),
      enabled_providers: backedUpValue(settings.enabled_providers),
      server: backedUpValue(settings.server),
      flowlet_provider: backedUpValue(jsonPointer(settings, "/provider/flowlet")),
      flowlet_auth: backedUpValue(auth[OPENCODE_PROVIDER_ID]),
      permission_plugin_path: displayPath(permissionPluginPath),
      permission_plugin_previous: backedUpValue(permissionPluginPrevious),
    };
    writeJsonFile(backup, snapshot);
  } else {
    upgradeOpencodeBackupWithServer(backup, settings.server);
    upgradeOpencodeBackupWithPermissionPlugin(backup, permissionPluginPath, permissionPluginPrevious);
    text = restoreOpencodeManagedServerFields(text, settingsPath, backup);
  }

  if (!settingsExisted) {
    text = jsoncSet(text, ["$schema"], OPENCODE_DEFAULT_SCHEMA);
  }
  text = updateProviderAllowlists(text, settings);
  text = jsoncSet(text, ["model"], modelRefValue(primaryModel));
  text = jsoncSet(text, ["small_model"], modelRefValue(fastModel));
  const providerModels: Record<string, unknown> = {};
  for (const model of [primaryModel, fastModel]) {
    providerModels[model] = { name: model };
  }
  text = jsoncSet(text, ["provider", OPENCODE_PROVIDER_ID], {
    name: "Flowlet",
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL: expectedBaseUrl },
    models: providerModels,
  });
  auth = { ...auth, [OPENCODE_PROVIDER_ID]: { type: "api", key: clientToken.trim() } };

  const settingsContent = textFileBytes(text);
  const authContent = jsonFileBytes(auth);
  const permissionPluginContent = textFileBytes(OPENCODE_PERMISSION_PLUGIN_SOURCE);
  try {
    writeFilesTransactionally("OpenCode 配置与凭据文件", [
      [settingsPath, settingsContent],
      [authPath, authContent],
      [permissionPluginPath, permissionPluginContent],
    ]);
  } catch (error) {
    if (backupCreated && error instanceof Error && errorMessageHasRolledBack(error)) {
      removeFileIfExists(backup, "清理 OpenCode 配置备份失败");
    }
    throw error;
  }
  return inspectOpencode(settingsPath, authPath, permissionPluginPath, expectedBaseUrl);
}

function errorMessageHasRolledBack(error: Error): boolean {
  return /已回滚/u.test(error.message);
}

export function restoreOpencode(
  paths: OpencodeApplyPaths,
  expectedBaseUrl: string,
): AgentGlobalConfigReport {
  const { settingsPath, permissionPluginPath } = paths;
  const backupPath = opencodeBackupPath(settingsPath);
  if (!fileExists(backupPath)) {
    throw new Error("没有可恢复的 OpenCode 全局配置备份");
  }
  const backup = parseOpencodeBackup(readOptionalJsonObject(backupPath));
  if (backup.version !== BACKUP_VERSION || backup.agent_id !== "opencode") {
    throw new Error("OpenCode 全局配置备份版本不受支持");
  }
  const authPath = backup.auth_path;
  if (!pathsEqual(authPath, paths.authPath)) {
    throw new Error("OpenCode 凭据备份路径与当前用户配置不一致");
  }
  if (backup.permission_plugin_path !== "" && !pathsEqual(backup.permission_plugin_path, permissionPluginPath)) {
    throw new Error("OpenCode 权限插件备份路径与当前用户配置不一致");
  }
  let auth = readOptionalJsonObject(authPath);
  let text = fileExists(settingsPath) ? readText(settingsPath) : "{}\n";
  parseSettingsText(text, settingsPath);

  text = jsoncSetOrDelete(text, ["$schema"], backup.schema.present ? backup.schema.value : undefined);
  text = jsoncSetOrDelete(text, ["model"], backup.model.present ? backup.model.value : undefined);
  text = jsoncSetOrDelete(text, ["small_model"], backup.small_model.present ? backup.small_model.value : undefined);
  text = jsoncSetOrDelete(
    text,
    ["disabled_providers"],
    backup.disabled_providers.present ? backup.disabled_providers.value : undefined,
  );
  text = jsoncSetOrDelete(
    text,
    ["enabled_providers"],
    backup.enabled_providers.present ? backup.enabled_providers.value : undefined,
  );
  if (backup.server !== null) {
    text = jsoncSetOrDelete(text, ["server"], backup.server.present ? backup.server.value : undefined);
  }

  const restored = parseSettingsText(text, settingsPath);
  const currentProvider = restored.provider;
  if (currentProvider !== undefined) {
    if (!isJsonObject(currentProvider)) {
      throw new Error("OpenCode 配置中的 provider 必须是 JSON 对象");
    }
    text = jsoncSetOrDelete(
      text,
      ["provider", OPENCODE_PROVIDER_ID],
      backup.flowlet_provider.present ? backup.flowlet_provider.value : undefined,
    );
    const afterProvider = parseSettingsText(text, settingsPath);
    if (
      !backup.provider_existed &&
      isJsonObject(afterProvider.provider) &&
      Object.keys(afterProvider.provider).length === 0
    ) {
      text = jsoncDelete(text, ["provider"]);
    }
  } else if (backup.flowlet_provider.present) {
    text = jsoncSet(text, ["provider", OPENCODE_PROVIDER_ID], backup.flowlet_provider.value);
  }

  if (backup.flowlet_auth.present) {
    auth = { ...auth, [OPENCODE_PROVIDER_ID]: backup.flowlet_auth.value };
  } else {
    const { [OPENCODE_PROVIDER_ID]: _removed, ...rest } = auth;
    auth = rest;
  }

  const finalSettings = parseSettingsText(text, settingsPath);
  const settingsContent =
    !backup.settings_existed && Object.keys(finalSettings).length === 0 ? null : textFileBytes(text);
  const authContent = !backup.auth_existed && Object.keys(auth).length === 0 ? null : jsonFileBytes(auth);
  const permissionPluginContent = backup.permission_plugin_previous.present
    ? typeof backup.permission_plugin_previous.value === "string"
      ? textFileBytes(backup.permission_plugin_previous.value)
      : null
    : null;
  writeFilesTransactionally("OpenCode 配置、凭据与权限插件文件", [
    [settingsPath, settingsContent],
    [authPath, authContent],
    [permissionPluginPath, permissionPluginContent],
  ]);
  removeFileIfExists(backupPath, "配置已恢复，但清理 Flowlet 备份标记失败");
  return inspectOpencode(settingsPath, authPath, permissionPluginPath, expectedBaseUrl);
}

/** 早期版本曾写入 server.hostname/port；重新应用时恢复这两个受管字段。 */
function restoreOpencodeManagedServerFields(
  text: string,
  settingsPath: string,
  backupPath: string,
): string {
  const current = parseSettingsText(text, settingsPath);
  const server = isJsonObject(current.server) ? current.server : null;
  if (server === null || server.hostname !== "127.0.0.1" || typeof server.port !== "number") {
    return text;
  }
  const backup = parseOpencodeBackup(readOptionalJsonObject(backupPath));
  if (backup.server === null) return text;
  const original = isJsonObject(backup.server.value) ? backup.server.value : null;
  let output = text;
  for (const field of ["hostname", "port"]) {
    const value = backup.server.present && original !== null ? original[field] : undefined;
    output = jsoncSetOrDelete(output, ["server", field], value);
  }
  const after = parseSettingsText(output, settingsPath);
  if (isJsonObject(after.server) && Object.keys(after.server).length === 0) {
    output = jsoncDelete(output, ["server"]);
  }
  return output;
}

function upgradeOpencodeBackupWithServer(backupPath: string, currentServer: unknown): void {
  const backup = readOptionalJsonObject(backupPath);
  if (hasJsonProperty(backup, "server")) return;
  backup.server = backedUpValue(currentServer);
  writeJsonFile(backupPath, backup);
}

function upgradeOpencodeBackupWithPermissionPlugin(
  backupPath: string,
  pluginPath: string,
  previousContent: string | null,
): void {
  const backup = readOptionalJsonObject(backupPath);
  if (hasJsonProperty(backup, "permission_plugin_previous")) return;
  backup.permission_plugin_path = displayPath(pluginPath);
  backup.permission_plugin_previous = backedUpValue(previousContent);
  writeJsonFile(backupPath, backup);
}

function updateProviderAllowlists(text: string, settings: Record<string, unknown>): string {
  let output = text;
  if (settings.disabled_providers !== undefined) {
    const values = settings.disabled_providers;
    if (!Array.isArray(values)) {
      throw new Error("OpenCode 配置中的 disabled_providers 必须是字符串数组");
    }
    output = jsoncSet(
      output,
      ["disabled_providers"],
      values.filter((value) => value !== OPENCODE_PROVIDER_ID),
    );
  }
  if (settings.enabled_providers !== undefined) {
    const values = settings.enabled_providers;
    if (!Array.isArray(values)) {
      throw new Error("OpenCode 配置中的 enabled_providers 必须是字符串数组");
    }
    const next = [...values];
    if (!arrayContains(values, OPENCODE_PROVIDER_ID)) next.push(OPENCODE_PROVIDER_ID);
    output = jsoncSet(output, ["enabled_providers"], next);
  }
  return output;
}

export function parseOpencodeBackup(value: Record<string, unknown>): OpencodeBackup {
  const backed = (key: string): BackedUpValue => {
    const entry = value[key];
    if (!isJsonObject(entry)) return { present: false, value: null };
    return { present: entry.present === true, value: entry.value ?? null };
  };
  return {
    version: typeof value.version === "number" ? value.version : 0,
    agent_id: typeof value.agent_id === "string" ? value.agent_id : "",
    created_at: typeof value.created_at === "string" ? value.created_at : "",
    settings_path: typeof value.settings_path === "string" ? value.settings_path : "",
    auth_path: typeof value.auth_path === "string" ? value.auth_path : "",
    settings_existed: value.settings_existed === true,
    auth_existed: value.auth_existed === true,
    provider_existed: value.provider_existed === true,
    schema: backed("schema"),
    model: backed("model"),
    small_model: backed("small_model"),
    disabled_providers: backed("disabled_providers"),
    enabled_providers: backed("enabled_providers"),
    server: hasJsonProperty(value, "server") ? backed("server") : null,
    flowlet_provider: backed("flowlet_provider"),
    flowlet_auth: backed("flowlet_auth"),
    permission_plugin_path:
      typeof value.permission_plugin_path === "string" ? value.permission_plugin_path : "",
    permission_plugin_previous: backed("permission_plugin_previous"),
  };
}

