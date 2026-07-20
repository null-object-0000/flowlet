use serde::{Deserialize, Serialize};

// ─── Request Type ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RequestType {
    #[default]
    Chat,
    Code,
    Reasoning,
    LongContext,
    ToolUse,
    Unknown,
}

impl RequestType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Code => "code",
            Self::Reasoning => "reasoning",
            Self::LongContext => "long_context",
            Self::ToolUse => "tool_use",
            Self::Unknown => "unknown",
        }
    }
}

/// 从请求体中识别请求类型
pub fn classify_request(body_bytes: &[u8], protocol: &ProtocolType) -> RequestType {
    // 尝试解析 JSON
    let json: serde_json::Value = match serde_json::from_slice(body_bytes) {
        Ok(v) => v,
        Err(_) => return RequestType::Unknown,
    };

    // 检查 tools / tool_use
    if json.get("tools").is_some()
        || json.get("tool_choice").is_some()
        || has_tool_use_content(&json, protocol)
    {
        return RequestType::ToolUse;
    }

    // 检查 messages 内容
    let messages = json
        .get("messages")
        .and_then(|m| m.as_array())
        .map(|a| a.as_slice())
        .unwrap_or_default();

    // 估算总 token 数（粗略：字符数 / 4）
    let total_chars: usize = messages
        .iter()
        .filter_map(|m| m.get("content").and_then(|c| c.as_str()).map(|s| s.len()))
        .sum();

    // 长上下文判断：总字符 > 20000 或单条消息 > 10000
    let max_single = messages
        .iter()
        .filter_map(|m| m.get("content").and_then(|c| c.as_str()).map(|s| s.len()))
        .max()
        .unwrap_or(0);

    if total_chars > 20000 || max_single > 10000 {
        return RequestType::LongContext;
    }

    // 检查是否包含代码相关关键词
    let all_text = messages
        .iter()
        .filter_map(|m| m.get("content").and_then(|c| c.as_str()))
        .collect::<Vec<_>>()
        .join(" ");

    let code_indicators = [
        "```",
        "function",
        "class ",
        "def ",
        "import ",
        "const ",
        "let ",
        "public ",
        "private ",
        "impl ",
        "fn ",
        "func ",
        "coding",
        "代码",
        "implement",
        "refactor",
        "debug",
        "compile",
    ];

    let code_hits = code_indicators
        .iter()
        .filter(|&&ind| all_text.to_lowercase().contains(ind))
        .count();

    if code_hits >= 2 {
        return RequestType::Code;
    }

    // 检查是否包含推理/复杂任务关键词
    let reasoning_indicators = [
        "analyze",
        "reasoning",
        "step by step",
        "complex",
        "difficult",
        "think carefully",
        "reasoning",
        "分析",
        "推理",
        "详细",
        "思考",
        "explain why",
        "compare",
        "evaluate",
    ];

    let reasoning_hits = reasoning_indicators
        .iter()
        .filter(|&&ind| all_text.to_lowercase().contains(ind))
        .count();

    if reasoning_hits >= 1 && total_chars > 2000 {
        return RequestType::Reasoning;
    }

    // 检查 system prompt 是否暗示代码任务
    if let Some(system) = messages
        .iter()
        .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("system"))
        .and_then(|m| m.get("content").and_then(|c| c.as_str()))
    {
        let sys_lower = system.to_lowercase();
        if sys_lower.contains("code")
            || sys_lower.contains("programming")
            || sys_lower.contains("代码")
        {
            return RequestType::Code;
        }
        if sys_lower.contains("reason")
            || sys_lower.contains("analyze")
            || sys_lower.contains("分析")
        {
            return RequestType::Reasoning;
        }
    }

    RequestType::Chat
}

/// 检查是否有 tool_use 类型的内容
fn has_tool_use_content(json: &serde_json::Value, _protocol: &ProtocolType) -> bool {
    if let Some(messages) = json.get("messages").and_then(|m| m.as_array()) {
        for msg in messages {
            // OpenAI 格式: content 中包含 tool_calls
            if msg.get("tool_calls").is_some() {
                return true;
            }
            // Anthropic 格式: content block 中有 type: "tool_use"
            if let Some(content) = msg.get("content").and_then(|c| c.as_array()) {
                for block in content {
                    if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                        return true;
                    }
                }
            }
        }
    }
    false
}

