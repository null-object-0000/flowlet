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
const LLM_NAMESPACE: &str = "llm-pi-ai";
const DEFAULT_MODEL_NAMESPACE: &str = "agent-default-model";
const LOCK_TIMEOUT: Duration = Duration::from_secs(2);
const SESSION_BRIDGE_SOURCE: &str =
    include_str!("../../../../resources/agent-plugins/deepseek-harness/flowlet-session-bridge.mjs");
const SESSION_BRIDGE_DIR: &str = ".flowlet";
const SESSION_BRIDGE_FILE: &str = "flowlet-session-bridge.mjs";
const SESSION_BRIDGE_START: &str = "# flowlet-managed:start deepseek-harness-session-bridge";
const SESSION_BRIDGE_END: &str = "# flowlet-managed:end deepseek-harness-session-bridge";

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
    plugin.is_file()
        && std::fs::read_to_string(&plugin).ok().as_deref() == Some(SESSION_BRIDGE_SOURCE)
        && std::fs::read_to_string(patch).ok().is_some_and(|text| {
            text.contains(SESSION_BRIDGE_START)
                && text.contains(SESSION_BRIDGE_END)
                && text.contains(&format!("baseURL: {}", normalize_url(expected_base_url)))
        })
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

fn read_yaml_text(path: &Path) -> Result<String, String> {
    if !path.is_file() {
        return Ok(String::new());
    }
    std::fs::read_to_string(path).map_err(|error| format!("读取 {} 失败：{error}", path.display()))
}

fn read_yaml_value(path: &Path) -> Result<serde_yaml::Value, String> {
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
    Ok(yaml_at(&read_yaml_value(path)?, &[TOKEN_REF])
        .and_then(serde_yaml::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string))
}

fn yaml_at<'a>(root: &'a serde_yaml::Value, path: &[&str]) -> Option<&'a serde_yaml::Value> {
    let mut current = Some(root);
    for segment in path {
        current = current.and_then(|value| value.get(*segment));
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
        credential: backed_up_yaml_value(&credentials, &[TOKEN_REF])?,
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

fn patch_yaml_entry(
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

fn provider_profile(expected_base_url: &str) -> Value {
    json!({
        "displayName": "Flowlet",
        "apiKeyEnv": TOKEN_REF,
        "api": "openai-completions",
        "baseURL": normalize_url(expected_base_url),
        "models": [{ "id": "flowlet-pro" }, { "id": "flowlet-flash" }],
    })
}

fn apply_settings_text(text: &str, expected_base_url: &str) -> Result<Vec<u8>, String> {
    let provider = provider_profile(expected_base_url);
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
    patch_yaml_entry(text, ".credentials.yaml", &[], TOKEN_REF, Some(&token))
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
    patch_yaml_entry(text, ".credentials.yaml", &[], TOKEN_REF, credential)
}

fn apply_dsh(
    expected_base_url: &str,
    client_token: &str,
    session_extension: bool,
) -> Result<AgentGlobalConfigReport, String> {
    let home = dsh_home()?;
    apply_dsh_at(&home, expected_base_url, client_token, session_extension)
}

fn apply_dsh_at(
    home: &Path,
    expected_base_url: &str,
    client_token: &str,
    session_extension: bool,
) -> Result<AgentGlobalConfigReport, String> {
    let settings_path = home.join("settings.yaml");
    let credentials_path = home.join(".credentials.yaml");
    let backup = backup_path(&home);
    let _settings_lock = DshFileLock::acquire(&settings_path)?;
    let _credentials_lock = DshFileLock::acquire(&credentials_path)?;
    let settings_text = read_yaml_text(&settings_path)?;
    let credentials_text = read_yaml_text(&credentials_path)?;
    let current = capture_snapshot(&settings_path, &credentials_path)?;
    let settings_output = apply_settings_text(&settings_text, expected_base_url)?;
    let credentials_output = apply_credentials_text(&credentials_text, client_token)?;
    let profiles = dsh_profiles(&home)?;
    if session_extension && profiles.is_empty() {
        return Err(
            "尚未发现可安装 Flowlet 会话插件的 DSH Profile；请先启动一次 DeepSeek Harness，或关闭可选的精确会话关联"
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
        });
    }
    let mut writes = vec![
        (settings_path, Some(settings_output)),
        (credentials_path, Some(credentials_output)),
    ];
    for (profile, root) in &profiles {
        let (patch, plugin) = profile_paths(root);
        if session_extension {
            writes.push((
                patch.clone(),
                Some(patch_session_bridge(
                    &read_yaml_text(&patch)?,
                    expected_base_url,
                )?),
            ));
            writes.push((plugin, Some(text_file_bytes(SESSION_BRIDGE_SOURCE))));
        } else {
            if patch.is_file() {
                let patch_text = read_yaml_text(&patch)?;
                let patch_output = remove_session_bridge(&patch_text)?;
                if patch_output != patch_text.as_bytes() {
                    writes.push((patch.clone(), Some(patch_output)));
                }
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
            if std::fs::read_to_string(&plugin).ok().as_deref() == Some(SESSION_BRIDGE_SOURCE) {
                writes.push((plugin, previous_plugin));
            }
        }
    }
    write_json_file(
        &backup,
        &serde_json::to_value(&backup_value)
            .map_err(|error| format!("序列化 DSH 配置备份失败：{error}"))?,
    )?;
    if let Err(error) =
        write_files_transactionally("DeepSeek Harness 配置与 Flowlet 会话插件", &writes)
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
    }
    write_files_transactionally("DeepSeek Harness 配置与 Flowlet 会话插件", &writes)
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
            provider_profile("http://127.0.0.1:18640/v1/"),
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
    fn lossless_edit_preserves_unmanaged_yaml_and_comments() {
        let before = "# keep root\nui-theme:\n  mode: dark # keep inline\nllm-pi-ai:\n  providers:\n    other:\n      baseURL: https://other.example/v1\n";
        let output =
            String::from_utf8(apply_settings_text(before, "http://127.0.0.1:18640/v1").unwrap())
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
            apply_settings_text("unrelated: keep\n", "http://127.0.0.1:18640/v1").unwrap(),
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
        )
        .unwrap_err();
        assert!(error.contains("行内或复杂 YAML"));
    }

    #[test]
    fn updates_quoted_managed_key_without_adding_a_duplicate() {
        let before =
            "llm-pi-ai:\n  providers:\n    'flowlet':\n      baseURL: https://old.example/v1\n";
        let output =
            String::from_utf8(apply_settings_text(before, "http://127.0.0.1:18640/v1").unwrap())
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

    #[test]
    fn real_upstream_profile_fixture_passes_apply_reapply_disable_restore_contract() {
        const UPSTREAM_PATCH: &str =
            include_str!("../../../../tests/fixtures/deepseek-harness/web/cordis.patch.yml");
        let home = std::env::temp_dir().join(format!(
            "flowlet-dsh-global-config-contract-{}",
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

        let report = apply_dsh_at(
            &home,
            "http://127.0.0.1:18640/v1",
            "flowlet-client-token",
            true,
        )
        .unwrap();
        assert_eq!(report.state, AgentGlobalConfigState::Flowlet);
        assert!(report.session_extension);
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
        )
        .unwrap();
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
        )
        .unwrap();
        assert!(!disabled.session_extension);
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
        assert_eq!(
            std::fs::read_to_string(profile.join("cordis.patch.yml")).unwrap(),
            UPSTREAM_PATCH
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
}
