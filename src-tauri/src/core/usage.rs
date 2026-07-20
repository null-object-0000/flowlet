#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseUsage {
    pub input_tokens: Option<i64>,
    pub input_cached_tokens: Option<i64>,
    pub input_uncached_tokens: Option<i64>,
    pub input_cache_write_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
}

pub fn extract_response_usage(body: &[u8]) -> Option<ResponseUsage> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    extract_usage_from_value(&value)
}

/// Parse a completed OpenAI- or Anthropic-compatible SSE response. OpenAI
/// streams terminate with `data: [DONE]`; Anthropic streams terminate with a
/// `message_stop` event. Usage may be split between `message_start` and
/// `message_delta`, so fields are merged across the completed stream.
pub fn extract_sse_response_usage(body: &[u8]) -> Option<ResponseUsage> {
    let text = std::str::from_utf8(body).ok()?;
    let mut saw_done = false;
    let mut latest_usage = None;

    for line in text.lines() {
        let Some(data) = line.trim().strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data == "[DONE]" {
            saw_done = true;
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
            continue;
        };
        if value.get("type").and_then(serde_json::Value::as_str) == Some("message_stop") {
            saw_done = true;
        }
        if let Some(usage) = extract_usage_from_value(&value) {
            latest_usage = Some(match latest_usage {
                Some(current) => merge_usage(current, usage),
                None => usage,
            });
        }
    }

    saw_done.then_some(latest_usage).flatten()
}

/// Returns true once a completed SSE data line contains actual model output.
/// Metadata-only events (role, message_start, usage, keep-alive) do not count
/// toward TTFT.
pub fn contains_sse_output_token(body: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(body) else {
        return false;
    };

    text.lines().any(|line| {
        let Some(data) = line.trim().strip_prefix("data:") else {
            return false;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            return false;
        }
        serde_json::from_str::<serde_json::Value>(data)
            .ok()
            .is_some_and(|value| value_contains_output_token(&value))
    })
}

fn value_contains_output_token(value: &serde_json::Value) -> bool {
    let non_empty_string = |value: Option<&serde_json::Value>| {
        value
            .and_then(serde_json::Value::as_str)
            .is_some_and(|text| !text.is_empty())
    };

    if non_empty_string(value.get("delta"))
        || non_empty_string(value.get("completion"))
        || non_empty_string(value.pointer("/delta/text"))
        || non_empty_string(value.pointer("/content_block/text"))
    {
        return true;
    }

    value
        .get("choices")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|choices| {
            choices.iter().any(|choice| {
                non_empty_string(choice.get("text"))
                    || non_empty_string(choice.pointer("/delta/content"))
                    || non_empty_string(choice.pointer("/delta/reasoning_content"))
                    || non_empty_string(choice.pointer("/delta/text"))
            })
        })
}

fn extract_usage_from_value(value: &serde_json::Value) -> Option<ResponseUsage> {
    let usage = value
        .get("usage")
        .or_else(|| value.pointer("/message/usage"))?;
    let raw_input_tokens = usage
        .get("prompt_tokens")
        .or_else(|| usage.get("input_tokens"))
        .and_then(serde_json::Value::as_i64);
    let output_tokens = usage
        .get("completion_tokens")
        .or_else(|| usage.get("output_tokens"))
        .and_then(serde_json::Value::as_i64);
    let anthropic_cache_read = usage
        .get("cache_read_input_tokens")
        .and_then(serde_json::Value::as_i64);
    let anthropic_cache_creation = usage
        .get("cache_creation_input_tokens")
        .and_then(serde_json::Value::as_i64);
    let has_anthropic_cache_fields = usage.get("cache_read_input_tokens").is_some()
        || usage.get("cache_creation_input_tokens").is_some();
    let (input_tokens, input_cached_tokens, input_uncached_tokens, input_cache_write_tokens) =
        if has_anthropic_cache_fields {
            // 未缓存输入沿用旧口径（含缓存写入），保证既有展示与汇总不变；
            // 缓存写入另行单列，计价时再单独扣减并按缓存写入单价计费。
            let cache_write = anthropic_cache_creation;
            let uncached = match (raw_input_tokens, anthropic_cache_creation) {
                (Some(input), Some(created)) => Some(input.saturating_add(created)),
                (Some(input), None) => Some(input),
                (None, Some(created)) => Some(created),
                (None, None) => None,
            };
            let total = match (uncached, anthropic_cache_read) {
                (Some(uncached), Some(cached)) => Some(uncached.saturating_add(cached)),
                (Some(uncached), None) => Some(uncached),
                (None, Some(cached)) => Some(cached),
                (None, None) => None,
            };
            (total, anthropic_cache_read, uncached, cache_write)
        } else {
            let cached = usage
                .get("effectiveCachedTokens")
                .or_else(|| {
                    usage
                        .get("prompt_tokens_details")
                        .and_then(|details| details.get("cached_tokens"))
                })
                .or_else(|| usage.get("cache_read_tokens"))
                .or_else(|| usage.get("cached_tokens"))
                .and_then(serde_json::Value::as_i64);
            let uncached = match (raw_input_tokens, cached) {
                (Some(input), Some(cached)) => Some(input.saturating_sub(cached).max(0)),
                _ => None,
            };
            (raw_input_tokens, cached, uncached, None)
        };
    let total_tokens = usage
        .get("total_tokens")
        .and_then(serde_json::Value::as_i64)
        .or_else(|| match (input_tokens, output_tokens) {
            (Some(input), Some(output)) => Some(input.saturating_add(output)),
            _ => None,
        });

    if input_tokens.is_none() && output_tokens.is_none() && total_tokens.is_none() {
        return None;
    }

    Some(ResponseUsage {
        input_tokens,
        input_cached_tokens,
        input_uncached_tokens,
        input_cache_write_tokens,
        output_tokens,
        total_tokens,
    })
}

