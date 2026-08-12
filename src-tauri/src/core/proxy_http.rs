use crate::core::config::{
    AuthStrategy, ChannelAccount, ChannelModel, ChannelPreset, ProtocolType, RouteCandidate,
    UaClientRule, ACCOUNT_CREDENTIAL_HEALTHY,
};
use axum::{
    body::Body,
    http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri},
    response::Response,
};
use base64::Engine;
use std::collections::BTreeSet;
use std::io::Read;

pub(super) fn cors_preflight_response(request_headers: &HeaderMap) -> Response {
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::NO_CONTENT;
    let requested_headers = request_headers.get(header::ACCESS_CONTROL_REQUEST_HEADERS);
    add_cors_headers(response.headers_mut(), requested_headers);
    response
}

pub(super) fn add_cors_headers(
    headers: &mut HeaderMap<HeaderValue>,
    requested_headers: Option<&HeaderValue>,
) {
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET,POST,PUT,PATCH,DELETE,OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        requested_headers.cloned().unwrap_or_else(|| {
            HeaderValue::from_static(
                "authorization,content-type,x-api-key,anthropic-version,anthropic-beta",
            )
        }),
    );
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("content-type,x-request-id"),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("86400"),
    );
}

pub(super) fn is_model_list_request(method: &Method, path: &str) -> bool {
    if method != Method::GET {
        return false;
    }

    let path_without_query = path.split('?').next().unwrap_or(path);
    matches!(
        path_without_query,
        "/v1/models" | "/openai/v1/models" | "/anthropic/v1/models"
    )
}

pub(super) fn model_detail_request_id(method: &Method, path: &str) -> Option<String> {
    if method != Method::GET {
        return None;
    }
    let path = path.split('?').next().unwrap_or(path);
    let id = path
        .strip_prefix("/v1/models/")
        .or_else(|| path.strip_prefix("/openai/v1/models/"))?;
    (!id.is_empty() && !id.contains('/')).then(|| id.to_string())
}

pub(super) fn build_model_detail_response(
    requested_id: &str,
    routes: &[RouteCandidate],
    accounts: &[ChannelAccount],
    channels: &[ChannelPreset],
    channel_models: &[ChannelModel],
    models_cn_json: Option<&str>,
) -> Response {
    let entries = collect_model_entries(routes, accounts, channels, &ProtocolType::OpenAi);
    let Some(entry) = entries.iter().find(|entry| entry.id == requested_id) else {
        return model_not_found_response(requested_id);
    };

    let usable_routes = usable_model_routes(requested_id, routes, accounts, channels);
    let catalog =
        models_cn_json.and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok());
    let mut candidates = Vec::new();
    for route in usable_routes {
        let upstream = channel_models.iter().find(|model| {
            model.channel_id == route.channel_id
                && crate::core::model_catalog::canonical_model_key(&model.model)
                    == crate::core::model_catalog::canonical_model_key(&route.upstream_model)
        });
        let catalog_model = catalog
            .as_ref()
            .and_then(|value| find_models_cn_model(value, &route.upstream_model));
        candidates.push(resolve_candidate_detail(route, upstream, catalog_model));
    }

    let context_window = min_present(candidates.iter().map(|item| item.context_window));
    let max_output_tokens = min_present(candidates.iter().map(|item| item.max_output_tokens));
    let pricing = aggregate_pricing(&candidates);
    let sources = candidates
        .iter()
        .map(|item| item.specification_source.as_str())
        .filter(|source| *source != "unavailable")
        .collect::<BTreeSet<_>>();
    let specification_source = match sources.len() {
        0 => "unavailable",
        1 => sources.iter().next().copied().unwrap_or("unavailable"),
        _ => "mixed",
    };

    json_response(serde_json::json!({
        "id": entry.id,
        "object": "model",
        "created": parse_unix_seconds(&entry.created_at),
        "owned_by": entry.owned_by,
        "context_window": context_window,
        // 当前上游详情与 models-cn 均未提供独立的最大输入字段。
        // context_window 的预算语义不明确，不能通过减去最大输出进行猜测。
        "max_input_tokens": serde_json::Value::Null,
        "max_output_tokens": max_output_tokens,
        "specification_source": specification_source,
        "pricing": pricing,
    }))
}

struct CandidateDetail {
    context_window: Option<i64>,
    max_output_tokens: Option<i64>,
    specification_source: String,
    pricing: Option<serde_json::Value>,
}

fn usable_model_routes<'a>(
    model_id: &str,
    routes: &'a [RouteCandidate],
    accounts: &[ChannelAccount],
    channels: &[ChannelPreset],
) -> Vec<&'a RouteCandidate> {
    let healthy_accounts = accounts
        .iter()
        .filter(|account| {
            account.enabled
                && !account.api_key.trim().is_empty()
                && account.credential_status == ACCOUNT_CREDENTIAL_HEALTHY
        })
        .map(|account| account.id.as_str())
        .collect::<BTreeSet<_>>();
    let enabled_channels = channels
        .iter()
        .filter(|channel| channel.enabled)
        .map(|channel| channel.id.as_str())
        .collect::<BTreeSet<_>>();
    routes
        .iter()
        .filter(|route| {
            route.enabled
                && route.client_protocol == ProtocolType::OpenAi
                && route.virtual_model_id == model_id
                && healthy_accounts.contains(route.account_id.as_str())
                && enabled_channels.contains(route.channel_id.as_str())
        })
        .collect()
}

struct ModelsCnMatch<'a> {
    model: &'a serde_json::Value,
    retrieved_at: Option<&'a str>,
}

