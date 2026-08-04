use jsonc_parser::ParseOptions;
use jsonc_parser::cst::{CstInputValue, CstObject, CstRootNode};
use jsonc_parser::json;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use super::agent_environment::display_path;
use super::codex_account::codex_home;
use super::codex_model_catalog;

const BACKUP_VERSION: u32 = 1;
const PRIMARY_MODEL: &str = "flowlet-pro";
const FAST_MODEL: &str = "flowlet-flash";
/// Claude Code 长上下文后缀：网关部署下 Claude Code 无法验证上游 1M 支持，
/// 在模型名后附加本后缀即可启用百万级上下文窗口预算；Claude Code 会在
/// 发送请求前剥离后缀，Flowlet 代理层也会防御性剥离（见 proxy_http.rs）。
const LONG_CONTEXT_SUFFIX: &str = "[1m]";
const FLOWLET_DIR: &str = ".flowlet";
const ACTIVE_BACKUP_FILE: &str = "claude-code-global-config-backup.json";
const OPENCODE_BACKUP_FILE: &str = "opencode-global-config-backup.json";
const OPENCODE_PROVIDER_ID: &str = "flowlet";
const OPENCODE_PRIMARY_MODEL: &str = "flowlet/flowlet-pro";
const OPENCODE_FAST_MODEL: &str = "flowlet/flowlet-flash";
const OPENCODE_PERMISSION_PLUGIN_FILE: &str = "plugins/flowlet.ts";
const PI_BACKUP_FILE: &str = "pi-global-config-backup.json";
const PI_PROVIDER_ID: &str = "flowlet";
const PI_PRIMARY_MODEL: &str = "flowlet-pro";
const PI_FAST_MODEL: &str = "flowlet-flash";
const CODEX_BACKUP_FILE: &str = "codex-global-config-backup.json";
const CODEX_PROVIDER_ID: &str = "flowlet";
const CODEX_PRIMARY_MODEL: &str = "flowlet-pro";
const CODEX_WIRE_API: &str = "responses";
/// Codex 系（CLI / ChatGPT Desktop / VS Code 插件）读取同一份 auth.json 中的
/// OPENAI_API_KEY（配合 provider 的 requires_openai_auth）。
const CODEX_AUTH_KEY: &str = "OPENAI_API_KEY";
/// Codex `model_catalog_json` 指向的模型目录引用值（`~` 由 Codex 展开，与 DeepSeek/千问文档一致）。
const CODEX_MODEL_CATALOG_REF: &str = "~/.codex/model-catalog.flowlet.json";
/// `~/.codex` 下由 Flowlet 生成的模型目录文件名（带 Flowlet 命名空间，避免覆盖 DeepSeek/千问的目录文件）。
const CODEX_MODEL_CATALOG_FILE: &str = "model-catalog.flowlet.json";

