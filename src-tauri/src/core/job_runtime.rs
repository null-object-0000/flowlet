use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub initial_delay: Duration,
}

impl RetryPolicy {
    pub const NONE: Self = Self {
        max_attempts: 1,
        initial_delay: Duration::ZERO,
    };

    pub const fn exponential(max_attempts: u32, initial_delay: Duration) -> Self {
        Self {
            max_attempts,
            initial_delay,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JobDefinition {
    pub job_type: &'static str,
    pub scope_key: &'static str,
    /// 单次可安全取消的 attempt 超时；不是整个任务的强制终止时间。
    pub attempt_timeout: Option<Duration>,
    pub retry: RetryPolicy,
}

impl JobDefinition {
    pub const fn exclusive(job_type: &'static str, scope_key: &'static str) -> Self {
        Self {
            job_type,
            scope_key,
            attempt_timeout: None,
            retry: RetryPolicy::NONE,
        }
    }

    pub const fn retryable(
        job_type: &'static str,
        scope_key: &'static str,
        attempt_timeout: Duration,
        retry: RetryPolicy,
    ) -> Self {
        Self {
            job_type,
            scope_key,
            attempt_timeout: Some(attempt_timeout),
            retry,
        }
    }
}

pub const AGENT_DATA_SYNC: JobDefinition =
    JobDefinition::exclusive("agent-data-sync", "agent-data-sync");
pub const CODEX_ACCOUNT_SYNC: JobDefinition =
    JobDefinition::exclusive("codex-account-sync", "codex-account-sync");
pub const CHANNEL_RESOURCE_SYNC: JobDefinition =
    JobDefinition::exclusive("channel-resource-sync", "channel-resource-sync");
pub const DEVICE_S3_SYNC: JobDefinition = JobDefinition::exclusive("device-s3-sync", "device-sync");
pub const DEVICE_S3_PULL: JobDefinition = JobDefinition::exclusive("device-s3-pull", "device-sync");
pub const ACCOUNT_WORKSPACE_SYNC: JobDefinition =
    JobDefinition::exclusive("account-workspace-sync", "account-workspace-sync");
pub const PROJECT_WORKSPACE_SYNC: JobDefinition =
    JobDefinition::exclusive("project-workspace-sync", "project-workspace-sync");
pub const BODY_CLEANUP: JobDefinition = JobDefinition::exclusive("body-cleanup", "body-cleanup");
pub const PROJECT_TASK_RUN: JobDefinition =
    JobDefinition::exclusive("project-task-run", "project-task");
pub const RECURRING_TASK_RUN: JobDefinition =
    JobDefinition::exclusive("recurring-task-run", "project-task");
pub const MODELS_CN_SYNC: JobDefinition = JobDefinition::retryable(
    "models-cn-sync",
    "models-cn-sync",
    Duration::from_secs(30),
    RetryPolicy::exponential(3, Duration::from_millis(250)),
);
pub const MODELS_DEV_SYNC: JobDefinition = JobDefinition::retryable(
    "models-dev-sync",
    "models-dev-sync",
    Duration::from_secs(30),
    RetryPolicy::exponential(3, Duration::from_millis(250)),
);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobAttemptError {
    pub message: String,
    pub retryable: bool,
}

impl JobAttemptError {
    pub fn retryable(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
        }
    }

    pub fn terminal(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
        }
    }
}

impl std::fmt::Display for JobAttemptError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

/// 进程内后台任务运行时。
///
/// SQLite `background_jobs` 继续负责可恢复的任务历史；这里负责进程内并发作用域、
/// 活动任务与持久化 job id 的关联，以及低延迟取消信号。两者职责刻意分离。
#[derive(Clone, Default)]
pub struct JobRuntime {
    inner: Arc<Mutex<JobRuntimeState>>,
}

#[derive(Default)]
struct JobRuntimeState {
    active_by_scope: HashMap<String, ActiveJob>,
}

#[derive(Clone)]
struct ActiveJob {
    run_id: String,
    job_type: String,
    job_id: Option<String>,
    cancellation: CancellationToken,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveJobSnapshot {
    pub scope_key: String,
    pub job_type: String,
    pub job_id: Option<String>,
    pub cancel_requested: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobAlreadyRunning {
    pub scope_key: String,
    pub job_type: String,
    pub job_id: Option<String>,
}

pub struct JobLease {
    runtime: JobRuntime,
    scope_key: String,
    run_id: String,
    cancellation: CancellationToken,
}

impl std::fmt::Debug for JobLease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("JobLease")
            .field("scope_key", &self.scope_key)
            .field("run_id", &self.run_id)
            .finish()
    }
}

impl JobRuntime {
    /// 获取一个排他运行作用域。同一 scope 同时只允许一个任务，彼此无关的 scope 可并行。
    pub fn try_acquire(
        &self,
        job_type: impl Into<String>,
        scope_key: impl Into<String>,
    ) -> Result<JobLease, JobAlreadyRunning> {
        let job_type = job_type.into();
        let scope_key = scope_key.into();
        let mut state = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(active) = state.active_by_scope.get(&scope_key) {
            return Err(JobAlreadyRunning {
                scope_key,
                job_type: active.job_type.clone(),
                job_id: active.job_id.clone(),
            });
        }
        let run_id = uuid::Uuid::new_v4().to_string();
        let cancellation = CancellationToken::new();
        state.active_by_scope.insert(
            scope_key.clone(),
            ActiveJob {
                run_id: run_id.clone(),
                job_type,
                job_id: None,
                cancellation: cancellation.clone(),
            },
        );
        Ok(JobLease {
            runtime: self.clone(),
            scope_key,
            run_id,
            cancellation,
        })
    }

