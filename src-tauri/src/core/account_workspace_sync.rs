use crate::core::config::ChannelAccount;
use crate::core::device_sync::{load_config, read_secret, S3Store, S3SyncConfig};
use crate::core::storage::Storage;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    ChaCha20Poly1305, Nonce,
};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

const WORKSPACE_KEYRING_SERVICE: &str = "Flowlet Account Workspace";
const WORKSPACE_ETAG_META_KEY: &str = "account_workspace_etag_v1";
const ENVELOPE_AAD: &[u8] = b"flowlet-account-workspace-v1";
const CATALOG_VERSION: u32 = 1;
const WORKSPACE_JOB_TYPE: &str = "account-workspace-sync";
static ACCOUNT_WORKSPACE_SYNC_GUARD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChannelAccount {
    pub id: String,
    pub channel_id: String,
    pub name: String,
    pub api_key: String,
    pub default_openai_base_url: Option<String>,
    pub default_anthropic_base_url: Option<String>,
    pub credential_fingerprint: String,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountWorkspaceCatalog {
    pub version: u32,
    pub revision: u64,
    pub updated_at: String,
    pub accounts: Vec<WorkspaceChannelAccount>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedCatalogEnvelope {
    format: String,
    version: u32,
    nonce: String,
    ciphertext: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountWorkspaceSyncResult {
    pub revision: u64,
    pub account_count: usize,
    pub linked_accounts: usize,
    pub created_local_accounts: usize,
    pub uploaded: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountWorkspaceStatus {
    pub enabled: bool,
    pub linked_accounts: usize,
}

pub fn status(storage: &Storage) -> Result<AccountWorkspaceStatus, String> {
    let linked_accounts = storage
        .list_channel_accounts()
        .map_err(|error| error.to_string())?
        .iter()
        .filter(|account| account.workspace_account_id.is_some())
        .count();
    Ok(AccountWorkspaceStatus {
        enabled: is_enabled(storage),
        linked_accounts,
    })
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAccountWorkspacePackage {
    pub format: String,
    pub version: u32,
    pub s3: crate::core::device_sync::S3SyncConfigInput,
    pub account_workspace_key: String,
}

fn workspace_key_entry(
    config: &crate::core::device_sync::S3SyncConfig,
) -> Result<keyring::Entry, String> {
    keyring::Entry::new(WORKSPACE_KEYRING_SERVICE, &config.credential_username())
        .map_err(|_| "无法访问账号工作区系统凭据库".to_string())
}

fn generate_workspace_key() -> [u8; 32] {
    let first = uuid::Uuid::new_v4();
    let second = uuid::Uuid::new_v4();
    let mut key = [0_u8; 32];
    key[..16].copy_from_slice(first.as_bytes());
    key[16..].copy_from_slice(second.as_bytes());
    key
}

fn save_workspace_key(
    config: &crate::core::device_sync::S3SyncConfig,
    key: &[u8; 32],
) -> Result<(), String> {
    workspace_key_entry(config)?
        .set_password(&BASE64.encode(key))
        .map_err(|_| "保存账号工作区密钥失败".to_string())
}

pub(crate) fn read_workspace_key(
    config: &crate::core::device_sync::S3SyncConfig,
) -> Result<[u8; 32], String> {
    let encoded = workspace_key_entry(config)?
        .get_password()
        .map_err(|_| "缺少账号工作区密钥，请导入桌面端工作区接入包".to_string())?;
    let bytes = BASE64
        .decode(encoded)
        .map_err(|_| "账号工作区密钥格式无效".to_string())?;
    bytes
        .try_into()
        .map_err(|_| "账号工作区密钥长度无效".to_string())
}

pub fn is_enabled(storage: &Storage) -> bool {
    load_config(storage)
        .ok()
        .flatten()
        .is_some_and(|config| read_workspace_key(&config).is_ok())
}

fn same_global_fields(left: &ChannelAccount, right: &ChannelAccount) -> bool {
    left.workspace_account_id == right.workspace_account_id
        && left.channel_id == right.channel_id
        && left.name == right.name
        && left.api_key == right.api_key
        && left.workspace_default_base_url == right.workspace_default_base_url
        && left.workspace_default_anthropic_base_url == right.workspace_default_anthropic_base_url
}

pub fn global_accounts_changed(previous: &[ChannelAccount], next: &[ChannelAccount]) -> bool {
    if previous.len() != next.len() {
        return true;
    }
    let next_by_id = next
        .iter()
        .map(|account| (account.id.as_str(), account))
        .collect::<std::collections::HashMap<_, _>>();
    previous.iter().any(|account| {
        next_by_id
            .get(account.id.as_str())
            .is_none_or(|candidate| !same_global_fields(account, candidate))
    })
}

pub fn export_desktop_package(storage: &Storage) -> Result<DesktopAccountWorkspacePackage, String> {
    let config = load_config(storage)?.ok_or_else(|| "尚未配置 S3 同步".to_string())?;
    let key = read_workspace_key(&config)?;
    Ok(DesktopAccountWorkspacePackage {
        format: "flowlet-desktop-account-workspace".to_string(),
        version: CATALOG_VERSION,
        s3: crate::core::device_sync::export_connection_config(storage)?,
        account_workspace_key: BASE64.encode(key),
    })
}

pub async fn import_desktop_package(
    storage: &Storage,
    package: &DesktopAccountWorkspacePackage,
) -> Result<(), String> {
    let _guard = ACCOUNT_WORKSPACE_SYNC_GUARD.lock().await;
    if package.format != "flowlet-desktop-account-workspace" || package.version != CATALOG_VERSION {
        return Err("桌面端账号工作区接入包版本不受支持".to_string());
    }
    let bytes = BASE64
        .decode(package.account_workspace_key.trim())
        .map_err(|_| "桌面端账号工作区密钥格式无效".to_string())?;
    let key: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "桌面端账号工作区密钥长度无效".to_string())?;
    let config = S3SyncConfig::from_input(&package.s3)?;
    let secret = package
        .s3
        .secret_access_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "桌面端账号工作区接入包缺少 S3 Secret Access Key".to_string())?;
    let store = S3Store::new(&config, secret)?;
    let encrypted = store.get(&config.workspace_accounts_key()).await?;
    decrypt_catalog(&encrypted, &key)?;
    crate::core::device_sync::save_config(storage, &package.s3)?;
    save_workspace_key(&config, &key)
}

fn credential_fingerprint(key: &[u8; 32], channel_id: &str, api_key: &str) -> String {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC accepts 32-byte keys");
    mac.update(channel_id.trim().as_bytes());
    mac.update(b"\0");
    mac.update(api_key.trim().as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

fn encrypt_catalog(catalog: &AccountWorkspaceCatalog, key: &[u8; 32]) -> Result<Vec<u8>, String> {
    let cipher = ChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| "初始化账号工作区加密失败".to_string())?;
    let nonce_uuid = uuid::Uuid::new_v4();
    let nonce_bytes = &nonce_uuid.as_bytes()[..12];
    let plaintext = serde_json::to_vec(catalog).map_err(|_| "序列化账号工作区失败".to_string())?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(nonce_bytes),
            Payload {
                msg: &plaintext,
                aad: ENVELOPE_AAD,
            },
        )
        .map_err(|_| "加密账号工作区失败".to_string())?;
    serde_json::to_vec(&EncryptedCatalogEnvelope {
        format: "flowlet-account-workspace".to_string(),
        version: CATALOG_VERSION,
        nonce: BASE64.encode(nonce_bytes),
        ciphertext: BASE64.encode(ciphertext),
    })
    .map_err(|_| "序列化账号工作区密文失败".to_string())
}

fn decrypt_catalog(bytes: &[u8], key: &[u8; 32]) -> Result<AccountWorkspaceCatalog, String> {
    let envelope: EncryptedCatalogEnvelope =
        serde_json::from_slice(bytes).map_err(|_| "账号工作区密文格式无效".to_string())?;
    if envelope.format != "flowlet-account-workspace" || envelope.version != CATALOG_VERSION {
        return Err("账号工作区版本不受支持".to_string());
    }
    let nonce = BASE64
        .decode(envelope.nonce)
        .map_err(|_| "账号工作区 nonce 无效".to_string())?;
    if nonce.len() != 12 {
        return Err("账号工作区 nonce 长度无效".to_string());
    }
    let ciphertext = BASE64
        .decode(envelope.ciphertext)
        .map_err(|_| "账号工作区密文无效".to_string())?;
    let cipher = ChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| "初始化账号工作区解密失败".to_string())?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: ENVELOPE_AAD,
            },
        )
        .map_err(|_| "账号工作区解密失败，请确认接入包来自同一工作区".to_string())?;
    let catalog: AccountWorkspaceCatalog =
        serde_json::from_slice(&plaintext).map_err(|_| "账号工作区内容格式无效".to_string())?;
    if catalog.version != CATALOG_VERSION {
        return Err("账号工作区内容版本不受支持".to_string());
    }
    Ok(catalog)
}

