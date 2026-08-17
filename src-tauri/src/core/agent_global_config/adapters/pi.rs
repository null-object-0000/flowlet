use super::super::*;
use super::AgentGlobalConfigAdapter;

const PI_BACKUP_FILE: &str = "pi-global-config-backup.json";
pub(in crate::core::agent_global_config) const PI_PROVIDER_ID: &str = "flowlet";
pub(in crate::core::agent_global_config) const PI_PRIMARY_MODEL: &str = "flowlet-pro";
pub(in crate::core::agent_global_config) const PI_FAST_MODEL: &str = "flowlet-flash";

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
    extension_previous: BackedUpValue,
}

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
fn pi_extension_path() -> Result<PathBuf, String> {
    pi_agent_path("extensions/flowlet.ts")
}

fn pi_backup_path(models_path: &Path) -> PathBuf {
    models_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(FLOWLET_DIR)
        .join(PI_BACKUP_FILE)
}

pub(super) struct PiAdapter;

impl AgentGlobalConfigAdapter for PiAdapter {
    fn id(&self) -> &'static str {
        "pi"
    }

    fn inspect(&self, expected_base_url: &str) -> Result<AgentGlobalConfigReport, String> {
        inspect_pi(
            &pi_settings_path()?,
            &pi_models_path()?,
            &pi_auth_path()?,
            &pi_extension_path()?,
            expected_base_url,
        )
    }

    fn apply(
        &self,
        expected_base_url: &str,
        client_token: &str,
        options: Option<&AgentGlobalConfigOptions>,
    ) -> Result<AgentGlobalConfigReport, String> {
        apply_pi(
            &pi_settings_path()?,
            &pi_models_path()?,
            &pi_auth_path()?,
            &pi_extension_path()?,
            expected_base_url,
            client_token,
            options
                .and_then(|options| options.session_extension)
                .unwrap_or(false),
        )
    }

    fn restore(&self, expected_base_url: &str) -> Result<AgentGlobalConfigReport, String> {
        restore_pi(
            &pi_settings_path()?,
            &pi_models_path()?,
            &pi_auth_path()?,
            &pi_extension_path()?,
            expected_base_url,
        )
    }
}

pub(in crate::core::agent_global_config) fn inspect_pi(
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
            primary_long_context: false,
            fast_long_context: false,
            long_context: false,
            backup_available,
            external_environment_overrides: Vec::new(),
            error,
            session_extension,
            model_specs: false,
            approval_bridge: false,
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

pub(in crate::core::agent_global_config) fn apply_pi(
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

pub(in crate::core::agent_global_config) fn restore_pi(
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

// Pi 的用户级配置统一位于 `~/.pi/agent/`：`models.json` 声明自定义 Provider，
// `auth.json`（0600）保存 Provider 凭据，`settings.json` 决定默认 Provider 和模型。
// Pi 会话扩展源码。仅在请求发往 Flowlet 渠道（x-flowlet-client: pi）时注入，
// 避免污染 Pi 到其他 Provider 的请求。注入的 session id 与 Pi 原生会话文件
// 头行的 `id` 一致，供 Flowlet 在本地做会话归属；Flowlet 在转发上游前会将其剥离。
pub(in crate::core::agent_global_config) const PI_SESSION_EXTENSION_SOURCE: &str = r#"// Flowlet 自动写入：为 Pi 请求注入会话标识，使 Flowlet 能按会话归属请求。
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
