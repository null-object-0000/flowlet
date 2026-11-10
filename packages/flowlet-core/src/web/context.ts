// 命令层共享上下文（由 web/index.ts 组装）。Owner: node-web.
import type {
  DeviceIdentity,
  JsonRow,
  ProxyController,
  RuntimeConfigStore,
} from "../types.ts";
import type { SqliteStorage } from "../storage/index.ts";
import type { CliAuth } from "./cli-auth.ts";
import type { AdminAuth } from "./auth.ts";
import type { LogCaptureConfig, UpstreamProxyConfig } from "./config-state.ts";
import type { DesktopRuntime } from "../desktop/types.ts";

/** 与 node-storage `SecretBox` 结构兼容的静态加密接口（密文格式 v1:...）。 */
export interface SecretBoxLike {
  encrypt(plaintext: string): string;
  decrypt(encoded: string): string;
}

export interface WebContext {
  storage: SqliteStorage;
  proxy: ProxyController;
  runtimeConfig: RuntimeConfigStore;
  catalogDir: string;
  configPath: string;
  adminToken: string;
  clientToken: string;
  staticDir: string;
  publicProxyUrl: string;
  deviceIdentity: DeviceIdentity;
  /** config.json 解析结果（缺失为 {}）。 */
  config: JsonRow;
  /** config.json.channels_config（渠道预设 / endpoints）。 */
  channelsConfig: JsonRow;
  /** 进程内 log_capture 状态；set_log_capture_config 成功后更新。 */
  logCapture: LogCaptureConfig;
  /** 进程内 upstream proxy 状态；set_upstream_proxy_config 成功后更新。 */
  upstreamProxy: UpstreamProxyConfig;
  /** 自定义抓取描述符缓存（Rust 侧 OnceLock 语义）。 */
  customScrapeChannels?: JsonRow[] | null;
  /** 三方服务凭据的静态加密（index.ts 传入 SecretBox，数据卷 secret.key）。 */
  secrets: SecretBoxLike;
  /** 管理端鉴权实例：命令里改登录提供方配置后要能立刻热替换。 */
  auth?: AdminAuth;
  /** CLI 浏览器授权（`flowlet login`）：授权码、token 签发与作用域校验。 */
  cliAuth: CliAuth;
  /**
   * 桌面（Electron）宿主注入的运行时能力。存在时命令 dispatch 先查桌面注册表
   * （`desktop/commands.ts`），未命中再回落到 Web Host 命令实现。
   * Web Host / Docker Host 上为 undefined。
   */
  desktop?: DesktopRuntime;
}