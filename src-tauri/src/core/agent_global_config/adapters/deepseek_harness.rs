use super::super::*;
use super::AgentGlobalConfigAdapter;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::OpenOptions;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

const PROVIDER_ID: &str = "flowlet";
const TOKEN_REF: &str = "FLOWLET_CLIENT_TOKEN";
const CREDENTIAL_REFS: &str = "refs";
const LLM_NAMESPACE: &str = "llm-pi-ai";
const DEFAULT_MODEL_NAMESPACE: &str = "agent-default-model";
const LOCK_TIMEOUT: Duration = Duration::from_secs(2);
const SESSION_BRIDGE_SOURCE: &str =
    include_str!("../../../../resources/agent-plugins/deepseek-harness/flowlet-session-bridge.mjs");
const SESSION_BRIDGE_DIR: &str = ".flowlet";
const SESSION_BRIDGE_FILE: &str = "flowlet-session-bridge.mjs";
const SESSION_BRIDGE_START: &str = "# flowlet-managed:start deepseek-harness-session-bridge";
const SESSION_BRIDGE_END: &str = "# flowlet-managed:end deepseek-harness-session-bridge";

const APPROVAL_BRIDGE_SOURCE: &str =
    include_str!("../../../../resources/agent-plugins/deepseek-harness/flowlet-approval-bridge.mjs");
const APPROVAL_BRIDGE_FILE: &str = "flowlet-approval-bridge.mjs";
const APPROVAL_BRIDGE_START: &str = "# flowlet-managed:start deepseek-harness-approval-bridge";
const APPROVAL_BRIDGE_END: &str = "# flowlet-managed:end deepseek-harness-approval-bridge";

/// MCP 服务器受管块：块内每个服务器是一个 `- insert:` 的 dsh-mcp-client 插件实例。
/// 增删改都整块重写（patch_mcp_servers），restore/关闭时整块移除。
const MCP_SERVERS_START: &str = "# flowlet-managed:start deepseek-harness-mcp-servers";
const MCP_SERVERS_END: &str = "# flowlet-managed:end deepseek-harness-mcp-servers";
/// DSH 官方 MCP 桥接插件包名（profile 内可从 node_modules 解析）。
const MCP_CLIENT_PACKAGE: &str = "@deepseek-ai/dsh-mcp-client";
const MCP_MAX_SERVER_NAME: usize = 32;

pub(super) struct DeepSeekHarnessAdapter;

impl AgentGlobalConfigAdapter for DeepSeekHarnessAdapter {
    fn id(&self) -> &'static str {
        "deepseek-harness"
    }

    fn inspect(&self, expected_base_url: &str) -> Result<AgentGlobalConfigReport, String> {
        inspect_dsh(expected_base_url)
    }

    fn apply(
        &self,
        expected_base_url: &str,
        client_token: &str,
        options: Option<&AgentGlobalConfigOptions>,
    ) -> Result<AgentGlobalConfigReport, String> {
        apply_dsh(
            expected_base_url,
            client_token,
            options
                .and_then(|options| options.session_extension)
                .unwrap_or(false),
            options
                .and_then(|options| options.model_specs)
                .unwrap_or(false),
            options.and_then(|options| options.model_input_modalities.as_ref()),
            options
                .and_then(|options| options.approval_bridge)
                .unwrap_or(false),
            options.and_then(|options| options.mcp_servers.as_deref()),
        )
    }

    fn restore(&self, expected_base_url: &str) -> Result<AgentGlobalConfigReport, String> {
        restore_dsh(expected_base_url)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct DshConfigBackup {
    version: u32,
    agent_id: String,
    provider: BackedUpValue,
    default_provider: BackedUpValue,
    default_model: BackedUpValue,
    credential: BackedUpValue,
    #[serde(default)]
    profiles: Vec<DshProfileBackup>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct DshProfileBackup {
    profile: String,
    patch: BackedUpText,
    plugin: BackedUpText,
    /// 接入前受管 approval bridge 插件文件的原文。None 表示旧版备份未记录该
    /// 字段（apply 时会按当前文件补录，保证恢复能还原到 Flowlet 触碰前的状态）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    approval_plugin: Option<BackedUpText>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct BackedUpText {
    present: bool,
    content: String,
}

#[derive(Clone, Debug)]
struct ManagedSnapshot {
    provider: BackedUpValue,
    default_provider: BackedUpValue,
    default_model: BackedUpValue,
    credential: BackedUpValue,
}

/// DSH 公开的写者协议：独占创建 `<file>.lock`，指数退避最多两秒。
/// 与 DSH 自身使用同一协议，避免 Flowlet 与运行中的 Web 发生读改写竞争。
struct DshFileLock {
    path: PathBuf,
}

impl DshFileLock {
    fn acquire(target: &Path) -> Result<Self, String> {
        let parent = target
            .parent()
            .ok_or_else(|| format!("配置路径没有父目录：{}", target.display()))?;
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建 DSH 配置目录 {} 失败：{error}", parent.display()))?;
        let path = PathBuf::from(format!("{}.lock", target.display()));
        let deadline = Instant::now() + LOCK_TIMEOUT;
        let mut delay = Duration::from_millis(20);
        loop {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    if let Err(error) = writeln!(file, "{}", std::process::id()) {
                        drop(file);
                        let _ = std::fs::remove_file(&path);
                        return Err(format!("写入 DSH 配置锁 {} 失败：{error}", path.display()));
                    }
                    return Ok(Self { path });
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                    if Instant::now() >= deadline {
                        return Err(format!(
                            "等待 DSH 配置锁超时：{}。请稍后重试；Flowlet 不会删除其他进程的锁。",
                            path.display()
                        ));
                    }
                    thread::sleep(delay);
                    delay = (delay * 2).min(Duration::from_millis(200));
                }
                Err(error) => {
                    return Err(format!("创建 DSH 配置锁 {} 失败：{error}", path.display()))
                }
            }
        }
    }
}

impl Drop for DshFileLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn dsh_home() -> Result<PathBuf, String> {
    std::env::var_os("DSH_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".dsh")))
        .ok_or_else(|| "无法确定 DeepSeek Harness 配置目录".to_string())
}

fn backup_path(home: &Path) -> PathBuf {
    home.join(FLOWLET_DIR)
        .join("deepseek-harness-global-config-backup.json")
}

fn dsh_profiles(home: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let root = home.join("profiles");
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut profiles = std::fs::read_dir(&root)
        .map_err(|error| format!("读取 DSH Profile 目录 {} 失败：{error}", root.display()))?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_type()
                .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
                && profile_uses_base_bundle(&entry.path())
        })
        .filter_map(|entry| {
            entry
                .file_name()
                .to_str()
                .map(|name| (name.to_string(), entry.path()))
        })
        .collect::<Vec<_>>();
    profiles.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(profiles)
}

fn profile_uses_base_bundle(root: &Path) -> bool {
    std::fs::read_to_string(root.join("package.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| {
            value
                .pointer("/dsh/profile/bundles")
                .and_then(Value::as_array)
                .cloned()
        })
        .is_some_and(|bundles| {
            bundles
                .iter()
                .any(|bundle| bundle.as_str() == Some("@deepseek-ai/dsh-base"))
        })
}

fn backed_up_text(path: &Path) -> Result<BackedUpText, String> {
    if !path.is_file() {
        return Ok(BackedUpText::default());
    }
    Ok(BackedUpText {
        present: true,
        content: std::fs::read_to_string(path)
            .map_err(|error| format!("读取 DSH 插件配置 {} 失败：{error}", path.display()))?,
    })
}

fn profile_paths(root: &Path) -> (PathBuf, PathBuf) {
    (
        root.join("cordis.patch.yml"),
        root.join(SESSION_BRIDGE_DIR).join(SESSION_BRIDGE_FILE),
    )
}

fn approval_plugin_path(root: &Path) -> PathBuf {
    root.join(SESSION_BRIDGE_DIR).join(APPROVAL_BRIDGE_FILE)
}

fn approval_bridge_block() -> String {
    format!(
        "{APPROVAL_BRIDGE_START}\n- insert:\n    - id: flowlet-approval-bridge\n      name: ./.flowlet/{APPROVAL_BRIDGE_FILE}\n      config:\n        provider: flowlet\n{APPROVAL_BRIDGE_END}\n"
    )
}

fn session_bridge_block(expected_base_url: &str) -> String {
    format!(
        "{SESSION_BRIDGE_START}\n- insert:\n    - id: flowlet-session-bridge\n      name: ./.flowlet/{SESSION_BRIDGE_FILE}\n      config:\n        provider: flowlet\n        baseURL: {}\n{SESSION_BRIDGE_END}\n",
        normalize_url(expected_base_url)
    )
}

fn prepare_patch_list_for_append(text: &str) -> Result<String, String> {
    let lines = text.lines().collect::<Vec<_>>();
    let content = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| {
            let trimmed = line.trim();
            (!trimmed.is_empty() && !trimmed.starts_with('#') && trimmed != "---")
                .then_some((index, trimmed))
        })
        .collect::<Vec<_>>();

    if content.len() == 1 && content[0].1 == "[]" {
        return Ok(lines
            .into_iter()
            .enumerate()
            .filter_map(|(index, line)| (index != content[0].0).then_some(line))
            .collect::<Vec<_>>()
            .join("\n")
            .trim_end_matches(['\r', '\n'])
            .to_string());
    }
    if content
        .first()
        .is_some_and(|(_, line)| line.starts_with('['))
        || content.iter().any(|(_, line)| *line == "...")
    {
        return Err(
            "DSH cordis.patch.yml 使用了无法安全追加的行内数组或文档结束标记，请先改为块级 YAML 数组"
                .to_string(),
        );
    }
    Ok(text.trim_end_matches(['\r', '\n']).to_string())
}

fn ensure_patch_list_after_removal(text: &str) -> String {
    let has_entry = text.lines().any(|line| {
        let trimmed = line.trim();
        !trimmed.is_empty() && !trimmed.starts_with('#') && trimmed != "---"
    });
    if has_entry {
        return text.trim_end_matches(['\r', '\n']).to_string();
    }
    let comments = text.trim_end_matches(['\r', '\n']);
    if comments.is_empty() {
        "[]".to_string()
    } else {
        format!("{comments}\n[]")
    }
}

fn patch_session_bridge(text: &str, expected_base_url: &str) -> Result<Vec<u8>, String> {
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let normalized = text.replace("\r\n", "\n");
    let start = normalized.find(SESSION_BRIDGE_START);
    let end = normalized.find(SESSION_BRIDGE_END);
    let mut unmanaged = match (start, end) {
        (None, None) => normalized.trim_end_matches(['\r', '\n']).to_string(),
        (Some(start), Some(end)) if end >= start => {
            let end = end + SESSION_BRIDGE_END.len();
            let mut value = format!("{}{}", &normalized[..start], &normalized[end..]);
            while value.contains("\n\n\n") {
                value = value.replace("\n\n\n", "\n\n");
            }
            value.trim_end_matches(['\r', '\n']).to_string()
        }
        _ => {
            return Err(
                "DSH cordis.patch.yml 中的 Flowlet 会话桥接标记不完整，拒绝覆盖".to_string(),
            )
        }
    };
    unmanaged = prepare_patch_list_for_append(&unmanaged)?;
    if !unmanaged.is_empty() {
        unmanaged.push_str("\n\n");
    }
    unmanaged.push_str(&session_bridge_block(expected_base_url));
    Ok(unmanaged.replace('\n', newline).into_bytes())
}

fn remove_session_bridge(text: &str) -> Result<Vec<u8>, String> {
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let normalized = text.replace("\r\n", "\n");
    let start = normalized.find(SESSION_BRIDGE_START);
    let end = normalized.find(SESSION_BRIDGE_END);
    let output = match (start, end) {
        (None, None) => return Ok(text.as_bytes().to_vec()),
        (Some(start), Some(end)) if end >= start => {
            let end = end + SESSION_BRIDGE_END.len();
            let mut value = format!("{}{}", &normalized[..start], &normalized[end..]);
            while value.contains("\n\n\n") {
                value = value.replace("\n\n\n", "\n\n");
            }
            ensure_patch_list_after_removal(&value)
        }
        _ => {
            return Err(
                "DSH cordis.patch.yml 中的 Flowlet 会话桥接标记不完整，拒绝覆盖".to_string(),
            )
        }
    };
    Ok(if output.is_empty() {
        Vec::new()
    } else {
        format!("{}{}", output.replace('\n', newline), newline).into_bytes()
    })
}