// ─── Protocol Type ──────────────────────────────────────────────────────────
// 序列化必须与 TypeScript 的 ProtocolType ("openai" | "anthropic") 完全一致
//（全小写），前端直接比较字符串。反序列化用 alias 兼容旧数据库的 "open-ai"。

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum ProtocolType {
    #[default]
    #[serde(rename = "openai", alias = "open-ai")]
    OpenAi,
    #[serde(rename = "anthropic", alias = "Anthropic")]
    Anthropic,
}

impl ProtocolType {
    pub fn from_path(path: &str) -> Option<Self> {
        let p = path.trim_start_matches('/');
        if p.starts_with("anthropic/") {
            Some(Self::Anthropic)
        } else if p.starts_with("v1/") || p.starts_with("openai/") || p == "v1" || p == "openai" {
            Some(Self::OpenAi)
        } else {
            None
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Anthropic => "anthropic",
        }
    }
}

// ─── Auth Strategy ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AuthStrategy {
    #[default]
    Bearer,
    XApiKey,
}

impl AuthStrategy {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Bearer => "bearer",
            Self::XApiKey => "x_api_key",
        }
    }
}

// ─── Channel Preset ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelPreset {
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub supported_protocols: Vec<ProtocolType>,
    pub openai_base_url: String,
    pub anthropic_base_url: String,
    pub openai_auth: AuthStrategy,
    pub anthropic_auth: AuthStrategy,
    pub default_model: String,
    pub small_model: Option<String>,
    pub timeout_seconds: Option<u64>,
    pub supports_model_list: bool,
    pub supports_model_detail: bool,
    pub supports_balance_query: bool,
    pub supports_quota_query: bool,
    pub supports_usage_query: bool,
    // 渠道平台查看 API Key 的跳转地址（如控制台页面）
    pub platform_url: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Default for ChannelPreset {
    fn default() -> Self {
        Self {
            id: "longcat".to_string(),
            name: "LongCat".to_string(),
            vendor: "longcat".to_string(),
            supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic],
            openai_base_url: "https://api.longcat.chat/openai".to_string(),
            anthropic_base_url: "https://api.longcat.chat/anthropic".to_string(),
            openai_auth: AuthStrategy::Bearer,
            anthropic_auth: AuthStrategy::Bearer,
            default_model: "LongCat-2.0".to_string(),
            small_model: None,
            timeout_seconds: None,
            supports_model_list: false,
            supports_model_detail: false,
            supports_balance_query: false,
            supports_quota_query: false,
            supports_usage_query: false,
            platform_url: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }
}

impl ChannelPreset {
    pub fn longcat() -> Self {
        Self {
            id: "longcat".to_string(),
            name: "LongCat".to_string(),
            vendor: "longcat".to_string(),
            supports_model_list: true,
            supports_model_detail: true,
            platform_url: Some("https://longcat.chat/platform/api_keys".to_string()),
            ..Default::default()
        }
    }

