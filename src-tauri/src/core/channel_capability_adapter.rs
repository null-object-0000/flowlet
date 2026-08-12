use super::channels_config::ChannelsConfig;
use super::config::{ChannelAccount, ChannelPreset};
use super::plugin_registry::plugin_registry;
use super::presets::{BalanceQueryResult, ModelSyncResult};
use super::sync::{
    query_deepseek_balance, query_kimi_balance, query_openrouter_balance, sync_deepseek_models,
    sync_kimi_models, sync_longcat_models, sync_openai_compatible_models, sync_qwen_models,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ModelSyncAdapter {
    LongCat,
    DeepSeek,
    Kimi,
    Qwen,
    OpenAiCompatible {
        use_configured_models_endpoint: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BalanceQueryAdapter {
    DeepSeek,
    Kimi,
    OpenRouter,
}

/// 编译进 Flowlet 的渠道行为适配器。
///
/// `plugin-registry.json` 只负责把渠道贡献绑定到 adapter id；这里负责描述该 adapter
/// 复用哪套底层实现。配置中的 `supports_*` 字段仍是产品能力声明，二者不会互相覆盖。
#[derive(Debug)]
pub(crate) struct ChannelCapabilityAdapter {
    pub id: &'static str,
    pub model_sync: ModelSyncAdapter,
    pub balance_query: Option<BalanceQueryAdapter>,
    pub strips_openai_v1_path: bool,
}

const ADAPTERS: &[ChannelCapabilityAdapter] = &[
    ChannelCapabilityAdapter {
        id: "longcat",
        model_sync: ModelSyncAdapter::LongCat,
        balance_query: None,
        strips_openai_v1_path: false,
    },
    ChannelCapabilityAdapter {
        id: "deepseek",
        model_sync: ModelSyncAdapter::DeepSeek,
        balance_query: Some(BalanceQueryAdapter::DeepSeek),
        strips_openai_v1_path: false,
    },
    ChannelCapabilityAdapter {
        id: "kimi",
        model_sync: ModelSyncAdapter::Kimi,
        balance_query: Some(BalanceQueryAdapter::Kimi),
        strips_openai_v1_path: false,
    },
    ChannelCapabilityAdapter {
        id: "qwen",
        model_sync: ModelSyncAdapter::Qwen,
        balance_query: None,
        strips_openai_v1_path: false,
    },
    ChannelCapabilityAdapter {
        id: "custom",
        model_sync: ModelSyncAdapter::OpenAiCompatible {
            use_configured_models_endpoint: false,
        },
        balance_query: None,
        strips_openai_v1_path: false,
    },
    ChannelCapabilityAdapter {
        id: "zhipu",
        model_sync: ModelSyncAdapter::OpenAiCompatible {
            use_configured_models_endpoint: true,
        },
        balance_query: None,
        strips_openai_v1_path: true,
    },
    ChannelCapabilityAdapter {
        id: "openrouter",
        model_sync: ModelSyncAdapter::OpenAiCompatible {
            use_configured_models_endpoint: true,
        },
        balance_query: Some(BalanceQueryAdapter::OpenRouter),
        strips_openai_v1_path: false,
    },
];

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
    let result = match adapter.model_sync {
        ModelSyncAdapter::LongCat => sync_longcat_models(account, config).await,
        ModelSyncAdapter::DeepSeek => sync_deepseek_models(account, config).await,
        ModelSyncAdapter::Kimi => sync_kimi_models(account, config).await,
        ModelSyncAdapter::Qwen => sync_qwen_models(account, config).await,
        ModelSyncAdapter::OpenAiCompatible {
            use_configured_models_endpoint,
        } => {
            let models_url = use_configured_models_endpoint
                .then(|| config.models_endpoint_url(&account.channel_id))
                .flatten();
            sync_openai_compatible_models(account, preset, models_url).await
        }
    };
    Ok(result)
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
        Some(BalanceQueryAdapter::DeepSeek) => query_deepseek_balance(account, config).await,
        Some(BalanceQueryAdapter::Kimi) => query_kimi_balance(account, config).await,
        Some(BalanceQueryAdapter::OpenRouter) => query_openrouter_balance(account, config).await,
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
        assert_eq!(
            channel_adapter("longcat").unwrap().model_sync,
            ModelSyncAdapter::LongCat
        );
        assert_eq!(
            channel_adapter("custom").unwrap().model_sync,
            ModelSyncAdapter::OpenAiCompatible {
                use_configured_models_endpoint: false
            }
        );
        assert_eq!(
            channel_adapter("zhipu").unwrap().model_sync,
            ModelSyncAdapter::OpenAiCompatible {
                use_configured_models_endpoint: true
            }
        );
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
