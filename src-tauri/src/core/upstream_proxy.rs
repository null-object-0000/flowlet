//! 上游代理配置。
//!
//! Flowlet 自身的对外 HTTP 请求（Codex 官方用量、渠道模型/余额同步、Agent 版本
//! 检查、远程数据拉取）在部分网络环境下需要显式代理才能连通（例如桌面进程不会
//! 继承 shell 里 export 的 `HTTPS_PROXY`）。这里提供一份进程内全局配置，供各
//! 处的 reqwest client 在构建时读取并注入代理。
//!
//! 边界：元数据/能力请求使用本配置；模型转发仅在渠道 Adapter 显式声明时
//! 使用本配置（当前仅 ChatGPT API）。其他渠道保留原有 HTTP Client 行为。

use super::config::ChannelAccount;
use hyper_util::client::proxy::matcher::Matcher;
use jsonc_parser::cst::{CstInputValue, CstRootNode};
use jsonc_parser::ParseOptions;
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};

/// SQLite `app_meta` 中保存运行时上游代理配置的键。
///
/// config.json 里的 `network.upstream_proxy` 只是「首次默认值」（以及手改文件的
/// 入口）；设置页保存后以 SQLite 为准，避免开发模式下打包资源在重新构建时把
/// 运行时改动的 config.json 覆盖掉。
pub const UPSTREAM_PROXY_META_KEY: &str = "upstream_proxy_config";

/// 上游代理配置。`url` 只支持 http/https 代理。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct UpstreamProxyConfig {
    /// 全局请求是否使用上游代理；账号可单独选择。
    #[serde(default)]
    pub enabled: bool,
    /// 代理地址，如 `http://127.0.0.1:7890`。仅支持 http/https。
    #[serde(default)]
    pub url: String,
}

impl Default for UpstreamProxyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            url: String::new(),
        }
    }
}

impl UpstreamProxyConfig {
    pub fn normalized(mut self) -> Self {
        self.url = self.url.trim().to_string();
        if self.url.is_empty() {
            self.enabled = false;
        }
        self
    }

    /// 校验配置是否可用于构建 reqwest 代理。`enabled=false` 时始终通过。
    pub fn validate(&self) -> Result<(), String> {
        if !self.enabled {
            return Ok(());
        }
        let url = self.url.trim();
        if url.is_empty() {
            return Err("上游代理地址不能为空".to_string());
        }
        let parsed = url::Url::parse(url).map_err(|error| format!("上游代理地址无效：{error}"))?;
        match parsed.scheme() {
            "http" | "https" => Ok(()),
            _ => Err("仅支持 http/https 上游代理（不支持 socks 代理）".to_string()),
        }
    }

    pub fn is_active(&self) -> bool {
        self.enabled && !self.url.trim().is_empty()
    }
}

static STORE: OnceLock<Mutex<UpstreamProxyConfig>> = OnceLock::new();

fn store() -> &'static Mutex<UpstreamProxyConfig> {
    STORE.get_or_init(|| Mutex::new(UpstreamProxyConfig::default()))
}

/// 更新进程内全局上游代理配置（先归一化并校验）。
pub fn set(config: UpstreamProxyConfig) -> Result<(), String> {
    let config = config.normalized();
    config.validate()?;
    if let Ok(mut guard) = store().lock() {
        *guard = config;
    }
    Ok(())
}

#[cfg(test)]
tokio::task_local! {
    static TEST_CONFIG: UpstreamProxyConfig;
}

#[cfg(test)]
pub(crate) async fn with_test_config<F: std::future::Future>(
    config: UpstreamProxyConfig,
    future: F,
) -> F::Output {
    TEST_CONFIG.scope(config, future).await
}

