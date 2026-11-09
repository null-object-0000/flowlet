//! Read-only quota observation through Antigravity's local language server.
//! The independent OAuth observer lives in `antigravity_oauth`; this module only probes local services.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::time::Duration;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AntigravityQuota {
    pub id: String,
    pub label: String,
    pub remaining_fraction: Option<f64>,
    pub reset_at: Option<String>,
    pub description: Option<String>,
    pub disabled: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AntigravityAccountReport {
    pub account_id: String,
    #[serde(default = "local_source")]
    pub source: String,
    #[serde(default)]
    pub stale: bool,
    #[serde(default)]
    pub reauthorization_required: bool,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub quotas: Vec<AntigravityQuota>,
    pub quota_source: Option<String>,
    pub updated_at: String,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct AntigravityAccountsReport {
    pub accounts: Vec<AntigravityAccountReport>,
}

fn local_source() -> String {
    "local".to_owned()
}

// Deliberately not Debug: command lines contain short-lived local CSRF secrets.
struct Server {
    pid: u32,
    csrf: String,
    extension_port: Option<u16>,
    extension_csrf: Option<String>,
}

fn flag(command: &str, name: &str) -> Option<String> {
    let pattern = format!(
        r#"(?:^|\s)--{}(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))"#,
        regex::escape(name)
    );
    let regex = regex::Regex::new(&pattern).ok()?;
    let captures = regex.captures(command)?;
    (1..=3).find_map(|index| captures.get(index).map(|value| value.as_str().to_owned()))
}

fn parse_server(pid: u32, command: &str) -> Option<Server> {
    let normalized = command.replace('\\', "/").to_lowercase();
    // Both markers are required: don't probe unrelated Codeium/Windsurf servers.
    if !normalized.contains("antigravity")
        || !(normalized.contains("language_server") || normalized.contains("language-server"))
    {
        return None;
    }
    let csrf = flag(command, "csrf_token")?;
    Some(Server {
        pid,
        csrf,
        extension_port: flag(command, "extension_server_port")
            .and_then(|s| s.parse::<u16>().ok())
            .filter(|p| *p > 0),
        extension_csrf: flag(command, "extension_server_csrf_token"),
    })
}

async fn command_output(program: &str, args: &[&str]) -> Result<String, String> {
    let mut command = tokio::process::Command::new(program);
    command.args(args).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(Duration::from_secs(4), command.output())
        .await
        .map_err(|_| "Antigravity 本地进程查询超时".to_owned())?
        .map_err(|_| "无法查询 Antigravity 本地进程".to_owned())?;
    if !output.status.success() {
        return Err("无法查询 Antigravity 本地进程".to_owned());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn discover_servers() -> Result<Vec<Server>, String> {
    #[cfg(windows)]
    {
        let output = command_output("powershell", &["-NoProfile", "-NonInteractive", "-Command",
            "Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*language*server*' -and $_.CommandLine -like '*antigravity*' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"]).await?;
        if output.trim().is_empty() {
            return Ok(Vec::new());
        }
        let value: Value = serde_json::from_str(&output)
            .map_err(|_| "无法解析 Antigravity 本地进程".to_owned())?;
        let entries = value.as_array().cloned().unwrap_or_else(|| vec![value]);
        return Ok(entries
            .iter()
            .filter_map(|entry| {
                parse_server(
                    u32::try_from(entry["ProcessId"].as_u64()?).ok()?,
                    entry["CommandLine"].as_str()?,
                )
            })
            .collect());
    }
    #[cfg(not(windows))]
    {
        let output = command_output("ps", &["-x", "-o", "pid=,command="]).await?;
        Ok(output
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                let (pid, command) = line.split_once(char::is_whitespace)?;
                parse_server(pid.parse().ok()?, command.trim())
            })
            .collect())
    }
}

#[cfg(target_os = "linux")]
fn linux_ports(pid: u32) -> BTreeSet<u16> {
    let root = std::path::PathBuf::from(format!("/proc/{pid}"));
    let sockets: BTreeSet<String> = std::fs::read_dir(root.join("fd"))
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| std::fs::read_link(entry.path()).ok())
        .filter_map(|path| {
            path.to_str()?
                .strip_prefix("socket:[")?
                .strip_suffix(']')
                .map(str::to_owned)
        })
        .collect();
    let mut ports = BTreeSet::new();
    for table in ["net/tcp", "net/tcp6"] {
        if let Ok(text) = std::fs::read_to_string(root.join(table)) {
            for line in text.lines().skip(1) {
                let fields: Vec<_> = line.split_whitespace().collect();
                if fields.len() > 9 && fields[3] == "0A" && sockets.contains(fields[9]) {
                    if let Some(port) = fields[1]
                        .rsplit(':')
                        .next()
                        .and_then(|s| u16::from_str_radix(s, 16).ok())
                    {
                        ports.insert(port);
                    }
                }
            }
        }
    }
    ports
}

