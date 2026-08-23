use super::config::{
    AuthStrategy, ChannelAccount, ChannelPreset, ModelPrice, ModelPriceTier, ProtocolType,
    RouteCandidate,
};
pub(crate) use super::model_catalog::{canonical_model_key, official_channel_id_for_model};
use serde::Deserialize;

/// 编译时随应用固化的默认配置。
///
/// 外部 config.json 仍然优先；这个副本只用于配置缺失、旧版本配置不含
/// `channels_config` 或打包资源路径异常时，避免桌面进程在创建窗口和托盘前退出。
pub const DEFAULT_CONFIG_JSON: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../config.json"));

/// 该渠道的 OpenAI-compatible 端点是否使用不带 `/v1` 前缀的路径。
/// 智谱官方 OpenAI 端点为 `/api/paas/v4/chat/completions`（无 `/v1`），
/// 而 `build_upstream_url` 默认在入站 `/v1/...` 路径上保留 `/v1`，会拼出
/// `/api/paas/v4/v1/chat/completions` 这类错误地址，因此须单独走无 `/v1` 拼接。
/// 其余渠道（LongCat / DeepSeek / Kimi / Qwen / custom）均保留 `/v1`。
pub(crate) fn openai_path_strips_v1(channel_id: &str) -> bool {
    crate::core::channel_capability_adapter::channel_adapter(channel_id)
        .is_some_and(|adapter| adapter.strips_openai_v1_path)
}

