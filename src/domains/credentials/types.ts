/** 三方服务凭据的领域类型（与 Rust `core::service_credentials` 的 camelCase JSON 对齐）。 */

export type CredentialProviderId = "gitlab";

export type CredentialProvider = {
  id: string;
  label: string;
  baseUrlHint: string;
  tokenLabel: string;
  available: boolean;
};

export type ServiceCredential = {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  kind: string;
  note: string | null;
  enabled: boolean;
  /** 例如 `••••1a2b`，永不包含明文。 */
  secretHint: string;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt: string | null;
  lastError: string | null;
};

export type ServiceCredentialInput = {
  id?: string;
  name: string;
  provider: string;
  baseUrl: string;
  /** 留空表示编辑时保持原 token 不变。 */
  token?: string;
  kind?: string;
  note?: string;
  enabled?: boolean;
};

export type CredentialCheck = {
  ok: boolean;
  username: string | null;
  version: string | null;
  error: string | null;
};