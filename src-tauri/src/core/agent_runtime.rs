use crate::core::agent_environment::{self, AgentEnvironmentReport};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

const START_TIMEOUT: Duration = Duration::from_secs(20);
const STOP_TIMEOUT: Duration = Duration::from_secs(8);
const OUTPUT_LIMIT: usize = 24 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AgentRuntimeLaunch {
    pub(crate) program: PathBuf,
    pub(crate) args: Vec<String>,
    pub(crate) display_command: String,
}

pub(crate) type RuntimeLaunch = fn(&AgentEnvironmentReport) -> Result<AgentRuntimeLaunch, String>;

pub(crate) struct AgentRuntimeAdapter {
    pub(crate) launch: RuntimeLaunch,
    pub(crate) health_addr: &'static str,
}

struct ManagedRuntime {
    child: Child,
    output: Arc<StdMutex<String>>,
}

#[derive(Clone, Default)]
pub(crate) struct AgentRuntimeManager {
    processes: Arc<Mutex<HashMap<String, ManagedRuntime>>>,
}

impl AgentRuntimeManager {
    pub(crate) async fn enrich_report(&self, agent_id: &str, report: &mut AgentEnvironmentReport) {
        let Some(adapter) = runtime_adapter(agent_id) else {
            return;
        };
        let mut processes = self.processes.lock().await;
        let managed = match processes.get_mut(agent_id) {
            Some(process) => match process.child.try_wait() {
                Ok(None) => true,
                Ok(Some(_)) | Err(_) => {
                    processes.remove(agent_id);
                    false
                }
            },
            None => false,
        };
        report.runtime_managed = Some(managed);
        report.runtime_command = (adapter.launch)(report)
            .ok()
            .map(|launch| launch.display_command);
    }

    pub(crate) async fn start(&self, agent_id: &str) -> Result<AgentEnvironmentReport, String> {
        let adapter = runtime_adapter(agent_id)
            .ok_or_else(|| format!("{agent_id} 不提供可管理的本地运行时"))?;
        let mut report = agent_environment::detect_agent_environment(agent_id).await?;
        self.enrich_report(agent_id, &mut report).await;
        if report.runtime_running == Some(true) {
            return if report.runtime_managed == Some(true) {
                Ok(report)
            } else {
                Err("DSH Web 已由 Flowlet 之外的进程启动；为避免终止未知进程，Flowlet 不会接管。请先在原启动位置停止后重试。".to_string())
            };
        }
        if report.runtime_managed == Some(true) {
            return Err("DSH Web 正在由 Flowlet 启动，请稍候再试。".to_string());
        }

        let launch = (adapter.launch)(&report)?;
        let mut command = build_command(&launch);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|error| format!("启动 `{}` 失败：{error}", launch.display_command))?;
        let output = Arc::new(StdMutex::new(String::new()));
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(capture_output(stdout, output.clone()));
        }
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(capture_output(stderr, output.clone()));
        }
        self.processes
            .lock()
            .await
            .insert(agent_id.to_string(), ManagedRuntime { child, output });

        let started_at = tokio::time::Instant::now();
        while started_at.elapsed() < START_TIMEOUT {
            if runtime_reachable(adapter.health_addr).await {
                let mut ready = agent_environment::detect_agent_environment(agent_id).await?;
                self.enrich_report(agent_id, &mut ready).await;
                return Ok(ready);
            }
            let exited = {
                let mut processes = self.processes.lock().await;
                match processes.get_mut(agent_id) {
                    Some(process) => match process.child.try_wait() {
                        Ok(Some(status)) => Some((status.to_string(), process.output.clone())),
                        Ok(None) => None,
                        Err(error) => Some((error.to_string(), process.output.clone())),
                    },
                    None => Some((
                        "运行时进程记录丢失".to_string(),
                        Arc::new(StdMutex::new(String::new())),
                    )),
                }
            };
            if let Some((status, output)) = exited {
                self.processes.lock().await.remove(agent_id);
                tokio::time::sleep(Duration::from_millis(50)).await;
                let detail = output
                    .lock()
                    .ok()
                    .map(|value| value.trim().to_string())
                    .unwrap_or_default();
                return Err(if detail.is_empty() {
                    format!("`{}` 启动后立即退出：{status}", launch.display_command)
                } else {
                    format!("`{}` 启动失败：{}", launch.display_command, tail(&detail))
                });
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }

        if let Some(process) = self.processes.lock().await.remove(agent_id) {
            terminate_process(process.child).await;
        }
        Err(format!(
            "`{}` 已启动，但 {} 在 {} 秒内未就绪",
            launch.display_command,
            adapter.health_addr,
            START_TIMEOUT.as_secs()
        ))
    }

    pub(crate) async fn stop(&self, agent_id: &str) -> Result<AgentEnvironmentReport, String> {
        let adapter = runtime_adapter(agent_id)
            .ok_or_else(|| format!("{agent_id} 不提供可管理的本地运行时"))?;
        let process = self.processes.lock().await.remove(agent_id);
        match process {
            Some(process) => terminate_process(process.child).await,
            None if runtime_reachable(adapter.health_addr).await => {
                return Err(
                    "DSH Web 不是由当前 Flowlet 启动；为避免终止未知进程，请在原启动位置停止。"
                        .to_string(),
                );
            }
            None => {}
        }

        let stopped_at = tokio::time::Instant::now();
        while stopped_at.elapsed() < STOP_TIMEOUT {
            if !runtime_reachable(adapter.health_addr).await {
                let mut report = agent_environment::detect_agent_environment(agent_id).await?;
                self.enrich_report(agent_id, &mut report).await;
                return Ok(report);
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        Err(format!("DSH Web 在 {} 秒内未停止", STOP_TIMEOUT.as_secs()))
    }

    pub(crate) async fn stop_all(&self) {
        let processes = {
            let mut guard = self.processes.lock().await;
            std::mem::take(&mut *guard)
        };
        for (_, process) in processes {
            terminate_process(process.child).await;
        }
    }
}

fn runtime_adapter(agent_id: &str) -> Option<&'static AgentRuntimeAdapter> {
    let environment_id = crate::core::plugin_registry::plugin_registry()
        .agent(agent_id)
        .map(|agent| agent.environment_adapter_id.as_str())
        .unwrap_or(agent_id);
    agent_environment::runtime_adapter(environment_id)
}

