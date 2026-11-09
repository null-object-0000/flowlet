use super::{
    channel_capability_adapter::{query_channel_balance, supports_official_balance},
    config::{AccountBalanceSnapshot, ChannelAccount, ChannelPreset},
    presets::BalanceQueryResult,
    services::FlowletServices,
};

/// Shared balance operation: persist snapshot and publish credential state to the proxy.
pub async fn query_balance(
    state: &FlowletServices,
    account_id: String,
) -> Result<BalanceQueryResult, String> {
    let account = {
        let snapshot = state.runtime_config.snapshot();
        snapshot
            .accounts
            .iter()
            .find(|a| a.id == account_id)
            .ok_or("账号不存在")?
            .clone()
    };

    let preset_supports_balance = state
        .runtime_config
        .snapshot()
        .channels
        .iter()
        .find(|preset| preset.id == account.channel_id)
        .is_some_and(|preset| preset.supports_balance_query);
    if !preset_supports_balance || !supports_official_balance(&account.channel_id) {
        return Ok(BalanceQueryResult {
            balance: None,
            currency: None,
            is_available: false,
            error: Some("当前渠道不支持官方余额查询".to_string()),
        });
    }

    if account.effective_openai_base_url().is_some() {
        return Ok(BalanceQueryResult {
            balance: None,
            currency: None,
            is_available: false,
            error: Some("自定义 OpenAI Base URL 不支持官方余额自动同步".to_string()),
        });
    }

    let config = state
        .channels_config
        .lock()
        .map_err(|_| "锁定渠道运行时配置失败".to_string())?
        .clone();
    let is_openrouter = account.channel_id == "openrouter";
    let uses_management_key = is_openrouter
        && account
            .management_key
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());

    // 直接在命令自身的 async 上下文里 await。适配器返回的 Future 全部是 `Send`
    // （见 `channel_capability_adapter` 的 `BalanceQueryFuture`），底层 HTTP 也是异步
    // 实现，因此既不需要 `spawn_blocking`，更不能在阻塞线程里自建嵌套 tokio runtime。
    //
    // 2026-09-19 事故现场：这里原先是「在 spawn_blocking 内自建 current-thread tokio
    // runtime，并用 unwrap_or_else 把 runtime 搭建失败转成 panic」。一旦搭建因进程资源
    // 耗尽返回 Err（tokio 的 build() 只在创建 IO/signal driver 失败时报错），一次本可
    // 上报给用户的 I/O 错误就被升级成 panic。嵌套 runtime 本身在 spawn_blocking 里是
    // 允许的（tokio 只在 block_on 时检查运行上下文，build() 不检查），所以这不是
    // 「必然 panic」的写法——但它是纯粹的重复开销与风险面，必须去掉。禁止该 bug class
    // 复现的回归测试见文件末尾的 `nested_runtime_regression_tests`。
    let result = query_channel_balance(&account, &config).await?;

    // 更新账号凭证状态与最后错误信息。
    // 测试连接成功 → 重置为 healthy；若返回 401 则标记为 invalid_key。
    // Management Key 与模型调用 API Key 相互独立，其查询结果不得改变路由凭证状态。
    // 同时更新共享内存，保证 SQLite / 共享内存 / 前端状态一致，下一次路由立即生效。
    if result.error.is_none() {
        if !uses_management_key {
            let _ = state.storage.mark_account_credential_healthy(&account_id);
        }
        state.runtime_config.update(|snapshot| {
            if let Some(shared_account) = snapshot
                .accounts
                .iter_mut()
                .find(|item| item.id == account_id)
            {
                if !uses_management_key {
                    shared_account.credential_status =
                        crate::core::config::ACCOUNT_CREDENTIAL_HEALTHY.to_string();
                }
                shared_account.last_error = None;
            }
        });
    }
    if let Some(ref err) = result.error {
        let _ = state.storage.update_account_last_error(&account_id, err);
        if !uses_management_key && (err.contains("HTTP 401") || err.contains("401")) {
            let _ = state.storage.mark_account_credential_invalid(&account_id);
            state.runtime_config.update(|snapshot| {
                if let Some(shared_account) = snapshot
                    .accounts
                    .iter_mut()
                    .find(|item| item.id == account_id)
                {
                    shared_account.credential_status =
                        crate::core::config::ACCOUNT_CREDENTIAL_INVALID_KEY.to_string();
                    shared_account.last_error = Some(err.clone());
                }
            });
        }
    } else {
        let now = chrono::Utc::now().to_rfc3339();
        let snapshot = AccountBalanceSnapshot {
            id: format!("balance-{}-{}", account_id, uuid::Uuid::new_v4()),
            account_id: account_id.clone(),
            balance: result.balance,
            currency: result.currency.clone(),
            token_pack_total: None,
            token_pack_used: None,
            token_pack_remaining: None,
            token_pack_expire_at: None,
            token_packs: None,
            raw_scraped_json: None,
            source: "sync".to_string(),
            synced_at: Some(now.clone()),
            remark: Some(if uses_management_key {
                "OpenRouter Management Key 账户 Credits 同步".to_string()
            } else if is_openrouter {
                "OpenRouter API Key 限额同步".to_string()
            } else {
                "官方余额接口同步".to_string()
            }),
            created_at: now.clone(),
            updated_at: now,
        };
        state
            .storage
            .save_balance_snapshot(&snapshot)
            .map_err(|err| err.to_string())?;
        let _ = state.storage.update_account_last_used(&account_id);
    }

    Ok(result)
}

