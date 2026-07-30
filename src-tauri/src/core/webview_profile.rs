use std::path::{Path, PathBuf};

const CACHE_PRUNE_THRESHOLD_BYTES: u64 = 32 * 1024 * 1024;

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
    use super::prune_oversized_webview_caches_with_threshold;

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
}
