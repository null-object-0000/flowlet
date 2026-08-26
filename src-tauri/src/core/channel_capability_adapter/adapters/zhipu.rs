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

/// 诊断：account_report 被判定为未满足时，每个进程只记录一次原始响应片段，
/// 用于定位真实信封结构（避免每次循环重复刷日志）。
fn log_account_report_rejection(body: &str) {
    use std::sync::OnceLock;
    static LOGGED: OnceLock<()> = OnceLock::new();
    if LOGGED.get().is_some() {
        return;
    }
    let _ = LOGGED.set(());
    let sample: String = body.chars().take(400).collect();
    tracing::warn!(
        sample = %sample,
        "Z.AI account_report 响应未通过业务成功校验"
    );
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
        // 钱包报告：判定“业务调用成功”即可，不要求余额字段必须是数字。
        // 官方信封是 `{code: 200, data: {...}}`（控制台）或 `{success: true,
        // data: {...}}`（开放平台），余额为空时 `data` 可能是 `{}` —— 这也是合法
        // 的成功响应，余额交给 extractor 兜底（缺失则为 null）。返回 Some(false)
        // 而不是 None，避免外层回退到“合法 JSON 即到位”，把 401 等误判成已捕获。
        "account_report" => {
            let code = root.get("code");
            let code_ok = code.and_then(Value::as_i64) == Some(200)
                || code.and_then(Value::as_u64) == Some(200)
                || code
                    .and_then(Value::as_str)
                    .is_some_and(|text| text.trim() == "200");
            let success_ok = root.get("success").and_then(Value::as_bool) == Some(true);
            let ok = code_ok || success_ok;
            if !ok {
                log_account_report_rejection(body);
            }
            Some(ok)
        }
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
            Some(false)
        );
        assert_eq!(
            scrape_response_satisfies(
                "account_report",
                r#"{"code":500,"msg":"server error","success":false}"#
            ),
            Some(false)
        );
    }

    #[test]
    fn accepts_zhipu_account_report_success_envelope() {
        // 成功信封（code 200 或 success:true）即视为已捕获；余额字段缺失/非数字
        // 时交给 extractor 兜底为 null，不应阻断整个抓取。
        assert_eq!(
            scrape_response_satisfies(
                "account_report",
                r#"{"code":200,"data":{"availableBalance":"n/a"},"success":true}"#
            ),
            Some(true)
        );
        assert_eq!(
            scrape_response_satisfies("account_report", r#"{"success":true,"data":{}}"#),
            Some(true)
        );
        assert_eq!(
            scrape_response_satisfies("account_report", r#"{"code":"200","data":{}}"#),
            Some(true)
        );
        assert_eq!(
            scrape_response_satisfies(
                "account_report",
                r#"{"code":200,"data":{"balance":123.45,"availableBalance":null}}"#
            ),
            Some(true)
        );
    }

    #[test]
    fn accepts_zhipu_numeric_string_balance() {
        assert_eq!(
            scrape_response_satisfies(
                "account_report",
                r#"{"code":200,"data":{"availableBalance":"70.50"},"success":true}"#
            ),
            Some(true)
        );
    }
}
