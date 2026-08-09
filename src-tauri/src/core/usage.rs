#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseUsage {
    pub input_tokens: Option<i64>,
    pub input_cached_tokens: Option<i64>,
    pub input_uncached_tokens: Option<i64>,
    pub input_cache_write_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
}

const MAX_STREAM_USAGE_LINE_BYTES: usize = 8 * 1024 * 1024;

/// Incrementally extracts usage from an SSE byte stream without retaining the
/// whole response. Usage-bearing events are normally small even when the
/// generated content is very large, so memory is bounded by one SSE line
/// rather than by the total response size.
#[derive(Debug, Default)]
pub(crate) struct StreamUsageAccumulator {
    pending_line: Vec<u8>,
    discarding_oversized_line: bool,
    usage: Option<ResponseUsage>,
    saw_terminal_marker: bool,
    saw_positive_output_usage: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StreamUsageResult {
    pub usage: Option<ResponseUsage>,
    /// 截断或传输报错时仍可认定 usage 完整的上游证据：标准终止标记，或兼容
    /// 上游最后一个带正数 output_tokens 的 usage 事件。
    pub has_completion_evidence: bool,
}

impl StreamUsageAccumulator {
    pub(crate) fn push(&mut self, chunk: &[u8]) {
        let mut remaining = chunk;
        while let Some(newline) = remaining.iter().position(|byte| *byte == b'\n') {
            self.push_line_fragment(&remaining[..newline]);
            self.finish_line();
            remaining = &remaining[newline + 1..];
        }
        self.push_line_fragment(remaining);
    }

    pub(crate) fn finish_with_evidence(mut self) -> StreamUsageResult {
        if !self.pending_line.is_empty() || self.discarding_oversized_line {
            self.finish_line();
        }
        StreamUsageResult {
            usage: self.usage,
            has_completion_evidence: self.saw_terminal_marker || self.saw_positive_output_usage,
        }
    }

    fn push_line_fragment(&mut self, fragment: &[u8]) {
        if self.discarding_oversized_line {
            return;
        }
        if self.pending_line.len().saturating_add(fragment.len()) > MAX_STREAM_USAGE_LINE_BYTES {
            self.pending_line.clear();
            self.discarding_oversized_line = true;
            return;
        }
        self.pending_line.extend_from_slice(fragment);
    }

