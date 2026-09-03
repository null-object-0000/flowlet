use super::adapters::claude_code::{
    apply_claude_code, backup_path, inspect_claude_code, restore_claude_code, FAST_MODEL,
    PRIMARY_MODEL,
};
use super::adapters::codex::{
    apply_codex, codex_backup_path, inspect_codex, restore_codex, CODEX_MODEL_CATALOG_FILE,
    CODEX_MODEL_CATALOG_REF,
};
use super::adapters::opencode::{
    apply_opencode, apply_opencode_with_model_specs, inspect_opencode, opencode_backup_path,
    read_jsonc_settings, restore_opencode, upgrade_opencode_backup_with_server,
    OPENCODE_FAST_MODEL, OPENCODE_PRIMARY_MODEL,
};
use super::adapters::pi::{
    apply_pi, apply_pi_with_model_specs, inspect_pi, restore_pi, PI_FAST_MODEL, PI_PRIMARY_MODEL,
    PI_PROVIDER_ID, PI_SESSION_EXTENSION_SOURCE,
};
use super::adapters::hermes::{apply_hermes, inspect_hermes, restore_hermes};
use super::*;

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

#[test]
fn legacy_long_context_option_enables_both_model_groups() {
    let legacy: AgentGlobalConfigOptions = serde_json::from_value(serde_json::json!({
        "longContext": true
    }))
    .unwrap();
    assert_eq!(legacy.claude_long_context(), (true, true));

    let split: AgentGlobalConfigOptions = serde_json::from_value(serde_json::json!({
        "longContext": true,
        "primaryLongContext": false,
        "fastLongContext": true
    }))
    .unwrap();
    assert_eq!(split.claude_long_context(), (false, true));
}

#[test]
fn omitted_session_extension_preserves_adapter_specific_defaults() {
    let options: AgentGlobalConfigOptions = serde_json::from_value(serde_json::json!({})).unwrap();
    assert_eq!(options.session_extension, None);
}

