use super::super::*;
use crate::core::config::{ChannelModel, ProtocolType};
use crate::core::sync::{OpenAiModelEntry, OpenAiModelsResponse};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct ModelDetail {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    created: Option<i64>,
    #[serde(default)]
    context_length: Option<i64>,
    #[serde(default)]
    architecture: Option<ModelArchitecture>,
    #[serde(default)]
    supported_parameters: Option<Vec<String>>,
    #[serde(default)]
    pricing: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct ModelArchitecture {
    #[serde(default)]
    input_modalities: Option<Vec<String>>,
    #[serde(default)]
    output_modalities: Option<Vec<String>>,
    #[serde(default)]
    modality: Option<String>,
}

fn sync<'a>(
    account: &'a ChannelAccount,
    _preset: &'a ChannelPreset,
    config: &'a ChannelsConfig,
) -> ModelSyncFuture<'a> {
    Box::pin(sync_models(account, config))
}

async fn sync_models(account: &ChannelAccount, config: &ChannelsConfig) -> ModelSyncResult {
    if account.api_key.trim().is_empty() {
        return sync_error("API Key 未配置");
    }
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(client) => client,
        Err(error) => return sync_error(format!("创建 HTTP 客户端失败: {error}")),
    };
    let body = match fetch_model_list(&client, account, config).await {
        Ok(body) => body,
        Err(result) => return result,
    };
    let mut entries: Vec<OpenAiModelEntry> =
        match serde_json::from_str::<OpenAiModelsResponse>(&body) {
            Ok(response) => response
                .data
                .into_iter()
                .filter(|model| !model.id.trim().is_empty())
                .collect(),
            Err(error) => return sync_error(format!("解析列表响应失败: {error}")),
        };
    crate::core::sync::sort_by_created_desc(&mut entries, |model| model.created);

    let synced_at = chrono::Utc::now().to_rfc3339();
    let uses_custom_endpoint = account.effective_openai_base_url().is_some();
    let mut models = Vec::with_capacity(entries.len());
    for entry in entries {
        let detail = if uses_custom_endpoint {
            None
        } else {
            fetch_model_detail(&client, account, &entry.id, config).await
        };
        models.push(match detail {
            Some(detail) => channel_model(entry.id, detail, &synced_at),
            None => channel_model_from_id(entry.id, &synced_at),
        });
    }
    ModelSyncResult {
        models_synced: models.len(),
        models,
        errors: Vec::new(),
    }
}

async fn fetch_model_list(
    client: &reqwest::Client,
    account: &ChannelAccount,
    config: &ChannelsConfig,
) -> Result<String, ModelSyncResult> {
    let Some(url) = crate::core::sync::account_models_url(account, config) else {
        return Err(sync_error(format!(
            "不支持同步模型的渠道: {}",
            account.channel_id
        )));
    };
    let response = match client
        .get(&url)
        .header(
            "Authorization",
            format!("Bearer {}", account.api_key.trim()),
        )
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => return Err(sync_error(format!("请求失败: {error}"))),
    };
    let status = response.status();
    let body = match response.text().await {
        Ok(body) => body,
        Err(error) => return Err(sync_error(format!("读取响应失败: {error}"))),
    };
    if !status.is_success() {
        return Err(sync_error(format!("HTTP {}: {body}", status.as_u16())));
    }
    Ok(body)
}

async fn fetch_model_detail(
    client: &reqwest::Client,
    account: &ChannelAccount,
    model_id: &str,
    config: &ChannelsConfig,
) -> Option<ModelDetail> {
    let url = config
        .longcat_model_detail_endpoint()
        .replace("{id}", model_id);
    let response = client
        .get(url)
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
    serde_json::from_str(&response.text().await.ok()?).ok()
}