fn merge_usage(current: ResponseUsage, next: ResponseUsage) -> ResponseUsage {
    let input_tokens = next.input_tokens.or(current.input_tokens);
    let input_cached_tokens = next.input_cached_tokens.or(current.input_cached_tokens);
    let input_uncached_tokens = next.input_uncached_tokens.or(current.input_uncached_tokens);
    let input_cache_write_tokens = next
        .input_cache_write_tokens
        .or(current.input_cache_write_tokens);
    let output_tokens = next.output_tokens.or(current.output_tokens);
    let total_tokens = match (input_tokens, output_tokens) {
        (Some(input), Some(output)) => Some(input.saturating_add(output)),
        _ => next.total_tokens.or(current.total_tokens),
    };
    ResponseUsage {
        input_tokens,
        input_cached_tokens,
        input_uncached_tokens,
        input_cache_write_tokens,
        output_tokens,
        total_tokens,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_longcat_usage_from_completed_sse() {
        let body = br#"data: {"choices":[{"delta":{"content":"ok"}}],"lastOne":false}

data: {"choices":[],"usage":{"effectiveCachedTokens":110592,"completion_tokens":77,"prompt_tokens":110653,"total_tokens":110730,"prompt_tokens_details":{"cached_tokens":110592}},"lastOne":true}

data: [DONE]

"#;

        assert_eq!(
            extract_sse_response_usage(body),
            Some(ResponseUsage {
                input_tokens: Some(110653),
                input_cached_tokens: Some(110592),
                input_uncached_tokens: Some(61),
                input_cache_write_tokens: None,
                output_tokens: Some(77),
                total_tokens: Some(110730),
            })
        );
    }

    #[test]
    fn rejects_sse_usage_without_done_marker() {
        let body = br#"data: {"usage":{"prompt_tokens":8,"completion_tokens":3,"total_tokens":11}}

"#;
        assert_eq!(extract_sse_response_usage(body), None);
    }

    #[test]
    fn extracts_longcat_anthropic_usage_from_message_stop_stream() {
        let body = br#"event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":21087,"cache_read_input_tokens":7552,"cache_creation_input_tokens":0,"output_tokens":0}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hello"}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":52}}

event: message_stop
data: {"type":"message_stop"}

"#;

        assert_eq!(
            extract_sse_response_usage(body),
            Some(ResponseUsage {
                input_tokens: Some(28639),
                input_cached_tokens: Some(7552),
                input_uncached_tokens: Some(21087),
                input_cache_write_tokens: Some(0),
                output_tokens: Some(52),
                total_tokens: Some(28691),
            })
        );
    }

    #[test]
    fn captures_anthropic_cache_write_tokens() {
        let body = br#"event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":1000,"cache_read_input_tokens":500,"cache_creation_input_tokens":2000,"output_tokens":0}}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}

event: message_stop
data: {"type":"message_stop"}

"#;

        assert_eq!(
            extract_sse_response_usage(body),
            Some(ResponseUsage {
                // 未缓存沿用旧口径含缓存写入：净输入 1000 + 写入 2000 = 3000；总输入再 + 缓存读取 500 = 3500
                input_tokens: Some(3500),
                input_cached_tokens: Some(500),
                input_uncached_tokens: Some(3000),
                input_cache_write_tokens: Some(2000),
                output_tokens: Some(50),
                total_tokens: Some(3550),
            })
        );
    }

    #[test]
    fn detects_first_output_token_but_ignores_metadata_events() {
        let metadata = br#"data: {"choices":[{"delta":{"role":"assistant"}}]}

"#;
        let output = br#"data: {"choices":[{"delta":{"content":"hello"}}]}

"#;
        let anthropic = br#"event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}

"#;

        assert!(!contains_sse_output_token(metadata));
        assert!(contains_sse_output_token(output));
        assert!(contains_sse_output_token(anthropic));
    }
}
