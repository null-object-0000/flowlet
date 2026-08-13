use super::super::*;

pub(in crate::core::agent_session_timeline) fn read_timeline(
    session_id: &str,
) -> Result<AgentSessionTimeline, String> {
    read_timeline_impl(session_id, None)
}

pub(in crate::core::agent_session_timeline) fn read_timeline_with_events(
    session_id: &str,
    usage_events: &mut Vec<super::super::super::config::AgentUsageEvent>,
) -> Result<AgentSessionTimeline, String> {
    read_timeline_impl(session_id, Some(usage_events))
}

fn read_timeline_impl(
    session_id: &str,
    usage_sink: Option<&mut Vec<super::super::super::config::AgentUsageEvent>>,
) -> Result<AgentSessionTimeline, String> {
    for database_path in opencode_database_candidates() {
        if !database_path.is_file() {
            continue;
        }
        let connection = match Connection::open_with_flags(
            &database_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) {
            Ok(connection) => connection,
            Err(_) => continue,
        };
        let _ = connection.busy_timeout(std::time::Duration::from_millis(750));
        let exists = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM session WHERE id = ?1)",
                params![session_id],
                |row| row.get::<_, bool>(0),
            )
            .unwrap_or(false);
        if !exists {
            continue;
        }
        return read_timeline_from(&connection, session_id, usage_sink);
    }
    Ok(empty_timeline())
}

pub(in crate::core::agent_session_timeline) fn read_timeline_from(
    connection: &Connection,
    session_id: &str,
    usage_sink: Option<&mut Vec<super::super::super::config::AgentUsageEvent>>,
) -> Result<AgentSessionTimeline, String> {
    read_timeline_from_mode(connection, session_id, false, usage_sink)
}

pub(in crate::core::agent_session_timeline) fn read_last_interaction(
    session_id: &str,
) -> Result<AgentSessionTimeline, String> {
    for database_path in opencode_database_candidates() {
        if !database_path.is_file() {
            continue;
        }
        let connection = match Connection::open_with_flags(
            &database_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) {
            Ok(connection) => connection,
            Err(_) => continue,
        };
        let _ = connection.busy_timeout(std::time::Duration::from_millis(750));
        let exists = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM session WHERE id = ?1)",
                params![session_id],
                |row| row.get::<_, bool>(0),
            )
            .unwrap_or(false);
        if exists {
            return read_timeline_from_mode(&connection, session_id, true, None);
        }
    }
    Ok(complete_timeline())
}