const MANAGED_FIELDS: &[&str] = &[
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

const EXTERNAL_OVERRIDE_FIELDS: &[&str] = &[
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentGlobalConfigState {
    NotConfigured,
    Flowlet,
    OtherGateway,
    Partial,
    Invalid,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AgentGlobalConfigReport {
    pub agent_id: String,
    pub settings_path: String,
    pub credentials_path: Option<String>,
    pub settings_exists: bool,
    pub state: AgentGlobalConfigState,
    pub base_url: Option<String>,
    pub auth_token_configured: bool,
    pub api_key_configured: bool,
    pub primary_model: Option<String>,
    pub fast_model: Option<String>,
    pub subagent_model: Option<String>,
    /// 仅 Codex：config.toml 中 `model_catalog_json` 的当前值。
    #[serde(default)]
    pub model_catalog_path: Option<String>,
    /// 仅 Codex：`model_catalog_json` 指向 Flowlet 生成的模型目录且文件在位。
    #[serde(default)]
    pub model_catalog_configured: bool,
    /// Claude Code 主模型是否写入 `[1m]` 长上下文后缀；其他 Agent 恒为 false。
    #[serde(default)]
    pub long_context: bool,
    pub backup_available: bool,
    pub external_environment_overrides: Vec<String>,
    pub error: Option<String>,
    /// 仅 Pi：Flowlet 会话扩展（`~/.pi/agent/extensions/flowlet.ts`）是否在位。
    /// 该扩展为 Pi 请求注入 x-flowlet-session 头，使 Flowlet 能按会话归并请求。
    #[serde(default)]
    pub session_extension: bool,
    /// 仅 OpenCode：Flowlet 权限事件插件是否在位。插件用于发现 Desktop 动态端口实例。
    #[serde(default)]
    pub opencode_permission_bridge: bool,
}

/// Agent 全局配置一键写入的可选参数；某 Agent 不支持的选项会被忽略。
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGlobalConfigOptions {
    /// 仅 Claude Code：为主模型环境变量附加 `[1m]` 后缀，启用百万级上下文窗口预算。
    #[serde(default)]
    pub long_context: bool,
    /// 仅 Pi：是否为 Pi 安装会话扩展（`~/.pi/agent/extensions/flowlet.ts`）。
    /// 安装后可为发往 Flowlet 渠道的请求注入 x-flowlet-session 头，使 Flowlet 能按会话
    /// 归并请求；关闭则不安装（Pi 仍可作为 Flowlet 客户端使用，但无法做会话维度串联）。
    /// 默认开启。
    #[serde(default = "true_bool")]
    pub session_extension: bool,
}

fn true_bool() -> bool {
    true
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct BackedUpValue {
    present: bool,
    value: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct GlobalConfigBackup {
    version: u32,
    agent_id: String,
    created_at: String,
    settings_path: String,
    settings_existed: bool,
    env_existed: bool,
    fields: BTreeMap<String, BackedUpValue>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct OpenCodeConfigBackup {
    version: u32,
    agent_id: String,
    created_at: String,
    settings_path: String,
    auth_path: String,
    settings_existed: bool,
    auth_existed: bool,
    provider_existed: bool,
    schema: BackedUpValue,
    model: BackedUpValue,
    small_model: BackedUpValue,
    #[serde(default)]
    disabled_providers: BackedUpValue,
    #[serde(default)]
    enabled_providers: BackedUpValue,
    #[serde(default)]
    server: Option<BackedUpValue>,
    flowlet_provider: BackedUpValue,
    flowlet_auth: BackedUpValue,
    #[serde(default)]
    permission_plugin_path: String,
    #[serde(default)]
    permission_plugin_previous: BackedUpValue,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PiConfigBackup {
    version: u32,
    agent_id: String,
    created_at: String,
    settings_path: String,
    models_path: String,
    auth_path: String,
    extension_path: String,
    settings_existed: bool,
    models_existed: bool,
    auth_existed: bool,
    providers_existed: bool,
    extension_existed: bool,
    default_provider: BackedUpValue,
    default_model: BackedUpValue,
    flowlet_provider: BackedUpValue,
    flowlet_auth: BackedUpValue,
    // 扩展写入前的原始内容（若存在），恢复时写回；不存在时恢复即删除。
    extension_previous: BackedUpValue,
}

fn config_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub fn inspect_agent_global_config(
    agent_id: &str,
    expected_base_url: &str,
) -> Result<AgentGlobalConfigReport, String> {
    let _guard = config_lock()
        .lock()
        .map_err(|_| "Agent 全局配置锁已损坏".to_string())?;
    match agent_id {
        "claude-code" => inspect_claude_code(&claude_settings_path()?, expected_base_url),
        "opencode" => inspect_opencode(
            &opencode_settings_path()?,
            &opencode_auth_path()?,
            &opencode_permission_plugin_path()?,
            expected_base_url,
        ),
        "pi" => inspect_pi(
            &pi_settings_path()?,
            &pi_models_path()?,
            &pi_auth_path()?,
            &pi_extension_path()?,
            expected_base_url,
        ),
        "codex" => inspect_codex(
            &codex_config_path(),
            &codex_auth_path(),
            &codex_models_path(),
            expected_base_url,
        ),
        _ => Err(format!("暂不支持管理 Agent 全局配置：{agent_id}")),
    }
}

pub fn apply_agent_global_config(
    agent_id: &str,
    expected_base_url: &str,
    client_token: &str,
    options: Option<&AgentGlobalConfigOptions>,
) -> Result<AgentGlobalConfigReport, String> {
    let _guard = config_lock()
        .lock()
        .map_err(|_| "Agent 全局配置锁已损坏".to_string())?;
    match agent_id {
        "claude-code" => apply_claude_code(
            &claude_settings_path()?,
            expected_base_url,
            client_token,
            options.is_some_and(|options| options.long_context),
        ),
        "opencode" => apply_opencode(
            &opencode_settings_path()?,
            &opencode_auth_path()?,
            &opencode_permission_plugin_path()?,
            expected_base_url,
            client_token,
        ),
        "pi" => apply_pi(
            &pi_settings_path()?,
            &pi_models_path()?,
            &pi_auth_path()?,
            &pi_extension_path()?,
            expected_base_url,
            client_token,
            // 会话扩展默认安装；仅当用户明确关闭开关时才不安装。
            options
                .as_ref()
                .map_or(true, |options| options.session_extension),
        ),
        "codex" => apply_codex(
            &codex_config_path(),
            &codex_auth_path(),
            &codex_models_path(),
            expected_base_url,
            client_token,
        ),
        _ => Err(format!("暂不支持管理 Agent 全局配置：{agent_id}")),
    }
}

pub fn restore_agent_global_config(
    agent_id: &str,
    expected_base_url: &str,
) -> Result<AgentGlobalConfigReport, String> {
    let _guard = config_lock()
        .lock()
        .map_err(|_| "Agent 全局配置锁已损坏".to_string())?;
    match agent_id {
        "claude-code" => restore_claude_code(&claude_settings_path()?, expected_base_url),
        "opencode" => restore_opencode(
            &opencode_settings_path()?,
            &opencode_auth_path()?,
            &opencode_permission_plugin_path()?,
            expected_base_url,
        ),
        "pi" => restore_pi(
            &pi_settings_path()?,
            &pi_models_path()?,
            &pi_auth_path()?,
            &pi_extension_path()?,
            expected_base_url,
        ),
        "codex" => restore_codex(
            &codex_config_path(),
            &codex_auth_path(),
            &codex_models_path(),
            expected_base_url,
        ),
        _ => Err(format!("暂不支持管理 Agent 全局配置：{agent_id}")),
    }
}

fn claude_config_dir() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        if !value.is_empty() {
            return Ok(PathBuf::from(value));
        }
    }
    dirs::home_dir()
        .map(|home| home.join(".claude"))
        .ok_or_else(|| "无法确定 Claude Code 用户配置目录".to_string())
}

fn claude_settings_path() -> Result<PathBuf, String> {
    let path = claude_config_dir()?.join("settings.json");
    if path.exists() {
        std::fs::canonicalize(&path)
            .map_err(|error| format!("无法解析 Claude Code 配置路径 {}：{error}", path.display()))
    } else {
        Ok(path)
    }
}

fn opencode_settings_path() -> Result<PathBuf, String> {
    let directory = dirs::home_dir()
        .map(|home| home.join(".config").join("opencode"))
        .ok_or_else(|| "无法确定 OpenCode 用户配置目录".to_string())?;
    let jsonc = directory.join("opencode.jsonc");
    let json = directory.join("opencode.json");
    let path = if jsonc.is_file() {
        jsonc
    } else if json.is_file() {
        json
    } else {
        jsonc
    };
    if path.exists() {
        std::fs::canonicalize(&path)
            .map_err(|error| format!("无法解析 OpenCode 配置路径 {}：{error}", path.display()))
    } else {
        Ok(path)
    }
}

fn opencode_auth_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| {
            home.join(".local")
                .join("share")
                .join("opencode")
                .join("auth.json")
        })
        .ok_or_else(|| "无法确定 OpenCode 凭据文件路径".to_string())
}

fn opencode_permission_plugin_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| {
            home.join(".config")
                .join("opencode")
                .join(OPENCODE_PERMISSION_PLUGIN_FILE)
        })
        .ok_or_else(|| "无法确定 OpenCode 权限事件插件路径".to_string())
}

/// OpenCode CLI、Web 与 Desktop 都会加载全局插件。每个进程按 PID 写一份短期心跳，
/// Flowlet 因而无需猜测 Desktop sidecar 的动态端口，也不会让多个并行实例互相覆盖。
const OPENCODE_PERMISSION_PLUGIN_SOURCE: &str = r#"// Flowlet 自动写入：桥接 OpenCode 进程内待确认权限状态。
import path from "node:path"
import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises"

export const FlowletPermissionBridge = async ({ client, serverUrl, directory, worktree }) => {
  const home = process.env.USERPROFILE || process.env.HOME
  if (!home) return {}
  const root = path.join(home, ".flowlet", "opencode-control")
  const instanceKey = createHash("sha256")
    .update(String(directory || worktree || serverUrl))
    .digest("hex")
    .slice(0, 12)
  const statePath = path.join(root, `state-${process.pid}-${instanceKey}.json`)
  const stateTempPath = `${statePath}.tmp`
  const permissions = new Map()
  const normalizePermission = (value) => ({
    id: value.id,
    sessionID: value.sessionID,
    permission: value.permission || value.type || "unknown",
    patterns: value.patterns || (Array.isArray(value.pattern) ? value.pattern : value.pattern ? [value.pattern] : []),
    metadata: value.metadata || {},
    always: value.always || [],
    tool: value.tool || (value.messageID ? { messageID: value.messageID, callID: value.callID || "" } : undefined),
  })

  await mkdir(root, { recursive: true })
  try {
    const response = await client.permission?.list?.()
    const pending = Array.isArray(response) ? response : response?.data
    if (Array.isArray(pending)) {
      for (const value of pending) permissions.set(value.id, normalizePermission(value))
    }
  } catch {}
  let persistQueue = Promise.resolve()
  const persist = () => {
    const snapshot = JSON.stringify({
      pid: process.pid,
      serverUrl: String(serverUrl),
      updatedAt: Date.now(),
      permissions: [...permissions.values()],
    })
    persistQueue = persistQueue.catch(() => {}).then(async () => {
      await writeFile(stateTempPath, snapshot, "utf8")
      await rename(stateTempPath, statePath)
    })
    return persistQueue
  }
  await persist()
  const consumeReplies = async () => {
    for (const name of await readdir(root)) {
      if (!name.startsWith("reply-") || !name.endsWith(".json")) continue
      const replyPath = path.join(root, name)
      try {
        const command = JSON.parse(await readFile(replyPath, "utf8"))
        const permission = permissions.get(command.permissionId)
        if (!permission) continue
        if (client.permission?.reply) {
          await client.permission.reply({ requestID: command.permissionId, reply: command.reply })
        } else if (client.postSessionIdPermissionsPermissionId) {
          await client.postSessionIdPermissionsPermissionId({
            path: { id: permission.sessionID, permissionID: command.permissionId },
            body: { response: command.reply },
          })
        } else {
          throw new Error("当前 OpenCode SDK 不支持 permission.reply")
        }
        await unlink(replyPath)
      } catch {}
    }
  }
  const heartbeat = setInterval(() => {
    void persist()
    void consumeReplies()
  }, 500)

  return {
    event: async ({ event }) => {
      if (event.type === "permission.asked" || event.type === "permission.updated") {
        permissions.set(event.properties.id, normalizePermission(event.properties))
        await persist()
      } else if (event.type === "permission.replied") {
        permissions.delete(event.properties.requestID || event.properties.permissionID)
        await persist()
      }
    },
    dispose: async () => {
      clearInterval(heartbeat)
      await persistQueue.catch(() => {})
      try { await unlink(statePath) } catch {}
      try { await unlink(stateTempPath) } catch {}
    },
  }
}
"#;

// Pi 的用户级配置统一位于 `~/.pi/agent/`：`models.json` 声明自定义 Provider，
// `auth.json`（0600）保存 Provider 凭据，`settings.json` 决定默认 Provider 和模型。
fn pi_agent_path(file_name: &str) -> Result<PathBuf, String> {
    let path = dirs::home_dir()
        .map(|home| home.join(".pi").join("agent").join(file_name))
        .ok_or_else(|| format!("无法确定 Pi 用户配置路径：{file_name}"))?;
    if path.exists() {
        std::fs::canonicalize(&path)
            .map_err(|error| format!("无法解析 Pi 配置路径 {}：{error}", path.display()))
    } else {
        Ok(path)
    }
}

fn pi_settings_path() -> Result<PathBuf, String> {
    pi_agent_path("settings.json")
}

fn pi_models_path() -> Result<PathBuf, String> {
    pi_agent_path("models.json")
}

fn pi_auth_path() -> Result<PathBuf, String> {
    pi_agent_path("auth.json")
}

// Pi 会话扩展位于 `~/.pi/agent/extensions/flowlet.ts`，Pi 启动时由 jiti 自动加载
// （无需编译）。扩展通过 `before_provider_headers` 事件在每次 LLM 请求 headers
// 组装完成后注入 x-flowlet-session 头，使 Flowlet 能把 Pi 请求按会话归并。
fn pi_extension_path() -> Result<PathBuf, String> {
    pi_agent_path("extensions/flowlet.ts")
}

// Pi 会话扩展源码。仅在请求发往 Flowlet 渠道（x-flowlet-client: pi）时注入，
// 避免污染 Pi 到其他 Provider 的请求。注入的 session id 与 Pi 原生会话文件
// 头行的 `id` 一致，供 Flowlet 在本地做会话归属；Flowlet 在转发上游前会将其剥离。
const PI_SESSION_EXTENSION_SOURCE: &str = r#"// Flowlet 自动写入：为 Pi 请求注入会话标识，使 Flowlet 能按会话归属请求。
// 该扩展在每次 LLM 请求 headers 组装完成后，检测是否发往 Flowlet 渠道
// （x-flowlet-client: pi），若是则注入 x-flowlet-session 头，值为当前会话 UUID
// （与 ~/.pi/agent/sessions/ 下会话文件头行的 id 一致）。该头仅用于本地归属，
// Flowlet 在转发上游前会将其剥离，不参与鉴权或路由。
export default function (pi) {
  pi.on("before_provider_headers", (event, ctx) => {
    if (event.headers?.["x-flowlet-client"] !== "pi") return;
    try {
      const sessionId = ctx?.sessionManager?.getSessionId?.();
      if (typeof sessionId === "string" && sessionId.length > 0) {
        event.headers["x-flowlet-session"] = sessionId;
      }
    } catch {
      // 忽略：无法获取会话 id 时不阻塞请求。
    }
  });
}
"#;

fn inspect_claude_code(
    settings_path: &Path,
    expected_base_url: &str,
) -> Result<AgentGlobalConfigReport, String> {
    let settings_exists = settings_path.is_file();
    let backup_available = backup_path(settings_path).is_file();
    let external_environment_overrides = EXTERNAL_OVERRIDE_FIELDS
        .iter()
        .filter(|name| std::env::var_os(name).is_some())
        .map(|name| (*name).to_string())
        .collect::<Vec<_>>();

    if !settings_exists {
        return Ok(AgentGlobalConfigReport {
            agent_id: "claude-code".to_string(),
            settings_path: display_path(settings_path),
            credentials_path: None,
            settings_exists: false,
            state: AgentGlobalConfigState::NotConfigured,
            base_url: None,
            auth_token_configured: false,
            api_key_configured: false,
            primary_model: None,
            fast_model: None,
            subagent_model: None,
            model_catalog_path: None,
            model_catalog_configured: false,
            long_context: false,
            backup_available,
            external_environment_overrides,
            error: None,
            session_extension: false,
            opencode_permission_bridge: false,
        });
    }

    let settings = match read_settings(settings_path) {
        Ok(settings) => settings,
        Err(error) => {
            return Ok(AgentGlobalConfigReport {
                agent_id: "claude-code".to_string(),
                settings_path: display_path(settings_path),
                credentials_path: None,
                settings_exists: true,
                state: AgentGlobalConfigState::Invalid,
                base_url: None,
                auth_token_configured: false,
                api_key_configured: false,
                primary_model: None,
                fast_model: None,
                subagent_model: None,
                model_catalog_path: None,
                model_catalog_configured: false,
                long_context: false,
                backup_available,
                external_environment_overrides,
                error: Some(error),
                session_extension: false,
                opencode_permission_bridge: false,
            });
        }
    };
    report_from_settings(
        settings_path,
        &settings,
        expected_base_url,
        backup_available,
        external_environment_overrides,
    )
}

fn has_long_context_suffix(value: &str) -> bool {
    value.to_ascii_lowercase().ends_with(LONG_CONTEXT_SUFFIX)
}

fn strip_long_context_suffix(value: &str) -> &str {
    if has_long_context_suffix(value) {
        &value[..value.len() - LONG_CONTEXT_SUFFIX.len()]
    } else {
        value
    }
}

fn report_from_settings(
    settings_path: &Path,
    settings: &Value,
    expected_base_url: &str,
    backup_available: bool,
    external_environment_overrides: Vec<String>,
) -> Result<AgentGlobalConfigReport, String> {
    let env = settings
        .as_object()
        .and_then(|root| root.get("env"))
        .and_then(Value::as_object);
    let string_value = |name: &str| {
        env.and_then(|values| values.get(name))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(ToOwned::to_owned)
    };

    let base_url = string_value("ANTHROPIC_BASE_URL");
    let auth_token_configured = string_value("ANTHROPIC_AUTH_TOKEN").is_some();
    let api_key_configured = string_value("ANTHROPIC_API_KEY").is_some();
    let primary_model = string_value("ANTHROPIC_MODEL");
    let fast_model = string_value("ANTHROPIC_DEFAULT_HAIKU_MODEL");
    let subagent_model = string_value("CLAUDE_CODE_SUBAGENT_MODEL");
    // 主模型允许携带 `[1m]` 长上下文后缀，比较收敛状态前先剥离。
    let aliases_match = [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_FABLE_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
    ]
    .iter()
    .all(|name| {
        string_value(name).as_deref().map(strip_long_context_suffix) == Some(PRIMARY_MODEL)
    }) && fast_model.as_deref() == Some(FAST_MODEL);
    // 写入时四个主模型变量同时带后缀；检测只看 ANTHROPIC_MODEL 即可反映开关状态。
    let long_context = primary_model
        .as_deref()
        .is_some_and(has_long_context_suffix);
    // 遗留的 ANTHROPIC_SMALL_FAST_MODEL 在会话标题生成等后台任务中仍优先于
    // ANTHROPIC_DEFAULT_HAIKU_MODEL 生效，必须一并收敛到 FAST_MODEL。
    let small_fast_matches =
        string_value("ANTHROPIC_SMALL_FAST_MODEL").as_deref() == Some(FAST_MODEL);
    let subagent_matches = subagent_model.as_deref() == Some(FAST_MODEL);
    let cloud_conflict = [
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "CLAUDE_CODE_USE_MANTLE",
    ]
    .iter()
    .any(|name| string_value(name).is_some());
    let any_managed = MANAGED_FIELDS
        .iter()
        .any(|name| env.is_some_and(|values| values.contains_key(*name)));
    let expected_base_url = normalize_url(expected_base_url);
    let state = if base_url.as_deref().map(normalize_url).as_deref()
        == Some(expected_base_url.as_str())
        && auth_token_configured
        && !api_key_configured
        && !cloud_conflict
        && aliases_match
        && small_fast_matches
        && subagent_matches
    {
        AgentGlobalConfigState::Flowlet
    } else if base_url
        .as_deref()
        .is_some_and(|value| normalize_url(value) != expected_base_url)
    {
        AgentGlobalConfigState::OtherGateway
    } else if any_managed {
        AgentGlobalConfigState::Partial
    } else {
        AgentGlobalConfigState::NotConfigured
    };

    Ok(AgentGlobalConfigReport {
        agent_id: "claude-code".to_string(),
        settings_path: display_path(settings_path),
        credentials_path: None,
        settings_exists: true,
        state,
        base_url,
        auth_token_configured,
        api_key_configured,
        primary_model,
        fast_model,
        subagent_model,
        model_catalog_path: None,
        model_catalog_configured: false,
        long_context,
        backup_available,
        external_environment_overrides,
        error: None,
        session_extension: false,
        opencode_permission_bridge: false,
    })
}

fn apply_claude_code(
    settings_path: &Path,
    expected_base_url: &str,
    client_token: &str,
    long_context: bool,
) -> Result<AgentGlobalConfigReport, String> {
    if client_token.trim().is_empty() {
        return Err("Flowlet 默认 Client Token 未配置，无法写入 Claude Code".to_string());
    }

    let settings_existed = settings_path.is_file();
    let mut settings = if settings_existed {
        read_settings(settings_path)?
    } else {
        Value::Object(Map::new())
    };
    let root = settings
        .as_object_mut()
        .ok_or_else(|| "Claude Code settings.json 顶层必须是 JSON 对象".to_string())?;
    let env_existed = root.contains_key("env");
    let env = ensure_env_object(root)?;

    let backup = backup_path(settings_path);
    if !backup.is_file() {
        let fields = MANAGED_FIELDS
            .iter()
            .map(|name| {
                let value = env.get(*name);
                (
                    (*name).to_string(),
                    BackedUpValue {
                        present: value.is_some(),
                        value: value.cloned().unwrap_or(Value::Null),
                    },
                )
            })
            .collect();
        let snapshot = GlobalConfigBackup {
            version: BACKUP_VERSION,
            agent_id: "claude-code".to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            settings_path: display_path(settings_path),
            settings_existed,
            env_existed,
            fields,
        };
        write_json_file(
            &backup,
            &serde_json::to_value(snapshot).map_err(|e| e.to_string())?,
        )?;
    }

    for name in [
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "CLAUDE_CODE_USE_MANTLE",
    ] {
        env.remove(name);
    }
    // `[1m]` 后缀只附加到主模型别名：Claude Code 据此启用百万级上下文窗口预算，
    // 并在发送请求前剥离后缀。快速模型用于会话标题等后台任务，无需长上下文。
    let primary_value = if long_context {
        format!("{PRIMARY_MODEL}{LONG_CONTEXT_SUFFIX}")
    } else {
        PRIMARY_MODEL.to_string()
    };
    for (name, value) in [
        ("ANTHROPIC_BASE_URL", expected_base_url),
        ("ANTHROPIC_AUTH_TOKEN", client_token.trim()),
        ("ANTHROPIC_MODEL", primary_value.as_str()),
        ("ANTHROPIC_DEFAULT_FABLE_MODEL", primary_value.as_str()),
        ("ANTHROPIC_DEFAULT_OPUS_MODEL", primary_value.as_str()),
        ("ANTHROPIC_DEFAULT_SONNET_MODEL", primary_value.as_str()),
        ("ANTHROPIC_DEFAULT_HAIKU_MODEL", FAST_MODEL),
        ("ANTHROPIC_SMALL_FAST_MODEL", FAST_MODEL),
        ("CLAUDE_CODE_SUBAGENT_MODEL", FAST_MODEL),
    ] {
        env.insert(name.to_string(), Value::String(value.to_string()));
    }

    write_json_file(settings_path, &settings)?;
    inspect_claude_code(settings_path, expected_base_url)
}

fn restore_claude_code(
    settings_path: &Path,
    expected_base_url: &str,
) -> Result<AgentGlobalConfigReport, String> {
    let backup_path = backup_path(settings_path);
    if !backup_path.is_file() {
        return Err("没有可恢复的 Claude Code 全局配置备份".to_string());
    }
    let backup_value = read_settings(&backup_path)?;
    let backup: GlobalConfigBackup =
        serde_json::from_value(backup_value).map_err(|error| format!("备份格式无效：{error}"))?;
    if backup.version != BACKUP_VERSION || backup.agent_id != "claude-code" {
        return Err("Claude Code 全局配置备份版本不受支持".to_string());
    }

    let mut settings = if settings_path.is_file() {
        read_settings(settings_path)?
    } else {
        Value::Object(Map::new())
    };
    let root = settings
        .as_object_mut()
        .ok_or_else(|| "Claude Code settings.json 顶层必须是 JSON 对象".to_string())?;
    let env = ensure_env_object(root)?;
    for name in MANAGED_FIELDS {
        match backup.fields.get(*name) {
            Some(backed_up) if backed_up.present => {
                env.insert((*name).to_string(), backed_up.value.clone());
            }
            _ => {
                env.remove(*name);
            }
        }
    }
    if !backup.env_existed && env.is_empty() {
        root.remove("env");
    }

    if !backup.settings_existed && root.is_empty() {
        if settings_path.is_file() {
            std::fs::remove_file(settings_path)
                .map_err(|error| format!("删除 Flowlet 创建的 Claude Code 配置失败：{error}"))?;
        }
    } else {
        write_json_file(settings_path, &settings)?;
    }
    std::fs::remove_file(&backup_path)
        .map_err(|error| format!("配置已恢复，但清理 Flowlet 备份标记失败：{error}"))?;
    inspect_claude_code(settings_path, expected_base_url)
}

fn inspect_opencode(
    settings_path: &Path,
    auth_path: &Path,
    permission_plugin_path: &Path,
    expected_base_url: &str,
) -> Result<AgentGlobalConfigReport, String> {
    let settings_exists = settings_path.is_file();
    let backup_available = opencode_backup_path(settings_path).is_file();
    // 仅有同名文件不代表桥接可用：旧版插件曾依赖 Desktop 中不存在的 Bun 全局对象。
    // 必须与当前托管源码一致，过期或被改写的插件应提示用户重新应用配置。
    let permission_bridge =
        managed_text_file_matches(permission_plugin_path, OPENCODE_PERMISSION_PLUGIN_SOURCE);
    let external_environment_overrides = ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT"]
        .iter()
        .filter(|name| std::env::var_os(name).is_some())
        .map(|name| (*name).to_string())
        .collect::<Vec<_>>();
    if !settings_exists {
        return Ok(AgentGlobalConfigReport {
            agent_id: "opencode".to_string(),
            settings_path: display_path(settings_path),
            credentials_path: Some(display_path(auth_path)),
            settings_exists: false,
            state: AgentGlobalConfigState::NotConfigured,
            base_url: None,
            auth_token_configured: false,
            api_key_configured: false,
            primary_model: None,
            fast_model: None,
            subagent_model: None,
            model_catalog_path: None,
            model_catalog_configured: false,
            long_context: false,
            backup_available,
            external_environment_overrides,
            error: None,
            session_extension: false,
            opencode_permission_bridge: permission_bridge,
        });
    }

    let settings = match read_jsonc_settings(settings_path) {
        Ok(settings) => settings,
        Err(error) => {
            return Ok(AgentGlobalConfigReport {
                agent_id: "opencode".to_string(),
                settings_path: display_path(settings_path),
                credentials_path: Some(display_path(auth_path)),
                settings_exists: true,
                state: AgentGlobalConfigState::Invalid,
                base_url: None,
                auth_token_configured: false,
                api_key_configured: false,
                primary_model: None,
                fast_model: None,
                subagent_model: None,
                model_catalog_path: None,
                model_catalog_configured: false,
                long_context: false,
                backup_available,
                external_environment_overrides,
                error: Some(error),
                session_extension: false,
                opencode_permission_bridge: permission_bridge,
            });
        }
    };
    let auth = match read_optional_json_object(auth_path) {
        Ok(auth) => auth,
        Err(error) => {
            return Ok(AgentGlobalConfigReport {
                agent_id: "opencode".to_string(),
                settings_path: display_path(settings_path),
                credentials_path: Some(display_path(auth_path)),
                settings_exists: true,
                state: AgentGlobalConfigState::Invalid,
                base_url: None,
                auth_token_configured: false,
                api_key_configured: false,
                primary_model: None,
                fast_model: None,
                subagent_model: None,
                model_catalog_path: None,
                model_catalog_configured: false,
                long_context: false,
                backup_available,
                external_environment_overrides,
                error: Some(error),
                session_extension: false,
                opencode_permission_bridge: permission_bridge,
            });
        }
    };
    let provider = settings.pointer("/provider/flowlet");
    let base_url = provider
        .and_then(|value| value.pointer("/options/baseURL"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned);
    let api_key_configured = auth
        .pointer("/flowlet/key")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    let auth_type_matches = auth.pointer("/flowlet/type").and_then(Value::as_str) == Some("api");
    let primary_model = settings
        .get("model")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let fast_model = settings
        .get("small_model")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let provider_shape_matches = provider.is_some_and(|provider| {
        provider.get("npm").and_then(Value::as_str) == Some("@ai-sdk/openai-compatible")
            && provider.pointer("/models/flowlet-pro").is_some()
            && provider.pointer("/models/flowlet-flash").is_some()
    });
    let disabled = string_array_contains(settings.get("disabled_providers"), OPENCODE_PROVIDER_ID);
    let enabled = settings.get("enabled_providers").is_none()
        || string_array_contains(settings.get("enabled_providers"), OPENCODE_PROVIDER_ID);
    let provider_enabled = !disabled && enabled;
    let expected_base_url = normalize_url(expected_base_url);
    let base_url_matches =
        base_url.as_deref().map(normalize_url).as_deref() == Some(expected_base_url.as_str());
    let state = if base_url_matches
        && api_key_configured
        && auth_type_matches
        && provider_shape_matches
        && provider_enabled
        && primary_model.as_deref() == Some(OPENCODE_PRIMARY_MODEL)
        && fast_model.as_deref() == Some(OPENCODE_FAST_MODEL)
        && permission_bridge
    {
        AgentGlobalConfigState::Flowlet
    } else if base_url
        .as_deref()
        .is_some_and(|value| normalize_url(value) != expected_base_url)
    {
        AgentGlobalConfigState::OtherGateway
    } else if provider.is_some()
        || auth.get("flowlet").is_some()
        || primary_model
            .as_deref()
            .is_some_and(|model| model.starts_with("flowlet/"))
        || fast_model
            .as_deref()
            .is_some_and(|model| model.starts_with("flowlet/"))
        || permission_bridge
    {
        AgentGlobalConfigState::Partial
    } else {
        AgentGlobalConfigState::NotConfigured
    };

    Ok(AgentGlobalConfigReport {
        agent_id: "opencode".to_string(),
        settings_path: display_path(settings_path),
        credentials_path: Some(display_path(auth_path)),
        settings_exists: true,
        state,
        base_url,
        auth_token_configured: api_key_configured,
        api_key_configured,
        primary_model,
        fast_model,
        subagent_model: None,
        model_catalog_path: None,
        model_catalog_configured: false,
        long_context: false,
        backup_available,
        external_environment_overrides,
        error: None,
        session_extension: false,
        opencode_permission_bridge: permission_bridge,
    })
}

fn apply_opencode(
    settings_path: &Path,
    auth_path: &Path,
    permission_plugin_path: &Path,
    expected_base_url: &str,
    client_token: &str,
) -> Result<AgentGlobalConfigReport, String> {
    if client_token.trim().is_empty() {
        return Err("Flowlet 默认 Client Token 未配置，无法写入 OpenCode".to_string());
    }
    let settings_existed = settings_path.is_file();
    let auth_existed = auth_path.is_file();
    let permission_plugin_previous = if permission_plugin_path.is_file() {
        Some(
            std::fs::read_to_string(permission_plugin_path).map_err(|error| {
                format!("读取 {} 失败：{error}", permission_plugin_path.display())
            })?,
        )
    } else {
        None
    };
    let mut auth = read_optional_json_object(auth_path)?;
    let source = if settings_existed {
        std::fs::read_to_string(settings_path)
            .map_err(|error| format!("读取 {} 失败：{error}", settings_path.display()))?
    } else {
        "{}\n".to_string()
    };
    let root = CstRootNode::parse(&source, &ParseOptions::default())
        .map_err(|error| format!("解析 {} 失败：{error}", settings_path.display()))?;
    let root_object = root
        .object_value()
        .ok_or_else(|| "OpenCode 配置文件顶层必须是 JSON 对象".to_string())?;
    let settings = root_object
        .to_serde_value()
        .ok_or_else(|| "OpenCode 配置文件顶层必须是 JSON 对象".to_string())?;
    let provider_existed = settings.get("provider").is_some();
    if settings
        .get("provider")
        .is_some_and(|value| !value.is_object())
    {
        return Err("OpenCode 配置中的 provider 必须是 JSON 对象".to_string());
    }
    if settings
        .get("server")
        .is_some_and(|value| !value.is_object())
    {
        return Err("OpenCode 配置中的 server 必须是 JSON 对象".to_string());
    }

    let backup = opencode_backup_path(settings_path);
    let backup_created = !backup.is_file();
    if backup_created {
        let snapshot = OpenCodeConfigBackup {
            version: BACKUP_VERSION,
            agent_id: "opencode".to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            settings_path: display_path(settings_path),
            auth_path: display_path(auth_path),
            settings_existed,
            auth_existed,
            provider_existed,
            schema: backed_up_value(settings.get("$schema")),
            model: backed_up_value(settings.get("model")),
            small_model: backed_up_value(settings.get("small_model")),
            disabled_providers: backed_up_value(settings.get("disabled_providers")),
            enabled_providers: backed_up_value(settings.get("enabled_providers")),
            server: Some(backed_up_value(settings.get("server"))),
            flowlet_provider: backed_up_value(settings.pointer("/provider/flowlet")),
            flowlet_auth: backed_up_value(auth.get("flowlet")),
            permission_plugin_path: display_path(permission_plugin_path),
            permission_plugin_previous: BackedUpValue {
                present: permission_plugin_previous.is_some(),
                value: permission_plugin_previous
                    .as_ref()
                    .map(|content| Value::String(content.clone()))
                    .unwrap_or(Value::Null),
            },
        };
        write_json_file(
            &backup,
            &serde_json::to_value(snapshot).map_err(|error| error.to_string())?,
        )?;
    } else {
        upgrade_opencode_backup_with_server(&backup, settings.get("server"))?;
        upgrade_opencode_backup_with_permission_plugin(
            &backup,
            permission_plugin_path,
            permission_plugin_previous.as_deref(),
        )?;
        restore_opencode_managed_server_fields(&root_object, &backup)?;
    }

    if !settings_existed {
        set_cst_property(
            &root_object,
            "$schema",
            CstInputValue::from("https://opencode.ai/config.json"),
        );
    }
    update_provider_allowlists(&root_object, &settings)?;
    set_cst_property(
        &root_object,
        "model",
        CstInputValue::from(OPENCODE_PRIMARY_MODEL),
    );
    set_cst_property(
        &root_object,
        "small_model",
        CstInputValue::from(OPENCODE_FAST_MODEL),
    );
    let provider_object = match root_object.get("provider") {
        Some(property) => property.object_value_or_set(),
        None => root_object
            .append("provider", CstInputValue::Object(Vec::new()))
            .object_value_or_set(),
    };
    set_cst_property(
        &provider_object,
        OPENCODE_PROVIDER_ID,
        jsonc_parser::json!({
            "name": "Flowlet",
            "npm": "@ai-sdk/openai-compatible",
            "options": {
                "baseURL": expected_base_url
            },
            "models": {
                "flowlet-pro": { "name": "flowlet-pro" },
                "flowlet-flash": { "name": "flowlet-flash" }
            }
        }),
    );
    auth.as_object_mut().unwrap().insert(
        OPENCODE_PROVIDER_ID.to_string(),
        serde_json::json!({ "type": "api", "key": client_token.trim() }),
    );
    let settings_content = text_file_bytes(&root.to_string());
    let auth_content = json_file_bytes(&auth)?;
    let permission_plugin_content = text_file_bytes(OPENCODE_PERMISSION_PLUGIN_SOURCE);
    if let Err(failure) = write_files_transactionally(
        "OpenCode 配置与凭据文件",
        &[
            (settings_path.to_path_buf(), Some(settings_content)),
            (auth_path.to_path_buf(), Some(auth_content)),
            (
                permission_plugin_path.to_path_buf(),
                Some(permission_plugin_content),
            ),
        ],
    ) {
        if backup_created && failure.rolled_back {
            let _ = std::fs::remove_file(&backup);
        }
        return Err(failure.message);
    }
    inspect_opencode(
        settings_path,
        auth_path,
        permission_plugin_path,
        expected_base_url,
    )
}

fn restore_opencode(
    settings_path: &Path,
    expected_auth_path: &Path,
    permission_plugin_path: &Path,
    expected_base_url: &str,
) -> Result<AgentGlobalConfigReport, String> {
    let backup_path = opencode_backup_path(settings_path);
    if !backup_path.is_file() {
        return Err("没有可恢复的 OpenCode 全局配置备份".to_string());
    }
    let backup: OpenCodeConfigBackup = serde_json::from_value(read_settings(&backup_path)?)
        .map_err(|error| format!("备份格式无效：{error}"))?;
    if backup.version != BACKUP_VERSION || backup.agent_id != "opencode" {
        return Err("OpenCode 全局配置备份版本不受支持".to_string());
    }
    let auth_path = PathBuf::from(&backup.auth_path);
    if !paths_equal(&auth_path, expected_auth_path) {
        return Err("OpenCode 凭据备份路径与当前用户配置不一致".to_string());
    }
    if !backup.permission_plugin_path.is_empty()
        && !paths_equal(
            &PathBuf::from(&backup.permission_plugin_path),
            permission_plugin_path,
        )
    {
        return Err("OpenCode 权限插件备份路径与当前用户配置不一致".to_string());
    }
    let mut auth = read_optional_json_object(&auth_path)?;
    let source = if settings_path.is_file() {
        std::fs::read_to_string(settings_path)
            .map_err(|error| format!("读取 {} 失败：{error}", settings_path.display()))?
    } else {
        "{}\n".to_string()
    };
    let root = CstRootNode::parse(&source, &ParseOptions::default())
        .map_err(|error| format!("解析 {} 失败：{error}", settings_path.display()))?;
    let root_object = root
        .object_value()
        .ok_or_else(|| "OpenCode 配置文件顶层必须是 JSON 对象".to_string())?;
    restore_cst_property(&root_object, "$schema", &backup.schema);
    restore_cst_property(&root_object, "model", &backup.model);
    restore_cst_property(&root_object, "small_model", &backup.small_model);
    restore_cst_property(
        &root_object,
        "disabled_providers",
        &backup.disabled_providers,
    );
    restore_cst_property(&root_object, "enabled_providers", &backup.enabled_providers);
    if let Some(server) = &backup.server {
        restore_cst_property(&root_object, "server", server);
    }
    if let Some(provider_property) = root_object.get("provider") {
        let provider_object = provider_property.object_value_or_set();
        restore_cst_property(
            &provider_object,
            OPENCODE_PROVIDER_ID,
            &backup.flowlet_provider,
        );
        if !backup.provider_existed && provider_object.properties().is_empty() {
            provider_property.remove();
        }
    } else if backup.flowlet_provider.present {
        let provider_object = root_object
            .append("provider", CstInputValue::Object(Vec::new()))
            .object_value_or_set();
        restore_cst_property(
            &provider_object,
            OPENCODE_PROVIDER_ID,
            &backup.flowlet_provider,
        );
    }

    let auth_object = auth.as_object_mut().unwrap();
    if backup.flowlet_auth.present {
        auth_object.insert(
            OPENCODE_PROVIDER_ID.to_string(),
            backup.flowlet_auth.value.clone(),
        );
    } else {
        auth_object.remove(OPENCODE_PROVIDER_ID);
    }
    let settings_content = if !backup.settings_existed && root_object.properties().is_empty() {
        None
    } else {
        Some(text_file_bytes(&root.to_string()))
    };
    let auth_content = if !backup.auth_existed && auth_object.is_empty() {
        None
    } else {
        Some(json_file_bytes(&auth)?)
    };
    let permission_plugin_content = if backup.permission_plugin_previous.present {
        backup
            .permission_plugin_previous
            .value
            .as_str()
            .map(text_file_bytes)
    } else {
        None
    };
    write_files_transactionally(
        "OpenCode 配置、凭据与权限插件文件",
        &[
            (settings_path.to_path_buf(), settings_content),
            (auth_path.to_path_buf(), auth_content),
            (
                permission_plugin_path.to_path_buf(),
                permission_plugin_content,
            ),
        ],
    )
    .map_err(|failure| failure.message)?;
    std::fs::remove_file(&backup_path)
        .map_err(|error| format!("配置已恢复，但清理 Flowlet 备份标记失败：{error}"))?;
    inspect_opencode(
        settings_path,
        expected_auth_path,
        permission_plugin_path,
        expected_base_url,
    )
}

fn inspect_pi(
    settings_path: &Path,
    models_path: &Path,
    auth_path: &Path,
    extension_path: &Path,
    expected_base_url: &str,
) -> Result<AgentGlobalConfigReport, String> {
    let backup_available = pi_backup_path(models_path).is_file();
    let session_extension = extension_path.is_file();
    let report = |state: AgentGlobalConfigState,
                  base_url: Option<String>,
                  api_key_configured: bool,
                  primary_model: Option<String>,
                  error: Option<String>| {
        AgentGlobalConfigReport {
            agent_id: "pi".to_string(),
            // UI 的“配置文件”指向真正承载 Flowlet Provider 的 models.json，
            // 凭据文件指向 auth.json；defaultProvider / defaultModel 位于 settings.json。
            settings_path: display_path(models_path),
            credentials_path: Some(display_path(auth_path)),
            settings_exists: models_path.is_file(),
            state,
            base_url,
            auth_token_configured: api_key_configured,
            api_key_configured,
            primary_model,
            fast_model: None,
            subagent_model: None,
            model_catalog_path: None,
            model_catalog_configured: false,
            long_context: false,
            backup_available,
            external_environment_overrides: Vec::new(),
            error,
            session_extension,
            opencode_permission_bridge: false,
        }
    };

    if !models_path.is_file() {
        return Ok(report(
            AgentGlobalConfigState::NotConfigured,
            None,
            false,
            None,
            None,
        ));
    }

    let models = match read_settings(models_path) {
        Ok(models) => models,
        Err(error) => {
            return Ok(report(
                AgentGlobalConfigState::Invalid,
                None,
                false,
                None,
                Some(error),
            ));
        }
    };
    let auth = match read_optional_json_object(auth_path) {
        Ok(auth) => auth,
        Err(error) => {
            return Ok(report(
                AgentGlobalConfigState::Invalid,
                None,
                false,
                None,
                Some(error),
            ));
        }
    };
    let settings = match read_optional_json_object(settings_path) {
        Ok(settings) => settings,
        Err(error) => {
            return Ok(report(
                AgentGlobalConfigState::Invalid,
                None,
                false,
                None,
                Some(error),
            ));
        }
    };

    let provider = models.pointer("/providers/flowlet");
    let base_url = provider
        .and_then(|value| value.get("baseUrl"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned);
    let api_matches = provider
        .and_then(|value| value.get("api"))
        .and_then(Value::as_str)
        == Some("openai-completions");
    let model_ids = provider
        .and_then(|value| value.get("models"))
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| model.get("id").and_then(Value::as_str))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let models_shape_matches =
        model_ids.contains(&PI_PRIMARY_MODEL) && model_ids.contains(&PI_FAST_MODEL);
    let api_key_configured = auth
        .pointer("/flowlet/key")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    let auth_type_matches =
        auth.pointer("/flowlet/type").and_then(Value::as_str) == Some("api_key");
    let default_provider = settings.get("defaultProvider").and_then(Value::as_str);
    let primary_model = settings
        .get("defaultModel")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let expected_base_url = normalize_url(expected_base_url);
    let base_url_matches =
        base_url.as_deref().map(normalize_url).as_deref() == Some(expected_base_url.as_str());
    let state = if base_url_matches
        && api_matches
        && models_shape_matches
        && api_key_configured
        && auth_type_matches
        && default_provider == Some(PI_PROVIDER_ID)
        && primary_model.as_deref() == Some(PI_PRIMARY_MODEL)
    {
        AgentGlobalConfigState::Flowlet
    } else if base_url
        .as_deref()
        .is_some_and(|value| normalize_url(value) != expected_base_url)
    {
        AgentGlobalConfigState::OtherGateway
    } else if provider.is_some()
        || auth.get(PI_PROVIDER_ID).is_some()
        || default_provider == Some(PI_PROVIDER_ID)
        || primary_model
            .as_deref()
            .is_some_and(|model| model.starts_with("flowlet"))
    {
        AgentGlobalConfigState::Partial
    } else {
        AgentGlobalConfigState::NotConfigured
    };

    Ok(report(
        state,
        base_url,
        api_key_configured,
        primary_model,
        None,
    ))
}

fn apply_pi(
    settings_path: &Path,
    models_path: &Path,
    auth_path: &Path,
    extension_path: &Path,
    expected_base_url: &str,
    client_token: &str,
    session_extension: bool,
) -> Result<AgentGlobalConfigReport, String> {
    if client_token.trim().is_empty() {
        return Err("Flowlet 默认 Client Token 未配置，无法写入 Pi".to_string());
    }
    let settings_existed = settings_path.is_file();
    let models_existed = models_path.is_file();
    let auth_existed = auth_path.is_file();
    // 扩展的备份始终反映写入前的真实磁盘状态，与 session_extension 选项无关，
    // 确保恢复时能正确还原；该选项仅控制本次是否写入扩展。
    let extension_existed = extension_path.is_file();
    let mut settings = read_optional_json_object(settings_path)?;
    let mut models = read_optional_json_object(models_path)?;
    let mut auth = read_optional_json_object(auth_path)?;
    if models
        .get("providers")
        .is_some_and(|value| !value.is_object())
    {
        return Err("Pi models.json 中的 providers 必须是 JSON 对象".to_string());
    }

    let backup = pi_backup_path(models_path);
    let backup_created = !backup.is_file();
    if backup_created {
        let providers_existed = models.get("providers").is_some();
        // 仅当扩展已存在时才记录其原始内容；present == false 表示写入前不存在，
        // 恢复时应删除 Flowlet 创建的扩展文件。
        let extension_previous = if extension_existed {
            Some(Value::String(
                std::fs::read_to_string(extension_path)
                    .map_err(|error| format!("读取 Pi 会话扩展失败：{error}"))?,
            ))
        } else {
            None
        };
        let snapshot = PiConfigBackup {
            version: BACKUP_VERSION,
            agent_id: "pi".to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            settings_path: display_path(settings_path),
            models_path: display_path(models_path),
            auth_path: display_path(auth_path),
            extension_path: display_path(extension_path),
            settings_existed,
            models_existed,
            auth_existed,
            providers_existed,
            extension_existed,
            default_provider: backed_up_value(settings.get("defaultProvider")),
            default_model: backed_up_value(settings.get("defaultModel")),
            flowlet_provider: backed_up_value(models.pointer("/providers/flowlet")),
            flowlet_auth: backed_up_value(auth.get(PI_PROVIDER_ID)),
            extension_previous: backed_up_value(extension_previous.as_ref()),
        };
        write_json_file(
            &backup,
            &serde_json::to_value(snapshot).map_err(|error| error.to_string())?,
        )?;
    }

    let providers = models
        .as_object_mut()
        .unwrap()
        .entry("providers")
        .or_insert_with(|| Value::Object(Map::new()));
    providers.as_object_mut().unwrap().insert(
        PI_PROVIDER_ID.to_string(),
        serde_json::json!({
            "baseUrl": expected_base_url,
            "api": "openai-completions",
            "headers": { "x-flowlet-client": "pi" },
            "models": [
                { "id": PI_PRIMARY_MODEL, "name": PI_PRIMARY_MODEL },
                { "id": PI_FAST_MODEL, "name": PI_FAST_MODEL }
            ]
        }),
    );
    auth.as_object_mut().unwrap().insert(
        PI_PROVIDER_ID.to_string(),
        serde_json::json!({ "type": "api_key", "key": client_token.trim() }),
    );
    let settings_object = settings.as_object_mut().unwrap();
    settings_object.insert(
        "defaultProvider".to_string(),
        Value::String(PI_PROVIDER_ID.to_string()),
    );
    settings_object.insert(
        "defaultModel".to_string(),
        Value::String(PI_PRIMARY_MODEL.to_string()),
    );

    let mut writes = vec![
        (
            settings_path.to_path_buf(),
            Some(json_file_bytes(&settings)?),
        ),
        (models_path.to_path_buf(), Some(json_file_bytes(&models)?)),
        (auth_path.to_path_buf(), Some(json_file_bytes(&auth)?)),
    ];
    if session_extension {
        let extension_bytes = text_file_bytes(PI_SESSION_EXTENSION_SOURCE);
        writes.push((extension_path.to_path_buf(), Some(extension_bytes)));
    } else {
        // 用户选择不安装会话扩展：若文件存在则删除，确保实际状态与选择一致。
        // 删除前的原始内容已由上方备份（extension_previous）捕获，恢复时可写回。
        writes.push((extension_path.to_path_buf(), None));
    }
    if let Err(failure) = write_files_transactionally("Pi 配置、模型、凭据与会话扩展文件", &writes)
    {
        if backup_created && failure.rolled_back {
            let _ = std::fs::remove_file(&backup);
        }
        return Err(failure.message);
    }
    inspect_pi(
        settings_path,
        models_path,
        auth_path,
        extension_path,
        expected_base_url,
    )
}

fn restore_pi(
    settings_path: &Path,
    models_path: &Path,
    auth_path: &Path,
    extension_path: &Path,
    expected_base_url: &str,
) -> Result<AgentGlobalConfigReport, String> {
    let backup_path = pi_backup_path(models_path);
    if !backup_path.is_file() {
        return Err("没有可恢复的 Pi 全局配置备份".to_string());
    }
    let backup: PiConfigBackup = serde_json::from_value(read_settings(&backup_path)?)
        .map_err(|error| format!("备份格式无效：{error}"))?;
    if backup.version != BACKUP_VERSION || backup.agent_id != "pi" {
        return Err("Pi 全局配置备份版本不受支持".to_string());
    }
    if !paths_equal(&PathBuf::from(&backup.settings_path), settings_path)
        || !paths_equal(&PathBuf::from(&backup.models_path), models_path)
        || !paths_equal(&PathBuf::from(&backup.auth_path), auth_path)
        || !paths_equal(&PathBuf::from(&backup.extension_path), extension_path)
    {
        return Err("Pi 配置备份路径与当前用户配置不一致".to_string());
    }

    let mut settings = read_optional_json_object(settings_path)?;
    let mut models = read_optional_json_object(models_path)?;
    let mut auth = read_optional_json_object(auth_path)?;

    restore_json_property(&mut settings, "defaultProvider", &backup.default_provider);
    restore_json_property(&mut settings, "defaultModel", &backup.default_model);

    let mut providers_empty = false;
    if let Some(providers) = models.get_mut("providers").and_then(Value::as_object_mut) {
        if backup.flowlet_provider.present {
            providers.insert(
                PI_PROVIDER_ID.to_string(),
                backup.flowlet_provider.value.clone(),
            );
        } else {
            providers.remove(PI_PROVIDER_ID);
        }
        providers_empty = providers.is_empty();
    } else if backup.flowlet_provider.present {
        let mut providers = Map::new();
        providers.insert(
            PI_PROVIDER_ID.to_string(),
            backup.flowlet_provider.value.clone(),
        );
        models
            .as_object_mut()
            .unwrap()
            .insert("providers".to_string(), Value::Object(providers));
    } else {
        providers_empty = true;
    }
    if !backup.providers_existed && providers_empty {
        models.as_object_mut().unwrap().remove("providers");
    }

    let auth_object = auth.as_object_mut().unwrap();
    if backup.flowlet_auth.present {
        auth_object.insert(
            PI_PROVIDER_ID.to_string(),
            backup.flowlet_auth.value.clone(),
        );
    } else {
        auth_object.remove(PI_PROVIDER_ID);
    }

    let settings_content = if !backup.settings_existed && settings.as_object().unwrap().is_empty() {
        None
    } else {
        Some(json_file_bytes(&settings)?)
    };
    let models_content = if !backup.models_existed && models.as_object().unwrap().is_empty() {
        None
    } else {
        Some(json_file_bytes(&models)?)
    };
    let auth_content = if !backup.auth_existed && auth_object.is_empty() {
        None
    } else {
        Some(json_file_bytes(&auth)?)
    };
    // 恢复会话扩展：若写入前已存在则写回原始内容，否则删除 Flowlet 写入的扩展文件。
    let extension_content = if backup.extension_previous.present {
        backup
            .extension_previous
            .value
            .as_str()
            .map(|text| text_file_bytes(text))
    } else {
        None
    };
    write_files_transactionally(
        "Pi 配置、模型、凭据与会话扩展文件",
        &[
            (settings_path.to_path_buf(), settings_content),
            (models_path.to_path_buf(), models_content),
            (auth_path.to_path_buf(), auth_content),
            (extension_path.to_path_buf(), extension_content),
        ],
    )
    .map_err(|failure| failure.message)?;
    std::fs::remove_file(&backup_path)
        .map_err(|error| format!("配置已恢复，但清理 Flowlet 备份标记失败：{error}"))?;
    inspect_pi(
        settings_path,
        models_path,
        auth_path,
        extension_path,
        expected_base_url,
    )
}

// ─── Codex ─────────────────────────────────────────────────────────────────
// Codex CLI、ChatGPT 桌面端 Codex 与 VS Code Codex 插件共享同一份
// `~/.codex/config.toml` 与 `~/.codex/auth.json`（官方确认无需分别配置），
// 一次写入即覆盖全系。Flowlet 经 Responses 协议接入，并强制
// `disable_response_storage = true`，避免 Codex 携带 store/previous_response_id
// 破坏 Flowlet 的无状态多账号路由。

/// Flowlet 受管的 config.toml 顶层键。`model` 本身在任意 Codex 配置中都可能出现，
/// 不单独作为 Flowlet 标记；标记判定见 inspect_codex。
const CODEX_MANAGED_TOP_LEVEL: &[&str] = &[
    "model",
    "model_provider",
    "disable_response_storage",
    "preferred_auth_method",
    "model_catalog_json",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
struct CodexConfigBackup {
    version: u32,
    agent_id: String,
    created_at: String,
    config_path: String,
    auth_path: String,
    config_existed: bool,
    auth_existed: bool,
    /// 写入前 `[model_providers.flowlet]` 表是否已存在；为 false 时恢复即整表删除。
    provider_table_existed: bool,
    /// 四个受管顶层键写入前的值（present=false 表示原本不存在）。
    top_level: BTreeMap<String, BackedUpValue>,
    /// 写入前整张 `[model_providers.flowlet]` 表的内容（序列化为 JSON 对象）。
    flowlet_provider: BackedUpValue,
    /// 写入前 auth.json 中 OPENAI_API_KEY 的值。
    auth_key: BackedUpValue,
    /// 模型目录文件路径；旧版本备份缺失该字段时默认空串（恢复时跳过模型目录还原）。
    #[serde(default)]
    models_path: String,
    /// 写入前模型目录文件是否存在。
    #[serde(default)]
    models_existed: bool,
    /// 写入前模型目录文件的原始内容；None 表示原本不存在。
    #[serde(default)]
    models_content: Option<String>,
}

fn codex_config_path() -> PathBuf {
    codex_home().join("config.toml")
}

fn codex_auth_path() -> PathBuf {
    codex_home().join("auth.json")
}
fn codex_models_path() -> PathBuf {
    codex_home().join(CODEX_MODEL_CATALOG_FILE)
}

fn codex_backup_path(config_path: &Path) -> PathBuf {
    config_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(FLOWLET_DIR)
        .join(CODEX_BACKUP_FILE)
}

fn read_codex_document(config_path: &Path) -> Result<toml_edit::DocumentMut, String> {
    if !config_path.is_file() {
        return Ok(toml_edit::DocumentMut::new());
    }
    let content = std::fs::read_to_string(config_path)
        .map_err(|error| format!("读取 {} 失败：{error}", config_path.display()))?;
    content
        .parse::<toml_edit::DocumentMut>()
        .map_err(|error| format!("解析 {} 失败：{error}", config_path.display()))
}

/// toml_edit 值 → serde_json（用于备份快照；手工转换，不依赖 serde 集成）。
fn toml_item_to_json(item: &toml_edit::Item) -> Option<Value> {
    match item {
        toml_edit::Item::Value(value) => Some(toml_value_to_json(value)),
        toml_edit::Item::Table(table) => Some(toml_table_to_json(table)),
        _ => None,
    }
}

fn toml_value_to_json(value: &toml_edit::Value) -> Value {
    match value {
        toml_edit::Value::String(text) => Value::String(text.value().clone()),
        toml_edit::Value::Integer(number) => Value::Number((*number.value()).into()),
        toml_edit::Value::Float(number) => serde_json::Number::from_f64(*number.value())
            .map(Value::Number)
            .unwrap_or(Value::Null),
        toml_edit::Value::Boolean(flag) => Value::Bool(*flag.value()),
        toml_edit::Value::Datetime(datetime) => Value::String(datetime.to_string()),
        toml_edit::Value::Array(array) => {
            Value::Array(array.iter().map(toml_value_to_json).collect())
        }
        toml_edit::Value::InlineTable(table) => {
            let mut map = Map::new();
            for (key, item) in table.iter() {
                map.insert(key.to_string(), toml_value_to_json(item));
            }
            Value::Object(map)
        }
    }
}

fn toml_table_to_json(table: &toml_edit::Table) -> Value {
    let mut map = Map::new();
    for (key, item) in table.iter() {
        if let Some(value) = toml_item_to_json(item) {
            map.insert(key.to_string(), value);
        }
    }
    Value::Object(map)
}

fn codex_top_level_value(doc: &toml_edit::DocumentMut, key: &str) -> Option<Value> {
    doc.get(key).and_then(toml_item_to_json)
}

fn codex_flowlet_provider_item(doc: &toml_edit::DocumentMut) -> Option<&toml_edit::Item> {
    doc.get("model_providers")
        .and_then(|item| item.get(CODEX_PROVIDER_ID))
}

fn codex_flowlet_provider_table(doc: &toml_edit::DocumentMut) -> Option<&dyn toml_edit::TableLike> {
    codex_flowlet_provider_item(doc).and_then(|item| item.as_table_like())
}

/// serde_json → toml_edit（用于恢复备份值；受管键实际只会是字符串/布尔/数值/表）。
fn json_to_toml_item(value: &Value) -> toml_edit::Item {
    match value {
        Value::Object(map) => {
            let mut table = toml_edit::Table::new();
            for (key, item) in map {
                table.insert(key, json_to_toml_item(item));
            }
            toml_edit::Item::Table(table)
        }
        _ => match json_to_toml_scalar(value) {
            Some(scalar) => toml_edit::Item::Value(scalar),
            None => toml_edit::Item::None,
        },
    }
}

fn json_to_toml_scalar(value: &Value) -> Option<toml_edit::Value> {
    match value {
        Value::String(text) => Some(toml_edit::Value::from(text.as_str())),
        Value::Bool(flag) => Some(toml_edit::Value::from(*flag)),
        Value::Number(number) => number
            .as_i64()
            .map(toml_edit::Value::from)
            .or_else(|| number.as_f64().map(toml_edit::Value::from)),
        _ => None,
    }
}

/// 用 Flowlet 受管内容构造 `[model_providers.flowlet]` 表（整体替换，
/// 顺带清理旧版本写入可能残留的多余字段）。
fn build_codex_flowlet_provider(base_url: &str) -> toml_edit::Item {
    let mut table = toml_edit::Table::new();
    table.insert("name", toml_edit::value(CODEX_PROVIDER_ID));
    table.insert("base_url", toml_edit::value(base_url));
    table.insert("wire_api", toml_edit::value(CODEX_WIRE_API));
    table.insert("requires_openai_auth", toml_edit::value(true));
    toml_edit::Item::Table(table)
}

fn inspect_codex(
    config_path: &Path,
    auth_path: &Path,
    models_path: &Path,
    expected_base_url: &str,
) -> Result<AgentGlobalConfigReport, String> {
    let settings_exists = config_path.is_file();
    let auth = read_optional_json_object(auth_path)?;
    let auth_key = auth
        .get(CODEX_AUTH_KEY)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let auth_token_configured = auth_key.is_some();
    let backup_available = codex_backup_path(config_path).is_file();

    let mut report = AgentGlobalConfigReport {
        agent_id: "codex".to_string(),
        settings_path: display_path(config_path),
        credentials_path: Some(display_path(auth_path)),
        settings_exists,
        state: AgentGlobalConfigState::NotConfigured,
        base_url: None,
        auth_token_configured,
        api_key_configured: auth_token_configured,
        primary_model: None,
        fast_model: None,
        subagent_model: None,
        model_catalog_path: None,
        model_catalog_configured: false,
        long_context: false,
        backup_available,
        external_environment_overrides: Vec::new(),
        error: None,
        session_extension: false,
        opencode_permission_bridge: false,
    };

    if !settings_exists {
        return Ok(report);
    }
    let doc = match read_codex_document(config_path) {
        Ok(doc) => doc,
        Err(error) => {
            report.state = AgentGlobalConfigState::Invalid;
            report.error = Some(error);
            return Ok(report);
        }
    };

    let model = codex_top_level_value(&doc, "model")
        .and_then(|value| value.as_str().map(str::to_string));
    let model_provider = codex_top_level_value(&doc, "model_provider")
        .and_then(|value| value.as_str().map(str::to_string));
    let disable_response_storage = codex_top_level_value(&doc, "disable_response_storage")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let preferred_auth_method = codex_top_level_value(&doc, "preferred_auth_method")
        .and_then(|value| value.as_str().map(str::to_string));
    let model_catalog_json = codex_top_level_value(&doc, "model_catalog_json")
        .and_then(|value| value.as_str().map(str::to_string));
    // 模型目录是否由 Flowlet 管理：config.toml 指向 Flowlet 的目录引用，且文件在位。
    let model_catalog_configured =
        model_catalog_json.as_deref() == Some(CODEX_MODEL_CATALOG_REF) && models_path.is_file();
    report.model_catalog_path = model_catalog_json.clone();
    report.model_catalog_configured = model_catalog_configured;
    report.primary_model = model.clone();

    let provider = codex_flowlet_provider_table(&doc);
    let provider_base_url = provider
        .and_then(|table| table.get("base_url"))
        .and_then(|item| item.as_value())
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let provider_wire_api = provider
        .and_then(|table| table.get("wire_api"))
        .and_then(|item| item.as_value())
        .and_then(|value| value.as_str());
    let provider_requires_auth = provider
        .and_then(|table| table.get("requires_openai_auth"))
        .and_then(|item| item.as_value())
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    report.base_url = provider_base_url.clone();

    // 当前生效 provider 的 base_url：优先取 model_provider 指向的表，
    // 缺失时回退 flowlet 表（用于识别“旧端口/旧网关”的过期 Flowlet 配置）。
    let active_base_url = model_provider
        .as_deref()
        .and_then(|id| {
            doc.get("model_providers")
                .and_then(|item| item.get(id))
                .and_then(|item| item.as_table_like())
        })
        .and_then(|table| table.get("base_url"))
        .and_then(|item| item.as_value())
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .or(provider_base_url);

    let matches_expected = active_base_url
        .as_deref()
        .is_some_and(|url| normalize_url(url) == normalize_url(expected_base_url));

    let is_flowlet = model_provider.as_deref() == Some(CODEX_PROVIDER_ID)
        && model.as_deref() == Some(CODEX_PRIMARY_MODEL)
        && disable_response_storage
        && preferred_auth_method.as_deref() == Some("apikey")
        && provider_wire_api == Some(CODEX_WIRE_API)
        && provider_requires_auth
        && matches_expected
        && auth_token_configured
        && model_catalog_configured;

    report.state = if is_flowlet {
        AgentGlobalConfigState::Flowlet
    } else if active_base_url.as_deref().is_some_and(|url| !url.trim().is_empty())
        && !matches_expected
    {
        AgentGlobalConfigState::OtherGateway
    } else if model_provider.as_deref() == Some(CODEX_PROVIDER_ID)
        || provider.is_some()
        || model.as_deref() == Some(CODEX_PRIMARY_MODEL)
        || disable_response_storage
        || auth_token_configured
    {
        AgentGlobalConfigState::Partial
    } else {
        AgentGlobalConfigState::NotConfigured
    };
    Ok(report)
}

fn apply_codex(
    config_path: &Path,
    auth_path: &Path,
    models_path: &Path,
    expected_base_url: &str,
    client_token: &str,
) -> Result<AgentGlobalConfigReport, String> {
    if client_token.trim().is_empty() {
        return Err("Flowlet 默认 Client Token 未配置，无法写入 Codex".to_string());
    }
    let config_existed = config_path.is_file();
    let auth_existed = auth_path.is_file();
    // 模型目录当前内容（存在时），用于备份与恢复；Flowlet 命名空间文件通常由 Flowlet 创建。
    let models_content_before =
        std::fs::read_to_string(models_path).ok();
    let mut doc = read_codex_document(config_path)?;
    let mut auth = read_optional_json_object(auth_path)?;

    let backup = codex_backup_path(config_path);
    let backup_created = !backup.is_file();
    if backup_created {
        let provider_exists = codex_flowlet_provider_table(&doc).is_some();
        let provider_json = codex_flowlet_provider_item(&doc).and_then(toml_item_to_json);
        let snapshot = CodexConfigBackup {
            version: BACKUP_VERSION,
            agent_id: "codex".to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            config_path: display_path(config_path),
            auth_path: display_path(auth_path),
            config_existed,
            auth_existed,
            provider_table_existed: provider_exists,
            top_level: CODEX_MANAGED_TOP_LEVEL
                .iter()
                .map(|key| {
                    (
                        key.to_string(),
                        backed_up_value(codex_top_level_value(&doc, key).as_ref()),
                    )
                })
                .collect(),
            flowlet_provider: backed_up_value(provider_json.as_ref()),
            auth_key: backed_up_value(auth.get(CODEX_AUTH_KEY)),
            models_path: display_path(models_path),
            models_existed: models_content_before.is_some(),
            models_content: models_content_before.clone(),
        };
        write_json_file(
            &backup,
            &serde_json::to_value(snapshot).map_err(|error| error.to_string())?,
        )?;
    } else {
        // 旧版本备份没有模型目录字段：升级备份，使恢复时能清理 Flowlet 生成的模型目录。
        let existing = read_settings(&backup)?;
        if existing.get("models_path").is_none()
            && existing.as_object().is_some_and(|object| object.contains_key("agent_id"))
        {
            let mut upgraded = existing.clone();
            if let Some(object) = upgraded.as_object_mut() {
                object.insert("models_path".to_string(), Value::String(display_path(models_path)));
                object.insert("models_existed".to_string(), Value::Bool(false));
                object.insert("models_content".to_string(), Value::Null);
            }
            write_json_file(&backup, &upgraded)?;
        }
    }

    doc["model"] = toml_edit::value(CODEX_PRIMARY_MODEL);
    doc["model_provider"] = toml_edit::value(CODEX_PROVIDER_ID);
    doc["disable_response_storage"] = toml_edit::value(true);
    doc["preferred_auth_method"] = toml_edit::value("apikey");
    // 自定义模型必须声明模型目录（上下文窗口、推理档位），仅应用启动时读取一次，
    // 补写后需重启 Codex 才生效（与 DeepSeek/千问官方 Codex 接入文档一致）。
    doc["model_catalog_json"] = toml_edit::value(CODEX_MODEL_CATALOG_REF);
    // 嵌套下标赋值在父表不存在时的自动派生不可靠（会被渲染成空内联表），
    // 先显式确保 model_providers 是表再写入 flowlet 子表。
    if !doc
        .get("model_providers")
        .is_some_and(|item| item.is_table_like())
    {
        doc["model_providers"] = toml_edit::Item::Table(toml_edit::Table::new());
    }
    doc["model_providers"][CODEX_PROVIDER_ID] = build_codex_flowlet_provider(expected_base_url);
    auth.as_object_mut()
        .unwrap()
        .insert(CODEX_AUTH_KEY.to_string(), Value::String(client_token.trim().to_string()));

    // 模型目录内容取内置数据源（仓库根目录 codex-models.json 的编译时快照）。
    let models_bytes = codex_model_catalog::DEFAULT_CODEX_MODELS_JSON.as_bytes().to_vec();
    if let Err(failure) = write_files_transactionally(
        "Codex 配置、凭据与模型目录文件",
        &[
            (
                config_path.to_path_buf(),
                Some(doc.to_string().into_bytes()),
            ),
            (auth_path.to_path_buf(), Some(json_file_bytes(&auth)?)),
            (models_path.to_path_buf(), Some(models_bytes)),
        ],
    ) {
        if backup_created && failure.rolled_back {
            let _ = std::fs::remove_file(&backup);
        }
        return Err(failure.message);
    }
    inspect_codex(config_path, auth_path, models_path, expected_base_url)
}

fn restore_codex(
    config_path: &Path,
    auth_path: &Path,
    models_path: &Path,
    expected_base_url: &str,
) -> Result<AgentGlobalConfigReport, String> {
    let backup_path = codex_backup_path(config_path);
    if !backup_path.is_file() {
        return Err("没有可恢复的 Codex 全局配置备份".to_string());
    }
    let backup: CodexConfigBackup = serde_json::from_value(read_settings(&backup_path)?)
        .map_err(|error| format!("备份格式无效：{error}"))?;
    if backup.version != BACKUP_VERSION || backup.agent_id != "codex" {
        return Err("Codex 全局配置备份版本不受支持".to_string());
    }
    if !paths_equal(&PathBuf::from(&backup.config_path), config_path)
        || !paths_equal(&PathBuf::from(&backup.auth_path), auth_path)
        || (!backup.models_path.is_empty()
            && !paths_equal(&PathBuf::from(&backup.models_path), models_path))
    {
        return Err("Codex 配置备份路径与当前用户配置不一致".to_string());
    }

    let mut doc = read_codex_document(config_path)?;
    let mut auth = read_optional_json_object(auth_path)?;

    for key in CODEX_MANAGED_TOP_LEVEL {
        let backed_up = backup
            .top_level
            .get(*key)
            .cloned()
            .unwrap_or_default();
        if backed_up.present {
            doc[key] = json_to_toml_item(&backed_up.value);
        } else {
            doc.remove(key);
        }
    }

    if backup.flowlet_provider.present {
        if !doc
            .get("model_providers")
            .is_some_and(|item| item.is_table_like())
        {
            doc["model_providers"] = toml_edit::Item::Table(toml_edit::Table::new());
        }
        doc["model_providers"][CODEX_PROVIDER_ID] = json_to_toml_item(&backup.flowlet_provider.value);
    } else {
        let providers_empty = doc
            .get_mut("model_providers")
            .and_then(|item| item.as_table_mut())
            .map(|table| {
                table.remove(CODEX_PROVIDER_ID);
                table.is_empty()
            })
            .unwrap_or(false);
        if providers_empty {
            doc.remove("model_providers");
        }
    }

    restore_json_property(&mut auth, CODEX_AUTH_KEY, &backup.auth_key);

    let config_empty = doc.iter().next().is_none();
    let config_content = if !backup.config_existed && config_empty {
        None
    } else {
        Some(doc.to_string().into_bytes())
    };
    let auth_content = if !backup.auth_existed && auth.as_object().unwrap().is_empty() {
        None
    } else {
        Some(json_file_bytes(&auth)?)
    };
    // 模型目录还原：写入前存在则恢复原内容，不存在则删除 Flowlet 生成的文件。
    let models_content = backup
        .models_content
        .as_deref()
        .map(|content| content.as_bytes().to_vec());
    write_files_transactionally(
        "Codex 配置、凭据与模型目录文件",
        &[
            (config_path.to_path_buf(), config_content),
            (auth_path.to_path_buf(), auth_content),
            (models_path.to_path_buf(), models_content),
        ],
    )
    .map_err(|failure| failure.message)?;
    std::fs::remove_file(&backup_path)
        .map_err(|error| format!("配置已恢复，但清理 Flowlet 备份标记失败：{error}"))?;
    inspect_codex(config_path, auth_path, models_path, expected_base_url)
}

fn restore_json_property(root: &mut Value, name: &str, backed_up: &BackedUpValue) {
    let object = root.as_object_mut().unwrap();
    if backed_up.present {
        object.insert(name.to_string(), backed_up.value.clone());
    } else {
        object.remove(name);
    }
}

fn backed_up_value(value: Option<&Value>) -> BackedUpValue {
    BackedUpValue {
        present: value.is_some(),
        value: value.cloned().unwrap_or(Value::Null),
    }
}

fn upgrade_opencode_backup_with_server(
    backup_path: &Path,
    current_server: Option<&Value>,
) -> Result<(), String> {
    let mut backup = read_settings(backup_path)?;
    let object = backup
        .as_object_mut()
        .ok_or_else(|| "OpenCode 全局配置备份格式无效".to_string())?;
    if object.contains_key("server") {
        return Ok(());
    }
    object.insert(
        "server".to_string(),
        serde_json::to_value(backed_up_value(current_server))
            .map_err(|error| format!("升级 OpenCode 配置备份失败：{error}"))?,
    );
    write_json_file(backup_path, &backup)
}

fn upgrade_opencode_backup_with_permission_plugin(
    backup_path: &Path,
    plugin_path: &Path,
    previous_content: Option<&str>,
) -> Result<(), String> {
    let mut backup = read_settings(backup_path)?;
    let object = backup
        .as_object_mut()
        .ok_or_else(|| "OpenCode 全局配置备份格式无效".to_string())?;
    if object.contains_key("permission_plugin_previous") {
        return Ok(());
    }
    object.insert(
        "permission_plugin_path".to_string(),
        Value::String(display_path(plugin_path)),
    );
    object.insert(
        "permission_plugin_previous".to_string(),
        serde_json::to_value(BackedUpValue {
            present: previous_content.is_some(),
            value: previous_content
                .map(|content| Value::String(content.to_string()))
                .unwrap_or(Value::Null),
        })
        .map_err(|error| format!("升级 OpenCode 权限插件备份失败：{error}"))?,
    );
    write_json_file(backup_path, &backup)
}

/// 早期 Flowlet 版本曾为了直接访问 OpenCode 控制接口写入 server.hostname/port。
/// 权限桥接插件已经不依赖固定端口；重新应用配置时只恢复这两个曾被 Flowlet 管理的
/// 字段，保留用户后来添加的 mdns、cors 等其他 server 设置。
fn restore_opencode_managed_server_fields(
    root: &CstObject,
    backup_path: &Path,
) -> Result<(), String> {
    let backup: OpenCodeConfigBackup = serde_json::from_value(read_settings(backup_path)?)
        .map_err(|error| format!("OpenCode 配置备份格式无效：{error}"))?;
    let Some(server_backup) = backup.server.as_ref() else {
        return Ok(());
    };
    let current = root
        .to_serde_value()
        .ok_or_else(|| "OpenCode 配置文件顶层必须是 JSON 对象".to_string())?;
    let current_server = current.get("server").and_then(Value::as_object);
    if !current_server.is_some_and(|server| {
        server.get("hostname").and_then(Value::as_str) == Some("127.0.0.1")
            && server.get("port").and_then(Value::as_u64).is_some()
    }) {
        return Ok(());
    }
    let Some(server_property) = root.get("server") else {
        return Ok(());
    };
    let server_object = server_property.object_value_or_set();
    let original_server = server_backup.value.as_object();
    for field in ["hostname", "port"] {
        if server_backup.present {
            if let Some(value) = original_server.and_then(|server| server.get(field)) {
                set_cst_property(&server_object, field, serde_to_cst(value));
                continue;
            }
        }
        if let Some(property) = server_object.get(field) {
            property.remove();
        }
    }
    if server_object.properties().is_empty() {
        server_property.remove();
    }
    Ok(())
}

fn string_array_contains(value: Option<&Value>, expected: &str) -> bool {
    value
        .and_then(Value::as_array)
        .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(expected)))
}

fn update_provider_allowlists(root: &CstObject, settings: &Value) -> Result<(), String> {
    if let Some(disabled) = settings.get("disabled_providers") {
        let values = disabled
            .as_array()
            .ok_or_else(|| "OpenCode 配置中的 disabled_providers 必须是字符串数组".to_string())?;
        let filtered = values
            .iter()
            .filter(|value| value.as_str() != Some(OPENCODE_PROVIDER_ID))
            .map(serde_to_cst)
            .collect();
        set_cst_property(root, "disabled_providers", CstInputValue::Array(filtered));
    }
    if let Some(enabled) = settings.get("enabled_providers") {
        let values = enabled
            .as_array()
            .ok_or_else(|| "OpenCode 配置中的 enabled_providers 必须是字符串数组".to_string())?;
        let mut values = values.iter().map(serde_to_cst).collect::<Vec<_>>();
        if !string_array_contains(Some(enabled), OPENCODE_PROVIDER_ID) {
            values.push(CstInputValue::from(OPENCODE_PROVIDER_ID));
        }
        set_cst_property(root, "enabled_providers", CstInputValue::Array(values));
    }
    Ok(())
}

fn set_cst_property(object: &CstObject, name: &str, value: CstInputValue) {
    if let Some(property) = object.get(name) {
        property.set_value(value);
    } else {
        object.append(name, value);
    }
}

fn restore_cst_property(object: &CstObject, name: &str, backed_up: &BackedUpValue) {
    if backed_up.present {
        set_cst_property(object, name, serde_to_cst(&backed_up.value));
    } else if let Some(property) = object.get(name) {
        property.remove();
    }
}

fn serde_to_cst(value: &Value) -> CstInputValue {
    match value {
        Value::Null => CstInputValue::Null,
        Value::Bool(value) => CstInputValue::Bool(*value),
        Value::Number(value) => CstInputValue::Number(value.to_string()),
        Value::String(value) => CstInputValue::String(value.clone()),
        Value::Array(values) => CstInputValue::Array(values.iter().map(serde_to_cst).collect()),
        Value::Object(values) => CstInputValue::Object(
            values
                .iter()
                .map(|(name, value)| (name.clone(), serde_to_cst(value)))
                .collect(),
        ),
    }
}

fn read_jsonc_settings(path: &Path) -> Result<Value, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
    let value = jsonc_parser::parse_to_serde_value::<Value>(&content, &ParseOptions::default())
        .map_err(|error| format!("解析 {} 失败：{error}", path.display()))?;
    if !value.is_object() {
        return Err(format!("{} 顶层必须是 JSON 对象", path.display()));
    }
    Ok(value)
}

