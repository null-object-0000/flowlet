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
///
/// `require_done_marker`：为 `true` 时仅在见到终止标记（`[DONE]` 或 `message_stop`）
/// 才返回用量，用于可能被截断的捕获体；为 `false` 时只要解析到用量就返回，
/// 用于已正常结束的流——部分 Anthropic 兼容上游（如千问 Token Plan）的流
/// 不带 `message_stop`/`[DONE]` 终止标记，但用量事件本身是完整的。
pub fn extract_sse_response_usage(body: &[u8], require_done_marker: bool) -> Option<ResponseUsage> {
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

    if require_done_marker {
        saw_done.then_some(latest_usage).flatten()
    } else {
        latest_usage
    }
}

/// 解析“流式”响应的用量，兼容两类上游行为：
/// 1. 标准 SSE 流（含无 `message_stop`/`[DONE]` 终止标记但已结束的流）；
/// 2. 上游以 `text/event-stream` 返回、但实际是单条 JSON 消息（无 `data:` 前缀）
///    的非流式响应——此时回退按普通 JSON 消息解析。
pub fn extract_stream_usage(body: &[u8]) -> Option<ResponseUsage> {
    extract_sse_response_usage(body, false).or_else(|| extract_response_usage(body))
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
        || non_empty_string(value.pointer("/delta/thinking"))
        || non_empty_string(value.pointer("/content_block/text"))
        || non_empty_string(value.pointer("/content_block/thinking"))
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
            extract_sse_response_usage(body, true),
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
        assert_eq!(extract_sse_response_usage(body, true), None);
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
            extract_sse_response_usage(body, true),
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
            extract_sse_response_usage(body, true),
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
    fn extracts_usage_from_completed_stream_without_done_marker() {
        // 千问 Token Plan 等 Anthropic 兼容上游的流可能不带 message_stop/[DONE]
        // 终止标记；流正常结束后仍应从用量事件提取 Token 明细。
        let body = br#"event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":6,"cache_read_input_tokens":23746,"cache_creation_input_tokens":11351,"output_tokens":0}}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":249}}

"#;

        // 严格要求终止标记时无结果（用于可能被截断的捕获体）
        assert_eq!(extract_sse_response_usage(body, true), None);
        // 流已正常结束（不要求终止标记）时返回合并用量
        assert_eq!(
            extract_sse_response_usage(body, false),
            Some(ResponseUsage {
                // 净输入 6 + 写入 11351 = 11357；总输入再 + 缓存读取 23746 = 35103
                input_tokens: Some(35103),
                input_cached_tokens: Some(23746),
                input_uncached_tokens: Some(11357),
                input_cache_write_tokens: Some(11351),
                output_tokens: Some(249),
                total_tokens: Some(35352),
            })
        );
    }

    #[test]
    fn extracts_stream_usage_falls_back_to_plain_json_message() {
        // 上游以 text/event-stream 返回、但实际是单条 JSON 消息（无 data: 前缀）：
        // SSE 解析无结果，extract_stream_usage 回退按普通 JSON 消息解析。
        let body = br#"{"id":"msg_1","type":"message","role":"assistant","model":"qwen3.8-max-preview","stop_reason":"end_turn","usage":{"input_tokens":6,"output_tokens":249,"cache_creation_input_tokens":11351,"cache_read_input_tokens":23746}}"#;

        // 纯 SSE 解析对无 data: 前缀的正文无结果
        assert_eq!(extract_sse_response_usage(body, false), None);
        // extract_stream_usage 回退到 JSON 解析，得到完整用量
        assert_eq!(
            extract_stream_usage(body),
            Some(ResponseUsage {
                input_tokens: Some(35103),
                input_cached_tokens: Some(23746),
                input_uncached_tokens: Some(11357),
                input_cache_write_tokens: Some(11351),
                output_tokens: Some(249),
                total_tokens: Some(35352),
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
        let anthropic_thinking = br#"event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"I need to"}}

"#;

        assert!(!contains_sse_output_token(metadata));
        assert!(contains_sse_output_token(output));
        assert!(contains_sse_output_token(anthropic));
        assert!(contains_sse_output_token(anthropic_thinking));
    }
}
