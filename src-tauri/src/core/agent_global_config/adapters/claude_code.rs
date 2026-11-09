use super::super::*;
use super::AgentGlobalConfigAdapter;

const ACTIVE_BACKUP_FILE: &str = "claude-code-global-config-backup.json";
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
const EXTERNAL_OVERRIDE_FIELDS: &[&str] = MANAGED_FIELDS;

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

pub(in crate::core::agent_global_config) fn backup_path(settings_path: &Path) -> PathBuf {
    settings_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(FLOWLET_DIR)
        .join(ACTIVE_BACKUP_FILE)
}

pub(super) struct ClaudeCodeAdapter;

impl AgentGlobalConfigAdapter for ClaudeCodeAdapter {
    fn id(&self) -> &'static str {
        "claude-code"
    }

    fn inspect(&self, expected_base_url: &str) -> Result<AgentGlobalConfigReport, String> {
        inspect_claude_code(&claude_settings_path()?, expected_base_url)
    }

    fn apply(
        &self,
        expected_base_url: &str,
        client_token: &str,
        options: Option<&AgentGlobalConfigOptions>,
    ) -> Result<AgentGlobalConfigReport, String> {
        let (primary_model, fast_model) = resolve_model_choices(options)?;
        apply_claude_code(
            &claude_settings_path()?,
            expected_base_url,
            client_token,
            &primary_model,
            &fast_model,
        )
    }

    fn restore(&self, expected_base_url: &str) -> Result<AgentGlobalConfigReport, String> {
        restore_claude_code(&claude_settings_path()?, expected_base_url)
    }
}

pub(in crate::core::agent_global_config) fn inspect_claude_code(
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
            backup_available,
            external_environment_overrides,
            error: None,
            session_extension: false,
            opencode_permission_bridge: false,
            mcp_servers: Vec::new(),
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
                backup_available,
                external_environment_overrides,
                error: Some(error),
                session_extension: false,
                opencode_permission_bridge: false,
                mcp_servers: Vec::new(),
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

/// 判断一组受管环境变量是否都存在且指向同一个模型值。
fn alias_group_matches(names: &[&str], string_value: &impl Fn(&str) -> Option<String>) -> bool {
    // 每个变量都必须存在（缺 FABLE/OPUS 等别名视为未收敛），且值完全一致。
    let mut values = names.iter().map(|name| string_value(name));
    let Some(Some(first)) = values.next() else {
        return false;
    };
    values.all(|value| value.as_deref() == Some(first.as_str()))
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
    // 聚合模型移除后不再有 `[1m]` 长上下文后缀：inspect 只校验同一模型组内的
    // 各别名指向同一个模型。默认模型由用户在接入抽屉中显式选择，值本身无需是
    // 某个固定常量，因此这里比较的是「组内一致」而非「等于内置模型名」。
    let primary_known = primary_model.as_deref().is_some_and(is_known_catalog_model);
    let fast_known = fast_model.as_deref().is_some_and(is_known_catalog_model);
    let primary_aliases_match = alias_group_matches(
        &[
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_FABLE_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
        ],
        &string_value,
    );
    let fast_aliases_match = alias_group_matches(
        &[
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_SMALL_FAST_MODEL",
            "CLAUDE_CODE_SUBAGENT_MODEL",
        ],
        &string_value,
    );
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
        && primary_aliases_match
        && fast_aliases_match
        && primary_known
        && fast_known
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
        backup_available,
        external_environment_overrides,
        error: None,
        session_extension: false,
        opencode_permission_bridge: false,
        mcp_servers: Vec::new(),
    })
}

pub(in crate::core::agent_global_config) fn apply_claude_code(
    settings_path: &Path,
    expected_base_url: &str,
    client_token: &str,
    primary_model: &str,
    fast_model: &str,
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
    // 主模型组（主会话 / Fable / Opus / Sonnet 别名）与快速模型组（Haiku /
    // SMALL_FAST / 子 Agent）分别写入用户选择的规范模型 ID。
    for (name, value) in [
        ("ANTHROPIC_BASE_URL", expected_base_url),
        ("ANTHROPIC_AUTH_TOKEN", client_token.trim()),
        ("ANTHROPIC_MODEL", primary_model),
        ("ANTHROPIC_DEFAULT_FABLE_MODEL", primary_model),
        ("ANTHROPIC_DEFAULT_OPUS_MODEL", primary_model),
        ("ANTHROPIC_DEFAULT_SONNET_MODEL", primary_model),
        ("ANTHROPIC_DEFAULT_HAIKU_MODEL", fast_model),
        ("ANTHROPIC_SMALL_FAST_MODEL", fast_model),
        ("CLAUDE_CODE_SUBAGENT_MODEL", fast_model),
    ] {
        env.insert(name.to_string(), Value::String(value.to_string()));
    }

    write_json_file(settings_path, &settings)?;
    inspect_claude_code(settings_path, expected_base_url)
}

pub(in crate::core::agent_global_config) fn restore_claude_code(
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
