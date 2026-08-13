use super::super::*;
use super::DetectionFuture;
use std::collections::HashSet;
use std::path::PathBuf;

const DEFAULT_WEB_URL: &str = "http://127.0.0.1:3080";

pub(super) fn detect_boxed() -> DetectionFuture {
    Box::pin(detect())
}

async fn detect() -> AgentEnvironmentReport {
    let mut installations = Vec::new();
    for candidate in dsh_cli_candidates() {
        let install_method = classify_dsh_method(&candidate.path);
        let install_dir = resolve_dsh_install_dir(&candidate.path, &install_method);
        let package_version = read_package_version(&install_dir);
        let version_result = read_version(&candidate.path).await;
        let (version, version_output, error) = match version_result {
            Ok(output) => (
                parse_version(&output).or(package_version),
                Some(output),
                None,
            ),
            Err(_) if package_version.is_some() => (package_version, None, None),
            Err(error) => (None, None, Some(error)),
        };
        installations.push(AgentInstallation {
            surface: AgentSurface::Web,
            executable_path: display_path(&candidate.path),
            install_dir: display_path(&install_dir),
            install_method,
            version,
            version_output,
            available_on_path: candidate.available_on_path,
            error,
        });
    }

    let dsh_home = std::env::var_os("DSH_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".dsh")));
    let web_running = tokio::net::TcpStream::connect("127.0.0.1:3080")
        .await
        .is_ok();
    if installations.is_empty() {
        let data_home = dsh_home.as_ref().filter(|path| path.is_dir());
        if web_running || data_home.is_some() {
            let npx_package = unambiguous_npx_package(&dsh_npx_cache_roots());
            installations.push(AgentInstallation {
                surface: AgentSurface::Web,
                executable_path: DEFAULT_WEB_URL.to_string(),
                install_dir: npx_package
                    .as_ref()
                    .map(|(path, _)| display_path(path))
                    .or_else(|| data_home.map(|path| display_path(path)))
                    .unwrap_or_else(|| DEFAULT_WEB_URL.to_string()),
                install_method: if npx_package.is_some() {
                    AgentInstallMethod::Npm
                } else {
                    AgentInstallMethod::Unknown
                },
                version: npx_package.map(|(_, version)| version),
                version_output: None,
                available_on_path: false,
                error: Some(if web_running {
                    "Web 正在运行，但当前 PATH 没有稳定的 dsh 启动命令；Flowlet 不会依赖 npx 临时缓存执行任务。".to_string()
                } else {
                    "检测到 Harness 数据目录，但当前 PATH 没有稳定的 dsh 启动命令。".to_string()
                }),
            });
        }
    }

    let primary = installations
        .iter()
        .find(|item| item.available_on_path && item.error.is_none())
        .or_else(|| installations.first())
        .cloned();
    AgentEnvironmentReport {
        agent_id: "deepseek-harness".to_string(),
        agent_name: "DeepSeek Harness".to_string(),
        installed: !installations.is_empty(),
        runtime_running: Some(web_running),
        primary,
        installations,
    }
}

fn dsh_npx_cache_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for key in ["NPM_CONFIG_CACHE", "npm_config_cache"] {
        if let Some(path) = std::env::var_os(key) {
            roots.push(PathBuf::from(path));
        }
    }
    #[cfg(windows)]
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local_app_data).join("npm-cache"));
    }
    #[cfg(not(windows))]
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".npm"));
    }
    roots.sort();
    roots.dedup();
    roots
}

/// npx 的哈希目录不是稳定的可执行入口，只用于只读显示版本。
/// 多个不同版本同时存在时无法确认当前 Web 来自哪一个，因此不猜测。
fn unambiguous_npx_package(cache_roots: &[PathBuf]) -> Option<(PathBuf, String)> {
    let mut packages = Vec::new();
    let mut versions = HashSet::new();
    for cache_root in cache_roots {
        let npx_root = cache_root.join("_npx");
        let Ok(entries) = std::fs::read_dir(npx_root) else {
            continue;
        };
        for entry in entries.flatten() {
            let package_dir = entry
                .path()
                .join("node_modules")
                .join("@deepseek-ai")
                .join("dsh");
            let Some(version) = read_package_version(&package_dir) else {
                continue;
            };
            versions.insert(version.clone());
            packages.push((package_dir, version));
        }
    }
    (versions.len() == 1)
        .then(|| packages.into_iter().next())
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_package(cache: &std::path::Path, hash: &str, version: &str) -> PathBuf {
        let package = cache
            .join("_npx")
            .join(hash)
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(
            package.join("package.json"),
            format!(r#"{{"name":"@deepseek-ai/dsh","version":"{version}"}}"#),
        )
        .unwrap();
        package
    }

    #[test]
    fn reads_only_an_unambiguous_npx_version() {
        let root = std::env::temp_dir().join(format!("flowlet-dsh-npx-{}", uuid::Uuid::new_v4()));
        write_package(&root, "one", "0.1.0-rc.6");
        write_package(&root, "same-version", "0.1.0-rc.6");
        let (package, version) = unambiguous_npx_package(std::slice::from_ref(&root)).unwrap();
        assert!(package.ends_with(PathBuf::from("@deepseek-ai").join("dsh")));
        assert_eq!(version, "0.1.0-rc.6");

        write_package(&root, "other-version", "0.1.0-rc.7");
        assert_eq!(unambiguous_npx_package(&[root.clone()]), None);
        std::fs::remove_dir_all(root).unwrap();
    }
}
