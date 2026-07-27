use super::config::{
    AuthStrategy, ChannelAccount, ChannelPreset, ModelPrice, ModelPriceTier, ProtocolType,
    RouteCandidate,
};
use serde::Deserialize;

/// 编译时随应用固化的默认配置。
///
/// 外部 config.json 仍然优先；这个副本只用于配置缺失、旧版本配置不含
/// `channels_config` 或打包资源路径异常时，避免桌面进程在创建窗口和托盘前退出。
pub const DEFAULT_CONFIG_JSON: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../config.json"));

/// Flowlet 支持模型的官方归属。实际请求可以经任意渠道账号转发，但模型品牌、
/// 官方规格和基准价格始终由模型 ID 决定，不由路由渠道决定。
pub(crate) fn official_channel_id_for_model(model_id: &str) -> Option<&'static str> {
    match model_id.trim().to_lowercase().as_str() {
        "longcat-2.0" => Some("longcat"),
        "deepseek-v4-flash" | "deepseek-v4-pro" => Some("deepseek"),
        "kimi-k3" | "kimi-k2.7-code" => Some("kimi"),
        "qwen3.8-max-preview"
        | "qwen3.7-max"
        | "qwen3.7-plus"
        | "qwen3.6-plus"
        | "qwen3.6-flash" => Some("qwen"),
        _ => None,
    }
}

// ─── JSON 反序列化结构 ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Clone)]
pub struct ChannelConfigJson {
    pub channels: Vec<ChannelJson>,
    #[serde(default)]
    pub model_prices: Vec<ModelPriceJson>,
    #[serde(default)]
    pub default_exposed_models: std::collections::HashMap<String, Vec<String>>,
    #[serde(default)]
    pub flowlet_tiers:
        std::collections::HashMap<String, std::collections::HashMap<String, FlowletTiersJson>>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(untagged)]
pub enum FlowletTiersJson {
    One(String),
    Many(Vec<String>),
}

impl FlowletTiersJson {
    fn into_vec(self) -> Vec<String> {
        match self {
            Self::One(tier) => vec![tier],
            Self::Many(tiers) => tiers,
        }
    }
}

#[derive(Debug, Deserialize, Clone)]
pub struct ChannelJson {
    pub id: String,
    pub name: String,
    pub vendor: String,
    #[serde(default)]
    pub platform_url: Option<String>,
    #[serde(default)]
    pub supported_protocols: Vec<String>,
    #[serde(default)]
    pub openai_base_url: String,
    #[serde(default)]
    pub anthropic_base_url: String,
    #[serde(default)]
    pub openai_auth: String,
    #[serde(default)]
    pub anthropic_auth: String,
    #[serde(default)]
    pub default_model: String,
    #[serde(default)]
    pub small_model: Option<String>,
    #[serde(default)]
    pub supports_model_list: bool,
    #[serde(default)]
    pub supports_model_detail: bool,
    #[serde(default)]
    pub supports_balance_query: bool,
    #[serde(default)]
    pub supports_quota_query: bool,
    #[serde(default)]
    pub supports_usage_query: bool,
    /// 是否支持通过后台 webview 登录控制台并拦截 API 抓取套餐余量。
    #[serde(default)]
    pub supports_scrape_balance: bool,
    /// 渠道级端点覆盖，key 例如 "models" / "model_detail" / "balance"。
    /// 优先于此处的配置，缺失时回退到 openai_base_url 拼接逻辑。
    #[serde(default)]
    pub endpoints: std::collections::HashMap<String, String>,
    /// 控制台抓取配置。key 为渠道内的抓取模式(如 longcat 的 "token_pack" /
    /// "pay_as_you_go"、qwen 的 "token_plan"),value 为该模式的抓取配置。
    #[serde(default)]
    pub scrape: std::collections::HashMap<String, ScrapeModeJson>,
}

/// 单个抓取模式的配置(一份 interceptor_js + 一份 extractor_js + 入口页面)。
#[derive(Debug, Deserialize, Clone)]
pub struct ScrapeModeJson {
    /// 后台 webview 导航到此 URL,页面需自发调用目标 API。
    pub console_url: String,
    /// 可选的第二次导航 URL。多阶段抓取模式下,主 URL 捕获完成后会导航到此
    /// URL 继续捕获(用于 LongCat 等 token 资源包与余额分属不同标签页的场景)。
    #[serde(default)]
    pub console_url_secondary: Option<String>,
    /// 可选的第三次导航 URL。三阶段抓取模式下,第二 URL 捕获完成后会导航到此
    /// URL 继续捕获(用于 LongCat 加载 `/platform/fuel_pack` 以获取完整资源包
    /// 列表,包含已用尽/已过期的包)。
    #[serde(default)]
    pub console_url_tertiary: Option<String>,
    /// 注入到页面的拦截器 JS(IIFE),monkeypatch fetch/XHR 并把匹配响应通过
    /// window.__TAURI_INTERNALS__.invoke("handle_intercepted_response", ...) 回传。
    pub interceptor_js: String,
    /// 解析器 JS(函数声明),函数名需与运行时约定一致:
    ///   - 单响应模式:function extract(raw) -> 结构化对象
    ///   - 聚合模式(aggregate=true):function extract(bundle) -> 结构化对象
    pub extractor_js: String,
    /// 是否需要 Rust 侧聚合多份响应后再调 extractor。
    /// true 时 extractor_js 的函数接收 {mode_key: raw_response, ...}。
    #[serde(default)]
    pub aggregate: bool,
    /// 聚合模式要求的响应槽位列表。aggregate=true 时,只有这些槽位全部到位
    /// 才视为捕获完成。key 与 classify_response_url 返回值一致。
    #[serde(default)]
    pub required_slots: Vec<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct ModelPriceJson {
    pub channel_id: String,
    pub upstream_model: String,
    #[serde(default)]
    pub input_uncached_price: f64,
    #[serde(default)]
    pub input_cached_price: f64,
    #[serde(default)]
    pub input_cache_write_price: Option<f64>,
    #[serde(default)]
    pub output_price: f64,
    #[serde(default)]
    pub tiers: Vec<ModelPriceTier>,
    #[serde(default)]
    pub currency: String,
    #[serde(default)]
    pub unit: String,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub price_version: Option<String>,
}

/// 运行时抓取模式配置(从 ScrapeModeJson 解析后存到这里)。
#[derive(Debug, Clone)]
pub struct ScrapeModeConfig {
    pub console_url: String,
    pub console_url_secondary: Option<String>,
    pub console_url_tertiary: Option<String>,
    pub interceptor_js: String,
    pub extractor_js: String,
    pub aggregate: bool,
    pub required_slots: Vec<String>,
}

// ─── 运行时渠道配置 ─────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ChannelsConfig {
    pub presets: Vec<ChannelPreset>,
    pub prices: Vec<ModelPrice>,
    pub default_exposed_models: std::collections::HashMap<String, Vec<String>>,
    pub flowlet_tiers:
        std::collections::HashMap<String, std::collections::HashMap<String, Vec<String>>>,
    /// 每个渠道的端点覆盖，key 为 channel_id → (endpoint_key → url)
    pub endpoints: std::collections::HashMap<String, std::collections::HashMap<String, String>>,
    /// 每个渠道的抓取配置，key 为 channel_id → (mode_key → ScrapeModeConfig)。
    pub scrape: std::collections::HashMap<String, std::collections::HashMap<String, ScrapeModeConfig>>,
}