    pub fn kimi() -> Self {
        Self {
            id: "kimi".to_string(),
            name: "Kimi".to_string(),
            vendor: "moonshot".to_string(),
            platform_url: Some("https://platform.kimi.com/console/api-keys".to_string()),
            supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic],
            openai_base_url: "https://api.moonshot.cn/v1".to_string(),
            anthropic_base_url: "https://api.moonshot.cn/anthropic".to_string(),
            openai_auth: AuthStrategy::Bearer,
            anthropic_auth: AuthStrategy::Bearer,
            default_model: "kimi-k3".to_string(),
            small_model: None,
            supports_model_list: true,
            supports_model_detail: false,
            supports_balance_query: true,
            supports_quota_query: false,
            supports_usage_query: false,
            ..Default::default()
        }
    }

    pub fn deepseek() -> Self {
        Self {
            id: "deepseek".to_string(),
            name: "DeepSeek".to_string(),
            vendor: "deepseek".to_string(),
            platform_url: Some("https://platform.deepseek.com/api_keys".to_string()),
            supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic],
            openai_base_url: "https://api.deepseek.com".to_string(),
            anthropic_base_url: "https://api.deepseek.com/anthropic".to_string(),
            openai_auth: AuthStrategy::Bearer,
            anthropic_auth: AuthStrategy::XApiKey,
            default_model: "deepseek-v4-pro".to_string(),
            small_model: None,
            supports_model_list: true,
            supports_model_detail: false,
            supports_balance_query: true,
            supports_quota_query: false,
            supports_usage_query: false,
            ..Default::default()
        }
    }

    /// 千问 Qwen（千问 AI 平台）按量付费渠道。
    /// Token Plan 订阅账号通过账号级 resource_mode + Base URL 覆盖接入，
    /// 渠道级默认值保持按量付费端点。
    pub fn qwen() -> Self {
        Self {
            id: "qwen".to_string(),
            name: "千问 Qwen".to_string(),
            vendor: "qwen".to_string(),
            platform_url: Some("https://platform.qianwenai.com/home/api-keys".to_string()),
            supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic],
            openai_base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string(),
            anthropic_base_url: "https://dashscope.aliyuncs.com/apps/anthropic".to_string(),
            openai_auth: AuthStrategy::Bearer,
            anthropic_auth: AuthStrategy::Bearer,
            default_model: "qwen3.7-max".to_string(),
            small_model: None,
            supports_model_list: true,
            supports_model_detail: false,
            supports_balance_query: false,
            supports_quota_query: false,
            supports_usage_query: false,
            ..Default::default()
        }
    }

    pub fn base_url_for(&self, protocol: &ProtocolType) -> &str {
        match protocol {
            ProtocolType::OpenAi => &self.openai_base_url,
            ProtocolType::Anthropic => &self.anthropic_base_url,
        }
    }

    pub fn auth_strategy_for(&self, protocol: &ProtocolType) -> &AuthStrategy {
        match protocol {
            ProtocolType::OpenAi => &self.openai_auth,
            ProtocolType::Anthropic => &self.anthropic_auth,
        }
    }
}

// ─── Channel Account ─────────────────────────────────────────────────────────

/// 账号凭证状态：healthy 表示可参与路由；invalid_key 表示上游最近返回 401，
/// 应从候选池中排除，直到用户修改 API Key 或测试连接成功。
pub type AccountCredentialStatus = String;

pub const ACCOUNT_CREDENTIAL_HEALTHY: &str = "healthy";
pub const ACCOUNT_CREDENTIAL_INVALID_KEY: &str = "invalid_key";

