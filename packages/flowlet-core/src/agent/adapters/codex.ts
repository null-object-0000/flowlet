// Codex 全局配置 Adapter。
//
// 权威实现：`src-tauri/src/core/agent_global_config/adapters/codex.rs` 与
// `src-tauri/src/core/codex_model_catalog.rs`。
//
// 文件：`~/.codex/config.toml`（`CODEX_HOME` 可覆盖）、`~/.codex/auth.json`，
// 以及按所选模型动态生成的 `~/.codex/model-catalog.flowlet.json`。
// TOML 编辑采用「smol-toml 解析 + 行级外科手术」保留注释与格式（见 `../toml.ts`）。
import path from "node:path";

import {
  errorText,
  fileExists,
  jsonFileBytes,
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
import { catalogDeclaresModel, codexCatalogContent } from "../models.ts";
import { displayPath, normalizeUrl, pathsEqual } from "../paths.ts";
import { backedUpValue, buildReport, type AgentGlobalConfigReport, type BackedUpValue } from "../report.ts";
import {
  parseToml,
  readTomlValue,
  removeTomlProviderTable,
  removeTomlTopLevelValue,
  setTomlProviderTable,
  setTomlTopLevelValue,
  tomlProviderTable,
  type TomlJson,
} from "../toml.ts";

const BACKUP_VERSION = 1;
const CODEX_BACKUP_FILE = "codex-global-config-backup.json";
const CODEX_PROVIDER_ID = "flowlet";
const CODEX_WIRE_API = "responses";
const CODEX_AUTH_KEY = "OPENAI_API_KEY";
export const CODEX_MODEL_CATALOG_REF = "~/.codex/model-catalog.flowlet.json";
export const CODEX_MODEL_CATALOG_FILE = "model-catalog.flowlet.json";

const CODEX_MANAGED_TOP_LEVEL: ReadonlyArray<string> = [
  "model",
  "model_provider",
  "disable_response_storage",
  "preferred_auth_method",
  "model_catalog_json",
];

export interface CodexPaths {
  configPath: string;
  authPath: string;
  modelsPath: string;
}

export interface CodexBackup {
  version: number;
  agent_id: string;
  created_at: string;
  config_path: string;
  auth_path: string;
  config_existed: boolean;
  auth_existed: boolean;
  provider_table_existed: boolean;
  top_level: Record<string, BackedUpValue>;
  flowlet_provider: BackedUpValue;
  auth_key: BackedUpValue;
  models_path: string;
  models_existed: boolean;
  models_content: string | null;
}

export function codexBackupPath(configPath: string): string {
  return path.join(path.dirname(configPath), ".flowlet", CODEX_BACKUP_FILE);
}

function tomlJson(value: unknown): TomlJson {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map(tomlJson);
  if (isJsonObject(value)) {
    const result: { [key: string]: TomlJson } = {};
    for (const [key, item] of Object.entries(value)) result[key] = tomlJson(item);
    return result;
  }
  return null;
}

function stringField(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function boolField(row: Record<string, unknown>, key: string): boolean {
  return row[key] === true;
}

export function inspectCodex(paths: CodexPaths, expectedBaseUrl: string): AgentGlobalConfigReport {
  const { configPath, authPath, modelsPath } = paths;
  const settingsExists = fileExists(configPath);
  const auth = readOptionalJsonObject(authPath);
  const authKey = typeof auth[CODEX_AUTH_KEY] === "string" ? (auth[CODEX_AUTH_KEY] as string).trim() : "";
  const authTokenConfigured = authKey !== "";
  const backupAvailable = fileExists(codexBackupPath(configPath));
  const base = {
    agent_id: "codex",
    settings_path: displayPath(configPath),
    credentials_path: displayPath(authPath),
    settings_exists: settingsExists,
    auth_token_configured: authTokenConfigured,
    api_key_configured: authTokenConfigured,
    backup_available: backupAvailable,
  };
  if (!settingsExists) {
    return buildReport({ ...base, state: "not_configured" });
  }

  let doc: Record<string, unknown>;
  try {
    doc = readTomlValue(configPath);
  } catch (error) {
    return buildReport({ ...base, state: "invalid", error: errorText(error) });
  }

  const model = stringField(doc, "model");
  const modelProvider = stringField(doc, "model_provider");
  const disableResponseStorage = boolField(doc, "disable_response_storage");
  const preferredAuthMethod = stringField(doc, "preferred_auth_method");
  const modelCatalogJson = stringField(doc, "model_catalog_json");
  const modelCatalogConfigured =
    modelCatalogJson === CODEX_MODEL_CATALOG_REF && fileExists(modelsPath);
  const catalogContent = modelCatalogConfigured ? readTextOrNull(modelsPath) : null;
  const catalogDeclares =
    catalogContent !== null &&
    model !== null &&
    catalogDeclaresModel(catalogContent, model);

  const provider = tomlProviderTable(doc, CODEX_PROVIDER_ID);
  const providerBaseUrl = provider !== undefined ? stringField(provider, "base_url") : null;
  const providerWireApi = provider !== undefined ? stringField(provider, "wire_api") : null;
  const providerRequiresAuth = provider !== undefined && boolField(provider, "requires_openai_auth");
  const activeBaseUrl =
    modelProvider !== null
      ? (() => {
          const table =
            doc.model_providers !== undefined && isJsonObject(doc.model_providers)
              ? (doc.model_providers as Record<string, unknown>)[modelProvider]
              : undefined;
          return isJsonObject(table) ? stringField(table, "base_url") : providerBaseUrl;
        })()
      : providerBaseUrl;

  const matchesExpected =
    activeBaseUrl !== null && normalizeUrl(activeBaseUrl) === normalizeUrl(expectedBaseUrl);
  const isFlowlet =
    modelProvider === CODEX_PROVIDER_ID &&
    catalogDeclares &&
    disableResponseStorage &&
    preferredAuthMethod === "apikey" &&
    providerWireApi === CODEX_WIRE_API &&
    providerRequiresAuth &&
    matchesExpected &&
    authTokenConfigured &&
    modelCatalogConfigured;
  const state = isFlowlet
    ? "flowlet"
    : activeBaseUrl !== null && activeBaseUrl.trim() !== "" && !matchesExpected
      ? "other_gateway"
      : modelProvider === CODEX_PROVIDER_ID ||
          provider !== undefined ||
          disableResponseStorage ||
          authTokenConfigured
        ? "partial"
        : "not_configured";

  return buildReport({
    ...base,
    state,
    base_url: providerBaseUrl,
    primary_model: model,
    model_catalog_path: modelCatalogJson,
    model_catalog_configured: modelCatalogConfigured,
  });
}

export function applyCodex(
  paths: CodexPaths,
  expectedBaseUrl: string,
  clientToken: string,
  primaryModel: string,
  modelsCn: Record<string, unknown> | null,
): AgentGlobalConfigReport {
  const { configPath, authPath, modelsPath } = paths;
  if (clientToken.trim() === "") {
    throw new Error("Flowlet 默认 Client Token 未配置，无法写入 Codex");
  }
  const configExisted = fileExists(configPath);
  const authExisted = fileExists(authPath);
  const modelsContentBefore = readTextOrNull(modelsPath);
  let text = configExisted ? readText(configPath) : "";
  const doc = parseToml(text, displayPath(configPath));
  let auth = readOptionalJsonObject(authPath);

  const backupPath = codexBackupPath(configPath);
  const backupCreated = !fileExists(backupPath);
  if (backupCreated) {
    const providerExists = tomlProviderTable(doc, CODEX_PROVIDER_ID) !== undefined;
    const providerJson = tomlProviderTable(doc, CODEX_PROVIDER_ID);
    const topLevel: Record<string, BackedUpValue> = {};
    for (const key of CODEX_MANAGED_TOP_LEVEL) {
      topLevel[key] = backedUpValue(
        Object.prototype.hasOwnProperty.call(doc, key) ? doc[key] : undefined,
      );
    }
    const snapshot: CodexBackup = {
      version: BACKUP_VERSION,
      agent_id: "codex",
      created_at: rfc3339Now(),
      config_path: displayPath(configPath),
      auth_path: displayPath(authPath),
      config_existed: configExisted,
      auth_existed: authExisted,
      provider_table_existed: providerExists,
      top_level: topLevel,
      flowlet_provider: backedUpValue(providerJson),
      auth_key: backedUpValue(auth[CODEX_AUTH_KEY]),
      models_path: displayPath(modelsPath),
      models_existed: modelsContentBefore !== null,
      models_content: modelsContentBefore,
    };
    writeJsonFile(backupPath, snapshot);
  } else {
    // 旧版本备份没有模型目录字段：升级备份，使恢复时能清理 Flowlet 生成的模型目录。
    const existing = readOptionalJsonObject(backupPath);
    if (!Object.prototype.hasOwnProperty.call(existing, "models_path") && typeof existing.agent_id === "string") {
      const upgraded = {
        ...existing,
        models_path: displayPath(modelsPath),
        models_existed: false,
        models_content: null,
      };
      writeJsonFile(backupPath, upgraded);
    }
  }

  text = setTomlTopLevelValue(text, "model", primaryModel);
  text = setTomlTopLevelValue(text, "model_provider", CODEX_PROVIDER_ID);
  text = setTomlTopLevelValue(text, "disable_response_storage", true);
  text = setTomlTopLevelValue(text, "preferred_auth_method", "apikey");
  text = setTomlTopLevelValue(text, "model_catalog_json", CODEX_MODEL_CATALOG_REF);
  text = setTomlProviderTable(text, CODEX_PROVIDER_ID, {
    name: CODEX_PROVIDER_ID,
    base_url: expectedBaseUrl,
    wire_api: CODEX_WIRE_API,
    requires_openai_auth: true,
  });
  auth = { ...auth, [CODEX_AUTH_KEY]: clientToken.trim() };

  // 模型目录按所选模型从 models-cn.json 动态生成（单条目）。
  const modelsContent = codexCatalogContent(modelsCn, primaryModel);
  try {
    writeFilesTransactionally("Codex 配置、凭据与模型目录文件", [
      [configPath, textFileBytes(text)],
      [authPath, jsonFileBytes(auth)],
      [modelsPath, Buffer.from(modelsContent, "utf8")],
    ]);
  } catch (error) {
    if (backupCreated && error instanceof Error && /已回滚/u.test(error.message)) {
      removeFileIfExists(backupPath, "清理 Codex 配置备份失败");
    }
    throw error;
  }
  return inspectCodex(paths, expectedBaseUrl);
}

export function restoreCodex(paths: CodexPaths, expectedBaseUrl: string): AgentGlobalConfigReport {
  const { configPath, authPath, modelsPath } = paths;
  const backupPath = codexBackupPath(configPath);
  if (!fileExists(backupPath)) {
    throw new Error("没有可恢复的 Codex 全局配置备份");
  }
  const backup = parseCodexBackup(readOptionalJsonObject(backupPath));
  if (backup.version !== BACKUP_VERSION || backup.agent_id !== "codex") {
    throw new Error("Codex 全局配置备份版本不受支持");
  }
  if (
    !pathsEqual(backup.config_path, configPath) ||
    !pathsEqual(backup.auth_path, authPath) ||
    (backup.models_path !== "" && !pathsEqual(backup.models_path, modelsPath))
  ) {
    throw new Error("Codex 配置备份路径与当前用户配置不一致");
  }

  let text = fileExists(configPath) ? readText(configPath) : "";
  parseToml(text, displayPath(configPath));
  let auth = readOptionalJsonObject(authPath);

  for (const key of CODEX_MANAGED_TOP_LEVEL) {
    const backedUp = backup.top_level[key] ?? { present: false, value: null };
    if (backedUp.present) {
      text = setTomlTopLevelValue(text, key, tomlJson(backedUp.value));
    } else {
      text = removeTomlTopLevelValue(text, key);
    }
  }

  if (backup.flowlet_provider.present) {
    const value = tomlJson(backup.flowlet_provider.value);
    text = setTomlProviderTable(
      text,
      CODEX_PROVIDER_ID,
      isJsonObject(value) ? (value as Record<string, TomlJson>) : {},
    );
  } else {
    text = removeTomlProviderTable(text, CODEX_PROVIDER_ID);
  }

  if (backup.auth_key.present) {
    auth = { ...auth, [CODEX_AUTH_KEY]: backup.auth_key.value };
  } else {
    const { [CODEX_AUTH_KEY]: _removed, ...rest } = auth;
    auth = rest;
  }

  const configEmpty = Object.keys(parseToml(text, displayPath(configPath))).length === 0;
  const configContent =
    !backup.config_existed && configEmpty ? null : textFileBytes(text);
  const authContent = !backup.auth_existed && Object.keys(auth).length === 0 ? null : jsonFileBytes(auth);
  const modelsContent =
    backup.models_content !== null ? Buffer.from(backup.models_content, "utf8") : null;
  writeFilesTransactionally("Codex 配置、凭据与模型目录文件", [
    [configPath, configContent],
    [authPath, authContent],
    [modelsPath, modelsContent],
  ]);
  removeFileIfExists(backupPath, "配置已恢复，但清理 Flowlet 备份标记失败");
  return inspectCodex(paths, expectedBaseUrl);
}

export function parseCodexBackup(value: Record<string, unknown>): CodexBackup {
  const backed = (entry: unknown): BackedUpValue => {
    if (!isJsonObject(entry)) return { present: false, value: null };
    return { present: entry.present === true, value: entry.value ?? null };
  };
  const topLevel: Record<string, BackedUpValue> = {};
  if (isJsonObject(value.top_level)) {
    for (const [key, entry] of Object.entries(value.top_level)) topLevel[key] = backed(entry);
  }
  return {
    version: typeof value.version === "number" ? value.version : 0,
    agent_id: typeof value.agent_id === "string" ? value.agent_id : "",
    created_at: typeof value.created_at === "string" ? value.created_at : "",
    config_path: typeof value.config_path === "string" ? value.config_path : "",
    auth_path: typeof value.auth_path === "string" ? value.auth_path : "",
    config_existed: value.config_existed === true,
    auth_existed: value.auth_existed === true,
    provider_table_existed: value.provider_table_existed === true,
    top_level: topLevel,
    flowlet_provider: backed(value.flowlet_provider),
    auth_key: backed(value.auth_key),
    models_path: typeof value.models_path === "string" ? value.models_path : "",
    models_existed: value.models_existed === true,
    models_content: typeof value.models_content === "string" ? value.models_content : null,
  };
}