async fn listening_ports(pid: u32) -> Result<BTreeSet<u16>, String> {
    #[cfg(target_os = "linux")]
    {
        return Ok(linux_ports(pid));
    }
    #[cfg(windows)]
    {
        let script = format!("Get-NetTCPConnection -State Listen -OwningProcess {pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort");
        return Ok(command_output(
            "powershell",
            &["-NoProfile", "-NonInteractive", "-Command", &script],
        )
        .await?
        .lines()
        .filter_map(|line| line.trim().parse::<u16>().ok())
        .collect());
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        Ok(command_output(
            "lsof",
            &[
                "-nP",
                "-a",
                "-p",
                &pid.to_string(),
                "-iTCP",
                "-sTCP:LISTEN",
                "-Fn",
            ],
        )
        .await?
        .lines()
        .filter(|line| line.starts_with('n'))
        .filter_map(|line| line.rsplit(':').next()?.parse::<u16>().ok())
        .collect())
    }
}

pub(super) fn string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub(super) fn reset_at(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        if let Ok(date) = chrono::DateTime::parse_from_rfc3339(text) {
            return Some(date.to_rfc3339());
        }
    }
    let seconds = value.as_i64().or_else(|| value.as_str()?.parse().ok())?;
    chrono::DateTime::from_timestamp(seconds, 0).map(|date| date.to_rfc3339())
}

pub(super) fn fraction(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|n| n.is_finite())
        .map(|n| n.clamp(0.0, 1.0))
}

fn valid_response(value: &Value) -> bool {
    value.is_object()
        && match value.get("code") {
            None | Some(Value::Null) => true,
            Some(Value::Number(n)) => n.as_i64() == Some(0),
            Some(Value::String(s)) => ["0", "ok", "success"].contains(&s.to_lowercase().as_str()),
            _ => false,
        }
}

pub(super) fn summary_quotas(value: &Value) -> Vec<AntigravityQuota> {
    if !valid_response(value) {
        return Vec::new();
    }
    let root = value
        .get("response")
        .or_else(|| value.get("summary"))
        .unwrap_or(value);
    let mut quotas = Vec::new();
    for group in root["groups"].as_array().into_iter().flatten() {
        for bucket in group["buckets"].as_array().into_iter().flatten() {
            let Some(id) = string(&bucket["bucketId"]).or_else(|| string(&bucket["id"])) else {
                continue;
            };
            let label = string(&bucket["displayName"])
                .or_else(|| string(&bucket["name"]))
                .unwrap_or_else(|| id.clone());
            let group_name = string(&group["displayName"]).or_else(|| string(&group["name"]));
            let remaining = &bucket["remaining"];
            quotas.push(AntigravityQuota {
                id,
                label: group_name
                    .map(|name| format!("{name} · {label}"))
                    .unwrap_or(label),
                remaining_fraction: fraction(&bucket["remainingFraction"])
                    .or_else(|| fraction(&remaining["remainingFraction"]))
                    .or_else(|| {
                        (remaining["case"] == "remainingFraction")
                            .then(|| fraction(&remaining["value"]))
                            .flatten()
                    }),
                reset_at: reset_at(&bucket["resetTime"]),
                description: string(&bucket["description"]),
                disabled: bucket["disabled"].as_bool().unwrap_or(false),
            });
        }
    }
    quotas
}

