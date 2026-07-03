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
}
