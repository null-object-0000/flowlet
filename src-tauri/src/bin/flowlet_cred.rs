//! `flowlet-cred`：Flowlet 全局凭据库的命令行入口。
//!
//! 设计目标：让 Agent 能以最小权限读写三方服务凭据。
//! - 读取：`cat` 凭据文件，或 `flowlet-cred get`、`flowlet-cred run`
//! - 写入：只能经由本 CLI（原子写、0600、键名校验）
//! - 三方服务适配：目前内置 GitLab API v4（按 GitLab CE 10.8.7 实测）
//!
//! 详细约定见 `docs/credential-cli.md` 与 `.agents/skills/flowlet-credentials/SKILL.md`。

use flowlet_lib::core::credential_store::{CredentialStore, ExportFormat};
use flowlet_lib::core::gitlab::{normalize_base_url, GitlabClient, ProjectSummary};
use flowlet_lib::core::service_credentials::{env_keys, ServiceCredentialExport};
use std::io::Read;
use std::process::{Command, ExitCode};

const GITLAB_URL_KEY: &str = "GITLAB_URL";
const GITLAB_TOKEN_KEY: &str = "GITLAB_TOKEN";

const USAGE: &str = "\
flowlet-cred — Flowlet 全局凭据库

用法：
  flowlet-cred init                              初始化凭据目录
  flowlet-cred path                              打印凭据文件路径
  flowlet-cred list [--json]                     列出凭据名（永不含明文值）
  flowlet-cred get <KEY> [--mask]                输出单个凭据值
  flowlet-cred set <KEY> [--kind=K] [--note=N]   新增/更新（值从 stdin 读取，或 --value=V）
  flowlet-cred unset <KEY>                       删除
  flowlet-cred env [--only=A,B]                  输出 dotenv，可 eval/写入其它 .env
  flowlet-cred export [--only=A,B] [--format=dotenv|shell|json]
  flowlet-cred run --with=A,B -- <程序> [参数...]  只把指定凭据注入子进程环境
  flowlet-cred doctor                            检查权限、重复键与元数据

GitLab（API v4，按 GitLab CE 10.8.7 实现）：
  flowlet-cred gitlab set --url=https://gitlab.example.com     token 从 stdin 读取并校验
  flowlet-cred gitlab status [--insecure]                       用户、版本、API 地址
  flowlet-cred gitlab projects [--search=S] [--limit=N] [--all] [--json]
  flowlet-cred gitlab api <METHOD> <PATH> [--data=JSON]         透传 10.8 已存在的端点
  flowlet-cred gitlab env                                       输出 GITLAB_URL / GITLAB_TOKEN
  flowlet-cred gitlab clear                                     移除 GitLab 凭据

远程同步（Docker / 服务端管理的凭据 → 本机 .env）：
  flowlet-cred pull --server=http://10.100.217.60:20134 [--token=管理凭据]
  flowlet-cred pull --server=... --dry-run                       只显示将要写入的键名

说明：
  - 值永远不会被 list 打印；set 时建议通过 stdin 传值，避免出现在进程列表里。
  - `run` 是推荐用法：Agent 不需要看到明文，只要让命令用上凭据。
  - 凭据类型（--kind）目前只是标签，默认 api_key。
