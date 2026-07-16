use crate::core::config::{
    ChannelAccount, ChannelPreset, ProtocolType, RequestLogInput, RouteCandidate, RouteRule,
    ACCOUNT_CREDENTIAL_HEALTHY,
};
pub(super) fn match_candidates(
    routes: &[RouteCandidate],
    rules: &[RouteRule],
    scores: &[(String, String, f64, f64, f64)],
    public_model: Option<&str>,
    protocol: &ProtocolType,
    client_id: Option<&str>,
    accounts: &[ChannelAccount],
    channels: &[ChannelPreset],
    round_robin: &mut std::collections::HashMap<String, usize>,
) -> Vec<RouteCandidate> {
    let Some(public_model) = public_model.filter(|model| !model.trim().is_empty()) else {
        return Vec::new();
    };
    let is_flowlet_model = matches!(public_model, "flowlet-pro" | "flowlet-flash");

    // 高级规则保留给旧自定义模型；固定 Flowlet 档位始终使用隔离的模型池。
    if !is_flowlet_model {
        if let Some(rule) = find_matching_rule(rules, client_id, Some(public_model), protocol, accounts) {
            return vec![RouteCandidate {
                id: format!("rule-{}", rule.id),
                virtual_model_id: public_model.to_string(),
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
    }

    let account_by_id: std::collections::HashMap<&str, &ChannelAccount> = accounts
        .iter()
        .filter(|account| {
            account.enabled
                && !account.api_key.trim().is_empty()
                && account.credential_status.as_str() == ACCOUNT_CREDENTIAL_HEALTHY
        })
        .map(|account| (account.id.as_str(), account))
        .collect();
    let dual_protocol_channels: std::collections::HashSet<&str> = channels
        .iter()
        .filter(|channel| {
            channel.supported_protocols.contains(&ProtocolType::OpenAi)
                && channel.supported_protocols.contains(&ProtocolType::Anthropic)
        })
        .map(|channel| channel.id.as_str())
        .collect();

    let mut matched: Vec<RouteCandidate> = routes
        .iter()
        .filter(|route| {
            route.enabled
                && route.virtual_model_id == public_model
                && route.client_protocol == *protocol
                && account_by_id.contains_key(route.account_id.as_str())
                && (!is_flowlet_model || dual_protocol_channels.contains(route.channel_id.as_str()))
        })
        .cloned()
        .collect();

    matched.sort_by(|a, b| {
        let account_a = account_by_id.get(a.account_id.as_str());
        let account_b = account_by_id.get(b.account_id.as_str());
        a.priority
            .cmp(&b.priority)
            .then_with(|| a.channel_id.cmp(&b.channel_id))
            .then_with(|| a.upstream_model.cmp(&b.upstream_model))
            .then_with(|| account_a.map(|account| account.priority).cmp(&account_b.map(|account| account.priority)))
            .then_with(|| account_a.map(|account| account.created_at.as_str()).cmp(&account_b.map(|account| account.created_at.as_str())))
    });

    // 每个“档位 + 协议 + 底层模型”的账号池独立轮询；模型池之间仍按 priority 固定 fallback。
    let mut cursor = 0;
    while cursor < matched.len() {
        let group_priority = matched[cursor].priority;
        let group_channel = matched[cursor].channel_id.clone();
        let group_model = matched[cursor].upstream_model.clone();
        let mut end = cursor + 1;
        while end < matched.len()
            && matched[end].priority == group_priority
            && matched[end].channel_id == group_channel
            && matched[end].upstream_model == group_model
        {
            end += 1;
        }
        let key = format!("{}:{}:{}:{}", public_model, protocol.as_str(), group_channel, group_model);
        let next = round_robin.entry(key).or_insert(0);
        let group_len = end - cursor;
        matched[cursor..end].rotate_left(*next % group_len);
        *next = (*next + 1) % group_len;
        cursor = end;
    }

    // 动态评分本期不参与默认路由。
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

pub(super) fn body_contains_account_deactivated(body: &[u8]) -> bool {
    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) {
        let error = value.get("error").unwrap_or(&value);
        if error
            .get("code")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|code| code.eq_ignore_ascii_case("account_deactivated"))
        {
            return true;
        }
        if error
            .get("message")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|message| {
                message
                    .to_ascii_lowercase()
                    .contains("api key is disabled")
            })
        {
            return true;
        }
    }

    String::from_utf8_lossy(body)
        .to_ascii_lowercase()
        .contains("api key is disabled")
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

