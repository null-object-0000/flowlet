//! Narrow compatibility for gateways omitting initial content-block fields.
//! Applied after capture so logs always retain the actual upstream response.
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use serde_json::Value;

const MAX_LINE_BYTES: usize = 64 * 1024;

#[derive(Default)]
struct ContentBlockStartCompat {
    line: Vec<u8>,
    oversized: bool,
}

impl ContentBlockStartCompat {
    fn push(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut output = Vec::new();
        for &byte in bytes {
            if byte == b'\r' || byte == b'\n' {
                if !self.oversized {
                    output.extend_from_slice(&normalize_line(&self.line));
                }
                self.line.clear();
                self.oversized = false;
                output.push(byte);
            } else if self.oversized {
                output.push(byte);
            } else if self.line.len() == MAX_LINE_BYTES {
                // Pass oversized lines through without accumulating unbounded data.
                output.append(&mut self.line);
                output.push(byte);
                self.oversized = true;
            } else {
                self.line.push(byte);
            }
        }
        output
    }
}

fn normalize_line(line: &[u8]) -> Vec<u8> {
    let Some(data) = line.strip_prefix(b"data:") else {
        return line.to_vec();
    };
    let Ok(mut event) = serde_json::from_slice::<Value>(data) else {
        return line.to_vec();
    };
    if event.get("type").and_then(Value::as_str) != Some("content_block_start") {
        return line.to_vec();
    }
    let Some(block) = event
        .get_mut("content_block")
        .and_then(Value::as_object_mut)
    else {
        return line.to_vec();
    };
    let (field, value) = match block.get("type").and_then(Value::as_str) {
        Some("thinking") if !block.contains_key("thinking") => {
            ("thinking", Value::String(String::new()))
        }
        Some("tool_use") if !block.contains_key("input") => {
            ("input", Value::Object(serde_json::Map::new()))
        }
        _ => return line.to_vec(),
    };
    block.insert(field.to_string(), value);
    let mut output = b"data: ".to_vec();
    output.extend_from_slice(&serde_json::to_vec(&event).expect("JSON value serialization"));
    output
}

