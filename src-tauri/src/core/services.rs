use super::channels_config::{ChannelsConfig, DEFAULT_CONFIG_JSON};
use super::config::{LogCaptureConfig, ProxyBindConfig, RouteCandidate};
use super::job_runtime::JobRuntime;
use super::presets::builtin_channel_presets;
use super::proxy::{extract_log_capture, read_config_raw, ProxyController, ProxySharedConfig};
use super::rate_limiter::RateLimiter;
use super::runtime_config::{RuntimeConfigSnapshot, RuntimeConfigStore};
use super::secret_box::SecretBox;
use super::storage::Storage;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const DEFAULT_UPSTREAM_TIMEOUT_SECONDS: u64 = 120;

/// 与具体 Host（Tauri Desktop / headless）无关的 Flowlet 应用服务。
///
/// 这里统一拥有持久化、运行时配置快照和代理生命周期；窗口、托盘、WebView 与
/// 平台事件仍由各 Host 管理。
#[derive(Clone)]
pub struct FlowletServices {
    pub proxy: ProxyController,
    pub runtime_config: RuntimeConfigStore,
    pub jobs: JobRuntime,
    pub storage: Storage,
    pub capture: Arc<Mutex<LogCaptureConfig>>,
    pub bind_config: Arc<Mutex<ProxyBindConfig>>,
    pub config_path: PathBuf,
    pub channels_config: Arc<Mutex<ChannelsConfig>>,
    /// 三方服务凭据的静态加密（密钥文件在数据目录 `secret.key`）。
    pub secrets: SecretBox,
    pub upstream_timeout_seconds: u64,
    require_client_auth: bool,
}

impl FlowletServices {
    pub fn open(db_path: impl AsRef<Path>, config_path: impl AsRef<Path>) -> Result<Self, String> {
        let config_path = config_path.as_ref().to_path_buf();
        let channels_config = merge_builtin_config(load_channels_config_from(&config_path)?);
        // 凭据密钥跟数据目录走：Docker 里是 /data，桌面里是应用数据目录/便携目录。
        let data_dir = db_path
            .as_ref()
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .map(|path| path.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from("."));
        let secrets = SecretBox::load_or_create(&data_dir)?;
        let storage = Storage::open(db_path).map_err(|error| error.to_string())?;

        initialize_channel_presets(&storage, &channels_config)?;

        let config_value = read_config_raw(&config_path)
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
        let capture = storage
            .get_app_meta("log_capture_config")
            .map_err(|error| error.to_string())?
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_else(|| {
                config_value
                    .as_ref()
                    .map(extract_log_capture)
                    .unwrap_or_default()
            });
        let bind_config = config_value
            .as_ref()
            .and_then(parse_bind_config)
            .unwrap_or_else(|| load_bind_config_from_sqlite(&storage));
        // 运行时优先取 SQLite app_meta 中设置页保存的值；没有时才回退 config.json
        // 的 `network.upstream_proxy`（首次默认值 / 手改文件入口）。这样开发模式下
        // 重新构建覆盖 config.json 也不会丢失用户保存的代理设置。
        let stored_proxy = storage
            .get_app_meta(super::upstream_proxy::UPSTREAM_PROXY_META_KEY)
            .ok()
            .flatten();
        let upstream_proxy = match stored_proxy.as_deref() {
            Some(raw) => super::upstream_proxy::from_stored_json(raw),
            None => config_value
                .as_ref()
                .map(super::upstream_proxy::from_config_json)
                .unwrap_or_default(),
        };
        // 解析失败不阻断启动：默认关闭代理，后续可在设置页修正。
        if let Err(error) = super::upstream_proxy::set(upstream_proxy) {
            tracing::warn!(error = %error, "忽略无效的上游代理配置，回退直连");
        }

        let snapshot = load_runtime_snapshot(&storage, &channels_config)?;
        super::storage::storage_tasks::rebuild_price_table(&storage, &config_path);
        Ok(Self {
            proxy: ProxyController {
                inner: Arc::new(Mutex::new(super::proxy::ProxyRuntime::default())),
                bind_config: Arc::new(Mutex::new(bind_config.clone())),
            },
            runtime_config: RuntimeConfigStore::new(snapshot),
            jobs: JobRuntime::default(),
            storage,
            capture: Arc::new(Mutex::new(capture)),
            bind_config: Arc::new(Mutex::new(bind_config)),
            config_path,
            channels_config: Arc::new(Mutex::new(channels_config)),
            secrets,
            upstream_timeout_seconds: DEFAULT_UPSTREAM_TIMEOUT_SECONDS,
            require_client_auth: false,
        })
    }