fn workspace_record(
    account: &ChannelAccount,
    workspace_id: String,
    key: &[u8; 32],
) -> WorkspaceChannelAccount {
    WorkspaceChannelAccount {
        id: workspace_id,
        channel_id: account.channel_id.clone(),
        name: account.name.clone(),
        api_key: account.api_key.clone(),
        // 首次迁移保守地把现有地址留作本设备 override；用户之后可主动设为工作区默认。
        default_openai_base_url: account.workspace_default_base_url.clone(),
        default_anthropic_base_url: account.workspace_default_anthropic_base_url.clone(),
        credential_fingerprint: credential_fingerprint(key, &account.channel_id, &account.api_key),
        archived: false,
        created_at: account.created_at.clone(),
        updated_at: account.updated_at.clone(),
    }
}

fn apply_catalog(
    storage: &Storage,
    catalog: &mut AccountWorkspaceCatalog,
    key: &[u8; 32],
) -> Result<(usize, usize, bool), String> {
    let mut local = storage
        .list_channel_accounts()
        .map_err(|error| error.to_string())?;
    let mut linked = 0;
    let mut created = 0;
    let mut catalog_changed = false;
    let mut archived_local_ids = std::collections::HashSet::new();

    for account in &mut local {
        let fingerprint = credential_fingerprint(key, &account.channel_id, &account.api_key);
        let matched = account
            .workspace_account_id
            .as_deref()
            .and_then(|id| catalog.accounts.iter().position(|record| record.id == id))
            .or_else(|| {
                catalog.accounts.iter().position(|record| {
                    record.channel_id == account.channel_id
                        && record.credential_fingerprint == fingerprint
                })
            });
        if let Some(index) = matched {
            let record = &catalog.accounts[index];
            if record.archived {
                archived_local_ids.insert(account.id.clone());
                continue;
            }
            account.workspace_account_id = Some(record.id.clone());
            account.name = record.name.clone();
            account.api_key = record.api_key.clone();
            account.workspace_default_base_url = record.default_openai_base_url.clone();
            account.workspace_default_anthropic_base_url =
                record.default_anthropic_base_url.clone();
            linked += 1;
        } else {
            let workspace_id = if catalog
                .accounts
                .iter()
                .any(|record| record.id == account.id)
            {
                format!("account-{}", uuid::Uuid::new_v4())
            } else {
                account.id.clone()
            };
            account.workspace_account_id = Some(workspace_id.clone());
            catalog
                .accounts
                .push(workspace_record(account, workspace_id, key));
            linked += 1;
            catalog_changed = true;
        }
    }
    local.retain(|account| !archived_local_ids.contains(&account.id));

    let mut next_priority = local
        .iter()
        .map(|account| account.priority)
        .max()
        .unwrap_or(-1)
        + 1;
    for record in catalog.accounts.iter().filter(|record| !record.archived) {
        if local
            .iter()
            .any(|account| account.workspace_account_id.as_deref() == Some(record.id.as_str()))
        {
            continue;
        }
        let local_account_id = storage
            .local_account_id_for_workspace(&record.id)
            .map_err(|error| error.to_string())?
            .unwrap_or_else(|| record.id.clone());
        local.push(ChannelAccount {
            id: local_account_id,
            workspace_account_id: Some(record.id.clone()),
            channel_id: record.channel_id.clone(),
            name: record.name.clone(),
            api_key: record.api_key.clone(),
            enabled: false,
            priority: next_priority,
            remark: None,
            resource_mode: None,
            resource_sync_mode: "manual".to_string(),
            base_url_override: None,
            anthropic_base_url_override: None,
            workspace_default_base_url: record.default_openai_base_url.clone(),
            workspace_default_anthropic_base_url: record.default_anthropic_base_url.clone(),
            last_used_at: None,
            last_error: None,
            credential_status: "healthy".to_string(),
            synced_models: None,
            models_synced_at: None,
            exposed_models: None,
            created_at: record.created_at.clone(),
            updated_at: record.updated_at.clone(),
        });
        next_priority += 1;
        created += 1;
    }
    storage
        .save_channel_accounts(&local)
        .map_err(|error| error.to_string())?;
    Ok((linked, created, catalog_changed))
}