/// 旧配置导入兼容：缺失 credential_status 时默认为 healthy。
fn default_credential_status() -> AccountCredentialStatus {
    ACCOUNT_CREDENTIAL_HEALTHY.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelAccount {
    pub id: String,
    pub channel_id: String,
    pub name: String,
    pub api_key: String,
    pub enabled: bool,
    pub priority: i64,
    pub remark: Option<String>,
    #[serde(default)]
    pub resource_mode: Option<String>,
    /// Account-level OpenAI-compatible upstream URL override.
    pub base_url_override: Option<String>,
    /// Account-level Anthropic-compatible upstream URL override.
    #[serde(default)]
    pub anthropic_base_url_override: Option<String>,
    pub last_used_at: Option<String>,
    pub last_error: Option<String>,
    #[serde(default = "default_credential_status")]
    pub credential_status: AccountCredentialStatus,
    pub created_at: String,
    pub updated_at: String,
}

impl Default for ChannelAccount {
    fn default() -> Self {
        Self {
            id: String::new(),
            channel_id: String::new(),
            name: String::new(),
            api_key: String::new(),
            enabled: true,
            priority: 0,
            remark: None,
            resource_mode: None,
            base_url_override: None,
            anthropic_base_url_override: None,
            last_used_at: None,
            last_error: None,
            credential_status: ACCOUNT_CREDENTIAL_HEALTHY.to_string(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }
}

// ─── Channel Model ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelModel {
    pub id: String,
    pub channel_id: String,
    pub model: String,
    pub display_name: Option<String>,
    pub supported_protocols: Vec<ProtocolType>,
    pub context_window: Option<i64>,
    pub max_output_tokens: Option<i64>,
    pub supports_stream: bool,
    pub enabled: bool,
    pub source: String,
    pub synced_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

// ─── Client Config ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientConfig {
    pub id: String,
    pub name: String,
    pub token: String,
    pub app_type: String,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// 基于 User-Agent 子串的客户端身份识别规则。
/// 独立于鉴权 token，仅决定日志/用量中的客户端归属。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UaClientRule {
    pub id: String,
    pub pattern: String,
    pub name: String,
    pub enabled: bool,
}

// ─── Virtual Model ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VirtualModel {
    pub id: String,
    pub name: String,
    pub protocol_type: ProtocolType,
    pub routing_strategy: String,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl VirtualModel {
    pub fn default_auto() -> Self {
        Self {
            id: "auto".to_string(),
            name: "auto".to_string(),
            protocol_type: ProtocolType::OpenAi,
            routing_strategy: "priority".to_string(),
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }
}

// ─── Route Candidate ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteCandidate {
    pub id: String,
    pub virtual_model_id: String,
    pub channel_id: String,
    pub account_id: String,
    pub upstream_model: String,
    pub client_protocol: ProtocolType,
    pub priority: i64,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl Default for RouteCandidate {
    fn default() -> Self {
        Self {
            id: String::new(),
            virtual_model_id: "auto".to_string(),
            channel_id: String::new(),
            account_id: String::new(),
            upstream_model: String::new(),
            client_protocol: ProtocolType::OpenAi,
            priority: 0,
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }
}

// ─── Route Rule (规则路由) ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteRule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub priority: i64,
    // 匹配条件（为空表示不匹配该字段）
    pub match_client_id: Option<String>,
    pub match_model: Option<String>,
    pub match_protocol: Option<ProtocolType>,
    // 命中后路由到
    pub target_channel_id: String,
    pub target_account_id: String,
    pub target_upstream_model: String,
    pub created_at: String,
    pub updated_at: String,
}

impl Default for RouteRule {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            enabled: true,
            priority: 0,
            match_client_id: None,
            match_model: None,
            match_protocol: None,
            target_channel_id: String::new(),
            target_account_id: String::new(),
            target_upstream_model: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }
}

// ─── Model Price (三段价格) ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelPrice {
    pub id: String,
    pub channel_id: String,
    pub upstream_model: String,
    pub input_uncached_price: f64,
    pub input_cached_price: f64,
    pub input_cache_write_price: Option<f64>,
    pub output_price: f64,
    /// 按输入长度分级计价。为空时使用上面的扁平单价；非空时按请求总输入 Token 选档。
    /// 约定按 `up_to_input_tokens` 升序排列，最后一档可用 `None` 作为无上限兜底。
    #[serde(default)]
    pub tiers: Vec<ModelPriceTier>,
    pub currency: String,
    pub unit: String,
    pub source_url: Option<String>,
    pub price_version: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Default for ModelPrice {
    fn default() -> Self {
        Self {
            id: String::new(),
            channel_id: String::new(),
            upstream_model: String::new(),
            input_uncached_price: 0.0,
            input_cached_price: 0.0,
            input_cache_write_price: None,
            output_price: 0.0,
            tiers: Vec::new(),
            currency: "USD".to_string(),
            unit: "1M tokens".to_string(),
            source_url: None,
            price_version: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }
}

/// 单个输入长度价格档位。`up_to_input_tokens` 为总输入 Token 的闭区间上限，
/// `None` 表示无上限（兜底档）。各价格为该档内的每百万 Token 单价。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelPriceTier {
    #[serde(default)]
    pub up_to_input_tokens: Option<i64>,
    #[serde(default)]
    pub input_uncached_price: f64,
    #[serde(default)]
    pub input_cached_price: f64,
    #[serde(default)]
    pub input_cache_write_price: Option<f64>,
    #[serde(default)]
    pub output_price: f64,
}

impl ModelPrice {
    /// 按总输入 Token 数解析生效的每百万 Token 单价。
    /// 返回 `(未缓存输入, 缓存输入, 缓存写入, 输出)`。
    /// 无分级时回退扁平单价；有分级时取第一个 `up_to_input_tokens >= input`
    /// 的档位（`None` 上限视为兜底），均未命中则回退扁平单价。
    pub fn resolve_prices(&self, input_tokens: Option<i64>) -> (f64, f64, Option<f64>, f64) {
        if self.tiers.is_empty() {
            return (
                self.input_uncached_price,
                self.input_cached_price,
                self.input_cache_write_price,
                self.output_price,
            );
        }
        let input = input_tokens.unwrap_or(0);
        for tier in &self.tiers {
            let hit = match tier.up_to_input_tokens {
                None => true,
                Some(limit) => input <= limit,
            };
            if hit {
                return (
                    tier.input_uncached_price,
                    tier.input_cached_price,
                    tier.input_cache_write_price,
                    tier.output_price,
                );
            }
        }
        (
            self.input_uncached_price,
            self.input_cached_price,
            self.input_cache_write_price,
            self.output_price,
        )
    }
}

// ─── Account Balance Snapshot ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountBalanceSnapshot {
    pub id: String,
    pub account_id: String,
    pub balance: Option<f64>,
    pub currency: Option<String>,
    pub token_pack_total: Option<i64>,
    pub token_pack_used: Option<i64>,
    pub token_pack_remaining: Option<i64>,
    pub token_pack_expire_at: Option<String>,
    // LongCat 多资源包原始数据（JSON 数组），按消耗顺序排列。单资源包场景为 None。
    pub token_packs: Option<String>,
    pub source: String,
    pub synced_at: Option<String>,
    pub remark: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

// ─── Request Log Row ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestLogRow {
    pub id: String,
    pub request_id: String,
    pub client_id: Option<String>,
    pub client_name: Option<String>,
    pub channel_id: Option<String>,
    pub channel_name: Option<String>,
    pub account_id: Option<String>,
    pub account_name: Option<String>,
    pub client_protocol: String,
    pub upstream_protocol: String,
    pub virtual_model: Option<String>,
    pub public_model: Option<String>,
    pub upstream_model: Option<String>,
    pub request_type: String,
    pub method: String,
    pub path: String,
    pub upstream_url: Option<String>,
    pub status: Option<i64>,
    pub latency_ms: Option<i64>,
    pub is_stream: bool,
    pub error_message: Option<String>,
    pub fallback_count: i64,
    pub route_reason: Option<String>,
    pub created_at: String,
    pub ttfb_ms: Option<i64>,
    pub ttft_ms: Option<i64>,
    pub duration_ms: Option<i64>,
    pub attempt_seq: i64,
    pub req_headers_json: Option<String>,
    pub req_body_b64: Option<String>,
    pub res_headers_json: Option<String>,
    pub res_body_b64: Option<String>,
    pub is_last_attempt: bool,
    /// Usage data is joined lazily for the final attempt. Intermediate attempts
    /// normally keep these fields empty because usage belongs to the request.
    pub input_tokens: Option<i64>,
    pub input_cached_tokens: Option<i64>,
    pub input_uncached_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    pub estimated_cost: Option<f64>,
}

// ─── Request Log Page (paginated + filtered) ─────────────────────────────────

/// 请求日志中出现的客户端身份。用于前端"客户端"筛选项。
/// `id` 为空串表示"未知"（日志中 client_id IS NULL）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogFilterClient {
    pub id: String,
    pub name: String,
}

