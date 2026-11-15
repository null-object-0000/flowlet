//! Mobile sync leases: serialize manual/background pulls and release on every exit path.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub struct JobDefinition {
    pub job_type: &'static str,
    pub scope_key: &'static str,
}
pub const DEVICE_S3_PULL: JobDefinition = JobDefinition {
    job_type: "device-s3-pull",
    scope_key: "device-sync",
};
#[derive(Clone, Default, Debug)]
pub struct JobRuntime {
    active: Arc<Mutex<HashMap<String, String>>>,
}
#[derive(Debug)]
pub struct JobLease {
    runtime: JobRuntime,
    scope_key: String,
    run_id: String,
}
impl JobRuntime {
    pub fn try_acquire_definition(&self, definition: &JobDefinition) -> Result<JobLease, String> {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if active.contains_key(definition.scope_key) {
            return Err(format!("{} already running", definition.job_type));
        }
        let run_id = uuid::Uuid::new_v4().to_string();
        active.insert(definition.scope_key.to_string(), run_id.clone());
        Ok(JobLease {
            runtime: self.clone(),
            scope_key: definition.scope_key.to_string(),
            run_id,
        })
    }
}
impl Drop for JobLease {
    fn drop(&mut self) {
        let mut active = self
            .runtime
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if active.get(&self.scope_key) == Some(&self.run_id) {
            active.remove(&self.scope_key);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn concurrent_pulls_share_a_lease_until_the_running_future_is_dropped() {
        let runtime = JobRuntime::default();
        let lease = runtime.try_acquire_definition(&DEVICE_S3_PULL).unwrap();
        let other = runtime.clone();
        assert!(
            std::thread::spawn(move || other.try_acquire_definition(&DEVICE_S3_PULL))
                .join()
                .unwrap()
                .is_err()
        );
        drop(lease);
        assert!(runtime.try_acquire_definition(&DEVICE_S3_PULL).is_ok());
    }
    #[test]
    fn unwind_releases_the_sync_scope() {
        let runtime = JobRuntime::default();
        let other = runtime.clone();
        assert!(std::panic::catch_unwind(move || {
            let _lease = other.try_acquire_definition(&DEVICE_S3_PULL).unwrap();
            panic!("simulated pull failure");
        })
        .is_err());
        assert!(runtime.try_acquire_definition(&DEVICE_S3_PULL).is_ok());
    }
}
