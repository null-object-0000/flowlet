//! Host 无关的周期维护任务：存储清理与模型目录同步。
//!
//! 桌面 Host 与 headless / Docker Host 必须执行同一组后台维护，否则 Body 保留策略、
//! 余额快照保留策略和模型目录新鲜度只会在桌面端生效。这里只放周期、同步地址与
//! “执行一次”的公共实现；由哪个运行时 spawn 由各 Host 决定
//! （桌面用 `tauri::async_runtime::spawn`，headless 用 `tokio::spawn`），
//! 避免两套日志、错误处理和参数拼写各自漂移。
use crate::core::job_runtime::JobRuntime;
use crate::core::storage::{storage_tasks, Storage};
use std::path::PathBuf;
use std::time::Duration;

/// 存储清理：启动后 15 分钟首次执行，之后每 15 分钟一次。
pub const STORAGE_CLEANUP_FIRST_DELAY: Duration = Duration::from_secs(15 * 60);
pub const STORAGE_CLEANUP_INTERVAL: Duration = Duration::from_secs(15 * 60);

/// 模型目录同步：启动后 1 小时首次执行，之后每 1 小时一次。
pub const CATALOG_SYNC_FIRST_DELAY: Duration = Duration::from_secs(60 * 60);
pub const CATALOG_SYNC_INTERVAL: Duration = Duration::from_secs(60 * 60);

pub const MODELS_CN_URL: &str = "https://null-object-0000.github.io/models-cn/api.json";
pub const MODELS_DEV_URL: &str = "https://models.dev/api.json";

/// 执行一次存储清理：请求/响应 Body 的过期与超限清理，以及派生的余额/资源快照保留策略。
///
/// 清理本身是同步 SQLite/文件操作，优先放到阻塞线程执行，避免占住异步 worker；
/// 若当前不在 tokio 运行时上下文（例如被同步测试直接调用），退化为原地执行。
pub async fn run_storage_cleanup_once(storage: Storage, config_path: PathBuf, jobs: JobRuntime) {
    let result = match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            let storage = storage.clone();
            let config_path = config_path.clone();
            let jobs = jobs.clone();
            handle
                .spawn_blocking(move || storage.run_scheduled_body_cleanup_job(&config_path, &jobs))
                .await
        }
        Err(_) => Ok(storage.run_scheduled_body_cleanup_job(&config_path, &jobs)),
    };
    match result {
        Ok(Ok((job_id, expired, pruned, before, after))) => {
            let before_mb = before as f64 / 1048576.0;
            let after_mb = after as f64 / 1048576.0;
            tracing::info!(
                job_id = %job_id,
                expired,
                pruned,
                before_mb = format!("{before_mb:.1}"),
                after_mb = format!("{after_mb:.1}"),
                "scheduled storage cleanup finished"
            );
        }
        Ok(Err(error)) => {
            tracing::warn!(error = %error, "scheduled storage cleanup job failed");
        }
        Err(error) => {
            tracing::warn!(error = %error, "scheduled body cleanup task panicked");
        }
    }
}

/// 执行一次模型目录同步：models-cn 与 models.dev 相互独立，结果分别写入后台任务日志。
pub async fn run_catalog_sync_once(storage: Storage, config_path: PathBuf, jobs: JobRuntime) {
    match storage_tasks::sync_models_cn_catalog(
        &storage,
        &jobs,
        &config_path,
        MODELS_CN_URL,
        "scheduled",
    )
    .await
    {
        Ok(sync_result) => {
            tracing::info!(
                started = sync_result.started,
                skipped = sync_result.skipped,
                providers = sync_result.provider_count,
                models = sync_result.model_count,
                "scheduled models-cn sync finished"
            );
        }
        Err(error) => {
            tracing::warn!(error = %error, "scheduled models-cn sync failed");
        }
    }
    match storage_tasks::sync_models_dev_catalog(
        &storage,
        &jobs,
        &config_path,
        MODELS_DEV_URL,
        "scheduled",
    )
    .await
    {
        Ok(sync_result) => {
            tracing::info!(
                started = sync_result.started,
                skipped = sync_result.skipped,
                providers = sync_result.provider_count,
                models = sync_result.model_count,
                "scheduled models.dev sync finished"
            );
        }
        Err(error) => {
            tracing::warn!(error = %error, "scheduled models.dev sync failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn periods_match_documented_scheduling() {
        assert_eq!(STORAGE_CLEANUP_FIRST_DELAY, Duration::from_secs(15 * 60));
        assert_eq!(STORAGE_CLEANUP_INTERVAL, Duration::from_secs(15 * 60));
        assert_eq!(CATALOG_SYNC_FIRST_DELAY, Duration::from_secs(60 * 60));
        assert_eq!(CATALOG_SYNC_INTERVAL, Duration::from_secs(60 * 60));
    }

    #[tokio::test]
    async fn storage_cleanup_once_runs_on_empty_database() {
        let root = std::env::temp_dir().join(format!("flowlet-scheduler-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let config_path = root.join("config.json");
        std::fs::write(&config_path, "{}").unwrap();
        let storage = Storage::open(root.join("scheduler.sqlite")).unwrap();
        let jobs = JobRuntime::default();
        run_storage_cleanup_once(storage, config_path, jobs).await;
        let _ = std::fs::remove_dir_all(&root);
    }
}
