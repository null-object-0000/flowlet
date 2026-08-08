use std::path::{Path, PathBuf};
use tauri::Manager;

const CACHE_PRUNE_THRESHOLD_BYTES: u64 = 32 * 1024 * 1024;

/// exe 同级目录。与 SQLite（`app_database_path`）、日志（`logging::log_dir`）、
/// 前端 `get_app_data_dir` 保持一致，保证便携版可整个目录随身拷贝。
pub fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|dir| dir.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 便携模式：exe 旁存在 portable.tag（scripts/build-portable.mjs 写入）。
/// 只有便携版才把 WebView 登录态放到 exe 旁；安装版仍使用 %LOCALAPPDATA%，
/// 避免 Program Files 写权限问题。
pub fn is_portable() -> bool {
    exe_dir().join("portable.tag").is_file()
}

/// WebView 数据根目录：
/// - 便携模式 → exe 旁（渠道控制台登录态随身拷贝）；
/// - 安装模式 → app_local_data_dir（%LOCALAPPDATA%\site.snewbie.flowlet，维持现状）。
pub fn webview_data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if is_portable() {
        Ok(exe_dir())
    } else {
        app.path()
            .app_local_data_dir()
            .map_err(|error| format!("解析应用数据目录失败: {error}"))
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct WebviewProfileMigrationReport {
    pub migrated: usize,
    pub skipped: usize,
    pub failures: Vec<String>,
}

/// 便携模式下把 %LOCALAPPDATA% 的 main-webview / scrape-webview-* 登录态迁移到
/// exe 旁。目标已存在（已迁移 / 用户手动放置）则跳过，不覆盖。非便携模式下
/// legacy_root == portable_root，自动为空操作。
///
/// 单个 profile 迁移失败仅记入 failures 并 warn，不阻塞应用启动（登录态丢失顶多
/// 重新登录，不应阻止应用运行）。
pub fn migrate_webview_profiles_to_portable(
    legacy_root: &Path,
    portable_root: &Path,
) -> WebviewProfileMigrationReport {
    let mut report = WebviewProfileMigrationReport::default();
    if legacy_root == portable_root {
        return report;
    }
    let profiles = match flowlet_webview_profiles(legacy_root) {
        Ok(profiles) => profiles,
        Err(error) => {
            report.failures.push(error);
            return report;
        }
    };
    if profiles.is_empty() {
        return report;
    }
    if let Err(error) = std::fs::create_dir_all(portable_root) {
        report
            .failures
            .push(format!("创建便携 WebView 数据目录 {} 失败: {error}", portable_root.display()));
        return report;
    }

    for profile in profiles {
        let name = profile
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        let target = portable_root.join(&name);
        if target.exists() {
            report.skipped += 1;
            continue;
        }
        match move_directory(&profile, &target) {
            Ok(()) => {
                report.migrated += 1;
                tracing::info!(
                    profile = %profile.display(),
                    target = %target.display(),
                    "WebView 登录态已迁移到便携目录"
                );
            }
            Err(error) => {
                let message = format!(
                    "迁移 WebView profile {} 到 {} 失败: {error}",
                    profile.display(),
                    target.display()
                );
                report.failures.push(message.clone());
                tracing::warn!(%message);
            }
        }
    }
    report
}

/// 移动目录；同卷 rename 失败（如跨卷）时回退为复制后删除原目录。
fn move_directory(source: &Path, target: &Path) -> std::io::Result<()> {
    match std::fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(_) => {
            copy_dir_all(source, target)?;
            std::fs::remove_dir_all(source)
        }
    }
}

