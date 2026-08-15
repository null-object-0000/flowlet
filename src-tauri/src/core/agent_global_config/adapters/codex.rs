use super::super::*;
use super::AgentGlobalConfigAdapter;

const CODEX_BACKUP_FILE: &str = "codex-global-config-backup.json";
const CODEX_PROVIDER_ID: &str = "flowlet";
const CODEX_PRIMARY_MODEL: &str = "flowlet-pro";
const CODEX_WIRE_API: &str = "responses";
const CODEX_AUTH_KEY: &str = "OPENAI_API_KEY";
pub(in crate::core::agent_global_config) const CODEX_MODEL_CATALOG_REF: &str =
    "~/.codex/model-catalog.flowlet.json";
pub(in crate::core::agent_global_config) const CODEX_MODEL_CATALOG_FILE: &str =
    "model-catalog.flowlet.json";

pub(super) struct CodexAdapter;

impl AgentGlobalConfigAdapter for CodexAdapter {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn inspect(&self, expected_base_url: &str) -> Result<AgentGlobalConfigReport, String> {
        inspect_codex(
            &codex_config_path(),
            &codex_auth_path(),
            &codex_models_path(),
            expected_base_url,
        )
    }

    fn apply(
        &self,
        expected_base_url: &str,
        client_token: &str,
        _options: Option<&AgentGlobalConfigOptions>,
    ) -> Result<AgentGlobalConfigReport, String> {
        apply_codex(
            &codex_config_path(),
            &codex_auth_path(),
            &codex_models_path(),
            expected_base_url,
            client_token,
        )
    }

    fn restore(&self, expected_base_url: &str) -> Result<AgentGlobalConfigReport, String> {
        restore_codex(
            &codex_config_path(),
            &codex_auth_path(),
            &codex_models_path(),
            expected_base_url,
        )
    }
}

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

pub(in crate::core::agent_global_config) fn codex_backup_path(config_path: &Path) -> PathBuf {
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

pub(in crate::core::agent_global_config) fn inspect_codex(
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
        primary_long_context: false,
        fast_long_context: false,
        long_context: false,
        backup_available,
        external_environment_overrides: Vec::new(),
        error: None,
        session_extension: false,
        model_specs: false,
        approval_bridge: false,
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

    let model =
        codex_top_level_value(&doc, "model").and_then(|value| value.as_str().map(str::to_string));
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
    } else if active_base_url
        .as_deref()
        .is_some_and(|url| !url.trim().is_empty())
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

pub(in crate::core::agent_global_config) fn apply_codex(
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
    let models_content_before = std::fs::read_to_string(models_path).ok();
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
            && existing
                .as_object()
                .is_some_and(|object| object.contains_key("agent_id"))
        {
            let mut upgraded = existing.clone();
            if let Some(object) = upgraded.as_object_mut() {
                object.insert(
                    "models_path".to_string(),
                    Value::String(display_path(models_path)),
                );
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
    auth.as_object_mut().unwrap().insert(
        CODEX_AUTH_KEY.to_string(),
        Value::String(client_token.trim().to_string()),
    );

    // 模型目录内容取内置数据源（仓库根目录 codex-models.json 的编译时快照）。
    let models_bytes = codex_model_catalog::DEFAULT_CODEX_MODELS_JSON
        .as_bytes()
        .to_vec();
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

pub(in crate::core::agent_global_config) fn restore_codex(
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
        let backed_up = backup.top_level.get(*key).cloned().unwrap_or_default();
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
        doc["model_providers"][CODEX_PROVIDER_ID] =
            json_to_toml_item(&backup.flowlet_provider.value);
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
