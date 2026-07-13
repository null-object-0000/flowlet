use super::config::{ChannelAccount, ChannelModel, ProtocolType};
use super::presets::{BalanceQueryResult, ModelSyncResult};
use reqwest::Client;
use serde::Deserialize;

const DEEPSEEK_BALANCE_URL: &str = "https://api.deepseek.com/user/balance";
const DEEPSEEK_MODELS_URL: &str = "https://api.deepseek.com/models";

#[derive(Debug, Deserialize)]
struct DeepSeekBalanceResponse {
    #[serde(default)]
    is_available: bool,
    #[serde(default)]
    balance_infos: Vec<DeepSeekBalanceInfo>,
}

#[derive(Debug, Deserialize)]
struct DeepSeekBalanceInfo {
    #[serde(default)]
    currency: String,
    #[serde(default)]
    total_balance: String,
    #[serde(default)]
    #[allow(dead_code)]
    granted_balance: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    topped_up_balance: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DeepSeekModelsResponse {
    #[serde(default)]
    data: Vec<DeepSeekModelEntry>,
}

#[derive(Debug, Deserialize, serde::Serialize, Clone)]
pub struct DeepSeekModelEntry {
    pub id: String,
    #[serde(default)]
    object: String,
    #[serde(default)]
    owned_by: Option<String>,
}

/// 测试渠道连接：仅验证 API Key 是否有效，不做余额读写。
/// 通过访问模型列表端点实现轻量级鉴权验证。
pub async fn test_channel_connection(account: &ChannelAccount) -> Result<(), String> {
    if account.api_key.trim().is_empty() {
        return Err("API Key 未配置".to_string());
    }

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|err| format!("创建 HTTP 客户端失败: {err}"))?;

    // 根据渠道选择对应的轻量端点进行鉴权测试
    let (url, auth_header) = match account.channel_id.as_str() {
        "deepseek" => (
            "https://api.deepseek.com/models".to_string(),
            format!("Bearer {}", account.api_key.trim()),
        ),
        "longcat" => (
            "https://api.longcat.chat/openai/v1/models".to_string(),
            format!("Bearer {}", account.api_key.trim()),
        ),
        _ => return Err(format!("不支持测试连接的渠道: {}", account.channel_id)),
    };

    let response = client
        .get(&url)
        .header("Authorization", auth_header)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|err| format!("请求失败: {err}"))?;

    let status = response.status();
    if status.is_success() {
        Ok(())
    } else if status.as_u16() == 401 {
        Err("API Key 无效 (HTTP 401)".to_string())
    } else {
        Err(format!("连接异常 (HTTP {})", status.as_u16()))
    }
}

/// 查询 DeepSeek 余额
pub async fn query_deepseek_balance(account: &ChannelAccount) -> BalanceQueryResult {
    if account.api_key.trim().is_empty() {
        return BalanceQueryResult {
            balance: None,
            currency: None,
            is_available: false,
            error: Some("API Key 未配置".to_string()),
        };
    }

    let client = match Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(err) => {
            return BalanceQueryResult {
                balance: None,
                currency: None,
                is_available: false,
                error: Some(format!("创建 HTTP 客户端失败: {err}")),
            }
        }
    };

    let response = client
        .get(DEEPSEEK_BALANCE_URL)
        .header(
            "Authorization",
            format!("Bearer {}", account.api_key.trim()),
        )
        .header("Accept", "application/json")
        .send()
        .await;

    let response = match response {
        Ok(r) => r,
        Err(err) => {
            return BalanceQueryResult {
                balance: None,
                currency: None,
                is_available: false,
                error: Some(format!("请求失败: {err}")),
            }
        }
    };

    let status = response.status();
    let body = match response.text().await {
        Ok(b) => b,
        Err(err) => {
            return BalanceQueryResult {
                balance: None,
                currency: None,
                is_available: false,
                error: Some(format!("读取响应失败: {err}")),
            }
        }
    };

    if !status.is_success() {
        return BalanceQueryResult {
            balance: None,
            currency: None,
            is_available: false,
            error: Some(format!("HTTP {}: {}", status.as_u16(), body)),
        };
    }

    match serde_json::from_str::<DeepSeekBalanceResponse>(&body) {
        Ok(data) => {
            // 优先使用 CNY 余额，否则取第一个
            let primary = data
                .balance_infos
                .iter()
                .find(|b| b.currency == "CNY")
                .or_else(|| data.balance_infos.first());

            match primary {
                Some(info) => BalanceQueryResult {
                    balance: info.total_balance.parse::<f64>().ok(),
                    currency: Some(info.currency.clone()),
                    is_available: data.is_available,
                    error: None,
                },
                None => BalanceQueryResult {
                    balance: None,
                    currency: None,
                    is_available: data.is_available,
                    error: Some("未找到余额信息".to_string()),
                },
            }
        }
        Err(err) => BalanceQueryResult {
            balance: None,
            currency: None,
            is_available: false,
            error: Some(format!("解析响应失败: {err}")),
        },
    }
}

