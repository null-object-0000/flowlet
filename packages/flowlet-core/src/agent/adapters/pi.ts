// Pi 全局配置 Adapter。
//
// 权威实现：`src-tauri/src/core/agent_global_config/adapters/pi.rs`。
// 文件位置：`~/.pi/agent/{settings.json,models.json,auth.json}` 与可选的会话扩展
// `~/.pi/agent/extensions/flowlet.ts`。`models.json` 承载 Flowlet Provider
// （`baseUrl` + `x-flowlet-client: pi` 标记头），`settings.json` 决定默认 Provider/模型。
//
// JSON 编辑同样走 jsonc-parser 的 CST 级 modify/applyEdits，保留用户注释与格式。
import path from "node:path";

import {
  errorText,
  fileExists,
  jsonFileBytes,
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
import { PI_SESSION_EXTENSION_SOURCE } from "../resources.ts";
import {
  backedUpValue,
  buildReport,
  type AgentGlobalConfigReport,
  type BackedUpValue,
} from "../report.ts";

const BACKUP_VERSION = 1;
const PI_PROVIDER_ID = "flowlet";
const PI_BACKUP_FILE = "pi-global-config-backup.json";

export interface PiPaths {
  settingsPath: string;
  modelsPath: string;
  authPath: string;
  extensionPath: string;
}

export interface PiBackup {
  version: number;
  agent_id: string;
  created_at: string;
  settings_path: string;
  models_path: string;
  auth_path: string;
  extension_path: string;
  settings_existed: boolean;
  models_existed: boolean;
  auth_existed: boolean;
  providers_existed: boolean;
  extension_existed: boolean;
  default_provider: BackedUpValue;
  default_model: BackedUpValue;
  flowlet_provider: BackedUpValue;
  flowlet_auth: BackedUpValue;
  extension_previous: BackedUpValue;
}

export function piBackupPath(modelsPath: string): string {
  return path.join(path.dirname(modelsPath), ".flowlet", PI_BACKUP_FILE);
}

function parseText(text: string, file: string): Record<string, unknown> {
  try {
    return parseJsoncObject(text, displayPath(file));
  } catch (error) {
    throw new Error(`解析 ${displayPath(file)} 失败：${errorText(error)}`);
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function inspectPi(paths: PiPaths, expectedBaseUrl: string): AgentGlobalConfigReport {
  const { settingsPath, modelsPath, authPath, extensionPath } = paths;
  const backupAvailable = fileExists(piBackupPath(modelsPath));
  const sessionExtension = fileExists(extensionPath);
  const base = {
    agent_id: "pi",
    settings_path: displayPath(modelsPath),
    credentials_path: displayPath(authPath),
    backup_available: backupAvailable,
    session_extension: sessionExtension,
  };

  if (!fileExists(modelsPath)) {
    return buildReport({ ...base, settings_exists: false, state: "not_configured" });
  }

  let models: Record<string, unknown>;
  let auth: Record<string, unknown>;
  let settings: Record<string, unknown>;
  try {
    models = readJsoncSettings(modelsPath);
    auth = readOptionalJsonObject(authPath);
    settings = readOptionalJsonObject(settingsPath);
  } catch (error) {
    return buildReport({ ...base, settings_exists: true, state: "invalid", error: errorText(error) });
  }

  const provider = jsonPointer(models, "/providers/flowlet");
  const providerRow = isJsonObject(provider) ? provider : null;
  const baseUrl = providerRow !== null ? nonEmptyString(providerRow.baseUrl) : null;
  const apiMatches = providerRow !== null && providerRow.api === "openai-completions";
  const modelIds = new Set<string>();
  if (providerRow !== null && Array.isArray(providerRow.models)) {
    for (const entry of providerRow.models) {
      if (isJsonObject(entry) && typeof entry.id === "string") modelIds.add(entry.id);
    }
  }
  const flowletAuth = isJsonObject(auth[PI_PROVIDER_ID]) ? auth[PI_PROVIDER_ID] : null;
  const apiKeyConfigured = flowletAuth !== null && nonEmptyString(flowletAuth.key) !== null;
  const authTypeMatches = flowletAuth !== null && flowletAuth.type === "api_key";
  const defaultProvider = typeof settings.defaultProvider === "string" ? settings.defaultProvider : null;
  const primaryModel = typeof settings.defaultModel === "string" ? settings.defaultModel : null;
  const modelsShapeMatches =
    primaryModel !== null && isKnownCatalogModel(primaryModel) && modelIds.has(primaryModel);
  const normalizedExpected = normalizeUrl(expectedBaseUrl);
  const baseUrlMatches = baseUrl !== null && normalizeUrl(baseUrl) === normalizedExpected;
  const state =
    baseUrlMatches && apiMatches && modelsShapeMatches && apiKeyConfigured && authTypeMatches && defaultProvider === PI_PROVIDER_ID
      ? "flowlet"
      : baseUrl !== null && normalizeUrl(baseUrl) !== normalizedExpected
        ? "other_gateway"
        : provider !== undefined ||
            auth[PI_PROVIDER_ID] !== undefined ||
            defaultProvider === PI_PROVIDER_ID ||
            (primaryModel?.startsWith("flowlet") ?? false)
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
  });
}

export function applyPi(
  paths: PiPaths,
  expectedBaseUrl: string,
  clientToken: string,
  sessionExtension: boolean,
  primaryModel: string,
  fastModel: string,
): AgentGlobalConfigReport {
  const { settingsPath, modelsPath, authPath, extensionPath } = paths;
  if (clientToken.trim() === "") {
    throw new Error("Flowlet 默认 Client Token 未配置，无法写入 Pi");
  }
  const settingsExisted = fileExists(settingsPath);
  const modelsExisted = fileExists(modelsPath);
  const authExisted = fileExists(authPath);
  const extensionExisted = fileExists(extensionPath);
  let settings = readOptionalJsonObject(settingsPath);
  let modelsText = modelsExisted ? readText(modelsPath) : "{}\n";
  let models = parseText(modelsText, modelsPath);
  let auth = readOptionalJsonObject(authPath);
  if (models.providers !== undefined && !isJsonObject(models.providers)) {
    throw new Error("Pi models.json 中的 providers 必须是 JSON 对象");
  }

  const backup = piBackupPath(modelsPath);
  const backupCreated = !fileExists(backup);
  if (backupCreated) {
    const snapshot: PiBackup = {
      version: BACKUP_VERSION,
      agent_id: "pi",
      created_at: rfc3339Now(),
      settings_path: displayPath(settingsPath),
      models_path: displayPath(modelsPath),
      auth_path: displayPath(authPath),
      extension_path: displayPath(extensionPath),
      settings_existed: settingsExisted,
      models_existed: modelsExisted,
      auth_existed: authExisted,
      providers_existed: hasJsonProperty(models, "providers"),
      extension_existed: extensionExisted,
      default_provider: backedUpValue(settings.defaultProvider),
      default_model: backedUpValue(settings.defaultModel),
      flowlet_provider: backedUpValue(jsonPointer(models, "/providers/flowlet")),
      flowlet_auth: backedUpValue(auth[PI_PROVIDER_ID]),
      extension_previous: backedUpValue(extensionExisted ? readText(extensionPath) : undefined),
    };
    writeJsonFile(backup, snapshot);
  }

  if (!isJsonObject(models.providers)) {
    modelsText = jsoncSet(modelsText, ["providers"], {});
    models = parseText(modelsText, modelsPath);
  }
  const entries: Array<{ id: string; name: string }> = [];
  for (const model of [primaryModel, fastModel]) {
    if (!entries.some((entry) => entry.id === model)) entries.push({ id: model, name: model });
  }
  modelsText = jsoncSet(modelsText, ["providers", PI_PROVIDER_ID], {
    baseUrl: expectedBaseUrl,
    api: "openai-completions",
    headers: { "x-flowlet-client": "pi" },
    models: entries,
  });
  auth = {
    ...auth,
    [PI_PROVIDER_ID]: { type: "api_key", key: clientToken.trim() },
  };
  let settingsText = settingsExisted ? readText(settingsPath) : "{}\n";
  parseText(settingsText, settingsPath);
  settingsText = jsoncSet(settingsText, ["defaultProvider"], PI_PROVIDER_ID);
  settingsText = jsoncSet(settingsText, ["defaultModel"], primaryModel);

  const writes: Array<readonly [string, Buffer | null]> = [
    [settingsPath, textFileBytes(settingsText)],
    [modelsPath, textFileBytes(modelsText)],
    [authPath, jsonFileBytes(auth)],
    [extensionPath, sessionExtension ? textFileBytes(PI_SESSION_EXTENSION_SOURCE) : null],
  ];
  try {
    writeFilesTransactionally("Pi 配置、模型、凭据与会话扩展文件", writes);
  } catch (error) {
    if (backupCreated && error instanceof Error && /已回滚/u.test(error.message)) {
      removeFileIfExists(backup, "清理 Pi 配置备份失败");
    }
    throw error;
  }
  return inspectPi(paths, expectedBaseUrl);
}

export function restorePi(paths: PiPaths, expectedBaseUrl: string): AgentGlobalConfigReport {
  const { settingsPath, modelsPath, authPath, extensionPath } = paths;
  const backupPath = piBackupPath(modelsPath);
  if (!fileExists(backupPath)) {
    throw new Error("没有可恢复的 Pi 全局配置备份");
  }
  const backup = parsePiBackup(readOptionalJsonObject(backupPath));
  if (backup.version !== BACKUP_VERSION || backup.agent_id !== "pi") {
    throw new Error("Pi 全局配置备份版本不受支持");
  }
  if (
    !pathsEqual(backup.settings_path, settingsPath) ||
    !pathsEqual(backup.models_path, modelsPath) ||
    !pathsEqual(backup.auth_path, authPath) ||
    !pathsEqual(backup.extension_path, extensionPath)
  ) {
    throw new Error("Pi 配置备份路径与当前用户配置不一致");
  }

  let settingsText = fileExists(settingsPath) ? readText(settingsPath) : "{}\n";
  let modelsText = fileExists(modelsPath) ? readText(modelsPath) : "{}\n";
  let auth = readOptionalJsonObject(authPath);
  parseText(settingsText, settingsPath);
  const models = parseText(modelsText, modelsPath);

  settingsText = jsoncSetOrDelete(
    settingsText,
    ["defaultProvider"],
    backup.default_provider.present ? backup.default_provider.value : undefined,
  );
  settingsText = jsoncSetOrDelete(
    settingsText,
    ["defaultModel"],
    backup.default_model.present ? backup.default_model.value : undefined,
  );

  if (isJsonObject(models.providers)) {
    modelsText = jsoncSetOrDelete(
      modelsText,
      ["providers", PI_PROVIDER_ID],
      backup.flowlet_provider.present ? backup.flowlet_provider.value : undefined,
    );
    const after = parseText(modelsText, modelsPath);
    if (
      !backup.providers_existed &&
      isJsonObject(after.providers) &&
      Object.keys(after.providers).length === 0
    ) {
      modelsText = jsoncDelete(modelsText, ["providers"]);
    }
  } else if (backup.flowlet_provider.present) {
    modelsText = jsoncSet(modelsText, ["providers"], {
      [PI_PROVIDER_ID]: backup.flowlet_provider.value,
    });
  }

  if (backup.flowlet_auth.present) {
    auth = { ...auth, [PI_PROVIDER_ID]: backup.flowlet_auth.value };
  } else {
    const { [PI_PROVIDER_ID]: _removed, ...rest } = auth;
    auth = rest;
  }

  const finalSettings = parseText(settingsText, settingsPath);
  const finalModels = parseText(modelsText, modelsPath);
  const settingsContent =
    !backup.settings_existed && Object.keys(finalSettings).length === 0 ? null : textFileBytes(settingsText);
  const modelsContent =
    !backup.models_existed && Object.keys(finalModels).length === 0 ? null : textFileBytes(modelsText);
  const authContent = !backup.auth_existed && Object.keys(auth).length === 0 ? null : jsonFileBytes(auth);
  const extensionContent =
    backup.extension_previous.present && typeof backup.extension_previous.value === "string"
      ? textFileBytes(backup.extension_previous.value)
      : null;
  writeFilesTransactionally("Pi 配置、模型、凭据与会话扩展文件", [
    [settingsPath, settingsContent],
    [modelsPath, modelsContent],
    [authPath, authContent],
    [extensionPath, extensionContent],
  ]);
  removeFileIfExists(backupPath, "配置已恢复，但清理 Flowlet 备份标记失败");
  return inspectPi(paths, expectedBaseUrl);
}

export function parsePiBackup(value: Record<string, unknown>): PiBackup {
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
    models_path: typeof value.models_path === "string" ? value.models_path : "",
    auth_path: typeof value.auth_path === "string" ? value.auth_path : "",
    extension_path: typeof value.extension_path === "string" ? value.extension_path : "",
    settings_existed: value.settings_existed === true,
    models_existed: value.models_existed === true,
    auth_existed: value.auth_existed === true,
    providers_existed: value.providers_existed === true,
    extension_existed: value.extension_existed === true,
    default_provider: backed("default_provider"),
    default_model: backed("default_model"),
    flowlet_provider: backed("flowlet_provider"),
    flowlet_auth: backed("flowlet_auth"),
    extension_previous: backed("extension_previous"),
  };
}