    fn finish_line(&mut self) {
        if self.discarding_oversized_line {
            self.discarding_oversized_line = false;
            self.pending_line.clear();
            return;
        }

        let Ok(line) = std::str::from_utf8(&self.pending_line) else {
            self.pending_line.clear();
            return;
        };
        let Some(data) = line.trim().strip_prefix("data:") else {
            self.pending_line.clear();
            return;
        };
        let data = data.trim();
        if data == "[DONE]" {
            self.saw_terminal_marker = true;
            self.pending_line.clear();
            return;
        }
        if data.is_empty() {
            self.pending_line.clear();
            return;
        }
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(data) {
            if value.get("type").and_then(serde_json::Value::as_str) == Some("message_stop") {
                self.saw_terminal_marker = true;
            }
            if data.contains("\"usage\"") {
                if let Some(usage) = extract_usage_from_value(&value) {
                    if usage.output_tokens.unwrap_or_default() > 0 {
                        self.saw_positive_output_usage = true;
                    }
                    self.usage = Some(match self.usage.take() {
                        Some(current) => merge_usage(current, usage),
                        None => usage,
                    });
                }
            }
        }
        self.pending_line.clear();
    }
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

/// Parse a stored stream capture without mistaking a truncated prefix for a
/// complete response. A terminal marker is the strongest signal. Some
/// compatible providers omit it, so a final positive output usage is also
/// accepted; a `message_start`-only prefix (input usage with zero output) is
/// deliberately rejected and may be recovered from the Agent transcript.
pub fn extract_captured_stream_usage(body: &[u8]) -> Option<ResponseUsage> {
    extract_sse_response_usage(body, true)
        .or_else(|| {
            extract_sse_response_usage(body, false)
                .filter(|usage| usage.output_tokens.unwrap_or_default() > 0)
        })
        .or_else(|| extract_response_usage(body))
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
    // OpenAI Responses API 的流式 `response.completed` 事件把完整响应对象嵌在
    // `response` 字段下（usage 位于 `/response/usage`）；非流式响应与
    // Chat Completions / Anthropic 一样在顶层或 `/message/usage`。
    let usage = value
        .get("usage")
        .or_else(|| value.pointer("/message/usage"))
        .or_else(|| value.pointer("/response/usage"))?;
    let raw_input_tokens = usage
        .get("prompt_tokens")
        .or_else(|| usage.get("input_tokens"))
        .and_then(serde_json::Value::as_i64);
    // Anthropic 形状的未缓存基值：必须 `input_tokens` 优先。某些 Anthropic 兼容上游
    // 会在同一 usage 里额外漏出 OpenAI 的 `prompt_tokens`（按 OpenAI 语义是「含缓存读」
    // 的全量）。若像 OpenAI 分支那样让 `prompt_tokens` 优先，再走下面的「+ cache_read」
    // 归一化，缓存读就会被重复计一次，使落库 input/total 虚高，并且和原样透传给客户端的
    // usage 对不上。故 Anthropic 分支以 `input_tokens` 为未缓存基值，仅在它缺失时才回退
    // `prompt_tokens`；`prompt_tokens` 的绝对优先权只留给下面的 OpenAI 分支。
    let anthropic_raw_input = usage
        .get("input_tokens")
        .or_else(|| usage.get("prompt_tokens"))
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
            let uncached = match (anthropic_raw_input, anthropic_cache_creation) {
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
                // OpenAI Responses API 用 input_tokens_details.cached_tokens
                // 报告缓存命中（DeepSeek/Qwen/LongCat 的 responses 端点同此形状）。
                .or_else(|| {
                    usage
                        .get("input_tokens_details")
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
    fn incrementally_extracts_usage_across_arbitrary_chunk_boundaries() {
        let body = br#"event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":113,"cache_read_input_tokens":116352,"cache_creation_input_tokens":0,"output_tokens":0}}}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}

event: message_delta
data: {"type":"message_delta","usage":{"output_tokens":9764}}

event: message_stop
data: {"type":"message_stop"}

"#;
        let mut accumulator = StreamUsageAccumulator::default();
        for chunk in body.chunks(7) {
            accumulator.push(chunk);
        }
        let result = accumulator.finish_with_evidence();
        assert!(result.has_completion_evidence);
        assert_eq!(
            result.usage,
            Some(ResponseUsage {
                input_tokens: Some(116465),
                input_cached_tokens: Some(116352),
                input_uncached_tokens: Some(113),
                input_cache_write_tokens: Some(0),
                output_tokens: Some(9764),
                total_tokens: Some(126229),
            })
        );
    }

    #[test]
    fn incremental_usage_marks_message_start_only_as_incomplete() {
        let body = br#"event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":6,"cache_read_input_tokens":23746,"cache_creation_input_tokens":11351,"output_tokens":0}}}

"#;
        let mut accumulator = StreamUsageAccumulator::default();
        accumulator.push(body);
        let result = accumulator.finish_with_evidence();
        assert!(!result.has_completion_evidence);
        assert_eq!(result.usage.unwrap().input_tokens, Some(35103));
    }

    #[test]
    fn incremental_usage_accepts_positive_output_without_terminal_marker() {
        let body = br#"event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":6,"cache_read_input_tokens":23746,"cache_creation_input_tokens":11351,"output_tokens":0}}}

event: message_delta
data: {"type":"message_delta","usage":{"output_tokens":249}}

"#;
        let mut accumulator = StreamUsageAccumulator::default();
        accumulator.push(body);
        let result = accumulator.finish_with_evidence();
        assert!(result.has_completion_evidence);
        assert_eq!(result.usage.unwrap().total_tokens, Some(35352));
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
    fn anthropic_shape_ignores_leaked_prompt_tokens_to_avoid_double_counting_cache() {
        // 某些 Anthropic 兼容上游在同一 usage 里漏出 OpenAI 的 prompt_tokens（= 净输入 + 缓存读，
        // 含缓存的全量）。落库的 input/total 绝不能因此把缓存读重复加一次，必须与透传给
        // 客户端的原始 usage 解释一致：净输入 1000 + 写入 2000 + 读取 500 = 3500。
        // （修复前 prompt_tokens 抢占基值，会得到 (1500+2000)+500 = 4000 的虚高值。）
        let body = br#"{"id":"msg_1","type":"message","usage":{"input_tokens":1000,"cache_read_input_tokens":500,"cache_creation_input_tokens":2000,"output_tokens":50,"prompt_tokens":1500}}"#;
        assert_eq!(
            extract_response_usage(body),
            Some(ResponseUsage {
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
    fn anthropic_stream_with_leaked_prompt_tokens_does_not_double_count_cache() {
        // 同上，流式路径：每个带用量的 SSE 事件都走同一归一化，同样不能因漏出的
        // prompt_tokens 重复计缓存。
        let body = br#"event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":1000,"cache_read_input_tokens":500,"cache_creation_input_tokens":2000,"output_tokens":0,"prompt_tokens":1500}}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}

event: message_stop
data: {"type":"message_stop"}

"#;
        assert_eq!(
            extract_sse_response_usage(body, true),
            Some(ResponseUsage {
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
    fn openai_shape_still_prefers_prompt_tokens() {
        // 回归保护：OpenAI 形状（无 Anthropic 缓存字段）仍须以 prompt_tokens 为全量基值，
        // 并减去 cached 得到未缓存，行为不变。
        let body = br#"{"usage":{"prompt_tokens":180,"completion_tokens":50,"total_tokens":230,"prompt_tokens_details":{"cached_tokens":80}}}"#;
        assert_eq!(
            extract_response_usage(body),
            Some(ResponseUsage {
                input_tokens: Some(180),
                input_cached_tokens: Some(80),
                input_uncached_tokens: Some(100),
                input_cache_write_tokens: None,
                output_tokens: Some(50),
                total_tokens: Some(230),
            })
        );
    }

    #[test]
    fn extracts_responses_streaming_usage_from_response_completed() {
        // OpenAI Responses API 的 SSE 流：usage 嵌在 `response.completed`
        // 事件的 `response` 对象下，且流不以 [DONE] 终止。
        let body = br#"event: response.created
data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"hello"}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"deepseek-v4-flash","usage":{"input_tokens":1000,"input_tokens_details":{"cached_tokens":400},"output_tokens":200,"output_tokens_details":{"reasoning_tokens":50},"total_tokens":1200}}}

"#;

        let expected = Some(ResponseUsage {
            input_tokens: Some(1000),
            input_cached_tokens: Some(400),
            input_uncached_tokens: Some(600),
            input_cache_write_tokens: None,
            output_tokens: Some(200),
            total_tokens: Some(1200),
        });
        // 实时流路径不要求终止标记
        assert_eq!(extract_sse_response_usage(body, false), expected);
        assert_eq!(extract_stream_usage(body), expected);
        // 捕获体可能被截断时的严格模式：无 [DONE]/message_stop 标记则不采信
        assert_eq!(extract_sse_response_usage(body, true), None);
    }

    #[test]
    fn extracts_responses_non_streaming_top_level_usage() {
        // 非流式 Responses 响应：usage 位于顶层，缓存命中在
        // input_tokens_details.cached_tokens。
        let body = br#"{"id":"resp_1","object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}],"usage":{"input_tokens":500,"input_tokens_details":{"cached_tokens":100},"output_tokens":80,"total_tokens":580}}"#;
        assert_eq!(
            extract_response_usage(body),
            Some(ResponseUsage {
                input_tokens: Some(500),
                input_cached_tokens: Some(100),
                input_uncached_tokens: Some(400),
                input_cache_write_tokens: None,
                output_tokens: Some(80),
                total_tokens: Some(580),
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
        assert!(extract_captured_stream_usage(body).is_some());
    }

    #[test]
    fn rejects_truncated_capture_with_only_message_start_usage() {
        let body = br#"event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":113,"cache_read_input_tokens":116352,"cache_creation_input_tokens":0,"output_tokens":0}}}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}

"#;

        assert!(extract_stream_usage(body).is_some());
        assert_eq!(extract_captured_stream_usage(body), None);
    }

    #[test]
    fn extracts_stream_usage_falls_back_to_plain_json_message() {
        // 上游以 text/event-stream 返回、但实际是单条 JSON 消息（无 data: 前缀）：
        // SSE 解析无结果，extract_stream_usage 回退按普通 JSON 消息解析。
        let body = br#"{"id":"msg_1","type":"message","role":"assistant","model":"qwen3.8-max","stop_reason":"end_turn","usage":{"input_tokens":6,"output_tokens":249,"cache_creation_input_tokens":11351,"cache_read_input_tokens":23746}}"#;

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
