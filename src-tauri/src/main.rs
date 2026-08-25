#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let logging_result = flowlet_lib::core::logging::init_file_logging();
    flowlet_lib::core::logging::install_panic_hook();
    if let Err(error) = &logging_result {
        flowlet_lib::core::logging::write_emergency_log("startup", error);
    }
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        pid = std::process::id(),
        "Flowlet 进程启动"
    );

    let _single_instance = match acquire_single_instance() {
        Some(guard) => guard,
        None => {
            tracing::warn!("检测到已有 Flowlet 实例，本次启动退出");
            return;
        }
    };

    flowlet_lib::run();
    tracing::info!("Flowlet 事件循环结束");
}

#[cfg(windows)]
struct SingleInstanceGuard(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
fn acquire_single_instance() -> Option<SingleInstanceGuard> {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::System::Threading::CreateMutexW;

    let name: Vec<u16> = "Local\\FlowletDesktopSingleInstance"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 1, name.as_ptr()) };

    if handle.is_null() {
        return None;
    }

    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe {
            let _ = windows_sys::Win32::Foundation::CloseHandle(handle);
        }
        return None;
    }

    Some(SingleInstanceGuard(handle))
}

/// Linux / macOS 的单例实现：对 exe 同级目录下的锁文件加 BSD `flock` 独占锁。
///
/// 与 Windows 的命名互斥量不同，这里必须落在文件系统上；选择 `flock` 而非
/// `create_new`，是因为 `flock` 随进程退出（含崩溃）自动释放，不会留下需要
/// 手动清理的脏锁文件。锁文件与 `flowlet.sqlite` / `logs` 一样放在 exe 同级，
/// 保持“整个目录自包含、可随身拷贝”的语义——不同安装目录视为不同实例。
#[cfg(not(windows))]
mod single_instance {
    use std::fs::OpenOptions;
    use std::os::fd::AsRawFd;
    use std::path::{Path, PathBuf};

    /// 持有独占锁的文件句柄；`Drop` 关闭文件即释放锁。
    pub struct SingleInstanceGuard {
        _file: std::fs::File,
    }

    pub fn acquire() -> Option<SingleInstanceGuard> {
        let lock_path = lock_file_path()?;
        acquire_at(&lock_path)
    }

    fn acquire_at(lock_path: &Path) -> Option<SingleInstanceGuard> {
        if let Some(parent) = lock_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(lock_path)
            .ok()?;

        // LOCK_EX | LOCK_NB：抢不到立即返回，不阻塞。
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if rc != 0 {
            return None;
        }

        Some(SingleInstanceGuard { _file: file })
    }

    fn lock_file_path() -> Option<PathBuf> {
        std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(|dir| dir.join(".flowlet.lock")))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn second_acquire_fails_while_first_is_held() {
            let dir = std::env::temp_dir().join(format!(
                "flowlet-single-instance-test-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let lock_path = dir.join("flowlet.lock");

            let first = acquire_at(&lock_path).expect("首次加锁应成功");
            assert!(
                acquire_at(&lock_path).is_none(),
                "持锁期间第二次加锁应失败"
            );

            drop(first);
            let _second = acquire_at(&lock_path).expect("释放后再次加锁应成功");

            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}

#[cfg(not(windows))]
fn acquire_single_instance() -> Option<single_instance::SingleInstanceGuard> {
    single_instance::acquire()
}
