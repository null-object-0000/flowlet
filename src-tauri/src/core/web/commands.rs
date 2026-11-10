use super::WebState;
use crate::core::{
    channel_capability_adapter,
    config::{
        AgentSessionsFilter, ChannelAccount, LogsFilter, ProxyBindConfig, RouteCandidate,
        VirtualModel,
    },
    service_credentials::{self, ServiceCredentialInput},
    storage::storage_tasks,
    sync,
};
use axum::http::StatusCode;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
type Error = (StatusCode, &'static str, String);
fn error(e: impl ToString) -> Error {
    (StatusCode::BAD_REQUEST, "command_failed", e.to_string())
}
fn value(v: impl Serialize) -> Result<Value, Error> {
    serde_json::to_value(v).map_err(error)
}
fn arg<T: DeserializeOwned>(args: &Value, name: &str) -> Result<T, Error> {
    serde_json::from_value(args.get(name).cloned().unwrap_or(Value::Null))
        .map_err(|e| error(format!("参数 {name}: {e}")))
}

pub async fn dispatch(state: &WebState, command: &str, args: Value) -> Result<Value, Error> {
    let s = &state.services;
    macro_rules! read {
        ($call:expr) => {
            value($call.map_err(error)?)
        };
    }
    match command {
        "ipc_ping" => value(json!({"ok":true,"host":"web"})),
        "list_channel_presets" => value(s.runtime_config.snapshot().channels.clone()),
        "list_channel_accounts" => value(s.runtime_config.snapshot().accounts.clone()),
        "list_route_candidates" => value(s.runtime_config.snapshot().routes.clone()),
        "list_virtual_models" => value(s.runtime_config.snapshot().virtual_models.clone()),
        "list_channel_models" => read!(s.storage.list_channel_models()),
        "save_channel_accounts" => {
            let accounts: Vec<ChannelAccount> = arg(&args, "accounts")?;
            let normalized = s
                .runtime_config
                .update_after(
                    || {
                        s.storage
                            .save_channel_accounts(&accounts)
                            .map_err(|e| e.to_string())?;
                        s.storage.list_channel_accounts().map_err(|e| e.to_string())
                    },
                    |snapshot, saved| snapshot.accounts = saved.clone(),
                )
                .map_err(error)?;
            value(normalized)
        }
        "save_route_candidates" => {
            let routes: Vec<RouteCandidate> = arg(&args, "routes")?;
            s.runtime_config
                .update_after(
                    || {
                        s.storage
                            .save_route_candidates(&routes)
                            .map_err(|e| e.to_string())?;
                        Ok::<_, String>(routes)
                    },
                    |snapshot, saved| snapshot.routes = saved.clone(),
                )
                .map_err(error)?;
            Ok(Value::Null)
        }
        "save_virtual_models" => {
            let models: Vec<VirtualModel> = arg(&args, "models")?;
            s.runtime_config
                .update_after(
                    || {
                        s.storage
                            .save_virtual_models(&models)
                            .map_err(|e| e.to_string())?;
                        Ok::<_, String>(models)
                    },
                    |snapshot, saved| snapshot.virtual_models = saved.clone(),
                )
                .map_err(error)?;
            Ok(Value::Null)
        }
        "proxy_status" => value(s.proxy.status()),
        "start_proxy" => {
            s.start_proxy().await.map_err(error)?;
            Ok(Value::Null)
        }
        "stop_proxy" => {
            s.stop_proxy().await.map_err(error)?;
            Ok(Value::Null)
        }
        "get_proxy_bind_config" => value(s.bind_config.lock().map_err(error)?.clone()),
        "web_connection_info" => value(
            json!({"base_url":state.public_proxy_url,"client_token":s.bind_config.lock().map_err(error)?.default_client_token}),
        ),
        "set_proxy_bind_config" => {
            let config: ProxyBindConfig = arg(&args, "config")?;
            s.set_bind_config(config.clone()).map_err(error)?;
            s.storage
                .set_app_meta(
                    "proxy_bind_config",
                    &serde_json::to_string(&config).map_err(error)?,
                )
                .map_err(error)?;
            Ok(Value::Null)
        }
        "test_connection" | "fetch_channel_models" => {
            let channel: String = arg(&args, "channelId")?;
            let account = ChannelAccount {
                channel_id: channel.clone(),
                api_key: arg(&args, "apiKey")?,
                base_url_override: arg(&args, "baseUrlOverride")?,
                use_upstream_proxy: arg(&args, "useUpstreamProxy")?,
                enabled: true,
                ..Default::default()
            };
            let config = s.channels_config.lock().map_err(error)?.clone();
            if command == "test_connection" {
                sync::test_channel_connection(&account, &config)
                    .await
                    .map_err(error)?;
                return Ok(Value::Null);
            }
            let preset = s
                .runtime_config
                .snapshot()
                .channels
                .iter()
                .find(|p| p.id == channel)
                .cloned();
            let result =
                channel_capability_adapter::sync_channel_models(&account, preset.as_ref(), &config)
                    .await
                    .map_err(error)?;
            if result.errors.is_empty() {
                let mut models = s
                    .storage
                    .list_channel_models()
                    .map_err(error)?
                    .into_iter()
                    .filter(|m| m.channel_id != channel)
                    .collect::<Vec<_>>();
                models.extend(result.models.clone());
                s.storage.save_channel_models(&models).map_err(error)?;
            }
            value(result)
        }
        "list_custom_scrape_channels" => value(crate::core::custom_scrape::list_channels()),
        // 千问平台 device-flow 登录与 HTTP 直连同步：Web Host 没有 WebView，
        // 这条路径是它获取余额与免费额度的唯一方式。
        "qwen_platform_status" => {
            let account_id: String = arg(&args, "accountId")?;
            value(crate::core::qwen_platform::status(s, &account_id))
        }
        "qwen_platform_login_start" => {
            let account_id: String = arg(&args, "accountId")?;
            read!(crate::core::qwen_platform::start_login(s, &account_id).await)
        }
        "qwen_platform_login_poll" => {
            let account_id: String = arg(&args, "accountId")?;
            read!(crate::core::qwen_platform::poll_login(s, &account_id).await)
        }
        "qwen_platform_logout" => {
            let account_id: String = arg(&args, "accountId")?;
            read!(crate::core::qwen_platform::logout(s, &account_id))
        }
        "qwen_platform_sync" => {
            let account_id: String = arg(&args, "accountId")?;
            read!(crate::core::qwen_platform::sync_account(s, &account_id).await)
        }
        "cleanup_old_logs" => {
            let days: i64 = arg(&args, "keepDays")?;
            if days < 0 {
                return Err(error("保留天数不能小于零"));
            }
            read!(s.storage.cleanup_old_logs(days))
        }
        "sync_models_cn_catalog" | "sync_models_dev_catalog" => {
            let source: String = arg(&args, "sourceUrl")?;
            let trigger: String = arg(&args, "triggerSource")?;
            if command == "sync_models_cn_catalog" {
                value(
                    storage_tasks::sync_models_cn_catalog(
                        &s.storage,
                        &s.jobs,
                        &s.config_path,
                        &source,
                        &trigger,
                    )
                    .await
                    .map_err(error)?,
                )
            } else {
                value(
                    storage_tasks::sync_models_dev_catalog(
                        &s.storage,
                        &s.jobs,
                        &s.config_path,
                        &source,
                        &trigger,
                    )
                    .await
                    .map_err(error)?,
                )
            }
        }
        "latest_balance_snapshots" => read!(s.storage.latest_balance_snapshots()),
        "save_balance_snapshot" => {
            s.storage
                .save_balance_snapshot(&arg(&args, "snapshot")?)
                .map_err(error)?;
            Ok(Value::Null)
        }
        "query_balance" => {
            let id: String = arg(&args, "accountId")?;
            value(
                crate::core::account_balance::query_balance(s, id)
                    .await
                    .map_err(error)?,
            )
        }
        "list_request_logs" => {
            let filter: LogsFilter = arg(&args, "filter")?;
            read!(s.storage.list_request_logs_page(filter))
        }
        "list_known_devices" => {
            let identity = state.device_identity.lock().map_err(error)?.clone();
            read!(crate::core::device_usage::known_devices(
                &s.storage, &identity
            ))
        }
        "device_daily_usage" => {
            let device_id: Option<String> = arg(&args, "deviceId")?;
            let current_device_id = state
                .device_identity
                .lock()
                .map_err(error)?
                .device_id
                .clone();
            read!(crate::core::device_usage::daily_usage(
                &s.storage,
                &current_device_id,
                device_id.as_deref(),
            ))
        }
        "device_hourly_usage" => {
            let device_id: Option<String> = arg(&args, "deviceId")?;
            let current_device_id = state
                .device_identity
                .lock()
                .map_err(error)?
                .device_id
                .clone();
            read!(crate::core::device_usage::hourly_usage(
                &s.storage,
                &current_device_id,
                device_id.as_deref(),
            ))
        }
        "list_request_log_clients" => read!(s.storage.list_request_log_clients()),
        "list_request_log_models" => read!(s.storage.list_request_log_models()),
        "list_request_log_channel_accounts" => {
            read!(s.storage.list_request_log_channel_accounts())
        }
        "get_request_log_detail" => read!(s
            .storage
            .list_request_logs_by_request_id(&arg::<String>(&args, "requestId")?)),
        // 会话目录只来自本实例 `request_logs` 的观测聚合：Web Host 不读取服务器本机
        // Agent 原生会话文件，也不扫描个人配置目录。筛选/分页口径与桌面端一致。
        "list_agent_sessions" => {
            let filter: AgentSessionsFilter = arg(&args, "filter")?;
            read!(s.storage.list_observed_agent_sessions_page(filter))
        }
        "list_agent_session_children" => {
            let agent_type: String = arg(&args, "agentType")?;
            let parent_session_id: String = arg(&args, "parentSessionId")?;
            read!(s
                .storage
                .list_observed_agent_session_children(&agent_type, &parent_session_id))
        }
        "account_routing_scores" => read!(s.storage.account_routing_scores()),
        "usage_summary" => {
            let start: Option<String> = arg(&args, "startAt")?;
            let end: Option<String> = arg(&args, "endAt")?;
            let group: String = arg(&args, "groupBy")?;
            if !matches!(group.as_str(), "hour" | "day") {
                return Err(error("无效的分组粒度"));
            }
            match (&start, &end) {
                (None, None) => {}
                (Some(a), Some(b))
                    if chrono::DateTime::parse_from_rfc3339(a).map_err(error)?
                        < chrono::DateTime::parse_from_rfc3339(b).map_err(error)? => {}
                _ => return Err(error("开始时间必须早于结束时间，且必须同时提供")),
            }
            let current_device_id = state
                .device_identity
                .lock()
                .map_err(error)?
                .device_id
                .clone();
            read!(s.storage.usage_summary_range(
                start.as_deref(),
                end.as_deref(),
                &group,
                &current_device_id,
            ))
        }
        "usage_today_tokens" => read!(s.storage.usage_today_summary()),
        "get_log_capture_config" => value(s.capture.lock().map_err(error)?.clone()),
        "set_log_capture_config" => {
            let capture = arg(&args, "config")?;
            s.storage
                .set_app_meta(
                    "log_capture_config",
                    &serde_json::to_string(&capture).map_err(error)?,
                )
                .map_err(error)?;
            *s.capture.lock().map_err(error)? = capture;
            Ok(Value::Null)
        }
        "read_app_meta" => read!(s.storage.get_app_meta(&arg::<String>(&args, "key")?)),
        "write_app_meta" => {
            let key: String = arg(&args, "key")?;
            if !["model_exposure_mode", "usage_cost_display_config"].contains(&key.as_str()) {
                return Err(error("Web 模式不允许修改此内部设置"));
            }
            s.storage
                .set_app_meta(&key, &arg::<String>(&args, "value")?)
                .map_err(error)?;
            Ok(Value::Null)
        }
        "get_models_cn_catalog" => value(storage_tasks::read_models_cn_file()),
        "get_models_dev_provider_catalog" => {
            let provider: String = arg(&args, "providerId")?;
            let catalog = storage_tasks::read_models_dev_file()
                .and_then(|v| serde_json::from_str::<Value>(&v).ok());
            value(
                catalog
                    .and_then(|v| v.get(&provider).cloned())
                    .map(|v| json!({(provider):v}).to_string()),
            )
        }
        "get_models_cn_currencies" => read!(storage_tasks::get_models_cn_currencies()),
        "get_upstream_proxy_config" => value(crate::core::upstream_proxy::current()),
        "set_upstream_proxy_config" => {
            let config: crate::core::upstream_proxy::UpstreamProxyConfig = arg(&args, "config")?;
            let config = config.normalized();
            config.validate().map_err(error)?;
            s.storage
                .set_app_meta(
                    crate::core::upstream_proxy::UPSTREAM_PROXY_META_KEY,
                    &serde_json::to_string(&config).map_err(error)?,
                )
                .map_err(error)?;
            crate::core::upstream_proxy::set(config).map_err(error)?;
            Ok(Value::Null)
        }
        "list_credential_providers" => value(service_credentials::providers()),
        "list_service_credentials" => value(service_credentials::list(s).map_err(error)?),
        "save_service_credential" => {
            let input: ServiceCredentialInput = arg(&args, "input")?;
            let insecure: Option<bool> = arg(&args, "insecure")?;
            let view = service_credentials::save(s, input, insecure.unwrap_or(false))
                .await
                .map_err(error)?;
            value(view)
        }
        "test_service_credential" => {
            let id: String = arg(&args, "id")?;
            let insecure: Option<bool> = arg(&args, "insecure")?;
            let check = service_credentials::test(s, &id, insecure.unwrap_or(false))
                .await
                .map_err(error)?;
            value(check)
        }
        "delete_service_credential" => {
            let id: String = arg(&args, "id")?;
            service_credentials::delete(s, &id).map_err(error)?;
            Ok(Value::Null)
        }
        "export_service_credentials" => value(service_credentials::export(s).map_err(error)?),
        _ => Err((
            StatusCode::NOT_IMPLEMENTED,
            "unsupported_in_web",
            format!("此功能需要桌面端：{command}"),
        )),
    }
}
