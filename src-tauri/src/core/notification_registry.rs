//! Windows 桌面通知的 AppUserModelID 注册。
//!
//! 便携版（无安装器、无开始菜单快捷方式）的 WinRT Toast 通知需要把
//! AppUserModelID 注册到 `HKCU\Software\Classes\AppUserModelId\<aumid>`，
//! 否则 Windows 会静默丢弃通知。这里在应用启动时幂等地注册一次，
//! 写入当前用户注册表（无需管理员权限），让 `tauri-plugin-notification`
//! 的 toast 在便携版下也能正常弹出。

/// 注册 Windows 应用的 AppUserModelID，使 toast 通知可用。
/// 仅 Windows 生效；失败只记录日志，不影响应用启动。
#[cfg(windows)]
pub(crate) fn register_app_user_model_id(aumid: &str, display_name: &str) {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let path = format!(r"Software\Classes\AppUserModelId\{aumid}");
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    match hkcu.create_subkey(&path) {
        Ok((key, _)) => {
            if let Err(error) = key.set_value("DisplayName", &display_name) {
                tracing::warn!(aumid, %error, "写入 AppUserModelID DisplayName 失败");
            }
            // 指向应用自身的 exe，让 toast 显示应用图标而不是空白占位。
            let exe_path = std::env::current_exe()
                .ok()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default();
            if !exe_path.is_empty() {
                if let Err(error) = key.set_value("IconUri", &exe_path) {
                    tracing::warn!(aumid, %error, "写入 AppUserModelID IconUri 失败");
                }
            }
        }
        Err(error) => {
            tracing::warn!(aumid, %error, "创建 AppUserModelID 注册表项失败");
        }
    }
}