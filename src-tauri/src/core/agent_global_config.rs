use jsonc_parser::cst::{CstInputValue, CstObject, CstRootNode};
use jsonc_parser::ParseOptions;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use super::agent_environment::display_path;
use super::codex_account::codex_home;
use super::codex_model_catalog;
use super::model_catalog::model_catalog;

pub(crate) mod adapters;

const BACKUP_VERSION: u32 = 1;
const FLOWLET_DIR: &str = ".flowlet";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentGlobalConfigState {
    NotConfigured,
    Flowlet,
    OtherGateway,
    Partial,
    Invalid,
}

/// DeepSeek Harness 受管 MCP 服务器的可见配置（写入 cordis.patch.yml 的
/// dsh-mcp-client 插件实例，见 docs/deepseek-harness-integration.md）。
/// 字段按命名空间与传输分层：stdio 用 command/args/env/cwd，
/// streamable-http 用 url/headers。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerSpec {
    /// Flowlet 内部稳定 id（`[A-Za-z0-9_-]`），同时决定 DSH 插件条目 id `mcp-<id>`。
    pub id: String,
    /// DSH 工具命名空间 `[A-Za-z0-9_-]{1,32}`，公开工具名为 mcp__<serverName>__<rawName>。
    pub server_name: String,
    /// `"stdio"` 或 `"streamable-http"`。
    pub transport: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    /// 额外环境变量。Flowlet 只写入普通字符串值，不生成 DSH 的 `!!js` 运行时注入表达式。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// 额外请求头（如 Authorization）。与 env 一样只写入普通字符串值。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
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
    pub backup_available: bool,
    pub external_environment_overrides: Vec<String>,
    pub error: Option<String>,
    /// Pi / DeepSeek Harness：Flowlet 会话扩展是否在位。
    /// 扩展为 Agent 请求注入 x-flowlet-session 头，使 Flowlet 能按会话归并请求。
    #[serde(default)]
    pub session_extension: bool,
    /// 仅 DeepSeek Harness：从各 base Profile 受管块回读的 MCP 服务器列表
    /// （按 id 合并，首个出现的 Profile 优先）。
    #[serde(default)]
    pub mcp_servers: Vec<McpServerSpec>,
    /// 仅 OpenCode：Flowlet 权限事件插件是否在位。插件用于发现 Desktop 动态端口实例。
    #[serde(default)]
    pub opencode_permission_bridge: bool,
}

/// Agent 全局配置一键写入的可选参数；某 Agent 不支持的选项会被忽略。
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGlobalConfigOptions {
    /// Pi / DeepSeek Harness / Hermes：是否安装可选会话扩展。安装后可为发往 Flowlet
    /// 渠道的请求注入 x-flowlet-session，使 Flowlet 能按会话归并请求。Adapter 在未传
    /// 选项时默认不安装（不改变已有扩展文件）。
    #[serde(default)]
    pub session_extension: Option<bool>,
    /// 用户在接入抽屉中显式选择的主模型（规范模型 ID）。所有 Agent 都使用该值；
    /// 未传时由 `apply_agent_global_config` command 按当前可用模型注入。
    #[serde(default)]
    pub primary_model: Option<String>,
    /// 快速模型：仅 Claude Code 的主/快速模型组与 OpenCode 的 `small_model` 使用。
    /// 缺省时回退到 `primary_model`（不再存在「快速模型必须是另一个模型」的语义）。
    #[serde(default)]
    pub fast_model: Option<String>,
    /// 仅 DeepSeek Harness：受管 MCP 服务器列表。`Some(非空)` 把列表整块写入
    /// 每个 base Profile 的 cordis.patch.yml；`Some(空)` 移除全部受管 MCP 块；
    /// `None` 表示不触碰 MCP 配置（兼容旧前端）。
    #[serde(default)]
    pub mcp_servers: Option<Vec<McpServerSpec>>,
}

/// 把用户传入的模型名归一为 `model-catalog.json` 中的规范模型 ID。
///
/// 允许别名、厂商前缀写法和大小写变体（与入站路由使用同一份目录归一规则），
/// 但目录里未登记的名字一律拒绝——聚合模型移除后不再有任何「任意模型名都会被
/// 接受」的兜底路径。
pub(crate) fn canonical_known_model(model: &str) -> Result<String, String> {
    model_catalog()
        .find(model)
        .map(|identity| identity.id.clone())
        .ok_or_else(|| format!("模型 {model} 不在 Flowlet 模型目录中，无法写入 Agent 配置"))
}

/// 模型是否在 `model-catalog.json` 中登记。
///
/// inspect 用它识别「历史聚合模型配置」：`flowlet-pro` / `flowlet-flash` 已从目录移除，
/// 这类旧配置即使结构完整也必须提示用户重新一键接入（Partial），不能报成已接入。
pub(crate) fn is_known_catalog_model(model: &str) -> bool {
    model_catalog().find(model).is_some()
}

/// 解析本次写入使用的（主模型，快速模型）。
///
/// `primaryModel` 必须提供，否则拒绝写入；正常调用链由 `apply_agent_global_config`
/// command 按当前可用模型补齐。`fastModel` 缺省时回退到主模型。
pub(crate) fn resolve_model_choices(
    options: Option<&AgentGlobalConfigOptions>,
) -> Result<(String, String), String> {
    let primary = options
        .and_then(|options| options.primary_model.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "未指定默认模型：请先在接入抽屉中选择一个已开放的模型".to_string())?;
    let primary = canonical_known_model(primary)?;
    let fast = options
        .and_then(|options| options.fast_model.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(canonical_known_model)
        .transpose()?
        .unwrap_or_else(|| primary.clone());
    Ok((primary, fast))
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct BackedUpValue {
    present: bool,
    value: Value,
}

fn config_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub fn inspect_agent_global_config(
    adapter_id: &str,
    expected_base_url: &str,
) -> Result<AgentGlobalConfigReport, String> {
    let _guard = config_lock()
        .lock()
        .map_err(|_| "Agent 全局配置锁已损坏".to_string())?;
    adapters::adapter(adapter_id)?.inspect(expected_base_url)
}

pub fn apply_agent_global_config(
    adapter_id: &str,
    expected_base_url: &str,
    client_token: &str,
    options: Option<&AgentGlobalConfigOptions>,
) -> Result<AgentGlobalConfigReport, String> {
    let _guard = config_lock()
        .lock()
        .map_err(|_| "Agent 全局配置锁已损坏".to_string())?;
    adapters::adapter(adapter_id)?.apply(expected_base_url, client_token, options)
}

pub fn restore_agent_global_config(
    adapter_id: &str,
    expected_base_url: &str,
) -> Result<AgentGlobalConfigReport, String> {
    let _guard = config_lock()
        .lock()
        .map_err(|_| "Agent 全局配置锁已损坏".to_string())?;
    adapters::adapter(adapter_id)?.restore(expected_base_url)
}

pub(crate) fn has_global_config_adapter(adapter_id: &str) -> bool {
    adapters::has_adapter(adapter_id)
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
#[path = "agent_global_config/tests.rs"]
mod tests;