fn find_models_cn_model<'a>(
    catalog: &'a serde_json::Value,
    model_id: &str,
) -> Option<ModelsCnMatch<'a>> {
    let identity = crate::core::model_catalog::model_catalog().find(model_id)?;
    let canonical = identity.id.as_str();
    catalog
        .get("providers")?
        .as_array()?
        .iter()
        .find_map(|provider| {
            (provider.get("id")?.as_str()? == identity.models_cn_provider_id)
                .then_some(provider)?
                .get("models")?
                .as_array()?
                .iter()
                .find(|model| model.get("id").and_then(|value| value.as_str()) == Some(canonical))
                .map(|model| {
                    let retrieved_at = provider
                        .get("sources")
                        .and_then(|sources| sources.as_array())
                        .and_then(|sources| {
                            sources
                                .iter()
                                .filter(|source| {
                                    source.get("kind").and_then(|value| value.as_str())
                                        == Some("pricing")
                                })
                                .filter_map(|source| {
                                    source.get("retrievedAt").and_then(|value| value.as_str())
                                })
                                .min()
                        });
                    ModelsCnMatch {
                        model,
                        retrieved_at,
                    }
                })
        })
}

fn resolve_candidate_detail(
    route: &RouteCandidate,
    upstream: Option<&ChannelModel>,
    catalog_match: Option<ModelsCnMatch<'_>>,
) -> CandidateDetail {
    let catalog_model = catalog_match.as_ref().map(|found| found.model);
    let catalog_context = catalog_model
        .and_then(|model| model.pointer("/limits/contextTokens"))
        .and_then(|value| value.as_i64());
    let catalog_output = catalog_model
        .and_then(|model| model.pointer("/limits/maxOutputTokens"))
        .and_then(|value| value.as_i64());
    let upstream_context = upstream.and_then(|model| model.context_window);
    let upstream_output = upstream.and_then(|model| model.max_output_tokens);
    let specification_source = if upstream_context.is_some() || upstream_output.is_some() {
        if (upstream_context.is_none() && catalog_context.is_some())
            || (upstream_output.is_none() && catalog_output.is_some())
        {
            "upstream+models-cn"
        } else {
            "upstream"
        }
    } else if catalog_context.is_some() || catalog_output.is_some() {
        "models-cn"
    } else {
        "unavailable"
    };
    CandidateDetail {
        context_window: upstream_context.or(catalog_context),
        max_output_tokens: upstream_output.or(catalog_output),
        specification_source: specification_source.to_string(),
        pricing: upstream
            .and_then(|model| model.pricing.as_ref())
            .map(|price| upstream_pricing_json(route, price))
            .or_else(|| {
                catalog_model.and_then(select_models_cn_price).map(|price| {
                    pricing_json(
                        route,
                        price,
                        catalog_match.and_then(|found| found.retrieved_at),
                    )
                })
            }),
    }
}

fn upstream_pricing_json(route: &RouteCandidate, pricing: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "channel_id": route.channel_id,
        "upstream_model": route.upstream_model,
        "source": "upstream",
        "raw": pricing
    })
}

fn select_models_cn_price(model: &serde_json::Value) -> Option<&serde_json::Value> {
    model.get("prices")?.as_array()?.iter().max_by_key(|price| {
        let market = price
            .get("market")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let currency = price
            .get("currency")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let rate_type = price
            .get("rateType")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        i32::from(market == "china") * 4
            + i32::from(currency == "CNY") * 2
            + i32::from(rate_type == "promotional")
    })
}

fn pricing_json(
    route: &RouteCandidate,
    price: &serde_json::Value,
    retrieved_at: Option<&str>,
) -> serde_json::Value {
    let input = price
        .get("input")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    serde_json::json!({
        "channel_id": route.channel_id,
        "upstream_model": route.upstream_model,
        "market": price.get("market"),
        "currency": price.get("currency"),
        "unit": price.get("unit"),
        "rate_type": price.get("rateType"),
        "input": {
            "standard": input.get("standard"),
            "cache_hit": input.get("cacheHit"),
            "explicit_cache_creation": input.get("explicitCacheCreation"),
            "explicit_cache_hit": input.get("explicitCacheHit"),
        },
        "output": price.get("output"),
        "source_url": price.get("sourceUrl"),
        "retrieved_at": retrieved_at,
        "source": "models-cn"
    })
}

fn aggregate_pricing(candidates: &[CandidateDetail]) -> Vec<serde_json::Value> {
    let mut by_currency = std::collections::BTreeMap::<String, serde_json::Value>::new();
    for price in candidates
        .iter()
        .filter_map(|candidate| candidate.pricing.as_ref())
    {
        let currency = price
            .get("currency")
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| {
                format!(
                    "upstream:{}:{}",
                    price
                        .get("channel_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or(""),
                    price
                        .get("upstream_model")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                )
            });
        let replace = by_currency.get(&currency).is_none_or(|current| {
            let current_total = current
                .pointer("/input/standard")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0)
                + current
                    .get("output")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0);
            let next_total = price
                .pointer("/input/standard")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0)
                + price.get("output").and_then(|v| v.as_f64()).unwrap_or(0.0);
            next_total > current_total
        });
        if replace {
            by_currency.insert(currency, price.clone());
        }
    }
    by_currency.into_values().collect()
}

fn min_present(values: impl Iterator<Item = Option<i64>>) -> Option<i64> {
    values.flatten().min()
}

fn parse_unix_seconds(raw: &str) -> i64 {
    if raw.is_empty() {
        return 0;
    }
    raw.parse::<i64>()
        .ok()
        .or_else(|| {
            chrono::DateTime::parse_from_rfc3339(raw)
                .ok()
                .map(|dt| dt.timestamp())
        })
        .unwrap_or(0)
}

