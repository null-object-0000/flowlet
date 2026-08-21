use super::super::*;

fn sync<'a>(
    account: &'a ChannelAccount,
    _preset: &'a ChannelPreset,
    config: &'a ChannelsConfig,
) -> ModelSyncFuture<'a> {
    Box::pin(crate::core::sync::sync_qwen_models(account, config))
}

pub(super) const ADAPTER: ChannelCapabilityAdapter = ChannelCapabilityAdapter {
    id: "qwen",
    preset_factory: ChannelPreset::qwen,
    model_sync: sync,
    balance_query: None,
    strips_openai_v1_path: false,
    console_scrape: ConsoleScrapeAdapter::ResourceMode {
        resource_mode: "token_plan",
        mode_key: "token_plan",
    },
    login_page: LoginPageAdapter::GenericOrHost("account.aliyun.com"),
    scrape_response: Some(ScrapeResponseAdapter {
        classify: classify_scrape_response,
        merge: no_scrape_response_merge,
        satisfies: scrape_response_satisfies,
    }),
};

fn classify_scrape_response(url: &str) -> Option<&'static str> {
    let normalized = url.to_ascii_lowercase().replace("%2f", "/");
    if normalized.contains("/tokenplan/personal/api/v2/subscription") {
        Some("subscription")
    } else if normalized.contains("/tokenplan/personal/api/v2/quota-config") {
        Some("quota_config")
    } else if normalized.contains("/tokenplan/personal/api/v2/reset-card/list") {
        Some("reset_card_list")
    } else if normalized.contains("/tokenplan/personal/api/v2/usage") {
        Some("usage")
    } else {
        None
    }
}

fn no_scrape_response_merge(_kind: &str, _existing: &str, _incoming: &str) -> Option<String> {
    None
}

fn scrape_response_satisfies(kind: &str, body: &str) -> Option<bool> {
    matches!(
        kind,
        "subscription" | "quota_config" | "reset_card_list" | "usage"
    )
    .then(|| {
        let Ok(root) = serde_json::from_str::<serde_json::Value>(body) else {
            return false;
        };
        let Some(payload) = root
            .get("data")
            .and_then(|value| value.get("DataV2"))
            .and_then(|value| value.get("data"))
            .and_then(|value| value.get("data"))
        else {
            return false;
        };

        // 千问在登录失效时也可能让这些接口返回合法 JSON。仅验证 JSON 语法会把
        // 登录错误响应误记为“已抓全”，随后 extractor 返回 null，而隐藏 WebView
        // 又不会被展示给用户。这里按 extractor 真正依赖的业务结构判定槽位完成，
        // 让 probe 在内容不可用时进入 console_action_required 并拉起控制台。
        match kind {
            "subscription" => payload.is_object(),
            "quota_config" => payload.as_object().is_some_and(|tiers| {
                tiers.values().any(|tier| {
                    tier.get("weekly")
                        .and_then(serde_json::Value::as_f64)
                        .is_some()
                })
            }),
            "usage" => payload
                .get("per1WeekPercentage")
                .and_then(serde_json::Value::as_f64)
                .is_some(),
            "reset_card_list" => payload.is_array() || payload.is_object(),
            _ => false,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::scrape_response_satisfies;

    fn response(payload: serde_json::Value) -> String {
        serde_json::json!({
            "data": { "DataV2": { "data": { "data": payload } } }
        })
        .to_string()
    }

    #[test]
    fn accepts_qwen_token_plan_business_payloads() {
        assert_eq!(
            scrape_response_satisfies(
                "subscription",
                &response(serde_json::json!({ "specCode": "standard" }))
            ),
            Some(true)
        );
        assert_eq!(
            scrape_response_satisfies(
                "quota_config",
                &response(serde_json::json!({ "standard": { "weekly": 10_000 } }))
            ),
            Some(true)
        );
        assert_eq!(
            scrape_response_satisfies(
                "usage",
                &response(serde_json::json!({ "per1WeekPercentage": 0.304 }))
            ),
            Some(true)
        );
    }

    #[test]
    fn rejects_valid_json_without_token_plan_data() {
        for kind in ["subscription", "quota_config", "usage"] {
            assert_eq!(
                scrape_response_satisfies(
                    kind,
                    r#"{"code":"UNAUTHORIZED","message":"login required"}"#
                ),
                Some(false),
                "{kind} must not complete from an authentication error"
            );
        }
        assert_eq!(
            scrape_response_satisfies("quota_config", &response(serde_json::json!({}))),
            Some(false)
        );
        assert_eq!(
            scrape_response_satisfies("usage", &response(serde_json::json!({}))),
            Some(false)
        );
    }
}
