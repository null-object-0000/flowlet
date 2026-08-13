use super::super::*;

type UsageEvent = super::super::super::config::AgentUsageEvent;

pub(in crate::core::agent_session_timeline) fn read_timeline(
    session_id: &str,
) -> Result<AgentSessionTimeline, String> {
    read_timeline_impl(session_id, None)
}

pub(in crate::core::agent_session_timeline) fn read_timeline_with_events(
    session_id: &str,
    usage_events: &mut Vec<UsageEvent>,
) -> Result<AgentSessionTimeline, String> {
    read_timeline_impl(session_id, Some(usage_events))
}

pub(in crate::core::agent_session_timeline) fn read_last_interaction(
    session_id: &str,
) -> Result<Option<AgentSessionTimeline>, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(None);
    };
    let root = home.join(".pi").join("agent").join("sessions");
    let Some(path) = find_session_file(&root, session_id) else {
        return Ok(None);
    };
    read_timeline_from_mode(&path, None, true, None).map(Some)
}

fn read_timeline_impl(
    session_id: &str,
    usage_sink: Option<&mut Vec<UsageEvent>>,
) -> Result<AgentSessionTimeline, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(empty_timeline());
    };
    let root = home.join(".pi").join("agent").join("sessions");
    let Some(path) = find_session_file(&root, session_id) else {
        return Ok(empty_timeline());
    };
    read_timeline_from(&path, usage_sink)
}

fn find_session_file(root: &Path, session_id: &str) -> Option<PathBuf> {
    let mut paths = Vec::new();
    collect_jsonl_files(root, &mut paths);
    paths.into_iter().find(|path| {
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .is_some_and(|stem| stem.ends_with(&format!("_{session_id}")))
    })
}

pub(in crate::core::agent_session_timeline) fn read_timeline_from(
    path: &Path,
    usage_sink: Option<&mut Vec<UsageEvent>>,
) -> Result<AgentSessionTimeline, String> {
    read_timeline_from_mode(path, None, false, usage_sink)
}