fn model_not_found_response(model_id: &str) -> Response {
    let mut response = json_response(serde_json::json!({
        "error": {
            "message": format!("The model '{}' does not exist or is not exposed", model_id),
            "type": "invalid_request_error",
            "param": "model",
            "code": "model_not_found"
        }
    }));
    *response.status_mut() = StatusCode::NOT_FOUND;
    response
}

pub(super) fn build_model_list_response(
    routes: &[RouteCandidate],
    accounts: &[ChannelAccount],
    channels: &[ChannelPreset],
    protocol: &ProtocolType,
) -> Response {
    let entries = collect_model_entries(routes, accounts, channels, protocol);

    match protocol {
        // Responses 没有独立模型列表端点（/v1/models 归属 OpenAI 协议），
        // 此分支仅为穷尽匹配兜底，形状沿用 OpenAI。
        ProtocolType::OpenAi | ProtocolType::Responses => build_openai_model_list(&entries),
        ProtocolType::Anthropic => build_anthropic_model_list(&entries),
    }
}

/// 单个对外模型的展示信息。owned_by 用于 OpenAI-compatible 模型列表。
#[derive(Clone)]
struct ModelEntry {
    id: String,
    owned_by: String,
    created_at: String,
}

/// 从 routes 中按 protocol+enabled+healthy 过滤后，收集对外模型集合。
/// 同时包含聚合模型（flowlet-pro/flash）与直接底层模型。
/// 直接模型：virtual_model_id === upstream_model，以渠道 vendor 为 owned_by；
/// 聚合模型：owned_by = "flowlet"。
fn collect_model_entries(
    routes: &[RouteCandidate],
    accounts: &[ChannelAccount],
    channels: &[ChannelPreset],
    protocol: &ProtocolType,
) -> Vec<ModelEntry> {
    // 账号健康判断与路由候选池一致：必须 enabled + API Key 非空 + credential_status = healthy。
    let healthy_accounts: BTreeSet<&str> = accounts
        .iter()
        .filter(|a| {
            a.enabled
                && !a.api_key.trim().is_empty()
                && a.credential_status == ACCOUNT_CREDENTIAL_HEALTHY
        })
        .map(|a| a.id.as_str())
        .collect();

    let dual_protocol_channels: BTreeSet<&str> = channels
        .iter()
        .filter(|channel| {
            channel.supported_protocols.contains(&ProtocolType::OpenAi)
                && channel
                    .supported_protocols
                    .contains(&ProtocolType::Anthropic)
        })
        .map(|channel| channel.id.as_str())
        .collect();

    let vendor_by_channel: std::collections::HashMap<&str, &str> = channels
        .iter()
        .map(|channel| (channel.id.as_str(), channel.vendor.as_str()))
        .collect();

    let mut result: Vec<ModelEntry> = Vec::new();
    let mut seen = BTreeSet::new();

    for route in routes {
        if !route.enabled
            || route.client_protocol != *protocol
            || !healthy_accounts.contains(route.account_id.as_str())
        {
            continue;
        }
        let is_aggregate = matches!(
            route.virtual_model_id.as_str(),
            "flowlet-pro" | "flowlet-flash"
        );
        // 聚合模型必须来自双协议渠道；直接模型按 client_protocol 自然兼容。
        if is_aggregate && !dual_protocol_channels.contains(route.channel_id.as_str()) {
            continue;
        }
        // 直接模型：对外模型名必须与上游模型名一致（不允许同名非直接路由混入）。
        if !is_aggregate && route.virtual_model_id != route.upstream_model {
            continue;
        }
        let id = route.virtual_model_id.trim();
        if id.is_empty() || !seen.insert(id.to_string()) {
            continue;
        }
        let owned_by = if is_aggregate {
            "flowlet".to_string()
        } else {
            vendor_by_channel
                .get(route.channel_id.as_str())
                .copied()
                .unwrap_or("flowlet")
                .to_string()
        };
        result.push(ModelEntry {
            id: id.to_string(),
            owned_by,
            created_at: route.created_at.clone(),
        });
    }
    // 排序固定：flowlet-pro → flowlet-flash → 其余按名字典序（需求八）。
    result.sort_by(|a, b| {
        rank_model(&a.id)
            .cmp(&rank_model(&b.id))
            .then_with(|| a.id.cmp(&b.id))
    });
    result
}

fn rank_model(id: &str) -> u8 {
    match id {
        "flowlet-pro" => 0,
        "flowlet-flash" => 1,
        _ => 2,
    }
}

fn build_openai_model_list(entries: &[ModelEntry]) -> Response {
    // Flowlet 聚合模型的 owned_by 固定为 "flowlet"；直接模型使用其所属渠道 vendor。
    let data: Vec<serde_json::Value> = entries
        .iter()
        .map(|entry| {
            serde_json::json!({
                "id": entry.id,
                "object": "model",
                "created": parse_unix_seconds(&entry.created_at),
                "owned_by": entry.owned_by
            })
        })
        .collect();

    json_response(serde_json::json!({
        "object": "list",
        "data": data
    }))
}

