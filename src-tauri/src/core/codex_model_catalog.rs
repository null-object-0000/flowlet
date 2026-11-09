//! Flowlet 动态 Codex 模型目录。
//!
//! 聚合模型（`flowlet-pro` / `flowlet-flash`）移除后，Codex 的默认模型由用户在接入
//! 抽屉中显式选择，取值为 `model-catalog.json` 里的规范模型 ID。Codex 使用不在其
//! 内置目录中的自定义模型时，必须通过 `config.toml` 的 `model_catalog_json` 声明模型
//! 元数据（上下文窗口、推理档位等），否则无法正确识别该模型。
//!
//! 因此本模块按所选模型 **动态生成** 只含一条目的目录：
//!
//! - `context_window` / `max_context_window`：取 `models-cn.json` 的
//!   `limits.contextTokens`；
//! - `input_modalities`：取 `capabilities.inputModalities` 并只保留 `text` / `image`；
//! - `supported_reasoning_levels`：按 `capabilities.thinking` 给档位，未知时回退
//!   `low` / `medium` / `high`；
//! - 其余必需字段沿用原静态目录的固定值（Codex 启动时 serde 反序列化缺字段即报错）。
//!
//! 模型在 `models-cn.json` 中查不到（例如 ChatGPT API 的 `gpt-6.x` 系列不在 CN 目录）
//! 时使用保守条目（上下文窗口 128000、仅 `text`）并通过 `tracing::warn!` 提示，绝不
//! 直接失败：写配置仍是用户可完成的动作，目录只是客户端元数据。

use serde_json::{json, Value};

use super::model_catalog::canonical_model_key;

/// 查不到模型规格时的保守上下文窗口。
const FALLBACK_CONTEXT_WINDOW: i64 = 128_000;

/// Codex CLI 0.137.0 及以后反序列化 `model_catalog_json` 时必填/常用字段。
///
/// 缺任一必填字段（如 `shell_type`）会导致 Codex 启动报错：
/// `failed to parse model_catalog_json ... missing field ...`。
#[cfg(test)]
pub(crate) const CODEX_MODEL_REQUIRED_FIELDS: &[&str] = &[
    "slug",
    "display_name",
    "description",
    "default_reasoning_level",
    "supported_reasoning_levels",
    "shell_type",
    "visibility",
    "supported_in_api",
    "priority",
    "base_instructions",
    "supports_reasoning_summaries",
    "support_verbosity",
    "truncation_policy",
    "supports_parallel_tool_calls",
    "context_window",
    "effective_context_window_percent",
    "experimental_supported_tools",
];

/// Codex CLI 0.137.0 的 `ReasoningEffort` 合法值（不含 `max` / `ultra`）。
#[cfg(test)]
pub(crate) const CODEX_MODEL_VALID_EFFORTS: &[&str] =
    &["none", "minimal", "low", "medium", "high", "xhigh"];

/// `models-cn.json` 中与规范模型对应的一条能力事实。
#[derive(Clone, Debug, Default)]
struct ModelsCnSpec {
    /// 目录里的展示名（`models-cn.json` 的 `name`），用于 Codex `display_name`。
    display_name: Option<String>,
    context_tokens: Option<i64>,
    /// 已过滤为客户端可声明的 `text` / `image`，顺序与目录一致。
    input_modalities: Vec<String>,
    thinking: Option<bool>,
}