    pub fn try_acquire_definition(
        &self,
        definition: &JobDefinition,
    ) -> Result<JobLease, JobAlreadyRunning> {
        self.try_acquire(definition.job_type, definition.scope_key)
    }

    /// 使用定义中的稳定任务类型，但由领域提供动态作用域（例如按 project_id 隔离）。
    pub fn try_acquire_in_scope(
        &self,
        definition: &JobDefinition,
        scope_key: impl Into<String>,
    ) -> Result<JobLease, JobAlreadyRunning> {
        self.try_acquire(definition.job_type, scope_key)
    }

    /// 同步持久化任务 id。任务创建成功后立即调用，使取消命令能命中活动任务。
    pub fn attach_job_id(&self, lease: &JobLease, job_id: impl Into<String>) {
        let mut state = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(active) = state.active_by_scope.get_mut(&lease.scope_key) {
            if active.run_id == lease.run_id {
                active.job_id = Some(job_id.into());
            }
        }
    }

    /// 向进程内任务发送取消信号。持久化 cancel_requested 由调用方同时写入 SQLite。
    pub fn request_cancel(&self, job_id: &str) -> bool {
        let mut state = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let Some(active) = state
            .active_by_scope
            .values_mut()
            .find(|active| active.job_id.as_deref() == Some(job_id))
        else {
            return false;
        };
        active.cancellation.cancel();
        true
    }

    pub fn active_for_scope(&self, scope_key: &str) -> Option<ActiveJobSnapshot> {
        let state = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        state
            .active_by_scope
            .get(scope_key)
            .map(|active| ActiveJobSnapshot {
                scope_key: scope_key.to_string(),
                job_type: active.job_type.clone(),
                job_id: active.job_id.clone(),
                cancel_requested: active.cancellation.is_cancelled(),
            })
    }

    pub fn is_running(&self, scope_key: &str) -> bool {
        self.active_for_scope(scope_key).is_some()
    }

