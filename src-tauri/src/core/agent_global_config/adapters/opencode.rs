use super::super::*;
use super::AgentGlobalConfigAdapter;

const OPENCODE_BACKUP_FILE: &str = "opencode-global-config-backup.json";
pub(in crate::core::agent_global_config) const OPENCODE_PROVIDER_ID: &str = "flowlet";
pub(in crate::core::agent_global_config) const OPENCODE_PRIMARY_MODEL: &str = "flowlet/flowlet-pro";
pub(in crate::core::agent_global_config) const OPENCODE_FAST_MODEL: &str = "flowlet/flowlet-flash";
const OPENCODE_PERMISSION_PLUGIN_FILE: &str = "plugins/flowlet.ts";

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

pub(in crate::core::agent_global_config) fn opencode_backup_path(settings_path: &Path) -> PathBuf {
    settings_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(FLOWLET_DIR)
        .join(OPENCODE_BACKUP_FILE)
}

pub(super) struct OpenCodeAdapter;

impl AgentGlobalConfigAdapter for OpenCodeAdapter {
    fn id(&self) -> &'static str {
        "opencode"
    }

    fn inspect(&self, expected_base_url: &str) -> Result<AgentGlobalConfigReport, String> {
        inspect_opencode(
            &opencode_settings_path()?,
            &opencode_auth_path()?,
            &opencode_permission_plugin_path()?,
            expected_base_url,
        )
    }

    fn apply(
        &self,
        expected_base_url: &str,
        client_token: &str,
        options: Option<&AgentGlobalConfigOptions>,
    ) -> Result<AgentGlobalConfigReport, String> {
        apply_opencode_with_model_specs(
            &opencode_settings_path()?,
            &opencode_auth_path()?,
            &opencode_permission_plugin_path()?,
            expected_base_url,
            client_token,
            options
                .and_then(|options| options.model_specs)
                .unwrap_or(false),
            options.and_then(|options| options.model_input_modalities.as_ref()),
        )
    }

    fn restore(&self, expected_base_url: &str) -> Result<AgentGlobalConfigReport, String> {
        restore_opencode(
            &opencode_settings_path()?,
            &opencode_auth_path()?,
            &opencode_permission_plugin_path()?,
            expected_base_url,
        )
    }
}

pub(in crate::core::agent_global_config) fn inspect_opencode(
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
            primary_long_context: false,
            fast_long_context: false,
            long_context: false,
            backup_available,
            external_environment_overrides,
            error: None,
            session_extension: false,
            model_specs: false,
            model_input_modalities: BTreeMap::new(),
            approval_bridge: false,
            opencode_permission_bridge: permission_bridge,
            mcp_servers: Vec::new(),
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
                primary_long_context: false,
                fast_long_context: false,
                long_context: false,
                backup_available,
                external_environment_overrides,
                error: Some(error),
                session_extension: false,
                model_specs: false,
                model_input_modalities: BTreeMap::new(),
                approval_bridge: false,
                opencode_permission_bridge: permission_bridge,
                mcp_servers: Vec::new(),
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
                primary_long_context: false,
                fast_long_context: false,
                long_context: false,
                backup_available,
                external_environment_overrides,
                error: Some(error),
                session_extension: false,
                model_specs: false,
                model_input_modalities: BTreeMap::new(),
                approval_bridge: false,
                opencode_permission_bridge: permission_bridge,
                mcp_servers: Vec::new(),
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
    let model_specs = ["flowlet-pro", "flowlet-flash"].into_iter().all(|model| {
        provider
            .and_then(|provider| provider.pointer(&format!("/models/{model}/modalities/input")))
            .and_then(Value::as_array)
            .is_some_and(|inputs| inputs.iter().any(|input| input.as_str() == Some("text")))
            && provider
                .and_then(|provider| {
                    provider.pointer(&format!("/models/{model}/modalities/output"))
                })
                .and_then(Value::as_array)
                .is_some_and(|outputs| outputs.iter().any(|output| output.as_str() == Some("text")))
    });
    let model_input_modalities = ["flowlet-pro", "flowlet-flash"]
        .into_iter()
        .filter_map(|model| {
            provider
                .and_then(|provider| provider.pointer(&format!("/models/{model}/modalities/input")))
                .and_then(Value::as_array)
                .map(|inputs| {
                    (
                        model.to_string(),
                        inputs
                            .iter()
                            .filter_map(Value::as_str)
                            .map(ToOwned::to_owned)
                            .collect(),
                    )
                })
        })
        .collect();
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
        primary_long_context: false,
        fast_long_context: false,
        long_context: false,
        backup_available,
        external_environment_overrides,
        error: None,
        session_extension: false,
        model_specs,
        model_input_modalities,
        approval_bridge: false,
        opencode_permission_bridge: permission_bridge,
        mcp_servers: Vec::new(),
    })
}

