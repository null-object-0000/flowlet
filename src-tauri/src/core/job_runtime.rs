use std::collections::HashMap;
use std::sync::{Arc, Mutex};

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
    cancel_requested: bool,
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
        state.active_by_scope.insert(
            scope_key.clone(),
            ActiveJob {
                run_id: run_id.clone(),
                job_type,
                job_id: None,
                cancel_requested: false,
            },
        );
        Ok(JobLease {
            runtime: self.clone(),
            scope_key,
            run_id,
        })
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
        active.cancel_requested = true;
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
                cancel_requested: active.cancel_requested,
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

impl JobLease {
    pub fn attach_job_id(&self, job_id: impl Into<String>) {
        self.runtime.attach_job_id(self, job_id);
    }

    pub fn cancel_requested(&self) -> bool {
        let state = self
            .runtime
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state
            .active_by_scope
            .get(&self.scope_key)
            .is_some_and(|active| active.run_id == self.run_id && active.cancel_requested)
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
}
