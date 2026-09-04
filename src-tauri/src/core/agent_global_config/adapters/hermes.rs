use super::super::*;
use super::deepseek_harness::{patch_yaml_entry, read_yaml_text, read_yaml_value, yaml_at};
use super::AgentGlobalConfigAdapter;

const HERMES_BACKUP_FILE: &str = "hermes-global-config-backup.json";
const HERMES_PROVIDER: &str = "custom";
const HERMES_PRIMARY_MODEL: &str = "flowlet-pro";
const HERMES_CLIENT_MARKER: &str = "hermes";
const HERMES_CLIENT_HEADER: &str = "x-flowlet-client";
/// 受管会话桥插件名（`~/.hermes/plugins/<name>/`，同时是 `plugins.enabled` 的条目）。
const HERMES_SESSION_BRIDGE_NAME: &str = "flowlet-session-bridge";
const HERMES_SESSION_BRIDGE_MANIFEST: &str =
    include_str!("../../../../resources/agent-plugins/hermes/plugin.yaml");
const HERMES_SESSION_BRIDGE_SOURCE: &str =
    include_str!("../../../../resources/agent-plugins/hermes/__init__.py");

pub(super) struct HermesAdapter;

impl AgentGlobalConfigAdapter for HermesAdapter {
    fn id(&self) -> &'static str {
        "hermes"
    }

    fn inspect(&self, expected_base_url: &str) -> Result<AgentGlobalConfigReport, String> {
        inspect_hermes(
            &hermes_config_path()?,
            &hermes_env_path()?,
            expected_base_url,
        )
    }

    fn apply(
        &self,
        expected_base_url: &str,
        client_token: &str,
        options: Option<&AgentGlobalConfigOptions>,
    ) -> Result<AgentGlobalConfigReport, String> {
        apply_hermes(
            &hermes_config_path()?,
            &hermes_env_path()?,
            expected_base_url,
            client_token,
            resolve_primary_model(options),
            options.and_then(|options| options.session_extension),
        )
    }

    fn restore(&self, expected_base_url: &str) -> Result<AgentGlobalConfigReport, String> {
        restore_hermes(
            &hermes_config_path()?,
            &hermes_env_path()?,
            expected_base_url,
        )
    }
}

/// Hermes Agent 支持用户选择默认模型：仅接受 Flowlet 两个聚合模型
/// `flowlet-pro` / `flowlet-flash`，其余值回退到默认主模型。
pub(in crate::core::agent_global_config) fn resolve_primary_model(
    options: Option<&AgentGlobalConfigOptions>,
) -> String {
    options
        .and_then(|options| options.primary_model.as_deref())
        .map(str::trim)
        .filter(|model| matches!(*model, HERMES_PRIMARY_MODEL | "flowlet-flash"))
        .unwrap_or(HERMES_PRIMARY_MODEL)
        .to_string()
}

// Hermes Agent（Nous Research）的全局配置位于 `~/.hermes/config.yaml`，`model:` 段
// 以 `provider: "custom"` + `base_url` + `default` 描述 OpenAI 兼容端点。官方
// “Custom endpoint” 流程不把 API Key 内联进 config.yaml，而是写入
// `api_key: ${HERMES_CUSTOM_<host:port>_API_KEY}` 引用，实际密钥落到 `~/.hermes/.env`
// 的同名变量（`custom_endpoint_key_env`，见 hermes_cli/config.py）。Flowlet 沿用该
// 约定：密钥只进 `.env`，config.yaml 里只留 `${…}` 引用。`model.default_headers`
// 是发往该端点的静态请求头，Flowlet 用它注入 `x-flowlet-client: hermes`，使请求
// 经过本地代理后能被识别为 Hermes 客户端（Hermes 复用 OpenAI Python SDK 的通用 UA，
// 无法靠 UA 子串区分）。这些都属于标准 Provider 配置，不涉及运行时注入。

