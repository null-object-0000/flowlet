use crate::core::config::{AccountBalanceSnapshot, ChannelAccount, ChannelPreset};
use crate::core::device_identity::{SyncedAccountQuotaWindow, SyncedAccountResource};
use crate::core::storage::Storage;
use chrono::{DateTime, Duration, Utc};
use serde_json::Value;

const RESOURCE_STALE_AFTER: Duration = Duration::minutes(10);

/// 生成可进入普通设备快照的去敏账号资源摘要。这里只读取本地最新观测，
/// 不触发上游请求；渠道同步与 Codex 同步仍由各自后台任务负责。
pub fn build_synced_account_resources(
    storage: &Storage,
) -> Result<Vec<SyncedAccountResource>, String> {
    let accounts = storage
        .list_channel_accounts()
        .map_err(|error| error.to_string())?;
    let presets = storage
        .list_channel_presets()
        .map_err(|error| error.to_string())?;
    let snapshots = storage
        .latest_balance_snapshots()
        .map_err(|error| error.to_string())?;
    let mut resources = accounts
        .iter()
        .filter_map(|account| {
            let workspace_id = account.workspace_account_id.as_deref()?.trim();
            let preset = presets
                .iter()
                .find(|preset| preset.id == account.channel_id)?;
            if workspace_id.is_empty() || !has_automatic_resource_sync(account, preset) {
                return None;
            }
            let snapshot = snapshots
                .iter()
                .find(|snapshot| snapshot.account_id == account.id)?;
            Some(channel_resource(workspace_id, account, preset, snapshot))
        })
        .collect::<Vec<_>>();

    let codex_root = storage
        .database_path()
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("codex-accounts");
    if let Ok(report) = crate::core::codex_account::list_cached_codex_accounts(&codex_root) {
        resources.extend(report.accounts.into_iter().filter_map(codex_resource));
    }
    resources.sort_by(|left, right| {
        left.channel_name
            .cmp(&right.channel_name)
            .then_with(|| left.account_name.cmp(&right.account_name))
    });
    Ok(resources)
}

fn has_automatic_resource_sync(account: &ChannelAccount, preset: &ChannelPreset) -> bool {
    if !account.enabled {
        return false;
    }
    let official_api =
        preset.supports_balance_query && account.effective_openai_base_url().is_none();
    let console = account.resource_sync_mode == "auto"
        && (account.channel_id == "longcat"
            || (account.channel_id == "qwen"
                && matches!(
                    account.resource_mode.as_deref(),
                    Some("token_plan") | Some("pay_as_you_go")
                )));
    official_api || console
}

fn channel_resource(
    workspace_id: &str,
    account: &ChannelAccount,
    preset: &ChannelPreset,
    snapshot: &AccountBalanceSnapshot,
) -> SyncedAccountResource {
    let mut plan = account.resource_mode.clone();
    let mut expires_at = snapshot.token_pack_expire_at.clone();
    let mut quota_windows = Vec::new();
    if account.channel_id == "qwen" && account.resource_mode.as_deref() == Some("token_plan") {
        if let Some(details) = snapshot
            .raw_scraped_json
            .as_deref()
            .and_then(parse_qwen_details)
        {
            plan = details.plan.or(plan);
            expires_at = details.expires_at.or(expires_at);
            quota_windows = details.windows;
        }
    }
    if account.channel_id == "qwen"
        && account.resource_mode.as_deref() == Some("pay_as_you_go")
    {
        if let Some(details) = snapshot
            .raw_scraped_json
            .as_deref()
            .and_then(parse_qwen_freetier_details)
        {
            plan = details.plan.or(plan);
        }
    }
    let observed_at = snapshot
        .synced_at
        .clone()
        .unwrap_or_else(|| snapshot.created_at.clone());
    SyncedAccountResource {
        account_id: workspace_id.to_string(),
        channel_id: account.channel_id.clone(),
        channel_name: preset.name.clone(),
        account_name: account.name.clone(),
        plan,
        balance: snapshot.balance,
        balance_text: None,
        currency: snapshot.currency.clone(),
        token_total: snapshot.token_pack_total,
        token_used: snapshot.token_pack_used,
        token_remaining: snapshot.token_pack_remaining,
        expires_at,
        quota_windows,
        stale: is_stale(&observed_at),
        observed_at,
    }
}