fn profile_bridge_matches(root: &Path, expected_base_url: &str) -> bool {
    let (patch, plugin) = profile_paths(root);
    // 插件文件用容错比较（容忍尾部换行与 CRLF），与 managed_text_file_matches 语义一致。
    plugin.is_file()
        && managed_text_file_matches(&plugin, SESSION_BRIDGE_SOURCE)
        && std::fs::read_to_string(patch).ok().is_some_and(|text| {
            text.contains(SESSION_BRIDGE_START)
                && text.contains(SESSION_BRIDGE_END)
                && text.contains(&format!("baseURL: {}", normalize_url(expected_base_url)))
        })
}

fn patch_approval_bridge(text: &str) -> Result<Vec<u8>, String> {
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let normalized = text.replace("\r\n", "\n");
    let start = normalized.find(APPROVAL_BRIDGE_START);
    let end = normalized.find(APPROVAL_BRIDGE_END);
    let mut unmanaged = match (start, end) {
        (None, None) => normalized.trim_end_matches(['\r', '\n']).to_string(),
        (Some(start), Some(end)) if end >= start => {
            let end = end + APPROVAL_BRIDGE_END.len();
            let mut value = format!("{}{}", &normalized[..start], &normalized[end..]);
            while value.contains("\n\n\n") {
                value = value.replace("\n\n\n", "\n\n");
            }
            value.trim_end_matches(['\r', '\n']).to_string()
        }
        _ => {
            return Err(
                "DSH cordis.patch.yml 中的 Flowlet 交互确认桥标记不完整，拒绝覆盖".to_string(),
            )
        }
    };
    unmanaged = prepare_patch_list_for_append(&unmanaged)?;
    if !unmanaged.is_empty() {
        unmanaged.push_str("\n\n");
    }
    unmanaged.push_str(&approval_bridge_block());
    Ok(unmanaged.replace('\n', newline).into_bytes())
}

fn remove_approval_bridge(text: &str) -> Result<Vec<u8>, String> {
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let normalized = text.replace("\r\n", "\n");
    let start = normalized.find(APPROVAL_BRIDGE_START);
    let end = normalized.find(APPROVAL_BRIDGE_END);
    let output = match (start, end) {
        (None, None) => return Ok(text.as_bytes().to_vec()),
        (Some(start), Some(end)) if end >= start => {
            let end = end + APPROVAL_BRIDGE_END.len();
            let mut value = format!("{}{}", &normalized[..start], &normalized[end..]);
            while value.contains("\n\n\n") {
                value = value.replace("\n\n\n", "\n\n");
            }
            ensure_patch_list_after_removal(&value)
        }
        _ => {
            return Err(
                "DSH cordis.patch.yml 中的 Flowlet 交互确认桥标记不完整，拒绝覆盖".to_string(),
            )
        }
    };
    Ok(if output.is_empty() {
        Vec::new()
    } else {
        format!("{}{}", output.replace('\n', newline), newline).into_bytes()
    })
}

fn profile_approval_bridge_matches(root: &Path) -> bool {
    let plugin = approval_plugin_path(root);
    let patch = root.join("cordis.patch.yml");
    // 插件文件用容错比较（容忍 text_file_bytes 补的尾换行与 CRLF），
    // 与 managed_text_file_matches 语义一致；patch 只要求受管标记在位。
    plugin.is_file()
        && managed_text_file_matches(&plugin, APPROVAL_BRIDGE_SOURCE)
        && std::fs::read_to_string(patch).ok().is_some_and(|text| {
            text.contains(APPROVAL_BRIDGE_START) && text.contains(APPROVAL_BRIDGE_END)
        })
}

fn is_valid_token(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// 保守的 YAML 纯量安全判定：不满足时用单引号包裹（单引号按 YAML 规则翻倍转义）。
/// 覆盖 DSH 解析器与 serde_yaml 的常见歧义：行首指示符、`#`/`: `、数字与布尔字面量。
fn yaml_plain_safe(value: &str) -> bool {
    if value.is_empty() || value.trim() != value {
        return false;
    }
    let first = value.as_bytes()[0];
    if !(first.is_ascii_alphabetic() || first == b'_' || first == b'.') {
        return false;
    }
    if value.contains(": ") || value.contains(" #") || value.ends_with(':') {
        return false;
    }
    if value
        .chars()
        .any(|c| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | ':' | '\\' | '@' | '+' | '=' | '%' | '~' | '^' | '(' | ')')))
    {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    if matches!(lower.as_str(), "true" | "false" | "null" | "yes" | "no" | "on" | "off" | "~")
    {
        return false;
    }
    if value.parse::<i64>().is_ok() || value.parse::<f64>().is_ok() {
        return false;
    }
    true
}

fn yaml_quote(value: &str) -> String {
    if yaml_plain_safe(value) {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "''"))
    }
}

fn validate_mcp_servers(servers: &[McpServerSpec]) -> Result<(), String> {
    let mut ids = std::collections::HashSet::new();
    let mut server_names = std::collections::HashSet::new();
    for server in servers {
        if !is_valid_token(&server.id) {
            return Err(format!(
                "MCP 服务器 id 只能包含字母、数字、下划线和连字符：{}",
                server.id
            ));
        }
        if !ids.insert(server.id.as_str()) {
            return Err(format!("MCP 服务器 id 重复：{}", server.id));
        }
        if server.server_name.is_empty()
            || server.server_name.len() > MCP_MAX_SERVER_NAME
            || !is_valid_token(&server.server_name)
        {
            return Err(format!(
                "MCP serverName 必须是 1-{MCP_MAX_SERVER_NAME} 位字母、数字、下划线或连字符：{}",
                server.server_name
            ));
        }
        if !server_names.insert(server.server_name.as_str()) {
            return Err(format!("MCP serverName 重复：{}", server.server_name));
        }
        match server.transport.as_str() {
            "stdio" => {
                if server.command.as_deref().map_or(true, str::is_empty) {
                    return Err(format!(
                        "MCP 服务器 {} 使用 stdio 传输时必须提供 command",
                        server.id
                    ));
                }
            }
            "streamable-http" => {
                if server.url.as_deref().map_or(true, str::is_empty) {
                    return Err(format!(
                        "MCP 服务器 {} 使用 streamable-http 传输时必须提供 url",
                        server.id
                    ));
                }
            }
            _ => {
                return Err(format!(
                    "MCP 服务器 {} 的 transport 必须是 stdio 或 streamable-http",
                    server.id
                ))
            }
        }
    }
    Ok(())
}

/// 生成受管块的完整文本：一个 MCP 服务器对应一个 `- insert:` 插件实例，
/// 全部包在单一 flowlet-managed 标记内，供整块重写与移除。
fn mcp_servers_block(servers: &[McpServerSpec]) -> String {
    let mut block = String::from(MCP_SERVERS_START);
    for server in servers {
        block.push_str("\n- insert:\n");
        block.push_str(&format!("    - id: mcp-{}\n", server.id));
        block.push_str(&format!("      name: '{MCP_CLIENT_PACKAGE}'\n"));
        block.push_str("      config:\n");
        block.push_str(&format!("        serverName: {}\n", server.server_name));
        block.push_str(&format!("        transport: {}\n", server.transport));
        if server.transport == "stdio" {
            if let Some(command) = &server.command {
                block.push_str(&format!("        command: {}\n", yaml_quote(command)));
            }
            if let Some(args) = &server.args {
                if !args.is_empty() {
                    block.push_str(&format!(
                        "        args: [{}]\n",
                        args.iter().map(|arg| yaml_quote(arg)).collect::<Vec<_>>().join(", ")
                    ));
                }
            }
            if let Some(cwd) = &server.cwd {
                block.push_str(&format!("        cwd: {}\n", yaml_quote(cwd)));
            }
            if let Some(env) = &server.env {
                if !env.is_empty() {
                    block.push_str("        env:\n");
                    for (key, value) in env {
                        block.push_str(&format!("          {}: {}\n", yaml_quote(key), yaml_quote(value)));
                    }
                }
            }
        } else {
            if let Some(url) = &server.url {
                block.push_str(&format!("        url: {}\n", yaml_quote(url)));
            }
            if let Some(headers) = &server.headers {
                if !headers.is_empty() {
                    block.push_str("        headers:\n");
                    for (key, value) in headers {
                        block.push_str(&format!("          {}: {}\n", yaml_quote(key), yaml_quote(value)));
                    }
                }
            }
        }
    }
    block.push_str(MCP_SERVERS_END);
    block
}

/// 从 patch 文本中移除旧的 MCP 受管块并以新列表重写；调方需保证列表非空。
fn patch_mcp_servers(text: &str, servers: &[McpServerSpec]) -> Result<Vec<u8>, String> {
    debug_assert!(!servers.is_empty(), "空列表应走 remove_mcp_servers");
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let normalized = text.replace("\r\n", "\n");
    let start = normalized.find(MCP_SERVERS_START);
    let end = normalized.find(MCP_SERVERS_END);
    let mut unmanaged = match (start, end) {
        (None, None) => normalized.trim_end_matches(['\r', '\n']).to_string(),
        (Some(start), Some(end)) if end >= start => {
            let end = end + MCP_SERVERS_END.len();
            let mut value = format!("{}{}", &normalized[..start], &normalized[end..]);
            while value.contains("\n\n\n") {
                value = value.replace("\n\n\n", "\n\n");
            }
            value.trim_end_matches(['\r', '\n']).to_string()
        }
        _ => {
            return Err(
                "DSH cordis.patch.yml 中的 Flowlet MCP 受管标记不完整，拒绝覆盖".to_string(),
            )
        }
    };
    unmanaged = prepare_patch_list_for_append(&unmanaged)?;
    if !unmanaged.is_empty() {
        unmanaged.push_str("\n\n");
    }
    unmanaged.push_str(&mcp_servers_block(servers));
    Ok(unmanaged.replace('\n', newline).into_bytes())
}

fn remove_mcp_servers(text: &str) -> Result<Vec<u8>, String> {
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let normalized = text.replace("\r\n", "\n");
    let start = normalized.find(MCP_SERVERS_START);
    let end = normalized.find(MCP_SERVERS_END);
    let output = match (start, end) {
        (None, None) => return Ok(text.as_bytes().to_vec()),
        (Some(start), Some(end)) if end >= start => {
            let end = end + MCP_SERVERS_END.len();
            let mut value = format!("{}{}", &normalized[..start], &normalized[end..]);
            while value.contains("\n\n\n") {
                value = value.replace("\n\n\n", "\n\n");
            }
            ensure_patch_list_after_removal(&value)
        }
        _ => {
            return Err(
                "DSH cordis.patch.yml 中的 Flowlet MCP 受管标记不完整，拒绝覆盖".to_string(),
            )
        }
    };
    Ok(if output.is_empty() {
        Vec::new()
    } else {
        format!("{}{}", output.replace('\n', newline), newline).into_bytes()
    })
}

fn string_map_from(mapping: &serde_yaml::Mapping) -> BTreeMap<String, String> {
    mapping
        .iter()
        .filter_map(|(key, value)| {
            Some((key.as_str()?.to_string(), value.as_str()?.to_string()))
        })
        .collect()
}

/// 从单个 dsh-mcp-client 插件条目解析回 McpServerSpec；未知/无法解析的条目跳过。
/// 只接受我们生成的受管块结构（id 以 `mcp-` 开头），用户手写的其他条目不受影响。
fn parse_mcp_plugin(value: &serde_yaml::Value) -> Option<McpServerSpec> {
    let id = value.get("id")?.as_str()?.strip_prefix("mcp-")?.to_string();
    let config = value.get("config")?;
    let server_name = config.get("serverName")?.as_str()?.to_string();
    let transport = config.get("transport")?.as_str()?.to_string();
    let string_field = |key: &str| {
        config
            .get(key)
            .and_then(serde_yaml::Value::as_str)
            .map(str::to_string)
    };
    let spec = McpServerSpec {
        id,
        server_name,
        transport,
        command: string_field("command"),
        args: config
            .get("args")
            .and_then(serde_yaml::Value::as_sequence)
            .map(|sequence| {
                sequence
                    .iter()
                    .filter_map(serde_yaml::Value::as_str)
                    .map(str::to_string)
                    .collect()
            }),
        env: config
            .get("env")
            .and_then(serde_yaml::Value::as_mapping)
            .map(string_map_from),
        cwd: string_field("cwd"),
        url: string_field("url"),
        headers: config
            .get("headers")
            .and_then(serde_yaml::Value::as_mapping)
            .map(string_map_from),
    };
    Some(spec)
}