/// 同步 DeepSeek 模型列表
pub async fn sync_deepseek_models(account: &ChannelAccount) -> ModelSyncResult {
    if account.api_key.trim().is_empty() {
        return ModelSyncResult {
            models_synced: 0,
            models: Vec::new(),
            errors: vec!["API Key 未配置".to_string()],
        };
    }

    let client = match Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(err) => {
            return ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![format!("创建 HTTP 客户端失败: {err}")],
            }
        }
    };

    let response = client
        .get(DEEPSEEK_MODELS_URL)
        .header(
            "Authorization",
            format!("Bearer {}", account.api_key.trim()),
        )
        .header("Accept", "application/json")
        .send()
        .await;

    let response = match response {
        Ok(r) => r,
        Err(err) => {
            return ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![format!("请求失败: {err}")],
            }
        }
    };

    let status = response.status();
    let body = match response.text().await {
        Ok(b) => b,
        Err(err) => {
            return ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![format!("读取响应失败: {err}")],
            }
        }
    };

    if !status.is_success() {
        return ModelSyncResult {
            models_synced: 0,
            models: Vec::new(),
            errors: vec![format!("HTTP {}: {}", status.as_u16(), body)],
        };
    }

    match serde_json::from_str::<DeepSeekModelsResponse>(&body) {
        Ok(data) => {
            let models: Vec<DeepSeekModelEntry> = data
                .data
                .into_iter()
                .filter(|m| !m.id.trim().is_empty())
                .collect();
            let synced_at = chrono::Utc::now().to_rfc3339();
            let channel_models = models
                .into_iter()
                .map(|model| deepseek_channel_model(model.id, &synced_at))
                .collect::<Vec<_>>();
            ModelSyncResult {
                models_synced: channel_models.len(),
                models: channel_models,
                errors: Vec::new(),
            }
        }
        Err(err) => ModelSyncResult {
            models_synced: 0,
            models: Vec::new(),
            errors: vec![format!("解析响应失败: {err}")],
        },
    }
}

const LONGCAT_MODELS_URL: &str = "https://api.longcat.chat/openai/v1/models";