/// 特殊客户端筛选值：匹配日志中 `client_id IS NULL`（未知）的请求。
pub const LOG_FILTER_CLIENT_UNKNOWN: &str = "__unknown__";

#[derive(Debug, Clone, Deserialize)]
pub struct LogsFilter {
    /// 1-based 页码
    pub page: u32,
    /// 每页条数（建议 25 / 50 / 100）
    pub page_size: u32,
    /// 状态筛选: "all" | "success" (2xx/3xx) | "error" (4xx/5xx/无状态码/有错误)
    pub status: String,
    /// 客户端 ID 筛选（空串 = 不过滤；`LOG_FILTER_CLIENT_UNKNOWN` 表示 client_id IS NULL）
    pub client_id: String,
    /// 渠道 ID 筛选（空串 = 不过滤）
    pub channel_id: String,
    /// 路径 / request_id / error_message 模糊搜索
    pub search: String,
    /// 时间范围: "1h" | "6h" | "today" | "7d" | "all"
    #[serde(default)]
    pub time_range: String,
    /// 对外模型筛选（空串 = 不过滤）
    #[serde(default)]
    pub model: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsSummary {
    pub request_count: i64,
    pub success_count: i64,
    pub error_count: i64,
    pub average_duration_ms: Option<f64>,
    pub average_ttft_ms: Option<f64>,
    pub average_output_tokens_per_second: Option<f64>,
    pub known_tokens: i64,
    pub input_tokens: i64,
    pub input_cached_tokens: i64,
    pub input_uncached_tokens: i64,
    pub cache_hit_rate: Option<f64>,
    pub estimated_cost: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsPageResult {
    pub rows: Vec<RequestLogRow>,
    pub total: i64,
    pub page: u32,
    pub page_size: u32,
    pub summary: LogsSummary,
}

// ─── Usage Record Row ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageRecordRow {
    pub id: String,
    pub request_id: String,
    pub client_id: Option<String>,
    pub client_name: Option<String>,
    pub channel_id: Option<String>,
    pub channel_name: Option<String>,
    pub account_id: Option<String>,
    pub account_name: Option<String>,
    pub client_protocol: String,
    pub upstream_protocol: String,
    pub virtual_model: Option<String>,
    pub upstream_model: Option<String>,
    pub input_tokens: Option<i64>,
    pub input_cached_tokens: Option<i64>,
    pub input_uncached_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    pub estimated_cost: Option<f64>,
    pub analyzed_at: Option<String>,
    pub created_at: String,
}

// ─── Usage Summary Row (for UI) ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageSummaryRow {
    pub date: String,
    pub client_id: Option<String>,
    pub client_name: Option<String>,
    pub channel_id: Option<String>,
    pub channel_name: Option<String>,
    pub account_id: Option<String>,
    pub account_name: Option<String>,
    pub upstream_model: Option<String>,
    pub request_count: i64,
    pub known_tokens: i64,
    pub input_tokens: i64,
    pub input_cached_tokens: i64,
    pub input_uncached_tokens: i64,
    pub cache_measured_input_tokens: i64,
    pub output_tokens: i64,
    pub unknown_count: i64,
    pub estimated_cost: f64,
}

