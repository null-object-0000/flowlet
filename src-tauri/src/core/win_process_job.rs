//! Windows Job Object 绑定：把 Flowlet 托管的运行时子进程（当前是 DSH Web）
//! 放进一个设置了 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job。
//!
//! 背景：DSH Web 由 Flowlet 以 `CREATE_NO_WINDOW` 静默启动（用户看不到任何终端），
//! 此前的生命周期只依赖内存记录 + 托盘“退出 Flowlet”路径调用 `stop_all()`。
//! 一旦 Flowlet 崩溃、被任务管理器强杀或以其他非托盘路径退出，子进程就会变成
//! 孤儿继续占用 3080 端口，下一次启动的 Flowlet 只能把它标记为“外部进程”。
//!
//! 绑定 Job 后，Job 句柄由 Flowlet 进程持有：无论 Flowlet 以何种方式退出，
//! 内核都会关闭句柄并按 KILL_ON_JOB_CLOSE 终止 Job 内的整棵进程树
//! （cmd.exe → node.exe 的孙进程默认自动加入同一 Job，无需额外处理）。
//! 刻意不设置 `JOB_OBJECT_LIMIT_BREAKAWAY_OK` / `SILENT_BREAKAWAY_OK`，
//! 避免子进程树被拆出 Job。
//!
//! 正常的启停路径不受影响：`terminate_process`（taskkill /T /F）仍先行执行，
//! Job 句柄在 `ManagedRuntime` 被移除时 Drop，只是兜底回收残余进程。

/// 持有 Job Object 句柄的 RAII 守卫。
///
/// Drop 时 `CloseHandle`；若此刻 Job 内仍有存活进程，KILL_ON_JOB_CLOSE
/// 会同步终止它们。Flowlet 进程本身退出时，内核同样会关闭该句柄，
/// 因此崩溃 / 被杀场景由操作系统兜底，不依赖任何用户态清理代码。
#[cfg(windows)]
pub(crate) struct ManagedProcessJob {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

// SAFETY：HANDLE 只是进程级内核句柄令牌，从不按裸指针解引用，CloseHandle 等
// Job API 可在任意线程调用；该类型未实现 Clone（唯一所有权），Drop 至多执行
// 一次 CloseHandle，因此跨线程移动（Send）与共享引用（Sync）都是安全的。
// AgentRuntimeManager 位于 Tauri 的 AppState 中，必须满足 Send + Sync。
#[cfg(windows)]
unsafe impl Send for ManagedProcessJob {}
#[cfg(windows)]
unsafe impl Sync for ManagedProcessJob {}

#[cfg(windows)]
impl ManagedProcessJob {
    /// 创建 Job（KILL_ON_JOB_CLOSE）并把已有进程句柄绑入。
    ///
    /// `process_handle` 来自 `Child::raw_handle()`（`RawHandle` 与 `HANDLE`
    /// 同为 `*mut c_void` 别名）。绑定失败只影响“异常退出兜底”，不应阻断
    /// 正常启停流程，因此返回 `Result` 由调用方决定是否降级。
    pub(crate) fn bind(process_handle: windows_sys::Win32::Foundation::HANDLE) -> Result<Self, String> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        // SAFETY：全部为 Windows Job Objects 的句柄级 FFI 调用；
        // 任何一步失败都必须 CloseHandle 释放已创建的 Job，避免句柄泄漏。
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err("CreateJobObjectW 失败".to_string());
            }

            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                CloseHandle(handle);
                return Err("SetInformationJobObject(KILL_ON_JOB_CLOSE) 失败".to_string());
            }

            if AssignProcessToJobObject(handle, process_handle) == 0 {
                CloseHandle(handle);
                return Err("AssignProcessToJobObject 失败".to_string());
            }

            Ok(Self { handle })
        }
    }
}

#[cfg(windows)]
impl Drop for ManagedProcessJob {
    fn drop(&mut self) {
        // 关闭 Job 句柄即触发 KILL_ON_JOB_CLOSE；返回值无可恢复动作，忽略。
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// 与 agent_runtime 的真实形态一致：cmd.exe 垫片 → 孙进程，隐藏控制台。
    /// 即使断言失败导致守卫未按预期生效，ping 也会在 30 秒后自然退出。
    fn spawn_long_running_child() -> std::process::Child {
        let mut command = Command::new("cmd.exe");
        command.args(["/D", "/C", "ping", "-n", "30", "127.0.0.1"]);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command.creation_flags(CREATE_NO_WINDOW);
        command.spawn().expect("spawn test child")
    }

    #[test]
    fn closing_the_job_terminates_the_whole_bound_tree() {
        let mut child = spawn_long_running_child();
        let process_handle = child.as_raw_handle();
        let job = ManagedProcessJob::bind(process_handle).expect("bind job");

        // 绑定后子进程仍在正常运行。
        assert!(child.try_wait().expect("try_wait").is_none());

        // 模拟 Flowlet 退出（含崩溃）：句柄关闭必须带走整棵进程树。
        drop(job);

        let deadline = Instant::now() + Duration::from_secs(10);
        while child.try_wait().expect("try_wait").is_none() {
            assert!(Instant::now() < deadline, "Job 关闭后子进程仍未被终止");
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}