";

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let Some(command) = args.next() else {
        print!("{USAGE}");
        return Ok(());
    };
    let rest: Vec<String> = args.collect();
    match command.as_str() {
        "-h" | "--help" | "help" => {
            print!("{USAGE}");
            Ok(())
        }
        "-V" | "--version" | "version" => {
            println!("flowlet-cred {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        "init" => {
            let store = open_store()?;
            store.init()?;
            println!("已初始化：{}", store.env_path().display());
            Ok(())
        }
        "path" => {
            let store = open_store()?;
            println!("{}", store.env_path().display());
            Ok(())
        }
        "list" => {
            let store = open_store()?;
            let json = flag_present(&rest, "--json");
            let entries = store.list()?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&entries)
                        .map_err(|error| format!("序列化失败：{error}"))?
                );
            } else if entries.is_empty() {
                println!("（暂无凭据）");
            } else {
                for entry in entries {
                    let note = entry
                        .note
                        .as_deref()
                        .map(|value| format!("  # {value}"))
                        .unwrap_or_default();
                    let updated = if entry.updated_at.is_empty() {
                        String::new()
                    } else {
                        format!("  ({})", entry.updated_at)
                    };
                    println!("{}  [{}]{note}{updated}", entry.key, entry.kind);
                }
            }
            Ok(())
        }
        "get" => {
            let key = positional(&rest, 0)?;
            let store = open_store()?;
            let value = store
                .get(&key)?
                .ok_or_else(|| format!("凭据不存在：{key}"))?;
            if flag_present(&rest, "--mask") {
                println!("{}", mask(&value));
            } else {
                println!("{value}");
            }
            Ok(())
        }
        "set" => {
            let key = positional(&rest, 0)?;
            let value = match option_value(&rest, "--value") {
                Some(value) => value,
                None => read_stdin_value()?,
            };
            if value.is_empty() {
                return Err("凭据值不能为空（用 stdin 或 --value=V 传入）".to_string());
            }
            let store = open_store()?;
            let entry = store.set(
                &key,
                &value,
                option_value(&rest, "--kind").as_deref(),
                option_value(&rest, "--note").as_deref(),
            )?;
            println!("已保存 {} [{}]", entry.key, entry.kind);
            Ok(())
        }
        "unset" | "rm" => {
            let key = positional(&rest, 0)?;
            let store = open_store()?;
            if store.unset(&key)? {
                println!("已删除 {key}");
            } else {
                println!("凭据不存在：{key}");
            }
            Ok(())
        }
        "env" => {
            let store = open_store()?;
            let only = option_value(&rest, "--only")
                .map(|value| parse_key_list(&value))
                .unwrap_or_default();
            print!("{}", store.export(&only, ExportFormat::Dotenv)?);
            Ok(())
        }
        "export" => {
            let store = open_store()?;
            let only = option_value(&rest, "--only")
                .map(|value| parse_key_list(&value))
                .unwrap_or_default();
            let format = match option_value(&rest, "--format").as_deref() {
                None | Some("dotenv") => ExportFormat::Dotenv,
                Some("shell") => ExportFormat::Shell,
                Some("json") => ExportFormat::Json,
                Some(other) => return Err(format!("未知格式：{other}（dotenv|shell|json）")),
            };
            print!("{}", store.export(&only, format)?);
            Ok(())
        }
        "run" => {
            let (keys, command) = parse_run_args(&rest)?;
            let store = open_store()?;
            let mut child = Command::new(&command[0]);
            child.args(&command[1..]);
            for key in &keys {
                let value = store
                    .get(key)?
                    .ok_or_else(|| format!("凭据不存在：{key}"))?;
                child.env(key, value);
            }
            let status = child
                .status()
                .map_err(|error| format!("启动子进程失败：{error}"))?;
            std::process::exit(status.code().unwrap_or(1));
        }
        "doctor" => {
            let store = open_store()?;
            for line in store.doctor()? {
                println!("{line}");
            }
            Ok(())
        }
        "pull" => pull_command(&rest).await,
        "gitlab" => gitlab_command(&rest).await,
        other => Err(format!("未知命令：{other}\n\n{USAGE}")),
    }
}

// ─── 远程同步 ───────────────────────────────────────────────────────────────

