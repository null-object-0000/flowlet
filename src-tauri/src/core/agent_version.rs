//! Agent 最新版本查询。
//!
//! 从 npm registry 拉取 Flowlet 注册的 Agent
//! 的最新发布版本，供前端在概览页与接入抽屉中提示「有新版可用」。
//!
//! 职责边界：只做「提示」——返回最新版本号与检查时间，不执行任何下载或升级；
//! 各 Agent 独立失败并返回 error，不影响其余 Agent 与整体 UI。
//! 产品判断（已安装版本 vs 最新版本、是否展示 Badge dot）由前端完成。

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// 版本检查请求超时：单个 Agent 失败不应拖垮整体检查。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
/// 版本缓存 TTL：npm 版本不会高频变化，避免概览页每次渲染都请求 registry。
const CACHE_TTL_SECS: u64 = 15 * 60;

/// agent_id → npm 包名（与 `detect_agent_environment` 支持的 Agent 保持一致）。
pub fn npm_package_for(agent_id: &str) -> Option<&'static str> {
    super::plugin_registry::plugin_registry()
        .agent(agent_id)
        .map(|agent| agent.npm_package.as_str())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AgentLatestVersionReport {
    pub agent_id: String,
    /// npm 包名；不支持的 agent_id 为空字符串。
    pub package: String,
    /// 最新发布版本（如 2.1.221）；查询失败时为 None。
    pub latest_version: Option<String>,
    /// 本次检查的 Unix 时间戳（秒）。
    pub checked_at: u64,
    /// 该 Agent 查询失败的原因；成功时为 None。
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AgentLatestVersionsReport {
    pub agents: Vec<AgentLatestVersionReport>,
}

#[derive(Clone, Debug)]
struct CachedEntry {
    version: Option<String>,
    error: Option<String>,
    checked_at: u64,
    fetched_at: Instant,
}

fn cache() -> &'static Mutex<HashMap<String, CachedEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// 并行检查所有受支持 Agent 的最新版本（带进程内 TTL 缓存）。
pub async fn check_agent_latest_versions() -> Result<AgentLatestVersionsReport, String> {
    let agents = futures_util::future::join_all(
        super::plugin_registry::plugin_registry()
            .agents()
            .iter()
            .map(|agent| check_one(&agent.id)),
    )
    .await;
    Ok(AgentLatestVersionsReport { agents })
}

async fn check_one(agent_id: &str) -> AgentLatestVersionReport {
    let package = match npm_package_for(agent_id) {
        Some(package) => package,
        None => {
            return AgentLatestVersionReport {
                agent_id: agent_id.to_string(),
                package: String::new(),
                latest_version: None,
                checked_at: 0,
                error: Some(format!("不支持的 Agent：{agent_id}")),
            };
        }
    };

    if let Some(entry) = read_cache(agent_id) {
        if entry.fetched_at.elapsed().as_secs() < CACHE_TTL_SECS {
            return AgentLatestVersionReport {
                agent_id: agent_id.to_string(),
                package: package.to_string(),
                latest_version: entry.version,
                checked_at: entry.checked_at,
                error: entry.error,
            };
        }
    }

    let (version, error) = match fetch_latest_version(package).await {
        Ok(version) => (Some(version), None),
        Err(message) => (None, Some(message)),
    };
    let checked_at = unix_now();
    write_cache(
        agent_id,
        CachedEntry {
            version: version.clone(),
            error: error.clone(),
            checked_at,
            fetched_at: Instant::now(),
        },
    );

    AgentLatestVersionReport {
        agent_id: agent_id.to_string(),
        package: package.to_string(),
        latest_version: version,
        checked_at,
        error,
    }
}

fn read_cache(agent_id: &str) -> Option<CachedEntry> {
    cache()
        .lock()
        .ok()
        .and_then(|guard| guard.get(agent_id).cloned())
}

fn write_cache(agent_id: &str, entry: CachedEntry) {
    if let Ok(mut guard) = cache().lock() {
        guard.insert(agent_id.to_string(), entry);
    }
}

async fn fetch_latest_version(package: &str) -> Result<String, String> {
    let url = format!("https://registry.npmjs.org/{package}/latest");
    let response = reqwest::Client::new()
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(
            reqwest::header::USER_AGENT,
            "Flowlet/0.1.0 (agent version check)",
        )
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("版本检查请求失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("版本源返回 HTTP {}", response.status()));
    }
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("版本源返回了无效数据：{error}"))?;
    let version = value
        .get("version")
        .and_then(serde_json::Value::as_str)
        .filter(|version| !version.is_empty())
        .ok_or_else(|| "版本源缺少 version 字段".to_string())?;
    Ok(version.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npm_package_for_maps_supported_agents() {
        assert_eq!(
            npm_package_for("claude-code"),
            Some("@anthropic-ai/claude-code")
        );
        assert_eq!(npm_package_for("opencode"), Some("opencode-ai"));
        assert_eq!(
            npm_package_for("pi"),
            Some("@earendil-works/pi-coding-agent")
        );
        assert_eq!(npm_package_for("codex"), Some("@openai/codex"));
        assert_eq!(
            npm_package_for("deepseek-harness"),
            Some("@deepseek-ai/dsh")
        );
        assert_eq!(npm_package_for("unknown"), None);
    }
}