fn create_workspace_job(
    storage: &Storage,
    trigger_source: &str,
    title: &str,
    first_event: &str,
) -> Result<String, String> {
    let job_id = uuid::Uuid::new_v4().to_string();
    storage
        .create_job(
            &job_id,
            WORKSPACE_JOB_TYPE,
            title,
            "同步渠道账号工作区目录",
            trigger_source,
            1,
            first_event,
        )
        .map_err(|error| format!("创建账号工作区同步任务失败：{error}"))?;
    Ok(job_id)
}

fn finish_workspace_job(
    storage: &Storage,
    job_id: &str,
    result: &AccountWorkspaceSyncResult,
    stage_message: &str,
) {
    let summary = serde_json::json!({
        "revision": result.revision,
        "accountCount": result.account_count,
        "linkedAccounts": result.linked_accounts,
        "createdLocalAccounts": result.created_local_accounts,
        "uploaded": result.uploaded,
    })
    .to_string();
    let _ = storage.update_job_progress(job_id, 1, 1);
    if let Err(error) = storage.finish_job(job_id, "succeeded", &summary, stage_message) {
        tracing::warn!(%error, job_id = %job_id, "failed to finish account workspace sync task log");
    }
}

pub async fn initialize(storage: Storage) -> Result<AccountWorkspaceSyncResult, String> {
    let _guard = ACCOUNT_WORKSPACE_SYNC_GUARD.lock().await;
    let job_id = create_workspace_job(&storage, "manual", "启用渠道账号工作区", "开始创建账号工作区目录")?;
    match initialize_inner(&storage).await {
        Ok(result) => {
            finish_workspace_job(
                &storage,
                &job_id,
                &result,
                &format!(
                    "账号工作区已创建并启用：目录版本 {}，共 {} 个账号",
                    result.revision, result.account_count
                ),
            );
            Ok(result)
        }
        Err(error) => {
            let _ = storage.fail_job(&job_id, &error);
            Err(error)
        }
    }
}