async fn runtime_reachable(address: &str) -> bool {
    tokio::net::TcpStream::connect(address).await.is_ok()
}

async fn capture_output(mut reader: impl AsyncRead + Unpin, output: Arc<StdMutex<String>>) {
    let mut buffer = [0_u8; 2048];
    loop {
        let Ok(read) = reader.read(&mut buffer).await else {
            return;
        };
        if read == 0 {
            return;
        }
        let chunk = String::from_utf8_lossy(&buffer[..read]);
        if let Ok(mut value) = output.lock() {
            value.push_str(&chunk);
            if value.len() > OUTPUT_LIMIT {
                let mut drain_to = value.len() - OUTPUT_LIMIT;
                while !value.is_char_boundary(drain_to) {
                    drain_to += 1;
                }
                value.drain(..drain_to);
            }
        }
    }
}

fn tail(value: &str) -> &str {
    let start = value
        .char_indices()
        .rev()
        .nth(1999)
        .map(|(index, _)| index)
        .unwrap_or(0);
    &value[start..]
}

fn build_command(launch: &AgentRuntimeLaunch) -> Command {
    #[cfg(windows)]
    {
        let extension = launch
            .program
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if extension == "cmd" || extension == "bat" {
            let mut command = Command::new("cmd.exe");
            command
                .arg("/D")
                .arg("/C")
                .arg(&launch.program)
                .args(&launch.args);
            crate::core::agent_environment::configure_hidden_console(&mut command);
            return command;
        }
        let mut command = Command::new(&launch.program);
        command.args(&launch.args);
        crate::core::agent_environment::configure_hidden_console(&mut command);
        command
    }
    #[cfg(not(windows))]
    {
        let mut command = Command::new(&launch.program);
        command.args(&launch.args);
        command
    }
}

async fn terminate_process(mut child: Child) {
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        let mut taskkill = Command::new("taskkill.exe");
        taskkill.args(["/PID", &pid.to_string(), "/T", "/F"]);
        taskkill.stdout(Stdio::null()).stderr(Stdio::null());
        crate::core::agent_environment::configure_hidden_console(&mut taskkill);
        let _ = taskkill.status().await;
    }
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
}
