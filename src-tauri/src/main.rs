#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let _single_instance = match acquire_single_instance() {
        Some(guard) => guard,
        None => {
            eprintln!("SINGLE_INSTANCE_LOCK: another process is running");
            return;
        }
    };
    // 设置 panic hook 输出到文件
    let log_path = std::env::current_exe()
        .ok().and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_default()
        .join("panic.log");
    std::panic::set_hook(Box::new({
        let log_path = log_path.clone();
        move |info| {
            let msg = format!("PANIC: {info}\n");
            let _ = std::fs::write(&log_path, &msg);
            eprintln!("{msg}");
        }
    }));
    eprintln!("MAIN: starting run()");
    flowlet_lib::run();
}

#[cfg(windows)]
struct SingleInstanceGuard(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        unsafe { let _ = windows_sys::Win32::Foundation::CloseHandle(self.0); }
    }
}

#[cfg(windows)]
fn acquire_single_instance() -> Option<SingleInstanceGuard> {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::System::Threading::CreateMutexW;
    let name: Vec<u16> = "Local\\FlowletDesktopSingleInstance".encode_utf16().chain(std::iter::once(0)).collect();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 1, name.as_ptr()) };
    if handle.is_null() { return None; }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe { let _ = windows_sys::Win32::Foundation::CloseHandle(handle); }
        return None;
    }
    Some(SingleInstanceGuard(handle))
}

#[cfg(not(windows))]
struct SingleInstanceGuard;
#[cfg(not(windows))]
fn acquire_single_instance() -> Option<SingleInstanceGuard> { Some(SingleInstanceGuard) }
