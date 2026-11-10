/** 三方服务凭据的领域类型（与 Rust `core::service_credentials` 的 camelCase JSON 对齐）。 */

export type CredentialProviderId = "gitlab" | "dockhand";

export type CredentialProvider = {
  id: string;
  label: string;
  baseUrlHint: string;
  tokenLabel: string;
  available: boolean;
  /** 未填 `envPrefix` 时该 provider 使用的默认环境前缀（`GITLAB` / `DOCKHAND`）。 */
  defaultEnvPrefix: string;
};

export type ServiceCredential = {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  kind: string;
  note: string | null;
  enabled: boolean;
  /** 解析后的环境前缀（Host 返回，已大写）；旧 Host 缺失时前端按 provider 默认值兜底。 */
  envPrefix?: string;
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
  /** 环境别名（Env 前缀）；留空/未传表示使用 provider 默认前缀。 */
  envPrefix?: string;
};

/** 浏览器授权签发的 CLI token（`flowlet login`）；永不包含 token 明文或哈希。 */
export type CliAuthToken = {
  id: string;
  /** 授权名称：默认取 CLI 机器名（hostname），可为空字符串。 */
  name: string;
  /** 作用域，当前固定为 `credentials:read`。 */
  scope: string;
  createdAt: string;
  /** TTL 30 天；过期行由服务端惰性清理，前端仍会展示到期时间。 */
  expiresAt: string;
  lastUsedAt: string | null;
};

export type CredentialCheck = {
  ok: boolean;
  username: string | null;
  version: string | null;
  /** provider 专用摘要（如 Dockhand 的 `{n} 个环境`）；GitLab 为 null。 */
  detail: string | null;
  error: string | null;
};