#[cfg(test)]
pub(in crate::core::agent_global_config) fn apply_opencode(
    settings_path: &Path,
    auth_path: &Path,
    permission_plugin_path: &Path,
    expected_base_url: &str,
    client_token: &str,
) -> Result<AgentGlobalConfigReport, String> {
    apply_opencode_with_model_specs(
        settings_path,
        auth_path,
        permission_plugin_path,
        expected_base_url,
        client_token,
        false,
        None,
    )
}

pub(in crate::core::agent_global_config) fn apply_opencode_with_model_specs(
    settings_path: &Path,
    auth_path: &Path,
    permission_plugin_path: &Path,
    expected_base_url: &str,
    client_token: &str,
    model_specs: bool,
    model_input_modalities: Option<&BTreeMap<String, Vec<String>>>,
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
    let provider = if model_specs {
        let pro_inputs = declared_model_inputs(model_input_modalities, "flowlet-pro");
        let flash_inputs = declared_model_inputs(model_input_modalities, "flowlet-flash");
        serde_json::json!({
            "name": "Flowlet",
            "npm": "@ai-sdk/openai-compatible",
            "options": {
                "baseURL": expected_base_url
            },
            "models": {
                "flowlet-pro": { "name": "flowlet-pro", "modalities": { "input": pro_inputs, "output": ["text"] } },
                "flowlet-flash": { "name": "flowlet-flash", "modalities": { "input": flash_inputs, "output": ["text"] } }
            }
        })
    } else {
        serde_json::json!({
            "name": "Flowlet",
            "npm": "@ai-sdk/openai-compatible",
            "options": { "baseURL": expected_base_url },
            "models": {
                "flowlet-pro": { "name": "flowlet-pro" },
                "flowlet-flash": { "name": "flowlet-flash" }
            }
        })
    };
    set_cst_property(
        &provider_object,
        OPENCODE_PROVIDER_ID,
        serde_to_cst(&provider),
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

pub(in crate::core::agent_global_config) fn restore_opencode(
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

pub(in crate::core::agent_global_config) fn upgrade_opencode_backup_with_server(
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

pub(in crate::core::agent_global_config) fn read_jsonc_settings(
    path: &Path,
) -> Result<Value, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
    let value = jsonc_parser::parse_to_serde_value::<Value>(&content, &ParseOptions::default())
        .map_err(|error| format!("解析 {} 失败：{error}", path.display()))?;
    if !value.is_object() {
        return Err(format!("{} 顶层必须是 JSON 对象", path.display()));
    }
    Ok(value)
}

/// OpenCode CLI、Web 与 Desktop 都会加载全局插件。每个进程按 PID 写一份短期心跳，
/// Flowlet 因而无需猜测 Desktop sidecar 的动态端口，也不会让多个并行实例互相覆盖。
pub(super) const OPENCODE_PERMISSION_PLUGIN_SOURCE: &str = r#"// Flowlet 自动写入：桥接 OpenCode 进程内待确认权限状态。
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