async fn initialize_inner(storage: &Storage) -> Result<AccountWorkspaceSyncResult, String> {
    let config = load_config(storage)?.ok_or_else(|| "尚未配置 S3 同步".to_string())?;
    let secret = read_secret(&config)?;
    let store = S3Store::new(&config, &secret)?;
    let object_key = config.workspace_accounts_key();
    if store
        .list(&config.workspace_prefix())
        .await?
        .iter()
        .any(|object| object.key == object_key)
    {
        return Err("远端已存在账号工作区，请导入桌面端工作区接入包后加入".to_string());
    }
    let key = generate_workspace_key();
    let now = chrono::Utc::now().to_rfc3339();
    let mut local = storage
        .list_channel_accounts()
        .map_err(|error| error.to_string())?;
    let mut catalog = AccountWorkspaceCatalog {
        version: CATALOG_VERSION,
        revision: 1,
        updated_at: now,
        accounts: Vec::with_capacity(local.len()),
    };
    for account in &mut local {
        let workspace_id = account
            .workspace_account_id
            .clone()
            .unwrap_or_else(|| account.id.clone());
        account.workspace_account_id = Some(workspace_id.clone());
        catalog
            .accounts
            .push(workspace_record(account, workspace_id, &key));
    }
    save_workspace_key(&config, &key)?;
    let etag = match store
        .put(&object_key, encrypt_catalog(&catalog, &key)?, None)
        .await
    {
        Ok(etag) => etag.or(store.head_etag(&object_key).await?),
        Err(error) => {
            if let Ok(entry) = workspace_key_entry(&config) {
                let _ = entry.delete_credential();
            }
            return Err(error);
        }
    };
    storage
        .save_channel_accounts(&local)
        .map_err(|error| error.to_string())?;
    if let Some(etag) = etag {
        storage
            .set_app_meta(WORKSPACE_ETAG_META_KEY, &etag)
            .map_err(|error| error.to_string())?;
    }
    Ok(AccountWorkspaceSyncResult {
        revision: catalog.revision,
        account_count: catalog.accounts.len(),
        linked_accounts: local.len(),
        created_local_accounts: 0,
        uploaded: true,
    })
}