#[derive(Clone, Debug, Serialize, Deserialize)]
struct HermesConfigBackup {
    version: u32,
    agent_id: String,
    created_at: String,
    config_path: String,
    env_path: String,
    config_existed: bool,
    env_existed: bool,
    /// 接入前整个顶层 `model` 值（可能是空串哨兵、完整映射或缺失），恢复时整键还原。
    model: BackedUpValue,
    /// 接入前 `.env` 中受管变量名（随 base_url 的 host:port 派生）。
    env_key: String,
    /// 接入前该变量的值；present=false 表示原本不存在该变量。
    env_value: BackedUpValue,
    /// 接入前整个顶层 `plugins` 值（可能是完整映射、缺失），恢复时整键还原，
    /// 与 `model` 的处理方式一致，确保 Flowlet 写入的 `plugins.enabled` 能被完整移除。
    #[serde(default)]
    plugins: BackedUpValue,
    /// 接入前受管会话桥插件文件内容（文件名 → 原文或 None=原本不存在）。
    /// 恢复时据此还原用户接入前的插件状态。
    #[serde(default)]
    bridge_files: BTreeMap<String, Option<String>>,
    /// 接入前插件目录是否为空目录（接入前无文件时，恢复后尝试清理空目录）。
    #[serde(default)]
    bridge_dir_existed: bool,
}