/// 解析单个 profile 的 cordis.patch.yml 中 Flowlet MCP 受管块。
fn parse_mcp_servers(text: &str) -> Result<Vec<McpServerSpec>, String> {
    let normalized = text.replace("\r\n", "\n");
    let Some(start) = normalized.find(MCP_SERVERS_START) else {
        return Ok(Vec::new());
    };
    let Some(end) = normalized.find(MCP_SERVERS_END) else {
        return Err("DSH cordis.patch.yml 中的 Flowlet MCP 受管标记不完整".to_string());
    };
    if end < start {
        return Err("DSH cordis.patch.yml 中的 Flowlet MCP 受管标记顺序错误".to_string());
    }
    let body_start = normalized[start..]
        .find('\n')
        .map(|offset| start + offset + 1)
        .unwrap_or(end);
    let body = normalized[body_start..end].trim();
    if body.is_empty() {
        return Ok(Vec::new());
    }
    let entries: Vec<serde_yaml::Value> = serde_yaml::from_str(body)
        .map_err(|error| format!("解析 DSH MCP 受管块失败：{error}"))?;
    Ok(entries
        .iter()
        .filter_map(|entry| {
            entry
                .get("insert")
                .and_then(serde_yaml::Value::as_sequence)
                .and_then(|sequence| sequence.first())
                .and_then(parse_mcp_plugin)
        })
        .collect())
}

/// 跨全部 base Profile 合并受管 MCP 服务器（按 id 去重，首个出现的 Profile 优先）。
fn collect_mcp_servers(profiles: &[(String, PathBuf)]) -> Result<Vec<McpServerSpec>, String> {
    let mut by_id = BTreeMap::new();
    for (_, root) in profiles {
        let patch = read_yaml_text(&root.join("cordis.patch.yml"))?;
        for server in parse_mcp_servers(&patch)? {
            by_id.entry(server.id.clone()).or_insert(server);
        }
    }
    Ok(by_id.into_values().collect())
}

fn inspect_dsh(expected_base_url: &str) -> Result<AgentGlobalConfigReport, String> {
    let home = dsh_home()?;
    inspect_dsh_at(&home, expected_base_url)
}

fn inspect_dsh_at(home: &Path, expected_base_url: &str) -> Result<AgentGlobalConfigReport, String> {
    let settings_path = home.join("settings.yaml");
    let credentials_path = home.join(".credentials.yaml");
    let backup_available = backup_path(&home).is_file();
    let profiles = dsh_profiles(&home)?;
    let session_extension = !profiles.is_empty()
        && profiles
            .iter()
            .all(|(_, root)| profile_bridge_matches(root, expected_base_url));
    // 交互确认桥：所有 base-bundle Profile 都部署了 Flowlet approval bridge。
    let approval_bridge = !profiles.is_empty()
        && profiles
            .iter()
            .all(|(_, root)| profile_approval_bridge_matches(root));
    // MCP 服务器：跨全部 base Profile 合并受管列表（按 id 去重）。
    let mcp_servers = collect_mcp_servers(&profiles)?;
    // 聚合模型规格声明：settings.yaml 中 flowlet-pro 模型条目携带 contextWindow。
    let model_specs = yaml_at(
        &read_yaml_value(&settings_path).unwrap_or_else(|_| serde_yaml::Value::Null),
        &[LLM_NAMESPACE, "providers", PROVIDER_ID, "models"],
    )
    .and_then(serde_yaml::Value::as_sequence)
    .is_some_and(|models| {
        models.iter().any(|entry| {
            entry.get("id").and_then(serde_yaml::Value::as_str) == Some("flowlet-pro")
                && entry.get("contextWindow").is_some()
        })
    });
    let report = |state, base_url, token, model, error| AgentGlobalConfigReport {
        agent_id: "deepseek-harness".to_string(),
        settings_path: display_path(&settings_path),
        credentials_path: Some(display_path(&credentials_path)),
        settings_exists: settings_path.is_file(),
        state,
        base_url,
        auth_token_configured: token,
        api_key_configured: token,
        primary_model: model,
        fast_model: None,
        subagent_model: None,
        model_catalog_path: None,
        model_catalog_configured: false,
        primary_long_context: false,
        fast_long_context: false,
        long_context: false,
        backup_available,
        external_environment_overrides: std::env::var_os(TOKEN_REF)
            .map(|_| vec![TOKEN_REF.to_string()])
            .unwrap_or_default(),
        error,
        session_extension,
        model_specs,
        model_input_modalities: BTreeMap::new(),
        approval_bridge,
        mcp_servers: mcp_servers.clone(),
        opencode_permission_bridge: false,
    };
    if !settings_path.is_file() {
        return Ok(report(
            AgentGlobalConfigState::NotConfigured,
            None,
            false,
            None,
            None,
        ));
    }
    let settings = match read_yaml_value(&settings_path) {
        Ok(value) => value,
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
    let provider = yaml_at(&settings, &[LLM_NAMESPACE, "providers", PROVIDER_ID]);
    let base_url = provider
        .and_then(|value| value.get("baseURL"))
        .and_then(serde_yaml::Value::as_str)
        .map(str::to_string);
    let key_ref_matches = provider
        .and_then(|value| value.get("apiKeyEnv"))
        .and_then(serde_yaml::Value::as_str)
        == Some(TOKEN_REF);
    let api_matches = provider
        .and_then(|value| value.get("api"))
        .and_then(serde_yaml::Value::as_str)
        == Some("openai-completions");
    let model = yaml_at(&settings, &[DEFAULT_MODEL_NAMESPACE, "model"])
        .and_then(serde_yaml::Value::as_str)
        .map(str::to_string);
    let default_provider = yaml_at(&settings, &[DEFAULT_MODEL_NAMESPACE, "provider"])
        .and_then(serde_yaml::Value::as_str);
    let token = std::env::var_os(TOKEN_REF).is_some()
        || read_credential_value(&credentials_path)?.is_some();
    let base_matches = base_url.as_deref().map(normalize_url).as_deref()
        == Some(normalize_url(expected_base_url).as_str());
    let state = if base_matches && key_ref_matches && api_matches && token
        && default_provider == Some(PROVIDER_ID)
        && model.as_deref() == Some("flowlet-pro")
    {
        AgentGlobalConfigState::Flowlet
    } else if base_url
        .as_deref()
        .is_some_and(|value| normalize_url(value) != normalize_url(expected_base_url))
    {
        AgentGlobalConfigState::OtherGateway
    } else if provider.is_some()
        || default_provider == Some(PROVIDER_ID)
        || model
            .as_deref()
            .is_some_and(|value| value.starts_with("flowlet"))
    {
        AgentGlobalConfigState::Partial
    } else {
        AgentGlobalConfigState::NotConfigured
    };
    Ok(report(state, base_url, token, model, None))
}

pub(in crate::core::agent_global_config) fn read_yaml_text(path: &Path) -> Result<String, String> {
    if !path.is_file() {
        return Ok(String::new());
    }
    std::fs::read_to_string(path).map_err(|error| format!("读取 {} 失败：{error}", path.display()))
}

pub(in crate::core::agent_global_config) fn read_yaml_value(
    path: &Path,
) -> Result<serde_yaml::Value, String> {
    let text = read_yaml_text(path)?;
    if text.trim().is_empty() {
        return Ok(serde_yaml::Value::Mapping(Default::default()));
    }
    let value: serde_yaml::Value = serde_yaml::from_str(&text)
        .map_err(|error| format!("解析 {} 失败：{error}", path.display()))?;
    if !value.is_mapping() {
        return Err(format!("{} 的根节点必须是 YAML 对象", path.display()));
    }
    Ok(value)
}

fn read_credential_value(path: &Path) -> Result<Option<String>, String> {
    let credentials = read_yaml_value(path)?;
    Ok(yaml_at(&credentials, &[CREDENTIAL_REFS, TOKEN_REF])
        .or_else(|| yaml_at(&credentials, &[TOKEN_REF]))
        .and_then(serde_yaml::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string))
}

pub(in crate::core::agent_global_config) fn yaml_at<'a>(
    root: &'a serde_yaml::Value,
    path: &[&str],
) -> Option<&'a serde_yaml::Value> {
    let mut current = Some(root);
    for segment in path {
        current = current.and_then(|value| {
            // 先尝试按映射键查找
            if let Some(result) = value.get(*segment) {
                return Some(result);
            }
            // 再尝试作为序列索引（数字字符串 → usize）
            if let Ok(index) = segment.parse::<usize>() {
                return value.get(index);
            }
            None
        });
    }
    current
}

fn backed_up_yaml_value(root: &serde_yaml::Value, path: &[&str]) -> Result<BackedUpValue, String> {
    let value = yaml_at(root, path);
    Ok(BackedUpValue {
        present: value.is_some(),
        value: value
            .map(serde_json::to_value)
            .transpose()
            .map_err(|error| format!("转换 DSH YAML 备份失败：{error}"))?
            .unwrap_or(Value::Null),
    })
}

fn capture_snapshot(
    settings_path: &Path,
    credentials_path: &Path,
) -> Result<ManagedSnapshot, String> {
    let settings = read_yaml_value(settings_path)?;
    let credentials = read_yaml_value(credentials_path)?;
    Ok(ManagedSnapshot {
        provider: backed_up_yaml_value(&settings, &[LLM_NAMESPACE, "providers", PROVIDER_ID])?,
        default_provider: backed_up_yaml_value(&settings, &[DEFAULT_MODEL_NAMESPACE, "provider"])?,
        default_model: backed_up_yaml_value(&settings, &[DEFAULT_MODEL_NAMESPACE, "model"])?,
        credential: if yaml_at(&credentials, &[CREDENTIAL_REFS, TOKEN_REF]).is_some() {
            backed_up_yaml_value(&credentials, &[CREDENTIAL_REFS, TOKEN_REF])?
        } else {
            backed_up_yaml_value(&credentials, &[TOKEN_REF])?
        },
    })
}

#[derive(Clone, Copy, Debug)]
struct LineBlock {
    start: usize,
    end: usize,
    indent: usize,
}

fn line_indent(line: &str) -> Option<usize> {
    let trimmed = line.trim_start_matches(' ');
    if trimmed.is_empty() || trimmed.starts_with('#') {
        None
    } else {
        Some(line.len() - trimmed.len())
    }
}

fn mapping_key(line: &str, indent: usize) -> Option<String> {
    if line_indent(line)? != indent {
        return None;
    }
    let content = &line[indent..];
    if content.starts_with('-') {
        return None;
    }
    let mut quote = None;
    let mut escaped = false;
    let mut colon = None;
    for (index, character) in content.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' if quote == Some('"') => escaped = true,
            '\'' | '"' if quote == Some(character) => quote = None,
            '\'' | '"' if quote.is_none() => quote = Some(character),
            ':' if quote.is_none() => {
                colon = Some(index);
                break;
            }
            _ => {}
        }
    }
    let token = content[..colon?].trim();
    if token.is_empty() {
        return None;
    }
    if let Some(unquoted) = token
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
    {
        return serde_yaml::from_str::<String>(&format!("\"{unquoted}\"")).ok();
    }
    if let Some(unquoted) = token
        .strip_prefix('\'')
        .and_then(|value| value.strip_suffix('\''))
    {
        return Some(unquoted.replace("''", "'"));
    }
    Some(token.to_string())
}

fn significant_end(lines: &[String], start: usize, end: usize) -> usize {
    let mut result = end;
    while result > start + 1 && line_indent(&lines[result - 1]).is_none() {
        result -= 1;
    }
    result
}

fn find_entry(
    lines: &[String],
    range: std::ops::Range<usize>,
    indent: usize,
    key: &str,
) -> Option<LineBlock> {
    let start = range
        .clone()
        .find(|index| mapping_key(&lines[*index], indent).as_deref() == Some(key))?;
    let raw_end = ((start + 1)..range.end)
        .find(|index| line_indent(&lines[*index]).is_some_and(|value| value <= indent))
        .unwrap_or(range.end);
    Some(LineBlock {
        start,
        end: significant_end(lines, start, raw_end),
        indent,
    })
}

fn child_indent(lines: &[String], block: LineBlock) -> usize {
    ((block.start + 1)..block.end)
        .filter_map(|index| line_indent(&lines[index]))
        .filter(|indent| *indent > block.indent)
        .min()
        .unwrap_or(block.indent + 2)
}

