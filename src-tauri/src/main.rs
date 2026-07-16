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

#[cfg(not(windows))]
struct SingleInstanceGuard;
#[cfg(not(windows))]
fn acquire_single_instance() -> Option<SingleInstanceGuard> {
    Some(SingleInstanceGuard)
}