fn model_quotas(value: &Value) -> Vec<AntigravityQuota> {
    if !valid_response(value) {
        return Vec::new();
    }
    let configs = value
        .pointer("/userStatus/cascadeModelConfigData/clientModelConfigs")
        .or_else(|| value.get("clientModelConfigs"));
    configs
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| {
            let quota = model.get("quotaInfo").filter(|v| v.is_object())?;
            let id = string(&model["modelOrAlias"]["model"]).or_else(|| string(&model["label"]))?;
            Some(AntigravityQuota {
                label: string(&model["label"]).unwrap_or_else(|| id.clone()),
                id,
                remaining_fraction: fraction(&quota["remainingFraction"]),
                reset_at: reset_at(&quota["resetTime"]),
                description: None,
                disabled: false,
            })
        })
        .collect()
}

async fn rpc(
    client: &reqwest::Client,
    scheme: &str,
    port: u16,
    csrf: &str,
    method: &str,
    body: Value,
) -> Option<Value> {
    // Destination is always a discovered loopback port. No system proxy or redirects.
    let response = client
        .post(format!(
            "{scheme}://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/{method}"
        ))
        .header("X-Codeium-Csrf-Token", csrf)
        .header("Connect-Protocol-Version", "1")
        .json(&body)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    // Bound response size; never return raw RPC errors/headers (may include credentials).
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    valid_response(&value).then_some(value)
}

async fn query_server(server: &Server) -> AntigravityAccountReport {
    let mut report = AntigravityAccountReport {
        account_id: format!("local-{}", server.pid),
        source: "local".into(),
        stale: false,
        reauthorization_required: false,
        email: None,
        plan: None,
        quotas: Vec::new(),
        quota_source: None,
        updated_at: chrono::Utc::now().to_rfc3339(),
        error: None,
    };
    let result = tokio::time::timeout(Duration::from_secs(18), async {
        let mut ports = match listening_ports(server.pid).await {
            Ok(ports) => ports,
            Err(error) if server.extension_port.is_none() => return Err(error),
            Err(_) => BTreeSet::new(),
        };
        if let Some(port) = server.extension_port { ports.insert(port); }
        let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
            // Antigravity uses a self-signed certificate on loopback only.
            .danger_accept_invalid_certs(true).timeout(Duration::from_secs(2)).build()
            .map_err(|_| "无法创建 Antigravity 本地连接".to_owned())?;
        let metadata = json!({"metadata": {"ideName": "antigravity", "extensionName": "antigravity", "locale": "en"}});
        let mut best: Option<(Value, Vec<AntigravityQuota>, &str)> = None;
        for port in ports.into_iter().filter(|p| *p > 0).take(12) {
            for scheme in ["https", "http"] {
                let csrf = if scheme == "http" && Some(port) == server.extension_port {
                    server.extension_csrf.as_deref().unwrap_or(&server.csrf)
                } else { &server.csrf };
                let summary = rpc(&client, scheme, port, csrf, "RetrieveUserQuotaSummary", json!({"forceRefresh": false})).await;
                let mut quotas = summary.as_ref().map(summary_quotas).unwrap_or_default();
                let status = rpc(&client, scheme, port, csrf, "GetUserStatus", metadata.clone()).await;
                let mut source = "summary";
                if quotas.is_empty() {
                    source = "models";
                    quotas = status.as_ref().map(model_quotas).unwrap_or_default();
                }
                if quotas.is_empty() {
                    source = "models";
                    quotas = rpc(&client, scheme, port, csrf, "GetCommandModelConfigs", metadata.clone()).await
                        .as_ref().map(model_quotas).unwrap_or_default();
                }
                if status.as_ref().and_then(|v| v.get("userStatus")).is_none() && quotas.is_empty() { continue; }
                let status = status.unwrap_or(Value::Null);
                if !quotas.is_empty() { return Ok((status, quotas, source)); }
                best = Some((status, quotas, source));
            }
        }
        best.ok_or_else(|| "无法读取 Antigravity 额度，请确认客户端已登录且本地服务已就绪".to_owned())
    }).await;
    match result {
        Ok(Ok((status, quotas, source))) => {
            report.quota_source = Some(source.to_owned());
            report.email = string(&status["userStatus"]["email"]);
            report.account_id = report.email.clone().unwrap_or(report.account_id);
            report.plan = string(&status["userStatus"]["userTier"]["name"]).or_else(|| {
                let info = &status["userStatus"]["planStatus"]["planInfo"];
                [
                    "planDisplayName",
                    "displayName",
                    "productName",
                    "planName",
                    "planShortName",
                ]
                .iter()
                .find_map(|key| string(&info[*key]))
            });
            report.quotas = quotas;
        }
        Ok(Err(error)) => report.error = Some(error),
        Err(_) => report.error = Some("Antigravity 额度查询超时，请稍后刷新".to_owned()),
    }
    report
}