/// LongCat 单模型详情（GET /openai/v1/models/{id}）
#[derive(Debug, Deserialize)]
pub struct LongCatModelDetail {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    // LongCat 返回 Unix 时间戳（秒）
    #[serde(default)]
    pub created: Option<i64>,
    #[serde(default)]
    pub context_length: Option<i64>,
    #[serde(default)]
    pub architecture: Option<LongCatArchitecture>,
    #[serde(default)]
    pub supported_parameters: Option<Vec<String>>,
    #[serde(default)]
    pub pricing: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct LongCatArchitecture {
    #[serde(default)]
    pub input_modalities: Option<Vec<String>>,
    #[serde(default)]
    pub output_modalities: Option<Vec<String>>,
    #[serde(default)]
    pub modality: Option<String>,
}

/// 同步 LongCat 模型列表，并对每个模型拉取详情获取 context_length / pricing
pub async fn sync_longcat_models(account: &ChannelAccount) -> ModelSyncResult {
    if account.api_key.trim().is_empty() {
        return ModelSyncResult {
            models_synced: 0,
            models: Vec::new(),
            errors: vec!["API Key 未配置".to_string()],
        };
    }

    let client = match Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(err) => {
            return ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![format!("创建 HTTP 客户端失败: {err}")],
            };
        }
    };

    // 1) 拉取列表
    let list_response = match fetch_longcat_list(&client, account).await {
        Ok(r) => r,
        Err(result) => return result,
    };

    // 2) 解析列表
    let entries: Vec<DeepSeekModelEntry> =
        match serde_json::from_str::<DeepSeekModelsResponse>(&list_response.body) {
            Ok(resp) => resp
                .data
                .into_iter()
                .filter(|m| !m.id.trim().is_empty())
                .collect(),
            Err(err) => {
                return ModelSyncResult {
                    models_synced: 0,
                    models: Vec::new(),
                    errors: vec![format!("解析列表响应失败: {err}")],
                };
            }
        };

    // 3) 逐个拉取详情
    let synced_at = chrono::Utc::now().to_rfc3339();
    let mut channel_models: Vec<ChannelModel> = Vec::new();
    let errors: Vec<String> = Vec::new();

    for entry in &entries {
        if let Some(detail) = fetch_longcat_detail(&client, account, &entry.id).await {
            channel_models.push(longcat_channel_model(
                entry.id.clone(),
                detail,
                &synced_at,
            ));
        } else {
            // 详情拉取失败时退化为仅列表信息
            channel_models.push(longcat_channel_model_from_id(
                entry.id.clone(),
                &synced_at,
            ));
        }
    }

    if channel_models.is_empty() && !errors.is_empty() {
        return ModelSyncResult {
            models_synced: 0,
            models: Vec::new(),
            errors,
        };
    }

    ModelSyncResult {
        models_synced: channel_models.len(),
        models: channel_models,
        errors,
    }
}

struct LongCatListResponse {
    #[allow(dead_code)]
    status: reqwest::StatusCode,
    body: String,
}

async fn fetch_longcat_list(
    client: &Client,
    account: &ChannelAccount,
) -> Result<LongCatListResponse, ModelSyncResult> {
    let response = client
        .get(LONGCAT_MODELS_URL)
        .header(
            "Authorization",
            format!("Bearer {}", account.api_key.trim()),
        )
        .header("Accept", "application/json")
        .send()
        .await;

    let response = match response {
        Ok(r) => r,
        Err(err) => {
            return Err(ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![format!("请求失败: {err}")],
            });
        }
    };

    let status = response.status();
    let body = match response.text().await {
        Ok(b) => b,
        Err(err) => {
            return Err(ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![format!("读取响应失败: {err}")],
            });
        }
    };

    if !status.is_success() {
        return Err(ModelSyncResult {
            models_synced: 0,
            models: Vec::new(),
            errors: vec![format!("HTTP {}: {}", status.as_u16(), body)],
        });
    }

    Ok(LongCatListResponse { status, body })
}

async fn fetch_longcat_detail(
    client: &Client,
    account: &ChannelAccount,
    model_id: &str,
) -> Option<LongCatModelDetail> {
    let url = format!("https://api.longcat.chat/openai/v1/models/{model_id}");
    let response = client
        .get(&url)
        .header(
            "Authorization",
            format!("Bearer {}", account.api_key.trim()),
        )
        .header("Accept", "application/json")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = response.text().await.ok()?;
    serde_json::from_str::<LongCatModelDetail>(&body).ok()
}

fn longcat_channel_model(
    model_id: String,
    detail: LongCatModelDetail,
    synced_at: &str,
) -> ChannelModel {
    ChannelModel {
        id: format!("longcat-{model_id}"),
        channel_id: "longcat".to_string(),
        display_name: detail.name.clone().or(Some(model_id.clone())),
        model: model_id,
        supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic],
        context_window: detail.context_length,
        max_output_tokens: None,
        supports_stream: detail
            .supported_parameters
            .as_ref()
            .map(|p| p.iter().any(|s| *s == "stream"))
            .unwrap_or(true),
        enabled: true,
        source: "synced".to_string(),
        synced_at: Some(synced_at.to_string()),
        created_at: synced_at.to_string(),
        updated_at: synced_at.to_string(),
    }
}

