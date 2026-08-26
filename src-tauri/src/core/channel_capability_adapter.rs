use super::channels_config::ChannelsConfig;
use super::config::{ChannelAccount, ChannelPreset};
use super::plugin_registry::plugin_registry;
use super::presets::{BalanceQueryResult, ModelSyncResult};
use std::future::Future;
use std::pin::Pin;

mod adapters;

use adapters::ADAPTERS;

type ModelSyncFuture<'a> = Pin<Box<dyn Future<Output = ModelSyncResult> + Send + 'a>>;
type ModelSyncFn =
    for<'a> fn(&'a ChannelAccount, &'a ChannelPreset, &'a ChannelsConfig) -> ModelSyncFuture<'a>;
type BalanceQueryFuture<'a> = Pin<Box<dyn Future<Output = BalanceQueryResult> + Send + 'a>>;
type BalanceQueryFn = for<'a> fn(&'a ChannelAccount, &'a ChannelsConfig) -> BalanceQueryFuture<'a>;

#[derive(Clone, Copy)]
struct ScrapeResponseAdapter {
    classify: fn(&str) -> Option<&'static str>,
    merge: fn(&str, &str, &str) -> Option<String>,
    satisfies: fn(&str, &str) -> Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConsoleScrapeAdapter {
    None,
    Fixed(&'static str),
    /// 按账号 resource_mode 选择抓取模式键。Qwen 双资源模式：token_plan 抓订阅
    /// 套餐端点，pay_as_you_go 抓福利页免费额度与余额。
    ResourceModes(&'static [(&'static str, &'static str)]),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LoginPageAdapter {
    None,
    Generic,
    GenericOrHost(&'static str),
}

/// 编译进 Flowlet 的渠道行为适配器。
///
/// `plugin-registry.json` 只负责把渠道贡献绑定到 adapter id；这里负责描述该 adapter
/// 复用哪套底层实现。配置中的 `supports_*` 字段仍是产品能力声明，二者不会互相覆盖。
pub(crate) struct ChannelCapabilityAdapter {
    pub id: &'static str,
    preset_factory: fn() -> ChannelPreset,
    model_sync: ModelSyncFn,
    balance_query: Option<BalanceQueryFn>,
    pub strips_openai_v1_path: bool,
    console_scrape: ConsoleScrapeAdapter,
    login_page: LoginPageAdapter,
    scrape_response: Option<ScrapeResponseAdapter>,
}

pub(crate) fn classify_scrape_response_url(url: &str) -> &'static str {
    ADAPTERS
        .iter()
        .filter_map(|adapter| adapter.scrape_response)
        .find_map(|adapter| (adapter.classify)(url))
        .unwrap_or("unknown")
}

pub(crate) fn merge_scrape_response(kind: &str, existing: &str, incoming: &str) -> Option<String> {
    ADAPTERS
        .iter()
        .filter_map(|adapter| adapter.scrape_response)
        .find_map(|adapter| (adapter.merge)(kind, existing, incoming))
}

/// 判断已捕获的响应是否满足槽位。
///
/// 同一槽位名可能被多个渠道共享（如 `token_packs_list` 同时用于 LongCat 与
/// Z.AI，但两者业务信封不同：LongCat 用 `data.items`，Z.AI 用顶层 `rows`）。
/// 不能用 `find_map` 取第一个 adapter 的结论——LongCat 的 `Some(false)` 会抢在
/// Z.AI 的 `Some(true)` 之前返回，导致 Z.AI 的资源包响应被误判为未抓全。这里
/// 改为「任一 adapter 判定满足即满足」；所有处理该槽位的 adapter 都判定不满足
/// 才视为不满足；没有 adapter 处理该槽位时退回“合法 JSON 即视为到位”。
pub(crate) fn scrape_response_satisfies_slot(kind: &str, body: &str) -> bool {
    let mut saw_rejection = false;
    for adapter in ADAPTERS.iter().filter_map(|adapter| adapter.scrape_response) {
        match (adapter.satisfies)(kind, body) {
            Some(true) => return true,
            Some(false) => saw_rejection = true,
            None => {}
        }
    }
    if saw_rejection {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(body).is_ok()
}

pub(crate) fn has_channel_capability_adapter(adapter_id: &str) -> bool {
    channel_capability_adapter(adapter_id).is_some()
}

pub(crate) fn channel_capability_adapter(
    adapter_id: &str,
) -> Option<&'static ChannelCapabilityAdapter> {
    ADAPTERS.iter().find(|adapter| adapter.id == adapter_id)
}

pub(crate) fn channel_adapter(channel_id: &str) -> Option<&'static ChannelCapabilityAdapter> {
    let contribution = plugin_registry().channel(channel_id)?;
    channel_capability_adapter(&contribution.adapter_id)
}

pub(crate) fn supports_official_balance(channel_id: &str) -> bool {
    channel_adapter(channel_id).is_some_and(|adapter| adapter.balance_query.is_some())
}

#[cfg(test)]
pub(crate) fn has_model_sync(channel_id: &str) -> bool {
    channel_adapter(channel_id).is_some()
}

#[cfg(test)]
pub(crate) fn configured_console_scrape_mode_key(channel_id: &str) -> Option<&'static str> {
    match channel_adapter(channel_id).map(|adapter| adapter.console_scrape) {
        Some(ConsoleScrapeAdapter::Fixed(mode_key)) => Some(mode_key),
        Some(ConsoleScrapeAdapter::ResourceModes(modes)) => {
            modes.first().map(|(_, mode_key)| *mode_key)
        }
        _ => None,
    }
}

pub(crate) fn builtin_channel_presets() -> Result<Vec<ChannelPreset>, String> {
    plugin_registry()
        .channels()
        .iter()
        .map(|contribution| {
            let adapter =
                channel_capability_adapter(&contribution.adapter_id).ok_or_else(|| {
                    format!(
                        "渠道插件 {} 缺少内置 Capability Adapter：{}",
                        contribution.id, contribution.adapter_id
                    )
                })?;
            let preset = (adapter.preset_factory)();
            if preset.id != contribution.id {
                return Err(format!(
                    "渠道插件 {} 的预设工厂返回了不匹配的渠道 ID：{}",
                    contribution.id, preset.id
                ));
            }
            Ok(preset)
        })
        .collect()
}

pub(crate) fn console_scrape_mode_key(
    channel_id: &str,
    resource_mode: Option<&str>,
) -> Option<&'static str> {
    match channel_adapter(channel_id)?.console_scrape {
        ConsoleScrapeAdapter::None => None,
        ConsoleScrapeAdapter::Fixed(mode_key) => Some(mode_key),
        ConsoleScrapeAdapter::ResourceModes(modes) => modes
            .iter()
            .find(|(required, _)| Some(*required) == resource_mode)
            .map(|(_, mode_key)| *mode_key),
    }
}