fn build_anthropic_model_list(entries: &[ModelEntry]) -> Response {
    // Anthropic GET /v1/models 官方 schema（参考 docs.claude.com）：
    // { "data": [{ "id": "...", "type": "model", "display_name": "...", "created_at": "RFC3339" }],
    //   "has_more": false, "first_id": "...", "last_id": "..." }
    let data: Vec<serde_json::Value> = entries
        .iter()
        .map(|entry| {
            let created_at = if entry.created_at.is_empty() {
                "1970-01-01T00:00:00Z"
            } else {
                entry.created_at.as_str()
            };
            serde_json::json!({
                "id": entry.id,
                "type": "model",
                "display_name": entry.id,
                "created_at": created_at
            })
        })
        .collect();

    let first_id = data.first().and_then(|v| v["id"].as_str()).unwrap_or("");
    let last_id = data.last().and_then(|v| v["id"].as_str()).unwrap_or("");

    json_response(serde_json::json!({
        "data": data,
        "has_more": false,
        "first_id": first_id,
        "last_id": last_id
    }))
}

fn json_response(value: serde_json::Value) -> Response {
    let mut response = Response::new(Body::from(value.to_string()));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
}

pub(super) fn is_streaming_response(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.contains("text/event-stream"))
        .unwrap_or(false)
}

// ─── URL Building ────────────────────────────────────────────────────────────

pub(super) fn build_upstream_url(
    base_url: &str,
    original_uri: &Uri,
    protocol: &ProtocolType,
) -> String {
    let base = base_url.trim_end_matches('/');
    let path = original_uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");

    match protocol {
        ProtocolType::OpenAi | ProtocolType::Responses => {
            // 保留 /v1 和 /openai/v1 前缀，因为 base_url 已经包含了 /openai 或 /v1 的入口前缀。
            // Responses 与 OpenAI 共享 Base URL：`/v1/responses` 拼出 `{base}/v1/responses`
            //（dashscope 等自带 /v1 后缀的 base 经 strip_duplicate_v1 去重后同样正确）。
            let path = path.trim_start_matches("/openai");
            let base = strip_duplicate_v1(base, path);
            format!("{base}{path}")
        }
        ProtocolType::Anthropic => {
            // 保留 /v1 前缀，只去掉 /anthropic 入口前缀
            let path = path.trim_start_matches("/anthropic");
            let base = strip_duplicate_v1(base, path);
            format!("{base}{path}")
        }
    }
}

/// 智谱（zhipu）OpenAI 兼容端点的路径不带 `/v1` 前缀：
/// 官方端点为 `/api/paas/v4/chat/completions` 而非 `/api/paas/v4/v1/chat/completions`。
/// 入站 `/v1/chat/completions` / `/v1/models` 转发时去掉 `/v1`（同时兼容
/// `/openai/v1/...` 入口前缀的防御性去除），得到 `{base}/chat/completions`。
pub(super) fn build_upstream_url_without_openai_v1(base_url: &str, original_uri: &Uri) -> String {
    let base = base_url.trim_end_matches('/');
    let path = original_uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");
    let path = path.trim_start_matches("/openai").trim_start_matches("/v1");
    format!("{base}{path}")
}

/// 许多 OpenAI-compatible 端点的官方 Base URL 本身就带 `/v1` 后缀
/// （dashscope `compatible-mode/v1`、token-plan、moonshot `api.moonshot.cn/v1` 等），
/// 而入站请求路径同样以 `/v1` 开头。直接拼接会得到 `.../v1/v1/chat/completions`，
/// 因此在路径已含 `/v1` 前缀时去掉 base 的尾随 `/v1`，避免重复。
/// 路径不带 `/v1` 时保留 base 原样，确保 `base(.../v1) + /chat/completions` 仍然正确。
fn strip_duplicate_v1<'a>(base: &'a str, path: &str) -> &'a str {
    if path.starts_with("/v1/") || path == "/v1" {
        base.strip_suffix("/v1").unwrap_or(base)
    } else {
        base
    }
}

// ─── Header Handling ────────────────────────────────────────────────────────

pub(super) fn apply_request_headers(
    mut builder: reqwest::RequestBuilder,
    headers: &HeaderMap,
    api_key: &str,
    protocol: &ProtocolType,
    auth_strategy: &AuthStrategy,
) -> reqwest::RequestBuilder {
    for (name, value) in headers {
        if is_hop_by_hop(name.as_str())
            || name == header::HOST
            // 请求 body 可能在路由阶段改写 model，旧长度不能继续透传。
            // 交给 reqwest 根据最终 body 自动生成 Content-Length。
            || name == header::CONTENT_LENGTH
            || name == header::AUTHORIZATION
            || name.as_str() == "x-api-key"
            // 客户端归属标记头仅用于本地识别，识别后不再透传上游，避免泄露受管信息。
            || name.as_str() == AGENT_CLIENT_HEADER
            // Pi 会话标识头仅用于本地会话归属，识别后不再透传上游。
            || name.as_str() == AGENT_SESSION_HEADER
        {
            continue;
        }
        if name.as_str() == "anthropic-beta" {
            // 过滤 Claude Code 长上下文附带的 context-1m beta（见下方说明）。
            if let Some(filtered) = filter_anthropic_beta(value) {
                builder = builder.header(name, filtered);
            }
            continue;
        }
        builder = builder.header(name, value);
    }

    if !api_key.trim().is_empty() {
        match auth_strategy {
            AuthStrategy::Bearer => {
                builder = builder.bearer_auth(api_key.trim());
            }
            AuthStrategy::XApiKey => {
                builder = builder.header("x-api-key", api_key.trim());
            }
        }
    }

    let _ = protocol;
    builder
}