/// 从 Flowlet Web Host 的管理接口拉取服务凭据，写成本机 dotenv。
/// 服务端只返回启用中的凭据；本机写入走 `CredentialStore`（原子写 + 0600）。
async fn pull_command(args: &[String]) -> Result<(), String> {
    let server = option_value(args, "--server")
        .ok_or_else(|| "pull 需要 --server=http://<flowlet-web-host>:<port>".to_string())?;
    let server = server.trim_end_matches('/').to_string();
    if !(server.starts_with("http://") || server.starts_with("https://")) {
        return Err("--server 必须是 http 或 https 地址".to_string());
    }
    let token = match option_value(args, "--token") {
        Some(token) => token,
        None => std::env::var("FLOWLET_ADMIN_TOKEN")
            .map_err(|_| "缺少管理凭据：用 --token=... 或设置 FLOWLET_ADMIN_TOKEN".to_string())?,
    };
    let insecure = flag_present(args, "--insecure");
    let dry_run = flag_present(args, "--dry-run");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .danger_accept_invalid_certs(insecure)
        .build()
        .map_err(|error| format!("创建 HTTP 客户端失败：{error}"))?;
    let url = format!("{server}/api/commands/export_service_credentials");
    let response = client
        .post(&url)
        .bearer_auth(&token)
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|error| format!("请求 {url} 失败：{error}（内网自签证书请加 --insecure）"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取响应失败：{error}"))?;
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("管理凭据无效（401）：请检查 --token / FLOWLET_ADMIN_TOKEN".to_string());
    }
    if !status.is_success() {
        return Err(format!("拉取失败（{status}）：{text}"));
    }
    let entries: Vec<ServiceCredentialExport> =
        serde_json::from_str(&text).map_err(|error| format!("解析服务端响应失败：{error}"))?;
    if entries.is_empty() {
        println!("服务端没有启用中的服务凭据");
        return Ok(());
    }
    let store = open_store()?;
    let mut written = 0usize;
    for entry in &entries {
        let pairs = env_keys(entry);
        if pairs.is_empty() {
            eprintln!("跳过未知服务类型：{}（{}）", entry.provider, entry.name);
            continue;
        }
        for (key, value, kind) in pairs {
            if dry_run {
                println!("将写入 {key}（来自 {} / {}）", entry.provider, entry.name);
                continue;
            }
            store.set(
                &key,
                &value,
                Some(kind),
                Some(&format!("{} / {}", entry.provider, entry.name)),
            )?;
            println!("已写入 {key}（来自 {} / {}）", entry.provider, entry.name);
            written += 1;
        }
    }
    if dry_run {
        println!("dry-run：未写入任何凭据");
    } else {
        println!("完成：写入 {written} 个键 → {}", store.env_path().display());
    }
    Ok(())
}

// ─── GitLab ─────────────────────────────────────────────────────────────────

async fn gitlab_command(args: &[String]) -> Result<(), String> {
    let sub = positional(args, 0)?;
    let insecure = flag_present(args, "--insecure");
    match sub.as_str() {
        "set" => gitlab_set(args, insecure).await,
        "status" => gitlab_status(insecure).await,
        "projects" => gitlab_projects(args, insecure).await,
        "api" => gitlab_api(args, insecure).await,
        "env" => {
            let store = open_store()?;
            let url = stored_gitlab_url(&store)?.ok_or_else(|| {
                "尚未配置 GitLab 地址，先运行 flowlet-cred gitlab set --url=...".to_string()
            })?;
            let token = stored_gitlab_token(&store)?.ok_or_else(|| {
                "尚未保存 GitLab token，先运行 flowlet-cred gitlab set --url=...".to_string()
            })?;
            eprintln!("注意：下面输出包含明文 token，只应在可信 shell 中使用。");
            println!("GITLAB_URL={url}");
            println!("GITLAB_TOKEN={token}");
            Ok(())
        }
        "clear" => {
            let store = open_store()?;
            let url_removed = store.unset(GITLAB_URL_KEY)?;
            let token_removed = store.unset(GITLAB_TOKEN_KEY)?;
            if url_removed || token_removed {
                println!("已移除 GitLab 凭据");
            } else {
                println!("没有可移除的 GitLab 凭据");
            }
            Ok(())
        }
        other => Err(format!(
            "未知的 gitlab 子命令：{other}（set|status|projects|api|env|clear）"
        )),
    }
}