fn insertion_index(lines: &[String], start: usize, end: usize) -> usize {
    let mut index = end;
    while index > start && line_indent(&lines[index - 1]).is_none() {
        index -= 1;
    }
    index
}

fn serialized_yaml_lines(value: &Value) -> Result<Vec<String>, String> {
    let yaml = serde_yaml::to_string(value)
        .map_err(|error| format!("序列化 DSH 受管字段失败：{error}"))?;
    Ok(yaml
        .strip_prefix("---\n")
        .unwrap_or(&yaml)
        .trim_end_matches(['\r', '\n'])
        .lines()
        .map(str::to_string)
        .collect())
}

fn render_entry(indent: usize, key: &str, value: &Value) -> Result<Vec<String>, String> {
    let rendered = serialized_yaml_lines(value)?;
    let prefix = " ".repeat(indent);
    if rendered.len() == 1 && !value.is_object() && !value.is_array() {
        return Ok(vec![format!("{prefix}{key}: {}", rendered[0])]);
    }
    let child_prefix = " ".repeat(indent + 2);
    let mut lines = vec![format!("{prefix}{key}:")];
    lines.extend(
        rendered
            .into_iter()
            .map(|line| format!("{child_prefix}{line}")),
    );
    Ok(lines)
}

fn render_nested_entry(
    indent: usize,
    parents: &[&str],
    key: &str,
    value: &Value,
) -> Result<Vec<String>, String> {
    if let Some((parent, rest)) = parents.split_first() {
        let mut lines = vec![format!("{}{parent}:", " ".repeat(indent))];
        lines.extend(render_nested_entry(indent + 2, rest, key, value)?);
        Ok(lines)
    } else {
        render_entry(indent, key, value)
    }
}

pub(in crate::core::agent_global_config) fn patch_yaml_entry(
    text: &str,
    label: &str,
    parents: &[&str],
    key: &str,
    value: Option<&Value>,
) -> Result<Vec<u8>, String> {
    let parsed = if text.trim().is_empty() {
        serde_yaml::Value::Mapping(Default::default())
    } else {
        serde_yaml::from_str(text).map_err(|error| format!("解析 {label} 失败：{error}"))?
    };
    if !parsed.is_mapping() {
        return Err(format!("{label} 的根节点必须是 YAML 对象"));
    }

    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let had_trailing_newline = text.ends_with('\n');
    let normalized = text.replace("\r\n", "\n");
    let mut lines: Vec<String> = normalized.lines().map(str::to_string).collect();
    let mut range = 0..lines.len();
    let mut indent = 0;
    let mut semantic_path = Vec::new();

    for (index, parent) in parents.iter().enumerate() {
        semantic_path.push(*parent);
        let semantic = yaml_at(&parsed, &semantic_path);
        let Some(block) = find_entry(&lines, range.clone(), indent, parent) else {
            if semantic.is_some() {
                return Err(format!(
                    "{label} 中的 {} 使用了 Flowlet 暂不支持安全改写的行内或复杂 YAML 写法；请改为普通缩进映射",
                    semantic_path.join(".")
                ));
            }
            let Some(value) = value else {
                return Ok(text_file_bytes(text));
            };
            let insert_at = insertion_index(&lines, range.start, range.end);
            let rendered = render_nested_entry(indent, &parents[index..], key, value)?;
            lines.splice(insert_at..insert_at, rendered);
            let mut output = lines.join(newline);
            if had_trailing_newline || !output.is_empty() {
                output.push_str(newline);
            }
            return Ok(output.into_bytes());
        };
        if semantic.is_some_and(|node| !node.is_mapping()) {
            return Err(format!(
                "{label} 中的 {} 必须是 YAML 对象",
                semantic_path.join(".")
            ));
        }
        range = (block.start + 1)..block.end;
        indent = child_indent(&lines, block);
    }

    let semantic_target = {
        let mut path = semantic_path;
        path.push(key);
        yaml_at(&parsed, &path).is_some()
    };
    match find_entry(&lines, range.clone(), indent, key) {
        Some(block) => {
            let replacement = value
                .map(|value| render_entry(block.indent, key, value))
                .transpose()?
                .unwrap_or_default();
            lines.splice(block.start..block.end, replacement);
        }
        None if semantic_target => {
            return Err(format!(
                "{label} 中的 {} 使用了 Flowlet 暂不支持安全改写的行内或复杂 YAML 写法；请改为普通缩进映射",
                parents.iter().chain(std::iter::once(&key)).copied().collect::<Vec<_>>().join(".")
            ));
        }
        None => {
            if let Some(value) = value {
                let insert_at = insertion_index(&lines, range.start, range.end);
                lines.splice(insert_at..insert_at, render_entry(indent, key, value)?);
            }
        }
    }
    let mut output = lines.join(newline);
    if had_trailing_newline || (!output.is_empty() && text.is_empty()) {
        output.push_str(newline);
    }
    Ok(output.into_bytes())
}

#[cfg(test)]
fn provider_profile(expected_base_url: &str, model_specs: bool) -> Value {
    provider_profile_with_inputs(expected_base_url, model_specs, None)
}

fn provider_profile_with_inputs(
    expected_base_url: &str,
    model_specs: bool,
    model_inputs: Option<&std::collections::BTreeMap<String, Vec<String>>>,
) -> Value {
    let input_for = |model: &str| {
        let requested = model_inputs
            .and_then(|inputs| inputs.get(model))
            .cloned()
            .unwrap_or_default();
        let mut normalized = vec!["text".to_string()];
        if requested.iter().any(|value| value == "image") {
            normalized.push("image".to_string());
        }
        normalized
    };
    let pro = if model_specs {
        json!({ "id": "flowlet-pro", "contextWindow": 1048576, "input": input_for("flowlet-pro") })
    } else {
        json!({ "id": "flowlet-pro" })
    };
    let flash = if model_specs {
        json!({ "id": "flowlet-flash", "contextWindow": 1048576, "input": input_for("flowlet-flash") })
    } else {
        json!({ "id": "flowlet-flash" })
    };
    json!({
        "displayName": "Flowlet",
        "apiKeyEnv": TOKEN_REF,
        "api": "openai-completions",
        "baseURL": normalize_url(expected_base_url),
        "models": [pro, flash],
    })
}

fn apply_settings_text(
    text: &str,
    expected_base_url: &str,
    model_specs: bool,
    model_inputs: Option<&std::collections::BTreeMap<String, Vec<String>>>,
) -> Result<Vec<u8>, String> {
    let provider = provider_profile_with_inputs(expected_base_url, model_specs, model_inputs);
    let text = String::from_utf8(patch_yaml_entry(
        text,
        "settings.yaml",
        &[LLM_NAMESPACE, "providers"],
        PROVIDER_ID,
        Some(&provider),
    )?)
    .map_err(|error| format!("生成 settings.yaml 失败：{error}"))?;
    let default_provider = Value::String(PROVIDER_ID.to_string());
    let text = String::from_utf8(patch_yaml_entry(
        &text,
        "settings.yaml",
        &[DEFAULT_MODEL_NAMESPACE],
        "provider",
        Some(&default_provider),
    )?)
    .map_err(|error| format!("生成 settings.yaml 失败：{error}"))?;
    let default_model = Value::String("flowlet-pro".to_string());
    patch_yaml_entry(
        &text,
        "settings.yaml",
        &[DEFAULT_MODEL_NAMESPACE],
        "model",
        Some(&default_model),
    )
}

fn apply_credentials_text(text: &str, client_token: &str) -> Result<Vec<u8>, String> {
    let token = Value::String(client_token.to_string());
    patch_credential_value(text, Some(&token))
}

fn patch_credential_value(text: &str, value: Option<&Value>) -> Result<Vec<u8>, String> {
    let parsed: serde_yaml::Value = if text.trim().is_empty() {
        serde_yaml::Value::Mapping(Default::default())
    } else {
        serde_yaml::from_str(text)
            .map_err(|error| format!("解析 .credentials.yaml 失败：{error}"))?
    };
    if !parsed.is_mapping() {
        return Err(".credentials.yaml 的根节点必须是 YAML 对象".to_string());
    }

    // DSH 0.1.1 起使用 `version: 1` + `refs:`；旧预发布版本使用根级扁平映射。
    // 已出现 version/refs/records 任一字段即按新版写入，并删除 Flowlet 旧版曾误写的
    // 根级同名键，从而自动修复新旧布局混合、导致 DSH 无法启动的文件。
    let versioned = ["version", CREDENTIAL_REFS, "records"]
        .iter()
        .any(|key| yaml_at(&parsed, &[*key]).is_some());
    if versioned {
        let nested = String::from_utf8(patch_yaml_entry(
            text,
            ".credentials.yaml",
            &[CREDENTIAL_REFS],
            TOKEN_REF,
            value,
        )?)
        .map_err(|error| format!("生成 .credentials.yaml 失败：{error}"))?;
        patch_yaml_entry(&nested, ".credentials.yaml", &[], TOKEN_REF, None)
    } else {
        patch_yaml_entry(text, ".credentials.yaml", &[], TOKEN_REF, value)
    }
}

fn restore_settings_text(text: &str, snapshot: &ManagedSnapshot) -> Result<Vec<u8>, String> {
    let provider = snapshot
        .provider
        .present
        .then_some(&snapshot.provider.value);
    let text = String::from_utf8(patch_yaml_entry(
        text,
        "settings.yaml",
        &[LLM_NAMESPACE, "providers"],
        PROVIDER_ID,
        provider,
    )?)
    .map_err(|error| format!("恢复 settings.yaml 失败：{error}"))?;
    let default_provider = snapshot
        .default_provider
        .present
        .then_some(&snapshot.default_provider.value);
    let text = String::from_utf8(patch_yaml_entry(
        &text,
        "settings.yaml",
        &[DEFAULT_MODEL_NAMESPACE],
        "provider",
        default_provider,
    )?)
    .map_err(|error| format!("恢复 settings.yaml 失败：{error}"))?;
    let default_model = snapshot
        .default_model
        .present
        .then_some(&snapshot.default_model.value);
    patch_yaml_entry(
        &text,
        "settings.yaml",
        &[DEFAULT_MODEL_NAMESPACE],
        "model",
        default_model,
    )
}

fn restore_credentials_text(text: &str, snapshot: &ManagedSnapshot) -> Result<Vec<u8>, String> {
    let credential = snapshot
        .credential
        .present
        .then_some(&snapshot.credential.value);
    patch_credential_value(text, credential)
}

fn apply_dsh(
    expected_base_url: &str,
    client_token: &str,
    session_extension: bool,
    model_specs: bool,
    model_inputs: Option<&std::collections::BTreeMap<String, Vec<String>>>,
    approval_bridge: bool,
    mcp_servers: Option<&[McpServerSpec]>,
) -> Result<AgentGlobalConfigReport, String> {
    let home = dsh_home()?;
    apply_dsh_at_with_inputs(
        &home,
        expected_base_url,
        client_token,
        session_extension,
        model_specs,
        approval_bridge,
        model_inputs,
        mcp_servers,
    )
}

#[cfg(test)]
fn apply_dsh_at(
    home: &Path,
    expected_base_url: &str,
    client_token: &str,
    session_extension: bool,
    model_specs: bool,
    approval_bridge: bool,
) -> Result<AgentGlobalConfigReport, String> {
    apply_dsh_at_with_inputs(
        home,
        expected_base_url,
        client_token,
        session_extension,
        model_specs,
        approval_bridge,
        None,
        None,
    )
}