fn hermes_home() -> Result<PathBuf, String> {
    std::env::var_os("HERMES_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".hermes")))
        .ok_or_else(|| "无法确定 Hermes Agent 配置目录".to_string())
}

fn hermes_config_path() -> Result<PathBuf, String> {
    Ok(hermes_home()?.join("config.yaml"))
}

fn hermes_env_path() -> Result<PathBuf, String> {
    Ok(hermes_home()?.join(".env"))
}

fn hermes_backup_path(config_path: &Path) -> PathBuf {
    config_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(FLOWLET_DIR)
        .join(HERMES_BACKUP_FILE)
}

/// 受管会话桥插件的安装目录 `~/.hermes/plugins/flowlet-session-bridge/`。
/// 由 config.yaml 所在目录（HERMES_HOME）推导，保证与显式传入的配置路径一致。
fn hermes_session_bridge_dir(config_path: &Path) -> PathBuf {
    config_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("plugins")
        .join(HERMES_SESSION_BRIDGE_NAME)
}

/// 读取 config.yaml 中 `plugins.enabled` 列表（缺失视为空）。
fn read_plugins_enabled(root: &serde_yaml::Value) -> Vec<String> {
    yaml_at(root, &["plugins", "enabled"])
        .and_then(serde_yaml::Value::as_sequence)
        .map(|sequence| {
            sequence
                .iter()
                .filter_map(serde_yaml::Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 把 `plugins.enabled` 列表写回 config.yaml 文本。
fn patch_plugins_enabled(text: &str, enabled: &[String]) -> Result<Vec<u8>, String> {
    let value = serde_json::to_value(enabled).map_err(|error| error.to_string())?;
    patch_yaml_entry(text, "config.yaml", &["plugins"], "enabled", Some(&value))
}

/// 会话桥是否在位：插件目录两个受管文件都存在，且 `plugins.enabled` 包含该插件。
fn session_bridge_installed(config_path: &Path) -> bool {
    let dir = hermes_session_bridge_dir(config_path);
    if !dir.join("plugin.yaml").is_file() || !dir.join("__init__.py").is_file() {
        return false;
    }
    let Ok(root) = read_yaml_value(config_path) else {
        return false;
    };
    read_plugins_enabled(&root)
        .iter()
        .any(|name| name == HERMES_SESSION_BRIDGE_NAME)
}


/// 从本地代理 base_url（如 `http://127.0.0.1:18640/v1`）提取 Hermes 自定义端点
/// 身份 `host:port`（`127.0.0.1:18640`），与官方 CLI setup 流程一致。
fn hermes_host_port(base_url: &str) -> String {
    let without_scheme = base_url
        .trim()
        .strip_prefix("http://")
        .or_else(|| base_url.trim().strip_prefix("https://"))
        .unwrap_or_else(|| base_url.trim());
    without_scheme
        .split('/')
        .next()
        .unwrap_or(without_scheme)
        .trim()
        .to_string()
}

/// 复刻 Hermes `custom_endpoint_key_env(identity)`：把 `host:port` 归一为
/// `[A-Z0-9]+`（其余字符折叠为单个 `_`、去首尾 `_`），生成
/// `HERMES_CUSTOM_<slug>_API_KEY`。与官方实现保持一致，确保 Flowlet 写入的变量名
/// 能被 Hermes 识别、也能在恢复时精确定位同一变量。
pub(in crate::core::agent_global_config) fn hermes_custom_key_env(identity: &str) -> String {
    let mut slug = String::new();
    let mut previous_separator = false;
    for character in identity.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_uppercase());
            previous_separator = false;
        } else if !previous_separator {
            slug.push('_');
            previous_separator = true;
        }
    }
    let slug = slug.trim_matches('_');
    if slug.is_empty() {
        "HERMES_CUSTOM_API_KEY".to_string()
    } else {
        format!("HERMES_CUSTOM_{slug}_API_KEY")
    }
}

/// 判定某行是否为顶层（无缩进）`key:` 键。
fn is_top_level_key(line: &str, key: &str) -> bool {
    if line.starts_with([' ', '\t']) {
        return false;
    }
    let Some(rest) = line.strip_prefix(key) else {
        return false;
    };
    let rest = rest.trim_start();
    rest == ":" || rest.starts_with(": ")
}

/// 移除顶层 `key:` 块（含其后所有更深缩进/空行/注释的子行），保留文件中其余内容。
/// 用于：apply 前替换接入前的 model（空串哨兵或映射）、restore 前移除 Flowlet 写的
/// 受管块，随后再整块写回备份值。
fn strip_top_level_block(text: &str, key: &str) -> String {
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let lines: Vec<&str> = text.lines().collect();
    let mut output = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        if is_top_level_key(lines[index], key) {
            index += 1;
            while index < lines.len() {
                let line = lines[index];
                let trimmed = line.trim_start();
                if trimmed.is_empty() || trimmed.starts_with('#') || line.len() > trimmed.len() {
                    index += 1;
                } else {
                    break;
                }
            }
            continue;
        }
        output.push(lines[index]);
        index += 1;
    }
    output.join(newline)
}

fn strip_top_level_model_block(text: &str) -> String {
    strip_top_level_block(text, "model")
}

fn strip_top_level_plugins_block(text: &str) -> String {
    strip_top_level_block(text, "plugins")
}

/// Hermes 全新安装时 `config.yaml` 的 `model:` 可能是空串哨兵（`model: ""`，表示
/// “尚未配置”）。行级 patch 要求父键是映射，因此先把标量/空映射的顶层 `model:` 行剥离，
/// 后续 `patch_yaml_entry` 再以映射形式整体插入。已是非空映射时保持不变。
fn strip_model_sentinel(text: &str) -> String {
    let parsed = match serde_yaml::from_str::<serde_yaml::Value>(text) {
        Ok(value) => value,
        Err(_) => return text.to_string(),
    };
    let model_needs_strip = parsed
        .get("model")
        .is_some_and(|value| value.as_mapping().map_or(true, |mapping| mapping.is_empty()));
    if !model_needs_strip {
        return text.to_string();
    }
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    text.lines()
        .filter(|line| !is_top_level_key(line, "model"))
        .collect::<Vec<_>>()
        .join(newline)
}

fn hermes_model_value(root: &serde_yaml::Value) -> Option<String> {
    yaml_at(root, &["model", "default"])
        .or_else(|| yaml_at(root, &["model", "model"]))
        .and_then(serde_yaml::Value::as_str)
        .map(str::to_string)
}

/// 读取 `.env` 中某个 `KEY=value` 变量的值（不存在或为空返回 None）。
fn read_env_value(text: &str, key: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let trimmed = line.trim();
        trimmed
            .strip_prefix(&format!("{key}="))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

/// 在 `.env` 文本中写入/移除某个 `KEY=value` 变量，保留其它内容与注释。
/// `value = None` 表示删除该变量行；`Some(v)` 表示替换或追加。
fn patch_env_value(text: &str, key: &str, value: Option<&str>) -> String {
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = Vec::new();
    let mut replaced = false;
    for line in text.lines() {
        if line.trim().starts_with(&format!("{key}=")) {
            replaced = true;
            if let Some(value) = value {
                lines.push(format!("{key}={value}"));
            }
            continue;
        }
        lines.push(line.to_string());
    }
    if !replaced {
        if let Some(value) = value {
            if !lines.is_empty() && !lines.last().is_some_and(|line| line.is_empty()) {
                lines.push(String::new());
            }
            lines.push(format!("{key}={value}"));
        }
    }
    lines.join(newline)
}

pub(in crate::core::agent_global_config) fn inspect_hermes(
    config_path: &Path,
    env_path: &Path,
    expected_base_url: &str,
) -> Result<AgentGlobalConfigReport, String> {
    let backup_available = hermes_backup_path(config_path).is_file();
    let settings_exists = config_path.is_file();
    let env_key = hermes_custom_key_env(&hermes_host_port(expected_base_url));
    let bridge_installed = session_bridge_installed(config_path);
    let report = |state: AgentGlobalConfigState,
                  base_url: Option<String>,
                  api_key_configured: bool,
                  primary_model: Option<String>,
                  error: Option<String>| AgentGlobalConfigReport {
        agent_id: "hermes".to_string(),
        settings_path: display_path(config_path),
        credentials_path: Some(display_path(env_path)),
        settings_exists,
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
        session_extension: bridge_installed,
        model_specs: false,
        model_input_modalities: BTreeMap::new(),
        approval_bridge: false,
        mcp_servers: Vec::new(),
        opencode_permission_bridge: false,
    };

    if !settings_exists {
        return Ok(report(
            AgentGlobalConfigState::NotConfigured,
            None,
            false,
            None,
            None,
        ));
    }
    let root = match read_yaml_value(config_path) {
        Ok(root) => root,
        Err(error) => {
            return Ok(report(
                AgentGlobalConfigState::Invalid,
                None,
                false,
                None,
                Some(error),
            ))
        }
    };
    let provider = yaml_at(&root, &["model", "provider"]).and_then(serde_yaml::Value::as_str);
    let base_url = yaml_at(&root, &["model", "base_url"])
        .and_then(serde_yaml::Value::as_str)
        .map(str::to_string);
    let api_key = yaml_at(&root, &["model", "api_key"])
        .and_then(serde_yaml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let client_header = yaml_at(&root, &["model", "default_headers", HERMES_CLIENT_HEADER])
        .and_then(serde_yaml::Value::as_str);
    let primary_model = hermes_model_value(&root);
    // 官方约定：config.yaml 里的 api_key 是 `${HERMES_CUSTOM_<host>_API_KEY}` 引用，
    // 实际密钥在 .env；同时兼容旧版内联密钥的展示。
    let api_key_is_env_ref = api_key.as_deref() == Some(format!("${{{env_key}}}").as_str());
    let env_token = std::fs::read_to_string(env_path)
        .ok()
        .and_then(|text| read_env_value(&text, &env_key));
    let api_key_configured = env_token.is_some() || api_key.is_some();

    let expected_base_url = normalize_url(expected_base_url);
    let base_url_matches =
        base_url.as_deref().map(normalize_url).as_deref() == Some(expected_base_url.as_str());
    let state = if provider == Some(HERMES_PROVIDER)
        && primary_model
            .as_deref()
            .is_some_and(|model| matches!(model, HERMES_PRIMARY_MODEL | "flowlet-flash"))
        && base_url_matches
        && api_key_is_env_ref
        && env_token.is_some()
        && client_header == Some(HERMES_CLIENT_MARKER)
    {
        AgentGlobalConfigState::Flowlet
    } else if base_url
        .as_deref()
        .is_some_and(|value| normalize_url(value) != expected_base_url)
    {
        AgentGlobalConfigState::OtherGateway
    } else if client_header == Some(HERMES_CLIENT_MARKER)
        || primary_model
            .as_deref()
            .is_some_and(|model| model.starts_with("flowlet"))
        || provider == Some(HERMES_PROVIDER)
        || api_key_is_env_ref
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

pub(in crate::core::agent_global_config) fn apply_hermes(
    config_path: &Path,
    env_path: &Path,
    expected_base_url: &str,
    client_token: &str,
    primary_model: String,
    session_extension: Option<bool>,
) -> Result<AgentGlobalConfigReport, String> {
    if client_token.trim().is_empty() {
        return Err("Flowlet 默认 Client Token 未配置，无法写入 Hermes Agent".to_string());
    }
    let env_key = hermes_custom_key_env(&hermes_host_port(expected_base_url));
    let config_existed = config_path.is_file();
    let env_existed = env_path.is_file();
    let original_text = read_yaml_text(config_path)?;
    let original_root = read_yaml_value(config_path)?;
    let original_env_text = if env_existed {
        std::fs::read_to_string(env_path)
            .map_err(|error| format!("读取 {} 失败：{error}", env_path.display()))?
    } else {
        String::new()
    };
    let bridge_dir = hermes_session_bridge_dir(config_path);

    let backup = hermes_backup_path(config_path);
    let backup_created = !backup.is_file();
    if backup_created {
        let snapshot = HermesConfigBackup {
            version: BACKUP_VERSION,
            agent_id: "hermes".to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            config_path: display_path(config_path),
            env_path: display_path(env_path),
            config_existed,
            env_existed,
            model: backed_up_yaml(&original_root, &["model"]),
            env_key: env_key.clone(),
            env_value: match read_env_value(&original_env_text, &env_key) {
                Some(value) => BackedUpValue {
                    present: true,
                    value: Value::String(value),
                },
                None => BackedUpValue {
                    present: false,
                    value: Value::Null,
                },
            },
            plugins: backed_up_yaml(&original_root, &["plugins"]),
            bridge_files: snapshot_bridge_files(&bridge_dir),
            bridge_dir_existed: bridge_dir.is_dir(),
        };
        write_json_file(
            &backup,
            &serde_json::to_value(snapshot).map_err(|error| error.to_string())?,
        )?;
    }

    // 逐键写入受管子键，保留用户在 model 段内的其它设置（streaming / context_length 等）。
    let mut text = strip_model_sentinel(&original_text);
    for (parents, key, value) in [
        (
            vec!["model"],
            "provider",
            Some(Value::String(HERMES_PROVIDER.to_string())),
        ),
        (
            vec!["model"],
            "default",
            Some(Value::String(primary_model.clone())),
        ),
        (
            vec!["model"],
            "base_url",
            Some(Value::String(normalize_url(expected_base_url))),
        ),
        (
            vec!["model"],
            "api_key",
            Some(Value::String(format!("${{{env_key}}}"))),
        ),
        (
            vec!["model", "default_headers"],
            HERMES_CLIENT_HEADER,
            Some(Value::String(HERMES_CLIENT_MARKER.to_string())),
        ),
    ] {
        text = String::from_utf8(patch_yaml_entry(
            &text,
            "config.yaml",
            &parents,
            key,
            value.as_ref(),
        )?)
        .map_err(|error| format!("生成 Hermes config.yaml 失败：{error}"))?;
    }
    // 会话桥：启用时把受管插件加入 `plugins.enabled`；关闭时移除；选项缺失不动。
    if session_extension.is_some() {
        let enabled = read_plugins_enabled(&original_root);
        let enabled = match session_extension {
            Some(true) if !enabled.iter().any(|name| name == HERMES_SESSION_BRIDGE_NAME) => {
                let mut next = enabled;
                next.push(HERMES_SESSION_BRIDGE_NAME.to_string());
                next
            }
            Some(false) => enabled
                .into_iter()
                .filter(|name| name != HERMES_SESSION_BRIDGE_NAME)
                .collect::<Vec<_>>(),
            _ => enabled,
        };
        text = String::from_utf8(patch_plugins_enabled(&text, &enabled)?)
            .map_err(|error| format!("生成 Hermes config.yaml 失败：{error}"))?;
    }
    let env_text = patch_env_value(&original_env_text, &env_key, Some(client_token.trim()));

    let content = text_file_bytes(&text);
    let env_content = (!env_text.trim().is_empty()).then(|| text_file_bytes(&env_text));
    let mut writes = vec![
        (config_path.to_path_buf(), Some(content)),
        (env_path.to_path_buf(), env_content),
    ];
    // 会话桥插件文件：启用写受管版本；关闭时删除与受管版本一致的文件；选项缺失不动。
    match session_extension {
        Some(true) => {
            writes.push((bridge_dir.join("plugin.yaml"), Some(text_file_bytes(HERMES_SESSION_BRIDGE_MANIFEST))));
            writes.push((bridge_dir.join("__init__.py"), Some(text_file_bytes(HERMES_SESSION_BRIDGE_SOURCE))));
        }
        Some(false) => {
            if managed_text_file_matches(&bridge_dir.join("plugin.yaml"), HERMES_SESSION_BRIDGE_MANIFEST) {
                writes.push((bridge_dir.join("plugin.yaml"), None));
            }
            if managed_text_file_matches(&bridge_dir.join("__init__.py"), HERMES_SESSION_BRIDGE_SOURCE) {
                writes.push((bridge_dir.join("__init__.py"), None));
            }
        }
        None => {}
    }
    write_files_transactionally("Hermes config.yaml、.env 与会话桥插件", &writes)
        .map_err(|failure| {
            if backup_created && failure.rolled_back {
                let _ = std::fs::remove_file(&backup);
            }
            failure.message
        })?;
    inspect_hermes(config_path, env_path, expected_base_url)
}

/// 记录接入前受管会话桥插件目录中两个文件的原文（文件名 → 内容或 None=原本不存在）。
fn snapshot_bridge_files(dir: &Path) -> BTreeMap<String, Option<String>> {
    ["plugin.yaml", "__init__.py"]
        .into_iter()
        .map(|name| {
            let content = std::fs::read_to_string(dir.join(name)).ok();
            (name.to_string(), content)
        })
        .collect()
}

pub(in crate::core::agent_global_config) fn restore_hermes(
    config_path: &Path,
    env_path: &Path,
    expected_base_url: &str,
) -> Result<AgentGlobalConfigReport, String> {
    let backup_path = hermes_backup_path(config_path);
    if !backup_path.is_file() {
        return Err("没有可恢复的 Hermes Agent 全局配置备份".to_string());
    }
    let backup: HermesConfigBackup = serde_json::from_value(read_settings(&backup_path)?)
        .map_err(|error| format!("备份格式无效：{error}"))?;
    if backup.version != BACKUP_VERSION || backup.agent_id != "hermes" {
        return Err("Hermes Agent 全局配置备份版本不受支持".to_string());
    }
    if !paths_equal(&PathBuf::from(&backup.config_path), config_path)
        || !paths_equal(&PathBuf::from(&backup.env_path), env_path)
    {
        return Err("Hermes Agent 配置备份路径与当前用户配置不一致".to_string());
    }

    // 整块移除 Flowlet 写的 model，再按备份写回接入前的 model（或缺失时保持移除）。
    let mut text = strip_top_level_model_block(&read_yaml_text(config_path)?);
    let model_value = backup.model.present.then_some(&backup.model.value);
    text = String::from_utf8(patch_yaml_entry(
        &text,
        "config.yaml",
        &[],
        "model",
        model_value,
    )?)
    .map_err(|error| format!("恢复 Hermes config.yaml 失败：{error}"))?;

    // 还原 `plugins` 块：整块移除 Flowlet 写入的受管 plugins，再写回接入前的值
    // （或原本缺失时保持移除），避免残留空的 `plugins:`。
    text = strip_top_level_plugins_block(&text);
    let plugins_value = backup.plugins.present.then_some(&backup.plugins.value);
    text = String::from_utf8(patch_yaml_entry(
        &text,
        "config.yaml",
        &[],
        "plugins",
        plugins_value,
    )?)
    .map_err(|error| format!("恢复 Hermes config.yaml 失败：{error}"))?;

    // 还原 .env 中的受管变量：接入前存在则写回原值，否则删除 Flowlet 写入的变量。
    let env_text = std::fs::read_to_string(env_path).unwrap_or_default();
    let env_value = backup
        .env_value
        .present
        .then(|| backup.env_value.value.as_str().map(str::to_string))
        .flatten();
    let env_text = patch_env_value(&env_text, &backup.env_key, env_value.as_deref());

    // 还原受管会话桥插件文件：接入前存在则写回原文，否则删除 Flowlet 写入的文件。
    let bridge_dir = hermes_session_bridge_dir(config_path);
    let mut writes = Vec::new();
    for name in ["plugin.yaml", "__init__.py"] {
        let content = backup.bridge_files.get(name).and_then(Option::as_deref);
        writes.push((bridge_dir.join(name), content.map(text_file_bytes)));
    }

    let restored_empty = text.trim().is_empty()
        || serde_yaml::from_str::<serde_yaml::Value>(&text)
            .map(|value| {
                value
                    .as_mapping()
                    .is_some_and(|mapping| mapping.is_empty())
            })
            .unwrap_or(false);
    let content = if !backup.config_existed && restored_empty {
        None
    } else {
        Some(text_file_bytes(&text))
    };
    let env_content = if !backup.env_existed && env_text.trim().is_empty() {
        None
    } else {
        Some(text_file_bytes(&env_text))
    };
    writes.insert(0, (config_path.to_path_buf(), content));
    writes.insert(1, (env_path.to_path_buf(), env_content));
    write_files_transactionally("Hermes config.yaml、.env 与会话桥插件", &writes)
        .map_err(|failure| failure.message)?;
    // 接入前插件目录不存在且已清空时，顺手删除空目录。
    if !backup.bridge_dir_existed && bridge_dir.is_dir() && bridge_dir.read_dir().map(|mut entries| entries.next().is_none()).unwrap_or(false) {
        let _ = std::fs::remove_dir(&bridge_dir);
    }
    std::fs::remove_file(&backup_path)
        .map_err(|error| format!("配置已恢复，但清理 Flowlet 备份标记失败：{error}"))?;
    inspect_hermes(config_path, env_path, expected_base_url)
}

/// 用 Flowlet 的 JSON 备份结构表示 YAML 中的一个可空值。
fn backed_up_yaml(root: &serde_yaml::Value, path: &[&str]) -> BackedUpValue {
    match yaml_at(root, path) {
        Some(value) => BackedUpValue {
            present: true,
            value: serde_json::to_value(value).unwrap_or(Value::Null),
        },
        None => BackedUpValue {
            present: false,
            value: Value::Null,
        },
    }
}
