//! 自定义渠道资源用量抓取的文件夹发现机制。
//!
//! 设计目标（见 `docs/custom-scrape-discovery.md`）：让用户在本机一个指定文件夹里，
//! 按账号名放置一份**声明式描述符**，为 `custom` 渠道账号提供「后台 webview 登录
//! 控制台 → 拦截业务 API → 解析资源用量」的能力，而无需改动 `config.json` 或编译期
//! adapter。
//!
//! 安全边界：描述符是 typed JSON，不引入动态库加载、不引入任意脚本执行。仅有的脚本
//! `interceptor.js` / `extractor.js` 与内置渠道一样，只在 per-account 抓取 webview
//! 沙箱内注入，信任边界不变。描述符只从本地目录读取，不进 SQLite、不进设备同步。

use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

// ─── 反序列化层（manifest.json 原始结构）───────────────────────────────────

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawManifest {
    schema_version: u32,
    channel_id: String,
    #[serde(default)]
    account_name: Option<String>,
    #[serde(default)]
    fallback: bool,
    #[serde(default)]
    resource_modes: Vec<RawResourceMode>,
    #[serde(default)]
    login: Option<RawLogin>,
    modes: HashMap<String, RawMode>,
    #[serde(default)]
    summary: Option<RawSummary>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawResourceMode {
    resource_mode: String,
    mode_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum RawLogin {
    None,
    Generic,
    GenericOrHost { host: String },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMode {
    console_url: String,
    #[serde(default)]
    console_url_secondary: Option<String>,
    #[serde(default)]
    console_url_tertiary: Option<String>,
    #[serde(default)]
    aggregate: bool,
    #[serde(default)]
    required_slots: Vec<String>,
    #[serde(default)]
    slots: HashMap<String, RawSlot>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSlot {
    #[serde(default, rename = "match")]
    match_rule: Option<RawUrlMatcher>,
    #[serde(default)]
    satisfies: Option<RawSatisfies>,
    #[serde(default)]
    merge: Option<RawMerge>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum RawUrlMatcher {
    UrlSubstring {
        value: String,
        #[serde(default = "default_true")]
        case_insensitive: bool,
    },
    UrlPrefix {
        value: String,
    },
    UrlExact {
        value: String,
    },
    UrlRegex {
        pattern: String,
    },
    Fallback,
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
enum RawExpect {
    Present,
    Number,
    Boolean,
    String,
    Array,
    Object,
    NonEmptyString,
    PositiveNumber,
}

impl Default for RawExpect {
    fn default() -> Self {
        Self::Present
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum RawSatisfies {
    JsonValid,
    JsonPath {
        path: String,
        #[serde(default)]
        expect: RawExpect,
    },
    None,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum RawMerge {
    LastWriteWins,
    MergeArrays {
        path: String,
        #[serde(default)]
        dedup_by: Vec<String>,
        #[serde(default)]
        keep_fields: Vec<String>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSummary {
    #[serde(default)]
    plan: Option<String>,
}

// ─── 校验后的运行时类型 ─────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum UrlMatch {
    Substring {
        value: String,
        case_insensitive: bool,
    },
    Prefix {
        value: String,
    },
    Exact {
        value: String,
    },
    Regex(regex::Regex),
    Fallback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsonExpect {
    Present,
    Number,
    Boolean,
    String,
    Array,
    Object,
    NonEmptyString,
    PositiveNumber,
}

#[derive(Debug, Clone)]
pub enum SlotSatisfies {
    JsonValid,
    JsonPath { path: String, expect: JsonExpect },
    None,
}

#[derive(Debug, Clone)]
pub enum SlotMerge {
    LastWriteWins,
    MergeArrays {
        path: String,
        dedup_by: Vec<String>,
        keep_fields: Vec<String>,
    },
}

#[derive(Debug, Clone)]
pub struct SlotRule {
    pub key: String,
    /// `None` 表示 fallback：未命中任何显式 matcher 的响应归入此槽位。
    pub match_rule: Option<UrlMatch>,
    pub satisfies: SlotSatisfies,
    pub merge: SlotMerge,
}

#[derive(Debug, Clone)]
pub enum LoginKind {
    None,
    Generic,
    GenericOrHost { host: String },
}

#[derive(Debug, Clone)]
pub struct Summary {
    pub plan: Option<String>,
}

/// 一次解析成功的自定义抓取模式（交给 `scrape_console::ScrapeModeRuntime` 使用）。
#[derive(Debug, Clone)]
pub struct CustomScrapeResolved {
    pub console_url: String,
    pub console_url_secondary: Option<String>,
    pub console_url_tertiary: Option<String>,
    pub interceptor_js: String,
    pub extractor_js: String,
    pub aggregate: bool,
    pub required_slots: Vec<String>,
    pub slots: Vec<SlotRule>,
    pub login: LoginKind,
    pub summary: Summary,
}

/// 供前端能力查询使用的最小描述。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomScrapeChannelInfo {
    pub channel_id: String,
    pub account_name: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ValidatedMode {
    pub console_url: String,
    pub console_url_secondary: Option<String>,
    pub console_url_tertiary: Option<String>,
    pub interceptor_js: String,
    pub extractor_js: String,
    pub aggregate: bool,
    pub required_slots: Vec<String>,
    pub slots: Vec<SlotRule>,
}

#[derive(Debug, Clone)]
pub struct Descriptor {
    pub channel_id: String,
    pub account_name: Option<String>,
    pub fallback: bool,
    pub resource_modes: Vec<(String, String)>,
    pub login: LoginKind,
    pub modes: HashMap<String, ValidatedMode>,
    pub summary: Summary,
}

#[derive(Debug, Clone, Default)]
pub struct CustomScrapeRegistry {
    pub descriptors: Vec<Descriptor>,
    pub errors: Vec<String>,
}

// ─── 全局注册表 ─────────────────────────────────────────────────────────────

static REGISTRY: OnceLock<RwLock<CustomScrapeRegistry>> = OnceLock::new();

pub fn registry() -> &'static RwLock<CustomScrapeRegistry> {
    REGISTRY.get_or_init(|| RwLock::new(load_registry()))
}

/// 重新扫描发现目录并替换全局注册表。返回重载后的快照供日志/前端展示。
pub fn reload() -> Result<CustomScrapeRegistry, String> {
    let next = load_registry();
    let lock = registry();
    let mut guard = lock
        .write()
        .map_err(|_| "锁定自定义抓取注册表失败".to_string())?;
    *guard = next.clone();
    Ok(next)
}

pub fn snapshot() -> CustomScrapeRegistry {
    registry()
        .read()
        .map(|value| value.clone())
        .unwrap_or_default()
}

pub fn list_channels() -> Vec<CustomScrapeChannelInfo> {
    snapshot()
        .descriptors
        .iter()
        .map(|descriptor| CustomScrapeChannelInfo {
            channel_id: descriptor.channel_id.clone(),
            account_name: descriptor.account_name.clone(),
        })
        .collect()
}

// ─── 发现目录 ───────────────────────────────────────────────────────────────

fn discovery_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|dir| dir.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    roots.push(exe_dir.join("custom-scrape"));
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".flowlet").join("custom-scrape"));
    }
    roots
}

// ─── 加载与校验 ─────────────────────────────────────────────────────────────

fn load_registry() -> CustomScrapeRegistry {
    let mut registry = CustomScrapeRegistry::default();
    let mut seen = std::collections::HashSet::new();
    for root in discovery_roots() {
        scan_root(&root, &mut registry, &mut seen);
    }
    registry
}

fn scan_root(
    root: &Path,
    registry: &mut CustomScrapeRegistry,
    seen: &mut std::collections::HashSet<String>,
) {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            registry.errors.push(format!(
                "读取自定义抓取目录 {} 失败: {error}",
                root.display()
            ));
            return;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest_path = path.join("manifest.json");
        if !manifest_path.is_file() {
            continue;
        }
        let dir_name = entry
            .file_name()
            .to_string_lossy()
            .to_ascii_lowercase();
        if !seen.insert(dir_name.clone()) {
            // 同名目录以后加载者（低优先级根目录）为准忽略。
            registry
                .errors
                .push(format!("忽略重复的自定义抓取描述符目录：{dir_name}"));
            continue;
        }
        match load_descriptor(&path) {
            Ok(descriptor) => {
                tracing::info!(
                    channel_id = %descriptor.channel_id,
                    account_name = ?descriptor.account_name,
                    dir = %path.display(),
                    "已发现自定义渠道抓取描述符"
                );
                registry.descriptors.push(descriptor);
            }
            Err(error) => {
                registry
                    .errors
                    .push(format!("{}: {error}", manifest_path.display()));
            }
        }
    }
}

fn load_descriptor(dir: &Path) -> Result<Descriptor, String> {
    let manifest_path = dir.join("manifest.json");
    let raw_text = std::fs::read_to_string(&manifest_path)
        .map_err(|error| format!("读取 manifest.json 失败: {error}"))?;
    let raw: RawManifest = serde_json::from_str(&raw_text)
        .map_err(|error| format!("解析 manifest.json 失败: {error}"))?;
    validate_and_build(&raw, dir)
}

fn validate_and_build(raw: &RawManifest, dir: &Path) -> Result<Descriptor, String> {
    if raw.schema_version != 1 {
        return Err(format!("不支持的 schemaVersion：{}", raw.schema_version));
    }
    let channel_id = raw.channel_id.trim();
    if channel_id.is_empty() {
        return Err("channelId 不能为空".to_string());
    }
    let account_name = raw.account_name.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if channel_id == "custom" && account_name.is_none() && !raw.fallback {
        return Err("custom 渠道的描述符必须声明 accountName，或显式设置 fallback=true".to_string());
    }
    if raw.resource_modes.is_empty() {
        return Err("resourceModes 不能为空".to_string());
    }

    let resource_modes: Vec<(String, String)> = raw
        .resource_modes
        .iter()
        .map(|entry| {
            (
                entry.resource_mode.trim().to_string(),
                entry.mode_key.trim().to_string(),
            )
        })
        .collect();
    for (resource_mode, mode_key) in &resource_modes {
        if resource_mode.is_empty() || mode_key.is_empty() {
            return Err("resourceModes 的 resourceMode / modeKey 不能为空".to_string());
        }
        if !raw.modes.contains_key(mode_key) {
            return Err(format!("resourceMode {resource_mode} 引用了缺失的 mode：{mode_key}"));
        }
    }

    let login = raw
        .login
        .as_ref()
        .map(validate_login)
        .transpose()?
        .unwrap_or(LoginKind::None);

    let mut modes = HashMap::new();
    for (mode_key, mode) in &raw.modes {
        modes.insert(
            mode_key.clone(),
            validate_mode(mode_key, mode, dir)?,
        );
    }

    let summary = raw
        .summary
        .as_ref()
        .map(|summary| Summary {
            plan: summary
                .plan
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned),
        })
        .unwrap_or(Summary { plan: None });

    Ok(Descriptor {
        channel_id: channel_id.to_string(),
        account_name: account_name.map(ToOwned::to_owned),
        fallback: raw.fallback,
        resource_modes,
        login,
        modes,
        summary,
    })
}

fn validate_login(login: &RawLogin) -> Result<LoginKind, String> {
    match login {
        RawLogin::None => Ok(LoginKind::None),
        RawLogin::Generic => Ok(LoginKind::Generic),
        RawLogin::GenericOrHost { host } => {
            let host = host.trim();
            if host.is_empty() {
                return Err("login.generic_or_host 的 host 不能为空".to_string());
            }
            Ok(LoginKind::GenericOrHost {
                host: host.to_ascii_lowercase(),
            })
        }
    }
}

fn validate_mode(mode_key: &str, mode: &RawMode, dir: &Path) -> Result<ValidatedMode, String> {
    if mode.console_url.trim().is_empty() {
        return Err(format!("mode {mode_key} 缺少 consoleUrl"));
    }

    let mut slots = Vec::new();
    for (slot_key, slot) in &mode.slots {
        let slot_key = slot_key.trim();
        if slot_key.is_empty() {
            return Err(format!("mode {mode_key} 存在空槽位名"));
        }
        let match_rule = slot
            .match_rule
            .as_ref()
            .map(validate_url_matcher)
            .transpose()
            .map_err(|error| format!("mode {mode_key} 槽位 {slot_key}：{error}"))?;
        let satisfies = slot
            .satisfies
            .as_ref()
            .map(validate_satisfies)
            .transpose()?
            .unwrap_or(SlotSatisfies::JsonValid);
        let merge = slot
            .merge
            .as_ref()
            .map(validate_merge)
            .transpose()
            .map_err(|error| format!("mode {mode_key} 槽位 {slot_key}：{error}"))?
            .unwrap_or(SlotMerge::LastWriteWins);
        slots.push(SlotRule {
            key: slot_key.to_string(),
            match_rule,
            satisfies,
            merge,
        });
    }

    if mode.aggregate {
        if mode.required_slots.is_empty() {
            return Err(format!("mode {mode_key} 聚合抓取缺少 requiredSlots"));
        }
        let declared: std::collections::HashSet<&str> =
            mode.slots.keys().map(String::as_str).collect();
        for required in &mode.required_slots {
            if !declared.contains(required.as_str()) {
                return Err(format!(
                    "mode {mode_key} 的 requiredSlots 引用了未声明的槽位：{required}"
                ));
            }
        }
    }

    let extractor_js = read_script(dir, "extractor.js")?;
    if extractor_js.trim().is_empty() {
        return Err(format!("mode {mode_key} 的 extractor.js 不能为空"));
    }
    let interceptor_js = read_script(dir, "interceptor.js")?;

    Ok(ValidatedMode {
        console_url: mode.console_url.trim().to_string(),
        console_url_secondary: mode
            .console_url_secondary
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        console_url_tertiary: mode
            .console_url_tertiary
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        interceptor_js,
        extractor_js,
        aggregate: mode.aggregate,
        required_slots: mode
            .required_slots
            .iter()
            .map(|value| value.trim().to_string())
            .collect(),
        slots,
    })
}

fn read_script(dir: &Path, file_name: &str) -> Result<String, String> {
    let path = dir.join(file_name);
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(format!("读取 {file_name} 失败: {error}")),
    }
}

fn validate_url_matcher(matcher: &RawUrlMatcher) -> Result<UrlMatch, String> {
    match matcher {
        RawUrlMatcher::UrlSubstring {
            value,
            case_insensitive,
        } => {
            let value = value.trim();
            if value.is_empty() {
                return Err("url_substring 的 value 不能为空".to_string());
            }
            Ok(UrlMatch::Substring {
                value: value.to_string(),
                case_insensitive: *case_insensitive,
            })
        }
        RawUrlMatcher::UrlPrefix { value } => {
            let value = value.trim();
            if value.is_empty() {
                return Err("url_prefix 的 value 不能为空".to_string());
            }
            Ok(UrlMatch::Prefix {
                value: value.to_string(),
            })
        }
        RawUrlMatcher::UrlExact { value } => {
            let value = value.trim();
            if value.is_empty() {
                return Err("url_exact 的 value 不能为空".to_string());
            }
            Ok(UrlMatch::Exact {
                value: value.to_string(),
            })
        }
        RawUrlMatcher::UrlRegex { pattern } => {
            let compiled = regex::Regex::new(pattern)
                .map_err(|error| format!("url_regex 编译失败: {error}"))?;
            Ok(UrlMatch::Regex(compiled))
        }
        RawUrlMatcher::Fallback => Ok(UrlMatch::Fallback),
    }
}

fn validate_satisfies(satisfies: &RawSatisfies) -> Result<SlotSatisfies, String> {
    match satisfies {
        RawSatisfies::JsonValid => Ok(SlotSatisfies::JsonValid),
        RawSatisfies::JsonPath { path, expect } => {
            let path = path.trim();
            if path.is_empty() {
                return Err("json_path 的 path 不能为空".to_string());
            }
            Ok(SlotSatisfies::JsonPath {
                path: path.to_string(),
                expect: map_expect(*expect),
            })
        }
        RawSatisfies::None => Ok(SlotSatisfies::None),
    }
}

fn map_expect(expect: RawExpect) -> JsonExpect {
    match expect {
        RawExpect::Present => JsonExpect::Present,
        RawExpect::Number => JsonExpect::Number,
        RawExpect::Boolean => JsonExpect::Boolean,
        RawExpect::String => JsonExpect::String,
        RawExpect::Array => JsonExpect::Array,
        RawExpect::Object => JsonExpect::Object,
        RawExpect::NonEmptyString => JsonExpect::NonEmptyString,
        RawExpect::PositiveNumber => JsonExpect::PositiveNumber,
    }
}

fn validate_merge(merge: &RawMerge) -> Result<SlotMerge, String> {
    match merge {
        RawMerge::LastWriteWins => Ok(SlotMerge::LastWriteWins),
        RawMerge::MergeArrays {
            path,
            dedup_by,
            keep_fields,
        } => {
            let path = path.trim();
            if path.is_empty() {
                return Err("merge_arrays 的 path 不能为空".to_string());
            }
            Ok(SlotMerge::MergeArrays {
                path: path.to_string(),
                dedup_by: dedup_by
                    .iter()
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .collect(),
                keep_fields: keep_fields
                    .iter()
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .collect(),
            })
        }
    }
}

// ─── 解析与匹配 ─────────────────────────────────────────────────────────────

/// 把一个账号解析到自定义抓取模式。`channel_id == "custom"` 时按 account_name 匹配。
pub fn resolve(
    channel_id: &str,
    account_name: Option<&str>,
    resource_mode: Option<&str>,
) -> Option<CustomScrapeResolved> {
    let registry = snapshot();
    let resource_mode = resource_mode.unwrap_or("pay_as_you_go");
    for descriptor in &registry.descriptors {
        if descriptor.channel_id != channel_id {
            continue;
        }
        if channel_id == "custom" {
            match (&descriptor.account_name, account_name) {
                (Some(expected), Some(actual)) if account_name_matches(expected, actual) => {}
                (None, _) if descriptor.fallback => {}
                _ => continue,
            }
        }
        let mode_key = descriptor
            .resource_modes
            .iter()
            .find(|(rm, _)| rm == resource_mode)
            .map(|(_, mode_key)| mode_key.clone())
            .or_else(|| {
                descriptor
                    .resource_modes
                    .iter()
                    .find(|(rm, _)| rm == "pay_as_you_go")
                    .map(|(_, mode_key)| mode_key.clone())
            })?;
        let mode = descriptor.modes.get(&mode_key)?;
        return Some(CustomScrapeResolved {
            console_url: mode.console_url.clone(),
            console_url_secondary: mode.console_url_secondary.clone(),
            console_url_tertiary: mode.console_url_tertiary.clone(),
            interceptor_js: mode.interceptor_js.clone(),
            extractor_js: mode.extractor_js.clone(),
            aggregate: mode.aggregate,
            required_slots: mode.required_slots.clone(),
            slots: mode.slots.clone(),
            login: descriptor.login.clone(),
            summary: descriptor.summary.clone(),
        });
    }
    None
}

/// 账号名匹配：大小写不敏感、trim 后先精确后子串。
pub fn account_name_matches(expected: &str, actual: &str) -> bool {
    let expected = expected.trim().to_ascii_lowercase();
    let actual = actual.trim().to_ascii_lowercase();
    if expected.is_empty() || actual.is_empty() {
        return false;
    }
    expected == actual || actual.contains(&expected) || expected.contains(&actual)
}

pub fn url_matches(matcher: &UrlMatch, url: &str) -> bool {
    match matcher {
        UrlMatch::Substring {
            value,
            case_insensitive,
        } => {
            if *case_insensitive {
                url.to_ascii_lowercase()
                    .contains(&value.to_ascii_lowercase())
            } else {
                url.contains(value.as_str())
            }
        }
        UrlMatch::Prefix { value } => url
            .to_ascii_lowercase()
            .starts_with(&value.to_ascii_lowercase()),
        UrlMatch::Exact { value } => {
            let url_no_query = url.split('?').next().unwrap_or(url);
            url_no_query.trim_end_matches('/') == value.trim_end_matches('/')
        }
        UrlMatch::Regex(regex) => regex.is_match(url),
        UrlMatch::Fallback => false,
    }
}

pub fn slot_satisfies(satisfies: &SlotSatisfies, body: &str) -> bool {
    match satisfies {
        SlotSatisfies::JsonValid => serde_json::from_str::<serde_json::Value>(body).is_ok(),
        SlotSatisfies::None => true,
        SlotSatisfies::JsonPath { path, expect } => {
            let Ok(root) = serde_json::from_str::<serde_json::Value>(body) else {
                return false;
            };
            let Some(pointer) = json_pointer(path) else {
                return false;
            };
            let Some(value) = root.pointer(&pointer) else {
                return false;
            };
            expect_matches(*expect, value)
        }
    }
}

pub fn merge_arrays(
    path: &str,
    dedup_by: &[String],
    keep_fields: &[String],
    existing: &str,
    incoming: &str,
) -> Option<String> {
    let existing_root: serde_json::Value = serde_json::from_str(existing).ok()?;
    let incoming_root: serde_json::Value = serde_json::from_str(incoming).ok()?;
    let pointer = json_pointer(path)?;
    let existing_items = existing_root.pointer(&pointer)?.as_array()?;
    let incoming_items = incoming_root.pointer(&pointer)?.as_array()?;

    let mut order: Vec<String> = Vec::new();
    let mut by_key: HashMap<String, serde_json::Value> = HashMap::new();
    for item in existing_items.iter().chain(incoming_items.iter()) {
        let key = identity_key(item, dedup_by);
        if key.is_empty() {
            continue;
        }
        if !by_key.contains_key(&key) {
            order.push(key.clone());
        }
        by_key.insert(key, item.clone());
    }

    let merged = order
        .iter()
        .filter_map(|key| by_key.get(key))
        .filter_map(|item| keep_declared_fields(item, keep_fields))
        .collect::<Vec<_>>();

    // 把合并结果写回 `path` 指向的数组，并保留信封其他字段。
    let mut root = existing_root.clone();
    if let Some(target) = root.pointer_mut(&pointer) {
        *target = serde_json::Value::Array(merged);
        return serde_json::to_string(&root).ok();
    }
    None
}

fn identity_key(item: &serde_json::Value, dedup_by: &[String]) -> String {
    if dedup_by.is_empty() {
        return serde_json::to_string(item).unwrap_or_default();
    }
    dedup_by
        .iter()
        .map(|path| {
            json_pointer(path)
                .and_then(|pointer| item.pointer(&pointer))
                .map(scalar_key)
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join("\u{1f}")
}

fn scalar_key(value: &serde_json::Value) -> String {
    value
        .as_str()
        .map(ToOwned::to_owned)
        .or_else(|| value.as_i64().map(|v| v.to_string()))
        .or_else(|| value.as_u64().map(|v| v.to_string()))
        .or_else(|| value.as_f64().map(|v| v.to_string()))
        .unwrap_or_default()
}

fn keep_declared_fields(
    item: &serde_json::Value,
    keep_fields: &[String],
) -> Option<serde_json::Value> {
    if keep_fields.is_empty() {
        return Some(item.clone());
    }
    let Some(source) = item.as_object() else {
        return None;
    };
    let mut target = serde_json::Map::new();
    for field in keep_fields {
        if let Some(value) = source.get(field) {
            target.insert(field.clone(), value.clone());
        }
    }
    Some(serde_json::Value::Object(target))
}

/// 把 `$.a.b[0]` 或 `/a/b/0` 归一为 JSON Pointer（`/a/b/0`）。
pub fn json_pointer(path: &str) -> Option<String> {
    let path = path.trim();
    if path.is_empty() {
        return None;
    }
    if path.starts_with('/') {
        return Some(path.to_string());
    }
    if !path.starts_with('$') {
        return None;
    }
    let rest = &path[1..];
    let mut pointer = String::new();
    let mut segment = String::new();
    let mut chars = rest.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '.' => push_pointer_segment(&mut pointer, &mut segment),
            '[' => {
                push_pointer_segment(&mut pointer, &mut segment);
                let mut index = String::new();
                for inner in chars.by_ref() {
                    if inner == ']' {
                        break;
                    }
                    index.push(inner);
                }
                if index.is_empty() {
                    return None;
                }
                pointer.push('/');
                pointer.push_str(&index);
            }
            other => segment.push(other),
        }
    }
    push_pointer_segment(&mut pointer, &mut segment);
    if pointer.is_empty() {
        return None;
    }
    Some(pointer)
}

fn push_pointer_segment(pointer: &mut String, segment: &mut String) {
    if !segment.is_empty() {
        pointer.push('/');
        pointer.push_str(segment);
        segment.clear();
    }
}

pub fn login_matches(login: &LoginKind, page_url: &str) -> bool {
    match login {
        LoginKind::None => false,
        LoginKind::Generic => has_login_path(page_url),
        LoginKind::GenericOrHost { host } => {
            has_login_path(page_url)
                || page_url.to_ascii_lowercase().contains(host.as_str())
        }
    }
}

fn has_login_path(page_url: &str) -> bool {
    let url = page_url.to_ascii_lowercase();
    url.contains("/login")
        || url.contains("/signin")
        || url.contains("/sign-in")
        || url.contains("passport")
        || url.contains("oauth")
}

fn expect_matches(expect: JsonExpect, value: &serde_json::Value) -> bool {
    match expect {
        JsonExpect::Present => !value.is_null(),
        JsonExpect::Number => value.as_f64().is_some(),
        JsonExpect::Boolean => value.as_bool().is_some(),
        JsonExpect::String => value.as_str().is_some(),
        JsonExpect::Array => value.is_array(),
        JsonExpect::Object => value.is_object(),
        JsonExpect::NonEmptyString => value.as_str().is_some_and(|value| !value.is_empty()),
        JsonExpect::PositiveNumber => value.as_f64().is_some_and(|value| value > 0.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_name_matches_is_case_insensitive_exact_then_substring() {
        assert!(account_name_matches("friday", "Friday"));
        assert!(account_name_matches("Friday", "Friday 主账号"));
        assert!(account_name_matches("Friday 主账号", "friday"));
        assert!(!account_name_matches("friday", "saturday"));
        assert!(!account_name_matches("", "friday"));
    }

    #[test]
    fn json_pointer_converts_jsonpath_and_passthrough_pointer() {
        assert_eq!(json_pointer("$.data.used").as_deref(), Some("/data/used"));
        assert_eq!(
            json_pointer("$.data.Data[0].Template.Code").as_deref(),
            Some("/data/Data/0/Template/Code")
        );
        assert_eq!(json_pointer("/data/used").as_deref(), Some("/data/used"));
        assert_eq!(json_pointer("data.used"), None);
        assert_eq!(json_pointer("$.data["), None);
    }

    #[test]
    fn slot_satisfies_json_path_expectations() {
        let body = r#"{"data":{"used":10,"name":"friday","active":true,"tags":[],"meta":{}}}"#;
        let number = SlotSatisfies::JsonPath {
            path: "$.data.used".to_string(),
            expect: JsonExpect::Number,
        };
        assert!(slot_satisfies(&number, body));
        let positive = SlotSatisfies::JsonPath {
            path: "$.data.used".to_string(),
            expect: JsonExpect::PositiveNumber,
        };
        assert!(slot_satisfies(&positive, body));
        let nonempty = SlotSatisfies::JsonPath {
            path: "$.data.name".to_string(),
            expect: JsonExpect::NonEmptyString,
        };
        assert!(slot_satisfies(&nonempty, body));
        let missing = SlotSatisfies::JsonPath {
            path: "$.data.missing".to_string(),
            expect: JsonExpect::Present,
        };
        assert!(!slot_satisfies(&missing, body));
        assert!(!slot_satisfies(&number, r#"{"code":"UNAUTHORIZED"}"#));
        assert!(!slot_satisfies(&number, "{"));
    }

    #[test]
    fn url_matches_variants() {
        assert!(url_matches(
            &UrlMatch::Substring {
                value: "/api/v2/usage".to_string(),
                case_insensitive: true,
            },
            "https://friday.example.com/API/V2/USAGE?x=1"
        ));
        assert!(url_matches(
            &UrlMatch::Prefix {
                value: "https://friday.example.com".to_string(),
            },
            "https://friday.example.com/api"
        ));
        assert!(url_matches(
            &UrlMatch::Exact {
                value: "https://friday.example.com/api".to_string(),
            },
            "https://friday.example.com/api?x=1"
        ));
        assert!(url_matches(
            &UrlMatch::Regex(regex::Regex::new(r"^https://friday\.example\.com/api/v2/usage").unwrap()),
            "https://friday.example.com/api/v2/usage"
        ));
        assert!(!url_matches(&UrlMatch::Fallback, "https://friday.example.com/api"));
    }

    #[test]
    fn login_matches_variants() {
        assert!(!login_matches(&LoginKind::None, "https://x.com/login"));
        assert!(login_matches(
            &LoginKind::Generic,
            "https://x.com/login?redirect=1"
        ));
        assert!(login_matches(
            &LoginKind::GenericOrHost {
                host: "friday.example.com".to_string(),
            },
            "https://friday.example.com/home"
        ));
        assert!(!login_matches(
            &LoginKind::Generic,
            "https://x.com/billing"
        ));
    }

    #[test]
    fn merge_arrays_dedups_by_path() {
        let existing = r#"{"data":{"Data":[{"Template":{"Code":"a"},"Status":"valid"},{"Template":{"Code":"b"},"Status":"valid"}]}}"#;
        let incoming = r#"{"data":{"Data":[{"Template":{"Code":"b"},"Status":"expired"},{"Template":{"Code":"c"},"Status":"valid"}]}}"#;
        let merged = merge_arrays(
            "$.data.Data",
            &["$.Template.Code".to_string()],
            &["Template".to_string(), "Status".to_string()],
            existing,
            incoming,
        )
        .expect("merged");
        let root: serde_json::Value = serde_json::from_str(&merged).unwrap();
        let items = root.pointer("/data/Data").unwrap().as_array().unwrap();
        assert_eq!(items.len(), 3);
        let b = items
            .iter()
            .find(|item| item.pointer("/Template/Code").and_then(|v| v.as_str()) == Some("b"))
            .unwrap();
        assert_eq!(b.pointer("/Status").and_then(|v| v.as_str()), Some("expired"));
        // 裁剪后不保留未声明的字段。
        assert!(items[0].get("unexpected").is_none());
    }
}