/// Claude Code 开启 1M 上下文时会在 `anthropic-beta` 附带
/// `context-1m-2025-08-07`。这是 Anthropic 官方 API 的 beta 标志，转发给
/// 第三方 Anthropic 兼容端点可能因未知 beta 被拒绝；Flowlet 支持的上游
/// （LongCat / DeepSeek / Kimi / 千问等）各自管理上下文长度，故转发前剔除
/// 该项，保留其余 beta。返回 `None` 表示过滤后为空、应整体丢弃该头。
/// 注：若未来接入 Anthropic 官方 API 渠道，应按上游 host 条件化保留。
fn filter_anthropic_beta(value: &HeaderValue) -> Option<HeaderValue> {
    const CONTEXT_1M_BETA: &str = "context-1m-2025-08-07";
    let Ok(raw) = value.to_str() else {
        return Some(value.clone());
    };
    let kept = raw
        .split(',')
        .map(str::trim)
        .filter(|token| !token.is_empty() && !token.eq_ignore_ascii_case(CONTEXT_1M_BETA))
        .collect::<Vec<_>>();
    if kept.is_empty() {
        return None;
    }
    HeaderValue::from_maybe_shared(kept.join(",")).ok()
}

pub(super) fn copy_response_headers(source: &HeaderMap, target: &mut HeaderMap<HeaderValue>) {
    for (name, value) in source {
        if is_hop_by_hop(name.as_str()) {
            continue;
        }
        target.append(name, value.clone());
    }
}

pub(super) fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

// ─── Client Identification ──────────────────────────────────────────────────

/// 通过鉴权 token（Authorization Bearer 或 X-Api-Key）识别客户端。
/// 匹配 `default_client_token`（来自 ProxyBindConfig）。
pub(super) fn identify_client(
    headers: &HeaderMap,
    default_token: &str,
) -> Option<(String, String)> {
    // 1. 先检查 Authorization Bearer
    if let Some(token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
    {
        if token == default_token {
            return Some(("default".to_string(), "默认客户端".to_string()));
        }
    }

    // 2. 再检查 X-Api-Key
    if let Some(token) = headers
        .get("x-api-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
    {
        if token == default_token {
            return Some(("default".to_string(), "默认客户端".to_string()));
        }
    }

    None
}

/// 从 config.json 加载时只要 ua_rules 数组。
/// config.json 顶层既可以是 { "ua_rules": [...] }（新格式），也可以是旧格式的 [...]。
fn extract_ua_rules(value: serde_json::Value) -> Vec<UaClientRule> {
    if let Some(arr) = value.as_array() {
        return serde_json::from_value::<Vec<UaClientRule>>(serde_json::Value::Array(arr.to_vec()))
            .unwrap_or_default();
    }
    if let Some(arr) = value.pointer("/ua_rules").and_then(|v| v.as_array()) {
        return serde_json::from_value::<Vec<UaClientRule>>(serde_json::Value::Array(arr.to_vec()))
            .unwrap_or_default();
    }
    Vec::new()
}

/// 从 config.json 顶层对象解析 log_capture 配置。缺失任何字段时使用默认值。
pub fn extract_log_capture(value: &serde_json::Value) -> crate::core::config::LogCaptureConfig {
    use crate::core::config::LogCaptureConfig;
    if let Some(obj) = value.as_object() {
        if let Some(lc) = obj.get("log_capture").and_then(|v| v.as_object()) {
            return LogCaptureConfig {
                capture_req_headers: lc
                    .get("capture_req_headers")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true),
                capture_req_body: lc
                    .get("capture_req_body")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true),
                capture_res_headers: lc
                    .get("capture_res_headers")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true),
                capture_res_body: lc
                    .get("capture_res_body")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true),
                max_body_bytes: lc
                    .get("max_body_bytes")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1024 * 1024) as usize,
                redact_sensitive_headers: lc
                    .get("redact_sensitive_headers")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                body_retention_days: lc
                    .get("body_retention_days")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(3),
                body_max_size_mb: lc
                    .get("body_max_size_mb")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(512),
                body_prune_ratio: lc
                    .get("body_prune_ratio")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.1),
            };
        }
    }
    LogCaptureConfig::default()
}

/// Flowlet 与受管 Agent 约定的客户端标记头。
///
/// 部分 Agent（如 Pi）复用通用 SDK 的 User-Agent（例如 `OpenAI/JS`），无法靠 UA
/// 子串区分，故由 Flowlet 在写入其全局配置时注入本头，值即客户端 id。识别时优先
/// 读取本头，再回退到 UA 规则，确保开箱即可归属，不依赖用户 config.json 是否含
/// 对应规则。该头仅用于本地归属，不参与鉴权或路由；Flowlet 在识别后、转发上游前
/// 会将其剥离，不向上游泄露。
pub(super) use crate::core::agent_session_identity::{AGENT_CLIENT_HEADER, AGENT_SESSION_HEADER};

/// Pi 与 Flowlet 约定的会话标识头。
///
/// Pi 走 OpenAI 兼容 SDK，原生请求不带会话标识。Flowlet 在写入 Pi 配置时会同时
/// 写入一个扩展（`~/.pi/agent/extensions/flowlet.ts`），在每次 LLM 请求的 headers
/// 组装完成后注入本头，值即当前会话 UUID（与 Pi 原生会话文件头行的 `id` 一致），
/// 使 Flowlet 能把请求按会话归并，并与原生会话数据按 `(agent_type, session_id)` 合并。
/// 该头仅用于本地会话归属，不参与鉴权或路由；Flowlet 在识别后、转发上游前会将其
/// 剥离，不向上游泄露。识别时以 `x-flowlet-client: pi` 标记头为门控，避免误读其他
/// 客户端的同名头。

/// 标记头值 → 展示名。仅收录 UA 无法区分、需要靠标记头识别的 Agent。
fn agent_client_marker_name(value: &str) -> Option<&'static str> {
    match value {
        "pi" => Some("Pi"),
        _ => None,
    }
}