fn read_optional_json_object(path: &Path) -> Result<Value, String> {
    if !path.is_file() {
        return Ok(Value::Object(Map::new()));
    }
    read_settings(path)
}

fn read_settings(path: &Path) -> Result<Value, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
    let value: Value = serde_json::from_str(&content)
        .map_err(|error| format!("解析 {} 失败：{error}", path.display()))?;
    if !value.is_object() {
        return Err(format!("{} 顶层必须是 JSON 对象", path.display()));
    }
    if value
        .as_object()
        .and_then(|root| root.get("env"))
        .is_some_and(|env| !env.is_object())
    {
        return Err(format!("{} 中 env 必须是 JSON 对象", path.display()));
    }
    Ok(value)
}

fn ensure_env_object(root: &mut Map<String, Value>) -> Result<&mut Map<String, Value>, String> {
    if !root.contains_key("env") {
        root.insert("env".to_string(), Value::Object(Map::new()));
    }
    root.get_mut("env")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Claude Code settings.json 中 env 必须是 JSON 对象".to_string())
}

fn backup_path(settings_path: &Path) -> PathBuf {
    settings_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(FLOWLET_DIR)
        .join(ACTIVE_BACKUP_FILE)
}

fn opencode_backup_path(settings_path: &Path) -> PathBuf {
    settings_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(FLOWLET_DIR)
        .join(OPENCODE_BACKUP_FILE)
}