fn longcat_channel_model_from_id(model: String, synced_at: &str) -> ChannelModel {
    ChannelModel {
        id: format!("longcat-{model}"),
        channel_id: "longcat".to_string(),
        display_name: Some(model.clone()),
        model,
        supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic],
        context_window: None,
        max_output_tokens: None,
        supports_stream: true,
        enabled: true,
        source: "synced".to_string(),
        synced_at: Some(synced_at.to_string()),
        created_at: synced_at.to_string(),
        updated_at: synced_at.to_string(),
    }
}

fn deepseek_channel_model(model: String, synced_at: &str) -> ChannelModel {
    ChannelModel {
        id: format!("deepseek-{model}"),
        channel_id: "deepseek".to_string(),
        display_name: Some(model.clone()),
        model,
        supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic],
        context_window: Some(1_000_000),
        max_output_tokens: Some(384_000),
        supports_stream: true,
        enabled: true,
        source: "synced".to_string(),
        synced_at: Some(synced_at.to_string()),
        created_at: synced_at.to_string(),
        updated_at: synced_at.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_deepseek_balance_response() {
        let json = r#"{
            "is_available": true,
            "balance_infos": [
                {"currency": "CNY", "total_balance": "100.50", "granted_balance": "0", "topped_up_balance": "100.50"},
                {"currency": "USD", "total_balance": "0.00"}
            ]
        }"#;
        let data: DeepSeekBalanceResponse = serde_json::from_str(json).unwrap();
        assert!(data.is_available);
        assert_eq!(data.balance_infos.len(), 2);
        assert_eq!(data.balance_infos[0].currency, "CNY");
        assert_eq!(data.balance_infos[0].total_balance, "100.50");
    }

    #[test]
    fn parse_deepseek_models_response() {
        let json = r#"{
            "data": [
                {"id": "deepseek-v4-flash", "object": "model", "owned_by": "deepseek"},
                {"id": "deepseek-v4-pro", "object": "model", "owned_by": "deepseek"}
            ]
        }"#;
        let data: DeepSeekModelsResponse = serde_json::from_str(json).unwrap();
        assert_eq!(data.data.len(), 2);
        assert_eq!(data.data[0].id, "deepseek-v4-flash");
    }

    #[test]
    fn parse_empty_balance_response() {
        let json = r#"{"is_available": false, "balance_infos": []}"#;
        let data: DeepSeekBalanceResponse = serde_json::from_str(json).unwrap();
        assert!(!data.is_available);
        assert!(data.balance_infos.is_empty());
    }

    #[test]
    fn parse_longcat_models_list_response() {
        // LongCat 返回 OpenAI 风格，与 DeepSeek 结构一致
        let json = r#"{
            "object": "list",
            "data": [
                {"id": "LongCat-2.0", "object": "model", "owned_by": "LongCat"}
            ]
        }"#;
        let data: DeepSeekModelsResponse = serde_json::from_str(json).unwrap();
        assert_eq!(data.data.len(), 1);
        assert_eq!(data.data[0].id, "LongCat-2.0");
    }

    #[test]
    fn parse_longcat_model_detail_response() {
        let json = r#"{
            "id": "LongCat-2.0",
            "name": "LongCat-2.0",
            "created": 1773331200,
            "context_length": 1048576,
            "architecture": {
                "input_modalities": ["text"],
                "output_modalities": ["text"],
                "modality": "text->text",
                "tokenizer": "Other",
                "instruct_type": null
            },
            "supported_parameters": [
                "max_tokens", "temperature", "top_p", "stream", "tools", "tool_choice", "thinking"
            ],
            "pricing": {"prompt": "2", "completion": "8", "cached_tokens": "0.04"}
        }"#;
        let data: LongCatModelDetail = serde_json::from_str(json).unwrap();
        assert_eq!(data.id, "LongCat-2.0");
        assert_eq!(data.context_length, Some(1_048_576));
        assert_eq!(data.name, Some("LongCat-2.0".to_string()));
        let params = data.supported_parameters.unwrap();
        assert!(params.contains(&"stream".to_string()));
        assert!(params.contains(&"tools".to_string()));
    }
}