/// 识别客户端身份：优先读取 Flowlet 标记头，再回退 UA 子串规则。
///
/// 与鉴权 token 无关，仅决定日志/用量中的客户端归属。返回 (id, name)；
/// 标记头与 UA 规则均无命中时返回 None。
pub(super) fn identify_client_agent(
    headers: &HeaderMap,
    rules: &[UaClientRule],
) -> Option<(String, String)> {
    if let Some(value) = headers
        .get(AGENT_CLIENT_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        let id = value.to_ascii_lowercase();
        let name = agent_client_marker_name(&id)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| value.to_string());
        return Some((id, name));
    }
    identify_client_by_ua(headers, rules)
}

/// 通过请求 User-Agent 子串匹配独立的客户端身份规则。
///
/// 与鉴权 token 无关，仅决定日志/用量中的客户端归属。返回命中的
/// UaClientRule 的 (id, name)；无任何命中时返回 None。
pub(super) fn identify_client_by_ua(
    headers: &HeaderMap,
    rules: &[UaClientRule],
) -> Option<(String, String)> {
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())?;
    rules
        .iter()
        .find(|r| r.enabled && !r.pattern.is_empty() && ua.contains(&r.pattern))
        .map(|r| (r.id.clone(), r.name.clone()))
}

/// 确保运行时 config.json 存在；缺失时写入编译时内置的完整默认配置。
pub(super) fn ensure_config_file(path: &std::path::Path) {
    if path.exists() {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, crate::core::channels_config::DEFAULT_CONFIG_JSON);
}

/// Flowlet 内置兜底 UA 规则。用户 config.json 中的规则优先：仅补充用户文件里
/// id 完全不存在的条目（用户显式禁用某 id 时尊重用户选择）。这样已有安装
///（config.json 早于新规则）无需手动改配置即可获得新 Agent 的客户端归属；
/// 新安装则从 config.json 默认集中直接获得同样的规则。
fn builtin_ua_rules() -> Vec<UaClientRule> {
    vec![
        UaClientRule {
            id: "codex".to_string(),
            pattern: "codex_cli_rs/".to_string(),
            name: "Codex".to_string(),
            enabled: true,
        },
        UaClientRule {
            id: "codex-desktop".to_string(),
            pattern: "Codex Desktop/".to_string(),
            name: "Codex Desktop".to_string(),
            enabled: true,
        },
    ]
}

/// 从本地 config.json 文件加载 UA 客户端规则。文件不存在或解析失败时返回空列表。
pub(crate) fn load_config_ua_rules(path: &std::path::Path) -> Vec<UaClientRule> {
    let Ok(json) = std::fs::read_to_string(path) else {
        return builtin_ua_rules();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&json) else {
        return builtin_ua_rules();
    };
    let mut rules = extract_ua_rules(value);
    let existing_ids: std::collections::HashSet<String> =
        rules.iter().map(|rule| rule.id.clone()).collect();
    for rule in builtin_ua_rules() {
        if !existing_ids.contains(&rule.id) {
            rules.push(rule);
        }
    }
    rules
}

// 向后兼容：旧代码里 load_ua_rules(...) 仍然可用
pub(super) use load_config_ua_rules as load_ua_rules;

// ─── Model Rewriting ─────────────────────────────────────────────────────────

/// Claude Code 用 `[1m]` 模型名后缀启用百万级上下文窗口预算，正常情况下会在
/// 发送请求前剥离后缀；这里防御性再剥离一次，确保带后缀的请求仍能命中对外
/// 模型（对普通模型无影响）。
fn strip_long_context_suffix(model: &str) -> &str {
    if model.to_ascii_lowercase().ends_with("[1m]") {
        &model[..model.len() - 4]
    } else {
        model
    }
}

pub(super) fn extract_model(body: &[u8], protocol: &ProtocolType) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    let model = match protocol {
        // Responses 请求体同样在顶层携带 model 字段。
        ProtocolType::OpenAi | ProtocolType::Responses => {
            value.get("model").and_then(|v| v.as_str())
        }
        ProtocolType::Anthropic => value.get("model").and_then(|v| v.as_str()),
    }?;
    Some(strip_long_context_suffix(model).to_string())
}

// ─── Header Sanitization + Body Encoding ─────────────────────────────────────

/// Serialize HTTP headers to a JSON object, redacting sensitive values.
///
/// 1. Hop-by-hop headers are skipped (reuses
///    [`is_hop_by_hop`]).
/// 2. Header names in `redact` are lower-cased and replaced with
///    `"[redacted]"`. This prevents leakage of Authorization tokens,
///    x-api-key values, and cookies into the request log payload.
pub(super) fn sanitize_headers(headers: &HeaderMap, redact: &[&str]) -> serde_json::Value {
    let redact_lower: std::collections::HashSet<String> =
        redact.iter().map(|key| key.to_ascii_lowercase()).collect();
    let mut map = serde_json::Map::new();
    for (name, value) in headers {
        if is_hop_by_hop(name.as_str()) {
            continue;
        }
        let key = name.as_str().to_string();
        let value = if redact_lower.contains(&key.to_ascii_lowercase()) {
            serde_json::Value::String("[redacted]".to_string())
        } else {
            value
                .to_str()
                .map(|v| serde_json::Value::String(v.to_string()))
                .unwrap_or_else(|_| serde_json::Value::String("[non-ascii]".to_string()))
        };
        map.insert(key, value);
    }
    serde_json::Value::Object(map)
}

pub(super) fn encode_body_base64(body: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(body)
}

