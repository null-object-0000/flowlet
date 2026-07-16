#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseUsage {
    pub input_tokens: Option<i64>,
    pub input_cached_tokens: Option<i64>,
    pub input_uncached_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
}

pub fn extract_response_usage(body: &[u8]) -> Option<ResponseUsage> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    extract_usage_from_value(&value)
}

/// Parse a completed LongCat/OpenAI-compatible SSE response. The usage event is
/// accepted only when the stream contains the terminal `data: [DONE]` marker,
/// so interrupted streams cannot be recorded as complete usage.
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
        if let Some(usage) = extract_usage_from_value(&value) {
            latest_usage = Some(usage);
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
    let usage = value.get("usage")?;
    let input_tokens = usage
        .get("prompt_tokens")
        .or_else(|| usage.get("input_tokens"))
        .and_then(serde_json::Value::as_i64);
    let output_tokens = usage
        .get("completion_tokens")
        .or_else(|| usage.get("output_tokens"))
        .and_then(serde_json::Value::as_i64);
    let total_tokens = usage
        .get("total_tokens")
        .and_then(serde_json::Value::as_i64)
        .or_else(|| match (input_tokens, output_tokens) {
            (Some(input), Some(output)) => Some(input + output),
            _ => None,
        });
    let input_cached_tokens = usage
        .get("effectiveCachedTokens")
        .or_else(|| {
            usage
                .get("prompt_tokens_details")
                .and_then(|details| details.get("cached_tokens"))
        })
        .or_else(|| usage.get("cache_read_tokens"))
        .or_else(|| usage.get("cached_tokens"))
        .and_then(serde_json::Value::as_i64);
    let input_uncached_tokens = match (input_tokens, input_cached_tokens) {
        (Some(input), Some(cached)) => Some(input.saturating_sub(cached).max(0)),
        _ => None,
    };

    if input_tokens.is_none() && output_tokens.is_none() && total_tokens.is_none() {
        return None;
    }

    Some(ResponseUsage {
        input_tokens,
        input_cached_tokens,
        input_uncached_tokens,
        output_tokens,
        total_tokens,
    })
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
