//! 服务凭据的静态加密。
//!
//! 三方服务 token（GitLab 等）不能以明文落到 SQLite：数据库文件会被备份、
//! 打包、复制到别的机器。这里用 ChaCha20-Poly1305 做认证加密，密钥来自数据目录
//! 下自动生成的 `secret.key`（32 字节随机值，0600）：
//!
//! - **桌面**：数据目录 = SQLite 所在目录（应用数据目录 / 便携目录）；
//! - **Docker**：数据目录 = `/data`（命名卷 `flowlet-data`），跟随卷一起备份；
//! - 密文格式 `v1:<base64(nonce || ciphertext+tag)>`，带上版本前缀便于以后换算法。
//!
//! 密钥文件丢失等于凭据全部不可解密（需要重新填写）；这是有意的取舍——不把密钥
//! 放进数据库本身，避免“拷走 SQLite 就能解密”。

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Nonce,
};
use ring::rand::SecureRandom;
use std::path::{Path, PathBuf};

const KEY_FILE_NAME: &str = "secret.key";
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const CIPHER_PREFIX: &str = "v1:";

#[derive(Clone)]
pub struct SecretBox {
    cipher: ChaCha20Poly1305,
}

impl SecretBox {
    /// 从数据目录读取密钥；不存在时生成并落盘（0600）。
    pub fn load_or_create(data_dir: impl AsRef<Path>) -> Result<Self, String> {
        let data_dir = data_dir.as_ref();
        let path = data_dir.join(KEY_FILE_NAME);
        let key = match std::fs::read_to_string(&path) {
            Ok(text) => decode_key(&text)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir_all(data_dir).map_err(|error| {
                    format!("创建数据目录失败（{}）：{error}", data_dir.display())
                })?;
                let generated = generate_key()?;
                write_key(&path, &generated)?;
                generated
            }
            Err(error) => {
                return Err(format!("读取凭据密钥失败（{}）：{error}", path.display()));
            }
        };
        Ok(Self {
            cipher: ChaCha20Poly1305::new_from_slice(&key)
                .map_err(|_| "凭据密钥长度无效".to_string())?,
        })
    }

    pub fn encrypt(&self, plaintext: &str) -> Result<String, String> {
        let mut nonce_bytes = [0u8; NONCE_LEN];
        ring::rand::SystemRandom::new()
            .fill(&mut nonce_bytes)
            .map_err(|_| "生成随机数失败".to_string())?;
        let ciphertext = self
            .cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_bytes())
            .map_err(|_| "加密凭据失败".to_string())?;
        let mut payload = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        payload.extend_from_slice(&nonce_bytes);
        payload.extend_from_slice(&ciphertext);
        Ok(format!("{CIPHER_PREFIX}{}", BASE64.encode(payload)))
    }

    pub fn decrypt(&self, encoded: &str) -> Result<String, String> {
        let body = encoded
            .strip_prefix(CIPHER_PREFIX)
            .ok_or_else(|| "凭据密文版本不支持，请重新保存该凭据".to_string())?;
        let payload = BASE64
            .decode(body)
            .map_err(|_| "凭据密文格式无效".to_string())?;
        if payload.len() <= NONCE_LEN {
            return Err("凭据密文长度无效".to_string());
        }
        let (nonce_bytes, ciphertext) = payload.split_at(NONCE_LEN);
        let plaintext = self
            .cipher
            .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
            .map_err(|_| "凭据解密失败（密钥可能已更换）".to_string())?;
        String::from_utf8(plaintext).map_err(|_| "凭据明文不是合法 UTF-8".to_string())
    }
}

fn decode_key(text: &str) -> Result<[u8; KEY_LEN], String> {
    let bytes = hex::decode(text.trim()).map_err(|_| "凭据密钥文件格式无效".to_string())?;
    if bytes.len() != KEY_LEN {
        return Err(format!(
            "凭据密钥长度无效：期望 {KEY_LEN} 字节，实际 {} 字节",
            bytes.len()
        ));
    }
    let mut key = [0u8; KEY_LEN];
    key.copy_from_slice(&bytes);
    Ok(key)
}

fn generate_key() -> Result<[u8; KEY_LEN], String> {
    let mut key = [0u8; KEY_LEN];
    ring::rand::SystemRandom::new()
        .fill(&mut key)
        .map_err(|_| "生成凭据密钥失败".to_string())?;
    Ok(key)
}

fn write_key(path: &Path, key: &[u8; KEY_LEN]) -> Result<(), String> {
    let temp: PathBuf = path.with_extension(format!("key.tmp-{}", std::process::id()));
    std::fs::write(&temp, hex::encode(key))
        .map_err(|error| format!("写入凭据密钥失败（{}）：{error}", temp.display()))?;
    restrict_file(&temp)?;
    std::fs::rename(&temp, path)
        .map_err(|error| format!("保存凭据密钥失败（{}）：{error}", path.display()))
}

#[cfg(unix)]
fn restrict_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("设置凭据密钥权限失败：{error}"))
}

#[cfg(not(unix))]
fn restrict_file(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "flowlet-secret-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or_default()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn roundtrip_encrypt_decrypt() {
        let dir = temp_dir("roundtrip");
        let secret_box = SecretBox::load_or_create(&dir).unwrap();
        let encoded = secret_box.encrypt("glpat-secret").unwrap();
        assert!(encoded.starts_with("v1:"));
        assert!(!encoded.contains("glpat"));
        assert_eq!(secret_box.decrypt(&encoded).unwrap(), "glpat-secret");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn key_is_stable_across_instances() {
        let dir = temp_dir("stable");
        let first = SecretBox::load_or_create(&dir).unwrap();
        let encoded = first.encrypt("token").unwrap();
        let second = SecretBox::load_or_create(&dir).unwrap();
        assert_eq!(second.decrypt(&encoded).unwrap(), "token");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn different_keys_cannot_decrypt() {
        let first = SecretBox::load_or_create(temp_dir("key-a")).unwrap();
        let second = SecretBox::load_or_create(temp_dir("key-b")).unwrap();
        let encoded = first.encrypt("token").unwrap();
        assert!(second.decrypt(&encoded).is_err());
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let dir = temp_dir("tamper");
        let secret_box = SecretBox::load_or_create(&dir).unwrap();
        let encoded = secret_box.encrypt("token").unwrap();
        let mut bytes = BASE64.decode(encoded.trim_start_matches("v1:")).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xFF;
        let tampered = format!("v1:{}", BASE64.encode(bytes));
        assert!(secret_box.decrypt(&tampered).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
