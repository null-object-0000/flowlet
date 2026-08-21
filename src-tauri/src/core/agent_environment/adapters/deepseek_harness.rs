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
            runner_executable: None,
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
            let bin_entry = npx_package
                .as_ref()
                .and_then(|(package_dir, _)| npx_bin_entry(package_dir));
            let (executable_path, install_dir) = match (&npx_package, &bin_entry) {
                (Some((package_dir, _)), Some(entry)) => {
                    (display_path(entry), display_path(package_dir))
                }
                (Some((package_dir, _)), None) => (DEFAULT_WEB_URL.to_string(), display_path(package_dir)),
                (None, _) => (
                    DEFAULT_WEB_URL.to_string(),
                    data_home
                        .map(|path| display_path(path))
                        .unwrap_or_else(|| DEFAULT_WEB_URL.to_string()),
                ),
            };
            let error = match (&npx_package, &bin_entry) {
                (Some(_), Some(_)) => None,
                (Some(_), None) => Some(
                    "在 npm 缓存中找到 @deepseek-ai/dsh，但无法解析包的可执行入口；建议全局安装后重试"
                        .to_string(),
                ),
                (None, _) => Some(if web_running {
                    "Web 正在运行，但 npm 缓存中没有唯一版本的 @deepseek-ai/dsh；无法据此执行 headless 任务，请全局安装后重试。当前接入与会话观测不受影响。".to_string()
                } else {
                    "检测到 Harness 数据目录，但没有可用于执行任务的 @deepseek-ai/dsh；请全局安装后重试。".to_string()
                }),
            };
            installations.push(AgentInstallation {
                surface: AgentSurface::Web,
                executable_path,
                install_dir,
                install_method: if npx_package.is_some() {
                    AgentInstallMethod::Npx
                } else {
                    AgentInstallMethod::Unknown
                },
                version: npx_package.map(|(_, version)| version),
                version_output: None,
                available_on_path: false,
                runner_executable: bin_entry.map(|entry| display_path(&entry)),
                error,
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

/// 解析 npx 缓存包的真实 bin 入口 JS（`bin` 为字符串或键值表，如
/// `{"dsh": "lib/bin.js"}`）。存在的文件才返回，供 Runner 以 `node` 直接解释执行，
/// 不依赖 PATH 或 npm 垫片。
fn npx_bin_entry(package_dir: &Path) -> Option<std::path::PathBuf> {
    let content = std::fs::read_to_string(package_dir.join("package.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&content).ok()?;
    let bin = value.get("bin")?;
    let entry = match bin {
        serde_json::Value::String(path) => path.clone(),
        serde_json::Value::Object(map) => map
            .get("dsh")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                map.values()
                    .find_map(serde_json::Value::as_str)
                    .map(str::to_owned)
            })?,
        _ => return None,
    };
    let path = package_dir.join(entry);
    path.is_file().then_some(path)
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

    #[test]
    fn resolves_npx_package_bin_entry_for_runner() {
        let package =
            std::env::temp_dir().join(format!("flowlet-dsh-bin-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(package.join("lib")).unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"@deepseek-ai/dsh","version":"0.1.0-rc.6","bin":{"dsh":"lib/bin.js"}}"#,
        )
        .unwrap();
        std::fs::write(package.join("lib/bin.js"), "#!/usr/bin/env node\n").unwrap();
        assert_eq!(npx_bin_entry(&package), Some(package.join("lib/bin.js")));

        // bin 为字符串形态且文件缺失时返回 None，不产出可执行入口。
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"@deepseek-ai/dsh","version":"0.1.0-rc.6","bin":"lib/missing.js"}"#,
        )
        .unwrap();
        assert_eq!(npx_bin_entry(&package), None);
        std::fs::remove_dir_all(package).unwrap();
    }
}
