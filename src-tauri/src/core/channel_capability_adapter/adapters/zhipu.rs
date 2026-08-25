use serde_json::Value;

use super::super::*;

fn sync<'a>(
    account: &'a ChannelAccount,
    preset: &'a ChannelPreset,
    config: &'a ChannelsConfig,
) -> ModelSyncFuture<'a> {
    let models_url = config.models_endpoint_url(&account.channel_id);
    Box::pin(crate::core::sync::sync_openai_compatible_models(
        account, preset, models_url,
    ))
}

pub(super) const ADAPTER: ChannelCapabilityAdapter = ChannelCapabilityAdapter {
    id: "zhipu",
    preset_factory: ChannelPreset::zhipu,
    model_sync: sync,
    balance_query: None,
    strips_openai_v1_path: true,
    // Z.AI 按量付费账号由官方控制台自动同步：资源包管理页会同时发起
    // tokenAccounts/list/my（资源包）与 account/query-customer-account-report（钱包）。
    console_scrape: ConsoleScrapeAdapter::ResourceModes(&[("pay_as_you_go", "paygo")]),
    login_page: LoginPageAdapter::Generic,
    scrape_response: Some(ScrapeResponseAdapter {
        classify: classify_scrape_response,
        merge: merge_scrape_response,
        satisfies: scrape_response_satisfies,
    }),
};

fn classify_scrape_response(url: &str) -> Option<&'static str> {
    let normalized = url.to_ascii_lowercase().replace("%2f", "/");
    if normalized.contains("tokenaccounts/list/my") {
        Some("token_packs_list")
    } else if normalized.contains("account/query-customer-account-report") {
        Some("account_report")
    } else {
        None
    }
}

fn merge_scrape_response(_kind: &str, _existing: &str, _incoming: &str) -> Option<String> {
    // 两个槽位均按“同类型最新覆盖旧”，无需跨批合并。
    None
}

fn scrape_response_satisfies(kind: &str, body: &str) -> Option<bool> {
    let Ok(root) = serde_json::from_str::<serde_json::Value>(body) else {
        return None;
    };
    match kind {
        // 资源包列表：业务信封 code == 200 且 rows 为数组（空数组也合法）。
        "token_packs_list" => {
            let code_ok = root.get("code").and_then(Value::as_i64) == Some(200)
                || root.get("code").and_then(Value::as_u64) == Some(200);
            Some(code_ok && root.get("rows").and_then(Value::as_array).is_some())
        }
        // 钱包报告：data.availableBalance 或 data.balance 必须是数字。
        "account_report" => root
            .get("data")
            .and_then(|data| {
                data.get("availableBalance")
                    .or_else(|| data.get("balance"))
                    .and_then(Value::as_f64)
            })
            .map(|_| true),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{classify_scrape_response, scrape_response_satisfies};

    #[test]
    fn classifies_zhipu_resource_pack_and_account_report_urls() {
        assert_eq!(
            classify_scrape_response(
                "https://www.bigmodel.cn/api/biz/tokenAccounts/list/my?pageNum=1&pageSize=10&filterEnabled=false"
            ),
            Some("token_packs_list")
        );
        assert_eq!(
            classify_scrape_response(
                "https://www.bigmodel.cn/api/biz/account/query-customer-account-report"
            ),
            Some("account_report")
        );
        assert_eq!(
            classify_scrape_response("https://www.bigmodel.cn/api/biz/customer/getCustomerInfo"),
            None
        );
    }

    #[test]
    fn accepts_zhipu_business_payloads() {
        assert_eq!(
            scrape_response_satisfies(
                "token_packs_list",
                r#"{"total":0,"rows":[],"code":200,"msg":"查询成功"}"#
            ),
            Some(true)
        );
        assert_eq!(
            scrape_response_satisfies(
                "account_report",
                r#"{"code":200,"data":{"availableBalance":0,"balance":0},"success":true}"#
            ),
            Some(true)
        );
    }

    #[test]
    fn rejects_zhipu_auth_errors() {
        assert_eq!(
            scrape_response_satisfies("token_packs_list", r#"{"code":401,"msg":"unauthorized"}"#),
            Some(false)
        );
        assert_eq!(
            scrape_response_satisfies("account_report", r#"{"code":401,"msg":"unauthorized"}"#),
            None
        );
        assert_eq!(
            scrape_response_satisfies(
                "account_report",
                r#"{"code":200,"data":{"availableBalance":"n/a"},"success":true}"#
            ),
            None
        );
    }
}