pub(super) fn normalize_content_block_starts(
    inner: impl Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static,
    enabled: bool,
) -> impl Stream<Item = Result<Bytes, std::io::Error>> {
    futures_util::stream::unfold(
        (
            Box::pin(inner),
            ContentBlockStartCompat::default(),
            None,
            false,
        ),
        move |(mut inner, mut compat, pending_error, ended)| async move {
            if let Some(error) = pending_error {
                return Some((Err(error), (inner, compat, None, true)));
            }
            if ended {
                return None;
            }
            loop {
                match inner.next().await {
                    Some(Ok(bytes)) => {
                        if !enabled {
                            return Some((Ok(bytes), (inner, compat, None, false)));
                        }
                        let output = compat.push(&bytes);
                        if !output.is_empty() {
                            return Some((Ok(Bytes::from(output)), (inner, compat, None, false)));
                        }
                    }
                    terminal => {
                        let error = terminal.and_then(Result::err);
                        // Never repair incomplete lines, including transport-error tails.
                        let tail = std::mem::take(&mut compat.line);
                        if !tail.is_empty() {
                            return Some((Ok(Bytes::from(tail)), (inner, compat, error, true)));
                        }
                        return error.map(|err| (Err(err), (inner, compat, None, true)));
                    }
                }
            }
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const BROKEN: &[u8] = b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\"}}\n\n";

    #[test]
    fn repairs_missing_thinking_at_every_chunk_boundary() {
        for ending in ["\n", "\r\n", "\r"] {
            let input = String::from_utf8(BROKEN.to_vec())
                .unwrap()
                .replace('\n', ending);
            for split in 0..=input.len() {
                let mut compat = ContentBlockStartCompat::default();
                let mut output = compat.push(&input.as_bytes()[..split]);
                output.extend(compat.push(&input.as_bytes()[split..]));
                assert!(compat.line.is_empty());
                let text = String::from_utf8(output).unwrap();
                let data = text
                    .split(['\r', '\n'])
                    .find_map(|line| line.strip_prefix("data:"))
                    .unwrap();
                let event: Value = serde_json::from_str(data).unwrap();
                assert_eq!(event["content_block"]["thinking"], "");
                assert_eq!(event["index"], 0);
                assert!(!event["content_block"]
                    .as_object()
                    .unwrap()
                    .contains_key("signature"));
                assert!(text.starts_with(&format!("event: content_block_start{ending}")));
                assert!(text.ends_with(&format!("{ending}{ending}")));
            }
        }
    }

    #[test]
    fn preserves_other_events_existing_values_and_invalid_json_byte_for_byte() {
        for line in [
            ": heartbeat",
            "data: [DONE]",
            "data: {invalid}",
            r#"data: {"type":"content_block_start","content_block":{"type":"thinking","thinking":"已有思考","signature":"sig"}}"#,
            r#"data: {"type":"content_block_start","content_block":{"type":"thinking","thinking":null}}"#,
            r#"data: {"type":"content_block_start","content_block":{"type":"text","text":""}}"#,
            r#"data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"你好"}}"#,
            r#"data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"t","name":"read","input":{}}}"#,
            r#"data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"t","name":"read","input":{"path":"existing.txt"}}}"#,
            r#"data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"t","name":"read","input":null}}"#,
            r#"data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\"command\":\"pwd\"}"}}"#,
            r#"data: {"type":"message_delta","usage":{"output_tokens":5}}"#,
            r#"data: {"type":"error","error":{"message":"failure"}}"#,
        ] {
            let input = format!("{line}\r\n\r\n");
            let mut compat = ContentBlockStartCompat::default();
            let mut output = Vec::new();
            for byte in input.as_bytes() {
                output.extend(compat.push(&[*byte]));
            }
            assert_eq!(output, input.as_bytes());
        }
    }

    #[test]
    fn repairs_real_missing_tool_input_at_every_chunk_boundary() {
        // Actual tool-use start from session-a7802f53, with no tool arguments captured.
        let raw = include_bytes!("../../tests/fixtures/dsh/missing-tool-input-start.sse");
        for ending in ["\n", "\r\n", "\r"] {
            let input = std::str::from_utf8(raw).unwrap().replace('\n', ending);
            for split in 0..=input.len() {
                let mut compat = ContentBlockStartCompat::default();
                let mut output = compat.push(&input.as_bytes()[..split]);
                output.extend(compat.push(&input.as_bytes()[split..]));
                let text = String::from_utf8(output).unwrap();
                let data = text
                    .split(['\r', '\n'])
                    .find_map(|line| line.strip_prefix("data:"))
                    .unwrap();
                let repaired: Value = serde_json::from_str(data).unwrap();
                let original_data = std::str::from_utf8(raw)
                    .unwrap()
                    .lines()
                    .find_map(|line| line.strip_prefix("data:"))
                    .unwrap();
                let mut expected: Value = serde_json::from_str(original_data).unwrap();
                expected["content_block"]["input"] = serde_json::json!({});
                assert_eq!(repaired, expected);
                assert!(text.ends_with(&format!("{ending}{ending}")));
            }
        }
    }

    #[tokio::test]
    async fn repaired_tool_start_preserves_argument_deltas_through_completion() {
        let raw = include_bytes!("../../tests/fixtures/dsh/missing-tool-input-start.sse");
        // Synthetic completion: parameter text belongs to deltas, never the start placeholder.
        let tail = concat!(
            "data: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"command\\\":\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"pwd\\\"}\"}}\n\n",
            "data: {\"type\":\"content_block_stop\",\"index\":2}\n\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":12}}\n\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        );
        let input = [raw.as_slice(), tail.as_bytes()].concat();
        let chunks: Vec<_> = input
            .chunks(7)
            .map(|part| Ok(Bytes::copy_from_slice(part)))
            .collect();
        let stream = normalize_content_block_starts(futures_util::stream::iter(chunks), true);
        futures_util::pin_mut!(stream);
        let mut output = Vec::new();
        while let Some(chunk) = stream.next().await {
            output.extend_from_slice(&chunk.unwrap());
        }
        assert!(output.ends_with(tail.as_bytes()));
        let mut arguments = String::new();
        for line in std::str::from_utf8(&output).unwrap().lines() {
            if let Some(data) = line.strip_prefix("data:") {
                let event: Value = serde_json::from_str(data).unwrap();
                if let Some(delta) = event["delta"]["partial_json"].as_str() {
                    arguments.push_str(delta);
                }
            }
        }
        assert_eq!(
            serde_json::from_str::<Value>(&arguments).unwrap(),
            serde_json::json!({"command":"pwd"})
        );
    }

    #[test]
    fn oversized_line_passes_through_and_next_event_is_repaired() {
        let mut compat = ContentBlockStartCompat::default();
        let mut input = b"data: ".to_vec();
        input.extend(vec![b'x'; MAX_LINE_BYTES * 2]);
        input.extend_from_slice(b"\n\n");
        let mut output = Vec::new();
        for chunk in input.chunks(13) {
            output.extend(compat.push(chunk));
            assert!(compat.line.len() <= MAX_LINE_BYTES);
        }
        assert_eq!(output, input);
        assert!(String::from_utf8(compat.push(BROKEN))
            .unwrap()
            .contains("\"thinking\":\"\""));
    }

    #[tokio::test]
    async fn bypass_and_incomplete_tails_are_unchanged_and_errors_propagate() {
        for enabled in [false, true] {
            let tail = b"data: {\"type\":\"content_block_start\"";
            let source = futures_util::stream::iter([
                Ok(Bytes::from_static(tail)),
                Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "idle timeout",
                )),
            ]);
            let stream = normalize_content_block_starts(source, enabled);
            futures_util::pin_mut!(stream);
            assert_eq!(stream.next().await.unwrap().unwrap(), tail.as_slice());
            assert_eq!(
                stream.next().await.unwrap().unwrap_err().kind(),
                std::io::ErrorKind::TimedOut
            );
            assert!(stream.next().await.is_none());
        }
        let source = futures_util::stream::iter([Ok(Bytes::from_static(BROKEN))]);
        let stream = normalize_content_block_starts(source, false);
        futures_util::pin_mut!(stream);
        assert_eq!(stream.next().await.unwrap().unwrap(), BROKEN);
        assert!(stream.next().await.is_none());
    }
}