// A measured grouped summary contains windows missing from the legacy model list.
fn report_quality(report: &AntigravityAccountReport) -> (bool, bool, bool, usize) {
    (
        report.error.is_none(),
        report
            .quotas
            .iter()
            .any(|q| !q.disabled && q.remaining_fraction.is_some()),
        report.quota_source.as_deref() == Some("summary"),
        report.quotas.len(),
    )
}

pub async fn query_antigravity_accounts() -> Result<AntigravityAccountsReport, String> {
    let servers = discover_servers().await?;
    // Probe independently so an unresponsive window cannot hide another signed-in account.
    let accounts = futures_util::future::join_all(servers.iter().take(8).map(query_server)).await;
    let mut deduplicated: Vec<AntigravityAccountReport> = Vec::new();
    for account in accounts {
        if let Some(existing) = deduplicated
            .iter_mut()
            .find(|a| a.account_id == account.account_id)
        {
            if report_quality(&account) > report_quality(existing) {
                *existing = account;
            }
        } else {
            deduplicated.push(account);
        }
    }
    Ok(AntigravityAccountsReport {
        accounts: deduplicated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn local_rpc_reads_summary_and_identity_and_falls_back_to_command_models() {
        use axum::{
            extract::{Path, State},
            http::{HeaderMap, StatusCode},
            routing::post,
            Json, Router,
        };
        async fn handler(
            State(legacy): State<bool>,
            Path(method): Path<String>,
            headers: HeaderMap,
            Json(body): Json<Value>,
        ) -> Result<Json<Value>, StatusCode> {
            assert_eq!(headers.get("x-codeium-csrf-token").unwrap(), "test-csrf");
            assert_eq!(headers.get("connect-protocol-version").unwrap(), "1");
            match method.as_str() {
                "RetrieveUserQuotaSummary" if !legacy => {
                    assert_eq!(body["forceRefresh"], false);
                    Ok(Json(
                        json!({"response":{"groups":[{"displayName":"Gemini","buckets":[
                            {"bucketId":"weekly","remaining":{"remainingFraction":0.42}}
                        ]}]}}),
                    ))
                }
                "GetUserStatus" if !legacy => Ok(Json(json!({"userStatus":{
                    "email":"test@example.test", "userTier":{"name":"Ultra"},
                    "planStatus":{"planInfo":{"planName":"Pro"}}
                }}))),
                "GetCommandModelConfigs" if legacy => Ok(Json(json!({"clientModelConfigs":[
                    {"label":"Gemini", "quotaInfo":{"remainingFraction":0.1}}
                ]}))),
                _ => Err(StatusCode::NOT_FOUND),
            }
        }
        for legacy in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let router = Router::new()
                .route(
                    "/exa.language_server_pb.LanguageServerService/{method}",
                    post(handler),
                )
                .with_state(legacy);
            let task = tokio::spawn(async move {
                axum::serve(listener, router).await.unwrap();
            });
            // A nonexistent PID keeps the fixture independent of platform process tools.
            let report = query_server(&Server {
                pid: u32::MAX,
                csrf: "test-csrf".into(),
                extension_port: Some(port),
                extension_csrf: None,
            })
            .await;
            task.abort();
            assert!(report.error.is_none(), "{:?}", report.error);
            assert_eq!(report.quotas.len(), 1);
            assert_eq!(
                report.quota_source.as_deref(),
                Some(if legacy { "models" } else { "summary" })
            );
            if !legacy {
                assert_eq!(report.email.as_deref(), Some("test@example.test"));
                assert_eq!(report.plan.as_deref(), Some("Ultra"));
                assert_eq!(report.quotas[0].remaining_fraction, Some(0.42));
            }
            assert!(!serde_json::to_string(&report)
                .unwrap()
                .contains("test-csrf"));
        }
    }

    #[test]
    fn process_detection_requires_brand_server_and_csrf_and_handles_equals() {
        assert!(parse_server(1, "/windsurf/language_server --csrf_token secret").is_none());
        assert!(parse_server(1, "/antigravity/renderer --csrf_token secret").is_none());
        assert!(parse_server(1, "/antigravity/language_server").is_none());
        let server = parse_server(42, r#""C:\Antigravity\language_server.exe" --csrf_token=secret --extension_server_port 1234 --extension_server_csrf_token "other""#).unwrap();
        assert_eq!(server.csrf, "secret");
        assert_eq!(server.extension_port, Some(1234));
        assert_eq!(server.extension_csrf.as_deref(), Some("other"));
    }

    #[test]
    fn legacy_preserves_unknown_zero_and_reset_without_inventing_quota() {
        let quotas = model_quotas(
            &json!({"userStatus": {"cascadeModelConfigData": {"clientModelConfigs": [
                {"label":"Gemini", "modelOrAlias":{"model":"gemini"}, "quotaInfo":{"remainingFraction":0,"resetTime":"2026-11-07T00:00:00Z"}},
                {"label":"Claude", "quotaInfo":{"resetTime":"1794009600"}},
                {"label":"No quota"}
            ]}}}),
        );
        assert_eq!(quotas.len(), 2);
        assert_eq!(quotas[0].remaining_fraction, Some(0.0));
        assert_eq!(quotas[1].remaining_fraction, None);
        assert!(quotas[1].reset_at.is_some());
    }

    #[test]
    fn summaries_keep_disabled_and_unknown_buckets_and_support_oneof() {
        let quotas = summary_quotas(
            &json!({"response":{"groups":[{"displayName":"Gemini", "buckets":[
                {"bucketId":"weekly", "remaining":{"remainingFraction":0.25}},
                {"bucketId":"session", "remaining":{"case":"remainingFraction","value":1.4}},
                {"bucketId":"unknown", "disabled":true}
            ]}]}}),
        );
        assert_eq!(quotas.len(), 3);
        assert_eq!(quotas[0].remaining_fraction, Some(0.25));
        assert_eq!(quotas[1].remaining_fraction, Some(1.0));
        assert_eq!(quotas[2].remaining_fraction, None);
        assert!(quotas[2].disabled);
        assert!(summary_quotas(&json!({"code":"unauthenticated", "groups":[]})).is_empty());
    }
}