fn channel_model(model_id: String, detail: ModelDetail, synced_at: &str) -> ChannelModel {
    ChannelModel {
        id: format!("longcat-{model_id}"),
        channel_id: "longcat".to_string(),
        display_name: detail.name.or(Some(model_id.clone())),
        model: model_id,
        supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic],
        context_window: detail.context_length,
        max_output_tokens: None,
        pricing: detail.pricing,
        supports_stream: detail
            .supported_parameters
            .as_ref()
            .map(|parameters| parameters.iter().any(|parameter| parameter == "stream"))
            .unwrap_or(true),
        enabled: true,
        source: "synced".to_string(),
        synced_at: Some(synced_at.to_string()),
        created_at: synced_at.to_string(),
        updated_at: synced_at.to_string(),
    }
}

fn channel_model_from_id(model: String, synced_at: &str) -> ChannelModel {
    ChannelModel {
        id: format!("longcat-{model}"),
        channel_id: "longcat".to_string(),
        display_name: Some(model.clone()),
        model,
        supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic],
        context_window: None,
        max_output_tokens: None,
        pricing: None,
        supports_stream: true,
        enabled: true,
        source: "synced".to_string(),
        synced_at: Some(synced_at.to_string()),
        created_at: synced_at.to_string(),
        updated_at: synced_at.to_string(),
    }
}

fn sync_error(error: impl Into<String>) -> ModelSyncResult {
    ModelSyncResult {
        models_synced: 0,
        models: Vec::new(),
        errors: vec![error.into()],
    }
}

pub(super) const ADAPTER: ChannelCapabilityAdapter = ChannelCapabilityAdapter {
    id: "longcat",
    preset_factory: ChannelPreset::longcat,
    model_sync: sync,
    balance_query: None,
    strips_openai_v1_path: false,
    console_scrape: ConsoleScrapeAdapter::Fixed("hybrid"),
    login_page: LoginPageAdapter::Generic,
    scrape_response: Some(ScrapeResponseAdapter {
        classify: classify_scrape_response,
        merge: merge_scrape_response,
        satisfies: scrape_response_satisfies,
    }),
};

fn classify_scrape_response(url: &str) -> Option<&'static str> {
    let normalized = url.to_ascii_lowercase().replace("%2f", "/");
    if normalized.contains("/api/pay/commercial/entitlements/token-packs/list") {
        Some("token_packs_list")
    } else if normalized.contains("/api/pay/quota/metering/token-packs/summary") {
        Some("token_packs_summary")
    } else if normalized.contains("/api/pay/quota/metering/api-usage/summary") {
        Some("api_usage_summary")
    } else {
        None
    }
}

fn merge_scrape_response(kind: &str, existing: &str, incoming: &str) -> Option<String> {
    (kind == "token_packs_list")
        .then(|| merge_token_pack_list(existing, incoming))
        .flatten()
}

fn scrape_response_satisfies(kind: &str, body: &str) -> Option<bool> {
    if !matches!(
        kind,
        "token_packs_list" | "token_packs_summary" | "api_usage_summary"
    ) {
        return None;
    }
    let Ok(root) = serde_json::from_str::<serde_json::Value>(body) else {
        return Some(false);
    };
    if kind != "token_packs_list" {
        return Some(true);
    }
    if root
        .get("code")
        .and_then(serde_json::Value::as_i64)
        .is_some_and(|code| code != 0)
    {
        return Some(false);
    }
    let data = root.get("data").unwrap_or(&root);
    let Some(items) = data.get("items").and_then(serde_json::Value::as_array) else {
        return Some(false);
    };
    let history_count = data
        .get("historyCount")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0) as usize;
    let page_size = data
        .get("pageSize")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(history_count as u64) as usize;
    if history_count == 0 {
        return Some(page_size > 1);
    }
    let expected_history_items = history_count.min(page_size.max(1));
    let has_status_codes = items
        .iter()
        .any(|item| item.get("statusCode").is_some() || item.get("displayStatusCode").is_some());
    let captured_history_items = if has_status_codes {
        items
            .iter()
            .filter(|item| {
                item.get("statusCode")
                    .or_else(|| item.get("displayStatusCode"))
                    .and_then(serde_json::Value::as_i64)
                    .is_some_and(|status| status != 1)
            })
            .count()
    } else {
        items.len()
    };
    Some(captured_history_items >= expected_history_items)
}

