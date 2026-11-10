//! 三方服务凭据的持久化（`service_credentials` 表）。
//!
//! 只做 SQL 读写；校验、加密与业务编排在 `core/service_credentials.rs`。

use super::{ServiceCredentialRow, Storage, StorageError};
use rusqlite::{params, OptionalExtension};

impl Storage {
    pub fn list_service_credentials(&self) -> Result<Vec<ServiceCredentialRow>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            "SELECT id, name, provider, base_url, secret_ciphertext, secret_hint, kind, note,
                    enabled, created_at, updated_at, last_verified_at, last_error
             FROM service_credentials
             ORDER BY created_at ASC, name ASC",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok(ServiceCredentialRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    provider: row.get(2)?,
                    base_url: row.get(3)?,
                    secret_ciphertext: row.get(4)?,
                    secret_hint: row.get(5)?,
                    kind: row.get(6)?,
                    note: row.get(7)?,
                    enabled: row.get::<_, i64>(8)? != 0,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                    last_verified_at: row.get(11)?,
                    last_error: row.get(12)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_service_credential(
        &self,
        id: &str,
    ) -> Result<Option<ServiceCredentialRow>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let row = connection
            .query_row(
                "SELECT id, name, provider, base_url, secret_ciphertext, secret_hint, kind, note,
                        enabled, created_at, updated_at, last_verified_at, last_error
                 FROM service_credentials WHERE id = ?1",
                params![id],
                |row| {
                    Ok(ServiceCredentialRow {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        provider: row.get(2)?,
                        base_url: row.get(3)?,
                        secret_ciphertext: row.get(4)?,
                        secret_hint: row.get(5)?,
                        kind: row.get(6)?,
                        note: row.get(7)?,
                        enabled: row.get::<_, i64>(8)? != 0,
                        created_at: row.get(9)?,
                        updated_at: row.get(10)?,
                        last_verified_at: row.get(11)?,
                        last_error: row.get(12)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    pub fn upsert_service_credential(
        &self,
        row: &ServiceCredentialRow,
    ) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute(
            "INSERT INTO service_credentials (
                id, name, provider, base_url, secret_ciphertext, secret_hint, kind, note,
                enabled, created_at, updated_at, last_verified_at, last_error
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                provider = excluded.provider,
                base_url = excluded.base_url,
                secret_ciphertext = excluded.secret_ciphertext,
                secret_hint = excluded.secret_hint,
                kind = excluded.kind,
                note = excluded.note,
                enabled = excluded.enabled,
                updated_at = excluded.updated_at,
                last_verified_at = excluded.last_verified_at,
                last_error = excluded.last_error",
            params![
                row.id,
                row.name,
                row.provider,
                row.base_url,
                row.secret_ciphertext,
                row.secret_hint,
                row.kind,
                row.note,
                if row.enabled { 1 } else { 0 },
                row.created_at,
                row.updated_at,
                row.last_verified_at,
                row.last_error,
            ],
        )?;
        Ok(())
    }

    pub fn update_service_credential_verification(
        &self,
        id: &str,
        verified_at: Option<&str>,
        error: Option<&str>,
    ) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute(
            "UPDATE service_credentials
             SET last_verified_at = COALESCE(?2, last_verified_at),
                 last_error = ?3,
                 updated_at = ?4
             WHERE id = ?1",
            params![
                id,
                verified_at,
                error,
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
            ],
        )?;
        Ok(())
    }

    pub fn delete_service_credential(&self, id: &str) -> Result<bool, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let affected =
            connection.execute("DELETE FROM service_credentials WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str) -> ServiceCredentialRow {
        ServiceCredentialRow {
            id: id.to_string(),
            name: "GitLab 主库".to_string(),
            provider: "gitlab".to_string(),
            base_url: "https://gitlab.example.com".to_string(),
            secret_ciphertext: "v1:fake".to_string(),
            secret_hint: "••••a1b2".to_string(),
            kind: "cli_token".to_string(),
            note: Some("公司实例".to_string()),
            enabled: true,
            created_at: "2026-11-10T00:00:00Z".to_string(),
            updated_at: "2026-11-10T00:00:00Z".to_string(),
            last_verified_at: None,
            last_error: None,
        }
    }

    fn temp_storage(name: &str) -> (Storage, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "flowlet-cred-store-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("flowlet.sqlite");
        (Storage::open(&db).unwrap(), dir)
    }

    #[test]
    fn crud_roundtrip() {
        let (storage, dir) = temp_storage("crud");
        assert!(storage.list_service_credentials().unwrap().is_empty());

        storage
            .upsert_service_credential(&sample("cred-1"))
            .unwrap();
        let rows = storage.list_service_credentials().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "GitLab 主库");

        let mut updated = sample("cred-1");
        updated.name = "GitLab 改".to_string();
        updated.enabled = false;
        storage.upsert_service_credential(&updated).unwrap();
        let rows = storage.list_service_credentials().unwrap();
        assert_eq!(rows[0].name, "GitLab 改");
        assert!(!rows[0].enabled);

        storage
            .update_service_credential_verification("cred-1", Some("2026-11-10T01:00:00Z"), None)
            .unwrap();
        let row = storage.get_service_credential("cred-1").unwrap().unwrap();
        assert_eq!(
            row.last_verified_at.as_deref(),
            Some("2026-11-10T01:00:00Z")
        );

        assert!(storage.delete_service_credential("cred-1").unwrap());
        assert!(!storage.delete_service_credential("cred-1").unwrap());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn verification_error_is_recorded() {
        let (storage, dir) = temp_storage("verify-error");
        storage
            .upsert_service_credential(&sample("cred-2"))
            .unwrap();
        storage
            .update_service_credential_verification("cred-2", None, Some("401 Unauthorized"))
            .unwrap();
        let row = storage.get_service_credential("cred-2").unwrap().unwrap();
        assert!(row.last_verified_at.is_none());
        assert_eq!(row.last_error.as_deref(), Some("401 Unauthorized"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