/// 生成某个规范模型对应的 Codex 模型目录（单条目）。
///
/// `raw_models_cn` 为 `models-cn.json` 原文；`None` 表示本机没有可用目录文件。
pub(crate) fn catalog_for_model(raw_models_cn: Option<&str>, model: &str) -> Value {
    let spec = raw_models_cn
        .and_then(|raw| models_cn_spec(raw, model))
        .unwrap_or_default();
    if spec.context_tokens.is_none() {
        tracing::warn!(
            model,
            "models-cn.json 缺少该模型的上下文窗口规格，Codex 模型目录使用保守条目（context_window={FALLBACK_CONTEXT_WINDOW}）"
        );
    }
    let supported_efforts = reasoning_efforts(spec.thinking);
    let default_effort = default_reasoning_level(spec.thinking);
    let context_window = spec.context_tokens.unwrap_or(FALLBACK_CONTEXT_WINDOW);
    let input_modalities = declared_input_modalities(&spec.input_modalities);
    let display_name = spec.display_name.unwrap_or_else(|| model.to_string());

    json!({
        "models": [{
            "slug": model,
            "display_name": display_name,
            "description": format!("Flowlet 本地代理转发的 {model}"),
            "default_reasoning_level": default_effort,
            "supported_reasoning_levels": supported_efforts
                .iter()
                .map(|effort| json!({ "effort": effort, "description": reasoning_description(effort) }))
                .collect::<Vec<_>>(),
            "shell_type": "shell_command",
            "visibility": "list",
            "supported_in_api": true,
            "priority": 1,
            "base_instructions": "",
            "supports_reasoning_summaries": spec.thinking.unwrap_or(false),
            "default_reasoning_summary": "none",
            "support_verbosity": false,
            "default_verbosity": null,
            "apply_patch_tool_type": "freeform",
            "web_search_tool_type": "text",
            "truncation_policy": { "mode": "tokens", "limit": 10000 },
            "supports_parallel_tool_calls": true,
            "supports_image_detail_original": false,
            "context_window": context_window,
            "max_context_window": context_window,
            "auto_compact_token_limit": null,
            "effective_context_window_percent": 95,
            "experimental_supported_tools": [],
            "input_modalities": input_modalities,
            "availability_nux": null,
            "upgrade": null
        }]
    })
}

/// 生成要写入磁盘的模型目录文本（缩进 + 末尾换行，便于用户查看 diff）。
pub(crate) fn catalog_content(raw_models_cn: Option<&str>, model: &str) -> Result<String, String> {
    let catalog = catalog_for_model(raw_models_cn, model);
    let content = serde_json::to_string_pretty(&catalog)
        .map_err(|error| format!("序列化 Codex 模型目录失败：{error}"))?;
    Ok(format!("{content}\n"))
}

/// 判断磁盘上的模型目录内容是否声明了指定模型（inspect 使用；解析失败视为未声明）。
pub(crate) fn catalog_declares_model(raw: &str, model: &str) -> bool {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|catalog| {
            catalog
                .get("models")
                .and_then(Value::as_array)
                .map(|models| {
                    models
                        .iter()
                        .any(|entry| entry.get("slug").and_then(Value::as_str) == Some(model))
                })
        })
        .unwrap_or(false)
}

/// 在 `models-cn.json` 中查找规范模型对应的能力事实。
///
/// 查找必须按规范 ID **双侧归一**：CN 目录按厂商自己的模型名收录（如 DeepSeek 的
/// `deepseek-flash` 是白名单规范 ID `deepseek-v4.1-flash` 的别名），且同一模型 ID 可能
/// 同时出现在国内/国际两个 provider 下，因此先按 `model-catalog.json` 的
/// `modelsCnProviderId` 锁定 provider，再按规范 ID 比较。
fn models_cn_spec(raw: &str, model: &str) -> Option<ModelsCnSpec> {
    let identity = super::model_catalog::model_catalog().find(model)?;
    let catalog: Value = serde_json::from_str(raw).ok()?;
    let providers = catalog.get("providers").and_then(Value::as_array)?;
    let wanted_key = canonical_model_key(&identity.id);
    for provider in providers {
        let Some(provider_id) = provider.get("id").and_then(Value::as_str) else {
            continue;
        };
        if provider_id != identity.models_cn_provider_id {
            continue;
        }
        let Some(models) = provider.get("models").and_then(Value::as_array) else {
            continue;
        };
        for entry in models {
            let Some(entry_id) = entry.get("id").and_then(Value::as_str) else {
                continue;
            };
            if canonical_model_key(entry_id) != wanted_key {
                continue;
            }
            return Some(ModelsCnSpec {
                display_name: entry
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(str::to_string),
                context_tokens: entry
                    .pointer("/limits/contextTokens")
                    .and_then(Value::as_i64)
                    .filter(|tokens| *tokens > 0),
                input_modalities: entry
                    .pointer("/capabilities/inputModalities")
                    .and_then(Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(Value::as_str)
                            .map(|value| value.trim().to_ascii_lowercase())
                            .filter(|value| matches!(value.as_str(), "text" | "image"))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default(),
                thinking: entry
                    .pointer("/capabilities/thinking")
                    .and_then(Value::as_bool),
            });
        }
    }
    None
}

/// Codex 只声明客户端官方支持的输入模态；文本是对话必需项，始终声明。
fn declared_input_modalities(catalog_modalities: &[String]) -> Vec<String> {
    let mut modalities = vec!["text".to_string()];
    if catalog_modalities.iter().any(|value| value == "image") {
        modalities.push("image".to_string());
    }
    modalities
}

/// 按 `capabilities.thinking` 给推理档位：
/// - 明确支持推理：给完整合法集合（含 `xhigh`）；
/// - 不支持推理或能力未知：回退 `low` / `medium` / `high`，与旧静态目录的快速模型一致。
fn reasoning_efforts(thinking: Option<bool>) -> Vec<&'static str> {
    match thinking {
        Some(true) => vec!["low", "medium", "high", "xhigh"],
        _ => vec!["low", "medium", "high"],
    }
}

