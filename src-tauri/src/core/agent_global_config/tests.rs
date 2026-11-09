//! Agent 全局配置写入的生命周期契约测试。
//!
//! 聚合模型（`flowlet-pro` / `flowlet-flash`）移除后，默认模型由用户在接入抽屉中
//! 显式选择。这里的测试覆盖：Options / Report 字段契约、模型校验与缺省注入、
//! 六个 Adapter 的 inspect -> apply -> reapply -> restore 生命周期，以及 Codex
//! 动态模型目录。每个 Adapter 至少验证一次「写入结果里不再出现聚合模型名和
//! `[1m]` / `modalities` / `contextWindow` 等已删除声明」。

use super::adapters::claude_code::{
    apply_claude_code, backup_path, inspect_claude_code, restore_claude_code,
};
use super::adapters::codex::{
    apply_codex, codex_backup_path, inspect_codex, restore_codex, CODEX_MODEL_CATALOG_FILE,
    CODEX_MODEL_CATALOG_REF,
};
use super::adapters::hermes::{apply_hermes, inspect_hermes, restore_hermes};
use super::adapters::opencode::{
    apply_opencode, inspect_opencode, opencode_backup_path, read_jsonc_settings, restore_opencode,
    upgrade_opencode_backup_with_server,
};
use super::adapters::pi::{
    apply_pi, inspect_pi, restore_pi, PI_PROVIDER_ID, PI_SESSION_EXTENSION_SOURCE,
};
use super::*;

/// 测试用的主模型 / 快速模型：都是 model-catalog.json 里登记的规范模型。
const PRIMARY_MODEL: &str = "kimi-k3";
const FAST_MODEL: &str = "glm-5.3";

fn options_with_models(primary: Option<&str>, fast: Option<&str>) -> AgentGlobalConfigOptions {
    AgentGlobalConfigOptions {
        primary_model: primary.map(str::to_string),
        fast_model: fast.map(str::to_string),
        ..Default::default()
    }
}

fn test_settings_path() -> PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "flowlet-agent-global-config-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&directory).unwrap();
    directory.join("settings.json")
}

