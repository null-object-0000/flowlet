use super::super::*;

pub(in crate::core::agent_session_timeline) fn read_timeline(
    agent_type: &str,
    session_id: &str,
) -> Result<AgentSessionTimeline, String> {
    let _ = agent_type;
    for database_path in hermes_database_candidates() {
        if let Some(timeline) = read_from_database_if_present(&database_path, session_id, None)? {
            return Ok(timeline);
        }
    }
    Ok(empty_timeline())
}

pub(in crate::core::agent_session_timeline) fn read_last_interaction(
    agent_type: &str,
    session_id: &str,
) -> Result<Option<AgentSessionTimeline>, String> {
    let _ = agent_type;
    for database_path in hermes_database_candidates() {
        if let Some(timeline) = read_from_database_if_present(&database_path, session_id, Some(()))?
        {
            return Ok(Some(timeline));
        }
    }
    Ok(Some(complete_timeline()))
}

fn read_from_database_if_present(
    database_path: &Path,
    session_id: &str,
    latest_only: Option<()>,
) -> Result<Option<AgentSessionTimeline>, String> {
    if !database_path.is_file() {
        return Ok(None);
    }
    let connection = match Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(connection) => connection,
        Err(_) => return Ok(None),
    };
    let _ = connection.busy_timeout(std::time::Duration::from_millis(750));
    let exists = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1)",
            params![session_id],
            |row| row.get::<_, bool>(0),
        )
        .unwrap_or(false);
    if !exists {
        return Ok(None);
    }
    Ok(Some(read_timeline_from(
        &connection,
        session_id,
        latest_only.is_some(),
        None,
    )?))
}

fn read_timeline_from(
    connection: &Connection,
    session_id: &str,
    latest_only: bool,
    mut usage_sink: Option<&mut Vec<super::super::super::config::AgentUsageEvent>>,
) -> Result<AgentSessionTimeline, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, role, content, tool_name, tool_calls, timestamp,
                   reasoning_content, token_count
            FROM messages
            WHERE session_id = ?1
            ORDER BY id
            "#,
        )
        .map_err(|error| format!("Hermes Agent 会话数据结构不兼容：{error}"))?;
    let rows = statement
        .query_map(params![session_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<f64>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<i64>>(7)?,
            ))
        })
        .map_err(|error| format!("读取 Hermes Agent 会话失败：{error}"))?;

    let mut timeline = complete_timeline();
    timeline.source_available = true;
    timeline.usage = read_session_usage(connection, session_id);
    timeline.models = read_session_models(connection, session_id);
    let mut usage_messages = HashSet::new();
    let mut last_user_seen = false;
    for row in rows {
        let (message_id, role, content, tool_name, tool_calls, timestamp, reasoning, token_count) =
            row.map_err(|error| format!("读取 Hermes Agent 会话失败：{error}"))?;
        let role = role.unwrap_or_default();
        let timestamp = timestamp.and_then(format_unix_seconds);
        if latest_only {
            if role == "user" {
                if last_user_seen {
                    timeline.events.clear();
                    timeline.turn_count = 0;
                }
                last_user_seen = true;
            }
        }
        let event_start = timeline.events.len();
        match role.as_str() {
            "user" => {
                timeline.turn_count += 1;
                push_event(
                    &mut timeline,
                    format!("m{message_id}"),
                    "user-message",
                    timestamp.clone(),
                    None,
                    content.clone(),
                    None,
                    None,
                );
            }
            "assistant" => {
                if let Some(reasoning) = reasoning.filter(|value| !value.trim().is_empty()) {
                    push_event(
                        &mut timeline,
                        format!("m{message_id}:reasoning"),
                        "reasoning",
                        timestamp.clone(),
                        Some("思考".to_string()),
                        Some(reasoning),
                        None,
                        None,
                    );
                }
                let assistant_text = content.clone().filter(|value| !value.trim().is_empty());
                if assistant_text.is_some() || tool_calls.is_some() {
                    let text = assistant_text.or_else(|| {
                        tool_calls.and_then(|raw| {
                            serde_json::from_str::<Value>(&raw)
                                .ok()
                                .and_then(|value| render_json_value(&value))
                        })
                    });
                    push_event(
                        &mut timeline,
                        format!("m{message_id}"),
                        "assistant-message",
                        timestamp.clone(),
                        None,
                        text,
                        None,
                        None,
                    );
                }
                if usage_messages.insert(message_id) {
                    if let Some(sink) = usage_sink.as_deref_mut() {
                        if let Some(event) = agent_usage_event(
                            format!("m{message_id}"),
                            timestamp.clone(),
                            None,
                            &AgentSessionNativeUsage {
                                total_tokens: token_count.unwrap_or_default(),
                                ..Default::default()
                            },
                        ) {
                            sink.push(event);
                        }
                    }
                    if token_count.unwrap_or_default() > 0 {
                        attach_usage_to_first_event(
                            &mut timeline,
                            event_start,
                            Some(AgentSessionNativeUsage {
                                total_tokens: token_count.unwrap_or_default(),
                                ..Default::default()
                            }),
                        );
                    }
                }
            }
            "tool" => {
                push_event(
                    &mut timeline,
                    format!("m{message_id}"),
                    "tool-result",
                    timestamp,
                    tool_name,
                    content,
                    None,
                    None,
                );
            }
            _ => {}
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
            SELECT input_tokens, cache_read_tokens, cache_write_tokens,
                   output_tokens, reasoning_tokens, estimated_cost_usd
            FROM sessions WHERE id = ?1
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
    connection
        .query_row(
            "SELECT model FROM sessions WHERE id = ?1",
            params![session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
        .filter(|model| !model.trim().is_empty())
        .into_iter()
        .collect()
}