fn default_reasoning_level(thinking: Option<bool>) -> &'static str {
    match thinking {
        Some(true) => "high",
        _ => "medium",
    }
}

fn reasoning_description(effort: &str) -> &'static str {
    match effort {
        "none" => "Disable reasoning",
        "minimal" => "Minimal reasoning for simple tasks",
        "low" => "Fast responses with lighter reasoning",
        "medium" => "Greater reasoning depth for complex problems",
        "high" => "Extra high reasoning depth for complex problems",
        "xhigh" => "Maximum reasoning depth for the hardest problems",
        _ => "Reasoning",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 与 `models-cn.json` 结构一致的最小 fixture：一个支持图片与推理的模型、
    /// 一个纯文本模型，以及一个 CN 目录里不存在的规范模型。
    const MODELS_CN_FIXTURE: &str = r#"{
      "providers": [
        {
          "id": "longcat",
          "models": [
            {
              "id": "LongCat-2.5",
              "name": "LongCat-2.5",
              "capabilities": { "thinking": true, "inputModalities": ["text", "image", "video"] },
              "limits": { "contextTokens": 1048576, "maxOutputTokens": 262144 }
            }
          ]
        },
        {
          "id": "zhipu-cn",
          "models": [
            {
              "id": "glm-5.3",
              "name": "GLM-5.3",
              "capabilities": { "thinking": true, "inputModalities": ["text"] },
              "limits": { "contextTokens": 1000000, "maxOutputTokens": 131072 }
            }
          ]
        }
      ]
    }"#;

    fn single_entry(catalog: &Value) -> &Value {
        catalog
            .get("models")
            .and_then(Value::as_array)
            .and_then(|models| models.first())
            .expect("模型目录 models 必须是非空数组")
    }

    #[test]
    fn generated_entry_has_every_codex_required_field() {
        let catalog = catalog_for_model(Some(MODELS_CN_FIXTURE), "glm-5.3");
        let entry = single_entry(&catalog);
        for field in CODEX_MODEL_REQUIRED_FIELDS {
            assert!(
                entry.get(field).is_some(),
                "模型条目缺少 Codex 必填字段 {field}: {entry}"
            );
        }
        assert_eq!(entry["slug"], "glm-5.3");
        assert_eq!(entry["context_window"], 1_000_000);
        assert_eq!(entry["max_context_window"], 1_000_000);
        assert_eq!(entry["input_modalities"], serde_json::json!(["text"]));
    }

    #[test]
    fn image_capable_model_declares_text_and_image_only() {
        let catalog = catalog_for_model(Some(MODELS_CN_FIXTURE), "LongCat-2.5");
        let entry = single_entry(&catalog);
        // 目录里的 video 不是 Codex 可声明输入模态，必须被丢弃。
        assert_eq!(
            entry["input_modalities"],
            serde_json::json!(["text", "image"])
        );
        assert_eq!(entry["context_window"], 1_048_576);
    }

    #[test]
    fn thinking_model_gets_full_reasoning_levels_and_valid_efforts() {
        let catalog = catalog_for_model(Some(MODELS_CN_FIXTURE), "glm-5.3");
        let entry = single_entry(&catalog);
        let efforts = entry["supported_reasoning_levels"]
            .as_array()
            .expect("supported_reasoning_levels 必须是数组");
        let effort_names = efforts
            .iter()
            .map(|preset| preset["effort"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(effort_names, vec!["low", "medium", "high", "xhigh"]);
        for effort in effort_names {
            assert!(
                CODEX_MODEL_VALID_EFFORTS.contains(&effort),
                "使用了 Codex 0.137.0 不支持的 effort {effort:?}"
            );
        }
        let default = entry["default_reasoning_level"].as_str().unwrap();
        assert!(efforts
            .iter()
            .any(|preset| preset["effort"].as_str() == Some(default)));
    }

    #[test]
    fn unknown_model_falls_back_to_conservative_entry() {
        // gpt-6.1-sol 属于 ChatGPT API，不在 models-cn.json（CN 厂商目录）里。
        let catalog = catalog_for_model(Some(MODELS_CN_FIXTURE), "gpt-6.1-sol");
        let entry = single_entry(&catalog);
        assert_eq!(entry["slug"], "gpt-6.1-sol");
        assert_eq!(entry["context_window"], 128_000);
        assert_eq!(entry["max_context_window"], 128_000);
        assert_eq!(entry["input_modalities"], serde_json::json!(["text"]));
        // 能力未知时回退 low / medium / high，且默认档位必须在支持集合内。
        let efforts = entry["supported_reasoning_levels"].as_array().unwrap();
        assert_eq!(efforts.len(), 3);
        assert_eq!(efforts[0]["effort"], "low");
        assert_eq!(entry["default_reasoning_level"], "medium");
        for field in CODEX_MODEL_REQUIRED_FIELDS {
            assert!(entry.get(field).is_some(), "保守条目缺少字段 {field}");
        }
    }

    #[test]
    fn missing_catalog_file_still_produces_conservative_entry() {
        let catalog = catalog_for_model(None, "glm-5.3");
        let entry = single_entry(&catalog);
        assert_eq!(entry["context_window"], 128_000);
        assert_eq!(entry["input_modalities"], serde_json::json!(["text"]));
    }

    #[test]
    fn alias_normalizes_to_one_single_canonical_slug() {
        // deepseek-flash 是规范模型 deepseek-v4.1-flash 的别名；目录条目按规范 ID 归一后
        // 必须只声明一条 slug，且 slug 写规范 ID（客户端请求用它）。
        let fixture = r#"{
          "providers": [{
            "id": "deepseek",
            "models": [{
              "id": "deepseek-flash",
              "name": "DeepSeek V4.1 Flash",
              "capabilities": { "thinking": true, "inputModalities": ["text"] },
              "limits": { "contextTokens": 1048576 }
            }]
          }]
        }"#;
        let catalog = catalog_for_model(Some(fixture), "deepseek-v4.1-flash");
        let entry = single_entry(&catalog);
        assert_eq!(entry["slug"], "deepseek-v4.1-flash");
        assert_eq!(entry["context_window"], 1_048_576);
        assert_eq!(entry["display_name"], "DeepSeek V4.1 Flash");
    }

    #[test]
    fn catalog_content_and_declaration_check_round_trip() {
        let content = catalog_content(Some(MODELS_CN_FIXTURE), "glm-5.3").unwrap();
        assert!(content.ends_with('\n'));
        assert!(catalog_declares_model(&content, "glm-5.3"));
        assert!(!catalog_declares_model(&content, "gpt-6.1-sol"));
        assert!(!catalog_declares_model("{not json", "glm-5.3"));
    }

    #[test]
    fn real_models_cn_catalog_produces_spec_for_cn_model() {
        // 只校验真实目录文件仍能被本模块解析；具体数值由目录维护者负责。
        let Some(raw) = super::super::model_input_capabilities::read_models_cn_source() else {
            return; // 运行期没有目录文件时跳过（发布构建可能尚未同步）。
        };
        let catalog = catalog_for_model(Some(&raw), "glm-5.3");
        let entry = single_entry(&catalog);
        assert_eq!(entry["slug"], "glm-5.3");
        assert_eq!(entry["input_modalities"], serde_json::json!(["text"]));
        assert!(
            entry["context_window"].as_i64().unwrap_or(0) > 0,
            "真实目录中的 glm-5.3 应有上下文窗口"
        );
    }
}