fn merge_token_pack_list(existing: &str, incoming: &str) -> Option<String> {
    let mut existing_root = serde_json::from_str::<serde_json::Value>(existing).ok()?;
    let incoming_root = serde_json::from_str::<serde_json::Value>(incoming).ok()?;
    let existing_data = existing_root.get("data").unwrap_or(&existing_root);
    let incoming_data = incoming_root.get("data").unwrap_or(&incoming_root);
    let existing_items = existing_data
        .get("items")
        .and_then(serde_json::Value::as_array)?
        .clone();
    let incoming_items = incoming_data
        .get("items")
        .and_then(serde_json::Value::as_array)?
        .clone();

    let mut merged_items = Vec::new();
    let mut item_indexes = std::collections::HashMap::<String, usize>::new();
    for item in existing_items.into_iter().chain(incoming_items) {
        let key = token_pack_item_key(&item)
            .unwrap_or_else(|| serde_json::to_string(&item).unwrap_or_default());
        if let Some(index) = item_indexes.get(&key).copied() {
            merged_items[index] = item;
        } else {
            item_indexes.insert(key, merged_items.len());
            merged_items.push(item);
        }
    }

    let count_fields = [
        "activeCount",
        "historyCount",
        "total",
        "pageSize",
        "totalPage",
    ];
    let merged_counts = count_fields.map(|field| {
        let existing_value = existing_data
            .get(field)
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let incoming_value = incoming_data
            .get(field)
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        (field, existing_value.max(incoming_value))
    });
    let merged_len = merged_items.len() as u64;
    let data = if existing_root.get("data").is_some() {
        existing_root.get_mut("data")?
    } else {
        &mut existing_root
    };
    let data = data.as_object_mut()?;
    data.insert("items".to_string(), serde_json::Value::Array(merged_items));
    for (field, mut value) in merged_counts {
        if field == "total" {
            value = value.max(merged_len);
        }
        data.insert(
            field.to_string(),
            serde_json::Value::Number(serde_json::Number::from(value)),
        );
    }
    serde_json::to_string(&existing_root).ok()
}

fn token_pack_item_key(item: &serde_json::Value) -> Option<String> {
    let id = item.get("resourceId").or_else(|| item.get("packageId"))?;
    id.as_str()
        .map(ToOwned::to_owned)
        .or_else(|| id.as_u64().map(|value| value.to_string()))
        .or_else(|| id.as_i64().map(|value| value.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_model_list_response() {
        let data: OpenAiModelsResponse = serde_json::from_str(
            r#"{
                "object": "list",
                "data": [
                    {"id": "LongCat-2.0", "object": "model", "owned_by": "LongCat"}
                ]
            }"#,
        )
        .unwrap();
        assert_eq!(data.data.len(), 1);
        assert_eq!(data.data[0].id, "LongCat-2.0");
    }

    #[test]
    fn parses_detail_and_maps_model_metadata() {
        let detail: ModelDetail = serde_json::from_str(
            r#"{
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
            }"#,
        )
        .unwrap();
        let model = channel_model("LongCat-2.0".to_string(), detail, "now");
        assert_eq!(model.id, "longcat-LongCat-2.0");
        assert_eq!(model.context_window, Some(1_048_576));
        assert_eq!(model.display_name.as_deref(), Some("LongCat-2.0"));
        assert_eq!(model.pricing.as_ref().unwrap()["prompt"], "2");
        assert_eq!(model.pricing.as_ref().unwrap()["completion"], "8");
        assert!(model.supports_stream);
    }

    #[test]
    fn falls_back_to_list_metadata_when_detail_is_unavailable() {
        let model = channel_model_from_id("LongCat-2.0".to_string(), "now");
        assert_eq!(model.context_window, None);
        assert_eq!(model.pricing, None);
        assert!(model.supports_stream);
        assert_eq!(
            model.supported_protocols,
            vec![ProtocolType::OpenAi, ProtocolType::Anthropic]
        );
    }
}
