// Node Host 引导（独立 bundle：dist-host/core-host.mjs）。
//
// 与 dist-host/main.mjs 分开是为了让 import.meta.url 资源定位插件在
// core-host bundle 内生效：宿主在 import 本模块之前设置
// `FLOWLET_RUNTIME_ROOT_URL`，bundle 内 flowlet-core 的相对资源路径才会指向
// 打包后的 runtime 目录（config / model-catalog / models-* / worker）。
//
// 本模块不 import electron：平台能力只通过 DesktopHostBridge 注入。
import { startHost } from "../../flowlet-core/src/index.ts";
import type { DesktopHostBridge } from "../../flowlet-core/src/desktop/types.ts";

export interface CoreHostStartOptions {
  readonly host: DesktopHostBridge;
  readonly appVersion: string;
  readonly dataDir: string;
  readonly portable: boolean;
  readonly dbPath: string;
  readonly configPath: string;
  readonly catalogDir: string;
  readonly staticDir: string;
  readonly adminToken: string;
  readonly bindAddr: string;
  readonly webAddr: string;
  /** 对外展示的模型入口 URL；桌面端默认空（本地客户端按 bind 配置自行推导）。 */
  readonly publicProxyUrl?: string;
}

export interface CoreHostHandle {
  close(): Promise<void>;
  webAddr: string;
}

export function startFlowletHost(options: CoreHostStartOptions): Promise<CoreHostHandle> {
  return startHost({
    dbPath: options.dbPath,
    configPath: options.configPath,
    catalogDir: options.catalogDir,
    staticDir: options.staticDir,
    adminToken: options.adminToken,
    // Node Host 会持久化 client token；桌面端与 Docker 一样允许首启生成。
    clientToken: "",
    bindAddr: options.bindAddr,
    // 0 端口由系统分配，规避与其它本机服务冲突；真实地址从返回值取。
    webAddr: options.webAddr,
    publicProxyUrl: options.publicProxyUrl ?? "",
    desktop: {
      host: options.host,
      appVersion: options.appVersion,
      dataDir: options.dataDir,
      portable: options.portable,
    },
  });
}