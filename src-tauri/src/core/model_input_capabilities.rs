use super::config::{
    ChannelAccount, ChannelPreset, ProtocolType, RouteCandidate, ACCOUNT_CREDENTIAL_HEALTHY,
};
use super::model_catalog::{canonical_model_key, model_catalog};
use super::runtime_config::RuntimeConfigSnapshot;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{OnceLock, RwLock};

const TEXT_MODALITY: &str = "text";
const IMAGE_MODALITY: &str = "image";

#[derive(Clone, Debug, Default)]
struct ModelInputCapabilityIndex {
    modalities: HashMap<String, HashSet<String>>,
    models_cn_models: HashSet<String>,
}

impl ModelInputCapabilityIndex {
    fn from_catalogs(models_cn: Option<&str>, models_dev: Option<&str>) -> Self {
        let mut index = Self::default();
        if let Some(raw) = models_cn {
            index.merge_models_cn(raw);
        }
        if let Some(raw) = models_dev {
            index.merge_openrouter_models_dev(raw);
        }
        index
    }

    fn merge_models_cn(&mut self, raw: &str) {
        let Ok(catalog) = serde_json::from_str::<Value>(raw) else {
            return;
        };
        let Some(providers) = catalog.get("providers").and_then(Value::as_array) else {
            return;
        };
        for provider in providers {
            let Some(provider_id) = provider.get("id").and_then(Value::as_str) else {
                continue;
            };
            let Some(models) = provider.get("models").and_then(Value::as_array) else {
                continue;
            };
            for model in models {
                let Some(model_id) = model.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let Some(identity) = model_catalog().find(model_id) else {
                    continue;
                };
                if identity.models_cn_provider_id != provider_id {
                    continue;
                }
                let key = canonical_model_key(model_id);
                self.models_cn_models.insert(key.clone());
                self.modalities.insert(
                    key,
                    normalized_modalities(
                        model
                            .pointer("/capabilities/inputModalities")
                            .and_then(Value::as_array),
                    ),
                );
            }
        }
    }

    fn merge_openrouter_models_dev(&mut self, raw: &str) {
        let Ok(catalog) = serde_json::from_str::<Value>(raw) else {
            return;
        };
        let Some(models) = catalog
            .get("openrouter")
            .and_then(|provider| provider.get("models"))
            .and_then(Value::as_object)
        else {
            return;
        };
        for (model_id, model) in models {
            let key = canonical_model_key(model_id);
            let is_openrouter_model = model_catalog()
                .find(model_id)
                .is_some_and(|identity| identity.owner_channel_id == "openrouter");
            if !is_openrouter_model || self.models_cn_models.contains(&key) {
                continue;
            }
            self.modalities.insert(
                key,
                normalized_modalities(model.pointer("/modalities/input").and_then(Value::as_array)),
            );
        }
    }

    fn supports(&self, model_id: &str, modality: &str) -> bool {
        self.modalities
            .get(&canonical_model_key(model_id))
            .is_some_and(|modalities| modalities.contains(modality))
    }
}

fn normalized_modalities(values: Option<&Vec<Value>>) -> HashSet<String> {
    values
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .collect()
}

fn capability_cache() -> &'static RwLock<Option<ModelInputCapabilityIndex>> {
    static CACHE: OnceLock<RwLock<Option<ModelInputCapabilityIndex>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(None))
}

fn current_index() -> ModelInputCapabilityIndex {
    if let Some(index) = capability_cache()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .cloned()
    {
        return index;
    }
    let mut cache = capability_cache()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(index) = cache.as_ref().cloned() {
        return index;
    }
    let mut models_cn = super::storage::storage_tasks::read_models_cn_file();
    #[cfg(desktop)]
    let mut models_dev = super::storage::storage_tasks::read_models_dev_file();
    #[cfg(not(desktop))]
    let mut models_dev: Option<String> = None;
    // 开发与测试二进制位于 target 目录，模型文件尚未复制到 exe 同级；使用仓库内
    // 随包资源作为同语义后备。发布构建仍只读取 exe 同级的可同步目录。
    #[cfg(debug_assertions)]
    {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        models_cn =
            models_cn.or_else(|| std::fs::read_to_string(manifest.join("models-cn.json")).ok());
        models_dev =
            models_dev.or_else(|| std::fs::read_to_string(manifest.join("models-dev.json")).ok());
    }
    let index =
        ModelInputCapabilityIndex::from_catalogs(models_cn.as_deref(), models_dev.as_deref());
    *cache = Some(index.clone());
    index
}

/// models-cn / models.dev 原子替换成功后使能力缓存失效；下一次需要时再解析。
pub(crate) fn invalidate_cache() {
    *capability_cache()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

pub(crate) fn request_uses_image(body: &[u8], protocol: &ProtocolType) -> bool {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return false;
    };
    match protocol {
        ProtocolType::OpenAi => contains_content_type(&value, &["image_url", "input_image"]),
        ProtocolType::Responses => contains_content_type(&value, &["input_image"]),
        ProtocolType::Anthropic => contains_content_type(&value, &["image"]),
    }
}

fn contains_content_type(value: &Value, image_types: &[&str]) -> bool {
    match value {
        Value::Array(values) => values
            .iter()
            .any(|value| contains_content_type(value, image_types)),
        Value::Object(object) => {
            if object
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| image_types.contains(&kind))
            {
                return true;
            }
            object
                .iter()
                .filter(|(key, _)| matches!(key.as_str(), "messages" | "content" | "input"))
                .any(|(_, value)| contains_content_type(value, image_types))
        }
        _ => false,
    }
}

