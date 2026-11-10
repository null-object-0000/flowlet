// Shared types for the Flowlet Node host.
//
// The Node host is a behavioural replacement for `src-tauri/src/bin/headless.rs`:
// it must serve the exact same Web Host command contract (`core/web/commands.rs`)
// and the same model proxy behaviour (`core/proxy*.rs`). Payload shapes are
// therefore copied from the Rust serde output, NOT designed from scratch.
//
// 约定：Rust 侧返回结构体默认 serde snake_case；少数较新结构体显式 camelCase。
// 迁移时逐字段对照 `src-tauri/src/core/**` 中对应的 `#[derive(Serialize)]`。

/** 原样透传的 JSON 行（字段命名与 Rust 输出一致，禁止二次重命名）。 */
export type JsonRow = Record<string, any>;

export interface HostOptions {
  /** 例：/data/flowlet.sqlite */
  dbPath: string;
  /** 例：/data/config.json（不存在时写入内置默认配置） */
  configPath: string;
  /** models-cn.json / models-dev.json 目录，例：/data/catalogs */
  catalogDir: string;
  /** dist-web 目录，例：/app/ui */
  staticDir: string;
  /** 管理凭据，至少 24 字符 */
  adminToken: string;
  /** 模型调用凭据（必须与 adminToken 不同） */
  clientToken: string;
  /** 模型入口监听地址，例：0.0.0.0:18640 */
  bindAddr: string;
  /** Web 管理监听地址，例：0.0.0.0:8080 */
  webAddr: string;
  /** 对外展示的模型入口 URL（可为空） */
  publicProxyUrl: string;
}

export interface ProxyBindConfig {
  host: string;
  port: number;
  allow_lan: boolean;
  default_client_token: string;
}

export interface ProxyStatus {
  running: boolean;
  bind_addr: string;
  started_at: string | null;
}

/** 命令错误：与 Rust `core/web` 的 `(StatusCode, code, message)` 同形。 */
export class CommandError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
  static badRequest(message: string): CommandError {
    return new CommandError(400, "command_failed", message);
  }
  static notImplemented(command: string): CommandError {
    return new CommandError(501, "unsupported_in_web", `此功能需要桌面端：${command}`);
  }
}

/**
 * Host 级设备身份，持久化在数据目录 `flowlet-device.json`（重启不变）。
 *
 * 文件格式必须与 Rust `core/device_identity.rs::DeviceIdentity` 一致；该结构体是
 * `#[serde(rename_all = "camelCase")]`，磁盘上写作
 * `{ schemaVersion, deviceId, createdAt, displayName, platform }`（进程内用 snake_case）。
 * Rust 侧没有 `deny_unknown_fields`，因此多余键（app_version）可安全共存；
 * 反过来 Rust 写的文件被 Node 读取时 app_version 缺失，由运行时补默认值。
 */
export interface DeviceIdentity {
  schema_version: number;
  device_id: string;
  created_at: string;
  display_name: string;
  platform: string;
  /** 仅 Node 侧内存/展示用，不写回 Rust 语义字段。 */
  app_version?: string;
}

/** 运行时配置快照：与 Rust RuntimeConfigStore 对齐，保存后必须刷新。 */
export interface RuntimeConfigStore {
  snapshot(): JsonRow;
  replace(snapshot: JsonRow): void;
  /** 局部更新（clone 后修改再 replace），用于 save_* 命令保存成功后刷新对应字段。 */
  update(mutate: (draft: JsonRow) => void): void;
}

/**
 * 模型入口控制器。
 *
 * 注意：bind config 变更（端口/调用密钥）持久化到 app_meta 后，下一次 `start()`
 * 或请求周期生效；Rust 版同样是「保存后下一次尝试生效」。
 */
export interface ProxyController {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): ProxyStatus;
  bindConfig(): ProxyBindConfig;
  setBindConfig(config: ProxyBindConfig): void;
}

/** Web 管理端需要注入的宿主服务（index.ts 负责组装）。 */
export interface HostServices {
  proxy: ProxyController;
  runtimeConfig: RuntimeConfigStore;
  bindConfig: ProxyBindConfig;
  catalogDir: string;
  configPath: string;
  clientToken: string;
  staticDir: string;
  publicProxyUrl: string;
  deviceIdentity: DeviceIdentity;
}