fn apply_dsh_at_with_inputs(
    home: &Path,
    expected_base_url: &str,
    client_token: &str,
    session_extension: bool,
    model_specs: bool,
    approval_bridge: bool,
    model_inputs: Option<&std::collections::BTreeMap<String, Vec<String>>>,
    mcp_servers: Option<&[McpServerSpec]>,
) -> Result<AgentGlobalConfigReport, String> {
    // 服务器列表校验是纯函数，先于任何锁与文件操作执行。
    if let Some(servers) = mcp_servers {
        if !servers.is_empty() {
            validate_mcp_servers(servers)?;
        }
    }
    let settings_path = home.join("settings.yaml");
    let credentials_path = home.join(".credentials.yaml");
    let backup = backup_path(&home);
    let _settings_lock = DshFileLock::acquire(&settings_path)?;
    let _credentials_lock = DshFileLock::acquire(&credentials_path)?;
    let settings_text = read_yaml_text(&settings_path)?;
    let credentials_text = read_yaml_text(&credentials_path)?;
    let current = capture_snapshot(&settings_path, &credentials_path)?;
    let settings_output = apply_settings_text(
        &settings_text,
        expected_base_url,
        model_specs,
        model_inputs,
    )?;
    let credentials_output = apply_credentials_text(&credentials_text, client_token)?;
    let profiles = dsh_profiles(&home)?;
    if session_extension && profiles.is_empty() {
        return Err(
            "尚未发现可安装 Flowlet 会话插件的 DSH Profile；请先启动一次 DeepSeek Harness，或关闭可选的精确会话关联"
                .to_string(),
        );
    }
    if mcp_servers.is_some_and(|servers| !servers.is_empty()) && profiles.is_empty() {
        return Err(
            "尚未发现可部署 MCP 服务器的 DSH Profile；请先启动一次 DeepSeek Harness，或移除 MCP 服务器"
                .to_string(),
        );
    }
    let created_backup = !backup.is_file();
    let mut backup_value = if created_backup {
        DshConfigBackup {
            version: BACKUP_VERSION,
            agent_id: "deepseek-harness".to_string(),
            provider: current.provider.clone(),
            default_provider: current.default_provider.clone(),
            default_model: current.default_model.clone(),
            credential: current.credential.clone(),
            profiles: Vec::new(),
        }
    } else {
        serde_json::from_value(read_settings(&backup)?)
            .map_err(|error| format!("解析 DSH 配置备份失败：{error}"))?
    };
    if backup_value.version != BACKUP_VERSION || backup_value.agent_id != "deepseek-harness" {
        return Err("DeepSeek Harness 配置备份版本不受支持".to_string());
    }
    for (profile, root) in &profiles {
        if backup_value
            .profiles
            .iter()
            .any(|item| item.profile == *profile)
        {
            continue;
        }
        let (patch, plugin) = profile_paths(root);
        backup_value.profiles.push(DshProfileBackup {
            profile: profile.clone(),
            patch: backed_up_text(&patch)?,
            plugin: backed_up_text(&plugin)?,
            approval_plugin: Some(backed_up_text(&approval_plugin_path(root))?),
        });
    }
    // 旧版备份无 approval_plugin 字段，补录当前文件原文，保证恢复时能完整还原。
    for item in &mut backup_value.profiles {
        if item.approval_plugin.is_none() {
            if let Some(root) = profiles
                .iter()
                .find(|(p, _)| p == &item.profile)
                .map(|(_, r)| r)
            {
                item.approval_plugin = Some(backed_up_text(&approval_plugin_path(root))?);
            }
        }
    }
    let mut writes = vec![
        (settings_path, Some(settings_output)),
        (credentials_path, Some(credentials_output)),
    ];
    for (profile, root) in &profiles {
        let (patch, plugin) = profile_paths(root);
        let approval_plugin = approval_plugin_path(root);
        // 会话桥接与交互确认桥共用同一份 patch 文本，按序叠加各自的受管块，
        // 最终只提交一次 patch 写入（write_files_transactionally 不做去重，后写覆盖先写）。
        let mut patch_text = read_yaml_text(&patch)?;
        let mut patch_changed = false;
        if session_extension {
            patch_text = String::from_utf8(patch_session_bridge(&patch_text, expected_base_url)?)
                .map_err(|_| "DSH 会话桥接输出不是合法 UTF-8".to_string())?;
            patch_changed = true;
            writes.push((plugin, Some(text_file_bytes(SESSION_BRIDGE_SOURCE))));
        } else {
            let patch_output = remove_session_bridge(&patch_text)?;
            if patch_output != patch_text.as_bytes() {
                patch_text = String::from_utf8(patch_output)
                    .map_err(|_| "DSH 会话桥接输出不是合法 UTF-8".to_string())?;
                patch_changed = true;
            }
            let previous_plugin = backup_value
                .profiles
                .iter()
                .find(|item| item.profile == *profile)
                .and_then(|item| {
                    item.plugin
                        .present
                        .then(|| text_file_bytes(&item.plugin.content))
                });
            if managed_text_file_matches(&plugin, SESSION_BRIDGE_SOURCE) {
                writes.push((plugin, previous_plugin));
            }
        }
        if approval_bridge {
            patch_text = String::from_utf8(patch_approval_bridge(&patch_text)?)
                .map_err(|_| "DSH 交互确认桥输出不是合法 UTF-8".to_string())?;
            patch_changed = true;
            writes.push((
                approval_plugin,
                Some(text_file_bytes(APPROVAL_BRIDGE_SOURCE)),
            ));
        } else {
            let patch_output = remove_approval_bridge(&patch_text)?;
            if patch_output != patch_text.as_bytes() {
                patch_text = String::from_utf8(patch_output)
                    .map_err(|_| "DSH 交互确认桥输出不是合法 UTF-8".to_string())?;
                patch_changed = true;
            }
            let previous_approval_plugin = backup_value
                .profiles
                .iter()
                .find(|item| item.profile == *profile)
                .and_then(|item| {
                    item.approval_plugin
                        .as_ref()
                        .and_then(|backup| backup.present.then(|| text_file_bytes(&backup.content)))
                });
            if managed_text_file_matches(&approval_plugin, APPROVAL_BRIDGE_SOURCE) {
                writes.push((approval_plugin, previous_approval_plugin));
            }
        }
        // MCP 服务器受管块：`Some(非空)` 整块重写，`Some(空)` 移除，`None` 不触碰。
        if let Some(servers) = mcp_servers {
            if servers.is_empty() {
                let patch_output = remove_mcp_servers(&patch_text)?;
                if patch_output != patch_text.as_bytes() {
                    patch_text = String::from_utf8(patch_output)
                        .map_err(|_| "DSH MCP 服务器输出不是合法 UTF-8".to_string())?;
                    patch_changed = true;
                }
            } else {
                patch_text = String::from_utf8(patch_mcp_servers(&patch_text, servers)?)
                    .map_err(|_| "DSH MCP 服务器输出不是合法 UTF-8".to_string())?;
                patch_changed = true;
            }
        }
        if patch_changed {
            writes.push((patch, Some(patch_text.into_bytes())));
        }
    }
    write_json_file(
        &backup,
        &serde_json::to_value(&backup_value)
            .map_err(|error| format!("序列化 DSH 配置备份失败：{error}"))?,
    )?;
    if let Err(error) =
        write_files_transactionally("DeepSeek Harness 配置与 Flowlet 会话/确认插件", &writes)
    {
        if created_backup && error.rolled_back {
            let _ = std::fs::remove_file(&backup);
        }
        return Err(error.message);
    }
    inspect_dsh_at(home, expected_base_url)
}

fn restore_dsh(expected_base_url: &str) -> Result<AgentGlobalConfigReport, String> {
    let home = dsh_home()?;
    restore_dsh_at(&home, expected_base_url)
}