// ─── Account Stats Row (per-account statistics) ──────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountStatsRow {
    pub account_id: String,
    pub account_name: Option<String>,
    pub channel_id: Option<String>,
    pub channel_name: Option<String>,
    pub total_requests: i64,
    pub success_requests: i64,
    pub failed_requests: i64,
    pub failure_rate: f64,
    pub total_fallbacks: i64,
    pub known_tokens: i64,
    pub estimated_cost: f64,
    pub last_error: Option<String>,
    pub last_error_at: Option<String>,
    pub last_used_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_simple_chat() {
        let body = br#"{"messages":[{"role":"user","content":"Hello, how are you?"}]}"#;
        let result = classify_request(body, &ProtocolType::OpenAi);
        assert_eq!(result, RequestType::Chat);
    }

    #[test]
    fn classify_code_request() {
        let body = br#"{"messages":[{"role":"user","content":"```rust\nfn main() {\n  println!(\"hello\");\n}\n```\nPlease fix this code"}]}"#;
        let result = classify_request(body, &ProtocolType::OpenAi);
        assert_eq!(result, RequestType::Code);
    }

    #[test]
    fn classify_tool_use() {
        let body = r#"{"model":"gpt-4","tools":[{"type":"function","function":{"name":"get_weather"}}],"messages":[{"role":"user","content":"What's the weather?"}]}"#;
        let result = classify_request(body.as_bytes(), &ProtocolType::OpenAi);
        assert_eq!(result, RequestType::ToolUse);
    }

    #[test]
    fn classify_long_context() {
        let long_text = "a".repeat(15000);
        let body = format!(
            r#"{{"messages":[{{"role":"user","content":"{}"}}]}}"#,
            long_text
        );
        let result = classify_request(body.as_bytes(), &ProtocolType::OpenAi);
        assert_eq!(result, RequestType::LongContext);
    }

    #[test]
    fn classify_reasoning_request() {
        let long_text = "Please analyze this complex problem step by step and explain why the algorithm works in detail. ".repeat(25);
        let body = format!(
            r#"{{"messages":[{{"role":"user","content":"{}"}}]}}"#,
            long_text
        );
        let result = classify_request(body.as_bytes(), &ProtocolType::OpenAi);
        assert_eq!(result, RequestType::Reasoning);
    }

    #[test]
    fn classify_unknown_for_invalid_json() {
        let body = b"not json";
        let result = classify_request(body, &ProtocolType::OpenAi);
        assert_eq!(result, RequestType::Unknown);
    }
}

