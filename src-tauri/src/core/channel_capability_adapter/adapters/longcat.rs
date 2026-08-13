use super::super::*;

fn sync<'a>(
    account: &'a ChannelAccount,
    _preset: &'a ChannelPreset,
    config: &'a ChannelsConfig,
) -> ModelSyncFuture<'a> {
    Box::pin(crate::core::sync::sync_longcat_models(account, config))
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