fn copy_dir_all(source: &Path, target: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

const RUNTIME_CACHE_PATHS: &[&[&str]] = &[
    &["EBWebView", "Default", "Cache"],
    &["EBWebView", "Default", "Code Cache"],
    &["EBWebView", "Default", "GPUCache"],
    &["EBWebView", "Default", "DawnWebGPUCache"],
    &["EBWebView", "Default", "DawnGraphiteCache"],
    &["EBWebView", "GrShaderCache"],
    &["EBWebView", "ShaderCache"],
    &["EBWebView", "GPUPersistentCache"],
];

/// WebView2 参数会替换 wry 的默认参数，因此这里同时保留其默认安全开关。
#[cfg(windows)]
pub const WINDOWS_CACHE_LIMIT_BROWSER_ARGS: &str = concat!(
    "--disk-cache-size=16777216 ",
    "--media-cache-size=4194304 ",
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"
);

#[derive(Debug, Default, PartialEq, Eq)]
pub struct WebviewCachePruneReport {
    pub profiles_scanned: usize,
    pub profiles_pruned: usize,
    pub bytes_pruned: u64,
    pub failures: Vec<String>,
}

/// 清理 Flowlet 自己的主窗口与 per-account 抓取窗口中可再生的运行时缓存。
///
/// Cookie、Local Storage、Network 和 WebStorage 均不在清理列表中，因此渠道登录态、
/// 应用偏好和账号隔离不会被破坏。只有缓存总量超过阈值的 profile 才会清理，避免
/// 每次启动都丢失小规模缓存带来的加载收益。
pub fn prune_oversized_webview_caches(app_local_data_dir: &Path) -> WebviewCachePruneReport {
    prune_oversized_webview_caches_with_threshold(app_local_data_dir, CACHE_PRUNE_THRESHOLD_BYTES)
}

fn prune_oversized_webview_caches_with_threshold(
    app_local_data_dir: &Path,
    threshold_bytes: u64,
) -> WebviewCachePruneReport {
    let mut report = WebviewCachePruneReport::default();
    let profiles = match flowlet_webview_profiles(app_local_data_dir) {
        Ok(profiles) => profiles,
        Err(error) => {
            report.failures.push(error);
            return report;
        }
    };

    for profile in profiles {
        report.profiles_scanned += 1;
        let cache_paths = runtime_cache_paths(&profile);
        let cache_bytes = cache_paths
            .iter()
            .map(|path| directory_size(path).unwrap_or_default())
            .sum::<u64>();
        if cache_bytes < threshold_bytes {
            continue;
        }

        let mut removed_any = false;
        for cache_path in cache_paths {
            if !cache_path.exists() {
                continue;
            }
            match std::fs::remove_dir_all(&cache_path) {
                Ok(()) => removed_any = true,
                Err(error) => report.failures.push(format!(
                    "清理 WebView 缓存 {} 失败: {error}",
                    cache_path.display()
                )),
            }
        }
        if removed_any {
            report.profiles_pruned += 1;
            report.bytes_pruned += cache_bytes;
        }
    }

    report
}

fn flowlet_webview_profiles(app_local_data_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut profiles = Vec::new();
    let entries = match std::fs::read_dir(app_local_data_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(profiles),
        Err(error) => {
            return Err(format!(
                "读取 WebView 数据目录 {} 失败: {error}",
                app_local_data_dir.display()
            ));
        }
    };

    for entry in entries {
        let entry = entry.map_err(|error| format!("读取 WebView profile 失败: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取 WebView profile 类型失败: {error}"))?;
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == "main-webview" || name.starts_with("scrape-webview-") {
            profiles.push(entry.path());
        }
    }
    Ok(profiles)
}

fn runtime_cache_paths(profile: &Path) -> Vec<PathBuf> {
    RUNTIME_CACHE_PATHS
        .iter()
        .map(|segments| {
            segments
                .iter()
                .fold(profile.to_path_buf(), |path, segment| path.join(segment))
        })
        .collect()
}

fn directory_size(path: &Path) -> std::io::Result<u64> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_symlink() {
        return Ok(0);
    }
    if metadata.is_file() {
        return Ok(metadata.len());
    }

    let mut size = 0_u64;
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        size = size.saturating_add(directory_size(&entry.path())?);
    }
    Ok(size)
}

#[cfg(test)]
mod tests {
    use super::{
        migrate_webview_profiles_to_portable, prune_oversized_webview_caches_with_threshold,
    };
    use std::path::Path;

    #[test]
    fn prunes_only_regenerable_flowlet_webview_caches() {
        let root = std::env::temp_dir().join(format!(
            "flowlet-webview-cache-prune-{}",
            uuid::Uuid::new_v4()
        ));
        let profile = root.join("scrape-webview-account-1").join("EBWebView");
        let cache = profile.join("Default").join("Cache");
        let code_cache = profile.join("Default").join("Code Cache");
        let cookies = profile.join("Default").join("Network");
        std::fs::create_dir_all(&cache).expect("create cache");
        std::fs::create_dir_all(&code_cache).expect("create code cache");
        std::fs::create_dir_all(&cookies).expect("create network store");
        std::fs::write(cache.join("cache.bin"), b"cache").expect("write cache");
        std::fs::write(code_cache.join("code.bin"), b"code").expect("write code cache");
        std::fs::write(cookies.join("Cookies"), b"login-state").expect("write cookies");

        let report = prune_oversized_webview_caches_with_threshold(&root, 1);

        assert_eq!(report.profiles_scanned, 1);
        assert_eq!(report.profiles_pruned, 1);
        assert!(report.failures.is_empty());
        assert!(!cache.exists());
        assert!(!code_cache.exists());
        assert_eq!(
            std::fs::read(cookies.join("Cookies")).expect("read cookies"),
            b"login-state"
        );

        std::fs::remove_dir_all(&root).expect("remove test profile");
    }

    #[test]
    fn ignores_non_flowlet_profiles_and_small_caches() {
        let root = std::env::temp_dir().join(format!(
            "flowlet-webview-cache-threshold-{}",
            uuid::Uuid::new_v4()
        ));
        let main_cache = root
            .join("main-webview")
            .join("EBWebView")
            .join("Default")
            .join("Cache");
        let unrelated_cache = root
            .join("other-profile")
            .join("EBWebView")
            .join("Default")
            .join("Cache");
        std::fs::create_dir_all(&main_cache).expect("create main cache");
        std::fs::create_dir_all(&unrelated_cache).expect("create unrelated cache");
        std::fs::write(main_cache.join("small.bin"), b"small").expect("write main cache");
        std::fs::write(unrelated_cache.join("large.bin"), vec![0_u8; 64])
            .expect("write unrelated cache");

        let report = prune_oversized_webview_caches_with_threshold(&root, 32);

        assert_eq!(report.profiles_scanned, 1);
        assert_eq!(report.profiles_pruned, 0);
        assert!(main_cache.exists());
        assert!(unrelated_cache.exists());

        std::fs::remove_dir_all(&root).expect("remove test profile");
    }