/// 只识别 Adapter 明确声明的登录页面。目标响应未出现、页面加载慢或拦截器异常
/// 都不能据此判定未登录。
pub(crate) fn is_explicit_login_url(channel_id: &str, page_url: &str) -> bool {
    let Some(adapter) = channel_adapter(channel_id) else {
        return false;
    };
    let url = page_url.to_ascii_lowercase();
    let has_login_path = url.contains("/login")
        || url.contains("/signin")
        || url.contains("/sign-in")
        || url.contains("passport")
        || url.contains("oauth");
    match adapter.login_page {
        LoginPageAdapter::None => false,
        LoginPageAdapter::Generic => has_login_path,
        LoginPageAdapter::GenericOrHost(host) => has_login_path || url.contains(host),
    }
}

pub(crate) async fn sync_channel_models(
    account: &ChannelAccount,
    preset: Option<&ChannelPreset>,
    config: &ChannelsConfig,
) -> Result<ModelSyncResult, String> {
    let preset = preset.ok_or_else(|| format!("渠道 {} 缺少运行时模板", account.channel_id))?;
    if !preset.supports_model_list {
        return Ok(ModelSyncResult {
            models_synced: 0,
            models: Vec::new(),
            errors: vec!["当前渠道未声明模型列表能力".to_string()],
        });
    }
    let adapter = channel_adapter(&account.channel_id).ok_or_else(|| {
        format!(
            "渠道 {} 未注册可用的 Capability Adapter",
            account.channel_id
        )
    })?;
    Ok((adapter.model_sync)(account, preset, config).await)
}

