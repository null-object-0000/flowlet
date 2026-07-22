//! 后台 webview 控制台抓取的核心逻辑:窗口构建、导航、拦截响应缓冲、
//! eval 执行 extractor、登录检测。
//!
//! 设计要点:
//! - 窗口由 Rust command 创建,挂 on_navigation + on_page_load 钩子,注入 interceptor_js。
//! - 拦截响应由页面 JS 通过 IPC(handle_intercepted_response)回传,暂存到 AppState.scrape_pending。
//! - 收齐后 Rust 侧 eval_with_callback 执行 extractor_js,拿到结构化结果。

use crate::core::channels_config::ChannelsConfig;
use std::collections::HashMap;

/// 单个抓取模式的运行时配置(从 ChannelsConfig 解析后传入)。
#[derive(Debug, Clone)]
pub struct ScrapeModeRuntime {
    pub console_url: String,
    pub interceptor_js: String,
    pub extractor_js: String,
    pub aggregate: bool,
}

/// 根据账号的 resource_mode / 渠道,解析出本次抓取的模式配置。
pub fn resolve_scrape_mode(
    channels_config: &ChannelsConfig,
    channel_id: &str,
    resource_mode: Option<&str>,
) -> Option<ScrapeModeRuntime> {
    let mode_key = match channel_id {
        "longcat" => match resource_mode {
            Some("pay_as_you_go") => "pay_as_you_go",
            _ => "token_pack",
        },
        "qwen" => "token_plan",
        _ => return None,
    };
    let cfg = channels_config.scrape_config(channel_id, mode_key)?;
    Some(ScrapeModeRuntime {
        console_url: cfg.console_url.clone(),
        interceptor_js: cfg.interceptor_js.clone(),
        extractor_js: cfg.extractor_js.clone(),
        aggregate: cfg.aggregate,
    })
}

/// 构建 per-account 后台抓取 webview(隐藏)。
pub fn build_scrape_webview(
    app: &tauri::AppHandle,
    account_id: &str,
    mode: &ScrapeModeRuntime,
) -> Result<tauri::WebviewWindow, String> {
    let label = format!("scrape-{account_id}");
    let url = tauri::WebviewUrl::External(
        mode.console_url
            .parse()
            .map_err(|e| format!("抓取控制台 URL 解析失败: {e}"))?,
    );
    let interceptor = mode.interceptor_js.clone();
    let window = tauri::webview::WebviewWindowBuilder::new(app, label, url)
        .title("Flowlet · 控制台抓取")
        .inner_size(900.0, 720.0)
        .visible(false)
        .initialization_script(interceptor)
        .initialization_script_for_all_frames(
            "window.__flowlet_scrape_active = true;".to_string(),
        )
        .build()
        .map_err(|e| format!("构建抓取 webview 失败: {e}"))?;
    Ok(window)
}

/// 根据响应 URL 判断它属于哪个抓取阶段(用于聚合模式分槽)。
/// 注意:
/// - URL 可能含 URL 编码(%2F = /),所以同时匹配编码与解码形式。
/// - 顺序有讲究:具体的复合路径(如 api-usage/summary)优先于泛匹配(如 usage)。
pub fn classify_response_url(url: &str) -> &'static str {
    if url.contains("subscription") && !url.contains("token-plan-individual") {
        "subscription"
    } else if url.contains("quota-config") {
        "quota_config"
    } else if url.contains("token-packs/summary") {
        "token_packs_summary"
    } else if url.contains("api-usage/summary") {
        "api_usage_summary"
    } else if url.contains("usage") {
        // 覆盖 /usage 与 %2Fusage 两种形式
        "usage"
    } else {
        "unknown"
    }
}

/// 聚合模式:检查是否收齐所有必需的响应槽。
pub fn aggregate_complete(slots: &HashMap<String, String>, mode: &ScrapeModeRuntime) -> bool {
    if mode.aggregate {
        // Qwen token_plan 需要 subscription + quota_config + usage
        slots.contains_key("subscription")
            && slots.contains_key("quota_config")
            && slots.contains_key("usage")
    } else {
        // 单响应模式:任意一个目标槽到位即可
        slots
            .keys()
            .any(|k| k == "token_packs_summary" || k == "api_usage_summary")
    }
}

/// 组装聚合模式的 bundle(传给 extractor 的 JSON 对象)。
pub fn build_aggregate_bundle(slots: &HashMap<String, String>) -> serde_json::Value {
    let mut bundle = serde_json::Map::new();
    for (key, body) in slots {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
            bundle.insert(key.clone(), value);
        }
    }
    serde_json::Value::Object(bundle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_response_url() {
        assert_eq!(
            classify_response_url(
                "https://cs-data.qianwenai.com/data/api.json?...%2Fsubscription"
            ),
            "subscription"
        );
        assert_eq!(
            classify_response_url(
                "https://cs-data.qianwenai.com/data/api.json?...%2Fquota-config"
            ),
            "quota_config"
        );
        assert_eq!(
            classify_response_url("https://cs-data.qianwenai.com/data/api.json?...%2Fusage"),
            "usage"
        );
        assert_eq!(
            classify_response_url(
                "https://longcat.chat/api/pay/quota/metering/token-packs/summary"
            ),
            "token_packs_summary"
        );
        assert_eq!(
            classify_response_url(
                "https://longcat.chat/api/pay/quota/metering/api-usage/summary"
            ),
            "api_usage_summary"
        );
    }

    #[test]
    fn test_resolve_scrape_mode_longcat_token_pack() {
        use crate::core::channels_config::ChannelsConfig;
    use crate::core::config::ChannelPreset;
        let config = ChannelsConfig {
            presets: vec![ChannelPreset::longcat()],
            prices: vec![],
            default_exposed_models: HashMap::new(),
            flowlet_tiers: HashMap::new(),
            endpoints: HashMap::new(),
            scrape: HashMap::new(),
        };
        // scrape 为空时返回 None(真实场景会从 config.json 加载)
        assert!(resolve_scrape_mode(&config, "longcat", Some("token_pack")).is_none());
        assert!(resolve_scrape_mode(&config, "qwen", None).is_none());
    }

    #[test]
    fn test_aggregate_complete() {
        let mode_multi = ScrapeModeRuntime {
            console_url: "https://example.com".to_string(),
            interceptor_js: String::new(),
            extractor_js: String::new(),
            aggregate: true,
        };
        let mode_single = ScrapeModeRuntime {
            console_url: "https://example.com".to_string(),
            interceptor_js: String::new(),
            extractor_js: String::new(),
            aggregate: false,
        };
        let mut slots = HashMap::new();
        assert!(!aggregate_complete(&slots, &mode_multi));
        slots.insert("subscription".to_string(), "{}".to_string());
        slots.insert("quota_config".to_string(), "{}".to_string());
        assert!(!aggregate_complete(&slots, &mode_multi));
        slots.insert("usage".to_string(), "{}".to_string());
        assert!(aggregate_complete(&slots, &mode_multi));

        let mut slots_single = HashMap::new();
        assert!(!aggregate_complete(&slots_single, &mode_single));
        slots_single.insert("token_packs_summary".to_string(), "{}".to_string());
        assert!(aggregate_complete(&slots_single, &mode_single));
    }
}
