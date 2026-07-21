use jsonc_parser::cst::{CstInputValue, CstObject, CstRootNode};
use jsonc_parser::json;
use jsonc_parser::ParseOptions;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use super::agent_environment::display_path;

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
const PI_BACKUP_FILE: &str = "pi-global-config-backup.json";
const PI_PROVIDER_ID: &str = "flowlet";
const PI_PRIMARY_MODEL: &str = "flowlet-pro";
const PI_FAST_MODEL: &str = "flowlet-flash";

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
    flowlet_provider: BackedUpValue,
    flowlet_auth: BackedUpValue,
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
            expected_base_url,
        ),
        "pi" => inspect_pi(
            &pi_settings_path()?,
            &pi_models_path()?,
            &pi_auth_path()?,
            &pi_extension_path()?,
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
            options.as_ref().map_or(true, |options| options.session_extension),
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
            expected_base_url,
        ),
        "pi" => restore_pi(
            &pi_settings_path()?,
            &pi_models_path()?,
            &pi_auth_path()?,
            &pi_extension_path()?,
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
            long_context: false,
            backup_available,
            external_environment_overrides,
            error: None,
            session_extension: false,
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
                long_context: false,
                backup_available,
                external_environment_overrides,
                error: Some(error),
                session_extension: false,
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
    })
        && fast_model.as_deref() == Some(FAST_MODEL);
    // 写入时四个主模型变量同时带后缀；检测只看 ANTHROPIC_MODEL 即可反映开关状态。
    let long_context = primary_model.as_deref().is_some_and(has_long_context_suffix);
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
        long_context,
        backup_available,
        external_environment_overrides,
        error: None,
        session_extension: false,
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
    expected_base_url: &str,
) -> Result<AgentGlobalConfigReport, String> {
    let settings_exists = settings_path.is_file();
    let backup_available = opencode_backup_path(settings_path).is_file();
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
            long_context: false,
            backup_available,
            external_environment_overrides,
            error: None,
            session_extension: false,
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
                long_context: false,
                backup_available,
                external_environment_overrides,
                error: Some(error),
                session_extension: false,
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
                long_context: false,
                backup_available,
                external_environment_overrides,
                error: Some(error),
                session_extension: false,
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
        long_context: false,
        backup_available,
        external_environment_overrides,
        error: None,
        session_extension: false,
    })
}

fn apply_opencode(
    settings_path: &Path,
    auth_path: &Path,
    expected_base_url: &str,
    client_token: &str,
) -> Result<AgentGlobalConfigReport, String> {
    if client_token.trim().is_empty() {
        return Err("Flowlet 默认 Client Token 未配置，无法写入 OpenCode".to_string());
    }
    let settings_existed = settings_path.is_file();
    let auth_existed = auth_path.is_file();
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
            flowlet_provider: backed_up_value(settings.pointer("/provider/flowlet")),
            flowlet_auth: backed_up_value(auth.get("flowlet")),
        };
        write_json_file(
            &backup,
            &serde_json::to_value(snapshot).map_err(|error| error.to_string())?,
        )?;
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
    if let Err(failure) = write_files_transactionally(
        "OpenCode 配置与凭据文件",
        &[
            (settings_path.to_path_buf(), Some(settings_content)),
            (auth_path.to_path_buf(), Some(auth_content)),
        ],
    ) {
        if backup_created && failure.rolled_back {
            let _ = std::fs::remove_file(&backup);
        }
        return Err(failure.message);
    }
    inspect_opencode(settings_path, auth_path, expected_base_url)
}