async fn gitlab_set(args: &[String], insecure: bool) -> Result<(), String> {
    let store = open_store()?;
    let url = option_value(args, "--url")
        .or_else(|| stored_gitlab_url(&store).ok().flatten())
        .ok_or_else(|| {
            "缺少 --url，例如：flowlet-cred gitlab set --url=https://gitlab.example.com".to_string()
        })?;
    let token = read_stdin_value()?;
    if token.is_empty() {
        return Err(
            "GitLab token 不能为空：用 `printf '%s' \"$TOKEN\" | flowlet-cred gitlab set ...`"
                .to_string(),
        );
    }
    let client = GitlabClient::new(&url, &token)?.with_insecure(insecure);
    // 先验证再落库：避免把不可用的 token 写进全局凭据库。
    let user = client.current_user().await.map_err(|error| {
        format!("{error}\n未保存。请检查实例地址、token 是否有效（需要 api scope）。")
    })?;
    let base = normalize_base_url(&url)?;
    store.set(
        GITLAB_URL_KEY,
        &base,
        Some("service"),
        Some("gitlab 实例地址（API v4）"),
    )?;
    store.set(
        GITLAB_TOKEN_KEY,
        &token,
        Some("cli_token"),
        Some("gitlab personal access token"),
    )?;
    println!("已保存 GitLab 凭据：{}", client.api_base());
    println!("{}", describe_user(&user));
    Ok(())
}

async fn gitlab_status(insecure: bool) -> Result<(), String> {
    let client = stored_gitlab_client(insecure)?;
    let user = client
        .current_user()
        .await
        .map_err(|error| error.to_string())?;
    println!("API：{}", client.api_base());
    println!("{}", describe_user(&user));
    match client.version().await.map_err(|error| error.to_string())? {
        Some(version) => {
            println!("版本：{version}");
            if !version.starts_with("10.8") {
                println!(
                    "提示：当前按 GitLab CE 10.8.7 实现；实例版本是 {version}，若有接口差异请用 `gitlab api` 验证。"
                );
            }
        }
        None => println!("版本：未知（/version 需要管理员 token；不影响 10.8 其它接口）"),
    }
    Ok(())
}

async fn gitlab_projects(args: &[String], insecure: bool) -> Result<(), String> {
    let client = stored_gitlab_client(insecure)?;
    let search = option_value(args, "--search");
    let limit = option_value(args, "--limit")
        .map(|value| {
            value
                .parse::<usize>()
                .map_err(|_| "--limit 需要整数".to_string())
        })
        .transpose()?
        .unwrap_or(20);
    let membership = !flag_present(args, "--all");
    let projects = client
        .projects(search.as_deref(), membership, limit)
        .await
        .map_err(|error| error.to_string())?;
    if flag_present(args, "--json") {
        println!(
            "{}",
            serde_json::to_string_pretty(&projects)
                .map_err(|error| format!("序列化失败：{error}"))?
        );
        return Ok(());
    }
    if projects.is_empty() {
        println!("（没有匹配的项目）");
        return Ok(());
    }
    for project in &projects {
        println!("{}", describe_project(project));
    }
    Ok(())
}

async fn gitlab_api(args: &[String], insecure: bool) -> Result<(), String> {
    let first = positional(args, 1)?;
    // `gitlab api /projects` 与 `gitlab api GET /projects` 都接受。
    let (method, path) = if first.starts_with('/') {
        ("GET".to_string(), first)
    } else {
        (first.to_uppercase(), positional(args, 2)?)
    };
    let body = match option_value(args, "--data") {
        Some(raw) => Some(
            serde_json::from_str::<serde_json::Value>(&raw)
                .map_err(|error| format!("--data 不是合法 JSON：{error}"))?,
        ),
        None => None,
    };
    let client = stored_gitlab_client(insecure)?;
    let (value, pagination) = client
        .request(&method, &path, body.as_ref())
        .await
        .map_err(|error| error.to_string())?;
    println!(
        "{}",
        serde_json::to_string_pretty(&value).map_err(|error| format!("序列化失败：{error}"))?
    );
    if pagination.next_page.is_some() || pagination.total.is_some() {
        eprintln!(
            "分页：page={:?} next={:?} total={:?}",
            pagination.page, pagination.next_page, pagination.total
        );
    }
    Ok(())
}

fn stored_gitlab_url(store: &CredentialStore) -> Result<Option<String>, String> {
    Ok(store
        .get(GITLAB_URL_KEY)?
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()))
}

fn stored_gitlab_token(store: &CredentialStore) -> Result<Option<String>, String> {
    Ok(store
        .get(GITLAB_TOKEN_KEY)?
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()))
}