/// 保留支持图片输入的候选，并按原顺序返回因能力不匹配而跳过的候选。
pub(crate) fn partition_image_capable_candidates(
    candidates: &mut Vec<RouteCandidate>,
) -> Vec<RouteCandidate> {
    let index = current_index();
    partition_image_capable_candidates_with_index(candidates, &index)
}

fn partition_image_capable_candidates_with_index(
    candidates: &mut Vec<RouteCandidate>,
    index: &ModelInputCapabilityIndex,
) -> Vec<RouteCandidate> {
    let original = std::mem::take(candidates);
    let mut skipped = Vec::new();
    for route in original {
        if index.supports(&route.upstream_model, IMAGE_MODALITY) {
            candidates.push(route);
        } else {
            skipped.push(route);
        }
    }
    skipped
}

fn route_is_usable_for_aggregate(
    route: &RouteCandidate,
    accounts: &[ChannelAccount],
    channels: &[ChannelPreset],
) -> bool {
    route.enabled
        && route.client_protocol == ProtocolType::OpenAi
        && accounts.iter().any(|account| {
            account.id == route.account_id
                && account.enabled
                && !account.api_key.trim().is_empty()
                && account.credential_status == ACCOUNT_CREDENTIAL_HEALTHY
        })
        && channels.iter().any(|channel| {
            channel.id == route.channel_id
                && channel.enabled
                && channel.supported_protocols.contains(&ProtocolType::OpenAi)
                && channel
                    .supported_protocols
                    .contains(&ProtocolType::Anthropic)
        })
}

/// Agent 模型配置只声明 Flowlet 当前支持的 text / image。文本始终声明；只要聚合模型
/// 存在一个可用图片候选，就声明 image，代理会在实际图片请求时再次按候选能力过滤。
pub(crate) fn aggregate_model_inputs(
    snapshot: &RuntimeConfigSnapshot,
) -> BTreeMap<String, Vec<String>> {
    let index = current_index();
    ["flowlet-pro", "flowlet-flash"]
        .into_iter()
        .map(|aggregate| {
            let supports_image = snapshot.routes.iter().any(|route| {
                route.virtual_model_id == aggregate
                    && route_is_usable_for_aggregate(route, &snapshot.accounts, &snapshot.channels)
                    && index.supports(&route.upstream_model, IMAGE_MODALITY)
            });
            let mut modalities = vec![TEXT_MODALITY.to_string()];
            if supports_image {
                modalities.push(IMAGE_MODALITY.to_string());
            }
            (aggregate.to_string(), modalities)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_cn_wins_and_models_dev_only_fills_openrouter_gap() {
        let models_cn = r#"{"providers":[
          {"id":"openrouter","models":[{"id":"ox-alpha","capabilities":{"inputModalities":["text"]}}]},
          {"id":"zhipu-cn","models":[{"id":"glm-5.3","capabilities":{"inputModalities":["text","image"]}}]}
        ]}"#;
        let models_dev = r#"{"openrouter":{"models":{
          "stealth/ox-alpha":{"modalities":{"input":["text","image"]}}
        }}}"#;
        let index = ModelInputCapabilityIndex::from_catalogs(Some(models_cn), Some(models_dev));
        assert!(!index.supports("stealth/ox-alpha", IMAGE_MODALITY));
        assert!(index.supports("glm-5.3", IMAGE_MODALITY));
    }

    #[test]
    fn models_dev_fills_missing_openrouter_model() {
        let models_dev = r#"{"openrouter":{"models":{
          "stealth/ox-alpha":{"modalities":{"input":["text","image"]}}
        }}}"#;
        let index = ModelInputCapabilityIndex::from_catalogs(None, Some(models_dev));
        assert!(index.supports("ox-alpha", IMAGE_MODALITY));
    }

    #[test]
    fn detects_protocol_specific_image_parts() {
        assert!(request_uses_image(
            br#"{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,x"}}]}]}"#,
            &ProtocolType::OpenAi,
        ));
        assert!(request_uses_image(
            br#"{"input":[{"role":"user","content":[{"type":"input_image","image_url":"https://example.test/a.png"}]}]}"#,
            &ProtocolType::Responses,
        ));
        assert!(request_uses_image(
            br#"{"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64"}}]}]}"#,
            &ProtocolType::Anthropic,
        ));
        assert!(!request_uses_image(
            br#"{"messages":[{"role":"user","content":"describe an image"}]}"#,
            &ProtocolType::OpenAi,
        ));
    }

    #[test]
    fn image_filter_preserves_order_and_removes_text_only_candidates() {
        let models_cn = r#"{"providers":[{"id":"zhipu-cn","models":[
          {"id":"glm-5.3","capabilities":{"inputModalities":["text","image"]}},
          {"id":"glm-5.2","capabilities":{"inputModalities":["text"]}}
        ]}]}"#;
        let index = ModelInputCapabilityIndex::from_catalogs(Some(models_cn), None);
        let mut candidates = vec![
            RouteCandidate {
                id: "text-only".to_string(),
                upstream_model: "glm-5.2".to_string(),
                ..Default::default()
            },
            RouteCandidate {
                id: "vision".to_string(),
                upstream_model: "glm-5.3".to_string(),
                ..Default::default()
            },
        ];
        let skipped = partition_image_capable_candidates_with_index(&mut candidates, &index);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].id, "vision");
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].id, "text-only");
    }
}
