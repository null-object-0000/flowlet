//! Uptime Kuma 只读客户端（面向上游 2.5.9 与公司子路径部署实测）。
//!
//! 选择面：
//! - 2.x 没有监控管理 REST API；API Key 只用于 Prometheus `/metrics` 鉴权，
//!   Basic 认证用户名为空、密码为 API Key（即 `Basic base64(":" + key)`）；
//! - 校验必须走 `/metrics`：401 说明 Key 无效；`disableAuth=true` 的实例可能匿名 200，
//!   这种配置下无法从响应判断 Key 真伪（见 docs/credential-cli.md）；
//! - 实例可能部署在子路径（`https://host/uptime-kuma`），地址归一保留子路径；
//! - 用户常直接粘贴前端路由地址（`.../uptime-kuma/#/settings/api-keys`），
//!   fragment 不是服务端路径，归一里丢掉；
//! - 凭据不跟随重定向，避免把 API Key 发到别处。

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);
pub const METRICS_PATH: &str = "/metrics";

#[derive(Debug, Clone)]
pub struct UptimeKumaError {
    pub status: Option<u16>,
    pub message: String,
}

impl std::fmt::Display for UptimeKumaError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.status {
            Some(status) => write!(formatter, "Uptime Kuma API {status}: {}", self.message),
            None => write!(formatter, "Uptime Kuma API: {}", self.message),
        }
    }
}

impl std::error::Error for UptimeKumaError {}

/// 单个监控项的最小投影：只保留定位与状态，避免把整份指标塞进 Agent 上下文。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MonitorStatus {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub monitor_type: String,
    pub up: bool,
}

/// `/metrics` 的投影：样本数、监控状态、内部构建版本。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct KumaMetrics {
    pub samples: usize,
    pub monitors: Vec<MonitorStatus>,
    pub version: Option<String>,
}

impl KumaMetrics {
    pub fn up_count(&self) -> usize {
        self.monitors.iter().filter(|monitor| monitor.up).count()
    }

    pub fn down_count(&self) -> usize {
        self.monitors.iter().filter(|monitor| !monitor.up).count()
    }

    /// 界面 toast / CLI 摘要：`54 个监控（54 正常 / 0 异常）`。
    pub fn summarize(&self) -> String {
        format!(
            "{} 个监控（{} 正常 / {} 异常）",
            self.monitors.len(),
            self.up_count(),
            self.down_count()
        )
    }
}

/// 规范化实例地址：
/// - 必须是 http/https；
/// - 丢弃 fragment（前端路由 `#/settings/api-keys` 不是服务端路径）；
/// - 拒绝 query 与账号密码；
/// - 去掉末尾所有 `/`，再去掉末尾 `/metrics`；
/// - 保留子路径部署（`https://host/uptime-kuma`）。
pub fn normalize_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Uptime Kuma 地址不能为空".to_string());
    }
    let mut parsed =
        url::Url::parse(trimmed).map_err(|error| format!("Uptime Kuma 地址无法解析：{error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Uptime Kuma 地址必须以 http:// 或 https:// 开头".to_string());
    }
    if parsed.query().is_some() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Uptime Kuma 地址不能带查询参数或账号密码".to_string());
    }
    parsed.set_fragment(None);
    let mut base = parsed.as_str().trim_end_matches('/').to_string();
    if let Some(stripped) = base.strip_suffix(METRICS_PATH) {
        base = stripped.trim_end_matches('/').to_string();
    }
    if base.is_empty() || parsed.host_str().is_none() {
        return Err("Uptime Kuma 地址缺少主机名".to_string());
    }
    Ok(base)
}

pub fn metrics_url(base: &str) -> String {
    format!("{base}{METRICS_PATH}")
}

/// `/metrics` 的 `Authorization` 头：用户名为空、密码为 API Key。
pub fn authorization_header(token: &str) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(format!(":{token}"));
    format!("Basic {encoded}")
}

#[derive(Debug)]
pub struct UptimeKumaClient {
    base: String,
    token: String,
    insecure: bool,
}

