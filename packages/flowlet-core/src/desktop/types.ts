// 桌面（Electron）命令层共享类型。Owner: lead。
//
// 设计目标：桌面端命令是 Web Host 命令面的**超集**。Web Host 已有的 66 条命令继续由
// `web/commands.ts` 的 dispatch 处理；桌面独有能力（窗口/托盘/自启/凭据/控制台抓取/
// Agent 本机文件与原生会话/跨设备同步）在这里按领域注册，互不覆盖。
//
// 平台能力的边界：命令层不 import electron，只通过 `DesktopHostBridge.invoke(channel, payload)`
// 调用主进程。channel 清单与 payload 契约见 `./README.md`，新增 channel 必须两端同时落地。
import type { JsonRow } from "../types.ts";
import type { WebContext } from "../web/context.ts";

/** 渲染进程外的宿主能力桥。Electron 主进程实现，Node 单测用内存实现。 */
export interface DesktopHostBridge {
  invoke<T = unknown>(channel: string, payload?: JsonRow): Promise<T>;
}

/** 桌面宿主注入的运行时信息与能力。 */
export interface DesktopRuntime {
  host: DesktopHostBridge;
  /** 应用版本（与 package.json 一致，替代 Rust `get_app_version`）。 */
  appVersion: string;
  /** 应用数据目录。必须与 Rust/Tauri 版本解析结果一致，旧数据库才能原地打开。 */
  dataDir: string;
  /** 是否便携版（数据目录在 exe 旁）。 */
  portable: boolean;
}

/** 桌面命令上下文：在 Web 命令上下文之上追加宿主能力。 */
export interface DesktopContext extends WebContext {
  desktop: DesktopRuntime;
}

export type DesktopHandler = (ctx: DesktopContext, args: JsonRow) => Promise<unknown> | unknown;

export type DesktopHandlerMap = Record<string, DesktopHandler>;