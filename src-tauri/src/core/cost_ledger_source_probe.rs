use super::agent_session_metadata::list_native_agent_sessions;
use super::agent_session_timeline::get_native_agent_session_timeline;
use super::config::{AgentSessionNativeUsage, AgentSessionRow};
use super::Storage;
use chrono::Utc;
use serde::Serialize;

const MAX_SAMPLE_SESSIONS: usize = 3;
const MAX_SAMPLE_USAGE: usize = 5;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceIdentity {
    pub id: String,
    pub source_type: String,
    pub adapter: String,
    pub display_name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub source_kind: String,
    pub locator: String,
    pub raw_record_id: Option<String>,
    pub schema_fingerprint: String,
    pub observed_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionObservation {
    pub source: SourceIdentity,
    pub agent_type: String,
    pub session_id: String,
    pub parent_session_id: Option<String>,
    pub project_path: Option<String>,
    pub started_at: Option<String>,
    pub updated_at: Option<String>,
    pub evidence: Evidence,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenObservation {
    pub input_tokens: Option<i64>,
    pub cached_input_tokens: Option<i64>,
    pub cache_write_input_tokens: Option<i64>,
    pub uncached_input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub reasoning_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageObservation {
    pub source: SourceIdentity,
    pub source_event_id: String,
    pub granularity: String,
    pub is_rollup: bool,
    pub agent_type: Option<String>,
    pub session_id: Option<String>,
    pub parent_session_id: Option<String>,
    pub request_id: Option<String>,
    pub client_id: Option<String>,
    pub account_id: Option<String>,
    pub project_path: Option<String>,
    pub repository: Option<String>,
    pub git_branch: Option<String>,
    pub model: Option<String>,
    pub occurred_at: Option<String>,
    pub tokens: TokenObservation,
    pub cost: Option<f64>,
    pub cost_currency: Option<String>,
    pub credits: Option<f64>,
    pub operation_count: Option<i64>,
    pub status: Option<String>,
    pub confidence: String,
    pub evidence: Evidence,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountEntitlement {
    pub source: SourceIdentity,
    pub account_id: Option<String>,
    pub plan: Option<String>,
    pub quota_scope: Option<String>,
    pub valid_until: Option<String>,
    pub confidence: String,
    pub evidence: Evidence,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceObservation {
    pub source: SourceIdentity,
    pub account_id: Option<String>,
    pub balance: Option<f64>,
    pub currency: Option<String>,
    pub credits_remaining: Option<f64>,
    pub observed_at: String,
    pub confidence: String,
    pub evidence: Evidence,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceProbeReport {
    pub source: SourceIdentity,
    pub available: bool,
    pub authorized: bool,
    pub requires_authorization: bool,
    pub record_count: i64,
    pub time_range_start: Option<String>,
    pub time_range_end: Option<String>,
    pub granularities: Vec<String>,
    pub capabilities: Vec<String>,
    pub missing_fields: Vec<String>,
    pub dedupe_key: String,
    pub incremental_cursor: String,
    pub incremental_sync_supported: bool,
    pub schema_fingerprint: String,
    pub confidence: String,
    pub sampled_session_count: usize,
    pub sampled_usage_count: usize,
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostLedgerSourceProbeResult {
    pub generated_at: String,
    pub reports: Vec<SourceProbeReport>,
    pub sessions: Vec<SessionObservation>,
    pub usage: Vec<UsageObservation>,
    pub entitlements: Vec<AccountEntitlement>,
    pub balances: Vec<BalanceObservation>,
}

#[derive(Clone, Debug)]
pub(crate) struct GatewayProbeSnapshot {
    pub record_count: i64,
    pub time_range_start: Option<String>,
    pub time_range_end: Option<String>,
    pub samples: Vec<GatewayUsageSample>,
}

#[derive(Clone, Debug)]
pub(crate) struct GatewayUsageSample {
    pub request_id: String,
    pub agent_type: Option<String>,
    pub session_id: Option<String>,
    pub parent_session_id: Option<String>,
    pub client_id: Option<String>,
    pub account_id: Option<String>,
    pub project_path: Option<String>,
    pub model: Option<String>,
    pub occurred_at: String,
    pub input_tokens: Option<i64>,
    pub cached_input_tokens: Option<i64>,
    pub uncached_input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    pub estimated_cost: Option<f64>,
    pub status: Option<i64>,
    pub error_message: Option<String>,
}

#[derive(Clone, Copy)]
enum NativeSourceKind {
    Codex,
    ClaudeCode,
    OpenCode,
}

impl NativeSourceKind {
    fn identity(self) -> SourceIdentity {
        match self {
            Self::Codex => SourceIdentity {
                id: "codex-local".to_string(),
                source_type: "agent_native".to_string(),
                adapter: "codex-local-jsonl".to_string(),
                display_name: "Codex 本地会话".to_string(),
            },
            Self::ClaudeCode => SourceIdentity {
                id: "claude-code-local".to_string(),
                source_type: "agent_native".to_string(),
                adapter: "claude-code-jsonl".to_string(),
                display_name: "Claude Code 本地会话".to_string(),
            },
            Self::OpenCode => SourceIdentity {
                id: "opencode-local".to_string(),
                source_type: "agent_native".to_string(),
                adapter: "opencode-sqlite".to_string(),
                display_name: "OpenCode 本地会话".to_string(),
            },
        }
    }

    fn matches(self, agent_type: &str) -> bool {
        match self {
            Self::Codex => matches!(agent_type, "codex-desktop" | "codex-cli"),
            Self::ClaudeCode => agent_type == "claude-code",
            Self::OpenCode => agent_type == "opencode",
        }
    }

    fn schema_fingerprint(self) -> &'static str {
        match self {
            Self::Codex => "codex-jsonl:session_meta,response_item,token_count:v1",
            Self::ClaudeCode => "claude-jsonl:user,assistant,usage:v1",
            Self::OpenCode => "opencode-sqlite:session,message,part:v1",
        }
    }

    fn dedupe_key(self) -> &'static str {
        match self {
            Self::Codex => "agent_type + session_id + response_item.id/turn_id",
            Self::ClaudeCode => "session_id + message.id/uuid",
            Self::OpenCode => "session_id + message.id/part.id",
        }
    }

    fn cursor(self) -> &'static str {
        match self {
            Self::Codex => "rollout path + modified time + byte offset",
            Self::ClaudeCode => "transcript path + modified time + byte offset",
            Self::OpenCode => "session.time_updated + message/part id",
        }
    }

    fn capabilities(self) -> Vec<String> {
        let mut values = strings(&["session", "project", "model", "tokens"]);
        if matches!(self, Self::OpenCode) {
            values.push("native_cost".to_string());
        }
        values
    }

    fn missing_fields(self) -> Vec<String> {
        let mut values = strings(&[
            "request_id",
            "account_id",
            "repository",
            "git_branch",
            "price_version",
        ]);
        if !matches!(self, Self::OpenCode) {
            values.push("native_cost".to_string());
            values.push("cost_currency".to_string());
        }
        values
    }
}

pub fn probe_cost_ledger_sources(storage: &Storage) -> CostLedgerSourceProbeResult {
    let generated_at = Utc::now().to_rfc3339();
    let native_catalog = list_native_agent_sessions();
    let mut reports = Vec::new();
    let mut sessions = Vec::new();
    let mut usage = Vec::new();

    probe_gateway(storage, &generated_at, &mut reports, &mut usage);
    for kind in [
        NativeSourceKind::Codex,
        NativeSourceKind::ClaudeCode,
        NativeSourceKind::OpenCode,
    ] {
        probe_native_source(
            kind,
            &native_catalog,
            &generated_at,
            &mut reports,
            &mut sessions,
            &mut usage,
        );
    }

    CostLedgerSourceProbeResult {
        generated_at,
        reports,
        sessions,
        usage,
        entitlements: Vec::new(),
        balances: Vec::new(),
    }
}

fn probe_gateway(
    storage: &Storage,
    observed_at: &str,
    reports: &mut Vec<SourceProbeReport>,
    usage: &mut Vec<UsageObservation>,
) {
    let source = SourceIdentity {
        id: "flowlet-gateway".to_string(),
        source_type: "gateway".to_string(),
        adapter: "flowlet-sqlite".to_string(),
        display_name: "Flowlet 代理请求".to_string(),
    };
    let schema = "flowlet-sqlite:request_logs+usage_records:v1";
    match storage.cost_ledger_gateway_probe_snapshot(MAX_SAMPLE_USAGE) {
        Ok(snapshot) => {
            let usage_start = usage.len();
            for sample in snapshot.samples {
                let status = sample
                    .error_message
                    .as_ref()
                    .map(|_| "error".to_string())
                    .or_else(|| {
                        sample.status.map(|status| {
                            if (200..400).contains(&status) {
                                "success"
                            } else {
                                "error"
                            }
                            .to_string()
                        })
                    });
                usage.push(UsageObservation {
                    source: source.clone(),
                    source_event_id: sample.request_id.clone(),
                    granularity: "request".to_string(),
                    is_rollup: false,
                    agent_type: sample.agent_type,
                    session_id: sample.session_id,
                    parent_session_id: sample.parent_session_id,
                    request_id: Some(sample.request_id.clone()),
                    client_id: sample.client_id,
                    account_id: sample.account_id,
                    project_path: sample.project_path,
                    repository: None,
                    git_branch: None,
                    model: sample.model,
                    occurred_at: Some(sample.occurred_at),
                    tokens: TokenObservation {
                        input_tokens: sample.input_tokens,
                        cached_input_tokens: sample.cached_input_tokens,
                        cache_write_input_tokens: None,
                        uncached_input_tokens: sample.uncached_input_tokens,
                        output_tokens: sample.output_tokens,
                        reasoning_tokens: None,
                        total_tokens: sample.total_tokens,
                    },
                    cost: sample.estimated_cost,
                    cost_currency: None,
                    credits: None,
                    operation_count: Some(1),
                    status,
                    confidence: "high".to_string(),
                    evidence: evidence(
                        "sqlite_row",
                        &format!("request_logs:{}", sample.request_id),
                        Some(sample.request_id),
                        schema,
                        observed_at,
                    ),
                });
            }
            reports.push(SourceProbeReport {
                source,
                available: true,
                authorized: true,
                requires_authorization: false,
                record_count: snapshot.record_count,
                time_range_start: snapshot.time_range_start,
                time_range_end: snapshot.time_range_end,
                granularities: vec!["request".to_string()],
                capabilities: strings(&[
                    "request",
                    "session",
                    "account",
                    "client",
                    "model",
                    "tokens",
                    "status",
                    "estimated_cost",
                ]),
                missing_fields: strings(&[
                    "repository",
                    "git_branch",
                    "reasoning_tokens",
                    "cache_write_tokens",
                    "cost_currency",
                    "price_version",
                ]),
                dedupe_key: "request_id".to_string(),
                incremental_cursor: "created_at + request_id".to_string(),
                incremental_sync_supported: true,
                schema_fingerprint: schema.to_string(),
                confidence: "high".to_string(),
                sampled_session_count: 0,
                sampled_usage_count: usage.len() - usage_start,
                errors: Vec::new(),
            });
        }
        Err(error) => reports.push(failed_report(source, schema, error.to_string())),
    }
}

fn probe_native_source(
    kind: NativeSourceKind,
    catalog: &[AgentSessionRow],
    observed_at: &str,
    reports: &mut Vec<SourceProbeReport>,
    sessions: &mut Vec<SessionObservation>,
    usage: &mut Vec<UsageObservation>,
) {
    let source = kind.identity();
    let schema = kind.schema_fingerprint();
    let mut rows = catalog
        .iter()
        .filter(|row| kind.matches(&row.agent_type))
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| right.activity_at.cmp(&left.activity_at));
    let time_range_start = rows
        .iter()
        .map(|row| row.activity_at.as_str())
        .min()
        .map(str::to_string);
    let time_range_end = rows
        .iter()
        .map(|row| row.activity_at.as_str())
        .max()
        .map(str::to_string);
    let session_start = sessions.len();
    let usage_start = usage.len();
    let mut errors = Vec::new();

    for row in rows.iter().take(MAX_SAMPLE_SESSIONS) {
        sessions.push(SessionObservation {
            source: source.clone(),
            agent_type: row.agent_type.clone(),
            session_id: row.session_id.clone(),
            parent_session_id: row.parent_session_id.clone(),
            project_path: row.project_path.clone(),
            started_at: row.native_started_at.clone(),
            updated_at: row.native_updated_at.clone(),
            evidence: evidence(
                "native_session",
                &format!("{}:{}", row.agent_type, row.session_id),
                Some(row.session_id.clone()),
                schema,
                observed_at,
            ),
        });
        match get_native_agent_session_timeline(&row.agent_type, &row.session_id) {
            Ok(timeline) if timeline.source_available => {
                if let Some(native_usage) = timeline.usage.as_ref() {
                    usage.push(native_usage_observation(
                        &source,
                        row,
                        format!("summary:{}:{}", row.agent_type, row.session_id),
                        "session",
                        row.native_updated_at.clone(),
                        timeline.models.first().cloned(),
                        native_usage,
                        schema,
                        observed_at,
                    ));
                }
                for event in timeline
                    .events
                    .into_iter()
                    .filter(|event| event.usage.is_some())
                {
                    if usage.len() - usage_start >= MAX_SAMPLE_USAGE {
                        break;
                    }
                    let native_usage = event.usage.expect("usage was filtered above");
                    usage.push(native_usage_observation(
                        &source,
                        row,
                        event.id,
                        "turn",
                        event.timestamp,
                        event.model,
                        &native_usage,
                        schema,
                        observed_at,
                    ));
                }
            }
            Ok(_) => {}
            Err(error) => errors.push(format!("{}: {error}", row.session_id)),
        }
        if usage.len() - usage_start >= MAX_SAMPLE_USAGE {
            break;
        }
    }

    reports.push(SourceProbeReport {
        source,
        available: !rows.is_empty(),
        authorized: true,
        requires_authorization: true,
        record_count: rows.len() as i64,
        time_range_start,
        time_range_end,
        granularities: strings(&["session", "turn"]),
        capabilities: kind.capabilities(),
        missing_fields: kind.missing_fields(),
        dedupe_key: kind.dedupe_key().to_string(),
        incremental_cursor: kind.cursor().to_string(),
        incremental_sync_supported: true,
        schema_fingerprint: schema.to_string(),
        confidence: "high".to_string(),
        sampled_session_count: sessions.len() - session_start,
        sampled_usage_count: usage.len() - usage_start,
        errors,
    });
}

#[allow(clippy::too_many_arguments)]
fn native_usage_observation(
    source: &SourceIdentity,
    row: &AgentSessionRow,
    event_id: String,
    granularity: &str,
    occurred_at: Option<String>,
    model: Option<String>,
    usage: &AgentSessionNativeUsage,
    schema: &str,
    observed_at: &str,
) -> UsageObservation {
    UsageObservation {
        source: source.clone(),
        source_event_id: event_id.clone(),
        granularity: granularity.to_string(),
        is_rollup: granularity == "session",
        agent_type: Some(row.agent_type.clone()),
        session_id: Some(row.session_id.clone()),
        parent_session_id: row.parent_session_id.clone(),
        request_id: None,
        client_id: None,
        account_id: None,
        project_path: row.project_path.clone(),
        repository: None,
        git_branch: None,
        model,
        occurred_at,
        tokens: TokenObservation {
            input_tokens: Some(usage.input_tokens),
            cached_input_tokens: Some(usage.cached_input_tokens),
            cache_write_input_tokens: Some(usage.cache_write_input_tokens),
            uncached_input_tokens: None,
            output_tokens: Some(usage.output_tokens),
            reasoning_tokens: Some(usage.reasoning_tokens),
            total_tokens: Some(usage.total_tokens),
        },
        cost: usage.cost,
        cost_currency: usage.cost_currency.clone(),
        credits: None,
        operation_count: None,
        status: None,
        confidence: "high".to_string(),
        evidence: evidence(
            "native_record",
            &format!("{}:{}:{event_id}", row.agent_type, row.session_id),
            Some(event_id),
            schema,
            observed_at,
        ),
    }
}

fn evidence(
    source_kind: &str,
    locator: &str,
    raw_record_id: Option<String>,
    schema: &str,
    observed_at: &str,
) -> Evidence {
    Evidence {
        source_kind: source_kind.to_string(),
        locator: locator.to_string(),
        raw_record_id,
        schema_fingerprint: schema.to_string(),
        observed_at: observed_at.to_string(),
    }
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

fn failed_report(source: SourceIdentity, schema: &str, error: String) -> SourceProbeReport {
    SourceProbeReport {
        source,
        available: false,
        authorized: true,
        requires_authorization: false,
        record_count: 0,
        time_range_start: None,
        time_range_end: None,
        granularities: Vec::new(),
        capabilities: Vec::new(),
        missing_fields: Vec::new(),
        dedupe_key: "request_id".to_string(),
        incremental_cursor: "created_at + request_id".to_string(),
        incremental_sync_supported: true,
        schema_fingerprint: schema.to_string(),
        confidence: "unknown".to_string(),
        sampled_session_count: 0,
        sampled_usage_count: 0,
        errors: vec![error],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_source_kinds_match_only_their_agents() {
        assert!(NativeSourceKind::Codex.matches("codex-desktop"));
        assert!(NativeSourceKind::Codex.matches("codex-cli"));
        assert!(!NativeSourceKind::Codex.matches("claude-code"));
        assert!(NativeSourceKind::ClaudeCode.matches("claude-code"));
        assert!(NativeSourceKind::OpenCode.matches("opencode"));
        assert!(!NativeSourceKind::Codex
            .capabilities()
            .contains(&"native_cost".to_string()));
        assert!(NativeSourceKind::OpenCode
            .capabilities()
            .contains(&"native_cost".to_string()));
    }

    #[test]
    fn probe_evidence_locator_does_not_require_a_file_path() {
        let evidence = evidence(
            "native_record",
            "codex-desktop:session-1:event-1",
            Some("event-1".to_string()),
            NativeSourceKind::Codex.schema_fingerprint(),
            "2026-07-19T00:00:00Z",
        );
        assert_eq!(evidence.locator, "codex-desktop:session-1:event-1");
        assert!(!evidence.locator.contains(".codex"));
    }

    #[test]
    fn empty_gateway_probe_is_available_without_creating_ledger_rows() {
        let storage = Storage::open(":memory:").expect("open in-memory storage");
        let mut reports = Vec::new();
        let mut usage = Vec::new();

        probe_gateway(&storage, "2026-07-19T00:00:00Z", &mut reports, &mut usage);

        assert_eq!(reports.len(), 1);
        assert!(reports[0].available);
        assert_eq!(reports[0].record_count, 0);
        assert!(usage.is_empty());
    }
}