impl UptimeKumaClient {
    pub fn new(url: &str, token: &str) -> Result<Self, String> {
        if token.trim().is_empty() {
            return Err("Uptime Kuma API Key 不能为空".to_string());
        }
        Ok(Self {
            base: normalize_base_url(url)?,
            token: token.trim().to_string(),
            insecure: false,
        })
    }

    pub fn with_insecure(mut self, insecure: bool) -> Self {
        self.insecure = insecure;
        self
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    pub fn metrics_url(&self) -> String {
        metrics_url(&self.base)
    }

    fn build_client(&self) -> Result<reqwest::Client, String> {
        reqwest::Client::builder()
            .timeout(DEFAULT_TIMEOUT)
            .danger_accept_invalid_certs(self.insecure)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(format!("flowlet/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| format!("创建 HTTP 客户端失败：{error}"))
    }

    /// 拉取 `/metrics` 原始文本；认证、内容类型与状态码在这里统一收口。
    pub async fn fetch_metrics_text(&self) -> Result<String, UptimeKumaError> {
        let url = self.metrics_url();
        let client = self.build_client().map_err(|message| UptimeKumaError {
            status: None,
            message,
        })?;
        let response = client
            .get(&url)
            .header("Authorization", authorization_header(&self.token))
            .header("Accept", "text/plain")
            .send()
            .await
            .map_err(|error| UptimeKumaError {
                status: None,
                message: format!(
                    "请求 {url} 失败：{error}（内网自签证书请配置可信 CA 或使用 --insecure）"
                ),
            })?;
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        let text = response.text().await.map_err(|error| UptimeKumaError {
            status: Some(status),
            message: format!("读取 {url} 响应失败：{error}"),
        })?;

        if (300..400).contains(&status) {
            return Err(UptimeKumaError {
                status: Some(status),
                message: format!(
                    "{url} 返回重定向（HTTP {status}）：请直接填写最终地址；凭据不会跟随重定向"
                ),
            });
        }
        if status == 401 || status == 403 {
            return Err(UptimeKumaError {
                status: Some(status),
                message: format!(
                    "已拒绝这把 API Key（HTTP {status}）：请到「设置 → API 密钥」创建或启用 Key，并确认实例已开启 API Key 鉴权"
                ),
            });
        }
        if status == 404 {
            return Err(UptimeKumaError {
                status: Some(status),
                message: format!(
                    "没有找到 {url}（HTTP 404）：请检查基础地址是否正确（子路径部署需带 /uptime-kuma）"
                ),
            });
        }
        if !(200..300).contains(&status) {
            return Err(UptimeKumaError {
                status: Some(status),
                message: format!("{url} 返回 HTTP {status}：请检查实例地址与网络连通性"),
            });
        }
        if !is_prometheus_content_type(&content_type) {
            return Err(UptimeKumaError {
                status: Some(status),
                message: format!(
                    "{url} 返回的不是 Prometheus 指标（HTTP {status}, {content_type}）：请检查基础地址是否包含正确的子路径（如 /uptime-kuma），且实例已启用 metrics"
                ),
            });
        }
        if parse_metrics(&text).samples == 0 {
            return Err(UptimeKumaError {
                status: Some(status),
                message: format!("{url} 没有返回任何指标样本：请检查实例状态与基础地址"),
            });
        }
        Ok(text)
    }

    pub async fn metrics(&self) -> Result<KumaMetrics, UptimeKumaError> {
        let text = self.fetch_metrics_text().await?;
        Ok(parse_metrics(&text))
    }
}

fn is_prometheus_content_type(content_type: &str) -> bool {
    let lowered = content_type.to_ascii_lowercase();
    lowered.contains("text/plain") || lowered.contains("openmetrics")
}

/// 解析 Prometheus 文本：只提取 `monitor_status`、`app_version` 与样本数。
/// 指标行里的 label 值可能含空格（中文监控名），不能按第一个空格切分。
pub fn parse_metrics(text: &str) -> KumaMetrics {
    let mut metrics = KumaMetrics::default();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((series, value)) = split_sample(line) else {
            continue;
        };
        metrics.samples += 1;
        let family = series.split('{').next().unwrap_or(series).trim();
        match family {
            "monitor_status" => {
                let labels = parse_labels(series);
                let label = |key: &str| {
                    labels
                        .iter()
                        .find(|(name, _)| name == key)
                        .map(|(_, value)| value.clone())
                };
                let Some(id) = label("monitor_id") else {
                    continue;
                };
                metrics.monitors.push(MonitorStatus {
                    id,
                    name: label("monitor_name").unwrap_or_default(),
                    monitor_type: label("monitor_type").unwrap_or_default(),
                    up: value == "1",
                });
            }
            "app_version" => {
                if metrics.version.is_none() {
                    let labels = parse_labels(series);
                    metrics.version = labels
                        .iter()
                        .find(|(name, value)| name == "version" && !value.is_empty())
                        .map(|(_, value)| value.clone());
                }
            }
            _ => {}
        }
    }
    metrics
}

/// 从一行样本里切出 `series`（含 labels）与数值 token。
fn split_sample(line: &str) -> Option<(&str, &str)> {
    let series_end = match line.find('{') {
        Some(open) => open + line[open..].find('}')? + 1,
        None => line.find(char::is_whitespace).unwrap_or(line.len()),
    };
    let series = &line[..series_end];
    let rest = line[series_end..].trim_start();
    let value = rest.split_whitespace().next()?;
    Some((series, value))
}

/// 解析 `{a="1",b="x"}` 里的 label；支持 Prometheus 的 `\\`、`\"`、`\n` 转义。
fn parse_labels(series: &str) -> Vec<(String, String)> {
    let Some(open) = series.find('{') else {
        return Vec::new();
    };
    let Some(close) = series.rfind('}') else {
        return Vec::new();
    };
    if close <= open {
        return Vec::new();
    }
    let body = &series[open + 1..close];
    let bytes = body.as_bytes();
    let mut labels = Vec::new();
    let mut index = 0usize;
    while index < body.len() {
        while index < body.len() && (bytes[index] == b',' || bytes[index].is_ascii_whitespace()) {
            index += 1;
        }
        if index >= body.len() {
            break;
        }
        let key_start = index;
        while index < body.len() && bytes[index] != b'=' {
            index += 1;
        }
        if index >= body.len() {
            break;
        }
        let key = body[key_start..index].trim().to_string();
        index += 1; // '='
        while index < body.len() && (bytes[index] == b' ' || bytes[index] == b'\t') {
            index += 1;
        }
        if index >= body.len() || bytes[index] != b'"' {
            while index < body.len() && bytes[index] != b',' {
                index += 1;
            }
            continue;
        }
        index += 1; // 开引号
        let mut value = String::new();
        let mut closed = false;
        while index < body.len() {
            let ch = body[index..].chars().next().unwrap_or('\u{0}');
            index += ch.len_utf8();
            match ch {
                '"' => {
                    closed = true;
                    break;
                }
                '\\' => {
                    let Some(escaped) = body.get(index..).and_then(|rest| rest.chars().next())
                    else {
                        break;
                    };
                    index += escaped.len_utf8();
                    match escaped {
                        'n' => value.push('\n'),
                        '\\' => value.push('\\'),
                        '"' => value.push('"'),
                        other => {
                            value.push('\\');
                            value.push(other);
                        }
                    }
                }
                other => value.push(other),
            }
        }
        if closed && !key.is_empty() {
            labels.push((key, value));
        }
        while index < body.len() && bytes[index] != b',' {
            index += 1;
        }
    }
    labels
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"# HELP monitor_status Monitor status
# TYPE monitor_status gauge
monitor_status{monitor_id="1",monitor_name="HG 英文站",monitor_type="group",monitor_url="https://"} 1
monitor_status{monitor_id="47",monitor_name="生产 Redis .11",monitor_type="redis",monitor_url="tcp://"} 0
# HELP app_version The service version by package.json
# TYPE app_version gauge
app_version{version="0.0.28",major="0",minor="0",patch="28"} 1
nodejs_version_info{version="v20.19.4"} 1
"#;

    #[test]
    fn normalizes_instance_urls() {
        assert_eq!(
            normalize_base_url("https://tcwireless.qa.17usoft.com/uptime-kuma").unwrap(),
            "https://tcwireless.qa.17usoft.com/uptime-kuma"
        );
        assert_eq!(
            normalize_base_url("  https://tcwireless.qa.17usoft.com/uptime-kuma//  ").unwrap(),
            "https://tcwireless.qa.17usoft.com/uptime-kuma"
        );
        // 用户粘贴的是前端设置页地址：fragment 必须丢掉。
        assert_eq!(
            normalize_base_url("https://host/uptime-kuma/#/settings/api-keys").unwrap(),
            "https://host/uptime-kuma"
        );
        // 粘贴到 /metrics 时归一掉。
        assert_eq!(
            normalize_base_url("https://host/uptime-kuma/metrics").unwrap(),
            "https://host/uptime-kuma"
        );
        assert_eq!(
            normalize_base_url("http://10.0.0.5:3001").unwrap(),
            "http://10.0.0.5:3001"
        );

        assert_eq!(
            normalize_base_url("").unwrap_err(),
            "Uptime Kuma 地址不能为空"
        );
        assert_eq!(
            normalize_base_url("   ").unwrap_err(),
            "Uptime Kuma 地址不能为空"
        );
        assert_eq!(
            normalize_base_url("ftp://host").unwrap_err(),
            "Uptime Kuma 地址必须以 http:// 或 https:// 开头"
        );
        assert_eq!(
            normalize_base_url("https://host/uptime-kuma?x=1").unwrap_err(),
            "Uptime Kuma 地址不能带查询参数或账号密码"
        );
        assert_eq!(
            normalize_base_url("https://user:pass@host/uptime-kuma").unwrap_err(),
            "Uptime Kuma 地址不能带查询参数或账号密码"
        );
        assert!(normalize_base_url("host/uptime-kuma")
            .unwrap_err()
            .starts_with("Uptime Kuma 地址无法解析："));
    }

    #[test]
    fn builds_metrics_url_and_basic_auth_header() {
        assert_eq!(
            metrics_url("https://host/uptime-kuma"),
            "https://host/uptime-kuma/metrics"
        );
        // 空用户名 + API Key：Basic base64(":key")
        assert_eq!(authorization_header("secret-key"), "Basic OnNlY3JldC1rZXk=");
    }

    #[test]
    fn parses_monitor_status_and_version() {
        let metrics = parse_metrics(FIXTURE);
        assert_eq!(metrics.samples, 4);
        assert_eq!(metrics.version.as_deref(), Some("0.0.28"));
        assert_eq!(
            metrics.monitors,
            vec![
                MonitorStatus {
                    id: "1".to_string(),
                    name: "HG 英文站".to_string(),
                    monitor_type: "group".to_string(),
                    up: true,
                },
                MonitorStatus {
                    id: "47".to_string(),
                    name: "生产 Redis .11".to_string(),
                    monitor_type: "redis".to_string(),
                    up: false,
                },
            ]
        );
        assert_eq!(metrics.up_count(), 1);
        assert_eq!(metrics.down_count(), 1);
        assert_eq!(metrics.summarize(), "2 个监控（1 正常 / 1 异常）");
    }

    #[test]
    fn parses_escaped_label_values_and_ignores_comments() {
        let text = r#"# comment
monitor_status{monitor_id="2",monitor_name="a \"quoted\" name",monitor_type="http"} 1
"#;
        let metrics = parse_metrics(text);
        assert_eq!(metrics.samples, 1);
        assert_eq!(metrics.monitors[0].name, "a \"quoted\" name");
        assert!(metrics.monitors[0].up);
    }

    #[test]
    fn empty_metrics_has_zero_samples() {
        let metrics = parse_metrics("");
        assert_eq!(metrics.samples, 0);
        assert!(metrics.monitors.is_empty());
        assert_eq!(metrics.summarize(), "0 个监控（0 正常 / 0 异常）");
    }

    #[test]
    fn rejects_blank_token() {
        assert_eq!(
            UptimeKumaClient::new("https://host/uptime-kuma", "  ").unwrap_err(),
            "Uptime Kuma API Key 不能为空"
        );
    }
}
