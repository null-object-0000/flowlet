//! Flowlet 内置 Codex 模型目录。
//!
//! Codex 使用自定义模型（如 `flowlet-pro` / `flowlet-flash`）时，必须通过
//! `config.toml` 的 `model_catalog_json` 指向一个声明模型元数据（上下文窗口、
//! 推理档位等）的 JSON 文件，否则 Codex 无法正确识别这些模型。
//! 官方参照：DeepSeek 与千问 AI 平台的 Codex 接入文档均要求该文件。
//!
//! 本模块以仓库根目录 `codex-models.json` 为唯一数据源（`include_str!` 内置），
//! 与前端 `src/features/agent-access/AgentAccessSideSheet.tsx` 中的
//! `CODEX_MODEL_CATALOG_JSON` 常量保持一致。

use serde_json::Value;

pub const DEFAULT_CODEX_MODELS_JSON: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../codex-models.json"));

/// 解析内置 Codex 模型目录；失败说明仓库内置文件损坏。
pub fn builtin_catalog() -> Result<Value, String> {
    serde_json::from_str(DEFAULT_CODEX_MODELS_JSON)
        .map_err(|error| format!("解析内置 Codex 模型目录失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Codex CLI（0.137.0 及以后）反序列化 model_catalog_json 时必填/常用字段。
    /// 缺任一必填字段（如 shell_type）会导致 Codex 启动报错：
    /// `failed to parse model_catalog_json ... missing field ...`。
    const CODEX_MODEL_REQUIRED_FIELDS: &[&str] = &[
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

    /// Codex CLI 0.137.0 的 `ReasoningEffort` 合法值（不含 max/ultra）。
    const CODEX_MODEL_VALID_EFFORTS: &[&str] =
        &["none", "minimal", "low", "medium", "high", "xhigh"];

    #[test]
    fn builtin_catalog_is_valid_json_with_flowlet_models() {
        let catalog = builtin_catalog().unwrap();
        let models = catalog
            .get("models")
            .and_then(Value::as_array)
            .expect("models 必须是数组");
        let slugs = models
            .iter()
            .filter_map(|model| model.get("slug").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert!(
            slugs.contains(&"flowlet-pro"),
            "缺少 flowlet-pro: {slugs:?}"
        );
        assert!(
            slugs.contains(&"flowlet-flash"),
            "缺少 flowlet-flash: {slugs:?}"
        );
        for model in models {
            for field in CODEX_MODEL_REQUIRED_FIELDS {
                assert!(
                    model.get(field).is_some(),
                    "model {} 缺少 Codex 必填字段 {field}: {model}",
                    model.get("slug").and_then(Value::as_str).unwrap_or("?"),
                );
            }
            let efforts = model
                .get("supported_reasoning_levels")
                .and_then(Value::as_array)
                .expect("supported_reasoning_levels 必须是数组");
            for preset in efforts {
                let effort = preset
                    .get("effort")
                    .and_then(Value::as_str)
                    .expect("effort 必须是字符串");
                assert!(
                    CODEX_MODEL_VALID_EFFORTS.contains(&effort),
                    "model {} 使用了 Codex 0.137.0 不支持的 effort {effort:?}（合法值 {CODEX_MODEL_VALID_EFFORTS:?}）",
                    model.get("slug").and_then(Value::as_str).unwrap_or("?"),
                );
            }
        }
    }
}
