use super::super::*;
use super::DetectionFuture;

pub(super) fn detect_boxed() -> DetectionFuture {
    Box::pin(detect())
}

async fn detect() -> AgentEnvironmentReport {
    let candidates = hermes_cli_candidates();
    let mut installations = Vec::with_capacity(candidates.len());

    for candidate in candidates {
        let install_method = classify_hermes_method(&candidate.path);
        let install_dir = resolve_hermes_install_dir(&candidate.path, &install_method);
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

    let primary_index = installations
        .iter()
        .position(|installation| installation.available_on_path && installation.version.is_some())
        .or_else(|| {
            installations
                .iter()
                .position(|installation| installation.version.is_some())
        })
        .or_else(|| {
            installations
                .iter()
                .position(|installation| installation.available_on_path)
        })
        .or_else(|| (!installations.is_empty()).then_some(0));
    let primary = primary_index.map(|index| installations[index].clone());

    AgentEnvironmentReport {
        agent_id: "hermes".to_string(),
        agent_name: "Hermes Agent CLI".to_string(),
        installed: !installations.is_empty(),
        runtime_running: None,
        runtime_managed: None,
        runtime_command: None,
        primary,
        installations,
    }
}
