use super::super::*;

pub(in crate::core::agent_session_timeline) fn read_timeline(
    session_id: &str,
) -> Result<AgentSessionTimeline, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(empty_timeline());
    };
    let root = home.join(".claude").join("projects");
    let Some(path) = find_jsonl_by_stem(&root, session_id) else {
        return Ok(empty_timeline());
    };
    read_jsonl_timeline(&path, parse_line)
}

pub(in crate::core::agent_session_timeline) fn session_file(session_id: &str) -> Option<PathBuf> {
    dirs::home_dir()
        .and_then(|home| find_jsonl_by_stem(&home.join(".claude").join("projects"), session_id))
}

pub(in crate::core::agent_session_timeline) fn read_last_interaction(
    session_id: &str,
) -> Result<Option<AgentSessionTimeline>, String> {
    let Some(path) = session_file(session_id) else {
        return Ok(None);
    };
    read_jsonl_last_interaction(&path, parse_line).map(Some)
}

pub(in crate::core::agent_session_timeline) fn parse_line(
    value: &Value,
    index: usize,
    timeline: &mut AgentSessionTimeline,
    seen_usage_ids: &mut HashSet<String>,
) {
    let outer_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(outer_type, "user" | "assistant")
        || value
            .get("isMeta")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return;
    }
    let Some(message) = value.get("message") else {
        return;
    };
    let timestamp = string_field(value, "timestamp");
    let base_id = string_field(value, "uuid").unwrap_or_else(|| format!("line-{index}"));
    let model = string_field(message, "model");
    if let Some(model) = model.as_deref() {
        remember_model(timeline, model);
    }
    let event_start = timeline.events.len();
    match message.get("content") {
        Some(Value::String(content)) => push_event(
            timeline,
            base_id.clone(),
            role_kind(outer_type),
            timestamp,
            None,
            Some(content.clone()),
            model,
            None,
        ),
        Some(Value::Array(content)) => {
            for (content_index, item) in content.iter().enumerate() {
                let event_id = format!("{base_id}:{content_index}");
                match item.get("type").and_then(Value::as_str) {
                    Some("text") => push_event(
                        timeline,
                        event_id,
                        role_kind(outer_type),
                        timestamp.clone(),
                        None,
                        string_field(item, "text"),
                        model.clone(),
                        None,
                    ),
                    Some("thinking") => push_event(
                        timeline,
                        event_id,
                        "reasoning",
                        timestamp.clone(),
                        Some("思考摘要".to_string()),
                        string_field(item, "thinking"),
                        model.clone(),
                        None,
                    ),
                    Some("tool_use") => push_event(
                        timeline,
                        event_id,
                        "tool-call",
                        timestamp.clone(),
                        string_field(item, "name"),
                        item.get("input").and_then(render_json_value),
                        model.clone(),
                        None,
                    ),
                    Some("tool_result") => {
                        let is_error = item
                            .get("is_error")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        push_event(
                            timeline,
                            event_id,
                            if is_error { "error" } else { "tool-result" },
                            timestamp.clone(),
                            Some("Tool result".to_string()),
                            item.get("content").and_then(render_json_value),
                            model.clone(),
                            None,
                        );
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    if outer_type == "assistant" {
        let usage_id = string_field(message, "id").unwrap_or(base_id);
        if seen_usage_ids.insert(usage_id) {
            timeline.turn_count += 1;
            let usage = usage_from_claude_message(message);
            attach_usage_to_first_event(timeline, event_start, usage.clone());
            if let Some(usage) = usage {
                add_usage_to_summary(timeline, &usage);
            }
        }
    }
}