// ─── Config Bundle (导入/导出) ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigBundle {
    pub version: String,
    pub exported_at: String,
    pub channels: Vec<ChannelPreset>,
    pub accounts: Vec<ChannelAccount>,
    pub routes: Vec<RouteCandidate>,
    pub rules: Vec<RouteRule>,
    pub prices: Vec<ModelPrice>,
    pub virtual_models: Vec<VirtualModel>,
}

impl Default for ConfigBundle {
    fn default() -> Self {
        Self {
            version: "1".to_string(),
            exported_at: String::new(),
            channels: Vec::new(),
            accounts: Vec::new(),
            routes: Vec::new(),
            rules: Vec::new(),
            prices: Vec::new(),
            virtual_models: Vec::new(),
        }
    }
}

// ─── Usage Record Input (internal) ───────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct UsageRecordInput {
    pub request_id: String,
    pub client_id: Option<String>,
    pub client_name: Option<String>,
    pub channel_id: Option<String>,
    pub channel_name: Option<String>,
    pub account_id: Option<String>,
    pub account_name: Option<String>,
    pub client_protocol: String,
    pub upstream_protocol: String,
    pub virtual_model: Option<String>,
    pub upstream_model: Option<String>,
    pub input_tokens: Option<i64>,
    pub input_cached_tokens: Option<i64>,
    pub input_uncached_tokens: Option<i64>,
    pub input_cache_write_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
}

// ─── Request Log Input (internal) ────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct RequestLogInput {
    pub request_id: String,
    pub agent_type: Option<String>,
    pub agent_session_id: Option<String>,
    pub parent_agent_session_id: Option<String>,
    pub client_id: Option<String>,
    pub client_name: Option<String>,
    pub channel_id: Option<String>,
    pub channel_name: Option<String>,
    pub account_id: Option<String>,
    pub account_name: Option<String>,
    pub client_protocol: String,
    pub upstream_protocol: String,
    pub virtual_model: Option<String>,
    pub public_model: Option<String>,
    pub upstream_model: Option<String>,
    pub request_type: String,
    pub method: String,
    pub path: String,
    pub upstream_url: Option<String>,
    pub status: Option<i64>,
    pub latency_ms: Option<i64>,
    pub is_stream: bool,
    pub error_message: Option<String>,
    pub fallback_count: i64,
    pub route_reason: Option<String>,
    pub ttfb_ms: Option<i64>,
    pub duration_ms: Option<i64>,
    pub attempt_seq: i64,
    pub req_headers_json: Option<String>,
    pub req_body_b64: Option<String>,
    pub res_headers_json: Option<String>,
    pub res_body_b64: Option<String>,
    pub is_last_attempt: bool,
}

