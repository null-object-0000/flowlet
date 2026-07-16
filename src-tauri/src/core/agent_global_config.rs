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
const FLOWLET_DIR: &str = ".flowlet";
const ACTIVE_BACKUP_FILE: &str = "claude-code-global-config-backup.json";
const OPENCODE_BACKUP_FILE: &str = "opencode-global-config-backup.json";
const OPENCODE_PROVIDER_ID: &str = "flowlet";
const OPENCODE_PRIMARY_MODEL: &str = "flowlet/flowlet-pro";
const OPENCODE_FAST_MODEL: &str = "flowlet/flowlet-flash";

const MANAGED_FIELDS: &[&str] = &[
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
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
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
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
    pub backup_available: bool,
    pub external_environment_overrides: Vec<String>,
    pub error: Option<String>,
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
        _ => Err(format!("暂不支持管理 Agent 全局配置：{agent_id}")),
    }
}

pub fn apply_agent_global_config(
    agent_id: &str,
    expected_base_url: &str,
    client_token: &str,
) -> Result<AgentGlobalConfigReport, String> {
    let _guard = config_lock()
        .lock()
        .map_err(|_| "Agent 全局配置锁已损坏".to_string())?;
    match agent_id {
        "claude-code" => {
            apply_claude_code(&claude_settings_path()?, expected_base_url, client_token)
        }
        "opencode" => apply_opencode(
            &opencode_settings_path()?,
            &opencode_auth_path()?,
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
            backup_available,
            external_environment_overrides,
            error: None,
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
                backup_available,
                external_environment_overrides,
                error: Some(error),
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
    let aliases_match = [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
    ]
    .iter()
    .all(|name| string_value(name).as_deref() == Some(PRIMARY_MODEL))
        && fast_model.as_deref() == Some(FAST_MODEL);
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
        backup_available,
        external_environment_overrides,
        error: None,
    })
}

fn apply_claude_code(
    settings_path: &Path,
    expected_base_url: &str,
    client_token: &str,
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
    for (name, value) in [
        ("ANTHROPIC_BASE_URL", expected_base_url),
        ("ANTHROPIC_AUTH_TOKEN", client_token.trim()),
        ("ANTHROPIC_MODEL", PRIMARY_MODEL),
        ("ANTHROPIC_DEFAULT_OPUS_MODEL", PRIMARY_MODEL),
        ("ANTHROPIC_DEFAULT_SONNET_MODEL", PRIMARY_MODEL),
        ("ANTHROPIC_DEFAULT_HAIKU_MODEL", FAST_MODEL),
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
            backup_available,
            external_environment_overrides,
            error: None,
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
                backup_available,
                external_environment_overrides,
                error: Some(error),
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
                backup_available,
                external_environment_overrides,
                error: Some(error),
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
        backup_available,
        external_environment_overrides,
        error: None,
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
    if !backup.is_file() {
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
    write_text_file(settings_path, &root.to_string())?;
    auth.as_object_mut().unwrap().insert(
        OPENCODE_PROVIDER_ID.to_string(),
        serde_json::json!({ "type": "api", "key": client_token.trim() }),
    );
    write_json_file(auth_path, &auth)?;
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

    if !backup.settings_existed && root_object.properties().is_empty() {
        if settings_path.is_file() {
            std::fs::remove_file(settings_path)
                .map_err(|error| format!("删除 Flowlet 创建的 OpenCode 配置失败：{error}"))?;
        }
    } else {
        write_text_file(settings_path, &root.to_string())?;
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
    if !backup.auth_existed && auth_object.is_empty() {
        if auth_path.is_file() {
            std::fs::remove_file(&auth_path)
                .map_err(|error| format!("删除 Flowlet 创建的 OpenCode 凭据文件失败：{error}"))?;
        }
    } else {
        write_json_file(&auth_path, &auth)?;
    }
    std::fs::remove_file(&backup_path)
        .map_err(|error| format!("配置已恢复，但清理 Flowlet 备份标记失败：{error}"))?;
    inspect_opencode(settings_path, expected_auth_path, expected_base_url)
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

fn write_json_file(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建配置目录 {} 失败：{error}", parent.display()))?;
    }
    let content =
        serde_json::to_string_pretty(value).map_err(|error| format!("序列化配置失败：{error}"))?;
    let temp_path = path.with_extension(format!(
        "{}.flowlet-tmp-{}",
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("json"),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(&temp_path, format!("{content}\n"))
        .map_err(|error| format!("写入临时配置 {} 失败：{error}", temp_path.display()))?;
    set_private_permissions(&temp_path)?;
    std::fs::rename(&temp_path, path).map_err(|error| {
        let _ = std::fs::remove_file(&temp_path);
        format!("替换配置 {} 失败：{error}", path.display())
    })?;
    Ok(())
}

fn write_text_file(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建配置目录 {} 失败：{error}", parent.display()))?;
    }
    let temp_path = path.with_extension(format!(
        "{}.flowlet-tmp-{}",
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("jsonc"),
        uuid::Uuid::new_v4()
    ));
    let content = if content.ends_with('\n') {
        content.to_string()
    } else {
        format!("{content}\n")
    };
    std::fs::write(&temp_path, content)
        .map_err(|error| format!("写入临时配置 {} 失败：{error}", temp_path.display()))?;
    set_private_permissions(&temp_path)?;
    std::fs::rename(&temp_path, path).map_err(|error| {
        let _ = std::fs::remove_file(&temp_path);
        format!("替换配置 {} 失败：{error}", path.display())
    })?;
    Ok(())
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
            r#"{"theme":"dark","env":{"ANTHROPIC_BASE_URL":"https://old.example","CUSTOM":"keep","ANTHROPIC_API_KEY":"old-secret"}}"#,
        )
        .unwrap();

        let applied =
            apply_claude_code(&path, "http://127.0.0.1:18640/anthropic", "flowlet-token").unwrap();
        assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
        assert!(applied.backup_available);
        let current = read_settings(&path).unwrap();
        assert_eq!(current["theme"], "dark");
        assert_eq!(current["env"]["CUSTOM"], "keep");
        assert!(current["env"].get("ANTHROPIC_API_KEY").is_none());
        assert_eq!(current["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"], FAST_MODEL);
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
        assert_eq!(restored_settings["env"]["CUSTOM"], "keep");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn removes_settings_created_only_for_flowlet_on_restore() {
        let path = test_settings_path();
        let directory = path.parent().unwrap().to_path_buf();

        apply_claude_code(&path, "http://127.0.0.1:18640/anthropic", "flowlet-token").unwrap();
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

        apply_claude_code(&path, "http://127.0.0.1:18640/anthropic", "flowlet-token").unwrap();
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
        assert!(apply_claude_code(&path, "http://127.0.0.1:18640/anthropic", "token").is_err());
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
}