pub(crate) async fn query_channel_balance(
    account: &ChannelAccount,
    config: &ChannelsConfig,
) -> Result<BalanceQueryResult, String> {
    let adapter = channel_adapter(&account.channel_id).ok_or_else(|| {
        format!(
            "渠道 {} 未注册可用的 Capability Adapter",
            account.channel_id
        )
    })?;
    let result = match adapter.balance_query {
        Some(query) => query(account, config).await,
        None => BalanceQueryResult {
            balance: None,
            currency: None,
            is_available: false,
            error: Some("当前渠道不支持官方余额查询".to_string()),
        },
    };
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_adapters_expose_stable_capability_strategies() {
        assert!(has_channel_capability_adapter("longcat"));
        assert!(has_channel_capability_adapter("custom"));
        assert!(has_channel_capability_adapter("zhipu"));
        assert!(channel_adapter("zhipu").unwrap().strips_openai_v1_path);
        assert!(!channel_adapter("openrouter").unwrap().strips_openai_v1_path);
    }

    #[test]
    fn official_balance_capability_is_adapter_driven() {
        for channel_id in ["deepseek", "kimi", "openrouter"] {
            assert!(supports_official_balance(channel_id), "{channel_id}");
        }
        for channel_id in ["longcat", "qwen", "custom", "zhipu", "missing"] {
            assert!(!supports_official_balance(channel_id), "{channel_id}");
        }
    }

    #[test]
    fn every_registered_channel_builds_a_matching_preset() {
        let presets = builtin_channel_presets().expect("内置渠道贡献都应能创建预设");
        let contribution_ids = plugin_registry().channel_ids().collect::<Vec<_>>();
        let preset_ids = presets
            .iter()
            .map(|preset| preset.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(preset_ids, contribution_ids);
    }

    #[test]
    fn console_scrape_policy_is_adapter_driven() {
        assert_eq!(
            console_scrape_mode_key("longcat", Some("pay_as_you_go")),
            Some("hybrid")
        );
        assert_eq!(
            console_scrape_mode_key("qwen", Some("token_plan")),
            Some("token_plan")
        );
        assert_eq!(
            console_scrape_mode_key("qwen", Some("pay_as_you_go")),
            Some("freetier")
        );
        assert_eq!(
            console_scrape_mode_key("zhipu", Some("pay_as_you_go")),
            Some("paygo")
        );
        assert_eq!(console_scrape_mode_key("qwen", None), None);
        assert_eq!(console_scrape_mode_key("zhipu", None), None);
        assert_eq!(console_scrape_mode_key("deepseek", None), None);
    }

    #[test]
    fn login_page_policy_is_adapter_driven() {
        assert!(is_explicit_login_url(
            "zhipu",
            "https://www.bigmodel.cn/login?redirect=%2Ffinance-center"
        ));
        assert!(!is_explicit_login_url(
            "zhipu",
            "https://www.bigmodel.cn/finance-center/finance/overview"
        ));
        assert!(is_explicit_login_url(
            "longcat",
            "https://longcat.chat/login"
        ));
        assert!(is_explicit_login_url(
            "qwen",
            "https://account.aliyun.com/login/login.htm"
        ));
        assert!(!is_explicit_login_url(
            "qwen",
            "https://platform.qianwenai.com/home/billing"
        ));
        assert!(!is_explicit_login_url(
            "deepseek",
            "https://example.com/login"
        ));
    }

    #[test]
    fn shared_slot_satisfies_lets_any_adapter_accept() {
        // Z.AI 的 token_packs_list 用顶层 `rows`；LongCat 的 token_packs_list 用
        // `data.items`。两者共享槽位名，LongCat 先注册，其 `Some(false)` 不应抢在
        // Z.AI 的 `Some(true)` 之前返回。
        let zhipu_pack_list = r#"{"code":200,"rows":[{"tokenBalance":1000,"availableBalance":400}],"total":1}"#;
        assert!(scrape_response_satisfies_slot("token_packs_list", zhipu_pack_list));

        // LongCat 的完整历史列表仍按 LongCat 口径判定。
        let longcat_history = r#"{"code":0,"data":{"activeCount":0,"historyCount":1,"total":1,"pageSize":9,"items":[{"resourceId":"h-1","statusCode":4}]}}"#;
        assert!(scrape_response_satisfies_slot("token_packs_list", longcat_history));

        // 鉴权错误（两种信封都判定不满足）不会被误判为已捕获。
        let auth_error = r#"{"code":401,"msg":"unauthorized"}"#;
        assert!(!scrape_response_satisfies_slot("token_packs_list", auth_error));
    }

    #[tokio::test]
    async fn model_sync_requires_the_preset_capability_declaration() {
        let account = ChannelAccount {
            channel_id: "deepseek".to_string(),
            ..Default::default()
        };
        let preset = ChannelPreset {
            id: "deepseek".to_string(),
            supports_model_list: false,
            ..Default::default()
        };
        let config_json: serde_json::Value =
            serde_json::from_str(super::super::channels_config::DEFAULT_CONFIG_JSON)
                .expect("内置渠道配置 JSON 应可解析");
        let config = ChannelsConfig::from_config_json(&config_json).expect("内置渠道配置应可解析");

        let result = sync_channel_models(&account, Some(&preset), &config)
            .await
            .expect("能力关闭应返回可处理结果");

        assert_eq!(result.models_synced, 0);
        assert_eq!(result.errors, vec!["当前渠道未声明模型列表能力"]);
    }
}
