// 三方服务凭据的静态加密：Rust `src-tauri/src/core/secret_box.rs` 的等价实现。
//
// 密文格式必须与 Rust 完全一致（同一 `secret.key` 双向可解密）：
//   `v1:` + base64(nonce[12] || ciphertext || tag[16])，ChaCha20-Poly1305（AEAD）。
// `secret.key` 是 hex 编码的 32 字节（0600），放在数据目录（Docker `/data`）随卷备份。
// 密钥文件丢失等于凭据全部不可解密（需要重新填写），这是有意取舍。
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const KEY_FILE_NAME = "secret.key";
const KEY_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const CIPHER_PREFIX = "v1:";
const ALGORITHM = "chacha20-poly1305";

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function isHex(value: string): boolean {
  return value.length > 0 && /^[0-9a-fA-F]+$/.test(value);
}

/** Rust `decode_key`：hex → 32 字节，错误文案对齐。 */
function decodeKey(text: string): Buffer {
  const trimmed = text.trim();
  if (!isHex(trimmed)) {
    throw new Error("凭据密钥文件格式无效");
  }
  const bytes = Buffer.from(trimmed, "hex");
  if (bytes.length !== KEY_LEN) {
    throw new Error(`凭据密钥长度无效：期望 ${KEY_LEN} 字节，实际 ${bytes.length} 字节`);
  }
  return bytes;
}

/** 严格 base64 解码（Rust `STANDARD` 引擎不接受非法字符/长度）。 */
function decodeBase64Strict(body: string): Buffer {
  if (!BASE64_PATTERN.test(body) || body.length % 4 !== 0) {
    throw new Error("凭据密文格式无效");
  }
  // 校验补位数量与解码后长度一致（Node Buffer 对坏补位过于宽松）。
  const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  const decoded = Buffer.from(body, "base64");
  if (decoded.toString("base64") !== body) {
    throw new Error("凭据密文格式无效");
  }
  if (padding > 2) throw new Error("凭据密文格式无效");
  return decoded;
}

/**
 * @types/node 只给 CCM/GCM/OCB 的 authTag 重载，ChaCha20-Poly1305 返回通用 `Cipheriv`，
 * 这里补最小结构类型（运行时由 OpenSSL 提供 getAuthTag/setAuthTag）。
 */
interface ChaChaCipher {
  update(data: Buffer | string, inputEncoding?: BufferEncoding): Buffer;
  final(): Buffer;
  getAuthTag(): Buffer;
}

interface ChaChaDecipher {
  setAuthTag(tag: Buffer): void;
  update(data: Buffer): Buffer;
  final(): Buffer;
}

function createCipher(key: Buffer, nonce: Buffer): ChaChaCipher {
  return createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_LEN }) as unknown as ChaChaCipher;
}

function createDecipher(key: Buffer, nonce: Buffer): ChaChaDecipher {
  return createDecipheriv(ALGORITHM, key, nonce, {
    authTagLength: TAG_LEN,
  }) as unknown as ChaChaDecipher;
}

/** 与 Rust `SecretBox` 等价的 ChaCha20-Poly1305 加密容器。 */
export class SecretBox {
  #key: Buffer;

  private constructor(key: Buffer) {
    this.#key = key;
  }

  /**
   * Rust `SecretBox::load_or_create`：读取 `<dataDir>/secret.key`；不存在时生成 hex 密钥
   * 并原子落盘（文件 0600，新建目录 0700）。
   */
  static loadOrCreate(dataDir: string): SecretBox {
    const keyPath = path.join(dataDir, KEY_FILE_NAME);
    let key: Buffer;
    if (existsSync(keyPath)) {
      let text: string;
      try {
        text = readFileSync(keyPath, "utf8");
      } catch (error) {
        throw new Error(
          `读取凭据密钥失败（${keyPath}）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      key = decodeKey(text);
    } else {
      try {
        mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      } catch (error) {
        throw new Error(
          `创建数据目录失败（${dataDir}）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      key = randomBytes(KEY_LEN);
      writeKey(keyPath, key);
    }
    return new SecretBox(key);
  }

  /** 从已存在的密钥字节构造（测试/迁移用；生产请用 loadOrCreate）。 */
  static fromKeyBytes(key: Buffer): SecretBox {
    if (key.length !== KEY_LEN) {
      throw new Error(`凭据密钥长度无效：期望 ${KEY_LEN} 字节，实际 ${key.length} 字节`);
    }
    return new SecretBox(key);
  }

  /** Rust `encrypt`：随机 nonce + AEAD，输出 `v1:<base64(nonce||ct||tag)>`。 */
  encrypt(plaintext: string): string {
    const nonce = randomBytes(NONCE_LEN);
    const cipher = createCipher(this.#key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${CIPHER_PREFIX}${Buffer.concat([nonce, ciphertext, tag]).toString("base64")}`;
  }

  /** Rust `decrypt`：校验版本前缀/格式/长度，AEAD 失败与非法 UTF-8 分别给错误文案。 */
  decrypt(encoded: string): string {
    if (!encoded.startsWith(CIPHER_PREFIX)) {
      throw new Error("凭据密文版本不支持，请重新保存该凭据");
    }
    const payload = decodeBase64Strict(encoded.slice(CIPHER_PREFIX.length));
    if (payload.length <= NONCE_LEN) {
      throw new Error("凭据密文长度无效");
    }
    const nonce = payload.subarray(0, NONCE_LEN);
    const sealed = payload.subarray(NONCE_LEN);
    if (sealed.length < TAG_LEN) {
      // Rust 侧 AEAD 解密同样失败。
      throw new Error("凭据解密失败（密钥可能已更换）");
    }
    const ciphertext = sealed.subarray(0, sealed.length - TAG_LEN);
    const tag = sealed.subarray(sealed.length - TAG_LEN);
    let plaintext: Buffer;
    try {
      const decipher = createDecipher(this.#key, nonce);
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error("凭据解密失败（密钥可能已更换）");
    }
    try {
      // Rust 用 String::from_utf8（严格校验），Node 默认解码会替换非法字节。
      return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    } catch {
      throw new Error("凭据明文不是合法 UTF-8");
    }
  }
}

/** Rust `write_key`：hex 文本写临时文件 → 0600 → rename。 */
function writeKey(keyPath: string, key: Buffer): void {
  const temporary = `${keyPath}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, key.toString("hex"));
  } catch (error) {
    throw new Error(
      `写入凭据密钥失败（${temporary}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    chmodSync(temporary, 0o600);
  } catch (error) {
    throw new Error(`设置凭据密钥权限失败：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    renameSync(temporary, keyPath);
  } catch (error) {
    throw new Error(
      `保存凭据密钥失败（${keyPath}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 密钥文件路径（供测试/运维诊断）。 */
export function secretKeyPath(dataDir: string): string {
  return path.join(dataDir, KEY_FILE_NAME);
}

export const SECRET_KEY_FILE_NAME = KEY_FILE_NAME;