// ─── Agent Session Observation ──────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct AgentSessionsFilter {
    pub page: u32,
    pub page_size: u32,
    #[serde(default)]
    pub search: String,
    #[serde(default)]
    pub agent_type: String,
    #[serde(default)]
    pub flowlet_status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionRow {
    pub agent_type: String,
    pub session_id: String,
    pub title: Option<String>,
    pub project_path: Option<String>,
    pub parent_session_id: Option<String>,
    pub client_id: Option<String>,
    pub client_name: Option<String>,
    pub native_started_at: Option<String>,
    pub native_updated_at: Option<String>,
    pub activity_at: String,
    pub flowlet_observed: bool,
    pub started_at: String,
    pub updated_at: String,
    pub request_count: i64,
    pub success_count: i64,
    pub error_count: i64,
    pub known_tokens: i64,
    pub input_tokens: i64,
    pub input_cached_tokens: i64,
    pub input_uncached_tokens: i64,
    pub cache_measured_input_tokens: i64,
    pub output_tokens: i64,
    pub unknown_usage_count: i64,
    pub estimated_cost: f64,
    pub native_summary: Option<AgentSessionNativeSummary>,
    pub native_synced_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionsPageResult {
    pub rows: Vec<AgentSessionRow>,
    pub total: i64,
    pub page: u32,
    pub page_size: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionTimeline {
    pub source_available: bool,
    pub truncated: bool,
    pub turn_count: i64,
    pub usage: Option<AgentSessionNativeUsage>,
    pub models: Vec<String>,
    pub events: Vec<AgentSessionTimelineEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionNativeSummary {
    pub source_available: bool,
    pub truncated: bool,
    pub turn_count: i64,
    pub usage: Option<AgentSessionNativeUsage>,
    #[serde(default)]
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionCostEstimate {
    pub amount: Option<f64>,
    pub currency: Option<String>,
    pub source_url: Option<String>,
    pub price_version: Option<String>,
    pub priced_turn_count: i64,
    pub unpriced_turn_count: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionNativeUsage {
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub cache_write_input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
    pub total_tokens: i64,
    pub cost: Option<f64>,
    pub cost_currency: Option<String>,
    #[serde(default)]
    pub api_equivalent: Option<AgentSessionCostEstimate>,
    #[serde(default)]
    pub plan_consumption: Option<AgentSessionCostEstimate>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionTimelineEvent {
    pub id: String,
    pub kind: String,
    pub source: String,
    pub timestamp: Option<String>,
    pub title: Option<String>,
    pub content: Option<String>,
    pub model: Option<String>,
    pub status: Option<String>,
    pub duration_ms: Option<i64>,
    pub time_to_first_token_ms: Option<i64>,
    pub usage: Option<AgentSessionNativeUsage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionRepairResult {
    pub scanned_requests: usize,
    pub repaired_requests: usize,
    pub repaired_logs: usize,
    pub skipped_requests: usize,
}

// ─── Proxy Bind Configuration ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyBindConfig {
    pub host: String,
    pub port: u16,
    pub allow_lan: bool,
    /// 概览页展示的默认客户端 Token。
    #[serde(default = "default_client_token")]
    pub default_client_token: String,
}

fn default_client_token() -> String {
    "flowlet-local-token".to_string()
}

impl Default for ProxyBindConfig {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".to_string(),
            port: 18640,
            allow_lan: false,
            default_client_token: default_client_token(),
        }
    }
}

impl ProxyBindConfig {
    pub fn normalized(mut self) -> Self {
        self.host = if self.allow_lan {
            "0.0.0.0".to_string()
        } else {
            "127.0.0.1".to_string()
        };
        if self.port == 0 {
            self.port = 18640;
        }
        self
    }

    pub fn bind_addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}
// ─── Log Capture Configuration ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogCaptureConfig {
    pub capture_req_headers: bool,
    pub capture_req_body: bool,
    pub capture_res_headers: bool,
    pub capture_res_body: bool,
    pub max_body_bytes: usize,
    /// 是否脱敏敏感 Header（默认 false — 明文记录）。
    /// 开启后，authorization / x-api-key / cookie / set-cookie / x-auth-token 会被替换为 [redacted]。
    pub redact_sensitive_headers: bool,
}

impl Default for LogCaptureConfig {
    fn default() -> Self {
        Self {
            capture_req_headers: true,
            capture_req_body: true,
            capture_res_headers: true,
            capture_res_body: true,
            max_body_bytes: 1024 * 1024,
            redact_sensitive_headers: false,
        }
    }
}

impl LogCaptureConfig {
    pub const fn redacted_header_keys() -> &'static [&'static str] {
        &[
            "authorization",
            "x-api-key",
            "cookie",
            "set-cookie",
            "x-auth-token",
        ]
    }
}