// ─── JSON 反序列化结构 ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Clone)]
pub struct ChannelConfigJson {
    pub channels: Vec<ChannelJson>,
    #[serde(default)]
    pub model_prices: Vec<ModelPriceJson>,
    #[serde(default)]
    pub default_exposed_models: std::collections::HashMap<String, Vec<String>>,
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
    /// 每个渠道的端点覆盖，key 为 channel_id → (endpoint_key → url)
    pub endpoints: std::collections::HashMap<String, std::collections::HashMap<String, String>>,
    /// 每个渠道的抓取配置，key 为 channel_id → (mode_key → ScrapeModeConfig)。
    pub scrape:
        std::collections::HashMap<String, std::collections::HashMap<String, ScrapeModeConfig>>,
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
                schedules: Vec::new(),
                currency: p.currency,
                unit: p.unit,
                source_url: p.source_url,
                price_version: p.price_version,
                created_at: now.clone(),
                updated_at: now.clone(),
            })
            .collect();

        Ok(Self {
            presets,
            prices,
            default_exposed_models: json.default_exposed_models,
            endpoints,
            scrape,
        })
    }

    /// 获取指定渠道、指定模式的抓取配置。
    pub fn scrape_config(&self, channel_id: &str, mode_key: &str) -> Option<&ScrapeModeConfig> {
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

    /// 获取 OpenRouter 余额端点（官方 `GET /api/v1/key`，返回该 API Key 的
    /// 剩余 credits）。优先使用配置中 endpoints["balance"] 覆盖，缺失时基于
    /// openai_base_url 拼接。
    pub fn openrouter_balance_endpoint(&self) -> String {
        self.endpoint_or("openrouter", "balance", |c| {
            format!("{}/key", c.openai_base_url.trim_end_matches('/'))
        })
    }

    /// 获取 OpenRouter 账户 Credits 端点（官方 `GET /api/v1/credits`）。
    /// 该接口必须使用 Management Key；普通模型调用 Key 会返回 403。
    pub fn openrouter_credits_endpoint(&self) -> String {
        self.endpoint_or("openrouter", "credits", |c| {
            format!("{}/credits", c.openai_base_url.trim_end_matches('/'))
        })
    }

    /// 获取 DeepSeek 模型列表端点
    pub fn deepseek_models_endpoint(&self) -> String {
        self.endpoint_or("deepseek", "models", |c| {
            format!("{}/models", c.openai_base_url)
        })
    }

    /// 获取 Qwen 模型列表端点
    pub fn qwen_models_endpoint(&self) -> String {
        self.endpoint_or("qwen", "models", |c| {
            format!("{}/models", c.openai_base_url.trim_end_matches('/'))
        })
    }

    /// 获取默认开放模型列表（按渠道）。
    /// 仅用于渠道预设的配置漂移检测（preset-sync），不再作为开放模型的白名单。
    /// 白名单请使用 supported_models()（所有渠道的并集）。
    /// 开放哪些模型由用户在账号编辑器中显式勾选，不在此维护默认勾选；
    /// OpenRouter 条目仅登记其独占模型的目录归属，不代表账号默认勾选。
    pub fn default_exposed_models(&self, channel_id: &str) -> Vec<String> {
        self.default_exposed_models
            .get(channel_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Flowlet 支持开放的上游模型全集，来自内置 model-catalog.json。
    /// 任意渠道账号只要底层 /models 返回了其中的模型，就可勾选开放——不再按渠道区分。
    pub fn supported_models(&self) -> Vec<String> {
        super::model_catalog::model_catalog().supported_models()
    }

    /// 为现有账号补齐「用户已勾选开放」的直连模型路由。
    ///
    /// 只追加缺失签名，不覆盖用户已有的启停状态、优先级和时间戳（删除取消勾选的
    /// 路由由前端保存时的对账逻辑负责）。全局最早创建账号的新路由默认开启，后续
    /// 所有官方或自定义账号的新路由默认关闭，等待用户手动开启。
    ///
    /// 候选上游模型 = 用户在账号编辑器中勾选的上游原始 ID `exposed_models` ∩
    /// 最近一次 `/models` 返回的 `synced_models` ∩ 全局支持模型集。白名单按规范
    /// 模型判断；同一规范模型映射到多个独立上游资源时分别生成候选路由。
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
                            // Responses 从 OpenAI Base URL 派生，共用同一覆盖地址。
                            ProtocolType::OpenAi | ProtocolType::Responses => account
                                .effective_openai_base_url()
                                .is_some_and(|url| !url.trim().is_empty()),
                            ProtocolType::Anthropic => account
                                .effective_anthropic_base_url()
                                .is_some_and(|url| !url.trim().is_empty()),
                        }
                    } else {
                        true
                    };
                    if !protocol_has_endpoint {
                        continue;
                    }
                    // 候选 = 原始上游 exposed_models ∩ synced_models ∩ 全局支持模型集。
                    // 同一规范模型的多个独立上游资源分别保留；exposed_models 为
                    // None（未配置）或空 → 不生成路由。
                    let exposed = account.exposed_models.as_deref().unwrap_or(&[]);
                    // synced_models 保留 /models 返回的原名（仅 trim 去空）。
                    let synced_raw: Vec<String> = account
                        .synced_models
                        .as_deref()
                        .unwrap_or(&[])
                        .iter()
                        .map(|m| m.trim().to_owned())
                        .filter(|m| !m.is_empty())
                        .collect();
                    let canonical_by_key: std::collections::HashMap<String, String> = whitelist
                        .iter()
                        .map(|model| (model.trim().to_lowercase(), model.clone()))
                        .collect();
                    let synced_by_id: std::collections::HashMap<String, String> = synced_raw
                        .iter()
                        .map(|model| (model.to_lowercase(), model.clone()))
                        .collect();
                    let exposed_models: Vec<(String, String)> = if exposed.is_empty() {
                        Vec::new()
                    } else {
                        let mut seen_upstream = std::collections::HashSet::new();
                        exposed
                            .iter()
                            .filter_map(|selected| {
                                let selected_raw = selected.trim();
                                if selected_raw.is_empty() {
                                    return None;
                                }
                                let selected_key = selected_raw.to_lowercase();
                                let canonical_key = canonical_model_key(selected_raw);
                                let canonical = canonical_by_key.get(&canonical_key)?.clone();
                                // 新数据精确选择上游原始 ID。兼容旧数据：旧版选择
                                // 别名时只保存规范 ID，规范 ID 未返回则回退到同规范
                                // 模型的首个上游资源。
                                let upstream =
                                    synced_by_id.get(&selected_key).cloned().or_else(|| {
                                        (selected_key == canonical_key).then(|| {
                                            synced_raw
                                                .iter()
                                                .find(|model| {
                                                    canonical_model_key(model) == canonical_key
                                                })
                                                .cloned()
                                        })?
                                    })?;
                                if !seen_upstream.insert(upstream.to_lowercase()) {
                                    return None;
                                }
                                Some((canonical, upstream))
                            })
                            .collect()
                    };
                    for (model_index, (canonical_model, upstream_model)) in
                        exposed_models.iter().enumerate()
                    {
                        let route = RouteCandidate {
                            id: format!(
                                "route-{}-{}-{}-{}-{}",
                                account.id,
                                upstream_model,
                                protocol.as_str(),
                                model_index,
                                account_index
                            ),
                            virtual_model_id: canonical_model.clone(),
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
            } else if c.id == "zhipu" {
                // 智谱 models 端点在 /api/paas/v4 下，不以 /v1 结尾；模板已显式
                // endpoints.models 覆盖，这里兜底保证外部配置缺失覆盖时仍正确。
                format!("{}/models", c.openai_base_url.trim_end_matches('/'))
            } else if c.id == "openrouter" {
                // OpenRouter openai_base_url 以 /api/v1 结尾，直接拼 /models；
                // 模板已显式 endpoints.models 覆盖，这里兜底防止外部配置缺失覆盖。
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

/// 判断账号是否为千问 Token Plan 订阅模式（sk-sp 专属 Key + 套餐端点，
/// 通过账号级 Base URL 覆盖接入）。
fn is_qwen_token_plan_account(account: &ChannelAccount) -> bool {
    account.channel_id == "qwen" && account.resource_mode.as_deref() == Some("token_plan")
}

fn parse_protocols(raw: &[String]) -> Vec<ProtocolType> {
    raw.iter()
        .map(|p| match p.as_str() {
            "anthropic" => ProtocolType::Anthropic,
            "responses" => ProtocolType::Responses,
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
                "default_exposed_models": {}
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
    fn account_model_routes_do_not_infer_aggregate_membership() {
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
        assert_eq!(routes.len(), 2);
        for protocol in [ProtocolType::OpenAi, ProtocolType::Anthropic] {
            let public_models: Vec<&str> = routes
                .iter()
                .filter(|route| route.client_protocol == protocol)
                .map(|route| route.virtual_model_id.as_str())
                .collect();
            assert_eq!(public_models, vec!["LongCat-2.0"]);
        }
    }

    #[test]
    fn parse_protocols_maps_responses() {
        let json = serde_json::json!({
            "channels_config": {
                "channels": [{
                    "id": "deepseek",
                    "name": "DeepSeek",
                    "vendor": "deepseek",
                    "supported_protocols": ["openai", "anthropic", "responses"]
                }]
            }
        });
        let config = ChannelsConfig::from_config_json(&json).unwrap();
        assert_eq!(
            config.presets[0].supported_protocols,
            vec![
                ProtocolType::OpenAi,
                ProtocolType::Anthropic,
                ProtocolType::Responses
            ]
        );
    }

    #[test]
    fn merge_default_routes_generates_responses_routes() {
        let json = serde_json::json!({
            "channels_config": {
                "channels": [{
                    "id": "deepseek",
                    "name": "DeepSeek",
                    "vendor": "deepseek",
                    "supported_protocols": ["openai", "responses"]
                }],
                "default_exposed_models": {
                    "deepseek": ["deepseek-v4-flash"]
                }
            }
        });
        let config = ChannelsConfig::from_config_json(&json).unwrap();
        let account = ChannelAccount {
            id: "deepseek-account".to_string(),
            channel_id: "deepseek".to_string(),
            api_key: "sk-test".to_string(),
            enabled: true,
            exposed_models: Some(vec!["deepseek-v4-flash".to_string()]),
            synced_models: Some(vec!["deepseek-v4-flash".to_string()]),
            ..Default::default()
        };

        let routes = config.merge_default_routes(&[], &[account], &config.presets);
        // 每个声明的协议各生成一条直连模型路由
        assert_eq!(routes.len(), 2);
        for protocol in [ProtocolType::OpenAi, ProtocolType::Responses] {
            let models: Vec<&str> = routes
                .iter()
                .filter(|route| route.client_protocol == protocol)
                .map(|route| route.virtual_model_id.as_str())
                .collect();
            assert_eq!(models, vec!["deepseek-v4-flash"]);
        }
    }

    #[test]
    fn custom_channel_responses_requires_base_url_override() {
        let json = serde_json::json!({
            "channels_config": {
                "channels": [{
                    "id": "custom",
                    "name": "自定义渠道",
                    "vendor": "custom",
                    "supported_protocols": ["openai", "responses"]
                }],
                "default_exposed_models": {
                    "deepseek": ["deepseek-v4-flash"]
                }
            }
        });
        let config = ChannelsConfig::from_config_json(&json).unwrap();
        // 只填 Anthropic 覆盖地址：openai 与 responses 都没有可用端点 → 零路由
        let anthropic_only = ChannelAccount {
            id: "relay".to_string(),
            channel_id: "custom".to_string(),
            api_key: "sk-test".to_string(),
            enabled: true,
            anthropic_base_url_override: Some("https://relay.example/anthropic".to_string()),
            exposed_models: Some(vec!["deepseek-v4-flash".to_string()]),
            synced_models: Some(vec!["deepseek-v4-flash".to_string()]),
            ..Default::default()
        };
        assert!(config
            .merge_default_routes(&[], &[anthropic_only.clone()], &config.presets)
            .is_empty());

        // 填了 OpenAI Base URL：openai 与 responses 路由同时生成（共享同一地址）
        let with_openai = ChannelAccount {
            base_url_override: Some("https://relay.example/v1".to_string()),
            ..anthropic_only
        };
        let routes = config.merge_default_routes(&[], &[with_openai], &config.presets);
        let protocols: std::collections::BTreeSet<&str> = routes
            .iter()
            .map(|route| route.client_protocol.as_str())
            .collect();
        assert_eq!(
            protocols,
            std::collections::BTreeSet::from(["openai", "responses"])
        );
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
        let routes = config.merge_default_routes(&[], &[later, first], &config.presets);

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
    fn canonical_model_key_maps_alias_variants() {
        // 别名变体 → 规范 ID；大小写不敏感；规范名与未知模型原样小写透传。
        assert_eq!(
            canonical_model_key("deepseek-v4-flash-0731"),
            "deepseek-v4-flash"
        );
        assert_eq!(
            canonical_model_key("DeepSeek-V4-Flash-0731"),
            "deepseek-v4-flash"
        );
        assert_eq!(
            canonical_model_key("DeepSeek-V4-Flash"),
            "deepseek-v4-flash"
        );
        assert_eq!(canonical_model_key("qwen3.7-max"), "qwen3.7-max");
    }

    #[test]
    fn official_channel_id_resolves_alias_variants() {
        assert_eq!(
            official_channel_id_for_model("deepseek-v4-flash-0731"),
            Some("deepseek")
        );
        assert_eq!(
            official_channel_id_for_model("deepseek-v4-flash"),
            Some("deepseek")
        );
        assert_eq!(
            official_channel_id_for_model("deepseek-v4-pro-0813"),
            Some("deepseek")
        );
    }

    #[test]
    fn official_channel_id_resolves_zhipu_glm() {
        assert_eq!(official_channel_id_for_model("glm-5.3"), Some("zhipu"));
        assert_eq!(official_channel_id_for_model("GLM-5.3"), Some("zhipu"));
        assert_eq!(official_channel_id_for_model("glm-5.2"), Some("zhipu"));
        assert_eq!(official_channel_id_for_model("GLM-5.2"), Some("zhipu"));
        assert_eq!(official_channel_id_for_model("glm-4.7"), Some("zhipu"));
        assert_eq!(official_channel_id_for_model("glm-4.5-air"), Some("zhipu"));
        // 智谱其他模型未纳入白名单，不应解析为 zhipu 归属。
        assert_eq!(official_channel_id_for_model("glm-5.1"), None);
    }

    fn qwen_alias_test_config() -> ChannelsConfig {
        let json = serde_json::json!({
            "channels_config": {
                "channels": [{
                    "id": "qwen",
                    "name": "Qwen",
                    "vendor": "qwen",
                    "supported_protocols": ["openai"],
                    "openai_base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1"
                }],
                "default_exposed_models": {
                    "deepseek": ["deepseek-v4-flash"]
                }
            }
        });
        ChannelsConfig::from_config_json(&json).unwrap()
    }

    #[test]
    fn merge_default_routes_maps_alias_variant_to_canonical_virtual_model() {
        // 千问 Token Plan 端点 /models 返回 deepseek-v4-flash-0731：
        // 用户勾选规范名 deepseek-v4-flash 即可命中，virtual_model_id 用规范名，
        // upstream_model 保留上游原名用于转发，且不推断任何聚合模型归属。
        let config = qwen_alias_test_config();
        let account = ChannelAccount {
            id: "qwen-token-plan".to_string(),
            channel_id: "qwen".to_string(),
            api_key: String::new(),
            enabled: true,
            resource_mode: Some("token_plan".to_string()),
            exposed_models: Some(vec!["deepseek-v4-flash".to_string()]),
            synced_models: Some(vec!["deepseek-v4-flash-0731".to_string()]),
            ..Default::default()
        };

        let routes = config.merge_default_routes(&[], &[account], &config.presets);
        let pairs: Vec<(&str, &str)> = routes
            .iter()
            .map(|route| {
                (
                    route.virtual_model_id.as_str(),
                    route.upstream_model.as_str(),
                )
            })
            .collect();
        assert_eq!(pairs, vec![("deepseek-v4-flash", "deepseek-v4-flash-0731")]);
    }

    #[test]
    fn merge_default_routes_maps_pro_0813_alias_on_qwen_to_canonical() {
        // 千问 Token Plan 端点 /models 返回 deepseek-v4-pro-0813：
        // 用户勾选规范名 deepseek-v4-pro 即可命中，virtual_model_id 用规范名，
        // upstream_model 保留上游原名用于转发。
        let config = qwen_alias_test_config();
        let account = ChannelAccount {
            id: "qwen-token-plan".to_string(),
            channel_id: "qwen".to_string(),
            api_key: String::new(),
            enabled: true,
            resource_mode: Some("token_plan".to_string()),
            exposed_models: Some(vec!["deepseek-v4-pro".to_string()]),
            synced_models: Some(vec!["deepseek-v4-pro-0813".to_string()]),
            ..Default::default()
        };

        let routes = config.merge_default_routes(&[], &[account], &config.presets);
        let pairs: Vec<(&str, &str)> = routes
            .iter()
            .map(|route| {
                (
                    route.virtual_model_id.as_str(),
                    route.upstream_model.as_str(),
                )
            })
            .collect();
        assert_eq!(pairs, vec![("deepseek-v4-pro", "deepseek-v4-pro-0813")]);
    }

    #[test]
    fn merge_default_routes_selects_only_exact_resource_when_only_canonical_is_checked() {
        // /models 同时返回规范名与别名变体，但只勾选规范 ID 时只生成规范资源路由。
        let config = qwen_alias_test_config();
        let account = ChannelAccount {
            id: "qwen-token-plan".to_string(),
            channel_id: "qwen".to_string(),
            api_key: String::new(),
            enabled: true,
            resource_mode: Some("token_plan".to_string()),
            exposed_models: Some(vec!["deepseek-v4-flash".to_string()]),
            synced_models: Some(vec![
                "deepseek-v4-flash-0731".to_string(),
                "deepseek-v4-flash".to_string(),
            ]),
            ..Default::default()
        };

        let routes = config.merge_default_routes(&[], &[account], &config.presets);
        assert!(
            routes
                .iter()
                .all(|route| route.upstream_model == "deepseek-v4-flash"),
            "精确同名优先于别名变体: {routes:?}"
        );
        assert_eq!(routes.len(), 1);
    }

    #[test]
    fn merge_default_routes_selects_alias_resource_by_raw_id() {
        let config = qwen_alias_test_config();
        let account = ChannelAccount {
            id: "qwen-token-plan".to_string(),
            channel_id: "qwen".to_string(),
            api_key: String::new(),
            enabled: true,
            resource_mode: Some("token_plan".to_string()),
            exposed_models: Some(vec!["deepseek-v4-flash-0731".to_string()]),
            synced_models: Some(vec![
                "deepseek-v4-flash".to_string(),
                "deepseek-v4-flash-0731".to_string(),
            ]),
            ..Default::default()
        };

        let routes = config.merge_default_routes(&[], &[account], &config.presets);
        let pairs: Vec<(&str, &str)> = routes
            .iter()
            .map(|route| {
                (
                    route.virtual_model_id.as_str(),
                    route.upstream_model.as_str(),
                )
            })
            .collect();
        assert_eq!(pairs, vec![("deepseek-v4-flash", "deepseek-v4-flash-0731")]);
    }

    #[test]
    fn merge_default_routes_keeps_two_resources_for_same_canonical_model() {
        let config = qwen_alias_test_config();
        let account = ChannelAccount {
            id: "qwen-token-plan".to_string(),
            channel_id: "qwen".to_string(),
            api_key: String::new(),
            enabled: true,
            resource_mode: Some("token_plan".to_string()),
            exposed_models: Some(vec![
                "deepseek-v4-flash".to_string(),
                "deepseek-v4-flash-0731".to_string(),
            ]),
            synced_models: Some(vec![
                "deepseek-v4-flash".to_string(),
                "deepseek-v4-flash-0731".to_string(),
            ]),
            ..Default::default()
        };

        let routes = config.merge_default_routes(&[], &[account], &config.presets);
        let pairs: Vec<(&str, &str)> = routes
            .iter()
            .map(|route| {
                (
                    route.virtual_model_id.as_str(),
                    route.upstream_model.as_str(),
                )
            })
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("deepseek-v4-flash", "deepseek-v4-flash"),
                ("deepseek-v4-flash", "deepseek-v4-flash-0731"),
            ]
        );
    }

    #[test]
    fn merge_default_routes_ignores_unselected_alias_variant() {
        // 未勾选规范名时，即使 synced 含别名变体也不生成路由。
        let config = qwen_alias_test_config();
        let account = ChannelAccount {
            id: "qwen-token-plan".to_string(),
            channel_id: "qwen".to_string(),
            api_key: String::new(),
            enabled: true,
            resource_mode: Some("token_plan".to_string()),
            exposed_models: Some(vec![]),
            synced_models: Some(vec!["deepseek-v4-flash-0731".to_string()]),
            ..Default::default()
        };

        let routes = config.merge_default_routes(&[], &[account], &config.presets);
        assert!(routes.is_empty());
    }

    #[test]
    fn qwen_models_endpoint_avoids_double_v1() {
        let json = serde_json::json!({
            "channels_config": {
                "channels": [{
                    "id": "qwen",
                    "name": "Qwen",
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
                        "name": "Qwen",
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
        // 聚合归属不再由模型名推断；这里只生成已有渠道模型的直连路由。
        assert!(routes.iter().any(|route| {
            route.virtual_model_id == "deepseek-v4-pro" && route.upstream_model == "deepseek-v4-pro"
        }));
        assert!(!routes
            .iter()
            .any(|route| route.virtual_model_id.starts_with("flowlet-")));
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
    fn supported_models_comes_from_embedded_model_catalog() {
        let json = serde_json::json!({
            "channels_config": {
                "channels": [{
                    "id": "qwen",
                    "name": "Qwen",
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
        let supported: std::collections::HashSet<String> =
            config.supported_models().into_iter().collect();
        // 即使传入配置只声明部分 Qwen 模型，内置目录仍提供完整白名单。
        for expected in ["qwen3.7-max", "qwen3.6-flash", "qwen3.8-max"] {
            assert!(supported.contains(expected), "缺少支持的模型: {expected}");
        }
        // 目录校验保证规范模型 ID 唯一。
        assert_eq!(
            config
                .supported_models()
                .iter()
                .filter(|m| *m == "qwen3.6-flash")
                .count(),
            1
        );
    }

    #[test]
    fn supported_models_includes_zhipu_glm() {
        let json = serde_json::json!({
            "channels_config": {
                "channels": [{
                    "id": "zhipu",
                    "name": "Z.AI",
                    "vendor": "zhipu",
                    "supported_protocols": ["openai", "anthropic"],
                    "openai_base_url": "https://open.bigmodel.cn/api/paas/v4",
                    "anthropic_base_url": "https://open.bigmodel.cn/api/anthropic"
                }],
                "default_exposed_models": {
                    "zhipu": ["glm-5.3", "glm-5.2", "glm-4.7", "glm-4.5-air"]
                }
            }
        });
        let config = ChannelsConfig::from_config_json(&json).unwrap();
        let supported: std::collections::HashSet<String> =
            config.supported_models().into_iter().collect();
        for expected in ["glm-5.3", "glm-5.2", "glm-4.7", "glm-4.5-air"] {
            assert!(supported.contains(expected), "缺少支持的模型: {expected}");
        }
        // 智谱 models 端点不以 /v1 结尾，显式 endpoints 覆盖优先。
        let config_with_endpoint = ChannelsConfig::from_config_json(&serde_json::json!({
            "channels_config": {
                "channels": [{
                    "id": "zhipu",
                    "name": "Z.AI",
                    "vendor": "zhipu",
                    "supported_protocols": ["openai", "anthropic"],
                    "openai_base_url": "https://open.bigmodel.cn/api/paas/v4",
                    "anthropic_base_url": "https://open.bigmodel.cn/api/anthropic"
                }],
                "endpoints": {
                    "zhipu": {
                        "models": "https://open.bigmodel.cn/api/paas/v4/models"
                    }
                }
            }
        }))
        .unwrap();
        assert_eq!(
            config_with_endpoint.models_endpoint_url("zhipu").as_deref(),
            Some("https://open.bigmodel.cn/api/paas/v4/models")
        );
        // 无 endpoints 覆盖时回退到 zhipu 拼接规则（/models 而非 /v1/models）。
        assert_eq!(
            config.models_endpoint_url("zhipu").as_deref(),
            Some("https://open.bigmodel.cn/api/paas/v4/models")
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
        assert!(config
            .merge_default_routes(&[], &[missing_from_models], &config.presets)
            .is_empty());
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
        assert!(routes
            .iter()
            .all(|route| route.upstream_model != "relay-proprietary-model"));
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
    fn embedded_config_contains_openrouter_channel_template() {
        let json: serde_json::Value = serde_json::from_str(DEFAULT_CONFIG_JSON).unwrap();
        let config = ChannelsConfig::from_config_json(&json).unwrap();
        let openrouter = config
            .presets
            .iter()
            .find(|preset| preset.id == "openrouter")
            .expect("missing openrouter channel");
        assert_eq!(openrouter.vendor, "openrouter");
        assert_eq!(openrouter.openai_base_url, "https://openrouter.ai/api/v1");
        assert_eq!(openrouter.anthropic_base_url, "https://openrouter.ai/api");
        assert_eq!(openrouter.openai_auth, AuthStrategy::Bearer);
        assert_eq!(openrouter.anthropic_auth, AuthStrategy::Bearer);
        assert!(openrouter.supports_model_list);
        assert!(openrouter.supports_balance_query);
        assert_eq!(
            config.models_endpoint_url("openrouter").as_deref(),
            Some("https://openrouter.ai/api/v1/models")
        );
        assert_eq!(
            config.openrouter_balance_endpoint(),
            "https://openrouter.ai/api/v1/key"
        );
        assert_eq!(
            config.openrouter_credits_endpoint(),
            "https://openrouter.ai/api/v1/credits"
        );
    }

    #[test]
    fn openrouter_models_endpoint_falls_back_to_v1_models_without_override() {
        let json = serde_json::json!({
            "channels_config": {
                "channels": [{
                    "id": "openrouter",
                    "name": "OpenRouter",
                    "vendor": "openrouter",
                    "supported_protocols": ["openai", "anthropic"],
                    "openai_base_url": "https://openrouter.ai/api/v1",
                    "anthropic_base_url": "https://openrouter.ai/api"
                }]
            }
        });
        let config = ChannelsConfig::from_config_json(&json).unwrap();
        // openai_base_url 以 /api/v1 结尾，无显式覆盖时拼 /models 而非 /v1/models。
        assert_eq!(
            config.models_endpoint_url("openrouter").as_deref(),
            Some("https://openrouter.ai/api/v1/models")
        );
        // 无 endpoints.balance 覆盖时，余额端点基于 openai_base_url 拼接为 /key。
        assert_eq!(
            config.openrouter_balance_endpoint(),
            "https://openrouter.ai/api/v1/key"
        );
        assert_eq!(
            config.openrouter_credits_endpoint(),
            "https://openrouter.ai/api/v1/credits"
        );
    }

    #[test]
    fn canonical_model_key_strips_aggregate_vendor_prefix() {
        assert_eq!(
            canonical_model_key("deepseek/deepseek-v4-flash"),
            "deepseek-v4-flash"
        );
        assert_eq!(canonical_model_key("qwen/qwen3.7-max"), "qwen3.7-max");
        assert_eq!(canonical_model_key("z-ai/glm-5.2"), "glm-5.2");
        assert_eq!(canonical_model_key("stealth/ox-alpha"), "ox-alpha");
        assert_eq!(
            canonical_model_key("nvidia/nemotron-3.5-lightning:free"),
            "nemotron-3.5-lightning"
        );
        assert_eq!(
            canonical_model_key("nvidia/nemotron-3-super-120b-a12b:free"),
            "nemotron-3-super-120b-a12b"
        );
        assert_eq!(
            canonical_model_key("nvidia/nemotron-3-ultra-550b-a55b:free"),
            "nemotron-3-ultra-550b-a55b"
        );
        // 别名变体在剥离 vendor 前缀后仍按规范映射
        assert_eq!(
            canonical_model_key("deepseek/deepseek-v4-flash-0731"),
            "deepseek-v4-flash"
        );
        // 普通模型名不含 vendor 前缀，不受影响
        assert_eq!(
            canonical_model_key("deepseek-v4-flash"),
            "deepseek-v4-flash"
        );
    }

    #[test]
    fn openrouter_catalog_default_only_lists_owned_models() {
        // 这里只登记 OpenRouter 独占模型的目录归属；账号开放哪些模型仍由用户显式勾选。
        let json: serde_json::Value = serde_json::from_str(DEFAULT_CONFIG_JSON).unwrap();
        let config = ChannelsConfig::from_config_json(&json).unwrap();
        assert_eq!(
            config.default_exposed_models("openrouter"),
            vec![
                "ox-alpha".to_string(),
                "nemotron-3.5-lightning".to_string(),
                "nemotron-3-super-120b-a12b".to_string(),
                "nemotron-3-ultra-550b-a55b".to_string(),
            ]
        );
    }

    #[test]
    fn merge_default_routes_maps_openrouter_vendor_prefixed_models() {
        let json: serde_json::Value = serde_json::from_str(DEFAULT_CONFIG_JSON).unwrap();
        let config = ChannelsConfig::from_config_json(&json).unwrap();
        let account = ChannelAccount {
            id: "openrouter-account".to_string(),
            channel_id: "openrouter".to_string(),
            api_key: "sk-or-test".to_string(),
            enabled: true,
            exposed_models: Some(vec![
                "deepseek/deepseek-v4-flash".to_string(),
                "qwen/qwen3.7-max".to_string(),
                "stealth/ox-alpha".to_string(),
            ]),
            synced_models: Some(vec![
                "deepseek/deepseek-v4-flash".to_string(),
                "qwen/qwen3.7-max".to_string(),
                "stealth/ox-alpha".to_string(),
            ]),
            ..Default::default()
        };
        let routes = config.merge_default_routes(&[], &[account.clone()], &config.presets);
        // 每个模型按声明的协议（openai / anthropic / responses）各生成一条直连路由。
        let pairs: Vec<(&str, &str)> = routes
            .iter()
            .filter(|route| route.channel_id == "openrouter")
            .map(|route| {
                (
                    route.virtual_model_id.as_str(),
                    route.upstream_model.as_str(),
                )
            })
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("deepseek-v4-flash", "deepseek/deepseek-v4-flash"),
                ("qwen3.7-max", "qwen/qwen3.7-max"),
                ("ox-alpha", "stealth/ox-alpha"),
                ("deepseek-v4-flash", "deepseek/deepseek-v4-flash"),
                ("qwen3.7-max", "qwen/qwen3.7-max"),
                ("ox-alpha", "stealth/ox-alpha"),
                ("deepseek-v4-flash", "deepseek/deepseek-v4-flash"),
                ("qwen3.7-max", "qwen/qwen3.7-max"),
                ("ox-alpha", "stealth/ox-alpha"),
            ]
        );
        // responses 协议确实生成路由，且协议集合覆盖三个声明的协议。
        let protocols: std::collections::BTreeSet<&str> = routes
            .iter()
            .filter(|route| route.channel_id == "openrouter")
            .map(|route| route.client_protocol.as_str())
            .collect();
        assert_eq!(
            protocols,
            std::collections::BTreeSet::from(["openai", "anthropic", "responses"])
        );
        // 白名单外的 vendor 前缀模型（openai/gpt-5.5）被过滤。
        let with_stranger = ChannelAccount {
            exposed_models: Some(vec![
                "deepseek/deepseek-v4-flash".to_string(),
                "openai/gpt-5.5".to_string(),
            ]),
            synced_models: Some(vec![
                "deepseek/deepseek-v4-flash".to_string(),
                "openai/gpt-5.5".to_string(),
            ]),
            ..account
        };
        let routes = config.merge_default_routes(&[], &[with_stranger], &config.presets);
        assert!(routes
            .iter()
            .all(|route| route.upstream_model != "openai/gpt-5.5"));
        assert!(routes
            .iter()
            .any(|route| route.upstream_model == "deepseek/deepseek-v4-flash"));
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
            vec![
                "token_packs_summary",
                "api_usage_summary",
                "token_packs_list"
            ],
            "三阶段聚合需要三个槽位全部到位"
        );
        assert!(hybrid.aggregate);
        // 拦截器必须同时拦截三个目标端点
        assert!(hybrid
            .interceptor_js
            .contains("/api/pay/quota/metering/token-packs/summary"));
        assert!(hybrid
            .interceptor_js
            .contains("/api/pay/quota/metering/api-usage/summary"));
        assert!(hybrid
            .interceptor_js
            .contains("/api/pay/commercial/entitlements/token-packs/list"));
        // extractor 必须引用 token_packs_list 槽位(去重合并逻辑)
        assert!(hybrid.extractor_js.contains("token_packs_list"));
    }
}
