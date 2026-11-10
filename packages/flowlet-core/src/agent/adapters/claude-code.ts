// Claude Code 全局配置 Adapter。
//
// 权威实现：`src-tauri/src/core/agent_global_config/adapters/claude_code.rs`。
// 配置位置：`~/.claude/settings.json`（`CLAUDE_CONFIG_DIR` 可覆盖）。
// 写入 env 中的 Anthropic Base URL / Token / 主模型组 / 快速模型组；
// 主模型组 = 主会话 + Fable/Opus/Sonnet 别名，快速模型组 = Haiku + SMALL_FAST + 子 Agent。
import path from "node:path";

import {
  errorText,
  fileExists,
  readText,
  removeFileIfExists,
  rfc3339Now,
  textFileBytes,
  writeBytesFile,
  writeJsonFile,
} from "../fs.ts";
import { isKnownCatalogModel } from "../models.ts";
import {
  isJsonObject,
  jsoncDelete,
  jsoncSet,
  parseJsoncObject,
  readJsoncSettings,
  readOptionalJsonObject,
} from "../jsonc.ts";
import { displayPath, normalizeUrl } from "../paths.ts";
import { backedUpValue, buildReport, type AgentGlobalConfigReport, type BackedUpValue } from "../report.ts";

const BACKUP_VERSION = 1;
const ACTIVE_BACKUP_FILE = "claude-code-global-config-backup.json";

const MANAGED_FIELDS: ReadonlyArray<string> = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
];

const EXTERNAL_OVERRIDE_FIELDS = MANAGED_FIELDS;

interface ClaudeCodeBackup {
  version: number;
  agent_id: string;
  created_at: string;
  settings_path: string;
  settings_existed: boolean;
  env_existed: boolean;
  fields: Record<string, BackedUpValue>;
}

export function claudeCodeBackupPath(settingsPath: string): string {
  return path.join(path.dirname(settingsPath), ".flowlet", ACTIVE_BACKUP_FILE);
}

export function inspectClaudeCode(settingsPath: string, expectedBaseUrl: string): AgentGlobalConfigReport {
  const settingsExists = fileExists(settingsPath);
  const backupAvailable = fileExists(claudeCodeBackupPath(settingsPath));
  const externalEnvironmentOverrides = EXTERNAL_OVERRIDE_FIELDS.filter(
    (name) => process.env[name] !== undefined,
  );

  const base = {
    agent_id: "claude-code",
    settings_path: displayPath(settingsPath),
    credentials_path: null,
    backup_available: backupAvailable,
    external_environment_overrides: externalEnvironmentOverrides,
  };

  if (!settingsExists) {
    return buildReport({ ...base, settings_exists: false, state: "not_configured" });
  }

  let settings;
  try {
    settings = readJsoncSettings(settingsPath);
  } catch (error) {
    return buildReport({
      ...base,
      settings_exists: true,
      state: "invalid",
      error: errorText(error),
    });
  }

  const env = isJsonObject(settings.env) ? settings.env : {};
  const stringValue = (name: string): string | null => {
    const value = env[name];
    return typeof value === "string" && value.trim() !== "" ? value : null;
  };

  const baseUrl = stringValue("ANTHROPIC_BASE_URL");
  const authTokenConfigured = stringValue("ANTHROPIC_AUTH_TOKEN") !== null;
  const apiKeyConfigured = stringValue("ANTHROPIC_API_KEY") !== null;
  const primaryModel = stringValue("ANTHROPIC_MODEL");
  const fastModel = stringValue("ANTHROPIC_DEFAULT_HAIKU_MODEL");
  const subagentModel = stringValue("CLAUDE_CODE_SUBAGENT_MODEL");
  const primaryKnown = primaryModel !== null && isKnownModel(primaryModel);
  const fastKnown = fastModel !== null && isKnownModel(fastModel);
  const primaryAliasesMatch = aliasGroupMatches(
    ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL"],
    stringValue,
  );
  const fastAliasesMatch = aliasGroupMatches(
    ["ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"],
    stringValue,
  );
  const cloudConflict = [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_MANTLE",
  ].some((name) => stringValue(name) !== null);
  const anyManaged = MANAGED_FIELDS.some((name) => Object.prototype.hasOwnProperty.call(env, name));
  const normalizedExpected = normalizeUrl(expectedBaseUrl);
  const state =
    baseUrl !== null &&
    normalizeUrl(baseUrl) === normalizedExpected &&
    authTokenConfigured &&
    !apiKeyConfigured &&
    !cloudConflict &&
    primaryAliasesMatch &&
    fastAliasesMatch &&
    primaryKnown &&
    fastKnown
      ? "flowlet"
      : baseUrl !== null && normalizeUrl(baseUrl) !== normalizedExpected
        ? "other_gateway"
        : anyManaged
          ? "partial"
          : "not_configured";

  return buildReport({
    ...base,
    settings_exists: true,
    state,
    base_url: baseUrl,
    auth_token_configured: authTokenConfigured,
    api_key_configured: apiKeyConfigured,
    primary_model: primaryModel,
    fast_model: fastModel,
    subagent_model: subagentModel,
  });
}

function isKnownModel(model: string): boolean {
  return isKnownCatalogModel(model);
}

/** 判断一组受管环境变量是否都存在且指向同一个模型值。 */
function aliasGroupMatches(names: ReadonlyArray<string>, stringValue: (name: string) => string | null): boolean {
  const first = stringValue(names[0]);
  if (first === null) return false;
  return names.slice(1).every((name) => stringValue(name) === first);
}