fn restore_opencode(
    settings_path: &Path,
    expected_auth_path: &Path,
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
    write_files_transactionally(
        "OpenCode 配置与凭据文件",
        &[
            (settings_path.to_path_buf(), settings_content),
            (auth_path.to_path_buf(), auth_content),
        ],
    )
    .map_err(|failure| failure.message)?;
    std::fs::remove_file(&backup_path)
        .map_err(|error| format!("配置已恢复，但清理 Flowlet 备份标记失败：{error}"))?;
    inspect_opencode(settings_path, expected_auth_path, expected_base_url)
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
            long_context: false,
            backup_available,
            external_environment_overrides: Vec::new(),
            error,
            session_extension,
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
    let api_matches = provider.and_then(|value| value.get("api")).and_then(Value::as_str)
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
    let models_shape_matches = model_ids.contains(&PI_PRIMARY_MODEL)
        && model_ids.contains(&PI_FAST_MODEL);
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
            Some(Value::String(std::fs::read_to_string(extension_path).map_err(
                |error| format!("读取 Pi 会话扩展失败：{error}"),
            )?))
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
        (settings_path.to_path_buf(), Some(json_file_bytes(&settings)?)),
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
    if let Err(failure) = write_files_transactionally(
        "Pi 配置、模型、凭据与会话扩展文件",
        &writes,
    ) {
        if backup_created && failure.rolled_back {
            let _ = std::fs::remove_file(&backup);
        }
        return Err(failure.message);
    }
    inspect_pi(settings_path, models_path, auth_path, extension_path, expected_base_url)
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
        models.as_object_mut()
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
        auth_object.insert(PI_PROVIDER_ID.to_string(), backup.flowlet_auth.value.clone());
    } else {
        auth_object.remove(PI_PROVIDER_ID);
    }

    let settings_content =
        if !backup.settings_existed && settings.as_object().unwrap().is_empty() {
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

        let applied =
            apply_claude_code(&path, "http://127.0.0.1:18640/anthropic", "flowlet-token", false).unwrap();
        assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
        assert!(applied.backup_available);
        let current = read_settings(&path).unwrap();
        assert_eq!(current["theme"], "dark");
        assert_eq!(current["env"]["CUSTOM"], "keep");
        assert!(current["env"].get("ANTHROPIC_API_KEY").is_none());
        assert_eq!(current["env"]["ANTHROPIC_DEFAULT_FABLE_MODEL"], PRIMARY_MODEL);
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
        assert_eq!(current["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"], PRIMARY_MODEL);

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

        let applied =
            apply_claude_code(&path, "http://127.0.0.1:18640/anthropic", "flowlet-token", false).unwrap();
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

        let applied =
            apply_claude_code(&path, "http://127.0.0.1:18640/anthropic", "flowlet-token", false).unwrap();
        assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
        let current = read_settings(&path).unwrap();
        assert_eq!(current["env"]["ANTHROPIC_DEFAULT_FABLE_MODEL"], PRIMARY_MODEL);

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn removes_settings_created_only_for_flowlet_on_restore() {
        let path = test_settings_path();
        let directory = path.parent().unwrap().to_path_buf();

        apply_claude_code(&path, "http://127.0.0.1:18640/anthropic", "flowlet-token", false).unwrap();
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

        apply_claude_code(&path, "http://127.0.0.1:18640/anthropic", "flowlet-token", false).unwrap();
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
        assert!(apply_claude_code(&path, "http://127.0.0.1:18640/anthropic", "token", false).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{invalid");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn applies_and_restores_opencode_config_and_credentials() {
        let (settings_path, auth_path) = test_opencode_paths();
        std::fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
        std::fs::create_dir_all(auth_path.parent().unwrap()).unwrap();
        std::fs::write(
            &settings_path,
            r#"{
  // keep this user setting
  "theme": "system",
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
            "http://127.0.0.1:18640/v1",
            "flowlet-token",
        )
        .unwrap();
        assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
        assert!(applied.backup_available);
        let settings = read_jsonc_settings(&settings_path).unwrap();
        assert_eq!(settings["model"], OPENCODE_PRIMARY_MODEL);
        assert_eq!(settings["small_model"], OPENCODE_FAST_MODEL);
        assert_eq!(
            settings["provider"]["flowlet"]["options"]["baseURL"],
            "http://127.0.0.1:18640/v1"
        );
        assert!(settings["provider"]["flowlet"]["options"]
            .get("apiKey")
            .is_none());
        assert_eq!(
            settings["disabled_providers"],
            serde_json::json!(["legacy"])
        );
        assert_eq!(
            settings["enabled_providers"],
            serde_json::json!(["other", "flowlet"])
        );
        assert!(std::fs::read_to_string(&settings_path)
            .unwrap()
            .contains("// keep this user setting"));
        let auth = read_settings(&auth_path).unwrap();
        assert_eq!(auth["flowlet"]["type"], "api");
        assert_eq!(auth["flowlet"]["key"], "flowlet-token");
        assert_eq!(auth["other"]["key"], "keep");

        let restored =
            restore_opencode(&settings_path, &auth_path, "http://127.0.0.1:18640/v1").unwrap();
        assert_eq!(restored.state, AgentGlobalConfigState::OtherGateway);
        let restored_settings = read_jsonc_settings(&settings_path).unwrap();
        assert_eq!(restored_settings["theme"], "system");
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

        let _ = std::fs::remove_dir_all(settings_path.parent().unwrap().parent().unwrap());
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
            "http://127.0.0.1:18640/v1",
            "flowlet-token",
        )
        .unwrap();
        restore_opencode(&settings_path, &auth_path, "http://127.0.0.1:18640/v1").unwrap();
        assert!(!settings_path.exists());
        assert!(!auth_path.exists());

        let _ = std::fs::remove_dir_all(directory);
    }

    fn test_pi_paths() -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        let directory = std::env::temp_dir().join(format!(
            "flowlet-pi-global-config-{}",
            uuid::Uuid::new_v4()
        ));
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
        assert_eq!(models["providers"]["other"]["baseUrl"], "https://other.example");
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
        assert_eq!(models["providers"]["flowlet"]["models"][0]["id"], "old-model");
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
}