#[test]
fn applies_and_restores_only_managed_fields() {
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
        false,
        false,
    )
    .unwrap();
    assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
    assert!(applied.backup_available);
    let current = read_settings(&path).unwrap();
    assert_eq!(current["theme"], "dark");
    assert_eq!(current["env"]["CUSTOM"], "keep");
    assert!(current["env"].get("ANTHROPIC_API_KEY").is_none());
    assert_eq!(
        current["env"]["ANTHROPIC_DEFAULT_FABLE_MODEL"],
        PRIMARY_MODEL
    );
    assert_eq!(current["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"], FAST_MODEL);
    assert_eq!(current["env"]["ANTHROPIC_SMALL_FAST_MODEL"], FAST_MODEL);
    assert_eq!(current["env"]["CLAUDE_CODE_SUBAGENT_MODEL"], FAST_MODEL);

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
fn independent_long_context_options_write_and_remove_suffixes() {
    let path = test_settings_path();
    let applied = apply_claude_code(
        &path,
        "http://127.0.0.1:18640/anthropic",
        "flowlet-token",
        true,
        true,
    )
    .unwrap();
    assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
    assert!(applied.primary_long_context);
    assert!(applied.fast_long_context);
    assert!(applied.long_context);
    assert_eq!(applied.primary_model.as_deref(), Some("flowlet-pro[1m]"));
    let current = read_settings(&path).unwrap();
    for name in [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_FABLE_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
    ] {
        assert_eq!(current["env"][name], "flowlet-pro[1m]", "{name}");
    }
    for name in [
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
    ] {
        assert_eq!(current["env"][name], "flowlet-flash[1m]", "{name}");
    }

    // 关闭开关后重新写入应剥离后缀并收敛。
    let reapplied = apply_claude_code(
        &path,
        "http://127.0.0.1:18640/anthropic",
        "flowlet-token",
        false,
        true,
    )
    .unwrap();
    assert_eq!(reapplied.state, AgentGlobalConfigState::Flowlet);
    assert!(!reapplied.primary_long_context);
    assert!(reapplied.fast_long_context);
    assert!(!reapplied.long_context);
    let current = read_settings(&path).unwrap();
    assert_eq!(current["env"]["ANTHROPIC_MODEL"], PRIMARY_MODEL);
    assert_eq!(
        current["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"],
        PRIMARY_MODEL
    );
    assert_eq!(
        current["env"]["CLAUDE_CODE_SUBAGENT_MODEL"],
        "flowlet-flash[1m]"
    );

    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[test]
fn manually_suffixed_config_still_converges_to_flowlet() {
    // 用户手动添加 [1m]（或旧版本写入）时，inspect 应剥离后缀比较，
    // 状态仍为 Flowlet，并分别回报两个模型组的上下文设置。
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

    let inspected = inspect_claude_code(&path, "http://127.0.0.1:18640/anthropic").unwrap();
    assert_eq!(inspected.state, AgentGlobalConfigState::Flowlet);
    assert!(inspected.primary_long_context);
    assert!(!inspected.fast_long_context);
    assert!(!inspected.long_context);
    assert_eq!(inspected.primary_model.as_deref(), Some("flowlet-pro[1m]"));

    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[test]
fn legacy_small_fast_model_is_reported_partial_and_repaired_by_apply() {
    // 旧版 Flowlet 写入的完整配置 + 用户遗留的 ANTHROPIC_SMALL_FAST_MODEL：
    // 该遗留变量在会话标题生成等后台任务中优先于 ANTHROPIC_DEFAULT_HAIKU_MODEL，
    // 必须被视为未收敛（Partial），重新写入后收敛到 FAST_MODEL 且可恢复原值。
    let path = test_settings_path();
    std::fs::write(
        &path,
        r#"{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:18640/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "flowlet-token",
    "ANTHROPIC_MODEL": "flowlet-pro",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "flowlet-pro",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "flowlet-pro",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "flowlet-flash",
    "ANTHROPIC_SMALL_FAST_MODEL": "LongCat-2.0",
    "CLAUDE_CODE_SUBAGENT_MODEL": "flowlet-flash"
  }
}"#,
    )
    .unwrap();

    let inspected = inspect_claude_code(&path, "http://127.0.0.1:18640/anthropic").unwrap();
    assert_eq!(inspected.state, AgentGlobalConfigState::Partial);

    let applied = apply_claude_code(
        &path,
        "http://127.0.0.1:18640/anthropic",
        "flowlet-token",
        false,
        false,
    )
    .unwrap();
    assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
    let current = read_settings(&path).unwrap();
    assert_eq!(current["env"]["ANTHROPIC_SMALL_FAST_MODEL"], FAST_MODEL);
    assert_eq!(current["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"], FAST_MODEL);

    let restored = restore_claude_code(&path, "http://127.0.0.1:18640/anthropic").unwrap();
    assert_eq!(restored.state, AgentGlobalConfigState::Partial);
    let restored_settings = read_settings(&path).unwrap();
    assert_eq!(
        restored_settings["env"]["ANTHROPIC_SMALL_FAST_MODEL"],
        "LongCat-2.0"
    );

    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[test]
fn missing_fable_alias_is_reported_partial_and_repaired_by_apply() {
    // 早期 Flowlet 写入的配置缺少 ANTHROPIC_DEFAULT_FABLE_MODEL：此时 `/model fable`、
    // `best` 别名会解析到内置 Fable 5 模型 ID，而非 Flowlet 暴露的模型，必须视为
    // 未收敛（Partial），重新写入后补上该变量并收敛到 PRIMARY_MODEL。
    let path = test_settings_path();
    std::fs::write(
        &path,
        r#"{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:18640/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "flowlet-token",
    "ANTHROPIC_MODEL": "flowlet-pro",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "flowlet-pro",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "flowlet-pro",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "flowlet-flash",
    "ANTHROPIC_SMALL_FAST_MODEL": "flowlet-flash",
    "CLAUDE_CODE_SUBAGENT_MODEL": "flowlet-flash"
  }
}"#,
    )
    .unwrap();

    let inspected = inspect_claude_code(&path, "http://127.0.0.1:18640/anthropic").unwrap();
    assert_eq!(inspected.state, AgentGlobalConfigState::Partial);

    let applied = apply_claude_code(
        &path,
        "http://127.0.0.1:18640/anthropic",
        "flowlet-token",
        false,
        false,
    )
    .unwrap();
    assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
    let current = read_settings(&path).unwrap();
    assert_eq!(
        current["env"]["ANTHROPIC_DEFAULT_FABLE_MODEL"],
        PRIMARY_MODEL
    );

    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[test]
