//! Web Console - HTTP API + embedded dashboard for headless mode

use super::config::{
    AccountStatsRow, ChannelAccount, ChannelPreset, RequestLogRow, RouteCandidate, RouteRule,
    UsageSummaryRow,
};
use super::metrics::Metrics;
use super::storage::Storage;
use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Json, Response},
    routing::get,
    Router,
};
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::RwLock;

pub struct WebState {
    pub storage: Storage,
    pub proxy_running: Arc<RwLock<bool>>,
    pub bind_addr: String,
    pub proxy_bind_addr: String,
    pub admin_token: Option<String>,
    pub metrics: Metrics,
}

/// 检查认证头
fn check_auth(headers: &HeaderMap, expected_token: &Option<String>) -> bool {
    let Some(expected) = expected_token else {
        return true; // 未设置 token，允许访问
    };
    if expected.is_empty() {
        return true;
    }
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|token| token == expected)
        .unwrap_or(false)
}

/// 未认证响应
fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, "Bearer")],
        Json(serde_json::json!({"error": "unauthorized"})),
    )
        .into_response()
}

#[derive(Serialize)]
struct StatusResponse {
    running: bool,
    proxy_bind_addr: String,
    channels: usize,
    accounts: usize,
    routes: usize,
}

pub fn create_web_router(state: WebState) -> Router {
    let state = Arc::new(state);

    // 公开路由（仪表板页面）
    let public_routes = Router::new().route("/", get(dashboard_handler));

    // 受保护路由（API 需要认证）
    let api_routes = Router::new()
        .route("/api/status", get(status_handler))
        .route("/api/channels", get(channels_handler))
        .route("/api/accounts", get(accounts_handler))
        .route("/api/routes", get(routes_handler))
        .route("/api/rules", get(rules_handler))
        .route("/api/logs", get(logs_handler))
        .route("/api/usage", get(usage_handler))
        .route("/api/stats", get(stats_handler))
        .route("/api/scores", get(scores_handler))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ));

    // Metrics endpoint (Prometheus format, no auth required for scraping)
    let metrics_routes = Router::new()
        .route("/metrics", get(metrics_handler))
        .with_state(state.clone());

    public_routes
        .merge(api_routes)
        .merge(metrics_routes)
        .with_state(state)
}

/// 认证中间件
async fn auth_middleware(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    if check_auth(&headers, &state.admin_token) {
        next.run(request).await
    } else {
        unauthorized()
    }
}

async fn dashboard_handler() -> Html<&'static str> {
    Html(DASHBOARD_HTML)
}

async fn status_handler(State(state): State<Arc<WebState>>) -> Json<StatusResponse> {
    let running = *state.proxy_running.read().await;
    let channels = state
        .storage
        .list_channel_presets()
        .unwrap_or_default()
        .len();
    let accounts = state
        .storage
        .list_channel_accounts()
        .unwrap_or_default()
        .len();
    let routes = state
        .storage
        .list_route_candidates()
        .unwrap_or_default()
        .len();
    Json(StatusResponse {
        running,
        proxy_bind_addr: state.proxy_bind_addr.clone(),
        channels,
        accounts,
        routes,
    })
}

async fn channels_handler(State(state): State<Arc<WebState>>) -> Json<Vec<ChannelPreset>> {
    Json(state.storage.list_channel_presets().unwrap_or_default())
}

async fn accounts_handler(State(state): State<Arc<WebState>>) -> Json<Vec<ChannelAccount>> {
    Json(state.storage.list_channel_accounts().unwrap_or_default())
}

async fn routes_handler(State(state): State<Arc<WebState>>) -> Json<Vec<RouteCandidate>> {
    Json(state.storage.list_route_candidates().unwrap_or_default())
}

async fn rules_handler(State(state): State<Arc<WebState>>) -> Json<Vec<RouteRule>> {
    Json(state.storage.list_route_rules().unwrap_or_default())
}

async fn logs_handler(State(state): State<Arc<WebState>>) -> Json<Vec<RequestLogRow>> {
    Json(state.storage.list_request_logs().unwrap_or_default())
}

async fn usage_handler(State(state): State<Arc<WebState>>) -> Json<Vec<UsageSummaryRow>> {
    Json(state.storage.usage_summary().unwrap_or_default())
}

async fn stats_handler(State(state): State<Arc<WebState>>) -> Json<Vec<AccountStatsRow>> {
    Json(state.storage.account_stats().unwrap_or_default())
}

async fn scores_handler(State(state): State<Arc<WebState>>) -> impl IntoResponse {
    Json(state.storage.account_routing_scores().unwrap_or_default())
}

async fn metrics_handler(State(state): State<Arc<WebState>>) -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        state.metrics.render_prometheus(),
    )
}