impl ChannelsConfig {
    /// 从 config.json 顶层对象的 `channels_config` 字段解析渠道配置。
    pub fn from_config_json(config_json: &serde_json::Value) -> Result<Self, String> {
        let channels_config = config_json
            .get("channels_config")
            .ok_or_else(|| "config.json 中缺少 channels_config 字段".to_string())?;

        let json: ChannelConfigJson = serde_json::from_value(channels_config.clone())
            .map_err(|e| format!("解析 config.json > channels_config 失败: {e}"))?;

        let now = chrono::Utc::now().to_rfc3339();

        // 必须先 borrow 出 endpoints（不能与下面的 into_iter 同周期 move）
        let endpoints: std::collections::HashMap<
            String,
            std::collections::HashMap<String, String>,
        > = json
            .channels
            .iter()
            .map(|c| (c.id.clone(), c.endpoints.clone()))
            .collect();

        // 提前提取 scrape 配置(避免与下面的 into_iter 同周期 move json.channels)
        let scrape: std::collections::HashMap<
            String,
            std::collections::HashMap<String, ScrapeModeConfig>,
        > = json
            .channels
            .iter()
            .map(|c| {
                let modes: std::collections::HashMap<String, ScrapeModeConfig> = c
                    .scrape
                    .iter()
                    .map(|(mode_key, mode_json)| {
                        (
                            mode_key.clone(),
                            ScrapeModeConfig {
                                console_url: mode_json.console_url.clone(),
                                console_url_secondary: mode_json.console_url_secondary.clone(),
                                console_url_tertiary: mode_json.console_url_tertiary.clone(),
                                interceptor_js: mode_json.interceptor_js.clone(),
                                extractor_js: mode_json.extractor_js.clone(),
                                aggregate: mode_json.aggregate,
                                required_slots: mode_json.required_slots.clone(),
                            },
                        )
                    })
                    .collect();
                (c.id.clone(), modes)
            })
            .collect();

        let presets: Vec<ChannelPreset> = json
            .channels
            .into_iter()
            .map(|c| {
                let protocols = parse_protocols(&c.supported_protocols);
                ChannelPreset {
                    id: c.id,
                    name: c.name,
                    vendor: c.vendor,
                    supported_protocols: protocols,
                    openai_base_url: c.openai_base_url,
                    anthropic_base_url: c.anthropic_base_url,
                    openai_auth: parse_auth_strategy(&c.openai_auth),
                    anthropic_auth: parse_auth_strategy(&c.anthropic_auth),
                    default_model: c.default_model,
                    small_model: c.small_model,
                    timeout_seconds: None,
                    supports_model_list: c.supports_model_list,
                    supports_model_detail: c.supports_model_detail,
                    supports_balance_query: c.supports_balance_query,
                    supports_quota_query: c.supports_quota_query,
                    supports_usage_query: c.supports_usage_query,
                    supports_scrape_balance: c.supports_scrape_balance,
                    platform_url: c.platform_url,
                    enabled: true,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                }
            })
            .collect();

        let prices: Vec<ModelPrice> = json
            .model_prices
            .into_iter()
            .map(|p| ModelPrice {
                id: format!("price-{}-{}", p.channel_id, p.upstream_model),
                channel_id: p.channel_id,
                upstream_model: p.upstream_model,
                input_uncached_price: p.input_uncached_price,
                input_cached_price: p.input_cached_price,
                input_cache_write_price: p.input_cache_write_price,
                output_price: p.output_price,
                tiers: p.tiers,
                currency: p.currency,
                unit: p.unit,
                source_url: p.source_url,
                price_version: p.price_version,
                created_at: now.clone(),
                updated_at: now.clone(),
            })
            .collect();

        let flowlet_tiers = json
            .flowlet_tiers
            .into_iter()
            .map(|(channel_id, models)| {
                let models = models
                    .into_iter()
                    .map(|(model, tiers)| (model, tiers.into_vec()))
                    .collect();
                (channel_id, models)
            })
            .collect();

        Ok(Self {
            presets,
            prices,
            default_exposed_models: json.default_exposed_models,
            flowlet_tiers,
            endpoints,
            scrape,
        })
    }

    /// 获取指定渠道、指定模式的抓取配置。
    pub fn scrape_config(
        &self,
        channel_id: &str,
        mode_key: &str,
    ) -> Option<&ScrapeModeConfig> {
        self.scrape.get(channel_id)?.get(mode_key)
    }