/// 读取当前进程内全局上游代理配置。
pub fn current() -> UpstreamProxyConfig {
    #[cfg(test)]
    if let Ok(config) = TEST_CONFIG.try_with(Clone::clone) {
        return config;
    }

    store()
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

/// 把上游代理配置合并进 config.json 的文本内容。
///
/// 使用 jsonc-parser 的 CST 做格式保留编辑：只新增/更新 `network.upstream_proxy`，
/// 其余字段、键序与注释原样保留。返回合并后的文本（保证以单个换行结尾）。
pub fn merge_into_config_json(
    content: &str,
    config: &UpstreamProxyConfig,
) -> Result<String, String> {
    let root = CstRootNode::parse(content, &ParseOptions::default())
        .map_err(|error| format!("解析 config.json 失败：{error}"))?;
    let root_object = root
        .object_value()
        .ok_or_else(|| "config.json 顶层必须是 JSON 对象".to_string())?;

    let network_object = match root_object.get("network") {
        Some(property) => property.object_value_or_set(),
        None => root_object
            .append("network", CstInputValue::Object(Vec::new()))
            .object_value_or_set(),
    };
    let proxy_value = CstInputValue::Object(vec![
        ("enabled".to_string(), CstInputValue::Bool(config.enabled)),
        ("url".to_string(), CstInputValue::String(config.url.clone())),
    ]);
    match network_object.get("upstream_proxy") {
        Some(property) => property.set_value(proxy_value),
        None => {
            network_object.append("upstream_proxy", proxy_value);
        }
    }

    let mut merged = root.to_string();
    if !merged.ends_with('\n') {
        merged.push('\n');
    }
    Ok(merged)
}

/// 从 JSON 字符串解析配置（用于读取 SQLite app_meta 中的运行时值）；
/// 解析失败或形状不符时返回默认值，不抛出错误。
pub fn from_stored_json(raw: &str) -> UpstreamProxyConfig {
    serde_json::from_str::<UpstreamProxyConfig>(raw)
        .unwrap_or_default()
        .normalized()
}

/// 从 config.json 顶层对象的 `network.upstream_proxy` 解析配置。缺失时返回默认值。
pub fn from_config_json(value: &serde_json::Value) -> UpstreamProxyConfig {
    let Some(proxy) = value
        .as_object()
        .and_then(|root| root.get("network"))
        .and_then(|network| network.get("upstream_proxy"))
    else {
        return UpstreamProxyConfig::default();
    };
    let Some(object) = proxy.as_object() else {
        return UpstreamProxyConfig::default();
    };
    UpstreamProxyConfig {
        enabled: object
            .get("enabled")
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
        url: object
            .get("url")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string(),
    }
    .normalized()
}

/// 把上游代理配置应用到 reqwest `ClientBuilder`。未启用时原样返回 builder。
pub fn apply_config(
    builder: reqwest::ClientBuilder,
    config: &UpstreamProxyConfig,
) -> Result<reqwest::ClientBuilder, String> {
    if !config.is_active() {
        return Ok(builder);
    }
    // 防御性校验：只接受 http/https，非法协议（如 socks5）直接拒绝，
    // 避免构建出 reqwest 在请求时才失败的 socks 代理。
    config.validate()?;
    let proxy = explicit_proxy(config)
        .map_err(|error| format!("上游代理地址无效（{}）：{error}", config.url))?;
    Ok(builder.proxy(proxy))
}

fn account_proxy_config(account: &ChannelAccount, legacy_uses_proxy: bool) -> UpstreamProxyConfig {
    let mut config = current();
    config.enabled = account
        .use_upstream_proxy
        .unwrap_or(config.is_active() && legacy_uses_proxy);
    config
}

pub(crate) fn apply_to_account(
    builder: reqwest::ClientBuilder,
    account: &ChannelAccount,
) -> Result<reqwest::ClientBuilder, String> {
    let config = account_proxy_config(account, true);
    if account.use_upstream_proxy.is_none() {
        return apply_config(builder, &config);
    }
    config.validate()?;
    apply_config(builder.no_proxy(), &config)
}

fn explicit_proxy(config: &UpstreamProxyConfig) -> Result<reqwest::Proxy, reqwest::Error> {
    reqwest::Proxy::all(&config.url)
}

/// 保持模型转发的连接池、keepalive 与连接超时策略一致。
pub(crate) fn model_client_builder() -> reqwest::ClientBuilder {
    use std::time::Duration;
    reqwest::Client::builder()
        .pool_idle_timeout(Duration::from_secs(60))
        .tcp_keepalive(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
}

type ModelClientCache = Option<(UpstreamProxyConfig, reqwest::Client)>;

fn proxy_used(matcher: &Matcher, url: &str) -> Option<bool> {
    let uri = url.parse().ok()?;
    Some(matcher.intercept(&uri).is_some())
}

pub(crate) fn system_proxy_used(url: &str) -> Option<bool> {
    static MATCHER: OnceLock<Matcher> = OnceLock::new();
    proxy_used(MATCHER.get_or_init(Matcher::from_system), url)
}

/// 每个候选在发起请求前读取最新设置；同配置复用连接池，修改地址或开关后
/// 下一次请求立即切换。已在途的请求继续持有原 Client，不因设置保存被中断。
/// 代理连接失败必须作为原候选的网络错误处理，不能偷偷重试直连。
pub(crate) fn model_forwarding_client(
    account: &ChannelAccount,
    original: &reqwest::Client,
    url: &str,
) -> Result<(reqwest::Client, Option<bool>, bool), String> {
    let legacy_uses_proxy = super::channel_capability_adapter::channel_adapter(&account.channel_id)
        .is_some_and(|adapter| adapter.uses_upstream_proxy_for_models);
    let config = account_proxy_config(account, legacy_uses_proxy);
    if account.use_upstream_proxy == Some(false) {
        static DIRECT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
        let client = DIRECT
            .get_or_init(|| {
                model_client_builder()
                    .no_proxy()
                    .build()
                    .map_err(|err| err.to_string())
            })
            .clone()?;
        return Ok((client, Some(false), false));
    }
    if !config.enabled {
        return Ok((original.clone(), system_proxy_used(url), false));
    }
    config.validate()?;
    static CACHE: OnceLock<Mutex<ModelClientCache>> = OnceLock::new();
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((cached_config, client)) = cache.as_ref() {
        if cached_config == &config {
            return Ok((client.clone(), Some(true), true));
        }
    }
    let client = model_client_builder()
        .no_proxy()
        .proxy(explicit_proxy(&config).map_err(|error| error.to_string())?)
        .build()
        .map_err(|error| error.to_string())?;
    *cache = Some((config, client.clone()));
    Ok((client, Some(true), true))
}

/// Retry only connector failures, before an upstream HTTP request could be sent.
/// The existing outer timeout includes both attempts and this short backoff.
pub(crate) async fn execute_model_request(
    channel_id: &str,
    client: &reqwest::Client,
    request: reqwest::Request,
    retry_proxy_connect: bool,
) -> Result<reqwest::Response, reqwest::Error> {
    let retry = retry_proxy_connect.then(|| request.try_clone()).flatten();
    match client.execute(request).await {
        Err(error) if error.is_connect() && retry.is_some() => {
            tracing::warn!(channel_id, error = %model_network_error(channel_id, &error),
                "Upstream connection failed before HTTP send; retrying once through the same client");
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            client
                .execute(retry.expect("retry request checked above"))
                .await
        }
        result => result,
    }
}

/// Retain OpenAI's connector cause chain without changing other channels' logs.
pub(crate) fn model_network_error(channel_id: &str, error: &reqwest::Error) -> String {
    use std::error::Error;
    let mut detail = error.to_string();
    if super::channel_capability_adapter::channel_adapter(channel_id)
        .is_some_and(|adapter| adapter.uses_upstream_proxy_for_models)
    {
        detail.push_str(if error.is_connect() {
            " [connect]"
        } else {
            " [after_connect]"
        });
        let mut source = error.source();
        for _ in 0..6 {
            let Some(cause) = source else {
                break;
            };
            detail.push_str(": ");
            detail.extend(cause.to_string().chars().take(256));
            source = cause.source();
        }
    }
    detail
}

/// 把当前进程内上游代理配置应用到 reqwest `ClientBuilder`。
pub fn apply_to(builder: reqwest::ClientBuilder) -> Result<reqwest::ClientBuilder, String> {
    apply_config(builder, &current())
}

/// 构建一个已应用当前上游代理配置的 reqwest client。
pub fn build_client() -> Result<reqwest::Client, String> {
    apply_to(reqwest::Client::builder())?
        .build()
        .map_err(|error| format!("创建 HTTP 客户端失败：{error}"))
}

/// 返回需要注入到子进程环境的代理变量。
///
/// Flowlet 自身用 reqwest 的 `apply_to` 走代理，但某些流程由 Flowlet 启动的子进程
/// 完成（例如 Codex CLI app-server 的 OAuth token exchange）。这些子进程不会读取
/// Flowlet 的内存配置，只能通过环境变量继承代理。`enabled=false` 时返回空列表，
/// 保留子进程对父进程环境变量的继承（与未配置代理时的行为一致）。
pub fn command_env_overrides(config: &UpstreamProxyConfig) -> Vec<(String, String)> {
    if !config.is_active() {
        return Vec::new();
    }
    let url = config.url.trim().to_string();
    let mut entries = Vec::with_capacity(8);
    for key in [
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        entries.push((key.to_string(), url.clone()));
    }
    for key in ["NO_PROXY", "no_proxy"] {
        entries.push((key.to_string(), String::new()));
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_network_upstream_proxy_with_legacy_fields() {
        let config = from_config_json(&serde_json::json!({
            "network": {
                "upstream_proxy": {
                    "enabled": true,
                    "url": " http://127.0.0.1:7890 ",
                    "no_proxy": "localhost,127.0.0.1"
                }
            }
        }));
        assert!(config.enabled);
        assert_eq!(config.url, "http://127.0.0.1:7890");
    }

    #[test]
    fn missing_proxy_config_falls_back_to_default() {
        assert_eq!(
            from_config_json(&serde_json::json!({ "bind": {} })),
            UpstreamProxyConfig::default()
        );
    }

    #[test]
    fn empty_url_forces_disabled() {
        let config = UpstreamProxyConfig {
            enabled: true,
            url: "  ".to_string(),
        }
        .normalized();
        assert!(!config.enabled);
        assert!(!config.is_active());
    }

    #[test]
    fn validates_http_proxy_url_and_rejects_socks() {
        let valid = UpstreamProxyConfig {
            enabled: true,
            url: "http://127.0.0.1:7890".to_string(),
        };
        assert!(valid.validate().is_ok());

        let socks = UpstreamProxyConfig {
            enabled: true,
            url: "socks5://127.0.0.1:7890".to_string(),
        };
        assert!(socks.validate().unwrap_err().contains("仅支持 http/https"));
    }

    #[test]
    fn apply_config_applies_proxy_only_when_enabled() {
        let builder = apply_config(
            reqwest::Client::builder(),
            &UpstreamProxyConfig {
                enabled: true,
                url: "http://127.0.0.1:7890".to_string(),
            },
        )
        .expect("apply proxy");
        assert!(builder.build().is_ok());

        let builder = apply_config(reqwest::Client::builder(), &UpstreamProxyConfig::default())
            .expect("no proxy");
        assert!(builder.build().is_ok());
    }

    #[test]
    fn apply_config_rejects_unsupported_proxy_scheme() {
        let error = apply_config(
            reqwest::Client::builder(),
            &UpstreamProxyConfig {
                enabled: true,
                url: "socks5://127.0.0.1:7890".to_string(),
            },
        )
        .expect_err("socks must be rejected");
        assert!(error.contains("仅支持 http/https"));
    }

    #[test]
    fn merge_into_config_json_preserves_other_fields_and_round_trips() {
        let source = r#"{
  "bind": { "host": "127.0.0.1", "port": 18640 },
  "usage_cost": { "currency_conversion_enabled": false }
}
"#;
        let merged = merge_into_config_json(
            source,
            &UpstreamProxyConfig {
                enabled: true,
                url: "http://127.0.0.1:7890".to_string(),
            },
        )
        .expect("merge");
        let value: serde_json::Value = serde_json::from_str(&merged).expect("valid json");
        assert_eq!(value["bind"]["port"], 18640);
        assert_eq!(value["usage_cost"]["currency_conversion_enabled"], false);
        assert_eq!(value["network"]["upstream_proxy"]["enabled"], true);
        assert_eq!(
            value["network"]["upstream_proxy"]["url"],
            "http://127.0.0.1:7890"
        );
        assert!(value["network"]["upstream_proxy"].get("no_proxy").is_none());

        // 再次覆盖写入应更新而非产生重复键。
        let merged_again = merge_into_config_json(
            &merged,
            &UpstreamProxyConfig {
                enabled: false,
                url: "http://127.0.0.1:7891".to_string(),
            },
        )
        .expect("re-merge");
        let value: serde_json::Value = serde_json::from_str(&merged_again).expect("valid json");
        assert_eq!(value["network"]["upstream_proxy"]["enabled"], false);
        assert_eq!(
            value["network"]["upstream_proxy"]["url"],
            "http://127.0.0.1:7891"
        );
        assert_eq!(value["bind"]["port"], 18640);
    }

    #[test]
    fn command_env_overrides_inject_proxy_when_enabled_and_empty_when_disabled() {
        let overrides = command_env_overrides(&UpstreamProxyConfig {
            enabled: true,
            url: "http://127.0.0.1:7890".to_string(),
        });
        let map: std::collections::HashMap<&str, &str> = overrides
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect();
        assert_eq!(map.get("HTTPS_PROXY"), Some(&"http://127.0.0.1:7890"));
        assert_eq!(map.get("HTTP_PROXY"), Some(&"http://127.0.0.1:7890"));
        assert_eq!(map.get("ALL_PROXY"), Some(&"http://127.0.0.1:7890"));
        assert_eq!(map.get("NO_PROXY"), Some(&""));

        assert!(command_env_overrides(&UpstreamProxyConfig::default()).is_empty());
    }
}
