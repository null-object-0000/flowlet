//! 上游代理配置。
//!
//! Flowlet 自身的对外 HTTP 请求（Codex 官方用量、渠道模型/余额同步、Agent 版本
//! 检查、远程数据拉取）在部分网络环境下需要显式代理才能连通（例如桌面进程不会
//! 继承 shell 里 export 的 `HTTPS_PROXY`）。这里提供一份进程内全局配置，供各
//! 处的 reqwest client 在构建时读取并注入代理。
//!
//! 边界：只作用于 Flowlet 自己发起的元数据/能力请求；本地代理的上游模型转发
//! （`proxy.rs` 的 `Client`）不经过本配置，继续直连各渠道上游。

use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};

/// 上游代理配置。`url` 只支持 http/https 代理。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct UpstreamProxyConfig {
    /// 是否启用上游代理。`false` 时所有请求直连。
    #[serde(default)]
    pub enabled: bool,
    /// 代理地址，如 `http://127.0.0.1:7890`。仅支持 http/https。
    #[serde(default)]
    pub url: String,
    /// 逗号分隔的直连白名单（host 或 host:port），命中的目标不走代理。可为空。
    #[serde(default)]
    pub no_proxy: String,
}

impl Default for UpstreamProxyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            url: String::new(),
            no_proxy: String::new(),
        }
    }
}

impl UpstreamProxyConfig {
    pub fn normalized(mut self) -> Self {
        self.url = self.url.trim().to_string();
        self.no_proxy = self.no_proxy.trim().to_string();
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

/// 读取当前进程内全局上游代理配置。
pub fn current() -> UpstreamProxyConfig {
    store()
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default()
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
        no_proxy: object
            .get("no_proxy")
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
    let proxy = reqwest::Proxy::all(&config.url)
        .map_err(|error| format!("上游代理地址无效（{}）：{error}", config.url))?;
    let proxy = match reqwest::NoProxy::from_string(&config.no_proxy) {
        Some(no_proxy) => proxy.no_proxy(Some(no_proxy)),
        None => proxy,
    };
    Ok(builder.proxy(proxy))
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
    let no_proxy = config.no_proxy.trim().to_string();
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
        entries.push((key.to_string(), no_proxy.clone()));
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_network_upstream_proxy_from_config_json() {
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
        assert_eq!(config.no_proxy, "localhost,127.0.0.1");
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
            no_proxy: String::new(),
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
            no_proxy: String::new(),
        };
        assert!(valid.validate().is_ok());

        let socks = UpstreamProxyConfig {
            enabled: true,
            url: "socks5://127.0.0.1:7890".to_string(),
            no_proxy: String::new(),
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
                no_proxy: String::new(),
            },
        )
        .expect("apply proxy");
        assert!(builder.build().is_ok());

        let builder = apply_config(
            reqwest::Client::builder(),
            &UpstreamProxyConfig::default(),
        )
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
                no_proxy: String::new(),
            },
        )
        .expect_err("socks must be rejected");
        assert!(error.contains("仅支持 http/https"));
    }

    #[test]
    fn command_env_overrides_inject_proxy_when_enabled_and_empty_when_disabled() {
        let overrides = command_env_overrides(&UpstreamProxyConfig {
            enabled: true,
            url: "http://127.0.0.1:7890".to_string(),
            no_proxy: "localhost".to_string(),
        });
        let map: std::collections::HashMap<&str, &str> = overrides
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect();
        assert_eq!(map.get("HTTPS_PROXY"), Some(&"http://127.0.0.1:7890"));
        assert_eq!(map.get("HTTP_PROXY"), Some(&"http://127.0.0.1:7890"));
        assert_eq!(map.get("ALL_PROXY"), Some(&"http://127.0.0.1:7890"));
        assert_eq!(map.get("NO_PROXY"), Some(&"localhost"));

        assert!(command_env_overrides(&UpstreamProxyConfig::default()).is_empty());
    }
}