fn read_timeline_from_mode(
    connection: &Connection,
    session_id: &str,
    latest_interaction_only: bool,
    mut usage_sink: Option<&mut Vec<super::super::super::config::AgentUsageEvent>>,
) -> Result<AgentSessionTimeline, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT m.id, m.time_created, m.data, p.id, p.time_created, p.data
            FROM message m
            LEFT JOIN part p ON p.message_id = m.id
            WHERE m.session_id = ?1
            ORDER BY COALESCE(p.time_created, m.time_created), m.id, p.id
            "#,
        )
        .map_err(|error| format!("OpenCode 会话数据结构不兼容：{error}"))?;
    let rows = statement
        .query_map(params![session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(|error| format!("读取 OpenCode 会话失败：{error}"))?;

    let mut timeline = complete_timeline();
    timeline.source_available = true;
    timeline.usage = read_session_usage(connection, session_id);
    timeline.models = read_session_models(connection, session_id);
    let mut usage_messages = HashSet::new();
    let mut current_user_message_id: Option<String> = None;
    for row in rows {
        let (message_id, message_time, message_json, part_id, part_time, part_json) =
            row.map_err(|error| format!("读取 OpenCode 会话失败：{error}"))?;
        let Ok(message) = serde_json::from_str::<Value>(&message_json) else {
            continue;
        };
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let model = message_model(&message);
        let usage_event_model = model.clone();
        if let Some(model) = model.as_deref() {
            remember_model(&mut timeline, model);
        }
        let Some(part_json) = part_json else {
            continue;
        };
        let Ok(part) = serde_json::from_str::<Value>(&part_json) else {
            continue;
        };
        if latest_interaction_only
            && role == "user"
            && current_user_message_id.as_deref() != Some(message_id.as_str())
        {
            timeline.events.clear();
            current_user_message_id = Some(message_id.clone());
        }
        let event_id = part_id.unwrap_or_else(|| message_id.clone());
        let timestamp = part_time.or(message_time).and_then(format_unix_millis);
        let event_start = timeline.events.len();
        match part.get("type").and_then(Value::as_str) {
            Some("text") => push_event(
                &mut timeline,
                event_id,
                role_kind(role),
                timestamp,
                None,
                string_field(&part, "text"),
                model,
                None,
            ),
            Some("reasoning") => push_event(
                &mut timeline,
                event_id,
                "reasoning",
                timestamp,
                Some("思考摘要".to_string()),
                string_field(&part, "text"),
                model,
                None,
            ),
            Some("tool") => push_tool_events(&mut timeline, event_id, timestamp, &part),
            _ => {}
        }
        if role == "assistant" && usage_messages.insert(message_id.clone()) {
            timeline.turn_count += 1;
            let usage = usage_from_message(&message);
            if let (Some(sink), Some(usage)) = (usage_sink.as_deref_mut(), usage.as_ref()) {
                if let Some(event) = agent_usage_event(
                    message_id.clone(),
                    message_time.and_then(format_unix_millis),
                    usage_event_model,
                    usage,
                ) {
                    sink.push(event);
                }
            }
            attach_usage_to_first_event(&mut timeline, event_start, usage);
        }
    }
    Ok(timeline)
}

fn read_session_usage(
    connection: &Connection,
    session_id: &str,
) -> Option<AgentSessionNativeUsage> {
    connection
        .query_row(
            r#"
            SELECT tokens_input, tokens_cache_read, tokens_cache_write,
                   tokens_output, tokens_reasoning, cost
            FROM session WHERE id = ?1
            "#,
            params![session_id],
            |row| {
                let input_tokens = row.get::<_, Option<i64>>(0)?.unwrap_or_default();
                let cached_input_tokens = row.get::<_, Option<i64>>(1)?.unwrap_or_default();
                let cache_write_input_tokens = row.get::<_, Option<i64>>(2)?.unwrap_or_default();
                let output_tokens = row.get::<_, Option<i64>>(3)?.unwrap_or_default();
                let reasoning_tokens = row.get::<_, Option<i64>>(4)?.unwrap_or_default();
                Ok(AgentSessionNativeUsage {
                    input_tokens,
                    cached_input_tokens,
                    cache_write_input_tokens,
                    output_tokens,
                    reasoning_tokens,
                    total_tokens: input_tokens + output_tokens + reasoning_tokens,
                    cost: row.get(5)?,
                    cost_currency: Some("USD".to_string()),
                    api_equivalent: None,
                })
            },
        )
        .ok()
}

fn read_session_models(connection: &Connection, session_id: &str) -> Vec<String> {
    let model = connection
        .query_row(
            "SELECT model FROM session WHERE id = ?1",
            params![session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten();
    let Some(model) = model else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&model) else {
        return vec![model];
    };
    string_field(&value, "id")
        .or_else(|| string_field(&value, "modelID"))
        .into_iter()
        .collect()
}

fn usage_from_message(message: &Value) -> Option<AgentSessionNativeUsage> {
    let tokens = message.get("tokens")?;
    let cache = tokens.get("cache").unwrap_or(&Value::Null);
    Some(AgentSessionNativeUsage {
        input_tokens: integer_field(tokens, "input"),
        cached_input_tokens: integer_field(cache, "read"),
        cache_write_input_tokens: integer_field(cache, "write"),
        output_tokens: integer_field(tokens, "output"),
        reasoning_tokens: integer_field(tokens, "reasoning"),
        total_tokens: integer_field(tokens, "total"),
        cost: number_field(message, "cost"),
        cost_currency: Some("USD".to_string()),
        api_equivalent: None,
    })
}

fn push_tool_events(
    timeline: &mut AgentSessionTimeline,
    event_id: String,
    timestamp: Option<String>,
    part: &Value,
) {
    let tool = string_field(part, "tool").unwrap_or_else(|| "Tool".to_string());
    let state = part.get("state").unwrap_or(&Value::Null);
    let status = string_field(state, "status");
    if let Some(input) = state.get("input").and_then(render_json_value) {
        push_event(
            timeline,
            format!("{event_id}:call"),
            "tool-call",
            timestamp.clone(),
            Some(tool.clone()),
            Some(input),
            None,
            status.clone(),
        );
    }
    let result = state
        .get("output")
        .and_then(render_json_value)
        .or_else(|| state.get("error").and_then(render_json_value));
    if let Some(result) = result {
        let kind = if state.get("error").is_some() {
            "error"
        } else {
            "tool-result"
        };
        push_event(
            timeline,
            format!("{event_id}:result"),
            kind,
            timestamp,
            Some(tool),
            Some(result),
            None,
            status,
        );
    }
}