const DASHBOARD_HTML: &str = r#"<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Flowlet Web Console</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#0f1419;color:#e7e9ea;font-size:14px}
.header{background:#1a2332;padding:16px 24px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #2a3a4a}
.header h1{font-size:20px;color:#4a9eff}
.status-badge{padding:4px 12px;border-radius:12px;font-size:12px;font-weight:600}
.status-running{background:#1a3a2a;color:#4ade80}
.status-stopped{background:#3a1a1a;color:#f87171}
.container{padding:24px;max-width:1200px;margin:0 auto}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;margin-bottom:24px}
.card{background:#1a2332;border:1px solid #2a3a4a;border-radius:8px;padding:16px}
.card h3{font-size:12px;color:#8899a6;text-transform:uppercase;margin-bottom:8px}
.card .value{font-size:28px;font-weight:700;color:#4a9eff}
.section{background:#1a2332;border:1px solid #2a3a4a;border-radius:8px;margin-bottom:16px;overflow:hidden}
.section-header{padding:12px 16px;border-bottom:1px solid #2a3a4a;font-weight:600}
.section-body{padding:16px;overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #2a3a4a;white-space:nowrap}
th{color:#8899a6;font-weight:600}
tr:hover{background:#1e2a3a}
.refresh-info{font-size:11px;color:#667788;float:right}
</style>
</head>
<body>
<div class="header"><h1>Flowlet</h1><div><span id="statusBadge" class="status-badge status-running">Running</span></div></div>
<div class="container">
<div class="grid">
<div class="card"><h3>Channels</h3><div class="value" id="chCount">-</div></div>
<div class="card"><h3>Accounts</h3><div class="value" id="acCount">-</div></div>
<div class="card"><h3>Routes</h3><div class="value" id="roCount">-</div></div>
</div>
<div class="section"><div class="section-header">Recent Logs <span class="refresh-info">auto-refresh 10s</span></div>
<div class="section-body"><table><thead><tr><th>Time</th><th>Channel</th><th>Account</th><th>Type</th><th>Model</th><th>Status</th><th>Latency</th></tr></thead><tbody id="logsBody"><tr><td colspan="7">Loading...</td></tr></tbody></table></div></div>
<div class="section"><div class="section-header">Account Stats</div>
<div class="section-body"><table><thead><tr><th>Account</th><th>Channel</th><th>Requests</th><th>Success</th><th>Failed</th><th>Fail Rate</th><th>Cost</th></tr></thead><tbody id="statsBody"><tr><td colspan="7">Loading...</td></tr></tbody></table></div></div>
<div class="section"><div class="section-header">Routing Scores</div>
<div class="section-body"><table><thead><tr><th>Account</th><th>Channel</th><th>Latency</th><th>Success Rate</th><th>Cost/1k</th></tr></thead><tbody id="scoresBody"><tr><td colspan="5">Loading...</td></tr></tbody></table></div></div>
</div>
<script>
async function fetchJSON(u){return(await fetch(u)).json()}
async function refresh(){
 try{
  const s=await fetchJSON('/api/status');
  document.getElementById('chCount').textContent=s.channels;
  document.getElementById('acCount').textContent=s.accounts;
  document.getElementById('roCount').textContent=s.routes;
  const b=document.getElementById('statusBadge');
  b.textContent=s.running?'Running':'Stopped';
  b.className='status-badge '+(s.running?'status-running':'status-stopped');
  const logs=await fetchJSON('/api/logs');
  document.getElementById('logsBody').innerHTML=logs.slice(0,50).map(r=>'<tr><td>'+(r.created_at||'-')+'</td><td>'+(r.channel_name||r.channel_id||'-')+'</td><td>'+(r.account_name||r.account_id||'-')+'</td><td>'+(r.request_type||'-')+'</td><td>'+(r.upstream_model||'-')+'</td><td>'+(r.status||'-')+'</td><td>'+(r.latency_ms?r.latency_ms+'ms':'-')+'</td></tr>').join('');
  const stats=await fetchJSON('/api/stats');
  document.getElementById('statsBody').innerHTML=stats.map(r=>'<tr><td>'+(r.account_name||r.account_id)+'</td><td>'+(r.channel_name||r.channel_id||'-')+'</td><td>'+r.total_requests+'</td><td>'+r.success_requests+'</td><td>'+r.failed_requests+'</td><td>'+r.failure_rate.toFixed(1)+'%</td><td>$'+r.estimated_cost.toFixed(6)+'</td></tr>').join('');
  const scores=await fetchJSON('/api/scores');
  document.getElementById('scoresBody').innerHTML=scores.map(s=>'<tr><td>'+s[0]+'</td><td>'+s[1]+'</td><td>'+Math.round(s[2])+'ms</td><td>'+s[3].toFixed(1)+'%</td><td>$'+s[4].toFixed(6)+'</td></tr>').join('');
 }catch(e){console.error(e);}
}
refresh();setInterval(refresh,10000);
</script>
</body>
</html>"#;