pub async fn sync(
    storage: Storage,
    trigger_source: &str,
) -> Result<AccountWorkspaceSyncResult, String> {
    let _guard = ACCOUNT_WORKSPACE_SYNC_GUARD.lock().await;
    let job_id = create_workspace_job(&storage, trigger_source, "渠道账号工作区同步", "开始同步渠道账号工作区目录")?;
    match sync_inner(&storage).await {
        Ok(result) => {
            let stage_message = if result.uploaded {
                format!(
                    "账号工作区同步完成：目录版本 {}，共 {} 个账号，本机关联 {} 个，新增 {} 个",
                    result.revision,
                    result.account_count,
                    result.linked_accounts,
                    result.created_local_accounts
                )
            } else {
                format!(
                    "账号工作区同步完成：目录版本 {} 无变化，共 {} 个账号",
                    result.revision, result.account_count
                )
            };
            finish_workspace_job(&storage, &job_id, &result, &stage_message);
            Ok(result)
        }
        Err(error) => {
            let _ = storage.fail_job(&job_id, &error);
            Err(error)
        }
    }
}

async fn sync_inner(storage: &Storage) -> Result<AccountWorkspaceSyncResult, String> {
    let config = load_config(storage)?.ok_or_else(|| "尚未配置 S3 同步".to_string())?;
    let secret = read_secret(&config)?;
    let key = read_workspace_key(&config)?;
    let store = S3Store::new(&config, &secret)?;
    let object_key = config.workspace_accounts_key();
    let remote_etag = store.head_etag(&object_key).await?;
    let bytes = store.get(&object_key).await?;
    let mut catalog = decrypt_catalog(&bytes, &key)?;
    let (linked, created, changed) = apply_catalog(storage, &mut catalog, &key)?;
    let uploaded = if changed {
        catalog.revision += 1;
        catalog.updated_at = chrono::Utc::now().to_rfc3339();
        let uploaded_etag = store
            .put(
                &object_key,
                encrypt_catalog(&catalog, &key)?,
                remote_etag.as_deref(),
            )
            .await?
            .or(store.head_etag(&object_key).await?);
        if let Some(etag) = uploaded_etag {
            storage
                .set_app_meta(WORKSPACE_ETAG_META_KEY, &etag)
                .map_err(|error| error.to_string())?;
        }
        true
    } else {
        false
    };
    if !uploaded {
        if let Some(etag) = remote_etag {
            storage
                .set_app_meta(WORKSPACE_ETAG_META_KEY, &etag)
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(AccountWorkspaceSyncResult {
        revision: catalog.revision,
        account_count: catalog.accounts.len(),
        linked_accounts: linked,
        created_local_accounts: created,
        uploaded,
    })
}

/// 把账号的工作区字段写入远端。路由、启停、优先级、模型选择和本机地址不进入目录。
/// 调用方应在该写入成功后再保存本地账号，保证 S3 不可用时全局字段只读。
pub async fn push_accounts(
    storage: &Storage,
    accounts: &mut [ChannelAccount],
) -> Result<(), String> {
    let _guard = ACCOUNT_WORKSPACE_SYNC_GUARD.lock().await;
    let config = load_config(storage)?.ok_or_else(|| "尚未配置 S3 同步".to_string())?;
    let secret = read_secret(&config)?;
    let key = read_workspace_key(&config)?;
    let store = S3Store::new(&config, &secret)?;
    let object_key = config.workspace_accounts_key();
    let remote_etag = store.head_etag(&object_key).await?;
    let saved_etag = storage
        .get_app_meta(WORKSPACE_ETAG_META_KEY)
        .map_err(|error| error.to_string())?;
    if saved_etag.is_some() && saved_etag != remote_etag {
        return Err("远端账号工作区已被其他设备更新，请先同步账号后再保存".to_string());
    }
    let bytes = store.get(&object_key).await?;
    let mut catalog = decrypt_catalog(&bytes, &key)?;
    let previous = storage
        .list_channel_accounts()
        .map_err(|error| error.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();

    for account in accounts.iter_mut() {
        let fingerprint = credential_fingerprint(&key, &account.channel_id, &account.api_key);
        let index = account
            .workspace_account_id
            .as_deref()
            .and_then(|id| catalog.accounts.iter().position(|record| record.id == id))
            .or_else(|| {
                catalog.accounts.iter().position(|record| {
                    record.channel_id == account.channel_id
                        && record.credential_fingerprint == fingerprint
                })
            });
        let index = match index {
            Some(index) => index,
            None => {
                let workspace_id = if catalog
                    .accounts
                    .iter()
                    .any(|record| record.id == account.id)
                {
                    format!("account-{}", uuid::Uuid::new_v4())
                } else {
                    account.id.clone()
                };
                catalog
                    .accounts
                    .push(workspace_record(account, workspace_id, &key));
                catalog.accounts.len() - 1
            }
        };
        let record = &mut catalog.accounts[index];
        account.workspace_account_id = Some(record.id.clone());
        record.channel_id = account.channel_id.clone();
        record.name = account.name.clone();
        record.api_key = account.api_key.clone();
        record.default_openai_base_url = account.workspace_default_base_url.clone();
        record.default_anthropic_base_url = account.workspace_default_anthropic_base_url.clone();
        record.credential_fingerprint = fingerprint;
        record.archived = false;
        record.updated_at = now.clone();
    }

    let retained = accounts
        .iter()
        .filter_map(|account| account.workspace_account_id.as_deref())
        .collect::<std::collections::HashSet<_>>();
    for workspace_id in previous
        .iter()
        .filter_map(|account| account.workspace_account_id.as_deref())
    {
        if !retained.contains(workspace_id) {
            if let Some(record) = catalog
                .accounts
                .iter_mut()
                .find(|record| record.id == workspace_id)
            {
                record.archived = true;
                record.updated_at = now.clone();
            }
        }
    }
    catalog.revision += 1;
    catalog.updated_at = now;
    let uploaded_etag = store
        .put(
            &object_key,
            encrypt_catalog(&catalog, &key)?,
            remote_etag.as_deref(),
        )
        .await?
        .or(store.head_etag(&object_key).await?);
    if let Some(etag) = uploaded_etag {
        storage
            .set_app_meta(WORKSPACE_ETAG_META_KEY, &etag)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_catalog_round_trips_and_rejects_wrong_key() {
        let key = [7_u8; 32];
        let catalog = AccountWorkspaceCatalog {
            version: 1,
            revision: 3,
            updated_at: "2026-08-03T00:00:00Z".to_string(),
            accounts: vec![WorkspaceChannelAccount {
                id: "workspace-account-1".to_string(),
                channel_id: "custom".to_string(),
                name: "Friday".to_string(),
                api_key: "secret-key".to_string(),
                default_openai_base_url: Some("https://public.example/v1".to_string()),
                default_anthropic_base_url: None,
                credential_fingerprint: credential_fingerprint(&key, "custom", "secret-key"),
                archived: false,
                created_at: "2026-08-03T00:00:00Z".to_string(),
                updated_at: "2026-08-03T00:00:00Z".to_string(),
            }],
        };
        let encrypted = encrypt_catalog(&catalog, &key).unwrap();
        assert_eq!(decrypt_catalog(&encrypted, &key).unwrap(), catalog);
        assert!(decrypt_catalog(&encrypted, &[8_u8; 32]).is_err());
        assert!(!String::from_utf8_lossy(&encrypted).contains("secret-key"));
    }

    #[test]
    fn local_only_account_changes_do_not_require_a_workspace_write() {
        let original = ChannelAccount {
            id: "local-1".to_string(),
            workspace_account_id: Some("workspace-1".to_string()),
            channel_id: "custom".to_string(),
            name: "Friday".to_string(),
            api_key: "sk-test".to_string(),
            enabled: true,
            priority: 1,
            base_url_override: Some("http://office.internal/v1".to_string()),
            exposed_models: Some(vec!["deepseek-v4-pro".to_string()]),
            ..Default::default()
        };
        let mut local_change = original.clone();
        local_change.enabled = false;
        local_change.priority = 9;
        local_change.base_url_override = Some("http://home.lan/v1".to_string());
        local_change.exposed_models = Some(Vec::new());
        assert!(!global_accounts_changed(
            &[original.clone()],
            &[local_change]
        ));

        let mut global_change = original.clone();
        global_change.workspace_default_base_url = Some("https://friday.example/v1".to_string());
        assert!(global_accounts_changed(&[original], &[global_change]));
    }

    #[test]
    fn archived_workspace_account_is_removed_locally_but_keeps_history_mapping() {
        let storage = Storage::from_connection_for_test(
            rusqlite::Connection::open_in_memory().expect("open sqlite"),
        );
        storage.migrate().expect("migrate workspace schema");
        storage
            .save_channel_accounts(&[ChannelAccount {
                id: "local-friday".to_string(),
                workspace_account_id: Some("workspace-friday".to_string()),
                channel_id: "custom".to_string(),
                name: "Friday".to_string(),
                api_key: "sk-friday".to_string(),
                ..Default::default()
            }])
            .expect("save account");
        let key = [9_u8; 32];
        let mut catalog = AccountWorkspaceCatalog {
            version: CATALOG_VERSION,
            revision: 2,
            updated_at: "2026-08-03T00:00:00Z".to_string(),
            accounts: vec![WorkspaceChannelAccount {
                id: "workspace-friday".to_string(),
                channel_id: "custom".to_string(),
                name: "Friday".to_string(),
                api_key: "sk-friday".to_string(),
                default_openai_base_url: None,
                default_anthropic_base_url: None,
                credential_fingerprint: credential_fingerprint(&key, "custom", "sk-friday"),
                archived: true,
                created_at: "2026-08-03T00:00:00Z".to_string(),
                updated_at: "2026-08-03T00:00:00Z".to_string(),
            }],
        };

        apply_catalog(&storage, &mut catalog, &key).expect("apply tombstone");
        assert!(storage.list_channel_accounts().unwrap().is_empty());
        assert_eq!(
            storage
                .local_account_id_for_workspace("workspace-friday")
                .unwrap()
            .as_deref(),
            Some("local-friday")
        );
    }

    #[test]
    fn workspace_sync_records_detailed_task_log() {
        let storage = Storage::from_connection_for_test(
            rusqlite::Connection::open_in_memory().expect("open sqlite"),
        );
        storage.migrate().expect("migrate workspace schema");
        let job_id = create_workspace_job(
            &storage,
            "background",
            "渠道账号工作区同步",
            "开始同步渠道账号工作区目录",
        )
        .expect("create job");
        let result = AccountWorkspaceSyncResult {
            revision: 3,
            account_count: 5,
            linked_accounts: 4,
            created_local_accounts: 1,
            uploaded: true,
        };
        finish_workspace_job(&storage, &job_id, &result, "账号工作区同步完成");

        let detail = storage
            .get_background_job_detail(&job_id)
            .expect("read job")
            .expect("job exists");
        assert_eq!(detail.job.job_type, "account-workspace-sync");
        assert_eq!(detail.job.title, "渠道账号工作区同步");
        assert_eq!(detail.job.trigger_source, "background");
        assert_eq!(detail.job.status, "succeeded");
        assert_eq!(detail.job.progress_total, 1);
        let summary: serde_json::Value =
            serde_json::from_str(detail.job.summary_json.as_deref().unwrap()).unwrap();
        assert_eq!(summary["revision"], 3);
        assert_eq!(summary["accountCount"], 5);
        assert_eq!(summary["linkedAccounts"], 4);
        assert_eq!(summary["createdLocalAccounts"], 1);
        assert_eq!(summary["uploaded"], true);
        // 首事件 + 完成事件
        assert_eq!(detail.events.len(), 2);
    }
}