pub(super) fn truncate_utf8(body: &mut Vec<u8>, max: usize) {
    if body.len() <= max {
        return;
    }
    let mut cut = max;
    // 回退到最近的 UTF-8 字符边界（UTF-8 续字节以 10xxxxxx 开头）
    while cut > 0 && (body[cut] & 0b1100_0000) == 0b1000_0000 {
        cut -= 1;
    }
    body.truncate(cut);
}

/// 读取响应头中的 content-encoding 首值（小写、去空白）。
/// reqwest 未启用自动解压 feature，上游压缩体会原样透传，捕获层需据此解压。
pub(super) fn content_encoding_value(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(',')
                .next()
                .unwrap_or(value)
                .trim()
                .to_ascii_lowercase()
        })
        .filter(|value| !value.is_empty())
}

/// 按 content-encoding 对捕获到的压缩体做一次性解压，支持 gzip / deflate / br。
/// 解压输出受 max_out 上限保护，避免压缩炸弹；无法识别或解压失败时回退原字节，
/// 保证日志可见性优先于完美解码。
pub(super) fn decompress_for_capture(
    body: &[u8],
    content_encoding: Option<&str>,
    max_out: usize,
) -> Vec<u8> {
    let encoding = match content_encoding {
        Some(value) => value,
        None => return body.to_vec(),
    };
    let result: std::io::Result<Vec<u8>> = match encoding {
        "gzip" | "x-gzip" => read_capped(flate2::read::GzDecoder::new(body), max_out),
        "deflate" => read_capped(flate2::read::DeflateDecoder::new(body), max_out),
        "br" => read_capped(brotli::Decompressor::new(body, 4096), max_out),
        _ => return body.to_vec(),
    };
    result.unwrap_or_else(|_| body.to_vec())
}

fn read_capped(mut reader: impl Read, max_out: usize) -> std::io::Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        if out.len() >= max_out {
            break;
        }
        let to_read = buf.len().min(max_out - out.len());
        let n = reader.read(&mut buf[..to_read])?;
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n]);
    }
    Ok(out)
}

