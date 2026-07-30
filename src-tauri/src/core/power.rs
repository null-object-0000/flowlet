//! 系统电源抑制：代理有活动请求期间阻止 Windows 自动待机。
//!
//! 背景见 docs/windows-suspend-resume-network-resilience.md：
//! Windows S0 Modern Standby 会冻结桌面进程并断开网络，进行中的流式请求
//! 必然在恢复后失败；而平台不允许桌面应用在待机中继续运行，唯一可行路径是
//! 在有活动请求时抑制系统的自动待机（屏幕不受影响，可正常熄灭）。
//!
//! 局限：无法阻止用户手动触发的待机（合盖、电源键——Windows 手动睡眠优先于
//! 应用请求）；该场景由电源计划引导（合盖动作）另行覆盖。

use std::sync::{Arc, Mutex};

/// 活动请求跟踪器。计数 0→1 时抑制系统自动待机，1→0 时解除。
/// 状态切换在同一把锁内完成，避免并发 acquire/release 交错导致抑制状态泄漏。
#[derive(Clone)]
pub struct ActivityTracker {
    state: Arc<Mutex<ActivityState>>,
}

struct ActivityState {
    active_requests: usize,
    inhibited: bool,
}

/// RAII 守卫：一次活动请求的持有凭证，Drop 时归还计数。
/// 流式请求需把它放进流状态里，让其活到流真正结束。
pub struct ActivityPermit {
    state: Arc<Mutex<ActivityState>>,
}

impl Default for ActivityTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl ActivityTracker {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(ActivityState {
                active_requests: 0,
                inhibited: false,
            })),
        }
    }

    pub fn track(&self) -> ActivityPermit {
        let mut state = self.state.lock().unwrap();
        state.active_requests += 1;
        if state.active_requests == 1 && !state.inhibited {
            platform::inhibit_system_sleep();
            state.inhibited = true;
        }
        ActivityPermit {
            state: self.state.clone(),
        }
    }

    #[cfg(test)]
    pub fn is_inhibited(&self) -> bool {
        self.state.lock().unwrap().inhibited
    }

    #[cfg(test)]
    pub fn active_requests(&self) -> usize {
        self.state.lock().unwrap().active_requests
    }
}

impl Drop for ActivityPermit {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap();
        state.active_requests = state.active_requests.saturating_sub(1);
        if state.active_requests == 0 && state.inhibited {
            platform::release_system_sleep();
            state.inhibited = false;
        }
    }
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::System::Power::{
        ES_CONTINUOUS, ES_SYSTEM_REQUIRED, SetThreadExecutionState,
    };

    /// ES_CONTINUOUS | ES_SYSTEM_REQUIRED：抑制系统自动待机直到显式清除；
    /// 不含 ES_DISPLAY_REQUIRED，屏幕可正常熄灭。进程退出时系统自动清除该请求。
    pub fn inhibit_system_sleep() {
        let previous = unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
        if previous == 0 {
            tracing::warn!("抑制系统自动待机失败（SetThreadExecutionState 返回 0）");
        }
    }

    pub fn release_system_sleep() {
        let previous = unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        if previous == 0 {
            tracing::warn!("解除系统待机抑制失败（SetThreadExecutionState 返回 0）");
        }
    }
}

#[cfg(not(windows))]
mod platform {
    // macOS 可后续用 IOKit IOPMAssertion、Linux 可用 systemd-inhibit 补齐。
    pub fn inhibit_system_sleep() {}
    pub fn release_system_sleep() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inhibits_while_any_request_active_and_releases_at_zero() {
        let tracker = ActivityTracker::new();
        assert!(!tracker.is_inhibited());

        let first = tracker.track();
        assert!(tracker.is_inhibited());
        assert_eq!(tracker.active_requests(), 1);

        let second = tracker.track();
        assert_eq!(tracker.active_requests(), 2);

        drop(first);
        // 仍有活动请求，保持抑制
        assert!(tracker.is_inhibited());
        assert_eq!(tracker.active_requests(), 1);

        drop(second);
        assert!(!tracker.is_inhibited());
        assert_eq!(tracker.active_requests(), 0);
    }

    #[test]
    fn re_inhibits_after_full_release() {
        let tracker = ActivityTracker::new();
        drop(tracker.track());
        assert!(!tracker.is_inhibited());

        let permit = tracker.track();
        assert!(tracker.is_inhibited());
        drop(permit);
        assert!(!tracker.is_inhibited());
    }
}
