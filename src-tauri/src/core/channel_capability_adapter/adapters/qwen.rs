use serde_json::Value;

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
    console_scrape: ConsoleScrapeAdapter::ResourceModes(&[
        // Token Plan 订阅：套餐专属控制台抓订阅额度。
        ("token_plan", "token_plan"),
        // API 按量付费：福利页（权益）抓免费额度实例与账单余额。
        ("pay_as_you_go", "freetier"),
    ]),
    login_page: LoginPageAdapter::GenericOrHost("account.aliyun.com"),
    scrape_response: Some(ScrapeResponseAdapter {
        classify: classify_scrape_response,
        merge: merge_scrape_response,
        satisfies: scrape_response_satisfies,
    }),
};

fn classify_scrape_response(url: &str) -> Option<&'static str> {
    let normalized = url.to_ascii_lowercase().replace("%2f", "/");
    // 福利页 / 权益页（pay_as_you_go）：freetier 模板清单、免费额度实例（多批）、
    // 账单账户余额、结算账单汇总、实名认证、会话信息。全部按 action/api 名精确匹配。
    if normalized.contains("listbailianfreetier") {
        Some("freetier_list")
    } else if normalized.contains("describefqinstance") {
        Some("fq_instance")
    } else if normalized.contains("getbillingaccountavailableamount") {
        Some("billing_amount")
    } else if normalized.contains("listsettlebilltotalsummary") {
        Some("settle_bill")
    } else if normalized.contains("querycurrentcertinfo") {
        Some("cert_info")
    } else if normalized.contains("tool/user/info.json") {
        Some("session_info")
    }
    // Token Plan 订阅控制台。
    else if normalized.contains("/tokenplan/personal/api/v2/subscription") {
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

fn merge_scrape_response(kind: &str, existing: &str, incoming: &str) -> Option<String> {
    // 只有 fq_instance 需要跨批合并（页面按 40 个模板一批连续发 14 批）；
    // 其余槽位同类型最新覆盖。
    if kind != "fq_instance" {
        return None;
    }
    merge_fq_instance_responses(existing, incoming)
}

/// DescribeFqInstance 跨批合并：按 `Template.Code` 去重（后到覆盖先到），并裁剪为
/// 白名单字段，避免把多批原始响应原样存入快照。输出仍保持
/// `{"data":{"Data":[...]}}` 信封，extractor 与前端解析无需感知合并细节。
fn merge_fq_instance_responses(existing: &str, incoming: &str) -> Option<String> {
    let existing_root: serde_json::Value = serde_json::from_str(existing).ok()?;
    let incoming_root: serde_json::Value = serde_json::from_str(incoming).ok()?;
    let existing_items = existing_root.get("data")?.get("Data")?.as_array()?;
    let incoming_items = incoming_root.get("data")?.get("Data")?.as_array()?;

    let mut order: Vec<String> = Vec::new();
    let mut by_code: std::collections::HashMap<String, serde_json::Value> =
        std::collections::HashMap::new();
    for item in existing_items.iter().chain(incoming_items.iter()) {
        let Some(code) = item.pointer("/Template/Code").and_then(Value::as_str) else {
            continue;
        };
        if code.is_empty() {
            continue;
        }
        if !by_code.contains_key(code) {
            order.push(code.to_string());
        }
        by_code.insert(code.to_string(), item.clone());
    }

    let merged = order
        .iter()
        .filter_map(|code| by_code.get(code))
        .filter_map(keep_fq_instance_fields)
        .collect::<Vec<_>>();
    Some(
        serde_json::json!({ "data": { "Data": merged, "TotalCount": merged.len() } })
            .to_string(),
    )
}

/// 裁剪单条额度实例，只保留前端展示需要的最小字段集。
fn keep_fq_instance_fields(value: &Value) -> Option<Value> {
    let template = value.get("Template")?;
    let code = template.get("Code")?.as_str()?;
    let name = template.get("Name").and_then(Value::as_str).unwrap_or("");
    let mut instance = serde_json::Map::new();
    instance.insert("Template".to_string(), serde_json::json!({ "Code": code, "Name": name }));
    for key in [
        "Status",
        "InitCapacity",
        "CurrCapacity",
        "CurrentCycleStartTime",
        "CurrentCycleEndTime",
        "EndTime",
    ] {
        if let Some(field) = value.get(key) {
            instance.insert(key.to_string(), field.clone());
        }
    }
    Some(Value::Object(instance))
}

fn scrape_response_satisfies(kind: &str, body: &str) -> Option<bool> {
    const TOKEN_PLAN_KINDS: [&str; 4] = ["subscription", "quota_config", "reset_card_list", "usage"];
    if TOKEN_PLAN_KINDS.contains(&kind) {
        return token_plan_payload_satisfies(kind, body);
    }
    let Ok(root) = serde_json::from_str::<serde_json::Value>(body) else {
        return None;
    };
    match kind {
        // BssOpenAPI-V3 / freetier 网关信封：data.Data 数组（额度实例可空数组，空也合法）。
        "freetier_list" | "fq_instance" | "settle_bill" => root
            .get("data")
            .and_then(|value| value.get("Data"))
            .and_then(Value::as_array)
            .map(|_| true),
        // 账单账户余额：可用金额必须是数字。
        "billing_amount" => root
            .get("data")
            .and_then(|value| value.get("AvailableAmount"))
            .and_then(Value::as_f64)
            .map(|_| true),
        // 实名认证：certified 布尔。
        "cert_info" => root
            .get("data")
            .and_then(|value| value.get("certified"))
            .and_then(Value::as_bool)
            .map(|_| true),
        // 会话信息：secToken 非空字符串。
        "session_info" => root
            .get("data")
            .and_then(|value| value.get("secToken"))
            .and_then(Value::as_str)
            .map(|token| !token.is_empty()),
        _ => None,
    }
}

/// Token Plan 的额度窗口键。
///
/// 上游控制台改版后主额度窗口由周（`weekly` + `per1WeekPercentage`）换成月
/// （`monthly` + `per1MonthPercentage`）；旧账号的历史快照仍是周口径。校验必须同时
/// 接受两种口径，否则新版页面会被误判成「未抓全」而中断同步。
const TOKEN_PLAN_QUOTA_WINDOWS: [&str; 3] = ["five_hour", "weekly", "monthly"];

/// 用量百分比键：`per5HourPercentage` / `per1WeekPercentage` / `per1MonthPercentage`
/// 等。按前缀 + 后缀匹配而不枚举具体窗口，避免上游再增窗口时又要改一次。
fn is_usage_percentage_key(key: &str) -> bool {
    key.starts_with("per") && key.ends_with("Percentage")
}

/// Token Plan 槽位沿用原校验：解析 data.DataV2.data.data 业务信封，登录失效时
/// 返回合法 JSON 但缺少业务结构，判定未抓全并进入 console_action_required。
///
/// 额度/用量只要求「信封在 + 至少一个窗口有值」，不锁定具体窗口名：
/// 只认 `weekly` / `per1WeekPercentage` 会让改版后的月额度账号永远抓不全。
fn token_plan_payload_satisfies(kind: &str, body: &str) -> Option<bool> {
    let Ok(root) = serde_json::from_str::<serde_json::Value>(body) else {
        return None;
    };
    let payload = root
        .get("data")
        .and_then(|value| value.get("DataV2"))
        .and_then(|value| value.get("data"))
        .and_then(|value| value.get("data"));
    match kind {
        "subscription" => Some(payload.is_some_and(Value::is_object)),
        "quota_config" => Some(payload.and_then(Value::as_object).is_some_and(|tiers| {
            tiers.values().any(|tier| {
                TOKEN_PLAN_QUOTA_WINDOWS
                    .iter()
                    .any(|key| tier.get(key).and_then(Value::as_f64).is_some())
            })
        })),
        "usage" => Some(payload.and_then(Value::as_object).is_some_and(|usage| {
            usage
                .iter()
                .any(|(key, value)| is_usage_percentage_key(key) && value.as_f64().is_some())
        })),
        "reset_card_list" => Some(payload.is_some_and(|value| value.is_array() || value.is_object())),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        classify_scrape_response, keep_fq_instance_fields, merge_fq_instance_responses,
        scrape_response_satisfies,
    };

    fn response(payload: serde_json::Value) -> String {
        serde_json::json!({
            "data": { "DataV2": { "data": { "data": payload } } }
        })
        .to_string()
    }

    fn gateway(payload: serde_json::Value) -> String {
        serde_json::json!({ "data": { "Data": payload } }).to_string()
    }

    /// 上游 `BroadScopeAspnGateway` 真实信封（2026-10 抓取样本）：比 `response()` 多一层
    /// `ret` / `msg` / `code` 包装，用来验证改版后的响应仍能满足槽位校验。
    fn broad_scope_gateway(payload: serde_json::Value) -> String {
        serde_json::json!({
            "code": "200",
            "data": {
                "DataV2": {
                    "ret": ["SUCCESS::接口调用成功"],
                    "data": { "msg": "Success.", "code": "SUCCESS", "data": payload }
                }
            }
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
    fn accepts_qwen_token_plan_monthly_payloads_after_console_revamp() {
        // 改版后主额度窗口由 weekly 换成 monthly，用量键由 per1WeekPercentage 换成
        // per1MonthPercentage。真实样本见 logs 的「控制台抓取原始响应明细」。
        assert_eq!(
            scrape_response_satisfies(
                "subscription",
                &broad_scope_gateway(serde_json::json!({
                    "instanceCode": "sfm_tokenplansolo_public_cn-u5i4xb5mo05",
                    "specCode": "standard",
                    "status": "VALID"
                }))
            ),
            Some(true)
        );
        assert_eq!(
            scrape_response_satisfies(
                "quota_config",
                &broad_scope_gateway(serde_json::json!({
                    "standard": { "five_hour": 3000.0, "monthly": 45000.0 }
                }))
            ),
            Some(true)
        );
        assert_eq!(
            scrape_response_satisfies(
                "usage",
                &broad_scope_gateway(serde_json::json!({
                    "per1MonthPercentage": 0.8008054844444444,
                    "per1MonthResetTime": 1_792_598_400_000_i64
                }))
            ),
            Some(true)
        );
        // 只有 five_hour 没有用量百分比的额度配置也算抓全（真实样本就是这种形态）。
        assert_eq!(
            scrape_response_satisfies(
                "quota_config",
                &broad_scope_gateway(serde_json::json!({ "standard": { "five_hour": 3000 } }))
            ),
            Some(true)
        );
    }

    #[test]
    fn rejects_qwen_quota_payloads_without_any_window() {
        // 信封在但没有额度窗口（例如仅返回套餐附加信息）时仍算未抓全。
        assert_eq!(
            scrape_response_satisfies(
                "quota_config",
                &broad_scope_gateway(serde_json::json!({ "standard": { "monthlyLabel": "月额度" } }))
            ),
            Some(false)
        );
        // 用量键必须带数值，非百分比键或字符串数值都不算。
        assert_eq!(
            scrape_response_satisfies(
                "usage",
                &broad_scope_gateway(serde_json::json!({ "per1MonthResetTime": 1_792_598_400_000_i64 }))
            ),
            Some(false)
        );
        assert_eq!(
            scrape_response_satisfies(
                "usage",
                &broad_scope_gateway(serde_json::json!({ "per1MonthPercentage": "n/a" }))
            ),
            Some(false)
        );
    }

    #[test]
    fn accepts_freetier_gateway_payloads() {
        assert_eq!(
            scrape_response_satisfies(
                "freetier_list",
                &gateway(
                    serde_json::json!([{ "TemplateCode": "sfm_inference_public_cn_x", "Safemode": "off" }])
                )
            ),
            Some(true)
        );
        // 空批次（该批模板均无实例）也是合法响应。
        assert_eq!(
            scrape_response_satisfies("fq_instance", &gateway(serde_json::json!([]))),
            Some(true)
        );
        assert_eq!(
            scrape_response_satisfies(
                "settle_bill",
                &gateway(serde_json::json!([{ "BillingCycle": "202608" }]))
            ),
            Some(true)
        );
    }

    #[test]
    fn accepts_free_tier_flat_payloads() {
        assert_eq!(
            scrape_response_satisfies(
                "billing_amount",
                &serde_json::json!({ "data": { "AvailableAmount": 106.13 } }).to_string()
            ),
            Some(true)
        );
        assert_eq!(
            scrape_response_satisfies(
                "cert_info",
                &serde_json::json!({ "data": { "certified": true, "aliyunId": "a@b.c" } }).to_string()
            ),
            Some(true)
        );
        assert_eq!(
            scrape_response_satisfies(
                "session_info",
                &serde_json::json!({ "data": { "secToken": "BDOTMAdWyBRYtagG0vJGy3" } }).to_string()
            ),
            Some(true)
        );
    }

    #[test]
    fn rejects_valid_json_without_business_data() {
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
        for kind in ["freetier_list", "fq_instance", "billing_amount", "settle_bill", "cert_info", "session_info"] {
            assert_eq!(
                scrape_response_satisfies(
                    kind,
                    r#"{"code":"UNAUTHORIZED","message":"login required"}"#
                ),
                None,
                "{kind} must not complete from an authentication error"
            );
        }
        assert_eq!(
            scrape_response_satisfies(
                "billing_amount",
                &serde_json::json!({ "data": { "AvailableAmount": "n/a" } }).to_string()
            ),
            None
        );
    }

    #[test]
    fn classifies_freetier_and_billing_urls() {
        assert_eq!(
            classify_scrape_response("https://platform-home.qianwenai.com/data/api.json?product=freetier&action=ListBailianFreetier&sec_token=x"),
            Some("freetier_list")
        );
        assert_eq!(
            classify_scrape_response("https://platform-home.qianwenai.com/data/api.json?product=BssOpenAPI-V3&action=DescribeFqInstance&params=%7B%22TemplateCodes%22%3A%5B%22sfm_inference_public_cn_20251111100417_0506%22%5D%7D"),
            Some("fq_instance")
        );
        assert_eq!(
            classify_scrape_response("https://platform-home.qianwenai.com/data/api.json?product=BssOpenAPI-V3&action=GetBillingAccountAvailableAmount"),
            Some("billing_amount")
        );
        assert_eq!(
            classify_scrape_response("https://platform-home.qianwenai.com/data/api.json?product=BssOpenAPI-V3&action=ListSettleBillTotalSummary&params=%7B%22StartBillingCycle%22%3A%22202608%22%7D"),
            Some("settle_bill")
        );
        assert_eq!(
            classify_scrape_response("https://account.qianwenai.com/cert/aliyuncert/queryCurrentCertInfo"),
            Some("cert_info")
        );
        assert_eq!(
            classify_scrape_response("https://platform-home.qianwenai.com/tool/user/info.json"),
            Some("session_info")
        );
        // 既有 Token Plan 槽位不受影响。
        assert_eq!(
            classify_scrape_response("https://cs-data.qianwenai.com/data/api.json?api=zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fsubscription"),
            Some("subscription")
        );
        assert_eq!(
            classify_scrape_response("https://platform-home.qianwenai.com/data/api.json?product=sfm_bailian&action=BroadScopeAspnGateway&api=zeldaEasy.bailian-dash-workspace.space.listWorkspaces4Agent"),
            None
        );
    }

    fn instance(code: &str, name: &str) -> serde_json::Value {
        serde_json::json!({
            "InstanceName": format!("dashscope_{code}"),
            "Status": "valid",
            "Uid": 1494342465971857_i64,
            "InitCapacity": { "BaseValue": 1000000.0, "ShowUnit": "千tokens", "ShowValue": "1000.000000" },
            "CurrCapacity": { "BaseValue": 500000.0, "ShowUnit": "千tokens", "ShowValue": "500.000000" },
            "Template": { "Code": code, "Name": name },
            "CurrentCycleStartTime": "Sat Aug 01 00:00:00 CST 2026",
            "CurrentCycleEndTime": "Tue Sep 01 00:00:00 CST 2026",
            "EndTime": "Thu Jan 01 00:00:00 CST 2099"
        })
    }

    #[test]
    fn merges_fq_instance_batches_by_template_code() {
        let batch1 = gateway(serde_json::json!([
            instance("sfm_public_cn_a", "qwen-a"),
            instance("sfm_public_cn_b", "qwen-b"),
        ]));
        let batch2 = gateway(serde_json::json!([
            instance("sfm_public_cn_b", "qwen-b-updated"),
            instance("sfm_public_cn_c", "qwen-c"),
        ]));
        let merged = merge_fq_instance_responses(&batch1, &batch2).expect("merged");
        let value: serde_json::Value = serde_json::from_str(&merged).expect("json");
        let data = value.get("data").and_then(|v| v.get("Data")).and_then(|v| v.as_array());
        let data = data.expect("data array");
        assert_eq!(data.len(), 3, "去重后保留 3 个实例");
        let codes: Vec<&str> = data
            .iter()
            .filter_map(|item| item.pointer("/Template/Code").and_then(serde_json::Value::as_str))
            .collect();
        assert_eq!(codes, vec!["sfm_public_cn_a", "sfm_public_cn_b", "sfm_public_cn_c"]);
        // 同名模板后到覆盖先到：b 取 batch2 的 Name。
        let b = data
            .iter()
            .find(|item| item.pointer("/Template/Code").and_then(serde_json::Value::as_str) == Some("sfm_public_cn_b"))
            .expect("b instance");
        assert_eq!(
            b.pointer("/Template/Name").and_then(serde_json::Value::as_str),
            Some("qwen-b-updated")
        );
        // 裁剪后不含 InstanceName / Uid。
        assert!(b.get("InstanceName").is_none());
        assert!(b.get("Uid").is_none());
    }

    #[test]
    fn keeps_only_required_instance_fields() {
        let kept = keep_fq_instance_fields(&instance("sfm_x", "qwen-x")).expect("kept");
        assert!(kept.get("Template").is_some());
        assert!(kept.get("Status").is_some());
        assert!(kept.get("InitCapacity").is_some());
        assert!(kept.get("CurrCapacity").is_some());
        assert!(kept.get("CurrentCycleStartTime").is_some());
        assert!(kept.get("CurrentCycleEndTime").is_some());
        assert!(kept.get("EndTime").is_some());
        assert!(kept.get("InstanceName").is_none());
        assert!(kept.get("Uid").is_none());
    }
}