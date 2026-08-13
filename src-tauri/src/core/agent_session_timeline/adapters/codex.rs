use super::super::*;

pub(in crate::core::agent_session_timeline) fn read_timeline(
    agent_type: &str,
    session_id: &str,
) -> Result<AgentSessionTimeline, String> {
    let root = crate::core::codex_account::codex_home().join("sessions");
    let Some(path) = find_codex_session_file(&root, agent_type, session_id) else {
        return Ok(empty_timeline());
    };
    read_jsonl_timeline(&path, parse_line)
}

pub(in crate::core::agent_session_timeline) fn session_file(
    agent_type: &str,
    session_id: &str,
) -> Option<PathBuf> {
    find_codex_session_file(
        &crate::core::codex_account::codex_home().join("sessions"),
        agent_type,
        session_id,
    )
}

pub(in crate::core::agent_session_timeline) fn read_last_interaction(
    agent_type: &str,
    session_id: &str,
) -> Result<Option<AgentSessionTimeline>, String> {
    let Some(path) = session_file(agent_type, session_id) else {
        return Ok(None);
    };
    read_jsonl_last_interaction(&path, parse_line).map(Some)
}

pub(in crate::core::agent_session_timeline) fn parse_line(
    value: &Value,
    index: usize,
    timeline: &mut AgentSessionTimeline,
    _seen_usage_ids: &mut HashSet<String>,
) {
    let top_type = value.get("type").and_then(Value::as_str);
    let payload = value.get("payload").unwrap_or(&Value::Null);
    if top_type == Some("turn_context") {
        if let Some(model) = string_field(payload, "model") {
            remember_model(timeline, &model);
            if let Some(event) =
                timeline.events.iter_mut().rev().find(|event| {
                    event.kind == "turn" && event.status.as_deref() == Some("running")
                })
            {
                event.model = Some(model);
            }
        }
        return;
    }
    if top_type == Some("event_msg") {
        match payload.get("type").and_then(Value::as_str) {
            Some("task_started") => {
                timeline.turn_count += 1;
                let turn_id =
                    string_field(payload, "turn_id").unwrap_or_else(|| format!("turn-{index}"));
                push_event(
                    timeline,
                    turn_id,
                    "turn",
                    string_field(value, "timestamp"),
                    Some("Agent 轮次".to_string()),
                    None,
                    None,
                    Some("running".to_string()),
                );
            }
            Some("task_complete") => {
                let turn_id = string_field(payload, "turn_id");
                if let Some(event) = timeline.events.iter_mut().rev().find(|event| {
                    event.kind == "turn"
                        && (turn_id.is_none() || turn_id.as_deref() == Some(event.id.as_str()))
                }) {
                    event.status = Some("completed".to_string());
                    event.duration_ms = optional_integer_field(payload, "duration_ms");
                    event.time_to_first_token_ms =
                        optional_integer_field(payload, "time_to_first_token_ms");
                }
            }
            Some("task_aborted" | "turn_aborted") => {
                if let Some(event) = timeline.events.iter_mut().rev().find(|event| {
                    event.kind == "turn" && event.status.as_deref() == Some("running")
                }) {
                    event.status = Some("cancelled".to_string());
                }
            }
            Some("token_count") => attach_token_count(payload, timeline),
            _ => {}
        }
        return;
    }
    if top_type != Some("response_item") {
        return;
    }

    let timestamp = string_field(value, "timestamp");
    let base_id = string_field(payload, "id").unwrap_or_else(|| format!("line-{index}"));
    match payload.get("type").and_then(Value::as_str) {
        Some("message") => {
            let role = payload
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !matches!(role, "user" | "assistant") {
                return;
            }
            if let Some(content) = payload.get("content").and_then(Value::as_array) {
                for (content_index, item) in content.iter().enumerate() {
                    if matches!(
                        item.get("type").and_then(Value::as_str),
                        Some("input_text" | "output_text")
                    ) {
                        push_event(
                            timeline,
                            format!("{base_id}:{content_index}"),
                            role_kind(role),
                            timestamp.clone(),
                            None,
                            string_field(item, "text"),
                            None,
                            None,
                        );
                    }
                }
            }
        }
        Some("function_call" | "custom_tool_call") => {
            let call_id = string_field(payload, "call_id").unwrap_or(base_id);
            push_event(
                timeline,
                call_id,
                "tool-call",
                timestamp,
                string_field(payload, "name"),
                payload
                    .get("arguments")
                    .or_else(|| payload.get("input"))
                    .and_then(render_json_value),
                None,
                string_field(payload, "status"),
            );
        }
        Some("function_call_output" | "custom_tool_call_output") => {
            let call_id = string_field(payload, "call_id").unwrap_or(base_id);
            let title = timeline
                .events
                .iter()
                .rev()
                .find(|event| event.kind == "tool-call" && event.id == call_id)
                .and_then(|event| event.title.clone())
                .unwrap_or_else(|| "Tool result".to_string());
            push_event(
                timeline,
                format!("{call_id}:result"),
                "tool-result",
                timestamp,
                Some(title),
                payload.get("output").and_then(render_json_value),
                None,
                string_field(payload, "status"),
            );
        }
        Some("reasoning") => push_event(
            timeline,
            base_id,
            "reasoning",
            timestamp,
            Some("思考摘要".to_string()),
            payload.get("summary").and_then(render_json_value),
            None,
            None,
        ),
        _ => {}
    }
}

fn attach_token_count(payload: &Value, timeline: &mut AgentSessionTimeline) {
    if let Some(info) = payload.get("info") {
        let last_usage = info
            .get("last_token_usage")
            .and_then(usage_from_codex_token_value);
        if let Some(usage) = last_usage {
            if let Some(event) =
                timeline.events.iter_mut().rev().find(|event| {
                    event.kind == "turn" && event.status.as_deref() == Some("running")
                })
            {
                add_usage(&mut event.usage, &usage);
            }
        }
        if let Some(total_usage) = info
            .get("total_token_usage")
            .and_then(usage_from_codex_token_value)
        {
            timeline.usage = Some(total_usage);
        }
    }
}