export function applyClaudeCode(
  settingsPath: string,
  expectedBaseUrl: string,
  clientToken: string,
  primaryModel: string,
  fastModel: string,
): AgentGlobalConfigReport {
  if (clientToken.trim() === "") {
    throw new Error("Flowlet 默认 Client Token 未配置，无法写入 Claude Code");
  }

  const settingsExisted = fileExists(settingsPath);
  let text = settingsExisted ? readText(settingsPath) : "{}\n";
  const settings = parseJsoncObject(text, displayPath(settingsPath));
  if (settings.env !== undefined && !isJsonObject(settings.env)) {
    throw new Error("Claude Code settings.json 中 env 必须是 JSON 对象");
  }
  const envExisted = Object.prototype.hasOwnProperty.call(settings, "env");
  const currentEnv = isJsonObject(settings.env) ? settings.env : {};

  const backupPath = claudeCodeBackupPath(settingsPath);
  if (!fileExists(backupPath)) {
    const fields: Record<string, BackedUpValue> = {};
    for (const name of MANAGED_FIELDS) {
      fields[name] = backedUpValue(currentEnv[name]);
    }
    const snapshot: ClaudeCodeBackup = {
      version: BACKUP_VERSION,
      agent_id: "claude-code",
      created_at: rfc3339Now(),
      settings_path: displayPath(settingsPath),
      settings_existed: settingsExisted,
      env_existed: envExisted,
      fields,
    };
    writeJsonFile(backupPath, snapshot);
  }

  if (!isJsonObject(settings.env)) text = jsoncSet(text, ["env"], {});
  for (const name of [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_MANTLE",
  ]) {
    text = jsoncDelete(text, ["env", name]);
  }
  const writes: Array<readonly [string, string]> = [
    ["ANTHROPIC_BASE_URL", expectedBaseUrl],
    ["ANTHROPIC_AUTH_TOKEN", clientToken.trim()],
    ["ANTHROPIC_MODEL", primaryModel],
    ["ANTHROPIC_DEFAULT_FABLE_MODEL", primaryModel],
    ["ANTHROPIC_DEFAULT_OPUS_MODEL", primaryModel],
    ["ANTHROPIC_DEFAULT_SONNET_MODEL", primaryModel],
    ["ANTHROPIC_DEFAULT_HAIKU_MODEL", fastModel],
    ["ANTHROPIC_SMALL_FAST_MODEL", fastModel],
    ["CLAUDE_CODE_SUBAGENT_MODEL", fastModel],
  ];
  for (const [name, value] of writes) {
    text = jsoncSet(text, ["env", name], value);
  }
  writeBytesFile(settingsPath, textFileBytes(text));
  return inspectClaudeCode(settingsPath, expectedBaseUrl);
}

export function restoreClaudeCode(settingsPath: string, expectedBaseUrl: string): AgentGlobalConfigReport {
  const backupPath = claudeCodeBackupPath(settingsPath);
  if (!fileExists(backupPath)) {
    throw new Error("没有可恢复的 Claude Code 全局配置备份");
  }
  const backupValue = readOptionalJsonObject(backupPath);
  const backup = parseBackup(backupValue);
  if (backup.version !== BACKUP_VERSION || backup.agent_id !== "claude-code") {
    throw new Error("Claude Code 全局配置备份版本不受支持");
  }

  let text = fileExists(settingsPath) ? readText(settingsPath) : "{}\n";
  const settings = parseJsoncObject(text, displayPath(settingsPath));
  if (settings.env !== undefined && !isJsonObject(settings.env)) {
    throw new Error("Claude Code settings.json 中 env 必须是 JSON 对象");
  }
  if (!isJsonObject(settings.env)) text = jsoncSet(text, ["env"], {});
  for (const name of MANAGED_FIELDS) {
    const backedUp = backup.fields[name];
    if (backedUp !== undefined && backedUp.present) {
      text = jsoncSet(text, ["env", name], backedUp.value);
    } else {
      text = jsoncDelete(text, ["env", name]);
    }
  }
  const afterRestore = parseJsoncObject(text, displayPath(settingsPath));
  if (!backup.env_existed && isJsonObject(afterRestore.env) && Object.keys(afterRestore.env).length === 0) {
    text = jsoncDelete(text, ["env"]);
  }
  const finalSettings = parseJsoncObject(text, displayPath(settingsPath));

  if (!backup.settings_existed && Object.keys(finalSettings).length === 0) {
    removeFileIfExists(settingsPath, "删除 Flowlet 创建的 Claude Code 配置失败");
  } else {
    writeBytesFile(settingsPath, textFileBytes(text));
  }
  removeFileIfExists(backupPath, "配置已恢复，但清理 Flowlet 备份标记失败");
  return inspectClaudeCode(settingsPath, expectedBaseUrl);
}

function parseBackup(value: unknown): ClaudeCodeBackup {
  if (!isJsonObject(value)) throw new Error("备份格式无效：顶层必须是 JSON 对象");
  const fields: Record<string, BackedUpValue> = {};
  if (isJsonObject(value.fields)) {
    for (const [key, entry] of Object.entries(value.fields)) {
      if (isJsonObject(entry)) {
        fields[key] = {
          present: entry.present === true,
          value: entry.value ?? null,
        };
      }
    }
  }
  return {
    version: typeof value.version === "number" ? value.version : 0,
    agent_id: typeof value.agent_id === "string" ? value.agent_id : "",
    created_at: typeof value.created_at === "string" ? value.created_at : "",
    settings_path: typeof value.settings_path === "string" ? value.settings_path : "",
    settings_existed: value.settings_existed === true,
    env_existed: value.env_existed === true,
    fields,
  };
}
