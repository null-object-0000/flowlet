use crate::core::config::{
    ChannelAccount, ChannelPreset, ProtocolType, RequestLogInput, RouteCandidate, RouteRule,
};
pub(super) fn match_candidates(
    routes: &[RouteCandidate],
    rules: &[RouteRule],
    scores: &[(String, String, f64, f64, f64)],
    public_model: Option<&str>,
    protocol: &ProtocolType,
    client_id: Option<&str>,
    accounts: &[ChannelAccount],
    _channels: &[ChannelPreset],
) -> Vec<RouteCandidate> {
    // 1. 优先检查规则路由
    if let Some(rule) = find_matching_rule(rules, client_id, public_model, protocol, accounts) {
        return vec![RouteCandidate {
            id: format!("rule-{}", rule.id),
            virtual_model_id: "auto".to_string(),
            channel_id: rule.target_channel_id,
            account_id: rule.target_account_id,
            upstream_model: rule.target_upstream_model,
            client_protocol: protocol.clone(),
            priority: rule.priority,
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
        }];
    }

    let virtual_model = match public_model {
        Some("auto") => "auto",
        Some(model) if !model.trim().is_empty() => {
            // 直接模型请求只匹配已开放模型，不回退到 auto。
            return find_direct_candidate(routes, model, protocol, accounts);
        }
        _ => return Vec::new(),
    };

    let mut matched: Vec<RouteCandidate> = routes
        .iter()
        .filter(|c| {
            c.enabled && c.virtual_model_id == virtual_model && c.client_protocol == *protocol
        })
        .filter(|c| accounts.iter().any(|a| a.id == c.account_id && a.enabled))
        .cloned()
        .collect();

    // 默认账号选择按 created_at 升序（先添加优先），priority 仅作高级路由 / fallback 策略。
    matched.sort_by(|a, b| a.created_at.cmp(&b.created_at));

    // 综合调度保留能力（暂不使用）。
    let _ = scores;
    matched
}

/// 查找第一个匹配的规则
pub(super) fn find_matching_rule(
    rules: &[RouteRule],
    client_id: Option<&str>,
    model: Option<&str>,
    protocol: &ProtocolType,
    accounts: &[ChannelAccount],
) -> Option<RouteRule> {
    let mut sorted_rules: Vec<RouteRule> = rules.iter().filter(|r| r.enabled).cloned().collect();
    sorted_rules.sort_by_key(|r| (r.priority, r.id.clone()));

    for rule in &sorted_rules {
        // 检查 client_id 匹配
        if let Some(ref match_client) = rule.match_client_id {
            if client_id != Some(match_client.as_str()) {
                continue;
            }
        }
        // 检查 model 匹配
        if let Some(ref match_model) = rule.match_model {
            if model != Some(match_model.as_str()) {
                continue;
            }
        }
        // 检查 protocol 匹配
        if let Some(ref match_proto) = rule.match_protocol {
            if match_proto != protocol {
                continue;
            }
        }
        // 检查目标账号是否有效且启用
        if !accounts
            .iter()
            .any(|a| a.id == rule.target_account_id && a.enabled)
        {
            continue;
        }
        return Some(rule.clone());
    }
    None
}

/// 综合调度：根据成本、延迟、成功率对候选进行排序
/// scores: Vec<(account_id, channel_id, avg_latency_ms, success_rate, cost_per_1k)]
#[allow(dead_code)]
pub(super) fn rank_candidates_by_score(
    candidates: &mut Vec<RouteCandidate>,
    scores: &[(String, String, f64, f64, f64)],
) {
    if candidates.len() <= 1 || scores.is_empty() {
        return;
    }

    let max_cost = scores.iter().map(|s| s.4).fold(0.0f64, f64::max).max(1.0);
    let max_latency = scores.iter().map(|s| s.2).fold(0.0f64, f64::max).max(1.0);

    let mut scored: Vec<(f64, RouteCandidate)> = candidates
        .drain(..)
        .map(|c| {
            let score = scores
                .iter()
                .find(|(acc, ch, _, _, _)| acc == &c.account_id && ch == &c.channel_id)
                .map(|(_, _, latency, success_rate, cost)| {
                    let norm_cost = cost / max_cost;
                    let norm_latency = latency / max_latency;
                    let failure_rate = (100.0 - success_rate) / 100.0;
                    0.4 * norm_cost + 0.3 * norm_latency + 0.3 * failure_rate
                })
                .unwrap_or(0.5);
            (score, c)
        })
        .collect();

    scored.sort_by(|(a, ca), (b, cb)| {
        // 评分相同时：按 created_at（添加时间）升序 — 越早添加的越优先。
        // priority 仅在高级模式下由 score 计算外生效，不再作为主要排序 key。
        a.partial_cmp(b)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| ca.created_at.cmp(&cb.created_at))
    });

    candidates.extend(scored.into_iter().map(|(_, c)| c));
}

/// 判断是否应该使用小模型，返回最终使用的上游模型名
pub(super) fn resolve_small_model(original_model: &str) -> String {
    original_model.to_string()
}

pub(super) fn find_direct_candidate(
    routes: &[RouteCandidate],
    model: &str,
    protocol: &ProtocolType,
    accounts: &[ChannelAccount],
) -> Vec<RouteCandidate> {
    // 直接模型请求必须匹配 route.virtual_model_id（对外模型名）。
    // upstream_model 仅在 rewrite_model 阶段用于转发前的模型名替换。
    // 同一 virtual_model_id 多个候选时，按 created_at 升序（先添加优先）。
    let mut candidates: Vec<&RouteCandidate> = routes
        .iter()
        .filter(|route| {
            route.client_protocol == *protocol
                && route.virtual_model_id == model
                && accounts.iter().any(|a| a.id == route.account_id && a.enabled)
        })
        .collect();
    candidates.sort_by_key(|r| r.created_at.as_str());
    candidates.first().map(|r| vec![(*r).clone()]).unwrap_or_default()
}

// ─── Fallback Rules ─────────────────────────────────────────────────────────

pub(super) fn should_try_next_status(status: reqwest::StatusCode, channel_vendor: &str) -> bool {
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
        return true;
    }
    // DeepSeek 402 余额不足
    if channel_vendor == "deepseek" && status == reqwest::StatusCode::PAYMENT_REQUIRED {
        return true;
    }
    false
}

pub(super) fn should_check_quota_body_status(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::PAYMENT_REQUIRED || status == reqwest::StatusCode::FORBIDDEN
}

pub(super) fn body_contains_quota_exceeded(body: &[u8]) -> bool {
    let text = String::from_utf8_lossy(body).to_ascii_lowercase();
    text.contains("quota exceeded")
        || text.contains("insufficient quota")
        || text.contains("exceeded your current quota")
        || text.contains("billing quota")
        || text.contains("balance insufficient")
}

pub(super) fn network_error_route_reason(err: &reqwest::Error) -> &'static str {
    if err.is_timeout() {
        "timeout"
    } else {
        "network_error"
    }
}

pub(super) fn enrich_upstream_error_log(status: reqwest::StatusCode, log: &mut RequestLogInput) {
    if !status.is_client_error() && !status.is_server_error() {
        return;
    }

    if log.error_message.is_none() {
        log.error_message = Some(format!("upstream status {}", status.as_u16()));
    }
    if log.route_reason.as_deref() == Some("direct") || log.route_reason.as_deref() == Some("auto")
    {
        log.route_reason = Some("upstream_error".to_string());
    }
}

