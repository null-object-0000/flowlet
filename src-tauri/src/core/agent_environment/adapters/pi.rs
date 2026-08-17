use super::super::*;
use super::DetectionFuture;

pub(super) fn detect_boxed() -> DetectionFuture {
    Box::pin(detect())
}

async fn detect() -> AgentEnvironmentReport {
    let mut installations = Vec::new();
    for candidate in pi_cli_candidates() {
        let install_method = classify_pi_cli_method(&candidate.path);
        let install_dir = resolve_pi_install_dir(&candidate.path, &install_method);
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
            surface: AgentSurface::Cli,
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

    let primary = installations
        .iter()
        .find(|installation| installation.available_on_path && installation.version.is_some())
        .or_else(|| {
            installations
                .iter()
                .find(|installation| installation.version.is_some())
        })
        .or_else(|| {
            installations
                .iter()
                .find(|installation| installation.available_on_path)
        })
        .or_else(|| installations.first())
        .cloned();

    AgentEnvironmentReport {
        agent_id: "pi".to_string(),
        agent_name: "Pi".to_string(),
        installed: !installations.is_empty(),
        runtime_running: None,
        primary,
        installations,
    }
}
