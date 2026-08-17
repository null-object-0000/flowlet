use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

const MODEL_CATALOG_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../model-catalog.json"
));

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelCatalogJson {
    schema_version: u32,
    models: Vec<ModelIdentity>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelIdentity {
    pub id: String,
    pub owner_channel_id: String,
    pub models_cn_provider_id: String,
    #[serde(default)]
    pub aliases: Vec<String>,
}

#[derive(Debug)]
pub struct ModelCatalog {
    models: Vec<ModelIdentity>,
    canonical_index: HashMap<String, usize>,
    alias_index: HashMap<String, usize>,
}

impl ModelCatalog {
    fn from_json(json: &str) -> Result<Self, String> {
        let parsed: ModelCatalogJson = serde_json::from_str(json)
            .map_err(|error| format!("解析 model-catalog.json 失败：{error}"))?;
        if parsed.schema_version != 1 {
            return Err(format!(
                "不支持的 model-catalog.json schemaVersion：{}",
                parsed.schema_version
            ));
        }

        let mut canonical_index = HashMap::new();
        let mut alias_index = HashMap::new();
        for (index, model) in parsed.models.iter().enumerate() {
            if model.id.trim().is_empty()
                || model.owner_channel_id.trim().is_empty()
                || model.models_cn_provider_id.trim().is_empty()
            {
                return Err(
                    "model-catalog.json 的模型 ID、归属渠道和 models-cn provider 不能为空"
                        .to_string(),
                );
            }
            let canonical_key = model.id.trim().to_lowercase();
            if canonical_index
                .insert(canonical_key.clone(), index)
                .is_some()
            {
                return Err(format!("model-catalog.json 存在重复模型：{}", model.id));
            }
            for alias in &model.aliases {
                let alias_key = alias.trim().to_lowercase();
                if alias_key.is_empty()
                    || alias_key == canonical_key
                    || alias_index.insert(alias_key.clone(), index).is_some()
                {
                    return Err(format!("model-catalog.json 存在无效或重复别名：{alias}"));
                }
            }
        }

        let canonical_keys: HashSet<_> = canonical_index.keys().cloned().collect();
        if let Some(alias) = alias_index
            .keys()
            .find(|alias| canonical_keys.contains(*alias))
        {
            return Err(format!(
                "model-catalog.json 别名与规范模型 ID 冲突：{alias}"
            ));
        }

        Ok(Self {
            models: parsed.models,
            canonical_index,
            alias_index,
        })
    }

    pub fn canonical_key(&self, model_id: &str) -> String {
        let raw = model_id.trim();
        let key = raw.rsplit('/').next().unwrap_or(raw).trim().to_lowercase();
        self.alias_index
            .get(&key)
            .map(|index| self.models[*index].id.trim().to_lowercase())
            .unwrap_or(key)
    }

    pub fn find(&self, model_id: &str) -> Option<&ModelIdentity> {
        let key = self.canonical_key(model_id);
        self.canonical_index
            .get(&key)
            .map(|index| &self.models[*index])
    }

    pub fn supported_models(&self) -> Vec<String> {
        self.models.iter().map(|model| model.id.clone()).collect()
    }

    #[cfg(test)]
    pub(crate) fn models(&self) -> &[ModelIdentity] {
        &self.models
    }

    pub fn owner_channel_for_models_cn_provider(&self, provider_id: &str) -> Option<&str> {
        self.models
            .iter()
            .find(|model| model.models_cn_provider_id == provider_id)
            .map(|model| model.owner_channel_id.as_str())
    }
}

pub fn model_catalog() -> &'static ModelCatalog {
    static CATALOG: OnceLock<ModelCatalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        assert_eq!(
            super::plugin_registry::plugin_registry().model_catalog_source(),
            "model-catalog.json",
            "模型目录必须由内置插件注册表声明"
        );
        ModelCatalog::from_json(MODEL_CATALOG_JSON)
            .expect("内置 model-catalog.json 必须通过结构与唯一性校验")
    })
}

pub(crate) fn canonical_model_key(model_id: &str) -> String {
    model_catalog().canonical_key(model_id)
}

pub(crate) fn official_channel_id_for_model(model_id: &str) -> Option<&'static str> {
    model_catalog()
        .find(model_id)
        .map(|model| model.owner_channel_id.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_catalog_is_valid_and_has_expected_models() {
        let catalog = model_catalog();
        assert_eq!(catalog.supported_models().len(), 15);
        assert_eq!(
            catalog.find("LongCat-2.0").unwrap().owner_channel_id,
            "longcat"
        );
        assert_eq!(catalog.find("GLM-5.3").unwrap().owner_channel_id, "zhipu");
        assert_eq!(catalog.find("GLM-5.2").unwrap().owner_channel_id, "zhipu");
        assert_eq!(
            catalog.owner_channel_for_models_cn_provider("moonshot-cn"),
            Some("kimi")
        );
    }

    #[test]
    fn embedded_channel_defaults_match_catalog_ownership() {
        let config: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../config.json"
        )))
        .unwrap();
        let defaults = config["channels_config"]["default_exposed_models"]
            .as_object()
            .unwrap();
        for model in &model_catalog().models {
            let owner_models = defaults[&model.owner_channel_id].as_array().unwrap();
            assert!(
                owner_models
                    .iter()
                    .any(|value| value.as_str() == Some(&model.id)),
                "config.json 缺少 {} 的归属预设 {}",
                model.id,
                model.owner_channel_id
            );
        }
        let configured_count: usize = defaults
            .values()
            .map(|models| models.as_array().unwrap().len())
            .sum();
        assert_eq!(configured_count, model_catalog().models.len());
    }

    #[test]
    fn aliases_and_aggregate_prefixes_resolve_to_the_same_identity() {
        let catalog = model_catalog();
        let direct = catalog.find("deepseek-v4-flash").unwrap();
        let alias = catalog.find("deepseek/deepseek-v4-flash-0731").unwrap();
        assert_eq!(direct.id, alias.id);
        assert_eq!(alias.models_cn_provider_id, "deepseek");
    }

    #[test]
    fn invalid_catalog_is_rejected() {
        let duplicate = r#"{
          "schemaVersion": 1,
          "models": [
            {"id":"m","ownerChannelId":"a","modelsCnProviderId":"p","aliases":["x"]},
            {"id":"M","ownerChannelId":"b","modelsCnProviderId":"q","aliases":[]}
          ]
        }"#;
        assert!(ModelCatalog::from_json(duplicate)
            .unwrap_err()
            .contains("重复模型"));
    }
}