fn test_opencode_paths() -> (PathBuf, PathBuf) {
    let directory = std::env::temp_dir().join(format!(
        "flowlet-opencode-global-config-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&directory).unwrap();
    (
        directory.join("config").join("opencode.jsonc"),
        directory.join("data").join("auth.json"),
    )
}

fn test_pi_paths() -> (PathBuf, PathBuf, PathBuf, PathBuf) {
    let directory =
        std::env::temp_dir().join(format!("flowlet-pi-global-config-{}", uuid::Uuid::new_v4()));
    let extensions = directory.join("extensions");
    std::fs::create_dir_all(&extensions).unwrap();
    (
        directory.join("settings.json"),
        directory.join("models.json"),
        directory.join("auth.json"),
        extensions.join("flowlet.ts"),
    )
}

fn test_codex_paths() -> (PathBuf, PathBuf, PathBuf) {
    let directory = std::env::temp_dir().join(format!(
        "flowlet-codex-global-config-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&directory).unwrap();
    (
        directory.join("config.toml"),
        directory.join("auth.json"),
        directory.join(CODEX_MODEL_CATALOG_FILE),
    )
}

fn parse_toml(path: &Path) -> toml_edit::DocumentMut {
    std::fs::read_to_string(path)
        .unwrap()
        .parse::<toml_edit::DocumentMut>()
        .unwrap()
}

fn toml_str<'a>(doc: &'a toml_edit::DocumentMut, key: &str) -> Option<&'a str> {
    doc.get(key)
        .and_then(|item| item.as_value())
        .and_then(|value| value.as_str())
}

fn toml_bool(doc: &toml_edit::DocumentMut, key: &str) -> Option<bool> {
    doc.get(key)
        .and_then(|item| item.as_value())
        .and_then(|value| value.as_bool())
}

/// 受管配置文件里不允许再出现已删除的聚合模型名。
fn assert_no_aggregate_model(content: &str) {
    assert!(
        !content.contains("flowlet-pro"),
        "受管配置不应再出现聚合模型 flowlet-pro：{content}"
    );
    assert!(
        !content.contains("flowlet-flash"),
        "受管配置不应再出现聚合模型 flowlet-flash：{content}"
    );
}

// ─── Options / 模型解析契约 ─────────────────────────────────────────────

#[test]
fn options_deserialize_primary_and_fast_models_and_ignore_removed_fields() {
    let options: AgentGlobalConfigOptions = serde_json::from_value(serde_json::json!({
        "primaryModel": "kimi-k3",
        "fastModel": "glm-5.3",
        "sessionExtension": true,
        "mcpServers": [],
        // 旧前端字段：必须被忽略，而不是重新生效。
        "longContext": true,
        "primaryLongContext": true,
        "fastLongContext": true,
        "modelSpecs": true,
    }))
    .unwrap();
    assert_eq!(options.primary_model.as_deref(), Some("kimi-k3"));
    assert_eq!(options.fast_model.as_deref(), Some("glm-5.3"));
    assert_eq!(options.session_extension, Some(true));
}

#[test]
fn resolve_model_choices_requires_known_canonical_models() {
    // 缺省：fastModel 回退到 primaryModel。
    let (primary, fast) =
        resolve_model_choices(Some(&options_with_models(Some("LongCat-2.5"), None))).unwrap();
    assert_eq!(primary, "LongCat-2.5");
    assert_eq!(fast, "LongCat-2.5");

    // 别名 / 厂商前缀写法按目录归一为规范模型 ID。
    let (primary, fast) = resolve_model_choices(Some(&options_with_models(
        Some("deepseek-flash"),
        Some("openai/gpt-6.1-sol"),
    )))
    .unwrap();
    assert_eq!(primary, "deepseek-v4.1-flash");
    assert_eq!(fast, "gpt-6.1-sol");

    // 未指定主模型 → 结构化错误。
    let error = resolve_model_choices(None).unwrap_err();
    assert!(error.contains("未指定默认模型"), "{error}");
    let error = resolve_model_choices(Some(&options_with_models(Some("  "), None))).unwrap_err();
    assert!(error.contains("未指定默认模型"), "{error}");

    // 非法模型（含已移除的聚合模型）→ 结构化错误，绝不写入。
    for invalid in ["flowlet-pro", "flowlet-flash", "gpt-4o", "not-a-model"] {
        let error =
            resolve_model_choices(Some(&options_with_models(Some(invalid), None))).unwrap_err();
        assert!(
            error.contains("不在 Flowlet 模型目录中"),
            "{invalid}: {error}"
        );
    }
    // 快速模型也必须校验。
    let error = resolve_model_choices(Some(&options_with_models(
        Some(PRIMARY_MODEL),
        Some("flowlet-flash"),
    )))
    .unwrap_err();
    assert!(error.contains("不在 Flowlet 模型目录中"), "{error}");
}

// ─── Claude Code ──────────────────────────────────────────────────────

#[test]
fn claude_code_applies_selected_models_and_restores_managed_fields() {
    let path = test_settings_path();
    std::fs::write(
        &path,
        r#"{"theme":"dark","env":{"ANTHROPIC_BASE_URL":"https://old.example","CUSTOM":"keep","ANTHROPIC_API_KEY":"old-secret","ANTHROPIC_SMALL_FAST_MODEL":"LongCat-2.0"}}"#,
    )
    .unwrap();

    let applied = apply_claude_code(
        &path,
        "http://127.0.0.1:18640/anthropic",
        "flowlet-token",
        PRIMARY_MODEL,
        FAST_MODEL,
    )
    .unwrap();
    assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
    assert!(applied.backup_available);
    assert_eq!(applied.primary_model.as_deref(), Some(PRIMARY_MODEL));
    assert_eq!(applied.fast_model.as_deref(), Some(FAST_MODEL));
    assert_eq!(applied.subagent_model.as_deref(), Some(FAST_MODEL));

    let current = read_settings(&path).unwrap();
    assert_eq!(current["theme"], "dark");
    assert_eq!(current["env"]["CUSTOM"], "keep");
    assert!(current["env"].get("ANTHROPIC_API_KEY").is_none());
    for name in [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_FABLE_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
    ] {
        assert_eq!(current["env"][name], PRIMARY_MODEL, "{name}");
    }
    for name in [
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
    ] {
        assert_eq!(current["env"][name], FAST_MODEL, "{name}");
    }
    // 不再写入 [1m] 长上下文后缀。
    let written = std::fs::read_to_string(&path).unwrap();
    assert!(!written.to_ascii_lowercase().contains("[1m]"), "{written}");
    assert_no_aggregate_model(&written);

    // reapply：切换模型后收敛到新值，不残留旧值。
    let reapplied = apply_claude_code(
        &path,
        "http://127.0.0.1:18640/anthropic",
        "flowlet-token",
        "LongCat-2.5",
        "LongCat-2.0",
    )
    .unwrap();
    assert_eq!(reapplied.state, AgentGlobalConfigState::Flowlet);
    assert_eq!(reapplied.primary_model.as_deref(), Some("LongCat-2.5"));
    assert_eq!(reapplied.fast_model.as_deref(), Some("LongCat-2.0"));

    let restored = restore_claude_code(&path, "http://127.0.0.1:18640/anthropic").unwrap();
    assert_eq!(restored.state, AgentGlobalConfigState::OtherGateway);
    assert!(!restored.backup_available);
    let restored_settings = read_settings(&path).unwrap();
    assert_eq!(
        restored_settings["env"]["ANTHROPIC_BASE_URL"],
        "https://old.example"
    );
    assert_eq!(restored_settings["env"]["ANTHROPIC_API_KEY"], "old-secret");
    assert_eq!(
        restored_settings["env"]["ANTHROPIC_SMALL_FAST_MODEL"],
        "LongCat-2.0"
    );
    assert_eq!(restored_settings["env"]["CUSTOM"], "keep");

    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[test]
fn claude_code_reports_partial_when_alias_group_or_model_drifted() {
    // 早期版本缺少 ANTHROPIC_DEFAULT_FABLE_MODEL：组内不一致 → Partial，重新写入收敛。
    let path = test_settings_path();
    std::fs::write(
        &path,
        format!(
            r#"{{
  "env": {{
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:18640/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "flowlet-token",
    "ANTHROPIC_MODEL": "{PRIMARY_MODEL}",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "{PRIMARY_MODEL}",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "{PRIMARY_MODEL}",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "{FAST_MODEL}",
    "ANTHROPIC_SMALL_FAST_MODEL": "{FAST_MODEL}",
    "CLAUDE_CODE_SUBAGENT_MODEL": "{FAST_MODEL}"
  }}
}}"#
        ),
    )
    .unwrap();
    let inspected = inspect_claude_code(&path, "http://127.0.0.1:18640/anthropic").unwrap();
    assert_eq!(inspected.state, AgentGlobalConfigState::Partial);

    let applied = apply_claude_code(
        &path,
        "http://127.0.0.1:18640/anthropic",
        "flowlet-token",
        PRIMARY_MODEL,
        FAST_MODEL,
    )
    .unwrap();
    assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);

    // 历史聚合模型 + [1m] 后缀的旧配置：模型不在目录中 → Partial，提示重新接入。
    let path = test_settings_path();
    std::fs::write(
        &path,
        r#"{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:18640/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "flowlet-token",
    "ANTHROPIC_MODEL": "flowlet-pro[1m]",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "flowlet-pro[1m]",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "flowlet-pro[1m]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "flowlet-pro[1m]",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "flowlet-flash",
    "ANTHROPIC_SMALL_FAST_MODEL": "flowlet-flash",
    "CLAUDE_CODE_SUBAGENT_MODEL": "flowlet-flash"
  }
}"#,
    )
    .unwrap();
    let legacy = inspect_claude_code(&path, "http://127.0.0.1:18640/anthropic").unwrap();
    assert_eq!(legacy.state, AgentGlobalConfigState::Partial);
    // inspect 不再把 [1m] 解析成长上下文状态。
    assert!(!serde_json::to_string(&legacy)
        .unwrap()
        .contains("long_context"));

    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[test]
