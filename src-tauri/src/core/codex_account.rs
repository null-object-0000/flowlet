use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

const RPC_TIMEOUT: Duration = Duration::from_secs(12);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const MANAGED_PROFILE_CONFIG: &str = "cli_auth_credentials_store = \"file\"\n";

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct CodexUsageWindow {
    pub used_percent: f64,
    pub window_duration_mins: i64,
    pub resets_at: i64,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct CodexCredits {
    pub has_credits: bool,
    pub unlimited: bool,
    pub balance: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct CodexRateLimitResetCredit {
    pub id: String,
    pub reset_type: Option<String>,
    pub status: Option<String>,
    pub granted_at: Option<i64>,
    pub expires_at: Option<i64>,
    pub title: Option<String>,
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct CodexRateLimitResetCredits {
    pub available_count: i64,
    pub credits: Option<Vec<CodexRateLimitResetCredit>>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct CodexAccountReport {
    pub account_id: String,
    pub signed_in: bool,
    pub is_current: bool,
    pub auth_mode: Option<String>,
    pub email: Option<String>,
    pub plan_type: Option<String>,
    pub primary: Option<CodexUsageWindow>,
    pub secondary: Option<CodexUsageWindow>,
    pub credits: Option<CodexCredits>,
    #[serde(default)]
    pub rate_limit_reset_credits: Option<CodexRateLimitResetCredits>,
    pub rate_limit_reached_type: Option<String>,
    pub source: String,
    pub updated_at: String,
    pub stale: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CodexAccountsReport {
    pub accounts: Vec<CodexAccountReport>,
    pub current_account_id: Option<String>,
}

pub async fn query_codex_accounts(managed_root: &Path) -> Result<CodexAccountsReport, String> {
    std::fs::create_dir_all(managed_root)
        .map_err(|error| format!("无法创建 Codex 多账号目录：{error}"))?;

    let current_result = query_current_codex_account().await;
    let current_error = current_result.as_ref().err().cloned();
    let mut current = current_result.ok().filter(|report| report.signed_in);
    if let Some(report) = current.as_mut() {
        report.is_current = true;
        if let Ok(auth) = read_json(&codex_home().join("auth.json")) {
            persist_managed_profile(managed_root, &auth, report)?;
        }
    }
    let current_account_id = current.as_ref().map(|report| report.account_id.clone());
    let mut accounts = current.into_iter().collect::<Vec<_>>();

    let entries = std::fs::read_dir(managed_root)
        .map_err(|error| format!("无法读取 Codex 多账号目录：{error}"))?;
    for profile_dir in entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
    {
        let auth_path = profile_dir.join("auth.json");
        let snapshot_path = profile_dir.join("snapshot.json");
        let stored_snapshot = read_snapshot(&snapshot_path);
        // The usage API's canonical account_id can differ from auth.json's
        // workspace/account hint. Prefer the successful usage snapshot so the
        // live account is not queried and rendered a second time.
        let stored_id = stored_snapshot
            .as_ref()
            .map(|snapshot| snapshot.account_id.clone())
            .or_else(|| {
                read_json(&auth_path).ok().and_then(|auth| {
                    auth.pointer("/tokens/account_id")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
            });
        if stored_id.as_deref() == current_account_id.as_deref() {
            continue;
        }

        match query_codex_account_via_oauth_path(&auth_path).await {
            Ok(report) => {
                write_private_json(&snapshot_path, &report)?;
                accounts.push(report);
            }
            Err(oauth_error) => {
                match query_codex_account_via_app_server(Some(&profile_dir)).await {
                    Ok(report) if report.signed_in => {
                        write_private_json(&snapshot_path, &report)?;
                        accounts.push(report);
                    }
                    app_server_result => {
                        if let Some(mut snapshot) = stored_snapshot {
                            snapshot.is_current = false;
                            snapshot.stale = true;
                            snapshot.error = Some(match app_server_result {
                                Ok(_) => "登录凭据已失效，请在 Codex 中重新登录该账号后刷新"
                                    .to_string(),
                                Err(app_server_error) => format!(
                                    "Codex 账号刷新失败。OAuth 会话：{oauth_error}；app-server：{app_server_error}"
                                ),
                            });
                            accounts.push(snapshot);
                        }
                    }
                }
            }
        }
    }

    sort_accounts(&mut accounts);
    deduplicate_accounts(&mut accounts);
    if accounts.is_empty() {
        if let Some(error) = current_error {
            return Err(error);
        }
    }

    Ok(CodexAccountsReport {
        accounts,
        current_account_id,
    })
}

fn sort_accounts(accounts: &mut [CodexAccountReport]) {
    accounts.sort_by(|left, right| {
        right
            .is_current
            .cmp(&left.is_current)
            .then_with(|| left.stale.cmp(&right.stale))
            .then_with(|| left.email.cmp(&right.email))
    });
}

pub async fn authorize_codex_account<F>(
    managed_root: &Path,
    open_auth_url: F,
) -> Result<CodexAccountReport, String>
where
    F: FnOnce(&str) -> Result<(), String>,
{
    std::fs::create_dir_all(managed_root)
        .map_err(|error| format!("无法创建 Codex 多账号目录：{error}"))?;
    let pending_dir = managed_root.join(format!(".pending-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&pending_dir)
        .map_err(|error| format!("无法创建 Codex 独立登录目录：{error}"))?;
    if let Err(error) = write_managed_profile_config(&pending_dir) {
        let _ = std::fs::remove_dir_all(&pending_dir);
        return Err(error);
    }

    let mut rpc = match start_codex_rpc(Some(&pending_dir)).await {
        Ok(rpc) => rpc,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&pending_dir);
            return Err(error);
        }
    };
    let result = async {
        initialize_codex_rpc(&mut rpc).await?;
        let login = rpc
            .call(2, "account/login/start", Some(json!({ "type": "chatgpt" })))
            .await?;
        let (login_id, auth_url) = parse_login_start(&login)?;
        open_auth_url(&auth_url)?;
        rpc.wait_for_login_completed(&login_id).await?;

        let auth_path = pending_dir.join("auth.json");
        let report = match query_codex_account_via_oauth_path(&auth_path).await {
            Ok(report) => report,
            Err(_) => read_codex_account_report(&mut rpc, false, 3).await?,
        };
        if !report.signed_in {
            return Err("Codex 独立账号授权完成后仍未检测到登录状态".to_string());
        }
        let auth = read_json(&auth_path)?;
        persist_managed_profile(managed_root, &auth, &report)?;
        Ok(report)
    }
    .await;

    rpc.stop().await;
    let _ = std::fs::remove_dir_all(&pending_dir);
    result
}

fn deduplicate_accounts(accounts: &mut Vec<CodexAccountReport>) {
    let mut seen = std::collections::HashSet::new();
    accounts.retain(|account| seen.insert(account.account_id.clone()));
}

fn persist_managed_profile(
    managed_root: &Path,
    auth: &Value,
    report: &CodexAccountReport,
) -> Result<(), String> {
    let profile_dir = managed_root.join(profile_directory_name(&report.account_id));
    std::fs::create_dir_all(&profile_dir)
        .map_err(|error| format!("无法创建 Codex 账号目录：{error}"))?;
    write_managed_profile_config(&profile_dir)?;
    write_private_json(&profile_dir.join("auth.json"), auth)?;
    write_private_json(&profile_dir.join("snapshot.json"), report)
}

fn write_managed_profile_config(profile_dir: &Path) -> Result<(), String> {
    std::fs::write(profile_dir.join("config.toml"), MANAGED_PROFILE_CONFIG)
        .map_err(|error| format!("写入 Codex 独立账号配置失败：{error}"))
}

fn read_json(path: &Path) -> Result<Value, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|error| format!("无法读取 {}：{error}", path.to_string_lossy()))?;
    serde_json::from_str(&content).map_err(|error| format!("Codex 登录文件格式无效：{error}"))
}

fn read_snapshot(path: &Path) -> Option<CodexAccountReport> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
}

fn write_private_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("序列化 Codex 账号数据失败：{error}"))?;
    let temporary = path.with_extension("tmp");
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("写入 Codex 账号数据失败：{error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("保存 Codex 账号数据失败：{error}"))?;
    #[cfg(windows)]
    if path.exists() {
        std::fs::remove_file(path).map_err(|error| format!("替换 Codex 账号数据失败：{error}"))?;
    }
    std::fs::rename(&temporary, path).map_err(|error| format!("更新 Codex 账号数据失败：{error}"))
}

fn profile_directory_name(account_id: &str) -> String {
    let safe: String = account_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect();
    if safe.is_empty() {
        "unknown-account".to_string()
    } else {
        safe
    }
}

fn account_identity(account_id: Option<&str>, email: Option<&str>) -> String {
    account_id
        .filter(|value| !value.is_empty())
        .or(email)
        .unwrap_or("unknown-account")
        .to_string()
}

async fn query_current_codex_account() -> Result<CodexAccountReport, String> {
    match query_codex_account_via_oauth().await {
        Ok(report) => Ok(report),
        Err(oauth_error) => match query_codex_account_via_app_server(None).await {
            Ok(report) => Ok(report),
            Err(app_server_error) => Err(format!(
                "Codex 账号查询失败。OAuth 会话：{oauth_error}；app-server：{app_server_error}"
            )),
        },
    }
}

async fn query_codex_account_via_app_server(
    home_override: Option<&Path>,
) -> Result<CodexAccountReport, String> {
    let mut rpc = start_codex_rpc(home_override).await?;
    let result = async {
        initialize_codex_rpc(&mut rpc).await?;
        read_codex_account_report(&mut rpc, true, 2).await
    }
    .await;

    rpc.stop().await;
    result
}

async fn start_codex_rpc(home_override: Option<&Path>) -> Result<CodexRpc, String> {
    let executable = resolve_codex_executable().await;
    let mut command = codex_command(&executable);
    if let Some(home) = home_override {
        command.env("CODEX_HOME", home);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            format!(
                "无法启动 Codex app-server（{}）：{error}",
                executable.to_string_lossy()
            )
        })?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法连接 Codex app-server 标准输入".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法连接 Codex app-server 标准输出".to_string())?;
    Ok(CodexRpc::new(child, stdin, stdout))
}

async fn initialize_codex_rpc(rpc: &mut CodexRpc) -> Result<(), String> {
    rpc.call(
        1,
        "initialize",
        Some(json!({
            "clientInfo": {
                "name": "flowlet",
                "title": "Flowlet",
                "version": env!("CARGO_PKG_VERSION")
            }
        })),
    )
    .await?;
    rpc.notify("initialized", None).await
}

async fn read_codex_account_report(
    rpc: &mut CodexRpc,
    refresh_token: bool,
    account_call_id: i64,
) -> Result<CodexAccountReport, String> {
    let account = rpc
        .call(
            account_call_id,
            "account/read",
            Some(if refresh_token {
                account_read_params()
            } else {
                json!({ "refreshToken": false })
            }),
        )
        .await?;

    let account_value = account.get("account").filter(|value| !value.is_null());
    let auth_mode = account_value
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let email = account_value
        .and_then(|value| value.get("email"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let account_plan = account_value
        .and_then(|value| value.get("planType"))
        .and_then(Value::as_str)
        .map(str::to_owned);

    if account_value.is_none() {
        return Ok(CodexAccountReport {
            account_id: String::new(),
            signed_in: false,
            is_current: false,
            auth_mode: None,
            email: None,
            plan_type: None,
            primary: None,
            secondary: None,
            credits: None,
            rate_limit_reset_credits: None,
            rate_limit_reached_type: None,
            source: "app_server".to_string(),
            updated_at: chrono::Utc::now().to_rfc3339(),
            stale: false,
            error: None,
        });
    }

    let rate_limit_result = if auth_mode.as_deref() == Some("chatgpt") {
        Some(
            rpc.call(account_call_id + 1, "account/rateLimits/read", None)
                .await?,
        )
    } else {
        None
    };
    let rate_limits = rate_limit_result
        .as_ref()
        .and_then(|value| value.get("rateLimits"))
        .filter(|value| !value.is_null());

    Ok(CodexAccountReport {
        account_id: account_value
            .and_then(|value| value.get("accountId"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| account_identity(None, email.as_deref())),
        signed_in: true,
        is_current: false,
        auth_mode,
        email,
        plan_type: rate_limits
            .and_then(|value| value.get("planType"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or(account_plan),
        primary: rate_limits
            .and_then(|value| value.get("primary"))
            .and_then(parse_usage_window),
        secondary: rate_limits
            .and_then(|value| value.get("secondary"))
            .and_then(parse_usage_window),
        credits: rate_limits
            .and_then(|value| value.get("credits"))
            .and_then(parse_credits),
        rate_limit_reset_credits: rate_limit_result
            .as_ref()
            .and_then(|value| value.get("rateLimitResetCredits"))
            .and_then(parse_rate_limit_reset_credits),
        rate_limit_reached_type: rate_limits
            .and_then(|value| value.get("rateLimitReachedType"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        source: "app_server".to_string(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        stale: false,
        error: None,
    })
}

fn account_read_params() -> Value {
    json!({ "refreshToken": true })
}

fn parse_login_start(value: &Value) -> Result<(String, String), String> {
    let login_id = value
        .get("loginId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Codex 登录流程未返回 loginId".to_string())?;
    let auth_url = value
        .get("authUrl")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Codex 登录流程未返回授权地址".to_string())?;
    Ok((login_id.to_string(), auth_url.to_string()))
}

async fn query_codex_account_via_oauth() -> Result<CodexAccountReport, String> {
    let auth_path = codex_home().join("auth.json");
    query_codex_account_via_oauth_path(&auth_path).await
}

async fn query_codex_account_via_oauth_path(
    auth_path: &Path,
) -> Result<CodexAccountReport, String> {
    let content = std::fs::read_to_string(&auth_path)
        .map_err(|error| format!("无法读取 {}：{error}", auth_path.to_string_lossy()))?;
    let auth: Value = serde_json::from_str(&content)
        .map_err(|error| format!("Codex 登录文件格式无效：{error}"))?;
    let access_token = auth
        .pointer("/tokens/access_token")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "未找到 ChatGPT OAuth 会话".to_string())?;

    let response = reqwest::Client::new()
        .get("https://chatgpt.com/backend-api/wham/usage")
        .bearer_auth(access_token)
        .header(reqwest::header::ACCEPT, "application/json")
        .timeout(RPC_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("官方用量接口请求失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("官方用量接口返回 HTTP {}", response.status()));
    }
    let usage: Value = response
        .json()
        .await
        .map_err(|error| format!("官方用量接口返回了无效数据：{error}"))?;
    parse_oauth_usage(
        &usage,
        auth.pointer("/tokens/account_id").and_then(Value::as_str),
    )
}

fn parse_oauth_usage(
    usage: &Value,
    auth_account_id: Option<&str>,
) -> Result<CodexAccountReport, String> {
    let email = usage
        .get("email")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let plan_type = usage
        .get("plan_type")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if email.is_none() && plan_type.is_none() {
        return Err("官方用量接口未返回账号信息".to_string());
    }

    Ok(CodexAccountReport {
        account_id: usage
            .get("account_id")
            .and_then(Value::as_str)
            .or(auth_account_id)
            .map(str::to_owned)
            .unwrap_or_else(|| account_identity(None, email.as_deref())),
        signed_in: true,
        is_current: false,
        auth_mode: Some("chatgpt".to_string()),
        email,
        plan_type,
        primary: usage
            .pointer("/rate_limit/primary_window")
            .and_then(parse_oauth_usage_window),
        secondary: usage
            .pointer("/rate_limit/secondary_window")
            .and_then(parse_oauth_usage_window),
        credits: usage.get("credits").and_then(parse_oauth_credits),
        rate_limit_reset_credits: usage
            .get("rate_limit_reset_credits")
            .or_else(|| usage.get("rateLimitResetCredits"))
            .and_then(parse_rate_limit_reset_credits),
        rate_limit_reached_type: usage
            .get("rate_limit_reached_type")
            .and_then(Value::as_str)
            .map(str::to_owned),
        source: "oauth".to_string(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        stale: false,
        error: None,
    })
}

fn parse_oauth_usage_window(value: &Value) -> Option<CodexUsageWindow> {
    Some(CodexUsageWindow {
        used_percent: value.get("used_percent")?.as_f64()?,
        window_duration_mins: value.get("limit_window_seconds")?.as_i64()? / 60,
        resets_at: value.get("reset_at")?.as_i64()?,
    })
}

fn parse_oauth_credits(value: &Value) -> Option<CodexCredits> {
    Some(CodexCredits {
        has_credits: value.get("has_credits")?.as_bool()?,
        unlimited: value.get("unlimited")?.as_bool()?,
        balance: value.get("balance").and_then(|balance| match balance {
            Value::String(value) => Some(value.clone()),
            Value::Number(value) => Some(value.to_string()),
            _ => None,
        }),
    })
}

fn parse_rate_limit_reset_credits(value: &Value) -> Option<CodexRateLimitResetCredits> {
    let available_count = value
        .get("availableCount")
        .or_else(|| value.get("available_count"))?
        .as_i64()?;
    let credits = match value.get("credits") {
        None | Some(Value::Null) => None,
        Some(Value::Array(items)) => Some(
            items
                .iter()
                .filter_map(parse_rate_limit_reset_credit)
                .collect(),
        ),
        Some(_) => return None,
    };
    Some(CodexRateLimitResetCredits {
        available_count,
        credits,
    })
}

fn parse_rate_limit_reset_credit(value: &Value) -> Option<CodexRateLimitResetCredit> {
    Some(CodexRateLimitResetCredit {
        id: value.get("id")?.as_str()?.to_string(),
        reset_type: optional_string(value, "resetType", "reset_type"),
        status: value
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_owned),
        granted_at: optional_i64(value, "grantedAt", "granted_at"),
        expires_at: optional_i64(value, "expiresAt", "expires_at"),
        title: value
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_owned),
        description: value
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

fn optional_string(value: &Value, camel: &str, snake: &str) -> Option<String> {
    value
        .get(camel)
        .or_else(|| value.get(snake))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn optional_i64(value: &Value, camel: &str, snake: &str) -> Option<i64> {
    value
        .get(camel)
        .or_else(|| value.get(snake))
        .and_then(Value::as_i64)
}

pub(crate) fn codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
        .unwrap_or_else(|| PathBuf::from(".codex"))
}

#[cfg(windows)]
fn codex_command(executable: &Path) -> Command {
    // Microsoft Store exposes the bundled Codex binary as an AppX execution alias.
    // CreateProcess-based launchers can reject that reparse point with EFTYPE, while
    // PowerShell resolves it correctly and transparently forwards the JSONL streams.
    let escaped = executable.to_string_lossy().replace('\'', "''");
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        &format!("& '{escaped}' -s read-only -a untrusted app-server"),
    ]);
    command
}

#[cfg(not(windows))]
fn codex_command(executable: &Path) -> Command {
    let mut command = Command::new(executable);
    command.args(["-s", "read-only", "-a", "untrusted", "app-server"]);
    command
}

fn parse_usage_window(value: &Value) -> Option<CodexUsageWindow> {
    Some(CodexUsageWindow {
        used_percent: value.get("usedPercent")?.as_f64()?,
        window_duration_mins: value.get("windowDurationMins")?.as_i64()?,
        resets_at: value.get("resetsAt")?.as_i64()?,
    })
}

fn parse_credits(value: &Value) -> Option<CodexCredits> {
    Some(CodexCredits {
        has_credits: value.get("hasCredits")?.as_bool()?,
        unlimited: value.get("unlimited")?.as_bool()?,
        balance: value.get("balance").and_then(|balance| match balance {
            Value::String(value) => Some(value.clone()),
            Value::Number(value) => Some(value.to_string()),
            _ => None,
        }),
    })
}

async fn resolve_codex_executable() -> PathBuf {
    let environment =
        crate::core::agent_environment::detect_agent_environment("chatgpt-desktop").await;
    if let Ok(report) = environment {
        if let Some(installation) = report.primary {
            if installation.surface == crate::core::agent_environment::AgentSurface::Cli {
                return PathBuf::from(installation.executable_path);
            }
            let install_dir = PathBuf::from(installation.install_dir);
            #[cfg(windows)]
            {
                let bundled = install_dir.join("app").join("resources").join("codex.exe");
                if bundled.is_file() {
                    return bundled;
                }
            }
            #[cfg(target_os = "macos")]
            {
                let bundled = install_dir.join("Contents").join("Resources").join("codex");
                if bundled.is_file() {
                    return bundled;
                }
            }
        }
    }
    PathBuf::from(if cfg!(windows) { "codex.exe" } else { "codex" })
}

struct CodexRpc {
    child: Child,
    stdin: ChildStdin,
    stdout: tokio::io::Lines<BufReader<ChildStdout>>,
}

impl CodexRpc {
    fn new(child: Child, stdin: ChildStdin, stdout: ChildStdout) -> Self {
        Self {
            child,
            stdin,
            stdout: BufReader::new(stdout).lines(),
        }
    }

    async fn call(
        &mut self,
        id: i64,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, String> {
        let mut request = json!({ "method": method, "id": id });
        if let Some(params) = params {
            request["params"] = params;
        }
        self.send(&request).await?;

        loop {
            let line = tokio::time::timeout(RPC_TIMEOUT, self.stdout.next_line())
                .await
                .map_err(|_| format!("Codex app-server 调用 {method} 超时"))?
                .map_err(|error| format!("读取 Codex app-server 响应失败：{error}"))?
                .ok_or_else(|| "Codex app-server 意外退出".to_string())?;
            let message: Value = serde_json::from_str(&line)
                .map_err(|error| format!("Codex app-server 返回了无效数据：{error}"))?;
            if message.get("id").and_then(Value::as_i64) != Some(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                let detail = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("未知错误");
                return Err(format!("Codex app-server 调用 {method} 失败：{detail}"));
            }
            return message
                .get("result")
                .cloned()
                .ok_or_else(|| format!("Codex app-server 调用 {method} 缺少结果"));
        }
    }

    async fn notify(&mut self, method: &str, params: Option<Value>) -> Result<(), String> {
        let mut request = json!({ "method": method });
        if let Some(params) = params {
            request["params"] = params;
        }
        self.send(&request).await
    }

    async fn wait_for_login_completed(&mut self, login_id: &str) -> Result<(), String> {
        let deadline = tokio::time::Instant::now() + LOGIN_TIMEOUT;
        loop {
            let line = tokio::time::timeout_at(deadline, self.stdout.next_line())
                .await
                .map_err(|_| "等待 Codex 账号授权超时，请重试".to_string())?
                .map_err(|error| format!("读取 Codex 登录结果失败：{error}"))?
                .ok_or_else(|| "Codex app-server 在登录完成前意外退出".to_string())?;
            let message: Value = serde_json::from_str(&line)
                .map_err(|error| format!("Codex app-server 返回了无效登录结果：{error}"))?;
            let Some(result) = parse_login_completed(&message, login_id) else {
                continue;
            };
            return result;
        }
    }

    async fn send(&mut self, value: &Value) -> Result<(), String> {
        let mut message = serde_json::to_vec(value)
            .map_err(|error| format!("生成 Codex app-server 请求失败：{error}"))?;
        message.push(b'\n');
        self.stdin
            .write_all(&message)
            .await
            .map_err(|error| format!("写入 Codex app-server 请求失败：{error}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|error| format!("刷新 Codex app-server 请求失败：{error}"))
    }

    async fn stop(&mut self) {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
    }
}

fn parse_login_completed(message: &Value, expected_login_id: &str) -> Option<Result<(), String>> {
    if message.get("method").and_then(Value::as_str) != Some("account/login/completed") {
        return None;
    }
    let params = message.get("params")?;
    if params.get("loginId").and_then(Value::as_str) != Some(expected_login_id) {
        return None;
    }
    if params.get("success").and_then(Value::as_bool) == Some(true) {
        Some(Ok(()))
    } else {
        let detail = params
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("未知错误");
        Some(Err(format!("Codex 账号授权失败：{detail}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_usage_window() {
        assert_eq!(
            parse_usage_window(&json!({
                "usedPercent": 24.5,
                "windowDurationMins": 300,
                "resetsAt": 1_779_459_394_i64
            })),
            Some(CodexUsageWindow {
                used_percent: 24.5,
                window_duration_mins: 300,
                resets_at: 1_779_459_394,
            })
        );
    }

    #[test]
    fn app_server_account_read_forces_token_refresh() {
        assert_eq!(
            account_read_params()
                .get("refreshToken")
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn parses_browser_login_start_and_completion() {
        assert_eq!(
            parse_login_start(&json!({
                "type": "chatgpt",
                "loginId": "login-1",
                "authUrl": "https://chatgpt.com/auth"
            })),
            Ok((
                "login-1".to_string(),
                "https://chatgpt.com/auth".to_string()
            ))
        );
        assert_eq!(
            parse_login_completed(
                &json!({
                    "method": "account/login/completed",
                    "params": { "loginId": "login-1", "success": true, "error": null }
                }),
                "login-1"
            ),
            Some(Ok(()))
        );
        assert!(parse_login_completed(
            &json!({
                "method": "account/login/completed",
                "params": { "loginId": "another-login", "success": true }
            }),
            "login-1"
        )
        .is_none());
    }

    #[test]
    fn parses_string_and_numeric_credit_balances() {
        assert_eq!(
            parse_credits(&json!({
                "hasCredits": true,
                "unlimited": false,
                "balance": "12.50"
            })),
            Some(CodexCredits {
                has_credits: true,
                unlimited: false,
                balance: Some("12.50".to_string()),
            })
        );
        assert_eq!(
            parse_credits(&json!({
                "hasCredits": true,
                "unlimited": false,
                "balance": 8
            }))
            .and_then(|credits| credits.balance),
            Some("8".to_string())
        );
    }

    #[test]
    fn parses_rate_limit_reset_credits_and_expiration() {
        assert_eq!(
            parse_rate_limit_reset_credits(&json!({
                "availableCount": 2,
                "credits": [{
                    "id": "RateLimitResetCredit_1",
                    "resetType": "codexRateLimits",
                    "status": "available",
                    "grantedAt": 1781654400_i64,
                    "expiresAt": 1784246400_i64,
                    "title": "Full reset",
                    "description": "Ready to redeem"
                }]
            })),
            Some(CodexRateLimitResetCredits {
                available_count: 2,
                credits: Some(vec![CodexRateLimitResetCredit {
                    id: "RateLimitResetCredit_1".to_string(),
                    reset_type: Some("codexRateLimits".to_string()),
                    status: Some("available".to_string()),
                    granted_at: Some(1781654400),
                    expires_at: Some(1784246400),
                    title: Some("Full reset".to_string()),
                    description: Some("Ready to redeem".to_string()),
                }]),
            })
        );
        assert_eq!(
            parse_rate_limit_reset_credits(&json!({
                "available_count": 1,
                "credits": null
            })),
            Some(CodexRateLimitResetCredits {
                available_count: 1,
                credits: None,
            })
        );
    }

    #[test]
    fn parses_oauth_usage_response() {
        let report = parse_oauth_usage(
            &json!({
                "account_id": "account-1",
                "email": "user@example.com",
                "plan_type": "plus",
                "rate_limit": {
                    "primary_window": {
                        "used_percent": 22,
                        "limit_window_seconds": 604800,
                        "reset_at": 1784952500_i64
                    },
                    "secondary_window": null
                },
                "credits": {
                    "has_credits": true,
                    "unlimited": false,
                    "balance": "10.5"
                },
                "rate_limit_reset_credits": {
                    "available_count": 1,
                    "credits": [{
                        "id": "RateLimitResetCredit_1",
                        "reset_type": "codex_rate_limits",
                        "status": "available",
                        "granted_at": 1781654400_i64,
                        "expires_at": 1784246400_i64
                    }]
                },
                "rate_limit_reached_type": null
            }),
            None,
        )
        .expect("parse OAuth usage");

        assert_eq!(report.account_id, "account-1");
        assert_eq!(report.email.as_deref(), Some("user@example.com"));
        assert_eq!(report.plan_type.as_deref(), Some("plus"));
        assert_eq!(
            report
                .primary
                .as_ref()
                .map(|window| window.window_duration_mins),
            Some(10080)
        );
        assert_eq!(
            report
                .credits
                .and_then(|credits| credits.balance)
                .as_deref(),
            Some("10.5")
        );
        assert_eq!(report.source, "oauth");
        assert_eq!(
            report
                .rate_limit_reset_credits
                .and_then(|credits| credits.credits)
                .and_then(|credits| credits.first().and_then(|credit| credit.expires_at)),
            Some(1784246400)
        );
    }

    #[test]
    fn persists_independent_managed_profile_and_snapshot() {
        let root =
            std::env::temp_dir().join(format!("flowlet-codex-accounts-{}", uuid::Uuid::new_v4()));
        let auth = json!({
            "tokens": { "account_id": "account-1", "access_token": "test-secret" }
        });
        let report = parse_oauth_usage(
            &json!({
                "account_id": "account-1",
                "email": "one@example.com",
                "plan_type": "plus"
            }),
            None,
        )
        .expect("parse report");

        persist_managed_profile(&root, &auth, &report).expect("persist profile");
        persist_managed_profile(&root, &auth, &report).expect("replace existing profile");
        let profile = root.join("account-1");
        assert_eq!(
            read_json(&profile.join("auth.json"))
                .expect("read auth")
                .pointer("/tokens/account_id")
                .and_then(Value::as_str),
            Some("account-1")
        );
        assert_eq!(
            read_snapshot(&profile.join("snapshot.json"))
                .expect("read snapshot")
                .email
                .as_deref(),
            Some("one@example.com")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn deduplicates_current_and_managed_copy_by_canonical_account_id() {
        let mut current = parse_oauth_usage(
            &json!({
                "account_id": "user-1",
                "email": "same@example.com",
                "plan_type": "plus"
            }),
            Some("workspace-hint"),
        )
        .expect("parse current account");
        current.is_current = true;
        let managed = current.clone();
        let mut accounts = vec![current, managed];

        deduplicate_accounts(&mut accounts);

        assert_eq!(accounts.len(), 1);
        assert!(accounts[0].is_current);
    }

    #[tokio::test]
    #[ignore = "requires a locally installed and signed-in Codex app"]
    async fn queries_live_codex_account() {
        let report = query_current_codex_account()
            .await
            .expect("query local Codex app-server");
        assert!(report.signed_in);
        assert!(report.auth_mode.is_some());
    }
}