/// 捕获响应体的统一入口：按 content-encoding 解压 → 截断到 UTF-8 边界 → base64。
pub(super) fn prepare_captured_res_body(
    body: &[u8],
    content_encoding: Option<&str>,
    max_bytes: usize,
) -> Option<String> {
    if body.is_empty() {
        return None;
    }
    let mut decompressed = decompress_for_capture(body, content_encoding, max_bytes);
    truncate_utf8(&mut decompressed, max_bytes);
    Some(encode_body_base64(&decompressed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_capture_missing_size_limit_uses_512_mb_default() {
        let config = extract_log_capture(&serde_json::json!({ "log_capture": {} }));
        assert_eq!(config.body_max_size_mb, 512);
    }

    #[test]
    fn sanitize_headers_redacts_bearer() {
        let mut map = HeaderMap::new();
        map.insert("authorization", HeaderValue::from_static("Bearer abc"));
        map.insert("content-type", HeaderValue::from_static("application/json"));
        let redacted = sanitize_headers(&map, &["authorization"]);
        let obj = redacted.as_object().unwrap();
        assert_eq!(obj["authorization"], "[redacted]");
        assert_eq!(obj["content-type"], "application/json");
    }

    #[test]
    fn encode_body_roundtrips_string() {
        let encoded = encode_body_base64(b"hello");
        assert_eq!(encoded, "aGVsbG8=");
    }

    fn gzip_compress(bytes: &[u8]) -> Vec<u8> {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn decompress_for_capture_handles_gzip_and_unknown() {
        let plain = br#"{"ok":true,"msg":"hello world"}"#;
        let compressed = gzip_compress(plain);
        assert_eq!(
            decompress_for_capture(&compressed, Some("gzip"), 1024),
            plain.to_vec()
        );
        // 未压缩体 + 无编码头：原样返回
        assert_eq!(decompress_for_capture(plain, None, 1024), plain.to_vec());
        // 未知编码：原样返回，不丢数据
        assert_eq!(
            decompress_for_capture(&compressed, Some("identity"), 1024),
            compressed
        );
    }

    #[test]
    fn prepare_captured_res_body_decompresses_then_truncates_utf8() {
        let plain = br#"{"ok":true,"msg":"hello world"}"#;
        let compressed = gzip_compress(plain);
        let encoded = prepare_captured_res_body(&compressed, Some("gzip"), 1024).unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        assert_eq!(decoded, plain);

        // 空体返回 None
        assert!(prepare_captured_res_body(&[], Some("gzip"), 1024).is_none());

        // 解压上限生效：上限小于明文时只保留前缀，且不破坏 UTF-8 边界
        let capped = prepare_captured_res_body(&compressed, Some("gzip"), 8).unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(capped)
            .unwrap();
        assert!(decoded.len() <= 8);
        assert!(std::str::from_utf8(&decoded).is_ok());
    }

    #[test]
    fn content_encoding_value_takes_first_token_lowercase() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_ENCODING,
            HeaderValue::from_static(" Gzip, identity"),
        );
        assert_eq!(content_encoding_value(&headers).as_deref(), Some("gzip"));
        let empty = HeaderMap::new();
        assert_eq!(content_encoding_value(&empty), None);
    }

    #[test]
    fn apply_request_headers_drops_stale_content_length() {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_LENGTH, HeaderValue::from_static("1"));
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );

        let request = apply_request_headers(
            reqwest::Client::new().post("http://127.0.0.1/test"),
            &headers,
            "upstream-secret",
            &ProtocolType::OpenAi,
            &AuthStrategy::Bearer,
        )
        .body("hello")
        .build()
        .unwrap();

        assert_ne!(
            request
                .headers()
                .get(header::CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok()),
            Some("1")
        );
        assert_eq!(
            request
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some("application/json")
        );
    }

    #[test]
    fn apply_request_headers_replaces_client_bearer_credentials() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer client-token"),
        );
        headers.insert("x-api-key", HeaderValue::from_static("client-api-key"));

        let request = apply_request_headers(
            reqwest::Client::new().post("http://127.0.0.1/test"),
            &headers,
            "upstream-secret",
            &ProtocolType::OpenAi,
            &AuthStrategy::Bearer,
        )
        .body("{}")
        .build()
        .unwrap();

        assert_eq!(
            request
                .headers()
                .get(header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok()),
            Some("Bearer upstream-secret")
        );
        assert!(!request.headers().contains_key("x-api-key"));
    }

    #[test]
    fn apply_request_headers_replaces_client_x_api_key_credentials() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer client-token"),
        );
        headers.insert("x-api-key", HeaderValue::from_static("client-api-key"));

        let request = apply_request_headers(
            reqwest::Client::new().post("http://127.0.0.1/test"),
            &headers,
            "upstream-secret",
            &ProtocolType::Anthropic,
            &AuthStrategy::XApiKey,
        )
        .body("{}")
        .build()
        .unwrap();

        assert!(!request.headers().contains_key(header::AUTHORIZATION));
        assert_eq!(
            request
                .headers()
                .get("x-api-key")
                .and_then(|value| value.to_str().ok()),
            Some("upstream-secret")
        );
    }

    #[test]
    fn apply_request_headers_strips_agent_client_marker_before_forwarding() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::USER_AGENT,
            HeaderValue::from_static("OpenAI/JS 6.26.0"),
        );
        headers.insert(AGENT_CLIENT_HEADER, HeaderValue::from_static("pi"));

        let request = apply_request_headers(
            reqwest::Client::new().post("http://127.0.0.1/test"),
            &headers,
            "",
            &ProtocolType::OpenAi,
            &AuthStrategy::Bearer,
        )
        .body("{}")
        .build()
        .unwrap();

        // 标记头仅用于本地归属，转发上游前必须剥离。
        assert!(!request.headers().contains_key(AGENT_CLIENT_HEADER));
        // 其余普通头（含 UA）照常透传。
        assert!(request.headers().contains_key(header::USER_AGENT));
    }

    #[test]
    fn extract_model_strips_long_context_suffix() {
        // Claude Code 的 [1m] 后缀正常会在发送前剥离；代理层防御性兼容带后缀的请求。
        let suffixed = br#"{"model":"flowlet-pro[1m]"}"#;
        assert_eq!(
            extract_model(suffixed, &ProtocolType::Anthropic).as_deref(),
            Some("flowlet-pro")
        );
        let upper = br#"{"model":"flowlet-pro[1M]"}"#;
        assert_eq!(
            extract_model(upper, &ProtocolType::OpenAi).as_deref(),
            Some("flowlet-pro")
        );
        let plain = br#"{"model":"flowlet-pro"}"#;
        assert_eq!(
            extract_model(plain, &ProtocolType::Anthropic).as_deref(),
            Some("flowlet-pro")
        );
    }

    #[test]
    fn apply_request_headers_filters_context_1m_beta_only() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "anthropic-beta",
            HeaderValue::from_static("prompt-caching-2024-07-31, context-1m-2025-08-07"),
        );

        let request = apply_request_headers(
            reqwest::Client::new().post("http://127.0.0.1/test"),
            &headers,
            "",
            &ProtocolType::Anthropic,
            &AuthStrategy::Bearer,
        )
        .body("{}")
        .build()
        .unwrap();

        // context-1m 是 Anthropic 官方 beta，第三方兼容端点可能拒绝，需剔除；其余保留。
        assert_eq!(
            request
                .headers()
                .get("anthropic-beta")
                .and_then(|value| value.to_str().ok()),
            Some("prompt-caching-2024-07-31")
        );
    }

    #[test]
    fn apply_request_headers_drops_beta_header_when_only_context_1m() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "anthropic-beta",
            HeaderValue::from_static("context-1m-2025-08-07"),
        );

        let request = apply_request_headers(
            reqwest::Client::new().post("http://127.0.0.1/test"),
            &headers,
            "",
            &ProtocolType::Anthropic,
            &AuthStrategy::Bearer,
        )
        .body("{}")
        .build()
        .unwrap();

        assert!(!request.headers().contains_key("anthropic-beta"));
    }
}

pub(super) fn rewrite_model(
    body: &[u8],
    upstream_model: &str,
    _protocol: &ProtocolType,
) -> Vec<u8> {
    let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(body) else {
        return body.to_vec();
    };
    let Some(original_model) = value
        .get("model")
        .and_then(|field| field.as_str())
        .map(str::to_string)
    else {
        return body.to_vec();
    };
    let Some(model_field) = value.get_mut("model") else {
        return body.to_vec();
    };
    *model_field = serde_json::Value::String(upstream_model.to_string());

    let body_text = String::from_utf8_lossy(body);
    for (search, replacement) in [
        (
            format!(r#""model":"{}""#, original_model),
            format!(r#""model":"{}""#, upstream_model),
        ),
        (
            format!(r#""model": "{}""#, original_model),
            format!(r#""model": "{}""#, upstream_model),
        ),
    ] {
        if let Some(position) = body_text.find(&search) {
            let mut result = body_text.clone().into_owned();
            result.replace_range(position..position + search.len(), &replacement);
            return result.into_bytes();
        }
    }
    serde_json::to_vec(&value).unwrap_or_else(|_| body.to_vec())
}