fn read_timeline_from_mode(
    path: &Path,
    max_bytes: Option<usize>,
    latest_interaction_only: bool,
    mut usage_sink: Option<&mut Vec<UsageEvent>>,
) -> Result<AgentSessionTimeline, String> {
    let file = File::open(path).map_err(|error| format!("无法读取 Pi 会话文件：{error}"))?;
    let mut entries: Vec<(usize, Value)> = Vec::new();
    let mut bytes_read = 0usize;
    for (index, line) in BufReader::new(file).lines().enumerate() {
        let line = line.map_err(|error| format!("读取 Pi 会话文件失败：{error}"))?;
        bytes_read = bytes_read.saturating_add(line.len());
        if max_bytes.is_some_and(|limit| bytes_read > limit) {
            break;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("session") {
            continue;
        }
        entries.push((index, value));
    }

    let by_id: HashMap<String, (usize, Value)> = entries
        .iter()
        .filter_map(|(index, value)| {
            value
                .get("id")
                .and_then(Value::as_str)
                .map(|id| (id.to_string(), (*index, value.clone())))
        })
        .collect();
    let parented: HashSet<String> = entries
        .iter()
        .filter_map(|(_, value)| value.get("parentId").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    let mut leaf: Option<(usize, Value)> = None;
    for (index, value) in &entries {
        let Some(id) = value.get("id").and_then(Value::as_str) else {
            continue;
        };
        if parented.contains(id) {
            continue;
        }
        let candidate = (*index, value.clone());
        leaf = match leaf {
            Some((_, ref leaf_value)) => {
                if string_field(value, "timestamp") > string_field(leaf_value, "timestamp") {
                    Some(candidate)
                } else {
                    leaf
                }
            }
            None => Some(candidate),
        };
    }

    let mut branch_indices = Vec::new();
    let mut visited = HashSet::new();
    let mut current_id = leaf
        .as_ref()
        .and_then(|(_, value)| value.get("id").and_then(Value::as_str).map(str::to_string));
    while let Some(id) = current_id {
        if !visited.insert(id.clone()) {
            break;
        }
        if let Some(entry_index) = entries
            .iter()
            .position(|(_, value)| value.get("id").and_then(Value::as_str) == Some(id.as_str()))
        {
            branch_indices.push(entry_index);
        }
        current_id = entries
            .iter()
            .find(|(_, value)| value.get("id").and_then(Value::as_str) == Some(id.as_str()))
            .and_then(|(_, value)| value.get("parentId").and_then(Value::as_str))
            .filter(|parent_id| !parent_id.is_empty())
            .and_then(|parent_id| by_id.contains_key(parent_id).then(|| parent_id.to_string()));
    }
    branch_indices.reverse();

    let mut timeline = complete_timeline();
    timeline.source_available = true;
    let mut seen_usage_ids = HashSet::new();
    for entry_index in branch_indices {
        let (_, value) = &entries[entry_index];
        let event_start = timeline.events.len();
        parse_entry(
            value,
            &mut timeline,
            &mut seen_usage_ids,
            usage_sink.as_deref_mut(),
        );
        if latest_interaction_only
            && timeline.events[event_start..]
                .iter()
                .any(|event| event.kind == "user-message")
        {
            timeline.events = timeline.events.split_off(event_start);
        }
    }
    Ok(timeline)
}

fn parse_entry(
    value: &Value,
    timeline: &mut AgentSessionTimeline,
    seen_usage_ids: &mut HashSet<String>,
    usage_sink: Option<&mut Vec<UsageEvent>>,
) {
    let timestamp = string_field(value, "timestamp");
    let id = string_field(value, "id").unwrap_or_default();
    match value.get("type").and_then(Value::as_str) {
        Some("message") => {
            let Some(message) = value.get("message") else {
                return;
            };
            let role = message
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let model = string_field(message, "model");
            if let Some(model) = model.as_deref() {
                remember_model(timeline, model);
            }
            match role {
                "user" => push_event(
                    timeline,
                    id,
                    "user-message",
                    timestamp,
                    None,
                    message_text(message),
                    model,
                    None,
                ),
                "assistant" => {
                    let blocks = message
                        .get("content")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    let event_start = timeline.events.len();
                    if blocks.is_empty() {
                        push_event(
                            timeline,
                            id.clone(),
                            "assistant-message",
                            timestamp.clone(),
                            None,
                            None,
                            model.clone(),
                            None,
                        );
                    }
                    for (block_index, block) in blocks.iter().enumerate() {
                        let block_id = format!("{id}:{block_index}");
                        match block.get("type").and_then(Value::as_str) {
                            Some("text") => push_event(
                                timeline,
                                block_id,
                                "assistant-message",
                                timestamp.clone(),
                                None,
                                string_field(block, "text"),
                                model.clone(),
                                None,
                            ),
                            Some("thinking") => push_event(
                                timeline,
                                block_id,
                                "reasoning",
                                timestamp.clone(),
                                Some("思考摘要".to_string()),
                                string_field(block, "thinking"),
                                model.clone(),
                                None,
                            ),
                            Some("toolCall") => push_event(
                                timeline,
                                block_id,
                                "tool-call",
                                timestamp.clone(),
                                string_field(block, "name"),
                                block.get("arguments").and_then(render_json_value),
                                model.clone(),
                                None,
                            ),
                            _ => {}
                        }
                    }
                    if seen_usage_ids.insert(id.clone()) {
                        timeline.turn_count += 1;
                        if let Some(usage) = usage_from_message(message) {
                            if let Some(sink) = usage_sink {
                                if let Some(event) = agent_usage_event(
                                    id.clone(),
                                    timestamp.clone(),
                                    model.clone(),
                                    &usage,
                                ) {
                                    sink.push(event);
                                }
                            }
                            attach_usage_to_first_event(timeline, event_start, Some(usage.clone()));
                            add_usage_to_summary(timeline, &usage);
                        }
                    }
                }
                "toolResult" => {
                    let is_error = message
                        .get("isError")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    push_event(
                        timeline,
                        id,
                        if is_error { "error" } else { "tool-result" },
                        timestamp,
                        string_field(message, "toolName"),
                        message_text(message),
                        model,
                        None,
                    );
                }
                "bashExecution" => {
                    let exit_code = message.get("exitCode").and_then(Value::as_i64);
                    let status = match exit_code {
                        Some(0) => Some("completed".to_string()),
                        Some(_) => Some("error".to_string()),
                        None => None,
                    };
                    push_event(
                        timeline,
                        id,
                        "tool-result",
                        timestamp,
                        string_field(message, "command"),
                        string_field(message, "output"),
                        model,
                        status,
                    );
                }
                "compactionSummary" | "branchSummary" | "custom" => {}
                _ => {}
            }
        }
        Some("model_change") => {
            if let Some(model) = value.get("modelId").and_then(Value::as_str) {
                remember_model(timeline, model);
            }
        }
        _ => {}
    }
}

fn message_text(message: &Value) -> Option<String> {
    match message.get("content")? {
        Value::String(text) => {
            let text = text.trim();
            (!text.is_empty()).then(|| text.to_string())
        }
        Value::Array(blocks) => {
            let text = blocks
                .iter()
                .filter_map(|block| {
                    (block.get("type").and_then(Value::as_str) == Some("text"))
                        .then(|| block.get("text").and_then(Value::as_str))
                        .flatten()
                })
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_string();
            (!text.is_empty()).then_some(text)
        }
        _ => None,
    }
}

fn usage_from_message(message: &Value) -> Option<AgentSessionNativeUsage> {
    let usage = message.get("usage")?;
    let cost = usage.get("cost");
    Some(AgentSessionNativeUsage {
        input_tokens: integer_field(usage, "input"),
        cached_input_tokens: integer_field(usage, "cacheRead"),
        cache_write_input_tokens: integer_field(usage, "cacheWrite"),
        output_tokens: integer_field(usage, "output"),
        reasoning_tokens: integer_field(usage, "reasoning"),
        total_tokens: integer_field(usage, "totalTokens"),
        cost: cost.and_then(|cost| cost.get("total").and_then(optional_number_field)),
        cost_currency: None,
        api_equivalent: None,
    })
}