fn stored_gitlab_client(insecure: bool) -> Result<GitlabClient, String> {
    let store = open_store()?;
    let url = stored_gitlab_url(&store)?.ok_or_else(|| {
        "尚未配置 GitLab 地址，先运行 flowlet-cred gitlab set --url=https://gitlab.example.com"
            .to_string()
    })?;
    let token = stored_gitlab_token(&store)?.ok_or_else(|| {
        "尚未保存 GitLab token，先运行 flowlet-cred gitlab set --url=https://gitlab.example.com"
            .to_string()
    })?;
    GitlabClient::new(&url, &token).map(|client| client.with_insecure(insecure))
}

fn describe_user(value: &serde_json::Value) -> String {
    let username = value
        .get("username")
        .and_then(|item| item.as_str())
        .unwrap_or("unknown");
    let name = value
        .get("name")
        .and_then(|item| item.as_str())
        .unwrap_or("");
    let id = value
        .get("id")
        .and_then(|item| item.as_i64())
        .map(|id| format!(" id={id}"))
        .unwrap_or_default();
    if name.is_empty() {
        format!("用户：@{username}{id}")
    } else {
        format!("用户：{name} (@{username}){id}")
    }
}

fn describe_project(project: &ProjectSummary) -> String {
    let branch = project
        .default_branch
        .as_deref()
        .map(|value| format!("  {value}"))
        .unwrap_or_default();
    let visibility = project
        .visibility
        .as_deref()
        .map(|value| format!("  {value}"))
        .unwrap_or_default();
    format!(
        "{:>8}  {}{}{}",
        project.id, project.path_with_namespace, branch, visibility
    )
}

// ─── 通用 ───────────────────────────────────────────────────────────────────

fn open_store() -> Result<CredentialStore, String> {
    CredentialStore::from_default_dir()
}

fn positional(args: &[String], index: usize) -> Result<String, String> {
    args.iter()
        .filter(|arg| !arg.starts_with("-"))
        .nth(index)
        .cloned()
        .ok_or_else(|| "缺少参数".to_string())
}

fn flag_present(args: &[String], flag: &str) -> bool {
    args.iter().any(|arg| arg == flag)
}

/// 支持 `--name=value` 与 `--name value` 两种写法。
fn option_value(args: &[String], name: &str) -> Option<String> {
    let prefix = format!("{name}=");
    for (index, arg) in args.iter().enumerate() {
        if let Some(value) = arg.strip_prefix(&prefix) {
            return Some(value.to_string());
        }
        if arg == name {
            return args.get(index + 1).cloned();
        }
    }
    None
}

fn parse_key_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

/// `run --with=A,B -- cmd ...`；`--` 之后全部视为要执行的命令。
fn parse_run_args(args: &[String]) -> Result<(Vec<String>, Vec<String>), String> {
    let keys = option_value(args, "--with")
        .ok_or_else(|| "run 需要 --with=A,B 指定要注入的凭据名".to_string())?;
    let keys = parse_key_list(&keys);
    if keys.is_empty() {
        return Err("--with 至少需要一个凭据名".to_string());
    }
    let command = match args.iter().position(|arg| arg == "--") {
        Some(index) => args[index + 1..].to_vec(),
        None => {
            return Err(
                "run 需要 `--` 分隔符，例如：flowlet-cred run --with=GITHUB_PAT -- gh pr list"
                    .to_string(),
            )
        }
    };
    if command.is_empty() {
        return Err(
            "run 需要指定要执行的命令，例如：flowlet-cred run --with=GITHUB_PAT -- gh pr list"
                .to_string(),
        );
    }
    Ok((keys, command))
}

fn read_stdin_value() -> Result<String, String> {
    let mut buffer = String::new();
    std::io::stdin()
        .read_to_string(&mut buffer)
        .map_err(|error| format!("读取 stdin 失败：{error}"))?;
    Ok(buffer.trim_end_matches(['\r', '\n']).to_string())
}

fn mask(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= 8 {
        return "•".repeat(chars.len().min(8));
    }
    let head: String = chars.iter().take(4).collect();
    let tail: String = chars.iter().skip(chars.len() - 4).collect();
    format!("{head}…{tail}")
}
