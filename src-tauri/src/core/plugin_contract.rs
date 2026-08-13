use super::agent_environment::has_environment_adapter;
use super::agent_global_config::has_global_config_adapter;
use super::agent_session_adapter::has_session_adapter;
use super::agent_task_runner::has_runner_adapter;
use super::channel_capability_adapter::{
    builtin_channel_presets, configured_console_scrape_mode_key, has_model_sync,
    supports_official_balance,
};
use super::channels_config::{ChannelsConfig, DEFAULT_CONFIG_JSON};
use super::config::ProtocolType;
use super::model_catalog::model_catalog;
use super::plugin_registry::plugin_registry;
use std::collections::HashSet;

fn embedded_channels_config() -> ChannelsConfig {
    let value: serde_json::Value =
        serde_json::from_str(DEFAULT_CONFIG_JSON).expect("内置 config.json 应为合法 JSON");
    ChannelsConfig::from_config_json(&value).expect("内置渠道配置应可解析")
}

#[test]
fn registered_channels_have_complete_runtime_contracts() {
    let registry = plugin_registry();
    let config = embedded_channels_config();
    let registered = registry.channel_ids().collect::<HashSet<_>>();
    let configured = config
        .presets
        .iter()
        .map(|preset| preset.id.as_str())
        .collect::<HashSet<_>>();
    assert_eq!(
        configured, registered,
        "plugin-registry.json 与 config.json 的渠道集合必须一致"
    );

    let factory_presets = builtin_channel_presets().expect("渠道预设工厂契约应完整");
    let factory_ids = factory_presets
        .iter()
        .map(|preset| preset.id.as_str())
        .collect::<HashSet<_>>();
    assert_eq!(factory_ids, registered, "渠道预设工厂必须覆盖全部贡献");

    for preset in &config.presets {
        let channel_id = preset.id.as_str();
        assert!(!preset.name.trim().is_empty(), "{channel_id} 缺少名称");
        assert!(!preset.vendor.trim().is_empty(), "{channel_id} 缺少 vendor");
        assert!(
            !preset.supported_protocols.is_empty(),
            "{channel_id} 至少需要一种协议"
        );
        let protocols = preset
            .supported_protocols
            .iter()
            .map(ProtocolType::as_str)
            .collect::<HashSet<_>>();
        assert_eq!(
            protocols.len(),
            preset.supported_protocols.len(),
            "{channel_id} 存在重复协议"
        );
        if channel_id != "custom" {
            if protocols.contains("openai") || protocols.contains("responses") {
                assert!(
                    !preset.openai_base_url.trim().is_empty(),
                    "{channel_id} 声明 OpenAI/Responses 协议但缺少 OpenAI Base URL"
                );
            }
            if protocols.contains("anthropic") {
                assert!(
                    !preset.anthropic_base_url.trim().is_empty(),
                    "{channel_id} 声明 Anthropic 协议但缺少 Anthropic Base URL"
                );
            }
        }

        assert_eq!(
            preset.supports_model_list,
            has_model_sync(channel_id),
            "{channel_id} 的模型列表声明与 Adapter 实现不一致"
        );
        assert_eq!(
            preset.supports_balance_query,
            supports_official_balance(channel_id),
            "{channel_id} 的余额声明与 Adapter 实现不一致"
        );
        let scrape_mode_key = configured_console_scrape_mode_key(channel_id);
        assert_eq!(
            preset.supports_scrape_balance,
            scrape_mode_key.is_some(),
            "{channel_id} 的控制台抓取声明与 Adapter 策略不一致"
        );
        if let Some(mode_key) = scrape_mode_key {
            let scrape = config
                .scrape_config(channel_id, mode_key)
                .unwrap_or_else(|| {
                    panic!("{channel_id} 的 Adapter 引用了缺失的 scrape mode：{mode_key}")
                });
            assert!(
                !scrape.console_url.trim().is_empty()
                    && !scrape.interceptor_js.trim().is_empty()
                    && !scrape.extractor_js.trim().is_empty(),
                "{channel_id}/{mode_key} 的控制台抓取配置不完整"
            );
            if scrape.aggregate {
                assert!(
                    !scrape.required_slots.is_empty(),
                    "{channel_id}/{mode_key} 聚合抓取缺少 required_slots"
                );
            }
        }

        if !preset.default_model.trim().is_empty() {
            assert!(
                model_catalog().find(&preset.default_model).is_some(),
                "{channel_id} 的默认模型 {} 不在模型目录中",
                preset.default_model
            );
        }
    }
}

#[test]
fn model_catalog_owners_are_registered_channels() {
    let registered = plugin_registry().channel_ids().collect::<HashSet<_>>();
    for model in model_catalog().models() {
        assert!(
            registered.contains(model.owner_channel_id.as_str()),
            "模型 {} 的官方归属渠道 {} 未注册",
            model.id,
            model.owner_channel_id
        );
    }
}

#[test]
fn registered_agents_resolve_every_compiled_adapter() {
    for agent in plugin_registry().agents() {
        assert!(
            has_environment_adapter(&agent.environment_adapter_id),
            "{} 缺少环境 Adapter {}",
            agent.id,
            agent.environment_adapter_id
        );
        assert!(
            has_global_config_adapter(&agent.global_config_adapter_id),
            "{} 缺少全局配置 Adapter {}",
            agent.id,
            agent.global_config_adapter_id
        );
        assert!(
            has_session_adapter(&agent.session_adapter_id),
            "{} 缺少会话 Adapter {}",
            agent.id,
            agent.session_adapter_id
        );
        assert!(
            has_runner_adapter(&agent.runner_adapter_id),
            "{} 缺少执行 Adapter {}",
            agent.id,
            agent.runner_adapter_id
        );
        assert!(
            matches!(agent.endpoint_suffix.as_str(), "/v1" | "/anthropic"),
            "{} 的代理端点不合法",
            agent.id
        );
        let surfaces = agent
            .surfaces
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        assert_eq!(
            surfaces.len(),
            agent.surfaces.len(),
            "{} 声明了重复 Surface",
            agent.id
        );
        assert!(
            surfaces
                .iter()
                .all(|surface| matches!(*surface, "cli" | "desktop")),
            "{} 声明了未知 Surface",
            agent.id
        );
    }
}
