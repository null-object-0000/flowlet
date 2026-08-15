use super::super::*;
use super::DetectionFuture;

pub(super) fn detect_boxed() -> DetectionFuture {
    Box::pin(detect())
}

async fn detect() -> AgentEnvironmentReport {
    let mut installations = Vec::new();
    for candidate in opencode_cli_candidates() {
        let install_method = classify_opencode_cli_method(&candidate.path);
        let install_dir = resolve_opencode_install_dir(&candidate.path, &install_method);
        let version_result = read_version(&candidate.path).await;
        let (version, version_output, error) = match version_result {
            Ok(output) => (parse_version(&output), Some(output), None),
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
    for candidate in opencode_desktop_candidates() {
        installations.push(AgentInstallation {
            surface: AgentSurface::Desktop,
            executable_path: display_path(&candidate.path),
            install_dir: display_path(candidate.path.parent().unwrap_or(&candidate.path)),
            install_method: AgentInstallMethod::Desktop,
            version: desktop_version(&candidate.path),
            version_output: None,
            available_on_path: false,
            runner_executable: None,
            error: None,
        });
    }

    let primary = installations
        .iter()
        .find(|installation| {
            installation.surface == AgentSurface::Cli
                && installation.available_on_path
                && installation.version.is_some()
        })
        .or_else(|| {
            installations.iter().find(|installation| {
                installation.surface == AgentSurface::Cli && installation.version.is_some()
            })
        })
        .or_else(|| {
            installations.iter().find(|installation| {
                installation.surface == AgentSurface::Desktop && installation.version.is_some()
            })
        })
        .or_else(|| {
            installations.iter().find(|installation| {
                installation.surface == AgentSurface::Cli
                    && installation.available_on_path
                    && installation.error.is_none()
            })
        })
        .or_else(|| installations.first())
        .cloned();

    AgentEnvironmentReport {
        agent_id: "opencode".to_string(),
        agent_name: "OpenCode".to_string(),
        installed: !installations.is_empty(),
        runtime_running: None,
        primary,
        installations,
    }
}