fn restore_dsh_at(home: &Path, expected_base_url: &str) -> Result<AgentGlobalConfigReport, String> {
    let settings_path = home.join("settings.yaml");
    let credentials_path = home.join(".credentials.yaml");
    let backup_path = backup_path(&home);
    if !backup_path.is_file() {
        return Err("没有可恢复的 DeepSeek Harness 接入前配置".to_string());
    }
    let backup: DshConfigBackup = serde_json::from_value(read_settings(&backup_path)?)
        .map_err(|error| format!("解析 DSH 配置备份失败：{error}"))?;
    if backup.version != BACKUP_VERSION || backup.agent_id != "deepseek-harness" {
        return Err("DeepSeek Harness 配置备份版本不受支持".to_string());
    }
    let snapshot = ManagedSnapshot {
        provider: backup.provider,
        default_provider: backup.default_provider,
        default_model: backup.default_model,
        credential: backup.credential,
    };
    let _settings_lock = DshFileLock::acquire(&settings_path)?;
    let _credentials_lock = DshFileLock::acquire(&credentials_path)?;
    let mut writes = vec![
        (
            settings_path.clone(),
            Some(restore_settings_text(
                &read_yaml_text(&settings_path)?,
                &snapshot,
            )?),
        ),
        (
            credentials_path.clone(),
            Some(restore_credentials_text(
                &read_yaml_text(&credentials_path)?,
                &snapshot,
            )?),
        ),
    ];
    let profiles_root = home.join("profiles");
    for profile in &backup.profiles {
        if profile.profile.is_empty()
            || profile.profile.contains('/')
            || profile.profile.contains('\\')
            || profile.profile == "."
            || profile.profile == ".."
        {
            return Err("DeepSeek Harness 配置备份包含无效 Profile 名称".to_string());
        }
        let root = profiles_root.join(&profile.profile);
        let (patch, plugin) = profile_paths(&root);
        writes.push((
            patch,
            profile
                .patch
                .present
                .then(|| text_file_bytes(&profile.patch.content)),
        ));
        writes.push((
            plugin,
            profile
                .plugin
                .present
                .then(|| text_file_bytes(&profile.plugin.content)),
        ));
        writes.push((
            approval_plugin_path(&root),
            profile
                .approval_plugin
                .as_ref()
                .and_then(|backup| backup.present.then(|| text_file_bytes(&backup.content))),
        ));
    }
    write_files_transactionally("DeepSeek Harness 配置与 Flowlet 会话/确认插件", &writes)
        .map_err(|error| error.message)?;
    std::fs::remove_file(&backup_path)
        .map_err(|error| format!("删除 DSH 配置备份失败：{error}"))?;
    inspect_dsh_at(home, expected_base_url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_documented_flowlet_custom_provider() {
        assert_eq!(
            provider_profile("http://127.0.0.1:18640/v1/", false),
            json!({
                "displayName": "Flowlet",
                "apiKeyEnv": "FLOWLET_CLIENT_TOKEN",
                "api": "openai-completions",
                "baseURL": "http://127.0.0.1:18640/v1",
                "models": [{ "id": "flowlet-pro" }, { "id": "flowlet-flash" }],
            })
        );
    }

    #[test]
    fn model_specs_declares_context_window_on_both_aggregate_models() {
        let model_inputs = std::collections::BTreeMap::from([
            (
                "flowlet-pro".to_string(),
                vec!["text".to_string(), "image".to_string()],
            ),
            ("flowlet-flash".to_string(), vec!["text".to_string()]),
        ]);
        let value = provider_profile_with_inputs(
            "http://127.0.0.1:18640/v1",
            true,
            Some(&model_inputs),
        );
        let models = value["models"].as_array().unwrap();
        assert_eq!(models.len(), 2);
        for entry in models {
            assert_eq!(
                entry["contextWindow"].as_i64(),
                Some(1_048_576),
                "每个聚合模型条目都应声明 1M 上下文窗口：{entry}"
            );
        }
        assert_eq!(models[0]["input"], json!(["text", "image"]));
        assert_eq!(models[1]["input"], json!(["text"]));
        let text = String::from_utf8(
            apply_settings_text(
                "unrelated: keep\n",
                "http://127.0.0.1:18640/v1",
                true,
                Some(&model_inputs),
            )
            .unwrap(),
        )
        .unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&text).unwrap();
        assert_eq!(
            yaml_at(
                &parsed,
                &[
                    LLM_NAMESPACE,
                    "providers",
                    PROVIDER_ID,
                    "models",
                    "0",
                    "contextWindow"
                ]
            )
            .and_then(serde_yaml::Value::as_i64),
            Some(1_048_576)
        );
        assert_eq!(
            yaml_at(
                &parsed,
                &[LLM_NAMESPACE, "providers", PROVIDER_ID, "models", "0", "input"]
            )
            .and_then(serde_yaml::Value::as_sequence)
            .map(Vec::len),
            Some(2)
        );
        // 关闭规格声明后重新写入应移除 contextWindow（不残留旧声明）。
        let disabled = String::from_utf8(
            apply_settings_text(&text, "http://127.0.0.1:18640/v1", false, None).unwrap(),
        )
        .unwrap();
        let reparsed: serde_yaml::Value = serde_yaml::from_str(&disabled).unwrap();
        for index in ["0", "1"] {
            assert!(
                yaml_at(
                    &reparsed,
                    &[
                        LLM_NAMESPACE,
                        "providers",
                        PROVIDER_ID,
                        "models",
                        index,
                        "contextWindow"
                    ]
                )
                .is_none(),
                "关闭后模型条目 {index} 不应残留 contextWindow"
            );
            assert!(
                yaml_at(
                    &reparsed,
                    &[LLM_NAMESPACE, "providers", PROVIDER_ID, "models", index, "input"]
                )
                .is_none(),
                "关闭后模型条目 {index} 不应残留 input"
            );
        }
    }

    #[test]
    fn lossless_edit_preserves_unmanaged_yaml_and_comments() {
        let before = "# keep root\nui-theme:\n  mode: dark # keep inline\nllm-pi-ai:\n  providers:\n    other:\n      baseURL: https://other.example/v1\n";
        let output =
            String::from_utf8(apply_settings_text(before, "http://127.0.0.1:18640/v1", false, None).unwrap())
                .unwrap();
        assert!(output.contains("# keep root"));
        assert!(output.contains("mode: dark # keep inline"));
        assert!(output.contains("https://other.example/v1"));
        let parsed: serde_yaml::Value = serde_yaml::from_str(&output).unwrap();
        assert_eq!(
            yaml_at(
                &parsed,
                &[LLM_NAMESPACE, "providers", PROVIDER_ID, "baseURL"]
            )
            .and_then(serde_yaml::Value::as_str),
            Some("http://127.0.0.1:18640/v1")
        );
        assert_eq!(
            yaml_at(&parsed, &[DEFAULT_MODEL_NAMESPACE, "model"])
                .and_then(serde_yaml::Value::as_str),
            Some("flowlet-pro")
        );
    }

    #[test]
    fn restore_changes_only_managed_paths() {
        let original: serde_yaml::Value = serde_yaml::from_str(
            "llm-pi-ai:\n  providers:\n    flowlet:\n      baseURL: https://old.example/v1\nagent-default-model:\n  provider: other\n  model: old\n",
        )
        .unwrap();
        let snapshot = ManagedSnapshot {
            provider: backed_up_yaml_value(&original, &[LLM_NAMESPACE, "providers", PROVIDER_ID])
                .unwrap(),
            default_provider: backed_up_yaml_value(
                &original,
                &[DEFAULT_MODEL_NAMESPACE, "provider"],
            )
            .unwrap(),
            default_model: backed_up_yaml_value(&original, &[DEFAULT_MODEL_NAMESPACE, "model"])
                .unwrap(),
            credential: BackedUpValue::default(),
        };
        let managed = String::from_utf8(
            apply_settings_text("unrelated: keep\n", "http://127.0.0.1:18640/v1", false, None).unwrap(),
        )
        .unwrap();
        let restored =
            String::from_utf8(restore_settings_text(&managed, &snapshot).unwrap()).unwrap();
        assert!(restored.contains("unrelated: keep"));
        let parsed: serde_yaml::Value = serde_yaml::from_str(&restored).unwrap();
        assert_eq!(
            yaml_at(&parsed, &[DEFAULT_MODEL_NAMESPACE, "provider"])
                .and_then(serde_yaml::Value::as_str),
            Some("other")
        );
        assert_eq!(
            yaml_at(
                &parsed,
                &[LLM_NAMESPACE, "providers", PROVIDER_ID, "baseURL"]
            )
            .and_then(serde_yaml::Value::as_str),
            Some("https://old.example/v1")
        );
    }

    #[test]
    fn refuses_inline_parent_instead_of_rewriting_or_duplicating_it() {
        let error = apply_settings_text(
            "llm-pi-ai: { providers: { other: { baseURL: https://other.example/v1 } } }\n",
            "http://127.0.0.1:18640/v1",
            false,
            None,
        )
        .unwrap_err();
        assert!(error.contains("行内或复杂 YAML"));
    }

    #[test]
    fn updates_quoted_managed_key_without_adding_a_duplicate() {
        let before =
            "llm-pi-ai:\n  providers:\n    'flowlet':\n      baseURL: https://old.example/v1\n";
        let output =
            String::from_utf8(apply_settings_text(before, "http://127.0.0.1:18640/v1", false, None).unwrap())
                .unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&output).unwrap();
        assert_eq!(
            yaml_at(
                &parsed,
                &[LLM_NAMESPACE, "providers", PROVIDER_ID, "baseURL"]
            )
            .and_then(serde_yaml::Value::as_str),
            Some("http://127.0.0.1:18640/v1")
        );
        assert_eq!(output.matches("flowlet:").count(), 1);
    }

    #[test]
    fn session_bridge_patch_preserves_user_plugins_and_is_idempotent() {
        let before = "# user plugin\n- insert:\n    - id: custom\n      name: custom-package\n";
        let once =
            String::from_utf8(patch_session_bridge(before, "http://127.0.0.1:18640/v1/").unwrap())
                .unwrap();
        assert!(once.contains("id: custom"));
        assert!(once.contains("id: flowlet-session-bridge"));
        assert!(once.contains("baseURL: http://127.0.0.1:18640/v1"));
        assert_eq!(once.matches(SESSION_BRIDGE_START).count(), 1);

        let twice =
            String::from_utf8(patch_session_bridge(&once, "http://127.0.0.1:28640/v1").unwrap())
                .unwrap();
        assert!(twice.contains("id: custom"));
        assert!(twice.contains("baseURL: http://127.0.0.1:28640/v1"));
        assert!(!twice.contains("baseURL: http://127.0.0.1:18640/v1"));
        assert_eq!(twice.matches(SESSION_BRIDGE_START).count(), 1);
    }

    #[test]
    fn session_bridge_patch_replaces_scaffolded_empty_array_document() {
        let before = "# user patch layer\n# keep this comment\n[]\n";
        let output =
            String::from_utf8(patch_session_bridge(before, "http://127.0.0.1:18640/v1").unwrap())
                .unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&output).unwrap();
        assert!(parsed
            .as_sequence()
            .is_some_and(|entries| entries.len() == 1));
        assert!(output.contains("# keep this comment"));
        assert!(!output.lines().any(|line| line.trim() == "[]"));
    }

    fn assert_versioned_credentials(text: &str, flowlet_token: Option<&str>) {
        let parsed: serde_yaml::Value = serde_yaml::from_str(text).unwrap();
        assert_eq!(
            parsed.get("version").and_then(serde_yaml::Value::as_i64),
            Some(1)
        );
        assert!(parsed
            .get(CREDENTIAL_REFS)
            .is_some_and(serde_yaml::Value::is_mapping));
        assert!(
            parsed.get(TOKEN_REF).is_none(),
            "凭据不能落在新版文档根节点"
        );
        assert_eq!(
            yaml_at(&parsed, &[CREDENTIAL_REFS, TOKEN_REF])
                .and_then(serde_yaml::Value::as_str),
            flowlet_token
        );
        assert_eq!(
            yaml_at(&parsed, &[CREDENTIAL_REFS, "EXISTING_TOKEN"])
                .and_then(serde_yaml::Value::as_str),
            Some("keep-me")
        );
    }

    #[test]
    fn repairs_mixed_versioned_credentials_created_by_legacy_flowlet_writer() {
        let before = "version: 1\nrefs:\n  EXISTING_TOKEN: keep-me\nFLOWLET_CLIENT_TOKEN: stale-token\n";
        let applied =
            String::from_utf8(apply_credentials_text(before, "fresh-token").unwrap()).unwrap();
        assert_versioned_credentials(&applied, Some("fresh-token"));

        let restored = String::from_utf8(
            restore_credentials_text(
                &applied,
                &ManagedSnapshot {
                    provider: BackedUpValue::default(),
                    default_provider: BackedUpValue::default(),
                    default_model: BackedUpValue::default(),
                    credential: BackedUpValue::default(),
                },
            )
            .unwrap(),
        )
        .unwrap();
        assert_versioned_credentials(&restored, None);
    }

    #[test]
    fn real_upstream_profile_fixture_passes_apply_reapply_disable_restore_contract() {
        const UPSTREAM_PATCH: &str =
            include_str!("../../../../tests/fixtures/deepseek-harness/web/cordis.patch.yml");
        const UPSTREAM_CREDENTIALS: &str =
            include_str!("../../../../tests/fixtures/deepseek-harness/credentials.v1.yaml");
        let home = std::env::temp_dir().join(format!(
            "flowlet-dsh-global-config-contract-{}",
            uuid::Uuid::new_v4()
        ));
        let profile = home.join("profiles").join("web");
        std::fs::create_dir_all(&profile).unwrap();
        let settings = "# keep user settings\nllm-pi-ai:\n  providers:\n    existing:\n      baseURL: https://example.com/v1\nagent-default-model:\n  provider: existing\n  model: existing-model\n";
        let credentials = UPSTREAM_CREDENTIALS;
        std::fs::write(home.join("settings.yaml"), settings).unwrap();
        std::fs::write(home.join(".credentials.yaml"), credentials).unwrap();
        std::fs::write(
            profile.join("package.json"),
            r#"{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}"#,
        )
        .unwrap();
        std::fs::write(profile.join("cordis.patch.yml"), UPSTREAM_PATCH).unwrap();

        let inspected = inspect_dsh_at(&home, "http://127.0.0.1:18640/v1").unwrap();
        assert_eq!(inspected.state, AgentGlobalConfigState::NotConfigured);
        assert_versioned_credentials(credentials, None);

        let report = apply_dsh_at(
            &home,
            "http://127.0.0.1:18640/v1",
            "flowlet-client-token",
            true,
            false,
            false,
        )
        .unwrap();
        assert_eq!(report.state, AgentGlobalConfigState::Flowlet);
        assert!(report.session_extension);
        assert!(!report.model_specs);
        assert_versioned_credentials(
            &std::fs::read_to_string(home.join(".credentials.yaml")).unwrap(),
            Some("flowlet-client-token"),
        );
        let managed_patch = std::fs::read_to_string(profile.join("cordis.patch.yml")).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&managed_patch).unwrap();
        assert!(parsed
            .as_sequence()
            .is_some_and(|entries| entries.len() == 1));
        assert!(profile
            .join(SESSION_BRIDGE_DIR)
            .join(SESSION_BRIDGE_FILE)
            .is_file());

        apply_dsh_at(
            &home,
            "http://127.0.0.1:18640/v1",
            "flowlet-client-token",
            true,
            false,
            false,
        )
        .unwrap();
        assert_versioned_credentials(
            &std::fs::read_to_string(home.join(".credentials.yaml")).unwrap(),
            Some("flowlet-client-token"),
        );
        assert_eq!(
            std::fs::read_to_string(profile.join("cordis.patch.yml")).unwrap(),
            managed_patch,
            "reapply must be idempotent"
        );

        let disabled = apply_dsh_at(
            &home,
            "http://127.0.0.1:18640/v1",
            "flowlet-client-token",
            false,
            false,
            false,
        )
        .unwrap();
        assert!(!disabled.session_extension);
        assert_versioned_credentials(
            &std::fs::read_to_string(home.join(".credentials.yaml")).unwrap(),
            Some("flowlet-client-token"),
        );
        let disabled_patch = std::fs::read_to_string(profile.join("cordis.patch.yml")).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&disabled_patch).unwrap();
        assert!(parsed.as_sequence().is_some_and(Vec::is_empty));
        assert!(!profile
            .join(SESSION_BRIDGE_DIR)
            .join(SESSION_BRIDGE_FILE)
            .is_file());

        let restored = restore_dsh_at(&home, "http://127.0.0.1:18640/v1").unwrap();
        assert_eq!(restored.state, AgentGlobalConfigState::NotConfigured);
        assert_eq!(
            std::fs::read_to_string(home.join("settings.yaml")).unwrap(),
            settings
        );
        assert_eq!(
            std::fs::read_to_string(home.join(".credentials.yaml")).unwrap(),
            credentials
        );
        assert_versioned_credentials(credentials, None);
        assert_eq!(
            std::fs::read_to_string(profile.join("cordis.patch.yml")).unwrap(),
            UPSTREAM_PATCH
        );
        assert!(!backup_path(&home).exists());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn real_upstream_approval_bridge_passes_apply_reapply_disable_restore_contract() {
        const UPSTREAM_PATCH: &str =
            include_str!("../../../../tests/fixtures/deepseek-harness/web/cordis.patch.yml");
        let home = std::env::temp_dir().join(format!(
            "flowlet-dsh-approval-bridge-contract-{}",
            uuid::Uuid::new_v4()
        ));
        let profile = home.join("profiles").join("web");
        std::fs::create_dir_all(&profile).unwrap();
        let settings = "# keep user settings\nllm-pi-ai:\n  providers:\n    existing:\n      baseURL: https://example.com/v1\nagent-default-model:\n  provider: existing\n  model: existing-model\n";
        let credentials = "# keep user credentials\nEXISTING_TOKEN: keep-me\n";
        std::fs::write(home.join("settings.yaml"), settings).unwrap();
        std::fs::write(home.join(".credentials.yaml"), credentials).unwrap();
        std::fs::write(
            profile.join("package.json"),
            r#"{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}"#,
        )
        .unwrap();
        std::fs::write(profile.join("cordis.patch.yml"), UPSTREAM_PATCH).unwrap();

        // apply：同时启用精确会话关联与交互确认桥。
        let report = apply_dsh_at(
            &home,
            "http://127.0.0.1:18640/v1",
            "flowlet-client-token",
            true,
            false,
            true,
        )
        .unwrap();
        assert_eq!(report.state, AgentGlobalConfigState::Flowlet);
        assert!(report.session_extension);
        assert!(report.approval_bridge, "apply 后 report 必须报告确认桥在位");
        let plugin = approval_plugin_path(&profile);
        assert!(plugin.is_file());
        // 部署文件由 text_file_bytes 补尾换行（源文件不以 \n 结尾），
        // 容错比较仍必须识别为受管文件（回归：曾因精确 == 比较导致 toggle 恒为关闭）。
        assert!(profile_approval_bridge_matches(&profile));
        let deployed = std::fs::read_to_string(&plugin).unwrap();
        assert!(
            deployed == APPROVAL_BRIDGE_SOURCE
                || deployed == format!("{}\n", APPROVAL_BRIDGE_SOURCE),
            "部署文件要么与源一致、要么只多一个尾换行"
        );
        let managed_patch = std::fs::read_to_string(profile.join("cordis.patch.yml")).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&managed_patch).unwrap();
        assert!(parsed
            .as_sequence()
            .is_some_and(|entries| entries.len() == 2));

        // reapply：幂等，patch 与插件文件均不变。
        apply_dsh_at(
            &home,
            "http://127.0.0.1:18640/v1",
            "flowlet-client-token",
            true,
            false,
            true,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(profile.join("cordis.patch.yml")).unwrap(),
            managed_patch,
            "reapply must be idempotent"
        );
        assert!(profile_approval_bridge_matches(&profile));

        // disable：只关确认桥、保留会话桥，插件文件移除、patch 标记清除。
        let disabled = apply_dsh_at(
            &home,
            "http://127.0.0.1:18640/v1",
            "flowlet-client-token",
            true,
            false,
            false,
        )
        .unwrap();
        assert!(!disabled.approval_bridge);
        assert!(disabled.session_extension);
        assert!(!profile_approval_bridge_matches(&profile));
        assert!(!plugin.exists(), "关闭后受管确认桥插件文件应被移除");
        let disabled_patch = std::fs::read_to_string(profile.join("cordis.patch.yml")).unwrap();
        assert!(!disabled_patch.contains(APPROVAL_BRIDGE_START));

        // restore：恢复原始 patch 与受管文件。
        let restored = restore_dsh_at(&home, "http://127.0.0.1:18640/v1").unwrap();
        assert_eq!(restored.state, AgentGlobalConfigState::NotConfigured);
        assert_eq!(
            std::fs::read_to_string(profile.join("cordis.patch.yml")).unwrap(),
            UPSTREAM_PATCH
        );
        assert_eq!(
            std::fs::read_to_string(home.join("settings.yaml")).unwrap(),
            settings
        );
        assert_eq!(
            std::fs::read_to_string(home.join(".credentials.yaml")).unwrap(),
            credentials
        );
        assert!(!backup_path(&home).exists());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn real_upstream_fixture_model_specs_passes_apply_disable_restore_contract() {
        const UPSTREAM_PATCH: &str =
            include_str!("../../../../tests/fixtures/deepseek-harness/web/cordis.patch.yml");
        let home = std::env::temp_dir().join(format!(
            "flowlet-dsh-model-specs-contract-{}",
            uuid::Uuid::new_v4()
        ));
        let settings = "# keep user settings\nllm-pi-ai:\n  providers:\n    existing:\n      baseURL: https://example.com/v1\nagent-default-model:\n  provider: existing\n  model: existing-model\n";
        let credentials = "# keep user credentials\nEXISTING_TOKEN: keep-me\n";
        std::fs::create_dir_all(home.join("profiles").join("web")).unwrap();
        std::fs::write(home.join("settings.yaml"), settings).unwrap();
        std::fs::write(home.join(".credentials.yaml"), credentials).unwrap();
        std::fs::write(
            home.join("profiles").join("web").join("cordis.patch.yml"),
            UPSTREAM_PATCH,
        )
        .unwrap();

        let model_inputs = std::collections::BTreeMap::from([
            (
                "flowlet-pro".to_string(),
                vec!["text".to_string(), "image".to_string()],
            ),
            ("flowlet-flash".to_string(), vec!["text".to_string()]),
        ]);

        let report = apply_dsh_at_with_inputs(
            &home,
            "http://127.0.0.1:18640/v1",
            "flowlet-client-token",
            false,
            true,
            false,
            Some(&model_inputs),
            None,
        )
        .unwrap();
        assert_eq!(report.state, AgentGlobalConfigState::Flowlet);
        assert!(report.model_specs);
        assert!(!report.session_extension);
        let managed = std::fs::read_to_string(home.join("settings.yaml")).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&managed).unwrap();
        let models = yaml_at(
            &parsed,
            &[LLM_NAMESPACE, "providers", PROVIDER_ID, "models"],
        )
        .and_then(serde_yaml::Value::as_sequence)
        .unwrap();
        assert_eq!(models.len(), 2);
        for entry in models {
            assert_eq!(
                entry["contextWindow"].as_i64(),
                Some(1_048_576),
                "每个聚合模型条目都应声明 1M 上下文窗口：{entry:?}"
            );
        }
        assert_eq!(models[0]["input"], serde_yaml::to_value(["text", "image"]).unwrap());
        assert_eq!(models[1]["input"], serde_yaml::to_value(["text"]).unwrap());
        // 非受管 Provider 原样保留。
        assert_eq!(
            yaml_at(
                &parsed,
                &[LLM_NAMESPACE, "providers", "existing", "baseURL"]
            )
            .and_then(serde_yaml::Value::as_str),
            Some("https://example.com/v1")
        );

        let reapplied = apply_dsh_at_with_inputs(
            &home,
            "http://127.0.0.1:18640/v1",
            "flowlet-client-token",
            false,
            true,
            false,
            Some(&model_inputs),
            None,
        )
        .unwrap();
        assert!(reapplied.model_specs, "reapply must preserve model specs");

        let disabled = apply_dsh_at(
            &home,
            "http://127.0.0.1:18640/v1",
            "flowlet-client-token",
            false,
            false,
            false,
        )
        .unwrap();
        assert!(!disabled.model_specs, "disable must clear model specs");
        let disabled_text = std::fs::read_to_string(home.join("settings.yaml")).unwrap();
        let reparsed: serde_yaml::Value = serde_yaml::from_str(&disabled_text).unwrap();
        let disabled_models = yaml_at(
            &reparsed,
            &[LLM_NAMESPACE, "providers", PROVIDER_ID, "models"],
        )
        .and_then(serde_yaml::Value::as_sequence)
        .unwrap();
        for entry in disabled_models {
            assert!(
                entry.get("contextWindow").is_none(),
                "关闭后模型条目不应残留 contextWindow：{entry:?}"
            );
            assert!(
                entry.get("input").is_none(),
                "关闭后模型条目不应残留 input：{entry:?}"
            );
        }

        let restored = restore_dsh_at(&home, "http://127.0.0.1:18640/v1").unwrap();
        assert_eq!(restored.state, AgentGlobalConfigState::NotConfigured);
        assert!(!restored.model_specs);
        assert_eq!(
            std::fs::read_to_string(home.join("settings.yaml")).unwrap(),
            settings
        );
        assert_eq!(
            std::fs::read_to_string(home.join(".credentials.yaml")).unwrap(),
            credentials
        );
        assert!(!backup_path(&home).exists());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn session_bridge_patch_repairs_the_previous_empty_array_plus_managed_block() {
        let broken = format!(
            "# user patch layer\n[]\n\n{}",
            session_bridge_block("http://127.0.0.1:18640/v1")
        );
        let output =
            String::from_utf8(patch_session_bridge(&broken, "http://127.0.0.1:28640/v1").unwrap())
                .unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&output).unwrap();
        assert!(parsed
            .as_sequence()
            .is_some_and(|entries| entries.len() == 1));
        assert!(output.contains("baseURL: http://127.0.0.1:28640/v1"));
        assert_eq!(output.matches(SESSION_BRIDGE_START).count(), 1);
    }

    #[test]
    fn session_bridge_patch_refuses_nonempty_flow_style_array() {
        let error =
            patch_session_bridge("[{ id: custom }]\n", "http://127.0.0.1:18640/v1").unwrap_err();
        assert!(error.contains("行内数组"));
    }

    #[test]
    fn session_bridge_patch_refuses_broken_managed_markers() {
        let error =
            patch_session_bridge(SESSION_BRIDGE_START, "http://127.0.0.1:18640/v1").unwrap_err();
        assert!(error.contains("标记不完整"));
    }

    #[test]
    fn session_bridge_patch_preserves_crlf() {
        let output = patch_session_bridge(
            "# user\r\n- insert:\r\n    - id: custom\r\n",
            "http://127.0.0.1:18640/v1",
        )
        .unwrap();
        let output = String::from_utf8(output).unwrap();
        assert!(output.contains("\r\n"));
        assert!(!output.replace("\r\n", "").contains('\n'));
    }

    #[test]
    fn session_bridge_removal_preserves_user_plugins_and_is_idempotent() {
        let before = "# user plugin\n- insert:\n    - id: custom\n      name: custom-package\n";
        let managed =
            String::from_utf8(patch_session_bridge(before, "http://127.0.0.1:18640/v1").unwrap())
                .unwrap();
        let once = String::from_utf8(remove_session_bridge(&managed).unwrap()).unwrap();
        assert!(once.contains("id: custom"));
        assert!(!once.contains(SESSION_BRIDGE_START));
        assert!(!once.contains("flowlet-session-bridge"));

        let twice = String::from_utf8(remove_session_bridge(&once).unwrap()).unwrap();
        assert_eq!(twice, once);
    }

    #[test]
    fn session_bridge_removal_restores_an_empty_array_document() {
        let managed = String::from_utf8(
            patch_session_bridge("# user patch layer\n[]\n", "http://127.0.0.1:18640/v1").unwrap(),
        )
        .unwrap();
        let removed = String::from_utf8(remove_session_bridge(&managed).unwrap()).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&removed).unwrap();
        assert!(
            parsed.as_sequence().is_some_and(Vec::is_empty),
            "removed patch was: {removed:?}"
        );
        assert!(removed.contains("# user patch layer"));
        assert!(removed.lines().any(|line| line.trim() == "[]"));
    }

    #[test]
    fn session_bridge_removal_refuses_broken_managed_markers() {
        let error = remove_session_bridge(SESSION_BRIDGE_END).unwrap_err();
        assert!(error.contains("标记不完整"));
    }

    #[test]
    fn only_profiles_with_the_base_bundle_receive_the_bridge() {
        let root =
            std::env::temp_dir().join(format!("flowlet-dsh-profile-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("package.json"),
            r#"{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","custom"]}}}"#,
        )
        .unwrap();
        assert!(profile_uses_base_bundle(&root));
        std::fs::write(
            root.join("package.json"),
            r#"{"dsh":{"profile":{"bundles":["custom"]}}}"#,
        )
        .unwrap();
        assert!(!profile_uses_base_bundle(&root));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn old_backup_without_profiles_remains_readable() {
        let backup: DshConfigBackup = serde_json::from_value(json!({
            "version": 1,
            "agent_id": "deepseek-harness",
            "provider": { "present": false, "value": null },
            "default_provider": { "present": false, "value": null },
            "default_model": { "present": false, "value": null },
            "credential": { "present": false, "value": null }
        }))
        .unwrap();
        assert!(backup.profiles.is_empty());
    }

    fn mcp_chrome(args: &[&str]) -> McpServerSpec {
        McpServerSpec {
            id: "chrome".to_string(),
            server_name: "chrome".to_string(),
            transport: "stdio".to_string(),
            command: Some("npx".to_string()),
            args: Some(args.iter().map(|arg| arg.to_string()).collect()),
            ..McpServerSpec::default()
        }
    }

    fn mcp_web_api() -> McpServerSpec {
        McpServerSpec {
            id: "webapi".to_string(),
            server_name: "webapi".to_string(),
            transport: "streamable-http".to_string(),
            url: Some("http://127.0.0.1:9222/mcp".to_string()),
            headers: Some(
                [("Authorization".to_string(), "Bearer secret token".to_string())]
                    .into_iter()
                    .collect(),
            ),
            ..McpServerSpec::default()
        }
    }

    #[test]
    fn mcp_servers_block_round_trips_stdio_and_http_specs() {
        let servers = vec![
            mcp_chrome(&["-y", "chrome-devtools-mcp@latest", "--headless"]),
            mcp_web_api(),
        ];
        let text = mcp_servers_block(&servers);
        assert!(text.starts_with(MCP_SERVERS_START));
        assert!(text.ends_with(MCP_SERVERS_END));
        assert_eq!(text.matches("- insert:").count(), 2);
        assert!(text.contains("name: '@deepseek-ai/dsh-mcp-client'"));
        assert!(
            text.contains("args: ['-y', chrome-devtools-mcp@latest, '--headless']"),
            "actual block:\n{text}"
        );
        assert!(text.contains("Authorization: 'Bearer secret token'"));
        // 生成文本必须是合法 YAML，且能无损解析回原列表。
        let parsed = parse_mcp_servers(&text).unwrap();
        assert_eq!(parsed, servers);
    }

    #[test]
    fn yaml_quote_quotes_ambiguous_scalars_only() {
        assert_eq!(yaml_quote("npx"), "npx");
        assert_eq!(yaml_quote("--headless"), "'--headless'");
        assert_eq!(
            yaml_quote("C:\\Program Files\\node\\npx.cmd"),
            "'C:\\Program Files\\node\\npx.cmd'"
        );
        assert_eq!(yaml_quote("@modelcontextprotocol/server-github"), "'@modelcontextprotocol/server-github'");
        assert_eq!(yaml_quote("true"), "'true'");
        assert_eq!(yaml_quote("42"), "'42'");
        assert_eq!(yaml_quote("it's"), "'it''s'");
        assert_eq!(yaml_quote("a: b"), "'a: b'");
    }

    #[test]
    fn mcp_patch_preserves_user_plugins_and_is_idempotent() {
        let before = "# user plugin\n- insert:\n    - id: custom\n      name: custom-package\n";
        let once =
            String::from_utf8(patch_mcp_servers(before, &[mcp_chrome(&["-y", "x@1"])]).unwrap())
                .unwrap();
        assert!(once.contains("id: custom"));
        assert!(once.contains("serverName: chrome"));
        assert_eq!(once.matches(MCP_SERVERS_START).count(), 1);

        // 修改列表：整块替换，不留旧条目。
        let twice = String::from_utf8(
            patch_mcp_servers(&once, &[mcp_chrome(&["-y", "x@2"]), mcp_web_api()]).unwrap(),
        )
        .unwrap();
        assert_eq!(twice.matches(MCP_SERVERS_START).count(), 1);
        assert!(!twice.contains("x@1"));
        let parsed = parse_mcp_servers(&twice).unwrap();
        assert_eq!(parsed.len(), 2);
        assert!(twice.contains("id: custom"), "用户插件必须保留");

        // 幂等：同一列表重复写入不改变文本。
        let thrice = String::from_utf8(
            patch_mcp_servers(&twice, &[mcp_chrome(&["-y", "x@2"]), mcp_web_api()]).unwrap(),
        )
        .unwrap();
        assert_eq!(thrice, twice);
    }

    #[test]
    fn mcp_patch_replaces_scaffolded_empty_array_document() {
        let before = "# user patch layer\n# keep this comment\n[]\n";
        let output = String::from_utf8(
            patch_mcp_servers(before, &[mcp_chrome(&["-y", "chrome-devtools-mcp@latest"])])
                .unwrap(),
        )
        .unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&output).unwrap();
        assert!(parsed
            .as_sequence()
            .is_some_and(|entries| entries.len() == 1));
        assert!(output.contains("# keep this comment"));
        assert!(!output.lines().any(|line| line.trim() == "[]"));

        // 移除后回退为合法的空数组文档。
        let removed =
            String::from_utf8(remove_mcp_servers(&output).unwrap()).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&removed).unwrap();
        assert!(parsed.as_sequence().is_some_and(Vec::is_empty));
        assert!(removed.contains("# keep this comment"));
        assert!(removed.lines().any(|line| line.trim() == "[]"));
        let twice = String::from_utf8(remove_mcp_servers(&removed).unwrap()).unwrap();
        assert_eq!(twice, removed);
    }

    #[test]
    fn mcp_patch_and_parse_refuse_broken_managed_markers() {
        let error =
            patch_mcp_servers(MCP_SERVERS_START, &[mcp_chrome(&["-y", "x"])]).unwrap_err();
        assert!(error.contains("标记不完整"));
        let parse_error = parse_mcp_servers(MCP_SERVERS_START).unwrap_err();
        assert!(parse_error.contains("标记不完整"));
        let remove_error = remove_mcp_servers(MCP_SERVERS_END).unwrap_err();
        assert!(remove_error.contains("标记不完整"));
    }

    #[test]
    fn mcp_patch_preserves_crlf() {
        let output = String::from_utf8(
            patch_mcp_servers(
                "# user\r\n- insert:\r\n    - id: custom\r\n",
                &[mcp_chrome(&["-y", "chrome-devtools-mcp@latest"])],
            )
            .unwrap(),
        )
        .unwrap();
        assert!(output.contains("\r\n"));
        assert!(!output.replace("\r\n", "").contains('\n'));
    }

    #[test]
    fn mcp_validate_rejects_bad_specs() {
        validate_mcp_servers(&[mcp_chrome(&["-y", "x"]), mcp_web_api()]).unwrap();

        let long_name = "a".repeat(33);
        for (label, server) in [
            ("bad-id", McpServerSpec { id: "has space".to_string(), ..mcp_chrome(&[]) }),
            ("long-name", McpServerSpec { server_name: long_name, ..mcp_chrome(&[]) }),
            ("no-command", McpServerSpec { command: None, ..mcp_chrome(&[]) }),
            ("empty-command", McpServerSpec { command: Some(String::new()), ..mcp_chrome(&[]) }),
            ("bad-transport", McpServerSpec { transport: "websocket".to_string(), ..mcp_chrome(&[]) }),
            ("http-without-url", McpServerSpec { url: None, ..mcp_web_api() }),
        ] {
            let error = validate_mcp_servers(std::slice::from_ref(&server)).unwrap_err();
            assert!(!error.is_empty(), "{label} 应当被拒绝");
        }
        // 同列表内 serverName 重复（不同 id）必须拒绝。
        let duplicated = vec![
            mcp_chrome(&[]),
            McpServerSpec { id: "alias".to_string(), ..mcp_chrome(&[]) },
        ];
        assert!(validate_mcp_servers(&duplicated).is_err());
    }

    #[test]
    fn mcp_apply_requires_an_initialized_profile_for_nonempty_lists() {
        let home =
            std::env::temp_dir().join(format!("flowlet-dsh-mcp-noprofile-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("settings.yaml"), "unrelated: keep\n").unwrap();
        std::fs::write(home.join(".credentials.yaml"), "EXISTING_TOKEN: keep-me\n").unwrap();

        let servers = [mcp_chrome(&["-y", "chrome-devtools-mcp@latest"])];
        let error = apply_dsh_at_with_inputs(
            &home,
            "http://127.0.0.1:18640/v1",
            "token",
            false,
            false,
            false,
            None,
            Some(&servers),
        )
        .unwrap_err();
        assert!(error.contains("尚未发现可部署 MCP 服务器的 DSH Profile"));

        // 空列表只是移除受管块，不应因没有 Profile 而失败。
        apply_dsh_at_with_inputs(
            &home,
            "http://127.0.0.1:18640/v1",
            "token",
            false,
            false,
            false,
            None,
            Some(&[]),
        )
        .unwrap();
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn real_upstream_fixture_mcp_servers_passes_apply_reapply_disable_restore_contract() {
        const UPSTREAM_PATCH: &str =
            include_str!("../../../../tests/fixtures/deepseek-harness/web/cordis.patch.yml");
        let home = std::env::temp_dir().join(format!(
            "flowlet-dsh-mcp-servers-contract-{}",
            uuid::Uuid::new_v4()
        ));
        let profile = home.join("profiles").join("web");
        std::fs::create_dir_all(&profile).unwrap();
        let settings = "# keep user settings\nllm-pi-ai:\n  providers:\n    existing:\n      baseURL: https://example.com/v1\nagent-default-model:\n  provider: existing\n  model: existing-model\n";
        let credentials = "# keep user credentials\nEXISTING_TOKEN: keep-me\n";
        std::fs::write(home.join("settings.yaml"), settings).unwrap();
        std::fs::write(home.join(".credentials.yaml"), credentials).unwrap();
        std::fs::write(
            profile.join("package.json"),
            r#"{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}"#,
        )
        .unwrap();
        std::fs::write(profile.join("cordis.patch.yml"), UPSTREAM_PATCH).unwrap();

        let inspected = inspect_dsh_at(&home, "http://127.0.0.1:18640/v1").unwrap();
        assert!(inspected.mcp_servers.is_empty());

        // apply：同时部署会话桥与两个 MCP 服务器（stdio + streamable-http）。
        let servers = vec![
            mcp_chrome(&["-y", "chrome-devtools-mcp@latest", "--headless", "--isolated"]),
            mcp_web_api(),
        ];
        let report = apply_dsh_at_with_inputs(
            &home,
            "http://127.0.0.1:18640/v1",
            "flowlet-client-token",
            true,
            false,
            true,
            None,
            Some(&servers),
        )
        .unwrap();
        assert_eq!(report.state, AgentGlobalConfigState::Flowlet);
        assert_eq!(report.mcp_servers, servers);
        assert!(report.session_extension);
        assert!(report.approval_bridge);

        let managed_patch = std::fs::read_to_string(profile.join("cordis.patch.yml")).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&managed_patch).unwrap();
        let entries = parsed.as_sequence().unwrap();
        let mcp_entries = entries
            .iter()
            .filter(|entry| {
                entry
                    .get("insert")
                    .and_then(|insert| insert.get(0))
                    .and_then(|plugin| plugin.get("name"))
                    .and_then(serde_yaml::Value::as_str)
                    == Some("@deepseek-ai/dsh-mcp-client")
            })
            .count();
        assert_eq!(mcp_entries, 2, "每个服务器一个 dsh-mcp-client 插件实例");
        // 受管块必须能重新解析回完整规格。
        assert_eq!(parse_mcp_servers(&managed_patch).unwrap(), servers);

        // reapply：幂等。
        apply_dsh_at_with_inputs(
            &home,
            "http://127.0.0.1:18640/v1",
            "flowlet-client-token",
            true,
            false,
            true,
            None,
            Some(&servers),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(profile.join("cordis.patch.yml")).unwrap(),
            managed_patch,
            "reapply must be idempotent"
        );

        // disable：Some(空) 只移除 MCP 块，保留会话桥与确认桥。
        let disabled = apply_dsh_at_with_inputs(
            &home,
            "http://127.0.0.1:18640/v1",
            "flowlet-client-token",
            true,
            false,
            true,
            None,
            Some(&[]),
        )
        .unwrap();
        assert!(disabled.mcp_servers.is_empty());
        assert!(disabled.session_extension);
        assert!(disabled.approval_bridge);
        let disabled_patch = std::fs::read_to_string(profile.join("cordis.patch.yml")).unwrap();
        assert!(!disabled_patch.contains(MCP_SERVERS_START));
        assert!(!disabled_patch.contains("dsh-mcp-client"));
        assert!(disabled_patch.contains(SESSION_BRIDGE_START));
        assert!(disabled_patch.contains(APPROVAL_BRIDGE_START));

        // restore：恢复原始 patch（逐字节），备份删除。
        let restored = restore_dsh_at(&home, "http://127.0.0.1:18640/v1").unwrap();
        assert_eq!(restored.state, AgentGlobalConfigState::NotConfigured);
        assert_eq!(
            std::fs::read_to_string(profile.join("cordis.patch.yml")).unwrap(),
            UPSTREAM_PATCH
        );
        assert_eq!(
            std::fs::read_to_string(home.join("settings.yaml")).unwrap(),
            settings
        );
        assert_eq!(
            std::fs::read_to_string(home.join(".credentials.yaml")).unwrap(),
            credentials
        );
        assert!(!backup_path(&home).exists());
        std::fs::remove_dir_all(home).unwrap();
    }
}