fn pi_backup_path(models_path: &Path) -> PathBuf {
    models_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(FLOWLET_DIR)
        .join(PI_BACKUP_FILE)
}

fn write_json_file(path: &Path, value: &Value) -> Result<(), String> {
    write_bytes_file(path, &json_file_bytes(value)?)
}

fn json_file_bytes(value: &Value) -> Result<Vec<u8>, String> {
    let content =
        serde_json::to_string_pretty(value).map_err(|error| format!("序列化配置失败：{error}"))?;
    Ok(format!("{content}\n").into_bytes())
}

fn text_file_bytes(content: &str) -> Vec<u8> {
    if content.ends_with('\n') {
        content.as_bytes().to_vec()
    } else {
        format!("{content}\n").into_bytes()
    }
}

fn managed_text_file_matches(path: &Path, expected: &str) -> bool {
    std::fs::read_to_string(path).is_ok_and(|actual| {
        actual.replace("\r\n", "\n").trim_end_matches('\n')
            == expected.replace("\r\n", "\n").trim_end_matches('\n')
    })
}

fn write_bytes_file(path: &Path, content: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建配置目录 {} 失败：{error}", parent.display()))?;
    }
    let temp_path = path.with_extension(format!(
        "{}.flowlet-tmp-{}",
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("json"),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(&temp_path, content)
        .map_err(|error| format!("写入临时配置 {} 失败：{error}", temp_path.display()))?;
    set_private_permissions(&temp_path)?;
    std::fs::rename(&temp_path, path).map_err(|error| {
        let _ = std::fs::remove_file(&temp_path);
        format!("替换配置 {} 失败：{error}", path.display())
    })?;
    Ok(())
}

#[derive(Debug)]
struct TransactionFailure {
    message: String,
    rolled_back: bool,
}

// 依次写入多个配置文件；任一写入失败时，将此前已写入的文件恢复到写入前快照。
// `description` 用于向用户说明被回滚的是哪组文件。
fn write_files_transactionally(
    description: &str,
    writes: &[(PathBuf, Option<Vec<u8>>)],
) -> Result<(), TransactionFailure> {
    let snapshots = writes
        .iter()
        .map(|(path, _)| capture_file(path))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|message| TransactionFailure {
            message,
            rolled_back: true,
        })?;
    for (index, (path, content)) in writes.iter().enumerate() {
        if let Err(write_error) = write_optional_file(path, content.as_deref()) {
            let rollback_errors = writes
                .iter()
                .take(index)
                .zip(snapshots.iter())
                .map(|((path, _), snapshot)| write_optional_file(path, snapshot.as_deref()))
                .filter_map(Result::err)
                .collect::<Vec<_>>();
            if rollback_errors.is_empty() {
                return Err(TransactionFailure {
                    message: format!("{write_error}；已回滚 {description}"),
                    rolled_back: true,
                });
            }
            return Err(TransactionFailure {
                message: format!(
                    "{write_error}；自动回滚失败：{}",
                    rollback_errors.join("；")
                ),
                rolled_back: false,
            });
        }
    }
    Ok(())
}