    /// 获取指定渠道的所有抓取模式 key 列表(用于 UI 或服务端分发)。
    pub fn scrape_mode_keys(&self, channel_id: &str) -> Vec<String> {
        self.scrape
            .get(channel_id)
            .map(|modes| modes.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// 从指定渠道的 endpoints 覆盖中读取一个端点 URL，缺失时调用
    /// fallback 基于 openai_base_url 拼接，再缺失则返回 default。
    fn endpoint_or<F>(&self, channel_id: &str, key: &str, fallback: F) -> String
    where
        F: FnOnce(&ChannelPreset) -> String,
    {
        if let Some(overrides) = self.endpoints.get(channel_id) {
            if let Some(url) = overrides.get(key) {
                return url.clone();
            }
        }
        self.presets
            .iter()
            .find(|c| c.id == channel_id)
            .map(fallback)
            .filter(|s| !s.is_empty())
            .unwrap_or_default()
    }

    /// 获取 DeepSeek 余额端点
    pub fn balance_endpoint(&self) -> String {
        self.endpoint_or("deepseek", "balance", |c| {
            format!("{}/user/balance", c.openai_base_url)
        })
    }

    /// 获取 LongCat 模型列表端点
    pub fn longcat_models_endpoint(&self) -> String {
        self.endpoint_or("longcat", "models", |c| {
            format!("{}/v1/models", c.openai_base_url)
        })
    }

    /// 获取 LongCat 模型详情端点模板
    pub fn longcat_model_detail_endpoint(&self) -> String {
        self.endpoint_or("longcat", "model_detail", |c| {
            format!("{}/v1/models/{{id}}", c.openai_base_url)
        })
    }

    /// 获取 Kimi 模型列表端点
    pub fn kimi_models_endpoint(&self) -> String {
        self.endpoint_or("kimi", "models", |c| {
            format!("{}/models", c.openai_base_url)
        })
    }

    /// 获取 Kimi 余额端点
    pub fn kimi_balance_endpoint(&self) -> String {
        self.endpoint_or("kimi", "balance", |c| {
            format!("{}/users/me/balance", c.openai_base_url)
        })
    }

    /// 获取 DeepSeek 模型列表端点
    pub fn deepseek_models_endpoint(&self) -> String {
        self.endpoint_or("deepseek", "models", |c| {
            format!("{}/models", c.openai_base_url)
        })
    }

    /// 获取千问 Qwen 模型列表端点
    pub fn qwen_models_endpoint(&self) -> String {
        self.endpoint_or("qwen", "models", |c| {
            format!("{}/models", c.openai_base_url.trim_end_matches('/'))
        })
    }

    /// 获取模型所属的全部 Flowlet 档位（按渠道查找，保留以兼容旧调用点）。
    pub fn flowlet_tiers(&self, channel_id: &str, model: &str) -> Vec<String> {
        let normalized = model.trim().to_lowercase();
        self.flowlet_tiers
            .get(channel_id)
            .and_then(|m| m.get(&normalized))
            .cloned()
            .unwrap_or_default()
    }

    /// 获取模型所属的全部 Flowlet 档位（全局查找，不按渠道区分）。
    /// 同一上游模型在任何渠道账号下都应得到相同的聚合档位，与「我们总共支持哪些模型」
    /// 的全局白名单语义一致。用于路由生成。
    pub fn flowlet_tiers_for_model(&self, model: &str) -> Vec<String> {
        let normalized = model.trim().to_lowercase();
        self.flowlet_tiers
            .values()
            .find_map(|channel_tiers| channel_tiers.get(&normalized).cloned())
            .unwrap_or_default()
    }

    /// 获取默认开放模型列表（按渠道）。
    /// 仅用于渠道预设的配置漂移检测（preset-sync），不再作为开放模型的白名单。
    /// 白名单请使用 supported_models()（所有渠道的并集）。
    pub fn default_exposed_models(&self, channel_id: &str) -> Vec<String> {
        self.default_exposed_models
            .get(channel_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Flowlet 支持开放的上游模型全集（所有渠道的并集，含 Token Plan 专属模型）。
    /// 任意渠道账号只要底层 /models 返回了其中的模型，就可勾选开放——不再按渠道区分。
    /// 必须与 src/domains/channel/types.ts 的 FLOWLET_SUPPORTED_MODELS 保持一致。
    pub fn supported_models(&self) -> Vec<String> {
        let mut models: Vec<String> = self
            .default_exposed_models
            .values()
            .flatten()
            .cloned()
            .chain(QWEN_TOKEN_PLAN_DEFAULT_MODELS.iter().map(|m| m.to_string()))
            .collect();
        // 去重（保持首次出现顺序）
        let mut seen = std::collections::HashSet::new();
        models.retain(|m| seen.insert(m.clone()));
        models
    }

    /// 为现有账号补齐「用户已勾选开放」的直连模型与 Flowlet 聚合模型路由。
    ///
    /// 只追加缺失签名，不覆盖用户已有的启停状态、优先级和时间戳（删除取消勾选的
    /// 路由由前端保存时的对账逻辑负责）。全局最早创建账号的新路由默认开启，后续
    /// 所有官方或自定义账号的新路由默认关闭，等待用户手动开启。
    ///
    /// 候选上游模型 = 用户在账号编辑器中勾选的 `exposed_models` ∩ 最近一次
    /// `/models` 返回的 `synced_models` ∩ 全局支持模型集。白名单不按渠道区分——
    /// 任意账号只要其 `/models` 返回了 Flowlet 支持的模型，就可勾选开放。
    /// - `exposed_models = None`：账号尚未用新流程配置过，不生成任何路由（保持现状）。
    /// - `exposed_models = Some(list)`（可为空）：仅为列表中的模型补齐路由。
    pub fn merge_default_routes(
        &self,
        existing: &[RouteCandidate],
        accounts: &[ChannelAccount],
        presets: &[ChannelPreset],
    ) -> Vec<RouteCandidate> {
        let mut merged = existing.to_vec();
        let mut signatures: std::collections::HashSet<String> =
            existing.iter().map(route_signature).collect();
        let now = chrono::Utc::now().to_rfc3339();
        // 所有渠道（包括 custom）统一使用全局支持模型白名单。
        let whitelist = self.supported_models();
        // 账号列表从 SQLite 读取时按渠道排序，不能用数组下标判断“第一个账号”。
        // 使用全局 created_at（同时间再按 id）确定最早账号；仅它的新路由默认开启。
        let first_account_id = accounts
            .iter()
            .min_by(|a, b| {
                a.created_at
                    .trim()
                    .cmp(b.created_at.trim())
                    .then_with(|| a.id.cmp(&b.id))
            })
            .map(|account| account.id.as_str());

        for preset in presets {
            for protocol in &preset.supported_protocols {
                for (account_index, account) in accounts
                    .iter()
                    .filter(|account| {
                        account.channel_id == preset.id
                            && account.enabled
                            // Token Plan 账号无传统 API Key，用 resource_mode 判定
                            && (!account.api_key.trim().is_empty()
                                || is_qwen_token_plan_account(account))
                    })
                    .enumerate()
                {
                    let protocol_has_endpoint = if preset.vendor == "custom" {
                        match protocol {
                            ProtocolType::OpenAi => account
                                .base_url_override
                                .as_deref()
                                .is_some_and(|url| !url.trim().is_empty()),
                            ProtocolType::Anthropic => account
                                .anthropic_base_url_override
                                .as_deref()
                                .is_some_and(|url| !url.trim().is_empty()),
                        }
                    } else {
                        true
                    };
                    if !protocol_has_endpoint {
                        continue;
                    }
                    // 候选 = exposed_models ∩ synced_models ∩ 全局支持模型集。
                    // exposed_models 为 None（未配置）或空 → 不生成路由。
                    let exposed = account.exposed_models.as_deref().unwrap_or(&[]);
                    let exposed_set: std::collections::HashSet<String> =
                        exposed.iter().map(|m| m.trim().to_lowercase()).collect();
                    let synced_set: std::collections::HashSet<String> = account
                        .synced_models
                        .as_deref()
                        .unwrap_or(&[])
                        .iter()
                        .map(|m| m.trim().to_lowercase())
                        .collect();
                    let upstream_models: Vec<String> = if exposed.is_empty() {
                        Vec::new()
                    } else {
                        whitelist
                            .iter()
                            .filter(|m| {
                                let key = m.trim().to_lowercase();
                                exposed_set.contains(&key) && synced_set.contains(&key)
                            })
                            .cloned()
                            .collect()
                    };
                    for (model_index, upstream_model) in upstream_models.iter().enumerate() {
                        // 档位映射按模型全局查找（不按渠道），与全局白名单语义一致。
                        let tiers = self.flowlet_tiers_for_model(upstream_model);
                        let public_models: Vec<String> = std::iter::once(upstream_model.clone())
                            .chain(tiers.into_iter().map(|tier| format!("flowlet-{tier}")))
                            .collect();
                        for public_model in &public_models {
                            let route = RouteCandidate {
                                id: if public_model == upstream_model {
                                    format!(
                                        "route-{}-{}-{}-{}-{}",
                                        account.id,
                                        upstream_model,
                                        protocol.as_str(),
                                        model_index,
                                        account_index
                                    )
                                } else {
                                    format!(
                                        "route-{}-{}-{}-{}-{}-{}",
                                        account.id,
                                        public_model,
                                        upstream_model,
                                        protocol.as_str(),
                                        model_index,
                                        account_index
                                    )
                                },
                                virtual_model_id: public_model.clone(),
                                channel_id: preset.id.clone(),
                                account_id: account.id.clone(),
                                upstream_model: upstream_model.clone(),
                                client_protocol: protocol.clone(),
                                priority: account_index as i64,
                                enabled: first_account_id == Some(account.id.as_str()),
                                created_at: now.clone(),
                                updated_at: now.clone(),
                            };
                            if signatures.insert(route_signature(&route)) {
                                merged.push(route);
                            }
                        }
                    }
                }
            }
        }

        merged
    }

    /// 获取指定渠道的 models 端点 URL（用于测试连接）。
    /// 优先使用配置中 endpoints["models"] 覆盖，缺失时按渠道拼接。
    pub fn models_endpoint_url(&self, channel_id: &str) -> Option<String> {
        // 1. 配置的显式覆盖
        if let Some(overrides) = self.endpoints.get(channel_id) {
            if let Some(url) = overrides.get("models") {
                return Some(url.clone());
            }
        }
        // 2. 按老逻辑拼接
        self.presets.iter().find(|c| c.id == channel_id).map(|c| {
            if c.id == "kimi" {
                format!("{}/models", c.openai_base_url)
            } else if c.id == "deepseek" {
                format!("{}/models", c.openai_base_url)
            } else if c.id == "qwen" {
                // 千问 openai_base_url 以 /v1 结尾，直接拼 /models
                format!("{}/models", c.openai_base_url.trim_end_matches('/'))
            } else {
                format!("{}/v1/models", c.openai_base_url)
            }
        })
    }
}

fn route_signature(route: &RouteCandidate) -> String {
    [
        route.virtual_model_id.as_str(),
        route.channel_id.as_str(),
        route.account_id.as_str(),
        route.upstream_model.as_str(),
        route.client_protocol.as_str(),
    ]
    .join("\0")
}

/// 千问 Token Plan 账号的默认开放模型（套餐专属：qwen3.8-max-preview 仅订阅可用）。
/// 必须与 src/domains/channel/types.ts 的 QWEN_TOKEN_PLAN_DEFAULT_MODELS 保持一致。
const QWEN_TOKEN_PLAN_DEFAULT_MODELS: [&str; 2] = ["qwen3.8-max-preview", "qwen3.6-flash"];

/// 判断账号是否为千问 Token Plan 订阅模式（sk-sp 专属 Key + 套餐端点，
/// 通过账号级 Base URL 覆盖接入）。
fn is_qwen_token_plan_account(account: &ChannelAccount) -> bool {
    account.channel_id == "qwen" && account.resource_mode.as_deref() == Some("token_plan")
}

fn parse_protocols(raw: &[String]) -> Vec<ProtocolType> {
    raw.iter()
        .map(|p| match p.as_str() {
            "anthropic" => ProtocolType::Anthropic,
            _ => ProtocolType::OpenAi,
        })
        .collect()
}

fn parse_auth_strategy(raw: &str) -> AuthStrategy {
    match raw {
        "x_api_key" => AuthStrategy::XApiKey,
        _ => AuthStrategy::Bearer,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_minimal_config() {
        let json = serde_json::json!({
            "channels_config": {
                "channels": [{
                    "id": "test",
                    "name": "Test",
                    "vendor": "test"
                }],
                "model_prices": [],
                "default_exposed_models": {},
                "flowlet_tiers": {}
            }
        });
        let config = ChannelsConfig::from_config_json(&json).unwrap();
        assert_eq!(config.presets.len(), 1);
        assert_eq!(config.presets[0].id, "test");
        assert_eq!(config.endpoints.len(), 1);
    }

    #[test]
    fn parse_full_config() {
        let json = serde_json::json!({
            "channels_config": {
                "channels": [{
                    "id": "deepseek",
                    "name": "DeepSeek",
                    "vendor": "deepseek",
                    "supported_protocols": ["openai", "anthropic"],
                    "openai_base_url": "https://api.deepseek.com",
                    "anthropic_base_url": "https://api.deepseek.com/anthropic",
                    "openai_auth": "bearer",
                    "anthropic_auth": "x_api_key",
                    "default_model": "deepseek-v4-pro",
                    "supports_model_list": true,
                    "supports_balance_query": true,
                    "endpoints": {
                        "models": "https://api.deepseek.com/models",
                        "balance": "https://api.deepseek.com/user/balance"
                    }
                }],
                "model_prices": [{
                    "channel_id": "deepseek",
                    "upstream_model": "deepseek-v4-flash",
                    "input_uncached_price": 1.0,
                    "output_price": 2.0,
                    "currency": "CNY",
                    "unit": "1M tokens"
                }],
                "default_exposed_models": {
                    "deepseek": ["deepseek-v4-flash"]
                },
                "flowlet_tiers": {
                    "deepseek": {
                        "deepseek-v4-flash": "flash"
                    }
                }
            }
        });
        let config = ChannelsConfig::from_config_json(&json).unwrap();
        assert_eq!(config.presets.len(), 1);
        assert_eq!(config.prices.len(), 1);
        assert_eq!(
            config.default_exposed_models("deepseek"),
            vec!["deepseek-v4-flash".to_string()]
        );
        assert_eq!(
            config.flowlet_tiers("deepseek", "deepseek-v4-flash"),
            vec!["flash".to_string()]
        );
        // 覆盖端点生效
        assert_eq!(
            config.deepseek_models_endpoint(),
            "https://api.deepseek.com/models"
        );
        assert_eq!(
            config.balance_endpoint(),
            "https://api.deepseek.com/user/balance"
        );
        assert_eq!(
            config.models_endpoint_url("deepseek").as_deref(),
            Some("https://api.deepseek.com/models")
        );
    }

    #[test]
    fn embedded_prices_cover_all_current_codex_models_in_both_dimensions() {
        let json: serde_json::Value = serde_json::from_str(DEFAULT_CONFIG_JSON).unwrap();
        let config = ChannelsConfig::from_config_json(&json).unwrap();
        let current_models = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"];

        for model in current_models {
            let api_price = config
                .prices
                .iter()
                .find(|price| price.channel_id == "openai-api" && price.upstream_model == model)
                .unwrap_or_else(|| panic!("missing OpenAI API price for {model}"));
            assert_eq!(api_price.currency, "USD");
            assert!(api_price.input_uncached_price > 0.0);
            assert!(api_price.output_price > 0.0);

            let plan_price = config
                .prices
                .iter()
                .find(|price| price.channel_id == "codex-native" && price.upstream_model == model)
                .unwrap_or_else(|| panic!("missing Codex credits price for {model}"));
            assert_eq!(plan_price.currency, "CREDITS");
            assert!(plan_price.input_uncached_price > 0.0);
            assert!(plan_price.output_price > 0.0);
        }
    }

    #[test]
    fn embedded_qwen_prices_match_latest_major_pricing() {
        let json: serde_json::Value = serde_json::from_str(DEFAULT_CONFIG_JSON).unwrap();
        let config = ChannelsConfig::from_config_json(&json).unwrap();

        // qwen3.7-plus：分级计价（≤256k / >256k），长上下文档更贵
        let plus = config
            .prices
            .iter()
            .find(|p| p.channel_id == "qwen" && p.upstream_model == "qwen3.7-plus")
            .expect("missing qwen3.7-plus price");
        assert_eq!(plus.tiers.len(), 2);
        assert_eq!(plus.tiers[0].up_to_input_tokens, Some(262144));
        assert_eq!(plus.tiers[1].up_to_input_tokens, None);
        assert!(plus.tiers[1].input_uncached_price > plus.tiers[0].input_uncached_price);
        assert!(plus.tiers[1].output_price > plus.tiers[0].output_price);

        // qwen3.7-max：主模型 MAJOR 目录价×0.5，扁平单价（无分级）
        let max = config
            .prices
            .iter()
            .find(|p| p.channel_id == "qwen" && p.upstream_model == "qwen3.7-max")
            .expect("missing qwen3.7-max price");
        assert!(max.tiers.is_empty());
        assert!((max.input_uncached_price - 6.0).abs() < 1e-9);
        assert!((max.input_cached_price - 1.2).abs() < 1e-9);
        assert!((max.input_cache_write_price.unwrap_or(0.0) - 7.5).abs() < 1e-9);
        assert!((max.output_price - 18.0).abs() < 1e-9);

        // qwen3.6-plus：分级计价，输入/输出/缓存无折扣；缓存命中取显式缓存读取价
        let plus36 = config
            .prices
            .iter()
            .find(|p| p.channel_id == "qwen" && p.upstream_model == "qwen3.6-plus")
            .expect("missing qwen3.6-plus price");
        assert_eq!(plus36.tiers.len(), 2);
        assert!((plus36.tiers[0].input_uncached_price - 2.0).abs() < 1e-9);
        assert!((plus36.tiers[0].output_price - 12.0).abs() < 1e-9);
        assert!((plus36.tiers[1].input_uncached_price - 8.0).abs() < 1e-9);
        assert!((plus36.tiers[1].output_price - 48.0).abs() < 1e-9);

        // qwen3.6-flash：分级计价，>256k 档单价为 ≤256k 档的 4 倍
        let flash36 = config
            .prices
            .iter()
            .find(|p| p.channel_id == "qwen" && p.upstream_model == "qwen3.6-flash")
            .expect("missing qwen3.6-flash price");
        assert_eq!(flash36.tiers.len(), 2);
        assert!((flash36.tiers[0].input_uncached_price - 1.2).abs() < 1e-9);
        assert!((flash36.tiers[0].output_price - 7.2).abs() < 1e-9);
        assert!((flash36.tiers[1].input_uncached_price - 4.8).abs() < 1e-9);
        assert!((flash36.tiers[1].output_price - 28.8).abs() < 1e-9);

        // qwen3.8-max-preview：暂无公开单价，不应配置价格（不用其他模型替代）
        assert!(
            !config
                .prices
                .iter()
                .any(|p| p.channel_id == "qwen" && p.upstream_model == "qwen3.8-max-preview"),
            "qwen3.8-max-preview should have no price entry"
        );
    }

    #[test]
    fn maps_one_upstream_model_to_multiple_flowlet_tiers() {
        let json = serde_json::json!({
            "channels_config": {
                "channels": [{
                    "id": "longcat",
                    "name": "LongCat",
                    "vendor": "longcat",
                    "supported_protocols": ["openai", "anthropic"]
                }],
                "default_exposed_models": {
                    "longcat": ["LongCat-2.0"]
                },
                "flowlet_tiers": {
                    "longcat": {
                        "longcat-2.0": ["pro", "flash"]
                    }
                }
            }
        });
        let config = ChannelsConfig::from_config_json(&json).unwrap();
        let account = ChannelAccount {
            id: "longcat-account".to_string(),
            channel_id: "longcat".to_string(),
            api_key: "sk-test".to_string(),
            enabled: true,
            exposed_models: Some(vec!["LongCat-2.0".to_string()]),
            synced_models: Some(vec!["LongCat-2.0".to_string()]),
            ..Default::default()
        };

        let routes = config.merge_default_routes(&[], &[account], &config.presets);
        assert_eq!(routes.len(), 6);
        for protocol in [ProtocolType::OpenAi, ProtocolType::Anthropic] {
            let public_models: Vec<&str> = routes
                .iter()
                .filter(|route| route.client_protocol == protocol)
                .map(|route| route.virtual_model_id.as_str())
                .collect();
            assert_eq!(
                public_models,
                vec!["LongCat-2.0", "flowlet-pro", "flowlet-flash"]
            );
        }
    }

    #[test]
    fn merge_default_routes_enables_only_the_globally_first_account() {
        let json = serde_json::json!({
            "channels_config": {
                "channels": [{
                    "id": "longcat",
                    "name": "LongCat",
                    "vendor": "longcat",
                    "supported_protocols": ["openai"]
                }],
                "default_exposed_models": {
                    "longcat": ["LongCat-2.0"]
                }
            }
        });
        let config = ChannelsConfig::from_config_json(&json).unwrap();
        let later = ChannelAccount {
            id: "account-later".to_string(),
            channel_id: "longcat".to_string(),
            api_key: "sk-later".to_string(),
            enabled: true,
            exposed_models: Some(vec!["LongCat-2.0".to_string()]),
            synced_models: Some(vec!["LongCat-2.0".to_string()]),
            created_at: "2026-07-02T00:00:00Z".to_string(),
            ..Default::default()
        };
        let first = ChannelAccount {
            id: "account-first".to_string(),
            channel_id: "longcat".to_string(),
            api_key: "sk-first".to_string(),
            enabled: true,
            exposed_models: Some(vec!["LongCat-2.0".to_string()]),
            synced_models: Some(vec!["LongCat-2.0".to_string()]),
            created_at: "2026-07-01T00:00:00Z".to_string(),
            ..Default::default()
        };

        // 故意把后创建账号放在前面，避免测试意外依赖数组或渠道排序。
        let routes =
            config.merge_default_routes(&[], &[later, first], &config.presets);

        assert_eq!(
            routes
                .iter()
                .filter(|route| route.account_id == "account-first")
                .count(),
            1
        );
        assert_eq!(
            routes
                .iter()
                .filter(|route| route.account_id == "account-later")
                .count(),
            1
        );
        assert!(routes
            .iter()
            .filter(|route| route.account_id == "account-first")
            .all(|route| route.enabled));
        assert!(routes
            .iter()
            .filter(|route| route.account_id == "account-later")
            .all(|route| !route.enabled));
    }

    #[test]
    fn qwen_models_endpoint_avoids_double_v1() {
        let json = serde_json::json!({
            "channels_config": {
                "channels": [{
                    "id": "qwen",
                    "name": "千问 Qwen",
                    "vendor": "qwen",
                    "supported_protocols": ["openai", "anthropic"],
                    "openai_base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                    "anthropic_base_url": "https://dashscope.aliyuncs.com/apps/anthropic"
                }]
            }
        });
        let config = ChannelsConfig::from_config_json(&json).unwrap();
        // openai_base_url 已以 /v1 结尾，拼 models 时不得再补 /v1
        assert_eq!(
            config.qwen_models_endpoint(),
            "https://dashscope.aliyuncs.com/compatible-mode/v1/models"
        );
        assert_eq!(
            config.models_endpoint_url("qwen").as_deref(),
            Some("https://dashscope.aliyuncs.com/compatible-mode/v1/models")
        );
    }

    #[test]
    fn merge_default_routes_uses_global_supported_models_any_channel() {
        // 白名单为全局支持模型集（所有渠道的并集），不再按渠道/套餐区分。
        // 本测试验证：千问账号勾选「其它渠道的模型」(deepseek-v4-pro) 也能生成路由。
        let json = serde_json::json!({
            "channels_config": {
                "channels": [
                    {
                        "id": "qwen",
                        "name": "千问 Qwen",
                        "vendor": "qwen",
                        "supported_protocols": ["openai", "anthropic"],
                        "openai_base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                        "anthropic_base_url": "https://dashscope.aliyuncs.com/apps/anthropic"
                    },
                    {
                        "id": "deepseek",
                        "name": "DeepSeek",
                        "vendor": "deepseek",
                        "supported_protocols": ["openai", "anthropic"],
                        "openai_base_url": "https://api.deepseek.com/v1",
                        "anthropic_base_url": "https://api.deepseek.com"
                    }
                ],
                "default_exposed_models": {
                    "qwen": ["qwen3.7-max", "qwen3.6-flash"],
                    "deepseek": ["deepseek-v4-flash", "deepseek-v4-pro"]
                },
                "flowlet_tiers": {
                    "qwen": {
                        "qwen3.7-max": "pro",
                        "qwen3.6-flash": "flash",
                        "qwen3.8-max-preview": "pro"
                    },
                    "deepseek": {
                        "deepseek-v4-pro": "pro",
                        "deepseek-v4-flash": "flash"
                    }
                }
            }
        });
        let config = ChannelsConfig::from_config_json(&json).unwrap();

        // 千问账号勾选了原属 DeepSeek 渠道的 deepseek-v4-pro：全局白名单下应可开放。
        let qwen_account = ChannelAccount {
            id: "qwen-cross".to_string(),
            channel_id: "qwen".to_string(),
            api_key: "sk-test".to_string(),
            enabled: true,
            exposed_models: Some(vec![
                "deepseek-v4-pro".to_string(),
                "qwen3.6-flash".to_string(),
            ]),
            synced_models: Some(vec![
                "deepseek-v4-pro".to_string(),
                "qwen3.6-flash".to_string(),
            ]),
            ..Default::default()
        };
        let routes = config.merge_default_routes(&[], &[qwen_account], &config.presets);
        let upstream_models: std::collections::HashSet<&str> =
            routes.iter().map(|r| r.upstream_model.as_str()).collect();
        assert_eq!(
            upstream_models,
            std::collections::HashSet::from(["deepseek-v4-pro", "qwen3.6-flash"])
        );
        // deepseek-v4-pro 应进入 flowlet-pro 聚合路由（沿用 deepseek 渠道的档位映射）。
        assert!(routes.iter().any(|route| {
            route.virtual_model_id == "flowlet-pro" && route.upstream_model == "deepseek-v4-pro"
        }));
        // 全局白名单外的模型仍被防御过滤。
        let with_stranger = ChannelAccount {
            id: "qwen-stranger".to_string(),
            channel_id: "qwen".to_string(),
            api_key: "sk-test".to_string(),
            enabled: true,
            exposed_models: Some(vec![
                "deepseek-v4-pro".to_string(),
                "some-random-model".to_string(),
            ]),
            synced_models: Some(vec![
                "deepseek-v4-pro".to_string(),
                "some-random-model".to_string(),
            ]),
            ..Default::default()
        };
        let routes = config.merge_default_routes(&[], &[with_stranger], &config.presets);
        let upstream_models: std::collections::HashSet<&str> =
            routes.iter().map(|r| r.upstream_model.as_str()).collect();
        assert!(!upstream_models.contains("some-random-model"));
        assert!(upstream_models.contains("deepseek-v4-pro"));
    }

    #[test]
    fn supported_models_is_union_of_all_channels_plus_token_plan() {
        let json = serde_json::json!({
            "channels_config": {
                "channels": [{
                    "id": "qwen",
                    "name": "千问 Qwen",
                    "vendor": "qwen",
                    "supported_protocols": ["openai", "anthropic"],
                    "openai_base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                    "anthropic_base_url": "https://dashscope.aliyuncs.com/apps/anthropic"
                }],
                "default_exposed_models": {
                    "qwen": ["qwen3.7-max", "qwen3.6-flash"]
                }
            }
        });
        let config = ChannelsConfig::from_config_json(&json).unwrap();
        let supported: std::collections::HashSet<String> = config.supported_models().into_iter().collect();
        // 渠道列表 + Token Plan 专属模型(qwen3.8-max-preview) 的并集。
        for expected in ["qwen3.7-max", "qwen3.6-flash", "qwen3.8-max-preview"] {
            assert!(supported.contains(expected), "缺少支持的模型: {expected}");
        }
        // 去重：qwen3.6-flash 同时出现在渠道列表与 Token Plan 列表，只出现一次。
        assert_eq!(
            config.supported_models().iter().filter(|m| *m == "qwen3.6-flash").count(),
            1
        );
    }

    #[test]
    fn merge_default_routes_uses_user_selected_exposed_models() {
        let json = serde_json::json!({
            "channels_config": {
                "channels": [{
                    "id": "deepseek",
                    "name": "DeepSeek",
                    "vendor": "deepseek",
                    "supported_protocols": ["openai", "anthropic"],
                    "openai_base_url": "https://api.deepseek.com/v1",
                    "anthropic_base_url": "https://api.deepseek.com"
                }],
                "default_exposed_models": {
                    "deepseek": ["deepseek-v4-flash", "deepseek-v4-pro"]
                }
            }
        });
        let config = ChannelsConfig::from_config_json(&json).unwrap();

        // 1) exposed_models = None（尚未配置）→ 不生成任何路由，保持现状。
        let unconfigured = ChannelAccount {
            id: "deepseek-new".to_string(),
            channel_id: "deepseek".to_string(),
            api_key: "sk-test".to_string(),
            enabled: true,
            ..Default::default()
        };
        assert!(config
            .merge_default_routes(&[], &[unconfigured], &config.presets)
            .is_empty());

        // 2) 仅为用户勾选的模型生成路由；与白名单取交集做防御（白名单外即使被勾选也过滤）。
        let selected = ChannelAccount {
            id: "deepseek-selected".to_string(),
            channel_id: "deepseek".to_string(),
            api_key: "sk-test".to_string(),
            enabled: true,
            exposed_models: Some(vec![
                "deepseek-v4-flash".to_string(),
                "deepseek-chat".to_string(), // 白名单外，应被过滤
            ]),
            synced_models: Some(vec![
                "deepseek-v4-flash".to_string(),
                "deepseek-chat".to_string(),
            ]),
            ..Default::default()
        };
        let routes = config.merge_default_routes(&[], &[selected], &config.presets);
        let upstream_models: std::collections::HashSet<&str> =
            routes.iter().map(|r| r.upstream_model.as_str()).collect();
        assert_eq!(
            upstream_models,
            std::collections::HashSet::from(["deepseek-v4-flash"])
        );
        // 未勾选的 deepseek-v4-pro 不应出现。
        assert!(!upstream_models.contains("deepseek-v4-pro"));
        // 白名单外的 deepseek-chat 不应出现。
        assert!(!upstream_models.contains("deepseek-chat"));

        // 3) exposed_models 为空列表 → 不开放任何模型。
        let none_selected = ChannelAccount {
            id: "deepseek-empty".to_string(),
            channel_id: "deepseek".to_string(),
            api_key: "sk-test".to_string(),
            enabled: true,
            exposed_models: Some(vec![]),
            synced_models: Some(vec![]),
            ..Default::default()
        };
        assert!(config
            .merge_default_routes(&[], &[none_selected], &config.presets)
            .is_empty());

        // 4) 只追加不删除：已有路由保留（删除取消勾选由前端对账负责）。
        let existing = routes.first().cloned().unwrap();
        let existing_id = existing.id.clone();
        let selected_account = ChannelAccount {
            id: "deepseek-selected".to_string(),
            channel_id: "deepseek".to_string(),
            api_key: "sk-test".to_string(),
            enabled: true,
            exposed_models: Some(vec!["deepseek-v4-flash".to_string()]),
            synced_models: Some(vec!["deepseek-v4-flash".to_string()]),
            ..Default::default()
        };
        let merged = config.merge_default_routes(&[existing], &[selected_account], &config.presets);
        assert_eq!(merged.len(), routes.len());
        assert!(merged.iter().any(|r| r.id == existing_id));

        // 5) 即使模型在全局白名单且仍被勾选，只要最新 /models 未返回，也不生成路由。
        let missing_from_models = ChannelAccount {
            id: "deepseek-stale".to_string(),
            channel_id: "deepseek".to_string(),
            api_key: "sk-test".to_string(),
            enabled: true,
            exposed_models: Some(vec!["deepseek-v4-pro".to_string()]),
            synced_models: Some(vec!["deepseek-v4-flash".to_string()]),
            ..Default::default()
        };
        assert!(
            config
                .merge_default_routes(&[], &[missing_from_models], &config.presets)
                .is_empty()
        );
    }

    #[test]
    fn custom_channel_uses_global_whitelist_and_only_configured_protocols() {
        let json = serde_json::json!({
            "channels_config": {
                "channels": [{
                    "id": "custom",
                    "name": "自定义渠道",
                    "vendor": "custom",
                    "supported_protocols": ["openai", "anthropic"],
                    "openai_base_url": "",
                    "anthropic_base_url": ""
                }],
                "default_exposed_models": {
                    "deepseek": ["deepseek-v4-pro"]
                }
            }
        });
        let config = ChannelsConfig::from_config_json(&json).unwrap();
        let account = ChannelAccount {
            id: "custom-relay".to_string(),
            channel_id: "custom".to_string(),
            api_key: "sk-test".to_string(),
            enabled: true,
            base_url_override: Some("https://relay.example/v1".to_string()),
            anthropic_base_url_override: None,
            exposed_models: Some(vec![
                "deepseek-v4-pro".to_string(),
                "relay-proprietary-model".to_string(),
            ]),
            synced_models: Some(vec![
                "deepseek-v4-pro".to_string(),
                "relay-proprietary-model".to_string(),
            ]),
            ..Default::default()
        };

        let routes = config.merge_default_routes(&[], &[account], &config.presets);
        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].upstream_model, "deepseek-v4-pro");
        assert_eq!(routes[0].client_protocol, ProtocolType::OpenAi);
        assert!(
            routes
                .iter()
                .all(|route| route.upstream_model != "relay-proprietary-model")
        );
    }

    #[test]
    fn embedded_config_contains_custom_channel_template() {
        let json: serde_json::Value = serde_json::from_str(DEFAULT_CONFIG_JSON).unwrap();
        let config = ChannelsConfig::from_config_json(&json).unwrap();
        let custom = config
            .presets
            .iter()
            .find(|preset| preset.id == "custom")
            .expect("missing custom channel");
        assert_eq!(custom.vendor, "custom");
        assert!(custom.openai_base_url.is_empty());
        assert!(custom.anthropic_base_url.is_empty());
        assert!(custom.supports_model_list);
        assert_eq!(custom.openai_auth, AuthStrategy::Bearer);
        assert_eq!(custom.anthropic_auth, AuthStrategy::XApiKey);
    }

    #[test]
    fn embedded_longcat_hybrid_scrape_config_has_three_phases() {
        // 验证 config.json 中 LongCat hybrid 模式已配置三阶段导航:
        // - 第一阶段: token 资源包汇总(?tab=token)
        // - 第二阶段: 按量余额(?tab=api)
        // - 第三阶段: 完整资源包列表(含已用尽/已过期,/platform/fuel_pack)
        let json: serde_json::Value = serde_json::from_str(DEFAULT_CONFIG_JSON).unwrap();
        let config = ChannelsConfig::from_config_json(&json).unwrap();
        let modes = config.scrape.get("longcat").expect("longcat scrape 配置");
        let hybrid = modes.get("hybrid").expect("longcat hybrid 模式");
        assert_eq!(
            hybrid.console_url, "https://longcat.chat/platform/usage?tab=token",
            "第一阶段应导航到 token 资源包汇总"
        );
        assert_eq!(
            hybrid.console_url_secondary.as_deref(),
            Some("https://longcat.chat/platform/usage?tab=api"),
            "第二阶段应导航到按量余额"
        );
        assert_eq!(
            hybrid.console_url_tertiary.as_deref(),
            Some("https://longcat.chat/platform/fuel_pack"),
            "第三阶段应导航到 fuel_pack 捕获完整资源包列表"
        );
        assert_eq!(
            hybrid.required_slots,
            vec!["token_packs_summary", "api_usage_summary", "token_packs_list"],
            "三阶段聚合需要三个槽位全部到位"
        );
        assert!(hybrid.aggregate);
        // 拦截器必须同时拦截三个目标端点
        assert!(hybrid.interceptor_js.contains("/api/pay/quota/metering/token-packs/summary"));
        assert!(hybrid.interceptor_js.contains("/api/pay/quota/metering/api-usage/summary"));
        assert!(hybrid
            .interceptor_js
            .contains("/api/pay/commercial/entitlements/token-packs/list"));
        // extractor 必须引用 token_packs_list 槽位(去重合并逻辑)
        assert!(hybrid.extractor_js.contains("token_packs_list"));
    }
}