    /// Require a client API key when this service is exposed by the server host.
    pub fn with_client_auth(mut self) -> Self {
        self.require_client_auth = true;
        self
    }

    pub async fn start_proxy(&self) -> Result<(), String> {
        if self.proxy.status().running {
            return Ok(());
        }
        // 与代理共享同一个 Arc：设置页保存捕获配置后，下一次请求立即生效。
        let capture = self.capture.clone();
        let bind_addr = self
            .bind_config
            .lock()
            .map(|value| value.clone().normalized().bind_addr())
            .unwrap_or_else(|_| ProxyBindConfig::default().bind_addr());
        let scores = self
            .storage
            .account_routing_scores()
            .map_err(|error| error.to_string())?;
        let shared = ProxySharedConfig {
            runtime_config: self.runtime_config.clone(),
            scores: Arc::new(Mutex::new(scores)),
            round_robin: Arc::new(Mutex::new(std::collections::HashMap::new())),
        };

        self.proxy
            .start_with_bind_auth(
                shared,
                self.storage.clone(),
                self.upstream_timeout_seconds,
                capture,
                &bind_addr,
                RateLimiter::new(600),
                self.config_path.clone(),
                self.require_client_auth,
            )
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn stop_proxy(&self) -> Result<(), String> {
        self.proxy.stop().await.map_err(|error| error.to_string())
    }

    pub fn set_bind_config(&self, config: ProxyBindConfig) -> Result<(), String> {
        let config = config.normalized();
        config
            .bind_addr()
            .parse::<std::net::SocketAddr>()
            .map_err(|_| "代理监听地址无效".to_string())?;
        *self
            .bind_config
            .lock()
            .map_err(|_| "锁定代理监听配置失败".to_string())? = config.clone();
        *self
            .proxy
            .bind_config
            .lock()
            .map_err(|_| "锁定代理状态配置失败".to_string())? = config;
        Ok(())
    }
}

fn initialize_channel_presets(
    storage: &Storage,
    channels_config: &ChannelsConfig,
) -> Result<(), String> {
    storage
        .ensure_preset_platform_urls(&channels_config.presets)
        .map_err(|error| error.to_string())?;
    let mut migration_presets = channels_config.presets.clone();
    for preset in builtin_channel_presets() {
        if !migration_presets
            .iter()
            .any(|current| current.id == preset.id)
        {
            migration_presets.push(preset);
        }
    }
    storage
        .ensure_missing_presets(&migration_presets)
        .and_then(|_| storage.sync_preset_maintained_config(&migration_presets))
        .and_then(|_| storage.ensure_preset_balance_query(&migration_presets))
        .and_then(|_| storage.ensure_preset_scrape_balance(&migration_presets))
        .and_then(|_| storage.ensure_preset_files_api(&migration_presets))
        .map_err(|error| error.to_string())
}

fn load_runtime_snapshot(
    storage: &Storage,
    channels_config: &ChannelsConfig,
) -> Result<RuntimeConfigSnapshot, String> {
    let mut channels = storage
        .list_channel_presets()
        .map_err(|error| error.to_string())?;
    if channels.is_empty() {
        channels = channels_config.presets.clone();
        storage
            .save_channel_presets(&channels)
            .map_err(|error| error.to_string())?;
    }

    let mut accounts = storage
        .list_channel_accounts()
        .map_err(|error| error.to_string())?;
    let original_count = accounts.len();
    accounts
        .retain(|account| !(account.id == "account-default" && account.api_key.trim().is_empty()));
    let mut accounts_changed = accounts.len() != original_count;
    let proxy_active = super::upstream_proxy::current().is_active();
    for account in &mut accounts {
        if account.use_upstream_proxy.is_none() {
            let used_model_proxy =
                super::channel_capability_adapter::channel_adapter(&account.channel_id)
                    .is_some_and(|adapter| adapter.uses_upstream_proxy_for_models);
            account.use_upstream_proxy = Some(proxy_active && used_model_proxy);
            accounts_changed = true;
        }
    }
    if accounts_changed {
        storage
            .save_channel_accounts(&accounts)
            .map_err(|error| error.to_string())?;
    }

    let virtual_models = storage
        .list_virtual_models()
        .map_err(|error| error.to_string())?;
    storage
        .save_virtual_models(&virtual_models)
        .map_err(|error| error.to_string())?;

    let routes = storage
        .list_route_candidates()
        .map_err(|error| error.to_string())?;
    let cleaned_routes: Vec<RouteCandidate> = routes
        .into_iter()
        .filter(|route| {
            if route.id == "route-auto-default" || route.account_id == "account-default" {
                return false;
            }
            if !route.enabled {
                return true;
            }
            !route.upstream_model.trim().is_empty()
                && channels
                    .iter()
                    .any(|channel| channel.id == route.channel_id)
                && accounts.iter().any(|account| {
                    account.id == route.account_id
                        && account.channel_id == route.channel_id
                        && account.enabled
                        && !account.api_key.trim().is_empty()
                })
        })
        .collect();
    let routes = channels_config.merge_default_routes(&cleaned_routes, &accounts, &channels);
    storage
        .save_route_candidates(&routes)
        .map_err(|error| error.to_string())?;

    let rules = storage
        .list_route_rules()
        .map_err(|error| error.to_string())?;
    Ok(RuntimeConfigSnapshot::new(
        channels,
        accounts,
        routes,
        rules,
        virtual_models,
    ))
}

fn parse_bind_config(value: &serde_json::Value) -> Option<ProxyBindConfig> {
    let bind = value.get("bind")?.as_object()?;
    let host = bind
        .get("host")
        .and_then(|value| value.as_str())
        .unwrap_or("127.0.0.1")
        .to_string();
    let port = bind
        .get("port")
        .and_then(|value| value.as_u64())
        .unwrap_or(18640) as u16;
    let default_client_token = bind
        .get("default_client_token")
        .and_then(|value| value.as_str())
        .unwrap_or("flowlet-local-token")
        .to_string();
    Some(
        ProxyBindConfig {
            allow_lan: host == "0.0.0.0",
            host,
            port,
            default_client_token,
        }
        .normalized(),
    )
}

pub fn load_bind_config_from_sqlite(storage: &Storage) -> ProxyBindConfig {
    storage
        .get_app_meta("proxy_bind_config")
        .unwrap_or_default()
        .and_then(|json| serde_json::from_str::<ProxyBindConfig>(&json).ok())
        .unwrap_or_default()
        .normalized()
}

pub fn load_channels_config_from(config_path: &Path) -> Result<ChannelsConfig, String> {
    let external = std::fs::read_to_string(config_path)
        .map_err(|error| format!("读取 config.json 失败 ({}): {error}", config_path.display()))
        .and_then(|content| parse_channels_config(&content, &config_path.display().to_string()));
    external.or_else(|external_error| {
        tracing::warn!(path = %config_path.display(), error = %external_error, "外部 config.json 无法提供渠道配置，回退到应用内置默认配置");
        parse_channels_config(DEFAULT_CONFIG_JSON, "应用内置 config.json").map_err(|fallback| {
            format!("外部渠道配置不可用: {external_error}; 内置渠道配置也不可用: {fallback}")
        })
    })
}

pub fn merge_builtin_config(mut external: ChannelsConfig) -> ChannelsConfig {
    let Ok(builtin) = parse_channels_config(DEFAULT_CONFIG_JSON, "应用内置 config.json") else {
        return external;
    };
    for preset in builtin.presets {
        if !external
            .presets
            .iter()
            .any(|current| current.id == preset.id)
        {
            external.presets.push(preset);
        }
    }
    // Ignore obsolete ChatGPT API browser-sync settings from older portable configs.
    external.scrape.remove("openai-api");
    if let Some(preset) = external
        .presets
        .iter_mut()
        .find(|preset| preset.id == "openai-api")
    {
        preset.supports_scrape_balance = false;
    }
    for price in builtin.prices {
        if !external.prices.iter().any(|current| {
            current.channel_id == price.channel_id && current.upstream_model == price.upstream_model
        }) {
            external.prices.push(price);
        }
    }
    for (channel_id, endpoints) in builtin.endpoints {
        external.endpoints.entry(channel_id).or_insert(endpoints);
    }
    for (channel_id, models) in builtin.default_exposed_models {
        external
            .default_exposed_models
            .entry(channel_id)
            .or_insert(models);
    }
    external
}

fn parse_channels_config(content: &str, source: &str) -> Result<ChannelsConfig, String> {
    let json =
        serde_json::from_str(content).map_err(|error| format!("解析 {source} 失败: {error}"))?;
    ChannelsConfig::from_config_json(&json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vibetoken_is_merged_into_legacy_external_config() {
        let mut external = parse_channels_config(DEFAULT_CONFIG_JSON, "test").unwrap();
        external.presets.retain(|p| p.id != "vibetoken");
        external.endpoints.remove("vibetoken");
        for _ in 0..2 {
            external = merge_builtin_config(external);
        }
        assert_eq!(
            external
                .presets
                .iter()
                .filter(|p| p.id == "vibetoken")
                .count(),
            1
        );
        assert_eq!(
            external.vibetoken_balance_endpoint(),
            "https://vibetoken.cn/api/v1/billing/balance"
        );
        assert_eq!(
            external.models_endpoint_url("vibetoken").as_deref(),
            Some("https://vibetoken.cn/v1/models")
        );
        external.endpoints.remove("vibetoken");
        assert_eq!(
            external.models_endpoint_url("vibetoken").as_deref(),
            Some("https://vibetoken.cn/v1/models")
        );
        assert_eq!(
            external.vibetoken_balance_endpoint(),
            "https://vibetoken.cn/api/v1/billing/balance"
        );
    }

    #[test]
    fn openai_browser_sync_is_removed_even_from_legacy_config() {
        let mut external = parse_channels_config(DEFAULT_CONFIG_JSON, "test").unwrap();
        let legacy_mode = external.scrape.get("zhipu").unwrap().clone();
        external.scrape.insert("openai-api".into(), legacy_mode);
        external
            .presets
            .iter_mut()
            .find(|p| p.id == "openai-api")
            .unwrap()
            .supports_scrape_balance = true;
        for _ in 0..2 {
            external = merge_builtin_config(external);
        }
        assert!(
            !external
                .presets
                .iter()
                .find(|p| p.id == "openai-api")
                .unwrap()
                .supports_scrape_balance
        );
        assert!(!external.scrape.contains_key("openai-api"));
    }

    #[tokio::test]
    async fn services_start_with_empty_accounts_and_routes() {
        let root = std::env::temp_dir().join(format!("flowlet-services-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let services =
            FlowletServices::open(root.join("flowlet.sqlite"), root.join("missing.json")).unwrap();

        assert!(services.runtime_config.snapshot().accounts.is_empty());
        let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        services
            .set_bind_config(ProxyBindConfig {
                host: "127.0.0.1".to_string(),
                port,
                allow_lan: false,
                default_client_token: "test-token".to_string(),
            })
            .unwrap();
        services.start_proxy().await.unwrap();
        assert!(services.proxy.status().running);
        services.stop_proxy().await.unwrap();
        drop(services);
        if let Err(error) = std::fs::remove_dir_all(&root) {
            tracing::debug!(path = %root.display(), error = %error, "Windows 尚未释放测试数据库句柄，保留临时目录");
        }
    }

    #[test]
    fn missing_external_config_uses_embedded_defaults() {
        let path = std::env::temp_dir().join(format!("missing-{}.json", uuid::Uuid::new_v4()));
        let config = load_channels_config_from(&path).unwrap();
        assert!(config.presets.iter().any(|preset| preset.id == "longcat"));
    }

    #[test]
    fn old_config_without_channels_uses_embedded_defaults() {
        let path = std::env::temp_dir().join(format!("old-{}.json", uuid::Uuid::new_v4()));
        std::fs::write(&path, r#"{"ua_rules": []}"#).unwrap();
        let config = load_channels_config_from(&path).unwrap();
        std::fs::remove_file(path).unwrap();

        for channel in ["longcat", "deepseek", "kimi", "qwen"] {
            assert!(config.presets.iter().any(|preset| preset.id == channel));
        }
    }
}
