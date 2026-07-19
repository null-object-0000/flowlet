use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentSourceChanged {
    agent_type: String,
}

pub fn start_agent_source_watcher(app: AppHandle) -> Result<RecommendedWatcher, String> {
    let watches = super::agent_session_metadata::native_agent_source_watches();
    let callback_watches = watches.clone();
    let last_emitted = Arc::new(Mutex::new(HashMap::<String, Instant>::new()));
    let callback_emitted = Arc::clone(&last_emitted);
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let Ok(event) = result else { return };
        for source in &callback_watches {
            if !event
                .paths
                .iter()
                .any(|path| relevant_change(path) && path.starts_with(&source.path))
            {
                continue;
            }
            let Ok(mut emitted) = callback_emitted.lock() else {
                return;
            };
            let now = Instant::now();
            if emitted
                .get(&source.agent_type)
                .is_some_and(|previous| now.duration_since(*previous) < Duration::from_millis(750))
            {
                continue;
            }
            emitted.insert(source.agent_type.clone(), now);
            drop(emitted);
            let _ = app.emit(
                "agent-source-changed",
                AgentSourceChanged {
                    agent_type: source.agent_type.clone(),
                },
            );
        }
    })
    .map_err(|error| format!("创建 Agent 数据源监听器失败：{error}"))?;

    for source in watches {
        if let Err(error) = watcher.watch(
            &source.path,
            if source.recursive {
                RecursiveMode::Recursive
            } else {
                RecursiveMode::NonRecursive
            },
        ) {
            tracing::warn!(path = %source.path.display(), %error, "Agent 数据源监听路径不可用，定时轮询继续兜底");
        }
    }
    Ok(watcher)
}

fn relevant_change(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("jsonl")
                || extension.eq_ignore_ascii_case("db")
                || extension.eq_ignore_ascii_case("sqlite")
                || extension.eq_ignore_ascii_case("wal")
        })
        || path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| name == "session_index.jsonl")
}