fn claude_code_removes_files_created_only_for_flowlet_on_restore() {
    let path = test_settings_path();
    let directory = path.parent().unwrap().to_path_buf();

    apply_claude_code(
        &path,
        "http://127.0.0.1:18640/anthropic",
        "flowlet-token",
        PRIMARY_MODEL,
        FAST_MODEL,
    )
    .unwrap();
    assert!(path.is_file());

    let restored = restore_claude_code(&path, "http://127.0.0.1:18640/anthropic").unwrap();
    assert_eq!(restored.state, AgentGlobalConfigState::NotConfigured);
    assert!(!path.exists());

    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn claude_code_restore_removes_new_managed_fields_missing_from_legacy_backup() {
    let path = test_settings_path();
    let directory = path.parent().unwrap().to_path_buf();

    apply_claude_code(
        &path,
        "http://127.0.0.1:18640/anthropic",
        "flowlet-token",
        PRIMARY_MODEL,
        FAST_MODEL,
    )
    .unwrap();
    let backup = backup_path(&path);
    let mut backup_value = read_settings(&backup).unwrap();
    backup_value["fields"]
        .as_object_mut()
        .unwrap()
        .remove("CLAUDE_CODE_SUBAGENT_MODEL");
    write_json_file(&backup, &backup_value).unwrap();

    restore_claude_code(&path, "http://127.0.0.1:18640/anthropic").unwrap();
    assert!(!path.exists());

    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn claude_code_reports_invalid_json_without_overwriting_it() {
    let path = test_settings_path();
    std::fs::write(&path, "{invalid").unwrap();

    let report = inspect_claude_code(&path, "http://127.0.0.1:18640/anthropic").unwrap();
    assert_eq!(report.state, AgentGlobalConfigState::Invalid);
    assert!(report.error.is_some());
    assert!(apply_claude_code(
        &path,
        "http://127.0.0.1:18640/anthropic",
        "token",
        PRIMARY_MODEL,
        FAST_MODEL,
    )
    .is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{invalid");

    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

// ─── OpenCode ─────────────────────────────────────────────────────────

#[test]
fn opencode_applies_selected_models_without_modalities_and_restores() {
    let (settings_path, auth_path) = test_opencode_paths();
    let permission_plugin_path = settings_path.parent().unwrap().join("plugins/flowlet.ts");
    std::fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
    std::fs::create_dir_all(auth_path.parent().unwrap()).unwrap();
    std::fs::write(
        &settings_path,
        r#"{
  // keep this user setting
  "theme": "system",
  "server": { "port": 1234, "mdns": true },
  "disabled_providers": ["flowlet", "legacy"],
  "enabled_providers": ["other"],
  "provider": {
    "other": { "models": {} },
    "flowlet": {
      "name": "Old Flowlet",
      "options": { "baseURL": "https://old.example/v1" }
    }
  }
}
"#,
    )
    .unwrap();
    std::fs::write(
        &auth_path,
        r#"{"other":{"type":"api","key":"keep"},"flowlet":{"type":"api","key":"old"}}"#,
    )
    .unwrap();

    let applied = apply_opencode(
        &settings_path,
        &auth_path,
        &permission_plugin_path,
        "http://127.0.0.1:18640/v1",
        "flowlet-token",
        PRIMARY_MODEL,
        FAST_MODEL,
    )
    .unwrap();
    assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
    assert!(applied.backup_available);
    assert_eq!(applied.primary_model.as_deref(), Some("flowlet/kimi-k3"));
    assert_eq!(applied.fast_model.as_deref(), Some("flowlet/glm-5.3"));
    let settings = read_jsonc_settings(&settings_path).unwrap();
    assert_eq!(settings["model"], "flowlet/kimi-k3");
    assert_eq!(settings["small_model"], "flowlet/glm-5.3");
    assert_eq!(
        settings["provider"]["flowlet"]["options"]["baseURL"],
        "http://127.0.0.1:18640/v1"
    );
    // provider models 条目保留（客户端需要），但不再声明 modalities。
    let models = settings["provider"]["flowlet"]["models"]
        .as_object()
        .unwrap();
    assert!(models.contains_key(PRIMARY_MODEL), "{models:?}");
    assert!(models.contains_key(FAST_MODEL), "{models:?}");
    for (id, entry) in models {
        assert!(
            entry.get("modalities").is_none(),
            "{id} 不应声明 modalities"
        );
    }
    let written = std::fs::read_to_string(&settings_path).unwrap();
    assert_no_aggregate_model(&written);
    assert!(!written.contains("modalities"));
    // 用户的其它设置与 JS 注释保留。
    assert_eq!(settings["server"]["port"], 1234);
    assert_eq!(
        settings["enabled_providers"],
        serde_json::json!(["other", "flowlet"])
    );
    assert!(written.contains("// keep this user setting"));
    let plugin_source = std::fs::read_to_string(&permission_plugin_path).unwrap();
    assert!(plugin_source.contains("permission.asked"));

    // reapply 幂等。
    let reapplied = apply_opencode(
        &settings_path,
        &auth_path,
        &permission_plugin_path,
        "http://127.0.0.1:18640/v1",
        "flowlet-token",
        PRIMARY_MODEL,
        FAST_MODEL,
    )
    .unwrap();
    assert_eq!(reapplied.state, AgentGlobalConfigState::Flowlet);

    let restored = restore_opencode(
        &settings_path,
        &auth_path,
        &permission_plugin_path,
        "http://127.0.0.1:18640/v1",
    )
    .unwrap();
    assert_eq!(restored.state, AgentGlobalConfigState::OtherGateway);
    let restored_settings = read_jsonc_settings(&settings_path).unwrap();
    assert_eq!(restored_settings["theme"], "system");
    assert!(restored_settings.get("model").is_none());
    assert_eq!(restored_settings["server"]["port"], 1234);
    assert_eq!(
        restored_settings["provider"]["flowlet"]["options"]["baseURL"],
        "https://old.example/v1"
    );
    assert_eq!(read_settings(&auth_path).unwrap()["flowlet"]["key"], "old");
    assert!(!permission_plugin_path.exists());

    let _ = std::fs::remove_dir_all(settings_path.parent().unwrap().parent().unwrap());
}

#[test]
fn upstream_opencode_fixture_passes_apply_reapply_restore_contract() {
    let (settings_path, auth_path) = test_opencode_paths();
    let permission_plugin_path = settings_path.parent().unwrap().join("plugins/flowlet.ts");
    std::fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
    std::fs::create_dir_all(auth_path.parent().unwrap()).unwrap();
    let original_settings = include_str!("../../../tests/fixtures/opencode/opencode.jsonc");
    let original_auth = include_str!("../../../tests/fixtures/opencode/auth.json");
    std::fs::write(&settings_path, original_settings).unwrap();
    std::fs::write(&auth_path, original_auth).unwrap();
    let initial = read_jsonc_settings(&settings_path).unwrap();
    let initial_auth = read_settings(&auth_path).unwrap();
    assert_eq!(
        inspect_opencode(
            &settings_path,
            &auth_path,
            &permission_plugin_path,
            "http://127.0.0.1:18640/v1",
        )
        .unwrap()
        .state,
        AgentGlobalConfigState::NotConfigured
    );

    let applied = apply_opencode(
        &settings_path,
        &auth_path,
        &permission_plugin_path,
        "http://127.0.0.1:18640/v1",
        "flowlet-token",
        "LongCat-2.5",
        "LongCat-2.0",
    )
    .unwrap();
    assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
    let applied_json = read_jsonc_settings(&settings_path).unwrap();
    assert_eq!(applied_json["model"], "flowlet/LongCat-2.5");
    assert_eq!(applied_json["small_model"], "flowlet/LongCat-2.0");

    apply_opencode(
        &settings_path,
        &auth_path,
        &permission_plugin_path,
        "http://127.0.0.1:18640/v1",
        "flowlet-token",
        "LongCat-2.5",
        "LongCat-2.0",
    )
    .unwrap();

    restore_opencode(
        &settings_path,
        &auth_path,
        &permission_plugin_path,
        "http://127.0.0.1:18640/v1",
    )
    .unwrap();
    assert_eq!(read_jsonc_settings(&settings_path).unwrap(), initial);
    assert_eq!(read_settings(&auth_path).unwrap(), initial_auth);
    assert!(std::fs::read_to_string(&settings_path)
        .unwrap()
        .contains("Representative upstream user setting"));

    let _ = std::fs::remove_dir_all(settings_path.parent().unwrap().parent().unwrap());
}

#[test]
fn upgrades_legacy_opencode_backup_without_overwriting_the_original_server() {
    let directory = std::env::temp_dir().join(format!(
        "flowlet-opencode-backup-upgrade-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&directory).unwrap();
    let backup_path = directory.join("backup.json");
    write_json_file(&backup_path, &serde_json::json!({ "version": 1 })).unwrap();

    let original = serde_json::json!({ "hostname": "localhost", "port": 8123 });
    upgrade_opencode_backup_with_server(&backup_path, Some(&original)).unwrap();
    let first = read_settings(&backup_path).unwrap();
    assert_eq!(first["server"]["present"], true);
    assert_eq!(first["server"]["value"], original);

    let later = serde_json::json!({ "port": 4096 });
    upgrade_opencode_backup_with_server(&backup_path, Some(&later)).unwrap();
    let second = read_settings(&backup_path).unwrap();
    assert_eq!(second["server"]["value"]["port"], 8123);

    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn removes_opencode_files_created_only_for_flowlet() {
    let (settings_path, auth_path) = test_opencode_paths();
    let directory = settings_path
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();

    apply_opencode(
        &settings_path,
        &auth_path,
        &settings_path.parent().unwrap().join("plugins/flowlet.ts"),
        "http://127.0.0.1:18640/v1",
        "flowlet-token",
        PRIMARY_MODEL,
        FAST_MODEL,
    )
    .unwrap();
    restore_opencode(
        &settings_path,
        &auth_path,
        &settings_path.parent().unwrap().join("plugins/flowlet.ts"),
        "http://127.0.0.1:18640/v1",
    )
    .unwrap();
    assert!(!settings_path.exists());
    assert!(!auth_path.exists());

    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn rolls_back_opencode_config_when_credentials_write_fails() {
    let (settings_path, auth_path) = test_opencode_paths();
    let directory = settings_path
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    std::fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
    std::fs::create_dir_all(&auth_path).unwrap();
    let original = b"{\n  // unchanged\n  \"theme\": \"system\"\n}\n";
    std::fs::write(&settings_path, original).unwrap();

    let error = apply_opencode(
        &settings_path,
        &auth_path,
        &settings_path.parent().unwrap().join("plugins/flowlet.ts"),
        "http://127.0.0.1:18640/v1",
        "flowlet-token",
        PRIMARY_MODEL,
        FAST_MODEL,
    )
    .unwrap_err();

    assert!(error.contains("已回滚 OpenCode 配置与凭据文件"));
    assert_eq!(std::fs::read(&settings_path).unwrap(), original);
    assert!(auth_path.is_dir());
    assert!(!opencode_backup_path(&settings_path).exists());

    let _ = std::fs::remove_dir_all(directory);
}

// ─── Pi ───────────────────────────────────────────────────────────────

#[test]
fn pi_applies_selected_models_without_input_declarations_and_restores() {
    let (settings_path, models_path, auth_path, extension_path) = test_pi_paths();
    std::fs::write(
        &settings_path,
        r#"{"theme":"dark","defaultProvider":"anthropic","defaultModel":"claude-sonnet-4-5"}"#,
    )
    .unwrap();
    std::fs::write(
        &models_path,
        r#"{"providers":{"other":{"baseUrl":"https://other.example","api":"openai-completions","models":[{"id":"m1"}]},"flowlet":{"baseUrl":"https://old.example/v1","api":"openai-completions","models":[{"id":"old-model"}]}}}"#,
    )
    .unwrap();
    std::fs::write(
        &auth_path,
        r#"{"other":{"type":"api_key","key":"keep"},"flowlet":{"type":"api_key","key":"old"}}"#,
    )
    .unwrap();

    let applied = apply_pi(
        &settings_path,
        &models_path,
        &auth_path,
        &extension_path,
        "http://127.0.0.1:18640/v1",
        "flowlet-token",
        true,
        PRIMARY_MODEL,
        FAST_MODEL,
    )
    .unwrap();
    assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
    assert!(applied.backup_available);
    assert!(applied.session_extension);
    assert!(extension_path.is_file());
    assert_eq!(applied.primary_model.as_deref(), Some(PRIMARY_MODEL));

    let models = read_settings(&models_path).unwrap();
    assert_eq!(
        models["providers"]["flowlet"]["headers"]["x-flowlet-client"],
        "pi"
    );
    let model_entries = models["providers"]["flowlet"]["models"].as_array().unwrap();
    let ids = model_entries
        .iter()
        .map(|entry| entry["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(ids, vec![PRIMARY_MODEL, FAST_MODEL]);
    for entry in model_entries {
        assert!(entry.get("input").is_none(), "不写模型 input：{entry}");
    }
    let written = std::fs::read_to_string(&models_path).unwrap();
    assert_no_aggregate_model(&written);
    let settings = read_settings(&settings_path).unwrap();
    assert_eq!(settings["defaultProvider"], PI_PROVIDER_ID);
    assert_eq!(settings["defaultModel"], PRIMARY_MODEL);
    assert_eq!(settings["theme"], "dark");

    let restored = restore_pi(
        &settings_path,
        &models_path,
        &auth_path,
        &extension_path,
        "http://127.0.0.1:18640/v1",
    )
    .unwrap();
    assert_eq!(restored.state, AgentGlobalConfigState::OtherGateway);
    assert!(!restored.session_extension);
    assert!(!extension_path.exists());
    let models = read_settings(&models_path).unwrap();
    assert_eq!(
        models["providers"]["flowlet"]["models"][0]["id"],
        "old-model"
    );
    let settings = read_settings(&settings_path).unwrap();
    assert_eq!(settings["defaultProvider"], "anthropic");
    assert_eq!(settings["defaultModel"], "claude-sonnet-4-5");

    let _ = std::fs::remove_dir_all(settings_path.parent().unwrap());
}

#[test]
fn upstream_pi_fixture_passes_apply_reapply_restore_contract() {
    let (settings_path, models_path, auth_path, extension_path) = test_pi_paths();
    let original_settings = include_str!("../../../tests/fixtures/pi/settings.json");
    let original_models = include_str!("../../../tests/fixtures/pi/models.json");
    let original_auth = include_str!("../../../tests/fixtures/pi/auth.json");
    std::fs::write(&settings_path, original_settings).unwrap();
    std::fs::write(&models_path, original_models).unwrap();
    std::fs::write(&auth_path, original_auth).unwrap();
    let initial_settings = read_settings(&settings_path).unwrap();
    let initial_models = read_settings(&models_path).unwrap();
    let initial_auth = read_settings(&auth_path).unwrap();
    assert_eq!(
        inspect_pi(
            &settings_path,
            &models_path,
            &auth_path,
            &extension_path,
            "http://127.0.0.1:18640/v1",
        )
        .unwrap()
        .state,
        AgentGlobalConfigState::NotConfigured
    );

    let applied = apply_pi(
        &settings_path,
        &models_path,
        &auth_path,
        &extension_path,
        "http://127.0.0.1:18640/v1",
        "flowlet-token",
        false,
        "LongCat-2.5",
        "LongCat-2.0",
    )
    .unwrap();
    assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
    assert_eq!(applied.primary_model.as_deref(), Some("LongCat-2.5"));

    apply_pi(
        &settings_path,
        &models_path,
        &auth_path,
        &extension_path,
        "http://127.0.0.1:18640/v1",
        "flowlet-token",
        false,
        "LongCat-2.5",
        "LongCat-2.0",
    )
    .unwrap();

    restore_pi(
        &settings_path,
        &models_path,
        &auth_path,
        &extension_path,
        "http://127.0.0.1:18640/v1",
    )
    .unwrap();
    assert_eq!(read_settings(&settings_path).unwrap(), initial_settings);
    assert_eq!(read_settings(&models_path).unwrap(), initial_models);
    assert_eq!(read_settings(&auth_path).unwrap(), initial_auth);

    let _ = std::fs::remove_dir_all(settings_path.parent().unwrap());
}

#[test]
fn pi_backs_up_and_restores_pre_existing_session_extension() {
    let (settings_path, models_path, auth_path, extension_path) = test_pi_paths();
    std::fs::write(&extension_path, "// user-owned extension\n").unwrap();

    let applied = apply_pi(
        &settings_path,
        &models_path,
        &auth_path,
        &extension_path,
        "http://127.0.0.1:18640/v1",
        "flowlet-token",
        true,
        PRIMARY_MODEL,
        FAST_MODEL,
    )
    .unwrap();
    assert!(applied.session_extension);
    assert_eq!(
        std::fs::read_to_string(&extension_path).unwrap(),
        PI_SESSION_EXTENSION_SOURCE
    );

    let restored = restore_pi(
        &settings_path,
        &models_path,
        &auth_path,
        &extension_path,
        "http://127.0.0.1:18640/v1",
    )
    .unwrap();
    assert!(restored.session_extension);
    assert_eq!(
        std::fs::read_to_string(&extension_path).unwrap(),
        "// user-owned extension\n"
    );

    let _ = std::fs::remove_dir_all(settings_path.parent().unwrap());
}

#[test]
fn pi_removes_extension_when_opted_out_and_restores_it() {
    let (settings_path, models_path, auth_path, extension_path) = test_pi_paths();
    std::fs::write(&extension_path, "// pre-existing extension\n").unwrap();

    let applied = apply_pi(
        &settings_path,
        &models_path,
        &auth_path,
        &extension_path,
        "http://127.0.0.1:18640/v1",
        "flowlet-token",
        false,
        PRIMARY_MODEL,
        FAST_MODEL,
    )
    .unwrap();
    assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
    assert!(!applied.session_extension);
    assert!(!extension_path.exists());

    let restored = restore_pi(
        &settings_path,
        &models_path,
        &auth_path,
        &extension_path,
        "http://127.0.0.1:18640/v1",
    )
    .unwrap();
    assert!(restored.session_extension);
    assert_eq!(
        std::fs::read_to_string(&extension_path).unwrap(),
        "// pre-existing extension\n"
    );

    let _ = std::fs::remove_dir_all(settings_path.parent().unwrap());
}

#[test]
fn pi_reports_partial_without_default_provider() {
    let (settings_path, models_path, auth_path, extension_path) = test_pi_paths();
    std::fs::write(
        &models_path,
        format!(
            r#"{{"providers":{{"flowlet":{{"baseUrl":"http://127.0.0.1:18640/v1","api":"openai-completions","models":[{{"id":"{PRIMARY_MODEL}"}},{{"id":"{FAST_MODEL}"}}]}}}}}}"#
        ),
    )
    .unwrap();
    std::fs::write(
        &auth_path,
        r#"{"flowlet":{"type":"api_key","key":"flowlet-token"}}"#,
    )
    .unwrap();
    // settings.json 缺失 defaultProvider / defaultModel，配置不完整。

    let inspected = inspect_pi(
        &settings_path,
        &models_path,
        &auth_path,
        &extension_path,
        "http://127.0.0.1:18640/v1",
    )
    .unwrap();
    assert_eq!(inspected.state, AgentGlobalConfigState::Partial);
    assert!(inspected.api_key_configured);
    assert!(!inspected.session_extension);

    let _ = std::fs::remove_dir_all(settings_path.parent().unwrap());
}

// ─── Codex ────────────────────────────────────────────────────────────

const CODEX_EXPECTED_BASE_URL: &str = "http://127.0.0.1:18640/v1";

#[test]
fn codex_applies_selected_model_and_generates_dynamic_catalog() {
    let (config_path, auth_path, models_path) = test_codex_paths();
    std::fs::write(
        &config_path,
        r##"# user comment
model = "gpt-5"
model_provider = "other"

[model_providers.other]
name = "other"
base_url = "https://gateway.example/v1"
wire_api = "responses"

[model_providers.flowlet]
name = "flowlet"
base_url = "http://127.0.0.1:9999/v1"
wire_api = "responses"
extra = "stale"
"##,
    )
    .unwrap();
    std::fs::write(
        &auth_path,
        r#"{"tokens":{"access_token":"chatgpt-token"},"OPENAI_API_KEY":"old-key"}"#,
    )
    .unwrap();

    let report = apply_codex(
        &config_path,
        &auth_path,
        &models_path,
        CODEX_EXPECTED_BASE_URL,
        "flowlet-token",
        "glm-5.3",
    )
    .unwrap();
    assert_eq!(report.state, AgentGlobalConfigState::Flowlet);
    assert!(report.backup_available);
    assert_eq!(report.primary_model.as_deref(), Some("glm-5.3"));
    assert_eq!(report.base_url.as_deref(), Some(CODEX_EXPECTED_BASE_URL));
    assert!(report.auth_token_configured);
    assert!(report.model_catalog_configured);
    assert_eq!(
        report.model_catalog_path.as_deref(),
        Some(CODEX_MODEL_CATALOG_REF)
    );

    let config_text = std::fs::read_to_string(&config_path).unwrap();
    assert!(config_text.contains("# user comment"));
    assert!(config_text.contains("[model_providers.other]"));
    assert!(!config_text.contains("stale"));
    assert_no_aggregate_model(&config_text);
    let doc = parse_toml(&config_path);
    assert_eq!(toml_str(&doc, "model"), Some("glm-5.3"));
    assert_eq!(toml_str(&doc, "model_provider"), Some("flowlet"));
    assert_eq!(toml_bool(&doc, "disable_response_storage"), Some(true));
    assert_eq!(toml_str(&doc, "preferred_auth_method"), Some("apikey"));
    assert_eq!(
        toml_str(&doc, "model_catalog_json"),
        Some(CODEX_MODEL_CATALOG_REF)
    );

    // 模型目录按所选模型动态生成，只有一条 slug=glm-5.3 的条目，且 Codex 必需字段齐全。
    let catalog: Value =
        serde_json::from_str(&std::fs::read_to_string(&models_path).unwrap()).unwrap();
    let models = catalog["models"].as_array().unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(models[0]["slug"], "glm-5.3");
    assert!(
        models[0]["context_window"].as_i64().unwrap_or(0) > 0,
        "models-cn.json 中 glm-5.3 应有上下文窗口：{}",
        models[0]
    );
    assert_eq!(models[0]["input_modalities"], serde_json::json!(["text"]));
    for field in codex_model_catalog::CODEX_MODEL_REQUIRED_FIELDS {
        assert!(
            models[0].get(field).is_some(),
            "Codex 模型条目缺少必填字段 {field}: {}",
            models[0]
        );
    }
    let effort_names = models[0]["supported_reasoning_levels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|preset| preset["effort"].as_str().unwrap())
        .collect::<Vec<_>>();
    for effort in &effort_names {
        assert!(
            codex_model_catalog::CODEX_MODEL_VALID_EFFORTS.contains(effort),
            "Codex 不支持的 effort：{effort}"
        );
    }

    // 切换到不在 models-cn.json 中的模型：保守条目 + 目录同步替换。
    let switched = apply_codex(
        &config_path,
        &auth_path,
        &models_path,
        CODEX_EXPECTED_BASE_URL,
        "flowlet-token",
        "gpt-6.1-sol",
    )
    .unwrap();
    assert_eq!(switched.state, AgentGlobalConfigState::Flowlet);
    assert_eq!(switched.primary_model.as_deref(), Some("gpt-6.1-sol"));
    let switched_catalog: Value =
        serde_json::from_str(&std::fs::read_to_string(&models_path).unwrap()).unwrap();
    assert_eq!(switched_catalog["models"][0]["slug"], "gpt-6.1-sol");
    assert_eq!(switched_catalog["models"][0]["context_window"], 128_000);
    assert_eq!(
        switched_catalog["models"][0]["input_modalities"],
        serde_json::json!(["text"])
    );
    assert!(report.model_catalog_configured);
    // models-cn.json 缺失该模型时只有一条保守条目，且仍有全部必填字段。
    for field in codex_model_catalog::CODEX_MODEL_REQUIRED_FIELDS {
        assert!(
            switched_catalog["models"][0].get(field).is_some(),
            "{field}"
        );
    }

    // auth.json：仅替换 OPENAI_API_KEY，ChatGPT 登录凭据保留。
    let auth: Value = serde_json::from_str(&std::fs::read_to_string(&auth_path).unwrap()).unwrap();
    assert_eq!(
        auth.get("OPENAI_API_KEY").and_then(Value::as_str),
        Some("flowlet-token")
    );
    assert_eq!(
        auth.pointer("/tokens/access_token").and_then(Value::as_str),
        Some("chatgpt-token")
    );

    // 恢复：旧 model/provider/auth 值全部回位，模型目录文件删除。
    let restored = restore_codex(
        &config_path,
        &auth_path,
        &models_path,
        CODEX_EXPECTED_BASE_URL,
    )
    .unwrap();
    assert_eq!(restored.state, AgentGlobalConfigState::OtherGateway);
    assert!(!restored.backup_available);
    let doc = parse_toml(&config_path);
    assert_eq!(toml_str(&doc, "model"), Some("gpt-5"));
    assert_eq!(toml_str(&doc, "model_provider"), Some("other"));
    assert_eq!(toml_bool(&doc, "disable_response_storage"), None);
    assert_eq!(toml_str(&doc, "model_catalog_json"), None);
    assert!(!models_path.exists());
    let config_text = std::fs::read_to_string(&config_path).unwrap();
    assert!(config_text.contains("http://127.0.0.1:9999/v1"));
    assert!(config_text.contains("stale"));
    let auth: Value = serde_json::from_str(&std::fs::read_to_string(&auth_path).unwrap()).unwrap();
    assert_eq!(
        auth.get("OPENAI_API_KEY").and_then(Value::as_str),
        Some("old-key")
    );
}

#[test]
fn removes_codex_files_created_only_for_flowlet() {
    let (config_path, auth_path, models_path) = test_codex_paths();
    assert!(!config_path.exists());
    assert!(!auth_path.exists());

    let report = apply_codex(
        &config_path,
        &auth_path,
        &models_path,
        CODEX_EXPECTED_BASE_URL,
        "flowlet-token",
        PRIMARY_MODEL,
    )
    .unwrap();
    assert_eq!(report.state, AgentGlobalConfigState::Flowlet);
    assert!(config_path.is_file());
    assert!(auth_path.is_file());
    assert!(models_path.is_file());

    let restored = restore_codex(
        &config_path,
        &auth_path,
        &models_path,
        CODEX_EXPECTED_BASE_URL,
    )
    .unwrap();
    assert_eq!(restored.state, AgentGlobalConfigState::NotConfigured);
    assert!(!config_path.exists());
    assert!(!auth_path.exists());
    assert!(!models_path.exists());
    assert!(!codex_backup_path(&config_path).exists());
}

#[test]
fn reports_not_configured_other_gateway_and_partial_for_codex() {
    let (config_path, auth_path, models_path) = test_codex_paths();

    // 与 Flowlet 无关的配置 → NotConfigured
    std::fs::write(
        &config_path,
        "model = \"gpt-5\"\nmodel_provider = \"openai\"\n",
    )
    .unwrap();
    let report = inspect_codex(
        &config_path,
        &auth_path,
        &models_path,
        CODEX_EXPECTED_BASE_URL,
    )
    .unwrap();
    assert_eq!(report.state, AgentGlobalConfigState::NotConfigured);

    // 指向别的网关 → OtherGateway
    std::fs::write(
        &config_path,
        r#"model_provider = "other"

[model_providers.other]
base_url = "https://gateway.example/v1"
"#,
    )
    .unwrap();
    let report = inspect_codex(
        &config_path,
        &auth_path,
        &models_path,
        CODEX_EXPECTED_BASE_URL,
    )
    .unwrap();
    assert_eq!(report.state, AgentGlobalConfigState::OtherGateway);

    // Flowlet 标记齐全但缺少模型目录 → Partial（提示重新写入以补齐目录）。
    std::fs::write(
        &config_path,
        r##"model = "glm-5.3"
model_provider = "flowlet"
disable_response_storage = true
preferred_auth_method = "apikey"

[model_providers.flowlet]
name = "flowlet"
base_url = "http://127.0.0.1:18640/v1"
wire_api = "responses"
requires_openai_auth = true
"##,
    )
    .unwrap();
    std::fs::write(&auth_path, r#"{"OPENAI_API_KEY":"flowlet-token"}"#).unwrap();
    let report = inspect_codex(
        &config_path,
        &auth_path,
        &models_path,
        CODEX_EXPECTED_BASE_URL,
    )
    .unwrap();
    assert_eq!(report.state, AgentGlobalConfigState::Partial);
    assert!(!report.model_catalog_configured);

    // 模型目录存在但声明的不是当前 model → Partial（需要重新一键写入）。
    std::fs::write(
        &config_path,
        format!(
            r##"model = "glm-5.3"
model_provider = "flowlet"
disable_response_storage = true
preferred_auth_method = "apikey"
model_catalog_json = "{CODEX_MODEL_CATALOG_REF}"

[model_providers.flowlet]
name = "flowlet"
base_url = "http://127.0.0.1:18640/v1"
wire_api = "responses"
requires_openai_auth = true
"##
        ),
    )
    .unwrap();
    let stale_catalog = codex_model_catalog::catalog_content(None, "kimi-k3").unwrap();
    std::fs::write(&models_path, stale_catalog).unwrap();
    let report = inspect_codex(
        &config_path,
        &auth_path,
        &models_path,
        CODEX_EXPECTED_BASE_URL,
    )
    .unwrap();
    assert_eq!(report.state, AgentGlobalConfigState::Partial);
    assert!(report.model_catalog_configured);

    // 目录与 model 一致 → Flowlet。
    let matching_catalog = codex_model_catalog::catalog_content(None, "glm-5.3").unwrap();
    std::fs::write(&models_path, matching_catalog).unwrap();
    let report = inspect_codex(
        &config_path,
        &auth_path,
        &models_path,
        CODEX_EXPECTED_BASE_URL,
    )
    .unwrap();
    assert_eq!(report.state, AgentGlobalConfigState::Flowlet);
}

#[test]
fn reports_invalid_codex_toml_without_overwriting_it() {
    let (config_path, auth_path, models_path) = test_codex_paths();
    let broken = "model = [invalid";
    std::fs::write(&config_path, broken).unwrap();

    let report = inspect_codex(
        &config_path,
        &auth_path,
        &models_path,
        CODEX_EXPECTED_BASE_URL,
    )
    .unwrap();
    assert_eq!(report.state, AgentGlobalConfigState::Invalid);
    assert!(report.error.is_some());

    let error = apply_codex(
        &config_path,
        &auth_path,
        &models_path,
        CODEX_EXPECTED_BASE_URL,
        "flowlet-token",
        PRIMARY_MODEL,
    )
    .unwrap_err();
    assert!(error.contains("解析"));
    assert_eq!(std::fs::read_to_string(&config_path).unwrap(), broken);
    assert!(!codex_backup_path(&config_path).exists());
    assert!(!models_path.exists());
}

#[test]
fn apply_codex_requires_client_token() {
    let (config_path, auth_path, models_path) = test_codex_paths();
    let error = apply_codex(
        &config_path,
        &auth_path,
        &models_path,
        CODEX_EXPECTED_BASE_URL,
        "  ",
        PRIMARY_MODEL,
    )
    .unwrap_err();
    assert!(error.contains("Client Token"));
    assert!(!config_path.exists());
    assert!(!models_path.exists());
}

#[test]
fn preserves_existing_models_catalog_and_reference_on_restore() {
    let (config_path, auth_path, models_path) = test_codex_paths();
    let original_catalog = r#"{"models":[{"slug":"deepseek-v4-flash","context_window":1048576}]}"#;
    std::fs::write(&models_path, original_catalog).unwrap();
    std::fs::write(
        &config_path,
        r##"model = "gpt-5"
model_provider = "other"
model_catalog_json = "~/.codex/models.json"

[model_providers.other]
name = "other"
base_url = "https://gateway.example/v1"
wire_api = "responses"
"##,
    )
    .unwrap();

    let report = apply_codex(
        &config_path,
        &auth_path,
        &models_path,
        CODEX_EXPECTED_BASE_URL,
        "flowlet-token",
        "glm-5.3",
    )
    .unwrap();
    assert_eq!(report.state, AgentGlobalConfigState::Flowlet);
    // 目录被按所选模型动态生成的内容替换（不再是仓库静态快照）。
    let applied_catalog: Value =
        serde_json::from_str(&std::fs::read_to_string(&models_path).unwrap()).unwrap();
    assert_eq!(applied_catalog["models"][0]["slug"], "glm-5.3");

    let restored = restore_codex(
        &config_path,
        &auth_path,
        &models_path,
        CODEX_EXPECTED_BASE_URL,
    )
    .unwrap();
    assert_eq!(restored.state, AgentGlobalConfigState::OtherGateway);
    assert_eq!(
        std::fs::read_to_string(&models_path).unwrap(),
        original_catalog
    );
    let doc = parse_toml(&config_path);
    assert_eq!(
        toml_str(&doc, "model_catalog_json"),
        Some("~/.codex/models.json")
    );
}

#[test]
fn legacy_codex_backup_without_models_fields_is_upgraded_on_reapply() {
    let (config_path, auth_path, models_path) = test_codex_paths();
    // 模拟旧版本生成的备份：没有 models_path/models_content 字段。
    let backup_path = codex_backup_path(&config_path);
    std::fs::create_dir_all(backup_path.parent().unwrap()).unwrap();
    let legacy_backup = serde_json::json!({
        "version": 1,
        "agent_id": "codex",
        "created_at": "2026-01-01T00:00:00Z",
        "config_path": display_path(&config_path),
        "auth_path": display_path(&auth_path),
        "config_existed": false,
        "auth_existed": false,
        "provider_table_existed": false,
        "top_level": {},
        "flowlet_provider": {"present": false, "value": null},
        "auth_key": {"present": false, "value": null},
    });
    std::fs::write(&backup_path, serde_json::to_vec(&legacy_backup).unwrap()).unwrap();

    let report = apply_codex(
        &config_path,
        &auth_path,
        &models_path,
        CODEX_EXPECTED_BASE_URL,
        "flowlet-token",
        PRIMARY_MODEL,
    )
    .unwrap();
    assert_eq!(report.state, AgentGlobalConfigState::Flowlet);
    assert!(models_path.is_file());
    let restored = restore_codex(
        &config_path,
        &auth_path,
        &models_path,
        CODEX_EXPECTED_BASE_URL,
    )
    .unwrap();
    assert_eq!(restored.state, AgentGlobalConfigState::NotConfigured);
    assert!(!models_path.exists());
    assert!(!config_path.exists());
    assert!(!backup_path.exists());
}

// ─── Hermes ───────────────────────────────────────────────────────────

#[test]
fn hermes_config_lifecycle_uses_real_upstream_fixture() {
    // 真实 Hermes Agent 全新安装时的 config.yaml：`model` 是空串哨兵，另含用户自定义段；
    // `.env` 里有其它 Provider 密钥与注释，用于验证 apply/restore 只触碰受管变量。
    let directory = std::env::temp_dir().join(format!(
        "flowlet-hermes-global-config-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&directory).unwrap();
    let config_path = directory.join("config.yaml");
    let env_path = directory.join(".env");
    let expected_base_url = "http://127.0.0.1:18640/v1";
    std::fs::write(
        &config_path,
        concat!(
            "model: \"\"\n",
            "terminal:\n",
            "  backend: local\n",
            "  timeout: 180\n",
            "display:\n",
            "  theme: dark\n",
        ),
    )
    .unwrap();
    std::fs::write(
        &env_path,
        concat!(
            "# Hermes Agent Environment Configuration\n",
            "OPENROUTER_API_KEY=sk-or-keep\n",
            "NOVITA_API_KEY=sk-novita-keep\n",
        ),
    )
    .unwrap();

    let before = inspect_hermes(&config_path, &env_path, expected_base_url).unwrap();
    assert_eq!(before.state, AgentGlobalConfigState::NotConfigured);
    assert_eq!(before.primary_model, None);
    assert_eq!(
        before.credentials_path.as_deref(),
        Some(display_path(&env_path).as_str())
    );

    let applied = apply_hermes(
        &config_path,
        &env_path,
        expected_base_url,
        "flowlet-token",
        PRIMARY_MODEL,
        None,
    )
    .unwrap();
    assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
    assert_eq!(applied.primary_model.as_deref(), Some(PRIMARY_MODEL));
    assert_eq!(
        applied.base_url.as_deref(),
        Some("http://127.0.0.1:18640/v1")
    );
    assert!(applied.api_key_configured);
    let yaml: serde_yaml::Value =
        serde_yaml::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
    assert_eq!(yaml["model"]["provider"].as_str(), Some("custom"));
    assert_eq!(yaml["model"]["default"].as_str(), Some(PRIMARY_MODEL));
    assert_eq!(
        yaml["model"]["api_key"].as_str(),
        Some("${HERMES_CUSTOM_127_0_0_1_18640_API_KEY}")
    );
    assert_eq!(
        yaml["model"]["default_headers"]["x-flowlet-client"].as_str(),
        Some("hermes")
    );
    assert_eq!(yaml["terminal"]["backend"].as_str(), Some("local"));
    let env_text = std::fs::read_to_string(&env_path).unwrap();
    assert!(env_text.contains("HERMES_CUSTOM_127_0_0_1_18640_API_KEY=flowlet-token"));
    assert!(env_text.contains("OPENROUTER_API_KEY=sk-or-keep"));
    assert!(env_text.contains("NOVITA_API_KEY=sk-novita-keep"));

    // reapply 幂等，并支持切换到另一个规范模型（不再限制 pro/flash）。
    let reapplied = apply_hermes(
        &config_path,
        &env_path,
        expected_base_url,
        "flowlet-token",
        "LongCat-2.5",
        None,
    )
    .unwrap();
    assert_eq!(reapplied.state, AgentGlobalConfigState::Flowlet);
    assert_eq!(reapplied.primary_model.as_deref(), Some("LongCat-2.5"));
    let text = std::fs::read_to_string(&config_path).unwrap();
    assert_eq!(text.matches("provider:").count(), 1);
    assert_eq!(text.matches("default:").count(), 1);
    assert_no_aggregate_model(&text);

    let restored = restore_hermes(&config_path, &env_path, expected_base_url).unwrap();
    assert_eq!(restored.state, AgentGlobalConfigState::NotConfigured);
    let restored_text = std::fs::read_to_string(&config_path).unwrap();
    assert!(restored_text.contains("model: \"\"") || restored_text.contains("model: ''"));
    let reparse: serde_yaml::Value = serde_yaml::from_str(&restored_text).unwrap();
    assert_eq!(reparse["terminal"]["backend"].as_str(), Some("local"));
    assert!(reparse.get("model").is_none_or(|value| !value.is_mapping()));
    let env_text = std::fs::read_to_string(&env_path).unwrap();
    assert!(!env_text.contains("HERMES_CUSTOM_127_0_0_1_18640_API_KEY"));
    assert!(env_text.contains("OPENROUTER_API_KEY=sk-or-keep"));

    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn hermes_custom_key_env_derives_from_host_port() {
    assert_eq!(
        super::adapters::hermes::hermes_custom_key_env("127.0.0.1:18640"),
        "HERMES_CUSTOM_127_0_0_1_18640_API_KEY"
    );
    assert_eq!(
        super::adapters::hermes::hermes_custom_key_env("localhost:8080"),
        "HERMES_CUSTOM_LOCALHOST_8080_API_KEY"
    );
    assert_eq!(
        super::adapters::hermes::hermes_custom_key_env(""),
        "HERMES_CUSTOM_API_KEY"
    );
}

#[test]
fn hermes_apply_detects_flowlet_for_any_known_model() {
    let directory = std::env::temp_dir().join(format!(
        "flowlet-hermes-model-choice-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&directory).unwrap();
    let config_path = directory.join("config.yaml");
    let env_path = directory.join(".env");
    let expected_base_url = "http://127.0.0.1:18640/v1";
    std::fs::write(&config_path, "model: \"\"\n").unwrap();

    for model in ["glm-5.3", "kimi-k3", "LongCat-2.5"] {
        let applied = apply_hermes(
            &config_path,
            &env_path,
            expected_base_url,
            "flowlet-token",
            model,
            None,
        )
        .unwrap();
        assert_eq!(applied.state, AgentGlobalConfigState::Flowlet, "{model}");
        assert_eq!(applied.primary_model.as_deref(), Some(model));
        let yaml: serde_yaml::Value =
            serde_yaml::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert_eq!(yaml["model"]["default"].as_str(), Some(model));
    }

    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn hermes_session_bridge_lifecycle_installs_enables_disables_and_restores() {
    let directory = std::env::temp_dir().join(format!(
        "flowlet-hermes-session-bridge-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&directory).unwrap();
    let config_path = directory.join("config.yaml");
    let env_path = directory.join(".env");
    let expected_base_url = "http://127.0.0.1:18640/v1";
    let bridge_dir = directory.join("plugins").join("flowlet-session-bridge");
    std::fs::write(
        &config_path,
        concat!(
            "model: \"\"\n",
            "terminal:\n",
            "  backend: local\n",
            "display:\n",
            "  theme: dark\n",
        ),
    )
    .unwrap();
    std::fs::write(
        &env_path,
        "# Hermes Agent Environment Configuration\nOPENROUTER_API_KEY=sk-or-keep\n",
    )
    .unwrap();

    let before = inspect_hermes(&config_path, &env_path, expected_base_url).unwrap();
    assert_eq!(before.state, AgentGlobalConfigState::NotConfigured);
    assert!(!before.session_extension);
    assert!(!bridge_dir.is_dir());

    let applied = apply_hermes(
        &config_path,
        &env_path,
        expected_base_url,
        "flowlet-token",
        PRIMARY_MODEL,
        Some(true),
    )
    .unwrap();
    assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
    assert!(applied.session_extension);
    assert!(bridge_dir.join("plugin.yaml").is_file());
    assert!(bridge_dir.join("__init__.py").is_file());
    let yaml: serde_yaml::Value =
        serde_yaml::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
    assert_eq!(
        yaml["plugins"]["enabled"][0].as_str(),
        Some("flowlet-session-bridge")
    );

    let reapplied = apply_hermes(
        &config_path,
        &env_path,
        expected_base_url,
        "flowlet-token",
        PRIMARY_MODEL,
        Some(true),
    )
    .unwrap();
    assert!(reapplied.session_extension);
    let yaml: serde_yaml::Value =
        serde_yaml::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
    assert_eq!(
        yaml["plugins"]["enabled"].as_sequence().map(Vec::len),
        Some(1)
    );

    let disabled = apply_hermes(
        &config_path,
        &env_path,
        expected_base_url,
        "flowlet-token",
        PRIMARY_MODEL,
        Some(false),
    )
    .unwrap();
    assert_eq!(disabled.state, AgentGlobalConfigState::Flowlet);
    assert!(!disabled.session_extension);
    assert!(!bridge_dir.join("plugin.yaml").exists());

    let restored = restore_hermes(&config_path, &env_path, expected_base_url).unwrap();
    assert_eq!(restored.state, AgentGlobalConfigState::NotConfigured);
    assert!(!restored.session_extension);
    let restored_text = std::fs::read_to_string(&config_path).unwrap();
    assert!(restored_text.contains("model: \"\"") || restored_text.contains("model: ''"));
    let yaml: serde_yaml::Value = serde_yaml::from_str(&restored_text).unwrap();
    assert_eq!(yaml["terminal"]["backend"].as_str(), Some("local"));
    assert!(yaml.get("plugins").is_none());
    assert!(!bridge_dir.exists());

    std::fs::remove_dir_all(directory).unwrap();
}