fn capture_file(path: &Path) -> Result<Option<Vec<u8>>, String> {
    if path.is_file() {
        std::fs::read(path)
            .map(Some)
            .map_err(|error| format!("读取事务快照 {} 失败：{error}", path.display()))
    } else {
        Ok(None)
    }
}

fn write_optional_file(path: &Path, content: Option<&[u8]>) -> Result<(), String> {
    match content {
        Some(content) => write_bytes_file(path, content),
        None if path.is_file() => std::fs::remove_file(path)
            .map_err(|error| format!("删除配置文件 {} 失败：{error}", path.display())),
        None => Ok(()),
    }
}

#[cfg(unix)]
fn set_private_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("设置配置文件权限失败：{error}"))
}

#[cfg(not(unix))]
fn set_private_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn normalize_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_ascii_lowercase()
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    let left = display_path(left);
    let right = display_path(right);
    if cfg!(windows) {
        left.eq_ignore_ascii_case(&right)
    } else {
        left == right
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_settings_path() -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "flowlet-agent-global-config-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        directory.join("settings.json")
    }

    fn test_opencode_paths() -> (PathBuf, PathBuf) {
        let directory = std::env::temp_dir().join(format!(
            "flowlet-opencode-global-config-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        (
            directory.join("config").join("opencode.jsonc"),
            directory.join("data").join("auth.json"),
        )
    }

    #[test]
    fn applies_and_restores_only_managed_fields() {
        let path = test_settings_path();
        std::fs::write(
            &path,
            r#"{"theme":"dark","env":{"ANTHROPIC_BASE_URL":"https://old.example","CUSTOM":"keep","ANTHROPIC_API_KEY":"old-secret","ANTHROPIC_SMALL_FAST_MODEL":"LongCat-2.0"}}"#,
        )
        .unwrap();

        let applied = apply_claude_code(
            &path,
            "http://127.0.0.1:18640/anthropic",
            "flowlet-token",
            false,
        )
        .unwrap();
        assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
        assert!(applied.backup_available);
        let current = read_settings(&path).unwrap();
        assert_eq!(current["theme"], "dark");
        assert_eq!(current["env"]["CUSTOM"], "keep");
        assert!(current["env"].get("ANTHROPIC_API_KEY").is_none());
        assert_eq!(
            current["env"]["ANTHROPIC_DEFAULT_FABLE_MODEL"],
            PRIMARY_MODEL
        );
        assert_eq!(current["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"], FAST_MODEL);
        assert_eq!(current["env"]["ANTHROPIC_SMALL_FAST_MODEL"], FAST_MODEL);
        assert_eq!(current["env"]["CLAUDE_CODE_SUBAGENT_MODEL"], FAST_MODEL);

        let restored = restore_claude_code(&path, "http://127.0.0.1:18640/anthropic").unwrap();
        assert_eq!(restored.state, AgentGlobalConfigState::OtherGateway);
        assert!(!restored.backup_available);
        let restored_settings = read_settings(&path).unwrap();
        assert_eq!(
            restored_settings["env"]["ANTHROPIC_BASE_URL"],
            "https://old.example"
        );
        assert_eq!(restored_settings["env"]["ANTHROPIC_API_KEY"], "old-secret");
        assert_eq!(
            restored_settings["env"]["ANTHROPIC_SMALL_FAST_MODEL"],
            "LongCat-2.0"
        );
        assert_eq!(restored_settings["env"]["CUSTOM"], "keep");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn long_context_option_writes_and_removes_suffix() {
        let path = test_settings_path();
        let applied = apply_claude_code(
            &path,
            "http://127.0.0.1:18640/anthropic",
            "flowlet-token",
            true,
        )
        .unwrap();
        assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
        assert!(applied.long_context);
        assert_eq!(applied.primary_model.as_deref(), Some("flowlet-pro[1m]"));
        let current = read_settings(&path).unwrap();
        for name in [
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_FABLE_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
        ] {
            assert_eq!(current["env"][name], "flowlet-pro[1m]", "{name}");
        }
        // 快速模型与子 Agent 模型不参与长上下文。
        assert_eq!(current["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"], FAST_MODEL);
        assert_eq!(current["env"]["ANTHROPIC_SMALL_FAST_MODEL"], FAST_MODEL);
        assert_eq!(current["env"]["CLAUDE_CODE_SUBAGENT_MODEL"], FAST_MODEL);

        // 关闭开关后重新写入应剥离后缀并收敛。
        let reapplied = apply_claude_code(
            &path,
            "http://127.0.0.1:18640/anthropic",
            "flowlet-token",
            false,
        )
        .unwrap();
        assert_eq!(reapplied.state, AgentGlobalConfigState::Flowlet);
        assert!(!reapplied.long_context);
        let current = read_settings(&path).unwrap();
        assert_eq!(current["env"]["ANTHROPIC_MODEL"], PRIMARY_MODEL);
        assert_eq!(
            current["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"],
            PRIMARY_MODEL
        );

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn manually_suffixed_config_still_converges_to_flowlet() {
        // 用户手动添加 [1m]（或旧版本写入）时，inspect 应剥离后缀比较，
        // 状态仍为 Flowlet，并如实回报 long_context。
        let path = test_settings_path();
        std::fs::write(
            &path,
            r#"{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:18640/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "flowlet-token",
    "ANTHROPIC_MODEL": "flowlet-pro[1m]",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "flowlet-pro[1m]",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "flowlet-pro[1m]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "flowlet-pro[1m]",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "flowlet-flash",
    "ANTHROPIC_SMALL_FAST_MODEL": "flowlet-flash",
    "CLAUDE_CODE_SUBAGENT_MODEL": "flowlet-flash"
  }
}"#,
        )
        .unwrap();

        let inspected = inspect_claude_code(&path, "http://127.0.0.1:18640/anthropic").unwrap();
        assert_eq!(inspected.state, AgentGlobalConfigState::Flowlet);
        assert!(inspected.long_context);
        assert_eq!(inspected.primary_model.as_deref(), Some("flowlet-pro[1m]"));

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn legacy_small_fast_model_is_reported_partial_and_repaired_by_apply() {
        // 旧版 Flowlet 写入的完整配置 + 用户遗留的 ANTHROPIC_SMALL_FAST_MODEL：
        // 该遗留变量在会话标题生成等后台任务中优先于 ANTHROPIC_DEFAULT_HAIKU_MODEL，
        // 必须被视为未收敛（Partial），重新写入后收敛到 FAST_MODEL 且可恢复原值。
        let path = test_settings_path();
        std::fs::write(
            &path,
            r#"{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:18640/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "flowlet-token",
    "ANTHROPIC_MODEL": "flowlet-pro",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "flowlet-pro",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "flowlet-pro",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "flowlet-flash",
    "ANTHROPIC_SMALL_FAST_MODEL": "LongCat-2.0",
    "CLAUDE_CODE_SUBAGENT_MODEL": "flowlet-flash"
  }
}"#,
        )
        .unwrap();

        let inspected = inspect_claude_code(&path, "http://127.0.0.1:18640/anthropic").unwrap();
        assert_eq!(inspected.state, AgentGlobalConfigState::Partial);

        let applied = apply_claude_code(
            &path,
            "http://127.0.0.1:18640/anthropic",
            "flowlet-token",
            false,
        )
        .unwrap();
        assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
        let current = read_settings(&path).unwrap();
        assert_eq!(current["env"]["ANTHROPIC_SMALL_FAST_MODEL"], FAST_MODEL);
        assert_eq!(current["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"], FAST_MODEL);

        let restored = restore_claude_code(&path, "http://127.0.0.1:18640/anthropic").unwrap();
        assert_eq!(restored.state, AgentGlobalConfigState::Partial);
        let restored_settings = read_settings(&path).unwrap();
        assert_eq!(
            restored_settings["env"]["ANTHROPIC_SMALL_FAST_MODEL"],
            "LongCat-2.0"
        );

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn missing_fable_alias_is_reported_partial_and_repaired_by_apply() {
        // 早期 Flowlet 写入的配置缺少 ANTHROPIC_DEFAULT_FABLE_MODEL：此时 `/model fable`、
        // `best` 别名会解析到内置 Fable 5 模型 ID，而非 Flowlet 暴露的模型，必须视为
        // 未收敛（Partial），重新写入后补上该变量并收敛到 PRIMARY_MODEL。
        let path = test_settings_path();
        std::fs::write(
            &path,
            r#"{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:18640/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "flowlet-token",
    "ANTHROPIC_MODEL": "flowlet-pro",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "flowlet-pro",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "flowlet-pro",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "flowlet-flash",
    "ANTHROPIC_SMALL_FAST_MODEL": "flowlet-flash",
    "CLAUDE_CODE_SUBAGENT_MODEL": "flowlet-flash"
  }
}"#,
        )
        .unwrap();

        let inspected = inspect_claude_code(&path, "http://127.0.0.1:18640/anthropic").unwrap();
        assert_eq!(inspected.state, AgentGlobalConfigState::Partial);

        let applied = apply_claude_code(
            &path,
            "http://127.0.0.1:18640/anthropic",
            "flowlet-token",
            false,
        )
        .unwrap();
        assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
        let current = read_settings(&path).unwrap();
        assert_eq!(
            current["env"]["ANTHROPIC_DEFAULT_FABLE_MODEL"],
            PRIMARY_MODEL
        );

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn removes_settings_created_only_for_flowlet_on_restore() {
        let path = test_settings_path();
        let directory = path.parent().unwrap().to_path_buf();

        apply_claude_code(
            &path,
            "http://127.0.0.1:18640/anthropic",
            "flowlet-token",
            false,
        )
        .unwrap();
        assert!(path.is_file());

        let restored = restore_claude_code(&path, "http://127.0.0.1:18640/anthropic").unwrap();
        assert_eq!(restored.state, AgentGlobalConfigState::NotConfigured);
        assert!(!path.exists());

        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn legacy_backup_removes_new_managed_fields_on_restore() {
        let path = test_settings_path();
        let directory = path.parent().unwrap().to_path_buf();

        apply_claude_code(
            &path,
            "http://127.0.0.1:18640/anthropic",
            "flowlet-token",
            false,
        )
        .unwrap();
        let backup = backup_path(&path);
        let mut backup_value = read_settings(&backup).unwrap();
        backup_value["fields"]
            .as_object_mut()
            .unwrap()
            .remove("CLAUDE_CODE_SUBAGENT_MODEL");
        write_json_file(&backup, &backup_value).unwrap();

        restore_claude_code(&path, "http://127.0.0.1:18640/anthropic").unwrap();
        assert!(!path.exists());

        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn reports_invalid_json_without_overwriting_it() {
        let path = test_settings_path();
        std::fs::write(&path, "{invalid").unwrap();

        let report = inspect_claude_code(&path, "http://127.0.0.1:18640/anthropic").unwrap();
        assert_eq!(report.state, AgentGlobalConfigState::Invalid);
        assert!(report.error.is_some());
        assert!(
            apply_claude_code(&path, "http://127.0.0.1:18640/anthropic", "token", false).is_err()
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{invalid");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn applies_and_restores_opencode_config_and_credentials() {
        let (settings_path, auth_path) = test_opencode_paths();
        let permission_plugin_path = settings_path.parent().unwrap().join("plugins/flowlet.ts");
        std::fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
        std::fs::create_dir_all(auth_path.parent().unwrap()).unwrap();
        std::fs::write(
            &settings_path,
            r#"{
  // keep this user setting
  "theme": "system",
  "server": { "port": 1234, "mdns": true },
  "disabled_providers": ["flowlet", "legacy"],
  "enabled_providers": ["other"],
  "provider": {
    "other": { "models": {} },
    "flowlet": {
      "name": "Old Flowlet",
      "options": { "baseURL": "https://old.example/v1" }
    }
  }
}
"#,
        )
        .unwrap();
        std::fs::write(
            &auth_path,
            r#"{"other":{"type":"api","key":"keep"},"flowlet":{"type":"api","key":"old"}}"#,
        )
        .unwrap();

        let applied = apply_opencode(
            &settings_path,
            &auth_path,
            &permission_plugin_path,
            "http://127.0.0.1:18640/v1",
            "flowlet-token",
        )
        .unwrap();
        assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
        assert!(applied.backup_available);
        let settings = read_jsonc_settings(&settings_path).unwrap();
        assert_eq!(settings["model"], OPENCODE_PRIMARY_MODEL);
        assert_eq!(settings["small_model"], OPENCODE_FAST_MODEL);
        assert_eq!(settings["server"]["port"], 1234);
        assert!(settings["server"].get("hostname").is_none());
        assert_eq!(settings["server"]["mdns"], true);
        assert_eq!(
            settings["provider"]["flowlet"]["options"]["baseURL"],
            "http://127.0.0.1:18640/v1"
        );
        assert!(
            settings["provider"]["flowlet"]["options"]
                .get("apiKey")
                .is_none()
        );
        assert_eq!(
            settings["disabled_providers"],
            serde_json::json!(["legacy"])
        );
        assert_eq!(
            settings["enabled_providers"],
            serde_json::json!(["other", "flowlet"])
        );
        assert!(
            std::fs::read_to_string(&settings_path)
                .unwrap()
                .contains("// keep this user setting")
        );
        let auth = read_settings(&auth_path).unwrap();
        assert_eq!(auth["flowlet"]["type"], "api");
        assert_eq!(auth["flowlet"]["key"], "flowlet-token");
        assert_eq!(auth["other"]["key"], "keep");
        let plugin_source = std::fs::read_to_string(&permission_plugin_path).unwrap();
        assert!(plugin_source.contains("permission.asked"));
        assert!(plugin_source.contains("client.permission?.list?.()"));
        assert!(plugin_source.contains("writeFile(stateTempPath"));
        assert!(plugin_source.contains("rename(stateTempPath, statePath)"));
        assert!(plugin_source.contains("state-${process.pid}-${instanceKey}.json"));
        assert!(!plugin_source.contains("Bun.write"));

        std::fs::write(
            &permission_plugin_path,
            "// Flowlet 旧版权限插件\nconst persist = () => Bun.write('state.json', '{}')\n",
        )
        .unwrap();
        let stale_plugin = inspect_opencode(
            &settings_path,
            &auth_path,
            &permission_plugin_path,
            "http://127.0.0.1:18640/v1",
        )
        .unwrap();
        assert_eq!(stale_plugin.state, AgentGlobalConfigState::Partial);
        assert!(!stale_plugin.opencode_permission_bridge);
        apply_opencode(
            &settings_path,
            &auth_path,
            &permission_plugin_path,
            "http://127.0.0.1:18640/v1",
            "flowlet-token",
        )
        .unwrap();

        std::fs::remove_file(&permission_plugin_path).unwrap();
        let missing_plugin = inspect_opencode(
            &settings_path,
            &auth_path,
            &permission_plugin_path,
            "http://127.0.0.1:18640/v1",
        )
        .unwrap();
        assert_eq!(missing_plugin.state, AgentGlobalConfigState::Partial);
        assert!(!missing_plugin.opencode_permission_bridge);
        apply_opencode(
            &settings_path,
            &auth_path,
            &permission_plugin_path,
            "http://127.0.0.1:18640/v1",
            "flowlet-token",
        )
        .unwrap();

        // 兼容短暂发布过的固定控制端口版本：再次应用时恢复接入前的 hostname/port，
        // 同时保留用户原有的 mdns 等其他 server 字段。
        let mut managed_settings = read_jsonc_settings(&settings_path).unwrap();
        let managed_server = managed_settings
            .get_mut("server")
            .and_then(Value::as_object_mut)
            .unwrap();
        managed_server.insert("port".to_string(), serde_json::json!(4096));
        managed_server.insert(
            "hostname".to_string(),
            Value::String("127.0.0.1".to_string()),
        );
        write_json_file(&settings_path, &managed_settings).unwrap();
        apply_opencode(
            &settings_path,
            &auth_path,
            &permission_plugin_path,
            "http://127.0.0.1:18640/v1",
            "flowlet-token",
        )
        .unwrap();
        let migrated = read_jsonc_settings(&settings_path).unwrap();
        assert_eq!(migrated["server"]["port"], 1234);
        assert!(migrated["server"].get("hostname").is_none());
        assert_eq!(migrated["server"]["mdns"], true);

        let restored = restore_opencode(
            &settings_path,
            &auth_path,
            &permission_plugin_path,
            "http://127.0.0.1:18640/v1",
        )
        .unwrap();
        assert_eq!(restored.state, AgentGlobalConfigState::OtherGateway);
        let restored_settings = read_jsonc_settings(&settings_path).unwrap();
        assert_eq!(restored_settings["theme"], "system");
        assert_eq!(restored_settings["server"]["port"], 1234);
        assert_eq!(restored_settings["server"]["mdns"], true);
        assert!(restored_settings["server"].get("hostname").is_none());
        assert!(restored_settings.get("model").is_none());
        assert_eq!(
            restored_settings["disabled_providers"],
            serde_json::json!(["flowlet", "legacy"])
        );
        assert_eq!(
            restored_settings["enabled_providers"],
            serde_json::json!(["other"])
        );
        assert_eq!(
            restored_settings["provider"]["flowlet"]["options"]["baseURL"],
            "https://old.example/v1"
        );
        let restored_auth = read_settings(&auth_path).unwrap();
        assert_eq!(restored_auth["flowlet"]["key"], "old");
        assert_eq!(restored_auth["other"]["key"], "keep");
        assert!(!permission_plugin_path.exists());

        let _ = std::fs::remove_dir_all(settings_path.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn upgrades_legacy_opencode_backup_without_overwriting_the_original_server() {
        let directory = std::env::temp_dir().join(format!(
            "flowlet-opencode-backup-upgrade-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let backup_path = directory.join("backup.json");
        write_json_file(&backup_path, &serde_json::json!({ "version": 1 })).unwrap();

        let original = serde_json::json!({ "hostname": "localhost", "port": 8123 });
        upgrade_opencode_backup_with_server(&backup_path, Some(&original)).unwrap();
        let first = read_settings(&backup_path).unwrap();
        assert_eq!(first["server"]["present"], true);
        assert_eq!(first["server"]["value"], original);

        let later = serde_json::json!({ "port": 4096 });
        upgrade_opencode_backup_with_server(&backup_path, Some(&later)).unwrap();
        let second = read_settings(&backup_path).unwrap();
        assert_eq!(second["server"]["value"]["port"], 8123);

        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn removes_opencode_files_created_only_for_flowlet() {
        let (settings_path, auth_path) = test_opencode_paths();
        let directory = settings_path
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();

        apply_opencode(
            &settings_path,
            &auth_path,
            &settings_path.parent().unwrap().join("plugins/flowlet.ts"),
            "http://127.0.0.1:18640/v1",
            "flowlet-token",
        )
        .unwrap();
        restore_opencode(
            &settings_path,
            &auth_path,
            &settings_path.parent().unwrap().join("plugins/flowlet.ts"),
            "http://127.0.0.1:18640/v1",
        )
        .unwrap();
        assert!(!settings_path.exists());
        assert!(!auth_path.exists());

        let _ = std::fs::remove_dir_all(directory);
    }

    fn test_pi_paths() -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        let directory =
            std::env::temp_dir().join(format!("flowlet-pi-global-config-{}", uuid::Uuid::new_v4()));
        let extensions = directory.join("extensions");
        std::fs::create_dir_all(&extensions).unwrap();
        (
            directory.join("settings.json"),
            directory.join("models.json"),
            directory.join("auth.json"),
            extensions.join("flowlet.ts"),
        )
    }

    #[test]
    fn applies_and_restores_pi_models_auth_and_settings() {
        let (settings_path, models_path, auth_path, extension_path) = test_pi_paths();
        std::fs::write(
            &settings_path,
            r#"{"theme":"dark","defaultProvider":"anthropic","defaultModel":"claude-sonnet-4-5"}"#,
        )
        .unwrap();
        std::fs::write(
            &models_path,
            r#"{"providers":{"other":{"baseUrl":"https://other.example","api":"openai-completions","models":[{"id":"m1"}]},"flowlet":{"baseUrl":"https://old.example/v1","api":"openai-completions","models":[{"id":"old-model"}]}}}"#,
        )
        .unwrap();
        std::fs::write(
            &auth_path,
            r#"{"other":{"type":"api_key","key":"keep"},"flowlet":{"type":"api_key","key":"old"}}"#,
        )
        .unwrap();

        let applied = apply_pi(
            &settings_path,
            &models_path,
            &auth_path,
            &extension_path,
            "http://127.0.0.1:18640/v1",
            "flowlet-token",
            true,
        )
        .unwrap();
        assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
        assert!(applied.backup_available);
        assert!(applied.session_extension);
        assert!(extension_path.is_file());
        let models = read_settings(&models_path).unwrap();
        assert_eq!(
            models["providers"]["flowlet"]["baseUrl"],
            "http://127.0.0.1:18640/v1"
        );
        assert_eq!(models["providers"]["flowlet"]["api"], "openai-completions");
        assert_eq!(
            models["providers"]["flowlet"]["headers"]["x-flowlet-client"],
            "pi"
        );
        let model_ids = models["providers"]["flowlet"]["models"]
            .as_array()
            .unwrap()
            .iter()
            .map(|model| model["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(model_ids, vec![PI_PRIMARY_MODEL, PI_FAST_MODEL]);
        assert_eq!(
            models["providers"]["other"]["baseUrl"],
            "https://other.example"
        );
        let auth = read_settings(&auth_path).unwrap();
        assert_eq!(auth["flowlet"]["type"], "api_key");
        assert_eq!(auth["flowlet"]["key"], "flowlet-token");
        assert_eq!(auth["other"]["key"], "keep");
        let settings = read_settings(&settings_path).unwrap();
        assert_eq!(settings["defaultProvider"], PI_PROVIDER_ID);
        assert_eq!(settings["defaultModel"], PI_PRIMARY_MODEL);
        assert_eq!(settings["theme"], "dark");

        let restored = restore_pi(
            &settings_path,
            &models_path,
            &auth_path,
            &extension_path,
            "http://127.0.0.1:18640/v1",
        )
        .unwrap();
        assert_eq!(restored.state, AgentGlobalConfigState::OtherGateway);
        assert!(!restored.backup_available);
        assert!(!restored.session_extension);
        assert!(!extension_path.exists());
        let models = read_settings(&models_path).unwrap();
        assert_eq!(
            models["providers"]["flowlet"]["baseUrl"],
            "https://old.example/v1"
        );
        assert_eq!(
            models["providers"]["flowlet"]["models"][0]["id"],
            "old-model"
        );
        let auth = read_settings(&auth_path).unwrap();
        assert_eq!(auth["flowlet"]["key"], "old");
        let settings = read_settings(&settings_path).unwrap();
        assert_eq!(settings["defaultProvider"], "anthropic");
        assert_eq!(settings["defaultModel"], "claude-sonnet-4-5");

        let _ = std::fs::remove_dir_all(settings_path.parent().unwrap());
    }

    #[test]
    fn removes_pi_files_created_only_for_flowlet() {
        let (settings_path, models_path, auth_path, extension_path) = test_pi_paths();
        let directory = settings_path.parent().unwrap().to_path_buf();

        apply_pi(
            &settings_path,
            &models_path,
            &auth_path,
            &extension_path,
            "http://127.0.0.1:18640/v1",
            "flowlet-token",
            true,
        )
        .unwrap();
        assert!(settings_path.is_file());
        assert!(models_path.is_file());
        assert!(auth_path.is_file());
        assert!(extension_path.is_file());

        let restored = restore_pi(
            &settings_path,
            &models_path,
            &auth_path,
            &extension_path,
            "http://127.0.0.1:18640/v1",
        )
        .unwrap();
        assert_eq!(restored.state, AgentGlobalConfigState::NotConfigured);
        assert!(!settings_path.exists());
        assert!(!models_path.exists());
        assert!(!auth_path.exists());
        assert!(!extension_path.exists());

        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn backs_up_and_restores_pre_existing_pi_session_extension() {
        let (settings_path, models_path, auth_path, extension_path) = test_pi_paths();
        // 用户事先已存在一个同名扩展文件（内容不应被覆盖丢失）。
        std::fs::write(&extension_path, "// user-owned extension\n").unwrap();

        let applied = apply_pi(
            &settings_path,
            &models_path,
            &auth_path,
            &extension_path,
            "http://127.0.0.1:18640/v1",
            "flowlet-token",
            true,
        )
        .unwrap();
        assert!(applied.session_extension);
        assert_eq!(
            std::fs::read_to_string(&extension_path).unwrap(),
            PI_SESSION_EXTENSION_SOURCE
        );

        let restored = restore_pi(
            &settings_path,
            &models_path,
            &auth_path,
            &extension_path,
            "http://127.0.0.1:18640/v1",
        )
        .unwrap();
        // 用户事先已存在同名扩展，Flowlet 不应删除用户文件，恢复后应写回用户原始内容。
        assert!(restored.session_extension);
        assert_eq!(
            std::fs::read_to_string(&extension_path).unwrap(),
            "// user-owned extension\n"
        );

        let _ = std::fs::remove_dir_all(settings_path.parent().unwrap());
    }

    #[test]
    fn skips_session_extension_when_opted_out() {
        let (settings_path, models_path, auth_path, extension_path) = test_pi_paths();
        // 用户事先存在一个扩展文件，但本次选择不安装会话扩展。
        std::fs::write(&extension_path, "// pre-existing extension\n").unwrap();

        let applied = apply_pi(
            &settings_path,
            &models_path,
            &auth_path,
            &extension_path,
            "http://127.0.0.1:18640/v1",
            "flowlet-token",
            false,
        )
        .unwrap();
        assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
        // 选择不安装时，扩展应被删除（删除前内容已由备份捕获）。
        assert!(!applied.session_extension);
        assert!(!extension_path.exists());

        // 恢复时应写回删除前的原始内容。
        let restored = restore_pi(
            &settings_path,
            &models_path,
            &auth_path,
            &extension_path,
            "http://127.0.0.1:18640/v1",
        )
        .unwrap();
        assert!(restored.session_extension);
        assert_eq!(
            std::fs::read_to_string(&extension_path).unwrap(),
            "// pre-existing extension\n"
        );

        let _ = std::fs::remove_dir_all(settings_path.parent().unwrap());
    }

    #[test]
    fn reports_pi_partial_state_without_default_provider() {
        let (settings_path, models_path, auth_path, extension_path) = test_pi_paths();
        std::fs::write(
            &models_path,
            r#"{"providers":{"flowlet":{"baseUrl":"http://127.0.0.1:18640/v1","api":"openai-completions","models":[{"id":"flowlet-pro"},{"id":"flowlet-flash"}]}}}"#,
        )
        .unwrap();
        std::fs::write(
            &auth_path,
            r#"{"flowlet":{"type":"api_key","key":"flowlet-token"}}"#,
        )
        .unwrap();
        // settings.json 缺失 defaultProvider / defaultModel，配置不完整。

        let inspected = inspect_pi(
            &settings_path,
            &models_path,
            &auth_path,
            &extension_path,
            "http://127.0.0.1:18640/v1",
        )
        .unwrap();
        assert_eq!(inspected.state, AgentGlobalConfigState::Partial);
        assert!(inspected.api_key_configured);
        assert!(!inspected.session_extension);

        let _ = std::fs::remove_dir_all(settings_path.parent().unwrap());
    }

    #[test]
    fn rolls_back_opencode_config_when_credentials_write_fails() {
        let (settings_path, auth_path) = test_opencode_paths();
        let directory = settings_path
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        std::fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&auth_path).unwrap();
        let original = b"{\n  // unchanged\n  \"theme\": \"system\"\n}\n";
        std::fs::write(&settings_path, original).unwrap();

        let error = apply_opencode(
            &settings_path,
            &auth_path,
            &settings_path.parent().unwrap().join("plugins/flowlet.ts"),
            "http://127.0.0.1:18640/v1",
            "flowlet-token",
        )
        .unwrap_err();

        assert!(error.contains("已回滚 OpenCode 配置与凭据文件"));
        assert_eq!(std::fs::read(&settings_path).unwrap(), original);
        assert!(auth_path.is_dir());
        assert!(!opencode_backup_path(&settings_path).exists());

        let _ = std::fs::remove_dir_all(directory);
    }

    // ─── Codex ─────────────────────────────────────────────────────────────

    /// 测试用临时 Codex 配置路径。inspect/apply/restore 均以路径为参数，
    /// 不需要改写进程级 CODEX_HOME 环境变量（避免并行测试互相干扰）。
    fn test_codex_paths() -> (PathBuf, PathBuf, PathBuf) {
        let directory = std::env::temp_dir().join(format!(
            "flowlet-codex-global-config-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        (
            directory.join("config.toml"),
            directory.join("auth.json"),
            directory.join(CODEX_MODEL_CATALOG_FILE),
        )
    }

    fn parse_toml(path: &Path) -> toml_edit::DocumentMut {
        std::fs::read_to_string(path)
            .unwrap()
            .parse::<toml_edit::DocumentMut>()
            .unwrap()
    }

    fn toml_str<'a>(doc: &'a toml_edit::DocumentMut, key: &str) -> Option<&'a str> {
        doc.get(key)
            .and_then(|item| item.as_value())
            .and_then(|value| value.as_str())
    }

    fn toml_bool(doc: &toml_edit::DocumentMut, key: &str) -> Option<bool> {
        doc.get(key)
            .and_then(|item| item.as_value())
            .and_then(|value| value.as_bool())
    }

    const CODEX_EXPECTED_BASE_URL: &str = "http://127.0.0.1:18640/v1";

    #[test]
    fn applies_and_restores_codex_config_and_credentials() {
        let (config_path, auth_path, models_path) = test_codex_paths();
        // 用户既有配置：注释、其它 provider、以及一份指向旧端口的 flowlet provider
        //（含多余字段，写入时应被整体替换）。auth.json 保留 ChatGPT 登录凭据。
        std::fs::write(
            &config_path,
            r##"# user comment
model = "gpt-5"
model_provider = "other"

[model_providers.other]
name = "other"
base_url = "https://gateway.example/v1"
wire_api = "responses"

[model_providers.flowlet]
name = "flowlet"
base_url = "http://127.0.0.1:9999/v1"
wire_api = "responses"
extra = "stale"
"##,
        )
        .unwrap();
        std::fs::write(
            &auth_path,
            r#"{"tokens":{"access_token":"chatgpt-token"},"OPENAI_API_KEY":"old-key"}"#,
        )
        .unwrap();

        let report = apply_codex(
            &config_path,
            &auth_path,
            &models_path,
            CODEX_EXPECTED_BASE_URL,
            "flowlet-token",
        )
        .unwrap();
        assert_eq!(report.state, AgentGlobalConfigState::Flowlet);
        assert!(report.backup_available);
        assert_eq!(report.primary_model.as_deref(), Some("flowlet-pro"));
        assert_eq!(report.base_url.as_deref(), Some(CODEX_EXPECTED_BASE_URL));
        assert!(report.auth_token_configured);

        let config_text = std::fs::read_to_string(&config_path).unwrap();
        // 用户注释与其它 provider 原样保留
        assert!(config_text.contains("# user comment"));
        assert!(config_text.contains("[model_providers.other]"));
        assert!(config_text.contains("https://gateway.example/v1"));
        // 旧版残留的多余字段被整体替换清理
        assert!(!config_text.contains("stale"));
        let doc = parse_toml(&config_path);
        assert_eq!(toml_str(&doc, "model"), Some("flowlet-pro"));
        assert_eq!(toml_str(&doc, "model_provider"), Some("flowlet"));
        assert_eq!(toml_bool(&doc, "disable_response_storage"), Some(true));
        assert_eq!(toml_str(&doc, "preferred_auth_method"), Some("apikey"));
        // 模型目录：config.toml 指向 Flowlet 目录引用，且 ~/.codex 下的目录文件已生成
        assert_eq!(toml_str(&doc, "model_catalog_json"), Some(CODEX_MODEL_CATALOG_REF));
        assert!(models_path.is_file());
        let catalog: Value =
            serde_json::from_str(&std::fs::read_to_string(&models_path).unwrap()).unwrap();
        let catalog_slugs = catalog
            .get("models")
            .and_then(Value::as_array)
            .map(|models| {
                models
                    .iter()
                    .filter_map(|model| model.get("slug").and_then(Value::as_str))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        assert!(catalog_slugs.contains(&"flowlet-pro"), "{catalog_slugs:?}");
        assert!(report.model_catalog_configured);
        assert_eq!(
            report.model_catalog_path.as_deref(),
            Some(CODEX_MODEL_CATALOG_REF)
        );
        let flowlet_base = doc
            .get("model_providers")
            .and_then(|item| item.get("flowlet"))
            .and_then(|item| item.as_table_like())
            .and_then(|table| table.get("base_url"))
            .and_then(|item| item.as_value())
            .and_then(|value| value.as_str());
        assert_eq!(flowlet_base, Some(CODEX_EXPECTED_BASE_URL));
        let flowlet_requires_auth = doc
            .get("model_providers")
            .and_then(|item| item.get("flowlet"))
            .and_then(|item| item.as_table_like())
            .and_then(|table| table.get("requires_openai_auth"))
            .and_then(|item| item.as_value())
            .and_then(|value| value.as_bool());
        assert_eq!(flowlet_requires_auth, Some(true));

        // auth.json：仅替换 OPENAI_API_KEY，ChatGPT 登录凭据保留
        let auth: Value =
            serde_json::from_str(&std::fs::read_to_string(&auth_path).unwrap()).unwrap();
        assert_eq!(
            auth.get("OPENAI_API_KEY").and_then(Value::as_str),
            Some("flowlet-token")
        );
        assert_eq!(
            auth.pointer("/tokens/access_token").and_then(Value::as_str),
            Some("chatgpt-token")
        );

        // 恢复：旧 model/provider/auth 值全部回位
        let restored = restore_codex(&config_path, &auth_path, &models_path, CODEX_EXPECTED_BASE_URL).unwrap();
        // 恢复后 model_provider 指回 other（base_url 非 Flowlet）→ OtherGateway
        assert_eq!(restored.state, AgentGlobalConfigState::OtherGateway);
        assert!(!restored.backup_available);

        let config_text = std::fs::read_to_string(&config_path).unwrap();
        assert!(config_text.contains("# user comment"));
        let doc = parse_toml(&config_path);
        assert_eq!(toml_str(&doc, "model"), Some("gpt-5"));
        assert_eq!(toml_str(&doc, "model_provider"), Some("other"));
        assert_eq!(toml_bool(&doc, "disable_response_storage"), None);
        assert_eq!(toml_str(&doc, "preferred_auth_method"), None);
        assert_eq!(toml_str(&doc, "model_catalog_json"), None);
        // 模型目录文件由 Flowlet 创建且原本不存在，恢复后应被删除
        assert!(!models_path.exists());
        // 旧 flowlet provider 表（含多余字段）整体回位
        assert!(config_text.contains("http://127.0.0.1:9999/v1"));
        assert!(config_text.contains("stale"));

        let auth: Value =
            serde_json::from_str(&std::fs::read_to_string(&auth_path).unwrap()).unwrap();
        assert_eq!(
            auth.get("OPENAI_API_KEY").and_then(Value::as_str),
            Some("old-key")
        );
        assert_eq!(
            auth.pointer("/tokens/access_token").and_then(Value::as_str),
            Some("chatgpt-token")
        );
    }

    #[test]
    fn removes_codex_files_created_only_for_flowlet() {
        let (config_path, auth_path, models_path) = test_codex_paths();
        assert!(!config_path.exists());
        assert!(!auth_path.exists());

        let report = apply_codex(
            &config_path,
            &auth_path,
            &models_path,
            CODEX_EXPECTED_BASE_URL,
            "flowlet-token",
        )
        .unwrap();
        assert_eq!(report.state, AgentGlobalConfigState::Flowlet);
        assert!(config_path.is_file());
        assert!(auth_path.is_file());

        let restored = restore_codex(&config_path, &auth_path, &models_path, CODEX_EXPECTED_BASE_URL).unwrap();
        assert_eq!(restored.state, AgentGlobalConfigState::NotConfigured);
        assert!(!config_path.exists());
        assert!(!auth_path.exists());
        assert!(!models_path.exists());
        assert!(!codex_backup_path(&config_path).exists());
    }

    #[test]
    fn reports_not_configured_other_gateway_and_partial_for_codex() {
        let (config_path, auth_path, models_path) = test_codex_paths();

        // 与 Flowlet 无关的配置 → NotConfigured
        std::fs::write(
            &config_path,
            "model = \"gpt-5\"\nmodel_provider = \"openai\"\n",
        )
        .unwrap();
        let report = inspect_codex(&config_path, &auth_path, &models_path, CODEX_EXPECTED_BASE_URL).unwrap();
        assert_eq!(report.state, AgentGlobalConfigState::NotConfigured);

        // 指向别的网关 → OtherGateway
        std::fs::write(
            &config_path,
            r#"model_provider = "other"

[model_providers.other]
base_url = "https://gateway.example/v1"
"#,
        )
        .unwrap();
        let report = inspect_codex(&config_path, &auth_path, &models_path, CODEX_EXPECTED_BASE_URL).unwrap();
        assert_eq!(report.state, AgentGlobalConfigState::OtherGateway);

        // 只有部分 Flowlet 标记（model 对了，provider 缺失）→ Partial
        std::fs::write(&config_path, "model = \"flowlet-pro\"\n").unwrap();
        let report = inspect_codex(&config_path, &auth_path, &models_path, CODEX_EXPECTED_BASE_URL).unwrap();
        assert_eq!(report.state, AgentGlobalConfigState::Partial);

        // Flowlet 标记齐全但缺少模型目录 → Partial（提示用户重新写入以补齐目录）
        std::fs::write(
            &config_path,
            r##"model = "flowlet-pro"
model_provider = "flowlet"
disable_response_storage = true
preferred_auth_method = "apikey"

[model_providers.flowlet]
name = "flowlet"
base_url = "http://127.0.0.1:18640/v1"
wire_api = "responses"
requires_openai_auth = true
"##,
        )
        .unwrap();
        std::fs::write(&auth_path, r#"{"OPENAI_API_KEY":"flowlet-token"}"#).unwrap();
        let report = inspect_codex(&config_path, &auth_path, &models_path, CODEX_EXPECTED_BASE_URL).unwrap();
        assert_eq!(report.state, AgentGlobalConfigState::Partial);
        assert!(!report.model_catalog_configured);

        // 补齐 model_catalog_json 且目录文件在位 → Flowlet
        std::fs::write(
            &config_path,
            &format!(
                r##"model = "flowlet-pro"
model_provider = "flowlet"
disable_response_storage = true
preferred_auth_method = "apikey"
model_catalog_json = "{CODEX_MODEL_CATALOG_REF}"

[model_providers.flowlet]
name = "flowlet"
base_url = "http://127.0.0.1:18640/v1"
wire_api = "responses"
requires_openai_auth = true
"##
            ),
        )
        .unwrap();
        std::fs::write(&models_path, codex_model_catalog::DEFAULT_CODEX_MODELS_JSON).unwrap();
        let report = inspect_codex(&config_path, &auth_path, &models_path, CODEX_EXPECTED_BASE_URL).unwrap();
        assert_eq!(report.state, AgentGlobalConfigState::Flowlet);
        assert!(report.model_catalog_configured);
    }

    #[test]
    fn reports_invalid_codex_toml_without_overwriting_it() {
        let (config_path, auth_path, models_path) = test_codex_paths();
        let broken = "model = [invalid";
        std::fs::write(&config_path, broken).unwrap();

        let report = inspect_codex(&config_path, &auth_path, &models_path, CODEX_EXPECTED_BASE_URL).unwrap();
        assert_eq!(report.state, AgentGlobalConfigState::Invalid);
        assert!(report.error.is_some());

        let error = apply_codex(
            &config_path,
            &auth_path,
            &models_path,
            CODEX_EXPECTED_BASE_URL,
            "flowlet-token",
        )
        .unwrap_err();
        assert!(error.contains("解析"));
        assert_eq!(std::fs::read_to_string(&config_path).unwrap(), broken);
        assert!(!codex_backup_path(&config_path).exists());
        assert!(!models_path.exists());
    }

    #[test]
    fn apply_codex_requires_client_token() {
        let (config_path, auth_path, models_path) = test_codex_paths();
        let error = apply_codex(&config_path, &auth_path, &models_path, CODEX_EXPECTED_BASE_URL, "  ")
            .unwrap_err();
        assert!(error.contains("Client Token"));
        assert!(!config_path.exists());
        assert!(!models_path.exists());
    }

    #[test]
    fn preserves_existing_models_catalog_and_reference_on_restore() {
        let (config_path, auth_path, models_path) = test_codex_paths();
        // 用户已有模型目录文件（例如 DeepSeek 的目录）与自定义 model_catalog_json。
        let original_catalog = r#"{"models":[{"slug":"deepseek-v4-flash","context_window":1048576}]}"#;
        std::fs::write(&models_path, original_catalog).unwrap();
        std::fs::write(
            &config_path,
            r##"model = "gpt-5"
model_provider = "other"
model_catalog_json = "~/.codex/models.json"

[model_providers.other]
name = "other"
base_url = "https://gateway.example/v1"
wire_api = "responses"
"##,
        )
        .unwrap();

        let report = apply_codex(
            &config_path,
            &auth_path,
            &models_path,
            CODEX_EXPECTED_BASE_URL,
            "flowlet-token",
        )
        .unwrap();
        assert_eq!(report.state, AgentGlobalConfigState::Flowlet);
        // 目录被 Flowlet 内容替换
        assert_eq!(
            std::fs::read_to_string(&models_path).unwrap(),
            codex_model_catalog::DEFAULT_CODEX_MODELS_JSON
        );

        // 恢复：model_catalog_json 与目录内容都回位
        let restored =
            restore_codex(&config_path, &auth_path, &models_path, CODEX_EXPECTED_BASE_URL).unwrap();
        assert_eq!(restored.state, AgentGlobalConfigState::OtherGateway);
        assert_eq!(std::fs::read_to_string(&models_path).unwrap(), original_catalog);
        let doc = parse_toml(&config_path);
        assert_eq!(toml_str(&doc, "model_catalog_json"), Some("~/.codex/models.json"));
    }

    #[test]
    fn legacy_codex_backup_without_models_fields_is_upgraded_on_reapply() {
        let (config_path, auth_path, models_path) = test_codex_paths();
        // 模拟旧版本生成的备份：没有 models_path/models_content 字段。
        let backup_path = codex_backup_path(&config_path);
        std::fs::create_dir_all(backup_path.parent().unwrap()).unwrap();
        let legacy_backup = serde_json::json!({
            "version": 1,
            "agent_id": "codex",
            "created_at": "2026-01-01T00:00:00Z",
            "config_path": display_path(&config_path),
            "auth_path": display_path(&auth_path),
            "config_existed": false,
            "auth_existed": false,
            "provider_table_existed": false,
            "top_level": {},
            "flowlet_provider": {"present": false, "value": null},
            "auth_key": {"present": false, "value": null},
        });
        std::fs::write(
            &backup_path,
            serde_json::to_vec(&legacy_backup).unwrap(),
        )
        .unwrap();

        let report = apply_codex(
            &config_path,
            &auth_path,
            &models_path,
            CODEX_EXPECTED_BASE_URL,
            "flowlet-token",
        )
        .unwrap();
        assert_eq!(report.state, AgentGlobalConfigState::Flowlet);
        assert!(models_path.is_file());
        // 旧备份被升级，恢复时应删除 Flowlet 生成的模型目录
        let restored =
            restore_codex(&config_path, &auth_path, &models_path, CODEX_EXPECTED_BASE_URL).unwrap();
        assert_eq!(restored.state, AgentGlobalConfigState::NotConfigured);
        assert!(!models_path.exists());
        assert!(!config_path.exists());
        assert!(!backup_path.exists());
    }
}