    fn release(&self, scope_key: &str, run_id: &str) {
        let mut state = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if state
            .active_by_scope
            .get(scope_key)
            .is_some_and(|active| active.run_id == run_id)
        {
            state.active_by_scope.remove(scope_key);
        }
    }
}

/// 执行一个可安全重试的 attempt。超时只包围单次 attempt；执行与重试等待均可取消。
pub async fn run_attempts<T, F, Fut>(
    lease: &JobLease,
    definition: &JobDefinition,
    mut operation: F,
) -> Result<T, JobAttemptError>
where
    F: FnMut(u32) -> Fut,
    Fut: Future<Output = Result<T, JobAttemptError>>,
{
    let max_attempts = definition.retry.max_attempts.max(1);
    for attempt in 1..=max_attempts {
        if lease.cancel_requested() {
            return Err(JobAttemptError::terminal("任务已取消"));
        }
        let attempt_future = operation(attempt);
        let result = if let Some(timeout) = definition.attempt_timeout {
            tokio::select! {
                _ = lease.cancelled() => Err(JobAttemptError::terminal("任务已取消")),
                result = tokio::time::timeout(timeout, attempt_future) => match result {
                    Ok(result) => result,
                    Err(_) => Err(JobAttemptError::retryable(format!(
                        "单次执行超过 {} 毫秒",
                        timeout.as_millis()
                    ))),
                },
            }
        } else {
            tokio::select! {
                _ = lease.cancelled() => Err(JobAttemptError::terminal("任务已取消")),
                result = attempt_future => result,
            }
        };
        match result {
            Ok(value) => return Ok(value),
            Err(error) if error.retryable && attempt < max_attempts => {
                let multiplier = 1_u32 << (attempt - 1).min(10);
                let delay = definition.retry.initial_delay.saturating_mul(multiplier);
                if !delay.is_zero() {
                    tokio::select! {
                        _ = lease.cancelled() => {
                            return Err(JobAttemptError::terminal("任务已取消"));
                        }
                        _ = tokio::time::sleep(delay) => {}
                    }
                }
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("max_attempts is normalized to at least one")
}

impl JobLease {
    pub fn attach_job_id(&self, job_id: impl Into<String>) {
        self.runtime.attach_job_id(self, job_id);
    }

    pub fn cancel_requested(&self) -> bool {
        self.cancellation.is_cancelled()
    }

    pub async fn cancelled(&self) {
        self.cancellation.cancelled().await;
    }
}

impl Drop for JobLease {
    fn drop(&mut self) {
        self.runtime.release(&self.scope_key, &self.run_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_only_the_same_scope_and_releases_on_drop() {
        let runtime = JobRuntime::default();
        let first = runtime
            .try_acquire("agent-data-sync", "agent-data-sync")
            .unwrap();
        let conflict = runtime
            .try_acquire("agent-data-sync", "agent-data-sync")
            .unwrap_err();
        assert_eq!(conflict.job_type, "agent-data-sync");
        let other = runtime
            .try_acquire("codex-account-sync", "codex-account-sync")
            .unwrap();
        assert!(runtime.is_running("agent-data-sync"));
        drop(first);
        assert!(!runtime.is_running("agent-data-sync"));
        assert!(runtime.is_running("codex-account-sync"));
        drop(other);
    }

    #[test]
    fn associates_persisted_id_and_propagates_cancel_signal() {
        let runtime = JobRuntime::default();
        let lease = runtime
            .try_acquire("channel-resource-sync", "channel-resource-sync")
            .unwrap();
        lease.attach_job_id("job-1");
        assert_eq!(
            runtime
                .active_for_scope("channel-resource-sync")
                .unwrap()
                .job_id
                .as_deref(),
            Some("job-1")
        );
        assert!(runtime.request_cancel("job-1"));
        assert!(lease.cancel_requested());
        assert!(!runtime.request_cancel("unknown"));
    }

    #[test]
    fn stale_lease_cannot_release_a_newer_run() {
        let runtime = JobRuntime::default();
        let first = runtime.try_acquire("sync", "scope").unwrap();
        let first_run_id = first.run_id.clone();
        runtime.release("scope", &first_run_id);
        let second = runtime.try_acquire("sync", "scope").unwrap();
        drop(first);
        assert!(runtime.is_running("scope"));
        drop(second);
    }

    #[test]
    fn dynamic_project_scopes_share_a_definition_without_global_serialization() {
        let runtime = JobRuntime::default();
        let first = runtime
            .try_acquire_in_scope(&PROJECT_TASK_RUN, "project-task:project-a")
            .unwrap();
        let other_project = runtime
            .try_acquire_in_scope(&RECURRING_TASK_RUN, "project-task:project-b")
            .unwrap();
        let same_project = runtime
            .try_acquire_in_scope(&RECURRING_TASK_RUN, "project-task:project-a")
            .unwrap_err();

        assert_eq!(same_project.job_type, PROJECT_TASK_RUN.job_type);
        drop(first);
        drop(other_project);
    }

    #[tokio::test]
    async fn retries_retryable_attempts_but_not_terminal_errors() {
        let runtime = JobRuntime::default();
        let definition = JobDefinition::retryable(
            "test",
            "test",
            Duration::from_secs(1),
            RetryPolicy::exponential(3, Duration::ZERO),
        );
        let lease = runtime.try_acquire("test", "test").unwrap();
        let mut attempts = 0;
        let result = run_attempts(&lease, &definition, |_| {
            attempts += 1;
            let current = attempts;
            async move {
                if current < 3 {
                    Err(JobAttemptError::retryable("temporary"))
                } else {
                    Ok("done")
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(result, "done");
        assert_eq!(attempts, 3);

        let mut terminal_attempts = 0;
        let error = run_attempts(&lease, &definition, |_| {
            terminal_attempts += 1;
            async { Err::<(), _>(JobAttemptError::terminal("invalid")) }
        })
        .await
        .unwrap_err();
        assert_eq!(error.message, "invalid");
        assert_eq!(terminal_attempts, 1);
    }

    #[tokio::test]
    async fn times_out_a_safe_attempt_and_honors_cancel_before_start() {
        let runtime = JobRuntime::default();
        let definition = JobDefinition::retryable(
            "test-timeout",
            "test-timeout",
            Duration::from_millis(10),
            RetryPolicy::NONE,
        );
        let lease = runtime.try_acquire_definition(&definition).unwrap();
        let error = run_attempts(&lease, &definition, |_| async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            Ok::<_, JobAttemptError>(())
        })
        .await
        .unwrap_err();
        assert!(error.retryable);
        assert!(error.message.contains("超过 10 毫秒"));

        lease.attach_job_id("cancel-me");
        assert!(runtime.request_cancel("cancel-me"));
        let mut called = false;
        let error = run_attempts(&lease, &definition, |_| {
            called = true;
            async { Ok::<_, JobAttemptError>(()) }
        })
        .await
        .unwrap_err();
        assert_eq!(error.message, "任务已取消");
        assert!(!called);
    }

    #[tokio::test]
    async fn interrupts_an_in_flight_safe_attempt() {
        let runtime = JobRuntime::default();
        let definition = JobDefinition::retryable(
            "test-cancel",
            "test-cancel",
            Duration::from_secs(5),
            RetryPolicy::NONE,
        );
        let lease = runtime.try_acquire_definition(&definition).unwrap();
        lease.attach_job_id("cancel-in-flight");
        let cancelling_runtime = runtime.clone();
        let cancelling = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            cancelling_runtime.request_cancel("cancel-in-flight")
        });

        let started_at = tokio::time::Instant::now();
        let error = run_attempts(&lease, &definition, |_| async {
            tokio::time::sleep(Duration::from_secs(1)).await;
            Ok::<_, JobAttemptError>(())
        })
        .await
        .unwrap_err();

        assert!(cancelling.await.unwrap());
        assert_eq!(error.message, "任务已取消");
        assert!(started_at.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn builtin_definitions_keep_expected_scope_relationships() {
        assert_eq!(DEVICE_S3_SYNC.scope_key, DEVICE_S3_PULL.scope_key);
        assert_ne!(AGENT_DATA_SYNC.scope_key, CODEX_ACCOUNT_SYNC.scope_key);
        assert_eq!(MODELS_CN_SYNC.retry.max_attempts, 3);
        assert_eq!(
            MODELS_DEV_SYNC.attempt_timeout,
            Some(Duration::from_secs(30))
        );
        assert_eq!(ACCOUNT_WORKSPACE_SYNC.retry, RetryPolicy::NONE);
        assert_eq!(BODY_CLEANUP.job_type, "body-cleanup");
        assert_eq!(PROJECT_TASK_RUN.scope_key, RECURRING_TASK_RUN.scope_key);
    }
}
