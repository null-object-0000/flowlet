//! End-to-end lifecycle checks against the standalone executable, isolated from desktop data.
#![cfg(unix)]
use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::Duration,
};
const ADMIN: &str = "integration-management-token-test";
struct Host {
    child: Child,
    dir: PathBuf,
    web: u16,
    proxy: u16,
}
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}
impl Host {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("flowlet-host-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), "Flowlet test").unwrap();
        let web = free_port();
        let proxy = free_port();
        let child = Self::spawn(&dir, web, proxy);
        Self {
            child,
            dir,
            web,
            proxy,
        }
    }
    fn spawn(dir: &PathBuf, web: u16, proxy: u16) -> Child {
        Command::new(env!("CARGO_BIN_EXE_headless"))
            .env("FLOWLET_ADMIN_TOKEN", ADMIN)
            .env_remove("FLOWLET_CLIENT_TOKEN")
            .env_remove("FLOWLET_CONFIG_PATH")
            .env("FLOWLET_DB_PATH", dir.join("test.sqlite"))
            .env("FLOWLET_STATIC_DIR", dir)
            .env("FLOWLET_WEB_ADDR", format!("127.0.0.1:{web}"))
            .env("FLOWLET_BIND_ADDR", format!("127.0.0.1:{proxy}"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }
    fn stop(&mut self) {
        assert!(Command::new("kill")
            .args(["-TERM", &self.child.id().to_string()])
            .status()
            .unwrap()
            .success());
        for _ in 0..100 {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success());
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("SIGTERM did not stop the standalone host");
    }
    async fn ready(&mut self, client: &reqwest::Client) {
        for _ in 0..100 {
            assert!(
                self.child.try_wait().unwrap().is_none(),
                "standalone host exited during startup"
            );
            if client
                .get(format!("http://127.0.0.1:{}/health", self.web))
                .send()
                .await
                .is_ok_and(|r| r.status().is_success())
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("standalone host was not ready");
    }
    async fn token(&self, client: &reqwest::Client) -> String {
        let info: serde_json::Value = client
            .post(format!(
                "http://127.0.0.1:{}/api/commands/web_connection_info",
                self.web
            ))
            .bearer_auth(ADMIN)
            .json(&serde_json::json!({}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        info["client_token"].as_str().unwrap().to_owned()
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
#[tokio::test]
async fn generated_token_survives_restart_and_model_endpoints_require_client_auth() {
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let mut host = Host::new();
    host.ready(&client).await;
    let token = host.token(&client).await;
    assert!(!token.is_empty());
    assert_ne!(token, "flowlet-local-token");
    assert_ne!(token, ADMIN);
    let models = format!("http://127.0.0.1:{}/v1/models", host.proxy);
    for credential in ["", ADMIN] {
        assert_eq!(
            client
                .get(&models)
                .bearer_auth(credential)
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
    }
    assert_eq!(
        client
            .get(&models)
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        client
            .get(&models)
            .header("x-api-key", &token)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    host.stop();
    host.child = Host::spawn(&host.dir, host.web, host.proxy);
    host.ready(&client).await;
    assert_eq!(host.token(&client).await, token);
    host.stop();
}
#[test]
fn missing_management_token_fails_before_creating_data() {
    let dir = std::env::temp_dir().join(format!("flowlet-no-admin-{}", uuid::Uuid::new_v4()));
    let status = Command::new(env!("CARGO_BIN_EXE_headless"))
        .env_remove("FLOWLET_ADMIN_TOKEN")
        .env("FLOWLET_DB_PATH", dir.join("test.sqlite"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert!(!status.success());
    assert!(!dir.exists());
}

impl Host {
    async fn management(&self, client: &reqwest::Client, command: &str) -> serde_json::Value {
        client
            .post(format!(
                "http://127.0.0.1:{}/api/commands/{command}",
                self.web
            ))
            .bearer_auth(ADMIN)
            .json(&serde_json::json!({}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn device_identity_is_stable_across_restart_and_listed_by_management_api() {
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let mut host = Host::new();
    host.ready(&client).await;
    let devices = host.management(&client, "list_known_devices").await;
    let devices = devices.as_array().unwrap();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0]["isCurrent"], true);
    let device_id = devices[0]["deviceId"].as_str().unwrap().to_owned();
    assert!(uuid::Uuid::parse_str(&device_id).is_ok());
    assert!(host.dir.join("flowlet-device.json").is_file());

    host.stop();
    host.child = Host::spawn(&host.dir, host.web, host.proxy);
    host.ready(&client).await;
    let devices = host.management(&client, "list_known_devices").await;
    let devices = devices.as_array().unwrap();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0]["isCurrent"], true);
    assert_eq!(devices[0]["deviceId"], device_id);
    host.stop();
}