    fn make_profile_with_cookies(root: &Path, name: &str) -> std::path::PathBuf {
        let profile = root.join(name);
        let network = profile.join("EBWebView").join("Default").join("Network");
        std::fs::create_dir_all(&network).expect("create network store");
        std::fs::write(
            network.join("Cookies"),
            format!("login-state-{name}").as_bytes(),
        )
        .expect("write cookies");
        profile
    }

    #[test]
    fn migrates_legacy_profiles_to_portable_root() {
        let root = std::env::temp_dir().join(format!(
            "flowlet-webview-migrate-{}",
            uuid::Uuid::new_v4()
        ));
        let legacy = root.join("legacy");
        let portable = root.join("portable");
        make_profile_with_cookies(&legacy, "main-webview");
        make_profile_with_cookies(&legacy, "scrape-webview-account-1");

        let report = migrate_webview_profiles_to_portable(&legacy, &portable);

        assert_eq!(report.migrated, 2);
        assert_eq!(report.skipped, 0);
        assert!(report.failures.is_empty());
        // 原位置被搬走，目标位置登录态到位。
        assert!(!legacy.join("main-webview").exists());
        assert!(!legacy.join("scrape-webview-account-1").exists());
        assert_eq!(
            std::fs::read(portable.join("main-webview/EBWebView/Default/Network/Cookies"))
                .expect("read migrated cookies"),
            b"login-state-main-webview"
        );
        assert_eq!(
            std::fs::read(
                portable
                    .join("scrape-webview-account-1")
                    .join("EBWebView")
                    .join("Default")
                    .join("Network")
                    .join("Cookies")
            )
            .expect("read migrated cookies"),
            b"login-state-scrape-webview-account-1"
        );

        std::fs::remove_dir_all(&root).expect("remove test root");
    }

    #[test]
    fn skips_migration_when_target_exists() {
        let root = std::env::temp_dir().join(format!(
            "flowlet-webview-migrate-existing-{}",
            uuid::Uuid::new_v4()
        ));
        let legacy = root.join("legacy");
        let portable = root.join("portable");
        make_profile_with_cookies(&legacy, "main-webview");
        // 目标已存在（模拟已迁移后重启 / 用户手动放置），不覆盖。
        make_profile_with_cookies(&portable, "main-webview");

        let report = migrate_webview_profiles_to_portable(&legacy, &portable);

        assert_eq!(report.migrated, 0);
        assert_eq!(report.skipped, 1);
        assert!(report.failures.is_empty());
        assert!(legacy.join("main-webview").exists(), "原目录应保留");
        assert_eq!(
            std::fs::read(portable.join("main-webview/EBWebView/Default/Network/Cookies"))
                .expect("read cookies"),
            b"login-state-main-webview"
        );

        std::fs::remove_dir_all(&root).expect("remove test root");
    }

    #[test]
    fn ignores_unrelated_legacy_dirs() {
        let root = std::env::temp_dir().join(format!(
            "flowlet-webview-migrate-unrelated-{}",
            uuid::Uuid::new_v4()
        ));
        let legacy = root.join("legacy");
        let portable = root.join("portable");
        make_profile_with_cookies(&legacy, "main-webview");
        std::fs::create_dir_all(legacy.join("other-profile")).expect("create unrelated");
        std::fs::create_dir_all(legacy.join("local.flowlet.desktop")).expect("create unrelated");

        let report = migrate_webview_profiles_to_portable(&legacy, &portable);

        assert_eq!(report.migrated, 1);
        assert_eq!(report.skipped, 0);
        assert!(report.failures.is_empty());
        assert!(
            legacy.join("other-profile").exists(),
            "非 Flowlet profile 目录不应迁移"
        );
        assert!(
            legacy.join("local.flowlet.desktop").exists(),
            "非 Flowlet profile 目录不应迁移"
        );

        std::fs::remove_dir_all(&root).expect("remove test root");
    }

    #[test]
    fn migration_is_noop_when_roots_match() {
        let root = std::env::temp_dir().join(format!(
            "flowlet-webview-migrate-same-{}",
            uuid::Uuid::new_v4()
        ));
        make_profile_with_cookies(&root, "main-webview");

        let report = migrate_webview_profiles_to_portable(&root, &root);

        assert_eq!(report.migrated, 0);
        assert_eq!(report.skipped, 0);
        assert!(report.failures.is_empty());
        assert!(root.join("main-webview").exists());

        std::fs::remove_dir_all(&root).expect("remove test root");
    }
}