fn codex_resource(
    report: crate::core::codex_account::CodexAccountReport,
) -> Option<SyncedAccountResource> {
    let has_observation = report.primary.is_some()
        || report.secondary.is_some()
        || report
            .credits
            .as_ref()
            .is_some_and(|credits| credits.has_credits || credits.unlimited);
    if !report.signed_in || !has_observation {
        return None;
    }
    let quota_windows = [report.primary.as_ref(), report.secondary.as_ref()]
        .into_iter()
        .flatten()
        .map(|window| SyncedAccountQuotaWindow {
            label: if window.window_duration_mins <= 360 {
                "5 小时".to_string()
            } else if window.window_duration_mins >= 7 * 24 * 60 {
                "7 天".to_string()
            } else {
                format!("{} 小时", window.window_duration_mins / 60)
            },
            used_percent: window.used_percent.clamp(0.0, 100.0),
            resets_at: DateTime::<Utc>::from_timestamp(window.resets_at, 0)
                .map(|value| value.to_rfc3339()),
        })
        .collect();
    let balance_text = report.credits.as_ref().and_then(|credits| {
        if credits.unlimited {
            Some("不限量".to_string())
        } else if credits.has_credits {
            credits.balance.clone().or_else(|| Some("可用".to_string()))
        } else {
            None
        }
    });
    Some(SyncedAccountResource {
        account_id: format!("codex:{}", report.account_id),
        channel_id: "chatgpt".to_string(),
        channel_name: "ChatGPT".to_string(),
        account_name: report.email.clone().unwrap_or_else(|| "Codex".to_string()),
        plan: report.plan_type,
        balance: None,
        balance_text,
        currency: None,
        token_total: None,
        token_used: None,
        token_remaining: None,
        expires_at: None,
        quota_windows,
        stale: report.stale || is_stale(&report.updated_at),
        observed_at: report.updated_at,
    })
}

struct QwenDetails {
    plan: Option<String>,
    expires_at: Option<String>,
    windows: Vec<SyncedAccountQuotaWindow>,
}

/// 千问 API 按量付费福利页抓取摘要：只取账单余额证明数据到位，套餐名固定为
/// 按量付费；免费额度实例明细留在 raw_scraped_json 由桌面端解析展示。
struct QwenFreetierDetails {
    plan: Option<String>,
}

fn parse_qwen_freetier_details(raw: &str) -> Option<QwenFreetierDetails> {
    let bundle: Value = serde_json::from_str(raw).ok()?;
    let billing = bundle.get("billing_amount")?.get("data")?;
    billing
        .get("AvailableAmount")
        .and_then(Value::as_f64)
        .is_some()
        .then(|| QwenFreetierDetails {
            plan: Some("API 按量付费".to_string()),
        })
}

fn parse_qwen_details(raw: &str) -> Option<QwenDetails> {
    let bundle: Value = serde_json::from_str(raw).ok()?;
    let subscription = response_data(bundle.get("subscription")?)?;
    let quota = response_data(bundle.get("quota_config")?)?;
    let usage = response_data(bundle.get("usage")?)?;
    let plan = subscription
        .get("specCode")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| Some("standard".to_string()));
    let tier = plan
        .as_deref()
        .and_then(|key| quota.get(key))
        .or_else(|| quota.get("standard"))?;
    let mut windows = Vec::new();
    push_qwen_window(
        &mut windows,
        "5 小时",
        tier.get("five_hour"),
        usage.get("per5HourPercentage"),
        usage.get("per5HourResetTime"),
    );
    push_qwen_window(
        &mut windows,
        "7 天",
        tier.get("weekly"),
        usage.get("per1WeekPercentage"),
        usage.get("per1WeekResetTime"),
    );
    Some(QwenDetails {
        plan,
        expires_at: timestamp_string(subscription.get("endTime")),
        windows,
    })
}

