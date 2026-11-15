use serde::{Deserialize, Serialize};

/// 设备同步快照中携带的本机维度用量聚合行。每台设备在生成快照时，把自身
/// 最近一段时间按 (日期, 客户端, 渠道, 账号, 模型) 聚合的用量附带发出；
/// 接收端导入 `device_usage_breakdowns` 表后，usage_summary 联表即可按设备维度
/// 汇总。字段语义与 `UsageSummaryRow` 一一对应，`device_id` 取自带快照顶层。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceUsageBreakdownRow {
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
    #[serde(default)]
    pub estimated_cost_currency: Option<String>,
    #[serde(default)]
    pub native_event_count: i64,
    pub elapsed_total_ms: i64,
    pub elapsed_measured_count: i64,
    pub generation_total_ms: i64,
    pub generation_output_tokens: i64,
}