fn removes_settings_created_only_for_flowlet_on_restore() {
    let path = test_settings_path();
    let directory = path.parent().unwrap().to_path_buf();

    apply_claude_code(
        &path,
        "http://127.0.0.1:18640/anthropic",
        "flowlet-token",
        false,
        false,
    )
    .unwrap();
    assert!(path.is_file());

    let restored = restore_claude_code(&path, "http://127.0.0.1:18640/anthropic").unwrap();
    assert_eq!(restored.state, AgentGlobalConfigState::NotConfigured);
    assert!(!path.exists());

    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn legacy_backup_removes_new_managed_fields_on_restore() {
    let path = test_settings_path();
    let directory = path.parent().unwrap().to_path_buf();

    apply_claude_code(
        &path,
        "http://127.0.0.1:18640/anthropic",
        "flowlet-token",
        false,
        false,
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
fn reports_invalid_json_without_overwriting_it() {
    let path = test_settings_path();
    std::fs::write(&path, "{invalid").unwrap();

    let report = inspect_claude_code(&path, "http://127.0.0.1:18640/anthropic").unwrap();
    assert_eq!(report.state, AgentGlobalConfigState::Invalid);
    assert!(report.error.is_some());
    assert!(apply_claude_code(
        &path,
        "http://127.0.0.1:18640/anthropic",
        "token",
        false,
        false,
    )
    .is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{invalid");

    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[test]
fn applies_and_restores_opencode_config_and_credentials() {
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
    )
    .unwrap();
    assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
    assert!(applied.backup_available);
    let settings = read_jsonc_settings(&settings_path).unwrap();
    assert_eq!(settings["model"], OPENCODE_PRIMARY_MODEL);
    assert_eq!(settings["small_model"], OPENCODE_FAST_MODEL);
    assert_eq!(settings["server"]["port"], 1234);
    assert!(settings["server"].get("hostname").is_none());
    assert_eq!(settings["server"]["mdns"], true);
    assert_eq!(
        settings["provider"]["flowlet"]["options"]["baseURL"],
        "http://127.0.0.1:18640/v1"
    );
    assert!(settings["provider"]["flowlet"]["options"]
        .get("apiKey")
        .is_none());
    assert_eq!(
        settings["disabled_providers"],
        serde_json::json!(["legacy"])
    );
    assert_eq!(
        settings["enabled_providers"],
        serde_json::json!(["other", "flowlet"])
    );
    assert!(std::fs::read_to_string(&settings_path)
        .unwrap()
        .contains("// keep this user setting"));
    let auth = read_settings(&auth_path).unwrap();
    assert_eq!(auth["flowlet"]["type"], "api");
    assert_eq!(auth["flowlet"]["key"], "flowlet-token");
    assert_eq!(auth["other"]["key"], "keep");
    let plugin_source = std::fs::read_to_string(&permission_plugin_path).unwrap();
    assert!(plugin_source.contains("permission.asked"));
    assert!(plugin_source.contains("client.permission?.list?.()"));
    assert!(plugin_source.contains("writeFile(stateTempPath"));
    assert!(plugin_source.contains("rename(stateTempPath, statePath)"));
    assert!(plugin_source.contains("state-${process.pid}-${instanceKey}.json"));
    assert!(!plugin_source.contains("Bun.write"));

    std::fs::write(
        &permission_plugin_path,
        "// Flowlet 旧版权限插件\nconst persist = () => Bun.write('state.json', '{}')\n",
    )
    .unwrap();
    let stale_plugin = inspect_opencode(
        &settings_path,
        &auth_path,
        &permission_plugin_path,
        "http://127.0.0.1:18640/v1",
    )
    .unwrap();
    assert_eq!(stale_plugin.state, AgentGlobalConfigState::Partial);
    assert!(!stale_plugin.opencode_permission_bridge);
    apply_opencode(
        &settings_path,
        &auth_path,
        &permission_plugin_path,
        "http://127.0.0.1:18640/v1",
        "flowlet-token",
    )
    .unwrap();

    std::fs::remove_file(&permission_plugin_path).unwrap();
    let missing_plugin = inspect_opencode(
        &settings_path,
        &auth_path,
        &permission_plugin_path,
        "http://127.0.0.1:18640/v1",
    )
    .unwrap();
    assert_eq!(missing_plugin.state, AgentGlobalConfigState::Partial);
    assert!(!missing_plugin.opencode_permission_bridge);
    apply_opencode(
        &settings_path,
        &auth_path,
        &permission_plugin_path,
        "http://127.0.0.1:18640/v1",
        "flowlet-token",
    )
    .unwrap();

    // 兼容短暂发布过的固定控制端口版本：再次应用时恢复接入前的 hostname/port，
    // 同时保留用户原有的 mdns 等其他 server 字段。
    let mut managed_settings = read_jsonc_settings(&settings_path).unwrap();
    let managed_server = managed_settings
        .get_mut("server")
        .and_then(Value::as_object_mut)
        .unwrap();
    managed_server.insert("port".to_string(), serde_json::json!(4096));
    managed_server.insert(
        "hostname".to_string(),
        Value::String("127.0.0.1".to_string()),
    );
    write_json_file(&settings_path, &managed_settings).unwrap();
    apply_opencode(
        &settings_path,
        &auth_path,
        &permission_plugin_path,
        "http://127.0.0.1:18640/v1",
        "flowlet-token",
    )
    .unwrap();
    let migrated = read_jsonc_settings(&settings_path).unwrap();
    assert_eq!(migrated["server"]["port"], 1234);
    assert!(migrated["server"].get("hostname").is_none());
    assert_eq!(migrated["server"]["mdns"], true);

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
    assert_eq!(restored_settings["server"]["port"], 1234);
    assert_eq!(restored_settings["server"]["mdns"], true);
    assert!(restored_settings["server"].get("hostname").is_none());
    assert!(restored_settings.get("model").is_none());
    assert_eq!(
        restored_settings["disabled_providers"],
        serde_json::json!(["flowlet", "legacy"])
    );
    assert_eq!(
        restored_settings["enabled_providers"],
        serde_json::json!(["other"])
    );
    assert_eq!(
        restored_settings["provider"]["flowlet"]["options"]["baseURL"],
        "https://old.example/v1"
    );
    let restored_auth = read_settings(&auth_path).unwrap();
    assert_eq!(restored_auth["flowlet"]["key"], "old");
    assert_eq!(restored_auth["other"]["key"], "keep");
    assert!(!permission_plugin_path.exists());

    let _ = std::fs::remove_dir_all(settings_path.parent().unwrap().parent().unwrap());
}

#[test]
fn upstream_opencode_fixture_model_inputs_pass_apply_disable_restore_contract() {
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

    let inputs = BTreeMap::from([
        (
            "flowlet-pro".to_string(),
            vec!["text".to_string(), "image".to_string()],
        ),
        ("flowlet-flash".to_string(), vec!["text".to_string()]),
    ]);
    let applied = apply_opencode_with_model_specs(
        &settings_path,
        &auth_path,
        &permission_plugin_path,
        "http://127.0.0.1:18640/v1",
        "flowlet-token",
        true,
        Some(&inputs),
    )
    .unwrap();
    assert!(applied.model_specs);
    let applied_json = read_jsonc_settings(&settings_path).unwrap();
    assert_eq!(
        applied_json["provider"]["flowlet"]["models"]["flowlet-pro"]["modalities"]["input"],
        serde_json::json!(["text", "image"])
    );
    assert_eq!(
        applied_json["provider"]["flowlet"]["models"]["flowlet-flash"]["modalities"]["input"],
        serde_json::json!(["text"])
    );

    let reapplied = apply_opencode_with_model_specs(
        &settings_path,
        &auth_path,
        &permission_plugin_path,
        "http://127.0.0.1:18640/v1",
        "flowlet-token",
        true,
        Some(&inputs),
    )
    .unwrap();
    assert!(reapplied.model_specs);
    read_jsonc_settings(&settings_path).unwrap();

    let disabled = apply_opencode_with_model_specs(
        &settings_path,
        &auth_path,
        &permission_plugin_path,
        "http://127.0.0.1:18640/v1",
        "flowlet-token",
        false,
        None,
    )
    .unwrap();
    assert!(!disabled.model_specs);
    let disabled_json = read_jsonc_settings(&settings_path).unwrap();
    assert!(
        disabled_json["provider"]["flowlet"]["models"]["flowlet-pro"]
            .get("modalities")
            .is_none()
    );

    restore_opencode(
        &settings_path,
        &auth_path,
        &permission_plugin_path,
        "http://127.0.0.1:18640/v1",
    )
    .unwrap();
    let restored = read_jsonc_settings(&settings_path).unwrap();
    assert_eq!(restored, initial);
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

#[test]
fn applies_and_restores_pi_models_auth_and_settings() {
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
    )
    .unwrap();
    assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
    assert!(applied.backup_available);
    assert!(applied.session_extension);
    assert!(extension_path.is_file());
    let models = read_settings(&models_path).unwrap();
    assert_eq!(
        models["providers"]["flowlet"]["baseUrl"],
        "http://127.0.0.1:18640/v1"
    );
    assert_eq!(models["providers"]["flowlet"]["api"], "openai-completions");
    assert_eq!(
        models["providers"]["flowlet"]["headers"]["x-flowlet-client"],
        "pi"
    );
    let model_ids = models["providers"]["flowlet"]["models"]
        .as_array()
        .unwrap()
        .iter()
        .map(|model| model["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(model_ids, vec![PI_PRIMARY_MODEL, PI_FAST_MODEL]);
    assert_eq!(
        models["providers"]["other"]["baseUrl"],
        "https://other.example"
    );
    let auth = read_settings(&auth_path).unwrap();
    assert_eq!(auth["flowlet"]["type"], "api_key");
    assert_eq!(auth["flowlet"]["key"], "flowlet-token");
    assert_eq!(auth["other"]["key"], "keep");
    let settings = read_settings(&settings_path).unwrap();
    assert_eq!(settings["defaultProvider"], PI_PROVIDER_ID);
    assert_eq!(settings["defaultModel"], PI_PRIMARY_MODEL);
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
    assert!(!restored.backup_available);
    assert!(!restored.session_extension);
    assert!(!extension_path.exists());
    let models = read_settings(&models_path).unwrap();
    assert_eq!(
        models["providers"]["flowlet"]["baseUrl"],
        "https://old.example/v1"
    );
    assert_eq!(
        models["providers"]["flowlet"]["models"][0]["id"],
        "old-model"
    );
    let auth = read_settings(&auth_path).unwrap();
    assert_eq!(auth["flowlet"]["key"], "old");
    let settings = read_settings(&settings_path).unwrap();
    assert_eq!(settings["defaultProvider"], "anthropic");
    assert_eq!(settings["defaultModel"], "claude-sonnet-4-5");

    let _ = std::fs::remove_dir_all(settings_path.parent().unwrap());
}

#[test]
fn upstream_pi_fixture_model_inputs_pass_apply_disable_restore_contract() {
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

    let inputs = BTreeMap::from([
        (
            "flowlet-pro".to_string(),
            vec!["text".to_string(), "image".to_string()],
        ),
        ("flowlet-flash".to_string(), vec!["text".to_string()]),
    ]);
    let applied = apply_pi_with_model_specs(
        &settings_path,
        &models_path,
        &auth_path,
        &extension_path,
        "http://127.0.0.1:18640/v1",
        "flowlet-token",
        false,
        true,
        Some(&inputs),
    )
    .unwrap();
    assert!(applied.model_specs);
    let applied_models = read_settings(&models_path).unwrap();
    assert_eq!(
        applied_models["providers"]["flowlet"]["models"][0]["input"],
        serde_json::json!(["text", "image"])
    );
    assert_eq!(
        applied_models["providers"]["flowlet"]["models"][1]["input"],
        serde_json::json!(["text"])
    );
    read_settings(&settings_path).unwrap();
    read_settings(&auth_path).unwrap();

    let reapplied = apply_pi_with_model_specs(
        &settings_path,
        &models_path,
        &auth_path,
        &extension_path,
        "http://127.0.0.1:18640/v1",
        "flowlet-token",
        false,
        true,
        Some(&inputs),
    )
    .unwrap();
    assert!(reapplied.model_specs);
    read_settings(&models_path).unwrap();

    let disabled = apply_pi_with_model_specs(
        &settings_path,
        &models_path,
        &auth_path,
        &extension_path,
        "http://127.0.0.1:18640/v1",
        "flowlet-token",
        false,
        false,
        None,
    )
    .unwrap();
    assert!(!disabled.model_specs);
    let disabled_models = read_settings(&models_path).unwrap();
    assert!(disabled_models["providers"]["flowlet"]["models"][0]
        .get("input")
        .is_none());

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
fn removes_pi_files_created_only_for_flowlet() {
    let (settings_path, models_path, auth_path, extension_path) = test_pi_paths();
    let directory = settings_path.parent().unwrap().to_path_buf();

    apply_pi(
        &settings_path,
        &models_path,
        &auth_path,
        &extension_path,
        "http://127.0.0.1:18640/v1",
        "flowlet-token",
        true,
    )
    .unwrap();
    assert!(settings_path.is_file());
    assert!(models_path.is_file());
    assert!(auth_path.is_file());
    assert!(extension_path.is_file());

    let restored = restore_pi(
        &settings_path,
        &models_path,
        &auth_path,
        &extension_path,
        "http://127.0.0.1:18640/v1",
    )
    .unwrap();
    assert_eq!(restored.state, AgentGlobalConfigState::NotConfigured);
    assert!(!settings_path.exists());
    assert!(!models_path.exists());
    assert!(!auth_path.exists());
    assert!(!extension_path.exists());

    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn backs_up_and_restores_pre_existing_pi_session_extension() {
    let (settings_path, models_path, auth_path, extension_path) = test_pi_paths();
    // 用户事先已存在一个同名扩展文件（内容不应被覆盖丢失）。
    std::fs::write(&extension_path, "// user-owned extension\n").unwrap();

    let applied = apply_pi(
        &settings_path,
        &models_path,
        &auth_path,
        &extension_path,
        "http://127.0.0.1:18640/v1",
        "flowlet-token",
        true,
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
    // 用户事先已存在同名扩展，Flowlet 不应删除用户文件，恢复后应写回用户原始内容。
    assert!(restored.session_extension);
    assert_eq!(
        std::fs::read_to_string(&extension_path).unwrap(),
        "// user-owned extension\n"
    );

    let _ = std::fs::remove_dir_all(settings_path.parent().unwrap());
}

#[test]
fn skips_session_extension_when_opted_out() {
    let (settings_path, models_path, auth_path, extension_path) = test_pi_paths();
    // 用户事先存在一个扩展文件，但本次选择不安装会话扩展。
    std::fs::write(&extension_path, "// pre-existing extension\n").unwrap();

    let applied = apply_pi(
        &settings_path,
        &models_path,
        &auth_path,
        &extension_path,
        "http://127.0.0.1:18640/v1",
        "flowlet-token",
        false,
    )
    .unwrap();
    assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
    // 选择不安装时，扩展应被删除（删除前内容已由备份捕获）。
    assert!(!applied.session_extension);
    assert!(!extension_path.exists());

    // 恢复时应写回删除前的原始内容。
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
fn reports_pi_partial_state_without_default_provider() {
    let (settings_path, models_path, auth_path, extension_path) = test_pi_paths();
    std::fs::write(
            &models_path,
            r#"{"providers":{"flowlet":{"baseUrl":"http://127.0.0.1:18640/v1","api":"openai-completions","models":[{"id":"flowlet-pro"},{"id":"flowlet-flash"}]}}}"#,
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
    )
    .unwrap_err();

    assert!(error.contains("已回滚 OpenCode 配置与凭据文件"));
    assert_eq!(std::fs::read(&settings_path).unwrap(), original);
    assert!(auth_path.is_dir());
    assert!(!opencode_backup_path(&settings_path).exists());

    let _ = std::fs::remove_dir_all(directory);
}

// ─── Codex ─────────────────────────────────────────────────────────────

/// 测试用临时 Codex 配置路径。inspect/apply/restore 均以路径为参数，
/// 不需要改写进程级 CODEX_HOME 环境变量（避免并行测试互相干扰）。
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

const CODEX_EXPECTED_BASE_URL: &str = "http://127.0.0.1:18640/v1";

#[test]
fn applies_and_restores_codex_config_and_credentials() {
    let (config_path, auth_path, models_path) = test_codex_paths();
    // 用户既有配置：注释、其它 provider、以及一份指向旧端口的 flowlet provider
    //（含多余字段，写入时应被整体替换）。auth.json 保留 ChatGPT 登录凭据。
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
    )
    .unwrap();
    assert_eq!(report.state, AgentGlobalConfigState::Flowlet);
    assert!(report.backup_available);
    assert_eq!(report.primary_model.as_deref(), Some("flowlet-pro"));
    assert_eq!(report.base_url.as_deref(), Some(CODEX_EXPECTED_BASE_URL));
    assert!(report.auth_token_configured);

    let config_text = std::fs::read_to_string(&config_path).unwrap();
    // 用户注释与其它 provider 原样保留
    assert!(config_text.contains("# user comment"));
    assert!(config_text.contains("[model_providers.other]"));
    assert!(config_text.contains("https://gateway.example/v1"));
    // 旧版残留的多余字段被整体替换清理
    assert!(!config_text.contains("stale"));
    let doc = parse_toml(&config_path);
    assert_eq!(toml_str(&doc, "model"), Some("flowlet-pro"));
    assert_eq!(toml_str(&doc, "model_provider"), Some("flowlet"));
    assert_eq!(toml_bool(&doc, "disable_response_storage"), Some(true));
    assert_eq!(toml_str(&doc, "preferred_auth_method"), Some("apikey"));
    // 模型目录：config.toml 指向 Flowlet 目录引用，且 ~/.codex 下的目录文件已生成
    assert_eq!(
        toml_str(&doc, "model_catalog_json"),
        Some(CODEX_MODEL_CATALOG_REF)
    );
    assert!(models_path.is_file());
    let catalog: Value =
        serde_json::from_str(&std::fs::read_to_string(&models_path).unwrap()).unwrap();
    let catalog_slugs = catalog
        .get("models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| model.get("slug").and_then(Value::as_str))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    assert!(catalog_slugs.contains(&"flowlet-pro"), "{catalog_slugs:?}");
    assert!(report.model_catalog_configured);
    assert_eq!(
        report.model_catalog_path.as_deref(),
        Some(CODEX_MODEL_CATALOG_REF)
    );
    let flowlet_base = doc
        .get("model_providers")
        .and_then(|item| item.get("flowlet"))
        .and_then(|item| item.as_table_like())
        .and_then(|table| table.get("base_url"))
        .and_then(|item| item.as_value())
        .and_then(|value| value.as_str());
    assert_eq!(flowlet_base, Some(CODEX_EXPECTED_BASE_URL));
    let flowlet_requires_auth = doc
        .get("model_providers")
        .and_then(|item| item.get("flowlet"))
        .and_then(|item| item.as_table_like())
        .and_then(|table| table.get("requires_openai_auth"))
        .and_then(|item| item.as_value())
        .and_then(|value| value.as_bool());
    assert_eq!(flowlet_requires_auth, Some(true));

    // auth.json：仅替换 OPENAI_API_KEY，ChatGPT 登录凭据保留
    let auth: Value = serde_json::from_str(&std::fs::read_to_string(&auth_path).unwrap()).unwrap();
    assert_eq!(
        auth.get("OPENAI_API_KEY").and_then(Value::as_str),
        Some("flowlet-token")
    );
    assert_eq!(
        auth.pointer("/tokens/access_token").and_then(Value::as_str),
        Some("chatgpt-token")
    );

    // 恢复：旧 model/provider/auth 值全部回位
    let restored = restore_codex(
        &config_path,
        &auth_path,
        &models_path,
        CODEX_EXPECTED_BASE_URL,
    )
    .unwrap();
    // 恢复后 model_provider 指回 other（base_url 非 Flowlet）→ OtherGateway
    assert_eq!(restored.state, AgentGlobalConfigState::OtherGateway);
    assert!(!restored.backup_available);

    let config_text = std::fs::read_to_string(&config_path).unwrap();
    assert!(config_text.contains("# user comment"));
    let doc = parse_toml(&config_path);
    assert_eq!(toml_str(&doc, "model"), Some("gpt-5"));
    assert_eq!(toml_str(&doc, "model_provider"), Some("other"));
    assert_eq!(toml_bool(&doc, "disable_response_storage"), None);
    assert_eq!(toml_str(&doc, "preferred_auth_method"), None);
    assert_eq!(toml_str(&doc, "model_catalog_json"), None);
    // 模型目录文件由 Flowlet 创建且原本不存在，恢复后应被删除
    assert!(!models_path.exists());
    // 旧 flowlet provider 表（含多余字段）整体回位
    assert!(config_text.contains("http://127.0.0.1:9999/v1"));
    assert!(config_text.contains("stale"));

    let auth: Value = serde_json::from_str(&std::fs::read_to_string(&auth_path).unwrap()).unwrap();
    assert_eq!(
        auth.get("OPENAI_API_KEY").and_then(Value::as_str),
        Some("old-key")
    );
    assert_eq!(
        auth.pointer("/tokens/access_token").and_then(Value::as_str),
        Some("chatgpt-token")
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
    )
    .unwrap();
    assert_eq!(report.state, AgentGlobalConfigState::Flowlet);
    assert!(config_path.is_file());
    assert!(auth_path.is_file());

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

    // 只有部分 Flowlet 标记（model 对了，provider 缺失）→ Partial
    std::fs::write(&config_path, "model = \"flowlet-pro\"\n").unwrap();
    let report = inspect_codex(
        &config_path,
        &auth_path,
        &models_path,
        CODEX_EXPECTED_BASE_URL,
    )
    .unwrap();
    assert_eq!(report.state, AgentGlobalConfigState::Partial);

    // Flowlet 标记齐全但缺少模型目录 → Partial（提示用户重新写入以补齐目录）
    std::fs::write(
        &config_path,
        r##"model = "flowlet-pro"
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

    // 补齐 model_catalog_json 且目录文件在位 → Flowlet
    std::fs::write(
        &config_path,
        &format!(
            r##"model = "flowlet-pro"
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
    std::fs::write(&models_path, codex_model_catalog::DEFAULT_CODEX_MODELS_JSON).unwrap();
    let report = inspect_codex(
        &config_path,
        &auth_path,
        &models_path,
        CODEX_EXPECTED_BASE_URL,
    )
    .unwrap();
    assert_eq!(report.state, AgentGlobalConfigState::Flowlet);
    assert!(report.model_catalog_configured);
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
    )
    .unwrap_err();
    assert!(error.contains("Client Token"));
    assert!(!config_path.exists());
    assert!(!models_path.exists());
}

#[test]
fn preserves_existing_models_catalog_and_reference_on_restore() {
    let (config_path, auth_path, models_path) = test_codex_paths();
    // 用户已有模型目录文件（例如 DeepSeek 的目录）与自定义 model_catalog_json。
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
    )
    .unwrap();
    assert_eq!(report.state, AgentGlobalConfigState::Flowlet);
    // 目录被 Flowlet 内容替换
    assert_eq!(
        std::fs::read_to_string(&models_path).unwrap(),
        codex_model_catalog::DEFAULT_CODEX_MODELS_JSON
    );

    // 恢复：model_catalog_json 与目录内容都回位
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
    )
    .unwrap();
    assert_eq!(report.state, AgentGlobalConfigState::Flowlet);
    assert!(models_path.is_file());
    // 旧备份被升级，恢复时应删除 Flowlet 生成的模型目录
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
        concat!("# Hermes Agent Environment Configuration\n", "OPENROUTER_API_KEY=sk-or-keep\n", "NOVITA_API_KEY=sk-novita-keep\n"),
    )
    .unwrap();

    // inspect：未配置。
    let before = inspect_hermes(&config_path, &env_path, expected_base_url).unwrap();
    assert_eq!(before.state, AgentGlobalConfigState::NotConfigured);
    assert_eq!(before.primary_model, None);
    assert_eq!(before.credentials_path.as_deref(), Some(display_path(&env_path).as_str()));

    // apply：Flowlet 配置写入 config.yaml（api_key 是 ${HERMES_CUSTOM_...} 引用）与 .env
    // （真实密钥），重新解析输出格式并保留用户无关段与其它 .env 变量。
    let applied = apply_hermes(&config_path, &env_path, expected_base_url, "flowlet-token", "flowlet-pro".to_string()).unwrap();
    assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
    assert_eq!(applied.primary_model.as_deref(), Some("flowlet-pro"));
    assert_eq!(
        applied.base_url.as_deref(),
        Some("http://127.0.0.1:18640/v1")
    );
    assert!(applied.api_key_configured);
    let yaml: serde_yaml::Value =
        serde_yaml::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
    assert_eq!(yaml["model"]["provider"].as_str(), Some("custom"));
    assert_eq!(yaml["model"]["default"].as_str(), Some("flowlet-pro"));
    assert_eq!(
        yaml["model"]["api_key"].as_str(),
        Some("${HERMES_CUSTOM_127_0_0_1_18640_API_KEY}")
    );
    assert_eq!(
        yaml["model"]["default_headers"]["x-flowlet-client"].as_str(),
        Some("hermes")
    );
    assert_eq!(yaml["terminal"]["backend"].as_str(), Some("local"));
    assert_eq!(yaml["display"]["theme"].as_str(), Some("dark"));
    let env_text = std::fs::read_to_string(&env_path).unwrap();
    assert!(env_text.contains("HERMES_CUSTOM_127_0_0_1_18640_API_KEY=flowlet-token"));
    assert!(env_text.contains("OPENROUTER_API_KEY=sk-or-keep"));
    assert!(env_text.contains("NOVITA_API_KEY=sk-novita-keep"));

    // reapply：幂等，仍是 Flowlet 且不产生重复键/重复 .env 变量。
    let reapplied = apply_hermes(&config_path, &env_path, expected_base_url, "flowlet-token", "flowlet-pro".to_string()).unwrap();
    assert_eq!(reapplied.state, AgentGlobalConfigState::Flowlet);
    let text = std::fs::read_to_string(&config_path).unwrap();
    assert_eq!(text.matches("provider:").count(), 1);
    assert_eq!(text.matches("default:").count(), 1);
    let reparse: serde_yaml::Value = serde_yaml::from_str(&text).unwrap();
    assert_eq!(reparse["model"]["provider"].as_str(), Some("custom"));
    let env_text = std::fs::read_to_string(&env_path).unwrap();
    assert_eq!(env_text.matches("HERMES_CUSTOM_127_0_0_1_18640_API_KEY=").count(), 1);

    // restore：完整还原到接入前的哨兵状态，并删除 Flowlet 写入的 .env 变量、保留其它变量。
    let restored = restore_hermes(&config_path, &env_path, expected_base_url).unwrap();
    assert_eq!(restored.state, AgentGlobalConfigState::NotConfigured);
    let restored_text = std::fs::read_to_string(&config_path).unwrap();
    assert!(restored_text.contains("model: \"\"") || restored_text.contains("model: ''"));
    let reparse: serde_yaml::Value = serde_yaml::from_str(&restored_text).unwrap();
    assert_eq!(reparse["terminal"]["backend"].as_str(), Some("local"));
    assert_eq!(reparse["display"]["theme"].as_str(), Some("dark"));
    assert!(reparse.get("model").is_none_or(|value| !value.is_mapping()));
    let env_text = std::fs::read_to_string(&env_path).unwrap();
    assert!(!env_text.contains("HERMES_CUSTOM_127_0_0_1_18640_API_KEY"));
    assert!(env_text.contains("OPENROUTER_API_KEY=sk-or-keep"));
    assert!(env_text.contains("NOVITA_API_KEY=sk-novita-keep"));

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
fn hermes_primary_model_resolves_user_choice_with_fallback() {
    let resolve = |primary_model: Option<&str>| {
        super::adapters::hermes::resolve_primary_model(Some(&AgentGlobalConfigOptions {
            primary_model: primary_model.map(str::to_string),
            ..Default::default()
        }))
    };
    assert_eq!(resolve(Some("flowlet-pro")), "flowlet-pro");
    assert_eq!(resolve(Some("flowlet-flash")), "flowlet-flash");
    // 非法值/缺省回退到默认主模型。
    assert_eq!(resolve(Some("gpt-4o")), "flowlet-pro");
    assert_eq!(resolve(None), "flowlet-pro");
    assert_eq!(super::adapters::hermes::resolve_primary_model(None), "flowlet-pro");
}

#[test]
fn hermes_apply_writes_selected_fast_model_and_still_detects_flowlet() {
    let directory = std::env::temp_dir().join(format!(
        "flowlet-hermes-model-choice-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&directory).unwrap();
    let config_path = directory.join("config.yaml");
    let env_path = directory.join(".env");
    let expected_base_url = "http://127.0.0.1:18640/v1";
    std::fs::write(&config_path, "model: \"\"\n").unwrap();

    let applied =
        apply_hermes(&config_path, &env_path, expected_base_url, "flowlet-token", "flowlet-flash".to_string())
            .unwrap();
    assert_eq!(applied.state, AgentGlobalConfigState::Flowlet);
    assert_eq!(applied.primary_model.as_deref(), Some("flowlet-flash"));
    let yaml: serde_yaml::Value =
        serde_yaml::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
    assert_eq!(yaml["model"]["default"].as_str(), Some("flowlet-flash"));

    std::fs::remove_dir_all(directory).unwrap();
}