fn response_data(value: &Value) -> Option<&serde_json::Map<String, Value>> {
    value
        .get("data")?
        .get("DataV2")?
        .get("data")?
        .get("data")?
        .as_object()
}

fn push_qwen_window(
    windows: &mut Vec<SyncedAccountQuotaWindow>,
    label: &str,
    total: Option<&Value>,
    consumed: Option<&Value>,
    reset: Option<&Value>,
) {
    let Some(total) = numeric(total) else {
        return;
    };
    let Some(mut ratio) = numeric(consumed) else {
        return;
    };
    if total <= 0.0 {
        return;
    }
    if ratio > 1.0 {
        ratio /= 100.0;
    }
    windows.push(SyncedAccountQuotaWindow {
        label: label.to_string(),
        used_percent: (ratio * 100.0).clamp(0.0, 100.0),
        resets_at: timestamp_string(reset),
    });
}

fn numeric(value: Option<&Value>) -> Option<f64> {
    value.and_then(|value| value.as_f64().or_else(|| value.as_str()?.parse().ok()))
}

fn timestamp_string(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(number) = value.as_i64() {
        let millis = if number < 100_000_000_000 {
            number * 1000
        } else {
            number
        };
        return DateTime::<Utc>::from_timestamp_millis(millis).map(|value| value.to_rfc3339());
    }
    let raw = value.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(number) = raw.parse::<i64>() {
        let millis = if number < 100_000_000_000 {
            number * 1000
        } else {
            number
        };
        return DateTime::<Utc>::from_timestamp_millis(millis).map(|value| value.to_rfc3339());
    }
    Some(raw.to_string())
}

fn is_stale(observed_at: &str) -> bool {
    DateTime::parse_from_rfc3339(observed_at)
        .map(|value| value.with_timezone(&Utc) + RESOURCE_STALE_AFTER < Utc::now())
        .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qwen_raw_payload_is_reduced_to_safe_windows() {
        let raw = serde_json::json!({
            "subscription": {"data":{"DataV2":{"data":{"data":{"specCode":"pro","endTime":1780000000000_i64}}}}},
            "quota_config": {"data":{"DataV2":{"data":{"data":{"pro":{"five_hour":3000,"weekly":10000}}}}}},
            "usage": {"data":{"DataV2":{"data":{"data":{"per5HourPercentage":0.25,"per1WeekPercentage":40,"per5HourResetTime":1780000000000_i64,"per1WeekResetTime":1780100000000_i64}}}}}
        }).to_string();
        let details = parse_qwen_details(&raw).expect("qwen details");
        assert_eq!(details.plan.as_deref(), Some("pro"));
        assert_eq!(details.windows.len(), 2);
        assert_eq!(details.windows[0].used_percent, 25.0);
        assert_eq!(details.windows[1].used_percent, 40.0);
        assert!(!serde_json::to_string(&details.windows)
            .unwrap()
            .contains("DataV2"));
    }

    #[test]
    fn qwen_freetier_payload_exposes_pay_as_you_go_plan() {
        let raw = serde_json::json!({
            "billing_amount": {"data": {"AvailableAmount": 106.13, "Currency": "CNY"}},
            "fq_instance": {"data": {"Data": []}}
        })
        .to_string();
        let details = parse_qwen_freetier_details(&raw).expect("qwen freetier details");
        assert_eq!(details.plan.as_deref(), Some("API 按量付费"));
        // 缺少账单余额数据时视为未抓全。
        assert!(parse_qwen_freetier_details(r#"{"code":"UNAUTHORIZED"}"#).is_none());
        assert!(parse_qwen_freetier_details(
            &serde_json::json!({ "fq_instance": {"data": {"Data": []}} }).to_string()
        )
        .is_none());
    }
}