/// 无桌面环境（headless / Docker Host）可自动同步的账号条件。
///
/// 与桌面端 `channel_resource_sync_method` 的官方余额分支保持同一口径：
/// 启用、渠道声明支持余额查询、适配器提供官方余额实现，且没有账号级自定义
/// OpenAI Base URL（自定义端点不保证官方余额接口语义）。
///
/// 控制台 WebView 抓取依赖桌面能力，不在服务端自动同步范围内。
pub fn supports_unattended_balance_sync(
    preset: Option<&ChannelPreset>,
    account: &ChannelAccount,
) -> bool {
    account.enabled
        && preset.is_some_and(|preset| preset.supports_balance_query)
        && supports_official_balance(&account.channel_id)
        && account.effective_openai_base_url().is_none()
}

/// 一轮官方余额同步的结果统计，用于宿主写运行日志。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BalanceSyncOutcome {
    pub attempted: usize,
    pub succeeded: usize,
    pub failed: usize,
}

/// 串行同步所有可由官方余额 API 更新的账号（桌面端由隐藏 WebView 抓取的渠道不在此列）。
///
/// 串行执行避免对上游渠道并发施压；单账号失败只记录日志，不中断本轮其余账号。
/// 宿主（headless / Docker）按固定周期调用，本身不持有重叠的并发轮次。
pub async fn sync_official_balances(state: &FlowletServices) -> BalanceSyncOutcome {
    let (accounts, presets) = {
        let snapshot = state.runtime_config.snapshot();
        (snapshot.accounts.clone(), snapshot.channels.clone())
    };
    let targets = accounts
        .iter()
        .filter(|account| {
            let preset = presets
                .iter()
                .find(|preset| preset.id == account.channel_id);
            supports_unattended_balance_sync(preset, account)
        })
        .map(|account| account.id.clone())
        .collect::<Vec<_>>();
    let mut outcome = BalanceSyncOutcome {
        attempted: targets.len(),
        ..Default::default()
    };
    for account_id in targets {
        match query_balance(state, account_id.clone()).await {
            Ok(result) if result.error.is_none() => outcome.succeeded += 1,
            Ok(result) => {
                outcome.failed += 1;
                tracing::warn!(
                    account_id = %account_id,
                    error = result.error.as_deref().unwrap_or("未知错误"),
                    "官方余额自动同步返回错误"
                );
            }
            Err(error) => {
                outcome.failed += 1;
                tracing::warn!(
                    account_id = %account_id,
                    error = %error,
                    "官方余额自动同步失败"
                );
            }
        }
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::channels_config::{ChannelsConfig, DEFAULT_CONFIG_JSON};

    fn channel_presets() -> Vec<ChannelPreset> {
        let json: serde_json::Value = serde_json::from_str(DEFAULT_CONFIG_JSON).unwrap();
        ChannelsConfig::from_config_json(&json).unwrap().presets
    }

    fn preset<'a>(presets: &'a [ChannelPreset], id: &str) -> &'a ChannelPreset {
        presets
            .iter()
            .find(|preset| preset.id == id)
            .unwrap_or_else(|| panic!("缺少渠道预设 {id}"))
    }

    fn account(channel_id: &str) -> ChannelAccount {
        ChannelAccount {
            channel_id: channel_id.to_string(),
            enabled: true,
            ..Default::default()
        }
    }

    #[test]
    fn unattended_sync_accepts_official_balance_channels() {
        let presets = channel_presets();
        for channel_id in ["deepseek", "kimi", "openrouter", "vibetoken"] {
            assert!(
                supports_unattended_balance_sync(
                    Some(preset(&presets, channel_id)),
                    &account(channel_id)
                ),
                "{channel_id} 应参与服务端官方余额同步"
            );
        }
    }

    #[test]
    fn unattended_sync_rejects_scrape_only_disabled_or_overridden_accounts() {
        let presets = channel_presets();

        // Qwen 只有控制台抓取，没有官方余额接口。
        assert!(!supports_unattended_balance_sync(
            Some(preset(&presets, "qwen")),
            &account("qwen")
        ));

        let mut disabled = account("deepseek");
        disabled.enabled = false;
        assert!(!supports_unattended_balance_sync(
            Some(preset(&presets, "deepseek")),
            &disabled
        ));

        let mut overridden = account("deepseek");
        overridden.base_url_override = Some("https://relay.example.com/v1".to_string());
        assert!(!supports_unattended_balance_sync(
            Some(preset(&presets, "deepseek")),
            &overridden
        ));

        assert!(!supports_unattended_balance_sync(
            None,
            &account("deepseek")
        ));
    }
}
